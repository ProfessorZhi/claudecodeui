---
id: gap-ac233-control-single-instance-wiring
title: AC-233 单实例控制服务：WebSocket 的 chat.send/abort/cancel-queued 与
  scheduled-messages 触达同一个 ChatControlService 实例（WS 处理器只剩解析与翻译），判据
  server/modules/websocket/tests/chat-control-wiring.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac232-control-shared-access-entry
goal_ac: AC-233
---
## Proposal

AC-233（GOAL-019 退出条件 4；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「ChatControlService / 装配」与「验收（阶段 1）」）要求**只有一个** `ChatControlService` 实例：`server/index.ts` 在创建 WebSocket 服务器之前构造它，把**同一个**实例交给 `createWebSocketServer` 的 chat 依赖与 scheduled-messages 的分发器；WebSocket 的 `chat.send`/`chat.abort`/`chat.cancel-queued` 处理器只剩解析→调用→翻译，不再直接触碰 `dispatchRun`/`runtime.abort`/`runtime.cancelQueuedInput`；scheduled-messages 改调同一实例的 `send`（`via: 'scheduled'`），保留「定时器优先打断进行中的运行」语义，既有行为不变。判据 `server/modules/websocket/tests/chat-control-wiring.test.ts` 用语法树扫描 + 计数间谍 + 真帧驱动给出 (a)–(d) 四组读数与三条取假形态。

<!-- dedup-ref -->
前置与边界：本任务建立在 `gap-ac232-control-shared-access-entry` 之上（该任务及其前置 `gap-ac231`/`gap-ac230` 已在 `chat-control.service.ts` 上交付 `send`/`abort`/`cancelQueued` 与共用访问入口）；本条只做「单实例装配 + 处理器改造 + 分发器改造 + 扫描判据」，不重做控制服务的动作实现。回归守卫 AC-237 的 17 个文件里含 `server/modules/scheduled-messages/tests/scheduled-messages.test.ts`；本条把分发器的注入缝从 runtime 网关换成控制服务，必须按 AC-237 自身的迁移规则「只许把它移植到新缝上并保持断言强度，不许删除或放宽，并在任务记录里逐条列出」。

