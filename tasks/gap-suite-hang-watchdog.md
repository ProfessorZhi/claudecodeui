---
id: gap-suite-hang-watchdog
title: 套件挂死无人终结：给 scripts/test.sh 加 max-runtime 与 silence 两条看门狗，阈值由实测推出
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-105
---
## Proposal

**要解决的问题**：本项目 `scripts/test.sh` 把一个套件跑到底、**没有任何上限**。一旦某个测试挂死（子进程不回、或等一个永不到来的事件），这次调用就无限期停在原地，而**没有任何一层会发现**——因为它不是红，是"没动静"。

**为什么这比红更贵**：quay 的实测记录（`SPEC-suite-lifecycle-and-failure-semantics-2026-08-26`）里两次挂死分别是 **33.7 分钟**与 **199.5 分钟（3.32 小时）**，两次都靠**人工发现 + 手工 `kill -TERM -- -<pgid>`** 才解掉，后者从人工 kill 到 worker 感知又隔了 49 分钟。本项目同样的路径目前完全裸露。

**为什么这一条是本轮唯一"无条件该补"的**：quay 把治理分三层——
- **A 资源仲裁**（此刻允许几个套件跑）：**可放松**，随负载自适应；
- **B 活性检测**（它还在推进吗）：**不可放松**，只答是/否，**不做处置决定**；
- **C 失败策略**（还要不要再给一次机会）：必须读原因。

本项目 A 层已有 client 池上限并落地，C 层由 AC-104 在补，**B 层完全空白**。而 B 层恰好是**不需要裁决阈值、不会停机**的一层——它只终结"已经在挂死的东西"。

**参照值（⛔ 不要照抄）**：quay 是 `SUITE_MAX_RUNTIME_MS = 45min` → timeout、`SUITE_SILENCE_MS = 15min` → hung。quay 的套件是 402–896s，而本项目安静时 Σ 仅 **153.6s**——照抄 45 分钟等于永不触发。

**⚠️ 阈值必须由本项目的实测推出，不许凭感觉写。** 这是 quay `SPEC-suite-speed` AC3 的纪律（「在 AC1/AC2 的数据出来之前，不许设任何阈值」）。而且要注意**两个失效方向不对称**：阈值太小 ⇒ 把只是被并发拖慢的**健康**套件杀掉（我们刚测到过并发下中位耗时 0.7s→41.3s 的劣化，虽然池上限落地后已几乎消失）；阈值太大 ⇒ 挂死仍然要人等。所以要取**带余量的**值，并优先以「安静墙钟」为基线、再乘一个覆盖并发劣化的倍数。

要做的事：
1. 在 `scripts/test.sh` 里加两条守卫：**max-runtime**（整次调用上限）与 **silence**（多久没有新输出即判挂死）；触发时**终结该套件**（连同其子进程树）、以非零退出，并在输出里**写明是哪条守卫触发、阈值多少、当时静默了多久**。
2. 阈值必须是**可从实测复算的**，且**复算由脚本完成**：`scripts/suite-hang-watchdog-check.sh` 自行测量安静墙钟与并发墙钟、自行算出余量倍数与所取阈值，并在 stdout 上以**一行**给出（测了几次、安静多少、并发多少、乘了什么余量、两条守卫各取多少）。允许用环境变量覆盖阈值以便调整。
3. 新增 `scripts/suite-hang-watchdog-check.sh`：**确定性地**造一次挂死（例如让一个测试文件在 setup 里睡过阈值），跑一次 `scripts/test.sh`，断言它在**有界时间内**结束、退出码非 0、且判词写明触发原因；再跑一次正常套件，断言**不**被误杀。失败时把成因写进判词（本仓库 AC 硬校验），不得用裸 `grep -q` 链。⚠️ 套件的冗长输出一律重定向进日志文件，判词只引用其中的关键行；脚本自身的 stdout 必须保持紧凑（见 AC 第 5 条）。
4. ⛔ 不得破坏既有的 flag 消费契约（`--buckets|--root|--state-dir|--runner|--log-file|--run-id) shift 2`）与 `__PERFILE__` 输出格式；守卫只终结进程，不改判据。

**⚠️⚠️ 阈值推导必须由脚本做，不得由 worker 在自己的上下文里跑套件得出（2026-09-20 修订单，人裁定）。** 本条首次派发的 worker 就是这么死的：它按当时的 AC4 与 DoD 在 12 分钟内把 **4 次全量/并发套件**跑进自己的上下文（每次上百行逐文件行加 vitest 明细），15:19:11 以 `failed / exit_code:1` 收场，transcript 末句是 `Prompt is too long · automatic compaction failed: summarization produced empty response`。**任务的举证要求把 worker 自己撑爆了。** 因此本条的测量与推导责任整体移交给 `scripts/suite-hang-watchdog-check.sh`：它自己跑套件、自己算阈值、只吐一行紧凑结论，worker 只读那一行（形态照 `scripts/suite-concurrency-check.sh`）。人裁定载体落在本仓（改任务举证要求），不改 quay driver 的 worker 提示词。

