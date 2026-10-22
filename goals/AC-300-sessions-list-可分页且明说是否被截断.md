---
id: AC-300
title: sessions_list 可分页且明说是否被截断
status: draft
kind: criterion
goal: GOAL-027
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-sessions-list-paging.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-sessions-list-paging.test.ts
expect: 夹具含 230 个会话。读数：(a) 参数有 `limit`（`minimum` 1、`maximum` 200、`default` 50）与
  `cursor`；(b) 输出为 `{ sessions, total, nextCursor, truncated }`，`nextCursor`
  在最后一页为 `null`；(c) 顺着 `nextCursor` 翻完，所有 230 个会话各出现恰好一次，顺序稳定；(d)
  第一页之外的会话只能靠翻页取到，不再有「悄悄只给前 200 个」的情形；(e) `total` 与实际会话数相等；(f) 过期或被篡改的 `cursor`
  返回 `INVALID_ARGUMENT`，不是从头重来。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 忽略
  `cursor` ⇒ (c) 必须红；(ii) 最后一页仍给非空 `nextCursor` ⇒ (b) 必须红；(iii) 篡改的 cursor
  静默从头开始 ⇒ (f)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
