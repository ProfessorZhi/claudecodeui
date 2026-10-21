import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const root = mkdtempSync(path.join(os.tmpdir(), 'pending-session-migration-'));
process.env.DATABASE_PATH = path.join(root, 'legacy.db');
const db = await import('../index.js');
await db.initializeDatabase();
after(() => db.closeConnection());

test('real process restart preserves unstarted app-only NULL native ids and known native identities', () => {
  const childRoot = path.join(root, 'processes'); mkdirSync(childRoot);
  const fixture = fileURLToPath(new URL('./fixtures/pending-session-process.ts', import.meta.url));
  const child = (phase: string) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', fixture, phase, childRoot], { env: process.env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT:'))!.slice(7));
  };
  const written = child('write'); const read = child('read');
  assert.notEqual(written.pid, read.pid);
  assert.deepEqual(read.rows, [
    { session_id: 'bound-app', provider_session_id: 'real-native-bound' },
    { session_id: 'discovered-native', provider_session_id: 'discovered-native' },
    { session_id: 'pending-claude', provider_session_id: null },
    { session_id: 'pending-codex', provider_session_id: null },
  ]);
});

test('actual absent-column legacy migration backfills once and repeated boot preserves later app-only rows', () => {
  db.sessionsDb.createSession('legacy-native', 'claude', root);
  db.getConnection().exec('DROP INDEX IF EXISTS idx_sessions_provider_session_id');
  db.getConnection().exec('ALTER TABLE sessions DROP COLUMN provider_session_id');
  db.runMigrations(db.getConnection());
  assert.equal(db.sessionsDb.getSessionById('legacy-native')!.provider_session_id, 'legacy-native');
  db.sessionsDb.createAppSession('new-after-legacy', 'codex', root);
  db.runMigrations(db.getConnection());
  assert.equal(db.sessionsDb.getSessionById('legacy-native')!.provider_session_id, 'legacy-native');
  assert.equal(db.sessionsDb.getSessionById('new-after-legacy')!.provider_session_id, null);
});
