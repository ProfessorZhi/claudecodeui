---
id: gap-claude-resident-busy-input
title: AC-163 忙时输入与 CLI 一致 — resident 会话忙时 chat.send 不返回
  RUN_IN_PROGRESS、消息带服务端分配 uuid 与 priority=later 立即写入进程 stdin（写入时刻早于当前轮
  result）并归入其后另起一轮的 run 不丢，撤回按 command_lifecycle 的 cancelled 事件判定（不读
  control_response）；五条假形态（服务端排队到轮末 / 返回 RUN_IN_PROGRESS / 撤回只在前端隐藏 / 以控制响应判成败 /
  等 session_state_changed）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
  - gap-claude-resident-unattended-turn
goal_ac: AC-163
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-163" tasks/*.md | wc -l` → **0**；`grep -rln "AC-163" tasks/*.md | wc -l` → **0** —— 不是"未认领"，是**全库零命中**（连邻居任务的非目标段都没点过名）。代码侧：`grep -rn "cancel_async_message\|command_uuid" server/ src/ --include=*.ts --include=*.tsx | wc -l` → **0**；`grep -rn "inputWhileBusy\|cancelQueuedInput" server/ src/ --include=*.ts --include=*.tsx | wc -l` → **0**（proposal §5 `:256-262` 预留的能力位在代码里一行都没有）；`ls server/modules/providers/list/claude/ | grep host-driver` → 只有 `claude-per-run-host-driver.provider.ts`，**无** resident driver。⇒ AC-163 无认领者，本条不是重复。

**两条真前置（已写成关系边，非仅散文）**：`gap-claude-resident-process-survival`（AC-161，`todo`）落 resident driver —— 一个不结束的输入队列、stdin 由服务端握着、轮次边界以 `system/init` 与 `result` 切分；**没有它就没有"忙时写入的那个进程 stdin"**。`gap-claude-resident-unattended-turn`（AC-162，`todo`）落无人轮的 run 建立 —— AC-163 判据 (1) 的"无人轮进行中"那一腿要有真的无人轮在跑，判据 (3) 的"被记入那一轮的 run"在无人轮那一腿上读取的正是它建的 run。两条都是**真前置**，故 `depends_on` 逐字列出（关系边存在，散文点名安全）；它们与本条机制不同（一个跨轮存活、一个无人轮触发与 run 落地），本条认证的是**忙时输入进 CLI 自己的命令队列 + 出队前撤回**，是本条独有的机制。proposal 阶段划分同属**阶段 3**（`docs/proposals/claude-resident-sessions.md:699`：「无人轮进入 run 注册表与通知；按 E2/E3/E9 的结论落地忙时输入与撤回」）。

**来源与判据物。** 判据逐字取自 `goals/AC-163-忙时输入与-claude-code-cli-一致-不拒绝-不在服务端排队-消息归入-cli-实际给出的那一轮.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-busy-input.test.ts`（命令逐字含文件路径，不用 glob）。**基线已经由人签过字**，本条不重测：`docs/proposals/claude-resident-sessions-experiments.md:49` 逐字有「E2/E3 基准确认：沿用 CLI 行为（两条形态实测一致——busy 时推入的第二条消息另起一轮、不并入当前轮、未丢失；无人轮进行中推入同样另起一轮）」（人 yale 2026-09-26 指示写入）。⇒ 判据**不需要**再跑交互式 CLI 那一半，只需要在 stream-json 形态上把"服务端这一侧写什么、什么时候写、撤回怎么判"钉死。

