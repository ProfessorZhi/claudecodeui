---
id: AC-298
title: run_get 的参数收敛：runId 与 session 二选一，去掉别名，互斥与缺失都有明确错误
status: draft
kind: criterion
goal: GOAL-027
criterion: for f in server/modules/mcp-gateway/tests/mcp-run-get-params.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-run-get-params.test.ts
expect: 读数：(a) `inputSchema` 只有 `runId`、`session`、`waitSeconds`；`run`、`wait`
  两个别名不再存在；(b) 只给 `runId`：按运行 id 查；只给
  `session`：返回该会话当前运行，没有则返回最近一次运行，两种都明说取到的是哪种；(c)
  两个都给、或两个都不给：`INVALID_ARGUMENT`，`details.fields` 点名互斥；(d) `waitSeconds` 的
  `minimum`、`maximum`（25）、`default`（0）写在 schema 里，超限被拒而不是被静默截断，并有用例；(e)
  描述写明二选一规则与等待上限。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 恢复别名 ⇒ (a) 必须红；(ii)
  两个都给时静默取一个 ⇒ (c) 必须红；(iii) 超限静默截断 ⇒ (d)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
