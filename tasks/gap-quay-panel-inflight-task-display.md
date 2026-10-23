---
id: gap-quay-panel-inflight-task-display
title: Quay tab 从未渲染后端已产出的 inFlight 读数：driver=running / tests.current.taskId
  被误读为"当前任务"
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（2026-10-07 调查结论，由"ClaudeCodeUI 自己的 Quay tab 状态显示是否有 bug"的独立排查得出；
已读代码 + 实测 HTTP/CLI/载体文件核实，调查过程中未改任何代码）：

这是另一条已完成任务 `gap-cloudcli-quay-snapshot-inflight-tasks`（status: done，commit
`247e77ed`/`a60faec9`）之上的纯前端增量——那个任务只做了后端 + MCP 这一侧（给
`server/modules/quay/quay.service.ts` 的 `QuaySnapshot` 加 `inFlight` 字段，并透传进 MCP
`quay_snapshot` 工具），**明确不碰**前端 React UI；本任务要做的是把同一个字段接到
`src/modules/quay/QuayPanel.tsx` 渲染的 Quay tab 上。

现状（已读代码 + 实测核实）：

1. 后端 `QuaySnapshot`（`server/modules/quay/quay.service.ts:240-269`）现在有
   `inFlight: QuayInFlightTask[] | null`，由 `.quay/worker-round.jsonl` 心跳推导
   （`quay.service.ts:736-778` 的 `inFlightPhase`/`summarizeInFlightTasks`），每条记录带
   `taskId`/`phase`（`'implementing'|'fan-in'`）/`startedAt`/`lastHeartbeat`/`workerPid`。
2. `server/modules/quay/quay.routes.ts` 的 `GET /:projectId/snapshot` 直接
   `res.json(snapshot)`，没有做任何字段白名单裁剪——所以这个新字段**已经原样出现在 HTTP
   响应体里**，不需要再改后端或路由这一层。
3. 前端 `src/shared/types.ts` 的 `QuaySnapshot` 类型（约 269-291 行）**没有** `inFlight`
   字段；`src/modules/quay/hooks/useQuayStatus.ts` 把响应体 `as QuaySnapshot` 断言成这个缺
   字段的类型——`inFlight` 这个 key 在运行时真实存在于对象里，只是 TS 类型和渲染代码都"看
   不见"它。
4. `src/modules/quay/QuayPanel.tsx` 全文 grep `inFlight` 零命中——没有任何卡片渲染它。
5. 因此用户此刻在 Quay tab 上能看到的、跟"活动"相关的信号只有两个代理信号，都不点名具体
   任务或会误导：
   - Driver 徽标：只查 `kind=worker` 的 `alive`/`running` 两个布尔（`quay.service.ts:839`
     附近），回答"worker driver 进程活着且忙"，不回答"在处理哪个 task"。
   - Tests 卡的 `tests.current.taskId`：绑定的是"最近一次套件运行"，可能是早已结束、且跟
     当前真正在飞的任务完全不是一个 task 的历史读数。**实测 2026-10-07 约 12:58 UTC**：
     `.quay/worker-round.jsonl` 最新心跳显示在飞任务是 `gap-mcp-session-search`（`
     in_flight_task_starts` 记录派发时刻 `2026-10-07T12:32:09.617Z`，已运行 ~26 分钟），而
     `.quay/full-suite-state.json` 的 "current" 读数却是 `taskId:
     "gap-ac261-consent-password-ratelimit-restore"`、`finishedAt` 换算为
     `2026-10-07T11:17:39Z`——一次 1 小时 41 分钟前就已经跑完、落地的历史套件。面板上同时
     渲染这两个读数（Driver "running" 徽标 + Tests 卡那个无关 taskId），没有任何视觉区分
     能让用户分清"这是哪个任务"。
   - 任务自身的 `status` 字段枚举是 `['todo','ready','done','needs-human','superseded']`
     （quay 仓库 `packages/quay/src/abi.ts:9,33`），**没有"运行中"这个状态值**——Task
     ledger 按 `status` 计数时，一个正在被 worker 实现的任务和一个纯排队中、没人碰过的任务
     在 Task ledger 里完全无法区分（都算在 `ready` 桶里）。
6. 这是纯前端类型/渲染缺口，不需要新增任何后端读数或 MCP 字段——数据已经在 HTTP 响应里。

要交付：

1. `src/shared/types.ts` 的 `QuaySnapshot` 新增 `inFlight` 字段，并新增对应的
   `QuayInFlightTask` type（`export type`，不用 interface，遵循前端规范），语义镜像后端：
   `null` = 载体没读到/不可解析（"没读到"）,`[]` = 读到了但当前没有在飞任务（"真的没有"）,
   两者不得合并；字段 `taskId`/`phase`/`startedAt`/`lastHeartbeat`/`workerPid` 与后端
   `QuayInFlightTask` 逐字段对齐。
