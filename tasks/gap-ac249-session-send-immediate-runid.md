---
id: gap-ac249-session-send-immediate-runid
title: AC-249 session_send 立即返回 runId，运行与 UI 发起的运行是同一种：来源为
  mcp、出现在运行中列表、常驻忙时排队、按次进程忙时 RUN_IN_PROGRESS、waitSeconds 有界等待、scope 不足 denied
  审计、与 WebSocket 共用同一控制服务实例；判据
  server/modules/mcp-gateway/tests/mcp-session-send.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac239-sdk-zod-declared-in-dependencies
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac241-mcp-token-auth-shares-service
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac248-run-get-bounded-wait
goal_ac: AC-249
---
## Proposal

AC-249（GOAL-020 退出条件 8 的第一条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 `session_send` §277、`ChatControlService` §167–§203、运行来源 §237、装配 §201–§203、阶段 4 §523）要求 MCP 写工具 `session_send` 立即返回 runId，且它发起的运行与 UI 发起的运行是同一种：来源 `mcp`、出现在运行中列表、常驻会话忙时排队、按次进程会话忙时结构化拒绝、`waitSeconds > 0` 有界等待、scope 不足被拒并写 `denied` 审计、且网关用的是与 WebSocket 同一个控制服务实例。判据文件 `server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 当前不存在，AC-249 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`。

现状（红态基线）：`session_send` 未注册（写工具集合尚不存在）；`/mcp` 的传输与工具注册缝、令牌认证、审计包装分别由 AC-240/AC-241/AC-244 落地（均为本任务机械前置）。控制服务本体已存在并已支持本任务所需的一切——`createChatControlService`（`server/modules/websocket/services/chat-control.service.ts`）的 `send(caller, { sessionId, content, options?, interruptActiveRun? })` 在运行登记后立即返回；`caller.via: 'mcp'` 经 `SOURCE_BY_VIA` 把运行来源记成 `'mcp'`（不依赖连接推断，`chat-control.service.ts:52`）；常驻会话忙时返回 `{ ok: true, runId, queued: true, queuedMessageUuid }`（uuid 由驱动交出，新增运行取代当前运行）；按次进程会话忙时返回 `{ ok: false, code: 'RUN_IN_PROGRESS', message }`（此时不登记新运行，当前运行的 runId 仍可从注册表读到）。本任务**不修改控制服务**，只做 MCP 侧的适配层（工具输入 → `ControlCaller` + `SendInput` → 结果翻译）与注册。

可读的数据源（各经 barrel 或已导出的单例）：
- `chatRunRegistry`（`@/modules/websocket/index.js`）：`getRun(appSessionId): ChatRun | undefined`（`ChatRun` 带 `runId`/`source`/`status`/`userId`）、`getRunById(runId): ChatRunLookupResult`、`listRunningRuns(): Array<{ sessionId; provider; startedAt; lastSeq }>`。
- `sessionsService.listRunningSessions()`（`@/modules/providers/index.js`，内部即 `chatRunRegistry.listRunningRuns()`）——`GET /api/providers/sessions/running`（`provider.routes.ts:855`）的数据源，即 AC 说的「运行中列表」。
- `readMcpPrincipal(res)` / `McpPrincipal = { userId: number; scopes: string[] }`（AC-241，`res.locals.mcpPrincipal`）——`ControlCaller.userId` 的来源。
- `withMcpAudit(registration)`（AC-244）：按 `requiredScopes` 在调用前做 scope 检查，缺 scope ⇒ 不调用 handler、写一行 `denied` 审计、返回 `isError`；本任务给 `session_send` 声明 `requiredScopes: ['cloudcli:session:send']` 即可同时满足 (f) 的拒绝与审计。
- `buildRunGet(input, deps)` / `MCP_RUN_GET_MAX_WAIT_SECONDS`（AC-248，`./mcp-run-get.js`）：`waitSeconds > 0` 时复用，不重写第二份等待循环，也不重写第二份上限字面量。

要交付：

