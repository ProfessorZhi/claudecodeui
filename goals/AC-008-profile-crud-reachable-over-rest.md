---
id: AC-008
title: profile CRUD reachable over REST
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/profile-rest-api.test.ts
expect: 经 REST 路由层建出一个 launch profile 并读回，profile 因此可被应用管理而非只能直写库；取假形态：模块当前没有
  launch-profiles.routes.ts，该测试今天必红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001；补立于
  GOAL-001 首次 achieved 后的范围复核
activatedAt: 2026-09-20T06:35:03.239Z
statusLog:
  - at: 2026-09-20T06:43:32.024Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:05.060Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-023 取代
superseded-by:
  - AC-023
---
