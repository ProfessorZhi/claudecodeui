---
id: gap-ac-001-criterion-repoint-to-migrated-test
title: AC-001：判据指回搬迁后的真实测试路径（passthrough-parity 黄金基准），并在测试侧固化溯源注释
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-001
---
## Proposal

### 为什么上一轮的 done 没有守住

<!-- dedup-ref -->
上一轮把这条判据做绿的是 `gap-launch-profiles-passthrough-env-parity-test`（`goal_ac: AC-001`，status=done）。它的实现是对的、今天仍然是对的——缺口不在实现，在**记录**：

1. **判据指向的路径被合法搬迁，AC 记录没跟着改。** `380922af` 把该测试落地于 `server/modules/launch-profiles/tests/passthrough-parity.test.ts`（142 行）。`b34a662e`（`refactor(launch-profiles): 拆除旧实体，AC-001 黄金基准移植到新入口`）按 GOAL-001 的拆除清单删掉整个 `server/modules/launch-profiles/` 目录，并把该测试**逐字移植**到 `server/modules/providers/tests/passthrough-parity.test.ts`。AC-001 记录的 `criterion` 至今仍逐字写着旧路径，于是本轮直接实测 `quay goal gate AC-001 --root /data/home/yale/work/claudecodeui` 得到 `verdict: fail`，reason 逐字为 `Could not find 'server/modules/launch-profiles/tests/passthrough-parity.test.ts'`。

2. **判据红不是保证退化。** 同一条命令换到搬迁后的路径：退出 0，`tests 4 / pass 4 / fail 0`（约 564ms）。旧入口 `resolveLaunchSpec` 全仓零引用，拆除是干净的。

3. **移植是忠实的，没有丢覆盖。** 把 `380922af` 版本与现文件逐行 diff，全部差异只有三类：(a) 入口由 `resolveLaunchSpec(null, 'claude')` 换成 `resolveModelLaunchSpec('claude', null)`——这正是 AC-001 的 expect 里那条 ⚠️ 明确要求的「移植到新入口」；(b) 期望值补上新增字段 `unsetEnv: []`；(c) 用例名把 "no profile" 改成 "no configured model"、import 改走 module barrel。**四条用例一条不少**，含 expect 点名的取假形态用例（新增一个键/缺失一个键/改一个值都必须判红）。

4. **expect 点名的两种形态都已有覆盖，故本任务不新增任何测试。** 「未选择带配置的自定义模型」这一句含两半：null 半边（没选模型）由本文件覆盖；「无配置的自定义模型」半边（记录存在但 `config` 为 null）由 `server/modules/providers/tests/model-launch-spec.test.ts:30` 的 `built-in and unconfigured custom models compile to the passthrough spec` 覆盖——它 seed 一条 `plain-custom` 且 `config: null`，断言 `env` / `unsetEnv` / `argv` / `warnings` 四项全空。两半合起来正好是 expect 的全文。

⇒ 本缺口是 `gap-ac-024-criterion-repoint-and-compile-allowlist-coverage` 的**同一机制**（判据指向被合法搬迁/删除的路径）的第二个实例，区别是 AC-024 那次同时丢了编译期白名单半边覆盖，**本次没有丢任何覆盖**，因此只做记录侧修正。

### 方案（最小切片）

