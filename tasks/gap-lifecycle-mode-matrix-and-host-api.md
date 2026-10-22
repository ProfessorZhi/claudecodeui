---
id: gap-lifecycle-mode-matrix-and-host-api
title: AC-169 lifecycle_mode 偏好列与能力矩阵：默认 per-run、不支持 resident 的 provider
  写入被拒且错误可辨、分叉不继承、POST /api/session-hosts/:sessionId/start 与 /close
  对常驻会话拉起与关闭宿主（per-run 的 close 被拒）、宿主 busy 时模式切换不在进行中的轮上生效；五条假形态（写入不校验 / 分叉继承 /
  per-run 也允许 close / busy 时照切 / start 不起进程）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
goal_ac: AC-169
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-169" tasks/*.md | wc -l` → **0**；`grep -rln "AC-169" tasks/*.md` → **3** 个文件（5 处命中），逐处核对**全部在非目标段且都是让位**：`gap-claude-resident-busy-input.md:34` 把 `residentFeatures` 里的 `inputWhileBusy` / `cancelQueuedInput` 逐字划给「能力矩阵任务（AC-169）」；`gap-claude-resident-server-restart.md:48` 把 `POST /api/session-hosts/:sessionId/close` 与「AC-169 的 API 开关与能力矩阵约束」列为非目标；`gap-debug-agent-host-driver.md:27/54/141` 把 `lifecycle_mode` 列与 `POST /api/session-hosts/:sessionId/start|close` 明写为 AC-169。⇒ 无认领者，邻居逐字让位，本条不是重复。

**与在飞邻居的边界（关系边已写成 `depends_on`，本段只作溯源）**：`gap-claude-resident-process-survival`（`goal_ac: AC-161`，status=ready）已把 AC-169 的三件承重物写进自己的 Touches 与 Plan：`sessions.lifecycle_mode` 列（`schema.ts` + `migrations.ts` + `sessions.db.ts` 读写，Plan 第 1 步逐字写着「迁移幂等、默认读回 `'per-run'`、写入不在 `lifecycleModes` 里的模式被拒」）、claude 的 `lifecycleModes` 加 `'resident'`、以及 `POST /api/session-hosts/:sessionId/close`。本条**不重做**这三件 —— 它们是本条判据 (1)(2)(4b) 的**读数面**而不是本条的工作面；本条在其上补：`POST …/:sessionId/start`、close 的 per-run 拒绝臂与**可辨错误码**、分叉默认 per-run（不继承）、宿主 busy 时模式切换的窗口规则、能力矩阵的 `residentFeatures` 格，以及判据文件 `lifecycle-mode.test.ts` 本身。⇒ 两条任务的机制不相交（它是「一个进程跨轮存活」，本条是「模式偏好列的取值规则与宿主生命周期 API」），且 `depends_on` 硬串行、不并发。

**来源与判据物。** 判据逐字取自 `goals/AC-169-lifecycle-mode-与能力矩阵-默认-per-run-不支持的模式被拒绝-分叉不继承-常驻的启动与关闭可经-a.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/lifecycle-mode.test.ts`（命令逐字含文件路径，不用 glob）。

**红态基线（本轮直跑，读数不是推断）**：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/lifecycle-mode.test.ts'`。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑同目录既有的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts` → 退出 **0**，读数 `tests 6 / suites 0 / pass 6 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 339.239839`。

**现状（本轮实测的读数）**

