---
id: gap-ac238-debug-agent-control-queue
title: AC-238 调试 agent 常驻驱动经控制服务走通忙时排队与撤回：驱动交出排队 uuid、撤回后那条消息永远不成为一轮；判据
  server/modules/debug-agent/tests/debug-agent-control-queue.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-238
depends_on:
  - gap-ac230-control-send-immediate-runid
  - gap-ac231-control-busy-queue-cancel
---
## Proposal

AC-238（GOAL-019 退出条件 9；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「排队路径的自动覆盖」§443-446 与「未核实的前提」第 5 条 §527）要求：不跑真 CLI，用调试 agent 的常驻宿主驱动经控制服务（而不是 WebSocket）走通常驻会话忙时排队与撤回——(a) 第一轮进行中再 `send` 返回 `queued: true` 与非空 `queuedMessageUuid`，且该 uuid 就是驱动内部为这条消息分配、`cancelQueuedInput` 认得的那个；(b) 不撤回时，第一轮结束后第二条消息成为独立的下一轮，其 runId 与第一轮不同，两轮各有一个终止帧；(c) 撤回时用返回的 uuid 调 `cancelQueued` 得到 `cancelled`，之后不再出现第二条消息对应的轮次，宿主 pid 不变；(d) 在该消息已被取出（已开始执行）之后再撤回得到 `unknown`，而不是 `cancelled`。真实 Claude 驱动的 `cancel_async_message` 不在本判据范围，只由既有真实 CLI 测试与阶段 4 的人工门覆盖。

前置：本任务建立在 `gap-ac230-control-send-immediate-runid`（创建 `server/modules/websocket/services/chat-control.service.ts`、导出 `dispatchRun`、交付非忙 `send`）与 `gap-ac231-control-busy-queue-cancel`（控制服务忙时分支、`cancelQueued`、在 `ProviderRuntimeGateway` 上新增可选 `queuedInputUuid` 缝；其判据用假运行时）之上。AC-231 边界明确把「真实网关与调试驱动的排队 uuid 交接」划给本任务。

现状（红态基线）：判据文件 `server/modules/debug-agent/tests/debug-agent-control-queue.test.ts` 不存在，判据的存在性闸以退出码 1 输出缺失的文件名。`queuedInputUuid` 在 `server/` 全库零命中。`provider-runtime.service.ts` 返回的真实网关（:667 起）只实现 `acceptsBusyInput`（:692）与 `cancelQueuedInput`（:709，经 `resolveResidentDriver` 解析常驻驱动、失败读作 `unknown`），没有交出排队 uuid 的缝。`debug-agent.host-driver.ts` 已有进程队列（`registerPushedCommand` :578、`cancelQueuedInput` :582 恒返回 `'unknown'`、`readOldestQueuedCommand` :597、`acknowledgeCancel` :604、`readCommandQueue` :647），但没有「交出最新排队 uuid」的动词。`debug-agent.provider.ts` 的 `acceptPushedCommand`（:211-237）当场 `crypto.randomUUID()` 铸造 uuid、`registerPushedCommand` 入队，返回 `{ pushed: true, commandUuid }`，且明确不运行场景、不发终止帧；`debug-agent.engine.ts` 的 `dequeue` 步（:442-452）只写 `started` 行、不打开运行。`debug-agent-host-driver.test.ts` 的 stand-in（:388-419）按名转发驱动全部动词，是加动词后必须同步的既有消费者。

要交付：

1. **调试驱动交出排队 uuid**（`debug-agent.host-driver.ts`）。给 `DebugAgentHostDriver` 增加一个动词（如 `queuedInputUuid(appSessionId): string | null`），返回该会话进程序列里「已交给进程、尚未开始」的最新一条命令的 uuid——即 `acceptPushedCommand` 铸造、`registerPushedCommand` 入队、`cancelQueuedInput` 认得、`readOldestQueuedCommand` 会取走的同一个 uuid；必须等于 `readCommandQueue(appSessionId).queued` 的末条。同步补进返回对象与 `debug-agent-host-driver.test.ts` 的 stand-in 转发对象（否则新增必填动词会让该文件 typecheck 失败）。

