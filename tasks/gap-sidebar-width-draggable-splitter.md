---
id: gap-sidebar-width-draggable-splitter
title: 侧栏（展开态）宽度可拖拽：桌面指针设备专属 splitter（默认 288 / 220–min(480,50vw) / 键盘与双击复位 /
  localStorage），移动端抽屉与触屏专用设备一律不提供
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

需求：侧栏展开态的宽度目前写死，长会话名看不全。改为可拖拽。

机制（已定位到行）：全仓唯一的宽度出处是 `src/modules/sidebar/SidebarContent.tsx:189` 的 `md:w-72`（288px；`w-72` 全仓仅此一处，没有别处依赖侧栏宽度）。会话名是 `truncate` + 原生 `title` 兜底（`SidebarSessionItem.tsx:172-173`），所以这是"行内可读宽度"问题，不是内容问题。桌面容器是 `ProjectSidebarRegion.tsx:30-58` 的 `flex-shrink-0 border-r`（宽度由内容撑开），移动是同一文件的抽屉 `w-[85vw] max-w-sm`；主区 `ProjectWorkspaceShell.tsx:25` 是 `flex min-w-0 flex-1`，会自动让位。折叠态渲染的是 `SidebarCollapsed`（`w-12` 图标栏），根本不经过 SidebarContent。

设计（原型已在真实浏览器实现并验证，见下方原型段）：

1. **落位**：全部改动留在 sidebar 模块内。宽度落在 SidebarContent 根节点（去掉 `md:w-72`，改 `relative` + ref + 内联宽度），手柄作为它的绝对定位子元素。折叠态手柄自然消失（SidebarCollapsed 里没有它），因此**不需要**读 `sidebarVisible`，也不需要在 `project-workspace` 侧做任何状态耦合。
2. **交互**：Pointer Events + `setPointerCapture`（鼠标/触控/笔一条路径，且拖到主区上方不丢事件）。拖拽期间锁 `document.body` 的 `cursor: col-resize` / `userSelect: none`。默认 **288**（与现状逐像素一致）、最小 **220**、最大 `min(480, 50vw)`；窗口 resize 重新钳制（该路径**不落盘**——那是窗口造成的，不是用户选择）。双击手柄复位 288；键盘 `←`/`→` ±16px、`Shift+←/→` ±64px、`Home`/`End` 到最小/最大。手柄是窗口分隔条模式：`role="separator"` + `aria-orientation="vertical"` + `aria-valuenow/min/max` + `tabIndex=0`。
3. **性能关键（不要改掉）**：拖拽期间只写 `rootRef.current.style.width`，**松手才** `setState` + 落盘。因为 `Sidebar.tsx:206` 每次渲染都重建 `projectListProps` 对象，会击穿行组件的 memo（`src/modules/sidebar/tests/sidebarRowProps.test.tsx` 守的正是这个），把宽度放进 state 会让每个 pointermove 重渲染整棵项目/会话列表。
4. **持久化**：localStorage 键 `sidebarWidth`，读写落在既有 `src/modules/sidebar/utils/sidebarStoredPreferences.ts`（该文件已声明浏览器本地语义），与 `quickSettingsHandlePosition` 同一先例。**不进** `uiPreferences`：那是全布尔 ABI（`parseBoolean` 逐键裁决），而且宽度是设备几何量——4K 上与笔记本上合理的值不同，服务端同步反而会把不合适的值推给另一台设备。
5. **设备排他（本任务的核心约束）**：移动端（`isMobile`，即 `innerWidth < 768` 的抽屉布局）与**触屏专用设备**都必须既无手柄、也无法拖拽。触摸判定复用仓库既有口径 `(pointer: coarse) and (hover: none)`（`src/modules/chat/hooks/useSendOnEnter.ts:12` 的 `TOUCH_ONLY_QUERY`；两半都要的论证见该文件注释——触屏笔电主指针仍是 fine，带鼠标的手机会报 hover），订阅用 `useSyncExternalStore` + 共享 `MediaQueryList`，形状抄同模块 `src/modules/sidebar/hooks/useCompactSidebar.ts`。**不要**另立触摸嗅探（实测 `'ontouchstart' in window` 在该配置下为 false）。
6. **一个连带的正确性点**：不可拖拽 ≠ 不设宽度。原型中间版本用 `width: null` 表达"不可拖拽"，那对抽屉是对的，但对**宽屏触摸设备**会让停靠侧栏失去宽度、塌成内容宽。最终实现把"是否内联宽度"绑在 `isMobile`、"是否有手柄"绑在 `canResize`——触屏宽设备仍以存储宽度停靠，只是没有手柄。

<!-- dedup-ref --> 同区域已 done 的 `gap-composer-send-key-touch-scoped` 是**同一触摸判定口径**的先例（那边修的是输入键行为），本任务复用它而不是另立判定，故记此互相引用以便追溯；该任务与本任务是不同机制（输入键契约 vs 侧栏几何），不构成重复。

**本任务必须基于已存在的原型开发，不要从零重写。** 原型已提交在一个独立 worktree：

