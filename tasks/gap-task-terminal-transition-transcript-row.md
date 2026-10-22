---
id: gap-task-terminal-transition-transcript-row
title: 后台任务由非终态转终态时，服务端 reducer 发一条转写事件：任务停了，会话记录里一定留一行（带稳定 id，重放不重复）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

用户要求：坞只表示当前活动（计数随任务结束而减，终态不留在坞里，见兄弟任务 `gap-dock-counts-only-live-tasks-and-retires-strip`），而「某个后台任务停了」这件事要在上方会话记录里留下一行。裁定：**由服务端在 reducer 里发转写事件**，不由客户端在任务表变化时本地插入（本地插入刷新页面就没了，也与历史重放不一致）。

**为什么现状不保证有这一行（读代码与此前真实帧序实测）。** 转写里现有的「Background task finished」行来自 CLI 排队写入 JSONL 的 `<task-notification>` 用户行（`useChatMessages.ts` 的 `parseTaskNotification`），它在后台子代理与 Monitor 事件上稳定出现；但此前对真实 SDK 的实测里，后台 `Bash` 结束时只有 `system/task_updated{status:completed}`，**没有**对应的 `task_notification`；从坞里停止的任务是否在转写里留行，现有代码也没有保证。所以不能依赖那个通知行，必须由任务表自己的终态转换产生一行。

**接缝（读代码）。** `server/modules/providers/services/claude-activity-task-reducer.service.ts` 的 `applyTaskUpdated` / `applyTaskNotification` / `reconcileStopHook`（Stop hook 快照把 running 判为 `ended`）是任务进入终态的全部入口；`server/modules/providers/list/claude/claude-runtime.provider.ts` 在每帧后用 `activitySignature` 前后比对来 tick 活动协议，是已经在场的观察点。归一化帧类型里已有 `task_notification`（`server/shared/types.ts`，客户端 `useChatMessages.ts` 的 `case 'task_notification'` 已能把它画成带 `taskStatus` 的助手通知行），所以客户端渲染面基本现成，缺的是服务端在「非终态 → 终态」那一刻发出该帧。

**必须解决的三个难点，立案时先点明，执行时各自出读数。** ① 同一任务同一次终态转换只发一次：任务 id + 终态作稳定键；快照重放、`task_started` 重放、Stop hook 二次对账（reducer 注释里明确要求幂等）都不得产生第二行。② 已有 CLI 通知行的任务（子代理、Monitor）不能再多出一行重复的：要么按 `task-id` 与已有通知行合并，要么在已有通知行存在时不发，须在执行时实测两种来源并选定一种并写进完成记录。③ 刷新或重连后行还在：事件要落在与其它转写帧同一条可回放的序列里（`chat.subscribe` 的 seq 回放），而不是只推一次的 `activity.*` 帧。

<!-- dedup-ref --> 相关任务：`gap-dock-counts-only-live-tasks-and-retires-strip`（兄弟，坞侧只数活动任务；两者互不依赖，各自可独立落地，合起来才是用户要的完整体验）、`gap-activity-task-reducer`（AC-191，reducer 本体，done）、`gap-chat-stop-task-event-confirmed`（AC-196，停止任务由事件确认，done）、`gap-ac200-monitor-event-projection-collapse`（AC-200，Monitor 事件折叠，done，本任务产生的行不得破坏它的折叠）。

## Plan

