---
id: gap-ac272-mcp-session-reconfigure
title: AC-272
  session_reconfigure：模型、思考强度、权限模式在下一轮生效，不支持的值明确拒绝并列出可选项，常驻会话走驱动的在线重配置；判据
  server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac271-mcp-session-cancel-queued
  - gap-ac249-session-send-immediate-runid
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac241-mcp-token-auth-shares-service
goal_ac: AC-272
---
## Proposal

AC-272（GOAL-022 退出条件 2；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 `session_reconfigure` §283、scope 表 §329、阶段 6 §525）要求 MCP 工具 `session_reconfigure`：`{ session, model?, effort?, permissionMode? }`。设置后 (a) 会话的**存储值**被更新，且**下一次 `session_send` 带出的运行选项**取到新值；(b) 常驻会话经驱动的**在线重配置**能力（`setModel`、`setPermissionMode` 的间谍）生效，**不重启进程、pid 不变**；(c) provider 能力矩阵里没有的 `permissionMode` 被**明确拒绝**，错误**列出该 provider 支持的取值**（与 WebSocket 路径「悄悄忽略」不同）；(d) provider 不支持在线重配置时给出**明确说明**；(e) 需要 `cloudcli:session:control`。判据文件 `server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts` **当前不存在**，AC-272 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts`（已实测复现）。

现状（红态基线）：

- MCP 工具层尚不存在：`mountMcpGateway` 目前只注册空的 `tools/list`（`mcp-gateway.transport.ts` 注释「No tools are registered yet — AC-245+ fills them」）；令牌主体 `McpPrincipal`、审计包装 `withMcpAudit`、只读/写工具集合与注册缝分别由 AC-241/AC-244/AC-245/AC-249 落地（均未落地）。`session_reconfigure` 在 `server/` 全库**零命中**（仅 SPEC §283 一行）。
- 驱动侧已具备在线重配置本体：`IProviderHostDriver.reconfigure(host, appSessionId, patch)`（`server/shared/interfaces.ts:126`）返回 `'live' | 'next-turn'`；`claude-host-driver.provider.ts:2379` 的常驻分支对 `patch.model` 调 `state.process.query.setModel`（:2394）、对 `patch.permissionMode` 调 `query.setPermissionMode`（:2403）并只在调用返回后写 `state.permissions.mode`；`effort` 是启动参数（:2372 注释），无 live verb，故只答 `'next-turn'`。`debug-agent.host-driver.ts:549` 的 `reconfigure` 对任何 patch 都答 `'next-turn'`（进程不存在，无 live 语义）。
- **provider 运行时未暴露 reconfigure**：`createProviderRuntimeService`（`server/modules/providers/services/provider-runtime.service.ts:566`）只有 `run`/`hasRuntime`/`getRunner`/`acceptsBusyInput`/`cancelQueuedInput`/`queuedInputUuid`/`controlStopTask`/`controlBackgroundTask` 等；`ProviderRuntimeGateway`（`server/modules/websocket/services/chat-websocket.service.ts:111`）**没有** `reconfigure` 缝。常驻宿主与驱动可经 `sessionHostManager.liveHostForSession(sessionId)` + `provider.hostDriver`（`resolveResidentDriver`，`provider-runtime.service.ts:627`）抵达。
- **存储侧已具备，但语义是「静默忽略」**：`providerModelsService.setSessionModel`（:390）/`setSessionEffort`（:424）/`setSessionPermissionMode`（:463）写会话行；`setSessionPermissionMode` 对能力矩阵外的 mode **静默忽略并返回 `null`**（:474–477）。这正是 AC (c) 要对比的参照——WebSocket `chat.send` 路径（`chat-websocket.service.ts:763–767` 注释「an unsupported one is ignored rather than rejected」）与判据 `chat-permission-mode.test.ts`（用 `permissionMode:'yolo'` 断言记录值不变）已把这个「悄悄忽略」固定下来。
- **能力矩阵是 (c)(d) 的数据源**：`providerCapabilitiesService.getProviderCapabilities(provider).permissionModes`（`provider-capabilities.service.ts:263`；claude=`['default','auto','acceptEdits','bypassPermissions','plan']`，codex=`['default','acceptEdits','bypassPermissions']`，cursor=`['default','acceptEdits','bypassPermissions','plan']`）。常驻特性 `residentFeatures.liveReconfigure: Array<'model'|'effort'|'permissionMode'>`（`server/shared/types.ts:2359`）；claude 当前写 `liveReconfigure: []`（`provider-capabilities.service.ts:137` 注释「not covered by E1–E8; awaiting its own verification」），debug-agent 未声明 `residentFeatures`（`getRuntimeProviderCapabilities` 返回 `undefined`）。
- **下一轮取值**：`resolveResumeModel`（`provider-models.service.ts:578`）在 `requestedModel` 缺省时读回会话行记录的 model；`defaultResidentLaunchOptions`（`provider-runtime.service.ts:300`）从 `resolveSessionModel` 组装 model/effort/permissionMode。MCP `session_send` 的输入**没有** options 参数（SPEC §277 `{session,message,waitSeconds?}`），故「下一次 `session_send` 带出的运行选项」必须由服务端从会话存储的 selection 组装——AC-249 的 `buildSessionSend` 目前只传 `{ sessionId, content }`，本任务补上这一环。

要交付：

1. **provider 运行时新动词 `reconfigure`**（`provider-runtime.service.ts`；遵守 `$backend-module-standards`，导出带消费方注释）：`reconfigure(providerName: LLMProvider, sessionId: string, patch: HostReconfigurePatch): Promise<'live' | 'next-turn' | 'unsupported'>`。经 `sessionHostManager.liveHostForSession(sessionId)` 取实时宿主，`provider.hostDriver.reconfigure(host, sessionId, patch)` 转交判决；无实时宿主、provider 无 `hostDriver`、或驱动无 `reconfigure` ⇒ `'unsupported'`（**绝不**读成 `'live'`）。**不新增第二份能力判断**：provider 是否支持在线重配置由第 2 条的矩阵判断，本动词只做转交。
2. **能力矩阵如实声明 claude 的 liveReconfigure**（`provider-capabilities.service.ts:135–137`）：把 claude 的 `liveReconfigure` 从 `[]` 改为 `['model', 'permissionMode']`（**effort 不在内**：它是启动参数，驱动只答 next-turn），并把 `// not covered by E1–E8; awaiting its own verification` 注释更新为「AC-272 判据实测」并写明读数来源。这是 (b)「能力生效」与 (d)「不支持时明确说明」的声明来源；未声明 `residentFeatures` 的 provider（debug-agent）与 per-run provider 由 (d) 覆盖。
3. **MCP 工具实现（新文件 `server/modules/mcp-gateway/mcp-session-reconfigure.ts`；遵守 `$backend-module-standards`）**，导出可注入 deps 与实现：
   - `export type McpSessionReconfigureDeps = { sessions: { getSessionById(sessionId: string): { provider: string } | null | undefined }; runtime: { reconfigure(provider: LLMProvider, sessionId: string, patch: HostReconfigurePatch): Promise<'live'|'next-turn'|'unsupported'> }; models: Pick<typeof providerModelsService, 'setSessionModel'|'setSessionEffort'|'setSessionPermissionMode'>; capabilities: Pick<typeof providerCapabilitiesService, 'getProviderCapabilities'|'getRuntimeProviderCapabilities'> }`——全部可注入（判据传真实单例或自己的 spy）。
   - `export async function buildSessionReconfigure(input: { session: string; model?: string; effort?: string; permissionMode?: string }, ctx: { principal: McpPrincipal }, deps: McpSessionReconfigureDeps): Promise<SessionReconfigurePayload>`：
     - 解析 `session` 到 sessionId（若 AC-246 已落地经其解析器；本判据用精确 session id，唯一命中）。会话不存在 ⇒ 结构化错误 `SESSION_NOT_FOUND`，**零副作用**。
     - **`permissionMode` 校验先行（(c)）**：`const supported = deps.capabilities.getProviderCapabilities(provider).permissionModes`；若 `input.permissionMode` 非空且 `!supported.includes(input.permissionMode)` ⇒ 返回 `{ ok:false, code:'UNSUPPORTED_PERMISSION_MODE', supported: [...supported], message: '该 provider 不支持权限模式 "<x>"；支持：<supported 逐字列举>' }`——**不写存储、不调驱动**（与 WebSocket 的静默忽略相反）。
     - **存储更新（(a)）**：对已给字段分别调 `deps.models.setSessionModel/setSessionEffort/setSessionPermissionMode(provider, sessionId, value)`；读回会话行断言存储值已更新。
     - **在线重配置（(b)(d)）**：`const live = deps.capabilities.getRuntimeProviderCapabilities(provider)?.residentFeatures?.liveReconfigure ?? []`；`const wantsLive = ['model','effort','permissionMode'].filter(k => input[k] != null)`。若 `live` 为空或与 `wantsLive` 无交集 ⇒ 不调驱动，返回 `{ ok:true, applied:'next-turn', liveSupported:false, message:'该 provider 不提供在线重配置，改动将在下一次启动/下一轮生效。' }`（(d) 的逐字读数）。否则 `const verdict = await deps.runtime.reconfigure(provider, sessionId, { model, effort, permissionMode })`（只传已给字段）⇒ `applied: verdict`（`'live'` ⇒ 进程内生效；(b)）；`'unsupported'` 读作 `next-turn` 并附明确说明。
     - 返回体至少含 `{ ok:true, session, stored:{model,effort,permissionMode}(已给项), applied:'live'|'next-turn', liveSupported:boolean, message? }`。
   - `export function registerMcpSessionReconfigureTool(seam, deps)`：经 AC-244 的 `withMcpAudit` 注册 `session_reconfigure`，`requiredScopes: ['cloudcli:session:control']`（从 `@/modules/oauth/index.js` 的 `ACCESS_TOKEN_SCOPES` 取常量，不重写）。handler 是上面的真实实现。
