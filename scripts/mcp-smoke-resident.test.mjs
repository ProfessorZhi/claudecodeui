#!/usr/bin/env node
// mcp-smoke-resident.test.mjs — `scripts/mcp-smoke.mjs` 常驻记录检查（AC-276/AC6 的 a–g）的护栏判据。
//
// 为什么这些护栏值得有自己的测试
// ------------------------------
// `--check-resident-record` 是 AC-276 判据命令里唯一的机械部分：它证明记录文件八节齐全、每节有非空
// `读数：`/`结论：`、且「撤回与 pid 不变」一节的 pid 前后相等。它**不**证明读数来自真跑（那是 DoD，
// 由 AC-277 的人工关卡判），所以它自己必须是诚实的：缺一节必须红、pid 前后不同必须红。承重腿正是
// 这两条——「缺一节就红」与「撤回节 pid 不等就红」——先红后补、由真的跑一遍 CLI 钉住（`main()` 的接线
// 本身也会坏，只调纯函数盖不住）。
//
// 覆盖（AC6 逐条）：
//   (a) 缺整节点名该节；                 (b) 缺 `读数：` / `结论：` 行点名该节缺哪行；
//   (c) 读数为空点红；                   (d) 撤回节 `pid-after` ≠ `pid-before` 点红（假形态 (ii) 的机械版）；
//   (e) 解析不到 pid 点红；              (f) 八节齐全 exit 0；
//   (g) 文件不存在八节全缺。
// 另加：AC9 的机械读法（记录模板与脚本输出都不得出现以 `常驻专有能力验收：通过` 开头的行）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RESIDENT_CANCEL_SECTION,
  RESIDENT_SECTION_TITLES,
  checkResidentRecordFile,
  checkResidentRecordText,
  parseCancelPids,
  parseResidentSection,
} from './mcp-smoke.mjs';

const SCRIPT = fileURLToPath(new URL('./mcp-smoke.mjs', import.meta.url));

/**
 * 跑一遍 `--check-resident-record` CLI。断言 stderr 时直接读 `spawnSync` 返回的 `result.stderr`
 * （内存 `node-test-stderr-does-not-reach-the-caller`：`node --test` 不把子进程 stderr 透传给调用方）。
 * @param {string[]} argv
 */
function runCli(argv) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
}

/** 撤回节的默认正文：可解析且前后相等的 pid。 */
const CANCEL_OK = '读数：session_cancel_queued outcome=cancelled pid-before=4242 pid-after=4242\n结论：ok\n';

/**
 * 八节齐全的一份最小记录：撤回节带上可解析且相等的 pid，其余每节 `读数：raw` + `结论：ok`。
 * @param {string} [cancelBody]
 */
function completeRecord(cancelBody = CANCEL_OK) {
  return RESIDENT_SECTION_TITLES
    .map((title) => (title === RESIDENT_CANCEL_SECTION
      ? `## ${title}\n\n${cancelBody}`
      : `## ${title}\n\n读数：raw\n结论：ok\n`))
    .join('\n');
}

/**
 * 把某节换成给定正文，其余节保持齐全。
 * @param {string} target @param {string} sectionBody
 */
function recordWith(target, sectionBody) {
  return RESIDENT_SECTION_TITLES
    .map((title) => {
      if (title === target) return `## ${title}\n\n${sectionBody}`;
      return title === RESIDENT_CANCEL_SECTION
        ? `## ${title}\n\n${CANCEL_OK}`
        : `## ${title}\n\n读数：raw\n结论：ok\n`;
    })
    .join('\n');
}

/** @param {string} prefix */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 在临时目录里放一份记录，跑 `--check-resident-record`。
 * @param {string} text @param {string} prefix
 */
