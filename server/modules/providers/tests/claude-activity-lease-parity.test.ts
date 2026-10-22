/**
 * Criterion for AC-195 — the Lease Deriver's frame-by-frame parity with the
 * resident driver's own held-work path.
 *
 * The claim is one sentence: the leases **derived** from the Task table (AC-191)
 * and the Schedule table (AC-192) equal, at every event of an ordered frame
 * sequence, the leases the existing resident path reports — the driver's
 * `observeHeldWorkEvent` + `reconcileHeldWork` + `inferHeldWork` (read through
 * `ClaudeResidentHostDriver.lifecycleReading`). The two paths **coexist**; this
 * criterion compares them and does not converge them, and the driver itself is
 * not touched.
 *
 * The sequence covers the four event classes the proposal names
 * (`docs/proposals/claude-session-activity-dock.md` §4):
 *
 *   0. **task nesting** — a parent `task_started` and a child
 *      `task_started{parent_tool_use_id}`; the child's terminal removes only the
 *      child (leg 1/3 below).
 *   1. **monitor stop** — `task_updated{status:'killed'}` plus
 *      `task_notification{status:'stopped'}` (leg 5).
 *   2. **cron and wakeup** — a `CronCreate` inferred lease, then a Stop hook
 *      whose `session_crons` names both a `recurring:true` job and a
 *      `recurring:false` wakeup (leg 2/6).
 *   3. **Stop-hook list changes** — a later list that no longer names an id drops
 *      it on both paths, including the "list no longer names a running task"
 *      (`ended`) calibration (leg 7).
 *
 * Two alignment obligations the parity forces (proposal §4 对齐义务) are read
 * directly:
 *
 *   · **monitor folds into `background-task`** — the resident path never
 *     produced a `monitor` lease (§5.4), so the derivation reproduces its shape
 *     and leg (5) reads the same `background-task` id on both sides.
 *   · **cron `expiresAt` is stable** — a job the CLI keeps naming keeps its
 *     first expiry on both paths; leg (7) advances the clock an hour and the
 *     lease's `expiresAt` is unchanged.
 *
 * The comparison is **per event**, not once at the end: a mismatch prints
 * `PARITY-MISMATCH at event #<i> (<label>)` with both lease sets and reds. Two
 * false-form arms (a deriver that leaks one class of terminal state each) reuse
 * the same reading function to prove the main comparison discriminates rather
 * than passing vacuously; if either arm also came out green the criterion would
 * have a hole.
 *
 * Determinism: the clock is a number the criterion owns, injected into the
 * driver, the manager *and* the schedule tracker, so every `expiresAt` is
 * comparable and no real waiting happens anywhere. The harness is the one
 * `claude-resident-idle.test.ts` builds (:107-365): a fake clock / fake resident
 * process / real `ClaudeResidentHostDriver` over a real `createSessionHostManager`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createClaudeScheduleTracker,
  createClaudeTaskReducer,
  deriveHeldWorkLeases,
} from '@/modules/providers/index.js';
import type { HeldWorkLeaseInput } from '@/modules/providers/index.js';
import {
  ClaudeResidentHostDriver,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type {
  HostScheduler,
  SessionBinding,
  SessionHostManager,
} from '@/modules/session-hosts/index.js';
import type {
  AnyRecord,
  HostLease,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const SESSION = 'ac195-lease-parity';
const HOUR_MS = 60 * 60 * 1000;

/** One line of this criterion's readings, prefixed so a reader can find them. */
function say(line: string): void {
  console.log(`parity ${line}`);
}

// ---------------------------
//----------------- FIXTURE SCAFFOLDING (from claude-resident-idle.test.ts) ----

/**
 * A scheduler whose deadlines are queue entries and whose clock is a number —
 * the same seam `claude-resident-idle.test.ts` (:117-154) injects. The manager
 * asks for an instant and this answers instantly, which is how the 24-hour idle
 * ceiling never fires during this sequence while the clock can still be moved
 * (leg 7) to exercise the cron expiry handoff.
 */
type FakeClock = HostScheduler & {
  now(): number;
  advance(ms: number): void;
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
  };
}

