---
id: gap-ac264-oauth-dcr-policy-and-manual-clients
title: AC-264 客户端注册策略：MCP_DCR off/allowlist/open 门住 /oauth/register，回调主机与 https
  安全校验，注册与手工创建的密钥只返回一次且只存哈希；判据 server/modules/oauth/tests/oauth-dcr.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac258-oauth-store-hash-and-revoke-cascade
  - gap-ac262-oauth-metadata-endpoints
goal_ac: AC-264
---
## Proposal

AC-264（GOAL-021 退出条件 5「客户端注册」；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §148–§156「路由与挂载顺序」、§406–§417「OAuth 流程 / 加固」、§485「OAuth 客户端（高级）」、§497「配置」）要求客户端注册策略就位：`MCP_DCR=off|allowlist|open`（默认 `off`）；`off` 时 `/oauth/register` 不可用且元数据不含 `registration_endpoint`；`allowlist` 时**每一个** `redirect_uris` 的主机都必须在 `MCP_ALLOWED_REDIRECT_HOSTS` 内，任一不在即 `invalid_redirect_uri`；`open` 时接受，但回调只能是 https 或 `localhost`/`127.0.0.1` 的 http，其他 http 被拒；注册返回的 `client_secret` **只出现在这一次响应里**、库里只有 SHA-256 哈希；经设置接口手工创建客户端同样只返回一次密钥、需要已登录用户。判据文件 `server/modules/oauth/tests/oauth-dcr.test.ts` 当前不存在，存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-dcr.test.ts`（已实测）。

现状（红态基线）：

- `grep -rn "MCP_DCR\|MCP_ALLOWED_REDIRECT_HOSTS\|oauth/register\|invalid_redirect_uri" server/ --include=*.ts` 为空——没有任何注册策略、注册端点或配置读取点。
- `server/modules/oauth/` 现有 `access-tokens.service.ts`、`token-info.routes.ts`、`index.ts`，**没有** dcr/clients 文件；`oauth_clients` 表与其仓储由 AC-258 建（本任务的前置）。
- `MCP_DCR` 的唯一读取点由 AC-262 在 `server/modules/mcp-gateway/oauth-metadata.gate.ts` 落成（`readMcpDcrMode`，fail-closed 默认 `off`），经 `server/modules/mcp-gateway/index.ts` barrel 导出；AC-262 明说「AC-264 落地时经 barrel 复用它，不重写第二份」。

**真实前置**（frontmatter `depends_on` 已声明）：

- `gap-ac258-oauth-store-hash-and-revoke-cascade`（存储，todo）交 `server/modules/oauth/oauth-store.service.ts` 的 `createOAuthStore({ now })`，其 `registerClient({ clientName, redirectUris, metadata, createdVia, publicClient }) → { clientId, clientSecret }` 生成 `client_id` 与（机密客户端才有的）`client_secret` 明文，**只**把 `sha256Hex(secret)` 落库并返回明文一次（`publicClient` 时 `client_secret_hash` 为 NULL）；并交 `oauthClientsDb`（`findById`/`insert`/`allRows`，经 database barrel 导出）。
- `gap-ac262-oauth-metadata-endpoints`（元数据与挂载，todo）交 `readMcpDcrMode(env): 'off'|'allowlist'|'open'`（未设/无法识别 → `'off'`）、`buildAuthorizationServerMetadata({ baseUrl, dcrMode })`（`dcrMode==='off'` 时**无** `registration_endpoint`）与 `mountOAuthMetadata(app): { mounted, reason }`，均经 `server/modules/mcp-gateway/index.ts` barrel 导出。

本任务只做注册策略与注册/手工客户端端点，不重写存储（AC-258）、不做授权服务器语义（AC-259）、授权页（AC-260/261）、元数据本体（AC-262）、`/mcp` 认证（AC-263）、设置列表/吊销/禁用（AC-265）、浏览器 UI（AC-266）、文案（AC-267）、端到端（AC-268）。

要交付：

1. **DCR 策略（新文件 `server/modules/oauth/oauth-dcr.policy.ts`；遵守 `$backend-module-standards`）**：
   - `readMcpAllowedRedirectHosts(env: NodeJS.ProcessEnv = process.env): string[]`——读 `MCP_ALLOWED_REDIRECT_HOSTS`，按逗号分隔，逐项 trim、转小写、去空、去重；未设/空 → `[]`。**不做缓存**（判据在同一进程读多态）。
   - `validateRedirectUris({ dcrMode, allowedHosts, redirectUris }): { ok: true } | { ok: false, error: 'invalid_redirect_uri'; reason: string }`（纯函数）：
     1. 每个 uri 必须能被 `new URL` 解析为绝对 URL，否则拒绝；
     2. **scheme 安全（所有模式）**：每个 uri 必须是 `https:`，或 `http:` 且 hostname 逐字为 `localhost` 或 `127.0.0.1`；否则拒绝（(c) 的读数）；
     3. `dcrMode === 'allowlist'` 时，**逐项**检查每个 uri 的 hostname（小写比较）都在 `allowedHosts` 内，任一不在 → 拒绝（(b) 的读数；不是只看第一个）；
     4. `dcrMode === 'off'` → 拒绝（fail-closed；端点本就不挂）。
   - `error` 恒为 `invalid_redirect_uri`（RFC 7591 注册错误码），`reason` 逐字含违规 uri 与原因，供判据逐字记录。

2. **客户端服务与 clientsStore 适配器（新文件 `server/modules/oauth/oauth-clients.service.ts`）**：
   - `createOAuthRegisteredClientsStore({ store, dcrMode, allowedHosts }): OAuthRegisteredClientsStore`（实现 SDK `@modelcontextprotocol/sdk/server/auth/clients.js` 的接口）：
     - `registerClient(clientInfo)`：先 `validateRedirectUris({ dcrMode, allowedHosts, redirectUris: clientInfo.redirect_uris })`；不通过 → **throw** `new CustomOAuthError('invalid_redirect_uri', reason)`（SDK `server/auth/errors.js`；注册 handler 捕获 `OAuthError` → 400 + `{ error:'invalid_redirect_uri', error_description }`）。通过 → 调 `store.registerClient({ clientName: clientInfo.client_name, redirectUris: clientInfo.redirect_uris, metadata: clientInfo, createdVia: 'dcr', publicClient: clientInfo.token_endpoint_auth_method === 'none' })`，把 store **生成的** `clientId`/`clientSecret`（明文，仅此一次）覆盖回返回对象（`{ ...clientInfo, client_id: clientId, client_secret: clientSecret ?? undefined }`）交还 handler 写进 201 响应；库里只有 hash（由 store 保证）。
     - `getClient(clientId)`：经 `@/modules/database/index.js` barrel 的 `oauthClientsDb.findById` 读回，`disabled_at` 非空 → `undefined`，`redirect_uris` JSON 解析后映射为 `OAuthClientInformationFull`。供后续 `mcpAuthRouter` 复用。
   - `createOAuthClientsService({ store }): { createManualClient({ clientName, redirectUris }) → { ok: true; clientId; clientSecret } | { ok: false; error: 'invalid_redirect_uri'; reason } }`：手工创建走与 `open` 相同的 scheme 安全校验（人类操作，不受 `MCP_DCR` 档位门住），违规 → `{ ok:false, error:'invalid_redirect_uri', reason }`；通过 → `store.registerClient({ clientName, redirectUris, metadata: {...}, createdVia: 'manual', publicClient: false })`。

3. **路由（新文件 `server/modules/oauth/oauth-clients.routes.ts`；保持路由薄）**：
   - `mountOAuthRegister(app: Express, deps: { store; dcrMode: 'off'|'allowlist'|'open'; allowedHosts: string[] }): { mounted: boolean; reason: string }`：`dcrMode === 'off'` → **什么都不挂**（`/oauth/register` 落 404），返回 `{ mounted:false, reason }`；否则 `app.use('/oauth/register', clientRegistrationHandler({ clientsStore: createOAuthRegisteredClientsStore({ store, dcrMode, allowedHosts }) }))`（SDK `server/auth/handlers/register.js`），返回 `{ mounted:true, reason }`。组合根负责把它挂在静态资源中间件**之前**。
   - `createOAuthClientsRouter({ store }): Router`：`POST /`（挂在 `/api/oauth/clients`）——解析 body `{ client_name, redirect_uris }`，调 `createManualClient`；`invalid_redirect_uri` → 400 `{ error:'invalid_redirect_uri', error_description }`；成功 → 201 `{ client_id, client_secret }`（明文仅此一次）；缺参数 → 400 `invalid_redirect_uri`。认证中间件由组合根 `authenticateToken` 施加，路由自身不实现认证。

4. **组合根接线（`server/index.ts`）**：
   - 在 `mountMcpGateway(app)`（当前第 445 行）之后、`createStaticAssetsMiddleware`（当前第 458 行）**之前**：`const oauthMetadata = mountOAuthMetadata(app);`（AC-262 已接），随后 `if (oauthMetadata.mounted) { mountOAuthRegister(app, { store, dcrMode: readMcpDcrMode(), allowedHosts: readMcpAllowedRedirectHosts() }); }`——用 AC-262 返回的 `mounted` 读数判定 OAuth 是否开启，**不新增 `MCP_OAUTH_ENABLED` 读取点**（守住 AC-242 的唯一读取点不变量）；`readMcpDcrMode` 从 `@/modules/mcp-gateway/index.js` 导入，`readMcpAllowedRedirectHosts` 从 `@/modules/oauth/index.js` 导入。
   - `app.use('/api/oauth/clients', authenticateToken, createOAuthClientsRouter({ store }))`，放在既有 `/api/oauth/token-info` 同区域，认证与既有设置路由一致。
   - `store = createOAuthStore()`（AC-258）在进程内建一次，传给注册与手工两条路径。

5. **barrel（`server/modules/oauth/index.ts`）**：新增导出 `readMcpAllowedRedirectHosts`、`validateRedirectUris`、`createOAuthRegisteredClientsStore`、`createOAuthClientsService`、`mountOAuthRegister`、`createOAuthClientsRouter` 与所需类型（消费者：`server/index.ts` 与判据），各自在定义处写消费方注释；不导出无消费者符号。

6. **判据文件 `server/modules/oauth/tests/oauth-dcr.test.ts`（红先行；真实 better-sqlite3 临时库 + 真 express 4 + 真实 HTTP `listen(0)`——`listen(0)` 会抽到 undici 拒绝的固定端口，见 AC-240 同款说明；形制照 `server/modules/oauth/tests/oauth-store.test.ts`）**。读数各自独立成断言并逐字写出原始状态码/响应体/哈希：
   - (a) **off 不注册、元数据不广告**：`mountOAuthRegister(express(), { store, dcrMode:'off', allowedHosts:[] })` → `{ mounted:false }`，对 `/oauth/register` POST → **404**；`buildAuthorizationServerMetadata({ baseUrl:'https://mcp.example.test', dcrMode:'off' })`（从 `@/modules/mcp-gateway/index.js` 导入）→ `'registration_endpoint' in body === false`；正例对照：`dcrMode:'open'` → `mounted:true` 且注册 201，`dcrMode:'allowlist'`/`'open'` 的元数据含 `registration_endpoint === 'https://mcp.example.test/oauth/register'`。逐字写出四组读数。
   - (b) **allowlist 逐项检查主机**：`allowedHosts:['app.example']`；POST `redirect_uris:['https://app.example/cb','https://evil.example/cb']`（**第二个**越界）→ 400 且 body `error === 'invalid_redirect_uri'`，`oauthClientsDb.allRows()` 行数不增（正例对照：全在 allowlist 的 `['https://app.example/cb']` → 201）；再 POST `['https://evil.example/cb','https://app.example/cb']`（第一个越界）→ 400。逐字写出两反例的状态码/`error` 与正例 201。
   - (c) **open 的 https/localhost 安全**：`dcrMode:'open'`；`['https://app.example/cb']` → 201；`['http://localhost:5173/cb']` → 201；`['http://127.0.0.1:5173/cb']` → 201；`['http://evil.example/cb']` → 400 `invalid_redirect_uri`。逐字写出四个状态码与 `error`。
   - (d) **密钥只出现一次、库里只有哈希**：open 模式成功注册一个机密客户端，记响应 `client_secret`；`closeConnection()` 后读 `oauth.db` 及其 `-wal`/`-shm` 兄弟文件的原始字节，断言明文 `client_secret` **不出现**；`oauthClientsDb.findById(client_id).client_secret_hash` 逐字等于 `sha256Hex(client_secret)` 且不等于明文（正例对照：该哈希**出现**在库中）；再次注册得到**不同**的 `client_secret`。逐字写出明文扫描结果、hash 读数、两次 secret 不相等。
   - (e) **手工创建需登录且密钥只一次**：`app.use('/api/oauth/clients', authenticateToken, createOAuthClientsRouter({ store }))`；不带 token POST → **401**（正例对照：带有效 token（复用既有 `authenticateToken` 的签发缝/测试夹具，形制照 `server/modules/oauth/tests/token-info.routes.test.ts`）→ 201 `{ client_id, client_secret }`）；读库断言 `client_secret_hash === sha256Hex(secret)` 且明文不出现，无 token 的请求**不**在库中建行。逐字写出 401/201 与 hash 读数。
   - (f) **不回归**：`server/modules/oauth/tests/oauth-store.test.ts` 不改一字仍逐字通过；`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；生产代码（`server/` 去掉 `/tests/`）中 `MCP_OAUTH_ENABLED` 字面量计数仍为 **1**（正例对照：放宽到含 tests 命中 ≥2）。

7. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) `off` 时仍可注册（`mountOAuthRegister` 忽略 `dcrMode==='off'`，无条件挂载）⇒ (a) 必须红；
   (ii) allowlist 只检查第一个回调（把 `validateRedirectUris` 的逐项检查改成只看 `redirectUris[0]`）⇒ (b) 必须红；
   (iii) 密钥明文入库（适配器绕过 `store.registerClient`，改 `oauthClientsDb.insert({ clientSecretHash: <明文 secret> })`）⇒ (d) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: AC-264" tasks/` 为空，本仓库无任何任务带 AC-264；`grep -rlE "MCP_DCR|oauth/register|MCP_ALLOWED_REDIRECT_HOSTS|registerClient|DCR" tasks/` 只命中 AC-258/259/260/261/262 的越界声明句（各自明确把「客户端注册策略 / DCR 三档 / 手工客户端」让给 AC-264；AC-262 只**读** `MCP_DCR` 决定是否发布 `registration_endpoint`，不实现注册端点，并注明 AC-264 落地时经 barrel 复用其 `readMcpDcrMode`）。AC-258（存储/哈希）、AC-259（授权服务器语义）、AC-260/261（授权页/限速）、AC-262（元数据与挂载）、AC-263（`/mcp` 认证）、AC-265+（设置列表/吊销/禁用、浏览器、文案）、AC-268（端到端）是不同机制与不同判据文件。AC-258 与 AC-262 是**机械前置**（frontmatter `depends_on` 已声明）：本任务复用其 `createOAuthStore.registerClient`（哈希与一次性明文）与 `readMcpDcrMode`/`buildAuthorizationServerMetadata`。AC-264 判据自足：临时 `DATABASE_PATH` + 真 express + 真 HTTP，不取用任何真实 provider/token 端点。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-264 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-dcr.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/oauth/tests/oauth-dcr.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-dcr.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) off 不注册且元数据不广告：`mountOAuthRegister({dcrMode:'off'})` → `{mounted:false}` 且 POST `/oauth/register` 404；`buildAuthorizationServerMetadata({dcrMode:'off'})` 的 `'registration_endpoint' in body === false`；正例对照 open/allowlist 有该键且注册 201；逐字写出四组读数。
