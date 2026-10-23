/**
 * `/mcp` token authentication criterion (AC-241).
 *
 * Drives the PRODUCTION assembly — `createTokenInfoRouter` and
 * `mountMcpGateway({ authorize: createMcpAuthMiddleware(...) })` on one real
 * express 4 application — backed by the real OAuth token service and a real
 * better-sqlite3 database in a temp directory. Requests go over `node:http`,
 * never `fetch`: undici refuses a fixed list of ports and `listen(0)` lands on
 * one often enough to red a suite run at random (see AC-240's criterion).
 *
 * Readings, one leg each:
 *   (a) seven invalid credentials (no header / non-Bearer / empty / unknown /
 *       expired / revoked / wrong prefix) all answer 401 with bytes identical to
 *       each other AND to `/api/oauth/token-info`'s 401 body — no reason leaks;
 *   (b) a live token reaches the transport (200 + JSON-RPC result) — the
 *       positive control that keeps (a) from passing vacuously;
 *   (c) revocation takes effect on the next request, same running server;
 *   (d) a counting spy proves `/mcp` and `/token-info` verify through the SAME
 *       service object, two-way stub controls prove the gateway obeys the
 *       injected verdict, and a source scan proves the gateway has no DB/hash;
 *   (e) a successful request stamps `last_used` and puts the owner's `userId`
 *       into the principal `readMcpPrincipal` returns.
 */

import assert from 'node:assert/strict';
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

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import type { AccessTokensService, IssuedAccessToken, VerifyAccessTokenResult } from '@/modules/oauth/index.js';
import { createAccessTokensService, createTokenInfoRouter } from '@/modules/oauth/index.js';

import { createMcpAuthMiddleware, MCP_GATEWAY_PATH, mountMcpGateway, readMcpPrincipal } from '../index.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const AUTH_SOURCE_PATH = path.join(REPO_ROOT, 'server/modules/mcp-gateway/mcp-gateway.auth.ts');
const ACCESS_TOKENS_SERVICE_PATH = path.join(REPO_ROOT, 'server/modules/oauth/access-tokens.service.ts');

/** The one body `/mcp` and `/token-info` must both return for a bad credential. */
const UNAUTHORIZED_BODY_TEXT = '{"error":"A valid personal access token is required","code":"ACCESS_TOKEN_INVALID"}';

/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';