/** A resident process the criterion owns: a stream it pushes into, in order. */
type FakeProcess = {
  factory: ClaudeResidentProcessFactory;
  emit(frame: AnyRecord): void;
  stop(input: AnyRecord): void;
};

function createFakeProcess(): FakeProcess {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
  let stopSink: ((input: AnyRecord) => void) | null = null;

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
    // Never resolves with `done`: an iterable that finished would make the
    // driver call `reportExit` and close the host mid-sequence.
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  return {
    factory: (input) => {
      stopSink = input.seams?.onStop ?? null;
      return { query, pid: 4242 } satisfies ClaudeResidentProcess;
    },
    emit: (frame) => push(frame),
    stop: (input) => stopSink?.(input),
  };
}

/** The runtime's own turn inputs, stubbed to the facts the driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createWriter(): ProviderRuntimeWriter {
  return { send: () => undefined, setSessionId: () => undefined, userId: 1 };
}

/** One host's worth of fixture: a clock, a manager, a driver, and one process. */
type Leg = {
  clock: FakeClock;
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: FakeProcess;
  sessionId: string;
  rounds: Array<Promise<void>>;
};

function createLeg(): Leg {
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
  return { clock, manager, driver, process, sessionId: SESSION, rounds: [] };
}

/** Yields the microtask queue enough times for the read loop to drain a push. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 50; hop += 1) {
    await Promise.resolve();
  }
}

/** The manager's own copy of the binding this leg's session is on, or null. */
function findBinding(leg: Leg): SessionBinding | null {
  const host = leg.manager.snapshot().find((candidate) => candidate.bindings.has(leg.sessionId));
  return host?.bindings.get(leg.sessionId) ?? null;
}

/** Arms one real round and waits for its `turn` lease so frames will be read. */
async function beginRound(leg: Leg): Promise<void> {
  leg.rounds.push(leg.driver.run(leg.sessionId, { command: 'AC195', options: {} }, createWriter(), CONTEXT));
  for (let hop = 0; hop < 400; hop += 1) {
    if ((findBinding(leg)?.leases ?? []).some((lease) => lease.kind === 'turn')) {
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
  await round?.catch(() => undefined);
}

// ---------------------------
//----------------- FRAME / HOOK SHAPES (§9.3–9.5; idle leg sources) ----------

const E9_SESSION_ID = 'b827aab6-2114-4fe2-b1af-991a6c2285e1';

/** The parent background agent. Shape: `taskStartedFrame` (idle test :479). */
const PARENT_ID = 'bt_parent';
const PARENT_TOOL = 'toolu_parent';
/** The child nested under the parent's tool call. */
const CHILD_ID = 'bt_child';
const CHILD_TOOL = 'toolu_child';
/** The Monitor task — its `task_type` string is an inference (§1.1). */
const MONITOR_ID = 'bt_monitor';
const MONITOR_TOOL = 'toolu_monitor';
/** A task the Stop hook names before any event did — the snapshot backfill. */
const SNAP_ID = 'bt_snapshot';
/** §9.1's cron job id and the `CronCreate` tool call that made it. */
const CRON_ID = '5c79b8ae';
const CRON_TOOL = 'toolu_cron_195';
/** §9.1's one-shot wakeup, represented as a `recurring:false` cron entry. */
const WAKEUP_ID = '7263511e';

function taskStartedFrame(overrides: AnyRecord = {}): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: PARENT_ID,
    tool_use_id: PARENT_TOOL,
    description: 'parent agent',
    is_backgrounded: true,
    task_type: 'local_agent',
    uuid: randomUUID(),
    session_id: E9_SESSION_ID,
    ...overrides,
  };
}

function taskUpdatedFrame(overrides: AnyRecord = {}): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: MONITOR_ID,
    patch: { status: 'killed' },
    uuid: randomUUID(),
    session_id: E9_SESSION_ID,
    ...overrides,
  };
}

function taskNotificationFrame(overrides: AnyRecord = {}): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: MONITOR_ID,
    tool_use_id: MONITOR_TOOL,
    status: 'stopped',
    output_file: '/tmp/claude-1004/tasks/output',
    summary: 'monitor stopped',
    uuid: randomUUID(),
    session_id: E9_SESSION_ID,
    ...overrides,
  };
}

