import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  accessTokensDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  oauthAuthorizationCodesDb,
  oauthClientsDb,
  runMigrations,
} from '@/modules/database/index.js';
import { createOAuthStore } from '@/modules/oauth/index.js';
import type { OAuthStore } from '@/modules/oauth/index.js';

/**
 * AC-258 criterion: OAuth store — three tables + access_tokens OAuth columns,
 * hash-only secret storage, revoke/disable cascades, and idempotent migrations.
 *
 * Every reading is a real one against a real better-sqlite3 database built by
 * the production `initializeDatabase()`/`runMigrations()` path, on a temp
 * `DATABASE_PATH`. The plaintext scan reads the database file's raw bytes after
 * the connection is closed, with a positive control (each plaintext's SHA-256 is
 * present) so "no hits" cannot pass vacuously.
 */

const sha256Hex = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

const tableNames = (): string[] =>
  (
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((row) => row.name);

const columnNames = (table: string): string[] =>
  (getConnection().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name
  );

/** Row count per application table, so "migrations lost no row" is checkable. */
const rowCounts = (): Record<string, number> =>
  Object.fromEntries(
    tableNames()
      .filter((name) => !name.startsWith('sqlite_'))
      .map((name) => [
        name,
        (
          getConnection().prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {
            count: number;
          }
        ).count,
      ])
  );

/** The whole schema surface (e) asserts is invariant across a re-run. */
const schemaSnapshot = (): {
  tables: string[];
  columns: Record<string, string[]>;
  counts: Record<string, number>;
} => {
  const tables = tableNames().sort();
  return {
    tables,
    columns: Object.fromEntries(tables.map((name) => [name, columnNames(name)])),
    counts: rowCounts(),
  };
};

function assertSnapshotUnchanged(
  before: ReturnType<typeof schemaSnapshot>,
  label: string
): void {
  const after = schemaSnapshot();
  assert.deepEqual(after.tables, before.tables, `${label}: the table set must not change`);
  assert.deepEqual(after.columns, before.columns, `${label}: the column set must not change`);
  assert.deepEqual(after.counts, before.counts, `${label}: the row counts must not change`);
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

type OAuthDatabaseContext = {
  store: OAuthStore;
  userId: number;
  dbPath: string;
};

/** Fresh temp database on the production migration path, with one owner user. */
async function withOAuthDatabase(
  runTest: (context: OAuthDatabaseContext) => void | Promise<void>
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'oauth-store-'));
  const databasePath = path.join(tempDirectory, 'oauth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const userId = Number(
      getConnection()
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run('oauth-owner', 'hash').lastInsertRowid
    );
    const store = createOAuthStore();
    await runTest({ store, userId, dbPath: databasePath });
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

/** A token expiry far enough in the future that a real clock never expires it. */
const futureExpiry = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString();

const RESOURCE = 'https://example.test/mcp';

test('(a) the three OAuth tables and the access_tokens OAuth columns are present and usable', async () => {
  await withOAuthDatabase(async ({ store, userId }) => {
    const tables = tableNames();
    console.log(
      `(a) tables = ${tables.filter((name) => name.startsWith('oauth_')).sort().join(', ')}`
    );
    for (const name of ['oauth_clients', 'oauth_grants', 'oauth_authorization_codes']) {
      assert.ok(tables.includes(name), `the database must carry the ${name} table`);
    }

    // Column names verbatim against the SPEC DDL, in declaration order.
    const expectedColumns: Record<string, string[]> = {
      oauth_clients: [
        'client_id',
        'client_secret_hash',
        'client_name',
        'redirect_uris',
        'metadata',
        'created_via',
        'created_at',
        'disabled_at',
      ],
      oauth_grants: [
        'id',
        'user_id',
        'client_id',
        'scopes',
        'resource',
        'created_at',
        'last_used',
        'revoked_at',
      ],
      oauth_authorization_codes: [
        'code_hash',
        'client_id',
        'user_id',
        'redirect_uri',
        'code_challenge',
        'scopes',
        'resource',
        'expires_at',
      ],
    };
    for (const [table, expected] of Object.entries(expectedColumns)) {
      const actual = columnNames(table);
      console.log(`(a) ${table} columns = ${actual.join(', ')}`);
      assert.deepEqual(actual, expected, `${table} columns must equal the SPEC DDL verbatim`);
    }

    const accessColumns = columnNames('access_tokens');
    console.log(`(a) access_tokens columns = ${accessColumns.join(', ')}`);
    for (const column of ['kind', 'grant_id', 'resource']) {
      assert.ok(accessColumns.includes(column), `access_tokens must carry ${column}`);
    }

    const foreignKeys = getConnection()
      .prepare('PRAGMA foreign_key_list(access_tokens)')
      .all() as { from: string; table: string; to: string; on_delete: string }[];
    const grantForeignKey = foreignKeys.find((fk) => fk.from === 'grant_id');
    console.log(
      `(a) access_tokens.grant_id -> ${grantForeignKey?.table}(${grantForeignKey?.to}) ON DELETE ${grantForeignKey?.on_delete}`
    );
    assert.ok(grantForeignKey, 'access_tokens must declare a grant_id foreign key');
    assert.equal(grantForeignKey.table, 'oauth_grants');
    assert.equal(grantForeignKey.to, 'id');

    // Usable: client -> grant -> an oauth_access token, read back from the row.
    const { clientId, clientSecret } = store.registerClient({
      clientName: 'usable',
      redirectUris: ['https://client.test/cb'],
      metadata: { client_name: 'usable' },
      createdVia: 'manual',
    });
    assert.ok(clientSecret, 'a confidential client must get a secret');
    const { grantId } = store.createGrant({
      userId,
      clientId,
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
    });
    const { tokenId } = store.issueOAuthToken({
      grantId,
      kind: 'oauth_access',
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
      expiresAt: futureExpiry(),
    });

    const row = accessTokensDb.findById(tokenId);
    assert.ok(row, 'the issued token row must be readable');
    console.log(`(a) issued oauth_access row kind=${row.kind} grant_id=${row.grant_id}`);
    assert.equal(row.kind, 'oauth_access');
    assert.equal(row.grant_id, grantId);
  });
});

test('(b) only SHA-256 hashes reach the database; no secret plaintext appears in its bytes', async () => {
  await withOAuthDatabase(async ({ store, userId, dbPath }) => {
    const { clientId, clientSecret } = store.registerClient({
      clientName: 'confidential',
      redirectUris: ['https://client.test/cb'],
      metadata: {},
      createdVia: 'manual',
    });
    assert.ok(clientSecret, 'a confidential client must get a secret');

    const { code } = store.issueAuthorizationCode({
      clientId,
      userId,
      redirectUri: 'https://client.test/cb',
      codeChallenge: 'challenge-value',
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
    });
    const { grantId } = store.createGrant({
      userId,
      clientId,
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
    });
    const access = store.issueOAuthToken({
      grantId,
      kind: 'oauth_access',
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
      expiresAt: futureExpiry(),
    });
    const refresh = store.issueOAuthToken({
      grantId,
      kind: 'oauth_refresh',
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
      expiresAt: futureExpiry(),
    });

    // Positive controls: each plaintext's SHA-256 really is the stored hash, and
    // it is not the plaintext itself.
    const clientRow = oauthClientsDb.findById(clientId);
    const codeRow = oauthAuthorizationCodesDb.findByHash(sha256Hex(code));
    const accessRow = accessTokensDb.findByHash(sha256Hex(access.token));
    const refreshRow = accessTokensDb.findByHash(sha256Hex(refresh.token));
    assert.ok(clientRow && codeRow && accessRow && refreshRow, 'all four rows must be found by hash');

    assert.equal(clientRow.client_secret_hash, sha256Hex(clientSecret));
    assert.notEqual(clientSecret, clientRow.client_secret_hash);
    assert.equal(codeRow.code_hash, sha256Hex(code));
    assert.notEqual(code, codeRow.code_hash);
    assert.equal(accessRow.token_hash, sha256Hex(access.token));
    assert.notEqual(access.token, accessRow.token_hash);
    assert.equal(refreshRow.token_hash, sha256Hex(refresh.token));
    assert.notEqual(refresh.token, refreshRow.token_hash);

    console.log(
      `(b) hash readings: client_secret_hash=${clientRow.client_secret_hash} code_hash=${codeRow.code_hash}`
    );
    console.log(
      `(b) hash readings: access.token_hash=${accessRow.token_hash} refresh.token_hash=${refreshRow.token_hash}`
    );

    // Raw-byte scan of the closed database file (and WAL/SHM siblings).
    closeConnection();
    const files = readDatabaseFiles(dbPath);
    const plaintexts: Record<string, string> = {
      clientSecret,
      code,
      accessToken: access.token,
      refreshToken: refresh.token,
    };
    const hits: Record<string, number> = {};
    for (const [label, value] of Object.entries(plaintexts)) {
      const needle = Buffer.from(value, 'utf8');
      hits[label] = [...files.values()].reduce(
        (total, bytes) => total + countOccurrences(bytes, needle),
        0
      );
    }
    console.log(`(b) scanned files = ${[...files.keys()].join(', ')}`);
    console.log(`(b) plaintext hits = ${JSON.stringify(hits)}`);
    assert.ok(files.size >= 1, 'the scan must have looked at a real database file');
    for (const label of Object.keys(plaintexts)) {
      assert.equal(hits[label], 0, `${label} plaintext must not appear in the database bytes`);
    }
  });
});

test('(c) revoking a grant cascades its access+refresh tokens and leaves other grants alone', async () => {
  await withOAuthDatabase(async ({ store, userId }) => {
    const { clientId } = store.registerClient({
      clientName: 'cascade',
      redirectUris: ['https://client.test/cb'],
      metadata: {},
      createdVia: 'manual',
    });
    const g1 = store.createGrant({
      userId,
      clientId,
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
    }).grantId;
    const g2 = store.createGrant({
      userId,
      clientId,
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
    }).grantId;

    const issue = (grantId: number, kind: 'oauth_access' | 'oauth_refresh'): string =>
      store.issueOAuthToken({
        grantId,
        kind,
        scopes: ['cloudcli:read'],
        resource: RESOURCE,
        expiresAt: futureExpiry(),
      }).token;

    const t1access = issue(g1, 'oauth_access');
    const t1refresh = issue(g1, 'oauth_refresh');
    const t2access = issue(g2, 'oauth_access');

    const result = store.revokeGrant(g1);
    console.log(`(c) revokeGrant(g1) = ${JSON.stringify(result)}`);
    assert.deepEqual(result, { grantRevoked: true, tokensRevoked: 2 });

    const v1access = store.verifyOAuthToken(t1access);
    const v1refresh = store.verifyOAuthToken(t1refresh);
    const v2access = store.verifyOAuthToken(t2access);
    console.log(`(c) verify t1access = ${JSON.stringify(v1access)}`);
    console.log(`(c) verify t1refresh = ${JSON.stringify(v1refresh)}`);
    console.log(`(c) verify t2access = ${JSON.stringify(v2access)}`);
    assert.deepEqual(v1access, { ok: false, reason: 'revoked' });
    assert.deepEqual(v1refresh, { ok: false, reason: 'revoked' });
    assert.equal(v2access.ok, true, 'a token under an unrelated grant must still verify');

    const rows = getConnection()
      .prepare(
        'SELECT id, grant_id, revoked_at FROM access_tokens WHERE grant_id IN (?, ?) ORDER BY id'
      )
      .all(g1, g2) as { id: number; grant_id: number; revoked_at: string | null }[];
    console.log(
      `(c) revoked_at readings = ${rows.map((row) => `${row.id}(g${row.grant_id})=${row.revoked_at}`).join(', ')}`
    );
    assert.ok(
      rows.filter((row) => row.grant_id === g1).every((row) => row.revoked_at !== null),
      'both tokens under the revoked grant must be stamped revoked_at'
    );
    assert.ok(
      rows.filter((row) => row.grant_id === g2).every((row) => row.revoked_at === null),
      'the other grant’s token must be untouched'
    );
  });
});

test('(d) disabling a client cascades every grant and every token under it', async () => {
  await withOAuthDatabase(async ({ store, userId }) => {
    const c1 = store.registerClient({
      clientName: 'disabled-client',
      redirectUris: ['https://a.test/cb'],
      metadata: {},
      createdVia: 'manual',
    }).clientId;
    const c2 = store.registerClient({
      clientName: 'live-client',
      redirectUris: ['https://b.test/cb'],
      metadata: {},
      createdVia: 'manual',
    }).clientId;

    const issue = (clientId: string): string => {
      const { grantId } = store.createGrant({
        userId,
        clientId,
        scopes: ['cloudcli:read'],
        resource: RESOURCE,
      });
      return store.issueOAuthToken({
        grantId,
        kind: 'oauth_access',
        scopes: ['cloudcli:read'],
        resource: RESOURCE,
        expiresAt: futureExpiry(),
      }).token;
    };

    const c1first = issue(c1);
    const c1second = issue(c1);
    const c2token = issue(c2);

    const result = store.disableClient(c1);
    console.log(`(d) disableClient(c1) = ${JSON.stringify(result)}`);
    assert.deepEqual(result, { clientDisabled: true, tokensRevoked: 2 });

    const v1first = store.verifyOAuthToken(c1first);
    const v1second = store.verifyOAuthToken(c1second);
    const v2 = store.verifyOAuthToken(c2token);
    console.log(`(d) verify c1.g1 = ${JSON.stringify(v1first)}`);
    console.log(`(d) verify c1.g2 = ${JSON.stringify(v1second)}`);
    console.log(`(d) verify c2    = ${JSON.stringify(v2)}`);
    assert.deepEqual(v1first, { ok: false, reason: 'revoked' });
    assert.deepEqual(v1second, { ok: false, reason: 'revoked' });
    assert.equal(v2.ok, true, 'the other client’s token must still verify');

    const clients = getConnection()
      .prepare('SELECT client_id, disabled_at FROM oauth_clients WHERE client_id IN (?, ?) ORDER BY client_id')
      .all(c1, c2) as { client_id: string; disabled_at: string | null }[];
    console.log(
      `(d) disabled_at readings = ${clients.map((row) => `${row.client_id}=${row.disabled_at}`).join(', ')}`
    );
    assert.ok(
      clients.find((row) => row.client_id === c1)!.disabled_at !== null,
      'the disabled client must be stamped disabled_at'
    );
    assert.equal(
      clients.find((row) => row.client_id === c2)!.disabled_at,
      null,
      'the other client must be untouched'
    );
  });
});

test('(e) migrations stay a no-op over an existing populated database and build a fresh one', async () => {
  await withOAuthDatabase(async ({ store, userId }) => {
    // Populate so idempotency is tested against real rows, not empty tables.
    const { clientId } = store.registerClient({
      clientName: 'idempotent',
      redirectUris: ['https://client.test/cb'],
      metadata: {},
      createdVia: 'manual',
    });
    const { grantId } = store.createGrant({
      userId,
      clientId,
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
    });
    store.issueOAuthToken({
      grantId,
      kind: 'oauth_access',
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
      expiresAt: futureExpiry(),
    });
    store.issueAuthorizationCode({
      clientId,
      userId,
      redirectUri: 'https://client.test/cb',
      codeChallenge: 'challenge-value',
      scopes: ['cloudcli:read'],
      resource: RESOURCE,
    });

    const before = schemaSnapshot();
    console.log(`(e) tables before = ${before.tables.join(', ')}`);
    console.log(`(e) row counts before = ${JSON.stringify(before.counts)}`);

    // Re-running the migration chain over the live, populated connection.
    runMigrations(getConnection());
    assertSnapshotUnchanged(before, 'runMigrations re-run');

    // And across a full close/reopen of the same file.
    closeConnection();
    await initializeDatabase();
    assertSnapshotUnchanged(before, 'initializeDatabase re-open');

    const after = schemaSnapshot();
    console.log(`(e) tables after  = ${after.tables.join(', ')}`);
    console.log(`(e) row counts after  = ${JSON.stringify(after.counts)}`);
  });

  // The other half of (e): a brand-new database with none of the tables builds
  // them through the same production path.
  await withOAuthDatabase(async () => {
    const tables = tableNames();
    console.log(
      `(e) fresh database tables = ${tables.filter((name) => !name.startsWith('sqlite_')).sort().join(', ')}`
    );
    for (const name of ['oauth_clients', 'oauth_grants', 'oauth_authorization_codes', 'access_tokens']) {
      assert.ok(tables.includes(name), `a fresh database must build ${name}`);
    }
    console.log(`(e) fresh access_tokens columns = ${columnNames('access_tokens').join(', ')}`);
  });
});
