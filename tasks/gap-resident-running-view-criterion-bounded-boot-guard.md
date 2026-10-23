---
id: gap-resident-running-view-criterion-bounded-boot-guard
title: AC-173 判据的启动阶段无界：一次渲染器侧模块加载中断（net::ERR_NETWORK_CHANGED 实测 10 连发）被拖到夹具项目行
  30s 超时记红——本族既有的有界预热+启动探针未回灌到 e2e/resident-running-view.spec.ts
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

来源：本轮 gap-filing 的直接测量，不是台账尾巴。AC-173 已离开 reverify 范围（其 GOAL-013 已 achieved、不再活），且未声明 `long-term: true`，台账尾部记为 CURRENTLY FALSE；本轮在立案前直接重跑了判据本身，并读失败轮的 trace，而不是台账 `reason` 里那条 stderr 尾巴。

判据命令（不变）：`npx playwright test e2e/resident-running-view.spec.ts`。门限不变：driver-anchor 下 `runAcceptance({ timeoutMs: 6e4 })` 的硬 60s；spec 自身另有 `playwright.config.ts:317` 的 `SINGLE_SPEC_CEILING_MS = 55_000`。

**红的原始读数（读失败轮的 trace，不读台账 `reason` 的 stderr 尾巴）**

- 失败轮目录 `/data/scratch/yale/quay-e2e-bD8juY`（本地 mtime 2026-09-30 04:45，对应台账那条 `2026-09-29T20:45:38.029Z` 的 AC-173 goal gate fail）。`test-results/.last-run.json` → `"status": "failed"`，3 个用例全红（该 spec 共 3 个用例）。
- `test-results/resident-running-view-resi-44a96-s-the-process-it-belongs-to/error-context.md` 逐字：`TimeoutError: locator.waitFor: Timeout 30000ms exceeded.` / `waiting for getByRole('button', { name: /^resident-running-view-workspace/ }).first() to be visible`，落在 `e2e/resident-running-view.spec.ts:438` 的 `revealSession` —— 夹具的项目行始终没出现。
- 同轮 trace 的页面控制台：**一次 10 连发的 `Failed to load resource: net::ERR_NETWORK_CHANGED`**，命中应用在途的模块 URL —— `node_modules/vite/dist/client/env.mjs`、`src/modules/plugins/index.ts`、`src/modules/project-workspace/index.ts`、`src/modules/i18n/config.ts`、`src/modules/i18n/LanguageSelector.tsx`、`src/modules/i18n/languages.ts`，以及四个本次运行的优化依赖分块 `/@fs/data/scratch/yale/quay-e2e-bD8juY/vite-cache/deps/chunk-*.js?v=334f84be`；之后只有 `SW registered`，页面再无可用内容。
- **没有 504**（trace 里没有 `Outdated Optimize Dep`；唯一命中子串 `504` 的是耗时 `40.504999…`），**全程没有 `[vite] connected`** ⇒ 是宿主网络抖动那条路，不是 `504 Outdated Optimize Dep` + Vite 客户端 `location.reload()` 那条老路。
- 整轮对照：通过轮 ~35.6s（`gap-claude-resident-running-view` 完成记录）/ 本轮直跑 `3 passed`、`elapsed=40755ms`、EXIT=0；红轮死在启动阶段的 30s `waitFor`，3 个用例一个读数都没取到。

**已排除（都量过，不要再走一遍）**：不是冷预打包 —— 失败轮的 `vite-cache/deps` 有 **2334** 个文件，与通过轮一致；不是 504 dep-reopt 路径（见上）；不是磁盘（本轮 e2e 暂存卷 available-bytes 3.67 TB）；不是 cgroup。

**机制（本仓能修的那一半）**：触发源在渲染器之外 —— Chromium 的 `net::ERR_NETWORK_CHANGED` 把应用在途的模块请求整批打断（本机 docker/veth 变动是网络变更通知的真实来源），页面停在 boot 中途。`e2e/resident-running-view.spec.ts` 的启动路径既没有客户端预热、也没有有界启动探针：文件里唯一的导航是 `:613` 的 `page.goto('/')`，它没有任何预算；`revealSession` 对项目行的 `waitFor({ timeout: 30_000 })` 是这条路上唯一的等待。于是一次瞬时的模块加载中断被拖成 30s 超时记红，而不是一次自愈的重放。