- [x] AC4 (b) allowlist 逐项检查：第二个回调越界 → 400 `invalid_redirect_uri` 且库中无新增行；第一个越界同样 400；全在 allowlist → 201；逐字写出两反例与正例。
- [x] AC5 (c) open 的 https/localhost 安全：https、`http://localhost`、`http://127.0.0.1` → 201；其他 http → 400 `invalid_redirect_uri`；逐字写出四个状态码与 error。
- [x] AC6 (d) 密钥只出现一次、库里只有哈希：响应明文 `client_secret` 在库及其 WAL/SHM 字节中不出现，`client_secret_hash` 逐字等于 `sha256Hex(secret)` 且不等于明文；两次注册的 secret 不同；逐字写出扫描结果与 hash 读数。
- [x] AC7 (e) 手工创建需登录且密钥只一次：无 token → 401 且库无行；有效 token → 201 `{client_id, client_secret}` 且库中只有 hash；逐字写出。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) off 仍可注册 ⇒ AC3 红；(ii) allowlist 只看首个回调 ⇒ AC4 红；(iii) 密钥明文入库 ⇒ AC6 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`oauth-store.test.ts` 不改一字仍逐字通过；生产代码中 `MCP_OAUTH_ENABLED` 字面量计数=1（正例对照含 tests ≥2）。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- `/oauth/register` **真的**在真 express 4 应用上随 `MCP_DCR` 通断：off 时该路径 404、元数据无 `registration_endpoint`；allowlist/open 时经真实 HTTP POST 真返回 201。
- allowlist **真的**逐项检查每一个回调主机：任一越界（不论第几个）真返回 400 `invalid_redirect_uri`，且库中真无该次注册的行。
- open **真的**只放行 https 或 localhost/127.0.0.1 的 http：其他 http 真被 400 拒绝。
- 密钥**真的**只在注册/创建响应里出现一次、库里只有 SHA-256：真读库字节与哈希列验证，不是「函数返回了 secret」或「表存在」就算数。
- 手工创建**真的**需要已登录用户（无 token 401 且不建行），且同样只返回一次密钥、只存哈希。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号、类型/工具就近定义）与 AGENTS.md；不引入新依赖（复用既有 SDK 与 node 内置）；不越界实现 AC-258–AC-263、AC-265–AC-270。

