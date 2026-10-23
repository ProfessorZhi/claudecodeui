---
id: gap-ac172-reload-landing-races-absolute-walk-plateau
title: AC-172 判据重连后的 busy 读数与绝对偏移走查的 6s 平台竞争：reload 落点由宿主网络决定，慢一次就错过
  `turn-end@13000`（读数走 `idle`→`exited`）；上一个有界守卫（done）只兜住了 reload 失败、没兜住它的落点
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-172
---
## Proposal

来源：本轮 gap-filing 的**直接测量**。AC-172 已离开 reverify 范围（GOAL-013 已 achieved、不再活）且未声明 `long-term: true`，台账尾部记为 CURRENTLY FALSE。判据命令不变：`npx playwright test e2e/resident-status-bar.spec.ts`。门限不变：goal gate 硬 60s；`playwright.config.ts` 的 spec 上限 `SINGLE_SPEC_CEILING_MS = 55_000`（spec 自身 `elapsed < 55_000` 钉此数）。

**本轮的直接量（不是台账尾巴）**

- driver 在 `2026-10-07T07:21:53.615Z` 记 fail（gate event），tree `3ee7c793…` == 本仓 `HEAD^{tree}`（branch `author`）。
- 该失败轮数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-Jc8pvk`；`test-results/resident-status-bar-reside-d8f2a-stopping-leaves-the-process/error-context.md` 逐字：`Error: expect(locator).toHaveAttribute(expected) failed` / `Locator: locator('a[href="/session/59680f17-…"]').first().locator('[data-resident-mark]')` / `Expected: "busy"` / `Received: "exited"` / `Timeout: 15000ms`，call log 逐行先是 `5 × locator resolved to <span … data-resident-state="idle" …>` 再是 `29 × … data-resident-state="exited" data-resident-exit-detail="oom"` ⇒ 红落点 `e2e/resident-status-bar.spec.ts:978`（test 2 重连后的 busy 读数）。
- 同目录 `watchdog-state.json`：`{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}` ⇒ 该轮**不是**看门狗杀，是 spec 自己的断言红。
- 同窗口本地复跑：7 次绿（33.5–38.4s，test 2 16.3–17.4s）+ 1 次看门狗红（55004ms）；8 路并发绿（34.6–43.0s），其中一路重连到 **9847ms（第 2 次尝试）** 才落地。
- 台账近 120 条本 AC 事件 13 条 fail（≈11%）。

**机制**：ARM_B 的整条四态走查是**一个绝对偏移时钟**（`debug-agent.engine.ts` 的走查循环：`due = startedAt + step.at`，`at` 以 run 起点为绝对毫秒）。跨会话 turn 的平台宽 6s：`unattended-turn(cross-session)@7000` → `turn-end@13000`。test 2 的故意重连（`:976` 的 `navigateBounded(page, paneLanding, 'replay')`）之后必须在**这个平台内**读到 `busy`；但 `navigateBounded` 的 `STARTUP_PROBE_DEADLINE_MS = 14_000` 允许一次重放花掉 14s，**落点由宿主网络决定**。一旦落地晚于 `turn-end@13000`，标记先 `idle`（turn 已结束）再 `exited`（`exit@14000`），于是永远读不到 `busy`——这正是上面 call log 的 `5×idle` + `29×exited`。判据的窗口宽度（6s）**小于**它自己那条守卫允许的漂移（14s），这个竞争是结构性的。

<!-- dedup-ref -->
**为什么上一次的修法没兜住**：`gap-ac172-criterion-reload-unbounded-net-churn`（`goal_ac: AC-172`，done，commit `e4703a6c`）把 test 2 的两处故意 reload 从裸 `await page.reload()` 改走 `navigateBounded(page, paneLanding, 'replay')`。它兜住的是 **reload 失败**（宿主 netlink / docker-veth 抖动掐断在途模块加载 → 页面没 mount → 紧邻的 pane `toBeVisible` 30s 超时）；它没有、也没打算改变 reload 的**落点**——守卫的 deadline 比它必须落进的平台还大（14_000 > 6_000）。所以同一台绝对时钟上的下一次竞争只是换了个红落点：从 pane 的 `toBeVisible` 挪到了紧邻的 mark `busy` 读数。同族的 `gap-ac188-criterion-body-budget-below-its-turn-walk-floor`（done）也属这个家族，但那条修的是用例体预算、不涉走查平台。

**修法（用既有机制把平台改由判据自己的进度释放，不新增算子）**：引擎**已经**有 `await-release` 步与 `POST /api/debug-agent/release`（`debug-agent.scenario.ts` 的 `DEBUG_AGENT_OPS` 收入 `await-release`；`debug-agent.engine.ts` 的 `awaitDebugAgentRelease` / `releaseDebugAgentRun`，`DEBUG_AGENT_RELEASE_CEILING_MS = 20_000`；`debug-agent.routes.ts` 的 `RELEASE_PATH`）——它存在的理由逐字就是「屏障之后的步在我自己的读数窗关闭后才发火，而不是一个固定偏移」。把 ARM_B 的跨会话 turn 用一道屏障持有到判据读完：

steps 改为

```
{ at: 7_000, op: 'unattended-turn', text: CROSS_SESSION_TURN_TEXT, trigger: 'cross-session', sender: PEER_NAME },
{ at: 8_000, op: 'await-release' },
{ at: 13_000, op: 'turn-end' },
{ at: 14_000, op: 'exit', detail: 'oom' },
{ at: 14_500, op: 'wait' },
```

走查循环是**顺序**的：它按 `due = startedAt + at` 睡到 `:8000` 就 park 在屏障上，其后的 `turn-end` 连 `due` 都还没算，因此**在释放的那一刻**才发火（`due` 已过 ⇒ 立即执行）——平台从此没有固定宽度，慢到 14s 的重放也仍在平台内。屏障是**一次性**的（`releaseDebugAgentRun` 把该 run 的 `released` 置真后所有 `await-release` 都直通），所以全场景只放一道，位置就是跨会话 turn 与其 `turn-end` 之间。

spec 侧在主线程上释放，**在 abort 读数之后**：

- `:978` 的重连后 `busy` 读数落地后**先不释放**——若在此释放，`turn-end` 与 `exit@14000` 会抢在 abort 读数之前发火，abort 的 `expect(['idle','lingering']).toContain(hostAfterAbort?.state)`（现 `:1000`–`:1015` 一带）会读到 `exited` 而红；
- 在 abort 读数（`hostAfterAbort.state ∈ {idle, lingering}`、`closeReason === null`、pid/startedAt 不变）**全部通过之后**，`await api.post('/api/debug-agent/release', { data: { sessionId: armB } })` 并断言响应 `ok`（释放失败不许静默——否则屏障 20s 后以 `DEBUG_AGENT_RELEASE_TIMEOUT` 红，读数会指向错误的层），随后再读 `exited`。
- abort 在屏障持有时仍成立，因为「停止当前一轮」是宿主层动作（撤回该 turn 的租约），不依赖场景的 `turn-end`；这正是现状的既有行为（现在 abort 也常在 `turn-end@13000` 之前点下，同一条断言为真）。

⛔ 不改四态语义、不弱化任何 `expect`、不改判据命令、不动 `playwright.config.ts` 的 `55_000` / 60s 门限、不回退 `gap-claude-resident-status-bar` 与 `gap-ac172-criterion-reload-unbounded-net-churn` 已落对的断言与守卫。AC-172 的两条假形态 (a)(b) 必须仍然红。

**非目标。** 不改 AC-172 的 `criterion:` / `expect:`；不新增 debug-agent 算子（`await-release` 已在树上）；不把 `navigateBounded` 拿掉或放宽它的守卫。

## Plan

1. **先定性（不改文件）**：`npx playwright test e2e/resident-status-bar.spec.ts` 连跑数次，登记每次 wall 与 spec 自报 `elapsed=`；确认红落点落在 `:978`（或看门狗），并对照本轮 driver 的 `error-context.md` 逐字。
2. **改 ARM_B steps + spec 释放点**（Proposal 里的形状）：加 `await-release`，在 abort 读数后 POST `/release` 并断言 `ok`。
3. **屏障承重对照**：临时**删掉释放 POST**（`await-release` 步保留），判据必须在约 20s 后以 `DEBUG_AGENT_RELEASE_TIMEOUT` 非零退出——证明屏障确在走查里、且平台确实由判据的进度而非固定偏移关闭；`git checkout --` 还原后判据回绿。
4. **负载臂**：还原后连续 ≥5 次 + 并发 ≥4 路一臂，全部 exit 0 且 wall < 55_000、`elapsed=` < 55_000；逐次如实登记宿主 load1。并发/多跑一律按 `docs/operations/process-isolation-and-memory-caps.md` 的「Running tests from a Claude session」限额（勿在会话内跑无界多文件 fan-out）。
5. **两条假形态各自变异—跑—登记—还原**：(i) 状态条改成读本地状态而不读宿主接口；(ii) 无人轮渲染成用户消息样式。每次登记 `echo $?`、失败断言逐字、变异 diff；还原后回绿。
6. **静态闸**：`npm run typecheck` 退出 0；改动文件过 oxlint（`e2e/` 不在 lint 路径内时单独 `npx oxlint e2e/resident-status-bar.spec.ts` 并说明既存错误）。
7. **落账并自检**：`task-schema-check.js` exit 0、`quay task check <id> --json` 的 `missing: []`；只把 Touches 里列出的文件加进提交。
8. **只在必要时动引擎常量**：仅当负载臂上释放到达晚于 `DEBUG_AGENT_RELEASE_CEILING_MS`（20s）而红，才可调 `server/modules/debug-agent/debug-agent.engine.ts` 的该常量（backend-module-standards 适用），并把读数写进完成记录。

## AC

- [x] AC1 平台由判据自己的进度释放（承重）：`grep -n "await-release" e2e/resident-status-bar.spec.ts` 命中 ARM_B 的 `steps`，且该步位于跨会话 `unattended-turn` 与其 `turn-end` 之间；`grep -n "debug-agent/release" e2e/resident-status-bar.spec.ts` 命中释放 POST（同一处断言响应 `ok`）。验证：两条 `grep -n` 逐行输出 + `npm run typecheck` 退出 0。
- [x] AC2 屏障承重对照（承重）：删掉释放 POST（`await-release` 保留）后 `npx playwright test e2e/resident-status-bar.spec.ts` 非零退出、输出含 `DEBUG_AGENT_RELEASE_TIMEOUT`；还原后 exit 0。验证：两次运行的 `echo $?`、wall、失败逐字输出。
- [x] AC3 判定面未变：`git diff develop -- e2e/resident-status-bar.spec.ts | grep -c "^-.*expect("` 为 **0**；`git diff develop -- package.json playwright.config.ts "goals/AC-172-真实浏览器里常驻会话的状态标记-状态条与关闭按钮反映宿主状态-无人轮带触发类型标签.md"` 为**空**；判据命令与 AC 记录的 `criterion:` 逐字一致。验证：三条命令的逐字输出。
- [x] AC4 AC-172 两条假形态仍然红（承重）：(i) 状态条改成读本地状态而不读宿主接口 ⇒ 判据退出非 0，红落在重连后的 busy 断言（`Expected: "busy"`）；(ii) 无人轮渲染成用户消息样式 ⇒ 判据退出非 0，红落在无人轮断言。各自 `git checkout --` 还原后判据回绿。验证：两次变异跑与还原跑的 `echo $?`、失败断言逐字、变异 diff。
- [x] AC5 负载臂连续绿且不出门限：还原后 `npx playwright test e2e/resident-status-bar.spec.ts` 连续 ≥5 次全部 exit 0，另并发 ≥4 路一臂全部 exit 0；逐次 wall < 55_000 且 spec 自报 `elapsed=` < 55_000。验证：逐次 `echo $?` + wall + `elapsed=`，并登记宿主 load1。
- [x] AC6 任务自身 `tasks/gap-ac172-reload-landing-races-absolute-walk-plateau.md` 已落账（自触）。

## DoD

真落地标准：屏障落地后，goal-driver 下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-172 台账尾部不再是 CURRENTLY FALSE），且这条绿在其后**连续多轮**的 round / frozenRecheck 中保持 pass——即重连落点晚于旧 `turn-end@13000` 时不再把它偶发打红。AC1–AC6 的逐字读数（含 AC2 屏障对照读数与还原读数、AC4 两条假形态读数与还原读数、AC5 逐次 wall/`elapsed=`/load）写进完成记录。⛔ 不得用改断言 / skip / `retries` / 改判据命令 / 改门限换绿；四个用例的 `expect` 语义未变由 AC3 机械证明。完成记录必须写明：触发源（宿主网络使 reload 的落点漂移）在仓外、不可控；本仓修的是**走查的时间形状**（固定 6s 平台 → 由判据进度释放的屏障），故这条判据的稳定性**依赖屏障**而非触发源消失；并写明**为什么** `e4703a6c`（有界重放）只兜住 reload 失败、没兜住落点（守卫 deadline 14s > 平台 6s），以及为何释放点必须在 abort 读数之后（否则 `exit@14000` 抢在 abort 读数前，`['idle','lingering']` 会读到 `exited`）。

## Touches

- `e2e/resident-status-bar.spec.ts`
- `server/modules/debug-agent/debug-agent.engine.ts`（**仅当**负载臂上释放到达晚于 `DEBUG_AGENT_RELEASE_CEILING_MS` 才动；backend-module-standards 适用）
- `tasks/gap-ac172-reload-landing-races-absolute-walk-plateau.md`（自触）

## 完成记录

**这一轮修的是判据的时间形状，不是产品。** 产品保证（常驻会话的侧栏四态标记 / 坞展开面板里的地址、pid、起停关闭 / composer 停止只中止一轮 / 无人轮的分隔标签、发送方、非用户样式）未动；判据命令 `npx playwright test e2e/resident-status-bar.spec.ts` 与 AC-172 的 `criterion:` 逐字不变，四个用例的 `expect` 一字未删（AC3 机械证明 `git diff develop -- <spec> | grep -c "^-.*expect("` = 0）。

**触发源在仓外、不可控；稳定性依赖屏障，不依赖触发源消失。** 红是结构性竞争：ARM_B 是一条**绝对偏移时钟**（`due = startedAt + step.at`），跨会话 turn 的平台只有 6s（`unattended-turn@7000` → `turn-end@13000`），而它自己那条有界重放守卫允许一次重放花掉 `STARTUP_PROBE_DEADLINE_MS = 14_000`——**窗口宽度（6s）小于守卫允许的漂移（14s）**。reload 的落点由宿主网络（netlink / docker-veth 抖动）决定，这在仓外。本仓能做的是把平台**改由判据自己的进度释放**：`unattended-turn(cross-session)@7000` 之后加一道 `await-release` 屏障（`{ at: 8_000, op: 'await-release' }`），`turn-end` / `exit` 排在其后。走查循环是**顺序**的，屏障之后两步的 `due` 在释放前根本不算，故 `turn-end` 在释放那一刻（`due` 已过则立即）才发火——平台从此没有固定宽度，重放慢到 14s 也仍在平台内。因此这条判据的稳定性**依赖屏障**，而不是触发源消失。

**为什么 `e4703a6c`（有界重放）只兜住 reload 失败、没兜住落点。** 它把两处裸 `await page.reload()` 改走 `navigateBounded(page, paneLanding, 'replay')`，兜住的是**reload 失败**（宿主抖动掐断在途模块加载 → 页面没 mount → 紧邻 pane 超时）；它没有改变 reload 的**落点**——守卫的 deadline（14_000ms）比它必须落进的平台（6_000ms）还大。下一次竞争只是把红从 pane 的 `toBeVisible` 挪到紧邻的 mark `busy` 读数。

**为什么释放点必须在 abort 读数之后。** 若在 `:984` 的重连后 busy 读数处就释放，`turn-end` 与 `exit@14000` 会抢在 abort 读数之前发火，abort 的 `expect(['idle','lingering']).toContain(hostAfterAbort?.state)` 会读到 `exited` 而红。故释放 POST 排在 abort 读数（`state ∈ {idle, lingering}`、`closeReason === null`、`hostId`/`pid`/`startedAt` 不变）**全部通过之后**；abort 在屏障持有时仍成立，因为「停止当前一轮」是宿主层动作（撤回该 turn 的租约），不依赖场景的 `turn-end`。

**逐条读数（如实登记）。** 宿主 load1 取运行前 `cat /proc/loadavg` 首字段；一律 `bash scripts/with-memory-cap.sh npx playwright test e2e/resident-status-bar.spec.ts`。

- **AC1** `grep -n "await-release" e2e/resident-status-bar.spec.ts` → `142:    { at: 8_000, op: 'await-release' },`（`:141` 是跨会话 `unattended-turn`、`:143` 是其 `turn-end`；`:125` 是注释）。`grep -n "debug-agent/release"` → `1041:    const releaseResponse = await api.post('/api/debug-agent/release', { data: { sessionId: armB } });`，`:1044` 断言 `releaseResponse.ok(...)` 为真。`npm run typecheck` → **EXIT=0**（合并 develop 后复跑仍 0）。
- **AC2** 对照（删掉释放 POST 与 `ok` 断言，保留 `await-release`）：**EXIT=1**，wall=55s，load1=18.16，逐字 `walk.verdict ok=false status=500 body={"success":false,"error":{"code":"DEBUG_AGENT_RELEASE_TIMEOUT","message":"The run for session \"dfe7f1b6-…\" reached an \"await-release\" step and nothing released it within 20000ms. The debug agent control plane's release action is what states it — see POST /api/debug-agent/release."}}`，并由本 run 自己的看门狗收尾（`crossed its own 55000ms ceiling at 55005ms … stuck at stage "browser-launch-or-cases"`）。还原后 **EXIT=0**，load1=13.99，`elapsed=32786ms`，`release.status=200 body=…"released":true,"woken":0`。
- **AC3** `git diff develop -- e2e/resident-status-bar.spec.ts | grep -c "^-.*expect("` = **0**（合并 develop 前后各一次）；`git diff develop -- package.json playwright.config.ts "<goal>"` = **空**（前后各一次）；goal 文件 `criterion: npx playwright test e2e/resident-status-bar.spec.ts` 逐字未变。`npx oxlint e2e/resident-status-bar.spec.ts` → **EXIT=0**。
- **AC4(i)** 变异「状态条读本地镜像而不读宿主接口」（`ResidentMark.tsx` 加 `sessionStorage` 本地镜像：一份 **boot 时已有存档读数** 的文档就固定在那份读数上、不再重读宿主接口；首次启动的文档则持续更新镜像）。**EXIT=1**，红落 `e2e/resident-status-bar.spec.ts:984`（重连后的 busy 断言），逐字 `Error: expect(locator).toHaveAttribute(expected) failed` / `Expected: "busy"` / `Received: "idle"` / `Timeout: 15000ms`，call log `34 × locator resolved to <span role="img" … data-resident-state="idle" …>`；重连前两读仍绿（`state=运行中 mark=solid+spinner snapshot.state=busy`、`state=空闲 mark=solid snapshot.state=idle`）。变异 diff 已登记（`ResidentMark.tsx` +35/-1）。
- **AC4(ii)** 变异「无人轮渲染成用户消息样式」（`MessageComponent.tsx`：`data-message-style={rendersAsUser || isUnattendedTurn ? 'user' : message.type}`）。**EXIT=1**，红落 `e2e/resident-status-bar.spec.ts:1154`（无人轮断言），逐字 `Error: a turn nobody typed must not wear the user's own bubble style` / `expect(received).not.toBe(expected)` / `Expected: not "user"`。变异 diff 已登记（`MessageComponent.tsx` +1/-1）。
- **AC4 还原** `git checkout -- src/` 后（两处变异同一次还原）**EXIT=0**，load1=37.33，`elapsed=32458ms`，`4 passed (32.5s)`。
- **AC5** 连续 5 次（逐次 load1 / EXIT / `elapsed=` / wall）：`19.35 0 32162ms 4 passed (32.2s)`、`15.47 0 32967ms 4 passed (33.0s)`、`13.82 0 33158ms 4 passed (33.1s)`、`14.00 0 32250ms 4 passed (32.3s)`、`13.89 0 32661ms 4 passed (32.7s)`。并发 4 路一臂（load1 before=12.88 / after=16.87；每路各自起服务与数据目录，config 每 run 向内核取一对空闲端口）：`1:0 33307ms 4 passed (33.3s)`、`2:0 33340ms 4 passed (33.4s)`、`3:0 33713ms 4 passed (33.7s)`、`4:0 33384ms 4 passed (33.4s)`。全部 **EXIT=0**，wall 与 `elapsed=` 均 < 55_000。
- **AC6** 本文件（自触），经 Provider ABI `task_write` 落账。

**关于 `woken` 读数（承重机制的诚实登记）**：全部绿 run 的 `POST /release` 都返回 `woken: 0`——即释放到达时该 run **尚未 park 到屏障**（`releaseDebugAgentRun` 先把 `released` 置真，走查走到 `:8000` 时直通）。这正是快 run 的应有形状：判据在 8s 前就读完平台并释放，`turn-end` 仍不早于 8000 发火；慢重放（落点 >8s）时释放必然更晚、落在已 park 的屏障上（woken:1）才唤醒它。屏障的承重性由 AC2 对照机械证明（无释放即 20000ms 后 `DEBUG_AGENT_RELEASE_TIMEOUT` 非零退出）。

**未动引擎常量**（Plan 8 的触发条件未出现：负载臂上释放均在 20s 上限内闭合，`DEBUG_AGENT_RELEASE_CEILING_MS` 未改，`server/modules/debug-agent/debug-agent.engine.ts` 未进本次提交）。
