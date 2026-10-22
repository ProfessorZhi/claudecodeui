---
id: gap-ac274-mcp-approvals
title: AC-274 审批：approvals_list 列出待审批并展开 AskUserQuestion 的问题与选项（含 input
  摘要、已等待时长），approval_answer 以 allow 决定调用 resolveToolApproval 并转发 message、answers
  作为 updatedInput；过期/不存在明确「已过期或不存在」且不调解析；需 cloudcli:approve，无 scope 被拒并写 denied
  审计；overview 的 awaitingPermission 与待审批一致；判据
  server/modules/mcp-gateway/tests/mcp-approvals.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac271-mcp-session-cancel-queued
  - gap-ac272-mcp-session-reconfigure
  - gap-ac273-mcp-session-background
  - gap-ac249-session-send-immediate-runid
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac241-mcp-token-auth-shares-service
  - gap-ac247-overview-quay-cache-readonly
goal_ac: AC-274
---
## Proposal

AC-274（GOAL-022 退出条件 4；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 `approvals_list` §285、`approval_answer` §286、scope 表 §330「`cloudcli:approve` → `approval_answer`」、阶段 6 §525）要求 MCP 网关的两个审批工具：

- `approvals_list({ session? })`（scope `cloudcli:read`）：有待审批时返回 `requestId`、会话、工具名、输入摘要、已等待时长；`AskUserQuestion` 展开成问题文本与各选项；
- `approval_answer({ requestId, allow, answers?, message? })`（scope `cloudcli:approve`）：`allow:true`/`allow:false` 以对应决定调用运行时 `resolveToolApproval`；带 `message` 时一并转发；`AskUserQuestion` 的 `answers` 作为 `updatedInput` 转发；已过期（超过审批超时被自动拒绝）或不存在的 `requestId` 返回明确的「已过期或不存在」、不抛异常、不调用 `resolveToolApproval`；没有 `cloudcli:approve` 的令牌被拒并写 `denied` 审计；`overview` 里 `awaitingPermission` 的会话与这里的待审批一致。

