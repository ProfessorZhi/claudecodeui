---
id: gap-ac175-criterion-bounded-boot-guard
title: AC-175 判据的启动阶段无界：宿主网络抖动把应用在途模块整批打断（net::ERR_NETWORK_CHANGED 实测 10
  连发）被拖到夹具项目行 30s 超时记红——把本族既有的有界预热+启动探针回灌到 e2e/resident-busy-send.spec.ts
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-175
---
## Proposal

来源：本轮 gap-filing 的**直接测量**，不是台账尾巴。AC-175 已离开 reverify 范围（其 GOAL-013 已 achieved、不再活；AC-175 未声明 `long-term: true`），台账尾部记为 CURRENTLY FALSE。本轮在立案前直接重跑了判据本身，并读了失败轮的 trace，而不是台账 `reason` 里那条只到 stderr 的尾巴。

判据命令（不变）：`npx playwright test e2e/resident-busy-send.spec.ts`。门限不变：driver-anchor 下 `runAcceptance({ timeoutMs: 6e4 })` 的硬 60s；spec 自身另有 `playwright.config.ts` 的 `SINGLE_SPEC_CEILING_MS = 55_000`。

**红的原始读数（读失败轮的 trace，不读台账 `reason` 的 stderr 尾巴）**

- 失败轮目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-kJWoBh`（本地 mtime 2026-10-03 16:15，对应台账 `2026-10-03T08:15:35.179Z` 的 AC-175 `gate=goal` fail）。`test-results/.last-run.json` → `"status": "failed"`，3 个用例全红。`test-results/resident-busy-send-residen-7053b-al-is-the-process-s-own-act/error-context.md` 逐字：`TimeoutError: locator.waitFor: Timeout 30000ms exceeded.` / `waiting for getByRole('button', { name: /^resident-busy-send-workspace/ }).first() to be visible`，落在 `e2e/resident-busy-send.spec.ts:334` 的 `revealSession` —— 夹具的项目行始终没出现。
- 同轮 trace 的页面控制台/网络（`test-results/.../trace.zip`，解出 `*-trace.network`）：**一次 10 连发的 `net::ERR_NETWORK_CHANGED`**（`_failureText` 逐字），命中应用在途的模块 URL —— `/src/shared/context/ThemeContext.tsx`、`/src/shared/context/UiPreferencesContext.tsx`、`/src/shared/context/WebSocketContext.tsx`、`/src/modules/auth/index.ts`、`/src/modules/plugins/index.ts`、`/src/modules/project-workspace/index.ts`、`/src/modules/task-master/index.ts`、`/src/modules/i18n/config.ts`、`/src/modules/i18n/LanguageSelector.tsx`、`/src/modules/i18n/languages.ts`；之后页面再无可用内容，`revealSession` 的 30s `waitFor` 到点。
- **没有 504**（trace 里没有 `Outdated Optimize Dep`），**全程没有 `[vite] connected`** ⇒ 是宿主网络抖动那条路，不是 504 dep-reopt + Vite 客户端 `location.reload()` 那条老路（两条路的区分法见既有 memory 与 `e2e/resident-running-view.spec.ts` 守卫的头注释）。
- 整轮对照：本轮直跑（同一 checkout、净树）`3 passed (37.1s)`、EXIT=0（`date -u` = `2026-10-03T08:16:29Z` → `08:17:07Z`），判据自己打印的全部读数逐条在场（`resident.queuedCard=0`、标注、撤回三态、per-run 正控制）；红轮死在启动阶段的 30s `waitFor`，3 个用例一个读数都没取到。台账近 6 轮（07:26–08:08）5 次 pass、1 次 fail。

**已排除（都量过，不要再走一遍）**：不是冷预打包 —— 失败轮 `vite-cache/deps` 与通过轮同源（本次运行的 `vite-cache` 已按 run 建好）；不是 504 dep-reopt 路径（见上）；不是磁盘 —— 本轮 e2e 暂存卷 free-bytes 3.58 TB；不是 cgroup。

**机制（本仓能修的那一半）**：触发源在渲染器之外 —— Chromium 的 `net::ERR_NETWORK_CHANGED` 把应用在途的模块请求整批打断（本机 docker/veth 变动是网络变更通知的真实来源），页面停在 boot 中途，侧栏永不渲染。`e2e/resident-busy-send.spec.ts` 的启动路径既没有客户端预热、也没有有界启动探针：文件里唯一的导航是 `:598` 的 `page.goto('/')`（其后 `:599` 的 `waitForLoadState('domcontentloaded')` 只等 DOM，不等挂载），它没有任何预算；`revealSession` 对项目行的 `waitFor({ timeout: 30_000 })`（`:334`）是这条路上唯一的等待。于是一次瞬时的模块加载中断被拖成 30s 超时记红，而不是一次自愈的重放。

<!-- dedup-ref -->
**机制去重读数（本轮实测，checkout `/data/home/yale/work/claudecodeui`，HEAD `09d4ac89`，branch `author`）**：`grep -rln '^goal_ac: *AC-175' tasks/` → 4 份（`gap-claude-resident-busy-send-ui`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`、`gap-ac175-criterion-red-is-uncommitted-composer-wip`），**全部 `status: done`**。在飞（todo/ready/needs-human）认领者实测为 **0** —— 三份在飞任务的 `goal_ac` 分别是 AC-190 / （空）/ （空），无一为 AC-175。`grep -rln "warmClientStartup\|bounded-boot\|navigateBounded" tasks/` 无一份命中 `resident-busy-send.spec.ts`（本族既有守卫任务覆盖的是 session-filter / transcript-follow / resident-running-view / resident-status-bar / resident-ui-layout / activity-dock-truthful / model-library / claude-resident-shell-tab，**没有 busy-send**）。⇒ 本条不是重复。按「done 不算重复、是更早修复没兜住的证据」：更早三条修的是判据的**断言面**（锚点换到活动坞、心跳帧毒化 merge），启动路径从未拿到本族守卫。

