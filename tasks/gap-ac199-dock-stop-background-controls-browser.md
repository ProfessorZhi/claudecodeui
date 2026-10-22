---
id: gap-ac199-dock-stop-background-controls-browser
title: AC-199 真实浏览器：坞里停止任务与把前台工具转后台，点击不乐观改状态、事件到达才变
  stopped；已结束任务无停止按钮；连接中断两按钮置灰（调试 agent 控制缝 + 坞控件 + e2e）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-199
depends_on:
  - gap-activity-dock-background-browser
  - gap-chat-stop-task-event-confirmed
  - gap-chat-background-task-foreground-tooluse
---
## Proposal

**这条是什么。** AC-199 的判据逐字：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`（该 spec 文件由 AC-194 新建；其中 AC-199 用例当前 ABSENT，判据红）。它要在**真实浏览器 + 真实应用**上证明活动坞的**控制面**端到端：对一个运行中的后台任务点「停止」——**点击瞬间任务行不乐观改状态**，随后由 `task_notification(stopped)` 经归约器与活动协议到达才变为 `stopped`；对一个运行中的前台工具点「转后台」——点击后任务面板**没有**该任务，随后由 `task_started` + `task_updated{is_backgrounded:true}` 驱动才出现；对已经结束的任务，停止按钮**结构上不再渲染**；经 `page.routeWebSocket` 在 app 自己的 socket 上分区（夹具机制同 AC-184，见 `e2e/activity-dock-truthful.spec.ts:308` 的 `installPartition`）后，坞内两个控制按钮都 `disabled` 并带说明文字。墙钟须实测 ≤ 40s。取假形态：点击后立即把任务置为 `stopped` ⇒「点击瞬间状态未变」读数必须红。

**今天的缺口（读代码，逐一实测）。**
- 坞（`src/modules/chat/composer/ActivityIndicator.tsx`）今天只渲染一条**只读**状态行：它自己的注释逐字写「The status line. The surface is a plain element, not a control」（`:208-212`）；`dockAttributes` 只有 `data-activity-dock`/`data-activity-state`/`data-activity-phase`（`:140-147`），**没有任何任务行或控制按钮**。客户端今天也**没有** Task 实体：`grep -rn "task_started\|task_updated" src/` → 0 命中；唯一后台任务展示面 `BackgroundTaskStrip.tsx` 读的是 `/api/session-hosts` 租约快照，**没有停止/转后台按钮**。⇒ 坞上没有任何控件可点。
- 服务端控制动词由 AC-196（`chat.stop-task`，`tasks/gap-chat-stop-task-event-confirmed.md`）与 AC-197（`chat.background-task`，`tasks/gap-chat-background-task-foreground-tooluse.md`）交付，两条**各自明写非目标**「不做前端坞控件与 e2e（AC-194/AC-199）」；坞面板与活动 store 由 AC-194（`tasks/gap-activity-dock-background-browser.md`）交付，其 AC/Plan **只列任务与计划行，不含停止/转后台控件**（其 AC9 只断言计划行无取消控件）。⇒ 控件这一层**无人认领**。
- 断连置灰今天只覆盖 composer 的停止入口（AC-184，`gap-activity-dock-unreachable-degradation.md` done，复用 key `claudeStatus.unreachable.stopReason`）；坞面板内的任务/前台工具按钮还不存在，自然也没有置灰。可复用的读缝已就绪：`useActivityFreshness(sessionId)`（`src/modules/chat/hooks/useActivityFreshness.ts:115`）给出 `liveness`（含 `'unreachable'`），`ActivityIndicator` 已据它把 `data-activity-state` 置为 `unreachable`（`:136,158`）——本条的新按钮读同一个读数，**不新造**连接判定。

**依赖与实现面（本条认领）。** 本条是 AC-196/197 都让出的「真实浏览器 + 坞控件」的腿，在 AC-194 的坞面板与活动 store 之上交付三件事：

1. **坞控件**（`src/modules/chat/`）：任务行加停止按钮，运行中的前台工具加转后台按钮；点击经既有 WS 通道发 `chat.stop-task` / `chat.background-task`（带 `requestId`），**客户端不发、也不写本地任务状态**——状态只来自 AC-193/194 的 `activity.snapshot` / `activity.upsert` 帧。按钮的启用/置灰读 `useActivityFreshness(sessionId).liveness`；`unreachable` 时 `disabled` 并渲染说明文字（复用 `claudeStatus.unreachable.stopReason`，按钮标题新增 i18n key）。
2. **调试 agent 控制缝与场景补足**（`server/modules/debug-agent/`）：让真实 WS 控制动词在调试 agent 场景里**可达且可被事件确认**——调试 agent 的宿主驱动要实现/转发 `stopTask(taskId)` 与 `backgroundTasks(toolUseId)`（AC-196/197 定义的驱动方法名），并在时钟上写出对应的 `task_notification(stopped)` / `task_started` + `task_updated{is_backgrounded:true}` 事件行；场景 `DEBUG_AGENT_OPS`（`debug-agent.scenario.ts:89`）需能表达本条读数所需的三种形态——一个**运行中**后台任务（有停止按钮）、一个**运行中**前台工具（`tool-call` 无配对 `tool-result`，有转后台按钮）、一个**已结束**任务（终态行、无停止按钮），且停止目标的终态事件落在**点击之后**的时钟偏移（这样才能取到「点击瞬间不改状态」）。AC-194 已为其 AC 加了按信号命名的 task 生命周期步；本条只在不足处追加（缺前台工具保持、缺终态步、或缺事件时序/控制缝）。**不得改变其它场景行为**；新步骤名不得在 `server/modules/debug-agent/` 里拼出帧/事件字面量（`debug-agent-vocabulary-guard.test.ts` 的 `FRAME_AND_EVENT_LITERALS`，照 `COMMAND_LIFECYCLE_ROW_TYPE` 先例 import 共享常量）。
3. **e2e 用例** AC-199：向共享 spec `e2e/activity-dock-background.spec.ts` **追加**一个 `-g "AC-199"` 用例（该文件与 AC-194 共享，add/add 冲突按 `shared-e2e-spec-add-add-merge-take-develop-then-append-renamed` 处理：从 develop 取文件、重命名追加，**不改 AC-194 用例**），含分区夹具（机制同 AC-184 的 `installPartition`，在本 spec 内就地实现或抽取共享助手，不改 `activity-dock-truthful.spec.ts`）与一条假形态臂。

**接口（本条钉死，供判据断言）。**
- 坞任务行：`[data-task-row]`（复用 AC-194 行；其上 `data-task-id`、`data-task-state`）。停止按钮 `[data-task-stop]`，**仅在该任务非终态时渲染**；终态行结构上不渲染该按钮（选择器计数 0）。
- 运行中的前台工具行：`[data-foreground-tool-row]`（带 `data-tool-use-id`）与转后台按钮 `[data-background-tool]`；无前台工具时该行不渲染。前台 `toolUseId` 由客户端从已加载转写里那条**未配对** `tool_use` 取得；服务端（AC-197 的 Turn Tracker）是权威，可回 `no-foreground-match`。
- 置灰与说明：分区（`unreachable`）时 `[data-task-stop]` 与 `[data-background-tool]` 均 `disabled`，且各自旁边渲染说明文字（`[data-control-disabled-reason]` 或等价选择器，计数 ≥ 1、文本非空）。
- 客户端发出的帧：`chat.stop-task` 入参 `{ sessionId, taskId, requestId }`；`chat.background-task` 入参 `{ sessionId, toolUseId, requestId }`（协议由 AC-196/197 钉死，本条只消费，不重定义）。
- 假形态钩子：点击后立即把任务行置 `stopped` 的变体 ⇒「点击瞬间 `data-task-state` 仍为原非终态」的读数必须红。

**假形态（写进判据，证明主断言有分辨力）。**
- 点击停止后**乐观**把任务行改成 `stopped`（不等 `task_notification(stopped)` 帧）⇒「点击瞬间任务行状态未变」读数必须红。
- 转后台按钮改读本地推断（点击后立即插入任务行，不等 `task_started`/`task_updated{is_backgrounded}`）⇒「点击后、事件前任务面板无该任务；事件后面板出现」读数红。
- 置灰只看本地 socket `isConnected` 而不看 `unreachable` 分区读数 ⇒ 分区后按钮仍可点，置灰读数红。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-04，读任务库与代码）。** `grep -rn "goal_ac: *AC-199" tasks/ goals/` → **0 命中**（AC-191/192/193/194/195/196/197/198 八条各带自己的 goal_ac，无一认领 AC-199）。机制词扫描：`grep -rln "chat.stop-task\|chat.background-task" tasks/` 只命中 AC-196/197/198 三条**服务端协议**任务，三条的非目标**逐字**把「前端坞控件与 e2e（AC-194/AC-199）」让了出来；`grep -rln "data-task-stop\|data-background-tool" tasks/` → 0 命中；`test -f e2e/activity-dock-background.spec.ts` → **ABSENT**。`gap-activity-dock-unreachable-degradation.md`（AC-184，done）只覆盖 composer 停止入口的置灰，不碰坞内任务/前台工具按钮；`gap-background-task-surface-absent-in-session-view.md`（done）是租约展示面，无控件。⇒ 不是重复。

**非目标。** 不实现 `chat.stop-task`（AC-196）与 `chat.background-task`（AC-197）的处理函数与归属校验；不实现 Task/Schedule 归约、活动协议、坞面板本体（AC-191/192/193/194）；不改租约路径（AC-195）；不碰 Monitor 折叠、人工关卡与其它 provider；不新增计划取消控件（计划仍只读）。

## Plan

1. **控件读缝**：坞面板（AC-194 的 `ActivityDockPanel.tsx`）与/或 `ActivityIndicator.tsx` 消费 `useActivityFreshness(sessionId)` 的 `liveness`；新增一个在 `src/modules/chat/hooks/` 的控制 hook（如 `useActivityControls.ts`），封装「发帧 + 由 store 帧驱动状态」两件事，**不持有本地任务状态**。
2. **按钮**：任务行加 `[data-task-stop]`（非终态才渲染），运行中前台工具行加 `[data-background-tool]`；点击构造 `{sessionId, taskId|toolUseId, requestId}` 经既有 WS 发送路径发出（`useChatRealtimeHandlers` 旁或直接 `WebSocketContext` 的 send）；`unreachable` 时 `disabled` + `[data-control-disabled-reason]`（复用 `claudeStatus.unreachable.stopReason`）。
3. **i18n**：按钮标题（stopTask / backgroundTool）进全部 12 个 locale 的 `chat.json`（缺 key 会让部分语言文案为空，判据读文案时红）。
4. **调试 agent 控制缝**：读 `debug-agent.scenario.ts` / `debug-agent.runtime.ts` / `debug-agent.engine.ts` / `debug-agent.host-driver.ts`，在 AC-194 已加步之外补足「前台工具保持未配对」「终态任务」「停止/转后台事件落在点击之后」所需步；宿主驱动实现 `stopTask`/`backgroundTasks` 并按时钟写出对应事件行；方言字面量经共享常量 import，`debug-agent-vocabulary-guard.test.ts` 保持绿。
5. **e2e 用例**：向 `e2e/activity-dock-background.spec.ts` 追加 `-g "AC-199"` 用例：注册账号、`POST /api/debug-agent/scenarios` 布场景、`POST /api/debug-agent/clock` 走时钟保持前台工具/任务开着、`navigateBounded`；断言 AC-199 全部读数；分区段复用 AC-184 的 `installPartition` 机制（本 spec 内就地实现或抽共享助手，不改 `activity-dock-truthful.spec.ts`）；墙钟由 `process.env.QUAY_E2E_RUN_STARTED_AT` 读。
6. **假形态臂**：以主用例读数函数跑「乐观改状态」变体，断言红。
7. **本地直跑**：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"` 退出 0、墙钟 ≤ 40s；`npm run typecheck`、`npm run lint`、`npm run build` 绿；`e2e/activity-dock-truthful.spec.ts`（AC-184）保持绿；`debug-agent-vocabulary-guard.test.ts` 与既有调试 agent 测试保持绿；AC-194 用例不被改红。
8. 写完成记录（AC-199 是机械判据，无人工关卡）。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"` 退出 **0**，stdout 中 AC-199 用例 `passed`；墙钟（`process.env.QUAY_E2E_RUN_STARTED_AT` 读数）**≤ 40_000ms**。
- [x] AC2 场景布好三态：调试 agent 场景在坞里同时给出一个**运行中**后台任务（有停止按钮）、一个**运行中**前台工具（有转后台按钮）、一个**已结束**任务（无停止按钮）；三者由 `GET` 活动快照与页面 DOM 两侧一致读数。
- [x] AC3 停止不乐观：对运行中任务点击 `[data-task-stop]`，**点击瞬间**（推进时钟前）该任务行 `data-task-state` 仍为原非终态（`stopped` 未被写入）；推进时钟后 `task_notification(stopped)` 到达，该行才变为 `stopped`。
- [x] AC4 转后台事件为准：对前台工具点击 `[data-background-tool]`，点击后、事件前任务面板**没有**该任务；喂入 `task_started` + `task_updated{is_backgrounded:true}` 后，任务面板出现该任务（其 id/toolUseId 与前台工具对应）。
- [x] AC5 终态无按钮：已结束任务行的 `[data-task-stop]` 选择器计数 **= 0**（结构上不渲染，不是隐藏/禁用）。
- [x] AC6 分区置灰：经 `page.routeWebSocket` 分区（夹具同 AC-184）后，`[data-task-stop]` 与 `[data-background-tool]` 均 `disabled` 且各自带说明文字（`[data-control-disabled-reason]` 或等价选择器计数 ≥ 1 且文本非空）。
- [x] AC7 假形态有分辨力：点击后立即乐观置 `stopped` 的变体 ⇒ AC3「点击瞬间状态未变」读数红；两臂复用 AC3 的读数函数并打印绿/红读数证明主断言非恒真。
- [x] AC8 既有不受影响：`e2e/activity-dock-truthful.spec.ts`（AC-184）仍绿；`debug-agent-vocabulary-guard.test.ts` 与既有调试 agent 测试仍绿（其它场景行为不变）；AC-194 用例仍绿。
- [x] AC9 契约面：`npm run typecheck`、`npm run lint`、`npm run build` 各退出 0；改动只落在 Touches（`git diff --stat develop...HEAD` 逐条对齐）；`e2e/activity-dock-background.spec.ts` 为共享文件，追加不删改 AC-194 用例。

