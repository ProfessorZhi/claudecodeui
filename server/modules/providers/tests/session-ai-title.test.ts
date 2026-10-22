import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { readSessionAiTitle } from '@/modules/providers/index.js';

const SESSION_ID = 'claude-ai-title-1';
const APP_SESSION_ID = 'app-ai-title-1';
const OTHER_SESSION_ID = 'claude-ai-title-other';
const PROVIDER_SESSION_ID = 'claude-ai-title-provider';

/**
 * Bytes this process has read since it started, straight from the kernel.
 *
 * The point of reading a title on demand is that it costs a prefix of the
 * transcript, not the transcript. Measuring the process needs no test-only
 * seam, so the bound stays true for whatever reader replaces this one, and it
 * is the resource actually spent that is bounded rather than a proxy for it.
 */
const bytesRead = (): number => {
  const match = readFileSync('/proc/self/io', 'utf8').match(/^rchar:\s*(\d+)$/m);
  assert.ok(match, 'this measurement needs /proc/self/io');
  return Number(match[1]);
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-ai-title-db-'));

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

/**
 * Runs one case against a fresh temp database and transcript directory. The
 * transcript's path is fixed after the callback builds the row, so the tests
 * can point a row at a file, at nothing, or at a file that fails later.
 */
async function withTranscripts(
  runTest: (context: { workspacePath: string; transcriptPath: (name?: string) => string }) => Promise<void>,
): Promise<void> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'session-ai-title-home-'));

  try {
    await runTest({
      workspacePath,
      transcriptPath: (name = SESSION_ID) => path.join(workspacePath, `${name}.jsonl`),
    });
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

/**
 * One transcript line as Claude writes it: `sessionId` and `cwd` repeat on
 * every entry, and the title arrives as its own `ai-title` entry.
 */
const transcriptLine = (sessionId: string, cwd: string, event: Record<string, unknown>): string =>
  JSON.stringify({ sessionId, cwd, ...event });

const aiTitleLine = (sessionId: string, cwd: string, aiTitle: string): string =>
  transcriptLine(sessionId, cwd, { type: 'ai-title', aiTitle });

const headLines = (sessionId: string, cwd: string): string[] => [
  transcriptLine(sessionId, cwd, { type: 'mode', mode: 'normal' }),
  transcriptLine(sessionId, cwd, { type: 'permission-mode', permissionMode: 'default' }),
  transcriptLine(sessionId, cwd, {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: 'first prompt' },
    uuid: 'msg-1',
  }),
];

/** A filler entry of roughly `size` bytes, of the shape a long session holds. */
const fillerLine = (sessionId: string, cwd: string, size: number): string =>
  transcriptLine(sessionId, cwd, {
    type: 'assistant',
    uuid: `filler-${size}`,
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(size) }] },
  });

// ---------------------------------------------------------------------------
// Both id shapes resolve to the same transcript
// ---------------------------------------------------------------------------

test('an app session reads the ai-title its transcript carries', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath(),
      [
        ...headLines(PROVIDER_SESSION_ID, workspacePath),
        aiTitleLine(PROVIDER_SESSION_ID, workspacePath, 'Generated From The Chat'),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      // The app allocated the session and only later learned the provider's id,
      // so `session_id` and `provider_session_id` differ — the case the reader
      // must resolve through the mapping rather than by primary key.
      sessionsDb.createAppSession(APP_SESSION_ID, 'claude', workspacePath, 'first prompt');
      sessionsDb.assignProviderSessionId(APP_SESSION_ID, PROVIDER_SESSION_ID);
      // The next indexer pass is what records the transcript against that row;
      // an app session holds no path until then.
      sessionsDb.createSession(
        PROVIDER_SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      const row = sessionsDb.getSessionById(APP_SESSION_ID);
      assert.equal(row?.provider_session_id, PROVIDER_SESSION_ID);
      assert.equal(row?.jsonl_path, transcriptPath());

      assert.equal(await readSessionAiTitle(APP_SESSION_ID), 'Generated From The Chat');
      // The provider id resolves to the same row, and so to the same title.
      assert.equal(await readSessionAiTitle(PROVIDER_SESSION_ID), 'Generated From The Chat');
    });
  });
});

test('a CLI session reads the ai-title its transcript carries', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath(),
      [
        ...headLines(SESSION_ID, workspacePath),
        aiTitleLine(SESSION_ID, workspacePath, 'Generated From The Chat'),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      // Disk-discovered sessions are keyed by the provider id in both columns.
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), 'Generated From The Chat');
    });
  });
});

// ---------------------------------------------------------------------------
// The generated title survives a rename — the point of the whole task
// ---------------------------------------------------------------------------

