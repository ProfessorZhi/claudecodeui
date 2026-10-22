#!/usr/bin/env node
// mcp-smoke.test.mjs — `scripts/mcp-smoke.mjs` 的护栏判据（AC7 的 a–f）。
//
// 为什么这些护栏值得有自己的测试
// ------------------------------
// 这条冒烟会起一个**真服务进程**、把一个**真 PAT** 交给**真终端 Claude Code**、并用**真模型**驱动一个
// 真会话——烧真钱、写临时库。本机 shell 已导出 `DATABASE_PATH`（真实库）与 `HOST`，而冒烟必须写**临时**
// 库、绑 127.0.0.1、避开 3001 上那个常驻服务。一次手滑就是往生产库里写会话、或抢 3001。所以
// 「必须显式给临时库」「端口 ≠ 3001」不是风格问题，是唯一挡住这两件事的东西——它们必须被钉住，
// 而且必须由**真的跑一遍 CLI**来钉，不是只调一次纯函数（`main()` 的接线本身也会坏）。
//
// 承重腿是「缺一节就红」：记录文件是这条任务唯一的产物，如果 `--check-record` 对缺节视而不见，
// 一份只写了一半的记录也会判绿——那这条判据就白设了。
//
// 覆盖（AC7 逐条）：
//   (a) 缺整节点名该节；         (b) 缺 `读数：` / `结论：` 行点名该节缺哪行；
//   (c) 读数为空点红；           (d) 端口 3001 红；
//   (e) 八节齐全 exit 0；        (f) 三条护栏各 CLI exit 1。
// 另加 AC10 的机械读法：脚本里不得出现禁用的人证行字样（正控制证明这条 grep 有分辨力）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXTERNAL_SECTION_TITLES,
  GuardRefusal,
  SECTION_TITLES,
  assertIsolatedDatabasePath,
  assertSafePort,
  checkExternalRecordFile,
  checkExternalRecordText,
  checkRecordFile,
  checkRecordText,
  extractSection,
  parseClaudeStream,
  parsePort,
  toolCallFor,
  upsertSection,
} from './mcp-smoke.mjs';

const SCRIPT = fileURLToPath(new URL('./mcp-smoke.mjs', import.meta.url));
/** 本机 shell 导出的真实库；护栏必须挡住它。 */
const AMBIENT = process.env.DATABASE_PATH || '/data/home/yale/.cloudcli/auth.db';

/**
 * 跑一遍 CLI。默认把 `DATABASE_PATH` 钉成真实库，因为要验的就是「护栏在真实环境里挡得住」。
 * @param {string[]} argv
 * @param {Record<string, string>} [extraEnv]
 */
function runCli(argv, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: AMBIENT, ...extraEnv },
  });
}

/** 八节齐全的一份最小记录：每节 `读数：raw` + `结论：ok`，端口不是 3001。 */
function completeRecord() {
  return SECTION_TITLES
    .map((title) => (title === '起独立实例'
      ? `## ${title}\n\n读数：port=54321 临时库 127.0.0.1\n结论：ok\n`
      : `## ${title}\n\n读数：raw\n结论：ok\n`))
    .join('\n');
}

/**
 * 把某节换成给定正文，其余节保持齐全。
 * @param {string} target @param {string} sectionBody
 */
function recordWith(target, sectionBody) {
  return SECTION_TITLES
    .map((title) => {
      if (title === target) return `## ${title}\n\n${sectionBody}`;
      // 非靶节一律给足：起独立实例带上可解析且 ≠ 3001 的端口，免得别的检查跟着一起红。
      return title === '起独立实例'
        ? `## ${title}\n\n读数：port=54321\n结论：ok\n`
        : `## ${title}\n\n读数：raw\n结论：ok\n`;
    })
    .join('\n');
}

/**
 * @param {string} prefix
 */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 在临时目录里放一份记录，跑 `--check-record`。
 * @param {string} text @param {string} prefix
 */
function checkRecordCli(text, prefix) {
  const { dir, cleanup } = tempDir(prefix);
  const file = path.join(dir, 'record.md');
  fs.writeFileSync(file, text);
  const result = runCli(['--check-record', file]);
  cleanup();
  return result;
}

// ---------------------------------------------------------------------------
// (f) 护栏：纯函数三层
// ---------------------------------------------------------------------------

test('护栏纯函数：缺省 --database-path 时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({ databasePath: undefined, ambientDatabasePath: AMBIENT }),
    (error) => error instanceof GuardRefusal && /必须显式给出临时 DATABASE_PATH/.test(error.message),
  );
});

