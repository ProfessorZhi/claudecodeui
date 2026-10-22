/**
 * AC-272 criterion: MCP `session_reconfigure` updates a session's stored
 * model/effort/permissionMode, reapplies what a provider can apply LIVE to its
 * resident process without restarting it, REFUSES an unsupported permission mode
 * with the supported list (the opposite of the WebSocket path's silent ignore),
 * and reports plainly when a provider offers no live reconfiguration.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the resident session is served
 * by the REAL `ClaudeResidentHostDriver` over a scripted query (the production
 * launch path with only its `createQuery` replaced, the shape
 * `claude-resident-permissions.test.ts` established); the control service is the
 * real `createChatControlService` over a real `createProviderRuntimeService`,
 * shared — as one object — by the MCP gateway and the WebSocket chat handler.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248/249's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) `session_reconfigure(model/effort/permissionMode)` writes the row, and
 *       the next `session_send`'s run options carry the new values verbatim;
 *   (b) a live change reaches the running process's `setModel`/`setPermissionMode`
 *       on the SAME host id and pid, with no new spawn; an effort-only change
 *       answers `next-turn` and touches no live verb;
 *   (c) a matrix-external `permissionMode` is refused with `supported` equal to
 *       the matrix, storage unchanged and no driver call, while the SAME value
 *       over the WebSocket `chat.send` path is silently ignored (row unchanged,
 *       no error);
 *   (d) a provider with no `liveReconfigure` answers `next-turn` /
 *       `liveSupported=false` with a message naming "live reconfiguration" and "next",
 *       and touches no live verb;
 *   (e) a token lacking `cloudcli:session:control` is denied, one `denied` audit
 *       row is written, and no write or driver call happens.
 *
 * The false forms (AC8) mutate the implementation after this criterion is green;
 * they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { AnyRecord, HostReconfigurePatch, LLMProvider, ProviderRuntimeWriter } from '@/shared/types.js';

// --------------------------------------------------------------------------
// A scratch HOME is set before any aliased module is imported, so the resident
// driver's Remote Control settings read lands on an empty directory (the same
// posture AC-168's criterion takes) and the model/catalog reads never touch the
// real user's config.
// --------------------------------------------------------------------------
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-session-reconfigure-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-session-reconfigure-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, mcpAuditLogDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const {
  ClaudeResidentHostDriver,
  createProviderRuntimeService,
  providerCapabilitiesService,
  providerModelsService,
  providerRegistry,
  sessionsService,
} = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const {
  BOOT_ID,
  chatRunRegistry,
  connectedClients,
  createChatControlService,
  handleChatConnection,
} = await import('@/modules/websocket/index.js');
const { MCP_GATEWAY_PATH, buildRunGet, createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');

type ChatControlService = ReturnType<typeof createChatControlService>;
type RuntimeService = ReturnType<typeof createProviderRuntimeService>;
type SessionHostManager = ReturnType<typeof createSessionHostManager>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const READ_SCOPE = 'cloudcli:read';
const SESSION_SEND_SCOPE = 'cloudcli:session:send';
const SESSION_CONTROL_SCOPE = 'cloudcli:session:control';
/** The pid every scripted process reports — a value, since no real child is spawned. */
const PROCESS_PID = 4242;

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`session-reconfigure ${line}`);
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

// --------------------------- the fake WebSocket ---------------------------

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: AnyRecord[];
  send(data: string): void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    try {
      socket.frames.push(JSON.parse(data) as AnyRecord);
    } catch {
      socket.frames.push({ raw: data });
    }
  };
  return socket;
}

// --------------------------- the fake clock ---------------------------

type FakeClock = {
  now(): number;
  schedule(at: number, run: () => void): () => void;
};

function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  const entries: Array<{ at: number; run: () => void; spent: boolean }> = [];
  return {
    now: () => current,
    schedule(at, run) {
      const entry = { at, run, spent: false };
      entries.push(entry);
      return () => {
        entry.spent = true;
      };
    },
  };
}

