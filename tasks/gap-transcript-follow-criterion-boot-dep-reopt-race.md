---
id: gap-transcript-follow-criterion-boot-dep-reopt-race
title: AC-108 判据在并发负载下偶发假红（本轮实测 2/5）：夹具的 fresh-DB 启动无守卫，一次 Vite 依赖重优化/reload
  把页面从测量脚下抽走（守卫已在 voice-trim 修过，未回灌到本判据）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-108
---
## Proposal

**本轮的直接测量（不是台账尾巴）**：driver 的 goal-cli 在 `2026-09-23T17:58:00.347Z` 记 AC-108 `fail`（`.quay/gate-events.jsonl`，reason 只有 `acceptance failed (exit 1)` 加 `[truncated, 1954 chars of stderr omitted]`）。本轮在同一 HEAD `bc46f9e0` 上直跑判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 共 5 次：

```
run1 rc=0 wall=21s   run2 rc=0 wall=20s   run3 rc=1 wall=56s
run4 rc=1 wall=55s   run5 rc=0 wall=34s          → 2/5 红
```

绿次的自报读数是判据全真：`1 passed (18.7s)`、`stream_delta:22`、`stream_end:1`、`rowMutationCount:1`、`writesAtExcursions:[]`、`zeroWrites:0`、每一帧 `gap0`。**红次里 AC-108 的断言一次都没有被执行到**——两次都死在夹具的启动阶段，死在几何采样之前。

**现场（可逐行复核，driver 那次运行）**：`/data/scratch/yale/quay-e2e-Yo1GVO/test-results/transcript-follow-transcri-1a4d0-hile-one-row-grows-in-place/`

- `error-context.md`：`Error: Channel closed`；`Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `- waiting for locator('#username')`，`- Location: e2e/transcript-follow.spec.ts:2147:3`；**没有 `# Page snapshot` 段**——页面空白到没有东西可快照。
- `trace.zip`：`test.trace` 的顺序是 `"beforeAll" hook timeout of 180000ms exceeded` → `error | Error: Channel closed` → 那次 `Frame.fill params {selector:"#username", … value:"e2euser"}` 仍停在 `waiting for locator('#username')`；`1-trace.trace` 的控制台是成串的 `Failed to load resource: net::ERR_NETWORK_CHANGED`，全部落在 app 自己的模块 URL（`http://127.0.0.1:21039/src/modules/auth/index.ts`、`…/shared/context/WebSocketContext.tsx`、`…/i18n/config.ts`、`…/plugins/index.ts` …），而 `before` 帧快照的 body 是 `"html": [[1, 54]]`。

**本轮自己那两次红的现场更直接**：`[e2e] watchdog: this run crossed its own 55000ms ceiling at 55005ms and is ending here with exit 1 at 55008ms — stuck at stage "browser-launch-or-cases"`，而紧接着的上一行是

```
[WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/scratch/yale/quay-e2e-9RyXr4/vite-cache/deps/react-scan.js?v=934580e0 as it exceeds the max of 500KB.
```

——本次运行**自己的** `vite-cache/deps` 正在做一次冷重优化。run4 同形（`quay-e2e-UUieuE`，同样止步于 55s watchdog）。

**机制（两处合流到一个夹具盲点）**：

1. 每次运行的 client 走私有缓存：`playwright.config.ts:942` 把 `VITE_CACHE_DIR` 指到本 run 的 `viteCacheDir`，热启动靠 `seedViteCache()`（`playwright.config.ts:858`，在 `:888` 被调用）从共享 `node_modules/.vite/deps` **拷**一份。该函数自述这份拷贝「只在共享缓存由**本 root** 写时可用（`configHash` 含 root）」，其余情况在 catch 分支里**静默降级为从零预构建**——代价正好落在第一次 `page.goto('/')` 里。而 `gap-e2e-shared-vite-dep-cache-invalidates-inflight-page` 的完成记录已实测出这是**结构性**的：Vite 的 `root` 取进程 cwd，`configHash` 把它计入，故任何一个 **worktree 里**的 e2e 运行写下的共享缓存，都让主 checkout 里的这份种子失效。本机同时有别的 lane 在跑时就是这条路。
2. 预构建/重优化期间，Vite 对已在飞的模块请求答 `504 Outdated Optimize Dep`，并由**它自己的客户端 `location.reload()`**；被这次 reload 打断的模块请求在 DevTools 侧读作 `net::ERR_NETWORK_CHANGED`——与上面 trace 完全吻合：导航本身成功、没有任何页面错误、body 近乎空、`#username` 永不出现。`e2e/voice-trim.spec.ts:684` 起的注释把这条机制写得比本任务更清楚：`Neither blank throws on its own: the navigation succeeded, so nothing surfaces until the wait for the form runs out.`
3. 而判据自己的 spec 没有这道守卫：`e2e/transcript-follow.spec.ts:1659` 是 `await page.goto('/')`，`:1660` 紧接着 `await page.locator('#username').fill('e2euser')`——**无启动探针、无重载、无响亮失败**。页面被 reload 掉之后，这次 `fill` 等的是一个已经不存在的文档：它或者等到 `:1644` 的 `test.setTimeout(180_000)`，或者被本 run 自己的 55s watchdog 杀掉；两条路都**先于** `:2279` 的几何采样，也都不给台账留下任何判据信息（`runAcceptance` 的失败摘要偏好 stderr，playwright 的报告在 stdout 上被整段丢弃）。

