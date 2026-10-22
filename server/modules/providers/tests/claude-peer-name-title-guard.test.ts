/**
 * Criterion for `gap-claude-peer-name-title-guard` — the peer name a Claude
 * session answers to follows the session's *own* title, and nothing is handed
 * over when the session has none.
 *
 * The sibling criterion `claude-peer-name-follows-ai-title.test.ts` settled
 * *that* a launch hands the session's Claude Code title to the CLI, so a process
 * registers under `nameSource: "auto"` and answers to a readable phrase instead
 * of the directory-plus-two-characters name the CLI derives. It left the other
 * half open, and a live server reading on 2026-10-01 showed what that costs:
 * `getSessionInfo().summary` is the CLI's *ladder*, not a "does this session
 * have a title" reading, so on a session with no `ai-title` the value handed over
 * was the ladder's last resort — the first prompt verbatim. The CLI adopted it,
 * the transcript gained a `custom-title` equal to it, the session row's
 * `transcript_name_source` moved to `manual`, and `manual` outranks `ai`: a
 * later generated title could never take the name back. Measured on the same
 * machine: 522 new sessions in 48 hours, 18 (3%) with an `ai-title`.
 *
 * So this criterion measures the gate, on real processes (the real `claude`
 * binary against an Anthropic-compatible mock endpoint):
 *
 * 1. **No title ⇒ nothing handed over.** A session whose transcript carries no
 *    `ai-title` keeps the CLI's derived name after *two* full rounds — the round
 *    that creates the session and the resumed round that is the first one able
 *    to hand anything over. The transcript gains no `custom-title`, and the
 *    session row's `transcript_name_source` is still `derived` after the
 *    provider's own indexer has re-read the transcript. The premise is read, not
 *    assumed: the title-generation request is asserted to have reached the
 *    endpoint and to have been answered with something the CLI does not accept
 *    as a title.
 * 2. **A generated title ⇒ handed over (positive control).** The same harness,
 *    the same two rounds, with the one variable changed: the endpoint answers
 *    the title request with `{"title": ...}`, the CLI writes an `ai-title`, and
 *    the resumed round registers `nameSource: "auto"` under that string byte for
 *    byte. Without this arm, leg 1's `derived` would be equally consistent with
 *    a guard that hands over nothing, ever.
 * 3. **A `/rename` ⇒ handed over.** The session from leg 1 is renamed through
 *    the SDK (`renameSession`, which appends the same `custom-title` entry a CLI
 *    `/rename` appends). The next round hands that string over and the process
 *    registers it. A human's word is a real title — the guard must not block it
 *    — and, because leg 1's session provably has no `ai-title`, the string in
 *    the registry can only have come from the rename.
 *
 * What is deliberately *not* an input: the app's own `transcript_name_source`
 * column. It is a reading of this app's ladder over the transcript and it can
 * already have been moved by an override, so it answers a different question
 * than "does Claude Code have a title for this session".
 *
 * Red lines:
 * - The process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, so a lifecycle that hangs is a budget kill with its own
 *   reading, as in the sibling criterion.
 * - Every reading is printed before anything is asserted.
 * - Registry readings are taken while the process is still alive: a per-run
 *   process registers, runs, answers and exits, so a read taken after the
 *   `complete` frame would find nothing at all — which is exactly what "no title
 *   was handed over" looks like too.
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

import { renameSession as renameClaudeSession } from '@anthropic-ai/claude-agent-sdk';
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
  ClaudeSessionSynchronizer,
  createProviderRuntimeService,
  providerRoutes,
} from '@/modules/providers/index.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

/**
 * This run's own tag.
 *
 * The registry this criterion reads is machine-global and pid-keyed, so its rows
 * are looked up by the provider session id this run minted — but the session ids
 * and the transcript markers have to belong to this run alone: the project
 * directory a transcript lives in is shared with every other run on the host.
 */
const RUN_TAG = randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 8);
const SESSION_TITLED = `${RUN_TAG}-titled`;
const SESSION_UNTITLED = `${RUN_TAG}-untitled`;

/**
 * The two titles, and neither ends in `-<six hex digits>`: that shape is how
 * the indexer recognises an address this app minted (`--name`), and a title it
 * misreads that way would be routed to a different rung and prove nothing.
 */
const GENERATED_TITLE = `AC Generated ${RUN_TAG}`;
const RENAME_TITLE = `AC Renamed ${RUN_TAG}`;

