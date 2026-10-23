import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import {
  accessTokensDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  oauthAuthorizationCodesDb,
  oauthCodeRedemptionsDb,
  oauthGrantsDb,
} from '@/modules/database/index.js';
import { MCP_GATEWAY_PATH, mountMcpGateway } from '@/modules/mcp-gateway/index.js';
import { createOAuthProvider, createOAuthStore } from '@/modules/oauth/index.js';
import type { OAuthProvider, OAuthStore } from '@/modules/oauth/index.js';
import { bearerToken } from '@/shared/utils.js';

/**
 * AC-259 criterion: OAuth authorization-server semantics.
 *
 * Every reading is a real one against a real better-sqlite3 database built by the
 * production `initializeDatabase()`/`runMigrations()` path on a temp
 * `DATABASE_PATH`, through the real `createOAuthStore` + `createOAuthProvider`.
 * A single mutable clock (`nowMs` → `now = () => new Date(nowMs)`) is injected
 * into both layers, so advancing it exercises the 60-second code lifetime and the
 * token TTL boundaries without sleeping; the `/mcp` audience reading goes over
 * real HTTP through `mountMcpGateway`'s `authorize` seam.
 *
 * The legs map one-to-one onto the AC: (a) PKCE S256, (b) single-use / 60-second /
 * replay revocation, (c) refresh rotation and reuse revocation, (d) scope
 * narrowing, (e) audience binding, (f) exact redirect_uri and client secret,
 * (g) configurable lifetimes and expiry boundaries, (h) the throttled `last_used`
 * stamp on both the access token and its grant.
 */

const PUBLIC_BASE_URL = 'https://cli.example';
const AUDIENCE = `${PUBLIC_BASE_URL}/mcp`;
const REDIRECT_URI = 'https://app.example/cb';
const GRANT_SCOPES = ['cloudcli:read', 'cloudcli:session:send'];

const sha256Hex = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/** A fresh PKCE pair: a random verifier and its S256 (base64url) challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Registers a confidential client (one that carries a secret) for the given redirect URIs. */
function registerConfidentialClient(
  store: OAuthStore,
  redirectUris: string[]
): { clientId: string; clientSecret: string } {
  const client = store.registerClient({
    clientName: 'confidential-app',
    redirectUris,
    metadata: { kind: 'test' },
    createdVia: 'manual',
  });
  if (client.clientSecret === null) {
    throw new Error('expected the registered client to be confidential');
  }
  return { clientId: client.clientId, clientSecret: client.clientSecret };
}

/** The `revoked_at` of the token row for `token`, or null when the row is absent or live. */
const tokenRevokedAt = (token: string): string | null =>
  accessTokensDb.findByHash(sha256Hex(token))?.revoked_at ?? null;

/** The `revoked_at` of a grant, or null when the grant is absent or live. */
const grantRevokedAt = (grantId: number): string | null =>
  oauthGrantsDb.findById(grantId)?.revoked_at ?? null;

type OAuthProviderOverrides = { accessTokenTtlSeconds?: number; refreshTokenTtlDays?: number };

type OAuthProviderContext = {
  store: OAuthStore;
  provider: OAuthProvider;
  userId: number;
  /** Advances the shared clock by `milliseconds`. */
  advance: (milliseconds: number) => void;
  /** The shared clock's current epoch millis. */
  nowMsValue: () => number;
  /** Builds another provider over the same store and clock, with lifetime overrides. */
  makeProvider: (overrides?: OAuthProviderOverrides) => OAuthProvider;
};

