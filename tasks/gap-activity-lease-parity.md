---
id: gap-activity-lease-parity
title: AC-195 租约推导并行对照：由 Task 表与 Schedule 表推出的租约与
  observeHeldWorkEvent+reconcileHeldWork 逐帧相等，行为不变
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-task-reducer
  - gap-activity-schedule-tracker
goal_ac: AC-195
---
## Proposal

**这条是什么。** AC-195 的判据逐字（`goals/AC-195-*.md`）：先要求三个判据文件存在——新增的 `server/modules/providers/tests/claude-activity-lease-parity.test.ts`（当前 **ABSENT**），以及既有的 `server/modules/providers/tests/claude-resident-idle.test.ts` 与 `server/modules/providers/tests/claude-background-work.test.ts`；随后 `npx tsx --tsconfig server/tsconfig.json --test` 这三个文件一起跑。它要的是一条**租约推导路径（Lease Deriver）的逐帧对照**：把「由 Task 表与计划表推出的租约集合」与「现有 `observeHeldWorkEvent` + `reconcileHeldWork` 路径得到的租约集合」在**同一批真实帧序**（任务嵌套、Monitor 停止、cron 与唤醒、Stop hook 清单变化）上逐帧比较，不一致即红并打印**第一处不一致的帧序号**；两条路径**并存**（先对照、不收敛），既有 `claude-resident-idle` 与 `claude-background-work` 保持绿，静默关闭上限与 cron 延期行为不变。设计来源：`docs/proposals/claude-session-activity-dock.md` §4（「租约由 SessionActivity 的任务与计划推出（Lease Deriver），行为不变，先并存对照再收敛」）与 `docs/proposals/claude-background-work-observability.md` §5.4（「resident 从不产出 monitor 租约的差异需要一并处理」）。

**今天的缺口。** 现有租约只有一条路径：`server/modules/providers/list/claude/claude-host-driver.provider.ts` 的 `observeHeldWorkEvent`（:2713，读 `system/task_started` / `task_notification` / `background_tasks_changed` 增删 `background-task` 租约）、`reconcileHeldWork`（:2683，用 Stop hook 的 `session_crons` / `background_tasks` 校准 `cron` / `background-task` 租约），外加 `inferHeldWork`（:2761）对 `CronCreate` / `CronDelete` 的推断；对判据可读的出口是 `ClaudeResidentHostDriver.lifecycleReading(sessionId)`（:2473 附近，返回 `{crons, backgroundTasks, cronsAuthoritative, tasksAuthoritative}`）。仓库里**没有**第二条「由任务表 + 计划表推出租约」的路径，也没有任何逐帧对照判据；`grep -rn "LeaseDeriver\|lease-deriver\|deriveHeldWorkLeases" server/ src/ tasks/` → **0 命中**。

**输入表来源。** Task 表由 `createClaudeTaskReducer()`（`server/modules/providers/services/claude-activity-task-reducer.service.ts`，类型 `ActivityTask`）产出；计划表由 `createClaudeScheduleTracker()`（`.../claude-activity-schedules.service.ts`，类型 `ActivitySchedule`）产出。本条**消费**这两张表，不重定义它们的形状（关系钉在任务对象的 `depends_on` 字段上）。

**接口（本条钉死，供判据断言）。** 新服务 `server/modules/providers/services/claude-activity-lease-deriver.service.ts` 导出：

- `deriveHeldWorkLeases(input: { tasks: ActivityTask[]; schedules: ActivitySchedule[]; now: number }): HostLease[]`——**纯函数**，无本地时钟副作用（时间只来自 `now`），把两张表投影成与现有路径同一形状的 held-work 租约集合：
  - 计划表每一项 ⇒ `{ kind: 'cron', id: schedule.scheduleId, recurring: schedule.recurring, expiresAt: schedule.expiresAt ?? now + CRON_MAX_AGE_MS, ...(schedule.source === 'tool-call' ? { inferred: true } : {}) }`（唤醒 `recurring:false` 也是 `cron` 租约，与 `cronsFromStopList` 同一读法）。
  - 任务表里**未终结**（`state ∉ { completed, failed, stopped, ended }`）的每一项 ⇒ `{ kind: 'background-task', id: task.taskId }`；终结的丢弃。**monitor 任务同样投影成 `background-task`**——这是对 proposal §5.4「resident 从不产出 monitor 租约」的显式处理：本条对照的是 resident 路径，故推导必须复刻它「一律 `background-task`」的形状；`monitor` 这一 kind 属 per-run 路径，不在本条对照范围（写进注释）。
  - 返回顺序稳定（按 `kind` 再按 `id` 排序），便于逐帧比较。
