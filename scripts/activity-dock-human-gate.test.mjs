#!/usr/bin/env node
// activity-dock-human-gate.test.mjs —— `scripts/activity-dock-human-gate.mjs` 的护栏判据（AC3/AC4）。
//
// 为什么这份护栏值得有自己的测试
// ------------------------------
// AC-190 的判据是一条 `grep -c '^- 人工验收 GOAL-014：accepted'`，它数的是**行首**匹配。于是
// 记录小节里最容易被模板自身点亮：只要说明格式的那一行以人证行的行首形式出现，人还没验收判据就绿了。
// 所以「模板泄漏判红」不是风格问题，是这条人工关卡唯一挡得住作弊的东西 —— 它必须被钉住，而且必须由
// **真的跑一遍 CLI**来钉，不是只调一次纯函数（`main()` 的接线本身也会坏）。
//
// 覆盖：
//   1. 缺文件 → exit 1 并点名；
//   2. 缺小节 → exit 1 并点名该小节；
//   3. 缺任一件事（三件要读的事各删一次）→ exit 1 并点名；
//      —— 其中「删去『计时不再前进』」是 AC4 的**正控制**：证明校验不是恒真；
//   4. 小节齐全但人证行缺失 → exit 0 且 stdout 含 `人证行：absent`；
//   5. 小节齐全且人证行带载荷 → exit 0 且 stdout 含 `人证行：present`；
//   6. 行首模板泄漏 → exit 1 并点名；
//   7. 真实提案文件 → exit 0（这是 AC2 的判据本身）。
//
// 以上是 GOAL-014/AC-190 的一组（全部保持非回归）。下面另有一组 `--gate goal015`（GOAL-015/AC-201）：
// 缺文件 / 缺小节 / 缺任一条读数三种红态、正控制（删「最近动作」即红）、absent / present / 模板泄漏三态、
// 两关前缀互不点亮、未知关卡用法错与真实提案 §12 的 AC2 判据。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GATE_SPECS,
  HUMAN_LINE_PREFIX,
  RECORD_SECTION_TITLE,
  REQUIRED_ITEMS,
  checkRecordText,
  extractSection,
  resolveGate,
  scanHumanLine,
} from './activity-dock-human-gate.mjs';

const SCRIPT = fileURLToPath(new URL('./activity-dock-human-gate.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
/** AC2 的判据文件：真实提案。 */
const REAL_RECORD = path.join(ROOT, 'docs/proposals/claude-session-activity-dock.md');

/** 三件人要读到的事（AC2 逐字）；列表化是为了「缺任一件事」能逐个删。 */
const READINGS = ['连接中断', '不再显示 Thinking', '计时不再前进'];

/** @param {string[]} argv */
function runCli(argv) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
}

/**
 * 一份小节齐全的最小记录。`omit` 里的短语会被删掉（用来造「缺任一件事」的红态），
 * `humanLine` 非空时追加一行**行首**人证行（用来造 present/leak 两态）。
 * @param {{ omit?: string[], humanLine?: string }} [opts]
 */
function sampleRecord({ omit = [], humanLine = '' } = {}) {
  const readings = READINGS.filter((reading) => !omit.includes(reading)).join(' / ');
  const tail = humanLine === '' ? '' : `${humanLine}\n`;
  return [
    '# 样本记录',
    '',
    `## ${RECORD_SECTION_TITLE}`,
    '',
    '1. 让一个会话处于处理中。',
    '2. 停掉或杀掉服务端。',
    '3. 约 15 秒内读坞。',
    '4. 重启服务端看恢复。',
    '',
    `- 人要读到的三件事：${readings}。`,
    '- 人证行格式（只由人写）：`- 人工验收 GOAL-014：accepted <人> <日期>`。',
    '- 执行者不得代写。',
    '',
    tail,
  ].join('\n');
}

/**
 * 把内容写进一个临时文件，返回其路径（测试自清理）。
 * @param {string} content
 */
function tempRecord(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-dock-human-gate-'));
  const file = path.join(dir, 'record.md');
  fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('缺文件：exit 1 并点名文件不存在', () => {
  const missing = path.join(os.tmpdir(), 'activity-dock-human-gate-absent-record.md');
  assert.equal(fs.existsSync(missing), false);
  const result = runCli(['--check-record', missing]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('记录文件不存在'), `stderr 应点名文件不存在，实际：${result.stderr}`);
});

test('缺小节：exit 1 并点名该小节', () => {
  const { file, cleanup } = tempRecord('# 样本记录\n\n## 别的小节\n\n无关内容。\n');
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(RECORD_SECTION_TITLE), `stderr 应点名小节，实际：${result.stderr}`);
  } finally {
    cleanup();
  }
});

