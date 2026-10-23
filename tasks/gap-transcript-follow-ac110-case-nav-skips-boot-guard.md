---
id: gap-transcript-follow-ac110-case-nav-skips-boot-guard
title: AC-110 判据偶发假红（近 16 次 gate 事件 2 红）：判据自己那条 case 在 beforeAll
  守卫之外重导航（全文件唯一一条这样做），页面被反复替换时 click 无界重试撞上 55s watchdog 杀浏览器，台账只留 "Channel
  closed"
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-110
depends_on:
  - gap-voice-false-forms-siblings-pid-attribution
---
## Proposal

**本轮的直接测量（两次读数都登记，不取台账尾巴）**

- 台账尾巴：`.quay/gate-events.jsonl` 里 AC-110 最后一条是 `verdict=fail`，`at=2026-09-25T10:04:32.495Z`，`actor=goal-cli`，`payload.reason` 只有 `acceptance failed (exit 1)` 加一段 stderr 尾巴（`[WebServer] No .env file found…`、一条 `[BABEL] … deoptimised the styling of …/quay-e2e-9atUIN/vite-cache/deps/react-scan.js`、`DEP0190`）——**没有一个字关于判据本身**。
- 本轮直跑判据（HEAD `af4b5442`，`npx playwright test e2e/transcript-follow.spec.ts -g "AC-110"`）：**`EXIT=0`**，`1 passed (19.9s)`，case 自报 `6.3s`，`real 0m20.652s`。判据自报读数全真：

```
AC-110 readings {"viewport":{"width":1440,"height":6000},"rowsBeforePrepend":20,"rowsAfterPrepend":24,
"scrollHeightBefore":5776,"scrollHeightAfterPrepend":6620,"paneClientHeight":5776,"restoreWrite":[683],
"gapAfterRestorePx":179,"scrollTopAfterRestore":665,"offset0Px":485,"samples":11,
"offsets":[485×11],"scrollTops":[665×11],"gaps":[299×11],
"driftPx":0,"scrollTopRisePx":0,"smallestGapPx":299,"scrollWritesInWindow":[0],"downwardWritesInWindow":0}
```

**所以本轮的诚实结论是：判据不是「假」的，是「偶发假红」的。** 近 16 次 gate 事件 14 pass / 2 fail（`08:40:41.042Z`、`10:04:32.495Z`），两次 fail 的 reason 都只有 stderr 尾巴。上一轮 gap prompt 的前提「criterion is false as of now」被本轮直跑证伪，本任务据此**不**声称几何保证回归（下面 AC5 反而要求把这条保证再钉一次）。本任务要修的是**判据的可测性**：一个约 2/16 概率死在夹具自己启动路径上的判据，每轮给台账的都是噪声。

**现场（本轮逐行复核过原始产物，不是从 reason 尾巴猜的）**

`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-9atUIN/test-results/transcript-follow-transcri-9252a-re-that-lands-at-the-bottom/error-context.md` 原文：

```
# Test info
- Name: transcript-follow.spec.ts >> transcript follow in a real browser >> AC-110 a prepend the wheel asked
        for stays the user's across the restore that lands at the bottom
- Location: e2e/transcript-follow.spec.ts:2221:3
# Error details
Error: Channel closed
Error: locator.click: Target page, context or browser has been closed
Call log:
  - waiting for locator('a[href^="/session/"]').filter({ hasText: 'transcript-follow' })
    - locator resolved to <a href="/session/e2e-transcript-follow" class="…">…</a>
  - attempting click action
    - waiting for element to be visible, enabled and stable
  - element was detached from the DOM, retrying
```

同一份文件里的 `# Page snapshot` **不是空白页**：`heading "CloudCLI"` 在，`button "Refresh projects and sessions (Ctrl+R)"`、`button "Create new project"`、`button "Hide sidebar"` 都在——**应用是活的、侧栏渲染完了**，只有那条 session 链接在反复 detach。