2. `QuayPanel.tsx` 新增一个明确的"正在运行"信号区块，渲染 `snapshot.inFlight`：
   - 非空时列出每条记录的 taskId + phase（`implementing`/`fan-in`两态要有不同的视觉区分，
     例如不同文案或 data-testid，不是同一个点）+ 从 `startedAt` 算起的已运行时长（复用面板
     现有 `formatDuration`/`formatTimestamp` 风格的工具函数或新增一个同风格的）。
   - `null` 态渲染"不可用"文案（参照面板现有 `UnavailableReading` 的 null-vs-真空区分惯例，
     不得读成"没有任务在跑"）。
   - `[]` 态渲染"当前没有在飞任务"文案，与 `null` 态文案必须不同。
3. 消除"`tests.current.taskId` 被误读为当前任务"的歧义：给 TestsCard 当前这个 taskId 的
   展示加上清晰标注（例如明确标成"最近一次套件"而非裸 taskId），避免用户把它当成实时的
   任务指针；不要求计算精确的"距今多久"（载体已有 `finishedAt`，有余力可以加，但不是本任务
   的硬性要求）。
4. Driver 徽标只查 `worker` 一个 driver kind 的既有行为**不在本任务范围内**——那是一个独立
   的、关于"要不要让徽标反映六种 driver kind 里任意一种在跑"的语义决策，留给后续任务（见
   Notes）。

<!-- dedup-ref -->
边界（dedup，机制上去重已核对）：`gap-cloudcli-quay-snapshot-inflight-tasks`（已 done）做的是
后端 `quay.service.ts` + MCP `quay_snapshot` 工具这一侧，明确排除了前端渲染；本任务是在它
已经产出的 `inFlight` 字段之上做纯前端消费，两者改动的文件集合不重叠（那个任务 Touches 的是
`server/modules/quay/*`、`server/modules/mcp-gateway/*`；本任务 Touches 的是
`src/shared/types.ts`、`src/modules/quay/*`），不是重复立案。`grep -lE "QuayPanel|inFlight"
tasks/*.md` 命中的其余任务全部是 `status: done` 且机制不同（quay-panel 的历史外观任务、
claude-resident 的 running view、voice 的 inflight-dot 等字面重合），没有一个认领"Quay tab
渲染 inFlight/消除 current-task 歧义"这个具体机制。

<!-- dedup-ref -->
粒度（merge-candidate 核对，`task-granularity-advice.js --touches src/shared/types.ts
--touches src/modules/quay/QuayPanel.tsx --touches src/modules/quay/hooks/useQuayStatus.ts
--touches src/modules/quay/tests/QuayPanel.test.tsx --root <此仓库> --json` 实测）：
`peers: []`、`mentions: []`——当前没有任何开放任务声明触碰这组文件。决定：**none found**，
独立立案。

## AC

- [x] AC1 红态基线（先用真实 fixture 固定住"现在看不到"这个事实）：构造一个最小 fixture——
  `useQuayStatus`/`QuayPanel` 的测试里注入一个 `QuaySnapshot`（运行时对象，不依赖 TS 类型）
  其中 `inFlight` 是 `[{"taskId":"gap-example-task","phase":"implementing","startedAt":
  "2026-10-06T23:50:00.000Z","lastHeartbeat":"2026-10-07T00:00:00.000Z","workerPid":4242}]`。
  在改动前的代码上渲染 `QuayPanel`，断言 `screen.queryByText(/gap-example-task/)` 为 `null`
  （或等价的 DOM 查询找不到该 taskId 文本）——这就是"数据已经在响应体里，面板看不见"的最小
  复现，写下完整命令与完整输出。
- [x] AC2 判据绿：同上 fixture，改动后渲染 `QuayPanel`，断言 DOM 中出现 `gap-example-task`
  文本，且其所在行/卡片带有 `phase=implementing` 的可辨识标记（data-testid 或等价文案）。
- [x] AC3 `phase` 两态都要覆盖：追加一条 `phase: 'fan-in'` 的 in-flight 记录，断言其渲染标记
  与 `implementing` 态不同（正例对照：两种 phase 都真实渲染出不同的东西，防止"一律同一种
  文案"也能通过）。
- [x] AC4 `inFlight` 的 null-vs-空 区分：`inFlight: null` 时渲染"不可用"文案；
  `inFlight: []` 时渲染"当前没有在飞任务"文案；两条文案逐字不同，测试分别断言两种状态各自
  渲染的文本，且互不相同。
- [x] AC5 TestsCard 歧义修复：注入一个 `tests.current.taskId` 非空的 fixture，断言该 taskId
  旁边渲染着一个标明"最近一次套件/非实时任务指针"语义的 data-testid 或文案（不是裸 taskId
  旁边什么都没有）。
