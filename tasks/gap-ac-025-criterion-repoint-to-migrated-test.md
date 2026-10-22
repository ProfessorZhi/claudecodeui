---
id: gap-ac-025-criterion-repoint-to-migrated-test
title: AC-025：判据指回搬迁后的真实测试路径（model-library 网关端到端），并在测试侧固化溯源注释
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-025
---
## Proposal

### 为什么上一轮的 done 没有守住

<!-- dedup-ref -->
上一轮把这条判据做绿的是 `gap-model-library-gateway-end-to-end`（`goal_ac: AC-025`，status=done，实现提交 `ede1b409`）。它的实现是对的、今天仍然是对的 —— 缺口不在实现，在**记录**：

1. **判据指向的路径被合法搬迁，AC 记录没跟着改。** `1d76cac6`（`gap-launch-profiles-relocate-shared-compile-layer`，status=done）把共享的 launch-spec 编译层与 4 个测试整体迁出 `server/modules/launch-profiles/tests/`，其中就包含 AC-025 的判据文件 → 现居 `server/modules/providers/tests/model-gateway-end-to-end.test.ts`。该任务的 `## Touches` 明文登记了这次搬迁（launch-profiles 侧 `.../tests/model-gateway-end-to-end.test.ts (deleted; 已迁出)` + providers 侧 `(new; 迁入)`），但**它的任务体里 `criterion` / `AC-024` / `AC-025` 出现 0 次** —— 搬迁任务只搬了文件，没有回头修正任何一条钉住这些路径的 AC 判据。

2. **随后目录被整体拆除。** `b34a662e`（`gap-launch-profiles-teardown-entity`，status=done）按 GOAL-001 的拆除清单删掉整个 `server/modules/launch-profiles/` 目录（对 gateway 而言它删的是 AC-002 的旧文件 `gateway-end-to-end.test.ts`，208 行；模型版此前已迁出）。

3. **于是判据今天指向一个不存在的路径。** AC-025 记录的 `criterion` 至今逐字写着 `server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts`。

**本轮实测读数（权威）**：`bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal gate AC-025 --root /data/home/yale/work/claudecodeui` → `"verdict": "fail"`，reason 逐字含 `Could not find 'server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts'`，退出 1。

**判据红不是保证退化**：同一条命令换到搬迁后的路径 → 退出 0，`tests 5 / pass 5 / fail 0`（约 12.3s）。

**搬迁是纯改名，零覆盖丢失**：

- `git diff ede1b409:server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts server/modules/providers/tests/model-gateway-end-to-end.test.ts` 输出为**空**（逐字一致）。
- `1d76cac6` 对该文件的 stat 为 `0` 行改动（纯 rename）。
- 五个用例一个不少，逐字保留：`(a) custom model: chat.send reaches the mock endpoint with the secret-row credential`、`(b) unset row: the host ANTHROPIC_API_KEY never reaches the gateway`、`(b-fake) without the unset row the leak assertion goes red`、`(c) built-in model: the request does not reach the mock`、`(d) forged options.env is ignored: the model entry credential and endpoint win`。其中 (b-fake) 正是 expect 点名的取假形态。

⇒ 这是 `gap-ac-001-criterion-repoint-to-migrated-test` 与 `gap-ac-024-criterion-repoint-and-compile-allowlist-coverage` 的**同一机制**（判据钉死的路径被合法搬迁/删除，记录未跟改）的第三个实例。⚠️ 与 AC-024 那次的关键区别：**本次没有任何覆盖丢失**（纯 rename），因此本任务只做记录侧修正 + 一段溯源注释，不新增、不修改任何断言。

### 方案（最小切片）

1. **把 AC-025 记录的 `criterion` 指回活着的那份测试。** 命令形态（`<QT>` = `/data/home/yale/work/claudecodeui`）：

   `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal write AC-025 --criterion "npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-gateway-end-to-end.test.ts" --origin "ADR-002；criterion 路径随 1d76cac6（relocate shared compile layer）与 b34a662e（拆除 launch-profiles 目录）修正：AC-025 的网关端到端判据现居 providers，测试逐字未改、五个用例一个不减" --root <QT>`

   ⚠️ 这不是「改判据让它变绿」：旧目录是 GOAL-001 拆除清单点名的删除对象，重建它会让本仓库的 AC-003（仓库级 grep 无 launch-profiles 引用）与拆除目标正面冲突；搬迁后的文件**就是同一份测试**（上面那条 `git diff` 为空），五个断言一个不减。本次修正的原因（路径搬迁）必须写进 `--origin`，保留可追溯性。

   写后**必须**复读核对：`quay goal show AC-025`（或直接读 `<QT>/goals/AC-025-gateway-request-lands-with-the-credential-from-a-model-entry.md`）确认 —— `criterion` 逐字含 `server/modules/providers/tests/model-gateway-end-to-end.test.ts`、**不含** `server/modules/launch-profiles/`、`status` 仍为 `achieved`、`goal` 仍为 `GOAL-001`、`supersedes` 仍含 `AC-002`。

   另跑 `git diff --stat -- goals/` 确认**恰好一个**记录文件被改 —— 这同时拦住「误改他记录」与「写到别处」。

   <!-- dedup-ref -->
   ⚠️ **并发写 goals/ 的核对**：本轮另有两条姐妹任务同样要对同一个 goals store 各写一次。写完后复读它们的记录，确认 `criterion` 仍指向 `server/modules/providers/tests/` 下的各自文件、没有被本次写吃掉。（读法见上面那条 AC。）

   ⚠️ 若写出的记录 commit 落在 worktree 之外的主检出（历史上出现过这种错位），按仓库惯例把该 commit cherry-pick 到任务分支，别把验收面留在分支外。

