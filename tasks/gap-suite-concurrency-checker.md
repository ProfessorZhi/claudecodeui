---
id: gap-suite-concurrency-checker
title: 并发判据读数：新增 scripts/suite-concurrency-check.sh，让 AC-103 从「缺文件」变成可复跑的并发检查
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-103
---
## Proposal

AC-103 现在是一条**纯红**判据：`criterion: bash scripts/suite-concurrency-check.sh`，gate exit 127「No such file or directory」。**判据文件不存在**——这与 AC-102 当初的起法一致（先立一条必红的读数，再由任务把它变成可复跑的检查）。

本任务只做那一件事：**建立并发判据的读数**，使 AC-103 从「文件不存在」变成「跑得起来、且当前仍红/未来能绿」。

要做的事：
1. 新增 `scripts/suite-concurrency-check.sh`：在同一台机器上**并发**（不是串行）启动 2 个 client 套件（`npx vitest run`），等待两者结束，然后断言 ①两者退出码均为 0；②两份输出中 `STACK_TRACE_ERROR` 与 `[vitest-worker]: Timeout calling "fetch"` 的计数均为 0；③打印安静基线与并发两组的服务端逐文件中位耗时对比，并在并发组超过安静基线的 K 倍时以非零退出并**带出原因**（K 先由首次实测钉死，写回 AC-103 的 expect）。
2. 脚本必须在失败时把**成因写在判词里**（这是本仓库 AC 的硬校验：criterion 的任何失败退出都必须同行输出原因），不得用裸 `grep -q` 链。
3. 并发治理本身不在本任务范围：client 侧 worker 池上限由既有任务承担（其被本条判据观测）。

**⚠️ 本脚本刻意不进套件 glob**：`scripts/test.sh` 只收集 `server/**/*.test.*` 与 `src/**/*.test.*`，所以放在 `scripts/` 下的检查器不会被套件递归调用（否则它会在套件里再跑套件）。这也是它必须是 standalone 命令而非 `.test.ts` 的原因。

<!-- dedup-ref -->相关但不同：`gap-vitest-worker-pool-unbounded`（已立案）做的是**并发治理**（给 client 池加自适应上限）；本任务做的是**读数**（让 AC-103 可被判据机跑）。两者是「被观测」与「观测」的关系，不是同一件事，故不合并。

## AC

- [x] `bash scripts/suite-concurrency-check.sh` 退出码 0：并发启动的 2 个 client 套件均 exit 0，且两份输出中 `STACK_TRACE_ERROR` 与 `Timeout calling "fetch"` 计数均为 0。
- [x] 取假（确定性）：脚本内把并发数降到 1（或临时去掉池上限）时，同一脚本必须能以非零退出**并打印出它测到的那串签名计数**——即该判据能取假，而不是恒绿。
- [x] `bash scripts/suite-concurrency-check.sh` 在**当前**代码上实测为红（或实测出并发劣化读数），并把这组读数写进完成记录（安静 vs 并发的中位耗时）。
- [x] `bash scripts/test.sh` 退出码 0（新增文件不进套件 glob，既有套件不回归）。

## DoD

真实落地判据：不是「脚本文件存在」。要求在同一台机器上**真的并发跑出两个套件**并把两串签名的计数、以及安静/并发两组中位耗时记入完成记录；随后 AC-103 的 gate 由 `exit 127`（文件不存在）变为 `exit 0`（或在其治理前提未落地时仍红但**红在读数上、不再红在缺文件上**）。⛔ 仅新增脚本而从未实跑并发不算完成。

**完成记录**（2026-09-20，worktree `gap-suite-concurrency-checker`，128 核，实跑时 load ≈ 20–55）

判据形态 `bash scripts/suite-concurrency-check.sh`（无参，wall ≈ 32s；goal 判据 gate 硬上限 60s ⇒ 留 ≈2× 余量）。四次实跑，首次原文：

