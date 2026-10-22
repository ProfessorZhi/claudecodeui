/**
 * `/api/oauth/token-info` route criterion.
 *
 * Drives the production route factory (`createTokenInfoRouter`) over real HTTP
 * (`app.listen(0)` + `fetch`), backed by the real OAuth token service and a real
 * better-sqlite3 database built in a temp directory. Covers:
 *   (a) a live token answers 200 with the owner id, its scopes and its expiry;
 *   (b) a revoked token answers 401 on the SAME running server — the service
 *       re-reads the row, so revocation needs no restart and no cache flush;
 *   (c) an expired token answers 401;
 *   (d) a missing/foreign/mistyped token answers 401, so (a) is not vacuous.
 *
 * The token service is created after `process.env.DATABASE_PATH` points at the
 * temp database, and the injected clock is advanced in-process to reach expiry
 * without waiting on wall time.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { createAccessTokensService, createTokenInfoRouter } from '@/modules/oauth/index.js';

const USER_ONE = 1;
const START = new Date('2026-01-01T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A token the service issued: its id, plaintext and the expiry it recorded. */
type IssuedToken = { id: number; token: string; expiresAt: string };

type Harness = {
  /** Base URL of the mounted router, e.g. `http://127.0.0.1:PORT/api/oauth`. */
  baseUrl: string;
  /** The real token service behind the route. */
  tokens: ReturnType<typeof createAccessTokensService>;
  /** Advances the injected clock, so expiry is reached without real waiting. */
  advanceDays: (days: number) => void;
};

/** Runs `run` against a fresh temp database, a real token service and the production router. */
async function withTokenInfoServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'token-info-routes-'));
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

  const app = express();
  app.use('/api/oauth', createTokenInfoRouter(tokens));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/api/oauth`,
      tokens,
      advanceDays: (days) => { clock.current = new Date(clock.current.getTime() + days * MS_PER_DAY); },
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

/** Issues a live token or fails the test — the harness never wants the invalid-expiry branch. */
function issueToken(harness: Harness, expiresInDays: number): IssuedToken {
  const issued = harness.tokens.issueToken({
    userId: USER_ONE,
    name: 'self-check',
    scopes: ['cloudcli:read'],
    expiresInDays,
  });
  if (!issued.ok) {
    throw new Error('the harness issued a token with a lifetime the service rejects');
  }
  return issued.token;
}

/** GETs `/token-info` with (or without) an `Authorization` header. */
function getTokenInfo(baseUrl: string, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl}/token-info`, authorization === undefined ? undefined : { headers: { authorization } });
}

test('(a) a live token answers 200 with its owner, scopes and expiry, verified per request', async () => {
  await withTokenInfoServer(async (harness) => {
    const token = issueToken(harness, 30);

    const response = await getTokenInfo(harness.baseUrl, `Bearer ${token.token}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { userId: number; scopes: string[]; expiresAt: string };
    assert.equal(body.userId, USER_ONE);
    assert.deepEqual(body.scopes, ['cloudcli:read']);
    assert.equal(body.expiresAt, token.expiresAt);

    // No cache: the row is read on every request, so a second call answers the
    // same way without the server being restarted.
    const second = await getTokenInfo(harness.baseUrl, `Bearer ${token.token}`);
    assert.equal(second.status, 200);
    console.log(`(a) status=${response.status} userId=${body.userId} scopes=${body.scopes.join(',')} expiresAt=${body.expiresAt}`);
  });
});

test('(b) revocation invalidates the token on the same running server', async () => {
  await withTokenInfoServer(async (harness) => {
    const token = issueToken(harness, 30);

    const before = await getTokenInfo(harness.baseUrl, `Bearer ${token.token}`);
    assert.equal(before.status, 200);

    assert.equal(harness.tokens.revokeToken(token.id), true);
    const after = await getTokenInfo(harness.baseUrl, `Bearer ${token.token}`);
    assert.equal(after.status, 401);
    assert.equal((await after.json() as { code: string }).code, 'ACCESS_TOKEN_INVALID');

    console.log(`(b) id=${token.id} before=${before.status} after=${after.status} (no restart, no cache)`);
  });
});

test('(c) an expired token answers 401', async () => {
  await withTokenInfoServer(async (harness) => {
    const token = issueToken(harness, 7);
    assert.equal((await getTokenInfo(harness.baseUrl, `Bearer ${token.token}`)).status, 200);

    harness.advanceDays(7);
    const expired = await getTokenInfo(harness.baseUrl, `Bearer ${token.token}`);
    assert.equal(expired.status, 401);

    console.log(`(c) id=${token.id} at +7d status=${expired.status}`);
  });
});

test('(d) missing, foreign and mistyped tokens answer 401, so (a) is not vacuous', async () => {
  await withTokenInfoServer(async (harness) => {
    const token = issueToken(harness, 30);
    // The positive control: the same request shape with a real token is 200.
    assert.equal((await getTokenInfo(harness.baseUrl, `Bearer ${token.token}`)).status, 200);

    const cases: { label: string; authorization?: string }[] = [
      { label: 'no header' },
      { label: 'empty scheme value', authorization: 'Bearer ' },
      { label: 'wrong scheme', authorization: `Basic ${token.token}` },
      { label: 'foreign prefix', authorization: `Bearer cca_${'a'.repeat(64)}` },
      { label: 'unknown ccp token', authorization: `Bearer ccp_${'f'.repeat(64)}` },
      { label: 'mistyped token', authorization: `Bearer ${token.token.slice(0, -1)}` },
    ];
    const readings: string[] = [];
    for (const testCase of cases) {
      const response = await getTokenInfo(harness.baseUrl, testCase.authorization);
      assert.equal(response.status, 401, `${testCase.label} should be rejected`);
      readings.push(`${testCase.label}=${response.status}`);
    }
    console.log(`(d) positive-control=200; ${readings.join(', ')}`);
  });
});