<!-- dedup-ref -->
**为什么上一次的修法没兜住**：`gap-claude-resident-running-view`（`goal_ac: AC-173`，**done**，实现提交 `8357e627`，2026-09-28）把 Running 视图分组、徽标只计在飞会话、以及判据都落对了，但它没有把这一族既有的启动守卫带回本 spec。守卫家族在本仓早已成立、且已回灌到多份兄弟 spec（逐份实测 `grep -c warmClientStartup` ≥ 2）：`e2e/session-filter.spec.ts`（`warmClientStartup` + `navigateBounded`，`gap-session-filter-criterion-bounded-boot-guard`，done）、`e2e/transcript-follow.spec.ts`（`:1739 warmClientStartup` 与其有界 reload 探针）、`e2e/voice-dashscope-written.spec.ts`、`e2e/voice-error-messages.spec.ts`、`e2e/voice-identifier-repair.spec.ts`。`e2e/resident-running-view.spec.ts` 是这一族里下一份「只有封顶、没有守卫」的 spec —— 封顶即 `playwright.config.ts` 的 `BOOT_CEILING_MS` / `RUN_CEILING_MS`，它把红限制在 55s 内、但不给页面里的无界等待一条恢复路径。

**修法（移植既有守卫，不发明新机制）**：把家族既有的两个杠杆搬进 `e2e/resident-running-view.spec.ts` 的启动路径，覆盖该 spec 真实存在的每一次导航（今天只有 `:613` 的 `page.goto('/')`，将来新增也必须走同一入口）：

1. **有界客户端预热**（在任何页面之前，`beforeAll` 内、`browser.newPage()` 之前）：对 `baseURL` 依次取 `/`、`/src/main.tsx`、以及从 entry 文本里读出的一个本次运行当前的优化依赖 URL，直到 200；每步各自带 deadline，超时或非 200 时按 url + status 指名抛错（照 `warmClientStartup` 的形态与语义，含「客户端接了连接却不答」也要按名字失败）。
2. **有界启动探针**（该次导航之后）：用短预算探「本次导航的落点已就绪」—— 首次 boot 探夹具的项目行（`projectRow` 的落点）；未就绪就在预算内 `page.reload()` 重放，并收集 `page.on('requestfailed')` 与 console 证据；预算耗尽时**带页面文本 + 失败请求列表大声抛错**，绝不静默继续。

预热与探针留在 spec 内，不动 `playwright.config.ts`：`globalSetup` 需要一个 `e2e/*.ts` 新文件，会触发 lint 边界（与 `gap-session-filter-criterion-bounded-boot-guard` 同一条理由）。

⛔ 不变式：判据命令不改；60s 门限与 55s spec 上限不动；3 个用例的 `expect` 一字不动；不加 Playwright `retries`；不开 `reuseExistingServer: true`；不 stub、不 skip；不把 Running 分组 / 徽标 / 关闭断言搬走；不删 AC-173 原本的假形态臂（徽标计入空闲常驻 ⇒ 读数 3）。守卫只允许**重放导航**，不允许替用例下任何结论 —— 探针探不到时必须红，而且红得可读。

取假形态：把守卫写成「探不到就当已就绪继续跑」时，3 个用例会在空白页上各自等到自己的超时，整轮必然越过 60s 门限记红 —— 这就是守卫没有变成静默放行的证明。

## AC

