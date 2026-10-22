---
id: gap-model-library-context-window-follows-model
title: model-library：上下文窗口的单一事实来源是模型条目的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 行（AC-028）
status: superseded
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  superseded_by: gap-model-env-row-single-source-context-window
  superseded_reason: 同一判据 AC-028 的重复任务。AC-028
    只有一条判据命令（server/modules/launch-profiles/tests/model-context-window.test.ts）；两条分支都【新增】该同一路径且内容不同，物理上不可能同时落地，后到者必冲突。env-row
    已于 2026-09-20 10:22Z 落地（flip-done → ff 进 develop）；本任务独有语义（会话无 model 时的降级）已被
    env-row 的 session.model || findNewestClaudeModelId(entries) 覆盖（后者还能从最新主线程
    assistant 回合的 message.model 兜回）。两任务此前被同一 lint 规则 boundaries/dependencies
    卡住（本任务未修）。人工裁定 2026-09-20。
depends_on:
  - gap-model-library-compile-spawn-env
goal_ac: AC-028
---
## Proposal

GOAL-001 的 AC-028：模型条目里的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 行是上下文窗口的单一事实来源——同一个值既导出给 CLI，也决定该模型会话的用量 total。此前 AC-005（以 `profile.contextWindow` 为源）与 AC-014（类型化 contextWindow/autoCompactWindow/autoCompactPct 导出）以旧 profile 实体和类型化字段为对象，B 方案（ADR-002）下不存在这两样东西，已被取代；本任务补上它们原本守着的“界面显示与 CLI 实际一致”这一防线，避免覆盖丢失。

现状事实：SDK 路径的 token total 现在取自 `options.profile?.contextWindow`（claude-runtime.provider.js 约第 984 行的调用点），token-usage 汇总接口取自 `process.env.CONTEXT_WINDOW`（provider-token-usage.service.ts）。二者都不认识模型条目。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-context-window-per-profile-test（AC-005，已 done、现已 superseded）验证的是解析函数 `resolveContextWindow` 的回退顺序，本任务验证的是【数据从模型条目流到 total 的接线】，且不再有类型化字段——值就是 env 行。

方案（最小切片）：
1. 编译入口（AC-024 引入的按模型编译）在产出 spec 时，把该模型的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` value 行解析为 `spec.contextWindow`；解析顺序：该行 → 宿主 `CONTEXT_WINDOW` → 160000；非正整数值落到下一级。
2. SDK 路径调用点改为使用模型对应的 `spec.contextWindow`，取代 `options.profile?.contextWindow`。
3. token-usage 汇总接口按会话所用模型取同一个值。⚠️ 未核实项须登记：会话历史里是否能可靠取得“该会话使用的模型”我没有验证（sessions 表有 model 列，但历史 JSONL 每条 usage 是否带模型未查）；实现时须先确认，取不到时的降级行为（回退 CONTEXT_WINDOW）须在测试里登记。
4. 新增 `server/modules/launch-profiles/tests/model-context-window.test.ts`：917000 行 → 两处 total 均为 917000 且 spawn 环境里同一个值；无行 → CONTEXT_WINDOW → 160000；非法值落级；内置模型与无配置条目与今日一致。取假用例：只改显示不导出、或只导出不改显示，同一断言必须判红。

依据：ADR-002 决策 6（上下文窗口由模型条目解析并取代全局配置）。

实现记录：编译入口 `resolveModelLaunchSpec` 已产出 `spec.contextWindow`；新增 `resolveSendContextWindow`（模型行 → launch profile → CONTEXT_WINDOW → 160000）供 SDK 调用点使用，并经 `server/modules/providers/index.ts` 桶文件导出给测试；token-usage 服务用 `sessions.model`（不读 JSONL）取模型行，session 无 model 或无该行时降级到 CONTEXT_WINDOW → 160000（测试已登记）。取假红灯：token-usage 忽略模型行、SDK total 忽略模型行，两种变体同一测试均 fail 1。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/model-context-window.test.ts` 退出码 0（AC-028 的判据命令）。
- [x] 测试证明：模型的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 行同时出现在 spawn 环境与两处 total 中；回退顺序与非法值处理正确。
- [x] 取假变体（显示与导出脱节）使该测试判红，红灯输出记录在任务证据中；`passthrough-parity.test.ts` 仍退出码 0；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实的 SDK 路径调用点与 token-usage 接口都从模型条目取上下文窗口，而不是旧的 profile 参数或全局 env。AC-028 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-028` 能独立核验。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-spec.service.ts
- server/modules/providers/index.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/services/provider-token-usage.service.ts
- server/modules/launch-profiles/tests/model-context-window.test.ts (new)
- tasks/gap-model-library-context-window-follows-model.md

## Needs-Human

**执行 2026-09-20T09:59:43.111Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7355 lint passed=false end_ms=1789898274189
- run_id：wk-prod-anchor
- session_id：1cb0f6b8-a36d-4a05-b13e-1b0444411ee8
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-model-library-context-window-follows-model~wk-prod-anchor~1789898249119-df7197.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-model-library-context-window-follows-model-wk-prod-anchor.log
