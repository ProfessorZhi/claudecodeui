---
id: gap-ac231-control-busy-queue-cancel
title: AC-231 控制服务忙会话语义：常驻会话忙时排队并返回驱动交出的可撤回 queuedMessageUuid，按次进程忙时
  RUN_IN_PROGRESS，cancelQueued 用同一 uuid 撤回、未知 uuid 得 unknown；判据
  server/modules/websocket/tests/chat-control-busy.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac230-control-send-immediate-runid
goal_ac: AC-231
---
## Proposal

AC-231（GOAL-019 退出条件 2；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「ChatControlService」要点 2、决策 D5）要求控制服务的忙会话语义与 UI 完全一致：常驻会话（`acceptsBusyInput` 为真）正忙时再 `send`，走 CLI 自己的队列——返回 `ok: true`、`queued: true`、非空 `queuedMessageUuid`，并新开一个被取代的第二个运行，两个运行都按各自 id 可查；按次进程会话（`acceptsBusyInput` 为假）正忙时 `send` 返回 `ok: false`、`code: RUN_IN_PROGRESS`，不登记第二次运行也不调用驱动；`cancelQueued` 用返回的那个 uuid 撤回排队消息得到 `cancelled`，用一个从未返回过的 uuid 得到 `unknown`。

前置：本任务建立在 `gap-ac230-control-send-immediate-runid` 之上——该任务创建 `server/modules/websocket/services/chat-control.service.ts`、把 `chat-websocket.service.ts` 的 `dispatchRun` 导出，并交付非忙语义的 `send`（`{ ok: true; runId }`，失败返回稳定错误码，不构造 socket）。本任务在同一个文件上补齐忙时分支与 `cancelQueued`，并扩展判据。

现状（红态基线）：判据文件 `server/modules/websocket/tests/chat-control-busy.test.ts` 不存在，判据的存在性闸以退出码 1 输出缺失的文件名。`chat-control.service.ts` 在 gap-ac230 完成前不存在。

要交付：

1. `ChatControlService.send` 忙时分支（`chat-control.service.ts`）。沿用 `dispatchRun`：`send` 走与 `chat.send` 同一条登记/分发路径（`startRun` → 注册表拒绝 → `acceptsBusyInput` 为真时 `startRun({ …, supersedeRunning: true })` 开新运行）。`dispatchRun` 需把「本次是否走了 `acceptsBusyInput` 重试（supersede）路径」这一事实交给 `send`——在 `beforeRun(run)` 的第二参（如 `beforeRun(run, { busyAccepted })`）上按附加字段给出，**不改**既有 `chat.send` 的 `beforeRun` 调用行为。当 `busyAccepted` 为真：`send` 取得该条排队消息的 uuid（第 2 条），返回 `{ ok: true, runId, queued: true, queuedMessageUuid }`，`queuedMessageUuid` 为非空字符串；运行本身在后台继续。运行被拒（`acceptsBusyInput` 为假，或注册表拒绝）时维持 gap-ac230 的结果：`{ ok: false, code: 'RUN_IN_PROGRESS', message }`，此时注册表里没有第二次运行，且 `runtime.run` 一次都未被调用（该拒发先于 `beforeRun` 发生）。

2. 排队消息 uuid 的「驱动 → 调用方」交接缝（SPEC 未核实项 5，本 goal 唯一依赖实现探索的点）。给 `ProviderRuntimeGateway`（`chat-websocket.service.ts`）增加一个**可选**动词 `queuedInputUuid(provider, sessionId): Promise<string | null>`：常驻驱动把自己的队列认得的那个 uuid（`cancelQueuedInput` 认的正是它）在写入队列后 resolve 出来；缺省/未实现读作 `null`，保守——绝不把「没有交出 uuid」读成「排队成功且 uuid 为空」。`send` 只在 `busyAccepted` 分支 await 它（有界），拿不到 uuid 时返回 `queued: true` 且 `queuedMessageUuid: null`（保守降级，判据 (a) 用的是会交出 uuid 的假运行时）。**真实网关装配与真实驱动侧的交接**（`provider-runtime.service.ts` 的实现面、真实 Claude 驱动的 `cancel_async_message` 语义）不在本任务范围：SPEC 非目标已声明不改真实驱动的 `cancel_async_message`；调试 agent 常驻驱动经控制服务的排队/撤回由 AC-238 覆盖，真实 Claude 的排队/撤回只由既有真实 CLI 测试与后续人工门覆盖。

