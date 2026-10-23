---
id: gap-ac244-mcp-audit-log-outcomes-and-retention
title: AC-244 每次工具调用在 mcp_audit_log 恰好留一行（ok/denied/error）+ 参数只记摘要（id
  原样、自由文本只记长度与前 40 字符）+ 90 天保留期在启动与每日各清理一次；判据
  server/modules/mcp-gateway/tests/mcp-audit.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-244
depends_on:
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac241-mcp-token-auth-shares-service
---
## Proposal

AC-244（GOAL-020 退出条件 6；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3 §389 的 `mcp_audit_log` DDL、§422「每次工具调用写 `mcp_audit_log`，保留 90 天」、§263「scope 不足返回 `isError` 并写 `denied` 审计」、§545「写操作分 scope……审计」）要求每次工具调用**恰好写一行** `mcp_audit_log`：列含令牌 id、客户端 id（PAT 为空）、工具名、结果（`ok` / `denied` / `error` 之一）、耗时；参数只记摘要——会话与项目 id **原样保留**，自由文本（如 `session_send` 的 500 字 message）**只记长度与前 40 个字符**，完整文本在全表**任何一列都找不到**；被 401 拒绝的请求没有令牌可归属，**不写审计行也不报错**；超过 90 天的行被清理、未超过的保留（**时钟可注入**），清理在**启动时与每日各跑一次**（**调度缝可注入**）；迁移幂等，在已有该表的库上重跑不出错。判据文件 `server/modules/mcp-gateway/tests/mcp-audit.test.ts` 当前不存在，AC-244 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-audit.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/` 目录不存在（由 AC-240 创建）；`server/modules/database/schema.ts` 与 `migrations.ts` 无 `mcp_audit_log`（`grep -rn "mcp_audit_log" server/ --include=*.ts` 为空）；全仓库无任何审计写入点或参数摘要函数。

要交付：

1. **表与迁移（`server/modules/database/schema.ts` + `migrations.ts`；遵守 `$backend-module-standards`）**：
   - 在 `schema.ts` 新增 `MCP_AUDIT_LOG_TABLE_SCHEMA_SQL`，**逐字照 SPEC §389 DDL**：`id INTEGER PRIMARY KEY AUTOINCREMENT`、`at DATETIME DEFAULT CURRENT_TIMESTAMP`、`token_id INTEGER`、`client_id TEXT`、`tool TEXT NOT NULL`、`args_digest TEXT`、`outcome TEXT NOT NULL`、`duration_ms INTEGER`，`CREATE TABLE IF NOT EXISTS mcp_audit_log (...)`。
   - 在 `runMigrations` 里按既有 `db.exec(<TABLE>_SCHEMA_SQL)` 惯例执行它（放在 `ACCESS_TOKENS_TABLE_SCHEMA_SQL` 之后即可），并加 `CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_at ON mcp_audit_log(at)`（保留期清理按 `at` 扫，无索引会全表扫）。`CREATE TABLE IF NOT EXISTS` 保证 (e) 幂等：已存在该表时不重建、不报错、数据不动。
2. **仓库（新文件 `server/modules/database/repositories/mcp-audit-log.db.ts`，形制照 `access-tokens.ts`；经 `server/modules/database/index.ts` barrel 导出）**：
   - `mcpAuditLogDb.insert({ at, tokenId, clientId, tool, argsDigest, outcome, durationMs })`——**允许调用方显式传 `at`**（判据要造 90 天前的旧行），返回新行 id。
   - `mcpAuditLogDb.count()`、`mcpAuditLogDb.allRows()`（判据读回整行，用于「任何一列都找不到全文」）。
   - `mcpAuditLogDb.deleteOlderThan(cutoffIso)`——`DELETE FROM mcp_audit_log WHERE at < ?`，返回删除行数。**只按 `at` 严格小于 cutoff 删**（(d)：91 天前删、89 天前留）。
   - barrel 导出 `mcpAuditLogDb` 与行类型，定义处写消费方注释。
3. **审计服务（新文件 `server/modules/mcp-gateway/mcp-gateway.audit.ts`；遵守 `$backend-module-standards`）**：
   - `export type McpAuditOutcome = 'ok' | 'denied' | 'error';`
   - `export function summarizeToolArgs(args: unknown): string`——**纯函数**，返回 JSON 字符串（写入 `args_digest` 列）。规则：键名属于**会话/项目 id 白名单**（至少 `session`、`sessionId`、`project`、`projectId`）的值**原样保留**；其余字符串**替换为** `{ length: <字符数>, preview: <前 40 个字符> }`（`preview` 用 `String.slice(0, 40)`，**不追加省略号、不写全量**）；数字/布尔/null 原样；对象/数组递归。自由文本的**第 41 个字符及以后绝不能出现在返回值里**。
   - `export function recordMcpToolCall(reading: { tokenId: number | null; clientId: string | null; tool: string; outcome: McpAuditOutcome; durationMs: number; args: unknown }): number`——调 `summarizeToolArgs` 后写**恰好一行** `mcpAuditLogDb.insert`，返回行 id。**无论 outcome 是 ok / denied / error 都走这一处写**（(a) 的核心）。
   - `export function startMcpAuditRetention(options?: { now?: () => Date; setInterval?: (fn: () => void, ms: number) => unknown; retentionDays?: number }): { prune: () => number }`——默认 `retentionDays = 90`，默认 `now = () => new Date()`，默认 `setInterval = globalThis.setInterval`。**立即调一次 `prune()`**（启动时跑），再 `setInterval(prune, 24*60*60*1000)` 每日跑一次，把两个返回都暴露给调用方供判据观测（调度缝可注入：判据传自己的假 `setInterval` 捕获 fn 与间隔，**不真等一天**）。`prune()` = `mcpAuditLogDb.deleteOlderThan(new Date(now().getTime() - retentionDays*MS_PER_DAY).toISOString())`，返回删除行数。
   - **审计派发包装器** `export function withMcpAudit(registration: { name: string; requiredScopes: readonly string[]; handler: (args: unknown, ctx: { principal: McpPrincipal }) => unknown }): McpToolHandler`（或等价的「注册一个经审计的工具」内联件，以 AC-240/AC-245 实际落地的工具注册形状为准）——执行逻辑：
     1. 读 `ctx.principal`（AC-241 的 `readMcpPrincipal` 供主）；用 `principal.scopes` 对照 `requiredScopes`：**缺任一所需的 scope ⇒ outcome `denied`，不调用 handler**，写一行后向 MCP 返回 `isError` 结果；
     2. 否则用可注入时钟记开始时刻，调用 `handler(args, { principal })`；**抛错 ⇒ outcome `error`**（把错误转成 MCP `isError` 结果，不让进程崩）；
     3. 正常返回 ⇒ outcome `ok`；
     4. 三条路径都调 `recordMcpToolCall(...)` **恰好一次**，`durationMs` 为非负整数，`tokenId`/`clientId` 取自 `principal`。
   - 主体类型扩展（**跨任务改动，见下**）：AC-241 的 `McpPrincipal` 只有 `{ userId, scopes }`，而 (a) 要求记**令牌 id** 与**客户端 id**。本任务把它扩为 `{ userId: number; tokenId: number; clientId: string | null; scopes: string[] }`（PAT 的 `clientId` 为 `null`，对应 SPEC「PAT 为空」）。为此：`server/modules/oauth/access-tokens.service.ts` 的 `VerifyAccessTokenResult` 成功分支增加 `tokenId: number`（从已读到的 `row.id` 带出，不额外查库）；`server/modules/mcp-gateway/mcp-gateway.auth.ts` 的 `res.locals.mcpPrincipal` 带上 `verified.tokenId` 与 `clientId: null`。**若 AC-241 实际落地的形状已带 id，则沿用、不重复加**；若落在别处，先用 `task_write` 把该文件加进本任务 `## Touches` 再改（`quay-touches-must-match-actual-write-sites`）。
