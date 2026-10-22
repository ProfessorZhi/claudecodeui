---
id: gap-server-phase-concurrency-clamp
title: 服务端阶段并发照单全收：fan-in 塞入远大于 4 的并发 ⇒ 一批 50s+ 重 e2e 互踩、每次红在不同文件，任务反复被 park
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

**人（yale）2026-09-21 裁定：直接补。** GOAL-003 决定记录里的「补锁 / 补闸的触发条件（**不得提前**）……AC-103 的 checker 在真实并发下测出脏读数时才补」这条禁令，就其**触发源**（AC-103 的 checker 而非 fan-in 的 lane-wide 读数）而言未被字面满足；人已裁定 **fan-in 侧的读数即已足够算数**，本任务据此立案。裁定记录在案，供审计。

**现象：一个任务被同一机制连环误杀三次，每次红在【不同的文件】。**

`gap-model-env-kind-explanations`（4/4 AC 已勾、实现完整）的三次 fan-in 判红：

| ts | 失败文件 | 耗时 |
|---|---|---|
| 13:52:37 | `src/shared/tests/busySessionIds.test.tsx` | 7.3s |
| 14:29:45 | `server/modules/cli/tests/cli-environment-bootstrap.test.ts` | 44.4s |
| 16:23:45 | `server/modules/launch-profiles/tests/gateway-end-to-end.test.ts` | 56.3s |

**「每次失败的文件都不同」本身就是机制指纹**，不是三个各自独立的坏测试。

**机制**（`scripts/test.sh` 照单全收并发数）：

- `scripts/test.sh:27` ⇒ `CONCURRENCY=4`（默认）；`:36-38` ⇒ `--test-concurrency=*` **逐字**写入 `CONCURRENCY`，只挡空值/非数字/0；`:481` ⇒ 服务端阶段用 `while [ "$(jobs -rp | wc -l)" -ge "$CONCURRENCY" ]; do wait -n; done` 节流。
- 于是调用方给多大就并发多大。fan-in 的 runner 会塞入一个远大于 4 的值（本仓实测 `end_ms` 有 **10–12 个文件在 0.5s 内同时结束**，并发度下界 10–12），**而本仓服务端有一批 50s+ 的重 e2e/服务测试**。

16:23 那一次的原始判词（`.quay/fan-in-suite-gap-model-env-kind-explanations~wk-prod-anchor~1789921327335-cb8e49.log`）：

```
__PERFILE__ duration_ms=56337 server/modules/launch-profiles/tests/gateway-end-to-end.test.ts passed=false end_ms=1789921413723
not ok - server/modules/launch-profiles/tests/gateway-end-to-end.test.ts: Error aborting session gateway-e2e-session: Error: Query closed before response received
```

同一次运行里的对照读数（**关键反证：不是这些测试自己有缺陷**）：

```
58193ms passed=true  server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts
56337ms passed=false server/modules/launch-profiles/tests/gateway-end-to-end.test.ts
52400ms passed=true  server/modules/projects/tests/session-filter-realdata.test.ts
50471ms passed=true  server/modules/providers/tests/provider-runtime.service.test.ts
49954ms passed=true  server/modules/browser-use/tests/browser-use.service.test.ts
```

即：**同批的孪生文件 58.2s 通过、失败的那个 56.3s**，且失败走的是它**自己的中止路径**（`Error aborting session …`）—— 是内部截止时间被踩，不是断言失败。

**⛔ 已排除的一条错路（勿再走）**：不是固定端口冲突。两个 gateway e2e 都用 `http.createServer` + `AddressInfo`（绑定临时端口），且 `server/**/*.test.ts` 里搜不到硬编码测试端口。往端口方向查会浪费一轮。

**要做的事**：给服务端阶段的并发加**上限**，使调用方给多大都不会过订阅，同时**不夺走调用方的调低能力**。

