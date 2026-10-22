---
id: AC-168
title: 常驻默认 bypass 启动；无人值守时三个需要人回应的入口都被自动拒绝并通知
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-permissions.test.ts
expect: 常驻进程以 permissionMode=bypassPermissions 且
  allowDangerouslySkipPermissions=true 启动；切到其他权限模式时调用 setPermissionMode
  而不重启进程。没有浏览器连接且没有用户轮时，三个需要人回应的入口一律自动拒绝或取消：(1) canUseTool：mock 让模型调用
  AskUserQuestion 与 ExitPlanMode ⇒ 被拒绝（E8 已读到 bypass 下仍走该回调）；(2)
  onElicitation：真实 CLI 的形态是一条 control_request，subtype=elicitation，带
  mcp_server_name、message、mode、requested_schema（E9 9.6 原文），用该原文形态的帧驱动 ⇒
  返回拒绝或取消；(3) request_user_dialog：E9 没触发到该入口（SDK 类型联合里有、实跑无读数，缺口如实保留），伪造帧按
  sdk.d.ts
  的类型定义构造，测试里注明形态来自类型而非实物，收到即按无人值守策略应答，拒绝或取消。三种情况下拒绝信息都含无人值守说明、推送通知被调用、该轮在限定时间内结束而不挂起。有连接时三者仍走现有的请求帧流程。side_question
  不在本条：它是宿主问 CLI 的方向，E9 读到 CLI 认该 subtype 但没有
  control_response，无人值守不需要为它写拒绝分支。取假形态：(a) 只在 canUseTool 拦截 ⇒ (2) 或 (3)
  的那一轮挂起到超时，必须红；(b) 只拦 canUseTool 与 onElicitation ⇒ (3) 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 ｜2026-09-27 人 yale 指令：按
  proposal 阶段 0 结论（E1–E9，记录文件
  docs/proposals/claude-resident-sessions-experiments.md）修订判据；三个入口按 E9 9.6 读数与
  proposal §9 落地，side_question 移出，request_user_dialog 缺实物读数
activatedAt: 2026-09-27T05:02:27.363Z
statusLog:
  - at: 2026-09-27T05:02:27.363Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-27T12:26:13.673Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T05:02:27.362Z
---
