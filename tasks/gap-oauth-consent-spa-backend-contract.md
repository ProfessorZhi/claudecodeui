---
id: gap-oauth-consent-spa-backend-contract
title: OAuth 授权页改为 SPA（后端半）：/oauth/authorize 先校验后跳转到 SPA 路由，新增已登录会话鉴权的
  context/decision JSON 接口，替换服务端 HTML 表单与其判据
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac260-oauth-consent-page
  - gap-ac261-oauth-consent-ratelimit
  - gap-ac268-oauth-e2e-flow
---
## Proposal

现状：`server/modules/oauth/oauth-consent.routes.ts` 用 `renderConsentPage` 服务端渲染一张裸 HTML 表单（CSP `default-src 'none'`、CSRF 台账、用户名+密码重输、`oauth-consent-ratelimit.service.ts` 的密码限速），无样式、与应用不一致。用户已裁定：授权页迁入 SPA（复用 `src/shared/ui` 与应用主题）。本任务是**后端半**；兄弟任务 `gap-oauth-consent-spa-ui` 是前端半，依赖本任务。

设计（下列不变量为强制，执行者可凭证据细化其余）：

1. `GET /oauth/authorize` 仍是已登记的 authorization_endpoint，**保留全部现有校验**（client_id 存在且未禁用、`response_type=code`、`redirect_uri` 逐字属于该客户端已登记集合——未登记者显示错误页且**绝不重定向**，RFC 6749 §3.1.2.4），校验通过后才 302（同源、相对路径）到 SPA 路由 `/oauth/consent?<原 query>`；路由路径作为常量，若前后端共享则放 `server/shared`（路由名由 UI 任务消费，此处定死）。非法请求仍返回纯文本/HTML 错误页。防嵌套头（`X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`）与 `Cache-Control: no-store` 还必须出现在 SPA 文档该路由的响应上（先读 `server/index.ts` 如何提供 SPA 壳，加路由级头中间件）与新 JSON 接口上。
2. 新增 `/api/oauth/authorize/` 下的 JSON 接口：`GET context?<同 query>` 由常规应用 bearer JWT（`authenticateToken`；SPA 以头携带 JWT，故无跨站 CSRF）鉴权，重跑同一套 client/redirect 校验（失败 400 JSON），返回 `{clientName, callbackHost, redirectUri, scopes:[{scope, description, required, writable}], state}`；`POST decision` 入参 `{client_id, redirect_uri, state, code_challenge, code_challenge_method, scopes[], action:'allow'|'deny'}`，同样鉴权，**重新校验 redirect_uri 属于已登记集合**（deny 不得成为开放重定向器）；deny → `{redirectTo: redirect_uri?error=access_denied&state=…}`；allow → 强制并入 `cloudcli:read`、丢弃 `ACCESS_TOKEN_SCOPES` 之外的 scope、以 JWT 中的 userId 调 `provider.authorize`，返回 `{redirectTo: redirect_uri?code=…&state=…}`。最终 `window.location` 跳转由 SPA 执行（避开服务端 CSP form-action 问题，Google 的多跳回调链保持可用）。
3. 密码重输**取消**，改为已登录会话 + 显式点击 Allow。故本页的 CSRF 台账与密码限速退役——**但先核查** `oauth-consent-ratelimit.service.ts` 是否另有消费者（`credential-verifier`、`/login`），仍被消费的保留，有消费者的代码不得删除。若判断去掉密码不安全（如会话劫持风险），在 Notes 中提出，并以开关保留 `confirm password` 选项，不得静默决定。
4. `oauth-request-log.service.ts` 的请求日志/脱敏必须覆盖新路径（`state`、`code`、`code_challenge` 仍须脱敏），审计语义保持。
5. 遵守 `$backend-module-standards`：跨模块只经 barrel、路由保持薄、逻辑进 service 层、导出带消费方注释、不建模块内 types/utils 文件。

待改写的判据（逐个读、原地改写，所有文件列入 Touches）：`oauth-consent-page.test.ts`（AC-260 的 (a) 转义、(b) 只读 checked+disabled、(c) 密码、(f) CSRF、(g) 头、(i) CSP 无 form-action、(j) 未登记 redirect_uri 的 GET/POST allow/deny、(l) 真浏览器两跳回调链、(m) 全 scope 供选仅 read 预勾、(n) 词表外伪造 scope 被丢弃）→ 转译到新契约：转义类改为 JSON 数据用例；密码/CSRF 类退役并写明理由；(j)(l)(m)(n)(g) 必须保留真实牙齿。`oauth-consent-ratelimit.test.ts`（AC-261）按第 3 点核查结果退役或改指向。`mcp-gateway/tests/oauth-flow.e2e.test.ts`（AC-268：`parseCsrf` + POST 表单流）→ GET authorize 302 → context → decision → token 交换，整条 PKCE 链保持绿。另有 `oauth-request-log.test.ts`、（若受影响）`oauth-provider.test.ts`、（若枚举了这些路由）`mcp-english-only.test.ts` 与 `mcp-error-envelope.test.ts`。

