---
id: gap-work-segment-selector-row-type-pure
title: AC-202 段选择器 groupWorkSegments() 的边界是行类型的纯函数且流式下不变
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-202
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rl "groupWorkSegments\|WorkSegment\|workSegments\|工作段" tasks/*.md` 0 命中；按 `goal_ac` 全量扫 272 条任务无 `AC-202`；`ls src/modules/chat/utils/workSegments.ts src/modules/chat/tests/workSegmentGrouping.test.ts` 均不存在（本轮已确认）。同轴兄弟判据 AC-203（折叠态无损）/ AC-204（展开态跨 LazyMessageRow 卸载保持）/ AC-205（段锚点稳定）/ AC-206（导出强制展开）/ AC-207（真实浏览器读数）是不同机制，本仓库目前也都没有归属任务。⇒「段选择器本身」无人认领，不是重复。

**现状读数（2026-10-02，读代码）。** 转写流今天只有一层合并：`src/modules/chat/utils/toolGrouping.ts` 的 `groupConsecutiveTools` 把「连续同名工具、条数 ≥ TOOL_GROUP_THRESHOLD(2)」折成一个 `ToolGroupItem`；它的成员判定是 `isToolUse && toolName && !isSubagentContainer`，并且在扫描时把 `rendersNothing`（thinking 且 showThinking=false）的行静默跨过（`toolGrouping.ts:24-27`、`groupConsecutiveTools` 内层 `continue`）。GOAL-016 要的是上一层「工作段」：吸收 thinking / 工具调用 / 子代理容器三类行，一切非成员行终止段；段内不再保留同名工具的 xN 层（GOAL-016 非目标第 5 条）。AC-202 钉的是这一层选择器的**边界只由行类型决定**，且在流式（末行正文由空变非空）下不变；目标级判据当前在 `.quay/gate-events.jsonl` 里的读数是 `No test files found, exiting with code 1`（判据文件不存在）。

**要做的事。** 新增纯函数 `groupWorkSegments()`：输入已渲染的 `ChatMessage[]`，输出 `MessageListItem[]`（原来的行，或一个 `WorkSegment`）。成员判定只看行类型字段 `isThinking / isToolUse / isSubagentContainer`，一切非成员行（正文行、用户行、分隔行、压缩行、任务通知行、常驻待定行）终止段；段内 N 条同名工具调用是 N 个成员，不折 xN；只有 1 个成员的段直接输出该行本身，不包壳。函数不得读渲染文本、不得读 React / DOM / store —— 「行类型的纯函数」是 AC-202 的字面要求，也是 (iv) 流式不变读数的前提。段的身份暂取首成员的行内键（`getIntrinsicMessageKey`，`src/modules/chat/utils/messageKeys.ts`），锚点的跨尾部增长稳定性由 AC-205 单列。

**本任务不做的（属同轴兄弟判据）。** <!-- dedup-ref --> 段记录的三层可见性渲染、LazyMessageRow 适配、导出强制展开、真实浏览器读数分别归 AC-203 / AC-204 / AC-206 / AC-207。本任务只交付选择器与它的判据文件，避免与兄弟任务的 `## Touches` 相撞（同一文件集被两个任务同时声明会触发 anti-drift 判定）。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/workSegmentGrouping.test.ts` 退出 0。红态基线：实现前该文件不存在（本轮 `ls` 已确认），目标级判据读数是 `No test files found, exiting with code 1`。
- [x] AC2（读数 i，承重）空内容不改变边界：`npx vitest run src/modules/chat/tests/workSegmentGrouping.test.ts -t "empty content does not move boundaries"` 退出 0 —— 工具行内部 prose（`displayText` / `content`）为空时该行仍是成员、段不被切断；独立的正文行即使 `content` 为空也终止段、且不被跨过。
- [x] AC3（读数 ii）段内 N 条同名工具调用产出 N 个成员：`-t "same-name tool calls stay N members"` 退出 0 —— 断言成员数组长度与原行数相等，输出里不存在任何 `_isGroup` / xN 折叠产物。
- [x] AC4（读数 iii）只有 1 个成员的段不包壳：`-t "single-member run is not wrapped"` 退出 0 —— 输出里该项就是原来那一行本身（引用相等），与今天逐行渲染等价。
- [x] AC5（读数 iv，承重）流式稳定：`-t "boundaries are stable while the tail text streams in"` 退出 0 —— 同一输入在「末行正文由空变非空」前后两次求值，段边界（各段的起止成员键序列）逐项相等，成员的 `content` 不参与边界判定。
- [x] AC6（读数 v）结构性行一律终止段：`-t "structural rows terminate the segment"` 退出 0 —— 用户行（`type: 'user'`）、分隔行（`UNATTENDED_DIVIDER_MESSAGE_TYPE`）、压缩行（`isCompactSummary` / `compact`）、任务通知行（`isTaskNotification`）、常驻待定行（`RESIDENT_PENDING_MESSAGE_TYPE`）逐类各一条用例。
- [x] AC7 取假形态必须红（承重，先提交再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(a) 把终止条件改成「正文非空才终止」（空 prose 行被静默跨过）⇒ AC2 红；(b) 把同名工具折回一层 xN ⇒ AC3 红；(c) 把成员判定改成看渲染文本（成员必须有可见文本）⇒ AC5 红。
- [x] AC8 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 判据文件跑的是真实实现：测试 `import` 的是 `src/modules/chat/utils/workSegments.ts` 里出货的那个 `groupWorkSegments`，不接受测试内联一份等价实现。
- `groupWorkSegments()` 是纯函数：不 import React / DOM，不读 store、全局或 `window`；判据文件是 `.ts`（不是 `.tsx`），只跑 node 语义即可加载该模块。
- 成员判定只出现行类型字段（`isThinking` / `isToolUse` / `isSubagentContainer`）；实现里不出现对 `content` / `displayText` 或任何渲染文本的读取来决定段的边界。
- 三个假形态都真的红过，且 `git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 干净。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- src/modules/chat/utils/workSegments.ts (new)
- src/shared/types.ts
- src/modules/chat/tests/workSegmentGrouping.test.ts (new)
- tasks/gap-work-segment-selector-row-type-pure.md


## Worker evidence

AC7 三个假形态：先提交实现（`ce9a832e`），再逐条变异，每条用
`git checkout -- src/modules/chat/utils/workSegments.ts` 恢复。

- (a) 终止条件改成「正文非空才终止、空 prose 行静默跨过」⇒ AC2 红：
  `workSegmentGrouping.test.ts:63` `AssertionError: an empty body row must not be crossed over`
  / `1 !== 3`。变异 diff：`/data/scratch/yale/gap-work-segment-selector-row-type-pure/mutation-a.diff`。
- (b) 同名工具调用折回一层 xN ⇒ AC3 红：`workSegmentGrouping.test.ts:79`
  `Expected values to be strictly deep-equal`：actual `[['a']]`，expected `[['a','b','c','d']]`。
  变异 diff：`.../mutation-b.diff`。
- (c) 成员判定改看渲染文本（成员必须有可见文本）⇒ AC5 红：`workSegmentGrouping.test.ts:109`
  `AssertionError: a member's content must not participate in boundary selection`：
  actual `[['message-assistant-block-a','message-assistant-block-b']]`，
  expected 同前加 `'message-assistant-block-tail'`。变异 diff：`.../mutation-c.diff`。

恢复后 `git status --porcelain` 为空，AC1 判据 10/10 绿（`red-a/b/c.txt` 为三条红态原文）。

## Needs-Human

**执行 2026-10-01T17:36:17.740Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：5abaead6-762b-46e0-b7dc-5dd6e276e401
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-work-segment-selector-row-type-pure~wk-prod-anchor~1790876124744-3b0908.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-work-segment-selector-row-type-pure-wk-prod-anchor.log
