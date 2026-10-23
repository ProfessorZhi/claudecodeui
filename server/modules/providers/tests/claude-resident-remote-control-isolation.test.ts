// ⛔ 溯源（勿删）：本文件是 goal AC-176 的**判据** —— 常驻进程的 Remote Control 跨机器可达性。
// 权威记录：goals/AC-176-常驻进程的-remote-control-跨机器可达性被强制关闭-信任边界保持在同一-unix-用户.md
// （criterion 即本文件：`npx tsx --tsconfig server/tsconfig.json --test
// server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`）。
//
// 判据在交付树上**真的**起常驻会话（真实 `claude` 二进制 + mock Anthropic 兼容端点 + 临时
// `DATABASE_PATH` / `CLAUDE_CONFIG_DIR`），经**真** `chat.send` 走生产分派，三个变体各写一份
// `<临时 CLAUDE_CONFIG_DIR>/settings.json`：
//   (1) `{"remoteControlAtStartup":true,"isolatePeerMachines":false}` ⇒ 常驻启动**被拒**：可辨
//       code + 界面文案，mock 端点 0 条 `/v1/messages`，进程表 0 个 claude 子进程，快照里没有
//       resident 宿主；
//   (2a) 不含该字段 ⇒ 启动成功，读回传给 SDK 的 `sdkOptions.settings` 逐字含两项，快照**分别**
//       记请求值与检测值（检测值是「未设置」，不是 `false`）；
//   (2b) `{"remoteControlAtStartup":false,"isolatePeerMachines":false}` ⇒ 同样启动成功，同一对读数
//       （检测值在 `false` 变体里是 `false`）。
//
// 为什么是「拒绝」而不是「传 flag settings 就完事」——见 driver 的 Remote Control 一节：E9 §9.7
// 的 `get_settings` 没读到响应，`--settings` 是否压过用户级 settings **本机无读数**。故本条**不得**
// 把「传了 flag settings」当成「远端可达性已关闭」的证据，它只断言「传了这两项」+「检测到开启就拒绝」。
//
// ⚠️ 已知缺口（逐字）：本条只检测用户级 settings；项目级 / 本地级 / 托管级 settings 未读数，是已知缺口。
// 判据不为那三层写断言（见末尾的负向核对）。
//
// 三条红线：
//  ① 一切 settings 读写都指向临时 `CLAUDE_CONFIG_DIR`，**不得**读写用户自己那份 settings（末条负向核对
//     扫的就是本文件自己：没有从 home 拼出来的路径）；
//    判据起子进程时传的 `CLAUDE_CONFIG_DIR` 以 `/proc/<常驻 pid>/environ` 的逐字读数核对。
//  ② 三臂**假形态**必须红，且每臂复用的就是主用例的读数函数（绿 = 判据有洞，先补判据）：
//    (a) 检测到开启仍照常启动；(b) 启动时不传那两项 flag settings；(c) 把请求值当生效值写进快照。
//  ③ 快照里的字段名**不得**出现 `effective` / 「生效」字样：请求值与检测值是两个不同的字段，
//    检测值在开启变体里是 `true` 而请求值恒为 `false`，把两者混为一谈立刻可辨。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { createProviderRuntimeService } from '@/modules/providers/index.js';
import {
  ClaudeResidentHostDriver,
  createSdkResidentProcess,
  readClaudeUserSettings,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeResidentQueryFactory,
  ClaudeUserSettingsReading,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import {
  HOST_BIND_ERROR_CODES,
  createSessionHostManager,
  sessionHostManager,
} from '@/modules/session-hosts/index.js';
import type {
  HostScheduler,
  ProcessHost,
  SessionHostManager,
} from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type {
  AnyRecord,
  ProviderModelEnvRow,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CRITERION_PATH = 'server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts';

const SESSION_ID = 'claude-resident-remote-control-session';
/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'remote-control-custom-model';
const MODEL_SECRET = 'remote-control-model-row-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** How long one turn is given to reach its terminal `complete`. */
const ROUND_TIMEOUT_MS = 60_000;
/** How long a `/proc` reading is retried — environ of a just-exec'd child is briefly unreadable. */
const PROC_TIMEOUT_MS = 20_000;

/**
 * The refusal code this criterion expects, as one member and not as a second list.
 *
 * `HOST_BIND_ERROR_CODES` is what the criterion reads "可辨" through — the
 * assertion in `assertLaunchGateHolds` is a *membership* test against the array
 * the build's union is kept in step with, not against a list typed out here
 * again. This single literal answers the other half of the question ("is it
 * *this* refusal, and not one of the two placement refusals the array already
 * held?"), which no array can answer without the criterion naming the member it
 * is looking for. If the union grows, the array assertion is what keeps this
 * honest; if the member is renamed, this is the one line that has to move.
 */
const REMOTE_CONTROL_REFUSAL_CODE = 'remote-control-enabled';

/** The words the interface copy must carry, quoted from the AC and pinned verbatim. */
const REMOTE_CONTROL_COPY = 'Remote Control 已开启';
const REMOTE_CONTROL_REASON = '以 bypass 运行的常驻进程会被跨机器驱动';

/** The temporary `CLAUDE_CONFIG_DIR` the harness hands the child, under the harness's temp root. */
const CLAUDE_CONFIG_DIR_NAME = 'claude-config';
const SETTINGS_FILE_NAME = 'settings.json';
const CLAUDE_CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';

/** The three variants, as the exact settings files the criterion writes. */
const ENABLING_SETTINGS: Record<string, unknown> = {
  remoteControlAtStartup: true,
  isolatePeerMachines: false,
};
const ABSENT_SETTINGS: Record<string, unknown> = {};
const DISABLED_SETTINGS: Record<string, unknown> = {
  remoteControlAtStartup: false,
  isolatePeerMachines: false,
};

/** One line of this criterion's readings, prefixed so a reader can find them. */
function say(line: string): void {
  console.log(`[remote-control] ${line}`);
}

type Received = { url: string; body: string; authorization: string | undefined; apiKey: string | undefined };

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
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

/** An Anthropic-compatible endpoint that records what it was sent. */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      });
      if (response.writableEnded || response.destroyed) {
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(messageStream());
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** Every `/v1/messages` request — where a turn and the SDK's auxiliary requests both land. */
function messagesRequests(received: Received[]): Received[] {
  return received.filter((request) => request.url.split('?')[0] === '/v1/messages');
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

// ---------------------------
//----------------- THE PROCESS TABLE, READ DIRECTLY ------------
/**
 * One process's environment, or null when `/proc` will not answer for it.
 *
 * A `null` here is not "no variable": it is "this reading could not be taken",
 * and the two are kept apart everywhere below. That is the note
 * `scripts/resident-experiment.mjs` already carries — `/proc/<pid>/environ` is
 * briefly unreadable for a child that has just exec'd — so every consumer waits
 * for a reading rather than treating the first miss as an absence.
 */
function environOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }
}

