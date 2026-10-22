import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { connectedClients } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Rename write-back: the app stores the name in its own database and then
 * records the same name in the provider's own store.
 *
 * Everything here runs against a real temporary `HOME` holding a real-shaped
 * transcript, a real temporary SQLite file, and the real route — the three
 * halves the write-back touches. The provider's store is reached through the
 * real SDK, so where a transcript has to sit on disk is the SDK's own rule and
 * not something this suite invents: the cases below fail if that shape drifts.
 *
 * Assertions are split so each one can redden alone. (a) reads the transcript
 * file itself, (b)/(c) read the database, and the skip cases read a whole-home
 * snapshot — so an implementation that stops writing to disk reds (a) only,
 * while one that writes unconditionally reds the skip cases only.
 */

type Harness = {
  baseUrl: string;
  /** Temporary `HOME`; the only place the provider SDK is allowed to write. */
  home: string;
  /** Temporary workspace the seeded sessions claim as their working directory. */
  workspace: string;
};

const originalHome = process.env.HOME;

/**
 * The one temporary home this process ever uses, created on first need.
 *
 * One home and not one per test, because the provider SDK resolves `~` on its
 * first use and keeps the answer for the rest of the process: a home that moved
 * between tests would send every later test to the first test's directory —
 * or, once that one was deleted, to nowhere at all. Tests separate themselves
 * by working directory instead, which is exactly what the provider's own
 * `<home>/projects/<encoded-directory>/` layout keys on.
 */
let sharedHome: string | null = null;

async function useSharedHome(): Promise<string> {
  if (!sharedHome) {
    sharedHome = await mkdtemp(path.join(os.tmpdir(), 'session-rename-writeback-home-'));
    process.env.HOME = sharedHome;
  }
  return sharedHome;
}

after(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (sharedHome) {
    await rm(sharedHome, { recursive: true, force: true });
  }
});

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

/**
 * The directory the provider SDK groups a project's transcripts under.
 *
 * Transcribed here rather than imported from the app: it is the SDK's rule, and
 * a fixture that borrowed the app's own helper would agree with a wrong
 * implementation about where a transcript lives.
 */
