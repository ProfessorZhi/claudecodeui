/**
 * Criterion for the resident idle ceiling and the reasons that hold it off (AC-165).
 *
 * The claim is one sentence long and has three parts: a resident host closes
 * itself when it has been quiet for 24 hours; a cron job or a background task the
 * CLI is still holding is a reason not to, and the close is deferred until that
 * reason's own expiry plus a fresh window; and a `cron` lease that goes away
 * gives the plain 24-hour window back. Everything below is a reading of that
 * sentence taken from the production pair that decides it — the real
 * `ClaudeResidentHostDriver` driving a real `createSessionHostManager` with an
 * injected clock — and never from a double of either.
 *
 * What is proven, in the order the criterion reads it:
 *
 *   (1) a `cron` lease holds the host past 24 hours, dated `CRON_MAX_AGE_MS`
 *       (seven days, the CLI's own receipt for `CronCreate`) from when it was
 *       first read — with a host that holds nothing closing at the same instant
 *       as the positive control that "still open" is about the cron.
 *   (2) the reason goes away when the CLI's next `Stop` list stops naming the
 *       job — no `CronDelete` is ever sent — and the host then closes at the
 *       plain 24-hour deadline, not one instant earlier.
 *   (3) a job the CLI keeps naming keeps its original expiry, so the deadline is
 *       re-counted from `expiresAt` and lands a full window after it.
 *   (4) a CLI that never fires the `Stop` hook at all is covered by the fallback:
 *       the `CronCreate` tool call infers a flagged reason, a `CronDelete`
 *       retracts it, and a list-sourced reason beside it is *not* flagged — so
 *       `inferred` distinguishes the two rather than being true by default.
 *   (5) background work is the same story from both of its sources, the hook's
 *       `background_tasks` list and the stream's own frames, and its retraction
 *       restores the plain window too.
 *   (6) a `system` subtype this build has never read (`scheduled_task_fire`,
 *       which E9 did not observe) is passed through rather than thrown on: the
 *       read loop is still alive afterwards and the timing and lease readings are
 *       word-for-word identical with and without it.
 *   (7) a browser subscribing moves nothing: the real `chat.subscribe` path
 *       reaches `attachViewer` through the manager, `lastActivityAt` and the
 *       close deadline are both unchanged, and a real `noteActivity` beside it
 *       moves them — so "unchanged" is not a clock that never moved.
 *   (8) the close reason is readable through the production REST listing
 *       (`GET /api/session-hosts`) over the same manager instance that drove the
 *       host, and reads `null` before the close.
 *
 * Determinism: the clock is a number the criterion owns and the scheduler is a
 * queue it drains, both injected into the driver *and* into the manager, so the
 * 24-hour ceiling and the seven-day expiry are reached in microseconds and there
 * is no real waiting anywhere in this file. The driver reaches the wall clock
 * only through the seam the manager's clock also replaces.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import express from 'express';

import {
  RESIDENT_IDLE_TIMEOUT,
  createSessionHostManager,
  createSessionHostsRouter,
} from '@/modules/session-hosts/index.js';
import type {
  HostScheduler,
  ProcessHost,
  SessionBinding,
  SessionHostManager,
} from '@/modules/session-hosts/index.js';
import {
  CRON_MAX_AGE_MS,
  ClaudeResidentHostDriver,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { handleChatConnection } from '@/modules/websocket/index.js';
import type {
  AnyRecord,
  HostLease,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const FILE_STARTED_AT = Date.now();
const SESSION = 'ac165-resident-idle';
const E9_SESSION_ID = 'b827aab6-2114-4fe2-b1af-991a6c2285e1';
const HOUR_MS = 60 * 60 * 1000;
/** The id of the frame leg (6) pushes *after* the subtype it does not know. */
const LIVENESS_TASK_ID = 'b3liveness';

/**
 * One line of this criterion's readings, prefixed so a reader can find them.
 *
 * `console.log` rather than a diagnostic because the readings *are* the
 * evidence: a leg that asserts without printing what it saw leaves a reader
 * unable to tell a passing assertion from a vacuous one.
 */
function say(line: string): void {
  console.log(`idle ${line}`);
}

// ---------------------------
//----------------- FIXTURE SCAFFOLDING ------------
/**
 * A scheduler whose deadlines are queue entries and whose clock is a number.
 *
 * The same seam the lifecycle criterion injects, for the same reason: the
 * manager asks for an instant and this answers instantly, which is the only way
 * a 24-hour policy threshold becomes reachable at all. `advance` moves the clock
 * first and then drains every entry that came due, oldest first, spending each
 * before running it — so a callback that re-arms (the cron deferral) is ordered
 * by the deadline it named rather than by when it was scheduled.
 */
type FakeClock = HostScheduler & {
  now(): number;
  advance(ms: number): void;
  /** Deadlines still armed — a "held, not closed" reading that is not a state. */
  pending(): number;
};

type ClockEntry = { at: number; run: () => void; spent: boolean };

function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  const entries: ClockEntry[] = [];

  return {
    now: () => current,
    schedule(at, run) {
      const entry: ClockEntry = { at, run, spent: false };
      entries.push(entry);
      return () => {
        entry.spent = true;
      };
    },
    advance(ms) {
      current += ms;
      for (;;) {
        const due = entries
          .filter((entry) => !entry.spent && entry.at <= current)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) {
          return;
        }
        due.spent = true;
        due.run();
      }
    },
    pending: () => entries.filter((entry) => !entry.spent).length,
  };
}

