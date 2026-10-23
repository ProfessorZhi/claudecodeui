---
id: AC-011
title: env allowlist rejects on the write path
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/env-allowlist-write-path.test.ts
expect: POST /api/launch-profiles 携带 config.env.LD_PRELOAD（或 PATH /
  NODE_OPTIONS）时必须被拒绝（4xx），且该键不得出现在任何已落库的记录里。ADR-001 决策 3 与 AC-004 的 expect
  都要求【写入路径与编译路径各自拒绝】，2026-09-20 实机验证发现写入这一半未实现：带 LD_PRELOAD 的 payload 返回 201
  并被持久化，而 AC-004 仍为绿 —— 说明那条测试只覆盖了编译路径。取假形态：现实现接受该 payload，本条今天必红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001；补立于
  2026-09-20 的 playwright 实机验证
activatedAt: 2026-09-20T07:43:31.583Z
statusLog:
  - at: 2026-09-20T07:51:48.340Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:05.449Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-023 取代
superseded-by:
  - AC-023
---
