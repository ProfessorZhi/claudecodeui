---
id: gap-mcp-ui-open-session
title: MCP 工具 ui_open_session：在指定浏览器设备中打开会话并定位（latest/messageId），不等用户确认，结果经
  ui_visible_context 查询；新 scope、限速常量、审计
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-ui-visible-context
  - gap-mcp-ui-clients-list
  - gap-mcp-ui-navigate-frontend
---
## Proposal

**背景（2026-10-07 与 yale 的讨论）：** 外部 agent（如 ChatGPT）应能先用 `ui_clients_list` 发现在线浏览器，再选一台，用本工具在其中打开某个会话、翻到固定位置。这是第一个会改变用户屏幕的 MCP 工具，所以有独立 scope、限速与审计；是否真的跳转由用户设备的策略与确认界面裁决（`gap-mcp-ui-navigate-frontend`）。本任务是服务端与工具半边。

**已定的行为：**

- 入参 `ui_open_session { client?, session, at? }`：
  - `session`：沿用现有目标解析（id 或标题子串，唯一命中才接受）。
  - `client`：`deviceId` 或设备名子串，唯一命中才接受。**只有一台设备在线时可省略并自动选择；多台时必须指定**，缺省返回 `CLIENT_REQUIRED` 并在错误里列出候选设备；无设备在线返回 `NO_CLIENT`。不向多台设备广播。
  - `at`：`{ latest: true }`（默认）或 `{ messageId }`。第一版不做 `turn`（按用户轮次定位），因为它要和 outline 的索引对齐，留待后续。
