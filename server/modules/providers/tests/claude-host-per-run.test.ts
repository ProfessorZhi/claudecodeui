/**
 * Criterion for AC-159: Claude's per-run process lifetime is owned by the
 * session-host layer through a driver that reports what it can see and decides
 * nothing itself.
 *
 * The claim has two halves, and a criterion that only checked the first would be
 * satisfiable by a driver that is simply a copy of the runtime's own hold logic:
 *
 *  1. **Every reading falls out of the manager's state machine.** A backgrounded
 *     turn leaves the host `lingering` with the reason the driver reported; a new
 *     turn supersedes it as `superseded` (the manager's word, not the driver's);
 *     the quiet ceiling releases it as `released`; the held work notifies once.
 *  2. **The decision to hold was not re-implemented here.** Whether a message
 *     starts work outliving its turn is asked of the runtime's own
 *     `startsBackgroundWork`, and the window the hold is bounded by is the
 *     manager's policy, not a number the driver carries (AC9).
 *
 * Three things keep the readings attributable rather than incidental, and each
 * prints what it measured:
 *
 *  - The message fixtures are checked against the runtime's classifier first, so
 *    a leg cannot "pass" because its fixture asked for nothing (AC2).
 *  - The supersede leg's control asserts the reading names the *specific* reason
 *    and neither look-alike, so "closed at all" cannot pass (AC3).
 *  - The criterion's own source is checked for clock waits, its key readings are
 *    printed for byte-comparison across runs, and its wall clock is bounded
 *    (AC8). Time in this file moves only when a leg calls `advanceTo`: the clock
 *    and the deadline scheduler are both the injected `FakeClock`.
 *
 * The criterion also re-runs the two neighbouring criteria it leans on (AC6):
 * the runtime's own background-work criterion, unchanged, and the frame
 * passthrough parity criterion that pins the runtime's environment assembly.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudePerRunHostDriver } from '@/modules/providers/list/claude/claude-per-run-host-driver.provider.js';
import { startsBackgroundWork } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import {
  PER_RUN_QUIET_CEILING_MS,
  createSessionHostManager,
} from '@/modules/session-hosts/index.js';
import type {
  ClaudeBackgroundWorkEvent,
  ClaudeHostQueryFactory,
  ClaudeHostQueryStream,
} from '@/modules/providers/list/claude/claude-per-run-host-driver.provider.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import type { AnyRecord, ProcessHost } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CRITERION_PATH = 'server/modules/providers/tests/claude-host-per-run.test.ts';
const DRIVER_PATH = 'server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts';
/** The runtime criterion that pins the classifier this driver delegates to. */
const NEIGHBOUR_PATH = 'server/modules/providers/tests/claude-background-work.test.ts';
/** The runtime criterion that pins the environment assembly the driver must not disturb. */
const PARITY_PATH = 'server/modules/providers/tests/passthrough-parity.test.ts';
/**
 * The branch this criterion's `DRIVER_PATH`-in-the-delta invariant is decided on.
 *
 * That invariant — the delta this criterion reads must really be the delta that
 * produced this tree, and that delta is the one that added the driver — is
 * *this* criterion's own, and it is about *this* criterion's branch. The
 * reading it was asserted from, though, is `git diff --name-only develop...HEAD`,
 * a fact about whichever tree happens to be checked out: mechanical fan-in
 * checks every task out on `task/<task-id>`, and after it merges `develop` the
 * three-dot delta is exactly *that sibling's* delta, which for every task but
 * this one is a set of files that legitimately does not mention the driver. So
 * the assertion is scoped to the branch that owns it and, everywhere else, the
 * reading is still printed — with the branch name and the reason — and recorded
 * as not-applicable (`evaluated=false`) rather than silently skipped. Nothing
 * about the invariant is relaxed on the branch that owns it; the AC3 negative
 * control in the completion record is the worked example. Same shape as
 * `gap-debug-agent-ac10-reads-the-whole-branch-delta` (`CRITERION_OWNER_BRANCH`
 * in `debug-agent-host-driver.test.ts`).
 */