1. 先取证再动手：用调试 agent 夹具或真实帧序，分别读出四类终态来源（`task_notification`、`task_updated{completed|killed}`、Stop hook 快照 `ended`、坞停止后的 `stopped`）在转写里现在各留几行；把读数写进完成记录。
2. 在 reducer 里加一个「终态转换」输出：`observe` / `reconcileStopHook` 返回或通过注入的回调报出 `{sessionId, taskId, toolUseId?, from, to, description, summary?, endedAt?}`，只在状态从 `running|blocked` 进入终态的那一次触发（幂等：同一任务已是终态时再来同样的终态不触发）。
3. `claude-runtime.provider.ts` 在已有的 `activitySignature` 比对旁消费该输出，发出一条归一化的 `task_notification` 帧（带稳定 id 与 `status`、`summary`/描述），经与其它转写帧相同的 writer 路径下发并进入 seq 回放；已有 CLI 通知行的任务按 ② 去重。
4. 客户端基本不改：确认 `useChatMessages.ts` 现有 `task_notification` 分支能画出 completed / failed / stopped / ended 四种状态；若需要为 `ended`（原因未知）补一句文案，在 12 个语种的 `chat.json` 同步，但本任务 Touches 不含客户端文件时就只验证、不动。
5. 单测落在既有测试文件里：reducer 的终态转换幂等与四类来源、runtime 的帧转发覆盖；不新增测试文件。

## AC