<!-- dedup-ref -->
边界（dedup）：机制去重已核对——`task_list` 搜索 `oauth-consent-spa` 与 `/api/oauth/authorize` 均无命中。相关但不同：`gap-ac260-oauth-consent-page`（done，服务端 HTML 授权页，本任务将其取代）、`gap-ac261-oauth-consent-ratelimit`（done，密码限速）、`gap-ac268-oauth-e2e-flow`（done，端到端流，本任务改写其判据）。三者的 AC 文本是历史记录，不改；前端半 `gap-oauth-consent-spa-ui` 是不同机制（SPA 页面），依赖本任务。

## AC

- [x] AC1 红态基线逐字记录：改动前，对已起的服务 `GET /oauth/authorize`（合法参数）返回 `content-type: text/html` 的表单而非 302，且 `GET /api/oauth/authorize/context` 为 404；写下完整命令与输出。
  - 步骤：在 worktree 内 `git stash push --include-untracked` 把工作树回到 `HEAD=ec270444`（改动前树），再 `env PATH="$PWD/node_modules/.bin:$PATH" TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx /tmp/ac1-baseline-probe.mts "$PWD"`。探针起真实 `server/index.ts`（tsx、真实 DB、真实静态层），注册一个 client，`curl` 等价地取两条路径。
  - 逐字读数（改动前）：
    ```
    GET /oauth/authorize -> 200
      content-type: text/html; charset=utf-8
      location: undefined
      body[0..300]: <!doctype html> <html lang="en"> <head><meta charset="utf-8"><title>Authorize access</title></head> <body>   <h1>Authorize access</h1>   <p>Application: ac1-probe</p>   <p>Callback host: app.example</p>   <p>Redirect URI: https://app.example/cb</p>   <form method="post" action="">     <input type="h
      carries csrf_token field: true
    GET /api/oauth/authorize/context -> 302
      content-type: text/plain; charset=utf-8
      location: http://localhost:5173
      body[0..200]: Found. Redirecting to http://localhost:5173
    ```
  - 第一读数与 AC 完全一致（HTML 表单、非 302、带 `csrf_token`）。
  - **偏差（按「逐字记录」优先，原样记下）**：AC 预测第二条为 404；实测为 302→Vite。改动前树中不存在任何 `/api/oauth/authorize` 路由（`grep -rn "api/oauth/authorize" server/ shared/` → 无命中；`grep -rn "oauth/consent" server/ shared/` → 无命中），唯一应答者是 `createStaticAssetsMiddleware` 的 SPA catch-all（dev 模式交棒 Vite；有 `dist/index.html` 时即 200 index.html）。故「改动前该 JSON 接口不存在」成立，只是可观测状态码由静态兜底决定，而非 404。
  - 恢复：`git stash pop`；`git diff` 与暂存前字节一致（`diff -q /tmp/ac1-tracked.patch <(git diff)` 通过），工作树状态 12 改 + 2 新恢复原样。
- [x] AC2 `GET /oauth/authorize` 合法请求 → 302，`location` 为同源相对路径 `/oauth/consent?…`，原 query 逐项保留；逐字写出 location。
  - 真实服务读数（同一探针，改动后）：`GET /oauth/authorize -> 302`，`location: /oauth/consent?response_type=code&client_id=2927d2bbed7a657f97f8421ded3544ec&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&code_challenge=baseline-challenge&code_challenge_method=S256&scope=cloudcli%3Aread&state=baseline-state`（无 scheme/host，纯相对路径）。
  - 判据 (a)：`(a) 302 location=/oauth/consent?client_id=4d8d20c4634b8a88034a905aba34dee9&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code&state=state-abc&code_challenge=z-lCjBGrYDukWl3WV0SAdoReOjZqfrMWFy3QT8LKqhs&code_challenge_method=S256&scope=cloudcli%3Aread+cloudcli%3Asession%3Asend`；并逐项断言原 query 每个 key 的取值逐字保留（`assert.equal(landed.searchParams.get(key), value, …)`），且以 `!/^https?:/i` 断言非绝对 URL。