function checkCli(text, prefix) {
  const dir = tempDir(prefix);
  try {
    const file = path.join(dir, 'resident-record.md');
    fs.writeFileSync(file, text);
    return runCli(['--check-resident-record', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (a) 缺整节点名该节
// ---------------------------------------------------------------------------

test('(a) 缺整个「审批」节点名该节', () => {
  const text = RESIDENT_SECTION_TITLES
    .filter((title) => title !== '审批')
    .map((title) => (title === RESIDENT_CANCEL_SECTION
      ? `## ${title}\n\n${CANCEL_OK}`
      : `## ${title}\n\n读数：raw\n结论：ok\n`))
    .join('\n');
  const missing = checkResidentRecordText(text);
  assert.deepEqual(
    missing,
    [{ title: '审批', reason: '缺整个小节' }],
    '缺一节时只应点名那一节，其余七节不得跟着红',
  );
});

test('(a) CLI：缺一节退出非 0，stderr 逐字点名该节', () => {
  const result = checkCli(completeRecord().replace('## 审批\n\n读数：raw\n结论：ok\n', ''), 'ac276-missing-');
  assert.notEqual(result.status, 0, '缺一节必须退出非 0');
  assert.match(result.stderr, /缺节：审批 —— 缺整个小节/, 'stderr 必须逐字点名缺的是哪一节');
});

// ---------------------------------------------------------------------------
// (b) 缺 `读数：` / `结论：` 行点名该节缺哪行
// ---------------------------------------------------------------------------

test('(b) 缺 `读数：` 行点名该节缺行', () => {
  const missing = checkResidentRecordText(recordWith('审批', '结论：ok\n'));
  assert.deepEqual(missing, [{ title: '审批', reason: '缺 `读数：` 行' }]);
});

test('(b) 缺 `结论：` 行点名该节缺行', () => {
  const missing = checkResidentRecordText(recordWith('后台任务列出与停止', '读数：raw\n'));
  assert.deepEqual(missing, [{ title: '后台任务列出与停止', reason: '缺 `结论：` 行' }]);
});

// ---------------------------------------------------------------------------
// (c) 读数为空点红
// ---------------------------------------------------------------------------

test('(c) `读数：` 冒号后为空点红并点名该节', () => {
  const missing = checkResidentRecordText(recordWith('忙时发送', '读数：   \n结论：ok\n'));
  assert.deepEqual(missing, [
    { title: '忙时发送', reason: '`读数：` 为空（冒号后去掉空白后没有内容）' },
  ]);
});

test('(c) `结论：` 冒号后为空点红并点名该节', () => {
  const missing = checkResidentRecordText(recordWith('审批', '读数：raw\n结论：\n'));
  assert.deepEqual(missing, [{ title: '审批', reason: '`结论：` 为空（冒号后去掉空白后没有内容）' }]);
});

// ---------------------------------------------------------------------------
// (d) 撤回节 `pid-after` ≠ `pid-before` 点红（假形态 (ii) 的机械版）
// ---------------------------------------------------------------------------

test('(d) 撤回节 pid-after ≠ pid-before 点红并点名 pid 不等', () => {
  const text = completeRecord('读数：outcome=cancelled pid-before=4242 pid-after=9999\n结论：ok\n');
  const missing = checkResidentRecordText(text);
  assert.deepEqual(missing, [
    { title: RESIDENT_CANCEL_SECTION, reason: 'pid 不等：pid-before=4242 pid-after=9999（撤回不得换进程）' },
  ]);
});

test('(d) CLI：撤回节 pid 不等退出非 0，stderr 逐字点名 pid 不等', () => {
  const result = checkCli(
    completeRecord('读数：outcome=cancelled pid-before=4242 pid-after=9999\n结论：ok\n'),
    'ac276-pid-',
  );
  assert.notEqual(result.status, 0, 'pid 不等必须退出非 0');
  assert.match(result.stderr, /缺节：撤回与 pid 不变 —— pid 不等：pid-before=4242 pid-after=9999/);
});

// ---------------------------------------------------------------------------
// (e) 解析不到 pid 点红
// ---------------------------------------------------------------------------

test('(e) 撤回节没有 pid-before/pid-after 两个字段时点红', () => {
  const missing = checkResidentRecordText(recordWith(RESIDENT_CANCEL_SECTION, '读数：outcome=cancelled\n结论：ok\n'));
  assert.deepEqual(missing, [
    {
      title: RESIDENT_CANCEL_SECTION,
      reason: '解析不到 `pid-before=<n>` 与 `pid-after=<n>` 两个字段（撤回节必须显式写出）',
    },
  ]);
});

test('(e) parseCancelPids 只解析 `<n>`，`pid-before=xpid-before=7` 不误命中', () => {
  assert.deepEqual(parseCancelPids('pid-before=11 pid-after=11'), { before: 11, after: 11 });
  assert.deepEqual(parseCancelPids('xpid-before=7 pid-after=11'), { before: null, after: 11 });
  assert.deepEqual(parseCancelPids('没有字段'), { before: null, after: null });
});

// ---------------------------------------------------------------------------
// (f) 八节齐全 exit 0
// ---------------------------------------------------------------------------

test('(f) 八节齐全（撤回节 pid 相等）exit 0', () => {
  const result = checkCli(completeRecord(), 'ac276-complete-');
  assert.equal(result.status, 0, `八节齐全应 exit 0，实得 ${result.status}：${result.stderr}`);
  assert.match(result.stdout, /记录合格/);
});

test('(f) parseResidentSection 三种读法：整段/读数/结论', () => {
  const parsed = parseResidentSection(completeRecord(), '忙时发送');
  assert.ok(parsed !== null, '八节齐全时「忙时发送」必须解析得到（否则下面的读数无从谈起）');
  assert.equal(parsed.reading, 'raw');
  assert.equal(parsed.conclusion, 'ok');
  assert.equal(parseResidentSection(completeRecord(), '不存在的小节'), null);
});

// ---------------------------------------------------------------------------
// (g) 文件不存在八节全缺
// ---------------------------------------------------------------------------

test('(g) 文件不存在时八节点名全缺', () => {
  const missing = checkResidentRecordFile(path.join(os.tmpdir(), 'ac276-does-not-exist-9f3a/resident.md'));
  assert.equal(missing.length, RESIDENT_SECTION_TITLES.length, '文件不存在应点名全部八节');
  assert.deepEqual(
    missing.map((entry) => entry.title),
    [...RESIDENT_SECTION_TITLES],
    '八节逐字、按 AC 顺序',
  );
  assert.ok(missing.every((entry) => /记录文件不存在/.test(entry.reason)));
});

// ---------------------------------------------------------------------------
// AC9：不点亮 AC-277 —— 脚本输出里不得出现以人证行开头的行
// ---------------------------------------------------------------------------

test('AC9 脚本源里没有以 `常驻专有能力验收：通过` 开头的行', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const lines = source.split('\n').filter((line) => line.startsWith('常驻专有能力验收：通过'));
  assert.deepEqual(lines, [], '执行者不得代写 AC-277 的人证行');
});
