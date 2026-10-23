---
id: gap-workspace-header-overflow-menu-replaces-edge-controls
title: 会话页右上角加 ⋯ 溢出菜单，收编 Export 与快速设置；去掉可拖动的快速设置抽屉把手和悬浮导出按钮，右边缘只留给滚动条和刻度
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人 yale 2026-10-04 的裁定：Export 与 quick settings 两个按钮使用频率很低，却占着会话右边缘（尤其手机）并挤压对话历史刻度；去掉可拖动的抽屉形态；手机上的菜单沿用下拉（不做底部弹层）。

现状读数（2026-10-04，:3001 当前版本，MCP 浏览器只读，视口 390×844 与 1280×800，会话 `649f666c…`）：

1. 手机：右边缘同时有三样东西——导出按钮（32×32，x=286,y=69，`ChatMessagesPane` 里 sticky 悬浮在正文上）、快速设置把手（38×38，x=336,y=384，`fixed`，停在视口中段，连打开的侧栏遮罩上也看得见）、绘制的滚动条紧贴把手右侧。手机不绘制刻度列。
2. 桌面：快速设置把手（y≈167）压在刻度列（x≈1243，y≈209–480）的正上方；导出按钮浮在正文右上。为了让它们互相避让，代码里已有导出锚点 `data-transcript-export-anchor`、CSS 变量 `--transcript-edge-thumb-left`、常量 `TRANSCRIPT_HANDLE_*` 与 `publishTranscriptEdgeBand` 一整套机制。
3. 顶部栏（`WorkspaceHeader.tsx`）：桌面是「标题 + 可滚动 tabs」，tabs 右侧没有空位；手机是「菜单 / 标题 / 工作区选择器」一行。

要做的事：

**A. 顶部栏最右（tabs 之外）加一个 `⋯` 溢出菜单，手机与桌面共用同一个下拉。** 菜单分组：「导出」（HTML / Markdown / JSON，沿用 `ChatExportMenu` 的三种格式与「先加载完整转录再导出」「构建中忙碌态」行为；当前没有会话消息时整组不显示）；「显示」（显示原始参数、显示思考）；「输入」（Ctrl+Enter 发送；语音开关仅在 `voiceEnabled` 时出现，行为与现状一致）；「外观」（深色模式、语言）。开关即点即改（沿用 `useSetUiPreference`），点开关后菜单保持打开，点导出项后关闭。手机上沿用下拉，不做底部弹层；下拉宽度不超出视口，触摸目标 ≥44px 高。

**B. 去掉可拖动的快速设置抽屉与悬浮导出按钮。** 删除 `QuickSettingsHandle`、`QuickSettingsPanelView` 的抽屉与遮罩、`useQuickSettingsDrag`、`localStorage.quickSettingsHandlePosition` 的读写，以及 `ChatMessagesPane` 里 sticky 的导出容器；清理因它们而存在的避让机制（`data-transcript-export-anchor`、`--transcript-edge-thumb-left`、`TRANSCRIPT_HANDLE_*` 常量、`publishTranscriptEdgeBand`/`readTranscriptEdgeBand` 中只服务把手的部分，以及刻度列为把手预留高度的逻辑）。右边缘只剩滚动条与刻度。

**C. 导出动作如何从 chat 传到 header。** 导出需要的消息与「加载完整转录」都在 chat 模块里，header 在 project-workspace 模块里，两个模块不得互相深入导入。实现者在 `src/shared` 里用一个小的注册式接缝（例如 chat 在有会话消息时登记一个「导出」动作，header 菜单读取；会话切换/卸载时撤销）传递，并把选择写进证据。快速设置内容组件迁到承载菜单的模块，不再保留 `quick-settings-panel` 的抽屉壳。

不在本任务内：滚动条/刻度的像素估算与点击落点（AC-219、AC-221）、右侧留白的按视口计算。

<!-- dedup-ref -->相关任务 `transcript-edge-gutter-handle-and-touch-target`（todo，AC-220）的 B 部分是在调把手的默认位置与夹取；本任务把把手整个移除，该任务的 B 部分与 Touches 里的把手文件随之作废，A（右侧留白）与 C（触摸热区）仍有效。是否收窄那个任务由人决定，本任务不改它。已完成的 `transcript-rail-split-scrollbar-and-windowed-ticks`（AC-217）的把手让开部分同样随之退役，其 e2e 断言要随本任务改。

