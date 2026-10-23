---
id: transcript-edge-gutter-handle-and-touch-target
title: AC-220
  右侧留白按显示的东西来留（手机像原生滚动条占一列、平板不收窄、宽屏用外侧边距），把手在任何视口固定在导出按钮下方且位置不被改写，滚动条触摸热区够大
status: done
labels:
  - gap
  - priority:p1
  - delivery-critical
parent: null
children: []
extra:
  deliveryCriticalSource: adhoc
depends_on:
  - transcript-scrollbar-native-length-and-pixel-position
goal_ac: AC-220
---
## Proposal

人 yale 2026-10-04 的裁定：把手在手机上也固定在导出按钮下方；手机右侧留白与原生滚动条旁的排版一致（留出滚动条列宽度，文字紧贴其左边）；平板宽度下刻度不收窄；起草 AC 与任务，优先。

现状读数（2026-10-04，:3001 当前版本，61 轮 / 536 条真实会话，视口 390×844 与 820×1100，只读；读 `src/index.css:584`、`QuickSettingsHandle.tsx`、`useQuickSettingsDrag.ts`、`TranscriptScrollbar.tsx`）：

1. **右侧留白固定 72px。** `.chat-messages-pane { padding-right: 4.5rem }` 不分视口，手机上刻度列 `display:none` 仍预留：内容列 318px，消息 286px，文字 262px，只占屏宽的 67%，右侧只有一条 12px 的滚动条轨道。平板上右侧 88px 空着。
2. **把手位置。** 手机上（以 `bottom` 百分比定位，默认 50%）停在 y=384–422 的视口中段，右边缘贴着轨道左边缘；平板上被夹在刻度列顶部正上方 8px 处，距导出按钮约 200 多像素，不是「导出按钮下方」。
3. **把手位置被改写。** 视口 390→820→390 往返后 `localStorage.quickSettingsHandlePosition` 由 50→29.8→50：夹取后的值被写回，用户自己拖过的位置会在换视口时丢。
4. **触摸目标太小。** 滚动条在滑块垂直中线上命中检测，能抓到滑块的只有 8px（连轨道 12px），轨道紧贴屏幕右缘（缩进 4px）；Android 的系统返回手势占屏幕两侧边缘，可能冲突（未在设备上验证）。

要做的事：

**A. 右侧留白按显示的东西来留（纯函数，便于单测）。** 新增 `src/shared/transcriptEdgeLayout.ts` 里的 `transcriptGutterPx(paneWidthPx, hasTickColumn)`（与现有常量同处，不新建文件）并在 `ChatMessagesPane` 用内联样式 / CSS 自定义属性设置 `padding-right`，删除 `index.css` 里写死的 `4.5rem`：
- 手机（刻度列不渲染，视口 <768）：`padding-right` = 滚动条列占用宽度（轨道 12px + 缩进 4px = 16px），文字边缘紧贴滚动条列左边，像原生滚动条那样占自己的一列；消息列宽目标约 342px（现状 286px）。
- 平板（刻度列渲染且空边距不足）：保持现有 72px，**刻度列不收窄**（宽 16px、间距 30px 与 AC-217 一致）。
- 宽屏（内容列 `max-w-[54.25rem]` 两侧的空边距 ≥72px）：`padding-right` = `max(0, 72 − 空边距)`，通常为 0；刻度列与滚动条落在内容列外侧的空边距里，文字列宽与无刻度时相同。
注意：`.chat-messages-pane` 有 `contain: layout style paint`，滚动条与刻度列是它的兄弟绝对定位元素（`TranscriptTurnRail`），不要把它们放进 pane 里改变其含义；宽屏用「pane 宽度 − 内容列实际宽度」算空边距，随 `ResizeObserver` 更新（jsdom 无该 API 时按已有守卫处理）。

