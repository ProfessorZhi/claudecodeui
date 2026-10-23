---
id: AC-014
title: typed context fields export the real CLI env
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/context-window-env-export.test.ts
expect: config.contextWindow / autoCompactWindow / autoCompactPct 设置时，spec.env
  必须分别带上 CLAUDE_CODE_MAX_CONTEXT_TOKENS / CLAUDE_CODE_AUTO_COMPACT_WINDOW /
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE，使 917000 不只改用量显示、也真的改 CLI
  行为；未设置的字段不得导出（不覆盖宿主环境）；与 config.env 同键冲突时类型化字段胜出并产出 warning。取假形态：现只有
  resolveContextWindow 改显示，spec.env 无这些键，今天必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于
  2026-09-20：对照用户历史启动命令（claude-fjdac + 917k 上下文三件套 + --permission-mode
  bypassPermissions + --prompt-suggestions false）复核 profile 机制所得缺口
activatedAt: 2026-09-20T08:17:01.357Z
statusLog:
  - at: 2026-09-20T08:29:42.059Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:38:11.668Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 复核：类型化 contextWindow/autoCompactWindow/autoCompactPct 字段在 B
      方案下不存在（第一版不做类型化字段），值即 env 行，由 AC-028 覆盖
superseded-by:
  - AC-028
---
