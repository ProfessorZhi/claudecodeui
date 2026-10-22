---
id: gap-mcp-ui-last-opened-session
title: MCP 只读工具 ui_last_opened_session：浏览器读取会话历史/outline 时落库
  last_opened，工具返回用户最后打开的会话（无记录返回 NOT_FOUND，不退回 lastActivity）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**目标：** 新增 MCP 只读工具 `ui_last_opened_session`（scope `cloudcli:read`），回答「用户最后打开的会话是哪个」，即使浏览器已关闭。该事实不能由 `lastActivity` 代替：90% 左右的会话由 quay worker 发起，`lastActivity` 会被后台刷新淹没。设计取自 2026-10-07 与 yale 的讨论：A 不向客户端拉取，由服务端在已有请求处记录。

**现状（已读代码核实）：**

- 前端打开会话时经 `src/shared/api.ts` 的 `/api/providers/sessions/:sessionId/messages` 与 `/outline` 读取历史；服务端处理在 `server/modules/providers/provider.routes.ts`（`router.get('/sessions/:sessionId/messages'` 与 `'/sessions/:sessionId/outline'`）。
- MCP 的 `session_read` 直接调用 `sessionsService.fetchHistory`，不经过这两个 HTTP 路由，所以 HTTP 路由天然只有浏览器调用方；但前端是否在用户未打开会话时预取（侧栏悬停、预加载）**尚未核实**。
- 全仓库没有「最后打开」的持久化；`mcp_audit_log` 之类的表结构与迁移在 `server/modules/database/schema.ts`、`migrations.ts`，仓库文件在 `server/modules/database/repositories/`，经 database barrel 导出。
- 读工具表在 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 `MCP_STAGE3_READ_TOOLS`；annotations 在 `mcp-tool-annotations.ts`，错误码词汇在 `mcp-tool-error-codes.ts`，经 mcp-gateway barrel `index.ts` 导出。

**要交付：**

1. **第一步，先核对再动手：** 确认前端有无预取或悬停预加载会触发 `/messages` 或 `/outline`。若有，且无法区分「用户打开」与「预取」，则不要把这两个路由当信号；退回方案：前端在选中会话时发一次 WS 帧 `ui.session_opened { sessionId }`，由 `server/modules/websocket/services/chat-websocket.service.ts` 的消息分派处理。把核对结论写入本任务的 Finding 段。
2. **存储：** 新表 `ui_last_opened(session_id TEXT PRIMARY KEY, opened_at INTEGER)` 只保留最后一条（或单行表），新增迁移与仓库文件 `server/modules/database/repositories/ui-last-opened.db.ts`，经 database barrel 导出。
3. **记录点：** 按上面第 1 步的结论，在选定的信号处 upsert。MCP 令牌调用方绝不写入这张表。
4. **工具：** 新文件 `server/modules/mcp-gateway/mcp-ui-tools.ts` 注册 `ui_last_opened_session`：返回会话摘要（与 `session_get` 同形，含 `host` 与当前运行摘要）加 `openedAt`（相对时间加 ISO）。无记录时返回错误码 `NOT_FOUND` 类（沿用现有错误码词汇，不新造第二个「找不到」），**不得退回 `lastActivity`**。
5. **接入现有机制：** 加进读工具表与 `mcp-tool-annotations.ts`（`readOnlyHint: true`）、`mcp-tool-error-codes.ts`，走现有错误信封与审计，经 barrel 导出；遵守 `$backend-module-standards`。
6. 新增 `server/**/*.test.ts` 会让 `quay-test-script` 的文件数 pin 变红：同步更新 `scripts/test.sh` 与 `server/shared/tests/quay-test-script.test.ts` 里的 known/unknown 计数。

## Finding

**预取核对（Proposal 第 1 步）结论：没有预取，也没有悬停预加载；选定信号 = provider 的浏览器会话读取路由（`GET /api/providers/sessions/:sessionId/messages` 与 `GET /api/providers/sessions/:sessionId/outline`），不启用 WS 帧备选方案（`server/modules/websocket/services/chat-websocket.service.ts` 未改动）。**

依据（均为现状代码核实）：

- 侧栏不存在任何悬停/预加载处理器：`grep -rn "onMouseEnter\|onPointerEnter\|onMouseOver\|prefetch\|preload" src/modules/sidebar/` 零命中。
- 两条路由的前端调用点只有一处：`api.providers.sessionMessages` / `api.providers.sessionOutline`（`src/shared/api.ts:505`、`:516`）只被 `src/modules/chat/hooks/useSessionStore.ts` 的三个取数函数（`:145`、`:202`、`:226`）调用。
- 这些调用点都位于「该会话已打开」之后：`/outline` 的两个调用者 `useInputOutline`（`src/modules/chat/outline/useInputOutline.ts:45-46`）与 `useChatSessionState`（`src/modules/chat/hooks/useChatSessionState.ts:1862`）都以 `isActive` 为前置条件。
- 唯一的「提前」读取是转录面板自身的滚动带预取，它只在面板已打开并被滚动时才存在（`e2e/transcript-prefetch.spec.ts` 头注释即建立在这一前提上），且读的仍是当前已打开的那个会话。

**测试选用的信号与结论一致**：`server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts` 在同一 Express 实例上挂**真实的 `providerRoutes`**（浏览器实际打的 `GET /api/providers/sessions/:id/messages`）作为「打开」信号，再经**生产 `/mcp` 挂载点**读回，而不是直接调服务。

**MCP 令牌无法写这张表**：网关的 `session_read` 直接调 `sessionsService.fetchHistory`/`fetchOutline`，不经过上述 HTTP 路由；写点只在路由层，两条调用图不相交。测试腿 (c) 与 e2e 第 (4)(5) 步各自断言了这一点。

