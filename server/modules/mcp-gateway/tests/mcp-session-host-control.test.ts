/**
 * AC-251 criterion: `session_start` / `session_close` reuse the session-hosts
 * module's `startResidentHost` / `closeResidentHost` — the start is idempotent
 * (a second start answers with the SAME pid and no second process), a close is
 * refused while the session holds a `cron` / `background-task` lease and no
 * `force: true` was given (the refusal names each kind and how many, and the
 * host is still running), the three existing refusal codes surface verbatim, and
 * both tools require `cloudcli:session:control`.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the sessions are debug-agent
 * fixtures (`armDebugAgentScenario`) whose rows really land in that database; the
 * host manager is a real `createSessionHostManager()`; and the start/close
 * decision is the REAL `startResidentHost` / `closeResidentHost` reached through
 * `createSessionHostControl` (the barrel default) — the criterion only WRAPS that
 * control in counting spies, it never re-implements it.
 *
 * The debug agent's gate is read ONCE per process and cached, and
 * `provider.registry.ts` builds its debug provider at module load. This file
 * therefore has NO static application imports: it opens `DEBUG_AGENT` (and
 * redirects `HOME` into a scratch directory) BEFORE any aliased module is pulled
 * in, and every application module below comes in dynamically.
 *
 * THE DRIVER. The debug agent's own host driver declares `multiplexedHost` but
 * implements NO on-demand `startResidentSession` verb — the debug substitute has
 * no process to launch, so `bindSession` is its only entry. This criterion needs
 * the launch path (so `launches` / `spawns` are non-trivial readings), so it
 * wraps a FRESH real driver (`createDebugAgentHostDriver`, one per arm, so
 * `processStarts` starts at zero) in an object whose prototype is that driver:
 * every other member — `startHost` (which counts the one process), `bind`,
 * `closeHost`, `multiplexedHost`, the live `processStarts` getter — is the debug
 * agent's own, and the one added member opens the host through the real manager
 * with a literal pid. That is the same "stand-in for the process" the AC-236 and
 * on-demand-route criteria mount; what is real and load-bearing here is the
 * manager record, the service decision, and the pid.
 *
 * The transport is handed a `node:http`-based `fetch`: `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248/249/250's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) `session_start` reaches the service (start-spy count 1), returns the
 *       live host's pid, and a second start answers with the SAME pid and hostId
 *       while the driver launched exactly once (launch count 1, processStarts 1);
 *   (b) `session_close` reaches the service (close-spy count 1), answers
 *       `closeReason: 'user'` and the started hostId, and leaves no live host;
 *   (c) a resident session holding `cron` + `background-task` leases is refused
 *       without `force` (`SESSION_HAS_ACTIVE_LEASES`, the message naming each
 *       kind and count), the close spy stays 0, and the host's pid is unchanged;
 *       `force: true` closes it (close spy 1); a session holding only
 *       `resident-policy` closes without `force` (the not-always-refuse control);
 *   (d) per-run ⇒ `LIFECYCLE_MODE_NOT_RESIDENT`, no host driver ⇒
 *       `LIFECYCLE_MODE_HOST_UNAVAILABLE`, unknown ⇒ `SESSION_NOT_FOUND`, each
 *       code/message the service's own;
 *   (e) a token lacking `cloudcli:session:control` is denied on both tools, one
 *       `denied` audit row each, both spies 0; the `cloudcli:session:control`
 *       token is allowed through.
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

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-session-host-control-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
const FIXTURE_HOME = path.join(SCRATCH, 'fixture');
process.env.HOME = SCRATCH_HOME;
process.env[GATE_VAR] = 'on';
process.env[GATE_HOME_VAR] = FIXTURE_HOME;
process.env.JWT_SECRET = 'mcp-session-host-control-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(FIXTURE_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, mcpAuditLogDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { providerRegistry, sessionsService } = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { DEBUG_AGENT_PROVIDER_ID, armDebugAgentScenario, createDebugAgentHostDriver } = await import(
  '@/modules/debug-agent/index.js'
);
const {
  MCP_GATEWAY_PATH,
  MCP_STAGE4_WRITE_TOOLS,
  createMcpAuthMiddleware,
  createSessionHostControl,
  mountMcpGateway,
  SESSION_HAS_ACTIVE_LEASES_CODE,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;
type SessionHostManager = ReturnType<typeof createSessionHostManager>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const DEBUG_PROVIDER = DEBUG_AGENT_PROVIDER_ID;
const READ_SCOPE = 'cloudcli:read';
const SEND_SCOPE = 'cloudcli:session:send';
const CONTROL_SCOPE = 'cloudcli:session:control';

/** The pid the launch stand-in binds onto the resident host. */
const FIXTURE_PID = 4242;

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`session-host-control ${line}`);
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

