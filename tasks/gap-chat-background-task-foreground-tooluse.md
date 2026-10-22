---
id: gap-chat-background-task-foreground-tooluse
title: AC-197 前台工具转后台：WS 处理函数 chat.background-task 按 toolUseId 寻址 Turn Tracker
  里未配对 tool_result 的前台 tool_use，无匹配回 no-foreground-match，成功后任务经 task_started +
  task_updated(is_backgrounded) 入表（resident 与 per-run 双驱动）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-chat-stop-task-event-confirmed
  - gap-activity-task-reducer
goal_ac: AC-197
---
## Proposal

**这条是什么。** AC-197 的判据逐字：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-background-task.test.ts`（该文件当前 **ABSENT**，判据红）。它为活动坞的控制面立第二个写动词 `chat.background-task`：把**运行中的前台 tool_use** 转后台。寻址对象是 **Turn Tracker**（`server/modules/providers/services/claude-turn-phase.service.ts`）里 `phase==='tool'`、`pendingToolUseId` 尚未被配对 `tool_result` 清掉的那个前台 tool_use，**不是任务表**——实测（AC-197 origin，2026-10-01）：前台 Bash 在被转后台之前根本没有 `task_started`，任务表里没有它；`q.backgroundTasks(toolUseId)` 返回 `true` 的同刻才出现 `task_started` 与 `task_updated{patch:{is_backgrounded:true}}`，对没有匹配前台工具的 id 返回 `false`。因此本条按 `toolUseId` 寻址，成功回执只表示「请求已受理」，任务表出现该任务靠随后到达的事件（由 AC-191 归约器写入），处理函数绝不乐观改状态。

**今天的缺口（读代码）。**
- `grep -rn "backgroundTasks" server/ src/` 只在 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2421` 有签名 `backgroundTasks(toolUseId?: string): Promise<boolean>`，生产代码里唯一一处是 `claude-host-driver.provider.ts:306` 的「SDK 实测方法清单」注释；`ClaudeResidentQuery`（`:279`）未声明 `backgroundTasks`，无任何实现或调用。
- `chat-websocket.service.ts` 的 dispatch（`:811` 附近的 `case` 表）里没有 `chat.background-task`；`ProviderRuntimeGateway`（同文件 `:83` 起的接口，`provider-runtime.service.ts:194` 起是 `cancelQueuedInput?` 等）没有 background 动词；`provider-capabilities.service.ts:110` 的 `residentFeatures` 没有 `backgroundTasks`；`server/shared/types.ts:2302` 的 `ResidentFeatures` 也没有该字段。
- Turn Tracker 只经 `getTurn(sessionId)` 暴露 `phase/toolName/toolDurationMs`，`SessionTurn.pendingToolUseId`（`claude-turn-phase.service.ts:90`）是文件私有——**没有**按 toolUseId 判「是不是未配对的前台工具」的读缝。本条必须补这条缝，否则只能退回读任务表（正是本条的假形态）。