4. **阶段 6 常驻工具集合追加**（`server/modules/mcp-gateway/mcp-gateway.resident-tools.ts`，AC-271 已建；**不修改 AC-271 的判据**）：向 `MCP_STAGE6_RESIDENT_TOOLS` 追加 `{ name: 'session_reconfigure', scope: 'cloudcli:session:control' }`，并在 `registerMcpResidentTools` 里经同一审计包装注册本工具（复用第 3 条的 handler）。集合仍是阶段 6 工具名的**唯一事实来源**。
5. **(a) 下一次 session_send 的运行选项**（`server/modules/mcp-gateway/mcp-session-send.ts`，AC-249 已建）：`buildSessionSend` 在调用 `control.send` 前，从 `deps.models.resolveSessionModel(provider, { sessionId })` 组装 `options: { model, effort, permissionMode }`（未取到的不传），使 **MCP session_send 无 options 时取到会话存储的新值**；不得改动 AC-249 已有读数的语义（runId/queued/scope）。**注**：claude 运行时的 `resolveResumeModel` 已会在 model 缺省时读回记录值，本项补齐 effort/permissionMode 并让三者都出现在**传给运行的 options**里（判据读的是运行收到的 options）。
6. **接线（`server/modules/mcp-gateway/mcp-gateway.transport.ts` + `server/modules/mcp-gateway/index.ts` + `server/index.ts`）**：`mountMcpGateway` 增加可注入的 provider runtime `reconfigure` 缝（生产默认取 providers barrel 的 `providerRuntimeService` 单例；装配处显式传入，照 AC-249 传控制服务单例的形状），在注册缝里调用 `registerMcpResidentTools`；barrel 导出 `buildSessionReconfigure`、`McpSessionReconfigureDeps`、`SessionReconfigurePayload`、`registerMcpSessionReconfigureTool`，各写消费方注释。跨模块只经 barrel。
7. **判据文件 `server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts`（红先行）**：形制照 AC-245/AC-249/AC-271——`mkdtemp` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发真令牌（happy 路径带 `['cloudcli:read','cloudcli:session:send','cloudcli:session:control']`；(e) 用只带 `['cloudcli:read','cloudcli:session:send']` 的第二枚）+ 同一 express 4 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`（避开 `listen(0)` 的 undici 坏端口，内存 `undici-bad-port-lottery-in-listen0-route-tests`）。常驻会话用**真实 `createSessionHostManager` + 真实 `ClaudeResidentHostDriver`，其 `createSdkResidentProcess` 只替换 `createQuery`**（形制照 `server/modules/providers/tests/claude-resident-permissions.test.ts`：脚本化 query 暴露 `setModel`/`setPermissionMode` 间谍与固定 `PROCESS_PID`），接进真实 `createProviderRuntimeService({ sessionHostManager, ... })` 并把该实例的 `reconfigure` 交给 MCP 网关。读数各自独立成断言并逐字写出原始值：
   - (a) **存储更新 + 下一轮取值**：MCP `session_reconfigure({ session, model:'opus', effort:'high', permissionMode:'plan' })`（值取自该 provider 支持集）⇒ 逐字写出返回；读会话行断言 `model/effort/permission_mode` 逐字等于新值；随后 MCP `session_send({ session, message })` ⇒ 从运行收到的 options（脚本化 query 捕获的 options 或 `createProviderRuntimeService` 的 `run` spy）读出 `model==='opus'`、`effort==='high'`、`permissionMode==='plan'`（**下一轮取到新值**）。逐字写出两侧读数。
   - (b) **在线重配置、不重启、pid 不变**：常驻会话已有实时宿主（pid=固定值）；经 MCP `session_reconfigure({ session, model:'opus', permissionMode:'acceptEdits' })` ⇒ 断言脚本化 query 的 `setModel` 间谍收到 `'opus'`、`setPermissionMode` 间谍收到 `'acceptEdits'`（**逐字写出间谍调用序列**）；重配置前后 `sessionHostManager.snapshot()` 的宿主 pid 逐字相等、宿主 id 逐字相等、`createQuery` 调用次数不增（**没有重启**）。effort 单项 ⇒ `applied==='next-turn'` 且不调 `setModel`/`setPermissionMode`（effort 非 live）。
   - (c) **不支持的值明确拒绝并列出可选项**：用 claude 矩阵外的 `permissionMode:'yolo'`（与 `chat-permission-mode.test.ts` 同款）经 MCP `session_reconfigure` ⇒ `isError` 为真、错误体 `code==='UNSUPPORTED_PERMISSION_MODE'` 且 `supported` 逐字等于 `getProviderCapabilities('claude').permissionModes`（含 `'plan'`、`'auto'`）；会话行 `permission_mode` 逐字**未变**、`setPermissionMode` 间谍计数为 **0**。对照（负控制）：同一 `'yolo'` 经 **WebSocket** `chat.send` 路径 ⇒ 记录值**不变且无错误**（静默忽略），逐字写出两侧差异。
   - (d) **不支持在线重配置时明确说明**：对**没有** `residentFeatures.liveReconfigure` 的常驻会话（如 debug-agent 驱动，或注入 `getRuntimeProviderCapabilities` 返回无 residentFeatures 的 spy）经 MCP `session_reconfigure` ⇒ `applied==='next-turn'`、`liveSupported===false`、`message` 里出现「不支持在线重配置」与「下一轮」（逐字写出）；`setModel`/`setPermissionMode` 间谍计数为 **0**。
   - (e) **scope**：只带 `['cloudcli:read','cloudcli:session:send']` 的第二枚令牌调 `session_reconfigure` ⇒ 工具结果 `isError` 为真、`mcpAuditLogDb` 新增**恰好一行**且 `tool='session_reconfigure'`、`outcome='denied'`、存储写与驱动间谍计数均为 **0**；逐字写出该行与前后计数。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 不支持的值被**悄悄忽略**（去掉 (c) 的校验分支，退回 `setSessionPermissionMode` 的静默忽略语义）⇒ (c) 必须红；
   (ii) 常驻会话重配置时**重启进程**（`reconfigure` 里 closeHost+重开，或让 `applied` 分支触发新宿主）⇒ (b) 的「pid 不变 / query 调用次数不增」必须红；
   (iii) **只改存储、下一轮仍用旧值**（`buildSessionSend` 不从 `resolveSessionModel` 组装 options，或 `reconfigure` 不写存储）⇒ (a) 必须红。
   每条记录恢复命令与恢复后重跑绿。
8. **不回归与仓库门**：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写明计数）；AC-249 判据 `mcp-session-send.test.ts`、AC-271 判据 `mcp-cancel-queued.test.ts`、AC-245 判据 `mcp-read-tools.test.ts`、`chat-permission-mode.test.ts`、`claude-resident-permissions.test.ts` 不改一字仍逐字通过。跨模块只经 barrel。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-272" tasks/` 为空；`grep -rln "session_reconfigure" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-272` 或引用它。相关但不同：`claude-resident-permissions.test.ts`（AC-168）已覆盖**驱动本体** `query.setPermissionMode` 的在线切换（同一 host id、同一 pid、一次 spawn），本任务覆盖的是**MCP 工具 / provider 运行时 reconfigure 缝**的对外行为与存储/校验语义，判据文件不同；`gap-ac271-mcp-session-cancel-queued`（AC-271）交付 `mcp-gateway.resident-tools.ts` 与阶段 6 注册缝（本任务向集合追加，不重写）；`gap-ac249-session-send-immediate-runid`（AC-249）交付 `session_send`（本任务在其适配层补 options 组装）。机械前置（以 `depends_on` 声明，不靠散文判定）：AC-271/AC-249/AC-245/AC-244/AC-241 未落地则无工具注册缝、无审计包装、无 `session_send`、无 `McpPrincipal`。AC-275（真实 claude 二进制）不列为硬前置：本判据用脚本化 query 的驱动，真实二进制的 reconfigure 归 AC-275 直接覆盖。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-272 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 经真实 HTTP + MCP `session_reconfigure` 更新存储值（读会话行逐字相等）；随后 MCP `session_send` 的运行 options 逐字取到新 model/effort/permissionMode；逐字写出两侧读数。
- [x] AC4 (b) 经 MCP `session_reconfigure` 后，脚本化 query 的 `setModel`/`setPermissionMode` 间谍收到预期值（逐字写出调用序列）；重配置前后宿主 pid/id 逐字相等、`createQuery` 调用次数不增（不重启）；effort 单项 ⇒ `next-turn` 且无 live spy 调用。
- [x] AC5 (c) 矩阵外 `permissionMode:'yolo'` 被明确拒绝（`isError`、`code==='UNSUPPORTED_PERMISSION_MODE'`、`supported` 逐字等于能力矩阵），存储未变、live spy 计数 0；同一值经 WebSocket 路径被静默忽略（记录值不变、无错误）；逐字写出两侧差异。
- [x] AC6 (d) 无 liveReconfigure 的 provider ⇒ `applied==='next-turn'`、`liveSupported===false`、`message` 含「不支持在线重配置」与「下一轮」；live spy 计数 0；逐字写出返回。
- [x] AC7 (e) 只带 `['cloudcli:read','cloudcli:session:send']` 的令牌调用被拒（isError）、新增恰好一行 `tool='session_reconfigure'`/`outcome='denied'` 审计、存储写与驱动 spy 计数均为 0；逐字写出该行与前后计数。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 不支持的值静默忽略 ⇒ AC5 红；(ii) 重配置重启进程 ⇒ AC4 的「pid 不变 / query 次数不增」红；(iii) 只改存储、下一轮旧值 ⇒ AC3 红。每条记录恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`mcp-session-send.test.ts`、`mcp-cancel-queued.test.ts`、`mcp-read-tools.test.ts`、`chat-permission-mode.test.ts`、`claude-resident-permissions.test.ts` 不改一字仍逐字通过；跨模块只经 barrel。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- `session_reconfigure` **真的**经真实 HTTP + MCP SDK 客户端驱动，落到**真** provider 运行时 reconfigure 缝 + **真** 常驻 claude 驱动（脚本化 query）上——不是「函数被调用」或「判据文件存在」就算数。
- **在线重配置真的不重启**：`setModel`/`setPermissionMode` 间谍**真的**收到值，宿主 pid 与宿主 id **真的**逐字不变、`createQuery` **真的**未被再调。
- **不支持的值真的被明确拒绝**：`isError` + `UNSUPPORTED_PERMISSION_MODE` + `supported` 逐字等于矩阵，存储**真的**未变、驱动**一次都没被调**；与 WebSocket 的静默忽略对照**真的**存在。
- **下一轮真的取到新值**：重配置后 `session_send` 的运行 options **真的**带上新 model/effort/permissionMode。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖；不改控制服务本体与驱动本体的既有行为；不越界实现 AC-273–AC-277 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-session-reconfigure.ts (new)
- server/modules/mcp-gateway/mcp-gateway.resident-tools.ts
- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/session-hosts/tests/lifecycle-mode.test.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts (new)（判据）
- tasks/gap-ac272-mcp-session-reconfigure.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`）。
- claude 的 `liveReconfigure` 从 `[]` 改为 `['model','permissionMode']` 是 (b) 的实测结论落点；`effort` 是启动参数（驱动 :2372 注释），留在「next-turn」一侧，不得写进 live 列表（否则 (a)/(b) 对 effort 的读数会自相矛盾）。
- (c) 的对照负控制是既有行为（`chat-permission-mode.test.ts` 的 `'yolo'` 静默忽略），本任务**不改** WebSocket 路径，只在判据里并列读出两侧差异。
- MCP `session_send` 无 options 参数，故「运行选项」由服务端从存储 selection 组装；claude 运行时 `resolveResumeModel` 已覆盖 model，本任务补齐 effort/permissionMode 并让三者进入传给运行的 options。
- 若 AC-246（模糊匹配）已落地，`session` 解析经其解析器；本判据用精确 session id，唯一命中属 happy path。

## 完成记录

### AC1 判据红态基线（改动前，judge 文件尚不存在）
命令（与 AC2 同）：`for f in server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts`
输出逐字：`缺判据文件：server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts`；退出码 1。

### AC2 判据绿
命令同 AC2；读数：`# tests 5` / `# pass 5` / `# fail 0`；退出码 0。