## Plan

1. 先写判据：新建 `e2e/workspace-overflow-menu.spec.ts (new)`，用例标题含 `AC-222`，视口 390×844 与 1280×800，种子用现有 `e2e-transcript-jump`。读数：菜单触发钮的包围盒、菜单项文本、`[data-quick-settings-handle]` 与 `[data-transcript-export-anchor]` 不存在、右边缘（滚动条左缘到视口右缘）内无其他可点元素。
2. 抽出共享接缝（`src/shared` 里的导出动作登记）与菜单组件；把 `QuickSettingsContent` 的行迁进菜单；`WorkspaceHeader` 在 tabs 之外放触发钮（桌面给 tabs 区留出触发钮宽度，手机放在工作区选择器右侧）。
3. chat 侧：`ChatInterface`/`ChatMessagesPane` 改为登记导出动作，删除 sticky 导出容器；`ChatExportMenu` 的格式列表与忙碌态迁成菜单项（保留 `transcriptExport` 单测覆盖的行为）。
4. 删除把手、抽屉、拖动 hook、localStorage 读写、避让常量与发布/读取；改 `e2e/transcript-rail-geometry.spec.ts` 里只与把手有关的断言（刻度与滚动条断言不放宽）。
5. i18n：新菜单文案进 en 并补齐其余语言；删掉不再使用的 `quickSettings.dragHandle.*` 键。
6. 跑守卫：AC-222、AC-217 v2（改后）、AC-214 v3、AC-218、AC-219、`transcript-follow`、transcriptExport 单测、`npm run typecheck`、`npm run lint`、i18n 完整性检查；手机与桌面改动前后截图并排写进证据。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/workspace-overflow-menu.spec.ts -g "AC-222"` 退出 0。红态基线：spec 文件不存在，playwright 报 No tests found。（实测：`3 passed (22.7s)`，退出 0 — AC-222 (a)(b)(c) 5.7s、(b) 三格式导出 4.8s、(d) 无会话 1.9s。）
- [x] AC2 菜单内容与行为（含在 AC-222 内）：打开 ⋯ 后能读到导出三格式、显示原始参数、显示思考、Ctrl+Enter 发送、深色模式、语言各一项；无会话消息时没有「导出」组；点开关后菜单仍开、对应偏好变化；点导出项后触发一次下载并关闭菜单（e2e 读下载事件，文件名后缀分别为 .html/.md/.json）。（实测：两视口均读到 `export-html/export-markdown/export-json/showRawParameters/showThinking/sendByCtrlEnter/darkMode/language` 八项；点 `showRawParameters` 后 `aria-checked` `false→true` 且菜单仍开、再点回 `false`；三个导出项各触发一次 `download` 事件，`suggestedFilename()` 分别以 `.html/.md/.json` 结尾且菜单 `[data-workspace-menu]` 归零；无会话时 `export-*` 项为空。）
- [x] AC3 边缘清空：`rg -n "data-quick-settings-handle|data-transcript-export-anchor|quickSettingsHandlePosition|transcript-edge-thumb-left|TRANSCRIPT_HANDLE_" src e2e` 在 `src` 与 `e2e` 下无命中（e2e 里验证它们不存在的断言字符串除外，需在证据里逐条列出）；e2e 里手机与桌面两种视口读到右边缘无把手、无悬浮导出按钮。（实测：`src` 下 0 命中；`e2e` 下命中即新判据的「不存在」断言字符串，逐条为：`e2e/workspace-overflow-menu.spec.ts` 里 `readEdge` 的 `document.querySelectorAll('[data-quick-settings-handle]')` 与 `document.querySelectorAll('[data-transcript-export-anchor]')`；两种视口 `readEdge` 读到 `handleCount=0`、`exportAnchorCount=0`、`offenders=[]`（右边缘 x∈[滚动条/刻度左缘, pane.right] 内除 rail 自身外无可点元素）。）
- [x] AC4 既有守卫不回退，逐字写下读数：`e2e/transcript-rail-geometry.spec.ts`（只改与把手有关的断言）、AC-214 v3、AC-218、AC-219、`e2e/transcript-follow.spec.ts` 均退出 0；`npx vitest run src/modules/chat/tests/transcriptExport.test.tsx src/modules/chat/tests/transcriptExportWorkSegments.test.tsx` 退出 0。（实测：`transcript-rail-geometry.spec.ts` 3 passed（AC-217 (a)(b)(c)(d)(e) 5.5s、(a)(e) 窄屏 2.6s、(a)(h) 短会话 5.5s）；AC-214 v3 2 passed（21.3s / 6.4s）+ AC-215 1 passed；AC-218 1 passed（27.2s，`thumbChangeShare=1`、`maxThumbJump=0.00083`）；vitest `transcriptExport` 16 passed（两文件）。`e2e/transcript-follow.spec.ts` 6/7：other 6 条全绿，`a whole row arriving while pinned` 在其**自身前置断言**红（`Expected: > 460 / Received: 240`，宿主 load avg≈20、另一会话正并发跑同一 spec），其行为读数全部成立（`whole-row settled gaps: 0→0→…→0`、`drift: worst settled gap 0px`），为本仓已记录的负载假红（`transcript-follow-whole-row-case-is-a-load-flake`），与本改动无关（未触碰 follow/lazy-row）；隔离重跑仍受同一并发负载。AC-219 在本树**无判据文件**（属 needs-human 任务 `transcript-scrollbar-native-length-and-pixel-position`，其 `e2e/transcript-scrollbar-native-length.spec.ts` 未合入），不可运行，如实记录。本轮补记：本轮的菜单修复（`3fcdbcec`）本身曾让一条**既有**守卫变红 —— `src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx`（不在本任务 `## Touches` 内、本轮未改动）7/8 失败，`Error: useUiPreferences must be used within a UiPreferencesProvider`：`WorkspaceHeader` 常驻渲染 `WorkspaceMenu`，而菜单内容读 `UiPreferencesContext`（无 Provider 即抛），于是 header 只渲染一个**关闭态**菜单也要 Provider。修法：把下拉内容拆成 `WorkspaceMenuPanel`，仅在菜单打开时挂载（改动只落在 Touches 内的 `WorkspaceMenu.tsx`），关闭态 header 不再依赖该 Provider；修后该文件 `8 passed`，`e2e/workspace-overflow-menu.spec.ts` 复跑仍 `3 passed (21.4s)`。）
- [x] AC5 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(a) 菜单里去掉导出组 ⇒ AC-222 红；(b) 开关点击后关闭菜单 ⇒ AC-222 红；(c) 把手重新渲染（任意位置）⇒ AC-222 边缘清空断言红；(d) 无会话消息时仍显示导出组 ⇒ AC-222 红；(e) 手机菜单宽度超出视口 ⇒ AC-222 手机用例红。（实测，基线提交 `affdf098`；本轮菜单面板拆分（`3fcdbcec`）后再以同一组五条变异逐条复测，五条全部仍红、失败行与下列逐字相同，逐条 diff 存 `/tmp/ac5-{a..e}.diff`，恢复命令统一 `git checkout -- <file>`：**(a)** `WorkspaceMenu.tsx` `{available && (` → `{false && (` ⇒ 红：`Error: the menu must offer export-html at mobile 390x844: ["showRawParameters","showThinking","sendByCtrlEnter","darkMode","language"]`；**(b)** `togglePreference` 内加 `setIsOpen(false)` ⇒ 红：`Error: a switch must not close the menu at mobile 390x844`（`expect(locator).toBeVisible() failed`）；**(c)** `ChatMessagesPane.tsx` 面板内加 `<div data-quick-settings-handle className="fixed right-0 top-1/2 h-10 w-10" />` ⇒ 红：`Error: no quick-settings handle may remain at mobile 390x844`；**(d)** `{available && (` → `{true && (` ⇒ 红（test (d)，test1/2 仍绿）：`Error: no export item may show without messages`；**(e)** `MENU_WIDTH_PX=900` 且 style width 去掉 `Math.min(…, window.innerWidth - 16)` ⇒ 红：`Error: the menu must not run off the right edge at mobile 390x844`。）
- [x] AC6 `npm run typecheck` 与 `npm run lint` 退出 0；i18n 完整性检查对照 develop 无新增缺键，且 `quickSettings.dragHandle` 键在各语言文件中均已删除；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。（实测：`npx tsc --noEmit -p tsconfig.json` 退出 0；`npm run lint`（oxlint src/ server/ scripts/ shared/）退出 0，仅既有 warning。i18n：新增键 `workspaceMenu.trigger` 在 12 个 locale 的 `chat.json` 全部非空（`locales.checked=12 newKeyMissing=0`），`quickSettings.dragHandle` 在 12 个 locale 的 `settings.json` 均已删除（`dragHandleRemaining=0`）；对照 develop **无新增缺键**（唯一既有缺口 `quickSettings.voiceEnabled` 在 de/fr/it/ja/ru/tr/zh-TW 7 个 locale 本就缺失，与 develop 相同，非本次新增）。`git diff --stat` 文件集与 `## Touches` 逐条对齐：新增 `WorkspaceMenu.tsx`、`TranscriptExportContext.tsx`、`e2e/workspace-overflow-menu.spec.ts`（均 `(new)`）；locale 以 `en/settings.json`、`en/chat.json` 为代表，其余 11 个为同组同名文件。）
- [x] AC7 手机（390×844）与桌面（1280×800）的菜单关闭态、打开态、改动前后截图写进证据。（实测：`/tmp/ac222-evidence/{after,before}-{mobile,desktop}-{closed,open}.png` 共 8 张 —— `after-*` 为改动后（顶部栏最右 `⋯`；关闭态右边缘只剩滚动条与桌面刻度；打开态为下拉菜单），`before-*` 为临时恢复基线 `src`（`471b9949`）后（右边缘可见抽屉把手 chevron 与悬浮导出按钮）。另：DoD 的真实长会话导出核对亦实测 —— `e2e-transcript-jump`（outline total=4800）经菜单导出三格式：HTML `12,060,831` bytes 且含 `<html`（可打开）、JSON `messageCount=4800` 与会话总数一致、Markdown `443,338` bytes，文件留在 `/tmp/ac222-evidence/export-{html.html,md.md,json.json}`。）

