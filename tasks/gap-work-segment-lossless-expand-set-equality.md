---
id: gap-work-segment-lossless-expand-set-equality
title: AC-203 段记录折叠态零信息丢失：展开全部段后的行键集合与合并前逐键相等
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-work-segment-selector-row-type-pure
goal_ac: AC-203
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-02）：`grep -rln "WorkSegmentRecord\|workSegmentLossless\|段记录\|无损" tasks/*.md` 只命中同轴 AC-202 任务里的一段散文（另一个命中 `gap-soak-mock-gateway-burst-materialization` 是「无损」二字的无关词）；按 `goal_ac:` 全量扫本仓 356 条声明，无任何任务声明 `AC-203`；`ls src/modules/chat/transcript/WorkSegmentRecord.tsx src/modules/chat/tests/workSegmentLossless.test.tsx` 均不存在（本轮已确认）。⇒「段记录的折叠/展开会不会吃内容」无人认领，不是重复。

**现状读数（2026-10-02）。** 目标级判据 `npx vitest run src/modules/chat/tests/workSegmentLossless.test.tsx` 本轮实跑的读数是 `No test files found, exiting with code 1`（判据文件不存在）。转写流今天只有 `src/modules/chat/utils/toolGrouping.ts` 的同名工具折叠层，没有任何「段记录」组件：`src/modules/chat/transcript/` 下没有 WorkSegmentRecord，折叠/展开这一层既没实现、也没被任何判据钉住。AC-203 要的正是这一层的硬断言——合并（折叠）只能隐藏行，不能丢弃行、thinking 块、工具调用或子代理容器。

**要做的事。** 交付段记录组件 `src/modules/chat/transcript/WorkSegmentRecord.tsx` 与判据 `src/modules/chat/tests/workSegmentLossless.test.tsx`：

- 组件 props：`{ segment: WorkSegment; expanded: boolean; onToggle?: (next: boolean) => void; renderMember: (message: ChatMessage, index: number) => ReactNode }`。成员行由外部注入（`renderMember`），组件自己不 import 面板、不认识 MessageComponent 的那一堆 props —— 这正是 AC-204 能把 LazyMessageRow 包好的成员行喂进来、而本任务不必动面板的原因。
- `expanded === false`：只渲染折叠头（把 `segment.messages.length` 作为可读计数暴露出来，供 AC-207 的密度/搜索读数用），**一次都不调用** `renderMember`。
- `expanded === true`：按 `segment.messages` 的顺序对每个成员**恰好调用一次** `renderMember`；不按行类型筛成员、不截断。
- 不变量（承重）：对任意输入，`keys(全部段展开渲染) === keys(合并前输入)`，键取 `getIntrinsicMessageKey`；折叠只允许把成员从挂载里移走，不允许改写或消耗 `segment.messages` 本身（折叠后再展开必须回到同一个集合）。

**出货类型说明（2026-10-02 实测）。** 出货的 `WorkSegment` 成员字段名是 `messages`（`src/shared/types.ts:1080`），不是 Proposal 里写的 `members`；实现与判据一律按出货类型取 `segment.messages`，语义不变（组件只读数组长度与顺序）。另：`groupWorkSegments` 对**恰好 1 个成员**的 run 不包壳（直接 emit 该成员），所以「单成员段」这一宽度只能由判据直接用出货 `WorkSegment` 类型构造（AC5），选择器不会产出它。

**判据怎么读（集合相等，不是比条数、也不是比文本）。** 固定夹具会话 → `groupWorkSegments()` 得 items（「合并前」的基准 = 夹具自身的键集合）→ 把 items 全部按 `expanded` 渲染（非段行照常渲染，段行渲染 `WorkSegmentRecord`）→ 从 DOM 收集每个真正挂载的成员行上的键 → 断言集合与夹具**相等**。判据自带的 `renderMember` 探针渲染一个带 `data-message-key` 的 div，所以「挂载」是 DOM 事实，不是内部调用计数。