- **列不存在**：`grep -rn "lifecycle_mode" server/ src/ shared/ --include=*.ts --include=*.tsx | wc -l` → **0**；驼峰那一个字段是另一回事：`grep -rn "lifecycleModes" server/ src/ shared/ --include=*.ts --include=*.tsx | wc -l` → **20**，逐条都是能力矩阵字段，无一是 `sessions` 表的列。`server/modules/database/schema.ts:126-192` 的 `sessions` CREATE TABLE 里没有这一列；迁移侧可照抄的形状在 `server/modules/database/migrations.ts:265-268`（`addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0')`，helper 定义在 `:32`）与 `:461`（`'name_source', "TEXT DEFAULT 'derived'"` —— 带默认值的字符串列就长这样）。
- **路由只有一条**：`grep -c "router\." server/modules/session-hosts/session-hosts.routes.ts` → **1**（只有 `router.get('/')`）；`grep -rn "sessionId/start\|sessionId/close\|'/start'\|'/close'" server/ --include=*.ts | grep -v tests | wc -l` → **0**。挂载点 `server/index.ts:213`：`app.use('/api/session-hosts', authenticateToken, createSessionHostsRouter({ sessionHostManager }))` —— 工厂**只收 manager**，没有驱动解析缝。
- **能力矩阵四行全是 per-run**：`grep -c "lifecycleModes: \['per-run'\]" server/modules/providers/services/provider-capabilities.service.ts` → **4**（claude/cursor/codex/opencode）；全库唯二声明过 `resident` 的是 `debug-agent.host-driver.ts:263` 与它经 `declareRuntimeProviderCapabilities`（`provider-capabilities.service.ts:173`）的镜像。`grep -rn "residentFeatures" server/ shared/ src/ --include=*.ts --include=*.tsx | wc -l` → **0** —— proposal §5 `:256-262` 的八个能力位一行都没有。
- **模式切换的实现体在，路径不在**：`session-host-manager.service.ts:1121` 的 `changeMode(appSessionId)`（`closeSessionHost(appSessionId, 'mode-change')`）**没有任何生产调用者** —— `grep -rn "changeMode" server/ --include=*.ts | grep -v "/tests/"` 只命中它自己的定义与 return 表；唯一调用者是既有判据的枚举用例 `session-host-lifecycle.test.ts:618`。它的注释写着「Consumed by the mode-switch path (AC-158)」，而那条路径今天不存在。`unbindSession`（`:807`）与 `closeHost`（`:532`）在位。
- **关闭原因的词汇表已含本条要用的两个值**：`server/shared/types.ts:1784-1795` 的 `HOST_CLOSE_REASONS` 含 `'user'`（`:1789`）与 `'mode-change'`（`:1791`）；`HostState`（`:1738`）含 `'busy'`。
- **分叉路径**：`sessions.service.ts:318` `forkSessionById`（HTTP 面 `provider.routes.ts:873-877`），落库走 `sessions.db.ts:428` 的 `createForkedSession`，其 INSERT 的列清单**逐字枚举**（`session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, model, effort, permission_mode, forked_from_session_id, isArchived, created_at, updated_at`）—— 不含模式列，所以 (3) 的实现面是「**不要**把它加进去」，而判据要证明「resident 源分叉出来的会话读回 per-run」，不能只靠默认值碰巧成立。
- **既有判据 6 条**（`ls server/modules/session-hosts/tests/*.test.ts | wc -l` → **6**）：`session-host-lifecycle` / `session-host-bindings` / `session-host-default-wrap` / `session-host-per-run-parity` / `session-hosts-routes` / `record-per-run-frame-baseline`。**一字不改且仍绿**是本条的硬约束。

**要建的东西（范围是 AC-169 的最小充分集）**