/** Fresh temp database on the production migration path, with one owner user and one shared clock. */
async function withOAuthProvider(
  runTest: (context: OAuthProviderContext) => void | Promise<void>
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousAccessTtl = process.env.MCP_ACCESS_TOKEN_TTL_SEC;
  const previousRefreshTtl = process.env.MCP_REFRESH_TOKEN_TTL_DAYS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'oauth-provider-'));
  const databasePath = path.join(tempDirectory, 'oauth-provider.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  // Harden the default-TTL reading: an ambient value must not be able to move it
  // away from the SPEC default, so the criterion owns its own root rather than
  // inheriting a deployer's environment.
  delete process.env.MCP_ACCESS_TOKEN_TTL_SEC;
  delete process.env.MCP_REFRESH_TOKEN_TTL_DAYS;
  await initializeDatabase();

  try {
    const userId = Number(
      getConnection()
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run('oauth-provider-owner', 'hash').lastInsertRowid
    );
    let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const now = (): Date => new Date(nowMs);
    const store = createOAuthStore({ now });
    const makeProvider = (overrides: OAuthProviderOverrides = {}): OAuthProvider =>
      createOAuthProvider({ store, now, publicBaseUrl: PUBLIC_BASE_URL, ...overrides });
    const provider = makeProvider();

    await runTest({
      store,
      provider,
      userId,
      advance: (milliseconds) => {
        nowMs += milliseconds;
      },
      nowMsValue: () => nowMs,
      makeProvider,
    });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousAccessTtl === undefined) {
      delete process.env.MCP_ACCESS_TOKEN_TTL_SEC;
    } else {
      process.env.MCP_ACCESS_TOKEN_TTL_SEC = previousAccessTtl;
    }
    if (previousRefreshTtl === undefined) {
      delete process.env.MCP_REFRESH_TOKEN_TTL_DAYS;
    } else {
      process.env.MCP_REFRESH_TOKEN_TTL_DAYS = previousRefreshTtl;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// --------------------------- HTTP helpers (node:http, never fetch) ------------

async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type HttpReading = { label: string; status: number; bodyHead: string };

/** POSTs a `tools/list` JSON-RPC request to `/mcp` with an optional bearer token. */
function postMcp(baseUrl: string, token: string | null, label: string): Promise<HttpReading> {
  const url = new URL(MCP_GATEWAY_PATH, baseUrl);
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    accept: 'application/json, text/event-stream',
  };
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }

  return new Promise<HttpReading>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ label, status: res.statusCode ?? 0, bodyHead: body.slice(0, 80).replace(/\s+/g, ' ') });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --------------------------- (a) PKCE ----------------------------------------

test('(a) PKCE: S256 is mandatory — missing/plain challenge → invalid_request, wrong verifier → invalid_grant, correct S256 → tokens', async () => {
  await withOAuthProvider(async ({ store, provider, userId }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const scopes = ['cloudcli:read'];
    const { verifier, challenge } = pkcePair();

    const missingChallenge = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: undefined,
      codeChallengeMethod: 'S256',
      scopes,
      userId,
    });
    const plainMethod = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'plain',
      scopes,
      userId,
    });
    const accepted = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scopes,
      userId,
    });
    if (!accepted.ok) {
      assert.fail(`a correct S256 request must be authorized, got ${JSON.stringify(accepted)}`);
    }

    const wrongVerifier = provider.exchangeAuthorizationCode({
      code: accepted.code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: REDIRECT_URI,
      codeVerifier: 'a-verifier-that-does-not-match',
      resource: AUDIENCE,
    });

    // A fresh code so the positive leg is independent of the failed one.
    const acceptedAgain = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scopes,
      userId,
    });
    if (!acceptedAgain.ok) {
      assert.fail('the second S256 authorize must succeed');
    }
    const exchanged = provider.exchangeAuthorizationCode({
      code: acceptedAgain.code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: AUDIENCE,
    });
    if (!exchanged.ok) {
      assert.fail(`a correct S256 exchange must succeed, got ${JSON.stringify(exchanged)}`);
    }

    console.log(`(a) missing challenge      -> ${JSON.stringify(missingChallenge)}`);
    console.log(`(a) method='plain'         -> ${JSON.stringify(plainMethod)}`);
    console.log(`(a) mismatched verifier    -> ${JSON.stringify(wrongVerifier)}`);
    console.log(
      `(a) correct S256 exchange  -> { ok: true, accessTokenPrefix: ${JSON.stringify(
        exchanged.accessToken.slice(0, 8)
      )}, refreshTokenPrefix: ${JSON.stringify(exchanged.refreshToken.slice(0, 8))}, expiresIn: ${
        exchanged.expiresIn
      } }`
    );

    assert.deepEqual(missingChallenge, { ok: false, error: 'invalid_request' });
    assert.deepEqual(plainMethod, { ok: false, error: 'invalid_request' });
    assert.deepEqual(wrongVerifier, { ok: false, error: 'invalid_grant' });
    assert.equal(exchanged.accessToken.startsWith('cca_'), true);
    assert.equal(exchanged.refreshToken.startsWith('ccr_'), true);
  });
});

