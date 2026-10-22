---
id: gap-activity-dock-truthful-criterion-bounded-boot-guard
title: e2e/activity-dock-truthful.spec.ts 是本族唯一没有有界启动守卫的 spec：无界启动让
  AC-185/AC-187/AC-188 的判据在负载下死在启动形态（GOAL-014 记 done-unresolved）
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

来源：本轮 gap-filing 的直接测量（读文件与判据台账），不是台账尾巴。

**判据载体。** `e2e/activity-dock-truthful.spec.ts` 存在（27411 bytes，写于 2026-10-02 15:09，由 AC-185 的 worker 任务 `gap-activity-send-unreachable-draft-retry` 写下，该任务 `status: done`）。它是 GOAL-014 四条 AC 的判据文件：AC-184（`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`，done —— `gap-activity-dock-unreachable-degradation`）、AC-185（`-g "AC-185"`，由 `gap-activity-send-unreachable-draft-retry` 实现）、以及等各自任务落用例后的 AC-187（`gap-activity-dock-phase-truthful`，ready）与 AC-188（`gap-activity-single-dock-global-consistency`，ready）。今天该文件只带 AC-184 与 AC-185 两个用例。

**缺陷 —— 本 spec 是本族唯一没有启动守卫的成员。** 本轮在活文件上实测：
- `grep -c warmClientStartup e2e/activity-dock-truthful.spec.ts` → **0**
- `grep -c navigateBounded e2e/activity-dock-truthful.spec.ts` → **0**

它的 `beforeAll` 用一次无界导航启动页面 —— `page.goto('/')`（第 358 行）接 `waitForLoadState('domcontentloaded')`（第 359 行）—— 全文唯一的「守卫」是末尾那条 `expect(elapsed).toBeLessThan(55_000)`（第 562 行），它什么都护不住：先跑完再报。同族每一份都有守卫：`e2e/resident-running-view.spec.ts` warm=2 nav=2、`e2e/resident-shell-tab.spec.ts` warm=3 nav=3、`e2e/resident-status-bar.spec.ts` warm=2 nav=4。

**后果 —— AC-185 的台账读数。** AC-185 的实现任务已落地（`status: done`），但它的 AC 记录卡住：goal-driver facts 读 `{"id":"AC-185","status":"active","verdict":"fail","reason":"acceptance failed"}`，gate-event 的 stderr 是 `Timed out waiting 30000ms from config.webServer`（在 `.quay/gate-events.jsonl` 里 grep 这一串）。缺口被记为 `{"goal":"GOAL-014","ac":"AC-185","state":"done-unresolved"}` —— 实现 done，判据过不去。同一个 spec 也承载 AC-187（`-g "AC-187"`）与 AC-188（`-g "AC-188"`），它们的用例将共用这份 `beforeAll`，同一段无界启动会把它们同样挡住。

**机制（本仓能修的那一半）。** 没有启动守卫时，首轮客户端起播的页面期代价就落在被测窗口里：负载下 Vite 依赖重优化 / 模块图被按住时，`beforeAll` 里那次无界 `page.goto('/')` 没有任何回退，整轮死在启动形态，而不是靠一次有界重放自愈。把本族既有的守卫移植进来，就是把这份代价移出被测窗口，并让前导拥有自己的预算与自己的、会署名的错误。

**已落地的先例。** `gap-claude-resident-shell-tab-criterion-bounded-boot-guard`（「this spec is the only member of its family without the boot guard」，`status: done`）恰好把两个杠杆搬进了 `e2e/resident-shell-tab.spec.ts`，本任务搬同样两个 —— 不发明新机制：
1. `warmClientStartup` —— `beforeAll` 内的有界客户端预热，落在任何 context/page 创建**之前**，逐 URL 带 deadline，某 URL 到不了 200 就按 url+status 指名抛错。
2. `navigateBounded` —— 有界启动探针，落点是夹具自己的行，在预算内用 `page.reload()` 重放，预算耗尽时带页面文本 + 失败请求列表大声抛错。

