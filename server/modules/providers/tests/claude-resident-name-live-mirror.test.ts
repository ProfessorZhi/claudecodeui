/**
 * Criterion for `gap-claude-resident-name-live-mirror` — a resident Claude
 * process's peer registration name mirrors the session's own generated title,
 * live, once, and only after the title exists.
 *
 * A resident (`entrypoint=sdk-ts`) session that is launched before it has a title
 * is launched with *no* title on purpose: handing one over at session creation
 * makes Claude Code skip title generation entirely (measured in the sibling
 * `claude-peer-name-follows-ai-title.test.ts`, leg 1c). The cost is that the
 * title the session earns a moment later never reaches the CLI's own registry —
 * `~/.claude/sessions/<pid>.json`'s `name` stays `derived` (the cwd's directory
 * name plus two random characters) for the process's whole life, so every peer
 * that reads an address out of `ListAgents` sees a machine-shaped string while
 * the transcript below holds a readable `ai-title`.
 *
 * The fix under test writes one `rename_session` control frame to the live
 * process's stdin once the title has settled. What this criterion measures, on
 * real processes (the real `claude` binary against an Anthropic-compatible mock
 * endpoint):
 *
 * 1. **Positive.** A brand-new resident session is booted with no title handed
 *    over — the exact state the gap is about — and the mock answers the CLI's
 *    title-generation request with `{"title": ...}`, so an `ai-title` row lands
 *    in the transcript. After the same value has settled, the registry's `name`
 *    reads that `ai-title` byte for byte, `nameSource` flips to `user` (the rung
 *    a `source: "host"` frame lands as), `nameSince` moves forward, and the
 *    **pid is unchanged** — the whole point of the control frame over a restart.
 * 2. **Not invented.** The mirrored string is the transcript's own `ai-title`.
 *    The registry name is compared against the transcript row this criterion
 *    reads for itself, not against anything the driver reports, and any
 *    `custom-title` the CLI appends alongside the rename is clamped to the
 *    mirrored value — a different string means the app wrote a name Claude never
 *    generated.
 * 3. **Not early.** At the moment of adoption the transcript holds the exact
 *    `ai-title` that was mirrored, so the frame provably went out after the title
 *    was written. This is the A-arm invariant stated as a reading: a build that
 *    renamed before generation would have *suppressed* generation, leaving no
 *    `ai-title` to mirror at all (the sibling criterion measures that
 *    suppression directly). The negative arm below completes the pair.
 * 4. **Once.** A later round appends the same `ai-title` again; the rename frame
 *    count stays at one.
 * 5. **Negative control.** A resident session of the same shape whose mock
 *    answers the title-generation request with prose — so the CLI parses no
 *    title and writes no `ai-title` row — keeps its `derived` name and writes
 *    **zero** rename frames over the same observation window. This is what makes
 *    reading 3 falsifiable: the mechanism is gated on the title existing, so a
 *    build that sent a name it did *not* read out of the transcript — any ladder
 *    rung, a prompt, a placeholder, an id prefix — would red here by writing a
 *    frame for a session with no title.
 *
 *    The limit of that claim was measured rather than assumed (2026-10-01): the
 *    *literal* "首读即发" mutation — sending on the first non-null read instead
 *    of on a repeated one — was applied to the settle test and run, and this
 *    criterion stayed **green**. That is a property of the design, not a hole in
 *    the negative arm: the frame's payload is read out of the transcript
 *    (reading 2), so shortening the settle test still leaves nothing to send
 *    until an `ai-title` exists, and the title does not change within a round,
 *    so the first read and the settled read are the same string. The invariant
 *    that matters — the frame cannot go out before the title exists — holds by
 *    construction, which is why the A-arm suppression itself is measured by the
 *    sibling criterion rather than re-derived here.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a lifecycle that hangs is a budget kill with its
 *   own reading, as in the sibling criteria.
 * - Every reading is printed before anything is asserted.
 * - The mirror runs on a settle window that polls the transcript; the positive
 *   wait is therefore generous, and the negative wait is a real observation
 *   window (not a single sample) so "zero frames" means "none arrived".
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

const SESSION_POSITIVE = `${RUN_TAG}-mirror-pos`;
const SESSION_NEGATIVE = `${RUN_TAG}-mirror-neg`;

/** What the mock answers the CLI's title-generation request with. */
const MOCK_AI_TITLE = `镜像标题 ${RUN_TAG} mirrored title`;
/** The title the mock would answer with if a *second* generation ran; never expected to land. */
const SECOND_AI_TITLE = `镜像标题 ${RUN_TAG} revised`;