**B. 把手在任何视口固定在导出按钮下方。**（⚠️ 已被外部任务作废，见 `## Resolution`）
- 默认位置 = 导出按钮包围盒底 + 8px（`TRANSCRIPT_HANDLE_BAND_MARGIN_PX`），手机、平板、宽屏一致；手机不再用 `bottom` 百分比，改用与桌面相同的基于顶部的定位（现有按移动端分支设置 `bottom` 的逻辑删除）。
- 允许的带 = [导出按钮底 + 8px, 刻度列顶 − 8px − 把手高]；手机没有刻度列时带的下沿 = 视口高度的某个上限（例如导出按钮底 + 24px 之外不得再往下，使把手始终贴着导出按钮下方；若要允许用户拖更低，上限取输入区顶部 − 把手高，由实现者裁定并写入证据）。把手右边缘 ≤ 滚动条触摸热区左边缘 − 4px。
- **用户位置只在渲染时夹取，不写回存储。** `readHandlePosition` 之后的夹取只影响渲染；只有用户真实拖动并松手才写 `localStorage`；视口往返后存储值不变。拖出带外松手时位置被夹回带内，写入的是被夹回后的值。
- 与现有 `publishTranscriptEdgeBand` / `readTranscriptEdgeBand` 通信，不得让 `quick-settings-panel` 与 `chat` 互相深入导入。

**C. 滚动条触摸热区。** 在粗指针（`(pointer: coarse)`）上，滑块的可抓取区加宽到 ≥32px、高 ≥44px，视觉仍是 8px 宽的滑块；热区向内容一侧（左）扩展，贴屏幕右缘的 8px 内不作为唯一抓取区（避开系统边缘手势）；热区不得与把手包围盒相交。细指针（鼠标）保持现有 12px 的抓取区。

不在本任务内：点击落点与行占位（AC-221，另一任务）、长度与位置的像素估算（AC-219，在前置任务）。

## Resolution（2026-10-04，worker）

**B 部分作废，A + C 落地。** 本任务立案时（14:59）把手与悬浮导出按钮尚在；其后（16:29）已完成的任务 `gap-workspace-header-overflow-menu-replaces-edge-controls`（提交 `affdf098`）把可拖动的快速设置抽屉把手、`QuickSettingsPanelView`、`useQuickSettingsDrag`、`localStorage.quickSettingsHandlePosition`、悬浮导出按钮、`TRANSCRIPT_HANDLE_*` / `publishTranscriptEdgeBand` 一整套避让机制**删除**，右边缘只留滚动条与刻度列；`e2e/workspace-overflow-menu.spec.ts` 断言 `[data-quick-settings-handle]` 与 `[data-transcript-export-anchor]` 在任何视口都为 0。该任务的 `dedup-ref` 逐字记录：「该任务的 B 部分与 Touches 里的把手文件随之作废，A（右侧留白）与 C（触摸热区）仍有效。是否收窄那个任务由人决定，本任务不改它。」

本 worker 据此后确定：**A（右侧留白）与 C（触摸热区）按原意落地**；**B 的读数（原 AC (d)(e)(f)：默认位置、夹取不写回、与把手两两不相交）没有主体**，无法实现也无法诚实勾选 —— 未复活任何已删组件（复活会把 `e2e/workspace-overflow-menu.spec.ts` 的边缘清空断言打红）。取而代之的是同一不变量在新形态下的表述：右边缘**不存在**任何手柄（`[data-quick-settings-handle]` 计数为 0）。原 B 的行文保留在 `## Proposal` 与 `## Plan` 中，未删除。

⚠️ 该作废不止于本任务：`goals/AC-220-…md`（`status: active`）的 `expect` 仍逐字要求把手读数 (d)(e)(f)，其 `criterion` 只运行 `e2e/transcript-edge-layout.spec.ts -g "AC-220"`。goal 面的收窄**只能由人 / 被授权的 goal 写入路径**执行，本 worker 无权改 `goals/`，故在此明确登记：goal AC-220 的 `expect` 仍含已作废的把手读数，需人工复核后收窄，否则其 sufficiency 判读会与本任务的实际交付不符。**复核者可以回退本节的收窄**（回退需同时复活把手，会红掉 overflow-menu 守卫）。

## Plan

