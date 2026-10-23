---
id: AC-141
title: DashScope 的 key 与地址由用户提供并存于服务端设置；健康检查反映之；key 不回显不入日志；与 TTS 凭据分离
status: achieved
kind: criterion
goal: GOAL-009
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice/tests/voice-dashscope-settings.test.ts
expect: 不设任何服务端环境变量：用户未填写时健康检查 providers 中 dashscope-omni 的 configured 为假，保存 key
  与地址后为真；读取设置时 key 以掩码返回；一次成功与一次失败的转写之后，服务端日志中不含 key 明文与转写正文；TTS 请求仍使用原有的
  baseUrl 与 apiKey。取假形态：(1) key 明文回显 ⇒ 必须红；(2) 只看环境变量判定 configured ⇒ 必须红。
origin: docs/proposals/voice-dashscope-omni-written-instruction.md（2026-09-24 人
  yale 裁定：E 组提示词定型；key 由用户提供；书面指令进 composer；本轮不改输入体验）
activatedAt: 2026-09-24T03:01:23.900Z
statusLog:
  - at: 2026-09-24T03:01:23.900Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-24T07:51:45.426Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T03:01:23.900Z
---
