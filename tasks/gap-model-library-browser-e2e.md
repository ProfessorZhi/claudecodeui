---
id: gap-model-library-browser-e2e
title: model-library：真实浏览器端到端——建模型、选中、发送、mock 收到（AC-027）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-library-gateway-end-to-end
  - gap-model-library-settings-ui
  - gap-launch-profiles-real-browser-e2e-toolchain
goal_ac: AC-027
---
## Proposal

GOAL-001 的 AC-027：整条链路的实机验收。此前 AC-010 是组件级 vitest，测的是组件不是产品，挡不住 i18n key 外泄、编辑器只有两个字段、入口缺失。本任务用真实浏览器驱动真实服务，把“建模型 → 选中 → 发送 → 请求落地”走一遍。

方案（最小切片）：
1. 新增 `e2e/model-library.spec.ts`，复用 e2e 工具链任务已落地的 playwright 配置与 webServer。
2. 用例：登录 → Settings > Agents > Claude > Models → 用“LLM 网关”模板新建模型（base URL 指向测试内 mock，token 填 secret 行）→ 刷新页面 → secret 仍显示“已设置”，且值不出现在页面文本与任何网络响应中 → 在 composer 现有模型选择器中选中该模型并发送 → mock 收到带该 token 的请求。
3. 同时断言页面文本无未翻译的 i18n 字面量（限定在 Models 页与 composer 工具栏范围内）；结束时清理自己建的模型，不残留。
4. ⛔ 不得用 API 直建代替 UI 录入。取假用例：去掉网关模板或 secret 掩码时必须判红。

⚠️ 环境事实须登记：`@playwright/test` 已在 package.json 声明，但主 checkout 的 node_modules 里未安装（`npm run test:e2e` 报 playwright: not found），worker 在自己的 worktree 里装过。该判据在主 checkout 上要变绿，需先 `npm install`；这是环境步骤，不是功能缺口，须在任务证据里区分。

依据：ADR-002（配置挂在 Model library 上；密钥允许存于 config_json 但只写；unset 为显式行类型；同 model id 不跨端点；第一版含 LLM 网关模板）。

## AC

- [x] `npm run test:e2e -- e2e/model-library.spec.ts` 退出码 0（AC-027 的判据命令）。
- [x] 测试仅经 UI 建模型；刷新后 secret 为“已设置”且值不出现在页面文本与网络响应；选中并发送后 mock 收到带该 token 的请求；页面无未翻译字面量。
- [x] 取假变体使该 e2e 判红，红灯输出记录在任务证据中；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有 spec 文件存在。要求真实浏览器里能只经 UI 完成整条链路。AC-027 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-027` 能独立核验。

## Touches

- e2e/model-library.spec.ts (new)
- tasks/gap-model-library-browser-e2e.md

## Evidence

- 绿灯：`npm run test:e2e -- e2e/model-library.spec.ts` → 3 passed（建模型 / 刷新后 secret 仅“Set” / 选中并发送，mock 网关收到 `Bearer <token>` 且 body 含 model id）。`npm run typecheck` exit 0。
- 环境步骤（非功能缺口）：主 checkout node_modules 未装 `@playwright/test`，本 worker 用 `npm install --no-save @playwright/test` 补装；主 checkout 上跑该判据需先 `npm install`。
- 取假变体 A（ModelLibraryPanel 的 `showGatewayTemplate={false}`）→ 用例 1 红：`waiting for getByRole('button', { name: 'LLM gateway template' })` 超时，exit=1。
- 取假变体 B（ModelEnvEditor `toEditorRows` 令 `secretStored:false`，即去掉 secret 掩码/已设置徽标）→ 用例 2 红：`getByTestId('secret-set-badge')` element(s) not found。两处变体均已还原，未入提交。
