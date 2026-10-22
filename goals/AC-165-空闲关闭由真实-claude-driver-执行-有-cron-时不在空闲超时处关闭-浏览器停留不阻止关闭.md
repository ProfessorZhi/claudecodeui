---
id: AC-165
title: 空闲关闭由真实 Claude driver 执行：cron 保活理由按 CLI 清单对账，有 cron 时不在空闲超时处关闭，浏览器停留不阻止关闭
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-idle.test.ts
expect: 伪造 SDK 流 + 注入时钟驱动 Claude resident driver。伪造帧的字段名与形态取自 E9 原始读数（记录文件 9.3 至
  9.5），不自造：Stop hook 输入的 session_crons 元素含
  id、schedule、recurring、prompt，background_tasks 元素含
  id、type、status、description、command；后台任务事件为
  task_started、task_notification、background_tasks_changed。轮次边界按 system/init 与
  result。判据：(1) session_crons 含一条周期 cron ⇒ 保活理由含 cron，expiresAt 为创建时加 7 天（E1
  读到工具结果写明自动 7 天过期），24 小时静默时不关；(2) 模型从未调用 CronDelete，但下一轮的 session_crons 已不含该
  cron ⇒ cron 保活理由消失，此后按正常计时在 24 小时处以 idle 关闭；(3) session_crons 一直含该 cron ⇒ 7
  天过期后再计时关闭；(4) 流中没有 Stop hook 输入时退回按 CronCreate、CronDelete 工具调用推测，保活理由标为
  inferred；(5) background_tasks 非空，或 background_tasks_changed 的 tasks 非空 ⇒
  后台任务保活理由存在，清单变空后消失并恢复计时；(6) 流中夹一条未知 system subtype（如 scheduled_task_fire，E9
  没读到、CLI 二进制里有）⇒ 读取循环不中断，计时与保活理由不受影响；(7) 期间浏览器持续 chat.subscribe 不改变关闭时刻；(8) 关闭后
  GET /api/session-hosts 读到 closeReason=idle。取假形态：(a) driver 不上报 cron 保活理由 ⇒ 24
  小时处被关，(1) 必须红；(b) 只按工具调用推测、不读 session_crons ⇒ (2) 里 cron 保活理由一直存在，必须红；(c) 遇未知
  subtype 抛错中断循环 ⇒ (6) 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 ｜2026-09-27 人 yale 指令：按
  proposal 阶段 0 结论（E1–E9，记录文件
  docs/proposals/claude-resident-sessions-experiments.md）修订判据；cron 与后台任务保活理由按 E9
  读到的 Stop hook 清单与 task_* 事件对账，未知 subtype 放过
activatedAt: 2026-09-27T04:58:58.692Z
statusLog:
  - at: 2026-09-27T04:58:58.692Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-27T11:15:59.670Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T04:58:58.692Z
---
