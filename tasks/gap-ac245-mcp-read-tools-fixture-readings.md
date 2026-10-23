---
id: gap-ac245-mcp-read-tools-fixture-readings
title: AC-245 只读工具在夹具数据上返回正确结果：projects_list/sessions_list 返回全部夹具且 state
  过滤各只返回对应会话、session_get 带宿主（state/pid/leases/peerName）、session_read 的
  latest/outline/around 与工具调用折叠、超 4000 字符按游标分页拼回原文、时间双形态；判据
  server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
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
goal_ac: AC-245
---
## Proposal

AC-245（GOAL-020 退出条件 7 的第一条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 的「MCP 工具 / 通用约定」§257–§260、工具清单 §270–§276、阶段 3 §522）要求只读工具在夹具数据上返回正确结果。判据文件 `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 当前不存在，AC-245 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/` 目录不存在（由 AC-240 创建）；全仓库无任何 MCP 工具注册或只读工具实现；`server/index.ts` 未挂 `/mcp`；`@modelcontextprotocol/sdk` 未声明进 `dependencies`（AC-239）。背后要读的服务已存在并各经 barrel 导出：`getProjectsWithSessions` / `getProjectSessionsPage`（`server/modules/projects/services/projects-with-sessions-fetch.service.ts`，经 `server/modules/projects/index.ts`）、`sessionsService.fetchHistory` / `fetchWindowAround` / `fetchOutline` / `listRecentSessions`（`server/modules/providers/services/sessions.service.ts`，经 `server/modules/providers/index.ts`）、`sessionHostManager.snapshot()` / `liveHostForSession()` 与 `ProcessHost`（state、pid、leases、peerName）（`server/modules/session-hosts/`）、`chatRunRegistry`（`listRunningRuns`、`getRunById`；`server/modules/websocket/`）。

要交付：

