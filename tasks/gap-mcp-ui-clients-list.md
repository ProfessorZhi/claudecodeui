---
id: gap-mcp-ui-clients-list
title: MCP 只读工具 ui_clients_list：列出当前在线的浏览器设备（身份、标签页、可见性、导航策略），供调用方选设备
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-ui-visible-context
---
## Proposal

**背景（2026-10-07 与 yale 的讨论）：** 典型场景是 ChatGPT 先发现有哪些在线浏览器，再选一台去观察（`ui_visible_context { client }`）或操纵（`ui_open_session { client }`）。发现和观察是两个动作，所以单独做一个只读工具，而不是让 `ui_visible_context` 兼任：发现要列出全部设备及其策略，观察一次只查一台，返回更小也更快。

**现状（已读代码核实）：**

- 设备身份（`deviceId`、`tabId`、设备名、`listUiClients()`）由 `gap-mcp-ui-device-identity-hello` 提供；往返原语 `requestUiState` 与前端应答（含 `navigationPolicy`、`visibility`、`hasFocus`、`lastFocusedAt`）由 `gap-mcp-ui-visible-context` 提供，本任务直接复用，不重写第二套。
- 读工具表、annotations、错误码词汇、audit、barrel 与前两个 MCP 任务相同。
- 仓库既有形态：使用 `@/*` 别名的 server 测试要带 `TSX_TSCONFIG_PATH=server/tsconfig.json` 才能直接运行；`quay-test-script` 的文件数 pin 只在 `server/shared/tests/quay-test-script.test.ts` 里，`scripts/test.sh` 没有字面量。

**要交付：**

1. 新文件 `server/modules/mcp-gateway/mcp-ui-clients-list.ts` 注册 `ui_clients_list {}`（scope `cloudcli:read`）：以 `listUiClients()` 为设备清单，内部做一次 `requestUiState` 往返，返回 `devices[]`，每项含 `deviceId`、`deviceName`、`tabs[]`（`tabId`、`connectedAt`）、`lastFocusedAt`、`visibility`、`hasFocus`、`navigationPolicy`、`unresponsive`。按 `lastFocusedAt` 降序。无设备返回 `devices: []`。
2. **同名设备区分：** 多台设备的名字相同（例如两台 Linux 上的 Chrome）时，返回里在名字后加稳定的短后缀（取 `deviceId` 前几位），使名字在一次返回内唯一，调用方才能按名字选。
3. 返回里不含任何会话内容，只有身份与状态。
4. 加进读工具表、`mcp-tool-annotations.ts`（`readOnlyHint: true`、`openWorldHint: false`）、`mcp-tool-error-codes.ts`，走现有错误信封与审计，经 barrel 导出；遵守 `$backend-module-standards`；同步 `server/shared/tests/quay-test-script.test.ts` 里的文件数 pin。

## AC

- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-clients-list.test.ts` 退出码 0：用假设备断言返回的 `devices[]` 含身份、标签页、可见性、策略，按 `lastFocusedAt` 降序；无设备时 `devices: []`；一个设备不应答时标 `unresponsive` 且整次调用在约 1.5s 内返回。
- [x] 同一测试文件断言：两台默认名相同的设备在返回里名字带不同的短后缀，且后缀在同一 `deviceId` 的两次调用间保持不变。
- [x] 同一测试文件断言：结构化返回中不出现消息正文、选中文本或会话标题以外的会话内容字段。
- [x] `grep -n "ui_clients_list" server/modules/mcp-gateway/mcp-tool-annotations.ts server/modules/mcp-gateway/mcp-tool-error-codes.ts server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 三个文件均有命中，已有的 `mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0。
- [x] `npm run typecheck` 退出码 0；`quay-test-script.test.ts` 退出码 0（计数 pin 已同步）。

## DoD

在真实运行的服务上实际操作一次：用手机和桌面两个浏览器同时连接，用 PAT 经 `/mcp` 调用 `ui_clients_list`，两台设备都出现，名字可区分，策略与各自 Settings 里的设置一致；关闭其中一台再调用，只剩另一台。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-ui-clients-list.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-ui-clients-list.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-ui-clients-list.md