- **工具不等用户。** 服务端发 `ui.navigate`，只等前端的送达 ack（`shown` / `applied` / `declined`，约 1.5s），然后立即返回。返回：`{ navigationId, device, status }`，`status` 为 `applied`（接受策略已跳转）、`pending_user`（询问策略，提示条已显示）、`declined`（拒绝策略）、`unresponsive`（送达超时）。
- **最终结果经 `ui_visible_context` 查询（用户已定，不新增 `ui_navigation_get`）：** 服务端在内存里保留最近的导航记录（至多 50 条，保留 10 分钟，不落库），`ui_visible_context` 的返回新增 `navigations[]`（可选入参 `navigationId` 只取一条），每条含 `navigationId`、设备、请求方客户端名、最终状态（`applied` / `declined` / `ignored` / `superseded` / `expired` / `pending_user`）与时间。
- **scope：** 新增 `cloudcli:navigate`（文案「Open a session in one of your browsers」），不在默认勾选里；工具的 annotations 为 `readOnlyHint: false`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: false`。
- **限速：** 每个令牌每分钟至多 6 次，写死为导出常量，超出返回 `RATE_LIMITED`，**不进设置**。
- **自指：** 目标会话就是调用方所在的会话时，照常执行（它不会中止或排队任何运行），不触发 `SELF_TARGET`；测试里明确写出。
- **最后打开：** 只有最终状态为 `applied` 的导航才写入 `gap-mcp-ui-last-opened-session` 的记录（经该任务暴露的 upsert 接口），被拒绝、忽略的不记。
- 审计走现有 `recordMcpToolCall`；新增的错误码（`CLIENT_REQUIRED`、`NO_CLIENT`、`RATE_LIMITED`、`CLIENT_NOT_FOUND` 等）进入现有错误码词汇表，同类别只用一个码，不另造平行词汇；`INSUFFICIENT_SCOPE` 沿用现有点名缺失 scope 的行为。

**现状（已读代码核实）：** scope 常量定义在 `server/modules/oauth/access-tokens.service.ts`（含 `cloudcli:approve` 先例），授权同意页的 scope 文案在 `server/modules/oauth/oauth-consent.routes.ts`，前端 scope 清单在 `src/shared/constants.ts`，设置页令牌复选框读 `accessTokens.scopes.*`（12 种语言的 `settings.json`，`i18nMcpSettingsCompleteness.test.ts` 守完整性）。往返原语 `requestUiState`、设备清单 `listUiClients()`、前端 `ui.navigate` 执行分别由前述依赖任务提供。仓库既有形态：使用 `@/*` 别名的 server 测试要带 `TSX_TSCONFIG_PATH=server/tsconfig.json` 才能直接运行；`quay-test-script` 的文件数 pin 只在 `server/shared/tests/quay-test-script.test.ts` 里，`scripts/test.sh` 没有字面量。

**要交付：** 新文件 `server/modules/mcp-gateway/mcp-ui-open-session.ts`（工具）、`server/modules/websocket/services/ui-navigation.service.ts`（发送 `ui.navigate`、等待送达 ack、记录 `ui.navigate_result`、内存导航记录、`ui.navigate_ack` / `ui.navigate_result` 分派）、`mcp-ui-visible-context.ts` 增加 `navigations[]`；工具表、annotations、错误码、barrel、`server/index.ts` 装配；新 scope 贯通令牌服务、同意页、前端清单与 12 种语言的 `accessTokens.scopes` 文案；遵守 `$backend-module-standards` 与 `$frontend-module-standards`；同步 `server/shared/tests/quay-test-script.test.ts` 里的文件数 pin。

## AC

- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-open-session.test.ts` 退出码 0：断言单设备在线时 `client` 可省略；多设备时缺省返回 `CLIENT_REQUIRED` 且错误里列出候选；无设备返回 `NO_CLIENT`；`client` 多个命中或无命中返回候选或查询词；只向选中的设备发 `ui.navigate`，不向其他设备发。
- [x] 同一测试文件断言：前端回 `shown` 时工具返回 `pending_user`，回 `applied` 时返回 `applied`，回 `declined` 时返回 `declined`，送达超时返回 `unresponsive`；工具在送达 ack 到达后立即返回，不等 `ui.navigate_result`。
- [x] 同一测试文件断言：随后到达的 `ui.navigate_result` 更新内存导航记录，`ui_visible_context` 的 `navigations[]` 反映最终状态，可按 `navigationId` 过滤；未知 `navigationId` 的结果帧被丢弃；记录超过 50 条或 10 分钟后被清理。
- [x] 同一测试文件断言：同一令牌第 7 次调用（一分钟内）返回 `RATE_LIMITED`，限速值取自导出常量；缺少 `cloudcli:navigate` scope 时返回 `INSUFFICIENT_SCOPE` 且名出缺失的 scope；对调用方自己所在的会话照常执行，不返回 `SELF_TARGET`；只有最终 `applied` 的导航更新「最后打开」记录。
- [x] `grep -rn "cloudcli:navigate" server/modules/oauth/access-tokens.service.ts server/modules/oauth/oauth-consent.routes.ts src/shared/constants.ts` 三处均有命中；12 种语言的 `settings.json` 都含新 scope 的文案键；`i18nMcpSettingsCompleteness.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts`、`mcp-insufficient-scope.test.ts` 逐文件运行退出码 0。
- [x] `npm run typecheck` 退出码 0；`quay-test-script.test.ts` 退出码 0（计数 pin 已同步）。

## DoD

在真实运行的服务上实际操作一次：用手机与桌面两个浏览器同时连接，用带 `cloudcli:navigate` 的 PAT 经 `/mcp` 先调 `ui_clients_list`，再对其中一台调 `ui_open_session`：策略为「询问」的设备显示提示条且工具返回 `pending_user`，在提示条上点「跳转」后，`ui_visible_context` 的 `navigations[]` 显示 `applied`，该设备已打开目标会话并定位到目标消息，另一台设备毫无反应；对策略为「拒绝」的设备调用返回 `declined`；不带该 scope 的令牌被拒绝。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-ui-open-session.ts
- server/modules/mcp-gateway/mcp-ui-visible-context.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/mcp-error-envelope.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/websocket/services/ui-navigation.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/index.ts
- server/shared/types.ts
- server/modules/oauth/access-tokens.service.ts
- server/modules/oauth/oauth-consent.routes.ts
- src/shared/constants.ts
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-open-session.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts
- server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts
- server/modules/mcp-gateway/tests/mcp-write-notification.test.ts
- server/modules/oauth/tests/access-token-scopes.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-ui-open-session.md