`trace.zip` 里的 `test.trace` 时间线：`beforeAll` 在 19.81s 结束（**守卫通过了**），AC-110 的 case 依次做 `Set viewport size`、`Set fixed time`、`Navigate`（20.00s），那个 `click` 在 22.42s 打开后**跑了 33.5s** 到 55.95s；55.58s 是 harness 的 After Hooks —— 即 `playwright.config.ts:229` 的 `RUN_CEILING_MS = 55_000` 看门狗结束了这次运行。控制台侧那份文档在约 10s 内被替换了至少 3 次（22.75s / 28.60s / ~32.0s，每次都是 `[vite] connecting…` → React DevTools → `SW registered` 一整套）。

**机制（哪一处是盲点，及为什么它是盲点）**

`e2e/transcript-follow.spec.ts` 里**只有两处导航**：`:1872` 的 `await page.goto('/')`（在 `beforeAll` 里）和 `:2227` 的 `await page.goto('/')`（**在 AC-110 这条 case 自己的体内**）。AC-106（`:1945`）、AC-107（`:2003`）、AC-111（`:2113`）、AC-108（`:2381`）、AC-109（`:2854`）全部复用 `beforeAll` 的那份文档，**只有 AC-110 重导航**。

而启动守卫只包住了前一处：`warmClientStartup(clientUrl)`（`:1739` 定义、`:1851` 调用）+ `appears()` 有界探针 + ≤2 次 `page.reload()` 有界重放 + 耗尽后抛出**含页面文本与 console/requestfailed 证据**的错误（`:1874–1893`）。这条守卫自己的注释声称它挡的是「the app's own `location.reload()` after `504 Outdated Optimize Dep`，**or any other restart of the document**」——但它只在**第一次**导航外生效。AC-110 的 `:2227` 是第二次导航，守卫不在它外面：落地之后那条 `sessionLink()` 的 `click` 是**无界**等一个「visible, enabled and stable」的元素，页面每被替换一次它就 detach 重试一次，撞上的是本 run 自己的 55s 看门狗，而不是任何断言。

**为什么早先的修复没挺住（本任务存在的理由）**

