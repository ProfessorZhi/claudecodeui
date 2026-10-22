---
id: gap-suite-criterion-wallclock-budget
title: AC-103 判据的墙钟超出 goal gate 硬上限：默认路径 ≈ 2× 最重服务端文件（新的 32s 成员）⇒ 实测 66–67s >
  60000ms，被击杀后记成 fail，与它要检测的「互拖红」同形
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-103
---
## Proposal

**AC-103 现在是假红，但红的不是它断言的那件事。**

判据 `bash scripts/suite-concurrency-check.sh` 的**判定语义此刻是绿的**：两份 client 套件 90 files / 626 tests 全过、`rc=[0 0]`；签名计数 `STACK_TRACE_ERROR=0`、`Timeout calling "fetch"=0`；服务端逐文件中位耗时 安静 `1013ms` vs 并发 `1132ms` / `1114ms` ⇒ 劣化比 **1.10× / 1.12×**，远低于 K=4。也就是说「两个全量套件互不拖红」这条不变量**成立**。

它假红的原因是**判据自己跑不完**：

```
.quay/gate-events.jsonl
2026-09-22T16:40:03.803Z  actor=goal-sweep  AC-103  verdict=fail
  reason: acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout
2026-09-22T16:41:05.792Z  actor=goal-cli    AC-103  verdict=fail
  reason: acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout
（两次的 criterionHash 都是 790fab152ee594aa）
```

**criterionHash 自 2026-09-22T15:38:27.706Z 那次 `pass` 起一个字都没变** —— 判据文本没变，变的是**运行时长**。

### 实测：从 34s 到 67s，一步到位

| 运行目录 | 墙钟 | 最重的服务端文件 |
|---|---|---|
| 2026-09-22T07:55 → 23:37（连续 20 次） | **33–35s**（一次 45s） | `providers/tests/model-gateway-end-to-end.test.ts` = **13,625ms** |
| 2026-09-23T00:39:03 | **66s** | `debug-agent/tests/debug-agent-external-write.test.ts` = **32,148ms** |
| 2026-09-23T00:40:05 | **67s** | 同上 = **32,162ms** |

两相拆分（`*.meta` 的 `start/end`）：

- 安静相 `quiet-readout-0`：**33.2s / 33.3s**（该文件 32.1s）
- 并发相 `concurrent-*`：**33.7s / 33.8s**（该文件 32.6s）

这个文件的成本是**内在的，不是争用造成的**：安静下 32.1s、并发下 32.6s，只差 **1.4%**。服务端文件数同时从 104 涨到 109（+5%），但相的墙钟跟的是 **max** 而不是条数，所以增长源只有一个。

⇒ 判据的地板 ≈ `2 × 32.1s` ≈ **64–67s**，**与负载无关地越过 60000ms**。它把整张服务端套件跑**两遍**（安静一遍 + 并发一遍），而两遍的地板都是同一个 32s 文件。

### 这个上限在本仓升不动（这是本任务形状的决定性事实）

- 插件包 `goal-driver.js` 里四处 goal-criterion 调用点**全部硬编码** `timeoutMs`：`:38403` `6e4`、`:38557` 经 `SWEEP_CRITERION_TIMEOUT_MS = 6e4`、`:38736` `6e4`、`:39269` `6e4`；
- `QUAY_ACCEPTANCE_TIMEOUT_MS`（`vendor/quay/dist/quay.js:7599` 那条 env 通道）在 `goal-driver.js` 里**从未被读取**；
- 本仓**没有** `.quay/gates.yml`，`.quay/config.yml` 里**没有** `gates:` 段，`packages/quay` 也**不存在**。

⇒ 判词的「raise gates.yml timeoutMs / --timeout」在本仓是一条**死路**。判据必须**在 60000ms 内跑完**，没有第二条路。

### 归因缺陷（这才是这条 AC 的老本行）

