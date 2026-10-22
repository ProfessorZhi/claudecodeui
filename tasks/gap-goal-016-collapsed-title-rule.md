---
id: gap-goal-016-collapsed-title-rule
title: GOAL-016 充分性补口：折叠行标题的「当前动作+计数+耗时」规则无 AC 覆盖，提议新增 AC-208
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-work-segment-lossless-expand-set-equality
---
## Proposal

**选型 (a)：提议新增一条 AC（不修订退出条件文本，⛔ 不改任何 GOAL/AC 状态）。** 本条由 GOAL-016 的充分性跟进 agent 立案，仅供人裁定。

### 未被覆盖的部分（逐字引用，出自 goals/GOAL-016-…md）

`## 范围` 两条（逐字）：

> - 段记录的三层可见性：折叠行标题、展开后的成员列表、成员自身的详情。
> - 折叠行标题随执行更新的规则（当前动作 + 计数 + 耗时）。

目标正文 `origin` 里人的裁定（逐字）：

> 缺省折叠且结束时不动、标题=当前动作+计数+耗时、段内不保留同名工具 xN 层、锚点内容不敏感

目标标题里对应的一截（逐字）：

> 对话流把一次工作的碎片折成一条可展开的记录

### 为何现有 AC 集覆盖不到

退出条件节逐字就是六条 AC 的标题自指（AC-202..AC-207），它本身不枚举工作分解——分解写在 `## 范围` 里，判官也被明示「judge the AC set against it, not against the exit conditions alone」。把 `## 范围` 六条与在域 AC 逐条对齐：

| `## 范围` 条目（逐字） | 覆盖它的 AC |
|---|---|
| 段选择器：纯函数，输入已渲染的行，输出行或段。 | AC-202 |
| 段记录的三层可见性：**折叠行标题**、展开后的成员列表、成员自身的详情。 | 展开后的成员列表 → AC-203；成员自身的详情 → `## 非目标` 明示「不改成员自身的渲染」；**折叠行标题 → 无** |
| **折叠行标题随执行更新的规则（当前动作 + 计数 + 耗时）。** | **无** |
| 展开态在两种增长下的保持：滚动导致的卸载、段尾部追加成员。 | AC-204（卸载）、AC-205（尾部追加） |
| 导出路径与搜索定位在合并下的不变量。 | AC-206（导出）、AC-207（搜索） |
| 真实浏览器里的缺省密度与搜索命中的可见性。 | AC-207 |

⇒ **折叠行只被当作「一个可点的壳」来钉**：AC-203 只要求它把 `segment.members.length` 暴露出来供 AC-207 的密度/搜索读数用，没有任何一条 AC 对**标题的内容**（当前动作、计数、耗时）、**随流式增长如何更新**、**结束后是否定格**取假。现有六条全绿时，折叠行可以渲染一个常量文案（甚至空白）而判据全过——而那正是目标正文里人逐轮裁定的「一条记录」的定义（`标题=当前动作+计数+耗时`）。

### 现状读数（2026-10-02，本轮实测）

- `grep -rn "^goal_ac: *AC-20[89]" tasks/*.md` → **0 命中**（新增口无人认领）。
- `grep -rn "当前动作\|计数\|耗时" src/modules/chat/` → **0 命中**（三个读数在出货代码里一处都没有）。
- `ls src/modules/chat/utils/workSegmentTitle.ts src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` → 均不存在。
- 目标级判据 AC-202..AC-207 在 `.quay/goal-round.jsonl` 最新轮（2026-10-01T16:53:46Z）verdict 全 fail，reason 均为 `No test files found`——整条轴尚未落地，折叠标题层更是零起点。

### 为何本提议覆盖得住

新增 **AC-208** 把折叠行标题的**内容与生命周期**作为可观察量钉住：三个读数必须从段本身派生（非常量）、随段尾部增长更新、且段停止增长后定格、折叠态不自动展开。它取假的对象正是上表那个空单元格——一个只渲染固定文案的折叠行。三条取假形态分别打三个读数，改坏任一个都必须红。

### 与在飞任务的关系（⛔ 不重复立案）

<!-- dedup-ref --> 本仓已有六条同轴任务 `gap-work-segment-selector-row-type-pure` / `-lossless-expand-set-equality` / `-expansion-survives-unmount` / `-anchor-stable` / `-export-forced-expand` / `-browser-density-and-search-expand`，逐条对应 AC-202..AC-207；对这六条 grep `退出条件|新 ?AC|充分性` → 0 条修改性内容，**没有任何一条提议新增/修订 AC 或退出条件**。其中 `gap-work-segment-lossless-expand-set-equality` 会创建 `src/modules/chat/transcript/WorkSegmentRecord.tsx` 并做出折叠头，但它只把 `segment.members.length` 暴露出去，**不定义标题内容**；AC-208 的实现要在该组件上补标题（见 `## Touches`），人在裁定 AC-208 时需要与那条任务的文件声明对齐。`gap-work-segment-browser-density-and-search-expand`（AC-207）只读密度与搜索命中可见性，不读标题文本。