test('a manually renamed session still reports the transcript ai-title, not its stored name', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath(),
      [
        ...headLines(SESSION_ID, workspacePath),
        aiTitleLine(SESSION_ID, workspacePath, 'Generated From The Chat'),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'Generated From The Chat',
        undefined,
        undefined,
        transcriptPath(),
      );
      sessionsDb.updateSessionCustomName(SESSION_ID, 'Chosen By Hand');
      assert.deepEqual(
        { name: sessionsDb.getSessionById(SESSION_ID)?.custom_name, source: sessionsDb.getSessionById(SESSION_ID)?.name_source },
        { name: 'Chosen By Hand', source: 'manual' },
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), 'Generated From The Chat');
    });
  });
});

test('a rename recorded in the transcript does not displace the generated title', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    // Claude writes the rename's `custom-title` immediately before the matching
    // `ai-title`, so a reader that let the rename win would answer with it.
    await writeFile(
      transcriptPath(),
      [
        ...headLines(SESSION_ID, workspacePath),
        transcriptLine(SESSION_ID, workspacePath, { type: 'custom-title', customTitle: 'Renamed In The CLI' }),
        aiTitleLine(SESSION_ID, workspacePath, 'Generated From The Chat'),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'Renamed In The CLI',
        undefined,
        undefined,
        transcriptPath(),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), 'Generated From The Chat');
    });
  });
});

// ---------------------------------------------------------------------------
// Every state with no title is a null, never a throw
// ---------------------------------------------------------------------------

test('a transcript with no ai-title entry reads as null', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath(),
      [...headLines(SESSION_ID, workspacePath), fillerLine(SESSION_ID, workspacePath, 512), ''].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), null);
    });
  });
});

test('a non-Claude session reads as null even with a transcript recorded', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath(),
      [aiTitleLine(SESSION_ID, workspacePath, 'Generated From The Chat'), ''].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'codex',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), null);
    });
  });
});

test('an unknown session id reads as null', async () => {
  await withTranscripts(async () => {
    await withIsolatedDatabase(async () => {
      assert.equal(await readSessionAiTitle('no-such-session'), null);
    });
  });
});

test('a session with no transcript path reads as null', async () => {
  await withTranscripts(async ({ workspacePath }) => {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(SESSION_ID, 'claude', workspacePath, 'first prompt');

      assert.equal(await readSessionAiTitle(SESSION_ID), null);
    });
  });
});

test('a session whose transcript file is gone reads as null', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath('deleted'),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), null);
    });
  });
});

test('a transcript of malformed lines reads as null', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(transcriptPath(), ['not json at all', '{"type":', ''].join('\n'), 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), null);
    });
  });
});

// ---------------------------------------------------------------------------
// The title must belong to the session being asked about
// ---------------------------------------------------------------------------

test('another session’s ai-title is not reported', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath(),
      [
        ...headLines(SESSION_ID, workspacePath),
        // A subagent transcript repeats its parent's entries under its own id,
        // and the watcher reaches those files too.
        aiTitleLine(OTHER_SESSION_ID, workspacePath, 'Belongs To Someone Else'),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), null);
    });
  });
});

test('a foreign ai-title does not shadow this session’s later one', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    await writeFile(
      transcriptPath(),
      [
        ...headLines(SESSION_ID, workspacePath),
        aiTitleLine(OTHER_SESSION_ID, workspacePath, 'Belongs To Someone Else'),
        aiTitleLine(SESSION_ID, workspacePath, 'Generated From The Chat'),
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      assert.equal(await readSessionAiTitle(SESSION_ID), 'Generated From The Chat');
    });
  });
});

// ---------------------------------------------------------------------------
// Reading a transcript stops at the answer
// ---------------------------------------------------------------------------

test('the read stops at the ai-title instead of scanning the rest of the transcript', async () => {
  await withTranscripts(async ({ workspacePath, transcriptPath }) => {
    const megabytes = 24;
    const filler = Array.from({ length: megabytes * 16 }, (_, index) =>
      fillerLine(SESSION_ID, workspacePath, 65536 + index),
    );
    // The title is on line 5, a quarter of a megabyte into a 24MB file.
    await writeFile(
      transcriptPath(),
      [
        ...headLines(SESSION_ID, workspacePath),
        aiTitleLine(SESSION_ID, workspacePath, 'Generated Early'),
        ...filler,
        '',
      ].join('\n'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath(),
      );

      const before = bytesRead();
      const title = await readSessionAiTitle(SESSION_ID);
      const spent = bytesRead() - before;
      console.log(`[reading] ai-title on line 5 of a ~${megabytes}MB transcript: bytes_read=${spent}`);

      assert.equal(title, 'Generated Early');
      assert.ok(
        spent < 4 * 1024 * 1024,
        `the title is on line 5, so a ${megabytes}MB transcript must not be read whole (read ${spent} bytes)`,
      );
    });
  });
});
