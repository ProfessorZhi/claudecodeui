#!/usr/bin/env node
// resident-smoke.mjs —— AC-170 的取数与取证通道：**只走 HTTP + WS** 的真模型冒烟。
//
// 这条脚本不写产品代码。常驻 driver 与 start/close API 由 AC-161/162/166/169 落地，这里只做一件事：
// 用一个**真服务进程**（临时 DATABASE_PATH、HOST=127.0.0.1、端口 ≠ 3001、杀整个进程组）加一个**真
// 模型**，把 AC 逐字要求的六段从头走一遍，把每段的**原始读数**写进记录文件，交人 yale 判定。
//
// 六段（AC 逐字，标题逐字）：
//   创建常驻会话 → 连续三轮 → 无人轮 → 关闭 → 重启后已关闭 → 再次发送重新拉起
//
// 三条护栏，缺一条就拒绝运行而不写假读数：
//   1. `--database-path` 必须显式给出、落在临时根下、且不等于 shell 导出的真实库。
//   2. 端口一律 `listen(0)` 探得，且断言 ≠ 3001（本机常驻服务；本脚本绝不重启它）。
//   3. AC-161/162/166/169 的 API 面任一段缺失时，走到那一段就点名缺失并 exit 非 0。
//
// 驱动面只有 HTTP 与 WS 两种：AC3 要求「只走这两条」是**机械事实**——本文件里厂商子命令的名字一次都
// 不出现，`fetch(` 与 `new WebSocket` 就是全部出站面。正控制是 `scripts/resident-experiment.mjs`
// （它确实 spawn 真 `claude` 二进制），同一个 grep 在那里非零，证这条读数有分辨力而不是恒真。
//
// 用法：
//   node scripts/resident-smoke.mjs --check-record <记录文件>
//   node scripts/resident-smoke.mjs --database-path <临时目录>/auth.db [--record <记录文件>]
//                                 [--temp-root <目录>]
//
// 退出码：0 = 六段走完且读数落盘；1 = 护栏拒绝、某段拒绝/失败、或 `--check-record` 不合格。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 记录文件里必须齐全的六节，AC 逐字。`--check-record` 按这个数组逐节检查，缺哪节点名哪节。
 * 标题即 id：用整行相等比对（不用 `\b`——中文没有词边界），所以 `关闭` 与 `重启后已关闭` 不会互撞。
 */
export const SECTION_TITLES = [
  '创建常驻会话',
  '连续三轮',
  '无人轮',
  '关闭',
  '重启后已关闭',
  '再次发送重新拉起',
];

/** 本机常驻服务端口；冒烟一律避开它，且全程不重启它。 */
export const PROTECTED_PORT = 3001;

/** 记录文件默认位置。 */
export const DEFAULT_RECORD = path.join(ROOT, 'docs/proposals/claude-resident-sessions-smoke.md');

/** 护栏拒绝。带这个名字的错误一律 exit 1，并且不产生任何读数。 */
export class GuardRefusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GuardRefusal';
  }
}

// ---------------------------------------------------------------------------
// 护栏（纯函数，判据直接调用）
// ---------------------------------------------------------------------------

/**
 * 拒绝理由：`--database-path` 必须显式给出、必须落在临时根下、且不得等于环境里已有的
 * `DATABASE_PATH`。返回解析后的绝对路径。
 *
 * 三条各自独立，因为它们挡的是三件不同的事：缺省 ⇒ 会写到别处；等于环境里的库 ⇒ 会写到真实库；
 * 不在临时根下 ⇒ 会写到任何别的地方。任一条为真都不运行。
 *
 * @param {{ databasePath: string | undefined, ambientDatabasePath?: string | undefined, tempRoot?: string }} input
 * @returns {string} 解析后的绝对路径
 */
export function assertIsolatedDatabasePath({ databasePath, ambientDatabasePath, tempRoot = os.tmpdir() }) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '') {
    throw new GuardRefusal('拒绝运行：必须显式给出临时 DATABASE_PATH（--database-path <临时目录>/auth.db）');
  }
  const resolved = path.resolve(databasePath);
  if (typeof ambientDatabasePath === 'string' && ambientDatabasePath.trim() !== ''
    && resolved === path.resolve(ambientDatabasePath)) {
    throw new GuardRefusal(`拒绝运行：--database-path 等于 shell 导出的 DATABASE_PATH（${resolved}），那是真实库`);
  }
  const root = path.resolve(tempRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new GuardRefusal(`拒绝运行：--database-path（${resolved}）不在临时根 ${root} 下`);
  }
  return resolved;
}

/**
 * 拒绝占用受保护端口。
 *
 * 探得端口之后、起服务之前调用一次，所以「端口 ≠ 3001」是运行期事实而不是事后检查。
 * @param {number} port
 */
