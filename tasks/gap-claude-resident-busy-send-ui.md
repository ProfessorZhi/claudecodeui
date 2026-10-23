---
id: gap-claude-resident-busy-send-ui
title: AC-175 真实浏览器里常驻会话忙时发送直接送达 — resident 忙时 chat.send 不吃
  QueuedMessageCard、消息立即进记录并标「将在当前回答结束后处理」，未出队带 [撤回]（点击后替身场景收到该 uuid 的
  cancel_async_message）、只在收到 command_lifecycle cancelled
  后显示「已撤回」并把该消息从记录移除且不产生一轮，started 后 [撤回] 消失改「已开始处理」，per-run 忙时仍出现
  QueuedMessageCard；三条假形态（仍本地排队 / 撤回只在前端隐藏 / 点击即标已撤回）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-api-smoke-human-gate
  - gap-lifecycle-mode-matrix-and-host-api
  - gap-claude-resident-status-bar
  - gap-claude-resident-busy-input
  - gap-debug-agent-host-driver
goal_ac: AC-175
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-175" tasks/*.md | wc -l` → **0**；`grep -rn "AC-175" tasks/*.md | wc -l` → **12**，分布在 7 个文件里，**逐处核对全部是边界话或让位**，没有一条认领：`tasks/gap-claude-resident-status-bar.md:57` 把「AC-175 的忙时直发与撤回（`QueuedMessageCard` / `cancel_async_message`）」逐字列进**非目标**；`tasks/gap-claude-resident-running-view.md:50` 与 `tasks/gap-claude-resident-shell-tab.md:51` 同样把「AC-175 的忙时直发与撤回」逐字列进非目标；其余命中（`gap-claude-resident-api-smoke-human-gate:26`「AC-171–175 的 UI 派工任务」、`gap-claude-resident-consent-gate:38`「AC-171–175」、`gap-claude-resident-unattended-turn:22`「AC-162…AC-175」、`gap-debug-agent-host-driver:27/54/141`「GOAL-013 的 AC-162…AC-175」）都是范围边界话。按机制词再扫：`grep -rl "resident-busy-send" tasks/ e2e/ | wc -l` → **0**；`ls e2e/resident-busy-send.spec.ts` → `No such file or directory`。代码侧：`grep -rn "command_lifecycle\|cancel_async_message" server/ src/ shared/ --include=*.ts --include=*.tsx | wc -l` → **0**；`grep -rn "将在当前回答结束后处理\|已开始处理" src/ server/ | wc -l` → **0**；`grep -rn "lifecycle_mode" server/ src/ --include=*.ts | wc -l` → **0**。今天在位的只有**要被打掉的那条路**：`src/modules/chat/composer/QueuedMessageCard.tsx` + `src/modules/chat/hooks/useChatComposerState.ts` 的 `queuedDraft`（前端本地排队，`:682`/`:731` 无条件入队）。⇒ AC-175 无认领者，本条不是重复。

