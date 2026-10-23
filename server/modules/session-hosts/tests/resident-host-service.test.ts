/**
 * Criterion for the resident host start/close service (AC-236).
 *
 * The subject is the two service functions the on-demand host verbs were
 * extracted into — `startResidentHost` and `closeResidentHost` — reached
 * directly, with no socket and no HTTP server in the path. The claim has four
 * halves, each read as a value rather than inferred from prose:
 *
 *   (a) the service exists and the route is *thin*: the five inline calls the
 *       route used to make (`readSession?.(`, `resolveHostDriver?.(`,
 *       `startResidentSession(`, `.bindSession(`, `.closeHost(`) are counted in
 *       the route source and must be zero, while the route names
 *       `startResidentHost(` / `closeResidentHost(` at least once — and the
 *       service source is counted for the same five patterns as a positive
 *       control, so a zero cannot be a scanner that reads nothing.
 *   (b) the four start refusals keep their status, code and sentence verbatim.
 *   (c) starting a session that already has a live resident host is idempotent:
 *       the same pid comes back and the launch seam is called exactly once.
 *   (d) closing returns the reason, the host, and the `resident-policy` lease
 *       read back from the real manager's binding; the four close refusals keep
 *       their status, code and sentence verbatim.
 *
 * What is real, and what is substituted, and why:
 *
 *  - **The manager is real.** Each case builds its own `createSessionHostManager()`
 *    and drives it, so "the leases the close returned" is read from a live
 *    binding rather than from a fixture's opinion.
 *  - **The driver is a stand-in for the process.** It opens a host in the real
 *    manager with a literal pid and adopts it only while its own
 *    `startResidentSession` asked for one — the rule the production Claude
 *    driver enforces by throwing "was opened without a process". Nothing is
 *    spawned: a criterion about a service's decisions has no business needing a
 *    model, and this file opens no socket.
 *  - **The seams are injected.** `readSession`, `resolveHostDriver` and
 *    `startResidentSession` are the same four dependencies the router is built
 *    with, supplied directly to the service. That is what lets the criterion
 *    reach every refusal branch without a database or a provider registry.
 *
 * Out of scope, deliberately: anything HTTP. The wire contract (status codes,
 * the success body, the two enums' membership) is measured end-to-end by
 * `resident-ondemand-start-route.test.ts` and `session-hosts-routes.test.ts`,
 * which this task does not touch. This file reads the service, and only the
 * service; a criterion that mounted a router would be restating those two.
 *
 * Falsification (three arms, each run before the fix is committed and recorded
 * in the completion record): a leftover inline call in the route reds (a); a
 * service that treats an already-running session as a new start reds (c); any
 * reworded refusal reds (b) or (d).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { IProviderHostDriver } from '@/shared/interfaces.js';
import type {
  HostMode,
  HostResidentLaunch,
  HostResidentStartResult,
  LLMProvider,
  ProcessHost,
} from '@/shared/types.js';

import { createSessionHostManager, type SessionHostManager } from '../session-host-manager.service.js';
import {
  closeResidentHost,
  startResidentHost,
  type ResidentHostServiceDeps,
} from '../resident-host.service.js';
import type { SessionLifecycleReading } from '../session-hosts.routes.js';

/** The pid the stand-in's verb reports. */
const FAKE_PID = 4242;

/** One line of this criterion's readings, prefixed so a reader can find them. */
function say(line: string): void {
  console.log(`resident-host-service ${line}`);
}

/** How many times `needle` occurs in `haystack`, without a regex. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------
//----------------- THE STAND-IN DRIVER ------------
type FakeDriver = Omit<IProviderHostDriver, 'startResidentSession'> & {
  /** The on-demand verb is required on this stand-in, unlike on the interface. */
  startResidentSession(appSessionId: string, launch: HostResidentLaunch): Promise<HostResidentStartResult>;
  /** Every launch bag this driver's on-demand verb was handed, in order. */
  launches: HostResidentLaunch[];
  /** How many hosts it has actually started. */
  spawns: () => number;
};

/**
 * The on-demand driver, as this module is allowed to write it.
 *
 * Its two load-bearing rules are the pair the production Claude driver enforces:
 * the verb opens a host in the real manager (so the record the service reads
 * back is real), and `startHost` adopts a host only while a launch is pending —
 * any other route to it is refused.
 */
