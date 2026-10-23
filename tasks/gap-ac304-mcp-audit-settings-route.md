---
id: gap-ac304-mcp-audit-settings-route
title: AC-304 设置接口 GET /api/settings/mcp-audit 返回当前用户最近的外部写调用（默认只写、includeReads
  含只读、摘要沿用审计规则、时间倒序、limit 有界、不含令牌与他人数据）；判据
  server/modules/mcp-gateway/tests/mcp-audit-route.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac244-mcp-audit-log-outcomes-and-retention
goal_ac: AC-304
---
## Proposal

**AC-304（GOAL-028 退出条件 2；GOAL-028 范围「设置接口 `GET /api/settings/mcp-audit`：当前用户最近的外部写调用（可选含只读），参数摘要沿用审计表规则」）。** 放宽 ChatGPT 的确认弹窗后，服务端就是唯一闸门；本任务给用户一个事后核查入口：经生产的设置路由工厂，读当前用户最近的外部写调用。判据文件 `server/modules/mcp-gateway/tests/mcp-audit-route.test.ts` 当前不存在，AC-304 的存在性闸以退出码 1 逐字输出缺失路径（红先行）。

现状（红态基线）：

- 审计表 `mcp_audit_log` 与仓库 `server/modules/database/repositories/mcp-audit-log.db.ts`（`insert`/`count`/`allRows`/`deleteOlderThan`）、摘要器 `summarizeToolArgs`、单写点 `recordMcpToolCall`、读/写工具的唯一声明 `MCP_TOOL_ANNOTATIONS.readOnlyHint` 均已在 AC-244 落地（`gap-ac244-mcp-audit-log-outcomes-and-retention`，状态 done）。审计行只存 `token_id`/`client_id`/`tool`/`args_digest`/`outcome`/`at`/`duration_ms`——**没有 user_id**，也没有任何完整消息（AC-244 保证全文不落库）。
- 设置模块已有 `createSettingsRouter(service)` 工厂与 `createSettingsService(deps)`，路由 seam 形如 `respond((req) => service.xxx(userId(req), ...))`；认证由外部中间件把 `req.user.id` 填好（见 `server/modules/oauth/tests/access-tokens.routes.test.ts` 的 `setUser` 注入法）。
- 全仓库无 `GET /api/settings/mcp-audit`：`grep -rn "mcp-audit" server/ --include=*.ts` 只命中审计表名；仓库也无审计行的按令牌/归属读方法。

要交付：

1. **数据层（`server/modules/database/repositories/mcp-audit-log.db.ts`；经 database barrel 导出）**：新增 `listForTokens(tokenIds: number[], options: { limit: number; excludeTools?: readonly string[] }): McpAuditLogRow[]`——`WHERE token_id IN (...)`（`tokenIds` 为空 ⇒ 直接返回 `[]`，**不要**拼 `IN ()`），`excludeTools` 非空时追加 `AND tool NOT IN (...)`，`ORDER BY at DESC, id DESC LIMIT ?`。纯读：不分类、不解析摘要、不碰时钟。

2. **读取器（新文件 `server/modules/mcp-gateway/mcp-audit-route.ts`；遵守 `$backend-module-standards`；经 mcp-gateway barrel 导出）**：
   - `export const MCP_AUDIT_ROUTE_DEFAULT_LIMIT = 50; export const MCP_AUDIT_ROUTE_MIN_LIMIT = 1; export const MCP_AUDIT_ROUTE_MAX_LIMIT = 200;`
   - `export type McpAuditRouteEntry = { at: string; clientName: string | null; tool: string; outcome: string; summary: unknown };`
   - `export function readMcpAuditLimit(value: unknown): number`——纯函数：非有限整数（含 undefined/''/非数字串）⇒ `DEFAULT`；否则 clamp 到 `[MIN, MAX]`。
   - `export type McpAuditReadDeps = { listTokenIdsForUser(userId: number): number[]; listRowsForTokens(tokenIds: number[], limit: number, excludeTools: readonly string[]): McpAuditLogRow[]; resolveClientName(row: McpAuditLogRow): string | null };`
   - `export function createMcpAuditReader(deps): { listForUser(input: { userId: number; limit?: unknown; includeReads?: unknown }): McpAuditRouteEntry[] }`：
     - `limit = readMcpAuditLimit(input.limit)`；`includeReads = input.includeReads === true || input.includeReads === 'true'`。
     - 只读工具集合**由 `MCP_TOOL_ANNOTATIONS` 派生**（`readOnlyHint === true` 的名字集合），不硬编码名单；`includeReads` 为假时把它作为 `excludeTools` 传下去（这样「只回写调用」在 SQL 层生效，`limit` 数的是写行而不是被过滤掉的行）。
     - `tokenIds = deps.listTokenIdsForUser(userId)`；`rows = deps.listRowsForTokens(tokenIds, limit, excludeTools)`。
     - 每行映射为 `{ at: row.at, clientName: deps.resolveClientName(row), tool: row.tool, outcome: row.outcome, summary: parseDigest(row.args_digest) }`——`summary` 就是**审计行已存储的参数摘要**（`args_digest` 解析后的对象；`args_digest` 为 null/无法解析时退回原字符串或 null）。**读取端不重新摘要、不新增第二份摘要规则**（「沿用审计表的规则」= 直接读已存摘要）。
     - 响应行**不含** `token_id`/`client_id`/`token_hash`/`token_prefix`。

