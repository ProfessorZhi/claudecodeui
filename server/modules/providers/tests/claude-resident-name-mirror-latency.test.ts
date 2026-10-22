/**
 * Criterion for `gap-claude-resident-name-mirror-window-opens-too-late` — a
 * resident Claude process's registered peer address must move onto its generated
 * title *while the first turn is still running*, not only once the turn's
 * `result` has been read.
 *
 * The sibling `claude-resident-name-live-mirror.test.ts` established the channel
 * (`rename_session` written to the live process's stdin) and opened the settle
 * window at each turn's `result`. Measured on a live session, that is too late:
 * the CLI writes its `ai-title` row near the *start* of the first turn — before
 * the first assistant message — while the mirror waited for the turn to end, so
 * the readable name the sidebar showed and the address `ListAgents`/`SendMessage`
 * used disagreed for the whole first turn (measured: 362 s on the session that
 * filed this task, with the title itself settled within ~0.6 s of appearing).
 *
 * This file has two legs, in order:
 *
 * 1. **The load-bearing reading (taken before the product change).** Can the CLI
 *    even be renamed *mid-turn*? The channel was measured with the process idle;
 *    nothing had measured a `rename_session` frame written while a turn was in
 *    flight. This leg answers that directly: a resident process is held mid-turn
 *    (the mock withholds its agent answer), a `rename_session` frame is written by
 *    hand through the same raw-write seam the driver uses, and the registry is
 *    read back. The reading must be: `name` byte-equal to the frame's title,
 *    `nameSource` no longer `derived`, `nameSince` moved past `startedAt`, **pid
 *    and `startedAt` unchanged**, and the turn still reaching its `result`. The
 *    negative control is a sibling session of the same shape whose window is not
 *    written to: it stays `derived`.
 *
 * 2. **The window timing (after the product change).** A fresh resident session
 *    whose mock *does* answer title generation is held mid-turn, and the registry
 *    is polled for the address while the turn is still open. It must read the
 *    transcript's own `ai-title` byte for byte, before any `result` frame exists.
 *    The frame count is one; a later round appends the same title again and writes
 *    no second frame; and both the `custom-title` **and** the `agent-name` rows the
 *    rename appends are clamped to the mirrored value — the sibling criterion
 *    clamped only `custom-title`, leaving the ladder's top rung (the rung `--name`
 *    once wrote) unclamped.
 *
 * Red lines:
 * - The process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, so a lifecycle that hangs is a budget kill with its own
 *   reading, as in the sibling criterion.
 * - Every reading is printed before anything is asserted.
 * - The mid-turn legs hold the turn open with a mock gate rather than a sleep, so
 *   "the address moved before the result" is a fact about the gate, not a race.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  providerModelsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { createProviderRuntimeService, providerRegistry, providerRoutes } from '@/modules/providers/index.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type {
  ClaudeResidentHostDriver,
  ClaudeResidentProcess,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

/** This run's own tag: session ids and transcript markers belong to this run alone. */
const RUN_TAG = randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 8);

/** The session the mid-turn hand-written rename frame is sent to. */
const SESSION_PROBE = `${RUN_TAG}-latency-probe`;
/** Its negative control: same shape, no frame written. */
const SESSION_PROBE_NEG = `${RUN_TAG}-latency-probe-neg`;
/** The session the product's own settle window renames. */
const SESSION_WINDOW = `${RUN_TAG}-latency-window`;

const MARKER_PROBE = `LATENCY-PROBE-${RUN_TAG}`;
const MARKER_PROBE_NEG = `LATENCY-PROBE-NEG-${RUN_TAG}`;
const MARKER_WINDOW = `LATENCY-WINDOW-${RUN_TAG}`;

/** What the mock answers the CLI's title-generation request with. */
const MOCK_AI_TITLE = `镜像延迟标题 ${RUN_TAG} latency title`;
/** The title the second-round mutation would use if a second window ever fired. */
const SECOND_AI_TITLE = `镜像延迟标题 ${RUN_TAG} revised`;
/** The title the hand-written mid-turn frame carries. Distinct from any ai-title. */
const PROBE_TITLE = `手工改名 ${RUN_TAG} hand-written rename`;

/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = `latency-custom-model-${RUN_TAG}`;
const MODEL_SECRET = `latency-model-row-secret-${RUN_TAG}`;

/** How long a turn is given to open and, once released, to land. */
const TURN_TIMEOUT_MS = 30_000;
/** How long a transcript or registry reading is given to appear. */
const READ_TIMEOUT_MS = 20_000;
/** How long the mid-turn registry is given to move after the raw frame is written. */
const MIDTURN_TIMEOUT_MS = 20_000;
/** How long the negative control is watched for a name that must not move. */
const NEGATIVE_WINDOW_MS = 8_000;
/** How many times a session's first turn is sent before the criterion gives up. */
const BOOT_ATTEMPTS = 3;