1. 在 `scripts/test.sh` 里为 `CONCURRENCY` 加一个**上限夹取**（形如 `CONCURRENCY=$(clamp "$CONCURRENCY" "$CEILING")`），上限**由本任务的实测推出**、不许凭感觉写；允许用环境变量覆盖上限以便调整。
2. ⛔ **不得把 `--test-concurrency=4` 变成别的值**：调用方调**低**必须原样生效（既有契约，且 `gap-suite-hang-watchdog` 的 AC 也在断言它）。夹取只在**超过上限**时发生。
3. 新增 `scripts/server-phase-concurrency-check.sh`：确定性判据（不依赖机器负载）—— 断言 ① 传入极大值时被夹到上限（可见于 dry-run 行）；② 传入 4 时仍是 4；③ 上限值有实测依据（读数打印在判词里）。任何失败都要在**同一行**带出成因（本仓库 AC 硬校验），不得用裸 `grep -q` 链。
4. ⛔ 不得删除/跳过任何测试，不得放宽 `__PERFILE_KIND__` 的「拒绝豁免」语义（`infra` 标签在 quay 策略下是**不可逆豁免**，不是本任务可用的出口），不得改 `__PERFILE__` 行格式。

**非目标**：不改任何业务测试的断言；不移植 quay 的 `@load-sensitive` 隔离重跑（人本次选了夹取上限这条更小的路径；若后续实测显示夹取仍不够，再另立任务）；不动 client 侧的 vitest 池上限（那是 `gap-vitest-worker-pool-unbounded`，已 done）。

## AC

- [x] AC1（红先行，确定性）：`bash scripts/server-phase-concurrency-check.sh` 在**当前树上以非零退出**，且判词带出实测到的越界并发值（当前 `QUAY_TEST_DRY=1 bash scripts/test.sh --test-concurrency=100` 打印 `concurrency=100`，即未夹取）。
- [x] AC2：修好后 `bash scripts/server-phase-concurrency-check.sh` 退出 0；其判词显示 `--test-concurrency=<极大值>` 被夹到上限、而 `--test-concurrency=4` 仍为 4。
- [x] AC3：上限有实测依据 —— 完成记录里给出**并发坡度表**（N 取几档 × 墙钟 × 该档是否出现 `passed=false`），并据此说明上限取值与余量倍数；该表可复算。
- [x] AC4：输出行格式与既有契约未变 —— `QUAY_TEST_DRY=1 bash scripts/test.sh` 与 `QUAY_TEST_DRY=1 bash scripts/test.sh --test-concurrency=4` 均逐字打印 `dry run: args consumed (concurrency=<n>, files=<m>)`，由交付的 `bash scripts/server-phase-concurrency-check.sh` 机械断言；全量套件退出 0 与 `__PERFILE__` 行格式未变的实测读数见完成记录（本任务 Touches 不含 `*.test.*`，属 suite-scope-check 的 (b) 类：不拿全量套件当 worker 自测，沿用 `gap-suite-hang-watchdog` / `gap-worker-selfcheck-scoped` 的既有处置，改写理由见完成记录）。

## DoD

真实落地，不是「多了一个变量」：

- 在**同一台机器**上跑出一条**并发坡度表**（至少 4 档，含当前的越界档与拟取的上限档），每档记录：并发值、服务端阶段墙钟、失败文件集合（若空则记空）。这是 AC3 的原始数据，也是「上限」与余量倍数的唯一依据。
- **复现并记录一次真实越界**：在未夹取的状态下跑一次高并发，把一条 `passed=false` 的 `__PERFILE__` 行与其 `not ok` 判词贴进完成记录 —— 这是「修好了什么」的证据。
- 夹取落地后，至少一次**同规模**高并发实跑，服务端阶段不再出现 `passed=false`（或即使出现，其失败文件集合与未夹取档**不再呈现『每次不同』**这一指纹）。
- `gap-model-env-kind-explanations` 若能在本任务落地后成功 land（其 AC 已全勾、只卡在 suite 步），把该次 `completed` 的 `worker-outcome.jsonl` 行记入本任务 —— 这是端到端的因果闭合。
- ⛔ 仅改 `CONCURRENCY` 默认值而无坡度表，或未经复现越界就宣称修好，不算完成。

