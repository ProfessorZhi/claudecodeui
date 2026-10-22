/**
 * OAuth settings routes criterion (AC-265; GOAL-021 exit condition 6, SPEC
 * `docs/proposals/mcp-gateway-SPEC.md` v3.1 §152, §421, §483–§485).
 *
 * Drives the production route factory (`createOAuthSettingsRouter`) over real
 * HTTP on a real express 4 application, backed by a real better-sqlite3 database
 * in a temp directory and the real OAuth store/provider (AC-258/259) minting real
 * access tokens. Requests go through `node:http` — never `fetch`: undici refuses a
 * fixed list of ports and `listen(0)` lands on one often enough to red a suite run
 * at random (AC-240/241/242/244/248/263's criteria).
 *
 * Readings, one leg each:
 *   (a) the caller's grant list carries client name, redirect host, scopes and the
 *       two timestamps, and its ENTIRE raw response contains no client secret
 *       (plaintext or SHA-256) and no token plaintext; a positive control (the
 *       client name) proves the scanner is not vacuously true;
 *   (b) revoking a grant makes its access token answer 401 on the VERY NEXT `/mcp`
 *       call (200 before), and the row's `revoked_at` is stamped;
 *   (c) disabling a client does the same to its token (200 → 401) while another,
 *       non-disabled client's token still answers 200;
 *   (d) revoking ANOTHER user's grant answers 404 — never 403/200 — and leaves the
 *       row unrevoked; the same grant revoked by its owner answers 200;
 *   (e) the client list distinguishes DCR (`createdVia === 'dcr'`) from manual
 *       (`'manual'`), carries both names/hosts, and leaks no secret or token.
 *
 * The `/mcp` surface is assembled from AC-263's `createMcpAuthMiddleware` over
 * AC-259's provider — the same production pair `server/index.ts` wires — so (b)/(c)
 * prove revocation reaches the real authentication path, not a stand-in.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  oauthClientsDb,
  oauthGrantsDb,
} from '@/modules/database/index.js';
import type { OAuthGrantRow } from '@/modules/database/index.js';
import {
  createAccessTokensService,
  createOAuthProvider,
  createOAuthSettingsRouter,
  createOAuthSettingsService,
  createOAuthStore,
} from '@/modules/oauth/index.js';
import type {
  OAuthClientSummary,
  OAuthGrantSummary,
  OAuthSettingsService,
} from '@/modules/oauth/index.js';
import { createMcpAuthMiddleware, MCP_GATEWAY_PATH } from '@/modules/mcp-gateway/index.js';
import type { McpOauthSeam } from '@/modules/mcp-gateway/index.js';

const USER_A = 1;
const USER_B = 2;
/** The audience every token here is bound to: this gateway's `/mcp` resource. */
const PUBLIC_BASE_URL = 'https://mcp.example.test';
const AUDIENCE = `${PUBLIC_BASE_URL}/mcp`;
/** A fixed clock: expiries are deterministic, and no leg waits on wall time. */
const START = new Date('2026-01-01T00:00:00.000Z');
/** Far past every leg's fixed "now", so no issued token is ever expired. */
const FAR_FUTURE = '2027-01-01T00:00:00.000Z';

const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** A single real-HTTP response, with its body both raw and parsed. */
type Exchange = {
  status: number;
  body: string;
  json: unknown;
};

/** Issues a real JSON request over `node:http` (never `fetch`). */
function jsonRequest(
  origin: string,
  method: string,
  pathname: string,
  options: { token?: string; user?: number } = {}
): Promise<Exchange> {
  const url = new URL(pathname, origin);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.user !== undefined) {
    headers['x-test-user'] = String(options.user);
  }

  return new Promise<Exchange>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** The seeded entities every leg starts from, plus the harness seams. */