- 路径：`/data/home/yale/work/claudecodeui/.claude/worktrees/sidebar-resize`
- 分支：`proto/sidebar-resize`，commit `68278044`，基于 `develop`（= `author` = `87f09b58`）
- 内容：新增 `src/modules/sidebar/hooks/useSidebarResize.ts`（248 行）与 `src/modules/sidebar/SidebarResizeHandle.tsx`（55 行）；改 `SidebarContent.tsx`（+30/-3）、`sidebarStoredPreferences.ts`（+30）、`src/shared/types.ts`（+20/-1）；`en`/`zh-CN` 两个 locale 已加 `resizeHandle.label`。
- 取用方式：把该分支并入本任务的 `task/<id>` 分支（`git merge proto/sidebar-resize`，或 `git cherry-pick 68278044`），再补齐下面的缺口。**不要**为本任务预建 `task/<候选 id 分支>`：`claim-task` 把已存在的 `task/<id>` 视为在途并拒绝派发。
- 原型已过：`tsc --noEmit` 退出 0；`npm run lint` 退出 0 且诊断数与 pristine develop 基线**同为 150（增量 0）**；`npm run test:client` 87 文件 / 610 用例全绿。

原型**故意没做**、本任务要补齐的：

1. 自动化测试完全没有：原型结论全部来自一次性手工探针（Playwright MCP 真实指针/触摸事件）。
2. i18n：只有 `en` / `zh-CN` 两个 locale 有 `sidebar:resizeHandle.label`，其余 **10 个**（de/es/fr/id/it/ja/ko/ru/tr/zh-TW）没有。
3. 没有 e2e spec 文件（`e2e/` 下无对应用例）。
4. 量测注意（原型踩过）：`page.setViewportSize` / `browser_resize` **只改视口，不翻 pointer 媒体特性**；触摸必须由 browser context 的 `hasTouch + isMobile`（e2e 里即 `test.use`）给，且视口与触摸必须在**同一处**一起给。

实施时按 `.agents/skills/frontend-module-standards/SKILL.md` 落位：新 hook 属模块私有，放 `src/modules/sidebar/hooks/` 且**不进** barrel；被 hook 与手柄两个文件共用的 handlers 类型按仓库先例放 `src/shared/types.ts`（同 `QuickSettingsHandleStyle`/`SidebarProjectListProps`）；新测试只经模块 barrel `@/modules/sidebar`（或模块内相对本模块的直接导入，同 `sidebarRowProps.test.tsx` 先例）导入，跨模块深导入会红 oxlint boundaries。

## AC

- [x] `npx vitest run src/modules/sidebar/tests/sidebarResize.test.ts` 退出码 0，且每条判定**各自独立可反红**并在失败信息里打印实际读数：(a) 无存储时宽度 === 288；(b) 存储 9999 被钳到当日上限、存储 10 被钳到 220；(c) 存储 `"abc"` / `"0x10"` 等损坏值回退 288 而不是 NaN；(d) 键盘四键各自读数——`←` = 起始−16、`Shift+←` = 起始−64、`Home` = 220、`End` = 当日上限；(e) 双击复位 288。
- [x] 同一文件断言**拖拽期间不落盘、仅松手落一次**：以 `localStorage.setItem` 的 spy 记录调用序列，拖拽中间态（多次 pointermove）的调用次数为 0，pointerup 后恰为 1 且传入值为松手时的宽度；断言的是这两个读数，不是"没报错"。
- [x] 同一文件断言**设备排他**：以 `window.matchMedia` 替身分别给出 `(pointer: coarse) and (hover: none)` 为真/假两 leg，真 leg 下 `canResize === false` 且渲染结果中无 `[role="separator"]`，假 leg 下 `canResize === true` 且有；两 leg 各自独立可反红（失败信息打印两 leg 的实际布尔）。jsdom 不实现 `matchMedia`，替身须自带且按 query 分支返回（`vitest.setup.ts` 现有替身恒返回 false，只够假 leg）。
- [x] e2e 触摸 leg：`npx playwright test e2e/sidebar-resize.spec.ts` 退出码 0。该 leg 以 `test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } })` 运行（**视口与触摸同处给**），并在断言行为**之前先断言前提**：页内 `matchMedia('(pointer: coarse) and (hover: none)').matches` 为 true、且 `document.querySelector('[role="separator"]')` 为 null，否则以该实际读数直接 fail（没有这两条，spec 在桌面配置下会静默通过，等于没测）。随后以 CDP `Input.dispatchTouchEvent` 在侧栏右缘做一次真实 touchStart/若干 touchMove/touchEnd，断言侧栏渲染宽度与 `localStorage.getItem('sidebarWidth')` 两者拖拽前后**逐字段相同**。
- [x] e2e 指针 leg（**同一 spec 文件内的另一个 describe 块**，共用一次运行与同一个 `DATABASE_PATH`；不要拆成第二个 spec 文件，那会踩"一次运行一个库"的鉴权坑）：默认配置 + 1440×900 视口下，断言拖拽后渲染宽度跟手（≥2 个采样点）、`localStorage.sidebarWidth` 落盘为松手值、reload 后仍为该值、往左拖到极左停在 220、往右拖到极右停在 `min(480, 50vw)`、双击复位 288。
- [x] 抗假变体：把设备排他判定恒置为真（等价于删掉 `!isTouchOnlyPointer` 那一半）后重跑该 spec，触摸 leg 必须在"无 `[role="separator"]`"那条变红；再单独把 `!isMobile` 那一半删掉重跑，767px 视口 leg 应变红。还原后全绿，`git diff` 只剩本任务声明的写点。单测 `sidebarResize.test.ts` 在变体下同样应变红。
- [x] i18n 完整性（12 个 locale × 1 个 key）：一条 `node -e` 或等价脚本校验 `src/modules/i18n/locales/*/sidebar.json` 全部存在**非空**的 `resizeHandle.label`，且 12 个文件仍是可解析 JSON；任一缺失或为空即以非 0 退出并打印缺哪个文件哪个 key。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 在本仓库预先就有诊断且非 0，不作为判据）。