// --------------------------- (b) code single-use / 60s / replay ---------------

test('(b) authorization code: single-use, 60-second expiry, and a replay revokes the tokens it already issued', async () => {
  await withOAuthProvider(async ({ store, provider, userId, advance }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const scopes = ['cloudcli:read'];
    const { verifier, challenge } = pkcePair();

    const authorize = () => {
      const result = provider.authorize({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scopes,
        userId,
      });
      if (!result.ok) {
        assert.fail(`authorize must succeed, got ${JSON.stringify(result)}`);
      }
      return result;
    };
    const exchange = (code: string) =>
      provider.exchangeAuthorizationCode({
        code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
        resource: AUDIENCE,
      });

    const first = authorize();
    const firstExchange = exchange(first.code);
    if (!firstExchange.ok) {
      assert.fail(`the first exchange must succeed, got ${JSON.stringify(firstExchange)}`);
    }

    const replay = exchange(first.code);
    const accessAfterReplay = store.verifyOAuthToken(firstExchange.accessToken, 'oauth_access');
    const refreshAfterReplay = store.verifyOAuthToken(firstExchange.refreshToken, 'oauth_refresh');
    const accessRevokedAt = tokenRevokedAt(firstExchange.accessToken);
    const refreshRevokedAt = tokenRevokedAt(firstExchange.refreshToken);

    const expiring = authorize();
    advance(61_000);
    const expiredExchange = exchange(expiring.code);

    const fresh = authorize();
    advance(59_000);
    const freshExchange = exchange(fresh.code);

    console.log(`(b) replay of a consumed code -> ${JSON.stringify(replay)}`);
    console.log(`(b) access after replay       -> ${JSON.stringify(accessAfterReplay)}`);
    console.log(`(b) refresh after replay      -> ${JSON.stringify(refreshAfterReplay)}`);
    console.log(`(b) access_tokens.revoked_at  -> ${JSON.stringify(accessRevokedAt)}`);
    console.log(`(b) refresh revoked_at        -> ${JSON.stringify(refreshRevokedAt)}`);
    console.log(`(b) exchange at now+61s       -> ${JSON.stringify(expiredExchange)}`);
    console.log(`(b) exchange at now+59s       -> ${JSON.stringify(freshExchange)}`);

    assert.deepEqual(replay, { ok: false, error: 'invalid_grant' });
    assert.deepEqual(accessAfterReplay, { ok: false, reason: 'revoked' });
    assert.deepEqual(refreshAfterReplay, { ok: false, reason: 'revoked' });
    assert.notEqual(accessRevokedAt, null);
    assert.notEqual(refreshRevokedAt, null);
    assert.deepEqual(expiredExchange, { ok: false, error: 'invalid_grant' });
    assert.equal(freshExchange.ok, true);
  });
});

// --------------------------- (c) refresh rotation / reuse ---------------------