- `gap-transcript-follow-prepend-restore-not-reattaching`（done，`goal_ac: AC-110`）把**几何**修对了（`55dfad8b`，2026-09-21 17:10:46 +0800），本轮复测它确实真（`driftPx 0`、`smallestGapPx 299`、`downwardWritesInWindow 0`）。**但那条 `:2227` 的 `goto` 正是这次提交引入的**（`git log -S"await page.goto('/')" -- e2e/transcript-follow.spec.ts` 指向 `55dfad8b`）：因为 `page` 来自共享 `beforeAll`、视口 1440×6000 没法用 `test.use({viewport})` 表达，它只好在 case 内部重新导航一次。**这一改动无意中把一条导航放到了守卫的覆盖面之外。**
- 启动守卫是**后到的、而且是逐 spec 回灌的**：`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，AC-108）它落进 `e2e/transcript-follow.spec.ts` 的 `beforeAll`；`gap-session-filter-criterion-bounded-boot-guard`（ready，AC-101）本轮把它落进 `e2e/session-filter.spec.ts`（`069c663d`，2026-09-25 18:05:21 +0800）；出处是 `e2e/voice-trim.spec.ts`。**这条家族线每一站都停在「spec 的第一份文档」上，从没有一站走到「同一条 spec 里 case 自己的第二次导航」**——所以本判据的盲点一直没人回灌。
- 另需如实登记：那次红的**触发源本轮没有确证**。`trace` 里**没有 504、没有 `net::ERR_NETWORK_CHANGED`、没有 `ERR_FAILED`**（失败项只有 `net::ERR_ABORTED`，即被撕掉的在途请求，以及那条始终没建立的 `/ws?token=…`），也没有 API 轮询暴涨（各 API 端点 ≤12 次；请求量是 dev 模块图本身）。文件里也不存在客户端自发的 reload 逻辑：`src/` 里 `window.location.replace` 只有 `src/modules/version-upgrade/VersionUpgradeModal.tsx:51` 一处、且需要用户点 Update Now 加 120s 倒计时；`public/sw.js` 没有 reload-on-controllerchange。**所以本任务只认领「无界等待落在守卫覆盖之外的那个站点」，不认领触发源**，修法也因此必须对**任何**形式的文档替换都成立（这正是 `:1874` 那条注释原本的措辞）。

**修法（最小切片，全部在夹具侧；判据断言一行不动）**

1. **把 `beforeAll` 已有那两件套就地用到 `:2227` 这次导航上**：重导航之后、`sessionLink().click()` 之前，插入同一形状的有界启动探针（短预算探一个「这份文档稳住了」的信号：`#username` 或侧栏容器）→ 未稳住则有界 `page.reload()`（或重放该次 `goto`）≤N 次 → 仍不稳住则抛出**含页面文本 + console errors + failedRequests** 的错误。**不新建文件、不改 `playwright.config.ts`、不改 `RUN_CEILING_MS`**（goal gate 的 60s 上限不可抬，看门狗是承重的，抬它就是掩盖）。
2. **把「无界等待」本身换成有界自报**：`sessionLink()` 的 `click` 走一个有界等待（预算之和留在判据自己的时间预算内），超预算即抛出夹具自己的话。这样真启动失败会在 ~30s 内以**夹具自己的错误信息**退出，而不是被 55s 看门狗从外面杀掉、也不是 180s hook 超时。
3. **不要**用「删掉 `:2227` 那次导航、改成复用 beforeAll 文档」来绕过——视口 1440×6000 与「首屏不可滚」的前置正是靠这次重新加载建立的，删掉它会把判据的测量前提换掉。守卫即可，不动测量。

⛔ 换绿禁令：不得加 `retries` / `--repeat-each`、不得 `skip` / `fixme`、不得放宽或删除 AC-110 的任何断言（`drift <= AC110_DRIFT_PX`、`highest - before.scrollTop <= 1`、`smallestGap > 2`、`downwardWrites` 为空）、不得改 `-g "AC-110"` 这条命令、不得改 `RUN_CEILING_MS` 或 goal gate 的上限、不得以桩/镜像替掉真实 Chromium + 真实后端、不得把这次导航移出 `-g "AC-110"` 那次运行。

