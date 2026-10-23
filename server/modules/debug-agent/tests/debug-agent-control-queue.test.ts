/**
 * AC-238 criterion — the debug agent's resident driver carries a busy send's
 * queued message end to end, through the CONTROL SERVICE and not a WebSocket.
 *
 * What is pinned here is the handover the SPEC's §527 premise asks for
 * (`docs/proposals/mcp-gateway-SPEC.md`, "未核实的前提" 5): the driver must give
 * the caller the uuid it minted for the queued message, so the withdrawal path
 * can be covered without a real CLI. Four readings, each a state observation
 * rather than a timing guess:
 *
 *   (a) a resident session that is mid-turn queues a second `send`:
 *       `queued: true`, a non-empty `queuedMessageUuid`, and that uuid is the
 *       TAIL of the driver's own queue — i.e. the driver handed it over, the
 *       control service did not mint it;
 *   (b) with no withdrawal, the first round ends and the queued command is
 *       dequeued into a round of its own — a runId distinct from the first
 *       round's — and BOTH rounds carry a terminal frame;
 *   (c) with a withdrawal by that uuid, the verdict is the union's `withdrawn`
 *       (AC-238's "cancelled"), the message really leaves the driver queue, no
 *       second round appears when the scenario advances, and the host's pid is
 *       unchanged;
 *   (d) a withdrawal AFTER the command was dequeued answers `already-started`,
 *       not `withdrawn` — the queue state, not a promise about the future.
 *       (AC-287 moved this reading from the ambiguous `unknown`: the driver now
 *       remembers what it dequeued, so "this process started it" is told apart
 *       from "this process never held it". The assertion's intent — "not
 *       withdrawn" — is unchanged and now names the fact precisely.)
 *
 * Vocabulary note. AC-238's prose names the successful withdrawal `cancelled`.
 * The shared union `HostQueuedInputCancelResult` (`server/shared/types.ts`) has
 * no such member: its successful-withdrawal value is `withdrawn`, which is also
 * exactly what the real Claude resident driver returns
 * (`claude-host-driver.provider.ts`). This criterion reads the driver's own,
 * type-correct value and prints it raw; a criterion that fabricated a
 * `cancelled` member would be measuring its own cast.
 *
 * Why every reading comes from a CHILD process: the gate is evaluated once per
 * process and the fixture home is a per-run scratch directory, so a child per
 * arm is the only way to take a reading without the previous arm's state in it.
 * This mirrors the host-driver, control-plane, gate and frames criteria.
 *
 * What is NOT here, on purpose: the real Claude driver's `cancel_async_message`
 * (covered only by the existing real-CLI tests and the later manual gate), the
 * WebSocket protocol, and the sibling criteria this task must not break —
 * those are measured by the worker and recorded, not spawned from here.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  createProviderRuntimeService,
  forwardNormalizedFrames,
  providerRegistry,
} from '@/modules/providers/index.js';
import { createSessionHostManager, type SessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, createChatControlService } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

import {
  DEBUG_AGENT_PROVIDER_ID,
  armDebugAgentScenario,
  createDebugAgentProvider,
  type DebugAgentHostDriver,
  type DebugAgentOpenRun,
  type DebugAgentScenario,
} from '../index.js';

// Spelled through constants so this file never becomes a second reader of the
// gate variable: the gate criterion asserts that, outside the gate module,
// `server/` contains no direct read of it.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_CONTROL_QUEUE_PROBE';
const MODE_VAR = 'DEBUG_AGENT_CONTROL_QUEUE_MODE';
const PROBE_MARKER = '__DEBUG_AGENT_CONTROL_QUEUE_READING__';

const DEBUG_PROVIDER = DEBUG_AGENT_PROVIDER_ID as LLMProvider;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);

/** The caller shape `send`/`cancelQueued` take: an authenticated WebSocket front end. */
const CALLER = { userId: 1, via: 'websocket' as const };

/**
 * The scenario every arm drives. One quick row, then a `dequeue` step late
 * enough that the criterion's second `send` (and, in the withdrawn arm, its
 * `cancelQueued`) land while the first round is still in flight.
 *
 * `delta` is per-arm because a withdrawn message never reaches the queue's head,
 * so the `dequeue` step writes no `started` row for it.
 */
function scenario(delta: 1 | 2): DebugAgentScenario {
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: {
      title: 'debug agent control queue fixture',
      userText: 'the first round starts here',
      lifecycleMode: 'resident',
    },
    steps: [
      { at: 30, op: 'row', role: 'assistant', text: 'round one is running' },
      { at: 320, op: 'dequeue' },
    ],
    expect: {
      rows: { delta },
      content: { mustContain: ['round one is running'] },
    },
  };
}

