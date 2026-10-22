---
id: gap-model-env-row-single-source-context-window
title: 模型条目的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 行是上下文窗口唯一来源：spawn 导出与用量 total 同值（AC-028）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-028
---
## Proposal

GOAL-001 的 AC-028 要求：模型条目（Model library 自定义模型）env 表里的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 行是上下文窗口的单一事实来源——同一个值既随 spawn 环境导出给 CLI，也决定该模型会话的用量 `total`，避免“界面显示 917k、CLI 实际用默认窗口”。解析顺序：该模型的行 → 宿主 `CONTEXT_WINDOW` → 160000；非法值（0、负数、非数字）落到下一级；无配置的模型与内置模型行为与今日一致。本任务取代 AC-005（以 profile.contextWindow 为源）与 AC-014（类型化 contextWindow 导出）的实现方向：B 方案没有类型化字段，这些值就是 env 行本身。tasks/ 中目前没有任何任务以 `goal_ac: AC-028` 推进该判据，这是结构性缺口。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-context-window-per-profile-test（AC-005）与 gap-launch-profiles-context-fields-export-env（AC-014）以 profile.contextWindow 类型化字段为源，本任务改以模型条目的 env 行为源，不复用其数据来源。

现状：`server/modules/providers/list/claude/claude-runtime.provider.js` 第 984-985 行 `extractTokenBudget` / `extractCumulativeTokenBudget` 传入 `options.profile?.contextWindow`，两处构造点（约 437、533 行）调用 `resolveContextWindow(profileContextWindow)`；`server/modules/providers/services/provider-token-usage.service.ts` 第 249 行同样以 profile 值与 `process.env.CONTEXT_WINDOW` 为源；模型条目的 env 行不影响 total（取假形态）。

