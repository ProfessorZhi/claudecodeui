import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTranscriptLastActivity } from '@/shared/utils.js';

/**
 * Runs one assertion against a transcript written from `lines`.
 *
 * Lines are joined with `\n` and no trailing newline, so a caller that wants a
 * terminated final record appends an empty string — the same shape a writer
 * leaves behind when it is interrupted mid-append.
 */
async function withTranscript(
  lines: string[],
  runAssertions: (filePath: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'transcript-activity-'));
  const filePath = path.join(directory, 'session.jsonl');

  try {
    await writeFile(filePath, lines.join('\n'), 'utf8');
    await runAssertions(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const record = (fields: Record<string, unknown>): string => JSON.stringify(fields);

test('skips trailing records that carry no timestamp', async () => {
  await withTranscript(
    [
      record({ type: 'user', sessionId: 's', timestamp: '2026-09-20T07:32:16.501Z' }),
      record({ type: 'assistant', sessionId: 's', timestamp: '2026-09-20T07:33:00.000Z' }),
      // What a Claude transcript actually ends on: bookkeeping rows written
      // long after the last thing the user did.
      record({ type: 'last-prompt', sessionId: 's', lastPrompt: 'carry on' }),
      record({ type: 'cost-state', sessionId: 's' }),
      record({ type: 'atis-latch', sessionId: 's' }),
      '',
    ],
    async (filePath) => {
      assert.equal(await readTranscriptLastActivity(filePath), '2026-09-20T07:33:00.000Z');
    }
  );
});

test('a half-written final record falls through to the record before it', async () => {
  await withTranscript(
    [
      record({ type: 'assistant', sessionId: 's', timestamp: '2026-09-20T07:33:00.000Z' }),
      // Truncated mid-append: both the request being written and its timestamp
      // are present, so a reader that scraped for a date instead of parsing
      // would report activity that no completed record ever recorded.
      '{"type":"user","sessionId":"s","timestamp":"2026-09-21T10:00:00.000Z","message":{"content":"trunc',
    ],
    async (filePath) => {
      assert.equal(await readTranscriptLastActivity(filePath), '2026-09-20T07:33:00.000Z');
    }
  );
});

test('returns null when no record carries a timestamp', async () => {
  await withTranscript(
    [
      record({ type: 'mode', mode: 'normal', sessionId: 's' }),
      record({ type: 'permission-mode', permissionMode: 'default', sessionId: 's' }),
      record({ type: 'last-prompt', sessionId: 's', lastPrompt: 'hello' }),
      record({ type: 'cost-state', sessionId: 's' }),
      '',
    ],
    async (filePath) => {
      assert.equal(await readTranscriptLastActivity(filePath), null);
    }
  );
});

test('returns the timestamp string the record stores, verbatim', async () => {
  // Deliberately not UTC and not in the shape `toISOString` produces: the
  // helper must hand back what the transcript says, so a caller comparing it
  // with a stored reading compares like with like.
  const stored = '2026-09-20T15:32:16.501+08:00';

  await withTranscript(
    [record({ type: 'user', sessionId: 's', timestamp: stored }), ''],
    async (filePath) => {
      const lastActivity = await readTranscriptLastActivity(filePath);

      assert.equal(lastActivity, stored);
      assert.notEqual(lastActivity, new Date(stored).toISOString());
    }
  );
});

test('a timestamp the date parser rejects is skipped, not returned', async () => {
  // The session store writes an unparseable value as CURRENT_TIMESTAMP — the
  // "active just now" reading this helper exists to remove — so a record whose
  // timestamp cannot be read is not a record that reports activity.
  await withTranscript(
    [
      record({ type: 'assistant', sessionId: 's', timestamp: '2026-09-20T07:33:00.000Z' }),
      record({ type: 'assistant', sessionId: 's', timestamp: 'not-a-date' }),
      '',
    ],
    async (filePath) => {
      assert.equal(await readTranscriptLastActivity(filePath), '2026-09-20T07:33:00.000Z');
    }
  );
});

test('widens the tail window past a run of bookkeeping records', async () => {
  // 80 KiB of timestamp-less rows is more than the initial 64 KiB window, so
  // the answer is only reachable by growing the window. A reader capped at one
  // window would report this session as having no activity at all.
  const padding = Array.from({ length: 400 }, (_, index) =>
    record({ type: 'last-prompt', sessionId: 's', lastPrompt: `step ${index}`.padEnd(200, 'x') })
  );

  await withTranscript(
    [
      record({ type: 'assistant', sessionId: 's', timestamp: '2026-09-19T05:00:00.000Z' }),
      ...padding,
      record({ type: 'cost-state', sessionId: 's' }),
      '',
    ],
    async (filePath) => {
      assert.equal(await readTranscriptLastActivity(filePath), '2026-09-19T05:00:00.000Z');
    }
  );
});

/** Grows `padding` so the record's JSON is exactly `targetLength` characters. */
function padRecordToLength(base: Record<string, unknown>, targetLength: number): string {
  const minimalLength = record({ ...base, padding: '' }).length;
  assert.ok(targetLength >= minimalLength, 'the target length must fit the record');
  return record({ ...base, padding: 'y'.repeat(targetLength - minimalLength) });
}

test('reads a complete record that starts exactly at the window boundary', async () => {
  // At the ceiling the window cannot widen any further, so a reader that drops
  // the window's first line whenever the read did not start at offset zero
  // answers null here — and sends the caller back to the file's mtime. The two
  // records are sized so the file's last window opens exactly on the line
  // carrying the timestamp, and the trailing run is long enough that the
  // windows below the ceiling all open inside it.
  const windowCeiling = 512 * 1024;
  const trailingLine = record({ type: 'cost-state', sessionId: 's', padding: 'z'.repeat(1200) });
  const trailingCopies = 320;
  const trailingBytes = trailingCopies * (trailingLine.length + 1);
  const boundaryLine = padRecordToLength(
    { type: 'assistant', sessionId: 's', timestamp: '2026-09-01T00:00:00.000Z' },
    windowCeiling - trailingBytes - 1
  );

  await withTranscript(
    [
      record({ type: 'mode', mode: 'normal', sessionId: 's' }),
      boundaryLine,
      ...Array.from({ length: trailingCopies }, () => trailingLine),
      '',
    ],
    async (filePath) => {
      assert.equal(await readTranscriptLastActivity(filePath), '2026-09-01T00:00:00.000Z');
    }
  );
});

test('returns null for a missing file instead of throwing', async () => {
  const missing = path.join(os.tmpdir(), 'transcript-activity-does-not-exist.jsonl');
  assert.equal(await readTranscriptLastActivity(missing), null);
});
