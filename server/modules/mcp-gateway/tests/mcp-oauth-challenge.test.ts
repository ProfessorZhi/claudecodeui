/**
 * `/mcp` OAuth-aware authentication criterion (AC-263; GOAL-021 exit condition 4,
 * SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §415/§416/§418/§422/§516/§524).
 *
 * Once `MCP_OAUTH_ENABLED` is on, `/mcp` accepts BOTH `ccp_` personal access
 * tokens (AC-241) and `cca_` OAuth access tokens whose audience is this gateway,
 * and its audit rows distinguish the two sources by `client_id`. A rejected
 * credential carries an RFC 9728 discovery challenge pointing at the
 * protected-resource metadata AC-262 publishes, the loopback guard (AC-242)
 * stands itself down, and a token missing a tool's scope is denied with a
 * `denied` audit row (AC-244).
 *
 * The production assembly is exercised for real: a real express 4 application, a
 * real better-sqlite3 database in a temp directory, the real OAuth store/provider
 * (AC-258/259) minting real tokens, and `node:http` requests — never `fetch`,
 * because undici refuses a fixed list of ports and `listen(0)` lands on one often
 * enough to red a suite run at random (see AC-240/241/242/244's criteria).
 *
 * Readings, one leg each:
 *   (a) OAuth on, no token => 401 with the exact `resource_metadata` challenge;
 *       OAuth off, no token => 401 with NO challenge (ACK-241 unchanged);
 *   (b) a valid PAT and a valid OAuth access token are both admitted (200), and
 *       the two audit rows differ in `client_id` (OAuth = client id, PAT = null);
 *   (c) a token bound to another resource is refused (401); a same-shaped token
 *       bound to this gateway's resource is admitted (200);
 *   (d) OAuth on stands the loopback guard down: a non-loopback socket reaches
 *       authentication and gets 401, not the guard's 403 — OAuth off keeps 403;
 *   (e) an OAuth token missing the probe tool's scope is denied (`isError`) with
 *       exactly one `denied` audit row naming the token and its client; a token
 *       with the scope is `ok`;
 *   (f) source-level: the auth module carries the `resource_metadata` literal, so
 *       (a)'s assertion reads a real response header rather than a self-made string.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import {
  accessTokensDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  mcpAuditLogDb,
} from '@/modules/database/index.js';
import {
  createAccessTokensService,
  createOAuthProvider,
  createOAuthStore,
} from '@/modules/oauth/index.js';
import type { AccessTokensService, OAuthStore } from '@/modules/oauth/index.js';

import {
  createMcpAuthMiddleware,
  MCP_GATEWAY_PATH,
  mountMcpGateway,
  withMcpAudit,
} from '../index.js';
import type { McpOauthSeam, McpToolRegistrar } from '../index.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const AUTH_SOURCE_PATH = path.join(REPO_ROOT, 'server/modules/mcp-gateway/mcp-gateway.auth.ts');

/** The audience this gateway serves and every bound token must carry. */
const PUBLIC_BASE_URL = 'https://cli.example';
const AUDIENCE = `${PUBLIC_BASE_URL}/mcp`;
/** A resource the gateway does NOT serve: a token bound to it must be refused. */
const OTHER_RESOURCE = 'https://elsewhere.example/mcp';
const REDIRECT_URI = 'https://app.example/cb';

/** The exact discovery challenge a rejection carries while OAuth is on. */
const EXPECTED_CHALLENGE = `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp"`;

/** The audited probe tool, and the scope it needs (`cloudcli:read`, AC-243). */
const PROBE_TOOL = 'probe_read';
const PROBE_SCOPE = 'cloudcli:read';

/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';

const MS_PER_HOUR = 60 * 60 * 1000;

const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** A fresh PKCE pair: a random verifier and its S256 (base64url) challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

// --------------------------- HTTP (node:http, never fetch) ---------------------------

type Exchange = {
  status: number;
  headers: http.IncomingHttpHeaders;
  contentType: string | null;
  body: string;
  json: Record<string, unknown> | null;
};

