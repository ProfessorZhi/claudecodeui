// ⛔ 溯源（勿删）：本文件是 goal AC-161 的**判据** —— Claude 常驻进程跨轮存活。判据在交付树上真的
// 起一个**真实** `claude` 二进制（真 CLI + mock Anthropic 兼容端点 + 临时 `DATABASE_PATH` /
// `CLAUDE_CONFIG_DIR`），经**真** `chat.send` 在同一个常驻会话上连发三轮，逐轮读出同一个 pid/hostId；
// 第 2 轮进行中 `chat.abort` 后该 pid 仍存活并接住第 3 轮；`POST /api/session-hosts/:sessionId/close`
// 后进程**真的**消失且宿主 `closeReason` 为 `user`。权威记录：
// goals/AC-161-常驻进程跨轮存活-连续三轮-pid-不变-中止当前一轮不杀进程-关闭后进程退出.md
// （criterion 即本文件）。
//
// 三条红线：
//  ① **进程级 60 秒预算守卫**：超时打印预算与实测墙钟并 `exit 3`，**不是** node:test 的 case
//    failure（`timeout` 选项做不到这件事）。负形态在同一文件内以子运行（`budget=1ms`）真跑一次。
//  ② 两臂**假形态**必须红，且两臂复用的就是主用例的读数函数（绿 = 判据有洞，先补判据）：
//    (a) 每轮 `--resume` 重启新进程 ⇒ pid 读数必须红；(b) abort 杀进程 ⇒ 存活读数必须红。
//  ③ 「退出」必须是 stdin EOF 换来的真退出，不是被 kill 掩盖：第三段以 `/proc/<pid>` 的读数为准，
//    `closeReason === 'user'` 只是同一个决定在宿主记录上的投影。
//
// e2e 配方照 AC-025 的 `model-gateway-end-to-end.test.ts`：mock 端点按**请求体**识别轮次 —— 一轮的
// 请求体带的是它累计到该轮的用户话轮，故按「带哪几轮」判轮，而**不是**按「body 里写了哪个模型名」：
// SDK 的辅助请求（标题等）同样打到 `/v1/messages`、凭证相同，但不带累计对话，所以任何轮签名都不
// 匹配它，而它*写*的模型名却随运行环境变（缺 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 时 CLI 回落到会话
// 模型），模型名判轮会让判据的结论取决于判据跑在谁的 env 里 —— 详见 `roundRequests`。模型条目提供
// 端点与凭证，宿主 key 不得泄漏。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { createProviderRuntimeService } from '@/modules/providers/index.js';
import {
  ClaudeResidentHostDriver,
  createSdkResidentProcess,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeResidentQueryFactory,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { AnyRecord, ProviderModelEnvRow, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CRITERION_PATH = 'server/modules/providers/tests/claude-resident-process.test.ts';
/** The graded invocation, so a sub-run reads this file exactly as the grader does. */
const TSX_PREFIX = ['tsx', '--tsconfig', 'server/tsconfig.json', '--test'];

const SESSION_ID = 'claude-resident-process-session';
/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'resident-custom-model';
const MODEL_SECRET = 'resident-model-row-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** How long one round is given to reach its `complete`. */
const ROUND_TIMEOUT_MS = 45_000;
/** How long the process is given to leave after stdin EOF — the close route's own window. */
const EXIT_TIMEOUT_MS = 20_000;

/**
 * The process-level budget, and the whole point of it being process-level.
 *
 * node:test's `timeout` option turns a slow test into a case failure; the goal
 * asks this criterion for an `exit 3` from the process itself, with the budget
 * and the measured wall clock printed. `CLAUDE_RESIDENT_BUDGET_MS` exists so the
 * negative control below can really exercise the guard with a 1 ms budget
 * instead of asserting that a `setTimeout` was installed.
 */
const BUDGET_MS = Number(process.env.CLAUDE_RESIDENT_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_RESIDENT_BUDGET_MS)
  : 60_000;
/** Set in the negative control's child, which is there to be killed by the budget, not to run the suite. */
const BUDGET_CHILD = process.env.CLAUDE_RESIDENT_BUDGET_CHILD === '1';
/** The wall clock starts at import, so `elapsed` covers module load as well as the legs. */
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the resident lifecycle did not finish ` +
      `inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, BUDGET_MS);
// Unref'd so the guard cannot itself hold the process open for the full budget
// once every test has finished.
budgetGuard.unref();

type Received = {
  url: string;
  body: string;
  authorization: string | undefined;
  apiKey: string | undefined;
};

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  /**
   * Holds the next `/v1/messages` reply instead of answering it.
   *
   * This is what makes "abort mid-round" deterministic: the turn is stuck on a
   * response that will not arrive, so the abort lands while the CLI is really
   * working on the turn rather than after it has already finished.
   */
  hold(): void;
  /** Answers every held reply, and stops holding. */
  release(): void;
  close(): Promise<void>;
};

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Minimal valid streaming `/v1/messages` reply. */
function messageStream(): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * An Anthropic-compatible endpoint that records what it was sent.
 *
 * The recording keeps the **body**, because that is what separates a turn's
 * request from the SDK's own title request — both are `POST /v1/messages` with
 * the model entry's credentials, and only the body says which one a reader is
 * looking at.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  const held: Array<() => void> = [];
  let holding = false;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const isMessages = url.split('?')[0] === '/v1/messages';
      received.push({
        url,
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      });

      const answer = () => {
        // An aborted turn destroys the response it was waiting on; answering a
        // destroyed socket would throw inside the server's own callback.
        if (response.writableEnded || response.destroyed) {
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(messageStream());
      };

      if (!isMessages) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (holding) {
        held.push(answer);
        return;
      }
      answer();
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    hold: () => { holding = true; },
    release: () => {
      holding = false;
      for (const answer of held.splice(0)) {
        answer();
      }
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** Every `/v1/messages` request, which is where both a turn and a title request land. */
function messagesRequests(received: Received[]): Received[] {
  return received.filter((request) => request.url.split('?')[0] === '/v1/messages');
}

/** The user turns this criterion sends, in round order. */
const ROUND_CONTENT = ['round one', 'round two', 'round three'];

/**
 * The requests carrying round `n` of this criterion, identified by its own body.
 *
 * A turn resends the whole conversation, so the round a request belongs to is
 * the set of user turns its body carries: round 1's body holds the first turn,
 * round 2's holds the first two, and round 3's holds all three. That accumulation
 * is intrinsic to a turn and is what "identify by request body" has to mean here.
 *
 * It must **not** mean "the body names the session's model". The SDK's auxiliary
 * requests (title generation, the small-model prompts behind it) post to the same
 * path with the same credential and carry no accumulated conversation, so they
 * can never satisfy a round signature — but the model they *name* depends on the
 * ambient environment: with `ANTHROPIC_DEFAULT_HAIKU_MODEL` set (a Claude Code
 * agent shell) they name that model, while in the environment this criterion is
 * actually graded in — the driver anchor's, which sets no such variable — the CLI
 * falls back to the session's own model and such a request reads as a fourth
 * turn. Reading the conversation instead of the model name makes the count the
 * same in both environments, which is the whole reason it is written this way.
 */
function roundRequests(received: Received[], round: number): Received[] {
  const upTo = ROUND_CONTENT.slice(0, round);
  const later = ROUND_CONTENT.slice(round);
  return messagesRequests(received).filter(
    (request) =>
      upTo.every((content) => request.body.includes(content)) &&
      later.every((content) => !request.body.includes(content)),
  );
}

/**
 * Every request carrying one of this criterion's rounds — the three signatures
 * are disjoint by construction, so this is the three rounds and nothing else.
 */
function turnRequests(received: Received[]): Received[] {
  return ROUND_CONTENT.flatMap((_, index) => roundRequests(received, index + 1));
}

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/** Every terminal frame the socket has been sent so far. */
function completesOf(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => frame.kind === 'complete');
}

/**
 * One host reading: who the process is, and whether it is still there.
 *
 * `alive` is read from `/proc` at the moment the reading is taken rather than
 * taken from the host record, because the record cannot say a process died — the
 * point of the third leg is that "the host says closed" and "the process is
 * gone" are two different facts, and only the second is the one that must not be
 * faked by a kill.
 */
type HostReading = {
  hostId: string;
  pid: number | null;
  alive: boolean;
};

/**
 * The process state from `/proc/<pid>/stat`, or null when there is no such pid.
 *
 * A zombie is not alive: it exists as an entry only because nobody has reaped
 * it, and a `Z` here would let "the process ended" pass while the CLI was in
 * fact still in the process table as a corpse. Reading the state rather than
 * mere existence is what keeps the third leg's reading honest — and it is the
 * same helper the `abort kills the process` arm reds.
 */
function processState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return close >= 0 ? stat.slice(close + 2, close + 3) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) {
    return false;
  }
  const state = processState(pid);
  return state !== null && state !== 'Z' && state !== 'X';
}

