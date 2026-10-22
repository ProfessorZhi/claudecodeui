/**
 * AC-163 criterion — a message sent while a resident session is busy.
 *
 * A resident host holds one CLI across turns, and the CLI's own input queue is
 * what makes the mode usable: a message typed while a turn is running must be
 * taken by the process, run afterwards as a turn of its own, and be withdrawable
 * until the process starts on it. The three behaviours the CLI already has
 * (measured on the real binary — `docs/proposals/claude-resident-sessions-experiments.md`
 * §9) are:
 *
 * 1. A busy message is not refused. It is written into the process's stdin
 *    immediately, under the `later` tier, and it is the CLI — not the server —
 *    that holds it until the turn in flight ends.
 * 2. It is not merged into the turn in flight either: the CLI runs it as a turn
 *    of its own afterwards. The write is still earlier than the current turn's
 *    `result`, which is exactly what "written into the queue, not into the
 *    turn" means as a measurement.
 * 3. A message still in the queue can be taken back. The withdrawal is judged by
 *    the queue's own account of it — a `command_lifecycle state=cancelled` event
 *    — and never by a control response, because `cancel_async_message` is
 *    answered by none at any of the three timings (still queued, already
 *    dequeued, uuid that never existed).
 *
 * The scenario below drives all three on one real resident process (a real
 * `claude` binary, an Anthropic-compatible endpoint standing in for the model,
 * a temporary `DATABASE_PATH`) through the real `chat.send` path. The mock
 * *holds* its answers, which is the only way to have a turn be in flight while
 * the criterion is looking at it:
 *
 * - Round one is a real `chat.send` that asks for a background `Bash` call, so
 *   the process has work running behind it and can later open a turn of its own.
 *   Its agent request is held, so leg 1's busy send lands while a user round is
 *   genuinely running.
 * - Leg 2's busy send lands while the *unattended* turn — the one the process
 *   opened for itself when that background work finished — is running.
 * - A third message is withdrawn while it is still queued (its text must appear
 *   in no turn's request at all), and the first message is withdrawn after the
 *   process has already started it (which must be reported as such, with no
 *   cancelled event and no effect on the process).
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a resident lifecycle that hangs is a budget kill
 *   with its own reading, as in the sibling resident criteria.
 * - Every reading is taken before anything is asserted, so a red lands on the
 *   reading that is wrong rather than on a timeout or on an earlier leg.
 * - The five fake forms this criterion is graded against each have an arm below
 *   that drives the *same* named assertion the real leg drives, so an assertion
 *   with a hole would pass the mutant and the arm would report it.
 * - Turn boundaries and turn identity are read from the request bodies'
 *   **byte size** (`bytes > 10KB`), never from a request's ordinal and never from
 *   whether a body carries user text: every turn first sends a ~2KB preflight
 *   that would be indistinguishable from a real turn by either of those.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  providerModelsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  providerRoutes,
  providerRegistry,
  createProviderRuntimeService,
} from '@/modules/providers/index.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { ClaudeResidentHostDriver } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CRITERION_PATH = 'server/modules/providers/tests/claude-resident-busy-input.test.ts';

const SESSION_ID = 'claude-resident-busy-input-session';
/** A second session on the same database, deliberately left at the default mode. */
const PER_RUN_SESSION_ID = 'claude-resident-busy-input-per-run-session';
/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'resident-busy-input-custom-model';
const MODEL_SECRET = 'resident-busy-input-model-row-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** Round one: the turn that leaves background work running behind it. */
const ROUND_ONE_TEXT = 'AC163-ROUND-ONE start the watch with Bash run_in_background';
/** Leg 1's busy message: sent while round one is in flight, run as its own turn. */
const MESSAGE_IN_USER_ROUND = 'AC163-QUEUED-DURING-USER-ROUND';
/** Leg 2's busy message: sent while the unattended turn is in flight. */
const MESSAGE_IN_UNATTENDED = 'AC163-QUEUED-DURING-UNATTENDED';
/** The message withdrawn while it is still in the queue. It must run nowhere. */
const MESSAGE_WITHDRAWN = 'AC163-WITHDRAWN-BEFORE-DEQUEUE';
/** Sent twice back-to-back to a per-run session, which must refuse the second. */
const PER_RUN_TEXT = 'AC163-PER-RUN-BUSY';

const ROUND_ONE_ACK = 'AC163_ROUND_ONE_ACK';
const MESSAGE_IN_USER_ROUND_ACK = 'AC163_ACK_USER_ROUND_TURN';
const UNATTENDED_ACK = 'AC163_ACK_UNATTENDED_TURN';
const MESSAGE_IN_UNATTENDED_ACK = 'AC163_ACK_UNATTENDED_QUEUED_TURN';
const PER_RUN_ACK = 'AC163_ACK_PER_RUN_TURN';
const BACKGROUND_SENTINEL = 'AC163_BACKGROUND_DONE';

/** The tier a busy write must carry. `later` is what makes it wait for the turn in flight. */
const EXPECTED_PRIORITY = 'later';

/** Real agent turns are recognised by the request body's size, and by nothing else. */
const REAL_TURN_MIN_BYTES = 10 * 1024;

/**
 * How long any one wait is given.
 *
 * Bounded well below the process budget: the waits a world *without* the
 * behaviour has to sit through are the ones that matter, and if they added up to
 * the budget the guard would kill the process before the leg that measures the
 * loss had said anything — a red nobody can attribute.
 */
const WAIT_MS = 10_000;
/** How long the cancel path is given to reach its verdict (the driver's own bound is shorter). */
const CANCEL_WAIT_MS = 8_000;

/**
 * The process budget, and the whole point of it being process-level.
 *
 * node:test's `timeout` option turns a slow case into a case failure; this
 * criterion is graded on the graded invocation exiting cleanly inside a minute,
 * so the budget is enforced by the process itself and printed with the measured
 * wall clock when it fires.
 */
const BUDGET_MS = Number(process.env.CLAUDE_RESIDENT_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_RESIDENT_BUDGET_MS)
  : 60_000;
/** The wall clock starts at import, so `elapsed` covers module load as well as the legs. */
const STARTED_AT = Date.now();
/** The bound the criterion itself reports against, in milliseconds. */
const ELAPSED_LIMIT_MS = 58_000;

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the busy-input scenario did not finish ` +
      `inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, BUDGET_MS);
