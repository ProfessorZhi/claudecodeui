/**
 * Criterion for the lease-driven host lifecycle (AC-157).
 *
 * Drives the real manager (`createSessionHostManager`) directly — no provider, no
 * CLI, no database — through a forged host driver and an injected clock, so every
 * reading below is a reading of the production state machine rather than of a
 * test double of it. What is proven:
 *
 *   (1) `per-run`: a host's state is derived from the union of its leases, not
 *       from a turn's open/closed switch. A `turn` lease makes it `busy`; with
 *       no `turn` lease but a `background-task` it is `lingering` (the state the
 *       switch-shaped implementation cannot produce); releasing the last reason
 *       closes it, and the close reason names which reason went away.
 *   (2) `resident`: `resident-policy` holds the host `idle` rather than
 *       closable, and the idle ceiling — 24 hours on the shipped policy — ends
 *       it. A live `cron` lease defers that close and the window is re-counted
 *       from the cron's own `expiresAt`.
 *   (3) a browser attaching is not activity: `attachViewer` never moves
 *       `lastActivityAt` (with `noteActivity` beside it as the positive control
 *       that the invariant is not vacuously true).
 *   (4) a driver-reported exit carries its detail (`oom`), and is distinguishable
 *       from an abort.
 *   (5) `shutdown()` closes every host as `server-shutdown`, forces the ones
 *       whose driver never settles, and does not resolve before they are closed.
 *   (6) every member of `HOST_CLOSE_REASONS` is produced by a named case.
 *
 * Determinism: the clock is a value the test owns and the scheduler is a queue
 * the test drains, so there is no real waiting anywhere in this file and the
 * 24-hour ceiling is reached in microseconds. The manager reaches the wall clock
 * only through the two seams those replace.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import {
  DEFAULT_PER_RUN_POLICY,
  DEFAULT_RESIDENT_POLICY,
  HOST_CLOSE_REASONS,
  PER_RUN_QUIET_CEILING_MS,
  RESIDENT_IDLE_TIMEOUT,
  createSessionHostManager,
} from '@/modules/session-hosts/index.js';
import type { HostScheduler, ProcessHost } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type { HostCloseReason, LLMProvider } from '@/shared/types.js';

const PROVIDER: LLMProvider = 'claude';
const FILE_STARTED_AT = Date.now();

// ---------------------------
//----------------- FIXTURE SCAFFOLDING ------------
/**
 * A scheduler whose deadlines are queue entries and whose clock is a number.
 *
 * `advance` moves the clock first and then drains every entry that came due, in
 * deadline order, so a callback that re-arms (the cron deferral below) is
 * ordered by the deadline it named rather than by when it was scheduled. This is
 * the seam that makes a 24-hour policy threshold reachable: the manager asks for
 * an instant, and this answers instantly.
 */
type FakeClock = HostScheduler & {
  /** The current instant, as the manager sees it. */
  now(): number;
  /** Moves the clock forward and fires everything that came due, oldest first. */
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
        // Spend before running: a one-shot fires once even if the callback
        // re-reads the queue, and a re-arm registers a fresh entry.
        due.spent = true;
        due.run();
      }
    },
    pending: () => entries.filter((entry) => !entry.spent).length,
  };
}

/** A driver the test owns: it reports through the sink and can refuse to settle. */
type FakeDriver = IProviderHostDriver & {
  /** The sink the manager handed over at `startHost`, or null before one was started. */
  sink: IProviderHostDriverSink | null;
  /** Every `closeHost` the manager asked for, in order. */
  closed: Array<{ hostId: string; reason: HostCloseReason }>;
};

