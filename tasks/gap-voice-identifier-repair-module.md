---
id: gap-voice-identifier-repair-module
title: 生产用确定性标识符修复模块（src/shared）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-identifier-harness-in-repo
goal_ac: AC-113
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-005 的生产用确定性标识符修复模块（AC-113 的实现侧）：纯函数、无 React/DOM 依赖，落 `src/shared/`，与既有的 `src/shared/voiceConfig.ts` 同层，供语音链路在客户端把错拼标识符还原为项目真实文件名（候选来自既有 file-tree 接口，纯字符串运算，无模型、无额外 API 调用、无延迟）。

### 方案

`src/shared/identifierRepair.ts`：导出纯函数 `repairIdentifiers(text, candidates)`。两遍匹配：

1. 带点名字走编辑距离 + 三重护栏。对 `foo.bar.ts` 这类含点 token，在候选集里按编辑距离取最近者；护栏一：长度差提前退出返回 `Infinity`（⛔ 不是 `cap+1`——那是真实距离的下界，转成相似度即成上界，用上界做阈值必然误报）；护栏二：带点名与不带点名互斥；护栏三：必须共享首三字符。
2. 跨词符号走精确相等，⛔ 不得用相似度。`useVoiceInput` 这类 token 的转写被拆成空格，需按去空格去大小写后的精确相等匹配候选；`look at how` 与 `use voice input` 形状完全相同，任何接受后者的模糊规则都会接受前者。

四重护栏（长度差提前退出、带点/不带点互斥、共享首三字符、跨词精确相等）一条都不能省。按 AGENTS.md，`src/` 适用 `$frontend-module-standards`；新增测试须经模块 barrel 导入（本仓库 boundaries 规则）。

### 边界（不做）

不改语音链路的交互；不实现指标（由 AC-114 承载）与浏览器判据（由 AC-115 承载）；不做时间轴压缩与 prompt 偏置。

## AC

- [x] `npx vitest run src/shared/tests/identifierRepair.test.ts` 退出码 0
- [x] 模块为纯函数、无 React/DOM 依赖，落 `src/shared/` 且与 `voiceConfig.ts` 同层
- [x] 跨词符号走去空格去大小写精确相等，⛔ 不用相似度；`look at how` 这类文本不得被改写
- [x] 四重护栏齐备：长度差提前退出返回 `Infinity`、带点/不带点互斥、共享首三字符、跨词精确相等
- [x] 新测试经模块 barrel 导入
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是模块文件存在，而是 `identifierRepair.ts` 的纯函数在真实候选集（项目文件树）上被单测证明——错拼标识符被还原为项目真实文件名，且不含标识符的文本逐字不变。承重性由两个负对照证明：把长度差护栏换成 `cap+1`、或把跨词半边换成相似度阈值，对应断言必须红；两个变体各跑一次、留输出、再还原。

L_D 该轴仍暗，理由：本任务只落地 `src/shared/` 的纯字符串修复函数，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务是确定性字符串算法的落地与单测，不产出生成质量轴读数。

承重性实录（两个负对照各跑一次，跑完即还原，模块文件经 `diff` 证回字节一致）：

- 变体 A（把长度差护栏的 `Infinity` 换成 `cap+1`）：只有「a name too short to be a typo of a candidate is not stretched into it」红。实测 `repairIdentifiers('the voiceIdentifier.ts file', CANDIDATES)` 返回 `the voiceConfig.ts file`——7 个字符的长度差被当成 3 的编辑距离（下界），转成相似度 0.833 后越过 0.8 阈值，正是 `Infinity` 挡掉的那类误报。
- 变体 B（把跨词半边的精确相等换成形状相似度阈值 0.5）：7 个断言红，含 DoD 点名的那个。实测 `repairIdentifiers('look at how it behaves', CANDIDATES)` 返回 `useVoiceInput useVoiceInput`。旁证：先量过字符级相似度——`lookathow` 对 `usevoiceinput` 的 Levenshtein 相似度只有 0.077，任何人会写的阈值（≥0.6）都会拒绝它，所以「任何接受后者的模糊规则都会接受前者」对编辑距离相似度不成立；成立的是形状/长度相似度（0.692 ≥ 0.5），变体 B 实现的正是后者。

还原后 `npx vitest run src/shared/tests/identifierRepair.test.ts` 10/10 绿。

## Touches

- src/shared/identifierRepair.ts (new)
- src/shared/tests/identifierRepair.test.ts (new)
- tasks/gap-voice-identifier-repair-module.md
