---
id: AC-259
title: OAuth 授权服务器的语义：PKCE 强制 S256，授权码一次性且 60 秒过期，refresh 每用一次即轮换且旧的复用会吊销整个授权，受众必须匹配
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in server/modules/oauth/tests/oauth-provider.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test server/modules/oauth/tests/oauth-provider.test.ts
expect: 时钟可注入。读数：(a) PKCE：缺 challenge、method 为 plain、verifier 不匹配三种都被拒，S256
  正确通过；(b) 授权码：第二次使用被拒，且该码已签发的令牌被吊销；超过 60 秒被拒；(c) refresh 轮换：用一次得到新 access 与新
  refresh，旧 refresh 立即失效；再次提交旧 refresh（复用）被拒并吊销整个授权；(d) scope：refresh
  时缩小允许、放大被拒；(e) 受众：请求的 `resource` 与授权时不一致被拒（invalid_target）；令牌的 `resource` 不是
  `PUBLIC_BASE_URL/mcp` 时 `/mcp` 不接受；客户端没发 `resource` 时以默认受众签发；(f)
  `redirect_uri` 必须与注册值精确相等，前缀、后缀、大小写变体、多一个查询参数都被拒；机密客户端密钥错误被拒；(g) access 有效期默认
  1 小时、refresh 默认 30 天，两者可配置。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 接受 plain
  ⇒ (a) 必须红；(ii) 授权码可重复使用 ⇒ (b) 必须红；(iii) 旧 refresh 轮换后仍有效 ⇒ (c) 必须红；(iv)
  redirect_uri 只比前缀 ⇒ (f) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:19:19.435Z
statusLog:
  - at: 2026-10-05T02:19:19.435Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:24:35.887Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:19:19.434Z
---
