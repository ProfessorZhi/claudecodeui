---
id: AC-027
title: "end to end in the real browser: create a model, pick it, send"
status: achieved
kind: criterion
goal: GOAL-001
criterion: npm run test:e2e -- e2e/model-library.spec.ts
expect: 真实浏览器驱动真实服务：登录 → Settings > Agents > Claude > Models → 用“LLM
  网关”模板新建一条模型（base URL 指向测试内 mock，token 填 secret 行）→ 刷新页面后 secret
  仍显示“已设置”且值不出现在页面文本或网络响应中 → 在 composer 现有模型选择器中选中它并发送 → mock 收到带该 token
  的请求。同时断言页面无未翻译的 i18n 字面量。⛔ 不得用 API 直建代替 UI 录入。取代 AC-012。取假形态：e2e
  工具链依赖（@playwright/test 已声明但主 checkout 未安装）与整条功能链今天都不存在，必红。
origin: ADR-002（配置挂在 Model library 上，取代独立 launch profile
  实体）；docs/proposals/launch-profiles.md 待随之修订
activatedAt: 2026-09-20T09:16:11.918Z
statusLog:
  - at: 2026-09-20T13:43:19.315Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-012
---