function createFakeDriver(settles: (host: ProcessHost) => boolean = () => true): FakeDriver {
  const driver: FakeDriver = {
    sink: null,
    closed: [],
    async startHost(host, sink) {
      driver.sink = sink;
      return host;
    },
    async bind() {
      // Binding is a process action; the manager's record is already written.
    },
    async submit() {
      // Turns are not part of this criterion.
    },
    async interrupt() {
      return true;
    },
    async reconfigure() {
      return 'live';
    },
    async unbind() {
      // Session detach is AC-158's subject.
    },
    async closeHost(host, reason) {
      driver.closed.push({ hostId: host.hostId, reason });
      if (!settles(host)) {
        // A driver that never answers: the shape `shutdown()` must survive.
        return new Promise<void>(() => {});
      }
    },
  };
  return driver;
}

function createManager(clock: FakeClock) {
  return createSessionHostManager({ now: () => clock.now(), scheduler: clock });
}

/** Reads one host out of the manager's own read port, refusing a missing id. */
function readHost(manager: ReturnType<typeof createSessionHostManager>, hostId: string): ProcessHost {
  const host = manager.snapshot().find((candidate) => candidate.hostId === hostId);
  assert.ok(host, `host ${hostId} is missing from snapshot()`);
  return host;
}

function bindingOf(host: ProcessHost, appSessionId: string) {
  const binding = host.bindings.get(appSessionId);
  assert.ok(binding, `host ${host.hostId} has no binding for ${appSessionId}`);
  return binding;
}

function leaseKinds(host: ProcessHost, appSessionId: string): string {
  return bindingOf(host, appSessionId).leases.map((lease) => lease.kind).join('+') || 'none';
}

/**
 * Every close reason any case produced, mapped to the case that produced it.
 *
 * A module-level record rather than a per-test one because the enumeration leg
 * is the last test in the file and asserts over what all the earlier legs saw —
 * which is what makes "the set of produced reasons covers the whole enum" a
 * statement about the cases rather than about a literal list typed twice.
 */
const reasonsSeen = new Map<HostCloseReason, string>();

function recordReason(
  manager: ReturnType<typeof createSessionHostManager>,
  hostId: string,
  caseName: string,
): HostCloseReason {
  const host = readHost(manager, hostId);
  assert.ok(host.closeReason, `${caseName}: host ${hostId} was never closed`);
  reasonsSeen.set(host.closeReason, caseName);
  return host.closeReason;
}