3. `ChatControlService.cancelQueued(caller, { sessionId, messageUuid })`（`chat-control.service.ts`）。先过与其它控制动作**同一个**访问入口 `assertSessionAccess`（未认证返回 `'forbidden'`，不碰驱动；FORBIDDEN 的判据归 AC-232）；随后经 `runtime.cancelQueuedInput?.(provider, sessionId, messageUuid)`，缺省读作 `'unknown'`（沿用 `handleChatCancelQueued` 的既有读法），驱动的判决原样透传。**不改** `handleChatCancelQueued` 的协议行为（归 AC-233 的适配层改造）。

4. 运行按各自 id 可查（判据 (a) 的支撑）。`chatRunRegistry` 增加最小 by-id 索引 `Map<runId, ChatRun>` 与 `getRunById(runId): ChatRun | undefined`，使被取代的第一个运行与新开的第二个运行都按各自 id 查到。保留期、运行摘要、`expired`/`unknown` 结果、被中止运行记 `aborted`，以及 `getRun(sessionId)` 的「每个会话一个当前运行」不变式，均归后续任务 AC-235；本任务只加最小索引，不改注册表既有映射语义。

5. 判据 `server/modules/websocket/tests/chat-control-busy.test.ts`（红先行；复用 gap-ac230 判据的注入式形态——临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入假运行时——**不构造任何 socket、不用事件发射器**）。假运行时（实现 `ProviderRuntimeGateway`）：`hasRuntime` 真、`acceptsBusyInput` 布尔可控、`cancelQueuedInput` 从自己的假队列删除该 uuid 并回 `'cancelled'`（队列里没有则回 `'unknown'`）、`run` 被一个可控延迟对象卡住（使第一个运行保持 running）并在被调用时把消息 uuid 记入假队列、`queuedInputUuid` 交出该 uuid。读数：
   (a) 常驻形态（`acceptsBusyInput` 真）正忙时再 `send`：返回 `ok: true`、`queued: true`、`queuedMessageUuid` 为非空字符串；产生与第一次不同的第二个 `runId`；`chatRunRegistry.getRunById(runId1)` 与 `getRunById(runId2)` 各命中（写下两个返回与两条 getRunById 读数）。
   (b) 用该 uuid 调 `cancelQueued`：得到 `'cancelled'`，且假队列里这条消息确实被移除（读假队列前后两次）。
   (c) 按次形态（`acceptsBusyInput` 假）正忙时再 `send`：返回 `ok: false`、`code: 'RUN_IN_PROGRESS'`；假运行时 `run` 调用计数不增；`getRunById` 里不存在第二个运行（写下三项读数）。
   (d) 用一个从未返回过的 uuid 调 `cancelQueued`：得到 `'unknown'`（写下返回与假队列未变读数）。

6. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 忙时一律拒绝（不查 `acceptsBusyInput`）⇒ (a) 必须红；(ii) 忙时一律排队（不查 `acceptsBusyInput`）⇒ (c) 必须红；(iii) `send` 返回自造的 `randomUUID()` 而不是驱动交出的 uuid ⇒ (b) 必须红；(iv) `cancelQueued` 对任何 uuid 都回 `'cancelled'` ⇒ (d) 必须红。

边界：不实现 `editSend`/`abort`/`stopTask`/`backgroundTask`/`answerApproval`/`pendingApprovals`（归其它 AC）；不做 `server/index.ts` 单实例装配、不改 `chat.send`/`chat.cancel-queued` 处理器走向（归 AC-233）；不加 `ChatRunSource` 的 `mcp`（归 AC-234）；不实现运行保留期、摘要、`expired`（归 AC-235）；不实现真实网关/驱动的排队 uuid 交接（归 AC-238 与真实驱动任务）；不给 `websocket/index.ts` 加无跨文件消费者的 barrel 导出；不改 WebSocket 协议与 `chat.subscribe` 帧序列；不构造 socket。

判定纪律：`send` 不构造 socket、不发帧；忙时排队与按次拒绝用 `acceptsBusyInput` 的布尔读数区分；返回的 uuid 必须是驱动队列认得的那个（判据 (b)(iii) 证明这一点），不是控制服务自造的随机 id；改动的 `chat-websocket.service.ts` 与 `chat-run-registry.service.ts` 不影响既有判据。

## AC