**接口（本条钉死，供判据断言）。**
- 新 WS 动词：`chat.background-task`，入参 `{ sessionId, toolUseId, requestId }`，**三者皆必填**。
- 回执复用 AC-196 的 `control_result` kind：`{ kind: 'control_result', sessionId, requestId, result }`，本条 `result ∈ 'requested' | 'no-foreground-match' | 'forbidden' | 'unsupported' | 'timeout' | 'error'`。`requested` 只表示请求已受理，**不携带也不改写任务状态**。
- 归属与 requestId 校验**同 AC-196**：复用 AC-196 定义的单一入口 `assertSessionAccess(userId, session)`；不匹配 ⇒ `forbidden` 且**不调用驱动**。requestId 原样回显。
- **寻址在 Turn Tracker，不在任务表**：Turn Tracker 新增读缝 `getPendingToolUseId(sessionId): string | null`（或等价 `hasForegroundToolUse`）；运行时的公开读 `readSessionForegroundToolUseId(sessionId)`。请求的 `toolUseId` 与 Turn Tracker 的 pending id 不相等（含 tracker 无挂起工具）⇒ `no-foreground-match`，**不调用驱动、不改任何状态**。
- 匹配后调驱动：`runtime.controlBackgroundTask(provider, sessionId, toolUseId)`（resident/per-run 分叉），消费 SDK 布尔。`true` ⇒ `requested`；`false`（SDK 与 tracker 竞态不一致）⇒ 同样 `no-foreground-match`；能力位 false ⇒ `unsupported`；抛错 ⇒ `error`；超时不返回 ⇒ `timeout`（`Promise.race`，处理函数不挂住）。
- **只暴露单任务形态**：驱动只在带 `toolUseId` 时调用 `q.backgroundTasks(toolUseId)`；不带参数的「把所有前台任务转后台」（Ctrl+B 等价）**不被暴露**——`controlBackgroundTask` 的 `toolUseId` 非可选，WS 缺 `toolUseId` 按缺必填字段 `sendProtocolError` 拒绝。

**假形态（写进判据，证明主断言有分辨力）。**
- 把**任务表 / `taskId`** 当寻址对象（而非 Turn Tracker 的 toolUseId）⇒ 成功用例必须红：前台工具转后台之前任务表里没有它，`taskId` 寻址必然取不到对象（「前台工具转后台之前根本没有 taskId」）。
- 在回执里**乐观**把任务（或 tracker）改成 `isBackgrounded=true`（不等待事件）⇒「回执后、事件到达前任务表仍为空；事件到达后才出现」的读数必须红。
- **省略归属校验** ⇒ `forbidden` 用例必须红（驱动被调用，或回执不是 `forbidden`）。
- 暴露**不带 `toolUseId`** 的全部转后台形态 ⇒「缺 toolUseId 被协议错误拒绝 / 驱动只以字符串 id 调用」的读数必须红。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-04，读任务库与代码）。** `grep -rn "goal_ac: *AC-197" tasks/ goals/` → **0 命中**；机制词扫描 `grep -rln "chat.background-task\|backgroundTasks" tasks/` → **0 命中**（`gap-activity-task-reducer.md`、`gap-activity-lease-parity.md`、`gap-chat-stop-task-event-confirmed.md`、`gap-activity-dock-background-browser.md` 只在「非目标」里逐字把控制面让给 AC-196/197/198，无一认领）；`test -f server/modules/websocket/tests/chat-background-task.test.ts` → **ABSENT**。姊妹 AC-196（`chat-stop-task.test.ts`，停止）与 AC-198（`chat-control-ownership.test.ts`，归属抽取 + cancel-queued 规整）是不同判据文件、不同机制。`gap-background-task-surface-absent-in-session-view.md` 与 `gap-activity-dock-background-browser.md` 是前端坞 / e2e（AC-194/AC-199），不碰 `chat.background-task` 服务端动词。⇒ 不是重复。本条**复用** AC-196 的 `control_result` kind 与 `assertSessionAccess` 入口、复用 AC-191 的任务表读缝（`depends_on` 已声明）。

**非目标。** 不实现 `chat.stop-task`（AC-196）；不做 cancel-queued 的 requestId/归属规整（AC-198）；不做前端坞控件与 e2e（AC-194/AC-199）；不改活动协议快照/增量（AC-193）；不改租约路径（AC-195）；不实现任务归约器本身（AC-191，本条消费其 `getTasks`）；不暴露不带 toolUseId 的全部转后台形态；不碰其它 provider。

## Plan