function createFakeDriver(manager: SessionHostManager): FakeDriver {
  let pendingLaunch = false;
  let spawns = 0;

  const driver: FakeDriver = {
    launches: [],
    spawns: () => spawns,
    multiplexedHost: false,

    async startResidentSession(
      appSessionId: string,
      launch: HostResidentLaunch,
    ): Promise<HostResidentStartResult> {
      driver.launches.push(launch);
      pendingLaunch = true;
      try {
        const host = await manager.openHost({
          provider: 'claude',
          mode: 'resident',
          appSessionId,
          driver,
          pid: FAKE_PID,
        });
        return { hostId: host.hostId, pid: host.pid };
      } finally {
        pendingLaunch = false;
      }
    },

    async startHost(host: ProcessHost): Promise<ProcessHost> {
      if (!pendingLaunch) {
        throw new Error(
          `Resident host ${host.hostId} was opened without a process; ` +
          'a resident host is started by the driver\'s run entry.',
        );
      }
      spawns += 1;
      return host;
    },

    async bind(): Promise<void> {},
    async submit(): Promise<void> {},
    async interrupt(): Promise<boolean> {
      return false;
    },
    async reconfigure(): Promise<'live' | 'next-turn'> {
      return 'live';
    },
    async unbind(): Promise<void> {},
    async closeHost(): Promise<void> {},
  };

  return driver;
}

/**
 * A driver that accepts a host opened under the per-run mode.
 *
 * The service's refusals are read against a *live* host in another mode, and a
 * per-run host is opened by `openHost` directly rather than through the
 * on-demand verb — so this stand-in has no launch gate. It is otherwise the
 * no-op shape the manager treats identically to a process-owning driver.
 */
function createPassiveDriver(): IProviderHostDriver {
  return {
    multiplexedHost: false,
    async startHost(host: ProcessHost): Promise<ProcessHost> {
      return host;
    },
    async bind(): Promise<void> {},
    async submit(): Promise<void> {},
    async interrupt(): Promise<boolean> {
      return false;
    },
    async reconfigure(): Promise<'live' | 'next-turn'> {
      return 'live';
    },
    async unbind(): Promise<void> {},
    async closeHost(): Promise<void> {},
  };
}

// ---------------------------
//----------------- THE HARNESS ------------
type Harness = {
  manager: SessionHostManager;
  driver: FakeDriver;
  sessions: Map<string, SessionLifecycleReading>;
  deps: ResidentHostServiceDeps;
};

/** One isolated manager + driver + seam set, per case. */
function createHarness(): Harness {
  const manager = createSessionHostManager();
  const driver = createFakeDriver(manager);
  const sessions = new Map<string, SessionLifecycleReading>();

  const deps: ResidentHostServiceDeps = {
    sessionHostManager: manager,
    readSession: (appSessionId) => sessions.get(appSessionId) ?? null,
    resolveHostDriver: (provider) => (provider === 'claude' ? driver : null),
    // The seam the composition root wires over `providerRuntimeService`: it asks
    // the driver's own on-demand verb. The launch bag is ignored by the stand-in.
    startResidentSession: (_provider, appSessionId) =>
      driver.startResidentSession(appSessionId, {} as HostResidentLaunch),
  };

  return { manager, driver, sessions, deps };
}

/** Seeds one session row's reading, which is all `readSession` answers. */
function seedSession(
  harness: Harness,
  sessionId: string,
  provider: LLMProvider,
  mode: HostMode,
): void {
  harness.sessions.set(sessionId, { provider, mode });
}

/** The live host serving a session, read from the manager's own port. */
function liveHost(manager: SessionHostManager, sessionId: string): ProcessHost | null {
  return manager.snapshot().find((host) => host.state !== 'closed' && host.bindings.has(sessionId)) ?? null;
}

// ---------------------------
//----------------- (a) EXISTENCE + THIN ROUTE + POSITIVE CONTROL ------------
test('AC2 (a): the service exists and the route makes none of the inline calls', () => {
  const routeSource = readFileSync(new URL('../session-hosts.routes.ts', import.meta.url), 'utf8');
  const serviceSource = readFileSync(new URL('../resident-host.service.ts', import.meta.url), 'utf8');

  assert.equal(typeof startResidentHost, 'function', 'startResidentHost is exported as a function');
  assert.equal(typeof closeResidentHost, 'function', 'closeResidentHost is exported as a function');

  const inlineCalls = [
    'readSession?.(',
    'resolveHostDriver?.(',
    'startResidentSession(',
    '.bindSession(',
    '.closeHost(',
  ];
  const routeCounts = inlineCalls.map((needle) => [needle, countOccurrences(routeSource, needle)] as const);

  say(`route inline counts ${routeCounts.map(([needle, n]) => `${needle}=${n}`).join(' ')}`);
  for (const [needle, n] of routeCounts) {
    assert.equal(n, 0, `the route must not call ${needle} — the decision lives in the service`);
  }

  const routeStartCalls = countOccurrences(routeSource, 'startResidentHost(');
  const routeCloseCalls = countOccurrences(routeSource, 'closeResidentHost(');
  say(`route service calls startResidentHost=${routeStartCalls} closeResidentHost=${routeCloseCalls}`);
  assert.ok(routeStartCalls >= 1, 'the start handler really calls startResidentHost');
  assert.ok(routeCloseCalls >= 1, 'the close handler really calls closeResidentHost');

  // The positive control: the same scanner run over the service must find the
  // calls the route no longer makes, so the zeros above are the extraction and
  // not a scanner reading nothing.
  const servicePatterns = [
    'readSession',
    'resolveHostDriver',
    'startResidentSession(',
    '.bindSession(',
    '.closeHost(',
  ];
  const serviceCounts = servicePatterns.map(
    (needle) => [needle, countOccurrences(serviceSource, needle)] as const,
  );
  say(`service counts ${serviceCounts.map(([needle, n]) => `${needle}=${n}`).join(' ')}`);
  for (const [needle, n] of serviceCounts) {
    assert.ok(n >= 1, `the service must contain ${needle} (positive control for the route zeros)`);
  }
});