3. **设置服务（`server/modules/settings/settings.service.ts`）**：deps 袋新增 `mcpAudit: { listForUser(input: { userId: number; limit?: unknown; includeReads?: unknown }): McpAuditRouteEntry[] }`；新增方法 `listMcpAudit(userId: number, options: { limit?: unknown; includeReads?: unknown }): { rows: McpAuditRouteEntry[] }`，薄委托 `mcpAudit.listForUser({ userId, ...options })`。既有调用方按 optional 处理（不破坏既有判据构造的 deps 袋——照 `mcpGateway` 那个 optional port 的先例）。

4. **设置路由（`server/modules/settings/settings.routes.ts`）**：`router.get('/mcp-audit', respond((req) => service.listMcpAudit(userId(req), { limit: req.query.limit, includeReads: req.query.includeReads })))`——沿用既有 `respond`/`userId` 形制。

5. **生产装配（`server/modules/settings/settings.module.ts`）**：用 database barrel（`mcpAuditLogDb`、`accessTokensDb`、`oauthClientsDb`）装配一个 `createMcpAuditReader`，把结果作为 `mcpAudit` 交给 `createSettingsService`：
   - `listTokenIdsForUser: (userId) => accessTokensDb.listByUser(userId).map((t) => t.id)`
   - `listRowsForTokens: (tokenIds, limit, excludeTools) => mcpAuditLogDb.listForTokens(tokenIds, { limit, excludeTools })`
   - `resolveClientName: (row) => row.client_id !== null ? (oauthClientsDb.findById(row.client_id)?.client_name ?? 'mcp client') : (row.token_id !== null ? (accessTokensDb.findById(row.token_id)?.name ?? 'personal access token') : null)`（PAT 的 `client_id` 为 null ⇒ 回令牌的 `name`；OAuth 客户端 ⇒ 回注册的 `client_name`）。

6. **判据（新文件 `server/modules/mcp-gateway/tests/mcp-audit-route.test.ts`；红先行）**：形制照 `server/modules/oauth/tests/access-tokens.routes.test.ts`——`mkdtemp` + `process.env.DATABASE_PATH` + `initializeDatabase()` + 插 owner 用户行；用 `createAccessTokensService`（注入 `now`）造真令牌；用**生产** `createSettingsService`（其 `mcpAudit` 接到真 `createMcpAuditReader` + 真库 seam）+ `createSettingsRouter`，挂在 `/api/settings`，前面注入一个把 `req.user = { id: <userId> }` 写死的中间件（`setUser(id)` 可切换用户）；HTTP 调用用 `node:http`（**不用 `fetch`**——`listen(0)` 会抽到 undici 拒绝的坏端口，见内存 `undici-bad-port-lottery-in-listen0-route-tests`）。审计行**一律经生产写路径造**：`recordMcpToolCall({ tokenId, clientId, tool, outcome, durationMs, args })`（走真 `summarizeToolArgs`），或直接 `mcpAuditLogDb.insert` 但当次要 `at`、`argsDigest` 一律由 `summarizeToolArgs(...)` 产出——**判据自己绝不手写摘要字面量**。读/写工具名从 `MCP_TOOL_ANNOTATIONS` 派生（`readOnlyHint` 为真/假各取一个），不硬编码。**每个 `test(...)` 用各自的临时库**（fresh DB per test），使各读数的夹具互不混入。

