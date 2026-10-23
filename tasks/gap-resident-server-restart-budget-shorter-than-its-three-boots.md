---
id: gap-resident-server-restart-budget-shorter-than-its-three-boots
title: AC-166 判据的 BUDGET_MS=60s 装不下它自己庇护的三次启动（3×BOOT_TIMEOUT_MS 25s =
  75s）：负载下「慢但成功」的启动序列必然撞进程级 kill（exit 3），而该红不指名任何用例
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-166
---
## Proposal

**现状读数（2026-10-02，读的是失败轮的保留子产物，不是台账 reason 的尾巴）。** 那一轮 suite 红只指名一个文件：`server/modules/session-hosts/tests/resident-server-restart.test.ts passed=false`，`duration_ms=61304`。该轮保留目录 `.../suite-logs/20261002T101402-3710237/` 里该文件 `.out` 的逐字读数：

```
server-boot pid=3750513 port=33023 log=/tmp/resident-server-restart-j0FeOo/server-33023.log
server-environ DATABASE_PATH=/tmp/resident-server-restart-j0FeOo/auth.db | HOST=127.0.0.1
sigterm-precondition resident-pid=3753009 alive-before=true
sigterm-killed killed=4 spared=1
sigterm resident-pid=3753009 alive-before=true gone-after-ms=756 closeReason=server-shutdown
✖ a stopped or killed server leaves no resident process behind, and the next boot says so (28301.723951ms)
[budget] budget-ms=60000 elapsed-ms=60004 exit=3 — the server boundary did not finish inside its process budget (a process-level kill, not a node:test case failure).
```

**关键点：那台服务端并没有启动失败。** 同一条 `.out` 里附的 `server-6665.log` 尾 4000 字显示它已经走到 `CloudCLI Server - Ready` / `Server URL: http://localhost:6665`，并完成了 `Initial session synchronization complete` 与四条 `session watcher using native filesystem events`。也就是说：**一次成功的启动被判成「从未应答 /health」**，随后整个文件撞上 60s 进程预算，被 `process.exit(3)` 杀掉。

**机制是算术，不是负载玄学。** 该文件自己的常量（`server/modules/session-hosts/tests/resident-server-restart.test.ts`）：

| 常量 | 值 | 位置 |
|---|---|---|
| `BOOT_TIMEOUT_MS` | 25_000 | `:78` |
| `ROUND_TIMEOUT_MS` | 30_000 | `:80` |
| `GONE_TIMEOUT_MS` | 20_000 | `:82` |
| `SCOPE_TIMEOUT_MS` | 15_000 | `:86` |
| `BUDGET_MS` | **60_000** | `:89` |

而 `bootServer()` 在**同一个** `test()` 里被调用**三次**（`:817` first / `:963` second / `:1032` third），每次最多等 `BOOT_TIMEOUT_MS`。**3 × 25s = 75s > BUDGET_MS 60s** —— 三次启动的截止之和**单独**就超过整个进程预算，`ROUND` / `GONE` / `SCOPE` 那几条腿还没开始算。所以只要三次启动各自「慢但成功」（负载下各自逼近 25s），这个文件在算术上**必然**触发 `process.exit(3)`；而 exit 3 是进程级 kill，`node:test` 不指名任何用例 —— 正是驱动侧读出「suite red could not be attributed to any failing test file」的那种形状。同一个 60s 预算还被 `guard({elapsedMs, budgetMs})` 的返回值语义钉住（超预算返回 3），这条语义本身是对的、不要改。

**要做的事。** 让进程预算**不小于它自己庇护的各步截止之和**，把「最坏情况下仍能跑完所有腿」变成算术事实而不是运气。二选一（或组合）：(1) 把 `BUDGET_MS` 从写死的 60s 改成由该文件实际使用的截止常量**推导**出来（3×`BOOT_TIMEOUT_MS` + `ROUND_TIMEOUT_MS` + `GONE_TIMEOUT_MS` + `SCOPE_TIMEOUT_MS` + 余量），并让推导式本身成为被断言的不变式；(2) 把三次启动压到预算装得下的总时长（缩短单次 `BOOT_TIMEOUT_MS`、或让三次启动共用一次启动）。无论选哪条，`guard()` 的语义（超预算返回 3）与「红必须指名」的性质都不许削弱。

**不在本条范围。** `server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts` 与 `claude-resident-name-live-mirror.test.ts` 有同样的 `[budget]` 形状（各自 60s 预算 + 自己的截止常量），本条**不动**它们；若核实为同一缺陷，另立任务。

## AC