function environmentValue(environ: string, name: string): string | null {
  for (const entry of environ.split('\0')) {
    if (entry.startsWith(`${name}=`)) {
      return entry.slice(name.length + 1);
    }
  }
  return null;
}

/**
 * Every Claude CLI running under one config directory, counted off the process table.
 *
 * Two filters, and both are load-bearing. The argv signature is the SDK's own
 * launch shape (`--output-format stream-json`) — without it this file's own
 * `node --test` runner, whose argv contains the word "claude" as part of the
 * criterion's path, would be counted. The environment filter is what makes the
 * count a statement about *this* launch: `CLAUDE_CONFIG_DIR` is a temp directory
 * the criterion made, so no other process on the machine can be wearing it.
 */
function claudeChildrenUnder(configDir: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    if (pid === process.pid) {
      continue;
    }
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch {
      continue;
    }
    if (!argv.includes('--output-format') || !argv.includes('stream-json')) {
      continue;
    }
    const environ = environOf(pid);
    if (environ === null) {
      continue;
    }
    if (environmentValue(environ, CLAUDE_CONFIG_DIR_VAR) === configDir) {
      found.push(pid);
    }
  }
  return found.sort((left, right) => left - right);
}

/**
 * The `CLAUDE_CONFIG_DIR` the resident child was really given, printed verbatim.
 *
 * This is the AC's own reading line: the value in `/proc/<pid>/environ` has to
 * be the temp directory the criterion handed the launch, which is what makes
 * "everything under the temp config dir" a measurement rather than a claim about
 * the criterion's own variables.
 */
async function readChildConfigDir(pid: number, expected: string, label: string): Promise<void> {
  let value: string | null = null;
  await waitFor(
    () => {
      const environ = environOf(pid);
      if (environ === null) {
        return false;
      }
      value = environmentValue(environ, CLAUDE_CONFIG_DIR_VAR);
      return value !== null;
    },
    PROC_TIMEOUT_MS,
    `${label}: /proc/${pid}/environ to become readable`,
  );

  assert.notStrictEqual(value, null, `${label}: the child's environ must name a CLAUDE_CONFIG_DIR`);
  assert.strictEqual(
    value,
    expected,
    `${label}: the child must run under the temp config directory this criterion made, not the user's own`,
  );
  console.log(`CLAUDE_CONFIG_DIR 核对（/proc/${pid}/environ）：${value} —— 一致`);
}

// ---------------------------
//----------------- THE THREE READINGS EVERY LEG SHARES ------------
/**
 * The gate's invariant, as one function: refused exactly when the user said on.
 *
 * Both the refusing leg and the two launching legs call it, and so does the fake
 * arm that models "detected but launched anyway" — which is what makes that
 * arm's redness a statement about *this* reading rather than about a second
 * assertion written for the occasion.
 *
 * The settings are read here rather than taken as a boolean because the file is
 * the input the gate decides on: a reader that was handed "enabled" by its caller
 * would be asserting a fact it never checked. `readSettings` is a parameter so
 * the reading is the production file-reader, passed in rather than reimplemented.
 */
