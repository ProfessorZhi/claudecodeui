---
id: gap-model-library-criterion-bounded-boot-guard
title: AC-027 判据的启动阶段无界：宿主网络抖动打断渲染器在途模块加载（net::ERR_NETWORK_CHANGED 实测 10
  连发）后，:80 的登录字段填充无预算，被拖到 55s 看门狗记红——本族既有的有界预热+启动探针未回灌到
  e2e/model-library.spec.ts
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-027
---
## Proposal

AC-027 的判据（`npm run test:e2e -- e2e/model-library.spec.ts`）本轮在 HEAD `6972c222967dbb7b88bddd1828e43523b342cd6f`（分支 `author`）上**直接重跑实测为不稳定**：同一棵树连跑两遍，一遍红一遍绿。台账尾部记的「当前为假」在本轮被一次直接测量确认了一次，又被紧接着的第二次测量否证了一次 —— 所以本条认领的不是「修一条已死的功能链」，而是「让判据的**响应**在宿主抖动下仍有界」。

两次读数的原始出处（本轮实测，不是台账 `reason` 里那条 stderr 尾巴）：

- **红跑**：日志 `/data/home/yale/work/ac027-criterion-1790762914.log`，`EXIT=1`，dataDir `/data/scratch/yale/quay-e2e-uqDvan`，`[e2e] server=29865 client=3117`；`watchdog-state.json` 逐字 `{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55005ms"}`，台账文本为 `stuck at stage "browser-launch-or-cases"`，三条用例**零读数**（没有任何一条开始）。
- **绿跑**：日志 `/data/home/yale/work/ac027-rerun-1790763036.log`，`EXIT=0`，`3 passed (24.4s)`，`[e2e] server=27081 client=16777`。

机制从红跑 trace 的 console / network 流读出（`/data/scratch/yale/quay-e2e-uqDvan/test-results/.playwright-artifacts-0/cae7749f6b71c61e7907e0ece01c16d4.zip`），而不是从台账尾巴猜：

1. 首屏加载期出现 **10 连发 `net::ERR_NETWORK_CHANGED`**，把渲染器**在途**的 10 个模块请求全部打断（trace 里这 10 条模块 URL 的 status 都是 `-1`）。
2. 页面因此没有 commit 出登录表单，`e2e/model-library.spec.ts:80` 的 `page.locator('#username').fill(...)` 是**无界**等待 —— `playwright.config.ts` 未设 `actionTimeout`（`grep -n actionTimeout playwright.config.ts` 零命中），`fill()` 没有任何预算 —— 于是一直等到 55s 看门狗 SIGKILL 掉整个 run。
3. trace 里**没有 504 `Outdated Optimize Dep`，也没有第二个 `[vite] connected`** ⇒ 这是宿主网络抖动打断在途模块加载的路径，**不是** vite 依赖重优化；也**不是**冷缓存（该 run 的 `vite-cache/deps` 下已有 **2334** 个文件）。

判据侧缺守卫是可机械 grep 的：`grep -c warmClientStartup e2e/model-library.spec.ts` = **0**、`grep -c navigateBounded e2e/model-library.spec.ts` = **0**；四处置导航全是裸调用（`:79` goto、`:103` goto、`:141` reload、`:161` reload），全 spec 只有 `:91` 一处有界等待（`Settings` 按钮，15s）。

本族既有解法（同机制、已落地）：`tasks/gap-resident-running-view-criterion-bounded-boot-guard.md`（`goal_ac: AC-173`，commit `e963c867`）为 `e2e/resident-running-view.spec.ts` 加了 `warmClientStartup`（`:502`）与 `navigateBounded`（`:625`），把「无界等待 → 看门狗红」换成「有界重放 → 响亮失败」。**本条就是把同一对杠杆回灌到 `e2e/model-library.spec.ts`**，不碰 `playwright.config.ts`。

修法（不弱化任何断言）：在该 spec 内定义

