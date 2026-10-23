---
id: gap-cloudcli-quay-snapshot-inflight-tasks
title: CloudCLI 的 quay_snapshot 暴露不到正在执行的具体 task：复用 .quay/worker-round.jsonl 载体补
  in-flight 读数（taskId/phase/startedAt/lastHeartbeat/可用时的 workerPid），不改
  sessions_list 的既有 running 语义
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（2026-10-07 调查结论，由一次"Quay Web 能看到任务在跑，但 ChatGPT 经 CloudCLI 的
quay_snapshot + sessions_list(state=running) 查询同一项目却看不到正在执行的具体任务"的现象
排查得出；已读代码核实，未改任何代码）：

现状（已读代码核实）：

1. `sessions_list(state='running')`（`server/modules/mcp-gateway/mcp-gateway.read-tools.ts:811`）
   的 `running` 来自 `deps.runs.listRunningRuns()`，生产绑定是 `chatRunRegistry`
   （`server/index.ts:29`）——只登记经 ClaudeCodeUI 自己 WebSocket 聊天路径发起的 run（用户在 UI
   发消息，或 `chatRunRegistry.openUnattendedRun(...)`）。Quay 的任务执行是另一条完全独立的路：
   `plugin/scripts/worker-driver.ts`（quay 仓库，约行 4464-4497）用 `spawn(cmd, cmdArgs, {cwd:
   rootDir, ...})` 直接起子进程、自己 `newSessionId()` 铸造 sessionId，从未经过
   `chatRunRegistry`/`sessionHostManager`。所以 `sessions_list(state='running')` 对 Quay
   worker 驱动的会话**结构性地、必然**返回空——这不是竞态，是两套完全不同的"运行"概念
   （ClaudeCodeUI 自己的聊天回合 vs Quay 自己派发的任务执行）。**本任务不改这条语义**——
   `sessions_list`/`chatRunRegistry` 的 running 判定是否要纳入"外部进程"是一个更大的、涉及
   ClaudeCodeUI 会话生命周期语义边界的决策，留给后续任务单独评估，不在本任务范围内。
2. CloudCLI 的 `quay_snapshot`（`server/modules/mcp-gateway/mcp-overview-tools.ts:334-398`，
   数据来自 `server/modules/quay/quay.service.ts`）现在返回
   `tasks/goals/adrs/driver/suite/fanIn/dashboardUrl/warnings`，但：
   - `driver`（`QuayDriverSummary`，`quay.service.ts:79-86` 类型定义，`summarizeDriver`
     函数在 `quay.service.ts:675-694`）只来自 `quay driver status --kind worker --json`
     （`collectSnapshot` 里的调用在 `quay.service.ts:839`，六个 driver kind 里只查了
     `worker` 这一个），且这个 CLI 子命令本身（quay 仓库 `plugin/scripts/driver-runtime.ts`
     的 `statusForKind`，约行 2980-3014）只回答 `alive`/`running`/`last_record_ts`——**进程
     活没活着，不回答在处理哪个 task**。这是上游 quay CLI 本身目前就没有这个字段，不是
     ClaudeCodeUI 这边读漏了。
   - `suite.current.taskId`（`QuaySuiteState`，`quay.service.ts:151-164`，来自
     `.quay/full-suite-state.json`）只在"全量验证/fan-in 轮"这个短暂阶段非空；任务生命周期
     里大部分时间（实现/写代码阶段）这个字段是 `null`。
   - 真正带着"当前正在处理哪些 task id"的载体是 `.quay/worker-round.jsonl`（quay 仓库
     `packages/quay/src/observation.ts:645` 定义为 `WORKER_ROUND_REL`）：`worker-driver.ts`
     的 `writeRound`（quay 仓库，约行 4885-4920）**每轮无条件**写一条心跳记录，字段包括
     `at`（ISO 时刻，本轮心跳时间）、`pid`（worker driver 循环自身进程号，**不是**逐任务
     子进程号）、`inFlightTasks()`（当前在飞的 task id 列表）、`inFlightTaskStarts()`
     （每个在飞 task 的派发起点时刻，ISO）。这正是 quay 自己的 `quay serve` Web 仪表盘
     "Live" 卡片（`packages/quay/src/serve-live.ts`/`serve-dashboard.ts` 的 `readLive()`）
     据以渲染"当前有哪个任务在跑"的核心数据源之一——用户在浏览器里看到的"明确有任务在跑"，
     很可能就是这条链路（或配合 `/proc` 扫描 + `~/.claude/sessions/<pid>.json` 做的会话
     id 解析，那部分更重，见 Notes）。
   - `server/modules/quay/quay.service.ts` 的 `collectSnapshot`（约行 779-880）已经用同一套
     注入的 `QuayFileReader` 读了三个 `.quay/` 载体文件（`full-suite-state.json` 经
     `readCurrentSuiteState`、`verification-round.jsonl` 与 `worker-outcome.jsonl` 经
     `readCarrierFileTail`），**从未读过** `worker-round.jsonl`。
   - `fanIn: QuayFanInSummary`（`quay.service.ts:194-196`，来自已读的 `worker-outcome.jsonl`）
     已经携带每个任务最近一次 fan-in 尝试的 `lockAcquireEpoch`/`lockReleaseEpoch`，可以直接
     复用来判断"这个在飞任务现在是不是卡在 fan-in 锁里"，不需要另外定义一套 fan-in 状态。
