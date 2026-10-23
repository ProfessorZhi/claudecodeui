---
id: gap-ac101-criterion-concurrency-determinism
title: AC-101 判据在舰队并发下不再可靠为绿：并发 e2e 撞死共享写死端口，会话过滤判据 2.4s 假红 / 单次运行 123s 被 goal
  gate 的 60s 上限击杀并遗留占端口孤儿
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

AC-101 的判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 在舰队并发下不再可靠为绿。以下读数全部是本轮直接复跑测得（canonical checkout `/data/home/yale/work/claudecodeui`，HEAD `e3777763`）。

### 现象一：静默机器上判据是绿的，余量充足 —— 所以红不是被测功能坏了

`npm run test:e2e -- e2e/session-filter.spec.ts` 连跑三次：EXIT=0 / EXIT=0 / EXIT=0，wall **16.74s / 16.92s / 23.02s**，每次 `5 passed`。逐条用时（run3）：2.5s / 379ms / 6.1s / 897ms / 699ms。

### 现象二：账本里最近一次红是「超时」

`.quay/gate-events.jsonl` 的 AC-101 goal gate：

- `2026-09-21T07:52:04.638Z` goal-sweep **fail** —— reason 为 `acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout`
- `2026-09-21T07:52:15.239Z` goal-cli **fail**（与上一条只隔 10.6s）

同一时刻现场另有一个孤儿 `npm run test:e2e e2e/session-filter.spec.ts`（PPID=1）在跑，存活 **~125s**。

### 现象三：直接复现（两次 e2e 相隔 0.5s 并发启动）

- A = AC-101 的判据 → **2.386s** EXIT=1：`Error: http://127.0.0.1:47173 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.`
- B = `e2e/model-library.spec.ts` → **123.061s** EXIT=1：先是 `[WebServer] Error: listen EADDRINUSE: address already in use 127.0.0.1:47101`，随后是反复 `Error: connect ECONNREFUSED 127.0.0.1:47101`。

### 机制（四条链，缺一不可）

`playwright.config.ts:13-14` 把两个端口写死 `47101` / `47173`；两处 webServer 都是 `reuseExistingServer: false`（`:155`、`:167`）；而端口是**机器级**资源，不是 checkout 级的。并发时：

1. 抢输的一方约 2s 内以 `already used` 判死 —— 判据变红，与被测功能无关。
2. 抢赢、但**另一个** webServer 撞上 `EADDRINUSE` 的一方，会把 url 健康检查一直重试到 `webServer.timeout: 120_000`（`:156`、`:168`），单次运行 wall 于是到 ≈123s。
3. 123s 远超 goal gate 的 **60s** 硬上限（`packages/quay/src/gate/factories/goal.ts:43` 调 `resolveRunnerOptions` 时**只传了 cwd、没传 timeoutMs**，于是落到 `packages/quay/src/gate/acceptance-runner.ts:156` 的默认 `60000`），该次运行被击杀、记为「超时红」。
4. 被击杀的那次运行**遗留 server / vite 孤儿**继续占着那两个端口，把紧随其后的下一轮也拖成红。

第 2–4 条合起来正是 `07:52:04` 超时 + `07:52:15` 紧接 fail 的成因；本轮也复现出同为 ≈123s 的第 2 条形态（上面 B）。

### 为什么前两次修复没挺住（本任务存在的理由）

`gap-session-filter-real-browser-e2e`（done）立了 spec 与判据，`gap-canonical-checkout-node-modules-missing-compression`（done）补齐了主 checkout 的依赖树。两次修的都是**内容侧**（spec 是否存在、依赖是否装齐、播种时序），一次也没碰判据的**运行级隔离**。所以这条判据从建立起就只在「此刻机器上没有别的 e2e 在跑」时成立；而舰队今天已不满足这个条件：GOAL-004 的六条 e2e 判据（AC-106..111）每条都有 filing agent、worker 与驱动器在各自 checkout 里跑 `npm run test:e2e`。

<!-- dedup-ref -->与在飞任务的边界（记给出处，⛔ 不重复申领）：`gap-e2e-hardcoded-ports-collide`（status=ready，其 `goal_ac` 是 AC-027，Touches 含 `playwright.config.ts`）正在为 AC-027 做「端口按运行分配 + 每次运行独立 outputDir」。端口按运行分配这一条归它，本任务**不重做**，也不把它写成自己的 AC。本任务要的是 AC-101 自己的判据在**它今天变红的那个条件下**确定性为绿，并关掉上面机制第 2–4 条那条 AC-027 任务 Proposal 未覆盖的加重路径（`EADDRINUSE` → 健康检查重试满 120s → 单次运行 >60s → 被 60s 门限击杀并遗留占端口孤儿）。若开工时端口按运行分配已经落地，本任务就退化为「在上述并发条件下取证 + 关闭加重路径」，⛔ 不得为凑 AC 再改一次端口分配。

