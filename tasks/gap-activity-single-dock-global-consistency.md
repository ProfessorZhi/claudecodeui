---
id: gap-activity-single-dock-global-consistency
title: AC-188 真实浏览器：页面上只有一个活动坞、旧活动页签/内联行不再存在、resident
  状态栏忙闲与租约计数并入坞，坞/侧栏运行视图/发送停止态各处一致（桌面+移动）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-dock-unreachable-degradation
goal_ac: AC-188
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，读任务库与代码）。`grep -rn "^goal_ac: *AC-188" tasks/*.md` → **0 命中**。`grep -rln "AC-188" tasks/` 只命中三条**不同机制**的旁述，且三条都白纸黑字把这一格让了出来：`gap-activity-dock-unreachable-degradation`（`goal_ac: AC-184`）明写「AC-188 管的是**全局各处**状态一致，含 ResidentStatusBar 的忙闲部分」；`gap-activity-dock-phase-truthful`（`goal_ac: AC-187`）明写「AC-188 管的是**全局各处**状态一致」；`gap-activity-send-unreachable-draft-retry`（`goal_ac: AC-185`）明写「AC-188 管的是**全局各处**状态一致」。机制侧读数：`grep -rn "data-activity-dock" src/ e2e/ server/` → **0**（坞尚未建，是本族四条都还没有的地基）；而 `grep -rn "data-running-group\|data-resident-lease\|data-resident-ui-state\|chat-activity-tab\|chat-activity-inline" src/ e2e/` 全部命中**今天仍在的、互不相干的多套忙来源**（见下）。⇒ 提案 P3「单一活动坞」这一机制无人认领，不是重复。本条的真前置只有 `gap-activity-dock-unreachable-degradation`（AC-184）一条，由 frontmatter 的 `depends_on` 显式声明（**唯一**的 gating 面）：AC-188 的判据跑在 AC-184 建出的同一个 spec 文件 `e2e/activity-dock-truthful.spec.ts` 里、读的也是 AC-184 建出的 `[data-activity-dock]` 与 `data-activity-state`；在同一条坞与同一个文件上并发没有意义。AC-182/183 经 AC-184 自己的 `depends_on` 传递进来。

**现状读数（2026-10-01，读代码）。** 提案 §1 表 A4 与 §4.6 的 P3 正是本条：今天页面上的「活动」在**四个互不相干的来源**上各画各的——

- 桌面活动**页签**：`ActivityIndicator.tsx:120` 的 `.chat-activity-tab` 类（其注释逐字说 `tab` 是「挂在输入框顶沿上的页签状长条」），由 `ChatComposer.tsx:470-473` 在 `!isMobile` 时挂载。
- 移动**内联行**：`ActivityIndicator.tsx:109` 的 `data-slot="chat-activity-inline"`，由 `ChatMessagesPane.tsx:465-469` 在 `isMobile` 时挂载。两个视口是**两个不同的元素**（ActivityIndicator 顶部注释：「`tab` …；`inline` 是消息面板放在转写末尾的行」）。
- resident 状态栏的**忙闲**：`ResidentStatusBar.tsx` 的 `data-resident-ui-state` 来自 `readResidentProcessState`（`useSessionHosts.ts:318-331`：`host.state` 为 `busy`/`starting` 即返回 `busy`），数据源是 `/api/session-hosts` 的 **1 秒轮询**（`useSessionHosts.ts:32 REFRESH_INTERVAL_MS = 1000`）；**租约计数**是折叠条的 `data-resident-lease-summary`/`data-resident-lease-total` 与面板里的 `data-lease-kind`/`data-lease-count`。
- 侧栏**运行视图**的忙：`RunningView.tsx:59-63` 的 `listRunningSessionIds`/`listResidentIdleSessionIds`，读的是**同一份 1 秒轮询快照**，渲染 `[data-running-group="running"]` 与 `data-running-group-count`；侧栏徽标经 `useSidebarController.ts:155` 读同一个函数。
- **发送按钮**的停止态：`ChatComposer.tsx:844-845` 的 `isLoading ? onAbortSession`，由本地 `processingSessions` 表驱动（又一个来源）。