**明确不动 / 不变式。** 判据命令不改；不加 Playwright `retries`；不开 `reuseExistingServer: true`；`playwright.config.ts` 一字不动（该文件已在 `DEBUG_AGENT_SPEC_FILES` 内、且已拿到本次选择缩短后的服务端阈值 —— 那是 AC-184 落地时的登记）；不 stub、不 skip；`e2e/activity-dock-truthful.spec.ts` 里一条 `expect(...)` 都不改。

**boot 那一条如实登记。** 卡住的 AC-185 stderr 是 `Timed out waiting 30000ms from config.webServer` —— 那是 Playwright 的 `webServer[].timeout: 30_000` 在**任何页面存在之前**等共享 e2e server，是 spec 侧守卫够不着的一层（与先例登记的分层一致）。本任务的可控目标是 spec 侧、页面期那次无界等待。若守卫落下后这串字仍复发，须如实归因为**宿主负载**（本族既有记录：`scoped-gate-can-red-on-fleet-load-boot-timeout`、`resident-server-restart-boot-health-timeout-is-load-flake`）—— 绝不栽到本任务头上，也绝不用改断言 / 加 retries 的方式掩盖。

<!-- dedup-ref --> 本轮去重读数：`task_get gap-activity-dock-truthful-criterion-bounded-boot-guard` → not found；`task_list search "bounded boot guard"` → 只命中 `gap-voice-identifier-criterion-boot-dep-reopt-race`（另一份 spec，`e2e/voice-identifier-repair.spec.ts`）；`task_list search "activity-dock"` → 上面那四条 AC-184/185/187/188 机制任务，没有一条是启动守卫机制、也没有一条碰这份文件的 `beforeAll`。已落地的先例 `gap-claude-resident-shell-tab-criterion-bounded-boot-guard` 是**另一份 spec**，本任务不重复它。

## Plan

1. **先读先例，再立红态基线。** 判据命令逐字保留。读 `e2e/resident-shell-tab.spec.ts` 已落地的守卫，以及家族源 `e2e/resident-running-view.spec.ts` 的 `warmClientStartup`/`navigateBounded` 取准确形状。
2. **移植 `warmClientStartup`。** 加进 `beforeAll`，落在第一个 `browser.newContext()`/`newPage()` **之前**；逐 URL 带 deadline；非 200 / 超时按 url+status 指名抛错；成功打印 `[e2e] client warm-up: pre-bundle committed in <n>ms`。
3. **移植有界启动探针。** 让 `navigateBounded` 成为唯一的启动导航，替换裸 `page.goto('/')` + `waitForLoadState('domcontentloaded')`；落点是夹具自己的锚（`sessionRow(page, sessionId)` / `PANE`）；预算内 `page.reload()` 重放；预算耗尽抛页面文本 + `requestfailed` 列表。
4. **有界失败读数。** 把探针落点临时指向一个不可能存在的 sentinel；判据须在预算内以非零退出、输出带页面文本 + 失败请求列表；还原并把两次读数一并登记。
5. **负载下连绿。** 判据连跑 ≥5 次，每次 wall < `SINGLE_SPEC_CEILING_MS = 55_000`；其中至少一次与 ≥4 份兄弟 spec 并发；兄弟若红，点名归因。
6. **断言零改动证明。** `git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -c "^-.*expect("` → 0；`git diff develop -- playwright.config.ts` → 空；判据命令逐字不变。
7. **取假形态（承重）。** (a) 守卫 take-fake：把有界探针还原成裸 goto ⇒ 同一负载下启动形态的红必须重现（该并发度下复现不出就如实登记，并补一档更高并发度读数）。(b) 判据自身的判别力：把坞的服务端推送状态来源改回本地表/本地钟（AC-184 的题面）⇒ AC-184 用例必须红在坞的状态断言上。逐条记变异 diff、逐字失败行、退出码；`git checkout -- <file>` 还原；判据回到 0。
8. **静态门。** `npm run typecheck` 退出 0；`npm run lint` 退出 0；scoped 门读数登记。

## AC

