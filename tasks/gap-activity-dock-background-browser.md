---
id: gap-activity-dock-background-browser
title: AC-194 真实浏览器：活动坞按 Task/Schedule 实体列出任务与计划（服务端接线 + 调试 agent 场景 + 客户端面板 +
  卡片读 Task），状态不刷新即变化，重载由快照恢复，计划只读
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-task-reducer
  - gap-activity-schedule-tracker
  - gap-activity-protocol-snapshot-rev
goal_ac: AC-194
---
## Proposal

**这条是什么。** AC-194 的判据逐字：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"`（该文件当前 **ABSENT**，判据红）。它要在**真实浏览器 + 真实应用**上证明：调试 agent 场景发出的 task_started / task_progress / task_updated / task_notification 与一个 cron 计划，经服务端归约与活动协议，真的走到坞上——坞摘要显示后台任务数与计划数；展开面板按类型列出任务（描述、状态、已运行时间、最近动作）与计划（表达式、下次触发倒计时、提示词）；任务完成时坞内状态**不刷新页面**即变化；整页重载后面板**由快照恢复**；转写里 Agent 与 Bash 卡片的头部读 Task、显示实时状态而不是只写 running；计划行**没有任何取消控件**（选择器计数 = 0）。墙钟须实测 ≤ 40s。

**今天的缺口（读代码，逐一实测）。** 三张服务端实体表（Task 归约器 / Schedule 计划表 / 活动快照协议）由 AC-191/192/193 交付，但三条**各自明写不接进运行回路、不碰前端坞**：AC-191 非目标逐字「不把归约器接进实时运行回路…不碰前端坞（AC-194/AC-199）」；AC-192 非目标逐字「不接进实时运行回路、不加 REST/WS 快照（那是 AC-193/AC-195 的活）…不碰前端坞」；AC-193 非目标逐字「不接进 run loop 把真实帧喂进存储（那是接线任务）」并让 `readTasks`/`readSchedules` 默认返回空数组、「它们的真实生产者在 AC-191/192，接线任务再换进来」。⇒ 即便三条落地，坞上仍是空的：**没有任何任务把三张实体表接进 run loop、换成活动存储的读取器、接上客户端 store 与坞面板 / 卡片**。

客户端今天也**没有** Task 实体：`grep -rn "task_started\|task_updated" src/` → 0 命中；只有 `SessionHostLease`（`src/shared/types.ts` 的联合，只带 `{kind, id}` 等）。**没有** cron 实体：`MessageKind` 里没有 task_*，客户端唯一的 schedule 是 `ScheduledMessage`（排队消息，不是 cron 计划）。坞（`ActivityIndicator`）是单行只读回合状态：`src/modules/chat/utils/activityDockView.ts` 的状态机只有 `hidden | in-turn | unreachable | send-failed`，不含计数、不可展开（租约计数面板在坞合并时被拆掉，`residentStatusBarLeaseSummary.test.tsx` 断言旧标记缺席）。

调试 agent 场景也**发不出** task_* 帧：`DEBUG_AGENT_OPS`（`server/modules/debug-agent/debug-agent.scenario.ts:89-113`）是转写行操作闭集，宿主驱动只从原始流里读 `task_id` 做租约增删（`claude-host-driver.provider.ts` 的 `HELD_WORK_SYSTEM_SUBTYPES`/`observeHeldWorkEvent`），`task_progress`/`task_updated` 全仓库从不被读；调试 agent 里**没有** Stop hook、**没有** session_crons。

**实现面（本条认领）。** 本条是 AC-191/192/193 都让出的那条「接线 + 真实浏览器」的腿，交付四件事：

