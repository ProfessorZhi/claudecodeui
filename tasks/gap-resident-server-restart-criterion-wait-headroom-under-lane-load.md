---
id: gap-resident-server-restart-criterion-wait-headroom-under-lane-load
title: AC-166 判据在 lane/舰队并发下红：resident 宿主 (重)spawn 的 30s ROUND_TIMEOUT_MS
  等待装不下并发下的真实重拉（记忆实测 in-lane 38.9s vs standalone 8.7s），负载下「慢但正确」的重拉撞
  waitForResidentPid:776 超时——上一次修的是 BUDGET 不是 wait
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-166
---
## Proposal

来源：本轮 gap-filing 的直接测量，不是台账尾巴。AC-166 已离开 reverify 范围（其 GOAL-013 已 achieved、不再活跃），且未声明 `long-term: true`，台账尾部记为 CURRENTLY FALSE；本轮在立案前直接重跑了判据本身，并读驱动环/台账的原始读数。

判据命令（不变）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts`。

**本轮的直接量（不是推断）**

- **standalone 绿**（canonical checkout，HEAD `0170aee9`，`env -u HOST -u DATABASE_PATH -u SERVER_PORT`）：`EXIT=0`、`tests 3 / pass 3 / fail 0`、`budget-ms=240000 elapsed-ms=8222`；三条腿全绿（`sigterm … closeReason=server-shutdown`、`sigkill … swept=1`、`restart old-pid≠new-pid`）。
- **驱动自己的 frozenRecheck 也绿**：`.quay/goal-round.jsonl` 轮 872–877（2026-10-04T22:41–22:48Z）对 AC-166 全部 `verdict: pass`、`outcome: cleared`、`cause: now-true`，duration 10.4–16.2s。
- **但台账尾部是红的**：`.quay/gate-events.jsonl` `2026-10-04T22:50:04.888Z`、`actor: goal-cli`、`verdict: fail`，`reason` 逐字带该文件堆栈：`… resident-server-restart.test.ts:776:13) at async TestContext.<anonymous> (… resident-server-restart.test.ts:1175:22)` —— 即 `waitForResidentPid`（在 `:776` 抛 `Timed out after ${timeoutMs}ms waiting for …`）被 leg 5 的第三次启动重拉等待（`:1175`）调用。

**机制（是算术，不是负载玄学）**

`ROUND_TIMEOUT_MS = 30_000`（`:80`）是每个 `waitForResidentPid` 给**真** resident `claude` 宿主 (重)spawn 并注册的等待——第一次 `:959/:963`、第二次 `:1056/:1060`、第三次 `:1175/:1179`。这条等待与它庇护的真实重拉时长之间没有余量项：lane/舰队并发下真实重拉超过 30s。本仓已有同文件的实测（记忆 `resident-server-restart-sweep-zero-is-a-scope-collection-race` 的第三次观察，2026-10-04）：同 worktree、同 runner，in-lane 38.9s vs standalone 8.7s —— **4.5× 超订膨胀**，一次重拉本身就超过 30s。文件自己的不变式（`:151` 的 AC1 用例，以及 `:171` 的 AC2 正控制）把**各腿截止之和**钉在 `BUDGET_MS` 之下；但**没有任何一项**约束**单腿**的负载膨胀，`ROUND_TIMEOUT_MS` 这个最紧的腿更是毫无余量。

<!-- dedup-ref --> **为什么上一次的修法没兜住**：`gap-resident-server-restart-budget-shorter-than-its-three-boots`（`goal_ac: AC-166`，**done**，2026-10-02）把 `BUDGET_MS` 60_000→240_000，消除了「3×`BOOT_TIMEOUT_MS`(75s) 单独越过预算 ⇒ `process.exit(3)` 进程级 kill」这条红——这是**预算**面。它一字未动 `ROUND_TIMEOUT_MS`。于是下一轮负载红只是从**进程级 kill**挪到了**等待腿**：本轮红文案逐字落在 `waitForResidentPid:776`（不是 `[budget] … exit=3`）。最早建判据的 `gap-claude-resident-server-restart`（`goal_ac: AC-166`，**done**）也没预见单腿的并发膨胀。两条都已 done，故本条不是重复，而是「早先的修法没有覆盖这一机制」。

**修法（owner 侧、判据加固——本仓自定的唯一合法编辑，见记忆 `scoped-gate-can-red-on-fleet-load-boot-timeout`）**：把 resident 宿主 (重)spawn 的等待**给出实测负载余量**，并把这个余量写成**会红的断言**而不是注释。

1. 抬高 `ROUND_TIMEOUT_MS`，使「负载拖慢但正确」的重拉能跑完；同时保持 AC1 的不变式 `BUDGET_MS >= 3*BOOT_TIMEOUT_MS + ROUND_TIMEOUT_MS + GONE_TIMEOUT_MS + SCOPE_TIMEOUT_MS` 成立，且各腿之和**远**低于 `BUDGET_MS`（当前 floor = 3×25 + 30 + 20 + 15 = 140_000，预算 240_000 有余量可用）。`BUDGET_MS` 保持**独立取值**（文件 `:99`–`:108` 的注释已说明为何不写成常量函数），不得改成截止常量的函数。
2. 把「单腿等待 × 负载余量」写进被断言的不变式家族（扩展现有 AC1/AC2 用例或新增具名用例），使它可红：删掉余量、或把某腿改大到越过余量时必须逐字红。
3. **不动的面**：判据命令；每一条语义断言（`closeReason` 逐字 `server-shutdown`、重启后 `lifecycle_mode=resident` / `running=false` / reason 非空、`old-pid != new-pid`、`survivor=true`）；不加 `retries`、不加 `skip`、不删假形态臂。

**归因与非目标**：触发源是 lane 并发下**真实 `claude` 重拉的延迟**，不在本仓可控范围——本仓修的是**响应方式**（无余量等待 → 带实测负载余量的等待 + 不变式）。⛔ 不得改判据命令 / 改断言 / 加 retries 换绿。同文件的 `swept=0`（下次启动无物可扫）是同一 flake 的**兄弟形态**，当前由 `SWEEP_ATTEMPTS = 3` 重试（`:1082` 的 `if (swept === 0 && attempt < SWEEP_ATTEMPTS)`）兜住；若复发，按同一宿主负载归因登记，**不重实现产品代码**。既有 per-run / 宿主层判据是硬约束，一字节不动。

## Plan

1. 读该文件当前的 `waitForResidentPid` 调用点（`:963`/`:1060`/`:1179`）与各腿截止常量，确认 `ROUND_TIMEOUT_MS` 是唯一最紧、且被三次重拉共用的等待。
2. 取实测负载余量（本仓已记 in-lane 38.9s vs standalone 8.7s；本轮再取一次 standalone 与并发读数），据此抬高 `ROUND_TIMEOUT_MS`，并核对 floor 仍远低于 `BUDGET_MS`。
3. 把余量写成会红的断言（AC1 家族），含正控制（合法取值下 `guard`/不变式返回绿）。
4. 单跑该判据 ≥5 次，另加一次与 ≥3 份重负载兄弟判据并发，逐次记 wall/exit/elapsed。
5. 取假形态（短路 `server/index.ts:571` 的清扫调用 + 去掉 `claude-host-driver.provider.ts:2480` 的 `state.queue.end()`），抄退出码与红态文案，`git checkout --` 还原。
6. `npm run typecheck`、`npm run lint` 退出 0；写完成记录。

## AC

- [x] AC1 承重（逐腿等待余量被**断言**，不是注释）：判据文件里出现一个会红的「单腿等待的负载余量」不变式（并入现有 AC1/AC2 用例或新增具名用例），并据此抬高 `ROUND_TIMEOUT_MS`；红态基线：把 `ROUND_TIMEOUT_MS` 改回不满足余量的值 ⇒ 该断言**逐字红**；恢复后绿。验证：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` 两次运行的 `echo $?` + 逐字失败行；`npm run typecheck` 退出 0。
- [x] AC2 判据命令与断言面不变：运行命令与 AC 记录 `criterion:` 逐字一致；`git diff develop -- server/modules/session-hosts/tests/resident-server-restart.test.ts | grep -cE "^-.*(server-shutdown|lifecycle_mode|running, false|RESIDENT_NOT_RUNNING_REASON|distinct|survivor)"` 为 **0**（未被删除/放宽的语义断言）；`grep -cE "\.skip\(|retries" <file>` 不增。验证：上述 grep/diff 的逐字输出。
- [x] AC3 负载下连续绿：该命令连续 ≥5 次 `exit 0`、每次打印 `elapsed-ms` 且 `elapsed-ms` 远小于 `BUDGET_MS`，其中至少一次与 ≥3 份重负载兄弟判据**并发**（如 `process-containment.test.ts` + 两份 `resident-*.test.ts` / `claude-resident-*.test.ts`）——并发那次的 wall/exit 逐字记录；同跑兄弟若自己红，**点名归因**（记忆 `resident-criterion-transiently-caps-a-shared-production-slice`）。验证：逐次 `echo $?` + wall/elapsed。
- [x] AC4 假形态仍红（承重，判据文件一字不动）：把 (a) `server/index.ts:571` 的 `sweepOrphanClaudeSessionScopes()` 调用点短路 **且** (b) `claude-host-driver.provider.ts:2480` 的 `state.queue.end()` 去掉（CLI 不因 EOF 退出）⇒ 判据退出**非 0**，红落在「下次启动仍有残留进程」那条读数上（`sigkill-residue … alive-at-next-boot=true` / `/proc/<b>` 仍在）。登记变异 diff + 逐字失败行；`git checkout --` 还原后回绿（正控制）。验证：两次运行的 `echo $?` + 失败断言逐字。
- [x] AC5 静态门与边界：`npm run typecheck`、`npm run lint` 退出 0；`git diff --stat` 只列 `## Touches` 的文件（AC4 的临时变异写点已还原，不进最终 diff）。验证：命令输出 + `git status --porcelain`。

