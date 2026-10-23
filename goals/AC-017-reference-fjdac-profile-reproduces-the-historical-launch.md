---
id: AC-017
title: reference fjdac profile reproduces the historical launch
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/reference-fjdac-profile.test.ts
expect: 以用户历史上的 claude-fjdac 启动方式为参照 fixture：baseUrl
  http://127.0.0.1:26510/、authEnvVarName
  FJDAC_API_KEY→ANTHROPIC_AUTH_TOKEN、modelAliases 三项 v4.1flash、defaultModel
  deepseek-v4-pro-anthropic、contextWindow/autoCompactWindow
  917000、autoCompactPct 80、permissionMode bypassPermissions、promptSuggestions
  false、env 含 DISABLE_ALTERNATE_SCREEN=1 与 DISABLE_MOUSE=1。经真实 resolveLaunchSpec
  编译后，断言 spec.env 与 spec.argv 与历史命令逐键等价（集合比较，凭据值只断言存在与来源、不落断言文本）。这是
  AC-013/014/015/016 的合取验收：任一环缺失，该 fixture 就无法复现原命令。已知不等价点须在测试注释里如实登记：wrapper
  同时导出 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_API_KEY，而 profile 只有单一
  authEnvVarTarget。取假形态：今天 env/permissionMode/promptSuggestions 三处缺失，必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于
  2026-09-20：对照用户历史启动命令（claude-fjdac + 917k 上下文三件套 + --permission-mode
  bypassPermissions + --prompt-suggestions false）复核 profile 机制所得缺口
activatedAt: 2026-09-20T08:17:01.375Z
statusLog:
  - at: 2026-09-20T09:17:06.200Z
    from: active
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-024 取代
superseded-by:
  - AC-024
---
