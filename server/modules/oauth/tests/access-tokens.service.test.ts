/**
 * Access-token service criterion.
 *
 * Runs the real service against a real better-sqlite3 database built in a temp
 * directory (temporary DATABASE_PATH + migrations), with an injected clock so
 * expiry can be reached by advancing time rather than sleeping. Covers:
 *   (a) plaintext only in the issue result, never on disk;
 *   (b) a live token verifies and stamps last_used, throttled to one write per
 *       60-second window;
 *   (c) the five rejection reasons are pairwise distinct;
 *   (d) only 7/30/90 day lifetimes are accepted;
 *   (e) revocation takes effect on the next verify in the same process.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { createAccessTokensService } from '@/modules/oauth/index.js';
import type { AccessTokensService, VerifyAccessTokenResult } from '@/modules/oauth/index.js';

const USER_ID = 1;
const START = new Date('2026-01-01T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type CriterionContext = {
  dbPath: string;
  service: AccessTokensService;
  userId: number;
  /** Moves the injected clock to `date`. */
  advanceTo: (date: Date) => void;
  /** The injected clock's current reading. */
  currentTime: () => Date;
};

/** Runs `run` against a freshly migrated temp database and cleans everything up. */
async function withAccessTokenDb(run: (context: CriterionContext) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'access-tokens-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  // access_tokens cascades from users(id), so the owner has to exist first.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');

  let current = new Date(START.getTime());
  const service = createAccessTokensService({ now: () => new Date(current.getTime()) });

  try {
    await run({
      dbPath: databasePath,
      service,
      userId: USER_ID,
      advanceTo: (date) => {
        current = new Date(date.getTime());
      },
      currentTime: () => new Date(current.getTime()),
    });
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

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: Buffer, needle: Buffer): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Reads the number of rows in access_tokens. */
function tokenRowCount(): number {
  const row = getConnection().prepare('SELECT COUNT(*) AS count FROM access_tokens').get() as {
    count: number;
  };
  return row.count;
}

