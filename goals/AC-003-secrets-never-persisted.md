---
id: AC-003
title: secrets never persisted
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/secret-never-persisted.test.ts
expect: 写入带凭据的 profile payload 后，在 sqlite 全库检索不到该凭据值；取假形态：把值写进任一列都会被检索命中而变红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.310Z
statusLog:
  - at: 2026-09-20T04:00:50.283Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:04.687Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-022 取代
superseded-by:
  - AC-022
---