方案（最小切片）：
1. 在 `server/modules/launch-profiles/launch-spec.service.ts` 让 `resolveContextWindow` 接受“该模型编译后 env 行里的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 值”，按 行 → `CONTEXT_WINDOW` → 160000 解析，非正整数视为非法并落下一级；spawn 环境导出与 total 都读同一个解析结果。
2. `claude-runtime.provider.js` 的两处 token 构造点与 SDK 路径调用（extractTokenBudget/extractCumulativeTokenBudget）改为传入所选模型条目的该行值，不再读 `options.profile?.contextWindow`。
3. `provider-token-usage.service.ts` 汇总接口按会话所用模型条目的该行值得出 total。
4. 新增 `server/modules/launch-profiles/tests/model-context-window.test.ts`（AC-028 判据）：模型行=917000 时 spawn 环境导出值与两条 total 路径均为 917000；行缺失时取宿主 `CONTEXT_WINDOW`，再缺失取 160000；行为 0/-5/abc 时落下一级；无配置模型与内置模型与今日一致；含取假用例——沿用 `options.profile?.contextWindow` / 仅读 `process.env.CONTEXT_WINDOW` 的实现必须判红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/model-context-window.test.ts` 退出码 0（AC-028 判据命令）。
- [x] 测试断言：模型条目行 CLAUDE_CODE_MAX_CONTEXT_TOKENS=917000（宿主 CONTEXT_WINDOW 设为不同值）时，spawn 环境导出值、SDK 路径 extractTokenBudget/extractCumulativeTokenBudget 的 total、token-usage 汇总接口的 total 三者严格相等且为 917000。
- [x] 测试断言解析顺序：无该行时 total 等于宿主 CONTEXT_WINDOW，二者皆无时为 160000；该行为 0、负数、非数字时落到下一级；无配置模型与内置模型的 total 与改动前一致。
- [x] 取假用例通过：把实现换回读 `options.profile?.contextWindow` 或仅读 `process.env.CONTEXT_WINDOW` 的变体时，模型行用例判红。
- [x] `npm run typecheck` 与 `npm test` 退出码 0（既有 claude-token-budget、passthrough-parity 等测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求 `claude-runtime.provider.js` 的真实 SDK token 构造路径与 `provider-token-usage.service.ts` 实际以模型条目的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 行为 total 的来源，且该值与随 spawn 环境导出给 CLI 的值是同一个解析结果（测试经真实产出路径而非仅纯函数证明）；取假变体证明旧来源即红。AC-028 判据命令在 quay 的 fan-in 中由红转绿，下一轮 driver 通过 `goal_ac: AC-028` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/index.ts
- server/modules/launch-profiles/model-launch-spec.service.ts
- server/modules/launch-profiles/tests/model-context-window.test.ts (new)
- server/modules/providers/index.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/services/provider-token-usage.service.ts
- tasks/gap-model-env-row-single-source-context-window.md

## Needs-Human

**执行 2026-09-20T09:51:53.857Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-model-env-row-single-source-context-window — 1 violation(s)
- run_id：wk-prod-anchor
- session_id：ddf343a0-f4dc-44e4-8a37-2054f1d91f65
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-model-env-row-single-source-context-window-wk-prod-anchor.log

**裁定 2026-09-20 — 人工裁定（human-adjudication）：声明有误，非实现缺陷**

- 复现判词：`out-of-declared: task wrote server/modules/launch-profiles/model-launch-spec.service.ts (matches no declared Touches glob)`。
- 归因：**Touches 声明写错，不是越界实现**。`launch-spec.service.ts` 的 `resolveContextWindow` 已实现 行 → `CONTEXT_WINDOW` → 160000 的解析顺序（非正整数落下一级），无需改动；本任务新增的能力是 `model-launch-spec.service.ts` 中的 `resolveModelContextWindowRow`（该文件负责模型条目编译），经 `launch-profiles/index.ts` 导出，由 `claude-runtime.provider.js`（第 760 行解析、991-992 行喂入真实 SDK token 构造路径）与 `provider-token-usage.service.ts`（第 98 行）消费。原 Touches 第 1 行抄自 Proposal 中的计划细节，与实现落点不符。
- 处置：Touches 由 `launch-spec.service.ts` 改为 `model-launch-spec.service.ts`；移除声明了但实际未改动的 `server/modules/providers/index.ts`（该 helper 经 launch-profiles barrel 导出，providers barrel 不参与）。
- 佐证：AC-028 判据命令在本分支实测 **3/3 通过、退出码 0**（含取假用例）；anti-drift 在 suite 之前中止，故此前重试均看不到这一绿。

## Needs-Human

**执行 2026-09-20T10:06:30.490Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=8170 lint passed=false end_ms=1789898748016
- run_id：wk-prod-anchor
- session_id：916dfebb-9bf5-4034-9181-5c23342b2030
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-model-env-row-single-source-context-window~wk-prod-anchor~1789898719986-2acd7b.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-model-env-row-single-source-context-window-wk-prod-anchor.log

**裁定 2026-09-20（二）— 第二次 park：suite 的 lint 卡点，非基建；撤回上一条的「移除 providers/index.ts」**

- 本次判词 `step=suite: __PERFILE__ ... lint passed=false`，driver 归因「suite 红但归因不出任何失败测试文件（基建/契约疑似）」。**该归因错误**：suite 日志明确指名
  `not ok - lint: server/modules/launch-profiles/tests/model-context-window.test.ts:10:49: error boundaries(dependencies): Cross-module imports must go through that module's barrel file`。
  该启发式只扫 `__PERFILE__` 行，故把 lint 类失败读成「无可归因」。
- 真实缺陷（可实现）：测试深导入 `@/modules/providers/services/provider-token-usage.service.js`。providers barrel 已从**同一文件**再导出 `summarizeClaudeTokenUsage`，但未导出 `createProviderTokenUsageService`，故当时不存在合规导入路径。
- 处置：`server/modules/providers/index.ts` 补出 `createProviderTokenUsageService`；测试改为从 `@/modules/providers/index.js` 导入。**故 `server/modules/providers/index.ts` 归回 Touches** —— 撤回上一条裁定中「移除」的判断：该文件确实必须改动，原始 Touches 在这一点上是对的。
- 实测：`bash scripts/test.sh`（`.quay/config.yml` 的 `loop.test_command`，即 fan-in 真正跑的那条）**170/170 通过、退出码 0**（修复前 169 pass / 1 fail）；AC-028 判据 3/3；`npm run typecheck` 退出码 0。修复提交 `59832bf1`。
