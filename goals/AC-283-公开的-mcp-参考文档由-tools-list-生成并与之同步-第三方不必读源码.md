---
id: AC-283
title: 公开的 MCP 参考文档由 tools/list 生成并与之同步，第三方不必读源码
status: draft
kind: criterion
goal: GOAL-023
criterion: for f in scripts/mcp-docs.mjs scripts/mcp-docs.test.mjs
  docs/mcp/README.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done;
  node --test scripts/mcp-docs.test.mjs && node scripts/mcp-docs.mjs --check
expect: 做法：脚本起生产挂载、拉 `initialize` 与 `tools/list`，生成 `docs/mcp/README.md`；`node
  scripts/mcp-docs.mjs --check` 重新生成并与已提交的文件逐字比较。读数：(a)
  文档含每个工具的名称、描述、参数表（含类型、是否必填、默认值、取值）、所需 scope、annotations 四个 hint、可能的错误 code；(b)
  含接入章节：端点、OAuth 发现路径、各 scope 的含义、给 ChatGPT 与 Gemini 与 Claude Code 的接入步骤；(c)
  `--check` 在文档与 `tools/list` 一致时退出 0，一旦有工具或参数改了而文档没更新则退出非 0 并点名差异；(d)
  脚本有单测覆盖「改一个参数描述就让 --check 变红」。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
