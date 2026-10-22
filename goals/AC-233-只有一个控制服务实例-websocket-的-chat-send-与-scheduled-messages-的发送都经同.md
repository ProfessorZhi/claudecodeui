---
id: AC-233
title: 只有一个控制服务实例：WebSocket 的 chat.send 与 scheduled-messages
  的发送都经同一个实例，WebSocket 处理器只剩解析与翻译
status: achieved
kind: criterion
goal: GOAL-019
criterion: for f in server/modules/websocket/tests/chat-control-wiring.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/websocket/tests/chat-control-wiring.test.ts
expect: 读数：(a) 向 `createWebSocketServer` 或 `handleChatConnection`
  注入一个间谍控制服务，经真实的 `chat.send`、`chat.abort`、`chat.cancel-queued`
  帧驱动，间谍上对应方法各被调用一次且调用方标记为 websocket，注入的假运行时被处理器直接调用的次数为 0；(b) 把同一个间谍实例交给
  scheduled-messages 的分发器，一次到点发送触达间谍的 `send`，调用方标记为
  scheduled，且仍带「打断进行中的运行」语义，既有的 scheduled-messages 行为不变；(c) 对
  `chat-websocket.service.ts`
  解析语法树：`handleChatSend`、`handleChatAbort`、`handleChatCancelQueued` 的函数体里没有对
  `dispatchRun`、`.abort(`、`.cancelQueuedInput(` 的调用；(d)
  同一次运行里的正例对照：同一个扫描器在控制服务的实现文件里能找到这三类调用，证明 (c) 的零不是扫描器失灵。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 让 `handleChatSend` 直接调 `dispatchRun` ⇒ (a) 与 (c) 必须红；(ii)
  scheduled-messages 自己 new 一个控制服务 ⇒ (b) 必须红；(iii) WebSocket 与
  scheduled-messages 各持一个实例 ⇒ (b) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:23:20.252Z
statusLog:
  - at: 2026-10-04T17:23:20.252Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T20:04:37.078Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:23:20.252Z
---