1. **只读工具注册与实现（新文件 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts`；遵守 `$backend-module-standards`）**：
   - 导出 `export const MCP_STAGE3_READ_TOOLS = [...] as const`：**恰好**本阶段（SPEC 工具清单 阶段 3）的 7 个只读工具名与各自所需 scope `cloudcli:read`：`overview`、`projects_list`、`sessions_list`、`session_get`、`session_read`、`run_get`、`quay_snapshot`。这是 (a)「恰好是本阶段的只读工具集合」的唯一事实来源；写工具一律不在此集合内。
   - `export function registerMcpReadTools(registrationSeam, deps: McpReadToolDeps): void`——经 AC-244 落地的工具注册缝（`withMcpAudit` 包装）**逐个注册上述 7 个工具**，每个带描述、`inputSchema`（zod）、`requiredScope`（取自 `MCP_STAGE3_READ_TOOLS`，不手写第二份字面量）与 `outputSchema`。本任务**完整实现** `projects_list`、`sessions_list`、`session_get`、`session_read` 四个（(b)–(f) 的对象）；`overview`、`run_get`、`quay_snapshot` 的**行为归 AC-247 / AC-248**，本任务只按上表注册（名字、scope、描述、输入 schema 正确），其 handler 主体返回一个明确的 `isError`（`code: 'MCP_TOOL_NOT_IMPLEMENTED'`，注明归 AC-247/AC-248）——**注册全 7 个是为了让 (a) 的「恰好」是一个稳定集合，AC-247/248 落地只替换这三个 handler，不改变集合**。
   - `McpReadToolDeps`（全部可注入，判据传真单例或自己驱动的实例）：`projects`（`getProjectsWithSessions`/`getProjectSessionsPage`）、`sessions`（`fetchHistory`/`fetchOutline`/`fetchWindowAround`/`listRecentSessions`）、`hosts`（`snapshot`/`liveHostForSession`）、`runs`（`listRunningRuns`/`getRunById`）、`activity`（阶段读数）、`now`（可注入时钟）。生产由 `server/index.ts`/`mountMcpGateway` 传进程单例；判据传自己驱动的实例（含调试 agent 宿主驱动的常驻会话）。
   - 工具行为要点（逐条对应读数，详细规则见 SPEC 工具清单）：
     - `projects_list`（(b)）：返回夹具里的全部项目（名、id、路径、会话数、相对时间 + ISO）；`includeArchived` 缺省 false。
     - `sessions_list`（(b)）：返回夹具里的全部会话（标题、id、provider、生命周期模式、宿主 state、是否运行中、最近活动）；`state` 过滤取 `'running' | 'idle' | 'resident' | 'any'`（缺省 `'any'`），三条谓词**唯一定义**：`running` = 该会话有存活运行（`runs.listRunningRuns()` 命中）；`resident` = 会话 `lifecycle_mode === 'resident'`；`idle` = 既非 running 也非 resident；`any` = 全部。夹具把三种各造一个（按次进程 busy、按次进程 quiet、常驻 idle），使三个集合按构造互不相交；**空过滤结果返回空列表而非报错**（例如某项目下无 running 会话时 `state:'running'` 返回 `[]`，`isError` 为 false）。
     - `session_get`（(c)）：会话元数据 + `host`（常驻会话：`state`、`pid`、`startedAt`、`idleFor`、`peerName`、`leases`，取自宿主快照的 `ProcessHost`/`SessionBinding`）+ 当前运行摘要；**冷会话（无宿主）明确说明「没有宿主」，而不是缺键或抛错**。leases 必须原样带出（`turn`/`cron`/`background-task`/`resident-policy`）。
     - `session_read`（(d)(e)）：`mode` 缺省 `latest`——最后 N 条消息（缺省 N=5，`limit` 可调），**工具调用折叠成一行**（`tool_use` 与其 `tool_result` 合成一条可读行）；`outline`——所有用户轮次（`fetchOutline`）；`around`——以某条消息为中心的窗口（`fetchWindowAround(sessionId, { aroundId, before, after })`）。所有模式走 `sessionsService` 的对应读函数，不自己解析 transcript。
   - **截断与游标（(e)，独立 helper）**：`export function paginateMcpText(text: string, cursor?: string): { content: string; cursor?: string }`——单块上限 **4000 字符**；超限则返回第一段 + `cursor`（不透明 token，编码下一段偏移，如 base64 `<offset>`）；**不超限时不得返回 cursor**；顺着 cursor 反复调用，把各段 `content` 依次拼接必须**逐字等于原文**（含空白与换行）。用于 `session_read`（及其它文本可能超限的只读工具）的输出。
   - **时间（(f)）**：`export function formatMcpTime(ms: number, now: () => number): { relative: string; iso: string }`——同一时间同时给相对时间（如 `3 分钟前`）与 ISO 时间戳；所有只读工具输出的时间字段都用它。id 一律原样返回（不截断、不哈希）。
   - 遵守 `$backend-module-standards`：跨模块只经 barrel（projects/providers/session-hosts/websocket）；导出带消费方注释；不导出无消费者符号；≥2 处使用的 helper 进 `server/shared/utils.ts`。
2. **接线（`server/modules/mcp-gateway/mcp-gateway.transport.ts` + `server/modules/mcp-gateway/index.ts` + `server/index.ts`）**：`mountMcpGateway` 在工具注册缝里调用 `registerMcpReadTools`（以 AC-240/AC-244 实际落地的缝形状为准：若缝是 `deps.registerTools(server)`，则在该回调里注册；若传输直接注册，则调 `registerMcpReadTools`）。`server/index.ts` 组装 `McpReadToolDeps`（进程单例：projects/providers/session-hosts/websocket 的读服务 + `now: () => Date.now()`）传给 `mountMcpGateway`。barrel `server/modules/mcp-gateway/index.ts` 导出 `MCP_STAGE3_READ_TOOLS`、`registerMcpReadTools`、`paginateMcpText`、`formatMcpTime`、`McpReadToolDeps`，各写消费方注释。**若 AC-240/AC-244 落地的缝不允许在注册时注入 deps，先用 `task_write` 把需改的文件加进本任务 `## Touches` 再改**（`quay-touches-must-match-actual-write-sites`）。
3. **判据文件 `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + MCP SDK 客户端 + 真实 better-sqlite3 临时库 + 真实宿主驱动）**：`mkdtemp` 建临时目录、`closeConnection()`、`process.env.DATABASE_PATH` 指向临时库、`initializeDatabase()`、插 owner 用户行，用注入时钟的 `createAccessTokensService` 发一个带 `['cloudcli:read']` 的真令牌；同一 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`（认证用 AC-241 的真实令牌中间件，工具注册缝注册 AC-245 的只读工具）。**客户端用 MCP SDK 的 `Client` + `StreamableHTTPClientTransport`**（AC-245 明确要求 SDK 客户端）；为避免 `listen(0)` 在本机抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`），给 transport 传一个基于 `node:http` 的 `fetch`（SDK 的 `StreamableHTTPClientTransportOptions` 有 `fetch?: FetchLike`），或把服务器绑到一个探测过的可用端口。夹具按 SPEC：两个项目；若干按次进程会话；一个**常驻会话由调试 agent 宿主驱动**（形制照 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`：`createSessionHostManager` + `createDebugAgentHostDriver`，把会话 resident 绑定到宿主，并加 `turn`/`cron`/`background-task` lease 使 `leases` 非空、`peerName` 可读）；一份带**用户轮、助手轮、工具调用**的转录（`jsonl_path` 指到临时文件，或经 provider fixture），并有**一条超过 4000 字符的消息**。读数各自独立成断言并逐字写出原始值：
   - (a) **tools/list 恰好是只读集合**：SDK 客户端 `listTools()` 返回的工具名集合与 `MCP_STAGE3_READ_TOOLS` 的 7 个名**集合相等**（写出两边逐字排序后的名字），且**没有任何写工具名**（`session_send`/`session_create`/`session_interrupt`/`session_start`/`session_close` 均不在其中）；每个工具的注册里都声明了所需 scope（断言每个的 `requiredScope === 'cloudcli:read'`，写出每个工具名与 scope）。正例对照：集合非空且含 `projects_list`、`sessions_list`、`session_get`、`session_read` 四个（防「空集合」也通过）。
   - (b) **projects_list 与 sessions_list 返回全部夹具 + state 过滤**：`projects_list` 返回夹具的**全部**项目（逐一列出 id/名）；`sessions_list`（无过滤）返回夹具的**全部**会话（逐一列出 id/标题/是否 running/是否 resident/lifecycleMode）；`sessions_list({state:'running'})` **只**返回 running 会话、`{state:'resident'}` **只**返回常驻会话、`{state:'idle'}` **只**返回 idle 会话（三者逐字写出返回的 id 列表并断言与夹具构造的预期集合相等）；一个夹具里无命中的过滤（如某项目下无 running 会话）**返回空列表**、工具调用 `isError` 为 false（不是抛错）。正例对照：无过滤返回数 ≥ 各过滤返回数且四个读数都非空（防「什么都不返回」也通过）。
   - (c) **session_get 的宿主状态**：对常驻会话 `session_get` 返回 `host`，断言 `host.state` 是有效 `HostState`、`host.pid` 是正整数、`host.leases` **非空**且逐条写出（至少一个 `turn`/`cron`/`background-task` 之一）、`host.peerName` 非 null（与宿主驱动注册的名字逐字相等）；对冷会话（按次进程、无宿主）返回体**明确说明没有宿主**（写出原始文案/字段），且不抛错。正例对照：常驻会话的 `host` 确实非空（防「一律说没有宿主」也通过）。
   - (d) **session_read 三模式**：`latest`（缺省）返回最后 N 条消息，且**工具调用折叠成一行**（写出折叠行的原始文本，断言 `tool_use` 与 `tool_result` 合成一条、不是两条独立消息）；`outline` 返回夹具转录里的**全部用户轮次**（逐一写出轮次，与夹具逐条一致）；`around`（给定某条消息 id）返回以它为中心的窗口（写出窗口内消息 id，断言目标在窗口内且前后条数符合 `before`/`after`）。正例对照：三模式都返回非空消息（防「什么都不返回」也通过）。
   - (e) **4000 字符截断 + 游标拼回原文**：对那条超过 4000 字符的文本，`session_read`（或触发它的只读工具）返回的第一段 `content` 长度 ≤ 4000 且**带 `cursor`**；顺着 `cursor` 反复调用直到没有 `cursor`，把各段 `content` 依次拼接，断言**逐字等于原文**（写出原文长度、每段长度、拼接后长度与 `拼接 === 原文` 的布尔）；再断言一段**不超过 4000 字符**的文本**不返回 `cursor`**（正例对照，防「一律返回 cursor」或「一律截断」也通过）。逐字写出原始 cursor 与末段读数。
   - (f) **时间双形态**：`projects_list`/`sessions_list`/`session_get` 输出的时间字段**同时**含相对时间（形如 `X 分钟前`）与 ISO 8601 时间戳（断言用可注入时钟，使相对时间可精确预期，写出原始两个值）。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) `sessions_list` 忽略 `state` 过滤（`state` 参数被读但不用，或恒返回全部）⇒ (b) 必须红；
   (ii) 超限截断后不给 `cursor`（或 cursor 只覆盖第一段、前进偏移不对，导致拼接 ≠ 原文）⇒ (e) 必须红；
   (iii) `session_get` 丢掉 `leases`（`host.leases` 恒为 `[]` 或省略）⇒ (c) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-245" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-245`；`grep -rln "AC-245" tasks/` 只命中 AC-240/AC-241/AC-242/AC-243/AC-244 的边界段（各自声明「不实现任何真实只读工具（AC-245+）」）。AC-246（名称模糊匹配）、AC-247（overview 冷缓存零 quay CLI + quay_snapshot 刷新）、AC-248（run_get 有界等待）是**不同读数与不同判据文件**（`mcp-resolve-target.test.ts`/`mcp-overview.test.ts`/`mcp-run-get.test.ts`），各自直接覆盖；本任务只在 (a) 里按名字注册它们的工具，不测其行为、不写其判据。写工具（AC-249–AC-251）、自指保护（AC-252）、设置页（AC-254/255）、冒烟（AC-256/257）均不越界。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-239 未落地则 SDK 未进 `dependencies`（判据要 import SDK 客户端）；AC-240 未落地则无 `/mcp` 传输与工具注册缝；AC-241 未落地则无令牌中间件与 `McpPrincipal`；AC-244 未落地则无 `withMcpAudit` 包装与注册缝。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-245 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-read-tools.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) `listTools()` 工具名集合与 `MCP_STAGE3_READ_TOOLS` 的 7 个名集合相等、无任何写工具名、每个声明 scope `cloudcli:read`；逐字写出两组名字与每个工具名+scope（正例对照：含四个被测只读工具）。