被 SIGKILL 的判据记录成 `verdict=fail`、理由是「超时」—— 与「两个套件互拖红」**同形**。账本读者分不出「并发把套件拖红了」和「判据没跑完」。判据其实**已经在判词行里打印自己的墙钟**（`scripts/suite-concurrency-check.sh:195` 的 `墙钟=%sms/60000ms`），但 `differential_verdict`（`:230`）**从不读 `R_WALL_MS`**，全脚本没有任何预算闸 —— 所以超预算唯一可能的表达形式就是 SIGKILL。

### 上一条修复为何没兜住

<!-- dedup-ref -->
`gap-concurrency-verdict-discriminates-flake-from-drag`（done）在它自己的读数里**点名过这条机制**（其 body 第 41 行：`acceptance timed out after 60000ms (killed)` … 「判词退化成『超时』、读数丢失」），并且它的 AC5 写着「判据自身墙钟实测打印且 < 60000ms …… 超时不是判据的一种红」，勾为 `[x]`。但 AC5 是被当作**瞬时读数**验收的，而不是**机制**：判据里没有任何东西约束自己的成本，也没有任何东西察觉自己的关键路径随套件增长。于是该读数在 15:38 为真、在 32s 成员落地后为假，账本翻红。判据自己的 `--help` 其实已经承认过这个约束 —— `--full-suites` 一行写着「≈2×55s，超出 60s gate 预算」—— 但**默认路径**没有对应的闸。`gap-ac101-criterion-concurrency-determinism`（done）在同一处也留了明文残留：「测试期仍可超过 60s …… 收窄它们等于削弱判据，本任务明文禁止」。

### 两条必须落地的杠杆（机制由实现者选定，证据指向上面的读数）

1. **把默认路径的成本压回上限内（带余量）。** 证据指向的唯一路线：**别在一次调用里付两遍最重文件的账** —— 例如把安静基线做成**带再校验的持久读数**（键含 criterion 哈希 + 服务端文件集），命中时判据只跑**一相**（≈34s）；键变了才重量。任何等价做法都行，但差分必须仍然是真的：安静红名单与中位分母要么是**活读数**，要么其新鲜度可被机械证明（键、时间、provenance 三者缺一不可）。
2. **让超预算自报，而不是被击杀成假红。** 在 `differential_verdict` 里加预算闸（新增 `--budget-ms`，默认 60000，并打印告警阈值）；超预算时 **exit 3（not-evaluated）** 并在判词里点名预算与实测墙钟。插件的 frozen sweep **已经**把子进程 exit 3 映射成 `not-evaluated`（`goal-driver.js:38558`），所以这条通道是现成的 —— 它让「没跑完」与「互拖红」在账本里**不再同形**。

**⛔ 明令禁止（照抄 GOAL-003 的非目标）**：删除或跳过任何测试；缩 `scripts/test.sh` 的收集面；放宽 K；把最重的服务端文件从**任一相**里排除；在文件集或判据变化后**不重新校验**就复用安静基线；靠削弱 `--self-test` 的合成控制来让自检变绿。