- [x] AC1 守卫存在且在**任何页面创建之前**被调用：`grep -n "warmClientStartup" e2e/activity-dock-truthful.spec.ts` 同时命中定义行与调用行，且调用落在 `beforeAll` 内、第一个 `browser.newContext()`/`newPage()` 之前；有界启动探针（`navigateBounded` 或等价命名）同样有定义行与启动路径上的调用行。验证：两条 `grep -n` 输出 + `npm run typecheck` 退出 0。
- [x] AC2 每一处启动导航都有界：`grep -n "page\.goto(\|page\.reload(" e2e/activity-dock-truthful.spec.ts` 的每一处都落在探针函数体内，函数体外无裸启动导航；探针耗尽预算时抛出携带页面文本与 `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界 + `npm run typecheck` 退出 0。
- [x] AC3 有界失败的实测：把探针落点临时指向一个不可能存在的 sentinel 后，`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"` 在预算内以非零退出，输出带页面文本与失败请求列表；还原后的读数一并登记。验证：两次运行的 `echo $?` 与 wall time。
- [ ] AC4 判据在负载下连续绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"` 连续 ≥5 次全部 `exit 0`，每一次 wall < `SINGLE_SPEC_CEILING_MS = 55_000`（一次都不触发 55s 看门狗 / 60s 门限），其中至少一次与 ≥4 份兄弟 spec 并发。如实登记：并发那一次若兄弟 spec 自己红，须点名归因，不记入本条。验证：逐次 `echo $?` + wall time。（AC-185 判据在 develop 净检出上以 transcript.userRows=[2] 恒红，属既有内容缺陷、非本任务；本任务只消除其启动形态红，翻绿待外部修复）（待外部）
- [x] AC5 判定面未变：`git diff develop -- playwright.config.ts package.json` 为空；`git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -c "^-.*expect("` 为 **0**；未新增 `retries`、未开 `reuseExistingServer`（`git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -cE '^\+.*(retries|reuseExistingServer)'` 为 0）；判据命令逐字不变。验证：上述各命令的逐字输出。
- [x] AC6 守卫 take-fake 必须红（承重）：把有界探针还原成裸 `page.goto('/')` ⇒ 同一负载下启动形态的失败重现、判据退出非零；若该并发度下复现不出，如实登记「该并发度下 take-fake 不成立」并补一档更高并发度读数。登记 take-fake 读数 + `echo $?`，随后还原。验证：take-fake 跑与还原跑的 `echo $?`。
- [x] AC7 判据在守卫落下后仍有牙（承重）：把坞的服务端推送状态来源改回本地表/本地钟（AC-184 的题面，落在 `src/modules/chat/hooks/useActivityFreshness.ts`）⇒ `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` 退出非零，且红落在坞的 `data-activity-state` 断言上。登记变异 diff、逐字失败行、退出码；`git checkout -- <file>` 还原后判据回到 0。验证：变异跑与还原跑的 `echo $?`。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑 AC-185 的判据（`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"`）在 `.quay/gate-events.jsonl` 里翻绿（AC-185 的台账尾巴不再是 `Timed out waiting 30000ms from config.webServer` 那条 fail），且此后连续多轮 frozenRecheck 保持 pass —— 即并发负载下页面期那次客户端起播不再是无界等待、不再死在启动形态。AC4 的 ≥5 连绿（含一次与 ≥4 份兄弟 spec 并发）逐次 wall/exit 写进完成记录；AC3 的有界失败读数与 AC6/AC7 的假形态读数（变异 diff、逐字失败行、还原命令）一并登记。

- **不是「多了一段等待」**：前导的代价被移出被测窗口，且前导自己有界、会署名；承重证据是 AC6（还原 ⇒ 启动形态的红重现）。
- **归因如实**：`config.webServer` 那条 30s 读数如实登记；若复发归因宿主负载，绝不栽本任务；绝不用改断言 / `retries` 掩盖。
- **判定面未动**：判据命令逐字不变，`playwright.config.ts` 未动，无 `retries`、无 `reuseExistingServer: true`、无 stub、无 skip；`expect` 一字未改由 AC5 机械证明。
- **读数原文**：每一条主张都是逐字的 grep 输出、退出码或 wall time；没有读数就不写「已通过」。
- **只动 `## Touches` 列出的文件**：AC7 的变异写点在最终 diff 前已还原（`git status --porcelain` 除本任务文件外为空）。