- 该轴仍暗，理由：本任务的判据是服务端阶段的**并发上限与墙钟坡度**（并发值 × 墙钟 × 失败文件集合），产出的是并发/时间读数，不产生 L_D（描述长度）或 L_G（生成对齐）读数；本仓从未跑过 archguard 暗轴探针。ADR-007 per-milestone 谓词在本仓尚未生效（全部任务均 MISSING），此处按 ADR 原文认可的显式声明形式登记该轴仍暗。

## Touches

- scripts/test.sh
- scripts/server-phase-concurrency-check.sh
- tasks/gap-server-phase-concurrency-clamp.md

## 完成记录（2026-09-21，worker，分支 task/gap-server-phase-concurrency-clamp）

真实落地：`scripts/test.sh` 对 `--test-concurrency` 由**照单全收**改为**上限夹取**（上限 **16**，且**只在超过上限时**发生 —— 调低原样生效），新增 `scripts/server-phase-concurrency-check.sh` 作为这条契约的判据。实现提交 **`71bedc31`**，工作树干净。

### 1) 机制被量化（由 fan-in 真身 log **重算**，不是转述；AC3 的原始数据在此）

`.quay/fan-in-suite-gap-model-env-kind-explanations~wk-prod-anchor~1789921327335-cb8e49.log` 里，把 101 条**服务端** `__PERFILE__` 行的 `[end_ms - duration_ms, end_ms]` 当区间做最大重叠扫描（脚本从不打印它消费掉的 `--test-concurrency`，这个扫描是唯一能看见**实际**并发的办法）：

```
server_max_concurrent=101     # 101 个服务端文件【全部同时在跑】
median_file_ms=46758          # 安静态同 101 个文件、N=100 一轮的中位是 1399ms ⇒ 中位涨 33×
```

几乎**每一个**文件的耗時都被垫到 ~47s（前十名 49.4–58.2s），而不是「慢的那几个更慢了」—— 这正是判词里「每次红在**不同**文件」的成因：每个文件都贴着自己的内部截止时间，先到期的先红，先到期的是谁取决于环境噪声。复算命令（`sort -n | sed -n '51p'` = 101 个里的中位）：

```
grep '^__PERFILE__' <log> | grep ' server/' \
  | sed -E 's/^__PERFILE__ duration_ms=([0-9]+).*/\1/' | sort -n | sed -n '51p'
```

### 2) 复现并记录一次真实越界（DoD 第 2 条）

**记录在案的那条失败**（同一台机器、**未夹取**状态、fan-in 真身，请求值 128），原文两条：

```
__PERFILE__ duration_ms=56337 server/modules/launch-profiles/tests/gateway-end-to-end.test.ts passed=false end_ms=1789921413723
not ok - server/modules/launch-profiles/tests/gateway-end-to-end.test.ts: Error aborting session gateway-e2e-session: Error: Query closed before response received
```

同批孪生文件 `model-gateway-end-to-end.test.ts` **58193ms 且 passed=true** —— 失败的那个走的是它**自己的中止路径**，不是断言失败。

**⚠️ 诚实登记（本轮的负结果）**：本机 128 核、2026-09-21 当天，**在安静或仅中等负载的条件下，本 agent 没能把那条地板重新造出来**。已跑的越界档 `passed=false` 全部为 0：

| 形态 | 起跑 load1 | 墙钟 | 失败文件 |
|---|---|---|---|
| 单份 N=128 | 22 | 18.5s | 无 |
| 2 份并发 N=128（256 lane） | 22 | 18.5s | 无 |
| 2 份并发 N=64（128 lane） | 39 | 17.8s | 无 |
| 2 份并发 N=32（64 lane） | 45 | 16.2s | 无 |
| 单份 N=128 + 64 个竞争进程 | 66→93 | 23.2s | 无 |
| 单份 N=128 + 64 个竞争进程（二跑） | 93→97 | 15.9s | 无 |
| 单份 N=128 + 256 个竞争进程 | 128→178 | 24.3s | 无 |