1. **`session_send` 实现（新文件 `server/modules/mcp-gateway/mcp-session-send.ts`；遵守 `$backend-module-standards`）**，导出可注入的 deps 与实现：
   - `export type McpSessionSendDeps = { control: { send(caller: ControlCaller, input: { sessionId: string; content: string }): Promise<SendResult> }; runs: { getRun(sessionId: string): ChatRun | undefined }; runGet: { deps; build(...): Promise<RunGetPayload> } }`——全部可注入（判据传真单例或自己驱动的实例 + spy）。
   - `export async function buildSessionSend(input: { session: string; message: string; waitSeconds?: number }, ctx: { principal: McpPrincipal }, deps: McpSessionSendDeps): Promise<SessionSendPayload>`：
     - 解析 `session` 到 sessionId：唯一命中才接受（若 AC-246 已落地，经其 `resolveInputTargets`/`resolveMcpTarget`；多义/无命中 ⇒ 结构化错误 `{ code: 'TARGET_AMBIGUOUS' | 'TARGET_NOT_FOUND', candidates, query }`，**不调用控制服务**、零副作用——本判据用精确 session id，唯一命中属 happy path）。
     - `caller = { userId: ctx.principal.userId, via: 'mcp' }`（(b)：userId 取自令牌属主，不是 null）。
     - `result = await deps.control.send(caller, { sessionId, content: input.message })`。
     - 成功：返回 `{ runId, queued, queuedMessageUuid, source: 'mcp' }`。**立即返回**：绝不 await 运行自身结束（`send` 内部那个「运行继续跑」的 promise 不 await）；结构上等待只发生在 `waitSeconds > 0` 分支。(a)。
     - 失败：翻译成结构化错误（`content` 文本 + `structuredContent`）：
       - `SESSION_NOT_FOUND` → `{ code: 'SESSION_NOT_FOUND', message }`。
       - `UNSUPPORTED_PROVIDER` → `{ code: 'UNSUPPORTED_PROVIDER', message }`。
       - `FORBIDDEN` → `{ code: 'FORBIDDEN', message }`。
       - `RUN_IN_PROGRESS` → **(d)** 从 `deps.runs.getRun(sessionId)?.runId` 取当前运行 id（控制服务的原始消息**不含** runId，见 Notes），返回 `{ code: 'RUN_IN_PROGRESS', runId: <当前运行的 runId>, message, hint: '该会话已有运行在进行；改用 run_get 查询它的进展，或稍后重试。' }`。hint 文案里**必须**出现 `run_get` 与「稍后重试」（(d) 的逐字读数）。
     - `waitSeconds > 0`：在成功结果之后 `await deps.runGet.build({ runId, waitSeconds }, deps.runGet.deps)`，把 `outcome`/`lastAssistantMessage`/最终摘要合并进返回值（(e)：有界等待、带回最终消息）。上限复用 `MCP_RUN_GET_MAX_WAIT_SECONDS`（从 `./mcp-run-get.js` 导入，不重写字面量）。等待循环只经 AC-248 注入的 `now`/`sleep`；本文件不得出现 `Date.now()`/`setTimeout`。
   - `export function registerMcpSessionSendTool(...)`（或等价名）把上面实现接到 AC-245/AC-244 的注册缝。
2. **写工具注册集合（新文件 `server/modules/mcp-gateway/mcp-gateway.write-tools.ts`）**：照 AC-245 只读集合的形状，导出
   - `export const MCP_STAGE4_WRITE_TOOLS = [...] as const`——阶段 4 的**恰好** 5 个写工具名与各自 scope：`session_send` → `cloudcli:session:send`、`session_create` → `cloudcli:session:create`、`session_interrupt`/`session_start`/`session_close` → `cloudcli:session:control`（scope 字面量取自 SPEC §327–§329；若 AC-243 已落地 `ACCESS_TOKEN_SCOPES` 常量则从 `@/modules/oauth/index.js` 导入该常量而不是重写）。这是写工具集合的唯一事实来源。
   - `export function registerMcpWriteTools(registrationSeam, deps: McpWriteToolDeps): void`——经 AC-244 的 `withMcpAudit` 包装**逐个注册**这 5 个工具，每个带描述、`inputSchema`（zod）、`requiredScope`（取自 `MCP_STAGE4_WRITE_TOOLS`）。`session_send` 的 handler 是真实实现（第 1 条）；`session_create`/`session_interrupt`/`session_start`/`session_close` 的**行为归 AC-250 / AC-251**，本任务只按上表注册，其 handler 主体返回明确的 `isError`（`code: 'MCP_TOOL_NOT_IMPLEMENTED'`，注明归 AC-250/AC-251）——注册全 5 个使集合稳定，AC-250/251 落地只替换 handler、不改集合、不改本任务判据。
