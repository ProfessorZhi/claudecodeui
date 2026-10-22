---
id: gap-ac-028-criterion-repoint-to-migrated-test
title: AC-028：判据指回搬迁后的真实测试路径（model-context-window 现居 providers），并在测试侧固化溯源注释
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-028
---
## Proposal

### 为什么上一轮的 done 没有守住

<!-- dedup-ref -->
同一机制在 GOAL-001 下的第三个实例（前两个实例的任务 id：`gap-ac-001-criterion-repoint-to-migrated-test`、`gap-ac-024-criterion-repoint-and-compile-allowlist-coverage`；另 `gap-ac-025-criterion-repoint-to-migrated-test` 同族）。三次都是同一个根因，AC-028 这条与前两次**不同路径、不同 AC 记录**，故不复用其任务。AC-028 的实现是好的、今天仍然是对的 —— 缺口不在实现，在**记录**：

1. **判据指向的路径被合法搬迁，AC 记录没跟着改。** `1d76cac6`（`refactor(providers): relocate the shared launch-spec compile layer out of launch-profiles`）把共享的 launch-spec 编译层与测试整体搬进 `server/modules/providers/`，git 识别为 `R098` 重命名：`server/modules/launch-profiles/tests/model-context-window.test.ts` → `server/modules/providers/tests/model-context-window.test.ts`。随后 `b34a662e`（拆除旧实体）按 GOAL-001 的拆除清单删掉整个 `server/modules/launch-profiles/` 目录。AC-028 记录的 `criterion` 至今仍逐字写着旧路径，于是判据命令指向一个不存在的文件。

2. **判据红不是保证退化。** 本轮实测 `quay goal gate AC-028 --root <QT>` → `verdict: fail`，reason 逐字为 `acceptance failed (exit 1) — … Could not find 'server/modules/launch-profiles/tests/model-context-window.test.ts'`（2026-09-21T04:03:53.863Z）。把同一条命令换成搬迁后的路径：退出 0，`tests 3 / pass 3 / fail 0`（约 902ms）。这是「判据指向死路径」，不是「被断言的性质失效」。

3. **搬迁是忠实的，覆盖一条没丢。** `git diff 1d76cac6^:server/modules/launch-profiles/tests/model-context-window.test.ts HEAD:server/modules/providers/tests/model-context-window.test.ts` 的全部差异只有一处：`resolveModelContextWindowRow` 的导入由 `@/modules/launch-profiles/index.js` 并入既有的 `@/modules/providers/index.js` 导入行。**断言、用例名、fixture 一字未改**，没有新增、删除或放宽任何一条。

4. **expect 的每一半在搬迁后的文件里都仍有覆盖，故本任务不新增任何测试。** 逐半对照：

| AC-028 expect 的句子 | 现文件里的承重断言 |
|---|---|
| 同一个值随 spawn 环境导出给 CLI | `assert.equal(spawn, '917000')`（`spawn` 取自 `mapCliOptionsToSDK({ model }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`） |
| 也决定该模型会话的用量 total | `assert.deepEqual(totals, [917000, 917000, 917000])` |
| SDK 路径的 extractTokenBudget | `totals[0]` = `extractTokenBudget(assistant, row)?.total` |
| SDK 路径的 extractCumulativeTokenBudget | `totals[1]` = `extractCumulativeTokenBudget(result, row)?.total` |
| token-usage 汇总接口 | `totals[2]` = `(await service.getSessionTokenUsage('s')).total`（真实 `createProviderTokenUsageService`） |
| 解析顺序：该模型的行 → 宿主 CONTEXT_WINDOW → 160000 | 行存在取 917000；无该行（`norow`）取 `CONTEXT_WINDOW=54321`；二者皆无取 160000 |
| 非法值（0、负数、非数字）落到下一级 | `['zero','neg','abc']` 三者在 `CONTEXT_WINDOW=54321` 下均取 54321，在无 `CONTEXT_WINDOW` 下均取 160000 |
| 无配置的模型与内置模型行为与今日一致 | `norow`（有记录、env 里无该行）与内置 `opus`（库中未知）两条都在 |
| 取假形态：来自 `options.profile?.contextWindow` 或 `process.env.CONTEXT_WINDOW` 必红 | 第三条用例的 `profileOnly()` / `hostOnly()` 两个负变体 + `assert.notEqual` |

⇒ 本缺口是纯记录侧的「判据指向被合法搬迁的路径」，与 AC-024 那次（同时丢了编译期白名单半边覆盖）不同，**本次没有丢任何覆盖**，因此只做记录侧修正 + 一段测试侧溯源注释。

### 方案（最小切片）