7. **同步钉数**：本任务新增一个服务端测试文件，必须**同 commit** 把 `server/shared/tests/quay-test-script.test.ts` 的两处 `known`/`unknown` 钉数各自 **+1**（当前是 `known=3 unknown=234` 与 `known=1 unknown=236`）。**以实现时读到的数字为准 +1，不要硬编码成 AC-303 任务里的 235/237**（AC-303 可能尚未落地；两者各自 +1 后总数一致）。理由见 `## Notes`。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rn "goal_ac:\s*AC-304" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-304`；`grep -rn "AC-304" tasks/` 只命中 `gap-ac303-mcp-write-notification` 的边界段（它显式声明「AC-304 才做回看接口，不在本任务范围」）。AC-303（成功写调用推送通知）与本任务（设置接口回看审计行）是 GOAL-028 两条相互独立的机制：AC-303 在**写路径**挂钩通知器，本任务在**读路径**暴露审计行，互不实现对方。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-244 未落地则无 `mcp_audit_log` 表、`mcpAuditLogDb` 与 `summarizeToolArgs`。

## AC

- [x] 存在性闸红态：实现前运行 AC 命令，退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-audit-route.test.ts`（写下完整命令与完整输出）。命令：`for f in server/modules/mcp-gateway/tests/mcp-audit-route.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit-route.test.ts`
- [x] 判据绿：上述命令退出码 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] (a) 真实 HTTP `GET /api/settings/mcp-audit` 返回当前用户的审计行，每行含**时间 `at`、客户端名称 `clientName`、工具 `tool`、结果 `outcome`、目标/参数摘要 `summary`**；默认（无 `includeReads`）只含写调用——从 `MCP_TOOL_ANNOTATIONS` 派生一个写工具名与一个只读工具名各造一行，默认读数只回写工具那行、且只读那行不在；`?includeReads=true` 时两行都在。`clientName` 对 PAT（`client_id=null`）等于该令牌的 `name`。逐字写出两次读数与派生出的两个工具名。
- [x] (b) `summary` 沿用审计表摘要规则：对 `args = { session: 's1', message: 'x'.repeat(45) + 'SECRET_TAIL' }` 的那行，断言 `summary.session === 's1'`、`summary.message` 深等于 `{ length: 56, preview: 'x'.repeat(40) }`（**字面量断言，期望值不得由 `summarizeToolArgs` 推导**）；且整个响应 JSON 里 `'x'.repeat(41)` 与 `'SECRET_TAIL'` 均不出现。逐字写出该行 `summary` 与「响应含 41 连 x / 含 SECRET_TAIL」两个布尔读数。
- [x] (c) 时间倒序 + `limit` 有界：造 `MCP_AUDIT_ROUTE_MAX_LIMIT + 1` 行（显式 `at`，同一格式、严格递增），断言 `?limit=999999` 恰好回 `MCP_AUDIT_ROUTE_MAX_LIMIT` 行；`?limit=1` 恰好回 1 行且是 `at` 最大那行；`?limit=0` 与 `?limit=-5` 不 500、回 ≥1 行（下界）；整段 `at` 严格递减。逐字写出各次行数与首行 `at`。
- [x] (d) 不含令牌与哈希：造一个真 PAT 并读其存储 `token_hash`；发 GET 后断言响应 JSON 里既无明文令牌、也无该 `token_hash`、也无 `token_prefix`；且每个响应行对象**没有** `token_id`/`client_id`/`token_hash`/`token_prefix` 键（逐字写出响应行的键名集合）。判定用「`JSON.stringify(response)` 后 `.includes(...)` 为假」。
- [x] (e) 另一用户的行不返回：为 user2 造令牌并插一行带**可区分标记**（独有的工具名或 `at`/`clientName`）的审计行；以 user1 调用 `?includeReads=true&limit=999999`，断言响应**不含**该标记，且行数只等于 user1 自己的行数。逐字写出 user1 读数与 user2 标记是否出现。
- [x] 变异 (i)（返回完整消息 ⇒ (b) 必须红）：先提交实现与判据，再对 `server/modules/mcp-gateway/mcp-gateway.audit.ts` 的 `summarizeValue` 字符串分支做临时变异（把 `return { length: …, preview: … }` 改为 `return value`），运行判据，(b) 必须红——判据经生产写路径造行，故被服务的 `summary` 会带上完整消息；逐字记录变异 `git diff`、判据逐字失败行、恢复命令 `git checkout -- server/modules/mcp-gateway/mcp-gateway.audit.ts`，随后恢复并复跑至绿。该文件**仅作临时探针，恢复后无净改动**。
- [x] 变异 (ii)（返回别的用户的行 ⇒ (e) 必须红）：把 `server/modules/database/repositories/mcp-audit-log.db.ts` 的 `listForTokens` 中 `WHERE token_id IN (…)` 的归属谓词去掉（改为返回全表行），运行判据，(e) 必须红；记录变异 `git diff`、逐字失败行、恢复命令 `git checkout -- server/modules/database/repositories/mcp-audit-log.db.ts`，随后恢复并复跑至绿。
- [x] 钉数同步：`server/shared/tests/quay-test-script.test.ts` 的两处 `known`/`unknown` 各 +1（以实现时读到的数字为准）；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 的 `: error ` 计数 0；`npm run build` 退出码 0（GOAL-028 退出条件 3）。

