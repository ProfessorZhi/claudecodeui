---
id: gap-margin-check-family-blind-spot
title: 冷编译判据的「族」是机制代理而非它自己断言的不变量：sessionFilterEditor 用例体内 await import() 让首用例付
  1.9–2.9s 冷编译（预算 0.53–0.57），判据却绿着 —— AC-103 因此于 2026-09-21T06:22Z 再次判红
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

**现象**：AC-103 的判据（`bash scripts/suite-concurrency-check.sh`）于 2026-09-21T06:22Z 判红，红在条件①（并发两份 client 套件 `rc=[1 1]`），红的是 `src/modules/sidebar/tests/sessionFilterEditor.test.tsx`。而本仓**专门为这条红建立的确定性判据** `scripts/test-timeout-margin-check.sh` 在同一时刻是**绿的**（本 agent 实测 `EXIT=0`，worst 比值 0.029，判词自称「族内 13 个文件全部 T_max ≤ B/K」）。

**为什么它绿着、AC-103 却红了：判据的「族」是机制代理，而不是它自己断言的不变量。**

- `scripts/test-timeout-margin-check.sh:153-155` 派生族的方式是两个条件的**合取**：文件里同时出现 `resetModules` **与** 动态 `import(`。
- 它断言的不变量却是另一件事（同文件 `:19-21`）：「族内每个文件的 `T_max ≤ B/K`」（`B=5000ms`、`K=4` ⇒ 阈值 1250ms）。
- `resetModules` 只是「首用例会付整张模块图的冷编译」的一个**代理**。真正让首用例付这笔钱的是「**用例体内** `await import()`」这一条；`resetModules` 只决定这笔钱要不要**每个**用例重付。不含 `resetModules` 的文件照样把冷编译整个记在**第一个**到达该 import 的用例头上。

**被漏掉的那个文件（实测）**：`src/modules/sidebar/tests/sessionFilterEditor.test.tsx:169` 的 helper `renderProjectsState()` 体内 `await import('@/modules/project-workspace')`，而该文件**没有** `resetModules`。全文件 7 个用例中只有第 5、6 个（0-based 4、5）调它，于是**第 5 个用例一次付清**：

```
idx   duration   用例
 0      367ms    typing rules calls preview once after the debounce and renders counts an
 1      310ms    a server-reported invalid line is marked on that textarea line
 2       15ms    a rejected save keeps the panel open and shows the server error
 3       10ms    a successful save reloads the project sessions and closes the panel
 4     1920ms    session requests carry running, attention and selected ids as keepSessio   ← 首个到达该 import 的用例
 5       53ms    a pushed session whose name matches the rules is not listed and only rai   ← 第二次调它，热缓存
 6       11ms    title-search results flagged filtered carry the 已过滤 mark
```

（`npx vitest run --reporter=json`，本机 2026-09-21；同一用例在逐文件 verbose 跑下为 **2630–2868ms**。）与 `gap-resetmodules-cold-compile-timeout` 记录的 projectsStateSelectionSync（首用例 3637ms / 其余 150ms）**完全同一形状**，只是触发条件少了 `resetModules` 这一半 —— 而那半个条件是判据自己加的代理，不是机制本身的一部分。

**这个文件是全树唯一的越界者**（本 agent 实测 `npx vitest run --reporter=json`，73 个 client 测试文件）：

```
total files: 73 | B=5000ms | K=4 threshold=1250ms
  1919.6ms  src/modules/sidebar/tests/sessionFilterEditor.test.tsx
            └ session requests carry running, attention and selected ids as keepSess
--- files over B/K=1250ms: 1 / 73
```

即：判据断言的不变量**只需修一个文件**就能在全树成立，而它现在因为族派生写窄了而看不见这唯一的违例。

**AC-103 判红那一次的原始读数**（`.quay/suite-concurrency-check/20260921T062206-2763765/`；两份并发套件的输出逐字相同）：