提案 §4.6「与现有表面的关系」的裁定：`ActivityIndicator`（桌面页签/移动内联行）→ **并入活动坞**，不再有独立的轮换文案；`ResidentStatusBar` 的「忙/闲/计数」→ **由坞的标题与计数取代**，它剩下的内容（地址与复制、pid、起停/关闭）**保留为坞展开面板底部的一行**；侧栏「运行中」视图 → 读**同一个** `SessionActivity` 的摘要；发送按钮的停止态 → 读 `turn.canInterrupt` 与连接状态。也就是**四个来源并成一个**。

**要做的事。** 在**真实浏览器、真实服务端、真实调试 agent 回合**上，把「活动」收敛成一个：单一活动坞（任一时刻恰有唯一 `[data-activity-dock]`），旧的独立页签与内联行两个选择器计数为 0；resident 状态栏不再输出自己的忙闲状态字样与租约计数（地址/pid/起停/关闭保留，移进坞的展开面板）；坞、侧栏运行视图、发送按钮停止态三处读**同一个**服务端权威活动来源，任何一次联合读数都不出现「坞说空闲而别处说忙」。桌面与移动两个视口**各读一次**。调试 agent 用一个 `unattended-turn` 把回合开着、再用它的对偶 `turn-end` 结束（两个 op 都已存在，见 `debug-agent.scenario.ts` 的 `DEBUG_AGENT_OPS`，无需扩展场景），一致性读数**覆盖回合结束后的窗口**。判据是 AC 的 `criterion:` 逐字命令 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`。

**开放的设计风险（留给实现，不写进 AC）。** AC-184 把坞挂在 `ActivityIndicator.tsx` 的两种出口上并加 `data-activity-dock`；本条要求「旧页签/内联行选择器计数为 0」且「恰有一个坞」。实现时必须把坞收敛成**一个挂载点**、并让旧标记（`.chat-activity-tab` 类与 `data-slot="chat-activity-inline"`）不再匹配——落点以实现时的真实接缝为准；既有的 `e2e/mobile-workspace-composer-layout.spec.ts:384-385,895,1091` 与 `src/modules/chat/tests/{activityIndicatorResponsive,chatComposerResponsive}.test.tsx` 正在断言这两个旧选择器可见，删标记会让它们红，必须同批更新（见 Touches）。侧栏的 `resident-idle` 分组仍可能需要 host 列表来列出被持有的进程行，但**忙/闲的分类**必须来自活动来源，不再来自 1 秒轮询——徽标与运行视图共用同一分类函数，必须一起改，否则坞、徽标、运行视图会互相矛盾。

## Plan

1. **红态先行。** 在 AC-184 建出的 `e2e/activity-dock-truthful.spec.ts` 里追加一个标题含 `AC-188` 的用例（判据用 `-g "AC-188"` 过滤），照 `e2e/resident-busy-send.spec.ts` 的形状起：`request.newContext()` 打 `POST /api/debug-agent/scenarios` 播种、`POST /api/debug-agent/clock` 走一个 `unattended-turn`（把回合开着）→ 取读数 → `turn-end`（把回合结束）→ 在 1 秒轮询刷新前的窗口内再取读数。**桌面与移动两个视口各跑一次**（同一用例里按 `viewport` 设两次，或分两个 project），两次读数都要打印。实现前该选择红（用例不存在）。
2. **单一坞构件。** 把活动坞收敛成**每页一个** `[data-activity-dock]`（桌面与移动各只挂一个，版面响应式），删掉旧页签/内联行两处独立挂载与它们的旧标记（`.chat-activity-tab`、`data-slot="chat-activity-inline"`）。落点以实现时的真实接缝为准；若需要动 `ChatComposer.tsx`/`ChatMessagesPane.tsx` 之外的文件，先加进 `## Touches`。
3. **状态栏并入坞。** `ResidentStatusBar.tsx` 不再渲染自己的忙闲状态字样与租约计数（`data-resident-ui-state` 的 busy/idle 呈现、`data-resident-lease-summary`/`data-resident-lease-total`、`data-lease-kind`/`data-lease-count` 的呈现都不再存在）；**保留并移进坞的展开面板**的是地址与复制、pid、起停/关闭（`data-resident-address`/`data-resident-pid-text`/`data-resident-copy`/`data-resident-start`/`data-resident-close` 这些控件语义去向）。
4. **同一来源。** 坞、`RunningView.tsx` 的运行分类、`ChatComposer.tsx` 的停止态都改读 AC-182/184 的服务端权威活动（`SessionActivity` 的回合/连接视图），**不再**让 1 秒 `/api/session-hosts` 轮询驱动任何忙/闲读数。徽标（`useSidebarController.ts`）与运行视图共用分类函数，一起改。
5. **文案。** 并入坞后需要的新/改文案键（状态栏事实并入坞面板的标题、无独立状态栏时的兜底等）加进 `src/modules/i18n/locales/*/chat.json` **全部 12 个**文件；缺一个则 i18n 完整性判据红。
6. **组件级单元判据（快速反馈）。** 新增 `src/modules/chat/tests/activityDockConsolidation.test.tsx`：喂一个回合中视图 ⇒ 页面里恰有**一个** `[data-activity-dock]`、旧页签/内联行选择器**计数为 0**、坞与一个假的「别处」读数同为回合中；喂空闲视图 ⇒ 三处同为空闲（**正控制**，证明确实渲染了坞而不是靠什么都不画来通过）。同步更新既有的 `activityIndicatorResponsive.test.tsx`、`chatComposerResponsive.test.tsx`、四个 `residentStatusBar*.test.tsx`（它们今天断言旧选择器/状态栏忙闲）。
7. **假形态（承重，先提交再变异，`git checkout -- <file>` 恢复，逐字登记变异 diff / 失败行 / 恢复命令）。** (i) **保留旧 `ActivityIndicator` 的挂载**（或保留 `.chat-activity-tab`/`data-slot="chat-activity-inline"` 标记）⇒ **数量读数必须红**（坞 > 1 或旧选择器 > 0）；(ii) **让状态栏继续读 1 秒轮询的 busy** ⇒ **一致性读数在回合刚结束的窗口内必须红**（坞已按推送回空闲而状态栏仍说忙）。任一条没红按「判据有洞」处理，先补判据（例如把读数窗口钉在 `turn-end` 之后、1 秒轮询尚未刷新到的区间，并确认该窗口在实测里真的存在）再加回。
8. **墙钟与登记。** 用例自己记起止并断言**用例体** ≤ `20_000`ms、整次调用在 `SINGLE_SPEC_CEILING_MS = 55_000`（`playwright.config.ts:317`）与 60 秒闸之内；`'activity-dock-truthful.spec.ts'` 已在 `DEBUG_AGENT_SPEC_FILES`（AC-184 登记），本条只读确认，不重复登记。
9. **静态门与对齐。** `npm run typecheck`、`npm run lint`、`npx tsc --noEmit -p server/tsconfig.json` 均退出 0；跨模块 import 走 barrel，并遵守 `.agents/skills/backend-module-standards/SKILL.md`（server/）与 `.agents/skills/frontend-module-standards/SKILL.md`（src/）；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 退出 0，`--list` 列出该用例。红态基线：实现前该选择红（用例不存在）。
- [x] AC2 单一坞（承重）：任一时刻页面里 `[data-activity-dock]` 的计数**恰为 1**（桌面与移动各读一次，打印 `dock.count.desktop` / `dock.count.mobile`）。
- [x] AC3 旧表面消失（承重）：`.chat-activity-tab` 与 `[data-slot="chat-activity-inline"]` 两个选择器在页面里的计数**都为 0**（打印 `legacy.tab`、`legacy.inline`）。
- [x] AC4 状态栏并入（承重）：resident 会话上不再有独立的忙闲状态字样与租约计数（读 `data-resident-ui-state` 的 busy/idle 呈现、`data-resident-lease-summary`/`data-resident-lease-total`、`data-lease-kind`/`data-lease-count` ⇒ 计数为 0）；**且**地址、pid、起停/关闭仍在（并入坞的展开面板，逐字打印这些控件的存在读数，证明是「并入」而不是「整块删掉」）。
- [x] AC5 三处一致（承重）：回合开着期间，坞为回合中（`data-activity-state` ∈ 回合中集合）、侧栏运行视图把该会话计入 `[data-running-group="running"]`、发送按钮为停止态（逐字读 `disabled`/aria，不是读 class）——三处读数在同一次采样里一致。打印 `consistency.turn={dock,sidebar,send}`。
- [x] AC6 回合结束后一致回到空闲（承重）：`turn-end` 之后，坞回到空闲、侧栏运行视图不再计入、发送按钮回到非停止态；**且**在 `turn-end` 之后到 1 秒轮询刷新前的窗口里逐次采样，任何一次读数都**不出现**「坞说空闲而别处说忙」（打印该窗口内的 `consistency.afterTurn=[…]`）。
- [x] AC7 双视口：桌面与移动两个视口**各读一次**，AC2–AC6 的读数两视口都成立（打印两组）。
- [x] AC8 墙钟：用例体实测 ≤ `20_000`ms（打印 `dock.wall=…ms`），整次调用在 55s/60s 闸内退出 0。
- [x] AC9 取假形态必须红（承重）：(i) 保留旧 `ActivityIndicator` 的挂载 ⇒ AC2 或 AC3 红；(ii) 让状态栏继续读 1 秒轮询的 busy ⇒ AC6 在回合刚结束的窗口内红。逐条记录变异 diff、逐字失败行与恢复命令；任一条没红按「判据有洞」处理，先补判据。
- [x] AC10 静态门与登记：`npm run typecheck`、`npm run lint`、`npx tsc --noEmit -p server/tsconfig.json`、`npx vitest run src/modules/chat/tests/` 均退出 0；`'activity-dock-truthful.spec.ts'` 在 `DEBUG_AGENT_SPEC_FILES` 内（AC-184 登记，本处只读确认）；`git diff --stat` 只落在 `## Touches` 列出的文件上（新增文件用 ASCII `(new)`）。