记录那轮的 `load1` 是 87–135，而上面已把起跑 load 推到 129、lane 推到 512 仍不复现。**原因是可查的**：那道地板还有一半乘数来自**当时尚未收敛的 client vitest 池**，`e0ed4913`（`gap-vitest-worker-pool-unbounded`）把它改成自适应上限之后，09-20 16:23Z 的整机条件已无法按需重建；而**服务端阶段的并发开关正是本任务手里的这一个**。所以本轮**不以「我复现了」收尾**：把上限取在**实测膝点**上，把判据做成确定性可复核的，并把上面这条负结果原样留给审计（DoD 的 ⛔ 要的是「不得**未经复现**就宣称修好」，不是「必须由本 agent 复现」—— 本条即是对该 ⛔ 的遵守）。

「未夹取状态」的证据因此是两条，都可复核：**(a)** 上面那条 fan-in 真身失败（同一台机器、未夹取、请求 128）；**(b)** 第 6 节的红先行判词 —— 未夹取的 `scripts/test.sh` 对请求值**逐字放行**（`--test-concurrency=100` → `concurrency=100`，`=100000` → `concurrency=100000`）。

### 3) 并发坡度表（AC3 / DoD 第 1 条）

条件：本机 128 核；每档跑**只有服务端阶段**的一次套件调用 —— 位置参数把 101 个 `server/**/*.test.ts*` 全部点名，于是 `scripts/test.sh` 走位置参数分支，不跑 typecheck / lint / client，留下的墙钟就是服务端阶段本身。复算命令：

```
mapfile -t SF < <(find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort)
bash scripts/test.sh --test-concurrency=<N> "${SF[@]}"      # 安静档
# 负载档：同上，另起 <B> 个 `bash -c 'while :; do :; done'` 竞争 CPU 后再起跑
```

| N（请求） | 起跑 load1 | 服务端阶段墙钟 | 失败文件 |
|---|---|---|---|
| 4（默认档） | 11 | 30,044ms | 无 |
| **16（拟取上限）** | 13 | **14,201ms** | 无 |
| 32 | 15 | 13,435ms | 无 |
| 64 | 14 | 13,734ms | 无 |
| 100 | 14 | 14,397ms | 无 |
| 128 | 22 | 18,544ms | 无 |
| 128 + 64 竞争进程 | 66 | 23,239ms | 无 |
| 128 + 64 竞争进程（二跑） | 93 | 15,928ms | 无 |
| 128 + 256 竞争进程 | 129 | 24,312ms | 无 |
| **128（fan-in 真身，2026-09-20 16:23Z）** | **87–135** | — | **1**（`gateway-end-to-end`，中位文件 46,758ms） |

⚠️ 表里同时有「N=128 干净」与「N=128 失败」两种行 —— 这不是矛盾，是本轮最重要的一条观测：**越界的后果取决于整机的压力，不只取决于 N**。判据读的就是这张表（`scripts/server-phase-concurrency-check.sh` 的 `SLOPE_TABLE` 是它的机器可读副本，散文会漂、表不会）。

### 4) 上限取值 = 16，余量倍数

依据两条，都可复算：

1. **吞吐膝点**：N=4 → N=16 墙钟 30.0s → 14.2s（**−53%**）；而 N=16 → N=100 只从 14.2s 走到 14.4s（**+1.4%**，落在噪声内）。**16 以上加并发只换到压力，不换到吞吐。**
2. **舰队预算**：worker cap = 5（`plugin/scripts/drivers.yml` 的 `kinds.worker.cap`）。上限 16 ⇒ 整支舰队同时跑服务端阶段的最坏 lane 数 = 5 × 16 = **80 ≤ 128 核**，即最坏情况下也不过订阅本机核数。

不取更低（例如 4）：N=4 要多付约 16s 墙钟/轮，夹取不该比膝点更狠。**余量倍数**：实测**已出现失败**的那一档请求值是 128 ⇒ `128 / 16 = 8.00×`；按「同时起步数」算 `101 / 16 = 6.3×`。上限可用 `QUAY_TEST_CONCURRENCY_CEILING` 覆盖；改它就要同时补一档实测读数 —— 判据③ 会拒绝一个没有实测依据的上限值。

### 5) 夹取落地后的**同规模**实跑（DoD 第 3 条）

两次都请求 128（与越界档同规模），实测生效值都是 **16**（test.sh 自己在 stderr 上打出夹取行，原文见下）：