test('护栏纯函数：--database-path 等于 shell 导出的值时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({ databasePath: AMBIENT, ambientDatabasePath: AMBIENT }),
    (error) => error instanceof GuardRefusal && /真实库/.test(error.message),
  );
});

test('护栏纯函数：--database-path 落在临时根之外时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({
      databasePath: '/data/home/yale/work/claudecodeui/some.db',
      ambientDatabasePath: AMBIENT,
    }),
    (error) => error instanceof GuardRefusal && /不在临时根/.test(error.message),
  );
});

test('护栏纯函数：临时根下的路径被接受并解析为绝对路径', () => {
  const candidate = path.join(os.tmpdir(), 'mcp-smoke-guard-ok', 'auth.db');
  assert.strictEqual(
    assertIsolatedDatabasePath({ databasePath: candidate, ambientDatabasePath: AMBIENT }),
    path.resolve(candidate),
  );
});

test('护栏纯函数：受保护端口 3001 被拒，别的端口放行', () => {
  assert.throws(() => assertSafePort(3001), (error) => error instanceof GuardRefusal);
  assert.doesNotThrow(() => assertSafePort(3123));
});

// ---------------------------------------------------------------------------
// (f) 护栏：CLI 接线（`main()` 的接线本身也会坏，所以真的跑一遍）
// ---------------------------------------------------------------------------

test('护栏 CLI（f-1）：未显式给 --database-path 时 exit 1', () => {
  const result = runCli(['--temp-root', os.tmpdir()]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /必须显式给出临时 DATABASE_PATH/);
});

test('护栏 CLI（f-2）：--database-path 指向真实库时 exit 1', () => {
  const result = runCli(['--database-path', AMBIENT, '--temp-root', os.tmpdir()]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /真实库/);
});

test('护栏 CLI（f-3）：--database-path 不在临时根下时 exit 1（且拒绝发生在起服务之前）', () => {
  const { dir, cleanup } = tempDir('mcp-smoke-outside-');
  const result = runCli(['--database-path', path.join(dir, 'auth.db'), '--temp-root', path.join(dir, 'nested')]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /不在临时根/);
  // 护栏拒绝时连一个文件都不该留（日志、库都没有）。
  assert.deepStrictEqual(fs.readdirSync(dir), [], '护栏拒绝时不该留下任何文件');
  cleanup();
});

// ---------------------------------------------------------------------------
// (a) 缺整节点名该节 —— 承重腿
// ---------------------------------------------------------------------------

