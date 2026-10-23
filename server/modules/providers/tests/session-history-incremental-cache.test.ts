import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  ClaudeSessionsProvider,
  getClaudeTranscriptParseBytes,
} from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { createSessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';

/**
 * Criterion for AC-211: the server transcript cache must resume an append from
 * the byte offset it already parsed instead of re-reading the whole JSONL, and
 * the incremental result must be deeply equal to a fresh full parse.
 *
 * Every case runs the real cache service against the real Claude provider and a
 * real JSONL transcript fixture — nothing mocks the filesystem, and the byte
 * count comes from the provider's own read accounting.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-incremental-db-'));

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

/** One transcript row, linked into the uuid chain the reader walks. */
type ClaudeFixtureRow = {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  message: { role: 'user' | 'assistant'; content: unknown[] };
};

function fixtureRowBase(
  sessionId: string,
  type: 'user' | 'assistant',
  ordinal: number,
  content: unknown[],
): ClaudeFixtureRow {
  return {
    type,
    uuid: `row-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `row-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role: type, content },
  };
}

function textRow(sessionId: string, role: 'user' | 'assistant', text: string, ordinal: number): ClaudeFixtureRow {
  return fixtureRowBase(sessionId, role, ordinal, [{ type: 'text', text }]);
}

function toolUseRow(sessionId: string, toolId: string, ordinal: number): ClaudeFixtureRow {
  return fixtureRowBase(sessionId, 'assistant', ordinal, [
    { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'echo hi' } },
  ]);
}

function toolResultRow(sessionId: string, toolId: string, content: string, ordinal: number): ClaudeFixtureRow {
  return fixtureRowBase(sessionId, 'user', ordinal, [
    { type: 'tool_result', tool_use_id: toolId, content },
  ]);
}