/**
 * A resident process the criterion owns: a stream it pushes into, in order.
 *
 * The query never ends on its own, which is load-bearing rather than
 * convenient: an iterable that finished would make the driver's read loop call
 * `reportExit`, the manager would close the host as `exited`, and every reading
 * below would be a reading of a dead process. Its `pid` is a value rather than a
 * getter for the same reason the fixture is a value: nothing here waits for a
 * spawn.
 */
type FakeProcess = {
  /** What the driver is constructed with. */
  factory: ClaudeResidentProcessFactory;
  /** Push one frame into the stream the driver is reading. */
  emit(frame: AnyRecord): void;
  /** Fire one `Stop` hook input through the seam the driver installed. */
  stop(input: AnyRecord): void;
  /** How many processes the driver has spawned. */
  readonly spawns: number;
  /** Tool names the criterion has pushed onto the stream, counted on the way in. */
  readonly toolCalls: Record<string, number>;
};

function createFakeProcess(): FakeProcess {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
  const toolCalls: Record<string, number> = {};
  let stopSink: ((input: AnyRecord) => void) | null = null;
  const stopsBeforeAdoption: AnyRecord[] = [];
  let spawns = 0;

  const push = (frame: AnyRecord): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    pending.push(frame);
  };

  const iterator: AsyncIterator<AnyRecord> = {
    next(): Promise<IteratorResult<AnyRecord>> {
      const frame = pending.shift();
      if (frame) {
        return Promise.resolve({ value: frame, done: false });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
      });
    },
    // Never resolves with `done`: see the type's doc comment.
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  const recordToolCalls = (frame: AnyRecord): void => {
    const message = frame?.message as AnyRecord | undefined;
    if (!Array.isArray(message?.content)) {
      return;
    }
    for (const block of message.content as AnyRecord[]) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
      }
    }
  };

  return {
    factory: (input) => {
      spawns += 1;
      stopSink = input.seams?.onStop ?? null;
      for (const queued of stopsBeforeAdoption.splice(0)) {
        stopSink?.(queued);
      }
      return { query, pid: 4242 } satisfies ClaudeResidentProcess;
    },
    emit: (frame) => {
      recordToolCalls(frame);
      push(frame);
    },
    stop: (input) => {
      if (!stopSink) {
        stopsBeforeAdoption.push(input);
        return;
      }
      stopSink(input);
    },
    get spawns() {
      return spawns;
    },
    toolCalls,
  };
}

/** The runtime's own turn inputs, stubbed to the two facts the driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // No frames are asserted here: the criterion is about a host's lifetime, and
  // the frame pipeline has its own criteria beside this one.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createWriter(): ProviderRuntimeWriter & { frames: unknown[] } {
  const frames: unknown[] = [];
  return {
    frames,
    send: (data: unknown) => frames.push(data),
    setSessionId: () => undefined,
    userId: 1,
  };
}

/** One host's worth of fixture: a clock, a manager, a driver, and one process. */
type Leg = {
  clock: FakeClock;
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: FakeProcess;
  sessionId: string;
  /** The rounds `run` is holding, in the order they were armed. */
  rounds: Array<Promise<void>>;
};

function createLeg(sessionId: string): Leg {
  const clock = createFakeClock();
  const manager = createSessionHostManager({ now: () => clock.now(), scheduler: clock });
  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => clock.now(),
  });
  return { clock, manager, driver, process, sessionId, rounds: [] };
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 50; hop += 1) {
    await Promise.resolve();
  }
}

/** The manager's own copy of the binding this leg's session is on, or null. */
function findBinding(leg: Leg): SessionBinding | null {
  const host = leg.manager
    .snapshot()
    .find((candidate) => candidate.bindings.has(leg.sessionId));
  return host?.bindings.get(leg.sessionId) ?? null;
}

/** The host itself, as the manager publishes it. */
function findHost(leg: Leg): ProcessHost {
  const host = leg.manager
    .snapshot()
    .find((candidate) => candidate.bindings.has(leg.sessionId));
  if (!host) {
    throw new Error(`no host serves ${leg.sessionId}`);
  }
  return host;
}

function leaseKinds(leg: Leg): string[] {
  return findBinding(leg)?.leases.map((lease) => lease.kind) ?? [];
}

function cronsOf(leg: Leg): Array<Extract<HostLease, { kind: 'cron' }>> {
  return (findBinding(leg)?.leases ?? []).filter(
    (lease): lease is Extract<HostLease, { kind: 'cron' }> => lease.kind === 'cron',
  );
}

function heldTasksOf(leg: Leg): Array<Extract<HostLease, { kind: 'background-task' | 'monitor' }>> {
  return (findBinding(leg)?.leases ?? []).filter(
    (lease): lease is Extract<HostLease, { kind: 'background-task' | 'monitor' }> =>
      lease.kind === 'background-task' || lease.kind === 'monitor',
  );
}

/**
 * Arms one real round through the driver's `run` entry and waits for its lease.
 *
 * The wait is on the `turn` lease rather than on the host record because the
 * lease is the later of the two facts: by the time it is there, `openHost` has
 * answered, `startHost` has adopted the process *and* installed the `Stop` seam,
 * the queue has been seeded, and `run` is parked at the round's settlement. Every
 * leg below can then push frames and fire hooks and know they will be read.
 */
