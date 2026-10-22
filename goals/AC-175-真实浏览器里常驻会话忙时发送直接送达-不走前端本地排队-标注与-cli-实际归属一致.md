---
id: AC-175
title: 真实浏览器里常驻会话忙时发送直接送达，不走前端本地排队，出队前可撤回
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx playwright test e2e/resident-busy-send.spec.ts
expect: 基准已定（E2/E3 与 E9 9.8 一致，人 yale 已确认）：忙时推入的消息另起一轮，不并入当前回答。调试 agent
  的常驻场景让会话处于忙（含无人轮进行中），场景按 E9 9.2 的原始形态发出 command_lifecycle
  帧（queued、started、cancelled、completed）并记录收到的 cancel_async_message：(1) 发送后不出现
  QueuedMessageCard，消息立即出现在记录里，标注为「将在当前回答结束后处理」；(2) 消息尚未出队时带 [撤回]，点击后场景收到对应 uuid
  的 cancel_async_message；界面在收到 cancelled 事件后提示「已撤回」并把该消息从记录中移除、不产生一轮，未收到
  cancelled 事件前不显示「已撤回」（E9 读到 cancel_async_message 没有
  control_response，不能拿点击成功或控制响应当撤回成功）；(3) 出队（started）后 [撤回] 消失，显示「已开始处理」；(4)
  per-run 会话忙时仍出现 QueuedMessageCard。取假形态：(a) 常驻会话仍走本地排队 ⇒ (1) 必须红；(b) 撤回只在前端隐藏 ⇒
  场景没有收到 cancel_async_message 且该消息仍产生一轮，(2) 必须红；(c) 点击后立即显示「已撤回」而不等 cancelled 事件
  ⇒ 场景不发 cancelled 时读到「已撤回」，(2) 必须红。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 ｜2026-09-27 人 yale 指令：按
  proposal 阶段 0 结论（E1–E9，记录文件
  docs/proposals/claude-resident-sessions-experiments.md）修订判据；忙时标注定为「将在当前回答结束后处理」，撤回成败以
  cancelled 事件判，不再有并入当前回答的备选
activatedAt: 2026-09-27T05:10:57.548Z
statusLog:
  - at: 2026-09-27T05:10:57.548Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T18:54:33.999Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T05:10:57.548Z
---
