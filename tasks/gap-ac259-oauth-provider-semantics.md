---
id: gap-ac259-oauth-provider-semantics
title: AC-259 OAuth 授权服务器语义：PKCE 强制 S256、授权码一次性且 60 秒过期、refresh
  轮换与复用吊销整条授权、受众匹配、redirect_uri 精确匹配与机密客户端密钥、有效期可配置；判据
  server/modules/oauth/tests/oauth-provider.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac258-oauth-store-hash-and-revoke-cascade
goal_ac: AC-259
---
## Proposal

GOAL-021 退出条件 2（AC-259）要求 OAuth 授权服务器**语义**就位：PKCE 强制 S256、授权码一次性且 60 秒过期、refresh 每用一次即轮换且旧 refresh 复用会吊销整条授权、受众绑定（RFC 8707 `resource`）、`redirect_uri` 精确匹配、机密客户端密钥校验、access/refresh 有效期可配置。出处：SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §303–§335「令牌种类 / Scope」、§403–§423「OAuth 流程 / 加固」、§490–§503 配置表。AC-258（本任务的存储前置，`depends_on`）交三张表 + 仓储 + `server/modules/oauth/oauth-store.service.ts` 的 `createOAuthStore({ now })`（`registerClient` / `createGrant` / `issueAuthorizationCode` / `issueOAuthToken` / `verifyOAuthToken` / `revokeGrant` / `disableClient`，只存 SHA-256、吊销级联）。本任务只做语义层，不做端点挂载（AC-262/263）、授权页（AC-260/261）、DCR（AC-264）、设置接口（AC-265+）、端到端（AC-268）。

红态基线：判据文件 `server/modules/oauth/tests/oauth-provider.test.ts` 不存在，AC-259 的存在性闸以退出码 1 逐字输出缺失文件名（已实测）；`server/modules/oauth/` 下无 `oauth-provider.service.ts`，全仓无 `createOAuthProvider`。

要交付：

1. **授权码→授权映射与消费台账（`server/modules/database/schema.ts` + `server/modules/database/migrations.ts` + 新仓储 `server/modules/database/repositories/oauth-code-redemptions.db.ts` + `server/modules/database/index.ts` barrel）**。
   设计决定（记录理由）：SPEC 的 `oauth_authorization_codes` 表由 AC-258 逐字建表，其判据断言列名**逐字等于 SPEC DDL**，该表**没有** `grant_id`；而 AC-259 (b) 要求「复用授权码 → 吊销该码已签发的令牌」，需要一个持久的 code→grant 映射。**不**给 codes 表加列（会打破 AC-258 的列名判据），改为新增台账表（逐字 SQL）：`CREATE TABLE IF NOT EXISTS oauth_code_redemptions (code_hash TEXT PRIMARY KEY, grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE, redeemed_at DATETIME)`。authorize 时连同 codes 行一起写入（`redeemed_at` 为 NULL），exchange 成功时置 `redeemed_at`；重放时 codes 行已被删但台账行仍在，据此拿到 `grant_id` 吊销整条授权。仓储 `oauthCodeRedemptionsDb.insert({ codeHash, grantId }): void`、`findByHash(codeHash): { code_hash; grant_id; redeemed_at } | undefined`、`markRedeemed(codeHash, redeemedAt): boolean`（`UPDATE ... SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL`）。在 `runMigrations` 里以 `CREATE TABLE IF NOT EXISTS` 建表（幂等；不回归 AC-258 的三表/列名判据——其判据断言表名**含**三表、列名逐字等于 SPEC，故额外台账表不使之红）。
