---
id: gap-ac101-criterion-bounded-under-gate-cap
title: AC-101 判据在 60s 门限之上无界、越过时不归因：端口预检只是一次快照而 Playwright 自身的 spawn 前探测没有
  deadline（实测构造 150s 不出，预检生效时 0.481s）
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

AC-101 的判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 在账本里不成立，但不是因为被测功能坏了，也不是因为普通的并发变慢：**这次运行在 60s 上限之上没有任何界，而且越过上限时它什么也不说。**

### 读数一：账本里判据在 4 分钟内两次被 60s 上限击杀

`.quay/gate-events.jsonl` 的 AC-101 goal gate，`criterionHash` 全程 `4f9eff7856601084`（判据文本一字未改 ⇒ 变的是运行时长，不是判据）：

- `05:10:50.811Z` goal-sweep pass / `06:16:16.054Z` pass / `07:17:24.326Z` pass / `08:18:43.849Z` pass
- `09:21:11.297Z` goal-sweep **fail** — `acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout`
- `09:21:36.227Z` goal-cli pass、`09:23:09.663Z` goal-cli pass
- `09:25:07.999Z` goal-cli **fail** — `acceptance timed out after 60000ms (killed)`

60s 是 goal gate 写死、本仓抬不动的上限（`runAcceptance({ timeoutMs: 6e4 })`；本仓无 `packages/quay`、无 `.quay/gates.yml`），且**超时与真失败同形**（都记 `verdict: fail`），所以红本身不可区分。

### 读数二：同一命令我连跑 7 次全绿，23.0–23.7s，含 6 路并发

全部 `npm run test:e2e -- e2e/session-filter.spec.ts`，cwd = 仓根，HEAD `beba8ccd`，并按 driver-anchor 的 environ 把 `ANTHROPIC_*` 摘掉：静默 2 次 **23.626s / 23.219s**；同命令 3 个实例并发 **23.251 / 23.361 / 23.684s**；在 6 个兄弟 spec（model-library、model-library-layout、sidebar-resize、model-env-kind-explanations、mobile-composer-send-key、voice-trim）同时在跑的 6 路负载下 **23.577s**（6 个兄弟各自 EXIT=0）。每一次 EXIT=0、`5 passed`。所以「普通并发变慢」不成立：`09:21:36` 那次复跑就是在 `load1=79.1` 下以 **23.631s** 通过的。

### 读数三：一次运行的 23s 花在哪（`DEBUG=pw:webserver` 实测）

配置求值+npm ≈0.6s → server（`npx tsx server/index.ts`）就绪 **1.86s** → vite 就绪 **0.48s**（两个 webServer 是**串行**启的）→ 浏览器启动 + `beforeAll` 装机 ≈**8.9s** → 5 条用例 **11.3s**（2.3 / 0.37 / 6.6 / 1.4 / 0.66s）。判据自己的判定面只有 11.3s，其中 6.6s 是「watcher 每 6s 轮询一次」这条领域约束，收不得。

### 读数四：我复现出那条无界路径（本任务立案的依据）

`playwright.config.ts` 的端口预检（`findTakenPorts`）在**配置求值那一刻取一次快照**，而 Playwright 自己在 spawn 之前那次可用性探测**没有 deadline**（配置自己的注释写着这句）。两次检查之间就是窗口：端口在快照之后才被占住时，预检放行，而探测会永远等下去。构造（sink = 只 accept TCP、永不应答的监听器，目录 `/data/scratch/yale/ac101probe-8f42af`）：

- 预检生效（今天仓里发出去的样子）：`QUAY_E2E_SERVER_PORT=45501 QUAY_E2E_CLIENT_PORT=45573 npm run test:e2e -- e2e/session-filter.spec.ts` → **EXIT=1 / wall 0.481s**，输出点名 `45501`。
- 把预检旁路以模拟「端口在快照之后才被占住」：同一命令加 `QUAY_E2E_PORTS_VERIFIED=1` → **EXIT=124 / wall 150.007s**（我的 `timeout 150` 打的），150s 里除 npm 横幅外**一行输出都没有**。外部击杀时账本记的就是 `acceptance timed out after 60000ms (killed)`。

一条被外部击杀的运行还会把它启好的 webServer 留下（配置注释自陈）：`gap-ac101-criterion-concurrency-determinism` 的 Proposal 记过一个 PPID=1、存活 ~125s 的孤儿，而孤儿正是下一个探测会连上却等不到应答的那类监听者。