function assertLaunchGateHolds(
  userSettingsPath: string,
  refusal: { code: string; message: string; settingsPath: string } | null,
  readSettings: (settingsPath: string) => ClaudeUserSettingsReading,
): void {
  const detected = readSettings(userSettingsPath);
  if (detected.remoteControlAtStartup !== true) {
    assert.strictEqual(
      refusal,
      null,
      `用户级 settings（${userSettingsPath}）没声明 Remote Control 开启 ⇒ 不得有拒绝读数`,
    );
    return;
  }

  assert.ok(
    refusal,
    `用户级 settings（${userSettingsPath}）已开启 Remote Control ⇒ 该次常驻启动必须被拒绝，` +
      '而不是照常拉起一个 bypass 进程',
  );
  assert.ok(
    (HOST_BIND_ERROR_CODES as readonly string[]).includes(refusal.code),
    `拒绝码 "${refusal.code}" 必须是 HOST_BIND_ERROR_CODES 里的成员（可辨），不是自造的词`,
  );
  assert.strictEqual(
    refusal.code,
    REMOTE_CONTROL_REFUSAL_CODE,
    '拒绝码必须是本条这条腿的拒绝，而不是数组里既有的放置类拒绝',
  );
  assert.match(refusal.message, new RegExp(REMOTE_CONTROL_COPY), `界面文案必须含「${REMOTE_CONTROL_COPY}」`);
  assert.match(refusal.message, new RegExp(REMOTE_CONTROL_REASON), `界面文案必须含「${REMOTE_CONTROL_REASON}」`);
  assert.strictEqual(refusal.settingsPath, userSettingsPath, '拒绝必须指名它读的那个 settings 文件');
}

/**
 * The second reading: the two flags the launch handed the SDK.
 *
 * Read off `host.remoteControl.launched`, which the production factory fills from
 * the very option bag it hands `query()` — so this is the launched settings, not
 * a copy of the request. `null` reds on purpose: a launch that recorded nothing
 * is a launch whose bag was never read back.
 */
function assertLaunchedFlags(
  launched: { remoteControlAtStartup?: boolean; isolatePeerMachines?: boolean } | null | undefined,
  label: string,
): void {
  assert.ok(
    launched,
    `${label}: 传给 SDK 的 sdkOptions.settings 必须被读回（null ⇒ 那次启动没带这两项）`,
  );
  assert.strictEqual(
    launched.remoteControlAtStartup,
    false,
    `${label}: 读回的 sdkOptions.settings.remoteControlAtStartup 必须是 false`,
  );
  assert.strictEqual(
    launched.isolatePeerMachines,
    true,
    `${label}: 读回的 sdkOptions.settings.isolatePeerMachines 必须是 true`,
  );
}

/**
 * The third reading: the two snapshot fields, and the absence of a merged one.
 *
 * Three separate claims, because the AC makes three. No field of the
 * Remote-Control record may be named for an *effect* — a name like `effective`
 * or `生效` is the shape a build takes when it collapses the request and the
 * detection into one value, and the collapse is exactly what is forbidden here.
 * `requested` is the two flags this build states, always `{false, true}`.
 * `detected` is the user's own file, key by key, with "the key was not there"
 * carried as `null` rather than folded into `false` — the difference the third
 * leg exists to read.
 */
function assertRequestedAndDetected(
  host: ProcessHost,
  expected: { remoteControlAtStartup: boolean | null; isolatePeerMachines: boolean | null },
  configDir: string,
  label: string,
): void {
  for (const key of Object.keys(host as unknown as Record<string, unknown>)) {
    assert.doesNotMatch(
      key,
      /effective|生效/i,
      `${label}: 宿主快照里不得出现名为 "${key}" 的字段——请求值与检测值不是同一个「生效值」`,
    );
  }

  const record = host.remoteControl;
  assert.ok(record, `${label}: 常驻宿主快照必须记录 Remote Control 的请求值与检测值`);
  for (const key of Object.keys(record as unknown as Record<string, unknown>)) {
    assert.doesNotMatch(
      key,
      /effective|生效/i,
      `${label}: Remote Control 记录里不得出现名为 "${key}" 的字段（请求值与检测值是两个字段）`,
    );
  }

  assert.deepStrictEqual(
    record.requested,
    { remoteControlAtStartup: false, isolatePeerMachines: true },
    `${label}: 请求值恒为这条腿传下去的两项`,
  );
  assert.deepStrictEqual(
    record.detected,
    {
      remoteControlAtStartup: expected.remoteControlAtStartup,
      isolatePeerMachines: expected.isolatePeerMachines,
    },
    `${label}: 检测值必须是检测到的用户级 settings 原值（缺失记「未设置」/null，不是 false）`,
  );
  assert.strictEqual(
    record.settingsPath,
    path.join(configDir, SETTINGS_FILE_NAME),
    `${label}: 检测读数必须指名它读的那个文件，且该文件由临时配置目录拼出`,
  );
}