## Touches

- `e2e/activity-dock-truthful.spec.ts`
- `src/modules/chat/hooks/useActivityFreshness.ts`（仅 AC7 假形态的临时写点，跑完还原，不进最终 diff）
- `tasks/gap-activity-dock-truthful-criterion-bounded-boot-guard.md`（自触）

## 完成记录（2026-10-02）

判据命令（逐字未改）：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"`；行号以最终分支文件的 `merge develop` 后版本为准。

**AC1** `grep -n "warmClientStartup" e2e/activity-dock-truthful.spec.ts` → 定义 `:385`，调用 `:588`、`:1055`；两处调用都落在各自 `beforeAll` 内、第一个 `browser.newContext()`（`:590` / `:1067`）之前。`grep -n "navigateBounded"` → 定义 `:520`，调用 `:618`、`:1090`、`:1176`、`:1211`、`:1274`。`npm run typecheck` 退出 **0**（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）。

**AC2** `grep -n "page\.goto(\|page\.reload(" e2e/activity-dock-truthful.spec.ts` → 仅 `:533`（`page.goto(url)`）与 `:535`（`page.reload()`），都在 `navigateBounded`（`:520`–）函数体内；函数体外无裸启动导航——文件里其余每一处导航（`:618`、`:1090`、`:1176`、`:1211`、`:1274`）都是 `navigateBounded` 调用。探针耗尽预算时抛出的错误逐字见 AC3。`npm run typecheck` 退出 **0**。

**AC3**（有界失败）落点临时改为 `page.locator('.sentinel-that-cannot-exist-xyz')`：判据 `EXIT=1`，wall **20154ms**（< 55_000 闸），输出逐字含 ``Error: the project row for activity-dock-workspace never rendered, so this run's client never came up to a document that stays: the page shows "CloudCLI\nStar\n13.9k\n…"; console errors: <none>; failed requests: <none>``。备份还原后判据回到与 AC4 同形的内容红（见 AC4）。

**AC4**（判据在负载下连续绿）——**`exit 0` 不可达，如实登记，不勾**。还原后连续 5 次 `-g "AC-185"`：`#1 EXIT=1 wall=11835ms`、`#2 12071`、`#3 11777`、`#4 12131`、`#5 12212`——每次都 wall < 55_000，每次都 `[e2e] client startup: the project row for activity-dock-workspace landed after ~2.2s (attempt 1)`，**无一** `Timed out waiting 30000ms from config.webServer`、无 55s 看门狗、无 `[e2e] watchdog:`；但每次都 `EXIT=1`，红落在 `:814` `transcript.userRows=[2]`（`the retried text is exactly one user row, never two`）。并读一次 4 路并发（`resident-running-view` + `resident-status-bar` + `resident-ui-layout` + `session-filter`）：**目标判据 `EXIT=1 wall=12941ms`**（启动 attempt 1 @2792ms），`session-filter` `EXIT=0`；`resident-running-view` `EXIT=1`（`the badge read 0 ("") throughout`）、`resident-status-bar` `EXIT=1`（popover `toBeVisible` 超时）、`resident-ui-layout` `EXIT=1 wall=55616ms`——三份兄弟 spec 均不在本任务 Touches、本任务 diff 未触及，属宿主 4 路并发下的既有形态，**点名归因、不计入本条**。
**为何 `exit 0` 不可达（点名归因，非本任务）**：把 `e2e/activity-dock-truthful.spec.ts` 用 `git checkout --` 回 develop 版（`grep -c warmClientStartup` = 0）直跑：`EXIT=1 wall=11672ms transcript.userRows=[2]`，同一断言行——即 AC-185 判据在 **develop 净检出**上以同一形态恒红（同形读数另见 AC-188 任务完成记录的 Falsification record 与 memory `ac185-dock-criterion-red-at-develop`）。定位：composer 的重发**确实复用**同一乐观行（临时诊断逐字 `[diag] REUSE row=local_…`），两行来自转写层 local-echo↔persisted 去重失败（`useChatComposerState.ts` 之外的层），非本任务写面。AC-185 的翻绿属**待外部修复**；本任务只消除其**启动形态**红。