```
suite-concurrency-check: root=/data/home/yale/work/claudecodeui-worktrees/gap-suite-concurrency-checker
suite-concurrency-check: suites=2 readouts=2 suite_cmd=npx vitest run ｜ readout_cmd=bash scripts/test.sh --test-concurrency=128 <101 server files> ｜ k=4
suite-concurrency-check: [concurrent] 2 × npx vitest run  ‖ 2 × server-phase(readout)
suite-concurrency-check: 读数 套件 rc=[0 0] 读数 rc=[0 0] 并发重叠=9795ms 并发窗口=17925ms 安静窗口=14184ms ｜ 签名 STACK_TRACE_ERROR=0 Timeout_fetch=0 ｜ 服务端逐文件中位耗时 安静=1397ms(n=101) 并发=2706ms(n=202) 比值=1.94 K=4
suite-concurrency-check: PASS — 2 份套件并发 rc=[0 0]、服务端读数 rc=[0 0]，未观测到 worker 死亡签名，服务端逐文件中位耗时劣化 1.94× ≤ K=4
EXIT=0
```

- **AC-1**：并发组 2 份 `npx vitest run` 均 rc=0，两份套件输出中 `STACK_TRACE_ERROR` 与 `Timeout calling "fetch"` 计数均为 0（脚本实测打印，见上行）。另三次复跑同形：比值 1.92× / 2.07× / 2.11×，安静中位 1341–1397ms，并发中位 2630–2877ms，n=101 / 202。
- **AC-2（确定性取假）**：`--concurrency 1` ⇒ `EXIT=1`，判词 `FAIL — 并发数 1 < 2：未观测到并发重叠，"两个套件互不拖红" 不可判（fail-closed）`，且**同行**打印它测到的签名计数（`签名 STACK_TRACE_ERROR=0 Timeout_fetch=0`）与安静/并发中位。注意该次读数比值只有 1.08×——若判据按「比值」取假就会假绿，故取假断言必须是「套件数 < 2 直接 fail-closed」。
- **AC-3（实测出并发劣化读数）**：当前代码上脚本实测**绿**（AC-1），但同时**实测出劣化读数**——服务端逐文件中位耗时 **1397ms → 2706ms（1.94×）**，四次稳定在 1.92–2.11×，即并发确实把服务端逐文件 phase 拖慢约 2×，只是尚未达到 AC-103 记的故障态（0.7s → 41.3s，59×）。K 由首次实测钉死为 **4**（≈2× 余量，对故障态仍留 ≈15× 判别余量），已写回 AC-103 的 expect。
- **取假接线验证（非判据，附证）**：`--k 1` ⇒ `EXIT=1`：`FAIL — 并发劣化超限：服务端逐文件中位耗时 1459ms → 3092ms（2.12× > K=1），并发套件把服务端拖慢`；`--drop-pool-cap` ⇒ 头部实测打印 `suite_cmd=npx vitest run --maxWorkers=128`（用 CLI 覆盖池上限，**不改** `vitest.config.ts`），该次仅 1 份套件故 `EXIT=1` 红在 fail-closed 分支——证明的是接线，不是劣化。
- **⛔ 未跑并说明**：`--drop-pool-cap` 的**双套件**形态（AC 草案点名的「临时去掉池上限」方向）未执行：2×128 个 vitest worker 会把本机打满并波及其它正在跑套件的 quay worker，与 `gap-vitest-worker-pool-unbounded` 当时拒绝跑同一方向的理由一致（该方向是佐证，不是本任务的判据；AC-2 的确定性取假由 `--concurrency 1` 提供）。
- **形态取舍（保真 vs 时限）**：单份 `bash scripts/test.sh` 实测 **54.98s**，两份并发必然撞 60s gate ⇒ 判词会退化成 `acceptance timed out`，AC-103 将永远红在超时上而不是红在读数上。故并发组取「2 × `npx vitest run`（client 池）‖ 2 × 服务端逐文件 phase」，复现的正是 fan-in 的并发形状（本仓库记录过的红点即产生于该形状），wall ≈ 32s。`--full-suites` 保留逐字完整的「两份 test.sh 并发」形态，供长预算手跑。
- **AC-4**：`bash scripts/test.sh` ⇒ `EXIT=0`，`# tests 176 / # pass 176 / # fail 0`（新文件落在 `scripts/`，不在套件收集面内，无递归、无回归）。
- **AC-103 gate**：由 `exit 127`（No such file or directory）→ 现在 `bash scripts/suite-concurrency-check.sh` 在本机实跑 `exit 0`。

## Touches

- scripts/suite-concurrency-check.sh
- tasks/gap-suite-concurrency-checker.md
