---
id: AC-156
title: GET /api/session-hosts 列出所有 provider 的宿主，含状态、绑定、保活理由与关闭原因，需鉴权
status: achieved
kind: criterion
goal: GOAL-012
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/session-hosts/tests/session-hosts-routes.test.ts
expect: 挂真实 express 应用与 authenticateToken：(1) 缺凭据 401；(2) 有凭据时，一个 codex per-run
  宿主运行中、一个 Claude per-run 宿主处于 lingering（run 已
  complete，chatRunRegistry.isProcessing 为 false）时，列表恰含这两条，每条带
  provider、mode、state、pid（没有则为 null）、bindings（含 appSessionId 与 leases）与
  closeReason；(3) 刚关闭的宿主在保留窗口内仍能读到 closeReason，窗口过后消失（注入时钟）；(4) 响应是 JSON
  且形状如上——本仓 SPA catch-all 对未挂载的 /api 路径返回 200 text/html，所以判据断言内容类型与形状，不以状态码 200
  作为挂载证据。取假形态：列表由 chatRunRegistry.listRunningRuns 映射而来 ⇒ lingering 那条缺失，(2)
  必须红。命令逐字含文件路径，不用 glob。当前必红：路由不存在。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-A「统一宿主层」并激活；扩展调试 agent 作宿主层对非 Claude provider
  适用性的替身；不加 cloudcli 子命令，只靠 HTTP/WS 加脚本
activatedAt: 2026-09-25T09:00:20.428Z
statusLog:
  - at: 2026-09-25T09:00:20.428Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-26T13:02:06.460Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-25T09:00:20.428Z
---
