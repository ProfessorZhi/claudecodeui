import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  claudeQueryFactory,
  queryClaudeSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

/**
 * The per-run path refuses a conversation a Claude Code background job is
 * running, before it creates a query — the same refusal, and the same reader,
 * the resident launch already makes.
 *
 * The launch itself is driven for real (`queryClaudeSDK`), with only the SDK's
 * `query` replaced by a counting double through the runtime's own factory seam.
 * That count is the whole point: "refused before any process exists" is only a
 * meaningful reading if a refused run really created no query, and a run that
 * got past the gate really created exactly one.
 *
 * Every negative is the positive control's own row with one field changed, so a
 * "not occupied" answer says which field made the difference and can never be
 * satisfied by a gate that simply never fires.
 */
const SESSION_ID = '04fda72d-fe9a-4e39-8746-16a221a8301a';
const APP_SESSION_ID = 'app-session-under-test';

/** Records the frames the run writes, in order. */
function recordingWriter(): { frames: AnyRecord[]; writer: ProviderRuntimeWriter } {
  const frames: AnyRecord[] = [];
  return {
    frames,
    writer: {
      send(data: unknown) {
        frames.push(data as AnyRecord);
      },
      userId: null,
      setSessionId() {},
    },
  };
}

/**
 * A stand-in for the SDK's `query`: counts how many times a query was created,
 * and (if one is) yields no SDK events, so a run that reaches it ends at once.
 */
function countingQuery(counts: { calls: number }): typeof claudeQueryFactory.current {
  const fake = (_input: unknown) => {
    counts.calls += 1;
    return {
      [Symbol.asyncIterator]: async function* () {},
      interrupt: async () => {},
    };
  };
  return fake as unknown as typeof claudeQueryFactory.current;
}

/** The provider-scoped lookups the runtime is handed; nothing but the gate is exercised. */
function fakeContext(providerSessionId: string | null): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => providerSessionId,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
}

/**
 * Drives one real per-run launch against a registry directory the caller owns.
 *
 * `CLAUDE_CONFIG_DIR` points the occupancy reader at that registry (it is the
 * host environment the CLI would register in), and `HOME` is moved there too so
 * the MCP-config load stays out of the real `~/.claude.json`.
 */
async function drivePerRun(input: {
  configDir: string;
  providerSessionId?: string | null;
  options?: AnyRecord;
}): Promise<{ frames: AnyRecord[]; queryCalls: number }> {
  const { frames, writer } = recordingWriter();
  const counts = { calls: 0 };
  const previousQuery = claudeQueryFactory.current;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousHome = process.env.HOME;
  claudeQueryFactory.current = countingQuery(counts);
  process.env.CLAUDE_CONFIG_DIR = input.configDir;
  process.env.HOME = input.configDir;
  try {
    await queryClaudeSDK(
      'hello',
      {
        sessionId: APP_SESSION_ID,
        ...(input.options ?? {}),
      },
      writer,
      fakeContext(input.providerSessionId === undefined ? SESSION_ID : input.providerSessionId),
    );
  } finally {
    claudeQueryFactory.current = previousQuery;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  return { frames, queryCalls: counts.calls };
}

/** Whether the run refused because the session was occupied. */
function hasOccupiedErrorFrame(frames: AnyRecord[]): boolean {
  return frames.some((frame) => frame.kind === 'error' && /claude stop /.test(String(frame.content)));
}

interface Registry {
  configDir: string;
  write: (name: string, row: unknown) => Promise<void>;
  livePid: number;
  liveProcStart: string;
}

/** A temp config dir plus one live child process a registry row can point at. */
async function withRegistry(run: (registry: Registry) => Promise<void>): Promise<void> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-per-run-occupancy-'));
  await mkdir(path.join(configDir, 'sessions'));
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const livePid = child.pid as number;
    const stat = await readFile(`/proc/${livePid}/stat`, 'utf8');
    const liveProcStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    await run({
      configDir,
      livePid,
      liveProcStart,
      write: (name, row) =>
        writeFile(path.join(configDir, 'sessions', name), typeof row === 'string' ? row : JSON.stringify(row)),
    });
  } finally {
    child.kill('SIGKILL');
    await rm(configDir, { recursive: true, force: true });
  }
}

test('a live background job holding the session refuses the per-run launch before any query is created', async () => {
  await withRegistry(async ({ configDir, write, livePid, liveProcStart }) => {
    await write(`${livePid}.json`, {
      pid: livePid,
      sessionId: SESSION_ID,
      kind: 'bg',
      jobId: 'job-hit',
      procStart: liveProcStart,
      name: 'Meta-cc version check',
    });

    const { frames, queryCalls } = await drivePerRun({ configDir });

    // The refusal the user reads: the exact command to stop the job, and the
    // fork escape hatch.
    assert.equal(frames[0].kind, 'error', `first frame is the error, got ${JSON.stringify(frames[0])}`);
    assert.match(String(frames[0].content), /claude stop job-hit/);
    assert.match(String(frames[0].content), /fork/);

    // Then the terminal complete, exactly as every other launch failure ends.
    assert.equal(frames[1].kind, 'complete', `second frame is the terminal complete, got ${JSON.stringify(frames[1])}`);
    assert.equal(frames[1].exitCode, 1);
    assert.equal(frames.length, 2, `only the error and its complete, got ${JSON.stringify(frames)}`);

    // The load-bearing reading: no query was ever created, so no process could
    // have been spawned for a session the CLI would refuse to resume.
    assert.equal(queryCalls, 0, 'a refused launch creates no query');
  });
});

test('rows that are not a live background job on this session let the per-run launch through', async () => {
  await withRegistry(async ({ configDir, write, livePid, liveProcStart }) => {
    const base = { pid: livePid, sessionId: SESSION_ID, kind: 'bg', jobId: 'job-hit', procStart: liveProcStart };

    // This app's own resident processes register as `interactive`.
    await write('a.json', { ...base, kind: 'interactive' });
    let result = await drivePerRun({ configDir });
    assert.equal(result.queryCalls, 1, 'interactive row: one query');
    assert.equal(hasOccupiedErrorFrame(result.frames), false, 'interactive row: no occupancy refusal');

    // Another conversation's job. It is a live owner of *its own* conversation,
    // which is what makes the empty answer for this one a reading rather than a
    // gate that never fires.
    await write('a.json', { ...base, sessionId: 'someone-else' });
    result = await drivePerRun({ configDir });
    assert.equal(result.queryCalls, 1, 'other session: one query');
    assert.equal(hasOccupiedErrorFrame(result.frames), false, 'other session: no occupancy refusal');

    // A pid left by a process that is gone.
    await write('a.json', { ...base, pid: 2 ** 22 + 12345 });
    result = await drivePerRun({ configDir });
    assert.equal(result.queryCalls, 1, 'dead pid: one query');
    assert.equal(hasOccupiedErrorFrame(result.frames), false, 'dead pid: no occupancy refusal');

    // A brand-new conversation has no provider session id yet, so no background
    // job can be holding it.
    await write('a.json', base);
    result = await drivePerRun({ configDir, providerSessionId: null });
    assert.equal(result.queryCalls, 1, 'brand-new session: one query');
    assert.equal(hasOccupiedErrorFrame(result.frames), false, 'brand-new session: no occupancy refusal');

    // A turn explicitly starting over shares no session with any background job.
    result = await drivePerRun({ configDir, options: { resumeFromScratch: true } });
    assert.equal(result.queryCalls, 1, 'resumeFromScratch: one query');
    assert.equal(hasOccupiedErrorFrame(result.frames), false, 'resumeFromScratch: no occupancy refusal');
  });
});