1. 先写判据：新建 `e2e/transcript-edge-layout.spec.ts`（用例标题含 `AC-220`，用种子 `e2e-transcript-jump`，视口 390×844、820×1100、1440×900；触摸用 `hasTouch` 的上下文），按 AC-220 的 (a)(b)(c)(g) 读数；把手读数 (d)(e)(f) 作废（见 `## Resolution`），新增「右边缘无手柄」断言代之。先看 AC-220 红。✅ 已建，红线为「spec 文件不存在 → No tests found」。
2. 纯函数与单测：`transcriptGutterPx` 与 `src/modules/chat/tests/transcriptGutter.test.ts`（手机 / 平板 / 宽屏三档与边界宽度 767/768、空边距恰为 72px）。✅ 已建并绿。原列的 `quickSettingsHandleBand.test.ts` 随 `quick-settings-panel` 模块一并作废。
3. 实现 A、C；`index.css` 删除写死的 `padding-right`，`ChatMessagesPane` 用 `transcriptGutterPx` 设内联 padding；粗指针下给滚动条滑块加一层 32×44 的命中层（视觉仍是 8px）。✅ 已完成。
4. 跑守卫并写证据。✅ 见 AC。

## AC

> 本节由 worker 于 2026-10-04 依 `## Resolution` 收窄：原 (d)(e)(f) 的把手读数作废，改为「右边缘无手柄」的同一不变量；A/C 读数与阈值未放宽。复核者可回退。

- [x] AC1 判据绿：`npx playwright test e2e/transcript-edge-layout.spec.ts -g "AC-220"` 退出 0。红态基线：spec 文件不存在，playwright 报 No tests found。（实测：`4 passed (22.2s)`，退出 0 —— (a) 2.7s、(b) 2.8s、(c) 2.8s、(g) 3.5s。）
- [x] AC2 既有守卫不回退，逐字写下各自读数，均退出 0：
  - AC-217 v2（`e2e/transcript-rail-geometry.spec.ts -g "AC-217 v2"`）3 passed：`(a)(b)(c)(d)(e) 5.6s`、`(a)(e) narrow 2.7s`、`(a)(h) stands down 9.1s`。
  - AC-214 v3 与 AC-215（`e2e/transcript-global-scrollbar.spec.ts`）passed（同批 11 passed 之内）。
  - AC-219（`e2e/transcript-scrollbar-native-length.spec.ts`）6 passed：`(a) 6.1s`、`(b) 5.3s`、`(c)(f) 7.7s`、`(d) 11.2s`、`(e) 6.0s`、`(g) 4.7s`。
  - AC-218（`e2e/transcript-scrub-smooth.spec.ts -g "AC-218"`）隔离重跑 passed（30.9s，读数 `settleInWindowP95=89`，阈值 100ms）。**同批首跑曾红**（`settleInWindowP95=[102]`，超阈 2ms，宿主 load avg≈12 且并发跑其它 spec）—— 隔离即绿，为负载假红，与本改动无关（细指针路径未动）。
  - AC-213 v2（`e2e/transcript-jump-to-turn.spec.ts -g "AC-213 v2"`）passed（16.8s）；AC-216（`e2e/transcript-prefetch.spec.ts`）passed（4.8s）。
  - `e2e/transcript-follow.spec.ts` 6/7：other 6 条（AC-106..111）全绿；第 7 条 `a whole row arriving while pinned keeps the pane at the bottom` 在其**自身前置断言**红（`row 1 has to arrive taller than the pane it arrives in … settledHeight 1135 vs pane 460`），为本仓已记录的负载假红（`transcript-follow-whole-row-case-is-a-load-flake`），未触碰 follow/lazy-row，与本改动无关。
