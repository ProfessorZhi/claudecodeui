---
id: AC-018
title: reference profile fully authorable through the UI
status: superseded
kind: criterion
goal: GOAL-001
criterion: npm run test:e2e -- e2e/launch-profiles-reference.spec.ts
expect: 真实浏览器驱动真实服务：登录 → Settings 的 Profiles 页 → 仅通过 UI 录入 AC-017 的参照 profile
  全部字段（含 modelAliases 三项、authEnvVarTarget、env
  表、permissionMode、promptSuggestions、设为默认）→ 保存 → 刷新页面 → 各字段原样回显 → 在会话入口选中它。⛔ 不得用
  API 直建代替 UI 录入 —— 本条存在的理由正是 2026-09-20 实机发现编辑器只有 name+model，而后端 5 个 verb
  已齐；同时断言页面无未翻译的 i18n 字面量。取假形态：编辑器目前缺 modelAliases/authEnvVarTarget/env
  表/permissionMode/默认开关，今天必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于
  2026-09-20：对照用户历史启动命令（claude-fjdac + 917k 上下文三件套 + --permission-mode
  bypassPermissions + --prompt-suggestions false）复核 profile 机制所得缺口
activatedAt: 2026-09-20T08:17:01.381Z
statusLog:
  - at: 2026-09-20T09:17:07.304Z
    from: active
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-026 取代
superseded-by:
  - AC-026
---
