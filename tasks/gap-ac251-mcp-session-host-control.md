---
id: gap-ac251-mcp-session-host-control
title: >-
  AC-251 session_start/session_close 复用 session-hosts 的
  startResidentHost/closeResidentHost：已运行幂等同
    pid、cron/background-task lease 无 force 被拒并点名种类与数量、既有拒绝码原样、scope
    cloudcli:session:control；判据 server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac236-resident-host-service
  - gap-ac239-sdk-zod-declared-in-dependencies
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac241-mcp-token-auth-shares-service
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac246-mcp-resolve-target-fuzzy-match
  - gap-ac249-session-send-immediate-runid
goal_ac: AC-251
---
## Proposal

AC-251（GOAL-020 退出条件 8 的第三条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 `session_start` §280 / `session_close` §281、宿主启停服务 §213–§215 与 §225、scope 表 §329、阶段 4 §523）要求 MCP 写工具 `session_start` / `session_close` **复用** session-hosts 模块里已有的宿主启停服务 `startResidentHost` / `closeResidentHost`，而不是在网关里再写一份；`session_start` 对已运行的常驻会话幂等（再次启动返回同一个 pid）；`session_close` 在会话持有 `cron` 或 `background-task` lease 时、**不带** `force` 被拒、错误里点名 lease 的种类与数量、宿主仍在运行，带 `force: true` 时关闭；非常驻会话、provider 无宿主驱动、会话不存在三类既有拒绝码原样呈现；两者都需要 `cloudcli:session:control`。判据文件 `server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts` 当前不存在，AC-251 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts`。

现状（红态基线）：
- AC-236（`gap-ac236-resident-host-service`，done）已把启停逻辑抽成 `server/modules/session-hosts/resident-host.service.ts` 的 `startResidentHost(sessionId, deps)` / `closeResidentHost(sessionId, deps)`：返回可判别联合（成功携带 `{ hostId, sessionId, mode:'resident', pid }`；关闭携带 `{ hostId, sessionId, mode:'resident', closeReason:'user', leases }`；拒绝携带 `{ ok:false, status, code, message }`，`code` 取 `LifecycleModeErrorCode`）。四种启动拒绝与四种关闭拒绝的文案已与路由逐字钉死。**但该服务今天不经 session-hosts barrel 导出**（AC-236 明确把 barrel 导出推迟给 GOAL-020 的消费者：SPEC §225 的消费者是「session-hosts 路由、mcp-gateway」）。
- `closeResidentHost` **没有** `force` 参数、**不看** lease，命中活常驻宿主即无条件关闭（关闭前读回 binding 的 leases 只为回报）。所以 `force` 门 **必须** 在 MCP 适配层、在委派 `closeResidentHost` **之前** 评估——否则宿主已经被关了，读不回「宿主仍在运行」。
- 网关今天只有传输（AC-240）；工具注册缝与写工具集合由 AC-249 落地（`session_start`/`session_close` 按 SPEC 注册为 `cloudcli:session:control`，handler 占位 `MCP_TOOL_NOT_IMPLEMENTED`，注明归 AC-251）；令牌主体 `McpPrincipal`、`withMcpAudit`、名称解析门分别由 AC-241/AC-244/AC-246 提供（本任务 frontmatter 已列出所需任务）。本任务 **只替换这两个 handler 的主体** 并新增适配层，不改写工具集合的名字与 scope 字面量。

lease 的可读来源与测试制造接口：`sessionHostManager.snapshot(): ProcessHost[]`，每项 `state` 与 `bindings: Map<appSessionId, SessionBinding>`，`SessionBinding.leases: HostLease[]`；`HostLease` 的 kind 含 `'cron'`（`{ kind:'cron'; id; recurring; expiresAt }`）、`'background-task'`（`{ kind:'background-task'; id; since? }`）与常驻自身的 `'resident-policy'`。管理器公开 `addLease(appSessionId, lease)` / `removeLease(appSessionId, kind)`——判据用 `addLease` 直接制造 cron/background-task lease（AC 要求「lease 用宿主管理器的接口在测试里直接制造」）。

要交付：

1. **适配层（新文件 `server/modules/mcp-gateway/mcp-session-host-control.ts`；遵守 `$backend-module-standards`，导出带消费方注释）**，导出可注入 deps 与两个实现：
   - `export type McpSessionHostDeps = { hosts: { start(sessionId: string): Promise<ResidentHostStartOutcome>; close(sessionId: string): ResidentHostCloseOutcome }; liveHost(sessionId: string): { mode: HostMode; leases: HostLease[] } | null }`——`hosts.start`/`hosts.close` 就是 `startResidentHost`/`closeResidentHost`（判据注入 spy 包装的真函数）；`liveHost` 是**只读**缝：读 `sessionHostManager.snapshot()` 找出服务该会话且 `state !== 'closed'` 的宿主，返回 `{ mode, leases: host.bindings.get(sessionId)?.leases ?? [] }`，无活宿主返回 `null`（与服务的 `liveHostForSession` 同一读端口，不重写启停）。
   - `export async function buildSessionStart(input: { session: string }, ctx: { principal: McpPrincipal }, deps): Promise<SessionStartPayload>`：`session` 到达时已是 AC-246 解析门改写后的 sessionId；`const outcome = await deps.hosts.start(sessionId)`；`outcome.ok` ⇒ 返回 `{ hostId, sessionId, mode:'resident', pid }`（**同一 outcome 原样透出**，幂等由服务保证）；`!outcome.ok` ⇒ 结构化 `isError`，把 `{ code, message }` **原样** 透出（(d)）。
   - `export function buildSessionClose(input: { session: string; force?: boolean }, ctx, deps): SessionClosePayload`：`session` 已是 sessionId；
     - `const live = deps.liveHost(sessionId)`；
     - **force 门**：仅当 `live?.mode === 'resident'` 时，取 `blocking = live.leases.filter(l => l.kind === 'cron' || l.kind === 'background-task')`；`blocking.length > 0 && input.force !== true` ⇒ 返回结构化拒绝 `{ code: 'SESSION_HAS_ACTIVE_LEASES', message, leases: blocking }`，其中 `message` **必须** 点名每种 lease 的种类与数量（例如 `该常驻会话持有 cron×1、background-task×1，关闭会终止其后台工作；如需强行关闭请传 force: true。`），**不调用** `deps.hosts.close`（宿主仍在运行）；
     - 否则 `const outcome = deps.hosts.close(sessionId)`；`outcome.ok` ⇒ 返回 `{ hostId, sessionId, mode:'resident', closeReason:'user', leases }`（(b)：关闭原因 `user` 来自服务）；`!outcome.ok` ⇒ 结构化 `isError`，`{ code, message }` **原样** 透出（(d)）。
     - 非 `resident` 的活宿主（如 per-run）**不走** force 门（`live.mode !== 'resident'`），直接委派服务，让服务按既有 `LIFECYCLE_MODE_NOT_RESIDENT` 拒绝（(d) 不被 force 门遮蔽）。
   - `export function registerMcpSessionHostTools(...)`（或等价名）把上面两个实现接到 AC-249 的注册缝，**替换** `session_start`/`session_close` 的占位 handler；`requiredScopes`（`cloudcli:session:control`）与工具名仍取自 `MCP_STAGE4_WRITE_TOOLS`（不手写第二份 scope 字面量）。
2. **`session_close` 的 `inputSchema` 补 `force?: boolean`（默认 false）**：在 `mcp-gateway.write-tools.ts`（AC-249 的文件）里给 `session_close` 的 zod schema 增加可选布尔 `force`，描述说明「持有 cron/background-task lease 时必须为 true」；`session_start` 的 schema 不变。不改集合的名字与 scope。
3. **接线与 barrel**：
   - `server/modules/mcp-gateway/mcp-gateway.transport.ts` 的 `McpGatewayDeps`（或写工具注册 deps）增加可注入的 `sessionHostControl` 缝，默认实现从 **session-hosts barrel** 取 `startResidentHost`/`closeResidentHost` 并自建 `liveHost` 读取器（读 `sessionHostManager` 单例，来自 barrel）。
   - `server/modules/session-hosts/index.ts` 增加 `startResidentHost` / `closeResidentHost` 与类型 `ResidentHostServiceDeps` / `ResidentHostStartOutcome` / `ResidentHostCloseOutcome` / `ResidentHostRefusal` 的 barrel 导出，各写消费方注释（消费者：mcp-gateway 的 `session_start`/`session_close` 适配层）。**只加本任务消费的这两个导出**；`getRunById` / `getProjectSessionsPage` 等其它 GOAL-020 barrel 导出归各自的消费者任务，AC-253 负责跨 barrel 的核对。
   - barrel `server/modules/mcp-gateway/index.ts` 导出 `buildSessionStart`、`buildSessionClose`、`McpSessionHostDeps`（各写消费方注释）。
4. **判据文件 `server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + MCP SDK 客户端 + 真实 better-sqlite3 临时库 + 调试 agent）**：形制照 AC-249/AC-250（`mkdtemp` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发带 `['cloudcli:read','cloudcli:session:control']` 的真令牌 + 同一 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`，避开 `listen(0)` 的 undici 坏端口）。宿主层用 **真** `createSessionHostManager()` + 调试 agent 驱动（`DEBUG_AGENT_PROVIDER_ID` + `createDebugAgentHostDriver` + `armDebugAgentScenario`）：一个 `lifecycle_mode='resident'` 的常驻会话、一个 `per-run` 会话、一个 provider 无宿主驱动的会话。**spy 包装真服务**：把从 session-hosts barrel 导入的 `startResidentHost`/`closeResidentHost` 包一层计数 spy 作为 `deps.hosts.start`/`close` 注入装配（装配同时经 `liveHost` 读真管理器）。读数各自独立成断言并逐字写出原始值：
   - (a) **session_start 走服务 + 幂等同 pid**：`session_start({session})` ⇒ 结果 `{ hostId, sessionId, mode:'resident', pid }` 且 `pid` 与 `sessionHostManager.snapshot()` 里该会话的 pid 相等；spy `start` 计数 === 1。再 `session_start({session})` ⇒ 第二个 `pid` 与第一个 **逐字相等**；spy `start` 计数 === 2（证明第二次仍经服务），而驱动 `launches.length === 1` / `spawns() === 1`（服务幂等、无第二个进程）。逐字写出两次 pid 与两个计数。
   - (b) **session_close 走服务、原因 user**：`session_close({session})` ⇒ `closeReason === 'user'`、`hostId` 与启动一致；spy `close` 计数 === 1；之后 `snapshot()` 里该会话无活宿主（host `state === 'closed'`）。逐字写出返回值与关闭后宿主状态。
   - (c) **lease 门**：先起一个常驻会话，用 `addLease(sessionId, { kind:'cron', id:'cron-1', recurring:true, expiresAt: <now+1h> })` 与 `addLease(sessionId, { kind:'background-task', id:'task-1' })` 制造两类 lease；`session_close({session})`（无 force）⇒ `isError`、错误体 `code === 'SESSION_HAS_ACTIVE_LEASES'` 且 `message` 逐字点名 `cron` 与 `background-task` 及其数量（各 1）、`leases` 列出两类；spy `close` 计数 === **0**；`snapshot()` 里宿主仍在、pid 与关闭前 **逐字相等**。再 `session_close({session, force:true})` ⇒ 成功、`closeReason === 'user'`、spy `close` 计数 === 1、宿主消失。**正例对照**：只有 `resident-policy` lease 的常驻会话不带 force 也成功关闭（防「一律拒绝」也通过）。逐字写出两侧返回值、计数与 pid。
   - (d) **既有拒绝码原样**：`per-run` 会话 `session_start` / `session_close` ⇒ `LIFECYCLE_MODE_NOT_RESIDENT`（文案与服务逐字相等）；provider 无宿主驱动的常驻会话 `session_start` ⇒ `LIFECYCLE_MODE_HOST_UNAVAILABLE`（逐字）；不存在的会话 `session_start` / `session_close` ⇒ `SESSION_NOT_FOUND`（逐字）。四个 code 与四句 message 逐字写出。
   - (e) **scope `cloudcli:session:control`**：只带 `['cloudcli:read','cloudcli:session:send']` 的令牌调 `session_start` / `session_close` ⇒ `isError`、`mcp_audit_log` 各新增**恰好一行** `outcome='denied'`（tool 分别为 `session_start`/`session_close`）、spy 计数为 0；带 `cloudcli:session:control` 的令牌成功（正例）。逐字写出审计行与前后计数。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 适配层忽略 lease 直接关闭（去掉 force 门）⇒ (c) 必须红（宿主被关、spy `close` 计数 1）；
   (ii) 网关自带一份启停逻辑而不走服务（适配层内联启动/关闭，不调 `deps.hosts.start`/`close`）⇒ (a) 与 (b) 必须红（spy 计数 0）；
   (iii) 把拒绝码改写成通用错误（拒绝时返回 `code:'MCP_TOOL_ERROR'` 之类，不透出服务的 `code`）⇒ (d) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-251" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-251`；`grep -rln "AC-251" tasks/` 只命中 AC-245/AC-246/AC-249/AC-250 的边界段（各自声明「`session_start`/`session_close` 归 AC-251」：AC-249 只按表注册这两个工具并留 `MCP_TOOL_NOT_IMPLEMENTED` 占位、注明归 AC-250/AC-251；AC-250 只替换 `session_create`/`session_interrupt` 的 handler，`session_start`/`session_close` 仍留占位归 AC-251；AC-245/AC-246 只交付注册缝与通用解析门）。AC-236 已交付被复用的服务本体但**不经 barrel 导出**（推迟给 GOAL-020 消费者）。AC-252（自指保护）、AC-253（装配与 barrel 核对）、AC-254/255（设置页）、AC-256/257（冒烟）均不越界——AC-253 的读数 (b) 核对 `startResidentHost`/`closeResidentHost` 的 barrel 导出与消费者存在，本任务正是落地这两个导出的消费者。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-239 未落地则判据无法 import SDK 客户端；AC-240 未落地则无 `/mcp` 传输与工具注册缝；AC-241 未落地则无令牌中间件与 `McpPrincipal`（(e) 要发真令牌读主体）；AC-244 未落地则无 `withMcpAudit` 包装与 `denied` 审计（(e) 依赖它）；AC-245 未落地则无工具注册缝的消费先例与 MCP 客户端夹具形制；AC-246 未落地则解析门不存在（`session` 字段不会被改写成 sessionId）；AC-249 未落地则写工具集合与这两个工具的注册占位都不存在（本任务只替换 handler、并给 `session_close` schema 补 `force`）。AC-236 已 done，不作为阻塞前置列出。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-251 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) `session_start` 经 `startResidentHost`（spy 计数 ==1）；已运行的常驻会话再次启动返回**同一个 pid**，第二次仍经服务（spy 计数 2）但驱动只启动一次（`launches.length === 1`）；逐字写出两次 pid 与三个计数。
