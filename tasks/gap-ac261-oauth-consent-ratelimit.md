---
id: gap-ac261-oauth-consent-ratelimit
title: AC-261 授权页密码提交限速：每来源每 15 分钟 10 次（第 11 次即使密码正确也 429），TRUST_PROXY 下来源取
  CF-Connecting-IP、未配置时伪造头无效；判据
  server/modules/oauth/tests/oauth-consent-ratelimit.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac260-oauth-consent-page
goal_ac: AC-261
---
## Proposal

GOAL-021 退出条件 3（AC-261）要求在授权页的密码提交上有限速：**每个来源每 15 分钟 10 次失败**，来源在配置了 `TRUST_PROXY` 时取 `CF-Connecting-IP`，未配置时取 socket 远端地址（伪造的 `CF-Connecting-IP`、`X-Forwarded-For` 不改变来源）。出处：SPEC `docs/proposals/mcp-gateway-SPEC.md`（v3.1）§419「限速：授权页密码提交每来源每 15 分钟 10 次」、§420「真实来源：cloudflared 从 docker 网桥连入，`req.ip` 恒为网桥地址；新增 `TRUST_PROXY`（交给 `app.set('trust proxy', …)`），限速键优先用 `CF-Connecting-IP`」、§499 配置表。

红态基线（已实测）：判据文件 `server/modules/oauth/tests/oauth-consent-ratelimit.test.ts` 不存在，存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`；`grep -rn "429\|限速\|rateLimit\|ratelimit\|TRUST_PROXY\|CF-Connecting-IP\|trustProxy" server/modules/oauth/ --include=*.ts` 为空；`grep -rl "^goal_ac: AC-261$" tasks/` 为空。

**真实前置**（frontmatter `depends_on: gap-ac260-oauth-consent-page` 已声明）：AC-260（授权页，todo）交 `createOAuthConsentRouter({ provider, clients, verifyCredentials, now?, csrfStore? })` 与 POST `/authorize` 的密码分支（CSRF 校验 → `action=deny|allow`；`allow` 时 `verifyCredentials(username,password)`：`{ok:false}`/空密码 → 401、`{ok:true}` → `provider.authorize` 后 302）。本任务只在其上接入限速与来源判定：不重写转义/CSRF/scope/防嵌套头（AC-260）、不做端点挂载与 `app.set('trust proxy', …)` 全局接线（AC-262）、不做 DCR/设置/端到端（AC-264+）。

要交付：

1. **限速服务（新文件 `server/modules/oauth/oauth-consent-ratelimit.service.ts`；TS、遵守 `$backend-module-standards`）**：`createConsentPasswordRateLimiter({ now?, windowMs?, maxAttempts?, trustProxy? })` 返回对象，`now` 可注入（默认 `() => new Date()`），`windowMs` 默认 `15 * 60 * 1000`，`maxAttempts` 默认 `10`，`trustProxy` 默认取 `String(process.env.TRUST_PROXY ?? '').trim() !== ''`：
   - `source(req)` → 来源键（字符串）：
     - `trustProxy` 为假：**只用** `req.socket?.remoteAddress ?? 'unknown'`，忽略一切请求头（伪造的 `CF-Connecting-IP`、`X-Forwarded-For` 一律无效）。
     - `trustProxy` 为真：优先 `req.get('CF-Connecting-IP')`（`trim()` 后非空）；缺失/空白时回退 `req.socket?.remoteAddress ?? 'unknown'`。
   - `isBlocked(source)` → 布尔。按来源做**固定窗口**计数：`Map<source, { count; windowStart }>`；当 `now() - windowStart >= windowMs` 视为窗口已过期（先清掉该来源计数再判）。
   - `recordFailure(source)` → 窗口过期则重置为 `{ count: 1, windowStart: now() }`，否则 `count++`。
   - `resetSource(source)` → **只删该来源**的计数（成功登录时调用），不得影响其他来源的桶。
   - `retryAfterMs(source)` → 该来源窗口剩余毫秒（用于 `Retry-After`）。
   顺带清理过期项以防无界增长。源解析可作模块内私有函数（无跨文件消费者则不导出）。

2. **授权页路由接入（修改 `server/modules/oauth/oauth-consent.routes.ts`，即 AC-260 的文件）**：`createOAuthConsentRouter({ provider, clients, verifyCredentials, now?, csrfStore?, trustProxy?, rateLimiter? })`——`trustProxy` 默认同服务默认；`rateLimiter` 可注入（默认以 `{ now, trustProxy }` 构建服务的限速器）。在 POST `/authorize` 的 `action === 'allow'` 分支、**CSRF 校验之后、`verifyCredentials` 之前**：
   - `const key = rateLimiter.source(req)`；若 `rateLimiter.isBlocked(key)` → `429` 错误页（HTML，含说明文字；推荐 `Retry-After: Math.ceil(retryAfterMs/1000)`），**不**调用 `verifyCredentials`、**不**调用 `provider.authorize`、**不**签发授权码、**不**跳转，并逐字保留 AC-260 的防嵌套/不缓存响应头。
   - `verifyCredentials` 返回 `{ ok:false }` 或密码为空 → `rateLimiter.recordFailure(key)` → 沿用 AC-260 的 `401`。
   - `verifyCredentials` 返回 `{ ok:true }` → `rateLimiter.resetSource(key)`（只重置本来源）→ 继续 AC-260 的 `provider.authorize` → 302。
   `action === 'deny'` 与 GET 不限速（不提交密码）。**不改** AC-260 的转义、CSRF、scope、头与 302 语义。

3. **判据文件 `server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`（红先行；真实 express `listen(0)` + `fetch`，形制照 `server/modules/oauth/tests/oauth-consent-page.test.ts` 与 `token-info.routes.test.ts`）**：单一可变 `let nowMs` 与 `now = () => new Date(nowMs)`；用假 `clients`/`provider`/`verifyCredentials`（限速读数只需真 HTTP，本任务不要求真实 DB；`provider.authorize` 用间谍计数）；每台被测服务器把 `createOAuthConsentRouter(...)` 挂到 `app` 的 `/oauth`，`listen(0)` 取端口。因 AC-260 的 csrf 令牌一次性，每次 POST 前先 GET `/oauth/authorize` 取一枚新 `csrf_token`。读数各自独立成断言并逐字 `console.log` 原始值：
   - (a) 未配置代理的服务器（默认）：同一来源（socket `127.0.0.1`）连续 10 次 POST 错密码（各带新 csrf）→ 前 10 次均非 429；第 11 次**这一次密码正确** → `429`，且该次 `provider.authorize` 间谍计数为 0、无授权码。逐字写出 11 个状态码。
   - (b) 窗口恢复：承 (a)，`nowMs += windowMs + 1`，POST 正确密码 → `302`（不再 429）。逐字写出推进量与状态码。
   - (c) `trustProxy: true` 的服务器：来源 A（`CF-Connecting-IP: 1.1.1.1`）连续 10 次错密码后第 11 次 → `429`；同服务器来源 B（`CF-Connecting-IP: 2.2.2.2`）首次 POST → **非** 429（各自独立计数）。逐字写出两来源的状态码。
   - (d) 未配置代理的服务器：10 次错密码在伪造的 `CF-Connecting-IP: 9.9.9.9` 与 `CF-Connecting-IP: 8.8.8.8`（并混入仅带 `X-Forwarded-For: 7.7.7.7` 的请求）之间交替分发 → 第 11 次（即使密码正确）→ `429`（所有请求共享 socket 同一个桶）。逐字写出伪造头值与状态码。
   - (e) 成功不重置其他来源：`trustProxy: true` 下来源 A（`1.1.1.1`）、B（`2.2.2.2`）各失败 5 次；A 用正确密码成功 → `302`；随后 B 再失败 6 次，**第 6 次** → `429`（B 的 5 仍在，5+6=11）；同时 A 成功后可再失败 10 次而第 11 次才 429（A 自身计数被重置）。逐字写出两来源各次状态码。
4. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 无条件信任 `CF-Connecting-IP`（`source` 恒取 `req.get('CF-Connecting-IP') || socket`，无视 `trustProxy`）⇒ (d) 必须红；
   (ii) 成功时清零**全部**桶（`resetSource` 清空整个 `Map`）⇒ (e) 必须红；
   (iii) 窗口永不过期（去掉 `now - windowStart >= windowMs` 的过期重置）⇒ (b) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令（`git checkout -- <file>` 或反向 patch），恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: AC-261" tasks/` 为空；`grep -rlE "限速|rate.?limit|ratelimit|CF-Connecting-IP|TRUST_PROXY|consent-ratelimit" tasks/` 只命中 AC-242（`/mcp` 回环守卫「转发头存在即 403」，不同端点、不同机制、不同判据）与 AC-260（授权页，明确把限速与真实来源让给 AC-261）。AC-258（存储）、AC-259（语义）、AC-260（授权页）是**前置**（`depends_on: gap-ac260-oauth-consent-page`，AC-260 自身依赖 AC-259/AC-258）；本任务只在其 POST `/authorize` 密码分支接入限速，不重写授权页其余语义。AC-262（元数据与挂载、`app.set('trust proxy', …)` 全局接线）、AC-263（/mcp 认证）、AC-264+（DCR/设置/端到端）是不同机制与不同判据文件。AC-261 判据自足：真实 express `listen(0)` + 伪造/注入的来源头 + 注入时钟，不取用真实 DB，不挂 `server/index.ts`。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-261 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/oauth/tests/oauth-consent-ratelimit.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-consent-ratelimit.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 同一来源 10 次错密码后，第 11 次（密码正确）→ 429；前 10 次非 429；第 11 次 `provider.authorize` 间谍计数为 0 且无授权码；逐字写出 11 个状态码。