test('(c) refresh rotation: a new pair is issued, the old refresh dies, and reuse revokes the whole grant without touching another grant', async () => {
  await withOAuthProvider(async ({ store, provider, userId }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const { verifier, challenge } = pkcePair();

    const exchangeNewCode = () => {
      const authorized = provider.authorize({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scopes: GRANT_SCOPES,
        userId,
      });
      if (!authorized.ok) {
        assert.fail(`authorize must succeed, got ${JSON.stringify(authorized)}`);
      }
      const exchanged = provider.exchangeAuthorizationCode({
        code: authorized.code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
        resource: AUDIENCE,
      });
      if (!exchanged.ok) {
        assert.fail(`exchange must succeed, got ${JSON.stringify(exchanged)}`);
      }
      const grantId = oauthCodeRedemptionsDb.findByHash(sha256Hex(authorized.code))?.grant_id ?? -1;
      return { grantId, ...exchanged };
    };
    const rotate = (refreshToken: string) =>
      provider.exchangeRefreshToken({
        refreshToken,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      });

    // Grant A: exchange, then rotate.
    const grantA = exchangeNewCode();
    const rotationA = rotate(grantA.refreshToken);
    if (!rotationA.ok) {
      assert.fail(`rotation must succeed, got ${JSON.stringify(rotationA)}`);
    }
    const oldRefreshState = store.verifyOAuthToken(grantA.refreshToken, 'oauth_refresh');

    // Grant B: an independent authorization that must survive A's reuse revocation.
    const grantB = exchangeNewCode();
    const rotationB = rotate(grantB.refreshToken);
    if (!rotationB.ok) {
      assert.fail(`grant B's rotation must succeed, got ${JSON.stringify(rotationB)}`);
    }

    // Replay A's already-rotated refresh: the whole grant must die.
    const reuse = rotate(grantA.refreshToken);
    const newAccessState = store.verifyOAuthToken(rotationA.accessToken, 'oauth_access');
    const newRefreshState = store.verifyOAuthToken(rotationA.refreshToken, 'oauth_refresh');
    const grantARevokedAt = grantRevokedAt(grantA.grantId);
    const grantBStillOk = store.verifyOAuthToken(rotationB.accessToken, 'oauth_access');

    console.log(
      `(c) rotated access differs from original -> ${grantA.accessToken !== rotationA.accessToken}`
    );
    console.log(
      `(c) rotated refresh differs from original -> ${grantA.refreshToken !== rotationA.refreshToken}`
    );
    console.log(`(c) old refresh after rotation   -> ${JSON.stringify(oldRefreshState)}`);
    console.log(`(c) replay of rotated refresh    -> ${JSON.stringify(reuse)}`);
    console.log(`(c) new access after reuse       -> ${JSON.stringify(newAccessState)}`);
    console.log(`(c) new refresh after reuse      -> ${JSON.stringify(newRefreshState)}`);
    console.log(`(c) oauth_grants.revoked_at      -> ${JSON.stringify(grantARevokedAt)}`);
    console.log(`(c) other grant B access         -> ${JSON.stringify(grantBStillOk)}`);

    assert.notEqual(rotationA.accessToken, grantA.accessToken);
    assert.notEqual(rotationA.refreshToken, grantA.refreshToken);
    assert.deepEqual(oldRefreshState, { ok: false, reason: 'revoked' });
    assert.deepEqual(reuse, { ok: false, error: 'invalid_grant' });
    assert.deepEqual(newAccessState, { ok: false, reason: 'revoked' });
    assert.deepEqual(newRefreshState, { ok: false, reason: 'revoked' });
    assert.notEqual(grantARevokedAt, null);
    assert.equal(grantBStillOk.ok, true);
  });
});

// --------------------------- (d) scope narrowing ------------------------------