// ---------------------------
//----------------- (1) PER-RUN IS LEASE-DRIVEN ------------
test('AC3: a per-run host is derived from its leases, and the last reason released names the close', async () => {
  const clock = createFakeClock();
  const manager = createManager(clock);
  const driver = createFakeDriver();

  console.log(
    `per-run-policy supersedeOnNewTurn=${DEFAULT_PER_RUN_POLICY.supersedeOnNewTurn} ` +
      `closeWhenLeasesEmpty=${DEFAULT_PER_RUN_POLICY.closeWhenLeasesEmpty} ` +
      `quietCeilingMs=${DEFAULT_PER_RUN_POLICY.quietCeilingMs}`,
  );

  // (a) the turn reason appears -> busy.
  const a = await manager.openHost({
    provider: PROVIDER,
    mode: 'per-run',
    appSessionId: 'ac157-pr-a',
    driver,
  });
  console.log(`per-run-a opened state=${readHost(manager, a.hostId).state}`);
  assert.equal(readHost(manager, a.hostId).state, 'starting');

  driver.sink?.leaseAdded('ac157-pr-a', { kind: 'turn', runId: 'run-a' });
  const busy = readHost(manager, a.hostId);
  console.log(`per-run-a turn-added state=${busy.state} leases=${leaseKinds(busy, 'ac157-pr-a')}`);
  assert.equal(busy.state, 'busy');

  // (b) the turn reason goes away with nothing else holding it.
  driver.sink?.leaseRemoved('ac157-pr-a', 'turn');
  const completed = readHost(manager, a.hostId);
  console.log(
    `per-run-b turn-released state=${completed.state} closeReason=${completed.closeReason}`,
  );
  assert.equal(completed.state, 'closed');
  assert.equal(completed.closeReason, 'turn-complete');
  recordReason(manager, a.hostId, 'AC3 turn released with nothing else holding');

  // (c) the turn reason goes away while a background task still holds it. A
  // switch-shaped implementation closes the host here, which is the failure the
  // criterion exists to catch.
  const c = await manager.openHost({
    provider: PROVIDER,
    mode: 'per-run',
    appSessionId: 'ac157-pr-c',
    driver,
  });
  driver.sink?.leaseAdded('ac157-pr-c', { kind: 'turn', runId: 'run-c' });
  driver.sink?.leaseAdded('ac157-pr-c', { kind: 'background-task', id: 'bg-c' });
  driver.sink?.leaseRemoved('ac157-pr-c', 'turn');
  const lingering = readHost(manager, c.hostId);
  console.log(
    `per-run-c turn-released-while-held state=${lingering.state} leases=${leaseKinds(lingering, 'ac157-pr-c')}`,
  );
  assert.equal(lingering.state, 'lingering');
  assert.equal(lingering.closeReason, null);
  assert.equal(leaseKinds(lingering, 'ac157-pr-c'), 'background-task');

  driver.sink?.leaseRemoved('ac157-pr-c', 'background-task');
  const released = readHost(manager, c.hostId);
  console.log(
    `per-run-c held-released state=${released.state} closeReason=${released.closeReason}`,
  );
  assert.equal(released.state, 'closed');
  assert.equal(released.closeReason, 'released');
  recordReason(manager, c.hostId, 'AC3 background task released with nothing else holding');

  // (d) the same lingering host, but with nobody releasing it: the quiet ceiling
  // closes it, at the deadline rather than at the end of the advance.
  const d = await manager.openHost({
    provider: PROVIDER,
    mode: 'per-run',
    appSessionId: 'ac157-pr-d',
    driver,
  });
  driver.sink?.leaseAdded('ac157-pr-d', { kind: 'turn', runId: 'run-d' });
  driver.sink?.leaseAdded('ac157-pr-d', { kind: 'background-task', id: 'bg-d' });
  driver.sink?.leaseRemoved('ac157-pr-d', 'turn');
  const armed = readHost(manager, d.hostId);
  const deadline = armed.quietDeadlineAt;
  assert.ok(typeof deadline === 'number', 'the quiet ceiling was never armed');
  console.log(
    `per-run-d quiet-armed window-start=${armed.quietWindowStartAt} deadline=${deadline} ` +
      `(= window-start + ${PER_RUN_QUIET_CEILING_MS})`,
  );
  assert.equal(deadline, armed.quietWindowStartAt! + PER_RUN_QUIET_CEILING_MS);

  // Positive control for the ceiling itself: one millisecond early it is still
  // held, so the close below is the deadline's doing and not a constant.
  clock.advance(deadline - 1 - clock.now());
  const early = readHost(manager, d.hostId);
  console.log(`per-run-d at-deadline-minus-1 state=${early.state} pending=${clock.pending()}`);
  assert.equal(early.state, 'lingering');

  clock.advance(1);
  const quietClosed = readHost(manager, d.hostId);
  console.log(
    `per-run-d quiet-closed-at=${clock.now()} deadline=${deadline} ` +
      `closeReason=${quietClosed.closeReason}`,
  );
  assert.equal(clock.now(), deadline);
  assert.equal(quietClosed.state, 'closed');
  assert.equal(quietClosed.closeReason, 'released');
  recordReason(manager, d.hostId, 'AC3 quiet ceiling reached while lingering');
});