### 给裁定人的两个选项（二选一，都由人定）

1. **采纳 AC-208（推荐）**：新增 `goals/AC-208-*.md`，`criterion` 逐字为 `npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx`，`goal: GOAL-016`，并把它加进 GOAL-016 的 `## 退出条件`。本任务随后可被派发实现。
2. **若人认为「标题内容」不该是退出条件**：修订 GOAL-016 的 `## 范围`，把「折叠行标题随执行更新的规则（当前动作 + 计数 + 耗时）」移出范围（例如移入 `## 非目标`），并删掉 `origin` 里的「标题=当前动作+计数+耗时」。选此项则本任务撤回、不派发。

（本 agent ⛔ 不写 goal-store、⛔ 不翻任何状态、⛔ 不改 `goals/*.md`；本任务的产品是提案，不是状态变更。）

## Resolution

人于 2026-10-02 裁定采纳选项 1：新增 `goals/AC-208-*.md`（`goal: GOAL-016`，`criterion` 逐字为 `npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx`）并把它加进 GOAL-016 的 `## 退出条件`；本任务随后可被派发实现。裁定结论：采纳 AC-208。红态为预期起点（该判据文件尚不存在，命令现读数为 `No test files found, exiting with code 1`）。

## AC

- [x] AC1 人已裁定「给裁定人的两个选项」之一，裁定结论记入本任务 `## Resolution`；选 2 则本任务撤回，不得派发。
- [x] AC2（若裁定选 1）新增 `goals/AC-208-*.md` 记录存在，`criterion` 逐字为 `npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx`、`goal: GOAL-016`，且 GOAL-016 的 `## 退出条件` 小节新增一行 `- AC-208 …`（经授权的 goal 写入路径，⛔ 非本 agent）。
- [x] AC3（若裁定选 1）实施后判据绿：`npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` 退出 0。红态基线（本轮实测）：该文件不存在，同一命令读数是 `No test files found, exiting with code 1`。
- [x] AC4（读数 i）三读数齐备且非退化：`-t "collapsed title carries action, count and elapsed"` 退出 0 —— 折叠头对固定夹具段（≥3 成员，含 thinking / 工具 / 子代理容器）同时暴露 a) 当前动作 = 段内**末成员**的动作标签（与成员自身既有渲染同一口径），b) 计数 = 段内成员数，c) 耗时 ≥ 0；三者都从 segment 派生，不是常量。
- [x] AC5（读数 ii）随执行更新：`-t "title tracks the growing segment while collapsed"` 退出 0 —— 向段尾逐条追加成员（≥3 次），每次在**未展开**的折叠头上：计数 +1、当前动作跟到新末成员、耗时非递减。
- [x] AC6（读数 iii）结束时不动：`-t "title freezes and stays collapsed at end of run"` 退出 0 —— 末成员 streaming 结束后标题三读数定格（再多渲染若干轮不变），折叠态保持折叠、不自动展开。
- [x] AC7 取假形态必须红（承重；先提交实现与判据，再逐条变异，逐条记录变异 diff、逐字失败行与 `git checkout -- <file>` 恢复命令）：(a) 标题三读数之一写成常量 ⇒ AC4 红；(b) 标题只在挂载时算一次、不随 segment 变化重算 ⇒ AC5 红；(c) 段停止增长时自动展开、或结束后耗时继续累加 ⇒ AC6 红。三条都必须真的红过并落记录。
- [x] AC8 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 判据跑的是真实出货实现：标题规则从 `@/modules/chat/utils/workSegmentTitle`（或等价出货模块）导入，折叠头是 `@/modules/chat/transcript/WorkSegmentRecord` 本体；⛔ 不接受测试内联一份等价的标题函数。
- 真实落地：AC-207 的真实浏览器夹具会话里，折叠行标题**实际渲染出**这三个读数——多秒长的一次工作段，其折叠行标题的计数等于该段成员数、耗时非零、当前动作是末成员的动作；仅有单测绿而浏览器里折叠行仍是常量文案不算完成。
- 三个假形态都真的红过，`git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- 只动 `## Touches` 列出的文件；标题的动作标签沿用成员既有口径，⛔ 不得读 `content`/`displayText` 猜动作（`## 非目标`：不改成员自身的渲染）。

## Touches