- [x] AC3 未登记 `redirect_uri`（及不存在/已禁用 client、非 `response_type=code`）→ 400 错误页且**无** `location` 头（不重定向）；逐字写出状态码与头。
  - 判据 (f)：`(f) GET=400 (no location) context=400 decision allow/deny=400; codes 0->0`。断言逐字：`assert.equal(getResponse.status, 400)`、`assert.equal(getResponse.headers.get('location'), null, 'an unregistered callback must never be redirected to')`、响应体含 `Authorization error`、且**不**含未登记主机名（不回显）。
  - 判据 (j)：`(j) missing=400 unknown=400 non-code=400 (all without Location)`（缺失 client/未知 client/非 `code` 一律 400 且无 Location）。
  - 依 RFC 6749 §3.1.2.4：未登记回调永不重定向。
- [x] AC4 `GET /api/oauth/authorize/context`：无 JWT → 401；有 JWT → 200，`scopes` 含全部词表 scope、`cloudcli:read` 为 `required:true`，`state` 原样回显，`callbackHost` 正确；未登记 `redirect_uri` → 400 JSON。
  - 无 JWT：判据 (k) `(k) context=401 decision=401; oauth_authorization_codes rows 0->0`；真实服务 `GET /api/oauth/authorize/context (no JWT) -> 401 {"error":"Access denied. No token provided.","code":"AUTH_TOKEN_INVALID"}`。
  - 有 JWT：判据 (b) `(b) clientName="<script>alert(1)</script>" callbackHost=app.example state=state-xyz`（clientName 作 JSON 数据逐字返回、不被当 HTML 解析；state 原样回显；callbackHost 为该 client 登记回调的主机）。
  - 整词表 + read 必选：判据 (c) `(c) scopes=cloudcli:read(required=true,writable=false) cloudcli:session:send(required=false,writable=true) cloudcli:session:create(required=false,writable=true) cloudcli:session:control(required=false,writable=true) cloudcli:approve(required=false,writable=true) cloudcli:navigate(required=false,writable=true)`；并断言保留 scope `cloudcli:admin` 绝不出现在供选表里。
  - 未登记 redirect_uri → 400 JSON：判据 (f) `context=400`（`error: invalid_request`）。
- [x] AC5 `POST /api/oauth/authorize/decision` allow：返回 `redirectTo` 含非空 `code` 与原样 `state`；经 `getConnection()` 读回的 `oauth_grants.scopes` 恰为「提交集 ∪ cloudcli:read − 词表外 scope」（含对伪造 scope 的丢弃）。
  - 判据 (e)：`(e) redirectTo=https://app.example/cb?code=59ea3fb58fb769c9565474eaf1b4bba4632b2d75432283c75cba372b548fa87f&state=state-allow-1 grant.scopes=["cloudcli:read","cloudcli:session:send"] codes 0->1`。断言：code 非空（64 位十六进制）、state 逐字回显、`redirectTo` 的 origin+path 等于登记回调、授权码行恰好 +1。
  - 判据 (m)：提交 `['cloudcli:admin','bogus','cloudcli:session:create','cloudcli:session:create','cloudcli:navigate']` → `(m) forged scopes dropped; grant.scopes=["cloudcli:read","cloudcli:session:create","cloudcli:navigate"]`，即「词表内 ∪ cloudcli:read，词表外丢弃，重复去重」。
  - grant 行读数经 `getConnection()` 直读 `oauth_grants.scopes`（真库行，非响应回显）。
- [x] AC6 decision deny：已登记 redirect_uri 时 `redirectTo` 含 `error=access_denied` 与 `state`、无 `code`；未登记 redirect_uri（allow 与 deny 两种）→ 400 且无 `redirectTo`、无授权码行新增。
  - 判据 (d)：`(d) redirectTo=https://app.example/cb?error=access_denied&state=state-deny-1 codes 0->0`（`url.searchParams.get('code') === null`、state 逐字、`oauth_authorization_codes` 行数不变）。
  - 判据 (f)：`(f) … decision allow/deny=400; codes 0->0` —— 校验先于两条分支，allow 与 deny 都在此被拒；`assert.equal(response.body?.redirectTo, undefined)` 且行数不变（deny 不构成开放重定向器）。
- [x] AC7 decision 无 JWT → 401 且无授权码行新增；`oauth_authorization_codes` 行数读数前后逐字写出。
  - 判据 (k) 逐字行数读数：`(k) context=401 decision=401; oauth_authorization_codes rows 0->0`。
  - 真实服务：`POST /api/oauth/authorize/decision (no JWT) -> 401 {"error":"Access denied. No token provided.","code":"AUTH_TOKEN_INVALID"}`。