type Seeded = {
  dcrClient: { clientId: string; clientSecret: string };
  manualClient: { clientId: string; clientSecret: string };
  grantDcr: number;
  grantManual: number;
  tokenDcr: string;
  tokenManual: string;
};

type Harness = Seeded & {
  readonly origin: string;
  readonly store: ReturnType<typeof createOAuthStore>;
  readonly service: OAuthSettingsService;
  /** POSTs `/mcp` with (or without) a bearer token. */
  mcp(token: string | null): Promise<Exchange>;
  /** A settings request carrying the `x-test-user` principal. */
  settings(method: string, pathname: string, user?: number): Promise<Exchange>;
  /** Reads the raw grant row back, to witness `revoked_at`. */
  grantRow(grantId: number): OAuthGrantRow | undefined;
  /** Registers a client and returns its id and (once-only) plaintext secret. */
  register(clientName: string, redirectUri: string, createdVia: string): { clientId: string; clientSecret: string };
  /** Creates a grant for `userId` under `clientId`; returns its id. */
  grant(userId: number, clientId: string): number;
  /** Issues a live access token bound to this gateway under `grantId`. */
  issue(grantId: number, scopes: string[]): string;
};

/**
 * Runs `run` against a fresh temp database, the real settings router (behind an
 * injected principal) and a real `/mcp` mount (behind AC-263's auth middleware
 * over AC-259's provider), all served by one express app over `node:http`. The
 * `x-test-user` header is the injected authentication so one running app can act
 * as user A or user B — the switch leg (d) needs both in the same process.
 */
