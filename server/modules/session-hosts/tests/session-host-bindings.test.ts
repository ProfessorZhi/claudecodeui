/**
 * Criterion for host/session cardinality — hosts are 1:N with sessions (AC-158).
 *
 * Drives the real manager (`createSessionHostManager`) through a forged host
 * driver, so every reading below is a reading of the production binding state
 * machine rather than of a test double of it. What is proven:
 *
 *   (1) `multiplexedHost: true` lets one process carry two sessions, and the
 *       declaration is load-bearing: the same shape without it never produces a
 *       host with two bindings (positive and negative control in one leg).
 *   (2) Detaching one session of two leaves the host running and the other
 *       binding byte-identical, and does not close the host — under both the
 *       `user` and the `idle` detach reasons.
 *   (3) Detaching the last binding closes the host exactly once, under the
 *       caller's reason, and a repeat detach does not close it a second time
 *       (the positive control that "exactly once" is not vacuous).
 *   (4) One session cannot have two bindings: a rebind is refused naming the
 *       *conflicting* host, whether the request was aimed at that host or at a
 *       different one, and the refusal writes nothing on the target.
 *   (5) Under a `supersedeOnNewTurn` policy the replacement host is not started
 *       until the old host's driver has acknowledged the close, which is the
 *       ordering that keeps the new bind legal under the single-writer rule.
 *
 * Determinism: the clock is a constant the test owns, the scheduler is inert,
 * and host ids come from a counter, so every printed reading is byte-identical
 * across runs. The only sequencing control is a gate the test holds on the fake
 * driver's `closeHost`; there is no real waiting anywhere in this file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type { HostCloseReason, LLMProvider, ProcessHost } from '@/shared/types.js';

const PROVIDER: LLMProvider = 'claude';
/** A constant instant, so no reading depends on when the file was run. */
const CLOCK = 1_700_000_000_000;
const FILE_STARTED_AT = Date.now();

/**
 * A scheduler that never fires.
 *
 * The manager reaches the wall clock only through this seam, and nothing in this
 * criterion may wait: every host here is closed explicitly, so an armed quiet
 * deadline would be a timer nobody waits for. Returning a no-op cancel keeps the
 * production call shape (`armQuietClose` still runs) while leaving the process
 * with nothing scheduled.
 */
const inertScheduler: HostScheduler = {
  schedule() {
    return () => undefined;
  },
};

/** A promise pair the test opens by hand — the one sequencing control in this file. */
type Gate = { readonly opened: Promise<void>; open(): void };

function createGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, open: release };
}

/**
 * One call the manager made on the driver, in order.
 *
 * `unbind` and `closeHost` are separate verbs on purpose: proving the host was
 * closed under the caller's reason requires reading which of the two the manager
 * used, and a log that collapsed them could not tell a detach from a kill.
 */
type HostCall =
  | { verb: 'startHost'; hostId: string }
  | { verb: 'bind'; hostId: string; appSessionId: string }
  | { verb: 'unbind'; hostId: string; appSessionId: string; reason: HostCloseReason }
  | { verb: 'closeHost'; hostId: string; reason: HostCloseReason };

/** The ordered log as one greppable reading. */
function formatCalls(calls: readonly HostCall[]): string {
  return (
    calls
      .map((call) => {
        switch (call.verb) {
          case 'startHost':
            return `startHost(${call.hostId})`;
          case 'bind':
            return `bind(${call.hostId},${call.appSessionId})`;
          case 'unbind':
            return `unbind(${call.hostId},${call.appSessionId},${call.reason})`;
          default:
            return `closeHost(${call.hostId},${call.reason})`;
        }
      })
      .join(' ') || 'none'
  );
}

/**
 * A driver the test owns: it logs every verb and can hold its close open.
 *
 * `multiplexedHost` is written only when the caller asks for it, so "the driver
 * did not declare it" is a driver without the property rather than a driver that
 * declared `false` — the default-false reading is what rule 3 of `bindSession`
 * depends on.
 */