// ---------------------------
//----------------- (2) RESIDENT STOPS AT IDLE ------------
test('AC4: a resident host is held idle by resident-policy and ended by the idle ceiling', async () => {
  const clock = createFakeClock();
  const manager = createManager(clock);
  const driver = createFakeDriver();

  console.log(
    `resident-policy supersedeOnNewTurn=${DEFAULT_RESIDENT_POLICY.supersedeOnNewTurn} ` +
      `closeWhenLeasesEmpty=${DEFAULT_RESIDENT_POLICY.closeWhenLeasesEmpty} ` +
      `quietCeilingMs=${DEFAULT_RESIDENT_POLICY.quietCeilingMs}`,
  );

  // (a) no reason to do anything, but the mode's own permanent reason holds it.
  const a = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-res-a',
    driver,
  });
  const idle = readHost(manager, a.hostId);
  const idleDeadline = idle.quietDeadlineAt;
  assert.ok(typeof idleDeadline === 'number', 'the idle ceiling was never armed');
  console.log(
    `resident-a state=${idle.state} leases=${leaseKinds(idle, 'ac157-res-a')} ` +
      `lastActivityAt=${bindingOf(idle, 'ac157-res-a').lastActivityAt} quietDeadlineAt=${idleDeadline}`,
  );
  assert.equal(idle.state, 'idle');
  assert.equal(leaseKinds(idle, 'ac157-res-a'), 'resident-policy');
  assert.equal(idleDeadline, idle.startedAt + RESIDENT_IDLE_TIMEOUT);

  // Positive control: "not closed" is not vacuously true — one millisecond
  // before the deadline the host is still there and still idle.
  clock.advance(idleDeadline - 1 - clock.now());
  const pending = readHost(manager, a.hostId);
  console.log(
    `resident-a at-deadline-minus-1 state=${pending.state} closeReason=${pending.closeReason} ` +
      `pending-deadline=${pending.quietDeadlineAt} pending-timers=${clock.pending()}`,
  );
  assert.equal(pending.state, 'idle');
  assert.equal(pending.closeReason, null);
  assert.equal(pending.quietDeadlineAt, idleDeadline);

  clock.advance(1);
  const closedA = readHost(manager, a.hostId);
  console.log(
    `resident-a idle-closed-at=${clock.now()} deadline=${idleDeadline} closeReason=${closedA.closeReason}`,
  );
  assert.equal(clock.now(), idleDeadline);
  assert.equal(closedA.state, 'closed');
  assert.equal(closedA.closeReason, 'idle');
  recordReason(manager, a.hostId, 'AC4 idle ceiling reached with only resident-policy');

  // (b) an unexpired cron lease defers the idle close, and the window is then
  // re-counted from the cron's own expiry rather than from the old activity.
  const b = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-res-b',
    driver,
  });
  const openedAt = clock.now();
  const cronExpiresAt = openedAt + 7 * 86_400_000;
  driver.sink?.leaseAdded('ac157-res-b', {
    kind: 'cron',
    id: 'cron-b',
    recurring: true,
    expiresAt: cronExpiresAt,
  });
  const held = readHost(manager, b.hostId);
  const firstDeadline = held.quietDeadlineAt;
  console.log(
    `resident-b cron-held state=${held.state} leases=${leaseKinds(held, 'ac157-res-b')} ` +
      `quietDeadlineAt=${firstDeadline} cronExpiresAt=${cronExpiresAt}`,
  );
  assert.equal(held.state, 'lingering');
  assert.equal(firstDeadline, openedAt + RESIDENT_IDLE_TIMEOUT);

  clock.advance(firstDeadline! - clock.now());
  const atIdleDeadline = readHost(manager, b.hostId);
  console.log(
    `resident-b at-idle-deadline at=${clock.now()} state=${atIdleDeadline.state} ` +
      `closeReason=${atIdleDeadline.closeReason} rearmed-window-start=${atIdleDeadline.quietWindowStartAt} ` +
      `rearmed-deadline=${atIdleDeadline.quietDeadlineAt}`,
  );
  assert.notEqual(atIdleDeadline.state, 'closed');
  assert.equal(atIdleDeadline.closeReason, null);
  assert.equal(atIdleDeadline.quietWindowStartAt, cronExpiresAt);
  assert.equal(atIdleDeadline.quietDeadlineAt, cronExpiresAt + RESIDENT_IDLE_TIMEOUT);

  const rearmedDeadline = atIdleDeadline.quietDeadlineAt!;
  clock.advance(rearmedDeadline - clock.now());
  const closedB = readHost(manager, b.hostId);
  console.log(
    `resident-b cron-expired-closed-at=${clock.now()} deadline=${rearmedDeadline} ` +
      `closeReason=${closedB.closeReason}`,
  );
  assert.equal(clock.now(), rearmedDeadline);
  assert.equal(closedB.state, 'closed');
  assert.equal(closedB.closeReason, 'idle');
  recordReason(manager, b.hostId, 'AC4 idle ceiling reached after a cron deferred it');
});