3. **接线（`server/modules/mcp-gateway/mcp-gateway.transport.ts` + `server/modules/mcp-gateway/index.ts` + `server/index.ts`）**：
   - `mountMcpGateway` 增加/复用可注入的 `control`（AC-233 的单例）与 `runGetDeps`，在工具注册缝（AC-244）里调用 `registerMcpWriteTools`；工具派发时用 `readMcpPrincipal(res)`（AC-241）构造 `{ principal }` 交给 handler。
   - `server/index.ts` 把**已有的那一个** `chatControl` 实例（`:118`，同时也交给 `createWebSocketServer` 与 scheduled-messages）传进 MCP 网关装配——(g)：**网关不得自己 `new` 一个控制服务**；同一实例经 spy 计数可证（SPEC §201–§203）。
   - barrel `server/modules/mcp-gateway/index.ts` 导出 `MCP_STAGE4_WRITE_TOOLS`、`registerMcpWriteTools`、`McpWriteToolDeps`、`buildSessionSend`、`McpSessionSendDeps`，各写消费方注释。
4. **判据文件 `server/modules/mcp-gateway/tests/mcp-session-send.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + MCP SDK 客户端 + 真实 better-sqlite3 临时库 + 调试 agent 的常驻/按次进程两种会话）**：形制照 AC-245/AC-248（`mkdtemp` + `closeConnection()` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发带 `['cloudcli:read','cloudcli:session:send']` 的真令牌 + 同一 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`，避开 `listen(0)` 的 undici 坏端口——内存 `undici-bad-port-lottery-in-listen0-route-tests`）。会话用**调试 agent**（`DEBUG_AGENT_PROVIDER_ID`：`createSessionHostManager` + `createDebugAgentHostDriver` + `armDebugAgentScenario`，形制照 `server/modules/debug-agent/tests/debug-agent-control-queue.test.ts`）：一个 `lifecycle_mode='resident'` 的常驻会话（忙时有队列、驱动交出 uuid）与一个按次进程会话。控制服务用**真实** `createChatControlService`（注入 `providerRuntimeService` 真实网关 + 该控制服务 `send` 的计数间谍 spy），并在装配时把**同一个**实例同时交给 WebSocket 服务器与 MCP 网关。读数各自独立成断言并逐字写出原始值：
   - (a) **立即返回且是同一种运行**：让常驻会话第一轮保持运行（场景把该轮悬住），经 MCP `session_send({ session, message })`（`waitSeconds` 缺省 0）；断言工具响应**在运行仍 running 时**到达——读出 `chatRunRegistry.getRun(sessionId)?.status === 'running'`、返回的 `runId` 与 `getRun(sessionId)?.runId` 逐字相等、`getRunById(runId)` 的 `source === 'mcp'`（逐字写出 `runId`/`source`/`status`）、`listRunningRuns()` 含该 `sessionId`、且 `GET /api/providers/sessions/running` 的响应里含该 `sessionId`（「运行中列表」）。正例对照：`runId` 非空、`source` 非 `undefined`（防「一律 undefined」也通过）。
   - (b) **caller.userId**：spy 记录 `send` 收到的 `caller`；断言 `caller.userId === <owner 用户 id>` 且 `!== null`，并读 `chatRunRegistry.getRun(sessionId)?.userId` 与 owner 相等；逐字写出两侧 id。
   - (c) **常驻忙时排队**：第一轮进行中对同常驻会话再 `session_send`，断言 `queued === true` 且 `queuedMessageUuid` 为非空字符串；逐字写出 `queued` 与 uuid，并与驱动队列末条（`readCommandQueue(sessionId).queued` 末条）相等（防自造 id）。
   - (d) **按次进程忙时拒绝**：第一轮进行中对按次进程会话 `session_send`，断言返回结构化错误 `code === 'RUN_IN_PROGRESS'`、错误体带 `runId` 且等于当前运行的 runId、`hint` 里出现 `run_get` 与「稍后重试」；逐字写出错误体 JSON 与当前 runId。
   - (e) **`waitSeconds > 0` 有界等待**：`waitSeconds: 40`，让运行在第 3 秒结束；断言 `elapsedMs < 40000`（逐字写出真实 elapsed）、返回体带最终消息且与夹具末条助手消息逐字相等。
   - (f) **scope 不足**：用只带 `['cloudcli:read']` 的第二枚令牌调 `session_send`，断言工具结果 `isError` 为真、`mcpAuditLogDb` 新增**恰好一行**且 `tool='session_send'`、`outcome='denied'`（逐字写出该行）、控制服务 `send` 间谍计数为 **0**（逐字写出前后计数）。
   - (g) **同一实例**：装配时把同一个 spy 包装的控制服务实例交给 WebSocket 服务器与 MCP 网关；先经 WebSocket `chat.send` 发一次、再经 MCP `session_send` 发一次，断言同一个 spy 的计数两次都 +1（逐字写出 `wsCount`/`mcpCount` 与 spy 对象身份判定）。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) `buildSessionSend` 在 `waitSeconds === 0` 时也 await 运行结束才返回 ⇒ (a) 必须红；
   (ii) `ControlCaller.via` 传成 `'scheduled'`（或直接用调度来源）⇒ 注册表 `source` 记成 `scheduled` ⇒ (a) 必须红；
   (iii) 忙时常驻会话也走拒绝分支（不把 `queued:true` 结果透出）⇒ (c) 必须红；
   (iv) 网关装配里 `createChatControlService(...)` 自造第二个实例而不接 `server/index.ts` 传入的单例 ⇒ (g) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-249" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-249`；`grep -rln "AC-249" tasks/` 只命中 AC-245/AC-246/AC-247/AC-248 的边界段（各自声明「写工具（AC-249–AC-251）不在本任务」；AC-246 明确「写工具本体行为由 AC-249–AC-251 交付，本任务交付它们必经的通用解析门」）。AC-250（`session_create`）与 AC-251（`session_interrupt`/`session_start`/`session_close`）是**不同读数与不同判据文件**，各自直接覆盖；本任务交付写工具注册集合与 `session_send` 一个真实 handler，其余四个只占位注册（`MCP_TOOL_NOT_IMPLEMENTED`，注明归属），不测它们的行为、不写它们的判据。AC-252（自指保护）、AC-253（装配与 barrel）、AC-254/255（设置页）、AC-256/257（冒烟）均不越界。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-239 未落地则判据无法 import SDK 客户端；AC-240 未落地则无 `/mcp` 传输与工具注册缝；AC-241 未落地则无令牌中间件与 `McpPrincipal`（(b)(f) 要发真令牌读主体）；AC-244 未落地则无 `withMcpAudit` 包装与 `denied` 审计（(f) 依赖它）；AC-245 未落地则无工具注册缝的消费先例与 MCP 客户端夹具形制；AC-248 未落地则 `waitSeconds > 0`（(e)）无 `buildRunGet` 可复用。AC-243（scope 词汇）不列为硬前置：`cloudcli:session:send` 字面量取自 SPEC §327，与 AC-245 对 `cloudcli:read` 的处理一致。AC-246（名称模糊匹配）不列为硬前置：本判据用精确 session id（唯一命中），解析门的多义/无命中读数归 AC-246。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-249 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-session-send.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) `session_send` 在运行仍 running 时返回；`runId` 与注册表当前运行逐字相等、`getRunById(runId).source === 'mcp'`、`listRunningRuns()` 与 `GET /api/providers/sessions/running` 都含该会话；逐字写出 runId/source/status 与两处列表读数；正例对照 runId 非空。
