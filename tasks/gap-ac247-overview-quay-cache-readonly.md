---
id: gap-ac247-overview-quay-cache-readonly
title: AC-247 overview 一次给出全局状态：只读 quay 缓存（冷缓存零 quay CLI 调用）、quay_snapshot
  单独刷新且一次一个项目；判据 server/modules/mcp-gateway/tests/mcp-overview.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac245-mcp-read-tools-fixture-readings
goal_ac: AC-247
---
## Proposal

AC-247（GOAL-020 退出条件 7 的 overview / quay 缓存条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1「MCP 工具」§270、§276、阶段 3 §522、风险表 §552）要求 MCP 网关的 `overview` 一次给出全局状态：会话侧给出运行中会话（项目、标题、回合阶段、已运行时长）、阶段为 `awaitingPermission` 的会话、保留期内被中止的运行、常驻宿主一览（state 与 leases）；quay 侧**只读 `quayService` 的缓存**，缓存命中的项目带任务计数与 driver、suite 状态，缓存未命中的项目标为「未知」并且**不触发任何 quay CLI 调用**（避免对 N 个项目冷启动扇出），项目数再多（20 个）运行器调用数仍为 0；刷新只能经 `quay_snapshot`，且一次只接受一个项目。判据文件 `server/modules/mcp-gateway/tests/mcp-overview.test.ts` 当前不存在，AC-247 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-overview.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/` 目录不存在（由 AC-240 创建）；AC-245 在注册缝里注册 7 个只读工具，但 `overview`/`quay_snapshot` 的 handler 主体只返回 `isError`（`code: 'MCP_TOOL_NOT_IMPLEMENTED'`）——本任务把这两个 handler 替换为真实实现，**不改工具集合**。可读的数据源已存在并各经 barrel 导出：`chatRunRegistry`（`listRunningRuns()`；`getRunById()`；`chat-run-registry.service.ts` 的 `DEFAULT_RUN_RETENTION_MS = 5 * 60 * 1000`）、`activityStore`（`snapshot(sessionId)` 的 `turn.phase: TurnPhase`，含 `'awaitingPermission'`；`server/modules/websocket/`）、`sessionHostManager.snapshot()`（`ProcessHost[]`，含 `state` 与 `bindings` 的 `leases`/`peerName`；`server/modules/session-hosts/`）、`getProjectsWithSessions`（`ProjectWithSessions`：`projectId`/`displayName`/`path`/`sessions`；`server/modules/projects/`）。quay 侧 `quayService`（`server/modules/quay/quay.service.ts`，经 `server/modules/quay/index.ts`）已有 `getQuaySnapshot(projectId, { forceRefresh? })` 与 `getQuayStatus(projectId)`，但**没有任何「只读缓存、绝不装载」的入口**：`getQuaySnapshot(projectId, {})` 在缓存未命中时会走 `loadSnapshot` → `collectSnapshot` → 逐个 `runCommand`（`task list`/`goal list`/`adr list`/`driver status`/`config validate`/`server status`），即**会 spawn CLI**。这正是 AC-247 要消除的扇出：`overview` 不能调用 `getQuaySnapshot` 的装载路径。

要交付：

1. **quay 缓存只读入口（`server/modules/quay/quay.service.ts` + `server/modules/quay/index.ts`）**：在 `createQuayService` 里新增
   `getCachedSnapshot(projectId: string): QuaySnapshot | null`——**只读内存 TTL 缓存**：命中且未过期时返回 `{ ...cached.snapshot, cached: true }`，否则返回 `null`；**绝不调用 `loadSnapshot`/`collectSnapshot`/`runCommand`**。在返回对象与 barrel `server/modules/quay/index.ts` 导出（带消费方注释：MCP `overview` 工具消费，AC-247）。**不改** `getQuaySnapshot` 的既有语义（Tier-2 面板仍经它按需装载）。
2. **最近运行枚举（`server/modules/websocket/services/chat-run-registry.service.ts` + `server/modules/websocket/index.ts`）**：新增
   `listRecentRuns(): ChatRunSummary[]`——返回注册表当前持有、且仍在保留期内的运行摘要（`running` 全部；`completed`/`aborted` 仅当 `now() - completedAt <= retentionMs`，与 `getRunById` 的过期判据同一条）。`overview` 用它筛出 `status === 'aborted'` 的运行（注册表只保留完成/中止的运行 5 分钟；摘要里没有退出码，只有 `status`）。在 barrel 导出 `ChatRunSummary` 类型（消费方注释：MCP `overview`）。
3. **overview / quay_snapshot 实现（新文件 `server/modules/mcp-gateway/mcp-overview-tools.ts`；遵守 `$backend-module-standards`）**：导出
   - `export type McpQuayRunner = { hasQuayConfig(projectId: string): boolean; readCached(projectId: string): QuaySnapshot | null; refresh(projectId: string): Promise<QuaySnapshot | null> }`——**注入的 quay 命令运行器缝**：`refresh(projectId)` 一次调用 = 对**恰好一个项目**的一次快照刷新（生产绑定到 `quayService.getQuaySnapshot(projectId, { forceRefresh: true })`），是读数里的「运行器调用计数」；`readCached` 绑定到新增的 `getCachedSnapshot`（零 CLI）；`hasQuayConfig` 绑定到 `getQuayStatus(projectId)?.hasQuayConfig ?? false`。
   - `export type McpOverviewDeps`（在 AC-245 落地的 `McpReadToolDeps` 基础上加 `quay: McpQuayRunner`；若 AC-245 的 deps 形状不同则以实际落地为准，先用 `task_write` 把需改文件加进 `## Touches` 再改——`quay-touches-must-match-actual-write-sites`）：`projects`（`getProjectsWithSessions`）、`sessions`（会话 id → 标题/项目）、`runs`（`listRunningRuns` + `listRecentRuns`）、`activity`（`snapshot(sessionId).turn.phase`）、`hosts`（`snapshot()`）、`quay`（上述 `McpQuayRunner`）、`now`（可注入时钟）。
   - `export function buildOverview(deps: McpOverviewDeps): OverviewPayload` 与 `export async function buildQuaySnapshot(input: { project: string; refresh?: boolean }, deps: McpOverviewDeps): Promise<...>`；`registerMcpOverviewTools` 在 AC-244/AC-245 的注册缝里**替换** `overview`/`quay_snapshot` 两个已有名字的 handler（**不新增、不改名工具**）。
   - `overview`（输入 `{}`）读数：
     - **会话侧**：`running`——`runs.listRunningRuns()` 每条的 `{ project（经 projects/sessions 解析）, title, phase（activity.snapshot(sessionId).turn.phase）, elapsedMs（now() - startedAt）}`；`awaitingPermission`——凡 `activity.snapshot(sessionId).turn.phase === 'awaitingPermission'` 的会话单列一份（`activityStore.snapshot` 是唯一来源，不自己造）；`aborted`——`runs.listRecentRuns()` 里 `status === 'aborted'` 的运行（保留期内）；`hosts`——`hosts.snapshot()` 中带常驻 binding 的宿主一览，每条 `{ hostId, state（HostState）, sessionId, leases（逐条原样）, peerName }`。
     - **quay 侧**：对 `projects` 里的每个项目调用 `quay.hasQuayConfig(projectId)`；为真则 `quay.readCached(projectId)`——命中时给 `{ projectId, tasks: { total, ... }, driver: { state }, suite: { state } }`（取自 `QuaySnapshot` 的 `tasks`/`driver`/`tests.current`）；未命中标 `{ projectId, status: 'unknown' }`；`hasQuayConfig` 为假的项目标「该项目没有 quay」。**`overview` 在任何路径上都不得调用 `quay.refresh`**（结构性：`buildOverview` 的 deps 类型只暴露 `readCached`/`hasQuayConfig`，`refresh` 只由 `buildQuaySnapshot` 调用）。
   - `quay_snapshot`（输入 `{ project: string, refresh?: boolean }`，**`project` 是单个字符串，schema 不接受数组**）：`refresh` 缺省/false 时 `quay.readCached(project)`（零运行器调用）；`refresh: true` 时 `await quay.refresh(project)`（**恰好一次运行器调用**，只针对该 `project`）；返回该项目的任务计数、最近任务、goal/ADR 计数、driver、suite、fan-in；项目无 quay 配置时返回「该项目没有 quay」的非错误说明；未知项目同样不抛错。
