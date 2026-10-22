---
id: gap-ac260-oauth-consent-page
title: AC-260 授权页由服务端渲染并抗攻击：回显字段全部转义、必须输入密码、scope 逐项勾选且只读必选、带防跨站与防嵌套的头；判据
  server/modules/oauth/tests/oauth-consent-page.test.ts
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
goal_ac: AC-260
---
## Proposal

GOAL-021 退出条件 3（AC-260）要求授权页就位：服务端渲染（不经 SPA），所有回显字段转义，必须输入密码，scope 逐项勾选且只读必选，CSRF 令牌，防嵌套与不缓存的头。出处：SPEC `docs/proposals/mcp-gateway-SPEC.md`（v3.1）§403–§423「OAuth 流程 / 加固」、§§322–§333「Scope」、§226「auth 登录校验的窄口（包住 authService.login）→ oauth 授权页」。**真实前置**（frontmatter `depends_on` 已声明）：AC-258（存储，ready）交 `oauthClientsDb.findById`（读客户端名称/回调/禁用态）与 `createOAuthStore`；AC-259（授权服务器语义，todo）交 `createOAuthProvider({ store, now, publicBaseUrl }).authorize()`（校验客户端/`redirect_uri` 逐字/PKCE 强制 S256/受众并落授权与授权码，返回 `{ ok:true, code, grantId } | { ok:false, error }`）。本任务只做授权页 GET/POST 与登录窄口导出，不做端点挂载与 https 基址判定（AC-262）、限速与真实来源（AC-261）、`/mcp` 认证（AC-263）、DCR（AC-264）、设置接口（AC-265+）、端到端（AC-268）。