- [x] AC4 (b) `session_close` 经 `closeResidentHost`（spy 计数 ==1），`closeReason === 'user'`、`hostId` 与启动一致，关闭后该会话无活宿主；逐字写出返回值与关闭后宿主状态。
- [x] AC5 (c) 持有 `cron` + `background-task` lease 时不带 `force` ⇒ `isError`、`code === 'SESSION_HAS_ACTIVE_LEASES'`、`message` 逐字点名两类 lease 与各自数量、`leases` 列出；spy `close` 计数 0；宿主仍在且 pid 前后逐字相等；带 `force:true` ⇒ 关闭成功、spy `close` 计数 1；正例对照：仅 `resident-policy` 的会话不带 force 也成功；逐字写出两侧返回值、计数与 pid。
- [x] AC6 (d) 非常驻会话 ⇒ `LIFECYCLE_MODE_NOT_RESIDENT`；provider 无宿主驱动 ⇒ `LIFECYCLE_MODE_HOST_UNAVAILABLE`；会话不存在 ⇒ `SESSION_NOT_FOUND`；三类 code 与 message 与 `resident-host.service.ts` 逐字相等；逐字写出四组 code/message。
- [x] AC7 (e) 仅带 `['cloudcli:read','cloudcli:session:send']` 的令牌调 `session_start` / `session_close` 均被拒（isError）、`mcp_audit_log` 各恰好一行 `tool=` 对应名 / `outcome='denied'`、spy 计数 0；带 `cloudcli:session:control` 的令牌两个工具都成功；逐字写出审计行与前后计数。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 忽略 lease 直接关闭 ⇒ AC5 红；(ii) 网关自带启停逻辑不走服务 ⇒ AC3 与 AC4 红；(iii) 拒绝码改写成通用错误 ⇒ AC6 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；AC-236 判据 `server/modules/session-hosts/tests/resident-host-service.test.ts` 与路由判据 `session-hosts-routes.test.ts` / `resident-ondemand-start-route.test.ts` 不改一字仍逐字通过；AC-249 判据 `mcp-session-send.test.ts`、AC-245/246/248 判据不改一字仍绿（本任务只替换两个 handler、只给 `session_close` schema 补 `force`，不改控制服务、不改工具集合的名字与 scope）。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- `session_start` / `session_close` **真的** 经真实 HTTP + MCP SDK 客户端驱动，且**真的** 经 session-hosts 的 `startResidentHost` / `closeResidentHost` 服务（spy 计数证明），不是网关里第二份启停实现——`session_start` 对已运行常驻会话**真的** 返回同一个 pid 且没有第二个进程。
- `session_close` **真的** 在会话持有 `cron` / `background-task` lease 时、不带 `force` 被拒、错误**真的** 点名 lease 种类与数量，且宿主**真的** 仍在运行（pid 不变）；带 `force: true` **真的** 关闭；只有 `resident-policy` 的常驻会话不带 force **真的** 也能关（不是「一律拒绝」）。
- 三类既有拒绝码（`LIFECYCLE_MODE_NOT_RESIDENT` / `LIFECYCLE_MODE_HOST_UNAVAILABLE` / `SESSION_NOT_FOUND`）**真的** 原样透出，与服务的 code/message 逐字相等。
- `cloudcli:session:control` scope **真的** 由 `withMcpAudit` 按 `MCP_STAGE4_WRITE_TOOLS` 执行：不足的令牌**真的** 被拒、**真的** 写下一行 `denied` 审计、两个服务的计数**真的** 为 0；足够 scope 的令牌**真的** 放行。
- `startResidentHost` / `closeResidentHost` **真的** 从 session-hosts barrel 导出且消费者是网关适配层（AC-253 会核对）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖；不改 `SessionHostManager`、不改控制服务本体；不越界实现 AC-249/AC-250/AC-252–AC-257 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-session-host-control.ts (new)
- server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts (new)（判据）
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/session-hosts/index.ts
- tasks/gap-ac251-mcp-session-host-control.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`）。
- force 门 **必须** 在 `closeResidentHost` **之前**：服务命中活常驻宿主即关闭并在关闭前读回 leases，若先调服务再判 lease，宿主已被关，读不回「宿主仍在运行」。
- `liveHost` 读缝与服务的 `liveHostForSession` 同一读端口（`snapshot()` 里 `state !== 'closed'` 且 `bindings.has(sessionId)`）；它只读不启停，启停仍 100% 委派服务（(a)(b) 的 spy 计数是这条的机械证据，(ii) 是它的反证）。
- `session_close` 的 `force` 是 MCP 工具入参，不进 `MCP_STAGE4_WRITE_TOOLS` 的名字/scope 表；补充 schema 时只加可选字段。
- 边界 lint 会拦新增测试文件（内存 `quay-boundaries-lint-blocks-new-test-files`）；本判据文件已列入 `## Touches`。给 mcp-gateway / session-hosts barrel 加导出后，若某兄弟测试对该 barrel 整体 `vi.mock`，需把新导出补进那个 mock 工厂（内存 `adding-an-export-reds-sibling-wholesale-vimocks`）。
- 判据要求调试 agent 的常驻驱动交出 pid（`snapshot()` 的 `pid`）；`per-run` 会话与「无宿主驱动 provider」用于 (d)，须在夹具里可构造。