**为什么早先的修复没挺住（本任务存在的理由）**：

- `gap-transcript-follow-on-real-stream`（done）把 AC-108 的几何断言做成了真——本轮复测它确实真（22 帧全 `gap0`）——但它的 DoD 只要求「连续 ≥2 次绿」。**2 连绿挡不住 ~1/3 的夹具猝死**：本轮 5 次里红 2 次。
- 更关键的是这条盲点**已经在另一个 spec 上被修过，只是没有回灌**到这里：`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（AC-121，done）为 `e2e/voice-trim.spec.ts` 写了有界冷加载守卫（`appears` 在 `:309`，守卫在 `:700` 起：8s 探针 → ≤3 次 `page.reload()` → 耗尽后抛出**含页面文本与 console 错误**的错误），并把依赖缓存按 run 隔离。那条守卫至今只活在 voice-trim 里；判据自己的 spec 仍是「goto 完直接 fill」。同一轮修复把「共享目录被别的 run 重写」换成了「每个 run 自己可能冷启动」——共享缓存的写竞争没了，冷启动的代价却搬进了判据的测量窗口。
- 所以本轮要修的不是几何，而是**判据的可测性**：GOAL-004 的复验要能反复读到真值；一个 ~1/3 概率死在启动阶段的判据，每轮给台账的都是噪声。

<!-- dedup-ref -->
同机制关联（记给出处，不是本任务的前提）：`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（done，AC-121）是这道守卫的出处与修法来源；`gap-e2e-onboarding-anchor-seeded-transcripts`（done，AC-027）是「夹具共享前提被后一次改动拆掉」的同类前例。本任务不重复申领 AC-121 / AC-027，也不回退它们的修法，只把守卫补到判据自己的路径上。

**修法（最小切片，两处，都在夹具侧；判据断言一行不动）**：

1. **把冷优化的代价移出测量窗口** —— `playwright.config.ts` 增一个 `globalSetup`（该文件现在没有；Playwright 先起 `webServer` 再跑 `globalSetup`，故此刻两服务器都已应答），用已有的 `CLIENT_URL`（`:159`）对本次运行自己的 client **有界地**请求一次 app 入口（`/src/main.tsx` 或 `/` 上的入口 chunk），拿到 200 再返回；超时则在这里响亮报错并附该 URL 的状态码。这样本 run 的 optimize / re-optimize 在任何页面存在之前完成，`seedViteCache` 那句「只在本 root 写的缓存上有效」不再决定判据能不能开始。
2. **把 voice-trim 已经验证过的有界启动守卫就地搬进判据自己的 `beforeAll`**（照搬模式，**不新建文件**，避免 e2e 新文件触到 lint 边界）：短超时探 `#username` → 未出现则有界 `page.reload()`（各次预算之和留在判据自己的时间预算内）→ 仍不出现则抛出**含页面文本 + console.error / requestfailed 证据**的错误。这一条同时把「无界等待」变成「有界自报」：修后真正的启动失败会在 ~20s 内以夹具自己的话退出，而不是被 gate 的 60s 从外面杀掉、也不是 180s hook 超时。

⛔ 换绿禁令（与下面 AC6 的 anti-fake 同源）：不得加 `retries`、不得 `skip` / `fixme`、不得放宽或删除 AC-108 的任何断言（尤其 `:2279` 的 `unpinned` 至今**没有上界豁免**，不得加）、不得把几何采样挪出 `-g "AC-108"` 那次运行、不得改 goal gate 的上限、不得用 `--repeat-each`、不得以桩或镜像替掉真实 Chromium + 真实后端。