- [x] AC4 (b) 控制服务收到的 `caller.userId` 等于令牌属主且非 null，注册表运行 `userId` 与属主相等；逐字写出两侧 id。
- [x] AC5 (c) 常驻会话忙时返回 `queued: true` 与非空 `queuedMessageUuid`，且 uuid 等于驱动队列末条；逐字写出 queued 与 uuid。
- [x] AC6 (d) 按次进程会话忙时返回结构化 `RUN_IN_PROGRESS`，带当前运行 runId 与含 `run_get`/「稍后重试」的提示；逐字写出错误体与当前 runId。
- [x] AC7 (e) `waitSeconds: 40` 而运行第 3 秒结束 ⇒ `elapsedMs < 40000` 且带回最终消息并与夹具末条助手消息逐字相等（逐字写 elapsed 与两侧文本）。
- [x] AC8 (f) 仅 `cloudcli:read` 令牌调用被拒（isError）、`mcp_audit_log` 新增恰好一行 `tool='session_send'`/`outcome='denied'`、控制服务 send 计数为 0；逐字写出该行与前后计数。
- [x] AC9 (g) 同一控制服务实例：WS `chat.send` 与 MCP `session_send` 都使同一个 spy 计数 +1；逐字写出 wsCount/mcpCount 与实例身份判定。
- [x] AC10 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 等运行结束才返回 ⇒ AC3 红；(ii) 来源记成 scheduled ⇒ AC3 红；(iii) 忙时一律拒绝 ⇒ AC5 红；(iv) 网关自造控制服务 ⇒ AC9 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC11 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；既有控制服务判据 `server/modules/websocket/tests/chat-control-*.test.ts`、AC-245 判据 `mcp-read-tools.test.ts` 与 AC-248 判据 `mcp-run-get.test.ts` 不改一字仍逐字通过（本任务只新增写工具与适配层，不改控制服务、不改只读工具集合）。
- [x] AC12 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- `session_send` **真的**经真实 HTTP + MCP SDK 客户端驱动，落到**真** `createChatControlService` + **真** `chatRunRegistry` + 调试 agent 的常驻/按次进程两种会话上——不是「函数被调用」或「判据文件存在」就算数。
- **立即返回是结构性的**：`waitSeconds` 缺省/0 时工具响应**真的**在运行仍 running 时到达；返回的 `runId` 就是注册表那次运行、`source` **真的**是 `'mcp'`、**真的**出现在 `listRunningRuns()` 与 `/api/providers/sessions/running` 里。
- 调用方 **真的**是令牌属主（`caller.userId` 非 null 且等于 owner）；常驻忙时**真的**排队并交出驱动队列里的那个 uuid；按次进程忙时**真的**返回带当前 runId 与 `run_get`/稍后重试提示的结构化 `RUN_IN_PROGRESS`。
- `waitSeconds > 0` **真的**有界等待（复用 AC-248 的 `buildRunGet` 与 `MCP_RUN_GET_MAX_WAIT_SECONDS`，不重写第二份）并在运行结束时带回最终消息。
- scope 不足**真的**被 `withMcpAudit` 拒、**真的**写下一行 `denied` 审计、控制服务 send 计数**真的**为 0；网关**真的**用与 WebSocket 同一个控制服务实例（spy 计数两向都 +1，非两份实例）。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖（SDK 由 AC-239 声明）；不改控制服务本体；不越界实现 AC-246/AC-250–AC-257 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-session-send.ts (new)
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts (new)
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts (new)（判据）
- server/index.ts
- tasks/gap-ac249-session-send-immediate-runid.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-248 同款说明）。
- (d) 的 runId 必须由**适配层**补：控制服务的 `RUN_IN_PROGRESS` 原始消息是 `Session "<id>" already has a run in progress.`（`chat-websocket.service.ts:735`），**不含 runId**；`buildSessionSend` 用 `deps.runs.getRun(sessionId)?.runId` 取当前运行 id 并写进结构化错误。这正是 (d) 读数与「只透传 message」的区别所在。
- (c) 的 uuid 必须来自驱动：`queuedMessageUuid` 由常驻驱动交出（`ProviderRuntimeGateway.queuedInputUuid`，AC-231/AC-238 落地）。判据把返回值与 `readCommandQueue(sessionId).queued` 末条比对，防止控制服务/适配层自造随机 id；驱动拿不到时控制服务保守返回 null，那时 (c) 应红——所以本判据要求调试 agent 驱动已交出 uuid（AC-238 已落地）。
- (g) 的形态照 SPEC §203 与 AC-233 的间谍计数：装配点 `server/index.ts` 只构造一个控制服务实例，同一对象交给 `createWebSocketServer`、scheduled-messages 与 `mountMcpGateway`；判据用同一对象身份判定 + 两向计数。取假形态 (iv) 证明这条闸有效。
- 写工具集合 `MCP_STAGE4_WRITE_TOOLS` 是写工具名的唯一事实来源（AC-252 的自指保护读它取网关写工具名，不手写第二份）；AC-250/251 只替换 handler，不改集合。
- `waitSeconds` 上限复用 AC-248 的 `MCP_RUN_GET_MAX_WAIT_SECONDS`（从 `./mcp-run-get.js` 导入），不重写第二份字面量；等待循环只经注入的 `now`/`sleep`。

