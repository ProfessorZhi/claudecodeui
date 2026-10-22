---
id: gap-session-hosts-lease-driven-lifecycle
title: AC-157 宿主状态机由保活理由驱动：伪造 driver + 注入时钟直接驱动 manager，per-run/resident
  两种策略、关闭原因枚举十值穷举、attach 不刷新 lastActivityAt、exited(oom) 与 shutdown() 停机
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
goal_ac: AC-157
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-157" tasks/*.md` → **0 命中**；`grep -rln "quietCeiling\|HostCloseReason\|HostLease\|resident-policy\|server-shutdown\|session-host-manager\|closeHost" tasks/*.md` → 只有两条邻居（`gap-session-hosts-default-wrap-four-providers`、`gap-session-hosts-rest-list-endpoint`），且两条都只在**非目标**里点名 AC-157、不认领它；`ls tasks/ | grep -iE "session-host|host-lifecycle|lease|keepalive|shutdown"` → 三条 session-hosts 任务（AC-154 ready、AC-155 todo、AC-156 todo）。AC-154…AC-156 已被那三条认领，AC-157 无认领者。本条认领的是判据要求的那一格：**状态由保活理由（lease）而不是 turn 的开合驱动、两种策略参数、关闭原因枚举十值逐个被产生并断言、以及 shutdown() 停机**。本条的判据就是直接驱动 AC-154 建的那个 manager（`server/modules/session-hosts/session-host-manager.service.ts`），因此必须先有 AC-154 的 module 与共享契约才能落地，故顶层 `depends_on` 指向 AC-154 的落地任务。

**来源与判据物。** 判据逐字取自 `goals/AC-157-宿主状态机由保活理由驱动-两种策略-每种关闭原因与停机都可判.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts`。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-lifecycle.test.ts'`；`ls server/modules/session-hosts/` → `No such file or directory`。

**现状（本轮实测的读数）**

- **宿主层在代码里零命中**：`grep -rn "HostCloseReason\|HostLease\|HostState\|ProcessHost\|closeHost\|lingering" server/` → **0 命中**；`grep -rn "RESIDENT_IDLE_TIMEOUT\|quietCeiling\|server-shutdown\|resident-policy" server/` → **0 命中**。即 AC-154 今天还没落地（它的 manager 是本条的落地前置），而 resident 侧的任何东西在 `server/`、`src/` 里都不存在。
- **判据表的位置**：proposal `docs/proposals/claude-resident-sessions.md` —— 保活理由 `:148-156`（`turn` / `background-task`|`monitor` / `cron{id,recurring,expiresAt}` / `resident-policy`）、策略表 `:158-165`（`supersedeOnNewTurn`、`closeWhenLeasesEmpty`、`quietCeilingMs` per-run 30 分钟 vs resident `RESIDENT_IDLE_TIMEOUT` 24 小时）、状态机 `:167-176`（`busy`=有 turn；`lingering`=轮次已结束但还有后台/monitor/cron；无其他理由时 resident 停 `idle`、per-run 直接 `closing`）、关闭原因枚举 `:178-191`（**十个值**：`turn-complete`、`released`、`superseded`、`aborted`、`user`、`idle`、`mode-change`、`rewind`、`exited`、`server-shutdown`；`exited` 附 `detail`：`oom`|`signal`|`error`）。
- **今天唯一存在的「保活」是 turn + 30 分钟持有，且它是 provider 内部实现**：`server/modules/providers/list/claude/claude-runtime.provider.js:791` 的 `idleReleaseTimer`（`:814-823` 排 30 分钟、`:1080`/`:1161-1162` 在 result 与收尾时清），`BG_WAIT_CEILING_MS = 30 * 60 * 1000`（`:73`，`:231` 经 env 传给 CLI、`:821` 是那个 30 分钟持有期）。⇒ per-run 的 `quietCeilingMs` 默认值与它同值，但 **manager 不得 import 这个 runtime 模块**（默认包装按 proposal §219-227 是 provider 无关的；四个 runtime 文件属非目标）。`RESIDENT_IDLE_TIMEOUT` 今天零命中 ⇒ resident 的 24 小时是本条新落的具名常量。
- **停机面只有一处**：`server/index.ts:389` 的 `shutdownRuntimeServices`（`:407-408` 挂 `SIGTERM`/`SIGINT`，逐项 `try/catch` 后 `process.exit(0)`）。本条的 `sessionHostManager.shutdown()` 接在这里。
- **钟与调度器今天没有注入先例**：`grep -rn "now: Date.now\|clock" server/modules/*/services/*.ts server/shared/*.ts` → 0 命中；`setTimeout` 直接用在 `chat-run-registry.service.ts:63`、`shell-websocket.service.ts:629` 等处（都是真实定时器）。判据要求「注入时钟直接驱动 manager」且 24 小时的 idle 超时不可能靠真实等待 ⇒ 本条必须**自带**一个调度器接缝（见下），这是本条判据确定性的承重件。
- **测试框架与别名**：判据文件与既有后端测试同形 —— `node:test` + `node:assert/strict`，import 用 `@/modules/…js`、`@/shared/…js`（照 `server/modules/providers/tests/provider-runtime.service.test.ts:1-16` 与 `claude-background-work.test.ts:1-4`）。仓里今天没有 `t.mock.timers` 用法（`grep -rln "mock.timers" server/` → 0 命中）。