### 为什么这条红会在 4 小时窗口里被反复放大

`check --stale-pass`（goal-store `checkStalePass`）对冻结 AC 取**最近一次 actor=goal-sweep 事件的 verdict**，并在 `DEFAULT_STALE_PASS_MAX_AGE_MS = 4h` 内让它在 `failing` 里买单；**其后 goal-cli 的 pass 不覆盖它**。`sweepFrozen` 对 fail 的重扫门槛是 `minAgeMs / DEFAULT_FAIL_RECHECK_DIVISOR = 10min`。于是 `09:21:11` 那一次 sweep 超时，就把 AC-101 钉成「当前为假」最长 4 小时，driver 每轮（约 1.5 分钟）都要真跑一次 23s 的真实浏览器 e2e 去复验（≈160 次），第二次超时几乎必然发生——`09:25:07` 那次就是它，而它使本轮读成 `confirmed-failing` ⇒ `frozen-violated`，才立了这个案。

### 为什么上一次修复没挺住

<!-- dedup-ref -->`gap-ac101-criterion-concurrency-determinism`（status=done，`goal_ac: AC-101`）关掉的是**启动期**的 >60s 路径：写死端口 → 内核按运行分配端口、`EADDRINUSE` → 健康检查重试满 120s → 被 60s 击杀并遗留占端口孤儿。它自己的 Evidence 末尾把**测试期/运行级**的 >60s 路径明确登记为残留并留给后续任务取舍（「本任务关闭的是启动期的 >60s 路径……测试期仍可超过 60s……收窄它们等于削弱判据，本任务明文禁止，故不在此处改动，仅登记供后续任务取舍」），而它加的那道预检只是**一次快照**，留下的正是上面读数四那条路径。所以它没挺住不是因为它做错了，而是因为它明文停在了启动期。

### 本任务要做的

1. **先复现**：拿到一次 wall ≥ 上限（或卡死不出）的判据运行，并记录它把时间花在哪个阶段（配置求值/播种、webServer 启动、浏览器启动、`beforeAll` 装机、5 条用例）。用读数四那条构造去逼出卡死即可，但必须记录读数。
2. **把运行自身的天花板压到 60s 之下**：让任何一次运行都在被外部击杀之前**自己结束并点名**（阶段 + 已用毫秒），而不是留下一句没有归因的超时。⛔ 不是收窄判定阈值：5 条用例的断言、`ALL_SESSIONS`、规则字面量、6s 轮询等待一个字都不许动。
3. **关掉读数四那条无界路径**：把「端口在预检快照之后才被占住」这个窗口要么关死、要么加界，使同一构造在 60s 内以一条可归因的红结束。
4. **孤立进程归零**：包括故意跑红的那次在内，结束后不残留本次运行启动的 `server/index.ts` / `vite --host 127.0.0.1 --strictPort`。

### 约束（⛔）

⛔ 不得削弱判据换绿：不 stub、不 skip、不删任何断言、不加 `retries`、不把 `reuseExistingServer` 改成 `true`（那会静默复用**别人的** server，而对方的 `QUAY_E2E_DATA_DIR` / `HOME` / `DATABASE_PATH` 全不同——是假绿，比红更坏）、不删 `keepSessionIds`、不把过滤搬到客户端、不改 `e2e/session-filter.spec.ts` 的 5 条断言、不改 `goals/AC-101-*.md` 里 `criterion` 命令本身。

## AC