const CRITERION_OWNER_BRANCH = 'task/gap-session-hosts-claude-per-run-driver';
/** The graded invocation, so the sub-runs read the files exactly as the criterion is read. */
const TSX_PREFIX = ['tsx', '--tsconfig', 'server/tsconfig.json', '--test'];
/** Every harness starts its clock here, so a reading is a statement about this instant. */
const CLOCK = 1_700_000_000_000;
/** How many microtask hops `flush` yields: enough for the read loop and the input pump. */
const FLUSH_HOPS = 24;
/** The wall clock starts at import, so `elapsed` covers the whole file. */
const STARTED_AT = Date.now();

/**
 * The key readings, accumulated as the legs run and printed as one block.
 *
 * Every value in here is derived from the injected clock and the fixtures, never
 * from the wall clock or the host, which is what makes two runs of this file
 * byte-identical on the same tree (AC8) — and what makes a diff of two blocks a
 * statement about the criterion rather than about the machine.
 */
const keyLines: string[] = [];

/**
 * The manager's deadline seam, moved by hand.
 *
 * The manager never reaches for a timer itself; it asks this for a deadline.
 * That is what makes the quiet ceiling reachable without waiting it out, and it
 * is why `advanceTo` fires in deadline order and sets the clock to each deadline
 * before running it: a handler that schedules a follow-up deadline must see the
 * instant its own was due, not the instant the leg was aiming for.
 */
class FakeClock implements HostScheduler {
  private current: number;
  private serial = 0;
  private readonly pending = new Map<number, { at: number; run: () => void }>();

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  schedule(at: number, run: () => void): () => void {
    const handle = (this.serial += 1);
    this.pending.set(handle, { at, run });
    // Cancelling after the deadline fired must be a no-op, because the manager
    // cancels unconditionally when it closes a host and cannot know whether the
    // deadline just fired.
    return () => {
      this.pending.delete(handle);
    };
  }

  /** Moves to `at`, firing everything due on the way, then rests at `at`. */
  advanceTo(at: number): void {
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, deadline]) => deadline.at <= at)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      const next = due[0];
      if (!next) {
        break;
      }
      this.pending.delete(next[0]);
      this.current = next[1].at;
      next[1].run();
    }
    this.current = Math.max(this.current, at);
  }
}

/**
 * Lets every pending microtask run.
 *
 * The legs need this after a synchronous act — a deadline firing, a message
 * delivered — whose consequences travel through the driver's read loop and the
 * scripted process's input pump. The count is a fixed number of microtask hops
 * rather than a duration, so no reading can become a race with a machine's
 * speed.
 */
async function flush(): Promise<void> {
  for (let hop = 0; hop < FLUSH_HOPS; hop += 1) {
    await Promise.resolve();
  }
}

/**
 * One scripted process's message stream, pushed by the criterion.
 *
 * A pull-based queue rather than a pre-written array because the legs interleave
 * delivery with readings: a message arrives, the manager's state is read, the
 * next message arrives. `taken` is the barrier that makes those readings
 * attributable — it resolves once the consumer has actually pulled the pushed
 * message, so a leg never reads state that the delivery has not yet reached the
 * driver for.
 */
type MessageQueue = {
  push(message: AnyRecord): void;
  finish(): void;
  /** How many messages have been handed to the consumer. */
  handedOver(): number;
  /** Resolves once `count` messages have been handed to the consumer. */
  taken(count: number): Promise<void>;
  iterator(): AsyncIterator<AnyRecord>;
};

function createMessageQueue(): MessageQueue {
  const buffered: AnyRecord[] = [];
  const signal = new EventEmitter();
  // A small, deliberate number of waiters ride this one signal — one pull and one
  // barrier at a time — but the count is not something this criterion needs to
  // police, and a listener warning on stderr would be noise in the readings.
  signal.setMaxListeners(0);
  let handed = 0;
  let exhausted = false;

  async function next(): Promise<IteratorResult<AnyRecord>> {
    while (buffered.length === 0) {
      if (exhausted) {
        return { done: true, value: undefined };
      }
      await once(signal, 'wake');
    }
    handed += 1;
    const value = buffered.shift() as AnyRecord;
    signal.emit('taken');
    return { done: false, value };
  }

  return {
    push(message) {
      buffered.push(message);
      signal.emit('wake');
    },
    finish() {
      exhausted = true;
      signal.emit('wake');
    },
    handedOver: () => handed,
    async taken(count) {
      while (handed < count) {
        await once(signal, 'taken');
      }
    },
    iterator: () => ({ next }),
  };
}

