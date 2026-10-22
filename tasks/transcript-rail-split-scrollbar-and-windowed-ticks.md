---
id: transcript-rail-split-scrollbar-and-windowed-ticks
title: AC-217 刻度与滚动条拆成两个部件：固定尺寸窗口化刻度列 + 独立的浅灰滚动条，快速设置把手左移上移让开
status: done
labels:
  - gap
  - priority:p1
  - delivery-critical
parent: null
children: []
extra:
  deliveryCriticalSource: adhoc
depends_on: []
goal_ac: AC-217
---
## Proposal

现状读数（2026-10-04，读 `src/modules/chat/transcript/TranscriptTurnRail.tsx`、`QuickSettingsHandle.tsx`、`useQuickSettingsDrag.ts` 与用户的三张对照截图）：

1. **刻度铺满整条轨道。** 每个用户轮次渲染一个 `<button>`，样式 `flex: 1 1 0; minHeight: 0`，把几乎整高（`top-4 bottom-4`）的轨道平分。轮次少时是一百多像素高的胖胶囊，轮次多时（1200 轮在约 1000px 里）每个不到 1px、糊成一道实线；1200 个按钮各带三个事件处理器。为了在亚像素刻度上点准，实现里叠了 `turnAt` 二分查找与 `turnAtFraction` 两套「指针→轮次」映射。
2. **导航与位置合成了一个控件。** 当前轮刻度被涂成主题蓝，同时又有一个固定 40px 的滑块表示位置，两个「当前位置」指示叠在同一个 16px 宽的 `nav` 里。
3. **快速设置把手盖在滚动条列上。** `QuickSettingsHandle` 是 `fixed right-0 z-50`，纵向位置是视口高度的百分比（默认 50%，范围 10%–90%，存 localStorage，可拖动），所以它必然在某个高度盖住最右侧的滚动条，并可能压住刻度。
4. 对照 DeepSeek：刻度是 8×2 CSS px 的固定短线（当前轮 12×3、蓝色），间距约 30px，居中，列容器约 300px 高、只渲染窗口内的条目（本身可滚动）；滚动条是最右侧另一个浅灰窄滑块，无箭头无轨道底色；内容、刻度列、滑块三列互不覆盖。

人 yale 2026-10-04 裁定：把刻度与滚动条拆成两个部件；快速设置把手「左移让开滚动条，上移到导出按钮下方让开刻度」；改写 AC-213/AC-214 中与整高轨道绑定的读数；补视觉形态 AC-217。

要做的事：

**A. 刻度列（导航）**：新组件 `TranscriptTurnTicks`。固定尺寸短线（普通 8×2、当前 12×3，间距 30px，整列居中于转录视口、高度 ≤300px）。只渲染当前轮附近的窗口（容量 = 列高 / 间距，≤11 个），由纯函数 `visibleTickWindow(turns, currentIndex, scrollOffset, capacity)` 计算（便于单测）；当前轮落在窗口中偏下处（参照 DeepSeek 的「第 4/5 条」）。列本身可滚动：鼠标滚轮停在刻度列上时滚动的是这组短线（用非 passive 的原生 wheel 监听并阻止冒泡到转录，因为 React 的 onWheel 是 passive，`preventDefault` 无效），上下方向键同理；转录的当前轮变化或发生跳转时，窗口重新跟随当前轮。悬停或聚焦某条刻度，在其左侧浮出摘要与时间（沿用现有预览）。点击刻度直接跳转（`jumpToMessage` 通道不变）。静止时只有当前刻度使用主题色，其余为中性灰。删除 `turnAt` 二分与按比例点击映射——刻度已是固定尺寸的真按钮，不再需要。窄屏（无 hover）不渲染刻度列，滑块仍在。轮次少于 3 时两者都不渲染。

**B. 滚动条（位置）**：新组件 `TranscriptScrollbar`，独立于刻度列（`[data-scrollbar-track]` 不是刻度列的祖先或后代），位于转录区最右侧。浅灰中性色、约 8 CSS px 宽、全圆角、无箭头、无轨道底色，平时淡出，悬停、拖动、键盘聚焦时加深或加宽。位置语义不变（当前轮序号 / 最后一轮序号，拖动只对最终位置取页一次，`role="scrollbar"` 与 aria 值、Home/End/PageUp/PageDown/方向键保持）。长度改为 `clamp(可见消息数 / 总消息数 × 轨道高度, 28px, 轨道高度 × 25%)`，不再写死 40px；「可见消息数」按转录里当前与视口相交的行所代表的消息数计（工作段按其成员数），由实现者给出并写明取法。点击滑块自己的轨道空白处跳到对应位置；点击刻度列不移动滑块。