## DoD

- 真实浏览器里，坞任务行的停止与前台工具的转后台都**只经真实 WS 帧**把请求送达、只经 `activity.snapshot`/`activity.upsert` 帧把状态读回；控件层（`src/modules/chat/`）没有任何本地任务状态写入——假形态「乐观改状态」必须红。
- 分区后的置灰是真实 DOM 读数（`disabled` + 说明文字），不是测试内联的假值；说明文字在全部 locale 有 key。
- 调试 agent 的 task / 前台工具 / 终态信号经完整脊（scenario op → 方言行 builder → engine → `appendDialectRow`/`forwardFrames` → 真实归约器 → 活动存储 → 坞）到达，且真实 WS 控制动词在调试 agent 场景里可达；`debug-agent-vocabulary-guard.test.ts` 保持绿，其它场景行为不变。
- 墙钟实测 ≤ 40s 是真实读数，且失败时判据自己输出来源（哪一读数超时）。
- 非目标外文件一行未动：不碰服务端控制动词实现、归约器、活动协议、租约、Monitor 折叠、人工关卡与其它 provider。

## Touches

- src/modules/chat/transcript/ActivityDockPanel.tsx
- src/modules/chat/hooks/useActivityControls.ts (new)
- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/i18n/locales/*/chat.json
- src/modules/chat/tests/activityDockControls.test.tsx (new)
- e2e/activity-dock-background.spec.ts
- server/modules/debug-agent/debug-agent.scenario.ts
- server/modules/debug-agent/debug-agent.runtime.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/debug-agent.host-driver.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/tests/debug-agent-host-driver.test.ts
- server/modules/websocket/services/chat-websocket.service.ts
- tasks/gap-ac199-dock-stop-background-controls-browser.md

## 完成记录

**AC1 判据绿。** `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"` 退出 0，1 passed。墙钟读数（`QUAY_E2E_RUN_STARTED_AT`）：隔离跑 **23.1s**、**22.8s**（两次），同文件连跑 AC-194+AC-199 时 **30.4s** —— 均 ≤ 40_000ms。stdout 原始序列：

```
ac2.snapshot.status=200 snapshot.tasks=["task-stop-target:running","task-terminal:completed","task-never:running"] dom.tasks=["task-never","task-stop-target","task-terminal"] foreground=7854e8d1-...
ac2.stopTarget.state=running
ac5.terminalStopButtons=0
ac3.main click-instant: before=running after=running green=true
ac4.idsBeforeBackground=["task-stop-target","task-terminal","task-never"]
ac3.settled: the stop event moved the row to stopped
ac4.backgrounded: bgTask=task-bg state=running toolUseId=7854e8d1-... foreground=7854e8d1-...
ac7.falseForm click-instant: before=running after=stopped green=false
ac6.partition: dockState=unreachable stopDisabled=true bgDisabled=true reasons=["Stop is unavailable while the server is unreachable", x3]
clock.status=200 clock.body={"success":true,...}
AC-199 wall clock: 23102ms
```

**AC2 三态。** 场景 `CONTROL_SCENARIO` 在坞里同时给出 `task-stop-target`（running，有停止按钮）、`task-terminal`（completed，无停止按钮）、`task-never`（running）三个任务，加一个未配对 `tool-call Bash` 的前台工具。`GET /api/sessions/:id/activity`（`ac2.snapshot.status=200`，`tasks=["task-stop-target:running","task-terminal:completed","task-never:running"]`）与页面 DOM 读到同一集合；前台工具**不在**快照任务里（它还不是任务），页面 `[data-foreground-tool-row]` 单独渲染。

**AC3 停止不乐观。** 点 `[data-task-stop]` 的读数为 `before=running after=running green=true` —— 点击瞬间该行 `data-task-state` 未被写入 `stopped`；随后场景时钟 12_000ms 处的 `task-notification{status:'stopped'}` 到达，`ac3.settled` 行变 `stopped`，且该行的停止按钮选择器计数归 0。

**AC4 转后台事件为准。** 点击前 `ac4.idsBeforeBackground=["task-stop-target","task-terminal","task-never"]`（无 `task-bg`）；点 `[data-background-tool]` 后立即再读仍无 `task-bg`；场景 12_300ms 的 `task-started` + 12_600ms 的 `task-updated{is_backgrounded:true}` 到达后 `task-bg` 出现，且其快照 `toolUseId` 与页面读到的前台工具 id **逐字相等**（`bgTask.toolUseId === foreground`）。

**AC5 终态无按钮。** `ac5.terminalStopButtons=0`：已结束任务的 `[data-task-stop]` 选择器计数为 0（`StopTaskControl` 仅在非终态渲染，结构上不出现）。

**AC6 分区置灰。** `page.routeWebSocket` 的 `reject` 分区（机制同 AC-184）后 `ac6.partition: stopDisabled=true bgDisabled=true reasons=[... x3]`，`[data-control-disabled-reason]` 计数 ≥ 2、文本非空（复用 `claudeStatus.unreachable.stopReason`）。注：坞的 `data-activity-state` 在无 in-flight turn 且持有时读 `background` 而非 `unreachable`（`deriveActivityDockView` 的分支顺序），所以置灰读的是 DOM 的 `disabled` 本身。

**AC7 假形态有分辨力。** 复用 AC3 的读数函数 `clickInstantVerdict`：主臂 `before=running after=running green=true`；假形态臂「点击后立即乐观置 stopped」`before=running after=stopped green=false`。两读数不同，证明主断言非恒真。

**AC8 既有不受影响。** `e2e/activity-dock-truthful.spec.ts -g "AC-184"` → 1 passed（`dock.wall=14511ms`，`dock.stop.count=0`，composer stop 仍 disabled 并带 `claudeStatus.unreachable.stopReason`）；`npx tsx --test "server/modules/debug-agent/tests/*.test.ts"` → **pass 35 / fail 0**（含 `debug-agent-vocabulary-guard.test.ts`，`FRAME_AND_EVENT_LITERALS` 绿）；AC-194 用例在同文件连跑中仍绿（`2 passed`）。注意：`activity-dock-truthful.spec.ts` 的多个 describe 各用不同用户名，单用户库里**不能整文件跑**（第二个 `createAccount` 撞 `AUTH_USER_ALREADY_CONFIGURED`）——这是该 spec 的既有性质，判据本就按 `-g` 逐条跑。

**AC9 契约面。** `npm run typecheck`（client+server+scripts）、`npm run lint`、`npm run build`（client vite + server tsc）各退出 0；`bash scripts/test.sh --for-task gap-ac199-dock-stop-background-controls-browser --allow-thin` 绿（`suite-scope-check: PASS`，`pass 1 / fail 0`）。`git diff --stat develop...HEAD` 逐条对齐 Touches。

**实现面（读代码，逐一）。**
- 坞控件（`src/modules/chat/`）：`useActivityControls.ts`（new）封装两个发送器（`chat.stop-task` / `chat.background-task`，各带 `requestId`），以 `useActivityFreshness` 的 `liveness` 决定 `disabled` 与说明文字；**不持有任何本地任务状态**（不 import 任何 store writer）。`ActivityDockPanel.tsx` 的任务行在非终态渲染 `[data-task-stop]`，前台工具渲染 `[data-foreground-tool-row][data-tool-use-id]` + `[data-background-tool]`；`disabled` 时各渲染 `[data-control-disabled-reason]`。前台 `toolUseId` 由 `ChatMessagesPane` 从已加载转写取未配对 `tool_use`（`findPendingForegroundTool`）后经 `ActivityIndicator` 传入。
- i18n：`claudeStatus.controls.stopTask` / `backgroundTool` 进全部 12 个 locale 的 `chat.json`；说明文字复用 `claudeStatus.unreachable.stopReason`（12 locale 均已存在）。
- 调试 agent 控制缝：宿主驱动实现 `stopTask` / `background`（替代进程「受理」——接受请求并返回 true，事件由场景时钟写出，这正是「点击不改状态、事件才改」可读的前提）；debug runtime 在 per-run 路由上暴露 `stopTask` / `backgroundTask` 委托给驱动；场景 `task-updated` op 新增可选 `isBackgrounded`（写成方言行的 `patch.is_backgrounded`），`task-started` / `task-notification` op 由 AC-194 已有。方言字面量经共享常量 import，`debug-agent-vocabulary-guard.test.ts` 保持绿。
- 接线（DoD「控制动词可达」所需）：`chat-websocket.service.ts` 的 `defaultGetTask` 改为读 `readSessionTasks` —— 该文件原先自建了第二张**永远不会被喂**的 task reducer，导致 `handleChatStopTask` 对任何会话都命中 `unknown-task`、驱动零调用；改为读 run loop 唯一喂的那张表后，控制动词在真实装配里可达（e2e 里 stop/background 的 `control_result` 均由驱动受理）。

**非目标外未动。** 未实现 `chat.stop-task` / `chat.background-task` 的处理函数与归属校验、Task/Schedule 归约、活动协议快照/增量、坞面板本体（AC-191/192/193/194）、租约路径（AC-195）、Monitor 折叠、人工关卡与其它 provider；计划仍只读。

**留待后续（未做，如实记录）。** 宿主驱动的 `stopTask` / `background` 目前对任何请求都返回 `true`（替代进程受理语义）；若将来要让它校验「本会话确有该 task / 该前台工具」，需要把任务表或场景读缝注入驱动——本条不做，因为控制处理函数已在调用驱动**之前**完成会话/归属/任务表/Turn Tracker 校验（AC-196/197），驱动只需报告「请求到达」。