**红态基线（本轮直跑，读数不是推断）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-busy-input.test.ts` → 退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-busy-input.test.ts'`。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts` → 退出 **0**，读数 `tests 7 / pass 7 / fail 0 / duration_ms 2348.35` ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮实测的读数）—— 忙时输入这一格今天的行为恰好是 AC 的假形态 (b)**

- **忙时 `chat.send` 今天被拒绝**：`server/modules/websocket/services/chat-websocket.service.ts:240` 在 `chatRunRegistry.startRun(...)` 返回 `null` 时发 `RUN_IN_PROGRESS`；而 `server/modules/websocket/services/chat-run-registry.service.ts:196-198` 在"该会话已有 running 的 run"时**就是返回 `null`**。⇒ 今天 run 进行中再发一次 `chat.send`，服务端**必返 `RUN_IN_PROGRESS`**——正是 AC 假形态 (b) 要红的那个行为面。
- **没有可写的进程**：resident driver 不存在（上段 `ls` 读数）；per-run driver 的 `reconfigure()` 恒返回 `'next-turn'`（`claude-per-run-host-driver.provider.ts:327-328`），`closeHost()` 对非 `turn-complete`/`released` 的原因一律 `stopQuery()`（`:356-366`）——两轮之间没有活着的进程，也就没有"立即写入 stdin"这回事。
- **claude 的能力声明还不含 resident**：`provider-capabilities.service.ts:79` claude 的 `lifecycleModes: ['per-run']`。本条的分派按 `sessions.lifecycle_mode === 'resident'` 走（AC-161 落的列），**不**依赖 `residentFeatures` 能力位——那一格（`inputWhileBusy` / `cancelQueuedInput`，proposal §5 `:261-262`）属能力矩阵任务（AC-169）的范围，本条不侵占。
- **SDK 0.3.165 的两个形状都在位**（本条要用）：`SDKUserMessage` 有 `priority?: 'now' | 'next' | 'later'` 与 `uuid?: UUID`（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3821`、`:3837`；E9 实测宿主分配的 uuid 就是 CLI 的 `command_uuid`）；`SDKControlCancelAsyncMessageRequest = { subtype: 'cancel_async_message'; message_uuid: string }`（`sdk.d.ts:2747-2750`）。**后者不在 `Query` 接口上**（本轮核 `Query` 的方法表：只有 interrupt / setPermissionMode / setModel / setMaxThinkingTokens / applyFlagSettings / stopTask / streamInput / rewindFiles / …），所以控制帧必须**自己写 stdin 原文**，与 E9 的取数方式一致。
- **E9 读数（原样，出自记录文件 §9.1/§9.2）**：轮次边界两条驱动都**没有** `session_state_changed`（各 0 条），可用把手是「每轮一条 `system/init` + 轮末一条 `result`」；三档 `now`/`next`/`later` **都**进 `command_lifecycle` 队列（`queued → started → completed`），`now` 出队排在 `later` 之前，**三档都不并入当前轮**；`cancel_async_message` 在"仍在队列里 / 已被处理完 / uuid 不存在"**三种时机都没有 `control_response`**，但排队中撤掉的那条确实发 `state=cancelled` 且其文本再没进任何一轮请求；轮次归属实读 `later→第 6 次真 agent 轮`、`now→第 5 次`、`next→没读到`（**缺口**，本条不对 `next` 作断言）。真 agent 轮识别按请求体 `bytes > 10KB`（每轮会先发一条约 2KB 的预检请求）。

**要建的东西（范围是 AC-163 的最小充分集）**

1. **driver 的写入面**（`claude-host-driver.provider.ts`，AC-161 落地的文件）—— `submit(sessionId, content)`：给每条消息**服务端分配 uuid**，往进程 stdin 写一帧 `{ type: 'user', uuid, priority: 'later', message: { role: 'user', content } }`。**不论当前忙闲一律立即写**，服务端**不排队**（原则 6、proposal §8 `:325`）；`priority: 'later'` = 排在当前轮之后，复现交互式 CLI 的忙时行为（§8 `:330`）。
2. **`command_lifecycle` 事件的解析** —— 从 CLI 输出流读 `state`（`queued` / `started` / `cancelled` / `completed`）与 `command_uuid`，供判据 (2) 的 uuid 对账与 (4) 的撤回判定。轮次边界**只用**每轮 `system/init` 与轮末 `result`，**不等** `session_state_changed`（E9 9.1；假形态 (e) 在这一层承重）。
3. **忙时 `chat.send` 的路由** —— resident 会话在 run 进行中收到 `chat.send` 时**不**走 `startRun`-null 那条分支（`chat-websocket.service.ts:236-243`），直接 submit，**不返回 `RUN_IN_PROGRESS`**；消息按 CLI 实际给出的轮次边界归入**其后另起的那一轮**的 run（判据 (3)）。per-run 会话路径**逐字不变**（仍走今天的 `RUN_IN_PROGRESS` 分支）。
4. **撤回入口** —— 新 WS verb（暂定 `chat.cancel-queued`，**名字可实现者定，语义由 AC 钉死**；`chat-websocket.service.ts:640-655` 的 switch 里加一格）：对 resident 宿主写控制帧 `{ type: 'control_request', request: { subtype: 'cancel_async_message', message_uuid } }`；**成败只看 `command_lifecycle` 的 `state=cancelled`**：读到该 uuid 的 cancelled ⇒ 返回「已撤回」；没读到 ⇒ 返回可辨的「已开始处理」（进程无副作用）。**绝不读 `control_response`**（E9：三种时机都没有；假形态 (d) 在这一层承重）。
5. **判据文件** `server/modules/providers/tests/claude-resident-busy-input.test.ts` —— 形状照 AC-025 的 `model-gateway-end-to-end.test.ts`（真实 `claude` 二进制 + mock Anthropic 兼容端点 + 临时 `DATABASE_PATH` + 经 `handleChatConnection` 的真 `chat.send`；mock **拖住响应**造出忙），轮次识别按请求体 `bytes > 10KB`。
6. **收尾** —— `npm run typecheck`、`npm run lint` 退出 0；既有 per-run 判据（`claude-host-per-run.test.ts`、`claude-background-work.test.ts`、`passthrough-parity.test.ts`）逐字不变且仍绿。