/** The live host serving this criterion's session, as the manager reports it. */
function liveResidentReading(): HostReading {
  const host = sessionHostManager
    .snapshot()
    .find((candidate) => candidate.state !== 'closed' && candidate.bindings.has(SESSION_ID));
  assert.ok(host, `no live host serves session "${SESSION_ID}"`);
  return { hostId: host.hostId, pid: host.pid, alive: isProcessAlive(host.pid) };
}

/**
 * The host this criterion is about, once the close route has closed it.
 *
 * Addressed by `hostId` rather than found by session id, and read from
 * `snapshot()` rather than held across the close. Both matter: a closed host
 * stays readable for the retention window, so earlier legs' hosts — which hold
 * the same session — are still in the snapshot, and the `closeReason` asserted
 * here has to be this host's, not a neighbour's.
 */
function closedResidentHost(hostId: string) {
  return sessionHostManager.snapshot().find((candidate) => candidate.hostId === hostId) ?? null;
}

/** Polls a predicate, and says what it was waiting for when it gives up. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/**
 * The invariant this whole file is about, as one function.
 *
 * Both the main leg and the `per-round --resume` arm call it, which is what
 * makes the arm's redness a statement about this reading rather than about a
 * second assertion written for the occasion.
 */
function assertSameHostAcrossRounds(readings: HostReading[], label: string): void {
  assert.ok(readings.length >= 3, `${label}: three rounds are needed, got ${readings.length}`);
  const first = readings[0];
  assert.ok(first.pid !== null && first.pid > 0, `${label}: a resident host carries a real pid`);
  readings.forEach((reading, index) => {
    assert.strictEqual(
      reading.pid,
      first.pid,
      `${label}: round ${index + 1} must run on the round-1 pid (${reading.pid} !== ${first.pid})`,
    );
    assert.strictEqual(
      reading.hostId,
      first.hostId,
      `${label}: round ${index + 1} must run on the round-1 host (${reading.hostId} !== ${first.hostId})`,
    );
    assert.ok(reading.alive, `${label}: the process behind round ${index + 1} must still be alive`);
  });
}