4. **接线与导出**：在 AC-245 的注册路径（`server/modules/mcp-gateway/mcp-gateway.read-tools.ts`）替换两个 handler 的实现体；barrel `server/modules/mcp-gateway/index.ts` 导出 `buildOverview`/`buildQuaySnapshot`/`registerMcpOverviewTools`/`McpOverviewDeps`/`McpQuayRunner`（各写消费方注释）。`server/index.ts` 组装 `McpOverviewDeps`（进程单例：`getProjectsWithSessions`、会话读、`chatRunRegistry`、`activityStore`、`sessionHostManager`、一个把 `quayService` 绑成 `McpQuayRunner` 的适配器、`now: () => Date.now()`）。
5. **判据文件 `server/modules/mcp-gateway/tests/mcp-overview.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + MCP SDK 客户端；quay 运行器与活动存储用注入的计数假体）**：形制照 AC-245/AC-246（`mkdtemp` + `closeConnection()` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发 `['cloudcli:read']` 真令牌 + 同一 app 上 `mountMcpGateway`；客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`，避开 `listen(0)` 的 undici 坏端口——内存 `undici-bad-port-lottery-in-listen0-route-tests`）。夹具：若干项目与会话；一个常驻会话由调试 agent 宿主驱动（形制照 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`，加 `turn`/`cron`/`background-task` lease 使 `leases` 非空、`peerName` 可读）；一个注入的 `activity` 假体把某会话的 `turn.phase` 造成 `'awaitingPermission'`；`runs` 假体各有 running / aborted（保留期内）/ completed 运行；`quay` 假体给两个项目造缓存命中（带 `tasks.total`/`driver.state`/`tests.current`）、给未命中项目返回 `null`、并对一个无 `.quay` 的项目 `hasQuayConfig=false`，同时**在 `refresh` 上计一个计数器 `refreshCount`**。读数各自独立成断言并逐字写出原始值：
   - (a) **overview 会话/宿主读数**：`overview` 返回的运行中会话逐条写出 `{project, title, phase, elapsedMs}`（含至少一个 running、phase 与注入的 activity 一致）；`awaitingPermission` 列表**含**注入的那条会话（逐字写出其 sessionId 与 phase）；`aborted` 列表**含**保留期内被中止的运行、**不含** completed 的（逐字写出两者 status 与 runId）；`hosts` 一览含常驻宿主，逐条写出 `state` 与 `leases`（lease kinds）。正例对照：running 列表非空（防「一律空」也通过）。**（这条即取假形态 (ii) 要红的点。）**
   - (b) **quay 缓存命中/未命中 + 冷缓存零 CLI**：缓存命中项目在 overview 里带任务计数与 driver、suite 状态（逐字写出 `tasks.total`/`driver.state`/`suite.state`）；未命中项目标为「未知」（写出原始标记字段）；**断言 `refreshCount === 0`**（冷缓存零运行器调用，逐字写出计数）。正例对照：命中项目确实带出计数（防「一律未知」也通过）。**（这条即取假形态 (i) 要红的一半。）**
   - (c) **quay_snapshot 默认读缓存 / 带 refresh 恰好一次 / 一次一个项目**：`quay_snapshot({project: P})`（无 refresh）返回 P 的缓存读数且 `refreshCount` 不增；`quay_snapshot({project: P, refresh: true})` 使 `refreshCount` **恰好 +1** 且只作用于 P（另一个项目的 `refreshCount` 贡献为 0，逐字写出两个计数）；用**数组** `{project: ['P','Q']}` 调用被输入 schema 拒绝（写出原始拒绝读数）。**（这条即取假形态 (iii) 要红的点。）**
   - (d) **无 quay 配置的项目说明而非抛错**：对 `hasQuayConfig=false` 的项目，overview 的 quay 段说明「该项目没有 quay」，`quay_snapshot({project: 该项目})` 返回同一说明且 `isError` 为 false/非抛错；逐字写出原始文案。正例对照：有 quay 配置的项目**不**出现该说明（防「一律说没有 quay」也通过）。
   - (e) **20 个项目仍零运行器调用**：夹具造 20 个项目（混合命中/未命中），跑一次 `overview`，断言 `refreshCount === 0` 且不随项目数增长（逐字写出项目数与计数）。**（这条即取假形态 (i) 要红的另一半。）**
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) `overview` 传 `refresh` 或对未命中的项目现取（让 `buildOverview` 调 `quay.refresh`）⇒ (b) 与 (e) 必须红（`refreshCount > 0`）；
   (ii) 漏掉 `awaitingPermission` 的会话（`buildOverview` 不把 phase 命中项单列）⇒ (a) 必须红；
   (iii) `quay_snapshot` 的 refresh 不触发运行器（refresh:true 走 `readCached`）⇒ (c) 必须红（`refreshCount` 不增）。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-247" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-247`；`grep -rln "AC-247" tasks/` 只命中 AC-245 的边界段（其 Notes 明确「`overview`/`run_get`/`quay_snapshot` 的行为归 AC-247/AC-248，本任务只注册名字/scope/描述/输入 schema」），以及 AC-246 的边界段。AC-245（夹具只读工具）、AC-246（名称模糊匹配）、AC-248（`run_get` 有界等待）是**不同读数与不同判据文件**（`mcp-read-tools.test.ts`/`mcp-resolve-target.test.ts`/`mcp-run-get.test.ts`），各自直接覆盖；本任务只在 AC-245 已注册的两个名字上填 `overview`/`quay_snapshot` 的 handler，**不新增/改名工具**，不测其判据。写工具（AC-249–AC-251）、自指保护（AC-252）、设置页（AC-254/255）、冒烟（AC-256/257）均不越界。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-240 未落地则无 `/mcp` 传输与工具注册缝；AC-244 未落地则无 `withMcpAudit` 包装与注册缝；AC-245 未落地则 `overview`/`quay_snapshot` 尚未注册、无替换点。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-247 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-overview.test.ts`（写下完整命令与完整输出）。
  - 命令：`for f in server/modules/mcp-gateway/tests/mcp-overview.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts`
  - 改动前输出（exit 1，stderr）：`缺判据文件：server/modules/mcp-gateway/tests/mcp-overview.test.ts`
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-overview.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
  - 读数：`ℹ tests 5` / `ℹ pass 5` / `ℹ fail 0`；exit 0。五条 ✔：(a) 会话/宿主、(b) 缓存命中/未命中+冷缓存、(c) quay_snapshot 三读数、(d) 无 quay 说明、(e) 20 项目零调用。
- [x] AC3 (a) overview 含运行中会话（逐条 project/title/phase/elapsedMs）、`awaitingPermission` 会话（经注入 activity 制造，逐字写出其 sessionId 与 phase）、保留期内被中止的运行（含 aborted、不含 completed，逐字写 status/runId）、常驻宿主一览（逐字写 state 与 leases kinds）；正例对照 running 非空。
  - `running = [{"sessionId":"overview-fixture-busy","projectId":"e5a5e108-…","project":"overview-main","title":"Busy overview session","phase":"awaitingPermission","elapsedMs":12345}]`（正例对照：length 1 > 0）
  - `awaitingPermission = [{"sessionId":"overview-fixture-busy","project":"overview-main","title":"Busy overview session","phase":"awaitingPermission"}]`
  - `aborted = [{"runId":"f4416005-af86-43a1-a823-b99a65c54801","sessionId":"overview-fixture-aborted","status":"aborted","startedAt":1791185815526,"completedAt":1791185815526}]`；断言不含 completed runId。
  - `hosts = [{"hostId":"host-b3a5a773-…","state":"lingering","sessionId":"overview-fixture-resident","peerName":"overview-fixture-peer","leases":[{"kind":"resident-policy"},{"kind":"cron","id":"overview-fixture-cron"},{"kind":"background-task","id":"overview-fixture-bg"}]}]`（lease kinds 逐字）
- [x] AC4 (b) quay 缓存命中项目带任务计数与 driver、suite 状态（逐字写 tasks.total/driver.state/suite.state）；未命中标「未知」；冷缓存 `refreshCount === 0`；正例对照命中项目带出计数。
  - 命中：`{"status":"cached","tasks":{"total":7,…},"driver":{"state":"running"},"suite":{"state":"passed"}}`（tasks.total=7 即正例对照）
  - 未命中：`{"status":"unknown","note":"未知：该项目没有缓存快照（overview 不装载；请用 quay_snapshot 刷新）"}`
  - `[b] refreshCount after overview = 0`
- [x] AC5 (c) `quay_snapshot` 默认读缓存（`refreshCount` 不增）、`refresh:true` 使该项目的 `refreshCount` 恰好 +1 且只作用于该项目（逐字写两项目计数）、数组 `project` 被输入 schema 拒绝（逐字写拒绝读数）。
  - 默认：`{"status":"cached","snapshot":{…}}`，`refreshCount=0`（不增）
  - `refresh:true`：`{"status":"refreshed",…}`；`[c] refreshCounts: <mainId>=1 <otherId>=0`
  - 数组：`isError=true text="MCP error -32602: Input validation error: Invalid arguments for tool quay_snapshot: [ { \"expected\": \"string\", \"code\": \"invalid_type\", \"path\": [ \"project\" ], \"message\": \"Invalid input: expected string, received array\" } ]"`
- [x] AC6 (d) 无 quay 配置的项目在 overview 与 `quay_snapshot` 里都说明「该项目没有 quay」且不抛错；有配置的项目不出现该说明；逐字写两侧原始文案。
  - overview：`{"projectId":"74b33c29-…","status":"no-quay-config","note":"该项目没有 quay"}`
  - `quay_snapshot`：`isError=false payload={"project":"74b33c29-…","hasQuayConfig":false,"status":"no-quay-config","note":"该项目没有 quay"}`
  - 正例对照：有配置项目 overview 条 `note` ≠ `该项目没有 quay`。
- [x] AC7 (e) 20 个项目下一次 `overview` 的 `refreshCount === 0`，不随项目数增长（逐字写项目数与计数）。
  - `[e] projects=20 entries=20 refreshCount=0`
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) overview 传 refresh / 对未命中现取 ⇒ AC4/AC7 红；(ii) 漏掉 awaitingPermission ⇒ AC3 红；(iii) quay_snapshot 的 refresh 不触发运行器 ⇒ AC5 红。每条恢复命令 + 恢复后重跑绿。
  - (i) 变异 `mcp-overview-tools.ts`：`buildOverview` 在 quay 段前 `await Promise.all(projects.filter(p=>!deps.quay.readCached(p.projectId)).map(p=>(deps.quay as unknown as McpQuayRunner).refresh(p.projectId)))`。失败行：`(b) AssertionError [ERR_ASSERTION]: overview must not call the quay runner / actual: 19 / expected: 0`；`(e) … no project count may cause a runner call / actual: 19 / expected: 0`（`[b] refreshCount after overview = 19`）。恢复：`git checkout -- server/modules/mcp-gateway/mcp-overview-tools.ts`，重跑 `pass 5 / fail 0`。
  - (ii) 变异：`awaitingPermission` 过滤比较串改为 `'permission'`。失败行：`(a) AssertionError [ERR_ASSERTION]: the awaitingPermission list must contain exactly the injected session / actual: [] / expected: [ 'overview-fixture-busy' ]`。恢复：同上 `git checkout --`，重跑 `pass 5 / fail 0`。
  - (iii) 变异：`buildQuaySnapshot` 的 `refresh:true` 分支 `await deps.quay.refresh(project)` → `deps.quay.readCached(project)`。失败行：`(c) AssertionError [ERR_ASSERTION]: refresh: true must call the runner exactly once for the named project / actual: 0 / expected: 1`（`[c] refreshCounts: <mainId>=0 <otherId>=0`）。恢复：同上 `git checkout --`，重跑 `pass 5 / fail 0`。
  - 三条变异均在实现提交（1220097a）之后施加，恢复后 `git status --short` 干净。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；既有 `server/modules/quay/tests/quay.service.test.ts`（`getQuaySnapshot` 既有语义）与 `server/modules/websocket/tests/chat-run-by-id.test.ts`（保留期）不改一字仍逐字通过；AC-245 判据 `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 不改一字仍逐字通过（本任务只替换两个 handler，不改工具集合）。
  - `npm run typecheck`：exit 0（三配置 `tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 全过）。
  - `npm run lint`：`: error ` 计数 = 0（仅 warning）。
  - `quay.service.test.ts`：`tests 14 / pass 14 / fail 0`（未改一字）。
  - `chat-run-by-id.test.ts`：`tests 6 / pass 6 / fail 0`（未改一字）。
  - `mcp-read-tools.test.ts`：`tests 6 / pass 6 / fail 0`（未改一字；未接线时 overview/quay_snapshot 仍以 `MCP_TOOL_NOT_IMPLEMENTED` 拒绝）。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。
  - `server/index.ts` | 16 +-
  - `server/modules/mcp-gateway/index.ts` | 35 ++
  - `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` | 88 ++-
  - `server/modules/mcp-gateway/mcp-overview-tools.ts (new)` | 436 ++
  - `server/modules/mcp-gateway/tests/mcp-overview.test.ts (new)` | 646 ++
  - `server/modules/quay/index.ts` | 6 +-
  - `server/modules/quay/quay.service.ts` | 26 +
  - `server/modules/websocket/index.ts` | 5 +
  - `server/modules/websocket/services/chat-run-registry.service.ts` | 34 +-
  - 与 `## Touches` 逐条对齐（唯一未出现在 diff 的 Touches 项是本任务文件 `tasks/gap-ac247-overview-quay-cache-readonly.md`，由 `task_write` 本身提交）。