**五条假形态全部要在判据文件里承重**（AC 逐字指定，(a)–(e)）；每条照 `model-gateway-end-to-end.test.ts:211` 的 `(b-fake)` 形状写成一臂（在判据内构造该假行为，断言对应读数**确实变红**）：(a) 服务端自己排队到当前轮 `result` 之后才写入 ⇒ (2) 的写入时刻读数红；(b) 忙时返回 `RUN_IN_PROGRESS` ⇒ (1) 红；(c) 撤回只在前端隐藏、不发 `cancel_async_message` ⇒ 无 cancelled 事件且消息仍产生一轮 ⇒ (4) 红；(d) 以 `control_response` 的到达判撤回成败 ⇒ 撤回成功也读成失败 ⇒ (4) 红；(e) 等 `session_state_changed` 才切分轮次 ⇒ 读不到轮边界 ⇒ (3) 红。

## Plan

1. **前置门与读回**：`task_get` 两条 `depends_on`（`gap-claude-resident-process-survival`、`gap-claude-resident-unattended-turn`）必须 `done`。resident driver 未落地则**停在登记处**，不自行造第二份 driver；无人轮的 run 建立未落地则判据 (1) 的第二腿与 (3) 的无人轮归属无法读数。
2. **driver 写入面（先不接线）**：输入队列 + 服务端 uuid 分配 + `priority: 'later'` 帧写 stdin。先用**伪造 SDK 流**证明"帧立即写出、不等 `result`"，把假形态 (a) 在这一层先红出来（照 AC-161 计划第 2 步的办法，先在伪造流层面红，再上真二进制）。
3. **`command_lifecycle` 与轮次边界**：解析 `queued/started/cancelled/completed` + `command_uuid`；轮次边界取 `system/init` / `result`。假形态 (e) 在这一层先红。
4. **忙时路由**：`chat.send` 对 resident 会话忙时改走 submit；per-run 逐字不变（跑 `claude-host-per-run.test.ts` 确认未动）。
5. **撤回**：WS verb + 写 `cancel_async_message` 控制帧 + 以 cancelled 事件判成败。假形态 (c)/(d) 在这一层先红。
6. **判据文件**：真二进制 + mock 拖住 + 两腿 busy send（用户轮 / 无人轮）+ 撤回两时机（队列中 / 已出队）+ 五条假形态各一臂；先把红态与五条假形态红态实测一遍再接线。
7. **收尾**：`npm run typecheck`、`npm run lint` 退出 0；既有三条 per-run 判据逐条退出 0 且文件一字不改；写完成记录（含每条读数与假形态实测的退出码/红文案）。

## AC