**一条标为未核实、供实现者自行判定的线索。** `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 的 32s 由 `POLL_INTERVAL_MS = 6_000`、`DRAIN_SILENCE_MS = 6_500`、`MAX_LOAD_ATTEMPTS = 3`、`LOAD_ATTEMPT_MS = 8_000` 这一组常量给出，且该文件**已经把各臂并发跑**（其自身注释，第 721 行）。若它的 load attempt 是**重试**、只有争用下才需要耗尽，那么在**安静**读数里也吃满三次本身就是可疑的、该文件存在诚实的余量。这是**假设，不是结论** —— 我没有读它的臂逻辑。⛔ 无论怎么改，被移走的断言必须换成**等强**的断言；削弱该文件的理解被 GOAL-003 的非目标明文禁止。

## AC

- [x] AC1 — **真实并发下判据绿，且自身墙钟 ≤ 45000ms**（60000 硬上限的 0.75 倍，留余量）。连跑 3 次 `bash scripts/suite-concurrency-check.sh`，每次 rc=0，且判词行里 `墙钟=<X>ms/60000ms` 的 X **每次都 ≤ 45000**。判据不满足时必须在判词里**带出 X 与预算**（否则「读数留在判词里」这条自身就不成立）；运行记录落在 `.quay/suite-concurrency-check/<ts>/`。
- [x] AC2 — **不缩覆盖面（抗假）**。AC1 那 3 次运行里，`quiet-readout-*` 与 `concurrent-readout-*` 的 `__PERFILE__` 行数**各 ≥ 109**，且 `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在**两组里都出现且 `passed=true`**；`git diff develop --name-status` 里没有删除任何 `*.test.*`，也没有新增 `skip` / `todo`。失败时打印实际行数与缺失的文件名。
- [x] AC3 — **不变量未被削弱**。`bash scripts/suite-concurrency-check.sh --self-test` rc=0，8 条控制按标签打印且 **C1/C3/C5 绿、C2/C4/C6/C7/C8 红**；`--drop-pool-cap`、`--concurrency 1`、`--k 1` 三条取假形态**各自非零退出**，`--drop-pool-cap` 的实测劣化比 **> K**，且三条都把实测读数打进判词。失败时指明是哪一条控制/哪一条取假形态、实测读数是多少。
- [x] AC3b — **超预算不再伪装成拖红**。`bash scripts/suite-concurrency-check.sh --budget-ms 1000` 的 rc=**3**（not-evaluated），判词点名**预算与实测墙钟**；同一次运行**不得**打印拖红判词，**不得**被 SIGKILL（rc=137 / 判词缺失 / 无判词行都算不达标）。失败时打印实际 rc 与完整判词行。
- [x] AC3c — **预算可声明、可读、不改变判定语义**。不带 `--budget-ms` 时判词行打印的预算字面量是 `/60000ms`，`--budget-ms 45000` 时是 `/45000ms`；`--help` 列出该开关；`--self-test` 在任意 `--budget-ms` 下 8 条控制的结果**逐条不变**。失败时打印实际字面量。
- [x] AC4 — **预算闸有体外测试**。新增 `scripts/suite-concurrency-check.test.mjs`，用 `node --test scripts/suite-concurrency-check.test.mjs` rc=0 覆盖：默认预算字面量、`--budget-ms` 覆盖、超预算 ⇒ exit 3 且判词点名预算、（正面控制）预算充裕 ⇒ 不因预算红。并 `npm run test:scripts` rc=0（该 runner 的 glob 是 `scripts/**/*.test.mjs`，新文件自动被发现，无需注册）。失败时打印实际 rc 与 `# fail` 计数。

## DoD

**真实落地判据：不是「脚本里出现了 budget 这个词」。** 要求在同一台机器上留下读数：

1. **3 次真实并发实跑** —— 各自 rc=0、判词行含墙钟与预算、X ≤ 45000（运行目录留在 `.quay/suite-concurrency-check/`）；
2. **1 次 `--self-test`** —— 8 条控制的标签与结果；
3. **3 条取假形态实跑** —— `--drop-pool-cap` / `--concurrency 1` / `--k 1`，各自非零退出 + 实测读数；
4. **1 次 `--budget-ms 1000`** —— rc=3、判词点名预算；
5. **1 次 `node --test scripts/suite-concurrency-check.test.mjs`** —— rc=0。

⛔ 仅改判词而无实跑不算完成。⛔ 不得靠删除/跳过任何测试、缩 `scripts/test.sh` 的收集面、放宽 K、或把最重的服务端文件从任一相里排除来达绿。

**必须写进 `goals/AC-103-*.md` 的 `expect` 的诚实契约。** 现在的 `expect` 仍声称「判据自身墙钟实测打印（实测 32.9–38.5s < goal gate 硬上限 60000ms）」—— 这句已假，且它是把 AC5 当瞬时读数验收的同一处病根。改成诚实的契约：**判据在判定语义上对负载不变（差分 + K），但它必须在 gate 的 60000ms 上限内跑完；跑不完时自报 `not-evaluated`（exit 3），不是红。** 并把「上一条修复为何没兜住」的一段（见 Proposal）留在任务体里供审计。