```
× session requests carry running, attention and selected ids as keepSessionIds 5003ms
FAIL  src/modules/sidebar/tests/sessionFilterEditor.test.tsx > session requests carry running, attention and selected ids as keepSessionIds
 Test Files  1 failed | 72 passed (73)
      Tests  2 failed | 471 passed (473)
```

同一文件在同一时刻单独跑：`Test Files 1 passed (1) | Tests 7 passed (7) | Duration 4.32s`，最慢用例 2630–2868ms。**没有任何断言缺陷** —— 它是被 5000ms 预算截断的（5003ms），同轮第二处 `deepEqual` 失败是其级联。

**为什么上一次修复没有守住**：`gap-resetmodules-cold-compile-timeout`（done，`goal_ac: AC-103`）建立这条确定性判据时，把「族」定义成了**它当时观察到的那个机制**（`resetModules` ∧ 动态 import），而不是**它自己断言的不变量**（每个 client 文件 `T_max ≤ B/K`）。那个定义对当时修掉的 3 个文件是对的，但它把射程绑在了一个代理条件上；本文件是同一机制的**另一半形态**（有动态 import、无 `resetModules`），于是落在射程外。判据因此**结构性地**看不见它 —— 这不是阈值松紧问题，是覆盖面问题。

**诚实的机器状态登记**：那次判红时本机 load1 为 87–135（128 核），争抢来自**本仓其它 quay worker**，不是并发的那份姊妹套件。`suite-concurrency-check.sh` 本身也不区分这两者（它的安静组只跑服务端读数、**从不跑 client 套件**，故 06:22 那次没有任何 client 基线可比）。这条观测**不改变本任务的结论**：无论争抢来自谁，`T_max = 1920–2868ms / B = 5000ms` 只剩 1.7–2.6× 余量，而修好后的姊妹文件是 14× 余量 —— 正是 `gap-resetmodules-cold-compile-timeout` 已经确立的那条纪律：判据判**余量**，不判红绿。但「判据缺 client 安静基线」是一条**独立**的健全性缺口，记在此处供人裁定，**不在本任务范围**（见非目标）。

**要做的事**：

1. **把判据的射程从机制代理换成不变量**：`scripts/test-timeout-margin-check.sh` 改为对**每一个** `src/**/*.test.ts(x)` 收逐用例耗时，断言 `T_max ≤ B/K`。原族派生可作**附加诊断**保留（打印哪些文件是机制族），但**不得**再作为判据的射程。
2. **先红后修**：改宽后判据必须在**当前树上以非零退出**，且同一行带出最差文件的 `T_max`、`B`（含来源）、比值与 `1/K`（本仓 AC 硬校验：失败退出必须同行输出成因）。
3. **修那一个文件**：把 `@/modules/project-workspace` 的模块图预热移出**用例**预算 —— 走 `beforeAll`（`hookTimeout=20000ms` 是独立预算；本 agent 实测该文件 `file_ms` 4.3s，20000ms 余量充裕）。手法与 `gap-resetmodules-cold-compile-timeout` 对 3 个同族文件所用者相同。**不改任何断言**。
4. **两条判据都要绿**：改后 `scripts/test-timeout-margin-check.sh` 退出 0；`scripts/suite-concurrency-check.sh` 的并发组两份 client 套件 rc 均为 0。

**非目标**：

- 不放宽 `K`。它由分布钉死：修好后下簇 ≤172ms、上簇 2781ms，阈值 1250ms 落在两簇之间的空档里。抬 `B` 同样不是出路 —— `B` 会出现在判词里（判据已按此设计），且抬 `B` 会削弱挂死探测（AC-105 正为此而设）。
- 不动服务端阶段的并发夹取 —— 那是 `gap-server-phase-concurrency-clamp`（ready）的机制：2026-09-21T06:27Z 那次并发读数 `rc=[137 137]`（SIGKILL，2 × `--test-concurrency=128` 在 128 核上过订阅）由它承担，与本任务的 client 侧冷编译不是同一件事。
- 不给 `suite-concurrency-check.sh` 补 client 安静基线。若人裁定要补，另立任务。