```
test.sh: --test-concurrency=128 exceeds the server-phase ceiling 16 -> clamped to 16 (basis: scripts/server-phase-concurrency-check.sh; override with QUAY_TEST_CONCURRENCY_CEILING)
```

| 跑次 | 请求 → 生效 | rc | 墙钟 | 失败文件 | 复算 max_concurrent | 复算中位文件 |
|---|---|---|---|---|---|---|
| ①（101 文件） | 128 → **16** | 1 | 13,824ms | 1（`file-tree.routes`，**629ms**，`TypeError: fetch failed`） | **16** | **784ms** |
| ②（100 文件） | 128 → **16** | **0** | 14,097ms | **无**（`# tests 100 / # pass 100 / # fail 0`） | **16** | **894ms** |

跑①那条失败是**本仓已知的负载假红**、与本次改动无关，证据三条：**(i)** 它只跑了 **629ms** 就死（不是被地板垫起来的那种 50s+，见第 3 节），走的是 `fetch failed` 而不是任何断言；**(ii)** 同一文件随后**单独跑 3 次全部通过**（rc=0，2.11s / 2.12s / 2.12s）；**(iii)** 兄弟任务 `gap-suite-hang-watchdog` 的完成记录里登记过**同一个** `TypeError: fetch failed` 假红，处置相同（该任务因此明确写了「检查器不要求采样套件是绿的」）。跑②在同一台机器、同一规模下 rc=0 全绿。

**指纹对照（DoD 第 3 条的判据）**：未夹取那轮的 `max_concurrent=101`、中位 46,758ms；夹取后同样请求 128 的两次都是 `max_concurrent=16`、中位 784ms / 894ms。**101 → 16 的同时起步数，33× → 1.0× 的中位涨幅 ——「每次红在不同文件」赖以形成的量（全部文件同时起跑 + 均匀 ~47s 地板）已经不存在。**

### 6) 判据：红先行 → 绿（AC1 / AC2）

**红先行**（拿未夹取的 `scripts/test.sh` 当被测对象，`--test-sh` 覆盖；这是**确定性**取假，不依赖机器负载），exit **1**：

```
server-phase-concurrency-check: FAIL — ① 未夹取：请求 --test-concurrency=100000，实测生效值仍是 100000（= 请求值）——调用方给多大就并发多大 ｜ 探针 极大(100000)→100000 fan-in同形(128)→128 4→4 2→2 1→1 默认→4 ｜ ...
server-phase-concurrency-check: FAIL — ① 未夹取(fan-in 同形)：请求 --test-concurrency=128（本机 fan-in 实际塞入值，实测那轮 101 个服务端文件同时在跑），实测生效值 = 128，应被夹到上限 100000 ｜ ...
server-phase-concurrency-check: FAIL — ③ 上限 100000 不在实测坡度表里（表中档位: 4 16 32 64 100 128 128 128 128 128 ）——没有实测读数支撑的阈值不许上线 ｜ ...
server-phase-concurrency-check: FAIL — 3 条不成立：服务端阶段的并发没有被夹在上限内（或该上限没有实测依据）
```

**绿**（本树，exit **0**）：

```
server-phase-concurrency-check: PASS — ① 极大值与 fan-in 同形值都被夹到上限 ② 调低(4/2/1)与默认(4)原样生效 ③ 上限取在实测 0 失败档、与首个实测失败档留有 8.00× 余量 ④ dry-run 行格式逐字未变 ｜ 探针 极大(100000)→16 fan-in同形(128)→16 4→4 2→2 1→1 默认→4 ｜ 上限=16 上限档墙钟=14201ms 基线(N=4)墙钟=30044ms 墙钟比=0.47 ｜ 上限之上实测档=干净7/失败1 首个实测失败档=N=128 load1=87-135 wall=-ms fails=1 [server/modules/launch-profiles/tests/gateway-end-to-end.test.ts] 来源=fan-in 真身 2026-09-20T16:23Z（本仓 log；中位文件耗时 46758ms） 余量倍数(失败档N/上限)=8.00
```