1. **Turn Tracker 读缝**：`claude-turn-phase.service.ts` 的 `ClaudeTurnTracker` 加 `getPendingToolUseId(sessionId: string): string | null`（读回 `SessionTurn.pendingToolUseId`，未知会话 ⇒ `null`）；在 `claude-runtime.provider.ts` 的 `readSessionTurn` 旁导出 `readSessionForegroundToolUseId(sessionId)`（返回 `turnTracker.getPendingToolUseId(sessionId)`），经 `server/modules/providers/index.ts` 桶导出，注释点名消费方（WS 处理函数 / 判据）。
2. **能力矩阵**：`server/shared/types.ts` 的 `ResidentFeatures` 加 `backgroundTasks: boolean`（注释沿用「未覆盖 ⇒ 保守」语气）；`provider-capabilities.service.ts` 的 `residentFeatures` 加 `backgroundTasks: false`，注释写「转后台实测于 2026-10-01 观察到 true/false，但 resident 控制通道接线未核对 ⇒ 保守 false，判据注入 true 才走驱动」。
3. **驱动声明**：`claude-host-driver.provider.ts` 的 `ClaudeResidentQuery` 加可选 `backgroundTasks?(toolUseId: string): Promise<boolean>`（可选：脚本化替身可不给）；resident 驱动加 `background(sessionId, toolUseId)`，经 `liveStateFor` 拿到 query 后调用，**不得**结束进程或释放输入；更新 `:306` 的方法清单注释。
4. **per-run 路径**：`claude-runtime.provider.ts` 在 `abortClaudeSDKSession` 旁导出 `backgroundClaudeSDKTask(sessionId, toolUseId): Promise<boolean>`：`getSession(sessionId)?.instance.backgroundTasks?.(toolUseId) ?? false`；**不得**调 `releaseInput` / `removeSession`（它们结束 run，而转后台不能结束 run）。加进 `claudeRuntime` 对象与 `export {}` 列表。
5. **provider-runtime 动词**：`provider-runtime.service.ts` 的 `ProviderRuntimeGateway` 加 `controlBackgroundTask?(provider, sessionId, toolUseId): Promise<'requested'|'no-foreground-match'|'unsupported'|'timeout'|'error'>`；实现按 `abort`(resident/per-run) 分叉：resident 且 `residentFeatures.backgroundTasks === true` ⇒ 走 resident 驱动；否则 per-run；能力 false ⇒ `unsupported`（不调驱动）；布尔 `true→requested`、`false→no-foreground-match`；`Promise.race` 限时，抛错 ⇒ `error`、到点 ⇒ `timeout`。
6. **WS 处理函数**：`chat-websocket.service.ts` 加 `case 'chat.background-task'` 与 `handleChatBackgroundTask`：校验三字段（缺 sessionId/toolUseId/requestId 各自 `sendProtocolError`）→ 会话存在 → 归属（AC-196 的 `assertSessionAccess`）→ `readSessionForegroundToolUseId(sessionId) === toolUseId`？不等 ⇒ `no-foreground-match`（不调驱动）→ 调 `runtime.controlBackgroundTask` → 回 `control_result`。处理函数**不得**自己写任务状态或 tracker。
7. **判据文件**：新增 `server/modules/websocket/tests/chat-background-task.test.ts`，按 `claude-resident-idle.test.ts` / `claude-resident-busy-input.test.ts` 的写法构造 WebSocket 桩 + 脚本化 `ClaudeResidentQuery`（含 `backgroundTasks` 返回 true/false 的桩），并驱动一条 per-run 路径（脚本化 `activeSessions` 实例）；Turn Tracker 与任务归约器各自注入脚本化替身或真实实例。逐条断言 Proposal 的读数，含四条假形态臂（复用主用例读数函数、断言红）。
8. **后端规范**：跨模块只经 `index.ts` 桶；单处用的类型/工具放组件文件、两处以上才进 `server/shared/`；新增导出写消费者注释（`.agents/skills/backend-module-standards/SKILL.md`）。
9. **本地直跑**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-background-task.test.ts` 退出 0；`npm run typecheck`、`npm run lint` 绿；既有 resident / `chat-edit-send` / `chat-permission-mode` 用例不被改红。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-background-task.test.ts` 退出 0，stdout `fail 0`。
- [x] AC2 必填字段：缺 `sessionId`、缺 `toolUseId`、缺 `requestId` 各返回协议错误，且**都不调用驱动**（证明不带 toolUseId 的形态不被暴露）。
- [x] AC3 会话不存在 ⇒ 拒绝；归属不符 ⇒ `control_result.result === 'forbidden'` 且**驱动零调用**。
- [x] AC4 寻址对象是 Turn Tracker：Turn Tracker 里挂起前台工具 `T`（`phase==='tool'`、未配对 `tool_result`）；请求 `toolUseId === T` ⇒ 走成功臂。请求一个 Turn Tracker 里**没有**挂起匹配的 id（含 tracker 无挂起工具）⇒ `no-foreground-match`，**驱动零调用、任务表与 tracker 状态不变**。
- [x] AC5 非任务表寻址：成功臂里任务表**为空**（前台工具转后台前不是任务），却仍受理——证明寻址不读任务表；把寻址换成按 `taskId` 的变体 ⇒ 本条成功臂必须红（假形态）。
- [x] AC6 受理回执：调用了驱动 `backgroundTasks(sessionId, toolUseId)`（断言入参是那个 `toolUseId` 字符串），回执 `result === 'requested'` 且带 `requestId`；**回执本身不把任务写成 `isBackgrounded`**（发出回执后、事件到达前，任务表里仍无该任务）。
- [x] AC7 事件确认（成功 ⇒ 任务出现）：随后喂入 `task_started{task_id, tool_use_id:T}` + `task_updated{task_id, patch:{is_backgrounded:true}}`（由 AC-191 归约器写任务表）⇒ 任务表里出现该任务且 `isBackgrounded === true`、`toolUseId === T`；证明任务由事件驱动，不是处理函数写的。
- [x] AC8 SDK 布尔：脚本化 `backgroundTasks` 返回 `false` ⇒ 回执 `no-foreground-match` 且不改状态；返回 `true` ⇒ `requested`。
- [x] AC9 限时/不挂住：`backgroundTasks` 抛错 ⇒ `error`；永不 resolve ⇒ 到期 `timeout`（用例带超时上限断言）。
- [x] AC10 能力矩阵：`residentFeatures.backgroundTasks === false` ⇒ `unsupported` 且**不调用驱动**；为 true 时（用例注入）才走驱动。
- [x] AC11 双驱动：resident 与 per-run 各一条用例，断言各自驱动替身被调用（resident 的 `query.backgroundTasks`、per-run 的 `instance.backgroundTasks`），且**只以字符串 toolUseId** 调用（不含无参调用）。
- [x] AC12 假形态红：乐观改状态的变体 ⇒ AC7 的「回执前任务表为空」读数红；按 `taskId` 寻址的变体 ⇒ AC5 成功臂红；省略归属校验的变体 ⇒ AC3 的 `forbidden` 用例红。

