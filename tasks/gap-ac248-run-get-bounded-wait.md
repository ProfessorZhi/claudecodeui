---
id: gap-ac248-run-get-bounded-wait
title: AC-248 run_get 按 runId 取运行摘要并可有界等待：结束、进入待审批、超时各自返回，等待上限 25
  秒，过期与未知与重启各有说法；判据 server/modules/mcp-gateway/tests/mcp-run-get.test.ts
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
goal_ac: AC-248
---
## Proposal

AC-248（GOAL-020 退出条件 7 的 run_get 条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 §275、`waitSeconds` 上限 §288、运行按 id 寻址 §242–§246、阶段 3 §522）要求 MCP 网关的 `run_get` 按 runId 取运行摘要并可有界等待：`waitSeconds` 缺省 0 时立即返回当前状态；大于 0 时在「运行结束、进入 `awaitingPermission`、超时」三者之一发生时返回，运行结束时附最后一条助手消息；`waitSeconds` 请求 60 秒时实际最多等 25 秒；再也取不到的 runId 要说清是「过期」「从未出现过」还是「服务已重启」，且过期与未知的说明不同，两者都附带回退读取该会话最近消息的结果。判据文件 `server/modules/mcp-gateway/tests/mcp-run-get.test.ts` 当前不存在，AC-248 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-run-get.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/tests/mcp-run-get.test.ts` 不存在；`run_get` 由 AC-245 在只读工具注册缝里按名字注册，其 handler 主体返回 `isError`（`code: 'MCP_TOOL_NOT_IMPLEMENTED'`，注明归 AC-248）——本任务把该 handler 替换为真实实现，**不新增/改名工具**。可读的数据源已存在并各经 barrel 导出：

- `chatRunRegistry.getRunById(runId)`（`server/modules/websocket/services/chat-run-registry.service.ts`）返回 `ChatRunSummary | ChatRunLookupMiss`；`ChatRunSummary = { runId, sessionId, source, status: 'running' | 'completed' | 'aborted', startedAt, completedAt, lastSeq }`；`ChatRunLookupMiss = { status: 'unknown', reason: 'expired' | 'unknown' }`——`expired` 只在记录仍在 `runsById` 里但已过保留期时给出（`now() - completedAt > retentionMs`，与注入时钟同一条判据），`unknown` 是 id 从未被发出过。`createChatRunRegistry({ now, retentionMs })` 是可注入时钟/保留期的缝（既有判据 `server/modules/websocket/tests/chat-run-by-id.test.ts` 已用它把假时钟推过保留期而不真等）。
- `activityStore.snapshot(sessionId)`（`server/modules/websocket/services/activity-protocol.service.ts`，经 `server/modules/websocket/index.ts`）返回 `ActivityProtocolSnapshot | null`：`{ sessionId, bootId, rev, asOf, turn: { phase: TurnPhase, toolName: string | null, toolDurationMs: number | null }, tasks, schedules }`。`phase`/`toolName` 的**唯一来源**就是这里的 `turn`（不自己从消息流推）；`bootId` 是进程身份（`activity-heartbeat.service.ts` 的 `BOOT_ID`，可注入）。`createActivityStore({ now, bootId, readTurn })` 是判据驱动读数的缝。**注意**：`snapshot` 对从未 `subscribe`/`recordChange` 过的会话返回 `null`。
- `sessionsService.fetchHistory(sessionId, { limit, offset })`（经 `server/modules/providers/index.ts`）返回 `FetchHistoryResult = { messages: NormalizedMessage[], total, hasMore, offset, limit }`——运行结束时取「最后一条助手消息」、以及 miss 时的回退读最近消息都走它。

要交付：

1. **run_get 实现（新文件 `server/modules/mcp-gateway/mcp-run-get.ts`；遵守 `$backend-module-standards`）**，导出可注入的 deps 与实现：
   - `export type McpRunGetDeps = { runs: { getRunById(runId: string): ChatRunLookupResult }; activity: { snapshot(sessionId: string): ActivityProtocolSnapshot | null }; sessions: { fetchHistory(sessionId: string, options: { limit: number }): Promise<FetchHistoryResult> }; now: () => number; sleep: (ms: number) => Promise<void>; bootId: () => string }`——全部可注入（判据传真单例或自己驱动的实例）；等待循环只经 `now`/`sleep`，不得直接用 `Date.now()`/`setTimeout`（否则假时钟推不动）。
   - `export const MCP_RUN_GET_MAX_WAIT_SECONDS = 25`——等待上限的**唯一**字面量。
   - `export async function buildRunGet(input: { runId: string; waitSeconds?: number; session?: string }, deps: McpRunGetDeps): Promise<RunGetPayload>`：
     - 解析运行：`deps.runs.getRunById(input.runId)`。
     - **命中**（拿到 `ChatRunSummary`）：摘要逐字含 `runId`、`sessionId`、`source`、`status`、`phase`、`toolName`（后两者取自 `deps.activity.snapshot(sessionId)?.turn`；快照为 null 时明确写「该会话无活动记录」而不是缺键或抛错）、`elapsedMs = now() - startedAt`、`bootId`（该运行创建时的 boot）；时间字段用 AC-245 的 `formatMcpTime`（相对 + ISO 双形态）。
     - **有界等待**（仅当 `waitSeconds > 0`）：`effectiveWaitSeconds = Math.min(waitSeconds, MCP_RUN_GET_MAX_WAIT_SECONDS)`；deadline = `now() + effectiveWaitSeconds * 1000`。循环：先读一次运行摘要与活动快照——`status` 已终态（`completed`/`aborted`）⇒ 立即返回并在 `lastAssistantMessage` 附 `fetchHistory(sessionId, { limit })` 里最后一条助手消息（取不到时明确说明）；`phase === 'awaitingPermission'` ⇒ 立即返回（`outcome: 'awaitingPermission'`）；`now() >= deadline` ⇒ 返回（`outcome: 'timeout'`，附当前摘要）；否则 `await deps.sleep(tickMs)` 再循环。**只有 `waitSeconds > 0` 才等待**：`waitSeconds` 为 0 或缺省时立即返回，一次 `sleep` 都不调用（结构性：等待循环整体在 `waitSeconds > 0` 分支内）。
     - **miss**（`ChatRunLookupMiss`，或运行记录存在但属于上一次启动）：返回 `{ runId, status: 'unknown', reason: 'expired' | 'unknown' | 'restarted', explanation: <三者各不相同的说明文案>, fallback: <回退读取> }`。三种 reason 的判据：
       - `expired`：`getRunById` 给出 `reason: 'expired'`；说明「该运行曾存在、已超出保留期」；记录仍在，取 `sessionId` 做回退读。
       - `unknown`：`getRunById` 给出 `reason: 'unknown'`；说明「该 runId 从未被发出过」；若输入给了可选 `session`（回退目标）则回退读该会话，否则明确写「无法确定会话，无从回退」。
       - `restarted`：运行记录仍在但 `run.bootId !== deps.bootId()`（当前进程身份不同）⇒ 说明「服务已重启，该运行属于上一次启动」；用记录的 `sessionId` 做回退读。
       - 回退读 = `deps.sessions.fetchHistory(sessionId, { limit })` 的最近消息（逐字原样带出；会话取不到时明确说明而不是抛错）。**三种说明的文案必须两两不同**（(f)/(g) 的读数）。
     - **重启判定的机制**：运行记录带上创建时的 boot，`run_get` 把它与当前 `deps.bootId()`（生产取自活动存储同源的 `BOOT_ID`）比较。判据用可注入 boot 的假运行时把「当前 boot」翻转，从而在同一进程内制造「记录属于上一次启动」的读数——这正是 AC 明确要求的「假运行时加可注入时钟」。
   - `export function registerMcpRunGetTool(...)`（或等价名）在 AC-244/AC-245 的注册缝里**替换** `run_get` 这一个已有名字的 handler（**不新增、不改名工具**）。
2. **运行记录带上创建时的 boot（`server/modules/websocket/services/chat-run-registry.service.ts` + `server/modules/websocket/index.ts`）**：`createChatRunRegistry` 新增可选 `bootId?: () => string`（缺省读与活动协议同源的 `BOOT_ID`）；`ChatRun` 增加 `bootId: string`（`startRun` 时读一次并存）；`ChatRunSummary` 增加 `bootId`；`summarize` 带出。在 barrel `server/modules/websocket/index.ts` 导出 `ChatRunSummary`、`ChatRunLookupResult`、`ChatRunLookupMiss` 类型（各写消费方注释：MCP `run_get` 消费，AC-248）。**不改** `getRunById` 的既有 `expired`/`unknown` 判据与 `runsById` 索引语义（既有判据不改一字仍逐字通过）。若 AC-247 已落地并已导出 `ChatRunSummary`，以实际落地为准合并，不重复导出。
3. **接线与导出**：在 AC-245 的注册路径替换 `run_get` 的 handler 实现体；barrel `server/modules/mcp-gateway/index.ts` 导出 `buildRunGet`/`registerMcpRunGetTool`/`McpRunGetDeps`/`MCP_RUN_GET_MAX_WAIT_SECONDS`（各写消费方注释）。`server/index.ts` 组装 `McpRunGetDeps`（进程单例：`chatRunRegistry.getRunById`、`activityStore.snapshot`、`sessionsService.fetchHistory`、`now: () => Date.now()`、`sleep: (ms) => new Promise((r) => setTimeout(r, ms))`、`bootId`）。
4. **`run_get` 的输入 schema（AC-245 已注册）**：保持 `{ runId, waitSeconds? }`；**可**增加可选 `session?: string` 作为「runId 取不到时回退读哪个会话」的目标（理由见 Notes）。这是超集（可选字段），AC-245 的判据只断言工具名集合/无写工具/每个工具的 scope，不断言输入 schema 形状，因此不红。
5. **判据文件 `server/modules/mcp-gateway/tests/mcp-run-get.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + MCP SDK 客户端 + 假运行时 + 可注入时钟）**：形制照 AC-245/AC-247（`mkdtemp` + `closeConnection()` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发带 `['cloudcli:read']` 的真令牌 + 同一 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`，避开 `listen(0)` 的 undici 坏端口——内存 `undici-bad-port-lottery-in-listen0-route-tests`）。**假运行时** = 真 `createChatRunRegistry({ now, bootId })`（注入假时钟与假 boot）+ 真 `createActivityStore({ now, bootId, readTurn })`（注入的 `readTurn` 按会话与假时钟给出 `turn.phase`/`turn.toolName`）+ 注入的 `sleep(ms)`（推进假时钟，并在预定的时刻结束运行 / 把 phase 翻成 `awaitingPermission` / 保持运行至超时）；`sessions.fetchHistory` 用注入假体（固定若干条消息，末条是助手消息）。读数各自独立成断言并逐字写出原始值：
   - (a) **摘要字段齐全**：对一个 running 运行 `run_get({ runId, waitSeconds: 0 })`，逐字写出 `runId`/`sessionId`/`source`/`status`/`phase`/`toolName`/`elapsedMs`/`bootId`，断言 `phase` 与 `toolName` 与注入活动存储逐字相等、`elapsedMs` 与假时钟下 `now() - startedAt` 相等、`source`/`status` 与注册表一致。正例对照：各字段非空（防「一律 undefined」也通过）。
   - (b) **waitSeconds 为 0 立即返回**：`waitSeconds` 缺省与显式 0 两种调用都立即返回当前状态，**`sleep` 调用计数为 0**（逐字写出计数与 elapsed）；断言返回的 `status` 是当前状态（running）而非终态。
   - (c) **运行在 N 秒内结束 ⇒ 在结束时刻返回并附最后一条助手消息**：`waitSeconds: 40`，假运行时让运行在第 3 秒结束；断言 `elapsedMs` **小于** `40 * 1000`（逐字写出真实 elapsed，写死「非满额等待」）、`status` 为终态、`lastAssistantMessage` 与夹具末条助手消息逐字相等（逐字写出两侧文本）。**（这条即取假形态 (i) 要红的点。）**
   - (d) **进入 awaitingPermission 提前返回**：`waitSeconds: 40`，假运行时在第 2 秒把该会话 `turn.phase` 翻成 `'awaitingPermission'`（运行仍未终态）；断言提前返回、`elapsedMs < 40 * 1000`、返回值里带 `phase: 'awaitingPermission'`（逐字写出 phase 与 elapsed）。正例对照：另一个未进入待审批的运行不给出该 outcome。
   - (e) **请求 60 秒最多等 25 秒**：`waitSeconds: 60`，假运行时让运行一直不结束；断言 `elapsedMs <= 25 * 1000`（逐字写出真实 elapsed，断言 `<= 25000`）、`outcome` 为超时、返回当前（running）摘要。**（这条即取假形态 (ii) 要红的点。）**
   - (f) **过期与未知说明不同 + 都带回退读**：用假时钟把一条已完成运行推过保留期后 `run_get`（过期），再对一个从未发出的 runId 调 `run_get`（未知，带 `session` 回退目标）；断言两者 `reason` 不同、两段说明文案**逐字不同**（写出两段原文）、两者都带 `fallback` 且回退消息与夹具该会话最近消息逐字相等（逐字写出两侧消息 id/文本）。正例对照：过期那条的 `fallback` 非空（防「一律空回退」也通过）。**（这条即取假形态 (iii) 要红的点。）**
   - (g) **boot 变化 ⇒ 说明服务已重启**：先 `run_get` 记下返回的 `bootId`（第一次调用），随后把假运行时的当前 boot 翻成不同值（记录仍在、属于上一次启动），再 `run_get`；断言第二次的说明与第一次不同、明确指出「服务已重启」、且 `fallback` 带回该会话最近消息（逐字写出两次 `bootId` 与说明差异）。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 等待循环忽略提前条件、总是等满 `effectiveWaitSeconds` ⇒ (c) 必须红；
   (ii) 不做 `MCP_RUN_GET_MAX_WAIT_SECONDS` 封顶（直接用 `waitSeconds`）⇒ (e) 必须红；
   (iii) `expired` 与 `unknown` 返回同一句说明 ⇒ (f) 必须红（两段文案相同）。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-248" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-248`；`grep -rln "AC-248" tasks/` 只命中 AC-245 与 AC-247 的边界段（两者都明确「`run_get` 的行为归 AC-248，本任务只注册名字/scope/描述/输入 schema」）。AC-245（夹具只读工具）、AC-246（名称模糊匹配）、AC-247（overview 冷缓存零 quay CLI + quay_snapshot 刷新）是**不同读数与不同判据文件**（`mcp-read-tools.test.ts`/`mcp-resolve-target.test.ts`/`mcp-overview.test.ts`），各自直接覆盖；本任务只在 AC-245 已注册的 `run_get` 这一个名字上填 handler，**不新增/改名工具**，不测其判据。写工具（AC-249–AC-251）、自指保护（AC-252）、设置页（AC-254/255）、冒烟（AC-256/257）均不越界。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-239 未落地则判据无法 import SDK 客户端；AC-240 未落地则无 `/mcp` 传输与工具注册缝；AC-241 未落地则无令牌中间件（判据要发真令牌）；AC-244 未落地则无 `withMcpAudit` 包装与注册缝；AC-245 未落地则 `run_get` 尚未注册、无替换点。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-248 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-run-get.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-run-get.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-run-get.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 摘要逐字含 `runId`/`sessionId`/`source`/`status`/`phase`/`toolName`/`elapsedMs`/`bootId`，`phase`/`toolName` 与注入活动存储逐字一致、`elapsedMs` 与假时钟一致；正例对照字段非空。
