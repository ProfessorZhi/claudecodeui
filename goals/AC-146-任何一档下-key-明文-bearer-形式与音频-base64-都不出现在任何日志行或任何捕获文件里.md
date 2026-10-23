---
id: AC-146
title: 任何一档下，key 明文、Bearer 形式与音频 base64 都不出现在任何日志行或任何捕获文件里
status: achieved
kind: criterion
goal: GOAL-010
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice/tests/voice-capture-secrets.test.ts
expect: 在 off、text、audio 三档下各做一次成功与一次失败的转写：DashScope key 哨兵、共享 backend key
  哨兵、Bearer 加 key 的形式、上传录音的 base64
  编码，都不出现在任何日志行与任何捕获文件里；而这些值确实经过了传输层（正例：替身上游收到的请求头与请求体含它们），所以这里的不出现是一次区分而不是从未存在。取假形态：(1)
  把请求头记进捕获 ⇒ 必须红；(2) 把音频 base64 记进捕获行 ⇒ 必须红。
origin: docs/proposals/voice-capture-server-side.md（2026-09-24 人 yale 裁定：三档
  off/text/audio、只在服务端配置、默认 off、无保留期与大小限制、音频目录不清理、AC-141 的转写正文条款错误需修订）
activatedAt: 2026-09-24T11:22:45.792Z
statusLog:
  - at: 2026-09-24T11:22:45.792Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-27T16:04:09.674Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T11:22:45.792Z
---