**为什么早先的 done 没兜住**：`gap-claude-resident-busy-send-ui`（done）建的是判据本体；`gap-activity-heartbeat-frame-crashes-realtime-merge`（done）修的是 `command_lifecycle` 的 merge 语义；`gap-ac175-criterion-anchor-retired-by-dock-consolidation`（done）把「忙」读数换锚到活动坞；`gap-ac175-criterion-red-is-uncommitted-composer-wip`（done，verification-only）把一次主检出 WIP 崩归因入档。四者都**没有**把本族既有的启动守卫（有界预热 + 有界启动探针）带回 `e2e/resident-busy-send.spec.ts`。本族守卫早已成立并已回灌到多份兄弟 spec（逐份实测 `grep -c warmClientStartup` ≥ 2：`e2e/session-filter.spec.ts`、`e2e/transcript-follow.spec.ts`、`e2e/resident-running-view.spec.ts`、`e2e/resident-status-bar.spec.ts`、`e2e/voice-dashscope-written.spec.ts`、`e2e/voice-error-messages.spec.ts`、`e2e/voice-identifier-repair.spec.ts`）；`e2e/resident-busy-send.spec.ts` 是这一族里下一份「只有封顶、没有守卫」的 spec —— 封顶即 `BOOT_CEILING_MS` / `RUN_CEILING_MS`，它把红限制在 55s 内、但不给页面里的无界等待一条恢复路径。

**修法（移植既有守卫，不发明新机制）**：把家族既有的两个杠杆搬进 `e2e/resident-busy-send.spec.ts` 的启动路径，覆盖该 spec 真实存在的每一次导航（今天只有 `beforeAll` 里 `:598` 的 `page.goto('/')`，将来新增也必须走同一入口）：

