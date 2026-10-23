---
id: gap-launch-profiles-context-window-per-profile-test
title: launch-profiles：token 用量 total 取 profile.contextWindow，未设回退
  CONTEXT_WINDOW 再回退 160000（AC-005）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-005
---
## Proposal

GOAL-001 的 AC-005 要求：token 用量的 `total` 等于 `profile.contextWindow`，而非硬编码的 160000；profile 未设 contextWindow 时回退到环境变量 `CONTEXT_WINDOW`，再回退到 160000；取假形态：沿用硬读（继续只读 `process.env.CONTEXT_WINDOW || 160000`）即红。目前 `server/modules/launch-profiles/` 不存在，`tasks/` 中没有任何任务以 `goal_ac: AC-005` 推进该判据，这是结构性缺口（判据测试 `context-window-per-profile.test.ts` 因模块缺失而红）。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-passthrough-env-parity-test（AC-001）证明无 profile 时 env 逐字一致，gap-launch-profiles-env-injection-closed-test（AC-004）覆盖 env 键名白名单；本任务只覆盖 token 用量 total 的 contextWindow 来源。

现状：`server/modules/providers/list/claude/claude-runtime.provider.js` 第 434 与 528 行两处 `parseInt(process.env.CONTEXT_WINDOW, 10) || 160000`，以及 `server/modules/providers/services/provider-token-usage.service.ts` 第 199/248 行同样的 CONTEXT_WINDOW→160_000 回退，均为进程级硬读，不感知 profile。

方案（最小切片）：
1. 在 `server/modules/launch-profiles/launch-spec.service.ts` 的解析结果中携带 `contextWindow?: number`（来自 profile.config），并导出纯函数 `resolveContextWindow(profileContextWindow, envValue)`：有效正整数的 profile 值优先，其次 `CONTEXT_WINDOW`，最后 160000。
2. `claude-runtime.provider.js` 两处 token 用量构造点与 `provider-token-usage.service.ts` 的 total 计算改为使用 `resolveContextWindow`，把本次运行所用 profile 的 contextWindow 传入；无 profile 时行为与改动前一致。
3. 新增 `server/modules/launch-profiles/tests/context-window-per-profile.test.ts`：分别断言 profile 设 contextWindow=12345 时 total===12345；未设且 `CONTEXT_WINDOW=54321` 时 total===54321；两者皆无时 total===160000；并含取假用例——模拟沿用硬读的实现时 profile 用例必须判红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/context-window-per-profile.test.ts` 退出码 0（AC-005 的判据命令）。
- [x] 测试断言 profile.contextWindow=12345（且环境 CONTEXT_WINDOW 设为不同值）时，经真实 token 用量产出路径得到的 `total` 严格等于 12345，而不是 160000 或环境变量值。
- [x] 测试断言 profile 未设 contextWindow 时 total 等于 `CONTEXT_WINDOW` 环境变量值；环境变量也未设（或非法）时 total 等于 160000。
- [x] 取假用例通过：把实现换成沿用硬读（忽略 profile）的变体时，profile 用例的断言判红，证明测试对该回归敏感。
- [x] `npm run typecheck` 与 `npm test` 退出码 0（既有 claude-token-budget 等测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求 `claude-runtime.provider.js` 的两处真实 token 用量构造点与 `provider-token-usage.service.ts` 实际经由 `resolveContextWindow` 取得 total，且测试经这些真实产出路径（而非仅直接调用纯函数）证明 profile→环境变量→160000 三级回退；取假变体证明沿用硬读即红。AC-005 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-005` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/launch-spec.service.ts (new)
- server/modules/launch-profiles/index.ts (new)
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/services/provider-token-usage.service.ts
- server/modules/launch-profiles/tests/context-window-per-profile.test.ts (new)
- server/modules/providers/index.ts
- tasks/gap-launch-profiles-context-window-per-profile-test.md

## Needs-Human

**执行 2026-09-20T04:01:07.601Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-launch-profiles-context-window-per-profile-test — 1 violation(s)
- run_id：wk-prod-anchor
- session_id：e38861ae-97e9-4f7e-bc3c-d94e1f6be5fd
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-context-window-per-profile-test-wk-prod-anchor.log