test('(d) refresh scope: narrowing to a subset is honoured, widening past the grant is invalid_scope', async () => {
  await withOAuthProvider(async ({ store, provider, userId }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const { verifier, challenge } = pkcePair();

    const authorized = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scopes: GRANT_SCOPES,
      userId,
    });
    if (!authorized.ok) {
      assert.fail(`authorize must succeed, got ${JSON.stringify(authorized)}`);
    }
    const exchanged = provider.exchangeAuthorizationCode({
      code: authorized.code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: AUDIENCE,
    });
    if (!exchanged.ok) {
      assert.fail(`exchange must succeed, got ${JSON.stringify(exchanged)}`);
    }

    const narrowed = provider.exchangeRefreshToken({
      refreshToken: exchanged.refreshToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      scopes: ['cloudcli:read'],
    });
    if (!narrowed.ok) {
      assert.fail(`narrowing must be allowed, got ${JSON.stringify(narrowed)}`);
    }
    const narrowedAccess = store.verifyOAuthToken(narrowed.accessToken, 'oauth_access');
    const narrowedScopes = narrowedAccess.ok ? narrowedAccess.scopes : null;

    const widened = provider.exchangeRefreshToken({
      refreshToken: narrowed.refreshToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      scopes: [...GRANT_SCOPES, 'cloudcli:session:control'],
    });

    console.log(`(d) narrowing result          -> ${JSON.stringify(narrowed.ok)}`);
    console.log(`(d) narrowed access scopes    -> ${JSON.stringify(narrowedScopes)}`);
    console.log(`(d) widening past the grant   -> ${JSON.stringify(widened)}`);

    assert.deepEqual(narrowedScopes, ['cloudcli:read']);
    assert.deepEqual(widened, { ok: false, error: 'invalid_scope' });
  });
});

// --------------------------- (e) audience binding -----------------------------

test('(e) resource audience: a mismatch is invalid_target, the default is the gateway resource, and /mcp returns 401 for a mis-bound token', async () => {
  await withOAuthProvider(async ({ store, provider, userId, nowMsValue }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const scopes = ['cloudcli:read'];
    const { verifier, challenge } = pkcePair();

    const wrongAudience = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scopes,
      resource: 'https://evil.example/mcp',
      userId,
    });
    const defaultAudienceRequest = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scopes,
      userId,
    });
    if (!defaultAudienceRequest.ok) {
      assert.fail(`a default-audience authorize must succeed, got ${JSON.stringify(defaultAudienceRequest)}`);
    }
    const codeResource =
      oauthAuthorizationCodesDb.findByHash(sha256Hex(defaultAudienceRequest.code))?.resource ?? null;

    const wrongResource = provider.exchangeAuthorizationCode({
      code: defaultAudienceRequest.code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: 'https://other.example/mcp',
    });
    const exchanged = provider.exchangeAuthorizationCode({
      code: defaultAudienceRequest.code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: AUDIENCE,
    });
    if (!exchanged.ok) {
      assert.fail(`a matching-resource exchange must succeed, got ${JSON.stringify(exchanged)}`);
    }
    const tokenResource = accessTokensDb.findByHash(sha256Hex(exchanged.accessToken))?.resource ?? null;

    const verifyWrong = provider.verifyAccessToken(exchanged.accessToken, {
      resource: 'https://other.example/mcp',
    });
    const verifyRight = provider.verifyAccessToken(exchanged.accessToken, { resource: AUDIENCE });

    // A token genuinely bound to another resource, issued directly, for the HTTP leg.
    const otherGrant = store.createGrant({
      userId,
      clientId: client.clientId,
      scopes,
      resource: 'https://other.example/mcp',
    });
    const otherAccess = store.issueOAuthToken({
      grantId: otherGrant.grantId,
      kind: 'oauth_access',
      scopes,
      resource: 'https://other.example/mcp',
      expiresAt: new Date(nowMsValue() + 3_600_000).toISOString(),
    }).token;

    const audienceGate: RequestHandler = (req, res, next) => {
      const token = bearerToken(req.headers.authorization);
      const verified = token === null ? null : provider.verifyAccessToken(token, { resource: AUDIENCE });
      if (verified === null || !verified.ok) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      next();
    };

    const app = express();
    app.use(express.json({ limit: '50mb' }));
    const mounted = mountMcpGateway(app, { env: { MCP_ENABLED: 'true' }, authorize: audienceGate });
    const { baseUrl, close } = await listen(app);
    const [wrongTokenReading, correctTokenReading] = await (async () => {
      try {
        return [await postMcp(baseUrl, otherAccess, 'mis-bound token'), await postMcp(baseUrl, exchanged.accessToken, 'bound token')] as const;
      } finally {
        await close();
      }
    })();

    console.log(`(e) authorize with evil resource -> ${JSON.stringify(wrongAudience)}`);
    console.log(`(e) issued code resource         -> ${JSON.stringify(codeResource)}`);
    console.log(`(e) exchange with wrong resource -> ${JSON.stringify(wrongResource)}`);
    console.log(`(e) issued token resource        -> ${JSON.stringify(tokenResource)}`);
    console.log(`(e) verifyAccessToken wrong      -> ${JSON.stringify(verifyWrong)}`);
    console.log(`(e) verifyAccessToken right      -> ${JSON.stringify(verifyRight)}`);
    console.log(
      `(e) POST /mcp [${wrongTokenReading.label}] -> ${wrongTokenReading.status} :: ${JSON.stringify(
        wrongTokenReading.bodyHead
      )}`
    );
    console.log(
      `(e) POST /mcp [${correctTokenReading.label}] -> ${correctTokenReading.status} :: ${JSON.stringify(
        correctTokenReading.bodyHead
      )}`
    );

    assert.deepEqual(wrongAudience, { ok: false, error: 'invalid_target' });
    assert.equal(codeResource, AUDIENCE);
    assert.deepEqual(wrongResource, { ok: false, error: 'invalid_target' });
    assert.equal(tokenResource, AUDIENCE);
    assert.deepEqual(verifyWrong, { ok: false, reason: 'invalid_target' });
    assert.equal(verifyRight.ok, true);
    assert.equal(mounted.mounted, true);
    assert.equal(wrongTokenReading.status, 401);
    assert.notEqual(correctTokenReading.status, 401);
  });
});