2. **真实网关实现 `queuedInputUuid`**（`server/modules/providers/services/provider-runtime.service.ts`）。在返回的网关对象上实现 `queuedInputUuid(providerName, sessionId): Promise<string | null>`：用与 `acceptsBusyInput`/`cancelQueuedInput` 同一个 `resolveResidentDriver` 解析常驻驱动条目并读它的排队 uuid；无 provider / 非常驻 / 无该动词 / 任何异常一律读作 `null`（保守：绝不把「拿不到」读成「排队成功且 uuid 为空」）。这是 AC-231 定义的 `ProviderRuntimeGateway.queuedInputUuid` 缝的真实实现。

3. **调试驱动的撤回真的移出队列**（`debug-agent.host-driver.ts` 的 `cancelQueuedInput`）。该 uuid 仍在进程序列里时，把它从队列移除并返回 `'cancelled'`；已不在队列（已被 `readOldestQueuedCommand` 取走／已开始）时返回 `'unknown'`。请求仍记入 `withdrawRequested`（供 `readCommandQueue` 读回），但判决改为由驱动自己的队列状态决定。`acknowledgeCancel`/`cancel-ack` 步保持可用，且不得让同一 uuid 产生第二条 `cancelled` 行。既有调试判据（host-driver / control-plane / gate / frames）现状未断言 `cancelQueuedInput` 的返回值（已 grep 确认），改后必须仍绿。

4. **未撤回的排队消息在首轮结束后成为独立的一轮**（`debug-agent.engine.ts` / `debug-agent.provider.ts`，必要时 `debug-agent.host-driver.ts`）。当第一轮进行中收到的排队命令在第一轮结束、被 `dequeue` 取出且未被撤回时，调试 agent 必须为它打开一个自己的运行（经宿主的 `openRun` / `openUnattendedTurn` 缝，runId 与第一轮不同）并走完、发出终止帧，使「两轮各有一个终止帧」可读；若该命令在取出前被撤回（已从队列移除），则不得出现这一轮。两种情形下都是同一个被持有的宿主进程（pid 不变）。实现者自选最小机制（例如：`dequeue` 步在队列非空时经宿主缝开一个运行并写该轮终止记录；或 `acceptPushedCommand` 记下该命令，令首轮 `run` 返回后由运行时再开一个运行），但读数必须成立。

5. **判据 `server/modules/debug-agent/tests/debug-agent-control-queue.test.ts`**（红先行）。经控制服务驱动：`createChatControlService` 与 `chatRunRegistry` 从 `@/modules/websocket/index.js` 导入（先例：`debug-agent-host-driver.test.ts` 已从该 barrel 导入 `chatRunRegistry`），真实网关用 `providerRuntimeService`（providers barrel），常驻宿主用 `createSessionHostManager`（session-hosts barrel）+ `createDebugAgentHostDriver` / `createDebugAgentProvider`（本模块 barrel），场景经 `armDebugAgentScenario` 装载；沿用 debug-agent 判据的 gate/home 临时目录与子进程手法（见 `debug-agent-control-plane.test.ts`），不构造 socket、不连生产 3001、不跑真 CLI。读数逐条写下原始值：
   (a) 第一轮 running 时第二次 `send`：返回 `queued: true`、`queuedMessageUuid` 非空，且等于 `readCommandQueue(sessionId).queued` 末条；写出两次返回。
   (b) 不撤回：令第一轮结束并推进场景使排队命令被 `dequeue`；断言出现一个与第一轮 runId 不同的运行，两轮各有一个终止帧（写出两个 runId 与两帧读数）。
   (c) 撤回：用 (a) 的 uuid 调 `cancelQueued` 得 `'cancelled'`；推进场景后断言没有出现第二条消息对应的运行／轮次；宿主 pid 与撤回前相同（写出返回值、轮次读数、两次 pid）。
   (d) 已取出后撤回：先让命令被 `dequeue`（已开始），再用同一 uuid 调 `cancelQueued` 得 `'unknown'` 而非 `'cancelled'`（写出返回值与队列读数）。

6. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：(i) 驱动不交出 uuid（`queuedInputUuid` 恒回 `null`，或网关不转发）⇒ (a) 必须红；(ii) 撤回只改返回值、不真正移出队列（回 `'cancelled'` 但不做 `splice`）⇒ (c) 的「不再出现第二条消息对应的轮次」必须红；(iii) 撤回已开始的消息仍回 `'cancelled'`（去掉「不在队列 ⇒ unknown」分支）⇒ (d) 必须红。每条记录恢复命令与恢复后重跑绿。

<!-- dedup-ref -->
边界：本任务与 GOAL-019 其它 AC 的任务相互独立、范围不重叠。不实现 AC-230–AC-237 各自的范围（控制服务本体与忙分支/取消归 AC-230/AC-231；访问入口归 AC-232；单实例归 AC-233；来源归 AC-234；按 id 寻址归 AC-235；宿主启停服务归 AC-236；不回归归 AC-237）；不改真实 Claude 驱动的 `cancel_async_message`；不改 WebSocket 协议与 `chat.subscribe` 帧序列；不构造 socket；不加无跨文件消费者的 barrel 导出；不改既有判据文件的断言（只做加动词所必需的 stand-in 转发补全）。

判定纪律：uuid 必须来自驱动队列（(a)/(i) 证明），不是控制服务自造；撤回的「不再成轮」是场景推进后的实测（(c)/(ii) 证明），不是只看返回值；已取出后撤回得 `unknown` 是队列状态的实测（(d)/(iii) 证明）。

## AC

- [x] AC1 判据绿：`for f in server/modules/debug-agent/tests/debug-agent-control-queue.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-control-queue.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/debug-agent/tests/debug-agent-control-queue.test.ts`）。
- [x] AC2 (a) 忙时排队并交出驱动 uuid：第一轮 running 时再 `send` 返回 `queued:true`、`queuedMessageUuid` 非空，且等于 `readCommandQueue(sessionId).queued` 末条；写出两次返回与队列读数。
- [x] AC3 (b) 不撤回成为独立下一轮：第一轮结束后排队命令被取出并成为一个 runId 与第一轮不同的运行，两轮各有一个终止帧；写出两个 runId 与两帧读数。
- [x] AC4 (c) 撤回：用 (a) 的 uuid 调 `cancelQueued` 得 `'cancelled'`，推进后不再出现第二条消息对应的轮次，宿主 pid 不变；写出返回值、轮次读数、两次 pid。
- [x] AC5 (d) 已取出后撤回得 unknown：命令已 `dequeue`（开始执行）后用同一 uuid 调 `cancelQueued` 得 `'unknown'` 而非 `'cancelled'`；写出返回值与队列读数。
- [x] AC6 无 WebSocket/真 CLI：写下用于核对的 grep 命令与空输出——判据文件不 `import` ws、不 `new WebSocket(`、不 spawn 真实 claude 二进制；AC2–AC5 全部读数在无 socket、无生产端口下完成。
- [x] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 驱动不交出 uuid ⇒ AC2 红；(ii) 撤回不移出队列 ⇒ AC4 的「不再成轮」红；(iii) 已开始的消息仍回 cancelled ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 不回归与仓库门：既有调试判据（至少 `debug-agent-host-driver.test.ts`、`debug-agent-control-plane.test.ts`、`debug-agent-gate.test.ts`、`debug-agent-frames.test.ts`）与 AC-230/AC-231 判据逐字通过（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写明计数）；跨模块只经 barrel。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 忙时 `send` 返回的 `queuedMessageUuid` 真的是驱动队列里那个 uuid（判据 (a) 用队列末条实测），不是控制服务自造的随机 id；缝缺失时保守返回 null，绝不假装排队成功。
- 撤回真的把消息移出进程队列：撤回后推进场景不再出现第二条消息对应的轮次（实测），不是「返回值是 cancelled」就算数；已开始的消息撤回得 unknown。
- 未撤回的排队消息真的在首轮结束后成为独立一轮（runId 不同、两轮各有终止帧，实测），宿主 pid 在撤回与否两种情形下都不变。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；判据不构造 socket、不跑真 CLI。
- 遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号）；不越界实现其它 AC 的范围（见边界）；不改协议与既有判据。