**要建的东西（范围是 AC-157 的最小充分集，其余交给兄弟 AC）**

1. **共享契约**（`server/shared/types.ts`，AC-154 已在此落 `HostCloseReason`/`HostLease`/`ProcessHost`/`SessionBinding`，本条在其上补）：
   - `LifecyclePolicy`：`supersedeOnNewTurn: boolean`、`closeWhenLeasesEmpty: boolean`、`quietCeilingMs: number`（proposal §158-165 的三行参数）。
   - `HostCloseDetail`：`'oom' | 'signal' | 'error' | 'forced'` —— 前三个是 proposal `:190` 的 `exited` 细节，`'forced'` 是 (5) 「超时未关被强制关闭并记录」的落地形态。
   - `HOST_CLOSE_REASONS: readonly HostCloseReason[]`：把关闭原因**以值数组常量**导出（与类型同步），使「枚举十值穷举」可机械断言，而不是靠人肉列举十个字面量。按后端规范放在共享文件（消费方 ≥ 2：manager 与判据），带说明与消费方注释。
   - 若 AC-154 的 driver sink 未把 `exited` 带上 `detail`，只在 `server/shared/interfaces.ts` 的对应事件上加这一个可选字段（以 AC-154 的实际形状为准，完成记录写明是否改动）。
2. **manager**（`server/modules/session-hosts/session-host-manager.service.ts`，不新起第二份状态表）：
   - **注入**：`createSessionHostManager({ now, scheduler, perRunPolicy, residentPolicy })`，默认 `now = Date.now`、`scheduler` 为真实 `setTimeout`/`clearTimeout` 包装，策略默认取 proposal 表（per-run `quietCeilingMs = 30 * 60 * 1000`；resident `quietCeilingMs = RESIDENT_IDLE_TIMEOUT = 24 * 60 * 60 * 1000`，模块内具名导出）。调度器接缝形如 `{ schedule(at: number, run: () => void): () => void }` —— **按绝对 epoch 调度**，判据注入一个「按注入钟排序、`advance(ms)` 时按序触发」的假调度器 ⇒ 判据里没有任何一次真实 sleep。
   - **lease 驱动的状态推导**（本条的核心，判据 (1)(2) 的名义命题）：有 `turn` lease ⇒ `busy`（优先于其他一切）；无 `turn` 但有 `background-task`/`monitor`/`cron` ⇒ `lingering`；无任何 lease 且 `closeWhenLeasesEmpty` ⇒ 关闭；resident 因 `resident-policy` 是永久 lease ⇒ 停 `idle`。lease 增减经 drive sink 的 `leaseAdded`/`leaseRemoved`，状态每次按 `leases` **重算**（不得写成「turn 开=busy / turn 关=closed」的开关式推导 —— 那正是本条判据的假形态）。
   - **静默上限**：无 `turn` 且处于 `lingering`(per-run)/`idle`(resident) 时，按策略 `quietCeilingMs` 经调度器排一次关闭；deadline 的起点是 `lastActivityAt`，任何**真实活动**（turn 开始/结束、流消息、用户发送）重置它（重排调度）。存在未过期 `cron` lease 时到点不关，按 `expiresAt` **重新计时**（proposal `:329`：周期任务 7 天过期，`expiresAt` 过后重新计时再关）。
   - **`lastActivityAt` 只由活动推进**：manager 提供客户端路径的显式入口（`attachViewer(appSessionId)`，代表浏览器 attach / `chat.subscribe`），它**不得**触碰 `lastActivityAt`（proposal `:323` 逐字：浏览器打开或停留在该会话不算活动）；同一族的 `noteActivity(appSessionId)` 是真实活动的推进路径。两条一起构成 (3) 的正负控制。
   - **`exited`**：sink 的 `exited({ hostId, detail })` ⇒ 立即关闭，`closeReason = 'exited'`、`closeDetail = detail`（`detail === 'oom'` 即判据 (4)）。
   - **`shutdown({ timeoutMs })`**：对全部宿主调用 driver 的 `closeHost(host, 'server-shutdown')`（默认包装走 `runtime.abort`）并 `await` 全部结算；`timeoutMs` 经**同一个**调度器计时，超时仍未结算的宿主被强制关闭（`closeDetail = 'forced'`）并记录；返回摘要（如 `{ closed: hostId[]; forced: hostId[] }`）；`shutdown()` 只在全部宿主都进入 `closed` 之后才 resolve。
   - **其余枚举值的产生入口**：`superseded`（`supersedeOnNewTurn` 且同一 `appSessionId` 上开新一轮 ⇒ 先以 `superseded` 关旧宿主）、`aborted`（`interrupt`）、`user`（`closeHost(hostId, 'user')`）、`mode-change`（策略/模式切换入口）、`rewind`（edit-send 重建入口）。本条只要求这些入口存在且把 `closeReason` 记对；它们的真实产品路径属 AC-158/AC-159。
