/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table.
 * This is a single-user system, but the schema supports multiple
 * users for forward compatibility.
 */

import { getConnection } from '@/modules/database/core/index.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
  totp_secret?: string | null;
  totp_pending_secret?: string | null;
  totp_enabled?: number | null;
  totp_last_counter?: number | null;
};

type UserPublicRow = Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login'>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  createUser(username: string, passwordHash: string): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash);
    return { id: result.lastInsertRowid, username };
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  /** Stores a secret awaiting its first verified code. Does not enable 2FA. */
  setPendingTotpSecret(userId: number, secret: string): void {
    getConnection()
      .prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?')
      .run(secret, userId);
  },

  /** Promotes the pending secret and turns 2FA on, at the counter just used. */
  enableTotp(userId: number, counter: number): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
           totp_enabled = 1, totp_last_counter = ?
         WHERE id = ? AND totp_pending_secret IS NOT NULL`
      )
      .run(counter, userId);
    return result.changes === 1;
  },

  /** Turns 2FA off and forgets every secret. */
  disableTotp(userId: number): void {
    getConnection()
      .prepare(
        `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL,
           totp_enabled = 0, totp_last_counter = NULL WHERE id = ?`
      )
      .run(userId);
  },

  /**
   * Records `counter` as used, atomically. False when that code (or a later
   * one) was already used: the caller refuses it as a replay.
   */
  consumeTotpCounter(userId: number, counter: number): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE users SET totp_last_counter = ?
         WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)`
      )
      .run(counter, userId, counter);
    return result.changes === 1;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /** Returns the first active user. Used for single-user mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as UserPublicRow | undefined;
  },

  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },
};