// --------------------------- (f) redirect_uri + client secret -----------------

test('(f) redirect_uri is matched exactly and a confidential client secret is enforced', async () => {
  await withOAuthProvider(async ({ store, provider, userId }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const scopes = ['cloudcli:read'];
    const { verifier, challenge } = pkcePair();

    const authorizeWithRedirect = (redirectUri: string) =>
      provider.authorize({
        clientId: client.clientId,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scopes,
        userId,
      });

    const trailingSlash = authorizeWithRedirect(`${REDIRECT_URI}/`);
    const suffix = authorizeWithRedirect(`${REDIRECT_URI}-x`);
    const upperCase = authorizeWithRedirect('https://APP.example/cb');
    const extraQuery = authorizeWithRedirect(`${REDIRECT_URI}?x=1`);
    const exact = authorizeWithRedirect(REDIRECT_URI);
    if (!exact.ok) {
      assert.fail(`the exact redirect_uri must be accepted, got ${JSON.stringify(exact)}`);
    }

    const wrongSecret = provider.exchangeAuthorizationCode({
      code: exact.code,
      clientId: client.clientId,
      clientSecret: 'not-the-client-secret',
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: AUDIENCE,
    });
    const tokensForGrant = (
      getConnection()
        .prepare('SELECT COUNT(*) AS count FROM access_tokens WHERE grant_id = ?')
        .get(exact.grantId) as { count: number }
    ).count;
    const withCorrectSecret = provider.exchangeAuthorizationCode({
      code: exact.code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: AUDIENCE,
    });

    console.log(`(f) redirect '${REDIRECT_URI}/'      -> ${JSON.stringify(trailingSlash)}`);
    console.log(`(f) redirect '${REDIRECT_URI}-x'     -> ${JSON.stringify(suffix)}`);
    console.log(`(f) redirect 'https://APP.example/cb' -> ${JSON.stringify(upperCase)}`);
    console.log(`(f) redirect '${REDIRECT_URI}?x=1'   -> ${JSON.stringify(extraQuery)}`);
    console.log(`(f) redirect exact '${REDIRECT_URI}'  -> ${JSON.stringify(exact.ok)}`);
    console.log(`(f) wrong client_secret               -> ${JSON.stringify(wrongSecret)}`);
    console.log(`(f) tokens issued despite wrong secret -> ${tokensForGrant}`);
    console.log(`(f) correct secret exchange            -> ${JSON.stringify(withCorrectSecret.ok)}`);

    assert.deepEqual(trailingSlash, { ok: false, error: 'invalid_request' });
    assert.deepEqual(suffix, { ok: false, error: 'invalid_request' });
    assert.deepEqual(upperCase, { ok: false, error: 'invalid_request' });
    assert.deepEqual(extraQuery, { ok: false, error: 'invalid_request' });
    assert.deepEqual(wrongSecret, { ok: false, error: 'invalid_client' });
    assert.equal(tokensForGrant, 0);
    assert.equal(withCorrectSecret.ok, true);
  });
});