- [x] AC1 有界客户端预热真实生效：`e2e/resident-running-view.spec.ts` 里有 `warmClientStartup`（或等价命名）的定义、与「任何页面之前」的调用，逐 URL 带 deadline，非 200 / 超时按 url 指名抛错。验证：`grep -n "warmClientStartup" e2e/resident-running-view.spec.ts` 同时命中定义行与调用行，且该 spec 的 typecheck `exit 0`。
- [x] AC2 每一次导航都走同一个有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/resident-running-view.spec.ts` 的每一处行号都落在探针函数体内部，函数体外没有任何裸导航；探针耗尽预算时抛出携带页面文本与 `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界 + typecheck `exit 0`。
- [x] AC3 有界失败的实测：把探针落点临时指向一个不可能存在的 sentinel 后，`npx playwright test e2e/resident-running-view.spec.ts` 在 **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：两次运行的 `echo $?` 与 wall time。
- [x] AC4 判据在负载下连续绿：`npx playwright test e2e/resident-running-view.spec.ts` 连续 ≥5 次全部 `exit 0`，且每一次 wall < 55_000ms（一次都不触发 55s 看门狗 / 60s 门限），其中至少一次与 ≥4 份兄弟 spec 并发。验证：逐次 `echo $?` + wall time。**如实登记**：本机负载高（实测 load1 > 30），并发那一次若兄弟 spec 自己红，须点名归因，不得算到本条头上。
- [x] AC5 判定面未变：`git diff develop -- package.json playwright.config.ts` 为空（无 `test:e2e` / `RUN_CEILING_MS` / `BOOT_CEILING_MS` / `SINGLE_SPEC_CEILING_MS` 的增删），且 `git diff develop -- e2e/resident-running-view.spec.ts | grep -c "^-.*expect("` 为 **0**。验证：两条命令的逐字输出。
- [x] AC6 AC-173 的假形态仍然红（承重）：把徽标改成计入空闲常驻会话（改回读客户端忙集 `activeSessionIds.size`，或把空闲常驻宿主也计进计数），判据命令退出**非 0**，且红**落在徽标读数那条断言**上（`badge.reading=3` / `badge.reading !== 1`）。登记变异 diff、失败断言逐字、退出码；恢复后判据回到 0。验证：变异跑与还原跑的 `echo $?`。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-173 的台账尾部不再是 CURRENTLY FALSE）。且这条绿不是「恰好那次没抖」—— AC4 的 ≥5 连绿（含一次 ≥4 份兄弟 spec 并发）的逐次 wall/exit 读数写进完成记录；AC3 的有界失败读数（探不到时 <30s 红、带页面文本与失败请求列表）以及还原后的读数一并登记；AC6 的假形态读数（徽标计入空闲常驻 ⇒ 读数 3、红在徽标断言）与还原读数一并登记。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿；3 个用例的 `expect` 一字未改由 AC5 机械证明。完成记录里必须写明：本仓修掉的是**响应方式**（无界等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`）不在本仓可控范围内 —— 因此这条判据的稳定性依赖守卫，而不是依赖触发源消失。

## Touches

- e2e/resident-running-view.spec.ts
- src/modules/sidebar/hooks/useSidebarController.ts（仅 AC6 假形态变异的临时写点，跑完还原，不进最终 diff）
- tasks/gap-resident-running-view-criterion-bounded-boot-guard.md

## 完成记录（2026-09-30）

**实现**：提交 `e963c867`（本任务分支，基于 develop `d7794b71`）。只改 `e2e/resident-running-view.spec.ts`（+238 / −4）。把家族既有两杠杆搬进启动路径：`warmClientStartup(clientUrl)`（`beforeAll` 内、`browser.newContext()/newPage()` 之前；对 `/`、`/src/main.tsx`、entry 里解析出的一个本次运行优化依赖 URL 逐 URL 带 deadline 取到 200，非 200 / 超时按 url+status 指名抛错，含「客户端接了连接却不答」）与 `navigateBounded(page, projectRowLanding, 'first-load')`（该 spec 唯一导航 `page.goto('/')` 已落进探针函数体；探到夹具项目行即返回，探不到就在 14s deadline 内 `page.reload()` 重放，耗尽则带页面文本 + `requestfailed` 列表抛错）。

**AC1** `grep -n "warmClientStartup" e2e/resident-running-view.spec.ts` → 定义 `:502`、调用 `:816`（定义行与调用行都命中）；`npm run typecheck` 退出 **0**（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）。

**AC2** `grep -n "page\.goto(\|page\.reload(" e2e/resident-running-view.spec.ts` → `:637`、`:639`，两行均落在 `navigateBounded`（`:625`–`:661`）函数体内，函数体外无裸导航。探针耗尽预算时抛出的错误逐字见 AC3。

**AC3**（有界失败实测）落点临时改为 `page.locator('[data-e2e-impossible-sentinel]')`：判据 `EXIT=1`，wall **24792ms**（< 30s），输出逐字 `Error: the project row for resident-running-view-workspace never rendered, so this run's client never came up to a document that stays: the page shows "CloudCLI\nStar\n13.9k\nProjects\nConversations\nCtrl\nK\nmobile-layout-workspace\n1 - ...\nresident-running-view-workspace\n5 - ...running-view-workspace\n..."; console errors: <none>; failed requests: <none>`。还原（`git checkout --`）后判据 `EXIT=0`、`elapsed=48244ms`。