// ---------------------------
//----------------- THE HARNESS ------------
/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

/** Sends one turn and answers with its terminal `complete` frame. */
async function sendTurn(socket: FakeSocket, content: string, cwd: string): Promise<Record<string, unknown>> {
  const before = completesOf(socket).length;
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId: SESSION_ID,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'default' },
  }));
  await waitFor(() => completesOf(socket).length > before, ROUND_TIMEOUT_MS, `the turn to reach its \`complete\``);
  return completesOf(socket).at(-1) as Record<string, unknown>;
}

type HarnessContext = {
  socket: FakeSocket;
  cwd: string;
  configDir: string;
  settingsPath: string;
  runtime: ReturnType<typeof createProviderRuntimeService>;
  /** The endpoint this leg was started with — carried, not looked up, so no leg can read another's. */
  mock: MockAnthropic;
};

/** The live host serving this criterion's session, as the manager reports it. */
function liveResidentHost(): ProcessHost {
  const host = sessionHostManager
    .snapshot()
    .find((candidate) => candidate.state !== 'closed' && candidate.mode === 'resident');
  assert.ok(host, 'no live resident host is serving this criterion\'s session');
  return host;
}

/**
 * The harness every leg runs inside: temp database, temp Claude config with the
 * variant's own `settings.json`, mock endpoint, and the production dispatch.
 *
 * The runtime is the production `createProviderRuntimeService()`, so the leg that
 * routes a turn is the one the chat handler routes it through — including the
 * `lifecycle_mode` read and the Remote Control gate the driver runs inside it.
 */