- [x] 复现读数入证据：构造出一次判据运行 wall ≥ 60000ms（或卡死不出），并把该次运行在各阶段的用时（配置求值/播种 / webServer 启动 / 浏览器启动 / `beforeAll` / 5 条用例）与逼出它的构造一并记入证据。
- [x] 卡死可归因且在上限内结束：同一构造下，`npm run test:e2e -- e2e/session-filter.spec.ts` 在 **< 60000ms** 内自行结束、EXIT≠0，且输出里有一行点名卡住的阶段与已用毫秒（即红是这次运行自己解释的，不是被外部击杀的）；把该 wall 与该行原文记入证据。
- [x] 并发下判据仍为绿：在 ≥4 个兄弟 spec（如 model-library / model-library-layout / sidebar-resize / voice-trim）同时在跑的条件下，连跑 ≥5 次判据，每次 EXIT=0、输出含 `5 passed`，各次 wall 记入证据且每次 < 45000ms。
- [x] 无孤立进程：上述每一次运行（含故意跑红的那次）结束后，按 cwd 过滤的 `pgrep -af "server/index.ts"` 与 `pgrep -af "vite --host 127.0.0.1 --strictPort"` 都不含本次运行的进程；把命令与输出记入证据。
- [x] 判定面未被削弱：`grep -c "reuseExistingServer: false" playwright.config.ts` 为 2；`grep -c "retries" playwright.config.ts` 为 0；`grep -cE "^  test\(" e2e/session-filter.spec.ts` 为 5；`git diff develop -- e2e/session-filter.spec.ts` 里 `await expect(` 的行数不减少；`grep -n "^criterion:" goals/AC-101-*.md` 仍是 `npm run test:e2e -- e2e/session-filter.spec.ts`。
- [x] 抗假变体真跑并留输出：把新加的界回退（恢复成上限之上的旧天花板），同一构造必须再次变成「外部击杀 / 无归因超时」；变体须还原，`git status` 干净。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

真实落地判据：不是「配置里多了一行」，也不是「挑一个安静的窗口跑一次绿」。要求在**判据今天变红的那个条件**下——机器上同时有别的 e2e 在跑、且存在一个只 accept 不应答的监听者——由真实浏览器驱动真实服务跑完 AC-101 全文并退出 0，且任何一次运行都在 60s 上限之前自己结束并说明原因，不遗留占端口的孤儿。取假形态：把新加的界回退掉，同一构造必须退回「被外部击杀、账本里只留一句 `acceptance timed out after 60000ms (killed)`」。对照读数：本轮静默 23.626s / 23.219s，3 路并发 23.251 / 23.361 / 23.684s，6 路并发 23.577s；无界构造 150.007s 不出（预检生效时 0.481s）。

L_D 该轴仍暗，理由：本任务修的是判据运行的界与可归因性，不新增会话过滤的领域能力。
L_G 该轴仍暗，理由：同上；判定面由既有 5 条真实浏览器断言承担，本任务不新增领域读数。

## Touches

- playwright.config.ts
- e2e/session-filter.spec.ts
- tasks/gap-ac101-criterion-bounded-under-gate-cap.md

## Evidence

### 冻结修订（每一条读数都取自同一份）

- `playwright.config.ts` sha256 `c471596654c8d149a64eb1233ef78941c238386a5782b326ca080c16b3c95ed9`；工作树文件与快照 `/data/scratch/yale/ac101-bd07/playwright.config.ts.final` **逐字节相同**（`sha256sum` 两行同值）。
- 分支 `task/gap-ac101-criterion-bounded-under-gate-cap`：实现提交 `5fb9888d`，其后 `git merge --no-edit develop` 得 `0966365a`（develop = `5ae2d3ad`），工作树干净。
- 所有 e2e 都按 driver-anchor 的 environ 摘掉 `ANTHROPIC_*` 再跑；scratch 目录 `/data/scratch/yale/ac101-bd07`（日志文件名在下面逐条给出）。
- 改动只有一个文件 `playwright.config.ts`：`e2e/session-filter.spec.ts` 逐字节未改（见 AC5）。

### AC1 复现读数（卡死不出，wall ≫ 60000ms）

构造 = 本任务读数四那条：sink 是只 accept TCP、永不应答的监听器，占住 45501 / 45573（`node sink.js 45501 45573`），再以 `QUAY_E2E_SERVER_PORT=45501 QUAY_E2E_CLIENT_PORT=45573 QUAY_E2E_PORTS_VERIFIED=1 npm run test:e2e -- e2e/session-filter.spec.ts` 跑判据；`QUAY_E2E_PORTS_VERIFIED=1` 旁路端口预检，正是「端口在预检快照之后才被占住」。