/** Serializes rows as the CLI does: one JSON object per newline-terminated line. */
function serialize(rows: ClaudeFixtureRow[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

/** Wires a real provider read for one session through the real cache. */
function providerLoader(provider: ClaudeSessionsProvider, sessionId: string, projectPath: string) {
  return () => provider.fetchHistory(sessionId, {
    limit: null,
    offset: 0,
    projectPath,
    providerSessionId: sessionId,
  });
}

test('an appended transcript parses only the tail and matches a full parse', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-incremental-'));
  const sessionId = 'incremental-append-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      await writeFile(
        transcriptPath,
        serialize([
          textRow(sessionId, 'user', 'first question', 0),
          toolUseRow(sessionId, 'tool-1', 1),
        ]),
        'utf8',
      );
      sessionsDb.createSession(
        sessionId,
        'claude',
        transcriptDirectory,
        'Incremental cache conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        transcriptPath,
      );

      const provider = new ClaudeSessionsProvider();
      const cache = createSessionHistoryCache();
      const loadFull = providerLoader(provider, sessionId, transcriptDirectory);

      // Cold read: the whole file is parsed, and the whole file is what is counted.
      const cold = await cache.getFullHistory({ sessionId, transcriptPath, loadFull });
      assert.equal(cold?.total, 2);
      assert.equal(getClaudeTranscriptParseBytes(), (await stat(transcriptPath)).size);

      // A tool result that folds back onto the cached call, plus a new turn.
      const appended = serialize([
        toolResultRow(sessionId, 'tool-1', 'tool output', 2),
        textRow(sessionId, 'assistant', 'all done', 3),
      ]);
      await appendFile(transcriptPath, appended, 'utf8');

      const incremental = await cache.getFullHistory({ sessionId, transcriptPath, loadFull });
      const tailBytes = getClaudeTranscriptParseBytes();
      const appendedBytes = Buffer.byteLength(appended, 'utf8');
      const grownSize = (await stat(transcriptPath)).size;

      // (a) only the appended tail was parsed, not the whole grown file.
      assert.ok(
        tailBytes <= appendedBytes + 64,
        `expected <= ${appendedBytes + 64} bytes parsed, got ${tailBytes}`,
      );
      assert.ok(tailBytes < grownSize, `expected fewer than the ${grownSize}-byte file, got ${tailBytes}`);

      // (b) incrementally-merged history equals a fresh whole-file parse.
      const controlCache = createSessionHistoryCache();
      const full = await controlCache.getFullHistory({ sessionId, transcriptPath, loadFull });
      assert.deepEqual(incremental, full);

      // (c) the appended tool result folded onto the earlier cached call.
      const call = incremental?.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'tool-1');
      assert.equal(call?.toolResult?.content, 'tool output');
      assert.equal(call?.toolResult?.isError, false);
      assert.equal(incremental?.total, 3);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('a truncated transcript falls back to a full parse instead of the stale cache', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-incremental-'));
  const sessionId = 'incremental-truncate-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      await writeFile(
        transcriptPath,
        serialize([
          textRow(sessionId, 'user', 'one', 0),
          textRow(sessionId, 'assistant', 'two', 1),
          textRow(sessionId, 'user', 'three', 2),
          textRow(sessionId, 'assistant', 'four', 3),
        ]),
        'utf8',
      );
      sessionsDb.createSession(sessionId, 'claude', transcriptDirectory, 'Truncation', undefined, undefined, transcriptPath);

      const provider = new ClaudeSessionsProvider();
      const cache = createSessionHistoryCache();
      const loadFull = providerLoader(provider, sessionId, transcriptDirectory);

      const cold = await cache.getFullHistory({ sessionId, transcriptPath, loadFull });
      assert.equal(cold?.total, 4);

      // Rewrite with fewer rows: the file shrinks, so the resume must be refused.
      await writeFile(
        transcriptPath,
        serialize([
          textRow(sessionId, 'user', 'one', 0),
          textRow(sessionId, 'assistant', 'two', 1),
        ]),
        'utf8',
      );

      const afterTruncate = await cache.getFullHistory({ sessionId, transcriptPath, loadFull });
      const truncatedSize = (await stat(transcriptPath)).size;
      assert.equal(getClaudeTranscriptParseBytes(), truncatedSize, 'truncation must re-parse the whole file');
      assert.equal(afterTruncate?.total, 2);

      const controlCache = createSessionHistoryCache();
      const full = await controlCache.getFullHistory({ sessionId, transcriptPath, loadFull });
      assert.deepEqual(afterTruncate, full);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('a rewritten prefix falls back to a full parse instead of the stale cache', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-incremental-'));
  const sessionId = 'incremental-rewrite-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      await writeFile(
        transcriptPath,
        serialize([
          textRow(sessionId, 'user', 'original question', 0),
          textRow(sessionId, 'assistant', 'original answer', 1),
        ]),
        'utf8',
      );
      sessionsDb.createSession(sessionId, 'claude', transcriptDirectory, 'Rewrite', undefined, undefined, transcriptPath);

      const provider = new ClaudeSessionsProvider();
      const cache = createSessionHistoryCache();
      const loadFull = providerLoader(provider, sessionId, transcriptDirectory);

      await cache.getFullHistory({ sessionId, transcriptPath, loadFull });

      // Rewrite an early row AND append: the file only grows, so size and mtime
      // alone would look like a clean append — the boundary digest is what
      // catches the rewrite.
      await writeFile(
        transcriptPath,
        serialize([
          textRow(sessionId, 'user', 'REWRITTEN question', 0),
          textRow(sessionId, 'assistant', 'original answer', 1),
          textRow(sessionId, 'user', 'appended turn', 2),
        ]),
        'utf8',
      );

      const afterRewrite = await cache.getFullHistory({ sessionId, transcriptPath, loadFull });
      const rewrittenSize = (await stat(transcriptPath)).size;
      assert.equal(getClaudeTranscriptParseBytes(), rewrittenSize, 'a prefix rewrite must re-parse the whole file');
      assert.deepEqual(
        afterRewrite?.messages.map((message) => message.content),
        ['REWRITTEN question', 'original answer', 'appended turn'],
      );

      const controlCache = createSessionHistoryCache();
      const full = await controlCache.getFullHistory({ sessionId, transcriptPath, loadFull });
      assert.deepEqual(afterRewrite, full);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('an mtime that moves backward falls back to a full parse', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-incremental-'));
  const sessionId = 'incremental-mtime-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      await writeFile(
        transcriptPath,
        serialize([textRow(sessionId, 'user', 'one', 0)]),
        'utf8',
      );
      sessionsDb.createSession(sessionId, 'claude', transcriptDirectory, 'Mtime', undefined, undefined, transcriptPath);

      const provider = new ClaudeSessionsProvider();
      const cache = createSessionHistoryCache();
      const loadFull = providerLoader(provider, sessionId, transcriptDirectory);

      await cache.getFullHistory({ sessionId, transcriptPath, loadFull });

      // The file grows, but its mtime is rolled back past the cached read.
      await appendFile(transcriptPath, serialize([textRow(sessionId, 'assistant', 'two', 1)]), 'utf8');
      const past = new Date(Date.UTC(2000, 0, 1));
      await utimes(transcriptPath, past, past);

      const after = await cache.getFullHistory({ sessionId, transcriptPath, loadFull });
      assert.equal(getClaudeTranscriptParseBytes(), (await stat(transcriptPath)).size, 'a backward mtime must re-parse the whole file');
      assert.equal(after?.total, 2);

      const controlCache = createSessionHistoryCache();
      const full = await controlCache.getFullHistory({ sessionId, transcriptPath, loadFull });
      assert.deepEqual(after, full);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('concurrent reads of one session share a single parse', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-incremental-'));
  const sessionId = 'incremental-concurrent-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      await writeFile(
        transcriptPath,
        serialize([
          textRow(sessionId, 'user', 'one', 0),
          textRow(sessionId, 'assistant', 'two', 1),
        ]),
        'utf8',
      );
      sessionsDb.createSession(sessionId, 'claude', transcriptDirectory, 'Concurrent', undefined, undefined, transcriptPath);

      const provider = new ClaudeSessionsProvider();
      const cache = createSessionHistoryCache();
      const read = providerLoader(provider, sessionId, transcriptDirectory);
      let loads = 0;
      const loadFull = () => {
        loads += 1;
        return read();
      };

      const [first, second] = await Promise.all([
        cache.getFullHistory({ sessionId, transcriptPath, loadFull }),
        cache.getFullHistory({ sessionId, transcriptPath, loadFull }),
      ]);

      assert.equal(loads, 1);
      assert.equal(second, first);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});
