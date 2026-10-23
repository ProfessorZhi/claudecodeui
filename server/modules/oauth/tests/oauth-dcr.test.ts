/**
 * AC-264 criterion: the client-registration policy and the two ways a client is
 * created. Reads, over real HTTP against real express 4 apps backed by a real
 * better-sqlite3 database built by the production migration path:
 *
 *   (a) `MCP_DCR=off` mounts no registration endpoint (the path 404s) and the
 *       advertised metadata omits `registration_endpoint`; allowlist/open DO
 *       advertise it and an open registration answers 201;
 *   (b) allowlist checks EVERY declared redirect host — an out-of-list host is
 *       `400 invalid_redirect_uri` whether it is the first or the last, and no
 *       row is created;
 *   (c) open admits https and localhost/127.0.0.1 http only; any other http is
 *       `400 invalid_redirect_uri`;
 *   (d) a registration's plaintext `client_secret` appears in the response ONCE
 *       and is absent from the database bytes; the stored column is its SHA-256;
 *   (e) manual creation requires a logged-in user (no token → 401, no row) and
 *       likewise returns its secret once and stores only the hash;
 *   (f) the OAuth switch still has exactly one production reader.
 *
 * Requests go over `node:http`, never `fetch`: the criterion runs WITHOUT the
 * suite's undici preload, and undici refuses a fixed set of ports that
 * `listen(0)` can land on (the same reason as AC-240/AC-262).
 */

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CustomOAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import express from 'express';

import type { OAuthStore } from '@/modules/oauth/index.js';

const TEST_JWT_SECRET = 'oauth-dcr-routes-test-secret';

// `auth.middleware.ts` resolves `JWT_SECRET` at module-load time and
// `shared/utils.ts` freezes `IS_PLATFORM` (which would replace token checks with
// "the first database user"). Static imports are hoisted above this code, so the
// environment is set first and every aliased module comes in dynamically.
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, oauthClientsDb } = await import(
  '@/modules/database/index.js'
);
const {
  createOAuthClientsRouter,
  createOAuthClientsService,
  createOAuthRegisteredClientsStore,
  createOAuthStore,
  mountOAuthRegister,
  readMcpAllowedRedirectHosts,
  validateRedirectUris,
} = await import('@/modules/oauth/index.js');
const { buildAuthorizationServerMetadata } = await import('@/modules/mcp-gateway/index.js');
const { authenticateToken } = await import('@/modules/auth/index.js');

const USER_ID = 1;
const METADATA_BASE = 'https://mcp.example.test';

/** lowercase-hex SHA-256, matching `oauth-store.service.ts`'s hash exactly. */
function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type Reading = {
  status: number;
  contentType: string | null;
  body: string;
  json: Record<string, unknown> | null;
};

/** One HTTP request over `node:http`, body parsed as JSON when possible. */
function request(
  baseUrl: string,
  method: string,
  requestPath: string,
  options: { body?: unknown; authorization?: string } = {},
): Promise<Reading> {
  const url = new URL(requestPath, baseUrl);
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
  const headers: Record<string, string | number> = {};
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = payload.length;
  }
  if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  }

  return new Promise<Reading>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(body) as unknown;
            if (typeof parsed === 'object' && parsed !== null) {
              json = parsed as Record<string, unknown>;
            }
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            body,
            json,
          });
        });
      },
    );

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/** Reads the database file plus its WAL/SHM siblings, as raw bytes, when present. */
function readDatabaseFiles(dbPath: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      files.set(file, readFileSync(file));
    }
  }
  return files;
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: Buffer, needle: Buffer): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

/** Scans the closed database bytes for `value`; returns the total hit count. */
function plaintextHits(dbPath: string, value: string): number {
  const needle = Buffer.from(value, 'utf8');
  return [...readDatabaseFiles(dbPath).values()].reduce(
    (total, bytes) => total + countOccurrences(bytes, needle),
    0,
  );
}

