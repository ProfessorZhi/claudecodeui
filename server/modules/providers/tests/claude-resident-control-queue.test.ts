// ⛔ 溯源（勿删）：本文件是 goal AC-275 的**判据** —— 真实 `claude` 二进制的常驻驱动经
// **控制服务**（`createChatControlService`，不经 WebSocket）撤回排队消息。四条读数：
//
//   (a) 第一轮在飞时第二次 `control.send` 返回 `queued:true` 与非空 `queuedMessageUuid`，
//       且该 uuid 是**真实驱动**为这条消息交出、`cancelQueuedInput` 认得的那一个 ——
//       与驱动 live state 的最新未开始排队条目、以及 CLI `command_lifecycle.command_uuid`
//       三方相等；
//   (b) 用该 uuid `control.cancelQueued` 得成功判决（驱动词表是 `withdrawn`，AC 措辞写
//       `cancelled`），CLI 报该 uuid `state=cancelled`，且释放首轮并结束后 mock 端点
//       此后**收不到**第二条消息对应的模型请求 —— 那条消息永不成为一轮；
//   (c) 全程宿主 pid/hostId 三次读数相同且经 `/proc` 判存活；
//   (d) 对照臂（正例）：不撤回时，第二条成为**独立的下一轮**，mock 收到含第二条文本的请求。
//
// 权威记录：goals/AC-275-*.md（criterion 即本文件）。做法照 AC-161 的
// `claude-resident-process.test.ts`（真 CLI + mock Anthropic 兼容端点 + 临时 `DATABASE_PATH` /
// `CLAUDE_CONFIG_DIR`，按**请求体**识别轮次，SDK 标题请求不计）与 AC-163 的
// `claude-resident-busy-input.test.ts`（忙时排队/uuid/撤回读数）。
//
// 三条纪律：
//  ① **进程级预算守卫**：超时打印预算与实测墙钟并 `exit 3`，**不是** node:test 的 case failure。
//  ② 读数逐条写下**原始值**（两次返回、驱动队列读数、lifecycle 读数、mock 请求体清单、pid）。
//  ③ (d) 是必须绿的正例对照：没有它，「mock 收不到第二条」可能因判据根本没跑第二条而假绿。
//
// 本文件**不** import/调用 `handleChatConnection`、不构造 socket、不连生产 3001 —— 见文末
// 的自检用例（读自己的源码断言这三条）。
//
// --------------------------- 取假形态记录（AC7，先提交实现再变异）---------------------------
// 三条取假形态各自只改 `claude-host-driver.provider.ts` 一处，跑主用例取其逐字失败行，随后
// `git checkout -- server/modules/providers/list/claude/claude-host-driver.provider.ts` 恢复并重跑绿。
//
// (i) 驱动不交出 uuid —— 在 `queuedInputUuid` 的 live-state guard 之后插入 `return null;`。
//     红：`AssertionError [ERR_ASSERTION]: the busy send must hand back a non-empty uuid from the
//     real driver (got null)`；旁证 `send(withdrawn) … queuedMessageUuid=null`。恢复后绿。
//
// (ii) 撤回只改返回值、不真正让 CLI 取消 —— 在 `cancelQueuedInput` 的 writeRaw guard 之后插入
//      `return 'withdrawn';`（不写控制帧、不等 `cancelled`、不 dropWithdrawnRound）。
//      红：`AssertionError [ERR_ASSERTION]: a withdrawn message must never become a turn
//      (real-turn requests carrying it: 1)`；旁证 `cancelVerdict="withdrawn"`、
//      `withdrawnRealTurns=1 realTurnBodies=[81401,81607] lifecycleCancelled=false` —— 那条消息
//      真的成了独立的下一轮（第二个真实轮请求）。恢复后绿。
//
// (iii) 撤回路径顺带杀进程 —— 在 `dropWithdrawnRound` 的 `state.rounds.splice(index, 1)` 之后
//      对 `state.process.pid` 发 SIGKILL。
//      红：撤回后、任一轮结束前的 pid 读数 `AssertionError [ERR_ASSERTION]: no live host serves
//      session "claude-resident-control-queue-session"`（AC4 的存活读数）。恢复后绿。
//
// 每条都在本仓当前 checkout 上真跑过一次；判据的预算守卫与真实 CLI 相同，未放宽任何断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  providerModelsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { createProviderRuntimeService, providerRegistry } from '@/modules/providers/index.js';
import type { ClaudeResidentHostDriver } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, createChatControlService } from '@/modules/websocket/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CRITERION_PATH = 'server/modules/providers/tests/claude-resident-control-queue.test.ts';

