#!/usr/bin/env node
// activity-dock-human-gate.mjs —— 活动坞人工关卡的取证通道（**只读**）。
//
// 本条同时服务两关（按 `--gate` 取材，规格抽在 `GATE_SPECS` 里）：
//   · `goal014`（默认）—— GOAL-014 的 L4 人工关卡（提案 §10.3 表格末行逐字），记录小节 §11，
//     判据 AC-190 数 `- 人工验收 GOAL-014：accepted` 的**行首**匹配。
//   · `goal015` —— GOAL-015 的人力关卡（退出条件末行逐字），记录小节 §12，判据 AC-201 数
//     `- 人工验收 GOAL-015：accepted` 的**行首**匹配。
// 这份脚本既不写产品代码（坞、任务、计划与控件分别由各 AC 落地），也**不写记录**：它只把两件事
// 读出来 —— 「人工验收小节是否写全」与「人证行是否已经由人写下」。
//
// 判据数的是**行首**匹配，所以记录小节里说明格式时，那一段模板**必须以行首之外的形式**出现；
// 一旦它以行首形式出现、又不带 `<人> <日期>` 两段载荷，就是模板泄漏 —— 人还没验收，判据就被模板
// 自己点绿了。本脚本把这一种情况判红（`state === 'leak'`），这是每一关唯一的机械陷阱。
//
// 用法：
//   node scripts/activity-dock-human-gate.mjs [--gate goal014|goal015] --check-record <记录文件>
//
// 退出码：0 = 小节齐全且无模板泄漏（stdout 打印 `人证行：absent|present`）；1 = 缺项或泄漏；2 = 用法错。
// 本文件没有任何写盘路径（只有 fs.existsSync / fs.readFileSync）：护栏用一条 fs 写调用的名字正则把
// 「人证行不可能由执行者代写」钉成机械事实 —— 那个正则的逐字放在任务文件里，故意**不**抄进本文件，
// 否则注释自己就会命中它。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 一关人工关卡的规格：记录小节标题 + 人证行行首前缀 + 必需要点清单。
 * @typedef {{
 *   id: string,
 *   label: string,
 *   sectionTitle: string,
 *   humanLinePrefix: string,
 *   requiredItems: Array<{ name: string, needles: string[] }>,
 * }} GateSpec
 */

/**
 * 逐项齐全的清单：四步人工步骤 + 每步要读到的读数 + 人证行格式说明 + 只由人写的声明。
 * `name` 里带上要点逐字，缺哪项就在 stderr 里点名哪项 —— 正控制（删一句即红）靠的就是这条：
 * 读数里能直接读到缺的那句话。
 * @type {Record<string, GateSpec>}
 */
export const GATE_SPECS = {
  goal014: {
    id: 'goal014',
    label: 'GOAL-014',
    sectionTitle: '11. 人工验收记录（GOAL-014 / AC-190）',
    humanLinePrefix: '- 人工验收 GOAL-014：accepted',
    requiredItems: [
      { name: '步骤一「让一个会话处于处理中」', needles: ['处理中'] },
      { name: '步骤二「停掉或杀掉服务端」', needles: ['停掉或杀掉服务端'] },
      { name: '步骤三「约 15 秒内读坞」', needles: ['约 15 秒内'] },
      { name: '步骤四「重启服务端看恢复」', needles: ['重启', '恢复'] },
      { name: '人要读到的第一件事「连接中断」', needles: ['连接中断'] },
      { name: '人要读到的第二件事「不再显示 Thinking」', needles: ['不再显示 Thinking'] },
      { name: '人要读到的第三件事「计时不再前进」', needles: ['计时不再前进'] },
      { name: '人证行格式说明', needles: ['人工验收 GOAL-014：accepted', '<人> <日期>'] },
      { name: '「只由人写」声明', needles: ['只由人写'] },
    ],
  },
  goal015: {
    id: 'goal015',
    label: 'GOAL-015',
    sectionTitle: '12. 人工验收记录（GOAL-015 / AC-201）',
    humanLinePrefix: '- 人工验收 GOAL-015：accepted',
    requiredItems: [
      { name: '步骤一「启动后台子代理与 Monitor」', needles: ['后台子代理', 'Monitor'] },
      { name: '步骤二「读坞里的描述/状态/最近动作」', needles: ['描述', '状态', '最近动作'] },
      { name: '步骤三「从坞里停止 Monitor」', needles: ['从坞里停止'] },
      { name: '步骤四「前台长命令转后台——读能力处置」', needles: ['前台长命令', '转后台', '不可点'] },
      { name: '读数一「坞列出描述/状态/最近动作」', needles: ['描述', '状态', '最近动作'] },
      { name: '读数二「由 SDK 的通知变为 stopped」', needles: ['由 SDK 的通知', 'stopped'] },
      { name: '读数三「能力处置可读（不可点 + 原因）」', needles: ['不可点', '原因'] },
      { name: '人证行格式说明', needles: ['人工验收 GOAL-015：accepted', '<人> <日期>'] },
      { name: '「只由人写」声明', needles: ['只由人写'] },
    ],
  },
};

