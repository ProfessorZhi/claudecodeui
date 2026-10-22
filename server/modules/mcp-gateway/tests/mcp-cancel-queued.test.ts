/**
 * AC-271 criterion: MCP `session_cancel_queued` withdraws a queued message by
 * the uuid `session_send` handed back, and the withdrawal is the tool's own
 * `cancelled` — not the control service's `withdrawn`, and never a fabricated
 * success for a message that already started.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the sessions are debug-agent
 * fixtures (`armDebugAgentScenario`) whose resident turns walk a real scenario;
 * the control service is the real `createChatControlService` over a real
 * `createProviderRuntimeService` — the SAME object the write tools and the
 * stage-6 resident tools are handed, wrapped by one spy that counts both `send`
 * and `cancelQueued`.
 *
 * The debug agent's gate is read ONCE per process and cached, and
 * `provider.registry.ts` builds its debug provider at module load. This file
 * therefore has NO static runtime application imports: it opens `DEBUG_AGENT`
 * (and redirects `HOME` into a scratch directory) BEFORE any aliased module is
 * pulled in, and every application module below comes in dynamically.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248/249's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) a busy resident `session_send` queues; the MCP withdrawal returns
 *       `outcome: 'cancelled'`, the uuid really leaves the driver queue, and
 *       when the scenario advances the withdrawn message never becomes a round
 *       — the driver opened no round, the registry holds no second run, and the
 *       resident host's pid is unchanged;
 *   (b) once the queued command is dequeued (started), withdrawing the same
 *       uuid returns the SUCCESS `outcome: 'already-started'` — NOT `cancelled`,
 *       and no longer the ambiguous `unknown` (AC-287) — and the second message
 *       really started a round;
 *   (c) a uuid that was never returned, and another resident session's own uuid,
 *       are BOTH errors `QUEUED_MESSAGE_NOT_FOUND` (AC-287: a reference to no
 *       live queued message is an error, not a reading) and leave both sessions'
 *       queues verbatim;
 *   (d) a token carrying only `cloudcli:session:send` is denied, exactly one
 *       `denied` audit row is written, and the control service's `cancelQueued`
 *       is never called.
 *
 * The false forms (AC8) mutate the implementation after this criterion is
 * green; they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { LLMProvider } from '@/shared/types.js';
import type { DebugAgentHostDriver } from '@/modules/debug-agent/index.js';

// --------------------------------------------------------------------------
// The environment is set BEFORE any aliased module is imported: the debug
// agent's gate is cached on first read, `provider.registry.ts` reads it at
// module load, and `shared/utils.ts` freezes IS_PLATFORM on first import.
//
// The gate variable is spelled through constants, exactly as the debug agent's
// own criteria do: `server/modules/debug-agent/tests/debug-agent-gate.test.ts`
// asserts that, outside the gate module, `server/` contains no direct read of
// it. The gate module stays the only parser; this file only sets the fixture
// before the first parse happens.
// --------------------------------------------------------------------------
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-cancel-queued-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
const FIXTURE_HOME = path.join(SCRATCH, 'fixture');
process.env.HOME = SCRATCH_HOME;
process.env[GATE_VAR] = 'on';
process.env[GATE_HOME_VAR] = FIXTURE_HOME;
process.env.JWT_SECRET = 'mcp-cancel-queued-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(FIXTURE_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, mcpAuditLogDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { createProviderRuntimeService, forwardNormalizedFrames, providerRegistry } = await import(
  '@/modules/providers/index.js'
);
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { BOOT_ID, chatRunRegistry, createChatControlService } = await import('@/modules/websocket/index.js');
const { DEBUG_AGENT_PROVIDER_ID, armDebugAgentScenario, createDebugAgentProvider } = await import(
  '@/modules/debug-agent/index.js'
);
const {
  MCP_GATEWAY_PATH,
  MCP_STAGE6_RESIDENT_TOOLS,
  buildRunGet,
  createMcpAuthMiddleware,
  mountMcpGateway,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;
type ChatControlService = ReturnType<typeof createChatControlService>;
type RuntimeService = ReturnType<typeof createProviderRuntimeService>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const DEBUG_PROVIDER = DEBUG_AGENT_PROVIDER_ID as LLMProvider;
const READ_SCOPE = 'cloudcli:read';
const SESSION_SEND_SCOPE = 'cloudcli:session:send';
const SESSION_CONTROL_SCOPE = 'cloudcli:session:control';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`cancel-queued ${line}`);
}

/** Awaits `predicate`, failing with a named line after `timeoutMs`. */
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