- [x] AC4 (b) `projects_list` 与 `sessions_list` 返回全部夹具项目/会话；`state` 三值各只返回对应会话（按谓词定义与夹具预期集合相等）；空过滤返回空列表且非 isError；逐字写出各个 id 列表与前后计数。
- [x] AC5 (c) 常驻会话 `session_get` 带 `host`（state、pid、非空 leases 且逐条列出、peerName 与驱动注册名相等）；冷会话明确说明没有宿主且不抛错；逐字写出两侧原始读数。
- [x] AC6 (d) `session_read` 的 `latest` 工具调用折叠成一行、`outline` 返回全部用户轮次、`around` 返回含目标的窗口；逐字写出折叠行文本、轮次列表、窗口消息 id。
- [x] AC7 (e) 超 4000 字符文本首段 ≤4000 且带 cursor，顺 cursor 取完拼接逐字等于原文；≤4000 字符文本不返回 cursor；逐字写出原文/各段长度/拼接读数与 cursor。
- [x] AC8 (f) 时间字段同时含相对时间与 ISO 时间戳（注入时钟下可预期）；逐字写出原始两值。
- [x] AC9 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) `state` 过滤被忽略 ⇒ AC4 红；(ii) 截断不给 cursor / cursor 取不全 ⇒ AC7 红；(iii) `session_get` 丢掉 leases ⇒ AC5 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC10 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；既有 `server/modules/providers/tests/*.test.ts`（`fetchHistory`/`fetchOutline`/`fetchWindowAround`）、`server/modules/session-hosts/tests/*.test.ts`（`snapshot`）、`server/modules/projects` 的既有判据不改一字仍逐字通过（本任务只新增只读工具与注册，不改被读服务）。
- [x] AC11 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## Evidence