const MARKER_TITLED = `AC-TITLED-${RUN_TAG}`;
const MARKER_UNTITLED = `AC-UNTITLED-${RUN_TAG}`;

/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = `peer-title-guard-model-${RUN_TAG}`;
const MODEL_SECRET = `peer-title-guard-secret-${RUN_TAG}`;

/** How long a turn is given to open, land and settle. */
const TURN_TIMEOUT_MS = 30_000;
/** How long a transcript or registry reading is given to appear. */
const READ_TIMEOUT_MS = 15_000;

/**
 * The process budget, enforced by the process rather than by node:test's own
 * per-case timeout, so a lifecycle that hangs is its own reading.
 */
const BUDGET_MS = Number(process.env.CLAUDE_PEER_TITLE_GUARD_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_PEER_TITLE_GUARD_BUDGET_MS)
  : 300_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the peer-title-guard run did not ` +
      `finish inside its process budget (a process-level kill, not a node:test case failure).`,
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
};

/**
 * Every live registration for one provider session, oldest pid first.
 *
 * Read straight off `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` rather than
 * through the driver's own reader: a criterion that compared the app's answer to
 * the app's reader would only be saying the reader equals itself.
 *
 * Sorted by pid rather than by mtime because a per-run session leaves its
 * earlier processes' registrations behind while they linger, and a fresh pid is
 * the only thing that distinguishes the process a round started from the one
 * before it.
 */
function readAllRegistrations(configDir: string): CliRegistration[] {
  const dir = path.join(configDir, 'sessions');
  if (!existsSync(dir)) {
    return [];
  }
  const rows: CliRegistration[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const pid = Number(file.slice(0, -'.json'.length));
    if (!Number.isFinite(pid)) {
      continue;
    }
    try {
      const row = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
      rows.push({
        pid,
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
        name: typeof row.name === 'string' && row.name ? row.name : null,
        nameSource: typeof row.nameSource === 'string' ? row.nameSource : null,
      });
    } catch {
      // No registration yet, or a torn one. A caller polls.
    }
  }
  return rows.sort((left, right) => left.pid - right.pid);
}

/**
 * Collects the registrations a round's process writes, *while it is alive*.
 *
 * The CLI rewrites `sessions/<pid>.json` more than once — it registers under its
 * derived name as it starts and rewrites the name when it adopts a title — so the
 * last state seen for a pid is the one kept. Keeping the first sighting would
 * read every process as `derived`, which is precisely the reading under test.
 */
function watchRegistrations(configDir: string, seenPids: number[]): {
  captured: CliRegistration[];
  sweep: () => void;
  stop: () => Promise<void>;
} {
  const captured: CliRegistration[] = [];
  let watching = true;

  const sweep = (): void => {
    for (const row of readAllRegistrations(configDir)) {
      if (seenPids.includes(row.pid) || !row.name) {
        continue;
      }
      const index = captured.findIndex((existing) => existing.pid === row.pid);
      if (index === -1) {
        captured.push(row);
      } else {
        captured[index] = row;
      }
    }
  };

  const loop = (async () => {
    while (watching) {
      sweep();
      await sleep(50);
    }
  })();
  return {
    captured,
    sweep,
    stop: async () => {
      watching = false;
      await loop;
    },
  };
}

/** Every pid the CLI holds a registration for right now, across all sessions. */
function registrationPids(configDir: string): number[] {
  const dir = path.join(configDir, 'sessions');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => Number(file.slice(0, -'.json'.length)))
    .filter((pid) => Number.isFinite(pid));
}

// ---------------------------------------------------------------------------
// The mock endpoint
// ---------------------------------------------------------------------------

type Received = { url: string; body: string; isAgent: boolean; tag: string };

/**
 * How the endpoint answers a *title-generation* request this round.
 *
 * `{ title }` is the shape the title prompt asks for; `'unusable'` is prose the
 * CLI cannot read a title out of, which is how a session that never gets an
 * `ai-title` is produced on demand rather than waited for.
 */
type TitleAnswer = { title: string } | 'unusable';

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  /** Opens a fresh recording bucket for one round and returns it. */
  openRound(tag: string, titleAnswer: TitleAnswer): Received[];
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
 * A request is an *agent* request when its body declares tool schemas. The CLI's
 * title generation posts to the same path with the same credential and declares
 * none, which is what separates the two — and the whole of the guard is what
 * happens with the answer to that second request.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  let recording = received;
  let tag = 'setup';
  let titleAnswer: TitleAnswer = { title: GENERATED_TITLE };

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
      recording.push({ url, body, isAgent, tag });
      if (isAgent) {
        answer(textStream(`AC ack ${tag}`));
        return;
      }
      answer(
        titleAnswer === 'unusable'
          ? textStream('I could not think of a title.')
          : textStream(JSON.stringify({ title: titleAnswer.title })),
      );
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    openRound: (nextTag: string, answer: TitleAnswer) => {
      tag = nextTag;
      titleAnswer = answer;
      recording = [];
      return recording;
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
 * The session's transcript, located by the conversation it holds.
 *
 * The provider session id is not known when the first round starts — the app has
 * none yet either, which is exactly why the first round hands over nothing — so
 * the file is identified by the marker only that session's prompt carries. Once
 * a file is found its basename *is* the provider session id, and every later
 * reading uses that. The newest match wins, because a session whose process died
 * on the way up and was booted again leaves an earlier file behind.
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
function titleRows(rows: Array<Record<string, unknown>>): {
  aiTitles: string[];
  customTitles: string[];
} {
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
  userId: number;
  cwd: string;
  configDir: string;
  mock: MockAnthropic;
  synchronizer: ClaudeSessionSynchronizer;
};

async function withGuardHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-peer-title-guard-'));
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
    const user = userDb.createUser(`claude-peer-title-guard-${RUN_TAG}`, 'unused-hash');

    // App-allocated rows, exactly as the session gateway writes them: the id is
    // the app's, the provider id stays NULL until the first round announces one,
    // and the name the user's first message produced is recorded as a *reading*
    // (`transcript_name_source: 'derived'`) rather than an override.
    for (const sessionId of [SESSION_TITLED, SESSION_UNTITLED]) {
      sessionsDb.createAppSession(sessionId, 'claude', tempDirectory, `first message ${sessionId}`);
      getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(sessionId);
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

    await run({
      socket,
      userId: Number(user.id),
      cwd: tempDirectory,
      configDir,
      mock,
      // The provider's own indexer, pointed at this run's provider home so the
      // app-side reading below is produced by the product's real reader.
      synchronizer: new ClaudeSessionSynchronizer({ home: configDir }),
    });
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
    // A per-run process is not in the host snapshots — those carry `pid: null`
    // for it — so the registrations it left behind are what has to be swept, or
    // a leaked CLI outlives the case.
    for (const pid of registrationPids(configDir)) {
      if (existsSync(`/proc/${pid}`)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
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

/** Sends one user turn and waits for its terminal `complete` frame. */
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

type RoundReading = {
  frame: Record<string, unknown>;
  providerSessionId: string | null;
  transcriptFile: string | null;
  registration: CliRegistration | null;
  aiTitles: string[];
  customTitles: string[];
  titleGenRequests: number;
};

/**
 * One round through the app, with the readings that only exist while its process
 * is alive.
 *
 * The registration is read first, because it is the reading with a deadline: a
 * per-run process lingers after its `result` but not forever, and the round
 * after it supersedes it. The transcript is read afterwards, twice if it has to
 * be, because a process flushes its title rows late — an `ai-title` that is
 * absent at the first read is routinely present at the second.
 */
async function runMeasuredRound(
  context: Harness,
  sessionId: string,
  marker: string,
  label: string,
  titleAnswer: TitleAnswer,
): Promise<RoundReading> {
  const bucket = context.mock.openRound(label, titleAnswer);
  const watch = watchRegistrations(context.configDir, registrationPids(context.configDir));
  const frame = await sendRound(context.socket, sessionId, `${marker} round for ${label}`, context.cwd);
  // A last look after the frame, for a process that answered before a poll came
  // round: it is gone a moment later, so this is the end of the window.
  await sleep(400);
  await watch.stop();

  await waitFor(() => Boolean(findTranscriptByMarker(context.configDir, marker)), READ_TIMEOUT_MS, `${label} transcript`);
  const transcriptFile = findTranscriptByMarker(context.configDir, marker);
  const providerSessionId = transcriptFile ? path.basename(transcriptFile, '.jsonl') : null;
  const registration = watch.captured.find((row) => row.sessionId === providerSessionId) ?? null;

  let titles = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
  if (titles.aiTitles.length === 0 && titles.customTitles.length === 0) {
    await sleep(1_500);
    titles = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
  }

  const reading: RoundReading = {
    frame,
    providerSessionId,
    transcriptFile,
    registration,
    aiTitles: titles.aiTitles,
    customTitles: titles.customTitles,
    // Title generation posts to `/v1/messages` itself; every other path (token
    // counting, quota) would answer `{}` above and is not a title request.
    titleGenRequests: bucket.filter(
      (request) => !request.isAgent && request.url.split('?')[0] === '/v1/messages',
    ).length,
  };
  console.log(
    `[readings] round=${label} session=${sessionId} answered=${JSON.stringify(titleAnswer)} ` +
      `exit=${String(frame.exitCode ?? 'none')} providerSessionId=${String(providerSessionId)} ` +
      `titleGenRequests=${reading.titleGenRequests} aiTitles=${JSON.stringify(reading.aiTitles)} ` +
      `customTitles=${JSON.stringify(reading.customTitles)} registration=${JSON.stringify(registration)}`,
  );
  return reading;
}

/**
 * Re-reads one transcript through the product's own indexer and answers what the
 * session row now says the transcript calls it.
 *
 * This is the app-side half of the reading: the bug being guarded against moved
 * `transcript_name_source` to `manual` because the CLI had persisted a
 * `custom-title` — so the column is only meaningful after the reader that writes
 * it has actually run over the file this round produced.
 */
async function transcriptionSourceAfterSync(
  context: Harness,
  sessionId: string,
  transcriptFile: string | null,
): Promise<{ source: string | null; name: string | null }> {
  if (transcriptFile) {
    await context.synchronizer.synchronizeFile(transcriptFile);
  }
  const row = sessionsDb.getSessionById(sessionId);
  return {
    source: (row?.transcript_name_source as string | null) ?? null,
    name: (row?.transcript_name as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

test('a session hands the CLI a title only when it has one', { timeout: 360_000 }, async () => {
  await withGuardHarness(async (context) => {
    // ---------------------------------------------------------------------
    // Leg 0 — the positive control: a session that *does* get a title.
    //
    // Run first so the harness's ability to produce both states is settled
    // before the reading that depends on its absence: the endpoint answers the
    // title request with `{"title": ...}`, the CLI writes the `ai-title`, and
    // the resumed round must hand it over. Without this arm, leg 1's `derived`
    // would be equally consistent with a guard that never hands anything over.
    // ---------------------------------------------------------------------
    const titledFirst = await runMeasuredRound(
      context, SESSION_TITLED, MARKER_TITLED, 'titled-round-1', { title: GENERATED_TITLE },
    );
    assert.notStrictEqual(titledFirst.providerSessionId, null, 'the first round must produce a provider session id');
    assert.strictEqual(
      titledFirst.titleGenRequests > 0,
      true,
      `the title-generation request must reach the endpoint on a first round (saw ${titledFirst.titleGenRequests})`,
    );
    assert.strictEqual(
      titledFirst.aiTitles.includes(GENERATED_TITLE),
      true,
      `the endpoint's title must land in the transcript as an ai-title (aiTitles=${JSON.stringify(titledFirst.aiTitles)})`,
    );
    assert.strictEqual(
      titledFirst.registration?.nameSource,
      'derived',
      `a first round hands over no title, so the process keeps the CLI's own derived name ` +
        `(${JSON.stringify(titledFirst.registration)})`,
    );

    const titledProviderId = titledFirst.providerSessionId as string;
    sessionsDb.assignProviderSessionId(SESSION_TITLED, titledProviderId);

    const titledSecond = await runMeasuredRound(
      context, SESSION_TITLED, MARKER_TITLED, 'titled-round-2', { title: GENERATED_TITLE },
    );
    assert.strictEqual(
      titledSecond.registration?.nameSource,
      'auto',
      `a session with a real title must still hand it over — the guard must not close the road ` +
        `(${JSON.stringify(titledSecond.registration)})`,
    );
    assert.strictEqual(
      titledSecond.registration?.name,
      GENERATED_TITLE,
      `the registered name must be the session's own ai-title byte for byte ` +
        `(registered=${JSON.stringify(titledSecond.registration?.name)} title=${JSON.stringify(GENERATED_TITLE)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 1 — no title, two full rounds, nothing handed over.
    //
    // The premise is read rather than assumed: the title-generation request is
    // asserted to have reached the endpoint (so "no ai-title" is the answer's
    // doing, not a request that never happened) and the transcript is asserted
    // to carry no `ai-title`. Then the resumed round — the first one that *can*
    // hand anything over — must leave the process on the CLI's derived name.
    // ---------------------------------------------------------------------
    const untitledFirst = await runMeasuredRound(
      context, SESSION_UNTITLED, MARKER_UNTITLED, 'untitled-round-1', 'unusable',
    );
    assert.notStrictEqual(untitledFirst.providerSessionId, null, 'the first round must produce a provider session id');
    assert.strictEqual(
      untitledFirst.titleGenRequests > 0,
      true,
      `the premise needs the title request to have been made and refused (saw ${untitledFirst.titleGenRequests})`,
    );
    assert.deepEqual(
      untitledFirst.aiTitles,
      [],
      `the premise needs this session to have no ai-title (aiTitles=${JSON.stringify(untitledFirst.aiTitles)})`,
    );
    assert.strictEqual(
      untitledFirst.registration?.nameSource,
      'derived',
      `a first round hands over no title (${JSON.stringify(untitledFirst.registration)})`,
    );

    const untitledProviderId = untitledFirst.providerSessionId as string;
    sessionsDb.assignProviderSessionId(SESSION_UNTITLED, untitledProviderId);

    const untitledSecond = await runMeasuredRound(
      context, SESSION_UNTITLED, MARKER_UNTITLED, 'untitled-round-2', 'unusable',
    );
    assert.deepEqual(
      untitledSecond.aiTitles,
      [],
      `the session must still have no ai-title on the resumed round (aiTitles=${JSON.stringify(untitledSecond.aiTitles)})`,
    );
    assert.strictEqual(
      untitledSecond.registration?.nameSource,
      'derived',
      `a session with no title must keep the CLI's derived name — handing the ladder's fallback over ` +
        `would freeze the first prompt on the manual rung (${JSON.stringify(untitledSecond.registration)})`,
    );
    assert.deepEqual(
      untitledSecond.customTitles,
      [],
      `no title was handed over, so no custom-title may have been persisted ` +
        `(customTitles=${JSON.stringify(untitledSecond.customTitles)})`,
    );

    const untitledApp = await transcriptionSourceAfterSync(context, SESSION_UNTITLED, untitledSecond.transcriptFile);
    console.log(
      `[readings] app-side session=${SESSION_UNTITLED} transcript_name_source=${JSON.stringify(untitledApp.source)} ` +
        `transcript_name=${JSON.stringify(untitledApp.name)}`,
    );
    assert.strictEqual(
      untitledApp.source,
      'derived',
      `the app-side reading must still be derived after the indexer re-read the transcript ` +
        `(${JSON.stringify(untitledApp)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 2 — a `/rename` is a real title and still travels.
    //
    // The same session, provably without an `ai-title`, renamed through the SDK
    // — the same `custom-title` entry a CLI `/rename` appends. The guard must
    // let it through, and because there is no generated title on this session
    // the string in the registry can only have come from the rename.
    // ---------------------------------------------------------------------
    await renameClaudeSession(untitledProviderId, RENAME_TITLE, { dir: context.cwd });
    const renamed = await runMeasuredRound(
      context, SESSION_UNTITLED, MARKER_UNTITLED, 'untitled-round-3-renamed', 'unusable',
    );
    console.log(
      `[readings] rename session=${SESSION_UNTITLED} renamedTo=${JSON.stringify(RENAME_TITLE)} ` +
        `registered=${JSON.stringify(renamed.registration?.name)} ` +
        `nameSource=${JSON.stringify(renamed.registration?.nameSource)} ` +
        `customTitles=${JSON.stringify(renamed.customTitles)}`,
    );
    assert.strictEqual(
      renamed.registration?.nameSource,
      'auto',
      `a renamed session must still hand its name over (${JSON.stringify(renamed.registration)})`,
    );
    assert.strictEqual(
      renamed.registration?.name,
      RENAME_TITLE,
      `the registered name must be the rename byte for byte ` +
        `(registered=${JSON.stringify(renamed.registration?.name)} rename=${JSON.stringify(RENAME_TITLE)})`,
    );

    const renamedApp = await transcriptionSourceAfterSync(context, SESSION_UNTITLED, renamed.transcriptFile);
    console.log(
      `[readings] app-side session=${SESSION_UNTITLED} transcript_name_source=${JSON.stringify(renamedApp.source)} ` +
        `transcript_name=${JSON.stringify(renamedApp.name)}`,
    );
    assert.strictEqual(
      renamedApp.name,
      RENAME_TITLE,
      `the indexer must read the rename as the session's name (${JSON.stringify(renamedApp)})`,
    );

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    assert.ok(measured < BUDGET_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});
