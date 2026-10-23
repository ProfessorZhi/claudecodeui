/**
 * Criterion for starting a resident session on demand (AC1).
 *
 * The claim, in one sentence: with a claude resident host already alive — same
 * provider, same mode, and `multiplexedHost === false`, so the process carries
 * exactly one conversation — starting a *second* session must give that session
 * a process of its own, on the spot, with no turn behind it.
 *
 * Why this needed an entry of its own. A session is placed on a process through
 * `SessionHostManager.bindSession` ("which live process can take this
 * session?"), and for this driver that question has exactly two answers, both of
 * them no:
 *
 *   (1) another claude resident host is alive ⇒ `host-not-multiplexed`, because
 *       a process that declared one conversation per process does not take a
 *       second one;
 *   (2) no host is alive ⇒ `openHost` → `startHost`, which throws `opened
 *       without a process`, because a resident process is brought up by the
 *       driver's `run` entry and a cold start has no turn to bring one up.
 *
 * A fresh resident session is case (1) on any machine already running a resident
 * session — which is the normal case for the [Start] control — so neither
 * refusal is an edge: together they are the whole of the answer the control used
 * to get. Leg (1) below *measures* both rather than asserting this prose, and
 * prints the code and the message, so the readings the fix has to change are on
 * the record instead of being recalled.
 *
 * What is proven, in the order the criterion reads it:
 *
 *   (1) the two refusals the old entry produced, each with the live host count
 *       and the spawn count unchanged by it — a refusal that quietly opened
 *       something would make the fix's own `+1` unattributable.
 *   (2) the fix: `driver.startResidentSession` on a second session, beside a live
 *       host, answers with a host of its own, the live host count goes from one
 *       to two, the new host's `bindings` holds the second session and nothing
 *       else, its pid is the injected process's pid, and it reads `idle` — the
 *       state "up and holding nothing but the resident policy" is supposed to
 *       have. Both rows are printed so the pair can be compared without
 *       re-running anything.
 *   (3) the positive control on the same fixture: the same call again is
 *       idempotent — same `hostId`, same pid, no third host, and *no second
 *       spawn* — so "a repeated start spawns nothing" is a count rather than a
 *       hope, and so "the count grew" cannot be satisfied by a call that grows it
 *       every time.
 *   (4) the same entry under case (2)'s premise — no host alive at all — opens
 *       one process instead of throwing, which is the half of the old behaviour
 *       that `bindSession` could not produce either.
 *
 * Falsification (run and recorded in the completion record): with the driver's
 * entry changed back to `bindSession` — literally the call leg (1) makes — leg
 * (2) reds on "the live host count grew by exactly one" and on the pid, printing
 * the same `host-not-multiplexed`. Leg (1) is the standing negative control: it
 * asserts that entry's numbers, so the pair cannot both pass with the entry in
 * either position.
 *
 * Determinism, and its own world: no real process is spawned (`createProcess` is
 * this criterion's own factory, whose pid is a literal), the clock is a number
 * the criterion owns and the scheduler is a queue it never advances, and the two
 * things a launch reads outside the fixture are both re-pointed at a root this
 * criterion makes — the Remote Control gate at a settings file inside it that is
 * never written (so it reads "nothing was stated" rather than whatever the
 * machine running the suite has in its own `~/.claude`), and the model catalogue
 * at a database of its own rather than the deployer's. The catalogue is read for
 * every launch that names a model, and left alone it is whichever `DATABASE_PATH`
 * the shell happened to export — a criterion that read it could pass on one
 * machine and fail on another with the same code.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  HOST_BIND_ERROR_CODES,
  createSessionHostManager,
} from '@/modules/session-hosts/index.js';
import type {
  BindSessionInput,
  HostBindResult,
  HostScheduler,
  ProcessHost,
  SessionHostManager,
} from '@/modules/session-hosts/index.js';
import {
  ClaudeResidentHostDriver,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  AnyRecord,
  HostResidentLaunch,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/** The session whose process is brought up by a turn, before anything is asked. */