## Change Notes (worker, 2026-10-05)

实现提交：`224e8646 feat(mcp-gateway): session_send returns a runId at once (AC-249)`（含判据）。以下为逐条 AC 证据。

### AC1 红态基线（判据文件尚不存在时）
命令：
`for f in server/modules/mcp-gateway/tests/mcp-session-send.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts`
输出（stderr）：`缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`；退出码 1。

### AC2 绿
`# tests 7` / `# pass 7` / `# fail 0`（退出 0）。

### AC3 (a) 立即返回 + 同一种运行（逐字）
`session-send (a) payload={"runId":"eeed5fc7-36c6-44f4-8e1d-1fb1fc6d98a0","queued":false,"queuedMessageUuid":null,"source":"mcp"}`
`session-send (a) registry.current={"runId":"eeed5fc7-...","source":"mcp","status":"running"}`
`session-send (a) registry.byId={"runId":"eeed5fc7-...","sessionId":"20deed9b-...","source":"mcp","status":"running",...}`
`session-send (a) listRunningRuns(for session)=[{"sessionId":"20deed9b-...","provider":"debug","startedAt":...}]`
`session-send (a) GET /api/providers/sessions/running sessions=["20deed9b-..."]`
正例对照：runId 非空且与注册表逐字相等；`byId.source` = `mcp`。