- [x] AC4 (b) `nowMs += windowMs + 1` 后同来源 POST 正确密码 → 302（窗口恢复）；逐字写出推进量与状态码。
- [x] AC5 (c) `trustProxy: true` 下来源 A（`CF-Connecting-IP: 1.1.1.1`）第 11 次 → 429，来源 B（`2.2.2.2`）首次 → 非 429；逐字写出。
- [x] AC6 (d) 未配置代理时伪造的 `CF-Connecting-IP`/`X-Forwarded-For` 不改变来源：10 次失败在 `CF-Connecting-IP: 9.9.9.9` 与 `8.8.8.8`（及仅 `X-Forwarded-For: 7.7.7.7`）间交替，第 11 次 → 429；逐字写出伪造头值与状态码。
- [x] AC7 (e) A、B 各失败 5 次后 A 成功（302），B 再失败 6 次其第 6 次 → 429（B 桶未被清零），且 A 自身计数被重置（A 再失败 10 次才 429）；逐字写出两来源各次状态码。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 无条件信任 `CF-Connecting-IP` ⇒ AC6 红；(ii) 成功清零全部桶 ⇒ AC7 红；(iii) 窗口永不过期 ⇒ AC4 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`server/modules/oauth/tests/oauth-consent-page.test.ts`（AC-260 判据，不改一字仍逐字通过）、`server/modules/oauth/tests/oauth-provider.test.ts`、`server/modules/oauth/tests/oauth-store.test.ts`、`server/modules/oauth/tests/access-tokens.service.test.ts`、`server/modules/oauth/tests/token-info.routes.test.ts` 不改一字仍逐字通过。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 限速**真的**按来源生效：同一来源真在第 11 次收到 429（即使密码正确），且该次真未签发授权码（`provider.authorize` 间谍为 0）——不是「有计数器」就算数；变异掉窗口过期后 (b) 真变红。
- 来源判定**真的**尊重 `TRUST_PROXY`：未配置时伪造的 `CF-Connecting-IP`/`X-Forwarded-For` 真不改变来源（请求真共享同一桶），配置时 `CF-Connecting-IP` 真成为限速键且不同来源真各自独立；变异成无条件信任头后 (d) 真变红。
- 成功登录**真的**只重置本来源（其他来源的桶真不受影响），且本来源失败计数真被清零；变异成清零全部桶后 (e) 真变红。
- 窗口**真的**会过期：推进注入时钟超过窗口后同来源真恢复放行；变异成永不过期后 (b) 真变红。
- 接入**真的**不破坏 AC-260：转义、CSRF、scope、防嵌套/不缓存头、302 语义不变，AC-260 判据不改一字仍通过。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、服务落 oauth 模块、路由只解析/调用/响应、导出带消费方注释、不导出无消费者符号、≥2 处使用的工具进 `server/shared/utils.ts`）与 AGENTS.md；不引入新依赖；不越界实现 AC-258–AC-260 与 AC-262–AC-270。

