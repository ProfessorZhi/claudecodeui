/**
 * `/api/settings/access-tokens` route criterion.
 *
 * Drives the production settings route factory (`createSettingsRouter`) over real
 * HTTP (`app.listen(0)` + `fetch`), assembled with the real OAuth token service
 * and a real better-sqlite3 database built in a temp directory. Covers:
 *   (a) creating tokens for 7/30/90 returns 201 with exactly one plaintext each;
 *   (b) listing returns neither plaintext nor the stored hash, only the safe fields;
 *   (c) a lifetime outside 7/30/90 is 400 and writes no row;
 *   (d) revocation returns 200, invalidates the token, and a repeat revoke is 404;
 *   (e) another user cannot revoke or list a token it does not own;
 *   (f) the retired `/api/settings/api-keys` endpoints are no longer handled (404);
 *   (g) the PAT list is PAT-only: an OAuth row never appears in it, and the
 *       advanced `/oauth-tokens` list is the surface that carries it, per user;
 *   (h) the OAuth-token list is read-only and safe: its exact key set (with the
 *       grant's client name), never `token_hash`, and POST/DELETE answer 404.
 *
 * The token service is created after `process.env.DATABASE_PATH` points at the
 * temp database, and every token read goes through the database module barrel.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  accessTokensDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  oauthClientsDb,
  oauthGrantsDb,
} from '@/modules/database/index.js';
import { createAccessTokensService } from '@/modules/oauth/index.js';
import { createSettingsRouter, createSettingsService } from '@/modules/settings/index.js';
import { AppError } from '@/shared/utils.js';

const USER_ONE = 1;
const USER_TWO = 2;
const START = new Date('2026-01-01T00:00:00.000Z');

/** A personal access token is `ccp_` plus 32 random bytes rendered as 64 hex digits. */
const PLAINTEXT_PATTERN = /^ccp_[0-9a-f]{64}$/;

type Harness = {
  /** Base URL of the mounted settings router, e.g. `http://127.0.0.1:PORT/api/settings`. */
  baseUrl: string;
  /** Switches the id the injected auth middleware stamps onto `req.user`. */
  setUser: (userId: number) => void;
  /** The real OAuth token service the settings routes delegate to. */
  tokens: ReturnType<typeof createAccessTokensService>;
  /** The stored `token_hash` for a token id, read straight from the database. */
  tokenHashOf: (tokenId: number) => string;
  /** The current row count of `access_tokens`. */
  countRows: () => number;
  /**
   * Inserts a full OAuth issuance — client, grant and a live `oauth_access`
   * token under that grant — the way the OAuth flow would, and hands back the
   * ids and the plaintext so a test can address each row.
   */
  seedOAuthToken: (userId: number, clientName: string) => SeededOAuthToken;
};

/** The rows `seedOAuthToken` created, plus the plaintext whose hash is stored. */
type SeededOAuthToken = {
  clientId: string;
  clientName: string;
  grantId: number;
  tokenId: number;
  plaintext: string;
  tokenHash: string;
};

