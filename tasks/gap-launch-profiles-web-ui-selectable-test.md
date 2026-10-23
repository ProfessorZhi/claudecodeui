---
id: gap-launch-profiles-web-ui-selectable-test
title: launch-profiles：Settings 增加 Profiles 页 + 会话创建入口选 profile 并随 chat.send 发出
  launchProfileId（AC-010）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-010
---
## Proposal

GOAL-001 的 AC-010 要求：Settings 的 Profiles 页能列出并编辑 profile；会话创建入口能选择 profile 并把 `launchProfileId` 随 `chat.send` 发出，缺省（不选）时不带该字段、走服务端解析链。取假形态：`src/` 下目前没有任何 profile 相关代码，判据两个 vitest 文件今天必红。`tasks/` 中没有任何任务以 `goal_ac: AC-010` 推进该判据，这是结构性缺口。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）与 ADR-001。判据走前端 runner（`npx vitest run`，即 `npm run test:client`），不能依赖只跑后端的 `npm test`。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-rest-crud-routes-test（AC-008）提供 `/api/launch-profiles` REST CRUD 后端；本任务只做前端消费方，通过该 REST 接口读写，不改 server/。测试里用 mock 的 fetch/authenticatedFetch，不依赖后端已落地。

方案（最小切片，遵循 frontend-module-standards：模块内聚、跨模块只走 index、类型显式）：
1. 新增 `src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx` 与配套 hook `useLaunchProfiles.ts`：GET `/api/launch-profiles` 列出 profile，支持编辑名称/配置并 PUT 保存（凭据字段只展示引用名，不回显明文）。在 `Settings.tsx` 与 `SettingsSidebar.tsx` 注册 `profiles` 标签页，补 i18n 文案键。
2. 会话创建入口（`src/modules/chat/composer/` 下新增 `LaunchProfileSelect.tsx`，由 `useChatComposerState.ts` 持有 `launchProfileId` 状态）：选择 profile 后，`chat.send` 消息体携带 `launchProfileId`；未选择时消息体不含该字段。
3. 新增 `src/modules/settings/tests/launchProfileSettings.test.tsx`：渲染 Profiles 页，mock 列表返回两个 profile，断言列出；编辑其中一个并保存，断言发出的 PUT 请求 URL/体正确。
4. 新增 `src/modules/chat/tests/launchProfileSessionEntry.test.tsx`：渲染选择入口，选中某 profile 后触发发送，断言 `chat.send` 消息含该 `launchProfileId`；不选时断言消息不含该字段（缺省走解析链）。

## AC

- [x] `npx vitest run src/modules/settings/tests/launchProfileSettings.test.tsx src/modules/chat/tests/launchProfileSessionEntry.test.tsx` 退出码 0（AC-010 的判据命令）。
- [x] settings 测试断言列表渲染出 mock 的全部 profile 名称，且编辑保存后 PUT `/api/launch-profiles/:id` 的请求体含修改后的字段。
- [x] chat 测试断言选中 profile 后发出的 `chat.send` 消息 `launchProfileId` 等于所选 id；未选时 `'launchProfileId' in message` 为 false。
- [x] `test -f src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx` 且 `grep -n "launchProfileId" src/modules/chat/hooks/useChatComposerState.ts` 有命中；`npm run typecheck` 与 `npm run test:client` 退出码 0（既有前端测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求 Profiles 页真实注册进 Settings 并可从侧边栏进入，会话创建入口在真实 composer 里可选 profile，且真实发送路径（`useChatComposerState` 的 send 逻辑）产出带 `launchProfileId` 的 `chat.send` 消息，测试经真实组件渲染与用户交互驱动，而非直接调用内部函数。AC-010 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-010` 能独立核验该任务。

## Touches

- src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx (new)
- src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts (new)
- src/modules/settings/Settings.tsx
- src/modules/settings/SettingsSidebar.tsx
- src/modules/chat/composer/LaunchProfileSelect.tsx (new)
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/settings/tests/launchProfileSettings.test.tsx (new)
- src/modules/chat/tests/launchProfileSessionEntry.test.tsx (new)
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/settings/hooks/useSettingsController.ts
- src/shared/types.ts
- tasks/gap-launch-profiles-web-ui-selectable-test.md

## Needs-Human

**执行 2026-09-20T06:43:41.424Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-launch-profiles-web-ui-selectable-test — 9 violation(s)
- run_id：wk-prod-anchor
- session_id：f0529a41-6cf1-4fab-a1fe-bb2ad5d9232c
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-web-ui-selectable-test-wk-prod-anchor.log