1. **服务端接线**：在真实 run loop 里把 claude 的原始帧喂进 `createClaudeTaskReducer()` 与 `createClaudeScheduleTracker()`，把 Stop hook 的 `background_tasks`/`session_crons` 接到两条 `reconcileStopHook`（`claude-host-driver.provider.ts` 的 `onStop`/`reconcileHeldWork` 缝），并让任务 / 计划的变化经 AC-193 的 `recordChange(sessionId)` 推 `activity.upsert`；把 AC-193 的 `readTasks`/`readSchedules` 从默认空数组换成这两张真表。
2. **调试 agent 场景扩展**：在 `DEBUG_AGENT_OPS` 加按**信号**命名的步骤，写出 claude 方言里承载 task 生命周期与 cron 计划的行，使真实归约链路收到 task_started / task_progress / task_updated / task_notification 与一个计划（§9.1 的 `session_crons` 或 `CronCreate` 的 `tool_result`，取判据能稳定读到的那条）。**不得改变其它场景的行为**；新步骤名不得在 `server/modules/debug-agent/` 里拼出帧 / 事件字面量（`debug-agent-vocabulary-guard.test.ts` 的 `FRAME_AND_EVENT_LITERALS` 含 `task_notification`；照 `COMMAND_LIFECYCLE_ROW_TYPE` 先例 import 共享常量）。
3. **客户端**：新建按会话的 Task/Schedule 视图（数据来自 AC-193 的快照 + `activity.snapshot`/`activity.upsert` 帧），坞摘要显示任务数与计划数，展开面板按类型列出任务与计划，Agent/Bash 卡片按 `toolUseId` 读 Task 显示实时状态，计划行只读（结构上不渲染取消控件）。
4. **e2e 判据** `e2e/activity-dock-background.spec.ts`（新）+ 登记进 `playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES`。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-04，读任务库与代码）。** `grep -rn "goal_ac: *AC-194" tasks/ goals/` → **0 命中**，无在飞认领者（AC-191/192/193 三条 ready 各带自己的 goal_ac，无一认领 AC-194）。机制词扫描：三条姊妹（`gap-activity-task-reducer` / `gap-activity-schedule-tracker` / `gap-activity-protocol-snapshot-rev`）的非目标**逐字**把「接进运行回路 / 前端坞 / e2e」让了出来（引文见上），三条互不同机制且都不认领 AC-194；`grep -rln "activity-dock-background" tasks/` 只命中这三条正文里「不碰 AC-194」的旁述，无一认领。`test -f e2e/activity-dock-background.spec.ts` → **ABSENT**。**同判据文件的姊妹** AC-199（`goals/AC-199-…md:7` 指向同一 spec 的 `-g "AC-199"`）是**不同 AC、不同用例**（停止 / 转后台控制，其控制面是 AC-196/197/198），目前**也无在飞认领者**——本条只建文件与 AC-194 用例，AC-199 用例由它自己的任务追加（共享 spec 的 add/add 由后到的任务按 `shared-e2e-spec-add-add-merge-take-develop-then-append-renamed` 处理），本条不替它申领。⇒ 不是重复。

**假形态（写进判据，证明主断言有分辨力）。** 两条，复用主用例的读数函数（若假形态也绿，说明判据有洞，先补判据）：

- (1) 卡片继续只从折叠行推断状态（不读 Task 实体）⇒ **卡片读数必须红**。
- (2) 面板数据改为轮询 `/api/session-hosts`（而不是活动快照 / 帧）⇒ **重载恢复**与**不刷新变化**两条读数**至少一条必须红**。轮询没有快照语义，天然红在「重载恢复」那条臂上；实现时按判据能稳定复现的那条臂断言。

**非目标。** 不实现 Task/Schedule 归约与活动存储（那是三条姊妹的活）；不做租约由任务推出、不做停止 / 转后台控制、不做 Monitor 折叠、不碰人工关卡；不改其它调试 agent 场景的行为；不碰其它 provider。

## Plan