1. **把 AC-001 记录的 `criterion` 指回活着的那份测试。** 命令形态（`<QT>` = `/data/home/yale/work/claudecodeui`）：

   `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal write AC-001 --criterion "npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts" --origin "ADR-002；criterion 路径随 b34a662e 的搬迁修正：launch-profiles 目录已按 GOAL-001 拆除，AC-001 黄金基准现居 providers" --root <QT>`

   先加 `--dry-run` 观测一次（已验证 dry-run 不落盘：`git status` 不变），确认后再正式写。

   ⚠️ 这不是「改判据让它变绿」：旧目录是 GOAL-001 拆除清单点名的删除对象，重建它会让本仓库 AC-003（仓库级 grep 无 launch-profiles 引用）与拆除目标正面冲突；搬迁后的文件**就是同一份测试**，四条断言一个不减。本次修正的原因（路径搬迁）必须写进 AC 记录的 `--origin`，保留可追溯性。写完复读 `quay goal show AC-001` 确认：`criterion` 逐字含新路径、**不含** `server/modules/launch-profiles/`、`status` 仍为 `achieved`、`goal` 仍为 `GOAL-001`。

   ⚠️ **并发写 goals/ 的核对**：本轮另有 `gap-ac-024-criterion-repoint-and-compile-allowlist-coverage`（status=ready）同样要执行一次 `quay goal write AC-024`。两次写落在同一个 goals store 上，完成后应复读 `quay goal show AC-024`，确认它的 `criterion` 仍指向 `server/modules/providers/tests/model-launch-spec.test.ts` 与 `model-spawn-env.test.ts`，没有被本次写吃掉。

   ⚠️ 若写出的记录落在 worktree 之外的主检出（历史上出现过这种错位），按仓库惯例把该 commit cherry-pick 到任务分支，别把验收面留在分支外。

2. **在那份测试顶部加溯源注释，让「这份测试属于 AC-001」从测试侧可 grep 到。** 本轮缺口的根因就是这条链只在记录侧存在、记录一改就断：搬迁发生时没有任何东西在测试侧提示「此文件是 AC-001 的黄金基准，只许移植、不许删除或放宽」。

   - 位置：`server/modules/providers/tests/passthrough-parity.test.ts` 顶部（import 之前或之后均可）。
   - 内容必须点名三个串：`AC-001`、`b34a662e`、`server/modules/launch-profiles/tests/passthrough-parity.test.ts`；并写明这是「升级零变化」黄金基准、由 `resolveModelLaunchSpec` 驱动、随新入口再移植是允许的而删除或放宽不是。
   - ⛔ **纯注释**：不改任何断言、不改任何 import、不改任何行为。加完重跑该测试仍须 `pass 4 / fail 0`。

3. **回归**：`quay goal gate AC-001` 转绿；`model-launch-spec.test.ts` 与 `model-spawn-env.test.ts`（AC-024 的判据文件）不受影响。

**边界（不做）**：不重建 `server/modules/launch-profiles/`；不改 `resolveModelLaunchSpec` 的任何语义；不新增/删除/放宽任何断言；不改 AC-024 的记录内容。

## 落地证据

### 判据修正（记录侧）

修正前同一条 gate 实测 `verdict: fail`，reason 逐字含 `Could not find 'server/modules/launch-profiles/tests/passthrough-parity.test.ts'`。`quay goal write AC-001 --criterion … --origin …`（先 `--dry-run` 观测一次，`git status` 不变，确认不落盘）把 `criterion` 指回搬迁后的路径，`--origin` 保留原 ADR-002 引证并追加本次修正原因（b34a662e 把该测试移植到新入口）。写入落在主检出（`9f4c6840`，分支 `author`），按仓库惯例 cherry-pick 进本任务分支（`2e8529cd`），验收面不留分支外。修正后 `quay goal gate AC-001 --root /data/home/yale/work/claudecodeui` 退出 0、`reason: acceptance passed (exit 0)`；复读该记录：`criterion` 逐字含 `server/modules/providers/tests/passthrough-parity.test.ts`，全文 `grep -c 'server/modules/launch-profiles/'` 为 0，`status: achieved`、`goal: GOAL-001` 均在。

### 测试侧溯源注释（注释-only）

`server/modules/providers/tests/passthrough-parity.test.ts` 顶部加了一段 banner，逐字点名 `AC-001`、`b34a662e`、`server/modules/launch-profiles/tests/passthrough-parity.test.ts`（三者 `grep -c` 分别为 3 / 1 / 1），并写明这是「已有安装升级后行为零变化」的黄金基准、由 `resolveModelLaunchSpec` 驱动、随新入口再移植是允许的而删除或放宽不是。

