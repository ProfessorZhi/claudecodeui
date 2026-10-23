---
id: AC-005
title: context window follows profile
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/context-window-per-profile.test.ts
expect: token 用量的 total 等于 profile.contextWindow，而非硬编码的 160000；并验证 profile
  未设时回退到 CONTEXT_WINDOW 再回退到 160000；取假形态：沿用硬读即红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.312Z
statusLog:
  - at: 2026-09-20T04:20:30.464Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:38:11.312Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 复核：以 profile.contextWindow 为源，B 方案下单一事实来源改为模型条目的
      CLAUDE_CODE_MAX_CONTEXT_TOKENS 行，由 AC-028 覆盖
superseded-by:
  - AC-028
---
