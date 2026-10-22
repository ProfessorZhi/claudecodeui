---
id: gap-launch-profiles-context-fields-export-env
title: launch-profiles：contextWindow / autoCompactWindow / autoCompactPct 导出真实
  CLI 环境变量（AC-014）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-config-env-compiled
goal_ac: AC-014
---
## Proposal

GOAL-001 的 AC-014 要求：类型化上下文字段设置时，spec.env 必须带上对应的真实 CLI 变量，使 917000 不只改用量显示、也真的改 CLI 行为。现状：`config.contextWindow` 只被 `resolveContextWindow` 消费，用来改用量百分比的 `total`；它**不导出** `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，所以界面显示 917k、CLI 实际仍按默认窗口压缩——两者各说各话。`autoCompactWindow`、`autoCompactPct` 在 proposal 的 `LaunchProfileConfig` 里有定义，实现里没有任何消费。用户历史启动命令的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=917000 CLAUDE_CODE_AUTO_COMPACT_WINDOW=917000 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` 因此无处表达。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-context-window-per-profile（AC-005，已 done）解决的是用量 `total` 的解析顺序；本任务解决的是同一个值向 CLI 的**导出**。

⚠️ 事实依据须如实登记：官方 env-vars 页收录了 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE，但**未收录** CLAUDE_CODE_MAX_CONTEXT_TOKENS 与 CLAUDE_CODE_AUTO_COMPACT_WINDOW；这两个变量实际可用（用户历史命令在用），但属未公开接口。代码注释与文档须标明这一点，按"尽力而为"对待。

方案（最小切片）：
1. 编译步骤：`contextWindow` 为正整数时导出 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`；`autoCompactWindow` 导出 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`；`autoCompactPct`（1-100 的整数）导出 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`。未设置的字段**不导出**（不覆盖宿主环境）；非法值丢弃并产出 warning。
2. 与 config.env 同键冲突时类型化字段胜出并产出 warning（沿用 AC-013 的优先级约定）。
3. 新增 `server/modules/launch-profiles/tests/context-window-env-export.test.ts`：三字段各自导出的键与值；未设置不导出；非法值（0、负数、101、非数字）被丢弃；冲突时胜出并有 warning；取假用例：只改显示不导出时必须判红。

依据：ADR-001（全局作用域、密钥不入库、env 白名单、会话锁定、toolsSettings 不进 profile、contextWindow 取代全局），其中决策 6 只规定了显示侧，本任务补齐导出侧。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/context-window-env-export.test.ts` 退出码 0（AC-014 的判据命令）。
- [x] 测试证明三个类型化字段导出正确的变量名与字符串值；未设置字段导出为零；非法值被丢弃且有 warning；同键冲突类型化字段胜出。
- [x] 取假变体（只保留 resolveContextWindow、不导出）使该测试判红，红灯输出记录在任务证据中。（证据：注释掉 compileContextEnv 调用后 pass 1 / fail 3 —— 三字段导出、非法值、冲突胜出三个用例判红）
- [x] `context-window-per-profile.test.ts` 与 `passthrough-parity.test.ts` 仍退出码 0（passthrough 不得多出任何键）；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实的 `resolveLaunchSpec` 对库里 profile 导出上述三个变量，且经 SDK 路径的 `sdkOptions.env` 与终端路径的 pty env 都能到达子进程。AC-014 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-014` 能独立核验。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-spec.service.ts
- server/modules/launch-profiles/tests/context-window-env-export.test.ts (new)
- tasks/gap-launch-profiles-context-fields-export-env.md
