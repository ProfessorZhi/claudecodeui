---
id: AC-012
title: launch profile usable end-to-end in the real app
status: superseded
kind: criterion
goal: GOAL-001
criterion: npm run test:e2e -- e2e/launch-profiles.spec.ts
expect: 真实浏览器驱动真实服务：登录 → 打开 Settings 的 Profiles 页 → 从 UI 新建一条 profile →
  在会话创建入口选中它。断言三件事：(a) 页面上不出现任何未翻译的 i18n 字面量（形如 mainTabs.profiles）；(b) profile
  编辑器能录入 baseUrl / 认证方式 / 上下文窗口，不是只有 name+model 两个框；(c) 选中的 profile 随会话发出。⛔ 组件级
  vitest 不满足本条 —— AC-010 正是组件测试绿、而实机三处都坏的反例。范围含补齐 e2e 工具链（@playwright/test
  依赖、playwright.config 的 webServer、test:e2e 脚本），因此今天 npm run test:e2e
  不存在即为红，这是预期的第一形态。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001；补立于
  2026-09-20 的 playwright 实机验证
activatedAt: 2026-09-20T07:43:31.593Z
statusLog:
  - at: 2026-09-20T09:17:08.748Z
    from: active
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-027 取代
superseded-by:
  - AC-027
---