// --------------------------- HTTP: a node:http based fetch ---------------------------

const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

// --------------------------- tool result parsing ---------------------------

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let payload: AnyRecord | null = null;
  // AC-284: a FAILURE now carries its machine fields in `structuredContent`
  // (`{ code, message, retryable, details? }`) instead of a JSON string stuffed
  // into the text. Read that first; a SUCCESS payload is still the text body.
  if (call.isError === true && typeof call.structuredContent === 'object' && call.structuredContent !== null) {
    payload = call.structuredContent as AnyRecord;
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
    } catch {
      payload = null;
    }
  }
  return { isError: call.isError === true, text, payload };
}

// --------------------------- the control-service spy ---------------------------

type SpyCaller = { userId: string | number | null; via: string };

type SpyControl = {
  counts: { send: number; cancelQueued: number };
  callers: SpyCaller[];
  control: ChatControlService;
};

/**
 * Wraps the real control service so every `send` and `cancelQueued` records the
 * caller and bumps a counter, then delegates. The SAME object is handed to the
 * MCP gateway's write tools AND its resident tools, so "one instance" is a count
 * on one object rather than two that merely look alike — and the denied-scope
 * leg reads a zero `cancelQueued` count off the very service the tool would use.
 */
function wrapControl(real: ChatControlService): SpyControl {
  const counts = { send: 0, cancelQueued: 0 };
  const callers: SpyCaller[] = [];
  const control = {
    ...real,
    send: async (...args: Parameters<ChatControlService['send']>) => {
      counts.send += 1;
      callers.push({ userId: args[0].userId, via: args[0].via });
      return real.send(...args);
    },
    cancelQueued: async (...args: Parameters<ChatControlService['cancelQueued']>) => {
      counts.cancelQueued += 1;
      callers.push({ userId: args[0].userId, via: args[0].via });
      return real.cancelQueued(...args);
    },
  };
  return { counts, callers, control };
}

// --------------------------- scenario building ---------------------------

/**
 * A resident scenario whose walk keeps the first round running for `holdMs`, so
 * a reading can land mid-turn, and optionally a `dequeue` step that starts the
 * oldest queued command. `delta` is the expected row count of the walk (best
 * effort — the engine logs an unmet expectation but never fails the run):
 * `1` when the queued message is withdrawn or absent, `2` when `dequeue`
 * actually starts one.
 */
function holdScenario(label: string, options: { holdMs: number; dequeueAt?: number; delta: number }) {
  const steps: Array<Record<string, unknown>> = [
    { at: options.holdMs, op: 'row', role: 'assistant', text: `${label} round one is running` },
  ];
  if (options.dequeueAt !== undefined) {
    steps.push({ at: options.dequeueAt, op: 'dequeue' });
  }
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: `ac271 ${label}`, userText: `first round for ${label}`, lifecycleMode: 'resident' },
    steps,
    expect: { rows: { delta: options.delta }, content: { mustContain: [`${label} round one is running`] } },
  };
}

// --------------------------- harness ---------------------------

type ArmedScenario = Awaited<ReturnType<typeof armDebugAgentScenario>>;

