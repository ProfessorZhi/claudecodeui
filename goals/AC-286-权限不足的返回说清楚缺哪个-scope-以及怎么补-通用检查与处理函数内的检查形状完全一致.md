---
id: AC-286
title: 权限不足的返回说清楚缺哪个 scope 以及怎么补，通用检查与处理函数内的检查形状完全一致
status: achieved
kind: criterion
goal: GOAL-024
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts
expect: "读数：(a) 持只读令牌调用每一个需要更高权限的工具，返回 `isError: true`，`code` 为
  `INSUFFICIENT_SCOPE`，`details.requiredScopes` 列出缺的 scope，`message` 点名该 scope
  并说明需要重新授权；不再是纯文本 `Insufficient scope for this tool.`；(b) 处理函数内的检查（现在
  `session_background` 停止分支的 `SCOPE_DENIED`）与通用检查返回逐字段相同的形状与 code，不再有第二个
  code；(c) 被拒绝时仍写 `denied` 审计，且审计记录里带上缺的 scope；(d)
  持有足够权限时同一调用通过，防止「一律拒绝」也通过。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 回到纯文本 ⇒
  (a) 必须红；(ii) 处理函数内仍用 `SCOPE_DENIED` ⇒ (b) 必须红；(iii) 不再写 denied 审计 ⇒ (c)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸\
  以退出码 1 输出缺失的文件名。"
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
activatedAt: 2026-10-06T12:17:36.057Z
statusLog:
  - at: 2026-10-06T12:17:36.057Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-06T17:04:59.092Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-06T12:17:36.057Z
---