**来源与判据物。** 判据逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`：`npx playwright test e2e/resident-busy-send.spec.ts`（命令逐字含文件路径，不用 glob）。红态基线（本轮**直跑**，读数不是推断）：`npx playwright test e2e/resident-busy-send.spec.ts --list` 退出 **1**，stdout 逐字 `Error: No tests found.` 与 `Total: 0 tests in 0 files`；同一跑的并列读数 `[e2e] server=10351 client=20461` 说明 harness 本身起得来，红只因判据文件不存在。

**本条认证的是哪一格。** GOAL-013 的阶段 5 前端（proposal §15.7「运行中发送」，`docs/proposals/claude-resident-sessions.md:496-501`）与前端那一台撤回状态机：常驻会话忙时发送**不走** `QueuedMessageCard`，消息立即进记录并标「将在当前回答结束后处理」；未出队时带 [撤回]，点它要**真的**把 `cancel_async_message` 送到宿主，成败**只**看随后 `command_lifecycle` 的 `cancelled` 事件（不是控制响应）；收到 `cancelled` 才提示「已撤回」并把该消息从记录移除、不产生一轮；`started` 之后 [撤回] 消失、改「已开始处理」；per-run 会话维持 `QueuedMessageCard`。**服务端那一侧的机制不由本条重造**：忙时不上报 `RUN_IN_PROGRESS` 的写入路径与撤回 verb 是 AC-163 的（见下）。本条把浏览器里看得见的那一段做完，并用调试 agent 的常驻场景作**替身**在真 Chromium 上取数（AC 的 origin 逐字：「调试 agent 扩展出的常驻场景作 UI e2e 替身」）。

<!-- dedup-ref --> **真前置（关系边已写成顶层 `depends_on`，本段只作溯源）**：`gap-claude-resident-api-smoke-human-gate`（`goal_ac: AC-170`，status=todo）—— AC-170 的 `expect` 逐字「UI 相关 AC（AC-171 至 AC-175）的派工任务以本条对应的任务为前置」；人 yale 在 `docs/proposals/claude-resident-sessions-smoke.md` 写下 `冒烟验收：通过` 之前，本条不得开工。`gap-lifecycle-mode-matrix-and-host-api`（`goal_ac: AC-169`，status=todo）—— 本条要读的「这个会话是不是常驻」是它落的 `sessions.lifecycle_mode`（读回投影与字段名）与能力矩阵里 claude 的 `'resident'` 取值；没有它，「resident 走直发 / per-run 走本地排队」这条分支就**没有判据来源**，而假形态 (a) 与第 (4) 条的**分辨力**正长在这条分支上。`gap-claude-resident-status-bar`（`goal_ac: AC-172`，status=todo）—— 它落 `playwright.config.ts` 的调试 agent 门控接缝与「常驻但未运行 / 忙」在**出厂控制面**上的可达性（`server/index.ts` 注入 `openRun`、`src/shared/api.ts` 与其上的读路径）；本条判据要的「会话忙」与「会话是常驻」两条读数都从这条链来，本条**不得**在前端另写第二份宿主取数。`gap-claude-resident-busy-input`（`goal_ac: AC-163`，status=todo）—— 它落忙时 `chat.send` 不再返回 `RUN_IN_PROGRESS` 的服务端路由、`command_lifecycle` 的解析（`command_uuid` 与四态）、以及撤回 verb 与 `cancel_async_message` 控制帧的写入缝；本条判据 (1) 的「忙时不拒、直接送达」与 (2) 的「替身场景收到 cancel_async_message」都长在它落的东西上，本条**只消费**，不另写第二条撤回路径。`gap-debug-agent-host-driver`（`goal_ac: AC-160`，status=**done**）—— 调试 agent 的 `hostDriver` facet（`submit`/`interrupt`/`closeHost`）、`unattended-turn` op 与经 manager → registry → 真实归一化 → writer 的帧通道，本条的替身场景扩展的正是它。（`gap-claude-resident-unattended-turn`（AC-162）与 `gap-claude-resident-addressable`（AC-164）与本条机制不相交：前者是真实 Claude driver 的无人轮，本条要的「无人轮进行中」由替身已有的 `unattended-turn` op 造；后者是 SendMessage 地址与改名。都不加边。）

**硬边界（设计约束，完成记录必须写明走的是哪条路）。** ADR-003 decision 7 的静态守卫（`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`，AC-126）扫 `server/modules/debug-agent/**` 的**非 tests** 源码，禁止其中出现 wire 帧/事件名字面量，并要求该模块真的引用产品的归一化入口：替身只能写**方言行**，客户端看到的帧必须由产品自己的归一化产出（`debug-agent.runtime.ts` 自己的注释也是这么写的：它决定 WHAT a row looks like，wire 形状是 `sessions.normalizeMessage` 的产物）。所以「场景发出 `command_lifecycle` 帧」**不能**靠在调试模块里构造帧实现——**行 → 帧的映射**（以及 `command_lifecycle` 是新增一个客户端可见事件种类，还是搭在既有的 run/消息投影上）是本条第 4 步要量并落定的设计点。第二条硬边界：**不改窄 per-run 的逐帧契约**——`server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 钉住 per-run 忙时**恰好一条** `RUN_IN_PROGRESS`，AC-126 守卫与既有 debug-agent 判据逐条仍绿。

## Plan

1. **量前置落地后的实际形状**（任一未落地时判据**点名拒绝**、缺哪件就打印哪件，不写假读数）：`sessions.lifecycle_mode` 的字段名与客户端读回投影；`GET /api/session-hosts` 投影里宿主 mode / state / 忙态的字段名；AC-163 落的撤回 verb 名与入参（uuid 从哪来）以及它解析出的 `command_lifecycle` 实际字段名；AC-163 落的忙时 `chat.send` 分支的实际形状。把它们钉进前端与判据，不按 proposal 的规划文字猜。
2. **量 AC-172 落的替身能力**：`debug-agent.routes.ts` 的按会话装填（`POST /scenarios` + `POST /clock`）今天能不能把会话绑成**常驻宿主**并置于**忙**（读宿主快照的 `state`）；读不到就**点名**缺口并停在登记处（那是 AC-172 的范围），不自造第二份。
3. **忙时直发的客户端分支**：`src/modules/chat/hooks/useChatComposerState.ts` 的 `queuedDraft` 对常驻会话**不入队**、直接 `chat.send`；per-run 逐字不变（`QueuedMessageCard` 仍在）。「是不是常驻」只读第 1 步量到的**单一来源**，不另算一遍（假形态 (a) 在这一层承重）。
4. **帧通道**：让 `command_lifecycle` 的 `queued` / `started` / `cancelled` / `completed`（含 `command_uuid`）经**产品自己的归一化 → run writer → 客户端**到达浏览器（`server/modules/providers/list/claude/claude-sessions.provider.ts` 的方言归一化，必要时 `server/modules/providers/services/sessions.service.ts` 与两侧 `shared/types.ts` 的事件种类）；替身场景侧只加**方言行**与 op（`debug-agent.scenario.ts` 的闭集校验与拒绝文案同步），并让它**记录收到的 `cancel_async_message`**（读回给判据）。「行→帧」落定后**逐字打印**它满足 ADR-003 decision 7 的理由。
5. **客户端状态机**：`src/modules/chat/hooks/useChatRealtimeHandlers.ts`（必要时 `useChatMessages.ts` / `useSessionStore.ts`）按 uuid 维护「排队中 / 已出队 / 已撤回」三态；**未收到 `cancelled` 之前不显示「已撤回」**（假形态 (c) 在这一层承重），发 `started` 后 [撤回] 消失并改「已开始处理」。
6. **记录区渲染**：新组件承载「消息 + 标注 + [撤回]」三态（未出队：「将在当前回答结束后处理」+ [撤回]；已出队：「已开始处理」，无 [撤回]；已撤回：提示「已撤回」后该消息**从记录移除**且不产生一轮）。**不得**复用 `QueuedMessageCard` 的皮——AC 逐字要求常驻会话不吃它。
7. **撤回动作**：点 [撤回] 走 AC-163 的 verb（uuid 逐字用该消息自己的）；**成败只看随后的 `command_lifecycle state=cancelled`**，**绝不读** `control_response`（E9 9.2：仍在队列里 / 已被处理完 / uuid 不存在三种时机**都没有** `control_response`；假形态 (b) 的判据面在这一层）。
8. **12 个 locale 的 `chat.json` 文案**（标注、[撤回]、「已撤回」、「已开始处理」）。
9. **判据 `e2e/resident-busy-send.spec.ts`**（真 Chromium + 真后端 + 替身场景）：(1)(2)(3)(4) 四条读数各一条断言，并配正/负控制（见 AC）；文案取自**运行期读的** `src/modules/i18n/locales/en/chat.json`，spec 里不抄句子；打印整体墙钟并断言 `< 55_000`。
10. **三条假形态承重变异**各做一次并登记（变异 diff、失败断言逐字、退出码），各自恢复后判据回到 0：(a) 常驻会话仍走本地排队 ⇒ (1) 红；(b) 撤回只在前端隐藏（不发 `cancel_async_message`，或忽略 `cancelled` 直接标已撤回）⇒ (2) 红；(c) 点击后立即显示「已撤回」而不等 `cancelled` ⇒ 场景不发 `cancelled` 时读到「已撤回」⇒ (2) 红。
11. **收尾**：`npm run lint` / `npm run typecheck` 退出 0；`npx playwright test --list` 的收集总数与改动前**逐字相同**；`git diff --stat` 与 Touches 逐条对齐；写完成记录（含每条读数与三条假形态的实测退出码/红文案）。

## AC

- [x] AC1 判据入口为绿：`npx playwright test e2e/resident-busy-send.spec.ts` 在落地后的树上退出 **0**，并打印整体墙钟 `elapsed=<n>ms` 且 `< 55_000`（`playwright.config.ts` 的 `SINGLE_SPEC_CEILING_MS`）。红态基线（本轮**直跑**）：`npx playwright test e2e/resident-busy-send.spec.ts --list` 退出 **1**，逐字 `Error: No tests found.` / `Total: 0 tests in 0 files`。命令逐字含文件路径，不用 glob。
- [x] AC2 (1) 常驻忙时发送不出现 `QueuedMessageCard`、消息立即进记录并带标注：判据打印 `resident.queuedCard=<n>`（断言 **0**）、`resident.row.present=true`、`resident.row.annotationKey=<key>` 与 `resident.row.annotation=<逐字文案>`（断言取自 `en/chat.json` 的 key，spec 不抄句子）。**正控制**：同一次运行里 per-run 会话忙时发送 ⇒ 打印 `perRun.queuedCard=<n>` 且 `>= 1`（证明 `resident.queuedCard=0` 不是恒真）。
- [x] AC3 (2) 出队前撤回**真的**送到宿主，且只在 `cancelled` 后算撤回：判据打印 `withdraw.visibleBefore=true`、`click.dispatched=true`、`cancelPayloads=<n>`（断言 **>= 1**）、`scenario.cancel_async_message=<uuid>`（断言与消息自身的 uuid **逐字相同**）、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`（从记录移除）、`turnsAfterWithdraw=0`（不产生一轮）。
- [x] AC4 (3) 出队后 [撤回] 消失、改「已开始处理」：判据打印 `afterStarted.withdrawButton=<n>`（断言 **0**）与 `afterStarted.label=<逐字文案>`（断言取自 `en/chat.json` 的 key）；**负控制**：出队前一刻 `beforeStarted.withdrawButton=<n>` 且 `>= 1`（证明 [撤回] 的出现与消失都不是常量）。
- [x] AC5 (4) per-run 会话忙时仍出现 `QueuedMessageCard`：判据打印 `perRun.queuedCard=<n>`（断言 **>= 1**）与它的文案 key 来自 `en/chat.json` 的既有 key；**正控制**：同一次运行里常驻那条腿打印 `resident.queuedCard=0`（AC2 已有；两条腿互为正/负控制）。
- [x] AC6 撤回成败不读控制响应：判据打印 `controlResponsesForCancel=<n>` 与 `cancelVerdictSource=command_lifecycle`；断言撤回的成败判定**不**来自控制响应（E9 9.2：三种时机都没有 `control_response`）。
- [x] AC7 假形态承重（三条，各自实测）：(**a**) 让常驻会话仍走本地排队 ⇒ 判据命令退出**非 0**，红**落在 AC2 的 `resident.queuedCard === 0` 那条断言**上；(**b**) 让撤回只在前端隐藏（不发 `cancel_async_message`）⇒ 退出**非 0**，红**落在 AC3 的 `cancelPayloads >= 1` / `scenario.cancel_async_message` 那条断言**上；(**c**) 让点击后立即显示「已撤回」而不等 `cancelled` ⇒ 场景不发 `cancelled` 时判据读到 `ui.withdrawnBeforeEvent=false` 那条断言红。三次变异各登记 diff、失败断言逐字、退出码，使用后各自 `git checkout --` 还原到绿。
- [x] AC8 替身改动不波及别的判据：`npx playwright test --list` 的收集总数与改动前**逐字相同**（打印改动前后两个数）；`npx playwright test e2e/model-env-kind-explanations.spec.ts` 仍退出 **0**（打印退出码与墙钟）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`（AC-126）与 `…/debug-agent-host-driver.test.ts` 各自退出 **0**（逐条打印命令与退出码）。
- [x] AC9 per-run 逐帧契约不被改窄：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 退出 **0**（它钉住 per-run 忙时**恰好一条** `RUN_IN_PROGRESS`），打印退出码。
- [x] AC10 契约面：`npm run typecheck`、`npm run lint` 退出 **0**；若第 4 步决定新增客户端可见事件种类，`server/shared/types.ts` 与 `src/shared/types.ts` 里 `MessageKind` 的落法逐字打印，且既有成员一个不少（打印改动前后成员数）。
- [x] AC11 如实登记：完成记录写明（a）第 1/2 步量到的实际字段名与入口名，以及哪一件尚未落地（若有则**点名拒绝**，不写假读数）；（b）`command_lifecycle` 从替身到浏览器走的是哪条路、为什么它满足 ADR-003 decision 7 的守卫（逐字打印「行→帧」位置）；（c）三条假形态的实测退出码与红态文案；（d）未实现（明确不在本条内）：AC-163 的 driver 侧写入与撤回缝、AC-162 的真实 Claude driver 无人轮、AC-165 的空闲关闭。

## DoD

判据在**落地后的树**上按原命令（`npx playwright test e2e/resident-busy-send.spec.ts`）重跑：退出码 0、墙钟 `< 55_000`、无 `skipped`。**真实落地**（不是「测试存在」）：判据真的起真 Chromium + 真后端 + 调试 agent 的**常驻**替身场景，真的让一个常驻会话处于忙（含无人轮进行中），真的 `chat.send` 推入一条消息——这条消息真的**没有**渲染成 `QueuedMessageCard`（同名正控制：同一次运行里的 per-run 会话**有**），真的立即出现在记录里并带「将在当前回答结束后处理」；真的点 [撤回]，替身场景**真的收到**该 uuid 的 `cancel_async_message`（判据读到原文），界面在真收到 `command_lifecycle cancelled` **之前**不显示「已撤回」、**之后**显示并把该消息从记录移除、且不产生一轮；`started` 之后 [撤回] 消失、改「已开始处理」。三条假形态各有实测变异与红态文案：仍本地排队 ⇒ (1) 红；撤回只在前端隐藏 ⇒ (2) 红（场景零 `cancel_async_message`）；点击即标已撤回 ⇒ (2) 红（未收到 `cancelled` 就读到「已撤回」）。AC-126 守卫、既有 debug-agent 判据、per-run 逐帧契约判据逐条仍绿；`npx playwright test --list` 的收集总数与改动前逐字相同。完成后 AC-175 在驱动器下一轮经 `goal_ac: AC-175` 独立复跑时由红翻绿——且这次翻绿有分辨力：per-run 的 `QueuedMessageCard` 正控制、出队前 [撤回] 的存在、`cancelled` 前后两态的三组读数，各有对照组。

## Touches

- `e2e/resident-busy-send.spec.ts` (new)
- `playwright.config.ts`
- `server/modules/debug-agent/debug-agent.scenario.ts`
- `server/modules/debug-agent/debug-agent.engine.ts`
- `server/modules/debug-agent/debug-agent.runtime.ts`
- `server/modules/debug-agent/debug-agent.routes.ts`
- `server/modules/debug-agent/debug-agent.provider.ts`
- `server/modules/debug-agent/debug-agent.host-driver.ts`
- `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`
- `server/modules/session-hosts/session-host-manager.service.ts`
- `server/modules/providers/list/claude/claude-sessions.provider.ts`
- `server/modules/providers/services/sessions.service.ts`
- `server/modules/providers/services/provider-runtime.service.ts`
- `server/shared/types.ts`
- `src/shared/types.ts`
- `src/shared/api.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/hooks/useChatRealtimeHandlers.ts`
- `src/modules/chat/hooks/useChatMessages.ts`
- `src/modules/chat/hooks/useSessionStore.ts`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/composer/QueuedMessageCard.tsx`
- `src/modules/chat/transcript/PendingResidentMessage.tsx` (new)
- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/i18n/locales/de/chat.json`
- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/es/chat.json`
- `src/modules/i18n/locales/fr/chat.json`
- `src/modules/i18n/locales/id/chat.json`
- `src/modules/i18n/locales/it/chat.json`
- `src/modules/i18n/locales/ja/chat.json`
- `src/modules/i18n/locales/ko/chat.json`
- `src/modules/i18n/locales/ru/chat.json`
- `src/modules/i18n/locales/tr/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/locales/zh-TW/chat.json`
- `tasks/gap-claude-resident-busy-send-ui.md`（自触）

（`server/index.ts` 或 `chat-websocket.service.ts` 若因 AC-163 落的注入点与实际不符而必须动，按实际文件登记并在完成记录里写明；不预列以免 Touches 与写入面漂移。）

## 完成记录（2026-09-28）

**判据与读数。** 判据 `e2e/resident-busy-send.spec.ts`（3 test：主判据 + 12 locale 文案 + 墙钟上限），真 Chromium + 真后端 + 调试 agent 的**常驻**替身场景。落地后的树上按原命令直跑：

- **AC1**：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**，`3 passed (35.4s)`，打印 `elapsed=35402ms`（< `SINGLE_SPEC_CEILING_MS=55_000`）。红态基线（本轮直跑，不是推断）：把判据文件移出树后再跑 `npx playwright test e2e/resident-busy-send.spec.ts --list`，退出 **1**，stdout 逐字 `Error: No tests found.` 与 `Total: 0 tests in 0 files`。
- **AC2**：`resident.queuedCard=0`（断言 **0**）、`resident.row.present=true`、`resident.row.annotationKey=resident.pending.annotation`、`resident.row.annotation=Will be handled after this answer finishes`（取自**运行期读的** `en/chat.json`，spec 不抄句子）。正控制同一次运行 `perRun.queuedCard=1`。
- **AC3**：`withdraw.visibleBefore=true`、`click.dispatched=true`、`cancelPayloads=1`、`scenario.cancel_async_message=34b26641-5685-405c-b2ed-8a9bf3f9b8d8`（与该消息自身 uuid 逐字相同）、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`row.textAfter="Withdrawn"`、`turnsAfterWithdraw=0`；对照 `turns.control=1` 证明计数法数得到真跑过的那一轮。
- **AC4**：`afterStarted.withdrawButton=0`、`afterStarted.annotationKey=resident.pending.started`、`afterStarted.label=Started processing`（取 `en/chat.json` 的 `resident.pending.started`）；负控制 `beforeStarted.withdrawButton=1`。
- **AC5**：`perRun.queuedCard=1`，文案为既有 key `input.queue.label`（`perRun.card.label=Queued`）与 `input.queue.willSend`（`perRun.card.text="QUEUED · Will send when this finishes draft three — this one waits for the browser"`，`QueuedMessageCard` 用 `uppercase` 画 label，故该 key 的比对折大小写、draft 与 `willSend` 逐字不折）。
- **AC6**：`controlResponsesForCancel=0`、`cancelVerdictSource=command_lifecycle`；并列读数 `cancelAckFrames=1`（撤回的答复帧是 `queued_input_cancel_result`，不是 `control_response`）。
- **AC8**：`npx playwright test --list` 收集总数改动前后**逐字相同**，两次都是 `Total: 75 tests in 16 files`（两次收集只差 `playwright.config.ts` 有没有本条的改动：本条把 `resident-status-bar.spec.ts` 与 `resident-busy-send.spec.ts` 列进调试 agent fixture home 的判据集，该改动不改变收集面）；`npx playwright test e2e/model-env-kind-explanations.spec.ts` 退出 **0**（`1 passed (10.2s)`）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` 退出 **0**（`tests 5 / pass 5 / fail 0`）；`…/debug-agent-host-driver.test.ts` 退出 **0**（`tests 5 / pass 5 / fail 0`）。
- **AC9**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 退出 **0**（`tests 5 / pass 5 / fail 0`），per-run 忙时仍恰好一条 `RUN_IN_PROGRESS`，逐帧契约未改窄。
- **AC10**：`npm run typecheck` 退出 **0**（三环 `tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 各 0）；`npm run lint` 退出 **0**（只有既有的 warning）。`MessageKind` 两处各新增一个成员，落法逐字：`server/shared/types.ts` **15 → 16**（末位 `  | 'command_lifecycle';`）、`src/shared/types.ts` **15 → 16**（同一末位），既有 15 个成员一个不少（`git show df558ecc^:<file>` 对比，改动前末位是 `| 'task_notification';`）。

**(a) 第 1/2 步量到的实际名字（不是 proposal 的规划文字）。**

- 会话生命周期：DB 列 `sessions.lifecycle_mode`（`server/modules/database/schema.ts:186`，`TEXT DEFAULT 'per-run'`）；`GET /api/session-hosts` 的 `sessions[]` 投影逐字 `{ appSessionId, provider, mode }`（`server/index.ts:280-284`，`mode: (session.lifecycle_mode ?? 'per-run') as HostMode`），进程在 `hosts[]`；前端**单一来源**是 `findSessionHostState(hostsSnapshot, sessionKey)?.lifecycleMode === 'resident'`（`src/modules/chat/hooks/useChatComposerState.ts:705`，`useSessionHosts` 把 `mode` 投影成 `lifecycleMode`）——前端没有第二份宿主取数。
- 宿主忙态：`hosts[].state`（`'busy' | 'starting' | …`），UI 词表在 `src/shared/hooks/useSessionHosts.ts:228-233`；状态条把它画成 `data-resident-ui-state`（`src/modules/chat/transcript/ResidentStatusBar.tsx:160`），判据即读这个属性。
- AC-163 落的撤回 verb：**`chat.cancel-queued`**，入参 `{ sessionId, messageUuid }`（路由 `server/modules/websocket/services/chat-websocket.service.ts:783` → `handleChatCancelQueued:519` → `runtime.cancelQueuedInput(provider, sessionId, messageUuid)` → 宿主驱动 → 替身的 `cancel-ack` op）。
- `command_lifecycle` 的方言字段逐字 `command_uuid` 与 `state`（四态；行类型常量 `COMMAND_LIFECYCLE_ROW_TYPE = 'command_lifecycle'`，`server/shared/types.ts:2328`，状态读数 `readCommandLifecycleState`）；替身场景的 op 名 `unattended-turn` / `dequeue` / `cancel-ack` / `turn-end` 取自 `debug-agent.scenario.ts` 的闭集（非法 op 与该文件的拒绝文案同步）。
- **前置落地情况**：本轮逐条查状态，AC-170（`gap-claude-resident-api-smoke-human-gate`）、AC-169（`gap-lifecycle-mode-matrix-and-host-api`）、AC-172（`gap-claude-resident-status-bar`）、AC-163（`gap-claude-resident-busy-input`）、AC-160（`gap-debug-agent-host-driver`）**五条全部 `done`**，没有一件缺失，**无点名拒绝项**。

**(b) `command_lifecycle` 从替身到浏览器走的是哪条路，为什么满足 ADR-003 decision 7。**

替身只写**方言行**，不构造帧：`server/modules/debug-agent/debug-agent.provider.ts` 的 `acceptPushedCommand`（`:209`）铸 uuid、把 uuid 登记进宿主队列（`registerPushedCommand`），再用 `buildCommandLifecycleRow({ …, state: 'queued' })` 造一行，行交给 `input.forwardFrames({ transformedMessage: row, sessionId, normalizeMessage: input.context.normalizeMessage, writer: input.writer })`（**`:227`**）；`started` / `cancelled` 行同理，由引擎的 `dequeue` / `cancel-ack` 步骤经 `server/modules/debug-agent/debug-agent.engine.ts:238` 的同一个 `forwardFrames` 出口。**「行 → 帧」的唯一位置是产品自己的归一化器**：`server/modules/providers/list/claude/claude-sessions.provider.ts:742-763` —— `raw.type === COMMAND_LIFECYCLE_ROW_TYPE || (raw.type === 'system' && raw.subtype === COMMAND_LIFECYCLE_ROW_TYPE)` 且 `readCommandLifecycleState(raw.state)` 与 `raw.command_uuid` 都非空时，产出 `kind: 'command_lifecycle'` + `commandUuid` + `commandState`，随后由 run writer 出到 socket。守卫的两半因此逐字成立：调试模块的非 tests 源码里没有一处写 wire 帧名或 `kind` 字面量（本轮该模块的改动全是**方言行**与 op），而行也确实走产品的归一化入口——`debug-agent-vocabulary-guard.test.ts` 仍绿（见 AC8）。协议面只**新增**一个客户端可见事件种类 `command_lifecycle`（两侧 `MessageKind` 各 +1，见 AC10），既有种类与 per-run 的逐帧契约未动（AC9）。

**(c) 三条假形态（各自实测，登记 diff 后用 `git checkout --` 还原到绿）。**

- **(a) 常驻会话仍走本地排队**：把 `src/modules/chat/hooks/useChatComposerState.ts:705` 的 `busySendToResidentProcess` 整个表达式替换为 `false`（等价于「常驻例外从未加过」）。判据退出 **1**，红**落在 AC2 那条断言**，逐字：`Error: a resident session must not fall back to the browser's own queue` / `expect(received).toBe(expected)` / `Expected: 0` / `Received: 1`（`e2e/resident-busy-send.spec.ts:645`，打印 `resident.queuedCard=1`）。
- **(b) 撤回只在前端隐藏**：`src/modules/chat/ChatInterface.tsx` 的 `handleWithdrawResidentCommand` 里整块删掉 `sendMessage({ type: 'chat.cancel-queued', … })`，并让 `src/modules/chat/transcript/PendingResidentMessage.tsx` 用本地 state 立刻画已撤回态。判据退出 **1**，红**落在 AC3 的 `cancelPayloads >= 1` 那条断言**，逐字：`Error: the click must reach the process that holds the command (cancelPayloads >= 1)` / `Expected: >= 1` / `Received: 0`（`e2e/resident-busy-send.spec.ts:677`，poll 计时 10s 到期）。
- **(c) 点击即标「已撤回」**：只留 `PendingResidentMessage.tsx` 的本地 state（`if (state === 'cancelled' || withdrawnLocally)` 直接画已撤回态，不等宿主的 `cancelled`）。判据退出 **1**，红**落在 AC3 的 `ui.withdrawnBeforeEvent=false` 那条断言**，逐字：`Error: a request is not a withdrawal: the row must not claim one yet` / `Expected: 0` / `Received: 1`（`e2e/resident-busy-send.spec.ts:691`；并列读数为 `withdraw.visibleBefore=true`、`click.dispatched=true`、`ui.withdrawnBeforeEvent=true`，即帧确实发出去了、只是界面抢在判决之前宣告了结果）。

三条各自还原后判据回到 **0**（`elapsed=35402ms`），树在还原后 `git status --short` 干净。

**(d) 未实现（明确不在本条内）。** AC-163 的驱动侧写入路径与撤回缝（本条只**消费** `chat.cancel-queued` verb 与 `command_lifecycle` 的解析，未改 `server/modules/websocket/services/chat-websocket.service.ts`）；AC-162 的真实 Claude driver 无人轮（本条要的「无人轮进行中」由替身已有的 `unattended-turn` op 造，未动真实 driver 的无人轮）；AC-165 的空闲关闭。三者本轮均未改动。

**顺带登记（不在本条判据面内，未修）：** `src/modules/i18n/locales/en/chat.json` 有两个顶层 `resident` 键（第 2 行与第 390 行），`JSON.parse` 只保留后一个，`resident.toggle` 与 `resident.notice.{title,bypass,trustBoundary,acknowledge}` 因此被遮蔽；`zh-CN/chat.json` 同形（第 2 行与第 311 行）。本条新增的 `resident.pending.*` 落在后一个 `resident` 里，运行期读得到；被遮蔽的是前一个。这是既有缺陷，属另案。