**形状纪律。** 若本次改动触及 `server/**`，按 `AGENTS.md` 先加载 `$backend-module-standards` 并只对后端代码施用；若触及 `src/**`，加载 `$frontend-module-standards` 并只对前端施用。改完跑 **`npm run lint`**（`oxlint src/ server/ scripts/`）——裸 `npx oxlint` 退出 1 是本仓既有现象，不是本次引入的红。

## 完成记录

判据改了两件事，判定语义（差分语义 + K）一个字没动：①**默认路径复用「带再校验的持久安静基线」**——键 = 判据 sha256 + 读数 argv + 服务端文件集指纹 + 相关环境；命中前再验三样（键相等、日志 sha256 一致、日志标签逐个覆盖本次文件集），缺一即重量。于是两遍最重服务端文件压成一遍。②**预算闸**——`--budget-ms`（默认 60000，告警阈值 45000），预检 / 后检 / 每相剩余预算夹取三层；装不下就 exit 3 `not-evaluated`，判词点名预算与实测墙钟，⛔ 不是红。预算只决定「要不要开工」，不参与判红/判绿。冷启动那一次是 not-evaluated（自报预算与实测墙钟），下一次起复用基线转绿——这条契约已写进 `goals/AC-103-*.md` 的 `expect`。

实测（本机，develop 最新形状，服务端 111 文件/相）。AC1：连跑 3 次 rc=0，判词 `墙钟=` 35387 / 34590 / 34592 ms，均 ≤ 45000；冷缓存那次 exit 3，判词点名预算 60000ms 与实测墙钟 33818ms。AC2：三跑每相各 111 条 `__PERFILE__`（≥ 109），最重的 `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在安静与并发两组都 `passed=true`；`git diff develop --name-status` 只有本任务声明的三个文件，无删除的 `*.test.*`、无新增 `skip`/`todo`。AC3：`--self-test` rc=0，8 条控制按标签打印，C1/C3/C5 绿、C2/C4/C6/C7/C8 红；`--drop-pool-cap` rc=1 且劣化比 4.71× > K=4，`--concurrency 1` rc=1，`--k 1` rc=1（1.11× > K=1），三条都把实测读数打进判词。AC3b：`--budget-ms 1000` rc=3，判词点名预算=1000ms 与实测墙钟=427ms，同一次运行无拖红判词、未被 SIGKILL（墙钟 469ms）。AC3c：默认判词为 `/60000ms`、`--budget-ms 45000` 得 `/45000ms`，`--help` 列出该开关，`--self-test --budget-ms 1` 的 8 条控制逐条不变。AC4：新增 `scripts/suite-concurrency-check.test.mjs`（6 例），`node --test` rc=0，`npm run test:scripts` rc=0（72 例 0 失败）。判定语义有一条现场旁证：其中一跑的并发组出现 1 个红文件，隔离复跑绿 ⇒ 判词记为「偶发」并照常 PASS，而不是判红——差分语义在真跑里确实在起作用。

运行记录落在 `.quay/suite-concurrency-check/<ts>/`（`.gitignore` 的 `.quay/*`）。

实现期发现并修掉的一处自身缺陷（判据自己说假读数）：冷启动那一次会在【并发相预检】处 exit 3，走不到结尾的 `write_state`，而「安静相一跑完就落盘」的那次写发生在 median/n 赋值之前——记录里会永久留下 `median_ms=0 / n=0`，此后每次复用命中都把它原样抄进判词（判词自称基线量到 0 个文件，其实量到 111 个）。已把 median/n 挪到该相结束处计算（与收集段同式，重算幂等），并由 `scripts/suite-concurrency-check.test.mjs` 的 T6 反证：去掉修复即红（`实得 n=0`）。

## Touches

- scripts/suite-concurrency-check.sh
- scripts/suite-concurrency-check.test.mjs (new)
- goals/AC-103-同时运行的两个全量套件互不拖红.md
- tasks/gap-suite-criterion-wallclock-budget.md