export function assertSafePort(port) {
  if (port === PROTECTED_PORT) {
    throw new GuardRefusal(`拒绝运行：端口 ${PROTECTED_PORT} 是本机常驻服务，冒烟一律避开且绝不重启它`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new GuardRefusal(`拒绝运行：端口 ${port} 不在可用范围`);
  }
}

// ---------------------------------------------------------------------------
// 记录文件：解析与逐节检查
// ---------------------------------------------------------------------------

/**
 * 抽出某个小节的正文（从 `## <标题>` 到下一个 `## ` 或文件尾）。
 *
 * 标题整行相等（尾部允许空白），所以 `## 关闭` 不会匹配到 `## 重启后已关闭`。
 * @param {string} text
 * @param {string} title
 * @returns {string | null}
 */
export function extractSection(text, title) {
  const heading = new RegExp(`^##[ \\t]+${escapeRegExp(title)}[ \\t]*$`, 'm');
  const match = heading.exec(text);
  if (match === null) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##[ \t]+/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 逐节检查：每节都要有 `读数：` 与 `结论：` 行。返回缺什么（空数组 = 齐全）。
 *
 * 缺整节与缺某一行是两种不同的缺失，分开报：只报「缺这一节」会让一节写了一半的记录看起来像没写。
 * @param {string} text
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkRecordText(text) {
  /** @type {Array<{ title: string, reason: string }>} */
  const missing = [];
  for (const title of SECTION_TITLES) {
    const section = extractSection(text, title);
    if (section === null) {
      missing.push({ title, reason: '缺整个小节' });
      continue;
    }
    if (!/^读数：/m.test(section)) missing.push({ title, reason: '缺 `读数：` 行' });
    if (!/^结论：/m.test(section)) missing.push({ title, reason: '缺 `结论：` 行' });
  }
  return missing;
}

/**
 * 读文件后逐节检查。文件不存在时把六节全部点名为缺失（AC1 的红态基线就是这一条）。
 * @param {string} filePath
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkRecordFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return SECTION_TITLES.map((title) => ({ title, reason: `记录文件不存在（${filePath}）` }));
  }
  return checkRecordText(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 幂等写入小节：已存在同名 `## <标题>` 就整段替换，否则追加。重跑不会留两份。
 * @param {string} filePath
 * @param {string} title
 * @param {string} body
 */
export function upsertSection(filePath, title, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const heading = `## ${title}\n`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : recordHeader();
  const match = new RegExp(`^##[ \\t]+${escapeRegExp(title)}[ \\t]*$`, 'm').exec(existing);
  let next;
  if (match === null) {
    next = `${existing.replace(/\s*$/, '')}\n\n${heading}\n${body.replace(/^\s+/, '')}\n`;
  } else {
    const rest = existing.slice(match.index);
    const nextHeading = /^##[ \t]+/m.exec(rest.slice(match[0].length));
    const tail = nextHeading === null ? '' : rest.slice(match[0].length + nextHeading.index);
    const head = existing.slice(0, match.index);
    next = `${head}${heading}\n${body.replace(/^\s+/, '')}\n\n${tail}`;
  }
  fs.writeFileSync(filePath, next);
}

/** 记录文件表头：六节由 `upsertSection` 逐段追加，这一行只在文件第一次被写时出现。 */
function recordHeader() {
  return [
    '# Claude 常驻会话 API 面真模型冒烟记录（AC-170）',
    '',
    '本文件由 `scripts/resident-smoke.mjs` 写入：六节各含**原始**读数（宿主快照、pid、`result` 计数、',
    '`seq`、关闭原因、重启后的新 pid）与一行结论。`node scripts/resident-smoke.mjs --check-record <本文件>`',
    '逐节检查 `读数：`/`结论：` 是否齐全。',
    '',
    '**「冒烟验收：通过」那一行只能由人 yale 写入，执行者不得代写。** 执行者只写 `读数：` 与 `结论：` 行。',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 通用读端口（/proc、进程、时间）
// ---------------------------------------------------------------------------

/** @param {number} pid */
export function isAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return state !== null && state !== undefined && state !== 'Z';
  } catch {
    return false;
  }
}

/**
 * `/proc/<pid>/environ` 拆成 `KEY=value` 表；读不到返回 null（刚 exec 完会短暂读不到）。
 * @param {number} pid
 * @returns {Record<string, string> | null}
 */
export function readEnviron(pid) {
  try {
    /** @type {Record<string, string>} */
    const env = {};
    for (const pair of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const eq = pair.indexOf('=');
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 轮询直到谓词为真；超时抛出带上「在等什么」。
 * @param {() => any} predicate
 * @param {number} timeoutMs
 * @param {string} label
 */
export async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时 ${timeoutMs}ms：${label}`);
    await delay(150);
  }
}

/** `listen(0)` 探一个空闲端口，随后立刻关闭监听。AC 要求端口探得而不是写死。 */
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// 真服务进程
// ---------------------------------------------------------------------------

/** 服务进程读数：进程组 leader、真实 server pid、端口、日志、环境、停止入口。 */
export class ServerReading {
  /**
   * @param {{ leaderPid: number, port: number, logPath: string, tempRoot: string }} input
   */
  constructor(input) {
    this.leaderPid = input.leaderPid;
    this.port = input.port;
    this.logPath = input.logPath;
    this.tempRoot = input.tempRoot;
    this.stopped = false;
  }

  /**
   * 真正持有本实例端口的那个进程（`npx` 那层只是包装，`leaderPid` 不是 server）。
   * 读内核表而不是产品自己写的标记文件——见 {@link portOwnerPid}。
   */
  serverPid() {
    return portOwnerPid(this.port);
  }

  logText() {
    try {
      return fs.readFileSync(this.logPath, 'utf8');
    } catch {
      return '';
    }
  }

  /** `/proc/<leaderPid>/environ` 的 `KEY=value` 表；env 在 exec 时继承，包装层的读数是可信的。 */
  environ() {
    return readEnviron(this.leaderPid);
  }

  /**
   * `/proc/<leaderPid>/environ` 的命中行，逐字打印用。
   * @param {string[]} names
   */
  environLines(names) {
    const environ = this.environ() ?? {};
    return names.map((name) => (name in environ ? `${name}=${environ[name]}` : `${name}=（未设置）`));
  }

  /**
   * SIGTERM 进程组 leader，等它整棵子树走干净。
   *
   * 杀的是 `detached` 那次的负 pid，所以 `npx`→`tsx`→server 这条包装链一起收；等待按 leader 判活，
   * 因为包装层退出后 /proc 里就没有这个 pid 了。
   */
  async stop(signal = 'SIGTERM') {
    if (this.stopped) return;
    this.stopped = true;
    try {
      process.kill(-this.leaderPid, signal);
    } catch {
      try {
        process.kill(this.leaderPid, signal);
      } catch {
        // 已经退出。
      }
    }
    await waitFor(() => !isAlive(this.leaderPid), 20_000, '服务进程组退出').catch(() => {});
  }
}

/**
 * 起一个**真**服务进程：`npx tsx --tsconfig server/tsconfig.json server/index.ts`。
 *
 * 日志走文件 fd 而不是管道：没人抽干的管道会填满并阻塞被观测的服务。`detached: true` 让整棵子树
 * 进自己的进程组，收尾时按组杀，包装层与孙进程不会留成孤儿。
 *
 * `HOME`/`CLAUDE_CONFIG_DIR` 都指向临时根：转录、CLI 配置、标记文件全部落在临时树里，跑完即可删。
 * `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` **照抄本进程的**——冒烟要打的正是调用方已经配置且可达
 * 的真模型端点，不像别的判据那样替换成 mock。
 *
 * @param {{ tempRoot: string, label: string }} input
 */
export async function bootServer({ tempRoot, label }) {
  const port = await freePort();
  assertSafePort(port);

  const logPath = path.join(tempRoot, `server-${label}-${port}.log`);
  const logFd = fs.openSync(logPath, 'a');

  // 环境里导出的 DATABASE_PATH / HOST / SERVER_PORT 是给别的用途的，一个都不带进去：子进程只能看到
  // 这里交给它的值。DATABASE_PATH 尤其不带——它不能被 HOME 覆盖，继承过去就是写真实库。
  const env = { ...process.env };
  for (const name of ['DATABASE_PATH', 'HOST', 'SERVER_PORT', 'JWT_SECRET', 'NODE_OPTIONS']) {
    delete env[name];
  }
  Object.assign(env, {
    DATABASE_PATH: path.join(tempRoot, 'auth.db'),
    HOME: path.join(tempRoot, 'home'),
    CLAUDE_CONFIG_DIR: path.join(tempRoot, 'claude-config'),
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    FORCE_COLOR: '0',
  });
  delete env.NO_COLOR;

  const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  const leaderPid = child.pid;
  if (leaderPid === undefined) throw new Error('服务子进程没有 pid：启动根本没发生');

  const reading = new ServerReading({ leaderPid, port, logPath, tempRoot });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    30_000,
    `服务（${label}, port=${port}）应答 /health；日志尾部：\n${reading.logText().slice(-2000)}`,
  );
  return reading;
}

/**
 * 打印一条原始读数行，同时返回它，便于段落正文复述。
 * @param {string} line
 */
function say(line) {
  process.stdout.write(`${line}\n`);
  return line;
}

// ---------------------------------------------------------------------------
// HTTP / WS 面
// ---------------------------------------------------------------------------

/**
 * 一次带 token 的 HTTP 调用。驱动面就是这一个函数里的 `fetch(`。
 * @param {number} port
 * @param {string} token
 * @param {string} method
 * @param {string} requestPath
 * @param {unknown} [body]
 */
export async function api(port, token, method, requestPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed ?? {} };
}

/**
 * 路由自己回的拒绝里的 `error.code`，或 null。
 *
 * 为什么需要它：`/api/session-hosts` 的 404 有**两种**互不相干的意思——「这个动词的路由没挂上」与
 * 「路由在，但这条会话现在没有活宿主」。两者都该点名，但点名必须说对是哪一种：把后者写成
 * 「AC-169 的路由没有落地」是**诬告**，会让人去查一条根本不缺的面。分界线是响应体：路由自己回的
 * 拒绝是 `{success:false, error:{code,message}}`，而路由没挂上时到不了这里（会落到 SPA catch-all）。
 * @param {any} answer
 */
export function refusalCode(answer) {
  const code = answer?.body?.error?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * 拆 `{ success, data }` 信封，失败时把状态与响应体一并抛出（缺面必须点名而不是静默）。
 * @param {any} answer
 * @param {string} label
 */
export function dataOf(answer, label) {
  if (!(answer.status >= 200 && answer.status < 300)) {
    throw new Error(`${label} 应答 ${answer.status}：${JSON.stringify(answer.body)}`);
  }
  const data = answer.body.data;
  if (data === null || typeof data !== 'object') throw new Error(`${label} 没有 data 信封`);
  return data;
}

/**
 * 取一条可撤销的观测 token。
 *
 * `mint-token.mjs` 用**目标库自己的** `jwt_secret` 签名，所以只能在服务起来之后、对该库调用；
 * 它拒绝在 `JWT_SECRET` 可达时运行，因此这里显式把它从环境里摘掉。
 * @param {string} databasePath
 * @param {string} outPath
 */
export function mintToken(databasePath, outPath) {
  const env = { ...process.env };
  delete env.JWT_SECRET;
  const result = spawnSync(
    'node',
    [path.join(ROOT, 'scripts/mint-token.mjs'), 'mint', '--db', databasePath, '--out', outPath],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`mint-token 拒绝：${result.stderr || result.stdout || '(无输出)'}`);
  }
  return fs.readFileSync(outPath, 'utf8').trim();
}

/** 一条 chat WS：把收到的每一帧原样留下（kind/seq 就是读数本身）。 */
export class ChatSocket {
  /**
   * @param {import('ws').WebSocket} socket
   */
  constructor(socket) {
    this.socket = socket;
    /** @type {Array<Record<string, unknown>>} */
    this.frames = [];
  }

  /** @param {number} port @param {string} token */
  static async connect(port, token) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const chat = new ChatSocket(socket);
    socket.on('message', (raw) => {
      try {
        chat.frames.push(JSON.parse(raw.toString('utf8')));
      } catch {
        // 读不懂的帧不是能拿来断言的帧。
      }
    });
    await new Promise((resolve, reject) => {
      socket.once('open', () => resolve(undefined));
      socket.once('error', (error) => reject(error));
    });
    return chat;
  }

  /** @param {unknown} payload */
  send(payload) {
    this.socket.send(JSON.stringify(payload));
  }

  /**
   * 面向该会话订阅：运行中的 run 会把帧推到这个 socket 上，并在订阅时回放。
   * @param {string} sessionId
   * @param {number} [lastSeq]
   */
  subscribe(sessionId, lastSeq = 0) {
    this.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq }] });
  }

  completes() {
    return this.frames.filter((frame) => frame.kind === 'complete');
  }

  /**
   * 最近一条 `chat_subscribed` 应答，没收到就是 null。
   *
   * 它带着两个字段，本冒烟的「可回放」读数正是从这两个字段来的：
   *   - `isProcessing`：订阅那一刻该会话有没有 run 在跑。**只有** running 的 run 会被回放
   *     （`chat-websocket.service.ts` 里回放那段前面写着「Replay only for RUNNING runs」，
   *     跑完的 run 走 REST 历史、不在这儿回放）。
   *   - `lastSeq`：订阅那一刻该 run 已经产出了多少条帧。这些帧在订阅时被**回放**给这条新听众，
   *     之后的走直播——所以它是「一条不是 run 起手的听众也能拿到完整一轮」的机械证据。
   */
  subscribedAck() {
    const acks = this.frames.filter((frame) => frame.kind === 'chat_subscribed');
    return acks.length > 0 ? acks[acks.length - 1] : null;
  }

  seqs() {
    return this.frames.filter((frame) => typeof frame.seq === 'number').map((frame) => frame.seq);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // 已经关了。
    }
  }
}

/**
 * 发一轮用户消息并等它的终止帧。
 *
 * `permissionMode: 'bypassPermissions'`：冒烟是无人值守的真模型调用，`default` 会把 Bash 卡在审批上。
 * 终止帧是 `kind === 'complete'`（驱动在 CLI 的 `result` 处写的那一条，逐轮一次）；`error` 帧直接
 * 抛错，把文本带出来——报错比超时有用。
 * @param {ChatSocket} chat
 * @param {string} sessionId
 * @param {string} content
 * @param {string} cwd
 * @param {{ model?: string, timeoutMs?: number }} [options]
 */
export async function sendTurn(chat, sessionId, content, cwd, { model, timeoutMs = 180_000 } = {}) {
  const before = chat.completes().length;
  const framesBefore = chat.frames.length;
  chat.send({
    type: 'chat.send',
    sessionId,
    content,
    options: { cwd, model, permissionMode: 'bypassPermissions' },
  });

  return await waitFor(
    () => {
      const completes = chat.completes();
      if (completes.length > before) return completes[completes.length - 1];
      const errors = chat.frames.slice(framesBefore).filter((frame) => frame.kind === 'error');
      if (errors.length > 0) throw new Error(`这一轮失败：${JSON.stringify(errors[0])}`);
      return null;
    },
    timeoutMs,
    `一轮（"${content.slice(0, 40)}"）走到终止帧`,
  );
}

// ---------------------------------------------------------------------------
// 宿主快照（`GET /api/session-hosts`）
// ---------------------------------------------------------------------------

/**
 * 读宿主快照。AC-161/166/169 的接缝面就是它：`hosts[]` 是进程，`sessions[]` 是「该跑而没跑」。
 * 缺 `sessions[]` 就是 AC-169 没落地，点名拒绝而不是绕开。
 * @param {number} port
 * @param {string} token
 * @param {string} [label]
 * @returns {Promise<{ hosts: any[], sessions: any[] }>}
 */
export async function readHosts(port, token, label = 'GET /api/session-hosts') {
  const data = dataOf(await api(port, token, 'GET', '/api/session-hosts'), label);
  if (!Array.isArray(data.hosts) || !Array.isArray(data.sessions)) {
    throw new Error(`${label} 的形状不是 AC-169 的宿主快照（缺 hosts[] 或 sessions[]）`);
  }
  return { hosts: data.hosts, sessions: data.sessions };
}

/**
 * 服务某会话的活常驻宿主，或 null。
 * @param {{ hosts: any[], sessions: any[] }} listing
 * @param {string} sessionId
 */
export function residentHostOf(listing, sessionId) {
  return (
    listing.hosts.find(
      (host) => host.state !== 'closed'
        && host.mode === 'resident'
        && Array.isArray(host.bindings)
        && host.bindings.some((/** @type {any} */ binding) => binding.appSessionId === sessionId),
    ) ?? null
  );
}

/**
 * 该会话在 `sessions[]` 里的那一行，或 null。
 * @param {{ hosts: any[], sessions: any[] }} listing
 * @param {string} sessionId
 */
export function sessionStateOf(listing, sessionId) {
  return listing.sessions.find((session) => session.appSessionId === sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// 版本与用量读数
// ---------------------------------------------------------------------------

/** `claude --version` 的整行输出；CLI 不在 PATH 上时返回「未读到」。 */
export function claudeVersion() {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) return `（未读到 claude --version：${(result.stderr || '').trim() || 'exit ' + result.status}）`;
  return (result.stdout || '').trim();
}

/** SDK 版本，从**应用实际装的**那份 package.json 读，不猜。 */
export function sdkVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'),
    );
    return `@anthropic-ai/claude-agent-sdk ${pkg.version}`;
  } catch (error) {
    return `（未读到 SDK 版本：${error instanceof Error ? error.message : String(error)}）`;
  }
}

/**
 * 本次真模型调用的用量：汇总 provider 转录里所有 assistant 行的 `message.usage`。
 *
 * 转录是本次运行的产物（临时 `CLAUDE_CONFIG_DIR` 下唯一的一条会话），所以这一读数是「本次花了多少」
 * 而不是宿主历史。费用一栏写明「未上报」——本机网关只回 token 用量，不回 USD，写一个猜出来的金额
 * 比写「未上报」更坏。
 * @param {string} configDir
 */
export function transcriptFiles(configDir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  walk(path.join(configDir, 'projects'));
  return files;
}

/**
 * 本次运行的转录里逐字含 `API Error` 的 assistant 正文。
 *
 * 为什么这是**判据**而不是噪声：模型名不对时，网关回的 400 会作为 assistant 正文落进转录，而这一轮
 * 的终止帧仍然照常到达（`kind=complete`）。于是「三轮都跑到了终止帧」读起来全绿，真正发生的事却是
 * **一次模型都没有跑**。这条读数取自 CLI 自己的转录（独立于 App 的 WS 帧），所以它能证否那种绿；
 * 命中的是逐字正文，人一眼看得到网关到底在抱怨什么。
 * @param {string} configDir
 */
export function apiErrorsInTranscripts(configDir) {
  /** @type {string[]} */
  const hits = [];
  for (const file of transcriptFiles(configDir)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes('API Error')) {
          hits.push(block.text.trim().replace(/\s+/g, ' '));
        }
      }
    }
  }
  return hits;
}

/** @param {string} configDir */
export function usageReading(configDir) {
  const files = transcriptFiles(configDir);

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let requests = 0;
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = row?.message?.usage;
      if (row?.type !== 'assistant' || !usage || typeof usage !== 'object') continue;
      requests += 1;
      input += Number(usage.input_tokens) || 0;
      output += Number(usage.output_tokens) || 0;
      cacheRead += Number(usage.cache_read_input_tokens) || 0;
    }
  }
  return { files: files.length, requests, input, output, cacheRead };
}

// ---------------------------------------------------------------------------
// 残留读数
// ---------------------------------------------------------------------------

/**
 * 读 `/proc/<pid>/stat` 的第 4、5 个字段（ppid、pgrp）。`comm` 里可能有空格和括号，从最后一个 `)` 之后切。
 * @param {number} pid
 */
export function procStat(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(tail[1]), pgrp: Number(tail[2]) };
}

/**
 * 本次冒烟自身的祖先 pid（`nohup`/`bash -c`/这个 node 自己）。它们的 argv 里也带着 `--temp-root`，
 * 所以 `pgrep -af <临时根>` 会命中它们——那是**发起链**不是残留。剔除它们，读到的才是真残留。
 * 注意不能用「进程组」代替：`bootServer` 用 `detached: true` 起的服务在**另一个**组里（本来就会被留下），
 * 而祖先链是只进不出的。
 */
export function ancestorPids(startPid = process.pid) {
  const seen = new Set();
  let pid = startPid;
  for (let i = 0; i < 64 && Number.isInteger(pid) && pid > 1; i += 1) {
    seen.add(pid);
    const stat = procStat(pid);
    if (!stat) break;
    pid = stat.ppid;
  }
  return seen;
}

/**
 * `pgrep -af` 里属于本次冒烟的进程行（按临时根过滤，别人的残留不算我的，发起链也不算）。
 * @param {string} tempRoot
 */
export function residualProcesses(tempRoot) {
  const result = spawnSync('pgrep', ['-af', tempRoot], { encoding: 'utf8' });
  const ancestors = ancestorPids();
  return (result.stdout || '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => !ancestors.has(Number(line.trim().split(/\s+/)[0])));
}

/**
 * 比 `pgrep -af` 更强的一条残留读数：漏掉的服务进程**argv 里没有临时根**（临时根在它的
 * `DATABASE_PATH=…` 环境里，argv 只是 `npx tsx … server/index.ts`），所以只 grep argv 的 pgrep
 * 对「服务漏没漏」几乎是瞎的。这条逐个读 `/proc/<pid>/cmdline` 与 `/proc/<pid>/environ`，
 * 命中的记成 `<pid> <name> (<命中的文件>)`。同理剔除发起链。
 * @param {string} tempRoot
 */
export function residualEnviron(tempRoot) {
  const ancestors = ancestorPids();
  const hits = [];
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || ancestors.has(pid)) continue;
    for (const file of ['cmdline', 'environ']) {
      let text;
      try {
        text = fs.readFileSync(`/proc/${entry}/${file}`, 'utf8');
      } catch {
        continue; // 刚死的进程、或不是本用户的进程。
      }
      if (!text.includes(tempRoot)) continue;
      let name = '';
      try {
        name = fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim();
      } catch {
        name = '?';
      }
      hits.push(`${pid} ${name} (${file})`);
      break;
    }
  }
  return hits;
}

/**
 * `systemctl --user list-units` 里含本次临时根的行。
 * @param {string} tempRoot
 */
export function residualScopes(tempRoot) {
  const result = spawnSync(
    'systemctl',
    ['--user', 'list-units', '--type=scope', '--all', '--no-legend', '--no-pager'],
    { encoding: 'utf8' },
  );
  return (result.stdout || '').split('\n').filter((line) => line.includes(tempRoot));
}

/**
 * 谁在监听某个端口——`fuser -n tcp <port>` 是**产品无关**的读数：它报内核表里真正持有该端口的进程，
 * 而不是产品自己写在某个文件里**声称**的 pid。产品留下的标记与 systemd 单元回答的是「我以为我是谁」，
 * 这一条回答「内核说是谁」。所以它同时是临时实例的真实 server pid 与 :3001 前后比对的读数。
 * @param {number} port
 * @returns {number | null}
 */
export function portOwnerPid(port) {
  const result = spawnSync('fuser', ['-n', 'tcp', String(port)], { encoding: 'utf8' });
  const pid = Number((result.stdout || '').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** `:3001` 的两个独立读数：内核表里的持有者 + systemd 单元 MainPID。都没有就写「未读到」。 */
export function protectedPortReading() {
  const owner = portOwnerPid(3001);
  const unit = spawnSync(
    'systemctl',
    ['--user', 'show', '-p', 'MainPID', '--value', 'claudecodeui-server.service'],
    { encoding: 'utf8' },
  );
  const mainPid = (unit.stdout || '').trim() || '未读到';
  return `listener-pid=${owner ?? '未读到'} systemd-main-pid=${mainPid}`;
}

// ---------------------------------------------------------------------------
// 六段
// ---------------------------------------------------------------------------

/**
 * 记录文件里的段落正文：一行原始读数 + 一行结论。
 * @param {string} reading
 * @param {string} conclusion
 */
function sectionBody(reading, conclusion) {
  return `读数：${reading}\n结论：${conclusion}\n`;
}

/** 一段拒绝：点名缺的是哪一条 AC 的面，绝不写假的读数行。 */
class LegRefusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LegRefusal';
  }
}

/**
 * 冒烟上下文：进程、端口、token、记录文件路径，以及六段之间要被下一段读到的读数。
 */
class Smoke {
  /**
   * @param {{ tempRoot: string, databasePath: string, record: string }} input
   */
  constructor(input) {
    this.tempRoot = input.tempRoot;
    this.databasePath = input.databasePath;
    this.record = input.record;
    /** @type {ServerReading[]} */
    this.servers = [];
    /** @type {ChatSocket[]} */
    this.chats = [];
    /** 不是 ChatSocket 的那些连接（`/desktop-notifications`），只需要能被收尾关掉。 */
    /** @type {Array<{ close: () => void }>} */
    this.rawSockets = [];
    this.startedAt = Date.now();
    this.token = '';
    /**
     * 模型条目的 id。它**同时**是两样东西：模型库里查配置的键，和交给 CLI 的 `--model` 逐字字符串
     * （`resolveResumeModel` 只做「会话已记录的选择 → 请求值」二选一，**不做** id→上游名的映射；
     * 见 `provider-models.service.ts` 与 `model-launch-spec.service.ts`）。
     * 所以它必须是一个**网关认得的模型名**，不能是随便起的别名——起别名的话 CLI 会把这个别名原样发给
     * 网关，换回 `400 Invalid model name`，而那一轮的终止帧仍然照常到达（`kind=complete`），
     * 于是「三轮都跑到终止帧了」会读成绿。`runSmoke` 里按本机环境赋值。
     */
    this.modelId = '';
    /**
     * 第一段起出来、第二段继续用的那条 chat WS（三轮的终止帧数在同一条听众上）。
     * @type {ChatSocket | null}
     */
    this.roundChat = null;
    /** 六段之间传递的读数。 */
    this.sessionId = '';
    this.perRunSessionId = '';
    /** @type {number | null} */
    this.firstPid = null;
    /** @type {number | null} */
    this.newPid = null;
    /** @type {Array<number | null>} */
    this.roundSeqs = [];
  }

  /** @param {string} title @param {string} reading @param {string} conclusion */
  write(title, reading, conclusion) {
    upsertSection(this.record, title, sectionBody(reading, conclusion));
  }

  /**
   * 起一个新服务进程并接上 token（重启那一段用它）。
   * @param {string} label
   */
  async boot(label) {
    const server = await bootServer({ tempRoot: this.tempRoot, label });
    this.servers.push(server);
    return server;
  }

  /** 最新那个服务进程。 */
  get server() {
    const server = this.servers[this.servers.length - 1];
    if (!server) throw new Error('冒烟还没有起过服务进程');
    return server;
  }

  /**
   * 环境读数：AC6 的命中行 + 端口。
   * @param {ServerReading} server
   */
  isolationReading(server) {
    const lines = server.environLines(['DATABASE_PATH', 'HOST']);
    return `proc-environ[${server.leaderPid}] ${lines.join(' | ')}；port=${server.port}（≠ ${PROTECTED_PORT}）`;
  }

  /**
   * 全程收到的所有 chat 帧（含终止帧与 `token_budget` 状态帧），用量一节按它数。
   * @returns {Array<Record<string, any>>}
   */
  allFrames() {
    return this.chats.flatMap((chat) => chat.frames);
  }

  /**
   * 「模型其实一次都没答」的读数：本次转录里逐字含 `API Error` 的助手正文。
   * 见 `apiErrorsInTranscripts`：终止帧到齐**不等于**模型跑过，这一条是那道分界线。
   * @param {string} stage 用于点名的阶段（「第一轮」/「三轮」/「无人轮」）
   * @returns {string | null} 拒绝语，或 null（没查到报错）
   */
  modelErrorRefusal(stage) {
    const hits = apiErrorsInTranscripts(path.join(this.tempRoot, 'claude-config'));
    if (hits.length === 0) return null;
    return `拒绝运行：${stage}的回复是网关报错而不是模型正文（转录里 ${hits.length} 条 \`API Error\`，`
      + `逐字：${hits[0]}）——终止帧照常到达，不查这一条就会读成绿。`
      + '核对 `Smoke.modelId`（取 `RESIDENT_SMOKE_MODEL`/`ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_SONNET_MODEL`）'
      + '是不是这个网关认得的模型名。';
  }

  close() {
    for (const socket of [...this.chats, ...this.rawSockets]) {
      try {
        socket.close();
      } catch {
        // 已经关了。
      }
    }
  }
}

/**
 * AC-169 的面。走不通就点名，不绕。
 * @param {Smoke} smoke
 */
async function assertLifecycleSurface(smoke) {
  const server = smoke.server;
  const answer = await api(server.port, smoke.token, 'GET', '/api/session-hosts');
  if (answer.status === 404) {
    throw new LegRefusal(
      '拒绝运行：`GET /api/session-hosts` 应答 404 —— AC-169（lifecycle_mode 列与 start/close 路由）没有落地，'
      + '冒烟没有可打的 API 面。缺面必须点名，不能谎报绿。',
    );
  }
  dataOf(answer, 'GET /api/session-hosts');
}

/**
 * 第一段：创建常驻会话。
 *
 * 建会话 → 存 `resident` → **发第一轮**让常驻宿主真的起来。读数是**宿主快照**里该会话那一行逐字
 * `lifecycleMode=resident`，加上宿主那一行的 pid。
 *
 * 为什么不是 `POST /start`：常驻进程**只能由 run entry 起**。`POST /api/session-hosts/:id/start`
 * 走的 `bindSession` → `openHost` → `startHost`，而 `startHost` 对 resident 模式要求一个**已经**被
 * 某轮 run 起好的进程（`this.pending`），没有就抛
 * `Resident host … was opened without a process; a resident host is started by the driver's run entry.`
 * ——本脚本实测该路由对一个尚无活宿主的常驻会话应答 **500**。这是产品面的事实，不是本冒烟的接缝问题，
 * 且 AC-169 的路由明确在本任务**非目标**内，所以本脚本不改它：`/start` 的状态只作为一条**额外读数**
 * 打印在同一节里交人判定，**不作本段的判据**（AC4 对这一段只要求「宿主快照出现且 lifecycle_mode 逐字
 * resident」——那一条由 run entry 起出来的宿主满足）。
 *
 * 这条 chat WS 在第二段继续用：三轮的终止帧要数在**同一条**听众上，跨段共享才谈得上「恰好 3 条」。
 * @param {Smoke} smoke
 */
async function legCreate(smoke) {
  const server = smoke.server;
  const created = dataOf(
    await api(server.port, smoke.token, 'POST', '/api/providers/sessions', {
      provider: 'claude',
      projectPath: smoke.tempRoot,
      initialMessage: '',
    }),
    'POST /api/providers/sessions',
  );
  if (typeof created.sessionId !== 'string' || !created.sessionId) {
    throw new LegRefusal('拒绝运行：建会话没有回 sessionId —— AC-161/166 的会话面没落地。');
  }
  smoke.sessionId = created.sessionId;

  const switched = await api(
    server.port,
    smoke.token,
    'PUT',
    `/api/providers/claude/sessions/${smoke.sessionId}/lifecycle-mode`,
    { mode: 'resident' },
  );
  if (switched.status === 404 && refusalCode(switched) === null) {
    throw new LegRefusal(
      '拒绝运行：`PUT …/lifecycle-mode` 应答 404 且不带 `error.code` —— AC-169 的 lifecycle_mode 写面没有落地。',
    );
  }
  dataOf(switched, 'PUT lifecycle-mode');

  // 常驻宿主由 run entry 起：挂上听众、发第一轮。这条 WS 第二段继续用（见本节文档）。
  const chat = await ChatSocket.connect(server.port, smoke.token);
  smoke.chats.push(chat);
  smoke.roundChat = chat;
  chat.subscribe(smoke.sessionId, 0);
  const terminal = await sendTurn(chat, smoke.sessionId, roundPrompt(1), smoke.tempRoot, {
    model: smoke.modelId,
  });
  smoke.roundSeqs.push(typeof terminal.seq === 'number' ? terminal.seq : null);

  const host = await waitFor(
    async () => residentHostOf(await readHosts(server.port, smoke.token), smoke.sessionId),
    30_000,
    '常驻宿主带着 pid 出现在宿主快照里（AC-161/166 的常驻 driver）',
  );
  // 判据是「活的」不是「正在跑一轮」：一轮结束之后进程仍在、`host.state` 是 `idle`（宿主状态机的
  // 站间状态），而快照自己的定义是 `sessions[].running = 有非 closed 的宿主持有该会话`。两者取后者，
  // 因为那正是 API 对「跑着」的定义；`host.state` 逐字打印出来，读的人自己看得见是 `idle` 还是别的。
  const listing = await readHosts(server.port, smoke.token);
  const state = sessionStateOf(listing, smoke.sessionId);
  if (!state) throw new LegRefusal('拒绝运行：宿主快照的 `sessions[]` 里没有这个会话。');
  if (typeof host.pid !== 'number' || state.running !== true) {
    throw new LegRefusal(
      `拒绝运行：第一轮之后没有活的常驻宿主（host.state=${host.state} pid=${String(host.pid)} `
      + `sessions[].running=${String(state.running)}）—— AC-161 的常驻进程面没落地。`,
    );
  }
  if (state.lifecycleMode !== 'resident') {
    throw new LegRefusal(`拒绝运行：宿主快照里 lifecycle_mode=${state.lifecycleMode}，不是逐字 resident。`);
  }
  smoke.firstPid = host.pid;

  // 「这一轮真的跑到模型了吗」：终止帧到齐不等于模型答过（见 modelErrorRefusal）。
  const firstRoundModelError = smoke.modelErrorRefusal('第一轮');
  if (firstRoundModelError) throw new LegRefusal(firstRoundModelError);

  // 额外读数（不作本段判据）：对一个**已经有活宿主**的常驻会话再问一次 `/start`，看它是不是
  // 「要一个状态、而状态已经是要的那个」而回 success。
  const started = await api(server.port, smoke.token, 'POST', '/api/session-hosts/' + smoke.sessionId + '/start');
  const startDetail = started.status === 200
    ? ' pid=' + String(dataOf(started, 'POST /start').pid)
    : ' ' + JSON.stringify(started.body);
  const startNote = '(POST /start 在已有活宿主时=' + started.status + startDetail + ')';

  const reading = `sessionId=${smoke.sessionId} lifecycle_mode=${state.lifecycleMode} `
    + `host.state=${host.state} host.mode=${host.mode} pid=${host.pid} `
    + `running=${state.running} reason=${JSON.stringify(state.reason)} `
    + `第一轮 terminal.kind=${String(terminal.kind)} seq=${String(terminal.seq)}；`
    + `${smoke.isolationReading(server)}；额外读数 ${startNote}`;
  smoke.write(
    '创建常驻会话',
    reading,
    `宿主快照逐字 lifecycle_mode=resident、running=true，常驻宿主已带 pid=${host.pid} 出现`
    + '（进程由第一轮的 run entry 起——/start 起不了常驻进程，见本节读数里的额外读数）。',
  );
  say(`[读数] 创建常驻会话 ${reading}`);
}

/**
 * 每一轮的提示词。三轮的**唯一**区别是编号，别的什么都不变——这样「同一 pid 恰好 3 条 result」读的是
 * 驱动跨轮复用进程这件事，而不是三轮里某一轮的特殊待遇。
 * @param {number} round
 */
function roundPrompt(round) {
  return `冒烟第 ${round} 轮：只回复 SMOKE_ROUND_${round} 这四个字，不要调用任何工具，不要做别的。`;
}

/**
 * 第二段：连续三轮。
 *
 * 第一段已经用**第一轮**把宿主起出来了，这一节只发第 2、3 轮，且**复用第一段那条 WS**：三轮的终止帧
 * 数在同一个听众上，「恰好 3 条」才是对三轮整体的计数，而不是「这一节自己数到几条」。
 *
 * 读数是**同一 pid** 与 `results=3`——两个数字取自同一次读，所以它同时证否了「三轮各起一个进程」。
 * 每轮之后都重新读一次宿主快照并记下 pid，三个 pid 的集合大小就是「是否换过进程」的直接读数。
 * @param {Smoke} smoke
 */
async function legThreeRounds(smoke) {
  const server = smoke.server;
  const chat = smoke.roundChat;
  if (!chat) throw new LegRefusal('拒绝运行：第二段需要第一段那条 chat WS（三轮的终止帧要数在同一条听众上）。');

  /** @type {Array<number | null>} */
  const pids = [smoke.firstPid];
  for (let round = 2; round <= 3; round += 1) {
    const framesBefore = chat.frames.length;
    const terminal = await sendTurn(chat, smoke.sessionId, roundPrompt(round), smoke.tempRoot, {
      model: smoke.modelId,
    });
    const listing = await readHosts(server.port, smoke.token);
    const host = residentHostOf(listing, smoke.sessionId);
    const state = sessionStateOf(listing, smoke.sessionId);
    if (!host || typeof host.pid !== 'number' || state?.running !== true) {
      throw new LegRefusal(
        `拒绝运行：第 ${round} 轮之后会话没有活的常驻宿主（host=${host ? host.state : 'none'} `
        + `pid=${String(host?.pid)} running=${String(state?.running)}）—— AC-161 的跨轮同进程没落地。`,
      );
    }
    pids.push(host.pid);
    const seq = typeof terminal.seq === 'number' ? terminal.seq : null;
    smoke.roundSeqs.push(seq);
    say(
      `[读数] 第 ${round} 轮 terminal.kind=${String(terminal.kind)} exitCode=${String(terminal.exitCode)} `
      + `aborted=${String(terminal.aborted)} seq=${String(seq)} pid=${host.pid} 本轮新帧=${chat.frames.length - framesBefore}`,
    );
  }

  const unique = new Set(pids);
  const results = chat.completes().length;
  if (unique.size !== 1) {
    throw new LegRefusal(`拒绝运行：三轮用了 ${unique.size} 个不同的 pid（${[...unique].join(', ')}）——同一进程跨轮不成立。`);
  }
  if (results !== 3) {
    throw new LegRefusal(`拒绝运行：终止帧（CLI 的 result）计数为 ${results}，不是恰好 3。`);
  }
  const threeRoundModelError = smoke.modelErrorRefusal('三轮');
  if (threeRoundModelError) throw new LegRefusal(threeRoundModelError);

  const reading = `pid=${pids[0]} results=${results}；`
    + `三轮终止帧 seq=[${smoke.roundSeqs.map(String).join(', ')}]；`
    + `三轮读回的 pid=[${pids.map(String).join(', ')}]（集合大小 ${unique.size}）；`
    + `每轮终止帧 kind=[${chat.completes().map((frame) => String(frame.kind)).join(', ')}]；`
    + `${smoke.isolationReading(server)}`;
  smoke.write(
    '连续三轮',
    reading,
    `同一个 pid=${pids[0]} 连做三轮，终止帧恰好 ${results} 条——三轮没有各起一个进程。`,
  );
  say(`[读数] 连续三轮 ${reading}`);
}

/**
 * 第三段：无人轮。
 *
 * 触发手段是**真**的：让模型用 Bash 的 `run_in_background` 挂一条等触发文件的命令，随后冒烟写出那个
 * 文件；后台任务完成时进程自己开出一轮——没有任何 `chat.send` 推它。读数三件：
 *   1. 触发类型（从 `/desktop-notifications` 的 `run.background_completed` 帧的 `data.trigger` 读），
 *   2. `seq`（无人轮的帧在 `/ws` 上带着 seq 到达；seq 是**逐轮**的——每次 `startRun` 都从 1 重开，
 *      所以无人轮的 seq 得从这条 run 自己的听众上读，不能跟上一轮比大小），
 *   3. 可回放（一条**不是它起手**的订阅在它跑着的时候挂上：挂上那一刻 `chat_subscribed` 回的
 *      `lastSeq` 就是「它已经产出、而服务端会在订阅时回放给我」的帧数，之后继续直播到终止帧）。
 *
 * **为什么不能读那条早就挂着的 `chat` 听众**：无人轮的 run 由 `openUnattendedRun` 起，那一路显式传
 * `connection: null`，而 writer 的构造是 `if (options.connection) this.connections.add(...)` —— 它的
 * 听众集**一开始就是空的**，所以一条早就挂着的听众收不到它的任何活帧；而 `chat.subscribe` 又只对
 * **还在跑**的 run 回放（跑完的 run 走 REST 历史）。两条合起来，本段的读数只能从「在它跑着时挂上的
 * 新订阅」取，那也正是「可回放」这条性质的唯一可观测形态。
 *
 * `source=unattended` 这一字段**只在进程内**（`ChatRun.source` 从不上线），所以这里把它作为**推导**
 * 打印并附上推导依据：本段全程没有 `chat.send`，帧是进程自己开出来的，且触发类型是从通知帧读到的。
 * 把推导写成推导、不冒充线上字段——这正是这条记录要交给人判的地方。
 * @param {Smoke} smoke
 */
async function legUnattended(smoke) {
  const server = smoke.server;
  const chat = smoke.roundChat;
  if (!chat) throw new LegRefusal('拒绝运行：无人轮需要第一段挂上、第二段继续用的那条 chat WS 听众。');

  const triggerFile = path.join(smoke.tempRoot, 'unattended-trigger');
  try {
    fs.unlinkSync(triggerFile);
  } catch {
    // 本来就没有。
  }

  // 这条通道还有**第二道闸**：`notification-orchestrator` 的 desktop 通道只在用户偏好
  // `channels.desktop === true` 时才发（`DEFAULT_NOTIFICATION_PREFERENCES` 里它是 **false**；通知
  // 事件 `stop` 默认倒是 true）。不打开它，`run.background_completed` 不会推到这条 socket 上——
  // 于是「这一轮没报」与「通道压根没开」分不开，而 AC4 要的正是一条**收到**的读数。走 HTTP 面打开
  // （AC3：驱动面只有 HTTP/WS 两种，厂商子命令一次都不碰）。
  const prefs = await api(server.port, smoke.token, 'PUT', '/api/settings/notification-preferences', {
    channels: { desktop: true },
  });
  if (prefs.body?.preferences?.channels?.desktop !== true) {
    throw new LegRefusal(
      '拒绝运行：`PUT /api/settings/notification-preferences` 没有把 desktop 通道打开'
      + `（应答 ${prefs.status} ${JSON.stringify(prefs.body).slice(0, 200)}）——`
      + '通知面在这台服务上取不到读数，本段无从取信。',
    );
  }

  // `/desktop-notifications` 是一条**要注册**的通道：连上之后不发 `{type:'register', deviceId}` 就一帧
  // 都收不到（注册失败还会 1008 关掉）。注册应答是 `{type:'registered'}`——拿到它才说明这条读数是活的，
  // 否则「没收到通知帧」与「根本没注册上」分不开，而 AC4 要的正是一个**收到**的读数。
  const notifySocket = new WebSocket(
    `ws://127.0.0.1:${server.port}/desktop-notifications?token=${encodeURIComponent(smoke.token)}`,
  );
  /** @type {Array<any>} */
  const notifications = [];
  let registered = false;
  notifySocket.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame?.type === 'registered') registered = true;
      notifications.push(frame);
    } catch {
      // 读不懂就丢。
    }
  });
  await new Promise((resolve, reject) => {
    notifySocket.once('open', () => resolve(undefined));
    notifySocket.once('error', (error) => reject(error));
  });
  notifySocket.send(JSON.stringify({
    type: 'register',
    deviceId: `resident-smoke-${process.pid}`,
    label: 'resident-smoke',
    platform: process.platform,
  }));
  await waitFor(() => registered, 15_000, 'desktop-notifications 通道注册成功（拿不到就是这条读数不活）');
  smoke.rawSockets.push({ close: () => { try { notifySocket.close(); } catch { /* 已关 */ } } });

  const armedPrompt = [
    '请用 Bash 工具、并以 run_in_background: true 的方式运行下面这一条命令（原样照抄，不要改）：',
    `while [ ! -f ${triggerFile} ]; do sleep 0.2; done; echo SMOKE_BACKGROUND_DONE`,
    '挂上之后，只回复两个字：已挂。不要等待它完成，也不要再做别的。',
  ].join('\n');

  // `seq` 是**逐轮**的：`chat-run-registry` 里 `lastSeq` 在每次 `startRun` 时重建为 0，所以服务端每个新
  // run 的事件 seq 都从 1 重开（前三轮的终止帧 seq 都是 13 就是这个原因）。所以**不能**靠「比上一轮的
  // seq 大」筛无人轮的帧。武装轮自己的帧也不参与无人轮的读数（无人轮根本不往这条听众上推帧，见下），
  // 这里记下武装轮结束时的位置只是为了报一条「常驻听众确实静默」的读数。
  const framesBefore = chat.frames.length;
  await sendTurn(chat, smoke.sessionId, armedPrompt, smoke.tempRoot, { model: smoke.modelId });
  const armedPos = chat.frames.length;
  say(`[读数] 无人轮 armed：后台任务已挂上，武装轮帧位置=${armedPos}（含武装轮自身 ${armedPos - framesBefore} 帧）`);

  // 先确认武装轮那条 run 已经**结束**（`isProcessing=false`）**再**写触发文件。
  // 少了这一读，下面「撞上一条正在跑的 run」就可能撞上**武装轮自己**（`complete` 帧到了，但 registry
  // 里那条 run 的 status 还没翻），于是把武装轮当成无人轮——那是一条**假绿**：读数一行不少、结论却
  // 写错了轮。武装轮收干净之后才放触发文件，此后任何 `isProcessing=true` 都只可能是无人轮开出来的。
  let armedSettled = false;
  const settleNotes = [];
  const settleDeadline = Date.now() + 60_000;
  while (!armedSettled && Date.now() < settleDeadline) {
    const probe = await ChatSocket.connect(server.port, smoke.token);
    probe.subscribe(smoke.sessionId, 0);
    await waitFor(() => probe.subscribedAck() !== null, 8_000, '订阅应答').catch(() => {});
    const ack = probe.subscribedAck();
    settleNotes.push(`isProcessing=${String(ack?.isProcessing)} lastSeq=${String(ack?.lastSeq)}`);
    armedSettled = ack?.isProcessing === false;
    probe.close();
    if (!armedSettled) await delay(300);
  }
  if (!armedSettled) {
    throw new LegRefusal(
      `拒绝运行：武装轮结束后 60 秒内该会话的 run 一直报 isProcessing=true（逐轮读数：`
      + `${settleNotes.slice(-6).join(' / ')}）——常驻宿主没有把上一轮收干净；这种状态下「撞上一条`
      + '正在跑的 run」分不清是武装轮还是无人轮，本段的读数无从取信。',
    );
  }

  // 触发：写出那个文件 ⇒ 后台任务完成 ⇒ 进程自己开出一轮。
  fs.writeFileSync(triggerFile, 'go\n');

  // 无人轮的 run 是 `openUnattendedRun` 起的，那一路显式传 `connection: null`，而
  // `ChatSessionWriter` 的构造是 `if (options.connection) this.connections.add(...)` —— 所以它
  // 的**听众集一开始是空的**：一条早就挂着的 chat 听众（本段的 `chat`）收不到它的任何活帧。
  // 而且 `chat.subscribe` 只对**还在跑**的 run 回放（`chat-websocket.service.ts` 里那句
  // 「Replay only for RUNNING runs…Completed runs are … served over REST」）——跑完的 run 连回放
  // 都没有。两条合起来：想在线看到无人轮，只有一条路——**在它跑着的时候**挂上一条订阅，
  // 那一刻 `isProcessing=true`，服务端先把该 run 已产出的帧回放给这条新听众，之后继续直播。
  // 这正是 AC4 要的「可回放」，所以本段不再读 `chat` 的活帧，改读**一条晚到的听众**。
  const liveSilent = chat.frames.length - armedPos;
  const probeNotes = [];
  let witness = null;
  let attachSeq = null;
  const witnessDeadline = Date.now() + 300_000;
  while (witness === null && Date.now() < witnessDeadline) {
    const candidate = await ChatSocket.connect(server.port, smoke.token);
    candidate.subscribe(smoke.sessionId, 0);
    await waitFor(() => candidate.subscribedAck() !== null, 8_000, '订阅应答').catch(() => {});
    const ack = candidate.subscribedAck();
    probeNotes.push(`isProcessing=${String(ack?.isProcessing)} lastSeq=${String(ack?.lastSeq)}`);
    if (ack?.isProcessing === true && typeof ack.lastSeq === 'number' && ack.lastSeq >= 1) {
      // 撞上了：run 在跑，且它在我挂上之前就已经产出了 lastSeq 条帧——那几条是回放给我的。
      witness = candidate;
      attachSeq = ack.lastSeq;
    } else {
      // 要么无人轮还没开出来（isProcessing=false），要么刚好赶上它的第一帧（lastSeq=0）。
      // 后者再转一圈就有帧了，所以这里不判死，只是关掉重挂。
      candidate.close();
      await delay(400);
    }
  }
  if (witness === null) {
    throw new LegRefusal(
      `拒绝运行：没能在线撞上无人轮 —— 从写出触发文件起 ${Math.round(300_000 / 1000)} 秒内，`
      + `每轮新挂的订阅都不是「某条 run 正在跑且已产出 ≥1 帧」（逐轮读数：${probeNotes.slice(-6).join(' / ')}）。`
      + '无人轮没开出来、或开出来但没产出帧，AC-162 没落地；缺面必须点名，不能写假的读数行。',
    );
  }
  // `witness` 与 `attachSeq` 在同一个分支里一起赋值（见上面的循环体），所以 `witness` 非空时
  // `attachSeq` 不可能是 null——这里只是把这条不变量讲给类型检查听，不是一条新判据。
  if (attachSeq === null) {
    throw new LegRefusal('拒绝运行：撞上了 witness 却没有记下 attachSeq——不可能到达的分支。');
  }
  smoke.chats.push(witness);

  let terminal;
  try {
    terminal = await waitFor(
      () => {
        const completes = witness.completes();
        return completes.length > 0 ? completes[completes.length - 1] : null;
      },
      300_000,
      '无人轮的终止帧（在那条晚到的听众上）',
    );
  } catch (error) {
    throw new LegRefusal(
      `拒绝运行：晚到的听众挂上了（挂上时 run.lastSeq=${attachSeq}），但没等到终止帧 —— `
      + `${error instanceof Error ? error.message : String(error)}。`
      + '这条读不上就是 AC-162（无人轮建 run、可回放）没落地。',
    );
  }

  const seq = typeof terminal.seq === 'number' ? terminal.seq : null;
  // 通知帧的形状取自兄弟判据（`claude-resident-unattended-turn.test.ts`）的同一读法：
  // `payload.data.code` 是通知名，`payload.data.trigger` 是触发类型。两层都不能省——
  // `buildNotificationPayload()` 把 `code`/`trigger` 放在**信封的 `data` 里**（`trigger` 是
  // 从 `meta.trigger` 抄下来的，因为 `meta` 不出 notification-orchestrator 那个文件）。
  const notificationCodes = notifications
    .map((frame) => frame?.payload?.data?.code)
    .filter((code) => typeof code === 'string');
  const notify = notifications.filter((frame) => frame?.payload?.data?.code === 'run.background_completed');
  const lastNotify = notify[notify.length - 1];
  const trigger = lastNotify?.payload?.data?.trigger ?? null;

  // 这条听众只属于无人轮这一条 run（`chat.subscribe` 只回放当前 run），所以它收到的帧就是无人轮的帧。
  const frames = witness.frames.filter((frame) => typeof frame.seq === 'number');
  const seqs = frames.map((frame) => frame.seq);

  // 四件读数缺一不可，缺了就**拒绝**，不能把它们写成一个看起来跑过的读数行：AC4 对本段要的正是
  // 「一次 source=unattended 的 run（打印 seq 与触发类型，并证明可回放）」。分开点名。
  const unattended = smoke.modelErrorRefusal('无人轮');
  if (unattended) throw new LegRefusal(unattended);
  if (seqs.length < attachSeq) {
    throw new LegRefusal(
      `拒绝运行：挂上时 run.lastSeq=${attachSeq}，但这条听众到最后只收到 ${seqs.length} 条带 seq 的帧 `
      + '——回放没有把它挂上之前的帧补齐，AC-162 的可回放没落地。',
    );
  }
  if (trigger === null) {
    throw new LegRefusal(
      `拒绝运行：无人轮跑了（${seqs.length} 帧），但 \`/desktop-notifications\` 上没有收到带触发类型的 `
      + '`run.background_completed` 帧——AC-162 的通知面没落地（无人轮只发生了一半：跑了但不报）。'
      + `这条通道上收到的帧共 ${notifications.length} 条，通知名逐字=[${notificationCodes.join(', ')}]`
      + `（收到 0 条 ⇒ 这条通道没接上；收到别的不含此名 ⇒ 这一轮没往它推）。`,
    );
  }

  const reading = `终止帧 seq=${seq} 触发类型=${String(trigger)} `
    + `晚到听众：挂上时 isProcessing=true run.lastSeq=${attachSeq}（这 ${attachSeq} 条是订阅时回放给它的）`
    + `→ 一路收到 ${frames.length} 帧，seq=[${seqs.slice(0, 12).join(', ')}${seqs.length > 12 ? ', …' : ''}]`
    + `（逐轮重开，首帧 seq=${seqs[0]}）；早先那条常驻 chat 听众本轮收到 ${liveSilent} 帧（应为 0：`
    + '无人轮的 writer 以 `connection: null` 起，听众集初始为空，它只进回放缓冲）'
    + `；source=unattended（推导：本段没有发出任何 chat.send，这一轮是常驻进程自己开出来的——`
    + '它的 writer 没有起手 socket，这正是 unattended/scheduled 与 user 轮的结构差别；'
    + `触发类型 ${String(trigger)} 读自 /desktop-notifications 的 run.background_completed 帧；`
    + `ChatRun.source 只在进程内、从不上线，故此处为推导而非线上字段）`;
  smoke.write(
    '无人轮',
    reading,
    `无人轮真的发生：一条**不是它起手**的听众在它跑着时挂上，先后拿到回放的 ${attachSeq} 帧与直播，`
    + `直到终止帧 seq=${seq}；触发类型=${String(trigger)}，本轮共 ${frames.length} 帧。`,
  );
  say(`[读数] 无人轮 ${reading}`);
}