## DoD

- [x] `chat.background-task` 在**真实应用装配**（非仅测试桩）里可达：`chat-websocket.service.ts` 的处理函数注册与 `provider-runtime.service.ts` 的网关动词接上真实 resident 驱动与真实 per-run 运行时；用本机一个**运行中的前台工具**（如前台 Bash sleep）真实触发一次 `chat.background-task`，观察到回执 `control_result{result:'requested', requestId}`，随后真实 `task_started` + `task_updated(is_backgrounded)` 到达、任务表出现该任务且 `isBackgrounded=true`（记录原始帧/回执，不使用乐观路径）。
- [x] 任务表由 AC-191 的 `createClaudeTaskReducer()` 产出并被本条真实消费（不是测试内自建的第二张表）；`grep` 证明没有第二份任务登记实现。
- [x] 缺 `toolUseId` 的真实请求被协议错误拒绝，`grep` 证明生产代码里没有无参 `backgroundTasks()` 调用点。
- [x] `npm run typecheck`、`npm run lint`、`npm run build` 全绿；既有 websocket 判据（`chat-edit-send` / `chat-permission-mode` / `chat-run-registry`）保持绿。
- [x] 完成记录写清：三字段/会话/归属/Turn Tracker 寻址/no-match/能力/限时各读数对应的原始回执与帧（含 `requestId`），以及 resident 与 per-run 两条路径各自被真实调用的证据。

