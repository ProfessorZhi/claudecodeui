---
id: gap-session-hosts-rest-list-endpoint
title: AC-156 `GET /api/session-hosts` 需鉴权：列出所有 provider
  的宿主（状态/绑定/保活理由/pid/关闭原因），lingering 可见，关闭原因有可注入时钟的保留窗口
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
goal_ac: AC-156
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rln 'goal_ac: *AC-156' tasks/*.md` → 0 命中；`grep -rln 'session-hosts-routes' tasks/*.md` → 0 命中；`ls tasks/ | grep session-hosts` → 只有 `gap-session-hosts-default-wrap-four-providers`（ready）与 `gap-session-hosts-per-run-frame-parity`（todo）两个。两条邻居都不重复，且都明确让出这一格：前者把 `session-hosts.routes.ts` 写进非目标，后者把「AC-156 的两条 REST」写进非目标，两条都只读 manager 快照、都不建 HTTP 面。本条认领的是判据要求的那一格：**一个需鉴权的 `GET /api/session-hosts`，数据来自宿主层快照（不是 run 表），并带一个钟可注入的「关闭后保留窗口」**。

这条判据必须跑在**宿主层已经接进分派入口**的树上 —— 否则「一个 codex 宿主运行中、一个 Claude 宿主 lingering」只能由测试自造，失去「经真实分派入口登记」这一半，判据也就无法区分「列表来自宿主层」与「列表来自 run 表」。故顶层 `depends_on` 指向 AC-154 的落地任务：先让包装接进 `provider-runtime.service.ts`，本条再在其上加读口与 HTTP 面。

**来源与判据物。** 判据逐字取自 `goals/AC-156-get-api-session-hosts-列出所有-provider-的宿主-含状态-绑定-保活理由与关闭原因-需鉴权.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts`。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，文案逐字 `Could not find 'server/modules/session-hosts/tests/session-hosts-routes.test.ts'`；`ls server/modules/session-hosts/` → `No such file or directory`。

**现状（本轮实测的读数，逐条都有出处）**

- **「列表即 run 表」是判据点名的假形态，它在仓里有真实先例**：`server/modules/providers/services/sessions.service.ts:201` 的 `listRunningSessions()` 就是 `chatRunRegistry.listRunningRuns()`；而 `server/modules/websocket/services/chat-run-registry.service.ts:220` 的 `listRunningRuns()` 只返回 `status === 'running'` 的 run，`:216` 的 `isProcessing()` 同理只看 run 状态。lingering（complete 已发、`run()` 的 promise 未结算、宿主仍在）在 run 表里**没有对应物** ⇒ 映射出来的列表恰好缺这一条。这就是本判据「必须读宿主层」的分辨力来源，也是假形态的实现路径。
- **鉴权面照生产**：`server/index.ts:199-209` 每个受保护路由都是 `app.use('/api/<x>', authenticateToken, <router>)`；`server/modules/auth/auth.middleware.ts:53` 缺凭据时 `401 { error: 'Access denied. No token provided.', code: 'AUTH_TOKEN_INVALID' }`。
- **200 不是挂载证据**：未挂载的 `/api` 路径落到 SPA catch-all 返回 `200 text/html` —— `server/index.ts:215` 的注释逐字写了这一点，`server/index.ts:250-258` 是那段 catch-all（dev 下 302 到 Vite）。所以判据断言内容类型与形状，并把「未挂载的路径在这套 harness 里长什么样」做成一条正控制。
- **路由测法的现成先例**：`server/modules/voice/tests/voice-config.routes.test.ts:36-52` 在动态 import 之前设 `process.env.JWT_SECRET`（`auth.middleware.ts` 在模块加载期解析它，否则会去读并创建开发者真实的 `~/.cloudcli/auth.db`）、删 `VITE_IS_PLATFORM`；`:108-175` 用 `express()` + **真实** `authenticateToken` + 临时 `DATABASE_PATH` + `addUser`/`signToken` 起真实 HTTP 服务并挂生产同形的错误中间件。本条照这份写。
- **驱动链的现成先例**：`server/modules/debug-agent/tests/debug-agent-frames.test.ts:224-241` 就是「`chatRunRegistry.startRun(...)` 拿 run → `providerRuntimeService.run(provider, cmd, {sessionId}, run.writer)`」这条链，注释逐字说明「链是产品的、不是绕过」；`server/modules/scheduled-messages/tests/scheduled-messages.test.ts:103` 同形。`chatRunRegistry` 经 `server/modules/websocket/index.ts:3` 的 barrel 导出，跨模块 import 合规。
- **run 在 complete 帧上自动收尾**：`chat-run-registry.service.ts:84-113` 的 `decorateAndRecordEvent` 在 `kind === 'complete'` 过 writer 时把 `run.status = 'completed'`。所以「Claude 那轮的 `isProcessing() === false` 而宿主仍 lingering」可以**纯由真实链产生**，不需要测试手改 run 状态。
- **注入缝**：`server/modules/providers/services/provider-runtime.service.ts:42` 的 `createProviderRuntimeService(overrides)`；最小假 `IProviderRuntime`/`IProvider` 形态与注入写法在 `server/modules/providers/tests/provider-runtime.service.test.ts:10-69`。AC-154 的包装加在 `createProviderRuntimeService` 内部 ⇒ 经它分派的一轮会被登记进 manager。
- **响应封装**：`server/shared/utils.ts:71` 的 `createApiSuccessResponse<TData>(data)` → `{ success: true, data }`；列表型路由写法见 `server/modules/scheduled-messages/scheduled-messages.routes.ts:37`。

**要建的东西**

1. **manager 侧的保留窗口与钟**（落在 AC-154 建的 `server/modules/session-hosts/session-host-manager.service.ts` 上，不新起第二份状态）：
   - 关闭的宿主不立刻从表里消失；`snapshot()` 在**读时**过滤掉「`closedAt + closedHostRetentionMs <= now()`」的条目。读时过滤让 (3) 的「窗口内可读、窗口过后消失」不需要任何定时器、也不依赖真实 sleep。
   - 钟与窗口都注入：`createSessionHostManager({ now, closedHostRetentionMs })`，默认 `now = Date.now`；`closedHostRetentionMs` 钉成模块内具名的导出常量（建议 5 分钟，AC-156 只要求「有窗口、可注入」，数值实现时定并写进完成记录）。
   - AC-154 落地后按其 `snapshot()` 的实际形状做**最小**改动（若它已经把关闭宿主丢掉或返回全部宿主，照实际改这条读时过滤），**不改**它的运行中语义。
2. **把 manager 变成可注入依赖**（`server/modules/providers/services/provider-runtime.service.ts`）：`ProviderRuntimeServiceDependencies` 增加 `sessionHostManager`（默认取模块单例，生产行为不变）。AC-154 若已留了这个缝就直接用。**没有这个缝，(3) 的注入钟就没法既驱动分派、又读同一个 manager。**
3. **路由** `server/modules/session-hosts/session-hosts.routes.ts`：导出 `createSessionHostsRouter({ sessionHostManager })`，只做「读快照 → `res.json(createApiSuccessResponse({ hosts }))`」。每条宿主带 `hostId`、`provider`、`mode`、`state`、`pid`（没有则 `null`）、`startedAt`、`closeReason`（未关闭为 `null`）、`bindings`（数组，每项 `appSessionId`、`providerSessionId`、`state`、`leases`、`lastActivityAt`）。路由不查数据库、不 import `chatRunRegistry`（业务在 manager 里）。经 `server/modules/session-hosts/index.ts` 桶导出（后端规范：跨模块只走 barrel）。
4. **挂载**（`server/index.ts`）：在受保护 API 段落里加 `app.use('/api/session-hosts', authenticateToken, sessionHostsRoutes);`，与 `:199-209` 同形。**无条件挂载** —— 这条不是 debug agent 那种由 gate 决定存在性的面。
5. **判据测例** `server/modules/session-hosts/tests/session-hosts-routes.test.ts`（见下）。
6. 假 runtime 只在测试里，用 `createProviderRuntimeService` 的注入缝；**四个 runtime 文件一个字节不动**。

**判据测例怎么搭**（每个子例各起一份 manager + 一份 express app，确定性；钟是注入的，不用真实 sleep）

- 共享脚手架：动态 import 前设 `JWT_SECRET`、删 `VITE_IS_PLATFORM`；临时 `DATABASE_PATH` + `initializeDatabase()`；`addUser` + `signToken`；`express()` + `app.use('/api/session-hosts', authenticateToken, createSessionHostsRouter({ sessionHostManager }))` + 生产同形的错误中间件 + **一段 `200 text/html` 的 catch-all**（照生产 SPA 落点）。分派侧：`createProviderRuntimeService({ resolveProvider: …, sessionHostManager })`，provider 的 `runtime.run(command, options, writer)` 由测试控制（发帧 / 挂住不结算）。
- (1) 缺凭据 ⇒ `401`，`content-type` 含 `application/json`，`code === 'AUTH_TOKEN_INVALID'`。**正控制**：同一 app 上一个未挂载的邻居路径（如 `/api/session-hosts-does-not-exist`）读 `200` 且 `content-type` 含 `text/html` —— 证明这套 harness 里 401 不是恒真、也不是 200 的另一种说法。
- (2) 两个宿主同时在场：**codex** 的 per-run 一轮在飞行中（假 runtime 的 `run` 悬着不结算；经真实 `chatRunRegistry.startRun` 记成 running ⇒ `isProcessing === true`，宿主 `state=busy`）；**Claude** 的 per-run 一轮已经由假 runtime 经 `run.writer` 发出 `complete` 帧、此后 `run` 的 promise 仍不结算（⇒ 注册表自动 completed，`isProcessing === false`，宿主 `state=lingering`）。经路由断言列表**恰含这两条**，每条带 `provider`/`mode`/`state`/`pid`/`closeReason`/`bindings`（含本轮 `appSessionId` 与 `leases`）。两条 `isProcessing` 读数都打印。
- (3) 保留窗口：一个刚关闭的宿主（`closeReason=turn-complete`），钟不动时经**路由**读到它且 `closeReason` 就是 `turn-complete`；把钟推过 `closedHostRetentionMs` 后再读同一条路由，它消失。两个读数都打印。
- (4) 形状与内容类型：`content-type` 含 `application/json`、body `JSON.parse` 成功、`success === true`、`data.hosts` 是数组、每个元素键集 `deepEqual` 于断言的字面键集。**不以状态码 200 作为挂载证据。**
- **负控制**：manager 空表时路由返回 `data.hosts.length === 0`。
- **假形态（判据分辨力证明，必须实测）**：把路由的数据源换成 `chatRunRegistry.listRunningRuns()` 映射 ⇒ (2) 必须红（lingering 那条缺失），退出码 1，红态文案点名缺的那条。只改实现、判据文件一字不动；实测完 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。

**非目标**：AC-154（宿主登记与关闭原因）、AC-155（逐帧不变）、AC-157（状态机/停机/关闭原因穷举）、AC-158（1:N 解绑与顶替）、AC-159（Claude 常驻 driver）、AC-160（调试 agent 场景 op）、能力矩阵字段、`POST /api/session-hosts/:sessionId/start|close`、`process-containment.service.ts`、`lifecycle_mode` 列、`chat-run-registry`/`scheduled-message-dispatcher` 的 run-source 字段。不改任何 per-run 的客户端可见行为。

## Plan

1. 读 AC-154 的落地提交：manager 的 `snapshot()` 实际形状、关闭宿主是否还在表里、`createProviderRuntimeService` 是否已能注入 manager。按实际形状改第 1/2 条。
2. manager 加 `now`/`closedHostRetentionMs` 注入与读时保留窗口过滤；`index.ts` 桶补路由工厂导出。
3. 写 `session-hosts.routes.ts`（读快照 → `createApiSuccessResponse`），在 `server/index.ts` 挂载。
4. 写判据测例：四个子例 + (1) 的正控制（未挂载邻居路径 200 html）+ 负控制（空表）+ 假形态实测。
5. 实测假形态（数据源换成 `listRunningRuns` 映射），抄退出码与红态文案，`git checkout --` 还原。
6. `npm run typecheck`、`npm run lint`、既有 `provider-runtime.service.test.ts` 与 AC-154 的 `session-host-default-wrap.test.ts` 全绿；写完成记录。

## AC

- [x] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`。红态基线已测：同命令当前退出 1、文案逐字 `Could not find 'server/modules/session-hosts/tests/session-hosts-routes.test.ts'`。
- [x] AC2 鉴权：无凭据请求 `GET /api/session-hosts` 得 **401** 且 `content-type` 含 `application/json`、`code === 'AUTH_TOKEN_INVALID'`（读的是生产 `authenticateToken`）。**正控制**：同一 app 上未挂载的邻居路径读 **200** 且 `content-type` 含 `text/html`。两个读数都打印（`no-credential=… unmounted-neighbour=…`）。
- [x] AC3 (2) 列表含两条且每条形状完整：codex per-run 宿主（run 在飞行中，`chatRunRegistry.isProcessing === true`）与 Claude per-run 宿主（complete 已发、`isProcessing === false`、`state=lingering`）；逐条打印 `provider=… mode=… state=… pid=… closeReason=… appSessionId=… leases=…`，并打印两条 `isProcessing`。
- [x] AC4 (2) 的两条来自宿主层而非 run 表：Claude 那条 `state=lingering` 与 `isProcessing === false` 同时成立（run 表里没有它）；列表条数为 2（打印 `hosts=2`）。
- [x] AC5 (3) 保留窗口：刚关闭的宿主（`closeReason=turn-complete`）在注入钟不动时经路由可读且 `closeReason` 就是 `turn-complete`；把注入钟推过 `closedHostRetentionMs` 后再读同一条路由，它不再出现。两个读数都打印（`in-window=… after-window=…`）。
- [x] AC6 (4) 形状与内容类型：`content-type` 含 `application/json`、body `JSON.parse` 成功、`success === true`、`data.hosts` 为数组、元素键集 `deepEqual` 于断言的字面键集；**不以状态码 200 作为挂载证据**（200 已被正控制那条 html 路径占用）。
- [x] AC7 负控制：manager 空表时路由返回 `data.hosts.length === 0`（打印 `empty-hosts=0`）。
- [x] AC8 假形态承重：把路由的数据源换成 `chatRunRegistry.listRunningRuns()` 映射 ⇒ 判据退出 **1**，红文案点名 (2) 里 lingering 那条缺失。实测退出码与红态文案抄进完成记录，用后还原。
- [x] AC9 生产面零改动：`git diff --name-only` 里没有 `server/modules/providers/list/**`、没有 `server/modules/websocket/services/**`；落地的只有 Touches 列出的文件（`git diff --stat` 逐条对齐）。
- [x] AC10 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-runtime.service.test.ts` 退出 0；AC-154 的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-default-wrap.test.ts` 仍退出 0（manager 是共享文件，本条加读时过滤不得把它改红）。
- [x] AC11 后端规范：路由只做「读快照 → 响应」（无业务逻辑、无数据库、不 import `chatRunRegistry`）；跨模块只经 barrel；模块内不建 `types.ts`/`interfaces.ts`/`utils.ts`（`ls server/modules/session-hosts/{types,interfaces,utils}.ts` 全不存在）；新增文件都是 TypeScript。
- [x] AC12 如实登记：完成记录写明（a）`closedHostRetentionMs` 的实际取值与具名导出位置、钟注入的接缝（哪个文件、哪个字段）；（b）AC-154 落地后 `snapshot()` 的实际形状、本条改了什么；（c）假形态的实测退出码与红态文案；（d）`pid` 在默认包装下为 `null`（runtime 不对外暴露 pid），本条不谎报 pid；（e）未实现：AC-157…AC-160、`POST /start|close`、能力矩阵。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts`）重跑：退出码 0 且 `fail 0`。(1) 的 401 读数与正控制的 200 html 读数、(2) 两条宿主的逐字段读数与两条 `isProcessing`、AC5 的窗口内/窗口后两个读数、AC6 的键集、AC7 的空表读数、AC8 假形态的实测退出码与红态文案，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0（含 AC-154 判据文件仍绿）。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；四个 runtime 文件不在其中）。完成后 AC-156 在驱动器下一轮经 `goal_ac: AC-156` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC8「列表由 `listRunningRuns` 映射」的变体必红，AC2 的正控制（未挂载邻居路径 200 html）保证 401 那条不是恒真。

## Touches

- server/modules/session-hosts/session-hosts.routes.ts (new)
- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/index.ts
- server/modules/session-hosts/tests/session-hosts-routes.test.ts (new)
- server/modules/providers/services/provider-runtime.service.ts
- server/index.ts
- tasks/gap-session-hosts-rest-list-endpoint.md

## 完成记录

落地提交：`ac0feb86 feat(session-hosts): serve the host listing over GET /api/session-hosts`（实现与判据文件同一提交）。分支 `task/gap-session-hosts-rest-list-endpoint`，基线 develop `97b1f539`。

改动文件（`git diff --name-only develop...HEAD`，6 条，与 Touches 逐条对齐）：

```
server/index.ts
server/modules/providers/services/provider-runtime.service.ts
server/modules/session-hosts/index.ts
server/modules/session-hosts/session-host-manager.service.ts
server/modules/session-hosts/session-hosts.routes.ts (new, 98 行)
server/modules/session-hosts/tests/session-hosts-routes.test.ts (new, 599 行)
```

`git diff --name-only develop...HEAD | grep -cE 'server/modules/(providers/list|websocket/services)/'` → **0**；`git diff --stat develop...HEAD` → `6 files changed, 810 insertions(+), 12 deletions(-)`。四个 provider runtime 文件一个字节未动。

### (a) `closedHostRetentionMs` 的实际取值、具名导出位置、钟注入的接缝

- **取值 5 分钟**：`export const CLOSED_HOST_RETENTION_MS = 5 * 60 * 1000;`（300000 ms），落在 `server/modules/session-hosts/session-host-manager.service.ts:110`，经模块桶 `server/modules/session-hosts/index.ts:14` 再导出（跨模块只走 barrel，后端规范）。判据文件读的就是这枚常量本身（`advance(CLOSED_HOST_RETENTION_MS)`）而不是把 300000 抄第二遍，故「窗口远端」与实现同源。
- **两个注入接缝都在 `createSessionHostManager(options: SessionHostManagerOptions)`**：`now?: () => number`（`session-host-manager.service.ts:145`，缺省 `Date.now`）与 `closedHostRetentionMs?: number`（同文件 `:159`，缺省 `options.closedHostRetentionMs ?? CLOSED_HOST_RETENTION_MS`，`:266`）。判据 (3) 注入一枚可变数字当时钟，因此窗口远端不需要 `setTimeout`、不需要真实 sleep —— 判据文件内 `grep -cE 'setTimeout|await sleep|node:timers'` → **0**。
- 生产路径不加缝：`server/index.ts` 走 `createSessionHostManager()` 的缺省分支，进程级单例行为不变；`providerRuntimeService` 的 `sessionHostManager` 也缺省取同一枚单例，故路由读的表就是分派写的那张表。

### (b) AC-154 落地后 `snapshot()` 的实际形状、本条改了什么

AC-154 落的 `snapshot()` 是**返回表内全部宿主**（关闭的也在），逐条 `copyHost` 成脱离引用的副本；类文档注释当时逐字写着 "Retention is deliberately unbounded for now: closed hosts stay readable so a close reason survives the run that produced it, and a pruning policy belongs to the AC that adds host listing" —— 本条就是那个 AC。改动**最小**，三处：

1. 新增侧索引 `closedAtByHostId = new Map<string, number>()`，在 `closeHost()` 里紧挨 `host.state = 'closed'` 记 `closedAtByHostId.set(hostId, now())`。用侧索引而不是给 `ProcessHost` 加 `closedAt` 字段：该记录类型在 `server/shared/types.ts`（不在 Touches 里），且「何时关闭」是 manager 自己的记账而非客户端要的字段。
2. `snapshot()` 改为读时过滤 —— 一次 `const at = now()`，`[...hosts.values()].filter((host) => withinRetention(host, at)).map(copyHost)`；`withinRetention` 对 `state !== 'closed'` 恒真，对已关闭宿主比较 `closedAt + closedHostRetentionMs > at`，`closedAt` 缺席（防御式分支）也判真。同一枚 `at` 用于所有宿主，故同时关闭的两个宿主同时过期。
3. 类文档注释与 `snapshot()` 的 doc 注释同步改写（不再写 unbounded，改述「只在读口过期，底层索引永不回收」）。

**运行中语义一字未改**：`deriveState` 与 lease 派生、`LifecyclePolicy`、`lingering`/`superseded` 的产生入口、`shutdown()`、`bindSession`/`unbindSession` 全部未触碰；本条只加了一条读取侧的过期判断。

**如实登记一处副作用**：`snapshot()` 是本模块唯一的读口，所以这条窗口同时作用于四条邻居判据。落地前核对过它们不会因此变红 —— AC-154 的 FakeClock 虽会推进到 24h，但每条「关闭后」读数都紧跟在关闭之后取（`closedAt` 与 `clock.now()` 同刻，窗口内），AC-157 的生命周期判据同理；实测四条邻居判据全绿（见 AC10 与下）。

### (c) 假形态（AC8）实测退出码与红态文案

假形态：把路由的数据源从 `sessionHostManager.snapshot()` 换成 `chatRunRegistry.listRunningRuns()` 的映射（即把 run 表当宿主表，Proposal 点名的那个假形态，仓里有 `sessions.service.ts:201` 的真实先例）。改动只落在 `server/modules/session-hosts/session-hosts.routes.ts` 一处，**判据文件一字未动**。实测：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts
FAKE_FORM_EXIT=1
ℹ tests 5 / ℹ pass 2 / ℹ fail 3
```

首条红就是判据要求的「(2) 里 lingering 那条缺失」（文案逐字，测试自己拼的上下文说明在前）：

```
AssertionError [ERR_ASSERTION]: the listing is missing the Claude host: its turn wrote the terminal complete frame while its run promise is still pending, so the host layer holds it as lingering and the run registry no longer reports it (isProcessing=false) — hosts=[{"hostId":"run-ac156-two-codex","provider":"codex","mode":"per-run","state":"busy","pid":null,"startedAt":1790426865690,"closeReason":null,"bindings":[{"appSessionId":"ac156-two-codex","providerSessionId":null,"state":"busy","leases":[{"kind":"turn","runId":"run-ac156-two-codex"}],"lastActivityAt":1790426865690}]}]
```

同一轮另外两条红（读数，非落点，一并登记）：`✖ AC5` 红在 `in-window=0 closeReason=undefined hosts=1`（run 表里没有「刚关闭」这个概念）；`✖ AC7` 红在 `2 !== 0`（`empty-hosts=2`）—— 负控制也红，因为 `listRunningRuns()` 读的是**全局** run 表，与本例那枚空 manager 无关，这一条恰好把「列表来自宿主层而不是 run 表」从另一侧钉住。AC2（401 + 未挂载邻居 200 html 正控制）与 AC6（形状/内容类型）在假形态下仍绿，说明这不是「整个 harness 崩掉」式的红。

还原：路由与判据两份文件 `diff -q` 对 `/tmp/ac156-routes-backup.ts`、`/tmp/ac156-test-backup.ts` 逐字节相同；`git status --short` 回到只剩 Touches 六条；重跑判据 EXIT=0、`fail 0`。

### (d) `pid` 在默认包装下为 `null`，本条不谎报 pid

路由把 `host.pid` **原样**投影（`pid: host.pid`），不从 `process.pid`、不从子进程、不从任何旁路补一个数。经 `providerRuntimeService` 默认包装登记的那条路径不给宿主 pid（`ProcessHost.pid` 的类型是 `number | null`，`openHost`/`bindSession` 上的 `pid` 入参留给自己持有子进程的 driver，即 AC-159 的常驻 driver），故判据里两条宿主的读数都是 `pid=null`。这条是**如实登记为 null**，不是「未实现 pid」的委婉说法。

### (e) 未实现（如实登记）

不在**本条 diff** 里的东西，逐条列出：

- **AC-157**（状态机/停机/关闭原因穷举）与 **AC-158**（1:N 解绑与顶替）：实现由各自任务承担；本条只加读时窗口，未改生命周期语义。**AC-159**（Claude 常驻 driver）、**AC-160**（调试 agent 场景 op）同样不在本条。
- `POST /api/session-hosts/:sessionId/start|close`：**未建**。本条的路由只有 `router.get('/')` 一条。
- 能力矩阵字段（`provider-capabilities.service.ts` 侧 `lifecycleModes`/`multiplexedHost` 的镜像）：未加。
- `process-containment.service.ts`、数据库 `lifecycle_mode` 列、`chat-run-registry` 与 `scheduled-message-dispatcher` 的 run-source 字段：未动。
- 前端：未动（本条只有服务端读口）。

### 判据读数（AC1–AC8）

判据入口（AC1），在**落地后的树**上按原命令跑：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts
（exit 0）
no-credential=401 content-type=application/json; charset=utf-8 code=AUTH_TOKEN_INVALID
unmounted-neighbour=200 content-type=text/html; charset=utf-8
✔ AC2: the listing needs a token, and the harness can also answer 200 html
host provider=codex mode=per-run state=busy pid=null closeReason=null appSessionId=ac156-two-codex leases=turn
host provider=claude mode=per-run state=lingering pid=null closeReason=null appSessionId=ac156-two-claude leases=none
isProcessing codex=true claude=false hosts=2
✔ AC3/AC4: two hosts — one run in flight and one whose turn ended while its run is still held
in-window=1 closeReason=turn-complete hosts=1
after-window=0 advance=300000
✔ AC5: a closed host is readable inside the retention window and gone after it
content-type=application/json; charset=utf-8 status=200 success=true hosts-is-array=true hosts=1
keys=bindings,closeReason,hostId,mode,pid,provider,startedAt,state
✔ AC6: the listing is JSON, enveloped, and every host carries exactly the declared keys
empty-hosts=0
✔ AC7: a manager that never dispatched a turn lists nothing
ℹ tests 5 / suites 0 / pass 5 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 1763.929883
```

AC2：`no-credential=401 content-type=application/json; charset=utf-8 code=AUTH_TOKEN_INVALID`；正控制 `unmounted-neighbour=200 content-type=text/html; charset=utf-8`。两条都打印 —— 401 不是恒真，也不是 200 的另一种说法。

AC3：两条宿主逐字段读数如上（`provider=… mode=… state=… pid=… closeReason=… appSessionId=… leases=…` 齐全），两条 `isProcessing` 都打印。

AC4：Claude 那条 `state=lingering` 与 `isProcessing=false` **同时成立**（run 表里没有它 —— 它的 complete 帧已被 writer 自动收尾成 `completed`）；`hosts=2` 打印。

AC5：`in-window=1 closeReason=turn-complete hosts=1`（钟不动时经**路由**读到刚关闭的宿主，且原因就是 `turn-complete`）；`after-window=0 advance=300000`（把注入钟推过 `CLOSED_HOST_RETENTION_MS` 后同一条路由不再返回它）。

AC6：`content-type=application/json; charset=utf-8 status=200 success=true hosts-is-array=true hosts=1`；键集 `keys=bindings,closeReason,hostId,mode,pid,provider,startedAt,state` 由上表两条打印且与断言的字面键集 `deepEqual`。**不以状态码 200 作挂载证据** —— 200 已被正控制那条 html 路径占用。

AC7：`empty-hosts=0`。

AC8：见 (c)。

### 契约面（AC9–AC11）

AC9：`git diff --name-only develop...HEAD` 六条与 Touches 逐条对齐（见上）；无 `server/modules/providers/list/**`、无 `server/modules/websocket/services/**`（`grep -c` → 0）。

AC10：`npm run typecheck` 退出 **0**；`npm run lint` 退出 **0**（`grep -cE ': error'` → 0，只剩既有 warning）。既有判据在落地后的树上：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-runtime.service.test.ts` 退出 0（`tests 3 / pass 3 / fail 0`）；`... server/modules/session-hosts/tests/session-host-default-wrap.test.ts`（AC-154）退出 0（`tests 6 / pass 6 / fail 0 / duration_ms 6014.574815`）。

AC11：`ls server/modules/session-hosts/{types,interfaces,utils}.ts` → 三者皆 `No such file or directory`；路由只做「读快照 → 投影 → `createApiSuccessResponse`」，`grep -cE '^import.*(chatRunRegistry|sessionsDb|database)' server/modules/session-hosts/session-hosts.routes.ts` → **0**（文件里 `chatRunRegistry` 只出现在 doc 注释里，用来说明**为什么**不查 run 表），无业务逻辑、无数据库访问；跨模块只经 barrel（`server/index.ts` 的 import 走 `@/modules/session-hosts/index.js`）；新增两个文件都是 `.ts`。

### 作用域门（worker 侧先行）

`bash scripts/test.sh --for-task gap-session-hosts-rest-list-endpoint --allow-thin`：退出 **0**，`suite-scope-check: PASS`（`tasks=206 skipped(done/superseded)=197 active=9 with-tests=7 no-tests=2`），`__PERFILE__ duration_ms=1955 server/modules/session-hosts/tests/session-hosts-routes.test.ts passed=true`，`# tests 1 / # pass 1 / # fail 0 / # cancelled 0`。

### 顺序说明

本轮按 ABI 用 `task_write` 记录 AC 状态与本节（该写自带提交 `tasks/<id>.md` 并推进 develop）**先行**，随后 `git merge --no-edit develop` → 重跑作用域门 → 写 scoped-gate 缓存（`--develop-sha "$(git rev-parse HEAD^2)"`，即合并提交真正并入的那枚 develop 尖端，按构造成 HEAD 的祖先）。上面那条作用域门读数取自 `task_write` 之前的一次运行（先把读数写进本节），`task_write` 之后再在并入 develop 的树上复跑一次确认，两次同为 `passed=true`。
