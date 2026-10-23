---
id: AC-231
title: 忙会话的发送语义与 UI 一致：常驻会话排队并返回可撤回的消息 uuid，按次进程的会话被拒，撤回用的就是返回的那个 uuid
status: achieved
kind: criterion
goal: GOAL-019
criterion: for f in server/modules/websocket/tests/chat-control-busy.test.ts; do
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/websocket/tests/chat-control-busy.test.ts
expect: "同样用注入式假运行时，其 `acceptsBusyInput` 与 `cancelQueuedInput` 可控。读数：(a)
  常驻形态（`acceptsBusyInput` 为真）的会话正忙时再 `send`：返回 `ok: true`、`queued:
  true`、`queuedMessageUuid` 为非空字符串，并产生第二个 runId，且注册表里两次运行都按各自 id 可查；(b) 用该 uuid
  调 `cancelQueued` 得到 `cancelled`，假队列里这条消息被移除；(c) 按次进程形态（`acceptsBusyInput`
  为假）的会话正忙时再 `send`：返回 `ok: false`、`code: RUN_IN_PROGRESS`，不登记第二次运行，也不调用驱动；(d)
  用一个从未返回过的 uuid 调 `cancelQueued` 得到 `unknown` 而不是
  `cancelled`。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 忙时一律拒绝 ⇒ (a) 必须红；(ii)
  忙时一律排队 ⇒ (c) 必须红；(iii) 返回的 uuid 是自造的、与驱动无关 ⇒ (b) 必须红；(iv) `cancelQueued` 对任何
  uuid 都回 `cancelled` ⇒ (d) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:22:03.830Z
statusLog:
  - at: 2026-10-04T17:22:03.830Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T18:50:24.896Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:22:03.830Z
---