test('(a) plaintext appears once in the issue result and zero times in the database', async () => {
  await withAccessTokenDb(async ({ service, userId, dbPath }) => {
    const issued = service.issueToken({ userId, name: 'laptop', scopes: ['cloudcli:read'] });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const plaintext = issued.token.token;
    assert.match(plaintext, /^ccp_[0-9a-f]{64}$/);

    const rows = getConnection().prepare('SELECT * FROM access_tokens').all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    const row = rows[0];

    // token_hash is exactly the SHA-256 of the plaintext; token_prefix its first 8 chars.
    const expectedHash = crypto.createHash('sha256').update(plaintext).digest('hex');
    assert.equal(String(row.token_hash), expectedHash);
    assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
    assert.equal(String(row.token_prefix), plaintext.slice(0, 8));

    // Scan every column value as a string for the plaintext.
    let columnHits = 0;
    const scannedColumns = Object.keys(row);
    for (const column of scannedColumns) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      if (String(value).includes(plaintext)) columnHits += 1;
    }
    assert.equal(columnHits, 0);

    // Scan the database file plus WAL/SHM siblings for the plaintext bytes.
    const scannedFiles: string[] = [];
    let fileHits = 0;
    const needle = Buffer.from(plaintext, 'utf8');
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${dbPath}${suffix}`;
      if (!existsSync(file)) continue;
      scannedFiles.push(file);
      fileHits += countOccurrences(await readFile(file), needle);
    }

    assert.equal(fileHits, 0);
    // The scan has to have looked at something, or "0 hits" would be vacuous.
    assert.equal(scannedFiles.length >= 1, true);
    assert.equal(scannedColumns.includes('token_hash'), true);
  });
});

test('(b) a live token verifies and stamps last_used from the injected clock, throttled to one write per window', async () => {
  await withAccessTokenDb(async ({ service, userId, advanceTo, currentTime }) => {
    const issued = service.issueToken({
      userId,
      name: 'laptop',
      scopes: ['cloudcli:read', 'cloudcli:session:send'],
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const readLastUsed = (): string | null =>
      (getConnection()
        .prepare('SELECT last_used FROM access_tokens WHERE id = ?')
        .get(issued.token.id) as { last_used: string | null }).last_used;

    assert.equal(readLastUsed(), null);

    const verified = service.verifyToken(issued.token.token, 'cloudcli:read');
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.userId, userId);
    assert.deepEqual(verified.scopes, ['cloudcli:read', 'cloudcli:session:send']);

    // t0: the first use fills the NULL column with the clock's reading.
    const firstStamp = currentTime().toISOString();
    assert.equal(readLastUsed(), firstStamp);

    // t0+59s: inside the window, so the stored instant is left alone.
    advanceTo(new Date(START.getTime() + 59_000));
    assert.equal(service.verifyToken(issued.token.token, 'cloudcli:read').ok, true);
    assert.equal(readLastUsed(), firstStamp);

    // t0+61s: past the window, so the instant advances to the new reading.
    advanceTo(new Date(START.getTime() + 61_000));
    assert.equal(service.verifyToken(issued.token.token, 'cloudcli:read').ok, true);
    assert.equal(readLastUsed(), new Date(START.getTime() + 61_000).toISOString());
  });
});

test('(c) the five rejection paths yield five pairwise-distinct reasons', async (t) => {
  await withAccessTokenDb(async ({ service, userId, advanceTo }) => {
    // One subtest per rejection so each reading is independently observable: the
    // always-valid falsification form has to redden all five, not just the first.
    const results: VerifyAccessTokenResult[] = [];

    await t.test('expired', () => {
      const issued = service.issueToken({ userId, scopes: ['cloudcli:read'], expiresInDays: 7 });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;
      advanceTo(new Date(START.getTime() + 8 * MS_PER_DAY));
      const result = service.verifyToken(issued.token.token);
      advanceTo(START);
      results.push(result);
      assert.deepEqual(result, { ok: false, reason: 'expired' });
    });

    await t.test('revoked', () => {
      const issued = service.issueToken({ userId, scopes: ['cloudcli:read'] });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;
      assert.equal(service.revokeToken(issued.token.id), true);
      const result = service.verifyToken(issued.token.token);
      results.push(result);
      assert.deepEqual(result, { ok: false, reason: 'revoked' });
    });

    await t.test('rewritten plaintext is not found', () => {
      const issued = service.issueToken({ userId, scopes: ['cloudcli:read'] });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;
      const rewritten =
        issued.token.token.slice(0, -1) + (issued.token.token.endsWith('0') ? '1' : '0');
      const result = service.verifyToken(rewritten);
      results.push(result);
      assert.deepEqual(result, { ok: false, reason: 'not_found' });
    });

    await t.test('foreign prefix', () => {
      const result = service.verifyToken(`cca_${'a'.repeat(64)}`);
      results.push(result);
      assert.deepEqual(result, { ok: false, reason: 'invalid_prefix' });
    });

    await t.test('insufficient scope', () => {
      const issued = service.issueToken({ userId, scopes: ['cloudcli:read'] });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;
      const result = service.verifyToken(issued.token.token, 'cloudcli:admin');
      results.push(result);
      assert.deepEqual(result, { ok: false, reason: 'insufficient_scope' });
    });

    // All five failures are discriminated results, not thrown errors, and no two
    // share a reason.
    const reasons = results.map((result) => (result.ok ? 'ok' : result.reason));
    assert.equal(reasons.length, 5);
    assert.equal(new Set(reasons).size, 5);
  });
});

test('(d) only 7/30/90 day lifetimes are accepted; anything else writes no row', async () => {
  await withAccessTokenDb(async ({ service, userId }) => {
    for (const days of [7, 30, 90]) {
      const result = service.issueToken({ userId, scopes: ['cloudcli:read'], expiresInDays: days });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.token.expiresAt, new Date(START.getTime() + days * MS_PER_DAY).toISOString());
    }

    // Omitted lifetime defaults to 30 days.
    const defaulted = service.issueToken({ userId, scopes: ['cloudcli:read'] });
    assert.equal(defaulted.ok, true);
    if (!defaulted.ok) return;
    assert.equal(defaulted.token.expiresAt, new Date(START.getTime() + 30 * MS_PER_DAY).toISOString());

    const beforeCount = tokenRowCount();
    assert.equal(beforeCount, 4);

    // null = permanent, Infinity = unlimited; 0/negative/365 out of policy.
    const rejected: (number | null)[] = [null, Infinity, 0, -1, 365];
    for (const days of rejected) {
      assert.deepEqual(
        service.issueToken({ userId, scopes: ['cloudcli:read'], expiresInDays: days }),
        { ok: false, reason: 'invalid_expiry' }
      );
    }

    assert.equal(tokenRowCount(), beforeCount);
  });
});

test('(e) revocation takes effect on the next verify, same process, no restart', async () => {
  await withAccessTokenDb(async ({ service, userId }) => {
    const issued = service.issueToken({ userId, scopes: ['cloudcli:read'] });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    assert.equal(service.verifyToken(issued.token.token).ok, true);
    assert.equal(service.revokeToken(issued.token.id), true);
    assert.deepEqual(service.verifyToken(issued.token.token), { ok: false, reason: 'revoked' });
  });
});
