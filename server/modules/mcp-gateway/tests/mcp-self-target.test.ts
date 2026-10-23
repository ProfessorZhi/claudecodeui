/**
 * AC-252 criterion: the self-referential guard. When the TARGET session's live
 * turn is executing a gateway write tool (`phase === 'tool'` and the pending
 * tool's raw name matches `mcp__<any alias>__<gateway write tool>`), every write
 * operation that would deadlock it — `session_send` / `session_interrupt` /
 * `session_close` / `session_cancel_queued` — is refused with `SELF_TARGET`, and
 * the control and host services are NEVER reached (spy count 0).
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the target session is a
 * debug-agent fixture (`armDebugAgentScenario`) whose row really lands in that
 * database. The only injected seams are the ones the task names: the turn reader
 * (so the rule is exercised with no real Claude run) and the write-tool name set
 * (so leg (d) proves a newly added write tool is covered with no guard edit).
 * The control and host services are counting spies, so a count is a statement
 * that the gateway reached the service rather than an inference from its effect.
 *
 * The debug agent's gate is read ONCE per process and cached, and
 * `provider.registry.ts` builds its debug provider at module load. This file
 * therefore has NO static application imports: it opens `DEBUG_AGENT` (and
 * redirects `HOME` into a scratch directory) BEFORE any aliased module is pulled
 * in, and every application module below comes in dynamically.
 *
 * The transport is handed a `node:http`-based `fetch`: `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248/249/250/251's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) three arbitrary aliases (`mcp__cloudcli__session_send`,
 *       `mcp__my-cc-ui__session_interrupt`, `mcp__x__session_close`) × the four
 *       protected operations are ALL `SELF_TARGET`; the first three over HTTP,
 *       `session_cancel_queued` through a direct guard reading; every control
 *       and host spy stays 0;
 *   (b) the same live `tool` turn whose tool name is NOT a gateway write tool
 *       (`Bash`, `mcp__other__list_files`, `mcp__x__session_read`) is released,
 *       and an HTTP `session_send` really reaches `control.send` (exactly +1);
 *   (c) a residual `mcp__x__session_close` tool name with `phase !== 'tool'`
 *       (`thinking` / `writing` / `idle` / `awaitingPermission` / `compacting`)
 *       is released, and each HTTP `session_send` reaches `control.send`;
 *   (d) the write-tool NAME set is injected: `mcp__x__session_reconfigure` is
 *       released under `MCP_STAGE4_WRITE_TOOLS` and refused once
 *       `session_reconfigure` is added to the injected registry;
 *   (e) a READ tool is never refused: `session_read` succeeds against the very
 *       session that is self-targeted, and no control spy moves.
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

import type { TurnState } from '@/modules/providers/index.js';

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

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-self-target-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
const FIXTURE_HOME = path.join(SCRATCH, 'fixture');
process.env.HOME = SCRATCH_HOME;
process.env[GATE_VAR] = 'on';
process.env[GATE_HOME_VAR] = FIXTURE_HOME;
process.env.JWT_SECRET = 'mcp-self-target-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(FIXTURE_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { providerRegistry } = await import('@/modules/providers/index.js');
const { DEBUG_AGENT_PROVIDER_ID, armDebugAgentScenario } = await import('@/modules/debug-agent/index.js');
const {
  MCP_GATEWAY_PATH,
  MCP_SELF_TARGET_WRITE_OPS,
  MCP_STAGE3_READ_TOOLS,
  MCP_STAGE4_WRITE_TOOLS,
  SELF_TARGET_CODE,
  buildSelfTargetGuard,
  createMcpAuthMiddleware,
  isSelfTargetTurn,
  mountMcpGateway,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;
type SelfTargetDecision = ReturnType<ReturnType<typeof buildSelfTargetGuard>>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const READ_SCOPE = 'cloudcli:read';
const SEND_SCOPE = 'cloudcli:session:send';
const CONTROL_SCOPE = 'cloudcli:session:control';

/** A released turn: no live tool, which is what every non-Claude session reads. */
const IDLE_TURN: TurnState = { phase: 'idle', toolName: null, toolDurationMs: null };

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`self-target ${line}`);
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