4. **接线（`server/modules/mcp-gateway/mcp-gateway.transport.ts` + `server/index.ts`）**：`mountMcpGateway` 增加可注入的**工具注册缝**（形状以 AC-240 实际落地的 deps 为准，例如 `deps.registerTools?: (server: McpServer) => void`），注册的工具一律经 `withMcpAudit` 包装；启动保留期清理（`startMcpAuditRetention`）由 `mountMcpGateway`（或 `server/index.ts` 装配点，以 AC-240 落点为准）调用一次。AC-245+ 的工具经**同一缝**注册——本任务不实现任何真实工具（越界）。`server/modules/mcp-gateway/index.ts` barrel 导出 `withMcpAudit`、`summarizeToolArgs`、`recordMcpToolCall`、`startMcpAuditRetention`、`McpAuditOutcome` 与扩展后的 `McpPrincipal`，各自写消费方注释，不导出无消费者符号。
5. **判据文件 `server/modules/mcp-gateway/tests/mcp-audit.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + 真实 better-sqlite3 临时库，形制照 `server/modules/oauth/tests/token-info.routes.test.ts`）**：`mkdtemp` 建临时目录、`closeConnection()`、`process.env.DATABASE_PATH` 指向 `audit.db`、`initializeDatabase()`、插 owner 用户行，用注入时钟的 `createAccessTokensService` 发真令牌；`mkdtemp` 后**再 `initializeDatabase()` 一次**证明 (e) 幂等不出错、行数不变。在同一 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`，认证用 AC-241 的真实令牌中间件，工具注册缝注册若干**假工具**：`echo_ok`（requiredScopes `[]`）、`needs_send`（requiredScopes `['cloudcli:session:send']`）、`boom`（handler 抛错）。HTTP 调用用 `node:http`（**不用 `fetch`**——`listen(0)` 会抽到 undici 拒绝的固定端口，见 AC-240/AC-241/AC-242/AC-243 同款说明与内存 `undici-bad-port-lottery-in-listen0-route-tests`）。读数各自独立成断言并逐字写出原始值：
   - (a) **每次调用恰好一行、三种结果都写**：带有效令牌（scopes 含 `cloudcli:session:send`）依次 `tools/call` 到 `echo_ok`（ok）、`needs_send`（ok）、`boom`（error）；再发一个 scope 只有 `['cloudcli:read']` 的令牌调 `needs_send`（denied）。每发一次，`mcpAuditLogDb.count()` **恰好 +1**，并读回该行断言 `tool`、`outcome`（逐字 `ok`/`denied`/`error`）、`token_id` 等于所发令牌 id、`client_id` 为 `null`（PAT）、`duration_ms` 为非负整数。写出四次调用前后行数与四行原始值。正例对照：一个 handler 抛错的调用必须得到 outcome `error` 而非 `ok`（防「一律 ok」也通过）。
   - (b) **参数摘要**：调 `needs_send`（或等价自由文本假工具）传 `{ session: '<sess-id>', project: '<proj-id>', message: 'A'.repeat(500) }`；读回该行 `args_digest`，断言：含 `sess-id` 与 `proj-id` **原样**；含长度 `500` 与**前 40 个字符**；且把整行**所有列**拼起来后，`'A'.repeat(500)` **不出现**、第 40 个字符之后的子串（如 `'A'.repeat(60)` 的后段）**不出现**。逐字写出原始 `args_digest` 与「全行拼接」读数。正例对照：`session`/`project` 两个 id 确实在摘要里（防「摘要整个为空」也通过）。
   - (c) **401 不写行也不报错**：无 `Authorization`、`Bearer` 空令牌、未知 `ccp_<64 hex>` 各发一次 `tools/call`；三次都得 401，`mcpAuditLogDb.count()` **前后不变**，且服务器进程仍存活（随后一次带有效令牌的调用仍成功）。写出三次状态码与前后行数。
   - (d) **保留期与调度缝**：用注入时钟 `T0`，直接经 `mcpAuditLogDb.insert({ at })` 造两行——`at = T0 - 91 天` 与 `at = T0 - 89 天`；调 `startMcpAuditRetention({ now: () => T0, retentionDays: 90 })`（或等价注入）触发的 `prune()`，断言 91 天行**被删**、89 天行**仍在**（写出删除前后行数与 `prune()` 返回）；再断言调度缝：传一个假 `setInterval`，断言 `startMcpAuditRetention` **立即**调了一次 prune（启动时），并注册了**间隔为 `24*60*60*1000`** 的每日回调（捕获 fn + ms 逐字写出），**不真等一天**。正例对照：未过期行保留（防「全删」也通过）。
   - (e) **迁移幂等**：在已经有过 `mcp_audit_log` 并有数据的库上**再次** `initializeDatabase()`（或 `runMigrations(getConnection())`），断言不抛错、表仍在、既有行数不变、`PRAGMA table_info(mcp_audit_log)` 列名与 SPEC DDL 逐字一致。写出幂等前后的行数与列名。
6. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 把完整消息写进摘要（`summarizeToolArgs` 对字符串直接原样返回，或 `preview` 用全量 `message`）⇒ (b) 必须红；
   (ii) scope 不够时不写审计（`withMcpAudit` 的 denied 分支提前 return，跳过 `recordMcpToolCall`）⇒ (a) 必须红；
   (iii) 清理删掉未过期的行（`deleteOlderThan` 改成 `at <= cutoff` 或删全部、或 cutoff 算成「不减去 90 天」）⇒ (d) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-244" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-244`；`grep -rln "AC-244" tasks/` 只命中 AC-240/AC-241/AC-242/AC-243 四份的边界段（它们各自声明「不做审计（AC-244）」）。AC-239（依赖声明）、AC-240（无状态传输与工具注册缝）、AC-241（令牌认证与主体）、AC-242（回环守卫）、AC-243（scope 词汇）是不同机制；本任务在它们之上落审计表、摘要器、保留期清理与经审计的工具派发，不重写传输、不换认证、不做回环与词汇校验、不实现任何真实只读/写工具（AC-245+）、不做设置页（AC-254/255）与冒烟（AC-256/257）。与 AC-243 的关系：本任务只在包装器里按 `requiredScopes` 做**调用期**比较以产生 `denied`，不改令牌签发路径与词汇表。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-240 未落地则无 `mountMcpGateway` 与工具注册缝；AC-241 未落地则无令牌中间件与 `McpPrincipal` 可扩展。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-244 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-audit.test.ts`（写下完整命令与完整输出）。
  - 命令：`for f in server/modules/mcp-gateway/tests/mcp-audit.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit.test.ts`
  - 输出：`缺判据文件：server/modules/mcp-gateway/tests/mcp-audit.test.ts`，退出码 1。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-audit.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
  - 读数：`tests 5` / `pass 5` / `fail 0`，退出码 0（合并 develop 并修复 boot-order 回归后复跑同为 5/5/0）。
