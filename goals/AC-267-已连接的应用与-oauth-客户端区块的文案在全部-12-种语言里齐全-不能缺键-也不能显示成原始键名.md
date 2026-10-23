---
id: AC-267
title: 已连接的应用与 OAuth 客户端区块的文案在全部 12 种语言里齐全，不能缺键，也不能显示成原始键名
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in
  src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx vitest run
  src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts
expect: 做法照 AC-229。读数：(a) 每种语言都含必需键常量声明的 `connectedApps` 与 `oauthClients`
  命名空间键，值非空且不等于键名；(b) 各语言键集合与 `en` 一致；(c) 缺键合成 bundle 的正例对照。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 删掉某语言的一个键 ⇒ (a) 与 (b) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1
  输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:22:52.168Z
statusLog:
  - at: 2026-10-05T02:22:52.168Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:25:57.317Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:22:52.168Z
---
