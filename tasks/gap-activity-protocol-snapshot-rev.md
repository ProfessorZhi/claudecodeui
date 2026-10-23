---
id: gap-activity-protocol-snapshot-rev
title: AC-193 活动协议：REST 快照 + WS 整条 upsert（带 rev），晚加入者先快照后增量，rev
  不连续即重拉；同会话多连接各自游标；会话结束按保留策略淘汰
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-193
---
## Proposal

**这条是什么。** AC-193 的判据逐字：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-protocol.test.ts`（该文件当前 **ABSENT**，判据红）。它要把 GOAL-014 已建立的「活动帧」从**只有心跳**升级成**完整的活动协议**：服务端权威的一份活动快照（`turn ⊕ tasks ⊕ schedules`，带 `bootId`/`rev`/`asOf`），经 **REST GET** 交给晚加入者，经 **WS 整条快照式的 upsert**（每次变更推整条、带新 rev，不是差量拼接）推给在线客户端；`rev` 每会话单调递增，且与 AC-182 心跳帧宣告的 `rev` **同源**。客户端侧游标语义（先快照后增量、rev 不连续即重拉而非自行拼接、同会话多连接各自持游标）由判据里一个**测试用客户端**兑现并断言。

**今天的缺口（读代码）。** AC-182（`gap-activity-heartbeat-server-frames`，done）只交付了 `server/modules/websocket/services/activity-heartbeat.service.ts`：它有 `BOOT_ID` 与 per-session 的 `activityRevisions` Map，但注释逐字写着「**Nothing in this module advances it; the frames that do belong to the activity snapshot/patch protocol**」——即 `rev` 恒为 0，`activity.snapshot` / `activity.patch`（或 upsert）根本不存在。仓库里 `grep -rn "createActivityStore\|activity.upsert\|activity-protocol" server/ src/` → **0 命中**；`src/shared/types.ts:340` 那个 `SessionActivity` 是**客户端**的 processing-state 三字段类型，不是本条的 `turn/tasks/schedules` 快照（命名撞车，实现时新类型不要复用该名）。

**接口（本条钉死，供判据断言）。** 新服务 `server/modules/websocket/services/activity-protocol.service.ts` 导出：

- 类型 `ActivityProtocolSnapshot = { sessionId; bootId; rev; asOf; turn; tasks; schedules }`。`turn` 复用 providers 模块的 `TurnState`（`phase`/`toolName`/`toolDurationMs`）；`tasks`/`schedules` 经**注入的读取函数**取得（`readonly unknown[]` 透传——它们的内部形状是 AC-191/AC-192 的活，本条只搬运，不重定义）。
- 工厂 `createActivityStore(options?): ActivityStore`。状态**按实例持有、按会话 id 分桶**（模块级单例会通过单会话用例、恰好红掉跨会话/多连接用例）。`options` 可注入：`now?: () => number`（默认 `Date.now`，`asOf` 只由它产生，**不得读真实时钟**）、`bootId?: string`（默认复用心跳的进程 bootId，保证同源）、`readTurn?` / `readTasks?` / `readSchedules?`。判据注入假读数驱动，使本条**不依赖 AC-191/192 落地**即可独立验证；默认 `readTurn` 读 providers 的 `readSessionTurn`，默认 `readTasks`/`readSchedules` 返回空数组（它们的真实生产者在 AC-191/192，接线任务再换进来）。
- `snapshot(sessionId): ActivityProtocolSnapshot | null` —— 读当前三源 + 当前 rev，返回一份**拷贝**（调用方拿不到可变内部记录）。
- `recordChange(sessionId): void` —— 宣告「该会话的任务或计划变了」：rev 自增 1，并向**该会话的每个订阅者**推一条 `kind:'activity.upsert'` 帧，**帧体是整条快照**（=此刻的 `snapshot(sessionId)`），带新 rev。`rev` 是**单一来源**：心跳的 `activityAnnouncement().rev` 必须读同一个计数器（把 `activity-heartbeat.service.ts` 的 `activityRevisions` 收敛进本存储，或让心跳读本存储；**不得出现第二个计数器**；AC-182 的 process 判据必须保持绿）。
- `subscribe(sessionId, onFrame): () => void` —— 每个订阅是一个**独立连接**，各自持有自己的游标状态；订阅建立时**先**收到一条快照帧（`kind:'activity.snapshot'`，晚加入者先快照），之后才收 upsert。一个订阅的游标/重拉**不得**影响另一个。
- `retireSession(sessionId): void` —— 会话结束时按保留策略**淘汰**该会话的 rev、快照缓存与订阅（快照里不留任何会话级内存泄漏项）；淘汰后 `snapshot()` 返回 `null`。
- `sessionIds(): string[]` —— 供判据断言淘汰（`retireSession` 后不含该 id）。
- REST 面：`createActivityRouter({ activityStore }): Router`，`GET` 返回该会话快照（存在→200+快照；不存在/已淘汰→404）。判据在裸 express app 上挂同一 router（先例 `server/modules/session-hosts/tests/session-hosts-routes.test.ts`）；生产挂载点在 `server/index.ts`。
- WS 帧：`activity.snapshot` / `activity.upsert`，每条都带 `sessionId`、`bootId`、`rev`。

**游标语义（判据断言，测试用客户端）。** 判据实现一个测试用客户端：持 `lastRev`，收到快照即锚定；只接受 `rev === lastRev + 1` 的增量为连续，`rev <= lastRev` 的重复/陈旧帧忽略；收到 `rev` **跳号**（不连续）时**重拉快照**（对该会话再发一次 GET）并以快照为准，**不**把不连续增量自行拼接。两个客户端对象 = 同一会话两个连接，各自游标互不影响。

**假形态（写进判据，证明主断言有分辨力）。** 两条，各复用主用例的读数函数（若假形态也绿，说明判据有洞，先补判据）：
- (1) upsert **不带 rev** 的变体存储 ⇒ 「不连续即重拉」用例的读数必须红（客户端拿不到跳号证据）。
- (2) **快照与增量用不同来源**的变体（例如 upsert 帧体缓存了旧快照、而 GET 读实时源）⇒ 「快照与增量一致」用例的读数必须红。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-03，读任务库与代码）。** `grep -rn "goal_ac: *AC-193" tasks/ .quay/ goals/` → **0 命中**；机制词扫描 `grep -rln "activity-protocol\|createActivityStore\|activity\.upsert\|活动协议\|整条快照式\|rev 不连续\|快照 rev" tasks/*.md` → **0 命中**；`grep -rn "createActivityStore\|activity\.upsert\|activity-protocol" server/ src/` → **0 命中**；`test -f server/modules/websocket/tests/activity-protocol.test.ts` → **ABSENT**。相邻但**不同机制**的姊妹：`gap-activity-task-reducer`（todo，`goal_ac: AC-191`）与 `gap-activity-schedule-tracker`（todo，`goal_ac: AC-192`）各建一张**归约表**（Task 表 / Schedule 表）及其判据文件——本条不重定义它们的形状，只经**注入的读取器**搬运，判据用假读数驱动，三条任务互不为前置；`gap-activity-heartbeat-server-frames`（done，`goal_ac: AC-182`）只做心跳节拍与 `bootId`，把「活动快照/增量」这一层明确让了出来（见其注释）。⇒ 不是重复。

**非目标。** 不实现 Task/Schedule 归约（AC-191/192）；不接进 run loop 把真实帧喂进存储（那是接线任务）；不做浏览器坞与 e2e（AC-194/AC-199）；不实现租约推导（AC-195）；不碰控制面（AC-196/197/198）；不改 `rev` 之外的心跳行为、不碰其它 provider。**会话级淘汰**只做存储层的 `retireSession`（是谁在什么时机调用它留给接线任务），本条判据直接调它验证不泄漏。

## Plan

1. 新增 `server/modules/websocket/services/activity-protocol.service.ts`：定义并导出上面钉的类型与 `createActivityStore()` / `ActivityStore` 工厂；按实例持有 `Map<sessionId, {rev, subscribers}>`；`snapshot` 返回深拷贝；`recordChange` 自增 + 向各订阅者推整条 upsert；`subscribe` 先推快照帧、各自持游标；`retireSession` 清该会话并终止其订阅。注释沿用 `activity-heartbeat.service.ts` 的语气，点名「rev 单源」「整条快照式 upsert（不拼接）」「晚加入者先快照」「无本地时钟」「按会话淘汰」五条载重不变量，并注明消费方是判据文件。
2. 把 `activity-heartbeat.service.ts` 的 per-session `activityRevisions` 收敛为**同一个** rev 源（存储导出读/推进，心跳读它），保持 `BOOT_ID` 与节拍行为不变（AC-182 process 判据仍绿）。
3. 新增 `server/modules/websocket/services/activity.routes.ts`：`createActivityRouter({ activityStore })`，`GET /:sessionId/activity` 返回快照（404 当不存在/已淘汰）。在 `server/index.ts` 生产挂载（`app.use('/api/sessions', authenticateToken, createActivityRouter({ activityStore }))`，路径以实现为准），并在 `server/modules/websocket/index.ts` 桶里导出存储/路由/类型与注释点名消费方。
4. 新增 `server/modules/websocket/tests/activity-protocol.test.ts`（判据文件）：裸 express app 挂 router；注入假 `now`/`bootId`/`readTurn`/`readTasks`/`readSchedules`；实现测试用客户端（游标、连续判定、跳号重拉）；逐条断言 AC2–AC9；加入两条假形态臂（复用主用例读数函数、断言红）。
5. 本地直跑：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-protocol.test.ts` 退出 0；`npm run typecheck`、`npm run lint`、`npm run build` 绿；`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-heartbeat.process.test.ts` 仍绿（不破 AC-182）。
6. 写完成记录，置终态 done（AC-193 是纯机械判据，无人工关卡）。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-protocol.test.ts` 退出 **0**，stdout `fail 0`。
- [x] AC2 REST 快照：`GET` 某会话返回 200 与 `{sessionId, bootId, rev, asOf, turn, tasks, schedules}`；`turn` 等于注入读数器的结果，`tasks`/`schedules` 逐字段等于注入的假表；不存在的会话返回 404。
- [x] AC3 整条 upsert + rev 单调：注入的任务或计划变化后调用 `recordChange(sessionId)`，订阅者收到 `kind:'activity.upsert'`，**帧体等于此刻 `snapshot(sessionId)` 的整条内容**（非差量），其 `rev` 严格大于上一帧；连续两次变更得到 `rev+1`、`rev+2`。
- [x] AC4 晚加入者先快照后增量：一个在若干次变更**之后**才订阅的连接，**第一条**收到的是 `kind:'activity.snapshot'`（不是 upsert），其 `rev` 等于当前 rev；其后的变更才以 upsert 到达。
- [x] AC5 只接受快照 rev 之后的增量：测试用客户端锚定快照后，`rev === lastRev+1` 的 upsert 被应用；`rev <= lastRev` 的陈旧/重复帧被忽略，客户端状态不变。
- [x] AC6 rev 不连续即重拉：注入一次「跳过 rev」的推送（模拟丢帧）后，测试用客户端**对该会话重发 GET**（断言 GET 次数增加）并以新快照为准；断言它**没有**把不连续增量自行拼接（客户端状态等于权威快照，不等于拼接结果）。
- [x] AC7 同会话多连接各自游标：同一会话两个测试用客户端；一个发生跳号重拉后，另一个的 `lastRev` 与状态不受影响（各自独立）。
- [x] AC8 会话级淘汰无泄漏：`retireSession(sessionId)` 后 `sessionIds()` 不含该会话、`snapshot()` 返回 `null`、GET 返回 404，且该会话的订阅不再收到任何后续帧（`recordChange` 后零投递）。
- [x] AC9 快照与增量同源：同一次变更下，upsert 帧体与紧接着的 GET 快照（同 rev）逐字段相等（deepEqual）——证明两条路径读的是同一个源。
- [x] AC10 假形态有分辨力：(1) 不带 `rev` 的 upsert 变体 ⇒ AC6 读数红；(2) 快照与增量不同源的变体 ⇒ AC9 读数红。两臂各复用主用例读数函数，打印绿/红读数证明主断言不是恒真。
- [x] AC11 契约面：`npm run typecheck`、`npm run lint`、`npm run build` 各退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-heartbeat.process.test.ts` 仍退出 0（不破 AC-182）；改动只落在 Touches 列出的文件上（`git diff --stat develop...HEAD` 逐条对齐）。

## DoD

- 活动存储是真的（`createActivityStore()` 被判据以注入读数与注入时钟驱动、产出快照与 upsert），不是测试里内联的一段伪代码；判据文件是测试条目的本体，AC1 的红→绿是被实现换来的。
- 「整条快照式 upsert（不自行拼接）」「快照与增量同源」「rev 单源」三条纪律真的被代码兑现：两条假形态臂必须红——若假形态也绿，说明主线断言没有分辨力，先补判据。
- `rev` 与 AC-182 的心跳帧**同源**（同一 per-session 计数器），心跳行为（bootId 稳定、无变化也发）不变，AC-182 process 判据仍绿。
- 无本地时钟副作用：所有 `asOf`/时间字段来自注入的 `now`；`retireSession` 后该会话在存储里不留 rev/快照/订阅。
- 非目标外的文件一行未动：不实现归约器/计划表、不接 run loop、不碰前端与其它 provider。
- 判据文件里每段假读数都注明其来源与用途，可被重新推导，不是凭空捏造。

## Touches

- `server/modules/websocket/services/activity-protocol.service.ts` (new)
- `server/modules/websocket/services/activity.routes.ts` (new)
- `server/modules/websocket/services/activity-heartbeat.service.ts`
- `server/modules/websocket/tests/activity-protocol.test.ts` (new)
- `server/modules/websocket/index.ts`
- `server/index.ts`
- `tasks/gap-activity-protocol-snapshot-rev.md`