- 复用 `HostLease`（`server/shared/types.ts:1937`）作为输出类型；`CRON_MAX_AGE_MS`（driver :249）与现有路径同值。

**观察者缝（判据如何读两条路径）。** 现有路径**不改**：判据像 `claude-resident-idle.test.ts` 那样构造 `ClaudeResidentHostDriver` + 假进程 + 假时钟（`createSessionHostManager({ now, scheduler })`，见该文件 :110-365），逐事件 `emit(frame)` / `stop(hookInput)`，读 `driver.lifecycleReading(sessionId)` 的 `{crons, backgroundTasks}`。新路径在同一时刻喂同一帧给 `reducer.observe` / `tracker.observe`、同一 hook 给 `reducer.reconcileStopHook` / `tracker.reconcileStopHook`，再 `deriveHeldWorkLeases({ tasks: reducer.getTasks(), schedules: tracker.getSchedules(), now: clock.now() })`。两条路径**共用同一个注入时钟**，故 `expiresAt` 可比。**不改 `claude-host-driver.provider.ts`。**

**逐帧语义（判据断言）。** 判据把一个**有序事件序列**（帧与 Stop hook 交错）按 0-based 序号逐条应用；每应用一条就比较两条路径的 held-work 租约**集合**（规范化 key `kind|id|recurring|expiresAt|inferred`，比较对顺序不敏感）。首个不一致处打印 `PARITY-MISMATCH at event #<i> (<subtype 或 Stop-hook>): existing=[...] derived=[...]` 并红。序列至少覆盖：任务嵌套（父 `task_started` + 子 `task_started{parent_tool_use_id}`，子终结只删子）、Monitor 停止（`task_updated{status:'killed'}` + `task_notification{status:'stopped'}`）、cron 与唤醒（`CronCreate` 后 Stop hook `session_crons` 含 `recurring:true` 与 `recurring:false` 两项）、Stop hook 清单变化（`background_tasks` / `session_crons` 列表在轮次间增删，含 `ended` 与「清单不再命名」两类终态）。序列避免使用 `background_tasks_changed`（它不在 AC-191 归约器的输入类里，本条只用帧序里列明的四类）。

**对齐义务（parity 会逼出来，属本条范围）。** 两条路径的证据源天然有别，判据必须让它们对齐：

- **inferred cron 的 id 命名空间**：现有 `inferHeldWork` 以 `tool_use_id` 记推断租约（:2775-2789）；计划表若以 `CronCreate` 的 `tool_result` 文本里解析出的 CLI id 记 `source:'tool-call'` 项，则该帧两路径 id 不同。对齐方向：计划表的 tool-call 项在 Stop hook 命名它之前以 `tool_use_id` 为 `scheduleId`（与现有推断租约同 key），Stop hook 到来后整条覆盖成 CLI id——这正是 `claude-resident-idle.test.ts` leg (4) 正控制所断言的行为（「the CLI-named id replaces the tool-call guess」）。
- **cron `expiresAt` 的稳定性**：现有 `cronsFromStopList`（:1260）对已持有的 id **保留首个 expiry**；`claude-resident-idle.test.ts` leg (3) 断言「a job the CLI keeps naming keeps its first expiry」。计划表重复命名同一 id 时不得重置 `expiresAt`；若重置，则该帧 parity 红。
- 若上述对齐需要改动计划表/任务表服务文件，属本条范围，但**必须保持它们各自的判据文件绿**（`claude-activity-schedules.test.ts`、`claude-activity-task-reducer.test.ts`）。

**假形态（写进判据，证明主断言有分辨力）。** 判据要「推导里漏掉一类终态 ⇒ 对照用例必须红」。至少两条，各复用主用例的读数函数：

- (i) 在 `task_notification` 终态上不删租约的变体（漏掉「通知即终态」这类）⇒ Monitor 停止那一帧 parity 红。
- (ii) 不跟随 Stop hook 清单覆盖的变体（漏掉「清单不再命名 = 终态」这类）⇒ 清单变化那一帧 parity 红。