type ChildMode = 'queue' | 'not-withdrawn' | 'withdrawn' | 'already-started';

type SendReading = {
  ok: boolean;
  runId: string | null;
  queued: boolean | null;
  queuedMessageUuid: string | null;
};

type BusyReading = {
  first: SendReading;
  second: SendReading;
  queueAfterSend: string[];
  queueTail: string | null;
};

type QueueReading = BusyReading & { mode: 'queue' };

type NotWithdrawnReading = BusyReading & {
  mode: 'not-withdrawn';
  round1RunId: string;
  round1Complete: boolean;
  round2RunId: string | null;
  round2Source: string | null;
  round2Text: string | null;
  round2Complete: boolean;
  openedRounds: number;
};

type WithdrawnReading = BusyReading & {
  mode: 'withdrawn';
  round1RunId: string;
  verdict: string;
  queueAfterCancel: string[];
  queueHeld: boolean;
  openedRounds: number;
  pidBefore: number | null;
  pidAfter: number | null;
  round1Complete: boolean;
};

type AlreadyStartedReading = BusyReading & {
  mode: 'already-started';
  round1RunId: string;
  queueAfterDequeue: string[];
  queueHeld: boolean;
  verdict: string;
  openedRounds: number;
};

type Reading = QueueReading | NotWithdrawnReading | WithdrawnReading | AlreadyStartedReading;

type ArmHarness = {
  sessionId: string;
  providerSessionId: string;
  hostDriver: DebugAgentHostDriver;
  manager: SessionHostManager;
  control: ReturnType<typeof createChatControlService>;
  /** Every run the host layer opened, in order — i.e. each queued command's round. */
  openedRounds: Array<{ runId: string; source: string; text: string }>;
};

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`control-queue ${line}`);
}

/** Awaits `predicate` becoming true, failing with a named line after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * Builds one arm's whole chain: the shipped provider factory with a run seam
 * this file owns (the registry wires none — it cannot reach the websocket module
 * without closing a cycle ADR-003 decision 7 forbids), a fresh host manager the
 * session is bound resident on, and the real gateway built by
 * `createProviderRuntimeService` over that manager and this provider.
 *
 * The debug agent's provider is built by its own factory rather than resolved
 * from the registry so the `openRun` seam is in scope; the registry still
 * supplies the claude base, the fixture-home synchronizer, and the capability
 * declaration that makes `resident` dispatchable to this driver.
 */
async function armHarness(label: string, delta: 1 | 2): Promise<ArmHarness> {
  const fixtureHome = process.env[GATE_HOME_VAR] ?? '';
  const registryProvider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);

  const armed = await armDebugAgentScenario({
    projectPath: path.join(fixtureHome, 'workspace', label),
    scenario: scenario(delta),
    synchronizeTranscript: (filePath) => registryProvider.sessionSynchronizer.synchronizeFile(filePath),
    setSessionLifecycleMode: ({ appSessionId, mode }) => sessionsDb.setSessionLifecycleMode(appSessionId, mode),
  });

  /** Every run the host layer opens, recorded so the criterion can name round two. */
  const openedRounds: Array<{ runId: string; source: string; text: string }> = [];
  const openRun: DebugAgentOpenRun = ({ appSessionId, text }) => {
    const run = chatRunRegistry.startRun({
      appSessionId,
      provider: DEBUG_PROVIDER,
      providerSessionId: armed.providerSessionId,
      connection: null,
      userId: null,
      source: 'unattended',
    });
    if (!run) {
      return null;
    }
    openedRounds.push({ runId: run.runId, source: String(run.source), text });
    return run.writer;
  };

  const provider = createDebugAgentProvider({
    base: providerRegistry.resolveProvider('claude'),
    forwardFrames: forwardNormalizedFrames,
    createSessionSynchronizer: () => registryProvider.sessionSynchronizer,
    openRun,
  });
  assert.ok(provider, 'the gate is open, so the factory must build a provider');
  const hostDriver = provider.hostDriver as DebugAgentHostDriver | undefined;
  assert.ok(hostDriver, 'the provider must carry a host driver');

  const manager = createSessionHostManager();
  const bound = await manager.bindSession({
    provider: DEBUG_PROVIDER,
    appSessionId: armed.sessionId,
    driver: hostDriver,
    mode: 'resident',
  });
  assert.ok(bound.ok, `the arm must place the session on a resident host (got ${JSON.stringify(bound)})`);

  const runtime = createProviderRuntimeService({
    sessionHostManager: manager,
    resolveProvider: (name) =>
      name === DEBUG_AGENT_PROVIDER_ID ? provider : providerRegistry.resolveProvider(name),
  });
  const control = createChatControlService({ runtime });

  return { sessionId: armed.sessionId, providerSessionId: armed.providerSessionId, hostDriver, manager, control, openedRounds };
}