## DoD

真落地标准：driver 下一轮 goal-gate 复跑该判据并把 pass 写进 `.quay/gate-events.jsonl`（AC-166 台账尾部不再是 CURRENTLY FALSE），且此绿在随后**连续多轮** frozenRecheck 中保持 pass。⛔ 不得用改判据命令 / 改断言 / `skip` / `retries` / 放宽语义断言换绿；AC1 的余量必须是**一条会红的断言**（删掉余量或把某腿改大时必须红），不是散文。AC3 的 ≥5 连绿（含一次 ≥3 份兄弟并发）逐次 wall/exit/elapsed 写进完成记录；AC4 的假形态读数与还原读数一并登记。完成记录必须写明：本仓修的是**响应方式**（单腿等待加实测负载余量 + 把它变成不变式），触发源（lane 并发的真实 `claude` 重拉延迟）不在本仓可控范围，故稳定性**依赖余量而非触发源消失**；若红仍复发，按宿主负载归因（记忆 `resident-server-restart-sweep-zero-is-a-scope-collection-race` / `resident-server-restart-boot-health-timeout-is-load-flake`），不得栽到本任务头上。

## Touches

- `server/modules/session-hosts/tests/resident-server-restart.test.ts`（判据：单腿等待负载余量 + 不变式断言）
- `server/index.ts`（仅 AC4 假形态变异的临时写点，跑完 `git checkout --` 还原，不进最终 diff）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（同上，仅 AC4 临时变异写点，跑完还原）
- `tasks/gap-resident-server-restart-criterion-wait-headroom-under-lane-load.md`（自触）