/**
 * 第四段：关闭。
 *
 * `POST /close` 记录关闭原因并让驱动收掉输入队列（常驻进程的 stdin EOF）。读数是进程真的没了
 * （`/proc/<pid>` 消失）加上快照里逐字的 `closeReason`。
 * @param {Smoke} smoke
 */
async function legClose(smoke) {
  const server = smoke.server;
  const pid = smoke.firstPid;
  if (typeof pid !== 'number') throw new LegRefusal('拒绝运行：没有第一段的 pid，无法验证关闭。');

  const closed = await api(server.port, smoke.token, 'POST', `/api/session-hosts/${smoke.sessionId}/close`);
  const closeCode = refusalCode(closed);
  if (closed.status === 404 && closeCode === null) {
    throw new LegRefusal('拒绝运行：`POST /api/session-hosts/:id/close` 应答 404 且不带 `error.code` —— AC-169 的 close 路由没有落地。');
  }
  if (closeCode === 'SESSION_HOST_NOT_FOUND') {
    // 路由在，缺的是**活宿主**。这一段的读数因此不成立，而且它同时说明前三段的读数已经不可信：
    // 常驻进程在第一段之后、这一段之前就掉了，前三段读到的「同一条会话」与这一段读到的不是同一个状态。
    throw new LegRefusal(
      `拒绝运行：close 路由在（\`error.code=${closeCode}\`），但该会话**没有活宿主可关**：`
      + `${JSON.stringify(closed.body)} —— 前三段读到的常驻进程在这之前就掉了，本段读数无从取得。`,
    );
  }
  const data = dataOf(closed, 'POST /close');

  await waitFor(() => !isAlive(pid), 60_000, `常驻进程 ${pid} 在关闭后退出`).catch(() => {});
  const gone = !isAlive(pid);
  const listing = await readHosts(server.port, smoke.token);
  const host = listing.hosts.find((entry) => entry.hostId === data.hostId) ?? null;

  if (!gone) throw new LegRefusal(`拒绝运行：关闭之后 /proc/${pid} 仍在 —— 关闭没有真的让进程退出。`);
  const reading = `pid=${pid} /proc/${pid} ${gone ? '消失' : '仍在'} closeReason=${String(host?.closeReason ?? data.closeReason)} `
    + `host.state=${String(host?.state)}`;
  smoke.write(
    '关闭',
    reading,
    `关闭原因逐字 ${String(host?.closeReason ?? data.closeReason)}，且进程 ${pid} 确实退出（/proc 消失）。`,
  );
  say(`[读数] 关闭 ${reading}`);
}