const SESSION_ID = 'claude-resident-control-queue-session';
/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'resident-control-queue-custom-model';
const MODEL_SECRET = 'resident-control-queue-model-row-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** The caller shape the control verbs take. `mcp` and `scheduled` both reach the same service. */
const CALLER = { userId: 1, via: 'mcp' as const };

/** The unique user-turn texts this criterion sends, one per leg. */
const ROUND_ONE_TEXT = 'AC275-ROUND-ONE held while the queue is exercised';
const WITHDRAWN_TEXT = 'AC275-WITHDRAWN never becomes a turn';
const CONTROL_ROUND_TEXT = 'AC275-CONTROL-ROUND held for the positive control';
const CONTROL_QUEUED_TEXT = 'AC275-CONTROL-QUEUED becomes its own turn';

/** Real agent turns are recognised by the request body's size, and by nothing else. */
const REAL_TURN_MIN_BYTES = 10 * 1024;

/**
 * How long any one wait is given.
 *
 * Bounded well below the process budget: a world *without* the behaviour has to sit through the
 * waits that matter, and if they added up to the budget the guard would kill the process before
 * the loss was reported — a red nobody can attribute.
 */
const WAIT_MS = 15_000;
/** How long the mock is watched after the first round ends, to see whether the withdrawn message runs. */
const NEGATIVE_WINDOW_MS = 4_000;

/**
 * The process-level budget: the graded invocation has to exit cleanly inside it, so it is enforced
 * by the process itself and printed with the measured wall clock when it fires.
 */
const BUDGET_MS = Number(process.env.CLAUDE_RESIDENT_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_RESIDENT_BUDGET_MS)
  : 150_000;
/** The wall clock starts at import, so `elapsed` covers module load as well as the legs. */
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the resident control-queue scenario ` +
      `did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, BUDGET_MS);
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
   * Holds every real agent request from now on instead of answering it.
   *
   * The hold is what makes "the first round is in flight" a fact the criterion holds rather than a
   * race it hopes for: the turn is stuck on a response that will not arrive until `release`.
   */
  hold(): void;
  /** Answers every held reply, and stops holding. */
  release(): void;
  close(): Promise<void>;
};

/** A request is a real agent turn when its body is over the size a turn really carries. */
function isRealTurn(request: Received): boolean {
  return request.url.split('?')[0] === '/v1/messages' && Buffer.byteLength(request.body, 'utf8') > REAL_TURN_MIN_BYTES;
}

/** Every `/v1/messages` request, which is where both a turn and a title request land. */
function messagesRequests(received: Received[]): Received[] {
  return received.filter((request) => request.url.split('?')[0] === '/v1/messages');
}

/** Whether any `/v1/messages` request body carries `text` — the sentinel makes this unambiguous. */
function anyRequestCarrying(received: Received[], text: string): boolean {
  return messagesRequests(received).some((request) => request.body.includes(text));
}

/** The number of `/v1/messages` request bodies that carry `text` — the printed quantity. */
function requestCountCarrying(received: Received[], text: string): number {
  return messagesRequests(received).filter((request) => request.body.includes(text)).length;
}

/**
 * The number of **real turns** whose request body carries `text`.
 *
 * The turn question — "did this message become a turn?" — is asked of real turns only. The SDK's
 * auxiliary prompts post to the same `/v1/messages` path with the same credential: a title request
 * built while a message is queued carries that message's text in its own small body (a few KB,
 * against a turn's tens of KB), so counting every `/v1/messages` body would read a title request as
 * the message running. `isRealTurn`'s size rule is what separates the two, exactly as the sibling
 * busy-input criterion uses it.
 */