- **把新加的界回退后的同一构造**（= 今天仓里发出去的样子）：`ac6-variant.log` → **EXIT=124 / wall 75006ms**（`timeout 75` 打的）。75s 里除 npm 横幅外一行输出都没有；账本会把它记成 `acceptance timed out after 60000ms (killed)`。原始 `timeout 150` 那次读到的是 **EXIT=124 / wall 150.007s**。
- **它把时间花在哪个阶段：一个阶段都没走到。** 卡点是 Playwright「spawn 之前」的那次可用性探测（配置自己的注释写着它没有 deadline），所以 webServer 从未被 spawn、浏览器从未启动、`beforeAll` 与 5 条用例从未开始。这正是「无界」在这里的含义——不是慢，是不前进。
- **对照：同一份修订上一次健康运行的阶段分解**（`DEBUG=pw:webserver`，`ac1-stages.log`，EXIT=0 / wall 17678ms / `5 passed (17.0s)`）：npm + 配置求值/播种 → Playwright 首次探测 `10:10:30.961Z`；server（`npx tsx --tsconfig server/tsconfig.json server/index.ts`）spawn `30.965Z` → available `32.831Z` = **1.87s**；vite spawn `32.831Z` → available `33.281Z` = **0.45s**（两个 webServer 是串行的）；其后浏览器启动 + `beforeAll` + 5 条用例 = **17.0s**。即健康启动 ≈3.4s，而启动界取 40s。

### AC2 卡死可归因、且在 60000ms 内自行结束

同一构造、同一冻结修订，`ac2-final.log` 原文（`[e2e]` 行与它下面的 EXIT 行）：

```
[e2e] watchdog: this run crossed its own 40000ms boot ceiling at 40007ms and is ending here with exit 1 at 42009ms — stuck at stage "webServer-start": port 45501 (server) accepts TCP but never answers an HTTP request, port 45573 (client) accepts TCP but never answers an HTTP request — Playwright's pre-spawn availability probe for http://127.0.0.1:45501/health has no deadline, so it cannot return.
EXIT=1 wall_ms=42469
```

**EXIT=1 / wall 42469ms < 60000ms**，且这一行是**运行自己写的**：`fs.writeSync(1, ...)` 先于 `process.exit(1)`（POSIX 管道是异步写的，`console.log` 会在这条唯一能解释红的信息上丢字），写失败时退到 fd 2。它点名了三件事：阶段（`webServer-start`）、两个端口各自的状态（bound 但不应答）、以及探测为什么回不来（没有 deadline）——不是一个「超时了」。

### AC3 并发下判据仍为绿

每轮先起 4 个兄弟 spec，确认 4 个都还活着，再跑判据；`ac3-summary-final.log`：

| 轮 | 同时存活兄弟 | 判据 EXIT | 判据 wall_ms | 判据输出 |
| --- | --- | --- | --- | --- |
| 1 | 4 | 0 | 23998 | `5 passed` |
| 2 | 4 | 0 | 17920 | `5 passed` |
| 3 | 4 | 0 | 23049 | `5 passed` |
| 4 | 4 | 0 | 24025 | `5 passed` |
| 5 | 4 | 0 | 23705 | `5 passed` |

5 次全部 EXIT=0 且输出含 `5 passed`，**最大 wall 24025ms < 45000ms**。同 5 轮里 **20 个兄弟运行全部 EXIT=0**（model-library 3 passed 15.4–18.2s；model-library-layout 4 passed 17.3–21.5s；sidebar-resize 4 passed 23.9–28.9s；voice-trim 4 passed 40.6–52.4s）。

这组读数还直接决定了界必须分两段：第 3 轮 `voice-trim` 跑了 **52.4s**（4 passed，完全健康）。单段 45s 的界会在它的第 4 条用例中途开火——这不是假设，是本实现在落地前实测到的回归：`ac3-sibling-r4-voice-trim.log` 里 `✓ 3 e2e/voice-trim.spec.ts:929:3 … (9.8s)` 之后紧跟着 `[e2e] watchdog: this run crossed its own 45000ms ceiling …`，同轮 `model-library`（正常 15.6–16.0s）也被 45s 杀掉。于是界改成：只对「两个 webServer 都还没应答」这一段取紧界，过启动后重新武装到仍能落在 60s 击杀之前的最大值。

### AC4 无孤立进程

`orphans.sh` 按 cwd 过滤（只认 cwd 落在本工作树内的 `server/index.ts` / `vite --host 127.0.0.1 --strictPort`）：