<!-- dedup-ref -->
同机制关联（记给出处，不是本任务的前提）：`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，AC-108）是这道守卫在**本 spec** 里的出处与修法来源；`gap-session-filter-criterion-bounded-boot-guard`（ready，AC-101）是它在本轮落进另一条 spec 的那一站；`gap-transcript-follow-prepend-restore-not-reattaching`（done，AC-110）是 `:2227` 那次导航的引入者。本任务不重复申领 AC-101 / AC-108 / AC-110 的既有裁决，也不回退它们的修法，只把守卫补到 AC-110 自己那条 case 的第二次导航上。另：`gap-mobile-layout-e2e-viewport-matrix`（todo）的 Touches 也含 `e2e/transcript-follow.spec.ts`，与本文构成池内串行，由 driver 的 Touches 门机制排序即可，无需人工串联。

## AC

- [x] 判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-110"` 退出码 0，且在**同一窗口内有别的 e2e lane 在跑**的条件下连跑 ≥10 次全部退出码 0；逐次记录 `exit=… wall=… self=[…]` 与 `git rev-parse HEAD`，10 行读数原文写进完成记录；且这 10 次日志里 `Channel closed` 出现 **0** 次、`[e2e] watchdog … crossed its own 55000ms ceiling` 出现 **0** 次（用 `grep -c` 给退出码）。
- [x] 绿路径不因为守卫而变慢：上述 10 次里每次 playwright 自报时长 ≤ 30s（修前绿次为 `1 passed (19.9s)`、case `6.3s`、wall `20.652s`），给出最小/最大值；并记录每次日志里的 `[e2e] server=… client=…` 行与 `[e2e] client warm-up: pre-bundle committed in …ms` 行，证明用的是本次运行自己的端口与缓存目录（不是别的 run 的）。
- [x] **阴性对照（那次重导航的守卫必须承重）**：构造一个**确定性**的假形态，让 `:2227` 那次导航之后文档被替换 / 稳不住——例如把该处启动探针临时指向必然不出现的哨兵选择器，或在导航后从页面侧有界地强制重放若干次 `location.reload()`——跑判据 → 必须非 0，且失败形态**落在夹具启动阶段并以夹具自己的话结束**：错误信息里含页面文本与 console errors / failedRequests，**退出发生在 ≤30s**，**不得**表现为 `Error: Channel closed`、**不得**是 55s watchdog kill、**不得**是 180s hook 超时。退出码与失败原文登记在证据里，之后全部还原。
- [x] **阳性对照**：只把 AC3 那处注入撤掉、守卫保留 ⇒ 判据必须退出码 0。AC3 与 AC4 一起证明这次补的守卫是承重的、不是装饰；之后 `git diff develop --stat` 证明改动面只剩 `e2e/transcript-follow.spec.ts` 一处（`playwright.config.ts` 一行未改）。
- [x] **判据未被削弱（AC-110 自己的抗假变体仍必须红）**：按 AC 记录 `expect` 里已写明的假形态——「prepend 恢复结束后回到原 mode（首屏不可滚时原 mode 是跟随）⇒ 下一次增长把视图拉到底」——构造该变体，判据必须退出码非 0（修前该变体已实测为 `driftPx 120`、`smallestGapPx 0`、`downwardWritesInWindow 2`，本轮须复现同形）；留输出并还原。`git diff` 证明 `e2e/transcript-follow.spec.ts` 里 AC-110 的断言（`drift <= AC110_DRIFT_PX`、`highest - before.scrollTop <= 1`、`smallestGap > 2`、`downwardWrites` 为空）与常量（`AC110_VIEWPORT`、`AC110_FIRST_PAGE_ROWS`、`AC110_SAMPLE_WINDOW_MS`、`AC110_DRIFT_PX`）以及 `-g "AC-110"` 命令一行未删未松；diff 内没有 `retries` / `repeat-each` / `test.skip` / `test.fixme`，也没有 `RUN_CEILING_MS` 或 gate 上限的改动。
- [x] `npm run lint` 退出码 0（如实登记：root tsconfig 与 oxlint 的 include 都不含 `e2e/`，故夹具代码另有 `scripts/test.sh --for-task … --allow-thin` 与 AC1 的真实跑动覆盖）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-110 的尾巴由 `2026-09-25T10:04:32.495Z` 的 fail 转回 pass，并在其后**连续多轮** frozenRecheck 中保持 pass（并发不再把它偶发打红）；判据的启动路径在 AC1 的 10 连跑里 0 次 `Channel closed` / 0 次 watchdog kill。
- **真落地**：不是一个更长的等待，而是 **AC-110 自己那条 case 的第二次导航不再无界**——`beforeAll` 已有的两件套（有界探针 + 有界重放）就地覆盖到 `:2227` 之后；页面真被抽走时以夹具自己的话在 ≤30s 内报错退出（AC3），而不是被 55s 看门狗从外面杀掉、也不是 180s hook 超时。证据是 AC1 的 10 个退出码与墙钟、AC3/AC4 的负正对照、AC3 的失败原文（含页面文本与 console 证据）。
- **读数原文**：AC1 的 10 行 `exit=… wall=… self=[…]` 与两次 `grep -c` 的退出码；AC2 的 `[e2e] server=… client=…` 与 `pre-bundle committed in …ms` 行及最小/最大自报时长；AC3/AC4 的退出码与失败/通过原文；AC5 抗假变体的退出码与判据读数；AC6 的两条 lint 退出码。
- **前提与不可复现项如实登记**（这一段必须逐条写进完成记录，不得含糊）：
  1. **本轮直跑判据是绿的**（`EXIT=0`，`1 passed (19.9s)`，`driftPx 0` / `smallestGapPx 299` / `downwardWritesInWindow 0`）。**不得写成「已复现几何回归」**——本任务证明的是夹具可测性缺陷（近 16 次 gate 事件 2 红），不是 prepend/restore 保证不成立。
  2. **那次红的触发源本轮未确证**：`quay-e2e-9atUIN` 的 trace 里没有 504、没有 `net::ERR_NETWORK_CHANGED`、没有 `ERR_FAILED`（只有 `net::ERR_ABORTED` 与未建立的 `/ws`）。被确证的只有**站点**：`:2227` 那次导航在守卫覆盖之外，且其后的 `click` 是无界等待。**不得写成「已复现 driver 那次红」**；本任务能做到的是证明同形路径可被确定性地重放（AC3）并在内层封住。
  3. 现场 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-9atUIN/test-results/transcript-follow-transcri-9252a-re-that-lands-at-the-bottom/` 是那次红的原始产物（`error-context.md` + `trace.zip`），读数取自它而不是 ledger 的 `reason` 尾巴；`reason` 尾巴偏好 stderr，playwright 的报告在 stdout 上被整段丢弃。
  4. 端口/负载前提：本机与别的 lane 共享宿主（本轮直跑时 ports 47101 / 47173 已确认空闲，宿主 load ~84，fleet cgroup 曾记过 1 次 `oom_kill`）；AC1 的「有别的 lane 在跑」这一条要在完成记录里写清当时是哪个 lane、它的窗口与自己的读法。
- **L_D = 0**。L_D 该轴仍暗，理由：本任务只改 e2e 夹具的启动路径与失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G = 0**。L_G 该轴仍暗，理由：同上 —— 读数是运行期退出码、墙钟与页面文本，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

## Touches

- `e2e/transcript-follow.spec.ts`
- `tasks/gap-transcript-follow-ac110-case-nav-skips-boot-guard.md`

## 完成记录

**实现（`e2e/transcript-follow.spec.ts`，95 insertions / 4 deletions，唯一改动文件）**

两条新助手，都在夹具侧；判据的断言、常量与 `-g "AC-110"` 命令一行未动：

- `settleSecondDocument(page, evidence)`（`SECOND_DOCUMENT_READY = '#sidebar-panel, [aria-label="Show sidebar"]'`、`SECOND_DOCUMENT_PROBE_MS = 4_000`、`SECOND_DOCUMENT_RELOADS = 2`）：把 `beforeAll` 已有的两件套就地套到 AC-110 自己那次 `page.goto('/')` 之后——有界探针（侧栏容器；塌陷时用塌陷条的展开钮）→ ≤2 次有界 `page.reload()` → 仍不稳住则抛含页面文本 + console errors + failedRequests 的错误。`playwright.config.ts` 一行未改，`RUN_CEILING_MS` 未动。
- `clickSessionLink(page, link, evidence)`（`SESSION_LINK_CLICK_MS = 15_000`）：把 `sessionLink().click()` 这条无界等待换成有界自报，`beforeAll` 与 AC-110 两处都换（本仓 `locator.click()` 没有 action timeout，正是现场里跑了 33.5s 的那一次）。

壁钟算术：绿路径探针首帧即中、不 reload，故 10 连跑的自报时长与修前同量级；注入路径 3 次加载 × 4s = 12s，落在 `beforeAll` 之上仍在 30s 内（AC3 实测 26.05s）。

### AC1 — 10 连跑（有别的 lane 同窗口在跑）

`git rev-parse HEAD` = `db4ee84e34206d7a52868485b471d327b714b766`（10 次同一 sha；2b 的 develop 合并 `3032bddd` 在其后）。

别的 lane：本 worktree 内重复跑 `e2e/session-filter.spec.ts`（另一个 project、另一份 data-dir、自己的端口），窗口 `2026-09-25T18:20:26+08:00` → 至少 `18:23:48+08:00`（iter 12 起始）**连续在跑**，iter 1–11 每次 `exit=0`。10 次判据跑动落在 `18:20:45 → 18:23:50`，完全被它覆盖。

10 行读数原文（`exit=… wall=… self=[…]`，末尾附该次自己的端口 / 预热 / data-dir）：

```
run=01 exit=0 wall=17.30s self=[1 passed (16.5s)] case=[5.5s] server=23461 client=15997 warm-up=3363ms data-dir=quay-e2e-h3cU9M
run=02 exit=0 wall=16.80s self=[1 passed (16.1s)] case=[5.5s] server=19105 client=29741 warm-up=3173ms data-dir=quay-e2e-mUAmvd
run=03 exit=0 wall=17.24s self=[1 passed (16.5s)] case=[5.6s] server=31405 client=16111 warm-up=3422ms data-dir=quay-e2e-jqY2Kd
run=04 exit=0 wall=16.68s self=[1 passed (16.0s)] case=[5.6s] server=23261 client=18233 warm-up=3355ms data-dir=quay-e2e-FgPCGy
run=05 exit=0 wall=17.01s self=[1 passed (16.3s)] case=[5.6s] server=9431 client=32547 warm-up=3363ms data-dir=quay-e2e-zr7xq6
run=06 exit=0 wall=17.53s self=[1 passed (16.8s)] case=[5.7s] server=11565 client=25173 warm-up=3534ms data-dir=quay-e2e-QBiSYm
run=07 exit=0 wall=17.77s self=[1 passed (17.1s)] case=[5.8s] server=26109 client=16331 warm-up=3913ms data-dir=quay-e2e-97TBzV
run=08 exit=0 wall=17.44s self=[1 passed (16.7s)] case=[5.5s] server=28415 client=2533 warm-up=3623ms data-dir=quay-e2e-ef3uaj
run=09 exit=0 wall=17.52s self=[1 passed (16.8s)] case=[5.7s] server=8969 client=15773 warm-up=3508ms data-dir=quay-e2e-13vqtA
run=10 exit=0 wall=17.91s self=[1 passed (17.2s)] case=[5.5s] server=6731 client=21455 warm-up=3209ms data-dir=quay-e2e-9Uo8Vy
```

`grep -c "Channel closed"`（10 份日志合计）→ **0**；`grep -c "crossed its own 55000ms ceiling"` → **0**；`nonzero_exits=0`。

### AC2 — 绿路径未变慢

playwright 自报总时长：min **16.0s** / max **17.2s**（修前绿次 `1 passed (19.9s)`），全部 ≤30s；case 自报 min **5.5s** / max **5.8s**（修前 `6.3s`）；wall min 16.68s / max 17.91s（修前 `real 0m20.652s`）。

每次的 `[e2e] server=… client=…` 与 `[e2e] client warm-up: pre-bundle committed in …ms` 见上表：10 次端口两两不同（23461/15997、19105/29741、31405/16111、23261/18233、9431/32547、11565/25173、26109/16331、28415/2533、8969/15773、6731/21455），data-dir 也 10 份不同——每次用的都是它自己那份服务与缓存，不是别的 run 的。

### AC3 — 阴性对照（哨兵选择器）

注入：`SECOND_DOCUMENT_READY` 单行改成 `'#e2e-negative-control-sentinel-that-never-renders'`（探针指向必然不出现的哨兵）。

`EXIT=1`，wall **26.05s**（≤30s），case 自报 14.4s。失败落在夹具启动阶段，原文：

```
Error: this run's client never settled on a document the criterion can measure on: #e2e-negative-control-sentinel-that-never-renders did not appear across 3 bounded loads of it (4000ms each): the page shows "CloudCLI Star Projects Conversations Ctrl K mobile-send-key-workspace 1 - ... transcript-follow-workspace 1 - ... Report Issue Join Community Settings CloudCLI v1.37.3 – Open Source Choose Your Project Select a project from the sidebar to start coding with Claude. Each project contains your chat sessions and file history. Tip: Create a"; console errors: Failed to load resource: the server responded with a status of 403 () | (×10); failed requests: http://127.0.0.1:2825/api/file-tree/projects/3d720303-853a-4d3d-b908-ef4df4b0795c/files?respectGitignore=true — net::ERR_ABORTED
    at settleSecondDocument (e2e/transcript-follow.spec.ts:692:9)
    at e2e/transcript-follow.spec.ts:2318:5