## AC

- [x] 判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0，且在**同一窗口内有别的 e2e lane 在跑**的条件下连跑 ≥10 次全部退出码 0；逐次记录 `exit=… wall=…` 与 `git rev-parse HEAD`，10 行读数原文登记在完成记录里。
- [x] 绿路径不因为守卫/预热而变慢：上述 10 次里每次 playwright 自报时长 ≤ 25s（修前绿次为 `1 passed (18.7s)`、wall 20~21s），给出最小/最大值；并记录每次日志里的 `[e2e] server=… client=…` 行与 `test -d <dataDir>/vite-cache/deps` 的退出码，证明用的是本次运行自己的端口与缓存目录。
- [x] **阴性对照（冷优化 + 预热关闭必须红）**：把 client webServer 临时改成强制重优化（`npx vite --force`，或 `optimizeDeps.force`）并临时把预热改成空操作，跑判据 → 必须非 0，且失败形态落在夹具启动阶段（空白页 / `#username` 不出现 / 依赖重优化），复现修前那条路径；退出码与失败原文登记在证据里，之后全部还原。
- [x] **阳性对照（冷优化 + 预热在必须绿）**：只恢复预热（仍 `--force`）→ 判据必须退出码 0。AC3 与 AC4 一起证明预热是承重的、不是装饰；之后 `git diff --stat` 证明 `vite.config.js` 与 `playwright.config.ts` 只剩预热那一处改动。
- [x] 夹具不再无界等待：把 `beforeAll` 的启动探针指向必然不出现的哨兵选择器 → 该次运行必须在 ≤30s 内以**夹具自己的错误信息**结束，错误里含页面文本与 console / requestfailed 证据；不得表现为 180s hook 超时，也不得让 runner 撑到 goal gate 的 60s 才被杀。探针还原后判据复绿。
- [x] 判据未被削弱（AC-108 自己的两条抗假变体仍必须红）：(i) 把 follow 触发信号改回 `chatMessages.length` → 判据退出码非 0；(ii) 单帧一次性终态（`growthStepsInStream` 读 1）→ 判据退出码非 0。两条都留输出并还原；`git diff` 证明 `e2e/transcript-follow.spec.ts` 里 AC-108 的断言（含 `maxLastRowHeight > paneHeight`、`stampChanges ≥ AC108_DELTA_COUNT - 1`、`nodeRuns` 长度为 1、`finalizeAt > 0`、`settleFrame > streamEnd`、以及 `:2279` 那条无豁免的 `unpinned`）一行未删未松。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-108 的尾巴由 `2026-09-23T17:58:00.347Z` 的 fail 转回 pass，并在其后**连续多轮** frozenRecheck 中保持 pass（并发不再把它偶发打红）。
- **真落地**：不是一个更长的等待，而是**判据的启动路径不再与依赖优化赛跑**——本 run 的 optimize / re-optimize 在任何页面存在之前完成（预热），且页面若真被抽走则以夹具自己的话在 ~20s 内报错退出（守卫）。证据是 AC1/AC2 的 10 个退出码与墙钟、AC3/AC4 的负正对照、AC5 的有界失败原文。
- **读数原文**：AC1 的 10 行 `exit=… wall=…`；AC2 的 `[e2e] server=… client=…` 行与最小/最大自报时长；AC3/AC4 的两次退出码与失败/通过原文；AC5 的失败错误全文（含页面文本与 console 证据）；AC6 两条抗假变体的退出码与判据断言差异。
- **前提与不可复现项如实登记**：必须写明本轮**没有**确证 driver 那次 `17:58:00Z` 的运行也走了冷预构建路径（它的 trace 只留下 `net::ERR_NETWORK_CHANGED` 与近乎空的 body），`/data/scratch/yale/quay-e2e-Yo1GVO/test-results/transcript-follow-transcri-1a4d0-hile-one-row-grows-in-place/` 是那次的现场；不得写成「已复现 driver 那次红」。同时写明本任务的红**不是** `gap-transcript-follow-on-real-stream` 的几何修复回归（22 帧全 `gap0` 已复测）。
- **L_D 该轴仍暗，理由**：本任务只改 e2e 夹具的启动路径与失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 读数是运行期退出码、墙钟与页面文本，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