**本任务不做的（属同轴兄弟判据）。** <!-- dedup-ref --> 面板采用该组件、以及段在 LazyMessageRow 卸载/重挂下的保持归 AC-204；导出路径强制展开归 AC-206；真实浏览器密度与搜索命中自动展开归 AC-207；段边界的选择器本身归本任务声明的前置依赖。本任务只交付记录组件与判据，避免与兄弟任务的 `## Touches` 相撞（同一文件集被两个任务同时声明会触发 anti-drift 判定）。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/workSegmentLossless.test.tsx` 退出 0。红态基线（本轮实跑）：该文件不存在，同一命令读数是 `No test files found, exiting with code 1`。实现后实跑：`Test Files 1 passed (1) / Tests 4 passed (4)`，exit 0。
- [x] AC2（读数 i，承重）展开全部段后逐键相等：`npx vitest run src/modules/chat/tests/workSegmentLossless.test.tsx -t "expanded segments render every pre-merge key"` 退出 0 —— 夹具的键集合与展开后 DOM 里 `data-message-key` 的集合**相等**（用集合断言，如排序后 `assert.deepEqual`）。既不许多（段头不得凭空造一个夹具里没有的键），也不许少（差集必须为空）。
- [x] AC3（读数 ii，承重）折叠只隐藏不丢弃：`-t "collapse hides but does not consume"` 退出 0 —— 同一批段按 `expanded=false` 渲染时，DOM 里被挂载的成员键数为 0（隐藏成立）且折叠头暴露 `segment.messages.length`；随后把**同一批段对象**再按 `expanded=true` 渲染，键集合仍与夹具逐键相等（折叠态不得改写或消耗 members）。
- [x] AC4（读数 iii）正控制：`-t "fixture actually exercises a multi-member segment"` 退出 0 —— 夹具必须含至少一个 ≥3 成员的段，成员里同时有 thinking 行、工具调用行与子代理容器行，且该段两端外侧各有一条非成员行（正文行/用户行）。断言这个夹具形状本身成立；否则「少一行」与「少一类」都测不出来（对照 [[zero-claim-criterion-needs-positive-controls]] 的教训）。夹具实为 4 成员段（thinking k1 / tool k2 / subagent k3 / thinking k4），两侧为非成员 u1、a1。
- [x] AC5（读数 iv）单成员段不包壳：`-t "single-member segment renders that member itself"` 退出 0 —— 只有 1 个成员的段展开后，DOM 里出现的就是该成员的键，且只出现一次，没有额外的包装键。
- [x] AC6 取假形态必须红（承重；先提交实现与判据，再逐条变异；逐条记录变异 diff、逐字失败行与 `git checkout -- <file>` 恢复命令）：(a) 展开路径漏渲尾部成员（如 `segment.messages.slice(0, -1)`）⇒ AC2 集合差集非空，红；(b) 过滤 thinking 成员（`members.filter(m => !m.isThinking)`）⇒ AC2 红；(c) 让段的成员数组漏掉最后一条（在段构建里丢掉尾成员）⇒ AC2 红。三条都必须真的红过并落记录。三条均实测红、逐条落记录于 `## Evidence`。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。实测 typecheck exit 0、lint exit 0（本仓既存 warning 不在本任务文件内），delta vs develop 恰为 Touches 的两条 `(new)`。

## DoD

- 判据跑的是真实出货实现：`import WorkSegmentRecord from '@/modules/chat/transcript/WorkSegmentRecord'`，段来自 `@/modules/chat/utils/workSegments` 出货的 `groupWorkSegments`；不接受测试内联一份等价的段记录或等价的选择器。
- 组件不参与成员取舍：`WorkSegmentRecord` 不读 `content` / `displayText` 决定渲染谁，不按 `isThinking` / `isToolUse` / `isSubagentContainer` 过滤成员，不做 `slice` 截断；成员的取舍只发生在选择器层。
- 两个可见状态只由 `expanded` 一个布尔驱动：`renderMember` 的调用次数在 collapsed 下为 0、expanded 下等于 `segment.messages.length`；折叠→展开往返不改变键集合。
- 三个假形态都真的红过，且 `git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件（例如共享类型落点），先把该文件加进 `## Touches` 再写。

