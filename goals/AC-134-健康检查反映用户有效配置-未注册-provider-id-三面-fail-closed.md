---
id: AC-134
title: 健康检查反映用户有效配置；未注册 provider id 三面 fail-closed
status: achieved
kind: criterion
goal: GOAL-008
criterion: node scripts/asr-config-resolution-check.mjs
expect: 构造「服务端环境变量未配置、但用户配置了」的实例，断言 configured 为真；断言 provider
  列表与各自能力齐备；断言未注册/拼错的 provider id 在三个面（直连分支、代理分支、健康检查）都 fail-closed 且不静默回落到默认
  provider。取假形态：(1) 保留今天「只看环境变量」的实现 ⇒ 第一个断言必须红（今天这个用例会答错）；(2) 未注册 id 静默回落 ⇒ 必须红。
origin: ADR-004 决策 4 缺口三（健康检查只反映服务端 env，客户端只能自行补偿）与决策 7（未注册 id 的行为，评审补）。
activatedAt: 2026-09-22T15:01:54.527Z
statusLog:
  - at: 2026-09-22T15:01:54.527Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-22T16:51:49.591Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-09-22T15:01:54.526Z
---