**AC5** `git diff develop -- playwright.config.ts package.json` → 空；`git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -c "^-.*expect("` → **0**；`git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -cE '^\+.*(retries|reuseExistingServer)'` → **0**；判据命令逐字未改。`git diff --stat develop` → 仅 `e2e/activity-dock-truthful.spec.ts`（1 file，+291/−7）。

**AC6**（承重 take-fake）先如实登记「纯还原不成立」：把 beforeAll 的探针还原成裸 `page.goto('/')`（develop 版）后在宿主负载下直跑 `EXIT=1 wall=11672ms`，**未**重现启动形态红（它照常挂载，落在内容红上）——与 memory `bounded-boot-guard-negative-control-needs-an-injected-non-mount` 的预测一致：健康客户端上单纯撤销探针是 no-op。故按该族既有配方注入「客户端不挂载」触发（`page.route('**/src/main.tsx', r => r.abort())`）作一档确定性更强的读数：
- take-fake（裸 `page.goto` + 注入不挂载）：`EXIT=1 wall=38510ms`，逐字失败 `TimeoutError: locator.waitFor: Timeout 30000ms exceeded.`（`:176` `revealSession` 的 `projectRow(...).waitFor`）——**无界、无署名**、逼近 55s 闸。
- 对照（探针在位 + 同一注入）：`EXIT=1 wall=20597ms`，`[e2e] client startup: the project row for activity-dock-workspace landed after 10786ms (attempt 2)`——**有界重放自愈**，未落到裸超时。
两臂随后 `git checkout -- e2e/activity-dock-truthful.spec.ts` 还原（`git status --porcelain` 干净）。承重结论：守卫把「无界、无署名、逼近 55s 闸的裸 `locator.waitFor` 超时」换成「有界、会署名、可重放自愈的启动路径」；撤销探针即回到前者。（未再单独跑「纯还原 + 4 路并发」；注入不挂载是该族既有的确定性配方，代其作为更强那一档。）

**AC7**（承重假形态）把 `src/modules/chat/hooks/useActivityFreshness.ts` 的 `liveness: snapshot.liveness` 临时改为 `liveness: 'fresh'`（本地表/本地钟，AC-184 的题面）：
```
-    liveness: snapshot.liveness,
+    // AC7 FALSIFICATION: the local table / local clock — the dock never reads unreachable.
+    liveness: 'fresh',
```
判据 `-g "AC-184"` → `EXIT=1 wall=21573ms`，红**落在坞的 `data-activity-state` 断言**：`Error: expect(locator).toHaveAttribute(expected) failed` / `Expected: "unreachable"` / `Received: "in-turn"` / `> 669 | await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'unreachable', { timeout: 10_000 });`。`git checkout -- src/modules/chat/hooks/useActivityFreshness.ts` 还原后判据回到 `EXIT=0 wall=24925ms`（1 passed），`git status --porcelain` 干净。

**守卫自身的原始输出行**：`[e2e] client warm-up: pre-bundle committed in 1524ms`；`[e2e] client startup: the project row for activity-dock-workspace landed after 2134ms (attempt 1)`；`[e2e] client startup: the chat pane on the mobile page for <sid> landed after 1966ms (attempt 1)`（AC-188 面）。

**boot 那一条**：本轮全部运行（AC4 的 5 连 + 1 并发 + AC3/AC6/AC7 变异跑）**均未复发** ``Error: Timed out waiting 30000ms from config.webServer.``（逐日志 grep 无命中），也无 `[e2e] watchdog:` 行。

**本仓修的是响应方式**：无界启动导航 → 有界预热（`beforeAll` 内、任何页面之前）+ 12s 有界探针（`page.reload()` 重放 + 署名错误）。触发源（本次运行自己的 Vite 依赖冷预构建 / 模块图在页面期被重优化打断）不在本仓可控范围内——判据的稳定性依赖守卫，而不是依赖触发源消失。

