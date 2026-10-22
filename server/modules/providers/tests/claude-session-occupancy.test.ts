import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ClaudeSessionOccupiedError,
  findBackgroundSessionOwner,
  readClaudeSessionOccupancy,
} from '@/shared/utils.js';

/**
 * A conversation a Claude Code background job is running cannot be resumed, so
 * the resident launch asks the CLI's registry first.
 *
 * Each negative is paired with the positive control it is a one-field edit of —
 * the same row with `kind: "bg"`, a live pid and the matching session id — so a
 * `null` answer says which field made the row not count, and "no owner" can never
 * be satisfied by a reader that finds nothing at all.
 *
 * Two readers, one judgement. `findBackgroundSessionOwner` answers for the one
 * conversation a launch is about to resume; `readClaudeSessionOccupancy` answers
 * for all of them at once, which is what the host listing reads. They share the
 * row judgement and the scan, so every negative below is asserted against both:
 * a rule that held for the single-conversation reader but not the table would
 * make the launch refuse to start a process the UI was drawing as free, or the
 * other way round.
 */
const SESSION_ID = '04fda72d-fe9a-4e39-8746-16a221a8301a';

/**
 * The two readers' answer for one conversation, as one value.
 *
 * `undefined` from the table and `null` from the single reader both mean "no
 * owner"; collapsing them here is what lets a case assert the same thing about
 * both without a second line that could drift.
 */
function occupancyOf(configDir: string, sessionId: string): { jobId: string; pid: number } | null {
  return readClaudeSessionOccupancy(configDir).get(sessionId) ?? null;
}

async function withRegistry(
  run: (input: { configDir: string; write: (name: string, row: unknown) => Promise<void>; livePid: number; liveProcStart: string }) => Promise<void>,
): Promise<void> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-occupancy-'));
  await mkdir(path.join(configDir, 'sessions'));
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const pid = child.pid as number;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const liveProcStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    await run({
      configDir,
      livePid: pid,
      liveProcStart,
      write: (name, row) =>
        writeFile(path.join(configDir, 'sessions', name), typeof row === 'string' ? row : JSON.stringify(row)),
    });
  } finally {
    child.kill('SIGKILL');
    await rm(configDir, { recursive: true, force: true });
  }
}

test('a live background job holding the session is reported with the handle `claude stop` takes', async () => {
  await withRegistry(async ({ configDir, write, livePid, liveProcStart }) => {
    await write(`${livePid}.json`, {
      pid: livePid,
      sessionId: SESSION_ID,
      kind: 'bg',
      jobId: '04fda72d',
      procStart: liveProcStart,
      name: 'Meta-cc version check',
    });

    const owner = findBackgroundSessionOwner(configDir, SESSION_ID);
    assert.deepEqual(owner, { pid: livePid, jobId: '04fda72d', name: 'Meta-cc version check' });

    // The same row through the whole-table reader the listing uses, which is
    // also the positive control for every negative below: this is the one
    // fixture state in which a table that is empty everywhere else is not.
    assert.deepEqual(occupancyOf(configDir, SESSION_ID), { jobId: '04fda72d', pid: livePid });
    // The table carries the pair and nothing else — the job's display name is
    // the refusal's business, not the listing row's.
    assert.deepEqual(Object.keys(occupancyOf(configDir, SESSION_ID)!).sort(), ['jobId', 'pid']);
    // A conversation nobody holds is absent from the table rather than mapped to
    // null, which is what makes "no key" and "no owner" the same answer.
    assert.equal(readClaudeSessionOccupancy(configDir).has('a-conversation-nobody-holds'), false);

    const message = new ClaudeSessionOccupiedError(owner!).message;
    assert.match(message, /claude stop 04fda72d/);
    assert.match(message, /fork/);
  });
});

test('rows that are not a live background job on this session do not count', async () => {
  await withRegistry(async ({ configDir, write, livePid, liveProcStart }) => {
    const base = { pid: livePid, sessionId: SESSION_ID, kind: 'bg', jobId: '04fda72d', procStart: liveProcStart };

    // This app's own resident processes register as `interactive`.
    await write('a.json', { ...base, kind: 'interactive' });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'interactive row');
    assert.equal(occupancyOf(configDir, SESSION_ID), null, 'interactive row (table)');

    // Another conversation's job. It is a live owner of *its own* conversation,
    // which is what makes the empty answer for this one a reading rather than an
    // empty table: the row is in the registry, and it names somebody else.
    await write('a.json', { ...base, sessionId: 'someone-else' });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'other session');
    assert.equal(occupancyOf(configDir, SESSION_ID), null, 'other session (table)');
    assert.deepEqual(occupancyOf(configDir, 'someone-else'), { jobId: '04fda72d', pid: livePid });

    // A pid that was recycled: alive, but not the process that wrote the row.
    await write('a.json', { ...base, procStart: `${liveProcStart}0` });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'recycled pid');
    assert.equal(occupancyOf(configDir, SESSION_ID), null, 'recycled pid (table)');

    // A row left by a process that is gone.
    await write('a.json', { ...base, pid: 2 ** 22 + 12345 });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'dead pid');
    assert.equal(occupancyOf(configDir, SESSION_ID), null, 'dead pid (table)');

    // A malformed row must not hide a real owner written beside it.
    await write('a.json', '{not json');
    await write('b.json', base);
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID)?.pid, livePid, 'malformed neighbour');
    assert.equal(occupancyOf(configDir, SESSION_ID)?.pid, livePid, 'malformed neighbour (table)');

    // No provider session id (a brand-new conversation) and no registry at all.
    assert.equal(findBackgroundSessionOwner(configDir, null), null, 'no session id');
    assert.equal(findBackgroundSessionOwner(path.join(configDir, 'missing'), SESSION_ID), null, 'no registry');
    assert.deepEqual(
      readClaudeSessionOccupancy(path.join(configDir, 'missing')),
      new Map(),
      'no registry (table)',
    );
  });
});

test('one table read scans the registry directory exactly once, whatever it holds', async () => {
  await withRegistry(async ({ configDir, write, livePid, liveProcStart }) => {
    // A registry with several live rows, so "one scan" cannot pass by there
    // being nothing to find.
    for (const suffix of ['a', 'b', 'c', 'd']) {
      await write(`${suffix}.json`, {
        pid: livePid,
        sessionId: `conversation-${suffix}`,
        kind: 'bg',
        jobId: `job-${suffix}`,
        procStart: liveProcStart,
      });
    }

    let listings = 0;
    const counting = (directory: string): string[] => {
      listings += 1;
      return readdirSync(directory);
    };

    const table = readClaudeSessionOccupancy(configDir, counting);
    console.log(`rows=${table.size} listings=${listings}`);

    assert.equal(table.size, 4, 'the four live rows are the positive control for the count below');
    assert.equal(
      listings,
      1,
      'a table read is one scan: the listing endpoint is polled once a second, and a reader that '
        + 'scanned per conversation would multiply this by the number of rows in the answer',
    );
  });
});