// ---------------------------
//----------------- (3) ATTACHING IS NOT ACTIVITY ------------
test('AC5: attaching repeatedly moves nothing, while real activity does', async () => {
  const clock = createFakeClock();
  const manager = createManager(clock);
  const driver = createFakeDriver();

  const a = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-att-a',
    driver,
  });
  const before = bindingOf(readHost(manager, a.hostId), 'ac157-att-a').lastActivityAt;
  const deadline = readHost(manager, a.hostId).quietDeadlineAt;
  assert.ok(typeof deadline === 'number', 'the idle ceiling was never armed');

  let attachCount = 0;
  for (; attachCount < 3; attachCount += 1) {
    assert.equal(manager.attachViewer('ac157-att-a'), true);
  }
  // Also move the clock without doing any work, so "unchanged" cannot be an
  // artefact of nothing having happened in between.
  clock.advance(60_000);

  const attached = readHost(manager, a.hostId);
  const after = bindingOf(attached, 'ac157-att-a').lastActivityAt;
  console.log(
    `attach before=${before} after=${after} attach-count=${attachCount} ` +
      `deadline=${deadline} deadline-after=${attached.quietDeadlineAt}`,
  );
  assert.equal(after, before);
  assert.equal(attached.quietDeadlineAt, deadline);

  clock.advance(deadline - clock.now());
  const closed = readHost(manager, a.hostId);
  console.log(
    `attach idle-closed-at=${clock.now()} expected-deadline=${deadline} closeReason=${closed.closeReason}`,
  );
  assert.equal(closed.closeReason, 'idle');
  recordReason(manager, a.hostId, 'AC5 idle ceiling reached without real activity');

  // Positive control: `noteActivity` is the same family of entry point, and it
  // does move the clock's window — so the invariant above is not "nothing in
  // this manager can move lastActivityAt".
  const b = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-att-b',
    driver,
  });
  const activityBefore = bindingOf(readHost(manager, b.hostId), 'ac157-att-b').lastActivityAt;
  clock.advance(120_000);
  driver.sink?.activity('ac157-att-b');
  const activityAfter = bindingOf(readHost(manager, b.hostId), 'ac157-att-b').lastActivityAt;
  console.log(
    `note-activity before=${activityBefore} after=${activityAfter} ` +
      `deadline=${readHost(manager, b.hostId).quietDeadlineAt}`,
  );
  assert.notEqual(activityAfter, activityBefore);
  assert.equal(activityAfter, clock.now());
  assert.equal(readHost(manager, b.hostId).quietDeadlineAt, activityAfter + RESIDENT_IDLE_TIMEOUT);
});

// ---------------------------
//----------------- (4) AN EXIT IS NOT AN ABORT ------------
test('AC6: an exit carries its detail and is not an alias for an abort', async () => {
  const clock = createFakeClock();
  const manager = createManager(clock);
  const driver = createFakeDriver();

  const a = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-exit-a',
    driver,
  });
  driver.sink?.exited({ hostId: a.hostId, detail: 'oom' });
  const exited = readHost(manager, a.hostId);
  console.log(
    `exited state=${exited.state} closeReason=${exited.closeReason} closeDetail=${exited.closeDetail}`,
  );
  assert.equal(exited.state, 'closed');
  assert.equal(exited.closeReason, 'exited');
  assert.equal(exited.closeDetail, 'oom');
  recordReason(manager, a.hostId, 'AC6 driver reported an exit with detail oom');

  // The driver is not asked to kill a process that reported itself gone.
  assert.deepEqual(driver.closed, []);

  const b = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-exit-b',
    driver,
  });
  const stopped = await manager.interrupt('ac157-exit-b');
  const aborted = readHost(manager, b.hostId);
  console.log(
    `interrupt stopped=${stopped} closeReason=${aborted.closeReason} closeDetail=${aborted.closeDetail}`,
  );
  assert.equal(stopped, true);
  assert.equal(aborted.closeReason, 'aborted');
  assert.notEqual(aborted.closeReason, exited.closeReason);
  recordReason(manager, b.hostId, 'AC6 interrupt stopped the turn');
});

