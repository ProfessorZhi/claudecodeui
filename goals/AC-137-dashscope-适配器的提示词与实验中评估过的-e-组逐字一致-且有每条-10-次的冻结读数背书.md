---
id: AC-137
title: DashScope 适配器的提示词与实验中评估过的 E 组逐字一致，且有每条 ≥10 次的冻结读数背书
status: achieved
kind: criterion
goal: GOAL-009
criterion: node scripts/asr-omni-prompt-frozen-check.mjs
expect: 读取 dashscope-omni 适配器导出的 ROLE、RULES、EXAMPLES、JSON_TASK、reasoning_effort
  与默认模型，和冻结实验快照中 E 组 provenance 逐字比较，必须全部相等；快照中 C 组与 E 组各 8 条片段、每条 ≥10
  次读数、全部来自同一个 run id。取假形态：(1) 适配器提示词改动一个字 ⇒ 必须红并指名是哪一段；(2) 快照中 E 组任一片段少于 10 次 ⇒
  必须红；(3) 快照缺失 ⇒ 必须红而不是跳过。
origin: docs/proposals/voice-dashscope-omni-written-instruction.md（2026-09-24 人
  yale 裁定：E 组提示词定型；key 由用户提供；书面指令进 composer；本轮不改输入体验）
activatedAt: 2026-09-24T02:55:59.788Z
statusLog:
  - at: 2026-09-24T02:55:59.788Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-24T03:28:54.057Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-24T02:55:59.788Z
---