/** Recursively collects every string in `value` that matches `pattern`. */
function collectMatchingStrings(value: unknown, pattern: RegExp, found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (pattern.test(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectMatchingStrings(item, pattern, found);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectMatchingStrings(item, pattern, found);
  }
  return found;
}

/**
 * Runs `run` against a fresh temp database, a real token service, and an express
 * server hosting the production settings router. Cleans everything up afterwards.
 */
async function withSettingsServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'access-tokens-routes-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const connection = getConnection();
  const insertUser = connection.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
  insertUser.run(USER_ONE, 'owner', 'hash');
  insertUser.run(USER_TWO, 'intruder', 'hash');

  const clock = { current: new Date(START.getTime()) };
  const tokens = createAccessTokensService({ now: () => new Date(clock.current.getTime()) });

  /** Mirrors settings.module.ts's grant-to-client-name resolution for the harness. */
  const resolveGrantClientName = (grantId: number | null): string | null => {
    if (grantId === null) return null;
    const grant = oauthGrantsDb.findById(grantId);
    if (grant === undefined) return null;
    return oauthClientsDb.findById(grant.client_id)?.client_name ?? null;
  };

  /** Writes the client/grant/token rows an OAuth flow would leave behind. */
  const seedOAuthToken = (userId: number, clientName: string): SeededOAuthToken => {
    const clientId = `client-${clientName.replace(/\s+/g, '-')}`;
    connection.prepare(
      'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, metadata, created_via) VALUES (?, ?, ?, ?, ?)',
    ).run(clientId, clientName, JSON.stringify(['http://127.0.0.1/callback']), JSON.stringify({}), 'dcr');
    const grantId = Number(connection.prepare(
      'INSERT INTO oauth_grants (user_id, client_id, scopes, resource, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(userId, clientId, JSON.stringify(['cloudcli:read']), 'https://mcp.example', clock.current.toISOString()).lastInsertRowid);
    const plaintext = `cca_${randomBytes(32).toString('hex')}`;
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');
    const tokenId = Number(connection.prepare(
      `INSERT INTO access_tokens
         (user_id, kind, token_hash, token_prefix, name, grant_id, scopes, resource, expires_at, created_at)
       VALUES (?, 'oauth_access', ?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      tokenHash,
      plaintext.slice(0, 8),
      grantId,
      JSON.stringify(['cloudcli:read']),
      'https://mcp.example',
      new Date(clock.current.getTime() + 3_600_000).toISOString(),
      clock.current.toISOString(),
    ).lastInsertRowid);
    return { clientId, clientName, grantId, tokenId, plaintext, tokenHash };
  };

  // Real service + real repositories; only credential/notification/push effects are stubs.
  const service = createSettingsService({
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    accessTokens: {
      list: (userId, kind) => accessTokensDb.listByUser(userId, kind),
      findById: (tokenId) => accessTokensDb.findById(tokenId),
      issue: (input) => tokens.issueToken(input),
      revoke: (tokenId) => tokens.revokeToken(tokenId),
    },
    // Mirrors settings.module.ts: every non-PAT row in its storage shape (hash
    // included), so the service's projection is what keeps the hash off the wire.
    oauthTokens: {
      list: (userId) =>
        accessTokensDb
          .listByUser(userId)
          .filter((row) => row.kind !== 'pat')
          .map((row) => ({
            id: row.id,
            kind: row.kind,
            token_hash: row.token_hash,
            token_prefix: row.token_prefix,
            scopes: row.scopes,
            expires_at: row.expires_at,
            created_at: row.created_at,
            last_used: row.last_used,
            revoked_at: row.revoked_at,
            client_name: resolveGrantClientName(row.grant_id),
          })),
    },
  });
  const router = createSettingsRouter(service);

  let currentUserId = USER_ONE;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/settings',
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { user?: { id: number } }).user = { id: currentUserId };
      next();
    },
    router,
  );
  // Mirrors the production AppError translation in server/index.ts.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/api/settings`,
      setUser: (userId) => { currentUserId = userId; },
      tokens,
      tokenHashOf: (tokenId) => {
        const row = connection
          .prepare('SELECT token_hash FROM access_tokens WHERE id = ?')
          .get(tokenId) as { token_hash: string } | undefined;
        assert.notEqual(row, undefined);
        return row!.token_hash;
      },
      countRows: () =>
        (connection.prepare('SELECT COUNT(*) AS count FROM access_tokens').get() as { count: number }).count,
      seedOAuthToken,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type CreatedToken = { id: number; plaintext: string; status: number; body: Record<string, unknown> };

/** POSTs a token and asserts the response carries exactly one plaintext. */
async function createToken(harness: Harness, payload: Record<string, unknown>): Promise<CreatedToken> {
  const response = await fetch(`${harness.baseUrl}/access-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as Record<string, unknown>;
  const plaintexts = collectMatchingStrings(body, PLAINTEXT_PATTERN);
  assert.equal(plaintexts.length, 1);
  const token = body.token as { id: number } | undefined;
  assert.notEqual(token, undefined);
  return { id: Number(token!.id), plaintext: plaintexts[0], status: response.status, body };
}

test('(a) creating tokens for 7/30/90 returns 201 and exactly one plaintext each', async () => {
  await withSettingsServer(async (harness) => {
    const created: (CreatedToken & { days: number })[] = [];
    for (const days of [7, 30, 90]) {
      const token = await createToken(harness, { name: `token-${days}`, expiresInDays: days });
      assert.equal(token.status, 201);
      assert.match(token.plaintext, PLAINTEXT_PATTERN);
      created.push({ ...token, days });
    }
    assert.equal(created.length, 3);
    for (const token of created) {
      console.log(`(a) expiresInDays=${token.days} status=${token.status} id=${token.id} plaintext=${token.plaintext}`);
    }
    console.log(`(a) ids = ${created.map((token) => token.id).join(', ')}; one plaintext per response`);
  });
});

test('(b) listing returns no plaintext and no stored hash, only the safe fields', async () => {
  await withSettingsServer(async (harness) => {
    const created: CreatedToken[] = [];
    for (const days of [7, 30, 90]) {
      created.push(await createToken(harness, { name: `list-${days}`, expiresInDays: days }));
    }

    const response = await fetch(`${harness.baseUrl}/access-tokens`);
    assert.equal(response.status, 200);
    const body = await response.json() as { tokens: Record<string, unknown>[] };
    const bodyText = JSON.stringify(body);

    let plaintextHits = 0;
    let hashHits = 0;
    for (const token of created) {
      if (bodyText.includes(token.plaintext)) plaintextHits += 1;
      if (bodyText.includes(harness.tokenHashOf(token.id))) hashHits += 1;
    }
    assert.equal(plaintextHits, 0);
    assert.equal(hashHits, 0);

    assert.equal(body.tokens.length, 3);
    for (const item of body.tokens) {
      assert.equal(typeof item.tokenPrefix, 'string');
      assert.equal(typeof item.name, 'string');
      assert.equal(Array.isArray(item.scopes), true);
      assert.equal(typeof item.expiresAt, 'string');
      assert.equal('lastUsed' in item, true);
      assert.equal('token_hash' in item, false);
      assert.equal('plaintext' in item, false);
      const owner = created.find((token) => token.plaintext.startsWith(String(item.tokenPrefix)));
      assert.notEqual(owner, undefined);
      assert.equal(String(item.tokenPrefix), owner!.plaintext.slice(0, 8));
    }
    console.log(`(b) response body keys = ${Object.keys(body.tokens[0]).sort().join(', ')}`);
    console.log(`(b) plaintext hits = ${plaintextHits}; token_hash hits = ${hashHits}`);
  });
});

test('(c) an expiry outside 7/30/90 is 400 and writes no row', async () => {
  await withSettingsServer(async (harness) => {
    const readings: string[] = [];
    for (const expiresInDays of [0, 1, 6, 10, 365, -1]) {
      const beforeCount = harness.countRows();
      const response = await fetch(`${harness.baseUrl}/access-tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `bad-${expiresInDays}`, expiresInDays }),
      });
      const afterCount = harness.countRows();
      const text = await response.text();
      assert.equal(response.status, 400);
      assert.equal(afterCount, beforeCount);
      readings.push(`expiresInDays=${expiresInDays} status=${response.status} rows ${beforeCount}->${afterCount} body=${text}`);
    }
    for (const reading of readings) console.log(`(c) ${reading}`);
  });
});

