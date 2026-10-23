---
id: AC-282
title: 描述与实际行为一致：session_start 与 session_close 说明是常驻宿主，quay_snapshot 说明 refresh
  的默认，overview 说明它返回什么
status: draft
kind: criterion
goal: GOAL-023
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-description-behavior.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-description-behavior.test.ts
expect: "用描述去对照行为，而不是只看描述写了什么。读数：(a) `session_start` 与 `session_close`
  的描述明说操作的是「常驻宿主进程」，不新建也不删除会话，并指向 `session_create`；(b) `quay_snapshot` 不带
  `refresh` 时注入的 quay 命令运行器调用数为 0，带 `refresh: true` 时恰好 1
  次，且描述同时写明这两种行为（现在的描述「Refresh and read」与默认行为相反）；(c) `overview`
  返回的顶层键与它的描述所列的键逐一相同，`project` 参数若存在，描述说明它改变什么、并有用例证明它确实改变了结果；(d)
  `session_background` 的描述说明列表与停止两种用途与各自需要的 scope（若已按 GOAL-025
  拆分，则两个工具各自说明）。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 把 `quay_snapshot`
  的描述改回「Refresh and read」 ⇒ (b) 必须红；(ii) 让 `overview` 多返回一个描述没提的键 ⇒ (c)
  必须红；(iii) `session_close` 的描述去掉「宿主」 ⇒ (a) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1
  输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