<!-- dedup-ref -->相关但不同：`gap-resetmodules-cold-compile-timeout`（done，`goal_ac: AC-103`）交付的正是本任务要改宽的这条判据与那 3 个同族文件的预热；`gap-server-phase-concurrency-clamp`（ready，无 `goal_ac`）管服务端阶段并发。三条任务 Touches 无交集，本任务也不以任何一条为前置。

## AC

- [x] AC1（红先行，确定性）：把族派生从「机制代理」换成「全树 client 逐用例 `T_max ≤ B/K`」之后，`bash scripts/test-timeout-margin-check.sh` 在**当前树上以非零退出**，同行打印最差文件的 `T_max`、`B`（含来源）、比值与 `1/K`；且该最差文件为 `src/modules/sidebar/tests/sessionFilterEditor.test.tsx`。
- [x] AC2：修好后 `bash scripts/test-timeout-margin-check.sh` 退出 0，且**全树每一个** client 测试文件 `T_max ≤ B/K`；判词须给出被检查文件总数与最差比值。
- [x] AC3：判据墙钟留在 gate 预算内 —— 完成记录给出 `time bash scripts/test-timeout-margin-check.sh` 的实测墙钟且 ≤ 60s。⛔ 逐文件串行 spawn 73 次不在预算内（本 agent 实测整张 client 套件一次 `--reporter=json` 收全量逐用例耗时 ≈30s、73 文件、`rc=0`；建议走这条一次性收集）。
- [x] AC4：`src/modules/sidebar/tests/sessionFilterEditor.test.tsx` 的**用例断言逐字未变**（`git diff develop...HEAD -- src/modules/sidebar/tests/sessionFilterEditor.test.tsx` 里 `test(`、`assert`、`expect(` 行零改动），该文件 7/7 通过且 `T_max ≤ B/K`。
- [x] AC5：`bash scripts/suite-concurrency-check.sh` 退出 0，其并发组两份 client 套件 rc 均为 0（完成记录贴出该判词行原文）。
- [x] AC6：`bash scripts/test.sh --for-task gap-margin-check-family-blind-spot` 退出 0，且**不是** thin（输出里 `# tests` ≥ 1）。

## DoD

真实落地，不是「判据改宽了」也不是「文件改了」—— 本任务的缺口正是**判据看不见它该管的那个文件**，故两边都必须动：

- 改宽前的**红先行**读数原文（非零退出 + `T_max` / `B` / 比值 / `1/K` 同行）粘进完成记录；并给出改宽前该判据为绿的对照读数（同一次会话内先跑旧版、再跑新版）。**仅有「改后绿了」不算**：没有红先行就无法区分「射程真的变宽了」与「只是换了个说法仍然看不见」。
- 全树 `T_max` 表（文件 / 最慢用例 / 耗时 / 比值 / 预算来源），至少覆盖越界文件与改后的新最差值 —— 这是 `K` 取值「分布数据先于阈值」的再确认，也是射程确实变大的证据（被检查文件数须从 13 变为 73）。
- 改后**真实并发**实测：`scripts/suite-concurrency-check.sh` 并发组两份套件 `rc=[0 0]`，且 `concurrent-suite-*.out` 里 `sessionFilterEditor.test.tsx` 不再出现 `Test timed out in 5000ms`，该文件逐用例全通过。
- **改宽判据本身的取假证明**：把该文件的预热撤掉（或经 `EXTRA_FILES` 注入一个已知超预算文件）后，新版判据必须重新变红 —— 否则「改成全树」只是把射程写宽了而没接线，等于把一个取不了假的绿换成了另一个。
- ⛔ 仅改宽判据而没修文件、或仅修文件而没改宽判据，都不算完成。
- 该轴仍暗，理由：本任务的判据是用例**耗时余量**（`T_max` 与 `testTimeout` 预算之比）与判据**射程**（族派生 vs 不变量），产出的是时间与覆盖面读数，不产生 L_D（描述长度）或 L_G（生成对齐）读数；本仓从未跑过 archguard 暗轴探针。ADR-007 per-milestone 谓词在本仓尚未生效（全部任务均 MISSING），此处按 ADR 原文认可的显式声明形式登记该轴仍暗。

