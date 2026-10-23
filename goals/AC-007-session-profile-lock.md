---
id: AC-007
title: session profile lock
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/session-profile-lock.test.ts
expect: 已锁定会话传入不同 launchProfileId 时以已存值为准并回带
  profileLocked，不报错不中断；取假形态：客户端值被采纳，或请求被拒绝，两者都红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.313Z
statusLog:
  - at: 2026-09-20T06:04:57.194Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:09.106Z
    from: achieved
    to: superseded
    actor: yale
    reason: 会话级 profile 锁定：ADR-002 第一版不做，已知风险已登记（跨供应商 resume 可能出错，未实测）
---
