---
id: AC-263
title: OAuth 开启后 /mcp 的认证：无令牌的 401 带资源元数据指引，PAT 与 OAuth 令牌并存，受众不对的令牌被拒，回环守卫自动关闭
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts
expect: 读数：(a) 无令牌访问 `/mcp` 得到 401，`WWW-Authenticate` 为 Bearer 且含
  `resource_metadata="<基址>/.well-known/oauth-protected-resource/mcp"`；(b) 有效 PAT
  与有效 OAuth access token 都被接受，来自 OAuth 令牌的调用审计里有客户端 id、来自 PAT 的为空；(c) `resource`
  不是本服务 `/mcp` 的 OAuth 令牌被拒；(d) 开启 OAuth 时非回环来源到达认证并得到 401，而不是回环守卫的 403；(e)
  范围不含所调工具所需 scope 的 OAuth 令牌被拒并写 `denied` 审计。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 401 不带 resource_metadata ⇒ (a) 必须红；(ii) 不校验受众 ⇒ (c)
  必须红；(iii) OAuth 开启后仍保留回环守卫 ⇒ (d) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:20:54.705Z
statusLog:
  - at: 2026-10-05T02:20:54.705Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:24:54.481Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:20:54.705Z
---