/** An `assistant` `tool_use` — the stream's own evidence of a tool call. */
function assistantToolUse(id: string, name: string, input: AnyRecord): AnyRecord {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    session_id: E9_SESSION_ID,
    uuid: randomUUID(),
  };
}

/** A `user` message carrying a `tool_result` paired to a `tool_use` id. */
function toolResultFrame(toolUseId: string, text: string): AnyRecord {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    session_id: E9_SESSION_ID,
    uuid: randomUUID(),
  };
}

function resultFrame(): AnyRecord {
  return { type: 'result', subtype: 'success', is_error: false, session_id: E9_SESSION_ID, uuid: randomUUID() };
}

/** §1.3/§9.1: the `CronCreate` result text naming the CLI's own job id. */
function cronCreateResult(): AnyRecord {
  return toolResultFrame(
    CRON_TOOL,
    `Scheduled recurring job ${CRON_ID} (Every 2 minutes). Session-only. ` +
      'Auto-expires after 7 days. Use CronDelete to cancel sooner.',
  );
}

/** §9.3: the Stop hook input, carrying the two authoritative lists. */
function stopHookInput(overrides: AnyRecord = {}): AnyRecord {
  return {
    session_id: E9_SESSION_ID,
    transcript_path: '/tmp/claude-1004/transcript.jsonl',
    cwd: '/tmp/parity',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'AC195-TICK',
    background_tasks: [],
    session_crons: [],
    ...overrides,
  };
}

/** §9.1: one `session_crons` entry. */
function cronEntry(id: string, schedule: string, recurring: boolean, prompt: string): AnyRecord {
  return { id, schedule, recurring, prompt };
}

/** §9.4: one `background_tasks` entry. */
function backgroundTask(id: string, type: string): AnyRecord {
  return { id, type, status: 'running', description: `${id} hold`, command: 'sleep 300' };
}

// ---------------------------
//----------------- THE EVENT SEQUENCE -----------------------------------------

/**
 * One event: a logical occurrence the criterion applies before reading. It is
 * atomic in the sense that a stop is one occurrence even when the CLI splits it
 * over two frames (`task_updated` then `task_notification`), and a tool call and
 * its result must both land before the schedule evidence exists at all — the
 * reading is taken once, after the whole event.
 */
type SequenceEvent = {
  label: string;
  frames?: AnyRecord[];
  /** Applied before the frames/hook, so a hook can be read at the moved clock. */
  advanceMs?: number;
  hook?: AnyRecord;
};

function buildEventSequence(): SequenceEvent[] {
  return [
    // (0) task nesting: the parent agent starts.
    {
      label: 'parent-start',
      frames: [
        taskStartedFrame({ task_id: PARENT_ID, tool_use_id: PARENT_TOOL, task_type: 'local_agent' }),
      ],
    },
    // (1) its child starts, nested through the parent's tool call.
    {
      label: 'child-start',
      frames: [
        taskStartedFrame({
          task_id: CHILD_ID,
          tool_use_id: CHILD_TOOL,
          parent_tool_use_id: PARENT_TOOL,
          task_type: 'local_bash',
          description: 'child bash',
        }),
      ],
    },
    // (2) the turn calls CronCreate and the CLI answers with the job id — one
    //     event, because the result text is where the schedule evidence lives.
    {
      label: 'cron-create',
      frames: [
        assistantToolUse(CRON_TOOL, 'CronCreate', {
          cron: '*/2 * * * *',
          prompt: 'cron-fired',
          recurring: true,
        }),
        cronCreateResult(),
      ],
    },
    // (3) the child ends; only the child's lease goes.
    {
      label: 'child-end',
      frames: [
        taskNotificationFrame({
          task_id: CHILD_ID,
          tool_use_id: CHILD_TOOL,
          status: 'completed',
          summary: 'child done',
        }),
      ],
    },
    // (4) a Monitor task starts (its `task_type` string is an inference).
    {
      label: 'monitor-start',
      frames: [
        taskStartedFrame({
          task_id: MONITOR_ID,
          tool_use_id: MONITOR_TOOL,
          task_type: 'monitor',
          description: 'monitor poll',
        }),
      ],
    },
    // (5) the Monitor stops — the CLI's own two-frame stop sequence.
    {
      label: 'monitor-stop',
      frames: [
        taskUpdatedFrame({ task_id: MONITOR_ID, patch: { status: 'killed' } }),
        taskNotificationFrame({
          task_id: MONITOR_ID,
          tool_use_id: MONITOR_TOOL,
          status: 'stopped',
          summary: 'monitor stopped',
        }),
      ],
    },
    // (6) the Stop hook: the authoritative cron list (a recurring job and a
    //     one-shot wakeup) and the background-task list (the parent plus a task
    //     the events never named — the snapshot backfill).
    {
      label: 'cron-hook',
      hook: stopHookInput({
        session_crons: [
          cronEntry(CRON_ID, '*/2 * * * *', true, 'cron-fired'),
          cronEntry(WAKEUP_ID, '58 20 * * *', false, 'wake-fired'),
        ],
        background_tasks: [backgroundTask(PARENT_ID, 'agent'), backgroundTask(SNAP_ID, 'shell')],
      }),
    },
    // (7) an hour later the list stops naming the wakeup and the two tasks —
    //     the "no longer named = terminal" calibration, and the cron's expiry
    //     stability across the moved clock.
    {
      label: 'list-change',
      advanceMs: HOUR_MS,
      hook: stopHookInput({
        session_crons: [cronEntry(CRON_ID, '*/2 * * * *', true, 'cron-fired')],
        background_tasks: [],
      }),
    },
  ];
}