## Touches

- `src/modules/chat/transcript/WorkSegmentRecord.tsx` (new)（段记录组件：折叠头 + 展开成员列表）
- `src/modules/chat/tests/workSegmentLossless.test.tsx` (new)（AC-203 判据：展开全段的键集合与合并前逐键相等）
- tasks/gap-work-segment-lossless-expand-set-equality.md

## Evidence

实现与判据已先在 `task/gap-work-segment-lossless-expand-set-equality` 上提交（`e9463614`），随后逐条取假形态；每条都由 `-t "expanded segments render every pre-merge key"`（AC2）判红，逐条 `git checkout -- <file>` 恢复。

**AC6(a) 展开路径漏渲尾部成员**（`src/modules/chat/transcript/WorkSegmentRecord.tsx`）

变异 diff：
```
-          {segment.messages.map((message, index) => (
+          {segment.messages.slice(0, -1).map((message, index) => (
```

读数：`npx vitest run src/modules/chat/tests/workSegmentLossless.test.tsx -t "expanded segments render every pre-merge key"` → `Test Files 1 failed (1) / Tests 1 failed | 3 skipped (4)`，exit 1。
逐字失败行：`src/modules/chat/tests/workSegmentLossless.test.tsx:120:10`（`assert.deepEqual(`），差集 `- "message-assistant-block-k4"`（Expected 有、Received 无）。
恢复：`git checkout -- src/modules/chat/transcript/WorkSegmentRecord.tsx`；恢复后同命令 green，`git status --porcelain` 对该文件干净。

**AC6(b) 过滤 thinking 成员**（`src/modules/chat/transcript/WorkSegmentRecord.tsx`）

变异 diff：
```
-          {segment.messages.map((message, index) => (
+          {segment.messages.filter((message) => !message.isThinking).map((message, index) => (
```

读数：同上命令 → `Test Files 1 failed (1) / Tests 1 failed | 3 skipped (4)`，exit 1。
逐字失败行：`src/modules/chat/tests/workSegmentLossless.test.tsx:120:10`，差集 `- "message-assistant-block-k1"`、`- "message-assistant-block-k4"`（两条 thinking 行缺失）。
恢复：`git checkout -- src/modules/chat/transcript/WorkSegmentRecord.tsx`；恢复后同命令 green，该文件 porcelain 干净。

**AC6(c) 段构建丢尾成员**（`src/modules/chat/utils/workSegments.ts`）

变异 diff：
```
       items.push({
         _isWorkSegment: true,
         key: getIntrinsicMessageKey(message),
-        messages: members,
+        messages: members.slice(0, -1),
       });
```

读数：同上命令 → `Test Files 1 failed (1) / Tests 1 failed | 3 skipped (4)`，exit 1。
逐字失败行：`src/modules/chat/tests/workSegmentLossless.test.tsx:120:10`，差集 `- "message-assistant-block-k4"`（段成员数组少一条，k4 整条丢失）。
恢复：`git checkout -- src/modules/chat/utils/workSegments.ts`；恢复后整文件 green（`Tests 4 passed (4)`），`git status --porcelain` 空。
## Needs-Human

**执行 2026-10-02T03:01:41.383Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts:   AssertionError [ERR_ASSERTION]: the probe process must offer a raw write seam to write the frame to
- run_id：wk-prod-anchor
- session_id：a0c05f2e-0d5b-4e8b-b76e-b8bdc042067b
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-work-segment-lossless-expand-set-equality~wk-prod-anchor~1790909919140-da4cdd.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-work-segment-lossless-expand-set-equality-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-02T03:34:02.639Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts:   AssertionError [ERR_ASSERTION]: the probe process must offer a raw write seam to write the frame to
- run_id：wk-prod-anchor
- session_id：75b88763-2122-4522-964c-28d198c9de0f
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-work-segment-lossless-expand-set-equality~wk-prod-anchor~1790911844791-285102.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-work-segment-lossless-expand-set-equality-wk-prod-anchor.log