test('缺任一件事：三件各删一次都 exit 1 并点名', () => {
  for (const reading of READINGS) {
    const { file, cleanup } = tempRecord(sampleRecord({ omit: [reading] }));
    try {
      const result = runCli(['--check-record', file]);
      assert.equal(result.status, 1, `删去「${reading}」后应 exit 1`);
      assert.ok(result.stderr.includes(reading), `stderr 应点名「${reading}」，实际：${result.stderr}`);
    } finally {
      cleanup();
    }
  }
});

test('AC4 正控制：删去「计时不再前进」前 exit 0、删后 exit 1（打印两次读数）', () => {
  const before = tempRecord(sampleRecord());
  const after = tempRecord(sampleRecord({ omit: ['计时不再前进'] }));
  try {
    const beforeResult = runCli(['--check-record', before.file]);
    const afterResult = runCli(['--check-record', after.file]);
    console.log(`[正控制] 删前 exit=${beforeResult.status} stdout=${beforeResult.stdout.trim()}`);
    console.log(`[正控制] 删后 exit=${afterResult.status} stderr=${afterResult.stderr.trim()}`);
    assert.equal(beforeResult.status, 0, '删前应 exit 0（样本本身合格）');
    assert.equal(afterResult.status, 1, '删后应 exit 1（正控制必须红）');
    assert.ok(
      afterResult.stderr.includes('计时不再前进'),
      `删后应点名「计时不再前进」，实际：${afterResult.stderr}`,
    );
  } finally {
    before.cleanup();
    after.cleanup();
  }
});

test('小节齐全且人证行缺失：exit 0 且打印 人证行：absent', () => {
  const { file, cleanup } = tempRecord(sampleRecord());
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 0, `应 exit 0，stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('人证行：absent'), `stdout 应含 人证行：absent，实际：${result.stdout}`);
  } finally {
    cleanup();
  }
});

test('小节齐全且人证行带载荷：exit 0 且打印 人证行：present', () => {
  const { file, cleanup } = tempRecord(sampleRecord({ humanLine: `${HUMAN_LINE_PREFIX} yale 2026-10-02` }));
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 0, `应 exit 0，stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('人证行：present'), `stdout 应含 人证行：present，实际：${result.stdout}`);
  } finally {
    cleanup();
  }
});

test('行首模板泄漏：exit 1 并点名', () => {
  const { file, cleanup } = tempRecord(sampleRecord({ humanLine: `${HUMAN_LINE_PREFIX} <人> <日期>` }));
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 1, '模板泄漏应 exit 1');
    assert.ok(result.stderr.includes('模板泄漏'), `stderr 应点名模板泄漏，实际：${result.stderr}`);
  } finally {
    cleanup();
  }
});

test('正控制：格式模板内联（行首不是人证行）时不算泄漏', () => {
  const text = sampleRecord();
  assert.equal(scanHumanLine(text).state, 'absent');
  assert.equal(checkRecordText(text).missing.length, 0);
});

test('真实提案文件是 AC2 的判据：exit 0 且判词与文件真实人证行状态一致', () => {
  // 人证行的有无是**人**的动作 —— 交付时 absent，人验收后 present，而写那一行正是本关卡存在的意义。
  // 所以这里断言「判词与文件真实内容一致」，**不是**把交付那一刻的 absent 钉成不变量：后者会让人
  // 一写下验收行、护栏自己就翻红（2026-10-04 的实况：AC-190 验收落笔后本用例曾恒红）。
  // 分辨力不靠这一条：absent / present / 模板泄漏三态由上面的样本用例逐个构造（line 145/156/167）。
  const expected = scanHumanLine(fs.readFileSync(REAL_RECORD, 'utf8')).state;
  const result = runCli(['--check-record', REAL_RECORD]);
  assert.equal(result.status, 0, `真实提案应 exit 0，stderr=${result.stderr}`);
  assert.ok(
    result.stdout.includes(`人证行：${expected}`),
    `判词应与文件真实状态一致（期望 人证行：${expected}），实际：${result.stdout}`,
  );
});