- [x] AC3 (a) 每次工具调用恰好写一行、三种结果都写：带有效令牌调 `echo_ok`/`needs_send`/`boom`（ok/ok/error）各使行数 +1，scope 不足调 `needs_send` 得 `denied` 且行数 +1；读回 `token_id` 等于所发令牌 id、`client_id` 为 null、`duration_ms` 非负整数；逐字写出四次前后行数与四行原始值。
  - echo_ok 0→1 `{"id":1,"at":"2026-10-05 05:00:23","token_id":1,"client_id":null,"tool":"echo_ok","args_digest":"{}","outcome":"ok","duration_ms":0}`
  - needs_send 1→2 `{"id":2,...,"token_id":1,"client_id":null,"tool":"needs_send","outcome":"ok","duration_ms":0}`
  - boom 2→3 `{"id":3,...,"token_id":1,"tool":"boom","outcome":"error","duration_ms":0}`（正例对照：抛错记 `error` 而非 `ok`）
  - denied 3→4 `{"id":4,...,"token_id":2,"tool":"needs_send","outcome":"denied","duration_ms":0}`
  - token_id 分别等于所发令牌 id（1/1/1/2）；client_id 均 null；duration_ms 均非负整数。
- [x] AC4 (b) 参数摘要：`args_digest` 含 `session`/`project` id 原样、含 `message` 长度 500 与前 40 字符；整行所有列拼接后 `'A'.repeat(500)` 与第 40 字符之后子串均不出现；逐字写出原始 `args_digest` 与全行拼接读数。
  - `args_digest={"session":"sess-id-123","project":"proj-id-456","message":{"length":500,"preview":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}`
  - 全行拼接仅含上述 40 个 `A`；未出现 `'A'.repeat(500)`，也未出现 `'A'.repeat(60)`。
