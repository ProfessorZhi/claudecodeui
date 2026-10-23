---
id: AC-281
title: 服务级说明：initialize 返回 instructions 与公开的 serverInfo，capabilities 如实
status: draft
kind: criterion
goal: GOAL-023
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-server-instructions.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-server-instructions.test.ts
expect: "真实 `initialize`。读数：(a) `instructions` 非空，且分节包含：引用规则（id
  与标题子串、歧义时怎么办）、典型工作流（发送后用 `run_get` 查进度、忙时返回排队）、写操作前先向用户确认、各 scope 能做什么、错误信封与
  code 的读法；(b) `serverInfo.name` 是公开名（不含 `claudecodeui`、`gateway` 这类内部词）、有
  `title`、`version` 等于 `package.json` 的版本而不是硬编码的 `0.1.0`、有 `websiteUrl`；(c)
  `capabilities.tools.listChanged` 为 `false`（无状态服务从不推送工具变化）；(d) `instructions`
  中点名的每个工具名都真实存在。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 删掉 instructions ⇒ (a)
  必须红；(ii) 硬编码版本 ⇒ (b) 必须红；(iii) 写成 `listChanged: true` ⇒ (c)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