async function beginRound(leg: Leg, label: string): Promise<void> {
  leg.rounds.push(leg.driver.run(leg.sessionId, { command: label, options: {} }, createWriter(), CONTEXT));
  for (let hop = 0; hop < 400; hop += 1) {
    if (leaseKinds(leg).includes('turn')) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('the resident host never armed a turn lease');
}

/** Ends the round in flight with a `result`, and waits for the dispatch to settle. */
async function endRound(leg: Leg): Promise<void> {
  const round = leg.rounds.pop();
  leg.process.emit(resultFrame());
  // A round that a mutation failed rejects; the settlement is not what this
  // criterion reads, so the rejection is swallowed here rather than crashing the
  // file on an unhandled rejection before the leg's own readings are printed.
  await round?.catch(() => undefined);
}

// ---------------------------
//----------------- §9.3–9.5 FRAME SHAPES ------------
/*
 * The key sets below are transcribed verbatim from E9's record
 * (`docs/proposals/claude-resident-sessions-experiments.md` §9.3–9.5), which is
 * the only place the CLI's own wire shape is written down. They are literals
 * rather than readings of the document because they are the *contract* this
 * criterion holds the driver to; the one claim the document itself is asked for
 * (that E9 never saw `scheduled_task_fire`) is read from it in leg (6).
 */
const E9_STOP_HOOK_KEYS = [
  'background_tasks',
  'cwd',
  'effort',
  'hook_event_name',
  'last_assistant_message',
  'permission_mode',
  'prompt_id',
  'session_crons',
  'session_id',
  'stop_hook_active',
  'transcript_path',
];
const E9_SESSION_CRON_KEYS = ['id', 'prompt', 'recurring', 'schedule'];
const E9_BACKGROUND_TASK_KEYS = ['command', 'description', 'id', 'status', 'type'];
const E9_TASK_STARTED_KEYS = [
  'description',
  'is_backgrounded',
  'session_id',
  'subtype',
  'task_id',
  'task_type',
  'tool_use_id',
  'type',
  'uuid',
];
const E9_TASK_NOTIFICATION_KEYS = [
  'output_file',
  'session_id',
  'status',
  'subtype',
  'summary',
  'task_id',
  'tool_use_id',
  'type',
  'uuid',
];
const E9_BACKGROUND_TASKS_CHANGED_KEYS = ['session_id', 'subtype', 'tasks', 'type', 'uuid'];
const E9_BACKGROUND_TASKS_CHANGED_TASK_KEYS = ['description', 'task_id', 'task_type'];

function keysOf(value: unknown): string[] {
  return Object.keys(value as AnyRecord).sort();
}

/**
 * One `Stop` hook input, shaped by §9.3.
 *
 * The CLI's own list of keys is the whole of it — including the two the driver
 * reads (`session_crons`, `background_tasks`) and the nine it ignores — because
 * a driver that quietly depended on a field the CLI does not send is exactly
 * what a shape assertion here catches.
 */
function stopHookInput(overrides: AnyRecord = {}): AnyRecord {
  return {
    session_id: E9_SESSION_ID,
    transcript_path: '/tmp/claude-1004/transcript.jsonl',
    cwd: '/tmp/resident-e9d',
    prompt_id: null,
    permission_mode: 'bypassPermissions',
    effort: null,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'E9-TICK-MARKER',
    background_tasks: [],
    session_crons: [],
    ...overrides,
  };
}

/** One `session_crons` element, §9.4's own sample. */
function sessionCron(overrides: AnyRecord = {}): AnyRecord {
  return {
    id: '7d58f90e',
    schedule: '* * * * *',
    recurring: true,
    prompt: 'E9-TICK-MARKER',
    ...overrides,
  };
}

/** One `background_tasks` element, §9.4's own sample. */
function backgroundTask(overrides: AnyRecord = {}): AnyRecord {
  return {
    id: 'b1dwq9kee',
    type: 'shell',
    status: 'running',
    description: 'sleep 300; echo hold-done',
    command: 'sleep 300; echo hold-done',
    ...overrides,
  };
}

function taskStartedFrame(overrides: AnyRecord = {}): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: 'b2k6xdn8u',
    tool_use_id: 'toolu_e9_fg',
    description: 'sleep 5; echo fg-done',
    is_backgrounded: false,
    task_type: 'local_bash',
    uuid: '60adf10f-4e5c-4a6f-9d0e-1f5a2b3c4d5e',
    session_id: E9_SESSION_ID,
    ...overrides,
  };
}

function taskNotificationFrame(overrides: AnyRecord = {}): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'b2k6xdn8u',
    tool_use_id: 'toolu_e9_fg',
    status: 'completed',
    output_file: '/tmp/claude-1004/tasks/b2k6xdn8u.output',
    summary: 'fg-done',
    uuid: '9f5b1c72-3d44-4a91-8e0b-6c2f7a1d0b33',
    session_id: E9_SESSION_ID,
    ...overrides,
  };
}

function backgroundTasksChangedFrame(tasks: AnyRecord[]): AnyRecord {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks,
    uuid: '3a91be20-7c15-4f68-9a2d-5e0b8c4f1a77',
    session_id: E9_SESSION_ID,
  };
}

function changedTaskRow(overrides: AnyRecord = {}): AnyRecord {
  return {
    task_id: 'b1dwq9kee',
    task_type: 'local_bash',
    description: 'sleep 300; echo hold-done',
    ...overrides,
  };
}

function initFrame(): AnyRecord {
  return {
    type: 'system',
    subtype: 'init',
    tools: ['Bash', 'CronCreate', 'CronDelete', 'CronList'],
    uuid: '1d0f5b8a-9c22-4e31-b7a4-8f6d2c0e5a91',
    session_id: E9_SESSION_ID,
  };
}

function assistantFrame(): AnyRecord {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'E9 ok' }] },
    session_id: E9_SESSION_ID,
    uuid: randomUUID(),
  };
}

/** One assistant turn that called a tool — the stream-side evidence of a job. */
function assistantToolUse(id: string, name: string, input: AnyRecord): AnyRecord {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    session_id: E9_SESSION_ID,
    uuid: randomUUID(),
  };
}

