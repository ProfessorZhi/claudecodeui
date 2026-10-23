---
id: AC-290
title: session_create 带 message 等于发送：需要 session:send，不只是 session:create
status: draft
kind: criterion
goal: GOAL-025
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-create-needs-send.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-create-needs-send.test.ts
expect: 真实 HTTP，三种令牌。读数：(a) 只有 `cloudcli:read` 与 `cloudcli:session:create`
  的令牌，调用 `session_create` 带非空 `message`，返回
  `INSUFFICIENT_SCOPE`，`details.requiredScopes` 含
  `cloudcli:session:send`，**没有创建会话、没有启动运行**（会话行数与运行注册表都不变）；(b) 同一令牌不带 `message`
  创建会话成功，且不启动任何运行；(c) 具备 create 与 send 的令牌带 `message` 创建成功并启动首轮；(d)
  工具描述与参数描述明说「带 message 即发送，需要 session:send」。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 恢复为只检查 create ⇒ (a) 必须红；(ii) 不带 message 也要求 send ⇒ (b)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
