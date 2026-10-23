---
id: gap-launch-profiles-shell-uses-selected-profile
title: launch-profiles：内置终端启动必须使用所选 profile，而非写死 null（AC-015）
status: superseded
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-config-env-compiled
goal_ac: AC-015
---
## Proposal

GOAL-001 的 AC-015 要求：内置终端启动使用所选 profile。现状：`shell-websocket.service.ts` 约第 415 行为写死的 `resolveLaunchSpec(null, 'claude')`，前端 `src/modules/shell/` 也不携带 launchProfileId。结果是 profile 编好的 `--model` 参数与 env 在终端里**永远用不上**——用户选了 profile，聊天会话生效，终端会话仍是 passthrough。此前 AC-006 只用 `dependencies.resolveLaunchSpec` seam 注入假 spec，证明的是接线形状，而不是终端真的会选 profile。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-shell-resume-launch-spec-test（AC-006，已 done）证明 --resume 与回退分支复用同一份 argv；本任务补的是**argv 从哪个 profile 来**。

方案（最小切片）：
1. 协议：shell 启动帧新增可选 `launchProfileId`（字符串）。服务端只接受 id，沿用 ADR-001 决策 3 的纪律：客户端传来的 env 一律忽略；id 不存在时回退 passthrough 并产出 warning，不崩溃。
2. 服务端：`resolveLaunchSpec(message.launchProfileId ?? null, 'claude')`；pty env 并入 spec.env，命令并入 spec.argv（首次、--resume、回退三个分支）。同一次启动只编译一次，argv 与 env 必须出自同一份 spec（现有注释已要求）。
3. 会话已存有 launch_profile_id 时以已存值为准（沿用 session-profile-lock 的语义，ADR-001 决策 4）。
4. 前端：`src/modules/shell/utils/socket.ts` 的启动帧类型与 `useShellRuntime.ts` 传出当前所选 profile 的 id。
5. 测试：新增 `server/modules/websocket/tests/shell-profile-selection.test.ts`（真实 spawnPty 注入桩，断言 env 与命令；含 --resume 分支与未选 profile 时逐字等同今日；不存在 id 回退；伪造 env 被忽略）与 `src/modules/shell/tests/shellLaunchProfile.test.ts`（断言启动帧确实带出 launchProfileId）。取假用例：恢复写死 null 时必须判红。

依据：ADR-001（全局作用域、密钥不入库、env 白名单、会话锁定、toolsSettings 不进 profile、contextWindow 取代全局）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/shell-profile-selection.test.ts && npx vitest run src/modules/shell/tests/shellLaunchProfile.test.ts` 退出码 0（AC-015 的判据命令，两段缺一不可）。
- [x] 服务端测试不经 `dependencies.resolveLaunchSpec` 注入假 spec，而是以真实落库的 profile 驱动，断言 pty env 含 spec.env 的键、命令含 `--model`；`--resume` 与回退分支同样携带。
- [x] 未选 profile 时 pty env 与命令与今日逐字一致（passthrough 不回归）；不存在的 id 回退并有 warning；客户端伪造的 env 被忽略。
- [x] 取假变体（写死 null）使服务端测试判红，红灯输出记录在任务证据中；`shell-resume-launch-spec.test.ts` 仍退出码 0；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求终端会话启动路径真的读取所选 profile，前端确实把 id 发出。AC-015 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-015` 能独立核验。

## Touches

- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/websocket/tests/shell-profile-selection.test.ts (new)
- src/modules/shell/utils/socket.ts
- src/modules/shell/hooks/useShellRuntime.ts
- src/modules/shell/tests/shellLaunchProfile.test.ts (new)
- tasks/gap-launch-profiles-shell-uses-selected-profile.md

## Evidence

- 红灯（写死 null）：`✖ shell launch uses the selected launch profile` — `AssertionError: claude`（命令不含 `--model`），fail 1。
- 前端红灯（移除 launchProfileId 展开）：shellLaunchProfile.test.ts 1 failed | 1 passed。
- 恢复后：两段判据命令、shell-resume-launch-spec.test.ts、`npm run typecheck` 均通过；scoped gate 绿。

## Needs-Human

**执行 2026-09-20T08:28:45.413Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-launch-profiles-shell-uses-selected-profile — 2 violation(s)
- run_id：wk-prod-anchor
- session_id：cf7f03a8-a121-420b-a2e0-c7cf181a07e2
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-shell-uses-selected-profile-wk-prod-anchor.log


2026-09-20 撤回：对应 AC-015 已置 superseded（ADR-002 第一版不做终端路径接入）。worktree claudecodeui-wt-shell-profile 与分支保留未删。