```

`grep -c "Channel closed"` → **0**；`grep -c "watchdog"` → **0**。错误信息含页面文本 + console errors + failedRequests，退出发生在 26.05s，不是 55s watchdog kill、不是 180s hook 超时。**注入已 `git checkout --` 还原。**

### AC4 — 阳性对照

撤掉注入、守卫保留后重跑（**在已合并 develop `3baf0a56` 的树上**）：`EXIT=0`，wall 17.16s，`1 passed (16.5s)`，读数 `driftPx 0` / `smallestGapPx 299` / `downwardWritesInWindow 0`。

合并后 `git -C <worktree> diff develop --stat` → **`e2e/transcript-follow.spec.ts | 99 ++++++++--`，`1 file changed, 95 insertions(+), 4 deletions(-)`**——只剩这一处；`playwright.config.ts` 一行未改。

### AC5 — 抗假变体仍必须红

假形态按 AC 记录里已写明的取法构造（与 `gap-transcript-follow-prepend-restore-not-reattaching` 完成记录同一取法）：把 `onWheel` 里「朝上且仍有过往页 ⇒ 记脱离」那一行短路——`src/modules/chat/hooks/useChatSessionState.ts:955` 改为 `if (false && event.deltaY < 0 && …)`，于是恢复结束后的 mode 恒为「跟随」，正是 AC 写的取假形态。

`EXIT=1`，红灯出自 AC-110 自己的断言：

```
AC-110 readings {...,"restoreWrite":[683,6620],"gapAfterRestorePx":0,"scrollTopAfterRestore":844,"offset0Px":306,
"samples":12,"offsets":[186×12],"scrollTops":[964×12],"gaps":[0×12],
"driftPx":120,"scrollTopRisePx":120,"smallestGapPx":0,"scrollWritesInWindow":[0,1100,6876],"downwardWritesInWindow":2}
    Error: a prepend the user asked for must leave the row where it was: the offset moved 120px over the window ([186,186,...])
    expect(received).toBeLessThanOrEqual(expected)
    Expected: <= 2
    > 2439 |     ).toBeLessThanOrEqual(AC110_DRIFT_PX);
