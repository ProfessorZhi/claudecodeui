/**
 * Criterion for the resident idle ceiling's configuration entry (AC-181).
 *
 * The claim has four parts, and this file reads them in order: the idle ceiling
 * is configurable (a short configured value ends an *idle* resident host at that
 * value, and the close reason is `idle`); a host that is actually serving a turn
 * is not ended by it (the positive control that "closable" is about idleness and
 * not about the configured number); the shipped default is unchanged — 24 hours
 * — when nothing is configured; and a malformed value falls back to that default
 * instead of throwing.
 *
 * Everything below is a reading of the production manager
 * (`createSessionHostManager`) driven through a forged host driver and a clock
 * the file owns, never of a double of the manager. The clock is the seam that
 * makes both 24 hours and five seconds reachable without waiting.
 *
 * The configuration entry is an environment variable, and the tests pin its
 * public name here rather than importing it: this criterion *is* the contract
 * for the entry, so a rename that the implementation makes alone must show up as
 * a red reading. The variable is read once, by `createSessionHostManager`, at
 * construction (`createConfiguredManager` below), so each test's value is a fact
 * about the manager it built and the ambient process is restored before any
 * assertion runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type { HostCloseReason, LLMProvider, ProcessHost } from '@/shared/types.js';

import {
  RESIDENT_IDLE_TIMEOUT,
  createSessionHostManager,
} from '../session-host-manager.service.js';
import type { HostScheduler, SessionHostManager } from '../session-host-manager.service.js';

const PROVIDER: LLMProvider = 'claude';

/**
 * The public name of the configuration entry, pinned here as the contract.
 *
 * Milliseconds, the unit `RESIDENT_IDLE_TIMEOUT` carries. A reader of the
 * criterion should be able to set the variable from this file alone; the
 * implementation names it privately for the same reason it does not export
 * every internal literal.
 */
const RESIDENT_IDLE_TIMEOUT_ENV = 'SESSION_HOST_RESIDENT_IDLE_TIMEOUT_MS';

/** A value short enough to reach with the injected clock, long enough to read. */
const SHORT_CEILING_MS = 5_000;

// ---------------------------
//----------------- FIXTURE SCAFFOLDING ------------
/**
 * A scheduler whose deadlines are queue entries and whose clock is a number.
 *
 * `advance` moves the clock first and then drains every entry that came due,
 * oldest first, so a callback that re-arms is ordered by the deadline it named
 * rather than by when it was scheduled. This is the seam that makes the ceiling
 * — 24 hours or five seconds — reachable in microseconds.
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

/** A driver the file owns: it reports through the sink and records its closes. */
type FakeDriver = IProviderHostDriver & {
  /** The sink the manager handed over at `startHost`, or null before one was started. */
  sink: IProviderHostDriverSink | null;
  /** Every `closeHost` the manager asked for, in order. */
  closed: Array<{ hostId: string; reason: HostCloseReason }>;
};

function createFakeDriver(): FakeDriver {
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
      // Turns are not dispatched in this criterion; the turn *lease* is.
    },
    async interrupt() {
      return true;
    },
    async reconfigure() {
      return 'live';
    },
    async unbind() {
      // Session detach is not this criterion's subject.
    },
    async closeHost(host, reason) {
      driver.closed.push({ hostId: host.hostId, reason });
    },
  };
  return driver;
}

/**
 * Builds a manager with the configuration entry set to `envValue`.
 *
 * The variable is restored to its previous value in a `finally`, so the value is
 * read exactly once — at construction, the manager's own single read point — and
 * every later assertion runs against a manager whose ceiling is already fixed
 * rather than against ambient process state. `undefined` means "not configured".
 */
function createConfiguredManager(clock: FakeClock, envValue: string | undefined): SessionHostManager {
  const previous = process.env[RESIDENT_IDLE_TIMEOUT_ENV];
  if (envValue === undefined) {
    delete process.env[RESIDENT_IDLE_TIMEOUT_ENV];
  } else {
    process.env[RESIDENT_IDLE_TIMEOUT_ENV] = envValue;
  }
  try {
    return createSessionHostManager({ now: () => clock.now(), scheduler: clock });
  } finally {
    if (previous === undefined) {
      delete process.env[RESIDENT_IDLE_TIMEOUT_ENV];
    } else {
      process.env[RESIDENT_IDLE_TIMEOUT_ENV] = previous;
    }
  }
}

/** Reads one host out of the manager's own read port, refusing a missing id. */
function readHost(manager: SessionHostManager, hostId: string): ProcessHost {
  const host = manager.snapshot().find((candidate) => candidate.hostId === hostId);
  assert.ok(host, `host ${hostId} is missing from snapshot()`);
  return host;
}

