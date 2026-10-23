---
id: gap-ac275-claude-resident-control-queue
title: AC-275 真实 claude 二进制的常驻驱动经控制服务撤回排队消息：uuid 来自真实驱动、撤回后那条消息不成为一轮、进程 pid
  不变；判据 server/modules/providers/tests/claude-resident-control-queue.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-275
---
## Proposal

AC-275（GOAL-022 退出条件 5；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §282 `session_cancel_queued`、§454「不覆盖的部分」与 §535「未核实的前提」第 5 条）要求：用**真实 `claude` 二进制**（做法照 AC-161 的 `server/modules/providers/tests/claude-resident-process.test.ts`：真 CLI + mock Anthropic 兼容端点 + 临时 `DATABASE_PATH` / `CLAUDE_CONFIG_DIR`，按**请求体**识别轮次，SDK 标题请求不计），经**控制服务**（`createChatControlService`，**不经 WebSocket**）在常驻会话上撤回排队消息。读数：

- (a) 经控制服务对常驻会话发第一轮，第一轮进行中再发第二条，返回 `queued: true` 与非空 `queuedMessageUuid`，且该 uuid 是**真实驱动**为这条消息交出、`cancelQueuedInput` 认得的那一个；
- (b) 用该 uuid 撤回，得到成功判决（AC 写作 `cancelled`；共享类型 `HostQueuedInputCancelResult` 实际值是 `withdrawn`——见 AC-238 已交付的词表映射先例），且 mock 端点此后**收不到**第二条消息对应的模型请求（那条消息永不成为一轮）；
- (c) 全程宿主 pid 不变；
- (d) 对照臂：不撤回时，第一条结束后第二条成为**独立的下一轮**，mock 端点收到对应请求。

本任务覆盖 SPEC §454/§535 明说的缺口：「真实 Claude 驱动的 `cancel_async_message` 只由现有真实 CLI 测试与阶段 4 的人工门覆盖。」AC-163（`claude-resident-busy-input.test.ts`）已在**驱动层经 socket** 覆盖了真 CLI 的撤回，但从未**经控制服务**、也从未用**控制服务交出的 uuid** 覆盖；本任务补上这条自动化判据。

现状（红态基线，已实测）：

- 判据文件 `server/modules/providers/tests/claude-resident-control-queue.test.ts` **不存在**。存在性闸逐字 `缺判据文件：server/modules/providers/tests/claude-resident-control-queue.test.ts`，退出码 1（已在仓库根实测复现）。
- 控制服务已具备读写两侧语义：`createChatControlService`（`server/modules/websocket/services/chat-control.service.ts:298`）的 `send`（:317）在忙分支返回 `{ ok:true, queued:true, queuedMessageUuid, completion }`（:440-448），uuid 由 `readQueuedMessageUuid`（:205）从 `deps.runtime.queuedInputUuid` 读、带 2s 上界；`cancelQueued`（:464）经 `accessEntry` 后透传 `deps.runtime.cancelQueuedInput` 的判决。`send` 返回的 `completion` 是运行自己的 promise（运行结束才 settle），可直接用来判定「一轮结束」。
- 真实网关已实现 `queuedInputUuid`：`provider-runtime.service.ts:752` 经 `resolveResidentDriver`（:627，要求 mode=resident + 声明 + 动词齐全 + 有 live host）读 `entry.queuedInputUuid`，任何取不到都保守读 `null`。这是 AC-238（commit `51760ea2`）交付的缝。
- **缺口**：真实 Claude 常驻驱动 `ClaudeResidentHostDriver`（`server/modules/providers/list/claude/claude-host-driver.provider.ts`）有 `cancelQueuedInput`（:2631）与 `busyInputReading`（:2528，暴露 `state.queuedInputs`），但**没有** `queuedInputUuid` 方法（实测 `grep -n queuedInputUuid server/modules/providers/list/claude/claude-host-driver.provider.ts` 零命中）。因此 `resolveResidentDriver(...).entry.queuedInputUuid` 不存在 → 网关读 `null` → 控制服务忙分支 `queuedMessageUuid` 恒为 `null` → 读数 (a) 必红。这正是 AC-275「驱动不交出 uuid ⇒ (a) 必须红」所针对的实现缺口；AC-238 只给了调试驱动的同名词，真实驱动从未给出。
- 真实驱动的撤回本体已具备（AC-163 交付）：`cancelQueuedInput` 手写 `cancel_async_message` 控制帧（CLI 对该帧在三种时机都不回 `control_response`，故以 CLI 自己的 `command_lifecycle state=cancelled` 事件为准），等待到 `cancelled` 后 `dropWithdrawnRound` 丢弃该消息本应开的那一轮并结束它，返回 `withdrawn`；已出队（`started`）则 `already-started`，从未入队则 `unknown`（`server/shared/types.ts:2553` 的 `HostQueuedInputCancelResult`；`CommandLifecycleState = 'queued' | 'started' | 'cancelled' | 'completed'`，:2445）。本任务**不改** `cancel_async_message` 实现（GOAL-022 非目标），只让它经控制服务被覆盖。