1. **有界客户端预热**（在任何页面之前，`beforeAll` 内、`browser.newContext()/newPage()` 之前）：对 `baseURL` 依次取 `/`、`/src/main.tsx`、以及从 entry 文本里读出的一个本次运行当前的优化依赖 URL（`/@fs/.../deps/<dep>.js?v=<hash>`），直到 200；每步各自带 deadline（照 `warmClientStartup` 的形态与语义，`CLIENT_WARM_DEADLINE_MS = 30_000`），超时或非 200 时按 url + status 指名抛错，含「客户端接了连接却不答」。
2. **有界启动探针**（该次导航之后）：用短预算探「本次导航的落点已就绪」——首次 boot 探夹具的项目行（`projectRow(workspaceName)` 的落点）；未就绪就在预算内 `page.reload()` 重放，并收集 `page.on('requestfailed')` 与 console 证据；预算耗尽时**带页面文本 + 失败请求列表大声抛错**，绝不静默继续。照 `e2e/resident-running-view.spec.ts:632` 的 `navigateBounded` 形态（`STARTUP_PROBE_MS=8_000` / `STARTUP_RELOAD_PROBE_MS=3_000` / `NAVIGATION_PROBE_MS=8_000` / `STARTUP_PROBE_DEADLINE_MS=14_000`）。

预热与探针留在 spec 内，不动 `playwright.config.ts`：`globalSetup` 需要一个 `e2e/*.ts` 新文件，会触发 lint 边界（与 `gap-session-filter-criterion-bounded-boot-guard` / `gap-resident-running-view-criterion-bounded-boot-guard` 同一条理由）。

⛔ 不变式：判据命令不改；60s 门限与 55s spec 上限不动；3 个用例的 `expect` 一字不动；不加 Playwright `retries`；不开 `reuseExistingServer: true`；不 stub、不 skip；不把 QueuedMessageCard / 标注 / 撤回三态 / per-run 正控制的断言搬走；不删任何假形态臂。守卫只允许**重放导航**，不允许替用例下任何结论 —— 探针探不到时必须红，而且红得可读。

取假形态：把守卫写成「探不到就当已就绪继续跑」时，3 个用例会在空白页上各自等到自己的超时，整轮必然越过 55s spec 上限 / 60s 门限记红 —— 这就是守卫没有变成静默放行的证明。

## AC

