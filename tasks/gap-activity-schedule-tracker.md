---
id: gap-activity-schedule-tracker
title: AC-192 计划表：由 Stop hook 的 session_crons 与工具结果得到 cron 与唤醒，计算下次触发，触发后消失
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-192
---
## Proposal

**这条是什么。** AC-192 的判据逐字：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-schedules.test.ts`（该文件当前 **ABSENT**，判据红）。它要一个**服务端计划表（Schedule Tracker）**：把 Claude 的「计划任务」——cron 与一次性唤醒（`ScheduleWakeup`）——归约成每会话一张表，算出 `nextFireAt`。数据来源有三：Stop hook 的 `session_crons`（**完整且权威**的清单，每项 `{id, schedule, recurring, prompt}`；`ScheduleWakeup` 也被表示成一条 `recurring:false` 的一次性项、`schedule` 是绝对分钟表达式如 `"58 20 * * *"`，触发后从清单里消失）；以及回合进行中 `CronCreate` / `ScheduleWakeup` 的 `tool_use` + `tool_result` 文本（`CronCreate` 结果含 `<id>` 与 “Every 2 minutes”、以及 “Auto-expires after 7 days”；`ScheduleWakeup` 结果含 “in 115s”）。夹具是 2026-10-01 真实读数（`docs/proposals/claude-session-activity-dock.md` §1.3、§4.7、§9.1/§9.4）。

**今天的缺口。** 宿主驱动只把 cron 当作「保活理由」处理：`cronsFromStopList`（`server/modules/providers/list/claude/claude-host-driver.provider.ts:1244`）从 `session_crons` 只取 `id`/`recurring`，丢掉 `schedule` 与 `prompt`，且不计算任何下次触发时间；`inferHeldWork`（同文件 `:2761`）只在流侧看 `CronCreate`/`CronDelete` 的 `tool_use`（以 `tool_use_id` 记租约），**完全忽略 `ScheduleWakeup`**，也从不读 `tool_result` 文本。仓库里没有计划表、没有 `nextFireAt` 计算、没有「触发后消失」的校准。proposal §4.7 已裁定「更好的做法是以 Stop hook 为准」。

**接口（本条钉死，供判据断言）。** 新服务导出 `createClaudeScheduleTracker(options?): ClaudeScheduleTracker`，与 `createClaudeTurnTracker()`、`createClaudeTaskReducer()` 同形：

- 状态**按实例持有、按会话 id 分桶**（从结构上让跨会话不串扰；模块级单例会通过单会话用例、恰好红掉串扰用例）。
- 工厂接受可选注入时钟 `{ now?: () => number }`（默认 `Date.now`）——`nextFireAt` 因此可在固定基准分钟上求值，与 Turn Tracker 的「无本地时钟副作用」纪律一致。
- `observe(sessionId: string, frame: unknown): void` —— 喂原始 SDK 帧：`assistant` 的 `tool_use`（`CronCreate`/`CronDelete`/`ScheduleWakeup`）与 `user` 的 `tool_result` 文本。
- `reconcileStopHook(sessionId: string, sessionCrons: SessionCronEntry[]): void` —— 用 Stop hook 的权威清单校准：**整条快照覆盖**（表里不在清单的项删除 —— 这正是「触发后消失」；清单里的项建立/覆盖）。
- `getSchedules(sessionId: string): ActivitySchedule[]` —— 读回该会话的计划表（返回拷贝，调用方拿不到可变内部记录）。

`ActivitySchedule` 字段（判据按名断言）：`scheduleId`、`kind: 'cron' | 'wakeup'`、`spec: string`、`recurring: boolean`、`prompt?: string`、`nextFireAt?: number`（分钟粒度的绝对时刻，epoch ms）、`expiresAt?: number`、`source: 'tool-call' | 'stop-hook'`。

`nextFireAt` 由 5 段 cron 表达式算出（分钟粒度），判据至少覆盖 `"*/2 * * * *"`、`"58 20 * * *"`、`"* * * * *"`（每分钟）。`expiresAt` = 创建时刻 + 7 天（与宿主驱动的 `CRON_MAX_AGE_MS` 同值；CLI 自述 “Auto-expires after 7 days”）。

**假形态（写进判据，证明主断言有分辨力）。** 两条，复用主用例的读数函数（若假形态也绿，说明判据有洞，先补判据）：

- (1) 只认 `CronCreate`、忽略 `ScheduleWakeup` 的变体 ⇒ 唤醒用例读数必须红。
- (2) 不被 Stop hook 校准（只累加、不做整条覆盖删除）的变体 ⇒ 触发后消失用例读数必须红。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-02，读任务库与代码）。** `grep -rn "goal_ac: *AC-192" tasks/ .quay/ goals/` → **0 命中**；`test -f server/modules/providers/tests/claude-activity-schedules.test.ts` → **ABSENT**；`grep -rln "activity-schedules\|计划表\|nextFireAt\|session_crons" tasks/*.md` 命中的在飞任务逐条核对：`gap-activity-task-reducer`（todo，`goal_ac: AC-191`）在 Proposal 里逐字写明「**不实现计划表（AC-192）**」，是相邻但**不同机制**的姊妹（Task 表 vs Schedule 表、不同判据文件）；`gap-resident-turn-phase-keyed-by-provider-id`（ready）与其余 transcript/session 任务与本条无机制交集。⇒ 不是重复。

**非目标。** 不改宿主驱动的保活租约路径（`cronsFromStopList`/`inferHeldWork` 保持现状，本条只读、不影响租约）；不接进实时运行回路、不加 REST/WS 快照（那是 AC-193/AC-195 的活）；不实现控制面取消（§0.1 已裁定坞对计划只读，取消由用户文本请模型调 `CronDelete`，结果经 `session_crons` 变化反映）；不碰 Task 表（AC-191）、不碰前端坞（AC-194/AC-199）、不碰其它 provider。

## Plan

1. 新增 `server/modules/providers/services/claude-activity-schedules.service.ts`：导出 `ScheduleKind`/`ScheduleSource`/`ActivitySchedule`/`SessionCronEntry`/`ClaudeScheduleTracker` 类型与 `createClaudeScheduleTracker()` 工厂。按实例持有 `Map<sessionId, Map<scheduleId, 内部记录>>`；`getSchedules` 返回拷贝。注释沿用 Turn Tracker 语气，点名「Stop hook 是权威清单」「触发即从清单消失 = 整条覆盖」「无本地时钟副作用，nextFireAt 只由表达式 + 注入基准算」三条载重不变量，并注明消费方是判据文件。
2. 实现 `nextFireAt`：一个最小 5 段 cron 求值器（分/时/日/月/周），支持 `*`、数字、`*/n`（至少覆盖 `*/2`、`*`），在注入的「当前分钟」基准上找下一个匹配分钟；不引入第三方依赖、不读真实时钟。
3. 实现 `observe`：`assistant.tool_use` 的 `CronCreate`/`ScheduleWakeup`/`CronDelete` 记 `tool_use_id → 工具名/输入`；`user.tool_result`（按 `tool_use_id` 配对）解析文本：`CronCreate` 取 id 与描述、`ScheduleWakeup` 取目标时刻；以 `source:'tool-call'` 建临时项。`reconcileStopHook` 做整条覆盖（删表里不在清单的项、建/覆盖清单里的项，`source:'stop-hook'`；`recurring:false` ⇒ `kind:'wakeup'`）。
4. 在 `server/modules/providers/index.ts` 桶里导出 `createClaudeScheduleTracker` 与各类型，附注释点名消费方（判据 `claude-activity-schedules.test.ts`；后续活动聚合器读它）。
5. 新增 `server/modules/providers/tests/claude-activity-schedules.test.ts`（判据文件）：按 `claude-turn-phase.test.ts` 的写法，为 2026-10-01 读数写带来源注释的 builder（§9.1 的两项 `session_crons`、`CronCreate`/`ScheduleWakeup` 的 `tool_result` 文本、触发后只剩 cron 的下一次 Stop hook），逐条断言 AC2–AC9，并加入两条假形态臂（各自复用主用例读数函数、断言红）。
6. 本地直跑：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-schedules.test.ts` 退出 0；`npm run typecheck`、`npm run lint`、`npm run build` 绿。
7. 写完成记录，置终态 done（AC-192 是纯机械判据，无人工关卡）。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-schedules.test.ts` 退出 **0**，stdout `fail 0`。
- [x] AC2 cron 与唤醒都建表：Stop hook 清单里 `recurring:true` 的项 `kind==='cron'`、`recurring:false` 的项 `kind==='wakeup'`；`getSchedules` 两项都在，`scheduleId`/`prompt`/`spec` 逐字段等于清单。
- [x] AC3 nextFireAt 由 5 段表达式算出：`"*/2 * * * *"`、`"58 20 * * *"`、`"* * * * *"` 三个表达式在给定基准分钟上得到正确的下一分钟（断言 epoch ms 落在整分钟上，秒/毫秒为 0）。
- [x] AC4 粒度是分钟：请求 60 秒后的唤醒，其 `tool_result` 文本 “in 115s” 解析后 `nextFireAt` 落在整分钟；断言不是秒级精度。
- [x] AC5 回合进行中先由工具结果显示：喂 `CronCreate` 的 `tool_result`（含 id 与 “Every 2 minutes”）与 `ScheduleWakeup` 的 `tool_result`（含 “in 115s”）后，`getSchedules` 立即出现 `source:'tool-call'` 的项（此时还没有 Stop hook）。
- [x] AC6 回合结束由 Stop hook 校准：随后 `reconcileStopHook` 用权威清单覆盖，`source` 变为 `'stop-hook'`，`spec` 变为清单里的绝对分钟表达式。
- [x] AC7 触发后消失：唤醒触发后下一次 Stop hook 清单里没有该项 ⇒ `getSchedules` 不再含它（整条覆盖的删除路径）。
- [x] AC8 cron 带 7 天过期：`expiresAt - 创建时刻 === 7 天`（与 `CRON_MAX_AGE_MS` 同值）；唤醒一次性项同样带 `expiresAt`。
- [x] AC9 同一分钟两个计划各自存在：两个计划落在同一分钟 ⇒ 表里两条独立项（不被合并）。
- [x] AC10 假形态有分辨力：(1) 忽略 `ScheduleWakeup` 的变体 ⇒ 唤醒用例读数红；(2) 不被 Stop hook 校准的变体 ⇒ 触发后消失用例读数红。两臂各复用主用例读数函数，打印绿/红读数证明主断言不是恒真。
- [x] AC11 契约面：`npm run typecheck`、`npm run lint`、`npm run build` 各退出 0；改动只落在 Touches 列出的文件上（`git diff --stat develop...HEAD` 逐条对齐）。

## DoD

- 计划表是真的（`createClaudeScheduleTracker()` 被测试以真实读数驱动、产出计划表），不是测试里内联的一段伪代码；判据文件是测试条目的本体，AC1 的红→绿是被实现换来的。
- 「触发后消失」与「唤醒也进表」两条纪律真的被代码兑现：对应的假形态臂必须红 —— 若假形态也绿，说明主线断言没有分辨力，先补判据。
- `nextFireAt` 是纯函数式求值（表达式 + 注入基准），没有本地时钟副作用；`expiresAt` 用的是 CLI 自述的 7 天。
- 夹具每条 builder 都注明形态来源（§1.3/§4.7/§9.1/§9.4），可被重新推导，不是凭空捏造。
- 非目标外的文件一行未动：不改租约路径、不接运行回路、不加 REST/WS、不碰 Task/前端/其它 provider。

## Touches

- `server/modules/providers/services/claude-activity-schedules.service.ts` (new)
- `server/modules/providers/tests/claude-activity-schedules.test.ts` (new)
- `server/modules/providers/index.ts`
- `tasks/gap-activity-schedule-tracker.md`