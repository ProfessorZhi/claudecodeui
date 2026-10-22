import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const SESSION_ID = 'claude-title-source-1';
const APP_SESSION_ID = 'app-title-source-1';

/**
 * Bytes this process has read since it started, straight from the kernel.
 *
 * Reading a session's title means reading part of a transcript, and the whole
 * point of the streaming reader is that "part" does not grow with the file.
 * Measuring the process beats a test-only seam in the provider: the assertion
 * stays true for whatever implementation is in place, and it is the actual
 * resource being spent that is bounded.
 */
const bytesRead = (): number => {
  const match = readFileSync('/proc/self/io', 'utf8').match(/^rchar:\s*(\d+)$/m);
  assert.ok(match, 'this measurement needs /proc/self/io');
  return Number(match[1]);
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-title-db-'));

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
 * One transcript line as Claude writes it. `sessionId` and `cwd` are repeated
 * on every entry in a real file, and the parser reads both from the first
 * entry it can parse.
 */
const transcriptLine = (sessionId: string, cwd: string, event: Record<string, unknown>): string =>
  JSON.stringify({ sessionId, cwd, ...event });

const headLines = (sessionId: string, cwd: string): string[] => [
  transcriptLine(sessionId, cwd, { type: 'mode', mode: 'normal' }),
  transcriptLine(sessionId, cwd, { type: 'permission-mode', permissionMode: 'default' }),
  transcriptLine(sessionId, cwd, {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: 'first prompt' },
    uuid: 'msg-1',
    timestamp: '2026-07-10T00:00:00.000Z',
  }),
];

/** A filler entry of roughly `size` bytes, of the shape a long session holds. */
const fillerLine = (sessionId: string, cwd: string, size: number): string =>
  transcriptLine(sessionId, cwd, {
    type: 'assistant',
    uuid: `filler-${size}`,
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(size) }] },
  });

const storedName = (sessionId: string): { name: string | null; source: string | null } => {
  const row = sessionsDb.getSessionById(sessionId);
  return { name: row?.custom_name ?? null, source: row?.name_source ?? null };
};

/**
 * Runs one synchronizer pass over a transcript and reports what it cost.
 *
 * The readings are printed rather than only asserted: a bound that holds is
 * only evidence if the number behind it is visible, and these are the numbers
 * the task's Evidence records.
 */
async function syncOnce(
  synchronizer: ClaudeSessionSynchronizer,
  transcriptPath: string,
  label: string,
): Promise<number> {
  const before = bytesRead();
  const result = await synchronizer.synchronizeFile(transcriptPath);
  const spent = bytesRead() - before;
  console.log(`[reading] ${label}: bytes_read=${spent}`);
  assert.ok(result, `${label}: the transcript must be indexed`);
  return spent;
}

async function withClaudeHome(
  runTest: (context: { claudeHome: string; workspacePath: string; transcriptPath: string }) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-title-home-'));
  const workspacePath = path.join(temporaryRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const claudeHome = path.join(temporaryRoot, '.claude');
  await mkdir(claudeHome, { recursive: true });
  // An empty history.jsonl keeps the fallback out of the way; the transcripts
  // below are the only naming source under test.
  await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');
  const restoreHomeDir = patchHomeDir(temporaryRoot);

  try {
    await runTest({
      claudeHome,
      workspacePath,
      transcriptPath: path.join(workspacePath, `${SESSION_ID}.jsonl`),
    });
  } finally {
    restoreHomeDir();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Which name a transcript gives a session, and how authoritative it is
// ---------------------------------------------------------------------------

test('an app session takes up the ai-title its transcript later gains', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [...headLines(SESSION_ID, workspacePath), ''].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      // The app names the session from its first message before any provider
      // run, and the transcript that shows up is the one holding that message.
      sessionsDb.createAppSession(APP_SESSION_ID, 'claude', workspacePath, 'first prompt');
      sessionsDb.assignProviderSessionId(APP_SESSION_ID, SESSION_ID);

      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'app session, no title yet');
      assert.deepEqual(storedName(APP_SESSION_ID), { name: 'first prompt', source: 'derived' });

      // Claude names the session as the conversation goes on.
      await appendFile(
        transcriptPath,
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated From The Chat' }) + '\n',
        'utf8',
      );

      await syncOnce(synchronizer, transcriptPath, 'app session, ai-title added');
      assert.deepEqual(storedName(APP_SESSION_ID), {
        name: 'Generated From The Chat',
        source: 'ai',
      });
    });
  });
});

test('a disk-discovered session takes up the ai-title over its derived name', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    // The `last-prompt` entry is what the session used to be named after; the
    // first prompt is what the CLI names it after, and both are here so the
    // assertion says which one the row took rather than only that it took one.
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'last-prompt', lastPrompt: 'the last thing I typed' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'cli session, no title entries');
      assert.deepEqual(storedName(SESSION_ID), {
        name: 'first prompt',
        source: 'derived',
      });

      await appendFile(
        transcriptPath,
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated From The Chat' }) + '\n',
        'utf8',
      );

      await syncOnce(synchronizer, transcriptPath, 'cli session, ai-title added');
      assert.deepEqual(storedName(SESSION_ID), {
        name: 'Generated From The Chat',
        source: 'ai',
      });
    });
  });
});