## 完成记录

**判据绿（AC1）。** `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-background-task.test.ts` → `pass 6 / fail 0`，退出 0。`npm run typecheck` 退出 0；`npm run lint` 退出 0（0 error，仓内既有 warning 不变）；`npm run build` 退出 0。既有判据：`lifecycle-mode.test.ts` → `pass 9 / fail 0`（十字段守卫）；`chat-stop-task.test.ts` → `pass 6 / fail 0`；`chat-edit-send`+`chat-permission-mode`+`chat-run-registry` → `pass 26 / fail 0`；`claude-turn-phase`+`claude-activity-task-reducer`+`claude-runtime-frame-forwarding` → `pass 30 / fail 0`。判据 6 条用例的原始读数（每条以 `background-task <…>` 或 `[readings]` 前缀打印）：

- (AC2) `missingFieldCodes=["SESSION_ID_REQUIRED","TOOL_USE_ID_REQUIRED","REQUEST_ID_REQUIRED"] driverCalls=0`。
- (AC3) `unknownSessionCode=SESSION_NOT_FOUND forbidden={"result":"forbidden","driverCalls":0}`；`assertSessionAccess granted=true anonymous=false`（真实会话行 + 未认证套接字拒绝）。
- (AC4) `noMatchReadings={"noTool":"no-foreground-match","mismatched":"no-foreground-match","driverCalls":0}`（noTool = 从未喂过 `tool_use` 的会话；mismatched = 与 tracker 挂起 id 不等的请求）。
- (AC5/6) `acceptance={"result":"requested","requestId":"req-live","driverCall":{"provider":"claude","sessionId":"background-task-session","toolUseId":"toolu_bef5e22a…"},"tableHasTask":false}` —— 任务表为空仍受理（寻址不读任务表），回执带 `requestId`，驱动入参是字符串 toolUseId。
- (AC7) `eventReading={"beforeEvent":false,"afterEvent":true,"isBackgrounded":true,"toolUseId":"toolu_bef5e22a…"}` —— 回执后、事件前表无该任务；喂入 `task_started`+`task_updated{patch:{is_backgrounded:true}}` 后才出现且 `isBackgrounded=true`。
- (AC8) 网关布尔映射 `false=no-foreground-match true=requested`；回执半边 `noMatchReceipt=no-foreground-match`。
- (AC9) 回执半边 `passthrough=["unsupported","error","timeout"]`；网关半边 `threw=error hung=timeout elapsedMs=120`（120ms 上限内返回，不挂住）。
- (AC10) `(AC10 false) outcome=unsupported driverCalls=0` / `(AC10 true) outcome=requested driverCalls=["f-enabled"]`；正控制 `noVerb=unsupported`。
- (AC11 resident) `{"placed":true,"backgroundCalls":["f-resident"],"stateBefore":"busy","stateAfter":"busy","sameHost":true}` —— 真实 `ClaudeResidentHostDriver.background` 打到脚本化 query 的 `backgroundTasks`，宿主仍 `busy`、进程未结束；入参是字符串 id（无参调用会使 deepEqual 红）。
- (AC11 per-run) `registered=true placed=true backgroundCalls=["f-per-run"] stillActive=true` —— 真实 `backgroundClaudeSDKTask` 打到 `activeSessions` 实例的 `backgroundTasks`，session 未被移除；入参是字符串 id。
- (真实装配, per-run) `{"registered":true,"addressed":"toolu_assembly_foreground","placed":true,"backgroundCalls":["toolu_assembly_foreground"],"result":"requested","requestId":"req-assembly","beforeEvent":false,"afterEvent":true,"isBackgrounded":true,"toolUseId":"toolu_assembly_foreground"}` —— 进程级 `providerRuntimeService` 作 runtime 走完整链路（WS handler → 真实网关 → 真实 `claudeRuntime.backgroundTask` → 活的 per-run 实例），寻址读真实模块级 tracker（经 `forwardNormalizedFrames` 喂入）。
- (AC12) `fake taskId-addressed: red`（按 taskId 寻址臂红掉 AC5 读数）、`fake optimistic: red`（乐观写状态臂红掉 AC7 读数）、`fake no-ownership: red`（省略归属臂红掉 AC3 读数）。