## DoD

真实落地判据：不是"测试存在"，而是真浏览器里跑出读数并写进 Evidence：

1. 指针 leg 的实测读数：拖拽采样点与渲染宽度（跟手）、`aria-valuenow` 与渲染宽度一致、落盘值、reload 后的值、220/上限/288 三个端点。
2. 触摸 leg 的前提读数：页内 `pointer: coarse` 与 `hover: none` **各自**的真假（两半分别打印，不只打合取结果），以及手柄缺席、真实触摸拖拽零变化。
3. 正向对照（不是"没写就等于没污染"）：(a) 触摸 leg 内 `localStorage.sidebarWidth` 拖拽前后**两次独立读数**相同；(b) 同一 profile 换成指针设备后手柄出现，且 `aria-valuenow` 等于该存储值——这条同时证明"触屏宽设备仍以存储宽度停靠、只是没有手柄"，而不是塌成内容宽。
4. 既有交互回归读数：transcript 阅读位置在两次 resize（缩窄再拉宽）中 **scrollTop 零位移**，且钉在底部时 resize 后仍在底部（原型实测：阅读态 853 不变；钉底态 3926 === max）。
5. 读数边界如实标注：触摸来自 Chromium 的 touch emulation（`hasTouch + isMobile` 翻转的是真实 Blink 媒体特性），**不是真机**；**触屏笔电（粗指针 + 主指针可悬停）这一组合 Playwright 表达不出来**（`hasTouch` 一开 `hover: none` 即为真），故"笔电不被误判"只由 query 语义与 `useSendOnEnter.ts` 的既有注释支撑，必须在 Evidence 里标明**未实测**；终端只验证到"容器随拖拽变宽"（原型 1064→1184→936），**列数未读数**（隔离 HOME 里没有活 shell）。
6. 夹具与量测注意：e2e 若需项目/会话，须在 `playwright.config.ts` 服务启动前播种（中途写入会被 watcher 当成 `session_upserted` 并标 "needs attention" 导致随机红）；若为播种改了配置文件，须同步把它加进 Touches——本任务默认**不需要**，分隔条的存在与项目数量无关。新库 onboarding 的 `beforeAll` 等 `#username` 在负载下约 1/7 概率红在 ~184s（安静时约 11s），按墙钟归因，不要加重试。原型另有一条已知无害噪声：长驻页面里热改本 hook 会触发 React Fast Refresh 的 hook 顺序错（`Should have a queue`），**整页重载后 0 error**——不是产品缺陷，但说明这类 hook 结构改动不适合热验。

L_D 该轴仍暗，理由：本任务改的是布局几何与手势可用性，不产出领域数据或文档语义读数；`resizeHandle.label` 的 12 locale 完整性由上面那条 i18n 判据单独机械钉住，除此之外该轴没有可分离的度量。

L_G 该轴仍暗，理由：同上；本任务的验证读数就是 DoD 里真实浏览器两个 leg 的读数与两条正向对照读数。

## Touches

- src/modules/sidebar/hooks/useSidebarResize.ts (new)
- src/modules/sidebar/SidebarResizeHandle.tsx (new)
- src/modules/sidebar/SidebarContent.tsx
- src/modules/sidebar/utils/sidebarStoredPreferences.ts
- src/shared/types.ts
- src/modules/sidebar/tests/sidebarResize.test.ts (new)
- e2e/sidebar-resize.spec.ts (new)
- src/modules/i18n/locales/en/sidebar.json
- src/modules/i18n/locales/zh-CN/sidebar.json
- src/modules/i18n/locales/zh-TW/sidebar.json
- src/modules/i18n/locales/ja/sidebar.json
- src/modules/i18n/locales/ko/sidebar.json
- src/modules/i18n/locales/de/sidebar.json
- src/modules/i18n/locales/es/sidebar.json
- src/modules/i18n/locales/fr/sidebar.json
- src/modules/i18n/locales/it/sidebar.json
- src/modules/i18n/locales/id/sidebar.json
- src/modules/i18n/locales/ru/sidebar.json
- src/modules/i18n/locales/tr/sidebar.json
- tasks/gap-sidebar-width-draggable-splitter.md