// --------------------------- the scripted resident process ---------------------------

type FakeProcess = {
  factory: (input: { options: AnyRecord }) => { query: unknown; pid: number | null; writeRaw: () => void };
  readonly launches: AnyRecord[];
  readonly setModels: string[];
  readonly setPermissionModes: string[];
  readonly spawns: number;
};

/**
 * A resident process the criterion owns: a query exposing the two live verbs,
 * plus the launch bag the driver built. The query never ends on its own, so the
 * driver's read loop stays parked (an iterable that finished would make the
 * driver call `reportExit` and the manager close the host as `exited`).
 *
 * The factory is substituted at the driver's own `createProcess` seam — the
 * point of that seam — so the driver, its host bookkeeping and its reconfigure
 * branch are the production ones.
 */
function createFakeProcess(): FakeProcess {
  const launches: AnyRecord[] = [];
  const setModels: string[] = [];
  const setPermissionModes: string[] = [];
  let spawns = 0;

  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
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
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
    setModel: async (model?: string) => {
      setModels.push(String(model));
    },
    setPermissionMode: async (mode: string) => {
      setPermissionModes.push(mode);
    },
  };

  return {
    factory: (input) => {
      spawns += 1;
      launches.push(input.options);
      return { query, pid: PROCESS_PID, writeRaw: () => undefined };
    },
    get launches() {
      return launches;
    },
    get setModels() {
      return setModels;
    },
    get setPermissionModes() {
      return setPermissionModes;
    },
    get spawns() {
      return spawns;
    },
  };
}

// --------------------------- harness ---------------------------

type SpyCounts = {
  model: string[];
  effort: string[];
  permissionMode: string[];
  reconfigurePatches: HostReconfigurePatch[];
};

type Harness = {
  sessionId: string;
  call: (name: string, args?: AnyRecord, which?: 'main' | 'readonly') => Promise<ToolCall>;
  wsSend: (args: AnyRecord) => Promise<AnyRecord | null>;
  chatControl: ChatControlService;
  runtime: RuntimeService;
  manager: SessionHostManager;
  process: FakeProcess;
  counts: SpyCounts;
  permissionModes: string[];
  /** The fake WebSocket the real `chat.send` handler answers on. */
  wsSocket: FakeSocket;
  /** The live host serving the session, as the manager publishes it, or null. */
  liveHost: () => { hostId: string; pid: number | null } | null;
  /** Every run-options bag `createProviderRuntimeService.run` was handed. */
  runOptions: AnyRecord[];
};

type HarnessOptions = {
  label: string;
  /**
   * A capability reader override for the reconfigure tool only. Defaults to the
   * real service; leg (d) supplies one whose `liveReconfigure` is empty.
   */
  capabilities?: {
    getProviderCapabilities(provider: LLMProvider): { permissionModes: string[]; residentFeatures?: AnyRecord };
    getRuntimeProviderCapabilities(provider: string): unknown;
  };
};

/**
 * Boots one arm: a fresh temp database + project directory, one resident claude
 * session, the real resident driver over a scripted process, the real runtime and
 * control services, and the production `/mcp` mount carrying the write tools and
 * the stage-6 resident tools.
 */
