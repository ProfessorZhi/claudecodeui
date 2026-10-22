---
id: AC-299
title: 凡是返回一次运行的地方都带 runId，且这个 runId 能直接交给 run_get
status: draft
kind: criterion
goal: GOAL-027
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-runid-everywhere.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-runid-everywhere.test.ts
expect: 读数：(a) `session_get.run`、`overview.running[]`、`session_send`
  的结果、`session_create` 的结果都含 `runId`；(b) 从这四处各取一个 `runId` 交给 `run_get`，都能查到该运行且
  `runId` 相同；(c) `runId` 字段名在所有这些结果里一致，不出现 `run_id`、`id`、`run` 的写法；(d)
  outputSchema 中该字段为必需字符串，不是可选。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i)
  `session_get.run` 去掉 `runId` ⇒ (a)(b) 必须红；(ii) 某处改名为 `id` ⇒ (c)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