红态基线（已实测）：判据文件 `server/modules/oauth/tests/oauth-consent-page.test.ts` 不存在，存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-consent-page.test.ts`；`grep -rn "createOAuthConsentRouter\|oauth-consent\|consent\|createCredentialVerifier\|verifyCredentials" server/ --include=*.ts` 为空；`grep -rl "^goal_ac: AC-260$" tasks/` 为空。

要交付：

1. **登录校验窄口（新文件 `server/modules/auth/credential-verifier.ts`；经 `server/modules/auth/index.ts` barrel 导出、带消费方注释）**：`createCredentialVerifier(authService: { login(username: unknown, password: unknown): Promise<{ user: { id: number | bigint } }> })` 返回 `verifyCredentials(username: string, password: string): Promise<{ ok: true; userId: number } | { ok: false }>`——包住 `authService.login`：成功解析为 `{ ok: true, userId: Number(user.id) }`；抛出（错误凭据，`AppError` `AUTH_INVALID_CREDENTIALS`）解析为 `{ ok: false }`，绝不把异常透出到授权页。消费方：oauth 授权页（本任务）与判据（经 barrel 导入，contract 见 (h)）。

2. **授权页路由工厂（新文件 `server/modules/oauth/oauth-consent.routes.ts`；经 `server/modules/oauth/index.ts` barrel 导出、带消费方注释；遵守 `$backend-module-standards`）**：`createOAuthConsentRouter({ provider, clients, verifyCredentials, now?, csrfStore? })` 返回 express `Router`：
   - `provider` = AC-259 的 `createOAuthProvider(...)`（只消费其 `authorize()`）；`clients` = `{ findById(clientId) => { client_id; client_name; redirect_uris; disabled_at } | undefined }`（生产传 AC-258 的 `oauthClientsDb`；判据传同一对象）；`verifyCredentials` = 上面的窄口；`now` 可注入；`csrfStore` 可注入（默认 `createCsrfTokenStore({ now })`）。
   - **GET `/authorize`**：解析 query（`client_id` / `redirect_uri` / `response_type` / `scope`（空格分隔）/ `state` / `code_challenge` / `code_challenge_method`）。客户端不存在或 `disabled_at` 非空 → `400` 错误页（无表单）。否则渲染 HTML 表单（`Content-Type: text/html; charset=utf-8`），**所有来自请求串/客户端行的回显字段逐字转义**（同文件内自写 `escapeHtml`：`& < > " '` → 实体；不引新依赖），显示：转义后的客户端名称、回调**主机**（`new URL(redirect_uri).host`，逐字转义后显示，另显示完整 `redirect_uri` 的转义文本）、请求的每个 scope（逐项一个 `<input type="checkbox" name="scope" value="<转义后的 scope>">`）：`cloudcli:read` 恒 `checked disabled`（只读必选、不可取消），其余请求的 scope 不勾选；`client_id`/`redirect_uri`/`state`/`code_challenge`/`code_challenge_method` 为隐藏字段（逐字转义）；用户名字段 `<input name="username">` 与密码字段 `<input type="password" name="password">`；隐藏 `csrf_token` 为本次渲染新签发的令牌；提交按钮与取消按钮（`name="action"`，值 `allow`/`deny`）。
   - **POST `/authorize`**：`express.urlencoded({ extended: false })`。先校验 `csrf_token`：缺失、未知、已消费或过期 → `403` 错误页（不签发授权码、不跳转）。取 `action`：`deny` → `302` 到 `redirect_uri`，带 `error=access_denied` 与原样 `state`（不签发授权码）。`allow` → `verifyCredentials(username, password)`：`{ ok:false }` 或密码为空 → `401` 错误页（含说明文字；**不**调用 `provider.authorize`、不签发授权码、不跳转）；`{ ok:true }` → 勾选的 scope = 提交的非只读 scope（只读 `disabled`，浏览器不提交）**并强制并入** `cloudcli:read`（去重、稳定顺序）；调用 `provider.authorize({ clientId, redirectUri, codeChallenge, codeChallengeMethod, scopes, resource?, userId })`；`{ ok:false, error }` → 映射为 `400` 错误页（`invalid_request`/`invalid_target`/`unauthorized_client`/`invalid_scope` 等，含说明）；`{ ok:true, code }` → `302` 到 `redirect_uri`，`code` 与原样 `state` 作为查询参数（用 `URL`/`URLSearchParams` 拼接，不改写 state 的解码值）。
   - **所有响应（GET 与 POST，含错误页与 302）设置头**：`X-Frame-Options: DENY`；`Content-Security-Policy` 含 `frame-ancestors 'none'`（实现可取最小集，如 `default-src 'none'; style-src 'unsafe-inline'; form-action <redirect_uri host>; frame-ancestors 'none'`，但 `frame-ancestors 'none'` 必须逐字出现）；`Cache-Control: no-store`。
   - **CSRF 令牌（同文件内的 `createCsrfTokenStore({ now?, ttlMs?, maxEntries? })`，不跨文件导出）**：`issue(): string` 生成 32 字节随机十六进制令牌记入 `Map`（每次调用互不相同）；`consume(token: unknown): boolean` 仅当令牌存在、未过期、未消费时删除并返回 true，否则 false；每次 issue/consume 顺带清理过期项并设上限（防无界增长）。GET 每次渲染签发一枚，POST 消费一枚。
   - 越界不做：挂载到 `server/index.ts` 与 `PUBLIC_BASE_URL` 的 https 判定（AC-262）、限速与真实来源判定（AC-261）、`/mcp` 认证（AC-263）、DCR、设置接口、审计、SPA。