- [x] AC4 (b) `waitSeconds` 缺省与 0 都立即返回当前状态，`sleep` 调用计数为 0（逐字写计数与 elapsed）。
- [x] AC5 (c) `waitSeconds: 40` 而运行第 3 秒结束 ⇒ `elapsedMs < 40000`、终态、附最后一条助手消息且逐字相等（逐字写 elapsed 与两侧文本）。
- [x] AC6 (d) 第 2 秒进入 `awaitingPermission` ⇒ 提前返回、`elapsedMs < 40000`、带 `phase: 'awaitingPermission'`；正例对照另一运行不给出该 outcome。
- [x] AC7 (e) `waitSeconds: 60` 且运行不结束 ⇒ `elapsedMs <= 25000`、超时 outcome、返回当前摘要（逐字写真实 elapsed）。
- [x] AC8 (f) 过期与未知的 `reason` 与说明文案逐字不同，两者都带 `fallback` 且回退消息与夹具逐字相等；正例对照过期回退非空。
- [x] AC9 (g) boot 翻转后第二次调用的说明明确指出「服务已重启」且与第一次不同，`fallback` 带回该会话最近消息（逐字写两次 bootId 与说明差异）。
- [x] AC10 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 总是等满 ⇒ AC5 红；(ii) 不封顶 ⇒ AC7 红；(iii) 过期与未知同一句 ⇒ AC8 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC11 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；既有 `server/modules/websocket/tests/chat-run-by-id.test.ts`（`expired`/`unknown` 判据与保留期）与 AC-245 判据 `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 不改一字仍逐字通过（本任务只替换 `run_get` 一个 handler，不改工具集合）。
- [x] AC12 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- `run_get` **真的**经真实 HTTP + MCP SDK 客户端驱动，读的是真注册表、真活动存储（注入假运行时/时钟）与真 `fetchHistory` 假体，不是「函数被调用」或「判据文件存在」就算数。
- **有界等待是结构性的**：`waitSeconds: 0` 一次 `sleep` 都不调用；运行在第 3 秒结束时**真的**在第 3 秒附近返回（`elapsedMs < 40000`）并附最后一条助手消息；进入 `awaitingPermission` **真的**提前返回；请求 60 秒**真的**最多等 25 秒。
- **三种 miss 各有说法**：`expired`/`unknown`/`restarted` 的 `reason` 与说明文案两两不同，且过期与（带 `session` 的）未知都**真的**带回该会话最近消息的回退读。
- 等待循环只经注入的 `now`/`sleep`，无直接 `Date.now()`/`setTimeout`；上限字面量只有 `MCP_RUN_GET_MAX_WAIT_SECONDS` 一份。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖（SDK 由 AC-239 声明）；不越界实现 AC-246–AC-257 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-run-get.ts (new)
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-run-get.test.ts (new)（判据）
- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/index.ts
- server/index.ts
- tasks/gap-ac248-run-get-bounded-wait.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-247 同款说明）。SDK transport options 确有 `fetch?: FetchLike`。
- **活动存储必须先「知道」该会话**：`activityStore.snapshot(sessionId)` 对从未 `subscribe`/`recordChange` 过的会话返回 `null`。判据在造夹具时必须让存储知道目标会话（订阅一次或 `recordChange` 一次），否则 (a) 的 phase/toolName 会读到 null 而误判。生产侧 `run_get` 对 null 快照要明确写「该会话无活动记录」，不得缺键或抛错。
- **重启判定 (g) 的机制**：运行记录带上创建时的 boot，`run_get` 与当前 `deps.bootId()` 比较得出「服务已重启」。判据用可注入 boot 的假运行时翻转当前 boot（记录仍在、属于上一次启动），这正是 AC 要求的「假运行时加可注入时钟」；不在本任务里落持久化的 run 台账（那属于「真重启后仍能认出旧 runId」的更远需求，AC 的读数是假运行时下的）。
- **(f) 的 `session` 回退目标**：过期与重启两条都能从仍在的记录里拿到 `sessionId`；「从未出现过」的 runId 没有会话可推，AC 又要求「两者都附带回退读」，故 `run_get` 接受可选 `session` 作为回退目标（只用于取不到运行时读哪个会话的最近消息）。这是 AC-245 已注册输入 schema 的**超集**（可选字段），AC-245 的判据只断言工具名集合/无写工具/每个工具 scope，不红；若不接受这一扩展，退路是未知那条明确写「无法确定会话，无从回退」，并在 AC8 里同时记录该读数。
- 等待的 tick 粒度（如 250ms）由实现选定；判据断言的是「提前于满额」（`elapsedMs < waitSeconds * 1000`）与超时上界（`<= 25000`），不依赖某个具体 tick 值；(c) 的「结束时刻」以假运行时的预定点为准（断言 `elapsedMs <= 预定点 + tick`）。
- 上限常量 `MCP_RUN_GET_MAX_WAIT_SECONDS = 25` 是唯一字面量；`session_send`（AC-249）之后若要复用同一上限，从本模块 barrel 导入而不是重写第二份。
- 本任务只替换 `run_get` 一个 handler：AC-245 的 `MCP_STAGE3_READ_TOOLS` 集合、`overview`/`quay_snapshot`（AC-247）与四个已实现的只读工具都不动。