// ---------------------------
//----------------- (b) THE FOUR START REFUSALS ------------
test('AC3 (b): the four start refusals keep status, code and sentence verbatim', async () => {
  const harness = createHarness();

  // 1. no such session.
  const notFound = await startResidentHost('missing-session', harness.deps);

  // 2. a live host already serving the session in another mode.
  const perRunId = 'runs-per-run';
  seedSession(harness, perRunId, 'claude', 'resident');
  await harness.manager.openHost({
    provider: 'claude',
    mode: 'per-run',
    appSessionId: perRunId,
    driver: createPassiveDriver(),
  });
  const alreadyRuns = await startResidentHost(perRunId, harness.deps);

  // 3. a resident session whose provider mounts no host driver.
  const noDriverId = 'resident-no-driver';
  seedSession(harness, noDriverId, 'codex', 'resident');
  const noDriver = await startResidentHost(noDriverId, harness.deps);

  // 4. a stored preference that is not residential.
  const storedId = 'stored-per-run';
  seedSession(harness, storedId, 'claude', 'per-run');
  const storedNotResident = await startResidentHost(storedId, harness.deps);

  say(`refusals ${JSON.stringify([notFound, alreadyRuns, noDriver, storedNotResident], null, 0)}`);

  assert.deepEqual(notFound, {
    ok: false,
    status: 404,
    code: 'SESSION_NOT_FOUND',
    message: `Session "missing-session" was not found.`,
  });
  assert.deepEqual(alreadyRuns, {
    ok: false,
    status: 409,
    code: 'LIFECYCLE_MODE_NOT_RESIDENT',
    message: `Session "${perRunId}" already runs in "per-run" mode; only a resident host can be started on demand.`,
  });
  assert.deepEqual(noDriver, {
    ok: false,
    status: 409,
    code: 'LIFECYCLE_MODE_HOST_UNAVAILABLE',
    message: `Provider "codex" mounts no host driver, so session "${noDriverId}" cannot be started.`,
  });
  assert.deepEqual(storedNotResident, {
    ok: false,
    status: 409,
    code: 'LIFECYCLE_MODE_NOT_RESIDENT',
    message: `Session "${storedId}" is stored as "per-run"; only a resident session can be started on demand.`,
  });

  await harness.manager.shutdown({ timeoutMs: 0 });
});

// ---------------------------
//----------------- (c) IDEMPOTENCE ------------
test('AC4 (c): a second start returns the same host and starts nothing', async () => {
  const harness = createHarness();
  const sessionId = 'idempotent-session';
  seedSession(harness, sessionId, 'claude', 'resident');

  const first = await startResidentHost(sessionId, harness.deps);
  if (!first.ok) {
    assert.fail(`the first start was refused: ${JSON.stringify(first)}`);
  }
  assert.equal(first.pid, FAKE_PID, 'the first start reports the launched pid');

  const second = await startResidentHost(sessionId, harness.deps);
  if (!second.ok) {
    assert.fail(`the repeated start was refused: ${JSON.stringify(second)}`);
  }

  say(
    `idempotent first.pid=${first.pid} second.pid=${second.pid} ` +
    `launches=${harness.driver.launches.length} spawns=${harness.driver.spawns()} ` +
    `sameHost=${first.hostId === second.hostId}`,
  );

  assert.equal(second.pid, first.pid, 'the repeated start answers with the same pid');
  assert.equal(second.hostId, first.hostId, 'and the same host');
  assert.equal(harness.driver.launches.length, 1, 'the launch seam was asked exactly once');
  assert.equal(harness.driver.spawns(), 1, 'and no second process came up');

  await harness.manager.shutdown({ timeoutMs: 0 });
});