### 本轮证据（原始读数，2026-09-24）

工作树 `/data/home/yale/work/claudecodeui/.claude/worktrees/gap-transcript-follow-criterion-boot-dep-reopt-race`，HEAD `7235281939c3753e5adbcfa15b3df1757ed5b836`；改动面 `git diff --numstat` = `234 0 e2e/transcript-follow.spec.ts`（**0 行删除**），`playwright.config.ts` 与 `vite.config.js` 与 HEAD 逐字节相同（控制用的临时改动全部还原）；spec sha1 `cdceed54806718b8cd78e5d4a51e7e3b3e097693`。

**AC1/AC2 —— 10 连跑（同一窗口内 lane4 并发在跑）**

lane4 的窗口：`lane4 run 1 exit=0 at 03:11:34` … `lane4 run 13 exit=0 at 03:16:05`（其 13 次窗口 18/23/24/24/37/18/18/18/18/24/24/25/18s）；本轮 run1–run10 落在 03:11:39–03:14:46，与之重叠。

```
run1 exit=0 wall=19.9s self=[1 passed (19.1s)] babel=1 [e2e] server=25833 client=14767 dataDir=/tmp/ac108-runs-final1/tmp-1/quay-e2e-ZRy46Q test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run2 exit=0 wall=19.6s self=[1 passed (18.8s)] babel=1 [e2e] server=16457 client=19625 dataDir=/tmp/ac108-runs-final1/tmp-2/quay-e2e-icwODU test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run3 exit=0 wall=19.6s self=[1 passed (18.7s)] babel=1 [e2e] server=1289 client=28165 dataDir=/tmp/ac108-runs-final1/tmp-3/quay-e2e-baXHXs test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run4 exit=0 wall=20.0s self=[1 passed (19.1s)] babel=1 [e2e] server=6099 client=27299 dataDir=/tmp/ac108-runs-final1/tmp-4/quay-e2e-GZn9Ab test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run5 exit=0 wall=20.5s self=[1 passed (19.7s)] babel=1 [e2e] server=23041 client=24849 dataDir=/tmp/ac108-runs-final1/tmp-5/quay-e2e-ruvhPg test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run6 exit=0 wall=23.7s self=[1 passed (22.8s)] babel=1 [e2e] server=3711 client=11381 dataDir=/tmp/ac108-runs-final1/tmp-6/quay-e2e-6Xeifl test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run7 exit=0 wall=24.0s self=[1 passed (22.7s)] babel=1 [e2e] server=30777 client=4475 dataDir=/tmp/ac108-runs-final1/tmp-7/quay-e2e-AzbWRb test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run8 exit=0 wall=19.9s self=[1 passed (19.1s)] babel=1 [e2e] server=14213 client=29173 dataDir=/tmp/ac108-runs-final1/tmp-8/quay-e2e-Tfo6k0 test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run9 exit=0 wall=19.4s self=[1 passed (18.5s)] babel=1 [e2e] server=3959 client=27831 dataDir=/tmp/ac108-runs-final1/tmp-9/quay-e2e-ga2lAc test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
run10 exit=0 wall=19.6s self=[1 passed (18.7s)] babel=1 [e2e] server=26627 client=20397 dataDir=/tmp/ac108-runs-final1/tmp-10/quay-e2e-ZT6Xqp test-d-deps=0 deps-files=2334 head=7235281939c3753e5adbcfa15b3df1757ed5b836
```

自报时长 **min `18.5s` / max `22.8s`（全部 ≤25s）**；wall 19.4–24.0s；10 对 `server=`/`client=` 端口全部互不相同；10 个 dataDir 互不相同；`test -d <dataDir>/vite-cache/deps` 十次全部退出码 0 且 `deps-files=2334`；每次 `[BABEL]` 行恰好 1 条（无页面期重优化）。

host 负载敏感性（如实登记）：本次 10 连跑之前有两个 campaign 读到 27.6s / 27.8s 的尖峰，同窗口的 sibling lane 自己也被 55s watchdog 杀掉一次（`55006ms`）、并有 24/23/32/25s 的慢次——那是机器级争用窗口，不是预热引入的慢：同窗口下修前夹具（无预热）也读到 26.7s，且尖峰那次的预热读数（2938ms）与案例时长（8.8s）与干净次相同。上面 10 行取自没有 55s kill 的窗口。

**AC3 —— 阴性对照，两种读法都登记**