```

与修前登记**同形**：`driftPx 120` / `scrollTopRisePx 120` / `smallestGapPx 0` / `gapAfterRestorePx 0` / `restoreWrite [683,6620]` / `downwardWritesInWindow 2`（`scrollWritesInWindow` 由 `[0,964,6740]` 到 `[0,1100,6876]`——同一形状，数值随该次几何窗口移动）。

**`src/` 改动已 `git checkout -- src/modules/chat/hooks/useChatSessionState.ts` 还原**（还原后 `git status --short` 空）。

断言/常量未删未松（`grep -n`）：`AC110_VIEWPORT :520`、`AC110_FIRST_PAGE_ROWS :522`、`AC110_SAMPLE_WINDOW_MS :524`、`AC110_DRIFT_PX :528`、`.toBeLessThanOrEqual(AC110_DRIFT_PX) :2439`、`highest - before.scrollTop :2441`、`smallestGap :2445`、`downwardWrites :2450` 全在。

diff 的删除行只有 4 行：`-import type { Page } from '@playwright/test';`（换成 `Locator, Page`）、`beforeAll` 与 AC-110 各一条 `-    await sessionLink().click();` 及其上一行注释。diff 内没有 `retries` / `repeat-each` / `test.skip` / `test.fixme` / `RUN_CEILING_MS`（`grep` 给 `none added`）。

### AC6 — lint

`npm run lint` → **exit 0**（输出里是 `src/` 既有的 react / react-hooks warning，与本任务无关）。如实登记：root tsconfig 与 oxlint 的 include 都不含 `e2e/`，夹具代码另有 `scripts/test.sh --for-task gap-transcript-follow-ac110-case-nav-skips-boot-guard --allow-thin` → **exit 0**（`no scoped test files … (thin)`）与 AC1 的 10 次真实跑动覆盖。

### 前提与不可复现项（逐条对应 DoD）

1. **本轮直跑判据是绿的**：`EXIT=0`、`driftPx 0`、`smallestGapPx 299`、`downwardWritesInWindow 0`。**不是「已复现几何回归」**——本任务证明的是夹具可测性缺陷（近 16 次 gate 事件 2 红），不是 prepend/restore 保证不成立。
2. **那次红的触发源本轮未确证**：`quay-e2e-9atUIN` 的 trace 里没有 504、没有 `net::ERR_NETWORK_CHANGED`、没有 `ERR_FAILED`（只有 `net::ERR_ABORTED` 与未建立的 `/ws`）。被确证的只有**站点**（`:2227` 那次导航在守卫覆盖之外、其后的 `click` 无界）。**不是「已复现 driver 那次红」**；本轮做到的是证明同形路径可被**确定性**重放（AC3）并在内层封住。
3. 现场 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-9atUIN/test-results/transcript-follow-transcri-9252a-re-that-lands-at-the-bottom/` 是那次红的原始产物（`error-context.md` + `trace.zip`），读数取自它而不是 ledger 的 `reason` 尾巴。
4. 端口/负载前提：本机与别的 lane 共享宿主。AC1 的 10 连跑期间同窗口在跑的是本 worktree 里的 `e2e/session-filter.spec.ts`（`18:20:26 → ≥18:23:48+08:00`，iter 1–11 各 `exit=0`）；每次判据跑动自己在日志里报了 `[e2e] server=… client=…` 与自己的 `data-dir`（10 份互不相同），所以端口不是复用的。