## DoD

- 判据驱动的是**真实服务端、真实应用、真实调试 agent 回合**：读数来自 `npx playwright test` 起的真实 webServer + Vite 客户端 + 调试 agent 的 `unattended-turn`/`turn-end`，不接受 in-page 替身、不接受 stub 掉 socket、不接受由 spec 自己往 DOM 写 `data-activity-dock`/`data-activity-state`、不接受把坞读数换成读某个内部 React state。
- **只有一个坞**：任一时刻 `[data-activity-dock]` 计数为 1，且旧的独立活动页签与内联行两个选择器计数为 0——不是把旧构件 `display:none`、也不是靠 CSS 隐藏。
- **状态栏不再有第二套忙闲**：它自己的忙闲状态与租约计数在页面上不存在；地址/pid/起停/关闭仍在（并入坞的展开面板）——要求「仍在」是为了证明是**并入**而不是**删掉**。
- **同一来源**：坞、侧栏运行视图（及徽标）、发送按钮停止态的忙/闲分类都来自服务端权威活动，**没有一处**再读 1 秒 `/api/session-hosts` 轮询来判忙闲（用 grep 证明忙闲判定不接轮询；轮询若仍用于列出被持有的进程行，其读数不得参与忙/闲分类）。
- **任何时刻不出现坞说空闲而别处说忙**：回合结束后的窗口内逐次采样都一致。
- 桌面与移动两个视口都成立；只在一个视口通过不算。
- 遵守 `.agents/skills/backend-module-standards/SKILL.md`（server/）与 `.agents/skills/frontend-module-standards/SKILL.md`（src/）。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- e2e/activity-dock-truthful.spec.ts
- e2e/mobile-workspace-composer-layout.spec.ts
- e2e/resident-running-view.spec.ts
- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/ResidentStatusBar.tsx
- src/modules/chat/utils/activityDockView.ts
- src/modules/sidebar/RunningView.tsx
- src/modules/sidebar/hooks/useSidebarController.ts
- src/modules/sidebar/SidebarHeader.tsx
- src/shared/hooks/useSessionHosts.ts
- src/modules/chat/hooks/useActivityFreshness.ts
- src/modules/chat/tests/hostSnapshotFailure.test.ts
- src/modules/sidebar/tests/sessionTitleSurfaces.test.tsx
- src/shared/types.ts
- src/modules/chat/tests/activityDockConsolidation.test.tsx (new)
- src/modules/chat/tests/activityIndicatorResponsive.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/modules/chat/tests/residentStatusBarLeaseSummary.test.tsx
- src/modules/chat/tests/residentStatusBarStartRefusal.test.tsx
- src/modules/chat/tests/residentStatusBarCloseReachable.test.tsx
- src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- tasks/gap-activity-single-dock-global-consistency.md（自触）