## Touches

- server/modules/oauth/oauth-dcr.policy.ts (new)
- server/modules/oauth/oauth-clients.service.ts (new)
- server/modules/oauth/oauth-clients.routes.ts (new)
- server/modules/oauth/index.ts
- server/index.ts
- server/modules/mcp-gateway/index.ts
- server/modules/oauth/tests/oauth-dcr.test.ts (new)（判据）
- tasks/gap-ac264-oauth-dcr-policy-and-manual-clients.md

## Notes

- `readMcpDcrMode`/`buildAuthorizationServerMetadata`/`mountOAuthMetadata` 属 AC-262（`depends_on`），经 `@/modules/mcp-gateway/index.js` 复用；**oauth 模块自身不 import mcp-gateway**——`dcrMode`/`allowedHosts` 由组合根 `server/index.ts`（或判据直接）注入，避免与 AC-241 的 mcp-gateway→oauth 形成 barrel 环（AC-262 的放置理由已点名此环）。若 AC-262 实际未导出某符号，按实际导出名调整并更新本任务 `## Touches` 与正文。
- 复用 AC-258 的 `createOAuthStore.registerClient`（生成 id/secret、只落 hash、返回明文一次）与 `oauthClientsDb`（经 database barrel）；不重写哈希与表。若 AC-258 实际签名与此不符，按实际写点更新正文与判据。
- 注册端点用 SDK `clientRegistrationHandler` + `CustomOAuthError('invalid_redirect_uri', …)`（SDK 无内建 `invalid_redirect_uri` 错误类，须自定义错误码；handler 对 `OAuthError` 统一 400 + `{error,error_description}`）；`getClient` 供后续 `mcpAuthRouter` 复用。若 SDK 版本的错误映射与该判据不符，改用薄路由自实现 `/oauth/register`（同样返回 `{error:'invalid_redirect_uri'}`），(a)–(e) 的读数不变。
- 手工创建路由只做 `POST`（创建）；列表/吊销/禁用属 AC-265（`server/modules/oauth/tests/oauth-settings.routes.test.ts`），浏览器 UI 属 AC-266，文案属 AC-267，端到端属 AC-268。确认路由路径与 AC-265 不冲突（本任务占 `/api/oauth/clients` 的 POST）。
- 判据是本任务的机械读数，文件即 AC-264 `criterion:` 所点名的那个；不新建第二个判据文件。
- 若实现中发现 AC-258/AC-262 的落点/导出名与本任务假设不符，按实际写点更新本任务 `## Touches` 与正文。