- [x] AC5 (c) 401（无头 / 空令牌 / 未知令牌）得 401、`count()` 前后不变、服务器不崩（随后有效调用仍成功）；逐字写出三次状态码与前后行数。
  - 三次状态码：no header=401, empty bearer=401, unknown token=401。
  - 行数 `count 0→0`（三次未授权后不变），随后有效调用成功使 `count →1`。
- [x] AC6 (d) 保留期：`T0-91天` 行被删、`T0-89天` 行保留（注入时钟，写出 prune 返回与前后行数）；`startMcpAuditRetention` 立即 prune 一次并注册间隔 `24*60*60*1000` 的每日回调（假 setInterval 捕获 fn+ms，逐字写出，不真等一天）。
  - `before=2 afterStartup=1 remaining=fresh scheduledMs=86400000 prune()=1`。
  - 假 setInterval 捕获 1 次 `fn`（=== `retention.prune`）+ `ms=86400000`；启动那次立即删掉 91 天行、保留 89 天行；手动 `prune()` 返回删除行数 1。
- [x] AC7 (e) 迁移幂等：已有表且有数据的库上再次 `initializeDatabase()` 不抛错、行数不变、`PRAGMA table_info(mcp_audit_log)` 列名与 SPEC DDL 逐字一致；写出前后行数与列名。
  - `rows 2->2; columns=[id,at,token_id,client_id,tool,args_digest,outcome,duration_ms]`（与 SPEC §389 DDL 逐字一致）。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 摘要写全文 ⇒ AC4 红；(ii) denied 不写审计 ⇒ AC3 红；(iii) 清理删未过期 ⇒ AC6 红。每条恢复命令 + 恢复后重跑绿。
  - (i) 变异 `summarizeValue` 字符串分支 `return value;` ⇒ (b) 红：`AssertionError [ERR_ASSERTION]: the free text length must be recorded`，退出码 1；恢复 `git checkout -- server/modules/mcp-gateway/mcp-gateway.audit.ts`，复跑 5/5 绿。
  - (ii) 变异 `withMcpAudit` denied 分支删除 `recordMcpToolCall(...)` ⇒ (a) 红：`AssertionError [ERR_ASSERTION]: a denied call must add exactly one row`，退出码 1；同一恢复命令，复跑 5/5 绿。
  - (iii) 变异 `prune` cutoff 不减 `retentionDays`（`deleteOlderThan(now().toISOString())`）⇒ (d) 红：`AssertionError [ERR_ASSERTION]: exactly the expired row must be deleted at startup`，退出码 1；同一恢复命令，复跑 5/5 绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；既有 `server/modules/oauth/tests/token-info.routes.test.ts`、`access-tokens.service.test.ts`、`server/modules/database/tests/api-keys-drop-migration.test.ts` 不改一字仍逐字通过（本任务对 `VerifyAccessTokenResult` 只**新增** `tokenId` 字段，既有断言不破）。
  - `npm run typecheck` 退出码 0（合并 develop 后复跑仍 0）。
  - `npm run lint` 中 `: error ` 计数 **0**（仅既有 warning）；退出码 0。
  - `npx tsx --tsconfig server/tsconfig.json --test` 跑 token-info.routes / access-tokens.service / api-keys-drop-migration / mcp-auth / mcp-transport / mcp-loopback-guard / dependency-declaration 共 **34 tests / 34 pass / 0 fail**。（`token-info.routes.test.ts`、`access-tokens.service.test.ts`、`api-keys-drop-migration.test.ts` 三份本任务未改一字。）
  - 本轮合并 develop 后发现上一轮 suite 红（`resident-server-restart`、`activity-heartbeat.process` 均 `/health` 25s 超时）实为本任务的 boot-order 回归（真因见 Notes），已修复。修复后进程级复跑：`resident-server-restart` 4/4/0、`activity-heartbeat.process` 2/2/0、判据 `mcp-audit` 5/5/0（合并跑 11 tests/11 pass/0 fail）；`server/modules/mcp-gateway/tests/*` + `server/modules/oauth/tests/*` 95 tests/95 pass/0 fail。`claude-peer-name-title-guard`（SDK 进程 exit 1，与 delta 无关）单独复跑 1/1 绿——属已知负载 flake。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。
  - 12 files changed, 963 insertions(+), 18 deletions(-)：`server/index.ts`(+9/-0)、`server/modules/database/index.ts`(+4/-0)、`server/modules/database/migrations.ts`(+6/-0)、`server/modules/database/repositories/mcp-audit-log.db.ts`(+102/-0, new)、`server/modules/database/schema.ts`(+26/-0)、`server/modules/mcp-gateway/index.ts`(+16/-0)、`server/modules/mcp-gateway/mcp-gateway.audit.ts`(+258/-0, new)、`server/modules/mcp-gateway/mcp-gateway.auth.ts`(+16/-3)、`server/modules/mcp-gateway/mcp-gateway.transport.ts`(+33/-9)、`server/modules/mcp-gateway/tests/mcp-audit.test.ts`(+476/-0, new)、`server/modules/mcp-gateway/tests/mcp-auth.test.ts`(+12/-3)、`server/modules/oauth/access-tokens.service.ts`(+5/-3)。
  - 10 个原 Touches 项 + 2 个已补进 Touches 的附带文件（`server/index.ts`、`mcp-auth.test.ts`）= 12，逐条对齐。`tasks/…md` 由 Provider 管理，不在 branch delta。