// ---------------------------
//----------------- THE COMPARISON ---------------------------------------------

/** The derivation under test: tables in, held-work leases out. */
type LeaseDeriver = (input: HeldWorkLeaseInput) => HostLease[];

/**
 * The normalized comparison key (`kind|id|recurring|expiresAt|inferred`).
 * Fields a kind does not carry normalize to the empty string / `false`, so the
 * same function is applied to both sides and a missing field can never look
 * like a difference.
 */
function leaseKey(lease: HostLease): string {
  const id = 'id' in lease ? lease.id : '';
  const recurring = lease.kind === 'cron' ? String(lease.recurring) : '';
  const expiresAt = lease.kind === 'cron' ? String(lease.expiresAt) : '';
  const inferred =
    lease.kind === 'cron' || lease.kind === 'background-task' || lease.kind === 'monitor'
      ? String(lease.inferred === true)
      : '';
  return `${lease.kind}|${id}|${recurring}|${expiresAt}|${inferred}`;
}

function sortedKeys(leases: HostLease[]): string[] {
  return leases.map(leaseKey).sort();
}

/** One event's reading: both lease sets, raw and keyed. */
type EventReading = {
  index: number;
  label: string;
  existing: HostLease[];
  derived: HostLease[];
};

/** Thrown at the first event whose two lease sets differ. */
class ParityMismatch extends Error {
  readonly index: number;
  constructor(index: number, label: string, existing: HostLease[], derived: HostLease[]) {
    super(
      `PARITY-MISMATCH at event #${index} (${label}): ` +
        `existing=[${sortedKeys(existing).join(', ')}] derived=[${sortedKeys(derived).join(', ')}]`,
    );
    this.name = 'ParityMismatch';
    this.index = index;
  }
}

/** The driver's own held-work reading: its crons and its background tasks. */
function driverLeases(leg: Leg): HostLease[] {
  const reading = leg.driver.lifecycleReading(leg.sessionId);
  if (!reading) {
    throw new Error('the resident host has no lifecycle reading');
  }
  return [...reading.crons, ...reading.backgroundTasks];
}

/** The result of one full sequence run, for the main case's own assertions. */
type ParityRun = {
  readings: EventReading[];
  finalTasks: ReturnType<ReturnType<typeof createClaudeTaskReducer>['getTasks']>;
};

/**
 * Applies every event of the sequence to *both* paths — the live driver and the
 * two reducers — and compares their lease sets after each. Throws at the first
 * mismatch (after printing it); returns the per-event readings otherwise.
 */