3. **判据文件 `server/modules/oauth/tests/oauth-consent-page.test.ts`（红先行；真实 better-sqlite3 临时库 + 真实 express `listen(0)` + `fetch`，形制照 `server/modules/oauth/tests/token-info.routes.test.ts`）**：`mkdtemp`、`closeConnection()`、`process.env.DATABASE_PATH` 指向临时 `oauth-consent.db`、`initializeDatabase()`、插 owner 用户行（`users(id, username, password_hash)`，`password_hash` 为任意占位哈希——口令校验由注入的 `verifyCredentials` 承担）；用同一 `nowMs`/`now` 建 `createOAuthStore({ now })` 与 `createOAuthProvider({ store, now, publicBaseUrl: 'https://cli.example' })`；`store.registerClient({ clientName, redirectUris:['https://app.example/cb'], publicClient:true, ... })` 得 `clientId`；注入 `verifyCredentials = async (u,p) => u==='owner' && p==='correct-password' ? { ok:true, userId:1 } : { ok:false }`；挂 `createOAuthConsentRouter({ provider, clients: oauthClientsDb, verifyCredentials })` 于 `app` 的 `/oauth`，`listen(0)`。读数各自独立成断言并逐字 `console.log` 原始值：
   - (a) **转义**：客户端名 `<script>alert(1)</script>` GET 授权请求 → `200`、`content-type` 含 `text/html`；body **不含** raw `<script>alert(1)</script>`、**含** `&lt;script&gt;alert(1)&lt;/script&gt;`；另注册客户端名 `"><img src=x onerror=1>` 再 GET → body 不含 `<img src=x onerror=1>`、含转义形态；body 含回调主机 `app.example` 与请求的 scope 文本。逐字写出两段判定与布尔读数。
   - (b) **只读必选**：解析 body 中 `value="cloudcli:read"` 的 `<input ...>` 标签 → 含 `checked` 且含 `disabled`；`value="cloudcli:session:send"` 的标签存在且**不含** `checked`。逐字写出两个标签原文。
   - (c) **密码**：GET 取 `csrf_token`；POST 正确参数 + 错密码 → 状态**非** 302（记录实际值）、body 含错误说明、`oauth_authorization_codes` 行数不变（无授权码）；空密码同理（非 302、无码）。POST 正确密码 → `302`，`location` 以 `https://app.example/cb` 开头、含非空 `code`、`state` 经解码逐字 `xyz`（`new URL(location).searchParams.get('state') === 'xyz'` 断言原样）；`oauth_authorization_codes` 行数 +1。逐字写出各次状态码、location、state 与行数。
   - (d) **取消**：POST `action=deny`（带有效 csrf）→ `302`，`location` 以 `redirect_uri` 开头、`error` 经解码逐字 `access_denied`、无 `code`。逐字写出。
   - (e) **scope 子集且含只读**：请求 scope `cloudcli:read cloudcli:session:send cloudcli:session:control`；POST 只提交 `scope=cloudcli:session:send`（只读 disabled 不提交）+ 正确密码 → `302`；经 `getConnection()` 读回新建 `oauth_grants` 行的 `scopes` JSON，断言集合**恰为** `{cloudcli:read, cloudcli:session:send}`（含只读、不含 control）。逐字写出该 grant 的 `scopes` 原文。
   - (f) **CSRF**：GET 两枚 `csrf_token` 互不相同（每次渲染唯一）。POST 缺 `csrf_token` → 非 302 且无码；POST 带随机未知令牌 → 非 302 且无码；正例：POST 带刚 GET 的令牌 → 302；**重放**已消费的同一令牌再次 POST → 非 302 且无码。逐字写出五组状态与两个令牌原文。
   - (g) **头**：GET 响应头 `x-frame-options` 逐字 `DENY`、`content-security-policy` 含 `frame-ancestors 'none'`、`cache-control` 含 `no-store`；POST 成功 302 的响应头同样满足三条。逐字写出三个头的原始值（GET/POST 各一组）。
   - (h) **窄口 contract**：`createCredentialVerifier` 作用于假 authService——`login` 解析 `{ user: { id: 7 } }` → `verifyCredentials(...)` 得 `{ ok:true, userId:7 }`；`login` 抛出 `AppError('...', { code:'AUTH_INVALID_CREDENTIALS' })` → `{ ok:false }`。逐字写出两组结果。

4. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 不转义客户端名称（`escapeHtml` 直接返回原串）⇒ (a) 必须红；
   (ii) 密码错误仍签发授权码（`{ok:false}` 分支改为继续调 `provider.authorize` 并 302）⇒ (c) 必须红；
   (iii) 去掉 CSRF 校验（`consume` 恒 true 或跳过）⇒ (f) 必须红；
   (iv) 去掉防嵌套头（不设 `X-Frame-Options` 与 CSP `frame-ancestors`）⇒ (g) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令（`git checkout -- <file>` 或反向 patch），恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: AC-260$" tasks/` 为空；`grep -rln "consent\|授权页\|createOAuthConsentRouter\|createCredentialVerifier" tasks/` 只命中 AC-258/AC-259 的越界声明句（二者明确把授权页让给 AC-260/261），本仓库无任何任务实现同一机制。AC-258（存储）与 AC-259（语义）是**真实前置**（frontmatter `depends_on` 已声明）：本任务复用其 `createOAuthProvider.authorize` 与 `oauthClientsDb.findById`，不重写表/仓储/PKCE/受众判定。AC-261（限速与来源）、AC-262（元数据与挂载）、AC-263（/mcp 认证）、AC-264（DCR）、AC-265+（设置接口）、AC-268（端到端）是不同机制与不同判据文件。AC-260 判据自足：临时 `DATABASE_PATH` + 真实 express + 注入的 `verifyCredentials`，不取用 GOAL-020 的任何端点，不挂 `server/index.ts`。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-260 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-consent-page.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/oauth/tests/oauth-consent-page.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-consent-page.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) GET 返回 HTML 且回显客户端名称、回调主机、请求 scope；恶意客户端名两种载荷均作为文本呈现（body 无 raw 可执行形态、含转义形态）；逐字写出两段判定与布尔读数。
- [x] AC4 (b) `cloudcli:read` 的 checkbox 含 `checked` 且含 `disabled`，`cloudcli:session:send` 的 checkbox 存在且不含 `checked`；逐字写出两个标签原文。
- [x] AC5 (c) 错密码/空密码：非 302、含错误说明、无授权码（行数不变）；正确密码：302 到 `redirect_uri`、含非空 `code`、`state` 逐字原样、授权码行数 +1；逐字写出。
- [x] AC6 (d) 取消：302 到 `redirect_uri`、`error=access_denied`、无 `code`；逐字写出。
- [x] AC7 (e) 勾选少于请求时 grant 的 scope 恰为勾选集并始终含 `cloudcli:read`（读回 `oauth_grants.scopes` 原文）；逐字写出。
- [x] AC8 (f) 每次渲染令牌唯一（两枚不等）；缺令牌、未知令牌、重放已消费令牌的 POST 均被拒（非 302、无码），带有效令牌则 302；逐字写出五组状态与令牌原文。
- [x] AC9 (g) GET 与成功 POST 的响应头含 `X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`、`Cache-Control: no-store`；逐字写出原始头值。
- [x] AC10 (h) `createCredentialVerifier` 的 contract：login 成功 → `{ok:true,userId}`、login 抛错 → `{ok:false}`；逐字写出。
- [x] AC11 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 不转义 ⇒ AC3 红；(ii) 错密码仍签发 ⇒ AC5 红；(iii) 去 CSRF ⇒ AC8 红；(iv) 去防嵌套头 ⇒ AC9 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC12 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`server/modules/oauth/tests/access-tokens.service.test.ts`、`server/modules/oauth/tests/token-info.routes.test.ts`、`server/modules/oauth/tests/access-token-scopes.test.ts`、`server/modules/oauth/tests/access-tokens.routes.test.ts`、`server/modules/oauth/tests/agent-retirement.test.ts` 不改一字仍逐字通过。
- [x] AC13 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 转义**真的**生效：两种恶意客户端名在真 HTTP 响应体里都不出现可执行原始形态、且出现转义形态——不是「调了 escapeHtml」就算数；变异掉转义后 (a) 真变红。
- 密码**真的**是闸：错密码与空密码真不签发授权码（真库行数不变、真不 302），正确密码真 302 且真带非空 `code` 与原样 `state`；变异掉该闸后 (c) 真变红。
- 只读 scope **真的**必选：渲染的 checkbox 真为 `checked disabled`；勾选少于请求时真库 `oauth_grants.scopes` 恰好是勾选集 ∪ `{cloudcli:read}`——不是「读到了表单」就算数。
- CSRF **真的**挡住跨站 POST：缺令牌、未知令牌、重放已消费令牌真被拒（非 302、无码），有效令牌真放行；每次渲染令牌真唯一；变异掉校验后 (f) 真变红。
- 防嵌套与不缓存头**真的**在 GET 与 POST 响应上：`X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`、`Cache-Control: no-store`；变异掉后 (g) 真变红。
- 登录窄口**真的**包住 `authService.login`：成功映射 `userId`、失败映射 `{ok:false}` 且不外抛。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、服务/路由落 oauth 与 auth 模块、导出带消费方注释、不导出无消费者符号、≥2 处使用的工具进 `server/shared/utils.ts`）与 AGENTS.md；不引入新依赖（只用既有 express 与 node 内置 `crypto`）；不越界实现 AC-261–AC-270。