/** The binding this session landed on, refusing a missing one. */
function bindingOf(host: ProcessHost, appSessionId: string) {
  const binding = host.bindings.get(appSessionId);
  assert.ok(binding, `host ${host.hostId} has no binding for ${appSessionId}`);
  return binding;
}

function leaseKinds(host: ProcessHost, appSessionId: string): string {
  return bindingOf(host, appSessionId).leases.map((lease) => lease.kind).join('+') || 'none';
}

/**
 * Opens one resident host and answers the idle ceiling it was armed with.
 *
 * The ceiling is read as `quietDeadlineAt - quietWindowStartAt` off the manager's
 * published record rather than off any exported number, so what is measured is
 * the value the policy actually used — a manager that read the entry and then
 * discarded it still reads as the default here.
 */
async function openResidentAndReadCeiling(
  manager: SessionHostManager,
  appSessionId: string,
): Promise<{ hostId: string; ceilingMs: number; deadline: number; windowStartAt: number }> {
  const opened = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId,
    driver: createFakeDriver(),
  });
  const host = readHost(manager, opened.hostId);
  assert.ok(
    typeof host.quietDeadlineAt === 'number' && typeof host.quietWindowStartAt === 'number',
    `a resident host must arm its quiet ceiling; got deadline=${host.quietDeadlineAt} window-start=${host.quietWindowStartAt}`,
  );
  return {
    hostId: opened.hostId,
    ceilingMs: host.quietDeadlineAt - host.quietWindowStartAt,
    deadline: host.quietDeadlineAt,
    windowStartAt: host.quietWindowStartAt,
  };
}

// ---------------------------
//----------------- (1) CONFIGURED CEILING ENDS AN IDLE HOST ------------
test('AC2: a configured idle ceiling ends an idle resident host at that value, as `idle`', async () => {
  const clock = createFakeClock();
  const manager = createConfiguredManager(clock, String(SHORT_CEILING_MS));
  const driver = createFakeDriver();

  const opened = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac181-idle-a',
    driver,
  });
  const idle = readHost(manager, opened.hostId);
  assert.ok(typeof idle.quietDeadlineAt === 'number', 'the idle ceiling was never armed');
  const deadline = idle.quietDeadlineAt;
  const ceiling = deadline - idle.quietWindowStartAt!;
  console.log(
    `idle-config-a configured=${SHORT_CEILING_MS} armed-ceiling=${ceiling} ` +
      `window-start=${idle.quietWindowStartAt} deadline=${deadline} state=${idle.state} ` +
      `leases=${leaseKinds(idle, 'ac181-idle-a')}`,
  );
  assert.equal(ceiling, SHORT_CEILING_MS);
  assert.equal(idle.state, 'idle');

  // Positive control: one millisecond early the host is still open, so the close
  // below is the configured deadline's doing and not a constant.
  clock.advance(deadline - 1 - clock.now());
  const early = readHost(manager, opened.hostId);
  console.log(
    `idle-config-a at-deadline-minus-1 at=${clock.now()} state=${early.state} ` +
      `closeReason=${early.closeReason} pending=${clock.pending()}`,
  );
  assert.equal(early.state, 'idle');
  assert.equal(early.closeReason, null);

  clock.advance(1);
  const closed = readHost(manager, opened.hostId);
  console.log(
    `idle-config-a closed-at=${clock.now()} deadline=${deadline} closeReason=${closed.closeReason}`,
  );
  assert.equal(clock.now(), deadline);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closeReason, 'idle');
});