// Unref'd so the guard cannot itself hold the process open for the full budget
// once every case has finished.
budgetGuard.unref();

type Received = {
  url: string;
  body: string;
  bytes: number;
  authorization: string | undefined;
  apiKey: string | undefined;
};

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  /**
   * Holds every real agent request from `index` on instead of answering it.
   *
   * The threshold is an index rather than a flag because the scenario needs one
   * turn released at a time: each leg's busy send has to land while a *specific*
   * turn is running, and the only way to hold a turn open is to hold its own
   * agent request.
   */
  holdFrom(index: number): void;
  /** Answers every request this mock is currently holding, in arrival order. */
  releaseHeld(): void;
  /** How many real agent requests have arrived (held or answered). */
  realCount(): number;
  /** How many real agent requests are held right now. */
  heldCount(): number;
  /** The real agent requests' body sizes, in arrival order. */
  realBytes(): number[];
  /** Every `/v1/messages` body size, in arrival order — turns and preflights alike. */
  allBytes(): number[];
  close(): Promise<void>;
};

/** A request is a real agent turn when its body is over the size a turn really carries. */
function isRealTurn(request: Received): boolean {
  return request.url.split('?')[0] === '/v1/messages' && request.bytes > REAL_TURN_MIN_BYTES;
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A minimal valid streaming `/v1/messages` reply carrying `text`. */
function textStream(text: string): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** A reply that asks for one `Bash` call, backgrounded or not. */
function bashToolStream(command: string, background: boolean): string {
  const partial = JSON.stringify(
    background
      ? { command, run_in_background: true, description: 'watch for the trigger file' }
      : { command, run_in_background: false, description: 'step through the turn' },
  );
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_tool', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ac163_bg', name: 'Bash', input: {} },
    }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * An Anthropic-compatible endpoint that answers the conversation this criterion
 * drives, and records what it was sent.
 *
 * Real agent turns are counted and answered **by position among real turns**,
 * where "real" is the body-size rule and nothing else. Position is what decides
 * *what* to answer (a turn's body accumulates the whole conversation, so it
 * cannot say which turn it is); size is what decides *whether* it is a turn at
 * all (the SDK's auxiliary prompts post to the same path with the same
 * credential and carry a couple of kilobytes). The first asks for the background
 * `Bash`, the second closes round one, the third is the queued message's own
 * turn, the fourth is the turn the process opened by itself, the fifth is the
 * second queued message's turn, and anything after that is the per-run control
 * session, which only needs an answer.
 */
async function startMockAnthropic(triggerFile: string): Promise<MockAnthropic> {
  const received: Received[] = [];
  const held: Array<{ body: string; answer: () => void }> = [];
  let holdFromIndex = Number.POSITIVE_INFINITY;
  let realCount = 0;

  const responderFor = (index: number, payload: string): string => {
    switch (index) {
      case 1:
        return bashToolStream(`while [ ! -f ${triggerFile} ]; do sleep 0.1; done; echo ${BACKGROUND_SENTINEL}`, true);
      case 2:
        return textStream(ROUND_ONE_ACK);
      case 3:
        return textStream(MESSAGE_IN_USER_ROUND_ACK);
      case 4:
        return textStream(UNATTENDED_ACK);
      case 5:
        return textStream(MESSAGE_IN_UNATTENDED_ACK);
      default:
        return textStream(PER_RUN_ACK);
    }
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      const bytes = Buffer.byteLength(body);
      const entry: Received = {
        url,
        body,
        bytes,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      };
      received.push(entry);

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

      if (!isRealTurn(entry)) {
        answer(textStream('aux ok'));
        return;
      }

      realCount += 1;
      const payload = responderFor(realCount, body);
      if (realCount >= holdFromIndex) {
        held.push({ body, answer: () => answer(payload) });
        return;
      }
      answer(payload);
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    holdFrom: (index) => { holdFromIndex = index; },
    releaseHeld: () => {
      for (const entry of held.splice(0)) {
        entry.answer();
      }
    },
    realCount: () => realCount,
    heldCount: () => held.length,
    realBytes: () => received.filter(isRealTurn).map((request) => request.bytes),
    allBytes: () => received.filter((request) => request.url.split('?')[0] === '/v1/messages').map((r) => r.bytes),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

type FakeSocket = EventEmitter & {
  readyState: number;
  OPEN: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

/**
 * A websocket stand-in for the chat protocol.
 *
 * `frames` is what the server sent, parsed. `readyState` is writable so a socket
 * can be represented as open for the whole scenario without a real handshake;
 * the chat handler's own `send` guard reads it.
 */
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Polls a predicate and answers whether it held, without failing the case. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  console.log(`[readings] waitFor timed out after ${timeoutMs}ms: ${label}`);
  return false;
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

/** Counts the import edges from one file to the websocket module. */
function websocketImports(relativePath: string): number {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  return source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line) && line.includes('modules/websocket')).length;
}

type Harness = {
  socket: FakeSocket;
  userId: number;
  cwd: string;
  triggerFile: string;
  mock: MockAnthropic;
  /** The production dispatch, so the withdrawals below go through the same seam `chat.send` does. */
  runtime: ReturnType<typeof createProviderRuntimeService>;
};

/**
 * The harness this criterion runs inside: temp database, temp Claude config, the
 * project settings file the sibling resident criterion runs under, and the
 * production dispatch.
 *
 * The runtime is the production `createProviderRuntimeService()`, so both the
 * turns and the withdrawals are routed by the same `lifecycle_mode` read the
 * chat handler performs. The provider routes are mounted because the sibling
 * criterion establishes the same shape and the session table is what the
 * dispatch reads.
 */
async function withBusyHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-busy-'));
  const configDir = path.join(tempDirectory, 'claude-config');
  const triggerFile = path.join(tempDirectory, 'ac163-trigger');
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  // The same project settings the sibling resident criterion installs. Kept
  // verbatim rather than dropped: the criterion measures the CLI's own busy-input
  // behaviour, and it must be measuring it under the configuration that behaviour
  // was established in, not under a leaner one this file invented.
  await mkdir(path.join(tempDirectory, '.claude'), { recursive: true });
  await writeFile(
    path.join(tempDirectory, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `cat >> ${path.join(tempDirectory, 'stop-hooks.jsonl')}` }] }] } }),
  );

  const mock = await startMockAnthropic(triggerFile);
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
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser('claude-resident-busy', 'unused-hash');

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Resident busy-input session', now, now, null);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    // The control session is deliberately left at the stored default, which is
    // what makes its refusal the pre-existing behaviour rather than a choice.
    sessionsDb.createSession(PER_RUN_SESSION_ID, 'claude', tempDirectory, 'Per-run control session', now, now, null);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(PER_RUN_SESSION_ID);
    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });
    assert.strictEqual(sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident'), true);
    assert.strictEqual(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');
    assert.strictEqual(sessionsDb.getSessionLifecycleMode(PER_RUN_SESSION_ID), 'per-run');

    // The composition root's one line, reproduced here for the same reason the
    // sibling resident criterion reproduces it: this criterion runs the harness,
    // not the process entry point, and without the seam the process's own turn
    // has nowhere to open a run — which is precisely the turn leg 2 is sent
    // during, so the leg could not be driven at all without it.
    sessionHostManager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));

    const socket = createFakeSocket();
    const runtime = createProviderRuntimeService();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    await run({
      socket,
      userId: Number(user.id),
      cwd: tempDirectory,
      triggerFile,
      mock,
      runtime,
    });
  } finally {
    sessionHostManager.setUnattendedRunOpener(null);
    const killHosts = (): void => {
      for (const host of sessionHostManager.snapshot()) {
        if (host.pid && existsSync(`/proc/${host.pid}`)) {
          try {
            process.kill(host.pid, 'SIGKILL');
          } catch {
            // Already gone between the check and the kill.
          }
        }
      }
    };
    // Killed *before* the hosts are closed on purpose. Closing a host ends its
    // input and then waits out the resident exit grace (~15s) for the CLI to
    // leave on its own; that wait is per host and the whole teardown would
    // otherwise outlast the process budget, so the budget guard would `exit 3`
    // while the teardown was still running and the red would land on the budget
    // rather than on the reading. The readings are all taken before this point
    // — nothing here is being measured — so the abrupt exit costs nothing.
    killHosts();
    for (const host of sessionHostManager.snapshot()) {
      if (host.state !== 'closed') {
        sessionHostManager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    killHosts();
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

/** The host driver this criterion reads its readings off. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

/** The session's reading, or null when the driver is hosting nothing for it. */
function busyReading(): ReturnType<ClaudeResidentHostDriver['busyInputReading']> {
  return residentDriver().busyInputReading(SESSION_ID);
}

/** Sends one `chat.send` and answers with the protocol error code it produced, if any. */
function send(socket: FakeSocket, sessionId: string, content: string, cwd: string): string | null {
  const before = socket.frames.length;
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'bypassPermissions' },
  }));
  // `dispatchRun` refuses before its first await, so the refusal — or its
  // absence — is already on the socket when `emit` returns. A busy send that is
  // accepted produces no frame at all here, which is the reading.
  const refusal = socket.frames
    .slice(before)
    .find((frame) => frame.kind === 'protocol_error' && frame.sessionId === sessionId);
  return typeof refusal?.code === 'string' ? refusal.code : null;
}

