---
id: AC-174
title: 真实浏览器里常驻会话的 Shell 标签页不可用，关闭常驻模式后恢复
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx playwright test e2e/resident-shell-tab.spec.ts
expect: 常驻会话里 Shell 标签页禁用并显示「常驻会话不支持 Shell，关闭常驻模式后可用」，判定只看
  lifecycle_mode、与进程是否存活无关；关闭常驻模式后同一会话的 Shell 标签页可用。取假形态：按进程是否存活判断 ⇒ 常驻但未运行时
  Shell 可用，必须红。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
activatedAt: 2026-09-27T05:09:03.968Z
statusLog:
  - at: 2026-09-27T05:09:03.968Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-27T19:08:27.695Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T05:09:03.968Z
---