## DoD

- **真落地**：在 `server/index.ts` 装配的生产 `settingsRoutes` 上，一次真实的 `GET /api/settings/mcp-audit` 会经 `createSettingsRouter` → `settingsService.listMcpAudit` → 生产装配的 `createMcpAuditReader`（真库 seam）返回当前用户最近的写调用行；`?includeReads=true` 才含只读。不是「测试里另搭一套 service」——判据用的 `createSettingsService` 与生产同形，且 `mcpAudit` port 接到真 `createMcpAuditReader` 与真 `mcpAuditLogDb`/`accessTokensDb`/`oauthClientsDb`。
- **红先行证据**：判据文件落地前，AC-304 的存在性闸以退出码 1 输出缺失文件名；判据文件落地后全绿。
- **两条取假形态**逐字入任务完成记录：每条含变异 `git diff`、判据的逐字失败行、恢复命令与恢复后复跑读数；每条只让指定腿变红（(i)→(b)、(ii)→(e)）。
- **所有权过滤是真的**：切换 `setUser` 会改变可见行集合；user2 的行在 user1 的读数里绝不出现（对真库读回，不是对函数独立断言）。
- **不回归**：既有 `server/modules/oauth/tests/access-tokens.routes.test.ts`、`server/modules/settings/tests/settings.service.test.ts` 与 AC-244 的 `server/modules/mcp-gateway/tests/mcp-audit.test.ts` 不改一字仍逐字通过（本任务只**新增** port/method/route/读方法，不改既有行为）。
- **后端规范**：新增/改动的 `server/` 代码遵守 `$backend-module-standards`——跨模块只走 barrel（settings↔database↔mcp-gateway↔oauth），导出只给必要成员并附消费方注释，无 module-local types/utils，≥2 处使用的工具进 `server/shared/utils.ts`；不引入新依赖。
- **钉数同步不遗漏**：`quay-test-script.test.ts` 两处钉数与新增的服务端测试文件数一致，全量 suite 不因本任务变红。

## Touches

- server/modules/database/repositories/mcp-audit-log.db.ts
- server/modules/mcp-gateway/mcp-audit-route.ts (new)
- server/modules/mcp-gateway/index.ts
- server/modules/settings/settings.service.ts
- server/modules/settings/settings.routes.ts
- server/modules/settings/settings.module.ts
- server/modules/mcp-gateway/tests/mcp-audit-route.test.ts (new)（判据）
- server/shared/tests/quay-test-script.test.ts（同步钉数 known/unknown 各 +1）
- server/modules/mcp-gateway/mcp-gateway.audit.ts（仅取假形态 (i) 的临时变异探针；恢复后无净改动）
- tasks/gap-ac304-mcp-audit-settings-route.md

## Notes