## Touches

- server/modules/debug-agent/debug-agent.host-driver.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/websocket/index.ts
- server/modules/debug-agent/tests/debug-agent-control-queue.test.ts (new)
- server/modules/debug-agent/tests/debug-agent-host-driver.test.ts
- tasks/gap-ac238-debug-agent-control-queue.md

## Notes

完成记录（2026-10-05）。分支 `task/gap-ac238-debug-agent-control-queue`。

**词表映射（AC4 的 `cancelled`）**：任务正文用 `cancelled` 命名的「撤回成功」判决，在共享类型 `HostQueuedInputCancelResult`（`server/shared/types.ts:2511`）里叫 `withdrawn`——真实 Claude 常驻驱动 `claude-host-driver.provider.ts:2658` 也返回 `withdrawn`。判据读驱动自己的、类型正确的值并在读数行原样打印（`verdict=withdrawn`）；«cancelled» 是该任务把驱动判决与调试 agent 的行状态 `command_lifecycle: 'cancelled'` 混称。已开始的消息撤回得 `unknown`（队列状态实测），与 AC5 逐字一致。

**AC1 红态基线**：`for f in server/modules/debug-agent/tests/debug-agent-control-queue.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done` → 退出码 1，stderr 逐字 `缺判据文件：server/modules/debug-agent/tests/debug-agent-control-queue.test.ts`（runs 前该文件在仓库中不存在）。绿：同一命令退出码 0，5 tests / 5 pass / 0 fail。

**AC2 (a) 读数**：`first={"ok":true,"runId":"71c173ae-bcef-4b6c-a431-4dbfb28bfbe1","queued":false,"queuedMessageUuid":null}`；`second={"ok":true,"runId":"19455621-d461-44db-b079-99b266bcb82d","queued":true,"queuedMessageUuid":"218e62a7-d7a3-436c-8e4d-1c3d77e92334"}`；`readCommandQueue(sessionId).queued=["218e62a7-d7a3-436c-8e4d-1c3d77e92334"]` → 返回的 uuid 严格等于队列末条（驱动交出，非控制服务自造）。

**AC3 (b) 读数**：`round1RunId=0c2de1f8-e5bf-460a-8abe-8b8c721f6719 round1Complete=true`；`round2RunId=d3510bda-a0bc-427a-ab21-67639b4596ef round2Source=unattended round2Text="second" round2Complete=true openedRounds=1` → 两个 runId 不同、两轮各有终止帧。round2 的文本是第二条消息原文（`queuedTextByCommand` 保住），pid 未变（宿主复用，`processStarts` 不增）。

**AC4 (c) 读数**：`verdict=withdrawn uuid=df6fc5dd-fe4f-4be6-b575-6304071028c1 queueAfterCancel=[] queueHeld=false openedRounds=0 round1Complete=true pidBefore=null pidAfter=null` → 撤回真的把消息移出队列、推进后没有出现第二条轮次、宿主 pid 两次相同。

**AC5 (d) 读数**：`uuid=ed75f414-4662-417d-952b-e8e1dde92caa queueAfterDequeue=[] queueHeld=false verdict=unknown openedRounds=1` → 已取出（已开始）后撤回得 `unknown`，队列实测已无该 uuid。

