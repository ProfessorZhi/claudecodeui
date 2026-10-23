---
id: gap-ac262-oauth-metadata-endpoints
title: AC-262 元数据端点返回 JSON 而不是 SPA 页面：开启时发布正确的 issuer/受众与 PKCE
  能力，关闭时不发布，PUBLIC_BASE_URL 必须为 https（localhost 例外），且挂在静态路由之前；判据
  server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac242-mcp-loopback-guard-before-auth
goal_ac: AC-262
---
## Proposal

AC-262（GOAL-021 退出条件 4「元数据与挂载」；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §148–§156「路由与挂载顺序」、§405、§415–§417、§490–§503「配置」、§522 阶段 3）要求 OAuth 发现文档就位：`MCP_OAUTH_ENABLED` 开且 `PUBLIC_BASE_URL` 为 https 时，`GET /.well-known/oauth-authorization-server` 与 `GET /.well-known/oauth-protected-resource/mcp` 返回 200 + `application/json`，`issuer` 等于基址，`resource` 等于基址 + `/mcp`，`code_challenge_methods_supported` 恰为 `["S256"]`；两端点挂在静态路由（`createStaticAssetsMiddleware`）**之前**；`registration_endpoint` 只在 `MCP_DCR` 不是 `off` 时出现；开关关闭时端点未挂载（响应不含 `issuer`）；开关开而 `PUBLIC_BASE_URL` 缺失或为非 localhost 的 http 时**配置加载失败并在错误里点名 `PUBLIC_BASE_URL`**，`http://localhost` 与 `http://127.0.0.1` 放行。判据文件 `server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts` 当前不存在，存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts`（已实测）。

现状（红态基线）：

- `grep -rn "well-known\|oauth-authorization-server\|oauth-protected-resource\|issuer\|code_challenge_methods_supported" server/ --include=*.ts` 为空——没有任何发现文档端点。
- `server/index.ts:445` 只装配了 `/mcp`（`mountMcpGateway`），紧接着 `server/index.ts:458` 是 `createStaticAssetsMiddleware`（SPA 兜底）；`/.well-known/*` 无挂载点，落在静态路由之后会得到 SPA 的 `200 text/html`（SPEC §156 明说的陷阱）。
- `MCP_OAUTH_ENABLED` 在整个 `server/` 无读取点；`PUBLIC_BASE_URL` / `MCP_DCR` 无读取点。
- AC-242（`todo`）将创建 `server/modules/mcp-gateway/mcp-gateway.loopback.ts` 的 `readMcpOauthEnabled(env)` 作为 `MCP_OAUTH_ENABLED` 的**唯一读取点**（其 AC9 断言生产代码里该变量只被读取一处，grep 计数=1）。本任务**复用**它，不新增第二个读取点——这就是 frontmatter `depends_on` 的机械前置。

要交付：

1. **发现文档闸（新文件 `server/modules/mcp-gateway/oauth-metadata.gate.ts`；遵守 `$backend-module-standards`）**：
   - `readOAuthMetadataGate(env: NodeJS.ProcessEnv = process.env): OAuthMetadataGateReading`：
     - 先调 `readMcpOauthEnabled(env)`（从 `./mcp-gateway.loopback.js` 导入；AC-242 的唯一读取点）。为假 ⇒ 返回 `{ enabled: false, reason }`，**不校验** `PUBLIC_BASE_URL`（关时不发布）。
     - 为真 ⇒ 读 `PUBLIC_BASE_URL`：缺失/空/`new URL` 解析失败/协议不是 `https:` 且不是（`http:` 且 hostname 恰为 `localhost` 或 `127.0.0.1`）⇒ **throw** 一个 `Error`，其 `message` 逐字包含 `PUBLIC_BASE_URL`（例如 `PUBLIC_BASE_URL must be an https origin (http://localhost and http://127.0.0.1 are allowed): <原因>`）。
     - 合法 ⇒ 归一化（去掉尾部 `/`）后返回 `{ enabled: true, baseUrl, resourceUrl: baseUrl + '/mcp', dcrMode, reason }`。
   - `readMcpDcrMode(env): 'off' | 'allowlist' | 'open'`：去空白转小写；未设/为空/无法识别一律 `'off'`（fail-closed）；`allowlist`/`open` 原样。**不做缓存**（判据在同一进程读多态）。
   - `buildAuthorizationServerMetadata({ baseUrl, dcrMode }): OAuthMetadata`：纯函数，返回 AS 元数据对象——`issuer: baseUrl`、`authorization_endpoint: baseUrl + '/oauth/authorize'`、`token_endpoint: baseUrl + '/oauth/token'`、`revocation_endpoint: baseUrl + '/oauth/revoke'`、`response_types_supported: ['code']`、`code_challenge_methods_supported: ['S256']`（**恰一项**，绝不含 `'plain'`）、`grant_types_supported: ['authorization_code','refresh_token']`、`token_endpoint_auth_methods_supported: ['client_secret_post','none']`，且 `dcrMode !== 'off'` 时才带 `registration_endpoint: baseUrl + '/oauth/register'`。端点路径取 SPEC §150 的 `/oauth/*`；**不用** SDK `createOAuthMetadata`（它把端点放根、并把 `registration_endpoint` 绑在 provider 的 `clientsStore` 上——本任务不引入 provider，端点本体属 AC-259/260）。
   - 边界：本文件**生产代码与注释都不写 `MCP_OAUTH_ENABLED` 字面量**（只调 `readMcpOauthEnabled`），否则 AC-242 的 grep 计数变 2、把已绿的 AC-242 判据拖红（跨文件连带）。测试文件在 `/tests/` 下，可自由使用该字面量。

2. **发现文档挂载（新文件 `server/modules/mcp-gateway/oauth-metadata.mount.ts`）**：
   - `mountOAuthMetadata(app: Express, deps: { env?: NodeJS.ProcessEnv } = {}): OAuthMetadataMountReading`：
     - `readOAuthMetadataGate(deps.env)`；`enabled === false` ⇒ 返回 `{ mounted: false, reason }`，**什么都不挂**（路径缺失=404，不是 403/200）。
     - `enabled === true` ⇒ `mcpAuthMetadataRouter({ oauthMetadata: buildAuthorizationServerMetadata({ baseUrl, dcrMode }), resourceServerUrl: new URL(resourceUrl) })`（SDK `@modelcontextprotocol/sdk/server/auth/router.js`，express 4；`mcpAuthMetadataRouter` 把 PRM 挂在 `/.well-known/oauth-protected-resource/mcp`、AS 元数据挂在 `/.well-known/oauth-authorization-server`，两者 `res.json` ⇒ `application/json`；PRM 的 `resource` 取 `resourceServerUrl.href`、`authorization_servers` 取 `issuer`）。`app.use(router)` 后返回 `{ mounted: true, reason }`。
     - 闸抛错时不吞：让 `Error` 冒泡（`server/index.ts` 顶层调用 ⇒ 进程启动失败，即「配置加载失败」）。
   - 导出类型 `OAuthMetadataGateReading`、`OAuthMetadataMountReading`。
   - 放置理由（SPEC §149 的示意把 `.well-known/*` 画在 oauth 模块一列）：本任务把**挂载与闸**放 mcp-gateway——判据点名的测试就在这里、挂载顺序是 mcp-gateway 已有的承重关切（`mcp-gateway.transport.ts` 的 `/mcp` 同款）、且避免 oauth↔mcp-gateway 的 barrel 环（AC-241 的 `mcp-gateway.auth.ts` 会 import `@/modules/oauth/index.js`）。

3. **接线（`server/index.ts`）**：在 `mountMcpGateway(app)`（当前 §445）之后、`createStaticAssetsMiddleware`（当前 §458）**之前**加 `const oauthMetadata = mountOAuthMetadata(app); console.log(\`[MCP] oauth metadata ${oauthMetadata.mounted ? 'mounted' : 'not mounted'} (${oauthMetadata.reason})\`);`。顺序承重：挂到静态路由之后，两个 well-known 会得到 SPA 的 `200 text/html`（SPEC §156）。

4. **barrel（`server/modules/mcp-gateway/index.ts`）**：导出 `readOAuthMetadataGate`、`readMcpDcrMode`、`mountOAuthMetadata` 与两个读数类型（消费者：`server/index.ts` 与判据），各自在定义处写消费方注释；不导出无消费者符号。

5. **判据文件 `server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts`（红先行；真实 express 4 + 真实 HTTP `node:http`——`listen(0)` 会抽到 undici 拒绝的固定端口，见 AC-240 同款说明；SPA 层用真实 `createStaticAssetsMiddleware` + 临时 `dist/index.html`）**。读数各自独立成断言并逐字写出原始状态码/content-type/JSON 字段：
   - (a) **开启时的正例读数**：env `{ MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: 'https://mcp.example.test' }`。`GET /.well-known/oauth-authorization-server` ⇒ 200、`content-type` 以 `application/json` 开头、`issuer === 'https://mcp.example.test'`、`code_challenge_methods_supported` 深等于 `['S256']`；`GET /.well-known/oauth-protected-resource/mcp` ⇒ 200、`application/json`、`resource === 'https://mcp.example.test/mcp'`、`authorization_servers` 含 `issuer`。逐字写出四个字段读数。
   - (b) **挂在静态路由之前**：(b1) 真实 app 上先 `mountOAuthMetadata`、再 `createStaticAssetsMiddleware`（临时 dist 有 `index.html`），两个 well-known 仍返 `application/json`（**不是** `text/html`）；并取一条未挂载路径（如 `/definitely-missing`）读回 SPA 的 `200 text/html` 作为**正例对照**（证明静态层确实在、SPA 兜底真会吞路径）。(b2) 用 TypeScript 解析器扫真实 `server/index.ts`（形制照 AC-240 判据的 mount-order scanner）：`mountOAuthMetadata` 调用位置 < `createStaticAssetsMiddleware` 调用位置；并把一段**反转顺序**的合成源码喂给同一 scanner，断言它判红（证明扫描器对顺序敏感，不是恒真）。逐字写出两处行号与两条扫描结论。
   - (c) **registration_endpoint 随 DCR 出现**：`MCP_DCR` 未设（默认 off）⇒ AS 元数据**无** `registration_endpoint` 键；`MCP_DCR=allowlist` 与 `=open` ⇒ 有且等于 `${baseUrl}/oauth/register`。正例对照：off 时该键真缺失（`'registration_endpoint' in body === false`）。逐字列出三态读数。
   - (d) **关闭时不发布**：`MCP_OAUTH_ENABLED` 未设/`false` ⇒ 两个 well-known 路径 **404**（未挂载），响应体不含 `issuer`；正例对照：`MCP_OAUTH_ENABLED=true` ⇒ 200。逐字写出两态状态码与「是否含 issuer」。
   - (e) **基址校验与点名**：`MCP_OAUTH_ENABLED=true` 且 `PUBLIC_BASE_URL` 缺失/空 ⇒ `readOAuthMetadataGate(env)` **抛出**，`error.message` 逐字含 `PUBLIC_BASE_URL`；`PUBLIC_BASE_URL=http://example.com`（非 localhost 的 http）⇒ 同样抛且点名；`PUBLIC_BASE_URL=http://localhost:3001` 与 `http://127.0.0.1:3001` ⇒ **不抛**，`{ enabled: true, baseUrl: <该值> }`。并断言 `server/index.ts` 真的调用 `mountOAuthMetadata`（源码扫描），使该抛错在启动装配点真的会被走到。逐字写出五种输入与两条错误消息。
   - (f) **不回归**：`server/modules/mcp-gateway/tests/mcp-transport.test.ts` 不改一字仍逐字绿；`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；生产代码（`server/` 去掉 `/tests/`）中 `MCP_OAUTH_ENABLED` 字面量计数仍为 **1**（只在 `mcp-gateway.loopback.ts`；正例对照：放宽到含 tests 命中 ≥2）。
6. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 把 `mountOAuthMetadata` 的挂载挪到 `createStaticAssetsMiddleware` 之后（改 `server/index.ts` 顺序，或把 (b1) 的装配顺序反转）⇒ (b) 必须红；
   (ii) 让缺 `PUBLIC_BASE_URL` 仍能启动（删掉 gate 里那次 `throw`，缺失时回退空基址）⇒ (e) 必须红；
   (iii) 在 `buildAuthorizationServerMetadata` 里把 `code_challenge_methods_supported` 改成 `['S256','plain']` ⇒ (a) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: AC-262" tasks/` 为空，本仓库无任何任务带 AC-262；`grep -rlE "well-known|oauth-authorization-server|oauth-protected-resource|oauth-metadata|PUBLIC_BASE_URL" tasks/` 只命中 AC-254/259/260 的越界声明句（AC-254 只读 `PUBLIC_BASE_URL` 作设置页基址展示、AC-259 只做授权服务器语义、AC-260 明确把「端点挂载与 https 基址判定」让给 AC-262）。AC-258（存储）、AC-259（授权服务器语义/PKCE/受众判定）、AC-260/261（授权页/限速）、AC-263（`/mcp` 认证与 `resource_metadata` 401）、AC-264（DCR 三档策略与手工客户端，本任务只**读** `MCP_DCR` 决定是否发布 `registration_endpoint`）、AC-265+（设置接口）、AC-268（端到端）是不同机制与不同判据文件。机械前置（frontmatter `depends_on`）：`gap-ac242-mcp-loopback-guard-before-auth` 交 `readMcpOauthEnabled`（`MCP_OAUTH_ENABLED` 的唯一读取点，本任务复用而不新增读取点）。AC-262 判据自足：纯 express 装配 + 真实 HTTP + 源码扫描，不取用任何 OAuth 存储/端点/provider。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-262 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 开+https 基址：AS 元数据 200/`application/json`、`issuer` 等于基址、`code_challenge_methods_supported` 深等于 `['S256']`；PRM 200/`application/json`、`resource` 等于基址 + `/mcp`；逐字写出字段读数。
- [x] AC4 (b) 挂载顺序：真实 app 上元数据在 SPA 兜底之前 ⇒ JSON 不是 `text/html`（并读取一条 SPA 吞掉的对照路径）；`server/index.ts` 源码扫描证明 `mountOAuthMetadata` 在 `createStaticAssetsMiddleware` 之前，反转合成源被判红；逐字写出。
- [x] AC5 (c) `registration_endpoint` 只在 `MCP_DCR` 不为 `off` 时出现：off 无该键（`in` 为 false 正例对照），allowlist/open 有且等于 `${baseUrl}/oauth/register`；逐字写出三态。
- [x] AC6 (d) 开关关闭时两端点 404 且响应不含 `issuer`；开关开为 200（正例对照）；逐字写出两态。
- [x] AC7 (e) 缺失/非 localhost http 的 `PUBLIC_BASE_URL` ⇒ gate 抛错且 message 逐字含 `PUBLIC_BASE_URL`；`http://localhost`、`http://127.0.0.1` 放行；`server/index.ts` 真的调用 `mountOAuthMetadata`；逐字写出五种输入与两条错误消息。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 挂载挪到静态之后 ⇒ AC4 红；(ii) 缺 `PUBLIC_BASE_URL` 仍启动 ⇒ AC7 红；(iii) 声明支持 `plain` ⇒ AC3 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`server/modules/mcp-gateway/tests/mcp-transport.test.ts` 不改一字仍逐字通过；生产代码中 `MCP_OAUTH_ENABLED` 字面量计数=1（正例对照含 tests ≥2）。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 两个 well-known 端点**真的**在真 express 4 应用上返回 `application/json` 且字段正确：经真实 HTTP 读回 `issuer`/`resource`/`code_challenge_methods_supported`，不是「路由函数被调用」就算数。
- 挂载顺序**真的**承重：元数据挂在真实 `createStaticAssetsMiddleware` 之前，两个端点仍是 JSON；`server/index.ts` 源码被解析器读出该顺序，且反转合成源被同一扫描器判红（证明扫描器不是恒真）。
- `registration_endpoint` **真的**随 `MCP_DCR` 出现/缺失；开关关闭时端点**真的**未挂载（404 且无 `issuer`）。
- 基址校验**真的**失败并点名变更：缺/非 localhost http 的 `PUBLIC_BASE_URL` 让 `readOAuthMetadataGate` 抛错且 message 含 `PUBLIC_BASE_URL`；`http://localhost`/`http://127.0.0.1` 真放行；`server/index.ts` 真调用该挂载（抛错会在启动装配点被走到）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号、类型/工具就近定义）与 AGENTS.md；不引入新依赖（只用既有 SDK 与 node 内置）；不越界实现 AC-258–AC-261、AC-263–AC-270。

## Touches

- server/modules/mcp-gateway/oauth-metadata.gate.ts (new)
- server/modules/mcp-gateway/oauth-metadata.mount.ts (new)
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts (new)（判据）
- tasks/gap-ac262-oauth-metadata-endpoints.md

## Notes

- `mcpAuthMetadataRouter` 由 SDK `@modelcontextprotocol/sdk/server/auth/router.js` 提供，已在 `node_modules` 中（与 AC-240 判据用的 `mcpAuthRouter` 同包）；其内部 `checkIssuerUrl` 对 https 与 localhost/127.0.0.1 的判定与本任务 gate 同规则，但**不点名 `PUBLIC_BASE_URL`**，故 gate 必须先于它抛错。
- 本任务**不**引入 `OAuthServerProvider`/`createOAuthMetadata`：端点本体与 provider 属 AC-259/260；元数据是**广告**，端点路径按 SPEC §150 的 `/oauth/*` 写死。
- `depends_on: [gap-ac242-mcp-loopback-guard-before-auth]` 是机械前置（复用其 `readMcpOauthEnabled`，避免第二个读取点把 AC-242 判据拖红）。
- `readMcpDcrMode` 本任务新增（AC-264 未立案）；AC-264 落地时经 barrel 复用它，不重写第二份。
- 判据是本任务的机械读数，文件即 AC-262 `criterion:` 所点名的那个；不新建第二个判据文件。
- 若实现中发现 `readMcpOauthEnabled` 的落点/导出名与 AC-242 实际交付不符，按实际写点更新本任务 `## Touches` 与正文。