/**
 * The second invariant, as one function: an abort stops the turn, not the
 * process.
 *
 * Shared the same way as `assertSameHostAcrossRounds`, and for the same reason:
 * the `abort kills the process` arm calls it through `assert.throws`, so the
 * arm's redness is a statement about this reading and not about an assertion
 * written for the arm.
 */
function assertProcessSurvivesAbort(before: HostReading, after: HostReading): void {
  assert.ok(after.alive, `the process must survive the abort (pid ${before.pid})`);
  assert.strictEqual(after.pid, before.pid, 'the abort must not change the pid');
  assert.strictEqual(after.hostId, before.hostId, 'the abort must not change the host');
}

/**
 * One host reading addressed by id, whether or not the host is still open.
 *
 * `liveResidentReading` cannot serve the arm that kills a host — it asserts a
 * live host exists, so it would red on "no live host" rather than on the survival
 * reading. Reading the record by id keeps the arm's redness aimed at `alive`,
 * which is the fact the mutant changes.
 */
function hostReadingById(hostId: string): HostReading {
  const host = closedResidentHost(hostId);
  return { hostId, pid: host?.pid ?? null, alive: isProcessAlive(host?.pid ?? null) };
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

/** Sends one turn and answers with its terminal `complete` frame. */
async function sendRound(socket: FakeSocket, content: string, cwd: string): Promise<Record<string, unknown>> {
  const before = completesOf(socket).length;
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId: SESSION_ID,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'default' },
  }));
  await waitFor(() => completesOf(socket).length > before, ROUND_TIMEOUT_MS, `round "${content}" to complete`);
  return completesOf(socket).at(-1) as Record<string, unknown>;
}