/** A single real-HTTP JSON-RPC POST to `/mcp` over `node:http` (never `fetch`). */
function request(baseUrl: string, body: unknown, authorization?: string): Promise<Exchange> {
  const url = new URL(MCP_GATEWAY_PATH, baseUrl);
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    accept: MCP_ACCEPT,
  };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }

  return new Promise<Exchange>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          const contentType = (res.headers['content-type'] as string | undefined) ?? null;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            contentType,
            body: responseBody,
            json: parseJsonRpc(responseBody, contentType),
          });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** A JSON-RPC envelope from either wire shape: a JSON body or an SSE `data:` frame. */
function parseJsonRpc(body: string, contentType: string | null): Record<string, unknown> | null {
  let text = body;
  if ((contentType ?? '').includes('text/event-stream')) {
    const dataLine = body.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return null;
    }
    text = dataLine.slice('data:'.length).trim();
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** POSTs a `tools/call` for `name` to `/mcp` with an optional bearer token. */
function toolsCall(baseUrl: string, name: string, authorization?: string): Promise<Exchange> {
  return request(
    baseUrl,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
    authorization
  );
}

/** Whether an exchange's JSON-RPC `result` carries `isError: true`. */
function resultIsError(exchange: Exchange): boolean {
  const result = exchange.json?.result as { isError?: boolean } | undefined;
  return result?.isError === true;
}

/** The `WWW-Authenticate` header as a single string, or null when absent. */
function challengeOf(exchange: Exchange): string | null {
  const value = exchange.headers['www-authenticate'];
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? value.join(', ') : value;
}

// --------------------------- harness ---------------------------

type Harness = {
  baseUrl: string;
  /** The env object BOTH the mount-time gate, the loopback guard and the auth middleware read. */
  env: NodeJS.ProcessEnv;
  /** The registered OAuth client id every OAuth audit row must name. */
  clientId: string;
  /** Overrides `req.socket` (AC-242's technique) to produce a non-loopback source. */
  socketPlan: { current: string | undefined };
  /** Issues a live PAT and returns its id and plaintext. */
  issuePat: (scopes: string[]) => { id: number; token: string };
  /** Issues a live OAuth access token bound to THIS gateway, with its row id. */
  issueOAuthToken: (scopes: string[]) => { token: string; tokenId: number };
  /** Issues a live OAuth access token bound to {@link OTHER_RESOURCE}. */
  issueMisboundToken: (scopes: string[]) => string;
};

/**
 * Runs `run` against a fresh temp database, the real token/OAuth services and the
 * production `/mcp` mount — a real express app over real better-sqlite3, driven by
 * `node:http`. `env` is one mutable object so each leg flips `MCP_OAUTH_ENABLED`
 * in place and the same mounted app observes it on the next request.
 */
async function withOauthChallengeServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-challenge-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'challenge.db');
  await initializeDatabase();

  const userId = Number(
    getConnection()
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('oauth-challenge-owner', 'hash').lastInsertRowid
  );

  // One clock shared by the token service, the store and the provider, so token
  // expiries are deterministic (the criterion never advances it; every token
  // lives for its full default lifetime within a leg).
  const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const now = (): Date => new Date(nowMs);
  const tokens: AccessTokensService = createAccessTokensService({ now });
  const store: OAuthStore = createOAuthStore({ now });
  const provider = createOAuthProvider({ store, now, publicBaseUrl: PUBLIC_BASE_URL });

  // A PUBLIC client (no secret): the token exchange needs only PKCE, so the
  // criterion mints real tokens without carrying a client secret around.
  const client = store.registerClient({
    clientName: 'challenge-app',
    redirectUris: [REDIRECT_URI],
    metadata: { kind: 'criterion' },
    createdVia: 'manual',
    publicClient: true,
  });

  const env: NodeJS.ProcessEnv = { MCP_ENABLED: 'true' };
  const socketPlan: { current: string | undefined } = { current: undefined };

  // The OAuth seam this task wires: AC-259's provider method passed straight
  // through (its success branch now carries `tokenId`/`clientId`).
  const oauth: McpOauthSeam = {
    publicBaseUrl: PUBLIC_BASE_URL,
    verifyAccessToken: (token, options) => provider.verifyAccessToken(token, options),
  };

  // The audited probe tool: requiring `cloudcli:read` means a token without it is
  // recorded `denied` by AC-244's wrapper before the handler runs.
  const probe = withMcpAudit({
    name: PROBE_TOOL,
    requiredScopes: [PROBE_SCOPE],
    handler: () => ({ probed: true }),
  });
  const registerTools: McpToolRegistrar = (server, principal) => probe(server, principal);

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // The socket override sits BEFORE the gateway, so the loopback guard (AC-242)
  // reads the fabricated address on the request it is handed.
  app.use((req, _res, next) => {
    if (socketPlan.current !== undefined) {
      Object.defineProperty(req, 'socket', {
        value: { remoteAddress: socketPlan.current },
        configurable: true,
      });
    }
    next();
  });
  mountMcpGateway(app, {
    env,
    authorize: createMcpAuthMiddleware({ tokens, oauth, env }),
    registerTools,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const issuePat = (scopes: string[]): { id: number; token: string } => {
    const issued = tokens.issueToken({ userId, name: 'probe', scopes, expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error('the harness issued a PAT with a lifetime the service rejects');
    }
    return { id: issued.token.id, token: issued.token.token };
  };

  const exchangeForScopes = (scopes: string[], resource: string): string => {
    const { verifier, challenge } = pkcePair();
    const authorized = provider.authorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scopes,
      resource,
      userId,
    });
    if (!authorized.ok) {
      throw new Error(`the harness's authorize failed: ${JSON.stringify(authorized)}`);
    }
    const exchanged = provider.exchangeAuthorizationCode({
      code: authorized.code,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource,
    });
    if (!exchanged.ok) {
      throw new Error(`the harness's token exchange failed: ${JSON.stringify(exchanged)}`);
    }
    return exchanged.accessToken;
  };

  const issueOAuthToken = (scopes: string[]): { token: string; tokenId: number } => {
    const token = exchangeForScopes(scopes, AUDIENCE);
    const row = accessTokensDb.findByHash(sha256Hex(token));
    if (!row) {
      throw new Error('the exchanged access token has no row');
    }
    return { token, tokenId: row.id };
  };

  // A token bound to another resource cannot be minted through `authorize` (it
  // refuses a non-default audience), so it is issued directly through the store.
  const issueMisboundToken = (scopes: string[]): string =>
    store.issueOAuthToken({
      grantId: store.createGrant({ userId, clientId: client.clientId, scopes, resource: OTHER_RESOURCE }).grantId,
      kind: 'oauth_access',
      scopes,
      resource: OTHER_RESOURCE,
      expiresAt: new Date(nowMs + MS_PER_HOUR).toISOString(),
    }).token;

  try {
    await run({
      baseUrl: `http://127.0.0.1:${port}`,
      env,
      clientId: client.clientId,
      socketPlan,
      issuePat,
      issueOAuthToken,
      issueMisboundToken,
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

// --------------------------- (a) discovery challenge ---------------------------

test('(a) OAuth on: a tokenless request is 401 with the resource_metadata challenge; OAuth off: 401 with none', async () => {
  await withOauthChallengeServer(async (h) => {
    h.env.MCP_OAUTH_ENABLED = 'true';
    const onExchange = await toolsCall(h.baseUrl, PROBE_TOOL);
    const onChallenge = challengeOf(onExchange);

    delete h.env.MCP_OAUTH_ENABLED;
    const offExchange = await toolsCall(h.baseUrl, PROBE_TOOL);
    const offChallenge = challengeOf(offExchange);

    console.log(
      `(a) OAuth on  status=${onExchange.status} WWW-Authenticate=${JSON.stringify(onChallenge)}`
    );
    console.log(
      `(a) OAuth off status=${offExchange.status} WWW-Authenticate=${JSON.stringify(offChallenge)}`
    );

    assert.equal(onExchange.status, 401, 'OAuth on + no token must be 401');
    assert.equal(onChallenge, EXPECTED_CHALLENGE, 'the challenge must be the exact discovery pointer');
    assert.equal(offExchange.status, 401, 'OAuth off + no token must be 401');
    assert.equal(offChallenge, null, 'OAuth off must carry NO WWW-Authenticate header (AC-241 unchanged)');
  });
});

// --------------------------- (b) PAT + OAuth coexist, audit splits source ---------------------------

test('(b) a valid PAT and a valid OAuth token are both admitted and the audit rows differ in client_id', async () => {
  await withOauthChallengeServer(async (h) => {
    h.env.MCP_OAUTH_ENABLED = 'true';

    const pat = h.issuePat([PROBE_SCOPE]);
    const oauthToken = h.issueOAuthToken([PROBE_SCOPE]);

    const before = mcpAuditLogDb.count();
    const patExchange = await toolsCall(h.baseUrl, PROBE_TOOL, `Bearer ${pat.token}`);
    const oauthExchange = await toolsCall(h.baseUrl, PROBE_TOOL, `Bearer ${oauthToken.token}`);

    const rows = mcpAuditLogDb.allRows();
    assert.equal(rows.length, before + 2, 'each admitted call writes exactly one audit row');
    const patRow = rows[before];
    const oauthRow = rows[before + 1];

    console.log(
      `(b) PAT   status=${patExchange.status} row=${JSON.stringify(patRow)}`
    );
    console.log(
      `(b) OAuth status=${oauthExchange.status} row=${JSON.stringify(oauthRow)}`
    );

    assert.equal(patExchange.status, 200, 'a valid PAT must be admitted while OAuth is on');
    assert.equal(oauthExchange.status, 200, 'a valid OAuth access token must be admitted');
    assert.equal(patRow.outcome, 'ok');
    assert.equal(patRow.token_id, pat.id);
    assert.equal(patRow.client_id, null, 'a PAT has no OAuth client id');
    assert.equal(oauthRow.outcome, 'ok');
    assert.equal(oauthRow.token_id, oauthToken.tokenId);
    assert.equal(oauthRow.client_id, h.clientId, 'an OAuth row must name its client id');
  });
});

// --------------------------- (c) audience gate ---------------------------

test('(c) an OAuth token bound to another resource is refused; a token bound to this gateway is admitted', async () => {
  await withOauthChallengeServer(async (h) => {
    h.env.MCP_OAUTH_ENABLED = 'true';

    const misbound = h.issueMisboundToken([PROBE_SCOPE]);
    const bound = h.issueOAuthToken([PROBE_SCOPE]);

    const misboundExchange = await toolsCall(h.baseUrl, PROBE_TOOL, `Bearer ${misbound}`);
    const boundExchange = await toolsCall(h.baseUrl, PROBE_TOOL, `Bearer ${bound.token}`);

    console.log(
      `(c) token resource=${OTHER_RESOURCE} status=${misboundExchange.status}`
    );
    console.log(`(c) token resource=${AUDIENCE} status=${boundExchange.status}`);

    assert.equal(misboundExchange.status, 401, 'a mis-bound OAuth token must be refused');
    assert.equal(boundExchange.status, 200, 'a correctly bound OAuth token must be admitted');
  });
});

// --------------------------- (d) loopback guard stands down ---------------------------

test('(d) OAuth on lets a non-loopback source reach authentication (401, not 403); OAuth off keeps the 403', async () => {
  await withOauthChallengeServer(async (h) => {
    h.socketPlan.current = '172.17.0.1';

    h.env.MCP_OAUTH_ENABLED = 'true';
    const onExchange = await toolsCall(h.baseUrl, PROBE_TOOL);

    delete h.env.MCP_OAUTH_ENABLED;
    const offExchange = await toolsCall(h.baseUrl, PROBE_TOOL);

    console.log(`(d) OAuth on  non-loopback + no token -> ${onExchange.status} (must be 401)`);
    console.log(`(d) OAuth off non-loopback + no token -> ${offExchange.status} (must be 403)`);

    assert.equal(onExchange.status, 401, 'with OAuth on the guard stands down and auth answers 401');
    assert.notEqual(onExchange.status, 403, 'with OAuth on the guard must NOT answer 403');
    assert.equal(offExchange.status, 403, 'with OAuth off the same source is refused by the guard');
  });
});

// --------------------------- (e) scope denial writes a denied audit row ---------------------------

test('(e) an OAuth token missing the tool scope is denied with one denied audit row; with the scope it is ok', async () => {
  await withOauthChallengeServer(async (h) => {
    h.env.MCP_OAUTH_ENABLED = 'true';

    const sendOnly = h.issueOAuthToken(['cloudcli:session:send']);
    const readOk = h.issueOAuthToken([PROBE_SCOPE]);

    const before = mcpAuditLogDb.count();
    const deniedExchange = await toolsCall(h.baseUrl, PROBE_TOOL, `Bearer ${sendOnly.token}`);
    const okExchange = await toolsCall(h.baseUrl, PROBE_TOOL, `Bearer ${readOk.token}`);

    const rows = mcpAuditLogDb.allRows();
    assert.equal(rows.length, before + 2, 'each call writes exactly one audit row');
    const deniedRow = rows[before];
    const okRow = rows[before + 1];

    console.log(
      `(e) missing scope isError=${resultIsError(deniedExchange)} row=${JSON.stringify(deniedRow)}`
    );
    console.log(`(e) with scope    isError=${resultIsError(okExchange)} row=${JSON.stringify(okRow)}`);

    assert.equal(deniedExchange.status, 200, 'a denied tool call is still an HTTP 200 JSON-RPC error');
    assert.equal(resultIsError(deniedExchange), true, 'a missing scope must answer isError');
    assert.equal(deniedRow.outcome, 'denied');
    // AC-286: the denied row carries the scope the OAuth token was missing.
    assert.deepEqual(
      JSON.parse(deniedRow.denied_scopes ?? 'null'),
      [PROBE_SCOPE],
      'the denied row must carry the missing probe scope',
    );
    assert.equal(deniedRow.token_id, sendOnly.tokenId, 'the denied row must name the invoking token');
    assert.equal(deniedRow.client_id, h.clientId, 'the denied row must name the OAuth client');
    assert.equal(okExchange.status, 200);
    assert.equal(resultIsError(okExchange), false, 'a token with the scope must not be denied');
    assert.equal(okRow.outcome, 'ok');
  });
});

// --------------------------- (f) source-level control ---------------------------

test('(f) the auth module carries the resource_metadata challenge literal (the pattern is not vacuous)', () => {
  const source = readFileSync(AUTH_SOURCE_PATH, 'utf8');
  const hits = source
    .split('\n')
    .map((line, index) => `${index + 1}:${line}`)
    .filter((entry) => entry.includes('resource_metadata'));
  // Positive control: the same matcher DOES hit a synthetic line, so a green
  // below is a real literal and not a matcher that can never fire.
  const syntheticHits = 'const probe = "resource_metadata";'
    .split('\n')
    .filter((entry) => entry.includes('resource_metadata'));

  console.log(
    `(f) resource_metadata hits in mcp-gateway.auth.ts: ${hits.map((line) => line.trim()).join(' || ')}`
  );
  console.log(`(f) synthetic positive control hits: ${syntheticHits.length}`);

  assert.ok(hits.length >= 1, 'the auth module must carry the resource_metadata literal');
  assert.ok(syntheticHits.length >= 1, 'the matcher must be able to hit a real occurrence');
});
