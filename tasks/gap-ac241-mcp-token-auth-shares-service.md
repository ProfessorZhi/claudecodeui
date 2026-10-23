---
id: gap-ac241-mcp-token-auth-shares-service
title: AC-241 /mcp 令牌认证与 token-info 共用一个令牌服务：无效令牌一律同一个 401、有效放行、吊销即时生效、last_used
  与 userId 进上下文；判据 server/modules/mcp-gateway/tests/mcp-auth.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac239-sdk-zod-declared-in-dependencies
  - gap-ac240-mcp-stateless-transport-mount-order
goal_ac: AC-241
---
## Proposal

AC-241（GOAL-020 退出条件 3；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §303、§318、§320、§522）要求 `/mcp` 只接受有效令牌：无 Authorization、非 Bearer 方案、空令牌、未知令牌、过期令牌、已吊销令牌、前缀不是 `ccp_` 的令牌一律同一个 401 且响应体逐字相同（不泄露拒绝原因）；有效令牌放行；吊销在下一次请求即生效（不重启、无缓存）；校验经过的必须就是 `GET /api/oauth/token-info` 所用的那个令牌服务实例（注入计数间谍证明两处共用一个，网关里没有第二份校验逻辑）；校验通过后 `last_used` 被更新，调用方的用户 id 被带进工具上下文而非 null。判据文件 `server/modules/mcp-gateway/tests/mcp-auth.test.ts` 当前不存在，AC-241 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-auth.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/` 目录不存在（由 AC-240 创建）；`server/index.ts:257` 用内联的 `createAccessTokensService({ now: () => new Date() })` 构造了一个**只给 token-info 用**的令牌服务实例，该实例没有变量名、无法被第二处复用；`/mcp` 尚无任何认证。`server/modules/oauth/access-tokens.service.ts` 的 `verifyToken(token)` 每调用一次都重新查库（`accessTokensDb.findByHash`）并检查 `revoked_at` / 比较 `expires_at`，成功时 `updateLastUsed`——这正是「吊销即时生效、无缓存」所依赖的机制，本任务必须复用它而不是在网关重写。`server/modules/oauth/token-info.routes.ts` 有模块私有的 `bearerToken(header)` 帮助函数与前置常量 `BEARER_PREFIX`，以及本任务要复用的 401 体 `{ error: 'A valid personal access token is required', code: 'ACCESS_TOKEN_INVALID' }`。

要交付：

1. **令牌认证中间件（新文件 `server/modules/mcp-gateway/mcp-gateway.auth.ts`；遵守 `$backend-module-standards`）**：
   - `createMcpAuthMiddleware(tokens: AccessTokensService): express.RequestHandler`——从 `Authorization` 头解析 `Bearer <token>`（与 token-info 同一套解析：`Bearer ` 前缀、`trim()`、非空）；任何解析失败，或 `tokens.verifyToken(token)` 返回 `!ok`，一律 `res.status(401).json({ error: 'A valid personal access token is required', code: 'ACCESS_TOKEN_INVALID' })` 并 return；**不按 `reason` 分支、不把 reason 写进响应**——五种 `AccessTokenRejectionReason`、缺头、非 Bearer、空令牌全部走同一条 `res.status(401).json(同一个对象常量)`。
   - 成功时把主体挂到请求上供工具上下文读取：`res.locals.mcpPrincipal = { userId: verified.userId, scopes: verified.scopes }`，然后 `next()`。
   - 导出 `readMcpPrincipal(res: express.Response): McpPrincipal | null` 与类型 `McpPrincipal = { userId: number; scopes: string[] }`——传输在派发工具时读它构造 `ControlCaller`（`{ userId, via: 'mcp' }`）；本任务只证明它非 null 且 `userId` 是令牌属主，工具本身在 AC-245+ 落地。
   - `AccessTokensService` 类型从 `@/modules/oauth/index.js` 导入（跨模块只经 barrel）。
   - **不 import `accessTokensDb`、不 `createHash`、不碰数据库**——校验只有注入的 service 一份。
2. **Bearer 解析提为共享工具（`server/shared/utils.ts`）**：`token-info.routes.ts` 的私有 `bearerToken`（连同 `BEARER_PREFIX` 常量）现在有两个消费者（token-info route 与 mcp auth 中间件），按 `$backend-module-standards`「≥2 处使用 → `server/shared/utils.ts`」把它移到 `server/shared/utils.ts` 并导出，`token-info.routes.ts` 与 `mcp-gateway.auth.ts` 都从 shared 导入。行为逐字不变，既有 `server/modules/oauth/tests/token-info.routes.test.ts` 不改一字仍绿。
3. **接线：网关与 token-info 共用一个实例（`server/index.ts`）**：把 `:257` 的内联构造提为局部常量
   `const accessTokensService = createAccessTokensService({ now: () => new Date() });`
   然后 `app.use('/api/oauth', createTokenInfoRouter(accessTokensService));`；再把**同一个** `accessTokensService` 经 AC-240 落地的认证缝传给 `/mcp`。以 AC-240 实际落地的 deps 形状为准：若该缝是 `deps.authorize: RequestHandler`，则 `mountMcpGateway(app, { authorize: createMcpAuthMiddleware(accessTokensService), ... })`；若该缝是 `deps.tokens`，则直接把实例传下去、由传输内部调用 `createMcpAuthMiddleware`。装配点仍是 `server/index.ts` 这一处，`mountMcpGateway` 的调用位置保持 AC-240 的「静态路由 `createStaticAssetsMiddleware` 之前」。若 AC-240 的缝要求传输内部改一行才能读主体，先用 `task_write` 把 `server/modules/mcp-gateway/mcp-gateway.transport.ts` 加进本任务 `## Touches` 再改（`quay-touches-must-match-actual-write-sites`）。