// ---------------------------
//----------------- (5) SHUTDOWN CLOSES AND FORCES ------------
test('AC7: shutdown closes every host, forces the ones that never settle, and resolves after them', async () => {
  const clock = createFakeClock();
  const manager = createManager(clock);
  const silent = new Set<string>();
  const driver = createFakeDriver((host) => !silent.has(host.hostId));

  const a = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-shut-a',
    driver,
  });
  const b = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-shut-b',
    driver,
  });
  // The second host's driver accepts the command and never reports back.
  silent.add(b.hostId);

  const shuttingDown = manager.shutdown({ timeoutMs: 5_000 });

  // Captured the instant the promise settles: if shutdown resolved early, this
  // is where it would show up as a host that is still open.
  let statesAtResolve: string[] = [];
  void shuttingDown.then(() => {
    statesAtResolve = [a.hostId, b.hostId].map((hostId) => readHost(manager, hostId).state);
  });

  clock.advance(5_000);
  const summary = await shuttingDown;

  const closedA = readHost(manager, a.hostId);
  const closedB = readHost(manager, b.hostId);
  console.log(
    `shutdown resolved-at=${clock.now()} closed=[${summary.closed.join(',')}] forced=[${summary.forced.join(',')}]`,
  );
  console.log(
    `shutdown-a state=${closedA.state} closeReason=${closedA.closeReason} closeDetail=${closedA.closeDetail}`,
  );
  console.log(
    `shutdown-b state=${closedB.state} closeReason=${closedB.closeReason} closeDetail=${closedB.closeDetail}`,
  );
  console.log(`shutdown states-at-resolve=[${statesAtResolve.join(',')}]`);

  assert.equal(closedA.state, 'closed');
  assert.equal(closedA.closeReason, 'server-shutdown');
  assert.equal(closedB.state, 'closed');
  assert.equal(closedB.closeReason, 'server-shutdown');

  // The one that never settled is the one recorded as forced — and the one that
  // did settle is not, which is the positive control for "forced".
  assert.equal(closedB.closeDetail, 'forced');
  assert.ok(summary.forced.includes(b.hostId));
  assert.ok(!summary.forced.includes(a.hostId));
  assert.equal(closedA.closeDetail, null);

  assert.equal(statesAtResolve.length, 2);
  assert.deepEqual(statesAtResolve, ['closed', 'closed']);

  // Every live host was asked, with the shutdown reason, through its driver.
  assert.ok(driver.closed.some((call) => call.hostId === a.hostId && call.reason === 'server-shutdown'));
  assert.ok(driver.closed.some((call) => call.hostId === b.hostId && call.reason === 'server-shutdown'));

  recordReason(manager, a.hostId, 'AC7 shutdown settled host');
  recordReason(manager, b.hostId, 'AC7 shutdown forced host');
});