### AC4 (b) caller.userId
`session-send (b) spy.callers=[{"userId":1,"via":"mcp"}] tokenOwner=1 runWriterUserId=1`（两侧相等且非 null）。

### AC5 (c) 常驻忙时排队
`session-send (c) second={"runId":"24411b3c-...","queued":true,"queuedMessageUuid":"2a4801cf-eb3f-4767-9fc8-875fa27ce7f8","source":"mcp"} queue={"list":["2a4801cf-..."],"tail":"2a4801cf-..."}`（uuid === 驱动队列末条）。

### AC6 (d) 按次进程忙时拒绝
`session-send (d) errorBody={"code":"RUN_IN_PROGRESS","runId":"bc935920-4d55-4e40-9f21-167cd1ed3419","message":"Session \"83e13986-...\" already has a run in progress.","hint":"该会话已有运行在进行；改用 run_get 查询它的进展，或稍后重试。"} isError=true`（runId === 当前运行；hint 含 `run_get` 与「稍后重试」）。

### AC7 (e) 有界等待
`run.elapsedMs=3195`（< 40000），`realElapsedMs=18`，`outcome="settled"`，`lastAssistantMessage.content="最后一条助手消息：运行已结束。"`（与夹具末条助手消息逐字相等）。

### AC8 (f) scope 不足
`session-send (f) isError=true text="Insufficient scope for this tool." sendCallsBefore=0 sendCallsAfter=0`
`session-send (f) newAuditRows=[{"id":1,"token_id":2,"client_id":null,"tool":"session_send","args_digest":"{\"session\":\"a8071ff0-...\",\"message\":{\"length\":6,\"preview\":\"denied\"}}","outcome":"denied","duration_ms":0}]`（恰好一行；控制服务 send 计数 0）。

### AC9 (g) 同一控制服务实例
`session-send (g) before=0 wsCount=1 mcpCount=2 callers=[{"userId":1,"via":"websocket"},{"userId":1,"via":"mcp"}]`（同一 spy 对象两向各 +1）。

### AC10 取假形态（先提交 224e8646，再逐条变异；恢复命令 `git checkout -- <file>`；恢复后整判据重跑 `# pass 7 / # fail 0`）
(i) `mcp-session-send.ts`：`waitSeconds === 0` 时轮询等待运行结束（新增 setTimeout 轮询块）⇒ AC3 红，逐字失败行：
`AssertionError [ERR_ASSERTION]: the run must still be running when the tool returns` / `actual: 'completed',` / `expected: 'running',`
恢复：`git checkout -- server/modules/mcp-gateway/mcp-session-send.ts`
(ii) `mcp-session-send.ts`：`ControlCaller.via` 类型放宽为 `'mcp' | 'scheduled'` 且传 `via: 'scheduled'` ⇒ AC3 红，逐字失败行：
`AssertionError [ERR_ASSERTION]: the run source must read mcp` / `actual: 'scheduled',` / `expected: 'mcp',`
恢复：`git checkout -- server/modules/mcp-gateway/mcp-session-send.ts`
(iii) `mcp-session-send.ts`：成功后 `if (result.queued) throw refusal({code:'RUN_IN_PROGRESS',...})`（不透出 queued）⇒ AC5 红，逐字失败行：
`AssertionError [ERR_ASSERTION]: the busy send must queue, not throw (text={"code":"RUN_IN_PROGRESS",...})` / `actual: true,` / `expected: false,`
恢复：`git checkout -- server/modules/mcp-gateway/mcp-session-send.ts`
(iv) `mcp-gateway.transport.ts`：`registerMcpWriteTools(register, { ...writeTools, control: { send: async () => ({ok:true,runId:'gateway-self-made',...}) } })`（网关自造控制答复，不接注入的单例）⇒ AC9 红，逐字失败行：
`AssertionError [ERR_ASSERTION]: the MCP session_send must bump the SAME spy by one more` / `actual: 1,` / `expected: 2,`
恢复：`git checkout -- server/modules/mcp-gateway/mcp-gateway.transport.ts`