/**
 * How long the raw-write seam is given to become observable.
 *
 * The seam is three conditions at once — the driver's live state for the
 * session, a raw write channel on its process, and the provider session id —
 * and the last of them (the id, captured from the process's own stream) is what
 * arrives after the process is up. The probe reads the seam only *after* the
 * host pid and the registry entry it already waits on, each `READ_TIMEOUT_MS`,
 * so two of that same step is the budget the invariant below enforces: at least
 * the steps the seam follows, with a stream hop of the same order for the id.
 *
 * Taken as two readiness steps, this is not a hand-picked sleep: the value is
 * checked against the steps it shelters at module load (`SEAM_READY_TIMEOUT_MS`
 * vs `READ_TIMEOUT_MS`), so shrinking it below the work that must precede it —
 * or the exact defect this task fixes, asserting before the seam can be
 * observed — is a red, not a comment.
 */
const SEAM_READY_TIMEOUT_MS = 40_000;

/**
 * The probe's pre-assertion readiness ladder, in the order it is climbed: the
 * host pid, then the registry entry, then the seam. A run that reached the
 * assertion has waited at most this long before it; the ladder must fit the
 * process budget below or a load-slowed-but-successful boot is killed by the
 * guard (exit 3) instead of reporting a case failure.
 */
const READINESS_LADDER_MS = READ_TIMEOUT_MS + READ_TIMEOUT_MS + SEAM_READY_TIMEOUT_MS;

/** How long the positive control hides an already-ready seam before releasing it. */
const POSITIVE_CONTROL_DELAY_MS = 1_500;
/** How long the negative control watches a seam that never appears. */
const NEGATIVE_CONTROL_WAIT_MS = 1_000;

/**
 * The process budget, enforced by the process rather than by node:test's own
 * per-case timeout, so a lifecycle that hangs is its own reading.
 */
const BUDGET_MS = Number(process.env.CLAUDE_RESIDENT_LATENCY_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_RESIDENT_LATENCY_BUDGET_MS)
  : 240_000;
const STARTED_AT = Date.now();

/**
 * Budget invariants — asserted, not described (the shape
 * `gap-resident-server-restart-budget-shorter-than-its-three-boots` applied to
 * its three boots, here applied to the probe's own readiness ladder).
 *
 * They run at module load, so a budget that is smaller than the steps it
 * shelters reds before any case starts rather than letting the in-lane race
 * silently return: a seam budget below the two steps that must precede it would
 * read a slow-but-ready seam as absent (this task's own defect), and a process
 * budget below the ladder would kill a load-slowed-but-successful run with
 * `exit 3` and name no case.
 */
assert.ok(
  SEAM_READY_TIMEOUT_MS >= READ_TIMEOUT_MS + READ_TIMEOUT_MS,
  `SEAM_READY_TIMEOUT_MS (${SEAM_READY_TIMEOUT_MS}ms) is below the readiness steps it follows ` +
    `(host pid + registry entry = ${READ_TIMEOUT_MS + READ_TIMEOUT_MS}ms): a slow-but-ready raw write seam ` +
    `would be read as absent, which is the in-lane failure this criterion exists to rule out.`,
);
assert.ok(
  BUDGET_MS > READINESS_LADDER_MS,
  `BUDGET_MS (${BUDGET_MS}ms) is not longer than the probe's readiness ladder (${READINESS_LADDER_MS}ms): ` +
    `a load-slowed-but-successful boot would be killed by the process guard (exit 3) before the seam is read.`,
);

const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the resident title-mirror ` +
      `latency run did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, BUDGET_MS);
budgetGuard.unref();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------------------
// The registry, as the CLI writes it. Read here, independently.
// ---------------------------------------------------------------------------

type CliRegistration = {
  pid: number;
  sessionId: string | null;
  name: string | null;
  nameSource: string | null;
  nameSince: number | null;
  startedAt: number | null;
};

/**
 * One process's registration, read straight off disk — parsed here rather than
 * through the driver's own reader, so "the app agrees with itself" is not what a
 * reading says. `nameSince` is the rename clock and `startedAt` the process clock;
 * both are read off the registry file itself, which is how "the name moved while
 * the process stayed put" is distinguished from "the process was restarted".
 */
