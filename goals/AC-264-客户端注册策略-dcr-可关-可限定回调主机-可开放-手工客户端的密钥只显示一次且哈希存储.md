---
id: AC-264
title: 客户端注册策略：DCR 可关、可限定回调主机、可开放，手工客户端的密钥只显示一次且哈希存储
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in server/modules/oauth/tests/oauth-dcr.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test server/modules/oauth/tests/oauth-dcr.test.ts
expect: 读数：(a) `MCP_DCR=off`（默认）时 `/oauth/register` 不可用，元数据不含
  `registration_endpoint`；(b) `allowlist` 时，所有 `redirect_uris` 的主机都在
  `MCP_ALLOWED_REDIRECT_HOSTS` 内才接受，任一不在即 `invalid_redirect_uri`；(c) `open`
  时接受，但回调只能是 https 或 `localhost`、`127.0.0.1` 的 http，其他 http 被拒；(d) 注册返回的
  `client_secret` 只出现在这一次响应里，库里只有哈希；(e)
  经设置接口手工创建客户端同样只返回一次密钥、需要已登录用户。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) `off`
  时仍可注册 ⇒ (a) 必须红；(ii) allowlist 只检查第一个回调 ⇒ (b) 必须红；(iii) 密钥明文入库 ⇒ (d)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:21:29.388Z
statusLog:
  - at: 2026-10-05T02:21:29.388Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:25:13.006Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:21:29.388Z
---