两臂各打印绿/红读数；若假形态也绿，说明判据有洞，先补判据。

**非目标。** 不改现有租约路径（`claude-host-driver.provider.ts` 一行不动，`observeHeldWorkEvent` / `reconcileHeldWork` / `inferHeldWork` / `cronsFromStopList` 保持现状）；**不把生产切到推导路径**（本条只并存对照，收敛留待后续）；不做 REST 快照 / WS 增量（AC-193）；不做前端坞 / e2e（AC-194 / AC-199）；不做控制面（AC-196 / AC-197 / AC-198）；不重定义 Task / Schedule 表（AC-191 / AC-192）；不碰其它 provider。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-04，读任务库与代码）。** `grep -rn "goal_ac: *AC-195" tasks/ .quay/ goals/` → **0 命中**（任务库里没有任何任务认领 AC-195）；机制词扫描 `grep -rn "LeaseDeriver\|lease-deriver\|deriveHeldWorkLeases\|activity-lease\|租约推导\|逐帧对照" tasks/*.md` → **0 命中**；代码扫描 `grep -rn "LeaseDeriver\|lease-deriver\|deriveHeldWorkLeases" server/ src/` → **0 命中**；`test -f server/modules/providers/tests/claude-activity-lease-parity.test.ts` → **ABSENT**。相邻但**不同机制**的姊妹逐条核对：`gap-activity-task-reducer`（AC-191，ready）建 **Task 表**及其判据，非目标逐字写「不改现有租约路径、不加 REST/WS（那是 AC-193/AC-195 的活）」；`gap-activity-schedule-tracker`（AC-192，ready）建 **Schedule 表**及其判据，非目标逐字写「不改租约路径、不加 REST/WS（那是 AC-193/AC-195 的活）」；`gap-activity-protocol-snapshot-rev`（AC-193，ready）做 REST/WS，非目标逐字写「不实现租约推导（AC-195）」。三条都各自把租约推导让给本条，本条消费它们的两张表。⇒ 不是重复。

## Plan

