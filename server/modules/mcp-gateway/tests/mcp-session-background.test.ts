/**
 * AC-273 criterion: MCP `session_background` lists a session's `background-task`
 * and `cron` leases from the LIVE HOST SNAPSHOT (a read-only token is enough),
 * and, given a `stopTaskId`, stops one through the shared `ChatControlService`
 * under `cloudcli:session:control` — refusing a read-only token BEFORE the
 * control service is reached, reporting an id the snapshot does not hold as
 * NOT FOUND without ever claiming it stopped, and showing it gone from a later
 * listing once the driver really removed the lease.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the resident host is the REAL
 * `createSessionHostManager` over a REAL `ClaudeResidentHostDriver` whose
 * `createProcess` seam is a scripted query (the shape
 * `claude-resident-permissions.test.ts` established) exposing a `stopTask`
 * spy that removes the lease through the manager's own `removeLease` — the
 * same transition the production `task_notification(stopped)` frame drives; the
 * control service is the real `createChatControlService` over a real
 * `createProviderRuntimeService`, wrapped in a counting proxy so a stop's
 * arrival is observable.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248/249/271/272's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) a read-only token lists both lease kinds with id/kind/recurring — the
 *       list comes from the host snapshot, `isError` false, `host` non-null;
 *   (b) a read-only token's stop is refused with `cloudcli:session:control` still
 *       at zero control calls and the lease untouched, while the control token's
 *       stop answers `stopped:true`, moves the count to one, and the scripted
 *       query's `stopTask` receives exactly `bg-1`;
 *   (c) the control token's stop of an unknown id is `TASK_NOT_FOUND`, carries no
 *       `stopped:true`, and never reaches the control service;
 *   (d) after a real stop the next listing drops `bg-1` and keeps the crons;
 *   (e) a cold session lists empty, `host:null`, and the message names "no host",
 *       while the same call for a warm session answers a non-null host.
 *
 * The false forms (AC8) mutate the implementation after this criterion is green;
 * they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
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

import type { AnyRecord, HostLease, LLMProvider, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

// --------------------------------------------------------------------------
// A scratch HOME is set before any aliased module is imported, so the resident
// driver's Remote Control settings read lands on an empty directory (the same
// posture AC-168/AC-272's criteria take) and the model/catalog reads never
// touch the real user's config.
// --------------------------------------------------------------------------
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-session-background-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-session-background-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const {
  ClaudeResidentHostDriver,
  createProviderRuntimeService,
  providerRegistry,
  sessionsService,
} = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { createChatControlService } = await import('@/modules/websocket/index.js');
const { MCP_GATEWAY_PATH, createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');

type ChatControlService = ReturnType<typeof createChatControlService>;
type RuntimeService = ReturnType<typeof createProviderRuntimeService>;
type SessionHostManager = ReturnType<typeof createSessionHostManager>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const READ_SCOPE = 'cloudcli:read';
const SESSION_CONTROL_SCOPE = 'cloudcli:session:control';
/** The pid the scripted process reports — a value, since no real child is spawned. */
const PROCESS_PID = 4242;
/** The one background-task id the criterion seeds and stops. */
const BG_ID = 'bg-1';
/** The two cron ids the criterion seeds; one repeating, one a one-shot wake. */
const CRON_IDS = ['cron-1', 'wake-1'] as const;

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`session-background ${line}`);
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

// --------------------------- the fake clock ---------------------------

type FakeClock = {
  now(): number;
  schedule(at: number, run: () => void): () => void;
};

