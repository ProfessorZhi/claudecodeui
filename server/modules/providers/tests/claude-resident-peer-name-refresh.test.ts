/**
 * Criterion for `gap-claude-resident-peer-name-projection-stale` — the projected
 * peer address (`GET /api/session-hosts`'s `binding.peerName`, the string the
 * status-bar popover's "copy address" hands out) follows the process's own
 * registry when a title-adoption frame moves it, instead of freezing the address
 * the process registered at startup.
 *
 * A cold-start resident session is launched with no title (handing one over makes
 * the CLI skip generation — see `claude-resident-name-live-mirror.test.ts`), so
 * the CLI registers its derived name and the app's identity read-back settles
 * there. The title mirror then writes a `rename_session` frame that moves the
 * CLI's *own* registry (`~/.claude/sessions/<pid>.json`) onto the generated
 * title — but before this task, nothing re-read the registry afterwards, so the
 * projection kept the derived snapshot for the process's whole life and the
 * popover handed out an orphan name.
 *
 * This criterion drives real processes (the real `claude` binary against an
 * Anthropic-compatible mock endpoint, a temporary `DATABASE_PATH` and a
 * temporary `CLAUDE_CONFIG_DIR`) and reads both sides for itself:
 *
 * 1. **Cold arm, red-before-green.** A brand-new resident session is booted with
 *    no title. The projection is polled from the first reading: it is the
 *    registry's derived name (`t0.peerName`, printed with the registry's
 *    `nameSource`). The mock answers the CLI's title-generation request with
 *    `{"title": ...}`, the transcript earns an `ai-title`, the mirror moves the
 *    registry — and the **projection then equals the registry's name byte for
 *    byte**, read here off `~/.claude/sessions/<pid>.json`, not off anything the
 *    driver reports. Before the fix this arm reds on exactly that equality: the
 *    projection stayed derived while the registry carried the title.
 * 2. **Not invented.** The projected string is the transcript's own newest
 *    `ai-title`, and the registry's `name` is that string; the driver's re-read
 *    publishes what the file says. A build that published the title it *sent*
 *    rather than the one it read would still have to match this file, and a
 *    build that published an app-side name would not.
 * 3. **Not restarted.** The pid and the registry's `startedAt` are unchanged
 *    across the move: the address moved under the process, not because a new
 *    process was launched (the whole reason the mirror uses a control frame).
 * 4. **Positive control (guards against a criterion that is true by accident).**
 *    In the same run, a resident session that is *launched with a title* (its
 *    provider session id is assigned after a first cold boot, so the restart
 *    resumes it and the CLI adopts the title at startup, `nameSource: "auto"`)
 *    reads equal from the first projection onward, with no re-read needed. If the
 *    projection were always null, or the equality held for a reason unrelated to
 *    the registry, this arm would part company with the cold arm.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a lifecycle that hangs is its own reading.
 * - Every reading is printed before anything is asserted.
 * - The false form (the re-read path removed) reds on the load-bearing equality
 *   — the reading the driver's own change is graded on.
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
import type { ClaudeResidentHostDriver } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

/** This run's own tag: session ids and transcript markers belong to this run alone. */
const RUN_TAG = randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 8);

/** The cold arm — the process whose registered name moves under it. */
const SESSION_COLD = `${RUN_TAG}-refresh-cold`;
/** The positive control — a process launched *with* a title, which needs no move. */
const SESSION_TITLED = `${RUN_TAG}-refresh-titled`;

/** What the mock answers each session's own title-generation request with. */
const MOCK_AI_TITLE = `刷新标题 ${RUN_TAG} refreshed title`;
/**
 * The control's title, deliberately different from the cold arm's.
 *
 * Two live processes claiming the same registered name collide: the CLI resolves
 * it by appending a `<adjective>-<animal>` suffix and landing the entry under
 * `nameSource: "collision"`, which is a fact about name uniqueness rather than
 * about the address this criterion grades. Distinct titles keep the two arms on
 * the rungs each is measuring.
 */
const MOCK_AI_TITLE_TITLED = `刷新标题 ${RUN_TAG} titled control title`;

const MARKER_COLD = `REFRESH-COLD-${RUN_TAG}`;
const MARKER_TITLED = `REFRESH-TITLED-${RUN_TAG}`;

/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = `refresh-custom-model-${RUN_TAG}`;
const MODEL_SECRET = `refresh-model-row-secret-${RUN_TAG}`;

