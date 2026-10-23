---
id: gap-shell-terminal-row-only-true-background
title: 后台终态通知行只给真正的后台任务发（前台 Bash 不出行），单行截断带状态词，不再切断工作 segment
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

**现象（2026-10-04 在 :3001 会话 `聊天导航条 DOM 和滚动逻辑` 实测，cd8600e3-1088-4fd8-97be-9a49c5b90cc7）。** 整个 transcript 滚完共 68 行，其中 **26 条是后台任务终态通知行，占 4680px，页面总高 9297px，约一半**。每条 Bash 命令（包括没设 `run_in_background` 的前台命令）结束后，都在 Bash 卡片或「Bash N」折叠头之后多出一行绿点灰字，正文是**整段命令**：最长 4040 字符、72 行、单行高 404px，`white-space: normal`，不截断。26 条全是 completed 绿点，没有状态词、退出码或耗时。这些行不是 `isToolUse`，所以 `groupWorkSegments` 不认它们是成员，每一行都把一个工作 segment 切成碎片（折叠头只剩「Bash 2」）。读者看到的就是「命令漏到了折叠框之外」。

**机制（读代码 + 真实 SDK 抓帧）。** 前序任务 `gap-task-terminal-transition-transcript-row` 让服务端为每个终态转换合成一帧 `task_notification`（`claude-runtime.provider.ts` 的 `buildTaskTerminalFrame`，去重只按 kind：`CLI_NOTIFIED_TASK_KINDS` 排除 subagent/workflow/monitor）。该任务的意图是「后台任务停了要在会话记录里留一行」。用 Agent SDK 直接抓帧的读数：
- `run_in_background:true` 的 Bash（无论有无 description）：`task_started` → `task_updated{completed}`，**没有** `task_notification`，走 `defaultTerminalSummary`（带「Background task finished:」前缀）。
- **没设 `run_in_background` 的前台 Bash**（`sleep 8`）：同样是 `task_type:"local_bash"` 的任务，终态帧是 `task_notification{status:"completed", summary:"sleep 8"}`。`summary` 就是任务 description，没有 description 时就是命令本身，服务端原样采用，所以行里只有裸命令、没有前缀。
即：前台命令的结果早已由同一张卡的 `tool_result` 与 `taskState`（AC-194，`useTaskByToolUseId`）表达，这一行是重复回执；它违背原任务的意图（只给后台任务留行），也让同一功能出现两种措辞。

**裁定的方向（语义）。** 终态行仍然保留给真正的后台任务（用户的原要求不变，刷新后仍在，走 seq 回放）；前台命令不产生终态行；产生的行必须说明「哪个任务、什么状态」，单行截断，不得因为一条通知占几百像素。

<!-- dedup-ref --> 相关任务：`gap-task-terminal-transition-transcript-row`（done，引入该帧；本任务修正它的对象范围与展示，不推翻其「后台任务终态留一行、幂等、可回放」的结论）、`gap-work-segment-selector-row-type-pure`（done，segment 边界只看行类型字段，本任务不得破坏）、`gap-ac200-monitor-event-projection-collapse`（done，Monitor 事件折叠，本任务不得改动其行为）。

## Plan

1. **先取证再动手。** 在 Agent SDK 或调试 agent 夹具上重放三类命令：前台短命令、前台长命令（超过一个会被当作任务的时长，阈值本次**未测**，要读出来写进完成记录）、`run_in_background:true`。对每类打印：终态帧序列、是否有 `task_notification`、其 `summary`、对应 `tool_use` 是否已有 `tool_result`。
2. **服务端判据。** 选定「真正的后台任务」的判据并只对它发终态帧。候选：(a) 启动该任务的 `tool_use` 带 `run_in_background:true`；(b) 终态到达时该 `tool_use` 的 `tool_result` 早已下发（前台命令的结果先于任务终态）。判据必须在读数里分辨三类命令，选定一种并把依据写进完成记录。`ClaudeTaskTransition` 已带 `toolUseId`，但不带 `run_in_background`，必要时在 reducer 的 `task_started` 处补记。
3. **summary 兜底。** 终态行的文本在 `summary` 等于任务 description/命令（没有状态词）时，仍走带状态前缀的文案；有状态词的 `summary` 保持原样。放在服务端 `buildTaskTerminalFrame` 或客户端渲染，二选一并写明理由；服务端放法要保持帧 id `task-terminal:<taskId>:<to>` 稳定。
4. **客户端展示。** `isTaskNotification` 行（`MessageComponent.tsx` 的通知分支）改成单行截断、等宽字体、完整文本放 `title`；显示状态（completed/failed/stopped/ended）而不只是绿点。
5. **segment 归属。** 让紧跟在工作 run 里的 shell 终态通知行作为成员被并入同一个 segment，不再切断它。成员判据仍只用行的类型字段（保持 `gap-work-segment-selector-row-type-pure` 的纯函数性质与 AC-203 的无损展开），不得读正文。
6. 单测落在既有测试文件里；展示截断的渲染例子新增一个 vitest 文件。