判据文件 `server/modules/mcp-gateway/tests/mcp-approvals.test.ts` **当前不存在**，AC-274 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-approvals.test.ts`（已实测复现）。

现状（红态基线）：

- **MCP 工具层尚不存在**：`mountMcpGateway` 目前只注册空的 `tools/list`（`mcp-gateway.transport.ts:38`「No tools are registered yet — AC-245+ fills them」）；阶段 6 常驻工具集合 `MCP_STAGE6_RESIDENT_TOOLS` 与 `registerMcpResidentTools`（AC-271 建、AC-272/AC-273 追加）、`withMcpAudit`（AC-244）、只读/写工具注册缝（AC-245/AC-249）、`McpPrincipal`（AC-241）均未落地。`approvals_list`/`approval_answer` 在 `server/` 全库零命中（仅 SPEC §285–286/§330 与 `chat-control.service.ts:290` 的注释）。
- **控制服务尚无审批动词**：`createChatControlService`（`server/modules/websocket/services/chat-control.service.ts`）目前返回 `{ send, abort, cancelQueued, stopTask, backgroundTask }`（:623），其文档注释（:290）明说 `editSend`/`answerApproval`/`pendingApprovals`「arrive with a later AC」——本任务就是那个 later AC。SPEC §285–286 把两个工具的**背后服务**指到 `ChatControlService.pendingApprovals` / `ChatControlService.answerApproval`，故这两个动词由本任务在控制服务本体落地。
- **运行时审批缝已具备（本任务的数据源与调用点）**：
  - `ProviderRuntimeGateway`（`server/modules/websocket/services/chat-websocket.service.ts:200`）已声明 `resolveToolApproval(requestId, payload: ProviderPermissionDecision): void` 与 `getPendingApprovalsForSession(sessionId): unknown[]`；`providerRuntimeService`（`server/modules/providers/services/provider-runtime.service.ts:978/984`）把前者扇出到每个 provider 的 `runtime.permissions.resolve`，把后者扇出到 `listPending`。
  - claude 运行时（`server/modules/providers/list/claude/claude-runtime.provider.ts`）：`getPendingApprovalsForSession(sessionId)`（:2053）遍历模块级 `pendingToolApprovals: Map<requestId, resolver>`（:109），对 `_sessionId === sessionId` 的条目返回 `{ requestId, toolName, input, context, sessionId, receivedAt }`；`resolveToolApproval(requestId, decision)`（:287）只在 map 里有该 requestId 时调用 resolver，**缺失时静默无操作、不抛错、无返回**——「过期/不存在」因此**不能**靠调用它来判断，必须先查在册性。
  - 超时即过期：`waitForToolApproval`（:228）在 `TOOL_APPROVAL_TIMEOUT_MS`（:139，默认 55000）到点时 `finalize(null)` → `pendingToolApprovals.delete(requestId)`；交互工具（`AskUserQuestion`/`ExitPlanMode`，`TOOLS_REQUIRING_INTERACTION` :168）`timeoutMs: 0` 无限等。被自动拒绝 = 该 requestId 从在册集合里消失。
  - 决定类型 `ProviderPermissionDecision = { allow; updatedInput?; message?; rememberEntry? }`（`server/shared/types.ts:575`）。
  - WS 侧既有先例：`chat.permission-response` 处理器（`chat-websocket.service.ts:1508`）把 `{ allow, updatedInput, message, rememberEntry }` 交给 `runtime.resolveToolApproval`——MCP 的 `approval_answer` 与它打同一个 resolver，词表需自洽。
- **scope 词汇已含 `cloudcli:approve`**：`ACCESS_TOKEN_SCOPES`（`server/modules/oauth/access-tokens.service.ts:38`）的第五项就是 `'cloudcli:approve'`（:43），从 `@/modules/oauth/index.js` barrel 导出。
- **`overview` 由 AC-247 交付**（`gap-ac247-overview-quay-cache-readonly`，todo）：其 `awaitingPermission` 会话取自 `activityStore.snapshot(sessionId).turn.phase === 'awaitingPermission'`（`claude-turn-phase.service.ts:48/51`），与审批在册集合是两个源；AC-274 的读数 (f) 要求两者一致。

要交付：

1. **控制服务审批动词（改 `server/modules/websocket/services/chat-control.service.ts`；遵守 `$backend-module-standards`）**：给 `createChatControlService` 增加两个动词，并在 :623 的返回对象里接上（`{ send, abort, cancelQueued, stopTask, backgroundTask, pendingApprovals, answerApproval }`）。两者都先过共享访问入口 `accessEntry(deps)`（与既有五个动词同一个 `assertSessionAccess` / 注入缝，:270），不新增第二个鉴权面：
   - `async function pendingApprovals(caller: ControlCaller, input: { sessionId?: string }): Promise<PendingApprovalsResult>`：
     - 带 `sessionId`：`sessionsDb.getSessionById(sessionId)`；`accessEntry` 拒绝 ⇒ `'forbidden'`；会话不存在 ⇒ `'SESSION_NOT_FOUND'`；否则 `deps.runtime.getPendingApprovalsForSession(sessionId)` 原样返回。
     - 省略 `sessionId`：对候选会话集合（默认 `chatRunRegistry.listRunningRuns().map(r => r.sessionId)`，即「运行中会话」——待审批只可能在有在飞回合的会话上；为可注入，deps 加可选 `listApprovalSessionIds?: () => string[]`，默认读 `chatRunRegistry`）逐个过 `accessEntry`，把可访问会话的 pending 合并返回。
     - 返回条目原样保留 `{ requestId, toolName, input, context, sessionId, receivedAt }`（`receivedAt` 是 `Date`；适配层的「已等待时长」由它算）。
   - `async function answerApproval(caller: ControlCaller, input: { requestId: string; allow: boolean; answers?: unknown; message?: string }): Promise<AnswerApprovalResult>`：
     - **先查在册性**：在候选会话集合上扫 `deps.runtime.getPendingApprovalsForSession(sid)`，找到持有该 `requestId` 的条目与其 `sessionId`。**找不到** ⇒ 返回 `{ ok: false, code: 'APPROVAL_EXPIRED_OR_NOT_FOUND', message: '该审批请求已过期或不存在（可能已超时被自动拒绝）。' }`，**绝不调用 `deps.runtime.resolveToolApproval`**（(d) 的机制点）。
     - 找到 ⇒ 对该 `sessionId` 过 `accessEntry`；拒绝 ⇒ `'forbidden'`（结构化拒绝归 AC-232 的统一词表，本任务只保证不当作成功、不调 resolver）。
     - 通过 ⇒ `deps.runtime.resolveToolApproval(requestId, { allow: input.allow, updatedInput: input.answers, message: input.message })`——**`answers` 就是转发给运行时的 `updatedInput`**（(c) 的词表落点：`answers` 作为 `updatedInput` 转发）；`message` 带则转发。返回 `{ ok: true, requestId }`。
     - **不发明第三种词**：`resolveToolApproval` 无返回值，成功即「已转交」；`ok:false` 只在过期/不存在/拒绝时出现。
2. **MCP 适配层（新文件 `server/modules/mcp-gateway/mcp-approvals.ts`；遵守 `$backend-module-standards`，导出带消费方注释）**，导出可注入 deps 与实现：
   - `export type McpApprovalPending = { requestId: string; sessionId: string; toolName: string; input: unknown; receivedAt: Date }`。
   - `export type McpApprovalsDeps = { control: { pendingApprovals(caller, input): Promise<...>; answerApproval(caller, input): Promise<...> }; now(): number }`——真控制服务单例或判据注入的实例皆可；`now` 可注入以保证「已等待时长」可断言。
   - `export type McpApprovalListItem = { requestId: string; session: string; toolName: string; inputSummary: string; waitedMs: number; questions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }> }> }`。
   - `export async function buildApprovalsList(input: { session?: string }, ctx: { principal: McpPrincipal }, deps: McpApprovalsDeps): Promise<{ approvals: McpApprovalListItem[] }>`：
     - `caller = { userId: ctx.principal.userId, via: 'mcp' }`。
     - 逐条 pending 映射：`{ requestId, session: sessionId, toolName, inputSummary: summarize(input), waitedMs: deps.now() - receivedAt.getTime() }`。
     - `summarize(input)`：人类可读摘要——优先 `input.command` / `input.file_path` / `input.pattern` / `input.url` 等标量字段，否则 JSON 截断到约 200 字符；**不**把整块 input 原样塞回。
     - `toolName === 'AskUserQuestion'` 时**展开** `input.questions`：每问 `{ question: string, header?: string, options: Array<{ label: string, description?: string }> }`（选项取 `label`/`description`，保留 `multiSelect` 若在）。展开字段随条目一起返回（(a) 的「问题文本与各选项」）。
   - `export async function buildApprovalAnswer(input: { requestId: string; allow: boolean; answers?: unknown; message?: string }, ctx: { principal: McpPrincipal }, deps: McpApprovalsDeps): Promise<ApprovalAnswerPayload>`：
     - `caller = { userId: ctx.principal.userId, via: 'mcp' }`。
     - `const result = await deps.control.answerApproval(caller, { requestId, allow, answers, message })`。
     - 成功 ⇒ `{ ok: true, requestId, decision: allow ? 'allow' : 'deny' }`；`code === 'APPROVAL_EXPIRED_OR_NOT_FOUND'` ⇒ `{ ok: false, code: 'APPROVAL_EXPIRED_OR_NOT_FOUND', message }`——**逐字含「已过期或不存在」**；`'forbidden'` ⇒ 结构化拒绝（归 AC-232）。
   - `export function registerMcpApprovalTools(registrationSeam, deps: McpApprovalsDeps): void`：经 AC-244 的 `withMcpAudit` 注册 `approvals_list`（`requiredScopes: ['cloudcli:read']`）与 `approval_answer`（`requiredScopes: ['cloudcli:approve']`），scope 字面量从 `@/modules/oauth/index.js` 的 `ACCESS_TOKEN_SCOPES` 取（不重写）。
3. **阶段 6 常驻工具注册集合（改 `server/modules/mcp-gateway/mcp-gateway.resident-tools.ts`，AC-271 建、AC-272/273 已追加）**：向 `MCP_STAGE6_RESIDENT_TOOLS` 追加 `{ name: 'approvals_list', scope: 'cloudcli:read' }` 与 `{ name: 'approval_answer', scope: 'cloudcli:approve' }`，并在 `registerMcpResidentTools` 里接上第 2 条的注册（不重写集合、不改既有条目）。
4. **接线（`mcp-gateway.transport.ts` + `mcp-gateway/index.ts` + `server/index.ts`）**：`mountMcpGateway` 用 AC-249 已注入的**同一个**控制服务单例（不新建实例）；barrel 导出 `buildApprovalsList`、`buildApprovalAnswer`、`registerMcpApprovalTools`、`McpApprovalsDeps`、`McpApprovalListItem`，各写消费方注释；`server/index.ts` 把同一个 `chatControl` 实例与 `now: () => Date.now()` 交给审批 deps。**若 AC-245/AC-249/AC-271 落地的缝不允许在注册时注入 deps（需改 `server/index.ts` 或别的文件），先用 `task_write` 把该文件加进本任务 `## Touches` 再改**（`quay-touches-must-match-actual-write-sites`）。
5. **判据文件 `server/modules/mcp-gateway/tests/mcp-approvals.test.ts`（红先行）**：形制照 AC-245/AC-249/AC-273——`mkdtemp` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + 一个会话行 + `createAccessTokensService` 发**两枚**真令牌（`T_read` 带 `['cloudcli:read']`；`T_appr` 带 `['cloudcli:read','cloudcli:approve']`）+ 同一 express 4 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`（避开 `listen(0)` 的 undici 坏端口，内存 `undici-bad-port-lottery-in-listen0-route-tests`）。**审批源用「假运行时」**：一个暴露 `getPendingApprovalsForSession(sessionId)`（返回夹具 pending 列表）与 `resolveToolApproval(requestId, decision)`（记录每次收到的 `requestId`/`decision` 的**间谍**）的假运行时对象，接进**真** `createChatControlService({ runtime: fakeRuntime, ... })`；`now` 注入固定时钟。夹具 pending 至少含：(i) 一条普通工具（如 `Bash`，input `{ command: 'echo hi' }`，`receivedAt = now - 3000`）；(ii) 一条 `AskUserQuestion`（input `{ questions: [{ question: '选哪个？', header: '选择', options: [{ label: 'A', description: '甲' }, { label: 'B', description: '乙' }] }] }`）。读数各自独立成断言并逐字写出原始值：
   - (a) **approvals_list 读数与 AskUserQuestion 展开**：`T_read` 经 MCP `approvals_list({ session: S })` ⇒ 返回含两条，逐条写出 `{ requestId, session, toolName, inputSummary, waitedMs }`；普通条 `inputSummary` 含 `echo hi`、`waitedMs === 3000`；AskUserQuestion 条展开出 `questions[0].question === '选哪个？'`、`options` 的 `label`/`description` 逐字等于 `A/甲`、`B/乙`。正例对照：`approvals` 非空且**同时**含普通工具与 AskUserQuestion 两类（防「空列表」与「不展开」也通过）。
   - (b) **approval_answer 的 allow 决定与 message 转发**：`T_appr` 调 `approval_answer({ requestId: R_normal, allow: true })` ⇒ `isError` 为假；假运行时 `resolveToolApproval` 收到**恰好一次** `(R_normal, { allow: true, ... })`；再对另一 requestId `R2` 调 `approval_answer({ requestId: R2, allow: false, message: '不行' })` ⇒ 收到 `(R2, { allow: false, message: '不行' })`。逐字写出两次间谍读数。
   - (c) **answers 作为 updatedInput 转发**：对手头的 AskUserQuestion 条 `RA` 调 `approval_answer({ requestId: RA, allow: true, answers: { '选哪个？': 'A' } })` ⇒ 假运行时 `resolveToolApproval` 收到的 `decision.updatedInput` 逐字等于 `{ '选哪个？': 'A' }`（即 `answers` 被当作 `updatedInput` 转发）。逐字写出该 decision。
   - (d) **过期/不存在：明确说法、不抛异常、不调解析**：造一个「已过期」requestId `R_exp`——先在册（`approvals_list` 能看到），随后从假运行时的 pending 集合移除（模拟 `waitForToolApproval` 超时 `delete`），再调 `approval_answer({ requestId: R_exp, allow: true })` ⇒ 工具结果**不抛异常**（`isError` 为假或结构化错误体，非 5xx/异常）、message 逐字含「已过期或不存在」、假运行时 `resolveToolApproval` 对该 requestId 的调用计数为 **0**；再对一个从未存在的 `R_none` 同调 ⇒ 同款说法、计数 **0**。逐字写出两次返回与调用计数。
   - (e) **scope**：用只带 `['cloudcli:read']` 的令牌 `T_read` 调 `approval_answer({ requestId: R_normal, allow: true })` ⇒ 工具结果 `isError` 为真、`mcpAuditLogDb` 新增**恰好一行**且 `tool='approval_answer'`、`outcome='denied'`、假运行时 `resolveToolApproval` 调用计数为 **0**；随后用 `T_appr` 同调成功（正例对照：有 approve scope 时不被拒）。逐字写出该行与前后计数。
   - (f) **overview 的 awaitingPermission 与待审批一致**：经 MCP `approvals_list({})`（无 session，走运行中会话枚举）得到待审批会话集合；经 MCP `overview()`（AC-247）得到 `awaitingPermission` 会话集合；断言两个集合相等（逐字写出两侧集合）。夹具把注入的 activity 假体的 `turn.phase` 对同一会话置 `'awaitingPermission'`、假运行时的 pending 也归属该会话，使两个源都指向它；再放一个「无待审批」会话，断言它**不**出现在任一侧（防「一律全列」也通过）。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) **过期的请求仍调用解析**（`answerApproval` 去掉在册性预检，直接 `resolveToolApproval`）⇒ (d) 必须红（计数 ≥1、返回不再是「已过期或不存在」）；
   (ii) **`answers` 被丢弃**（`answerApproval` 不把 `input.answers` 放进 `updatedInput`）⇒ (c) 必须红（decision.updatedInput 为 undefined）；
   (iii) **不检查 approve scope**（`approval_answer` 的 `requiredScopes` 写成 `['cloudcli:read']` 或不声明）⇒ (e) 必须红（只读令牌不被拒、计数 ≥1、无 `denied` 审计行）。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。
6. **不回归与仓库门**：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写明计数）；AC-271 判据 `mcp-cancel-queued.test.ts`、AC-273 判据 `mcp-session-background.test.ts`、AC-249 判据 `mcp-session-send.test.ts`、AC-245 判据 `mcp-read-tools.test.ts`、AC-247 判据 `mcp-overview.test.ts` **不改一字**仍逐字通过；`server/modules/websocket/tests/chat-control-*.test.ts`、`claude-resident-permissions.test.ts`、`provider-runtime.service.test.ts` 不改一字仍逐字通过（控制服务新增动词不改既有五个的行为，`ProviderRuntimeGateway` 既有两缝签名不变）。跨模块只经 barrel。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: *AC-274" tasks/*.md | wc -l` → **0**；`grep -rln "AC-274" tasks/*.md | wc -l` → **1**，唯一命中 `gap-ac273-mcp-session-background.md` 的边界段，其原文为「不越界实现 AC-274–AC-277 的读数与判据」（声明非目标，不是认领）。本仓库无任何任务带 `goal_ac: AC-274` 或覆盖 MCP 审批工具机制。相关但不同：`gap-claude-resident-permission-interception`（AC-168，done）覆盖的是**常驻驱动**无人值守时三个需人回应入口的自动拒绝，不是 MCP 审批工具；`gap-ac231-control-busy-queue-cancel`/`gap-ac232-control-shared-access-entry` 覆盖控制服务既有动词与共享访问入口。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-271/AC-272/AC-273 未落地则无 `mcp-gateway.resident-tools.ts` 阶段 6 注册缝与集合（本任务向集合追加，紧跟 AC-273 之后避免并发改同一文件）；AC-249 未落地则无写工具注册先例与单例控制服务接线；AC-245 未落地则无只读工具缝与 MCP 客户端夹具形制；AC-244 未落地则无 `withMcpAudit` 包装与 `denied` 审计（(e) 依赖它）；AC-241 未落地则无 `McpPrincipal` 与 `scopes`（(a)/(e) 要发真令牌读主体）；AC-247 未落地则 `overview` 工具不存在，(f) 的 `awaitingPermission` 无读数对象。AC-232（控制服务共享访问入口）不列为硬前置：该入口已存在（`chat-control.service.ts:270`）。AC-275（真实 claude 驱动的审批超时/自动拒绝实物）不列为硬前置：本判据用假运行时把超时读作「从在册集合消失」，真实二进制的超时语义归 AC-275 直接覆盖。AC-277（人工关卡）不列为硬前置（它是 GOAL-022 的最终人工门）。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-274 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-approvals.test.ts`（写下完整命令与完整输出）。 —— 证据：命令 `for f in server/modules/mcp-gateway/tests/mcp-approvals.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-approvals.test.ts`；实现前退出码 1，stderr 逐字 `缺判据文件：server/modules/mcp-gateway/tests/mcp-approvals.test.ts`。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-approvals.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-approvals.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。 —— 证据：同一命令退出 0；读数 `ℹ tests 6 / ℹ suites 0 / ℹ pass 6 / ℹ fail 0`（duration_ms 4440.16885；六条用例 a–f 全绿）。
- [x] AC3 (a) 经真实 HTTP + MCP `approvals_list({session:S})` 返回每条 `{requestId, session, toolName, inputSummary, waitedMs}`：普通条 `waitedMs===3000`、`inputSummary` 含 `echo hi`；`AskUserQuestion` 条展开 `questions[0].question` 与 `options` 的 `label`/`description` 逐字等于夹具；正例对照两类都在；逐字写出返回。 —— 证据：(a) `isError=false payload={"approvals":[{"requestId":"req-normal","session":"f3a4df98-6f1f-4b93-8f61-8273bb679891","toolName":"Bash","inputSummary":"echo hi","waitedMs":3000},{"requestId":"req-ask","session":"f3a4df98-6f1f-4b93-8f61-8273bb679891","toolName":"AskUserQuestion","inputSummary":"{\"questions\":[{\"question\":\"选哪个？\",\"header\":\"选择\",\"options\":[{\"label\":\"A\",\"description\":\"甲\"},{\"label\":\"B\",\"description\":\"乙\"}]}]}","waitedMs":1000,"questions":[{"question":"选哪个？","options":[{"label":"A","description":"甲"},{"label":"B","description":"乙"}],"header":"选择"}]}]}`；普通条 `waitedMs===3000`、`inputSummary` 含 `echo hi`；AskUserQuestion 展开 `question="选哪个？"`、`options` 的 `label`/`description` 逐字 `A/甲`、`B/乙`；两类俱在（正例对照）。
- [x] AC4 (b) `approval_answer({requestId, allow:true})` 与 `({requestId, allow:false, message:'不行'})` 分别使假运行时 `resolveToolApproval` 收到 `(requestId,{allow:true,...})` 与 `(requestId,{allow:false,message:'不行'})`，各恰好一次；逐字写出两次间谍读数。 —— 证据：(b) allowPayload=`{"ok":true,"requestId":"req-normal","decision":"allow"}`；denyPayload=`{"ok":true,"requestId":"req-second","decision":"deny"}`；resolveCalls=`[{"requestId":"req-normal","decision":{"allow":true}},{"requestId":"req-second","decision":{"allow":false,"message":"不行"}}]`（各恰好一次；`message:'不行'` 逐字转发）。
- [x] AC5 (c) `AskUserQuestion` 的 `answers` 转发：假运行时收到的 `decision.updatedInput` 逐字等于传入的 `answers`；逐字写出该 decision。 —— 证据：(c) `isError=false payload={"ok":true,"requestId":"req-ask","decision":"allow"}`；假运行时收到的 `decision={"allow":true,"updatedInput":{"选哪个？":"A"}}`，`updatedInput` 与传入 `answers` 逐字相等。
- [x] AC6 (d) 「已过期」（在册后移除）与「不存在」（从未在册）的 requestId 调 `approval_answer` ⇒ 不抛异常、message 逐字含「已过期或不存在」、`resolveToolApproval` 对该 id 调用计数为 0；逐字写出两次返回与计数。 —— 证据：(d) 过期（`req-normal` 在册后移除）→ `expiredIsError=false expiredPayload={"ok":false,"requestId":"req-normal","code":"APPROVAL_EXPIRED_OR_NOT_FOUND","message":"该审批请求已过期或不存在（可能已超时被自动拒绝）。"}`；不存在（`req-never`）→ `neverPayload={"ok":false,"requestId":"req-never","code":"APPROVAL_EXPIRED_OR_NOT_FOUND","message":"该审批请求已过期或不存在（可能已超时被自动拒绝）。"}`；`resolveCounts=[]`（两 id 调用计数均为 0）；`isError=false`（未抛异常）。
- [x] AC7 (e) 仅 `cloudcli:read` 令牌调 `approval_answer` 被拒（isError）、`mcp_audit_log` 新增恰好一行 `tool='approval_answer'`/`outcome='denied'`、`resolveToolApproval` 计数为 0；`cloudcli:approve` 令牌同调成功（正例对照）；逐字写出该行与前后计数。 —— 证据：(e) 只读令牌 → `deniedIsError=true text="Insufficient scope for this tool."`；`newRows=[{"id":1,"tool":"approval_answer","outcome":"denied"}]`（恰好一行，denied）；`resolveCallsAfterDenied=0`；`T_appr` 同调 → `allowedIsError=false payload={"ok":true,"requestId":"req-normal","decision":"allow"}`，`resolveCallsAfterApprove=1`（正例对照）。
- [x] AC8 (f) `approvals_list({})` 的待审批会话集合与 `overview()` 的 `awaitingPermission` 会话集合相等；无待审批的会话不出现在任一侧；逐字写出两侧集合。 —— 证据：(f) `listedSessions=["364871df-b39a-4bf0-9e96-7e6a30a19400"]`；`awaitingSessions=["364871df-b39a-4bf0-9e96-7e6a30a19400"]`（两侧相等）；`coldSessionId=c6bfa9f3-5e1d-4bc3-9272-83aed906b3a3` 不出现在任一侧。
- [x] AC9 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 过期仍调用解析 ⇒ AC6 红；(ii) `answers` 被丢弃 ⇒ AC5 红；(iii) 不检查 approve scope ⇒ AC7 红。每条记录恢复命令 + 恢复后重跑绿。 —— 证据（三条均在已提交实现上变异、记录失败行、恢复后重跑 6/6 绿）：
  (i) 移除 `answerApproval` 在册性预检（`server/modules/websocket/services/chat-control.service.ts`：`if (holderSessionId === null) { return { code: 'APPROVAL_EXPIRED_OR_NOT_FOUND', ... } }` → `const holderSessionId = findApprovalSession(deps, input.requestId) ?? '';`）⇒ (d) 红：`✖ (d) expired and never-seen request ids answer 已过期或不存在 without resolving (373.524333ms)`，读数 `expiredPayload={"ok":true,"requestId":"req-normal","decision":"allow"}`、`resolveCounts=[{"requestId":"req-normal","decision":{"allow":true}},{"requestId":"req-never","decision":{"allow":true}}]`、`ℹ fail 1`（退出 1）；恢复命令 `git -C /data/home/yale/work/claudecodeui-task-gap-ac274-mcp-approvals checkout -- server/modules/websocket/services/chat-control.service.ts` → 重跑 `ℹ tests 6 / pass 6 / fail 0`（退出 0）。
  (ii) 丢弃 `answers`（删 `if (input.answers !== undefined) { decision.updatedInput = input.answers; }`）⇒ (c) 红：`✖ (c) an AskUserQuestion answers argument arrives as updatedInput (378.130737ms)`，读数 `decision={"allow":true}`（无 `updatedInput`）、`ℹ fail 1`（退出 1）；恢复命令同上 `git -C ... checkout -- server/modules/websocket/services/chat-control.service.ts` → 重跑 `ℹ tests 6 / pass 6 / fail 0`。
  (iii) `approval_answer` 不检查 approve scope（`server/modules/mcp-gateway/mcp-approvals.ts`：`requiredScope: APPROVE_SCOPE` → `READ_SCOPE`）⇒ (e) 红：`✖ (e) a read-only token is denied with one denied audit row and no resolve (340.339356ms)`，读数 `deniedIsError=false`、`newRows=[{"id":1,"tool":"approval_answer","outcome":"ok"}]`、`resolveCallsAfterDenied=1`、`ℹ fail 1`（退出 1）；恢复命令 `git -C /data/home/yale/work/claudecodeui-task-gap-ac274-mcp-approvals checkout -- server/modules/websocket/services/chat-control.service.ts server/modules/mcp-gateway/mcp-approvals.ts` → 重跑 `ℹ tests 6 / pass 6 / fail 0`，`git status --porcelain` 空。
- [x] AC10 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`mcp-cancel-queued.test.ts`、`mcp-session-background.test.ts`、`mcp-session-send.test.ts`、`mcp-read-tools.test.ts`、`mcp-overview.test.ts`、`chat-control-*.test.ts`、`claude-resident-permissions.test.ts`、`provider-runtime.service.test.ts` 不改一字仍逐字通过；跨模块只经 barrel。 —— 证据：`npm run typecheck` 退出码 0（tsconfig + server/tsconfig + scripts/tsconfig 三段全过）；`npm run lint` 退出码 0，`: error ` 计数 **0**（仅既有 warning）；兄弟判据不改一字 → 一次 `tsx --test` 跑 `mcp-cancel-queued.test.ts`、`mcp-session-background.test.ts`、`mcp-session-send.test.ts`、`mcp-read-tools.test.ts`、`mcp-overview.test.ts`、`chat-control-{access,busy,ownership,send,source,wiring}.test.ts`、`claude-resident-permissions.test.ts`、`provider-runtime.service.test.ts` 得 `ℹ tests 58 / ℹ suites 0 / ℹ pass 58 / ℹ fail 0`（退出 0）；跨模块导入只经 barrel。
- [x] AC11 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。 —— 证据：`git diff --stat develop...HEAD` 逐字为 `server/index.ts | 7 +-`、`server/modules/mcp-gateway/index.ts | 25 +`、`server/modules/mcp-gateway/mcp-approvals.ts | 502 ++`、`server/modules/mcp-gateway/mcp-gateway.resident-tools.ts | 18 +`、`server/modules/mcp-gateway/mcp-gateway.transport.ts | 5 +`、`server/modules/mcp-gateway/tests/mcp-approvals.test.ts | 659 ++`、`server/modules/websocket/services/chat-control.service.ts | 234 +-`；`7 files changed, 1442 insertions(+), 8 deletions(-)`。逐条对齐 `## Touches` 的 7 个代码文件（`mcp-approvals.ts (new)`、`mcp-gateway.resident-tools.ts`、`mcp-gateway.transport.ts`、`index.ts`、`chat-control.service.ts`、`server/index.ts`、`tests/mcp-approvals.test.ts (new)`）；第 8 条 `tasks/gap-ac274-mcp-approvals.md` 由 `task_write` 维护。无 Touches 之外的文件被写。

