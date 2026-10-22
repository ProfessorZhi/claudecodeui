---
id: AC-301
title: session_send 返回明确的状态，等待结果有类型：running、queued、completed、failed、waiting_timed_out
status: draft
kind: criterion
goal: GOAL-027
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-session-send-state.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-send-state.test.ts
expect: 真实 HTTP，调试 agent 的常驻与按次进程两种会话。读数：(a) outputSchema 含必需的 `state` 枚举，取值为
  `running`、`queued`、`completed`、`failed`、`wait_timed_out`，并保留
  `runId`、`queued`、`queuedMessageUuid`；(b) 空闲会话不等待：`running`；(c)
  忙的常驻会话：`queued`，带 `queuedMessageUuid`，描述写明「这条消息还没执行，用 `run_get` 查，或用
  `session_cancel_queued` 撤回」；(d) 带 `waitSeconds` 且运行在时限内结束：`completed`，带
  `finalMessage`（文本与角色）；(e) 带 `waitSeconds` 但时限内未结束：`wait_timed_out`，带
  `waitedSeconds`，运行仍在继续，不是错误；(f) 运行失败：`failed`，带错误摘要；(g) `run` 字段不再是
  `any`，有具体结构。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 去掉 `state` ⇒ (a)
  必须红；(ii) 超时当作错误返回 ⇒ (e) 必须红；(iii) 忙时不区分 `queued` ⇒ (c)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