## AC

- [x] AC1 前台命令不出行：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 退出 0；新增例子分别驱动前台 Bash（无 `run_in_background`，终态为 `task_notification{summary:<命令>}`）与 `run_in_background:true` 的 Bash（终态为 `task_updated{completed}`），writer 收到的 `task_notification` 帧数分别为 **0** 与 **1**，打印这两个读数；原任务 AC3/AC4 的例子保持绿。
- [x] AC2 判据可分辨：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-task-reducer.test.ts` 退出 0；新增例子证明所选判据对前台、后台、已有 CLI 通知行的子代理三类任务各给出「不报 / 报 / 不报」，且终态转换仍只触发一次（重放不重复）。
- [x] AC3 单行截断：`npx vitest run src/modules/chat/tests/taskNotificationRow.test.tsx` 退出 0；例子喂入一条 4000 字符 72 行的 `summary`，渲染后的文本节点不含换行、带截断样式、完整文本出现在 `title` 属性中，并断言行里出现状态词（completed/failed/stopped/ended 之一）。
- [x] AC4 无前缀的 summary 补状态：同一测试文件的例子，`summary` 等于命令本身时，行文本以状态措辞开头；`summary` 已有状态词时不重复添加。
- [x] AC5 不再切断 segment：`npx vitest run src/modules/chat/tests/workSegmentGrouping.test.ts` 退出 0；新增例子给定 `[tool, 通知, tool]` 的行序，得到 **1** 个成员数为 3 的 segment；`workSegmentLossless.test.tsx` 与 `workSegmentKeyStability.test.tsx` 保持绿。
- [x] AC6 负控制有分辨力：把 AC1 的判据临时改成「恒为真」，前台例子必须红；打印改前绿、改后红两次读数。
- [x] AC7 不破坏 Monitor 与既有投影：`npx vitest run src/modules/chat/tests/useChatMessages.test.ts` 保持绿，AC-200 的折叠相关测试保持绿。
- [x] AC8 契约面：`npm run lint` 与 `npm run typecheck` 退出 0；`git diff --stat develop...HEAD` 与 Touches 逐条对齐。

## DoD

- 在真实 :3001 会话（或调试 agent 驱动的会话）里各跑三次前台 Bash 与一次 `run_in_background:true` 的 Bash：前台命令**不多出任何行**，后台命令多出且只多出一行，该行为单行、带状态词、不超过一行高，刷新页面后仍在；同一浏览器读数里用 `.work-segment` 与通知行的 DOM 计数证明 segment 未被切碎。
- 用本任务立案时的基线对照：会话 cd8600e3 的 26 条通知行/4680px，修后同类会话的通知行数与高度显著下降（读出具体数字，不接受「看起来好了」）。
- 不改变原任务的结论：后台任务终态仍由服务端 reducer 产生、幂等、可回放；客户端没有本地插入路径；子代理/workflow/Monitor 的 CLI 通知行不受影响。
- 完成记录写明：判据的选定与依据、前台任务产生任务的时长阈值读数（若测得）、summary 兜底放在哪一侧及理由。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/modules/providers/services/claude-activity-task-reducer.service.ts
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts
- server/modules/providers/tests/claude-activity-task-reducer.test.ts
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/utils/workSegments.ts
- src/modules/chat/tests/workSegmentGrouping.test.ts
- src/modules/chat/tests/taskNotificationRow.test.tsx
- server/modules/providers/index.ts（AC2：判据 `earnsTaskTerminalRow` 必须经 providers facade 出口，判据测试才读得到它；被 AC2 强制）
- playwright.config.ts（DoD：调试 agent 闸门的 spec 白名单，spec 不在其中服务器就不带夹具 provider 与控制面，scenario 无法 arm；被 DoD 强制）
- e2e/transcript-task-terminal-row.spec.ts（新：DoD 的真实浏览器读数；被 DoD 强制）
- tasks/gap-shell-terminal-row-only-true-background.md

## 完成记录

### 判据的选定与依据

判据定为 **`earnsTaskTerminalRow(transition) = transition.background && !CLI_NOTIFIED_TASK_KINDS.has(kind)`**，其中 `background` 由 reducer 在观察 `assistant` 帧时记下、在 `task_started` 时读回：**启动该任务的 `tool_use` 的 `input.run_in_background === true`（Agent/Task 则 `!== false`），或某帧带 `task_updated{patch:{is_backgrounded:true}}` 把它移到后台**。即 Plan 的候选 **(a)**，加上手动转后台这一路。

依据是 2026-10-04 用 `@anthropic-ai/claude-agent-sdk` 0.3.165 的一次真实抓帧（一次 turn 内 3 条前台 + 1 条后台）：

- 三条前台调用（`echo fg-one` / `echo fg-two` / `sleep 6`）的 tool_use `input` 都**没有** `run_in_background`；`sleep 6` 的终态是 `system/task_started` + `task_notification{status:"completed", summary:"foreground three"}` —— summary 就是 description，**没有状态词**。
- 后台那条 tool_use `input` 带 `run_in_background:true`；终态是 `task_updated{patch:{status:"killed"}}`（进程收尾时被杀），随后才有一条 `task_notification{status:"stopped", summary:"background four"}`。
- 即：**终态帧的种类不是可靠判据**（后台任务被杀时同样发 `task_notification`），而调用自身的 `run_in_background` 是调用方声明的、不受终态路径影响的事实。选 (a)。
- 候选 (b)「终态到达时 tool_result 早已下发」被这次抓帧**证伪**：前台 `sleep 6` 的三个帧在同一时刻到达，顺序是 `task_started` → `task_notification` → `tool_result`，结果 **晚于**终态；后台那条的 `tool_result`（"Command running in background with ID: …"）才早于终态。按 (b) 会把前台判成后台。

### 前台任务产生任务的时长阈值读数

**未测得阈值，且本次抓帧没有出现「前台长命令被自动转后台」这一形态。** 真实读数：`sleep 6` 前台跑满 6 秒后在**结束时**才出现 `task_started`（4.4s 调用 → 12.4s `task_started`），终态是 `task_notification`；`sleep 8` 的两次抓帧同样如此。因此本任务不需要阈值，也不依赖阈值。真正的时间形态差别是**发射时刻**：前台的 `task_started` 在命令结束时才到，后台的在调用瞬间就到（13.6s 调用与 `task_started` 同刻），但那不是帧字段，判据用不到。

### summary 兜底放在哪一侧

放在**客户端渲染**（`MessageComponent.tsx` 的通知分支），不放服务端 `buildTaskTerminalFrame`。理由：**同一个分支也渲染 CLI 自己写进 JSONL 的 `<task-notification>` 行**（`useChatMessages.ts` → `parseTaskNotification`），那些行不经过服务端帧构造。规则放在行上，一处覆盖两路；放服务端则 CLI 来源的那一半仍会显示裸命令。服务端只把 `defaultTerminalSummary` 的措辞改成规范状态词（`Background task completed:` 等），使兜底文案本身已含状态词、客户端不再重复加前缀；帧 id `task-terminal:<taskId>:<to>` 未动，幂等/回放结论不变。

### DoD 读数

- **真实 SDK 全链路（真帧 → 出厂 `forwardNormalizedFrames` → 运行 writer）**：3 条前台 + 1 条后台，emitted `task_notification` 帧 **1** 条，且是后台那条（`task-terminal:bli4ndwk8:stopped`，summary `Background task stopped: background four`）。
- **真实浏览器（`e2e/transcript-task-terminal-row.spec.ts`，调试 agent 夹具，`playwright test` 1 passed / 21.6s）**：4 条 Bash 调用（3 前台 + 1 `run_in_background:true`）后 —— `.work-segment` **1** 个、成员数 **5**（4 张卡片 + 1 条终态行，未修时同一条 walk 会是 8 个成员且被切成 4 段）；`[data-task-notification-text]` **1** 条；文本 `Background task completed: background four`，`title` 同文，class 含 `truncate` + `whitespace-nowrap`，无换行，含状态词 `completed`；同行 4 张卡片都在。对照立案基线 cd8600e3 的 26 条 / 4680px：同样 4 条命令下，通知行由「每条命令一行」降为 **1** 行。
- **刷新**：行仍在（Dom 计数 ≥1，文本与 class 不变）。**同时记录一个不属于本任务结论的现象**：刷新后同一行被画了 **2** 次（打印读数 `reload.one: members=6 cards=4 notifRows=2`）—— 该帧 live 只投递 1 次，刷新后由「会话已存消息」与「run 回放缓冲」各来一次。这是投递层的重复，与本任务的判据正交（它只是把已存在的行数翻倍；未修时会把 4 条翻成 8 条），本任务不改动它，只如实记录。

### 契约面

- AC1：前台 **0** / 后台 **1**（打印读数）；原任务 AC3/AC4 例子仍绿（AC3 只补了它本来就该有的启动 `tool_use` 帧）。
- AC2：三类判据读数 `false / true / false`，跨重放各只触发 1 次；另加「前台被手动转后台后翻成 true」一条。
- AC6：注入 `() => true` 后前台例子由 0 变 1 而红（改前绿 / 改后红两次读数都打印）。
- AC7：`useChatMessages.test.ts`、`monitorEventCollapse*.test.*` 全绿。
- AC8：`npm run lint` / `npm run typecheck` 退出 0；diff 与 Touches 逐条对齐（新增 3 条已按强制来源补入 Touches）。