/**
 * 第五段：重启后已关闭。
 *
 * 停掉第一个服务进程、在**同一份**临时库上起第二个，然后读同一条会话行：未运行、原因非空。
 * 正控制是同一读里的 per-run 会话：它的 `reason` 必须是 `null`——否则「原因非空」只是「这个字段从不
 * 为空」的同义反复。
 * @param {Smoke} smoke
 */
async function legAfterRestart(smoke) {
  const oldServer = smoke.server;
  const oldPid = oldServer.serverPid() ?? oldServer.leaderPid;
  await oldServer.stop('SIGTERM');

  // per-run 控制会话：不写 lifecycle_mode，读它的 reason 必须是 null。
  const next = await smoke.boot('restart');
  if (next.port === oldServer.port) {
    throw new LegRefusal(`拒绝运行：重启后仍是同一个端口 ${next.port}，这不是重启。`);
  }
  const perRun = dataOf(
    await api(next.port, smoke.token, 'POST', '/api/providers/sessions', {
      provider: 'claude',
      projectPath: smoke.tempRoot,
      initialMessage: '',
    }),
    '创建 per-run 控制会话',
  );
  smoke.perRunSessionId = perRun.sessionId;

  const listing = await readHosts(next.port, smoke.token);
  const state = sessionStateOf(listing, smoke.sessionId);
  const control = sessionStateOf(listing, smoke.perRunSessionId);
  if (!state) throw new LegRefusal('拒绝运行：重启后的宿主快照里没有这条会话 —— AC-166 的状态面没落地。');
  if (state.running) throw new LegRefusal(`拒绝运行：重启后该会话仍报 running=true —— AC-166 没落地。`);
  if (typeof state.reason !== 'string' || state.reason === '') {
    throw new LegRefusal('拒绝运行：重启后该会话的 reason 为空 —— 「已随重启关闭」读不出来。');
  }
  if (!control || control.reason !== null) {
    throw new LegRefusal(
      `拒绝运行：正控制失败 —— per-run 会话的 reason 应为 null，实为 ${JSON.stringify(control?.reason)}。`
      + '这一读若不成立，「reason 非空」就只是该字段从不空。',
    );
  }

  const reading = `server-old-pid=${oldPid} server-new-pid=${next.serverPid() ?? next.leaderPid} `
    + `running=${state.running} reason=${JSON.stringify(state.reason)} `
    + `正控制 per-run sessionId=${smoke.perRunSessionId} reason=${JSON.stringify(control.reason)} `
    + `lifecycle_mode=${state.lifecycleMode}`;
  smoke.write(
    '重启后已关闭',
    reading,
    `换了另一个服务进程（${oldPid} → ${next.serverPid() ?? next.leaderPid}）后读回「未运行」且原因非空，`
    + '同一读里 per-run 会话的 reason 为 null（该字段不是恒真）。',
  );
  say(`[读数] 重启后已关闭 ${reading}`);
}

