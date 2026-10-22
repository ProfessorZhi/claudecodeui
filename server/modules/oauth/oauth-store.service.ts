/**
 * OAuth storage service.
 *
 * Owns the read/write primitives behind mcp-gateway-SPEC stage 5's OAuth store:
 * client registration, consent grants, authorization codes, OAuth access /
 * refresh token issuance, verification, and the revocation cascades. Plaintext
 * secrets (client secrets, authorization codes, tokens) are generated here and
 * returned exactly once; only their SHA-256 hash reaches the database, so a
 * leaked database file cannot be replayed against the token endpoint. Every
 * timestamp comes from the injected clock, which is what makes expiry and
 * revocation testable without waiting on wall time.
 *
 * This is the storage layer only. PKCE verification, authorization-code
 * single-use / 60-second admission, refresh rotation and reuse detection,
 * redirect-uri and audience validation, and the HTTP endpoints belong to
 * AC-259+.
 *
 * Consumers: this module's criterion (`tests/oauth-store.test.ts`); the later
 * OAuth endpoint tasks (AC-259+) build on it through the OAuth module barrel.
 */

import crypto from 'crypto';

import {
  accessTokensDb,
  getConnection,
  oauthAuthorizationCodesDb,
  oauthClientsDb,
  oauthGrantsDb,
} from '@/modules/database/index.js';

/** The two OAuth token kinds this store issues; a PAT is a third, separate kind. */
export type OAuthTokenKind = 'oauth_access' | 'oauth_refresh';

/**
 * Why an OAuth token verification failed. `wrong_kind` is returned when a caller
 * requires one kind and the row holds the other (e.g. a refresh token presented
 * as an access token).
 */
export type OAuthTokenRejectionReason = 'not_found' | 'revoked' | 'expired' | 'wrong_kind';

/** Caller-supplied fields for {@link OAuthStore.registerClient}. */
export type RegisterClientInput = {
  clientName: string;
  redirectUris: string[];
  /** RFC 7591 registration metadata, stored verbatim as JSON. */
  metadata: unknown;
  /** `'dcr'` or `'manual'`. */
  createdVia: string;
  /** A public (PKCE-only) client stores no secret; its `clientSecret` is null. */
  publicClient?: boolean;
};

/** A freshly registered client. `clientSecret` is the plaintext and is returned only here. */
export type RegisterClientResult = {
  clientId: string;
  clientSecret: string | null;
};

/** Caller-supplied fields for {@link OAuthStore.createGrant}. */
export type CreateGrantInput = {
  userId: number;
  clientId: string;
  scopes: string[];
  resource: string;
};

/** Result of {@link OAuthStore.createGrant}. */
export type CreateGrantResult = { grantId: number };

/** Caller-supplied fields for {@link OAuthStore.issueAuthorizationCode}. */
export type IssueAuthorizationCodeInput = {
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
};

/** A freshly issued code. `code` is the plaintext and is returned only here. */
export type IssueAuthorizationCodeResult = { code: string };

/** Caller-supplied fields for {@link OAuthStore.issueOAuthToken}. */
export type IssueOAuthTokenInput = {
  grantId: number;
  kind: OAuthTokenKind;
  scopes: string[];
  resource: string;
  expiresAt: string;
};

/** A freshly issued token. `token` is the plaintext and is returned only here. */
export type IssueOAuthTokenResult = { token: string; tokenId: number };

/**
 * Result of verifying an OAuth token. On success the row id, the owning grant,
 * the granted scopes and the stored expiry are returned; on failure exactly one
 * {@link OAuthTokenRejectionReason}.
 */
export type VerifyOAuthTokenResult =
  | { ok: true; tokenId: number; grantId: number | null; scopes: string[]; expiresAt: string }
  | { ok: false; reason: OAuthTokenRejectionReason };

/** Result of {@link OAuthStore.revokeGrant}: whether the grant changed and how many tokens the cascade revoked. */
export type RevokeGrantResult = { grantRevoked: boolean; tokensRevoked: number };

/** Result of {@link OAuthStore.disableClient}: whether the client changed and how many tokens the cascade revoked. */
export type DisableClientResult = { clientDisabled: boolean; tokensRevoked: number };

export type OAuthStore = {
  registerClient(input: RegisterClientInput): RegisterClientResult;
  createGrant(input: CreateGrantInput): CreateGrantResult;
  issueAuthorizationCode(input: IssueAuthorizationCodeInput): IssueAuthorizationCodeResult;
  issueOAuthToken(input: IssueOAuthTokenInput): IssueOAuthTokenResult;
  /**
   * Hashes `token` and looks it up. `revoked_at` on the row rejects it as
   * `revoked` (this is what makes a grant or client cascade take effect on the
   * very next check, with no restart), and an elapsed `expires_at` rejects it as
   * `expired`. When `kind` is given, a row of the other kind is `wrong_kind`.
   */
  verifyOAuthToken(token: string, kind?: OAuthTokenKind): VerifyOAuthTokenResult;
  /** Revokes the grant and, in the same transaction, every token under it. */
  revokeGrant(grantId: number): RevokeGrantResult;
  /** Disables the client and, in the same transaction, every grant under it and every token under those. */
  disableClient(clientId: string): DisableClientResult;
};

/** Construction options; `now` is the only clock the store reads. */
export type OAuthStoreOptions = { now?: () => Date };

