---
id: AC-132
title: 能力声明真的生效：请求预算超限零上游请求、honors 为假时不发该字段
status: achieved
kind: criterion
goal: GOAL-008
criterion: node scripts/asr-capability-check.mjs
expect: 断言超过 maxInlineRequestBytes 的请求返回 OVERSIZE 且上游调用次数为
  0；断言「音频在预算内、加上长上下文后超预算」的用例被拒（预算含提示词与上下文）；断言 honors.X 为 false
  时该字段不出现在请求体（不是发空值）。取假形态：(1) 把超限音频直接塞进请求体 ⇒ 调用次数断言必须红；(2) 只按音频字节判预算、不计提示词与上下文 ⇒
  长上下文用例必须红；(3) 把不支持的参数实现成发空字符串 ⇒ 必须红。
origin: ADR-004 决策 1 能力表；决策 6（上下文与音频共享同一请求预算）；决策 4 缺口二（上限必然分两层）。
activatedAt: 2026-09-22T15:01:52.963Z
statusLog:
  - at: 2026-09-22T15:01:52.963Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-23T05:03:01.881Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-09-22T15:01:52.963Z
---