### 约束

⛔ 不得削弱判据换绿：不 stub、不 skip、不删任何断言、不加 `retries`（重试会把真回归掩盖成慢绿）、不把 `reuseExistingServer` 改成 `true`（那会静默复用**别人的** server，而对方的 `QUAY_E2E_DATA_DIR` / `HOME` / `DATABASE_PATH` 全不同 —— 那是假绿，比红更坏）、不删 `keepSessionIds`、不把过滤搬到客户端、不改 `e2e/session-filter.spec.ts` 的任何断言、不改 `goals/AC-101-*.md` 里 `criterion` 命令本身。

## AC

- [x] AC-101 判据在**并发条件下**退出码 0：先起 `npm run test:e2e -- e2e/model-library.spec.ts`，在 1s 内并发起 `npm run test:e2e -- e2e/session-filter.spec.ts`，后者 EXIT=0 且输出含 `5 passed`（今天同一形态必红：本轮实测 2.386s `47173 is already used`）。两次运行的 EXIT 与被测判据的逐条输出记入证据。
- [x] AC-101 判据单独连跑 ≥3 次全部 EXIT=0、每次 `5 passed`，各次 wall 时间记入证据（证明并发修好没有把判据本身弄坏）。
- [x] 单次运行不再存在超过 60s 的路径：构造一次「端口已被占用」形态，实测该次 `npm run test:e2e -- e2e/session-filter.spec.ts` 的 wall **< 60s**，且其输出里第一条可归因错误行点名端口或启动失败（即启动失败是快速且可归因的失败，而不是把健康检查重试到 120s）；把该 wall 与那一行记入证据。
- [x] 判据命令一字未改：`grep -n "^criterion:" goals/AC-101-*.md` 的输出仍是 `npm run test:e2e -- e2e/session-filter.spec.ts`；且 `git diff develop -- e2e/session-filter.spec.ts` 无输出。
- [x] 抗假变体真跑并留输出：把「并发下不互撞」的实现回退成共享写死端口（其余不动），同一并发对必须变红（`already used` 或 `EADDRINUSE` 形态），变体须还原。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。
- [x] 记录卫生：`goals/AC-101-在真实浏览器里经界面把规则设进去并使列表真的收敛.md` 的 `expect` 末尾那句「⚠️ 当前必红：e2e/session-filter.spec.ts 不存在，且 @playwright/test 已声明但主 checkout 未安装」现在已是**假的**（spec 存在；`node -e "require.resolve('@playwright/test/package.json')"` 在仓根可解析）。用 `quay goal write AC-101 --expect …` 改成与当下一致的陈述，并在完成记录里点名该 note 已误导后续每一次 filing。

## DoD

真实落地判据：不是「配置里多了几行」，也不是「挑一个安静的窗口跑一次绿」。要求在**判据今天变红的那个条件**下 —— 机器上同时有另一个 e2e 在跑 —— 由真实浏览器驱动真实服务跑完 AC-101 全文并退出 0，且单次运行不再存在 >60s 的路径（否则会被 goal gate 的 60s 上限击杀，并遗留占端口孤儿把下一轮也拖红）。取假形态：把运行级隔离回退成共享写死端口后，同一并发对必须变红。判断「修好了没有」的对照读数：本轮静默三连绿 16.74s / 16.92s / 23.02s，并发复现 2.386s（`already used`）与 123.061s（`EADDRINUSE` → `ECONNREFUSED`）。

L_D 该轴仍暗，理由：本任务修的是判据的运行级隔离与失败可归因，不新增会话过滤的领域能力。
L_G 该轴仍暗，理由：同上；判定面由既有 5 条真实断言承担，本任务不新增领域读数。

## Touches

- playwright.config.ts
- e2e/session-filter.spec.ts (覆盖面登记，⛔ 不写入)
- goals/AC-101-在真实浏览器里经界面把规则设进去并使列表真的收敛.md
- tasks/gap-ac101-criterion-concurrency-determinism.md