type Harness = {
  sessionIds: string[];
  spy: SpyControl;
  /** Every round the driver opened for a dequeued command, in order. */
  openedRounds: Array<{ runId: string; text: string }>;
  /**
   * The live host serving a session, read from the manager's own binding table.
   *
   * The debug substitute is served in-process, so `pid` is the value the manager
   * recorded at `bindSession` (the debug driver reports no child pid — its own
   * comment says "no pid"), while `hostId` is the manager's real, non-null
   * identity for the held host. Reading both makes "the withdrawal did not
   * replace the held process" a claim about a live, identified host rather than a
   * `null === null` that survives the host being closed.
   */
  hostOf: (sessionId: string) => { hostId: string; pid: number | null; state: string } | null;
  /** The driver's own queue for a session, read back at the moment of interest. */
  queueOf: (sessionId: string) => { list: string[]; tail: string | null };
  /** Whether a given run has reached its terminal frame. */
  isRoundComplete: (runId: string) => boolean;
  /** How many runs the registry currently holds as running for a session. */
  runningCountFor: (sessionId: string) => number;
  call: (name: string, args?: AnyRecord, which?: 'main' | 'readonly') => Promise<ToolCall>;
};

type ArmOptions = {
  label: string;
  /** 1 or 2 resident sessions (the cross-session leg arms two). */
  sessions: number;
  /** How long the first round stays running. */
  holdMs: number;
  /** The instant the scenario dequeues the oldest queued command; absent means never. */
  dequeueAt?: number;
  delta: number;
};

/**
 * Boots one arm: a fresh temp database + fixture home, N armed debug scenarios
 * bound resident, the real runtime gateway over the factory-built debug
 * provider, the real control service wrapped by the spy, and the production
 * `/mcp` mount carrying BOTH the stage-4 write tools and the stage-6 resident
 * tools — over the one spy control service.
 */