## Touches

- server/modules/auth/credential-verifier.ts (new)
- server/modules/auth/index.ts
- server/modules/oauth/oauth-consent.routes.ts (new)
- server/modules/oauth/index.ts
- server/modules/oauth/tests/oauth-consent-page.test.ts (new)（判据）
- tasks/gap-ac260-oauth-consent-page.md

## Notes

- 依赖顺序：AC-260 复用 AC-259 的 `createOAuthProvider.authorize()`（客户端/`redirect_uri` 逐字/PKCE/受众判定与授权码落库）与 AC-258 的 `oauthClientsDb.findById`；`depends_on` 已声明两条，AC-259 落地前本任务必红。若实现中发现 `oauthClientsDb` 的读取方法名/形状与 AC-258 实际交付不同，以实际写点为准调整 `clients` 缝与 Touches（内存 `quay-touches-must-match-actual-write-sites`）。
- 转义：自写 `escapeHtml`（`&`→`&amp;`、`<`→`&lt;`、`>`→`&gt;`、`"`→`&quot;`、`'`→`&#39;`），不引新依赖；AC-261 若复用（≥2 处）再移入 `server/shared/utils.ts`，本任务不提前移动。
- CSRF 台账在路由工厂实例内（单进程）；无需跨进程。判据可注入固定 `now` 推进令牌 TTL 以测过期分支（可选）。
- `state` 原样回传：GET 隐藏字段与 302 Location 都逐字回传提交值，不改写解码后的值（`URLSearchParams` 会做百分号编码，判据按解码后逐字断言）。
- 只读 scope 恒 `disabled`：浏览器不提交 disabled 项，服务端必须强制并入 `cloudcli:read`，(e) 断言这一点。
- 新增测试文件可能被边界 lint 拦截（内存 `quay-boundaries-lint-blocks-new-test-files`）；判据文件已列入 `## Touches`。
- 新增 barrel 导出（auth 的 `createCredentialVerifier`、oauth 的 `createOAuthConsentRouter`）可能使某个整体 `vi.mock('@/modules/auth/index.js')` / `vi.mock('@/modules/oauth/index.js')` 的兄弟测试变红（内存 `adding-an-export-reds-sibling-wholesale-vimocks`）；若如此，把新导出补进对应 mock 工厂并把该测试文件加进 `## Touches`，以实际写点为准。
- 判据是本任务的机械读数，文件即 AC-260 `criterion:` 所点名的那个；不新建第二个判据文件。