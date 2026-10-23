---
id: AC-138
title: DashScope 适配器线协议、书面化解析与降级、错误映射在离线替身下成立
status: achieved
kind: criterion
goal: GOAL-009
criterion: node scripts/asr-dashscope-omni-check.mjs
expect: 全程注入替身 fetch、零真实网络：请求为 chat-audio 形状（system 含三段提示词；user 含 input_audio 的
  data URI 与 JSON_TASK；stream 为 false；reasoning_effort 为 low；format 由录音基础 MIME
  推出）；上游返回合法 JSON ⇒ text 等于 instruction 且 style 为 written；JSON 不可解析但有 transcript
  ⇒ 降级为 verbatim 且 meta.writtenFallback 为 1；两者都空 ⇒ NO_SPEECH_DETECTED；401、403（含
  AccessDenied.Unpurchased，信息指出未开通或余额不足）、429、超时各自映射到
  UNAUTHORIZED、UNAUTHORIZED、RATE_LIMITED、TIMEOUT；超过 10MB 的请求 ⇒ OVERSIZE 且替身调用次数为
  0；hints 中的 prompt 与 context 不出现在请求体中。取假形态：(1) 把原始 content 整段当作 text 返回 ⇒
  必须红；(2) 403 映射成 UPSTREAM_ERROR ⇒ 必须红；(3) 超限仍发出请求 ⇒ 必须红。
origin: docs/proposals/voice-dashscope-omni-written-instruction.md（2026-09-24 人
  yale 裁定：E 组提示词定型；key 由用户提供；书面指令进 composer；本轮不改输入体验）
activatedAt: 2026-09-24T02:56:34.382Z
statusLog:
  - at: 2026-09-24T02:56:34.382Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-24T03:55:40.546Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T02:56:34.382Z
---
