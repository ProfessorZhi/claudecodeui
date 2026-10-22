---
id: AC-250
title: session_create 与 session_interrupt：创建会话（可带首条消息），中止运行但常驻进程保留，对空闲会话如实说没有可中止的
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
expect: "读数：(a) `session_create` 在指定项目下创建应用会话；带 `message` 时随即启动首轮并同时返回
  `sessionId` 与 `runId`，不带时不启动任何运行；(b) 项目名按模糊匹配规则解析，多义时不创建；(c) 需要
  `cloudcli:session:create`，只有 send 的令牌被拒；(d) `session_interrupt` 对正在运行的常驻会话：返回
  `aborted: true`，终止帧为 aborted，宿主 pid 不变；(e) 对空闲会话返回 `aborted: false`
  并明说没有可中止的运行，不虚报已中止；(f) 需要 `cloudcli:session:control`。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 中止后把常驻进程也关了 ⇒ (d) 的 pid 不变必须红；(ii) 空闲时也回 `aborted: true`
  ⇒ (e) 必须红；(iii) 不带 message 也启动运行 ⇒ (a) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1
  输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:12:57.797Z
statusLog:
  - at: 2026-10-05T02:12:57.797Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T10:28:10.448Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:12:57.796Z
---