- `src/modules/chat/utils/workSegmentTitle.ts` (new)（折叠行标题的纯规则：当前动作 + 计数 + 耗时）
- `src/modules/chat/transcript/WorkSegmentRecord.tsx`（折叠头接上该规则；该文件由同轴 AC-203 任务创建，人裁定 AC-208 时须与 `gap-work-segment-lossless-expand-set-equality` 的 Touches 对齐）
- `src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` (new)（AC-208 判据）
- tasks/gap-goal-016-collapsed-title-rule.md

## Evidence

实现与判据已先在 `task/gap-goal-016-collapsed-title-rule` 上提交（`e18c57e8`），随后逐条取假形态；每条都由对应读数的 `-t` 用例判红，逐条 `git checkout -- <file>` 恢复。

**AC7(a) 标题动作写成常量**（`src/modules/chat/utils/workSegmentTitle.ts`）

变异 diff：
```
-  return { action: getMemberActionLabel(last), count: messages.length, elapsedMs };
+  return { action: 'Work', count: messages.length, elapsedMs };
```

读数：`npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx -t "collapsed title carries action, count and elapsed"` → `Test Files 1 failed (1) / Tests 1 failed | 2 skipped (3)`，exit 1。
逐字失败行：`src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx:107:10` —— `AssertionError: the title action must be the last member’s own label`。
恢复：`git checkout -- src/modules/chat/utils/workSegmentTitle.ts`；恢复后同命令 green（`Tests 1 passed | 2 skipped (3)`），`git status --porcelain` 对该文件干净。

**AC7(b) 标题只在挂载时算一次**（`src/modules/chat/transcript/WorkSegmentRecord.tsx`）

变异 diff：
```
-import { Fragment } from 'react';
+import { Fragment, useMemo } from 'react';
@@
-  const title = buildWorkSegmentTitle(segment);
+  const title = useMemo(() => buildWorkSegmentTitle(segment), []);
```

读数：`npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx -t "title tracks the growing segment while collapsed"` → `Test Files 1 failed (1) / Tests 1 failed | 2 skipped (3)`，exit 1。
逐字失败行：`src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx:158:12` —— `AssertionError: count must grow to 2 on append 1`。
恢复：`git checkout -- src/modules/chat/transcript/WorkSegmentRecord.tsx`；恢复后同命令 green，该文件 porcelain 干净。

**AC7(c) 结束后耗时继续累加**（`src/modules/chat/utils/workSegmentTitle.ts`）

变异 diff：
```
-  const elapsedMs = Math.max(0, toEpochMs(last.timestamp) - toEpochMs(messages[0].timestamp));
+  const elapsedMs = Math.max(0, Date.now() - toEpochMs(messages[0].timestamp));
```

读数：`npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx -t "title freezes and stays collapsed at end of run"` → `Test Files 1 failed (1) / Tests 1 failed | 2 skipped (3)`，exit 1。
逐字失败行：`src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx:195:12` —— `AssertionError: the settled run’s span must be its members’ span`。
恢复：`git checkout -- src/modules/chat/utils/workSegmentTitle.ts`；恢复后同命令 green，该文件 porcelain 干净。

**AC7(c) 段停止增长时自动展开**（`src/modules/chat/transcript/WorkSegmentRecord.tsx`）

变异 diff：
```
-        aria-expanded={expanded}
+        aria-expanded={expanded || !segment.messages[segment.messages.length - 1]?.isStreaming}
```

读数：`npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx -t "title freezes and stays collapsed at end of run"` → `Test Files 1 failed (1) / Tests 1 failed | 2 skipped (3)`，exit 1。
逐字失败行：`src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx:212:14` —— `AssertionError: a settled run must not auto-expand (round 0)`。
恢复：`git checkout -- src/modules/chat/transcript/WorkSegmentRecord.tsx`；恢复后整文件 green（`Tests 3 passed (3)`），`git status --porcelain` 空。

**AC3/AC8 读数**

- `npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` → `Test Files 1 passed (1) / Tests 3 passed (3)`，exit 0。
- 同轴回归：`workSegmentLossless` / `workSegmentGrouping` / `workSegmentAnchorStability` / `workSegmentExpansionPersistence` / `transcriptExportWorkSegments` → `Test Files 5 passed (5) / Tests 25 passed (25)`。
- `npm run typecheck` → exit 0；`npm run lint` → exit 0（仅既有 warning）。
- `git diff --name-status develop...HEAD` → `A src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx`、`M src/modules/chat/transcript/WorkSegmentRecord.tsx`、`A src/modules/chat/utils/workSegmentTitle.ts`，与 `## Touches` 逐条对齐（无额外文件）。
