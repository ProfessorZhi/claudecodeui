/**
 * Scenario driver shared by the AC-155 baseline recorder and its criterion.
 *
 * Every reading this file produces goes through the production path: the real
 * `handleChatConnection` dispatcher (which owns `chat.send` / `chat.abort` /
 * `chat.subscribe`), the real `chatRunRegistry`, and the production
 * `providerRuntimeService` singleton. Only each provider's *process* is forged —
 * codex by mocking the SDK's `Codex.prototype`, cursor and opencode by a fake
 * executable placed earlier on `PATH`, claude by a fake CLI at `CLAUDE_CLI_PATH`
 * — so "client-visible frames" below means the bytes a browser socket would
 * have received, not a look-alike.
 *
 * Deliberately free of any import of `@/modules/session-hosts`: the baseline is
 * recorded on the tree that predates the per-run wrapper, where that module
 * does not exist yet, and this file is what the recorder copies over there.
 */
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Codex } from '@openai/codex-sdk';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import {
  chatRunRegistry,
  connectedClients,
  handleChatConnection,
  WS_OPEN_STATE,
} from '@/modules/websocket/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The committed baseline this driver replays against. */
export const FIXTURE_PATH = path.join(HERE, 'fixtures', 'per-run-frame-baseline.json');

export const PROVIDER_IDS = ['claude', 'codex', 'cursor', 'opencode'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const SCENARIO_IDS = ['turn', 'abort', 'busy', 'replay'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** One frame exactly as the client socket received it. */
export type Frame = Record<string, unknown>;
export type FrameSequence = Frame[];

/**
 * The last frame each forged process emits before it reaches the gate.
 *
 * It is the driver's synchronisation point: a single stdout stream (or one
 * async generator) delivers frames in order, so observing the second marker
 * proves every earlier frame has already been observed too. Waiting on it
 * instead of on a fixed sleep is what keeps a recording from being truncated —
 * a short read would look like a shorter but perfectly plausible sequence.
 */
export const FIRST_CONTENT = 'parity barri.er alpha';
export const BARRIER_CONTENT = 'parity barri.er omega';

/**
 * A mid-stream `lastSeq` for the replay scenario.
 *
 * Every forged stream emits at least two frames before its gate, so this is
 * strictly inside the buffered prefix and the replay is never the degenerate
 * "client has seen nothing" case.
 */
export const MID_STREAM_LAST_SEQ = 1;

/**
 * The beat the driver pins for a scenario, in milliseconds.
 *
 * Long enough that no drive can live to see one: the comparison is about the
 * frames a run lifecycle accounts for, and a liveness beat is not one of them.
 */
const PARITY_HEARTBEAT_INTERVAL_MS = 600_000;

// ---------------------------
//----------------- FRAME PROJECTION ------------
/**
 * Fields dropped before comparison, each because the frozen baseline and a live
 * run cannot be made to agree on it — never to make a comparison pass:
 *
 * - `timestamp`: minted from the wall clock by `createNormalizedMessage` (and
 *   by the gateway's own `protocol_error` / `chat_subscribed` frames), so two
 *   runs a second apart can never carry the same value.
 * - `id`: minted per frame as `<kind>_<randomUUID()>` by
 *   `createNormalizedMessage` when the provider row carries no id of its own,
 *   which none of the forged streams do.
 * - `runId`: the run registry mints one `randomUUID()` per run and stamps it on
 *   every frame that run emits, so no two drives of a scenario can carry the
 *   same value — the same instability as `id`, for the same reason (a fresh
 *   random id per run), on a field the per-run identity work added.
 * - `bootId`, `rev`, `heartbeatIntervalMs`, `unreachableAfterMs`, `phase`,
 *   `toolName`: the activity announcement the websocket module spreads onto the
 *   `chat_subscribed` hello. The baseline is a recording of a tree that predates
 *   that announcement — and it must stay one, because its provenance (AC5) is
 *   "recorded before the host wrapper" and the recorder refuses to rewrite a
 *   fixture on a tree that carries the wrapper — so no baseline frame can hold
 *   these keys, and they are dropped as the group the announcement added.
 *   `bootId` is in any case a per-process `randomUUID()`, the same instability
 *   as `runId`; `phase`/`toolName` are the turn-phase reading the announcement
 *   later grew (the fields a browser's activity dock renders), which likewise no
 *   pre-announcement baseline frame can carry.
 *
 * `kind` and `seq` are never dropped, and no whole frame is ever dropped:
 * frame count and order are compared strictly, one frame at a time. Any further
 * field the four forges turn out not to hold stable is only added here together
 * with the reading that forced it — the recorder refuses to write a baseline it
 * cannot reproduce byte for byte.
 */
export const UNSTABLE_FRAME_FIELDS = [
  'id',
  'timestamp',
  'runId',
  'bootId',
  'rev',
  'heartbeatIntervalMs',
  'unreachableAfterMs',
  'phase',
  'toolName',
] as const;

export function projectFrame(frame: Frame): Frame {
  const projected: Frame = {};
  for (const [key, value] of Object.entries(frame)) {
    if ((UNSTABLE_FRAME_FIELDS as readonly string[]).includes(key)) {
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

export function projectFrames(frames: FrameSequence): FrameSequence {
  return frames.map(projectFrame);
}

// ---------------------------
//----------------- FRAME COMPARISON ------------
export type FrameDiff = {
  equal: boolean;
  /** Index of the first frame the baseline holds and the live run does not. */
  missingIndex: number | null;
  /** Index of the first frame the live run holds and the baseline does not. */
  extraIndex: number | null;
  /** Human-readable verdict naming the offending frame, or null when equal. */
  reason: string | null;
};

function describeFrame(index: number, frame: Frame | undefined): string {
  return frame === undefined ? `#${index} <absent>` : `#${index} ${JSON.stringify(frame)}`;
}

/**
 * Compares a recorded sequence against a freshly driven one.
 *
 * The first divergence is located before it is classified, treating "this
 * sequence ran out" as a divergence like any other. Classifying on length alone
 * was wrong for the case that matters most: a refusal vanishing from the middle
 * of a busy sequence leaves the live run one frame short, and a length-only
 * check blamed the last frame — reporting a lost terminal `complete` when what
 * actually went missing was the `RUN_IN_PROGRESS` frame two positions earlier.
 * Naming the wrong frame is worse than naming none, because the reader believes
 * it.
 */
export function compareFrames(baseline: FrameSequence, actual: FrameSequence): FrameDiff {
  const shared = Math.min(baseline.length, actual.length);
  let divergence = shared;
  for (let index = 0; index < shared; index += 1) {
    if (JSON.stringify(baseline[index]) !== JSON.stringify(actual[index])) {
      divergence = index;
      break;
    }
  }

  if (divergence === baseline.length && baseline.length === actual.length) {
    return { equal: true, missingIndex: null, extraIndex: null, reason: null };
  }

  if (actual.length < baseline.length) {
    return {
      equal: false,
      missingIndex: divergence,
      extraIndex: null,
      reason: `missing frame at ${describeFrame(divergence, baseline[divergence])}`,
    };
  }
  if (actual.length > baseline.length) {
    return {
      equal: false,
      missingIndex: null,
      extraIndex: divergence,
      reason: `extra frame at ${describeFrame(divergence, actual[divergence])}`,
    };
  }

  return {
    equal: false,
    missingIndex: null,
    extraIndex: null,
    reason: `frame differs at #${divergence}: baseline ${JSON.stringify(
      baseline[divergence],
    )} live ${JSON.stringify(actual[divergence])}`,
  };
}

// ---------------------------
//----------------- SOCKET ------------
export type FakeSocket = EventEmitter & {
  readyState: number;
  frames: Frame[];
  send: (data: string) => void;
};

/** The client end of the chat websocket: an EventEmitter that keeps every frame. */
export function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = WS_OPEN_STATE;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as Frame);
  };
  return socket;
}

/**
 * Connects a socket through the real dispatcher and returns a sender for it.
 *
 * The socket is registered with `connectedClients` by the dispatcher itself and
 * then dropped from it again: that set is the fan-out list for *unrelated*
 * broadcasts (`session_upserted`, fired asynchronously the moment a runtime
 * announces its provider-native id). Those are not part of any run's frame
 * stream, they land at a time that depends on how fast an unrelated promise
 * resolves, and leaving them in would put a frame in the comparison that no run
 * lifecycle can account for. The chat path itself does not read the set — a run
 * writes to its own writer's audience — so muting the fan-out changes nothing
 * the run sends.
 *
 * `userId` must be a row that exists in the scenario's database: a terminal run
 * reads notification preferences for its owner, and that read inserts a defaults
 * row behind a foreign key. A missing user would otherwise append a spurious
 * `error` frame to the very stream under measurement — and, on the providers
 * whose run-stopped notification fires from a child-process exit handler with no
 * catch, take the whole process down with it.
 */
export function connectSocket(socket: FakeSocket, userId: number): (frame: Frame) => Promise<void> {
  handleChatConnection(
    socket as never,
    { user: { id: userId } } as never,
    { runtime: providerRuntimeService },
  );
  connectedClients.delete(socket as never);

  const handleMessage = socket.listeners('message')[0] as unknown as (
    rawMessage: unknown,
  ) => Promise<void>;
  return (frame: Frame) => handleMessage(JSON.stringify(frame));
}

// ---------------------------
//----------------- PROVIDER FORGES ------------
type CodexGate = {
  wait: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
};

function createCodexGate(): CodexGate {
  let released = false;
  const waiters: Array<() => void> = [];

  return {
    wait(signal?: AbortSignal): Promise<void> {
      if (released || signal?.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    release(): void {
      released = true;
      for (const resolve of waiters.splice(0)) {
        resolve();
      }
    },
  };
}

const CODEX_PROVIDER_SESSION_ID = 'codex-parity-1';

/**
 * A codex thread whose stream is forged, with the gate before its terminal event.
 *
 * No `usage` is reported, so no `token_budget` frame can be appended after the
 * barrier — every frame the client sees is one a turn lifecycle accounts for.
 */
function createCodexThread(gate: CodexGate) {
  return {
    id: CODEX_PROVIDER_SESSION_ID,
    async runStreamed(_input: unknown, options?: { signal?: AbortSignal }) {
      return {
        events: (async function* streamEvents() {
          yield { type: 'thread.started', thread_id: CODEX_PROVIDER_SESSION_ID };
          yield {
            type: 'item.completed',
            item: { id: 'item-alpha', type: 'agent_message', text: FIRST_CONTENT },
          };
          yield { type: 'item.completed', item: { type: 'agent_message', text: BARRIER_CONTENT } };
          await gate.wait(options?.signal);
          // An aborted run must not go on to emit a terminal event of its own —
          // the abort path already sent the client's `complete`.
          if (options?.signal?.aborted) {
            return;
          }
          yield { type: 'turn.completed' };
        })(),
      };
    },
  };
}

/**
 * Installs one provider's forged process.
 *
 * `releaseOnAbort` marks the single forge whose gate lives in-process rather
 * than in a killable child: codex's async generator has to be let go before the
 * run loop can observe the abort at all.
 */
type ProviderForge = {
  install: () => Promise<void>;
  uninstall: () => void;
  release: () => void;
  releaseOnAbort: boolean;
};

function createCodexForge(gate: CodexGate): ProviderForge {
  const prototype = Codex.prototype as unknown as Record<string, unknown>;
  const originalStartThread = prototype.startThread;
  const originalResumeThread = prototype.resumeThread;
  const forgeThread = () => createCodexThread(gate) as never;

  return {
    async install() {
      prototype.startThread = forgeThread;
      prototype.resumeThread = forgeThread;
    },
    uninstall() {
      prototype.startThread = originalStartThread;
      prototype.resumeThread = originalResumeThread;
    },
    release: () => gate.release(),
    releaseOnAbort: true,
  };
}

async function writeExecutable(directory: string, name: string, source: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const scriptPath = path.join(directory, name);
  await writeFile(scriptPath, source, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Shared preamble for the forged CLIs.
 *
 * `waitForRelease` polls for a file the driver writes when a scenario wants the
 * process to finish. It is a file rather than a signal because the runtime owns
 * the child handle and the driver never sees the pid. The 15s ceiling is a leak
 * bound, not a synchronisation: it keeps a scenario that deliberately never
 * releases (an aborted child) from parking a node process forever, and no
 * released run ever waits on it.
 */
const CLI_PRELUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const FIRST = ${JSON.stringify(FIRST_CONTENT)};
const BARRIER = ${JSON.stringify(BARRIER_CONTENT)};
const GATE_CEILING_MS = 15000;
const waitForRelease = () => new Promise((resolve) => {
  const release = process.env.PER_RUN_PARITY_RELEASE;
  if (!release) { resolve(); return; }
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(release) || Date.now() - startedAt > GATE_CEILING_MS) {
      clearInterval(timer);
      resolve();
    }
  }, 10);
});
`;

/**
 * Answers an installation probe.
 *
 * cursor's and opencode's runtimes report "CLI is not installed" — as an `error`
 * frame on the run's own stream — when a post-exit `isProviderInstalled()` probe
 * finds no executable. A real CLI answers `--version` instantly; a forge that
 * only knows how to stream a turn makes that probe time out and fabricates an
 * error frame that no run lifecycle accounts for, which is exactly the kind of
 * frame this comparison must not carry.
 */
const VERSION_GUARD = `if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write('parity-fake 1.0.0\\n');
  process.exit(0);
}
`;

const CURSOR_PROVIDER_SESSION_ID = 'cursor-parity-1';
const CURSOR_FAKE_SOURCE = `${CLI_PRELUDE}${VERSION_GUARD}
process.stdin.resume();
(async () => {
  out({ type: 'system', subtype: 'init', session_id: '${CURSOR_PROVIDER_SESSION_ID}', model: 'parity-model', cwd: process.cwd() });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: FIRST }] } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: BARRIER }] } });
  await waitForRelease();
  out({ type: 'result', subtype: 'success', session_id: '${CURSOR_PROVIDER_SESSION_ID}' });
})();
`;

const OPENCODE_PROVIDER_SESSION_ID = 'opencode-parity-1';
const OPENCODE_FAKE_SOURCE = `${CLI_PRELUDE}${VERSION_GUARD}
process.stdin.resume();
(async () => {
  out({ type: 'text', sessionID: '${OPENCODE_PROVIDER_SESSION_ID}', text: FIRST });
  out({ type: 'text', sessionID: '${OPENCODE_PROVIDER_SESSION_ID}', text: BARRIER });
  await waitForRelease();
  out({ type: 'step_finish', sessionID: '${OPENCODE_PROVIDER_SESSION_ID}' });
})();
`;

/**
 * Fake Claude Code CLI speaking the SDK's stream-json protocol.
 *
 * The gate sits between the assistant turn and the `result` line, so a run can
 * be observed mid-turn. `result` is what the runtime turns into the client's
 * terminal `complete`, and the CLI then exits when the runtime closes stdin —
 * which it does either on `result` or, for an aborted run, when the abort path
 * releases the held prompt stream. No `usage` is reported, so no `token_budget`
 * frame can be emitted after the barrier.
 */
const CLAUDE_PROVIDER_SESSION_ID = 'claude-parity-1';
const CLAUDE_FAKE_SOURCE = `${CLI_PRELUDE}
const sid = '${CLAUDE_PROVIDER_SESSION_ID}';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
      // A real CLI stops the turn when the SDK interrupts it. Without this the
      // fake would sit at its gate until the leak ceiling, holding the run's
      // promise open for a quarter of a minute on an aborted turn.
      if ((message.request || {}).subtype === 'interrupt') {
        setTimeout(() => process.exit(0), 20);
      }
    }
  }
});
process.stdin.on('end', () => { setTimeout(() => process.exit(0), 20); });
(async () => {
  await delay(20);
  out({ type: 'system', subtype: 'init', session_id: sid, tools: [], mcp_servers: [], model: 'parity-model', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', cwd: process.cwd(), agents: [], output_style: 'default', uuid: 'parity-uuid-1' });
  await delay(20);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: FIRST }] }, uuid: 'parity-uuid-2' });
  await delay(20);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: BARRIER }] }, uuid: 'parity-uuid-3' });
  await waitForRelease();
  out({ type: 'result', subtype: 'success', session_id: sid, is_error: false, result: 'ok', duration_ms: 1, num_turns: 1, total_cost_usd: 0, uuid: 'parity-uuid-4' });
})();
`;

function createCliForge(provider: 'cursor' | 'opencode' | 'claude', root: string): ProviderForge {
  const binDirectory = path.join(root, `${provider}-bin`);
  const releaseFile = path.join(root, 'gate-release');
  const previousPath = process.env.PATH;
  const previousCliPath = process.env.CLAUDE_CLI_PATH;
  const previousRelease = process.env.PER_RUN_PARITY_RELEASE;

  return {
    async install() {
      if (provider === 'claude') {
        process.env.CLAUDE_CLI_PATH = await writeExecutable(
          binDirectory,
          'claude',
          CLAUDE_FAKE_SOURCE,
        );
      } else {
        const source = provider === 'cursor' ? CURSOR_FAKE_SOURCE : OPENCODE_FAKE_SOURCE;
        const name = provider === 'cursor' ? 'cursor-agent' : 'opencode';
        await writeExecutable(binDirectory, name, source);
        process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ''}`;
      }
      process.env.PER_RUN_PARITY_RELEASE = releaseFile;
    },
    uninstall() {
      if (provider === 'claude') {
        if (previousCliPath === undefined) {
          delete process.env.CLAUDE_CLI_PATH;
        } else {
          process.env.CLAUDE_CLI_PATH = previousCliPath;
        }
      } else {
        process.env.PATH = previousPath;
      }
      if (previousRelease === undefined) {
        delete process.env.PER_RUN_PARITY_RELEASE;
      } else {
        process.env.PER_RUN_PARITY_RELEASE = previousRelease;
      }
    },
    release() {
      void writeFile(releaseFile, 'release', 'utf8');
    },
    releaseOnAbort: false,
  };
}

