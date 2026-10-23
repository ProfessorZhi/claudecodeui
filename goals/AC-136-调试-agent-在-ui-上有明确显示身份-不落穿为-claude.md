---
id: AC-136
title: 调试 Agent 在 UI 上有明确显示身份，不落穿为 Claude
status: achieved
kind: criterion
goal: GOAL-007
criterion: npx vitest run src/shared/tests/debug-agent-display-identity.test.ts
expect: 裁决 A（ADR-003 决策 2）：运行期 provider id **刻意不进 `LLMProvider` 联合**，故 UI
  侧不存在编译期强制点——它只能靠**显式显示身份**，否则 `LLMProviderLogo` 会落穿到末尾的 claude 分支，用户看到的是**错标为
  "Claude"**（不是缺标：功能全绿，只有一个错误的标签）。本判据对一处**构造出的侧栏会话视图**断言并打印实际读数：(1)
  提供商文字位**非空**且**逐字不等于 "Claude"**；(2) `LLMProviderLogo` 对该 id **不落穿**到 claude
  分支（其形态与 claude
  分支可区分）。取假形态：**不给它显示身份（保持落穿）**时本判据必须红——该失败是静默的，正是本条存在的理由。命令必须逐字含文件路径，不得用
  glob。当前必红：该测试文件不存在。
origin: ADR-003 评审裁决 A 与决策 2；人 yale 2026-09-22
  裁定另立（gap-goal-007-exit-conditions-section 的 Resolution）。
activatedAt: 2026-09-22T15:43:51.544Z
statusLog:
  - at: 2026-09-22T16:01:49.928Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