现状（红态基线）：判据文件 `server/modules/websocket/tests/chat-control-wiring.test.ts` 不存在，判据的存在性闸以退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-wiring.test.ts`；`server/index.ts` 目前把 `providerRuntimeService` 分别交给 `createWebSocketServer`（`chat.runtime`）与 `initializeScheduledMessageDispatcher`，没有任何共享控制服务实例；`chat-websocket.service.ts` 的 `handleChatSend`（:465）直接调 `dispatchRun`、`handleChatAbort`（:766）直接调 `dependencies.runtime.abort`、`handleChatCancelQueued`（:818）直接调 `dependencies.runtime.cancelQueuedInput`；`scheduled-message-dispatcher.service.ts` 的 `sendClaimedQueuedMessage`（:65）与 `sendClaimedMessage`（:108）直接调 `runDetachedChatTurn`。

要交付：

1. **单实例装配**（`server/index.ts`）。在 `createWebSocketServer` 之前构造 `const chatControl = createChatControlService({ runtime: providerRuntimeService, ... })`（依赖按控制服务在 AC-230/232 定义的实际签名注入）；把**同一个** `chatControl` 放进 `createWebSocketServer(server, { ..., chat: { runtime: providerRuntimeService, control: chatControl } })`，并把**同一个** `chatControl` 交给 `initializeScheduledMessageDispatcher(chatControl)`（替换现在的 `providerRuntimeService`）。全仓只有一个 `createChatControlService(` 调用点（装配处）；网关/分发器不得各自构造。
2. **barrel 导出**（`server/modules/websocket/index.ts`）。导出 `createChatControlService`（消费者 `server/index.ts`），加消费方注释；遵守「不导出没有跨文件消费者的符号」。
3. **控制服务补齐本 AC 需要的上游语义**（`server/modules/websocket/services/chat-control.service.ts`，在 AC-232 已交付的动作上补全到处理器可直接翻译的程度）。`send` 支持 `interruptActiveRun`（到点发送优先打断进行中的运行——现为 `runDetachedChatTurn` 内联的逻辑，搬进控制服务）；`abort` 覆盖 `NO_ACTIVE_RUN` 分支；`cancelQueued` 返回 `HostQueuedInputCancelResult | 'forbidden'`。**结果码/文案与既有处理器一致**（`SESSION_NOT_FOUND`/`UNSUPPORTED_PROVIDER`/`RUN_IN_PROGRESS`/`FORBIDDEN`/`NO_ACTIVE_RUN`/`MESSAGE_UUID_REQUIRED`/`REQUEST_ID_REQUIRED` 等），既有 WebSocket 判据（AC-237 族）逐字通过所依赖的帧与文案不得改。控制服务文件里保留对 `dispatchRun`、`.abort(`、`.cancelQueuedInput(` 的调用（判据 (d) 的正例对照要在这里扫到这三类调用）。
4. **WebSocket 处理器只剩解析与翻译**（`chat-websocket.service.ts`）。`handleChatSend`/`handleChatAbort`/`handleChatCancelQueued` 的函数体：只解析帧字段（sessionId/content/options/messageUuid/requestId）、构造 `caller = { userId, via: 'websocket' }`、调用 `dependencies.control.<send|abort|cancelQueued>(caller, …)`、把返回值翻译成既有协议帧（`protocol_error` 或 `queued_input_cancel_result` 回执）。这三个函数体里**不得**出现 `dispatchRun`、`.abort(`、`.cancelQueuedInput(` 调用，也不得直接调用 `dependencies.runtime` 的任何方法（含 `hasRuntime`——会话解析与 provider 判定都搬进控制服务）。`ChatWebSocketDependencies` 增加控制服务注入缝（供判据注入间谍）；生产装配点必须显式提供（无默认构造，避免第二实例）。`chat.edit-send`/`chat.stop-task`/`chat.background-task`/`chat.subscribe` 的走向不在本 AC 的机械判据内，本任务不改动它们的走向。
5. **scheduled-messages 经同一实例发送**（`scheduled-message-dispatcher.service.ts`）。`dispatchDueScheduledMessages`/`dispatchQueuedMessages`/`initializeScheduledMessageDispatcher` 改为接受控制服务实例：到点发送走 `control.send({ userId, via: 'scheduled' }, { sessionId, content, options, interruptActiveRun: true })`；草稿队列路径按既有语义调用同一实例的 `send`（不打断，保留「忙则还原、下轮重试」的既有行为）。`runDetachedChatTurn` 变为 `send` 的薄包装或删除（若保留，须仍只经控制服务，不得直接 `dispatchRun`）。失败登记（`markFailed`）、草稿清理/还原等既有行为逐字保持。
6. **判据 `server/modules/websocket/tests/chat-control-wiring.test.ts`**（红先行）。读数：
   (a) 向 `handleChatConnection`（或 `createWebSocketServer` 的 `chat` 依赖）注入计数间谍控制服务，用 `chat-edit-send.test.ts`/`chat-control-ownership.test.ts` 的假 socket + 假请求（带认证用户）驱动真实 `chat.send`、`chat.abort`、`chat.cancel-queued` 三帧；间谍上 `send`/`abort`/`cancelQueued` **各被调用一次**，每次 `caller.via === 'websocket'` 且 `caller.userId` 为该请求的用户；同一次驱动里注入的假 runtime 的方法调用计数为 **0**（处理器不直接触达 runtime）。
   (b) 把**同一个间谍实例**交给 scheduled-messages 分发器，用临时库播种一条到点消息，`dispatchDueScheduledMessages(spy)` 后间谍 `send` 恰被调用一次，`caller.via === 'scheduled'`，且入参带 `interruptActiveRun: true`（打断语义）；既有 scheduled-messages 行为由 AC-237 的 `scheduled-messages.test.ts`（迁移新缝后、断言强度不变）守护。
   (c) 用 TypeScript 语法树扫描 `chat-websocket.service.ts`：`handleChatSend`/`handleChatAbort`/`handleChatCancelQueued` 三个函数体里对 `dispatchRun(`、`.abort(`、`.cancelQueuedInput(` 的调用数为 **0**（逐函数、逐符号列出计数）。
   (d) 同一次运行里的**正例对照**：同一个扫描器扫描 `chat-control.service.ts`，能找到这三类调用（各 ≥1），证明 (c) 的零不是扫描器失灵。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 让 `handleChatSend` 直接调 `dispatchRun` ⇒ (a)（间谍未命中/假 runtime 被直接调用）与 (c)（扫到 `dispatchRun`）必须红；(ii) scheduled-messages 自己 `createChatControlService(...)` 而非用注入实例 ⇒ (b) 必须红；(iii) WebSocket 与 scheduled-messages 各持一个控制服务实例 ⇒ (b) 必须红。
7. **AC-237 迁移登记**。若分发器换缝迫使 `server/modules/scheduled-messages/tests/scheduled-messages.test.ts` 的 `createRuntime(runs)` 假替身改形，逐条列出移植项（旧缝→新缝、每条断言强度如何保持不变），并确认该文件仍在 AC-237 的 17 文件集合里通过；不许删除或放宽任何断言。

边界：不实现 MCP/OAuth/新端点；不加 `ChatRunSource` 的 `mcp`（归 AC-234）；不做运行保留期/摘要（归 AC-235）；不做宿主启停服务（归 AC-236）；不改 WebSocket 协议与 `chat.subscribe` 帧序列（AC-237 守护）；不改 `chat.edit-send`/`chat.stop-task`/`chat.background-task` 的处理器走向；不构造第二份控制服务实例。

判定纪律：单实例是「同一个对象被两个调用方触达」的实测（同一间谍实例同时收 websocket 与 scheduled 两种 caller），不是「代码看起来共用」；(c) 的零必须带 (d) 的正例对照；三条取假形态各自先红后恢复。

## AC

- [x] AC1 判据绿：`for f in server/modules/websocket/tests/chat-control-wiring.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-wiring.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-wiring.test.ts`）。
- [x] AC2 (a) WebSocket 三帧各命中间谍一次且 caller.via 为 websocket：驱动真 `chat.send`/`chat.abort`/`chat.cancel-queued` 帧后，间谍 `send`/`abort`/`cancelQueued` 调用计数各为 1，逐次 `caller.via === 'websocket'`、`caller.userId` 等于认证用户；写入三组读数。
- [x] AC3 (a) 处理器零直触 runtime：同一次驱动里，注入的假 runtime 的 `run`/`abort`/`cancelQueuedInput`/`hasRuntime` 全部方法调用计数为 0（写入逐方法计数）。
- [x] AC4 (b) scheduled-messages 触达同一实例：`dispatchDueScheduledMessages(<同一间谍>)` 后间谍 `send` 恰被调用 1 次，`caller.via === 'scheduled'`，入参 `interruptActiveRun === true`；且该间谍对象与 AC2 用的是同一个实例（写入调用日志两段 caller）。
- [x] AC5 (c) 三处理器函数体零禁用调用：语法树扫描 `chat-websocket.service.ts`，`handleChatSend`/`handleChatAbort`/`handleChatCancelQueued` 三体里 `dispatchRun`/`.abort(`/`.cancelQueuedInput(` 计数全为 0（逐函数逐符号列出）。
- [x] AC6 (d) 正例对照非零：同一扫描器扫 `chat-control.service.ts`，`dispatchRun`/`.abort(`/`.cancelQueuedInput(` 各 ≥1（写入三项计数），证明 AC5 的零不是扫描器失灵。
- [x] AC7 单实例装配实测：`grep -n "createChatControlService(" server/index.ts` 只有一处构造；`createWebSocketServer` 的 chat 依赖与 `initializeScheduledMessageDispatcher` 收到的是同一变量（写入 grep 输出与变量名）。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) `handleChatSend` 直调 `dispatchRun` ⇒ AC2/AC3 与 AC5 红；(ii) 分发器自造控制服务 ⇒ AC4 红；(iii) WS 与分发送各持一实例 ⇒ AC4 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC9 不回归与仓库门：AC-237 的 17 文件集合（含迁移后的 `scheduled-messages.test.ts`）逐字/按登记迁移项通过（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级，写明计数）；跨模块只经 barrel、无深导入。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写；列出实际改动文件清单。

## DoD

- 单实例是实测事实：同一间谍实例在一次运行里既收到 `via: 'websocket'` 的三次调用、又收到 `via: 'scheduled'` 的到点发送；`server/index.ts` 只有一个构造点，两个消费者是同一变量。
- 三个 WebSocket 处理器真的只剩解析→调用→翻译：语法树在三个函数体里扫到 0 次 `dispatchRun`/`.abort(`/`.cancelQueuedInput(`，且假 runtime 在真帧驱动下零直触；同一扫描器在控制服务里扫到这三类调用（正例对照），零不是扫描器失灵。
- scheduled-messages 到点发送真的经同一实例、`via: 'scheduled'`、带打断语义；既有 scheduled-messages 行为按 AC-237 迁移规则保持（迁移项逐条列出，断言强度不放宽）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards` 与仓库 AGENTS.md（后端规范、导出带消费方注释、不导出无消费者符号）；不越界实现 AC-234/235/236；不改协议与既有判据。

## Touches

- server/index.ts
- server/modules/websocket/index.ts
- server/modules/websocket/services/chat-control.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts
- server/modules/scheduled-messages/tests/scheduled-messages.test.ts
- server/modules/scheduled-messages/index.ts
- server/modules/websocket/tests/chat-control-wiring.test.ts (new)
- tasks/gap-ac233-control-single-instance-wiring.md

## Evidence (AC-233)

实现提交 `94bfd57e`（worktree 分支 `task/gap-ac233-control-single-instance-wiring`），pre-merge 提交 `4c561d75`。

### 红态基线（AC1）
改动前判据文件不存在：`git show develop:server/modules/websocket/tests/chat-control-wiring.test.ts` → 退出 128。存在性闸逐字输出（以临时移走判据文件复现）：`缺判据文件：server/modules/websocket/tests/chat-control-wiring.test.ts`，退出 1。

### AC1 绿
`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-wiring.test.ts` → `tests 3 / pass 3 / fail 0`（exit 0）。

### (a) AC2 / AC3 读数
`control-wiring (a) {"send":1,"abort":1,"cancelQueued":1,"sendCaller":{"userId":1,"via":"websocket"},"abortCaller":{"userId":1,"via":"websocket"},"cancelCaller":{"userId":1,"via":"websocket"},"drivers":{"run":0,"abort":0,"cancelQueuedInput":0,"hasRuntime":0}}` —— 三帧各命中同一间谍一次、caller 均为 websocket/认证用户；假 runtime 四项计数全 0（handler 只经控制服务）。

### (b) AC4 读数（同一实例）
`control-wiring (b) {"sent":1,"newSendCalls":1,"scheduledCaller":{"userId":1,"via":"scheduled"},"scheduledInput":{"sessionId":"control-wiring-session","content":"wire scheduled","options":{},"interruptActiveRun":true},"sameInstance":true}`
`control-wiring (b) same-object: websocket={"userId":1,"via":"websocket"} scheduled={"userId":1,"via":"scheduled"}` —— 同一间谍对象先收 websocket 的三次 caller、再收到点发送的 scheduled caller。

### (c) AC5 / (d) AC6 读数
`control-wiring (c) perHandler={"handleChatSend":{"dispatchRun":0,"abort":0,"cancelQueuedInput":0},"handleChatAbort":{"dispatchRun":0,"abort":0,"cancelQueuedInput":0},"handleChatCancelQueued":{"dispatchRun":0,"abort":0,"cancelQueuedInput":0}} total={"dispatchRun":0,"abort":0,"cancelQueuedInput":0}`
`control-wiring (d) controlService={"dispatchRun":1,"abort":2,"cancelQueuedInput":1}` —— 正例对照非零，证明 (c) 的零不是扫描器失灵。

### AC7 单实例装配实测
```
$ grep -n "createChatControlService(" server/index.ts
117:const chatControl = createChatControlService({ runtime: providerRuntimeService });
```
唯一构造点，变量名 `chatControl`；同一变量同处的两个消费者：
```
127:        control: chatControl,          # createWebSocketServer 的 chat 依赖
598:            initializeScheduledMessageDispatcher(chatControl);
```

### AC8 取假形态（先提交实现 `94bfd57e`，再逐条变异 → 必红 → 恢复 → 重跑绿）
(i) 变异：`handleChatSend` 不走控制服务、直调 `dispatchRun`（并自造 result）。变异 diff：
```
-  const result = await dependencies.control.send(
-    { userId, via: 'websocket' }, { sessionId, content: ..., options: ..., connection: ws },
-  );
+  const mutatedSession = sessionsDb.getSessionById(sessionId);
+  const dispatched = await dispatchRun(ws as never, userId, sessionId, mutatedSession as never, data, dependencies as never);
+  const result = dispatched.started ? { ok: true as const, runId:'mutation', ... } : { ok: false as const, code:'RUN_IN_PROGRESS' as const, ... };
   if (!result.ok) { sendProtocolError(ws, result.code, result.message, sessionId); return; }
   await result.completion;
```
逐字失败行（两处红）：
```
✖ (a)/(b) the WebSocket three frames and a scheduled due send reach the same control service
  AssertionError [ERR_ASSERTION]: chat.send must call the control service exactly once
    actual: 0, expected: 1
✖ (c)/(d) the three transport verbs touch no runtime, ...
  AssertionError [ERR_ASSERTION]: handleChatSend must not call dispatchRun, runtime.abort or runtime.cancelQueuedInput
    actual: { dispatchRun: 1, abort: 0, cancelQueuedInput: 0 }, expected: { dispatchRun: 0, abort: 0, cancelQueuedInput: 0 }
```
恢复：`git checkout -- server/modules/websocket/services/chat-websocket.service.ts`；重跑 `tests 3 / pass 3 / fail 0`。

(ii) 变异：分发器自造控制服务（`createChatControlService({ runtime: <fabricated> })`）而不使用注入实例，且 import 由 `import type` 改为值导入。变异 diff 位于 `sendClaimedMessage`：
```
-    const result = await control.send(
+    const ownControl = createChatControlService({ runtime: { hasRuntime: () => true, run: async () => undefined } as never });
+    const result = await ownControl.send(
       { userId: row.user_id, via: 'scheduled' }, ...);
```
逐字失败行：
```
✖ (a)/(b) the WebSocket three frames and a scheduled due send reach the same control service
  AssertionError [ERR_ASSERTION]: the scheduled pass must call the same spy exactly once
    actual: 0, expected: 1
```
恢复：`git checkout -- server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts`；重跑绿。

(iii) 变异：到点发送入口 `dispatchDueScheduledMessages` 自持一个控制服务实例（WS 侧仍持 spy）——即两个消费者各持一实例。变异 diff：
```
+  const ownControl = createChatControlService({ runtime: { hasRuntime: () => true, run: async () => undefined } as never });
   for (const row of due) {
-    await sendClaimedMessage(row, control);
+    await sendClaimedMessage(row, ownControl);
```
逐字失败行：
```
✖ (a)/(b) ... AssertionError [ERR_ASSERTION]: the scheduled pass must call the same spy exactly once
    actual: 0, expected: 1
```
恢复：`git checkout -- server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts`；重跑绿。

### AC-237 迁移登记（item 7）
分发器换缝迫使 `server/modules/scheduled-messages/tests/scheduled-messages.test.ts` 的假替身改形，逐条移植项（旧缝 → 新缝，断言强度逐条不变）：
1. 旧：`createRuntime(runs, behaviour, aborts)` 返回一个假 **runtime 网关**，交给 `dispatchDueScheduledMessages(runtime)`／`dispatchQueuedMessages(runtime)`。新：`createControl(runs, behaviour, aborts)` 用**同一个假 runtime** 包一层**真** `createChatControlService({ runtime })`，交给同样两个入口。调用点仅函数名 `createRuntime(` → `createControl(`。
2. `runs`（`{provider, command, options}`）：不变——真 `dispatchRun` 仍以同样的 4 参调 `runtime.run`，假 runtime 仍记录同形状。
3. `aborts`（被 abort 的 sessionId 数组）：不变——到点发送的打断语义仍由控制服务的 `interruptActiveRun` 分支调用 `runtime.abort` 达成。
4. 「provider 失败登记」：不变——控制服务 `send` 新增的 `completion`（provider 回合自身的结果）由分发器 await，正是旧 `runDetachedChatTurn` 持有的同一屏障，`markFailed('provider exploded')` 仍触发。
5. 草稿清理／还原、`markFailed`、状态流转（`sent`/`failed`/`cancelled`/`pending`）：逐字未改；`dispatchQueuedMessages` 的忙时预检与 `RUN_IN_PROGRESS` 还原语义保留。
未删除或放宽任何断言；该文件在 17 文件集合里通过（见 AC9）。

### AC9 不回归与仓库门
- AC-237 的 17 文件集合（含迁移后的 `scheduled-messages.test.ts`）：`npx tsx --tsconfig server/tsconfig.json --test <17 files>` → `tests 111 / pass 111 / fail 0`。
- 另跑控制服务判据 `chat-control-wiring`/`chat-control-send`/`chat-control-busy`/`chat-control-access` 与 `debug-agent-control-queue`：`21 / pass 21 / fail 0`（AC-232、AC-230 的既有判据逐字通过，未迁移）。
- `npx tsc -p server/tsconfig.json --noEmit` → exit 0。
- `npm run lint` → `: error ` 计数 0（仅 warning）。
- 跨模块只经 barrel：新判据经 `@/modules/scheduled-messages/index.js` 导入 `dispatchDueScheduledMessages`（该 barrel 新增该导出，带消费方注释），无深导入；`npm run lint` 的 `boundaries/dependencies` 无 error。

### AC10 对齐
`git diff --stat develop...HEAD`：
```
 server/index.ts                                    |  15 +-
 server/modules/scheduled-messages/index.ts         |   7 +
 .../services/scheduled-message-dispatcher.service.ts |  80 ++--
 .../tests/scheduled-messages.test.ts               |  68 ++--
 server/modules/websocket/index.ts                  |   9 +-
 server/modules/websocket/services/chat-control.service.ts |  80 +++-
 server/modules/websocket/services/chat-websocket.service.ts | 298 +++++++-------
 server/modules/websocket/tests/chat-control-wiring.test.ts  | 447 ++++++++++ (new)
 8 files changed, 799 insertions(+), 205 deletions(-)
```
与 `## Touches` 逐条一致（`tasks/gap-ac233-control-single-instance-wiring.md` 由 task_write 提交在任务库，不在分支 diff 内，符合既有机制）。

### 设计说明与边界
- `SendInput` 增加可选 `connection`：控制服务保持与传输无关、不发帧，但把请求 socket 作为运行的 connection 交给 `dispatchRun`（与 `ws` 错误上报解耦），否则经控制服务派发的 `chat.send` 运行不再流向请求它的客户端。经此，AC-237 的按次进程逐帧一致性判据基线比对通过。
- `SendResult.ok:true` 增加 `completion`：`send` 仍在登记后立即返回（AC-230 不变），但把运行自身的结果交给需要报告失败（scheduled `markFailed`）的调用方。
- `ChatWebSocketDependencies.control` 为可选：生产装配点显式提供唯一实例；既有以 `{ runtime }` 驱动网关的十余个 harness 由 `resolveChatControl` 在同一次连接内解析出**一个**控制服务（同 runtime），使其行为不变。`server/index.ts` 只有一个构造点。
- `runDetachedChatTurn` 删除（`server/modules/websocket/index.ts` 的对应导出一并移除）：分发器直接调用共享的 `send`。
- `abort` 在控制服务内、紧随 provider 应答发射终止 `complete`（与旧内联 handler 同一回合），以保持 codex 等 in-process 生成器释放时的「恰好一个 complete / aborted 语义」与基线一致；「无活动运行」的判定仍在 WS handler 侧先行（其对 registry 的读与旧实现同位置，避免与控制服务异步边界竞态）。
- 边界差异：`chat.cancel-queued` 对**会话不存在**的输入，现返回 `queued_input_cancel_result{result:'unknown'}`（AC-232 固定的 `HostQueuedInputCancelResult | 'forbidden'` 契约不含 `SESSION_NOT_FOUND`），旧为 `protocol_error{SESSION_NOT_FOUND}`；无既有判据依赖该帧，其余字段/文案不变。
- 未实现 AC-234/235/236；未改协议与 `chat.subscribe` 帧序。

### 本轮（suite-red 修复）：`chat.send` 拒绝帧恢复同 tick 发射
本轮 fan-in 全量 suite 唯一红：`server/modules/providers/tests/claude-resident-busy-input.test.ts`，`AssertionError [ERR_ASSERTION]: the positive control: a per-run session must still refuse a busy send (got null)`，期望 `'RUN_IN_PROGRESS'`（读数行 `withdrawnSendRefusal=null perRunBusyCode=null`）。

根因：旧 `handleChatSend` 走 `await dispatchRun(ws, …)`，而 `dispatchRun` 的 `RUN_IN_PROGRESS` 拒绝分支在**其首个 `await` 之前**同步写帧，所以该帧在 `socket.emit('message')` 返回时已落在 socket 上（该判据 `send()` 帮手同步读取拒绝码）。改经 `control.send` 后，拒绝决定被推过至少一个微任务，帧晚到，同步读得 `null`；该判据其余读数（accepted 分支的 `roundOneRefusal`/`busySends`/`withdrawnSendRefusal` 为 null）与全量 suite 的其余 355 项均不受影响。

修法（行为保全；控制服务仍 transport-free——它只做通知、不构造帧、不发帧）：`SendInput` 增可选 `onRefuse?: (refusal: { code; message }) => void`；`send` 在三处同步早退（`FORBIDDEN` / `SESSION_NOT_FOUND` / `UNSUPPORTED_PROVIDER`）与 `dispatchRun` 的 `RUN_IN_PROGRESS` 分支（给 `dispatchRun` 增可选 `onRefuse` 形参）调用它；`handleChatSend` 传入回调并以 `refusedSync` 去重，使拒绝帧恢复同一 tick 发射（与 develop 旧内联处理器同刻）。每个拒绝都在首个 `await` 之前同步判定，故通知确为真同步。三个处理器函数体仍无 `dispatchRun`/`.abort(`/`.cancelQueuedInput(`，假 runtime 仍零直触（判据 (a)/(c) 逐字不变）。

验证：
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-busy-input.test.ts` → `pass 1 / fail 0`，`[readings] perRunBusyCode=RUN_IN_PROGRESS`（修复前同一命令 `fail 1`，`perRunBusyCode=null`）。
- `server/modules/websocket/tests/*.test.ts` + `server/modules/scheduled-messages/tests/*.test.ts` → `101 / pass 101 / fail 0`；`claude-resident-*.test.ts` → `27 / pass 27 / fail 0`；`chat-control-*` / `chat-stop-task` / `chat-background-task` / `chat-control-ownership` / `scheduled-messages` 合跑 `45 / pass 45 / fail 0`。
- scoped 门 `bash scripts/test.sh --for-task gap-ac233-control-single-instance-wiring --allow-thin` → `2 / pass 2 / fail 0`；scoped-gate 缓存已写（developSha `54ba0f80…`）。
- `npx tsc -p server/tsconfig.json --noEmit` → exit 0；`npm run lint` → `: error ` 计数 0。
- 只改 `## Touches` 内两文件（`chat-control.service.ts`、`chat-websocket.service.ts`），无新增文件；提交 `5cc59b4a`。