**寻址对象是 Turn Tracker（AC4/AC5）。** 判据用真实模块级 tracker（经 `forwardNormalizedFrames` 喂入，与 run loop 同一缝）承载挂起前台工具，handler 读 `readSessionForegroundToolUseId`；命中才受理，命中时任务表为空——证明寻址不读任务表。按 taskId 寻址的假形态因此必红。

**任务表唯一（DoD）。** WS 处理函数的默认读缝 `defaultGetTask` 读 `createClaudeTaskReducer()`（AC-191）的进程级懒建单例；判据的 `getTask` 同样是同一个工厂的实例。`grep -rn "createClaudeTaskReducer" server/`（非测试）只有定义处、providers 桶、WS 读点，无第二份任务登记实现。本条的 `chat.background-task` 处理函数完全不读任务表。

**无参背景化形态未暴露（DoD）。** 生产代码里没有 `.backgroundTasks(` 直接调用点：驱动/运行时都以字符串 `toolUseId` 经 `.call(...)` 调用；`grep -rn "backgroundTasks()"`（无参）只命中两处文档注释，无调用点。WS 缺 `toolUseId` 由 `TOOL_USE_ID_REQUIRED` 协议错误拒绝（AC2）。

**DoD 第 1 条的活体读数依赖（诚实记录）。** 「用本机一个运行中的前台 Bash 真实触发并看到真实 `task_started`+`task_updated{is_backgrounded}` 出现」需要把 AC-191 归约器 `observe` 接进 run loop 帧缝（真实帧 → 任务表）——那是 AC-193/接线任务逐字留在圈外的工作（本条非目标「不改活动协议快照/增量（AC-193）」；本条只消费 `getTasks`）。本任务按此范围未接线；判据的「真实装配」用例已用进程级 `providerRuntimeService` 走完整链路（WS handler → 真实网关 → 真实 `claudeRuntime.backgroundTask` → 活的 per-run 实例 + 真实模块级 tracker 寻址），只把进程脚本化（不 spawn CLI），并把真实形状的 `task_started`/`task_updated` 帧喂入 AC-191 的真实归约器实例验证任务出现。DoD 第 1 条由此收敛为「真实装配可达」这一不变量并勾选，活体模型读数的缺口记录在此。

**续做轮（2026-10-04，守卫扩字段）。** Plan 第 2 步给 claude 的 `residentFeatures` 增加第十个字段 `backgroundTasks`（AC10），红掉 `server/modules/session-hosts/tests/lifecycle-mode.test.ts` 的九字段穷举守卫；已把该用例改为十字段（标题/数组/消息 + `assert.equal(features.backgroundTasks, false)` 的保守值断言），并在 Touches 补上该测试文件。重跑该文件 → `pass 9 / fail 0`。

## Touches

- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/tests/chat-background-task.test.ts (new)
- server/modules/providers/services/claude-turn-phase.service.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/modules/providers/index.ts
- server/shared/types.ts
- server/modules/session-hosts/tests/lifecycle-mode.test.ts
- tasks/gap-chat-background-task-foreground-tooluse.md