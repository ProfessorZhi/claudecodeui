---
id: gap-mcp-ui-device-identity-hello
title: 设备身份：前端生成 deviceId/tabId，WS 连接后发一次 ui.hello，服务端把身份挂到连接上（内存，断开即移除）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-ui-device-settings
---
## Proposal

**背景（2026-10-07 与 yale 的讨论）：** 要让 MCP 调用方「选一台设备」，需要稳定的设备身份；WS 连接 id 刷新即变，一个设备还可能开多个标签页，不能当设备 id。本任务建立三层身份并让服务端在连接时知道它，这是 `ui_clients_list`、`ui_visible_context` 的 `client` 参数、`ui_open_session` 的共同前提。仍然是懒模式：身份只在连接时发一次，易变状态（可见性、当前会话）依然只在被问到时才回答。

**身份模型：**

- `deviceId`：前端首次启动生成的 UUID，存 localStorage，清除站点数据才重置；对外选设备选的就是它。
- `tabId`：存 sessionStorage，刷新保持，新标签页不同。
- `connectionId`：服务端生成，随 WS 连接，不暴露给调用方。
- 设备名取自 `gap-mcp-ui-device-settings` 的 `readDeviceName()`。

**现状（已读代码核实）：**

- 服务端全部聊天 WS 连接在 `server/modules/websocket/services/websocket-state.service.ts` 的 `connectedClients`（`RealtimeClientConnection`，类型在 `server/shared/types.ts`）。
- 入站帧分派在 `server/modules/websocket/services/chat-websocket.service.ts` 的 `switch (messageType)`；前端 WS 在 `src/shared/context/WebSocketContext.tsx`（已有 `hosts_changed` 的入站处理）。
- 服务端目前没有任何设备或客户端身份的概念。
- 仓库既有形态：使用 `@/*` 别名的 server 测试要带 `TSX_TSCONFIG_PATH=server/tsconfig.json` 才能直接运行（`scripts/test.sh` 即如此）；`quay-test-script` 的文件数 pin 只在 `server/shared/tests/quay-test-script.test.ts` 里，`scripts/test.sh` 没有字面量。

**要交付：**

1. **前端：** 新文件 `src/shared/utils/deviceIdentity.ts` 提供 `getDeviceId()` / `getTabId()`（读取失败或不可用时退回内存中的随机值，不抛错）；在 `WebSocketContext.tsx` 每次连接建立后发送一次 `{ type: 'ui.hello', deviceId, tabId, deviceName }`（重连也重发）。
2. **服务端：** 新文件 `server/modules/websocket/services/ui-client-registry.service.ts`（遵守 `$backend-module-standards`，经 websocket barrel 导出）：在 `ui.hello` 到达时把 `{ deviceId, tabId, deviceName, connectedAt }` 挂到该连接上；连接关闭即移除；对外提供只读查询 `listUiClients()`，按 `deviceId` 聚合成设备，每个设备带 `tabs[]`。字段校验：`deviceId`/`tabId` 必须是长度有界的字符串，设备名截断到有界长度，不合法的 `ui.hello` 丢弃并不影响连接。同一 `deviceId` 来自多条连接时视作同一设备的多个标签页，不报错。
3. 没有持久化的设备表；不新增持续上报。

## AC

- [x] `npx vitest run src/shared/tests/deviceIdentity.test.ts` 退出码 0：`getDeviceId()` 在同一 localStorage 内稳定、清除后变化；`getTabId()` 在同一 sessionStorage 内稳定、不同 sessionStorage 不同；存储不可用时不抛错。
- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/websocket/tests/ui-client-registry.test.ts` 退出码 0：`ui.hello` 后 `listUiClients()` 返回该设备；连接关闭后消失；同一 `deviceId` 的两条连接聚合为一个设备两个标签页；字段超长或类型错误的 `ui.hello` 被丢弃且连接保持。
- [x] 前端测试断言每次 WS（重新）连接后恰好发送一次 `ui.hello`，且内容含 `deviceId`、`tabId` 与设备名。
- [x] `npm run typecheck` 退出码 0；`quay-test-script` 的文件数 pin 已同步（只在 `server/shared/tests/quay-test-script.test.ts`），该测试退出码 0。

## DoD

在真实运行的服务上用两个浏览器标签页连接，其中一个刷新：服务端的 `listUiClients()` 始终只显示同一个设备，标签页数随打开与关闭变化，`deviceId` 在刷新前后不变。仅有测试夹具通过不算完成。

## Touches

- src/shared/utils/deviceIdentity.ts
- src/shared/context/WebSocketContext.tsx
- src/shared/types.ts
- src/shared/tests/deviceIdentity.test.ts
- server/modules/websocket/services/ui-client-registry.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/index.ts
- server/shared/types.ts
- server/modules/websocket/tests/ui-client-registry.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-ui-device-identity-hello.md