async function runParitySequence(deriver: LeaseDeriver): Promise<ParityRun> {
  const leg = createLeg();
  const reducer = createClaudeTaskReducer();
  const tracker = createClaudeScheduleTracker({ now: () => leg.clock.now() });
  const events = buildEventSequence();
  const readings: EventReading[] = [];
  let failure: unknown = null;

  await beginRound(leg);
  try {
    for (const [index, event] of events.entries()) {
      if (event.advanceMs) {
        leg.clock.advance(event.advanceMs);
      }
      for (const frame of event.frames ?? []) {
        leg.process.emit(frame);
        reducer.observe(leg.sessionId, frame);
        tracker.observe(leg.sessionId, frame);
        await settle();
      }
      if (event.hook) {
        leg.process.stop(event.hook);
        const backgroundTasks = event.hook.background_tasks;
        if (Array.isArray(backgroundTasks)) {
          reducer.reconcileStopHook(leg.sessionId, backgroundTasks as never);
        }
        const sessionCrons = event.hook.session_crons;
        if (Array.isArray(sessionCrons)) {
          tracker.reconcileStopHook(leg.sessionId, sessionCrons as never);
        }
        await settle();
      }

      const existing = driverLeases(leg);
      const derived = deriver({
        tasks: reducer.getTasks(leg.sessionId),
        schedules: tracker.getSchedules(leg.sessionId),
        now: leg.clock.now(),
      });
      const reading: EventReading = { index, label: event.label, existing, derived };
      readings.push(reading);
      say(
        `#${index} ${event.label} existing=[${sortedKeys(existing).join(', ')}] ` +
          `derived=[${sortedKeys(derived).join(', ')}]`,
      );
      if (JSON.stringify(sortedKeys(existing)) !== JSON.stringify(sortedKeys(derived))) {
        throw new ParityMismatch(index, event.label, existing, derived);
      }
    }
  } catch (error) {
    failure = error;
  }
  await endRound(leg);
  if (failure) {
    throw failure;
  }
  return { readings, finalTasks: reducer.getTasks(leg.sessionId) };
}

/** The reading at one event label, or a failure naming it. */
function readingAt(readings: EventReading[], label: string): EventReading {
  const reading = readings.find((candidate) => candidate.label === label);
  if (!reading) {
    throw new Error(`no reading for event ${label}`);
  }
  return reading;
}

/** `id`s of the background-task leases in a reading. */
function backgroundIds(leases: HostLease[]): string[] {
  return leases
    .filter((lease): lease is Extract<HostLease, { kind: 'background-task' | 'monitor' }> =>
      lease.kind === 'background-task' || lease.kind === 'monitor',
    )
    .map((lease) => lease.id)
    .sort();
}

/** The `cron` leases in a reading. */
function cronLeases(leases: HostLease[]): Array<Extract<HostLease, { kind: 'cron' }>> {
  return leases.filter((lease): lease is Extract<HostLease, { kind: 'cron' }> => lease.kind === 'cron');
}

// ---------------------------
//----------------- THE CRITERION ----------------------------------------------

test('AC1/AC2: the derived leases equal the driver reading at every event', async () => {
  const run = await runParitySequence(deriveHeldWorkLeases);

  say(`events=${run.readings.length} all-equal=true`);
  assert.equal(run.readings.length, buildEventSequence().length, 'every event was applied and compared');

  // Positive control: at least one event's two sets are both non-empty and
  // equal, so "equal at every event" is not a vacuous equality of two empties.
  const positive = readingAt(run.readings, 'cron-create');
  assert.ok(positive.existing.length > 0, 'the positive control event holds leases on the driver path');
  assert.ok(positive.derived.length > 0, 'the positive control event holds leases on the derived path');
  assert.deepEqual(sortedKeys(positive.existing), sortedKeys(positive.derived));
  say(`positive-control #${positive.index} ${positive.label} non-empty and equal (count=${positive.existing.length})`);
});

