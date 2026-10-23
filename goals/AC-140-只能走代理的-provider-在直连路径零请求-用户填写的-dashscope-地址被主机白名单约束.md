---
id: AC-140
title: 只能走代理的 provider 在直连路径零请求；用户填写的 DashScope 地址被主机白名单约束
status: achieved
kind: criterion
goal: GOAL-009
criterion: node scripts/asr-proxy-only-ssrf-check.mjs
expect: 生效 provider 的 transport 为 proxy-only 时，即使浏览器侧配置了 baseUrl，直连路径零请求，请求发往
  /api/voice/transcribe 并带 x-voice-provider；服务端对用户填写的 DashScope 地址，凡非
  https、主机名不匹配 maas.aliyuncs.com 工作空间形态且不等于 dashscope.aliyuncs.com、带端口或用户信息的（如
  evil.example.com、aliyuncs.com.evil.com、127.0.0.1），一律返回 INVALID_BASE_URL
  且上游调用次数为 0；白名单内的合法工作空间地址放行（阳性对照）。取假形态：(1) 去掉主机校验 ⇒ 必须红；(2) 忽略 proxy-only 仍直连 ⇒
  必须红。
origin: docs/proposals/voice-dashscope-omni-written-instruction.md（2026-09-24 人
  yale 裁定：E 组提示词定型；key 由用户提供；书面指令进 composer；本轮不改输入体验）
activatedAt: 2026-09-24T02:59:36.066Z
statusLog:
  - at: 2026-09-24T02:59:36.066Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-24T07:24:45.906Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T02:59:36.066Z
---