function resultFrame(): AnyRecord {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: E9_SESSION_ID,
    uuid: randomUUID(),
  };
}

// ---------------------------
//----------------- THE CRITERION ------------
test('resident idle ceiling: held work defers the close and the REST listing reports it', async () => {
  // ---- AC3: the frame shapes every leg below is built from match §9.3–9.5. ----
  const shapes: Array<[string, unknown, string[]]> = [
    ['Stop-hook input', stopHookInput(), E9_STOP_HOOK_KEYS],
    ['session_crons[0]', sessionCron(), E9_SESSION_CRON_KEYS],
    ['background_tasks[0]', backgroundTask(), E9_BACKGROUND_TASK_KEYS],
    ['system/task_started', taskStartedFrame(), E9_TASK_STARTED_KEYS],
    ['system/task_notification', taskNotificationFrame(), E9_TASK_NOTIFICATION_KEYS],
    ['system/background_tasks_changed', backgroundTasksChangedFrame([]), E9_BACKGROUND_TASKS_CHANGED_KEYS],
    ['background_tasks_changed.tasks[0]', changedTaskRow(), E9_BACKGROUND_TASKS_CHANGED_TASK_KEYS],
  ];
  for (const [label, frame, expected] of shapes) {
    say(`(3) ${label} keys=${keysOf(frame).join(',')}`);
    assert.deepEqual(keysOf(frame), expected, `${label} does not match the E9 key set`);
  }

  // ---- AC4 (1): a held cron defers the close past 24 hours, for seven days. ----
  {
    const leg = createLeg(`${SESSION}-1`);
    const createdAt = leg.clock.now();
    await beginRound(leg, 'E9-CRON-CREATE 请创建一个每分钟的周期任务');
    // The turn really made the job, and the hook then really named it — the E9
    // sequence (§9.4), not the hook alone.
    leg.process.emit(
      assistantToolUse('toolu_e9_cron', 'CronCreate', {
        schedule: '* * * * *',
        prompt: 'E9-TICK-MARKER',
        recurring: true,
      }),
    );
    leg.process.stop(stopHookInput({ session_crons: [sessionCron()], background_tasks: [] }));
    await endRound(leg);

    const crons = cronsOf(leg);
    assert.equal(crons.length, 1, 'the hook named one job and the binding holds it');
    const cron = crons[0];
    say(
      `(1) lease.kind=${cron.kind} id=${cron.id} recurring=${cron.recurring} ` +
        `expiresAt=${cron.expiresAt} createdAt=${createdAt} spanMs=${cron.expiresAt - createdAt} ` +
        `inferred=${cron.inferred === true}`,
    );
    assert.equal(cron.expiresAt - createdAt, CRON_MAX_AGE_MS, 'the expiry is the CLI receipt window');
    assert.equal(cron.recurring, true);

    const host = findHost(leg);
    say(
      `(1) at-t0 host.state=${host.state} binding.state=${findBinding(leg)?.state} ` +
        `closeReason=${String(host.closeReason)} quietWindowStartAt=${host.quietWindowStartAt} ` +
        `quietDeadlineAt=${host.quietDeadlineAt} expected=${createdAt + RESIDENT_IDLE_TIMEOUT}`,
    );
    assert.equal(host.quietDeadlineAt, createdAt + RESIDENT_IDLE_TIMEOUT);

    leg.clock.advance(RESIDENT_IDLE_TIMEOUT);
    const afterDay = findHost(leg);
    say(
      `(1) at-24h host.state=${afterDay.state} binding.state=${findBinding(leg)?.state} ` +
        `closeReason=${String(afterDay.closeReason)} crons=${cronsOf(leg).length} ` +
        `quietWindowStartAt=${afterDay.quietWindowStartAt} quietDeadlineAt=${afterDay.quietDeadlineAt}`,
    );
    assert.notEqual(afterDay.state, 'closed', 'a held cron must keep the host open at 24 hours');
    assert.equal(findBinding(leg)?.state, 'idle');
    assert.equal(afterDay.closeReason, null);
    assert.equal(cronsOf(leg).length, 1);
    assert.equal(afterDay.quietWindowStartAt, cron.expiresAt);
    assert.equal(afterDay.quietDeadlineAt, cron.expiresAt + RESIDENT_IDLE_TIMEOUT);

    // Positive control: the very same advance closes a host that holds nothing,
    // so "still open" above is a statement about the cron and not about a clock
    // that cannot close anything.
    const control = createLeg(`${SESSION}-1-control`);
    await beginRound(control, 'no held work');
    await endRound(control);
    control.clock.advance(RESIDENT_IDLE_TIMEOUT);
    const controlHost = findHost(control);
    say(`(1) positive-control bare-host at-24h state=${controlHost.state} closeReason=${String(controlHost.closeReason)}`);
    assert.equal(controlHost.state, 'closed');
    assert.equal(controlHost.closeReason, 'idle');
  }

  // ---- AC5 (2): the reason goes away with no CronDelete, and the host closes. ----
  {
    const leg = createLeg(`${SESSION}-2`);
    await beginRound(leg, 'E9-CRON-CREATE 请创建一个每分钟的周期任务');
    leg.process.emit(
      assistantToolUse('toolu_e9_cron', 'CronCreate', {
        schedule: '* * * * *',
        prompt: 'E9-TICK-MARKER',
        recurring: true,
      }),
    );
    leg.process.stop(stopHookInput({ session_crons: [sessionCron()] }));
    await endRound(leg);
    assert.equal(cronsOf(leg).length, 1, 'round 1 leaves the job held');

    const secondRoundAt = leg.clock.now();
    await beginRound(leg, '下一轮');
    leg.process.emit(assistantFrame());
    // The CLI's next Stop list simply no longer names it. Nothing cancels the
    // job on the stream — the list is the only evidence, which is the point.
    leg.process.stop(stopHookInput({ session_crons: [] }));
    await endRound(leg);

    const deadline = findHost(leg).quietDeadlineAt;
    const reading = leg.driver.lifecycleReading(leg.sessionId);
    say(
      `(2) cronLeaseGone=${cronsOf(leg).length === 0} cronDeletesSent=${leg.process.toolCalls.CronDelete ?? 0} ` +
        `cronsAuthoritative=${reading?.cronsAuthoritative} quietDeadlineAt=${String(deadline)} ` +
        `expected=${secondRoundAt + RESIDENT_IDLE_TIMEOUT}`,
    );
    assert.equal(cronsOf(leg).length, 0, 'the retracted job leaves no cron lease');
    assert.equal(leg.process.toolCalls.CronDelete ?? 0, 0, 'no CronDelete was ever sent');
    assert.equal(reading?.cronsAuthoritative, true, 'the list really was read');
    assert.equal(deadline, secondRoundAt + RESIDENT_IDLE_TIMEOUT);

    leg.clock.advance(RESIDENT_IDLE_TIMEOUT - 1);
    const early = findHost(leg);
    say(`(2) at-deadline-minus-1 host.state=${early.state} closeReason=${String(early.closeReason)} pending=${leg.clock.pending()}`);
    assert.notEqual(early.state, 'closed', 'the close is not a moment early');

    leg.clock.advance(1);
    const closed = findHost(leg);
    say(`(2) idle-closed-at=${String(deadline)} host.state=${closed.state} closeReason=${String(closed.closeReason)}`);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.closeReason, 'idle');
  }

  // ---- AC6 (3): a job the CLI keeps naming re-times the deadline to its own expiry. ----
  {
    const leg = createLeg(`${SESSION}-3`);
    const firstAt = leg.clock.now();
    await beginRound(leg, 'E9-CRON-CREATE 请创建一个每分钟的周期任务');
    leg.process.emit(
      assistantToolUse('toolu_e9_cron', 'CronCreate', {
        schedule: '* * * * *',
        prompt: 'E9-TICK-MARKER',
        recurring: true,
      }),
    );
    leg.process.stop(stopHookInput({ session_crons: [sessionCron()] }));
    await endRound(leg);

    leg.clock.advance(HOUR_MS);
    await beginRound(leg, '再问一次它还在不在');
    leg.process.stop(stopHookInput({ session_crons: [sessionCron()] }));
    await endRound(leg);

    const crons = cronsOf(leg);
    const expiresAt = crons[0]?.expiresAt ?? 0;
    const firstDeadline = findHost(leg).quietDeadlineAt ?? 0;
    say(
      `(3) expiresAt=${expiresAt} expected=${firstAt + CRON_MAX_AGE_MS} ` +
        `deadline-before-rearm=${String(firstDeadline)} crons=${crons.length}`,
    );
    assert.equal(crons.length, 1);
    assert.equal(expiresAt, firstAt + CRON_MAX_AGE_MS, 'a job the CLI keeps naming keeps its first expiry');

    // Step to the window the first round armed: that is where the re-time happens.
    leg.clock.advance(firstDeadline - leg.clock.now());
    const rearmed = findHost(leg);
    say(
      `(3) rearmed-window-start=${String(rearmed.quietWindowStartAt)} ` +
        `rearmed-deadline=${String(rearmed.quietDeadlineAt)} host.state=${rearmed.state} ` +
        `expected=${expiresAt + RESIDENT_IDLE_TIMEOUT}`,
    );
    assert.equal(rearmed.quietWindowStartAt, expiresAt);
    assert.equal(rearmed.quietDeadlineAt, expiresAt + RESIDENT_IDLE_TIMEOUT);

    // Step to the re-armed deadline itself: it is `expiresAt + 24h` away, which
    // is the whole point — the second window is counted from the job's own
    // expiry rather than from the activity that armed the first one.
    const rearmedDeadline = rearmed.quietDeadlineAt ?? 0;
    leg.clock.advance(rearmedDeadline - leg.clock.now() - 1);
    const early = findHost(leg);
    say(
      `(3) at-rearmed-deadline-minus-1 host.state=${early.state} closeReason=${String(early.closeReason)} ` +
        `pending=${leg.clock.pending()} now=${leg.clock.now()}`,
    );
    assert.notEqual(early.state, 'closed', 'not one instant before the re-armed deadline');

    leg.clock.advance(1);
    const closed = findHost(leg);
    say(
      `(3) closed-at=${expiresAt + RESIDENT_IDLE_TIMEOUT} host.state=${closed.state} closeReason=${String(closed.closeReason)} ` +
        `now=${leg.clock.now()} crons=${cronsOf(leg).length} expiresAt=${String(cronsOf(leg)[0]?.expiresAt)} ` +
        `quietWindowStartAt=${String(closed.quietWindowStartAt)} quietDeadlineAt=${String(closed.quietDeadlineAt)}`,
    );
    assert.equal(closed.state, 'closed');
    assert.equal(closed.closeReason, 'idle');
  }

  // ---- AC7 (4): the tool-call fallback when no Stop hook ever fires. ----
  {
    const leg = createLeg(`${SESSION}-4`);
    const at = leg.clock.now();
    await beginRound(leg, 'E9-CRON-CREATE（这次没有任何 Stop hook）');
    leg.process.emit(
      assistantToolUse('toolu_e9_cron_inferred', 'CronCreate', {
        schedule: '* * * * *',
        prompt: 'E9-TICK-MARKER',
        recurring: true,
      }),
    );
    await settle();

    const inferred = cronsOf(leg);
    const reading = leg.driver.lifecycleReading(leg.sessionId);
    say(
      `(4) lease.kind=${inferred[0]?.kind} id=${String(inferred[0]?.id)} inferred=${inferred[0]?.inferred === true} ` +
        `expiresAt=${String(inferred[0]?.expiresAt)} cronsAuthoritative=${String(reading?.cronsAuthoritative)}`,
    );
    assert.equal(reading?.cronsAuthoritative, false, 'no Stop hook fired in this leg');
    assert.equal(inferred.length, 1);
    assert.equal(inferred[0].inferred, true, 'a tool-call reading is flagged as a guess');
    assert.equal(inferred[0].id, 'toolu_e9_cron_inferred');
    assert.equal(inferred[0].expiresAt, at + CRON_MAX_AGE_MS);

    leg.process.emit(assistantToolUse('toolu_e9_cron_delete', 'CronDelete', { id: '7d58f90e' }));
    await settle();
    assert.equal(cronsOf(leg).length, 0, 'CronDelete retracts the inferred reason');
    // The deadline is read once the round is over: a host serving a turn is on
    // no quiet clock at all (`quietDeadlineAt` is null), so a reading taken
    // mid-round would be a reading of the turn rather than of the retraction.
    await endRound(leg);
    say(
      `(4) after-CronDelete crons=${cronsOf(leg).length} quietDeadlineAt=${String(findHost(leg).quietDeadlineAt)} ` +
        `expected=${at + RESIDENT_IDLE_TIMEOUT}`,
    );
    assert.equal(findHost(leg).quietDeadlineAt, at + RESIDENT_IDLE_TIMEOUT);

    // Positive control, in this leg's own terms: the same tool call with the
    // hook's list arriving after it is *not* flagged, so `inferred` is a
    // statement about which evidence won rather than a field that is true by
    // default.
    const control = createLeg(`${SESSION}-4-control`);
    await beginRound(control, 'E9-CRON-CREATE（有 Stop hook）');
    control.process.emit(
      assistantToolUse('toolu_e9_cron', 'CronCreate', {
        schedule: '* * * * *',
        prompt: 'E9-TICK-MARKER',
        recurring: true,
      }),
    );
    control.process.stop(stopHookInput({ session_crons: [sessionCron()] }));
    await settle();
    const listed = cronsOf(control);
    say(`(4) positive-control list-sourced id=${String(listed[0]?.id)} inferred=${listed[0]?.inferred === true}`);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, '7d58f90e', 'the CLI-named id replaces the tool-call guess');
    assert.notEqual(listed[0].inferred, true);
    await endRound(control);
  }

  // ---- AC8 (5): background work, from the hook's list and from the stream. ----
  {
    const leg = createLeg(`${SESSION}-5-hook`);
    const at = leg.clock.now();
    await beginRound(leg, 'E9-BG-HOLD 请挂一个后台任务');
    leg.process.emit(
      assistantToolUse('toolu_e9_hold', 'Bash', { command: 'sleep 300; echo hold-done', run_in_background: true }),
    );
    leg.process.stop(
      stopHookInput({ background_tasks: [backgroundTask()], session_crons: [] }),
    );
    await endRound(leg);

    const held = heldTasksOf(leg);
    const reading = leg.driver.lifecycleReading(leg.sessionId);
    say(
      `(5) hook-source lease.kind=${held[0]?.kind} id=${String(held[0]?.id)} ` +
        `tasksAuthoritative=${String(reading?.tasksAuthoritative)} count=${held.length}`,
    );
    assert.equal(held.length, 1);
    assert.equal(held[0].kind, 'background-task');
    assert.equal(held[0].id, 'b1dwq9kee');
    assert.equal(reading?.tasksAuthoritative, true);

    await beginRound(leg, '下一轮');
    leg.process.stop(stopHookInput({ background_tasks: [], session_crons: [] }));
    await endRound(leg);
    say(
      `(5) hook-source after-empty tasks=${heldTasksOf(leg).length} quietDeadlineAt=${String(findHost(leg).quietDeadlineAt)} ` +
        `expected=${at + RESIDENT_IDLE_TIMEOUT}`,
    );
    assert.equal(heldTasksOf(leg).length, 0, 'the finished task restores the plain window');
    assert.equal(findHost(leg).quietDeadlineAt, at + RESIDENT_IDLE_TIMEOUT);
  }
  {
    const leg = createLeg(`${SESSION}-5-stream`);
    const at = leg.clock.now();
    await beginRound(leg, 'E9-BG-HOLD 请挂一个后台任务');

    // The stream's own frames: a task that starts and stops inside one turn is
    // never on any hook list, and a host that only read the hook would look idle
    // for the whole of it.
    leg.process.emit(taskStartedFrame());
    await settle();
    const started = heldTasksOf(leg);
    say(`(5) stream-source task_started lease.kind=${started[0]?.kind} id=${String(started[0]?.id)} count=${started.length}`);
    assert.equal(started.length, 1);
    assert.equal(started[0].id, 'b2k6xdn8u');

    leg.process.emit(taskNotificationFrame());
    await settle();
    say(`(5) stream-source task_notification tasks=${heldTasksOf(leg).length}`);
    assert.equal(heldTasksOf(leg).length, 0, 'the notification retracts the task it names');

    leg.process.emit(backgroundTasksChangedFrame([changedTaskRow()]));
    await settle();
    const changed = heldTasksOf(leg);
    say(`(5) stream-source background_tasks_changed lease.kind=${changed[0]?.kind} id=${String(changed[0]?.id)} count=${changed.length}`);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, 'b1dwq9kee');

    leg.process.emit(backgroundTasksChangedFrame([]));
    await settle();
    await endRound(leg);
    say(
      `(5) stream-source after-empty tasks=${heldTasksOf(leg).length} quietDeadlineAt=${String(findHost(leg).quietDeadlineAt)} ` +
        `expected=${at + RESIDENT_IDLE_TIMEOUT}`,
    );
    assert.equal(heldTasksOf(leg).length, 0);
    assert.equal(findHost(leg).quietDeadlineAt, at + RESIDENT_IDLE_TIMEOUT);
  }

  // ---- AC9 (6): an unread `system` subtype is passed through, not thrown on. ----
  {
    const summaries: string[] = [];
    for (const withFire of [false, true]) {
      const leg = createLeg(`${SESSION}-6-${withFire ? 'fire' : 'quiet'}`);
      const at = leg.clock.now();
      await beginRound(leg, 'E9-CRON-CREATE（无人轮 subtype）');
      leg.process.emit(initFrame());
      if (withFire) {
        // The subtype E9 never observed but the binary carries (§9.4/9.5):
        // "是否出现 scheduled_task_fire：没有出现". A loop that stopped here would
        // end the process's whole lifetime on a word the CLI is entitled to add.
        leg.process.emit({
          type: 'system',
          subtype: 'scheduled_task_fire',
          cron_id: '7d58f90e',
          schedule: '* * * * *',
          uuid: '7e2c4a10-5b93-4d6f-8a01-c3f5e9b7d244',
          session_id: E9_SESSION_ID,
        });
      }
      leg.process.emit(assistantFrame());
      // Liveness, read directly rather than by proxy: a frame this build *does*
      // read arrives after the one it does not, and its effect has to land. A
      // loop that stopped on the unknown subtype would never consume this, so
      // the lease below is the difference between "it passed the alphabet" and
      // "it is still reading". Its own retraction follows so the settled
      // summaries of the two runs stay comparable.
      leg.process.emit(taskStartedFrame({ task_id: LIVENESS_TASK_ID }));
      await settle();

      const reading = leg.driver.lifecycleReading(leg.sessionId);
      const host = findHost(leg);
      const liveness = heldTasksOf(leg).some((lease) => lease.id === LIVENESS_TASK_ID);
      const alive = reading !== null && host.state !== 'closed' && liveness;
      say(
        `(6) with-fire=${withFire} unknownSubtypeSeen=${reading?.unhandledSystemSubtypes.includes('scheduled_task_fire') === true} ` +
          `loopAlive=${alive} frameAfterUnknownRead=${liveness} ` +
          `unhandled=[${(reading?.unhandledSystemSubtypes ?? []).join(',')}] host.state=${host.state}`,
      );
      if (withFire) {
        assert.equal(reading?.unhandledSystemSubtypes.includes('scheduled_task_fire'), true);
        assert.notEqual(reading, null, 'the read loop is still alive after an unread subtype');
        assert.notEqual(host.state, 'closed');
      } else {
        assert.deepEqual(reading?.unhandledSystemSubtypes, []);
        assert.notEqual(host.state, 'closed');
      }
      // The one assertion both runs make, and the one that reds when the loop
      // stopped on the earlier frame.
      assert.equal(liveness, true, 'a frame pushed after the unknown subtype was still read');

      leg.process.emit(taskNotificationFrame({ task_id: LIVENESS_TASK_ID }));
      await settle();
      await endRound(leg);
      const settledHost = findHost(leg);
      const summary =
        `host.state=${settledHost.state} leases=${leaseKinds(leg).join(',')} ` +
        `quietWindowStartAt=${settledHost.quietWindowStartAt} quietDeadlineAt=${settledHost.quietDeadlineAt} ` +
        `closeReason=${String(settledHost.closeReason)}`;
      summaries.push(summary);
      say(`(6) with-fire=${withFire} settled ${summary}`);
      assert.equal(settledHost.quietDeadlineAt, at + RESIDENT_IDLE_TIMEOUT);
    }
    assert.equal(summaries[0], summaries[1], 'timing and lease readings are identical with and without the frame');

    // The document's own answer, read rather than restated: E9 never saw this
    // frame, which is why "the loop must survive it" is a rule and not a report.
    const record = readFileSync(
      fileURLToPath(new URL('../../../../docs/proposals/claude-resident-sessions-experiments.md', import.meta.url)),
      'utf8',
    );
    const marker = '是否出现 scheduled_task_fire：';
    const line = record.split('\n').find((row) => row.includes(marker)) ?? '';
    const answer = line.slice(line.indexOf(marker) + marker.length);
    say(`(6) scheduledTaskFireInE9=false record-says=${answer.trim()}`);
    assert.equal(answer.replace(/\*/g, '').trim(), '没有出现');
  }

  // ---- AC10 (7): a subscription attaches a viewer and moves nothing. ----
  {
    const leg = createLeg(`${SESSION}-7`);
    await beginRound(leg, '先说一句话');
    await endRound(leg);

    const before = findBinding(leg)?.lastActivityAt;
    const deadlineBefore = findHost(leg).quietDeadlineAt;

    const attachCalls: string[] = [];
    const socket = createFakeSocket();
    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: stubRuntime(),
        sessionHostManager: {
          attachViewer: (sessionId: string) => {
            attachCalls.push(sessionId);
            return leg.manager.attachViewer(sessionId);
          },
        },
      },
    );

    const subscriptions = 3;
    for (let index = 0; index < subscriptions; index += 1) {
      socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: leg.sessionId }] }));
    }

    const after = findBinding(leg)?.lastActivityAt;
    const host = findHost(leg);
    say(
      `(7) subscribe-attach-calls=${attachCalls.length} lastActivityAt-before=${before} ` +
        `lastActivityAt-after=${String(after)} idle-closed-at=${String(host.quietDeadlineAt)} ` +
        `expected=${String(deadlineBefore)}`,
    );
    assert.ok(attachCalls.length > 0, 'the real chat.subscribe path really reached the manager');
    assert.equal(attachCalls.length, subscriptions);
    assert.deepEqual(new Set(attachCalls), new Set([leg.sessionId]));
    assert.equal(after, before, 'attaching a viewer is not activity');
    assert.equal(host.quietDeadlineAt, deadlineBefore, 'the close time is still the original deadline');
    socket.emit('close');

    // Positive control: real activity *does* move both, so "unchanged" above is
    // about the attach path rather than about a clock that never moved.
    leg.clock.advance(HOUR_MS);
    leg.manager.noteActivity(leg.sessionId);
    const moved = findBinding(leg)?.lastActivityAt;
    const movedHost = findHost(leg);
    say(
      `(7) positive-control noteActivity lastActivityAt=${String(moved)} ` +
        `quietDeadlineAt=${String(movedHost.quietDeadlineAt)} expected=${String(deadlineBefore)}`,
    );
    assert.notEqual(moved, after);
    assert.equal(movedHost.quietDeadlineAt, (moved ?? 0) + RESIDENT_IDLE_TIMEOUT);
  }

  // ---- AC11 (8): the close reason, read through the production REST listing. ----
  {
    const leg = createLeg(`${SESSION}-8`);
    await beginRound(leg, '先说一句话');
    await endRound(leg);

    const app = express();
    app.use(express.json());
    app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager: leg.manager }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const listingFor = async (): Promise<{ status: number; host: AnyRecord | null }> => {
      const response = await fetch(`http://127.0.0.1:${port}/api/session-hosts`, {
        headers: { connection: 'close' },
      });
      const body = (await response.json()) as AnyRecord;
      const hosts = ((body.data as AnyRecord)?.hosts ?? []) as AnyRecord[];
      const host =
        hosts.find((candidate) =>
          ((candidate.bindings as AnyRecord[]) ?? []).some(
            (binding) => binding.appSessionId === leg.sessionId,
          ),
        ) ?? null;
      return { status: response.status, host };
    };

    try {
      const before = await listingFor();
      say(
        `(8) before-close status=${before.status} closeReason=${String(before.host?.closeReason)} ` +
          `state=${String(before.host?.state)}`,
      );
      assert.notEqual(before.host, null, 'the host is in the listing before it closes');
      assert.equal(before.status, 200);
      assert.equal(before.host?.closeReason, null);
      assert.notEqual(before.host?.state, 'closed');

      leg.clock.advance(RESIDENT_IDLE_TIMEOUT);
      const after = await listingFor();
      say(
        `(8) after-close status=${after.status} closeReason=${String(after.host?.closeReason)} ` +
          `state=${String(after.host?.state)} hostId=${findHost(leg).hostId}`,
      );
      assert.notEqual(after.host, null, 'a closed host stays in the listing for its retention window');
      assert.equal(after.status, 200);
      assert.equal(after.host?.closeReason, 'idle');
      assert.equal(after.host?.state, 'closed');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
});