/**
 * The harness every leg runs inside: temp database, temp Claude config, mock
 * endpoint, and the production dispatch.
 *
 * The runtime is the production `createProviderRuntimeService()`, so the leg
 * that routes a turn is the one the chat handler routes it through — including
 * the `lifecycle_mode` read that decides resident versus per-run.
 */
async function withResidentHarness(
  mock: MockAnthropic,
  run: (context: { socket: FakeSocket; cwd: string; closeBaseUrl: string }) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-process-'));
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  // Mounted exactly as `server/index.ts` mounts it, minus the auth middleware:
  // this leg is about what the close route does to a resident host, and the
  // token check in front of it is the routes criterion's subject, not this one.
  const app = express();
  app.use(express.json());
  app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const closeBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let socket: FakeSocket | null = null;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDirectory, 'claude-config');
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser('claude-resident-process', 'unused-hash');

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Resident process session', now, now, null);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });
    // The mode under test, stored the way the application stores it. The
    // dispatch reads it back through the repository, so this is the same value
    // the chat handler's routing decision is made from.
    assert.strictEqual(sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident'), true);
    assert.strictEqual(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');

    socket = createFakeSocket();
    const runtime = createProviderRuntimeService();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    await run({ socket, cwd: tempDirectory, closeBaseUrl });
  } finally {
    if (socket) {
      for (const host of sessionHostManager.snapshot()) {
        if (host.state !== 'closed') {
          sessionHostManager.closeHost(host.hostId, 'server-shutdown');
        }
      }
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      for (const host of sessionHostManager.snapshot()) {
        if (host.pid && isProcessAlive(host.pid)) {
          try {
            process.kill(host.pid, 'SIGKILL');
          } catch {
            // Already gone between the check and the kill.
          }
        }
      }
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
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

test('(a) three real chat.send rounds on one resident host: same pid, same hostId, one complete each', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withResidentHarness(mock, async ({ socket, cwd }) => {
      const readings: HostReading[] = [];
      const nodes: string[] = [];
      // Terminal frames per round, and the count before the first round, so the
      // tally below says what the transport did rather than what the rounds were
      // expected to do. This socket plays the frontend's role — the client's own
      // `complete` handler is what refreshes the transcript tail — so a round
      // that produced no terminal frame, or two, is visible here.
      const completesBeforeRounds = completesOf(socket).length;
      const completesPerRound: number[] = [];

      for (const content of ['round one', 'round two', 'round three']) {
        const roundStart = completesOf(socket).length;
        const complete = await sendRound(socket, content, cwd);
        completesPerRound.push(completesOf(socket).length - roundStart);
        assert.strictEqual(complete.aborted, false, `"${content}" completed rather than aborting`);
        assert.strictEqual(complete.exitCode, 0, `"${content}" exited cleanly`);
        readings.push(liveResidentReading());
      }

      // The reading gap-fork-from-assistant-reply-anchor's first criterion is
      // about: whether the resident path gives the client a terminal frame at
      // the end of EVERY turn. It decides whether that task has to add a
      // turn-end tail refresh of its own, so it is printed in the form the
      // criterion names rather than left to be inferred from the assertions
      // above — those hold for any non-zero count.
      const completesAfterRounds = completesOf(socket).length - completesBeforeRounds;
      const everyTurn = completesPerRound.every((count) => count === 1);
      console.log(`[resident] completesBeforeRounds=${completesBeforeRounds} completesPerRound=${completesPerRound.join(',')}`);
      console.log(`residentTurnComplete=${everyTurn && completesAfterRounds === completesPerRound.length ? 'every-turn' : 'not-every-turn'}`);

      assertSameHostAcrossRounds(readings, 'three rounds');
      for (const reading of readings) {
        nodes.push(`host=${reading.hostId} pid=${reading.pid} alive=${reading.alive}`);
      }
      console.log(`[resident] three rounds: ${nodes.join(' | ')}`);

      // The turns really went through the mock endpoint, on the model entry's
      // credential — the pid readings above are readings of a process that ran.
      const turns = turnRequests(mock.received);
      console.log(
        `[resident] endpoint: /v1/messages=${messagesRequests(mock.received).length} ` +
          `turns=${turns.length} titleRequestsNotCounted=${messagesRequests(mock.received).length - turns.length}`,
      );
      assert.strictEqual(turns.length, 3, 'each round is one turn request to the mock endpoint');
      for (const request of messagesRequests(mock.received)) {
        assert.strictEqual(request.authorization, `Bearer ${MODEL_SECRET}`, 'the model entry credential is used');
        assert.ok(request.apiKey === undefined, 'no x-api-key header reaches the mock');
        assert.ok(!request.body.includes(HOST_SENTINEL), 'the host key must not appear in any request body');
      }
    });
  } finally {
    await mock.close();
  }
});

test('(b) abort mid-round-2 interrupts the turn; the process survives and round 3 lands on the same pid', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withResidentHarness(mock, async ({ socket, cwd }) => {
      const first = await sendRound(socket, 'round one', cwd);
      assert.strictEqual(first.aborted, false, 'round one completed on its own');
      const beforeAbort = liveResidentReading();

      // Hold the next reply, then send. The turn is now in flight with nothing
      // to answer it, so the abort below lands mid-turn by construction.
      mock.hold();
      const secondRound = sendRound(socket, 'round two', cwd);
      await waitFor(
        () => roundRequests(mock.received, 2).length >= 1,
        ROUND_TIMEOUT_MS,
        'the second turn, with round one behind it, to reach the mock endpoint',
      );

      socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
      const second = await secondRound;
      mock.release();

      assert.strictEqual(second.aborted, true, 'the aborted round reports aborted');
      assert.strictEqual(
        completesOf(socket).filter((frame) => frame.aborted === true).length,
        1,
        'an aborted round has exactly one terminal frame',
      );

      // The reading the goal asks for: the interrupt stopped the turn, not the
      // process. Read here, before round three, so a process that died under the
      // abort cannot be hidden by a later restart.
      const afterAbort = liveResidentReading();
      assertProcessSurvivesAbort(beforeAbort, afterAbort);

      const third = await sendRound(socket, 'round three', cwd);
      assert.strictEqual(third.aborted, false, 'round three completed on its own');
      const afterThird = liveResidentReading();

      assertSameHostAcrossRounds([beforeAbort, afterAbort, afterThird], 'across the abort');
      console.log(
        `[resident] abort: pid=${beforeAbort.pid} aliveAfterAbort=${afterAbort.alive} ` +
          `round3pid=${afterThird.pid}`,
      );
    });
  } finally {
    await mock.close();
  }
});

