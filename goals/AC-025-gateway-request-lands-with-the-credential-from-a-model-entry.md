---
id: AC-025
title: gateway request lands with the credential from a model entry
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/model-gateway-end-to-end.test.ts
expect: 测试内起 mock Anthropic 兼容服务，建一条自定义模型（base URL 指向 mock，secret 行为 token，unset
  ANTHROPIC_API_KEY），经真实 chat.send（options.model 为该模型 id，⛔ 不携带任何 env）跑一轮，断言 mock
  收到该请求、认证头来自 secret 行、且宿主环境里的 ANTHROPIC_API_KEY 没有出现在请求里。对照组：选内置模型时请求不打到
  mock。(d) 客户端经 chat.send 的 options.env 伪造的环境被后端完全忽略（接过 AC-004 的 WebSocket
  半边）。取代 AC-002 与 AC-004（WebSocket 半边）。取假形态：模型条目今天不影响 spawn 环境，请求打不到 mock，必红。
origin: ADR-002；criterion 路径随 1d76cac6（relocate shared compile layer）与
  b34a662e（拆除 launch-profiles 目录）修正：AC-025 的网关端到端判据现居 providers，测试逐字未改、五个用例一个不减
activatedAt: 2026-09-20T09:16:11.906Z
statusLog:
  - at: 2026-09-20T09:57:10.158Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-002
---