3. **停机接线**（`server/index.ts`）：在 `shutdownRuntimeServices`（`:389`）里加一个 `try/catch` 项，`await sessionHostManager.shutdown({ timeoutMs: <具名常量> })`，位置与其余逐项清理同段落、在 `process.exit(0)` 之前。**如实登记**：本条不产生「真实信号下停机」的 e2e 读数（判据是直接驱动 manager），这条接线只以静态读数 + typecheck 覆盖。
4. **判据测例** `server/modules/session-hosts/tests/session-host-lifecycle.test.ts`：伪造 driver + 假调度器 + 注入钟，逐条见下。

**判据测例怎么搭**（每个子例各起一份 manager + 一份假 driver，确定性；无真实 sleep）

- **共享脚手架**：假 driver 实现 AC-154 的 driver 接口（`closeHost` 可被测试控制为「立即结算」或「永不结算」）；假调度器记录 `{at, run, cancel}` 并在 `advance(ms)` 时把 `now` 推到位、按 `at` 升序触发到期回调；`now` 是一个测试持有的可变值。
- **(1) per-run**：`addLease({kind:'turn', runId})` ⇒ `state=busy`；`removeLease` 且无其他 lease ⇒ `closed` 且 `closeReason=turn-complete`；`turn` 解除时仍有 `{kind:'background-task'}` ⇒ `state=lingering`，理由清空后 ⇒ `closed(released)`；静默推进到 `quietCeilingMs` ⇒ `closed(released)`（打印 `quiet-closed-at=<ms>` 证明关闭发生在 deadline 那一刻）。四行读数都打印。
- **(2) resident**：无其他 lease ⇒ `state=idle` 且 leases 含 `resident-policy`（打印 leases）；推进到 idle deadline 之前（`deadline - 1`）宿主仍在、仍 `idle`（**正控制**：「不关」不是恒真）；推进到 deadline ⇒ `closed(idle)`；另起一例带未过期 `cron`：到 idle deadline 不关（打印），推进过 `cron.expiresAt` 后重新计时（打印新 deadline 起点 `= expiresAt`），再达 `quietCeilingMs` ⇒ `closed(idle)`。
- **(3) attach / subscribe 不刷新**：绑定建立后记 `lastActivityAt`，反复调 `attachViewer`（等价 attach/subscribe）若干次 ⇒ `lastActivityAt` 逐字不变（打印 `before=/after=`，两次调用次数），且 resident 宿主仍按**原** deadline 关闭（打印 `idle-closed-at=`）。**正控制**：同一绑定上真实活动（turn 开始/结束或流消息经 `noteActivity`）会把 `lastActivityAt` 推后（打印两个不同的值）——保证「不变」那条不是恒真。
- **(4) exited / oom**：sink 上报 `exited({detail:'oom'})` ⇒ `closeReason=exited`、`closeDetail=oom`（两行读数都打印）；并列一条 `interrupt` 读 `aborted`，断言两条的 `closeReason` 不同 —— 保证 `exited` 不是 `aborted` 的别名。
- **(5) shutdown()**：两个宿主，其一 `closeHost` 立即结算、其二永不结算；`shutdown({timeoutMs})` 返回后断言：两者 `state=closed` 且 `closeReason=server-shutdown`；超时那条 `closeDetail=forced` 且出现在返回摘要的 `forced` 里；未超时那条**不在** `forced` 里（**正控制**：强制关闭不是恒真）；`shutdown()` 的 resolve 不早于两者都 `closed`（打印 `closed=[…] forced=[…]`）。
- **枚举穷举**：读共享导出的 `HOST_CLOSE_REASONS`，断言「被产生的值集合 ⊇ 全集」且每个值有具名用例（打印 `reasons-covered=10/10` 与逐值 `reason=<v> case=<name>`）。
- **假形态（判据分辨力证明，必须实测）**：把状态推导换成「只由 turn 的开关推导」（turn 一解除就关闭、忽略其他 lease）⇒ 判据命令退出 **1**，红文案点名 `lingering` 那条与 `cron` 那条。只改实现、判据文件一字不动；实测完 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。