/** How long a turn is given to open, land and settle. */
const TURN_TIMEOUT_MS = 30_000;
/** How long the projection is given to follow the registry after the frame. */
const REFRESH_TIMEOUT_MS = 25_000;
/** How long a transcript or registry reading is given to appear. */
const READ_TIMEOUT_MS = 15_000;
/** How many times a session's first turn is sent before the criterion gives up. */
const BOOT_ATTEMPTS = 3;

/**
 * The process budget, enforced by the process rather than by node:test's own
 * per-case timeout, so a lifecycle that hangs is its own reading.
 */
const BUDGET_MS = Number(process.env.CLAUDE_RESIDENT_REFRESH_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_RESIDENT_REFRESH_BUDGET_MS)
  : 240_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the resident peer-name refresh run ` +
      `did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
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
 * One process's registration, read straight off disk.
 *
 * Parsed here rather than through the driver's own reader for the reason the
 * sibling criteria do the same: a reading that compared the app's published
 * answer to the app's own reader would only be saying the reader agrees with
 * itself. `nameSource` and `nameSince` are the adoption clock — a name handed to
 * the process moves them, so they are how "the name moved while the process
 * stayed put" is distinguished from "the process was restarted under a new name".
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
 * title-generation posts carry none, which is what separates the two. Every
 * non-agent call is answered with the JSON title, so a cold launch earns an
 * `ai-title` the mirror can move the registry onto.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];

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
        answer(textStream(`refresh ack ${RUN_TAG}`));
        return;
      }
      // The title request carries the conversation it summarizes, so the marker
      // separates the two sessions and each earns its own title.
      answer(textStream(JSON.stringify({ title: body.includes(MARKER_TITLED) ? MOCK_AI_TITLE_TITLED : MOCK_AI_TITLE })));
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
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
 *
 * The provider session id is not known before the first round — the app has none
 * yet either — so the file is identified by content. The newest match wins,
 * because a process that died on the way up and was booted again leaves an
 * earlier file behind.
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

/** The title rows a process wrote into its own transcript, in row order. */
function titleRows(rows: Array<Record<string, unknown>>): { aiTitles: string[]; customTitles: string[] } {
  const aiTitles: string[] = [];
  const customTitles: string[] = [];
  for (const row of rows) {
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle) {
      aiTitles.push(row.aiTitle);
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle) {
      customTitles.push(row.customTitle);
    }
  }
  return { aiTitles, customTitles };
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
// The REST projection this criterion reads the address out of
// ---------------------------------------------------------------------------

type BindingRow = {
  appSessionId: string;
  providerSessionId: string | null;
  state: string;
  peerName: string | null;
};

type HostRow = {
  hostId: string;
  state: string;
  pid: number | null;
  bindings: BindingRow[];
};

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** One `GET`, answered as JSON. Local and short-lived; no retries needed. */
function getJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
  });
}

async function readHosts(apiBaseUrl: string): Promise<HostRow[]> {
  const response = await getJson(`${apiBaseUrl}/api/session-hosts`);
  assert.strictEqual(response.status, 200, `GET /api/session-hosts must answer (${response.status})`);
  const body = row(JSON.parse(response.body)) ?? {};
  const data = row(body.data) ?? {};
  return (Array.isArray(data.hosts) ? data.hosts : []) as HostRow[];
}

async function readBinding(
  apiBaseUrl: string,
  appSessionId: string,
): Promise<{ host: HostRow; binding: BindingRow } | null> {
  for (const host of await readHosts(apiBaseUrl)) {
    const binding = (host.bindings ?? []).find((candidate) => candidate.appSessionId === appSessionId);
    if (binding && host.state !== 'closed') {
      return { host, binding };
    }
  }
  return null;
}

/**
 * The first address the app publishes for one session, plus the registry file at
 * that instant.
 *
 * Read *during* the turn rather than after it: the point of the cold arm is that
 * the projection starts on the CLI's derived name and then moves, so the first
 * reading has to be taken while the process is still on that name. The registry
 * is read at the same moment so the reading is "the projection was showing what
 * the file said", not just "the projection was non-null".
 */