function createFakeClock(start = 1_700_000_000_000): FakeClock {
  const current = start;
  const entries: Array<{ run: () => void; spent: boolean }> = [];
  return {
    now: () => current,
    schedule(_at, run) {
      const entry = { run, spent: false };
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
  /** Every task id the live query's `stopTask` verb was handed, in order. */
  readonly stopTaskIds: string[];
  readonly spawns: number;
};

/**
 * A resident process the criterion owns: a query exposing `stopTask` (unless the
 * arm deliberately omits the verb), plus the launch bag the driver built. The
 * query never ends on its own, so the driver's read loop stays parked (an
 * iterable that finished would make the driver call `reportExit` and the manager
 * close the host as `exited`), keeping the session a LIVE host for the whole leg.
 *
 * The factory is substituted at the driver's own `createProcess` seam — the
 * point of that seam — so the driver, its host bookkeeping and its resident
 * `stopTask` branch are the production ones. `onStop` is where the leg wires the
 * real lease transition (`manager.removeLease`), the same one production reaches
 * from the `task_notification(stopped)` frame.
 */
function createFakeProcess(options: { withStopVerb: boolean; onStop?: (taskId: string) => void }): FakeProcess {
  const stopTaskIds: string[] = [];
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

  const query: AnyRecord = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };
  if (options.withStopVerb) {
    query.stopTask = async (taskId: string) => {
      stopTaskIds.push(taskId);
      options.onStop?.(taskId);
    };
  }

  return {
    factory: () => {
      spawns += 1;
      return { query, pid: PROCESS_PID, writeRaw: () => undefined };
    },
    get stopTaskIds() {
      return stopTaskIds;
    },
    get spawns() {
      return spawns;
    },
  };
}

// --------------------------- harness ---------------------------

type Harness = {
  sessionId: string;
  coldSessionId: string;
  call: (name: string, args?: AnyRecord, which?: 'read' | 'control') => Promise<ToolCall>;
  manager: SessionHostManager;
  process: FakeProcess;
  /** Every `stopTask` call the counting control proxy has seen, in order. */
  stopTaskCalls: Array<{ caller: AnyRecord; input: AnyRecord }>;
  /** The live host's leases for the session, straight from the snapshot. */
  leases: HostLease[];
  /** The lease ids the live host snapshot holds right now (id, sorted). */
  leaseIds: () => string[];
  liveHost: () => { hostId: string; pid: number | null } | null;
};

type HarnessOptions = {
  label: string;
  /** When false, the scripted query exposes no `stopTask` verb (the unsupported arm). */
  withStopVerb?: boolean;
};

/**
 * Boots one arm: a fresh temp database + project directory, one resident claude
 * session (warm, holding the seeded leases) plus one cold session, the real
 * resident driver over a scripted process, the real runtime and control
 * services, and the production `/mcp` mount carrying the stage-6 resident tools.
 */
async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));
  const fixtureProject = path.join(tempDirectory, options.label);
  mkdirSync(fixtureProject, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'session-background.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const created = sessionsService.createAppSession('claude', fixtureProject, 'seed for background');
  const sessionId = created.sessionId;
  sessionsDb.setSessionLifecycleMode(sessionId, 'resident');
  const cold = sessionsService.createAppSession('claude', fixtureProject, 'cold seed');
  const coldSessionId = cold.sessionId;

  const clock = createFakeClock();
  const manager = createSessionHostManager({ now: () => clock.now(), scheduler: clock });
  const fakeProcess = createFakeProcess({
    withStopVerb: options.withStopVerb ?? true,
    onStop: () => {
      // The production transition the driver takes on `task_notification(stopped)`.
      manager.removeLease(sessionId, 'background-task');
    },
  });
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

  const realControl = createChatControlService({ runtime });
  const stopTaskCalls: Array<{ caller: AnyRecord; input: AnyRecord }> = [];
  const controlSpy = {
    ...realControl,
    stopTask: async (caller: unknown, input: unknown) => {
      stopTaskCalls.push({ caller: caller as AnyRecord, input: input as AnyRecord });
      return realControl.stopTask(caller as never, input as never);
    },
  };

  const tokens = createAccessTokensService({ now: () => new Date() });
  const readToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac273-read',
    scopes: [READ_SCOPE],
    expiresInDays: 30,
  });
  const controlToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac273-control',
    scopes: [READ_SCOPE, SESSION_CONTROL_SCOPE],
    expiresInDays: 30,
  });
  if (!readToken.ok || !controlToken.ok) {
    throw new Error('the harness must mint both tokens');
  }

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    residentTools: {
      control: controlSpy as never,
      background: {
        sessions: { getSessionById: (id: string) => sessionsDb.getSessionById(id) },
        hosts: manager,
        control: controlSpy as never,
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
    const client = new Client({ name: 'ac273-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const read = await connect(readToken.token.token);
  const control = await connect(controlToken.token.token);

  const callWith = async (client: Client, name: string, args: AnyRecord): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  const liveHost = () => {
    const host = manager.liveHostForSession(sessionId);
    return host ? { hostId: host.hostId, pid: host.pid } : null;
  };

  // Warm the resident host through the production `run` entry (the permissions
  // test's `beginRound`) — not through MCP `session_send`, so the criterion needs
  // only the two tokens the SPEC names.
  const writer: ProviderRuntimeWriter = {
    send: () => undefined,
    setSessionId: () => undefined,
    userId: USER_ONE,
  };
  void driver.run(sessionId, { command: 'warm the host', options: {} }, writer, CONTEXT);
  await waitFor(() => liveHost() !== null, 5_000, 'the resident host to come up');

  const now = clock.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.equal(manager.addLease(sessionId, { kind: 'background-task', id: BG_ID }), true, 'the background-task lease must attach');
  assert.equal(
    manager.addLease(sessionId, { kind: 'cron', id: CRON_IDS[0], recurring: true, expiresAt: now + week }),
    true,
    'the repeating cron lease must attach',
  );
  assert.equal(
    manager.addLease(sessionId, { kind: 'cron', id: CRON_IDS[1], recurring: false, expiresAt: now + week }),
    true,
    'the one-shot cron lease must attach',
  );

  const leaseIds = () => {
    const host = manager.liveHostForSession(sessionId);
    const leases = host?.bindings.get(sessionId)?.leases ?? [];
    const ids: string[] = [];
    for (const lease of leases) {
      if (lease.kind === 'background-task' || lease.kind === 'cron') {
        ids.push(lease.id);
      }
    }
    return ids.sort();
  };

  try {
    await run({
      sessionId,
      coldSessionId,
      call: (name, args = {}, which = 'read') => callWith(which === 'control' ? control.client : read.client, name, args),
      manager,
      process: fakeProcess,
      stopTaskCalls,
      get leases() {
        return manager.liveHostForSession(sessionId)?.bindings.get(sessionId)?.leases ?? [];
      },
      leaseIds,
      liveHost,
    });
  } finally {
    await read.transport.close().catch(() => undefined);
    await control.transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

/** The runtime's own turn inputs, stubbed to the facts the driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

// --------------------------- (a) the read-only listing ---------------------------

test('(a) a read-only token lists both lease kinds from the host snapshot', { concurrency: false }, async () => {
  await withHarness({ label: 'list' }, async (harness) => {
    const call = await harness.call('session_background', { session: harness.sessionId });

    say(`(a) isError=${call.isError} payload=${JSON.stringify(call.payload)}`);
    say(`(a) snapshotIds=${JSON.stringify(harness.leaseIds())}`);

    assert.equal(call.isError, false, `session_background must not error (text=${call.text})`);
    assert.equal(call.payload?.ok, true, 'the listing must report ok');
    const host = call.payload?.host as AnyRecord | null;
    assert.ok(host, 'a warm session must answer a non-null host');
    assert.ok(
      typeof host.state === 'string' && host.state.length > 0,
      'the host reading must carry a state',
    );
    assert.equal(host.pid, PROCESS_PID, 'the host reading must carry the live pid');

    const tasks = call.payload?.tasks as AnyRecord[];
    assert.ok(Array.isArray(tasks), 'the payload must carry a task array');
    const byId = Object.fromEntries(tasks.map((task) => [String(task.id), task]));
    // Positive control: both kinds present, so "empty" or "cron dropped" reds.
    assert.deepEqual(
      tasks.map((task) => task.id).sort(),
      [BG_ID, ...CRON_IDS].sort(),
      'the listing must hold exactly the seeded leases',
    );
    assert.deepEqual(byId[BG_ID], { id: BG_ID, kind: 'background-task', recurring: false }, 'bg-1 verbatim');
    assert.deepEqual(
      byId[CRON_IDS[0]],
      { id: CRON_IDS[0], kind: 'cron', recurring: true },
      'cron-1 verbatim',
    );
    assert.deepEqual(
      byId[CRON_IDS[1]],
      { id: CRON_IDS[1], kind: 'cron', recurring: false },
      'wake-1 verbatim',
    );
    assert.ok(
      tasks.some((task) => task.kind === 'background-task') && tasks.some((task) => task.kind === 'cron'),
      'the listing must carry BOTH kinds',
    );
  });
});

// --------------------------- (b) scope: read-only refused, control stops ---------------------------

test('(b) a read-only stop is refused before the control service, the control token stops', { concurrency: false }, async () => {
  await withHarness({ label: 'scope' }, async (harness) => {
    const denied = await harness.call('session_background', { session: harness.sessionId, stopTaskId: BG_ID }, 'read');
    const callsAfterDenied = harness.stopTaskCalls.length;
    const afterDenied = await harness.call('session_background', { session: harness.sessionId }, 'read');

    say(`(b) denied isError=${denied.isError} payload=${JSON.stringify(denied.payload)}`);
    say(`(b) controlCalls after read-only stop=${callsAfterDenied}`);
    say(`(b) bg still listed=${JSON.stringify((afterDenied.payload?.tasks as AnyRecord[]).map((t) => t.id))}`);

    assert.equal(denied.isError, true, 'a read-only token must be refused');
    assert.equal(
      denied.payload?.code,
      'INSUFFICIENT_SCOPE',
      'the refusal must name the missing control scope with the gateway-wide scope code',
    );
    // AC-286: the refusal also carries the MISSING scope as a machine field, so a
    // caller can re-authorize with exactly it — the same `details.requiredScopes`
    // the audited wrapper's generic check renders.
    assert.deepEqual(
      (denied.payload?.details as AnyRecord | undefined)?.requiredScopes,
      [SESSION_CONTROL_SCOPE],
      'the stop refusal must carry the missing control scope in details.requiredScopes',
    );
    assert.equal(denied.payload?.retryable, false, 'a missing scope is not retryable');
    assert.equal(callsAfterDenied, 0, 'the refused stop must never reach the control service');
    assert.ok(
      (afterDenied.payload?.tasks as AnyRecord[]).some((task) => task.id === BG_ID),
      'the refused stop must leave the lease in place',
    );

    const stopped = await harness.call('session_background', { session: harness.sessionId, stopTaskId: BG_ID }, 'control');
    const callsAfterStop = harness.stopTaskCalls.length;

    say(`(b) stopped isError=${stopped.isError} payload=${JSON.stringify(stopped.payload)}`);
    say(
      `(b) controlCalls=${callsAfterDenied}->${callsAfterStop} driverStopTaskIds=${JSON.stringify(harness.process.stopTaskIds)}`,
    );

    assert.equal(stopped.isError, false, `the control token's stop must succeed (text=${stopped.text})`);
    assert.equal(stopped.payload?.ok, true, 'the stop must report ok');
    assert.equal(stopped.payload?.stopped, true, 'the stop must report stopped');
    assert.equal(stopped.payload?.taskId, BG_ID, 'the stop must name the task it stopped');
    assert.equal(callsAfterStop, 1, 'exactly one control service stop call must have happened');
    assert.deepEqual(harness.process.stopTaskIds, [BG_ID], "the live query's stopTask must receive exactly 'bg-1'");
  });
});

// --------------------------- (c) unknown id, no false stop ---------------------------

test('(c) an unknown id is TASK_NOT_FOUND, never reaches the control service, and claims no stop', { concurrency: false }, async () => {
  await withHarness({ label: 'unknown' }, async (harness) => {
    const before = harness.leaseIds();
    const callsBefore = harness.stopTaskCalls.length;
    const call = await harness.call(
      'session_background',
      { session: harness.sessionId, stopTaskId: 'no-such-id' },
      'control',
    );
    const callsAfter = harness.stopTaskCalls.length;
    const after = harness.leaseIds();

    say(`(c) isError=${call.isError} payload=${JSON.stringify(call.payload)}`);
    say(`(c) controlCalls=${callsBefore}->${callsAfter} ids=${JSON.stringify(before)}->${JSON.stringify(after)}`);

    assert.equal(call.isError, true, 'an unknown id must be refused');
    assert.equal(call.payload?.code, 'TASK_NOT_FOUND', 'the refusal must say the id was not found');
    assert.notEqual(call.payload?.stopped, true, 'an unknown id must NEVER be reported stopped');
    assert.equal(callsAfter, callsBefore, 'the unknown id must not reach the control service');
    assert.deepEqual(after, before, 'the lease set must be unchanged');
    assert.deepEqual(
      before,
      [BG_ID, ...CRON_IDS].sort(),
      'nothing may have vanished alongside the refusal',
    );
  });
});

// --------------------------- (d) the lease really disappears ---------------------------

test('(d) after a real stop the lease is gone and the crons remain', { concurrency: false }, async () => {
  await withHarness({ label: 'disappear' }, async (harness) => {
    const before = await harness.call('session_background', { session: harness.sessionId }, 'control');
    const stop = await harness.call('session_background', { session: harness.sessionId, stopTaskId: BG_ID }, 'control');
    const after = await harness.call('session_background', { session: harness.sessionId }, 'control');

    const beforeIds = (before.payload?.tasks as AnyRecord[]).map((task) => task.id).sort();
    const afterIds = (after.payload?.tasks as AnyRecord[]).map((task) => task.id).sort();

    say(`(d) before=${JSON.stringify(beforeIds)} stop=${JSON.stringify(stop.payload)}`);
    say(`(d) after=${JSON.stringify(afterIds)} snapshotIds=${JSON.stringify(harness.leaseIds())}`);

    assert.equal(stop.payload?.stopped, true, 'the stop must have really happened');
    assert.deepEqual(beforeIds, [BG_ID, ...CRON_IDS].sort(), 'bg-1 and both crons must be listed before the stop');
    assert.ok(
      !afterIds.includes(BG_ID),
      'the stopped lease must be gone from the next listing',
    );
    assert.ok(afterIds.includes(CRON_IDS[0]) && afterIds.includes(CRON_IDS[1]), 'the crons must remain listed');
    assert.deepEqual(afterIds, [...CRON_IDS].sort(), 'exactly the crons must remain');
    assert.deepEqual(
      (stop.payload?.remaining as AnyRecord[]).map((task) => task.id).sort(),
      [...CRON_IDS].sort(),
      'the stop response must carry the re-read remaining set',
    );
  });
});

// --------------------------- (e) the cold session ---------------------------

test('(e) a cold session lists empty and says "no host", while the warm one does not', { concurrency: false }, async () => {
  await withHarness({ label: 'cold' }, async (harness) => {
    const cold = await harness.call('session_background', { session: harness.coldSessionId }, 'read');
    const warm = await harness.call('session_background', { session: harness.sessionId }, 'read');

    say(`(e) cold isError=${cold.isError} payload=${JSON.stringify(cold.payload)}`);
    say(`(e) warm host=${JSON.stringify(warm.payload?.host)}`);

    assert.equal(cold.isError, false, `the cold listing must not error (text=${cold.text})`);
    assert.equal(cold.payload?.ok, true, 'the cold listing must report ok');
    assert.equal(cold.payload?.host, null, 'a cold session must answer a null host');
    assert.deepEqual(cold.payload?.tasks, [], 'a cold session must list nothing');
    assert.match(String(cold.payload?.message), /no host/i, 'the message must say there is no host');

    // Positive control: the same call for a warm session answers a non-null host,
    // so "always say no host" reds here.
    assert.ok(warm.payload?.host, 'the warm session must answer a non-null host');
  });
});

// --------------------------- optional: the request landed but nothing stopped ---------------------------

test('(f) a driver that cannot place the request answers STOP_UNSUPPORTED, never stopped', { concurrency: false }, async () => {
  await withHarness({ label: 'unsupported', withStopVerb: false }, async (harness) => {
    const callsBefore = harness.stopTaskCalls.length;
    const call = await harness.call('session_background', { session: harness.sessionId, stopTaskId: BG_ID }, 'control');
    const callsAfter = harness.stopTaskCalls.length;

    say(`(f) isError=${call.isError} payload=${JSON.stringify(call.payload)} controlCalls=${callsBefore}->${callsAfter}`);

    assert.equal(call.isError, true, 'a driver without the verb cannot stop — the call is an error');
    assert.equal(call.payload?.code, 'STOP_UNSUPPORTED', 'the refusal must name the unsupported outcome');
    assert.notEqual(call.payload?.stopped, true, 'a request that was not placed must never be reported stopped');
    assert.equal(callsAfter, callsBefore + 1, 'the control service was reached — the refusal is about the driver, not the scope');
    assert.deepEqual(harness.leaseIds(), [BG_ID, ...CRON_IDS].sort(), 'nothing may have been removed');
  });
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