## AC

- [x] `bash scripts/suite-hang-watchdog-check.sh` 退出码 0：人为挂死的套件在有界时间内被终结（退出码非 0，判词写明触发守卫与阈值），而正常套件不被误杀。
- [x] 取假（确定性）：把两条守卫的阈值放大到永不触发（或移除守卫）时，同一检查器必须以非零退出（因为它会观察到"挂死没有被终结"）。
- [x] `bash scripts/suite-hang-watchdog-check.sh` 退出码 0（本任务 Touches 不含 `*.test.*`，scoped 会掏空成 thin 假绿，故自测入口是它自己交付的检查器）；改动后既有 `__PERFILE__` 行格式未变、`--test-concurrency=4` 仍被正确消费（证据见完成记录第 5 条的全量实跑读数，不再由本 AC 直接发起全量调用）。
- [x] 阈值推导由脚本完成且在**一行**内给出：`bash scripts/suite-hang-watchdog-check.sh` 的 stdout 含一行同时给出**安静墙钟、并发墙钟、余量倍数、两条守卫的所取阈值**（四者可据此复算），且该行同时写入完成记录。⛔ worker 不得为取得该读数而自行跑套件。
- [x] 检查器自身的 stdout 紧凑：`bash scripts/suite-hang-watchdog-check.sh | wc -l` 输出 ≤ 12（套件原始输出一律进日志文件、不进 stdout），以确保读它的人或 worker 不可能因它而耗尽上下文。

## DoD

真实落地判据：不是「多了两个变量」。要求在**同一台机器上真的造出一次挂死**并把看门狗终结它的输出（触发哪条守卫、阈值、静默时长、退出码）与随后一次**正常套件不被误杀**的判词一并记入完成记录 —— **记入的是检查器吐出的紧凑判词行，不是套件原始输出**；随后 AC-105 的 gate 由 `exit 127`（判据文件不存在）变为 `exit 0`。⛔ 仅加变量而从未实跑挂死场景、或阈值无实测依据，不算完成；⛔ 也不接受「worker 在自己上下文里跑套件、把冗长输出贴进完成记录」这种举证方式 —— 它已被实测证明会杀死 worker（见 Proposal 的修订单）。

- 该轴仍暗，理由：本任务的判据是套件**活性**（整次调用墙钟上限与静默时长），产出的是挂死判定与阈值，不产生 L_D（描述长度）或 L_G（生成对齐）读数；本仓也从未跑过 archguard 暗轴探针。ADR-007 per-milestone 谓词在本仓尚未生效（全部 43 条任务均 MISSING），此处按 ADR 原文认可的显式声明形式登记该轴仍暗。

## Touches

- scripts/test.sh
- scripts/suite-hang-watchdog-check.sh
- tasks/gap-suite-hang-watchdog.md

## 完成记录（2026-09-20，worker，分支 task/gap-suite-hang-watchdog）

真实落地：同一台机器实跑，非合成字符串；fixture 由检查器在运行期写成、退出时删除（本任务手建的同名 fixture 也已被检查器的清理带走），提交 `0fded859` 后工作树干净。

1) **挂死被终结（按 shipped 阈值实跑，不是缩小版）**：`server/.suite-hang-check/hang-forever.fixture.ts`（`await new Promise(() => {})`，永不返回）跑 `bash scripts/test.sh <该文件>`，rc=**3**，wall_ms=244420，报告全文：

    suite-watchdog: ABORT guard=silence reason=hung threshold_ms=240000 elapsed_ms=243070 silent_ms=241059
    not ok - suite-watchdog: ABORT guard=silence reason=hung threshold_ms=240000 elapsed_ms=243070 silent_ms=241059
    # tests 1
    # pass 0
    # fail 1
    # cancelled 0

判词写明触发的是 **silence** 守卫、阈值 240000ms、当时已静默 241059ms；退出码非 0；四个计数平衡（1 = 0 + 1 + 0）。

2) **正常套件不被误杀**：检查器两条正向场景的判词原文 ——

    CHECK OK   [slow-but-alive] slow-but-alive: server/.suite-hang-check/slow-but-alive.fixture.ts passed in 7420ms, exit 0 after 7s, no watchdog line in the report
    CHECK OK   [healthy-defaults] healthy-defaults: server/.suite-hang-check/healthy.fixture.ts passed in 423ms, exit 0 after 0s, no watchdog line in the report

`healthy-defaults` **不带任何阈值覆盖**，跑的就是 shipped 配置；`slow-but-alive` 比 silence 阈值更慢（7 个 1s tick 的连续推进）却因推进不间断而不被碰。两条都断言"报告里没有 watchdog 行"。