test('纯函数：小节抽取按整行相等，不会误配别的小节', () => {
  assert.equal(extractSection(sampleRecord(), RECORD_SECTION_TITLE)?.includes('停掉或杀掉服务端'), true);
  assert.equal(extractSection(`## ${RECORD_SECTION_TITLE} 别的东西\n`, RECORD_SECTION_TITLE), null);
});

test('REQUIRED_ITEMS 覆盖四步 + 三件事 + 格式 + 声明', () => {
  const names = REQUIRED_ITEMS.map((item) => item.name).join('\n');
  for (const needle of ['处理中', '停掉或杀掉服务端', '约 15 秒内', '重启', '恢复', ...READINGS, '格式', '只由人写']) {
    assert.ok(names.includes(needle), `REQUIRED_ITEMS 应覆盖「${needle}」`);
  }
});

// ---------------------------------------------------------------------------
// GOAL-015 / AC-201：同一份校验器按 `--gate goal015` 走 §12 规格。
// GOAL-014 的既有用例必须保持全绿（上面全部通过），这一组是新增的非回归扩展。
// ---------------------------------------------------------------------------

/** GOAL-015 的三条读数（AC-201 expect 逐字）；列表化是为了「缺任一项」能逐个删。 */
const READINGS_015 = ['描述', '状态', '最近动作'];

/** GOAL-015 关卡规格（下面用它的 sectionTitle / humanLinePrefix 造样本）。 */
const GATE_015 = GATE_SPECS.goal015;

/**
 * 一份 GOAL-015 小节齐全的最小记录。`omit` 里的短语会被替换成不含该针的写法（造缺项红态），
 * `humanLine` 非空时追加一行**行首**人证行（造 present/leak 两态）。
 * @param {{ omit?: string[], humanLine?: string }} [opts]
 */
function sampleRecord015({ omit = [], humanLine = '' } = {}) {
  /** @param {string} phrase */
  const has = (phrase) => !omit.includes(phrase);
  const readings = READINGS_015.filter(has).join('/');
  const daemon = has('后台子代理') ? '后台子代理' : '子代理';
  const monitor = has('Monitor') ? 'Monitor' : '监控';
  const fg = has('前台长命令') ? '前台长命令' : '长命令';
  const bg = has('转后台') ? '转后台' : '放后台';
  const dis = has('不可点') ? '不可点' : '可点击';
  const rsn = has('原因') ? '原因' : '说明';
  const notif = has('由 SDK 的通知') ? '由 SDK 的通知' : '来自事件';
  const tail = humanLine === '' ? '' : `${humanLine}\n`;
  return [
    '# 样本记录',
    '',
    `## ${GATE_015.sectionTitle}`,
    '',
    `1. 启动${daemon}与一个 ${monitor}。`,
    `2. 读坞里的${readings}。`,
    `3. 从坞里停止 ${monitor}。`,
    `4. 对${fg}读坞里为${bg}提供的控件：应当${dis}并给出${rsn}。`,
    '',
    `- 读数一：坞里列出${readings}。`,
    `- 读数二：停止后${notif}变为 stopped，不是点击就乐观改。`,
    `- 读数三：${bg}那一格是${dis}的控件与${rsn}文案，不是可点却静默无效。`,
    '- 人证行格式（只由人写）：`- 人工验收 GOAL-015：accepted <人> <日期>`。',
    '- 执行者不得代写。',
    '',
    tail,
  ].join('\n');
}