- [x] AC1 判据绿：`for f in server/modules/websocket/tests/chat-control-busy.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-busy.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-busy.test.ts`）。
- [x] AC2 (a) 常驻忙时排队并产生第二个可查运行：`acceptsBusyInput` 为真、第一个运行仍 running 时再 `send`，返回 `ok:true`、`queued:true`、`queuedMessageUuid` 为非空字符串；第二个 `runId` 与第一次不同；`chatRunRegistry.getRunById(runId1)` 与 `getRunById(runId2)` 均命中（写下两个返回与两条 getRunById 读数）。
- [x] AC3 (b) 撤回用的就是返回的那个 uuid：用 AC2 的 uuid 调 `cancelQueued` 得到 `'cancelled'`，且假运行时的假队列里该 uuid 确实被移除（写下返回值与移除前后的队列读数）。
- [x] AC4 (c) 按次进程忙时被拒：`acceptsBusyInput` 为假、第一个运行仍 running 时再 `send`，返回 `ok:false`、`code:'RUN_IN_PROGRESS'`；假运行时 `run` 调用计数不增；`getRunById` 里不存在第二个运行（写下三项读数）。
- [x] AC5 (d) 未知 uuid 得 unknown：用一个从未返回过的 uuid 调 `cancelQueued` 得到 `'unknown'` 而不是 `'cancelled'`（写下返回值与假队列未变读数）。
- [x] AC6 无 WebSocket 参与：写下用于核对的 grep 命令与空输出——判据文件不 import `ws`、不 `new WebSocket(`、不构造 socket；AC2–AC5 全部读数在该文件内无 socket 完成。
- [x] AC7 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 忙时一律拒绝 ⇒ AC2 红；(ii) 忙时一律排队 ⇒ AC4 红；(iii) `send` 返回自造 uuid ⇒ AC3 红；(iv) `cancelQueued` 对任何 uuid 都回 `cancelled` ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 不回归与仓库门：既有 WebSocket 判据保持逐字通过——至少 `chat-control-ownership.test.ts`、`chat-control-send.test.ts`、`chat-edit-send.test.ts`、`chat-run-registry.test.ts`、`chat-background-task.test.ts`（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级，写明计数）；控制服务跨模块只经 barrel 导入、无深导入。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 常驻会话忙时第二次 `send` 真的走了 CLI 自己的队列路径，并拿到驱动交出的 uuid；该 uuid 就是 `cancelQueued` 撤回后从假队列消失的那条；按次会话忙时真的被拒且驱动一次没被碰——三段读数均由判据实测，不是「实现看起来对」。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；判据不构造任何 socket。
- 排队消息 uuid 由驱动交出（可选 `queuedInputUuid` 网关缝），不是控制服务自造的随机 id；缝缺失时保守返回 `null`，绝不假装排队成功。
- `send` 与 `chat.send` 走同一条登记/分发路径（共用 `dispatchRun`），不是第二份注册逻辑；遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号）；不越界实现其它 AC 的范围（见边界）；不改协议与既有判据。

## Touches

- server/modules/websocket/services/chat-control.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/tests/chat-control-busy.test.ts (new)
- tasks/gap-ac231-control-busy-queue-cancel.md

## Evidence