test('(c) POST /api/session-hosts/:sessionId/close ends the process by stdin EOF, with closeReason user', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withResidentHarness(mock, async ({ socket, cwd, closeBaseUrl }) => {
      const complete = await sendRound(socket, 'round one', cwd);
      assert.strictEqual(complete.aborted, false, 'the round completed before the close');
      const opened = liveResidentReading();
      assert.ok(opened.alive, 'the resident process is running before the close');
      assert.ok(opened.pid !== null && opened.pid > 0, 'the host carries a real pid');

      const response = await fetch(`${closeBaseUrl}/api/session-hosts/${SESSION_ID}/close`, { method: 'POST' });
      const body = (await response.json()) as { success?: boolean; data?: { closeReason?: string } };
      assert.strictEqual(response.status, 200, `the close route answered 200, got ${response.status}`);
      assert.strictEqual(body.success, true, 'the close route reports success');
      assert.strictEqual(body.data?.closeReason, 'user', 'the route reports the reason it recorded');

      // The exit is the EOF's, not a kill's: nothing here signals the process,
      // so the only thing that can end it is the CLI reading stdin to its end.
      const pid = opened.pid as number;
      await waitFor(
        () => !isProcessAlive(pid),
        EXIT_TIMEOUT_MS,
        `pid ${pid} to leave after stdin EOF (nothing signalled it)`,
      );

      const host = closedResidentHost(opened.hostId);
      assert.ok(host, 'the closed host is still readable through the snapshot');
      assert.strictEqual(host.closeReason, 'user', 'the host records the close reason the route used');
      assert.strictEqual(host.pid, opened.pid, 'the closed host is the same host, on the same pid');
      console.log(
        `[resident] close: pid=${pid} stateAfterEof=${processState(pid) ?? 'gone'} closeReason=${host.closeReason}`,
      );
    });
  } finally {
    await mock.close();
  }
});

