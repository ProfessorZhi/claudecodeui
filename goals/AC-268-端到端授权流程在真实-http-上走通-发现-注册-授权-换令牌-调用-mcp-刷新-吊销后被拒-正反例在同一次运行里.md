---
id: AC-268
title: 端到端授权流程在真实 HTTP 上走通：发现、注册、授权、换令牌、调用 /mcp、刷新、吊销后被拒，正反例在同一次运行里
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts; do
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts
expect: 临时实例，`MCP_OAUTH_ENABLED` 开，`MCP_DCR=open`，不经浏览器：用 MCP SDK 客户端的 OAuth
  能力或等价的手写客户端。读数：(a) 依次完成元数据发现、动态注册、`GET /oauth/authorize`、带密码与 CSRF 令牌的
  POST、`/oauth/token` 授权码换令牌（PKCE S256）；(b) 用 access token 调 `tools/list` 与
  `overview` 得到正确结果；(c) 刷新得到新令牌，旧 refresh 此后被拒；(d) 在设置接口吊销该授权后，同一个 access token
  的下一次 `/mcp` 调用得到 401；(e) 反例同在这一次运行：错误密码拿不到授权码，错误 verifier
  换不到令牌，授权码重放被拒。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 授权页跳过密码 ⇒ (e) 必须红；(ii)
  吊销不级联 ⇒ (d) 必须红；(iii) 刷新后旧令牌仍有效 ⇒ (c) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1
  输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:23:16.533Z
statusLog:
  - at: 2026-10-05T02:23:16.533Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:26:03.688Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:23:16.532Z
---