- [x] 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-busy-input.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`。红态基线（本轮直跑）：同命令退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-busy-input.test.ts'`；同命令形状跑既有 `…/claude-host-per-run.test.ts` 退出 **0**（`tests 7 / pass 7 / fail 0 / duration_ms 2348.35`）⇒ 红只因判据文件不存在。命令逐字含文件路径，不用 glob。
- [x] 真实链路：判据里用**真实** `claude` 二进制 + mock Anthropic 兼容端点（临时 `DATABASE_PATH`），mock **拖住响应**造出忙；真 agent 轮按请求体 **`bytes > 10KB`** 识别（**不按序号、也不按请求里有无用户文本**——每轮会先发一条约 2KB 的预检请求）；打印逐次请求体量 `bytesPerTurn=[…] realTurns=<n>`。
- [x] (1) 两腿都不拒：**用户轮进行中**与**无人轮进行中**各发一次真 `chat.send`，两次都**不**返回 `RUN_IN_PROGRESS`（打印 `busySends=[{leg:'user',code:null},{leg:'unattended',code:null}]`）；**正控制**：同一次运行里对 per-run 会话在忙时发一次 `chat.send`，读数 `perRunBusyCode=RUN_IN_PROGRESS`——保证该判定不是恒真。
- [x] (2) 写入时刻与帧形状：两腿各打印 `writeAt=<ts> turnResultAt=<ts> before=true`（帧写入进程 stdin 的时刻**早于**当前轮的 `result`）与 `frame.uuid=<uuid> frame.priority=later`；该 uuid 与随后 CLI 输出的 `command_lifecycle command_uuid` **逐字相同**（两个读数并排打印）。
- [x] (3) 不丢、归入后一轮：该消息文本出现在**其后另起一轮**的请求体里（打印 `appearsInTurnRequest#<n> textPresent=true`），且被记入**那一轮**的 run（打印 `run.appSessionId=<A> messageInRun=true`）；**正控制**：当前轮请求体里 `textPresentInCurrentTurn=false`（既没并进当前轮，也没丢）。
- [x] (4a) 队列中撤回：对**尚在队列中**的消息发起撤回 ⇒ 服务端发出 `cancel_async_message`（打印发出的控制帧原文），读到该 uuid 的 `command_lifecycle state=cancelled`，该消息文本**不出现在任何一轮请求体里**（打印 `textInAnyTurn=false`），返回值标为**已撤回**（打印 `cancelResult=withdrawn`）。**不读控制响应**：打印 `controlResponsesForCancel=0`。
- [x] (4b) 已出队撤回：对**已出队**的消息撤回 ⇒ **没有** cancelled 事件（打印 `cancelledEvents=0`），返回值是可辨的「已开始处理」（打印 `cancelResult=already-started`），进程无副作用（打印撤回前后 `hostPid` **相同**，且其后仍产生 `result`）。
- [x] 假形态 (a) 承重：让服务端自己排队、等当前轮 `result` 之后才写入 ⇒ (2) 的写入时刻读数**必须红**（判据文件内一臂，照 `model-gateway-end-to-end.test.ts:211` 的 `(b-fake)` 形状：构造该假行为并断言读数确实变红）。
- [x] 假形态 (b) 承重：让 resident 的忙时 `chat.send` 返回 `RUN_IN_PROGRESS` ⇒ (1) **必须红**。
- [x] 假形态 (c) 承重：撤回只在前端隐藏、不发 `cancel_async_message` ⇒ 无 cancelled 事件且消息仍产生一轮 ⇒ (4) **必须红**。
- [x] 假形态 (d) 承重：以 `control_response` 的到达判撤回成败 ⇒ 撤回成功也读成失败 ⇒ (4) **必须红**。
- [x] 假形态 (e) 承重：等 `session_state_changed` 才切分轮次 ⇒ 读不到轮边界 ⇒ (3) **必须红**（打印本次实跑的 `sessionStateChanged=<n>`；E9 9.1 两条驱动各 0 条）。
- [x] 不越权断言：`next` 档执行时的落点 E9 没读到 ⇒ 判据**不**对 `next` 作断言，只打印 `nextPriorityLanding=unread`（读不到就是读不到，不编）。
- [x] 不使既有判据变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts` 三条各自退出 **0**（逐条打印命令与退出码），这三条文件**一字不改**（`git diff --name-only` 里没有它们）。
- [x] 契约面：`npm run typecheck`、`npm run lint` 退出 0。
- [x] 不闭环：忙时写入与撤回的注入点不引入 providers → websocket 的反向 import 边（照 `provider.registry.ts:101-103` 的禁环说明选边），打印该文件的 import 边读数证明未新增反向依赖。

## DoD

判据在**落地后的树**上按原命令重跑：退出码 0、`fail 0`。**真实落地**（不是「测试存在」）：判据里真的起一个 `claude` **常驻**进程（真二进制 + mock 端点 + 临时 `DATABASE_PATH`），mock 真的把响应拖住造出忙，**用户轮进行中**与**无人轮进行中**各由真 `chat.send` 推入一条消息——两条都真的没被拒（无 `RUN_IN_PROGRESS`），两条都真的在**当前轮 `result` 之前**被写进进程 stdin（帧带服务端分配的 uuid 与 `priority=later`），两条都真的出现在**其后另起一轮**的请求体里并被记入那一轮的 run（不丢失、不并入当前轮）；**出队前的撤回**真的发出 `cancel_async_message` 控制帧、真的读到该 uuid 的 `command_lifecycle state=cancelled`、该文本真的不出现在任何一轮请求里；**出队后的撤回**真的没有 cancelled 事件、返回可辨的「已开始处理」且进程无副作用（pid 不变、其后仍有轮）。五条假形态各有判据内一臂，且各自把对应读数打红（绿 = 判据有洞，必须先补判据再继续）。`next` 档不读到就不作断言，读数写 `unread`。既有三条 per-run 判据逐字不变且仍绿。完成后 AC-163 在驱动器下一轮经 `goal_ac: AC-163` 独立复跑时由红翻绿——且这次翻绿有分辨力：不拒 / 写入时刻 / 归轮不丢 / 撤回四条读数各有正控制（per-run 忙时仍 `RUN_IN_PROGRESS`、当前轮请求体不含该文本、出队后撤回无 cancelled），五条假形态必红。

## Touches

- `server/modules/providers/tests/claude-resident-busy-input.test.ts` (new)（判据，AC-163 的 criterion 路径）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（AC-161 落地的 resident driver：输入队列写入 + 服务端 uuid + `priority=later` + `command_lifecycle` 解析 + `cancel_async_message` 控制帧；若其实际文件名不同，按实际文件登记并在完成记录里写明）
- `server/modules/providers/list/claude/claude.provider.ts`（submit / cancel 的 provider 缝）
- `server/modules/providers/services/provider-runtime.service.ts`（忙时 submit 的分派与消息归轮）
- `server/modules/websocket/services/chat-websocket.service.ts`（`chat.send` 忙时不再返回 `RUN_IN_PROGRESS`；新增撤回 verb）
- `server/modules/websocket/services/chat-run-registry.service.ts`（resident 会话在轮次边界开/结 run，使后一轮的 run 承载被推入的消息；今天的 `startRun` 在已有 running run 时返回 `null` 是 `RUN_IN_PROGRESS` 的成因）
- `server/modules/session-hosts/session-host-manager.service.ts`（resident 宿主的忙态查询与输入提交入口）
- `server/shared/types.ts`（优先档 / `command_lifecycle` 事件 / 撤回结果的类型）
- `tasks/gap-claude-resident-busy-input.md`（自触）

## 完成记录

落地提交 `35e94019`（任务分支 `task/gap-claude-resident-busy-input`；develop `a32b41ee` 已合入）。判据命令逐字：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-busy-input.test.ts` → 退出 **0**，`tests 1 / pass 1 / fail 0 / duration_ms 8897.32`（进程自然退出，无 `[budget]` 行）。