function readRegistration(configDir: string, pid: number | null): CliRegistration | null {
  if (pid === null) {
    return null;
  }
  try {
    const row = JSON.parse(readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    return {
      pid,
      sessionId: typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null,
      name: typeof row.name === 'string' && row.name ? row.name : null,
      nameSource: typeof row.nameSource === 'string' ? row.nameSource : null,
      nameSince: typeof row.nameSince === 'number' ? row.nameSince : null,
      startedAt: typeof row.startedAt === 'number' ? row.startedAt : null,
    };
  } catch {
    // No registration yet, or a torn one. A caller polls.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The mock endpoint
// ---------------------------------------------------------------------------

type Received = { url: string; body: string; isAgent: boolean };

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  /** Whether the next title-generation requests answer with JSON (`{"title": ...}`) or prose. */
  setTitleJson(enabled: boolean): void;
  /** Withholds every agent (non-title) answer until `releaseAgent`, holding a turn mid-flight. */
  holdAgent(): void;
  releaseAgent(): void;
  close(): Promise<void>;
};

const sse = (events: Array<[string, unknown]>): string =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const textStream = (text: string): string =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);

/**
 * An Anthropic-compatible endpoint that answers a turn and a title generation.
 *
 * A request is an *agent* request when its body declares tool schemas; the CLI's
 * title-generation posts carry none, which is what separates the two. The title
 * answer is switchable so the same endpoint serves both legs, and the agent answer
 * can be *held* (see `holdAgent`) so a turn stays open while the registry is read.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  let titleJson = true;
  let agentGate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');

      const answer = (payload: string) => {
        if (response.writableEnded || response.destroyed) {
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(payload);
      };

      if (url.split('?')[0] !== '/v1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }

      const isAgent = body.includes('"input_schema"');
      received.push({ url, body, isAgent });
      if (isAgent) {
        const gate = agentGate;
        if (gate) {
          void gate.then(() => answer(textStream(`latency ack ${RUN_TAG}`)));
          return;
        }
        answer(textStream(`latency ack ${RUN_TAG}`));
        return;
      }
      answer(titleJson ? textStream(JSON.stringify({ title: MOCK_AI_TITLE })) : textStream('aux ok'));
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    setTitleJson: (enabled: boolean) => { titleJson = enabled; },
    holdAgent: () => {
      agentGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    },
    releaseAgent: () => {
      releaseGate?.();
      releaseGate = null;
      agentGate = null;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ---------------------------------------------------------------------------
// Transport stand-in and file readings
// ---------------------------------------------------------------------------

type FakeSocket = EventEmitter & {
  readyState: number;
  OPEN: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  };
  socket.close = () => { socket.readyState = 3; };
  return socket;
}

/** Polls a predicate and answers whether it held, without failing the case. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(50);
  }
  console.log(`[readings] waitFor timed out after ${timeoutMs}ms: ${label}`);
  return false;
}

/** One line of a JSONL file, or an empty record for a torn one. */
function readJsonLines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

/**
 * The session's transcript, located by the marker only its own prompt carries.
 * The newest match wins, because a process that died on the way up and was booted
 * again leaves an earlier file behind.
 */
function findTranscriptByMarker(configDir: string, marker: string): string | null {
  const projects = path.join(configDir, 'projects');
  if (!existsSync(projects)) {
    return null;
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const file of readdirSync(path.join(projects, entry.name))) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      const candidate = path.join(projects, entry.name, file);
      if (!readFileSync(candidate, 'utf8').includes(marker)) {
        continue;
      }
      const mtimeMs = statSync(candidate).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = { file: candidate, mtimeMs };
      }
    }
  }
  return newest?.file ?? null;
}

/**
 * The title rows a process wrote into its own transcript, in row order.
 *
 * All three rungs the CLI can write are collected. `ai-title` is Claude's own
 * generated title; `custom-title` and `agent-name` are the side effects a rename
 * appends, and the last two are what the clamp reads.
 */
function titleRows(rows: Array<Record<string, unknown>>): {
  aiTitles: string[];
  customTitles: string[];
  agentNames: string[];
} {
  const aiTitles: string[] = [];
  const customTitles: string[] = [];
  const agentNames: string[] = [];
  for (const row of rows) {
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle) {
      aiTitles.push(row.aiTitle);
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle) {
      customTitles.push(row.customTitle);
    }
    if (row.type === 'agent-name' && typeof row.agentName === 'string' && row.agentName) {
      agentNames.push(row.agentName);
    }
  }
  return { aiTitles, customTitles, agentNames };
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Harness = {
  socket: FakeSocket;
  cwd: string;
  configDir: string;
  mock: MockAnthropic;
};

async function withLatencyHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-latency-'));
  const configDir = path.join(tempDirectory, 'claude-config');
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  const mock = await startMockAnthropic();
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRoutes);
  app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // A dead host endpoint, so a run that ignored the model entry can never reach
    // the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = 'sk-host-sentinel-must-not-leak';
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser(`claude-resident-latency-${RUN_TAG}`, 'unused-hash');

    const now = new Date().toISOString();
    for (const sessionId of [SESSION_PROBE, SESSION_PROBE_NEG, SESSION_WINDOW]) {
      sessionsDb.createSession(sessionId, 'claude', tempDirectory, `${RUN_TAG} display name`, now, now, null);
      // A session the app has never resumed has no provider session id yet, which
      // is exactly why its first launch is handed no title at all.
      getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(sessionId);
      assert.strictEqual(sessionsDb.setSessionLifecycleMode(sessionId, 'resident'), true);
    }

    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });

    sessionHostManager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));

    const socket = createFakeSocket();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: createProviderRuntimeService() as never },
    );

    await run({ socket, cwd: tempDirectory, configDir, mock });
  } finally {
    sessionHostManager.setUnattendedRunOpener(null);
    for (const host of sessionHostManager.snapshot()) {
      if (host.state !== 'closed') {
        sessionHostManager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await sleep(250);
    for (const host of sessionHostManager.snapshot()) {
      if (host.pid && existsSync(`/proc/${host.pid}`)) {
        try {
          process.kill(host.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the kill.
        }
      }
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
    await mock.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The `complete` frames this run's client has seen for one session. */
function completes(socket: FakeSocket, sessionId: string): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => frame.kind === 'complete' && frame.sessionId === sessionId);
}

/** Writes one user turn into the resident session and does not wait for it. */
function pushTurn(socket: FakeSocket, sessionId: string, content: string, cwd: string): void {
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'bypassPermissions' },
  }));
}