约定：`<QT>` = `/data/home/yale/work/claudecodeui`；`<QUAY>` = `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay`。

1. **把 AC-028 记录的 `criterion` 指回活着的那份测试。**

   `<QUAY> goal write AC-028 --criterion "npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-context-window.test.ts" --origin "ADR-002 决策 6；2026-09-20 复核：AC-005/AC-014 以 profile 与类型化字段为对象，不符合当前方向；criterion 路径随 1d76cac6 的搬迁修正：launch-profiles 目录已按 GOAL-001 拆除，测试现居 providers" --root <QT>`

   先加 `--dry-run` 观测一次（已验证 dry-run 不落盘：`git status` 不变），确认后再正式写。

   ⛔ **不是「改判据让它变绿」**：旧目录是 GOAL-001 拆除清单点名的删除对象，重建它会让本仓库「无 launch-profiles 引用」的拆除目标正面冲突；搬迁后的文件**就是同一份测试**，九条承重断言一个不减（见上表）。本次修正的原因（路径搬迁）必须写进 AC 记录的 `--origin`，保留可追溯性。

   写完复读 `<QUAY> goal show AC-028 --root <QT>` 确认：`criterion` 逐字正确、**不含** `server/modules/launch-profiles/`、`status` 仍为 `achieved`、`goal` 仍为 `GOAL-001`、`origin` 同时保留了 ADR-002 的存量信息与本次修正原因。

   ⚠️ 若写出的记录落在 worktree 之外的主检出（本仓历史上出现过这种错位），按仓库惯例把该 commit cherry-pick 到任务分支，别把验收面留在分支外。

   ⚠️ **并发写 goals/ 的核对**：本 store 中另有 AC-024 / AC-025 的 repoint 任务可能同时段写同一个 goals store。完成后复读 `AC-024` 与 `AC-025` 的 `criterion`，确认没有被本次写吃掉。

2. **在测试顶部加溯源注释，让「这份测试属于 AC-028」从测试侧可 grep 到。** 本轮缺口的根因就是这条链只在记录侧存在、记录一改就断：搬迁发生时没有任何东西在测试侧提示「此文件是 AC-028 的判据文件，只许移植、不许删除或放宽」。

   - 位置：`server/modules/providers/tests/model-context-window.test.ts` 顶部。
   - 内容必须点名两个串：`AC-028`、`1d76cac6`；并写明这是 AC-028 判据所指向的文件、由 `resolveModelContextWindowRow` 与两条 token 路径驱动、随未来搬迁再移植是允许的而删除或放宽断言不是。
   - ⛔ **不要**把旧路径字符串写进注释：旧目录名已被 GOAL-001 拆除，重写回 `server/` 会把刚清掉的标识重新引入（AC-001 的同类注释要求逐字含旧路径，那一处是待裁定的历史；本任务**不**复制该要求）。溯源信息由 `AC-028` + `1d76cac6` 两个串承载，`git log --follow` 可据此复原旧路径。
   - ⛔ **纯注释**：不改任何断言、不改任何 import、不改任何行为。加完重跑该测试仍须 `pass 3 / fail 0`。

3. **回归**：`goal gate AC-028` 转绿；`model-launch-spec.test.ts` / `model-spawn-env.test.ts`（AC-024 的判据文件）与 `passthrough-parity.test.ts`（AC-001 黄金基准）不受影响。

**边界（不做）**：不重建 `server/modules/launch-profiles/`；不改 `resolveModelContextWindowRow` / `extractTokenBudget` / `extractCumulativeTokenBudget` / `provider-token-usage.service.ts` 的任何行为；不新增、删除或放宽任何断言；不改 AC-024 / AC-025 的记录内容；本条只修 AC-028 一条判据指针，其余 GOAL-001 AC 的同类死路径由各自的 repoint 任务处理。

## AC

