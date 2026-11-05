import { AppError } from '@/shared/utils.js';

import { generateTotpSecret, matchTotp, totpUri } from './totp.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & {
  password_hash: string;
  totp_secret?: string | null;
  totp_pending_secret?: string | null;
  totp_enabled?: number | boolean | null;
};

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    setPendingTotpSecret?(userId: number, secret: string): void;
    enableTotp?(userId: number, counter: number): boolean;
    disableTotp?(userId: number): void;
    consumeTotpCounter?(userId: number, counter: number): boolean;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
  /** Milliseconds since the epoch; injectable so TOTP tests pin the clock. */
  now?(): number;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function totpEnabled(user: AuthLoginUser): boolean {
  return Boolean(user.totp_enabled) && typeof user.totp_secret === 'string' && user.totp_secret !== '';
}

function sessionUsername(user: unknown): string {
  if (typeof user === 'object' && user !== null && 'username' in user && typeof user.username === 'string') {
    return user.username;
  }
  throw new AppError('Authenticated user is required', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  const service = {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    /**
     * Username + password, then — when the user has turned it on — a TOTP code.
     * A missing code is `AUTH_TOTP_REQUIRED` (the client asks for one); a wrong
     * or reused code is `AUTH_INVALID_TOTP`. Neither says whether the password
     * was right unless it was.
     */
    async login(usernameInput: unknown, passwordInput: unknown, totpInput?: unknown) {
      const user = await service.verifyPassword(usernameInput, passwordInput);
      if (totpEnabled(user)) {
        const code = typeof totpInput === 'string' ? totpInput.trim() : '';
        if (!code) {
          throw new AppError('A two-factor code is required', {
            code: 'AUTH_TOTP_REQUIRED',
            statusCode: 401,
          });
        }
        const now = dependencies.now ? dependencies.now() : Date.now();
        const counter = matchTotp(user.totp_secret as string, code, now);
        const fresh = counter !== null
          && (dependencies.users.consumeTotpCounter?.(numericUserId(user.id), counter) ?? false);
        if (!fresh) {
          throw new AppError('Invalid two-factor code', {
            code: 'AUTH_INVALID_TOTP',
            statusCode: 401,
          });
        }
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },

    /**
     * The password check alone. Used by `login`, and by the OAuth consent page
     * to re-confirm a user whose session was already established with 2FA.
     */
    async verifyPassword(usernameInput: unknown, passwordInput: unknown): Promise<AuthLoginUser> {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }
      return user;
    },

    /** Whether the signed-in user has 2FA on, or a setup in progress. */
    totpStatus(sessionUser: unknown) {
      const user = dependencies.users.getUserByUsername(sessionUsername(sessionUser));
      if (!user) {
        throw new AppError('Authenticated user is required', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
      }
      return { enabled: totpEnabled(user), pending: Boolean(user.totp_pending_secret) };
    },

    /**
     * Starts 2FA setup: a new secret the user adds to an authenticator app.
     * Nothing changes for login until `totpEnable` sees a code from that app.
     * Refused while 2FA is on, so a stolen session cannot swap the secret.
     */
    totpSetup(sessionUser: unknown) {
      const user = dependencies.users.getUserByUsername(sessionUsername(sessionUser));
      if (!user) {
        throw new AppError('Authenticated user is required', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
      }
      if (totpEnabled(user)) {
        throw new AppError('Two-factor authentication is already on; turn it off first', {
          code: 'AUTH_TOTP_ALREADY_ENABLED',
          statusCode: 409,
        });
      }
      const secret = generateTotpSecret();
      dependencies.users.setPendingTotpSecret?.(numericUserId(user.id), secret);
      return { secret, otpauthUri: totpUri(secret, user.username) };
    },

    /** Turns 2FA on once a code from the new secret checks out. */
    totpEnable(sessionUser: unknown, codeInput: unknown) {
      const user = dependencies.users.getUserByUsername(sessionUsername(sessionUser));
      const pending = user?.totp_pending_secret;
      if (!user || !pending) {
        throw new AppError('Start two-factor setup first', { code: 'AUTH_TOTP_NOT_PENDING', statusCode: 409 });
      }
      const code = typeof codeInput === 'string' ? codeInput : '';
      const now = dependencies.now ? dependencies.now() : Date.now();
      const counter = matchTotp(pending, code, now);
      if (counter === null || !dependencies.users.enableTotp?.(numericUserId(user.id), counter)) {
        throw new AppError('Invalid two-factor code', { code: 'AUTH_INVALID_TOTP', statusCode: 401 });
      }
      return { enabled: true };
    },

    /** Turns 2FA off: needs the password and a current code, not just a session. */
    async totpDisable(sessionUser: unknown, passwordInput: unknown, codeInput: unknown): Promise<{ enabled: false }> {
      const username = sessionUsername(sessionUser);
      await service.login(username, passwordInput, codeInput);
      const user = dependencies.users.getUserByUsername(username);
      if (user) {
        dependencies.users.disableTotp?.(numericUserId(user.id));
      }
      return { enabled: false };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
  return service;
}