test('AC4: the cron list (recurring + wakeup) and the inferred tool-call lease agree', async () => {
  const run = await runParitySequence(deriveHeldWorkLeases);

  // Before the hook: the CronCreate tool call is an inferred `cron` lease, keyed
  // by the SDK tool_use id (the driver's inferHeldWork key) on both paths.
  const inferredEvent = readingAt(run.readings, 'cron-create');
  const existingInferred = cronLeases(inferredEvent.existing);
  const derivedInferred = cronLeases(inferredEvent.derived);
  assert.equal(existingInferred.length, 1, 'the driver inferred one cron lease from the tool call');
  assert.equal(derivedInferred.length, 1, 'the derivation projected one cron lease from the table');
  assert.equal(existingInferred[0].id, CRON_TOOL);
  assert.equal(existingInferred[0].inferred, true, 'the driver flags the tool-call lease inferred');
  assert.equal(derivedInferred[0].id, CRON_TOOL, 'the derived lease is keyed by the tool_use id until the hook names it');
  assert.equal(derivedInferred[0].inferred, true, "a source:'tool-call' schedule derives inferred === true");
  say(
    `AC4 inferred existing.id=${existingInferred[0].id} inferred=${existingInferred[0].inferred === true} ` +
      `derived.id=${derivedInferred[0].id} inferred=${derivedInferred[0].inferred === true} ` +
      `expiresAt-equal=${existingInferred[0].expiresAt === derivedInferred[0].expiresAt}`,
  );
  assert.equal(existingInferred[0].expiresAt, derivedInferred[0].expiresAt, 'the shared clock dates both identically');

  // After the hook: both paths hold the recurring job and the one-shot wakeup
  // under the CLI's own ids, item for item.
  const hookEvent = readingAt(run.readings, 'cron-hook');
  const existingCrons = cronLeases(hookEvent.existing).sort((a, b) => a.id.localeCompare(b.id));
  const derivedCrons = cronLeases(hookEvent.derived).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    existingCrons.map((lease) => [lease.id, lease.recurring]),
    [[CRON_ID, true], [WAKEUP_ID, false]],
    'the driver holds the recurring job and the one-shot wakeup from the list',
  );
  assert.deepEqual(
    derivedCrons.map((lease) => [lease.id, lease.recurring]),
    [[CRON_ID, true], [WAKEUP_ID, false]],
    'the derivation holds the same two, recurring flags equal',
  );
  assert.deepEqual(
    derivedCrons.map((lease) => lease.expiresAt),
    existingCrons.map((lease) => lease.expiresAt),
    'expiresAt is equal item for item',
  );
  say(
    `AC4 hook existing=${existingCrons.map((l) => `${l.id}:${l.recurring}:${l.expiresAt}`).join(',')} ` +
      `derived=${derivedCrons.map((l) => `${l.id}:${l.recurring}:${l.expiresAt}`).join(',')}`,
  );
});

test('AC5: the monitor lease disappears on both paths at the stop event', async () => {
  const run = await runParitySequence(deriveHeldWorkLeases);

  const started = readingAt(run.readings, 'monitor-start');
  assert.ok(
    backgroundIds(started.existing).includes(MONITOR_ID),
    'the driver holds the monitor as a background-task lease while it runs',
  );
  assert.ok(
    backgroundIds(started.derived).includes(MONITOR_ID),
    'the derivation folds the monitor kind into a background-task lease',
  );

  const stopped = readingAt(run.readings, 'monitor-stop');
  assert.ok(!backgroundIds(stopped.existing).includes(MONITOR_ID), 'the stop dropped the driver lease');
  assert.ok(!backgroundIds(stopped.derived).includes(MONITOR_ID), 'the stop dropped the derived lease');
  say(
    `AC5 monitor-start existing=[${backgroundIds(started.existing).join(',')}] ` +
      `derived=[${backgroundIds(started.derived).join(',')}] | ` +
      `monitor-stop #${stopped.index} existing=[${backgroundIds(stopped.existing).join(',')}] ` +
      `derived=[${backgroundIds(stopped.derived).join(',')}]`,
  );
});

test('AC6: nested tasks both hold, and the child terminal removes only the child', async () => {
  const run = await runParitySequence(deriveHeldWorkLeases);

  const nested = readingAt(run.readings, 'child-start');
  assert.deepEqual(backgroundIds(nested.existing), [CHILD_ID, PARENT_ID]);
  assert.deepEqual(backgroundIds(nested.derived), [CHILD_ID, PARENT_ID], 'parent and child both held on both paths');

  const ended = readingAt(run.readings, 'child-end');
  assert.deepEqual(backgroundIds(ended.existing), [PARENT_ID], 'the child terminal removes only the child');
  assert.deepEqual(backgroundIds(ended.derived), [PARENT_ID], 'the parent stays held on both paths');
  say(
    `AC6 child-start existing=[${backgroundIds(nested.existing).join(',')}] derived=[${backgroundIds(nested.derived).join(',')}] | ` +
      `child-end existing=[${backgroundIds(ended.existing).join(',')}] derived=[${backgroundIds(ended.derived).join(',')}]`,
  );
});