async function withRemoteControlHarness(
  mock: MockAnthropic,
  settings: Record<string, unknown>,
  run: (context: HarnessContext) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-remote-control-'));
  const configDir = path.join(tempDirectory, CLAUDE_CONFIG_DIR_NAME);
  const settingsPath = path.join(configDir, SETTINGS_FILE_NAME);
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  let socket: FakeSocket | null = null;
  try {
    // The variant's own user-level settings file, written before anything starts
    // so the gate reads the file this leg is about. The directory is made first
    // because the CLI will want to write its transcript inside it.
    await mkdir(configDir, { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    say(`settings.json 原文（${settingsPath}）：${JSON.stringify(settings)}`);

    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser('claude-resident-remote-control', 'unused-hash');

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Remote Control session', now, now, null);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });
    assert.strictEqual(sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident'), true);
    assert.strictEqual(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');

    socket = createFakeSocket();
    const runtime = createProviderRuntimeService();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    await run({ socket, cwd: tempDirectory, configDir, settingsPath, runtime, mock });
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

// ---------------------------
//----------------- LEG (1): THE REFUSAL ------------
test('(1) 用户级 settings 开启 Remote Control ⇒ 常驻启动被拒，且没有进程、没有请求、没有宿主', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withRemoteControlHarness(mock, ENABLING_SETTINGS, async ({ socket, cwd, configDir, settingsPath, runtime }) => {
      // The gate reads the file the child would have run under, which is this
      // temp directory: asserted rather than assumed, because "the temp dir is
      // what was read" is the whole basis of the negative half below.
      assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, configDir, 'the launch runs under the temp config dir');
      assert.strictEqual(readClaudeUserSettings(settingsPath).remoteControlAtStartup, true, 'the variant is enabled');

      const complete = await sendTurn(socket, 'round one', cwd);
      say(`开启变体：complete exitCode=${String(complete.exitCode)} aborted=${String(complete.aborted)}`);
      assert.strictEqual(complete.exitCode, 1, '被拒的那一轮以失败收场，而不是照常完成');

      const refusal = runtime.remoteControlRefusal('claude', SESSION_ID);
      assertLaunchGateHolds(settingsPath, refusal, readClaudeUserSettings);
      assert.ok(refusal, 'the gate refused, so there is a refusal to read');
      say(`拒绝：code=${refusal.code} settingsPath=${refusal.settingsPath}`);
      say(`拒绝文案：${refusal.message}`);
      assert.ok(
        refusal.settingsPath.startsWith(configDir),
        'the refusal names a file under the temp config dir, never the user\'s own',
      );

      const messages = messagesRequests(mock.received);
      say(`/v1/messages 条数：${messages.length}`);
      assert.strictEqual(messages.length, 0, 'mock 端点必须收到 0 条 /v1/messages');

      const children = claudeChildrenUnder(configDir);
      say(`进程表 claude 子进程：${children.length} 个`);
      assert.deepStrictEqual(children, [], `进程表里不得有以 ${configDir} 为标识的 claude 子进程`);

      // This leg is declared first in the file, so the host table is still empty
      // — no earlier leg has had a chance to leave a closed one behind. That is
      // what lets the reading be "no resident host in the snapshot" literally,
      // and not "no *live* resident host".
      const hosts = sessionHostManager.snapshot();
      const residents = hosts.filter((host) => host.mode === 'resident');
      assert.deepStrictEqual(residents, [], '被拒的启动不得在快照里留下任何 resident 宿主');
      const forSession = hosts.filter((host) => host.bindings.has(SESSION_ID));
      assert.deepStrictEqual(forSession, [], '被拒的启动不得为该会话留下任何宿主');
      say(`快照：hosts=${hosts.length} resident=${residents.length} forSession=${forSession.length}`);
    });
  } finally {
    await mock.close();
  }
});

// ---------------------------
//----------------- LEG (2a)/(2b): THE TWO LAUNCHING VARIANTS ------------
/**
 * The readings both launching variants owe, in one place.
 *
 * Written once and called twice because the two legs differ in exactly one
 * input — the settings file — while the AC asks the same four things of each.
 * The detection expectation is a parameter for the same reason: it is the one
 * value the file changes.
 */
async function assertLaunchesWithFlags(
  context: HarnessContext,
  expected: { remoteControlAtStartup: boolean | null; isolatePeerMachines: boolean | null },
  label: string,
): Promise<ProcessHost> {
  const { socket, cwd, configDir, settingsPath, runtime } = context;

  const before = messagesRequests(context.mock.received).length;
  const complete = await sendTurn(socket, `turn for ${label}`, cwd);
  say(`${label}：complete exitCode=${String(complete.exitCode)} aborted=${String(complete.aborted)}`);
  assert.strictEqual(complete.exitCode, 0, `${label}: 未开启时那一轮必须真的跑通`);

  const refusal = runtime.remoteControlRefusal('claude', SESSION_ID);
  assertLaunchGateHolds(settingsPath, refusal, readClaudeUserSettings);
  say(`${label}：拒绝读数=${refusal === null ? 'null（放行）' : refusal.code}`);

  const host = liveResidentHost();
  assertLaunchedFlags(host.remoteControl?.launched, label);
  assertRequestedAndDetected(host, expected, configDir, label);
  say(`${label}：读回 sdkOptions.settings=${JSON.stringify(host.remoteControl?.launched)}`);
  say(
    `${label}：快照 requested=${JSON.stringify(host.remoteControl?.requested)} ` +
      `detected=${JSON.stringify(host.remoteControl?.detected)}`,
  );

  // The positive control the refusal leg leans on: the same counter that reads 0
  // in leg (1) reads a child here, so its 0 there is a reading rather than a
  // filter that can never match. Retried, because environ of a just-exec'd child
  // is briefly unreadable and a miss is not an absence.
  await waitFor(
    () => claudeChildrenUnder(configDir).length >= 1,
    PROC_TIMEOUT_MS,
    `${label}: a claude child under ${configDir} to appear in the process table`,
  );
  say(`${label}：进程表 claude 子进程=${claudeChildrenUnder(configDir).length} 个`);
  assert.ok(host.pid !== null && host.pid > 0, `${label}: the resident host carries a real pid`);
  await readChildConfigDir(host.pid as number, configDir, label);

  const requests = messagesRequests(context.mock.received).slice(before);
  assert.ok(requests.length >= 1, `${label}: the turn really went through the mock endpoint`);
  for (const request of requests) {
    assert.strictEqual(request.authorization, `Bearer ${MODEL_SECRET}`, `${label}: the model entry credential is used`);
    assert.ok(!request.body.includes(HOST_SENTINEL), `${label}: the host key must not appear in any request body`);
  }

  // Leave nothing behind for the next leg's snapshot readings.
  sessionHostManager.closeHost(host.hostId, 'user');
  return host;
}

test('(2a) 用户 settings 不含 remoteControlAtStartup ⇒ 启动成功，两项 flag settings 逐字读回', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withRemoteControlHarness(mock, ABSENT_SETTINGS, async (context) => {
      // The file exists and simply does not state the key: the detection must
      // read "not stated", which is what makes the `null` in the snapshot a
      // distinct value rather than a synonym for `false`.
      assert.strictEqual(
        readClaudeUserSettings(context.settingsPath).remoteControlAtStartup,
        null,
        'the variant states no remoteControlAtStartup',
      );
      await assertLaunchesWithFlags(
        context,
        { remoteControlAtStartup: null, isolatePeerMachines: null },
        '不含该字段变体',
      );
    });
  } finally {
    await mock.close();
  }
});

test('(2b) 用户 settings 为 remoteControlAtStartup:false ⇒ 同样启动成功，检测值读到 false', { timeout: 120_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await withRemoteControlHarness(mock, DISABLED_SETTINGS, async (context) => {
      assert.strictEqual(
        readClaudeUserSettings(context.settingsPath).remoteControlAtStartup,
        false,
        'the variant states remoteControlAtStartup: false',
      );
      // `isolatePeerMachines` is stated `false` here while the request is always
      // `true`, so the two field groups are shown to be independent on this leg
      // — a single field could not carry both.
      await assertLaunchesWithFlags(
        context,
        { remoteControlAtStartup: false, isolatePeerMachines: false },
        'false 变体',
      );
    });
  } finally {
    await mock.close();
  }
});