type ToolCall = {
  isError: boolean;
  text: string;
  payload: AnyRecord | null;
  /**
   * The SDK's `structuredContent`, when the server emitted one. A handler that
   * THROWS is rendered by `withMcpAudit` as text-only `isError` (the same shape
   * AC-249/250/251's criteria read), so the refusal body lives in `text`; this
   * field is captured anyway so the reading does not depend on which of the two
   * carriers a given call used.
   */
  structured: AnyRecord | null;
};

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let payload: AnyRecord | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
  } catch {
    payload = null;
  }
  const structured =
    typeof call.structuredContent === 'object' && call.structuredContent !== null
      ? (call.structuredContent as AnyRecord)
      : null;
  return { isError: call.isError === true, text, payload, structured };
}

/** The refusal code a call carries, from whichever carrier rendered it. */
function refusalCode(call: ToolCall): unknown {
  return call.payload?.code ?? call.structured?.code ?? null;
}

// --------------------------- scenario building ---------------------------

/**
 * A valid, never-walked scenario. The guard reads an INJECTED turn, so this
 * fixture only has to make the target session a real row; arming writes the seed
 * rows and indexes the session under the debug provider.
 */
function targetScenario(label: string) {
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: `ac252 ${label}`, userText: `seed for ${label}`, lifecycleMode: 'per-run' },
    steps: [{ at: 5, op: 'row', role: 'assistant', text: `${label} done` }],
    expect: { rows: { delta: 1 }, content: { mustContain: [`${label} done`] } },
  };
}

// --------------------------- harness ---------------------------

type Spies = { send: number; abort: number; cancelQueued: number; start: number; close: number };

type Harness = {
  /** The real debug-agent session the guard reads a turn for. */
  targetId: string;
  /** The live turn the injected reader answers per session id. */
  turns: Map<string, TurnState>;
  spies: Spies;
  /** The write-tool name set the production default would inject. */
  writeToolNames: readonly string[];
  /** Calls one tool over the real `/mcp` mount. */
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  /** A direct guard reading over the injected turn reader, optionally a custom registry. */
  guard: (input: { op: string; targetSessionId: string }, names?: readonly string[]) => SelfTargetDecision;
};

/** Builds a `tool`-phase turn with the given raw tool name. */
function toolTurn(toolName: string): TurnState {
  return { phase: 'tool', toolName, toolDurationMs: 12 };
}