const SESSION_HELD = 'ac1-ondemand-held';
/** The session the on-demand entry is asked to start beside it. */
const SESSION_SECOND = 'ac1-ondemand-second';
/** The session leg (4) starts with no host alive at all. */
const SESSION_COLD = 'ac1-ondemand-cold';
/** The pid the injected factory reports, so a host's pid is a value to compare, not to guess. */
const FAKE_PID = 4242;
const PROJECT_PATH = '/tmp/ac1-ondemand-project';
const RESIDENT_MODEL = 'claude-sonnet-4-5';

/**
 * One line of this criterion's readings, prefixed so a reader can find them.
 *
 * `console.log` rather than a diagnostic because the readings *are* the
 * evidence: a leg that asserts without printing what it saw leaves a reader
 * unable to tell a passing assertion from a vacuous one.
 */
function say(line: string): void {
  console.log(`ondemand-start ${line}`);
}

// ---------------------------
//----------------- FIXTURE SCAFFOLDING ------------
/**
 * Runs one leg against a root this criterion owns, and dismantles it after.
 *
 * Two things outside the fixture are read by a launch: the Remote Control gate's
 * settings file and the model catalogue's database. Both are re-pointed into the
 * same fresh directory, so every reading below is a reading of a world this file
 * built — not of the shell's `DATABASE_PATH` or of the suite runner's home
 * directory. The database is migrated rather than faked because a launch with a
 * model id genuinely queries it, and a stub there would be this criterion
 * asserting its own substitute.
 */
