---
id: gap-concurrency-verdict-discriminates-flake-from-drag
title: 并发判据把「与并发无关的逐文件偶发」记成「两个套件互拖红」：suite-concurrency-check 的退出码同时压住两个命题，致
  AC-103 间歇判红（99 次里 11 次）
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

**问题**：AC-103 的判据 `bash scripts/suite-concurrency-check.sh` 间歇性判红，但它**红的成因已经不是它命名的那件事**。

**实测（99 次判据运行记录，落在 `.quay/suite-concurrency-check/`）**：10 次红的并发组 + 1 次红的安静基线。而**每次红的文件都不同** —— file-tree.routes.test.ts、projects-session-filter.integration.test.ts、agent.routes.test.ts、commands.test.ts、model-config-write-path.test.ts、profile-partial-update.test.ts、git-init.routes.test.ts —— 耗时 783ms–8.4s，**正常或偏快，不是超时**。

**同时，判据为它命名的不变量而测的那两个量都已经绿了**：签名计数恒为 0（STACK_TRACE_ERROR / Timeout calling "fetch"），并发中位耗时劣化 1.12–2.08× ≤ K=4（AC-103 origin 记的故障态是 59×）。

**决定性证据 —— 判据自己写下的判词**（2026-09-20T15:49:15Z 的 goal gate 记录）：

```
套件 rc=[0 0] 读数 rc=[0 0] 并发重叠=9852ms ｜ 签名 STACK_TRACE_ERROR=0 Timeout_fetch=0 ｜ 服务端逐文件中位耗时 安静=1352ms(n=101) 并发=2806ms(n=202) 比值=2.08 K=4
suite-concurrency-check: FAIL — 安静基线自己就非零退出（rc=1，与并发无关）：先修基线再谈并发读数（日志 20260920T234842-3234032）
```

那一次**两个并发套件 rc=[0 0]、两个并发读数 rc=[0 0]** —— 并发组是干净的。判据红，只因为**单独跑的那一份安静基线**自己红了一个文件（file-tree.routes.test.ts，`[TypeError: fetch failed]`，1200ms）。**并发组 0 红、安静组 1 红**，这就是「这不是互拖」的定义。

**缺口形状**：判据用一个退出码同时压住两个不同命题 ——

- (A) 它命名的：**并发**把套件互相拖红。**已成立**（签名 0、劣化 1.2–2.1×）。
- (B) 它没命名、也管不了的：**这台机器上服务端跑 194 次文件，一次都不许偶发失败**。

(B) 不是并发属性：它在**单进程**安静基线里同样发生（上例），却在 24 路并发单文件压测里复现不出来（24/24 绿）。它是机器负载下的逐文件偶发，与「两个套件互拖」无关。

**同一机制已被兄弟任务独立登记过**：`gap-server-phase-concurrency-clamp` 的完成记录第 5 节，跑①红在 `file-tree.routes` 629ms 的 `TypeError: fetch failed`，同文件单独跑 3/3 通过，它写作「本仓已知的负载假红、与本次改动无关」。本条与之同源，但观测面不同：那条看的是**单份套件的服务端阶段**，本条看的是**判据把这次偶发记成了「互拖」并因此判红**。

**另外两条与并发无关的红**（同一份记录）：`acceptance timed out after 60000ms (killed)`（2026-09-20T22:23Z —— 判据墙钟在负载下超过 goal gate 的 60s 硬上限，判词退化成「超时」、读数丢失）；`line 148: … Killed`（22:28Z —— 并发读数进程被 SIGKILL，rc=137）。

**要做的事**：把判词收回到它命名的不变量上，**不放松任何一条**。

1. **差分判定**：并发红名单与安静红名单**做差**；只有「安静绿 ∧ 并发红」的文件才算被拖红。安静基线自己的红**单独报告、不再单独致判据红**（它现在正是判据红的直接原因）。
2. **确认步 + 计数上界（防洗白）**：对差集里的文件隔离复跑一次 —— 仍红 ⇒ 判红；复跑绿 ⇒ 记为偶发、打印、不计入。⛔ 必须同时有**计数上界**：差集大小超上界、或签名计数 ≠ 0、或劣化比 > K 时**跳过确认步直接判红**，否则确认步会把成批死亡洗成「偶发」。
3. **取假形态必须仍红**：`--drop-pool-cap`（及既有 `--concurrency 1` / `--k 1`）仍须非零退出，且确认步**洗不白**它。
4. **确定性自检**：把差分判词做成可由合成读数驱动的 `--self-test`（不依赖并发），带**正反控制**并按标签打印每条控制的结果 —— 「零个拖红」正是惰性实现也能拿到的分数，所以必须把**必须判红**的那几条一起放进同一个 runner。
5. **墙钟留在 gate 预算内**：判据自身墙钟实测打印且 < 60s 留余量 —— 超时不是判据的一种红。
6. **AC 记录与判据一致**：把差分语义写回 AC-103 的 expect，使记录里的不变量与脚本实际判定的是同一个。