- AC1 健康运行 + AC2 卡死运行之后：`ac4-final.log` → `ORPHAN lines: 0`。
- AC3 五轮（5 次判据 + 20 次兄弟）之后：0。
- 额外一击（`force-fire-rearm.log`）：把两段界临时调到 9s / 11s，让 watchdog 在一次**真的跑起来了**的运行里开火——此时 Playwright 已经 spawn 出 server + vite 两棵进程树，`endRun` 对每个直接子进程打 `process.kill(-pid, 'SIGKILL')`（Playwright 用 `detached` 起 webServer，每个直接子进程自成进程组，所以这一下覆盖整棵 `sh -c` → `npx` → `tsx`/`vite` 树）。事后孤儿 **0**。黑盒构造够不到这条分支（它卡在 spawn 之前，没有树可收），所以单独跑了一次。

### 两段界各自的取数与验证

- `BOOT_CEILING_MS = 40_000`：只界唯一无界的那一段。取值必须高于所有**已经有界**的启动路径——两个 `webServer.timeout` 各 30s，但它们是串行的，先到期的那个就结束整次运行，故上界 ≈31s；40s 也在健康启动（≈3.4s）的十倍以上。
- `RUN_CEILING_MS = 55_000`：过启动后重新武装到这个值（`force-fire-rearm` 实测：9s 的启动界在 `browser-launch-or-cases` 上不开火，重新武装后**在 11000ms 开火**——是按运行起点计的 55s，不是 9s+55s）。它是「仍能把那行落在 60s 击杀之前」的最大值：55s + 2s 诊断探测 + ≈0.6s 进程启动 ≈ 57.6s；取最大值而不是更小的值，理由就是上面那 52.4s 的 `voice-trim`——界低于同机别的东西的正常用时，就是把负载伪影变成丢掉的一次运行。
- 三条 `endRun` 分支都真跑过：`webServer-start` / silent（AC2，`ac2-final.log`）、`webServer-start` / closed（`force-fire-closed.log`：`port 31865 (server) is not listening, port 2739 (client) is not listening`，EXIT=1 / wall 2033ms）、`browser-launch-or-cases`（`force-fire-rearm.log`，EXIT=1 / wall 11542ms）。
- 另外两处 `execFileSync`（`freePortPair` / `findTakenPorts`）加了 `timeout: 10_000`：它们**同步阻塞事件循环**，子进程不收尾会让 watchdog 自己也永远不开火——同一个缺陷的另一种写法。

### AC5 判定面未被削弱

```
$ grep -c "reuseExistingServer: false" playwright.config.ts   → 2
$ grep -c "retries" playwright.config.ts                      → 0
$ grep -cE "^  test\(" e2e/session-filter.spec.ts             → 5
$ git diff develop --stat -- e2e/session-filter.spec.ts       → （空：该 spec 逐字节未改）
$ grep -c "await expect(" e2e/session-filter.spec.ts          → 45
$ grep -n "^criterion:" goals/AC-101-*.md                     → 7:criterion: npm run test:e2e -- e2e/session-filter.spec.ts
```

`ALL_SESSIONS`、规则字面量、6s 轮询等待、5 条断言一字未动。

### AC6 抗假变体真跑并留输出

变体只做一件事：删掉 `if (isDataDirOwner) { … }` 那个 arm 块，其余一字不动（`setTimeout` 出现次数 2 → 1，端口预检、端口对、sink、命令完全相同）。`ac6-variant.log`：

```
EXIT=124 wall_ms=75006          (timeout 75 = 外部击杀)
  attribution lines: 0          (grep -c 'e2e] watchdog' = 0)
```

即同一构造退回「被外部击杀 / 无归因超时」，而且 75006ms > 60000ms ⇒ 账本里只会留下一句 `acceptance timed out after 60000ms (killed)`。变体已还原：还原后 `sha256sum playwright.config.ts` 仍是 `c4715966…`（与快照同值），`git status --porcelain` **输出为空**（实现在 `5fb9888d` 已提交，故还原后与 HEAD 一致）。

### AC7

`npm run typecheck` → EXIT=0（`ac7-typecheck.log`）。`npm run lint` → EXIT=0，仅剩仓里既有的 warning（`ac7-lint.log`）。

### 门与缓存

`bash scripts/test.sh --for-task gap-ac101-criterion-bounded-under-gate-cap --allow-thin` → EXIT=0（`suite-scope-check: PASS`；本任务 `## Touches` 里没有 `*.test.*`，故 scoped 门读作 `thin`）。随后 `worker-driver.js --write-scoped-gate-cache --develop-sha 5ae2d3ad…` 写入成功（`scoped-gate-cache-written`）。
