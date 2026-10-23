---
id: gap-dock-counts-only-live-tasks-and-retires-strip
title: 活动坞只表示当前活动：计数与面板只含非终态任务，终态不再撑住 background 状态；取消与坞重复的 BackgroundTaskStrip 框
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

真实部署取证（2026-10-04，用户重启服务后）：会话里后台任务停了以后，坞的计数不减，点开面板才看到任务其实已经 completed/stopped；同时消息流末尾的 `BackgroundTaskStrip` 框信息很少（只有标签与时长），与坞数的是同一批任务，已无存在必要。

**机制（读代码，不是推断）。** `src/modules/chat/composer/ActivityIndicator.tsx:141` 传 `taskCount: tasks.length`，数的是任务表的全部行，含终态 `completed | failed | stopped | ended`。任务表保留终态行是有意的——转写里的卡片靠 `useTaskByToolUseId` 按 `toolUseId` 查任务来显示状态，所以**不能**在服务端或 store 里删终态行，只能在坞的读侧过滤。同一个缺陷还落在 `src/modules/chat/utils/activityDockView.ts:209`：`taskCount > 0` 决定坞进 `background` 状态，所有任务都已结束时坞仍显示「Background work · N tasks」且永不自行消失。面板 `ActivityDockPanel.tsx` 同样按 `tasks.length` 列出全部行，终态行只是没有停止按钮。

**裁定（用户已定）。** 坞只表示当前活动：计数、`background` 状态判定、面板列表都只含非终态任务（`running` 与 `blocked`）；终态任务不在坞里保留，只留在转写卡片里。计划（cron/wakeup）没有终态，行为不变。`BackgroundTaskStrip` 整体取消：它读 `/api/session-hosts` 租约，坞读 `activity.*` 帧，同一件事两个数据源；它还有两个已知缺陷（标签用 `task_id` 去匹配转写里的 `tool_use_id` 永远匹配不上而退回通用词；服务端缺 `since` 时显示 `NaN:NaN`），随它一起消失。

<!-- dedup-ref --> 相关任务：`gap-background-task-surface-absent-in-session-view`（done，当年立这个条的任务，其浏览器判据 `e2e/background-task-strip.spec.ts` 读条的 DOM，本任务取消条后该判据随之退役）、`gap-activity-dock-background-browser`（AC-194，坞的面板）、`gap-activity-dock-background-human-gate`（AC-201 人工关卡，读数里写「坞里列出描述、状态与最近动作」，本任务不改变它的四步动作）。「任务结束在转写里留一条记录」是另一个机制（服务端 reducer 发转写事件），由兄弟任务 `gap-task-terminal-transition-transcript-row` 承担，本任务不做。

## Plan

1. 在 `activityDockView.ts` 或 `useSessionActivity.ts` 旁抽出一个纯函数「活动任务」：过滤掉终态（复用面板已有的 `TERMINAL_TASK_STATES`，把它提到共享位置，不要抄第二份）。
2. `ActivityIndicator.tsx` 的 `taskCount` 与 `activityDockView.ts` 的 `background` 判定改读活动任务数；全部结束且无计划、无轮次时坞为 `hidden`。
3. `ActivityDockPanel.tsx` 的任务段、`data-task-count` 与 `Tasks N` 标题改为只列活动任务；面板空（无活动任务、无计划、无前台工具）时不渲染。
4. 删除 `BackgroundTaskStrip.tsx`、`ChatMessagesPane.tsx` 里的挂载点、`tests/backgroundTaskStrip.test.tsx`、`e2e/background-task-strip.spec.ts`；`ResidentSessionBadge.tsx` 仍在用的 `resident.backgroundTasks.count` 键保留，条专用的键（`title`、`genericLabel`、`monitorLabel`、`unknown`、`lastNotification`）在 12 个语种里同步删除，先 grep 确认无其它引用。
5. 修 `src/shared/types.ts` 里描述条的过时注释；`e2e/resident-status-bar.spec.ts` 的 i18n 键表同步（见记忆：判据键表会随退役变陈旧）。
6. 新增或改写单测：任务由 running 转 completed/stopped 后，坞计数减一；最后一个任务结束后坞消失；终态行不出现在面板；被取消的条在 DOM 里不存在。

## AC