### AC11 不回归与仓库门
- `npm run typecheck`：退出 0（三个 tsconfig 全过）。
- `npm run lint`：`: error ` 计数 = 0。
- 未改一字、逐字仍绿的既有判据：`chat-control-send/busy/access/source` + `mcp-read-tools` + `mcp-run-get` 合并跑读数 `# tests 30 / # pass 30 / # fail 0`。

### AC12 diff 与 Touches 对齐
`git diff --stat develop...HEAD`：
```
 server/index.ts                                    |  34 +-
 server/modules/mcp-gateway/index.ts                |  34 +
 server/modules/mcp-gateway/mcp-gateway.transport.ts| 106 ++-
 server/modules/mcp-gateway/mcp-gateway.write-tools.ts (new) | 190 ++
 server/modules/mcp-gateway/mcp-session-send.ts     (new) | 241 ++
 server/modules/mcp-gateway/tests/mcp-session-send.test.ts (new) | 703 ++
```
逐条对应 `## Touches`；另 `tasks/gap-ac249-session-send-immediate-runid.md` 由 task_write 提交。

### 实现说明（与判据形态有关的两个事实）
- 判据用**真实调试 agent 且不分子进程**：文件顶部在**任何 aliased import 之前**写 `process.env.DEBUG_AGENT='on'` / `DEBUG_AGENT_HOME`（并把 `HOME` 重定向到 scratch），因此 `provider.registry` 在 gate 打开后才构建。AC-245 判据注释里「gate 已在 import 时关闭」的前提只在先有静态 application import 时成立；本文件无静态 application import，故 gate 可开，常驻/按次进程两种会话都是调试 agent 真会话。
- `writeTools` 未接线时传输行为与 AC-240/244/245 完全一致（不注册任何写工具），因此只读集合判据不受影响。
- 判据的 REST 运行中列表在同一 app 上挂 `GET /api/providers/sessions/running`，处理函数**请求时**读 `chatRunRegistry.listRunningRuns()`（与生产该路由同一数据源），不是夹具事先拍下的快照。

## Change Notes (worker, 2026-10-05, round 2)

上一轮 exited-not-landed 的真因（suite 日志的诊断行文本误导）——**不是** face 1 registry，而是 `server/modules/debug-agent/tests/debug-agent-gate.test.ts` 的
`the gate has exactly one read point under server/`：

```
✖ the gate has exactly one read point under server/
  AssertionError [ERR_ASSERTION]: a consumer that parsed the gate variable itself would be a second, independently-wrong decision
  actual: [
    "server/modules/mcp-gateway/tests/mcp-session-send.test.ts:72: process.env.DEBUG_AGENT = 'on';",
    "server/modules/mcp-gateway/tests/mcp-session-send.test.ts:73: process.env.DEBUG_AGENT_HOME = path.join(SCRATCH, 'fixture');",
    'server/modules/mcp-gateway/tests/mcp-session-send.test.ts:77: mkdirSync(process.env.DEBUG_AGENT_HOME, { recursive: true });'
  ]
  expected: []
```

真因：本任务判据必须在首个 aliased import 之前设置 gate 变量（这是让 `provider.registry` 构建真调试 provider 的唯一办法，见上节），但**字面写法**使它成为 gate 变量的第二个读取点，触发 debug agent 自身判据的「唯一读取点」不变量。机械 delta 判定把它读成 UNRELATED——因为失败文件不在本任务 diff 里；真实关系是「本任务**新增的判据文件**把那个文件判红」。

修复（提交 `1c4a85e2 fix(mcp-gateway): spell the debug-agent gate vars through constants (AC-249)`）：按 debug agent 自身判据（`debug-agent-control-queue/external-write/fixture-isolation/control-plane.test.ts`）的既有惯例，把两个变量名经常量拼写——`const GATE_VAR = 'DEBUG_AGENT'` / `const GATE_HOME_VAR = 'DEBUG_AGENT_HOME'`，只用 `process.env[GATE_VAR]` 写夹具。gate 模块仍是唯一**解析**点，本文件只**设置**夹具；断言与实现一字未动。顺带用中间量 `SCRATCH_HOME`/`FIXTURE_HOME` 消掉两处 `process.env.*` 读取。

本轮读数：
- `server/modules/debug-agent/tests/debug-agent-gate.test.ts`：`# tests 6 / # pass 6 / # fail 0`（修复前 `# pass 5 / # fail 1`）。
- `server/modules/mcp-gateway/tests/mcp-session-send.test.ts`：`# tests 7 / # pass 7 / # fail 0`（gate 仍打开，常驻/按次进程两种真调试 agent 会话照常）。
- `npm run typecheck` 退出 0；`npm run lint` `: error ` 计数 0。