// --------------------------- (g) configurable lifetimes ------------------------

test('(g) lifetimes: default access 3600s / refresh 30d, configurable to 120s / 1d, with exact expiry boundaries', async () => {
  await withOAuthProvider(async ({ store, provider, userId, advance, nowMsValue, makeProvider }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const scopes = ['cloudcli:read'];
    const { verifier, challenge } = pkcePair();

    const exchangeNewCode = (active: OAuthProvider) => {
      const authorized = active.authorize({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scopes,
        userId,
      });
      if (!authorized.ok) {
        assert.fail(`authorize must succeed, got ${JSON.stringify(authorized)}`);
      }
      const exchanged = active.exchangeAuthorizationCode({
        code: authorized.code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
        resource: AUDIENCE,
      });
      if (!exchanged.ok) {
        assert.fail(`exchange must succeed, got ${JSON.stringify(exchanged)}`);
      }
      return exchanged;
    };

    // Default provider: SPEC defaults.
    const issuedAtDefault = nowMsValue();
    const defaults = exchangeNewCode(provider);
    const defaultAccessExpiry = accessTokensDb.findByHash(sha256Hex(defaults.accessToken))?.expires_at ?? '';
    const defaultRefreshExpiry = accessTokensDb.findByHash(sha256Hex(defaults.refreshToken))?.expires_at ?? '';
    const defaultAccessTtlSeconds = (new Date(defaultAccessExpiry).getTime() - issuedAtDefault) / 1000;
    const defaultRefreshTtlSeconds = (new Date(defaultRefreshExpiry).getTime() - issuedAtDefault) / 1000;

    // Configured provider over the same store and clock.
    const configured = makeProvider({ accessTokenTtlSeconds: 120, refreshTokenTtlDays: 1 });
    const issuedAtConfigured = nowMsValue();
    const configuredTokens = exchangeNewCode(configured);
    const configuredAccessExpiry =
      accessTokensDb.findByHash(sha256Hex(configuredTokens.accessToken))?.expires_at ?? '';
    const configuredRefreshExpiry =
      accessTokensDb.findByHash(sha256Hex(configuredTokens.refreshToken))?.expires_at ?? '';
    const configuredAccessTtlSeconds =
      (new Date(configuredAccessExpiry).getTime() - issuedAtConfigured) / 1000;
    const configuredRefreshTtlSeconds =
      (new Date(configuredRefreshExpiry).getTime() - issuedAtConfigured) / 1000;

    // Access-token expiry boundary, one second either side.
    advance(120_000 - 1);
    const accessBeforeExpiry = configured.verifyAccessToken(configuredTokens.accessToken);
    advance(1);
    const accessAtExpiry = configured.verifyAccessToken(configuredTokens.accessToken);

    // Refresh-token expiry boundary, one second either side.
    advance(86_400_000 - 120_000 - 1);
    const refreshBeforeExpiry = store.verifyOAuthToken(configuredTokens.refreshToken, 'oauth_refresh');
    advance(1);
    const refreshAtExpiry = store.verifyOAuthToken(configuredTokens.refreshToken, 'oauth_refresh');

    console.log(
      `(g) default access expires_at - now = ${defaultAccessTtlSeconds}s (refresh ${defaultRefreshTtlSeconds}s)`
    );
    console.log(
      `(g) configured access expires_at - now = ${configuredAccessTtlSeconds}s (refresh ${configuredRefreshTtlSeconds}s)`
    );
    console.log(`(g) access at now+119s  -> ${JSON.stringify(accessBeforeExpiry)}`);
    console.log(`(g) access at now+120s  -> ${JSON.stringify(accessAtExpiry)}`);
    console.log(`(g) refresh at now+1d-1s -> ${JSON.stringify(refreshBeforeExpiry)}`);
    console.log(`(g) refresh at now+1d    -> ${JSON.stringify(refreshAtExpiry)}`);

    assert.equal(defaultAccessTtlSeconds, 3600);
    assert.equal(defaultRefreshTtlSeconds, 30 * 86_400);
    assert.equal(configuredAccessTtlSeconds, 120);
    assert.equal(configuredRefreshTtlSeconds, 86_400);
    assert.equal(accessBeforeExpiry.ok, true);
    assert.deepEqual(accessAtExpiry, { ok: false, reason: 'expired' });
    assert.equal(refreshBeforeExpiry.ok, true);
    assert.deepEqual(refreshAtExpiry, { ok: false, reason: 'expired' });
  });
});

