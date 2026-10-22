---
id: AC-275
title: 真实 claude 二进制的常驻驱动经控制服务撤回排队消息：uuid 来自真实驱动，撤回后那条消息不成为一轮，进程 pid 不变
status: achieved
kind: criterion
goal: GOAL-022
criterion: for f in
  server/modules/providers/tests/claude-resident-control-queue.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-control-queue.test.ts
expect: "做法照 AC-161：真实 claude 二进制加 mock Anthropic 兼容端点，临时
  DATABASE_PATH，按请求体识别请求，SDK 标题请求不计。读数：(a) 经控制服务（不经
  WebSocket）对常驻会话发第一轮，第一轮进行中再发第二条，返回 `queued: true` 与非空 `queuedMessageUuid`；(b)
  用该 uuid 撤回得到 `cancelled`，mock 端点此后收不到第二条消息对应的模型请求；(c) 全程宿主 pid 不变；(d)
  对照臂：不撤回时第二条成为独立的下一轮，mock 端点收到对应请求。覆盖 SPEC 里「真实驱动的 cancel_async_message
  只被既有测试覆盖」的缺口。负载下可能假红，由 fan-in 全量 suite 复核时按假红处理流程，不放宽断言。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 驱动不交出 uuid ⇒ (a) 必须红；(ii) 撤回不真正移出队列 ⇒ (b) 必须红；(iii)
  撤回关掉了进程 ⇒ (c) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:28:00.780Z
statusLog:
  - at: 2026-10-05T02:28:00.780Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:28:42.052Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:28:00.779Z
---
