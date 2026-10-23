---
id: AC-254
title: 真实浏览器里设置页的 CloudCLI MCP 区块：显示端点与启用状态，给出 Claude Code 的接入命令，令牌的 scope
  勾选默认只读并对写权限给出提示
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in e2e/mcp-settings.spec.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/mcp-settings.spec.ts
expect: "真实浏览器、真实后端、临时数据目录，分别在 `MCP_ENABLED` 开与关两种配置下。读数：(a) 开启时区块显示端点
  URL（带复制按钮）与「已启用」，URL 形如 `<基址>/mcp`；(b) 关闭时显示「未启用」与启用方法，不显示可用的接入命令；(c) 接入命令里含端点
  URL 与 `Authorization: Bearer` 头的占位符，页面上任何文本节点都不含真实令牌；(d) 创建令牌的表单里五个 scope
  的勾选框：只读默认勾选，其余默认不勾；勾选任一写 scope 时出现风险提示；(e) 创建出的令牌经 `GET /api/oauth/token-info`
  返回的 scope 与勾选一致。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 写 scope 默认勾选 ⇒ (d)
  必须红；(ii) 关闭时仍显示接入命令 ⇒ (b) 必须红；(iii) 命令里内嵌真实令牌 ⇒ (c)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:15:54.864Z
statusLog:
  - at: 2026-10-05T02:15:54.864Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T05:06:42.808Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:15:54.864Z
---