test('AC7: a list that stops naming an id drops it on both paths, and the cron keeps its expiry', async () => {
  const run = await runParitySequence(deriveHeldWorkLeases);

  const hook = readingAt(run.readings, 'cron-hook');
  assert.deepEqual(backgroundIds(hook.existing), [PARENT_ID, SNAP_ID]);
  assert.deepEqual(backgroundIds(hook.derived), [PARENT_ID, SNAP_ID], 'the snapshot backfill agrees on both paths');

  const after = readingAt(run.readings, 'list-change');
  assert.deepEqual(backgroundIds(after.existing), [], 'the driver dropped the ids the list no longer names');
  assert.deepEqual(backgroundIds(after.derived), [], 'the derivation dropped them too (the ended calibration)');
  assert.ok(
    run.finalTasks.some((task) => task.state === 'ended'),
    'the Task table really reached the ended state — the calibration is the path being read',
  );

  const cronBefore = cronLeases(hook.existing).find((lease) => lease.id === CRON_ID);
  const cronAfter = cronLeases(after.existing).find((lease) => lease.id === CRON_ID);
  const derivedAfter = cronLeases(after.derived).find((lease) => lease.id === CRON_ID);
  assert.ok(cronBefore && cronAfter && derivedAfter, 'the kept cron is present on both paths');
  assert.equal(cronAfter.expiresAt, cronBefore.expiresAt, 'the driver kept the first expiry across the moved clock');
  assert.equal(derivedAfter.expiresAt, cronBefore.expiresAt, 'the derivation kept the same first expiry');
  say(
    `AC7 list-change existing=[${backgroundIds(after.existing).join(',')}] derived=[${backgroundIds(after.derived).join(',')}] ` +
      `endedStates=${run.finalTasks.filter((task) => task.state === 'ended').length} ` +
      `cron.expiresAt-stable=${cronAfter.expiresAt === cronBefore.expiresAt && derivedAfter.expiresAt === cronBefore.expiresAt}`,
  );
});

test('AC3/AC8: two derivation false forms each red the parity at their own event', async () => {
  // (i) a deriver that leaks `stopped` misses the task_notification terminal →
  //     the monitor stays in the derived set at the stop event.
  const leakStopped: LeaseDeriver = (input) =>
    deriveHeldWorkLeases(input, { leakTerminalStates: ['stopped'] });
  let stoppedError: unknown = null;
  try {
    await runParitySequence(leakStopped);
  } catch (error) {
    stoppedError = error;
  }
  say(`AC8 false form (i) red=${stoppedError instanceof ParityMismatch} error=${String((stoppedError as Error)?.message)}`);
  assert.ok(stoppedError instanceof ParityMismatch, 'the leak-stopped arm must red the parity');
  assert.equal(stoppedError.index, 5, 'it reds at the monitor-stop event');
  assert.match(stoppedError.message, /PARITY-MISMATCH at event #5 \(monitor-stop\)/);

  // (ii) a deriver that leaks `ended` misses the "the list no longer names it"
  //      terminal → the tasks stay in the derived set at the list-change event.
  const leakEnded: LeaseDeriver = (input) =>
    deriveHeldWorkLeases(input, { leakTerminalStates: ['ended'] });
  let endedError: unknown = null;
  try {
    await runParitySequence(leakEnded);
  } catch (error) {
    endedError = error;
  }
  say(`AC8 false form (ii) red=${endedError instanceof ParityMismatch} error=${String((endedError as Error)?.message)}`);
  assert.ok(endedError instanceof ParityMismatch, 'the leak-ended arm must red the parity');
  assert.equal(endedError.index, 7, 'it reds at the list-change event');
  assert.match(endedError.message, /PARITY-MISMATCH at event #7 \(list-change\)/);
});
