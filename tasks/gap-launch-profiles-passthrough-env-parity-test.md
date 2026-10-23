---
id: gap-launch-profiles-passthrough-env-parity-test
title: launch-profiles：落地 resolveLaunchSpec 的 passthrough 路径与 env 逐字一致性测试（AC-001）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-001
---
## Proposal

GOAL-001 的 AC-001 要求：未配置任何 profile 时，`resolveLaunchSpec` 产出的 env 与变更前逐字一致。目前 `server/modules/launch-profiles/` 不存在，`tasks/` 中没有任何任务以 `goal_ac: AC-001` 推进该判据，这是结构性缺口（AC 判据测试 `passthrough-parity.test.ts` 因模块缺失而红）。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）的「编译层」一节与 ADR-001。

方案（只覆盖 AC-001 所需的最小切片，不实现 profile 存储/白名单/密钥，那些归属 AC-002..AC-007 各自的任务）：
1. 新建 `server/modules/launch-profiles/`，含 `index.ts` 桶文件，导出 `resolveLaunchSpec(profileId: string | null, provider)`；`ResolvedLaunchSpec` 类型按提案定义（跨模块使用的类型放 `server/shared/types.ts`，遵循 backend-module-standards）。
2. `profileId === null`（或内置 passthrough）时，`spec.env` 必须为空对象 `{}`，`argv` 为 `[]`，`contextWindow` 按 `CONTEXT_WINDOW` → 160000 解析，`warnings` 为 `[]`。这样调用方 `{ ...process.env, ...spec.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS }` 与变更前的 `{ ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS }` 逐键相同。
3. 接入 SDK 路径 `server/modules/providers/list/claude/claude-runtime.provider.js:225` 与 Shell 路径 `server/modules/websocket/services/shell-websocket.service.ts`（pty env）时，把 env 拼装改为并入 `spec.env`，且保持无 profile 时结果不变。
4. 新增 `server/modules/launch-profiles/tests/passthrough-parity.test.ts`：把变更前的 env 拼装公式在测试内以字面量固化为基线（SDK 路径：`{...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS}`；pty 路径：`{...process.env, [PATH key]: 优先 PATH, TERM:'xterm-256color', COLORTERM:'truecolor', FORCE_COLOR:'3'}`），在受控 `process.env` 夹具下断言 `Object.keys` 集合与每个键的值完全相等；并含取假用例：向 spec.env 人为加一个键、删一个键、改一个值，比较函数必须分别判红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/passthrough-parity.test.ts` 退出码 0（AC-001 的判据命令）。
- [x] 该测试对 SDK 路径与 pty 路径各断言：无 profile 时最终 env 的键集合与每个键的值和基线逐字相等（`assert.deepStrictEqual`）。
- [x] 取假用例通过：对 spec.env 新增一个键、缺失一个键、改一个值三种变异，一致性比较均判不等（测试内以 `assert.notDeepStrictEqual` 或 throws 断言，证明测试会变红）。
- [x] `grep -n "resolveLaunchSpec" server/modules/providers/list/claude/claude-runtime.provider.js server/modules/websocket/services/shell-websocket.service.ts` 两个文件均有命中；`npm run typecheck` 与 `npm test` 退出码 0（既有 server 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求 `claude-runtime.provider.js` 与 `shell-websocket.service.ts` 两个真实启动点实际经由 `resolveLaunchSpec` 拼装 env，并在未配置 profile 的真实启动路径上（例如用 `spawnPty` 依赖注入捕获 pty env、以及捕获 `sdkOptions.env`）证明产出与改动前逐字一致；AC-001 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-001` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/index.ts
- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/tests/passthrough-parity.test.ts
- server/shared/types.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/providers/index.ts
- server/modules/websocket/index.ts
- tasks/gap-launch-profiles-passthrough-env-parity-test.md

## Needs-Human

**执行 2026-09-20T03:54:02.823Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7556 lint passed=false end_ms=1789876414282
- run_id：wk-prod-anchor
- session_id：197484b0-d2a6-4446-b867-dca1500c816c
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-launch-profiles-passthrough-env-parity-test~wk-prod-anchor~1789876390070-4671f0.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-passthrough-env-parity-test-wk-prod-anchor.log
