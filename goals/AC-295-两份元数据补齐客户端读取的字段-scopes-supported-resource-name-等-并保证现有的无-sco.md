---
id: AC-295
title: 两份元数据补齐客户端读取的字段：scopes_supported、resource_name 等，并保证现有的无 scope 授权流程不变
status: draft
kind: criterion
goal: GOAL-026
criterion: for f in
  server/modules/mcp-gateway/tests/oauth-metadata-fields.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/oauth-metadata-fields.test.ts
expect: '读数：(a) 授权服务器元数据含 `scopes_supported`（恰为 SPEC
  词汇表的五个）、`response_modes_supported:
  ["query"]`、`revocation_endpoint_auth_methods_supported`、`service_documentation`；(b)
  受保护资源元数据含 `scopes_supported`、`resource_name`、`bearer_methods_supported:
  ["header"]`、`resource_documentation`；(c) 两份文档里的 `scopes_supported`
  彼此一致，并等于签发令牌时使用的同一份词汇表（语法树或单测证明没有第二份常量）；(d) **回归守卫**：不带 `scope` 参数的授权流程（Gemini
  与 ChatGPT 的形态）仍然完整走通，授权页仍列出全部五个 scope、只预勾只读；带全部五个 scope
  的授权请求同样走通。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) `scopes_supported` 多一个
  `cloudcli:admin` ⇒ (a)(c) 必须红；(ii) 授权页只列请求的 scope ⇒ (d)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。'
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