1. **服务端接线**：在 claude run loop（`claude-runtime.provider.ts` 的帧转发缝）里实例化 `createClaudeTaskReducer()` 与 `createClaudeScheduleTracker()`，把每一帧喂进 `observe`；把 `claude-host-driver.provider.ts` 的 Stop hook `background_tasks`/`session_crons` 接到两条 `reconcileStopHook`；在任务 / 计划变化处调 AC-193 的 `recordChange`；把活动存储的 `readTasks`/`readSchedules` 从默认空数组换成这两张真表（AC-193 的注入点，构造点在 `server/index.ts` / `providers/index.ts`）。
2. **调试 agent 扩展**：在 `debug-agent.scenario.ts` 的 `DEBUG_AGENT_OPS` 加按信号命名的步骤（task 生命周期 + 一个计划）与其 step 类型，在 `debug-agent.runtime.ts` 加对应的方言行 builder（本模块是唯一知道方言字段的地方），在 `debug-agent.engine.ts` 加 `switch (step.op)` 的 dispatch case，复用 `appendDialectRow` 的「写一行即转发」路径；`task_*` 等字面量经共享常量 import（词汇守卫测试保持绿）。计划走 Stop hook（在 `debug-agent.host-driver.ts` 加 `clock` 步可达的 Stop hook 快照）或走既有 `tool-call`/`tool-result` 的 `CronCreate` 文本（AC-192 的 `source:'tool-call'` 路径），取判据能稳定读到的那条。
3. **客户端**：在 `src/shared/types.ts` 加 Task/Schedule 视图类型与 `activity.snapshot`/`activity.upsert` 帧类型（`server/shared/types.ts` 同步）；在 `useChatRealtimeHandlers.ts` 落这两个帧；新建按会话的 store 与选择器（`useSessionActivity.ts`）；坞摘要加计数、展开面板（`ActivityDockPanel.tsx`）按类型列任务与计划；`SubagentPanel.tsx` 与 Bash 卡片（`MessageComponent.tsx`）按 `toolUseId` 读 Task 显示实时状态；计划行不渲染任何取消控件。
4. **判据文件**：新增 `e2e/activity-dock-background.spec.ts`，按 `e2e/activity-dock-truthful.spec.ts` / `background-task-strip.spec.ts` 的写法（注册账号、`POST /api/debug-agent/scenarios` 布场景、`POST /api/debug-agent/clock` 走时钟、`GET /api/session-hosts` 与快照交叉核对、`navigateBounded`），逐条断言 AC2–AC10；加两条假形态臂（各自复用主用例读数函数、断言红）。
5. 把 `'activity-dock-background.spec.ts'` 登记进 `playwright.config.ts:1498` 的 `DEBUG_AGENT_SPEC_FILES`。
6. 本地直跑：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` 退出 0、墙钟 ≤ 40s；`npm run typecheck`、`npm run lint`、`npm run build` 绿；既有 `activity-dock-truthful.spec.ts` 与 `background-task-strip.spec.ts` 保持绿；`debug-agent-vocabulary-guard.test.ts` 与既有调试 agent 测试保持绿。
7. 写完成记录，置终态 done（AC-194 是机械判据，无人工关卡）。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` 退出 **0**，stdout 中 AC-194 用例 `passed`；墙钟（`process.env.QUAY_E2E_RUN_STARTED_AT` 读数）**≤ 40_000ms**。── 实测三次：15369ms / 16980ms / 15227ms。
- [x] AC2 场景发出四类事件与一个计划：调试 agent 场景经真实归约链路产出至少一个 running 的后台任务（其 `toolUseId` 与转写里 Agent/Bash 卡片对应）、一次 `task_progress`/`task_updated` 的状态推进、一次终态 `task_notification`，以及一个计划（快照里 `kind==='cron'` 或 `'wakeup'`）。断言在页面读数与 `GET` 快照两侧一致。── 场景新增 `task-started`/`task-progress`/`task-updated`/`task-notification`/`schedule-plan` 步骤；快照 tasks=2（running→completed）schedules=1（kind=cron）。
- [x] AC3 坞摘要计数：坞摘要渲染后台任务数与计划数两个读数，与快照里 tasks/schedules 的长度一致（真实浏览器 DOM 读数）。── `dock.counts=2/1 snapshot.tasks=2 snapshot.plans=1`。
- [x] AC4 展开面板列任务：展开后按类型列出任务行，每行含描述、状态、已运行时间、最近动作四项读数；行数等于快照 tasks 数。── `running.tasks` 两行，四项非空；行数 = 快照 2。
- [x] AC5 展开面板列计划：每个计划行含表达式、下次触发倒计时、提示词三项读数；行数等于快照 schedules 数。── `running.plans=[{expression:"Every 2 minutes",countdown:"1m 42s",prompt:"check the queue"}]`。
- [x] AC6 不刷新即变化：场景推进到任务终态后，**不重新导航**（`page.goto`/`reload` 次数不增），面板里该任务的状态读数由运行中变为终态（auto-retry 断言）。── `settled.tasks=["completed","completed"]`，`navigations=0`。
- [x] AC7 重载由快照恢复：`page.reload()`（或 `navigateBounded(..., 'first-load')`）后，面板由快照恢复出同样的任务 / 计划行；先以快照 GET 返回 200 证明快照存在，且恢复不经过 `/api/session-hosts` 轮询。── reload 后 `restored.tasks=["task-agent","task-shell"] restored.plans=["cron-…"]`，快照 GET 200。
- [x] AC8 卡片读 Task：转写里 Agent 与 Bash 卡片的头部读 Task 实体、显示**实时状态**（随 AC6 的终态变化而变），而不是恒定 `running`；断言卡片头的状态读数在 AC6 前后不同。── `running.cardTaskStates=["running","running"]` → `settled.cardTaskStates=["completed","completed"]`。
- [x] AC9 计划只读：计划行的取消控件选择器计数 **= 0**（例如 `page.locator('[data-schedule-cancel]')` 的 `count()` 为 0）。── `plan.cancelControls=0`（面板结构上不渲染任何按钮）。
- [x] AC10 既有不受影响：`activity-dock-truthful.spec.ts`、`background-task-strip.spec.ts` 仍绿；`debug-agent-vocabulary-guard.test.ts` 与既有调试 agent 测试仍绿（其它场景行为不变）。── background-task-strip 25.2s passed；activity-dock-truthful 的 AC-184/185/186 整文件跑过，AC-187/AC-188 单独 `-g` 各 passed（整文件一次跑会撞单用户 auth 的用户名，是既有 harness 特性）；debug-agent 35 tests passed；chat 客户端 516 tests passed。
- [x] AC11 假形态有分辨力：(1) 卡片只从折叠行推断状态的变体 ⇒ AC8 红；(2) 面板数据改轮询 `/api/session-hosts` 的变体 ⇒ AC6 或 AC7 至少一红。两臂各复用主用例读数函数，打印绿 / 红读数证明主断言不是恒真。── (1) `settled.cardFoldedStates=["running","running"]`（折叠行读数）对 `settled.cardTaskStates=["completed","completed"]`（Task 读数）；折叠行推断会读 running、在主断言上红。(2) `falseForm2.sessionHostsLeases=0 falseForm2.panelRows=3`：轮询源不含任务 / 计划，轮询驱动的面板在 AC7 恢复臂上红。
- [x] AC12 契约面：`npm run typecheck`、`npm run lint`、`npm run build` 各退出 0；改动只落在 Touches 列出的文件上（`git diff --stat develop...HEAD` 逐条对齐）。── 三者均退出 0；diff 24 个文件，与 Touches 逐条一致。