async function firstPublishedName(
  apiBaseUrl: string,
  appSessionId: string,
  configDir: string,
  timeoutMs: number,
  label: string,
): Promise<{ peerName: string | null; hostPid: number | null; registration: CliRegistration | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await readBinding(apiBaseUrl, appSessionId);
    if (found?.binding.peerName) {
      return {
        peerName: found.binding.peerName,
        hostPid: found.host.pid,
        registration: readRegistration(configDir, found.host.pid),
      };
    }
    if (Date.now() >= deadline) {
      console.log(`[readings] firstPublishedName read no address (${label}, waited ${timeoutMs}ms)`);
      return { peerName: null, hostPid: null, registration: null };
    }
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Harness = {
  socket: FakeSocket;
  cwd: string;
  configDir: string;
  apiBaseUrl: string;
  mock: MockAnthropic;
};

async function withRefreshHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-refresh-'));
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
  const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = 'sk-host-sentinel-must-not-leak';
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser(`claude-resident-refresh-${RUN_TAG}`, 'unused-hash');

    const now = new Date().toISOString();
    for (const sessionId of [SESSION_COLD, SESSION_TITLED]) {
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

    await run({ socket, cwd: tempDirectory, configDir, apiBaseUrl, mock });
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

/** Sends one user turn and answers with its terminal `complete` frame. */
async function sendRound(
  socket: FakeSocket,
  sessionId: string,
  content: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  const completes = (): Array<Record<string, unknown>> =>
    socket.frames.filter((frame) => frame.kind === 'complete' && frame.sessionId === sessionId);
  const before = completes().length;
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'bypassPermissions' },
  }));
  await waitFor(() => completes().length > before, TURN_TIMEOUT_MS, `round "${content.slice(0, 40)}" to complete`);
  return completes().at(-1) as Record<string, unknown>;
}

/**
 * Boots one resident session, retrying a process that died on the way up.
 *
 * The retry absorbs an environmental failure — the CLI exiting non-zero before
 * it reaches the mock — which is a fact about the machine and not about the
 * address. It is asserted afterwards, so a session that only ever came up on the
 * second try cannot pass as one that came up first.
 */
async function bootResidentSession(
  socket: FakeSocket,
  sessionId: string,
  marker: string,
  cwd: string,
  label: string,
): Promise<{ frame: Record<string, unknown>; exits: number[]; attempts: number }> {
  const exits: number[] = [];
  for (;;) {
    const frame = await sendRound(socket, sessionId, `${marker} BOOT first turn`, cwd);
    const exitCode = typeof frame.exitCode === 'number' ? frame.exitCode : 0;
    exits.push(exitCode);
    const landed = exitCode === 0 && frame.aborted === false;
    if (landed || exits.length >= BOOT_ATTEMPTS) {
      return { frame, exits, attempts: exits.length };
    }
    console.log(
      `[readings] boot retry session=${label} attempt=${exits.length} exit=${exitCode} ` +
        `(the process did not come up; sending the first turn again)`,
    );
    await sleep(250);
  }
}

/** The host driver this criterion reads its frame counts off. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

/** The control frames this host has written whose subtype is the title rename. */
function renameFrames(sessionId: string): Array<{ at: number; frame: Record<string, unknown> }> {
  const reading = residentDriver().busyInputReading(sessionId);
  const frames = reading?.controlFrames ?? [];
  return frames.filter((entry) => row(entry.frame.request)?.subtype === 'rename_session');
}