/**
 * Sends one user turn and answers with its terminal `complete` frame.
 * The retry absorbs a process that died on the way up (an environmental failure,
 * a fact about the machine and not about the mirror).
 */
async function sendRound(
  socket: FakeSocket,
  sessionId: string,
  content: string,
  cwd: string,
): Promise<{ frame: Record<string, unknown>; exits: number[] }> {
  const exits: number[] = [];
  for (;;) {
    const before = completes(socket, sessionId).length;
    pushTurn(socket, sessionId, content, cwd);
    await waitFor(() => completes(socket, sessionId).length > before, TURN_TIMEOUT_MS, `round "${content.slice(0, 32)}"`);
    const frame = completes(socket, sessionId).at(-1) as Record<string, unknown>;
    const exitCode = typeof frame.exitCode === 'number' ? frame.exitCode : 0;
    exits.push(exitCode);
    const landed = exitCode === 0 && frame.aborted === false;
    if (landed || exits.length >= BOOT_ATTEMPTS) {
      return { frame, exits };
    }
    console.log(
      `[readings] boot retry session=${sessionId} attempt=${exits.length} exit=${exitCode} ` +
        `(the process did not come up; sending the first turn again)`,
    );
    await sleep(250);
  }
}

/** The host driver this criterion reads its frame counts off. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

/** The driver's private per-session state, reached directly for this criterion only. */
type DriverInternals = {
  liveStateFor(appSessionId: string): { process: ClaudeResidentProcess; providerSessionId: string | null } | null;
};

/** The three conditions the raw-write seam needs, read in one pass. */
type SeamReading = {
  /** The driver holds live state for the session (it has adopted the process). */
  liveState: boolean;
  /** The process offers the raw write channel the rename frame goes out on. */
  writeRaw: boolean;
  /** The provider session id the frame must carry, or null while it is not yet readable. */
  providerSessionId: string | null;
};

/** The driver's live state for a session, or null when it has no process. */
function rawSeamState(appSessionId: string): { process: ClaudeResidentProcess; providerSessionId: string | null } | null {
  return (residentDriver() as unknown as DriverInternals).liveStateFor(appSessionId);
}

/**
 * Reads the three seam conditions as they stand right now, without waiting.
 *
 * Printed before the assertion so a failure names *which* condition is absent:
 * the provider session id is captured from the process's own stream and arrives
 * one hop behind the registry entry the probe already waits on, so it is the
 * one that can still be null at the instant the frame is written.
 */
function readSeam(appSessionId: string): SeamReading {
  const state = rawSeamState(appSessionId);
  return {
    liveState: state !== null,
    writeRaw: typeof state?.process?.writeRaw === 'function',
    providerSessionId: state?.providerSessionId ?? null,
  };
}

/** Whether a reading means the seam can be written through right now. */
function seamReady(reading: SeamReading): boolean {
  return reading.liveState && reading.writeRaw && reading.providerSessionId !== null;
}

/**
 * The criterion's own seam reader. Swappable so the controls below can inject a
 * seam that is slow to appear (positive: the wait must outlast it) or that
 * never appears (negative: the wait must not invent it). The real reader is
 * {@link readSeam}; nothing but this criterion's own wait and write go through
 * it, so a swap cannot change how the driver handles the turn.
 */
let seamReader: (appSessionId: string) => SeamReading = readSeam;

/**
 * Waits, within a budget, for the raw-write seam to become observable.
 *
 * This is the readiness step the probe was missing: the host pid and the
 * registry entry say the process is up, but the provider session id it must
 * write the rename frame with is read off the process's stream and can lag
 * both. On a quiet machine the lag is ~0 and the old immediate read was always
 * lucky; under lane load the window opens and the seam reads as absent. The
 * budget is `SEAM_READY_TIMEOUT_MS`, asserted at module load to cover the steps
 * it follows.
 *
 * A timeout is *not* answered here: the caller's own assertion must still fail
 * loudly on the same sentence when the seam is genuinely absent.
 */
async function waitForSeamReady(appSessionId: string, timeoutMs: number, label: string): Promise<boolean> {
  return waitFor(() => seamReady(seamReader(appSessionId)), timeoutMs, label);
}

/** Prints the three seam conditions, so a red names which one is absent. */
function logSeam(label: string, appSessionId: string): void {
  const reading = readSeam(appSessionId);
  console.log(
    `[readings] ${label} seam liveState=${reading.liveState} writeRaw=${reading.writeRaw} ` +
      `providerSessionId=${reading.providerSessionId === null ? 'null' : 'set'}`,
  );
}

/**
 * Writes one `rename_session` frame by hand through the process's own raw-write
 * seam — the exact bytes {@link ClaudeResidentHostDriver} would write — so the
 * load-bearing question ("does the CLI honor a rename while a turn is running?")
 * is answered about the channel, independently of when the product opens its
 * window. Returns whether a live process with a write seam was there to write to.
 *
 * The readiness predicate is the same `seamReady` the bounded wait polls, so a
 * seam that never becomes ready fails the same way here as it would there.
 */
