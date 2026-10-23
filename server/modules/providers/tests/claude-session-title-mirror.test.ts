import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

/**
 * The title ladder the Claude Code CLI itself displays, one case per entry
 * type, asserted against the name this app stores for the session.
 *
 * The entries below are shapes taken from real transcripts rather than the
 * smallest JSON that parses: `mode` / `permission-mode` bookkeeping lines, the
 * user entry that carries the first prompt, and — for the revision cases — the
 * repeated `ai-title` / `last-prompt` entries the CLI rewrites on every round.
 * A reader can agree with the CLI on the minimal shape and still disagree on a
 * real file, and it is the real file the ladder has to mirror.
 *
 * Each case is reddenable on its own: its fixture holds two or three *different*
 * strings drawn from the entry types under test, so the assertion names which
 * one the row took instead of only that it took one.
 */

const SESSION_ID = 'claude-title-mirror-1';

/**
 * Bytes this process has read since it started, straight from the kernel.
 *
 * The byte-bound cases below assert on what a sync actually spent, so the
 * measurement has to be the real one: a seam that counts the reader's own reads
 * would stay green for an implementation that reads the file another way first.
 */
const bytesRead = (): number => {
  const match = readFileSync('/proc/self/io', 'utf8').match(/^rchar:\s*(\d+)$/m);
  assert.ok(match, 'this measurement needs /proc/self/io');
  return Number(match[1]);
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-title-mirror-db-'));

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

/** One transcript line as Claude writes it: the id and cwd ride on every entry. */
const transcriptLine = (sessionId: string, cwd: string, event: Record<string, unknown>): string =>
  JSON.stringify({ sessionId, cwd, ...event });

/**
 * The head of a real transcript: the bookkeeping entries the CLI opens with,
 * then the user entry holding the first prompt.
 */
const headLines = (sessionId: string, cwd: string, firstPrompt = 'first prompt'): string[] => [
  transcriptLine(sessionId, cwd, { type: 'mode', mode: 'normal' }),
  transcriptLine(sessionId, cwd, { type: 'permission-mode', permissionMode: 'default' }),
  transcriptLine(sessionId, cwd, {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: firstPrompt },
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

/** Runs one synchronizer pass and prints what the read cost. */
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
  runTest: (context: { workspacePath: string; transcriptPath: string }) => Promise<void>,
  sessionId = SESSION_ID,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-title-mirror-home-'));
  const workspacePath = path.join(temporaryRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const claudeHome = path.join(temporaryRoot, '.claude');
  await mkdir(claudeHome, { recursive: true });
  // Empty, so the only naming source in play is the transcript under test.
  await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');
  const restoreHomeDir = patchHomeDir(temporaryRoot);

  try {
    await runTest({
      workspacePath,
      transcriptPath: path.join(workspacePath, `${sessionId}.jsonl`),
    });
  } finally {
    restoreHomeDir();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The ladder: one case per rung and per revision rule
// ---------------------------------------------------------------------------

test('two ai-titles for one session resolve to the later one', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        // What a round of a continuing conversation appends: the CLI rewrites
        // `last-prompt, custom-title, ai-title` together on every one of them,
        // so a real file holds the same title entry again and again and the
        // last one is the title it currently displays.
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'last-prompt',
          lastPrompt: 'how do I index a repo?',
        }),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'The First Draft' }),
        fillerLine(SESSION_ID, workspacePath, 4096),
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'last-prompt',
          lastPrompt: 'and how do I search it?',
        }),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'The Revised Title' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'ai-title revised mid-file');

      assert.deepEqual(storedName(SESSION_ID), { name: 'The Revised Title', source: 'ai' });
    });
  });
});

test('a custom-title appended after an ai-title is the name', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated Title' }),
        // A `/rename` does not arrive with an `ai-title` beside it: the CLI
        // appends a lone `custom-title` at the end of the file, which is why the
        // ladder — not the order the entries appear in — has to decide.
        transcriptLine(SESSION_ID, workspacePath, { type: 'custom-title', customTitle: 'Renamed By Hand' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'custom-title after ai-title');

      assert.deepEqual(storedName(SESSION_ID), { name: 'Renamed By Hand', source: 'manual' });
    });
  });
});