/** One process the driver opened: what it was fed, and what was done to it. */
type ScriptedInstance = {
  queue: MessageQueue;
  /** How many prompt messages the driver built and handed over for this turn. */
  promptMessages: number;
  /** True once the driver released the held input — the CLI's stdin reached EOF. */
  inputEnded: boolean;
  /** How many times the driver interrupted this process. */
  interrupts: number;
  /** How many messages this leg has pushed to it. */
  pushed: number;
};

type ScriptedProcess = {
  factory: ClaudeHostQueryFactory;
  instances: ScriptedInstance[];
  latest(): ScriptedInstance;
  /** Hands one message to the newest process and waits until it has been taken. */
  deliver(message: AnyRecord): Promise<void>;
  /** Ends the newest process's message stream, as a process that exited would. */
  finish(): void;
};

/**
 * The process forge: the SDK's `query` replaced by a scripted stream.
 *
 * Injected through the driver's `createQuery` option rather than by mocking the
 * SDK module, because the driver takes its query factory as a constructor
 * argument — so the seam the criterion uses is the one production uses, and the
 * scripted process can report facts a real CLI would report (`inputEnded`,
 * `interrupts`) without any visibility into the driver.
 */
function createScriptedProcess(): ScriptedProcess {
  const instances: ScriptedInstance[] = [];

  const factory: ClaudeHostQueryFactory = (input) => {
    const instance: ScriptedInstance = {
      queue: createMessageQueue(),
      promptMessages: 0,
      inputEnded: false,
      interrupts: 0,
      pushed: 0,
    };
    instances.push(instance);

    // The prompt the driver built is read to its end, exactly as the CLI reads
    // its stdin: the pump finishing is what "the process was told to wind down"
    // looks like from outside the driver.
    const pump = (async () => {
      for await (const _message of input.prompt) {
        instance.promptMessages += 1;
      }
      instance.inputEnded = true;
    })();
    pump.catch(() => undefined);

    const stream: ClaudeHostQueryStream = {
      [Symbol.asyncIterator]: () => instance.queue.iterator(),
      async interrupt() {
        instance.interrupts += 1;
      },
    };
    return stream;
  };

  return {
    factory,
    instances,
    latest() {
      const last = instances[instances.length - 1];
      assert.ok(last, 'no query has been opened yet');
      return last;
    },
    async deliver(message) {
      const instance = this.latest();
      instance.pushed += 1;
      instance.queue.push(message);
      await instance.queue.taken(instance.pushed);
      await flush();
    },
    finish() {
      this.latest().queue.finish();
    },
  };
}

type Harness = {
  manager: SessionHostManager;
  clock: FakeClock;
  driver: ClaudePerRunHostDriver;
  process: ScriptedProcess;
  /** Every completion the driver reported, in order. */
  notifications: ClaudeBackgroundWorkEvent[];
};

/**
 * One manager, one clock, one driver and one scripted process, wired as the
 * provider mounts them — the manager as the driver's host port, the notification
 * replaced by an array so the count is the reading.
 */
function createHarness(): Harness {
  const clock = new FakeClock(CLOCK);
  let serial = 0;
  const manager = createSessionHostManager({
    now: () => clock.now(),
    scheduler: clock,
    createHostId: () => `h${(serial += 1)}`,
  });
  const process = createScriptedProcess();
  const notifications: ClaudeBackgroundWorkEvent[] = [];
  const driver = new ClaudePerRunHostDriver({
    host: manager,
    notify: (event) => {
      notifications.push(event);
    },
    createQuery: process.factory,
  });
  return { manager, clock, driver, process, notifications };
}

/** Drives one turn through the driver's own dispatch entry and returns its host. */
async function runTurn(harness: Harness, appSessionId: string, command: string): Promise<string> {
  const bound = await harness.driver.run(appSessionId, { command, options: { cwd: REPO_ROOT } });
  assert.ok(bound.ok, `the bind was refused: ${bound.ok ? 'ok' : bound.code}`);
  return bound.hostId;
}

