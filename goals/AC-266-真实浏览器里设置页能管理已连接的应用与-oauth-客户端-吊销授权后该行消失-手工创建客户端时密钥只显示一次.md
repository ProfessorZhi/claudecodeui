---
id: AC-266
title: 真实浏览器里设置页能管理已连接的应用与 OAuth 客户端：吊销授权后该行消失，手工创建客户端时密钥只显示一次
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || {
  echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test
  e2e/connected-apps-settings.spec.ts
expect: 真实浏览器、真实后端、临时数据目录，授权记录经后端接口预置。读数：(a)
  「已连接的应用」列出预置的授权，显示客户端名称、回调主机、scope；(b) 吊销后该行消失，且用该授权的令牌访问 `/mcp` 得到 401；(c)
  在「OAuth 客户端（高级）」手工创建客户端，密钥只在创建后的提示里出现一次，刷新后页面任何文本节点都不含它；(d)
  禁用客户端后其授权的令牌被拒。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 吊销只改前端状态 ⇒ (b)
  必须红；(ii) 列表里渲染密钥 ⇒ (c) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:22:29.130Z
statusLog:
  - at: 2026-10-05T02:22:29.131Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:25:38.456Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:22:29.130Z
---