// --------------------------- scenario building ---------------------------

/**
 * A resident scenario. The walk is never driven (this criterion starts and
 * closes hosts, it never sends a turn), so the steps exist only to make the
 * document valid; arming writes the seed rows and indexes the session.
 */
function residentScenario(label: string) {
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: `ac251 ${label}`, userText: `seed for ${label}`, lifecycleMode: 'resident' },
    steps: [{ at: 5, op: 'row', role: 'assistant', text: `${label} done` }],
    expect: { rows: { delta: 1 }, content: { mustContain: [`${label} done`] } },
  };
}

// --------------------------- the launch stand-in (real debug driver + one verb) ---------------------------

type LaunchDriver = {
  startResidentSession(sessionId: string): Promise<{ hostId: string; pid: number | null }>;
  processStarts: number;
};

/**
 * The debug agent's real driver with the ONE member it lacks: the on-demand
 * `startResidentSession` verb.
 *
 * `Object.create(real)` makes every other member real — `startHost` is the debug
 * driver's own (so `processStarts` counts the process it actually brings up),
 * `bind` / `closeHost` / `multiplexedHost` are the debug driver's own, and the
 * `processStarts` getter reads live through the prototype rather than a spread
 * that would have frozen it. The added verb opens a host through the real
 * manager with {@link FIXTURE_PID}, which is why the pid a leg reads is a value
 * the manager holds rather than a number the criterion invented.
 */
function withLaunchVerb(real: object, manager: SessionHostManager): LaunchDriver {
  const driver = Object.create(real) as Record<string, unknown>;
  driver.startResidentSession = async (sessionId: string) => {
    const host = await manager.openHost({
      provider: DEBUG_PROVIDER as never,
      mode: 'resident',
      appSessionId: sessionId,
      driver: driver as never,
      pid: FIXTURE_PID,
    });
    return { hostId: host.hostId, pid: host.pid };
  };
  return driver as unknown as LaunchDriver;
}

// --------------------------- harness ---------------------------

type Harness = {
  /** The first resident session's id. */
  residentA: string;
  /** A second resident session, for the only-`resident-policy` positive control. */
  residentB: string;
  /** A stored per-run session. */
  perRun: string;
  /** A stored resident session under a provider that mounts no host driver. */
  noDriver: string;
  /** An id with no row at all. */
  unknown: string;
  manager: SessionHostManager;
  spies: { start: number; close: number };
  /** Every session id the resident-launch seam was asked to launch. */
  launches: string[];
  /** The debug driver's real process count. */
  spawns: () => number;
  call: (name: string, args?: AnyRecord, which?: 'control' | 'sendOnly') => Promise<ToolCall>;
};

/** The live host serving one session, as the manager's own read port reports it. */
function liveHost(manager: SessionHostManager, sessionId: string) {
  return manager.snapshot().find((host) => host.state !== 'closed' && host.bindings.has(sessionId)) ?? null;
}

/** The leases the manager holds for one session, read from `snapshot()`. */
function bindingLeases(manager: SessionHostManager, sessionId: string) {
  return liveHost(manager, sessionId)?.bindings.get(sessionId)?.leases ?? [];
}