## 完成记录

### 1. 红先行 + 「改宽前为绿」的对照（同一次会话、同一棵树）

同一棵树、同一次会话内先跑旧版（族=13），再跑新版（射程=73）。旧版为绿：

```
test-timeout-margin-check: family=13 files ｜ B=5000ms（来源：vitest.config.ts 显式 testTimeout）｜ K=4 ⇒ 阈值 1/K=0.250 ｜ 串行逐个跑
test-timeout-margin-check: PASS — 族内 13 个文件全部 T_max ≤ B/K（最差比值 0.034），冷编译不在任何用例的 testTimeout 预算内 ｜ worst=src/modules/project-workspace/tests/projectsStateSessionAlias.test.ts T_max=170ms B=5000ms(来源：vitest.config.ts 显式 testTimeout) 比值=0.034 阈值 1/K=0.250 (K=4) 最慢用例='an upsert for a session that is already canonical does not'
real	0m24.039s
EXIT=0
```

新版红先行（**未修文件**的那棵树），非零退出，同行带出 `T_max` / `B`（含来源）/ 比值 / `1/K`，最差文件即越界者：

```
test-timeout-margin-check: scope=73 files（ALL client test files（不变量射程））｜ 机制族(仅诊断)=13 files ｜ B=5000ms（来源：vitest.config.ts 显式 testTimeout）｜ K=4 ⇒ 阈值 1/K=0.250 ｜ 一次性收集
test-timeout-margin-check: file=src/modules/sidebar/tests/sessionFilterEditor.test.tsx T_max=2026ms(session requests carry running, attention and selected ids) B=5000ms 比值=0.405 1/K=0.250 tests=7 file_ms=2803 status=OVER-BUDGET
test-timeout-margin-check: FAIL — 1/73 个 client 文件余量不足或读数不可得（要求每个文件 T_max ≤ B/K）｜ worst=src/modules/sidebar/tests/sessionFilterEditor.test.tsx T_max=2026ms B=5000ms(来源：vitest.config.ts 显式 testTimeout) 比值=0.405 阈值 1/K=0.250 (K=4) 最慢用例='session requests carry running, attention and selected ids' ｜ 射程 73 个文件（ALL client test files（不变量射程））｜ 达标 72 / 不足或不可得 1
real	0m9.022s
EXIT=1
```

这就是「射程真的变宽了」而不是「换了个说法仍然看不见」的判别：**同一棵树**上，旧版报「13/13 达标，最差 0.034」，新版报「73 里 1 个越界，0.405」——被检查文件数 13 → 73，越界者从看不见变看得见，且它正是 AC-103 那次判红的那个文件与那个用例。

### 2. 全树 `T_max` 表（73 个 client 文件，B=5000ms，来源 vitest.config.ts 显式 testTimeout）

| 文件 | 改前：最慢用例 → T_max（比值） | 改后：最慢用例 → T_max（比值） |
| --- | --- | --- |
| src/modules/sidebar/tests/sessionFilterEditor.test.tsx | session requests carry running, attention and selected ids → **2026ms（0.405）** | typing rules calls preview once after the debounce and ren… → **367ms（0.073）** |
| src/modules/chat/tests/transcriptScrollOwnership.test.tsx | does not yank the view back down when the user scrolls up → 292ms（0.058） | 同 → 159ms（0.032） |
| src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts | a refresh that changes nothing workspace-visible keeps the… → 236ms（0.047） | 同 → 213ms（0.043） |
| src/modules/project-workspace/tests/projectsInitialFetch.test.tsx | an explicit refresh still reaches the server after the mou… → 235ms（0.047） | 同 → 207ms（0.041） |
| src/modules/project-workspace/tests/projectsStateSessionAlias.test.ts | an upsert for a session that is already canonical does not… → 209ms（0.042） | an upsert without a provider id leaves the aliased row in… → 208ms（0.042） |
| src/modules/chat/tests/streamingMarkdownComponent.test.tsx | the split render matches the unsplit render: a fenced bloc… → 151ms（0.030） | 同 → 154ms（0.031） |