/** The pid of the live host serving one session, or null. */
function hostPid(sessionId: string): number | null {
  const host = sessionHostManager
    .snapshot()
    .find((candidate) => candidate.state !== 'closed' && candidate.bindings.has(sessionId));
  return host?.pid ?? null;
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

test('a resident host re-reads its projected peer name once the registry name moves', { timeout: 360_000 }, async () => {
  await withRefreshHarness(async (context) => {
    const { socket, cwd, configDir, apiBaseUrl } = context;

    // ---------------------------------------------------------------------
    // Leg 1 — the cold arm. The address the app publishes must start on the
    // derived name and follow the registry onto the generated title.
    // ---------------------------------------------------------------------
    // The projection is watched from before the turn, so the *first* address it
    // ever publishes is captured — that is the derived snapshot, and the reading
    // that has to move.
    const t0Promise = firstPublishedName(apiBaseUrl, SESSION_COLD, configDir, TURN_TIMEOUT_MS, 'cold-t0');
    const coldBoot = await bootResidentSession(socket, SESSION_COLD, MARKER_COLD, cwd, 'cold');
    const t0 = await t0Promise;
    console.log(
      `[readings] cold boot exit=${String(coldBoot.frame.exitCode)} aborted=${String(coldBoot.frame.aborted)} ` +
        `attempts=${coldBoot.attempts} exits=${coldBoot.exits.join(',')}`,
    );
    assert.strictEqual(
      coldBoot.frame.exitCode === 0 && coldBoot.frame.aborted === false,
      true,
      `the resident process must come up before its projections mean anything ` +
        `(exits=${coldBoot.exits.join(',')} attempts=${coldBoot.attempts})`,
    );

    const coldPid = hostPid(SESSION_COLD);
    assert.notStrictEqual(coldPid, null, 'the cold session must be served by a live host with a pid');
    console.log(
      `[readings] t0.peerName=${JSON.stringify(t0.peerName)} t0.registry.name=${JSON.stringify(t0.registration?.name)} ` +
        `t0.registry.nameSource=${JSON.stringify(t0.registration?.nameSource)} t0.pid=${String(coldPid)}`,
    );
    // The honest first reading: the projection was the registry's derived name.
    assert.strictEqual(
      t0.registration?.nameSource,
      'derived',
      `the cold launch must register the CLI's derived name first ` +
        `(t0.registry=${JSON.stringify(t0.registration)})`,
    );
    assert.strictEqual(
      t0.peerName,
      t0.registration?.name,
      `the first published address must be the registry's derived name ` +
        `(projection=${JSON.stringify(t0.peerName)} registry=${JSON.stringify(t0.registration?.name)})`,
    );

    // Wait for the projection to *move*, then read the registry as the authority.
    const moved = await waitFor(
      () => {
        const host = sessionHostManager
          .snapshot()
          .find((candidate) => candidate.state !== 'closed' && candidate.bindings.has(SESSION_COLD));
        const published = host?.bindings.get(SESSION_COLD)?.peerName ?? null;
        return Boolean(published) && published !== t0.peerName;
      },
      REFRESH_TIMEOUT_MS,
      'the projection to move off the derived name',
    );

    // Read both sides at the end: the REST projection (what the popover copies
    // from) and the process's own registry file.
    const finalFound = await readBinding(apiBaseUrl, SESSION_COLD);
    const after = readRegistration(configDir, coldPid);
    const transcriptFile = findTranscriptByMarker(configDir, MARKER_COLD);
    const titles = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
    const clipBoard = finalFound?.binding.peerName ?? null;
    const equal = clipBoard !== null && clipBoard === after?.name;
    console.log(
      `[readings] moved=${moved} projection.peerName=${JSON.stringify(clipBoard)} after.peerName=${JSON.stringify(clipBoard)} ` +
        `clipboard=${JSON.stringify(clipBoard)} registry.pid=${String(after?.pid)} registry.name=${JSON.stringify(after?.name)} ` +
        `registry.nameSource=${JSON.stringify(after?.nameSource)} equal=${String(equal)} ` +
        `aiTitles=${JSON.stringify(titles.aiTitles)} customTitles=${JSON.stringify(titles.customTitles)} ` +
        `renameFrames=${renameFrames(SESSION_COLD).length} elapsed=${Date.now() - STARTED_AT}ms`,
    );

    // The load-bearing reading: the projected address is the registry's name, and
    // the registry's name is the session's own generated title.
    assert.strictEqual(
      equal,
      true,
      `the projected peer name must equal the registry's name after the rename ` +
        `(projection=${JSON.stringify(clipBoard)} registry=${JSON.stringify(after?.name)} equal=${String(equal)})`,
    );
    // Read-only, not invented: the file the projection was just compared against
    // is the live host process's own, read here a second time.
    assert.strictEqual(
      after?.pid,
      coldPid,
      `the registry file must be the host's own process (registry=${String(after?.pid)} host=${String(coldPid)})`,
    );
    assert.strictEqual(
      after?.name,
      MOCK_AI_TITLE,
      `the registry name must be the generated title this criterion read for itself ` +
        `(registry=${JSON.stringify(after?.name)} expected=${JSON.stringify(MOCK_AI_TITLE)})`,
    );
    assert.strictEqual(
      after?.nameSource !== 'derived',
      true,
      `the registry must have adopted a name the CLI did not derive ` +
        `(nameSource=${JSON.stringify(after?.nameSource)})`,
    );
    // Not invented: the projected string is the transcript's own newest ai-title.
    assert.strictEqual(
      clipBoard,
      titles.aiTitles.at(-1),
      `the projected address must be the transcript's own newest ai-title, byte for byte ` +
        `(projection=${JSON.stringify(clipBoard)} transcript=${JSON.stringify(titles.aiTitles.at(-1))})`,
    );
    // Not restarted: the address moved under the same process.
    assert.strictEqual(hostPid(SESSION_COLD), coldPid, `the cold process must not be restarted (${String(coldPid)})`);
    assert.strictEqual(
      after?.startedAt,
      t0.registration?.startedAt,
      `the process start must be unchanged across the move (before=${String(t0.registration?.startedAt)} ` +
        `after=${String(after?.startedAt)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 2 — the positive control. A resident session launched *with* a title
    // (its provider session id is assigned after its own cold boot, so the
    // restart resumes it and the CLI adopts the title at startup) reads equal
    // from the first projection onward, with no re-read needed.
    // ---------------------------------------------------------------------
    const titledBoot = await bootResidentSession(socket, SESSION_TITLED, MARKER_TITLED, cwd, 'titled-boot');
    assert.strictEqual(
      titledBoot.frame.exitCode === 0 && titledBoot.frame.aborted === false,
      true,
      `the control's cold boot must come up (exits=${titledBoot.exits.join(',')})`,
    );
    const titledFirstPid = hostPid(SESSION_TITLED);
    assert.notStrictEqual(titledFirstPid, null, 'the control must be served by a live host before the restart');
    const titledTranscript = findTranscriptByMarker(configDir, MARKER_TITLED);
    const titledProviderSessionId = titledTranscript ? path.basename(titledTranscript, '.jsonl') : null;
    assert.notStrictEqual(titledProviderSessionId, null, 'the control boot must write a transcript to resume from');
    // The mirror moves the control's registry onto its own generated title during
    // its cold boot; wait for that before restarting, so the resumed title is the
    // value the transcript now carries.
    const titledMirrored = await waitFor(
      () => readRegistration(configDir, titledFirstPid)?.nameSource === 'user',
      REFRESH_TIMEOUT_MS,
      'the control cold boot to be mirrored before its restart',
    );
    console.log(
      `[readings] titled-boot pid=${String(titledFirstPid)} mirrored=${String(titledMirrored)} ` +
        `registry=${JSON.stringify(readRegistration(configDir, titledFirstPid))} renameFrames=${renameFrames(SESSION_TITLED).length}`,
    );
    assert.strictEqual(titledMirrored, true, 'the control cold boot must earn and mirror its own title');
    // Hand the provider session id to the app, exactly as the live flow does once
    // the CLI names its session, then restart the host so the launch resumes a
    // conversation that already has a title.
    sessionsDb.assignProviderSessionId(SESSION_TITLED, titledProviderSessionId as string);
    const titledHost = sessionHostManager
      .snapshot()
      .find((host) => host.pid === titledFirstPid);
    assert.ok(titledHost, 'the control host must be open before the restart');
    sessionHostManager.closeHost(titledHost.hostId, 'user');
    await waitFor(
      () => titledFirstPid === null || !existsSync(`/proc/${titledFirstPid}`),
      15_000,
      "the control's first process to be gone before the restart",
    );

    const titledT0Promise = firstPublishedName(apiBaseUrl, SESSION_TITLED, configDir, TURN_TIMEOUT_MS, 'titled-t0');
    const titledRestart = await bootResidentSession(socket, SESSION_TITLED, MARKER_TITLED, cwd, 'titled-restart');
    const titledT0 = await titledT0Promise;
    assert.strictEqual(
      titledRestart.frame.exitCode === 0 && titledRestart.frame.aborted === false,
      true,
      `the control's restart must come up (exits=${titledRestart.exits.join(',')})`,
    );
    const titledPid = hostPid(SESSION_TITLED);
    assert.notStrictEqual(titledPid, null, 'the restarted control must be served by a live host');
    assert.notStrictEqual(titledPid, titledFirstPid, `the control must be a second process (${String(titledPid)})`);
    const titledRegistry = readRegistration(configDir, titledPid);
    console.log(
      `[readings] titled t0.peerName=${JSON.stringify(titledT0.peerName)} projection.peerName=${JSON.stringify(titledT0.peerName)} ` +
        `registry.pid=${String(titledRegistry?.pid)} registry.name=${JSON.stringify(titledRegistry?.name)} ` +
        `registry.nameSource=${JSON.stringify(titledRegistry?.nameSource)} ` +
        `equal=${String(titledT0.peerName !== null && titledT0.peerName === titledRegistry?.name)}`,
    );
    // The CLI adopted the handed-over title at startup (`auto`), and the
    // projection read the same string from the first moment.
    assert.strictEqual(
      titledRegistry?.nameSource,
      'auto',
      `a title-launched process must register the CLI's auto rung (${JSON.stringify(titledRegistry)})`,
    );
    assert.strictEqual(
      titledRegistry?.name,
      MOCK_AI_TITLE_TITLED,
      `the title-launched process must register the session's own title byte for byte ` +
        `(registry=${JSON.stringify(titledRegistry?.name)})`,
    );
    assert.strictEqual(
      titledT0.peerName,
      titledRegistry?.name,
      `the control's first published address must equal its registry name ` +
        `(projection=${JSON.stringify(titledT0.peerName)} registry=${JSON.stringify(titledRegistry?.name)})`,
    );

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    assert.ok(measured < BUDGET_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});
