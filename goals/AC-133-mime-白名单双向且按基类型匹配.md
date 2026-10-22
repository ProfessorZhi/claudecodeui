---
id: AC-133
title: MIME 白名单双向且按基类型匹配
status: achieved
kind: criterion
goal: GOAL-008
criterion: node scripts/asr-mime-allowlist-check.mjs
expect: 断言白名单双向：白名单内绿、白名单外红且返回不支持 MIME 的语义码、且拒绝发生在读取上游之前（上游调用次数为 0）；断言带参数的
  MIME（audio/webm;codecs=opus）与裸基类型（audio/webm）都被判为受支持；断言两条路径产出同一个语义码。取假形态：(1)
  白名单恒拒 ⇒ 「内绿」那一半必须红；(2) 按精确串匹配 ⇒ 带参数的用例必须红（那是出货录音器自己的输出）；(3) 只改代理路径 ⇒
  「同码」那一半必须红。
origin: ADR-004 决策 4 缺口一；浏览器 MIME_CANDIDATES 首项带参数（audio/webm;codecs=opus），服务商公布的是基类型。
activatedAt: 2026-09-22T15:01:53.725Z
statusLog:
  - at: 2026-09-22T15:01:53.725Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-23T05:03:03.098Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-09-22T15:01:53.724Z
---