- [x] AC8 防嵌套/不缓存头：SPA 路由 `/oauth/consent` 文档与 context、decision JSON 响应均含 `X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`、`Cache-Control: no-store`；逐字写出原始头值。
  - 两条 JSON 路由：判据 (g) `(g) context x-frame-options=DENY csp="frame-ancestors 'none'" cache-control=no-store; decision 200/400 the same`（含 400 分支）。
  - SPA 文档（跨真实静态层 `createStaticAssetsMiddleware`）：判据 (h) `(h) /oauth/consent x-frame-options=DENY csp="frame-ancestors 'none'" cache-control="no-store"`。
  - 真实服务（e2e，真 HTTP 头原值）：`[AC8] GET /oauth/consent -> 302 location=http://localhost:5173 x-frame-options=DENY csp="frame-ancestors 'none'" cache-control=no-store`。
  - 挂载顺序（头中间件必须先于静态层，否则 `Cache-Control` 会被静态层覆写）：`[AC8] server/index.ts: mountOAuthServer@42971 < consentDocHeaders@43789 < createStaticAssetsMiddleware@44356`。
  - 判据 (i)：文档 CSP `frame-ancestors 'none'`（无 `default-src 'none'`、无 `form-action` —— `window.location` 下 `form-action` 无主体，且壳的 bundle 必须能加载）；错误页 CSP 仍为 `default-src 'none'; frame-ancestors 'none'`。
- [x] AC9 全 PKCE 链 e2e 绿（`oauth-flow.e2e.test.ts` 新流：authorize 302 → context → decision → token 交换 → `/mcp` 调用）；(l) 多跳回调链真浏览器用例仍绿。
  - `oauth-flow.e2e.test.ts` 1/1 绿（exit 0），真实服务逐字读数：
    ```
    [a] GET /oauth/authorize -> 302 location=/oauth/consent?response_type=code&client_id=3639e27290d03292cc4171b3de5f280b&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&code_challenge=zdBAai9LeB18bhyOjPj-a13a-0jj1yp37W4oI27BCaM&code_challenge_method=S256&scope=cloudcli%3Aread&state=e483558d02b9dc85
    [a] GET /api/oauth/authorize/context -> 200 {"clientName":"oauth-flow-criterion","callbackHost":"app.example","redirectUri":"https://app.example/cb","scopes":[{"scope":"cloudcli:read","required":true,"writable":false},…6 项…],"state":"e483558d02b9dc85"}
    [a] POST /api/oauth/authorize/decision -> 200 redirectTo=https://app.example/cb?code=c7484d2b361dfe716b3827272e9e5c360e0a5cb6d511abf3bf422c13467b301d&state=e483558d02b9dc85
    [a] POST /oauth/token (authorization_code) -> 200 {"access_token":"cca_f23395202f6c85821028e9946a7ea26f7e4cfba89f3a43f054c80b9d611cac64","token_type":"Bearer","expires_in":3600,"refresh_token":"ccr_9cd2d864064e9978361930987782cb064f489d2306f31988bb86d44db1f0b63a"}
    [b] POST /mcp tools/list -> 200; tools=[…21 项…]
    [b] POST /mcp tools/call overview -> 200; payload={"running":[],"awaitingPermission":[],"aborted":[],"hosts":[],"quay":[]}
    ```
  - (l) 真浏览器多跳链：`(l) real Chromium: authorize 302 -> /oauth/consent -> window.location -> 2 hops -> http://127.0.0.1:4123/done code=64 chars state=state-browser; control stopped on /oauth/consent` —— 同一脚本在 `default-src 'none'` 下无法执行（control 停在 /oauth/consent），反证 consent 文档不得沿用错误页 CSP。