AC1 红态基线：判据文件不存在时，存在性闸逐字输出 `缺判据文件：server/modules/websocket/tests/chat-control-busy.test.ts`、退出码 1。实现提交 `2db6ce93`（后经两次 develop 合并）。绿态：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-busy.test.ts` 退出 0（`ℹ tests 5 / pass 5 / fail 0`）。

AC2 读数：`(a) firstSend={"ok":true,"runId":"fd688552-...","queued":false,"queuedMessageUuid":null} secondSend={"ok":true,"runId":"5e3411ab-...","queued":true,"queuedMessageUuid":"0fde30ac-..."} queue=["4bd9a8e3-...","0fde30ac-..."]`；`(a) getRunById(runId1)={"runId":"fd688552-...","status":"running"} getRunById(runId2)={"runId":"5e3411ab-...","status":"running"}`。第二次运行 id 与第一次不同，两条 getRunById 均命中。

AC3 读数：`(b) uuid=ad9f3795-... verdict=cancelled before=["4ac43a5a-...","ad9f3795-..."] after=["4ac43a5a-..."]`——撤回用的正是 (a) 交出的 uuid，且假队列里该条被移除。

AC4 读数：`(c) secondSend={"ok":false,"code":"RUN_IN_PROGRESS","message":"Session \"control-busy-session\" already has a run in progress."} runCallsBefore=1 runCallsAfter=1 currentRunId=9ff76deb-... runningForSession=1 getRunById(runId1)=9ff76deb-...`——驱动 run 计数不增、无第二个运行。

AC5 读数：`(d) neverUuid=35fce5be-... verdict=unknown before=["416a783a-...","af97887a-..."] after=["416a783a-...","af97887a-..."]`——未知 uuid 得 unknown，队列未变。

AC6 读数：`grep -nE "from ['\"]ws['\"]|new WebSocket\(|new EventEmitter\(|require\(['\"]ws['\"]\)" server/modules/websocket/tests/chat-control-busy.test.ts` 无输出（退出 1，即无匹配）；判据内静态守卫实测 `(e) socketReferences=[]`。

AC7 取假形态（先提交实现 `2db6ce93`；逐条变异 → 必红 → `git checkout --` 恢复 → 重跑绿）：
- (i) 变异：`chat-websocket.service.ts` 的 `if (!run && dependencies.runtime.acceptsBusyInput?.(provider, sessionId)) {` → `if (!run && false) {`。逐字失败行：`✖ (a) a resident busy session queues the second send and mints a second queryable run (286.149697ms)` + `  AssertionError [ERR_ASSERTION]: the busy send must be queued, not refused (got {"ok":false,"code":"RUN_IN_PROGRESS","message":"Session \"control-busy-session\" already has a run in progress."})`。恢复：`git checkout -- server/modules/websocket/services/chat-websocket.service.ts`；恢复后 5 pass。
- (ii) 变异：同处 → `if (!run) {`。逐字失败行：`✖ (c) a per-run busy session is refused without touching the provider (259.68038ms)` + `  AssertionError [ERR_ASSERTION]: a per-run busy session refuses the second send`。恢复同上；恢复后 5 pass。
- (iii) 变异：`chat-control.service.ts` 的 `const queuedMessageUuid = await readQueuedMessageUuid(deps.runtime, provider, input.sessionId);` → `const queuedMessageUuid = randomUUID();`（并加 `import { randomUUID } from 'node:crypto';`）。逐字失败行：`✖ (b) cancelQueued withdraws exactly the uuid the provider handed over (404.907709ms)` + `  AssertionError [ERR_ASSERTION]: the queued message must be withdrawable by the returned uuid`。恢复：`git checkout -- server/modules/websocket/services/chat-control.service.ts`；恢复后 5 pass。
- (iv) 变异：`chat-control.service.ts` 的 `cancelQueued` 驱动判决透传 → `return 'cancelled';`。逐字失败行：`✖ (d) an unknown uuid answers unknown, not cancelled (424.192841ms)` + `  AssertionError [ERR_ASSERTION]: an id the provider never queued cannot be withdrawn`。恢复同上；恢复后 5 pass。

AC8 不回归与仓库门：
- 既有 WebSocket 判据（各自 `npx tsx --tsconfig server/tsconfig.json --test <file>`）：`chat-control-ownership.test.ts` 4/4、`chat-control-send.test.ts` 4/4、`chat-edit-send.test.ts` 8/8、`chat-run-registry.test.ts` 12/12、`chat-background-task.test.ts` 6/6，fail 全 0。
- `npm run typecheck` 退出 0。
- `npm run lint` 退出 0；`: error ` 计数 0。
- 控制服务跨模块导入仅经 barrel：`@/modules/database/index.js`、`@/shared/types.js`；websocket 模块内符号经同模块 `services/` 路径，非跨模块深导入。

AC9 对齐：`git diff --stat develop...HEAD` ⇒
`server/modules/websocket/services/chat-control.service.ts | 132 ++++++-`、
`server/modules/websocket/services/chat-run-registry.service.ts | 34 +++`、
`server/modules/websocket/services/chat-websocket.service.ts | 37 ++-`、
`server/modules/websocket/tests/chat-control-busy.test.ts | 337 ++++ (new)`。
与 `## Touches` 逐条一致（task 文件本身由 task_write 提交）。

scoped 门（driver fan-in 同款）：`bash scripts/test.sh --for-task gap-ac231-control-busy-queue-cancel --allow-thin` 退出 0（1 file / 1 pass / 0 fail）；scoped-gate 缓存以 develop `26903a7f` 记录。

边界遵守：未实现其余控制动词；未改 `server/index.ts` 装配、`chat.send`/`chat.cancel-queued` 处理器走向、barrel 导出、`ChatRunSource`、运行保留期/摘要、真实网关/驱动的排队 uuid 交接、WebSocket 协议与 `chat.subscribe` 帧序列。