3. ClaudeCodeUI 不依赖 quay 的 npm 包（`grep "\"quay\"" package.json` 为空），架构上把 quay
   当作"外部 CLI + 只读 flat files"，从不 import quay 的 TS 源码（比如
   `packages/quay/src/observation.ts` 的 `readLive`/`pairInFlight`/`readLiveWorkerProcesses`/
   `liveSessionIdForPid` 等）。本任务**不改变**这个架构边界：新增的读数要走
   `quay.service.ts` 已有的 `QuayFileReader` 读 flat-file 载体这条路，**不要**跨包 import
   quay 的源码，也**不要**新增 `/proc` 扫描——那是 quay 自己 Live 页更重的实现，复刻它的
   `pairInFlight`/`InFlightPhase`（implementing/fan-in/awaiting-land/landed 四态，需要额外
   读 `.workflow-events/`）是一个明显更大的任务，本任务不做，只做"一眼就能看出任务 id 和它
   还活不活"这一层最小可用读数。

要交付：

1. **新载体读取 + 新类型（`server/modules/quay/quay.service.ts` + `server/modules/quay/index.ts`）**：
   新增导出类型
   ```
   export type QuayInFlightTask = {
     taskId: string;
     /** 'fan-in'：fanIn.recent 里该 task 最近一条尝试的 lockAcquireEpoch 非 null 且
      *  lockReleaseEpoch 仍是 null（锁未释放）；否则 'implementing'。两态复用已收集的
      *  fanIn 读数判定，不新开一套状态机。 */
     phase: 'implementing' | 'fan-in';
     /** worker-round 记录里 inFlightTaskStarts[taskId] 的派发时刻（ISO），读不到为 null。*/
     startedAt: string | null;
     /** 产出本条读数的那条 worker-round 记录自身的 `at`（本轮心跳时刻），ISO。*/
     lastHeartbeat: string;
     /** worker-round 记录的 `pid`（worker driver 循环自身进程号，不是逐任务子进程号——
      *  honest 字段名/注释说明这个边界，不得冒充逐任务 pid）；读不到为 null。*/
     workerPid: number | null;
   };
   ```
   在 `QuaySnapshot`（`quay.service.ts:209-230`）新增字段
   `inFlight: QuayInFlightTask[] | null`——`null` = `.quay/worker-round.jsonl` 不存在/读取
   失败/不可解析（载体层面的"没读到"），`[]` = 载体读到了但当前 `inFlightTasks` 为空（真实的
   "没有任务在飞"，与"没读到"是两个不同的值，不得合并——同本模块既有 `tests.current`/
   `driver` 的 null-vs-真空 区分惯例）。`collectSnapshot`（约行 825-853 的
   `Promise.all`）里新增一次对 `.quay/worker-round.jsonl` 的读取（同一个注入的
   `dependencies.readFile` seam；取最后一条可解析的 JSONL 记录即可，不必像
   `verification-round.jsonl`/`worker-outcome.jsonl` 那样保留 `QUAY_RECENT_LIST_LIMIT`
   条历史——in-flight 只关心"现在"），解析出 `inFlightTasks`/`inFlightTaskStarts`/`at`/
   `pid`，叠加已经并行收集到的 `fanInRecords` 判定每个 task 的 `phase`，产出
   `QuayInFlightTask[]`。在 `server/modules/quay/index.ts` 导出 `QuayInFlightTask`（带消费方
   注释：MCP `quay_snapshot` 工具消费）。**不改** `driver`/`tests`/`fanIn` 任何既有字段的
   既有语义——这是纯增量字段。
