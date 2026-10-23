---
id: AC-248
title: run_get 按 runId 取运行摘要并可有界等待：结束、进入待审批、超时各自返回，等待上限 25 秒，过期与未知与重启各有说法
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/mcp-gateway/tests/mcp-run-get.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-run-get.test.ts
expect: 假运行时加可注入时钟。读数：(a) 摘要含
  `runId`、`sessionId`、`source`、`status`、`phase`、`toolName`（阶段来自活动存储）、已运行时长、`bootId`；(b)
  `waitSeconds` 为 0 时立即返回当前状态；(c) `waitSeconds` 为 N 时，运行在 N
  秒内结束则在结束时刻返回并附最后一条助手消息，不是等满 N 秒；(d) 运行进入 `awaitingPermission` 时提前返回；(e) 请求 60
  秒时实际最多等 25 秒；(f) 过期的 runId 与从未出现过的 runId 返回不同的说明，两者都附带回退读取该会话最近消息的结果；(g)
  `bootId` 与首次调用时不同则说明服务已重启。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 总是等满
  `waitSeconds` ⇒ (c) 必须红；(ii) 不封顶 ⇒ (e) 必须红；(iii) 过期与未知返回同一句 ⇒ (f)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:12:05.951Z
statusLog:
  - at: 2026-10-05T02:12:05.951Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T08:09:24.534Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:12:05.950Z
---