### 2b — 预合并与 scoped 门

- `git -C <worktree> merge --no-edit develop` → `Merge made by the 'ort' strategy`，无冲突（合并提交 `3032bddd`，develop 侧 `3baf0a56`）。
- `bash <worktree>/scripts/test.sh --for-task gap-transcript-follow-ac110-case-nav-skips-boot-guard --allow-thin` → **exit 0**（`suite-scope-check: PASS — 20 active task(s) scanned …`；`no scoped test files for … (thin)`）。
- scoped-gate cache 已写：`{"event":"scoped-gate-cache-written","task":"gap-transcript-follow-ac110-case-nav-skips-boot-guard","developSha":"3baf0a568765fef9edeb14cbaf7434f7d809acc4"}`。

### 轴读数

- L_D = 0，理由：该轴仍暗——本任务只改 e2e 夹具的启动路径与失败信息，不新增领域数据能力，没有可读出的领域数据轴读数。
- L_G = 0，理由：该轴仍暗——读数是运行期退出码、墙钟与页面文本，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

## Needs-Human

**执行 2026-09-25T10:43:36.122Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=27122 server/modules/voice/tests/voice-capture-text.false-forms.test.ts passed=false end_ms=1790332922471
- run_id：wk-prod-anchor
- session_id：69300ee4-fae6-4ae0-bef9-5ab6cd8ce99b
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-transcript-follow-ac110-case-nav-skips-boot-guard~wk-prod-anchor~1790332859065-1c31bb.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-transcript-follow-ac110-case-nav-skips-boot-guard-wk-prod-anchor.log