**C. 组合与布局**：`TranscriptTurnRail.tsx` 保留为组合容器，挂载 A 与 B 并保证三列互不覆盖：转录内容右边缘与刻度列间距 ≥16px，刻度列与滑块间距 ≥16px。

**D. 快速设置把手让开**：(1) 左移：关闭态把手右边缘 ≤ 滑块左边缘 − 4px（即把手不再 `right-0` 盖住滚动条列；抽屉打开的 `right-64` 态行为不变）；(2) 上移：把手允许的纵向带 = [导出按钮包围盒底 + 8px, 刻度列顶 − 8px]；默认位置取带顶；localStorage 中已保存的越界位置在读取时夹回带内（并写回），用户拖动超出带时松手夹回；窄屏（以 `bottom` 定位）下把手不与导出按钮和滑块相交；转录少于 3 轮（无刻度列、无滑块）时带只受导出按钮约束。(3) 模块边界：`quick-settings-panel` 与 `chat` 两个模块互不深入导入对方；二者的耦合只经 `src/shared`：新增 `src/shared/transcriptEdgeLayout.ts`，导出列宽与间距常量，以及一对 `publishTranscriptEdgeBand` / `readTranscriptEdgeBand`（chat 把带的上下沿与滑块左沿发布成 documentElement 上的 CSS 自定义属性，把手读取并订阅其变化；resize 与会话切换时重发）。

不在本任务内：服务端、store、预取、搜索跳转；隐藏原生滚动条（已落地，AC-215 必须保持绿）。

## Plan