test('记录（a）：缺一节就红，并逐字点名缺的是哪节', () => {
  const missingTitle = '查进度';
  const text = SECTION_TITLES
    .filter((title) => title !== missingTitle)
    .map((title) => (title === '起独立实例'
      ? `## ${title}\n\n读数：port=54321\n结论：ok\n`
      : `## ${title}\n\n读数：raw\n结论：ok\n`))
    .join('\n');
  const result = checkRecordCli(text, 'mcp-smoke-record-missing-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：查进度 —— 缺整个小节/);
  assert.doesNotMatch(result.stderr, /缺节：发消息/, '齐了的节不该被点名');
});

test('记录（a 纯函数）：checkRecordText 对只有一节的记录点名其余七节全缺', () => {
  const missing = checkRecordText('## 环境与版本\n\n读数：raw\n结论：ok\n');
  assert.deepStrictEqual(missing.map((entry) => entry.title), SECTION_TITLES.slice(1));
  assert.ok(missing.every((entry) => entry.reason === '缺整个小节'));
});

test('记录（a 纯函数）：checkRecordFile 对不存在的文件把八节点名全缺', () => {
  const missing = checkRecordFile('/tmp/definitely-not-here-mcp-smoke.md');
  assert.deepStrictEqual(missing.map((entry) => entry.title), SECTION_TITLES);
});

// ---------------------------------------------------------------------------
// (b) 缺 `读数：` / `结论：` 行点名该节缺哪行
// ---------------------------------------------------------------------------

test('记录（b-1）：缺 `结论：` 行的节点名该节缺哪行，不报整节', () => {
  const result = checkRecordCli(recordWith('中止', '读数：raw\n'), 'mcp-smoke-record-noconcl-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：中止 —— 缺 `结论：` 行/);
  assert.doesNotMatch(result.stderr, /缺整个小节/, '只有一节缺一行，不该报整节缺失');
});

test('记录（b-2）：缺 `读数：` 行的节点名该节缺哪行', () => {
  const result = checkRecordCli(recordWith('发消息', '结论：ok\n'), 'mcp-smoke-record-noread-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：发消息 —— 缺 `读数：` 行/);
});

// ---------------------------------------------------------------------------
// (c) 读数为空点红
// ---------------------------------------------------------------------------

test('记录（c）：`读数：` 冒号后为空时点红并点名该节', () => {
  const result = checkRecordCli(recordWith('列出会话', '读数：\n结论：ok\n'), 'mcp-smoke-record-blank-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：列出会话 —— `读数：` 为空/);
});

test('记录（c 纯函数）：冒号后只有空白也算空', () => {
  const missing = checkRecordText(recordWith('列出会话', '读数：   \n结论：ok\n'));
  assert.deepStrictEqual(missing, [{ title: '列出会话', reason: '`读数：` 为空（冒号后去掉空白后没有内容）' }]);
});

// ---------------------------------------------------------------------------
// (d) 端口 3001 红
// ---------------------------------------------------------------------------

test('记录（d）：起独立实例的 port=3001 必红并点名端口', () => {
  const result = checkRecordCli(
    recordWith('起独立实例', '读数：port=3001 临时库\n结论：ok\n'),
    'mcp-smoke-record-port-',
  );
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：起独立实例 —— port=3001/);
});

test('记录（d）：解析不到 port=<n> 也红（读数里没有端口同样是缺面）', () => {
  const result = checkRecordCli(
    recordWith('起独立实例', '读数：临时库 127.0.0.1\n结论：ok\n'),
    'mcp-smoke-record-noport-',
  );
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：起独立实例 —— 解析不到 `port=<n>`/);
});

test('记录（d 纯函数）：parsePort 只认逐字 port=，不误命中 SERVER_PORT=', () => {
  assert.strictEqual(parsePort('读数：port=54321 临时库'), 54321);
  assert.strictEqual(parsePort('SERVER_PORT=3001 与 port=6123'), 6123, '全大写 SERVER_PORT 不该被当端口');
  assert.strictEqual(parsePort('没有端口读数'), null);
});

// ---------------------------------------------------------------------------
// (e) 八节齐全 exit 0
// ---------------------------------------------------------------------------

test('记录（e）：八节齐全 exit 0', () => {
  const result = checkRecordCli(completeRecord(), 'mcp-smoke-record-ok-');
  assert.strictEqual(result.status, 0, `期望 exit 0，实际 ${result.status}；stderr=${result.stderr}`);
  assert.match(result.stdout, /记录合格/);
});

test('记录（e 纯函数）：八节齐全判绿', () => {
  assert.deepStrictEqual(checkRecordText(completeRecord()), []);
});

test('记录：文件不存在时 exit 1 并把八节点名全缺', () => {
  const result = runCli(['--check-record', '/tmp/definitely-not-here-mcp-smoke.md']);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  for (const title of SECTION_TITLES) {
    assert.match(result.stderr, new RegExp(`缺节：${title}`), `stderr 应点名 ${title}`);
  }
});

// ---------------------------------------------------------------------------
// 纯函数：抽取与小节写入
// ---------------------------------------------------------------------------

test('纯函数：extractSection 只取到下一个 `## ` 为止', () => {
  const text = '## 环境与版本\n\n读数：1\n结论：2\n\n## 起独立实例\n\n读数：3\n结论：4\n';
  assert.match(extractSection(text, '环境与版本') ?? '', /读数：1/);
  assert.doesNotMatch(extractSection(text, '环境与版本') ?? '', /读数：3/);
});

test('纯函数：upsertSection 重写同名小节而不留两份，且八节齐全后判绿', () => {
  const { dir, cleanup } = tempDir('mcp-smoke-upsert-');
  const file = path.join(dir, 'record.md');
  upsertSection(file, '环境与版本', '读数：first\n结论：一\n');
  upsertSection(file, '环境与版本', '读数：second\n结论：二\n');
  let text = fs.readFileSync(file, 'utf8');
  assert.strictEqual((text.match(/^## 环境与版本$/gm) ?? []).length, 1, '同名小节只应出现一次');
  assert.match(text, /second/);
  assert.doesNotMatch(text, /first/);

  for (const title of SECTION_TITLES) {
    upsertSection(file, title, title === '起独立实例' ? '读数：port=54321\n结论：ok\n' : '读数：raw\n结论：ok\n');
  }
  text = fs.readFileSync(file, 'utf8');
  assert.deepStrictEqual(checkRecordText(text), []);
  cleanup();
});

// ---------------------------------------------------------------------------
// 纯函数：终端 Claude Code 的 stream-json 解析
// ---------------------------------------------------------------------------

test('纯函数：parseClaudeStream 抠出 tool_use 与它的 tool_result', () => {
  const ndjson = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '我先列会话' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__cloudcli__sessions_list', input: {} }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '{"sessions":[]}' }] }] },
    }),
    '不是 JSON 的进度行',
    JSON.stringify({ type: 'result', subtype: 'success', result: '完成' }),
  ].join('\n');

  const parsed = parseClaudeStream(ndjson);
  assert.deepStrictEqual(parsed.toolUses.map((use) => use.name), ['mcp__cloudcli__sessions_list']);
  assert.strictEqual(parsed.toolResults[0].text, '{"sessions":[]}');
  assert.strictEqual(parsed.result.result, '完成');

  const call = toolCallFor(parsed, 'sessions_list');
  assert.strictEqual(call?.use.name, 'mcp__cloudcli__sessions_list');
  assert.strictEqual(call?.result?.text, '{"sessions":[]}');
  assert.strictEqual(toolCallFor(parsed, 'session_send'), null, '没调过的工具必须回 null（缺面要点名）');
});

// ---------------------------------------------------------------------------
// AC10：不点亮 AC-257（禁用字样在脚本里 0 次），带正控制
// ---------------------------------------------------------------------------

test('AC10：冒烟脚本里不得出现禁用的人证行字样（正控制证明这条 grep 有分辨力）', () => {
  // 逐字拼出来，免得本测试文件自己变成那个字面量的一份拷贝。
  const needle = ['嵌套冒烟验收', '：', '通过'].join('');
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const hits = source.split('\n').filter((line) => line.includes(needle)).length;
  assert.strictEqual(hits, 0, `脚本不得承载人证行字样，命中 ${hits} 行 —— AC-257 会被本任务的模板点亮`);
  // 正控制：同一条 grep 在一个确实含该字样的串上必须非零，否则这条断言没有分辨力。
  assert.strictEqual([`${needle}（人 yale 于某日）`].filter((line) => line.includes(needle)).length, 1);
});

// ---------------------------------------------------------------------------
// AC-269 外部客户端绑定记录：`--check-external-record` 的五件机械检查
//   (a) 缺一节就红并点名；      (b) 缺 `读数：`/`结论：` 行点名该节缺哪行；
//   (c) 读数或结论为空点红；    (d) 公网基址含 `ccp_`/`cca_` 令牌红并点名；
//   (e) 九节齐全 exit 0。
// ---------------------------------------------------------------------------

/** 九节齐全的一份最小外部记录：每节 `读数：raw` + `结论：ok`。 */
function completeExternalRecord() {
  return EXTERNAL_SECTION_TITLES
    .map((title) => `## ${title}\n\n读数：raw\n结论：ok\n`)
    .join('\n');
}

/**
 * 把某节换成给定正文，其余节保持齐全。
 * @param {string} target @param {string} sectionBody
 */
function externalRecordWith(target, sectionBody) {
  return EXTERNAL_SECTION_TITLES
    .map((title) => (title === target ? `## ${title}\n\n${sectionBody}` : `## ${title}\n\n读数：raw\n结论：ok\n`))
    .join('\n');
}

/**
 * 在临时目录里放一份外部记录，跑 `--check-external-record`。
 * @param {string} text @param {string} prefix
 */
function checkExternalCli(text, prefix) {
  const { dir, cleanup } = tempDir(prefix);
  const file = path.join(dir, 'record.md');
  fs.writeFileSync(file, text);
  const result = runCli(['--check-external-record', file]);
  cleanup();
  return result;
}

// — (a) 缺整节点名该节（承重腿） —
test('外部记录（a）：缺一节就红，并逐字点名缺的是哪节', () => {
  const missingTitle = 'overview 返回';
  const text = EXTERNAL_SECTION_TITLES
    .filter((title) => title !== missingTitle)
    .map((title) => `## ${title}\n\n读数：raw\n结论：ok\n`)
    .join('\n');
  const result = checkExternalCli(text, 'mcp-smoke-ext-missing-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：overview 返回 —— 缺整个小节/);
  assert.doesNotMatch(result.stderr, /缺节：客户端与版本/, '齐了的节不该被点名');
});

test('外部记录（a 纯函数）：checkExternalRecordText 对只有一节的记录点名其余八节全缺', () => {
  const missing = checkExternalRecordText('## 客户端与版本\n\n读数：raw\n结论：ok\n');
  assert.deepStrictEqual(missing.map((entry) => entry.title), EXTERNAL_SECTION_TITLES.slice(1));
  assert.ok(missing.every((entry) => entry.reason === '缺整个小节'));
});

test('外部记录（a 纯函数）：checkExternalRecordFile 对不存在的文件把九节点名全缺', () => {
  const missing = checkExternalRecordFile('/tmp/definitely-not-here-mcp-external.md');
  assert.deepStrictEqual(missing.map((entry) => entry.title), EXTERNAL_SECTION_TITLES);
});

// — (b) 缺 `读数：` / `结论：` 行点名该节缺哪行 —
test('外部记录（b-1）：缺 `结论：` 行的节点名该节缺哪行，不报整节', () => {
  const result = checkExternalCli(externalRecordWith('是否使用 DCR', '读数：raw\n'), 'mcp-smoke-ext-noconcl-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：是否使用 DCR —— 缺 `结论：` 行/);
  assert.doesNotMatch(result.stderr, /缺整个小节/, '只有一节缺一行，不该报整节缺失');
});

test('外部记录（b-2）：缺 `读数：` 行的节点名该节缺哪行', () => {
  const result = checkExternalCli(externalRecordWith('回调主机', '结论：ok\n'), 'mcp-smoke-ext-noread-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：回调主机 —— 缺 `读数：` 行/);
});

// — (c) 读数或结论为空点红 —
test('外部记录（c-1）：`读数：` 冒号后为空时点红并点名该节', () => {
  const result = checkExternalCli(externalRecordWith('工具调用超时', '读数：\n结论：ok\n'), 'mcp-smoke-ext-blank-');
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：工具调用超时 —— `读数：` 为空/);
});

test('外部记录（c-2）：`结论：` 冒号后只有空白也算空', () => {
  const missing = checkExternalRecordText(externalRecordWith('allowlist 重绑', '读数：raw\n结论：   \n'));
  assert.deepStrictEqual(missing, [{
    title: 'allowlist 重绑',
    reason: '`结论：` 为空（冒号后去掉空白后没有内容）',
  }]);
});

// — (d) 公网基址含令牌红并点名 —
test('外部记录（d-1）：公网基址含 `ccp_` 令牌必红并点名该节', () => {
  const result = checkExternalCli(
    externalRecordWith('公网基址', '读数：https://x.trycloudflare.com/mcp?token=ccp_deadbeef\n结论：ok\n'),
    'mcp-smoke-ext-token-ccp-',
  );
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：公网基址 —— 正文含令牌串/);
});

test('外部记录（d-2）：公网基址含 `cca_` 令牌必红并点名该节', () => {
  const result = checkExternalCli(
    externalRecordWith('公网基址', '读数：https://x.trycloudflare.com/?a=cca_0123456789abcdef\n结论：ok\n'),
    'mcp-smoke-ext-token-cca-',
  );
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：公网基址 —— 正文含令牌串/);
  // 令牌串只出现在别的节时不该误伤公网基址。
  const benign = checkExternalRecordText(externalRecordWith('客户端与版本', '读数：PAT 前缀 ccp_ 已据实记别处\n结论：ok\n'));
  assert.deepStrictEqual(benign, [], '令牌串写在别的节里不该让公网基址判红');
});

// — (e) 九节齐全 exit 0 —
test('外部记录（e）：九节齐全 exit 0', () => {
  const result = checkExternalCli(completeExternalRecord(), 'mcp-smoke-ext-ok-');
  assert.strictEqual(result.status, 0, `期望 exit 0，实际 ${result.status}；stderr=${result.stderr}`);
  assert.match(result.stdout, /记录合格/);
});

test('外部记录（e 纯函数）：九节齐全判绿', () => {
  assert.deepStrictEqual(checkExternalRecordText(completeExternalRecord()), []);
});

test('外部记录：文件不存在时 exit 1 并把九节点名全缺', () => {
  const result = runCli(['--check-external-record', '/tmp/definitely-not-here-mcp-external.md']);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  for (const title of EXTERNAL_SECTION_TITLES) {
    assert.match(result.stderr, new RegExp(`缺节：${title}`), `stderr 应点名 ${title}`);
  }
});

test('外部记录：`--check-external-record` 缺文件参数时给用法并 exit 1', () => {
  const result = runCli(['--check-external-record']);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /用法：node scripts\/mcp-smoke\.mjs --check-external-record <记录文件>/);
});

// — AC8：记录与脚本都不得点亮 AC-270 的人证行（负控制 + 正控制） —
test('AC8：外部记录检查器不写、不承载 AC-270 的人证行字样（正控制证明 grep 有分辨力）', () => {
  const needle = ['外部客户端验收', '：', '通过'].join('');
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.strictEqual(source.split('\n').filter((line) => line.includes(needle)).length, 0);
  // 正控制：同一条子串匹配在一个确实含该字样的串上必须非零。
  assert.strictEqual([`${needle}（人 yale 于某日）`].filter((line) => line.includes(needle)).length, 1);
});