2. **语义服务（新文件 `server/modules/oauth/oauth-provider.service.ts`；经 `server/modules/oauth/index.ts` barrel 导出、带消费方注释；遵守 `$backend-module-standards`）**：`createOAuthProvider({ store, now, publicBaseUrl, accessTokenTtlSeconds?, refreshTokenTtlDays?, authorizationCodeTtlSeconds? })`。`now` 可注入（判据推进时钟）；`publicBaseUrl` 决定默认受众 `${publicBaseUrl}/mcp`；`accessTokenTtlSeconds` 默认取 `Number(process.env.MCP_ACCESS_TOKEN_TTL_SEC ?? 3600)`、`refreshTokenTtlDays` 默认取 `Number(process.env.MCP_REFRESH_TOKEN_TTL_DAYS ?? 30)`、授权码有效期固定 60 秒（SPEC 表为常量）。`store` 由调用方传入（判据用同一 `now` 建 store 与 provider，时钟一致）。返回以下方法，错误码用稳定串 `invalid_request` / `invalid_client` / `invalid_grant` / `invalid_scope` / `invalid_target` / `unauthorized_client`：
   - `authorize({ clientId, redirectUri, codeChallenge, codeChallengeMethod, scopes, resource, userId })` → `{ ok: true, code, grantId } | { ok: false, error }`。校验顺序：客户端存在且未禁用（否则 `unauthorized_client`）；`codeChallengeMethod` 必须逐字 `S256` 且 `codeChallenge` 为非空串（缺 challenge、method 为 `plain`、method 非 S256 → `invalid_request`）；`redirectUri` 必须与注册的 `redirect_uris` JSON 数组某项**逐字相等**（前缀/后缀/大小写/多一个查询参数均拒 → `invalid_request`）；`resource` 缺省取默认受众，给出但与默认受众不逐字相等 → `invalid_target`。成功：`store.createGrant({ userId, clientId, scopes, resource })` → `store.issueAuthorizationCode({ clientId, userId, redirectUri, codeChallenge, scopes, resource })`（其内部置 `expires_at = now + 60 秒`）→ `oauthCodeRedemptionsDb.insert({ codeHash: sha256Hex(code), grantId })`。
   - `exchangeAuthorizationCode({ code, clientId, clientSecret, redirectUri, codeVerifier, resource })` → `{ ok: true, accessToken, refreshToken, expiresIn } | { ok: false, error }`。事务内：`sha256Hex(code)` 查 codes 行——无行但台账有该 hash 且 `redeemed_at` 非空 → **复用**，`store.revokeGrant(grant_id)` 后 `invalid_grant`；无行且台账无行 → `invalid_grant`；有行但 `expires_at <= now` → `invalid_grant`（并删码）；`redirectUri` 与 codes 行不逐字相等 → `invalid_request`；机密客户端（注册行 `client_secret_hash` 非 NULL）且 `client_secret` 的 SHA-256 与注册值不符 → `invalid_client`；PKCE：`base64url(sha256(codeVerifier))` 与 codes 行 `code_challenge` 不逐字相等 → `invalid_grant`；`resource` 若给出须与 codes 行 `resource` 逐字相等否则 `invalid_target`。成功：删 codes 行、`oauthCodeRedemptionsDb.markRedeemed`、`store.issueOAuthToken` 签 access（`kind:'oauth_access'`，`expiresAt = now + accessTokenTtlSeconds`）与 refresh（`kind:'oauth_refresh'`，`expiresAt = now + refreshTokenTtlDays 天`），两者均带同一 `grant_id` 与受众。
   - `exchangeRefreshToken({ refreshToken, clientId, clientSecret, scopes?, resource? })` → 同上形状。事务内：`store.verifyOAuthToken(refreshToken, 'oauth_refresh')` 取 `grantId`（`not_found`/`revoked`/`expired` 各自映射为对应错误）；若该 refresh 行 `revoked_at` 非空（已被轮换或吊销）→ **复用**，`store.revokeGrant(grantId)` 后 `invalid_grant`；秘密校验同上；`resource` 若给出须与 grant 的 `resource` 逐字相等否则 `invalid_target`；`scopes` 若给出须是 grant `scopes` 的子集（**缩小允许**），超出 → `invalid_scope`，缺省继承该 refresh 行的 scopes。成功：置旧 refresh 行 `revoked_at = now`（轮换，旧 refresh 立即失效），签新 access + 新 refresh（同一 `grant_id`、结果 scopes）。
   - `verifyAccessToken(token, { resource })` → `{ ok: true, userId, scopes, grantId, expiresAt } | { ok: false, reason }`。委托 `store.verifyOAuthToken(token, 'oauth_access')`，并要求行 `resource` 逐字等于给定 `resource`（默认 `${publicBaseUrl}/mcp`），不相等 → `invalid_target`——`/mcp` 的受众闸消费此判定（AC-263 接线，本任务只提供判定）。
   越界不做：端点与挂载、授权页、DCR、手工客户端接口、设置接口、审计、scope 词汇表校验（AC-243）——本任务只做语义。
