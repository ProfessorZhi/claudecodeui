---
id: AC-238
title: 经控制服务在调试 agent 的常驻驱动上走通忙时排队与撤回：uuid 由驱动交出，撤回后那条消息永远不成为一轮
status: achieved
kind: criterion
goal: GOAL-019
criterion: for f in
  server/modules/debug-agent/tests/debug-agent-control-queue.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/debug-agent/tests/debug-agent-control-queue.test.ts
expect: "用调试 agent 的常驻宿主驱动（不跑真 CLI），经控制服务而不是 WebSocket。读数：(a) 第一轮仍在进行时再
  `send`，返回 `queued: true` 与非空 `queuedMessageUuid`，且该 uuid 与驱动内部给这条消息分配的相同；(b)
  不撤回时，第一轮结束后第二条消息成为独立的下一轮，其 runId 与第一轮不同，两轮各有一个终止帧；(c) 撤回时，用返回的 uuid 调
  `cancelQueued` 得到 `cancelled`，之后不再出现第二条消息对应的轮次，宿主 pid 不变；(d)
  在该消息已被取出（已开始执行）之后再撤回得到 `unknown` 或等价的「已不在队列」结果，而不是
  `cancelled`。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 驱动不交出 uuid ⇒ (a)
  必须红；(ii) 撤回只改返回值、不真正移出队列 ⇒ (c) 的「不再出现轮次」必须红；(iii) 撤回已开始的消息仍回 `cancelled` ⇒ (d)
  必须红。说明：真实 Claude 驱动的 `cancel_async_message` 不由本判据覆盖，只由既有真实 CLI 测试与后续 goal
  的人工门覆盖。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:26:38.499Z
statusLog:
  - at: 2026-10-04T17:26:38.499Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T19:25:29.596Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:26:38.499Z
---