2. **`quay_snapshot` 输出补字段（`server/modules/mcp-gateway/mcp-overview-tools.ts`）**：
   `McpQuaySnapshotReading`（约行 311-322）新增 `inFlight: QuaySnapshot['inFlight']`；
   `summarizeSnapshot`（约行 334-347）新增一行把 `snapshot.inFlight` 透传进去。**不改**
   `overview` 工具（`buildOverview`/`summarizeCachedQuay`，约行 200-300）——`overview` 的
   每项目摘要范围由已完成的 AC-247 定义，本任务不越界改它；CloudCLI 要看 in-flight 读数走
   `quay_snapshot`，不新增独立工具（范围判断：已有字段扩展足够满足"能通过 quay_snapshot
   查询当前正在执行的具体 task"，不需要新开一个 `quay_active_tasks` 工具去背负新增 MCP 工具
   的那一整套同步成本——`mcp-tool-annotations.ts`/`mcp-tool-error-codes.ts`/
   `mcp-read-tools.test.ts`/`mcp-english-only.test.ts`/`mcp-error-envelope.test.ts` 五处
   "registry 驱动覆盖表"同步——除非执行时发现字段扩展方案在某个具体约束下走不通，才退回去开
   新工具，并相应把这五个文件补进 `## Touches`）。
3. **`sessions_list`/`chatRunRegistry` 零改动**：本任务不得修改
   `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 里 `sessions_list` 的 handler、
   不得修改 `chatRunRegistry`/`listRunningRuns` 的既有实现或语义。用既有判据
   `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 不改一字仍逐字通过来证明未
   越界（见 AC）。

<!-- dedup-ref -->
边界（dedup，机制上去重已核对）：`grep -rli "inflight\|worker-round" tasks/*.md` 命中的都是
无关任务（resident/activity/badge/冷快照延迟等不同机制的"running"/"inflight"问题，命中纯属
字面重合，逐一核对过标题与现状段，没有一个认领"CloudCLI 看不到 Quay 正在执行的 task"这个
具体机制）。已完成的 `gap-ac247-overview-quay-cache-readonly`（`goal_ac: AC-247`）只定义了
`overview`/`quay_snapshot` 的缓存读/刷新语义（零 CLI 扇出、单项目刷新），不碰"driver 当前
在处理哪个 task"这个维度，本任务是在它之上的纯增量字段，不重复、不回退它已锁定的行为
（其 AC9/AC10 的既有回归判据原样保留）。

<!-- dedup-ref -->
粒度（merge-candidate 核对，`task-granularity-advice.js --touches ...` 实测）：唯一共享文件的
开放任务是 `gap-mcp-resolve-deps-production-wiring`（status: ready），共享
`server/modules/mcp-gateway/mcp-overview-tools.ts`。两者机制不同且改动点不重叠——那个任务改
`registerMcpOverviewTools` 注册 `overview`/`quay_snapshot` 的 handler 以接通生产环境的
project/session 名称模糊解析（`resolveDeps`）、并裁定 `overview` 的 `project` 参数是否生效；
本任务只在 `McpQuaySnapshotReading`/`summarizeSnapshot` 里新增/透传 `inFlight` 字段，不碰
名称解析、不碰 `overview` 的 handler 绑定。决定：**separate**——保持分案，理由是那个任务已是
`ready`（随时可能被派发执行），把本任务的内容并进去会打断一个已核准、即将执行的任务；两边
对同一文件的编辑点不重叠，调度器按 Touches 串行化即可，不需要合并来省这一次任务固定成本。

