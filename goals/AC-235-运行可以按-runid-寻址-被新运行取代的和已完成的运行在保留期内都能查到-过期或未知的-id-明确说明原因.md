---
id: AC-235
title: 运行可以按 runId 寻址：被新运行取代的和已完成的运行在保留期内都能查到，过期或未知的 id 明确说明原因
status: achieved
kind: criterion
goal: GOAL-019
criterion: for f in server/modules/websocket/tests/chat-run-by-id.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/websocket/tests/chat-run-by-id.test.ts
expect: 保留期与时钟可注入（环境变量 `CHAT_RUN_RETENTION_MS` 或构造参数，默认仍为 5 分钟）。读数：(a)
  同一会话先后开两次运行（第二次以取代方式开出），两个 runId 都能 `getRunById` 查到，且各自状态独立正确（旧的 running 或
  completed，新的 running）；(b) 运行摘要含
  `runId`、`sessionId`、`source`、`status`（running、completed、aborted
  之一）、`startedAt`、`completedAt`、`lastSeq`；被中止的运行状态为 aborted 而不是 completed；(c)
  完成的运行在保留期内可查，拨过保留期后返回 `expired`，未出现过的 id 返回 `unknown`；(d)
  「每个会话一个当前运行」不变：`getRun(sessionId)` 在取代之后返回新运行；(e) `chat.subscribe`
  的重放行为不变，同一运行的 `replayEvents` 结果与改动前逐帧相同。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 索引只记当前运行 ⇒ (a) 必须红；(ii) 完成的运行永不清除 ⇒ (c) 的 expired
  必须红；(iii) 中止的运行记成 completed ⇒ (b) 必须红；(iv) 让 `getRun` 返回旧运行 ⇒ (d)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:24:52.933Z
statusLog:
  - at: 2026-10-04T17:24:52.933Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T20:29:52.141Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:24:52.932Z
---
