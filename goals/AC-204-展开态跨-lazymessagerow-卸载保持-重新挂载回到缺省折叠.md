---
id: AC-204
title: 展开态跨 LazyMessageRow 卸载保持，重新挂载回到缺省折叠
status: achieved
kind: criterion
goal: GOAL-016
criterion: npx vitest run src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx
expect: 两个读数：(i) 展开某一段 ⇒ 该行滚出视口（触发 LazyMessageRow 的卸载与占位）⇒ 滚回 ⇒ 仍是展开态、成员可见；(ii)
  整个 pane 重新挂载 ⇒ 该段回到缺省折叠（缺省是折叠，不是记住上次）。取假形态：把展开态改回段组件内部的 useState ⇒ 卸载即丢，(i)
  必须红；把缺省值改成展开 ⇒ (ii) 必须红。
origin: 同 AC-202。人 2026-10-02 明确裁定「段缺省即折叠，用户展开过就保持展开，结束不要动」——这条与 LazyMessageRow
  的卸载策略直接冲突（src/modules/chat/transcript/LazyMessageRow.tsx），故单列一条常驻判据。
activatedAt: 2026-10-01T16:35:34.966Z
statusLog:
  - at: 2026-10-02T04:30:37.630Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