/**
 * `PATH` and `CLAUDE_CLI_PATH` are process-wide, so a scenario must install,
 * drive and uninstall exactly one forge at a time — which is why the runner
 * loops sequentially rather than fanning out.
 */
function createForge(provider: ProviderId, root: string, gate: CodexGate): ProviderForge {
  if (provider === 'codex') {
    return createCodexForge(gate);
  }
  return createCliForge(provider, root);
}

// ---------------------------
//----------------- SCENARIO RUNNER ------------
export type InFlightContext = {
  provider: ProviderId;
  scenario: ScenarioId;
  sessionId: string;
  /** Frames the observed socket had received when the gate was still closed. */
  frames: FrameSequence;
  /** The registry's own sequence counter at that same moment. */
  runLastSeq: number;
};

export type ScenarioHooks = {
  /**
   * Runs while the provider process is held at its gate — the only window in
   * which "a run is in flight" is true of the real system.
   */
  onInFlight?: (context: InFlightContext) => void | Promise<void>;
};

export type ScenarioRun = {
  provider: ProviderId;
  scenario: ScenarioId;
  sessionId: string;
  /** Raw frames of the observed socket; for `replay`, of the second socket. */
  frames: FrameSequence;
};

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function sessionIdFor(provider: ProviderId, scenario: ScenarioId): string {
  return `${provider}-${scenario}-parity`;
}

