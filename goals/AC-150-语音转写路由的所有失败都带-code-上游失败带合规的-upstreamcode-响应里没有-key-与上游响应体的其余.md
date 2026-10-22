---
id: AC-150
title: 语音转写路由的所有失败都带 code，上游失败带合规的 upstreamCode，响应里没有 key 与上游响应体的其余文本
status: achieved
kind: criterion
goal: GOAL-011
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice/tests/voice-error-contract.test.ts
expect: 经出货的路由，对预检拒绝、上游各类失败、无语音、不可达各驱动一次：每个失败响应都含 error 与 code；上游失败另含
  upstreamCode，它只由字母、数字、点、下划线、连字符组成、长度有界、取自上游响应体里的错误码串；响应中不含 key 明文、Bearer 加 key
  的形式，也不含上游响应体里不属于码串的文本（替身上游把一段哨兵文本放进响应体，正例是它确实在上游响应里，而它不得出现在返回给页面的响应中）。取假形态：(1)
  上游失败不带 code ⇒ 必须红；(2) 把上游响应体原样放进 error 或 upstreamCode ⇒ 必须红。
origin: docs/proposals/voice-error-messages.md（2026-09-24 人 yale 裁定：所有失败带稳定
  code、账户类合成 ACCOUNT_ACCESS、提示持续显示并带折叠技术详情、不做上传前静音检查、建成新 goal）
activatedAt: 2026-09-24T12:42:40.201Z
statusLog:
  - at: 2026-09-24T12:42:40.201Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-24T13:52:16.567Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T12:42:40.201Z
---