/** Asks the server to withdraw one queued message and answers with its verdict frame. */
async function requestWithdrawal(
  socket: FakeSocket,
  messageUuid: string,
): Promise<Record<string, unknown> | null> {
  const before = socket.frames.length;
  socket.emit('message', JSON.stringify({
    type: 'chat.cancel-queued',
    sessionId: SESSION_ID,
    messageUuid,
    // The gateway requires a request id on this verb (AC-198's rework): without
    // one the withdrawal is refused with REQUEST_ID_REQUIRED before it reaches
    // the queue, so a real client always sends one and so must this one.
    requestId: `withdraw-${messageUuid}`,
  }));
  await waitFor(
    () => socket.frames.slice(before).some((frame) => frame.kind === 'queued_input_cancel_result'),
    CANCEL_WAIT_MS,
    `the withdrawal verdict for ${messageUuid}`,
  );
  return (
    socket.frames
      .slice(before)
      .find((frame) => frame.kind === 'queued_input_cancel_result') ?? null
  );
}

/** The first real turn (1-based) whose request body carries `text`, or null. */
function firstTurnCarrying(mock: MockAnthropic, text: string): number | null {
  let index = 0;
  for (const request of mock.received) {
    if (!isRealTurn(request)) {
      continue;
    }
    index += 1;
    if (request.body.includes(text)) {
      return index;
    }
  }
  return null;
}

/** Whether any real turn's request body carries `text`. */
function anyTurnCarrying(mock: MockAnthropic, text: string): boolean {
  return mock.received.some((request) => isRealTurn(request) && request.body.includes(text));
}

/** The body of the `index`-th (1-based) real turn, or null when there is no such turn. */
function realTurnBody(mock: MockAnthropic, index: number): string | null {
  const bodies = mock.received.filter(isRealTurn).map((request) => request.body);
  return bodies[index - 1] ?? null;
}

/**
 * Whether the frames the socket received from `from` that carry `text` also carry
 * a numeric `seq`.
 *
 * A `seq` is stamped by `ChatRunRegistry.decorateAndRecordEvent` and by nothing
 * else, so a frame that has one was recorded *in a run*. That is the measurable
 * half of "the message is recorded in the run of the turn it started": the
 * frames of that turn really went through a run's writer rather than reaching
 * the socket by some other path.
 */
function carryingFramesAreRecorded(socket: FakeSocket, from: number, text: string): boolean {
  const carrying = framesFrom(socket, from).filter((frame) => JSON.stringify(frame).includes(text));
  return carrying.length > 0 && carrying.every((frame) => typeof frame.seq === 'number');
}

/** The same reading as a printed line: how many frames carry the text, and their kinds/seq. */
function carryingFrameReport(socket: FakeSocket, from: number, text: string): string {
  const carrying = framesFrom(socket, from).filter((frame) => JSON.stringify(frame).includes(text));
  return (
    `count=${carrying.length} withSeq=${carrying.filter((frame) => typeof frame.seq === 'number').length} ` +
    `kinds=${JSON.stringify(carrying.map((frame) => `${String(frame.kind)}:${typeof frame.seq}`))}`
  );
}

/** Every terminal `complete` frame the socket received, in arrival order. */
function completes(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => frame.kind === 'complete');
}