test('GOAL-015 缺文件：exit 1 并点名文件不存在', () => {
  const missing = path.join(os.tmpdir(), 'activity-dock-human-gate-015-absent-record.md');
  assert.equal(fs.existsSync(missing), false);
  const result = runCli(['--gate', 'goal015', '--check-record', missing]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('记录文件不存在'), `stderr 应点名文件不存在，实际：${result.stderr}`);
});

test('GOAL-015 缺小节：exit 1 并点名该小节', () => {
  const { file, cleanup } = tempRecord('# 样本记录\n\n## 别的小节\n\n无关内容。\n');
  try {
    const result = runCli(['--gate', 'goal015', '--check-record', file]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(GATE_015.sectionTitle), `stderr 应点名 §12，实际：${result.stderr}`);
  } finally {
    cleanup();
  }
});

test('GOAL-015 缺任一项：三条读数各删一次都 exit 1 并点名', () => {
  for (const reading of READINGS_015) {
    const { file, cleanup } = tempRecord(sampleRecord015({ omit: [reading] }));
    try {
      const result = runCli(['--gate', 'goal015', '--check-record', file]);
      assert.equal(result.status, 1, `删去「${reading}」后应 exit 1，实际 stdout=${result.stdout}`);
      assert.ok(result.stderr.includes(reading), `stderr 应点名「${reading}」，实际：${result.stderr}`);
    } finally {
      cleanup();
    }
  }
});

test('AC4 正控制（GOAL-015）：删去「最近动作」前 exit 0、删后 exit 1（打印两次读数）', () => {
  const before = tempRecord(sampleRecord015());
  const after = tempRecord(sampleRecord015({ omit: ['最近动作'] }));
  try {
    const beforeResult = runCli(['--gate', 'goal015', '--check-record', before.file]);
    const afterResult = runCli(['--gate', 'goal015', '--check-record', after.file]);
    console.log(`[GOAL-015 正控制] 删前 exit=${beforeResult.status} stdout=${beforeResult.stdout.trim()}`);
    console.log(`[GOAL-015 正控制] 删后 exit=${afterResult.status} stderr=${afterResult.stderr.trim()}`);
    assert.equal(beforeResult.status, 0, '删前应 exit 0（样本本身合格）');
    assert.equal(afterResult.status, 1, '删后应 exit 1（正控制必须红）');
    assert.ok(
      afterResult.stderr.includes('最近动作'),
      `删后应点名「最近动作」，实际：${afterResult.stderr}`,
    );
  } finally {
    before.cleanup();
    after.cleanup();
  }
});

test('GOAL-015 小节齐全且人证行缺失：exit 0 且打印 人证行：absent', () => {
  const { file, cleanup } = tempRecord(sampleRecord015());
  try {
    const result = runCli(['--gate', 'goal015', '--check-record', file]);
    assert.equal(result.status, 0, `应 exit 0，stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('人证行：absent'), `stdout 应含 人证行：absent，实际：${result.stdout}`);
  } finally {
    cleanup();
  }
});

test('GOAL-015 小节齐全且人证行带载荷：exit 0 且打印 人证行：present', () => {
  const { file, cleanup } = tempRecord(sampleRecord015({ humanLine: `${GATE_015.humanLinePrefix} yale 2026-10-04` }));
  try {
    const result = runCli(['--gate', 'goal015', '--check-record', file]);
    assert.equal(result.status, 0, `应 exit 0，stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('人证行：present'), `stdout 应含 人证行：present，实际：${result.stdout}`);
  } finally {
    cleanup();
  }
});

test('GOAL-015 行首模板泄漏：exit 1 并点名', () => {
  const { file, cleanup } = tempRecord(sampleRecord015({ humanLine: `${GATE_015.humanLinePrefix} <人> <日期>` }));
  try {
    const result = runCli(['--gate', 'goal015', '--check-record', file]);
    assert.equal(result.status, 1, '模板泄漏应 exit 1');
    assert.ok(result.stderr.includes('模板泄漏'), `stderr 应点名模板泄漏，实际：${result.stderr}`);
  } finally {
    cleanup();
  }
});