## Verification（AC1–AC10 读数）

实际改动文件（`git diff --name-status develop...HEAD`，与 `## Touches` 逐条对齐；两个新增以 `(new)` 计）：
```
M  server/modules/mcp-gateway/index.ts
M  server/modules/mcp-gateway/mcp-gateway.transport.ts
M  server/modules/mcp-gateway/mcp-gateway.write-tools.ts
A  server/modules/mcp-gateway/mcp-session-host-control.ts (new)
A  server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts (new)
M  server/modules/session-hosts/index.ts
```
（第 7 项 `tasks/gap-ac251-mcp-session-host-control.md` 由本 `task_write` 自身提交。）

AC1（红态基线）：改动前运行 AC-251 存在性闸命令，逐字输出：
```
$ for f in server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts
缺判据文件：server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts
EXIT=1
```

AC2（绿）：同一命令退出 0，读数 `# tests 6 / # pass 6 / # fail 0`（node spec reporter 逐字 `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0`，duration ≈ 4.3s）。

AC3 (a)：第一次 `session_start` payload `{"hostId":"host-a5349e39-07d0-4add-9882-982597abd5bb","sessionId":"02f94244-…","mode":"resident","pid":4242}`，`snapshotHost={"hostId":"host-a5349e39-…","pid":4242,"state":"idle"} startSpy=1 launches=1 spawns=1`；第二次 payload 同 `hostId`、同 `pid=4242`，`startSpy=2 launches=1 spawns=1`。两次 pid 逐字相等（4242），服务被调两次、驱动只启动一次。