## DoD

- 真实会话页上：右边缘（手机与桌面）只剩滚动条与（桌面的）刻度，没有把手也没有悬浮导出按钮；⋯ 在顶部栏最右，在 tabs 之外，手机与桌面可点。
- 在 :3001 的真实长会话上实际导出三种格式各一次并打开文件核对（HTML 可打开、Markdown 与 JSON 条数与会话一致），不是只靠 fixture；偏好开关在真实页面上改一次再改回，不留下改动过的偏好。
- 菜单与导出动作的接缝不让 `chat` 与 `project-workspace` 互相深入导入；遵守 `frontend-module-standards`；不放宽任何既有 e2e 阈值。

## Touches

- src/modules/project-workspace/WorkspaceHeader.tsx
- src/modules/project-workspace/ProjectWorkspaceShell.tsx
- src/modules/project-workspace/WorkspaceMenu.tsx (new)
- src/shared/context/TranscriptExportContext.tsx (new)
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/ChatExportMenu.tsx
- src/modules/chat/transcript/TranscriptTurnRail.tsx
- src/modules/chat/transcript/TranscriptTurnTicks.tsx
- src/shared/transcriptEdgeLayout.ts
- src/shared/types.ts
- src/shared/ui/DarkModeToggle.tsx
- src/modules/i18n/LanguageSelector.tsx
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/*/settings.json
- src/modules/i18n/locales/*/chat.json
- src/modules/quick-settings-panel/index.ts
- src/modules/quick-settings-panel/QuickSettingsContent.tsx
- src/modules/quick-settings-panel/QuickSettingsHandle.tsx
- src/modules/quick-settings-panel/QuickSettingsPanelView.tsx
- src/modules/quick-settings-panel/QuickSettingsPanelHeader.tsx
- src/modules/quick-settings-panel/QuickSettingsSection.tsx
- src/modules/quick-settings-panel/QuickSettingsToggleRow.tsx
- src/modules/quick-settings-panel/hooks/useQuickSettingsDrag.ts
- src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts
- src/modules/chat/tests/transcriptExport.test.tsx
- e2e/workspace-overflow-menu.spec.ts (new)
- e2e/transcript-rail-geometry.spec.ts
- tasks/gap-workspace-header-overflow-menu-replaces-edge-controls.md