- [x] AC1 终态转换恰好一次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-task-reducer.test.ts` 退出 0；新增例子给定 `task_started` 后依次喂 `task_updated{completed}`、同一 `task_notification{completed}`、再重放整段序列，终态转换回调**只触发 1 次**。
- [x] AC2 四类终态来源都有一行：新增例子分别驱动 `task_notification(completed|failed|stopped)`、`task_updated{status:'completed'}`（无通知行）、`task_updated{status:'killed'}`、Stop hook 快照使 running 任务变 `ended`，每一类各产生 1 条转换，且 `to` 分别为 `completed | failed | stopped | stopped | ended`。
- [x] AC3 帧真的下发且可回放：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 退出 0；新增例子里任务进入终态后 writer 收到一条 `kind:'task_notification'` 帧，带稳定 id 与 `status`；同一 session 重新订阅按 seq 回放时该帧仍在且只有一条。
- [x] AC4 不与 CLI 通知行重复：新增例子对一个后台子代理（CLI 会写 `<task-notification>` 用户行）与一个后台 Bash（不会写）各走一遍，转写投影后前者终态只有 1 行、后者终态也只有 1 行；选定的去重方式写进完成记录。
- [x] AC5 不破坏兄弟：`npx vitest run src/modules/chat/tests/useChatMessages.test.ts` 与 AC-200 的折叠相关测试保持绿；`server/modules/providers/tests/claude-activity-lease-parity.test.ts` 保持绿（租约推导不受影响）。
- [x] AC6 负控制有分辨力：把「只在非终态→终态时触发」临时改成「每次终态帧都触发」，AC1 的重放例子必须红；打印改前绿、改后红两次读数。
- [x] AC7 契约面：`npm run lint` 与 `npm run typecheck` 退出 0；`git diff --stat develop...HEAD` 与 Touches 逐条对齐。

## DoD

- 真实的一次后台 Bash 自然结束、一次后台子代理结束、一次从坞里停止 Monitor，在真实或调试 agent 驱动的会话里各让转写多出且只多出一行结束记录，刷新页面后仍在；不是只让单测里的回调被调用。
- 事件由服务端 reducer 的终态转换产生，客户端没有任何本地插入路径；一次重放或 Stop hook 二次对账不会让同一任务多出第二行。
- 与 CLI 自带的 `<task-notification>` 行不重复，去重策略与取证读数（步骤 1 的四类来源现状）写进任务完成记录。
- 不改变任务表保留终态行的事实（转写卡片仍可按 `toolUseId` 找到已结束任务）。

## Touches

- server/modules/providers/services/claude-activity-task-reducer.service.ts
- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/shared/types.ts
- server/modules/providers/tests/claude-activity-task-reducer.test.ts
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts
- tasks/gap-task-terminal-transition-transcript-row.md

## 完成记录

**取证（Plan 步骤 1 的四类终态来源读数，由判据打印）。** 每类来源驱动一个各自的 task，读数取自 AC2 例子的 `[task-reducer] AC2 …` 行：
- `task_notification{completed}` → 1 条转换，`to=completed`；`{failed}` → `failed`；`{stopped}` → `stopped`。
- `task_updated{status:'completed'}`（后台 Bash 的结束形态，**无**通知帧、CLI 也不写用户行）→ 1 条转换，`to=completed`。这正是本任务要补的那一行。
- `task_updated{status:'killed'}` → 1 条转换，`to=stopped`。
- Stop hook 快照令 running 任务消失 → 1 条转换，`to=ended`；快照**直接补录**的终态任务不报（0 条，见 AC2 例子里 `ac2-backfilled` 读数）。
- 重放整段序列（含 task_started 重放、两次终态帧）后 `onTaskTerminal` 仍只触发 1 次（AC1 打印 `fired 1 time(s)`）。

**去重策略（难点 ② 的选定：按 kind 不发）。** 实测/案卷结论：CLI 会为 **子代理、workflow、Monitor** 各排队写一条 `<task-notification>` 用户行（客户端 `parseTaskNotification` 已把它画成通知行），而后台 shell（`local_bash`）不写。因此服务端只为「CLI 不会替它写行」的 kind 发帧，`subagent` / `workflow` / `monitor` 一律不发。实现即 `claude-runtime.provider.ts` 的 `CLI_NOTIFIED_TASK_KINDS`。AC4 读数：子代理投影后 **1 行**（CLI 1 + 服务端 0），后台 Bash 投影后 **1 行**（CLI 0 + 服务端 1）。Monitor 在帧路径上 SDK 报 `local_bash`（kind 归 `shell`，与后台 Bash 同形），其事件行的去重依赖 CLI 行本身 + AC-200 的折叠；本任务未触及 Monitor 的 kind 判定（不在 Touches），完成记录在此如实标注该边界。

**下发与回放（难点 ③）。** 帧经 `forwardNormalizedFrames` 的同一个 writer 下发（在归一化帧之后），因此带上网关的 `seq` 并进入 `chatRunRegistry` 的 replay buffer；id 稳定为 `task-terminal:<taskId>:<to>`，并盖 `taskId` 供转写行与任务表按 id 对齐。AC3 读数：replay 里 `task_notification` 帧 **1 条**，重新订阅后仍为同一条、同 id。

**负控制（AC6，两次读数）。** 改前（主）：`onTaskTerminal` 触发 **1** 次（绿）；改后（`terminalOnEveryFrame`，每次终态帧都触发）：触发 **5** 次，套用 AC1 的「等于 1」断言即红。两次读数都由测试打印。

**契约面（AC7）。** `npm run lint`、`npm run typecheck` 退出 0；`git diff --stat develop...HEAD` 恰为 Touches 内的 5 个代码文件（+ 本任务文件）。客户端未改（Touches 不含客户端文件），`useChatMessages.ts` 现有 `case 'task_notification'` 分支按 `status` 渲染，ended/failed/stopped 落入琥珀色点、completed 落绿色点，无需改动。

**未落地/边界。** Stop hook 的 `ended` 转换在 reducer 层已产生并判据覆盖，但 resident 路径的 Stop hook 对账（`reconcileSessionHeldWork`）发生在 host driver 内、该处没有 writer 且 `claude-host-driver.provider.ts` 不在本任务 Touches，故本任务未把 `ended` 帧接到 resident 的 writer 上；DoD 列举的三例（后台 Bash 结束、子代理结束、坞停 Monitor）均由 `forwardNormalizedFrames` 帧路径覆盖。
## Needs-Human

**执行 2026-10-04T03:49:32.103Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: ABORT guard=silence reason=hung threshold_ms=240000 elapsed_ms=431808 silent_ms=240935
- run_id：wk-prod-anchor
- session_id：3ce7a71f-dfc3-4aa1-8bef-3e0d0690e1cf
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-task-terminal-transition-transcript-row~wk-prod-anchor~1791085288513-2f17a2.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-task-terminal-transition-transcript-row-wk-prod-anchor.log