## DoD

- 每次工具调用**真的**恰好写一行：经真实 HTTP 走 `mountMcpGateway` + 真实令牌 + 真寄存器，ok/denied/error 三条路径都由真库读回，`token_id` 真是所发令牌、`client_id` 真为 null、`duration_ms` 非负——不是「表存在」或「函数被调用」就算数。
- 参数摘要**真的**只记摘要：会话/项目 id 原样、自由文本只留长度与前 40 字符，整行任何一列都**找不到**完整 500 字文本（对真库整行 SELECT 读回，不是对函数的独立断言）；自由文本假工具的 message 全量不得落库。
- 401 **真的**不写行也不报错：真 HTTP 三次未授权调用后行数不变、进程存活、后续有效调用仍成功。
- 保留期**真的**按 90 天：注入时钟下 91 天行删、89 天行留；清理**真的**在启动时跑一次并按每日间隔注册（假调度缝捕获，不真等一天）——不是「判据文件存在」就算数。
- 迁移**真的**幂等：已有表且有数据的库上重跑不抛错、数据与列结构不变。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、DDL 与仓库落在 database 模块、摘要/审计/保留期/派发落在 mcp-gateway 模块、导出带消费方注释、不导出无消费者符号、≥2 处使用的工具进 `server/shared/utils.ts`）与 AGENTS.md；不引入新依赖（只用既有 better-sqlite3 与 node 内置）；不越界实现 AC-245–AC-257。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/mcp-audit-log.db.ts (new)
- server/modules/database/index.ts
- server/modules/mcp-gateway/mcp-gateway.audit.ts (new)
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/mcp-gateway.auth.ts
- server/modules/mcp-gateway/index.ts
- server/modules/oauth/access-tokens.service.ts
- server/modules/mcp-gateway/tests/mcp-audit.test.ts (new)（判据）
- server/index.ts（附带：`startMcpAuditRetention()` 启动装配点；`mountMcpGateway` 本身的接线在 transport）
- server/modules/mcp-gateway/tests/mcp-auth.test.ts（附带：`VerifyAccessTokenResult` 新增 `tokenId` 后 stub 字面量与 principal 断言随之更新）
- tasks/gap-ac244-mcp-audit-log-outcomes-and-retention.md

