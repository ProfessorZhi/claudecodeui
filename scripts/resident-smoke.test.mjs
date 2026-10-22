#!/usr/bin/env node
// resident-smoke.test.mjs — `scripts/resident-smoke.mjs` 的护栏判据（AC2/AC3）。
//
// 为什么这些护栏值得有自己的测试
// ------------------------------
// 冒烟会起一个**真服务进程**、接**真模型**、烧真钱。本机 shell 已导出 `DATABASE_PATH`
// （`/data/home/yale/.cloudcli/auth.db`，真实库）与 `HOST`，而冒烟必须写**临时**库、绑 127.0.0.1。
// 一次手滑就是往生产库里写会话、或抢 3001 上那个常驻服务。所以「必须显式给临时库」「端口 ≠ 3001」
// 不是风格问题，是唯一挡住这两件事的东西——它们必须被钉住，而且必须由**真的跑一遍 CLI**来钉，
// 不是只调一次纯函数（`main()` 的接线本身也会坏）。
//
// 覆盖：
//   1. 未显式给临时 DATABASE_PATH 时拒绝运行（三条：缺省、等于环境里的值、不在临时根下），CLI exit 1；
//   2. 受保护端口 3001 被拒；
//   3. `--check-record` 对缺节记录 exit 1 并点名缺的节、对缺 `结论：` 的节点名该节、对六节齐全 exit 0；
//   4. 「只走 HTTP/WS」是机械读数：脚本里厂商子命令名 0 次，且正控制（`resident-experiment.mjs`）非零。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GuardRefusal,
  SECTION_TITLES,
  assertIsolatedDatabasePath,
  assertSafePort,
  checkRecordFile,
  checkRecordText,
  extractSection,
  upsertSection,
} from './resident-smoke.mjs';

const SCRIPT = fileURLToPath(new URL('./resident-smoke.mjs', import.meta.url));
/** 本机 shell 导出的真实库；护栏必须挡住它。 */
const AMBIENT = '/data/home/yale/.cloudcli/auth.db';

/** @param {string[]} argv */
function runCli(argv, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: AMBIENT, ...extraEnv },
  });
}

/** 六节齐全的一份最小记录。 */
function completeRecord() {
  return SECTION_TITLES.map((title) => `## ${title}\n\n读数：\nraw\n结论：ok\n`).join('\n');
}

/**
 * 建一个临时目录，返回 { dir, cleanup }。
 * @param {string} prefix
 */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// 护栏：纯函数
// ---------------------------------------------------------------------------

test('断言：缺省 --database-path 时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({ databasePath: undefined, ambientDatabasePath: AMBIENT }),
    (error) => error instanceof GuardRefusal && /必须显式给出临时 DATABASE_PATH/.test(error.message),
  );
});

test('断言：--database-path 等于 shell 导出的值时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({ databasePath: AMBIENT, ambientDatabasePath: AMBIENT }),
    (error) => error instanceof GuardRefusal && /真实库/.test(error.message),
  );
});

test('断言：--database-path 落在临时根之外时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({
      databasePath: '/data/home/yale/work/claudecodeui/some.db',
      ambientDatabasePath: AMBIENT,
    }),
    (error) => error instanceof GuardRefusal && /不在临时根/.test(error.message),
  );
});

test('断言：临时根下的路径被接受并解析为绝对路径', () => {
  const temp = path.join(os.tmpdir(), 'resident-smoke-guard-ok', 'auth.db');
  assert.strictEqual(
    assertIsolatedDatabasePath({ databasePath: temp, ambientDatabasePath: AMBIENT }),
    path.resolve(temp),
  );
});

test('断言：受保护端口 3001 被拒，别的端口放行', () => {
  assert.throws(() => assertSafePort(3001), (error) => error instanceof GuardRefusal);
  assert.doesNotThrow(() => assertSafePort(3123));
});

// ---------------------------------------------------------------------------
// 护栏：CLI 接线（`main()` 的接线本身也会坏，所以真的跑一遍）
// ---------------------------------------------------------------------------

test('CLI：未显式给 --database-path 时 exit 1', () => {
  const result = runCli(['--temp-root', os.tmpdir()]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /必须显式给出临时 DATABASE_PATH/);
});

test('CLI：--database-path 指向真实库时 exit 1', () => {
  const result = runCli(['--database-path', AMBIENT, '--temp-root', os.tmpdir()]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /真实库/);
});

test('CLI：--database-path 不在临时根下时 exit 1（且不会起服务）', () => {
  const { dir, cleanup } = tempDir('resident-smoke-outside-');
  const result = runCli(['--database-path', path.join(dir, 'auth.db'), '--temp-root', path.join(dir, 'nested')]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /不在临时根/);
  // 拒绝发生在起服务之前：临时根里不该有日志、也不该有那个库。
  assert.deepStrictEqual(fs.readdirSync(dir), [], '护栏拒绝时不该留下任何文件');
  cleanup();
});

// ---------------------------------------------------------------------------
// `--check-record`
// ---------------------------------------------------------------------------

test('CLI：--check-record 对缺节记录 exit 1 并逐节点名', () => {
  const { dir, cleanup } = tempDir('resident-smoke-record-missing-');
  const file = path.join(dir, 'record.md');
  // 只写第一节，且它缺 `结论：`；其余五节整个缺失。
  fs.writeFileSync(file, '## 创建常驻会话\n\n读数：\nraw\n');
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /缺节：创建常驻会话 —— 缺 `结论：` 行/);
  for (const title of SECTION_TITLES.slice(1)) {
    assert.match(result.stderr, new RegExp(`缺节：${title} —— 缺整个小节`), `stderr 应点名 ${title}`);
  }
  cleanup();
});