/** 未传 `--gate` 时的默认关卡：字面上等价于旧的单关卡脚本，既有用例非回归。 */
export const DEFAULT_GATE = 'goal014';

/**
 * 按 id 取关卡规格；未知 id 返回 null，由 `main` 判为用法错（exit 2）。
 * @param {string} [id]
 * @returns {GateSpec | null}
 */
export function resolveGate(id = DEFAULT_GATE) {
  return Object.prototype.hasOwnProperty.call(GATE_SPECS, id) ? GATE_SPECS[id] : null;
}

/**
 * @deprecated 只作既有导入的非回归别名；新代码用 `GATE_SPECS.goal014`。
 * @type {string}
 */
export const RECORD_SECTION_TITLE = GATE_SPECS.goal014.sectionTitle;

/**
 * @deprecated 同上：默认关卡的人证行前缀。
 * @type {string}
 */
export const HUMAN_LINE_PREFIX = GATE_SPECS.goal014.humanLinePrefix;

/**
 * @deprecated 同上：默认关卡的必需要点清单。
 * @type {Array<{ name: string, needles: string[] }>}
 */
export const REQUIRED_ITEMS = GATE_SPECS.goal014.requiredItems;

/** 载荷里的占位符：出现它们说明写的是格式模板，不是人证。 */
export const PLACEHOLDERS = ['<人>', '<日期>'];

/**
 * 抽出某个 `##` 小节的正文（从 `## <标题>` 到下一个 `## ` 或文件尾）。
 *
 * 标题整行相等（尾部允许空白），所以 `## 11. …` 不会匹配到标题里含同样字样的别处。
 * @param {string} text
 * @param {string} title
 * @returns {string | null}
 */