test('(d) revoking a token returns 200, invalidates it, and a second revoke is 404', async () => {
  await withSettingsServer(async (harness) => {
    const token = await createToken(harness, { name: 'revoke-me', expiresInDays: 30 });
    assert.equal(harness.tokens.verifyToken(token.plaintext).ok, true);

    const first = await fetch(`${harness.baseUrl}/access-tokens/${token.id}`, { method: 'DELETE' });
    assert.equal(first.status, 200);

    const verified = harness.tokens.verifyToken(token.plaintext);
    assert.deepEqual(verified, { ok: false, reason: 'revoked' });

    const second = await fetch(`${harness.baseUrl}/access-tokens/${token.id}`, { method: 'DELETE' });
    assert.equal(second.status, 404);

    console.log(`(d) DELETE id=${token.id} first=${first.status} second=${second.status} verify=${JSON.stringify(verified)}`);
  });
});

test('(e) another user cannot revoke or list a token it does not own', async () => {
  await withSettingsServer(async (harness) => {
    harness.setUser(USER_ONE);
    const ownerToken = await createToken(harness, { name: 'owner', expiresInDays: 30 });
    harness.setUser(USER_TWO);
    const intruderToken = await createToken(harness, { name: 'intruder', expiresInDays: 30 });

    const deleteResponse = await fetch(`${harness.baseUrl}/access-tokens/${ownerToken.id}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 404);
    assert.equal(harness.tokens.verifyToken(ownerToken.plaintext).ok, true);

    const intruderList = await (await fetch(`${harness.baseUrl}/access-tokens`)).json() as { tokens: { id: number }[] };
    const intruderIds = intruderList.tokens.map((item) => item.id);
    assert.deepEqual(intruderIds, [intruderToken.id]);
    assert.equal(intruderIds.includes(ownerToken.id), false);

    harness.setUser(USER_ONE);
    const ownerList = await (await fetch(`${harness.baseUrl}/access-tokens`)).json() as { tokens: { id: number }[] };
    const ownerIds = ownerList.tokens.map((item) => item.id);
    assert.deepEqual(ownerIds, [ownerToken.id]);

    console.log(`(e) user ${USER_TWO} cross-delete=${deleteResponse.status}; user ${USER_TWO} ids=[${intruderIds}]`);
    console.log(`(e) user ${USER_ONE} ids=[${ownerIds}]`);
  });
});

test('(f) the retired /api-keys endpoints are not handled by the settings router', async () => {
  await withSettingsServer(async (harness) => {
    const getResponse = await fetch(`${harness.baseUrl}/api-keys`);
    const getText = await getResponse.text();
    const postResponse = await fetch(`${harness.baseUrl}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'legacy' }),
    });
    const postText = await postResponse.text();

    assert.equal(getResponse.status, 404);
    assert.equal(postResponse.status, 404);
    assert.equal(getText.includes('apiKeys'), false);
    assert.equal(postText.includes('apiKeys'), false);

    console.log(`(f) GET status=${getResponse.status} body=${getText.slice(0, 80)}`);
    console.log(`(f) POST status=${postResponse.status} body=${postText.slice(0, 80)}`);
  });
});