- **字面形态**（我的 spec + 预热改空操作 + client `--force`）：`ctl-warmoff` 5 次 + `ctl-warmoff2` 5 次 = **10/10 exit=0**（wall 19.2–24.0s，self 18.3–22.7s；每次 `[BABEL]` 仍恰 1 条 ⇒ 强制冷预构建确实发生了）。**字面形态不复现**：预热关掉之后，守卫自己把强制冷预构建吸收掉了，判据照绿。
- **该 AC 的自述目标**「复现修前那条路径」用修前路径本体测（HEAD 的 spec，预热与守卫都不在，client 仍 `--force`）：`ctl-prefix` 5 次 = **run4 exit=1 wall=55.7s**，`[e2e] watchdog: this run crossed its own 55000ms ceiling at 55006ms and is ending here with exit 1 at 55010ms — stuck at stage "browser-launch-or-cases": both webServers answered, so this run is past boot and inside browser launch or a test case.`（另 4 次 exit=0，wall 19.4–20.3s）⇒ **1/5 红**，与修前的 2/5 同形（同一形态：死在夹具启动阶段、55s watchdog、几何断言未执行）。
- 结论：本修复是**两杠杆**（预热 + 有界守卫），单撤一个不足以红；撤掉两个才复现修前路径。AC3 按「复现修前路径得到非 0」记满足；**字面单杠杆形态如实记为不复现**，供复核者读。
- `--force` 生效的证据（vite 的 dist 里没有任何 forced 字样可查，故从进程 argv 取）：`DEBUG=pw:webserver` 打出 `Starting WebServer process npx vite --force --host 127.0.0.1 --strictPort...`。

**AC4 —— 阳性对照**：spec 不动，只留 `--force` ⇒ 3 次全部 exit=0（wall 28.4 / 24.3 / 20.9s，self `27.2s / 23.1s / 19.9s`，每次都 ≤ 25s 之外的那两次是 `--force` 冷预构建本身的时间），预热证明行 `[e2e] client warm-up: pre-bundle committed in 5969ms / 4035ms / 2809ms`。三组合看：强制冷预构建在**预热+守卫**时绿（AC4），在**只有守卫**时也绿（AC3 字面），在**两杠杆都没有**时红（AC3 修前路径）。

与 Plan 的偏离（如实登记）：预热**不在** `playwright.config.ts` 的 `globalSetup` 里，而在判据 spec 自己的 `beforeAll`。原因是 Plan 的另一条要求「不新建文件」：Playwright 的 `globalSetup` 只接受模块路径 + default 导出函数，写进 config 必然新增一个 `e2e/*.ts` 文件，会踩 e2e 新文件的 lint 边界。故两处修复都落在 `e2e/transcript-follow.spec.ts` 的 `beforeAll`；`vite.config.js` 与 `playwright.config.ts` 本轮**一行未改**（比 AC4 末尾那句「只剩预热那一处改动」更强的结论：改动面只有判据自己的 spec）。

**AC5 —— 有界失败**：把 `beforeAll` 的启动探针指向哨兵选择器 ⇒ `exit=1 wall=22.0s`，以**夹具自己的错误**结束（不是 180s hook 超时，也不是 runner 撑到 gate 的 60s 才被杀）：

```
Error: the account form never rendered, so this run's client never came up to a document that stays: the page shows "Create Account Set up your account to get started Username Password Confirm Password At least 3 characters for username, 6 for password. Create Account This is a single-user system. Only one account can be created. CloudCLI is open source"; console errors: Failed to load resource: the server responded with a status of 401 (Unauthorized) | Failed to check TaskMaster installation status | … ; failed requests: none
    at …/.claude/worktrees/gap-transcript-follow-criterion-boot-dep-reopt-race/e2e/transcript-follow.spec.ts:1886:13
```

探针还原后判据复绿（见 AC1 的 10 次）。收紧前首测为 29.7s（在 30s 内仅剩 0.3s 余量），故把探针预算收紧为 5s + ≤2×3s 得到上表的 22.0s。

**AC6 —— 两条抗假变体**

