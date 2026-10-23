---
id: AC-009
title: real profile compiles to non-empty spec
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/launch-spec-real-profile.test.ts
expect: 由一条真实落库的 profile 记录驱动 resolveLaunchSpec，断言产出非空 argv，且 spec.contextWindow
  取 profile 值而非只读 CONTEXT_WINDOW；⛔ 不得经 dependencies.resolveLaunchSpec 这类 seam
  注入假 spec —— 本条存在的理由正是 AC-006 只证明了接线形状、未证明真实 profile 能产出 argv；取假形态：现实现恒返回
  argv:[] 且第 87 行只读 env，今天必红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001；补立于
  GOAL-001 首次 achieved 后的范围复核
activatedAt: 2026-09-20T06:35:03.247Z
statusLog:
  - at: 2026-09-20T06:45:58.951Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:05.817Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-024 取代
superseded-by:
  - AC-024
---