- [x] AC10 取假形态必须红（逐条记录变异 diff、逐字失败行、恢复命令、恢复后重跑绿）：实现态先备份到 `/tmp/ac10-backup/`，每条变异后 `cp` 回原位（`diff -q` 通过）再重跑。
  - **(i) decision 跳过 redirect_uri 校验 ⇒ AC6 红。**
    - 变异 diff（`oauth-consent.routes.ts`，`/decision` 内）：
      ```
      -    // The registered-callback check runs BEFORE either branch: the deny branch
      -    // would otherwise be an open redirector.
      -    const reading = readConsentRequest(options.clients, { clientId, redirectUri });
      -    if (!reading.ok) {
      -      sendJsonError(res, reading.status, reading.error, reading.message);
      +    // FALSIFICATION (AC10-i): skip the registered-callback check entirely.
      +    if (redirectUri === null) {
      +      sendJsonError(res, 400, 'invalid_request', 'Missing redirect_uri');
             return;
           }
      +    const reading = { clientId: clientId ?? '', redirectUri, clientName: '', callbackHost: '' };
      ```
    - 逐字失败行：``AssertionError [ERR_ASSERTION]: decision deny to an unregistered callback must be refused`` @ `server/modules/oauth/tests/oauth-consent-page.test.ts:445:14`，`actual: 200, expected: 400`；`pass 12 / fail 1`，exit 1。
    - 恢复：`cp /tmp/ac10-backup/oauth-consent.routes.ts server/modules/oauth/oauth-consent.routes.ts`；重跑 13/13 绿，exit 0。
  - **(ii) 跳过 JWT 鉴权 ⇒ AC4/AC7 红。**
    - 变异 diff（`oauth-server.mount.ts`）：
      ```
      -  app.use('/api/oauth/authorize', authenticateToken, createOAuthAuthorizeApiRouter({ provider, clients }));
      +  // FALSIFICATION (AC10-ii): the JWT gate is dropped.
      +  app.use('/api/oauth/authorize', createOAuthAuthorizeApiRouter({ provider, clients }));
      ```
    - 逐字失败行（直接命中 AC4/AC7 的一条）：``AssertionError [ERR_ASSERTION]: context without a bearer JWT must be refused`` @ `oauth-consent-page.test.ts:556:12`，`actual: 200, expected: 401`。同一次运行另有 3 条由「无 user」级联而来：`:396:12`（leg (e) `actual: 500, expected: 200`）、`:590:12`（leg (m)，同）、`:677:18`（leg (l) 浏览器用例）。`pass 9 / fail 4`，exit 1。
    - 恢复：`cp /tmp/ac10-backup/oauth-server.mount.ts server/modules/oauth/oauth-server.mount.ts`；重跑 13/13 绿，exit 0。
  - **(iii) 保留词表外 scope ⇒ AC5 红。**
    - 变异 diff（`oauth-consent.service.ts` 的 `grantedScopes`）：
      ```
      -    if (!vocabulary.has(scope) || seen.has(scope)) {
      +    // FALSIFICATION (AC10-iii): the vocabulary filter is dropped.
      +    if (seen.has(scope)) {
      ```
    - 逐字失败行：``AssertionError [ERR_ASSERTION]: only vocabulary scopes survive, once each, plus the forced read-only scope`` @ `oauth-consent-page.test.ts:591:12`
      `actual: [ 'bogus', 'cloudcli:admin', 'cloudcli:navigate', 'cloudcli:read', 'cloudcli:session:create' ]`
      `expected: [ 'cloudcli:navigate', 'cloudcli:read', 'cloudcli:session:create' ]`（读的是真库 grant 行）。`pass 12 / fail 1`，exit 1。
    - 恢复：`cp /tmp/ac10-backup/oauth-consent.service.ts server/modules/oauth/oauth-consent.service.ts`；重跑 13/13 绿，exit 0。
  - **(iv) 去掉 SPA 路由头 ⇒ AC8 红。**
    - 变异 diff（`oauth-consent.routes.ts`，`createOAuthConsentDocumentHeadersMiddleware`）：
      ```
      -  return (_req, res, next) => {
      -    applyConsentHeaders(res);
      -    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => express.Response;
      -    res.writeHead = ((...args: unknown[]) => {
      -      applyConsentHeaders(res);
      -      return writeHead(...args);
      -    }) as typeof res.writeHead;
      +  // FALSIFICATION (AC10-iv): the SPA route's document headers are not applied.
      +  return (_req, _res, next) => {
             next();
           };
      ```
    - 逐字失败行：``AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:`` @ `oauth-consent-page.test.ts:499:12`，`actual: null, expected: 'DENY'`（leg (h) `X-Frame-Options` 缺失）；``AssertionError [ERR_ASSERTION]: anti-framing must stay: `` @ `:515:12`（leg (i)）。`pass 11 / fail 2`，exit 1。
    - 恢复：`cp /tmp/ac10-backup/oauth-consent.routes.ts server/modules/oauth/oauth-consent.routes.ts`；重跑 13/13 绿，exit 0。