- [x] `<QUAY> goal gate AC-028 --root <QT>` 退出 0（改前实测 `verdict: fail`，reason 含 `Could not find 'server/modules/launch-profiles/tests/model-context-window.test.ts'`；改后必须转绿为 `verdict: pass`）。
- [x] `<QT>/goals/AC-028-model-env-row-is-the-single-source-of-the-context-window.md` 的 `criterion` 逐字包含 `server/modules/providers/tests/model-context-window.test.ts`，且全文不含 `server/modules/launch-profiles/`；`status` 仍为 `achieved`、`goal` 仍为 `GOAL-001`、`origin` 含本次修正原因（搬迁）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-context-window.test.ts` 退出码 0 且输出 `pass 3` / `fail 0`。
- [x] `server/modules/providers/tests/model-context-window.test.ts` 顶部注释逐字含 `AC-028`、`1d76cac6` 两个串；且 `grep -c "launch-profiles" server/modules/providers/tests/model-context-window.test.ts` 输出 0（不得把已拆除的旧目录名写回 server/）。
- [x] 溯源注释是注释-only：`git diff -U0 develop...HEAD -- server/modules/providers/tests/model-context-window.test.ts | grep -E '^\+' | grep -v '^+++' | grep -vE '^\+\s*(//|\*|/\*)'` 输出为空。
- [x] `git diff --name-only develop...HEAD -- server/modules/launch-profiles/` 输出为空（旧目录未被重建）。
- [x] `<QUAY> goal show AC-024 --root <QT>` 与 `<QUAY> goal show AC-025 --root <QT>` 的 `criterion` 仍分别指向 `server/modules/providers/tests/model-launch-spec.test.ts`+`model-spawn-env.test.ts` 与 `server/modules/providers/tests/model-gateway-end-to-end.test.ts`（并发写未互相踩踏；若与本任务无关地已被改写，记录实际读数即可）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts server/modules/providers/tests/model-launch-spec.test.ts server/modules/providers/tests/model-spawn-env.test.ts` 退出码 0（AC-001 / AC-024 的判据文件未被带动）。
- [x] `npm run typecheck`、`npm run lint` 退出码 0；`bash scripts/test.sh --for-task gap-ac-028-criterion-repoint-to-migrated-test --allow-thin` 退出码 0（scoped 自测；全量套件是 fan-in 的合并闸，不是 worker 的自测）。

## DoD

真实落地判据：**gate 转绿必须由真实 gate 证明，不是「我改了记录」**。`quay goal gate AC-028` 是唯一权威读数 —— 必须现场由 `fail`（reason 含 `Could not find`）变为退出 0；同一 root 下复读 `goals/AC-028-*.md`，`criterion` 逐字正确且不含死路径、`status` 仍 `achieved`、`goal` 仍 `GOAL-001`。测试侧的溯源注释必须在 `git diff develop...HEAD` 里可见且**零代码行改动**（注释-only 由上面那条 grep 证明），加注释后该测试仍 `pass 3 / fail 0`。下一轮 driver 通过 `goal_ac: AC-028` 独立复跑时，会真的执行那三条用例而不是撞 `Could not find` —— 即本判据断言的性质（模型条目的行同时决定 spawn 导出与三条 total 路径）在真实入口上活着，且判据本身指得到它。判据修正前必须先以 `--dry-run` 验证不落盘，且写出的记录若落在 worktree 之外须 cherry-pick 回任务分支，别把验收面留在分支外。

### 落地证据（本 worker 实测）

- 改前 `<QUAY> goal gate AC-028 --root <QT>` = `verdict: fail`，reason 含 `Could not find 'server/modules/launch-profiles/tests/model-context-window.test.ts'`（2026-09-21T04:06:59.647Z，本 worktree root）；改后同一命令 = `verdict: pass` / `acceptance passed (exit 0)`。
- `goal write AC-028 --criterion … --origin …` 的 `--dry-run` 先跑一次：输出 `status: achieved` / `goal: GOAL-001` / `criterion` 逐字为新路径，`git status` 无变化（不落盘）。
- 正式写落在 worktree 之外的主检出（该 CLI 的 goal store 以主检出为准，写成了 `77023f37`），已按仓库惯例 `git cherry-pick` 回任务分支（`36e755ab`）；验收面留在任务分支内。
- 溯源注释加后 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-context-window.test.ts` = 退出 0，`tests 3 / pass 3 / fail 0`。
- `grep -c 'AC-028'` = 4、`grep -c '1d76cac6'` = 1、`grep -c 'launch-profiles'` = 0（该测试文件）。
- 注释-only 与旧目录未重建两条 grep 均输出为空；AC-024 / AC-025 的 `criterion` 复读分别仍为 `model-launch-spec.test.ts`+`model-spawn-env.test.ts` 与 `model-gateway-end-to-end.test.ts`。
- `npm run typecheck` / `npm run lint` / `bash scripts/test.sh --for-task … --allow-thin` 退出码均为 0（scoped 自测 `__PERFILE__ … model-context-window.test.ts passed=true`）。

L_D 该轴仍暗，理由：本任务只修一条 AC 记录的判据指针与一段溯源注释，不新增领域能力，也没有可读的两轴读数。
L_G 该轴仍暗，理由：同上。

## Touches

- goals/AC-028-model-env-row-is-the-single-source-of-the-context-window.md
- server/modules/providers/tests/model-context-window.test.ts
- tasks/gap-ac-028-criterion-repoint-to-migrated-test.md