4. **判据文件 `server/modules/mcp-gateway/tests/mcp-auth.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + 真实 better-sqlite3 临时库，形制照 `server/modules/oauth/tests/token-info.routes.test.ts`）**：`mkdtemp` 建临时目录、`closeConnection()`、`process.env.DATABASE_PATH` 指向 `auth.db`、`initializeDatabase()`、插 owner 用户行（`access_tokens.user_id` 外键），用注入时钟的 `createAccessTokensService` 发真令牌；HTTP 调用用 `node:http`（**不用 `fetch`**——`listen(0)` 会抽到 undici 拒绝的固定端口，见 AC-240 同款说明）。在同一 app 上同时挂 `createTokenInfoRouter(spy)`（`/api/oauth`）与 `mountMcpGateway`（`MCP_ENABLED=true`），其中 `spy` 是包住真 service 的计数代理（`verifyToken` 委托真 service 并计数/记录收到的 token，可切到 stub 模式）。读数各写成独立断言并逐字写出原始值：
   - (a) **同一个 401 体，不泄露原因**：对 `/mcp` 逐个发——无 Authorization、`Basic <valid>`、`Bearer `（空令牌）、未知 `ccp_<64 hex>`、过期令牌（发 7 天后 `advanceDays(7)`）、已吊销令牌、前缀不对 `cca_<64 hex>`。每个都得 401，且**七个响应体字节逐一相同**，并等于 `/token-info` 的 401 体 `{"error":"A valid personal access token is required","code":"ACCESS_TOKEN_INVALID"}`（逐字列出七条原始体）。
   - (b) **有效令牌放行**：`POST /mcp` 带 `Authorization: Bearer <valid>`、body 为 JSON-RPC `tools/list`，得 200 且 JSON-RPC 有 `result`；content-type 是 `application/json` 或 `text/event-stream`（此读数是 (a) 的正例对照，防止「一律 401」也通过）。
   - (c) **吊销即时生效、无缓存**：同一运行中的服务器，先带 valid 令牌 `POST /mcp` 得 200，`tokens.revokeToken(id)` 后**下一次**同一令牌 `POST /mcp` 得 401（不重启、未重挂载）；写下 revoke 前后状态码与 `revokeToken` 返回。
   - (d) **共用一个实例、无第二份校验**：`spy` 记录 `verifyToken` 调用次数与收到的 token；`createTokenInfoRouter(spy)` 与网关收到的是**同一个 spy 对象**（写下对象身份判定）。`GET /api/oauth/token-info`（带 valid）一次后计数 +1，`POST /mcp`（带 valid）一次后再 +1（写下两次计数）。No-second-validation 两向对照：把 spy 切到 stub 返回 `{ ok: true, userId: 42, scopes: ['cloudcli:read'], expiresAt }`（对一个真 service 会拒的 token，如 `ccp_<64 hex>`）⇒ `/mcp` 得 200（网关完全听注入 service 的裁决）；再把 spy 切成对**真 valid 令牌**返回 `{ ok:false, reason:'not_found' }` ⇒ `/mcp` 得 401（网关无从旁路放行）。源码级对照：`grep -nE "sha256|createHash|findByHash|accessTokensDb" server/modules/mcp-gateway/mcp-gateway.auth.ts` 为空，而 `server/modules/oauth/access-tokens.service.ts` 命中 ≥1（正例对照，证明扫描器有效）。
   - (e) **last_used 更新 + userId 进上下文非 null**：`POST /mcp`（valid）得 200 后，直接查库读该行 `last_used`，断言非 null 且 ≥ 签发时刻（写下前后值）；并断言成功请求上下文的 `readMcpPrincipal(res)`（挂在同一认证中间件后的探针路由读回）深等于 `{ userId: <owner>, scopes: [...token scopes] }`，`userId` 不是 null。
5. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 网关缓存校验结果（在中间件里按 token 字符串 memoize `verifyToken` 结果）⇒ (c) 必须红（吊销后仍 200）；
   (ii) 按拒绝原因返回不同的 401 体（例如把 `reason` 写进响应或改文案）⇒ (a) 必须红；
   (iii) 网关自带一份校验（不经注入 service，改用 `accessTokensDb` / 自算 hash）⇒ (d) 必须红（spy 不被调用，或出现旁路放行）。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑回绿。

<!-- dedup-ref -->
本任务与 AC-239（依赖声明）、AC-240（传输与认证缝）机制不同：AC-239 改 `package.json` / lock，AC-240 造传输与认证缝且其 dedup 段已声明「AC-241 用真实令牌校验替换该缝」。本任务在既有 `AccessTokensService` 之上接入令牌认证并接线共用一个实例，不重写传输、不做回环（AC-242）、scope 词汇校验（AC-243）、审计（AC-244）、工具（AC-245+）、设置页、冒烟。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-240 未落地则无 `mountMcpGateway` 与该缝，AC-239 未落地则 SDK 未声明进 dependencies。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-241 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-auth.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-auth.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-auth.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 七种无效形态（无头 / 非 Bearer / 空令牌 / 未知 / 过期 / 已吊销 / 前缀不对）全部 401，七个响应体字节逐一相同且等于 token-info 的 401 体；逐字列出七条原始体。
- [x] AC4 (b) 有效令牌 `POST /mcp`（`tools/list`）得 200 且 JSON-RPC 有 `result`，content-type 为 JSON 或 SSE；写下状态码与 content-type（正例对照）。
- [x] AC5 (c) 同一运行中服务器：revoke 后**下一次**请求即 401（不重启、无缓存）；写下 revoke 前后两次状态码与 `revokeToken` 返回。
- [x] AC6 (d) 计数间谍证明 token-info 与 `/mcp` 收到同一 service 对象且两次 `verifyToken` 计数递增；stub 两向对照（网关听注入裁决、无旁路放行）；源码级 grep 网关 auth 文件无 `sha256|createHash|findByHash|accessTokensDb` 而 oauth service 有（正例对照）；逐字写下计数、对象身份、两向状态码与两组 grep 读数。
- [x] AC7 (e) 成功请求后该行 `last_used` 非 null 且 ≥ 签发时刻；上下文 `readMcpPrincipal`（探针路由读回）`userId === owner` 且非 null、scopes 正确；逐字写下前后 `last_used` 与读回主体。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 网关缓存 ⇒ AC5 红；(ii) 按 reason 不同 401 体 ⇒ AC3 红；(iii) 网关自带校验 ⇒ AC6 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`server/modules/oauth/tests/token-info.routes.test.ts` 不改一字仍逐字通过；`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；跨模块只经 barrel，≥2 处使用的 `bearerToken` 已进 `server/shared/utils.ts`。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- `/mcp` 真的只放行有效令牌：判据用真实 HTTP + 真实库 + 真实 service 驱动，七种无效形态同一个 401 体、有效 200——不是「判据文件存在」就算数。
- 吊销真的即时：同一运行中的服务器上 revoke 后下一次请求即 401（真库 `revoked_at` 被 `verifyToken` 每次重读），无缓存。
- 校验真的只有一份：计数间谍在**同一个对象**上同时承载 token-info 与 `/mcp` 的 `verifyToken`，两向 stub 对照证明网关裁决完全来自注入 service，源码级 grep 证明网关不碰库、不重算 hash。
- `last_used` 真被更新、调用方 `userId` 真进请求上下文且非 null（从真库与真响应读回，非夹具）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、≥2 处用的工具进 `server/shared/utils.ts`、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不越界实现 AC-242–AC-257。

## Touches

- server/index.ts
- server/modules/mcp-gateway/mcp-gateway.auth.ts (new)
- server/modules/mcp-gateway/index.ts
- server/shared/utils.ts
- server/modules/oauth/token-info.routes.ts
- server/modules/mcp-gateway/tests/mcp-auth.test.ts (new)（判据）
- tasks/gap-ac241-mcp-token-auth-shares-service.md

## Notes

- 判据的 HTTP 调用用 `node:http` 不用 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（见 `server/modules/debug-agent/tests/debug-agent-control-plane.test.ts` 与 AC-240 的同款说明）。既有 `token-info.routes.test.ts` 用了 `fetch` 但未命中坏端口，本判据按 AC-240 的更稳做法。
- 令牌服务实例必须**只有一个**：`server/index.ts` 提为局部常量后同时喂给 `createTokenInfoRouter` 与 `mountMcpGateway`，这是 (d) 的接线前提；网关不得自行 `createAccessTokensService`。
- `readMcpPrincipal` 是给 AC-245+ 工具消费的接缝（`ControlCaller.userId`），本任务只钉「成功请求后它非 null 且等于属主」，工具注册在 AC-245 落地。