1. **`POST /api/session-hosts/:sessionId/start`**（`session-hosts.routes.ts`）—— 常驻会话的手动启动（proposal §10 `:356`：「用户首次在常驻会话中发送消息，或手动点『启动』时，才懒启动」）。按 `appSessionId` 找会话 → 读 `provider` 与 `lifecycle_mode` → **resident** 才解析该 provider 的 `hostDriver`（`IProvider.hostDriver`，`shared/interfaces.ts:84`）并 `manager.bindSession({provider, appSessionId, driver})`；**per-run 拒绝**（对称于 §13.2 的 close 规则），**provider 没有 hostDriver 时也拒绝**，两种拒绝各带具名错误码。
2. **驱动解析缝（避免反向 import 成环）**：`createSessionHostsRouter` 现在只收 `{sessionHostManager}`；start 要拿到 provider 的 driver，而 `providers → session-hosts` 这条边**已经存在**（`provider-runtime.service.ts:4`、`claude.provider.ts:13` 都 import 本模块的 barrel），所以本模块**不能** import `@/modules/providers`（会闭环；同形的禁环理由写在 `provider.registry.ts:95-103`）。做法：把 `resolveHostDriver(provider)` 作为**依赖参数**加进工厂，由 `server/index.ts:213`（组合根，两边都 import）注入 `providerRegistry.resolveProvider(provider).hostDriver`。判据里注入 resident 能力驱动替身，于是判据不 spawn 真进程。
3. **`POST /api/session-hosts/:sessionId/close` 的 per-run 拒绝臂 + 可辨错误码**（同文件）—— AC 逐字要求「对 per-run 会话的 close 被拒绝（proposal §13：关闭动作只对 resident 开放）」。AC-161 落这条路由，本条补**拒绝臂与错误码**：错误具名（如 `LIFECYCLE_MODE_NOT_RESIDENT`），与「会话不存在」「宿主不存在」两类错误**互相可辨**（判据并排打印三种情形的 code/status，证明不是同一个错误）。
4. **模式切换路径 + 宿主 busy 时的窗口规则** —— 写路径（校验目标模式在该 provider 的 `lifecycleModes` 里，不在则拒绝且错误可辨）与宿主过渡（resident→per-run 以 `mode-change` 解除绑定；per-run→resident 若旧 per-run 宿主仍在持有期先以 `superseded` 关闭，proposal §13.1/§13.3）。**busy 窗口**是 AC (5)：宿主 `state === 'busy'` 时**不在进行中的轮上切换** —— 要么拒绝（可辨错误码），要么推迟到本轮结束；两种都合规，但**不允许**在轮上生效。入口路径由实现者定（默认 `PUT /api/providers/:provider/sessions/:sessionId/lifecycle-mode`，与既有 `/:provider/sessions/:sessionId/active-model`、`active-effort` 同形）—— AC 只钉语义与不变式，判据用实际路径并在完成记录里写明。
5. **`residentFeatures` 能力格**（`provider-capabilities.service.ts` + `shared/types.ts`）—— proposal §5 `:256-264` 的八个字段（`interruptKeepsProcess` / `liveReconfigure` / `unattendedTurns` / `addressable` / `inputWhileBusy` / `cancelQueuedInput` / `authoritativeLeases` / `remoteControl`）；claude 行按 E1–E8 结论填，`liveReconfigure` 填 `[]` 并在注释里写明是「E1–E8 未覆盖、待单独验证」而不是已知为空；`inputWhileBusy` / `cancelQueuedInput` 正是 `gap-claude-resident-busy-input` 让给本 AC 的那一格。`RuntimeProviderCapabilities`（`shared/types.ts:2013` 附近的 `lifecycleModes`）同步收该字段，调试 agent 的镜像行为不因此改变（它本来就只声明 `lifecycleModes` / `multiplexedHost` 两格）。
6. **判据文件** `server/modules/session-hosts/tests/lifecycle-mode.test.ts` —— 形状照同目录既有的 `session-hosts-routes.test.ts`（真 express + 真 `authenticateToken` + 真 `initializeDatabase` + 真 manager，只有 provider 的 run 与 host driver 是替身；`JWT_SECRET` 必须在动态 import 之前设好、`IS_PLATFORM` 同理 —— 那段理由在 `session-hosts-routes.test.ts:52-63`）。

**五条假形态全部要在判据文件里承重**（判据内构造该假行为，断言对应读数**确实变红**，形状照 `model-gateway-end-to-end.test.ts:211` 的 `(b-fake)`）：(a) 写路径跳过能力矩阵校验（对 codex 接受 `resident`）⇒ (2) 红；(b) 分叉复制源的 `lifecycle_mode` ⇒ (3) 红；(c) per-run 会话的 close 返回 2xx（或静默 no-op）⇒ (4b) 的拒绝臂红；(d) busy 时切换照常生效（轮上就 `mode-change` 关宿主 / 存储列在轮中已变）⇒ (5) 红；(e) `/start` 只写库或空转、不调 `driver.startHost` ⇒ (4a) 红（`startHostCalls=0` 或宿主不出现在投影里）。