改前全树分布（73 文件）：1 个 >1000ms（2026ms），其余 72 个 ≤292ms —— 阈值 1250ms 落在**两个簇之间的空档**里（上簇 2026ms 的 62%，下簇 292ms 的 4.3 倍）。改后最差 367ms、次差 213ms，全树无 >1000ms 者；阈值对最差读数留 3.4× 余量、对次差留 5.9×。用例名超过 58 字符的按判据脚本的截断长度显示（以 `…` 结尾）。

### 3. 取假证明：撤掉预热，新版判据必须重新变红

在最终 SHA 的树上，把 `src/modules/sidebar/tests/sessionFilterEditor.test.tsx` 临时换回 `develop` 版本（唯一区别就是撤回那个 `beforeAll` 预热，**断言与其余一切不变**），跑新版判据：

```
test-timeout-margin-check: file=src/modules/sidebar/tests/sessionFilterEditor.test.tsx T_max=1848ms(session requests carry running, attention and selected ids) B=5000ms 比值=0.370 1/K=0.250 tests=7 file_ms=2613 status=OVER-BUDGET
test-timeout-margin-check: FAIL — 全树：1/73 个 client 文件余量不足或读数不可得（要求每个文件 T_max ≤ B/K）｜ worst=src/modules/sidebar/tests/sessionFilterEditor.test.tsx T_max=1848ms B=5000ms(来源：vitest.config.ts 显式 testTimeout) 比值=0.370 阈值 1/K=0.250 (K=4) 最慢用例='session requests carry running, attention and selected ids' ｜ 射程 73 个文件（ALL client test files（不变量射程））｜ 达标 72 / 不足或不可得 1
EXIT=1
```

随后 `git checkout HEAD -- <file>` 还原（`git status` 干净）。⇒ 「改成全树」是**接了线**的，不是把一个取不了假的绿换成另一个：预热一撤，判据立刻在同名文件、同名用例上变红。

### 4. 改后判据为绿（AC2 / AC3）

```
test-timeout-margin-check: collect rc=0 wall=7437ms（npx vitest run --reporter=json，一次收全量逐用例耗时）
test-timeout-margin-check: PASS — 全树 73 个 client 文件全部 T_max ≤ B/K（最差比值 0.073），冷编译不在任何用例的 testTimeout 预算内 ｜ worst=src/modules/sidebar/tests/sessionFilterEditor.test.tsx T_max=367ms B=5000ms(来源：vitest.config.ts 显式 testTimeout) 比值=0.073 阈值 1/K=0.250 (K=4) 最慢用例='typing rules calls preview once after the debounce and ren' ｜ 射程 73 个文件（ALL client test files（不变量射程））｜ 达标 73 / 不足或不可得 0
real	0m8.666s
EXIT=0
```

墙钟：`time bash scripts/test-timeout-margin-check.sh` = **8.7s**（取数那一步 7.4s），远在 60s gate 预算内；对照旧版逐文件串行 spawn 13 次 = 24.0s，73 次按同一速率约 135s —— 所以取数走**一次** `npx vitest run --reporter=json`。旧脚本的 `--k` / `--list` / `--file` 三个入口都保留；`--file` 现为**收窄射程**的诊断形态，判词会标明 `scope=restricted`，避免把 1 个文件的绿读成全树的绿（实测：`PASS — 收窄射程 1 个 client 文件…`）。

### 5. 真实并发实测（AC5）

`bash scripts/suite-concurrency-check.sh`（最终 SHA）：