function writeRawRename(appSessionId: string, title: string): boolean {
  if (!seamReady(seamReader(appSessionId))) {
    return false;
  }
  const state = rawSeamState(appSessionId);
  const writeRaw = state?.process.writeRaw;
  if (!state || typeof writeRaw !== 'function' || !state.providerSessionId) {
    return false;
  }
  writeRaw.call(state.process, {
    type: 'control_request',
    request_id: randomUUID(),
    request: {
      subtype: 'rename_session',
      title,
      source: 'host',
      session_id: state.providerSessionId,
    },
  });
  return true;
}

/** The control frames this host has written whose subtype is the title rename. */
function renameFrames(sessionId: string): Array<{ at: number; frame: Record<string, unknown> }> {
  const reading = residentDriver().busyInputReading(sessionId);
  const frames = reading?.controlFrames ?? [];
  return frames.filter((entry) => {
    const request = row(entry.frame.request);
    return request?.subtype === 'rename_session';
  });
}

/** The pid of the live host serving one session, or null. */
function hostPid(sessionId: string): number | null {
  const host = sessionHostManager
    .snapshot()
    .find((candidate) => candidate.state !== 'closed' && candidate.bindings.has(sessionId));
  return host?.pid ?? null;
}

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** The mirrored title a rename frame carried, or null. */
function mirroredTitle(sessionId: string): string | null {
  const request = row(renameFrames(sessionId).at(-1)?.frame.request);
  const title = request?.title;
  return typeof title === 'string' && title ? title : null;
}

/**
 * Opens a resident session's first turn and waits for its registry entry.
 *
 * The turn is pushed and *not* awaited: these legs observe the process while the
 * turn is still in flight. A process that dies on the way up (an environmental
 * failure) is retried with a fresh turn, up to the boot budget, exactly as the
 * sibling criterion retries its own.
 */