test('(d) per-round --resume re-spawn makes the shared pid reading go red', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withResidentHarness(mock, async ({ socket, cwd }) => {
      // The mutation is the one the goal names: a process per round, each one
      // resuming the conversation. Expressed through the real seams — the host is
      // closed between rounds, so the next `chat.send` cannot find a live
      // process and has to start one, which is what `--resume` re-spawning is.
      const readings: HostReading[] = [];
      for (const content of ['round one', 'round two', 'round three']) {
        const complete = await sendRound(socket, content, cwd);
        assert.strictEqual(complete.aborted, false, `"${content}" completed`);
        readings.push(liveResidentReading());
        const host = sessionHostManager
          .snapshot()
          .find((candidate) => candidate.state !== 'closed' && candidate.bindings.has(SESSION_ID));
        assert.ok(host, 'the round has a live host to close');
        sessionHostManager.closeHost(host.hostId, 'user');
        await waitFor(
          () => !isProcessAlive(host.pid),
          EXIT_TIMEOUT_MS,
          `the round-${readings.length} process to leave before the next round`,
        );
      }

      console.log(`[resident] fake (a) pids: ${readings.map((reading) => reading.pid).join(' -> ')}`);
      assert.throws(
        () => assertSameHostAcrossRounds(readings, 'fake (a)'),
        /must run on the round-1 pid/,
        're-spawning per round must red the pid reading',
      );
    });
  } finally {
    await mock.close();
  }
});

test('(e) aborting by ending the process makes the survival reading go red', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withResidentHarness(mock, async ({ socket, cwd }) => {
      const first = await sendRound(socket, 'round one', cwd);
      assert.strictEqual(first.aborted, false, 'round one completed on its own');
      const before = liveResidentReading();

      // The same mid-round abort as the main leg, but answered the other way: the
      // mutation is the per-run answer to a stop — close the host, which ends the
      // process. Nothing here is a stand-in for a kill; `closeHost` is the seam
      // the per-run dispatch already uses, and on a resident host its EOF is what
      // takes the process down.
      mock.hold();
      const secondRound = sendRound(socket, 'round two', cwd);
      await waitFor(
        () => roundRequests(mock.received, 2).length >= 1,
        ROUND_TIMEOUT_MS,
        'the second turn, with round one behind it, to reach the mock endpoint',
      );

      const live = sessionHostManager
        .snapshot()
        .find((candidate) => candidate.state !== 'closed' && candidate.bindings.has(SESSION_ID));
      assert.ok(live, 'the round has a live host to close');
      sessionHostManager.closeHost(live.hostId, 'aborted');
      // Let the held reply through at once, so the process that has just lost its
      // stdin is not also left waiting on the endpoint: the reading below is about
      // what the close did, not about how long the CLI waits for a reply that the
      // real end-of-turn path would have delivered already.
      mock.release();
      await waitFor(
        () => !isProcessAlive(before.pid),
        EXIT_TIMEOUT_MS,
        `pid ${before.pid} to leave after the mutated abort`,
      );

      // The round's own frame may or may not arrive through this path; the arm is
      // about the process reading, so its result is drained rather than asserted.
      const second = await Promise.race([
        secondRound,
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000); }),
      ]);

      const after = hostReadingById(before.hostId);
      console.log(
        `[resident] fake (b): pid=${before.pid} -> ${after.pid} alive=${after.alive} ` +
          `(round two frame=${second ? String(second.aborted) : 'none'})`,
      );
      assert.throws(
        () => assertProcessSurvivesAbort(before, after),
        /must survive the abort/,
        'answering an abort by ending the process must red the survival reading',
      );
    });
  } finally {
    await mock.close();
  }
});

