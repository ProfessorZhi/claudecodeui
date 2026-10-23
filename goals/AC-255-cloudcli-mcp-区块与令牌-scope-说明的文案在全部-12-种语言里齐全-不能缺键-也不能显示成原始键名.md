---
id: AC-255
title: CloudCLI MCP 区块与令牌 scope 说明的文案在全部 12 种语言里齐全，不能缺键，也不能显示成原始键名
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in
  src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx vitest run
  src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts
expect: 做法照 AC-229：遍历 `locales/*/settings.json` 的 glob，不硬编码语言清单。读数：(a) 每种语言都含
  `mcp` 命名空间下由测试内常量声明的必需键（区块标题、端点、已启用、未启用、接入命令说明、五个 scope
  的名称与说明、写权限风险提示），值为非空字符串且不等于键名；(b) 各语言的键集合与 `en` 完全一致；(c) 同一次运行里对缺键合成 bundle
  的正例对照。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 删掉任一语言的一个键 ⇒ (a) 与 (b)
  必须红；(ii) 值写成键名本身 ⇒ (a) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:17:06.611Z
statusLog:
  - at: 2026-10-05T02:17:06.611Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T05:23:38.469Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:17:06.611Z
---
