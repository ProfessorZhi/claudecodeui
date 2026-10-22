---
id: AC-004
title: env injection surface closed
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/env-injection-closed.test.ts
expect: 白名单在写入路径与编译路径各自拒绝 PATH/NODE_OPTIONS/LD_PRELOAD 等键；且经 WebSocket 伪造的
  options.env 被后端完全忽略；取假形态：任一路径漏判或客户端 env 被采纳即红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.311Z
statusLog:
  - at: 2026-09-20T05:54:37.990Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:38:10.590Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 复核：写入路径半边由 AC-023、编译路径半边由 AC-024、WebSocket 伪造 env 半边由 AC-025
      接过；原测试以旧 profile 服务为对象
superseded-by:
  - AC-024
---