AC4 (b)：payload `{"hostId":"host-0396b739-…","sessionId":"48b1c9e3-…","mode":"resident","closeReason":"user","leases":[{"kind":"resident-policy"}]} closeSpy=1 liveHostAfter=null`。`closeReason==='user'`，`hostId` 与启动一致，关闭后无活宿主。

AC5 (c)：无 force ⇒ `isError=true payload={"code":"SESSION_HAS_ACTIVE_LEASES","message":"该常驻会话持有 cron×1、background-task×1，关闭会终止其后台工作；如需强行关闭请传 force: true。","leases":[{"kind":"cron","id":"cron-1",…},{"kind":"background-task","id":"task-1",…}]} closeSpy=0 pidAfter=4242`（pid 与关闭前 4242 逐字相等，宿主仍在）。带 force ⇒ `isError=false closeReason":"user" closeSpy=1 liveHostAfter=null`。正例对照：`resident-policy` only 的会话 `isError=false`，无 force 也关闭。

AC6 (d)：四组 code/message：
```
LIFECYCLE_MODE_NOT_RESIDENT (start): Session "ac251-per-run" is stored as "per-run"; only a resident session can be started on demand.
LIFECYCLE_MODE_NOT_RESIDENT (close): Session "ac251-per-run" is stored as "per-run"; only a resident session can be closed on demand.
LIFECYCLE_MODE_HOST_UNAVAILABLE:      Provider "codex" mounts no host driver, so session "ac251-no-driver" cannot be started.
SESSION_NOT_FOUND (start/close):      Session "ac251-unknown" was not found.
```

