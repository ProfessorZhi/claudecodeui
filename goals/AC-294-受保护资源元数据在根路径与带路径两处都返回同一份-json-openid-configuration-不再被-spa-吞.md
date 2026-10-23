---
id: AC-294
title: 受保护资源元数据在根路径与带路径两处都返回同一份 JSON，openid-configuration 不再被 SPA 吞掉
status: draft
kind: criterion
goal: GOAL-026
criterion: for f in
  server/modules/mcp-gateway/tests/oauth-discovery-paths.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/oauth-discovery-paths.test.ts
expect: 以 SPA 兜底路由为后盾的装配，真实 HTTP。读数：(a) `GET
  /.well-known/oauth-protected-resource` 与 `GET
  /.well-known/oauth-protected-resource/mcp` 都返回 200 与
  `application/json`，两份正文逐字相同；(b) `GET /.well-known/openid-configuration` 返回 404
  与 JSON 错误体，不是 SPA 的 200 HTML；(c) 两处都挂在静态路由之前；(d) OAuth 关闭时这些路径不发布元数据（响应不含
  `resource` 或 `issuer` 字段）。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 根路径不挂载 ⇒
  (a) 必须红；(ii) 把挂载放到静态路由之后 ⇒ (a)(b) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