/**
 * Drives one (provider, scenario) pair to completion and returns the frames the
 * client end of the websocket saw.
 *
 * The four scenarios are the four shapes a chat client can observe: an ordinary
 * turn, a turn cancelled mid-flight, a second send while the first is still
 * running, and a reconnect that replays from a mid-stream `lastSeq`. Every leg
 * advances by observing frames (never by sleeping), so a slow machine reads the
 * same sequence as a fast one.
 */
export async function runScenario(
  provider: ProviderId,
  scenario: ScenarioId,
  hooks: ScenarioHooks = {},
): Promise<ScenarioRun> {
  const sessionId = sessionIdFor(provider, scenario);
  const root = await mkdtemp(path.join(os.tmpdir(), `parity-${provider}-${scenario}-`));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHeartbeatInterval = process.env.ACTIVITY_HEARTBEAT_INTERVAL_MS;
  const gate = createCodexGate();
  const forge = createForge(provider, root, gate);
  const socket = createFakeSocket();
  const observer = createFakeSocket();

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'parity.db');
  // The activity beat is a liveness frame, not a run frame. Like the unrelated
  // `session_upserted` broadcasts muted in `connectSocket`, it must not land in
  // the sequence under measurement: a `replay` drive that outran the shipped
  // beat would otherwise pick up an `activity.heartbeat` frame no run lifecycle
  // accounts for. Pushing the beat past any scenario's wall clock keeps the
  // comparison about run frames only. The override is a shipped knob, so this
  // still drives the production gateway.
  process.env.ACTIVITY_HEARTBEAT_INTERVAL_MS = String(PARITY_HEARTBEAT_INTERVAL_MS);
  await initializeDatabase();
  const userId = Number(userDb.createUser('parity', 'parity').id);

  const observed = scenario === 'replay' ? observer : socket;

  try {
    sessionsDb.createAppSession(sessionId, provider, root, `parity ${provider} ${scenario}`);
    await forge.install();

    const sendFrame = connectSocket(socket, userId);
    const inFlight = async () => {
      await waitFor(
        () => socket.frames.some((frame) => JSON.stringify(frame).includes(BARRIER_CONTENT)),
        `the ${provider}/${scenario} barrier frame`,
      );
      await hooks.onInFlight?.({
        provider,
        scenario,
        sessionId,
        frames: socket.frames,
        runLastSeq: chatRunRegistry.getRun(sessionId)?.lastSeq ?? 0,
      });
    };

    if (scenario === 'turn') {
      const send = sendFrame({ type: 'chat.send', sessionId, content: 'parity turn' });
      await inFlight();
      forge.release();
      await send;
    } else if (scenario === 'abort') {
      const send = sendFrame({ type: 'chat.send', sessionId, content: 'parity abort' });
      await inFlight();
      await sendFrame({ type: 'chat.abort', sessionId });
      // The gate is only load-bearing for the in-process forge; a child process
      // is stopped by the abort itself.
      if (forge.releaseOnAbort) {
        forge.release();
      }
      await send;
    } else if (scenario === 'busy') {
      const send = sendFrame({ type: 'chat.send', sessionId, content: 'parity busy first' });
      await inFlight();
      await sendFrame({ type: 'chat.send', sessionId, content: 'parity busy second' });
      forge.release();
      await send;
    } else {
      const send = sendFrame({ type: 'chat.send', sessionId, content: 'parity replay' });
      await inFlight();
      const sendOnObserver = connectSocket(observer, userId);
      await sendOnObserver({
        type: 'chat.subscribe',
        sessions: [{ sessionId, lastSeq: MID_STREAM_LAST_SEQ }],
      });
      forge.release();
      await send;
    }

    return { provider, scenario, sessionId, frames: observed.frames };
  } finally {
    forge.uninstall();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousHeartbeatInterval === undefined) {
      delete process.env.ACTIVITY_HEARTBEAT_INTERVAL_MS;
    } else {
      process.env.ACTIVITY_HEARTBEAT_INTERVAL_MS = previousHeartbeatInterval;
    }
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------
//----------------- BASELINE ------------
export type BaselineRecord = {
  provider: ProviderId;
  scenario: ScenarioId;
  frames: FrameSequence;
};

export type Baseline = {
  /** The commit the baseline was recorded on — the tree without the wrapper. */
  recordedAtCommit: string;
  recordedAt: string;
  providers: ProviderId[];
  scenarios: ScenarioId[];
  records: BaselineRecord[];
};

/** Reads the committed baseline, or null when it has not been recorded yet. */
export async function readBaseline(): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Baseline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