## DoD

- 坞上真的看得到任务与计划（由 `GET` 快照 + `activity.snapshot`/`activity.upsert` 帧驱动的真实浏览器读数），不是轮询 session-hosts 的伪造；AC7 的重载恢复必须由快照路径兑现。
- 卡片真的按 `toolUseId` 读 Task 实体显示实时状态，不是从折叠行 / 本地推断；假形态 (1) 必须红。
- 调试 agent 的 task / 计划信号是真的经完整脊（scenario op → 方言行 builder → engine → `appendDialectRow`/`forwardFrames` → 真实归约器 → 活动存储 → 坞）到达坞，不是测试内联的假值；`debug-agent-vocabulary-guard.test.ts` 保持绿，其它场景行为不变。
- 计划行**结构上**没有取消控件（不是靠隐藏 / 禁用），AC9 的选择器计数为 0 由真实 DOM 读数证明。
- 墙钟实测 ≤ 40s 是**真实读数**，且失败时判据自己输出原因。
- 非目标外文件一行未动：不碰租约推导、控制面、Monitor 折叠、人工关卡与其它 provider。

## Touches

- `server/modules/providers/list/claude/claude-runtime.provider.ts`
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`
- `server/modules/providers/index.ts`
- `server/index.ts`
- `server/shared/types.ts`
- `server/modules/websocket/services/activity-protocol.service.ts`
- `server/modules/websocket/services/chat-websocket.service.ts`
- `server/modules/debug-agent/debug-agent.scenario.ts`
- `server/modules/debug-agent/debug-agent.runtime.ts`
- `server/modules/debug-agent/debug-agent.engine.ts`
- `src/shared/types.ts`
- `src/shared/api.ts`
- `src/modules/chat/hooks/useChatRealtimeHandlers.ts`
- `src/modules/chat/hooks/useSessionActivity.ts` (new)
- `src/modules/chat/utils/activityDockView.ts`
- `src/modules/chat/composer/ActivityIndicator.tsx`
- `src/modules/chat/transcript/ActivityDockPanel.tsx` (new)
- `src/modules/chat/tools/SubagentPanel.tsx`
- `src/modules/chat/tools/BashCommandDisplay.tsx`
- `src/modules/chat/tools/ToolRenderer.tsx`
- `src/modules/chat/transcript/MessageComponent.tsx`
- `src/modules/chat/tests/activityDockTaskSchedule.test.tsx` (new)
- `e2e/activity-dock-background.spec.ts` (new)
- `playwright.config.ts`
- `tasks/gap-activity-dock-background-browser.md`

## Completion

**Verification readings（本机，2026-10-04）。**

- 判据：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` → `1 passed`，墙钟 15227ms / 16980ms / 15369ms（都 ≤ 40s）。stdout 关键读数：`running.cardTaskStates=["running","running"]`、`settled.cardTaskStates=["completed","completed"]`、`settled.cardFoldedStates=["running","running"]`、`dock.counts=2/1`、`plan.cancelControls=0`、`restored.tasks=["task-agent","task-shell"]`、`falseForm2.sessionHostsLeases=0 panelRows=3`。
- 回归：`background-task-strip.spec.ts` passed（25.2s）；`activity-dock-truthful.spec.ts` AC-187 / AC-188 单独 `-g` passed，AC-184/185/186 在整文件跑中 passed；`debug-agent/tests/*.test.ts` 35 passed；`vitest run src/modules/chat/tests` 516 passed。
- 契约：`npm run typecheck` / `npm run lint` / `npm run build` 均退出 0。