3. **判据文件 `server/modules/oauth/tests/oauth-provider.test.ts`（红先行；真实 better-sqlite3 临时库，形制照 `server/modules/oauth/tests/oauth-store.test.ts` 与 `server/modules/database/tests/api-keys-drop-migration.test.ts`）**：`mkdtemp` 建临时目录、`closeConnection()`、`process.env.DATABASE_PATH` 指向临时 `oauth-provider.db`、`initializeDatabase()`、插 owner 用户行；用一个可变的 `let nowMs` 与 `now = () => new Date(nowMs)` 建 `createOAuthStore({ now })` 与 `createOAuthProvider({ store, now, publicBaseUrl: 'https://cli.example' })`；`publicBaseUrl + '/mcp'` = `https://cli.example/mcp`。读数各自独立成断言并逐字写出原始值：
   - (a) **PKCE**：注册一个机密客户端与一条授权；`authorize` 三反例——缺 `codeChallenge` → `invalid_request`、`codeChallengeMethod:'plain'` → `invalid_request`、正确 S256 但 `exchangeAuthorizationCode` 传入不匹配 `codeVerifier` → `invalid_grant`；正例——正确 S256 + 正确 verifier → 换出 access。逐字写出四组 `{ok,error}`/`{ok:false,error}` 与正例的 token 前缀。
   - (b) **授权码一次性、60 秒、复用吊销**：正常换一次得 access+refresh；立即用同一 code 再换 → `invalid_grant`，且**首次换出的 access 与 refresh 下一次校验均被拒**（`store.verifyOAuthToken` 返回 `revoked`，读回 `access_tokens.revoked_at` 非空）——证明复用吊销了该码已签发的令牌；另起一条授权码，`nowMs += 61_000` 后换 → `invalid_grant`；`nowMs += 59_000`（未过期）换 → `ok:true`。逐字写出各次结果与两行 `revoked_at`。
   - (c) **refresh 轮换与复用**：用 refresh 换一次 → 得新 access 与新 refresh（明文与旧的都不相等）；旧 refresh 立即失效（`store.verifyOAuthToken(oldRefresh)` → `revoked`）；再次提交旧 refresh（复用）→ `invalid_grant`，且该 grant 下**全部**令牌（新 access、新 refresh）下一次校验均 `revoked`（读回 `oauth_grants.revoked_at` 非空）。正例对照：另一条 grant 的 refresh 轮换与复用互不影响。逐字写出。
   - (d) **scope 缩小/放大**：grant scopes = `['cloudcli:read','cloudcli:session:send']`；refresh 带 `['cloudcli:read']` → 新 access 的 scopes 恰为 `['cloudcli:read']`；refresh 带 `['cloudcli:read','cloudcli:session:send','cloudcli:session:control']` → `invalid_scope`。逐字写出两次结果与新 access 的 scopes。
   - (e) **受众**：`authorize` 带 `resource:'https://evil.example/mcp'` → `invalid_target`；缺省 → 成功且码/令牌 `resource` 逐字等于 `https://cli.example/mcp`；`exchangeAuthorizationCode` 带不符 `resource` → `invalid_target`；`verifyAccessToken(token, { resource:'https://other.example/mcp' })` → `invalid_target`，`resource` 相符 → `ok:true`；`mountMcpGateway(express(), { env:{ MCP_ENABLED:'true' }, authorize: <由 provider 受众闸构造的 RequestHandler> })` 后对携带 `resource` 不符令牌的 `POST /mcp` **断言 401**、对相符令牌断言非 401。逐字写出四组 verdict 与两个 HTTP 状态码。
   - (f) **redirect_uri 精确匹配与密钥**：注册 `redirect_uris:[ 'https://app.example/cb' ]`；`authorize` 用 `https://app.example/cb/`、`https://app.example/cb-x`、`https://APP.example/cb`、`https://app.example/cb?x=1` 四种变体 → 均 `invalid_request`，逐字原值 `https://app.example/cb` → `ok:true`；机密客户端 `exchangeAuthorizationCode` 传错 `clientSecret` → `invalid_client`（且不签发令牌）。逐字写出五组结果。
   - (g) **有效期**：默认 provider 下 access `expires_at - now` = 3600 秒、refresh = 30 天（逐字秒数）；`createOAuthProvider({ ..., accessTokenTtlSeconds: 120, refreshTokenTtlDays: 1 })` 下分别为 120 秒与 1 天；`nowMs` 分别推进到刚好过期与未过期处，`verifyAccessToken`/`verifyOAuthToken` 的 `expired` 边界逐字写出。
4. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 接受 `plain`（把 `codeChallengeMethod !== 'S256'` 的拒绝去掉）⇒ (a) 必须红；
   (ii) 授权码可重复使用（`exchangeAuthorizationCode` 成功时不删 codes 行/不置台账）⇒ (b) 必须红；
   (iii) 旧 refresh 轮换后仍有效（轮换时不置旧 refresh 行 `revoked_at`）⇒ (c) 必须红；
   (iv) `redirect_uri` 只比前缀（改 `===` 为 `startsWith`）⇒ (f) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: AC-259" tasks/` 为空，`grep -rln "oauth-provider\|createOAuthProvider\|code_challenge\|PKCE" tasks/` 只命中 AC-258 的越界声明句（`gap-ac258-oauth-store-hash-and-revoke-cascade`，它明确把 PKCE/授权码一次性/refresh 轮换/受众/redirect_uri 让给 AC-259），本仓库无任何任务带 AC-259 或实现同一机制。与 AC-258 是**前置关系**（存储 → 语义，`depends_on` 已声明，AC-258 落地后本任务才能红转绿）：本任务复用 AC-258 的 `createOAuthStore`，不重写表/仓储/哈希/级联，只补 code→grant 台账、语义判定与判据。AC-260+（授权页、元数据、注册、设置、端到端）是不同机制与不同判据文件。AC-259 判据自足：临时 `DATABASE_PATH` + `runMigrations` + `oauth-provider.test.ts`，`/mcp` 受众读数经既有 `mountMcpGateway` 的 `authorize` 注入缝，不改 `mcp-gateway` 任何文件。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-259 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-provider.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/oauth/tests/oauth-provider.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-provider.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) PKCE：缺 challenge → `invalid_request`、method `plain` → `invalid_request`、verifier 不匹配 → `invalid_grant`，正确 S256 → `ok:true` 换出令牌；逐字写出四组结果。
