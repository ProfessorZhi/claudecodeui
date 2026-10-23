---
id: AC-288
title: 参数校验失败返回简短、机器可读的 INVALID_ARGUMENT，不是整段 zod 输出
status: achieved
kind: criterion
goal: GOAL-024
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
expect: '读数：(a) 缺必填、类型错、枚举外、超出 `minimum` 或 `maximum`、同时给出互斥参数，都返回 `isError:
  true` 与 `code: INVALID_ARGUMENT`；(b) `details.fields` 是数组，每项含参数路径与一句英文原因，如 `{
  path: "message", problem: "required" }`；(c) `message` 不超过 300 个字符，不含原始的 zod 或
  JSON Schema 转储；(d) 未知工具返回 `UNKNOWN_TOOL`，同样是这个信封；(e)
  合法调用不受影响（正例对照）。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 回到 SDK 默认的整段输出 ⇒ (c)
  必须红；(ii) 缺 `details.fields` ⇒ (b)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。'
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
activatedAt: 2026-10-06T12:18:09.395Z
statusLog:
  - at: 2026-10-06T12:18:09.395Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-06T16:18:05.907Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-06T12:18:09.394Z
---