## 完成记录

实现与判据全部落地，AC1–AC10 逐条达成。

- AC1 红态基线：改动前运行 AC-264 命令，存在性闸退出码 1，逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-dcr.test.ts`。
- AC2 判据绿：`for f in server/modules/oauth/tests/oauth-dcr.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-dcr.test.ts` 退出 0；读数 `# tests 7` / `# pass 7` / `# fail 0`。
- AC3 (a)：`mountOAuthRegister({dcrMode:'off'})` → `{mounted:false, reason:"MCP_DCR is off"}`，`POST /oauth/register` → 404；`buildAuthorizationServerMetadata({baseUrl:'https://mcp.example.test', dcrMode:'off'})` → `'registration_endpoint' in body === false`；allowlist/open 元数据 `registration_endpoint === "https://mcp.example.test/oauth/register"`；正例对照 open `{mounted:true}` 且注册 → 201（`client_id="668abea2c932ce2fff0ac9ffa04d1406"`）。
- AC4 (b)：`allowedHosts:['app.example']`；`['https://app.example/cb','https://evil.example/cb']` → 400 `error="invalid_redirect_uri"` `description="https://evil.example/cb host evil.example is not in MCP_ALLOWED_REDIRECT_HOSTS"`；`['https://evil.example/cb','https://app.example/cb']` → 400 同码；全在 allowlist → 201；行数 `before=0 afterRejects=0 afterAllowed=1`。
- AC5 (c)：`https://app.example/cb` → 201；`http://localhost:5173/cb` → 201；`http://127.0.0.1:5173/cb` → 201；`http://evil.example/cb` → 400 `error="invalid_redirect_uri"`。
- AC6 (d)：open 注册机密客户端，响应 `client_secret` 长 64；`client_secret_hash === sha256Hex(secret) === 9727173a80898d334d6d718d549556b77211e4734aaf3dcfd5530a4ca0e9d430` 且 `!== 明文`；两次注册 `first_secret === second_secret ? false`；`closeConnection()` 后扫描库及其 WAL/SHM 字节 `plaintext_hits={"first":0,"second":0} hash_hits=1`（哈希作为正例对照出现）。
- AC7 (e)：`app.use('/api/oauth/clients', authenticateToken, createOAuthClientsRouter({store}))`；无 token POST → 401（`body={"error":"Access denied. No token provided.","code":"AUTH_TOKEN_INVALID"}`）且行数 0；有效 token → 201 `{client_id, client_secret}`（secret 长 64），`created_via='manual'`，`client_secret_hash === sha256Hex(secret)` 且明文不出现（`plaintext_hits=0 hash_hits=1`）；非 localhost 的 http → 400 `invalid_redirect_uri`。
- AC8 取假形态三条先红后恢复（先提交实现 `0157c130` 再变异）：
  - (i) `off` 仍可注册（注释掉 `mountOAuthRegister` 的 off 短路）⇒ (a) 红：`AssertionError [ERR_ASSERTION]: off must not mount: {"mounted":true,"reason":"MCP_DCR=off"}`；恢复 `git checkout -- server/modules/oauth/oauth-clients.routes.ts`，重跑 7/7 绿。
  - (ii) allowlist 只看首个回调（`for (const uri of redirectUris.slice(0, 1))`）⇒ (b) 红：`a later out-of-list host must 400, got 201`（(f) 亦红：`the three rejection branches must not accept`）；恢复 `git checkout -- server/modules/oauth/oauth-dcr.policy.ts`，重跑 7/7 绿。
  - (iii) 密钥明文入库（适配器绕过 `store.registerClient`，`oauthClientsDb.insert({ clientSecretHash: <明文> })`）⇒ (d) 红：`AssertionError [ERR_ASSERTION]: the stored column must be the secret’s SHA-256`；恢复 `git checkout -- server/modules/oauth/oauth-clients.service.ts`，重跑 7/7 绿。