**DoD（真实服务实操）已完成**：`e2e/ui-last-opened-session.spec.ts` 用真实 Chromium，在 `playwright.config.ts` 启动的真实 server + Vite client 上经侧栏打开 `e2e-transcript-follow`，用应用自己的设置路由签发 PAT（默认 `cloudcli:read`），再以该 PAT 向 `/mcp` 发真实 HTTP `tools/call`：返回该会话与 `openedAt`；随后 `session_read` 读另一个会话（`e2e-transcript-jump`），再读仍返回同一会话、同一时刻。实测绿（11.4s、12.1s 连续两次，另在清空 `MCP_ENABLED`/`MCP_OAUTH_ENABLED`/`MCP_DCR`/`PUBLIC_BASE_URL` 的环境下再绿一次）；负控：在同样的干净环境下把 `playwright.config.ts` 的 MCP 挂载选择项改回，`/mcp` 返回 404、用例转红——即这次运行依赖已提交的配置，而不是本机 shell 恰好导出的环境变量。

**AC1 命令形态的偏离（已核实，属仓库既有）**：AC1 的裸命令 `node --import tsx --test <文件>` 在本仓库对**任何**使用 `@/*` 别名的 server 测试都跑不通（`ERR_MODULE_NOT_FOUND: Cannot find package '@/modules'`）——别名由 `server/tsconfig.json` 承载，而纯 `node --import tsx` 读的是仓库根的 `tsconfig.json`（`@/*` → `src/*`）。`scripts/test.sh:903,905` 与 fan-in 实际使用的形态是 `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test <文件>`。本任务用后者验证（4/4 通过）；对照：既有文件 `mcp-read-tools.test.ts` 在裸命令下同样失败，加上该环境变量后 6/6 通过，说明这是仓库既有形态而非本任务的缺陷。

**计数 pin 只在测试文件里**：Proposal 第 6 条提到的 `scripts/test.sh` 并无 known/unknown 字面量（`scripts/test.sh:827` 是运行时打印），pin 只在 `server/shared/tests/quay-test-script.test.ts`，已由 242/244 同步为 243/245，该文件 11/11 通过。

**English-only 判据的登记表随第 18 个工具增长（本轮补）**：本任务把 `MCP_STAGE3_READ_TOOLS` 从 17 个工具扩到 18 个，另一个枚举注册表的判据 `server/modules/mcp-gateway/tests/mcp-english-only.test.ts` 因此需要同步（该文件不在原 Touches 内，本轮补入）：`tools/list` 计数 17→18，成功探针表新增 `ui_last_opened_session` 并把 fixture 的 `uiLastOpened` 指针接到可解析的 `sess-1`。`ui_last_opened_session` 不声明任何输入参数，包装层的声明输入校验分支没有可拒绝的输入，故失败半表按 `mcp-error-envelope.test.ts` 对同一工具的既有做法登记一条**有理由的豁免**（`NO_VALIDATION_FAILURE`），而不是把名字静默删掉——注册表 deepEqual 禁止静默省略；该工具拒绝文案的 CJK-free 仍由 (d) 腿的源码扫描覆盖，其 `SESSION_NOT_FOUND` 信封由 `mcp-ui-last-opened.test.ts` 覆盖。改动后该文件 10/10 通过、`tsc --noEmit -p server/tsconfig.json` 退出码 0。

## AC

- [x] `node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts` 退出码 0：断言工具返回会话摘要加 `openedAt`；库里无记录时返回 `NOT_FOUND` 类错误码且结构化内容不含 `lastActivity` 回退；MCP 令牌调用 `session_read` 后表内容不变。（按仓库既有形态 `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test …` 实测 4/4 通过；裸命令的偏离与对照见 Finding。）
- [x] 同一测试文件断言：浏览器路径（所选信号）会 upsert，重复打开同一会话只更新 `opened_at`，打开另一个会话后工具返回后者。
- [x] `grep -n "ui_last_opened_session" server/modules/mcp-gateway/mcp-tool-annotations.ts server/modules/mcp-gateway/mcp-tool-error-codes.ts server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 三个文件均有命中，且已有的 `mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0。
- [x] `npm run typecheck` 退出码 0；`bash scripts/with-memory-cap.sh` 下运行 `server/shared/tests/quay-test-script.test.ts` 退出码 0（计数 pin 已同步）。
- [x] 本任务 Finding 段记录了预取核对结论（有或无预取，选定的信号是什么），且该结论与测试选用的信号一致。

## DoD

在真实运行的服务上实际操作一次：用浏览器打开某个会话，再用 PAT 经 `/mcp` 调用 `ui_last_opened_session`，返回的就是该会话及其 `openedAt`；随后用 PAT 调用 `session_read` 读另一个会话，再次调用结果不变。仅有测试夹具通过不算完成。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/ui-last-opened.db.ts
- server/modules/database/index.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/index.ts
- server/modules/providers/services/ui-last-opened-session.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/mcp-gateway/mcp-ui-tools.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/index.ts
- scripts/test.sh
- server/shared/tests/quay-test-script.test.ts
- e2e/ui-last-opened-session.spec.ts
- playwright.config.ts
- tasks/gap-mcp-ui-last-opened-session.md

（`server/modules/websocket/services/chat-websocket.service.ts` 与 `scripts/test.sh` 最终未改动：前者是 Proposal 第 1 步的备选方案，核对结论为无预取，无需启用；后者的计数 pin 实为运行时计算，字面量只在 `server/shared/tests/quay-test-script.test.ts`。两条按原样保留在 Touches 里，以免看起来像被抹掉。`server/modules/mcp-gateway/tests/mcp-english-only.test.ts` 为本轮补入的工具计数/探针表同步。）
