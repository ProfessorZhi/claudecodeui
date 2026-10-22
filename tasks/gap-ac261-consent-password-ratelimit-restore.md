---
id: gap-ac261-consent-password-ratelimit-restore
title: AC-261 授权页密码提交限速在 SPA 上重建：每来源每 15 分钟 10 次（第 11 次即使密码正确也 429），TRUST_PROXY
  下来源取 CF-Connecting-IP、未配置时伪造头无效；判据
  server/modules/oauth/tests/oauth-consent-ratelimit.test.ts（早先的修复被 SPA
  迁移删除，本任务重建）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-261
---
## Proposal

GOAL-021 退出条件 3 逐字要求「授权页（AC-260、AC-261）：转义、**密码**、scope、CSRF、防嵌套头；**限速与来源判定**」。AC-261 就是这后半条：授权页的密码提交**每来源每 15 分钟 10 次**（第 11 次即使密码正确也 429），来源在配置 `TRUST_PROXY` 时取 `CF-Connecting-IP`、未配置时取 socket 远端地址（伪造的 `CF-Connecting-IP`/`X-Forwarded-For` 一律无效）。

**为什么早先的修复没有保持（本任务存在的原因，本轮已直接实测）**：AC-261 曾由 `gap-ac261-oauth-consent-ratelimit`（done，提交 `74f3e833`）达成，交付 `server/modules/oauth/oauth-consent-ratelimit.service.ts` 与其判据 `server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`。此后 `gap-oauth-consent-spa-backend-contract`（done，提交 `cf9d8055`）把授权页迁入 SPA，并**把服务端渲染表单的密码重输连同密码限速器一起删除**——删除理由是限速器「零消费者」（唯一消费者是它自己的判据），并在该任务 Notes 里把「AC-261 的授权页密码限速语义」散文式声明为「被 SPA + JSON 契约取代」。该声明**没有**落成 goal store 的 `superseded`（对照 AC-122：退役由 worker 执行、理由含人授权、`actor: worker-gap-voice-single-continuous-input-path`，才算数），所以 AC-261 仍以 achieved 被每轮复验，而判据文件已不在树上 ⇒ **现在必红**：存在性闸退出码 1，逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`。凭 `quay goal check --stale-pass`，175 条冻结（frozen）AC 中**只有 AC-261** 落在 `failing`，即这次 SPA 迁移只退役了这一条保证。

同时，该任务自己把「去掉密码是否安全」列为**待人工裁定**（其 Notes「密码重输移除的安全提请」：持有被盗 JWT 者（XSS 取 token 等）可**静默**为第三方客户端授权；原文「取舍交人裁定」），并未取得裁定；`server/modules/auth/credential-verifier.ts` 的 `createCredentialVerifier` 窄口与 barrel 导出的 `credentialVerifier` 至今**无消费者**（auth barrel 注释仍写着它的消费者是 `server/index.ts` 注入 OAuth 挂载），正是为该退回路径预留。故本任务按 GOAL-021 退出条件与 AC-261 的现行文本，把该保证**在当前 SPA 数据面上重建**（不是回退 SPA 页面本身，也不改动 AC-260 已就绪的转义/scope/头语义）。

技术缝即 `gap-oauth-consent-spa-backend-contract` 自己给出的最小改法——「只需在 `/decision` 前加一次凭据校验」。授权页仍是 SPA，只在授权决定前恢复一次**密码确认**（用已登录会话的用户名 + 用户重新输入的密码，经现成的 `credential-verifier` 校验），并对该密码提交接入每来源限速与来源判定。若人裁定不接受该退回，应走 AC-122 那条路（人工授权的 `superseded` + 替代读数），而不是让判据长期红着；本任务按驱动默认（让判据为真）立案。

要交付：

1. **限速服务（新文件 `server/modules/oauth/oauth-consent-ratelimit.service.ts`；TS，遵守 `$backend-module-standards`，跨模块只经 barrel）**：`createConsentPasswordRateLimiter({ now?, windowMs?, maxAttempts?, trustProxy? })` 返回对象。`now` 可注入（默认 `() => new Date()`），`windowMs` 默认 `15 * 60 * 1000`，`maxAttempts` 默认 `10`，`trustProxy` 默认取 `String(process.env.TRUST_PROXY ?? '').trim() !== ''`。
   - `source(req)` → 来源键（字符串）：`trustProxy` 为假时**只用** `req.socket?.remoteAddress ?? 'unknown'`，忽略一切请求头；为真时优先 `req.get('CF-Connecting-IP')`（`trim()` 后非空），缺失/空白回退 socket 远端地址。
   - `isBlocked(source)` → 布尔。按来源做**固定窗口**计数 `Map<source, {count; windowStart}>`：`now() - windowStart >= windowMs` 视为窗口过期（先重置该来源再判）；`count >= maxAttempts` 即封锁。
   - `recordFailure(source)` → 窗口过期则置 `{count:1, windowStart:now()}`，否则 `count++`。
   - `resetSource(source)` → **只删该来源**的计数（成功确认时调用），不得影响其他来源的桶。
   - `retryAfterMs(source)` → 该来源窗口剩余毫秒（用于 `Retry-After`）。顺带清理过期项防无界增长。源解析可作模块内私有函数（无跨文件消费者则不导出）。

2. **授权决定接入（修改 `server/modules/oauth/oauth-consent.routes.ts`）**：`createOAuthAuthorizeApiRouter({ provider, clients, verifyCredentials?, trustProxy?, rateLimiter? })`——`rateLimiter` 可注入（默认以 `{ trustProxy }` 构建服务的限速器），`verifyCredentials` 可注入（生产为 auth 模块 barrel 的 `credentialVerifier`）。在 `POST /decision` 的 `action === 'allow'` 分支、`readConsentRequest` 通过之后、`provider.authorize` 之前：
   - `const key = rateLimiter.source(req)`；若 `rateLimiter.isBlocked(key)` → `429` JSON（`sendJsonError(res, 429, 'too_many_requests', …)`，可带 `Retry-After: Math.ceil(retryAfterMs/1000)`），**不**调 `verifyCredentials`、**不**调 `provider.authorize`、**不**签发授权码、**不**返回 `redirectTo`，并保留本面既有的 `X-Frame-Options`/CSP/`Cache-Control: no-store` 头（`sendJsonError` 已带）。
   - 取用户名：优先请求体 `username`（单字符串），缺失时回退 `req.user` 的登录名；密码取请求体 `password`。`verifyCredentials(username, password)` 返回 `{ ok: false }` 或密码为空 → `rateLimiter.recordFailure(key)` → `401` JSON（沿用本面既有错误形制）。
   - `{ ok: true }` → `rateLimiter.resetSource(key)`（只重置本来源）→ 继续既有 `provider.authorize` → 回 `{ redirectTo }`。
   - `action === 'deny'` 与 `GET /context` 不限速（不提交密码）。**不改**本面的转义、scope 词表、`grantedScopes`、未登记回调用例与防嵌套/不缓存头语义。

3. **接线（修改 `server/modules/oauth/oauth-server.mount.ts` 与 `server/index.ts`）**：`MountOAuthServerDeps` 增加可选 `credentialVerifier`，`createOAuthAuthorizeApiRouter` 收到它；`server/index.ts`（auth barrel 注释已声明的消费方）把 auth 模块的 `credentialVerifier` 注入 `mountOAuthServer`。**不新建第二份凭据实现**，不引入新依赖。

4. **SPA 同步（修改 `src/modules/oauth-consent/OAuthConsentRoute.tsx` 与 `src/modules/oauth-consent/hooks/useOAuthConsent.ts`；遵守 `$frontend-module-standards`）**：Allow 前增加一次**密码确认**输入（复用 `src/shared/ui` 组件与主题 token，mobile-first，375px 无横向溢出），`POST /api/oauth/authorize/decision` 的 body 增加 `password`（用户名由登录态提供）。错误态：凭据错误 → 可读错误、可重试；`429` → 显示限速说明（含“稍后重试”）。所有字符串走 react-i18next，键加到全部 locale。

5. **判据 `server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`（红先行；真实 express `listen(0)` + `fetch`，形制照 `server/modules/oauth/tests/oauth-consent-page.test.ts`）**：单一可变 `let nowMs` 与 `now = () => new Date(nowMs)`；假 `clients`/`provider`/`verifyCredentials`（如 `verifyCredentials = async (u, p) => p === 'correct-horse' ? {ok:true} : {ok:false}`），`provider.authorize` 用间谍计数；把 `createOAuthAuthorizeApiRouter(...)` 挂到裸 `app` 的 `/api/oauth/authorize`（判据自挂，或注入一个把 `req.user` 置为 `{id:1}` 的直通 middleware，不走真 JWT）。读数各自独立成断言并逐字 `console.log` 原始值：(a) 同来源连续 10 次错密码 → 前 10 次均非 429；第 11 次**这一次密码正确** → `429`，且该次 `provider.authorize` 间谍为 0、无 `redirectTo`（逐字写 11 个状态码）；(b) 承 (a) `nowMs += windowMs + 1`，POST 正确密码 → 200 且带 `redirectTo`（窗口恢复，逐字写推进量）；(c) `trustProxy: true`：来源 A（`CF-Connecting-IP: 1.1.1.1`）第 11 次 → 429，同服务器来源 B（`2.2.2.2`）首次 → 非 429；(d) 未配置代理：10 次失败在伪造 `CF-Connecting-IP: 9.9.9.9` 与 `8.8.8.8`（并混入仅带 `X-Forwarded-For: 7.7.7.7`）之间交替 → 第 11 次（即使密码正确）→ 429；(e) `trustProxy: true` 下 A、B 各失败 5 次，A 用正确密码成功 → 200，随后 B 再失败 6 次其**第 6 次** → 429（B 的 5 仍在），且 A 自身计数被重置（A 再失败 10 次才 429）。逐字写出两来源各次状态码。

6. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：(i) `source` 无条件信任 `CF-Connecting-IP`（无视 `trustProxy`）⇒ (d) 必须红；(ii) 成功时清零**全部**桶（`resetSource` 清空整张 `Map`）⇒ (e) 必须红；(iii) 窗口永不过期（去掉 `now - windowStart >= windowMs` 的重置）⇒ (b) 必须红。每条记录变异前后 `git diff`、判据逐字失败行、恢复命令（`git checkout -- <file>` 或反向 patch），恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（机制去重）：`grep -rln "^goal_ac: AC-261$" tasks/` 只命中 `gap-ac261-oauth-consent-ratelimit`（done，即上文被删掉的那次实现；按「done 不算重复、是早先修复未保持的证据」立案）。相邻但不同机制、不再重复立案的：`gap-oauth-consent-spa-backend-contract`（done，SPA 后端契约；本任务在其 `/decision` 上恢复密码确认与限速，不改其 JSON 契约字段名）与 `gap-oauth-consent-spa-ui`（done，SPA 前端半；本任务在其页面加一处密码确认输入）。AC-260 判据 `oauth-consent-page.test.ts` 仍绿、不在本任务范围（只读不动）；AC-262（元数据与挂载、`app.set('trust proxy', …)` 全局接线）、AC-263（/mcp 认证）、AC-264+ 是不同端点/不同判据。AC-261 判据自足：真实 `listen(0)` + 注入来源头与注入时钟 + 假凭据校验，不取真实 DB、不挂 `server/index.ts`。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 `for f in server/modules/oauth/tests/oauth-consent-ratelimit.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`（写下完整命令与完整输出）。
  - 运行树：分支点树 —— `git -C <worktree> archive develop | tar -x -C /tmp/ac261-baseline-develop`（develop = db8743d2，即本任务的分支点；判据文件只存在于本任务分支，故「改动前」即分支点）。`server/modules/oauth/tests/` 下同目录 11 个既有文件俱在，唯独本判据缺席。
  - 命令（逐字，上面的 for 闸 + `npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`）
  - 输出（逐字，stderr）：`缺判据文件：server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`
  - 退出码：**1**（存在性闸即退出，`npx tsx` 未被执行）。
- [x] AC2 判据绿：同一条 AC-261 命令退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
  - 命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`（工作树内）→ **EXIT=0**
  - 读数（逐字）：`ℹ tests 4` / `ℹ pass 4` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 0`。
- [x] AC3 (a) 同来源连续 10 次错密码后，第 11 次（这次密码正确）→ 429；前 10 次非 429；第 11 次 `provider.authorize` 间谍计数为 0 且无 `redirectTo`；逐字写出 11 个状态码。
  - 逐字读数：`(a) statuses=401,401,401,401,401,401,401,401,401,401,429; the 11th carried the correct password and answered 429; authorizeCalls=0; redirectTo=null`
  - 判据断言：前 10 个状态码均 `!== 429`；第 11 次 `=== 429`；`provider.authorize` 间谍计数 `=== 0`；响应体无 `redirectTo`。
- [x] AC4 (b) `nowMs += windowMs + 1` 后同来源 POST 正确密码 → 200（含 `redirectTo`），不再 429；逐字写出推进量与状态码。
  - 逐字读数：`(b) nowMs += 900001; same source POST correct password -> 200; redirectTo="https://app.example/cb?code=code-1&state=state-1"; authorizeCalls=1`
  - 推进量 `windowMs + 1 = 15*60*1000 + 1 = 900001` ms；状态码 200，`redirectTo` 非空，`authorizeCalls=1`。
- [x] AC5 (c) `trustProxy: true` 下来源 A（`CF-Connecting-IP: 1.1.1.1`）第 11 次 → 429，来源 B（`2.2.2.2`）首次 → 非 429（各自独立计数）；逐字写出。
  - 逐字读数：`(c) source A(1.1.1.1) statuses=401,401,401,401,401,401,401,401,401,401,429; source B(2.2.2.2) first=200 redirectTo="https://app.example/cb?code=code-1&state=state-1"`
- [x] AC6 (d) 未配置代理时伪造的 `CF-Connecting-IP`/`X-Forwarded-For` 不改变来源：10 次失败在 `9.9.9.9` 与 `8.8.8.8`（及仅 `X-Forwarded-For: 7.7.7.7`）间交替，第 11 次 → 429；逐字写出伪造头值与状态码。
  - 逐字读数：`(d) forged headers per attempt={"CF-Connecting-IP":"9.9.9.9"} {"CF-Connecting-IP":"8.8.8.8"} {"X-Forwarded-For":"7.7.7.7"} {"CF-Connecting-IP":"9.9.9.9"} {"CF-Connecting-IP":"8.8.8.8"} {"X-Forwarded-For":"7.7.7.7"} {"CF-Connecting-IP":"9.9.9.9"} {"CF-Connecting-IP":"8.8.8.8"} {"X-Forwarded-For":"7.7.7.7"} {"CF-Connecting-IP":"9.9.9.9"}; statuses=401,401,401,401,401,401,401,401,401,401,429; the 11th answered 429`
  - 全部 10 次伪造头都落在同一桶（socket 远端地址），第 11 次（密码正确）仍 429。
- [x] AC7 (e) A、B 各失败 5 次后 A 用正确密码成功（200），B 再失败 6 次其第 6 次 → 429（B 桶未被清零），且 A 自身计数被重置（A 再失败 10 次才 429）；逐字写出两来源各次状态码。
  - 逐字读数：`(e) A failures=401,401,401,401,401; B failures=401,401,401,401,401; A success=200 (redirectTo="https://app.example/cb?code=code-1&state=state-1"); B next six=401,401,401,401,401,429; A next eleven=401,401,401,401,401,401,401,401,401,401,429`
  - B 的 5 次在 A 成功之后仍在（第 6 次 → 429）；A 的计数确被清零（再 10 次才 429）。
- [x] AC8 取假形态三条先红后恢复（逐条记录变异 diff、逐字失败行、恢复命令）：(i) 无条件信任 `CF-Connecting-IP` ⇒ AC6 红；(ii) 成功清零全部桶 ⇒ AC7 红；(iii) 窗口永不过期 ⇒ AC4 红；每条恢复命令 + 恢复后重跑回绿。
  - 前置：实现先提交（`e9c60b30`），故恢复命令一律是 `git checkout -- server/modules/oauth/oauth-consent-ratelimit.service.ts`。
  - **(i) 无条件信任 `CF-Connecting-IP`** —— diff：`-  if (trustProxy) {` / `+  if (trustProxy || true) {`（`resolveSource`）。运行读数：`✖ (d) without a trusted proxy, forged CF-Connecting-IP / X-Forwarded-For never change the source`；`(d) … statuses=401,401,401,401,401,401,401,401,401,401,200; the 11th answered 200`；失败行逐字：`AssertionError [ERR_ASSERTION]: the forged headers must not buy the client an extra identity` / `200 !== 429`；`ℹ tests 4 / pass 3 / fail 1`，EXIT=1。(a)(b)(c)(e) 仍绿——变异只动来源解析。(d) 红即 AC6 红。
  - **(ii) 成功清零全部桶** —— diff：`-      buckets.delete(source);` / `+      void source;` / `+      buckets.clear();`（`resetSource`）。运行读数：`✖ (e) a confirmed password clears only its own source`；`(e) … B next six=401,401,401,401,401,401; …`（B 的第 6 次不再是 429）；失败行逐字：`AssertionError [ERR_ASSERTION]: B must still be blocked on its eleventh attempt after A succeeded` / `401 !== 429`；`ℹ tests 4 / pass 3 / fail 1`，EXIT=1。(e) 红即 AC7 红。
  - **(iii) 窗口永不过期** —— diff：`-  const expired = (bucket: { windowStart: number }, time: number): boolean =>` / `-    time - bucket.windowStart >= windowMs;` / `+  const expired = (_bucket: { windowStart: number }, _time: number): boolean => false;`。运行读数：`✖ (a)+(b) ten failures block the source; the eleventh is 429 even with the right password; the next window admits it`；`(b) nowMs += 900001; same source POST correct password -> 429; redirectTo=null; authorizeCalls=0`；失败行逐字：`AssertionError [ERR_ASSERTION]: after the window, a correct password must be admitted` / `429 !== 200`；`ℹ tests 4 / pass 3 / fail 1`，EXIT=1。(b) 红即 AC4 红。
  - 三条各自恢复后重跑：`git diff --stat -- <file>` 为空（字节级复原），判据 **EXIT=0 / tests 4 / pass 4 / fail 0**（三条各一次，逐条确认回绿）。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；AC-260 判据 `server/modules/oauth/tests/oauth-consent-page.test.ts` 不改一字仍绿；SPA 前端判据 `src/modules/oauth-consent/tests/oauthConsentPage.test.tsx` 与两条 e2e（`e2e/oauth-consent-page.spec.ts`、`server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts`）按新增的密码确认同步后仍绿；新增 `server/**/*.test.ts` 触发的计数钉死值（`server/shared/tests/quay-test-script.test.ts`）已同步。
  - `npm run typecheck` → **EXIT=0**（`tsc --noEmit -p tsconfig.json && -p server/tsconfig.json && -p scripts/tsconfig.json`，无输出）。
  - `npm run lint` → **EXIT=0**；`: error ` 计数 **0**，`: warning ` 计数 **227**（与改动前同量；无新增 `error`）。
  - AC-260 判据未改一字：`git diff --stat develop...HEAD -- server/modules/oauth/tests/oauth-consent-page.test.ts` 为空；运行 → **EXIT=0 / `ℹ tests 13` / `ℹ pass 13` / `ℹ fail 0`**（与 AC-261 判据合计 17/17）。
  - SPA 前端判据 `npx vitest run src/modules/oauth-consent/tests/oauthConsentPage.test.tsx` → **EXIT=0 / `Test Files 1 passed (1)` / `Tests 12 passed (12)`**。
  - e2e 实浏览器：`npx playwright test e2e/oauth-consent-page.spec.ts` → **EXIT=0 / `1 passed`**；逐字读数 `(b) the confirmation field gated Allow: disabled before the password was re-entered=true, enabled after=true`，且 (g) 各 locale key 数 29 一致、(f) 375x812 `scrollWidth=375 clientWidth=375`。
  - e2e 实服务（真 `server/index.ts` + 真 bcrypt 账户）：`server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts` → **EXIT=0 / 1 pass**；新增反例 (e4) 逐字 `[e4] POST /api/oauth/authorize/decision (wrong confirmation password) -> 401 {"error":"invalid_credentials","error_description":"Incorrect username or password"}`。
  - 计数钉死值已同步：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → **EXIT=0 / `ℹ tests 11` / `ℹ pass 11` / `ℹ fail 0`**（`known=3 unknown=247`、`known=1 unknown=249`）。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。
  - `git diff --stat develop...HEAD`：**24 files changed, 922 insertions(+), 47 deletions(-)**。
  - 清单 ↔ Touches 对齐：`server/modules/oauth/oauth-consent-ratelimit.service.ts`(new)、`server/modules/oauth/oauth-consent.routes.ts`、`server/modules/oauth/oauth-server.mount.ts`、`server/index.ts`、`server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`(new)、`src/shared/types.ts`、`src/modules/oauth-consent/OAuthConsentRoute.tsx`、`src/modules/oauth-consent/hooks/useOAuthConsent.ts`、`src/modules/oauth-consent/tests/oauthConsentPage.test.tsx`、`e2e/oauth-consent-page.spec.ts`、`server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts`、`server/shared/tests/quay-test-script.test.ts`（12 条），加上 `src/modules/i18n/locales/*/consent.json` 一条 glob 覆盖 diffstat 里的 12 个 locale 文件 = 24；`tasks/gap-ac261-consent-password-ratelimit-restore.md` 为本任务自身（在 store 分支上，不入 diffstat）。

## DoD

- 限速**真的**按来源生效：同一来源第 11 次真收到 429（即使密码正确），且该次真未签发授权码（`provider.authorize` 间谍为 0）；变异掉窗口过期后 (b) 真变红。
- 来源判定**真的**尊重 `TRUST_PROXY`：未配置时伪造的 `CF-Connecting-IP`/`X-Forwarded-For` 真不改变来源（请求真共享同一桶），配置时 `CF-Connecting-IP` 真成为限速键且不同来源真各自独立；变异成无条件信任头后 (d) 真变红。
- 成功确认**真的**只重置本来源（其他来源的桶真不受影响），且本来源失败计数真被清零；变异成清零全部桶后 (e) 真变红。
- 密码确认**真的**在 SPA 授权流里端到端可用：允许前要求重新输入密码，错密码 401 且不授权，正确密码才授权；SPA 判据与两条 e2e 在真实浏览器/真实 HTTP 下走通（不是只让服务端单测绿）。用真实 served 页面/真实后端实测，不以 fixture 冒充。
- 接入**真的**不破坏既有面：AC-260 的转义、scope 词表、未登记回调用例与防嵌套/不缓存头不变，其判据不改一字仍通过。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（服务落 oauth 模块、路由只解析/调用/响应、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 `$frontend-module-standards` 及 AGENTS.md；不引入新依赖；不越界实现 AC-258/AC-259/AC-260 与 AC-262–AC-270。

## Touches

- server/modules/oauth/oauth-consent-ratelimit.service.ts (new)（每来源密码限速器，`now`/`trustProxy` 可注入）
- server/modules/oauth/oauth-consent.routes.ts（`/decision` 的 allow 分支接入凭据确认与限速）
- server/modules/oauth/oauth-server.mount.ts（`MountOAuthServerDeps` 增加 `credentialVerifier` 并传给 JSON API 路由器）
- server/index.ts（把 auth barrel 的 `credentialVerifier` 注入 `mountOAuthServer`）
- server/modules/oauth/tests/oauth-consent-ratelimit.test.ts (new)（AC-261 判据）
- src/shared/types.ts（`OAuthConsentDecisionRequest` 增加 `password` 字段：Allow 的密码确认，空值即失败确认、绝不旁路）
- src/modules/oauth-consent/OAuthConsentRoute.tsx（Allow 前的密码确认字段）
- src/modules/oauth-consent/hooks/useOAuthConsent.ts（decision body 增加 `password`）
- src/modules/oauth-consent/tests/oauthConsentPage.test.tsx（前端判据同步密码确认）
- src/modules/i18n/locales/*/consent.json（新增密码确认与限速文案键 `passwordLabel`/`passwordHint`/`errors.invalidCredentials`/`errors.rateLimited`，全部 12 个 locale）
- e2e/oauth-consent-page.spec.ts（e2e 决策带密码确认）
- server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts（e2e 决策带密码确认）
- server/shared/tests/quay-test-script.test.ts（新增 server 测试文件的计数钉死值同步）
- tasks/gap-ac261-consent-password-ratelimit-restore.md（本任务自身）

## Notes

- **这是「让判据重新为真」的立案（驱动默认 a），不是把 AC 退役**。退役（`superseded`）需人工授权（对照 AC-122：worker 执行 + 理由含「人 yale …授权退役」）。本任务把该保证重建在 SPA 面上；若人裁定接受无密码的会话式授权，请另走 supersede + 替代读数，而不要让它长期红着。
- 依赖方向：AC-260（授权页其余语义）与两个 SPA 任务均已 done，本任务在其之上加缝；`credential-verifier.ts` 与其 barrel 导出已存在、当前无消费者——本任务正是它的消费方，**不要**新建第二份。
- 写假形态注意：新增 `server/**/*.test.ts` 会令测试文件计数钉死判据全线变红（内存 `quay-test-script-pins-the-exact-server-test-file-count`），故把 `server/shared/tests/quay-test-script.test.ts` 列入 Touches 并同步其 known/unknown 两个数。若接入使某处 `vi.mock` 的整体工厂失效（内存 `adding-an-export-reds-sibling-wholesale-vimocks`），把该测试文件补进 Touches。
- `TRUST_PROXY` 的全局 `app.set('trust proxy', …)` 属 AC-262，不在本任务；本任务限速器只读 `TRUST_PROXY` 环境或注入的 `trustProxy`，判据直接注入该选项，不依赖全局接线。
- 固定窗口（非滑动）即可满足 (a)–(e)；判据用注入时钟推进，不睡真时间。429 响应沿用本面既有的防嵌套/不缓存头，另加 `Retry-After`。
- 内存提示：`labels`/`goal_ac` 等 frontmatter 字段的写入面由 pre-commit 守卫校验（delivery-critical 才强制 `goal_ac`；本任务非 delivery-critical，但仍带上 `goal_ac: AC-261` 以便驱动下一轮独立核验）。

### 实现记录（本轮）

- 密码/限速整块**以 `options.verifyCredentials !== undefined` 为闸**：不注入校验器的挂载（AC-260 的判据）逐字节不变——这是让「Allow 必须带密码」与「AC-260 判据不改一字仍绿」两条同时成立的关键，AC9 已实测二者并行绿。
- 凭据校验走既有窄口 `createCredentialVerifier`（auth barrel 的 `credentialVerifier`），未新建第二份实现、未引入新依赖。
- 前端把 401 `invalid_credentials` 与 429 `too_many_requests` 作为**就地可重试**错误（`submitError`，决策仍在屏上），与「会话失效」的 401（页面级 `consent-error`，无 Allow）区分；区分依据是 RFC 6749 的 `error` 码，不是状态码。
- 12 个 locale 的 `consent.json` 用文本插入补键（保留各文件既有格式与尾换行），插入后逐文件 `JSON.parse` 校验并断言 12 个 locale 的顶层与 `errors` 键集与 `en` 完全一致（Playwright (g) 腿亦独立复核 29 键 × 12 locale）。
- `oauth-flow.e2e.test.ts` 的种子账户原用占位串 `'placeholder-hash'`（当时注释称密码未被使用）；本任务起密码**被真正校验**，故改为 `bcrypt.hashSync('oauth-e2e-password', 10)` 的真题哈希。
- 计数钉死值：`server/shared/tests/quay-test-script.test.ts` 的 `known=3 unknown=246` → `247`、`known=1 unknown=248` → `249`（新增 1 个 server 判据文件）。