- [x] AC1（承重，不变式）预算 ≥ 它庇护的各步截止之和：判据文件机械断言 `BUDGET_MS >= 3 * BOOT_TIMEOUT_MS + ROUND_TIMEOUT_MS + GONE_TIMEOUT_MS + SCOPE_TIMEOUT_MS`（若采用「缩短单次启动」路线，则断等价的不变式：最坏情况总耗时 ≤ `BUDGET_MS`）。这条不是注释、不是散文，是一条会红的断言。红态基线：修前该不等式为假（75_000 > 60_000 的那一项）。
- [x] AC2 行为读数（正控制）：一条注入式读数证明预算**真的**庇护得住 —— 把三次启动的耗时注入到逼近 `BOOT_TIMEOUT_MS` 的假读数（或等价地把耗时喂给 `guard`），断言 `guard()` 返回 `0` 而不是 `3`。没有这条，AC1 可能被一个「把所有常量一起改小」的改动满足。
- [x] AC3 取假形态必须红（承重）：把 `BUDGET_MS` 改回 60_000 ⇒ AC1 逐字红；把 `BOOT_TIMEOUT_MS` 改回不满足不变式的值 ⇒ AC1 逐字红。逐条登记变异 diff、逐字失败行与 `git checkout --` 恢复命令，恢复后 `git status --porcelain` 干净。
- [x] AC4 单文件重跑读数：只重跑该判据文件本身（不是全量 suite），逐字记录 `duration_ms` 与是否出现 `[budget] … exit=3`。修后在本机负载下该文件必须跑完并给出 `# pass`，不得再出现 exit 3。
- [x] AC5 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- `guard()` 的语义（`elapsedMs > budgetMs` 返回 3，否则 0）与它在退出路径上的用法**未被削弱** —— 本条改的是预算的**取值依据**，不是「超预算不算红」。
- 预算与各步截止之间的关系是被**断言**的，不是被注释描述的：删掉推导、把某个截止常量单独改大而预算不变时，判据必须红。
- 该文件在原负载条件下重跑过，且读数（`duration_ms`、有无 `[budget]` 行）是逐字记录的真实读数，不是「应该没问题」。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- server/modules/session-hosts/tests/resident-server-restart.test.ts
- tasks/gap-resident-server-restart-budget-shorter-than-its-three-boots.md

## Evidence

（2026-10-02 worker 实施轮；读数取自本机真实运行）

**实现**：`BUDGET_MS` 60_000 → 240_000；新增两条具名断言用例（AC1 不变式、AC2 正控制）。

**AC1/AC2（修复后，仅跑两条断言用例）**：

```
✔ AC1: the process budget is not smaller than the sum of its step deadlines (0.580426ms)
✔ AC2: a run at every step deadline still finishes inside the budget (guard answers 0) (0.142046ms)
ℹ pass 2 / fail 0
```

**AC3 变异 1（`BUDGET_MS` 改回 60_000）**：
diff `@@ -109 +109 @@`：`-const BUDGET_MS = 240_000;` / `+const BUDGET_MS = 60_000;`
逐字失败行：`AssertionError [ERR_ASSERTION]: BUDGET_MS (60000ms) is below the sum of its step deadlines (140000ms): a load-slowed-but-successful boot sequence would be killed by the process guard (exit 3) instead of running to completion, and node:test would name no failing case`
恢复：`git checkout -- server/modules/session-hosts/tests/resident-server-restart.test.ts`；恢复后 `git status --porcelain` 空。

**AC3 变异 2（`BOOT_TIMEOUT_MS` 25_000 → 60_000，floor=245_000 越过预算）**：
diff `@@ -78 +78 @@`：`-const BOOT_TIMEOUT_MS = 25_000;` / `+const BOOT_TIMEOUT_MS = 60_000;`
逐字失败行：`AssertionError [ERR_ASSERTION]: BUDGET_MS (240000ms) is below the sum of its step deadlines (245000ms): a load-slowed-but-successful boot sequence would be killed by the process guard (exit 3) instead of running to completion, and node:test would name no failing case`
恢复同上；恢复后 `git status --porcelain` 空。

**AC4 单文件重跑**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts`，本机 load ~11–16/128 核）：
退出码 0；`ℹ tests 3 / pass 3 / fail 0`；`ℹ duration_ms 9068.584122`；`budget-ms=240000 elapsed-ms=7986`；**无 `[budget]` 行**（grep 为空）。

**AC5 静态门**：`npm run typecheck` exit 0；`npm run lint` exit 0；`git diff develop --stat` 仅 `server/modules/session-hosts/tests/resident-server-restart.test.ts`（+71/-2），与 `## Touches` 对齐。