test('CLI：--check-record 对只差一节的记录 exit 1 且不点名齐了的节', () => {
  const { dir, cleanup } = tempDir('resident-smoke-record-one-');
  const file = path.join(dir, 'record.md');
  const missing = SECTION_TITLES[SECTION_TITLES.length - 1];
  const body = SECTION_TITLES
    .filter((title) => title !== missing)
    .map((title) => `## ${title}\n\n读数：\nraw\n结论：ok\n`)
    .join('\n');
  fs.writeFileSync(file, `# 记录\n\n${body}`);
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, new RegExp(`缺节：${missing} —— 缺整个小节`));
  assert.doesNotMatch(result.stderr, /缺节：创建常驻会话/, '齐了的节不该被点名');
  cleanup();
});

test('CLI：--check-record 对缺 `结论：` 的节点名该节', () => {
  const { dir, cleanup } = tempDir('resident-smoke-record-noconcl-');
  const file = path.join(dir, 'record.md');
  const target = '关闭';
  const body = SECTION_TITLES
    .map((title) => (title === target ? `## ${title}\n\n读数：\nraw\n` : `## ${title}\n\n读数：\nraw\n结论：ok\n`))
    .join('\n');
  fs.writeFileSync(file, `# 记录\n\n${body}`);
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, new RegExp(`缺节：${target} —— 缺 \`结论：\` 行`));
  assert.doesNotMatch(result.stderr, /缺整节|缺整个小节/, `只有 ${target} 缺一行，不该报整个小节缺失`);
  cleanup();
});

test('CLI：--check-record 对六节齐全的记录 exit 0', () => {
  const { dir, cleanup } = tempDir('resident-smoke-record-ok-');
  const file = path.join(dir, 'record.md');
  fs.writeFileSync(file, completeRecord());
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 0, `期望 exit 0，实际 ${result.status}；stderr=${result.stderr}`);
  cleanup();
});

test('CLI：--check-record 对不存在的记录文件 exit 1 并点名全部六节', () => {
  const result = runCli(['--check-record', '/tmp/definitely-not-here-resident-smoke.md']);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  for (const title of SECTION_TITLES) {
    assert.match(result.stderr, new RegExp(`缺节：${title}`), `stderr 应点名 ${title}`);
  }
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('纯函数：checkRecordText 逐节报告缺什么', () => {
  const missing = checkRecordText('## 创建常驻会话\n\n读数：\n结论：ok\n');
  assert.deepStrictEqual(missing.map((entry) => entry.title), SECTION_TITLES.slice(1));
  assert.ok(missing.every((entry) => entry.reason === '缺整个小节'));
});

test('纯函数：checkRecordText 对 `关闭` 与 `重启后已关闭` 不互撞', () => {
  const text = completeRecord().replace('## 关闭\n\n读数：\nraw\n结论：ok\n', '## 关闭\n\n读数：\nraw\n');
  const missing = checkRecordText(text);
  assert.deepStrictEqual(missing, [{ title: '关闭', reason: '缺 `结论：` 行' }]);
});

test('纯函数：checkRecordFile 对不存在的文件点名全部六节', () => {
  const missing = checkRecordFile('/tmp/definitely-not-here-resident-smoke.md');
  assert.deepStrictEqual(missing.map((entry) => entry.title), SECTION_TITLES);
});

test('纯函数：extractSection 只取到下一个 `## ` 为止', () => {
  const text = '## 创建常驻会话\n\n读数：1\n结论：2\n\n## 连续三轮\n\n读数：3\n结论：4\n';
  assert.match(extractSection(text, '创建常驻会话') ?? '', /读数：1/);
  assert.doesNotMatch(extractSection(text, '创建常驻会话') ?? '', /读数：3/);
});

test('纯函数：upsertSection 重写同名小节而不留两份，且六节齐全的记录判绿', () => {
  const { dir, cleanup } = tempDir('resident-smoke-upsert-');
  const file = path.join(dir, 'record.md');
  upsertSection(file, '创建常驻会话', '读数：first\n结论：一\n');
  upsertSection(file, '创建常驻会话', '读数：second\n结论：二\n');
  let text = fs.readFileSync(file, 'utf8');
  assert.strictEqual((text.match(/^## 创建常驻会话$/gm) ?? []).length, 1, '同名小节只应出现一次');
  assert.match(text, /second/);
  assert.doesNotMatch(text, /first/);

  for (const title of SECTION_TITLES) upsertSection(file, title, '读数：raw\n结论：ok\n');
  text = fs.readFileSync(file, 'utf8');
  assert.deepStrictEqual(checkRecordText(text), []);
  cleanup();
});

// ---------------------------------------------------------------------------
// AC3：驱动面是机械读数
// ---------------------------------------------------------------------------

test('AC3：冒烟脚本里厂商子命令名 0 次，驱动面只有 fetch( 与 new WebSocket', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const hits = source.split('\n').filter((line) => line.includes('cloudcli')).length;
  assert.strictEqual(hits, 0, `冒烟脚本不该提到厂商子命令，命中 ${hits} 行`);
  assert.ok(
    /fetch\(/.test(source) && /new WebSocket/.test(source),
    '驱动面必须只由 fetch( 与 new WebSocket 构成',
  );
});

test('AC3 正控制：同一个 grep 在 resident-experiment.mjs 上非零', () => {
  const sibling = fileURLToPath(new URL('./resident-experiment.mjs', import.meta.url));
  const hits = fs.readFileSync(sibling, 'utf8').split('\n').filter((line) => line.includes('cloudcli')).length;
  assert.ok(hits > 0, `正控制必须非零，实为 ${hits} —— 为零说明这条 grep 没有分辨力`);
});