- [x] AC4 (b) 授权码：第二次使用 `invalid_grant` 且首发的 access 与 refresh 下一次校验均 `revoked`（读回 `revoked_at` 非空）；`now+60s` 被拒、`now+59s` 通过；逐字写出。
- [x] AC5 (c) refresh：用一次得新 access 与新 refresh、旧 refresh 立即失效；再次提交旧 refresh → `invalid_grant` 且该 grant 全部令牌被吊销（`oauth_grants.revoked_at` 非空）；另一 grant 不受影响；逐字写出。
- [x] AC6 (d) scope：refresh 缩小 `['cloudcli:read']` 允许且新 access scopes 恰为缩小集；放大到 grant 之外 → `invalid_scope`；逐字写出。
- [x] AC7 (e) 受众：authorize `resource` 不符 → `invalid_target`；缺省 → 签发 `resource` = `https://cli.example/mcp`；令牌 `resource` 不符时 `verifyAccessToken` → `invalid_target` 且注入该受众闸的 `mountMcpGateway` 对 `POST /mcp` 返回 401，相符令牌非 401；逐字写出。
- [x] AC8 (f) `redirect_uri` 前缀/后缀/大小写/多查询参数四种变体都 `invalid_request`、逐字原值通过；机密客户端错误 `client_secret` → `invalid_client`；逐字写出五组结果。
- [x] AC9 (g) 默认 access 3600 秒、refresh 30 天；配置 `accessTokenTtlSeconds:120` / `refreshTokenTtlDays:1` 后分别为 120 秒与 1 天，过期边界 `expired` 逐字写出。
- [x] AC10 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 接受 plain ⇒ AC3 红；(ii) 授权码可复用 ⇒ AC4 红；(iii) 旧 refresh 仍有效 ⇒ AC5 红；(iv) redirect_uri 只比前缀 ⇒ AC8 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC11 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`server/modules/oauth/tests/oauth-store.test.ts`（AC-258 判据）、`server/modules/oauth/tests/access-tokens.service.test.ts`、`server/modules/oauth/tests/token-info.routes.test.ts`、`server/modules/database/tests/api-keys-drop-migration.test.ts`、`server/modules/mcp-gateway/tests/mcp-transport.test.ts` 不改一字仍逐字通过。
- [x] AC12 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- PKCE **真的**被强制 S256：一个 method 为 `plain` 或缺 challenge 的授权请求真被拒（不是「有函数被调用」），正确 S256 真换出令牌；变异掉该拒绝后判据真变红。
- 授权码**真的**一次性且 60 秒过期，且**复用真吊销该码已签发的令牌**：对真库读回 `access_tokens.revoked_at` 非空佐证，`now+60s` 真被拒、`now+59s` 真通过——不是「第二次返回了错误码」就算数。
- refresh **真的**轮换：用一次真得到新 access 与新 refresh（明文字节不同），旧 refresh 真立即失效，复用旧 refresh 真吊销整条授权（该 grant 全部令牌 `revoked`，另一 grant 真不受影响）。
- 受众**真的**被绑定：authorize/exchange 的不符 `resource` 真被拒（`invalid_target`），缺省真以 `${PUBLIC_BASE_URL}/mcp` 签发，且注入该受众闸的 `/mcp` 对不符令牌真返回 401、对相符令牌真放行。
- `redirect_uri` **真的**逐字匹配（四种变体真被拒）、机密客户端密钥错误真被拒（`invalid_client`）；有效期默认 3600 秒 / 30 天、配置后真改变，过期边界真可判。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、DDL/仓储落 database 模块、服务落 oauth 模块、导出带消费方注释、不导出无消费者符号、≥2 处使用的工具进 `server/shared/utils.ts`）与 AGENTS.md；不引入新依赖（只用既有 better-sqlite3 与 node 内置）；不越界实现 AC-258（存储）与 AC-260+。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/oauth-code-redemptions.db.ts (new)
- server/modules/database/index.ts
- server/modules/oauth/oauth-provider.service.ts (new)
- server/modules/oauth/index.ts
- server/modules/oauth/tests/oauth-provider.test.ts (new)（判据）
- tasks/gap-ac259-oauth-provider-semantics.md

## Notes

- 时钟：判据用单一可变 `nowMs` 同时注入 store 与 provider（`now = () => new Date(nowMs)`），推进 `nowMs` 即推进两者的时间；授权码 60 秒与 token TTL 的边界均据此判定，不睡真时间。
- `oauth_code_redemptions` 台账是 SPEC 五张表之外的最小补充，只为「code→grant 的持久映射 + 消费标记」；若实现中发现可完全复用 AC-258 的 `oauthAuthorizationCodesDb` 而无需台账（例如 AC-258 的实现以别的方式暴露 code→grant），以实际写点为准调整 Touches（内存 `quay-touches-must-match-actual-write-sites`），但 (b) 的「复用时吊销该码已签发的令牌」必须在真库持久可判、跨 `closeConnection()` 仍成立。
- `resource` 与 `scopes` 的比较都是**逐字**（JSON 数组解析后字符串相等），不做前缀/大小写/子串匹配。
- 秘密比较用 `crypto.timingSafeEqual`（长度先对齐）或对两边 SHA-256 十六进制做常量时间比较，避免 `===` 短路。
- 新增测试文件可能被边界 lint 拦截（内存 `quay-boundaries-lint-blocks-new-test-files`）；判据文件已列入 `## Touches`。
- 若新增 barrel 导出使某个整体 `vi.mock('@/modules/database/index.js')` 的兄弟测试变红（内存 `adding-an-export-reds-sibling-wholesale-vimocks`），按同款修法把新导出补进那个 mock 工厂并把该测试文件加进 `## Touches`。
- `/mcp` 受众读数经既有 `mountMcpGateway` 的 `authorize` 注入缝：不修改 `server/modules/mcp-gateway/*`，只在其测试外以 provider 受众闸构造 `RequestHandler` 传入。
- 服务用 `now` 注入时钟（默认 `() => new Date()`）；`exchangeAuthorizationCode` / `exchangeRefreshToken` 的「删码/置台账/签发」与「置旧 refresh revoked/签发」分别落在同一 `db.transaction(...)` 内，使消费与签发原子。
- 判据是本任务的机械读数，文件即 AC-259 `criterion:` 所点名的那个；不新建第二个判据文件。
