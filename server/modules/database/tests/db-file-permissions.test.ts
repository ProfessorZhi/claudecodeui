import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/index.js';

const posixOnly = { skip: process.platform === 'win32' };

async function withDatabasePath(
  run: (dbPath: string) => Promise<void>,
  seed?: (dbPath: string) => Promise<void>,
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'db-perms-'));
  const dbPath = path.join(dir, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await seed?.(dbPath);
  try {
    await run(dbPath);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const modeOf = async (file: string) => (await stat(file)).mode & 0o777;

test('a newly created auth.db is 0600', posixOnly, async () => {
  await withDatabasePath(async (dbPath) => {
    getConnection();
    assert.equal(await modeOf(dbPath), 0o600);
  });
});

test('an existing 0644 auth.db is tightened to 0600 on open', posixOnly, async () => {
  await withDatabasePath(
    async (dbPath) => {
      getConnection();
      assert.equal(await modeOf(dbPath), 0o600);
    },
    async (dbPath) => {
      await writeFile(dbPath, '');
      await chmod(dbPath, 0o644);
    },
  );
});