test('(f-control) an unknown settings path is also 404, so the api-keys reading is not vacuous', async () => {
  await withSettingsServer(async (harness) => {
    const response = await fetch(`${harness.baseUrl}/definitely-not-a-route`);
    assert.equal(response.status, 404);
  });
});

test('(g) the PAT list excludes OAuth rows, which the per-user OAuth list surfaces', async () => {
  await withSettingsServer(async (harness) => {
    const pat = await createToken(harness, { name: 'my-pat', expiresInDays: 30 });
    const oauth = harness.seedOAuthToken(USER_ONE, 'Preset App');

    // The PAT list is exactly the PAT, never the OAuth row — and every row it
    // returns carries a real name, so the settings list cannot show a blank.
    const patList = await (await fetch(`${harness.baseUrl}/access-tokens`)).json() as {
      tokens: { id: number; name: string | null }[];
    };
    assert.deepEqual(patList.tokens.map((token) => token.id), [pat.id]);
    assert.equal(patList.tokens.some((token) => token.id === oauth.tokenId), false);
    assert.equal(patList.tokens.every((token) => typeof token.name === 'string' && token.name.length > 0), true);

    // The OAuth surface carries the row the PAT list omits, and reaches it via
    // the grant's client name rather than the NULL `name` the OAuth store wrote.
    const oauthList = await (await fetch(`${harness.baseUrl}/oauth-tokens`)).json() as {
      tokens: { id: number; clientName: string | null; kind: string }[];
    };
    assert.deepEqual(oauthList.tokens.map((token) => token.id), [oauth.tokenId]);
    assert.equal(oauthList.tokens[0].clientName, 'Preset App');
    assert.equal(oauthList.tokens[0].kind, 'oauth_access');

    // Ownership: the row is scoped to its user, so another user's list is empty.
    harness.setUser(USER_TWO);
    const otherList = await (await fetch(`${harness.baseUrl}/oauth-tokens`)).json() as { tokens: unknown[] };
    assert.equal(otherList.tokens.length, 0);

    console.log(`(g) user ${USER_ONE} PAT ids=[${patList.tokens.map((t) => t.id)}] oauth ids=[${oauth.tokenId}]`);
    console.log(`(g) user ${USER_ONE} oauth clientName=${JSON.stringify(oauthList.tokens[0].clientName)} kind=${oauthList.tokens[0].kind}`);
    console.log(`(g) user ${USER_TWO} oauth ids=[]`);
  });
});

test('(h) the OAuth-token list is read-only and never leaks the token hash', async () => {
  await withSettingsServer(async (harness) => {
    await createToken(harness, { name: 'unrelated-pat', expiresInDays: 30 });
    const oauth = harness.seedOAuthToken(USER_ONE, 'Read-Only App');

    const response = await fetch(`${harness.baseUrl}/oauth-tokens`);
    assert.equal(response.status, 200);
    const body = await response.json() as { tokens: Record<string, unknown>[] };
    const bodyText = JSON.stringify(body);

    assert.equal(body.tokens.length, 1);
    const item = body.tokens[0];
    assert.deepEqual(
      Object.keys(item).sort(),
      ['clientName', 'createdAt', 'expiresAt', 'id', 'kind', 'lastUsed', 'revokedAt', 'scopes', 'tokenPrefix'],
    );
    assert.equal('token_hash' in item, false);
    assert.equal('plaintext' in item, false);
    assert.equal(bodyText.includes(oauth.tokenHash), false);
    assert.equal(bodyText.includes(oauth.plaintext), false);
    assert.equal(item.id, oauth.tokenId);
    assert.equal(item.tokenPrefix, oauth.plaintext.slice(0, 8));
    assert.deepEqual(item.scopes, ['cloudcli:read']);

    // Read-only: OAuth tokens are issued by the flows, so there is no create or
    // revoke verb here — both answer 404 and the row is untouched.
    const postResponse = await fetch(`${harness.baseUrl}/oauth-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    const deleteResponse = await fetch(`${harness.baseUrl}/oauth-tokens/${oauth.tokenId}`, { method: 'DELETE' });
    assert.equal(postResponse.status, 404);
    assert.equal(deleteResponse.status, 404);
    assert.equal(harness.countRows(), 2);

    console.log(`(h) response keys = ${Object.keys(item).sort().join(', ')}`);
    console.log(`(h) hash hits = ${bodyText.includes(oauth.tokenHash) ? 1 : 0}; POST=${postResponse.status} DELETE=${deleteResponse.status}`);
  });
});