注释-only 由判据 5 的那条 grep 机械证明：`git diff -U0 develop...HEAD -- <该测试>` 的 `+` 行过滤掉注释前缀后输出为空（`grep` 退出 1），`--stat` 为 `17 insertions(+), 0 deletions(-)`。加注释后同一命令 `tests 4 / pass 4 / fail 0`。

### 其余读数

- 判据命令（搬迁后的 providers 路径）：退出 0，`tests 4 / pass 4 / fail 0`。
- 回归：`model-launch-spec.test.ts` + `model-spawn-env.test.ts`（AC-024 的两条判据文件）退出 0，`tests 12 / pass 12 / fail 0`。
- 并发写未互相踩踏：`quay goal show AC-024` 的 `criterion` 仍逐字指向上述两个 providers 路径，`quay goal gate AC-024` 退出 0。
- 边界守住：本轮不新增/删除/放宽任何断言，不重建 `server/modules/launch-profiles/`，不改 `resolveModelLaunchSpec` 语义，不改 AC-024 的记录内容。

## AC

- [x] `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal gate AC-001 --root /data/home/yale/work/claudecodeui` 退出 0（改前实测为 `verdict: fail`，reason 含 `Could not find 'server/modules/launch-profiles/tests/passthrough-parity.test.ts'`；改后必须转绿）。
- [x] `/data/home/yale/work/claudecodeui/goals/AC-001-passthrough-env-parity.md` 的 `criterion` 逐字包含 `server/modules/providers/tests/passthrough-parity.test.ts`，且全文不含 `server/modules/launch-profiles/`；`status` 仍为 `achieved`、`goal` 仍为 `GOAL-001`、`origin` 含本次修正原因（搬迁）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts` 退出码 0 且输出 `pass 4` / `fail 0`。
- [x] `server/modules/providers/tests/passthrough-parity.test.ts` 顶部注释逐字含 `AC-001`、`b34a662e`、`server/modules/launch-profiles/tests/passthrough-parity.test.ts` 三个串（`grep -c` 各 ≥1）。
- [x] 溯源注释是注释-only：`git diff -U0 develop...HEAD -- server/modules/providers/tests/passthrough-parity.test.ts` 中所有 `+` 行（除去 `+++` 头）都匹配注释前缀——`git diff -U0 develop...HEAD -- server/modules/providers/tests/passthrough-parity.test.ts | grep -E '^\+' | grep -v '^+++' | grep -vE '^\+\s*(//|\*|/\*)'` 输出为空。
- [x] `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal show AC-024 --root /data/home/yale/work/claudecodeui` 的 `criterion` 仍指向 `server/modules/providers/tests/model-launch-spec.test.ts` 与 `model-spawn-env.test.ts`（并发写未互相踩踏）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-launch-spec.test.ts server/modules/providers/tests/model-spawn-env.test.ts` 退出码 0（AC-024 两条判据文件未被带动）。

## DoD

真实落地判据：**gate 转绿必须由真实 gate 证明，不是「我改了记录」**。`quay goal gate AC-001` 是唯一权威读数——必须现场由 `fail`（reason 含 `Could not find`）变为退出 0；同一 root 下复读 `goals/AC-001-passthrough-env-parity.md`，`criterion` 逐字正确且不含死路径、`status` 仍 `achieved`。测试侧的溯源注释必须在 `git diff develop...HEAD` 里可见且**零代码行改动**（注释-only 由上面那条 grep 证明），加注释后该测试仍 `pass 4 / fail 0`。下一轮 driver 通过 `goal_ac: AC-001` 独立复跑时，会真的执行那份测试而不是撞 `Could not find`，并在 `model-launch-spec.test.ts:30` 上看到「无配置的自定义模型」半边仍绿——即本判据断言的性质在真实入口上活着，且判据本身指得到它。

L_D：该轴仍暗，理由：本任务只修一条 AC 记录的判据指针与一段注释，不产出新的领域判据，无可读的两轴读数。

## Touches

- goals/AC-001-passthrough-env-parity.md
- server/modules/providers/tests/passthrough-parity.test.ts
- tasks/gap-ac-001-criterion-repoint-to-migrated-test.md