**非目标**：默认包装与四个 provider 的真实分派入口登记（AC-154）、逐帧不变（AC-155）、`GET /api/session-hosts` 与关闭后保留窗口（AC-156）、1:N 解绑与单写者不变量（AC-158）、真实 Claude driver 的顶替与持有（AC-159）、调试 agent 的 `hostDriver` 与场景 op（AC-160）、能力矩阵 `lifecycleModes`/`multiplexedHost`、`process-containment.service.ts`、数据库 `lifecycle_mode` 列、`chat-run-registry`/`scheduled-message-dispatcher` 的 run-source 字段、前端。**不改 `server/modules/providers/list/**`（四个 runtime 一字节不动）、不改 `server/modules/websocket/**`**。

## Plan

1. 读 AC-154 的落地提交：manager 的实际形状（工厂名、`snapshot()`、driver sink 的事件与形状、策略字段是否已存在）、共享类型里 `HostLease`/`HostCloseReason` 的实际取值、`exited` 事件是否带 `detail`。按实际形状改第 1/2 条，**不重复造**已有的字段。
2. 落共享契约：`LifecyclePolicy`、`HostCloseDetail`、`HOST_CLOSE_REASONS`（必要时 `IProviderHostDriver` 的 `exited.detail`）；`npm run typecheck` 绿。
3. manager：注入 `now`/`scheduler`/两套策略；lease 驱动的状态重算；静默 deadline（随活动重置、cron `expiresAt` 重计时）；`attachViewer`/`noteActivity`；`exited(detail)`；`shutdown({timeoutMs})` 与强制关闭记录；其余枚举入口。
4. 写判据测例（上面每个子例 + 枚举穷举 + (3)(5) 的正控制），假 driver + 假调度器，读数逐行打印。
5. 实测假形态（turn-only 推导），抄退出码与红态文案，`git checkout --` 还原。
6. 在 `server/index.ts:389` 的 `shutdownRuntimeServices` 里接线。
7. `npm run typecheck`、`npm run lint`、AC-154 的 `session-host-default-wrap.test.ts` 全绿；写完成记录（含每条读数与假形态实测）。

## AC

