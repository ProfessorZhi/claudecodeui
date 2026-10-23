---
id: gap-ac271-mcp-session-cancel-queued
title: AC-271 session_cancel_queued：用 session_send 返回的 uuid 撤回排队消息（撤回得
  cancelled、已取出得非 cancelled、未知与跨会话得 unknown），此后那条消息永不成为一轮且宿主 pid 不变；仅 send
  令牌被拒并写 denied 审计；判据 server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac249-session-send-immediate-runid
  - gap-ac238-debug-agent-control-queue
  - gap-ac231-control-busy-queue-cancel
goal_ac: AC-271
---
## Proposal

AC-271（GOAL-022 退出条件 1；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 `session_cancel_queued` §282、scope 表 §329、阶段 6 §525 与 §453「排队路径的自动覆盖」）要求 MCP 工具 `session_cancel_queued` 让外部客户端用 `session_send` 返回的 `queuedMessageUuid` 撤回一条**尚未开始**的排队消息：撤回成功如实报 `cancelled`；那条消息此后**永远不成为一轮**，且被持有的常驻宿主进程 pid 不变；若消息已被取出开始执行，撤回如实说「已不在队列」（不是 `cancelled`）；用从未返回过的 uuid、或属于别的会话的 uuid 撤回，报 `unknown` 且不改动该会话的队列；该工具需要 `cloudcli:session:control`，只带 `cloudcli:session:send` 的令牌被拒并写 `denied` 审计。判据文件 `server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts` 当前不存在，AC-271 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts`（已实测复现）。

现状（红态基线）：

- MCP 工具层尚不存在：`mountMcpGateway` 目前只注册空的 `tools/list`（`mcp-gateway.transport.ts` 的 `createMcpServer`，注释「No tools are registered yet — AC-245+ fills them」）；只读/写工具集合、工具注册缝、令牌主体 `McpPrincipal`、`withMcpAudit` 分别由 AC-245/AC-249/AC-241/AC-244 落地（均未落地）。`session_cancel_queued` 在 `server/` 全库零命中。
- 控制服务已具备本任务所需的撤回语义：`createChatControlService`（`server/modules/websocket/services/chat-control.service.ts`）的 `cancelQueued(caller, { sessionId, messageUuid })`（:464）先过与 `send`/`abort` 同一个访问入口 `accessEntry`，再经 `deps.runtime.cancelQueuedInput?.(provider, input.sessionId, input.messageUuid)`，判决原样透传、缺省读作 `unknown`。
- 调试 agent 常驻驱动已具备队列撤回：`debug-agent.host-driver.ts` 的 `cancelQueuedInput(appSessionId, messageUuid)`（:582 起）在队列里还有该 uuid 时 `splice` 移除并返回 `'withdrawn'`，不在队列（已被 `readOldestQueuedCommand` 取走走）时返回 `'unknown'`；`queuedInputUuid(appSessionId)` 交出驱动队列末条（`session_send` 的 `queuedMessageUuid` 来源）。共享判决类型 `HostQueuedInputCancelResult = 'withdrawn' | 'already-started' | 'unknown'`（`server/shared/types.ts:2553`）——即**去掉队列的判决是 `withdrawn`，不是 `cancelled`**；AC-271 要的 `cancelled` 是 MCP 工具自己的报告词，适配层必须翻译。真实 claude 驱动对已取出消息会回 `already-started`（`claude-host-driver.provider.ts:2666`），调试驱动按 AC-238 的判决把已取出也读作 `unknown`（`debug-agent-control-queue.test.ts` 的 `(d)`）。
- `session_send` 的 `queuedMessageUuid` 由 AC-249 交付（本判据用它取 uuid）。

要交付：

1. **适配层（新文件 `server/modules/mcp-gateway/mcp-session-cancel-queued.ts`；遵守 `$backend-module-standards`，导出带消费方注释）**，导出可注入 deps 与实现：
   - `export type McpSessionCancelQueuedDeps = { control: { cancelQueued(caller: ControlCaller, input: { sessionId: string; messageUuid: string }): Promise<HostQueuedInputCancelResult | 'forbidden'> } }`——真单例或判据注入的 spy 实例皆可。
   - `export type SessionCancelQueuedOutcome = 'cancelled' | 'already-started' | 'unknown'`。
   - `export async function buildSessionCancelQueued(input: { session: string; messageUuid: string }, ctx: { principal: McpPrincipal }, deps): Promise<SessionCancelQueuedPayload>`：
     - `session` 到达时已是解析门改写后的 sessionId（解析门归 AC-246，本判据用精确 session id）。
     - `caller = { userId: ctx.principal.userId, via: 'mcp' }`。
     - `const verdict = await deps.control.cancelQueued(caller, { sessionId, messageUuid: input.messageUuid })`。
     - 翻译（AC-271 的词表落点，逐字）：`'withdrawn'` ⇒ `{ outcome: 'cancelled', session, messageUuid, message: '该排队消息已撤回，不会成为一轮。' }`；`'already-started'` ⇒ `{ outcome: 'already-started', session, messageUuid, message: '该消息已不在队列（已被取出开始执行），无法再撤回。' }`；`'unknown'` ⇒ `{ outcome: 'unknown', session, messageUuid, message: '该会话队列里没有这个消息 uuid（可能从未存在、属于别的会话，或没有常驻宿主）。' }`；`'forbidden'` ⇒ 结构化拒绝（归 AC-232，本任务只保证不把它读成成功）。
     - **绝不把 `withdrawn` 直接当报告词透出**（AC-271 要的是 `cancelled`；透传 `withdrawn` 则 (a) 红）；也**绝不把非 `withdrawn` 读成 `cancelled`**（否则 (b) 红）。
   - `export function registerMcpSessionCancelQueuedTool(...)`：把实现接到工具注册缝（AC-245/AC-249 的缝），`requiredScopes: ['cloudcli:session:control']`（scope 字面量取自 SPEC §329；若 AC-243 已落地 `ACCESS_TOKEN_SCOPES` 常量则从 `@/modules/oauth/index.js` 导入该常量，不重写）。
2. **阶段 6 常驻工具注册集合（新文件 `server/modules/mcp-gateway/mcp-gateway.resident-tools.ts`）**：照 AC-249 写工具集合的形状，导出 `export const MCP_STAGE6_RESIDENT_TOOLS = [{ name: 'session_cancel_queued', scope: 'cloudcli:session:control' }] as const`（这是阶段 6 工具名的唯一事实来源；AC-272/273/274 落地时向此表追加 `session_reconfigure`/`session_background`/`approvals_list`/`approval_answer`，不改本任务判据）与 `export function registerMcpResidentTools(registrationSeam, deps): void`——经 AC-244 的 `withMcpAudit` 注册 `session_cancel_queued`，handler 是第 1 条的真实实现。
3. **接线（`server/modules/mcp-gateway/mcp-gateway.transport.ts` + `server/modules/mcp-gateway/index.ts`）**：`mountMcpGateway` 在既有工具注册缝里调用 `registerMcpResidentTools`，用 AC-249 已注入的**同一个**控制服务实例（不新建实例）；barrel 导出 `MCP_STAGE6_RESIDENT_TOOLS`、`registerMcpResidentTools`、`buildSessionCancelQueued`、`McpSessionCancelQueuedDeps`、`SessionCancelQueuedOutcome`，各写消费方注释。
4. **判据文件 `server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts`（红先行）**：形制照 AC-249 判据——`mkdtemp` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发真令牌（happy 路径带 `['cloudcli:read','cloudcli:session:send','cloudcli:session:control']`；(d) 用只带 `['cloudcli:read','cloudcli:session:send']` 的第二枚）+ 同一 express 4 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`（控制服务用真 `createChatControlService` + 注入 spy），客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`（避开 `listen(0)` 的 undici 坏端口）。会话用**调试 agent**（`DEBUG_AGENT_PROVIDER_ID`：`createSessionHostManager` + `createDebugAgentHostDriver` + `armDebugAgentScenario`，形制照 `debug-agent-control-queue.test.ts`）：一个 `lifecycle_mode='resident'` 会话，场景把第一轮悬住。**真实 HTTP** 经 MCP 客户端调用；uuid 全部来自 MCP `session_send` 的返回，不手造。读数各自独立成断言并逐字写出原始值：
   - (a) **撤回得 `cancelled` 且永不成为一轮、pid 不变**：第一轮 running 时经 MCP `session_send` 第二次 ⇒ 取 `queuedMessageUuid`；经 MCP `session_cancel_queued({ session, messageUuid })` ⇒ `outcome === 'cancelled'`；推进场景（`dequeue` 步）后断言没有出现第二条消息对应的轮次/运行（`openedRounds` 计数、注册表里没有第二个 runId），常驻宿主 pid 与撤回前逐字相等。逐字写出：两次 `session_send` 返回、`session_cancel_queued` 返回、队列撤回前后读数、pid 前后。
   - (b) **已取出后撤回不是 `cancelled`**：先推进场景使排队命令被 `dequeue`（开始执行），再经 MCP 撤回同一 uuid ⇒ `outcome !== 'cancelled'`（调试驱动按 AC-238 的判决给 `'unknown'`；真实驱动的 `'already-started'` 归 AC-275），且第二条消息**真的**开始了一轮（`openedRounds >= 1`／存在第二个 runId）——「已不在队列」由「消息真的开始执行了」与「返回不是 cancelled」共同证明。逐字写出返回与轮次读数。
   - (c) **未知与跨会话 uuid 得 `unknown` 且不动队列**：用一个从未返回过的 uuid 经 MCP 撤回 ⇒ `outcome === 'unknown'`；用**另一个**常驻会话的、由它自己的 `session_send` 返回的 uuid 撤回第一个会话 ⇒ `outcome === 'unknown'`，且两个会话的驱动队列在撤回前后逐字不变。逐字写出两组返回与两组队列读数。
   - (d) **scope**：用只带 `['cloudcli:read','cloudcli:session:send']` 的第二枚令牌调 `session_cancel_queued` ⇒ 工具结果 `isError` 为真、`mcpAuditLogDb` 新增**恰好一行**且 `tool='session_cancel_queued'`、`outcome='denied'`、控制服务 `cancelQueued` spy 计数为 **0**。逐字写出该行与前后计数。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 撤回只改返回值、不真正移出驱动队列（`cancelQueuedInput` 回 `withdrawn` 但不 `splice`）⇒ (a) 的「永不成为一轮」必须红；
   (ii) 已开始的消息仍回 `cancelled`（去掉「不在队列 ⇒ 非 cancelled」分支，或适配层把 `unknown` 映射成 `cancelled`）⇒ (b) 必须红；
   (iii) 不校验会话归属（适配层忽略传入的 sessionId、按 uuid 全局找会话再撤回）⇒ (c) 的跨会话一项必须红（另一会话的队列被改动，或返回 `cancelled`）。
   每条记录恢复命令与恢复后重跑绿。
5. **不回归与仓库门**：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写明计数）；AC-249 判据 `mcp-session-send.test.ts`、AC-245 判据 `mcp-read-tools.test.ts`、AC-238 判据 `debug-agent-control-queue.test.ts` 不改一字仍逐字通过。跨模块只经 barrel。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-271" tasks/` 为空；`grep -rln "AC-271" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-271` 或引用它。相关但不同：`gap-ac238-debug-agent-control-queue`（AC-238，done）覆盖的是**控制服务**层在调试驱动上的忙时排队与撤回（判据 `debug-agent-control-queue.test.ts`，判决词是 `withdrawn`/`unknown`）；`gap-ac231-control-busy-queue-cancel`（AC-231，done）覆盖控制服务本体的 `cancelQueued`；`gap-ac249-session-send-immediate-runid`（AC-249，todo）交付 MCP 写工具集合与 `session_send`。本任务覆盖的是**MCP 工具** `session_cancel_queued` 的对外行为与词表（`cancelled`/`already-started`/`unknown`）、scope 审计与判据 `mcp-cancel-queued.test.ts`，是不同机制、不同判据文件。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-249 未落地则无工具注册缝、无审计包装消费先例、无 `session_send` 取 uuid、无单例控制服务接线；AC-238 未落地则调试驱动队列撤回语义不存在（(a)(b)(c) 的队列读数无来源）；AC-231 未落地则控制服务 `cancelQueued` 不存在。AC-252（自指保护）不列为硬前置：本判据用普通会话，不构造「目标正执行网关写工具」的自指场景，自指拒绝读数归 AC-252。AC-246（模糊匹配）不列为硬前置：本判据用精确 session id。AC-275（真实 claude 驱动的 `already-started`）不列为硬前置：本判据走调试驱动，真实驱动的已开始判决由 AC-275 直接覆盖。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-271 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 经真实 HTTP + MCP `session_send` 取 `queuedMessageUuid`，经 MCP `session_cancel_queued` 撤回得 `outcome==='cancelled'`；推进场景后没有第二条消息对应的轮次/运行，宿主 pid 撤回前后逐字相等；逐字写出两次 send 返回、撤回返回、队列前后、pid 前后。
- [x] AC4 (b) 消息被 `dequeue`（开始执行）后撤回 ⇒ `outcome !== 'cancelled'`（调试驱动读作 `'unknown'`）且第二条消息真的开始了一轮（`openedRounds>=1`／存在第二个 runId）；逐字写出返回与轮次读数。
- [x] AC5 (c) 从未返回过的 uuid ⇒ `outcome==='unknown'`；另一会话自己的 uuid 对第一个会话 ⇒ `outcome==='unknown'`，两个会话的驱动队列撤回前后逐字不变；逐字写出两组返回与两组队列读数。
- [x] AC6 (d) 只带 `['cloudcli:read','cloudcli:session:send']` 的令牌调用被拒（isError）、新增恰好一行 `tool='session_cancel_queued'`/`outcome='denied'` 审计、控制服务 `cancelQueued` spy 计数为 0；逐字写出该行与前后计数。
- [x] AC7 无 WebSocket 客户端参与/无真 CLI：写下 grep 命令与空输出——判据文件不 `import` ws / 不 `new WebSocket(` / 不 spawn 真实 claude 二进制；AC3–AC6 全部读数在该文件内完成。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 只改返回值不移出队列 ⇒ AC3 的「永不成为一轮」红；(ii) 已开始仍回 `cancelled` ⇒ AC4 红；(iii) 不校验会话归属 ⇒ AC5 的跨会话一项红。每条记录恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`debug-agent-control-queue.test.ts`、`chat-control-*.test.ts` 不改一字仍逐字通过；跨模块只经 barrel。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- `session_cancel_queued` **真的**经真实 HTTP + MCP SDK 客户端驱动，落到**真** `createChatControlService` + **真**调试 agent 常驻驱动队列上——不是「函数被调用」或「判据文件存在」就算数。
- 撤回的词表**真的**是 AC-271 要的：成功报 `cancelled`（不是透传控制服务的 `withdrawn`）；已取出的消息**真的**不报 `cancelled`（调试驱动读作 `unknown`）；未知/跨会话 uuid **真的**报 `unknown` 且**真的**不动那个会话的队列。
- 「永不成为一轮」是**实测**：撤回后推进场景**真的**没有出现第二条消息对应的轮次/运行，宿主 pid **真的**不变。
- scope **真的**生效：只带 send 的令牌**真的**被拒、**真的**写下一行 `denied` 审计、控制服务撤回**一次都没被调用**。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖；不改控制服务与调试驱动本体；不越界实现 AC-232/AC-246/AC-252/AC-272–AC-277 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-session-cancel-queued.ts (new)
- server/modules/mcp-gateway/mcp-gateway.resident-tools.ts (new)
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts (new)（判据）
- tasks/gap-ac271-mcp-session-cancel-queued.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-249 同款说明）。
- `withdrawn` → `cancelled` 的翻译是 AC-271 特有的词表要求（AC-238 的判据断言的是控制服务的 `withdrawn`；本判据断言的是 MCP 工具的 `cancelled`），两者不冲突：控制服务不变，只在新适配层翻译。
- 调试驱动的 `cancelQueuedInput` 对已取出的 uuid 读作 `unknown`（AC-238 的 `(d)`），故 (b) 的机器词是 `unknown`、实质证据是「消息真的开始了一轮」；真实 claude 驱动的 `already-started` 词表由 AC-275 直接覆盖。
- `MCP_STAGE6_RESIDENT_TOOLS` 是阶段 6 工具名的唯一事实来源；AC-252 的自指保护从工具注册表取网关写工具名（含 `session_cancel_queued`），不手写第二份。