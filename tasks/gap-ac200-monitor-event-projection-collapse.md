---
id: gap-ac200-monitor-event-projection-collapse
title: AC-200 Monitor 事件在转写投影层折叠成一行：同一 task-id 连续事件折叠（描述 +
  事件个数，可展开），非折叠投影仍含全部原始行，超时显示已停止非错误，不同 task-id / 跨断隔不合并
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-200
---
## Proposal

**这条是什么。** AC-200 的判据逐字：`npx vitest run src/modules/chat/tests/monitorEventCollapse.test.ts`（该文件当前 **ABSENT**，判据红）。它要求 `useChatMessages` 的投影把**同一 `task-id` 的连续 Monitor 事件用户行**折叠成**一行**——显示描述与事件个数（`📡 <描述> · N 个事件`），可展开看事件列表；**同一输入的非折叠投影仍含全部原始行**（历史与存储不变，转写仍是 CLI 的权威记录）；Monitor 超时那条（`<event>` 正文 `Monitor timed out`）显示为**已超时/已停止**，**不是错误样式**；**不同 `task-id`** 的事件不合并；**被其它消息隔开**的同一 `task-id` 事件不跨过隔断合并。取假形态：按**文本相等**合并 ⇒ 不同任务同文事件的「不合并」读数必须红。

**今天的缺口（读代码）。**
- 投影入口 `normalizedToChatMessages`（`src/modules/chat/hooks/useChatMessages.ts:211`）经 `parseTaskNotification`（`:73`）只读 `<status>/<summary>/<result>`；`<task-id>` 与 `<event>` **完全丢弃**。于是每条 Monitor 事件各自渲染成一条无区分度的 assistant 通知（`content` = summary），既无 `task-id` 可分组，也拿不到事件正文。
- `grep -rn "'<event>'\|<task-id>\|monitorEvent\|MonitorEvent" src/` → **0 命中**：客户端没有 Monitor 概念。
- **不能用 `origin` 检测**：JSONL 里这些行带 `origin:{kind:"task-notification"}`，但 Claude 实时路径不给帧盖 `origin`（提案 `docs/proposals/claude-session-activity-dock.md` §5.6b 实测），客户端 `NormalizedMessage.origin` 是 `{trigger,sender}`。识别必须**按内容形态**（通知里带 `<event>`）。
- **超时形态**（实测，提案 `docs/proposals/claude-background-work-observability.md:53`）：事件行是 `<task-notification><task-id>…</task-id><summary>Monitor event: …</summary><event>tick1…</event></task-notification>`，超时那条的 `<event>` 是 `[Monitor timed out — re-arm if needed.]`。今天它被 `parseTaskNotification` 的默认 `status='completed'` 当成正常通知渲染，事件正文丢失——既无「已停止」读数，也没有「非错误」的判定面。
- 渲染面 `MessageComponent.tsx:298` 把通知画成一条不可展开的紧凑行（`taskStatus==='completed'` 绿点，否则琥珀点），没有展开入口。折叠行要「可展开」必须新增一个渲染分支。