3) **检查器 stdout 原文**（`bash scripts/suite-hang-watchdog-check.sh`，rc=0，7 行 —— AC 第 5 条的 `| wc -l` 实测也是 **7** ≤ 12；套件原始输出全部落在日志文件里，不进 stdout）：

    suite-watchdog: thresholds readings=measured quiet_wall_ms=59027 concurrent_wall_ms=67356 max_gap_ms=8000 margin_runtime=9 margin_silence=30 max_runtime_ms=660000 silence_ms=240000
    CHECK OK   [hang-silence] hang-silence: guard=silence reason=hung threshold_ms=4000 silent_ms=4016 elapsed_ms=6027 → exit 3 after 6s
    CHECK OK   [hang-max-runtime] hang-max-runtime: guard=max-runtime reason=timeout threshold_ms=6000 silent_ms=4016 elapsed_ms=6028 → exit 3 after 6s
    CHECK OK   [slow-but-alive] （判词见上）
    CHECK OK   [healthy-defaults] （判词见上）
    CHECK OK   [falsify/unarmed-watchdog] guards removed → checker exit 1, verdict names the un-ended hang
    CHECK PASS scripts/test.sh ends a hung suite with the guard that noticed it (silence or max-runtime), says which guard, its threshold and how long the suite had been silent, exits non-zero, leaves a healthy suite — even one slower than the silence threshold — untouched, and stops ending hangs at all once its guards are removed.

第一行即 AC 第 4 条要求的读数行：安静墙钟 59027ms、并发墙钟 67356ms、最大推进间隔 8000ms、余量 runtime 9× / silence 30×、两条守卫分别取 660000ms / 240000ms（四者可据此复算）。

4) **取假（确定性，AC 第 2 条）**：把 arming 行从 `scripts/test.sh` 的副本里剥掉后，同一检查器 exit **1**，判词 `[falsify/unarmed-watchdog] guards removed → checker exit 1, verdict names the un-ended hang`（即它观察到"挂死没有被终结"）。

5) **AC 第 3 条**：`bash scripts/test.sh` rc=0（wall 57.3s）；`bash scripts/test.sh --test-concurrency=4` rc=0（wall 61.6s，flag 被消费）。两次都是 `# tests 176 / # pass 176 / # fail 0 / # cancelled 0`，176 条 `__PERFILE__` 行**全部**仍匹配 quay 的锚定正则（格式未变），typecheck / lint 两条 stage 行在，`not ok - ` 0 条，watchdog 行 0 条。

6) **阈值怎么来的**：由检查器自己测、自己算（worker 未为取得读数跑任何套件）。`--measure` 跑 3 次套件（安静 1 次 + 并发 2 次），读数缓存进 `.quay/suite-hang-watchdog/measurement.env`（`.quay/*` 已 gitignore）；每项读数取各次实测的**运行最大值**，所以更快的一次采样不会让阈值缩水。配方与算例：`max_runtime_ms = ceil_minute(9 × concurrent_wall_ms)`、`silence_ms = ceil_minute(30 × max_gap_ms)`，向上取整到整分钟（往更宽松的方向取整）；9 × 67356ms = 606204ms → **660000ms**；30 × 8000ms = **240000ms**；安静墙钟 59027ms 作基线登记。判红的是 shipped **小于**把同一配方用在固定基线读数（首次实测：安静 53908ms / 并发 65700ms / 间隔 8000ms）上的结果——那一条与负载无关，是可确定复现的下限（9 × 65700ms → 600000ms ≤ 660000ms 通过）；而"某次更慢的实测会推出比 shipped 更大的值"只作漂移提示打印、不判红。

7) **AC-105 的 gate**：criterion 原文就是 `bash scripts/suite-hang-watchdog-check.sh`。修前该文件不存在（`exit 127`），现在 rc=**0**（第 3 条、第 4 条各一次）。

诚实披露（供后续读 fan-in 红日志的人参考）：(a) 本任务实现期先按旧阈值 300000ms 跑过一次挂死，rc=3、silent_ms=301898 —— 触发路径本身当时即可用；(b) 那次读数是在我编辑 `scripts/test.sh` 期间跑的，报告里 `# cancelled` 仍是改前的公式值（1），为免把未真正执行过的代码路径当成已验证，阈值定稿后**重跑**了第 1 条里那次 244420ms 的实跑，平衡后的计数即是 0；(c) `--measure` 的三次采样里，安静那次曾红过一次 `server/modules/projects/tests/projects-session-filter.integration.test.ts` 的 `TypeError: fetch failed`（本仓已知的负载假红，该文件单独跑过、紧接着重跑全量也过）——检查器因此**不要求**采样套件是绿的：只要求它"跑完了"（自己的守卫没触发），红文件照样算进样本，否则检查器会在负载高的机器上假红。