export function extractSection(text, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##[ \\t]+${escaped}[ \\t]*$`, 'm');
  const match = heading.exec(text);
  if (match === null) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##[ \t]+/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * 扫描**行首**以 `prefix` 开头的行，判定人证行状态。
 *
 * 三种读数：
 *   · `absent` —— 一行都没有：人还没验收（这是交付时应有的状态）。
 *   · `present` —— 至少一行带了 `<人> <日期>` 两段真载荷。
 *   · `leak` —— 出现了行首匹配但**不带**载荷（或载荷就是 `<人>`/`<日期>` 占位符）：格式模板泄漏，
 *     判据会被模板自己点绿。泄漏压过 present：记录里同时存在两种行时，泄漏本身就是缺陷。
 *
 * 前缀按当前关卡参数化，所以 `--gate goal015` 只会被 GOAL-015 的模板泄漏点亮，
 * 不会被 GOAL-014 的小节误伤，反之亦然。
 * @param {string} text
 * @param {string} [prefix]
 * @returns {{ state: 'absent' | 'present' | 'leak', line: string | null, reason: string | null }}
 */
export function scanHumanLine(text, prefix = HUMAN_LINE_PREFIX) {
  const lines = text.split('\n').filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return { state: 'absent', line: null, reason: null };
  /** @type {string[]} */
  const leaks = [];
  let present = false;
  for (const line of lines) {
    const payload = line.slice(prefix.length);
    const match = /^\s+(\S+)\s+(\S+)\s*$/.exec(payload);
    if (match !== null && !PLACEHOLDERS.includes(match[1]) && !PLACEHOLDERS.includes(match[2])) {
      present = true;
      continue;
    }
    leaks.push(line);
  }
  if (leaks.length > 0) {
    return {
      state: 'leak',
      line: leaks[0],
      reason: `行首出现人证行但缺 <人> <日期> 两段载荷（模板泄漏）：${leaks[0]}`,
    };
  }
  return { state: present ? 'present' : 'absent', line: null, reason: null };
}

/**
 * 逐项检查记录文本。返回缺什么（`missing` 为空 = 合格）与人证行状态。
 *
 * 「缺小节」与「小节在但缺某项」是两种不同的缺失，分开报：只报前者会让写了一半的小节看起来像没写。
 * 模板泄漏扫的是**整个文件**（AC 措辞是「文件里出现行首 …」），不只小节内。
 * @param {string} text
 * @param {GateSpec} [spec]
 * @returns {{ missing: Array<{ item: string, reason: string }>, humanLine: 'absent' | 'present' | 'leak' }}
 */
export function checkRecordText(text, spec = GATE_SPECS.goal014) {
  /** @type {Array<{ item: string, reason: string }>} */
  const missing = [];
  const section = extractSection(text, spec.sectionTitle);
  if (section === null) {
    missing.push({ item: `小节「${spec.sectionTitle}」`, reason: '缺整个人工验收记录小节' });
  } else {
    for (const item of spec.requiredItems) {
      const absent = item.needles.filter((needle) => !section.includes(needle));
      if (absent.length > 0) {
        const named = absent.map((needle) => `「${needle}」`).join('');
        missing.push({ item: item.name, reason: `小节里找不到 ${named}` });
      }
    }
  }
  const human = scanHumanLine(text, spec.humanLinePrefix);
  if (human.state === 'leak') missing.push({ item: '人证行模板泄漏', reason: human.reason ?? '' });
  return { missing, humanLine: human.state };
}

/**
 * `--check-record`：逐项检查，缺哪项点名哪项；齐全 exit 0 并打印人证行状态。
 * @param {string} filePath
 * @param {GateSpec} [spec]
 * @returns {number} 进程退出码
 */
export function runCheckRecord(filePath, spec = GATE_SPECS.goal014) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`缺项：记录文件不存在（${filePath}）\n`);
    process.stderr.write(`记录不合格（${filePath}）：缺 1 处；要求见 AC2。\n`);
    return 1;
  }
  const result = checkRecordText(fs.readFileSync(filePath, 'utf8'), spec);
  if (result.missing.length === 0) {
    process.stdout.write(`记录合格：${filePath} 人工验收小节齐全且无模板泄漏；人证行：${result.humanLine}\n`);
    return 0;
  }
  for (const entry of result.missing) {
    process.stderr.write(`缺项：${entry.item} —— ${entry.reason}\n`);
  }
  process.stderr.write(`记录不合格（${filePath}）：缺 ${result.missing.length} 处；要求见 AC2。\n`);
  return 1;
}

/**
 * 手写 flag 解析：`--k v` 与 `--k=v` 两种都收。
 * @param {string[]} argv
 * @returns {Record<string, string | undefined>}
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
 * 主入口。本脚本只读：没有任何分支会写盘。
 * @param {string[]} argv
 * @returns {number} 进程退出码
 */
export function main(argv) {
  const flags = parseFlags(argv);
  const spec = resolveGate(flags.gate ?? DEFAULT_GATE);
  if (spec === null) {
    process.stderr.write(`用法：未知关卡 --gate ${flags.gate}（可用：${Object.keys(GATE_SPECS).join('|')}）\n`);
    return 2;
  }
  if (flags['check-record'] === undefined) {
    process.stderr.write('用法：node scripts/activity-dock-human-gate.mjs [--gate goal014|goal015] --check-record <记录文件>\n');
    return 2;
  }
  return runCheckRecord(flags['check-record'], spec);
}

// 只有本文件被**直接执行**时才跑 CLI：判据要 `import` 它的纯函数，导入不该有副作用。
// 按 realpath 比较，脚本经符号链接调用时也认得出是自己。
const invokedDirectly = process.argv[1] !== undefined
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