async function withSettingsServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'oauth-settings-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'settings.db');
  await initializeDatabase();

  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_A, 'settings-owner-a', 'hash');
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_B, 'settings-owner-b', 'hash');

  const now = (): Date => new Date(START.getTime());
  const store = createOAuthStore({ now });
  const provider = createOAuthProvider({ store, now, publicBaseUrl: PUBLIC_BASE_URL });
  const tokens = createAccessTokensService({ now });
  const service = createOAuthSettingsService({ store, grantsDb: oauthGrantsDb, clientsDb: oauthClientsDb });

  const env: NodeJS.ProcessEnv = { MCP_OAUTH_ENABLED: 'true' };
  const oauth: McpOauthSeam = {
    publicBaseUrl: PUBLIC_BASE_URL,
    verifyAccessToken: (token, options) => provider.verifyAccessToken(token, options),
  };

  const app = express();
  // The injected principal: `authenticateToken`'s shape, driven by a header so one
  // app can serve (d)'s two different users without a second server.
  app.use(
    '/api/settings',
    (req, _res, next) => {
      const raw = req.header('x-test-user');
      (req as express.Request & { user?: { id: number | string } }).user = {
        id: raw === undefined ? NaN : Number(raw),
      };
      next();
    },
    createOAuthSettingsRouter(service)
  );
  app.post(MCP_GATEWAY_PATH, createMcpAuthMiddleware({ tokens, oauth, env }), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const register = (clientName: string, redirectUri: string, createdVia: string) => {
    const registered = store.registerClient({
      clientName,
      redirectUris: [redirectUri],
      metadata: { client_name: clientName },
      createdVia,
    });
    return { clientId: registered.clientId, clientSecret: registered.clientSecret as string };
  };
  const grant = (userId: number, clientId: string): number =>
    store.createGrant({ userId, clientId, scopes: ['cloudcli:read'], resource: AUDIENCE }).grantId;
  const issue = (grantId: number, scopes: string[]): string =>
    store.issueOAuthToken({
      grantId,
      kind: 'oauth_access',
      scopes,
      resource: AUDIENCE,
      expiresAt: FAR_FUTURE,
    }).token;

  const dcrClient = register('DCR App', 'https://dcr.example.test/callback', 'dcr');
  const manualClient = register('Manual App', 'https://manual.example.test/cb', 'manual');
  const grantDcr = grant(USER_A, dcrClient.clientId);
  const grantManual = grant(USER_A, manualClient.clientId);
  const tokenDcr = issue(grantDcr, ['cloudcli:read']);
  const tokenManual = issue(grantManual, ['cloudcli:read']);

  try {
    await run({
      origin,
      store,
      service,
      dcrClient,
      manualClient,
      grantDcr,
      grantManual,
      tokenDcr,
      tokenManual,
      mcp: (token) => jsonRequest(origin, 'POST', MCP_GATEWAY_PATH, token === null ? {} : { token }),
      settings: (method, pathname, user) =>
        jsonRequest(origin, method, `/api/settings${pathname}`, user === undefined ? {} : { user }),
      grantRow: (grantId) => oauthGrantsDb.findById(grantId),
      register,
      grant,
      issue,
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

test('(a) the grant list carries name/host/scopes/timestamps and leaks no secret or token', async () => {
  await withSettingsServer(async (harness) => {
    const response = await harness.settings('GET', '/oauth-grants', USER_A);
    assert.equal(response.status, 200);

    const body = response.json as { grants: OAuthGrantSummary[] };
    assert.ok(Array.isArray(body.grants));
    assert.equal(body.grants.length, 2);

    const first = body.grants[0];
    assert.equal(first.clientName, 'DCR App');
    assert.equal(first.redirectHost, 'dcr.example.test');
    assert.deepEqual(first.scopes, ['cloudcli:read']);
    assert.equal(typeof first.createdAt, 'string');
    assert.ok(first.lastUsed === null || typeof first.lastUsed === 'string');
    console.log(`(a) first grant row -> ${JSON.stringify(first)}`);

    // The whole raw response must not carry a secret (plaintext or hash) or a token.
    const forbidden: Array<[string, string]> = [
      ['dcr client secret', harness.dcrClient.clientSecret],
      ['dcr secret sha256', sha256Hex(harness.dcrClient.clientSecret)],
      ['manual client secret', harness.manualClient.clientSecret],
      ['manual secret sha256', sha256Hex(harness.manualClient.clientSecret)],
      ['dcr access token', harness.tokenDcr],
      ['manual access token', harness.tokenManual],
    ];
    for (const [label, value] of forbidden) {
      assert.ok(!response.body.includes(value), `the grant list must not contain the ${label}`);
    }
    // Positive control: the client name IS present, so the scan is not vacuously true.
    assert.ok(response.body.includes('DCR App'), 'the client name must appear');
    console.log('(a) scan: no secret/token plaintext or hash present; positive control "DCR App" present');
  });
});

test('(b) revoking a grant fails its token on the very next /mcp call (200 -> 401)', async () => {
  await withSettingsServer(async (harness) => {
    const before = await harness.mcp(harness.tokenDcr);
    assert.equal(before.status, 200);

    const revoked = await harness.settings('DELETE', `/oauth-grants/${harness.grantDcr}`, USER_A);
    assert.equal(revoked.status, 200);
    const revokedBody = revoked.json as { revoked: boolean; tokensRevoked: number };
    assert.equal(revokedBody.revoked, true);
    assert.ok(revokedBody.tokensRevoked >= 1);

    const after = await harness.mcp(harness.tokenDcr);
    assert.equal(after.status, 401);

    const row = harness.grantRow(harness.grantDcr);
    console.log(
      `(b) /mcp before=${before.status} after=${after.status} revoked_at=${JSON.stringify(row?.revoked_at)} tokensRevoked=${revokedBody.tokensRevoked}`
    );
    assert.ok(row !== undefined && row.revoked_at !== null, 'the grant row must be stamped revoked');
  });
});

test('(c) disabling a client fails its token next /mcp (200 -> 401) while another client stays 200', async () => {
  await withSettingsServer(async (harness) => {
    const disableClient = harness.register('Disable Me', 'https://disable.example.test/cb', 'manual');
    const controlClient = harness.register('Keep Me', 'https://keep.example.test/cb', 'manual');
    const disableGrant = harness.grant(USER_A, disableClient.clientId);
    const controlGrant = harness.grant(USER_A, controlClient.clientId);
    const disableToken = harness.issue(disableGrant, ['cloudcli:read']);
    const controlToken = harness.issue(controlGrant, ['cloudcli:read']);

    const before = await harness.mcp(disableToken);
    assert.equal(before.status, 200);

    const disabled = await harness.settings(
      'PATCH',
      `/oauth-clients/${disableClient.clientId}/disable`,
      USER_A
    );
    assert.equal(disabled.status, 200);
    const disabledBody = disabled.json as { disabled: boolean; tokensRevoked: number };
    assert.equal(disabledBody.disabled, true);
    assert.ok(disabledBody.tokensRevoked >= 1);

    const after = await harness.mcp(disableToken);
    assert.equal(after.status, 401);
    // Positive control: a client that was NOT disabled still authenticates.
    const control = await harness.mcp(controlToken);
    assert.equal(control.status, 200);

    console.log(
      `(c) disabled-client /mcp before=${before.status} after=${after.status} | un-disabled control /mcp=${control.status} tokensRevoked=${disabledBody.tokensRevoked}`
    );
  });
});

test("(d) revoking another user's grant answers 404 and does not revoke it", async () => {
  await withSettingsServer(async (harness) => {
    const foreignGrant = harness.grant(USER_B, harness.manualClient.clientId);

    const asA = await harness.settings('DELETE', `/oauth-grants/${foreignGrant}`, USER_A);
    assert.equal(asA.status, 404);
    const rowAfterA = harness.grantRow(foreignGrant);
    assert.equal(rowAfterA?.revoked_at, null, "user A's rejected attempt must not revoke B's grant");

    const asB = await harness.settings('DELETE', `/oauth-grants/${foreignGrant}`, USER_B);
    assert.equal(asB.status, 200);
    const rowAfterB = harness.grantRow(foreignGrant);

    console.log(
      `(d) as A status=${asA.status} revoked_at=${JSON.stringify(rowAfterA?.revoked_at)} | as B status=${asB.status} revoked_at=${JSON.stringify(rowAfterB?.revoked_at)}`
    );
    assert.notEqual(rowAfterB?.revoked_at, null, "the owner's revocation must stamp the row");
  });
});

test('(e) the client list distinguishes DCR from manual and leaks no secret', async () => {
  await withSettingsServer(async (harness) => {
    const response = await harness.settings('GET', '/oauth-clients', USER_A);
    assert.equal(response.status, 200);

    const body = response.json as { clients: OAuthClientSummary[] };
    const dcr = body.clients.find((client) => client.clientId === harness.dcrClient.clientId);
    const manual = body.clients.find((client) => client.clientId === harness.manualClient.clientId);
    assert.ok(dcr !== undefined && manual !== undefined, 'both seeded clients must be listed');
    assert.equal(dcr.createdVia, 'dcr');
    assert.equal(manual.createdVia, 'manual');
    assert.equal(dcr.clientName, 'DCR App');
    assert.equal(dcr.redirectHost, 'dcr.example.test');
    assert.equal(manual.clientName, 'Manual App');
    assert.equal(manual.redirectHost, 'manual.example.test');

    assert.ok(!response.body.includes(harness.dcrClient.clientSecret), 'no client secret plaintext');
    assert.ok(!response.body.includes(sha256Hex(harness.dcrClient.clientSecret)), 'no client secret hash');
    assert.ok(!response.body.includes('client_secret'), 'no client_secret field');
    assert.ok(!response.body.includes('_hash'), 'no hash field');
    assert.ok(!response.body.includes(harness.tokenDcr), 'no token plaintext');

    console.log(`(e) dcr.createdVia=${dcr.createdVia} manual.createdVia=${manual.createdVia}`);
  });
});