## DoD

- `approvals_list`/`approval_answer` **真的**经真实 HTTP + MCP SDK 客户端驱动，落到**真** `createChatControlService`（真 `accessEntry`）上，其审批源是**假运行时**的 `getPendingApprovalsForSession`/`resolveToolApproval`（间谍可观测）——不是「函数被调用」或「判据文件存在」就算数。
- 列表**真的**给出 `requestId`/会话/工具名/输入摘要/已等待时长，且 `AskUserQuestion` **真的**展开成问题文本与各选项；等待时长**真的**由注入时钟与 `receivedAt` 算出。
- `approval_answer` **真的**按 `allow` 调 `resolveToolApproval`、**真的**转发 `message`；`answers` **真的**作为 `updatedInput` 转发（不是丢弃、不是另起字段）。
- 「过期或不存在」**真的**是查在册性得出的：不在册时**真的**不调用 `resolveToolApproval`（计数为 0）、**真的**不抛异常、**真的**逐字说「已过期或不存在」。
- scope **真的**生效：仅 `cloudcli:read` 的令牌**真的**被拒、**真的**写下一行 `denied` 审计、解析**一次都没被调用**；`cloudcli:approve` 令牌**真的**放行。
- `overview` 的 `awaitingPermission` 会话集合与待审批**真的**一致（两侧集合相等，无待审批者不入列）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖；不改运行时审批缝的既有签名与既有五个控制动词的行为；不越界实现 AC-275–AC-277 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-approvals.ts (new)
- server/modules/mcp-gateway/mcp-gateway.resident-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/websocket/services/chat-control.service.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-approvals.test.ts (new)（判据）
- tasks/gap-ac274-mcp-approvals.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-273 同款说明）。
- 「过期」的实质是**从在册集合消失**：`waitForToolApproval` 超时（`TOOL_APPROVAL_TIMEOUT_MS`，默认 55s）时 `finalize(null)` 会 `pendingToolApprovals.delete(requestId)`，`resolveToolApproval` 对缺失 id 静默无操作——故在册性必须由 `getPendingApprovalsForSession` 先查，不能靠调用解析器试探。判据用假运行时把「移除」模拟成 `delete`；真实二进制的超时读数归 AC-275。
- `answers` → `updatedInput` 的词表是 AC-274 特有的：控制服务的 `answerApproval` 把 `input.answers` 放进 `resolveToolApproval` 的 `decision.updatedInput`（与 WS 侧 `chat.permission-response` 的 `updatedInput` 打同一 resolver，语义自洽）；`ProviderPermissionDecision` 的 `rememberEntry` 本任务不引入。
- `MCP_STAGE6_RESIDENT_TOOLS` 是阶段 6 工具名的唯一事实来源（AC-252 的自指保护从工具注册表取网关工具名，含这两个审批工具）；本任务追加条目，不重写集合。
- `overview` 由 AC-247 交付；本任务只**读**它的 `awaitingPermission` 读数用于 (f) 的一致性断言，不改其实现与判据。若 AC-247 实际落地形状不同（字段名不同），以实际落地为准并先用 `task_write` 把需要改的文件加进 `## Touches`。
- 控制服务新增两个动词后，`provider-runtime.service.ts` 的 `resolveToolApproval`/`getPendingApprovalsForSession` 签名不变（本任务不扩 `ProviderRuntimeGateway`）；既有 `chat-control-*.test.ts` 用真 `createChatControlService` + 假 runtime，新增动词不影响既有五个动词的读数。
