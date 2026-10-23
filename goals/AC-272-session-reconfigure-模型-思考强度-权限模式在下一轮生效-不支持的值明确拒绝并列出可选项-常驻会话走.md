---
id: AC-272
title: session_reconfigure：模型、思考强度、权限模式在下一轮生效，不支持的值明确拒绝并列出可选项，常驻会话走驱动的在线重配置
status: achieved
kind: criterion
goal: GOAL-022
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts
expect: 读数：(a) 设置 `model`、`effort`、`permissionMode` 后，会话的存储值被更新，下一次
  `session_send` 带出的运行选项取到新值；(b) 常驻会话经驱动的在线重配置能力（`setModel`、`setPermissionMode`
  的间谍）生效，不重启进程，pid 不变；(c) provider 能力矩阵里没有的 `permissionMode` 被明确拒绝，错误列出该
  provider 支持的取值，与 WebSocket 路径「悄悄忽略」不同；(d) provider 不支持在线重配置时给出明确说明；(e) 需要
  `cloudcli:session:control`。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i)
  不支持的值被悄悄忽略 ⇒ (c) 必须红；(ii) 常驻会话重配置时重启进程 ⇒ (b) 必须红；(iii) 只改存储、下一轮仍用旧值 ⇒ (a)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:26:35.103Z
statusLog:
  - at: 2026-10-05T02:26:35.103Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:28:00.914Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:26:35.103Z
---