1. 先写判据：新建 `e2e/transcript-rail-geometry.spec.ts`（用例标题含 `AC-217`），按 AC-217 的 (a)–(h) 在 1440×900、1024×700、390×844 三种视口与 1200 轮 / 5 轮夹具上读数；改写 `e2e/transcript-jump-to-turn.spec.ts` 与 `e2e/transcript-global-scrollbar.spec.ts` 里 AC-213 / AC-214 的用例，标题改为 `AC-213 v2` / `AC-214 v2`（判据串按标题过滤，旧标题不含 `v2`）。先看三者红。5 轮夹具需要一个独立种子：若 `playwright.config.ts` 无现成的短会话种子，复用 `transcript-follow` 的 24 条种子（其中用户轮次数按实际读出并写入证据），不要新增种子。
2. 纯函数与单测：`src/modules/chat/utils/turnTickWindow.ts (new)` 的 `visibleTickWindow` 与 `src/modules/chat/tests/turnTickWindow.test.ts (new)`；把手夹取的纯函数与 `src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts (new)`。
3. 实现 `TranscriptTurnTicks`、`TranscriptScrollbar`，改 `TranscriptTurnRail` 为组合；`useTurnNavigation` 提供窗口所需的当前轮序与滚动偏移；`ChatMessagesPane` 挂载并给导出按钮容器打上可读的定位锚点；删除 `turnAt` 与比例点击映射。
4. 实现 `transcriptEdgeLayout.ts` 与把手侧的读取、夹取、左移；保持把手既有的拖动与抽屉行为。
5. 跑守卫：AC-215、AC-216、AC-213 v2、AC-214 v2、`e2e/transcript-follow.spec.ts` 全部绿；`npx vitest run src/modules/chat/tests/chatTurnRailCompleteness.test.ts` 绿（不新增 i18n 键；若必须新增，先把全部 12 个语言的 chat.json 加进 `## Touches` 再写）。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-rail-geometry.spec.ts -g "AC-217"` 退出 0。红态基线：spec 文件不存在，playwright 报 No tests found。
- [x] AC2 改写后的 AC-213 判据绿：`npx playwright test e2e/transcript-jump-to-turn.spec.ts -g "AC-213 v2"` 退出 0。红态基线：现有用例标题不含 `v2`，No tests found。
- [x] AC3 改写后的 AC-214 判据绿：`npx playwright test e2e/transcript-global-scrollbar.spec.ts -g "AC-214 v2"` 退出 0。红态基线：同上。
- [x] AC4 既有守卫不回退，逐字写下各自读数：`npx playwright test e2e/transcript-global-scrollbar.spec.ts -g "AC-215"`、`npx playwright test e2e/transcript-prefetch.spec.ts -g "AC-216"`、`npx playwright test e2e/transcript-follow.spec.ts`（AC-106 至 AC-111）均退出 0。
- [x] AC5 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(a) 刻度恢复 `flex:1 1 0` 铺满整条 ⇒ AC-217 (a)(b)(c) 红；(b) 全部轮次都渲染成按钮 ⇒ AC-217 (a) 与 AC-213 v2 (a) 红；(c) 把手恢复 `right-0` 与 50% ⇒ AC-217 (e)(f) 红；(d) 当前刻度与滑块都用主题色 ⇒ AC-217 (d) 红；(e) 把手只改默认值、不夹取已保存位置 ⇒ AC-217 (g) 红；(f) 滑块长度写死 40px ⇒ AC-214 v2 (f) 红；(g) 滚轮停在刻度列上却滚动了转录 ⇒ AC-213 v2 (b) 红。
- [x] AC6 单测绿：`npx vitest run src/modules/chat/tests/turnTickWindow.test.ts src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts src/modules/chat/tests/chatTurnRailCompleteness.test.ts` 退出 0；`visibleTickWindow` 覆盖：总轮次 < 容量、当前轮在两端、滚动偏移越界被夹取、轮次追加时窗口稳定。
- [x] AC7 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 读数全部来自我们自绘的元素（Playwright 默认带 `--hide-scrollbars`，原生滚动条的布局读数在 e2e 里恒为 0，不得拿它当证据）。
- 刻度列渲染的按钮数不随总轮次增长（1200 轮 ≤11），`turnAt` 二分与按比例点击映射已删除，不存在两套「指针→轮次」映射。
- 滚动条与刻度列是两个独立部件，各自的 DOM 不嵌套；静止时整个区域只有当前刻度一个主题色元素。
- 把手左移让开滚动条、纵向被夹在导出按钮下沿与刻度列上沿之间；已保存的越界位置、拖出带外、窄屏三种输入都有真实浏览器读数。
- 滚轮停在刻度列上不滚动转录，且不触发会话取页（读网络层计数）。
- 模块边界：`quick-settings-panel` 与 `chat` 之间无互相导入，只经 `src/shared/transcriptEdgeLayout.ts` 通信。
- 新增的测试文件对其他模块只经其 barrel（`src/modules/<module>/index.ts`）导入，对 `src/shared` 用 `@/shared/...`；否则 suite 的 lint 步骤（oxlint `boundaries/dependencies`）会红，而只跑自己测试文件的 worker 看不到。若实现被迫写 `## Touches` 之外的文件，先用 task_write 把它加进 Touches 再写。
- 遵守 `frontend-module-standards`（`.agents/skills/frontend-module-standards/SKILL.md`）：`@/` 导入、`type` 不用 `interface`、`import type`、导出组件带消费方注释；只动 `## Touches` 列出的文件。

## Touches

- src/modules/chat/transcript/TranscriptTurnRail.tsx
- src/modules/chat/transcript/TranscriptTurnTicks.tsx (new)
- src/modules/chat/transcript/TranscriptScrollbar.tsx (new)
- src/modules/chat/utils/turnTickWindow.ts (new)
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/quick-settings-panel/QuickSettingsHandle.tsx
- src/modules/quick-settings-panel/hooks/useQuickSettingsDrag.ts
- src/modules/quick-settings-panel/QuickSettingsPanelView.tsx
- src/shared/transcriptEdgeLayout.ts (new)
- src/modules/chat/tests/turnTickWindow.test.ts (new)
- src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts (new)
- e2e/transcript-rail-geometry.spec.ts (new)
- e2e/transcript-jump-to-turn.spec.ts
- e2e/transcript-global-scrollbar.spec.ts
- src/index.css
- .oxlintrc.json
- tasks/transcript-rail-split-scrollbar-and-windowed-ticks.md