**AC6 grep 证据**：`grep -nE "from ['\"]ws['\"]|require\(['\"]ws['\"]\)|new WebSocket\(|@anthropic-ai|claude-code|spawn\(['\"]claude" server/modules/debug-agent/tests/debug-agent-control-queue.test.ts` → 无匹配、退出码 1（空输出）。文件里唯一的进程派生是 `execFileSync(process.execPath, [TSX_CLI, …])`——tsx 跑同一判据文件的子进程，不连生产 3001、不跑真 CLI；判据自身还带 (e) 无 socket 引用自检。

**AC7 取假形态（先提交实现 `51760ea2`，逐条变异—实测红—恢复）**：
(i) 驱动不交出 uuid：`queuedInputUuid` 改为 `void appSessionId; return null;`。变异红：`AssertionError [ERR_ASSERTION]: queuedMessageUuid must be a non-empty string (got null)`（(a) 退出 1）。恢复：`git checkout -- server/modules/debug-agent/debug-agent.host-driver.ts`；重跑 (a) 绿（pass 1 / fail 0）。
(ii) 撤回只改返回值不移出队列：删 `queue.splice(at, 1);`。变异红：`AssertionError [ERR_ASSERTION]: a withdrawn message must never become a round — actual: 1, expected: 0`（(c) 退出 1；为此把 (c) 的 openedRounds 断言排在 queueHeld 之前，正是 AC7(ii) 要求的那条读数）。恢复同 (i)；重跑 (c) 绿。
(iii) 已开始的消息仍回成功：`if (at < 0) return 'unknown'` 改为 `if (at >= 0) queue.splice(at,1)`，恒 `return 'withdrawn'`。变异红：`AssertionError [ERR_ASSERTION]: a message already started cannot be withdrawn — actual: 'withdrawn', expected: 'unknown'`（(d) 退出 1）。恢复同 (i)；重跑 (d) 绿。
三条变异 diff 分别存 `/tmp/mut-i.diff`、`/tmp/mut-ii.diff`、`/tmp/mut-iii.diff`（本次会话）。

**AC8 不回归与仓库门**：
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-host-driver.test.ts` → 5 pass / 0 fail（退出 0）；`…/debug-agent-control-plane.test.ts` → 4 pass / 0 fail；`…/debug-agent-gate.test.ts` + `…/debug-agent-frames.test.ts` 合并 → 9 pass / 0 fail。
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-busy.test.ts server/modules/websocket/tests/chat-control-send.test.ts`（AC-231/AC-230）→ 9 pass / 0 fail。
- `npm run typecheck` → 退出 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json）。
- `npm run lint` → 退出 0；`grep -c ": error "` = 0；本次改动的文件无任何 lint 输出。
- 跨模块只经 barrel：判据从 `@/modules/websocket/index.js`、`@/modules/providers/index.js`、`@/modules/session-hosts/index.js`、`@/modules/database/index.js` 导入；为此把 `createChatControlService` 补进 websocket barrel（其消费方：本次判据与 AC-233 的 `server/index.ts` 单实例装配），这是 Touches 之外唯一被迫新增的文件，已先加入 Touches。

**AC9 文件清单（`git diff --name-status develop...HEAD`，7 项，与 Touches 逐条对齐）**：
- M `server/modules/debug-agent/debug-agent.engine.ts`（`DebugAgentRunInput.onQueuedCommandStarted` + `dequeue` 步上报）
- M `server/modules/debug-agent/debug-agent.host-driver.ts`（新增 `queuedInputUuid`；`cancelQueuedInput` 真移出队列并回 `withdrawn`/`unknown`）
- M `server/modules/debug-agent/debug-agent.provider.ts`（记下排队文本；首轮结束后为每条已 dequeue 的命令经 `openUnattendedTurn` 开独立一轮并写终止帧）
- M `server/modules/providers/services/provider-runtime.service.ts`（网关实现 `queuedInputUuid`，保守读 `null`）
- M `server/modules/websocket/index.ts`（导出 `createChatControlService`）
- A `server/modules/debug-agent/tests/debug-agent-control-queue.test.ts` (new)
- M `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`（stand-in 转发新动词）
- `tasks/gap-ac238-debug-agent-control-queue.md`（本文件，task_write 自身提交）