/**
 * Boots one arm: a fresh temp database + fixture home, one armed debug scenario
 * (the target session), the production `/mcp` mount carrying the read tools and
 * the write tools over counting control/host spies, and the injected turn reader
 * and write-tool registry.
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'self-target.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const debugProvider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
  assert.ok(debugProvider.sessionSynchronizer, 'the debug provider must carry a session synchronizer');

  const armed = await armDebugAgentScenario({
    projectPath: path.join(tempDirectory, 'project'),
    scenario: targetScenario('target'),
    synchronizeTranscript: (filePath) => debugProvider.sessionSynchronizer.synchronizeFile(filePath),
    setSessionLifecycleMode: ({ appSessionId, mode }) => sessionsDb.setSessionLifecycleMode(appSessionId, mode),
  });

  // The injected turn reader: this is the whole point of the criterion — the
  // rule is exercised with no real Claude run, and every leg sets the exact turn
  // it needs by mutating this map.
  const turns = new Map<string, TurnState>();
  const readTurn = (sessionId: string): TurnState => turns.get(sessionId) ?? IDLE_TURN;
  const writeToolNames = MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name);

  // Counting spies: a count is a statement that the gateway reached the service.
  // `cancelQueued` rides the same object so leg (a)'s "all zero" reading covers
  // the stage-6 operation too (that tool is deliberately not registered here).
  const spies: Spies = { send: 0, abort: 0, cancelQueued: 0, start: 0, close: 0 };
  const control = {
    send: async () => {
      spies.send += 1;
      return { ok: true, runId: 'ac252-run', queued: false, queuedMessageUuid: null };
    },
    abort: async () => {
      spies.abort += 1;
      return { ok: true, aborted: false };
    },
    cancelQueued: async () => {
      spies.cancelQueued += 1;
      return 'unknown' as const;
    },
  };

  const readTools = {
    projects: {
      getProjectsWithSessions: async () => [],
      getArchivedProjectsWithSessions: async () => [],
      getProjectSessionsPage: async () => ({ sessions: [], total: 0 }),
    },
    sessions: {
      listRecentSessions: () => ({ conversations: [], total: 0 }),
      readSessionLifecycle: () => null,
      // The one reader leg (e) reaches: an empty transcript is a legitimate answer.
      fetchHistory: async () => ({ messages: [] }),
      fetchOutline: async () => ({ turns: [] }),
      fetchWindowAround: async () => ({ messages: [] }),
    },
    hosts: { snapshot: () => [], liveHostForSession: () => null },
    runs: { listRunningRuns: () => [] },
    now: () => Date.now(),
  };

  const sessionHostControl = {
    hosts: {
      start: async (sessionId: string) => {
        spies.start += 1;
        return { ok: true as const, sessionId, hostId: 'ac252-host', mode: 'resident', pid: 4242, leases: [] };
      },
      close: (sessionId: string) => {
        spies.close += 1;
        return { ok: true as const, sessionId, hostId: 'ac252-host', mode: 'resident', closeReason: 'user', leases: [] };
      },
      liveHost: () => null,
    },
  };

  const tokens = createAccessTokensService({ now: () => new Date() });
  const issued = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac252-criterion',
    scopes: [READ_SCOPE, SEND_SCOPE, CONTROL_SCOPE],
    expiresInDays: 30,
  });
  if (!issued.ok) {
    throw new Error('the harness must mint the criterion token');
  }

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    readTools: readTools as never,
    writeTools: {
      control,
      runs: { getRun: () => undefined },
      runGet: { deps: {}, build: async () => ({ outcome: 'timeout' }) },
      sessionInterrupt: { control },
      sessionHostControl,
    } as never,
    // The injected guard seams. Supplying them at the mount level overrides the
    // production default for every write tool this mount registers.
    selfTarget: { readTurn, writeToolNames },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${issued.token.token}` } },
    fetch: nodeFetch,
  });
  const client = new Client({ name: 'ac252-criterion', version: '0.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: AnyRecord = {}): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  try {
    await run({
      targetId: armed.sessionId,
      turns,
      spies,
      writeToolNames,
      call,
      guard: (input, names) =>
        buildSelfTargetGuard({ readTurn, writeToolNames: names ?? writeToolNames })(input),
    });
  } finally {
    await transport.close().catch(() => undefined);
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

// --------------------------- (a) arbitrary alias × four protected ops ---------------------------

test('(a) three arbitrary aliases × four protected operations are all SELF_TARGET with zero service calls', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    // The three trigger names the SPEC pins: an alias that merely starts with
    // `mcp__cloudcli`, one containing `-`, and one that shares no prefix at all.
    const triggers = ['mcp__cloudcli__session_send', 'mcp__my-cc-ui__session_interrupt', 'mcp__x__session_close'];
    const httpOps: Array<{ name: string; args: AnyRecord }> = [
      { name: 'session_send', args: { session: harness.targetId, message: 'blocked' } },
      { name: 'session_interrupt', args: { session: harness.targetId } },
      { name: 'session_close', args: { session: harness.targetId } },
    ];

    const observed: Array<{ trigger: string; op: string; isError: boolean; code: unknown }> = [];

    for (const trigger of triggers) {
      harness.turns.set(harness.targetId, toolTurn(trigger));
      for (const op of httpOps) {
        const call = await harness.call(op.name, op.args);
        observed.push({ trigger, op: op.name, isError: call.isError, code: refusalCode(call) });
        assert.equal(call.isError, true, `${op.name} against ${trigger} must be refused (text=${call.text})`);
        assert.equal(
          refusalCode(call),
          SELF_TARGET_CODE,
          `${op.name} against ${trigger} must carry ${SELF_TARGET_CODE} (text=${call.text})`,
        );
      }

      // `session_cancel_queued` is a stage-6 tool this task does NOT register
      // (out of scope); its decision is read off the guard directly, over the
      // same injected turn reader and registry.
      const cancelDecision = harness.guard({ op: 'session_cancel_queued', targetSessionId: harness.targetId });
      observed.push({
        trigger,
        op: 'session_cancel_queued',
        isError: !cancelDecision.allowed,
        code: cancelDecision.allowed ? null : cancelDecision.code,
      });
      assert.equal(cancelDecision.allowed, false, `session_cancel_queued against ${trigger} must be refused`);
      assert.equal(
        cancelDecision.allowed ? null : cancelDecision.code,
        SELF_TARGET_CODE,
        `session_cancel_queued against ${trigger} must carry ${SELF_TARGET_CODE}`,
      );
    }

    say(`(a) triggers=${JSON.stringify(triggers)} reads=${JSON.stringify(observed)}`);
    say(
      `(a) spies=${JSON.stringify(harness.spies)} protectedOps=${JSON.stringify([...MCP_SELF_TARGET_WRITE_OPS])} ` +
        `target=${harness.targetId}`,
    );

    // Every one of the 12 readings is SELF_TARGET — assert the cross product
    // explicitly so a single released pair cannot hide in the loop above.
    assert.equal(observed.length, triggers.length * 4, 'three aliases × four ops = twelve readings');
    assert.ok(
      observed.every((reading) => reading.code === SELF_TARGET_CODE),
      `all twelve must be ${SELF_TARGET_CODE} (got ${JSON.stringify(observed)})`,
    );
    assert.deepEqual(harness.spies, { send: 0, abort: 0, cancelQueued: 0, start: 0, close: 0 });
  });
});

// --------------------------- (b) non-gateway tool names are released ---------------------------

test('(b) Bash / mcp__other__list_files / mcp__x__session_read are released and session_send reaches control.send', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const allowedNames = ['Bash', 'mcp__other__list_files', 'mcp__x__session_read'];

    for (const toolName of allowedNames) {
      harness.turns.set(harness.targetId, toolTurn(toolName));
      const decision = harness.guard({ op: 'session_send', targetSessionId: harness.targetId });
      const before = harness.spies.send;
      const call = await harness.call('session_send', { session: harness.targetId, message: 'allowed' });
      say(
        `(b) toolName=${toolName} decision=${JSON.stringify(decision)} sendBefore=${before} ` +
          `sendAfter=${harness.spies.send} isError=${call.isError} payload=${JSON.stringify(call.payload)}`,
      );

      assert.equal(decision.allowed, true, `${toolName} is not a gateway write tool, so the guard releases`);
      assert.equal(call.isError, false, `session_send must succeed while the target runs ${toolName} (text=${call.text})`);
      assert.equal(refusalCode(call), null, 'a successful call carries no refusal code');
      assert.equal(harness.spies.send, before + 1, `control.send must be reached exactly once for ${toolName}`);
    }

    assert.equal(harness.spies.send, allowedNames.length, 'the positive control really reached the service each time');
    assert.equal(harness.spies.abort + harness.spies.close + harness.spies.start + harness.spies.cancelQueued, 0);
  });
});

// --------------------------- (c) phase !== 'tool' releases the residual name ---------------------------

test("(c) a residual gateway tool name with phase !== 'tool' is released on every non-tool phase", { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const phases: TurnState['phase'][] = ['thinking', 'writing', 'idle', 'awaitingPermission', 'compacting'];

    for (const phase of phases) {
      const phaseTurn: TurnState = { phase, toolName: 'mcp__x__session_close', toolDurationMs: 9 };
      harness.turns.set(harness.targetId, phaseTurn);
      // The direct rule reading for THIS phase turn: the residual name is present
      // but the phase is not `tool`, so `isSelfTargetTurn` must release.
      const reading = isSelfTargetTurn(phaseTurn, harness.writeToolNames);
      const decision = harness.guard({ op: 'session_send', targetSessionId: harness.targetId });
      const before = harness.spies.send;
      const call = await harness.call('session_send', { session: harness.targetId, message: 'phase' });
      say(
        `(c) phase=${phase} toolTurnReading_blocked=${reading.blocked} decision=${JSON.stringify(decision)} ` +
          `sendBefore=${before} sendAfter=${harness.spies.send} isError=${call.isError}`,
      );

      assert.equal(reading.blocked, false, `the residual name on phase ${phase} must not read as a self-target`);
      assert.equal(decision.allowed, true, `phase ${phase} is not a live tool, so the guard releases`);
      assert.equal(call.isError, false, `session_send must succeed on phase ${phase}`);
      assert.equal(harness.spies.send, before + 1, `control.send must be reached for phase ${phase}`);
    }

    assert.equal(harness.spies.send, phases.length, 'every phase reached the service exactly once');
  });
});

// --------------------------- (d) the write-tool name set comes from the registry ---------------------------

test('(d) a newly added write tool is covered by the injected registry with no guard edit', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const base: ReadonlyArray<{ name: string; scope?: string }> = MCP_STAGE4_WRITE_TOOLS.map((tool) => ({
      name: tool.name,
      scope: tool.requiredScope,
    }));
    const extended = [...base, { name: 'session_reconfigure', scope: 'cloudcli:session:control' }];

    harness.turns.set(harness.targetId, toolTurn('mcp__x__session_reconfigure'));

    const baseNames = base.map((tool) => tool.name);
    const extendedNames = extended.map((tool) => tool.name);
    const baseDecision = harness.guard({ op: 'session_send', targetSessionId: harness.targetId }, baseNames);
    const extendedDecision = harness.guard({ op: 'session_send', targetSessionId: harness.targetId }, extendedNames);

    say(`(d) baseNames=${JSON.stringify(baseNames)} baseDecision=${JSON.stringify(baseDecision)}`);
    say(`(d) extendedNames=${JSON.stringify(extendedNames)} extendedDecision=${JSON.stringify(extendedDecision)}`);

    assert.equal(baseDecision.allowed, true, 'session_reconfigure is not in the base registry, so the guard releases');
    assert.equal(extendedDecision.allowed, false, 'adding session_reconfigure to the registry must widen the guard');
    assert.equal(
      extendedDecision.allowed ? null : extendedDecision.code,
      SELF_TARGET_CODE,
      'the widened guard refuses with SELF_TARGET',
    );
    assert.ok(!baseNames.includes('session_reconfigure'), 'the base registry does not name the new tool');
    assert.ok(extendedNames.includes('session_reconfigure'), 'the extended registry names it');
  });
});

// --------------------------- (e) read tools are never refused ---------------------------

test('(e) a read tool succeeds against a self-targeted session and moves no control spy', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    harness.turns.set(harness.targetId, toolTurn('mcp__x__session_close'));

    const before = { ...harness.spies };
    const call = await harness.call('session_read', { session: harness.targetId, mode: 'latest' });
    say(
      `(e) readTool=session_read isError=${call.isError} code=${JSON.stringify(refusalCode(call))} ` +
        `payload=${JSON.stringify(call.payload)} spiesBefore=${JSON.stringify(before)} ` +
        `spiesAfter=${JSON.stringify(harness.spies)}`,
    );

    assert.equal(call.isError, false, `a read tool must never be refused (text=${call.text})`);
    assert.notEqual(refusalCode(call), SELF_TARGET_CODE, 'a read tool must never answer SELF_TARGET');
    assert.equal(call.payload?.session, harness.targetId, 'the read really ran against the self-targeted session');
    assert.equal(call.payload?.mode, 'latest');
    assert.deepEqual(harness.spies, before, 'no control or host service moved for a read');
  });
});

// --------------------------- barrel + vocabulary ---------------------------

test('the guard, its code and its protected-op list are barreled and match the stage-4 registry', async () => {
  assert.equal(typeof buildSelfTargetGuard, 'function', 'buildSelfTargetGuard is barreled');
  assert.equal(typeof isSelfTargetTurn, 'function', 'isSelfTargetTurn is barreled');
  assert.equal(SELF_TARGET_CODE, 'SELF_TARGET');

  const readNames = MCP_STAGE3_READ_TOOLS.map((tool) => tool.name);
  const writeNames = MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name);
  say(`(barrel) readNames=${JSON.stringify(readNames)} writeNames=${JSON.stringify(writeNames)}`);
  assert.ok(readNames.includes('session_read'), 'session_read is one of the stage-3 read tools');
  assert.deepEqual(
    [...MCP_SELF_TARGET_WRITE_OPS].sort(),
    ['session_cancel_queued', 'session_close', 'session_interrupt', 'session_send'],
    'the protected operations are the four the SPEC names',
  );
  assert.ok(
    writeNames.includes('session_send') && !(writeNames as readonly string[]).includes('session_cancel_queued'),
    'session_cancel_queued is a stage-6 tool, deliberately absent from the stage-4 registry',
  );
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