test('a renamed session keeps its name when the transcript carries an ai-title', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated From The Chat' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(SESSION_ID, 'claude', workspacePath, 'first prompt');
      sessionsDb.updateSessionCustomName(SESSION_ID, 'Chosen By Hand');

      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'renamed session with an ai-title on disk');

      assert.deepEqual(storedName(SESSION_ID), { name: 'Chosen By Hand', source: 'manual' });
    });
  });
});

test('a transcript custom-title records the rename as manual', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'custom-title', customTitle: 'Renamed In The CLI' }),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated From The Chat' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'transcript with a custom-title');

      assert.deepEqual(storedName(SESSION_ID), { name: 'Renamed In The CLI', source: 'manual' });
    });
  });
});

test('a session already named by an ai-title takes up the one written later', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'The First Title' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'first pass names the session');
      assert.deepEqual(storedName(SESSION_ID), { name: 'The First Title', source: 'ai' });

      // Claude re-titles the session as the conversation goes on. The row is
      // already named by an ai-title, and it still has to change: a name that
      // is never re-read is a name that goes stale the moment Claude revises
      // the title it wrote, which it does on every round of a long session.
      const megabytes = 8;
      const filler = Array.from({ length: megabytes * 16 }, (_, index) =>
        fillerLine(SESSION_ID, workspacePath, 65536 + index),
      );
      await writeFile(
        transcriptPath,
        [
          ...headLines(SESSION_ID, workspacePath),
          transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'A Title Written Later' }),
          ...filler,
          '',
        ].join('\n'),
        'utf8',
      );

      const spent = await syncOnce(synchronizer, transcriptPath, 'second pass over a title already known');

      assert.deepEqual(storedName(SESSION_ID), { name: 'A Title Written Later', source: 'ai' });
      // Re-reading the title still costs a bounded window at each end of the
      // file rather than the file: the title sits near the head and the tail
      // holds none, so both windows are paid for and neither grows with the
      // transcript.
      assert.ok(
        spent < 4 * 1024 * 1024,
        `re-reading a title must not read ~${megabytes}MB (read ${spent} bytes)`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Reading a transcript stops at the answer
// ---------------------------------------------------------------------------

test('a title near the head of a huge transcript is found without reading the file', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    const megabytes = 24;
    const filler = Array.from({ length: megabytes * 16 }, (_, index) =>
      fillerLine(SESSION_ID, workspacePath, 65536 + index),
    );
    // The title is on line 5, a quarter of the way into nothing, and the tail
    // of the file is a wall of filler: the window that answers is the head one.
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated Early' }),
        ...filler,
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const spent = await syncOnce(synchronizer, transcriptPath, `ai-title on line 5 of a ~${megabytes}MB file`);

      assert.deepEqual(storedName(SESSION_ID), { name: 'Generated Early', source: 'ai' });
      assert.ok(
        spent < 4 * 1024 * 1024,
        `the title is on line 5, so a ${megabytes}MB transcript must not be read whole (read ${spent} bytes)`,
      );
    });
  });
});

test('a transcript with no title entries is named after its first prompt, not its last', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    const filler = Array.from({ length: 4096 }, (_, index) =>
      fillerLine(SESSION_ID, workspacePath, 1024 + index),
    );
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        ...filler,
        // Three different strings, so the assertion says which one the name
        // came from: the first thing the user typed, the last thing the CLI
        // recorded, and a later message of the user's.
        transcriptLine(SESSION_ID, workspacePath, {
          parentUuid: 'msg-1',
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: 'the second thing I typed' },
          uuid: 'msg-2',
        }),
        transcriptLine(SESSION_ID, workspacePath, { type: 'last-prompt', lastPrompt: 'the last thing I typed' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'no title entries at all');

      assert.deepEqual(storedName(SESSION_ID), {
        name: 'first prompt',
        source: 'derived',
      });
    });
  });
});

test('a metadata block is not mistaken for the prompt that names a session', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        // The CLI writes its own bookkeeping as `user` entries. A session named
        // after one of them would be named after XML, so the first entry that
        // is the user's own words is the one the derived name comes from.
        transcriptLine(SESSION_ID, workspacePath, {
          parentUuid: null,
          isSidechain: false,
          isMeta: true,
          type: 'user',
          message: { role: 'user', content: '<system-reminder>Context loaded</system-reminder>' },
          uuid: 'meta-1',
        }),
        transcriptLine(SESSION_ID, workspacePath, {
          parentUuid: null,
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'how do I index a repo?' }] },
          uuid: 'msg-1',
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'metadata entry before the first prompt');

      assert.deepEqual(storedName(SESSION_ID), {
        name: 'how do I index a repo?',
        source: 'derived',
      });
    });
  });
});
