---
id: AC-145
title: audio 档把上传的录音原样写成文件并在捕获行给出路径与 sha256；text 档不写文件；不做清理
status: achieved
kind: criterion
goal: GOAL-010
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice/tests/voice-capture-audio.test.ts
expect: VOICE_CAPTURE=audio 下，一次成功转写后在 VOICE_CAPTURE_DIR 指定的目录（未设置时为与数据库同级的
  voice-capture 目录）生成一个文件，其字节与上传逐字节相同，其 sha256 与 voice.capture
  行中的一致，行中给出该文件路径，目录权限为 0700、文件权限为 0600；连续多次转写后文件逐次累积，没有任何一个被删除。同样输入在 text
  档不产生任何文件。取假形态：(1) text 档也写文件 ⇒ 必须红；(2) 写入的内容被改动（重编码或截断）⇒ 必须红；(3) 文件权限宽于 0600 ⇒
  必须红。
origin: docs/proposals/voice-capture-server-side.md（2026-09-24 人 yale 裁定：三档
  off/text/audio、只在服务端配置、默认 off、无保留期与大小限制、音频目录不清理、AC-141 的转写正文条款错误需修订）
activatedAt: 2026-09-24T11:21:56.214Z
statusLog:
  - at: 2026-09-24T11:21:56.214Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-27T04:43:23.502Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T11:21:56.214Z
---