**三条正控制（防恒真/恒假）**：(i) 能力矩阵**含** resident 的 provider（AC-161 之后的 claude）写 `resident` 必须 **2xx 且读回 `resident`** —— 证明 (2) 不是「一律拒绝」；(ii) 常驻会话的 `/close` 必须成功且 `closeReason=user` —— 证明 (4b) 的 per-run 拒绝不是「close 恒失败」；(iii) 宿主**空闲**（无在飞轮）时同一模式切换必须**生效**（存储列改变 + 旧宿主以 `mode-change` 关闭）—— 证明 (5) 的「busy 时不动」不是「永远不动」。

**约束（红线）**

- 跨模块只经 barrel（`AGENTS.md` → `$backend-module-standards`；本仓 oxlint `boundaries/dependencies` 会让「只跑过自己那一个文件」的新测试在套件里红）—— 新判据的 import 走 `@/modules/session-hosts/index.js` / `@/modules/providers/index.js` / `@/shared/types.js`，缺符号就补 barrel，并把补过的 barrel 计入 Touches。
- 既有 6 条判据**一字不改**；per-run 会话的客户端可见行为逐字不变。
- `migrations.ts` / `schema.ts` 只在 AC-161 落地的列**不满足** (1) 的旧行读回时才动（例如列被加成无默认值的 `TEXT` ⇒ 旧行读 NULL）；否则不写。

## Plan

1. **前置门与读回**：`task_get` `gap-claude-resident-process-survival` 必须 `done`；读回列已在 `schema.ts`/`migrations.ts`/`sessions.db.ts` 落地、claude 能力行含 `resident`、`POST …/close` 在位。缺任一项就**停在登记处**并写回读数，不自行重做（重做即与在飞任务抢同一个写面）。
2. **判据骨架先红**：先把 `lifecycle-mode.test.ts` 的五条读数臂与五条假形态写出来，在**当前树**上跑出 (a)–(e) 各自的红态文案（此步 (1) 与 (4b) 的 close 本体已可由 AC-161 的落地物读绿，(2)/(3)/(5) 与 start 必红）。
3. **能力矩阵格**：加 `residentFeatures` 类型与 claude 行；跑既有 provider-capabilities / debug-agent 判据确认未动行为。
4. **start 路由 + 驱动解析缝**：`resolveHostDriver` 依赖参数 + `POST /:sessionId/start` + 两类拒绝的具名错误码；判据 (4a)/(4c) 与假形态 (e) 在这一层红→绿。
5. **close 的 per-run 拒绝臂**：具名错误码 + 与「会话不存在 / 宿主不存在」的可辨性读数（假形态 (c) 在这层红）。
6. **模式切换 + busy 窗口**：写路径校验（假形态 (a) 在这层红）+ 宿主过渡（`changeMode` / `superseded`）+ busy 拒绝或推迟（假形态 (d) 在这层红）+ 正控制 (iii)。
7. **分叉默认**：证明 resident 源分叉出的会话读回 `per-run`（假形态 (b) 红）；确认 `createForkedSession` 的列清单不含模式列。
8. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；既有 6 条判据逐条退出 0 且文件一字未改（`git diff --name-only` 里没有它们）；写完成记录（每条读数 + 五条假形态的实测退出码/红文案 + 三条正控制的读数）。

## AC