- **判据的 HTTP 调用用 `node:http` 不用 `fetch`**：`listen(0)` 在本机会抽到 undici 拒绝的固定坏端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240/244 同款说明）。
- **所有权映射靠令牌**：审计行只有 `token_id`/`client_id`，没有 user_id。当前用户的归属 = `accessTokensDb.listByUser(userId)` 得到的令牌 id 集合，再用它过滤 `mcp_audit_log.token_id`。不要给审计表加 user_id 列（越界改 AC-244 的表结构）。
- **`limit` 在 SQL 层生效**：只读过滤（`excludeTools`）必须和 `LIMIT` 在同一条 SQL 里（默认视图下 `limit` 数的是写行），否则「先取 N 行再在 JS 里滤掉只读」会让写行数少于 `limit`。
- **`at` 排序格式**：`CURRENT_TIMESTAMP` 产出 `YYYY-MM-DD HH:MM:SS`（空格分隔）。判据造行时用同一格式的显式 `at`，避免 ISO `T` 与空格混排导致字典序与时间序不一致；(c) 的夹具全部用显式 `at` 并经 `mcpAuditLogDb.insert` 落地。
- **读取端不重摘要**：`summary` 直接回 `args_digest` 解析结果。请在读取器处注释说明「沿用审计表规则」= 复用已存摘要，避免下一个评审者以为漏了截断。
- **钉数陷阱**（内存 `quay-test-script-pins-the-exact-server-test-file-count`）：每个新增的服务端 `*.test.ts` 都会让 `server/shared/tests/quay-test-script.test.ts` 里钉住的服务端测试文件总数对不上，全队全量 suite 变红且被驱动报成 UNATTRIBUTABLE。必须同 commit +1 两处；**以落地时实际读到的数字为准**，不要抄本任务或 AC-303 里写的具体数（AC-303 可能先/后落地，各自 +1 后总数一致）。
- **变异 (ii) 的探针只动归属谓词**：其余读方法行为（排序、limit、excludeTools）保持不动，确保只有 (e) 腿变红；每个 `test` 各自 fresh DB 也保证 (a)/(c)/(d) 的夹具不含 user2 的行。

## 完成记录

实现分支 `task/gap-ac304-mcp-audit-settings-route`，实现提交 `0659f40e`（feat(mcp-gateway): expose GET /api/settings/mcp-audit readback (AC-304)）。`git merge --no-edit develop` → `Already up to date`（MERGE_EXIT=0）；（本项目 `.quay/config.yml` 未声明 `loop.scoped_command`，scoped 门跳过）。

### 红先行（存在性闸）

命令与逐字输出（实现前）：

```
$ for f in server/modules/mcp-gateway/tests/mcp-audit-route.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit-route.test.ts
缺判据文件：server/modules/mcp-gateway/tests/mcp-audit-route.test.ts
EXIT=1
```