test('关卡规格互相隔离：goal014 前缀不点亮 goal015 样本，反之亦然', () => {
  // 样本 §12 只含 GOAL-015 前缀；用 goal014 规格扫它必须判 present 而不是被误伤。
  const { file, cleanup } = tempRecord(sampleRecord015({ humanLine: `${GATE_015.humanLinePrefix} yale 2026-10-04` }));
  try {
    const asGoal014 = runCli(['--gate', 'goal014', '--check-record', file]);
    // 用 GOAL-014 规格扫 §12 样本：缺 §11 小节 → exit 1，且**不**把人证行判成 present。
    assert.equal(asGoal014.status, 1, 'goal014 规格扫 §12 样本应因缺小节 exit 1');
    assert.ok(asGoal014.stderr.includes(RECORD_SECTION_TITLE), `stderr 应点名 §11，实际：${asGoal014.stderr}`);
    assert.equal(scanHumanLine(fs.readFileSync(file, 'utf8'), GATE_015.humanLinePrefix).state, 'present');
    assert.equal(scanHumanLine(fs.readFileSync(file, 'utf8')).state, 'absent', 'GOAL-014 前缀不应匹配 GOAL-015 的人证行');
  } finally {
    cleanup();
  }
});

test('未知 --gate 是用法错：exit 2 并列出可用关卡', () => {
  const result = runCli(['--gate', 'goal999', '--check-record', 'whatever.md']);
  assert.equal(result.status, 2, `未知关卡应 exit 2，实际 ${result.status}`);
  assert.ok(result.stderr.includes('goal014') && result.stderr.includes('goal015'), `stderr 应列出可用关卡，实际：${result.stderr}`);
});

test('resolveGate：默认 goal014，未知返回 null', () => {
  assert.equal(resolveGate()?.id, 'goal014');
  assert.equal(resolveGate('goal015')?.id, 'goal015');
  assert.equal(resolveGate('nope'), null);
});

test('GOAL-015 真实提案文件是 AC2 的判据：--gate goal015 exit 0 且判词与文件真实人证行状态一致', () => {
  // 与 line 184 的 goal014 孪生用例同形：人证行的有无是**人**的动作 —— 交付时 absent，人验收后 present。
  // 所以这里断言「判词与文件真实内容一致」，**不是**把交付那一刻的 absent 钉成不变量：后者会让人一
  // 写下验收行、护栏自己就翻红（2026-10-04 实况：AC-201 验收落笔后本用例曾恒红）。
  // 分辨力不靠这一条：absent / present / 模板泄漏三态由上面的样本用例逐个构造。
  const expected = scanHumanLine(fs.readFileSync(REAL_RECORD, 'utf8'), GATE_015.humanLinePrefix).state;
  const result = runCli(['--gate', 'goal015', '--check-record', REAL_RECORD]);
  assert.equal(result.status, 0, `真实提案应 exit 0，stderr=${result.stderr}`);
  assert.ok(
    result.stdout.includes(`人证行：${expected}`),
    `判词应与文件真实状态一致（期望 人证行：${expected}），实际：${result.stdout}`,
  );
});

test('GOAL-015 纯函数：小节抽取按整行相等，不会误配别的小节', () => {
  assert.equal(extractSection(sampleRecord015(), GATE_015.sectionTitle)?.includes('从坞里停止'), true);
  assert.equal(extractSection(`## ${GATE_015.sectionTitle} 别的东西\n`, GATE_015.sectionTitle), null);
});

test('GOAL-015 REQUIRED_ITEMS 覆盖四步 + 三条读数 + 格式 + 声明', () => {
  const names = GATE_015.requiredItems.map((item) => item.name).join('\n');
  // 步骤四/读数三的语义在 2026-10-04 改为「读能力处置」（`backgroundTasks: false` ⇒ 控件不可点并给出原因），
  // 所以这里的不变量跟着换针：'后台任务' 不再是必需项，'不可点' 是。
  for (const needle of ['后台子代理', 'Monitor', '从坞里停止', '前台长命令', '转后台', ...READINGS_015, 'stopped', '不可点', '格式', '只由人写']) {
    assert.ok(names.includes(needle), `GOAL-015 REQUIRED_ITEMS 应覆盖「${needle}」`);
  }
});