AC7 (e)：不足 scope 令牌 ⇒ 两工具 `isError=true`；审计逐字 `{"id":1,"tool":"session_start","outcome":"denied",…}`、`{"id":2,"tool":"session_close","outcome":"denied",…}`（各恰好一行，tool 对应）；`startSpy=0 closeSpy=0`。带 `cloudcli:session:control` ⇒ `allowedStart isError=false startSpy=1 allowedClose isError=false closeSpy=1`。

AC8（三条取假形态，均先红后恢复；实现已先提交于 `7f73cd53`）：
- (i) 去掉 force 门（`buildSessionClose` 删去 `live`/`blocking` 门）⇒ (c) 红：`AssertionError: a close with blocking leases and no force must be refused; actual: false, expected: true`（`closeSpy=1 pidAfter=null`）。恢复：`git -C <wt> checkout -- server/modules/mcp-gateway/mcp-session-host-control.ts` → 重跑 6/6 绿。
- (ii) 适配层内联启停、不调 `deps.hosts.start`/`close` ⇒ (a)、(b) 红：`(a) … startSpy=0 launches=0 spawns=0` + `AssertionError: the payload carries the live host pid; actual: 999, expected: 4242`；`(b) … closeSpy=0` + `AssertionError: the close service was reached exactly once; actual: 0, expected: 1`。恢复同上 → 6/6 绿。
- (iii) 拒绝码改写为 `code:'MCP_TOOL_ERROR'` ⇒ (d) 红：`AssertionError: actual: 'MCP_TOOL_ERROR', expected: 'LIFECYCLE_MODE_NOT_RESIDENT'`（另四组同样被改写；仅 (d) 红，其余 5 例仍绿）。恢复同上 → 6/6 绿。

AC9：`npm run typecheck` 退出 0；`npm run lint` 退出 0 且无 `: error `（仅既有 warning 计数，本任务文件 0 条）；AC-236/路由/AC-249/AC-250/AC-245/AC-246/AC-248 判据一字未改，同批运行 `ℹ tests 48 / ℹ pass 48 / ℹ fail 0` 退出 0。

AC10：见上方改动文件清单，与 `## Touches` 逐条对齐（`mcp-session-host-control.ts`、`mcp-session-host-control.test.ts` 两个新增）。
