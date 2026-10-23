---
id: AC-293
title: 每个工具声明的所需 scope 与实际强制的 scope 一致，且工具定义里能读到
status: draft
kind: criterion
goal: GOAL-025
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-declared-scopes.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-declared-scopes.test.ts
expect: "读数：(a) `tools/list` 里每个工具的 `_meta` 带
  `requiredScopes`（数组），描述末尾也写出「Requires scope: …」；(b) 对每个工具，用一个**恰好缺少**该声明 scope
  的令牌调用，得到 `INSUFFICIENT_SCOPE` 且 `details.requiredScopes` 与声明相同；用恰好具备该 scope
  的令牌调用，不再因权限被拒（可能因目标不存在而失败，但 code 不是权限类）；(c) 声明表由工具注册表生成，不手写第二份：往测试用注册表加一个工具并声明
  scope，两处同时生效；(d) 把某个工具的声明改成另一个 scope
  而实际强制不变，本测试必须红，证明它抓得到声明与强制的漂移。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i)
  改声明不改强制 ⇒ (b) 必须红；(ii) 改强制不改声明 ⇒ (b) 必须红；(iii) 手写第二份声明表 ⇒ (c)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