判据命令（AC1，判据文件缺席时的红态基线）：

```
$ for f in server/modules/mcp-gateway/tests/mcp-read-tools.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
exit=1
```

AC2（绿）：

```
ℹ tests 6
ℹ pass 6
ℹ fail 0
ℹ duration_ms 4604.521966   (exit 0)
```

AC3 (a)：

```
[a] tools/list names           = ["overview","projects_list","quay_snapshot","run_get","session_get","session_read","sessions_list"]
[a] MCP_STAGE3_READ_TOOLS names = ["overview","projects_list","quay_snapshot","run_get","session_get","session_read","sessions_list"]
[a] declared overview|projects_list|sessions_list|session_get|session_read|run_get|quay_snapshot requiredScope=cloudcli:read  (7/7)
[a] write tools absent = ["session_send","session_create","session_interrupt","session_start","session_close"]
[a] projects_list with a token lacking cloudcli:read -> isError=true text="Insufficient scope for this tool."
[a] overview -> isError=true text="{\"code\":\"MCP_TOOL_NOT_IMPLEMENTED\",\"tool\":\"overview\",\"owner\":\"AC-247\",...}"
[a] run_get  -> isError=true text="{\"code\":\"MCP_TOOL_NOT_IMPLEMENTED\",\"tool\":\"run_get\",\"owner\":\"AC-248\",...}"
[a] quay_snapshot -> isError=true text="{\"code\":\"MCP_TOOL_NOT_IMPLEMENTED\",\"tool\":\"quay_snapshot\",\"owner\":\"AC-247\",...}"
```