- [x] AC11 请求日志脱敏：`oauth-request-log.test.ts` 证明新路径的 `state`、`code`、`code_challenge` 在日志中仍为脱敏值。
  - `oauth-request-log.test.ts` 7/7 绿（exit 0）。leg (f) 一次投放 8 个带唯一标记的敏感值（`code`、`verifier`、`client_secret`、`refresh_token`、`password`、`state`、`code_challenge`、bearer），断言 6 行日志中**任意标记及其 12 字前缀均不出现**：`(f) 6 lines, 8 planted secrets, 0 leaked`。
  - leg (g) 断言新路径的日志形状：`(g) [OAuthReq] GET /api/oauth/authorize/context -> 400 invalid_request   client=3b3dae8d  …`（查询串（载 `state`/`code_challenge`）被剥离，`state=` 不出现在行内）；`(g) [OAuthReq] POST /api/oauth/authorize/decision -> 200 redirect=- …`（`/decision` 的应答体带 `code`，但因无 Location 头，logger 无从读到，故不泄漏）。
  - `server/modules/oauth/oauth-request-log.service.ts` 本体无需改动：logger 按挂载前缀工作、从不读请求体或响应体，新路径复用同一机制；改动仅在 `server/index.ts` 的挂载前缀加入 `/api/oauth/authorize`。
- [x] AC12 限速服务消费者核查已落 Notes：列出 `oauth-consent-ratelimit.service.ts` 的全部消费者；仍有消费者的保留，无消费者才退役（连同判据 `oauth-consent-ratelimit.test.ts` 改写/退役并写明理由）。
  - 核查命令与结果见 Notes「AC12 限速服务消费者核查」。结论：**零消费者**，文件与其判据一并退役；仓库内其余限速（`createUiOpenSessionRateLimiter`、ASR 侧）与本流程无关，未触碰。
- [x] AC13 仓库门：逐个单文件运行被触及的测试文件（遵守 `docs/operations/process-isolation-and-memory-caps.md`，不做无界 fan-out），`npm run typecheck` 退出 0，`npm run lint`（含 boundaries）无 `: error `；**不新增** `server/**/*.test.ts` 文件（仓库钉死文件数），只改既有文件。
  - 逐文件单跑（各自独立 node 进程，非 fan-out；`env PATH="$PWD/node_modules/.bin:$PATH" TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test <file>`）：`oauth-consent-page.test.ts` 13/13、`oauth-request-log.test.ts` 7/7、`oauth-flow.e2e.test.ts` 1/1、`mcp-english-only.test.ts` 10/10、`quay-test-script.test.ts` 11/11、`oauth-provider.test.ts` 8/8、`mcp-error-envelope.test.ts` 7/7、`oauth-metadata-mount.test.ts` 6/6、`mcp-oauth-challenge.test.ts` 6/6、`oauth-dcr.test.ts` 7/7、`dependency-declaration.test.ts` 4/4 —— 全部 exit 0，无 `not ok`。
  - `npm run typecheck` → exit 0（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三段）。
  - `npm run lint`（即 `oxlint src/ server/ scripts/ shared/`，`.oxlintrc.json` 加载 `boundaries` 插件）→ exit 0，`grep -c ": error "` = 0（余下均为既有前端 warning）。
  - 测试文件计数：`find server \( -name '*.test.ts' -o -name '*.test.js' \) | grep -v node_modules | wc -l` → **249**，与钉死值一致（`quay-test-script.test.ts` 现为 `known=3 unknown=246` 与 `known=1 unknown=248`，两式均 249；较原 250 恰减 1，因删除 1 个测试文件）。
  - **未新增** `server/**/*.test.ts`：`git status` 无新增测试文件，只有 1 个删除。
- [x] AC14 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ` (new)`）；已改 `oauth/index.ts` barrel 导出与 `server/index.ts`、`oauth-server.mount.ts` 的消费一致。
  - `git diff --stat develop...HEAD` → 13 个文件，见 `## Touches` 的逐条对齐（新增标 ` (new)`、删除标 ` (deleted)`）。
  - barrel 消费一致：`server/modules/oauth/index.ts` 新增导出 `createOAuthConsentRouter` / `createOAuthAuthorizeApiRouter` / `createOAuthConsentDocumentHeadersMiddleware` 与类型 `OAuthConsentRouterOptions` / `OAuthAuthorizeApiOptions`；`server/index.ts` 消费 `createOAuthConsentDocumentHeadersMiddleware` 与 `OAUTH_CONSENT_SPA_PATH`（来自 `shared/oauthConsent.js`）；`oauth-server.mount.ts` 消费 `createOAuthConsentRouter` 与 `createOAuthAuthorizeApiRouter`。`npm run typecheck`（含 `server/tsconfig.json`）退出 0 即一致性证明。

## DoD