function realTurnsCarrying(received: Received[], text: string): number {
  return received.filter(isRealTurn).filter((request) => request.body.includes(text)).length;
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

/**
 * An Anthropic-compatible endpoint that records what it was sent.
 *
 * The recording keeps the **body**, because that is what separates a turn's request from the SDK's
 * own title request — both are `POST /v1/messages` with the model entry's credentials, and only
 * the body says which one a reader is looking at. Real turns (by size) are held while `hold()` is
 * on; the SDK's own probes and auxiliary requests are answered at once, so nothing but a real
 * turn can be the thing that stalls a round.
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
      const body = Buffer.concat(chunks).toString('utf8');
      const entry: Received = {
        url,
        body,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      };
      received.push(entry);

      const answer = () => {
        if (response.writableEnded || response.destroyed) {
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(textStream('ok'));
      };

      if (url.split('?')[0] !== '/v1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (holding && isRealTurn(entry)) {
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

/**
 * A reading of the process behind a session, taken from the manager and `/proc`.
 *
 * `alive` is read from `/proc/<pid>/stat` at the moment the reading is taken rather than taken from
 * the host record, because the record cannot say a process died: the point of the pid leg is that a
 * withdrawal must not change which process holds the session, and only the live reading is the fact.
 */
type HostReading = {
  hostId: string;
  pid: number | null;
  alive: boolean;
};

/** The process state from `/proc/<pid>/stat`, or null when there is no such pid. */
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

/** The host driver this criterion reads its readings off. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

/** The session's busy-input reading, or null when the driver is hosting nothing for it. */
function busyReading(): ReturnType<ClaudeResidentHostDriver['busyInputReading']> {
  return residentDriver().busyInputReading(SESSION_ID);
}

/** One queued-input record, as `busyInputReading` reports it. */
type QueuedInput = NonNullable<ReturnType<ClaudeResidentHostDriver['busyInputReading']>>['queuedInputs'][number];

/** The newest queued entry the driver has not started, or null. */
function newestUnstartedInput(): QueuedInput | null {
  const reading = busyReading();
  const unstarted = (reading?.queuedInputs ?? []).filter((input) => input.startedAt === null);
  return unstarted.at(-1) ?? null;
}

/** Polls a predicate, and says what it was waiting for when it gives up. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  console.log(`[readings] waitFor timed out after ${timeoutMs}ms: ${label}`);
  return false;
}

/** Slept for a bounded window, so a "nothing arrived" reading is taken after a real chance to arrive. */
async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

/** One control `send` result, narrowed so its own fields can be read and asserted. */
type SendOutcome = {
  ok: boolean;
  runId?: string;
  queued: boolean;
  queuedMessageUuid: string | null;
  completion?: Promise<unknown>;
  code?: string;
};

type Harness = {
  cwd: string;
  mock: MockAnthropic;
  control: ReturnType<typeof createChatControlService>;
};

/**
 * The harness this criterion runs inside: temp database, temp Claude config, mock endpoint, and the
 * **production control service** wired to the production `createProviderRuntimeService()`.
 *
 * The runtime is the production one, so both the turns and the withdrawal are routed by the same
 * `lifecycle_mode` read the chat handler performs; the control service is the production
 * `createChatControlService`, so the calls below go through the exact seam the WebSocket and MCP
 * adapters drive. No socket is created anywhere in this file.
 *
 * A user row is created before the session, and that is load-bearing rather than decorative: with no
 * user in the database, the resident CLI answers its first turn and then ends, and every later round
 * cold-starts a new process — so "the host survives the withdrawal" could never be read. The
 * mechanism is the resident driver's own session lookup; the observation (no user ⇒ process exits
 * after round one) is why the sibling AC-161/AC-163 harnesses create one too.
 */
async function withHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-control-queue-'));
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );
  const mock = await startMockAnthropic();

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDirectory, 'claude-config');
    // A dead host endpoint, so a run that ignored the model entry can never reach the mock:
    // reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    userDb.createUser('claude-resident-control-queue', 'unused-hash');

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Resident control-queue session', now, now, null);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });
    // The mode under test, stored the way the application stores it.
    assert.strictEqual(sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident'), true);
    assert.strictEqual(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');

    const runtime = createProviderRuntimeService();
    const control = createChatControlService({ runtime });

    await run({ cwd: tempDirectory, mock, control });
  } finally {
    // Hosts are killed *before* they are closed on purpose: closing ends a host's input and then
    // waits out the resident exit grace (~15s), which would outlast the process budget. Every
    // reading is taken before this point, so the abrupt exit costs nothing.
    const killHosts = (): void => {
      for (const host of sessionHostManager.snapshot()) {
        if (host.pid && isProcessAlive(host.pid)) {
          try {
            process.kill(host.pid, 'SIGKILL');
          } catch {
            // Already gone between the check and the kill.
          }
        }
      }
    };
    killHosts();
    for (const host of sessionHostManager.snapshot()) {
      if (host.state !== 'closed') {
        sessionHostManager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await settle(250);
    killHosts();
    chatRunRegistry.clearAll();
    await mock.close();
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

/** Sends one control turn and answers with the raw result, printing it. */
async function controlSend(
  control: ReturnType<typeof createChatControlService>,
  content: string,
  cwd: string,
  leg: string,
): Promise<SendOutcome> {
  const result = (await control.send(CALLER, {
    sessionId: SESSION_ID,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'bypassPermissions' },
    connection: null,
  })) as SendOutcome;
  console.log(
    `[readings] send(${leg}) ok=${String(result.ok)} queued=${String(result.queued)} ` +
      `runId=${String(result.runId)} queuedMessageUuid=${JSON.stringify(result.queuedMessageUuid)}` +
      (result.code ? ` code=${result.code}` : ''),
  );
  return result;
}

test('control service queues and withdraws a real resident process message; pid survives; unwithdrawn one lands', { timeout: 240_000 }, async () => {
  await withHarness(async ({ cwd, mock, control }) => {
    // -------------------------------------------------------------------
    // (a)+(c) — first round in flight; a second control send is queued.
    // -------------------------------------------------------------------
    mock.hold();
    const first = await controlSend(control, ROUND_ONE_TEXT, cwd, 'round-one');
    assert.strictEqual(first.ok, true, `the cold send must register (got ${JSON.stringify(first)})`);
    assert.strictEqual(first.queued, false, 'a cold send with no turn in flight is not queued');

    const roundOneInFlight = await waitFor(
      () => anyRequestCarrying(mock.received, ROUND_ONE_TEXT),
      WAIT_MS,
      "round one's agent request to be in flight and held",
    );
    assert.strictEqual(roundOneInFlight, true, 'round one must really be in flight before the busy send');

    const readingWhileBusy = liveResidentReading();

    const second = await controlSend(control, WITHDRAWN_TEXT, cwd, 'withdrawn');
    assert.strictEqual(second.ok, true, `the busy send must be queued, not refused (got ${JSON.stringify(second)})`);
    assert.strictEqual(second.queued, true, 'a busy control send reports queued');
    assert.ok(
      typeof second.queuedMessageUuid === 'string' && second.queuedMessageUuid.length > 0,
      `the busy send must hand back a non-empty uuid from the real driver (got ${JSON.stringify(second.queuedMessageUuid)})`,
    );
    const queuedMessageUuid = second.queuedMessageUuid as string;

    // The uuid is the driver's own: it equals the newest unstarted entry in the driver's live
    // queue (the same record `busyInputReading` reports), which is the CLI's own `command_uuid`.
    const driverInput = newestUnstartedInput();
    assert.ok(driverInput, 'the driver must have a live unstarted queue entry for the busy send');
    assert.strictEqual(
      driverInput.uuid,
      queuedMessageUuid,
      `the control service's uuid must be the driver queue's uuid (driver=${driverInput.uuid} control=${queuedMessageUuid})`,
    );

    const lifecycleQueued = await waitFor(
      () => (busyReading()?.lifecycle ?? []).some((event) => event.commandUuid === queuedMessageUuid && event.state === 'queued'),
      WAIT_MS,
      "the CLI's `command_lifecycle state=queued` for the busy send's uuid",
    );
    console.log(
      `[readings] (a) controllerUuid=${queuedMessageUuid} driverQueueUuid=${driverInput.uuid} ` +
        `cliLifecycleQueued=${String(lifecycleQueued)} queuedInputs=${JSON.stringify(
          (busyReading()?.queuedInputs ?? []).map((input) => ({ uuid: input.uuid, startedAt: input.startedAt })),
        )}`,
    );
    assert.strictEqual(lifecycleQueued, true, "the CLI must report `command_lifecycle state=queued` for the uuid");

    // -------------------------------------------------------------------
    // (b) — withdraw by that uuid; the message never becomes a turn.
    // -------------------------------------------------------------------
    const verdict = await control.cancelQueued(CALLER, { sessionId: SESSION_ID, messageUuid: queuedMessageUuid });
    console.log(`[readings] (b) cancelVerdict=${JSON.stringify(verdict)} (AC wording 'cancelled' == driver word 'withdrawn')`);
    assert.strictEqual(verdict, 'withdrawn', `the withdrawal must succeed (got ${JSON.stringify(verdict)})`);

    // The process the withdrawal acted on is the same one, still alive: a withdrawal is a queue
    // operation on the running process, never a reason to end it. Read on its own here — one round
    // has not ended yet, so a later reading could not tell "the withdrawal killed it" from "the
    // turn ended it".
    await settle(500);
    const readingAfterCancel = liveResidentReading();
    console.log(`[readings] (c) afterCancel=${JSON.stringify(readingAfterCancel)}`);
    assert.strictEqual(
      readingAfterCancel.alive,
      true,
      `the withdrawal must leave the process alive (pid ${String(readingAfterCancel.pid)})`,
    );

    // Release the first round and let it really end. Awaiting the run's own promise is the
    // "one round ended" signal: the run settles only when its round does.
    mock.release();
    await Promise.race([first.completion, settle(WAIT_MS)]);
    const roundOneEnded = await waitFor(
      () => (busyReading()?.resultTimes.length ?? 0) >= 1,
      WAIT_MS,
      'round one to end',
    );
    assert.strictEqual(roundOneEnded, true, 'round one must end after its held reply is released');

    // The window the withdrawn message would have started its own turn in, had the withdrawal not
    // really removed it from the process's queue. Both readings are taken here — after the first
    // round has ended and the CLI has had its chance to start the queued message — because that is
    // the only moment "it never ran" is a fact about the run rather than about the ordering.
    await settle(NEGATIVE_WINDOW_MS);
    const readingAfterFirstEnd = liveResidentReading();
    const withdrawnRealTurns = realTurnsCarrying(mock.received, WITHDRAWN_TEXT);
    const lifecycleCancelled = (busyReading()?.lifecycle ?? []).some(
      (event) => event.commandUuid === queuedMessageUuid && event.state === 'cancelled',
    );
    console.log(
      `[readings] (b) withdrawnRealTurns=${withdrawnRealTurns} withdrawnAnyRequest=${requestCountCarrying(mock.received, WITHDRAWN_TEXT)} ` +
        `lifecycleCancelled=${String(lifecycleCancelled)} ` +
        `realTurnBodies=${JSON.stringify(mock.received.filter(isRealTurn).map((request) => request.body.length))} ` +
        `allMessagesBodies=${JSON.stringify(messagesRequests(mock.received).map((request) => request.body.length))}`,
    );
    assert.strictEqual(
      withdrawnRealTurns,
      0,
      `a withdrawn message must never become a turn (real-turn requests carrying it: ${withdrawnRealTurns})`,
    );
    // The CLI's own account of the withdrawal, read after the fact. Kept in the criterion because
    // the driver's `withdrawn` verdict is derived from exactly this event (see `cancelQueuedInput`):
    // a withdrawal that never cancelled would be a verdict without the CLI having agreed to it.
    assert.strictEqual(lifecycleCancelled, true, 'the CLI must report the uuid cancelled');

    // -------------------------------------------------------------------
    // (c) — the host process never changed.
    // -------------------------------------------------------------------
    const readings = [readingWhileBusy, readingAfterCancel, readingAfterFirstEnd];
    console.log(`[readings] (c) readings=${JSON.stringify(readings)}`);
    const pid = readings[0].pid;
    assert.ok(pid !== null && pid > 0, 'the resident host must carry a real pid');
    for (const [index, reading] of readings.entries()) {
      assert.strictEqual(reading.pid, pid, `reading ${index + 1} must be the same pid (${reading.pid} !== ${pid})`);
      assert.strictEqual(reading.hostId, readings[0].hostId, `reading ${index + 1} must be the same host`);
      assert.strictEqual(reading.alive, true, `reading ${index + 1} must find the process alive`);
    }

    // -------------------------------------------------------------------
    // (d) — positive control: an unwithdrawn second message becomes its own turn.
    // -------------------------------------------------------------------
    mock.hold();
    const controlRound = await controlSend(control, CONTROL_ROUND_TEXT, cwd, 'control-round');
    assert.strictEqual(controlRound.ok, true, 'the control round must register');
    assert.strictEqual(controlRound.queued, false, 'the control round starts when no turn is in flight');

    const controlRoundInFlight = await waitFor(
      () => anyRequestCarrying(mock.received, CONTROL_ROUND_TEXT),
      WAIT_MS,
      'the control round to be in flight and held',
    );
    assert.strictEqual(controlRoundInFlight, true, 'the control round must be in flight before the busy send');

    const controlQueued = await controlSend(control, CONTROL_QUEUED_TEXT, cwd, 'control-queued');
    assert.strictEqual(controlQueued.ok, true, 'the control busy send must register');
    assert.strictEqual(controlQueued.queued, true, 'the control busy send reports queued');
    assert.ok(
      typeof controlQueued.queuedMessageUuid === 'string' && controlQueued.queuedMessageUuid.length > 0,
      'the control busy send must hand back a non-empty uuid too',
    );
    assert.notStrictEqual(controlQueued.runId, controlRound.runId, 'the two turns must be distinct runs');

    mock.release();
    const controlQueuedLanded = await waitFor(
      () => realTurnsCarrying(mock.received, CONTROL_QUEUED_TEXT) > 0,
      WAIT_MS,
      "the queued message's own turn request",
    );
    await Promise.race([controlQueued.completion, settle(WAIT_MS)]);
    await Promise.race([controlRound.completion, settle(WAIT_MS)]);
    const controlTurnRequests = realTurnsCarrying(mock.received, CONTROL_QUEUED_TEXT);
    console.log(
      `[readings] (d) controlQueuedLanded=${String(controlQueuedLanded)} ` +
        `controlRealTurnsCarrying=${controlTurnRequests} controlRoundRunId=${String(controlRound.runId)} ` +
        `controlQueuedRunId=${String(controlQueued.runId)} resultTimes=${String(busyReading()?.resultTimes.length ?? 0)}`,
    );
    assert.strictEqual(
      controlQueuedLanded,
      true,
      'an unwithdrawn busy message must appear in a model request of its own',
    );
    assert.ok(controlTurnRequests > 0, 'the queued control message must reach the model as a real turn');

    // The two rounds really ran as two turns on one process, not one merged turn: the second turn's
    // request carries the queued text, and the process never restarted under the control leg.
    const controlLegReading = liveResidentReading();
    assert.strictEqual(controlLegReading.hostId, readings[0].hostId, 'the control leg runs on the same host');
    assert.strictEqual(controlLegReading.pid, pid, 'the control leg runs on the same pid');
  });
});

/**
 * AC6 — the criterion drives the control service directly.
 *
 * Read off this file's own source rather than asserted from memory, so the reading cannot drift
 * from the file: no import or call of the WebSocket entry, no socket construction, no `ws` import.
 * The control-service import is the one `modules/websocket` edge there is, and it is the service,
 * not the socket gateway.
 */
test('the criterion drives the control service and constructs no socket', () => {
  const source = readFileSync(path.join(REPO_ROOT, CRITERION_PATH), 'utf8');
  // Comment lines are dropped first: the traceability header states these same prohibitions in
  // prose, and the reading is about code. The forbidden tokens are assembled from pieces so the
  // checker's own source cannot be the thing it finds (a literal here would match itself).
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const socketEntry = ['handleChat', 'Connection'].join('');
  const socketCtor = ['new ', 'WebSocket('].join('');
  const wsModule = ['w', 's'].join('');
  const wsImport = new RegExp(`^\\s*import\\b[^\\n]*['"]${wsModule}['"]`);

  const websocketImports = codeOnly
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line) && line.includes('modules/websocket'));
  console.log(
    `[readings] websocketImports=${JSON.stringify(websocketImports)} ` +
      `socketEntry=${String(codeOnly.includes(socketEntry))} socketCtor=${String(codeOnly.includes(socketCtor))} ` +
      `wsImport=${String(codeOnly.split('\n').some((line) => wsImport.test(line)))}`,
  );

  assert.ok(!codeOnly.includes(socketEntry), 'the criterion must not import or call the WebSocket chat entry');
  assert.ok(!codeOnly.includes(socketCtor), 'the criterion must not construct a socket');
  assert.ok(
    !codeOnly.split('\n').some((line) => wsImport.test(line)),
    "the criterion must not import 'ws'",
  );
  assert.strictEqual(
    websocketImports.length,
    1,
    `the only modules/websocket import must be the control service (got ${JSON.stringify(websocketImports)})`,
  );
  assert.ok(
    websocketImports[0].includes('createChatControlService'),
    'the websocket import must be the control service',
  );
});