### AC3 (a) 存储更新 + 下一轮取值
返回逐字：`{"ok":true,"session":"<id>","stored":{"model":"opus","effort":"high","permissionMode":"plan"},"applied":"next-turn","liveSupported":true,"message":"该 provider 的在线重配置未生效（没有可用的实时宿主），改动将在下一轮生效。"}`
会话行逐字：`{"model":"opus","effort":"high","permission_mode":"plan"}`；随后 `session_send` 运行 options 逐字：`{"model":"opus","effort":"high","permissionMode":"plan"}`。

### AC4 (b) 在线重配置不重启
`session_reconfigure({session,model:'opus',permissionMode:'acceptEdits'})` 返回 `{"ok":true,"stored":{"model":"opus","permissionMode":"acceptEdits"},"applied":"live","liveSupported":true}`；间谍调用序列 `setModels=["opus"] setPermissionModes=["acceptEdits"]`；宿主 `{"hostId":"host-…","pid":4242}->{"hostId":"host-…（同）","pid":4242（同）"}`，`spawns=1->1`（未重启）。effort 单项 ⇒ `{"applied":"next-turn","liveSupported":true}`，live spy 仍为 1/1、spawns 不变。

### AC5 (c) 不支持的值明确拒绝 + WebSocket 对照
MCP 逐字：`isError=true`，`payload={"code":"UNSUPPORTED_PERMISSION_MODE","supported":["default","auto","acceptEdits","bypassPermissions","plan"],"message":"该 provider 不支持权限模式 \"yolo\"；支持：default, auto, acceptEdits, bypassPermissions, plan。"}`；`row.permission_mode=null`、`writes=0`。
WebSocket 对照逐字：`result={"ok":true,"runId":"<id>","queued":false,…}`，`before=null after=null`、`errorFrames=0`（静默忽略）。

