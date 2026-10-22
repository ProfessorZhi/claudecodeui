---
id: AC-173
title: 真实浏览器里 Running 视图分正在运行与常驻（空闲）两组，侧栏徽标只计正在运行的会话
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx playwright test e2e/resident-running-view.spec.ts
expect: 调试 agent 场景造出一个运行中的会话与两个空闲常驻会话：侧栏 Running 徽标读数为 1；Running
  视图两组各列出对应会话，第二组每行有关闭按钮，点击后该会话宿主关闭、从该组消失。取假形态：徽标计入空闲常驻会话 ⇒ 读数 3，必须红。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
activatedAt: 2026-09-27T05:07:28.991Z
statusLog:
  - at: 2026-09-27T05:07:28.991Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T19:01:06.073Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T05:07:28.991Z
---
