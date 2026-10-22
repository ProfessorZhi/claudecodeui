---
id: gap-launch-profiles-shell-resume-launch-spec-test
title: launch-profiles：内置终端 --resume 分支沿用首次启动的 argv 与 env，并落地回归测试（AC-006）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-passthrough-env-parity-test
goal_ac: AC-006
---
## Proposal

GOAL-001 的 AC-006 要求：内置终端（`server/modules/websocket/services/shell-websocket.service.ts`）的 `--resume` 分支与首次启动携带同一套启动参数（argv）与 env。目前 `buildShellCommand` 的 resume 分支只拼 `claude --resume "<id>"${bypassFlag} || claude${bypassFlag}`，丢弃了 profile 编译出的 `spec.argv`（首次启动分支 `initialCommand || claude${bypassFlag}` 同样未带 argv），pty env 也未并入 `spec.env`；`tasks/` 中没有任何任务以 `goal_ac: AC-006` 推进该判据，且判据测试 `shell-resume-launch-spec.test.ts` 不存在，这是结构性缺口。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）与 ADR-001。

<!-- dedup-ref -->相关但机制不同的任务：gap-launch-profiles-passthrough-env-parity-test（AC-001）负责创建 `resolveLaunchSpec` 并把 env 并入 pty 路径的 passthrough 语义；本任务只负责 resume 分支与首次启动分支共用同一份 spec 的 argv/env。

方案：
1. 在 `buildShellCommand` 中经 `resolveLaunchSpec` 取得一次 spec，首次启动与 resume 两条分支（含 `|| claude` 回退分支、win32 PowerShell 分支）都把同一份 `spec.argv` 拼入命令；pty `env` 使用同一份 `spec.env`，两条分支不得各自计算。
2. 新增 `server/modules/websocket/tests/shell-resume-launch-spec.test.ts`：以依赖注入捕获 `spawnPty` 的 command 与 env，对同一 profile 分别触发首次启动与 `hasSession + sessionId` 的 resume，断言两次的 argv 片段与 env（含 profile 注入键）一致；含取假用例：在现状（resume 丢弃启动参数）实现下该测试必须为红，并用变异（让 resume 分支丢掉 argv 或 env）证明比较函数会判红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/shell-resume-launch-spec.test.ts` 退出码 0（AC-006 判据命令）。
- [x] 测试断言首次启动与 resume 两次 spawn 的 profile argv 片段相同且 pty env 逐键相等（`assert.deepStrictEqual`），覆盖 claude 的 POSIX 与 win32 两种命令形态。
- [x] 取假验证：将 resume 分支临时改回丢弃 argv/env 的现状实现，上述测试退出码非 0（在任务证据中记录该红灯输出），恢复后为绿。
- [x] `grep -n "resolveLaunchSpec" server/modules/websocket/services/shell-websocket.service.ts` 有命中；`npm run typecheck` 与 `npm test` 退出码 0（既有 shell-websocket 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求 `shell-websocket.service.ts` 的真实 resume 启动路径实际使用与首次启动同一份 spec，并通过注入 `spawnPty` 捕获真实 command 与 env 来证明两者一致；在 resume 丢弃启动参数的旧实现上该测试确实为红，修复后由红转绿，且下一轮 driver 通过 `goal_ac: AC-006` 能独立核验该任务。

## Touches

- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/websocket/tests/shell-resume-launch-spec.test.ts
- server/modules/websocket/tests/shell-websocket.service.test.ts
- tasks/gap-launch-profiles-shell-resume-launch-spec-test.md