test('a rename after a session was already titled takes effect on the next sync', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated Title' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'first pass, ai-title only');
      assert.deepEqual(storedName(SESSION_ID), { name: 'Generated Title', source: 'ai' });

      // The row is already named by an ai-title, and it still has to move: the
      // CLI can be renamed at any point in a session's life, so a sync that
      // treats "already titled" as "nothing to learn" misses every rename that
      // happens more than one round into the conversation.
      await appendFile(
        transcriptPath,
        transcriptLine(SESSION_ID, workspacePath, { type: 'custom-title', customTitle: 'Renamed By Hand' }) + '\n',
        'utf8',
      );

      await syncOnce(synchronizer, transcriptPath, 'second pass after the rename');
      assert.deepEqual(storedName(SESSION_ID), { name: 'Renamed By Hand', source: 'manual' });
    });
  });
});

test('an agent-name outranks a custom-title in the same transcript', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        // The two entries carry deliberately unrelated strings: with the same
        // text in both, the assertion would hold whichever rung the reader took.
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'agent-name',
          agentName: 'The Agent That Owns This',
        }),
        transcriptLine(SESSION_ID, workspacePath, { type: 'custom-title', customTitle: 'Renamed By Hand' }),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Generated Title' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'agent-name beside a custom-title');

      assert.deepEqual(storedName(SESSION_ID), {
        name: 'The Agent That Owns This',
        source: 'agent',
      });
    });
  });
});

test('an agent-name alone names the session', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'agent-name',
          agentName: 'The Agent That Owns This',
        }),
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'last-prompt',
          lastPrompt: 'the last thing I typed',
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'agent-name without any other title');

      assert.deepEqual(storedName(SESSION_ID), {
        name: 'The Agent That Owns This',
        source: 'agent',
      });
    });
  });
});

test('a transcript with no titles is named after its first prompt, not its last', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath, 'how do I index a repo?'),
        fillerLine(SESSION_ID, workspacePath, 2048),
        // Three different strings, so the assertion says which one the name came
        // from: the first thing the user typed, and two later `last-prompt`
        // entries of the kind the CLI rewrites as the conversation goes on.
        transcriptLine(SESSION_ID, workspacePath, {
          parentUuid: 'msg-1',
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: 'and how do I search it?' },
          uuid: 'msg-2',
        }),
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'last-prompt',
          lastPrompt: 'the last thing I typed',
        }),
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'last-prompt',
          lastPrompt: 'the very last thing I typed',
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await syncOnce(synchronizer, transcriptPath, 'no title entries at all');

      assert.deepEqual(storedName(SESSION_ID), {
        name: 'how do I index a repo?',
        source: 'derived',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// What a title read costs
// ---------------------------------------------------------------------------

test('a title rewritten at the end of a ~24MB transcript costs a bounded read', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    const megabytes = 24;
    const filler = Array.from({ length: megabytes * 16 }, (_, index) =>
      fillerLine(SESSION_ID, workspacePath, 65536 + index),
    );
    // Fixture A: the title entries are the last thing in the file, which is
    // where the CLI leaves a rewritten title, and everything before them is a
    // wall of conversation the read has no reason to touch.
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        ...filler,
        transcriptLine(SESSION_ID, workspacePath, {
          type: 'last-prompt',
          lastPrompt: 'and how do I search it?',
        }),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Rewritten At The End' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const spent = await syncOnce(
        synchronizer,
        transcriptPath,
        `fixture A, title entries at the tail of ~${megabytes}MB`,
      );

      assert.deepEqual(storedName(SESSION_ID), { name: 'Rewritten At The End', source: 'ai' });
      assert.ok(
        spent < 4 * 1024 * 1024,
        `a ${megabytes}MB transcript must not be read whole (read ${spent} bytes)`,
      );
    });
  });
});

test('a title written once near the head of a ~24MB transcript costs a bounded read', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    const megabytes = 24;
    const filler = Array.from({ length: megabytes * 16 }, (_, index) =>
      fillerLine(SESSION_ID, workspacePath, 65536 + index),
    );
    // Fixture B: the *same* title exists only as the early instance — a session
    // that was titled once and then grew — so the tail window holds nothing and
    // the answer can only come from the head. Neither end may fall back on
    // reading the file.
    await writeFile(
      transcriptPath,
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: 'Rewritten At The End' }),
        ...filler,
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const spent = await syncOnce(
        synchronizer,
        transcriptPath,
        `fixture B, the only instance of the title at the head of ~${megabytes}MB`,
      );

      assert.deepEqual(storedName(SESSION_ID), { name: 'Rewritten At The End', source: 'ai' });
      assert.ok(
        spent < 4 * 1024 * 1024,
        `a ${megabytes}MB transcript must not be read whole (read ${spent} bytes)`,
      );
    });
  });
});
