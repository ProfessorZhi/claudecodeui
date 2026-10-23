---
id: gap-ac265-oauth-settings-routes
title: AC-265 已连接的应用与 OAuth
  客户端设置接口：列出当前用户授权（名称/回调主机/scope/授权时间/最近使用，无密钥）、吊销授权（越权 404）、禁用客户端，吊销/禁用后其令牌下一次
  /mcp 返回 401，客户端列表区分 DCR 与手工；判据
  server/modules/oauth/tests/oauth-settings.routes.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac258-oauth-store-hash-and-revoke-cascade
  - gap-ac259-oauth-provider-semantics
  - gap-ac263-oauth-mcp-challenge-audience
goal_ac: AC-265
---
## Proposal

AC-265（GOAL-021 退出条件 6「管理」；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §152「`/api/settings/access-tokens | oauth-grants | oauth-clients`（JWT，设置页用）」、§421「吊销即时生效」、§483–§485「已连接的应用 / OAuth 客户端（高级）」）要求设置接口就位：列出当前用户的授权（每行含客户端名称、回调主机、scope、授权时间、最近使用，整个响应里找不到任何密钥与令牌）、按 id 吊销授权（**别的用户**的授权返回 404 而非 403/200）、禁用 OAuth 客户端；吊销或禁用后，其名下令牌的**下一次** `/mcp` 调用返回 401；客户端列表区分 DCR（`created_via='dcr'`）与手工创建（`created_via='manual'`）。判据文件 `server/modules/oauth/tests/oauth-settings.routes.test.ts` 当前不存在，存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-settings.routes.test.ts`（已实测）。

现状（红态基线）：
- `grep -rn "oauth-grants\|oauth-clients\|oauth-settings\|createOAuthSettingsRouter\|createOAuthSettingsService" server/ --include=*.ts` 为空——没有任何设置接口承接授权的列出/吊销与客户端的列出/禁用。
- `server/modules/settings/settings.routes.ts:44-51` 只有 `/access-tokens` 三条（PAT）；settings 模块不读 OAuth 的 grant/client。
- `server/modules/oauth/` 现有 `access-tokens.service.ts`、`token-info.routes.ts`、`index.ts`，**没有** settings 文件。

**真实前置**（frontmatter `depends_on` 已声明）：
- `gap-ac258-oauth-store-hash-and-revoke-cascade`（ready）交三表与仓储（`oauthClientsDb` 的 `findById`/`allRows`/`disable`，`oauthGrantsDb` 的 `findById`/`revoke`）与 `createOAuthStore({ now })` 的 `revokeGrant(grantId) → { grantRevoked, tokensRevoked }`、`disableClient(clientId) → { clientDisabled, tokensRevoked }`（事务内级联其全部令牌落 `revoked_at`）。
- `gap-ac259-oauth-provider-semantics`（todo）交 `createOAuthProvider({ store, now, publicBaseUrl })` 的 `verifyAccessToken(token, { resource })`，供判据在 `/mcp` 上造真 OAuth 令牌并验证吊销后的 401。
- `gap-ac263-oauth-mcp-challenge-audience`（todo）交 OAuth 感知的 `createMcpAuthMiddleware({ tokens, oauth })`（无令牌 401、OAuth 令牌经注入 `oauth` 缝校验）。判据用它把 `/mcp` 以生产认证装配起来，证明 (b)/(c) 的「下一次 `/mcp` 返回 401」。

本任务只做设置接口（列表/吊销/禁用）与其判据，不重写存储与级联（AC-258）、不实现授权服务器语义（AC-259）、授权页（AC-260/261）、元数据（AC-262）、`/mcp` 认证本体（AC-263）、DCR 策略与手工创建端点（AC-264）、浏览器 UI（AC-266）、文案（AC-267）、端到端（AC-268）。

要交付：

1. **授权读的仓储补充（`server/modules/database/repositories/oauth-grants.db.ts` + `server/modules/database/index.ts`）**：新增 `listByUser(userId: number): GrantRow[]`（`SELECT * FROM oauth_grants WHERE user_id = ? ORDER BY id`），经 database barrel 导出并带消费方注释（消费者：本任务的 settings service 与判据）。这是 AC-258 未提供的唯一读原语；不改其既有方法签名、不改 `revoke`/级联语义。

2. **设置服务（新文件 `server/modules/oauth/oauth-settings.service.ts`；遵守 `$backend-module-standards`）**：
   - `createOAuthSettingsService({ store, grantsDb, clientsDb, now }): OAuthSettingsService`：
     - `listGrants(userId)`：`grantsDb.listByUser(userId)`，对每行经 `clientsDb.findById(client_id)` 取 `client_name` 与 `redirect_uris`（JSON 数组解析，取第一个 uri 的 `hostname`）；解析 `scopes` JSON。**只**投影 `{ id, clientId, clientName, redirectHost, scopes, createdAt, lastUsed }`——显式白名单，绝不透传 `client_secret_hash`/`metadata`/令牌；`lastUsed` 可为 null。
     - `revokeGrant(userId, grantId)`：`grantsDb.findById(grantId)`；不存在 **或** `row.user_id !== userId` → `{ ok: false, reason: 'not_found' }`（越权与不存在同码，不做预言机，(d) 的读数）；否则 `store.revokeGrant(grantId)` → `{ ok: true, tokensRevoked }`。
     - `listClients()`：`clientsDb.allRows()`，投影 `{ clientId, clientName, redirectHost, createdVia, disabledAt }`——`createdVia` 即 `'dcr'|'manual'`，(e) 的区分；**不含** `client_secret_hash`/`metadata`。
     - `disableClient(clientId)`：`clientsDb.findById` 不存在 → `{ ok:false, reason:'not_found' }`；否则 `store.disableClient(clientId)` → `{ ok:true, tokensRevoked }`（(c) 的级联由 AC-258 保证）。
   - 服务不实现认证、不做路由；`now` 仅为可注入时钟。

3. **路由（新文件 `server/modules/oauth/oauth-settings.routes.ts`；保持路由薄，形制照 `settings.routes.ts`）**：`createOAuthSettingsRouter(service): Router`：
   - `GET /oauth-grants` → `200 { grants: service.listGrants(userId(req)) }`。
   - `DELETE /oauth-grants/:grantId` → `not_found` → **404**；成功 → `200 { revoked: true, tokensRevoked }`。
   - `GET /oauth-clients` → `200 { clients }`（含 `createdVia`）。
   - `PATCH /oauth-clients/:clientId/disable` → 不存在 → 404；成功 → `200 { disabled: true, tokensRevoked }`。
   - `userId(req)` 从 `req.user.id` 读（与 settings 模块同款）；路由自身**不**实现认证，认证由组合根施加。

4. **组合根（`server/index.ts`）**：在既有 `app.use('/api/settings', authenticateToken, settingsRoutes)` 之后，`app.use('/api/settings', authenticateToken, createOAuthSettingsRouter(createOAuthSettingsService({ store, grantsDb: oauthGrantsDb, clientsDb: oauthClientsDb })))`；`store` 与 AC-258/AC-264 共用同一个进程内实例。路径落在 SPEC §152 的 `/api/settings/oauth-grants`、`/api/settings/oauth-clients`，与 AC-264 的 `/api/oauth/clients` POST 不冲突（后者是另一前缀）。

5. **barrel（`server/modules/oauth/index.ts`）**：新增导出 `createOAuthSettingsService`、`createOAuthSettingsRouter` 与所需类型（消费者：`server/index.ts` 与判据），各自写消费方注释；不导出无消费者符号。

6. **判据文件 `server/modules/oauth/tests/oauth-settings.routes.test.ts`（红先行；真实 better-sqlite3 临时库 + 真 express 4 + 真实 HTTP——`listen(0)` 会抽到 undici 拒绝的固定端口，见 AC-240/AC-241 同款说明，故用 `node:http` 而非 `fetch`；形制照 `server/modules/oauth/tests/token-info.routes.test.ts`）**：
   - 装配：`mkdtemp` 临时目录、`closeConnection()`、`process.env.DATABASE_PATH` 指向临时库、`initializeDatabase()`，插两个用户行（A=1、B=2）；`MCP_OAUTH_ENABLED=true`、`PUBLIC_BASE_URL='https://mcp.example.test'`；建 `createOAuthStore`（注入时钟）造两个客户端——一个 `createdVia:'dcr'`、一个 `createdVia:'manual'`——各建 grant（(a) 用）、经 store 的 `issueOAuthToken({ grantId, kind:'oauth_access', scopes, resource: \`${PUBLIC_BASE_URL}/mcp\` })` 造真令牌。**注入的认证**：`app.use('/api/settings', injectUser, createOAuthSettingsRouter(service))`，`injectUser` 从请求头 `x-test-user` 取 `Number` 写 `req.user={id}`（使 (d) 能在同一运行里切换认证用户）。同一 app 上以 AC-263 的 `createMcpAuthMiddleware({ tokens, oauth: createOAuthProvider({ store, now, publicBaseUrl }) })` 装配 `POST /mcp`（handler 返回 200），证明 (b)/(c)。
   - (a) **授权列表字段齐全且无密钥**：GET `/api/settings/oauth-grants`（as A）→ 200；每行有 `clientName`/`redirectHost`/`scopes`/`createdAt`/`lastUsed`；逐字写下第一条行；对整段响应**原始文本**扫描：种子客户端的 `client_secret` 明文与其 `sha256`、以及种子的 access token 明文**均不出现**；正例对照：该客户端的 `clientName` **出现**（证明扫描器非恒真）。
   - (b) **吊销授权 ⇒ 其令牌下一次 /mcp 401**：`POST /mcp` 带 `Authorization: Bearer <cca_…>` → 200（正例对照）；DELETE `/api/settings/oauth-grants/:id` → 200；同一令牌再 `POST /mcp` → **401**。逐字写下吊销前后两次状态码与回读的 `revoked_at`。
   - (c) **禁用客户端 ⇒ 其令牌下一次 /mcp 401**：另建 client+grant+token，`POST /mcp` → 200；PATCH `/api/settings/oauth-clients/:clientId/disable` → 200；同一令牌 `POST /mcp` → **401**；正例对照：另一未被禁用的客户端令牌仍 200。逐字写下。
   - (d) **吊销别的用户的授权 ⇒ 404**：为 B 建 grant；as A DELETE 该 grant → **404**；回读该 grant `revoked_at` 仍为 NULL（未被误吊销）；as B DELETE 同一 grant → 200（正例对照）。逐字写下三次读数。
   - (e) **客户端列表区分 DCR 与手工**：GET `/api/settings/oauth-clients` → 200；响应里 DCR 客户端 `createdVia==='dcr'`、手工客户端 `createdVia==='manual'`，两者 `clientName`/`redirectHost` 齐；整段文本无 `client_secret`/`_hash`/令牌明文。逐字写下两行 `createdVia`。
   - (f) **不回归**：`server/modules/oauth/tests/token-info.routes.test.ts`、`access-tokens.service.test.ts` 不改一字仍逐字通过；`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）。

7. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 列表返回密钥哈希（`listGrants`/`listClients` 的投影加上 `client_secret_hash`）⇒ (a) 必须红；
   (ii) 吊销不校验归属（`revokeGrant` 去掉 `row.user_id !== userId` 判定，直接 `store.revokeGrant`）⇒ (d) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rlE '^goal_ac:[[:space:]]*AC-265[[:space:]]*$' tasks/` 为空，本仓库无任何任务带 AC-265；`grep -rln "oauth-grants\|oauth-clients\|oauth-settings\|createOAuthSettingsRouter\|listByUser" tasks/` 只命中 AC-258/259/260/262/263/264 的越界声明句（各自明确把「设置列表/吊销/禁用」让给 AC-265；AC-264 占 `/api/oauth/clients` 的 POST，本任务用 `/api/settings/oauth-clients`，前缀不同不冲突）。AC-258（存储/级联）、AC-259（语义/受众）、AC-263（/mcp 认证）是**机械前置**（frontmatter `depends_on` 已声明）：本任务复用其 `createOAuthStore.revokeGrant`/`disableClient`、`createOAuthProvider.verifyAccessToken`、`createMcpAuthMiddleware`，不重写任一机制。AC-265 判据自足：临时 `DATABASE_PATH` + 真 express + 真实 HTTP，不挂 `server/index.ts`、不取用任何真实外部客户端。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-265 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-settings.routes.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/oauth/tests/oauth-settings.routes.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-settings.routes.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 授权列表每行含客户端名称、回调主机、scope、授权时间、最近使用；整段响应原始文本找不到种子客户端的 `client_secret` 明文/其 sha256、令牌明文；正例对照 clientName 出现；逐字写出首行与扫描结果。
- [x] AC4 (b) 吊销授权后，其名下 access 令牌下一次 `POST /mcp` 401；吊销前 200（正例对照）；逐字写出两次状态码与 `revoked_at`。
- [x] AC5 (c) 禁用客户端后，其令牌下一次 `POST /mcp` 401；另一未被禁用客户端令牌仍 200（正例对照）；逐字写出。
- [x] AC6 (d) as A 吊销 B 的授权 ⇒ 404 且该 grant `revoked_at` 仍 NULL；as B 吊销同一条 ⇒ 200（正例对照）；逐字写出三次读数。
- [x] AC7 (e) 客户端列表区分 DCR（`createdVia==='dcr'`）与手工（`'manual'`），两者名称/回调主机齐，文本无密钥；逐字写出两行 `createdVia`。
- [x] AC8 取假形态两条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 列表返回密钥哈希 ⇒ AC3 红；(ii) 吊销不校验归属 ⇒ AC6 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`token-info.routes.test.ts`、`access-tokens.service.test.ts` 不改一字仍逐字通过。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 设置接口**真的**在真 express + 真实 HTTP 上可用：列出当前用户的授权（字段齐全）、按 id 吊销、禁用客户端，均由判据经真实请求驱动，不是「函数被调用」或「路由存在」就算数。
- 列表**真的**不含任何密钥与令牌：判据对整段响应原始文本扫描种子 secret 明文/其哈希/令牌明文，且正例对照证明扫描器非恒真。
- 吊销/禁用**真的**即时生效：其令牌下一次 `/mcp` 调用真返回 401，读回 `revoked_at`/`disabled_at` 佐证——不是「标了 grant」就算数。
- 越权吊销**真的**返回 404：别的用户的授权被 404 拒绝且真未被吊销；归属校验不是装饰。
- 客户端列表**真的**区分 DCR 与手工（`createdVia` 逐字读数）。
- 两条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号、路由薄/服务承载语义）与 AGENTS.md；不引入新依赖（复用既有 express/better-sqlite3 与 node 内置）；不越界实现 AC-258–AC-264、AC-266–AC-270。

## Touches

- server/modules/oauth/oauth-settings.service.ts (new)
- server/modules/oauth/oauth-settings.routes.ts (new)
- server/modules/oauth/index.ts
- server/modules/database/repositories/oauth-grants.db.ts
- server/modules/database/index.ts
- server/index.ts
- server/modules/oauth/tests/oauth-settings.routes.test.ts (new)（判据）
- tasks/gap-ac265-oauth-settings-routes.md

## Notes

- 路由路径取 SPEC §152 的 `/api/settings/oauth-grants`、`/api/settings/oauth-clients`，与 AC-264 的 `/api/oauth/clients` POST（另一前缀）不冲突；若 AC-264 实际改挂到 `/api/settings/oauth-clients`，以不冲突为准调整并更新正文与判据。
- `oauthGrantsDb.listByUser` 是本任务对 AC-258 唯一的仓储补充（AC-258 只给了 `listIdsByClient`）；不改其既有方法签名。越权判定发生在**服务层**（读 `user_id` 比对），不改 AC-258 的 `revokeGrant`/`disableClient` 语义（无归属参数）。
- (b)/(c) 的 `/mcp` 装配复用 AC-263 的 OAuth 感知 `createMcpAuthMiddleware` 与 AC-259 的 `createOAuthProvider`；若其实际落点/名字/返回形状不同，以实际为准，并按需把相关文件加进 `## Touches`（内存 `quay-touches-must-match-actual-write-sites`）。
- 判据优先用 `node:http` 而非 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（AC-240/AC-241 同款）。
- 新增测试文件可能被边界 lint 拦截（内存 `quay-boundaries-lint-blocks-new-test-files`）；判据文件已列入 `## Touches`。
- 判据是本任务的机械读数，文件即 AC-265 `criterion:` 所点名的那个；不新建第二个判据文件。