/**
 * 第六段：再次发送重新拉起。
 *
 * 重启后对同一条常驻会话再发一轮：新进程的 pid 必须 **≠** 第一段的 pid。等 pid 不同而不是等 pid 出现，
 * 因为「出现」对旧进程的残留也成立。
 * @param {Smoke} smoke
 */
async function legResend(smoke) {
  const server = smoke.server;
  const chat = await ChatSocket.connect(server.port, smoke.token);
  smoke.chats.push(chat);
  chat.subscribe(smoke.sessionId, 0);

  await sendTurn(chat, smoke.sessionId, '冒烟最后一轮：只回复 SMOKE_REVIVED。', smoke.tempRoot, {
    model: smoke.modelId,
  });

  const host = await waitFor(
    async () => {
      const listing = await readHosts(server.port, smoke.token);
      const found = residentHostOf(listing, smoke.sessionId);
      return found && typeof found.pid === 'number' && found.pid !== smoke.firstPid ? found : null;
    },
    120_000,
    `再次发送后出现一个 pid ≠ ${String(smoke.firstPid)} 的常驻宿主`,
  );
  smoke.newPid = host.pid;

  const reading = `old-pid=${smoke.firstPid} new-pid=${host.pid} host.state=${host.state}`;
  smoke.write(
    '再次发送重新拉起',
    reading,
    `再次发送后拉起了新 pid=${host.pid}（≠ 第一段的 ${smoke.firstPid}），不是复用死进程。`,
  );
  say(`[读数] 再次发送重新拉起 ${reading}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 手写 flag 解析：`--k v` 与 `--k=v` 两种都收。
 * @param {string[]} argv
 */
export function parseFlags(argv) {
  /** @type {Record<string, string | undefined>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[token.slice(2)] = next;
      i += 1;
    } else {
      flags[token.slice(2)] = 'true';
    }
  }
  return flags;
}

/**
 * `--check-record`：逐节检查，缺哪节点名哪节；齐全 exit 0。
 * @param {string} filePath
 */
export function runCheckRecord(filePath) {
  const missing = checkRecordFile(filePath);
  if (missing.length === 0) {
    process.stdout.write(`记录合格：${filePath} 六节齐全且每节都有 读数：/结论：\n`);
    return 0;
  }
  for (const entry of missing) {
    process.stderr.write(`缺节：${entry.title} —— ${entry.reason}\n`);
  }
  process.stderr.write(`记录不合格（${filePath}）：缺 ${missing.length} 处，六节要求见 AC1。\n`);
  return 1;
}

/**
 * 冒烟主流程：环境与版本 ⇒ 六段 ⇒ 残留读数。
 *
 * 六段逐段落盘，所以一段失败不会抹掉前面已经写下的原始读数——记录文件里能看到走到哪、卡在哪。
 * @param {Smoke} smoke
 */
export async function runSmoke(smoke) {
  smoke.write(
    '环境与版本',
    `claude --version = ${claudeVersion()}；SDK = ${sdkVersion()}；`
    + `费用/用量：见本节末行（六段跑完后由 usageReading 汇总）；:3001 起点读数 ${protectedPortReading()}。`,
    '本节不是 AC1 检查的六节之一，只放版本与用量；六段读数在下面各节。',
  );

  const server = smoke.server;
  smoke.token = mintToken(smoke.databasePath, path.join(smoke.tempRoot, 'token'));

  // 模型条目：调用方**已经配好且可达**的那个真端点（`ANTHROPIC_BASE_URL`），原样交给要跑的那个进程。
  // 空值一行都不写——把 `ANTHROPIC_BASE_URL=''` 交给 CLI 比不写更坏，那是把可达端点覆盖成空串。
  // `ANTHROPIC_DEFAULT_*_MODEL` 一起带上：CLI 的会话标题那次调用不认自定义 model id，不带就报
  // `unrecognized_model` 并回落 200k 上下文假设（读数里的噪声，不是失败）。
  //
  // 条目 id **就是**被交给 CLI 的 `--model`（见 `Smoke.modelId` 的注释），所以它取「本机环境里那个
  // 网关认得的模型名」而不是一个自造的别名：取别名的话每一轮的回复都会是一段 `API Error: 400 …`
  // 正文，而终止帧照常到达，绿得看不出来。优先级是本机显式指定的、再回落到环境里已有的 sonnet 名。
  const underlyingModel = process.env.RESIDENT_SMOKE_MODEL
    ?? process.env.ANTHROPIC_MODEL
    ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ?? 'v4.1flash';
  smoke.modelId = underlyingModel;
  const envRows = [
    ['ANTHROPIC_BASE_URL', 'value', process.env.ANTHROPIC_BASE_URL],
    ['ANTHROPIC_AUTH_TOKEN', 'secret', process.env.ANTHROPIC_AUTH_TOKEN],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'value', underlyingModel],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'value', underlyingModel],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'value', underlyingModel],
  ]
    .filter(([, , value]) => typeof value === 'string' && value !== '')
    .map(([key, kind, value]) => ({ key, kind, value }));
  // `ANTHROPIC_API_KEY` 必须显式 unset：调用方的 shell 里它是有值的，继承过去会让 CLI 走 API key 那条
  // 认证分支而不是 base-url + auth-token 那条。
  envRows.push({ key: 'ANTHROPIC_API_KEY', kind: 'unset', value: undefined });

  const model = await api(server.port, smoke.token, 'POST', '/api/providers/claude/models', {
    id: smoke.modelId,
    model: underlyingModel,
    config: { env: envRows },
  });
  if (!(model.status === 201 || model.status === 200)) {
    throw new LegRefusal(
      `拒绝运行：真模型条目「${smoke.modelId}」没有被接受（${model.status}）：${JSON.stringify(model.body)}`
      + ' 换 `RESIDENT_SMOKE_MODEL=<网关认得的模型名>` 再跑。',
    );
  }
  await assertLifecycleSurface(smoke);

  /** @type {Array<[string, (smoke: Smoke) => Promise<void>]>} */
  const legs = [
    ['创建常驻会话', legCreate],
    ['连续三轮', legThreeRounds],
    ['无人轮', legUnattended],
    ['关闭', legClose],
    ['重启后已关闭', legAfterRestart],
    ['再次发送重新拉起', legResend],
  ];

  let failure = null;
  for (const [title, leg] of legs) {
    try {
      await leg(smoke);
    } catch (error) {
      failure = { title, error };
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[拒绝] 第「${title}」段：${message}\n`);
      if (error instanceof LegRefusal || error instanceof GuardRefusal) {
        // 缺面：点名，不写假读数。本节留一条明确写着拒绝的记录，人一眼能看到卡在哪。
        // 前缀由 `sectionBody` 加，这里只给正文——带上前缀会写成 `读数：读数：…`。
        smoke.write(title, `（未取得）${message}`, '本段拒绝，读数缺失——见 stderr，禁止把缺面写成绿。');
        break;
      }
      throw error;
    }
  }

  // 用量读数是**服务还活着时**的 HTTP 面（`/token-usage`），所以在这里取；残留读数**不在这里**取：
  // 「残留」问的是跑完之后还剩什么，而此刻临时服务还开着，读数必然非零、什么也证明不了。它移到
  // `main()` 收完尾之后（见那边的注释）。
  //
  // `费用/用量` 这一行的取法：几个**独立**来源并列，谁有值写谁的值。USD 一栏各家都可能不回，
  // 那就逐字写「未上报」——折算一个金额比写「未上报」坏得多。
  const usage = usageReading(path.join(smoke.tempRoot, 'claude-config'));
  const elapsedMs = Date.now() - smoke.startedAt;
  // 读 **当前** 那个服务，不是本函数开头缓存的 `server`：第五段会停掉第一个、起第二个，缓存的
  // 那个此刻已经死了，对它发请求只会得到 `fetch failed`（正是本行曾经踩过的坑）。
  const tokenUsage = await api(
    smoke.server.port,
    smoke.token,
    'GET',
    `/api/providers/sessions/${smoke.sessionId}/token-usage`,
  );
  const budgetFrames = smoke.allFrames().filter((frame) => frame.kind === 'status' && frame.text === 'token_budget');
  const lastBudget = budgetFrames[budgetFrames.length - 1]?.tokenBudget ?? null;
  const usageLine = `claude --version = ${claudeVersion()}；SDK = ${sdkVersion()}；`
    + `费用/用量：真模型轮次 = ${smoke.roundSeqs.length} 轮 + 1 无人轮，全程 ${Math.round(elapsedMs / 1000)}s，`
    + `本次转录里 assistant 行 ${usage.requests} 条（转录 ${usage.files} 份）；`
    + `转录 message.usage 汇总 input_tokens=${usage.input} output_tokens=${usage.output} `
    + `cache_read_input_tokens=${usage.cacheRead}；`
    + `WS 上 token_budget 帧 ${budgetFrames.length} 条，末条逐字 ${JSON.stringify(lastBudget)}；`
    + `GET /api/providers/sessions/<id>/token-usage 应答 ${tokenUsage.status} ${JSON.stringify(tokenUsage.body)}；`
    + 'USD 一栏：本机网关只回 token 用量、不回金额（上面几个来源里没有任何 USD 字段），'
    + '故逐字写「未上报」，不折算。';

  return { failure, usageLine, usage, elapsedMs };
}

