---
id: AC-287
title: 引用不存在是错误，不是看似成功的结果：approval_answer、session_cancel_queued、run_get、quay_snapshot
status: achieved
kind: criterion
goal: GOAL-024
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts
expect: "约定：结果表示「一个存在的实体的状态」，错误表示「引用没有指向任何东西」或请求无效。读数：(a) `approval_answer`
  对不存在或已过期的 `requestId` 返回错误 `APPROVAL_NOT_FOUND`，`details` 区分「已过期」与「从未存在」，不再是
  `ok:false` 的成功结果；(b) `session_cancel_queued` 对从未见过的 uuid 返回错误
  `QUEUED_MESSAGE_NOT_FOUND`，而「消息已被取出开始执行」仍是成功结果，带明确的 `outcome` 枚举，且枚举写进
  outputSchema；(c) `run_get` 对未知或过期的 `runId` 返回错误
  `RUN_NOT_FOUND`，`details.reason` 为 `expired` 或 `never_issued`，并带回退读取到的最近消息；(d)
  `quay_snapshot` 对不存在的项目返回错误 `PROJECT_NOT_FOUND`（2026-10-07 订正：本条原写
  `TARGET_NOT_FOUND`。该字面量在本仓已不可满足——同族已达成判据 AC-284 要求「一类问题一个 code」，其判据在
  `server/modules/mcp-gateway/*.ts` 里扫到该字面量即红；AC-285 的 `MCP_ERROR_CODES`
  键集与其期望集双向深等，也不含该名。经人 yale 裁定，按本仓唯一规范码 `PROJECT_NOT_FOUND`
  对齐；语义未变，仍是「引用不存在即错误」），对存在但没有 quay 配置的项目返回成功结果 `status:
  no_quay_config`，两种情况不再混为一谈；(e)
  「已开始执行」「已完成」这类真实状态仍然是成功结果，不被误改成错误。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 让
  `approval_answer` 的不存在仍回 `ok:false` 成功 ⇒ (a) 必须红；(ii) 把「已开始执行」改成错误 ⇒ (e)
  必须红；(iii) `quay_snapshot` 把不存在的项目当作无配置 ⇒ (d)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸\
  以退出码 1 输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
activatedAt: 2026-10-06T12:17:56.425Z
statusLog:
  - at: 2026-10-06T12:17:56.425Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-07T02:03:40.065Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-06T12:17:56.424Z
---