- [x] AC1 有界客户端预热真实生效：`e2e/resident-busy-send.spec.ts` 里有 `warmClientStartup`（或等价命名）的定义、与「任何页面之前」的调用（`beforeAll` 内、`browser.newPage()` 之前），逐 URL 带 deadline，非 200 / 超时按 url 指名抛错。验证：`grep -n "warmClientStartup" e2e/resident-busy-send.spec.ts` 同时命中定义行与调用行，且证据贴在完成记录里；该 spec 的 typecheck `exit 0`。
- [x] AC2 每一次导航都走同一个有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/resident-busy-send.spec.ts` 的每一处行号都落在探针函数体内部，函数体外没有任何裸导航；探针耗尽预算时抛出携带页面文本与 `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界 + typecheck `exit 0`。
- [x] AC3 有界失败的实测：把探针落点临时指向一个不可能存在的 sentinel 后，`npx playwright test e2e/resident-busy-send.spec.ts` 在 **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：两次运行的 `echo $?` 与 wall time。
- [x] AC4 判据在负载下连续绿：`npx playwright test e2e/resident-busy-send.spec.ts` 连续 ≥5 次全部 `exit 0`，且每一次 wall < 55_000ms（一次都不触发 55s 看门狗 / 60s 门限），其中至少一次与 ≥4 份兄弟 spec 并发。验证：逐次 `echo $?` + wall time。**如实登记**：本机负载高（实测 swap 14.4/15G、load1 > 13），并发那一次若兄弟 spec 自己红，须点名归因，不得算到本条头上。
- [x] AC5 判定面未变：`git diff develop -- package.json playwright.config.ts` 为空（无 `test:e2e` / `RUN_CEILING_MS` / `BOOT_CEILING_MS` / `SINGLE_SPEC_CEILING_MS` 的增删），且 `git diff develop -- e2e/resident-busy-send.spec.ts | grep -c "^-.*expect("` 为 **0**。验证：两条命令的逐字输出。
- [x] AC6 AC-175 的红形态仍可复现（承重负控制）：在本条自己的隔离 worktree 上，把 `revealSession` 的项目行落点临时改成一个不可能存在的 sentinel（或把 `projectRow` 的 workspaceName 改成错名），判据退出**非 0** 且红**落在启动探针那条错误**（带页面文本 + 失败请求列表），而不是三条用例各自超时；登记变异 diff、失败逐字、退出码；恢复后判据回到 0。验证：变异跑与还原跑的 `echo $?`。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-175 的台账尾部不再是 CURRENTLY FALSE）。且这条绿不是「恰好那次没抖」—— AC4 的 ≥5 连绿（含一次 ≥4 份兄弟 spec 并发）的逐次 wall/exit 读数写进完成记录；AC3 的有界失败读数（探不到时 <30s 红、带页面文本与失败请求列表）以及还原后的读数一并登记；AC6 的负控制读数（哨兵落点 ⇒ 探针红、带证据）与还原读数一并登记。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿；3 个用例的 `expect` 一字未改由 AC5 机械证明。完成记录里必须写明：本仓修掉的是**响应方式**（无界等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`）不在本仓可控范围内 —— 因此这条判据的稳定性依赖守卫，而不是依赖触发源消失。

## Touches

- e2e/resident-busy-send.spec.ts
- tasks/gap-ac175-criterion-bounded-boot-guard.md

## 完成记录（2026-10-03）

**实现**：提交 `506b06a5`（本任务分支 `task/gap-ac175-criterion-bounded-boot-guard`，基于 develop `84014b0b`，已合 develop `01209a9d` → `84b0e6c4`）。只改 `e2e/resident-busy-send.spec.ts`（+241 / −3）。把本族既有两杠杆搬进启动路径：`warmClientStartup(clientUrl)`（`beforeAll` 内、`browser.newContext()/newPage()` 之前；对 `/`、`/src/main.tsx`、entry 里解析出的一个本次运行优化依赖 URL 逐 URL 带 deadline 取到 200，非 200 / 超时按 url+status 指名抛错，含「客户端接了连接却不答」）与 `navigateBounded(page, projectRowLanding, 'first-load')`（该 spec 唯一导航 `page.goto('/')` 已落进探针函数体；探到夹具项目行即返回，探不到就在 14s deadline 内 `page.reload()` 重放，耗尽则带页面文本 + `requestfailed` 列表抛错）。

**AC1** `grep -n "warmClientStartup" e2e/resident-busy-send.spec.ts` → 定义 `:416`、调用 `:805`（调用在 `browser.newContext()` `:807` 之前，因之在 `newPage()` 之前）；该 spec 独立 typecheck（`npx tsc --noEmit --strict --skipLibCheck ... e2e/resident-busy-send.spec.ts`）退出 **0**；`npm run typecheck` 退出 **0**（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）。

**AC2** `grep -n "page\.goto(\|page\.reload(" e2e/resident-busy-send.spec.ts` → `:551`、`:553`，两行均落在 `navigateBounded`（`:539`–`:574`）函数体内，函数体外无裸导航。探针耗尽预算时抛出的错误逐字见 AC3/AC6。

**AC3**（有界失败实测）探针落点临时改为 `page.locator('#__ac175-ac3-impossible-sentinel__')`：判据 `EXIT=1`，wall **22753ms**（< 30s），输出逐字 `Error: the project row for resident-busy-send-workspace never rendered, so this run's client never came up to a document that stays: the page shows "CloudCLI\nStar\nProjects\nConversations\nCtrl\nK\nmobile-layout-workspace\n1 - ...obile-layout-workspace\nmobile-send-key-workspace\n1 - ...ile-send-key-workspace\nresident-busy-send-workspace\n3 - ...nt-busy-send-workspace\nsession-filter-workspace\n7 - ...ssion-filter-workspace\ntranscript-follow-workspace\n1 - "; console errors: Failed to load resource: the server responded with a status of 403 () | (×5); failed requests: <none>`。还原后判据 `EXIT=0`、wall=37457ms、`elapsed=36494ms`。