- `warmClientStartup(clientUrl)`：首个页面之前，按 URL 逐个有界等待客户端模块系统可用；超时抛错且错误文本含该 url 与状态。
- 一个有界导航探针（`page.goto` / `page.reload` 一律走它）：落地条件分两处 —— fresh-DB `beforeAll` 的 `#username`（登录表单），`afterAll` 与两次 `reload` 后的 app shell（`Settings` 按钮）；耗尽预算时抛出，错误里带页面文本与 `requestfailed` 列表。

触发源（宿主的 `net::ERR_NETWORK_CHANGED`）在仓库之外，仓库能修的是**响应**：无界等待 → 有界重放 + 可归因失败。

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-30）：`grep -ln "goal_ac: AC-027" tasks/*.md` → **5 命中**（`gap-model-library-browser-e2e`、`gap-e2e-onboarding-anchor-seeded-transcripts`、`gap-e2e-hardcoded-ports-collide`、`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`、`gap-ac027-gateway-wait-weaker-than-assertion`），**五条全部是 `done`**，没有 todo/ready/needs-human 的认领者 —— 按本轮规则，done 的认领不是重复，而是「更早的修复没守住」的证据，且本轮的假形态在它们落地之后仍然实测出现（上面那次红跑），所以立新条。这五条在本段只作溯源，**不构成任何关系**。同区不同机制、本条**不**重复也不与其互为前置的邻居：`gap-e2e-hardcoded-ports-collide` 交付**端口按运行从内核取一对**、`gap-e2e-onboarding-anchor-seeded-transcripts` 交付**登录后置锚点不依赖空态**、`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page` 交付**vite 预构建缓存按运行隔离**、`gap-ac027-gateway-wait-weaker-than-assertion` 交付**第三条腿的等待谓词与断言谓词合一**（这四处今天都在生效，所以它们不是本条要动的东西）。本条认领的是它们都让出的那一格：**启动阶段本身无界**。

本条**不认领**另一个机制（登记为未认领观察，供后续轮次单独立案）：同一台账窗口里 10:05:45Z 那次失败的 `error-context` 为 `Error: page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1719/` —— `playwright.config.ts` 的 `freePortPair()` 用 `listen(0)` 取端口，而本机 `net.ipv4.ip_local_port_range = 1024 65535`，`listen(0)` 可能落到 Chromium 屏蔽端口段内。它与本条的 `ERR_NETWORK_CHANGED` 是**不同机制**，本条不改端口选择（AC5 机械钉住），只登记。

## AC

- [x] AC1 有界客户端预热就位：`e2e/model-library.spec.ts` 内定义 `warmClientStartup(clientUrl)`（按 URL 逐个有界等待客户端模块系统可用，超时抛出且错误文本含该 url 与状态），并在该 spec 首个页面之前调用。验证：`grep -n "warmClientStartup" e2e/model-library.spec.ts` 同时命中定义行与调用行；`npm run typecheck` 退出 0（本仓 `typecheck` 不覆盖 `e2e/` —— 该 spec 的编译正确性由判据运行本身的 Playwright 转译保证，故以 AC4 的连续绿为准，逐字登记这一限制）。
- [x] AC2 每一次导航都走同一个有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/model-library.spec.ts` 的每一处行号都落在探针函数体内部，函数体外没有任何裸导航；探针耗尽预算时抛出携带页面文本与 `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界（并给出探针函数的起止行号作对照）。
- [x] AC3 有界失败的实测：把探针落点临时指向一个不可能存在的 sentinel 后，判据命令在 **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：两次运行的 `echo $?` 与 wall time。
- [x] AC4 判据在负载下连续绿：判据命令连续 ≥5 次全部 `exit 0`，且每一次 wall < 55_000ms（一次都不触发 55s 看门狗 / 60s 门限），其中至少一次与 ≥4 份兄弟 spec 并发。验证：逐次 `echo $?` + wall time。**如实登记**：本机负载高（实测 load1 > 19），并发那一次若兄弟 spec 自己红，须点名归因，不得算到本条头上。
- [x] AC5 判定面未变：`git diff develop -- package.json playwright.config.ts` 为空（无 `test:e2e` / `RUN_CEILING_MS` / `BOOT_CEILING_MS` / `SINGLE_SPEC_CEILING_MS` 的增删），且 `git diff develop -- e2e/model-library.spec.ts | grep -c "^-.*expect("` 为 **0**。验证：两条命令的逐字输出。
- [x] AC6 AC-027 的假形态仍然红（承重）：把 `src/modules/chat/modals/ModelEnvEditor.tsx` 里存储 secret 的 `secret-set-badge` 遮蔽去掉（让已存 secret 的值可被读回），判据命令退出**非 0**，且红**落在第二条腿的 secret 断言**上（`:146` 的 `secret-set-badge` 可见 或 `:147` 的 `toHaveValue('')`）。登记变异 diff、失败断言逐字、退出码；恢复后判据回到 `exit 0`。

