---
id: gap-activity-task-reducer
title: AC-191 Task 归约器：由 2026-10-01 真实帧序得到任务表（嵌套 / Workflow / Monitor 超时 / 前台转后台
  / Stop hook 校准），重放幂等
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-191
---
## Proposal

**这条是什么。** AC-191 的判据逐字：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-task-reducer.test.ts`（该文件当前 **ABSENT**，判据红）。它要一个**服务端 Task 归约器**：吃 SDK 的原始帧（`assistant`/`system` 的 `task_started`、`task_updated`、`task_progress`、`task_notification`），以及 Stop hook 的 `background_tasks` 快照，产出一张**每会话的任务表**。夹具是 2026-10-01 真实捕获的帧序（后台子代理 + 其内部 Bash、后台 Bash、Monitor、Workflow、前台 Bash 被转后台），来源逐条记在 `docs/proposals/claude-session-activity-dock.md` §1 与 §9、以及 `docs/proposals/claude-background-work-observability.md` §1/§9。

**今天的缺口。** 宿主驱动 `server/modules/providers/list/claude/claude-host-driver.provider.ts` 只从 `task_*` 帧里读 `task_id` 去增删租约（`taskIdOf`、`heldBackgroundTasks`），其余字段（`task_type`/`workflow_name`/`description`/`parent_tool_use_id`/`is_backgrounded`/status/`summary`）全部丢弃。仓库里既没有任务表，也没有归约器；AC-186 已经把同形的 Turn Tracker 立了起来（`server/modules/providers/services/claude-turn-phase.service.ts` + `.../tests/claude-turn-phase.test.ts`），本条是它在 Task 维度的姊妹：同样的「一实体一稳定 key、事件溯源、无本地时钟」纪律。

**接口（本条钉死，供判据断言）。** 新服务导出 `createClaudeTaskReducer(): ClaudeTaskReducer`，与 `createClaudeTurnTracker()` 同形：

- 状态**按实例持有、按会话 id 分桶** —— 这从结构上让 (h) 跨会话不串扰成立（模块级单例会通过单会话用例、恰好红掉串扰用例）。
- `observe(sessionId: string, frame: unknown): void` —— 喂一帧原始 SDK 帧（就是 Turn Tracker 消费的那个 `transformedMessage` 缝）。
- `reconcileStopHook(sessionId: string, backgroundTasks: BackgroundTaskSummary[]): void` —— 用 Stop hook 快照校准。
- `getTasks(sessionId: string): ActivityTask[]` —— 读回该会话的任务表（返回拷贝，调用方拿不到可变内部记录）。

`ActivityTask` 字段（判据按名断言）：`taskId`、`kind: 'subagent'|'shell'|'monitor'|'workflow'|'other'`、`state: 'running'|'blocked'|'completed'|'failed'|'stopped'|'ended'`、`toolUseId?`、`parentTaskId?`、`isBackgrounded`、`workflowName?`、`stepLabel?`、`description`、`summary?`、`endReason?: 'unknown'`、`origin: 'sdk-event'|'stop-hook-snapshot'`，以及只在帧真带时间戳时才落的时间戳字段（**不得有本地时钟**——沿用 Turn Tracker 的纪律）。

其中 `state: 'ended'` 是「已结束（原因未知）」这一格：只由 Stop hook 校准产出，**不与 `stopped` 合并**（`stopped` 专指被 `stopTask`/Monitor 超时终结）。AC-191 (f) 要的正是这格。

**归约规则（判据 (a)–(f) 逐条对应）。**

- (a) `task_started{task_id, tool_use_id, parent_tool_use_id}`：维护 `tool_use_id → taskId` 映射；若 `parent_tool_use_id` 命中另一任务的 `toolUseId`，则本任务 `parentTaskId = 那个任务的 taskId`。
- (b) `task_updated{status:'killed'}` + `task_notification{status:'stopped'}` ⇒ `state='stopped'`，**不是 `failed`**。状态映射：`task_updated.status` 的 `killed → stopped`、`paused → blocked`、`running → running`、`completed/failed` 原样；`task_notification.status` 的 `completed/failed/stopped` 原样。
- (c) `task_started{task_type:'local_workflow', workflow_name}` ⇒ `kind='workflow'`、`workflowName=workflow_name`；`stepLabel` 取**最近一条** `task_progress` 的 `description`。`task_type` 映射：`local_agent → subagent`、`local_bash → shell`、`local_workflow → workflow`、monitor 类 → `monitor`、其余 → `other`（monitor 的 `task_type` 字符串未被实测，按推断处理并在测试注释里标注）。
- (d) **前台工具在被转后台之前不是任务**：归约器只在 `task_started` 上建任务，**绝不**在 `assistant` 的 `tool_use` 上建任务。前台 Bash 的 `tool_use` 到达时任务表里没有它；随后同刻到达 `task_started` 与 `task_updated{patch:{is_backgrounded:true}}` 之后才有，且 `isBackgrounded=true`。
- (e) **只有 `task_updated(completed)` 而没有 `task_notification`** 的后台 Bash 也能终结（实测后台 Bash 结束只有 `task_updated`）：`task_updated` 的终态即终态。
- (f) `reconcileStopHook(sessionId, backgroundTasks)`：① 表里未终结、而快照里**没有**的任务 ⇒ `state='ended'`、`endReason='unknown'`；② 快照里**有**、而事件里从没见过的任务 ⇒ 补建，`origin='stop-hook-snapshot'`，状态取快照 `status`（`running`/`completed`/…）。

**重放幂等 (g)。** 同一段帧序喂两遍（同一实例重放、或两个新实例各喂一遍），`getTasks` 结果逐字段不变 —— 归约是「整条快照覆盖 + 稳定 key」，不累加、不追加。

**假形态（写进判据，证明主断言有分辨力）。** 两条，复用主用例的读数函数（若假形态也绿，说明判据有洞，先补判据）：

- (b) 的假形态：一个把 `killed` 当作 `failed` 的变体归约器 ⇒ (b) 的读数必须红。
- (d) 的假形态：一个在 `tool_use` 时就建任务、不看 `is_backgrounded` 的变体 ⇒ (d) 的读数必须红。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-02，读任务库与代码）。** `grep -rn "goal_ac: *AC-191" tasks/ .quay/ goals/` → **0 命中**；在飞扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human：`gap-activity-dock-human-gate`、`gap-resident-turn-phase-keyed-by-provider-id`、`session-history-incremental-cache`、`session-turn-outline-endpoint`、`session-window-around-id-endpoint`、`transcript-long-session-e2e-seed`）**无一认领 AC-191**。机制词扫描 `grep -rln "task-reducer\|taskReducer\|Task Reducer\|任务归约\|Task 归约" tasks/` → **0 命中**；`test -f server/modules/providers/tests/claude-activity-task-reducer.test.ts` → **ABSENT**；`find server -name '*task-reduc*'` → **空**。AC-186 的 Turn Tracker（`gap-claude-turn-phase-real-signals`，已 done）是**不同机制**（回合阶段 vs 任务表）、不同判据文件，不构成本条的重复；本条的 `ActivityTask` 与它互不覆盖。⇒ 不是重复。

**非目标。** 不把归约器接进实时运行回路、不改现有租约路径、不加 REST 快照与 WS 增量（那是 AC-193/AC-195 的活）；不实现计划表（AC-192）；不实现控制面停止/转后台（AC-196/AC-197）；不碰前端坞（AC-194/AC-199）；不碰其它 provider。提案 §526 已裁定这一步是「只读、不影响现有租约」。

## Plan

1. 新增 `server/modules/providers/services/claude-activity-task-reducer.service.ts`：定义并导出 `TaskKind`/`TaskState`/`TaskOrigin`/`ActivityTask`/`BackgroundTaskSummary`/`ClaudeTaskReducer` 类型与 `createClaudeTaskReducer()` 工厂。按实例持有 `Map<sessionId, 内部任务记录>`；`getTasks` 返回深拷贝。注释沿用 Turn Tracker 的语气，点名「无本地时钟」「稳定 key 幂等归约」「前台工具不是任务」三条载重不变量，并注明消费方是判据文件。
2. 在服务文件里实现归约：`observe` 处理 `task_started`/`task_updated`/`task_progress`/`task_notification`（其余帧忽略）；`reconcileStopHook` 做 (f) 双向校准。状态映射表逐条写死，`killed → stopped`（**不得**写成 failed）。
3. 在 `server/modules/providers/index.ts` 桶里导出 `createClaudeTaskReducer` 与各类型，附注释点名消费方（判据 `claude-activity-task-reducer.test.ts`；后续活动聚合器读它）。
4. 新增 `server/modules/providers/tests/claude-activity-task-reducer.test.ts`（判据文件）：按 `claude-turn-phase.test.ts` 的写法，为 2026-10-01 帧序写带来源注释的 builder（后台子代理 + 其内部 Bash、后台 Bash、Monitor 超时、Workflow、前台 Bash 被转后台、Stop hook 快照），逐条断言 (a)–(h)，并加入两条假形态臂（各自复用主用例读数函数、断言红）。
5. 本地直跑：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-task-reducer.test.ts` 退出 0（判据绿）；`npm run typecheck`、`npm run lint` 绿。
6. 写完成记录，置终态 done（AC-191 是纯机械判据，无人工关卡）。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-task-reducer.test.ts` 退出 **0**，stdout `fail 0`。
- [x] AC2 (a) 嵌套：后台子代理的内部 Bash 任务的 `parentTaskId` 由其 `parent_tool_use_id` 命中父任务的 `toolUseId` 还原；断言子任务 `parentTaskId === 父任务 taskId`。
- [x] AC3 (b) Monitor 超时：`task_updated{killed}` + `task_notification{stopped}` ⇒ Monitor 任务 `state === 'stopped'`（断言不等于 `'failed'`）。
- [x] AC4 (c) Workflow：`kind === 'workflow'`、`workflowName === 'simple-workflow-ok'`、`stepLabel` 等于最近一条 `task_progress.description`（给出两条 progress，断言取后一条）。
- [x] AC5 (d) 前台 Bash 在转后台前不是任务：喂入前台 Bash 的 `assistant.tool_use` 后 `getTasks` 里**没有**该任务；喂入同刻的 `task_started` + `task_updated{patch:{is_backgrounded:true}}` 后才有，且 `isBackgrounded === true`。
- [x] AC6 (e) 只有 `task_updated{completed}`（无 `task_notification`）的后台 Bash ⇒ `state === 'completed'`。
- [x] AC7 (f) Stop hook 校准：表里未终结但快照缺失的任务 ⇒ `state === 'ended'` 且 `endReason === 'unknown'`；快照里有而事件没见过的任务 ⇒ 被补建且 `origin === 'stop-hook-snapshot'`。
- [x] AC8 (g) 重放幂等：同一帧序喂两遍（同一实例重放 + 两个新实例各一遍），`getTasks` 结果 `assert.deepEqual` 相等。
- [x] AC9 (h) 跨会话隔离：两个会话的帧交错喂入，`getTasks(A)` 不含 B 的任务、`getTasks(B)` 不含 A 的任务。
- [x] AC10 假形态有分辨力：(b) 的变体（`killed → failed`）与 (d) 的变体（`tool_use` 即建任务）各复用主用例的读数函数直跑，读数必须红；测试打印两臂的绿/红读数，证明主断言不是恒真。
- [x] AC11 契约面：`npm run typecheck` 退出 0、`npm run lint` 退出 0、`npm run build` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat develop...HEAD` 逐条对齐）。

## DoD

- 归约器是真的（`createClaudeTaskReducer()` 被测试以真实帧序驱动、产出任务表），不是测试里内联的一段伪代码；判据文件是**测试条目的本体**，AC1 的红→绿是被归约器实现换来的。
- (b)「stopped 不是 failed」与 (d)「前台工具不是任务」两条纪律真的被代码兑现：对应的假形态臂必须红 —— 若假形态也绿，说明主线断言没有分辨力，先补判据。
- (g) 重放幂等与 (h) 跨会话隔离是结构性的（稳定 key、按会话分桶），不是用例特判。
- 夹具的每条 builder 都注明其形态来源（§1/§9 或某个既有测试），可被重新推导，不是凭空捏造。
- 非目标外的文件一行未动：不接运行回路、不改租约、不加 REST/WS、不碰前端与其它 provider。

## Touches

- `server/modules/providers/services/claude-activity-task-reducer.service.ts` (new)
- `server/modules/providers/tests/claude-activity-task-reducer.test.ts` (new)
- `server/modules/providers/index.ts`
- `tasks/gap-activity-task-reducer.md`