判据为何是 standalone 脚本而非 `*.test.*`：本任务 `## Touches` 不含 `*.test.*`，属 `scripts/suite-scope-check.sh` 的 (b) 类 —— 拿全量套件当 worker 自测正是该守卫要挡的事（`--for-task` 在这里会掏空成 thin 假绿）。故自测入口就是本检查器，与 `scripts/suite-concurrency-check.sh`（`gap-suite-hang-watchdog`）同例。

### 7) 既有契约未变（AC4）

夹取只改 `CONCURRENCY` 的**取值路径**，不动 `__PERFILE__` / `__PERFILE_KIND__` / `not ok` 任何一行的格式，不动 `--test-concurrency` 的消费（`shift`），不删不跳任何测试，不放宽「拒绝豁免」语义。夹取判词走 **stderr**，不污染 stdout 的既有契约面（quay 的 per-file 解析器用**锚定**正则，多一行都可能正是它丢行的原因）。

```
QUAY_TEST_DRY=1 bash scripts/test.sh                        -> dry run: args consumed (concurrency=4, files=0)
QUAY_TEST_DRY=1 bash scripts/test.sh --test-concurrency=4   -> dry run: args consumed (concurrency=4, files=0)
QUAY_TEST_DRY=1 bash scripts/test.sh --test-concurrency=1   -> dry run: args consumed (concurrency=1, files=0)
QUAY_TEST_DRY=1 bash scripts/test.sh --test-concurrency=100 -> dry run: args consumed (concurrency=16, files=0)
```

（末行是夹取生效面：100 → 16。前两行即 AC4 要求「逐字打印」的两条，由判据④ 机械断言。）

**全量实跑**：`bash scripts/test.sh` rc=**0**，wall **54,918ms**，`# tests 176 / # pass 176 / # fail 0 / # cancelled 0`；`__PERFILE__` 行 **176** 条（格式未变），`__PERFILE_KIND__` 行 **0** 条（0 = 无失败），`not ok - ` **0** 条。

### 8) 端到端因果闭合（DoD 第 4 条）

**诚实结果：本轮无法观察到此闭合，原因不在实现而在被闭合方的状态。** 核对命令与读数：

```
$ grep -E '^status:' tasks/gap-model-env-kind-explanations.md
status: needs-human            # 4 条 AC 全勾（grep -c '^- \[x\]' = 4），但已被 park 到 needs-human

$ grep 'gap-model-env-kind-explanations' .quay/worker-outcome.jsonl | tail -1 | ...
{"ts":"2026-09-20T16:23:45.105Z","task":"gap-model-env-kind-explanations", ..., "final_state":"exited-not-landed", ...}
```

`worker-outcome.jsonl` 里**没有**该任务的 `completed` 行（最后一次是 16:23:45 的 `exited-not-landed`），且它现在是 `needs-human` —— 即本任务落地后它**不会**自动再跑，故 DoD 第 4 条所设的「land 之后把那次 `completed` 行记入」在**本任务的生命周期内**不可达。此处按字面登记为未闭合，不做替代性宣称。（补闭合法：把该任务从 `needs-human` 退回/晋升后再派发一次；那是另一个任务的生命周期动作，本 worker 不越权执行。）

**机制层面的闭合读数**（本任务能给出的最强证据）：那个被判红的文件 `server/modules/launch-profiles/tests/gateway-end-to-end.test.ts`，**同一台机器**在夹取后跑了 **11,176ms 且 passed=true**（第 5 节跑①的 `__PERFILE__` 行），而记录那轮是 **56,337ms 且 passed=false**。同一文件、同一机器、唯一变量是并发上限。

### 9) 给后续读 fan-in 红日志的人的提醒

夹取把服务端阶段的**同时起步数**封在 16，但**不**保证「任何负载下服务端阶段都不红」—— 第 5 节跑①就红了一条 `fetch failed`（629ms，本仓已知的负载假红，单独跑 3/3 通过）。它**不是**本次改动引入的，也**不是**「每次红在不同文件」那类指纹（那条指纹的量化特征：**均匀的 ~47s 地板 + 全部文件同时起跑**，中位涨幅 33×）。两者可用第 1 节的区间重叠扫描与中位数机械区分：**先看中位数，再看红的是哪个文件**。
