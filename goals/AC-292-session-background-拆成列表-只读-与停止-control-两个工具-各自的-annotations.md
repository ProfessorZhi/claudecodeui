---
id: AC-292
title: session_background 拆成列表（只读）与停止（control）两个工具，各自的 annotations 与 scope 准确
status: draft
kind: criterion
goal: GOAL-025
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-background-split.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-background-split.test.ts
expect: "读数：(a) `tools/list` 里有 `session_background`（只列出后台任务与计划，所需 scope 为
  read，`readOnlyHint: true`）与 `session_background_stop`（所需 scope 为
  control，`destructiveHint: true`）；(b) 持只读令牌：能列出，不能停止，返回
  `INSUFFICIENT_SCOPE`；(c) 旧用法兼容的取舍明确：`session_background` 不再接受
  `stopTaskId`，传入时返回 `INVALID_ARGUMENT` 并在 `message` 里指向
  `session_background_stop`；(d) 停止一个不存在的任务返回 `TASK_NOT_FOUND`，不虚报已停止；(e)
  annotations 审计表与新工具一致，列表工具不再被标成破坏性。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i)
  列表工具仍接受 `stopTaskId` ⇒ (c) 必须红；(ii) 停止工具只需要 read ⇒ (b) 必须红；(iii) 列表工具仍标破坏性 ⇒
  (e)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸\
  以退出码 1 输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