type FakeDriver = IProviderHostDriver & {
  readonly calls: HostCall[];
  sink: IProviderHostDriverSink | null;
  gate: Gate | null;
  verbCount(verb: HostCall['verb']): number;
};

function createFakeDriver(
  options: { multiplexed?: boolean } = {},
): FakeDriver {
  const calls: HostCall[] = [];
  const driver: FakeDriver = {
    calls,
    sink: null,
    gate: null,
    verbCount: (verb) => calls.filter((call) => call.verb === verb).length,
    async startHost(host, sink) {
      driver.sink = sink;
      calls.push({ verb: 'startHost', hostId: host.hostId });
      return host;
    },
    async bind(host, binding) {
      calls.push({ verb: 'bind', hostId: host.hostId, appSessionId: binding.appSessionId });
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
    async unbind(host, appSessionId, reason) {
      calls.push({ verb: 'unbind', hostId: host.hostId, appSessionId, reason });
    },
    async closeHost(host, reason) {
      calls.push({ verb: 'closeHost', hostId: host.hostId, reason });
      if (driver.gate) {
        // The shape the manager must await before it starts a replacement.
        await driver.gate.opened;
      }
    },
    ...(options.multiplexed === undefined ? {} : { multiplexedHost: options.multiplexed }),
  };
  return driver;
}

/** A manager with a constant clock, an inert scheduler and counted host ids. */
function createManager(): SessionHostManager {
  let serial = 0;
  return createSessionHostManager({
    now: () => CLOCK,
    scheduler: inertScheduler,
    createHostId: () => `h${++serial}`,
  });
}

/** Reads one host out of the manager's own read port, refusing a missing id. */
function readHost(manager: SessionHostManager, hostId: string): ProcessHost {
  const host = manager.snapshot().find((candidate) => candidate.hostId === hostId);
  assert.ok(host, `host ${hostId} is missing from snapshot()`);
  return host;
}

/**
 * How many *live* hosts carry a binding for this session.
 *
 * Live, because a closed host keeps its bindings as the record of who it was
 * serving — that is what makes a close reason readable after the fact — so
 * counting every host would report a superseded session twice and make the
 * single-writer invariant unreadable. The invariant this answers is about live
 * processes, so closed ones are excluded by definition.
 */
function liveBindingsFor(manager: SessionHostManager, appSessionId: string): number {
  return manager
    .snapshot()
    .filter((host) => host.state !== 'closed' && host.bindings.has(appSessionId)).length;
}

/** Reads a binding's state and leases as one literal, or null when it is absent. */
function bindingShape(host: ProcessHost, appSessionId: string): string | null {
  const binding = host.bindings.get(appSessionId);
  return binding ? JSON.stringify({ state: binding.state, leases: binding.leases }) : null;
}

// ---------------------------
//----------------- (1)+(1b) BINDING CARDINALITY ------------
test('AC2: multiplexedHost decides whether one host carries two sessions', async () => {
  const manager = createManager();
  const driver = createFakeDriver({ multiplexed: true });

  const first = await manager.bindSession({ provider: PROVIDER, appSessionId: 'A', driver });
  const second = await manager.bindSession({ provider: PROVIDER, appSessionId: 'B', driver });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.ok(first.ok && second.ok);

  const hosts = manager.snapshot();
  const host = readHost(manager, first.hostId);
  console.log(`multiplexed-declaration multiplexedHost=true`);
  console.log(
    `hosts=${hosts.length} hostId=${first.hostId} bindings=${host.bindings.size} ` +
      `appSessionIds=[${[...host.bindings.keys()].join(',')}] calls=${formatCalls([...driver.calls])}`,
  );
  // The cardinality claim first, and the corroborating readings after it: a
  // manager that keys hosts 1:1 with sessions fails on `bindings` here rather
  // than on a proxy for it, so the red names the reading this criterion exists
  // to establish.
  assert.equal(host.bindings.size, 2);
  assert.deepEqual([...host.bindings.keys()], ['A', 'B']);
  assert.equal(first.hostId, second.hostId);
  assert.equal(hosts.length, 1);
  // One process, so exactly one start: the second bind was placed on the first
  // host rather than served by a second process that happens to look similar.
  assert.equal(driver.verbCount('startHost'), 1);
  assert.equal(driver.verbCount('bind'), 2);

  const negative = createManager();
  const singleton = createFakeDriver();
  const negativeFirst = await negative.bindSession({
    provider: PROVIDER,
    appSessionId: 'A',
    driver: singleton,
  });
  const negativeSecond = await negative.bindSession({
    provider: PROVIDER,
    appSessionId: 'B',
    driver: singleton,
  });
  assert.equal(negativeFirst.ok, true);
  assert.equal(negativeSecond.ok, false);
  assert.ok(!negativeSecond.ok);
  assert.equal(negativeSecond.code, 'host-not-multiplexed');
  assert.equal(negativeSecond.existingHostId, negativeFirst.ok ? negativeFirst.hostId : null);

  const negativeHosts = negative.snapshot();
  const maxBindingsPerHost = Math.max(...negativeHosts.map((candidate) => candidate.bindings.size));
  console.log(
    `single-conversation multiplexedHost=absent hosts=${negativeHosts.length} ` +
      `maxBindingsPerHost=${maxBindingsPerHost} secondBind=rejected ` +
      `code=${negativeSecond.code} existingHostId=${negativeSecond.existingHostId} ` +
      `hostsCarryingB=${negativeHosts.filter((candidate) => candidate.bindings.has('B')).length}`,
  );
  assert.equal(maxBindingsPerHost, 1);
  assert.equal(negativeHosts.filter((candidate) => candidate.bindings.has('B')).length, 0);
});

// ---------------------------
//----------------- (2) DETACH LEAVES THE HOST OPEN ------------
/**
 * One detach reason's worth of leg (2): two sessions on one host, one detached.
 *
 * Returns the manager and the driver so leg (3) can continue from the `idle`
 * run — the two reasons are the same story up to the point where the caller
 * names why the session went away.
 */
async function detachOneOfTwo(reason: HostCloseReason) {
  const manager = createManager();
  const driver = createFakeDriver({ multiplexed: true });
  const first = await manager.bindSession({ provider: PROVIDER, appSessionId: 'A', driver });
  const second = await manager.bindSession({ provider: PROVIDER, appSessionId: 'B', driver });
  assert.ok(first.ok && second.ok);
  const hostId = first.hostId;

  const before = readHost(manager, hostId);
  const otherBefore = bindingShape(before, 'B');
  console.log(`unbind=${reason} bindingsBefore=${before.bindings.size}`);

  const detached = await manager.unbindSession('A', reason);
  const after = readHost(manager, hostId);
  const otherAfter = bindingShape(after, 'B');
  console.log(
    `unbind=${reason} bindingsAfter=${after.bindings.size} ` +
      `remaining=[${[...after.bindings.keys()].join(',')}] ` +
      `bindingUnchanged=${otherAfter === otherBefore} ` +
      `closeHostCalls=${driver.verbCount('closeHost')} hostState=${after.state}`,
  );

  assert.equal(detached, true);
  assert.notEqual(after.state, 'closed');
  // Positive control: the detach really happened, so "the host is still open"
  // is not the reading of a no-op.
  assert.equal(before.bindings.size, 2);
  assert.equal(after.bindings.size, 1);
  assert.deepEqual([...after.bindings.keys()], ['B']);
  assert.equal(otherAfter, otherBefore);
  assert.equal(driver.verbCount('closeHost'), 0);
  assert.equal(driver.verbCount('unbind'), 1);
  return { manager, driver, hostId };
}

test('AC3: detaching one of two sessions leaves the host and the other binding untouched', async () => {
  await detachOneOfTwo('user');
  await detachOneOfTwo('idle');
});

// ---------------------------
//----------------- (3) THE LAST BINDING CLOSES IT ONCE ------------
test('AC4: detaching the last binding closes the host once, under the caller reason', async () => {
  const { manager, driver, hostId } = await detachOneOfTwo('idle');

  const closed = await manager.unbindSession('B', 'idle');
  const host = readHost(manager, hostId);
  assert.equal(closed, true);
  console.log(
    `unbindCalls=${driver.verbCount('unbind')} closeHostCalls=${driver.verbCount('closeHost')} ` +
      `closeReason=${host.closeReason} hostState=${host.state}`,
  );
  assert.equal(driver.verbCount('unbind'), 2);
  assert.equal(driver.verbCount('closeHost'), 1);
  assert.equal(host.closeReason, 'idle');
  assert.equal(host.state, 'closed');
  assert.equal(host.bindings.size, 0);

  // Positive control for "exactly once": the second detach is a no-op, so a
  // manager that closed on every call would read 2 here instead of 1.
  const repeat = await manager.unbindSession('B', 'idle');
  console.log(`idempotentCloseHostCalls=${driver.verbCount('closeHost')} repeatDetached=${repeat}`);
  assert.equal(repeat, false);
  assert.equal(driver.verbCount('closeHost'), 1);
});

// ---------------------------
//----------------- (4) ONE SESSION, ONE BINDING ------------
test('AC5: a rebind is refused naming the conflicting host, and writes nothing', async () => {
  const manager = createManager();
  const driver = createFakeDriver({ multiplexed: true });

  const first = await manager.bindSession({ provider: PROVIDER, appSessionId: 'A', driver });
  assert.ok(first.ok);
  const conflictHostId = first.hostId;

  const sameHost = await manager.bindSession({ provider: PROVIDER, appSessionId: 'A', driver });
  assert.ok(!sameHost.ok);
  console.log(
    `rebindSameHost=rejected code=${sameHost.code} existingHostId=${sameHost.existingHostId}`,
  );
  assert.equal(sameHost.code, 'session-already-bound');
  assert.equal(sameHost.existingHostId, conflictHostId);

  // A second, newer host exists — so the refusal below is aimed at a host other
  // than the one that holds the session, and still names the holder.
  const other = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'D',
    driver,
  });
  const targetBefore = readHost(manager, other.hostId)
    .bindings.has('A');
  const otherHost = await manager.bindSession({ provider: PROVIDER, appSessionId: 'A', driver });
  const targetAfter = readHost(manager, other.hostId).bindings.has('A');
  assert.ok(!otherHost.ok);
  console.log(
    `rebindOtherHost=rejected code=${otherHost.code} existingHostId=${otherHost.existingHostId} ` +
      `targetHostId=${other.hostId} targetBindingsBefore=[${targetBefore ? 'A' : ''}] ` +
      `targetBindingsAfter=[${targetAfter ? 'A' : ''}] ` +
      `targetHostBindings=[${[...readHost(manager, other.hostId).bindings.keys()].join(',')}]`,
  );
  assert.equal(otherHost.code, 'session-already-bound');
  assert.equal(otherHost.existingHostId, conflictHostId);
  assert.notEqual(otherHost.existingHostId, other.hostId);
  assert.equal(targetBefore, false);
  assert.equal(targetAfter, false);

  const fresh = await manager.bindSession({ provider: PROVIDER, appSessionId: 'C', driver });
  assert.equal(fresh.ok, true);
  assert.ok(fresh.ok);
  console.log(`bindFreshSession=ok hostId=${fresh.hostId}`);
  assert.equal(fresh.hostId, other.hostId);
  assert.equal(liveBindingsFor(manager, 'A'), 1);
});