读数（落树实跑，逐字）：
- 真链路：`bytesPerTurn=[4079,69943,4050,70705,70922,71951,4050,72174,4038,80863] realTurns=6`——真 agent 轮按请求体 `bytes > 10KB` 识别，不按序号、也不按请求里有无用户文本
- (1) 两腿都不拒：`busySends=[{"leg":"user","code":null},{"leg":"unattended","code":null}]`；正控制 `perRunBusyCode=RUN_IN_PROGRESS`（同一次运行里 per-run 会话忙时仍被拒，证明该判定不是恒真）
- (2) 写入时刻与帧形状：`leg=user writeAt=1790501878396 turnResultAt=1790501878621 before=true frame.uuid=e7610d4b-efe8-47e9-9938-a6f789c88c43 frame.priority=later command_lifecycle.command_uuid=e7610d4b-efe8-47e9-9938-a6f789c88c43`；`leg=unattended writeAt=1790501878900 turnResultAt=1790501884020 before=true frame.uuid=a5372c56-61a4-4163-aa95-4d61adb39cba frame.priority=later command_lifecycle.command_uuid=a5372c56-61a4-4163-aa95-4d61adb39cba`（两腿的 uuid 与 CLI 输出的 `command_uuid` 逐字相同）
- (3) 不丢、归入其后另起一轮：`leg=user appearsInTurnRequest#3 inFlightTurn#1 textPresentInCurrentTurn=false run.appSessionId=claude-resident-busy-input-session messageInRun=true`；`leg=unattended appearsInTurnRequest#5 inFlightTurn#4 textPresentInCurrentTurn=false run.appSessionId=claude-resident-busy-input-session messageInRun=true`
- (4a) 队列中撤回：`cancelResult=withdrawn command_lifecycle.state=cancelled textInAnyTurn=false controlResponsesForCancel=0`；发出的控制帧原文 `{"type":"control_request","request_id":"c7a0ee29-265b-4b65-9b9a-c9ee40921db3","request":{"subtype":"cancel_async_message","message_uuid":"da7e1064-d801-4fb3-b2d1-aeac0f592b95"}}`（成败只读 `command_lifecycle`，不读 `control_response`）
- (4b) 已出队撤回：`alreadyStarted cancelledEvents=0 cancelResult=already-started hostPidBefore=3070627 hostPidAfter=3070627 laterResult=true unattendedFinished=true`（进程无副作用且其后仍产生 `result`）
- 轮次边界与回执帧：`turnBoundaries=4 fakeBoundaries(sessionStateChanged)=0 terminalsAtQueuedTurn=3 terminalsAtUnattendedTurn=3`；`ackFrames user={count=2 withSeq=2 kinds=["stream_delta:number","text:number"]} unattended={count=2 withSeq=2 kinds=["stream_delta:number","text:number"]}`
- 收尾读数：`unattendedStarted=true unattendedQueued=true resultsBefore=2 resultsAfter=2 resultsNow=4 queuedTurnEnded=true queuedUnattendedTurnEnded=true`；`framesAfterPerRunSends=2 perRunTurnInFlight=true perRunTurnStopped=true`——per-run 控制腿那一轮经生产 `runtime.abort('claude', <session>)` 停住：它的宿主由 `trackPerRunTurn` 建立、`pid` 为 `null`，teardown 的 SIGKILL 够不着它，不停就会把判据进程拖到 60s 进程预算上（曾实测 `[budget] elapsed=60003ms exit=3`）
- 不越权：`nextPriorityLanding=unread`（`next` 档出队落点 E9 未读到，故不作断言）；`sessionStateChanged=0`
- 不闭环：五个文件的 `websocketImports(...)=0`（`provider.registry.ts` / `provider-runtime.service.ts` / `claude-host-driver.provider.ts` / `claude.provider.ts` / `session-host-manager.service.ts`），未新增 providers → websocket 反向边
- 五条假形态：`fake (a): red`、`fake (b): red`、`fake (c): red`、`fake (d): red (verdict-from-control-response=unknown)`、`fake (e): red (sessionStateChanged=0, realTurnBoundaries=4)`