**AC4**（负载下连续绿；本机 load1 ≈ 30）还原后连续 6 次：`#1 EXIT=0 wall=40678ms elapsed=39636ms`、`#2 40606/39719`、`#3 40296/39419`、`#4 40735/39894`、`#5 40070/39139`、`#6 39876/38989` —— 全部 `exit 0` 且 wall < 55_000（无一看门狗 / 60s 门限）。并发一次：与 `session-filter`、`transcript-follow`、`resident-status-bar`、`resident-ui-layout` 四份兄弟 spec 同跑，**目标判据 `EXIT=0 wall=40786ms elapsed=39871ms`**。兄弟 `session-filter` / `resident-status-bar` / `resident-ui-layout` 分别 5 / 4 / 3 passed；`transcript-follow` **EXIT=1** —— **点名归因**：红是它自己的看门狗跨了单文件 55s 上限（`this run crossed its own 55000ms ceiling at 55000ms … stuck at stage "browser-launch-or-cases"`），且**无并发单独跑同样 `EXIT=1 wall=55662ms` 跨 55s 上限**；该文件不在本任务 Touches、本任务 diff 未触及，属宿主负载下的既有红，不计入本条。

**AC5** `git diff develop -- package.json playwright.config.ts` → 空；`git diff develop -- e2e/resident-running-view.spec.ts | grep -c "^-.*expect("` → **0**。`git diff --stat develop` → 仅 `e2e/resident-running-view.spec.ts | 238 +++++-`（1 file，+238 −4）。

**AC6**（承重假形态，逐字复现 AC-173 的变异）：
```
-import { listRunningSessionIds, useSessionHosts } from '@/shared/hooks/useSessionHosts';
+import { listResidentIdleSessionIds, listRunningSessionIds, useSessionHosts } from '@/shared/hooks/useSessionHosts';
   const runningSessionsCount = useMemo(
-    () => listRunningSessionIds(sessionHostsSnapshot).length,
+    () => listRunningSessionIds(sessionHostsSnapshot).length + listResidentIdleSessionIds(sessionHostsSnapshot).length,
     [sessionHostsSnapshot],
   );
```
判据 `EXIT=1`（wall 14919ms），红**落在徽标读数断言**上，逐字 `Error: the badge counts the sessions with a turn in flight` / `Expected: 1` / `Received: 3`（`e2e/resident-running-view.spec.ts:932`），同跑打印 `hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=3`。还原后判据回到 `EXIT=0`。

**守卫自身的原始输出行**：`[e2e] client warm-up: pre-bundle committed in 1386ms`；`[e2e] client startup: the project row for resident-running-view-workspace landed after 3480ms (attempt 1)`。

**本仓修的是响应方式**：无界等待（`revealSession` 的 30s `waitFor`）→ 有界重放（预热 + 探针 + `page.reload()`）。触发源（宿主层 `net::ERR_NETWORK_CHANGED`，本机 docker/veth 变动）不在本仓可控范围内 —— 因此这条判据的稳定性依赖守卫，而不是依赖触发源消失。