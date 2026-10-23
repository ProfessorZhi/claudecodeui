---
id: AC-028
title: model env row is the single source of the context window
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/model-context-window.test.ts
expect: 模型条目里的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 行是上下文窗口的【单一事实来源】：同一个值既随 spawn
  环境导出给 CLI，也决定该模型会话的用量 total（SDK 路径的
  extractTokenBudget/extractCumulativeTokenBudget 与 token-usage 汇总接口两处），避免“界面显示
  917k、CLI 实际用默认窗口”两个数各说各话。解析顺序：该模型的行 → 宿主 CONTEXT_WINDOW →
  160000；非法值（0、负数、非数字）落到下一级；无配置的模型与内置模型行为与今日一致。取代 AC-005（以 profile.contextWindow
  为源）与 AC-014（类型化 contextWindow/autoCompactWindow/autoCompactPct 导出——B
  方案没有类型化字段，这些值就是 env 行本身）。取假形态：现 total 来自 options.profile?.contextWindow 或
  process.env.CONTEXT_WINDOW，模型条目的行不影响 total，必红。
origin: ADR-002 决策 6；2026-09-20 复核：AC-005/AC-014 以 profile
  与类型化字段为对象，不符合当前方向；criterion 路径随 1d76cac6 的搬迁修正：launch-profiles 目录已按 GOAL-001
  拆除，测试现居 providers
activatedAt: 2026-09-20T09:37:54.887Z
statusLog:
  - at: 2026-09-20T10:24:22.044Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