**接口（本条钉死，供判据断言）。**
- `normalizedToChatMessages(messages)` **保持无损非折叠投影**：对同一输入行数与顺序与今天一致，绝不改动 `NormalizedMessage[]`（这是 AC 所称的「非折叠投影」，也是 search/export/anchor 的原始来源）。
- 通知解析**增量**补字段：Monitor 事件行带 `isMonitorEvent: true`、`monitorTaskId`（`<task-id>` 值）、`monitorEvent`（`<event>` 正文）、`monitorDescription`（summary）。**判定**：通知里出现 `<event>` 即 Monitor 事件行（后台任务完成通知没有 `<event>`）；每行仍 1:1 产出，**不丢行**。
- 新增纯函数导出（同模块）：`collapseMonitorEventRows(rows: ChatMessage[]): ChatMessage[]`。把**相邻**且 `isMonitorEvent` 且**同一非空 `monitorTaskId`** 的最大连续段折叠成一行，携带 `isMonitorCollapse: true`、`monitorTaskId`、`monitorDescription`（取段内首行）、`monitorEventCount`（段长）、`monitorEvents: string[]`（按序的全部事件正文）、`monitorStatus: 'stopped' | 'completed'`。任何**非 Monitor 行**、**缺 `monitorTaskId` 的行**、或**不同 `monitorTaskId`** 都构成断隔——绝不跨断隔合并、绝不合并不同 id、**绝不按文本相等合并**。
- `monitorStatus`：段内任一 `monitorEvent` 命中 `/Monitor timed out/` ⇒ `'stopped'`，否则 `'completed'`。折叠行 `type: 'assistant'` 且 `isTaskNotification: true`（沿用通知样式），**绝不** `type: 'error'`。
- 转写渲染路径（`useChatSessionState.ts:598` 的 `chatMessages`）与**搜索定位投影**（`:1523` 的 `messagesForSearch`）都组合为 `collapseMonitorEventRows(normalizedToChatMessages(...))`，保证行下标对齐；原始 `normalizedToChatMessages` 仍是需要原始保真的调用点的来源。
- 渲染面：`MessageComponent.tsx` 为 `isMonitorCollapse` 增加分支——画出 `📡 <描述> · N 个事件`，并用 `<details>` 展开 `monitorEvents`；`monitorStatus==='stopped'` 时画「已超时/已停止」样式（琥珀/中性），**不走红色 error 头像**。

**假形态（写进判据，证明主断言有分辨力）。**
- 把折叠键改成 `content` **文本相等**：两条不同 `task-id`、正文相同的 Monitor 事件会被并成一行 ⇒ 判据里「不同 `task-id` 不合并」的读数必须红。判据用同一读数函数跑这条变体并断言它得到更少的行。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-04，读任务库与代码）。** `grep -rn "goal_ac: *AC-200" tasks/ goals/` → **0 命中**；`grep -rln "AC-200" tasks/` → **0 命中**。机制词扫描：`grep -rln "monitorEventCollapse\|collapseMonitorEvent\|Monitor 折叠" tasks/` 只命中 `tasks/gap-activity-dock-background-browser.md`（AC-194）与 `tasks/gap-ac199-dock-stop-background-controls-browser.md`（AC-199）两条，二者在**非目标里逐字**把「Monitor 折叠」让了出去（AC-194 非目标：「不做 Monitor 折叠」；AC-199 非目标：「不碰 Monitor 折叠」）。`test -f src/modules/chat/tests/monitorEventCollapse.test.ts` → **ABSENT**；`grep -rn "'<event>'\|<task-id>\|monitorEvent" src/` → **0 命中**。⇒ 不是重复。

**非目标。** 不改服务端 Task 归约（AC-191 已 achieved）与活动协议（AC-193 已 achieved）；不做坞面板/浏览器（AC-194）与控制动词（AC-196/197/198/199）；不改租约（AC-195）；不做人工关卡（AC-201）；不改历史/存储/JSONL；不给实时帧补 `origin`；不碰其它 provider。

## Plan