/**
 * 主入口。守护栏先跑：护栏拒绝时**不写任何读数**，只 exit 1。
 * @param {string[]} argv
 */
export async function main(argv) {
  const flags = parseFlags(argv);

  if (flags['check-record'] !== undefined) {
    return runCheckRecord(flags['check-record']);
  }

  const tempRoot = path.resolve(flags['temp-root'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'resident-smoke-')));
  // 护栏**先**跑，且先于任何**写**盘：拒绝运行时连一个子目录都不该建。判据把这条钉成了读数——
  // 「拒绝时临时根里空无一物」比「拒绝时返回 1」强，因为后者对「先写了一半再拒绝」也成立。
  const databasePath = assertIsolatedDatabasePath({
    databasePath: flags['database-path'],
    ambientDatabasePath: process.env.DATABASE_PATH,
    tempRoot,
  });
  fs.mkdirSync(path.join(tempRoot, 'home'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'claude-config'), { recursive: true });
  const record = path.resolve(flags.record ?? DEFAULT_RECORD);

  const smoke = new Smoke({ tempRoot, databasePath, record });
  say(`[冒烟] tempRoot=${tempRoot} databasePath=${databasePath} record=${record}`);

  let outcome = null;
  try {
    await smoke.boot('main');
    const protectedBefore = protectedPortReading();
    say(`[读数] :3001 起点读数 ${protectedBefore}`);
    outcome = await runSmoke(smoke);
  } finally {
    smoke.close();
    for (const server of smoke.servers) await server.stop('SIGTERM');
  }

  // —— 到这里临时服务全部停了。残留读数**只能**在这里取：`residualEnviron` 命中的正是那些服务进程
  //    的 `DATABASE_PATH=<临时根>`，收尾之前取，读到的永远是「还活着」。SIGTERM 之后内核收尸要一点
  //    时间，所以先有界地等一等；等到预算耗尽也照样把当时的读数打印出来，不假装干净。
  const residueWait = await waitForNoResidue(tempRoot, 20_000);
  const residues = residualProcesses(tempRoot);
  const environHits = residualEnviron(tempRoot);
  const scopes = residualScopes(tempRoot);
  const protectedEnd = protectedPortReading();
  say(
    `[读数] 残留检查 tempRoot=${tempRoot} pgrep-命中=${residues.length} `
    + `environ-命中=${environHits.length} scope-命中=${scopes.length}`
    + `（已剔除本次冒烟自身及其祖先 ${ancestorPids().size} 个 pid；等待后剩余 ${residueWait}）`,
  );
  for (const line of residues) say(`[残留·pgrep] ${line}`);
  for (const line of environHits) say(`[残留·environ] ${line}`);
  for (const line of scopes) say(`[残留·scope] ${line}`);
  say(`[读数] :3001 终点读数 ${protectedEnd}`);

  smoke.write(
    '环境与版本',
    `${outcome.usageLine}`
    + `残留与生产面（收尾后读数）：临时根 ${tempRoot} 上 pgrep-命中=${residues.length} `
    + `environ-命中=${environHits.length} scope-命中=${scopes.length}；`
    + `:3001 终点读数 ${protectedEnd}（与首行起点读数同值即未被动过）。`,
    '版本与用量来自本机 CLI/SDK 与本次运行的 provider 转录；USD 未上报是网关的实测面，不是漏读。'
    + '残留读数取自**收尾之后**——收尾之前取的话命中的永远是那几个还开着的服务进程。',
  );

  if (outcome.failure) return 1;
  if (residues.length > 0 || environHits.length > 0 || scopes.length > 0) {
    process.stderr.write(
      `拒绝报告完成：临时实例留下残留（pgrep=${residues.length} environ=${environHits.length} `
      + `scope=${scopes.length}）：${[...residues, ...environHits, ...scopes].join(' | ')}\n`,
    );
    return 1;
  }
  const missing = checkRecordFile(record);
  if (missing.length > 0) {
    for (const entry of missing) process.stderr.write(`缺节：${entry.title} —— ${entry.reason}\n`);
    return 1;
  }
  say('[冒烟] 六段读数已落盘；「冒烟验收：通过」那一行只由人 yale 写，本脚本不写。');
  return 0;
}

/**
 * 有界地等临时实例的进程真的消失。SIGTERM 之后内核收尸要一点时间，读太早会把「正在死」读成「残留」。
 * 预算耗尽就返回当时还剩几条——照样打印，不假装干净。
 * @param {string} tempRoot
 * @param {number} budgetMs
 */
export async function waitForNoResidue(tempRoot, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const hits = residualProcesses(tempRoot).length
      + residualEnviron(tempRoot).length
      + residualScopes(tempRoot).length;
    if (hits === 0 || Date.now() >= deadline) return hits;
    await delay(1000);
  }
}

// 只有本文件被**直接执行**时才跑 CLI：判据要 `import` 它的纯函数，导入不该有副作用。
// 按 realpath 比较，脚本经符号链接调用时也认得出是自己。
const invokedDirectly = process.argv[1] !== undefined
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof GuardRefusal) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
