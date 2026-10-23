---
id: AC-169
title: lifecycle_mode 与能力矩阵：默认 per-run，不支持的模式被拒绝，分叉不继承，常驻的启动与关闭可经 API 操作
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/session-hosts/tests/lifecycle-mode.test.ts
expect: (1) 迁移后既有会话的 lifecycle_mode 为 per-run；(2) 对能力矩阵 lifecycleModes 不含
  resident 的 provider 写入 resident 被拒绝，错误可辨；(3) 分叉出的会话为 per-run；(4) POST
  /api/session-hosts/:sessionId/start 与 /close 对常驻会话分别拉起与关闭宿主，对 per-run 会话的
  close 被拒绝（proposal §13：关闭动作只对 resident 开放）；(5) 宿主 busy
  时模式切换被拒绝或推迟到本轮结束，不在进行中的轮上切换。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
activatedAt: 2026-09-27T05:03:12.859Z
statusLog:
  - at: 2026-09-27T05:03:12.859Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-27T07:11:13.792Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T05:03:12.859Z
---