## AC

- [x] AC1 红态基线（先用真实的 fixture 固定住"现在看不到"这个事实，再修复）：构造一个最小
  fixture——注入的 `QuayFileReader` 假体里 `.quay/worker-round.jsonl` 内容为一条 JSONL 记录
  `{"at":"2026-10-07T00:00:00.000Z","pid":4242,"inFlightTasks":["gap-example-task"],
  "inFlightTaskStarts":{"gap-example-task":"2026-10-06T23:50:00.000Z"}}`，`driver status
  --kind worker --json` 假体返回 `{alive:1, running:1, last_record_ts:"..."}`（对应"Quay Web
  显示 driver=running"），`full-suite-state.json` 不存在（对应"当前不在 fan-in 验证阶段"，
  `suite.current` 为 `null`）。在改动前的代码上跑 `getQuaySnapshot`/现有
  `quay.service.test.ts` 同形夹具，逐字记录：返回的 `QuaySnapshot` 里没有任何字段的值等于
  `"gap-example-task"`（`JSON.stringify` 全量搜索该字符串，命中数为 0）——这就是"Quay Web
  能看到 running task，但 CloudCLI 看不到"的最小复现，写下完整命令与完整输出。
- [x] AC2 判据绿：`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test
  server/modules/quay/tests/quay.service.test.ts` 新增覆盖：同 AC1 的夹具，断言
  `snapshot.inFlight` 等于
  `[{"taskId":"gap-example-task","phase":"implementing","startedAt":"2026-10-06T23:50:00.000Z",
  "lastHeartbeat":"2026-10-07T00:00:00.000Z","workerPid":4242}]`（逐字比对，不是存在性检查）。
- [x] AC3 `phase` 两态都要覆盖：追加一个该 task 在 `worker-outcome.jsonl`（`fanIn` 读数来源）
  里有一条 `lockAcquireEpoch` 非 null 且 `lockReleaseEpoch` 为 null 的尝试的夹具，断言该 task
  的 `phase === 'fan-in'`；另一个在飞 task 没有未释放的 fan-in 锁尝试，断言其 `phase ===
  'implementing'`（正例对照：两种 phase 都真实出现，防止"一律某一态"也能通过）。
- [x] AC4 `inFlight` 的 null-vs-空区分：`worker-round.jsonl` 不存在时 `snapshot.inFlight ===
  null`；存在但其最新记录 `inFlightTasks` 为 `[]` 时 `snapshot.inFlight` 深等于 `[]`（两者
  不得混淆，逐字写两个读数）。
- [x] AC5 `quay_snapshot` 端到端：在 `server/modules/mcp-gateway/tests/mcp-overview.test.ts`
  里追加同形夹具，经真实 HTTP + MCP SDK 客户端调用 `quay_snapshot({project, refresh:true})`，
  断言返回体的 `snapshot.inFlight` 与 AC2 同形逐字一致；并断言 `overview` 的输出里该项目的
  quay 条目**没有** `inFlight` 这个 key（证明本任务刻意不扩 `overview`，范围没有越界）。