- 真实运行的服务 + 真实 JWT，用 curl 驱动授权码流程端到端：`/oauth/authorize` 302 → context → decision allow → `/oauth/token` 交换，最终以签发的令牌成功调用 `/mcp`；逐字记录每步状态码与响应。
- redirect_uri 校验**真的**在 GET authorize、context、decision 三处生效：未登记者真不重定向、真无授权码、deny 不是开放重定向器；变异掉后对应 AC 真变红。
- JWT 鉴权**真的**是闸：无 JWT 的 context/decision 真 401；变异掉后真变红。
- 词表外 scope **真的**被丢弃、`cloudcli:read` 真被强制并入（真库 grant 行读数）。
- 防嵌套/不缓存头**真的**在 SPA 路由文档与 JSON 接口响应上（真 HTTP 头原值）。
- 被取代的服务端 HTML 表单与 CSRF 台账已移除；仍有消费者的限速代码未被删除；遵守 `$backend-module-standards` 与 AGENTS.md；不引入新依赖。

## Touches

`git diff --stat develop...HEAD` 逐条对齐（13 个文件；` (new)` = 新增，` (deleted)` = 删除）：

- shared/oauthConsent.ts (new)（唯一跨树常量 `OAUTH_CONSENT_SPA_PATH = '/oauth/consent'`；前端半 `gap-oauth-consent-spa-ui` 消费）
- server/modules/oauth/oauth-consent.service.ts (new)（consent 策略层：`OAUTH_CONSENT_READ_SCOPE`、`SCOPE_DESCRIPTIONS`、`consentScopeOptions()`、`registeredRedirectUris()`、`readConsentRequest()`、`grantedScopes()`）
- server/modules/oauth/oauth-consent.routes.ts（传输层重写：`createOAuthConsentRouter`、`createOAuthAuthorizeApiRouter`、`createOAuthConsentDocumentHeadersMiddleware`、`sendErrorPage`）
- server/modules/oauth/oauth-server.mount.ts（新增 `/api/oauth/authorize` 挂在注入的 `authenticateToken` 之后；不再消费 `credentialVerifier`）
- server/modules/oauth/index.ts（barrel += `createOAuthConsentRouter`、`createOAuthAuthorizeApiRouter`、`createOAuthConsentDocumentHeadersMiddleware`、`OAuthConsentRouterOptions`、`OAuthAuthorizeApiOptions`）
- server/modules/oauth/oauth-consent-ratelimit.service.ts (deleted)（AC12 核查为零消费者，退役）
- server/index.ts（去掉 `credentialVerifier` 构造；在 `OAUTH_CONSENT_SPA_PATH` 挂文档头中间件，必须先于 `createStaticAssetsMiddleware`；请求日志前缀加入 `/api/oauth/authorize`；`mountOAuthServer` 调用改传 `{ provider, store, clients, authenticateToken }`）
- server/modules/oauth/tests/oauth-consent-page.test.ts（判据整体转译到新契约，13 例 (a)–(m)；密码/CSRF 腿按 AC-260 退役并写明理由）
- server/modules/oauth/tests/oauth-consent-ratelimit.test.ts (deleted)（AC12 的退役）
- server/modules/oauth/tests/oauth-request-log.test.ts（挂载前缀加入 `/api/oauth/authorize`；新增 leg (g) 新路径形状/脱敏用例）
- server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts（端到端流转改为 GET authorize 302 → context → decision → token；新增 `/oauth/consent` 头探针与挂载顺序读数）
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts（仅删掉 `createOAuthConsentRouter(...)` 调用中已移除的 `provider`/`verifyCredentials` 入参）
- server/shared/tests/quay-test-script.test.ts（测试文件计数钉死值随删除 1 个测试文件减 1）
- tasks/gap-oauth-consent-spa-backend-contract.md（本任务账本，由 `task_write` 分支感知提交）

原 Touches 候选里**实际未触及**的：`server/modules/oauth/oauth-provider.service.ts`（无需改）、`server/modules/oauth/oauth-request-log.service.ts`（logger 本体无需改，脱敏按构造已覆盖新路径）、`server/shared/constants.ts`（常量落 `shared/oauthConsent.ts`，模块名更贴切）、`server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts`（未枚举这些路由，7/7 仍绿）。

## Notes

- **取代声明（历史记录不改）**：`gap-ac260-oauth-consent-page`、`gap-ac261-oauth-consent-ratelimit`、`gap-ac268-oauth-e2e-flow` 已 done，其 AC 文本是历史记录，本任务不编辑它们。自本任务落地起，AC-260 的服务端 HTML 表单、转义用例 (a)、只读 checkbox (b)、密码 (c)、CSRF (f)、CSP 无 form-action (i) 以及 AC-261 的授权页密码限速语义，被本任务的 SPA + JSON 契约取代；AC-268 的 `parseCsrf` + POST 表单流被新流取代。(g)(j)(l)(m)(n) 的意图保留并转译到新契约。