async function withOwnRoot(runTest: (root: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(join(tmpdir(), 'ac1-ondemand-start-'));

  closeConnection();
  process.env.DATABASE_PATH = join(root, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(root);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A scheduler whose deadlines are queue entries and whose clock is a number.
 *
 * Nothing here advances it: this criterion is about a host being *opened*, not
 * about one being closed, and the quiet ceiling the manager arms on every idle
 * host is simply never reached. It is injected anyway so no reading in this file
 * depends on the wall clock the suite happens to run under.
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

/**
 * A resident process the criterion owns: a stream that says nothing, ever.
 *
 * The query never ends and never yields, which is load-bearing rather than
 * convenient. An iterable that finished would make the driver's read loop call
 * `reportExit`, the manager would close the host as `exited`, and every reading
 * below would be a reading of a dead process; a frame pushed into it would arm a
 * round nobody is holding. A resident process with nothing to report is exactly
 * what a just-started session is, so the silence is the fixture.
 */
type FakeProcess = {
  /** What the driver is constructed with. */
  factory: ClaudeResidentProcessFactory;
  /** How many processes the driver has spawned. */
  readonly spawns: number;
};

function createFakeProcess(): FakeProcess {
  let spawns = 0;

  const parked = (): Promise<IteratorResult<AnyRecord>> =>
    new Promise<IteratorResult<AnyRecord>>(() => undefined);

  const iterator: AsyncIterator<AnyRecord> = {
    next: parked,
    // Also parked: a `return()` that resolved would let a teardown look like an
    // orderly end of stream, and this fixture has no orderly end.
    return: parked,
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  return {
    factory: () => {
      spawns += 1;
      return { query, pid: FAKE_PID } satisfies ClaudeResidentProcess;
    },
    get spawns() {
      return spawns;
    },
  };
}

/** The runtime's own turn inputs, stubbed to the two facts a launch asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // No frames are asserted here: this criterion is about a process existing, and
  // the frame pipeline has its own criteria beside this one.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createWriter(): ProviderRuntimeWriter {
  return {
    send: () => undefined,
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

function createLeg(sessionId: string, root: string): Leg {
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
    // The launch gate reads one user-level settings file, and left to itself that
    // file is the deployer's own `~/.claude/settings.json`: a machine with Remote
    // Control on would refuse every launch below, and a machine without it would
    // pass — the same criterion, two verdicts, decided by a dotfile this test
    // does not own. The path below is inside a directory this criterion made and
    // never writes, which reads as "nothing was stated" on every machine.
    userSettingsPath: join(root, 'settings.json'),
  });
  return { clock, manager, driver, process, sessionId, rounds: [] };
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 50; hop += 1) {
    await Promise.resolve();
  }
}

/** Every host the manager still calls live — a closed record is a post-mortem, not a process. */
function liveHosts(leg: Leg): ProcessHost[] {
  return leg.manager.snapshot().filter((host) => host.state !== 'closed');
}

/** The live host holding one session, or null. */
function hostHolding(leg: Leg, sessionId: string): ProcessHost | null {
  let found: ProcessHost | null = null;
  for (const host of liveHosts(leg)) {
    if (host.bindings.has(sessionId)) {
      found = host;
    }
  }
  return found;
}

/** One host as a single line, so two of them can be compared by eye. */
function describeHost(host: ProcessHost): string {
  return (
    `hostId=${host.hostId} mode=${host.mode} provider=${host.provider} ` +
    `pid=${host.pid ?? '<none>'} state=${host.state} bindings=[${[...host.bindings.keys()].join(',')}]`
  );
}

/**
 * Arms one real round through the driver's `run` entry and waits for its lease.
 *
 * The wait is on the `turn` lease rather than on the host record because the
 * lease is the later of the two facts: by the time it is there, `openHost` has
 * answered, `startHost` has adopted the process, and `run` is parked at the
 * round's settlement. The round is deliberately never ended — this criterion
 * needs a *live* host of the ordinary kind, which is what "a session is running"
 * looks like from the manager's side.
 */
async function beginRound(leg: Leg, label: string): Promise<void> {
  leg.rounds.push(
    leg.driver.run(leg.sessionId, { command: label, options: {} }, createWriter(), CONTEXT),
  );
  for (let hop = 0; hop < 400; hop += 1) {
    const binding = hostHolding(leg, leg.sessionId)?.bindings.get(leg.sessionId);
    if (binding?.leases.some((lease) => lease.kind === 'turn')) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('the resident host never armed a turn lease');
}

/**
 * The bag the route assembles for a cold start.
 *
 * Deliberately not a session row read here: the driver is handed the options the
 * session's next turn would launch under, which is why the shape below is the
 * one `defaultResidentLaunchOptions` produces (a `cwd` and a `model`) rather than
 * a fixture of the driver's own making. `providerSessionId` is absent for the
 * same reason it is absent there — the driver injects it from the context and it
 * is what becomes the SDK's `resume`, so a caller that stated it too would be
 * stating it twice.
 */
function launchFor(sessionId: string): HostResidentLaunch {
  return {
    options: { sessionId, cwd: PROJECT_PATH, model: RESIDENT_MODEL },
    context: CONTEXT,
  };
}

// ---------------------------
//----------------- (1) THE TWO REFUSALS THE OLD ENTRY PRODUCED ------------
test('AC1: the entry the route used to take refuses the second session both ways', async () => {
  await withOwnRoot(async (root) => {
    // The premise, stated as readings rather than as a comment: one live claude
    // resident host, one conversation per process allowed.
    const leg = createLeg(SESSION_HELD, root);
    await beginRound(leg, 'hold the first session open');
    assert.equal(leg.driver.multiplexedHost, false, 'the premise: one conversation per process');
    assert.equal(liveHosts(leg).length, 1, 'the premise: one live host');
    assert.equal(leg.process.spawns, 1, 'the premise: one process');

    const bindInput: BindSessionInput = {
      provider: 'claude',
      appSessionId: SESSION_SECOND,
      driver: leg.driver,
    };
    const refused: HostBindResult = await leg.manager.bindSession(bindInput);

    assert.equal(refused.ok, false, 'a live single-conversation host does not take a second session');
    assert.equal(
      refused.ok === false ? refused.code : null,
      'host-not-multiplexed',
      'and says so with the vocabulary member that names it',
    );
    // Read against the runtime list the manager is typed to, so this asserts the
    // refusal is a member of the vocabulary rather than a string typed twice.
    assert.ok(HOST_BIND_ERROR_CODES.includes('host-not-multiplexed'));
    assert.equal(liveHosts(leg).length, 1, 'the refusal opened nothing');
    assert.equal(leg.process.spawns, 1, 'and spawned nothing');
    say(
      `refusal#1 entry=bindSession liveHost=1 code=${refused.ok === false ? refused.code : '<ok>'} ` +
      `liveHosts=${liveHosts(leg).length} spawns=${leg.process.spawns}`,
    );

    // The other half of the old behaviour: no host alive at all.
    const cold = createLeg(SESSION_COLD, root);
    let thrown: unknown = null;
    try {
      await cold.manager.bindSession({
        provider: 'claude',
        appSessionId: SESSION_COLD,
        driver: cold.driver,
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof Error, 'binding with no host alive rejects rather than answering');
    assert.match(
      (thrown as Error).message,
      /opened without a process/,
      'and the rejection is the driver refusing to adopt a host it never started',
    );
    assert.equal(liveHosts(cold).length, 0, 'the failed open left no live host behind');
    assert.equal(cold.process.spawns, 0, 'and spawned nothing');
    say(
      `refusal#2 entry=bindSession liveHost=0 liveHosts=${liveHosts(cold).length} ` +
      `spawns=${cold.process.spawns} message="${(thrown as Error).message}"`,
    );

    await settle();
  });
});

// ---------------------------
//----------------- (2) THE FIX: A PROCESS OF ITS OWN ------------
test('AC1: on-demand start gives the second session its own process beside a live host', async () => {
  await withOwnRoot(async (root) => {
    const leg = createLeg(SESSION_HELD, root);
    await beginRound(leg, 'hold the first session open');

    const before = liveHosts(leg);
    assert.equal(before.length, 1);
    for (const host of before) {
      say(`before ${describeHost(host)}`);
    }

    const started = await leg.driver.startResidentSession(SESSION_SECOND, launchFor(SESSION_SECOND));

    const after = liveHosts(leg);
    assert.equal(after.length, before.length + 1, 'the live host count grew by exactly one');
    assert.equal(started.pid, FAKE_PID, 'the new host carries the injected process pid');
    assert.notEqual(
      started.hostId,
      before[0].hostId,
      "the second session did not land on the first session's process",
    );

    const fresh = hostHolding(leg, SESSION_SECOND);
    assert.ok(fresh, 'a live host holds the second session');
    assert.equal(fresh.hostId, started.hostId, 'and it is the host the entry answered with');
    assert.deepEqual(
      [...fresh.bindings.keys()],
      [SESSION_SECOND],
      'the new process carries the second session and no other',
    );
    assert.equal(fresh.pid, FAKE_PID, 'the host row carries the same pid the entry answered with');
    assert.equal(fresh.mode, 'resident');
    assert.equal(fresh.state, 'idle', 'started with nothing asked of it yet');
    assert.equal(leg.process.spawns, 2, 'a second process was really brought up');

    for (const host of after) {
      say(`after ${describeHost(host)}`);
    }

    // Positive control, on this same fixture: a second start is a success that
    // spawns nothing. Without it, "the count grew" would also be satisfied by an
    // entry that grew it on every call.
    const again = await leg.driver.startResidentSession(SESSION_SECOND, launchFor(SESSION_SECOND));
    assert.equal(again.hostId, started.hostId, 'a repeated start answers with the host already serving');
    assert.equal(again.pid, started.pid);
    assert.equal(liveHosts(leg).length, after.length, 'and opens no third host');
    assert.equal(leg.process.spawns, 2, 'and spawns nothing');
    say(
      `idempotent hostId=${again.hostId} pid=${again.pid} liveHosts=${liveHosts(leg).length} ` +
      `spawns=${leg.process.spawns}`,
    );

    await settle();
  });
});

// ---------------------------
//----------------- (3) THE OTHER PREMISE: NO HOST ALIVE AT ALL ------------
test('AC1: on-demand start with no live host opens one rather than throwing', async () => {
  await withOwnRoot(async (root) => {
    const leg = createLeg(SESSION_COLD, root);
    assert.equal(liveHosts(leg).length, 0, 'the premise: nothing is running');

    const started = await leg.driver.startResidentSession(SESSION_COLD, launchFor(SESSION_COLD));

    const hosts = liveHosts(leg);
    assert.equal(hosts.length, 1, 'one process, opened for this session');
    assert.equal(hosts[0].hostId, started.hostId);
    assert.equal(hosts[0].pid, FAKE_PID);
    assert.deepEqual([...hosts[0].bindings.keys()], [SESSION_COLD]);
    assert.equal(hosts[0].state, 'idle');
    assert.equal(leg.process.spawns, 1);
    say(`cold-start ${describeHost(hosts[0])}`);

    await settle();
  });
});