/** Seeds one stored session row, the way a real create would. */
function seedSession(sessionId: string, provider: string, directory: string, mode: string): void {
  const now = new Date().toISOString();
  sessionsDb.createSession(sessionId, provider as never, directory, `ac251 ${sessionId}`, now, now, null);
  sessionsDb.setSessionLifecycleMode(sessionId, mode);
}

/**
 * Boots one arm: a fresh temp database + fixture home, two armed resident
 * scenarios, a fresh debug driver (wrapped with the launch verb), a real host
 * manager, the production `/mcp` mount carrying the write tools over a
 * spy-wrapped `createSessionHostControl`, and a stored per-run / no-driver /
 * unknown session for the refusal leg.
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'session-host-control.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const debugProvider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
  assert.ok(debugProvider.sessionSynchronizer, 'the debug provider must carry a session synchronizer');

  const arm = (label: string) =>
    armDebugAgentScenario({
      projectPath: path.join(SCRATCH, `project-${label}`),
      scenario: residentScenario(label),
      synchronizeTranscript: (filePath) => debugProvider.sessionSynchronizer.synchronizeFile(filePath),
      setSessionLifecycleMode: ({ appSessionId, mode }) => sessionsDb.setSessionLifecycleMode(appSessionId, mode),
    });

  const armedA = await arm('a');
  const armedB = await arm('b');

  // A fresh debug driver per arm, so `processStarts` (and therefore `spawns()`)
  // starts at zero — the provider registry's driver is a process-wide singleton
  // and would carry a previous arm's count.
  const realDriver = createDebugAgentHostDriver({ openRun: () => null });
  assert.ok(realDriver, 'the debug agent gate must be open so a driver can be built');

  const manager = createSessionHostManager({ scheduler: { schedule: () => () => {} } });
  const driver = withLaunchVerb(realDriver, manager);

  const launches: string[] = [];
  const serviceDeps = {
    sessionHostManager: manager,
    readSession: (sessionId: string) => sessionsService.readSessionLifecycle(sessionId),
    resolveHostDriver: (provider: string) => (provider === DEBUG_PROVIDER ? (driver as never) : null),
    startResidentSession: (_provider: string, sessionId: string) => {
      launches.push(sessionId);
      return driver.startResidentSession(sessionId);
    },
  };

  // The production default over the session-hosts barrel, wrapped in counting
  // spies: `base.hosts.start` / `close` ARE `startResidentHost` / `closeResidentHost`
  // over `serviceDeps`, so a count is a statement that the gateway reached the
  // service rather than an inference from its effects.
  const base = createSessionHostControl(serviceDeps as never);
  const spies = { start: 0, close: 0 };
  const sessionHostControl = {
    hosts: {
      start: (sessionId: string) => {
        spies.start += 1;
        return base.hosts.start(sessionId);
      },
      close: (sessionId: string) => {
        spies.close += 1;
        return base.hosts.close(sessionId);
      },
      liveHost: (sessionId: string) => base.hosts.liveHost(sessionId),
    },
  };

  const perRun = 'ac251-per-run';
  const noDriver = 'ac251-no-driver';
  const unknown = 'ac251-unknown';
  seedSession(perRun, 'claude', path.join(SCRATCH, 'per-run'), 'per-run');
  seedSession(noDriver, 'codex', path.join(SCRATCH, 'no-driver'), 'resident');

  const tokens = createAccessTokensService({ now: () => new Date() });
  const mint = (name: string, scopes: string[]): string => {
    const issued = tokens.issueToken({ userId: USER_ONE, name, scopes, expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error(`the harness must mint the ${name} token`);
    }
    return issued.token.token;
  };
  const controlToken = mint('ac251-control', [READ_SCOPE, CONTROL_SCOPE]);
  const sendOnlyToken = mint('ac251-send', [READ_SCOPE, SEND_SCOPE]);

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    writeTools: {
      // The other three stage-4 tools are registered but never called here; the
      // stubs satisfy the deps bag so the REAL handlers for session_start/close
      // are installed (sessionHostControl is present).
      control: {
        send: async () => ({ ok: true, runId: 'unused', queued: false, queuedMessageUuid: null }),
        abort: async () => ({ ok: true, aborted: false }),
      },
      runs: { getRun: () => undefined },
      runGet: {
        deps: {
          runs: { getRun: () => undefined, getRunById: () => undefined },
          activity: { snapshot: () => null },
          sessions: { fetchHistory: async () => ({ messages: [] }) },
          now: () => Date.now(),
          sleep: async () => undefined,
          bootId: () => 'ac251-boot',
        },
        build: async () => ({ outcome: 'timeout' }),
      },
      sessionHostControl,
    } as never,
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
    const client = new Client({ name: 'ac251-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const control = await connect(controlToken);
  const sendOnly = await connect(sendOnlyToken);
  const clients = { control: control.client, sendOnly: sendOnly.client };

  const callWith = async (client: Client, name: string, args: AnyRecord): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  try {
    await run({
      residentA: armedA.sessionId,
      residentB: armedB.sessionId,
      perRun,
      noDriver,
      unknown,
      manager,
      spies,
      launches,
      spawns: () => realDriver.processStarts,
      call: (name, args = {}, which = 'control') => callWith(clients[which], name, args),
    });
  } finally {
    await control.transport.close().catch(() => undefined);
    await sendOnly.transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.shutdown({ timeoutMs: 0 });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// --------------------------- (a) start goes through the service; a second start is idempotent ---------------------------

test('(a) session_start reaches the service and a second start answers the same pid without launching', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const first = await harness.call('session_start', { session: harness.residentA });
    const hostAfterFirst = liveHost(harness.manager, harness.residentA);
    const firstPid = first.payload?.pid ?? null;

    say(
      `(a) first isError=${first.isError} payload=${JSON.stringify(first.payload)} ` +
        `snapshotHost=${JSON.stringify(hostAfterFirst ? { hostId: hostAfterFirst.hostId, pid: hostAfterFirst.pid, state: hostAfterFirst.state } : null)} ` +
        `startSpy=${harness.spies.start} launches=${harness.launches.length} spawns=${harness.spawns()}`,
    );

    assert.equal(first.isError, false, `session_start must not error (text=${first.text})`);
    assert.equal(first.payload?.sessionId, harness.residentA, 'the payload names the started session');
    assert.equal(first.payload?.mode, 'resident');
    assert.equal(first.payload?.pid, FIXTURE_PID, 'the payload carries the live host pid');
    assert.ok(hostAfterFirst, 'a live host is serving the session');
    assert.equal(first.payload?.pid, hostAfterFirst.pid, 'the payload pid equals the manager snapshot pid');
    assert.equal(first.payload?.hostId, hostAfterFirst.hostId, 'and the hostId names the manager host');
    assert.equal(harness.spies.start, 1, 'the start service was reached exactly once');
    assert.equal(harness.launches.length, 1, 'the launch seam was asked exactly once');
    assert.equal(harness.spawns(), 1, 'and one process came up');

    const second = await harness.call('session_start', { session: harness.residentA });
    say(
      `(a) second isError=${second.isError} payload=${JSON.stringify(second.payload)} ` +
        `startSpy=${harness.spies.start} launches=${harness.launches.length} spawns=${harness.spawns()}`,
    );

    assert.equal(second.isError, false, 'a repeated start is a success');
    assert.equal(second.payload?.pid, firstPid, 'the repeated start answers the SAME pid verbatim');
    assert.equal(second.payload?.hostId, first.payload?.hostId, 'and the same hostId');
    assert.equal(harness.spies.start, 2, 'the second start still reached the service (proving idempotence is the service\'s)');
    assert.equal(harness.launches.length, 1, 'the launch seam was NOT asked a second time');
    assert.equal(harness.spawns(), 1, 'and no second process came up');
  });
});

// --------------------------- (b) close goes through the service with reason user ---------------------------

test('(b) session_close reaches the service, records reason user, and leaves no live host', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const started = await harness.call('session_start', { session: harness.residentA });
    assert.equal(started.isError, false, `the premise start must not error (text=${started.text})`);

    const closed = await harness.call('session_close', { session: harness.residentA });
    const hostAfter = liveHost(harness.manager, harness.residentA);

    say(
      `(b) closed isError=${closed.isError} payload=${JSON.stringify(closed.payload)} ` +
        `closeSpy=${harness.spies.close} liveHostAfter=${hostAfter ? hostAfter.hostId : null}`,
    );

    assert.equal(closed.isError, false, 'session_close must not error');
    assert.equal(closed.payload?.closeReason, 'user', 'the close records the user as the reason');
    assert.equal(closed.payload?.hostId, started.payload?.hostId, 'and names the host the start returned');
    assert.equal(closed.payload?.sessionId, harness.residentA);
    assert.equal(harness.spies.close, 1, 'the close service was reached exactly once');
    const leases = (closed.payload?.leases ?? []) as Array<{ kind?: string }>;
    assert.ok(
      leases.some((lease) => lease.kind === 'resident-policy'),
      `the close reports the resident-policy lease (got ${JSON.stringify(leases)})`,
    );
    assert.equal(hostAfter, null, 'no live host serves the session afterwards');
  });
});

// --------------------------- (c) the lease force gate ---------------------------

test('(c) a resident host holding cron+background-task leases is refused without force, closed with it', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const started = await harness.call('session_start', { session: harness.residentA });
    assert.equal(started.isError, false, `the premise start must not error (text=${started.text})`);
    const hostBefore = liveHost(harness.manager, harness.residentA);
    const pidBefore = hostBefore?.pid ?? null;
    assert.equal(pidBefore, FIXTURE_PID, 'the premise: the host reports the fixture pid');

    harness.manager.addLease(harness.residentA, {
      kind: 'cron',
      id: 'cron-1',
      recurring: true,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    harness.manager.addLease(harness.residentA, { kind: 'background-task', id: 'task-1' });

    const blocked = await harness.call('session_close', { session: harness.residentA });
    const hostAfterBlocked = liveHost(harness.manager, harness.residentA);
    const blockedMessage = String(blocked.payload?.message ?? '');

    say(
      `(c) blocked isError=${blocked.isError} payload=${JSON.stringify(blocked.payload)} ` +
        `closeSpy=${harness.spies.close} pidAfter=${hostAfterBlocked?.pid ?? null}`,
    );

    assert.equal(blocked.isError, true, 'a close with blocking leases and no force must be refused');
    assert.equal(blocked.payload?.code, SESSION_HAS_ACTIVE_LEASES_CODE, 'the refusal carries the lease code');
    assert.ok(blockedMessage.includes('cron×1'), `the message must name cron×1 (got ${JSON.stringify(blockedMessage)})`);
    assert.ok(
      blockedMessage.includes('background-task×1'),
      `the message must name background-task×1 (got ${JSON.stringify(blockedMessage)})`,
    );
    const listed = ((blocked.payload?.details as AnyRecord | undefined)?.leases ?? []) as Array<{
      kind?: string;
    }>;
    assert.deepEqual(
      listed.map((lease) => lease.kind).sort(),
      ['background-task', 'cron'],
      'the refusal lists both blocking leases',
    );
    assert.equal(harness.spies.close, 0, 'the close service was NOT reached for a blocked call');
    assert.ok(hostAfterBlocked, 'the host is still running after the refusal');
    assert.equal(hostAfterBlocked.pid, pidBefore, 'and its pid is unchanged, verbatim');

    const forced = await harness.call('session_close', { session: harness.residentA, force: true });
    const hostAfterForced = liveHost(harness.manager, harness.residentA);
    say(
      `(c) forced isError=${forced.isError} payload=${JSON.stringify(forced.payload)} ` +
        `closeSpy=${harness.spies.close} liveHostAfter=${hostAfterForced ? hostAfterForced.hostId : null}`,
    );

    assert.equal(forced.isError, false, 'force: true authorises the close');
    assert.equal(forced.payload?.closeReason, 'user', 'the forced close records the user as the reason');
    assert.equal(forced.payload?.hostId, started.payload?.hostId, 'and names the started host');
    assert.equal(harness.spies.close, 1, 'the close service was reached exactly once');
    assert.equal(hostAfterForced, null, 'the host is gone after the forced close');

    // Positive control: a resident session holding ONLY `resident-policy` closes
    // without force, so "refuse every close" cannot pass this leg.
    const startedB = await harness.call('session_start', { session: harness.residentB });
    assert.equal(startedB.isError, false, `the positive-control start must not error (text=${startedB.text})`);
    const leasesB = bindingLeases(harness.manager, harness.residentB);
    const closedB = await harness.call('session_close', { session: harness.residentB });
    say(
      `(c) positiveControl leases=${JSON.stringify(leasesB)} isError=${closedB.isError} ` +
        `payload=${JSON.stringify(closedB.payload)}`,
    );

    assert.deepEqual(
      leasesB.map((lease) => lease.kind),
      ['resident-policy'],
      'the positive-control session holds only the resident-policy lease',
    );
    assert.equal(closedB.isError, false, 'a session with no blocking lease closes without force');
    assert.equal(closedB.payload?.closeReason, 'user');
  });
});

// --------------------------- (d) the existing refusal codes surface verbatim ---------------------------

test('(d) per-run / no-driver / unknown sessions keep the service refusal codes and messages', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const perRunStart = await harness.call('session_start', { session: harness.perRun });
    const perRunClose = await harness.call('session_close', { session: harness.perRun });
    const noDriver = await harness.call('session_start', { session: harness.noDriver });
    const unknownStart = await harness.call('session_start', { session: harness.unknown });
    const unknownClose = await harness.call('session_close', { session: harness.unknown });

    say(
      `(d) perRunStart=${JSON.stringify(perRunStart.payload)} perRunClose=${JSON.stringify(perRunClose.payload)} ` +
        `noDriver=${JSON.stringify(noDriver.payload)} unknownStart=${JSON.stringify(unknownStart.payload)} ` +
        `unknownClose=${JSON.stringify(unknownClose.payload)}`,
    );

    assert.equal(perRunStart.isError, true);
    assert.equal(perRunStart.payload?.code, 'LIFECYCLE_MODE_NOT_RESIDENT');
    assert.equal(
      perRunStart.payload?.message,
      `Session "${harness.perRun}" is stored as "per-run"; only a resident session can be started on demand.`,
    );

    assert.equal(perRunClose.isError, true);
    assert.equal(perRunClose.payload?.code, 'LIFECYCLE_MODE_NOT_RESIDENT');
    assert.equal(
      perRunClose.payload?.message,
      `Session "${harness.perRun}" is stored as "per-run"; only a resident session can be closed on demand.`,
    );

    assert.equal(noDriver.isError, true);
    assert.equal(noDriver.payload?.code, 'LIFECYCLE_MODE_HOST_UNAVAILABLE');
    assert.equal(
      noDriver.payload?.message,
      `Provider "codex" mounts no host driver, so session "${harness.noDriver}" cannot be started.`,
    );

    assert.equal(unknownStart.isError, true);
    assert.equal(unknownStart.payload?.code, 'SESSION_NOT_FOUND');
    assert.equal(unknownStart.payload?.message, `Session "${harness.unknown}" was not found.`);

    assert.equal(unknownClose.isError, true);
    assert.equal(unknownClose.payload?.code, 'SESSION_NOT_FOUND');
    assert.equal(unknownClose.payload?.message, `Session "${harness.unknown}" was not found.`);
  });
});

// --------------------------- (e) the control scope and its audit ---------------------------

test('(e) a token lacking cloudcli:session:control is denied on both tools and audits one denied row each', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const before = mcpAuditLogDb.count();

    const deniedStart = await harness.call('session_start', { session: harness.residentA }, 'sendOnly');
    const afterStart = mcpAuditLogDb.allRows().filter((row) => row.id > before);
    say(
      `(e) deniedStart isError=${deniedStart.isError} newRows=${JSON.stringify(afterStart)} ` +
        `startSpy=${harness.spies.start}`,
    );
    assert.equal(deniedStart.isError, true, 'a token lacking cloudcli:session:control must be denied');
    assert.equal(afterStart.length, 1, 'exactly one audit row must be written for the start');
    assert.equal(afterStart[0].tool, 'session_start', 'the audit row must name session_start');
    assert.equal(afterStart[0].outcome, 'denied', 'the audit row must read denied');
    // AC-286: the denied row carries the scope the caller was missing.
    assert.deepEqual(
      JSON.parse(afterStart[0].denied_scopes ?? 'null'),
      [CONTROL_SCOPE],
      'the denied row must carry the missing control scope',
    );
    assert.equal(harness.spies.start, 0, 'the start service must NOT be reached for a denied call');

    const deniedClose = await harness.call('session_close', { session: harness.residentA }, 'sendOnly');
    const afterClose = mcpAuditLogDb.allRows().filter((row) => row.id > before);
    say(
      `(e) deniedClose isError=${deniedClose.isError} rowsSinceBefore=${JSON.stringify(afterClose)} ` +
        `closeSpy=${harness.spies.close}`,
    );
    assert.equal(deniedClose.isError, true, 'a token lacking cloudcli:session:control must be denied');
    assert.equal(afterClose.length, 2, 'a second audit row must be written for the close');
    assert.equal(afterClose[1].tool, 'session_close', 'the second audit row must name session_close');
    assert.equal(afterClose[1].outcome, 'denied', 'the second audit row must read denied');
    assert.deepEqual(
      JSON.parse(afterClose[1].denied_scopes ?? 'null'),
      [CONTROL_SCOPE],
      'the second denied row must carry the missing control scope',
    );
    assert.equal(harness.spies.close, 0, 'the close service must NOT be reached for a denied call');

    const allowedStart = await harness.call('session_start', { session: harness.residentA }, 'control');
    const allowedClose = await harness.call('session_close', { session: harness.residentA }, 'control');
    say(
      `(e) allowedStart isError=${allowedStart.isError} startSpy=${harness.spies.start} ` +
        `allowedClose isError=${allowedClose.isError} closeSpy=${harness.spies.close}`,
    );
    assert.equal(allowedStart.isError, false, 'a token carrying cloudcli:session:control must succeed');
    assert.equal(harness.spies.start, 1, 'the allowed start reached the service');
    assert.equal(allowedClose.isError, false, 'the allowed close must succeed');
    assert.equal(harness.spies.close, 1, 'the allowed close reached the service');
  });
});

// --------------------------- barrel + table ---------------------------

test('the session-hosts barrel exports the two services the adapter delegates to; the table keeps the control scope', async () => {
  const sessionHosts = await import('@/modules/session-hosts/index.js');
  assert.equal(typeof sessionHosts.startResidentHost, 'function', 'startResidentHost is barreled');
  assert.equal(typeof sessionHosts.closeResidentHost, 'function', 'closeResidentHost is barreled');

  const names = MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name).sort();
  say(`(table) ${JSON.stringify(names)}`);
  assert.deepEqual(names, ['session_close', 'session_create', 'session_interrupt', 'session_send', 'session_start']);
  assert.equal(MCP_STAGE4_WRITE_TOOLS.find((tool) => tool.name === 'session_start')?.requiredScope, CONTROL_SCOPE);
  assert.equal(MCP_STAGE4_WRITE_TOOLS.find((tool) => tool.name === 'session_close')?.requiredScope, CONTROL_SCOPE);
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