/** Every frame the socket received after `from`, in arrival order. */
function framesFrom(socket: FakeSocket, from: number): Array<Record<string, unknown>> {
  return socket.frames.slice(from);
}

// ---------------------------
//----------------- THE READINGS, AS NAMED ASSERTIONS ------------
/**
 * The readings the five fake forms are aimed at, each as a named function.
 *
 * Factoring them out is what makes a fake form load-bearing rather than
 * decorative: the mutant drives the *same* assertion the real arm does, so a
 * mutation the arm could not see would pass and the case would report a hole
 * rather than a pass.
 */
type BusySendReading = { leg: string; code: string | null };

/** (1) A message sent while a turn is running must be accepted, on both legs. */
function assertBusySendNotRefused(sends: BusySendReading[]): void {
  assert.ok(sends.length >= 2, `both legs must have sent while busy (sends=${sends.length})`);
  for (const send of sends) {
    assert.strictEqual(
      send.code,
      null,
      `a message sent while the ${send.leg} turn was in flight must not be refused (code=${String(send.code)})`,
    );
  }
}

type WriteTimingReading = {
  leg: string;
  uuid: string;
  priority: string | null;
  writeAt: number;
  turnResultAt: number;
  before: boolean;
  lifecycleUuid: string | null;
};

/**
 * (2) The frame was written into the process's stdin before the turn in flight
 * ended, under the `later` tier, and the uuid the host stamped it with is the
 * uuid the CLI reports for it.
 */
function assertWrittenBeforeTurnEnd(readings: WriteTimingReading[]): void {
  assert.ok(readings.length >= 2, `both legs must have a write-timing reading (readings=${readings.length})`);
  for (const entry of readings) {
    assert.ok(
      entry.before,
      `the ${entry.leg} message must be written before the turn in flight ends ` +
        `(writeAt=${entry.writeAt} turnResultAt=${entry.turnResultAt})`,
    );
    assert.ok(
      entry.writeAt < entry.turnResultAt,
      `the ${entry.leg} write moment must precede the turn's result ` +
        `(writeAt=${entry.writeAt} turnResultAt=${entry.turnResultAt})`,
    );
    assert.strictEqual(
      entry.priority,
      EXPECTED_PRIORITY,
      `the ${entry.leg} frame must carry the ${EXPECTED_PRIORITY} tier (got ${String(entry.priority)})`,
    );
    assert.ok(entry.uuid.length > 0, `the ${entry.leg} frame must carry a server-assigned uuid`);
    assert.strictEqual(
      entry.lifecycleUuid,
      entry.uuid,
      `the ${entry.leg} frame's uuid must be the CLI's own command uuid for it ` +
        `(host=${entry.uuid} cli=${String(entry.lifecycleUuid)})`,
    );
  }
}

type LandingReading = {
  leg: string;
  text: string;
  /** 1-based index of the real turn whose request body first carries the message, or null. */
  turnIndex: number | null;
  /** The real turn that was in flight when the message was sent, 1-based. */
  inFlightTurnIndex: number;
  textPresentInCurrentTurn: boolean;
  runAppSessionId: string | null;
  messageInRun: boolean;
};

/**
 * (3) The message is not lost and not merged into the turn that was running: it
 * appears in a turn of its own afterwards, and it is recorded in that turn's run.
 *
 * The ordering half (`turnIndex > inFlightTurnIndex`) is the one a reader that
 * delimits turns by `session_state_changed` cannot make: that event never
 * arrives (E9 §9.1), so such a reader finds no turn boundary at all, cannot tell
 * a later turn from the one in flight, and reads the message as either missing
 * or merged. It is therefore the assertion the (e) fake form has to red.
 */
function assertLandedInLaterTurn(readings: LandingReading[]): void {
  assert.ok(readings.length >= 2, `both legs must have a landing reading (readings=${readings.length})`);
  for (const entry of readings) {
    assert.ok(
      entry.turnIndex !== null,
      `the ${entry.leg} message must appear in a real turn's request body (text=${entry.text})`,
    );
    assert.ok(
      entry.turnIndex > entry.inFlightTurnIndex,
      `the ${entry.leg} message must land in a turn *after* the one that was in flight ` +
        `(messageTurn=${entry.turnIndex} inFlightTurn=${entry.inFlightTurnIndex})`,
    );
    assert.strictEqual(
      entry.textPresentInCurrentTurn,
      false,
      `the ${entry.leg} message must not be in the turn that was in flight when it was sent`,
    );
    assert.strictEqual(
      entry.runAppSessionId,
      SESSION_ID,
      `the ${entry.leg} message must be recorded in a run keyed by the app session id ` +
        `(got ${String(entry.runAppSessionId)})`,
    );
    assert.strictEqual(
      entry.messageInRun,
      true,
      `the ${entry.leg} message must be recorded in the run of the turn it started`,
    );
  }
}

/**
 * (4a) A withdrawal that works: the control frame really went out, the queue
 * really cancelled that uuid, the text never reached any turn, and the verdict
 * is read off the queue's account — not off a control response, of which the CLI
 * sends none for this request.
 */
function assertWithdrawnWhileQueued(readings: Array<{
  text: string;
  controlFrameWritten: boolean;
  cancelledSeen: boolean;
  textInAnyTurn: boolean;
  result: string;
  controlResponsesForCancel: number;
}>): void {
  for (const entry of readings) {
    assert.strictEqual(
      entry.controlFrameWritten,
      true,
      'the withdrawal must really write a cancel_async_message control frame',
    );
    assert.strictEqual(entry.cancelledSeen, true, 'the queue must report the withdrawn uuid as cancelled');
    assert.strictEqual(
      entry.textInAnyTurn,
      false,
      `the withdrawn message must not reach any turn (text=${entry.text})`,
    );
    assert.strictEqual(entry.result, 'withdrawn', `a queued message must be reported withdrawn (got ${entry.result})`);
    assert.strictEqual(
      entry.controlResponsesForCancel,
      0,
      'the verdict must not depend on a control response, and the CLI sends none for this request',
    );
  }
}

/**
 * (4b) A withdrawal that cannot work: no cancelled event is read, the verdict
 * says the process had already started the message, and the process is untouched
 * — same pid, and still producing turns afterwards.
 */