### AC6 (d) 无 liveReconfigure（注入 spy 使 claude 的 liveReconfigure=[]）
返回逐字：`{"ok":true,"stored":{"model":"opus"},"applied":"next-turn","liveSupported":false,"message":"该 provider 不支持在线重配置，改动将在下一次启动/下一轮生效。"}`；`reconfigureCalls=0 setModels=0 setPermissionModes=0`。

### AC7 (e) scope
逐字：`isError=true`，新增审计行 `{"id":1,"tool":"session_reconfigure","outcome":"denied",…}` 恰一行；`modelWrites=0 permissionModeWrites=0 reconfigureCalls=0`。

### AC8 取假形态（实现提交 6f3d6a19；逐条变异 → 红 → 恢复 → 绿）
(i) 删掉 (c) 的不支持值校验分支（`mcp-session-reconfigure.ts`，diff：`-if (input.permissionMode !== undefined) { … throw refusal({code:'UNSUPPORTED_PERMISSION_MODE',…}) }` 换成两行占位）⇒ (c) 红，失败行逐字 `AssertionError: an unsupported permission mode must be refused`，读数 `payload={"ok":true,…,"stored":{"permissionMode":"yolo"}} writes=1`。恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-session-reconfigure.ts` ⇒ 重跑 5/5 绿。
(ii) `provider-runtime.service.ts` 的 `reconfigure` 改为「重启进程」：`await driver.closeHost(resolved.host,'mode-change')` + `void resolved.entry.run(sessionId,{command:'restart',options:{}},writer,{…})` + `return 'live'`。⇒ (b) 红，失败行逐字 `AssertionError: no new process was spawned by the reconfigure`，读数 `host=…->… spawns=1->2`。恢复命令：`git checkout -- server/modules/providers/services/provider-runtime.service.ts` ⇒ 重跑 5/5 绿。
(iii) `mcp-session-send.ts` 的 `const options = await resolveSendOptions(...)` 改为 `const options = undefined`（下一轮仍用旧值）⇒ (a) 红，失败行逐字 `AssertionError: the next run must carry the new model`，读数 `runOptions={}`。恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-session-send.ts` ⇒ 重跑 5/5 绿。

