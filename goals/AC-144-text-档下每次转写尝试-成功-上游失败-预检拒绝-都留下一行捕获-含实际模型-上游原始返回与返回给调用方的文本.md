---
id: AC-144
title: text 档下每次转写尝试（成功、上游失败、预检拒绝）都留下一行捕获，含实际模型、上游原始返回与返回给调用方的文本
status: achieved
kind: criterion
goal: GOAL-010
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice/tests/voice-capture-text.test.ts
expect: VOICE_CAPTURE=text 下，一次成功与一次上游失败（重放 2026-09-24 的 dashscope 事件：上游 404
  加错误体）各产生一行 voice.capture，为单行 JSON，其 captureId 与同一次 voice.transcribe 行一致。成功行含
  providerId、实际使用的 model（用户未填模型时为适配器声明的缺省而非共享 sttModel）、地址主机名、上传的
  mime、bytes、sha256、上游 status、上游原始返回文本逐字（含 transcript 与 instruction
  两份）、结果分支与返回给调用方的 text；失败行含上游 status 与原始错误体。被预检拒绝的尝试（不受支持的容器）也有一行，upstream 为
  null。行内不出现上游请求体与任何请求头；不创建任何文件；原始返回超过 64 KB 时截断并带 truncated
  标记，未超限时不带该标记。取假形态：(1) 只记最终 text 不记原始返回 ⇒ 必须红；(2) 失败尝试不记 ⇒ 必须红；(3)
  不截断，或对未超限的也标记截断 ⇒ 必须红。
origin: docs/proposals/voice-capture-server-side.md（2026-09-24 人 yale 裁定：三档
  off/text/audio、只在服务端配置、默认 off、无保留期与大小限制、音频目录不清理、AC-141 的转写正文条款错误需修订）
activatedAt: 2026-09-24T11:21:00.324Z
statusLog:
  - at: 2026-09-24T11:21:00.324Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-24T12:30:14.544Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T11:21:00.324Z
---
