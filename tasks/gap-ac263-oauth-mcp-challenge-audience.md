---
id: gap-ac263-oauth-mcp-challenge-audience
title: AC-263 OAuth 开启后 /mcp 的认证：无令牌 401 带 resource_metadata 指引、PAT 与 OAuth
  令牌并存且审计区分来源、受众不符被拒、回环守卫自动关闭、缺 scope 写 denied 审计；判据
  server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac241-mcp-token-auth-shares-service
  - gap-ac242-mcp-loopback-guard-before-auth
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac258-oauth-store-hash-and-revoke-cascade
  - gap-ac259-oauth-provider-semantics
  - gap-ac262-oauth-metadata-endpoints
goal_ac: AC-263
---
## Proposal

AC-263（GOAL-021 退出条件 4；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §415、§416、§418、§422、§516、§524）要求 `MCP_OAUTH_ENABLED` 开启后 `/mcp` 的认证行为由本任务落地，并由判据 `server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts` 证明。五条读数：(a) 无令牌访问 `/mcp` 得 401，`WWW-Authenticate` 为 Bearer 且含 `resource_metadata="<基址>/.well-known/oauth-protected-resource/mcp"`；(b) 有效 PAT 与有效 OAuth access token 都被接受，且审计行 `client_id` 因令牌来源而异——OAuth 令牌写入其客户端 id、PAT 为空；(c) `resource` 不是本服务 `${PUBLIC_BASE_URL}/mcp` 的 OAuth 令牌被拒；(d) 开启 OAuth 时非回环来源到达认证并得到 401，而不是回环守卫的 403；(e) scope 不含所调工具所需 scope 的 OAuth 令牌被拒并写 `denied` 审计。判据文件当前不存在，存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/mcp-gateway.auth.ts`（AC-241）只校验 `ccp_` PAT，401 体固定为 `{ error: 'A valid personal access token is required', code: 'ACCESS_TOKEN_INVALID' }`，**无 `WWW-Authenticate` 头**；`server/modules/oauth/access-tokens.service.ts` 的 `VerifyAccessTokenResult` 成功分支不含 `kind`/`resource`/`clientId`；`grep -rn "resource_metadata\|WWW-Authenticate" server/ --include=*.ts` 为空（`oauth-protected-resource` 的唯一命中是 AC-240 判据里的装配守卫，不产生响应头）；AC-258 的 OAuth store（`cca_`/`ccr_` 前缀）与 AC-259 的 `verifyAccessToken(token, { resource })`（受众不符返回 `invalid_target`）尚未落地。

要交付：

1. **OAuth 感知的认证中间件（扩展 `server/modules/mcp-gateway/mcp-gateway.auth.ts`；遵守 `$backend-module-standards`）**：
   - 选项形状扩为 `createMcpAuthMiddleware({ tokens, oauth })`，`oauth?: { publicBaseUrl: string; verifyAccessToken(token: string, opts: { resource: string }): OAuthVerifyResult }`。`readMcpOauthEnabled(env)`（AC-242 的唯一读取点）**每请求现场求值、不缓存**，使判据能在同一进程翻转开关态。
   - 复用 AC-241 已提入 `server/shared/utils.ts` 的 Bearer 解析，不重写。
   - 判定顺序：`ccp_` 前缀走 PAT `tokens.verifyToken`；否则（OAuth 开启且注入 `oauth` 缝时）走 `oauth.verifyAccessToken(token, { resource: \`${oauth.publicBaseUrl}/mcp\` })`。二者皆失败 ⇒ 拒绝。**不按拒绝原因分支、不做预言机**：无头 / 非 Bearer / 空令牌 / 未知 / 过期 / 吊销 / 前缀错 / 受众错 / 未知 OAuth 令牌一律同一个 401 体 + （OAuth 开启时）同一个 `WWW-Authenticate` 头。
   - **成功**：`res.locals.mcpPrincipal = { userId, tokenId, clientId, scopes }`——PAT 的 `clientId` 为 `null`（SPEC「PAT 为空」），OAuth 的 `clientId` 取自 AC-259 判定所指向的 grant→client。主体形状以 AC-244 实际落地的 `McpPrincipal`（含 `tokenId`/`clientId`）为准；若 AC-259 的返回未带 `clientId`，在装配处按 `grantId` 从 AC-258 store 解析（需要改 `server/modules/oauth/oauth-store.service.ts` 或 `oauth-provider.service.ts` 时，先用 `task_write` 把该文件加进本任务 `## Touches` 再改，见 `quay-touches-must-match-actual-write-sites`）。
   - **失败且 OAuth 开启**：`res.status(401)` 且响应头 `WWW-Authenticate: Bearer resource_metadata="<oauth.publicBaseUrl>/.well-known/oauth-protected-resource/mcp"`（URL 逐字字符串拼接，不做编码/重写）。**失败且 OAuth 关闭**：逐字保持 AC-241 的 401 体与「无 `WWW-Authenticate`」行为（AC-241 判据不改一字仍绿）。
2. **受众闸（消费 AC-259 的判定，不重写）**：`resource` 不等于 `${publicBaseUrl}/mcp` 的 OAuth 令牌由 AC-259 `verifyAccessToken` 返回 `invalid_target`，中间件把它当一般失败拒绝（401）。本任务**不自算受众**，只接线与断言。
3. **装配（`server/modules/mcp-gateway/mcp-gateway.transport.ts` + `server/index.ts`）**：`McpGatewayDeps` 增加可注入 `oauth` 缝并透传给 `createMcpAuthMiddleware`；`server/index.ts` 用 AC-258 `createOAuthStore` 与 AC-259 `createOAuthProvider`（`publicBaseUrl` 取自 `PUBLIC_BASE_URL`）构造 `oauth` 传入 `mountMcpGateway`，装配点仍在静态路由 `createStaticAssetsMiddleware` 之前（AC-240）。回环守卫（AC-242）保持原位、逻辑不改；本任务只在取假形态 (iii) 中临时变异并恢复。
4. **scope 拒绝 + `denied` 审计（消费 AC-244 的 `withMcpAudit` 与工具注册缝，不重写审计）**：经注册缝注册一个探针工具（所需 scope 如 `cloudcli:read`）。工具调用时 AC-244 的 `withMcpAudit` 用 `principal.scopes` 判定：缺所需 scope ⇒ 返回 `isError` 且 `mcp_audit_log` 恰一行 `denied`（写该 OAuth 令牌的 `client_id` 与 `token_id`）。本任务只接线与断言，不实现真实工具。
5. **判据文件 `server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP `node:http`（**不用 `fetch`**——`listen(0)` 会抽到 undici 拒绝的固定端口，见 AC-240/AC-241 同款说明）+ 真实 better-sqlite3 临时库，形制照 `server/modules/oauth/tests/token-info.routes.test.ts`）**：
   - 装配：`mkdtemp` 临时目录、`closeConnection()`、`process.env.DATABASE_PATH` 指向临时库、`initializeDatabase()`、插 owner 用户行；注入时钟的 `createAccessTokensService` 发真 PAT；用 AC-258 store + AC-259 provider 造真 OAuth 客户端/grant/令牌（经 provider 的 `authorize` + `exchangeAuthorizationCode`，或 store 的签发方法，以实际落地形状为准）；经 AC-244 注册缝注册探针工具（含所需 scope）；同一 app 上 `mountMcpGateway(app, { authorize: createMcpAuthMiddleware({ tokens, oauth }), registerTools })`，`MCP_ENABLED=true`，`MCP_OAUTH_ENABLED` 按读数切换。
   - (a) OAuth 开启、无令牌 `POST /mcp` ⇒ 401，`WWW-Authenticate` 逐字等于 `Bearer resource_metadata="<publicBaseUrl>/.well-known/oauth-protected-resource/mcp"`；逐字写下头值与状态码。正例对照：OAuth 关闭无令牌 ⇒ 401 且**无** `WWW-Authenticate`。
   - (b) 有效 PAT 与有效 OAuth access token 各发一次 `POST /mcp`（`tools/list` 或探针工具）⇒ 均 200；随后读 `mcp_audit_log` 两行：OAuth 行 `client_id` 逐字等于该客户端 id，PAT 行为 NULL/空；逐字写下两行与两次状态码。
   - (c) `resource` = 另一基址（如 `https://elsewhere.example/mcp`）的 OAuth access token ⇒ 401；正例对照：`resource` = `${publicBaseUrl}/mcp` 同形令牌 ⇒ 200；逐字写下令牌 `resource` 与两次状态码。
   - (d) OAuth 开启、伪造非回环 socket（照 AC-242 的 `Object.defineProperty(req, 'socket', { value: { remoteAddress: '172.17.0.1' }, configurable: true })` 手法）+ 无令牌 ⇒ 401（认证层）而非 403（守卫）；正例对照：OAuth 关闭时同形请求 ⇒ 403；逐字写下两次状态码。
   - (e) 只有 `cloudcli:session:send` 的 OAuth access token 调所需 `cloudcli:read` 的探针工具 ⇒ 结果 `isError` 且 `mcp_audit_log` 恰一行 `denied`（`client_id` = 该客户端、`token_id` = 该令牌行）；正例对照：带所需 scope 同类令牌 ⇒ `ok`；逐字写下结果与两行审计。
   - 源码级正负对照：`grep -n "resource_metadata" server/modules/mcp-gateway/mcp-gateway.auth.ts` 非空（模式并非永不匹配），且 (a) 的头断言取自真实响应头而非自造字符串。
6. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 401 不带 `resource_metadata`（删掉 `WWW-Authenticate` 头或其 `resource_metadata` 参数）⇒ (a) 必须红；
   (ii) 不校验受众（忽略 AC-259 返回的受众判定 / 不传 `resource`）⇒ (c) 必须红；
   (iii) OAuth 开启后仍保留回环守卫（在 `mcp-gateway.loopback.ts` 把 `readMcpOauthEnabled` 判定短路为 false，使守卫始终生效）⇒ (d) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令（(iii) 用 `git checkout -- server/modules/mcp-gateway/mcp-gateway.loopback.ts`），恢复后重跑回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-263" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-263`；`grep -rlE "resource_metadata|WWW-Authenticate|mcp-oauth-challenge|受众" tasks/` 只命中 AC-242/AC-258/AC-259/AC-260/AC-262 的越界声明句（各自明确把 `/mcp` 认证让给 AC-263）。AC-241（PAT 认证）、AC-242（回环守卫与 `MCP_OAUTH_ENABLED` 读取点）、AC-243（scope 词汇）、AC-244（审计与 `McpPrincipal`）、AC-258（OAuth 存储）、AC-259（OAuth 语义与受众判定）、AC-262（元数据端点）是不同机制与不同判据文件；本任务只把它们接进 `/mcp` 的认证并写自己的判据，不重写任一机制。机械前置（frontmatter `depends_on`）：AC-241 未落地则无认证中间件可扩展；AC-244 未落地则无 `clientId`、审计与注册缝，(b)/(e) 无从证明；AC-242 未落地则无 `readMcpOauthEnabled`；AC-258/AC-259 未落地则无 OAuth store/provider 可造真令牌与受众判定；AC-262 未落地则 `/.well-known/oauth-protected-resource/mcp` 无对应端点。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-263 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) OAuth 开启、无令牌 ⇒ 401 且 `WWW-Authenticate` 逐字含 `Bearer resource_metadata="<publicBaseUrl>/.well-known/oauth-protected-resource/mcp"`；正例对照 OAuth 关闭 ⇒ 401 且无该头；逐字写下两条头值与状态码。
- [x] AC4 (b) 有效 PAT 与有效 OAuth access token 都 200；`mcp_audit_log` 两行 `client_id`：OAuth = 客户端 id、PAT = 空；逐字写下两行与两次状态码。
- [x] AC5 (c) `resource` 非本服务 `/mcp` 的 OAuth 令牌被拒 401；受众正确同形令牌 200（正例对照）；逐字写下令牌 `resource` 与两次状态码。
- [x] AC6 (d) OAuth 开启、非回环 socket + 无令牌 ⇒ 401（非守卫的 403）；OAuth 关闭同形 ⇒ 403（正例对照）；逐字写下两次状态码。
- [x] AC7 (e) 缺所需 scope 的 OAuth 令牌调探针工具 ⇒ `isError` 且恰一行 `denied`（`client_id`/`token_id` 正确）；带所需 scope ⇒ `ok`（正例对照）；逐字写下结果与两行审计。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 去 `resource_metadata` ⇒ AC3 红；(ii) 不校验受众 ⇒ AC5 红；(iii) 保留回环守卫 ⇒ AC6 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：AC-240 `mcp-transport.test.ts`、AC-241 `mcp-auth.test.ts`、AC-242/AC-244 判据不改一字仍逐字通过；`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)` 标注；`mcp-gateway.loopback.ts` 仅作 (iii) 变异目标、最终 delta 不含，已标注）；列出实际改动文件清单。

## DoD

- `/mcp` 在 OAuth 开启后真的按 SPEC 行为：无令牌的 401 带可发现的 `resource_metadata` 指引，PAT 与 OAuth 令牌并存且审计能区分来源，受众不对的令牌真的被拒，回环守卫真的自动关闭，缺 scope 真的写 `denied`——判据用真实 express + 真实 HTTP + 真实库 + 真 OAuth 令牌驱动，五条读数各有原始值。
- 受众与 scope 判定都来自既有机制（AC-259 / AC-244），本任务只接线：不改写 OAuth provider 语义、不重写审计、不重写回环守卫（仅在取假形态中临时变异并恢复）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不越界实现 AC-258–AC-262、AC-264–AC-270。

## Touches

- `server/modules/mcp-gateway/mcp-gateway.auth.ts`
- `server/modules/mcp-gateway/mcp-gateway.transport.ts`
- `server/modules/mcp-gateway/index.ts`
- `server/index.ts`
- `server/modules/oauth/oauth-provider.service.ts`（AC-259 provider：为 `verifyAccessToken` 成功分支补 `tokenId`/`clientId`，使 `/mcp` 认证机构能区分令牌来源；Proposal §1/§5）
- `server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts` (new)（判据）
- `server/modules/mcp-gateway/mcp-gateway.loopback.ts`（取假形态 (iii) 变异目标，恢复后最终 delta 不含此文件）
- tasks/gap-ac263-oauth-mcp-challenge-audience.md

## Notes

- OAuth access token 前缀为 `cca_`、refresh 为 `ccr_`（AC-258），PAT 为 `ccp_`（AC-241）；中间件据此区分来源，但**不把前缀当作信任依据**——一律走各自 service 校验。
- 判据的 HTTP 调用用 `node:http` 不用 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（见 AC-240/AC-241 同款说明）。
- 若 AC-258/AC-259/AC-244 实际落地的形状与本 Proposal 假设不同（例如 `verifyAccessToken` 返回不含 `clientId`、`McpPrincipal` 形状不同、注册缝名字不同），以实际落地为准；需要改其文件时先用 `task_write` 把该文件加进 `## Touches` 再改。
- AC-263 是与 GOAL-021 人工关卡 AC-270 不同的机械判据：本任务不碰真实外部客户端，只证明 `/mcp` 在 OAuth 开启后的认证行为。

<!-- execution-trace -->
AC2 读数：`# tests 6 / # pass 6 / # fail 0`，退出 0（快照在实现提交 `30f45ad4`；merge develop 后重跑仍 6/6）。
AC3 读数：OAuth on 无令牌 → `401`，`WWW-Authenticate: Bearer resource_metadata="https://cli.example/.well-known/oauth-protected-resource/mcp"`（逐字）；OAuth off 无令牌 → `401`，无 `WWW-Authenticate`（`null`）。
AC4 读数：PAT → `200` row `{"token_id":1,"client_id":null,"tool":"probe_read","outcome":"ok"}`；OAuth → `200` row `{"token_id":2,"client_id":"<clientId>","tool":"probe_read","outcome":"ok"}`。
AC5 读数：mis-bound token resource=`https://elsewhere.example/mcp` → `401`；bound token resource=`https://cli.example/mcp` → `200`。
AC6 读数：OAuth on 非回环 socket(172.17.0.1)+无令牌 → `401`；OAuth off 同形 → `403`。
AC7 读数：缺 scope → `isError=true` row `{"token_id":1,"client_id":"<clientId>","outcome":"denied"}`；带 scope → `isError=false` row `{"outcome":"ok"}`（每调用恰一行）。
AC8 读数：实现提交 `30f45ad4` 后逐条变异——(i) 删 `WWW-Authenticate` ⇒ (a) 红 `AssertionError [ERR_ASSERTION]: the challenge must be the exact discovery pointer`，`git checkout -- server/modules/mcp-gateway/mcp-gateway.auth.ts` 恢复后 6/6；(ii) 跳受众检查（`if (false && row.resource !== expectedAudience)`）⇒ (c) 红 `AssertionError [ERR_ASSERTION]: a mis-bound OAuth token must be refused`，`git checkout -- server/modules/oauth/oauth-provider.service.ts` 恢复后 6/6；(iii) `readMcpOauthEnabled` 短路为 false ⇒ (d) 红 `AssertionError [ERR_ASSERTION]: with OAuth on the guard stands down and auth answers 401`，`git checkout -- server/modules/mcp-gateway/mcp-gateway.loopback.ts` 恢复后 6/6。恢复后 `git status` 干净。
AC9 读数：`mcp-transport/mcp-auth/mcp-loopback-guard/mcp-audit/mcp-read-tools/oauth-provider` 六文件 32/32 pass（未改一字）；`npm run typecheck` 退出 0（三段 tsc 全过）；`npm run lint` 退出 0，`: error ` 计数 = 0，我改动的六个文件无任何 warning。
AC10 读数：`git diff --name-status develop...HEAD` = M `server/index.ts`、M `server/modules/mcp-gateway/index.ts`、M `server/modules/mcp-gateway/mcp-gateway.auth.ts`、M `server/modules/mcp-gateway/mcp-gateway.transport.ts`、A `server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts` (new)、M `server/modules/oauth/oauth-provider.service.ts`；与 Touches 对齐（`mcp-gateway.loopback.ts` 仅 (iii) 变异目标、delta 不含；`tasks/…` 由 ABI `task_write` 落 develop，不在本分支 delta）。