async function openResidentTurn(
  socket: FakeSocket,
  sessionId: string,
  content: string,
  cwd: string,
  configDir: string,
  label: string,
): Promise<{ pid: number; before: CliRegistration | null; exits: number[] }> {
  const exits: number[] = [];
  for (;;) {
    pushTurn(socket, sessionId, content, cwd);
    const up = await waitFor(() => hostPid(sessionId) !== null, READ_TIMEOUT_MS, `${label} host pid`);
    const last = completes(socket, sessionId).at(-1);
    const exitCode = last && typeof last.exitCode === 'number' ? last.exitCode : 0;
    if (!up) {
      exits.push(exitCode);
      console.log(`[readings] ${label} process did not come up (exit=${exitCode}); retrying the turn`);
      if (exits.length >= BOOT_ATTEMPTS) {
        assert.fail(`the ${label} resident process never came up (exits=${exits.join(',')})`);
      }
      await sleep(250);
      continue;
    }
    const pid = hostPid(sessionId) as number;
    await waitFor(() => readRegistration(configDir, pid) !== null, READ_TIMEOUT_MS, `${label} registry entry`);
    // The seam is the last readiness step. The pid says the process is up and
    // the registry row says the CLI has written itself down, but neither says
    // the provider session id the rename frame must carry has been read off the
    // process's stream yet. Wait for it within its own budget (asserted at
    // module load to cover the steps it follows); a timeout is deliberately not
    // answered here — the caller's own assertion must still fail on the same
    // sentence when the seam is genuinely absent.
    const seamUp = await waitForSeamReady(sessionId, SEAM_READY_TIMEOUT_MS, `${label} raw write seam`);
    const seam = readSeam(sessionId);
    console.log(
      `[readings] ${label} seam liveState=${seam.liveState} writeRaw=${seam.writeRaw} ` +
        `providerSessionId=${seam.providerSessionId === null ? 'null' : 'set'} ready=${seamUp}`,
    );
    return { pid, before: readRegistration(configDir, pid), exits };
  }
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

test('a resident session can be renamed mid-turn, and its mirror moves the address before the result', { timeout: 400_000 }, async () => {
  await withLatencyHarness(async (context) => {
    const { socket, cwd, configDir, mock } = context;

    // ---------------------------------------------------------------------
    // Leg 1 — the load-bearing reading: a hand-written `rename_session` frame
    // reaches a process whose turn is still in flight and moves its address.
    // The mock answers title generation with prose, so the product's own
    // window has nothing to send and cannot be confused with this frame.
    // ---------------------------------------------------------------------
    mock.setTitleJson(false);
    mock.holdAgent();
    const probe = await openResidentTurn(
      socket,
      SESSION_PROBE,
      `${MARKER_PROBE} first turn`,
      cwd,
      configDir,
      'probe',
    );
    console.log(
      `[readings] probeUp pid=${probe.pid} attempts=${probe.exits.length} before=${JSON.stringify(probe.before)}`,
    );
    assert.notStrictEqual(probe.before?.nameSource, null, 'the probe process must register an address');

    // The turn is held open by the gate, so no `result` can exist yet. The
    // reading is printed before the assertion so that, if the seam is ever
    // absent again, the failure names which of the three conditions is missing
    // rather than only that the write did not go out.
    const completesBefore = completes(socket, SESSION_PROBE).length;
    logSeam('probe', SESSION_PROBE);
    const wrote = writeRawRename(SESSION_PROBE, PROBE_TITLE);
    assert.strictEqual(wrote, true, 'the probe process must offer a raw write seam to write the frame to');
    const moved = await waitFor(
      () => readRegistration(configDir, probe.pid)?.name === PROBE_TITLE,
      MIDTURN_TIMEOUT_MS,
      'the mid-turn rename to land in the registry',
    );
    const probeAfter = readRegistration(configDir, probe.pid);
    console.log(
      `[readings] probeMidTurn wrote=${wrote} moved=${moved} completesBefore=${completesBefore} ` +
        `completesNow=${completes(socket, SESSION_PROBE).length} after=${JSON.stringify(probeAfter)}`,
    );

    assert.strictEqual(moved, true, `the mid-turn rename must reach the registry (after=${JSON.stringify(probeAfter)})`);
    assert.strictEqual(probeAfter?.name, PROBE_TITLE, 'the registered name must be the hand-written title byte for byte');
    assert.notStrictEqual(
      probeAfter?.nameSource,
      'derived',
      `the renamed process must leave the derived rung (nameSource=${JSON.stringify(probeAfter?.nameSource)})`,
    );
    assert.strictEqual(probeAfter?.pid, probe.pid, 'the mid-turn rename must not restart the process');
    assert.strictEqual(probeAfter?.startedAt, probe.before?.startedAt, 'the process start clock must not move');
    assert.strictEqual(
      probeAfter !== null && probeAfter.nameSince !== null && probeAfter.startedAt !== null
        && probeAfter.nameSince > probeAfter.startedAt,
      true,
      `the rename must move nameSince past the process start (startedAt=${String(probeAfter?.startedAt)} ` +
        `nameSince=${String(probeAfter?.nameSince)})`,
    );
    // The turn was still open when the address moved: the gate has not been
    // released, so a `result` here would mean the turn ended some other way.
    assert.strictEqual(
      completes(socket, SESSION_PROBE).length,
      completesBefore,
      'the turn must still be in flight while the address moved',
    );

    // The turn still reaches its own `result` — the frame did not wedge it.
    mock.releaseAgent();
    await waitFor(
      () => completes(socket, SESSION_PROBE).length > completesBefore,
      TURN_TIMEOUT_MS,
      'the probe turn to reach its result after the mid-turn rename',
    );
    const probeEnd = completes(socket, SESSION_PROBE).at(-1) as Record<string, unknown>;
    console.log(`[readings] probeResult exit=${String(probeEnd.exitCode)} aborted=${String(probeEnd.aborted)}`);
    assert.strictEqual(probeEnd.exitCode === 0 && probeEnd.aborted === false, true, 'the probe turn must still complete');

    // Negative control: a sibling session of the same shape, no frame written.
    mock.holdAgent();
    const probeNeg = await openResidentTurn(
      socket,
      SESSION_PROBE_NEG,
      `${MARKER_PROBE_NEG} first turn`,
      cwd,
      configDir,
      'probe-neg',
    );
    mock.releaseAgent();
    const negBefore = readRegistration(configDir, probeNeg.pid);
    await sleep(NEGATIVE_WINDOW_MS);
    const negAfter = readRegistration(configDir, probeNeg.pid);
    const negTranscript = findTranscriptByMarker(configDir, MARKER_PROBE_NEG);
    const negTitles = titleRows(negTranscript ? readJsonLines(negTranscript) : []);
    console.log(
      `[readings] probeNeg before=${JSON.stringify(negBefore)} after=${JSON.stringify(negAfter)} ` +
        `renameFrames=${renameFrames(SESSION_PROBE_NEG).length} aiTitles=${JSON.stringify(negTitles.aiTitles)} ` +
        `window=${NEGATIVE_WINDOW_MS}ms`,
    );
    // This is the A-arm's mechanical reading: the product's own window opens on
    // this session's messages too, and a session with no `ai-title` must get no
    // frame out of it. A build that sent a name it did *not* read out of the
    // transcript — any ladder rung, a display name — would red here.
    assert.strictEqual(
      negTitles.aiTitles.length,
      0,
      `the negative control's transcript must hold no generated title (aiTitles=${JSON.stringify(negTitles.aiTitles)})`,
    );
    assert.strictEqual(
      renameFrames(SESSION_PROBE_NEG).length,
      0,
      `a session with no ai-title must write no rename frame (saw ${renameFrames(SESSION_PROBE_NEG).length})`,
    );
    assert.strictEqual(negAfter?.nameSource, 'derived', 'a sibling session nobody wrote a frame to must stay derived');
    assert.strictEqual(negAfter?.name, negBefore?.name, 'its derived name must not move');

    // ---------------------------------------------------------------------
    // Leg 2 — the window timing: with the product change, the address moves
    // onto the transcript's own ai-title while the first turn is still open.
    // ---------------------------------------------------------------------
    mock.setTitleJson(true);
    mock.holdAgent();
    const win = await openResidentTurn(
      socket,
      SESSION_WINDOW,
      `${MARKER_WINDOW} first turn`,
      cwd,
      configDir,
      'window',
    );
    console.log(`[readings] windowUp pid=${win.pid} attempts=${win.exits.length} before=${JSON.stringify(win.before)}`);

    const completesBeforeWindow = completes(socket, SESSION_WINDOW).length;
    const transcript = await waitForTitle(configDir, MARKER_WINDOW, READ_TIMEOUT_MS, 'window transcript ai-title');
    const titleSeen = transcript ? titleRows(readJsonLines(transcript)).aiTitles : [];
    console.log(
      `[readings] windowTitleSeen transcript=${transcript ? path.basename(transcript) : 'none'} ` +
        `aiTitles=${JSON.stringify(titleSeen)} completes=${completes(socket, SESSION_WINDOW).length}`,
    );
    assert.strictEqual(
      titleSeen.includes(MOCK_AI_TITLE),
      true,
      `the transcript must hold the mock's ai-title mid-turn (aiTitles=${JSON.stringify(titleSeen)})`,
    );

    const addressMoved = await waitFor(
      () => readRegistration(configDir, win.pid)?.name === MOCK_AI_TITLE,
      MIDTURN_TIMEOUT_MS,
      'the address to move onto the ai-title before the result',
    );
    const winAfter = readRegistration(configDir, win.pid);
    const transcriptAtAdoption = findTranscriptByMarker(configDir, MARKER_WINDOW);
    const titlesAtAdoption = titleRows(transcriptAtAdoption ? readJsonLines(transcriptAtAdoption) : []);
    const framesBeforeResult = renameFrames(SESSION_WINDOW).length;
    console.log(
      `[readings] windowMidTurn addressMoved=${addressMoved} completesBefore=${completesBeforeWindow} ` +
        `completesNow=${completes(socket, SESSION_WINDOW).length} renameFrames=${framesBeforeResult} ` +
        `after=${JSON.stringify(winAfter)} aiTitlesAtAdoption=${JSON.stringify(titlesAtAdoption.aiTitles)} ` +
        `customTitlesAtAdoption=${JSON.stringify(titlesAtAdoption.customTitles)} ` +
        `agentNamesAtAdoption=${JSON.stringify(titlesAtAdoption.agentNames)}`,
    );

    // AC3 — the address is in place before the first `result`.
    assert.strictEqual(
      addressMoved,
      true,
      `the address must move onto the ai-title before the result (after=${JSON.stringify(winAfter)} ` +
        `transcript=${transcriptAtAdoption ? path.basename(transcriptAtAdoption) : 'none'})`,
    );
    assert.strictEqual(winAfter?.name, MOCK_AI_TITLE, 'the registered name must be the generated title byte for byte');
    assert.notStrictEqual(
      winAfter?.nameSource,
      'derived',
      `the mirrored name must leave the derived rung (nameSource=${JSON.stringify(winAfter?.nameSource)})`,
    );
    // AC4 — not early: at adoption the transcript already holds the mirrored
    // title, so the frame provably went out after the title was written.
    assert.strictEqual(
      titlesAtAdoption.aiTitles.includes(MOCK_AI_TITLE),
      true,
      `the frame must go out only once the transcript holds the title ` +
        `(aiTitles=${JSON.stringify(titlesAtAdoption.aiTitles)})`,
    );
    assert.strictEqual(
      mirroredTitle(SESSION_WINDOW),
      titlesAtAdoption.aiTitles.at(-1),
      `the frame's title must be the transcript's own newest title byte for byte ` +
        `(frame=${JSON.stringify(mirroredTitle(SESSION_WINDOW))} transcript=${JSON.stringify(titlesAtAdoption.aiTitles.at(-1))})`,
    );
    assert.strictEqual(
      titlesAtAdoption.aiTitles.includes(SECOND_AI_TITLE),
      false,
      `no title the mock never sent may appear (aiTitles=${JSON.stringify(titlesAtAdoption.aiTitles)})`,
    );
    // The turn must still be open: the gate has not been released, so a `result`
    // here would mean the window only fired because the turn had ended.
    assert.strictEqual(
      completes(socket, SESSION_WINDOW).length,
      completesBeforeWindow,
      'the first-turn result must not have arrived yet',
    );
    assert.strictEqual(framesBeforeResult, 1, `exactly one rename frame must be written (saw ${framesBeforeResult})`);
    // AC6 — the side effects are clamped, both rungs. The two "must append"
    // lines make the clamps below non-vacuous: the rename writes a
    // `custom-title` *and* an `agent-name`, measured, so an `every` over an
    // empty list would pass while proving nothing.
    assert.ok(
      titlesAtAdoption.customTitles.length > 0,
      `the rename must append a custom-title for the clamp to read ` +
        `(customTitles=${JSON.stringify(titlesAtAdoption.customTitles)})`,
    );
    assert.ok(
      titlesAtAdoption.agentNames.length > 0,
      `the rename must append an agent-name for the clamp to read ` +
        `(agentNames=${JSON.stringify(titlesAtAdoption.agentNames)})`,
    );
    assert.strictEqual(
      titlesAtAdoption.customTitles.every((title) => title === MOCK_AI_TITLE),
      true,
      `every custom-title must be byte-equal to the mirrored value ` +
        `(customTitles=${JSON.stringify(titlesAtAdoption.customTitles)})`,
    );
    assert.strictEqual(
      titlesAtAdoption.agentNames.every((name) => name === MOCK_AI_TITLE),
      true,
      `every agent-name must be byte-equal to the mirrored value ` +
        `(agentNames=${JSON.stringify(titlesAtAdoption.agentNames)})`,
    );

    // Let the first turn finish, then a second round: the same title is appended
    // again and no second frame is written.
    mock.releaseAgent();
    await waitFor(
      () => completes(socket, SESSION_WINDOW).length > completesBeforeWindow,
      TURN_TIMEOUT_MS,
      'the window turn to reach its result',
    );
    const winEnd = completes(socket, SESSION_WINDOW).at(-1) as Record<string, unknown>;
    assert.strictEqual(winEnd.exitCode === 0 && winEnd.aborted === false, true, 'the window turn must complete');

    const second = await sendRound(socket, SESSION_WINDOW, `${MARKER_WINDOW} second turn`, cwd);
    await sleep(2_000);
    const afterSecond = readRegistration(configDir, win.pid);
    const titlesAfterSecond = titleRows(transcript ? readJsonLines(transcript) : []);
    console.log(
      `[readings] windowOnce exit=${String(second.frame.exitCode)} renameFrames=${renameFrames(SESSION_WINDOW).length} ` +
        `aiTitlesAfter=${JSON.stringify(titlesAfterSecond.aiTitles)} name=${JSON.stringify(afterSecond?.name)}`,
    );
    assert.strictEqual(second.frame.exitCode === 0 && second.frame.aborted === false, true, 'the second round must complete');
    assert.strictEqual(
      renameFrames(SESSION_WINDOW).length,
      1,
      `a later round must not write a second rename frame (saw ${renameFrames(SESSION_WINDOW).length})`,
    );
    assert.strictEqual(afterSecond?.name, MOCK_AI_TITLE, 'the name must stay where adoption put it');
    assert.strictEqual(afterSecond?.nameSince, winAfter?.nameSince, 'a second frame would have moved nameSince again');
    assert.strictEqual(
      titlesAfterSecond.agentNames.every((name) => name === MOCK_AI_TITLE),
      true,
      `later rounds must not append an unclamped agent-name (agentNames=${JSON.stringify(titlesAfterSecond.agentNames)})`,
    );

    // ---------------------------------------------------------------------
    // AC5 — the bound is neither always-green nor always-red.
    // ---------------------------------------------------------------------
    // Positive control: hide a seam that is really ready for
    // POSITIVE_CONTROL_DELAY_MS. A wait that did not actually wait would answer
    // false at once and the real write below would fail; the wait holding until
    // the delay passes and the write then succeeding is what proves the bound
    // outlasts its work. The session behind the injected gate is the live
    // window session, so the driver underneath is the real one.
    {
      const real = seamReader;
      const started = Date.now();
      const gateUntil = started + POSITIVE_CONTROL_DELAY_MS;
      seamReader = (id) => (Date.now() < gateUntil
        ? { liveState: false, writeRaw: false, providerSessionId: null }
        : real(id));
      try {
        const ready = await waitForSeamReady(SESSION_WINDOW, SEAM_READY_TIMEOUT_MS, 'positive-control delayed seam');
        const waited = Date.now() - started;
        console.log(
          `[readings] positiveControl seamReady=${ready} injectedDelayMs=${POSITIVE_CONTROL_DELAY_MS} waitedMs=${waited}`,
        );
        assert.strictEqual(ready, true, 'the bounded seam wait must outlast an injected late seam');
        const lateWrote = writeRawRename(SESSION_WINDOW, PROBE_TITLE);
        console.log(`[readings] positiveControl afterWait wrote=${lateWrote}`);
        assert.strictEqual(lateWrote, true, 'the real seam must be writable once the bounded wait has held');
      } finally {
        seamReader = real;
      }
    }

    // Negative control: a seam that never appears must not be reported ready.
    // With the reader forced absent, the wait must time out and answer false,
    // so the fix cannot turn "no seam" into a pass. (Its production form — a
    // process shape that never emits the id — reds at the probe assertion; the
    // mutation reading is in `## Evidence`.)
    {
      const real = seamReader;
      seamReader = () => ({ liveState: false, writeRaw: false, providerSessionId: null });
      try {
        const ready = await waitForSeamReady(SESSION_PROBE, NEGATIVE_CONTROL_WAIT_MS, 'negative-control absent seam');
        console.log(`[readings] negativeControl seamReady=${ready} budgetMs=${NEGATIVE_CONTROL_WAIT_MS}`);
        assert.strictEqual(ready, false, 'a seam that never appears must not be reported ready');
      } finally {
        seamReader = real;
      }
    }

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    assert.ok(measured < BUDGET_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});

/** Polls for the transcript of a marker and whether it holds an ai-title. */
async function waitForTitle(
  configDir: string,
  marker: string,
  timeoutMs: number,
  label: string,
): Promise<string | null> {
  let file: string | null = null;
  const held = await waitFor(() => {
    const candidate = findTranscriptByMarker(configDir, marker);
    if (!candidate) {
      return false;
    }
    file = candidate;
    return titleRows(readJsonLines(candidate)).aiTitles.length > 0;
  }, timeoutMs, label);
  return held ? file : findTranscriptByMarker(configDir, marker);
}