type DcrContext = {
  baseUrl: string;
  store: OAuthStore;
  dbPath: string;
  mount: { mounted: boolean; reason: string };
};

/** Runs `run` against a fresh temp database and a real express app mounting `/oauth/register`. */
async function withDcrServer(
  options: { dcrMode: 'off' | 'allowlist' | 'open'; allowedHosts: string[] },
  run: (context: DcrContext) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'oauth-dcr-'));
  const databasePath = path.join(tempDirectory, 'oauth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const store = createOAuthStore();
  const app = express();
  app.use(express.json());
  const mount = mountOAuthRegister(app, {
    store,
    dcrMode: options.dcrMode,
    allowedHosts: options.allowedHosts,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
      dbPath: databasePath,
      mount,
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

/** A bare temp database and a store over it, for the pure-factory readings. */
async function withOAuthDatabase(
  run: (context: { store: OAuthStore; dbPath: string }) => Promise<void> | void,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'oauth-dcr-db-'));
  const databasePath = path.join(tempDirectory, 'oauth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await run({ store: createOAuthStore(), dbPath: databasePath });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Mints the HS256 JWT `authenticateToken` verifies, with the secret it loaded. */
function signToken(payload: { userId: number; username: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + 3600 });
  const signature = createHmac('sha256', TEST_JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

type ManualContext = { baseUrl: string; store: OAuthStore; token: string; dbPath: string };

/** A real express app mounting the manual-client router behind the production auth middleware. */
async function withManualServer(run: (context: ManualContext) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'oauth-dcr-manual-'));
  const databasePath = path.join(tempDirectory, 'oauth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'owner', 'hash');

  const store = createOAuthStore();
  const token = signToken({ userId: USER_ID, username: 'owner' });

  const app = express();
  app.use(express.json());
  app.use('/api/oauth/clients', authenticateToken, createOAuthClientsRouter({ store }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, store, token, dbPath: databasePath });
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

/** The RFC 7591 registration body every DCR leg posts (confidential client). */
const registrationBody = (redirectUris: string[]): Record<string, unknown> => ({
  client_name: 'dcr-client',
  redirect_uris: redirectUris,
  token_endpoint_auth_method: 'client_secret_post',
});

const rowCount = (): number => oauthClientsDb.allRows().length;

// --------------------------- criteria ---------------------------

test('(a) DCR off mounts nothing and advertises no registration endpoint; allowlist/open do', async () => {
  const registerPath = '/oauth/register';

  // off: the mount attaches nothing, so the path is genuinely ABSENT (404).
  await withDcrServer({ dcrMode: 'off', allowedHosts: [] }, async (context) => {
    assert.equal(context.mount.mounted, false, `off must not mount: ${JSON.stringify(context.mount)}`);
    const response = await request(context.baseUrl, 'POST', registerPath, {
      body: registrationBody(['https://app.example/cb']),
    });
    console.log(
      `[off] mounted=${context.mount.mounted} reason=${JSON.stringify(context.mount.reason)}; POST ${registerPath} -> ${response.status} ${JSON.stringify(response.body)}`,
    );
    assert.equal(response.status, 404, `off must leave /oauth/register absent (404), got ${response.status}`);
  });

  // Metadata: registration_endpoint is present iff the mode is not off.
  const offMetadata = buildAuthorizationServerMetadata({ baseUrl: METADATA_BASE, dcrMode: 'off' });
  const allowlistMetadata = buildAuthorizationServerMetadata({ baseUrl: METADATA_BASE, dcrMode: 'allowlist' });
  const openMetadata = buildAuthorizationServerMetadata({ baseUrl: METADATA_BASE, dcrMode: 'open' });
  console.log(
    `[metadata/off]       registration_endpoint present=${'registration_endpoint' in offMetadata} value=${JSON.stringify(offMetadata.registration_endpoint)}`,
  );
  console.log(
    `[metadata/allowlist] registration_endpoint present=${'registration_endpoint' in allowlistMetadata} value=${JSON.stringify(allowlistMetadata.registration_endpoint)}`,
  );
  console.log(
    `[metadata/open]      registration_endpoint present=${'registration_endpoint' in openMetadata} value=${JSON.stringify(openMetadata.registration_endpoint)}`,
  );
  assert.equal('registration_endpoint' in offMetadata, false, 'off metadata must omit registration_endpoint');
  assert.equal(
    allowlistMetadata.registration_endpoint,
    `${METADATA_BASE}/oauth/register`,
    `allowlist metadata must advertise ${METADATA_BASE}/oauth/register`,
  );
  assert.equal(
    openMetadata.registration_endpoint,
    `${METADATA_BASE}/oauth/register`,
    `open metadata must advertise ${METADATA_BASE}/oauth/register`,
  );

  // Positive control: the SAME mount code on `open` attaches and registers a client.
  await withDcrServer({ dcrMode: 'open', allowedHosts: [] }, async (context) => {
    assert.equal(context.mount.mounted, true, `open must mount: ${JSON.stringify(context.mount)}`);
    const response = await request(context.baseUrl, 'POST', registerPath, {
      body: registrationBody(['https://app.example/cb']),
    });
    console.log(
      `[open] mounted=${context.mount.mounted} reason=${JSON.stringify(context.mount.reason)}; POST ${registerPath} -> ${response.status} client_id=${JSON.stringify(response.json?.client_id)}`,
    );
    assert.equal(response.status, 201, `open must register (201), got ${response.status}: ${response.body}`);
    assert.equal(typeof response.json?.client_id, 'string', 'the response must carry a client_id');
  });
});

test('(b) allowlist checks every redirect host, not just the first', async () => {
  await withDcrServer({ dcrMode: 'allowlist', allowedHosts: ['app.example'] }, async (context) => {
    const registerPath = '/oauth/register';
    const before = rowCount();

    // Second host out of list.
    const secondOut = await request(context.baseUrl, 'POST', registerPath, {
      body: registrationBody(['https://app.example/cb', 'https://evil.example/cb']),
    });
    // First host out of list.
    const firstOut = await request(context.baseUrl, 'POST', registerPath, {
      body: registrationBody(['https://evil.example/cb', 'https://app.example/cb']),
    });
    const afterRejects = rowCount();
    // Every host in list.
    const allowed = await request(context.baseUrl, 'POST', registerPath, {
      body: registrationBody(['https://app.example/cb']),
    });
    const afterAllowed = rowCount();

    console.log(
      [
        `[b/second-out] status=${secondOut.status} error=${JSON.stringify(secondOut.json?.error)} description=${JSON.stringify(secondOut.json?.error_description)}`,
        `[b/first-out]  status=${firstOut.status} error=${JSON.stringify(firstOut.json?.error)} description=${JSON.stringify(firstOut.json?.error_description)}`,
        `[b/allowed]    status=${allowed.status} rows before=${before} afterRejects=${afterRejects} afterAllowed=${afterAllowed}`,
      ].join('\n'),
    );

    assert.equal(secondOut.status, 400, `a later out-of-list host must 400, got ${secondOut.status}`);
    assert.equal(secondOut.json?.error, 'invalid_redirect_uri', 'the error code must be invalid_redirect_uri');
    assert.equal(firstOut.status, 400, `an earlier out-of-list host must 400, got ${firstOut.status}`);
    assert.equal(firstOut.json?.error, 'invalid_redirect_uri', 'the error code must be invalid_redirect_uri');
    assert.equal(afterRejects, before, 'a rejected registration must create no row');
    assert.equal(allowed.status, 201, `an all-allowed registration must 201, got ${allowed.status}`);
    assert.equal(afterAllowed, before + 1, 'a successful registration must create exactly one row');
  });
});

test('(c) open admits https or localhost/127.0.0.1 http only', async () => {
  await withDcrServer({ dcrMode: 'open', allowedHosts: [] }, async (context) => {
    const cases: Array<{ label: string; uri: string; expected: number }> = [
      { label: 'https', uri: 'https://app.example/cb', expected: 201 },
      { label: 'http://localhost', uri: 'http://localhost:5173/cb', expected: 201 },
      { label: 'http://127.0.0.1', uri: 'http://127.0.0.1:5173/cb', expected: 201 },
      { label: 'http non-local', uri: 'http://evil.example/cb', expected: 400 },
    ];

    for (const probe of cases) {
      const response = await request(context.baseUrl, 'POST', '/oauth/register', {
        body: registrationBody([probe.uri]),
      });
      console.log(
        `[c/${probe.label}] redirect_uris=[${JSON.stringify(probe.uri)}] -> ${response.status} error=${JSON.stringify(response.json?.error)}`,
      );
      assert.equal(response.status, probe.expected, `${probe.label} (${probe.uri}) must answer ${probe.expected}, got ${response.status}`);
      if (probe.expected === 400) {
        assert.equal(response.json?.error, 'invalid_redirect_uri', 'the error code must be invalid_redirect_uri');
      }
    }
  });
});

test('(d) a registration secret appears once, only its SHA-256 reaches the database', async () => {
  await withDcrServer({ dcrMode: 'open', allowedHosts: [] }, async (context) => {
    const first = await request(context.baseUrl, 'POST', '/oauth/register', {
      body: registrationBody(['https://app.example/cb']),
    });
    assert.equal(first.status, 201, `the first registration must 201, got ${first.status}: ${first.body}`);
    const firstClientId = first.json?.client_id as string;
    const firstSecret = first.json?.client_secret as string;
    assert.equal(typeof firstClientId, 'string', 'the response must carry a client_id');
    assert.equal(typeof firstSecret, 'string', 'a confidential client must receive a client_secret');

    const row = oauthClientsDb.findById(firstClientId);
    assert.ok(row, 'the registered client row must be readable');
    const expectedHash = hashSecret(firstSecret);
    console.log(
      `[d] client_id=${firstClientId} response_secret_len=${firstSecret.length} stored_hash=${row.client_secret_hash} sha256(secret)=${expectedHash}`,
    );
    assert.equal(row.client_secret_hash, expectedHash, 'the stored column must be the secret’s SHA-256');
    assert.notEqual(row.client_secret_hash, firstSecret, 'the stored column must not be the plaintext');

    // A second registration mints a DIFFERENT secret.
    const second = await request(context.baseUrl, 'POST', '/oauth/register', {
      body: registrationBody(['https://app.example/cb']),
    });
    assert.equal(second.status, 201, `the second registration must 201, got ${second.status}: ${second.body}`);
    const secondSecret = second.json?.client_secret as string;
    console.log(`[d] first_secret === second_secret ? ${firstSecret === secondSecret}`);
    assert.notEqual(firstSecret, secondSecret, 'two registrations must not share a secret');

    // Raw-byte scan of the closed database (and WAL/SHM siblings).
    closeConnection();
    const files = readDatabaseFiles(context.dbPath);
    const secrets = { first: firstSecret, second: secondSecret };
    const hits: Record<string, number> = {};
    for (const [label, value] of Object.entries(secrets)) {
      hits[label] = plaintextHits(context.dbPath, value);
    }
    const hashHits = plaintextHits(context.dbPath, expectedHash);
    console.log(
      `[d] scanned files=${[...files.keys()].join(', ')} plaintext_hits=${JSON.stringify(hits)} hash_hits=${hashHits}`,
    );
    assert.ok(files.size >= 1, 'the scan must have looked at a real database file');
    assert.equal(hits.first, 0, 'the first plaintext secret must not appear in the database bytes');
    assert.equal(hits.second, 0, 'the second plaintext secret must not appear in the database bytes');
    // Positive control: the hash IS present, so "no plaintext hits" is not a scan that missed everything.
    assert.ok(hashHits >= 1, 'the stored SHA-256 must appear in the database bytes');
  });
});

test('(e) manual creation requires a logged-in user and returns its secret once', async () => {
  await withManualServer(async (context) => {
    const body = { client_name: 'manual-client', redirect_uris: ['https://app.example/cb'] };

    const unauthenticated = await request(context.baseUrl, 'POST', '/api/oauth/clients', { body });
    const rowsAfter401 = rowCount();
    console.log(
      `[e] no token -> ${unauthenticated.status}; rows=${rowsAfter401} body=${JSON.stringify(unauthenticated.body)}`,
    );
    assert.equal(unauthenticated.status, 401, `a request without a token must 401, got ${unauthenticated.status}`);
    assert.equal(rowsAfter401, 0, 'an unauthenticated request must create no row');

    const created = await request(context.baseUrl, 'POST', '/api/oauth/clients', {
      body,
      authorization: `Bearer ${context.token}`,
    });
    const clientId = created.json?.client_id as string;
    const clientSecret = created.json?.client_secret as string;
    console.log(
      `[e] token -> ${created.status} client_id=${JSON.stringify(clientId)} secret_len=${typeof clientSecret === 'string' ? clientSecret.length : 'n/a'}`,
    );
    assert.equal(created.status, 201, `an authenticated request must 201, got ${created.status}: ${created.body}`);
    assert.equal(typeof clientId, 'string', 'the response must carry a client_id');
    assert.equal(typeof clientSecret, 'string', 'a manual client must receive a client_secret');

    const row = oauthClientsDb.findById(clientId);
    assert.ok(row, 'the manual client row must be readable');
    assert.equal(row.client_secret_hash, hashSecret(clientSecret), 'the stored column must be the secret’s SHA-256');
    assert.notEqual(row.client_secret_hash, clientSecret, 'the stored column must not be the plaintext');
    assert.equal(row.created_via, 'manual', 'a manual client must be recorded as manual');

    // Scheme safety applies on the manual path too: a non-local http callback is refused.
    const unsafe = await request(context.baseUrl, 'POST', '/api/oauth/clients', {
      body: { client_name: 'unsafe', redirect_uris: ['http://evil.example/cb'] },
      authorization: `Bearer ${context.token}`,
    });
    console.log(`[e] unsafe http -> ${unsafe.status} error=${JSON.stringify(unsafe.json?.error)}`);
    assert.equal(unsafe.status, 400, `a non-local http callback must 400, got ${unsafe.status}`);
    assert.equal(unsafe.json?.error, 'invalid_redirect_uri', 'the error code must be invalid_redirect_uri');

    closeConnection();
    const hashHits = plaintextHits(context.dbPath, hashSecret(clientSecret));
    const secretHits = plaintextHits(context.dbPath, clientSecret);
    console.log(`[e] database bytes: plaintext_hits=${secretHits} hash_hits=${hashHits}`);
    assert.equal(secretHits, 0, 'the manual secret plaintext must not appear in the database bytes');
    assert.ok(hashHits >= 1, 'the manual secret’s SHA-256 must appear in the database bytes');
  });
});

test('(f) the policy functions and both factory seams enforce the same rules directly', async () => {
  // The allowlist reader: trim, lowercase, drop empties, dedupe; unset answers [].
  const parsedHosts = readMcpAllowedRedirectHosts({
    MCP_ALLOWED_REDIRECT_HOSTS: ' App.Example , evil.example ,, app.example ',
  });
  const unsetHosts = readMcpAllowedRedirectHosts({});
  console.log(`[f/hosts] parsed=${JSON.stringify(parsedHosts)} unset=${JSON.stringify(unsetHosts)}`);
  assert.deepEqual(parsedHosts, ['app.example', 'evil.example'], 'hosts must be trimmed, lowercased and deduped');
  assert.deepEqual(unsetHosts, [], 'an unset allowlist must be empty');

  // validateRedirectUris: every branch returns the RFC 7591 code, and the reason names the URI.
  const allowlistReject = validateRedirectUris({
    dcrMode: 'allowlist',
    allowedHosts: ['app.example'],
    redirectUris: ['https://app.example/cb', 'https://evil.example/cb'],
  });
  const offReject = validateRedirectUris({
    dcrMode: 'off',
    allowedHosts: [],
    redirectUris: ['https://app.example/cb'],
  });
  const schemeReject = validateRedirectUris({
    dcrMode: 'open',
    allowedHosts: [],
    redirectUris: ['http://evil.example/cb'],
  });
  const accepted = validateRedirectUris({
    dcrMode: 'open',
    allowedHosts: [],
    redirectUris: ['https://app.example/cb'],
  });
  console.log(
    [
      `[f/allowlist] ${JSON.stringify(allowlistReject)}`,
      `[f/off]       ${JSON.stringify(offReject)}`,
      `[f/scheme]    ${JSON.stringify(schemeReject)}`,
      `[f/accept]    ${JSON.stringify(accepted)}`,
    ].join('\n'),
  );
  for (const rejection of [allowlistReject, offReject, schemeReject]) {
    assert.equal(rejection.ok, false, 'the three rejection branches must not accept');
    if (!rejection.ok) {
      assert.equal(rejection.error, 'invalid_redirect_uri', 'every rejection must carry invalid_redirect_uri');
      assert.ok(
        rejection.reason.includes('evil.example') || rejection.reason.includes('off'),
        `the reason must name the offending URI or the off mode: ${rejection.reason}`,
      );
    }
  }
  assert.equal(accepted.ok, true, 'a compliant set must be accepted');

  // The store adapter throws the SDK error the register handler maps to 400.
  await withOAuthDatabase(({ store }) => {
    const storeAdapter = createOAuthRegisteredClientsStore({
      store,
      dcrMode: 'allowlist',
      allowedHosts: ['app.example'],
    });
    assert.throws(
      () => storeAdapter.registerClient!({ redirect_uris: ['https://evil.example/cb'] }),
      (error: unknown) => error instanceof CustomOAuthError && error.errorCode === 'invalid_redirect_uri',
      'the store adapter must throw CustomOAuthError(invalid_redirect_uri) for an out-of-list host',
    );

    // The manual service returns a discriminated result instead of throwing.
    const service = createOAuthClientsService({ store });
    const manualReject = service.createManualClient({
      clientName: 'direct',
      redirectUris: ['http://evil.example/cb'],
    });
    const manualAccept = service.createManualClient({
      clientName: 'direct',
      redirectUris: ['https://app.example/cb'],
    });
    console.log(
      `[f/service] reject=${JSON.stringify(manualReject)} accept_ok=${manualAccept.ok ? 'true' : 'false'}`,
    );
    assert.equal(manualReject.ok, false, 'an unsafe manual redirect must be refused');
    if (!manualReject.ok) {
      assert.equal(manualReject.error, 'invalid_redirect_uri', 'the manual refusal must carry invalid_redirect_uri');
    }
    assert.equal(manualAccept.ok, true, 'a safe manual redirect must be accepted');
  });
});

test('(g) the OAuth switch still has exactly one production reader', () => {
  const SERVER_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'), 'server');
  const literal = 'MCP_OAUTH_ENABLED';

  const walk = (root: string): string[] => {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          out.push(full);
        }
      }
    }
    return out;
  };

  const count = (excludeTests: boolean): number =>
    walk(SERVER_DIR)
      .filter((file) => !excludeTests || !file.includes(`${path.sep}tests${path.sep}`))
      .reduce((total, file) => total + (readFileSync(file, 'utf8').split(literal).length - 1), 0);

  const production = count(true);
  const includingTests = count(false);
  console.log(`[g] MCP_OAUTH_ENABLED production=${production} including-tests=${includingTests}`);
  assert.equal(production, 1, 'exactly one production file may read the OAuth switch');
  assert.ok(includingTests >= 2, 'including tests the count must rise (criteria use the literal)');
});
