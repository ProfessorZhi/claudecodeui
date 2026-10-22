---
id: gap-launch-profiles-real-profile-compiles-spec-test
title: launch-profiles：真实落库 profile 驱动 resolveLaunchSpec 产出非空 argv 且
  contextWindow 取 profile 值（AC-009）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-009
---
## Proposal

GOAL-001 的 AC-009 要求：由一条真实落库（launchProfilesDb / launchProfilesService.createProfile）的 profile 记录驱动真实的 `resolveLaunchSpec`，断言产出非空 `argv`，且 `spec.contextWindow` 取 profile.config.contextWindow 而非只读 `CONTEXT_WINDOW`。⛔ 不得经 `dependencies.resolveLaunchSpec` 之类 seam 注入假 spec —— AC-006 只证明了接线形状，未证明真实 profile 能产出 argv。今天 `tasks/` 中没有任何任务以 `goal_ac: AC-009` 推进该判据，这是结构性缺口。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c，ResolvedLaunchSpec 契约含 model/fallbackModel/argv/contextWindow）与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-context-window-per-profile-test（AC-005）只证明 token 用量 total 经 resolveContextWindow 取 profile 值，gap-launch-profiles-shell-resume-launch-spec-test（AC-006）证明 shell 接线形状；本任务补的是 resolveLaunchSpec 本身对真实 profile 的编译产出。

现状（今日必红）：`server/modules/launch-profiles/launch-profiles.service.ts` 的 `resolveLaunchSpec` 恒返回 `argv: []`（第 86 行），且第 87 行 `contextWindow: parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || DEFAULT_CONTEXT_WINDOW` 只读环境变量，从不读 profile.config.contextWindow；已有的 `resolveContextWindow`（launch-spec.service.ts）未被 resolveLaunchSpec 使用。

方案（最小切片）：
1. `resolveLaunchSpec` 中 contextWindow 改用 `resolveContextWindow(profile?.config.contextWindow)`（profile → CONTEXT_WINDOW → 160000）。
2. 由 profile.config 编译 argv（仅 Shell 路径使用）：defaultModel 非空时追加 `--model <defaultModel>`，fallbackModel 非空时追加 `--fallback-model <fallbackModel>`；密钥绝不进 argv（ADR/提案 §密钥绝不进 argv）；passthrough（无 profile）仍为 `[]`，保持 passthrough-parity 不回归。
3. 新增 `server/modules/launch-profiles/tests/launch-spec-real-profile.test.ts`：用真实 DB（临时库）经 launchProfilesService.createProfile 落一条含 defaultModel、fallbackModel、contextWindow=917000 的 gateway profile，再直接调用真实 `resolveLaunchSpec(id, 'claude')`，断言 argv 非空且含 `--model`、contextWindow===917000（同时把 CONTEXT_WINDOW 设为不同值）；含取假用例：argv 恒 [] 或 contextWindow 只读 env 的变体必须判红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/launch-spec-real-profile.test.ts` 退出码 0（AC-009 的判据命令）。
- [x] 测试经真实落库 profile 调用真实 `resolveLaunchSpec`（grep 该测试文件不含 `dependencies.resolveLaunchSpec` 或任何对 resolveLaunchSpec 的替身/注入），断言 `spec.argv.length > 0` 且包含 `--model` 及其 defaultModel 值。
- [x] 测试断言 profile.config.contextWindow=917000 且 `process.env.CONTEXT_WINDOW` 设为不同值时 `spec.contextWindow === 917000`；profile 未设 contextWindow 时回退 CONTEXT_WINDOW，再回退 160000。
- [x] 取假用例通过：实现改回恒 `argv: []` 或只读 env 的 contextWindow 时，对应断言判红（在任务证据中给出改回后红的输出）。
- [x] `npm run typecheck` 与 `npm test` 退出码 0（passthrough-parity、shell-resume-launch-spec、context-window-per-profile 不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实 `resolveLaunchSpec` 实现（launch-profiles.service.ts）确实由落库 profile 编译出非空 argv 与 profile 来源的 contextWindow，测试全程不经 seam 注入假 spec；取假变体（恒 argv:[]、只读 CONTEXT_WINDOW）证明会判红。AC-009 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-009` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-spec.service.ts
- server/modules/launch-profiles/tests/launch-spec-real-profile.test.ts (new)
- tasks/gap-launch-profiles-real-profile-compiles-spec-test.md
