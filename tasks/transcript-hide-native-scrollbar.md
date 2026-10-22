---
id: transcript-hide-native-scrollbar
title: AC-215 隐藏转录区原生滚动条：只剩自绘轨道一条滚动条，滚轮/触摸/键盘滚动与贴底行为不变
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - transcript-global-scrollbar-track
goal_ac: AC-215
---
## Proposal

现状：自绘全局滚动条交付后，转录滚动容器（`.chat-messages-pane`）的原生滚动条仍在，两条并存。人 yale 裁定（2026-10-04）隐藏窗口内部的原生滚动条。

要做的事：用 CSS 隐藏原生滚动条（`scrollbar-width: none` 加 `::-webkit-scrollbar { display: none }`），不得用 `overflow: hidden`（会让滚轮与触摸失效）。隐藏后容器的 offsetWidth − clientWidth 为 0，自绘轨道不得遮挡最后一列文本（轨道占用自己的列或透明边距，由实现裁定并写入证据）。全局 CSS 层叠有大量高风险规则（仓库有 CSS 层叠审计记录），改动只作用于转录容器选择器，并检查是否有后加载规则覆盖它。保留 `Scroll to bottom` 按钮与贴底、跟随、离开底部不被拉回的既有行为（AC-106 至 AC-111 的判据保持绿）。

## Plan

1. 先写判据文件 `e2e/transcript-global-scrollbar.spec.ts` 的 AC-215 用例（两种视口 1440×900 与 390×844；读 offsetWidth/clientWidth、滚轮/触摸/键盘滚动、DOM 注入长高、轨道与文本包围盒不相交、ARIA）。先看它红。
2. 在转录容器上加隐藏规则（index.css 或该容器已有的样式位置，按现有约定）。
3. 窄屏确认触屏仍可拖动轨道。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-global-scrollbar.spec.ts -g "AC-215"` 退出 0。红态基线：该用例不存在（文件由前置任务创建，用例由本任务追加）。
- [x] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) 用 overflow:hidden 隐藏 ⇒ 滚轮可滚断言红；(b) 轨道盖住文字 ⇒ 包围盒断言红；(c) 不隐藏 ⇒ 两条滚动条并存断言红。
- [x] AC3 既有跟随不回退：`npx playwright test e2e/transcript-follow.spec.ts` 保持绿（AC-106 至 AC-111），逐字写下读数；`e2e/transcript-jump-to-turn.spec.ts` 与 AC-214 用例保持绿。
- [x] AC4 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 两种视口都只剩自绘轨道一条滚动条，原生滚动能力完整保留。
- 判据里有「用 overflow:hidden 实现」的负对照且必须红。
- 只动 `## Touches` 列出的文件。

## Touches

- src/index.css
- e2e/transcript-global-scrollbar.spec.ts
- tasks/transcript-hide-native-scrollbar.md
