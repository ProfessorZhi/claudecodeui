---
id: gap-ac268-oauth-e2e-flow
title: AC-268 端到端 OAuth 流程在真实 HTTP 上走通：临时实例（MCP_OAUTH_ENABLED
  开、MCP_DCR=open）一次运行里完成发现/注册/授权换码/换令牌/调用 /mcp/刷新/吊销后被拒，且错误密码、错误
  verifier、授权码重放三条反例同在；判据
  server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts
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
  - gap-ac260-oauth-consent-page
  - gap-ac262-oauth-metadata-endpoints
  - gap-ac263-oauth-mcp-challenge-audience
  - gap-ac264-oauth-dcr-policy-and-manual-clients
  - gap-ac265-oauth-settings-routes
  - gap-ac245-mcp-read-tools-fixture-readings
goal_ac: AC-268
---
## Proposal

AC-268（GOAL-021 退出条件 7「端到端（AC-268）：发现、注册、授权、换令牌、调用、刷新、吊销后被拒，正反例同一次运行」；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §403–§421「OAuth 流程 / 加固」、§148–§156「路由与挂载顺序」、§451「自动化判据不连生产 3001：临时端口起独立服务实例」）。判据由 AC 钉死，命令：

```
for f in server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts; do
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts
```

判据文件不存在 ⇒ 存在性闸退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts`（当前必红）。

本任务是 GOAL-021 的**集成/端到端**那一环，交付两样：

1. **补上无人认领的生产挂载（接线缺口）**：按 SPEC §150 的挂载清单，`/.well-known/*`（AC-262，`mountOAuthMetadata`）、`/oauth/register`（AC-264，`mountOAuthRegister`）、`/api/settings/oauth-grants|oauth-clients`（AC-265）、`/mcp` 的 OAuth 认证（AC-263）各自认领了挂载；但 **`/oauth/authorize`（授权页 GET/POST）与 `/oauth/token`、`/oauth/revoke` 三个端点的生产挂载当前无人认领**——AC-259 只交 provider 语义、AC-260 只交授权页路由、AC-262 明确只挂元数据、AC-264 只挂注册。本任务把这三个端点挂进 `server/index.ts` 的生产装配（位置在 `createStaticAssetsMiddleware` 之前），复用 AC-259 的 `createOAuthProvider` 与 AC-260 的授权页工厂（必要时经 `server/modules/oauth/index.ts` barrel 导出其可挂载形态），**不重实现**其背后的存储/语义/页面/DCR/设置。若兄弟任务最终自行认领了这些挂载，本任务只补缺口、复用其实际工厂，并按实际写点收敛 Touches。

2. **端到端判据 `server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts`（红先行）**：在临时端口起一个**真实** `server/index.ts` 实例（SPEC §451「临时实例」「不连生产 3001」），环境 `MCP_ENABLED=1`、`MCP_OAUTH_ENABLED=1`、`MCP_DCR=open`、`PUBLIC_BASE_URL=http://127.0.0.1:<port>`（127.0.0.1 属 SPEC 的 localhost https 例外）、`SERVER_PORT=<临时端口>`、`HOST=127.0.0.1`、`HOME=<临时目录>`、**显式覆盖** `DATABASE_PATH=<临时目录>/auth.db`（本 shell 导出真库路径，必须覆盖）。播种唯一 CloudCLI 用户（用户名 + bcrypt 密码哈希，使授权页 POST 经 auth 模块同一校验路径通过）。客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 的 OAuth 能力（`OAuthClientProvider`）或等价手写客户端（AC 允许二选一）；原始 HTTP 一律 `node:http`，不用 `fetch`（undici 端口黑名单）。读数：

   - (a) 元数据发现（两个 well-known 返回 JSON）→ DCR 注册拿 `client_id`（机密客户端另拿一次性 `client_secret`）→ `GET /oauth/authorize`（服务端渲染密码页，解析出 CSRF token）→ 带密码 + CSRF 的 POST（302 回 `redirect_uri` 带 `code`，PKCE S256 的 `code_challenge` 已提交）→ `/oauth/token` 用 `code` + `code_verifier` 换 access + refresh。
   - (b) 用 access token 调 `/mcp` 的 `tools/list` 与 `overview` 得到正确结果。
   - (c) 刷新得到新 access/refresh，旧 refresh 此后换令牌被拒。
   - (d) 经设置接口吊销该授权后，**同一个** access token 的下一次 `/mcp` 调用得到 401（正例对照：吊销前同一 token 为 200）。
   - (e) 反例同一次运行：错误密码拿不到 `code`、错误 `code_verifier` 换不到 token、`code` 重放被拒。

   每条读数逐字写出原始状态码/响应字段/拒绝原因。

取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 授权页跳过密码（POST 不校验密码即发 code）⇒ (e) 必须红；(ii) 吊销不级联（设置接口只标 grant、不使其令牌下一次 `/mcp` 被拒）⇒ (d) 必须红；(iii) 刷新后旧令牌仍有效（轮换不失效旧 refresh）⇒ (c) 必须红。每条恢复后重跑判据回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: AC-268" tasks/` 为空，本仓库无任何任务带 AC-268；判据文件 `oauth-flow.e2e.test.ts` 独属本任务。AC-258（存储/哈希/级联吊销，判据 oauth-store.test.ts）、AC-259（provider 语义，oauth-provider.test.ts）、AC-260（授权页，oauth-consent-page.test.ts）、AC-261（限速，oauth-consent-ratelimit.test.ts）、AC-262（元数据挂载，oauth-metadata-mount.test.ts）、AC-263（/mcp 认证，mcp-oauth-challenge.test.ts）、AC-264（DCR，oauth-dcr.test.ts）、AC-265（设置接口，oauth-settings.routes.test.ts）、AC-245（只读工具夹具读数，mcp-read-tools.test.ts）各是不同机制与不同判据文件；本任务复用它们的交付物、只补生产挂载缺口并写端到端判据，不重实现任一机制。frontmatter `depends_on` 列出上述 8 个任务为机械前置（本任务在它们落地后才能满足）。

## Plan

1. 红态基线：改动前运行 AC-268 判据命令，逐字记录退出码 1 与 `缺判据文件：…/oauth-flow.e2e.test.ts`。
2. 读已落地表面：`server/modules/oauth/index.ts`、`server/modules/mcp-gateway/index.ts` 的导出与 `server/index.ts` 现有挂载；确定 `/oauth/authorize|token|revoke` 是否已被兄弟挂载。缺则新建单一挂载工厂（`server/modules/oauth/oauth-server.mount.ts`）并从 `server/index.ts` 调用（静态路由之前）；已挂则复用。
3. 起真实临时实例：`mkdtemp`；子进程 `node_modules/.bin/tsx --tsconfig server/tsconfig.json server/index.ts`，env 显式覆盖 `HOME`/`DATABASE_PATH`/`HOST=127.0.0.1`/`SERVER_PORT`/`FORCE_COLOR=0` 与三个 MCP 开关；`detached:true`，stdout/stderr 写文件 fd，等待 `CloudCLI Server - Ready`，结束 `process.kill(-pid,'SIGKILL')`。
4. 播种用户与 JWT：向临时库插 `users` 行（bcrypt 哈希）；为设置接口取 JWT（`scripts/mint-token.mjs mint --db <tmp>/auth.db` 或按 temp 库 `app_config` 的同一 secret 自签）。
5. 实现流程读数 (a)–(e)，每段独立断言并逐字写原始值。
6. 反例 (e) 与正例共用同一实例、同一次运行。
7. 假形态三条：先提交实现，再逐条变异，记录 diff/失败行/恢复命令，恢复后回绿。
8. 回归：`npm run typecheck`、`npm run lint`；兄弟判据文件不改一字仍通过。
9. Touches 对齐与提交。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 AC-268 命令，退出码 1 且逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts`（写下完整命令与输出）。
- [x] AC2 判据绿：AC-268 命令退出 0；写下 `# tests`/`# pass`/`# fail`。
- [x] AC3 (a) 同一次运行依次完成元数据发现（两个 well-known 返回 `application/json`）、DCR 注册拿 `client_id`、`GET /oauth/authorize` 得服务端渲染密码页并解析出 CSRF token、带密码+CSRF 的 POST 302 回 `redirect_uri` 带 `code`、`/oauth/token` 以 PKCE S256 `code_verifier` 换到 access+refresh；逐字写出每步状态码与关键字段。
- [x] AC4 (b) 用 access token 调 `/mcp` 的 `tools/list` 与 `overview` 得正确结果（工具清单非空、overview 结构符合夹具）；逐字写出读数。
- [x] AC5 (c) refresh 换到新 access/refresh；旧 refresh 换令牌被拒；逐字写出新旧令牌与旧 refresh 的拒绝读数。
- [x] AC6 (d) 经设置接口吊销该授权后，同一个 access token 的下一次 `/mcp` 得 401；正例对照：吊销前同一 token 的 `/mcp` 为 200；逐字写出吊销响应与两条 `/mcp` 读数。
- [x] AC7 (e) 同一次运行的反例：错误密码拿不到 `code`、错误 `code_verifier` 换不到 token、`code` 重放被拒；逐字写出三条拒绝读数。
- [x] AC8 判据跑的是**生产装配**：实例是真 `server/index.ts` 进程（或经其调用的同一挂载工厂），`/oauth/authorize|token|revoke` 的生产挂载在 `server/index.ts`（静态路由之前）；写下证明读数（进程命令行/端口监听/挂载顺序扫描）。
- [x] AC9 实例隔离：`HOME`/`DATABASE_PATH` 及数据目录为临时路径、端口为临时端口且 `HOST=127.0.0.1`；起实例前显式覆盖（防写进真库）；结束时按进程组杀并清理；写下临时路径与端口读数。
- [x] AC10 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 授权页跳过密码 ⇒ AC7 红；(ii) 吊销不级联 ⇒ AC6 红；(iii) 刷新后旧 refresh 仍有效 ⇒ AC5 红；每条恢复后重跑回绿。
- [x] AC11 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写计数）；AC-245 与 AC-258..267 的判据文件不改一字仍逐字通过。
- [x] AC12 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件 ASCII `(new)`）；列出实际改动文件清单。

## DoD

- 端到端流程**真的**在真实 HTTP 上跑通：真临时实例 + 真库 + 生产装配，一次运行内完成 (a)–(e)，不是「各单测拼起来」也不是「函数被调用」。
- 正例**真的**成立：access token 真能调 `/mcp` 拿正确结果；刷新真换到新令牌；吊销前 200 与吊销后 401 是同一 token 在同一实例上的对照。
- 反例**真的**同一次运行被拒：错误密码、错误 verifier、`code` 重放三条写原始拒绝读数，不是「断言了状态码」。
- 生产挂载缺口**真的**补上：`/oauth/authorize|token|revoke` 真挂在 `server/index.ts` 的静态路由之前，故 HTTP 上真能走到；判据不搭平行路由。
- 三条假形态先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards` 与 AGENTS.md；不引入新依赖（只用既有 `@modelcontextprotocol/sdk`、better-sqlite3、express、node 内置）；不越界重实现 AC-258–267/AC-245 的机制。

## Touches

- server/index.ts
- server/modules/oauth/index.ts
- server/modules/auth/auth.module.ts（导出 credentialVerifier：授权页 POST 经它走同一 authService.login 路径）
- server/modules/auth/index.ts（barrel 再导出 credentialVerifier）
- server/modules/oauth/oauth-server.mount.ts (new)（`/oauth/authorize`、`/oauth/token`、`/oauth/revoke` 的生产挂载工厂；若兄弟已交等价挂载则改为其实文件）
- server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts (new)（判据）
- tasks/gap-ac268-oauth-e2e-flow.md

## Notes

- 真实实例的启动与清理按本机已实测配方（内存 `real-service-process-criterion-recipe`、`dod-harness-spawning-real-server-pin-host-kill-group`、`tsx-wrapper-pid-is-not-the-server-pid`）：`HOST` 必须钉 `127.0.0.1`（本 shell 导出了别的 HOST）；tsx 使服务成为孙进程，须 `detached:true` + `process.kill(-pid,'SIGKILL')`；stdout/stderr 走文件 fd，避免管道致挂起；`FORCE_COLOR=0`；`DATABASE_PATH` 必须显式覆盖（内存 `shell-exports-database-path-so-temp-servers-write-the-real-db`）；读就绪行 `CloudCLI Server - Ready`。
- 授权页密码校验走 auth 模块的同一 login 路径（AC-260 的窄口），故播种的 bcrypt 哈希必须与 `authService.login` 的比对一致；设置接口需 JWT（`authenticateToken` 用 `process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret()`）：用 `scripts/mint-token.mjs mint --db <tmp>/auth.db`（JWT_SECRET 未设时可用）或按 temp 库的同一 secret 自签，以实测可行者为准。
- 原始 HTTP 用 `node:http`，不用 `fetch`（内存 `undici-bad-port-lottery-in-listen0-route-tests`）。
- 若需为挂载新增 barrel 导出并使某整体 `vi.mock('@/modules/database/index.js')` 的兄弟测试变红（内存 `adding-an-export-reds-sibling-wholesale-vimocks`），按同款修法把新导出补进该 mock 工厂并把该测试文件加进 `## Touches`。
- 新测试文件可能被边界 lint 拦截（内存 `quay-boundaries-lint-blocks-new-test-files`）；判据文件已列入 `## Touches`。
- Touches 中 `oauth-server.mount.ts` 为预期落点；若兄弟已交等价工厂，按实际写点用 `task_write` 收敛 Touches（内存 `quay-touches-must-match-actual-write-sites`）。实际写点另含 `server/modules/auth/auth.module.ts` 与 `server/modules/auth/index.ts`（授权页需要生产装配的 credentialVerifier，经 auth barrel 导出），已据实加入 Touches。
- 判据实测读数（2026-10-05，worktree gap-ac268）：`# tests 1 / # pass 1 / # fail 0`；工具清单 `["projects_list","sessions_list","session_get","session_read","overview","quay_snapshot","run_get"]`；overview `{"running":[],"awaitingPermission":[],"aborted":[],"hosts":[],"quay":[]}`；吊销正例对照 `before revoke 200` → `DELETE .../oauth-grants/1 -> 200 {"revoked":true,"tokensRevoked":2}` → `after revoke 401`；假形态三条失败行：`a wrong password must be refused`（AC7）、`the revoked token must be refused on the next /mcp call`（AC6）、`the rotated-out refresh token must be refused`（AC5）。