// ---------------------------
//----------------- (6) THE ENUM IS EXHAUSTED ------------
test('AC8: every close reason in the shared enum is produced by a named case', async () => {
  const clock = createFakeClock();
  const manager = createManager(clock);
  const driver = createFakeDriver();

  // The four reasons with no other home in this file.
  const supersededApp = 'ac157-enum-superseded';
  const first = await manager.openHost({
    provider: PROVIDER,
    mode: 'per-run',
    appSessionId: supersededApp,
    driver,
  });
  driver.sink?.leaseAdded(supersededApp, { kind: 'turn', runId: 'run-enum' });
  await manager.openHost({
    provider: PROVIDER,
    mode: 'per-run',
    appSessionId: supersededApp,
    driver,
  });
  assert.equal(readHost(manager, first.hostId).closeReason, 'superseded');
  recordReason(manager, first.hostId, 'AC8 a newer turn superseded the host');

  const userHost = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-enum-user',
    driver,
  });
  manager.closeHost(userHost.hostId, 'user');
  assert.equal(readHost(manager, userHost.hostId).closeReason, 'user');
  recordReason(manager, userHost.hostId, 'AC8 the user closed the host');

  const modeHost = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-enum-mode',
    driver,
  });
  assert.equal(manager.changeMode('ac157-enum-mode'), true);
  assert.equal(readHost(manager, modeHost.hostId).closeReason, 'mode-change');
  recordReason(manager, modeHost.hostId, 'AC8 the session changed lifecycle mode');

  const rewindHost = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac157-enum-rewind',
    driver,
  });
  assert.equal(manager.rewind('ac157-enum-rewind'), true);
  assert.equal(readHost(manager, rewindHost.hostId).closeReason, 'rewind');
  recordReason(manager, rewindHost.hostId, 'AC8 an edit rewound the conversation');

  const covered = HOST_CLOSE_REASONS.filter((reason) => reasonsSeen.has(reason));
  for (const reason of HOST_CLOSE_REASONS) {
    console.log(`reason=${reason} case=${reasonsSeen.get(reason) ?? 'MISSING'}`);
  }
  console.log(`reasons-covered=${covered.length}/${HOST_CLOSE_REASONS.length}`);
  assert.equal(covered.length, HOST_CLOSE_REASONS.length);
  assert.deepEqual([...reasonsSeen.keys()].sort(), [...HOST_CLOSE_REASONS].sort());
});

// ---------------------------
//----------------- (7) THE LISTING ANNOUNCES ITSELF ------------
/**
 * AC5: `onChange` announces a changed listing exactly once per transition, and
 * the subscription is the thing that decides who hears it.
 *
 * Before this, a client learned that the listing had moved only by asking again
 * on a one-second timer; the manager now says so, and the count of announcements
 * is what a client's re-read is driven by. So "exactly once" is not a nicety:
 * an announcement per *recomputation* rather than per *transition* would put a
 * burst of frames on the wire for one turn ending (the lease drop recomputes,
 * the close recomputes again), and a client that read on each would be as busy
 * as the poll it replaced. The close leg is the one that traps this: the recompute
 * that decides to close and `closeHost` itself both run, and only the close may
 * speak — which is why `applyDerivedState` reports back whether it closed.
 *
 * `revisions` are also required to strictly increase, because the client drops a
 * frame whose revision it has already applied; a repeated revision would make
 * that dedup silently swallow the second change.
 */
