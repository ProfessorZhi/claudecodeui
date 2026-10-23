---
id: AC-002
title: gateway request actually lands
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/gateway-end-to-end.test.ts
expect: 以 gateway profile 跑一轮真实 chat.send，测试内 mock 的 Anthropic 兼容服务器确实收到该请求，且
  Authorization 头来自 profile 引用的环境变量；取假形态：profile 未生效时请求打到默认端点，mock 收不到即红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.309Z
statusLog:
  - at: 2026-09-20T04:22:35.486Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:06.569Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-025 取代
superseded-by:
  - AC-025
---
