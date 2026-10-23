---
id: AC-262
title: 元数据端点返回 JSON 而不是 SPA 页面：开启时发布正确的 issuer、受众与 PKCE 能力，关闭时不发布，公网基址必须是 https
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in
  server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts
expect: 读数：(a) `MCP_OAUTH_ENABLED` 开且 `PUBLIC_BASE_URL` 为 https 时，`GET
  /.well-known/oauth-authorization-server` 与 `GET
  /.well-known/oauth-protected-resource/mcp` 返回 200，content-type 为
  `application/json`，`issuer` 等于基址，`resource` 等于基址加
  `/mcp`，`code_challenge_methods_supported` 恰为 `["S256"]`；(b) 这两个端点挂在静态路由之前：以
  SPA 兜底路由为后盾的装配下，响应仍是 JSON 而不是 `text/html`；(c) `registration_endpoint` 只在 DCR
  不是 off 时出现；(d) 开关关闭时响应不含 `issuer` 字段（未挂载，不发布元数据）；(e) 开关开而 `PUBLIC_BASE_URL`
  缺失、或为非 localhost 的 http 时，配置加载失败并在错误里点名该变量；`http://localhost` 与
  `http://127.0.0.1` 放行。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 把挂载放到静态路由之后 ⇒
  (b) 必须红；(ii) 缺 PUBLIC_BASE_URL 仍启动 ⇒ (e) 必须红；(iii) 声明支持 plain ⇒ (a)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:20:13.622Z
statusLog:
  - at: 2026-10-05T02:20:13.622Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:24:48.173Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:20:13.622Z
---
