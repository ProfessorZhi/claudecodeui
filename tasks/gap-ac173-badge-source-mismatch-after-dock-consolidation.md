---
id: gap-ac173-badge-source-mismatch-after-dock-consolidation
title: AC-173 判据红：坞合并把徽标与 Running 组的读数源从宿主列表 turn 租约换成会话活动集，调试 agent
  时钟回合点不亮它——waitForBadge 8s 内恒读 0（命令逐字未改，坏的是读数源）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-173
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -l '^goal_ac: *AC-173' tasks/*.md` → 只命中 `tasks/gap-claude-resident-running-view.md` 与 `tasks/gap-resident-running-view-criterion-bounded-boot-guard.md`，两条 `status:` 逐字皆 **done** —— 按规则 done 不是重复，而是「上一次的修法没兜住」的证据。在飞扫描（逐份读 `tasks/*.md` 的 `^status:` 与顶层 `^goal_ac:`，status ∈ todo/ready/needs-human）→ 全库在飞且带顶层 goal_ac 的只有 `gap-ac179-criterion-anchor-retired-by-dock-consolidation.md`（AC-179）与 `gap-activity-dock-human-gate.md`（AC-190），**无一认领 AC-173** ⇒ 无在飞认领者，本条不是重复。机制词扫描 `grep -rln 'resident-running-view\|Running 视图\|running-view' tasks/*.md` 命中的都是邻居（`gap-activity-single-dock-global-consistency` 是坞合并本身、各 `*-criterion-bounded-boot-guard` 是启动守卫收尾），没有一份是「徽标/Running 组读数源在合并后与判据期望不再同源」。

来源与判据物（逐字取自 `goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md`）：`criterion:` = `npx playwright test e2e/resident-running-view.spec.ts`。`expect` 逐字：「调试 agent 场景造出一个运行中的会话与两个空闲常驻会话：侧栏 Running 徽标读数为 1；Running 视图两组各列出对应会话，第二组每行有关闭按钮，点击后该会话宿主关闭、从该组消失。取假形态：徽标计入空闲常驻会话 ⇒ 读数 3，必须红。」该 AC `status: achieved`，其 GOAL-013 已 achieved 且不再活，且未声明 `long-term: true`。

红态基线（本轮**直接重跑判据本身**，读它自己的失败输出，不读台账 reason 的 stderr 尾巴）：命令同上 → **EXIT=1**，失败用例 `resident-running-view.spec.ts:863` 记 `(8.2s)`，失败逐字：

```
Error: the badge to light up for the turn — the badge read 0 ("") throughout
   at waitForBadge (/data/home/yale/work/claudecodeui/e2e/resident-running-view.spec.ts:360:11)
   at /data/home/yale/work/claudecodeui/e2e/resident-running-view.spec.ts:912:19
```

同一轮 stdout 的原始读数：空视图正确（`empty.groups running=0 residentIdle=0`）；两个空闲常驻各自 `start.idle*=200`、`residents.hosts=1 bindings=2`、`residents.hosts.detail=host=host-0533a1ae-… state=idle mode=resident bindings=[50ddc25b:idle:[resident-policy] d20d0677:idle:[resident-policy]]`、`residents.running=0 residentIdle=2`（这一臂全绿）。随后 `fireClock(api, inFlight)` 之后 **`waitForHosts`（spec `:904`，条件 `runningSessions(snapshot).length === 1 && liveHosts(snapshot).length === 2`）已收敛**（否则会在 `:904` 抛它自己那条 `the per-run turn to open its own host beside the resident one`），即**宿主列表读到了 1 个 turn 租约、2 台宿主**；而紧接着 `:912` 的 `waitForBadge(page, r => r.reading > 0)` 在 **8000ms 预算内读数恒 0**（`badge.text=""`）⇒ 同一次运行里，**宿主列表说「在跑」，页面的运行读数源说「没在跑」**。判据没能跑到 `:932` 的承重断言就死在读数源分歧上，一个 AC 保证的读数都没取到。

因果括号（criterionHash 恒定 = 判据文本一字未动，动的是产品）：
- `2026-10-02T08:36:25.511Z` goal-sweep **pass**（AC-173 最后一次绿，`payload.criterionHash: ff3be22083747a57`）
- `2026-10-02T12:28:11.519Z` goal-sweep **fail** + `12:30:57.568Z` goal-cli **fail**（首个红），两次 `criterionHash` 仍是 `ff3be22083747a57`
- `git log -1 -- e2e/resident-running-view.spec.ts` → `e963c867 2026-09-30`（spec 自 9/30 起未动）
- `git log -1 -L 153,153:src/modules/sidebar/hooks/useSidebarController.ts` 与 `git log -1 -L 216,234:src/shared/hooks/useSessionHosts.ts` **都命中 `ad1bb63a`（2026-10-02 15:40:33 +0800）**；该提交进 develop 的首个提交是 `e3f86d82`（2026-10-02 16:29:56 +0800）

⚠️ 括号里有一处**不能假设、必须由本条实测复核**的细节：08:29Z 落地之后 08:36Z 还有一次 pass。因此「ad1bb63a 是唯一因」尚未闭合 —— 有可能是读数源换成 5s 轮询后的**轮询窗口竞态**（见下），须由探针判定，不得直接照抄。

机制（两处 `ad1bb63a` 改的读数源，blame 已钉住）：
- 徽标：`src/modules/sidebar/hooks/useSidebarController.ts:153` 逐字 `const runningSessionsCount = useMemo(() => busySessionIds.size, [busySessionIds]);`，`busySessionIds = useBusySessionIdSet()`（`src/shared/context/SessionProtectionContext.tsx:159`）。
- Running 组：`src/shared/hooks/useSessionHosts.ts:216-221` 的 `classifyRunningSessions(busySessionIds, snapshot)` 逐字 `const running = [...busySessionIds].sort();` ⇒ 第一组同样来自 busy 集。
- busy 集的来源：`SessionProtectionContext` 的 `refreshRunningSessions`（`:84-113`）读 `api.runningSessions()` = `GET /api/providers/sessions/running`，服务端 `sessions.service.ts:240` 逐字 `return chatRunRegistry.listRunningRuns();`，页面上以 **5000ms** 间隔轮询（`SessionProtectionContext.tsx:119-125`）；另有 socket 帧驱动的 `markSessionProcessing` 作为第二入口。
- 反观判据侧的期望读数：`e2e/resident-running-view.spec.ts:249-256` 的 `holdsTurn` / `runningSessions(snapshot)` 仍从 **`GET /api/session-hosts` 的 `turn` 租约**派生「正在运行」。合并前徽标读的就是这份宿主列表（1s 轮询），所以两个读数同源、判据成立；`ad1bb63a` 把徽标/第一组换成 busy 集后，两者**不再同源**。
- 调试 agent 这一侧：`server/modules/debug-agent/debug-agent.host-driver.ts:489` 的 `sinkFor(host).activity(appSessionId)` 经 `session-host-manager.service.ts:784` 的 `activity: noteActivity` **只更新宿主的 `lastActivityAt` 与派生状态**（`:731-740`），不写 `chatRunRegistry`；`POST /api/debug-agent/clock`（spec `fireClock`，`e2e/resident-running-view.spec.ts:722`）驱动的是宿主层的 `unattended-turn` 步（`debug-agent.engine.ts:334` → `openUnattendedTurn` `:613-648`）。因此本轮读数完全自洽：**宿主列表看到 turn 租约（spec `:904` 收敛），页面的 busy 集看不到（`:912` 恒 0）**。

为什么上一次的修法没兜住（两条 done，都不是重复）：`gap-claude-resident-running-view`（2026-09-28，`8357e627`）把徽标从客户端忙集改成读 `useSessionHosts()` 的**宿主列表**并落了判据；`gap-resident-running-view-criterion-bounded-boot-guard`（2026-09-30，`e963c867`）只补了启动守卫。两条都**早于** `ad1bb63a`，而后者又把徽标/第一组的读数源换成了 busy 集 —— 修法被后续合并**覆盖**，不是没落地。

修法方向（探针判定，二选一，不发明新机制）：先量清楚「调试 agent 场景的这个回合为什么点不亮页面的 busy 集」，两个候选：
1. **夹具接缝**：让场景驱动的回合也进入页面读的那份源（`chatRunRegistry` / SessionActivity），例如让 `openUnattendedTurn` 的 run 在共享 run registry 里登记（与真实 provider 运行时同一入口），而不是只走 `noteActivity` 的宿主局部状态。
2. **轮询窗口**（若探针显示 registry 确实短暂登记、只是被 5s 轮询窗口错过）：让判据场景的回合对页面可见（或把运行源做成推送），使读数不再依赖一次轮询恰好落在回合存活期内。
无论选哪支：⛔ 判据命令不变；⛔ AC 的承重断言（spec `:932` `badge.reading === hostsRunning.length`、`:935` `badge.reading === 1`、两组/关闭各条）**一字不改**；⛔ 不加 `retries` / `skip` / 不改 `SINGLE_SPEC_CEILING_MS`；⛔ 不得把「徽标计入空闲常驻 ⇒ 读数 3」的假形态臂删掉（修好后必须重证它仍红）；⛔ 不往生产里补回退役标记，也不把产品退回读宿主列表（`ad1bb63a` 的「一个源」方向是既定意图）。若确需把判据的**期望读数**改锚到产品实际使用的那份源（busy 集），必须在完成记录里如实登记并证明假形态臂仍红、AC 的数值保证（徽标 1、两组 1/2、关闭移出）不变。注意 spec `:924-930` 的注释与 `badge.source=hosts (… stream frames=0)` 这行**取证文字**在合并后已不再是事实，须同步改成如实描述（那行是 print，不是 expect，可改）。

## Plan

1. 复跑确认红形态：`npx playwright test e2e/resident-running-view.spec.ts` 退出 1、失败逐字同 Proposal（工作树须干净）。若已转绿，说明是轮询窗口竞态 ⇒ 直接走候选 2，并在完成记录里登记连续次数与每次读数，不得以「恰好这次绿」收工。
2. 探针（不猜）：在场景回合存活期内直接读 `GET /api/providers/sessions/running`（判据或临时 curl），判定 `chatRunRegistry.listRunningRuns()` 在该回合里到底有没有这个会话。有 ⇒ 是 5s 轮询窗口错过（候选 2）；没有 ⇒ 是夹具接缝没登记（候选 1）。两个读数逐字登记。
3. 按判定实施最小修法（候选 1 或 2）。
4. 前端/夹具读数同源复核：修后同一跑里打印 `hosts.running`、`badge.reading`、`group.running.count`、`group.residentIdle.count`，四者须与 AC 一致（1 / 1 / 1 / 2）。
5. 重证假形态臂：把徽标改回计入空闲常驻 ⇒ 判据退出非 0，且红落在 `:935` 的 `badge.reading === 1`（读数 3）那条断言上；登记变异 diff、逐字失败行、退出码；还原后复绿。
6. 正/负控制不退化：多开一个在飞会话 ⇒ 徽标变大；关掉空闲常驻 ⇒ 徽标不变、`hosts.total` 变小（沿用 spec 既有臂，逐行读数登记）。
7. `npm run lint` / `npm run typecheck` 绿；`npx playwright test --list` 收集总数与改动前逐字相同；`git diff --stat` 与 Touches 对齐；写完成记录（含本轮红是「读数源被合并换掉」还是「轮询窗口」，指名说清）。

## AC

- [x] AC1 判据翻绿：`npx playwright test e2e/resident-running-view.spec.ts` 退出 0，`3 passed`，并打印整体墙钟 `elapsed=<n>ms` < `SINGLE_SPEC_CEILING_MS = 55_000`（命令逐字不改）。红态基线：本轮 EXIT=1、`waitForBadge` 恒读 0（见 Proposal）。
- [x] AC2 根因由探针判定、不靠推断：登记「该回合存活期内 `GET /api/providers/sessions/running` 的原始返回」与「`GET /api/session-hosts` 里该会话的 turn 租约」两条读数，据以指明是候选 1（接缝没登记）还是候选 2（轮询窗口错过）。
- [x] AC3 徽标与两组读数同源且与 AC 一致：同一跑打印 `hosts.running=1 badge.reading=1 group.running.count=1 group.residentIdle.count=2`，且 `badge.reading !== hosts.total`；读数源与产品实际使用的那份源一致（若改锚，完成记录如实登记旧/新锚）。
- [x] AC4 第二组 [关闭] 仍成立：`close.request=200`、`hosts.beforeClose>hosts.afterClose`、`group.residentIdle.count.after` 变小、`badge.reading.after` 不变；正控制：被关会话关闭前在快照里、第一组行数不变。
- [x] AC5 假形态臂仍红（承重）：徽标计入空闲常驻 ⇒ 命令退出非 0，红落在 `badge.reading === 1`（读数 3）上；登记变异 diff、逐字失败行、退出码；还原后回到 0。
- [x] AC6 判定面未变：spec 里 `:932` / `:935` 两条承重断言的文本逐字未改（`git diff` 的 `^-.*expect(` 对这两条为 0），且 `git diff develop -- playwright.config.ts package.json` 为空（无 `SINGLE_SPEC_CEILING_MS`/`RUN_CEILING_MS`/`test:e2e` 改动）。
- [x] AC7 契约面：`npm run lint` 退出 0；`npm run typecheck` 退出 0；`npx playwright test --list` 收集总数与改动前逐字相同（打印前后两个数）；`git diff --stat` 与 Touches 逐条对齐。
- [x] AC8 取证文字如实：spec `:924-930` 的注释与 `badge.source=…` 那行 print 改成与合并后事实一致（不再声称徽标不是由页面自身集合驱动），若与实际不符则登记新读数；⛔ 只改取证文字/print，不动任何 `expect`。

## DoD

- driver 下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-173 台账尾部不再是 CURRENTLY FALSE），且这条绿不是「恰好没抖」—— 连续 ≥5 次全绿、逐次 `elapsed=` 与退出码写进完成记录。
- 判据在真浏览器里跑：真服务、真 `GET /api/session-hosts` 与 `GET /api/providers/sessions/running`、debug-agent 场景驱动，不拉起真 claude。
- 红/绿的承重读数都是判据原始输出行（`badge.reading` / `hosts.running` / `group.*.count` / `close.request` …），不是转述。
- 假形态（徽标计入空闲常驻 ⇒ 读数 3）真跑真红，红落在徽标读数断言上；还原后复绿。
- ⛔ 不得用改判据命令 / 改 AC 承重断言 / `skip` / `retries` / 改上限换绿；⛔ 不删假形态臂；⛔ 不往生产补回退役标记、不把产品退回读宿主列表（一个源的方向是既定意图）。
- 单文件判据在 55s 内自己结束（打印墙钟），不是被看门狗或 60s 闸门外部击杀。
- 只动 Touches 列出的文件；不碰 AC-172/174/175/177/178/179/188 的范围（各自的在飞/已完成任务认领）。

## Touches

- e2e/resident-running-view.spec.ts
- server/modules/debug-agent/debug-agent.host-driver.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/index.ts
- tasks/gap-ac173-badge-source-mismatch-after-dock-consolidation.md（自触）

若探针把修法定到别处（例如需要动 `chatRunRegistry` 的登记入口或前端运行源），按实际写点扩展 Touches 并在任务里说明；Touches 须与实际写点逐条对齐。

### Touches 校准说明（本轮实际写点）

本轮实际只写了两个文件：`e2e/resident-running-view.spec.ts`（仅取证文字/print）与 `server/index.ts`（控制面的 `driveScenario` 接缝）。Proposal 里列的三个 `server/modules/debug-agent/*.ts` **未被改动**：探针把根因定在「控制面派发的 per-run 回合没在 run registry 里登记」（候选 1），而登记入口就在组合根——控制面 `driveScenario` 正是「派发这个回合的传输层」的替身，真实 per-run 聊天回合的 run 也由传输层（`chat-websocket.service.ts` 的 `chatRunRegistry.startRun`）而不是 provider/module 内部打开。故按规则把 `server/index.ts` 加进 Touches，未动的三个文件保留在表内以标明「曾评估、未改」。

## 完成记录

**红态基线（判据原文，工作树干净）**：`npx playwright test e2e/resident-running-view.spec.ts` → EXIT=1，`3 passed` 未达，失败 `resident-running-view.spec.ts:863`（8.1s），逐字 `Error: the badge to light up for the turn — the badge read 0 ("") throughout` at `waitForBadge (…:360:11)` / `…:912:19`。同一跑读数：`residents.running=0 residentIdle=2`、`start.idleA/B=200`，`waitForHosts(:904)` 已收敛后 `:912` 恒 0。

**AC2 探针判定（不猜，两读数逐字）**：在 `waitForHosts` 收敛（`:904`）之后、`waitForBadge`（`:912`）之前，对 `GET /api/providers/sessions/running` 连打 20 次（8s，400ms 间隔），全部逐字 `{"sessions":[]}`（`samples=20 first={"sessions":[]} last={"sessions":[]}`）；同一时刻 `GET /api/session-hosts` 里该会话的 binding 租约逐字 `PROBE.inFlightTurnLease=[{"kind":"turn","runId":"run-adb46b8c-5395-40c1-a1b5-0d5605960742"}]`（`hosts.running=1 hosts.residentIdle=2 hosts.total=2`）。⇒ **候选 1：夹具接缝没登记**（`chatRunRegistry.listRunningRuns()` 在该回合存活期内根本没有这个会话），**不是候选 2 轮询窗口**（20 次采样无一次非空，5s 轮询窗口无从「错过」一个从未出现过的登记）。这也闭合了 Proposal 里 `08:36Z pass` 的疑点：registry 从不登记该回合 ⇒ 那次绿只能是合并尚未在 goal-sweep 的 checkout 生效（`e3f86d82` 08:29:56Z 落地后 goal-sweep 的引用尚未推进），而非「恰好没抖」；`ad1bb63a` 把徽标换成 busy 集即为其唯一因。

**根因**：`ad1bb63a`（activity dock 合并）把侧栏 Running 徽标与第一组换成页面那份 server-authoritative 活动源（`GET /api/providers/sessions/running` → `chatRunRegistry.listRunningRuns()`）。而调试 agent 控制面的 `driveScenario` 把 per-run 场景回合直接交给 `providerRuntimeService.run`，**没有像真实 per-run 聊天回合的传输层那样先开一个 run**（`chat-websocket.service.ts` 先 `chatRunRegistry.startRun` 再 `runtime.run(run.writer)`）。于是该回合只作为宿主租约存在：宿主列表读到「在跑」，活动源的每个读者（活动坞、Running 视图、徽标）读到「没在跑」。

**修法（候选 1，最小；未发明新机制）**：`server/index.ts` 的 `driveScenario` 在派发前，当会话存储模式为 `per-run` 时经 `chatRunRegistry.openUnattendedRun(...)` 开一个 run——与宿主层 `setDebugAgentOpenRun` 用的是同一条 opener；并把时钟自身的 writer 与 run 的 writer 用一个新的 `teeWriter` 并接（时钟的答案仍报它这一走收到的帧 `frames.length`，而 run 的终帧 `complete` 经 run writer 结束该 run）。`resident` 会话不动：其 run 由走内的 `unattended-turn` 步经宿主层 opener 自行打开，此处预开会把那一步的 run 抢走。前端/产品代码一字未改（「一个源」方向保持）。

**AC1（连续 ≥5 次全绿，逐次退出码与 `elapsed`）**：判据命令逐字 `npx playwright test e2e/resident-running-view.spec.ts`。
- run1 `exit=0 3 passed elapsed=41577ms`
- run2 `exit=0 3 passed elapsed=35634ms`
- run3 `exit=0 3 passed elapsed=35726ms`
- run4 `exit=0 3 passed elapsed=35306ms`
- run5 `exit=0 3 passed elapsed=35634ms`
全部 `< SINGLE_SPEC_CEILING_MS = 55_000`，单文件判据自行结束（非看门狗/60s 闸门击杀）。

**AC3（同源读数，同一跑）**：`hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1`；`badge.text="1" badge.label="1 running sessions"`；`group.running.count=1 group.residentIdle.count=2`；`badge.source=runningSessions poll (socket frames seen=13, of them stream frames=0)`；`1 !== 2`（`badge.reading !== hosts.total`）。**锚未改**：判据期望读数仍来自 `GET /api/session-hosts` 的 turn 租约（`hostsRunning`），产品的读数源仍是 busy 集（`SessionActivity`）——本条未改锚，两项在修后同源一致，故登记为「锚不变，源由夹具接缝补齐」。

**AC4（关闭臂，同一跑）**：`close.request=200`；`hosts.beforeClose=2 hosts.afterClose=1`（−1）；`group.residentIdle.count.after=0`（< 2）；`group.running.count.after=1`（不变）；`badge.reading.after=1`（= `badge.reading.before=1`）；`hosts.listing.after` 里被关会话 `f2e024a5` 的 binding 读 `idle:[]`（宿主 `closed`）、第一组所在 per-run 宿主仍 `state=busy … [1c06f33b:busy:[turn]]`（正控制：被关会话关闭前在 `beforeCloseHosts` 快照内、第一组行数不变）；第二组行尾 hint 回落 `running.noMatchingSessions`。

**AC5（假形态真跑真红，承重）**：临时变异 `src/modules/sidebar/hooks/useSidebarController.ts`——徽标改为「live 宿主持有的所有 binding 数」（即计入空闲常驻）：新增 `import { useSessionHosts } …`，并把 `const runningSessionsCount = useMemo(() => busySessionIds.size, …)` 换成 `useMemo(() => (fakeHostSnapshot?.hosts ?? []).filter(h => h.state !== 'closed').flatMap(h => h.bindings).length, [fakeHostSnapshot])`。判据（`-g "the badge and the two groups follow"`）→ **EXIT=1**，读数 `hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=3`，失败逐字：
```
Error: the badge counts the sessions with a turn in flight
expect(received).toBe(expected) // Object.is equality
Received: 3
   942 |     expect(badge.reading, 'the badge counts the sessions with a turn in flight').toBe(hostsRunning.length);
```
（行号 942 为加了取证文字后的漂移，文本即原 `:932` 那条）——读数 3，红落在徽标读数承重断言上。**已用 `git checkout --` 还原**，还原后连跑 5 次全绿（见 AC1）。

**AC6（判定面未变）**：`git diff -U0 -- e2e/resident-running-view.spec.ts | grep -E "^[-+].*expect\("` → 空（两条承重断言文本逐字未改，仅行号随取证文字漂移）；`git diff develop -- playwright.config.ts package.json` → 空。

**AC7（契约面）**：`npm run lint` EXIT=0（仅既有 warning）；`npm run typecheck` EXIT=0；`npx playwright test --list` → 改动后 `Total: 91 tests in 23 files`，stash 掉本轮改动后 → `Total: 91 tests in 23 files`（前后逐字相同）；`git diff --stat` = `e2e/resident-running-view.spec.ts` + `server/index.ts`，与 Touches（本条实际写点）逐条对齐。

**AC8（取证文字如实）**：spec 原 `badge.source=hosts (…)` 那行改为 `badge.source=runningSessions poll (socket frames seen=…, of them stream frames=…)`，并重写其上方注释，如实说明修后徽标读的是页面自身那份活动集（由 `GET /api/providers/sessions/running` 轮询驱动），不再是宿主列表；`waitForBadge` 的 doc 注释同步从「宿主列表 1s 轮询」改为「running-session 集 5s 轮询」。仅改注释/print，未动任何 `expect`。

**回归旁证（非本判据）**：`e2e/resident-ui-layout.spec.ts`（唯一另一个对 per-run 会话走时钟的 spec）→ `3 passed` EXIT=0；`e2e/resident-status-bar.spec.ts`（resident 臂共享控制面）→ `4 passed` EXIT=0。resident 臂因生命周期门被原样旁路（`writer` 不变），行为逐字不变。

**最终交付面**：`server/index.ts`（控制面 per-run 派发开 run + `teeWriter`）、`e2e/resident-running-view.spec.ts`（取证文字）。⛔ 未改判据命令 / 未改承重 `expect` / 未加 `retries`/`skip` / 未改上限 / 未删假形态臂 / 未把产品退回读宿主列表。