## DoD

- 驱动器的下一轮在 `.quay/gate-events.jsonl` 把 AC-027 翻成 pass（判据命令在本树上 `exit 0`）—— 这是本条的落地判据，不是「代码改完了」。
- 绿不得是「这次没抖」：AC4 的 ≥5 连续绿是承重读数，单次绿不构成落地。
- 全部读数（红跑 / 绿跑 / AC3 有界失败 / AC4 逐次 wall / AC6 变异与还原）逐条登记在完成记录里，含原始日志路径与 `echo $?`。
- 完成记录须写明：触发源（宿主 `net::ERR_NETWORK_CHANGED`）在仓库之外，本条修的是**响应**（无界等待 → 有界重放 + 可归因失败）；并如实登记未认领的 `ERR_UNSAFE_PORT` 机制仍可能极低频地把该判据记红。

## Touches

- e2e/model-library.spec.ts
- src/modules/chat/modals/ModelEnvEditor.tsx（仅 AC6 假形态变异的临时写点，跑完还原，不进最终 diff）
- tasks/gap-model-library-criterion-bounded-boot-guard.md

## 完成记录（2026-09-30，branch `task/gap-model-library-criterion-bounded-boot-guard`，commit `19165b66`）

代码 delta 只有 `e2e/model-library.spec.ts`（`git diff develop --stat` 排除 `tasks/`/`goals/`）：287 insertions / 7 deletions；`src/`、`server/` 最终 diff 为空（AC6 的变异已还原）。