// ---------------------------
//----------------- FAKE ARM (a): DETECTED, LAUNCHED ANYWAY ------------
/** A manager clock whose deadlines are queue entries and whose `now` is a number. */
type FakeClock = HostScheduler & { now(): number };

function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    schedule() {
      return () => undefined;
    },
  };
}

/** A pid above `pid_max`: it names no process, so the arm's host can never be mistaken for a live one. */
const UNREACHABLE_PID = 4_194_305;

/** A prompt iterable that never yields and never finishes — the factory only forwards it. */
function idlePrompt(): AsyncIterable<AnyRecord> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<AnyRecord>>(() => undefined),
    }),
  };
}

/**
 * A query whose stream never yields and never finishes.
 *
 * One stub for every scripted arm, because the *stream* is not what any of them
 * measures: the arms read the option bag the production factory builds and hands
 * this reply, and an idle stream is what keeps the driver's read loop parked
 * instead of calling `reportExit` and closing the host underneath the reading.
 */
function idleQuery(): ClaudeResidentQuery {
  return {
    [Symbol.asyncIterator]: () => idlePrompt()[Symbol.asyncIterator](),
    interrupt: async () => undefined,
    close: () => undefined,
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
  };
}

/**
 * A scripted resident process: the production factory with only its query replaced.
 *
 * The same shape `claude-resident-permissions.test.ts` uses, and for the same
 * reason — the option bag has to be the production builder's, while the CLI
 * itself must not be involved.
 */
function createScriptedProcess(): ClaudeResidentProcessFactory {
  const query = idleQuery();
  return (input) => {
    const built = createSdkResidentProcess(input, {
      createQuery: (() => query) as ClaudeResidentQueryFactory,
    });
    return {
      query: built.query,
      pid: UNREACHABLE_PID,
      writeRaw: built.writeRaw,
      launchSettings: built.launchSettings,
    } satisfies ClaudeResidentProcess;
  };
}

/** The runtime's own turn inputs, stubbed to the facts the driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createWriter(): ProviderRuntimeWriter {
  return { send: () => undefined, setSessionId: () => undefined, userId: 1 };
}

/**
 * The database fact the two *production-launch* arms bring themselves.
 *
 * Arms (3) and (4) drive the production launch (`createSdkResidentProcess` →
 * `buildResidentSdkOptions` → `mapCliOptionsToSDK`), and that path resolves the
 * model library's launch spec on its way to the SDK option bag — a read of the
 * `provider_models` table (`findCustomProviderModelByModelId`). Both arms build
 * the launch *outside* `withRemoteControlHarness`, so they do not inherit its
 * temp `DATABASE_PATH`: without one of their own they read whichever
 * `database/auth.db` the checkout happens to have. On a checkout whose
 * environment database was never migrated that file holds only `app_config`, so
 * the read throws `no such table: provider_models` before the launch can open a
 * host — the arm then reds on the checkout's database state rather than on the
 * mutation it measures.
 *
 * This is the criterion *owning* that fact instead of inheriting it: a migrated
 * database in a temp directory, made the ambient `DATABASE_PATH` for the run and
 * torn down after. The checkout's own `database/auth.db` is never touched.
 */
