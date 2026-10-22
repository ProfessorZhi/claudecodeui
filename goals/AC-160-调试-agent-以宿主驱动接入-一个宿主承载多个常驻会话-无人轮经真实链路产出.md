---
id: AC-160
title: 调试 agent 以宿主驱动接入：一个宿主承载多个常驻会话，无人轮经真实链路产出
status: achieved
kind: criterion
goal: GOAL-012
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/debug-agent/tests/debug-agent-host-driver.test.ts
expect: 门控开启时：(1) 调试 agent 的能力矩阵 lifecycleModes 含 per-run 与
  resident，multiplexedHost 为 true；(2) 两个调试会话以 resident 绑定到同一 hostId；(3) 场景 op
  unattended-turn 在没有任何浏览器连接时产生一个来源为 unattended 的 run，帧来自真实归一化（normalizeMessage
  / createNormalizedMessage），seq 由 run registry 分配且严格递增，transcript 真实落盘，随后
  chat.subscribe(lastSeq=0) 能完整重放；(4) 场景 op 增减保活理由与 exit(oom) 分别反映到宿主快照的
  leases，以及 closeReason=exited、detail=oom；(5)
  解除其中一个会话不影响另一个。门控关闭时宿主层里不存在任何调试宿主。本改动不得使 AC-123、AC-126、AC-136 变红（由 goal
  的复验覆盖）。取假形态：调试 agent 在引擎里直接构造帧推给 writer、绕过 manager 开 run ⇒ (3) 的 run 来源与 seq
  读数必须红。命令逐字含文件路径，不用 glob。当前必红：测试文件不存在。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-A「统一宿主层」并激活；扩展调试 agent 作宿主层对非 Claude provider
  适用性的替身；不加 cloudcli 子命令，只靠 HTTP/WS 加脚本
activatedAt: 2026-09-25T09:03:53.998Z
statusLog:
  - at: 2026-09-25T09:03:53.998Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-26T13:54:54.068Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-25T09:03:53.998Z
---