2. **在那份测试顶部加溯源注释，让「这份测试属于 AC-025」从测试侧可 grep 到。** 本轮缺口的根因是这条链只在记录侧存在、记录一改就断：搬迁发生时没有任何东西在测试侧提示「此文件是 AC-025 的网关端到端判据，只许随 AC 记录一并搬迁、不许删除或放宽」。

   - 位置：`server/modules/providers/tests/model-gateway-end-to-end.test.ts` 顶部（import 之前或之后均可）。
   - 内容必须点名三个串：`AC-025`、`1d76cac6`、`server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts`；并写明这是 model-library 网关端到端判据（真实 chat.send → mock Anthropic 兼容端点，凭据来自模型条目），随新入口再搬迁是允许的，但删除或放宽不是。
   - ⛔ **纯注释**：不改任何断言、不改任何 import、不改任何行为。加完重跑该测试仍须 `pass 5 / fail 0`。

3. **回归**：`quay goal gate AC-025` 转绿；AC-001 与 AC-024 的判据文件不受影响。

**边界（不做）**：不重建 `server/modules/launch-profiles/`；不改 `resolveModelLaunchSpec` / 网关编译或派发的任何语义；不新增、不删除、不放宽任何断言；不改 AC-001 / AC-024 的记录内容；不改 `scripts/` 与套件机制。

## AC

- [x] `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal gate AC-025 --root /data/home/yale/work/claudecodeui` 退出 0（改前实测为 `"verdict": "fail"`，reason 含 `Could not find 'server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts'`；改后必须转绿）。
- [x] `/data/home/yale/work/claudecodeui/goals/AC-025-gateway-request-lands-with-the-credential-from-a-model-entry.md` 的 `criterion` 逐字包含 `server/modules/providers/tests/model-gateway-end-to-end.test.ts`，且全文不含 `server/modules/launch-profiles/`；`status` 仍为 `achieved`、`goal` 仍为 `GOAL-001`、`supersedes` 仍含 `AC-002`、`origin` 含本次修正原因（搬迁）。
- [x] `git diff --stat -- goals/` 显示恰好一个记录文件被修改（本次写未波及其他 AC 记录）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-gateway-end-to-end.test.ts` 退出码 0 且输出 `pass 5` / `fail 0`。
- [x] `server/modules/providers/tests/model-gateway-end-to-end.test.ts` 顶部注释逐字含 `AC-025`、`1d76cac6`、`server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts` 三个串（`grep -c` 各 ≥1）。
- [x] 溯源注释是注释-only：`git diff -U0 develop...HEAD -- server/modules/providers/tests/model-gateway-end-to-end.test.ts | grep -E '^\+' | grep -v '^+++' | grep -vE '^\+\s*(//|\*|/\*)'` 输出为空。
- [x] `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal show AC-001 --root /data/home/yale/work/claudecodeui` 的 `criterion` 仍指向 `server/modules/providers/tests/passthrough-parity.test.ts`，`... goal show AC-024 --root ...` 的 `criterion` 仍指向 `server/modules/providers/tests/model-launch-spec.test.ts` 与 `server/modules/providers/tests/model-spawn-env.test.ts`（并发写未互相踩踏）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts server/modules/providers/tests/model-launch-spec.test.ts server/modules/providers/tests/model-spawn-env.test.ts` 退出码 0（AC-001 / AC-024 判据文件未被带动）。
- [x] `npm run typecheck`、`npm run lint` 退出码 0。

## DoD

真实落地判据：**gate 转绿必须由真实 gate 证明，不是「我改了记录」**。`quay goal gate AC-025` 是唯一权威读数 —— 必须现场由 `fail`（reason 含 `Could not find`）变为退出 0；同一 root 下复读 `goals/AC-025-*.md`，`criterion` 逐字正确且不含死路径、`status` 仍 `achieved`、`supersedes` 仍含 `AC-002`，且 `git diff --stat -- goals/` 证明本次只动了这一条记录。测试侧的溯源注释必须在 `git diff develop...HEAD` 里可见且**零代码行改动**（注释-only 由上面那条 grep 证明），加注释后该测试仍 `pass 5 / fail 0`。下一轮 driver 通过 `goal_ac: AC-025` 独立复跑时，会真的执行那份测试而不是撞 `Could not find`，并看到 (a)/(b)/(b-fake)/(c)/(d) 五个用例仍绿 —— 即本判据断言的性质在真实链路上活着，且判据本身指得到它。

L_D 该轴仍暗，理由：本任务只修一条 AC 记录的判据指针与一段注释，不产出新的领域判据，无可读的两轴读数。
L_G 该轴仍暗，理由：同上。

## Touches

- goals/AC-025-gateway-request-lands-with-the-credential-from-a-model-entry.md
- server/modules/providers/tests/model-gateway-end-to-end.test.ts
- tasks/gap-ac-025-criterion-repoint-to-migrated-test.md