function assertWithdrawalAfterDequeue(readings: Array<{
  cancelledEvents: number;
  result: string;
  pidBefore: number | null;
  pidAfter: number | null;
  laterResult: boolean;
}>): void {
  for (const entry of readings) {
    assert.strictEqual(entry.cancelledEvents, 0, 'a message the process already started must produce no cancelled event');
    assert.strictEqual(
      entry.result,
      'already-started',
      `a message the process already started must be reported as such (got ${entry.result})`,
    );
    assert.ok(entry.pidBefore !== null, 'the reading must carry the host pid');
    assert.strictEqual(entry.pidAfter, entry.pidBefore, 'the withdrawal must not touch the process');
    assert.strictEqual(entry.laterResult, true, 'the process must still produce turns after the withdrawal');
  }
}

/**
 * (e) The turn boundary. `session_state_changed` is not a boundary source: E9
 * measured zero of them on both drivers, so a reader that waited for one would
 * never see the later turn that carries the queued message.
 */
function assertTurnBoundaryReadable(boundaries: number): void {
  assert.ok(boundaries > 0, `the turn boundary must be readable from the stream (boundaries=${boundaries})`);
}

// ---------------------------
//----------------- THE SCENARIO ------------
test('busy input is queued, run as its own turn, and withdrawable until it starts', { timeout: 180_000 }, async () => {
  const elapsed = () => `${Date.now() - STARTED_AT}ms`;
  /** The verdict a reader that trusted control responses would compute for this run. */
  const verdictFromControlResponse = (controlResponsesForCancel: number): string =>
    controlResponsesForCancel > 0 ? 'withdrawn' : 'unknown';

  await withBusyHarness(async ({ socket, cwd, triggerFile, mock, runtime }) => {
    // -------------------------------------------------------------------
    // Leg 1 — a message sent while a user round is in flight.
    // -------------------------------------------------------------------
    mock.holdFrom(1);
    const sendsStart = socket.frames.length;
    const roundOneRefusal = send(socket, SESSION_ID, ROUND_ONE_TEXT, cwd);
    const roundOneInFlight = await waitFor(
      () => mock.heldCount() >= 1,
      WAIT_MS,
      'round one\'s agent request to be in flight and held',
    );
    console.log(`[readings] roundOneInFlight=${roundOneInFlight} roundOneRefusal=${String(roundOneRefusal)}`);

    // The turn in flight, counted among the real turns the mock has seen. Round
    // one is held, so it is turn 1 and it is the only real turn there is.
    const inFlightTurnAtLeg1 = mock.realCount();
    const userRoundRefusal = send(socket, SESSION_ID, MESSAGE_IN_USER_ROUND, cwd);
    // The run the send opened for this message. `dispatchRun` starts it before its
    // first await, so it is the session's current run the moment `send` returns;
    // the message's own turn is held open, so nothing can have replaced it yet.
    const leg1RunAppSessionId = chatRunRegistry.getRun(SESSION_ID)?.appSessionId ?? null;

    // The message withdrawn while still queued goes in behind it, in the same
    // turn's queue: nothing has been released yet, so both are queued and the
    // withdrawal below is unambiguously a queued one.
    const withdrawnSendRefusal = send(socket, SESSION_ID, MESSAGE_WITHDRAWN, cwd);

    const queued = await waitFor(
      () => (busyReading()?.queuedInputs.length ?? 0) >= 2,
      WAIT_MS,
      'both busy frames to be written into the process',
    );
    const readingAfterSends = busyReading();
    assert.ok(readingAfterSends, 'the resident host must be live and holding the queued frames');
    assert.strictEqual(queued, true, 'both busy frames must be recorded as written while busy');

    const userRoundInput = readingAfterSends.queuedInputs.find(
      (input) => JSON.stringify(input.frame).includes(MESSAGE_IN_USER_ROUND),
    );
    const withdrawnInput = readingAfterSends.queuedInputs.find(
      (input) => JSON.stringify(input.frame).includes(MESSAGE_WITHDRAWN),
    );
    assert.ok(userRoundInput, 'the leg-1 frame must be readable with its own uuid');
    assert.ok(withdrawnInput, 'the withdrawal target must be readable with its own uuid');

    // (4a) The withdrawal of a message that is still in the queue.
    const controlFramesBefore = readingAfterSends.controlFrames.length;
    const withdrawnVerdict = await requestWithdrawal(socket, withdrawnInput.uuid);
    const withdrawnReading = busyReading();

    // -------------------------------------------------------------------
    // Round one ends, and the queued message runs as a turn of its own.
    // -------------------------------------------------------------------
    mock.holdFrom(2);
    mock.releaseHeld();
    const roundOneContinued = await waitFor(() => mock.realCount() >= 2, WAIT_MS, 'round one\'s continuation');
    mock.holdFrom(3);
    mock.releaseHeld();
    const queuedTurnStarted = await waitFor(
      () => mock.realCount() >= 3,
      WAIT_MS,
      'the queued message\'s own turn',
    );
    // The queued message's turn is held, so it is released here — and the hold is
    // moved to index 4 in the same breath so the *next* real turn (the one the
    // process will open by itself) arrives held.
    mock.holdFrom(4);
    mock.releaseHeld();
    // …and its turn has to *end* before the process can open a turn of its own:
    // the opener refuses while any round is armed, and a round is only shifted out
    // at its own `result`. Writing the trigger file first would let the background
    // task's ending race that `result`, and the unattended turn leg 2 is sent
    // during could simply never be opened — a harness race, not a reading.
    const queuedTurnEnded = await waitFor(
      () => (busyReading()?.resultTimes.length ?? 0) >= 2,
      WAIT_MS,
      'the queued message\'s turn to end',
    );
    const completionsAtQueuedTurn = completes(socket).length;
    console.log(
      `[readings] roundOneContinued=${roundOneContinued} queuedTurnStarted=${queuedTurnStarted} ` +
        `queuedTurnEnded=${queuedTurnEnded} completes=${completionsAtQueuedTurn}`,
    );

    // The frames this turn produced, and whether they were recorded in a run: a
    // frame carrying a `seq` came through a run's writer, and no other path
    // stamps one.
    const userRoundMessageInTurn = carryingFramesAreRecorded(socket, sendsStart, MESSAGE_IN_USER_ROUND_ACK);

    // -------------------------------------------------------------------
    // The process opens a turn of its own when its background work finishes.
    // -------------------------------------------------------------------
    await writeFile(triggerFile, 'go');
    const unattendedStarted = await waitFor(
      () => mock.realCount() >= 4,
      WAIT_MS,
      'the turn the process opened by itself',
    );

    // -------------------------------------------------------------------
    // Leg 2 — a message sent while that unattended turn is in flight.
    // -------------------------------------------------------------------
    const unattendedSendStart = socket.frames.length;
    const inFlightTurnAtLeg2 = mock.realCount();
    const unattendedRefusal = send(socket, SESSION_ID, MESSAGE_IN_UNATTENDED, cwd);
    const leg2RunAppSessionId = chatRunRegistry.getRun(SESSION_ID)?.appSessionId ?? null;
    const unattendedQueued = await waitFor(
      () => (busyReading()?.queuedInputs ?? []).some((input) => JSON.stringify(input.frame).includes(MESSAGE_IN_UNATTENDED)),
      WAIT_MS,
      'the leg-2 frame to be written into the process',
    );
    const readingWithUnattendedInput = busyReading();
    const unattendedInput = readingWithUnattendedInput?.queuedInputs.find(
      (input) => JSON.stringify(input.frame).includes(MESSAGE_IN_UNATTENDED),
    );
    assert.ok(unattendedInput, 'the leg-2 frame must be readable with its own uuid');

    // -------------------------------------------------------------------
    // (4b) Withdrawing the message the process already started.
    // -------------------------------------------------------------------
    const pidBefore = busyReading()?.hostPid ?? null;
    const resultsBefore = busyReading()?.resultTimes.length ?? 0;
    const startedVerdict = await requestWithdrawal(socket, userRoundInput.uuid);
    const resultsAfter = busyReading()?.resultTimes.length ?? 0;
    const pidAfter = busyReading()?.hostPid ?? null;

    // The unattended turn ends, which is both the queued message's cue to run
    // and the "the process still produces turns" half of (4b).
    mock.holdFrom(5);
    mock.releaseHeld();
    const unattendedFinished = await waitFor(
      () => (busyReading()?.resultTimes.length ?? 0) > resultsBefore,
      WAIT_MS,
      'the unattended turn to end',
    );
    const laterResult = (busyReading()?.resultTimes.length ?? 0) > resultsAfter;
    const queuedUnattendedTurn = await waitFor(
      () => mock.realCount() >= 5,
      WAIT_MS,
      'the second queued message\'s own turn',
    );
    const completionsAtUnattendedTurn = completes(socket).length;
    // The second queued message's turn is held so that the exit gate above could
    // be read while a turn was still in flight; what the reading needs now is for
    // it to run to its end, because the frames that answer for leg 2 are the ones
    // that turn produces. Releasing the hold and waiting for the turn's own
    // `result` is the same shape every earlier turn in this scenario was driven
    // with, and it keeps the reading from being taken on a turn still in flight.
    const resultsAtUnattendedQueuedTurn = busyReading()?.resultTimes.length ?? 0;
    mock.holdFrom(Number.POSITIVE_INFINITY);
    mock.releaseHeld();
    const queuedUnattendedTurnEnded = await waitFor(
      () => (busyReading()?.resultTimes.length ?? 0) > resultsAtUnattendedQueuedTurn,
      WAIT_MS,
      'the second queued message\'s own turn to end',
    );
    const unattendedMessageInTurn = carryingFramesAreRecorded(socket, unattendedSendStart, MESSAGE_IN_UNATTENDED_ACK);

    // -------------------------------------------------------------------
    // The per-run control: the same send on a session that runs a process
    // per turn must still be refused.
    //
    // Its turn is held (turn 6, the first real turn after the resident
    // session's queue is empty) for the same reason every earlier turn was: the
    // stop below has to reach a turn that is genuinely in flight. Stopping it is
    // part of the leg, not housekeeping — a per-run host is recorded with
    // `pid: null` (`trackPerRunTurn` gives the manager a binding and no child),
    // so neither the manager nor a pid kill in the teardown can reach this
    // process; `runtime.abort` is the production act that does, and a process
    // left behind holds this run's pipes open past its readings.
    // -------------------------------------------------------------------
    mock.holdFrom(6);
    const perRunStart = socket.frames.length;
    send(socket, PER_RUN_SESSION_ID, PER_RUN_TEXT, cwd);
    const perRunRefusal = send(socket, PER_RUN_SESSION_ID, PER_RUN_TEXT, cwd);
    const perRunTurnInFlight = await waitFor(
      () => mock.realCount() >= 6,
      WAIT_MS,
      'the per-run control session\'s own turn',
    );
    const perRunTurnStopped = await Promise.resolve(runtime.abort('claude', PER_RUN_SESSION_ID)).catch(() => false);
    mock.releaseHeld();
    console.log(
      `[readings] framesAfterPerRunSends=${socket.frames.length - perRunStart} ` +
        `perRunTurnInFlight=${perRunTurnInFlight} perRunTurnStopped=${perRunTurnStopped}`,
    );

    // -------------------------------------------------------------------
    // Readings — taken without asserting, so the redness of a fake form lands
    // on the reading rather than on a timeout.
    // -------------------------------------------------------------------
    const finalReading = busyReading();
    assert.ok(finalReading, 'the resident host must still be live when the readings are taken');

    const lifecycleFor = (uuid: string, state: string): string | null =>
      finalReading.lifecycle.find((event) => event.commandUuid === uuid && event.state === state)?.commandUuid ?? null;
    /** The same frame as the final reading sees it, by its uuid. */
    const finalInputFor = (uuid: string): (typeof finalReading.queuedInputs)[number] | null =>
      finalReading.queuedInputs.find((input) => input.uuid === uuid) ?? null;
    /**
     * The turn boundaries the *stream* reports: one terminal frame ends one turn
     * (a withdrawn message's turn ends with an `aborted` one). This is the
     * boundary source the `system/init` + `result` pair gives a reader, as
     * opposed to `session_state_changed`, of which E9 §9.1 measured none.
     */
    const turnBoundaries = completes(socket).length;

    const writeTimings: WriteTimingReading[] = [userRoundInput, unattendedInput].map((input, index) => {
      const leg = index === 0 ? 'user' : 'unattended';
      // Read the frame's facts off the *final* reading, never off the snapshot
      // taken at the send: `queuedBeforeResult` is only computed when the turn in
      // flight ends, so the snapshot taken while that turn was still held carries
      // `null` there and every leg would read `before=false` no matter what the
      // driver did. Falling back to the snapshot (rather than asserting here)
      // keeps the failure on the AC's own reading if a frame ever goes missing.
      const frame = finalInputFor(input.uuid) ?? input;
      return {
        leg,
        uuid: frame.uuid,
        priority: frame.priority,
        writeAt: frame.at,
        turnResultAt: finalReading.resultTimes[frame.resultsSeenAtPush] ?? Number.NaN,
        before: frame.queuedBeforeResult === true,
        lifecycleUuid: lifecycleFor(frame.uuid, 'queued'),
      };
    });

    const landings: LandingReading[] = [
      {
        leg: 'user',
        text: MESSAGE_IN_USER_ROUND,
        turnIndex: firstTurnCarrying(mock, MESSAGE_IN_USER_ROUND),
        inFlightTurnIndex: inFlightTurnAtLeg1,
        textPresentInCurrentTurn: (realTurnBody(mock, inFlightTurnAtLeg1) ?? '').includes(MESSAGE_IN_USER_ROUND),
        runAppSessionId: leg1RunAppSessionId,
        messageInRun: leg1RunAppSessionId === SESSION_ID && userRoundMessageInTurn,
      },
      {
        leg: 'unattended',
        text: MESSAGE_IN_UNATTENDED,
        turnIndex: firstTurnCarrying(mock, MESSAGE_IN_UNATTENDED),
        inFlightTurnIndex: inFlightTurnAtLeg2,
        textPresentInCurrentTurn: (realTurnBody(mock, inFlightTurnAtLeg2) ?? '').includes(MESSAGE_IN_UNATTENDED),
        runAppSessionId: leg2RunAppSessionId,
        messageInRun: leg2RunAppSessionId === SESSION_ID && unattendedMessageInTurn,
      },
    ];

    const cancelControlFrame = withdrawnReading?.controlFrames
      .slice(controlFramesBefore)
      .find((entry) => record(entry.frame.request)?.message_uuid === withdrawnInput.uuid) ?? null;
    const cancelRequestId = cancelControlFrame?.requestId ?? null;
    const controlResponsesForCancel = cancelRequestId
      ? (withdrawnReading?.controlResponses ?? []).filter((entry) => entry.requestId === cancelRequestId).length
      : 0;
    const cancelledForWithdrawn = (withdrawnReading?.lifecycle ?? []).filter(
      (event) => event.commandUuid === withdrawnInput.uuid && event.state === 'cancelled',
    ).length;

    const withdrawalReadings = [{
      text: MESSAGE_WITHDRAWN,
      controlFrameWritten: Boolean(cancelControlFrame),
      cancelledSeen: cancelledForWithdrawn > 0,
      textInAnyTurn: anyTurnCarrying(mock, MESSAGE_WITHDRAWN),
      result: typeof withdrawnVerdict?.result === 'string' ? withdrawnVerdict.result : 'no-verdict-frame',
      controlResponsesForCancel,
    }];

    const startedReadings = [{
      cancelledEvents: (busyReading()?.lifecycle ?? []).filter(
        (event) => event.commandUuid === userRoundInput.uuid && event.state === 'cancelled',
      ).length,
      result: typeof startedVerdict?.result === 'string' ? startedVerdict.result : 'no-verdict-frame',
      pidBefore,
      pidAfter,
      laterResult,
    }];

    const busySends: BusySendReading[] = [
      { leg: 'user', code: userRoundRefusal },
      { leg: 'unattended', code: unattendedRefusal },
    ];

    // -------------------------------------------------------------------
    // Printed readings.
    // -------------------------------------------------------------------
    console.log(`[readings] bytesPerTurn=${JSON.stringify(mock.allBytes())} realTurns=${mock.realBytes().length}`);
    console.log(`[readings] busySends=${JSON.stringify(busySends)}`);
    console.log(`[readings] withdrawnSendRefusal=${String(withdrawnSendRefusal)} perRunBusyCode=${String(perRunRefusal)}`);
    for (const entry of writeTimings) {
      console.log(
        `[readings] leg=${entry.leg} writeAt=${entry.writeAt} turnResultAt=${entry.turnResultAt} ` +
          `before=${entry.before} frame.uuid=${entry.uuid} frame.priority=${String(entry.priority)} ` +
          `command_lifecycle.command_uuid=${String(entry.lifecycleUuid)}`,
      );
    }
    for (const entry of landings) {
      console.log(
        `[readings] leg=${entry.leg} appearsInTurnRequest#${String(entry.turnIndex)} ` +
          `inFlightTurn#${entry.inFlightTurnIndex} textPresentInCurrentTurn=${entry.textPresentInCurrentTurn} ` +
          `run.appSessionId=${String(entry.runAppSessionId)} messageInRun=${entry.messageInRun}`,
      );
    }
    console.log(
      `[readings] turnBoundaries=${turnBoundaries} fakeBoundaries(sessionStateChanged)=${finalReading.sessionStateChanged} ` +
        `terminalsAtQueuedTurn=${completionsAtQueuedTurn} terminalsAtUnattendedTurn=${completionsAtUnattendedTurn}`,
    );
    console.log(
      `[readings] ackFrames user={${carryingFrameReport(socket, sendsStart, MESSAGE_IN_USER_ROUND_ACK)}} ` +
        `unattended={${carryingFrameReport(socket, unattendedSendStart, MESSAGE_IN_UNATTENDED_ACK)}}`,
    );
    console.log(`[readings] cancelControlFrame=${JSON.stringify(cancelControlFrame?.frame ?? null)}`);
    console.log(
      `[readings] cancelResult=${withdrawalReadings[0].result} ` +
        `command_lifecycle.state=${cancelledForWithdrawn > 0 ? 'cancelled' : 'not-cancelled'} ` +
        `textInAnyTurn=${withdrawalReadings[0].textInAnyTurn} controlResponsesForCancel=${controlResponsesForCancel}`,
    );
    console.log(
      `[readings] alreadyStarted cancelledEvents=${startedReadings[0].cancelledEvents} ` +
        `cancelResult=${startedReadings[0].result} hostPidBefore=${String(pidBefore)} hostPidAfter=${String(pidAfter)} ` +
        `laterResult=${laterResult} unattendedFinished=${unattendedFinished} ` +
        `queuedUnattendedTurn=${queuedUnattendedTurn}`,
    );
    console.log(
      `[readings] unattendedStarted=${unattendedStarted} unattendedQueued=${unattendedQueued} ` +
        `resultsBefore=${resultsBefore} resultsAfter=${resultsAfter} ` +
        `resultsNow=${busyReading()?.resultTimes.length ?? 0} queuedTurnEnded=${queuedTurnEnded} ` +
        `queuedUnattendedTurnEnded=${queuedUnattendedTurnEnded}`,
    );
    console.log(`[readings] sessionStateChanged=${finalReading.sessionStateChanged}`);
    console.log(`[readings] nextPriorityLanding=unread`);
    for (const file of [
      'server/modules/providers/provider.registry.ts',
      'server/modules/providers/services/provider-runtime.service.ts',
      'server/modules/providers/list/claude/claude-host-driver.provider.ts',
      'server/modules/providers/list/claude/claude.provider.ts',
      'server/modules/session-hosts/session-host-manager.service.ts',
    ]) {
      console.log(`[readings] websocketImports(${file})=${websocketImports(file)}`);
    }
    console.log(`[readings] elapsed=${elapsed()}`);

    // -------------------------------------------------------------------
    // Assertions — the AC's readings, in order.
    // -------------------------------------------------------------------
    assertBusySendNotRefused(busySends);
    assertWrittenBeforeTurnEnd(writeTimings);
    assertLandedInLaterTurn(landings);
    assertWithdrawnWhileQueued(withdrawalReadings);
    assertWithdrawalAfterDequeue(startedReadings);
    assertTurnBoundaryReadable(turnBoundaries);
    assert.strictEqual(roundOneRefusal, null, 'round one must be accepted (it is the first turn)');
    assert.strictEqual(withdrawnSendRefusal, null, 'the withdrawal target must be accepted when it is sent');
    assert.strictEqual(
      perRunRefusal,
      'RUN_IN_PROGRESS',
      `the positive control: a per-run session must still refuse a busy send (got ${String(perRunRefusal)})`,
    );
    // The per-run control's process has to be stopped before the harness ends,
    // and nothing else in this criterion can stop it: a per-run host carries no
    // pid, so the teardown's kill has no handle to use. Asserted rather than
    // left implicit because the alternative failure is not a red reading but a
    // run that hangs until its budget guard, which reads as a timeout instead of
    // as this fact.
    assert.strictEqual(
      perRunTurnStopped,
      true,
      'the per-run control turn must be stoppable through the production abort path',
    );
    assert.strictEqual(finalReading.sessionStateChanged, 0, 'the stream must carry no session_state_changed (E9 §9.1)');

    // -------------------------------------------------------------------
    // The five fake forms, each driving the assertion above that it is aimed at.
    // -------------------------------------------------------------------
    // (a) A server-side queue: the frame is written after the current turn's
    // result instead of into the process. The write-moment reading is the one
    // that must catch it.
    const serverSideQueue: WriteTimingReading = {
      ...writeTimings[0],
      writeAt: writeTimings[0].turnResultAt + 50,
      before: writeTimings[0].turnResultAt + 50 < writeTimings[0].turnResultAt,
    };
    assert.throws(
      () => assertWrittenBeforeTurnEnd([serverSideQueue, writeTimings[1]]),
      /must be written before the turn in flight ends/,
      'fake (a) must red the write-moment reading',
    );
    console.log('[readings] fake (a): red');

    // (b) The busy send is refused. This is not a constructed reading: it is
    // exactly what the per-run control session did, and the assertion that must
    // catch it is the one leg 1 passes.
    assert.throws(
      () => assertBusySendNotRefused([{ leg: 'user', code: perRunRefusal }, busySends[1]]),
      /must not be refused/,
      'fake (b) must red the not-refused reading',
    );
    console.log('[readings] fake (b): red');

    // (c) The withdrawal hides the message in the UI and sends nothing. No
    // cancelled event, and the text still runs as a turn of its own.
    const hiddenOnly = {
      ...withdrawalReadings[0],
      controlFrameWritten: false,
      cancelledSeen: false,
      textInAnyTurn: true,
    };
    assert.throws(
      () => assertWithdrawnWhileQueued([hiddenOnly]),
      /must really write a cancel_async_message control frame/,
      'fake (c) must red the withdrawal reading',
    );
    console.log('[readings] fake (c): red');

    // (d) The verdict is read off a control response. The real run has zero of
    // them for this request, so a reader that trusted them would report a
    // successful withdrawal as an unknown one.
    const verdictTheFakeWay = verdictFromControlResponse(controlResponsesForCancel);
    assert.throws(
      () => assertWithdrawnWhileQueued([{ ...withdrawalReadings[0], result: verdictTheFakeWay }]),
      /must be reported withdrawn/,
      'fake (d) must red the withdrawal verdict',
    );
    console.log(`[readings] fake (d): red (verdict-from-control-response=${verdictTheFakeWay})`);

    // (e) The turn boundary is taken from session_state_changed. E9 §9.1 measured
    // zero of them on both drivers, so a reader delimiting turns that way finds no
    // boundary at all — and with no boundary it cannot tell the later turn from
    // the one in flight, so it reads the message as absent from every turn. Both
    // halves are driven: the boundary count the reader would have, and the landing
    // reading computed from it.
    assert.throws(
      () => assertTurnBoundaryReadable(finalReading.sessionStateChanged),
      /must be readable from the stream/,
      'fake (e) must red the turn-boundary count',
    );
    const boundaryBlindLanding: LandingReading = {
      ...landings[0],
      turnIndex: null,
      textPresentInCurrentTurn: false,
    };
    assert.throws(
      () => assertLandedInLaterTurn([boundaryBlindLanding, landings[1]]),
      /must appear in a real turn's request body/,
      'fake (e) must red the landing reading (a boundary-blind reader finds no turn)',
    );
    console.log(
      `[readings] fake (e): red (sessionStateChanged=${finalReading.sessionStateChanged}, ` +
        `realTurnBoundaries=${turnBoundaries})`,
    );

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    assert.ok(measured < ELAPSED_LIMIT_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});
