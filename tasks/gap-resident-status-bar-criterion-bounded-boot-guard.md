---
id: gap-resident-status-bar-criterion-bounded-boot-guard
title: AC-172 判据的启动阶段无界：一次页面期 Vite 依赖冷预构建把应用的模块图整批打断（trace 里 10 个模块响应状态 -1、整轮无
  /api/*），被拖成夹具项目行 30s 超时记红——本族既有的有界预热+启动探针未回灌到 e2e/resident-status-bar.spec.ts
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

来源：本轮 gap-filing 的直接测量，不是台账尾巴。AC-172 已离开 reverify 范围（其 GOAL-013 已 achieved、不再活），且未声明 `long-term: true`，台账尾部记为 CURRENTLY FALSE。

判据命令（不变）：`npx playwright test e2e/resident-status-bar.spec.ts`。门限不变：driver-anchor 下 goal gate 的硬 60s；`playwright.config.ts:317` 的 `SINGLE_SPEC_CEILING_MS = 55_000`（spec 自身 `:1002` 的 `elapsed < 55_000` 亦钉此数）。

**本轮的直接量（不是推断）**

- 干净重跑：`npx playwright test e2e/resident-status-bar.spec.ts` → `4 passed (32.2s)`，EXIT=0（HEAD `bf55b0a6`，author==develop）。
- 同一 AC 在同一窗口内也是**间歇红**（台账 `reason` 只留 stderr 尾巴，故读失败轮的 trace）：
  - `/data/scratch/yale/quay-e2e-Uv39To`（goal-sweep，`2026-10-01T05:40:29.078Z` fail）
  - `/data/scratch/yale/quay-e2e-YKl0c7`（goal-sweep，`2026-10-01T05:58:17.157Z` fail）
  - `/data/scratch/yale/quay-e2e-X7mHVU`（goal-cli，`2026-10-01T06:02:20.530Z` fail）
  三次 `reason` 逐字同形：`acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/scratch/yale/quay-e2e-*/vite-cache/deps/react-scan.js?v=… as it exceeds the max of 500KB.`
- 失败形态（`…/test-results/resident-status-bar-reside-45a00-s-it-and-closes-the-process/error-context.md` 逐字）：`TimeoutError: locator.waitFor: Timeout 30000ms exceeded.` / `waiting for getByRole('button', { name: /^resident-status-bar-workspace/ }).first() to be visible`，落在 `e2e/resident-status-bar.spec.ts:392` 的 `revealSession` —— 夹具的项目行始终没出现，四条四态断言一条都没执行到。
- 同轮 trace（`trace.zip` 的 network）解出的直接证据：应用的模块图**没走完** —— `/src/shared/context/ThemeContext.tsx`、`…/UiPreferencesContext.tsx`、`/src/modules/auth/index.ts`、`…/task-master/index.ts`、`…/WebSocketContext.tsx`、`…/plugins/index.ts`、`…/project-workspace/index.ts`、`…/i18n/config.ts`、`…/LanguageSelector.tsx`、`…/languages.ts` 的响应状态是 **-1**（到 trace 截断时仍在途），且整轮**没有任何 `/api/*` 请求** → 应用从未 mount，页面停在空白。

**机制（本仓能修的那一半）**：驱动这轮的 `[BABEL] … react-scan.js …` 行说明**本次运行自己的** `vite-cache/deps` 在页面期做了一次冷预构建/重优化。本仓这一族的既有结论（`gap-transcript-follow-criterion-boot-dep-reopt-race`、`gap-session-filter-criterion-bounded-boot-guard`）已实测：每次运行的 client 走私有 `VITE_CACHE_DIR`，`seedViteCache()` 在共享缓存无效时**静默降级为从零预构建**；预构建期间 Vite 对在途模块请求答 504 `Outdated Optimize Dep`，并由它自己的客户端 `location.reload()` 把文档整份换掉 —— 被这次 reload 打断的模块请求就这么永远停在 -1。`e2e/resident-status-bar.spec.ts` 的启动路径**既没有客户端预热、也没有有界启动探针**：文件里唯一的启动导航是 `:554` 的 `page.goto('/')`，没有任何预算；这条路上唯一的等待是 `revealSession` 对项目行的 `waitFor({ state: 'visible', timeout: 30_000 })`。于是一次页面期重优化被拖成 30s 超时记红，而不是一次自愈的重放。

<!-- dedup-ref -->
**为什么上一次的修法没兜住**：`gap-claude-resident-status-bar`（`goal_ac: AC-172`，**done**）把四态行走、计数、popover 复制/关闭、无人轮标签这些**断言**落对了，但没有把本族既有的启动守卫带回本 spec。守卫家族在本仓早已成立并已回灌到多份兄弟 spec（逐份实测 `grep -c warmClientStartup` = 2，即定义行 + 调用行）：`e2e/session-filter.spec.ts`、`e2e/transcript-follow.spec.ts`、`e2e/voice-dashscope-written.spec.ts`、`e2e/voice-error-messages.spec.ts`、`e2e/voice-identifier-repair.spec.ts`，以及本次 AC 的**同族**兄弟 `e2e/resident-running-view.spec.ts`（`gap-resident-running-view-criterion-bounded-boot-guard`，done）与 `e2e/resident-ui-layout.spec.ts`（`gap-resident-ui-layout-criterion-bounded-boot-guard`，done）。实测：`grep -c warmClientStartup e2e/resident-status-bar.spec.ts` → **0**；`grep -c navigateBounded e2e/resident-status-bar.spec.ts` → **0** —— 它是这一族里**最后一份**「只有封顶、没有守卫」的 spec。

**台账现状（如实登记，免得下一轮重炒）**：本轮 goal-driver 的 round 3329（`2026-10-01T06:01:09.030Z`）`frozenFailing.failing=["AC-172"]`、`judgment="violated"`，但其 `frozenRecheck` 逐轮 `cleared`/`now-true`（rounds 3316–3329 共 14 轮全部如此），故 `gaps=[]`、`spawned=0`。也就是说：立案前复核每次都能把判据跑绿，而把它留在 `failing` 里的那条台账尾是 **goal-sweep 的 fail** —— 那不是陈旧读数，是**同一启动态在并发负载下的真实测量**（见上三条 fail）。因此本任务不是「追一条陈旧尾巴」，而是让这条判据在驱动自己的负载下**不再偶发假红**。

**修法（移植既有守卫，不发明新机制）**：把家族既有的两个杠杆搬进 `e2e/resident-status-bar.spec.ts` 的**启动路径**：

1. **有界客户端预热**（`beforeAll` 内、`browser.newContext()`/`newPage()` 之前）：对 `baseURL` 依次取 `/`、`/src/main.tsx`、以及从 entry 文本里读出的一个本次运行当前的优化依赖 URL，直到 200；每步各自带 deadline，非 200 / 超时按 url+status 指名抛错（照 `e2e/resident-running-view.spec.ts:502` 的 `warmClientStartup` 形态与语义，含「客户端接了连接却不答」也要按名字失败）。
2. **有界启动探针**：`:554` 的启动导航改走 `navigateBounded`，落点是夹具的项目行（`projectRow(page, workspaceName)`）；首次 8s 探到即返回，探不到就在 14s deadline 内 `page.reload()` 重放，并收集 `page.on('console')` / `page.on('requestfailed')` 证据；预算耗尽时**带页面文本 + 失败请求列表大声抛错**，绝不静默继续（照 `e2e/resident-running-view.spec.ts:625` 的 `navigateBounded`）。

**明确不动**：`:793` 与 `:877` 的两处 `page.reload()` 是本判据**故意**的重连（文件自己的注释：「a document open before the run started was never attached to it」），各自紧跟有界的 `toBeVisible(...)`，属测量的组成部分，**保持原样**；守卫只覆盖**启动**那一次导航。

⛔ 不变式：判据命令不改；60s 门限与 55s spec 上限不动；四个用例的 `expect` 一字不动；不加 Playwright `retries`；不开 `reuseExistingServer: true`；不 stub、不 skip；不把四态行走 / 计数 / popover / 无人轮断言搬走；不删 AC-172 原本的两条假形态臂（状态条读本地状态 ⇒ 必须红；无人轮以用户消息样式显示 ⇒ 必须红）。守卫只允许**重放导航**，不允许替用例下任何结论 —— 探针探不到时必须红，而且红得可读。预热与探针留在 spec 内，不动 `playwright.config.ts`（`globalSetup` 需要一个 `e2e/*.ts` 新文件，会触发 lint 边界，与 `gap-session-filter-criterion-bounded-boot-guard` 同一条理由）。

## AC

- [x] AC1 有界客户端预热真实生效：`e2e/resident-status-bar.spec.ts` 里有 `warmClientStartup`（或等价命名）的定义与「任何页面之前」的调用，逐 URL 带 deadline，非 200 / 超时按 url 指名抛错。验证：`grep -n "warmClientStartup" e2e/resident-status-bar.spec.ts` 同时命中定义行与调用行，且 `npm run typecheck` 退出 0。
- [x] AC2 启动导航走有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/resident-status-bar.spec.ts` 里**启动**那一次（原 `:554`）落在探针函数体内部；`:793` / `:877` 两处故意重连保持原样并逐行说明为何不搬。探针耗尽预算时抛出携带页面文本与 `requestfailed` 列表的错误。验证：`grep -n` 输出逐行落界 + typecheck 退出 0。
- [x] AC3 有界失败的实测：把探针落点临时指向一个不可能存在的 sentinel 后，`npx playwright test e2e/resident-status-bar.spec.ts` 在 **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：两次运行的 `echo $?` 与 wall time。
- [x] AC4 判据在负载下连续绿：`npx playwright test e2e/resident-status-bar.spec.ts` 连续 ≥5 次全部 `exit 0`，且每一次 wall < 55_000ms（一次都不触发 55s 看门狗 / 60s 门限），其中至少一次与 ≥4 份兄弟 spec 并发。验证：逐次 `echo $?` + wall time。**如实登记**：本机负载高（本轮实测 load1 ≈ 10.5–13），并发那一次若兄弟 spec 自己红，须点名归因，不得算到本条头上。
- [x] AC5 判定面未变：`git diff develop -- package.json playwright.config.ts` 为空；`git diff develop -- e2e/resident-status-bar.spec.ts | grep -c "^-.*expect("` 为 **0**；判据命令 `npx playwright test e2e/resident-status-bar.spec.ts` 与 AC 记录里 `criterion:` 逐字一致。验证：三条命令的逐字输出。
- [x] AC6 AC-172 的两条假形态仍然红（承重）：(i) 把状态条改成读本地状态而不读宿主接口（场景切换状态后读数不再跟随宿主）⇒ 判据退出**非 0**，红落在四态那条断言上；(ii) 把无人轮渲染成用户消息样式（`isUserStyle` 为真 / 去掉 `unattended` 行类）⇒ 判据退出**非 0**，红落在无人轮那条断言上。两条都登记变异 diff、失败断言逐字、退出码；恢复后判据回到 0。验证：两次变异跑与两次还原跑的 `echo $?`。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-172 的台账尾部不再是 CURRENTLY FALSE），且这条绿在**其后连续多轮**的 frozenRecheck 中保持 pass —— 即 goal-sweep 在并发负载下不再把它偶发打红。AC4 的 ≥5 连绿（含一次 ≥4 份兄弟 spec 并发）逐次 wall/exit 写进完成记录；AC3 的有界失败读数（探不到时 <30s 红、带页面文本与失败请求列表）与还原读数一并登记；AC6 两条假形态的读数与还原读数一并登记。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿；四个用例的 `expect` 一字未改由 AC5 机械证明。完成记录里必须写明：本仓修掉的是**响应方式**（无界等待 → 有界重放），触发源（本次运行自己的 Vite 依赖冷预构建 / 重优化）由 `seedViteCache()` 在共享缓存无效时的静默降级决定，预热把这个代价移出测量窗口 —— 因此这条判据的稳定性依赖守卫，而不是依赖触发源消失。同时写明本任务**不**改四态语义、**不**回退 `gap-claude-resident-status-bar` 已落对的断言。

## Touches

- e2e/resident-status-bar.spec.ts
- tasks/gap-resident-status-bar-criterion-bounded-boot-guard.md

## 完成记录（2026-10-01）

**实现**：提交 `b57428a1`（本任务分支，基于 develop `26e80987`）。只改 `e2e/resident-status-bar.spec.ts`（+248 / −4）。把家族既有两杠杆搬进启动路径：`warmClientStartup(clientUrl)`（`beforeAll` 内、`browser.newContext()/newPage()` 之前；对 `/`、`/src/main.tsx`、entry 里解析出的一个本次运行优化依赖 URL 逐 URL 带 deadline 取到 200，非 200 / 超时按 url+status 指名抛错，含「客户端接了连接却不答」）与 `navigateBounded(page, projectRowLanding, 'first-load')`（该 spec 的启动导航 `page.goto('/')` 已落进探针函数体；探到夹具项目行即返回，探不到就在 14s deadline 内 `page.reload()` 重放，耗尽则带页面文本 + `requestfailed` 列表抛错）。`:1034` / `:1121` 两处故意重连保持原样，各加一行说明为何不搬。

**AC1** `grep -n "warmClientStartup" e2e/resident-status-bar.spec.ts` → 定义 `:487`、调用 `:757`（定义行与调用行都命中）；`npm run typecheck` 退出 **0**（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）。

**AC2** `grep -n "page\.goto(\|page\.reload(" e2e/resident-status-bar.spec.ts` → `:623`（`goto('/')`）、`:625`（探针内的 replay `reload()`）落在 `navigateBounded`（`:611`–`:646`）函数体内；函数体外只剩 `:1034`、`:1121` 两处故意重连，均带「deliberately not moved behind `navigateBounded`」逐行说明。探针耗尽预算时抛出的错误逐字见 AC3。typecheck 退出 0。

**AC3**（有界失败实测）落点临时改为 `page.locator('[data-startup-probe-sentinel-never-renders]')`：判据 `EXIT=1`，wall **22327ms**（< 30s），输出逐字 `Error: the project row for resident-status-bar-workspace never rendered, so this run's client never came up to a document that stays (the navigation itself failed: page.reload: Timeout 189ms exceeded. …): the page shows ""; console errors: <none>; failed requests: <none>`。还原（`git checkout --`）后判据 `EXIT=0`、wall **32034ms**（另一次确认 `EXIT=0`、wall 31920ms）。

**AC4**（负载下连续绿；本机 load1 ≈ 10.9–13.2）还原后连续 5 次：`#1 EXIT=0 wall=31824ms`、`#2 32152ms`、`#3 31991ms`、`#4 32131ms`、`#5 32610ms` —— 全部 `exit 0` 且 wall < 55_000（无一看门狗 / 60s 门限）。并发一次：与 `resident-running-view`、`resident-ui-layout`、`session-filter`、`transcript-follow` 四份兄弟 spec 同跑，**目标判据 `EXIT=0 wall=32458ms`（4 passed）**。兄弟 `running-view` / `ui-layout` / `session-filter` 分别 3 / 3 / 5 passed；`transcript-follow` **EXIT=1**（wall=55296ms）—— **点名归因**：红是它自己的断言 `e2e/transcript-follow.spec.ts:3108`（`a whole row arriving while pinned keeps the pane at the bottom`，逐字 `row 0 has to arrive taller than the pane it arrives in …`），且**无并发单独跑同样 `EXIT=1 wall=54494ms`**；该文件不在本任务 Touches、本任务 diff 未触及，属宿主负载下的既有红，不计入本条。

**AC5** `git diff develop -- package.json playwright.config.ts` → 空；`git diff develop -- e2e/resident-status-bar.spec.ts | grep -c "^-.*expect("` → **0**；`git diff --stat develop` → 仅 `e2e/resident-status-bar.spec.ts | 248 ++++…`（1 file，+248 −4）；判据命令逐字 `npx playwright test e2e/resident-status-bar.spec.ts`，与 `goals/AC-172-*.md` 的 `criterion:` 一致。

**AC6**（承重假形态，逐字复现 AC-172 的两条臂）：

(i) 状态条加一个本地镜像（`localStateEcho`，由自身 start/close 写入、永不从 `GET /api/session-hosts` 刷新），`processState = localStateEcho.get(sessionId) ?? readResidentProcessState(host)`；diff 见 `/tmp/ac6-sb-armA.diff`。判据 `EXIT=1`（wall **26128ms**），红**落在四态那条断言**上，逐字 `Error: expect(locator).toHaveAttribute(expected) failed` / `Expected: "busy"` / `Received: "idle"`（`e2e/resident-status-bar.spec.ts:976`），同跑打印 `data-resident-host-state="busy"` 而 `data-resident-ui-state="idle"`。

(ii) `rendersAsUser = message.type === 'user' || message.type === UNATTENDED_TURN_MESSAGE_TYPE`；diff 见 `/tmp/ac6-sb-armB.diff`。判据 `EXIT=1`（wall **32575ms**），红**落在无人轮那条断言**上，逐字 `Error: a turn nobody typed must not wear the user's own bubble style` / `Expected: not "user"`，同跑打印 `row.class=user isUserStyle=true`（两条无人轮）。

两臂还原（`git checkout --`）后判据回到 `EXIT=0`、wall 31877ms。

**守卫自身的原始输出行**：`[e2e] client warm-up: pre-bundle committed in 1433ms`；`[e2e] client startup: the project row for resident-status-bar-workspace landed after 2195ms (attempt 1)`。

**本仓修的是响应方式**：无界等待（`revealSession` 的 30s `waitFor`）→ 有界重放（预热 + 探针 + `page.reload()`）。触发源（本次运行自己的 Vite 依赖冷预构建 / 重优化）由 `seedViteCache()` 在共享缓存无效时的静默降级决定，不在本仓可控范围内 —— 预热把这个代价移出测量窗口，因此这条判据的稳定性依赖守卫，而不是依赖触发源消失。本任务**不**改四态语义、**不**回退 `gap-claude-resident-status-bar` 已落对的断言（四个用例的 `expect` 一字未改由 AC5 机械证明）。