function readHost(manager: SessionHostManager, hostId: string): ProcessHost {
  const host = manager.snapshot().find((candidate) => candidate.hostId === hostId);
  assert.ok(host, `host ${hostId} is not in the snapshot`);
  return host;
}

/**
 * The hosts still serving a session.
 *
 * A closed host keeps its binding record — the close writes a `detachReason`
 * into it rather than deleting it — so a count that did not filter on state
 * would report the superseded host as still serving the session.
 */
function liveBindings(manager: SessionHostManager, appSessionId: string): ProcessHost[] {
  return manager
    .snapshot()
    .filter((host) => host.state !== 'closed' && host.bindings.has(appSessionId));
}

/** The lease kinds one session's binding holds, in the order the manager keeps them. */
function leaseKinds(host: ProcessHost, appSessionId: string): string[] {
  const binding = host.bindings.get(appSessionId);
  assert.ok(binding, `host ${host.hostId} has no binding for ${appSessionId}`);
  return binding.leases.map((lease) => lease.kind);
}

/** One tool call, as the SDK reports it inside an assistant message. */
function toolMessage(name: string, input: AnyRecord, id: string): AnyRecord {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

/** The turn's terminal message. */
const RESULT: AnyRecord = { type: 'result', subtype: 'success' };
/** A Bash call that backgrounded itself: the canonical reason a process is held. */
const BACKGROUNDED_BASH: AnyRecord = toolMessage(
  'Bash',
  { command: 'true', run_in_background: true },
  'toolu_bg',
);
/** A watching tool: deferred by nature, and the reason the `monitor` kind is named. */
const MONITOR: AnyRecord = toolMessage('Monitor', {}, 'toolu_mon');
/** A foreground call that starts nothing: the control fixture. */
const READ_ONLY: AnyRecord = toolMessage('Read', { file_path: '/dev/null' }, 'toolu_read');

// ---------------------------
//----------------- READINGS ------------
test('AC2: a turn that starts work outliving itself leaves the host lingering', async () => {
  // The fixtures are checked against the runtime's own classifier before any leg
  // runs: a leg whose fixture classified as false would leave the host closing on
  // its turn's end, and a criterion that read only "some state changed" could
  // report that as the hold working.
  console.log(
    `classifier backgroundedBash=${startsBackgroundWork(BACKGROUNDED_BASH)} ` +
      `monitor=${startsBackgroundWork(MONITOR)} readOnly=${startsBackgroundWork(READ_ONLY)}`,
  );
  assert.equal(startsBackgroundWork(BACKGROUNDED_BASH), true);
  assert.equal(startsBackgroundWork(MONITOR), true);
  assert.equal(startsBackgroundWork(READ_ONLY), false);

  // Leg 1: a backgrounded Bash turn. The turn's own result must leave the host
  // held, with the reason the driver reported and not the turn's.
  const bash = createHarness();
  const bashHostId = await runTurn(bash, 'S-bash', 'run it in the background');
  await bash.process.deliver(BACKGROUNDED_BASH);
  await bash.process.deliver(RESULT);
  const bashHost = readHost(bash.manager, bashHostId);
  const bashReading =
    `afterResult state=${bashHost.state} leases=[${leaseKinds(bashHost, 'S-bash').join(',')}] ` +
    `inputStreamEnded=${bash.process.latest().inputEnded}`;
  console.log(bashReading);
  keyLines.push(bashReading);
  assert.equal(bashHost.state, 'lingering');
  assert.deepEqual(leaseKinds(bashHost, 'S-bash'), ['background-task']);
  assert.equal(bash.process.latest().inputEnded, false);

  // Leg 2: a watching tool holds the host under its own reason, so the manager's
  // two background reasons are both reachable rather than one being a synonym.
  const watched = createHarness();
  const watchedHostId = await runTurn(watched, 'S-monitor', 'watch it');
  await watched.process.deliver(MONITOR);
  await watched.process.deliver(RESULT);
  const watchedHost = readHost(watched.manager, watchedHostId);
  const watchedReading = `afterResult state=${watchedHost.state} leases=[${leaseKinds(watchedHost, 'S-monitor').join(',')}]`;
  console.log(watchedReading);
  keyLines.push(watchedReading);
  assert.equal(watchedHost.state, 'lingering');
  assert.deepEqual(leaseKinds(watchedHost, 'S-monitor'), ['monitor']);

  // Leg 3, the control: a turn that starts nothing leaves no reason behind, so
  // the manager closes the host on the turn's own end. Without this leg, a driver
  // that reported a hold for every message would pass the two above.
  const plain = createHarness();
  const plainHostId = await runTurn(plain, 'S-plain', 'just read it');
  await plain.process.deliver(READ_ONLY);
  await plain.process.deliver(RESULT);
  await flush();
  const plainHost = readHost(plain.manager, plainHostId);
  const plainReading =
    `noBackground state=${plainHost.state} closeReason=${plainHost.closeReason} ` +
    `inputStreamEnded=${plain.process.latest().inputEnded}`;
  console.log(plainReading);
  keyLines.push(plainReading);
  assert.equal(plainHost.state, 'closed');
  assert.equal(plainHost.closeReason, 'turn-complete');
  // The process was told to wind down as well: the close reaches the driver, and
  // the driver's release is what ends the input.
  assert.equal(plain.process.latest().inputEnded, true);
});

test('AC3: a new turn on a lingering session is the manager superseding it', async () => {
  const harness = createHarness();
  const firstHostId = await runTurn(harness, 'S-super', 'first');
  await harness.process.deliver(BACKGROUNDED_BASH);
  await harness.process.deliver(RESULT);
  assert.equal(readHost(harness.manager, firstHostId).state, 'lingering');
  const firstInstance = harness.process.latest();

  const secondHostId = await runTurn(harness, 'S-super', 'second');
  await flush();

  const oldHost = readHost(harness.manager, firstHostId);
  const newHost = readHost(harness.manager, secondHostId);
  const live = liveBindings(harness.manager, 'S-super');
  // Both counts, because a closed host keeps its binding record: the session is
  // served by exactly one process (`liveBindings`), while two host records still
  // name it. Printing one alone would hide which of the two is meant.
  const carrying = harness.manager
    .snapshot()
    .filter((host) => host.bindings.has('S-super')).length;
  const reading =
    `supersede old=${firstHostId} closeReason=${oldHost.closeReason} ` +
    `new=${secondHostId} state=${newHost.state} liveBindings=${live.length} ` +
    `hostRecordsCarryingTheBinding=${carrying}`;
  console.log(reading);
  keyLines.push(reading);
  // The old process was interrupted and its input ended, so the close did not
  // merely relabel the record: the process really was taken down.
  console.log(
    `supersede evidence oldInputEnded=${firstInstance.inputEnded} ` +
      `oldInterrupts=${firstInstance.interrupts}`,
  );
  assert.equal(oldHost.closeReason, 'superseded');
  assert.equal(newHost.state, 'busy');
  assert.equal(live.length, 1);
  assert.equal(carrying, 2);
  assert.equal(firstInstance.interrupts, 1);
  assert.equal(firstInstance.inputEnded, true);

  // Control: the reading names the *supersede* reason. If it contained either
  // look-alike — the ceiling's `released`, or the turn's own `turn-complete` —
  // then the assertion above would be reading a close the driver's own
  // bookkeeping produced rather than the policy's decision.
  const forbidden = ['released', 'turn-complete'].filter((token) => reading.includes(token));
  console.log(`supersede control forbiddenTokens=${forbidden.length} reading=<${reading}>`);
  assert.equal(forbidden.length, 0);
});

test('AC4: the quiet ceiling is the manager releasing a host it no longer needs', async () => {
  const harness = createHarness();
  const hostId = await runTurn(harness, 'S-quiet', 'hold it open');
  await harness.process.deliver(BACKGROUNDED_BASH);
  await harness.process.deliver(RESULT);
  const armed = readHost(harness.manager, hostId);
  console.log(
    `quiet deadline=+${(armed.quietDeadlineAt ?? 0) - CLOCK}ms ceiling=${PER_RUN_QUIET_CEILING_MS}`,
  );
  assert.equal((armed.quietDeadlineAt ?? 0) - CLOCK, PER_RUN_QUIET_CEILING_MS);

  // One minute short of the ceiling: still held, input still open.
  harness.clock.advanceTo(CLOCK + PER_RUN_QUIET_CEILING_MS - 60_000);
  await flush();
  const early = readHost(harness.manager, hostId);
  const earlyReading = `at29m state=${early.state} inputStreamEnded=${harness.process.latest().inputEnded}`;
  console.log(earlyReading);
  keyLines.push(earlyReading);
  assert.equal(early.state, 'lingering');
  assert.equal(harness.process.latest().inputEnded, false);

  // At the ceiling: the manager's own policy closes the host, and the close
  // reaches the driver as the ending of the held input.
  harness.clock.advanceTo(CLOCK + PER_RUN_QUIET_CEILING_MS);
  await flush();
  const late = readHost(harness.manager, hostId);
  const lateReading =
    `after30m state=${late.state} closeReason=${late.closeReason} ` +
    `inputStreamEnded=${harness.process.latest().inputEnded}`;
  console.log(lateReading);
  keyLines.push(lateReading);
  assert.equal(late.state, 'closed');
  assert.equal(late.closeReason, 'released');
  assert.equal(harness.process.latest().inputEnded, true);
});

test('AC5: the held work reports back exactly once, and then the host releases', async () => {
  const harness = createHarness();
  const hostId = await runTurn(harness, 'S-held', 'hold it open');
  await harness.process.deliver(BACKGROUNDED_BASH);
  await harness.process.deliver(RESULT);
  assert.equal(readHost(harness.manager, hostId).state, 'lingering');

  // A result arriving after the turn's own is the work the process was held for
  // reporting back: one notification, and the reason it was held goes away.
  await harness.process.deliver(RESULT);
  const host = readHost(harness.manager, hostId);
  const reading = `heldWork notifyCount=${harness.notifications.length} state=${host.state} closeReason=${host.closeReason}`;
  console.log(reading);
  keyLines.push(reading);
  assert.equal(harness.notifications.length, 1);
  assert.equal(host.state, 'closed');
  assert.equal(host.closeReason, 'released');
  // The report carries the session the work was for, which is what the
  // notification layer addresses a completion with.
  const [reported] = harness.notifications;
  assert.ok(reported, 'a hold reported back without notifying');
  assert.equal(reported.sessionId, 'S-held');
  assert.equal(reported.provider, 'claude');
  assert.equal(reported.appSessionId, 'S-held');

  // Control: a result pushed after the release must not notify a second time —
  // and it must really reach the driver, so the silence is the driver's
  // decision rather than a message nobody read. The queue's hand-over count is
  // what makes that distinguishable: it would not advance if the push were left
  // in the buffer.
  const instance = harness.process.latest();
  await harness.process.deliver(RESULT);
  const control = `heldWork control afterReleasePush notifyCount=${harness.notifications.length} pushed=${instance.pushed} taken=${instance.queue.handedOver()}`;
  console.log(control);
  keyLines.push(control);
  assert.equal(harness.notifications.length, 1);
  assert.equal(instance.queue.handedOver(), instance.pushed);
});

test('AC6: the criteria this one leans on are untouched and still green', () => {
  // The uncommitted delta, which is the reading the criterion is worded against.
  const workingTree = filesOf(gitMaybe(['diff', '--name-only']));
  // ...and the committed delta against develop, which is the stronger statement.
  // Best-effort: a checkout without a local `develop` (or a degenerate merge base,
  // which reports an empty delta) must not make this criterion red for a reason
  // that has nothing to do with the criterion it is measuring.
  const vsDevelopText = gitMaybe(['diff', '--name-only', 'develop...HEAD']);
  const vsDevelop = vsDevelopText === null ? null : filesOf(vsDevelopText);
  const driverExists = fs.existsSync(path.join(REPO_ROOT, DRIVER_PATH));

  // Which branch's delta the driver-in-delta reading is about. `develop...HEAD`
  // answers about the tree that is checked out, and that tree is not always this
  // criterion's own — see `CRITERION_OWNER_BRANCH`. Read here rather than inside
  // the assertion so the scope itself is a printed reading, not a branch test
  // buried in an `if`.
  const branch = gitMaybe(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'n/a';
  const driverInDeltaEvaluated = branch === CRITERION_OWNER_BRANCH;

  const containsNeighbour = workingTree.includes(NEIGHBOUR_PATH) ||
    (vsDevelop ?? []).includes(NEIGHBOUR_PATH);
  // The delta as the criterion sees it: the commits against develop plus the
  // uncommitted work. The union, so "the delta does not mention the driver"
  // cannot be reached by reading only the weaker half of it.
  const delta = vsDevelop === null ? null : [...new Set([...workingTree, ...vsDevelop])];
  const driverInDelta = delta === null ? 'n/a' : String(delta.includes(DRIVER_PATH));
  console.log(
    `gitDiff workingTreeFiles=${workingTree.length} ` +
      `vsDevelopFiles=${vsDevelop === null ? 'n/a' : vsDevelop.length} ` +
      `containsNeighbour=${containsNeighbour} driverExists=${driverExists} driverInDelta=${driverInDelta}`,
  );
  console.log(
    `[AC6] driverInDelta=${driverInDelta} evaluated=${driverInDeltaEvaluated} branch=${branch}`,
  );
  keyLines.push(`gitDiff containsNeighbour=${containsNeighbour} driverExists=${driverExists}`);
  if (!driverInDeltaEvaluated) {
    console.log(
      `[AC6] the develop-delta assertion is NOT evaluated here: this tree is on branch ${branch}, ` +
        `and that invariant is decided on ${CRITERION_OWNER_BRANCH}. A delta that does not name ` +
        `${DRIVER_PATH} on this branch is a sibling task's declared scope, not a violation of this ` +
        `criterion; the reading above is printed, not asserted.`,
    );
  }
  assert.equal(
    containsNeighbour,
    false,
    `the criterion modified the runtime's own criterion: ${NEIGHBOUR_PATH}`,
  );
  // The driver is in the tree the criterion measures, whether or not the delta it
  // was asked about can see it. Without this, an empty diff would satisfy the
  // assertion above while measuring nothing.
  assert.equal(driverExists, true, `the driver is not in the tree: ${DRIVER_PATH}`);
  // Only when the delta has something in it: an empty answer is the degenerate
  // reading (develop already contains this branch, or nothing is committed yet),
  // and the assertion above is then the only thing that can be said about it.
  // ...and only on the branch that owns this invariant: everywhere else the
  // reading is a statement about the sibling task checked out here, and is
  // printed (above) rather than asserted. `driverInDeltaEvaluated` is a printed
  // reading, never a silent skip.
  if (driverInDeltaEvaluated && delta !== null && delta.length > 0) {
    assert.equal(
      delta.includes(DRIVER_PATH),
      true,
      `the develop delta does not mention the driver, so it is not the delta being read: ${DRIVER_PATH}`,
    );
  }

  // The runtime criterion this driver's delegation must not have changed: the
  // same file, the same tally as before the driver existed.
  const neighbour = runTestFile(NEIGHBOUR_PATH);
  console.log(`neighbour ${NEIGHBOUR_PATH} exit=${neighbour.status} ${neighbour.tally}`);
  assert.equal(neighbour.fail, 0);
  assert.equal(neighbour.pass, 10);
  assert.equal(neighbour.status, 0);
  assert.equal(neighbour.tests, 10);

  // The parity criterion pins the runtime's environment assembly, which the
  // driver's reuse of the runtime's prompt builder must leave alone.
  const parity = runTestFile(PARITY_PATH);
  console.log(`parity ${PARITY_PATH} exit=${parity.status} ${parity.tally}`);
  assert.equal(parity.status, 0);
  assert.equal(parity.fail, 0);
});

test('AC9: the driver delegates the background-work decision and carries no ceiling', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, DRIVER_PATH), 'utf8');
  const references = matchingLineNumbers(source, 'startsBackgroundWork');
  console.log(`${DRIVER_PATH} startsBackgroundWorkLines=[${references.join(',')}]`);
  keyLines.push(`driver startsBackgroundWorkLines=${references.length}`);

  const ceilingLines = matchingLineNumbers(source, '1800000').length +
    matchingLineNumbers(source, '30 * 60').length +
    matchingLineNumbers(source, 'BG_WAIT_CEILING').length;
  const runInBackgroundLines = matchingLineNumbers(source, 'run_in_background').length;
  console.log(
    `driver ceilingLiterals=${ceilingLines} runInBackgroundLiterals=${runInBackgroundLines}`,
  );
  keyLines.push(`driver ceilingLiterals=${ceilingLines} runInBackgroundLiterals=${runInBackgroundLines}`);

  assert.ok(
    references.length > 0,
    'the driver does not consult the runtime classifier, so the hold decision is its own copy',
  );
  // The window the hold is bounded by is the manager's policy. A driver that
  // carried the number would be re-deciding when a hold ends, which is exactly
  // the duplication this criterion exists to rule out.
  assert.equal(matchingLineNumbers(source, '1800000').length, 0);
  assert.equal(matchingLineNumbers(source, '30 * 60').length, 0);
  assert.equal(matchingLineNumbers(source, 'BG_WAIT_CEILING').length, 0);
  // And the score of a tool call is asked of the runtime rather than re-read off
  // the call's own arguments here.
  assert.equal(runInBackgroundLines, 0);
});