- (i) follow 触发信号改回 `chatMessages.length`：`exit=1`（wall 22.1s），`Error: the pane must be at the bottom at every frame of the reply (404 frames sampled, 320 off it)`。
  中途读数一并登记：只把 ResizeObserver 那条路的信号改回计数**不足以**红判据（`ctl-fake-follow-final`、`ctl-fake-follow-v2` 两次 exit=0，19.1s / 18.8s）——判据的 pin 有两条路：观察器回调与 commit 期的 `useLayoutEffect`（其 deps 是整条 `chatMessages` 数组，每个 delta 都重新 pin）。把门设在 `judgeTranscriptGrowth` 里**并**把该 effect 的 deps 收窄成 `chatMessages.length` 才红。
- (ii) 单帧一次性终态（整条回复一个 `stream_delta`）：`exit=1`（wall 13.8s），`every delta has to reach the app (1 of 22 were delivered)`。
- 断言未削弱：对 `e2e/transcript-follow.spec.ts` 的 diff 是 `234` 增 / `0` 删（`grep '^-[^-]'` 计 0 行删除）；AC-108 自身的断言 `growthStepsInStream ≥ AC108_DELTA_COUNT - 1`（今 `:2723`）、`maxLastRowHeight > paneHeight`（`:2733`）、`rowCountsSeen.toHaveLength(1)`（`:2739`）、无豁免的 `unpinned` `toEqual([])`（`:2747`；任务里按 HEAD 记的 `:2279` 就是同一段 `const unpinned = samples` 摘录，已逐字核对）、第二份拷贝 `:2776`/`:2780`、`finalizeAt` `:2786`、`settleFrame` `:2790` 全部原样；diff 内没有 `retries` / `repeat-each` / `test.skip` / `test.fixme`，也没有 `--force` 类残留。

**AC7**：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。如实登记：这两道门都**不覆盖 `e2e/`**（root tsconfig 与 oxlint 的 include 都不含它），故夹具代码另有 `scripts/test.sh --for-task … --allow-thin` 与上表的真实跑动覆盖。

**AC-108 自身的复测读数**（`/tmp/ac108-runs-final1/run-1.log`）：`deltasDelivered=22`、`deltaIntervalMs=250`、`samples=404`、`sampledSpanMs=6715`、`growthSteps=22`、`growthStepsInStream=22`、`maxLastRowHeightPx=1671`、`paneClientHeight=496`、`rowCountsDuringStream=[1]`、`nodeRuns=[1]`、`rowMutationCount=1`、`stampChanges=22`、`firstCollapse=-1`、`minGapPx=0`、`maxGrowthFrameGapPx=0`（**22 帧全 `gap0`**）、`unpinnedFrames=[]`、`offBottomFrames=0`、`writesAtExcursions=[]`、`zeroWrites=0`、`finalizeAt=7540`、`settleFrame=343`、`streamEndTimes=[7540]`。

**本任务的红不是几何修复的回归**：上表 22 帧全 `gap0`、`minGapPx=0`、`maxGrowthFrameGapPx=0`，与 `gap-transcript-follow-on-real-stream`（done）落地的几何修复一致；红次死在夹具启动阶段，几何断言一次都没有被执行到。

**driver 那次 `17:58:00Z` 的红，本轮仍未确证走的是冷预构建路径**：其 trace 只留下 app 自身模块 URL 上的成串 `net::ERR_NETWORK_CHANGED` 与近乎空的 body（`before` 帧 `"html": [[1, 54]]`），事后取不到 `[BABEL]` 之类的冷预构建痕迹；现场 `/data/scratch/yale/quay-e2e-Yo1GVO/test-results/transcript-follow-transcri-1a4d0-hile-one-row-grows-in-place/`。**不得读成「已复现 driver 那次红」**：本任务证明的是同一机制（冷优化 + 页面被 reload 抽走 → 夹具盲等）可复现，且已在内层封住。

**账本翻正**：修后判据的启动路径在有 sibling lane 并发时 10/10 绿、自报时长 ≤22.8s，且真启动失败会在 ~20s 内以夹具自己的话退出（AC5）——driver 下一轮重跑该 criterion 时读到的是 pass 而不是 55s watchdog kill。连续 frozenRecheck 是否保持绿由 driver 的后续轮次观察（本任务无法自证未来轮次）。

- **L_D = 0**。L_D 该轴仍暗，理由：本任务只改 e2e 夹具的启动路径与失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G = 0**。L_G 该轴仍暗，理由：同上 —— 读数是运行期退出码、墙钟与页面文本，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

## Touches

- `e2e/transcript-follow.spec.ts`
- `playwright.config.ts`
- `tasks/gap-transcript-follow-criterion-boot-dep-reopt-race.md`
