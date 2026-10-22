---
id: AC-015
title: terminal session uses the selected profile
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/shell-profile-selection.test.ts && npx vitest
  run src/modules/shell/tests/shellLaunchProfile.test.ts
expect: 内置终端启动必须使用所选 profile：shell 启动帧携带 launchProfileId，服务端据此调用
  resolveLaunchSpec，pty 的 env 并入 spec.env、命令并入 spec.argv（含 --resume 与回退两个分支）；未选
  profile 时行为与今日逐字一致；id 不存在时回退 passthrough 并产出 warning、不崩溃；客户端传来的 env
  一律忽略。两段命令缺一不可（&&）：服务端接线 + 前端确实把 launchProfileId
  发出。取假形态：shell-websocket.service.ts:415 现为写死的
  resolveLaunchSpec(null,'claude')，前端 src/modules/shell/ 亦不传 id，今天必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于
  2026-09-20：对照用户历史启动命令（claude-fjdac + 917k 上下文三件套 + --permission-mode
  bypassPermissions + --prompt-suggestions false）复核 profile 机制所得缺口
activatedAt: 2026-09-20T08:17:01.362Z
statusLog:
  - at: 2026-09-20T09:17:09.472Z
    from: active
    to: superseded
    actor: yale
    reason: 终端路径接入：ADR-002 第一版不做，终端会话仍继承服务进程环境
---