// ---------------------------
//----------------- (d) CLOSE: REASON, HOST, LEASE, AND FOUR REFUSALS ------------
test('AC5 (d): close returns the reason, host and resident-policy lease, with four verbatim refusals', async () => {
  const harness = createHarness();

  // The close that must succeed: start first, then close the same session.
  const closeableId = 'close-me';
  seedSession(harness, closeableId, 'claude', 'resident');
  const started = await startResidentHost(closeableId, harness.deps);
  if (!started.ok) {
    assert.fail(`the premise start was refused: ${JSON.stringify(started)}`);
  }
  assert.ok(liveHost(harness.manager, closeableId), 'the premise: a live host is serving it');

  const closed = closeResidentHost(closeableId, harness.deps);
  say(`closed ${JSON.stringify(closed)}`);

  if (!closed.ok) {
    assert.fail(`the close was refused: ${JSON.stringify(closed)}`);
  }
  assert.equal(closed.closeReason, 'user', 'the close records the user as the reason');
  assert.equal(closed.hostId, started.hostId, 'and names the host the start returned');
  assert.equal(closed.mode, 'resident');
  assert.deepEqual(
    closed.leases,
    [{ kind: 'resident-policy' }],
    'the resident-policy lease is read back from the real binding',
  );
  assert.equal(liveHost(harness.manager, closeableId), null, 'the host is no longer live afterwards');

  // 1. a live host serving the session in another mode.
  const perRunId = 'close-per-run';
  seedSession(harness, perRunId, 'claude', 'per-run');
  await harness.manager.openHost({
    provider: 'claude',
    mode: 'per-run',
    appSessionId: perRunId,
    driver: createPassiveDriver(),
  });
  const hostNotResident = closeResidentHost(perRunId, harness.deps);

  // 2. no such session.
  const notFound = closeResidentHost('missing-session', harness.deps);

  // 3. a stored preference that is not residential.
  const storedId = 'close-stored-per-run';
  seedSession(harness, storedId, 'claude', 'per-run');
  const storedNotResident = closeResidentHost(storedId, harness.deps);

  // 4. a resident session with no live host.
  const hostlessId = 'close-resident-hostless';
  seedSession(harness, hostlessId, 'claude', 'resident');
  const hostless = closeResidentHost(hostlessId, harness.deps);

  say(
    `close refusals ${JSON.stringify([hostNotResident, notFound, storedNotResident, hostless], null, 0)}`,
  );

  assert.deepEqual(hostNotResident, {
    ok: false,
    status: 409,
    code: 'LIFECYCLE_MODE_NOT_RESIDENT',
    message: `Session "${perRunId}" runs in "per-run" mode; only a resident host can be closed on demand.`,
  });
  assert.deepEqual(notFound, {
    ok: false,
    status: 404,
    code: 'SESSION_NOT_FOUND',
    message: `Session "missing-session" was not found.`,
  });
  assert.deepEqual(storedNotResident, {
    ok: false,
    status: 409,
    code: 'LIFECYCLE_MODE_NOT_RESIDENT',
    message: `Session "${storedId}" is stored as "per-run"; only a resident session can be closed on demand.`,
  });
  assert.deepEqual(hostless, {
    ok: false,
    status: 404,
    code: 'SESSION_HOST_NOT_FOUND',
    message: `Session "${hostlessId}" is resident but no live host is serving it.`,
  });

  await harness.manager.shutdown({ timeoutMs: 0 });
});

// ---------------------------
//----------------- (e) NO SOCKET, NO HTTP ------------
test('AC6 (e): the criterion opens no listener and imports no express or WebSocket', () => {
  const self = readFileSync(new URL(import.meta.url), 'utf8');

  // The needles are built from fragments so the assertion source does not itself
  // contain the pattern it forbids — a self-match that would make every count 1.
  const forbidden = [
    ['import express', `from '` + 'express' + `'`],
    ['listen(', '.lis' + 'ten('],
    ['WebSocket constructor', 'new Web' + 'Socket('],
    ['WebSocketServer constructor', 'new Web' + 'SocketServer('],
  ];
  const readings = forbidden.map(
    ([label, needle]) => [label, needle, countOccurrences(self, needle)] as const,
  );

  say(
    `self-scan ${readings.map(([label, needle, n]) => `${label}<${needle}>=${n}`).join(' ')}`,
  );
  for (const [label, needle, n] of readings) {
    assert.equal(n, 0, `the criterion must not contain ${label} (needle ${JSON.stringify(needle)})`);
  }
});
