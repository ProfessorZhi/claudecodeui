---
id: AC-006
title: shell resume keeps launch spec
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/shell-resume-launch-spec.test.ts
expect: 内置终端的 --resume 分支与首次启动携带同一套 argv 与 env；取假形态：现状（resume 丢弃启动参数）下该测试为红，是本缺陷的回归闸。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.312Z
statusLog:
  - at: 2026-09-20T04:14:25.545Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:38:12.045Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 复核：终端路径接入延期（AC-015 已 superseded）；该判据守的是终端 resume
      复用启动参数，而生产上终端始终走无配置路径，属休眠的回归闸，不属第一版退出条件。重启终端路径时须重新立判据
---