AC4 (b)：

```
[b] projects_list = [{"id":"…","name":"alpha-workspace","path":"<tmp>/alpha-workspace","sessionCount":2,"lastActivity":{"relative":"55 分钟前","iso":"2026-09-01T11:05:00.000Z"},"isArchived":false},
                     {"id":"…","name":"beta-workspace","path":"<tmp>/beta-workspace","sessionCount":2,"lastActivity":{"relative":"56 分钟前","iso":"2026-09-01T11:04:00.000Z"},"isArchived":false}]
[b] sessions_list(all) = 4 rows:
      read-fixture-busy     "Busy session"     claude per-run   hostState=null        running=true
      read-fixture-quiet    "Quiet session"    claude per-run   hostState=null        running=false
      read-fixture-resident "Resident session" claude resident  hostState="lingering" running=false
      read-fixture-big      "Big session"      claude per-run   hostState=null        running=false
[b] state=running  -> ["read-fixture-busy"]
[b] state=resident -> ["read-fixture-resident"]
[b] state=idle     -> ["read-fixture-big","read-fixture-quiet"]
[b] project=beta state=running -> {"sessions":[],"total":0} isError=false
```

AC5 (c)：

```
[c] session_get(read-fixture-resident).host = {"hostId":"host-…","mode":"resident","state":"lingering","pid":531013,
      "startedAt":{"relative":"刚刚","iso":"2026-09-01T12:00:00.000Z"},"idleForMs":0,"peerName":"read-fixture-peer",
      "leases":[{"kind":"resident-policy"},
                {"kind":"cron","id":"read-fixture-cron","recurring":true,"expiresAt":1788267600000},
                {"kind":"background-task","id":"read-fixture-bg","since":1788264000000}]}
[c] host.state="lingering"  host.pid=531013 (positive integer)  host.peerName="read-fixture-peer"
[c] session_get(read-fixture-quiet) host=null hostNote="没有宿主：该会话当前没有宿主进程（按次进程模式且未运行）。"  isError=false
```

AC6 (d)：

```
[d] latest lines (5) = ["[2026-09-01T11:00:00.000Z] user: First question: what does the read tool return?",
                        "[2026-09-01T11:00:01.000Z] assistant: It reads the normalized history.",
                        "[2026-09-01T11:00:02.000Z] tool Bash({\"command\":\"echo read-fixture-hello\"}) -> read-fixture-hello",
                        "[2026-09-01T11:00:04.000Z] user: Second question: does the tool call fold onto one line?",
                        "[2026-09-01T11:00:05.000Z] assistant: Yes, one line."]
[d] folded tool lines = 1  (the two raw JSONL rows a-read-tool / u-read-tool-result draw as ONE line; no line begins with a bare tool_result)
[d] outline lines = ["[2026-09-01T11:00:00.000Z] #0 u-read-1: First question: …", "[2026-09-01T11:00:04.000Z] #3 u-read-2: Second question: …"]
[d] around(a-read-tool_0) lines = 3, middle line is the folded Bash call
```

AC7 (e)：

```
[e] paginateMcpText: original=5041 chunks=[4000,1041] reassembled=5041 equal=true
[e] session_read(big) first chunk length=4000 cursor="NDAwMA=="
[e] session_read(big) chunk lengths=[4000,1055] reassembled=5055 containsFixtureText=true
[e] short session_read payload keys = ["session","mode","content"]   (no cursor key at all)
```