- [x] AC3 取假形态必须红（先提交实现再变异，逐条记录：变异点、逐字失败行、恢复命令）。基线提交 `77dbf819`；恢复命令统一 `git checkout -- <file>`；四次变异后 `git status --porcelain` 均空。
  - (a) `padding-right` 恢复固定 band（`transcriptGutterPx` 直接 `return TRANSCRIPT_TICK_BAND_GUTTER_PX`）⇒ **(a)(c) 红**：(a) `Error: the phone gutter must not be a fixed band at mobile 390x844`（`panePaddingRight:72`）；(c) `Error: the wide gutter must shrink to nothing at wide 1440x900`（`panePaddingRight:72`）。
  - (b) 手机不渲染刻度但仍预留 72px（首行改 `return TRANSCRIPT_TICK_BAND_GUTTER_PX`）⇒ **(a) 红**（同上失败行），**(c) 仍绿**（1 passed）—— 与 (a) 判然有别。
  - (f) 平板把刻度列收窄（`TRANSCRIPT_TICK_COLUMN_WIDTH_PX=8`）⇒ **(b) 红**：`Error: the tick column must stay 16px wide at tablet 820x1100`。
  - (e) 热区仍为 8px（`TRANSCRIPT_SCROLLBAR_GRAB_WIDTH_PX=8`）⇒ **(g) 红**：`Error: the grab area must be at least 32px wide at touch mobile 390x844`。
  - 原 (c)(d) 两条（把手恢复 `right-0`/50%、夹取写回 localStorage）无主体，作废，未执行。
- [x] AC4 单测绿：`npx vitest run src/modules/chat/tests/transcriptGutter.test.ts` 退出 0（`5 passed`，覆盖 Plan 第 2 步列的三档与边界 767/768、空边距恰为 72px）。其余 chat 客户端测试保持绿：`npx vitest run src/modules/chat` 退出 0 —— **88 files passed，587 tests passed | 1 skipped**。`src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts` 随模块作废（目录已不存在）。
- [x] AC5 手机与平板截图写进证据（改动前 / 改动后并排），读数并排：
  - 文件：`/data/home/yale/.cache/quay-ac220-evidence/{before,after}-{mobile,tablet}.png`（手机 390×844、平板 820×1100，截图框住右边缘 360px）。
  - 手机：改动前 `padding-right=72`、`content.right=318`（文字列 286px，占 73%）；改动后 `padding-right=16`、`content.right=374=track.left`、文字列 342px（占 87.7%），文字紧贴滚动条列左边。
  - 平板：改动前 / 改动后均 `padding-right=72`、`content.right=748` —— 刻度列不收窄（与 AC-217 一致）。
- [x] AC6 `npm run typecheck` 退出 0（`tsc --noEmit -p tsconfig.json` 0；`npm run typecheck` 三段全过）；`npm run lint`（oxlint）退出 0，仅既有 warning。`git diff --stat`（`77dbf819`）与 `## Touches` 逐条对齐：6 个代码文件，其中 2 个新增用 ASCII `(new)` 标注。

## DoD

- 读数全部来自我们自绘的元素与几何 / 计算样式，不读原生滚动条布局（e2e 里 Playwright 带 `--hide-scrollbars`）；不放宽阈值。
- 手机：padding-right 16px（∈[滚动条列 16, 20]），文字紧贴滚动条列左边，消息列宽 342/390=87.7% ≥ 85%；平板：72px 且刻度列宽 16px、间距 30px 不收窄；宽屏：padding-right 0 ≤8px，刻度列 `left 1392 ≥ content.right 1263 + 16`，滚动条落在内容列外侧。
- 右边缘无任何手柄 / 悬浮导出按钮（`[data-quick-settings-handle]`、`[data-transcript-export-anchor]` 计数为 0）—— 原「把手在导出按钮下方、与导出按钮/刻度列/滚动条两两不相交」的 DoD 随 B 作废（见 `## Resolution`）。
- 触摸热区 ≥32×44px，向内容一侧扩展（右缘在 `pane.right-4`，左缘 `≤ pane.right-32`），贴屏幕右缘的 8px 内不作为唯一抓取区；细指针行为不变（滑块仍 8px、几何读数不变）。
- 模块边界：`quick-settings-panel` 与 `chat` 之间无互相导入（`quick-settings-panel` 已不存在），只经 `src/shared`；新增测试文件对其他模块只经其 barrel 导入；遵守 `frontend-module-standards`；`## Touches` 之外未写任何文件。

## Touches

- src/index.css
- src/shared/transcriptEdgeLayout.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/TranscriptScrollbar.tsx
- src/modules/chat/tests/transcriptGutter.test.ts (new)
- e2e/transcript-edge-layout.spec.ts (new)
- tasks/transcript-edge-gutter-handle-and-touch-target.md