const MARKER_POSITIVE = `MIRROR-POS-${RUN_TAG}`;
const MARKER_NEGATIVE = `MIRROR-NEG-${RUN_TAG}`;

/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = `mirror-custom-model-${RUN_TAG}`;
const MODEL_SECRET = `mirror-model-row-secret-${RUN_TAG}`;

/** How long a turn is given to open, land and settle. */
const TURN_TIMEOUT_MS = 30_000;
/** How long the mirror is given to write its frame after a turn ends. */
const MIRROR_TIMEOUT_MS = 20_000;
/**
 * How long the negative session is watched for a frame that must not come.
 *
 * It has to outlast the positive arm's own mirror latency — the frame there
 * lands within a few seconds of the turn's result — so zero here is an
 * observation and not a sample taken before the mechanism had a chance to run.
 */
const NEGATIVE_WINDOW_MS = 8_000;
/** How long a transcript or registry reading is given to appear. */
const READ_TIMEOUT_MS = 15_000;
/** How many times a session's first turn is sent before the criterion gives up. */
const BOOT_ATTEMPTS = 3;

/**
 * The process budget, enforced by the process rather than by node:test's own
 * per-case timeout, so a lifecycle that hangs is its own reading.
 */
const BUDGET_MS = Number(process.env.CLAUDE_RESIDENT_MIRROR_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_RESIDENT_MIRROR_BUDGET_MS)
  : 180_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the resident title-mirror run ` +
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
 * itself. `nameSince` is the rename clock — a name handed to the process moves
 * it forward, so it is how "the name moved while the process stayed put" is
 * distinguished from "the process was restarted under a new name".
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
 * A request is an *agent* request when its body declares tool schemas; the
 * CLI's title-generation posts carry none, which is what separates the two. The
 * title answer is switchable so the same endpoint serves both arms: JSON earns
 * the session an `ai-title`, prose earns it nothing at all — the CLI discards an
 * answer it cannot parse, so "no `ai-title` row" holds for the negative arm even
 * though the title request itself is made.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  let titleJson = true;

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
        answer(textStream(`mirror ack ${RUN_TAG}`));
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
// The harness
// ---------------------------------------------------------------------------

type Harness = {
  socket: FakeSocket;
  cwd: string;
  configDir: string;
  mock: MockAnthropic;
};

async function withMirrorHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-mirror-'));
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
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = 'sk-host-sentinel-must-not-leak';
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser(`claude-resident-mirror-${RUN_TAG}`, 'unused-hash');

    const now = new Date().toISOString();
    for (const sessionId of [SESSION_POSITIVE, SESSION_NEGATIVE]) {
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
 * mirror. It is asserted afterwards: left unretried it would hollow out the
 * negative arm, whose whole claim is about a *live* host that registers nothing.
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

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

test('a resident session mirrors its generated title into the peer registry, once', { timeout: 300_000 }, async () => {
  await withMirrorHarness(async (context) => {
    const { socket, cwd, configDir, mock } = context;

    // ---------------------------------------------------------------------
    // Leg 1 — the positive arm: a brand-new resident session is handed no
    // title, generates one, and the mirror moves its registered name.
    // ---------------------------------------------------------------------
    mock.setTitleJson(true);
    const boot = await bootResidentSession(socket, SESSION_POSITIVE, MARKER_POSITIVE, cwd, 'positive');
    console.log(
      `[readings] boot=positive exit=${String(boot.frame.exitCode)} aborted=${String(boot.frame.aborted)} ` +
        `attempts=${boot.attempts} exits=${boot.exits.join(',')}`,
    );
    assert.strictEqual(
      boot.frame.exitCode === 0 && boot.frame.aborted === false,
      true,
      `the resident process must come up before its registry readings mean anything ` +
        `(exits=${boot.exits.join(',')} attempts=${boot.attempts})`,
    );

    const pid = hostPid(SESSION_POSITIVE);
    assert.notStrictEqual(pid, null, 'the resident session must be served by a live host with a pid');
    // Read the registry as early as it exists, so `nameSince`'s forward move is a
    // measured delta rather than a comparison against nothing. The CLI writes the
    // file as the process starts and the title lands a moment after the turn, so
    // this read is the pre-mirror state.
    await waitFor(() => readRegistration(configDir, pid) !== null, READ_TIMEOUT_MS, 'the registry entry to appear');
    const before = readRegistration(configDir, pid);
    console.log(`[readings] preAdoption=${JSON.stringify(before)}`);

    const frameLanded = await waitFor(
      () => renameFrames(SESSION_POSITIVE).length === 1 && readRegistration(configDir, pid)?.name === MOCK_AI_TITLE,
      MIRROR_TIMEOUT_MS,
      'the mirror frame and the registry rename',
    );
    const after = readRegistration(configDir, pid);
    const transcriptFile = findTranscriptByMarker(configDir, MARKER_POSITIVE);
    const titles = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
    const frames = renameFrames(SESSION_POSITIVE);
    console.log(
      `[readings] positive frameLanded=${frameLanded} renameFrames=${frames.length} ` +
        `mirrored=${JSON.stringify(mirroredTitle(SESSION_POSITIVE))} after=${JSON.stringify(after)} ` +
        `aiTitles=${JSON.stringify(titles.aiTitles)} customTitles=${JSON.stringify(titles.customTitles)} ` +
        `transcript=${transcriptFile ? path.basename(transcriptFile) : 'none'}`,
    );

    assert.strictEqual(frames.length, 1, `exactly one rename frame must be written (saw ${frames.length})`);
    assert.strictEqual(
      after?.name,
      MOCK_AI_TITLE,
      `the registered name must become the generated title (name=${JSON.stringify(after?.name)})`,
    );
    assert.strictEqual(
      after?.nameSource,
      'user',
      `the renamed process registers as the user's rung, the one a host-source frame lands as ` +
        `(nameSource=${JSON.stringify(after?.nameSource)})`,
    );
    assert.strictEqual(
      after?.sessionId,
      transcriptFile ? path.basename(transcriptFile, '.jsonl') : null,
      `the renamed registration must be this conversation's (registry=${String(after?.sessionId)} ` +
        `transcript=${String(transcriptFile ? path.basename(transcriptFile, '.jsonl') : null)})`,
    );
    // AC2, the live half: the process is the same one, so the name moved without
    // a restart. `nameSince` is the rename clock and `startedAt` is the process
    // clock; both are read off the registry file itself.
    assert.strictEqual(hostPid(SESSION_POSITIVE), pid, `the process must not be restarted (${String(pid)})`);
    assert.notStrictEqual(after?.nameSince, null, 'the registry must carry the rename clock');
    // The forward move, stated against the process's own clock. `nameSince` starts
    // equal to `startedAt` (a derived name is minted as the process starts), so a
    // rename landing later is `nameSince > startedAt`. Stated this way rather than
    // as a before/after delta because the mirror may already have fired by the
    // time the pre-read happens; both are printed.
    assert.strictEqual(
      after !== null && after.startedAt !== null && after.nameSince !== null && after.nameSince > after.startedAt,
      true,
      `the rename must move nameSince past the process start (startedAt=${String(after?.startedAt)} ` +
        `nameSince=${String(after?.nameSince)} preRead=${String(before?.nameSince)})`,
    );

    // AC4 / hard invariant 1: at adoption the transcript holds the exact title
    // that was mirrored. A build that renamed before generation would have
    // suppressed generation and left no `ai-title` here at all.
    assert.strictEqual(
      titles.aiTitles.includes(MOCK_AI_TITLE),
      true,
      `the transcript must hold the mirrored ai-title at adoption (aiTitles=${JSON.stringify(titles.aiTitles)})`,
    );
    // Hard invariant 2: mirror, never invent. The value sent is the transcript's
    // own newest ai-title, byte for byte.
    assert.strictEqual(
      titles.aiTitles.at(-1),
      MOCK_AI_TITLE,
      `the mirrored value must be the transcript's own newest title (${JSON.stringify(titles.aiTitles)})`,
    );
    assert.strictEqual(
      mirroredTitle(SESSION_POSITIVE),
      titles.aiTitles.at(-1),
      `the frame's title must be the transcript's title byte for byte ` +
        `(frame=${JSON.stringify(mirroredTitle(SESSION_POSITIVE))} transcript=${JSON.stringify(titles.aiTitles.at(-1))})`,
    );
    assert.strictEqual(
      titles.aiTitles.includes(SECOND_AI_TITLE),
      false,
      `no title the mock never sent may appear (aiTitles=${JSON.stringify(titles.aiTitles)})`,
    );
    // AC6: the side effect the control frame carries is clamped — every
    // `custom-title` the rename appended is the mirrored value and nothing else.
    assert.strictEqual(
      titles.customTitles.every((title) => title === MOCK_AI_TITLE),
      true,
      `every custom-title must be byte-equal to the mirrored value ` +
        `(customTitles=${JSON.stringify(titles.customTitles)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 2 — idempotence: a later round re-appends the same title, and no
    // second frame is written.
    // ---------------------------------------------------------------------
    const framesBeforeSecond = renameFrames(SESSION_POSITIVE).length;
    const second = await sendRound(socket, SESSION_POSITIVE, `${MARKER_POSITIVE} second turn`, cwd);
    await sleep(2_000);
    const afterSecond = readRegistration(configDir, pid);
    const titlesAfterSecond = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
    console.log(
      `[readings] idempotence exit=${String(second.exitCode)} renameFramesBefore=${framesBeforeSecond} ` +
        `renameFramesAfter=${renameFrames(SESSION_POSITIVE).length} ` +
        `aiTitlesAfter=${JSON.stringify(titlesAfterSecond.aiTitles)} name=${JSON.stringify(afterSecond?.name)}`,
    );
    assert.strictEqual(second.exitCode === 0 && second.aborted === false, true, 'the second round must complete');
    assert.strictEqual(
      renameFrames(SESSION_POSITIVE).length,
      1,
      `a later round must not write a second rename frame (saw ${renameFrames(SESSION_POSITIVE).length})`,
    );
    assert.strictEqual(
      afterSecond?.name,
      MOCK_AI_TITLE,
      `the name must stay where adoption put it (name=${JSON.stringify(afterSecond?.name)})`,
    );
    assert.strictEqual(afterSecond?.nameSince, after?.nameSince, 'a second frame would have moved nameSince again');

    // ---------------------------------------------------------------------
    // Leg 3 — the negative control: a resident session whose transcript has no
    // ai-title keeps its derived name and writes no frame.
    // ---------------------------------------------------------------------
    mock.setTitleJson(false);
    const negBoot = await bootResidentSession(socket, SESSION_NEGATIVE, MARKER_NEGATIVE, cwd, 'negative');
    console.log(
      `[readings] boot=negative exit=${String(negBoot.frame.exitCode)} aborted=${String(negBoot.frame.aborted)} ` +
        `attempts=${negBoot.attempts}`,
    );
    assert.strictEqual(
      negBoot.frame.exitCode === 0 && negBoot.frame.aborted === false,
      true,
      `the negative control must also be a live process (exits=${negBoot.exits.join(',')})`,
    );
    const negPid = hostPid(SESSION_NEGATIVE);
    assert.notStrictEqual(negPid, null, 'the negative session must be served by a live host with a pid');
    await waitFor(() => readRegistration(configDir, negPid) !== null, READ_TIMEOUT_MS, 'the negative registry entry');
    const negBefore = readRegistration(configDir, negPid);

    // The observation window: long enough that the positive arm's own mirror
    // latency has elapsed several times over.
    await sleep(NEGATIVE_WINDOW_MS);

    const negAfter = readRegistration(configDir, negPid);
    const negTranscript = findTranscriptByMarker(configDir, MARKER_NEGATIVE);
    const negTitles = titleRows(negTranscript ? readJsonLines(negTranscript) : []);
    const negFrames = renameFrames(SESSION_NEGATIVE);
    console.log(
      `[readings] negative renameFrames=${negFrames.length} before=${JSON.stringify(negBefore)} ` +
        `after=${JSON.stringify(negAfter)} aiTitles=${JSON.stringify(negTitles.aiTitles)} ` +
        `titleGenRequests=${mock.received.filter((request) => !request.isAgent).length} ` +
        `window=${NEGATIVE_WINDOW_MS}ms`,
    );
    assert.strictEqual(
      negTitles.aiTitles.length,
      0,
      `the negative control's transcript must hold no generated title (aiTitles=${JSON.stringify(negTitles.aiTitles)})`,
    );
    assert.strictEqual(
      negFrames.length,
      0,
      `a session with no ai-title must write no rename frame (saw ${negFrames.length})`,
    );
    assert.strictEqual(
      negAfter?.nameSource,
      'derived',
      `a session with no ai-title must keep the CLI's derived name (nameSource=${JSON.stringify(negAfter?.nameSource)})`,
    );
    assert.strictEqual(
      negAfter?.name,
      negBefore?.name,
      `the derived name must not move (before=${JSON.stringify(negBefore?.name)} after=${JSON.stringify(negAfter?.name)})`,
    );
    assert.strictEqual(hostPid(SESSION_NEGATIVE), negPid, 'the negative control must not be restarted');

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    assert.ok(measured < BUDGET_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});
