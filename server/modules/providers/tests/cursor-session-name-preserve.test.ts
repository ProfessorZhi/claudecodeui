import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { CursorSessionSynchronizer } from '@/modules/providers/list/cursor/cursor-session-synchronizer.provider.js';

const SESSION_ID = 'cursor-session-1';
const PROJECT_PATH = '/workspace/cursor-project';
/** What the user typed first, and therefore what the scan names the session. */
const FIRST_LINE = 'How do I index a repo?';
const RENAMED = 'Renamed In The Sidebar';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'cursor-name-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
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

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

/**
 * One Cursor chat on disk: the project's `worker.log` (which carries the
 * workspace path the scan reads) and the chat transcript below it, at the
 * depth `processSessionFile` expects for that log to be found.
 */
async function writeCursorChat(cursorHome: string): Promise<string> {
  const projectDirectory = path.join(cursorHome, 'projects', 'cursor-project');
  const chatDirectory = path.join(projectDirectory, 'chat-1', 'bubble-1');
  await mkdir(chatDirectory, { recursive: true });
  await writeFile(
    path.join(projectDirectory, 'worker.log'),
    `2026-07-10 00:00:00 info workspacePath=${PROJECT_PATH}\n`,
    'utf8',
  );

  const transcriptPath = path.join(chatDirectory, `${SESSION_ID}.jsonl`);
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ role: 'system', message: { content: [{ type: 'text', text: 'ignored' }] } }),
      JSON.stringify({
        role: 'user',
        message: {
          content: [{
            type: 'text',
            text: `<timestamp>2026-07-10T00:00:00.000Z</timestamp><user_query>${FIRST_LINE}\nand a second line</user_query>`,
          }],
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  return transcriptPath;
}

const storedName = (sessionId: string): { name: string | null; source: string | null } => {
  const row = getConnection()
    .prepare('SELECT custom_name AS name, name_source AS source FROM sessions WHERE session_id = ?')
    .get(sessionId) as { name: string | null; source: string | null } | undefined;
  assert.ok(row, `session ${sessionId} must exist`);
  return row;
};

/**
 * What the scanner's upsert writes when nothing outranks anything: the last
 * name seen on disk wins, whatever the row already held.
 *
 * The test below runs this *after* proving the real path preserves the rename,
 * as the control that says why it was preserved. Without it the assertion
 * would also hold for a fixture that never reaches a conflicting write — this
 * shows the conflicting write does land, and on the same value, so the
 * precedence is the only thing standing between the rename and the overwrite.
 */
const upsertIgnoringPrecedence = (providerSessionId: string, name: string): void => {
  getConnection()
    .prepare(
      `UPDATE sessions SET custom_name = ?
       WHERE provider_session_id = ? AND provider = 'cursor'`
    )
    .run(name, providerSessionId);
};

test('a renamed Cursor session keeps its name when its transcript is scanned again', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cursor-name-home-'));
  const cursorHome = path.join(temporaryRoot, '.cursor');
  await mkdir(cursorHome, { recursive: true });
  const restoreHomeDir = patchHomeDir(temporaryRoot);

  try {
    const transcriptPath = await writeCursorChat(cursorHome);

    await withIsolatedDatabase(async () => {
      const synchronizer = new CursorSessionSynchronizer();

      // Discovered on disk, named from the first line the user typed.
      const first = await synchronizer.synchronizeFile(transcriptPath);
      assert.equal(first, SESSION_ID);
      assert.deepEqual(storedName(SESSION_ID), { name: FIRST_LINE, source: 'derived' });
      // Captured while it is on the row: this is the name the scan would write
      // again on the next pass, and the value the control writes below.
      const scannedName = storedName(SESSION_ID).name;
      assert.equal(scannedName, FIRST_LINE);

      // Renamed through the same service the sidebar route calls.
      await sessionsService.renameSessionById(SESSION_ID, RENAMED);
      assert.deepEqual(storedName(SESSION_ID), { name: RENAMED, source: 'manual' });

      // The transcript changes, the watcher scans it again.
      const later = new Date(Date.now() + 60_000);
      await utimes(transcriptPath, later, later);
      const second = await synchronizer.synchronizeFile(transcriptPath);

      assert.equal(second, SESSION_ID);
      assert.deepEqual(
        storedName(SESSION_ID),
        { name: RENAMED, source: 'manual' },
        'a rescan must not overwrite a name the user chose',
      );

      // Control: the same write the scan makes, with the precedence removed.
      upsertIgnoringPrecedence(SESSION_ID, scannedName!);
      assert.deepEqual(
        storedName(SESSION_ID),
        { name: FIRST_LINE, source: 'manual' },
        'the scan really does reach this row with a competing name',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