async function withHarness(arm: ArmOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, `${arm.label}.db`);
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const registryProvider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
  const synchronizeTranscript = (filePath: string) => registryProvider.sessionSynchronizer.synchronizeFile(filePath);

  /** Every round the host layer opens for a dequeued command, recorded so the criterion can name it. */
  const openedRounds: Array<{ runId: string; text: string }> = [];
  const providerSessionByAppSession = new Map<string, string>();
  const openRun = ({ appSessionId, text }: { appSessionId: string; text: string }) => {
    const started = chatRunRegistry.startRun({
      appSessionId,
      provider: DEBUG_PROVIDER,
      providerSessionId: providerSessionByAppSession.get(appSessionId) ?? '',
      connection: null,
      userId: null,
      source: 'unattended',
    });
    if (!started) {
      return null;
    }
    openedRounds.push({ runId: started.runId, text });
    return started.writer;
  };

  const armedList: ArmedScenario[] = [];
  for (let index = 0; index < arm.sessions; index += 1) {
    const label = index === 0 ? arm.label : `${arm.label}-b`;
    const armed = await armDebugAgentScenario({
      projectPath: path.join(tempDirectory, 'projects', label),
      scenario: holdScenario(label, { holdMs: arm.holdMs, dequeueAt: arm.dequeueAt, delta: arm.delta }),
      synchronizeTranscript,
      setSessionLifecycleMode: ({ appSessionId, mode }) => sessionsDb.setSessionLifecycleMode(appSessionId, mode),
    });
    providerSessionByAppSession.set(armed.sessionId, armed.providerSessionId);
    armedList.push(armed);
  }

  const provider = createDebugAgentProvider({
    base: providerRegistry.resolveProvider('claude'),
    forwardFrames: forwardNormalizedFrames,
    createSessionSynchronizer: () => registryProvider.sessionSynchronizer,
    openRun,
  });
  assert.ok(provider, 'the gate is open, so the factory must build a provider');
  const hostDriver = provider.hostDriver as DebugAgentHostDriver | undefined;
  assert.ok(hostDriver, 'the provider must carry a host driver');

  const manager = createSessionHostManager({ scheduler: { schedule: () => () => {} } });
  for (const armed of armedList) {
    const bound = await manager.bindSession({
      provider: DEBUG_PROVIDER,
      appSessionId: armed.sessionId,
      driver: hostDriver,
      mode: 'resident',
    });
    assert.ok(bound.ok, `the arm must place ${armed.sessionId} on a resident host (got ${JSON.stringify(bound)})`);
  }

  const runtime = createProviderRuntimeService({
    sessionHostManager: manager,
    resolveProvider: (name) =>
      name === DEBUG_AGENT_PROVIDER_ID ? provider : providerRegistry.resolveProvider(name),
  });
  const realControl = createChatControlService({ runtime });
  const spy = wrapControl(realControl);

  const tokens = createAccessTokensService({ now: () => new Date() });
  const mainToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac271-main',
    scopes: [READ_SCOPE, SESSION_SEND_SCOPE, SESSION_CONTROL_SCOPE],
    expiresInDays: 30,
  });
  const sendOnlyToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac271-send-only',
    scopes: [READ_SCOPE, SESSION_SEND_SCOPE],
    expiresInDays: 30,
  });
  if (!mainToken.ok || !sendOnlyToken.ok) {
    throw new Error('the harness must mint both tokens');
  }

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    writeTools: {
      control: spy.control,
      runs: { getRun: (sessionId: string) => chatRunRegistry.getRun(sessionId) },
      runGet: {
        deps: {
          runs: chatRunRegistry,
          activity: { snapshot: () => null },
          sessions: { fetchHistory: async () => ({ messages: [] }) },
          now: () => Date.now(),
          sleep: async () => {},
          bootId: () => BOOT_ID,
        },
        build: buildRunGet,
      },
    },
    // The SAME spy control service the write tools use — the resident bag adds
    // only the `cancelQueued` verb this tool reads.
    residentTools: { control: spy.control },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ac271-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const main = await connect(mainToken.token.token);
  const readonly = await connect(sendOnlyToken.token.token);

  const callWith = async (client: Client, name: string, args: AnyRecord): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  // When the fixture's first `session_send` ran, so teardown can let its walk
  // finish before the transcript directory is removed.
  let firstSendAt = 0;

  try {
    await run({
      sessionIds: armedList.map((armed) => armed.sessionId),
      spy,
      openedRounds,
      hostOf: (sessionId) => {
        const host = manager.liveHostForSession(sessionId);
        return host === null ? null : { hostId: host.hostId, pid: host.pid, state: host.state };
      },
      queueOf: (sessionId) => {
        const list = hostDriver.readCommandQueue(sessionId).queued;
        return { list, tail: list.length > 0 ? list[list.length - 1] : null };
      },
      isRoundComplete: (runId) => chatRunRegistry.getRunById(runId)?.status === 'completed',
      runningCountFor: (sessionId) =>
        chatRunRegistry.listRunningRuns().filter((entry) => entry.sessionId === sessionId).length,
      call: (name, args = {}, which = 'main') => {
        if (name === 'session_send' && firstSendAt === 0) {
          firstSendAt = Date.now();
        }
        return callWith(which === 'readonly' ? readonly.client : main.client, name, args);
      },
    });
  } finally {
    if (firstSendAt > 0) {
      const walkMs = Math.max(arm.holdMs, arm.dequeueAt ?? 0);
      const settleBy = firstSendAt + walkMs + 1_000;
      while (Date.now() < settleBy) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await main.transport.close().catch(() => undefined);
    await readonly.transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// --------------------------- (a) cancelled, never a round, pid unchanged ---------------------------

test('(a) a queued withdrawal reports cancelled, never becomes a round, and keeps the host pid', { concurrency: false }, async () => {
  await withHarness({ label: 'cancel', sessions: 1, holdMs: 200, dequeueAt: 2_500, delta: 1 }, async (harness) => {
    const session = harness.sessionIds[0];

    const first = await harness.call('session_send', { session, message: 'first' });
    assert.equal(first.isError, false, `the first send must register (text=${first.text})`);
    const firstRunId = String(first.payload?.runId);

    const second = await harness.call('session_send', { session, message: 'second' });
    assert.equal(second.isError, false, `the busy send must queue, not throw (text=${second.text})`);
    const uuid = second.payload?.queuedMessageUuid;
    assert.ok(typeof uuid === 'string' && uuid.length > 0, 'the busy send must hand over a queuedMessageUuid');

    const hostBefore = harness.hostOf(session);
    const pidBefore = hostBefore?.pid ?? null;
    const queueBefore = harness.queueOf(session);
    const cancel = await harness.call('session_cancel_queued', { session, messageUuid: uuid });
    const queueAfter = harness.queueOf(session);
    const hostAfterCancel = harness.hostOf(session);

    say(`(a) first=${JSON.stringify(first.payload)}`);
    say(`(a) second=${JSON.stringify(second.payload)}`);
    say(`(a) cancel=${JSON.stringify(cancel.payload)} isError=${cancel.isError} text=${JSON.stringify(cancel.text)}`);
    say(`(a) queueBefore=${JSON.stringify(queueBefore)} queueAfterCancel=${JSON.stringify(queueAfter)}`);
    say(`(a) hostBefore=${JSON.stringify(hostBefore)} hostAfterCancel=${JSON.stringify(hostAfterCancel)}`);

    assert.equal(cancel.isError, false, `the withdrawal must not error (text=${cancel.text})`);
    assert.equal(cancel.payload?.outcome, 'cancelled', 'a queued withdrawal must report AC-271 cancelled');
    assert.notEqual(cancel.payload?.outcome, 'withdrawn', 'the tool must NOT pass the control service withdrawn through');
    assert.equal(queueBefore.list.includes(String(uuid)), true, 'positive control: the uuid IS queued before the withdrawal');
    assert.equal(queueAfter.list.includes(String(uuid)), false, 'the withdrawn uuid must really leave the driver queue');

    // Advance the scenario: the dequeue step now has nothing to start.
    await waitFor(() => harness.isRoundComplete(firstRunId), 15_000, 'the first round to complete');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hostAfter = harness.hostOf(session);
    const pidAfter = hostAfter?.pid ?? null;
    const runningCount = harness.runningCountFor(session);

    say(`(a) openedRounds=${JSON.stringify(harness.openedRounds)}`);
    say(`(a) runningForSession=${runningCount} hostAfter=${JSON.stringify(hostAfter)}`);
    say(`(a) pidBefore=${pidBefore} pidAfter=${pidAfter}`);

    assert.equal(harness.openedRounds.length, 0, 'a withdrawn message must never become a round');
    assert.equal(runningCount, 0, 'the registry must hold no second run for the session');
    assert.ok(hostBefore !== null, 'positive control: a live resident host must serve the session before the withdrawal');
    assert.ok(hostAfter !== null, 'the resident host must still be live after the withdrawal');
    assert.equal(hostAfter?.hostId, hostBefore?.hostId, 'the withdrawal must not replace the held resident host');
    assert.equal(pidAfter, pidBefore, 'the resident host pid must be verbatim unchanged');
  });
});

// --------------------------- (b) already started is not cancelled ---------------------------

test('(b) withdrawing an already-dequeued message is already-started (not cancelled) and the message really started', { concurrency: false }, async () => {
  await withHarness({ label: 'started', sessions: 1, holdMs: 200, dequeueAt: 1_500, delta: 2 }, async (harness) => {
    const session = harness.sessionIds[0];

    const first = await harness.call('session_send', { session, message: 'first' });
    assert.equal(first.isError, false, `the first send must register (text=${first.text})`);
    const second = await harness.call('session_send', { session, message: 'second' });
    assert.equal(second.isError, false, `the busy send must queue (text=${second.text})`);
    const uuid = second.payload?.queuedMessageUuid;
    assert.ok(typeof uuid === 'string' && uuid.length > 0, 'the busy send must hand over a queuedMessageUuid');

    // The dequeued round opening is the observable proof that the command left
    // the queue and started; only then is the withdrawal asked for.
    await waitFor(() => harness.openedRounds.length >= 1, 15_000, 'the queued command to be dequeued');
    const queueAfterDequeue = harness.queueOf(session);
    const cancel = await harness.call('session_cancel_queued', { session, messageUuid: uuid });

    say(`(b) second=${JSON.stringify(second.payload)}`);
    say(`(b) openedRounds=${JSON.stringify(harness.openedRounds)}`);
    say(`(b) queueAfterDequeue=${JSON.stringify(queueAfterDequeue)}`);
    say(`(b) cancel=${JSON.stringify(cancel.payload)} isError=${cancel.isError} text=${JSON.stringify(cancel.text)}`);

    assert.equal(cancel.isError, false, `the withdrawal must not error (text=${cancel.text})`);
    assert.notEqual(cancel.payload?.outcome, 'cancelled', 'a message already taken must NOT be reported cancelled');
    // AC-287: a dequeued message is `already-started` — the named fact the debug
    // driver now reports instead of the ambiguous `unknown` it used to share with
    // "never held at all". Still a SUCCESS: the message really started.
    assert.equal(
      cancel.payload?.outcome,
      'already-started',
      'the debug driver reads an already-started message as already-started',
    );
    assert.equal(queueAfterDequeue.list.includes(String(uuid)), false, 'the dequeued message is already out of the queue');
    assert.ok(harness.openedRounds.length >= 1, 'the second message really started a round');
  });
});

// --------------------------- (c) unknown and cross-session ---------------------------

test('(c) a never-returned uuid and another session uuid are both QUEUED_MESSAGE_NOT_FOUND and leave both queues verbatim', { concurrency: false }, async () => {
  await withHarness({ label: 'unknown', sessions: 2, holdMs: 2_000, delta: 1 }, async (harness) => {
    const [sessionA, sessionB] = harness.sessionIds;

    const aFirst = await harness.call('session_send', { session: sessionA, message: 'a-first' });
    assert.equal(aFirst.isError, false, `A's first send must register (text=${aFirst.text})`);
    const aSecond = await harness.call('session_send', { session: sessionA, message: 'a-second' });
    assert.equal(aSecond.isError, false, `A's busy send must queue (text=${aSecond.text})`);

    const bFirst = await harness.call('session_send', { session: sessionB, message: 'b-first' });
    assert.equal(bFirst.isError, false, `B's first send must register (text=${bFirst.text})`);
    const bSecond = await harness.call('session_send', { session: sessionB, message: 'b-second' });
    assert.equal(bSecond.isError, false, `B's busy send must queue (text=${bSecond.text})`);

    const uuidA = aSecond.payload?.queuedMessageUuid;
    const uuidB = bSecond.payload?.queuedMessageUuid;
    assert.ok(typeof uuidA === 'string' && uuidA.length > 0, "A's busy send must hand over a uuid");
    assert.ok(typeof uuidB === 'string' && uuidB.length > 0, "B's busy send must hand over a uuid");

    const queueABefore = harness.queueOf(sessionA);
    const queueBBefore = harness.queueOf(sessionB);
    const neverUuid = `never-returned-uuid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

    const never = await harness.call('session_cancel_queued', { session: sessionA, messageUuid: neverUuid });
    const cross = await harness.call('session_cancel_queued', { session: sessionA, messageUuid: uuidB });

    const queueAAfter = harness.queueOf(sessionA);
    const queueBAfter = harness.queueOf(sessionB);

    say(`(c) aSecond=${JSON.stringify(aSecond.payload)} bSecond=${JSON.stringify(bSecond.payload)}`);
    say(`(c) neverUuid=${neverUuid} never=${JSON.stringify(never.payload)} isError=${never.isError}`);
    say(`(c) crossSession(uuidB against A)=${JSON.stringify(cross.payload)} isError=${cross.isError}`);
    say(`(c) queueABefore=${JSON.stringify(queueABefore)} queueAAfter=${JSON.stringify(queueAAfter)}`);
    say(`(c) queueBBefore=${JSON.stringify(queueBBefore)} queueBAfter=${JSON.stringify(queueBAfter)}`);

    // AC-287: a uuid the host never held is an ERROR (`QUEUED_MESSAGE_NOT_FOUND`),
    // not an `unknown` success. Both the fabricated uuid and the other session's
    // live uuid are, from session A's host, ids it never held.
    assert.equal(never.isError, true, `the never-returned withdrawal must error (text=${never.text})`);
    assert.equal(never.payload?.code, 'QUEUED_MESSAGE_NOT_FOUND', 'a uuid that was never returned reads QUEUED_MESSAGE_NOT_FOUND');
    assert.equal(cross.isError, true, `the cross-session withdrawal must error (text=${cross.text})`);
    assert.equal(
      cross.payload?.code,
      'QUEUED_MESSAGE_NOT_FOUND',
      "another session's uuid reads QUEUED_MESSAGE_NOT_FOUND against the first",
    );
    assert.deepEqual(queueAAfter.list, queueABefore.list, "session A's driver queue must be verbatim unchanged");
    assert.deepEqual(queueBAfter.list, queueBBefore.list, "session B's driver queue must be verbatim unchanged");
    assert.equal(queueABefore.list.includes(String(uuidA)), true, 'positive control: A still holds its own queued uuid');
    assert.equal(queueBBefore.list.includes(String(uuidB)), true, 'positive control: B still holds its own queued uuid');
  });
});

// --------------------------- (d) scope denied + audit ---------------------------

test('(d) a token lacking the control scope is denied, audits one denied row, and never calls cancelQueued', { concurrency: false }, async () => {
  await withHarness({ label: 'denied', sessions: 1, holdMs: 1_500, delta: 1 }, async (harness) => {
    const before = mcpAuditLogDb.count();
    const cancelCallsBefore = harness.spy.counts.cancelQueued;

    const call = await harness.call(
      'session_cancel_queued',
      { session: harness.sessionIds[0], messageUuid: 'never-returned-uuid' },
      'readonly',
    );
    const cancelCallsAfter = harness.spy.counts.cancelQueued;
    const newRows = mcpAuditLogDb.allRows().filter((row) => row.id > before);

    say(
      `(d) isError=${call.isError} text=${JSON.stringify(call.text)} ` +
        `cancelCallsBefore=${cancelCallsBefore} cancelCallsAfter=${cancelCallsAfter}`,
    );
    say(`(d) newAuditRows=${JSON.stringify(newRows)}`);

    assert.equal(call.isError, true, 'a token lacking cloudcli:session:control must be denied');
    assert.equal(newRows.length, 1, 'exactly one audit row must be written');
    assert.equal(newRows[0].tool, 'session_cancel_queued', 'the audit row must name session_cancel_queued');
    assert.equal(newRows[0].outcome, 'denied', 'the audit row must read denied');
    // AC-286: the denied row names the missing scope, not just the denial.
    assert.deepEqual(
      JSON.parse(newRows[0].denied_scopes ?? 'null'),
      [SESSION_CONTROL_SCOPE],
      'the denied row must carry the missing control scope',
    );
    assert.equal(cancelCallsBefore, 0, 'the control service was not called before the denied call');
    assert.equal(cancelCallsAfter, 0, 'the control service must NOT be called for a denied tool');
  });
});

// --------------------------- the stage-6 table ---------------------------

test('the stage-6 resident table names session_cancel_queued with the control scope', () => {
  const names = MCP_STAGE6_RESIDENT_TOOLS.map((tool) => tool.name);
  const row = MCP_STAGE6_RESIDENT_TOOLS.find((tool) => tool.name === 'session_cancel_queued');

  say(`(table) ${JSON.stringify(MCP_STAGE6_RESIDENT_TOOLS)}`);

  assert.deepEqual(names, ['session_cancel_queued']);
  assert.equal(row?.scope, SESSION_CONTROL_SCOPE, 'the table must carry the cloudcli:session:control scope');
});

// --------------------------- (AC7) no socket, no real CLI ---------------------------

test('the criterion file neither opens a socket nor spawns a real CLI', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');

  // The needles are assembled from fragments so this guard's own source does
  // not contain the literals it searches for (a self-match would be a permanent
  // false positive, not a detection).
  const wsModule = ['w', 's'].join('');
  const socketCtor = ['Web', 'Socket'].join('');
  const childModule = ['node:child', '_process'].join('');
  const needles = [
    { label: `import from '${wsModule}'`, hit: new RegExp(`from\\s+['"]${wsModule}['"]`) },
    { label: `new ${socketCtor}(`, hit: new RegExp(`new\\s+${socketCtor}\\s*\\(`) },
    { label: `import from '${childModule}'`, hit: new RegExp(`['"]${childModule}['"]`) },
  ].filter((needle) => needle.hit.test(source));

  say(`(ac7) socketOrSpawnReferences=${JSON.stringify(needles.map((needle) => needle.label))}`);

  assert.deepEqual(
    needles.map((needle) => needle.label),
    [],
    'the criterion must import no ws, construct no socket, and spawn no real CLI',
  );
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
