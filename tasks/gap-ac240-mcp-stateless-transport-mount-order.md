---
id: gap-ac240-mcp-stateless-transport-mount-order
title: AC-240 /mcp 是无状态的 Streamable HTTP，MCP_ENABLED 默认关闭、挂在静态路由之前，返回 JSON-RPC
  而非 SPA；判据 server/modules/mcp-gateway/tests/mcp-transport.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-240
---
## Proposal

AC-240（GOAL-020 退出条件 2；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §156、§157、§158、§415、§494、§514）要求 `/mcp` 是一个无状态的 Streamable HTTP 端点，经 `server/index.ts` 单实例装配，挂在静态路由 `createStaticAssetsMiddleware` 之前，由 `MCP_ENABLED` 控制且默认关闭；开关关着时该路径返回 404（不是 SPA 的 200、也不是 401），开着时返回 JSON-RPC（`application/json` 或 `text/event-stream`）而不是 `text/html`。判据文件 `server/modules/mcp-gateway/tests/mcp-transport.test.ts` 当前不存在，AC-240 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-transport.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/` 目录不存在；`server/index.ts` 未挂载 `/mcp`；`MCP_ENABLED` 在整个 `server/` 无任何读取点（grep `MCP_ENABLED` 只命中 SPEC）。

要交付：

1. **新模块 `server/modules/mcp-gateway/`（TypeScript；遵守 `$backend-module-standards`）**：
   - `mcp-gateway.gate.ts`：`MCP_ENABLED` 的唯一读取点（fail-closed，形制照 `server/modules/debug-agent/debug-agent.gate.ts`）。只有去空白、转小写后落在 `1/true/yes/on` 才开；未设、`false` 系、无法识别的值一律判关，并携带可打印的 reason。导出纯函数 `readMcpGatewayGate(env: NodeJS.ProcessEnv = process.env)`（不缓存——判据要在同一进程里读两种开关态）。
   - `mcp-gateway.transport.ts`：生产装配函数（消费者 `server/index.ts`），签名约 `mountMcpGateway(app: Express, deps?: McpGatewayDeps): McpGatewayReading`。开启时按 SDK 的无状态配方挂载 `/mcp`：每个 POST 新建 `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` 与一个新的 `McpServer`，`server.connect(transport)` 后 `transport.handleRequest(req, res, req.body)`；`GET`/`DELETE /mcp` 返回 405 JSON-RPC（照 SDK `examples/server/simpleStatelessStreamableHttp.js`）。关闭时**不调用任何 `app.use`/`app.post`/`app.get`/`app.delete`**，返回 `{ mounted: false, reason }`。
   - `McpServer` 至少注册 `tools/list`（本任务返回空工具数组即可；AC-245+ 再填工具——不越界实现工具）。响应必须是 JSON-RPC（`application/json` 或 `text/event-stream`），不能落到静态层的 `text/html`。
   - 认证/回环不属本任务：装配接一个可注入的 `authorize: RequestHandler` 缝（默认 fail-closed 返 401），供 AC-241（令牌）与 AC-242（回环）在认证之前接入；判据 (a)(b) 用直通缝（`(_req,_res,next)=>next()`）单独量传输，使本任务不依赖 AC-241。
   - `index.ts`：barrel，只导出装配函数、gate 读数类型与 `/mcp` 路径常量；不导出无消费者的符号。
2. **`server/index.ts`**：在 `app.use(createStaticAssetsMiddleware({...}))`（当前 `:449`）之前调用装配函数，把 `/mcp` 挂上。装配点仍是 `server/index.ts` 这一处，本任务不构造控制服务（AC-253 的「只构造一个实例」在后续任务落地）。
3. **判据文件 `server/modules/mcp-gateway/tests/mcp-transport.test.ts`（红先行）**：真实 express 4 应用 + 真实 HTTP。用 `node:http`（不用 `fetch`——undici 拒绝一组固定端口，`listen(0)` 会抽中），每个读数独立成断言并逐字写出原始值：
   - (a) 无状态：同一客户端连续发两次 `tools/list`，两次都不带 `Mcp-Session-Id` 头，两次都成功（HTTP 200 且 JSON-RPC 有 `result`）；并断言响应没有 `Mcp-Session-Id`。
   - (b) 响应 content-type 是 `application/json` 或 `text/event-stream`，不是 `text/html`。
   - (c) 开关未开（`MCP_ENABLED` 未设/非 true）时装配函数不挂任何东西：在同一 app 上装配后，`POST /mcp` 得 404（不是 401、也不是 200）。正例对照：同一函数在 `MCP_ENABLED=true` 的 env 下装配，`POST /mcp` 不再是 404（可被传输处理）。
   - (d) 对 `server/index.ts` 解析语法树（用 `typescript` 编译器 API `ts.createSourceFile`；`typescript` 是本仓库 devDependency 5.9.3）：挂载 `/mcp` 的调用在 `createStaticAssetsMiddleware` 的 `app.use` 之前。把扫描器写成可取源码字符串的纯函数 `checkMountOrder(sourceText)`，并用**反例对照**：把两处调用顺序倒过来的合成源码喂给同一函数，必须判出违规。
   - (e) SDK/express4 兼容守卫：把 SDK 的授权路由（`mcpAuthRouter`，配一个最小 in-memory `OAuthServerProvider`；SDK 自带 `examples/server/demoInMemoryOAuthProvider.js` 可参照）与无状态传输挂在真实 express 4.21 应用上，断言元数据端点 200（JSON content-type）、`tools/list` 200，防止 SDK 升级后漂移。
4. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 把传输换成有状态（`sessionIdGenerator: () => randomUUID()`）⇒ (a) 必须红；
   (ii) 把 `/mcp` 挂载移到静态路由之后 ⇒ (d) 与 (b) 必须红；
   (iii) 开关未开仍挂载 ⇒ (c) 必须红。
   每条记录变异前后的 `git diff`、判据的逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上的去重已核对——本仓库无任何任务带 `goal_ac: AC-240`；`tasks/gap-ac239-sdk-zod-declared-in-dependencies.md` 是相关但不同的机制（依赖声明/lock 同步），其 dedup 段已声明「不创建 mcp-gateway barrel，因为此刻无消费者」，本任务正是该 barrel 的第一个消费者（传输 + `server/index.ts` 装配），两者不重叠。本任务不做令牌认证（AC-241）、回环限制（AC-242）、scope（AC-243）、审计（AC-244）、工具（AC-245+）、设置页（AC-254/255）、冒烟（AC-256/257）。`@modelcontextprotocol/sdk` 与 `zod` 的 `package.json` 声明由 AC-239 负责；本任务只 import（两包已装在 node_modules）。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-240 的命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-transport.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-transport.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-transport.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 无状态：同一客户端连续两次 `tools/list` 都不带 `Mcp-Session-Id` 且都成功；写下两次请求头（无 `Mcp-Session-Id`）与两次 200/`result` 读数，并断言响应无 `Mcp-Session-Id`。
- [x] AC4 (b) 响应 content-type 是 `application/json` 或 `text/event-stream`（不是 `text/html`）；逐字写下实测 content-type。
- [x] AC5 (c) `MCP_ENABLED` 未设为 true 时生产装配函数不挂载任何东西，`POST /mcp` 得 404（不是 401、不是 200）；并留正例对照（`MCP_ENABLED=true` 同一装配函数下 `POST /mcp` 不再 404）。写下两态的状态码。
- [x] AC6 (d) 对 `server/index.ts` 解析语法树：挂载 `/mcp` 的调用在 `createStaticAssetsMiddleware` 的 `app.use` 之前；写下扫描器对真实源码的判定与两个调用的源码位置。
- [x] AC7 (d) 反例对照：把顺序倒过来的合成源码喂给同一个扫描器函数，必须判出违规（写下合成源码、扫描器返回值与判出结论）。
- [x] AC8 (e) SDK 授权路由 + 无状态传输挂在真实 express 4.21 应用上工作的守卫：元数据端点 200（JSON content-type）、`tools/list` 200；逐字写下两个状态码与 express 版本读数。
- [x] AC9 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 有状态传输 ⇒ AC3 红；(ii) 挂载移到静态路由之后 ⇒ AC6 与 AC4 红；(iii) 开关未开仍挂载 ⇒ AC5 红。每条记录恢复命令并在恢复后重跑判据回绿。
- [x] AC10 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）。

## DoD

- 生产装配函数真的按 `MCP_ENABLED` 决定挂不挂：开着时 `/mcp` 真的是无状态 Streamable HTTP（连续两次无 `Mcp-Session-Id` 的 `tools/list` 都成功），关闭时该路径真的不存在（404），且开着时返回的是 JSON-RPC 而不是 SPA 的 HTML——不是「判据文件存在」就算数。
- `server/index.ts` 里 `/mcp` 的挂载位置真的在 `createStaticAssetsMiddleware` 之前；这是对真实文件的语法树读数，不是夹具，且扫描器对倒序合成源码敏感（反例对照）。
- SDK 授权路由与无状态传输挂在真实 express 4.21 应用上工作的守卫为真（元数据 200、`tools/list` 200），夹具是真实 HTTP + 真实 express，不是 mock。
- 判据对三条变异都敏感：先提交实现，再逐条变异证明变红，记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- 遵守 `$backend-module-standards`：TS、模块 barrel 只导出有消费者的符号、测试放 `server/modules/mcp-gateway/tests/`、装配薄、不导出无消费者符号；不引入新依赖（传输只用 SDK 与 `zod`；判据额外只用 node 内置与 `typescript` 编译器 API 解析语法树）。
- 越界不实现 AC-241–AC-257 的范围（认证/回环/scope/审计/工具/设置页/冒烟）。

## Touches

- server/index.ts
- server/modules/mcp-gateway/index.ts (new)
- server/modules/mcp-gateway/mcp-gateway.gate.ts (new)
- server/modules/mcp-gateway/mcp-gateway.transport.ts (new)
- `server/modules/mcp-gateway/tests/mcp-transport.test.ts` (new)（判据）
- tasks/gap-ac240-mcp-stateless-transport-mount-order.md

## Notes

- SDK 无状态配方（`node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStatelessStreamableHttp.js`）：每个 POST 新建 `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` + 新 `McpServer`，`connect` 后 `handleRequest`；`GET`/`DELETE /mcp` 返 405 JSON-RPC。无状态模式下 SDK 不校验 session（d.ts：「No session validation is performed」），故不带 `Mcp-Session-Id` 的 `tools/list` 成功。
- 已实测环境：顶层 `express` 4.21.2（`package.json` 声明 `^4.18.2`）；SDK `@modelcontextprotocol/sdk` 1.29.0 自带嵌套 express 5，`mcpAuthRouter` / 无状态 `StreamableHTTPServerTransport` 挂在顶层 express 4.21 上工作正常（SPEC §105 的临时探测；本任务 (e) 把它固化成守卫）。
- 判据的 HTTP 调用用 `node:http` 不用 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（见 `server/modules/debug-agent/tests/debug-agent-control-plane.test.ts` 的同款说明）。
- 认证缝默认 fail-closed（401）：本任务落地后 `/mcp` 在 `MCP_ENABLED=true` 但 AC-241 未落地期间不放行任何请求，符合「默认关闭 + 只听本机」的安全取向；AC-241 用真实令牌校验替换该缝。