// ---------------------------
//----------------- THE CRITERION'S OWN PROPERTIES ------------
/**
 * Two readings that are about this file rather than about the manager.
 *
 * `real-wait-primitives` counts the three primitives that would mean the
 * readings above came from a real clock — a 24-hour ceiling and a seven-day
 * expiry cannot be reached inside a minute by waiting, so their presence would
 * make every timing assertion above a reading of the machine rather than of the
 * policy. The patterns are assembled from fragments on purpose: compiling them
 * into the file as literals would make this check match itself, and a criterion
 * that fails its own rule is worse than no rule.
 *
 * `elapsed` is the wall clock the whole file took. Together with the injected
 * clock it is the evidence that the seam is load-bearing rather than decorative.
 */
after(() => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const forbidden = [
    ['set', 'Timeout'].join(''),
    ['await', ' ', 'sleep'].join(''),
    ['node:', 'timers'].join(''),
  ];
  const counts = forbidden.map((pattern) => source.split(pattern).length - 1);
  console.log(`idle real-wait-primitives=${counts.reduce((sum, count) => sum + count, 0)}`);
  for (const [index, pattern] of forbidden.entries()) {
    assert.equal(counts[index], 0, `the criterion contains a real-wait primitive: ${pattern}`);
  }

  const elapsed = Date.now() - FILE_STARTED_AT;
  console.log(`idle elapsed=${elapsed}ms`);
  assert.ok(elapsed < 60_000, `the criterion took ${elapsed}ms, which means it really waited`);
});

// ---------------------------
//----------------- THE TWO SOCKET-AND-RUNTIME DOUBLES ------------
/**
 * A socket the chat gateway can talk to, and a runtime it can ask about
 * permissions.
 *
 * Neither is the subject of this criterion: the chat connection is entered for
 * one thing only — that a `chat.subscribe` reaches the manager — and the runtime
 * is stubbed so the gateway's own bookkeeping (pending approvals for a session
 * with no run) answers instead of reaching a database.
 */
type FakeSocket = EventEmitter & {
  readyState: number;
  frames: AnyRecord[];
  send(data: string): void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as AnyRecord);
  };
  return socket;
}

function stubRuntime() {
  return {
    hasRuntime: () => true,
    run: async () => undefined,
    abort: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  };
}