**为什么早先的修复没有兜住**：`gap-vitest-worker-pool-unbounded`（client 池上限 8）、`gap-server-phase-concurrency-clamp`（服务端并发夹取 16）、`gap-resetmodules-cold-compile-timeout`、`gap-margin-check-family-blind-spot` 四条修的都是**并发治理**（命题 A），而且**修成了** —— 签名计数归零、劣化从 59× 降到 1.12–2.08×。残留的红**全部**来自命题 B，而 B 从来不在那四条的范围里，也**不在这条判据的命名范围里**。本任务不是再修一次并发，而是让判据不再把 B 记成 A。

<!-- dedup-ref -->相关但不同：`gap-server-phase-concurrency-clamp`（done）夹取服务端阶段的并发；`gap-suite-infra-attribution`（done，AC-104）给套件失败行加 infra/assert 分类；`gap-margin-check-family-blind-spot`（done）修的是另一条判据（test-timeout-margin-check.sh）的族偏差。三者的机制都不是「把与并发无关的逐文件偶发记成互拖」。

## AC

- [x] `bash scripts/suite-concurrency-check.sh` 真实并发下退出码 0，且判词**同一行**打印：并发红名单、安静红名单、差集（安静绿 ∧ 并发红）、确认步后幸存的红文件、签名计数、劣化比、判据自身墙钟。
- [x] 差分语义落地：安静基线自己的红不再单独致判据红。以 2026-09-20T15:49:15Z 那次的读数形状为回归夹具（并发组全绿、安静组 1 红）时，判据退出码 0 并打印那个安静红文件。
- [x] 确认步有上界、洗不白成批死亡：差集大小超上界、或签名计数 ≠ 0、或劣化比 > K 时**跳过确认步直接判红**；上界值由实测给出并在判词里打印依据，不得凭感觉写。
- [x] `bash scripts/suite-concurrency-check.sh --self-test` 退出码 0，且至少四条合成读数控制按标签打印结果：① 安静红 = 并发红 ⇒ 绿；② 安静绿 ∧ 并发红 ∧ 复跑红 ⇒ 红；③ 安静绿 ∧ 并发红 ∧ 复跑绿 ∧ 差集 ≤ 上界 ⇒ 绿且打印偶发；④ 取假形态：并发红成批（> 上界）⇒ 红，且不因复跑绿而洗白。
- [x] 自检能取假（确定性）：去掉 ④ 的上界判定（或把确认步改成无条件洗白）后，`--self-test` 必须非零退出并指明是**哪一条**控制失败。
- [x] 判据自身墙钟实测打印且 < 60000ms（goal gate 的硬上限）；`--drop-pool-cap` / `--concurrency 1` / `--k 1` 三条取假形态仍各自非零退出，并把实测读数打进判词。
- [x] AC-103 的 expect 已按差分语义写回，且写回之后 `bash scripts/suite-concurrency-check.sh` 实测仍绿。

## DoD

真实落地判据：不是「脚本里出现了 diff 这个词」。要求在同一台机器上留下读数 —— 一次**真实并发**实跑（打印差分后的红名单与自身墙钟）、一次 `--self-test`（打印四条控制标签与结果）、一次取假形态实跑（非零退出）、以及一次**能复现安静基线偶发而判据仍绿**的读数（或该形状的合成夹具）。⛔ 仅改判词而无实跑不算完成；⛔ 不得靠删除/跳过任何服务端测试、放宽 K、或缩 `scripts/test.sh` 的收集面来达绿。

L_D 该轴仍暗，理由：本任务只改判据脚本的判词与差分逻辑，不触碰领域模型与前端。

## Touches

- scripts/suite-concurrency-check.sh
- goals/AC-103-同时运行的两个全量套件互不拖红.md
- tasks/gap-concurrency-verdict-discriminates-flake-from-drag.md
