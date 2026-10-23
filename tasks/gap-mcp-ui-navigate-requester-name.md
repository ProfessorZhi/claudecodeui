---
id: gap-mcp-ui-navigate-requester-name
title: ui_open_session 的导航记录 requestedBy 为 null、提示条只能显示兜底名 MCP：请求方名称取令牌所属的 OAuth
  客户端名或 PAT 名
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**Finding（2026-10-07，对运行中的服务做真实调用）：** 用 PAT 调 `ui_open_session` 后，`ui_visible_context` 的 `navigations[0]` 里 `requestedBy: null`。确认提示条的目的之一是让用户知道是谁在要求跳转，所以请求方名称为空会让「询问」策略失去一半意义。

**现状（已读代码核实）：**

- `server/modules/mcp-gateway/mcp-ui-open-session.ts:368` 传 `requestedBy: principal.clientId`；`mcp-gateway.auth.ts` 里 PAT 的 `clientId` 恒为 `null`（PAT 不是发给某个 OAuth 客户端的），所以 PAT 调用必然是 `null`。
- 即使是 OAuth 令牌，`clientId` 也是客户端 id，不是给人看的名字，直接显示在提示条上不友好。
- 前端 `src/modules/chat/hooks/useUiNavigate.ts` 在帧里没有可用的 `requester` 时回退为常量 `'MCP'`（`UNKNOWN_REQUESTER`），所以现在提示条只会显示 MCP，看不出是谁。
- 已有一个先例做同样的事：`server/modules/settings/settings.module.ts:74` 的 `resolveClientName` 把审计行解析成人能读的客户端名，`mcp-write-notification.ts` 的 `resolveClientName(principal)` 也对 principal 做同样的事（通知文案里用）。本任务应复用这套解析，不另写第二份。
- 访问令牌表（`server/modules/database/repositories/access-tokens.ts`）有 `name` 列，PAT 的名字就存在这里。

**要交付：**

1. 请求方名称解析：OAuth 令牌取其客户端的展示名（取不到时用客户端 id 的缩写），PAT 取令牌的 `name`（为空时用「Personal access token」之类的固定文案）；复用已有的 `resolveClientName` 的解析，不重复实现。名称截断到有界长度。
2. `mcp-ui-open-session.ts` 把解析出的名称放进 `requestedBy`，并经 `ui.navigate` 帧的 `requester` 字段送到前端；导航记录里的 `requestedBy` 也是这个名称，`ui_visible_context` 的 `navigations[]` 因此能返回它。
3. 前端提示条显示该名称（`UiNavigatePrompt.tsx`），无名称时才回退为兜底文案。
4. 名称是用户可设置的字符串，渲染时按文本处理，不得当作 HTML。
5. 不新增 `server/**/*.test.ts` 文件：断言写进已有的 `server/modules/mcp-gateway/tests/mcp-ui-open-session.test.ts` 与 `src/modules/chat/tests/uiNavigate.test.tsx`。

## AC

- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-open-session.test.ts` 退出码 0，且新增断言：PAT 调用时 `ui.navigate` 帧的 `requester` 等于该 PAT 的 `name`；OAuth 令牌调用时等于其客户端展示名；PAT 名为空时是固定文案而不是 `null`；`navigations[0].requestedBy` 与帧里的 `requester` 一致。
- [x] 同一测试文件断言：超长名称被截断到有界长度。
- [x] `npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出码 0，且新增断言：提示条文案里含帧里的请求方名称，名称含 `<b>x</b>` 之类标记时按文本渲染（不产生元素）；只有帧里没有可用名称时才显示兜底名。
- [x] `grep -n "resolveClientName" server/modules/mcp-gateway/mcp-ui-open-session.ts server/index.ts` 显示解析经已有的 `resolveClientName` 接入，且全仓库没有第二个独立实现（`grep -rn "function resolveClientName\|resolveClientName:" server --include=*.ts | grep -v tests` 的命中点不增加新的解析逻辑）。
- [x] `npm run typecheck` 退出码 0；`mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0。

## DoD

在真实运行的服务上实际操作一次：用一个名为 `probe-ui-open` 的 PAT 调 `ui_open_session`，浏览器里的确认提示条上写着「probe-ui-open」想带你去某会话，而不是「MCP」；点「跳转」后 `ui_visible_context` 的 `navigations[]` 里 `requestedBy` 也是 `probe-ui-open`。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-ui-open-session.ts
- server/modules/mcp-gateway/mcp-write-notification.ts
- server/modules/mcp-gateway/index.ts
- server/modules/websocket/services/ui-navigation.service.ts
- server/index.ts
- src/modules/chat/components/UiNavigatePrompt.tsx
- src/modules/chat/hooks/useUiNavigate.ts
- server/modules/mcp-gateway/tests/mcp-ui-open-session.test.ts
- server/modules/mcp-gateway/tests/mcp-write-notification.test.ts
- src/modules/chat/tests/uiNavigate.test.tsx
- tasks/gap-mcp-ui-navigate-requester-name.md