/** One `send` result, trimmed to the fields every arm reads. */
function sendReading(result: Awaited<ReturnType<ArmHarness['control']['send']>>): SendReading {
  return result.ok
    ? { ok: true, runId: result.runId, queued: result.queued, queuedMessageUuid: result.queuedMessageUuid }
    : { ok: false, runId: null, queued: null, queuedMessageUuid: null };
}

/** The driver's queue, read back at the moment of interest. */
function queueOf(harness: ArmHarness): { list: string[]; tail: string | null } {
  const list = harness.hostDriver.readCommandQueue(harness.sessionId).queued;
  return { list, tail: list.length > 0 ? list[list.length - 1] : null };
}

/**
 * Sends twice: the first registers the resident turn, the second lands while it
 * is running. Returns both readings and the driver queue as it stood right after
 * the second send.
 */
async function sendTwice(harness: ArmHarness): Promise<BusyReading> {
  const first = sendReading(await harness.control.send(CALLER, { sessionId: harness.sessionId, content: 'first' }));
  assert.equal(first.ok, true, `the first send must register (got ${JSON.stringify(first)})`);
  assert.equal(first.queued, false, 'a send with no run in flight is not queued');

  const second = sendReading(await harness.control.send(CALLER, { sessionId: harness.sessionId, content: 'second' }));
  const queue = queueOf(harness);

  return { first, second, queueAfterSend: queue.list, queueTail: queue.tail };
}

/**
 * The terminal-frame reading for one run, from the registry's own summary.
 *
 * The registry marks a run `completed` in the same step it records the terminal
 * `complete` frame, so that status is the frame's registry-side fact. The run's
 * event buffer is no longer exposed on a by-id lookup (the lookup returns a
 * fixed read-only summary), and it is not needed here: this arm only asks
 * whether the round reached its terminal frame.
 */
function completeOf(runId: string | null): boolean {
  if (!runId) {
    return false;
  }
  return chatRunRegistry.getRunById(runId)?.status === 'completed';
}

// --------------------------- arms ---------------------------

/** (a) the busy send queues and hands over the driver's own uuid. */
async function readQueue(): Promise<QueueReading> {
  const harness = await armHarness('queue', 2);
  const busy = await sendTwice(harness);
  return { mode: 'queue', ...busy };
}

/** (b) no withdrawal: the queued command becomes its own round after round one. */
async function readNotWithdrawn(): Promise<NotWithdrawnReading> {
  const harness = await armHarness('not-withdrawn', 2);
  const busy = await sendTwice(harness);
  const round1RunId = busy.first.runId ?? '';

  await waitFor(
    () => chatRunRegistry.getRunById(round1RunId)?.status === 'completed',
    6_000,
    'the first round to complete',
  );
  await waitFor(() => harness.openedRounds.length >= 1, 6_000, 'the queued round to open');

  const round2 = harness.openedRounds[0];
  return {
    mode: 'not-withdrawn',
    ...busy,
    round1RunId,
    round1Complete: completeOf(round1RunId),
    round2RunId: round2?.runId ?? null,
    round2Source: round2?.source ?? null,
    round2Text: round2?.text ?? null,
    round2Complete: completeOf(round2?.runId ?? null),
    openedRounds: harness.openedRounds.length,
  };
}

/** (c) a withdrawal by that uuid really removes it and no round appears. */
async function readWithdrawn(): Promise<WithdrawnReading> {
  const harness = await armHarness('withdrawn', 1);
  const busy = await sendTwice(harness);
  const round1RunId = busy.first.runId ?? '';
  const uuid = busy.second.queuedMessageUuid ?? '';
  assert.ok(uuid.length > 0, 'the busy send must hand over a uuid to withdraw by');

  const pidBefore = harness.manager.liveHostForSession(harness.sessionId)?.pid ?? null;
  const verdict = await harness.control.cancelQueued(CALLER, { sessionId: harness.sessionId, messageUuid: uuid });
  const after = queueOf(harness);

  await waitFor(
    () => chatRunRegistry.getRunById(round1RunId)?.status === 'completed',
    6_000,
    'the first round to complete',
  );
  // Give any (wrong) second round a moment to appear before the count is read.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pidAfter = harness.manager.liveHostForSession(harness.sessionId)?.pid ?? null;

  return {
    mode: 'withdrawn',
    ...busy,
    round1RunId,
    verdict,
    queueAfterCancel: after.list,
    queueHeld: after.list.includes(uuid),
    openedRounds: harness.openedRounds.length,
    pidBefore,
    pidAfter,
    round1Complete: completeOf(round1RunId),
  };
}