## Falsification record (AC9)

Both fake forms were run against the criterion `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`, with the mutation applied in the worktree and reverted with `git checkout -- <file>`. The diffs are kept beside this run at `/tmp/ac188-falsification/fake-i.diff` and `/tmp/ac188-falsification/fake-ii.diff`.

**(i) the pre-consolidation markers come back.** `src/modules/chat/composer/ActivityIndicator.tsx`: the surface regains `chat-activity-tab` and the dock root regains `data-slot="chat-activity-inline"` — the two markers the tab and the inline line published before the consolidation.

  - readings: `dock.count.desktop=1 legacy.tab=1 legacy.inline=1` and `dock.count.mobile=1 legacy.tab=1 legacy.inline=1`
  - failure line: `Error: desktop: the old tab class and the inline slot must not match anything` (AC3, both tiers)
  - restore: `git checkout -- src/modules/chat/composer/ActivityIndicator.tsx`

**(ii) the busy/idle classification goes back to the one-second host poll.** `src/modules/sidebar/RunningView.tsx`: the running set is derived from the `turn` leases in the `/api/session-hosts` listing instead of the page's activity map.

  - readings: `consistency.turnOpen` is `{"dock":"idle","sidebar":true,"send":"send"}` on **every** sample of the window
  - failure line: `Error: while the turn is opening, no sample may show the dock at rest while the sidebar or the send button says busy` (the turn-open agreement reading, `+ Received + 102`)
  - restore: `git checkout -- src/modules/sidebar/RunningView.tsx`

**One correction to the task's own reading of where that window is.** The AC9 parenthetical places fake (ii)'s red in "the window just after the turn ends". Measured, that is not where the two sources can disagree: `turn-end` releases the host's turn *lease* at once, the one-second poll observes it within a beat, and the page's activity entry clears on the client's own schedule — so at the end of a turn the poll-driven sidebar is *ahead* of the dock, never behind it, and a criterion written only for that window cannot go red. The window where the two sources really diverge is the **start** of a turn: the lease is reported immediately while a page that subscribed before the turn existed learns about the run from the client's five-second sync of the run registry. That is the window `consistency.turnOpen` samples, and it is the reading fake (ii) reds. The turn-end window AC6 names is still sampled and asserted (`consistency.afterTurn`), it is simply not the one that can fail.

**A pre-existing red, recorded so it is not attributed here.** `-g "AC-185"` in this same file fails at `transcript.userRows=[2]` ("the retried text is exactly one user row, never two"), and it fails identically on the untouched checkout at `/data/home/yale/work/claudecodeui` (same reading, same line). It is not caused by this task; AC-184 and AC-188 both pass on this branch.