## Evidence

（2026-10-05 worker 实施轮；读数取自本机真实运行，worktree `task/gap-resident-server-restart-criterion-wait-headroom-under-lane-load`；判据运行一律 `env -u HOST -u DATABASE_PATH -u SERVER_PORT`）

**实现**：`ROUND_TIMEOUT_MS` 30_000 → 60_000（= `MEASURED_LANE_ROUND_MS` 38_900 × `ROUND_LOAD_MARGIN` 1.5）；新增具名断言用例 `AC1b: the per-round wait carries the measured lane-load margin`；`BUDGET_MS` 保持独立 240_000，AC1 floor 140_000 → 170_000（仍远低于预算）。判据命令、每一条语义断言、`skip`/`retries` 一字未动。

**AC1 红态基线**（`ROUND_TIMEOUT_MS` 改回 30_000，`npx tsx … --test --test-name-pattern=AC1b <file>`）：`echo $?` = 1；逐字失败行：
`AssertionError [ERR_ASSERTION]: ROUND_TIMEOUT_MS (30000ms) is below the measured lane-load requirement (38900ms x 1.5 = 58350ms): a resident (re)spawn slowed by concurrent lane load would time out at waitForResidentPid even though it was still going to succeed — the load red this margin exists to absorb.`
恢复 60_000 后 `--test-name-pattern=AC1b` `echo $?` = 0。
**AC1 反向**（`ROUND_TIMEOUT_MS` 改大到 200_000 ⇒ floor=310_000 越过预算，`--test-name-pattern=AC1:`）：`echo $?` = 1；逐字：
`AssertionError [ERR_ASSERTION]: BUDGET_MS (240000ms) is below the sum of its step deadlines (310000ms): a load-slowed-but-successful boot sequence would be killed by the process guard (exit 3) instead of running to completion, and node:test would name no failing case`。

