---
id: gap-mcp-ui-device-settings
title: Settings 增加本设备的 MCP 导航策略（接受/询问/拒绝，默认询问）与设备名，存 localStorage，并补全各语言 i18n
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**背景（2026-10-07 与 yale 的讨论）：** 计划新增 MCP 工具 `ui_open_session`，让外部 agent 在用户指定的浏览器里打开某个会话并定位到某处。是否允许、是否需要确认由**每台设备各自**决定，所以策略与设备名都存在该浏览器的 localStorage，不存服务端。本任务只交付前端的设置与存储，不依赖其他任务，可最先落地；后续任务（设备身份、导航执行与确认界面）读取这里的值。

**现状（已读代码核实）：**

- MCP 设置块在 `src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx`，由 `CredentialsSettingsTab.tsx` 渲染；设置页组件有 `SettingsRow`、`SettingsSection`、`SettingsToggle`（`src/modules/settings/`）。
- 设置文案在 `src/modules/i18n/locales/<lang>/settings.json`，共 12 种语言（de、en、es、fr、id、it、ja、ko、ru、tr、zh-CN、zh-TW）；`src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts` 用一份独立的必需键清单遍历全部语言，缺键会红。
- 项目里已有把偏好放进 localStorage 的先例（permissionMode，见 `src/modules/chat/hooks/useChatComposerState.ts` 附近与其测试），可参照其读写与跨标签同步写法。

**要交付：**

1. **hook（新文件 `src/modules/settings/hooks/useMcpNavigationSettings.ts`）：** 读写两个 localStorage 键——导航策略 `accept | ask | reject`（未设置、值非法、读取抛错时一律按 `ask`），设备名（未设置时由 User-Agent 推出人能读的默认名，粒度只到浏览器与系统类别，例如「Chrome · Linux」，不含版本号与 IP；用户可改名，改成空串则回到默认名）。同时导出不依赖 React 的纯读取函数 `readMcpNavigationPolicy()` 与 `readDeviceName()`，供非组件代码（WS 应答、导航执行）使用。监听 `storage` 事件，同一浏览器的多个标签页保持一致。
2. **设置页一节：** 在 `McpGatewaySection.tsx` 内或其相邻的新组件里加「导航请求」一节，含三态选择和设备名输入框，写明「仅对本设备生效」。
3. **i18n：** 为新增键在 12 个 `settings.json` 都补全译文，并把新键加入 `i18nMcpSettingsCompleteness.test.ts` 的必需键清单。

## AC

- [x] `npx vitest run src/modules/settings/tests/mcpNavigationSettings.test.tsx` 退出码 0：断言 hook 在无值、非法值、读取抛错时返回 `ask`；写入后读到新值；`storage` 事件使另一个 hook 实例同步；设备名为空时回到由 User-Agent 推出的默认名，且默认名不含版本号。
- [x] 同一测试文件断言设置页渲染出三态选择与设备名输入框，切换后 localStorage 中的值随之改变，且页面上写明该设置仅对本设备生效。
- [x] `npx vitest run src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts` 退出码 0，且该测试的必需键清单包含本任务新增的全部键；`ls src/modules/i18n/locales/*/settings.json | wc -l` 为 12，每个文件都含新键。
- [x] `npm run typecheck` 退出码 0，`npx oxlint src/modules/settings` 退出码 0。

## DoD

在真实运行的前端里打开 Settings → API，把本设备策略改为「拒绝」并改设备名，刷新页面后两者保持；在另一个标签页里读到同样的值；清除站点数据后回到「询问」与默认名。仅有测试通过不算完成。

## Touches

- src/modules/settings/hooks/useMcpNavigationSettings.ts
- src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx
- src/modules/settings/tabs/api-settings/sections/McpNavigationSection.tsx
- src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx
- src/modules/settings/tests/mcpNavigationSettings.test.tsx
- src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts
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
- src/modules/settings/index.ts
- tasks/gap-mcp-ui-device-settings.md