/** Access-token plaintext prefix, per mcp-gateway-SPEC. */
const ACCESS_TOKEN_PREFIX = 'cca_';

/** Refresh-token plaintext prefix, per mcp-gateway-SPEC. */
const REFRESH_TOKEN_PREFIX = 'ccr_';

/** Prefix length stored for display: a three-character prefix plus five hex digits. */
const TOKEN_PREFIX_LENGTH = 8;

/**
 * Lifetime stored on a new authorization code. The value is the SPEC's 60-second
 * code lifetime; the admission decision built on it is AC-259's, not this
 * layer's.
 */
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

/** SHA-256 of `value`, lowercase hex — the only form any secret reaches disk. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 32 random bytes as lowercase hex — a client secret, code or token plaintext. */
function randomSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Builds the OAuth store. `now` is called for every `created_at` / `expires_at`
 * / `revoked_at` the store writes and for the expiry comparison, so a test can
 * advance time by mutating what the clock returns.
 */
export function createOAuthStore(options: OAuthStoreOptions = {}): OAuthStore {
  const now = options.now ?? (() => new Date());

  return {
    registerClient({
      clientName,
      redirectUris,
      metadata,
      createdVia,
      publicClient,
    }: RegisterClientInput): RegisterClientResult {
      // The client id is public and opaque; the secret exists only in the return.
      const clientId = crypto.randomBytes(16).toString('hex');
      const clientSecret = publicClient ? null : randomSecret();

      oauthClientsDb.insert({
        clientId,
        clientSecretHash: clientSecret === null ? null : sha256Hex(clientSecret),
        clientName,
        redirectUris: JSON.stringify(redirectUris),
        metadata: JSON.stringify(metadata ?? {}),
        createdVia,
        createdAt: now().toISOString(),
      });

      return { clientId, clientSecret };
    },

    createGrant({ userId, clientId, scopes, resource }: CreateGrantInput): CreateGrantResult {
      const grantId = oauthGrantsDb.insert({
        userId,
        clientId,
        scopes: JSON.stringify(scopes),
        resource,
        createdAt: now().toISOString(),
      });
      return { grantId };
    },

    issueAuthorizationCode({
      clientId,
      userId,
      redirectUri,
      codeChallenge,
      scopes,
      resource,
    }: IssueAuthorizationCodeInput): IssueAuthorizationCodeResult {
      const code = randomSecret();
      const issuedAt = now();
      oauthAuthorizationCodesDb.insert({
        codeHash: sha256Hex(code),
        clientId,
        userId,
        redirectUri,
        codeChallenge,
        scopes: JSON.stringify(scopes),
        resource,
        expiresAt: new Date(issuedAt.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      });
      return { code };
    },

    issueOAuthToken({
      grantId,
      kind,
      scopes,
      resource,
      expiresAt,
    }: IssueOAuthTokenInput): IssueOAuthTokenResult {
      const grant = oauthGrantsDb.findById(grantId);
      if (!grant) {
        throw new Error(`Cannot issue an OAuth token for unknown grant ${grantId}`);
      }

      const prefix = kind === 'oauth_access' ? ACCESS_TOKEN_PREFIX : REFRESH_TOKEN_PREFIX;
      const token = `${prefix}${randomSecret()}`;
      const tokenId = accessTokensDb.insert({
        userId: grant.user_id,
        tokenHash: sha256Hex(token),
        tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        name: null,
        scopes: JSON.stringify(scopes),
        expiresAt,
        createdAt: now().toISOString(),
        kind,
        resource,
        grantId,
      });
      return { token, tokenId };
    },

    verifyOAuthToken(token: string, kind?: OAuthTokenKind): VerifyOAuthTokenResult {
      const row = accessTokensDb.findByHash(sha256Hex(token));
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }
      // Read the row fresh every call: a cascade that stamped revoked_at is
      // visible on the next check without any restart or cache invalidation.
      if (row.revoked_at !== null) {
        return { ok: false, reason: 'revoked' };
      }
      if (now().getTime() >= new Date(row.expires_at).getTime()) {
        return { ok: false, reason: 'expired' };
      }
      if (kind !== undefined && row.kind !== kind) {
        return { ok: false, reason: 'wrong_kind' };
      }
      return {
        ok: true,
        tokenId: row.id,
        grantId: row.grant_id,
        scopes: JSON.parse(row.scopes) as string[],
        expiresAt: row.expires_at,
      };
    },

    revokeGrant(grantId: number): RevokeGrantResult {
      const revokedAt = now().toISOString();
      return getConnection().transaction(() => {
        const grantRevoked = oauthGrantsDb.revoke(grantId, revokedAt);
        const tokensRevoked = accessTokensDb.revokeByGrantId(grantId, revokedAt);
        return { grantRevoked, tokensRevoked };
      })();
    },

    disableClient(clientId: string): DisableClientResult {
      const disabledAt = now().toISOString();
      return getConnection().transaction(() => {
        const clientDisabled = oauthClientsDb.disable(clientId, disabledAt);
        let tokensRevoked = 0;
        for (const grantId of oauthGrantsDb.listIdsByClient(clientId)) {
          oauthGrantsDb.revoke(grantId, disabledAt);
          tokensRevoked += accessTokensDb.revokeByGrantId(grantId, disabledAt);
        }
        return { clientDisabled, tokensRevoked };
      })();
    },
  };
}
