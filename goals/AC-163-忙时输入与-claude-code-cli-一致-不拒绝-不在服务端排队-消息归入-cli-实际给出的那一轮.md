---
id: AC-163
title: 忙时输入与 Claude Code CLI 一致：不拒绝、不在服务端排队，进入 CLI 的输入队列并可在出队前撤回
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-busy-input.test.ts
expect: 基线已定：E2/E3 两种形态一致，忙时推入的用户消息另起一轮，不并入、不丢、不拒，人 yale 已在记录文件写入「E2/E3
  基准确认：」一行（2026-09-26）。E9 读数：优先级三档 now、next、later 都进入 CLI 命令队列（command_lifecycle
  依次为 queued、started、completed），都不并入当前轮；服务端写入用 later 档（排在当前轮之后，复现交互式 CLI
  行为，proposal §8），next 档执行时的落点 E9 没读到，不作断言。轮次边界取 system/init 与 result，E9
  两条驱动都没读到 session_state_changed，不等该事件。真实 claude 二进制 + mock 端点，mock 拖住响应以造出忙；识别真
  agent 轮按请求体体量大于 10KB，不按序号、也不按请求里有无用户文本（每轮会先发一条约 2KB 的预检请求）。判据：(1)
  用户轮进行中与无人轮进行中各发一次 chat.send，都不返回 RUN_IN_PROGRESS；(2) 消息写入进程 stdin 的时刻早于当前轮的
  result，帧带服务端分配的 uuid（即 CLI 的 command_uuid）与 priority=later；(3)
  该消息出现在其后另起一轮的请求体里，被记入那一轮的 run，不丢失；(4) 撤回按 command_lifecycle 的 cancelled
  事件判定，不按控制响应，因为 E9 读到 cancel_async_message 在三种时机都没有
  control_response：对尚在队列中的消息发起撤回 ⇒ 服务端发出 cancel_async_message，读到该 uuid 的
  state=cancelled，该消息文本不出现在任何一轮请求里，返回值标为已撤回；对已出队的消息撤回 ⇒ 没有 cancelled
  事件，返回可辨的已开始处理结果，进程无副作用。取假形态：(a) 服务端自己排队到当前轮结束后才写入 ⇒ (2) 的写入时刻读数必须红；(b) 返回
  RUN_IN_PROGRESS ⇒ 必须红；(c) 撤回只在前端隐藏、不发 cancel_async_message ⇒ 无 cancelled
  事件且消息仍产生一轮，(4) 必须红；(d) 以 control_response 的到达判撤回成败 ⇒ 撤回成功也读成失败，(4) 必须红；(e) 等
  session_state_changed 才切分轮次 ⇒ 读不到轮边界，(3) 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 ｜2026-09-27 人 yale 指令：按
  proposal 阶段 0 结论（E1–E9，记录文件
  docs/proposals/claude-resident-sessions-experiments.md）修订判据；忙时输入基准由 E2/E3/E9
  定稿，priority 取 later，撤回以 cancelled 事件为准，轮次边界以 system/init 与 result 为准
activatedAt: 2026-09-27T04:56:26.174Z
statusLog:
  - at: 2026-09-27T04:56:26.174Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T11:24:19.090Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T04:56:26.174Z
---