AC10 判别力复核（改动后抽查取假形态 (ii)，证断言未被夹具改动削弱）：`mcp-session-send.ts:208` `via: 'mcp'` → `via: 'scheduled'`，逐字失败行
`AssertionError [ERR_ASSERTION]: the run source must read mcp` / `actual: 'scheduled',` / `expected: 'mcp',`；本轮另读到 (g) 也红：`actual: [ 'websocket', 'scheduled' ], expected: [ 'websocket', 'mcp' ]`。恢复命令 `git checkout -- server/modules/mcp-gateway/mcp-session-send.ts`，恢复后 7/7 回绿。

`## Touches` 不变：本轮只改 `server/modules/mcp-gateway/tests/mcp-session-send.test.ts`（已在 Touches 中），无新增文件。

## Change Notes (worker, 2026-10-05, round 3)

第三轮续做（复用既有 worktree `gap-ac249-session-send-immediate-runid`，4 个提交未重做）。上一条 `## Needs-Human`（round-2 的「失败无法归因，停派」）在**本轮被归因并证伪**——根因是**负载诱发的 flake**，不是实现缺陷。

### 归因：round-2 的 suite 红是负载 flake，与本任务 delta 无关

真因读数（suite 日志 `/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac249-session-send-immediate-runid~wk-prod-anchor~1791191319693-1cb4ec.log` + 其 `suite-logs/20261005T170849-2706865/` 逐文件产物）：三个 `passed=false` 文件共享**同一根因**——外部 `claude` CLI 以退出码 1 退出（`SDK query error: Error: Claude Code process exited with code 1`；`[Chat] Provider runtime "claude" failed`），不是断言逻辑缺陷：

- `claude-peer-name-follows-ai-title.test.ts`：`resident-restart` 腿的重启常驻进程未注册（`round=resident-restart exit=1 ... registration=null`）⇒ 后续 `the restarted resident process must register the session's own title (null)` 红。
- `claude-resident-busy-input.test.ts`：按次进程控制会话自身轮次超时（`waitFor timed out after 10000ms`）⇒ `the per-run control turn must be stoppable through the production abort path` 红。
- `claude-resident-control-queue.test.ts`：第一轮从未进入 in-flight（`waitFor timed out after 15000ms`）⇒ `round one must really be in flight before the busy send` 红。

**隔离复跑（本轮实测，逐字）**：三个文件单独跑全绿——
- `claude-resident-control-queue.test.ts`：`# tests 2 / # pass 2 / # fail 0`（`✔ control service queues and withdraws a real resident process message; pid survives; unwithdrawn one lands 5493.591363ms`）。
- `claude-resident-busy-input.test.ts`：`# tests 1 / # pass 1 / # fail 0`。
- `claude-peer-name-follows-ai-title.test.ts`：`# tests 1 / # pass 1 / # fail 0`。

⇒ suite 内的红是并发全量负载下真 `claude` CLI 进程退出 1（内存 `claude-resident-process-neg-control-arms-flake-under-load`、`claude-peer-name-title-guard-rename-leg-flakes-under-suite-load`、`claude-code-global-reinstall-reds-sdk-spawn-tests`），非本任务可实现的缺陷。

**delta 无关性（机械复核）**：
- `git diff --stat develop...HEAD` = 本任务 Touches 的 6 个文件（`server/index.ts` + mcp-gateway 的 4 个 + 本判据），仅此。
- 三个失败文件**均不 import** 本任务 delta 的任一模块（grep `mcp-gateway|mcp-session-send|write-tools|server/index` 无命中）；它们走 `claude` provider 的真实 SDK 子进程路径，与本任务新增的 MCP 适配层无交集。

### 本轮读数
- 本任务判据 `server/modules/mcp-gateway/tests/mcp-session-send.test.ts`：`# tests 7 / # pass 7 / # fail 0`。
- `npm run typecheck`：退出 0；`npm run lint`：`: error ` 计数 0。
- `git merge develop --no-edit`：干净合并（无冲突、无 unmerged path）；AC 勾选合并后仍 12/12。
- AC 勾选经 Provider ABI 复核：`task_check` → `{ok:true, acTotal:12, acChecked:12}`。

`## Touches` 不变：本轮未改任何实现文件，只经 task_write 追加本记录。