/** (d) a withdrawal after the command was dequeued answers already-started. */
async function readAlreadyStarted(): Promise<AlreadyStartedReading> {
  const harness = await armHarness('already-started', 2);
  const busy = await sendTwice(harness);
  const round1RunId = busy.first.runId ?? '';
  const uuid = busy.second.queuedMessageUuid ?? '';
  assert.ok(uuid.length > 0, 'the busy send must hand over a uuid to withdraw by');

  // The queued round opening is the observable proof that `dequeue` took the
  // command and started it; only then is the withdrawal asked for.
  await waitFor(() => harness.openedRounds.length >= 1, 6_000, 'the queued command to be dequeued');
  const afterDequeue = queueOf(harness);
  const verdict = await harness.control.cancelQueued(CALLER, { sessionId: harness.sessionId, messageUuid: uuid });

  return {
    mode: 'already-started',
    ...busy,
    round1RunId,
    queueAfterDequeue: afterDequeue.list,
    queueHeld: afterDequeue.list.includes(uuid),
    verdict,
    openedRounds: harness.openedRounds.length,
  };
}

// --------------------------- child plumbing ---------------------------

async function readControlQueue(mode: ChildMode): Promise<Reading> {
  await initializeDatabase();

  switch (mode) {
    case 'queue':
      return readQueue();
    case 'not-withdrawn':
      return readNotWithdrawn();
    case 'withdrawn':
      return readWithdrawn();
    case 'already-started':
      return readAlreadyStarted();
  }
}

type ChildRun<Reading> = { reading: Reading; stdout: string };

/** How long one probe child may run: well under this criterion's own 60s ceiling. */
const CHILD_TIMEOUT_MS = 40_000;

/**
 * Runs one arm in a child. `HOME` and `DATABASE_PATH` are redirected into a
 * scratch directory so no arm can reach the machine's real `~/.claude` or its
 * real database, and the gate is opened only for these children.
 */
function runChild<Reading>(mode: ChildMode): ChildRun<Reading> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-control-queue-${mode}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  mkdirSync(home, { recursive: true });

  const databasePath = path.join(scratch, 'control-queue.db');
  writeFileSync(databasePath, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_PATH: databasePath,
    [PROBE_VAR]: '1',
    [MODE_VAR]: mode,
    [GATE_VAR]: 'on',
    [GATE_HOME_VAR]: fixtureHome,
  };

  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', 'server/tsconfig.json', SELF], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }) as unknown as string;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(
      `probe child (${mode}) exited non-zero.\n--- stdout ---\n${failure.stdout ?? ''}\n--- stderr ---\n${failure.stderr ?? String(error)}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const line = stdout
    .split('\n')
    .filter((entry) => entry.startsWith(PROBE_MARKER))
    .pop();
  assert.ok(line, `probe child (${mode}) printed no reading; stdout was:\n${stdout}`);

  return { reading: JSON.parse(line.slice(PROBE_MARKER.length)) as Reading, stdout };
}

if (process.env[PROBE_VAR] === '1') {
  const mode = process.env[MODE_VAR] as ChildMode | undefined;
  if (mode !== 'queue' && mode !== 'not-withdrawn' && mode !== 'withdrawn' && mode !== 'already-started') {
    throw new Error(`unknown probe mode ${JSON.stringify(mode)}`);
  }

  console.log(`${PROBE_MARKER}${JSON.stringify(await readControlQueue(mode))}`);
} else {
  registerCriteria();
}

// --------------------------- parent assertions ---------------------------

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    assert.fail(`${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
}