test('AC8: the criterion waits on no clock, and its key readings are reproducible', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, CRITERION_PATH), 'utf8');
  // Assembled from fragments rather than written out. This file's own source is
  // what the check reads, so a literal needle here would be found by the check
  // itself — and by the `grep -c` the criterion is worded against — which would
  // turn the reading into a constant 1 and say nothing about whether there is a
  // clock wait. The fragments spell the same three needles without ever writing
  // one down.
  const needles = ['await' + ' new Promise', 'await' + ' sleep', 'set' + 'Timeout('];
  for (const needle of needles) {
    const count = matchingLineNumbers(source, needle).length;
    console.log(`criterionSource ${needle} -> lines=${count}`);
    keyLines.push(`criterionSource ${needle} lines=${count}`);
    assert.equal(count, 0, `the criterion contains a clock wait: ${needle}`);
  }

  const block = keyLines.join('\n');
  const digest = createHash('sha256').update(block).digest('hex').slice(0, 16);
  console.log(['--- key readings ---', block, '--- end key readings ---'].join('\n'));
  console.log(`keyReadings lines=${keyLines.length} sha256=${digest}`);

  const elapsed = Date.now() - STARTED_AT;
  console.log(`elapsed=${elapsed}ms`);
  assert.ok(elapsed < 60_000, `the criterion took ${elapsed}ms`);
});

