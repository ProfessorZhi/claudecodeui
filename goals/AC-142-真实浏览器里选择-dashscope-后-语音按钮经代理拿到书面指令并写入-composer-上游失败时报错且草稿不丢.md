---
id: AC-142
title: 真实浏览器里选择 DashScope 后，语音按钮经代理拿到书面指令并写入 composer；上游失败时报错且草稿不丢
status: achieved
kind: criterion
goal: GOAL-009
criterion: npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"
expect: 在设置页选择 DashScope 并填入 key 与地址；拦截 /api/voice/transcribe 返回 style 为 written
  的信封，断言该请求带 x-voice-provider 为 dashscope-omni、且页面没有向任何 aliyuncs.com
  主机发出请求；点语音按钮录音后 composer 出现信封中的书面指令文本；拦截返回上游 403 语义错误时 UI 显示错误且 composer
  中已有草稿保持不变。取假形态：前端忽略 proxy-only 而直连 ⇒ 必须红。
origin: docs/proposals/voice-dashscope-omni-written-instruction.md（2026-09-24 人
  yale 裁定：E 组提示词定型；key 由用户提供；书面指令进 composer；本轮不改输入体验）
activatedAt: 2026-09-24T03:03:54.307Z
statusLog:
  - at: 2026-09-24T03:03:54.307Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-24T08:29:46.424Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T03:03:54.307Z
---