<!-- evidence -->
**证据（全部真跑，读数取自本 worktree；实现提交 `0b5f4cb6`）。** AC-1 并发形态：同一 shell 内先起 A=`e2e/model-library.spec.ts`，1s 后起 B=`e2e/session-filter.spec.ts`（即判据）。**B EXIT=0 / `5 passed (16.8s)` / wall 17.29s**，逐条 2.1s / 291ms / 2.5s / 1.7s / 644ms；A 同一轮 EXIT=0 / 3 passed / wall 13.96s，两者在时间上重叠（B 全程与 A 并存）。AC-2 单独连跑三次：**EXIT=0 / EXIT=0 / EXIT=0，每次 `5 passed`，wall 17.00s / 16.83s / 17.12s**，即并发修好没有把判据本身弄坏。AC-3 两种「端口已被占用」构造，都不再走「健康检查重试到 120s」：(i) 用一个只接受 TCP 连接、不应答 HTTP 的监听器占住 client 端口，`QUAY_E2E_CLIENT_PORT=45173 npm run test:e2e -- e2e/session-filter.spec.ts` → **EXIT=1 / wall 0.456s**，输出里第一条可归因错误行为 `Error: e2e port(s) 45173 are already in use by another process, so this run's servers cannot bind them. Failing now, naming the port, rather than waiting on a health check that has no deadline.`（`playwright.config.ts:111`）；(ii) 复刻舰队真实形态 —— 另一个真在跑的 e2e（`e2e/model-library.spec.ts`，固定 `QUAY_E2E_SERVER_PORT=45201` / `QUAY_E2E_CLIENT_PORT=45273`，已 boot 完成并 LISTEN）占住两个端口，再跑同一条判据命令 → **EXIT=1 / wall 0.444s**，首行点名 `45201, 45273`。**未修前的同一形态实测 >300s 仍无退出码、输出里没有一行点名端口**（此时进程被外部击杀，与账本里 `acceptance timed out after 60000ms (killed)` 同形）：Playwright 在 spawn 之前先做一次可用性探测，`playwright-core/lib/coreBundle.js:8898` 的 `httpStatusCode` 没有超时，`WebServerPlugin._startProcess` 里那次 `await this._isAvailableCallback()`（`runner/index.js:859`）位于 `_waitForProcess` 的 deadline（`:943-951`）之前，所以 `webServer.timeout` 对它根本不生效。AC-5 抗假变体：只把端口分配回退成写死 `47101`/`47173`（其余不动），同一并发对三次读数全部变红 —— 两次先到者 A `EXIT=1`、原文 `Error: http://127.0.0.1:47173 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.`；一次等 A 的 webServer 起满后再起 B，**B（判据本身）EXIT=1 / wall 0.423s**、原文 `Error: http://127.0.0.1:47101/health is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.`（变体读数时用 `QUAY_E2E_PORTS_VERIFIED=1` 显式旁路本任务新增的那道预检，以免预检抢在 Playwright 之前把红改写成本任务自己的消息）。变体随后 `git checkout -- playwright.config.ts` 还原：`git status` 干净，文件里已无 `47101`/`47173` 字面量。AC-4：`grep -n "^criterion:" goals/AC-101-*.md` → `7:criterion: npm run test:e2e -- e2e/session-filter.spec.ts`；`git diff develop -- e2e/session-filter.spec.ts` 无输出；spec 工作区亦无改动。AC-6：`npm run typecheck` EXIT=0；`npm run lint` EXIT=0（仅 pre-existing warning，0 error）。

**该 note 已误导后续每一次 filing。** `goals/AC-101-*.md` 的 `expect` 末尾那句「⚠️ 当前必红：e2e/session-filter.spec.ts 不存在，且 @playwright/test 已声明但主 checkout 未安装」自 `gap-session-filter-real-browser-e2e` 落地那一刻起就是假的，但它作为 AC-101 唯一的读数说明长期挂在记录上：任何以 AC-101 为 `goal_ac` 的 filing agent 读到它，都会把「这条判据当前必红、且红的原因是环境没装好」当成前提去写 Proposal —— 本任务 Proposal 的「为什么前两次修复没挺住」正是在这个前提下写成的（把红归给内容侧）。已按本 AC 用 `quay goal write AC-101 --expect …` 改为与当下一致的陈述（记录提交 `c4afc64d`，已 cherry-pick 进本任务分支 `d2b7e1b9`），并在新句中标明原文已过期。

**残留（如实登记，本任务未关闭）。** 本任务关闭的是**启动期**的 >60s 路径：无 deadline 的可用性探测、`webServer.timeout` 120_000、vite 静默换端口。**测试期**仍可超过 60s：一次运行里 hook 与各用例自己的上限仍是 60_000，负载高时 hook 超时叠加会让单次 wall 到 ~123s —— 本轮基线实测就出现过一次 `"beforeAll" hook timeout of 60000ms exceeded`、wall 123.75s（同一个并发对的另一侧，判据本身那一轮仍 EXIT=0）。这些上限属于判据自己的判定面，收窄它们等于削弱判据，本任务明文禁止，故不在此处改动，仅登记供后续任务取舍。