1. 新增 `server/modules/providers/services/claude-activity-lease-deriver.service.ts`：导出 `deriveHeldWorkLeases()`（纯函数）与所需类型别名；导入 `ActivityTask`（AC-191 服务）、`ActivitySchedule`（AC-192 服务）、`HostLease`（shared/types）、`CRON_MAX_AGE_MS`（复用 driver 的导出，避免第二处常量）。注释点名三条载重不变量：无本地时钟（时间只来自 `now`）、monitor 折叠成 `background-task`（复刻 resident 路径）、终态即丢弃。
2. 在 `server/modules/providers/index.ts` 桶里导出 `deriveHeldWorkLeases` 与类型，注释点名消费方（判据 `claude-activity-lease-parity.test.ts`）。
3. 新增 `server/modules/providers/tests/claude-activity-lease-parity.test.ts`：① 复用 `claude-resident-idle.test.ts` 的夹具骨架（假时钟 / 假进程 / `ClaudeResidentHostDriver` / `SessionHostManager`，见 :110-365）；② 写一条有序事件序列 builder，覆盖嵌套 / Monitor 停止 / cron 与唤醒 / Stop hook 清单变化，每帧注明形态来源（§9 或既有 leg）；③ 逐事件应用并比较两条路径的 held-work 集合，首个不一致打印 `PARITY-MISMATCH at event #<i> ...` 并断言相等；④ 加一条两集合均非空的相等读数作正控制；⑤ 加两条假形态臂（漏终态），各自打印红读数。
4. 若 parity 在 tool-call cron 的 id 命名空间或 cron `expiresAt` 稳定性上暴露出与 AC-192 计划表的不一致：按 Proposal「对齐义务」改 `claude-activity-schedules.service.ts`（tool-call 项以 `tool_use_id` 为 key 直到被 Stop hook 命名；重复命名不重置 expiry），并保持 `claude-activity-schedules.test.ts` 绿；同理若任务表在终态上有洞，最小改 `claude-activity-task-reducer.service.ts` 并保持其判据绿。**不改 driver。**
5. 本地直跑判据全文：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-lease-parity.test.ts server/modules/providers/tests/claude-resident-idle.test.ts server/modules/providers/tests/claude-background-work.test.ts` 退出 0；`npm run typecheck`、`npm run lint`、`npm run build` 绿。
6. 写完成记录，置终态 done（AC-195 是纯机械判据，无人工关卡）。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-lease-parity.test.ts server/modules/providers/tests/claude-resident-idle.test.ts server/modules/providers/tests/claude-background-work.test.ts` 退出 **0**，stdout `fail 0`。
- [x] AC2 逐帧相等：在覆盖嵌套 / Monitor 停止 / cron 与唤醒 / Stop hook 清单变化的事件序列上，**每一个**事件序号之后，`deriveHeldWorkLeases(...)` 的租约集合与 `driver.lifecycleReading(sessionId)` 的 `{crons, backgroundTasks}` 集合（规范化 key `kind|id|recurring|expiresAt|inferred`）相等；测试打印逐帧读数。
- [x] AC3 首处不一致可报：一个刻意发散的帧（或假形态臂）使 harness 打印 `PARITY-MISMATCH at event #<i>` 与两条路径的集合并断言红——证明比较逐帧而非只比末态。
- [x] AC4 cron 与唤醒：Stop hook `session_crons` 含 `recurring:true` 与 `recurring:false` 两项时，两路径都得到 `kind:'cron'`、`id` 等于清单 id、`recurring` 逐项相等、`expiresAt` 相等；`source:'tool-call'` 的推断项 `inferred === true`。
- [x] AC5 Monitor 停止：`task_updated{status:'killed'}` + `task_notification{status:'stopped'}` 之后的那一帧，两路径的 monitor（投影为 `background-task`）租约都消失，且该帧序号被覆盖。
- [x] AC6 嵌套任务：父与子任务同时 running 时两路径都持有两个租约；子任务终结只删除子，父仍在。
- [x] AC7 Stop hook 清单变化：一轮 Stop hook 的 `background_tasks` / `session_crons` 不再命名某 id 时，该帧两路径都删除其租约（「清单不再命名 = 终态」这一类）；含 `ended` 校准路径。
- [x] AC8 假形态有分辨力：≥2 条推导变体（(i) 漏 `task_notification` 终态；(ii) 漏 Stop hook 清单覆盖）各在对应帧使 parity 红；打印绿/红读数证明主断言非恒真。
- [x] AC9 既有行为不变：`claude-resident-idle.test.ts` 与 `claude-background-work.test.ts` 仍退出 0（已在 AC1 命令内）；`git diff --stat` 显示 `claude-host-driver.provider.ts` **零改动**；静默关闭上限（`RESIDENT_IDLE_TIMEOUT`）与 cron 延期读数由 idle 文件自身断言保持绿。
- [x] AC10 契约面：`npm run typecheck`、`npm run lint`、`npm run build` 各退出 0；改动只落在 Touches 列出的文件上（`git diff --stat develop...HEAD` 逐条对齐）。

## DoD

- 推导路径是真的：`deriveHeldWorkLeases()` 被测试以 AC-191 / AC-192 归约器产出的**真实表**驱动、产出租约，不是测试里内联的伪代码；判据文件是测试条目的本体。
- 对照是**逐帧**的（每个事件序号都比较、可在首个不一致处报号），不是只比一次末态。
- 「漏掉一类终态 ⇒ parity 红」这条分辨力真被兑现：两条假形态臂必须红；若假形态也绿，先补判据。
- 现有路径**一行未改**，其两条判据（`claude-resident-idle` / `claude-background-work`）保持绿；monitor 折叠成 `background-task` 与 cron `expiresAt` 稳定两条对齐义务在代码与注释里可读。
- 夹具每条 builder 注明形态来源（§9 / `claude-resident-idle.test.ts` 的既有 leg），可被重新推导。
- 非目标外的文件一行未动：不切生产、不做 REST/WS、不碰前端与其它 provider。

## Touches

- `server/modules/providers/services/claude-activity-lease-deriver.service.ts` (new)
- `server/modules/providers/tests/claude-activity-lease-parity.test.ts` (new)
- `server/modules/providers/index.ts`
- `server/modules/providers/services/claude-activity-schedules.service.ts` (parity 对齐：tool-call 项以 `tool_use_id` 为 key、重复命名不重置 expiry；保持 `claude-activity-schedules.test.ts` 绿)
- `server/modules/providers/services/claude-activity-task-reducer.service.ts` (parity 若暴露终态洞则最小对齐；保持 `claude-activity-task-reducer.test.ts` 绿)
- `tasks/gap-activity-lease-parity.md`