- [x] AC6 类型检查：`npm run typecheck` 退出 0。
- [x] AC7 现有测试不回归：`node --import tsx --test src/modules/quay/tests/QuayPanel.test.tsx
  src/modules/quay/tests/quayTabVisibility.test.tsx` 全部 pass（写 tests/pass/fail 计数）。
- [x] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单
  （新增文件用 ` (new)` 标注）。

## DoD

- 用户打开 Quay tab 能看到真正在飞的具体 task id 和它的 phase/已运行时长——不再只能靠
  Driver 徽标（不点名任务）或 Tests 卡的历史 taskId（可能早已过期、跟当前在飞任务不是一个
  task）去猜"现在是不是有任务在跑、跑的是哪个"。AC1 记录的"改动前看不到"与 AC2 记录的
  "改动后看到"两个真实读数对照，证明这条 UI 缺口被补上，不是"类型文件存在就算数"。
- 不新增、不改动任何后端读数或 MCP 字段——`server/modules/quay/`、
  `server/modules/mcp-gateway/` 目录下零改动（`git diff --stat` 可验证），因为
  `inFlight` 已经由 `gap-cloudcli-quay-snapshot-inflight-tasks` 产出并通过现有路由透传。
- 遵守 `$frontend-module-standards`（`export type`/`import type`、类型放
  `src/shared/types.ts`、组件内 state/工具函数的既有风格）与 `AGENTS.md`；不引入新依赖。

## Touches

- src/shared/types.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- tasks/gap-quay-panel-inflight-task-display.md

## Notes

- 本任务明确排除：Driver 徽标把判定范围从 `kind=worker` 扩大到六种 driver kind（promotion/
  worker/outer/quality/meta/goal）里任意一种在跑——这是一个更大的、涉及"徽标该代表哪种
  '运行'语义"的独立决策，如果要做应该是另一个任务。
- 实现落点（2026-10-07）：`useQuayStatus.ts` **未改动**（它只做整体 `as QuaySnapshot` 断言，
  加字段不需要动它），故已从 `## Touches` 移除；"经 hook 拿到的数据被 QuayPanel 正确渲染"
  由 `QuayPanel.test.tsx` 中一条注入 `api.quaySnapshot`、真实驱动 `useQuayStatus` 的用例覆盖。
- AC7 命令替换（如实记录）：AC7 字面写的是 `node --import tsx --test <这两个 .tsx>`，但这两个
  文件是 **vitest** 用例（`import { test } from 'vitest'`）。实测该字面命令在改动前后都直接
  报 `Error: Vitest failed to access its internal state.` 并以 1 退出——`node --test` 根本
  没有执行里面的用例，属命令形式不适用于 vitest 文件，而非用例失败。按 AC7 的实质要求
  （"现有测试不回归 / 全部 pass"），改用仓库真实的客户端 runner 跑**同样的两个文件**：
  `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx
  src/modules/quay/tests/quayTabVisibility.test.tsx` → `Test Files 2 passed (2)`,
  `Tests 20 passed (20)`，0 fail。
- 验证读数（2026-10-07，本 worktree，AC1/AC6/AC8）：
  - AC1（改动前红基线）：临时探针用例渲染 `QuayPanel` 并注入上面的 fixture，断言
    `screen.queryByText(/gap-example-task/) === null`，在改动前的代码上
    `npx vitest run src/modules/quay/tests/zz-ac1-red-baseline.probe.test.tsx` →
    `Test Files 1 passed (1)` / `Tests 1 passed (1)`——断言成立，即面板看不到在飞任务
    （该探针为实现前的一次性取证，已在提交前删除，不属交付物）。
  - AC6：`npm run typecheck` → 退出 0（client / server / scripts 三个 tsconfig 全过）。
  - AC8：`git diff --stat develop...HEAD` 实际改动清单为
    `src/modules/quay/QuayPanel.tsx | 98 +-`、`src/modules/quay/tests/QuayPanel.test.tsx | 122 +-`、
    `src/shared/types.ts | 26 +-`（3 files changed, 240 insertions(+), 6 deletions(-)），逐条
    对应 `## Touches` 的三条代码路径；无新增文件。`tasks/gap-quay-panel-inflight-task-display.md`
    的 tic k 由 task_write 落在 store 分支，develop 与 HEAD 内容一致，故不出现在该 diff 中。
- 若实现时发现 `src/modules/quay/hooks/useQuayStatus.ts` 不需要改动（`inFlight` 只是
  `QuaySnapshot` 类型上的新字段，hook 本身只做 `response.json() as QuaySnapshot` 的类型
  断言，不逐字段解构），可以把它从 `## Touches` 里去掉对应的改动，但测试文件仍需要覆盖
  经由这个 hook 拿到的数据被 `QuayPanel` 正确渲染。
- 调查过程中用到的 `/data/home/yale/work/quay`（quay 自身源码仓库）、`.quay/worker-round.jsonl`
  等只读证据，均为调查取证，不是本任务的 Touches 对象。
