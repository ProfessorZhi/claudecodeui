---
id: AC-284
title: 所有工具的所有失败用同一个信封：isError 为真，structuredContent 带稳定 code、英文
  message、retryable、details
status: achieved
kind: criterion
goal: GOAL-024
criterion: for f in server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
expect: "真实 HTTP 加 MCP SDK
  客户端，对全部工具跑同一组错误探针：会话不存在、项目不存在、歧义、参数缺失、参数类型错、未知工具、权限不足、会话忙、审批或排队消息不存在、运行不存在。读数\
  ：(a) 每个失败都是 `isError: true`，并且带 `structuredContent` 形如 `{ code, message,
  retryable, details? }`，`code` 是大写蛇形字符串，`retryable` 是布尔；(b) 不再有「文本里塞一段
  JSON」或「纯文本一句话」的形态（当前 `session_read` 是纯文本、`session_send` 是文本里的 JSON）；(c)
  同一类问题在所有工具上用同一个 code：例如会话不存在一律是同一个 code，不再出现 `SESSION_NOT_FOUND` 与
  `TARGET_NOT_FOUND` 两种说法并存；(d) 探针表覆盖 17
  个工具中每个能触发该类错误的工具，探针表本身由工具注册表驱动，新增工具而未加入探针时本测试变红。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 让某个工具回到纯文本错误 ⇒ (a)(b) 必须红；(ii) 让某个工具的 not found 用另一个 code
  ⇒ (c) 必须红；(iii) 往注册表加一个工具而不加探针 ⇒ (d)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸\
  以退出码 1 输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
activatedAt: 2026-10-06T12:15:25.754Z
statusLog:
  - at: 2026-10-06T12:15:25.754Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-06T14:44:56.757Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-06T12:15:25.754Z
---