- **AC1** — `grep -n "warmClientStartup" e2e/model-library.spec.ts` → `97:const warmClientStartup …`（定义）+ `334: await warmClientStartup(clientUrl);`（调用，在 `browser.newPage()` 之前）。`npm run typecheck` exit 0（日志 `/tmp/ac027-typecheck.log`）。局限如实登记：本仓 `typecheck` 的 include 不含 `e2e/`（`tsc -p tsconfig.json && server/tsconfig.json && scripts/tsconfig.json`），`lint` 亦不扫 `e2e/`（`oxlint src/ server/ scripts/ shared/`）⇒ 该 spec 的编译正确性由判据运行之时 Playwright 的转译保证，以 AC4 的连续绿为准。
- **AC2** — `grep -n "page\.goto(\|page\.reload(" e2e/model-library.spec.ts` → 只有两处：`237`（`page.goto('/')`）与 `239`（`page.reload()`），都在 `navigateBounded` 函数体（`225`–`260`）内；函数体外无裸导航。探针耗尽 `STARTUP_PROBE_DEADLINE_MS=14_000ms` 时抛出的错误携带 `readStartupEvidence(page)`：页面文本 + console errors（前 5）+ `requestfailed` 列表（前 5）—— AC3 逐字见下。
- **AC3** — 把 `ACCOUNT_FORM_PROBE` 临时改成不可存在的 sentinel `#username-sentinel-that-cannot-exist`：`exit=1`，`wall=22356ms`（< 30_000ms），日志 `/tmp/ac027-ac3-sentinel.log`；错误逐字：``Error: the account form (#username-sentinel-that-cannot-exist) never rendered, so this run's client never came up to a document that stays (the navigation itself failed: page.reload: Timeout 237ms exceeded. …): the page shows ""; console errors: Failed to load resource: the server responded with a status of 401 (Unauthorized) | … ; failed requests: <none>``（页面文本与失败请求列表两个字段都在错误文本里）。还原（diff 为空）后：`exit=0`，`wall=17381ms`，`3 passed (16.7s)`，日志 `/tmp/ac027-ac3-restored.log`。
- **AC4** — 连续 5 次：`17695 / 17834 / 22334 / 18650 / 18733 ms`，全部 `exit=0`，`3 passed`，均 < 55_000ms（日志 `/tmp/ac027-ac4-run{1..5}.log`）。并发一次：`model-library exit=0 wall=18514ms 3 passed`，与 4 份兄弟 spec（`session-filter` / `transcript-follow` / `mobile-composer-send-key` / `sidebar-resize`）同时起跑（日志 `/tmp/ac027-conc-model-library.log`，5 路并发总 wall 55484ms）。**兄弟点名归因（不算到本条）**：并发那次 `mobile-composer-send-key`（exit=1, 11147ms）与 `sidebar-resize`（exit=1, 11126ms）各自红在 5000ms 的 `expect(locator).toBeVisible()` / `element(s) not found`，单独重跑均 `exit=0`（36881ms / 32360ms）⇒ 并发下的宿主资源争用；`transcript-follow` 并发与单独重跑均 `exit=1`（55s watchdog，`stuck at stage "browser-launch-or-cases"`），单独重跑时 load1 已升至 71.8，且其文件与本分支逐字相同（`git diff develop -- e2e/transcript-follow.spec.ts` 为空）⇒ 与 develop 同源的既有重载红，非本条。
- **AC5** — `git diff develop -- package.json playwright.config.ts` 输出 0 行（空）；`git diff develop -- e2e/model-library.spec.ts | grep -c "^-.*expect("` = `0`。
- **AC6** — 变异（写点 `src/modules/chat/modals/ModelEnvEditor.tsx`，`toEditorRows` 内）：`secretStored: row.kind === 'secret'` → `secretStored: false`（即去掉 secret 掩码/已设置徽标；与 `tasks/gap-model-library-browser-e2e.md:51` 记录的假变体 B 同一手法）。判据 `exit=1`，`wall=19754ms`，红落在第二条腿的 secret 断言（逐字）：``Error: expect(locator).toBeVisible() failed`` / ``Locator: getByTestId('model-env-row').filter({ has: locator('input[value="ANTHROPIC_AUTH_TOKEN"]') }).getByTestId('secret-set-badge')`` / ``Error: element(s) not found``；`1 failed`（case 2），另两条 pass。日志 `/tmp/ac027-ac6-mutation.log`。还原（`git checkout -- src/modules/chat/modals/ModelEnvEditor.tsx`，`git diff --stat` 为空）后：`exit=0`，`wall=17273ms`，`3 passed (16.5s)`，日志 `/tmp/ac027-ac6-restored.log`。
- **触发源与「响应」定位** — 触发源（宿主 `net::ERR_NETWORK_CHANGED` 打断渲染器在途模块加载）在仓库之外；本条修的是**响应**：无界等待 → 有界重放 + 可归因失败，两个杠杆（`warmClientStartup` 预热 + `navigateBounded` 单点导航探针）均取自 `e2e/session-filter.spec.ts` / `e2e/transcript-follow.spec.ts`，未新造、未弱化任何断言。未认领的 `ERR_UNSAFE_PORT` 机制（`freePortPair()` 的 `listen(0)` 可能落进 Chromium 屏蔽端口段）仍可能极低频地把该判据记红 —— 本条按 AC5 未改端口选择，只登记。