// --------------------------- (h) last_used stamping ---------------------------

test('(h) verifying an OAuth access token stamps the token and its grant, throttled to one write per window', async () => {
  await withOAuthProvider(async ({ store, provider, userId, advance, nowMsValue }) => {
    const client = registerConfidentialClient(store, [REDIRECT_URI]);
    const { verifier, challenge } = pkcePair();

    const authorized = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scopes: GRANT_SCOPES,
      userId,
    });
    if (!authorized.ok) {
      assert.fail(`authorize must succeed, got ${JSON.stringify(authorized)}`);
    }

    const exchanged = provider.exchangeAuthorizationCode({
      code: authorized.code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: AUDIENCE,
    });
    if (!exchanged.ok) {
      assert.fail(`exchange must succeed, got ${JSON.stringify(exchanged)}`);
    }

    const tokenLastUsed = (): string | null =>
      accessTokensDb.findByHash(sha256Hex(exchanged.accessToken))?.last_used ?? null;
    const grantLastUsed = (): string | null =>
      oauthGrantsDb.findById(authorized.grantId)?.last_used ?? null;

    // Never verified yet: neither the token nor the grant carries a reading.
    console.log(`(h) before verify: token.last_used=${tokenLastUsed()} grant.last_used=${grantLastUsed()}`);
    assert.equal(tokenLastUsed(), null);
    assert.equal(grantLastUsed(), null);

    // t0: a successful verify stamps both rows with the clock's reading.
    const firstVerified = provider.verifyAccessToken(exchanged.accessToken, { resource: AUDIENCE });
    assert.equal(firstVerified.ok, true);
    const firstStamp = new Date(nowMsValue()).toISOString();
    console.log(
      `(h) after verify @t0: token.last_used=${tokenLastUsed()} grant.last_used=${grantLastUsed()} (clock ${firstStamp})`
    );
    assert.equal(tokenLastUsed(), firstStamp);
    assert.equal(grantLastUsed(), firstStamp);

    // t0+59s: inside the 60s window, so neither row is rewritten.
    advance(59_000);
    assert.equal(provider.verifyAccessToken(exchanged.accessToken, { resource: AUDIENCE }).ok, true);
    console.log(
      `(h) after verify @t0+59s: token.last_used=${tokenLastUsed()} grant.last_used=${grantLastUsed()}`
    );
    assert.equal(tokenLastUsed(), firstStamp);
    assert.equal(grantLastUsed(), firstStamp);

    // t0+61s: past the window, so both rows advance to the new reading.
    advance(2_000);
    assert.equal(provider.verifyAccessToken(exchanged.accessToken, { resource: AUDIENCE }).ok, true);
    const secondStamp = new Date(nowMsValue()).toISOString();
    console.log(
      `(h) after verify @t0+61s: token.last_used=${tokenLastUsed()} grant.last_used=${grantLastUsed()} (clock ${secondStamp})`
    );
    assert.equal(tokenLastUsed(), secondStamp);
    assert.equal(grantLastUsed(), secondStamp);
    assert.notEqual(secondStamp, firstStamp);
  });
});