// ---------------------------
//----------------- (5) SUPERSEDE BEFORE START ------------
test('AC6: the replacement host starts only after the old close is acknowledged', async () => {
  const manager = createManager();
  const driver = createFakeDriver({ multiplexed: true });

  const first = await manager.bindSession({
    provider: PROVIDER,
    appSessionId: 'A',
    driver,
    mode: 'per-run',
  });
  assert.ok(first.ok);
  const oldHostId = first.hostId;

  driver.sink?.leaseAdded('A', { kind: 'turn', runId: 'run-1' });
  driver.sink?.leaseAdded('A', { kind: 'background-task', id: 'bg-1' });
  driver.sink?.leaseRemoved('A', 'turn');
  assert.equal(readHost(manager, oldHostId).state, 'lingering');

  const gate = createGate();
  driver.gate = gate;
  const pending = manager.bindSession({
    provider: PROVIDER,
    appSessionId: 'A',
    driver,
    mode: 'per-run',
  });

  // Read synchronously, before the gate opens: the log is the live array, so a
  // slice taken later would include the very entries this reading is about.
  const gatedCalls = [...driver.calls];
  const gatedCloseIndex = gatedCalls.findIndex(
    (call) => call.verb === 'closeHost' && call.hostId === oldHostId,
  );
  const startedNewHostBeforeOldClosed = gatedCalls
    .slice(gatedCloseIndex + 1)
    .some((call) => call.verb === 'startHost' || call.verb === 'bind');
  console.log(`gatedCalls=${formatCalls(gatedCalls)}`);
  console.log(`gated:startedNewHostBeforeOldClosed=${startedNewHostBeforeOldClosed}`);
  assert.equal(gatedCloseIndex >= 0, true);
  assert.equal(startedNewHostBeforeOldClosed, false);

  gate.open();
  const rebound = await pending;
  assert.equal(rebound.ok, true);
  assert.ok(rebound.ok);
  driver.sink?.leaseAdded('A', { kind: 'turn', runId: 'run-2' });

  const closeIndex = driver.calls.findIndex(
    (call) => call.verb === 'closeHost' && call.hostId === oldHostId,
  );
  const startIndex = driver.calls.findIndex(
    (call) => call.verb === 'startHost' && call.hostId === rebound.hostId,
  );
  const bindIndex = driver.calls.findIndex(
    (call) => call.verb === 'bind' && call.hostId === rebound.hostId,
  );
  const oldHost = readHost(manager, oldHostId);
  const newHost = readHost(manager, rebound.hostId);
  console.log(`orderedCalls=${formatCalls([...driver.calls])}`);
  console.log(
    `supersede oldHostId=${oldHostId} oldCloseReason=${oldHost.closeReason} ` +
      `newHostId=${rebound.hostId} newState=${newHost.state} ` +
      `newBindings=[${[...newHost.bindings.keys()].join(',')}] ` +
      `liveBindingsForA=${liveBindingsFor(manager, 'A')}`,
  );
  assert.notEqual(rebound.hostId, oldHostId);
  assert.equal(closeIndex >= 0 && startIndex >= 0 && bindIndex >= 0, true);
  assert.equal(closeIndex < startIndex, true);
  assert.equal(closeIndex < bindIndex, true);
  assert.equal(oldHost.closeReason, 'superseded');
  // Positive control: the reason is the supersede path's own, not the two other
  // closes a lingering per-run host can reach.
  assert.notEqual(oldHost.closeReason, 'turn-complete');
  assert.notEqual(oldHost.closeReason, 'released');
  assert.equal(newHost.state, 'busy');
  assert.deepEqual([...newHost.bindings.keys()], ['A']);
  assert.equal(liveBindingsFor(manager, 'A'), 1);
});

// ---------------------------
//----------------- DETERMINISM READING ------------
test('AC8: the criterion contains no real waiting', () => {
  // Assembled from halves so the grep this reading answers cannot match this
  // very line: the needle and the artifact under test are the same bytes.
  const needles = [['set', 'Timeout'].join(''), ['await', 'sleep'].join(' '), ['node', 'timers'].join(':')];
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const hits = source
    .split('\n')
    .filter((line) => needles.some((needle) => line.includes(needle))).length;
  console.log(`realWaitPatterns=${hits} patterns=[${needles.join('|')}]`);
  assert.equal(hits, 0);

  console.log(`elapsed=${Date.now() - FILE_STARTED_AT}ms`);
});