1. **解析扩字段**（`useChatMessages.ts`）：把 `parseTaskNotification` 扩展为可读 `<task-id>`/`<event>`（新增 `readTaggedValue` 式的小读取器），在 `text`/user 分支为 Monitor 事件行附加 `isMonitorEvent/monitorTaskId/monitorEvent/monitorDescription`；**保持行数不变**。`task_notification` kind 分支（`:529`）同理补 Monitor 字段（若该 kind 也承载事件）。
2. **折叠纯函数**：新增 `collapseMonitorEventRows(rows)`（同模块、纯、不改入参），按上面钉死的规则分段；共享元数据（`timestamp`、`id`/`blockKey`）取段内首行，`monitorEvents` 收集全部正文。
3. **类型**（`src/shared/types.ts`）：给 `ChatMessage` 增量加 `isMonitorEvent/monitorTaskId/monitorEvent/monitorDescription/isMonitorCollapse/monitorEventCount/monitorEvents/monitorStatus`，每条按前端规范写注释；只在一处使用的类型留在组件文件。
4. **接线**（`useChatSessionState.ts`）：`chatMessages` 与 `messagesForSearch` 两处组合折叠函数；其它需要原始保真的调用点保持 `normalizedToChatMessages` 原样。
5. **渲染**（`MessageComponent.tsx`）：新增 `isMonitorCollapse` 分支（描述 + 计数 + `<details>` 事件列表 + 停止态样式），i18n key 进 `chat.json`（按仓库 i18n 完整性惯例补全 locale）。
6. **判据文件**（`src/modules/chat/tests/monitorEventCollapse.test.ts`，新）：构造 NormalizedMessage[] 夹具（同一 task-id 连续多条、不同 task-id 同文、被其它消息隔开的同 task-id、含 `Monitor timed out` 的段）；断言折叠输出、原始投影无损、超时非错误、断隔不合并；再以一个按文本相等的变体折叠函数跑同一读数并断言「不同 task-id 不合并」红。
7. **渲染用例**（`src/modules/chat/tests/monitorEventCollapseRender.test.tsx`，新）：渲染折叠行，断言描述/计数文本与可展开的事件列表入口存在，停止态不渲染红色 error 头像。
8. **本地直跑**：`npx vitest run src/modules/chat/tests/monitorEventCollapse.test.ts` 退出 0；`npm run test:client`、`npm run typecheck`、`npm run lint`、`npm run build:client` 绿；既有 `useChatMessages.test.ts` / `compactionRows.test.ts` 保持绿。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/monitorEventCollapse.test.ts` 退出 **0**，stdout 无用例 `fail`。
- [x] AC2 折叠成一行：同一 `task-id` 的连续 Monitor 事件行 ⇒ 输出 **1** 行，带描述、`monitorEventCount === N`、`monitorEvents.length === N`（按序全部事件正文）。
- [x] AC3 原始投影无损：同一输入下 `normalizedToChatMessages(messages)`（非折叠）仍含**全部原始行**（行数/顺序等于未改动前），且未改动入参数组（`NormalizedMessage[]` 不变）。
- [x] AC4 超时非错误：段内含 `Monitor timed out` ⇒ 折叠行 `monitorStatus === 'stopped'` 且 `type !== 'error'`；不误判为 `completed`。
- [x] AC5 不同任务不合并：两个不同 `task-id`（正文相同）的事件 ⇒ 输出 **2** 行，各自 `monitorTaskId` 正确。
- [x] AC6 断隔不跨：同一 `task-id` 的两段之间夹一条其它消息 ⇒ 输出 **2** 行（不跨隔合并）。
- [x] AC7 假形态红：按 `content` 文本相等的变体折叠函数，对 AC5 的输入并成 **1** 行 ⇒ 「不同 `task-id` 不合并」读数红；两臂复用同一读数函数并打印绿/红读数。
- [x] AC8 渲染可展开：`npx vitest run src/modules/chat/tests/monitorEventCollapseRender.test.tsx` 退出 0；折叠行渲染出描述与计数，存在可展开的事件列表入口；停止态不渲染红色 error 头像。
- [x] AC9 契约面：`npm run typecheck`、`npm run lint`、`npm run build:client` 各退出 0；改动只落在 Touches（`git diff --stat develop...HEAD` 逐条对齐）；既有 chat 投影用例保持绿。

## DoD

- 折叠是**真实转写路径**上的投影：`useChatSessionState` 的渲染投影确实组合了折叠函数（不是只在测试里调用），在真实应用里同一 Monitor 任务的连续事件**在屏幕上只占一行**并可展开看到全部事件；原始 `normalizedToChatMessages` 与 store/JSONL 一行未改（历史仍是 CLI 权威记录）。
- 超时那条在真实渲染里显示为**已超时/已停止**（非红色错误）；`monitorTaskId` 分组是唯一分组键，文本相等不参与分组（假形态必须红）。
- `npm run typecheck`、`npm run lint`、`npm run build:client`、`npm run test:client` 全绿；既有 `useChatMessages.test.ts`、`compactionRows.test.ts` 保持绿。
- 非目标外文件一行未动：不碰服务端归约/协议/坞/控制/租约/人工关卡与其它 provider。

## Touches

- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/tests/monitorEventCollapse.test.ts (new)
- src/modules/chat/tests/monitorEventCollapseRender.test.tsx (new)
- src/shared/types.ts
- src/modules/i18n/locales/*/chat.json
- tasks/gap-ac200-monitor-event-projection-collapse.md