- AC9 不回归：`npm run typecheck` 退出 0；`npm run lint` 中 `: error ` 计数 0（208 条 warning 为既有）；`server/modules/oauth/tests/oauth-store.test.ts` 不改一字，`# tests 5` / `# pass 5` / `# fail 0`；生产代码（`server/` 去 `/tests/`）`MCP_OAUTH_ENABLED` 字面量计数 1（正例对照含 tests 为 36）。
- AC10 `git diff --stat develop...HEAD` 实际改动 7 文件，与 `## Touches` 逐条对齐（含本任务新增的 mcp-gateway barrel 导出一行）：`server/index.ts`、`server/modules/mcp-gateway/index.ts`、`server/modules/oauth/index.ts`、`server/modules/oauth/oauth-clients.routes.ts (new)`、`server/modules/oauth/oauth-clients.service.ts (new)`、`server/modules/oauth/oauth-dcr.policy.ts (new)`、`server/modules/oauth/tests/oauth-dcr.test.ts (new)`。

实现期偏离与理由（均按 Notes「按实际写点更新 ## Touches 与正文」处理）：

- AC-262 的 barrel 未导出 `buildAuthorizationServerMetadata`，而 AC3 要求判据经 `@/modules/mcp-gateway/index.js` 读它；故新增该 barrel 导出并把 `server/modules/mcp-gateway/index.ts` 列入 `## Touches`。
- oauth 模块不 import mcp-gateway（避免与 AC-241 的 mcp-gateway→oauth 形成 barrel 环），故 DCR 档位类型在 `oauth-dcr.policy.ts` 就地声明为 `OAuthDcrMode`，与 mcp-gateway 的 `McpDcrMode` 结构相同，由组合根注入的读值结构匹配。
- SDK `clientRegistrationHandler` 默认会预生成一个一次性 `client_id`/`client_secret`；适配器把这两个丢弃值从落库 metadata 中剔除，确保库里只有哈希（否则 handler 的明文秘钥会随 metadata 入库，违背「库里只有 SHA-256」的 DoD）。
- 判据另含 (f)(g) 两条强化读数：直接驱动 `validateRedirectUris`/两个工厂缝，并校验 OAuth 开关生产读取点仍为 1（与 AC-262 (f) 同口径）。