- [x] AC1 计数只含活动任务：新增单测给定任务表 `[running, completed, stopped, blocked]`，渲染的 `[data-activity-task-count]` 为 `2`；`npx vitest run src/modules/chat/tests/activityDockTaskSchedule.test.tsx` 退出 0（含新例）。── 新例 `AC1: the dock counts only the tasks that can still move`，读数 `ac1.dockTaskCount=2 of 4 rows`（running + blocked）；该文件 `5 passed`，退出 0。
- [x] AC2 全部终态时坞自行消失：单测给定任务表只有终态行、无计划、无轮次，`[data-activity-dock]` 不存在（`hidden`）；任务由 running 经一次 `activity.upsert` 帧转 stopped 后，同一渲染里计数从 `1` 变为不存在。── 新例 `AC2: the dock retires itself when the last live task settles`，读数 `ac2.before: dock=true count=1` → `ac2.after: dock=false count=null`（同一 `render`，帧经 `applyActivityFrame` 走 `activity.upsert` 的同一入口）。
- [x] AC3 面板只列活动任务：单测给定一行 completed 与一行 running，面板 `[data-task-row]` 只有 1 个，`data-task-count` 为 `1`；已结束任务的停止按钮路径不再被渲染（`[data-task-stop]` 与行数一致）。── 新例 `AC3: the panel lists the live tasks only, and every listed row is stoppable`，读数 `ac3.rows=1 stops=1 panelTaskCount=1`（行 marker 是 `[data-activity-task-row]`，即本仓任务文里 `[data-task-row]` 一直指的那行，见 AC-199 同一写法）；同例断言终态行 `querySelector` 为 `null`，且 store 仍持 2 行、`findTaskByToolUseId('tool-done-1')` 仍解析。
- [x] AC4 条已取消：`test ! -e src/modules/chat/transcript/BackgroundTaskStrip.tsx` 退出 0；`grep -rn "BackgroundTaskStrip\|data-background-task" src e2e` 命中 0。── 两条都验：文件不存在；grep 无输出（含 `playwright.config.ts` 里退役判据条目的清理）。
- [x] AC5 死键清理且不误删：`grep -rn "resident.backgroundTasks.\(title\|genericLabel\|monitorLabel\|unknown\|lastNotification\)" src e2e` 命中 0，12 个语种的 `chat.json` 同步（`node scripts/` 下既有 i18n 完整性检查或 `npm run lint` 退出 0）；`resident.backgroundTasks.count` 仍存在且 `ResidentSessionBadge` 测试保持绿。── grep 无输出；12 个 `chat.json` 的 `resident.backgroundTasks` 各删 5 键、各留 `count`（脚本逐文件断言 `set(keys)=={'count'}`，12/12 ok）；`npx vitest run src/modules/i18n` 3 passed；`resident.backgroundTasks.count` 仍在 `ResidentSessionBadge.tsx` 与 `e2e/resident-status-bar.spec.ts`（该表本就只列 `count`，无需改）；`residentStatusBar*` + `activityDockConsolidation` 共 14 例全绿。
- [x] AC6 负控制有分辨力：把过滤临时改回 `tasks.length`，AC1 与 AC2 的新单测必须红；打印改前绿、改后红两次读数。── 绿（`selectActiveTasks(tasks).length`）：`ac1.dockTaskCount=2`、`ac2.after: dock=false count=null`，`Tests 9 passed`，退出 0。红（`tasks.length`）：`ac1.dockTaskCount=4`、`ac2.after: dock=true count=1`，`Tests 2 failed | 3 passed`，退出 1，两条红都落在 AC1/AC2 的断言上。改回后重跑恢复绿。
- [x] AC7 契约面：`npm run lint` 与 `npm run typecheck` 退出 0；`git diff --stat develop...HEAD` 与 Touches 逐条对齐。── `npm run lint` exit 0（`oxlint src/ server/ scripts/ shared/`，仅既有 warning，无新增）；`npm run typecheck` exit 0（三份 tsconfig）；`anti-drift-touches-check --task ... --worktree <wt> --merge-target develop` 报 `ANTI-DRIFT OK … all within declared Touches`。

## DoD

