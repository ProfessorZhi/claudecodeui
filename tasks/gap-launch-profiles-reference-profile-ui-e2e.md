---
id: gap-launch-profiles-reference-profile-ui-e2e
title: launch-profiles：参照 profile 能完全经 UI 录入并原样回显（AC-018）
status: superseded
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-permission-mode-and-suggestions
  - gap-launch-profiles-real-browser-e2e-toolchain
goal_ac: AC-018
---
## Proposal

GOAL-001 的 AC-018 要求：AC-017 的参照 profile 能只经 Settings 的 Profiles 页完整录入、保存、刷新后原样回显，并能在会话入口选中。2026-09-20 用 playwright 实机验证发现：编辑器只有名称、描述、模型、baseUrl、认证方式、环境变量名、contextWindow 这几项，缺 modelAliases 三项、authEnvVarTarget、env 表、permissionMode、promptSuggestions、设为默认；而后端 5 个 REST verb 早已齐全。结果是 profile 只能靠 API 建，建完在 UI 里只能改个名字——AC-010 是组件级 vitest，测的是组件不是产品，挡不住这一点。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-real-browser-e2e-toolchain（AC-012）补的是 e2e 工具链与首条真实浏览器判据；本任务在该工具链之上补**编辑器完整度**的实机验收，复用其 fixture 与 webServer 配置。

方案（最小切片）：
1. 编辑器补齐字段：modelAliases（opus/sonnet/haiku 三个输入）、authEnvVarTarget（下拉，限白名单内的两个目标）、env 键值表（违规键行内报错，复用后端 400 的 code 映射为可读文案）、permissionMode（取值来自 `/api/providers/capabilities`，不在组件里写死）、promptSuggestions（三态：不设置/开/关）、设为默认。`useLaunchProfiles.ts` 补 create 与 delete，与后端 verb 对齐。
2. i18n：新增键补齐全部现有语言目录（`src/modules/i18n/locales/*/settings.json`，含此前缺失的 `mainTabs.profiles` 已补的状态需复核），页面上不得出现任何形如 `launchProfiles.xxx` 的未翻译字面量。
3. 新增 `e2e/launch-profiles-reference.spec.ts`：登录 → Profiles 页 → 仅经 UI 录入参照 profile 全部字段 → 保存 → 刷新 → 各字段原样回显 → 在会话入口下拉选中它；并断言页面文本不匹配 `/\b[a-z]+\.[a-zA-Z.]+\b/` 形式的 i18n 字面量（限定在 Profiles 页与 composer 工具栏范围内）。测试用例结束时清理自己建的 profile，不残留。取假用例：去掉任一字段的输入控件时必须判红。
4. 组件级测试 `launchProfileSettings.test.tsx` 同步更新，但不以它替代 e2e。

⛔ 不得用 API 直建 profile 代替 UI 录入——本条存在的理由正是这一点。

依据：ADR-001（全局作用域、密钥不入库、env 白名单、会话锁定、toolsSettings 不进 profile、contextWindow 取代全局）。

## AC

- [ ] `npm run test:e2e -- e2e/launch-profiles-reference.spec.ts` 退出码 0（AC-018 的判据命令）。
- [ ] 测试仅经 UI 录入全部字段，刷新后原样回显；页面无未翻译 i18n 字面量；会话入口可选中该 profile。
- [ ] 取假变体（去掉任一字段的输入控件）使该 e2e 判红，红灯输出记录在任务证据中。
- [ ] `npx vitest run src/modules/settings/tests/launchProfileSettings.test.tsx src/modules/chat/tests/launchProfileSessionEntry.test.tsx` 仍退出码 0；`npm run typecheck`、`npm run lint` 通过；前端改动遵循 frontend-module-standards（`@/` 别名、无 interface、状态注释）。

## DoD

真实落地判据：不是仅有 spec 文件存在。要求真实浏览器里能只经 UI 建出与历史启动命令等价的 profile。AC-018 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-018` 能独立核验。

## Touches

- src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx
- src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts
- src/modules/settings/tests/launchProfileSettings.test.tsx
- src/modules/i18n/locales/en/settings.json
- e2e/launch-profiles-reference.spec.ts (new)
- tasks/gap-launch-profiles-reference-profile-ui-e2e.md


2026-09-20 撤回：改为 Model library 承载（ADR-002，B 方案），profile 独立实体被取代；本任务对象（Profiles 页编辑器）不再存在。