**AC4**（负载下连续绿；本机负载高）还原后连续 5 次：`#1 EXIT=0 wall=40290ms elapsed=39295ms`、`#2 37408`、`#3 36818`、`#4 46251`、`#5 38414` —— 全部 `exit 0` 且 wall < 55_000（无一看门狗 / 60s 门限）。并发一次：与 `session-filter`、`transcript-follow`、`resident-running-view`、`resident-status-bar` 四份兄弟 spec 同跑（5 路并发），**目标判据 `EXIT=0 wall=43606ms elapsed=42647ms`**。兄弟 `session-filter` / `resident-running-view` / `resident-status-bar` 分别 5 / 3 / 4 passed；`transcript-follow` **EXIT=1** —— **点名归因**：红是它自己的看门狗跨了单文件 55s 上限（`this run crossed its own 55000ms ceiling at 55001ms and is ending here with exit 1 at 55003ms — stuck at stage "browser-launch-or-cases"`，7 个用例里 5 个已 pass）；该文件不在本任务 Touches、本任务 diff 未触及，属宿主负载（本次 5 路并发）下的既有红，不计入本条。

**AC5** `git diff develop -- package.json playwright.config.ts` → 空；`git diff develop -- e2e/resident-busy-send.spec.ts | grep -c "^-.*expect("` → **0**。合 develop `01209a9d` 后复测同样为 0 / 空。

**AC6**（承重负控制）把探针落点 `projectRow` 的 workspaceName 实参改成错名（模板串 `${workspaceName}-ac6-no-such-fixture`）：
```
-      present: (budgetMs) => appears(projectRow(page, workspaceName), budgetMs),
+      present: (budgetMs) => appears(projectRow(page, `${workspaceName}-ac6-no-such-fixture`), budgetMs),
```
判据 `EXIT=1`（wall 25400ms），红**落在启动探针那条错误**上，逐字 `Error: the project row for resident-busy-send-workspace never rendered, so this run's client never came up to a document that stays (the navigation itself failed: page.reload: Timeout 178ms exceeded. ... ): the page shows ""; console errors: Failed to load resource: the server responded with a status of 403 () | (×5); failed requests: <none>`，且同轮 `grep -c "Timeout 30000ms exceeded"` = **0**（不是三条用例各自超时）。还原后判据回到 `EXIT=0`、wall=37090ms。

**合 develop 后复跑**：`git merge develop`（`01209a9d`）→ `84b0e6c4`；merge 未触及本 spec（`git diff 506b06a5 HEAD --name-only | grep -c resident-busy-send.spec.ts` = 0）；复跑判据 `EXIT=0`、wall=37378ms、`elapsed=36561ms`。

**守卫自身的原始输出行**：`[e2e] client warm-up: pre-bundle committed in 1254ms`；`[e2e] client startup: the project row for resident-busy-send-workspace landed after 2860ms (attempt 1)`。

**scoped 门**：`bash scripts/test.sh --for-task gap-ac175-criterion-bounded-boot-guard --allow-thin` → `no scoped test files for gap-ac175-criterion-bounded-boot-guard (thin)`，退出 0（Touches 的 `e2e/*.spec.ts` 不匹配门的 `*.test.*` 过滤，故为 thin）。

**本仓修的是响应方式**：无界等待（`revealSession` 的 30s `waitFor`）→ 有界重放（预热 + 探针 + `page.reload()`）。触发源（宿主层 `net::ERR_NETWORK_CHANGED`，本机 docker/veth 变动）不在本仓可控范围内 —— 因此这条判据的稳定性依赖守卫，而不是依赖触发源消失。