**实现摘要。**

- 服务端：`forwardNormalizedFrames` 在同一个缝里喂 `createClaudeTaskReducer()` 与 `createClaudeScheduleTracker()`（模块级单例，keyed by app session id），变化时经注入的 `setActivityChangeNotifier`（`server/index.ts` 装成 `activityStore.recordChange`）推整快照 upsert；`claude-host-driver.provider.ts` 的 `reconcileHeldWork` 把 Stop hook 的两张表接到 `reconcileSessionHeldWork`；活动存储的 `readTasks`/`readSchedules` 默认改读这两张真表；`chat-websocket.service.ts` 在 `chat.subscribe` 上 `activityStore.subscribe`，把 `activity.snapshot`/`activity.upsert` 送给订阅者。
- 调试 agent：`DEBUG_AGENT_OPS` 加 `task-started`/`task-progress`/`task-updated`/`task-notification`/`schedule-plan`，`tool-call` 加可选 `input`；方言行 builder 经共享常量（`CLAUDE_TASK_*_SUBTYPE`）写 `system` 行，`schedule-plan` 走 AC-192 的 `CronCreate` tool-call/result 路径。词汇守卫保持绿。
- 客户端：`src/shared/types.ts` 加 Task/Schedule 视图与帧类型，`activityDockView.ts` 加计数与 `background` 状态，`ActivityIndicator` 加计数与展开面板，新 `ActivityDockPanel` 列任务 / 计划（计划只读），新 `useSessionActivity` store（帧 + 一次性快照 REST join），`SubagentPanel`/`BashCommandDisplay` 经 `ToolRenderer` 按 `toolUseId` 读 Task 显示实时状态（并发布折叠行读数作对照）。