async function withMigratedDatabase(run: () => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-arm-db-'));
  const saved = process.env.DATABASE_PATH;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (saved === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = saved;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('(3) 假形态 (a)：检测到开启仍照常启动 ⇒ 门的读数必须红', { timeout: 120_000 }, async () => {
  await withMigratedDatabase(runFakeArmA);
});

/** Arm (3)'s body, run against a migrated temp database (see `withMigratedDatabase`). */
async function runFakeArmA(): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-gate-arm-'));
  const configDir = path.join(tempDirectory, CLAUDE_CONFIG_DIR_NAME);
  const settingsPath = path.join(configDir, SETTINGS_FILE_NAME);
  /** Where the mis-wired gate looks instead: a file that says nothing. */
  const elsewherePath = path.join(tempDirectory, 'not-the-user-settings.json');
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  let manager: SessionHostManager | null = null;
  try {
    // The user-level file really says on — this is the fact the arm is about.
    await mkdir(configDir, { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(ENABLING_SETTINGS)}\n`, 'utf8');
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const clock = createFakeClock();
    manager = createSessionHostManager({ now: () => clock.now(), scheduler: clock });
    const driver = new ClaudeResidentHostDriver({
      host: manager,
      notifyBackgroundWork: () => undefined,
      notifyUnattendedWork: () => undefined,
      notifyRunStopped: () => undefined,
      createProcess: createScriptedProcess(),
      now: () => clock.now(),
      // The mutation, through the seam the driver documents for exactly this:
      // the gate reads something other than the settings the process runs under,
      // so a launch proceeds while the user-level file is still enabled.
      userSettingsPath: elsewherePath,
    });

    let runError: unknown = null;
    const runPromise = driver
      .run(
        SESSION_ID,
        { command: 'arm (a)', options: { cwd: tempDirectory, model: MODEL_ID, sessionId: SESSION_ID } },
        createWriter(),
        CONTEXT,
      )
      .catch((error: unknown) => {
        runError = error;
      });

    await waitFor(
      () => manager !== null && manager.snapshot().some((host) => host.mode === 'resident' && host.state !== 'closed'),
      PROC_TIMEOUT_MS,
      'the mutated build to open a resident host despite the enabled user settings',
    );

    // Positive control: the arm is only interesting because the launch really
    // happened. Without this, "no refusal" could be read off a run that died
    // before the gate ever ran.
    assert.strictEqual(runError, null, 'the mutated gate must let the launch through, not refuse it');
    const host = manager.snapshot().find((candidate) => candidate.mode === 'resident' && candidate.state !== 'closed');
    say(`假形态 (a)：尽管 ${settingsPath} 说开启，仍起了常驻宿主 ${host?.hostId ?? '(none)'}`);

    assert.throws(
      () => assertLaunchGateHolds(settingsPath, driver.remoteControlRefusal(SESSION_ID), readClaudeUserSettings),
      /必须被拒绝/,
      '检测到开启却照常启动，必须把门的读数打红',
    );

    // Leave the run parked rather than settled: the scripted stream never ends,
    // so awaiting it would wait forever. The catch above already owns its result.
    void runPromise;
  } finally {
    if (manager) {
      for (const host of manager.snapshot()) {
        if (host.state !== 'closed') {
          manager.closeHost(host.hostId, 'server-shutdown');
        }
      }
    }
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// ---------------------------
//----------------- FAKE ARMS (b) AND (c): THE LAUNCH AND THE SNAPSHOT ------------
/**
 * One production launch, built with whatever flags the arm hands it.
 *
 * `createQuery` is called eagerly by the factory — the bag it is handed *is* the
 * launch — so the stub is installed rather than made to throw: the reading under
 * test is `launchSettings`, which the factory reports off that same bag.
 */
function buildLaunch(remoteControlFlags?: { remoteControlAtStartup: boolean; isolatePeerMachines: boolean }) {
  const built = createSdkResidentProcess(
    {
      prompt: idlePrompt(),
      options: { cwd: process.cwd(), model: MODEL_ID } as AnyRecord,
      ...(remoteControlFlags ? { remoteControlFlags } : {}),
    },
    { createQuery: (() => idleQuery()) as ClaudeResidentQueryFactory },
  );
  return built.launchSettings;
}

test('(4) 假形态 (b)：启动时不传那两项 flag settings ⇒ 读回的读数必须红', { timeout: 60_000 }, async () => {
  await withMigratedDatabase(runFakeArmB);
});

/** Arm (4)'s body, run against a migrated temp database (see `withMigratedDatabase`). */
async function runFakeArmB(): Promise<void> {
  // Both levers, because the reading has to red on both of them: a build that
  // stated nothing, and a build that stated the wrong pair. A reading that only
  // checked presence would pass the second, which is the single-lever fix this
  // arm exists to catch.
  const statedNothing = buildLaunch();
  say(`假形态 (b)：不传 flags ⇒ 读回=${JSON.stringify(statedNothing)}`);
  assert.throws(
    () => assertLaunchedFlags(statedNothing, 'fake (b) 不传 flags'),
    /必须被读回/,
    '启动时不传那两项 flag settings，必须把 flag 读数打红',
  );

  const statedWrong = buildLaunch({ remoteControlAtStartup: true, isolatePeerMachines: false });
  say(`假形态 (b)：传错值 ⇒ 读回=${JSON.stringify(statedWrong)}`);
  assert.throws(
    () => assertLaunchedFlags(statedWrong, 'fake (b) 传错值'),
    /必须是 false/,
    '把两项的取值写反，必须把 flag 读数打红',
  );

  // The genuine bag, through the same production builder, passes the same
  // reading — so the two throws above are about the values and not about a
  // reading that can never be satisfied.
  assertLaunchedFlags(buildLaunch({ remoteControlAtStartup: false, isolatePeerMachines: true }), 'genuine');
}

test('(5) 假形态 (c)：把请求值当生效值写进快照 ⇒ 两个字段的读数必须红', { timeout: 60_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-snapshot-arm-'));
  const configDir = path.join(tempDirectory, CLAUDE_CONFIG_DIR_NAME);
  const settingsPath = path.join(configDir, SETTINGS_FILE_NAME);
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(ENABLING_SETTINGS)}\n`, 'utf8');

    // The discriminating case, as the AC states it: the detection can be `true`
    // (from a file that enables Remote Control) while the request is always
    // `false`. A single field serving both cannot represent that, which is the
    // hole this arm's shape would open.
    const enabling = readClaudeUserSettings(settingsPath);
    const base = { hostId: 'snapshot-arm', mode: 'resident', state: 'open', pid: UNREACHABLE_PID } as unknown as ProcessHost;
    const genuine = {
      ...base,
      remoteControl: {
        requested: { remoteControlAtStartup: false, isolatePeerMachines: true },
        detected: {
          remoteControlAtStartup: enabling.remoteControlAtStartup,
          isolatePeerMachines: enabling.isolatePeerMachines,
        },
        settingsPath,
        launched: { remoteControlAtStartup: false, isolatePeerMachines: true },
      },
    } as unknown as ProcessHost;
    say(
      `假形态 (c) 的判别读数：检测值 remoteControlAtStartup=${String(enabling.remoteControlAtStartup)} ` +
        '而请求值恒为 false',
    );
    assert.strictEqual(enabling.remoteControlAtStartup, true, 'the enabling file states remoteControlAtStartup: true');
    assert.strictEqual(genuine.remoteControl?.requested.remoteControlAtStartup, false, 'the request is the other value');

    // Positive control: the genuine pair passes the reading, so the three throws
    // below are about the mutated shapes and not about a reading that always reds.
    assertRequestedAndDetected(genuine, { remoteControlAtStartup: true, isolatePeerMachines: false }, configDir, 'genuine');

    const withEffectiveName = {
      ...base,
      remoteControl: {
        remoteControlEffective: { remoteControlAtStartup: false, isolatePeerMachines: true },
        settingsPath,
        launched: null,
      },
    } as unknown as ProcessHost;
    assert.throws(
      () => assertRequestedAndDetected(withEffectiveName, { remoteControlAtStartup: true, isolatePeerMachines: false }, configDir, 'fake (c) effective'),
      /不得出现名为 "remoteControlEffective"/,
      '一个带 effective 名字的字段，必须把读数打红',
    );

    const withLocalisedName = {
      ...base,
      remoteControl: {
        生效值: { remoteControlAtStartup: false, isolatePeerMachines: true },
        settingsPath,
        launched: null,
      },
    } as unknown as ProcessHost;
    assert.throws(
      () => assertRequestedAndDetected(withLocalisedName, { remoteControlAtStartup: true, isolatePeerMachines: false }, configDir, 'fake (c) 生效值'),
      /不得出现名为 "生效值"/,
      '一个带「生效值」名字的字段，必须把读数打红',
    );

    const oneFieldForBoth = {
      ...base,
      remoteControl: {
        requestAndDetected: { remoteControlAtStartup: false, isolatePeerMachines: true },
        settingsPath,
        launched: null,
      },
    } as unknown as ProcessHost;
    assert.throws(
      () => assertRequestedAndDetected(oneFieldForBoth, { remoteControlAtStartup: true, isolatePeerMachines: false }, configDir, 'fake (c) 单字段'),
      /检测值必须是检测到的用户级 settings 原值|请求值恒为/,
      '一个字段同时充当请求值与检测值，必须把读数打红',
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// ---------------------------
//----------------- THE CRITERION'S OWN NEGATIVE CHECKS ------------
/**
 * Whether one path looks like it was built out of the user's home directory.
 *
 * The needles are assembled rather than written out, so this check does not
 * itself contain the thing it forbids — the same reason a `grep` for a word has
 * to exclude its own pattern.
 */
function mentionsUserLevelPath(source: string): string[] {
  const needles = ['homedir' + '(', '.claude' + path.posix.sep + SETTINGS_FILE_NAME];
  return needles.filter((needle) => source.includes(needle));
}

test('(6) 判据自身的负向核对：不碰真实用户级 settings，且写明「只覆盖用户级」这个已知缺口', () => {
  const source = readFileSync(new URL(`file://${path.join(REPO_ROOT, CRITERION_PATH)}`), 'utf8');

  const hits = mentionsUserLevelPath(source);
  assert.deepStrictEqual(hits, [], `判据里不得出现拼真实用户级 settings 路径的写法，命中：${hits.join(', ')}`);

  // 逐字：本条只检测用户级 settings；项目级 / 本地级 / 托管级 settings 未读数，是已知缺口。
  assert.match(source, /本条只检测用户级 settings；项目级 \/ 本地级 \/ 托管级 settings 未读数，是已知缺口/);

  // 不为那三层写断言：它们的文件名一次都不该出现。
  const tiers = ['managed-' + SETTINGS_FILE_NAME, 'settings.local' + '.json'];
  for (const tier of tiers) {
    assert.ok(!source.includes(tier), `判据不得为「${tier}」写断言——那三层未读数是已知缺口`);
  }

  say('判据自身的负向核对：无真实用户级 settings 路径、无三层 settings 断言、已知缺口已逐字写明');
});

test('(7) 判据命令逐字含文件路径，不用 glob', () => {
  assert.ok(!CRITERION_PATH.includes('*'), 'the criterion path is literal');
  assert.ok(CRITERION_PATH.endsWith('.test.ts'), 'the criterion is a file, not a glob');
  say(`判据命令：npx tsx --tsconfig server/tsconfig.json --test ${CRITERION_PATH}`);
});