**AC2**：`git diff develop -- server/modules/session-hosts/tests/resident-server-restart.test.ts | grep -cE "^-.*(server-shutdown|lifecycle_mode|running, false|RESIDENT_NOT_RUNNING_REASON|distinct|survivor)"` = **0**；`grep -cE "\.skip\(|retries"`：develop=1 / now=1（未增）。

**AC3 连续绿**（修复后，standalone，逐次）：
```
run1 EXIT=0 wall_ms=12219 elapsed-ms=9801
run2 EXIT=0 wall_ms=12606 elapsed-ms=10277
run3 EXIT=0 wall_ms=12277 elapsed-ms=9940
run4 EXIT=0 wall_ms=12264 elapsed-ms=10013
run5 EXIT=0 wall_ms=12389 elapsed-ms=10018
```
**AC3 并发**（本判据 + 3 份重负载兄弟同时起）：判据 `EXIT=0 wall_ms=12555 elapsed-ms=10133`；兄弟 `process-containment.test.ts EXIT=0 wall=2190ms`、`claude-resident-process.test.ts EXIT=0 wall=14738ms`、`claude-resident-idle.test.ts EXIT=0 wall=2359ms` —— 无兄弟红，无需点名归因。（本机本轮为安静态，in-lane 膨胀未复现：standalone 10_262ms / concurrent 10_106ms；历史 in-lane 38.9s vs standalone 8.7s 见记忆 `resident-server-restart-sweep-zero-is-a-scope-collection-race`，正因不可按需复现才用余量而非改触发源。）

**AC4 假形态**（承重，判据文件一字不动）：变异 diff —
```
server/index.ts:            - ? sweepOrphanClaudeSessionScopes()   / + ? [] // AC4 fake form
claude-host-driver.provider.ts: - state.queue.end();              / + // AC4 fake form: removed
```
判据 `echo $?` = **1**；读数逐字：`sigkill-residue pid=2734613 alive-at-next-boot=false swept=0` → `sigkill-attempt 1/3 read swept=0; repeating with the fresh boot` → `sigkill-residue pid=2735911 alive-at-next-boot=true swept=0` → `sigkill-attempt 2/3` → `sigkill-residue pid=2744158 alive-at-next-boot=true swept=0`；逐字失败行：
`AssertionError [ERR_ASSERTION]: the next boot swept nothing in 3 attempt(s) (swept=0); the orphan was not there to reap`（`resident-server-restart.test.ts:1177`）。`git checkout --` 还原两文件后 `git status --porcelain` 空，判据回绿（上面 AC3 的 5 连绿即还原后读数）。

**AC5 静态门**：`npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）；`git diff --stat develop` 仅 `server/modules/session-hosts/tests/resident-server-restart.test.ts`（+67/-6），与 `## Touches` 对齐；`git status --porcelain` 空。

**归因说明**：本仓修的是**响应方式**（单腿等待加实测负载余量，`ROUND_TIMEOUT_MS` 30s→60s，并把它写成会红的断言 AC1b），触发源（lane 并发的真实 `claude` 重拉延迟）不在本仓可控范围，故稳定性**依赖余量而非触发源消失**。若红仍复发，按宿主负载归因（记忆 `resident-server-restart-sweep-zero-is-a-scope-collection-race` / `resident-server-restart-boot-health-timeout-is-load-flake`），不得栽到本任务头上。