test('AC5 (hosts_changed): onChange announces one revision per listing transition, and unsubscribe is honoured', async () => {
  const clock = createFakeClock();
  const manager = createManager(clock);
  const driver = createFakeDriver();

  const revisions: number[] = [];
  const unsubscribe = manager.onChange((rev) => revisions.push(rev));

  // (1) A host appearing in the listing. Per-run mode opens holding no lease,
  // so this is the `starting` state rather than a lease-driven one — the
  // announcement is that the listing gained a host, not that a turn began.
  const a = await manager.openHost({
    provider: PROVIDER,
    mode: 'per-run',
    appSessionId: 'ac5-a',
    driver,
  });
  assert.equal(revisions.length, 1, 'opening a host should announce exactly once');

  // (2) A turn starting moves the host `busy`.
  driver.sink?.leaseAdded('ac5-a', { kind: 'turn', runId: 'run-a' });
  assert.equal(revisions.length, 2, 'a turn starting should announce exactly once');

  // (3) The name the process answers to is part of the listing, so recording it
  // is a transition of its own even though no state word moved.
  driver.sink?.identity('ac5-a', 'peer-a');
  assert.equal(revisions.length, 3, 'recording an identity should announce exactly once');

  // (4) The turn ends and the host closes. This is the leg that must not speak
  // twice: the recompute closes the host and `closeHost` announces it, so the
  // boolean `applyDerivedState` returns is the whole difference between one
  // frame and two.
  driver.sink?.leaseRemoved('ac5-a', 'turn');
  assert.equal(revisions.length, 4, 'a turn ending (host close) should announce exactly once');
  assert.equal(readHost(manager, a.hostId).state, 'closed');

  // Strictly increasing and never repeated: a client's dedup cursor depends on
  // both, so a listing announced on the same revision twice would be dropped.
  const sorted = [...revisions].sort((left, right) => left - right);
  assert.deepEqual(revisions, sorted, `revisions must increase: ${revisions.join(',')}`);
  assert.equal(new Set(revisions).size, revisions.length, 'a revision must not be reused');
  console.log(`revisions=${revisions.join(',')}`);

  // (5) Unsubscribing stops delivery without stopping the manager: the two
  // transitions below really happen, and none of them is announced here.
  unsubscribe();
  const b = await manager.openHost({
    provider: PROVIDER,
    mode: 'per-run',
    appSessionId: 'ac5-b',
    driver,
  });
  driver.sink?.leaseAdded('ac5-b', { kind: 'turn', runId: 'run-b' });
  assert.equal(revisions.length, 4, 'an unsubscribed listener must not hear later transitions');
  assert.equal(readHost(manager, b.hostId).state, 'busy', 'the missed transition still happened');

  // (6) A listener subscribing later hears from its own subscription, and the
  // unsubscribed one stays silent — the two are independent.
  const later: number[] = [];
  const stopLater = manager.onChange((rev) => later.push(rev));
  driver.sink?.leaseRemoved('ac5-b', 'turn');
  assert.equal(later.length, 1, 'a later subscriber hears the transition it subscribed for');
  assert.equal(revisions.length, 4, 'the unsubscribed listener is still silent');
  stopLater();

  // (7) One listener throwing must not silence the listeners registered after
  // it: the wire reaches every client independently, and a client whose handler
  // faults is not allowed to become the reason the others stop hearing.
  console.log('throwing-listener-case the error logged on the next line is expected');
  const survivor: number[] = [];
  const stopThrower = manager.onChange(() => {
    throw new Error('ac5-listener-failure');
  });
  const stopSurvivor = manager.onChange((rev) => survivor.push(rev));
  await manager.openHost({ provider: PROVIDER, mode: 'per-run', appSessionId: 'ac5-c', driver });
  assert.equal(survivor.length, 1, 'a throwing listener must not stop the ones after it');
  stopThrower();
  stopSurvivor();
});

// ---------------------------
//----------------- THE CRITERION'S OWN PROPERTIES ------------
/**
 * Two readings that are about this file rather than about the manager.
 *
 * `real-wait-primitives` counts the three primitives that would mean the
 * readings above came from a real clock. The patterns are assembled from
 * fragments on purpose: compiling them into the file as literals would make this
 * check match itself, and a criterion that fails its own rule is worse than no
 * rule. `elapsed` is the wall clock the whole file took — a 24-hour ceiling that
 * was not really injected cannot be reached inside a minute, so this number is
 * the evidence that the clock seam is load-bearing rather than decorative.
 */
after(() => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const forbidden = [
    ['set', 'Timeout'].join(''),
    ['await', ' ', 'sleep'].join(''),
    ['node:', 'timers'].join(''),
  ];
  const counts = forbidden.map((pattern) => source.split(pattern).length - 1);
  console.log(`real-wait-primitives=${counts.reduce((sum, count) => sum + count, 0)}`);
  for (const [index, pattern] of forbidden.entries()) {
    assert.equal(counts[index], 0, `the criterion contains a real-wait primitive: ${pattern}`);
  }

  const elapsed = Date.now() - FILE_STARTED_AT;
  console.log(`elapsed=${elapsed}ms`);
  assert.ok(elapsed < 60_000, `the criterion took ${elapsed}ms, which means it really waited`);
});