## Notes

- 判据的 HTTP 调用用 `node:http` 不用 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的固定端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240/AC-241/AC-242/AC-243 同款说明）。既有 `token-info.routes.test.ts` 用 `fetch` 只是没抽中坏端口。
- 令牌 id 的来源：`VerifyAccessTokenResult` 成功分支新增 `tokenId`（从已读到的 `row.id` 带出，**不新增查库**），`McpPrincipal` 随之带 `tokenId`/`clientId`。若 AC-241 落地时已带 id，则沿用。PAT 没有客户端 id，故 `clientId` 记 `null`（SPEC「client id（PAT 为空）」）；OAuth 客户端 id 属 GOAL-021，本任务只留列。
- 保留期默认 90 天、每日一次均以 SPEC 为准；「启动时 + 每日」的启动那次在**装配点**（`server/index.ts`，AC-240 落点）调用 `startMcpAuditRetention` 时完成，不做 module-level 缓存或计时器（避免挡住判据在同一进程里注入假时钟/假调度缝，也避免让既有 gateway 挂载测试无意中武装真实计时器）。
- **boot-order 回归（本轮修复，2026-10-05）**：`startMcpAuditRetention()` 的启动那次会**立即** `DELETE FROM mcp_audit_log`，故必须在 `initializeDatabase()` 之后调用。原实现把它放在 `server/index.ts` **模块顶层**，先于 `startServer()` 里的 `await initializeDatabase()`，真机启动（`tsx server/index.ts`）时表尚未建，抛 `SqliteError: no such table: mcp_audit_log` 使进程在 `/health` 前就崩——进程级测试（`resident-server-restart`、`activity-heartbeat.process`）因此表现为 `/health` 25s 超时，被上一轮误判为负载 flake。现调用点移入 `startServer()` 内 `await initializeDatabase()` 之后（`server/index.ts`）。挂载 gateway 本身仍不建库、不武装计时器（判据可自由注入假时钟/假调度缝）。
- `summarizeToolArgs` 的 id 白名单以实际工具参数为准（SPEC 工具表用 `{ session }`、`{ project }` 等键）；若 AC-245+ 引入别的 id 键，应扩白名单——本任务先覆盖 `session`/`sessionId`/`project`/`projectId` 与自由文本 `message`。
- `duration_ms` 用可注入时钟测：`withMcpAudit` 若用 `Date.now()` 则判据只能断言非负整数，若要精确值就注入 `now`；判据至少断言非负整数。本任务用 `Date.now()`，判据断言非负整数。
- 越界不实现 AC-245–AC-257（只读/写工具、自指保护、设置页、冒烟）。本任务提供的 `withMcpAudit` 与工具注册缝正是 AC-245+ 的落点，AC-245 注册真实工具时复用同一包装器。
