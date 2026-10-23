---
id: AC-296
title: 401 的挑战头带 scope 与错误种类：缺令牌、令牌无效或过期各自可区分
status: draft
kind: criterion
goal: GOAL-026
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-challenge-header.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-challenge-header.test.ts
expect: '读数：(a) 无令牌：`WWW-Authenticate: Bearer resource_metadata="…",
  scope="cloudcli:read"`（不带 `error`，RFC 6750 规定缺凭据时不带）；(b) 令牌未知、已吊销、已过期：同样
  401，头里多出 `error="invalid_token"` 与 `error_description`，且 401
  的响应体对这三种原因仍然逐字相同（不泄露原因）；(c) 回环守卫拒绝的是 403，不带 Bearer 挑战；(d) OAuth
  关闭时挑战头不指向不存在的元数据路径。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 缺 `scope` ⇒ (a)
  必须红；(ii) 无效令牌不带 `error` ⇒ (b) 必须红；(iii) 响应体按原因不同 ⇒ (b)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。'
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
