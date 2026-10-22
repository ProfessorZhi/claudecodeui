---
id: AC-249
title: session_send 立即返回 runId，运行与 UI 发起的运行是同一种：来源为 mcp、出现在运行中列表、忙时排队，所需 scope 不够则拒绝
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/mcp-gateway/tests/mcp-session-send.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-send.test.ts
expect: "真实 HTTP，调试 agent 的常驻与按次进程两种会话。读数：(a) 返回先于运行结束，`runId` 等于注册表里的运行
  id，注册表里该运行 `source === 'mcp'`，并出现在 `listRunningRuns` 里；(b) 调用方的用户 id
  是令牌所属用户，不是 null；(c) 常驻会话正忙时返回 `queued: true` 与非空 `queuedMessageUuid`；(d)
  按次进程的会话正忙时返回结构化错误 `RUN_IN_PROGRESS`，并带上当前运行的 runId 与「改用 run_get 或稍后重试」的提示；(e)
  `waitSeconds > 0` 时有界等待并带回最终消息；(f) 只有 `cloudcli:read` 的令牌调用被拒，写 `denied`
  审计，控制服务的发送计数为 0；(g) 网关使用的是与 WebSocket 同一个控制服务实例（间谍计数）。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 等运行结束才返回 ⇒ (a) 必须红；(ii) 来源记成 scheduled ⇒ (a) 必须红；(iii)
  忙时一律拒绝 ⇒ (c) 必须红；(iv) 网关自己 new 一个控制服务 ⇒ (g) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1
  输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:12:41.490Z
statusLog:
  - at: 2026-10-05T02:12:41.490Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T10:04:15.650Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:12:41.489Z
---