## DoD

- `overview` **真的**经真实 HTTP + MCP SDK 客户端驱动，读的是注入的计数假体（running/aborted/completed 运行、`awaitingPermission` 的活动存储、常驻宿主），不是「函数被调用」或「判据文件存在」就算数。
- **冷缓存零 CLI 是结构性的**：20 个项目下 `overview` 的 `refreshCount` 为 0；缓存未命中只标「未知」，绝不现取——证明 SPEC §552 的「无上限扇出」被消除。
- `quay_snapshot` **真的**默认读缓存、`refresh:true` 时对该项目**恰好一次**运行器调用且不影响其它项目；`project` schema 只接受单个字符串。
- 无 quay 配置的项目**真的**被说明「该项目没有 quay」而不是抛错；缓存命中项目**真的**带出任务计数、driver 与 suite 状态。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖；不越界实现 AC-248–AC-257 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-overview-tools.ts (new)
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts (new)（判据）
- server/modules/quay/quay.service.ts
- server/modules/quay/index.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/index.ts
- server/index.ts
- tasks/gap-ac247-overview-quay-cache-readonly.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-246 同款说明）。SDK transport options 确有 `fetch?: FetchLike`。
- 「运行器调用计数」量的是注入的 `McpQuayRunner.refresh` 调用数（一次 refresh = 一个项目的一次快照装载）；`readCached`/`hasQuayConfig` 不走 CLI，不计入。这样就同时满足 (b)/(e) 的「冷缓存零 CLI」与 (c) 的「恰好一次运行器调用」。生产绑定把 `refresh` 接到 `quayService.getQuaySnapshot(projectId, { forceRefresh: true })`、`readCached` 接到新增的 `getCachedSnapshot`。
- `getCachedSnapshot` 的过期判据与 `getQuaySnapshot` 的缓存分支**同一条**（`cached.expiresAt > dependencies.now()`）；两处若漂移，panel 与 MCP 会对「新鲜」给出不同答案。
- `aborted` 的运行摘要没有退出码（注册表摘要只有 `status`），不要臆造 exitCode 字段；`completed` 的运行**不**算「被中止」。
- 常驻夹具形制照 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`（`createSessionHostManager` + `createDebugAgentHostDriver` + `armDebugAgentScenario`；`DEBUG_AGENT_PROVIDER_ID`）；退路是直接 `createSessionHostManager` + `bindSession` + 管理器 API 加 lease，仍从 `snapshot()` 读回，不手写 host 对象。
- AC-248（`run_get` 有界等待）不在本任务：本任务只填 `overview`/`quay_snapshot`，`run_get` 的 handler 仍由 AC-248 落地。
- 实现说明（worker）：quay 侧 `overview` 的 deps 只暴露 `CachedQuayReader`（`hasQuayConfig`+`readCached`），`refresh` 仅出现在 `buildQuaySnapshot` 的 deps 上——零扇出是类型层面的，不靠约定。`overview` 与 `quay_snapshot` 在 deps 未接线 quay/activity 时仍走 AC-245 的具名拒绝，故 AC-245 判据不改一字仍绿；接线后由 `registerMcpOverviewTools` 经同一注册缝安装真实 handler，工具集合（7 个名字/scope）不变。判据夹具用 20 个真实项目（2 个具名 + 18 个 extra），常驻宿主用直接 `createSessionHostManager`+`bindSession`+`addLease` 的退路（调试 agent 的 gate 在 import 时被 `provider.registry` 封死）。
