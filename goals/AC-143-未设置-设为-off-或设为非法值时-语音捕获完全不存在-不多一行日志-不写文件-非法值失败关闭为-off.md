---
id: AC-143
title: 未设置、设为 off 或设为非法值时，语音捕获完全不存在：不多一行日志、不写文件，非法值失败关闭为 off
status: achieved
kind: criterion
goal: GOAL-010
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice/tests/voice-capture-off.test.ts
expect: 环境变量 VOICE_CAPTURE 未设置、为
  off、或为无法识别的值三种情形下，对同一份录音各做一次成功与一次失败的转写：日志行数与内容和没有捕获功能时的基线逐字节相同，不出现
  voice.capture 行，voice.transcribe 行不带 captureId，音频目录不被创建；无法识别的值在启动时打一行警告并按 off
  处理；启动行 voice.capture mode=<模式> 读出生效模式，三种情形分别读到 off。正例：同一测试里 text
  档对同样输入必须出现捕获行，证明这里的零不是空实现的零。取假形态：(1) 不看模式一律记录 ⇒ 必须红；(2) 无法识别的值当作 text ⇒ 必须红。
origin: docs/proposals/voice-capture-server-side.md（2026-09-24 人 yale 裁定：三档
  off/text/audio、只在服务端配置、默认 off、无保留期与大小限制、音频目录不清理、AC-141 的转写正文条款错误需修订）
activatedAt: 2026-09-24T11:20:16.514Z
statusLog:
  - at: 2026-09-24T11:20:16.514Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-24T11:56:13.995Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T11:20:16.514Z
---