AC8 (f)：`NOW = 2026-09-01T12:00:00.000Z`（注入时钟）；四个会话 lastActivity = `{"relative":"55 分钟前","iso":"2026-09-01T11:05:00.000Z"}` / `56 分钟前` / `57 分钟前` / `58 分钟前`；`projects_list` 与 `session_get` 同形。

AC9 取假形态（先提交实现 `85db9402` 再变异；每条记录 diff、失败行、恢复命令）：

(i) `sessions_list` 忽略 `state` —— 变异 diff 删去三行谓词、改为 `void state; return true;`：
```
-          if (state === 'running') return session.running;
-          if (state === 'resident') return isResident(session);
-          if (state === 'idle') return !session.running && !isResident(session);
+          // FALSE FORM (i): `state` is read above and then ignored here.
+          void state;
           return true;
```
失败行（(b) 红，5 pass / 1 fail）：
```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
actual:   [ 'read-fixture-big', 'read-fixture-busy', 'read-fixture-quiet', 'read-fixture-resident' ],
expected: [ 'read-fixture-busy' ],
```
恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-gateway.read-tools.ts` → 重跑 `ℹ pass 6 ℹ fail 0`。

(ii) 截断不给 cursor —— 变异 diff：
```
-  return next < text.length ? { content, cursor: encodeMcpCursor(next) } : { content };
+  return { content: text.slice(offset, offset + MCP_TEXT_CHUNK_CHARS) };
```
失败行（(e) 红，5 pass / 1 fail）：
```
AssertionError [ERR_ASSERTION]: the over-long original must need more than one chunk
```
恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-gateway.read-tools.ts` → 重跑 `ℹ pass 6 ℹ fail 0`。

(iii) `session_get` 丢掉 `leases` —— 变异 diff：
```
-              leases: binding.leases.map((lease) => ({ ...lease })),
+              // FALSE FORM (iii): the binding's leases are dropped.
+              leases: [],
```
失败行（(c) 红，5 pass / 1 fail）：
```
AssertionError [ERR_ASSERTION]: the resident binding must carry leases
```
恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-gateway.read-tools.ts` → 重跑 `ℹ pass 6 ℹ fail 0`。

AC10：

```
$ npm run typecheck    → exit 0 (tsconfig.json + server/tsconfig.json + scripts/tsconfig.json)
$ npm run lint         → exit 0；`: error ` 计数 = 0（213 warnings，全部为本任务之前既有；本任务改动的 7 个文件零 warning）
$ npx tsx --tsconfig server/tsconfig.json --test <each existing file>:
   mcp-gateway/tests: dependency-declaration 4/0, mcp-audit 5/0, mcp-auth 5/0, mcp-loopback-guard 5/0, mcp-transport 4/0, oauth-metadata-mount 6/0
   session-hosts/tests: backgroundTaskLeaseSince 1/0, lifecycle-mode 9/0, process-containment 1/0, resident-host-service 5/0,
     resident-idle-timeout-config 4/0, resident-ondemand-start-route 2/0, resident-server-restart 4/0, session-host-bindings 6/0,
     session-host-default-wrap 6/0, session-host-lifecycle 6/0, session-host-per-run-parity 5/0, session-hosts-routes 7/0
   providers/tests: session-turn-outline 3/0, session-window-around 7/0（fetchHistory / fetchOutline / fetchWindowAround）
   projects/tests: 7 files, 30/0
```

AC11：`git diff --stat develop...HEAD`

```
 server/index.ts                                          |  25 +-
 server/modules/mcp-gateway/index.ts                      |  23 +
 server/modules/mcp-gateway/mcp-gateway.audit.ts          |  56 +-
 server/modules/mcp-gateway/mcp-gateway.read-tools.ts     | 732 ++++++ (new)
 server/modules/mcp-gateway/mcp-gateway.transport.ts      |  60 +-
 server/modules/mcp-gateway/tests/mcp-read-tools.test.ts  | 788 ++++++ (new)
 server/modules/projects/index.ts                         |   9 +
 7 files changed, 1674 insertions(+), 19 deletions(-)
