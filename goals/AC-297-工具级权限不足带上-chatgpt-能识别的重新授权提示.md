---
id: AC-297
title: 工具级权限不足带上 ChatGPT 能识别的重新授权提示
status: draft
kind: criterion
goal: GOAL-026
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-tool-reauth-meta.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-tool-reauth-meta.test.ts
expect: 依据 OpenAI 文档对「工具级 OAuth 界面」的要求。读数：(a) `INSUFFICIENT_SCOPE` 的工具结果带
  `_meta["mcp/www_authenticate"]`，值是 `Bearer error="insufficient_scope",
  error_description="…", scope="<缺的 scope>", resource_metadata="…"`
  形态的挑战字符串，`error` 与 `error_description` 都在；(b) 结果仍保持第一个 goal 的错误信封，二者互不冲突；(c)
  非权限类错误不带这项 `_meta`；(d) `scope` 值与 `details.requiredScopes`
  一致。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 缺 `error_description` ⇒ (a)
  必须红；(ii) 非权限错误也带 ⇒ (c) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