- [x] 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/lifecycle-mode.test.ts` 在落地后的树上退出 **0** 且 `fail 0`。红态基线（本轮直跑）：同命令退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/lifecycle-mode.test.ts'`；同命令形状跑 `server/modules/session-hosts/tests/session-host-lifecycle.test.ts` 退出 **0**（`tests 6 / pass 6 / fail 0 / duration_ms 339.239839`）⇒ 红只因判据文件不存在。命令逐字含文件路径，不用 glob。
- [x] (1) 迁移后既有会话为 per-run：判据里建一个**没有该列**的 legacy `sessions` 表并插一行，跑 `initializeDatabase`（真迁移）后 `PRAGMA table_info(sessions)` 含 `lifecycle_mode`，且**那一行**读回 `'per-run'`（打印 `legacyRowMode=per-run column=…`）；另一臂：全新库新建的会话行也读回 `per-run`（打印 `freshRowMode=per-run`）。
- [x] (2) 不支持的模式被拒且错误可辨：对 `lifecycleModes` 不含 `resident` 的 provider（codex / cursor / opencode 逐条打印）写 `resident` ⇒ 非 2xx **且**响应体带具名 code（打印 `code=… status=…`）；该 code 与「未知模式值」的错误 code **不同**（两者并排打印）。**正控制**：`lifecycleModes` 含 `resident` 的 provider（AC-161 之后的 claude）同一写入 ⇒ **2xx 且读回 `resident`**（打印 `claudeMode=resident`）⇒ 保证不是「一律拒绝」。
- [x] (3) 分叉不继承：把一个 **resident** 会话分叉（经 `forkSessionById` 或既有 fork HTTP 面），新会话 `lifecycle_mode` 读回 `per-run`（打印 `sourceMode=resident forkedMode=per-run`），且 `forked_from_session_id` 指向源。
- [x] (4a) start 拉起宿主：对 resident 会话 `POST /api/session-hosts/:sessionId/start` ⇒ 2xx，**且**该会话出现在 `GET /api/session-hosts` 的投影里（`mode=resident`，打印该行），**且**注入驱动的 `startHost` 调用计数 ≥1（打印 `startHostCalls=…`）。
- [x] (4b) close 对 resident 生效、对 per-run 被拒且可辨：resident 会话 `POST …/:sessionId/close` ⇒ 2xx 且宿主 `closeReason=user`（打印）；per-run 会话同一调用 ⇒ 非 2xx 且具名 code（打印 `perRunCloseCode=… status=…`），该 code 与「会话不存在」「宿主不存在」两个 code **互不相同**（三者并排打印）。**正控制**：(4b) 前半的 resident close 成功即证明拒绝臂不是「close 恒失败」。
- [x] (4c) 无驱动可拉起时也拒绝：对 resident 但 provider 无 `hostDriver` 的会话 `POST …/start` ⇒ 非 2xx 且具名 code，与 (4a) 的成功、与 (4b) 的 per-run 拒绝三者互不相同（并排打印）。
- [x] (5) busy 时不在轮上切换：令宿主 `state === 'busy'`（用 manager 的真实 lease / 驱动缝造出在飞轮）后发起模式切换 ⇒ 读数必须是「拒绝（具名 code）」或「推迟（本轮结束后才生效）」二者之一，且**在轮进行中**读到的存储列**未变**、宿主**未**收到 `mode-change` 关闭（打印 `busySwitch=<refused|deferred> storedModeDuringTurn=… modeChangeDuringTurn=false`）。**正控制**：同一会话在宿主**空闲**时切换 ⇒ 生效（存储列改变 + 旧宿主以 `mode-change` 关闭，打印 `idleSwitch=applied closeReason=mode-change`）⇒ 保证不是「永远不动」。
- [x] (5b) 推迟档若被选：推迟的那次切换必须在**本轮结束之后**真的生效（打印 `deferredAppliedAt=after-turn`）；若实现选「拒绝」，此项打印 `deferredNotImplemented` 并不断言 —— AC 允许二选一，判据不得把未选的那一档写成必红。
- [x] 假形态 (a) 承重：写路径跳过能力矩阵校验、对 codex 接受 `resident` ⇒ (2) **必须红**。
- [x] 假形态 (b) 承重：分叉复制源的 `lifecycle_mode` ⇒ (3) **必须红**。
- [x] 假形态 (c) 承重：per-run 会话的 close 返回 2xx / 静默 no-op ⇒ (4b) 的拒绝臂**必须红**。
- [x] 假形态 (d) 承重：busy 时切换照常生效（轮上就 `mode-change` 关宿主）⇒ (5) **必须红**。
- [x] 假形态 (e) 承重：`/start` 只写库 / 空转、不调 `driver.startHost` ⇒ (4a) **必须红**（`startHostCalls=0` 或宿主不出现在投影里）。
- [x] `residentFeatures` 到位：claude 行含 proposal §5 的八个字段（打印该行；`liveReconfigure=[]` 并注明「E1–E8 未覆盖，待单独验证」）；`RuntimeProviderCapabilities` 同步收该字段，且调试 agent 的镜像行为不变（既有 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts` 仍退出 0）。
- [x] 不越权：不重做 `sessions.lifecycle_mode` 列本体、claude 能力行 `lifecycleModes` 加 `resident`、`POST …/close` 路由本体（AC-161 的工作面）—— 若 `git diff` 里出现这三处的改动，完成记录必须逐条说明是「AC-161 的落地不满足本条判据读数」的**被迫**修正并给出读数。
- [x] 不使既有判据变红：`session-host-lifecycle` / `session-host-bindings` / `session-host-default-wrap` / `session-host-per-run-parity` / `session-hosts-routes` / `record-per-run-frame-baseline` 六条各自退出 **0**（逐条打印命令与退出码），且这六条文件**一字不改**（`git diff --name-only` 里没有它们）。
- [x] 契约面：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0（新判据的跨模块 import 全部经 barrel）。
- [x] 不闭环：本条的注入点不引入 `session-hosts → providers` 的反向 import 边（打印 `grep -rn "modules/providers" server/modules/session-hosts/ | grep -v tests` 的输出为空；驱动解析经 `server/index.ts` 组合根注入）。

## DoD

判据在**落地后的树**上按原命令重跑：退出码 0、`fail 0`。**真实落地**（不是「测试存在」）：判据里跑的是**真** express + 真 `authenticateToken` + 真 `initializeDatabase`（真迁移，含 legacy 行的读回）+ 真 `createSessionHostManager`，唯一的替身是 provider 的 run 与 host driver（照同目录 `session-hosts-routes.test.ts` 的既有做法）；resident 会话经 `POST …/start` **真的**让注入驱动收到 `startHost` 并在 `GET /api/session-hosts` 的投影里出现，`POST …/close` 真的以 `user` 关闭它，per-run 会话的 close 真的被拒且错误码与其余两类错误可辨；resident 源分叉出的会话真的读回 `per-run`；宿主 busy 时发起的模式切换真的**没有**在轮上生效（存储列未变、无 `mode-change` 关闭），而空闲时的同一切换真的生效（存储列改变 + `mode-change`）。五条假形态各有判据内一臂，且各自把对应读数打红（绿 = 判据有洞，必须先补判据再继续）；三条正控制各自的读数与拒绝臂并排打印。既有六条判据逐字不变且仍绿。完成后 AC-169 在驱动器下一轮经 `goal_ac: AC-169` 独立复跑时由红翻绿。

## Touches

- `server/modules/session-hosts/tests/lifecycle-mode.test.ts` （新：判据，AC-169 的 criterion 路径）
- `server/modules/session-hosts/session-hosts.routes.ts`（`POST /:sessionId/start` + close 的 per-run 拒绝臂 + `resolveHostDriver` 依赖参数）
- `server/modules/session-hosts/index.ts`（新符号经 barrel 收口）
- `server/modules/session-hosts/session-host-manager.service.ts`（模式切换的 busy 窗口缝，复用 `changeMode` / `unbindSession`）
- `server/modules/providers/provider.routes.ts`（模式切换入口）
- `server/modules/providers/services/sessions.service.ts`（模式切换写路径：能力矩阵校验 + busy 规则 + 宿主过渡次序；分叉默认 per-run 的读数面）
- `server/modules/providers/services/provider-capabilities.service.ts`（`residentFeatures` 格）
- `server/modules/providers/index.ts`（判据要用的符号经 barrel 收口，若未导出）
- `server/shared/types.ts`（`residentFeatures` 类型 + 模式写入/切换的具名错误码）
- `server/index.ts`（组合根注入 `resolveHostDriver`）
- `server/modules/database/repositories/sessions.db.ts`（`lifecycle_mode` 的读 + 模式切换的写；分叉路径的列清单）
- `server/modules/database/migrations.ts`（**仅当** AC-161 落地的列不满足 (1) 的旧行读回时的被迫修正）
- `server/modules/database/schema.ts`（同上）
- `tasks/gap-lifecycle-mode-matrix-and-host-api.md`（自触）