```

两点实现说明（不改变读数）：
1. **常驻夹具的宿主驱动用了脚本书写驱动而非调试 agent 驱动**。调试 agent 的闸是「进程内首次读取即缓存」，而 `provider.registry.ts` 在模块加载时就调 `createDebugAgentProvider`，即本判据自身的（传递）静态导入会在任何环境变量可设之前就把闸读成 closed，`createDebugAgentHostDriver` 因此恒返回 null。管理器、绑定、lease 账本与 identity sink 两种写法完全相同；脚本驱动经文档化的 sink 上报 peerName 与 lease，不手写 host 对象（任务 Notes 的退路，逐字照办）。
2. `McpReadToolDeps` 只声明本任务真的读取的成员（`runs: { listRunningRuns }`）；`getRunById` 与 `activity` 属 AC-247/AC-248 的读数，落地时由该任务扩展 deps，本任务不预留无消费者的探测面。

## DoD

- 只读工具**真的**经真实 HTTP + MCP SDK 客户端驱动，读的是真库与真夹具（项目、按次进程会话、调试 agent 宿主驱动的常驻会话、含用户/助手/工具调用且有一条超 4000 字符的转录）——不是「函数被调用」或「判据文件存在」就算数。
- `tools/list` **真的**恰好是本阶段 7 个只读工具、每个声明 `cloudcli:read`、无写工具；`state` 三值过滤**真的**各只返回对应会话且空过滤为空不报错。
- `session_get` **真的**对常驻会话带出宿主 `state`/`pid`/`leases`/`peerName`（leases 从真宿主快照读回、非空），对冷会话**真的**说明没有宿主。
- `session_read` **真的**三模式返回正确消息、工具调用**真的**折叠成一行；超 4000 字符文本**真的**截断并给 cursor，顺着取完**真的**逐字拼回原文。
- 时间**真的**双形态（相对 + ISO），用注入时钟可预期。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号、≥2 处使用的工具进 `server/shared/utils.ts`）与 AGENTS.md；不引入新依赖（SDK 由 AC-239 声明）；不越界实现 AC-246–AC-257 的读数与判据。
- (a) 里 `overview`/`run_get`/`quay_snapshot` 的行为**不在本任务**：本任务只注册其名字/scope/描述/输入 schema（handler 返回明确的「归 AC-247/AC-248」isError），使 `tools/list` 集合稳定；AC-247/248 落地只替换这三个 handler，不改集合、不改本任务判据。

## Touches

- server/modules/mcp-gateway/mcp-gateway.read-tools.ts (new)
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/projects/index.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts (new)（判据）
- tasks/gap-ac245-mcp-read-tools-fixture-readings.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240/AC-241/AC-242/AC-243/AC-244 同款说明）。SDK 的 transport options 确有 `fetch?: FetchLike`（`node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts`），所以既能满足「MCP SDK 客户端」又避开坏端口。
- 常驻夹具用调试 agent 宿主驱动，形制照 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`（`createSessionHostManager` + `createDebugAgentHostDriver` + `armDebugAgentScenario`；`DEBUG_AGENT_PROVIDER_ID`）：把目标会话 `lifecycle_mode='resident'` 绑定到宿主，并加 `turn`/`cron`/`background-task` lease 使 `leases` 非空、`peerName` 非 null。若该驱动难以在单测内起，退路是直接 `createSessionHostManager` 并 `bindSession`，再经管理器 API 加 lease——仍从 `snapshot()`/`liveHostForSession()` 读回，不手写 host 对象。
- scope 字面量 `cloudcli:read` 取自 SPEC §326；若 AC-243 已落地 `ACCESS_TOKEN_SCOPES`，从 `@/modules/oauth/index.js` 导入该常量而不是重写；未落地时用字面量（AC-243 不列为硬前置，因为签发路径在缺省/任意非空子串下都能签出该 scope）。
- `MCP_STAGE3_READ_TOOLS` 是 (a)「恰好」的唯一事实来源；AC-247/248 引入工具行为时**不得**新增/改名工具，只在既有名字上填 handler（否则本判据红，属预期——集合是契约）。
- 截断的 4000 是**字符**（`String.length` 计码元，中文一字一码元）而非字节；cursor 不透明，编码下一段**字符**偏移（如 base64(String(offset))），不依赖任何内部状态（无状态传输）。
- 时间的相对形态不引入新依赖（不用 dayjs/date-fns），自写小函数；相对时间在注入 `now` 下必须可精确预期（写出用例）。
- 名称模糊匹配（AC-246）不在本任务：本任务 `session_get`/`session_read` 的 `session` 参数先按**精确 id** 取（夹具用 id）；AC-246 落地后在解析前加子串解析。本任务不实现多义/无命中的候选列表——那属 AC-246。
