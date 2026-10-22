---
id: AC-271
title: session_cancel_queued：用 session_send 返回的 uuid
  撤回排队消息，之后那条消息永远不成为一轮，撤回已开始的消息如实说已不在队列
status: achieved
kind: criterion
goal: GOAL-022
criterion: for f in server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts
expect: 真实 HTTP，调试 agent 的常驻宿主驱动。读数：(a) 第一轮进行中发送第二条，得到
  `queuedMessageUuid`；用它撤回得到 `cancelled`，此后不再出现第二条消息对应的轮次，宿主 pid 不变；(b)
  第二条已被取出开始执行后再撤回，结果是「已不在队列」，不是 `cancelled`；(c) 用从未返回过的 uuid、或别的会话的 uuid 撤回，得到
  `unknown`，不影响该会话的队列；(d) 需要 `cloudcli:session:control`，只有 send 的令牌被拒并写 `denied`
  审计。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 撤回只改返回值、不真正移出队列 ⇒ (a) 必须红；(ii)
  已开始的消息仍回 `cancelled` ⇒ (b) 必须红；(iii) 不校验会话归属 ⇒ (c)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:26:12.746Z
statusLog:
  - at: 2026-10-05T02:26:12.746Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:27:55.838Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:26:12.746Z
---