const USER_ONE = 1;
const START = new Date('2026-01-01T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VALID_SCOPES = ['cloudcli:read'];

// --------------------------- HTTP ---------------------------

type Exchange = { status: number; contentType: string | null; body: string };

/** A single real-HTTP exchange over `node:http` (never `fetch`). */
function request(
  baseUrl: string,
  method: string,
  requestPath: string,
  options: { headers?: Record<string, string>; body?: unknown; accept?: string } = {},
): Promise<Exchange> {
  const url = new URL(requestPath, baseUrl);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = { ...options.headers };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (options.accept) {
    headers.accept = options.accept;
  }

  return new Promise<Exchange>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            body,
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

/** POSTs a JSON-RPC `tools/list` to `/mcp` with (or without) an authorization header. */
function postMcp(baseUrl: string, authorization?: string): Promise<Exchange> {
  return request(baseUrl, 'POST', MCP_GATEWAY_PATH, {
    accept: MCP_ACCEPT,
    headers: authorization === undefined ? {} : { authorization },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
}

/** GETs `/api/oauth/token-info` with an authorization header. */
function getTokenInfo(baseUrl: string, authorization: string): Promise<Exchange> {
  return request(baseUrl, 'GET', '/api/oauth/token-info', { headers: { authorization } });
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

function isJsonRpcContentType(contentType: string | null): boolean {
  const value = contentType ?? '';
  return value.includes('application/json') || value.includes('text/event-stream');
}

// --------------------------- counting spy ---------------------------

/**
 * Wraps a real `AccessTokensService`. In delegate mode `verifyToken` forwards to
 * the real service while recording every token and the receiver it was called on
 * (so a criterion can prove both routes used the SAME object). In stub mode it
 * returns a fixed verdict, which is how the criterion shows the gateway's
 * decision comes entirely from the injected service.
 */
type Spy = {
  service: AccessTokensService;
  received: string[];
  receivers: unknown[];
  setStub: (result: VerifyAccessTokenResult) => void;
  clearStub: () => void;
  count: () => number;
};

function createCountingSpy(real: AccessTokensService): Spy {
  let stub: VerifyAccessTokenResult | null = null;
  const received: string[] = [];
  const receivers: unknown[] = [];
  const service: AccessTokensService = {
    issueToken: (input) => real.issueToken(input),
    revokeToken: (id) => real.revokeToken(id),
    verifyToken(token, requiredScope) {
      received.push(token);
      receivers.push(this);
      return stub ?? real.verifyToken(token, requiredScope);
    },
  };

  return {
    service,
    received,
    receivers,
    setStub: (result) => {
      stub = result;
    },
    clearStub: () => {
      stub = null;
    },
    count: () => received.length,
  };
}

// --------------------------- harness ---------------------------

type Harness = {
  baseUrl: string;
  tokens: AccessTokensService;
  spy: Spy;
  advanceDays: (days: number) => void;
  issue: (expiresInDays: number) => IssuedAccessToken;
};

/** The row shape this criterion reads back from the real database. */
type TokenRow = { last_used: string | null };

function readTokenRow(id: number): TokenRow {
  return getConnection().prepare('SELECT last_used FROM access_tokens WHERE id = ?').get(id) as TokenRow;
}

/**
 * Runs `run` against a fresh temp database, the production token-info router and
 * the production `/mcp` gateway — both sharing ONE counting spy over ONE real
 * token service, exactly as `server/index.ts` assemblies them.
 */
async function withMcpAuthServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-auth-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  // `access_tokens.user_id` references `users(id)`, so the owner row has to exist.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const clock = { current: new Date(START.getTime()) };
  const tokens = createAccessTokensService({ now: () => new Date(clock.current.getTime()) });
  const spy = createCountingSpy(tokens);

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/oauth', createTokenInfoRouter(spy.service));

  const authorize = createMcpAuthMiddleware(spy.service);
  mountMcpGateway(app, { env: { MCP_ENABLED: 'true' }, authorize });
  // The probe sits behind the SAME middleware instance as the gateway and reads
  // back the principal it attached — the tool-context seam AC-245+ consumes.
  app.post('/mcp-principal-probe', authorize, (_req, res) => {
    res.json({ principal: readMcpPrincipal(res) });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  const issue = (expiresInDays: number): IssuedAccessToken => {
    const issued = tokens.issueToken({ userId: USER_ONE, name: 'mcp', scopes: VALID_SCOPES, expiresInDays });
    if (!issued.ok) {
      throw new Error('the harness issued a token with a lifetime the service rejects');
    }
    return issued.token;
  };

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      tokens,
      spy,
      advanceDays: (days) => {
        clock.current = new Date(clock.current.getTime() + days * MS_PER_DAY);
      },
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

// --------------------------- legs ---------------------------

test('(a) every invalid credential gets the same 401 body as /token-info, leaking no reason', async () => {
  await withMcpAuthServer(async (h) => {
    const valid = h.issue(30);
    const expired = h.issue(7);
    const revoked = h.issue(30);
    assert.equal(h.tokens.revokeToken(revoked.id), true);
    h.advanceDays(7); // `expired` is now past; `valid` (30d) stays live.

    const cases: { label: string; authorization?: string }[] = [
      { label: 'no header' },
      { label: 'non-bearer', authorization: `Basic ${valid.token}` },
      { label: 'empty token', authorization: 'Bearer ' },
      { label: 'unknown', authorization: `Bearer ccp_${'f'.repeat(64)}` },
      { label: 'expired', authorization: `Bearer ${expired.token}` },
      { label: 'revoked', authorization: `Bearer ${revoked.token}` },
      { label: 'wrong prefix', authorization: `Bearer cca_${'a'.repeat(64)}` },
    ];

    const bodies: string[] = [];
    for (const testCase of cases) {
      const response = await postMcp(h.baseUrl, testCase.authorization);
      assert.equal(response.status, 401, `${testCase.label} must be rejected`);
      bodies.push(response.body);
    }

    for (let i = 1; i < bodies.length; i += 1) {
      assert.equal(bodies[i], bodies[0], `body for "${cases[i].label}" differs from "${cases[0].label}"`);
    }

    const tokenInfo = await getTokenInfo(h.baseUrl, `Bearer ccp_${'f'.repeat(64)}`);
    assert.equal(tokenInfo.status, 401);
    assert.equal(bodies[0], tokenInfo.body, '/mcp and /token-info must share the 401 body byte-for-byte');
    assert.equal(tokenInfo.body, UNAUTHORIZED_BODY_TEXT);

    const readings = cases.map((testCase, i) => `${testCase.label}=${JSON.stringify(bodies[i])}`);
    console.log(`(a) seven /mcp bodies (all identical): ${readings.join(' | ')}`);
    console.log(`(a) /token-info body=${JSON.stringify(tokenInfo.body)}`);
  });
});

test('(b) a valid token is admitted: tools/list answers 200 with a JSON-RPC result', async () => {
  await withMcpAuthServer(async (h) => {
    const valid = h.issue(30);

    const response = await postMcp(h.baseUrl, `Bearer ${valid.token}`);
    assert.equal(response.status, 200);
    const json = parseJsonRpc(response.body, response.contentType);
    assert.ok(json !== null && 'result' in json, 'the response must carry a JSON-RPC result');
    assert.ok(isJsonRpcContentType(response.contentType), `unexpected content-type: ${response.contentType}`);

    console.log(
      `(b) status=${response.status} content-type=${response.contentType} bodyHead=${JSON.stringify(response.body.slice(0, 120))}`,
    );
  });
});

test('(c) revocation takes effect on the next request, same running server', async () => {
  await withMcpAuthServer(async (h) => {
    const valid = h.issue(30);

    const before = await postMcp(h.baseUrl, `Bearer ${valid.token}`);
    assert.equal(before.status, 200);

    const revoked = h.tokens.revokeToken(valid.id);
    assert.equal(revoked, true);

    const after = await postMcp(h.baseUrl, `Bearer ${valid.token}`);
    assert.equal(after.status, 401);

    console.log(`(c) id=${valid.id} before=${before.status} revokeToken=${revoked} after=${after.status} (no restart, no cache)`);
  });
});

test('(d) /mcp and /token-info share one service object; the gateway obeys its verdict and has no second check', async () => {
  await withMcpAuthServer(async (h) => {
    const valid = h.issue(30);

    const before = h.spy.count();
    const tokenInfo = await getTokenInfo(h.baseUrl, `Bearer ${valid.token}`);
    assert.equal(tokenInfo.status, 200);
    const afterTokenInfo = h.spy.count();
    assert.equal(afterTokenInfo, before + 1, '/token-info must verify through the spy');

    const mcp = await postMcp(h.baseUrl, `Bearer ${valid.token}`);
    assert.equal(mcp.status, 200);
    const afterMcp = h.spy.count();
    assert.equal(afterMcp, afterTokenInfo + 1, '/mcp must verify through the same spy');

    const identity = h.spy.receivers.length > 0 && h.spy.receivers.every((receiver) => receiver === h.spy.service);
    assert.ok(identity, 'both routes must call verifyToken on the same service object');

    // Stub mode 1: a token the real service rejects is ADMITTED because the
    // injected service says so — the gateway has no verdict of its own.
    h.spy.setStub({ ok: true, userId: 42, tokenId: 42, scopes: VALID_SCOPES, expiresAt: '2026-06-01T00:00:00.000Z' });
    const stubAllowed = await postMcp(h.baseUrl, `Bearer ccp_${'f'.repeat(64)}`);
    assert.equal(stubAllowed.status, 200);

    // Stub mode 2: a genuinely live token is REJECTED because the injected
    // service says so — the gateway cannot bypass it.
    h.spy.setStub({ ok: false, reason: 'not_found' });
    const stubDenied = await postMcp(h.baseUrl, `Bearer ${valid.token}`);
    assert.equal(stubDenied.status, 401);
    h.spy.clearStub();

    // Source-level control: the gateway auth module reaches no database and
    // hashes nothing; the OAuth service (positive control) does both.
    const dbPattern = /sha256|createHash|findByHash|accessTokensDb/;
    const hits = (source: string): number => source.split('\n').filter((line) => dbPattern.test(line)).length;
    const authHits = hits(readFileSync(AUTH_SOURCE_PATH, 'utf8'));
    const serviceHits = hits(readFileSync(ACCESS_TOKENS_SERVICE_PATH, 'utf8'));
    assert.equal(authHits, 0, 'mcp-gateway.auth.ts must not touch the database or hash tokens');
    assert.ok(serviceHits >= 1, 'the positive control must find DB/hash access in access-tokens.service.ts');

    console.log(
      `(d) identity=${identity} verifyToken counts before=${before} afterTokenInfo=${afterTokenInfo} afterMcp=${afterMcp}; ` +
        `stubAllowed=${stubAllowed.status} stubDenied=${stubDenied.status}; authHits=${authHits} serviceHits=${serviceHits}`,
    );
  });
});

test('(e) a successful request stamps last_used and puts the owner id into the principal', async () => {
  await withMcpAuthServer(async (h) => {
    const valid = h.issue(30);

    const beforeRow = readTokenRow(valid.id);
    assert.equal(beforeRow.last_used, null, 'a fresh token has no last_used');

    const response = await postMcp(h.baseUrl, `Bearer ${valid.token}`);
    assert.equal(response.status, 200);

    const afterRow = readTokenRow(valid.id);
    assert.notEqual(afterRow.last_used, null, 'last_used must be stamped after a successful check');
    assert.ok(
      new Date(afterRow.last_used as string).getTime() >= START.getTime(),
      'last_used must be at or after the issuance instant',
    );

    const probe = await request(h.baseUrl, 'POST', '/mcp-principal-probe', {
      headers: { authorization: `Bearer ${valid.token}` },
    });
    assert.equal(probe.status, 200);
    const body = JSON.parse(probe.body) as {
      principal: { userId: number; tokenId: number; clientId: string | null; scopes: string[] } | null;
    };
    assert.notEqual(body.principal, null, 'readMcpPrincipal must be non-null after a valid request');
    // AC-244 extends the principal with the token id (for the audit log) and a
    // null client id (a PAT has no OAuth client).
    assert.deepEqual(body.principal, {
      userId: USER_ONE,
      tokenId: valid.id,
      clientId: null,
      scopes: VALID_SCOPES,
    });
    assert.notEqual(body.principal?.userId, null);

    console.log(
      `(e) last_used before=${JSON.stringify(beforeRow.last_used)} after=${JSON.stringify(afterRow.last_used)}; principal=${JSON.stringify(body.principal)}`,
    );
  });
});