旁证——既有判据逐字未改（`git diff --name-only develop..HEAD` 共 8 条，不含它们），各自退出 0：
- `claude-host-per-run.test.ts`（`tests 7 / pass 7 / fail 0`）
- `claude-background-work.test.ts`（`tests 10 / pass 10 / fail 0`）
- `passthrough-parity.test.ts`（`tests 4 / pass 4 / fail 0`）
- `npm run typecheck` 退出 0；`npm run lint` 退出 0

门与缓存：`bash scripts/test.sh --for-task gap-claude-resident-busy-input --allow-thin` 退出 0。第一次跑时本任务判据那一条 Touches 写的是「反引号路径紧贴全角括注」，scoped 选择器取不到该路径、照 `(thin)` 空跑；本次一并改成半角空格分隔的 `(new)（…）` 形状（路径不变，anti-drift 解析对两种拼法等价），并 `git merge develop` 把改写后的任务文件带进 worktree——重跑 scoped 门即真的选中并跑过判据：`__PERFILE__ duration_ms=9269 server/modules/providers/tests/claude-resident-busy-input.test.ts passed=true`，`# tests 1 / # pass 1 / # fail 0`，退出 0（`suite-scope-check: PASS — 16 active task(s) scanned`，active 16 / with-tests 7）。scoped-gate 缓存按跑门时实测的 develop sha 写：`--develop-sha` 取的是 `git -C <worktree> rev-parse develop`，跑门前后该值不变、且该提交是 HEAD 的祖先（该次 HEAD 为 `Merge branch 'develop' into task/gap-claude-resident-busy-input`）。任务文件每改写一次 develop 就前进一格，故缓存 key 里的 sha 以 `.quay/scoped-gate-cache.json` 的实测值为准，本文不写死字面量。