function providerBucket(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** One transcript line as the CLI writes it: the session id and cwd ride on every entry. */
function transcriptLine(sessionId: string, cwd: string, event: Record<string, unknown>): string {
  return JSON.stringify({ sessionId, cwd, ...event });
}

/**
 * The head of a real transcript, including an `agent-name`: the entry that
 * outranks a rename in the CLI's own title ladder, and so the reason a written
 * rename need not change the title the CLI *lists*.
 */
function transcriptHead(sessionId: string, cwd: string): string[] {
  return [
    transcriptLine(sessionId, cwd, { type: 'mode', mode: 'normal' }),
    transcriptLine(sessionId, cwd, {
      type: 'user',
      message: { role: 'user', content: 'the first thing I typed' },
    }),
    transcriptLine(sessionId, cwd, { type: 'agent-name', agentName: 'Repo Index Agent' }),
    transcriptLine(sessionId, cwd, { type: 'ai-title', aiTitle: 'Generated Title' }),
  ];
}

async function withRenameServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-rename-writeback-'));
  // The provider SDK resolves `~` from the process environment, so pointing
  // `HOME` at a temporary directory is the seam that keeps every write it makes
  // inside this suite — a seed landing in the machine's real home would let the
  // run pass while dirtying it. It is set once, process-wide: see `useSharedHome`.
  const home = await useSharedHome();
  const workspace = path.join(tempDirectory, 'workspace');
  await mkdir(workspace, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, home, workspace });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const rename = (baseUrl: string, sessionId: string, summary: string) =>
  fetch(`${baseUrl}/api/providers/sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary }),
  });

const storedRow = (sessionId: string) => {
  const row = sessionsDb.getSessionById(sessionId);
  assert.ok(row, `expected a session row for ${sessionId}`);
  return {
    name: row.custom_name,
    source: row.name_source,
    transcriptName: row.transcript_name,
    transcriptNameSource: row.transcript_name_source,
  };
};

/**
 * Seeds a session whose row points at a real transcript in the temporary home.
 *
 * The transcript is written where the provider SDK looks for it — derived from
 * the session's working directory — and the row's `jsonl_path` is that same
 * file, which is what a real scan stores.
 */
async function seedTranscriptSession(input: {
  home: string;
  workspace: string;
  sessionId: string;
  jsonlPath?: string | null;
  lines?: string[];
}): Promise<string> {
  const transcriptPath = input.jsonlPath === undefined
    ? path.join(
        input.home,
        '.claude',
        'projects',
        providerBucket(input.workspace),
        `${input.sessionId}.jsonl`,
      )
    : input.jsonlPath;
  if (transcriptPath) {
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(
      transcriptPath,
      (input.lines ?? transcriptHead(input.sessionId, input.workspace)).map((line) => `${line}\n`).join(''),
      'utf8',
    );
  }

  sessionsDb.createSession(
    input.sessionId,
    'claude',
    input.workspace,
    'the first thing I typed',
    undefined,
    undefined,
    transcriptPath,
  );
  // The transcript's own reading, which the write-back must never touch.
  sessionsDb.writeTranscriptName(input.sessionId, 'Generated Title', 'ai');

  return transcriptPath ?? '';
}

/** The `custom-title` values a transcript carries, in file order. */
async function readCustomTitles(transcriptPath: string, title: string): Promise<string[]> {
  const content = await readFile(transcriptPath, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; customTitle?: string })
    .filter((entry) => entry.type === 'custom-title' && entry.customTitle === title)
    .map((entry) => entry.customTitle as string);
}

/** Every file under `root`, keyed by relative path, with its bytes. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      snapshot.set(path.relative(root, fullPath), await readFile(fullPath, 'utf8'));
    }
  }

  await walk(root);
  return snapshot;
}

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

test('(a) a rename appends a custom-title naming the new title to the transcript', async () => {
  await withRenameServer(async ({ baseUrl, home, workspace }) => {
    const transcriptPath = await seedTranscriptSession({ home, workspace, sessionId: SESSION_ID });

    // Positive control: the file is read on both sides, so the assertion below
    // cannot be satisfied by a state that was already true.
    const before = (await readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean);
    assert.equal(
      JSON.parse(before[before.length - 1]).type,
      'ai-title',
      'the fixture must not already end in the rename it is about to receive',
    );

    const response = await rename(baseUrl, SESSION_ID, 'Renamed From The App');
    assert.equal(response.status, 200);

    const after = (await readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean);
    assert.equal(after.length, before.length + 1, 'the rename must add exactly one transcript entry');
    const appended = JSON.parse(after[after.length - 1]) as { type?: string; customTitle?: string };
    assert.equal(appended.type, 'custom-title');
    assert.equal(appended.customTitle, 'Renamed From The App');
  });
});

test('(b)(c) a rename stores the name as a manual override and leaves the transcript reading alone', async () => {
  await withRenameServer(async ({ baseUrl, home, workspace }) => {
    await seedTranscriptSession({ home, workspace, sessionId: SESSION_ID });
    assert.deepEqual(storedRow(SESSION_ID), {
      name: 'Generated Title',
      source: 'ai',
      transcriptName: 'Generated Title',
      transcriptNameSource: 'ai',
    });

    const response = await rename(baseUrl, SESSION_ID, 'Renamed From The App');
    assert.equal(response.status, 200);

    const row = storedRow(SESSION_ID);
    assert.equal(row.name, 'Renamed From The App');
    assert.equal(row.source, 'manual');
    // The reading is the transcript's own observation; a rename is a claim made
    // in this app, and the two are stored apart for exactly this reason.
    assert.equal(row.transcriptName, 'Generated Title');
    assert.equal(row.transcriptNameSource, 'ai');
  });
});

test('a session with nothing to write to is renamed in the app and writes no file anywhere', async () => {
  await withRenameServer(async ({ baseUrl, home, workspace }) => {
    // 1. A row whose `jsonl_path` was never recorded, while a transcript exists
    //    at the exact place the provider would look for *that row's own* session.
    //    The trap is the point: an implementation that wrote whenever it *could*
    //    would resolve the session by its id, find this file, and change it — so
    //    the skip has to be the row's own column, not whether a file is there.
    //    The transcript is therefore named after the row, not after some other
    //    session that merely shares the directory.
    const trapId = '22222222-3333-4444-8555-666666666666';
    const trapPath = path.join(
      home,
      '.claude',
      'projects',
      providerBucket(workspace),
      `${trapId}.jsonl`,
    );
    await mkdir(path.dirname(trapPath), { recursive: true });
    await writeFile(
      trapPath,
      transcriptHead(trapId, workspace).map((line) => `${line}\n`).join(''),
      'utf8',
    );
    sessionsDb.createSession(
      trapId,
      'claude',
      workspace,
      'no transcript recorded',
      undefined,
      undefined,
      null,
    );

    // 2. A row pointing at a file that is not there any more.
    const missingPath = path.join(home, '.claude', 'projects', providerBucket(workspace), 'gone.jsonl');
    sessionsDb.createSession(
      '33333333-4444-4555-8666-777777777777',
      'claude',
      workspace,
      'transcript already deleted',
      undefined,
      undefined,
      missingPath,
    );

    // 3. A provider that keeps no writable title, with a real file beside it.
    const codexPath = path.join(home, '.codex', 'sessions', '2026', 'rollout-1.jsonl');
    await mkdir(path.dirname(codexPath), { recursive: true });
    await writeFile(codexPath, '{"type":"session_meta"}\n', 'utf8');
    sessionsDb.createSession(
      '44444444-5555-4666-8777-888888888888',
      'codex',
      workspace,
      'another provider',
      undefined,
      undefined,
      codexPath,
    );

    const before = await snapshotTree(home);
    assert.ok(before.has(path.relative(home, trapPath)), 'the trap transcript must be in the snapshot');
    assert.ok(before.has(path.relative(home, codexPath)), 'the other provider\'s file must be in the snapshot');
    await assert.rejects(() => stat(missingPath), 'the missing transcript must really be missing');

    const renames: Array<[string, string]> = [
      [trapId, 'Renamed With No Transcript'],
      ['33333333-4444-4555-8666-777777777777', 'Renamed With A Missing Transcript'],
      ['44444444-5555-4666-8777-888888888888', 'Renamed On Another Provider'],
    ];
    for (const [sessionId, summary] of renames) {
      const response = await rename(baseUrl, sessionId, summary);
      assert.equal(response.status, 200, `expected 200 for ${sessionId}`);
      const row = storedRow(sessionId);
      assert.equal(row.name, summary);
      assert.equal(row.source, 'manual');
    }

    // Every file and every byte under the temporary home, not just the three
    // paths above: a write to some *other* location is the same defect.
    assert.deepEqual(await snapshotTree(home), before);
  });
});

test('renaming a session twice to the same name leaves every reading but the transcript count identical', async () => {
  await withRenameServer(async ({ baseUrl, home, workspace }) => {
    const transcriptPath = await seedTranscriptSession({ home, workspace, sessionId: SESSION_ID });

    assert.equal((await rename(baseUrl, SESSION_ID, 'Renamed Twice')).status, 200);
    const afterFirst = storedRow(SESSION_ID);
    const firstCount = (await readCustomTitles(transcriptPath, 'Renamed Twice')).length;

    assert.equal((await rename(baseUrl, SESSION_ID, 'Renamed Twice')).status, 200);
    const afterSecond = storedRow(SESSION_ID);
    const secondCount = (await readCustomTitles(transcriptPath, 'Renamed Twice')).length;

    assert.deepEqual(afterSecond, afterFirst);
    assert.equal(secondCount >= firstCount, true, 'the transcript must not lose an entry it already had');

    // Recorded as a reading rather than asserted as an invariant: the provider's
    // own rename appends unconditionally, so a repeated identical rename adds
    // one more entry carrying the same title. The name the provider reads back
    // is unchanged either way — the CLI takes the last `custom-title` — and this
    // is the known shape, not a silently-tolerated failure.
    console.log(
      `[rename-writeback] custom-title entries for "Renamed Twice": after 1st rename = ${firstCount}, after 2nd = ${secondCount}`,
    );
  });
});
