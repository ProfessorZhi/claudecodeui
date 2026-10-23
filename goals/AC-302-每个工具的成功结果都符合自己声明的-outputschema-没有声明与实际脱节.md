---
id: AC-302
title: 每个工具的成功结果都符合自己声明的 outputSchema，没有声明与实际脱节
status: draft
kind: criterion
goal: GOAL-027
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-output-schema-truth.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-output-schema-truth.test.ts
expect: "用 JSON Schema 校验器对全部工具的真实成功结果做校验。读数：(a) 17 个工具各至少一个成功样例的
  `structuredContent` 通过其 `outputSchema` 校验；(b) `outputSchema` 设置
  `additionalProperties: false` 或显式列出全部顶层字段，使「声明少于实际」的脱节（现在 `run_get` 声明
  `{run?:any}`、实际返回顶层 `runId`、`status`、`reason`）能被校验抓到；(c) 错误结果通过统一错误信封的
  schema；(d) 正例对照：往某个工具的结果里多加一个未声明字段，本测试必须红。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 某工具结果多一个未声明字段 ⇒ (b)(d) 必须红；(ii) 把 `run_get` 的 schema 改回
  `{run?:any}` ⇒ (b) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
