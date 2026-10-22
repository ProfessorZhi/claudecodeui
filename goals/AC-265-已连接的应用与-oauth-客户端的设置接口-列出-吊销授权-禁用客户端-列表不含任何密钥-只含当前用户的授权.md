---
id: AC-265
title: 已连接的应用与 OAuth 客户端的设置接口：列出、吊销授权、禁用客户端，列表不含任何密钥，只含当前用户的授权
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in server/modules/oauth/tests/oauth-settings.routes.test.ts; do
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/oauth/tests/oauth-settings.routes.test.ts
expect: 用生产的设置路由工厂加注入的认证，经真实 HTTP。读数：(a)
  授权列表每行含客户端名称、回调主机、scope、授权时间、最近使用，整个响应里找不到密钥与令牌；(b) 吊销一个授权后，它名下令牌的下一次 `/mcp`
  调用返回 401；(c) 禁用客户端后同样；(d) 吊销别的用户的授权返回 404；(e) 客户端列表区分 DCR
  与手工创建。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 列表返回密钥哈希 ⇒ (a) 必须红；(ii)
  吊销不校验归属 ⇒ (d) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:22:03.088Z
statusLog:
  - at: 2026-10-05T02:22:03.088Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:25:19.247Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:22:03.088Z
---