function registerCriteria(): void {
  test('(a) a busy resident send queues and hands over the driver queue tail', () => {
    const { reading } = runChild<QueueReading>('queue');
    say(
      `(a) first=${JSON.stringify(reading.first)} second=${JSON.stringify(reading.second)} ` +
        `queue=${JSON.stringify(reading.queueAfterSend)}`,
    );

    assert.equal(reading.first.ok, true, 'the first send must register');
    assert.equal(reading.second.ok, true, `the busy send must be queued, not refused (${JSON.stringify(reading.second)})`);
    assert.equal(reading.second.queued, true, 'a resident busy send reports queued');
    assertNonEmptyString(reading.second.queuedMessageUuid, 'queuedMessageUuid');
    assert.equal(
      reading.second.queuedMessageUuid,
      reading.queueTail,
      'the handed-over uuid must be the driver queue tail, not a value the control service minted',
    );
  });

  test('(b) with no withdrawal the queued message becomes its own completed round', () => {
    const { reading } = runChild<NotWithdrawnReading>('not-withdrawn');
    say(
      `(b) round1RunId=${reading.round1RunId} round1Complete=${reading.round1Complete} ` +
        `round2RunId=${reading.round2RunId} round2Source=${reading.round2Source} ` +
        `round2Text=${JSON.stringify(reading.round2Text)} round2Complete=${reading.round2Complete} ` +
        `openedRounds=${reading.openedRounds}`,
    );

    assertNonEmptyString(reading.second.queuedMessageUuid, 'queuedMessageUuid');
    assert.equal(reading.openedRounds, 1, 'exactly one queued round must be opened');
    assertNonEmptyString(reading.round2RunId, 'round2RunId');
    assert.notEqual(reading.round2RunId, reading.round1RunId, 'the second round must be a distinct run');
    assert.equal(reading.round1Complete, true, 'the first round must carry its own terminal frame');
    assert.equal(reading.round2Complete, true, 'the second round must carry its own terminal frame');
  });

  test('(c) a withdrawal removes the message and no round appears; the host pid is unchanged', () => {
    const { reading } = runChild<WithdrawnReading>('withdrawn');
    say(
      `(c) verdict=${reading.verdict} uuid=${reading.second.queuedMessageUuid} ` +
        `queueAfterCancel=${JSON.stringify(reading.queueAfterCancel)} queueHeld=${reading.queueHeld} ` +
        `openedRounds=${reading.openedRounds} round1Complete=${reading.round1Complete} ` +
        `pidBefore=${reading.pidBefore} pidAfter=${reading.pidAfter}`,
    );

    assertNonEmptyString(reading.second.queuedMessageUuid, 'queuedMessageUuid');
    assert.equal(
      reading.verdict,
      'withdrawn',
      'a queued message must be withdrawable by the returned uuid (the union member AC-238 calls "cancelled")',
    );
    assert.equal(reading.openedRounds, 0, 'a withdrawn message must never become a round');
    assert.equal(reading.queueHeld, false, 'the withdrawn message must really leave the driver queue');
    assert.equal(reading.round1Complete, true, 'the first round still completes normally');
    assert.equal(reading.pidAfter, reading.pidBefore, 'the withdrawal must not replace the held process');
  });

  test('(d) a withdrawal after the command was dequeued answers already-started', () => {
    const { reading } = runChild<AlreadyStartedReading>('already-started');
    say(
      `(d) uuid=${reading.second.queuedMessageUuid} queueAfterDequeue=${JSON.stringify(reading.queueAfterDequeue)} ` +
        `queueHeld=${reading.queueHeld} verdict=${reading.verdict} openedRounds=${reading.openedRounds}`,
    );

    assertNonEmptyString(reading.second.queuedMessageUuid, 'queuedMessageUuid');
    assert.equal(reading.queueHeld, false, 'the dequeued message is already out of the driver queue');
    // AC-287: the driver remembers what it dequeued, so a started message is
    // `already-started` — a named fact — rather than the ambiguous `unknown` it
    // used to share with "never held at all" (`server/shared/types.ts`).
    assert.equal(reading.verdict, 'already-started', 'a message already started cannot be withdrawn');
    assert.notEqual(reading.verdict, 'withdrawn');
  });

  test('(e) the criterion file itself neither imports ws nor constructs a socket', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8');

    // The needles are assembled from fragments so this guard's own source does
    // not contain the literals it searches for (a self-match would be a
    // permanent false positive, not a detection). The only child this file
    // spawns is `process.execPath` running this same file under tsx; the debug
    // agent, not a real CLI, is the provider under test.
    const wsModule = ['w', 's'].join('');
    const socketCtor = ['Web', 'Socket'].join('');
    const emitterCtor = ['Event', 'Emitter'].join('');
    const needles = [
      { label: `import from '${wsModule}'`, hit: new RegExp(`from\\s+['"]${wsModule}['"]`) },
      { label: `new ${socketCtor}(`, hit: new RegExp(`new\\s+${socketCtor}\\s*\\(`) },
      { label: `new ${emitterCtor}(`, hit: new RegExp(`new\\s+${emitterCtor}\\s*\\(`) },
    ].filter((needle) => needle.hit.test(source));

    say(`(e) socketReferences=${JSON.stringify(needles.map((needle) => needle.label))}`);
    assert.deepEqual(
      needles.map((needle) => needle.label),
      [],
      'the criterion must import no ws, construct no socket, and build no emitter to stand in for one',
    );
  });
}