- [x] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`。红态基线已测：同命令当前退出 1、文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-lifecycle.test.ts'`。
- [x] AC2 判据是伪造 driver + 注入钟：判据文件里没有真实等待（`grep -c "setTimeout\|await sleep\|node:timers" <判据文件>` → 0，打印该读数），钟与调度器都由测试持有并注入；打印判据命令的整体墙钟 `elapsed=<n>ms` 且 `< 60_000`（24 小时的 idle 超时若没被注入钟接管就不可能跑完，故这条同时是「钟真的注入了」的证据）。
- [x] AC3 (1) per-run 四条读数都打印：turn 出现 ⇒ `state=busy`；turn 解除且无其他理由 ⇒ `closed` 且 `closeReason=turn-complete`；turn 解除时仍有 `background-task` ⇒ `state=lingering` → 理由清空 ⇒ `closed(released)`；静默达 `quietCeilingMs` ⇒ `closed(released)`，打印 `quiet-closed-at=<ms>` 落在 deadline 那一刻。
- [x] AC4 (2) resident 四条读数都打印：无其他理由 ⇒ `state=idle` 且 leases 含 `resident-policy`；推进到 idle deadline 前一刻不关（**正控制**，打印 pending 读数）；到达 deadline ⇒ `closed(idle)`；带未过期 `cron` 时到点不关、`expiresAt` 过后重新计时、再达 `quietCeilingMs` ⇒ `closed(idle)`（打印 cron 例的两个 deadline 读数）。
- [x] AC5 (3) attach/subscribe 不刷新 `lastActivityAt`：反复 `attachViewer` 后 `lastActivityAt` 逐字不变，且 resident 宿主仍按原 deadline 关闭（打印 `before=/after=/attach-count=/idle-closed-at=`）。**正控制**：真实活动（turn 边界或流消息经 `noteActivity`）把 `lastActivityAt` 推后（打印两个不同的值）——「不变」那条不得是恒真。
- [x] AC6 (4) exited/oom：sink 上报 `exited({detail:'oom'})` ⇒ `closeReason=exited`、`closeDetail=oom`（两行读数打印）；并列的 `interrupt` 那条读 `aborted`，两条 `closeReason` 不同（保证 `exited` 不是 `aborted` 的别名）。
- [x] AC7 (5) shutdown()：两个宿主（一个立即结算、一个永不结算），`shutdown({timeoutMs})` 返回后两者 `state=closed` 且 `closeReason=server-shutdown`；超时那条 `closeDetail=forced` 且在返回摘要的 `forced` 里，未超时那条**不在** forced 里（正控制）；`shutdown()` 的 resolve 不早于两者都 `closed`。打印 `closed=[…] forced=[…]`。
- [x] AC8 枚举十值穷举：读共享导出的 `HOST_CLOSE_REASONS`，断言被产生的值集合 ⊇ 全集，且每个值有具名用例；打印 `reasons-covered=10/10` 与逐值 `reason=<v> case=<name>`（十个值：`turn-complete`、`released`、`superseded`、`aborted`、`user`、`idle`、`mode-change`、`rewind`、`exited`、`server-shutdown`）。
- [x] AC9 假形态承重：把状态推导换成「只由 turn 的开关推导」（忽略其他 lease）⇒ 判据退出 **1**，红文案点名 `lingering` 那条与 `cron` 那条。实测退出码与红态文案抄进完成记录，用后还原。
- [x] AC10 契约面不被改窄 + 生产面零改动：`npm run typecheck`、`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-default-wrap.test.ts`（AC-154 的判据文件）仍退出 0；`git diff --name-only` 里没有 `server/modules/providers/list/**`、没有 `server/modules/websocket/**`。
- [x] AC11 停机接线为静态读数：`grep -n "sessionHostManager" server/index.ts` 有输出，且行号落在 `shutdownRuntimeServices`（`:389` 起）体内（打印该行号）。**如实登记**：本条不覆盖真实信号下的停机 e2e 读数。
- [x] AC12 后端规范：`ls server/modules/session-hosts/{types,interfaces,utils}.ts` 全不存在；跨模块只经 `server/modules/session-hosts/index.ts` 桶；`LifecyclePolicy`/`HostCloseDetail`/`HOST_CLOSE_REASONS` 落在 `server/shared/types.ts` 且带说明与消费方注释；新增文件都是 TypeScript。
- [x] AC13 如实登记：完成记录写明（a）调度器接缝的实际形状（哪个文件、哪个字段、判据怎么注入）、`RESIDENT_IDLE_TIMEOUT` 与 per-run `quietCeilingMs` 的实际取值与具名导出位置；（b）AC-154 落地后 manager/共享契约的实际形状、本条改了什么（含 `server/shared/interfaces.ts` 是否改动）；（c）假形态的实测退出码与红态文案；（d）枚举十值的逐值用例名；（e）未实现：AC-155…AC-160、真实信号停机的 e2e、前端。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts`）重跑：退出码 0 且 `fail 0`。AC3 的四条 per-run 读数、AC4 的四条 resident 读数（含两条正控制）、AC5 的不变读数与活动正控制、AC6 的 `exited`/`oom` 与并列的 `aborted`、AC7 的 `closed/forced` 摘要与 resolve 次序、AC8 的 `reasons-covered=10/10` 与逐值用例名，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0（含 AC-154 的判据文件仍绿）。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；四个 runtime 与 `server/modules/websocket/**` 不在其中）。完成后 AC-157 在驱动器下一轮经 `goal_ac: AC-157` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC9「turn-only 推导」的变体必红（`lingering` 与 `cron` 两条），AC5 的活动正控制保证「attach 不刷新」那条不是恒真。

## Touches

- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/index.ts
- server/modules/session-hosts/tests/session-host-lifecycle.test.ts (new)
- server/shared/types.ts
- server/shared/interfaces.ts
- server/index.ts
- tasks/gap-session-hosts-lease-driven-lifecycle.md

## 完成记录

落地提交：`b071ac94 feat(session-hosts): drive host lifecycle from leases, with two policies`（分支 `task/gap-session-hosts-lease-driven-lifecycle`，基于 develop `7db1d5b6`）。

### (a) 调度器接缝与两个上限的实际形状

- 接缝：`HostScheduler = { schedule(at: number, run: () => void): () => void }`，具名导出在 `server/modules/session-hosts/session-host-manager.service.ts`，经 `createSessionHostManager({ now, scheduler, perRunPolicy, residentPolicy })` 注入；**按绝对 epoch 调度**（`at` 是时刻不是延时），返回取消函数。判据注入 `createFakeClock()`：`now()` 读测试持有的可变值，`schedule()` 把 `{at, run}` 入队，`advance(ms)` 推进 `now` 并按 `at` 升序触发到期回调（先扣账再跑，避免回调里重排导致无限循环）。
- `PER_RUN_QUIET_CEILING_MS = 30 * 60 * 1000`、`RESIDENT_IDLE_TIMEOUT = 24 * 60 * 60 * 1000`：同文件具名导出，且经 `server/modules/session-hosts/index.ts` 桶再导出（判据从同一个值说 deadline，不复述数字）。`DEFAULT_PER_RUN_POLICY = { supersedeOnNewTurn: true, closeWhenLeasesEmpty: true, quietCeilingMs: PER_RUN_QUIET_CEILING_MS }`、`DEFAULT_RESIDENT_POLICY = { supersedeOnNewTurn: false, closeWhenLeasesEmpty: false, quietCeilingMs: RESIDENT_IDLE_TIMEOUT }`。
- 判据文件里**没有真实等待**：`grep -c "setTimeout\|await sleep\|node:timers" <判据文件>` → `0`（判据自己打印 `real-wait-primitives=0`，模式用 `['set','Timeout'].join('')` 等碎片拼出，故文件不匹配自己的 grep）；整体墙钟 `elapsed=11ms`。

### (b) AC-154 落地后的实际形状 + 本条改了什么

AC-154 已落地的 manager：`createSessionHostManager({ now, createHostId, createRunId })`，一张宿主表，读口 `snapshot()`，per-run 旧路径 `trackPerRunTurn` / `endTurn` / `settleTurn` / `requestAbort`，共享契约里已有 `HostCloseReason` / `HostLease` / `HostState` / `ProcessHost` / `SessionBinding`。

本条按实际形状**扩展**而非另起一份：

1. `server/shared/types.ts`：新增 `HOST_CLOSE_REASONS`（十值的运行时数组，`as const satisfies readonly HostCloseReason[]`）、`HostCloseDetail = 'oom' | 'signal' | 'error' | 'forced'`、`LifecyclePolicy`；`ProcessHost` 加三个可选字段 `closeDetail?` / `quietDeadlineAt?` / `quietWindowStartAt?`（未改动 AC-154 已有字段；AC-154 判据不做出现在这段字段集上的断言，改动后仍绿）。
2. `server/shared/interfaces.ts`：**本条改动了此文件** —— 新增 `IProviderHostDriverSink`（`leaseAdded` / `leaseRemoved` / `activity` / `exited`），并把 `IProviderHostDriver.startHost` 的签名改为 `startHost(host: ProcessHost, sink: IProviderHostDriverSink)`。AC-154 落地时 `startHost` 不带 sink、`IProviderHostDriverSink` 不存在，故 `exited.detail` 这个可选字段无处可加，本条直接落了 sink 的 `exited({ hostId, detail: Exclude<HostCloseDetail, 'forced'> })`。
3. `session-host-manager.service.ts`：注入 `scheduler` + 两套策略；`deriveState` 每次从 `binding.leases` **重算**（有 `turn` ⇒ `busy` 优先；无 `turn` 但有别的 lease ⇒ `lingering`；只剩 `resident-policy` ⇒ resident 停 `idle`；一次 lease 都没持有过的 `starting` ⇒ 起静默钟；空 lease 且 `closeWhenLeasesEmpty` ⇒ 关）；静默 deadline 以 `lastActivityAt` 为起点、任何活动重排、遇未过期 `cron` 到点不关而按 `expiresAt` 重新计时；`attachViewer` 不碰 `lastActivityAt`、`noteActivity` 碰；`reportExited(hostId, detail)` 先摘掉 driver 再关（死进程不能被要求去死）；`shutdown({timeoutMs})` 用同一个调度器计时，超时未结算者 `closeDetail='forced'` 并进摘要 `forced`，在全部目标 `closed` 之后才 resolve。
4. `server/modules/session-hosts/index.ts`：桶补上新导出（两套策略、两个上限、`HOST_CLOSE_REASONS`、读口类型、`HostScheduler` / `ShutdownSummary` / `OpenHostInput`）。
5. `server/modules/session-hosts/tests/session-host-lifecycle.test.ts`（新，670 行）：判据本体。
6. `server/index.ts`：停机接线。

### 假形态实测（AC9）

把 `deriveState` 换成「只由 turn 的开关推导、忽略其他 lease」（`releasedKind !== null` 即关，非 turn 的 lease 不再产生 `lingering`），判据文件一字不动：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts
EXIT=1
ℹ pass 3
ℹ fail 3
reasons-covered=9/10            （'released' 不再被产生）
resident-b cron-held state=idle leases=resident-policy+cron ...（期望 lingering）
✖ AC3: a per-run host is derived from its leases, and the last reason released names the close
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'closed'
  - 'lingering'
      at .../session-host-lifecycle.test.ts:244:10
✖ AC4: a resident host is held idle by resident-policy and ended by the idle ceiling
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'idle'
  - 'lingering'
      at .../session-host-lifecycle.test.ts:371:10
✖ AC8: every close reason in the shared enum is produced by a named case
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  9 !== 10
      at .../session-host-lifecycle.test.ts:637:10
```

红文案逐字点名 `lingering` 两条（AC3 的 lingering 例在 `:244`、AC4 的 cron 例在 `:371`，两处 `expected: 'lingering'`），AC8 的 `9 !== 10` 是同一原因的下游。实测后 `git checkout -- server/modules/session-hosts/session-host-manager.service.ts` 还原，`git status --short` 空、HEAD 仍是 `b071ac94`。

### (d) 枚举十值逐值用例名

`reasons-covered=10/10`，逐值 `reason=<v> case=<name>`：

- `turn-complete` — AC3 turn released with nothing else holding
- `released` — AC3 quiet ceiling reached while lingering
- `superseded` — AC8 a newer turn superseded the host
- `aborted` — AC6 interrupt stopped the turn
- `user` — AC8 the user closed the host
- `idle` — AC5 idle ceiling reached without real activity
- `mode-change` — AC8 the session changed lifecycle mode
- `rewind` — AC8 an edit rewound the conversation
- `exited` — AC6 driver reported an exit with detail oom
- `server-shutdown` — AC7 shutdown forced host

### 判据读数（AC3–AC8）

```
per-run-a opened state=starting
per-run-a turn-added state=busy leases=turn
per-run-b turn-released state=closed closeReason=turn-complete
per-run-c turn-released-while-held state=lingering leases=background-task
per-run-c held-released state=closed closeReason=released
per-run-d quiet-armed window-start=1700000000000 deadline=1700001800000 (= window-start + 1800000)
per-run-d at-deadline-minus-1 state=lingering pending=1
per-run-d quiet-closed-at=1700001800000 deadline=1700001800000 closeReason=released
resident-a state=idle leases=resident-policy lastActivityAt=1700000000000 quietDeadlineAt=1700086400000
resident-a at-deadline-minus-1 state=idle closeReason=null pending-deadline=1700086400000 pending-timers=1
resident-a idle-closed-at=1700086400000 deadline=1700086400000 closeReason=idle
resident-b cron-held state=lingering leases=resident-policy+cron quietDeadlineAt=1700172800000 cronExpiresAt=1700691200000
resident-b at-idle-deadline at=1700172800000 state=lingering closeReason=null rearmed-window-start=1700691200000 rearmed-deadline=1700777600000
resident-b cron-expired-closed-at=1700777600000 deadline=1700777600000 closeReason=idle
attach before=1700000000000 after=1700000000000 attach-count=3 deadline=1700086400000 deadline-after=1700086400000
attach idle-closed-at=1700086400000 expected-deadline=1700086400000 closeReason=idle
note-activity before=1700086400000 after=1700086520000 deadline=1700172920000
exited state=closed closeReason=exited closeDetail=oom
interrupt stopped=true closeReason=aborted closeDetail=null
shutdown resolved-at=1700000005000 closed=[host-…,host-…] forced=[host-…]
shutdown-a state=closed closeReason=server-shutdown closeDetail=null
shutdown-b state=closed closeReason=server-shutdown closeDetail=forced
shutdown states-at-resolve=[closed,closed]
```

正控制都成立：AC4 的 `at-deadline-minus-1 state=idle closeReason=null pending-timers=1`（「不关」不是恒真）、AC5 的 `before=1700000000000 after=1700000000000` 与 `note-activity before=1700086400000 after=1700086520000`（「不变」不是恒真）、AC7 的 `shutdown-a closeDetail=null` 不在 `forced` 里。

### 其余门读数（AC10 / AC11 / AC12）

- `npm run typecheck` EXIT 0；`npm run lint` EXIT 0，且 `session-hosts|shared/types\.ts|shared/interfaces\.ts|server/index\.ts` 在本条 Touches 上**零命中**（lint 输出的 warning 全在非本条的既有文件里）。
- AC-154 判据 `server/modules/session-hosts/tests/session-host-default-wrap.test.ts` EXIT 0、`pass 6 / fail 0`。
- `git diff --name-only develop...HEAD` = 恰六个 Touches 源码文件，无 `server/modules/providers/list/**`、无 `server/modules/websocket/**`。
- AC12：`ls server/modules/session-hosts/{types,interfaces,utils}.ts` 三者**全不存在**（模块目录只有 `index.ts`、`session-host-manager.service.ts`、`tests/`）；新增文件全部 TypeScript。
- AC11：`grep -n "sessionHostManager" server/index.ts` →
  - `22:import { sessionHostManager } from '@/modules/session-hosts/index.js';`
  - `298:const SESSION_HOST_SHUTDOWN_TIMEOUT_MS = 5_000;`
  - `433:const hosts = await sessionHostManager.shutdown({ timeoutMs: SESSION_HOST_SHUTDOWN_TIMEOUT_MS });`

  `:433` 落在 `shutdownRuntimeServices`（`:409` 起）体内、在 `process.exit(0)`（`:446`）之前；信号挂在 `:448`/`:449`。**与任务书/Proposal 的 `:389`/`:407-408` 有约 44 行漂移**（该文件在立案后又长过），本条如实按实测行号登记，未为了对齐旧行号去搬动 `server/index.ts` 里的位置。

### (e) 未实现 / 非目标

AC-155…AC-160 全部未做（逐帧不变、`GET /api/session-hosts` 与关闭后保留窗口、1:N 解绑与单写者不变量、真实 Claude driver 的顶替与持有、调试 agent 的 `hostDriver` 与场景 op）；不产生「真实 SIGTERM/SIGINT 下停机」的 e2e 读数（AC11 只有静态读数 + typecheck 覆盖，判据是直接驱动 manager）；前端、`server/modules/providers/list/**`、`server/modules/websocket/**`、`process-containment.service.ts`、数据库 `lifecycle_mode` 列一律未改。`superseded` / `user` / `mode-change` / `rewind` / `aborted` 五个入口本条只要求存在并记对 `closeReason`，它们的真实产品路径属 AC-158/AC-159。