```
suite-concurrency-check: 读数 套件 rc=[0 0] 读数 rc=[0 0] 并发重叠=9776ms 并发窗口=18115ms 安静窗口=14216ms ｜ 签名 STACK_TRACE_ERROR=0 Timeout_fetch=0 ｜ 服务端逐文件中位耗时 安静=1444ms(n=101) 并发=2939ms(n=202) 比值=2.04 K=4
suite-concurrency-check: PASS — 2 份套件并发 rc=[0 0]、服务端读数 rc=[0 0]，未观测到 worker 死亡签名，服务端逐文件中位耗时劣化 2.04× ≤ K=4｜ 签名 STACK_TRACE_ERROR=0 Timeout_fetch=0 ｜ 服务端逐文件中位耗时 安静=1444ms(n=101) 并发=2939ms(n=202) 比值=2.04 K=4
EXIT=0
```

并发组两份 client 套件里该文件的逐文件行（各一份），以及各自的总结行：

```
 ✓ src/modules/sidebar/tests/sessionFilterEditor.test.tsx (7 tests) 4155ms
 ✓ src/modules/sidebar/tests/sessionFilterEditor.test.tsx (7 tests) 4552ms
 Test Files  73 passed (73)      Tests  473 passed (473)
```

两份 `concurrent-suite-*.out` 里 `grep -c "Test timed out"` 均为 **0**，该文件 7/7 全通过 —— AC-103 那次 `Test timed out in 5000ms` 的形态不再出现。

（诚实登记：本会话另一次跑 `suite-concurrency-check.sh` 时**安静基线**自己 rc=1，红在 `server/modules/launch-profiles/tests/profile-rest-api.test.ts` 的 `TypeError: fetch failed`（`__PERFILE_KIND__ … kind=assert`）—— 那是 `--test-concurrency=128` 在 128 核上过订阅的既有负载伪影，与本次改动（一个 client 测试文件 + 一条 client 侧判据）无关；重跑即绿，即上表。）

### 6. 逐条 AC

- AC1 —— 见 §1：非零退出、最差文件 = `src/modules/sidebar/tests/sessionFilterEditor.test.tsx`、同行 `T_max=2026ms B=5000ms(来源：…) 比值=0.405 1/K=0.250`。
- AC2 —— 见 §4：退出 0，73/73 文件 `T_max ≤ B/K`，判词给出被检查文件总数 73 与最差比值 0.073。
- AC3 —— 见 §4：`time` 实测 8.7s ≤ 60s；取数用一次性收集而非 73 次串行 spawn。
- AC4 —— `git diff develop...HEAD -- src/modules/sidebar/tests/sessionFilterEditor.test.tsx` 的改动行只有「vitest import 行加 `beforeAll`」+「新增注释与 `beforeAll` 块」；把改动行按 `test(` / `assert` / `expect(` 过滤后**零命中**（`grep -E` 在改动行上 rc=1）。该文件 7/7 通过、`T_max=367ms ≤ 1250ms`。
- AC5 —— 见 §5。
- AC6 —— `bash scripts/test.sh --for-task gap-margin-check-family-blind-spot` 退出 0，输出 `# tests 1`（非 thin，5.1s）。

### 7. 改了哪两处

- `scripts/test-timeout-margin-check.sh`：射程从「`resetModules` ∧ 用例内动态 import」的机制族改为 `src/**/*.test.ts(x)` 全集（不变量本身）；取数改为一次性 `npx vitest run --reporter=json`；族派生保留为**诊断**（判词与 `--list` 里标注）；射程内有文件在报告里没有条目 ⇒ fail-closed（射程与读数不会各说各话）。
- `src/modules/sidebar/tests/sessionFilterEditor.test.tsx`：新增一个 `beforeAll(async () => { await import('@/modules/project-workspace'); })`，把那笔冷编译从**用例**预算挪到 `hookTimeout`（20000ms）。**没有任何断言被改动**，也没有引入 `resetModules`（这个文件本来就没有，也不需要有）。

## Touches

- scripts/test-timeout-margin-check.sh
- src/modules/sidebar/tests/sessionFilterEditor.test.tsx
- tasks/gap-margin-check-family-blind-spot.md