- [x] AC6 不越界/不回归：`grep -n "inFlight" server/modules/mcp-gateway/mcp-gateway.read-tools.ts`
  为空（没有新增/改动 `sessions_list` 或其他工具的注册）；
  `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 不改一字仍逐字通过（写 tests/pass/
  fail 计数）；`npm run typecheck` 退出 0；`npm run lint` 的 `: error ` 计数为 0。
- [x] AC7 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单
  （新增文件用 ` (new)` 标注）。

## DoD

- `inFlight` 读数来自与 Quay 自己 `quay serve` Web 仪表盘 Live 卡片**同一份** `.quay/
  worker-round.jsonl` 载体（同文件、同字段语义），不是重新发明的另一套"任务在跑"判断逻辑；
  `phase` 复用已收集的 `fanIn`（`worker-outcome.jsonl`）读数判定，不新开状态机。
- `sessions_list`/`chatRunRegistry` 的既有实现与语义逐字未改一行（AC6 的 grep + 既有判据
  不改一字仍绿即为证明）；`overview` 工具的既有输出形状未改（AC5 的"没有 `inFlight` key"
  即为证明）。
- CloudCLI 经 `quay_snapshot` 真的能看到当前在飞的具体 task id、phase、起点、最近心跳，以及
  （能从 worker-round 记录里读到时）worker 自身 pid——AC1 记录的"改动前看不到"与 AC2/AC5
  记录的"改动后看到"两个真实读数对照，证明这条 CloudCLI/ClaudeCodeUI 集成缺口被补上，不是
  "判据文件存在就算数"。
- 遵守 `$backend-module-standards`（跨模块只经 barrel、导出带消费方注释、新字段注释说明
  null/[]/单字段语义边界）与 AGENTS.md；不引入新依赖；不 import quay 包的 TS 源码；不新增
  `/proc` 扫描或 `.workflow-events/` 读取（那是 quay 自己 Live 页更重的实现，明确排除在本
  任务范围外，见 Notes）。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/index.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/quay/tests/quay.service.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts
- tasks/gap-cloudcli-quay-snapshot-inflight-tasks.md

## Notes

- 本任务明确排除：(a) 修改 `sessions_list`/`chatRunRegistry` 的 running 判定范围（是否该把
  Quay worker 自己 spawn 的 Claude 会话也算"running"，是一个更大的、涉及 ClaudeCodeUI 会话
  生命周期语义边界的决策——若要做，应该是另一个独立任务，参考方向是让判定逻辑额外核对
  `~/.claude/sessions/<pid>.json`（Claude Code 自己维护的、进程存活期间写入/退出即删的
  pid→sessionId 全局登记表，quay 自己的 `packages/quay/src/observation.ts` 的
  `liveSessionIdForPid` 已经在用这张表），而不是只看 `chatRunRegistry` 自己登记过的 run）；
  (b) 新增独立的 `quay_active_tasks` MCP 工具（除非字段扩展方案执行中证明走不通）；
  (c) 复刻 quay 自己 `observation.ts` 的 `pairInFlight`/`InFlightPhase`
  （implementing/fan-in/awaiting-land/landed 四态，依赖 `.workflow-events/`）或
  `readLiveWorkerProcesses`/`liveSessionIdForPid`（`/proc` 扫描 + session registry 解析）——
  这些是 quay 自己 Web 仪表盘 "Live" 卡片更重的实现，本任务只做"任务 id + 粗粒度两态 phase +
  起点 + 最近心跳 + 可用时的 worker pid"这一层最小可用读数。
- `worker-round.jsonl` 的 `pid` 字段是 worker driver 循环自身的进程号（一个 `--kind worker`
  实例一个 pid），不是逐任务的子进程/会话 pid——这是本任务能从现有载体里诚实拿到的粒度，
  字段注释与本文档都已明确这个边界，不得在实现时悄悄冒充成逐任务 pid。
- 若 quay 仓库在本任务执行期间已经新增了一个带 `--json` 的、直接输出 in-flight task 读数
  的 CLI 子命令（比如把 `readLive()` 的部分结果通过 CLI 暴露出来），执行者应该优先改用那个
  命令（经 `QUAY_READ_ONLY_COMMANDS` 白名单新增一条只读命令），而不是继续手剖
  `worker-round.jsonl` 的 JSONL——现读现核实，不要凭本任务写作时的调查结论断言 quay 没有
  这样的命令。
