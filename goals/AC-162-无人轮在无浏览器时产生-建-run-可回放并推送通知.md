---
id: AC-162
title: 无人轮在无浏览器时产生、建 run、可回放并推送通知
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-unattended-turn.test.ts
expect: 真实 claude 二进制 + mock 端点：mock 按脚本让模型以后台方式（run_in_background）启动一个
  Bash，命令盯一个由测试控制的文件，文件出现才退出。E9 读到 Monitor 不在 CLI 工具表里，不能再用它触发；后台任务的
  task_started、task_notification、background_tasks_changed 事件形态见记录文件 9.3。所有
  socket 断开后测试创建该文件 ⇒ 产生一个来源为 unattended 的 run，帧由真实归一化产出、seq 递增；新连接
  chat.subscribe(lastSeq=0) 能完整重放；notifyBackgroundWorkCompleted
  被调用且带触发类型（后台任务回报）；该轮内容同时出现在 transcript 与 REST 历史里。无人轮的识别用 command_uuid
  不在本宿主已推集合里，触发类型对账 Stop hook 的 background_tasks，不读 origin。用后台 Bash 而非 cron
  触发，是为了在 60 秒内完成；cron 真实触发的读数由 E1 给出。读数缺口：E9 观察窗内后台 Bash 没有跑完，没读到「完成后 CLI
  是否自行开一轮无人轮」；实现本条的任务先取这条读数并写回记录文件，读到不开轮时由人改判据（改用跨会话消息触发），不得自行放宽。取假形态：无人轮只靠转录同步补进会话、不开
  run ⇒ 重放读数必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 ｜2026-09-27 人 yale 指令：按
  proposal 阶段 0 结论（E1–E9，记录文件
  docs/proposals/claude-resident-sessions-experiments.md）修订判据；工具表无 Monitor（E9
  9.3），改后台 Bash 触发；完成是否开无人轮尚无读数，记为缺口
activatedAt: 2026-09-27T04:55:11.863Z
statusLog:
  - at: 2026-09-27T04:55:11.863Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T08:26:43.123Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T04:55:11.863Z
---