要交付：

1. **真实驱动交出排队 uuid**（`claude-host-driver.provider.ts`）。给 `ClaudeResidentHostDriver` 增加 `queuedInputUuid(appSessionId: string): string | null`：返回该会话 live state 的 `state.queuedInputs` 里「最新一条、且 `startedAt === null`」的 `uuid`（即忙时 `armRound` 推入、CLI 用 `command_lifecycle` 报到的同一个 uuid，`cancelQueuedInput` 撤回的也是它）；无 live state / 已关 / 无未开始条目时返回 `null`（保守：绝不把「拿不到」读成「排队成功且 uuid 为空」）。必须在控制服务 `readQueuedMessageUuid` 读取它的那一刻就已可读（单次忙写已在控制服务读之前完成入队，参照 AC-238 的同步交接前提）；实现若发现读取时机晚于入队，须让交接在忙写完成时即可读，**不得**改用其它源（如 `busyInputReading`）绕过该缝。该缝为可选（`ResidentTurnEntry.queuedInputUuid?`），新增类方法不需改共享接口；全库无按名枚举驱动动词的 stand-in（已 grep 确认），故无转发对象需同步。

2. **判据 `server/modules/providers/tests/claude-resident-control-queue.test.ts`**（红先行）。做法照 AC-161 / AC-163：真实 `claude` 二进制 + mock Anthropic 兼容端点（按**请求体**识别轮次，SDK 标题/辅助请求不计；mock 必须能 `hold()` 住回复，使第一轮真正在飞）+ 临时 `DATABASE_PATH` / `CLAUDE_CONFIG_DIR` + 一条自定义模型条目（`ANTHROPIC_BASE_URL` 指向 mock、`ANTHROPIC_AUTH_TOKEN` 为条目密文、`ANTHROPIC_API_KEY=unset`；宿主 key 哨兵不得出现在任何请求体/头里）+ 会话 `lifecycle_mode='resident'`。**经控制服务驱动**：`const runtime = createProviderRuntimeService(); const control = createChatControlService({ runtime });` 用 `control.send(CALLER, { sessionId, content, options, connection: null })` 与 `control.cancelQueued(CALLER, { sessionId, messageUuid })`（`CALLER = { userId: 1, via: 'scheduled' | 'mcp' }`），**不** import/调用 `handleChatConnection`、不构造 socket、不连生产 3001。读数逐条写下原始值：

   (a) `mock.hold()` 后 `control.send` 第一轮，等到 mock 收到带第一轮文本的请求（证明轮在飞）；再 `control.send` 第二条 → 断言 `ok:true`、`queued:true`、`queuedMessageUuid` 为非空字符串；交叉核对：它等于驱动 live state 里最新未开始排队条目的 uuid（经 `providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver` 的 `busyInputReading(sessionId)!.queuedInputs`）且 CLI 的 `command_lifecycle.command_uuid` 报到这个 uuid（写出两次返回、驱动队列读数、lifecycle 读数）。

   (b) `control.cancelQueued(CALLER, { sessionId, messageUuid })` → 断言得成功判决（打印驱动返回的类型正确值 `withdrawn`，并在边上注明 AC 的 `cancelled` 措辞即此）；断言 CLI 对该 uuid 报了 `command_lifecycle state=cancelled`；释放第一轮的 held 回复、`await first.completion` 让第一轮真正结束，再等一个有界窗口，断言 mock 收到的任何 `/v1/messages` 请求体都**不含**第二条消息的文本（那条消息永不成为一轮）。

   (c) 从 `sessionHostManager.snapshot()` 读该会话的 live host（`bindings.has(sessionId)` 且 `state !== 'closed'`），用 `/proc/<pid>/stat` 的 non-zombie 判定存活：三次读数（第一轮在飞时、撤回后、第一轮结束后）pid 与 hostId 相同且始终存活。

   (d) 对照臂（同一次真实驱动上、或在同文件第二个用例里重跑同一读数函数）：同样的 hold 与两次 `control.send`，但**不撤回**；释放后等第二条对应的独立下一轮 → 断言 mock 收到一个请求体包含第二条文本的请求、且第一轮与第二条各自的运行/轮次读数可区分（两轮都走完）。对照臂是 (b) 的正例对照：没有它，「mock 收不到第二条」可能因判据根本没跑第二条而假绿。

   另按 AC-161 的纪律加**进程级预算守卫**（`exit 3` + 打印预算与实测墙钟，非 node:test case failure），并让整个文件在其自身预算内完成。

3. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：(i) 驱动不交出 uuid（`queuedInputUuid` 恒回 `null`）⇒ (a) 必须红（`queuedMessageUuid` 为 null / 非空断言失败）；(ii) 撤回不真正移出队列（撤回只改返回值、不真正让 CLI 取消，例如去掉等待 `cancelled` 与 `dropWithdrawnRound`）⇒ (b) 必须红（mock 随后收到第二条文本的请求）；(iii) 撤回关掉了进程（撤回路径顺带关宿主/杀进程）⇒ (c) 必须红（pid 变化或不再存活）。每条记录恢复命令与恢复后重跑绿。