// ---------------------------
//----------------- (2) A HOST HOLDING A TURN IS NOT CLOSED ------------
test('AC3: a host holding a turn lease is not ended by the configured ceiling', async () => {
  const clock = createFakeClock();
  const manager = createConfiguredManager(clock, String(SHORT_CEILING_MS));
  const driver = createFakeDriver();

  // The idle sibling is the positive control: it closes at the configured
  // deadline while the busy host does not, so "still open" is not a clock that
  // never moved.
  const idleHost = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac181-busy-idle',
    driver: createFakeDriver(),
  });
  const busyHost = await manager.openHost({
    provider: PROVIDER,
    mode: 'resident',
    appSessionId: 'ac181-busy-live',
    driver,
  });
  driver.sink?.leaseAdded('ac181-busy-live', { kind: 'turn', runId: 'run-ac181' });

  const busy = readHost(manager, busyHost.hostId);
  console.log(
    `idle-config-b busy state=${busy.state} leases=${leaseKinds(busy, 'ac181-busy-live')} ` +
      `quietDeadlineAt=${busy.quietDeadlineAt} (a turn is never on the quiet clock)`,
  );
  assert.equal(busy.state, 'busy');
  assert.equal(busy.quietDeadlineAt, null);

  const idleDeadline = readHost(manager, idleHost.hostId).quietDeadlineAt!;
  clock.advance(idleDeadline - clock.now());
  const busyAtDeadline = readHost(manager, busyHost.hostId);
  const idleAtDeadline = readHost(manager, idleHost.hostId);
  console.log(
    `idle-config-b at-configured-deadline at=${clock.now()} ` +
      `idle-sibling-state=${idleAtDeadline.state} idle-sibling-closeReason=${idleAtDeadline.closeReason} ` +
      `busy-state=${busyAtDeadline.state} busy-closeReason=${busyAtDeadline.closeReason}`,
  );
  assert.equal(idleAtDeadline.state, 'closed');
  assert.equal(idleAtDeadline.closeReason, 'idle');
  assert.equal(busyAtDeadline.state, 'busy');
  assert.equal(busyAtDeadline.closeReason, null);

  // The configured ceiling is the one the host gets *back* once the turn ends:
  // releasing the turn re-arms at `now + SHORT_CEILING_MS`, and the host then
  // closes as idle exactly a configured window later.
  driver.sink?.leaseRemoved('ac181-busy-live', 'turn');
  const rearmed = readHost(manager, busyHost.hostId);
  console.log(
    `idle-config-b turn-released state=${rearmed.state} leases=${leaseKinds(rearmed, 'ac181-busy-live')} ` +
      `window-start=${rearmed.quietWindowStartAt} deadline=${rearmed.quietDeadlineAt}`,
  );
  assert.equal(rearmed.state, 'idle');
  assert.equal(rearmed.quietDeadlineAt! - rearmed.quietWindowStartAt!, SHORT_CEILING_MS);

  clock.advance(rearmed.quietDeadlineAt! - clock.now());
  const closedAfterTurn = readHost(manager, busyHost.hostId);
  console.log(
    `idle-config-b closed-after-turn at=${clock.now()} closeReason=${closedAfterTurn.closeReason}`,
  );
  assert.equal(closedAfterTurn.state, 'closed');
  assert.equal(closedAfterTurn.closeReason, 'idle');
});

// ---------------------------
//----------------- (3) NOTHING CONFIGURED IS STILL 24 HOURS ------------
test('AC4: with nothing configured the ceiling is the shipped 86400000 ms', async () => {
  const clock = createFakeClock();
  const manager = createConfiguredManager(clock, undefined);

  const { ceilingMs, deadline, windowStartAt } = await openResidentAndReadCeiling(
    manager,
    'ac181-default',
  );
  console.log(
    `idle-config-default env=unset exported=${RESIDENT_IDLE_TIMEOUT} armed-ceiling=${ceilingMs} ` +
      `window-start=${windowStartAt} deadline=${deadline}`,
  );
  assert.equal(RESIDENT_IDLE_TIMEOUT, 24 * 60 * 60 * 1000);
  assert.equal(RESIDENT_IDLE_TIMEOUT, 86_400_000);
  assert.equal(ceilingMs, 86_400_000);
  assert.equal(ceilingMs, RESIDENT_IDLE_TIMEOUT);
});

// ---------------------------
//----------------- (4) A MALFORMED VALUE FALLS BACK, SILENTLY ------------
test('AC5: negative, zero, and non-numeric values fall back to the default without throwing', async () => {
  const malformed = ['-1', '0', 'not-a-number'];
  for (const [index, raw] of malformed.entries()) {
    const clock = createFakeClock();
    let manager: SessionHostManager | null = null;
    assert.doesNotThrow(() => {
      manager = createConfiguredManager(clock, raw);
    }, `configuring ${RESIDENT_IDLE_TIMEOUT_ENV}=${JSON.stringify(raw)} must not throw`);
    assert.ok(manager, `a manager was built for ${JSON.stringify(raw)}`);

    const { ceilingMs } = await openResidentAndReadCeiling(manager, `ac181-bad-${index}`);
    console.log(
      `idle-config-bad raw=${JSON.stringify(raw)} armed-ceiling=${ceilingMs} default=${RESIDENT_IDLE_TIMEOUT}`,
    );
    assert.equal(ceilingMs, RESIDENT_IDLE_TIMEOUT, `${JSON.stringify(raw)} must fall back`);
  }
});