- 坞在真实渲染里随任务终态把计数减下去，并在最后一个活动任务结束后消失；不是只让一个固定快照数对。
- 面板与计数、`background` 判定读同一个「活动任务」纯函数，没有第二份终态集合。
- 任务表在 store 与服务端里仍保留终态行（转写卡片靠它显示状态）：`useTaskByToolUseId` 对已结束任务仍返回该任务，现有 `liveSubagentGrouping` 与卡片相关测试不回归。
- 条的组件、测试、e2e 判据、死 i18n 键一并删除，没有留下指向它的悬空引用；旧任务 `gap-background-task-surface-absent-in-session-view` 的判据随之退役而不是留红。

## Touches

- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/utils/activityDockView.ts
- src/modules/chat/transcript/ActivityDockPanel.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/BackgroundTaskStrip.tsx (delete)
- src/modules/chat/transcript/ResidentSessionBadge.tsx
- src/modules/chat/hooks/useSessionActivity.ts
- src/shared/types.ts
- src/shared/utils.ts （退役后 findBackgroundTaskLeases 的读者注释要改）
- playwright.config.ts （把退役判据从 DEBUG_AGENT_SPEC_FILES 里去掉）
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/chat/tests/activityDockTaskSchedule.test.tsx
- src/modules/chat/tests/backgroundTaskStrip.test.tsx(delete)
- src/modules/chat/tests/activityDockControls.test.tsx （面板改列活动任务后它会红）
- e2e/background-task-strip.spec.ts (delete)
- e2e/activity-dock-background.spec.ts （该判据读面板的终态行）
- e2e/resident-status-bar.spec.ts
- tasks/gap-dock-counts-only-live-tasks-and-retires-strip.md

## 完成记录

**过滤落在读侧、只有一份。** `TERMINAL_TASK_STATES` / `isActiveTask` / `selectActiveTasks` 收进 `src/modules/chat/hooks/useSessionActivity.ts`（store 模块，已导出 `readSessionActivityView`/`findTaskByToolUseId` 这类纯读helper，Plan 明列此文件）；面板原来那份本地终态集合删除。坞计数（`ActivityIndicator`）、`background` 判定（`deriveActivityDockView` 收到的 `taskCount`）与面板行/`data-task-count`/`Tasks N` 三处同读它。终态行在 store 与服务端一字未动。

**面板终态行改为"不列"而非"列而无停止按钮"。** `TaskRow` 的 `canStop` 分支随之删除——列表就是活动集，所以每行都带 `[data-task-stop]`（AC3 的"与行数一致"是构造性的）。

**条退役连带的三处计划外但被任务自身语义强制的工作**（都已在 Touches 声明）：
1. `playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES` 里 `background-task-strip.spec.ts` 是悬空条目，删。
2. `src/shared/utils.ts` 里 `findBackgroundTaskLeases` 的注释写着"the whole set the background-task strip draws"，读者只剩 resident pill，改写。
3. `e2e/activity-dock-background.spec.ts`（AC-194）原本断言终态任务**在面板里有行**（`[data-activity-task-row][data-task-state="completed"]` 计数 2、reload 后 2 行、AC5 "终态行有 0 个停止按钮"、AC-199 停在 `data-task-state="stopped"` 的行上）——与本任务的面板语义直接冲突，不改就留一条必红的判据。已改写成新语义：终态任务离开面板（`TASK_ROW` 计 0），而**卡片仍读 `completed`**、快照仍持 2 条终态任务——后者正是"读侧过滤"的对照臂。该文件在 `e2e/`，不进 typecheck/lint/全量 suite，本轮未跑真机 playwright（需 3001 上的真 server）；改动仅限读数与断言翻转，机械上未验证。

**未做（有意）**：`server/modules/session-hosts/tests/backgroundTaskLeaseSince.test.ts` 的文档注释里仍有一句"the background-task strip draws"。它不在本任务 Touches、不匹配 AC4 的 grep，属服务端测试的散文陈述，未动。

**测试**：`npx vitest run src/modules/chat` → `83 files / 534 passed | 1 skipped`，退出 0。

**AC3 选择器**：任务文写的 `[data-task-row]` 是本仓任务文对 `[data-activity-task-row]` 的既有简写（`tasks/gap-ac199-dock-stop-background-controls-browser.md:34` 同一写法），代码里从未有 `data-task-row` 这个 marker，故单测按真 marker 断言。