// --- (h)–(j) the edit anchor reaches the SDK bag --------------------------
//
// The edit rebuild rests on one thing being true at this boundary: the anchor
// the gateway hands the runtime has to survive the whole way into the launch.
// If it stops short of the SDK bag, the replacement process resumes at the end
// of the conversation and quietly appends the edited turn instead of replacing
// it — which is the defect, wearing the shape of a fix.
//
// Read without a CLI, because the question is about the options object and not
// about what the CLI does with it: the driver here is production's own, behind
// production's own `createSdkResidentProcess`, and only the SDK entry point is
// replaced. The bag captured through it is the object `query()` would have been
// called with — `buildResidentSdkOptions` runs either way.

/** The pid a scripted launch records. Never a live process: nothing spawns here. */
const LAUNCH_PID = 4242;
/** The provider-native session id the launch is told the session has. */
const LAUNCH_PROVIDER_SESSION_ID = 'clarify-launch-provider-session';

/** A query that never yields and never ends, so the read loop stays out of the way. */
function inertQuery(): ClaudeResidentQuery {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<AnyRecord>>(() => undefined),
      return: () => new Promise<IteratorResult<AnyRecord>>(() => undefined),
    }),
    interrupt: async () => undefined,
    close: () => undefined,
  };
}

/** The writer a launch needs; no frames are asserted through it here. */
function launchWriter(): ProviderRuntimeWriter {
  return { send: () => undefined, setSessionId: () => undefined, userId: 1 };
}