### AC12 限速服务消费者核查（先核查、后删除）

- `grep -rn "oauth-consent-ratelimit\|createOAuthConsentRateLimiter\|consentRateLimit\|oauthConsentRateLimit" --include=*.ts --include=*.tsx --include=*.js --include=*.json --exclude-dir=node_modules .` → **全树零命中**（`oauth-consent-ratelimit.service.ts` 已删后的复核同样零命中）。
- `grep -rni "rate.limit\|ratelimit" server/modules/oauth` → **无命中**，即 `credential-verifier`、`/login` 与 OAuth 模块内均未消费它。
- 结论：唯一消费者是它自己的判据文件 `oauth-consent-ratelimit.test.ts`（该判据只驱动该被删服务），故连同服务一并退役。仓库中其余限速实现（`server/modules/mcp-gateway/mcp-ui-open-session.ts` 的 `createUiOpenSessionRateLimiter`、ASR 侧）与本流程无关，**未触碰**；「仍有消费者的限速代码不得删除」成立。
- 随之退役的还有本页的 CSRF 台账：`grep -rn "csrfStore\|csrf_token\|createCsrf\|CsrfStore" server/ shared/` → **无命中**（SPA 以 `Authorization` 头携带 JWT，无跨站表单，故无 CSRF 台账主体）。

### 密码重输移除的安全提请（AC3 要求不得静默决定）

- 事实：密码重输取消后，授权完全依赖「已登录会话 + 显式点击 Allow」。持有被盗 JWT 的攻击者（XSS 取 token 等）可**静默**为第三方客户端授权——在密码重输下这还需要用户的登录密码。这是本任务引入的真实信任边界变化。
- 本次决策：**按任务第 3 点执行移除**。理由：任务正文已把「已登录会话 + 显式点击 Allow」定为既定设计；`/api/oauth/authorize/*` 与应用其余需鉴权的写操作（`/api/settings/*` 等）处于**同一信任级**，若认为 JWT 可被静默滥用，那是全局会话模型问题而非本页面独有；且 SPA 以 `Authorization` 头携带 JWT，无跨站 CSRF 面，密码重输在此不增加独立的第二因子强度。
- 未加 `confirm password` 开关。**取舍交人裁定**：若不接受该风险，请在 `gap-oauth-consent-spa-ui`（前端半）动工前决定是否加回一个可配置的 `confirm password` 步骤；本契约已把 `/decision` 收敛为唯一授权入口，加回该步骤不需要改动后端契约（只需在 `/decision` 前加一次凭据校验）。

### 实现要点与偏差

- **SPA 路由常量**放 `shared/oauthConsent.ts`（任务给的两个候选是 `server/shared` 与 `server/shared/constants.ts`；实际写点选根 `shared/`，因前端半还要 `import` 它，根 `shared/` 是双方都可经 barrel/别名到达的唯一处）。
- **文档头必须在静态层之前挂**：`createStaticAssetsMiddleware` 的 SPA catch-all 会给 `index.html` 自设 `Cache-Control` 并终结响应，故仅在路由上设一次头会被覆写。解法是路由级中间件在 `res.writeHead` 上再断言一次（Node 的隐式 header flush 与 `res.redirect` 都会走到 `writeHead`），从而在文档、dev 重定向与 404 三种路径上都压得住。e2e 的 `mountOAuthServer@… < consentDocHeaders@… < createStaticAssetsMiddleware@…` 即为顺序证据。
- **CSP 分野**：consent 文档只带 `frame-ancestors 'none'`（壳的 bundle 必须能加载、`window.location` 下无需 `form-action`）；静态错误页仍为 `default-src 'none'; frame-ancestors 'none'`。判据 (i) 与 (l) 的 control 分别从两头钉死。
- **AC1 的一处读数偏差**已原样记在 AC1 下（预测 404，实测 302→Vite 静态兜底）。
- 本条已由前置会话核实过、本次复核仍成立：`mcp-error-envelope.test.ts` 无需改动（未枚举这些路由）；`server/index.ts` 的日志前缀加 `/api/oauth/authorize` 是让新路径进日志的唯一改动点（logger 本体按前缀工作、不读 body，故脱敏天然覆盖）。
- 内存提示：新增 `server/**/*.test.ts` 会令测试文件计数钉死判据全面变红，故只改既有测试文件（本次净删 1 个并同步钉死值）。