async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));
  const fixtureProject = path.join(tempDirectory, options.label);
  mkdirSync(fixtureProject, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'session-reconfigure.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const created = sessionsService.createAppSession('claude', fixtureProject, 'seed for reconfigure');
  const sessionId = created.sessionId;
  sessionsDb.setSessionLifecycleMode(sessionId, 'resident');

  const clock = createFakeClock();
  const manager = createSessionHostManager({ now: () => clock.now(), scheduler: clock });
  const fakeProcess = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: fakeProcess.factory as never,
    now: () => clock.now(),
  });

  const baseProvider = providerRegistry.resolveProvider('claude');
  const claudeProvider = { ...baseProvider, hostDriver: driver };
  const runtime = createProviderRuntimeService({
    sessionHostManager: manager,
    resolveProvider: (name: string) =>
      name === 'claude' ? (claudeProvider as never) : providerRegistry.resolveProvider(name),
  });

  const counts: SpyCounts = { model: [], effort: [], permissionMode: [], reconfigurePatches: [] };
  const runOptions: AnyRecord[] = [];

  const runtimeSpy = {
    ...runtime,
    run: (provider: LLMProvider, command: string, runOpts: AnyRecord, writer: ProviderRuntimeWriter) => {
      runOptions.push(runOpts);
      return runtime.run(provider, command, runOpts, writer);
    },
  };

  const realControl = createChatControlService({ runtime: runtimeSpy as RuntimeService });
  const controlSeen: Array<{ input: AnyRecord; result: AnyRecord }> = [];
  const controlSpy = {
    ...realControl,
    send: async (...args: Parameters<ChatControlService['send']>) => {
      const result = await realControl.send(...args);
      controlSeen.push({ input: args[1] as unknown as AnyRecord, result: result as unknown as AnyRecord });
      return result;
    },
  };

  const modelsSpy = {
    setSessionModel: (provider: LLMProvider, id: string, value: string) => {
      counts.model.push(value);
      return providerModelsService.setSessionModel(provider, id, value);
    },
    setSessionEffort: (provider: LLMProvider, id: string, value: string) => {
      counts.effort.push(value);
      return providerModelsService.setSessionEffort(provider, id, value);
    },
    setSessionPermissionMode: (provider: LLMProvider, id: string, value: string) => {
      counts.permissionMode.push(value);
      return providerModelsService.setSessionPermissionMode(provider, id, value);
    },
  };

  const reconfigureSeam = {
    reconfigure: (provider: LLMProvider, id: string, patch: HostReconfigurePatch) => {
      counts.reconfigurePatches.push(patch);
      return runtime.reconfigure(provider, id, patch);
    },
  };

  const capabilities = options.capabilities ?? {
    getProviderCapabilities: (provider: LLMProvider) => providerCapabilitiesService.getProviderCapabilities(provider),
    getRuntimeProviderCapabilities: (provider: string) =>
      providerCapabilitiesService.getRuntimeProviderCapabilities(provider),
  };

  const tokens = createAccessTokensService({ now: () => new Date() });
  const mainToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac272-main',
    scopes: [READ_SCOPE, SESSION_SEND_SCOPE, SESSION_CONTROL_SCOPE],
    expiresInDays: 30,
  });
  const sendOnlyToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac272-send-only',
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
      control: controlSpy,
      runs: { getRun: (id: string) => chatRunRegistry.getRun(id) },
      runGet: {
        deps: {
          runs: chatRunRegistry,
          activity: { snapshot: () => null },
          sessions: { fetchHistory: async () => ({ messages: [] }) },
          now: () => Date.now(),
          sleep: async () => undefined,
          bootId: () => BOOT_ID,
        },
        build: buildRunGet,
      },
      selection: {
        sessions: { getSessionById: (id: string) => sessionsDb.getSessionById(id) },
        models: { resolveSessionModel: (provider: LLMProvider, opts: { sessionId: string }) => providerModelsService.resolveSessionModel(provider, opts) },
      },
    },
    residentTools: {
      control: controlSpy,
      reconfigure: {
        sessions: { getSessionById: (id: string) => sessionsDb.getSessionById(id) },
        runtime: reconfigureSeam,
        models: modelsSpy as never,
        capabilities: capabilities as never,
      },
    },
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
    const client = new Client({ name: 'ac272-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const main = await connect(mainToken.token.token);
  const sendOnly = await connect(sendOnlyToken.token.token);

  const callWith = async (client: Client, name: string, args: AnyRecord): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  const wsSocket = createFakeSocket();
  handleChatConnection(wsSocket as never, { user: { id: USER_ONE } } as never, {
    runtime: runtimeSpy,
    control: controlSpy,
  } as never);

  try {
    await run({
      sessionId,
      call: (name, args = {}, which = 'main') =>
        callWith(which === 'readonly' ? sendOnly.client : main.client, name, args),
      wsSend: async (args) => {
        const before = controlSeen.length;
        const handler = wsSocket.listeners('message')[0] as unknown as (raw: unknown) => Promise<void>;
        void handler(JSON.stringify({ type: 'chat.send', ...args }));
        await waitFor(() => controlSeen.length > before, 5_000, 'the WebSocket chat.send to reach the control service');
        return controlSeen.at(-1)?.result ?? null;
      },
      chatControl: controlSpy as ChatControlService,
      runtime,
      manager,
      process: fakeProcess,
      counts,
      permissionModes: providerCapabilitiesService.getProviderCapabilities('claude').permissionModes,
      wsSocket,
      liveHost: () => {
        const host = manager.snapshot().find((candidate) => candidate.bindings.has(sessionId));
        return host ? { hostId: host.hostId, pid: host.pid } : null;
      },
      runOptions,
    });
  } finally {
    await main.transport.close().catch(() => undefined);
    await sendOnly.transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connectedClients.clear();
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

/** Brings the session's resident host up through a real MCP `session_send`. */
async function warmHost(harness: Harness): Promise<void> {
  const call = await harness.call('session_send', { session: harness.sessionId, message: 'warm the host' });
  assert.equal(call.isError, false, `the warm-up send must not error (text=${call.text})`);
  await waitFor(() => harness.liveHost() !== null, 5_000, 'the resident host to come up');
}

// --------------------------- (a) storage + next-turn options ---------------------------

test('(a) session_reconfigure writes the row and the next session_send runs with the new values', { concurrency: false }, async () => {
  await withHarness({ label: 'next-turn' }, async (harness) => {
    const sessionId = harness.sessionId;
    const cfg = await harness.call('session_reconfigure', {
      session: sessionId,
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
    });
    assert.equal(cfg.isError, false, `session_reconfigure must not error (text=${cfg.text})`);
    assert.equal(cfg.payload?.ok, true);

    const row = sessionsDb.getSessionById(sessionId);
    const send = await harness.call('session_send', { session: sessionId, message: 'run with the new values' });
    assert.equal(send.isError, false, `session_send must not error (text=${send.text})`);
    const runOptions = harness.runOptions.at(-1) ?? {};

    say(`(a) reconfigure=${JSON.stringify(cfg.payload)}`);
    say(
      `(a) row=${JSON.stringify({ model: row?.model, effort: row?.effort, permission_mode: row?.permission_mode })}`,
    );
    say(
      `(a) runOptions=${JSON.stringify({ model: runOptions.model, effort: runOptions.effort, permissionMode: runOptions.permissionMode })}`,
    );

    assert.equal(row?.model, 'opus', 'the stored model must equal the new value verbatim');
    assert.equal(row?.effort, 'high', 'the stored effort must equal the new value verbatim');
    assert.equal(row?.permission_mode, 'plan', 'the stored permission mode must equal the new value verbatim');
    assert.equal(runOptions.model, 'opus', 'the next run must carry the new model');
    assert.equal(runOptions.effort, 'high', 'the next run must carry the new effort');
    assert.equal(runOptions.permissionMode, 'plan', 'the next run must carry the new permission mode');
  });
});

// --------------------------- (b) live reconfigure, no restart ---------------------------

test('(b) a live change moves the running process with the same host id and pid', { concurrency: false }, async () => {
  await withHarness({ label: 'live' }, async (harness) => {
    const sessionId = harness.sessionId;
    await warmHost(harness);

    const before = harness.liveHost();
    const spawnsBefore = harness.process.spawns;
    assert.ok(before, 'the warm-up must have produced a live host');

    const cfg = await harness.call('session_reconfigure', {
      session: sessionId,
      model: 'opus',
      permissionMode: 'acceptEdits',
    });
    const after = harness.liveHost();
    const effortOnly = await harness.call('session_reconfigure', { session: sessionId, effort: 'high' });

    say(`(b) reconfigure=${JSON.stringify(cfg.payload)}`);
    say(
      `(b) setModels=${JSON.stringify(harness.process.setModels)} setPermissionModes=${JSON.stringify(harness.process.setPermissionModes)}`,
    );
    say(
      `(b) host=${JSON.stringify(before)}->${JSON.stringify(after)} spawns=${spawnsBefore}->${harness.process.spawns}`,
    );
    say(`(b) effortOnly=${JSON.stringify(effortOnly.payload)}`);

    assert.equal(cfg.payload?.applied, 'live', 'a live-capable change must report applied live');
    // The "no restart" reading is checked FIRST: a mutant that fakes `live` by
    // reopening the process must red here, before any live-verb assertion.
    assert.equal(after?.hostId, before?.hostId, 'the host is the same host');
    assert.equal(after?.pid, before?.pid, 'the pid is the same pid — the process was not restarted');
    assert.equal(harness.process.spawns, spawnsBefore, 'no new process was spawned by the reconfigure');
    assert.deepEqual(harness.process.setModels, ['opus'], 'setModel must reach the running query with the new model');
    assert.deepEqual(
      harness.process.setPermissionModes,
      ['acceptEdits'],
      'setPermissionMode must reach the running query with the new mode',
    );

    // Effort is a launch argument, not a live verb: it must answer next-turn and
    // touch neither live spy (counts stay at one each from the live change above).
    assert.equal(effortOnly.payload?.applied, 'next-turn', 'an effort-only change is not applied live');
    assert.equal(harness.process.setModels.length, 1, 'the effort-only change must not call setModel');
    assert.equal(harness.process.setPermissionModes.length, 1, 'the effort-only change must not call setPermissionMode');
    assert.equal(harness.process.spawns, spawnsBefore, 'the effort-only change must not spawn a process');
  });
});

// --------------------------- (c) unsupported value + WebSocket contrast ---------------------------

test('(c) a matrix-external permission mode is refused, while the WebSocket path silently ignores it', { concurrency: false }, async () => {
  await withHarness({ label: 'refused' }, async (harness) => {
    const sessionId = harness.sessionId;
    const bad = await harness.call('session_reconfigure', { session: sessionId, permissionMode: 'yolo' });
    const afterMcpRow = sessionsDb.getSessionById(sessionId);
    const mcpWrites = harness.counts.permissionMode.length;

    const beforeWs = sessionsDb.getSessionById(sessionId)?.permission_mode ?? null;
    const wsResult = await harness.wsSend({ sessionId, content: 'ws yolo', options: { permissionMode: 'yolo' } });
    const afterWsRow = sessionsDb.getSessionById(sessionId);
    const errorFrames = harness.wsSocket.frames.filter((frame) => frame.type === 'error' || frame.kind === 'error');

    say(`(c) mcp isError=${bad.isError} payload=${JSON.stringify(bad.payload)}`);
    say(`(c) mcp row.permission_mode=${JSON.stringify(afterMcpRow?.permission_mode)} writes=${mcpWrites}`);
    say(
      `(c) ws result=${JSON.stringify(wsResult)} before=${JSON.stringify(beforeWs)} after=${JSON.stringify(afterWsRow?.permission_mode)} errorFrames=${errorFrames.length}`,
    );

    assert.equal(bad.isError, true, 'an unsupported permission mode must be refused');
    assert.equal(bad.payload?.code, 'UNSUPPORTED_PERMISSION_MODE', 'the refusal must name the code');
    assert.deepEqual(
      bad.payload?.details?.supported,
      harness.permissionModes,
      'the refusal must list the provider-supported modes verbatim',
    );
    assert.ok((bad.payload?.details?.supported as string[]).includes('plan'), 'the list must carry the plan mode');
    assert.ok((bad.payload?.details?.supported as string[]).includes('auto'), 'the list must carry the auto mode');
    assert.equal(afterMcpRow?.permission_mode, null, 'the refused mode must not be written to the row');
    assert.equal(mcpWrites, 0, 'the refusal must not reach setSessionPermissionMode');

    assert.equal(
      afterWsRow?.permission_mode,
      beforeWs,
      'the WebSocket path silently ignores the same value — the row is unchanged',
    );
    assert.equal(wsResult?.ok, true, 'the WebSocket path accepts the send (no error) while ignoring the mode');
    assert.equal(errorFrames.length, 0, 'the WebSocket path raises no error frame for the ignored mode');
  });
});

// --------------------------- (d) no live reconfiguration ---------------------------

test('(d) a provider without liveReconfigure reports next-turn and 不支持在线重配置', { concurrency: false }, async () => {
  const capabilities = {
    getProviderCapabilities: (provider: LLMProvider) => {
      const real = providerCapabilitiesService.getProviderCapabilities(provider);
      if (provider === 'claude') {
        return { ...real, residentFeatures: { ...real.residentFeatures, liveReconfigure: [] } };
      }
      return real;
    },
    getRuntimeProviderCapabilities: (provider: string) =>
      providerCapabilitiesService.getRuntimeProviderCapabilities(provider),
  };

  await withHarness({ label: 'no-live', capabilities }, async (harness) => {
    await warmHost(harness);
    const cfg = await harness.call('session_reconfigure', { session: harness.sessionId, model: 'opus' });

    say(`(d) payload=${JSON.stringify(cfg.payload)}`);
    say(
      `(d) reconfigureCalls=${harness.counts.reconfigurePatches.length} setModels=${harness.process.setModels.length} setPermissionModes=${harness.process.setPermissionModes.length}`,
    );

    assert.equal(cfg.isError, false, 'a provider without live reconfig is not an error');
    assert.equal(cfg.payload?.applied, 'next-turn', 'the change must be reported as next-turn');
    assert.equal(cfg.payload?.liveSupported, false, 'the provider must be reported as not live-capable');
    assert.match(String(cfg.payload?.message), /live reconfiguration/, 'the message must say live reconfiguration is unsupported');
    assert.match(String(cfg.payload?.message), /next/, 'the message must say the change lands next turn');
    assert.equal(harness.counts.reconfigurePatches.length, 0, 'the runtime reconfigure must not be called');
    assert.equal(harness.process.setModels.length, 0, 'setModel must not be called');
    assert.equal(harness.process.setPermissionModes.length, 0, 'setPermissionMode must not be called');
  });
});

// --------------------------- (e) scope denied + audit ---------------------------

test('(e) a token lacking the control scope is denied, audits one denied row, and writes nothing', { concurrency: false }, async () => {
  await withHarness({ label: 'denied' }, async (harness) => {
    const auditBefore = mcpAuditLogDb.count();
    const call = await harness.call('session_reconfigure', { session: harness.sessionId, model: 'opus' }, 'readonly');
    const newRows = mcpAuditLogDb.allRows().filter((row) => row.id > auditBefore);

    say(`(e) isError=${call.isError} text=${JSON.stringify(call.text)}`);
    say(`(e) newAuditRows=${JSON.stringify(newRows)}`);
    say(
      `(e) modelWrites=${harness.counts.model.length} permissionModeWrites=${harness.counts.permissionMode.length} reconfigureCalls=${harness.counts.reconfigurePatches.length}`,
    );

    assert.equal(call.isError, true, 'a token lacking cloudcli:session:control must be denied');
    assert.equal(newRows.length, 1, 'exactly one audit row must be written');
    assert.equal(newRows[0].tool, 'session_reconfigure', 'the audit row must name session_reconfigure');
    assert.equal(newRows[0].outcome, 'denied', 'the audit row must read denied');
    assert.equal(harness.counts.model.length, 0, 'the denied call must not write the model');
    assert.equal(harness.counts.permissionMode.length, 0, 'the denied call must not write a permission mode');
    assert.equal(harness.counts.reconfigurePatches.length, 0, 'the denied call must not reach the driver');
  });
});

// --------------------------- a live host actually exists for (b)/(d) ---------------------------
// (Removed: the WebSocket leg's own reading is the control-service receipt,
// asserted in (c).)

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