const LAUNCH_CONTEXT: ProviderRuntimeContext = {
  // The provider-native id the launch is launched against. Stated by the
  // context rather than by the option bag because that is where the driver
  // reads it — `startResidentHost` overwrites the bag's copy — and a launch
  // that resumed nothing would make every reading below vacuous.
  resolveProviderSessionId: () => LAUNCH_PROVIDER_SESSION_ID,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

/**
 * One resident cold start's SDK bag, for the option bag it was launched with.
 *
 * `startResidentSession` rather than `run`: this reading is about the launch,
 * and a turn would arm a round that a scripted stream never settles. The host
 * it opens is closed again by the caller, so no leg's process outlives it.
 */
async function launchBagFor(options: AnyRecord): Promise<AnyRecord> {
  const built: AnyRecord[] = [];
  const factory: ClaudeResidentProcessFactory = (input) => {
    const process = createSdkResidentProcess(input, {
      createQuery: ((launch: { options: AnyRecord }) => {
        built.push(launch.options);
        return inertQuery();
      }) as ClaudeResidentQueryFactory,
    });
    return { query: process.query, pid: LAUNCH_PID, writeRaw: process.writeRaw } satisfies ClaudeResidentProcess;
  };
  const driver = new ClaudeResidentHostDriver({
    host: sessionHostManager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    notifyUser: () => undefined,
    createProcess: factory,
  });

  const appSessionId = `ac162-launch-${randomUUID()}`;
  const started = await driver.startResidentSession(appSessionId, {
    options: { cwd: process.cwd(), ...options },
    context: LAUNCH_CONTEXT,
  });
  sessionHostManager.closeHost(started.hostId, 'server-shutdown');

  assert.equal(built.length, 1, 'the launch built exactly one SDK bag');
  return built[0];
}

test('(h) a resident launch carries the edit anchor into the SDK bag', { timeout: 60_000 }, async () => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-launch-'));
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  try {
    const bag = await launchBagFor({ resumeAnchorId: 'anchor-before-the-edit' });

    // Both halves, and both are load-bearing: without `resume` the anchor has
    // no session to apply to, and without `resumeSessionAt` the CLI resumes at
    // the end of the transcript rather than at the truncation point.
    assert.equal(
      bag.resume,
      LAUNCH_PROVIDER_SESSION_ID,
      'the launch resumes the same provider session',
    );
    assert.equal(
      bag.resumeSessionAt,
      'anchor-before-the-edit',
      'the launch resumes at the turn the edit keeps',
    );
  } finally {
    if (previousConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test('(i) editing the first prompt launches a resident host that resumes nothing', { timeout: 60_000 }, async () => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-launch-'));
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  try {
    const bag = await launchBagFor({ resumeFromScratch: true, resumeAnchorId: 'stale-anchor' });

    // Nothing precedes the edited turn, so there is no conversation to resume
    // into and no point to resume at. An anchor left over from a previous edit
    // must not survive either: a restart that resumed the branch it was
    // supposed to drop is the defect with an extra step.
    assert.ok(!('resume' in bag), 'a from-scratch launch does not resume a session');
    assert.ok(!('resumeSessionAt' in bag), 'a from-scratch launch does not name an anchor');
  } finally {
    if (previousConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test('(j) an ordinary resident launch states no anchor at all', { timeout: 60_000 }, async () => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-launch-'));
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  try {
    const bag = await launchBagFor({});

    // The ordinary cold start: a resident session whose process is being
    // brought back up resumes its conversation, and nothing about the edit path
    // may change that. The key list is pinned rather than spot-checked because
    // "the anchor changed nothing" is a claim about the whole bag — a
    // pass-through that quietly added a launch-time entry would leave every
    // spot check green.
    assert.equal(bag.resume, LAUNCH_PROVIDER_SESSION_ID, 'an ordinary launch still resumes');
    assert.ok(!('resumeSessionAt' in bag), 'an ordinary launch states no anchor');

    const editOnlyEntries = ['resumeAnchorId', 'resumeFromScratch', 'resumeSessionAt'];
    const unexpected = editOnlyEntries.filter((entry) => entry in bag);
    assert.deepEqual(unexpected, [], 'no edit-path entry leaks into the ordinary bag');
  } finally {
    if (previousConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test('(f) the budget guard is a process exit, not a case failure', { timeout: 120_000 }, async () => {
  // The guard is only worth anything if it really fires, so it is exercised
  // rather than described: this very file is re-run twice with a 1 ms budget.
  // Both runs are needed, and they answer different questions.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete childEnv.NODE_TEST_CONTEXT;
  childEnv.CLAUDE_RESIDENT_BUDGET_MS = '1';
  childEnv.CLAUDE_RESIDENT_BUDGET_CHILD = '1';

  // 1. Under the graded invocation. The file runs in a child of node's own test
  //    runner, so what the guarded process itself exits with is not what the
  //    runner reports — but its reading is on the output, and the reading is
  //    what says the guard fired as a process kill rather than as a case.
  const graded = spawnSync('npx', [...TSX_PREFIX, CRITERION_PATH], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const gradedOutput = `${graded.stdout ?? ''}${graded.stderr ?? ''}`;
  const gradedLine = gradedOutput.split('\n').find((line) => line.includes('[budget] budget=1ms')) ?? '';
  console.log(`[resident] budget child (graded): status=${graded.status} ${gradedLine.trim()}`);
  assert.match(
    gradedLine,
    /\[budget\] budget=1ms elapsed=\d+ms exit=3/,
    'the guard prints the budget and the measured wall clock under the graded invocation',
  );

  // 2. Run directly, where the guarded process *is* the one whose status is read.
  //    This is the shape the goal asks for: the criterion's own process ends
  //    with exit 3, which no `timeout` option on a case can produce.
  const direct = spawnSync('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', CRITERION_PATH], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const directOutput = `${direct.stdout ?? ''}${direct.stderr ?? ''}`;
  const directLine = directOutput.split('\n').find((line) => line.includes('[budget] budget=1ms')) ?? '';
  console.log(`[resident] budget child (direct): status=${direct.status} ${directLine.trim()}`);
  assert.match(directLine, /\[budget\] budget=1ms elapsed=\d+ms exit=3/, 'the guard prints its reading');
  assert.strictEqual(direct.status, 3, 'the guarded process exits 3');
});

test('(g) the whole file finished inside its own budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${BUDGET_MS}ms elapsed=${elapsed}ms exit=0`);
  assert.ok(elapsed < BUDGET_MS, `the criterion finished in ${elapsed}ms, under its ${BUDGET_MS}ms budget`);
});