### 判据绿（判据文件落地后）

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit-route.test.ts
ℹ tests 6
ℹ pass 6
ℹ fail 0
EXIT=0
```

派生工具名（由 `MCP_TOOL_ANNOTATIONS.readOnlyHint` 派生，非硬编码）：write=`session_send`，read=`overview`。

### (a) 默认只写 / `?includeReads=true`

```
(a) default rows = [{"at":"2026-10-06 13:31:39","clientName":"audit-pat","tool":"session_send","outcome":"ok","summary":{"session":"s1"}}]
(a) includeReads rows = [{"at":"2026-10-06 13:31:39","clientName":"audit-pat","tool":"overview","outcome":"ok","summary":{}},{"at":"2026-10-06 13:31:39","clientName":"audit-pat","tool":"session_send","outcome":"ok","summary":{"session":"s1"}}]
```

默认只回 `session_send`（写）那行，`overview`（只读）不在；`?includeReads=true` 两行都在；PAT 的 `clientName` = 令牌 `name`（`audit-pat`）。

### (b) `summary` 沿用审计表摘要规则

```
(b) summary = {"session":"s1","message":{"length":56,"preview":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}
(b) response contains 41 x's = false; contains SECRET_TAIL = false
```

`summary.session === 's1'`；`summary.message` 深等于字面量 `{ length: 56, preview: 'x'.repeat(40) }`（期望值不来自 `summarizeToolArgs`）；响应 JSON 不含 41 连 x、不含 `SECRET_TAIL`。

### (c) 时间倒序 + `limit` 有界

```
(c) inserted 201 rows
(c) limit=999999 rows=200 first at=2026-01-01 00:03:20
(c) limit=1 rows=1 first at=2026-01-01 00:03:20
(c) limit=0 status=200 rows=1; limit=-5 status=200 rows=1
```

`limit=999999` 恰回 `MCP_AUDIT_ROUTE_MAX_LIMIT`=200 行；`limit=1` 恰 1 行且是 `at` 最大那行；`limit=0`/`limit=-5` 均 200 且 ≥1 行；整段 `at` 严格递减。

### (d) 不含令牌与哈希

```
(d) row keys = [at, clientName, outcome, summary, tool]
(d) contains plaintext=false; hash=false; prefix=false
```

响应行键集合 = `{at, clientName, outcome, summary, tool}`，无 `token_id`/`client_id`/`token_hash`/`token_prefix`；响应 JSON 不含明文令牌、`token_hash`、`token_prefix`。

### (e) 另一用户的行不返回

```
(e) user 1 rows = [{"at":"2026-10-06 13:31:42","clientName":"user1-pat","tool":"session_send","outcome":"ok","summary":{}}]
(e) user 2 marker "zzz-user2-only-tool" present = false
```

user1 读数只 1 行（自己的），user2 的可区分标记不出现。

### 变异 (i)（返回完整消息 ⇒ (b) 红）

临时变异 `git diff`（`server/modules/mcp-gateway/mcp-gateway.audit.ts` 的 `summarizeValue` 字符串分支）：

```
@@ -58,7 +58,7 @@ function summarizeValue(value: unknown, key: string | null): unknown {
   if (typeof value === 'string') {
     // Only the length and the first PREVIEW_LENGTH characters — no ellipsis, no
     // tail — so nothing past the preview can ever be reconstructed.
-    return { length: value.length, preview: value.slice(0, PREVIEW_LENGTH) };
+    return value;
   }
```

判据逐字失败行（`tests 6 / pass 5 / fail 1`，只 (b) 红）：

```
✖ (b) summary is the stored audit digest — ids verbatim, free text reduced — with no full text
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    actual: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxSECRET_TAIL',
    expected: { length: 56, preview: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
```

恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-gateway.audit.ts`。恢复后该文件净改动为空，复跑 `tests 6 / pass 6 / fail 0`（EXIT=0）。

### 变异 (ii)（返回别的用户的行 ⇒ (e) 红）

临时变异 `git diff`（`server/modules/database/repositories/mcp-audit-log.db.ts` 的 `listForTokens` 去掉 `WHERE token_id IN (…)` 归属谓词，改为返回全表行；排序/limit/excludeTools 不动）：

```
@@ -115,9 +115,8 @@ export const mcpAuditLogDb = {
     if (tokenIds.length === 0) {
       return [];
     }
-    const params: unknown[] = [...tokenIds];
-    const placeholders = tokenIds.map(() => '?').join(', ');
-    let sql = `SELECT ${AUDIT_COLUMNS} FROM mcp_audit_log WHERE token_id IN (${placeholders})`;
+    const params: unknown[] = [];
+    let sql = `SELECT ${AUDIT_COLUMNS} FROM mcp_audit_log WHERE 1 = 1`;
     const excludeTools = options.excludeTools ?? [];
     if (excludeTools.length > 0) {
```

判据逐字失败行（`tests 6 / pass 5 / fail 1`，只 (e) 红）：

```
✖ (e) another user's audit rows never appear in this user's read
  AssertionError [ERR_ASSERTION]: only the caller's own rows are counted
    actual: 2,
    expected: 1,
```

恢复命令：`git checkout -- server/modules/database/repositories/mcp-audit-log.db.ts`。恢复后该文件净改动为空，复跑 `tests 6 / pass 6 / fail 0`（EXIT=0）。

### 钉数同步

以实现时读到的数字为准，`server/shared/tests/quay-test-script.test.ts` 两处 `unknown` 各 +1（`known` 只数基线里仍在收集表内的文件，不因新增文件而变）：

- AC2 行：`known=3 unknown=234` → `known=3 unknown=235`
- AC3 行：`known=1 unknown=236` → `known=1 unknown=237`

```
$ npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts
ℹ tests 11
ℹ pass 11
ℹ fail 0
EXIT=0
```

### 不回归 + 静态门

- `server/modules/oauth/tests/access-tokens.routes.test.ts` → tests 7 / pass 7 / fail 0（EXIT=0）
- `server/modules/settings/tests/settings.service.test.ts` → tests 3 / pass 3 / fail 0（EXIT=0）
- `server/modules/mcp-gateway/tests/mcp-audit.test.ts` → tests 5 / pass 5 / fail 0（EXIT=0）
- `npm run typecheck` → EXIT=0
- `npm run lint` → `: error ` 计数 0（EXIT=0；新增/改动文件无 warning）
- `npm run build` → EXIT=0
