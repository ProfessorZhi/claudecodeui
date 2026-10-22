/**
 * Criterion for the held-work leases' `since` stamp and its listing projection.
 *
 * The session view needs one fact about a background task it cannot read for
 * itself: when the hold began, which is the whole of the elapsed reading the
 * background-task strip draws. The manager is the one place every lease passes
 * through, so the stamp belongs to `addLease` rather than to each driver, and
 * the value a client is owed is the one the `/api/session-hosts` projection
 * publishes. Both halves are read here, off the production manager and the real
 * listing router:
 *
 *   - a lease added at a controlled instant comes back with that instant as a
 *     number, for both held-work kinds (`background-task` and `monitor`), and
 *   - the `cron` member's shape is untouched: it carries its own schedule and no
 *     `since`, so a client can tell a scheduled job from a running task.
 *
 * The clock is a constant the test owns and the scheduler is inert, so every
 * printed reading is byte-identical across runs and nothing waits.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createSessionHostManager, createSessionHostsRouter } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  HostCloseReason,
  HostReconfigurePatch,
  HostTurnInput,
  LLMProvider,
  ProcessHost,
  SessionBinding,
} from '@/shared/types.js';

const PROVIDER: LLMProvider = 'claude';
const SESSION_ID = 'since-session';

/** The three instants the criterion joins work at. Distinct, so a mix-up is visible. */
const T_BACKGROUND = 1_700_000_000_000;
const T_MONITOR = T_BACKGROUND + 5_000;
const T_CRON = T_MONITOR + 3_000;

/** A scheduler that never fires — no quiet ceiling may run during this criterion. */
const inertScheduler: HostScheduler = {
  schedule() {
    return () => undefined;
  },
};

/**
 * A driver the test owns. Only `startHost` matters: it hands the criterion the
 * sink every later lease is reported through, and the manager never reaches the
 * remaining verbs because nothing here closes a host.
 */
function createFakeDriver(): IProviderHostDriver & { sink: IProviderHostDriverSink | null } {
  const driver: IProviderHostDriver & { sink: IProviderHostDriverSink | null } = {
    sink: null,
    async startHost(host: ProcessHost, sink: IProviderHostDriverSink) {
      driver.sink = sink;
      return host;
    },
    async bind(_host: ProcessHost, _binding: SessionBinding) {
      // No driver-side bookkeeping is part of this criterion.
    },
    async submit(_host: ProcessHost, _appSessionId: string, _turn: HostTurnInput) {
      // Turns are not part of this criterion.
    },
    async interrupt() {
      return true;
    },
    async reconfigure(): Promise<'live' | 'next-turn'> {
      return 'live';
    },
    async unbind(_host: ProcessHost, _appSessionId: string, _reason: HostCloseReason) {
      // Unused.
    },
    async closeHost(_host: ProcessHost, _reason: HostCloseReason) {
      // Unused: every lease here is added while the host is live.
    },
  };
  return driver;
}

/** A manager whose clock the test advances by hand. */
function createManager(clock: { value: number }): SessionHostManager {
  let serial = 0;
  return createSessionHostManager({
    now: () => clock.value,
    scheduler: inertScheduler,
    createHostId: () => `since-host-${++serial}`,
  });
}

/** One binding's leases as the listing publishes them. */
type WireLease = { kind: string; since?: unknown } & Record<string, unknown>;

/** Fetches `GET /api/session-hosts` off a router mounted on a bare express app. */
async function readListing(manager: SessionHostManager): Promise<WireLease[]> {
  const app = express();
  app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager: manager }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/session-hosts`);
    assert.equal(response.status, 200, 'the listing must answer 200 without an auth layer in front of it');
    const body = (await response.json()) as {
      data?: { hosts?: Array<{ state: string; bindings: Array<{ appSessionId: string; leases: WireLease[] }> }> };
    };
    const hosts = body.data?.hosts ?? [];
    for (const host of hosts) {
      if (host.state === 'closed') continue;
      const binding = host.bindings.find((candidate) => candidate.appSessionId === SESSION_ID);
      if (binding) return binding.leases;
    }
    return [];
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('AC2: held-work leases carry the instant they were added; cron keeps its own shape', async () => {
  const clock = { value: T_BACKGROUND };
  const manager = createManager(clock);
  const driver = createFakeDriver();

  const bound = await manager.bindSession({ provider: PROVIDER, appSessionId: SESSION_ID, driver });
  assert.ok(bound.ok, 'premise: the session must bind to a live host');
  assert.ok(driver.sink, 'premise: startHost must have handed over a sink');

  // The hold the strip exists for. The stamp is read off the manager's clock at
  // the moment addLease runs — never off the driver's report, which carries none.
  driver.sink.leaseAdded(SESSION_ID, { kind: 'background-task', id: 'toolu-run-in-background' });

  clock.value = T_MONITOR;
  driver.sink.leaseAdded(SESSION_ID, { kind: 'monitor', id: 'toolu-monitor' });

  clock.value = T_CRON;
  driver.sink.leaseAdded(SESSION_ID, { kind: 'cron', id: 'cron-1', recurring: false, expiresAt: T_CRON + 60_000 });

  const leases = await readListing(manager);
  const background = leases.find((lease) => lease.kind === 'background-task');
  const monitor = leases.find((lease) => lease.kind === 'monitor');
  const cron = leases.find((lease) => lease.kind === 'cron');

  console.log(
    `listing.leases=${JSON.stringify(leases.map((lease) => ({ kind: lease.kind, since: lease.since ?? null })))}`,
  );

  assert.ok(background, 'the background-task lease must be on the listing');
  assert.equal(
    background.since,
    T_BACKGROUND,
    'the background task must carry the instant addLease saw, not a later read',
  );
  assert.equal(typeof background.since, 'number', 'since must cross the wire as a number');

  assert.ok(monitor, 'the monitor lease must be on the listing');
  assert.equal(monitor.since, T_MONITOR, 'each held-work lease carries its own join instant');

  // The negative half: `cron` is unchanged, so a client cannot mistake a
  // scheduled job for running work by finding a clock where it expects none.
  assert.ok(cron, 'the cron lease must be on the listing');
  assert.equal('since' in cron, false, 'cron must not grow a since field');
  assert.deepEqual(
    Object.keys(cron).sort(),
    ['expiresAt', 'id', 'kind', 'recurring'],
    'the cron member shape is the one it always had',
  );

  // And the manager's own read port agrees with the projection: the stamp is
  // written by addLease, and the route only re-publishes it.
  const stored =
    manager
      .snapshot()
      .flatMap((host) => [...host.bindings.values()])
      .find((binding) => binding.appSessionId === SESSION_ID)?.leases ?? [];
  const storedBackground = stored.find((lease) => lease.kind === 'background-task');
  assert.ok(storedBackground && 'since' in storedBackground, 'the manager must stamp the lease it holds');
  assert.equal(
    (storedBackground as { since?: number }).since,
    T_BACKGROUND,
    "the projection must read the manager's own stamp rather than inventing one",
  );
});