## Touches

- server/modules/oauth/oauth-consent-ratelimit.service.ts (new)
- server/modules/oauth/oauth-consent.routes.ts
- server/modules/oauth/tests/oauth-consent-ratelimit.test.ts (new)（判据）
- tasks/gap-ac261-oauth-consent-ratelimit.md

## Notes

- 依赖顺序（frontmatter `depends_on: gap-ac260-oauth-consent-page` 已声明）：AC-260 未落地则无 POST `/authorize` 的密码分支可接入，本任务必红。若 AC-260 实际的 `createOAuthConsentRouter` 入参名/内部结构与本文不同，以实际写点为准调整接入缝与 Touches（内存 `quay-touches-must-match-actual-write-sites`）。
- `trustProxy` 默认取自 `process.env.TRUST_PROXY`（`trim()` 后非空即信任）；AC-262 挂载时会同时接好 `app.set('trust proxy', …)` 与显式 `trustProxy`。本任务不修改 `server/index.ts`。
- 固定窗口（非滑动）即可满足 (a)–(e)：第 11 次判定用 `count >= maxAttempts`，窗口过期用 `now - windowStart >= windowMs` 重置。判据用注入时钟推进，不睡真时间。
- 429 响应须同时保持 AC-260 的 `X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`、`Cache-Control: no-store`（AC-260 的响应头中间件覆盖所有响应），可另加 `Retry-After`。
- 每次 POST 需一枚新 csrf（AC-260 令牌一次性）；限速在 CSRF 之后，故 (a)–(e) 均按「GET 取 token 再 POST」驱动。
- **同文件并发**：`server/modules/oauth/oauth-consent.routes.ts` 亦在 AC-260 的 Touches 内；本任务须在 AC-260 落地后再动手，改动限于「加入限速分支与可选入参」。
- 新增测试文件可能被边界 lint 拦截（内存 `quay-boundaries-lint-blocks-new-test-files`）；判据文件已列入 `## Touches`。
- 本设计默认**不**新增 barrel 导出（限速工厂仅被同模块路由消费）；若实现选择经 `@/modules/oauth/index.js` 导出且使整体 `vi.mock` 的兄弟测试变红，按内存 `adding-an-export-reds-sibling-wholesale-vimocks` 把新导出补进对应 mock 工厂并把该测试文件加进 `## Touches`。
- 判据是本任务的机械读数，文件即 AC-261 `criterion:` 所点名的那个；不新建第二个判据文件。