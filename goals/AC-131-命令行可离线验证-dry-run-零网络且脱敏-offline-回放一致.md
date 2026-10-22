---
id: AC-131
title: 命令行可离线验证：--dry-run 零网络且脱敏，--offline 回放一致
status: achieved
kind: criterion
goal: GOAL-008
criterion: node scripts/asr-cli-offline-check.mjs
expect: 断言 --dry-run 在禁止联网的 fetch 替身下不发生任何调用，且其输出不含密钥与音频字节；断言 --offline
  读录制响应产出的文本与录制一致；断言 CLI 以 tsx 启动（从启动方式判定）。取假形态：(1) --dry-run 实际发出请求（替身记录到调用）⇒
  必须红；(2) 脱敏只脱密钥不脱音频 ⇒ 必须红；(3) --offline 实际联网 ⇒ 必须红。
origin: ADR-004 决策 2 约束 2（实测：.js 说明符在裸 node 下 ERR_MODULE_NOT_FOUND，npx tsx
  通过）与决策 8（联网「真跑」不判据化）。
activatedAt: 2026-09-22T15:01:52.206Z
statusLog:
  - at: 2026-09-22T15:01:52.206Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-22T17:15:27.563Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-09-22T15:01:52.205Z
---