// ---------------------------
//----------------- HELPERS ------------
/** The line numbers whose text contains `needle`, mirroring `grep -n`. */
function matchingLineNumbers(text: string, needle: string): number[] {
  const lines = text.split('\n');
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (line.includes(needle)) {
      found.push(index + 1);
    }
  });
  return found;
}

/**
 * Runs one git query against this checkout, or answers null if git refused.
 *
 * A refusal is not a failure of the criterion: the readings that use it are about
 * a delta, and a repository state where that delta cannot be computed (no such
 * ref, no merge base) says nothing about whether the criterion's neighbours were
 * modified. The caller prints which of the two it got.
 */
function gitMaybe(args: string[]): string | null {
  const result = spawnSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 ? (result.stdout ?? '').trim() : null;
}

/** The non-empty lines of a `--name-only` answer. */
function filesOf(text: string | null): string[] {
  return (text ?? '').split('\n').filter((line) => line.length > 0);
}

type TestRun = {
  status: number | null;
  tests: number;
  pass: number;
  fail: number;
  tally: string;
};

/**
 * Runs one of the repository's criteria through the graded invocation.
 *
 * A subprocess rather than an import, because the tally is the reading: the
 * neighbour criterion's own pass count is what says the classifier it pins is
 * still being exercised.
 */
function runTestFile(relativePath: string): TestRun {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  // A nested test run inherits this marker and changes what it reports; the
  // criterion wants the file's own tally, not the child's knowledge that it is
  // somebody's subtest.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync('npx', [...TSX_PREFIX, relativePath], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tests = tallyOf(output, 'tests');
  const pass = tallyOf(output, 'pass');
  const fail = tallyOf(output, 'fail');
  return {
    status: result.status,
    tests,
    pass,
    fail,
    tally: `tests=${tests} pass=${pass} fail=${fail}`,
  };
}

/** Reads one `ℹ <label> <n>` tally line out of a test runner's output. */
function tallyOf(output: string, label: string): number {
  const match = new RegExp(`^\\D*${label} (\\d+)`, 'm').exec(output);
  return match ? Number(match[1]) : -1;
}