<!-- dedup-ref -->
边界与查重：本任务的机制是「**真实 claude 驱动 + 控制服务**的排队 uuid 交接与撤回」，与以下既存任务机制不同、范围不重叠——AC-238 `gap-ac238-debug-agent-control-queue`（调试 agent 驱动、不跑真 CLI）覆盖的是同一**语义**在调试驱动上的实现，不覆盖真实驱动；AC-163 `claude-resident-busy-input.test.ts`（`gap-claude-resident-busy-input`）覆盖真 CLI 的撤回但在**驱动层经 socket**、且 uuid 取自 `busyInputReading`，不经控制服务、不用控制服务交出的 uuid；AC-271 `gap-ac271-mcp-session-cancel-queued` 及 AC-272/273/274 覆盖 **MCP 工具层**（`session_cancel_queued` 等），本任务不经 MCP、不经 WebSocket。本任务不改 `cancel_async_message` 实现（GOAL-022 非目标），不改 WebSocket 协议与既有判据，不新增 MCP 工具，不实现 GOAL-020/021 范围。

判定纪律：uuid 必须来自真实驱动队列（(a)+(i) 证明），不是控制服务自造；「撤回后不成一轮」是释放首轮并等窗口后的 mock 请求体实测（(b)+(ii) 证明），不是只看返回值；pid 不变是 `/proc` 存活读数（(c)+(iii) 证明）；(d) 是必须绿的正例对照。负载下可能假红，由 fan-in 全量 suite 复核时按假红处理流程，**不放宽断言**。

## AC

- [x] AC1 判据绿：`for f in server/modules/providers/tests/claude-resident-control-queue.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-control-queue.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/providers/tests/claude-resident-control-queue.test.ts`）。
- [x] AC2 (a) 忙时排队并交出真实驱动 uuid：第一轮在飞时第二次 `control.send` 返回 `queued:true`、`queuedMessageUuid` 非空，且等于驱动 live state 最新未开始排队条目的 uuid、CLI `command_lifecycle.command_uuid` 也报到它；写出两次返回、驱动队列读数、lifecycle 读数。
- [x] AC3 (b) 撤回后那条消息不成为一轮：用 (a) 的 uuid 调 `control.cancelQueued` 得成功判决（打印 `withdrawn` 并注明即 AC 的 `cancelled`），CLI 报该 uuid `state=cancelled`；释放首轮并结束后，mock 收不到任何含第二条文本的 `/v1/messages` 请求；写出返回值、lifecycle 读数、mock 请求体清单。
- [x] AC4 (c) pid 不变：第一轮在飞时 / 撤回后 / 首轮结束后三次读数的 hostId 相同、pid 相同且经 `/proc` 判存活；写出三次读数。
- [x] AC5 (d) 对照臂（正例）：不撤回时第二条成为独立的下一轮，mock 收到含第二条文本的请求，两轮各自走完；写出两次 `send` 返回、两轮运行/轮次读数、mock 请求体读数。
- [x] AC6 经控制服务、不经 WebSocket、不跑生产：写下用于核对的 grep 命令与空输出——判据文件不 `import` `handleChatConnection`、不 `new WebSocket(`、不 import `'ws'`；全部读数经 `createChatControlService` 完成、不连生产 3001。
- [x] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 驱动不交出 uuid ⇒ AC2 红；(ii) 撤回不移出队列 ⇒ AC3 的「mock 收不到第二条文本」红；(iii) 撤回杀进程 ⇒ AC4 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 不回归与仓库门：既有相邻判据（至少 `claude-resident-process.test.ts`、`claude-resident-busy-input.test.ts`、`chat-control-busy.test.ts`）逐字通过（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写明计数）；跨模块只经 barrel。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 忙时 `control.send` 返回的 `queuedMessageUuid` 真的是**真实 claude 驱动**队列里那个 uuid（(a) 用驱动 live state 与 CLI lifecycle 双重实测），不是控制服务自造的随机 id；驱动缺该缝时保守返回 `null`，绝不假装排队成功——(i) 证明 (a) 的读数依赖该缝真实存在。
- 撤回真的把消息移出真实进程队列：撤回并推进后 **mock 端点收不到**第二条消息对应的模型请求，不是「返回值是 withdrawn」就算数——(ii) 证明该断言有洞会被抓到。
- 撤回不改变持有该会话的宿主进程：pid/hostId 三次读数相同且存活——(iii) 证明该断言有洞会被抓到。
- 对照臂 (d) 是绿的且是**同一读数函数**的正例：不撤回时第二条确实成为独立下一轮、mock 确实收到其请求；没有 (d)，(b) 的「收不到」不算数。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；判据用真 CLI 但经控制服务、不构造 socket、不连生产 3001。
- 遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号）；不越界实现其它 AC/GOAL 的范围（见边界）；不改 `cancel_async_message` 实现、不改协议与既有判据。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/tests/claude-resident-control-queue.test.ts (new)
- tasks/gap-ac275-claude-resident-control-queue.md