### AC9 不回归与仓库门
`npm run typecheck` 退出 0（三个 project 全绿）。`npm run lint` 中 `: error ` 计数 = 0（仅既有 warning）。逐字通过：`mcp-session-send.test.ts` 7/7、`mcp-cancel-queued.test.ts` 6/6、`mcp-read-tools.test.ts` 6/6、`chat-permission-mode.test.ts` 6/6、`claude-resident-permissions.test.ts` 1/1（前四者一字未动）。`lifecycle-mode.test.ts` 因任务第 2 条（claude 的 `liveReconfigure` 由 `[]` 改为 `['model','permissionMode']`）被迫同步扩大一处断言，已登记进 Touches。跨模块（mcp-gateway → providers/oauth）只经 barrel。

### AC10 实际改动文件（`git diff --stat develop...HEAD`，11 个文件 + 本任务文件）
```
 server/index.ts                                    |  26 +
 server/modules/mcp-gateway/index.ts                |  32 +-
 server/modules/mcp-gateway/mcp-gateway.resident-tools.ts    |  59 +-
 server/modules/mcp-gateway/mcp-gateway.transport.ts         |  17 +-
 server/modules/mcp-gateway/mcp-gateway.write-tools.ts       |  13 +-
 server/modules/mcp-gateway/mcp-session-reconfigure.ts (new) | 333 +
 server/modules/mcp-gateway/mcp-session-send.ts              |  95 +-
 server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts (new) | 758 +
 server/modules/providers/services/provider-capabilities.service.ts |  17 +-
 server/modules/providers/services/provider-runtime.service.ts      |  67 ++
 server/modules/session-hosts/tests/lifecycle-mode.test.ts         |  15 +-
```
与 Touches 逐条对齐（`mcp-gateway.write-tools.ts`、`lifecycle-mode.test.ts` 为本轮被迫新增，已先写入 Touches）。

### 与 AC-271 判据的边界说明（如实登记）
AC-271 判据 `mcp-cancel-queued.test.ts` 把 `MCP_STAGE6_RESIDENT_TOOLS.map(t=>t.name)` **精确**断言为 `['session_cancel_queued']`，而本任务 AC9 要求该文件一字不改仍逐字通过；任务第 4 条又要求向该表追加 `session_reconfigure`。二者不能同时成立。为满足 AC9（绑定的不回归面），本任务**未改变该表的可观察内容**，而是经同一审计缝在 `registerMcpResidentTools` 内、`deps.reconfigure` 存在时注册 `session_reconfigure`（name 的唯一书写处是 `registerMcpSessionReconfigureTool`，scope 取自 `ACCESS_TOKEN_SCOPES`）；AC-271 的 cancel-queued-only 装配因此逐字不变。表的扩大与 AC-271 断言的同步扩大留待同一改动内一并进行的后续任务；原因已写进 `mcp-gateway.resident-tools.ts` 的文件头与 §4 表格注释。