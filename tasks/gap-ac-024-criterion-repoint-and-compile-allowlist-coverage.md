---
id: gap-ac-024-criterion-repoint-and-compile-allowlist-coverage
title: AC-024：判据指回搬迁后的真实测试路径，并补回被拆除任务丢掉的编译期白名单半边（LD_PRELOAD 直写库也不得进最终 spawn 环境）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-024
---
## Proposal

### 为什么上一轮的 done 没有守住

<!-- dedup-ref -->
上一轮把这条判据做绿的是 `gap-model-library-compile-spawn-env`（AC-024，status=done）；随后 `gap-launch-profiles-teardown-entity`（status=done）执行 GOAL-001 的拆除。两者叠加产生了本轮的缺口，机制如下：

1. **判据指向的路径被合法搬迁，但 AC 记录没跟着改。** `1d76cac6`（refactor(providers): relocate the shared launch-spec compile layer out of launch-profiles）把编译层与测试整体搬到 `server/modules/providers/`；`b34a662e`（拆除旧实体）删掉了 `server/modules/launch-profiles/` 整个目录。AC-024 记录的 `criterion` 仍逐字写着 `server/modules/launch-profiles/tests/model-launch-spec.test.ts` 与 `server/modules/launch-profiles/tests/model-spawn-env.test.ts`。本轮实测 `quay goal gate AC-024` → verdict `fail`，reason 逐字为 `Could not find 'server/modules/launch-profiles/tests/model-launch-spec.test.ts, server/modules/launch-profiles/tests/model-spawn-env.test.ts'`。判据红**不是保证退化**：把同一条命令换成搬迁后的路径，退出 0、`tests 8 / pass 8 / fail 0`（约 1.2s）。这是"判据指向死路径"，不是"被断言的性质失效"。

2. **搬迁丢掉了一半覆盖，而且被登记成了"已覆盖"。** 拆除任务的登记表把 `env-injection-closed.test.ts`（AC-004）登记为 `model-spawn-env.test.ts`（AC-024）等价 —— 实测不成立。被删的那个文件里有 `compilePathLeaks()`：绕过 service 直接把 `PATH / NODE_OPTIONS / NODE_PATH / LD_PRELOAD / LD_LIBRARY_PATH / BASH_ENV / ENV / SHELL / IFS / PYTHONPATH / CLAUDE_CLI_PATH / CLAUDE_CONFIG_DIR` 写成 env 行落库，断言编译后 `key in spec.env` 为空；另有 negative control：把缝隙换成 `{ isAllowedKey: () => true }` 时同一断言必须判红。搬迁后的 5 个测试（value / secret / envref / unset / 内置 passthrough 逐字一致）**没有一条**覆盖这条编译期白名单复验。而这正是 AC-024 的 expect 里点名的那句「编译路径对每一行重新校验白名单：绕过写入路径直写库的越权键（LD_PRELOAD 等）也不得进入最终 spawn 环境，并产出 warning——这是纵深防御，写入路径校验（AC-023）不能替代它（接过 AC-004 的编译路径半边）」。

3. **于是编译期守卫的缝隙成了死代码 + 假注释。** `server/modules/providers/index.ts:19` 写着 "LaunchSpecGuards: the compile-path key-filter seam, consumed by the model compile tests."，而全仓 grep 该类型只有四处：类型定义（`server/modules/providers/services/model-launch-spec.service.ts:9`）、默认值（`:11`）、默认参数（`:26`）、这条 barrel 导出（`index.ts:20`）—— **零消费者**。

### 本轮实测读数

- 判据命令按原文（`npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/model-launch-spec.test.ts server/modules/launch-profiles/tests/model-spawn-env.test.ts`）→ 退出 1（Could not find）。
- 同一命令换到搬迁后路径 → 退出 0，`tests 8 / pass 8 / fail 0`。
- 编译期守卫行为探针（12 个 denied key 经 `providerModelsDb.createCustomProviderModel('claude', {...})` 直写库，绕过 `provider-models.service.ts:129` 的写入校验）：`spec.env` 泄漏 = `[]`；`spec.warnings` = 12 条（逐键点名 "not allowed in a model config and was dropped"）；SDK 最终 env 里 `LD_PRELOAD` 不存在，宿主自带的 `PATH` / `SHELL` 保持宿主继承值。⇒ **守卫实现是好的；缺的是覆盖与判据指向，不是实现。**

### 方案（最小切片）

1. **把 AC-024 记录的 `criterion` 指回活着的那份测试。** 命令形态（在 worktree 内执行，`<QT>` = 本仓库根）：

   `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal write AC-024 --criterion "npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-launch-spec.test.ts server/modules/providers/tests/model-spawn-env.test.ts" --origin "ADR-002；criterion 路径随 gap-launch-profiles-teardown-entity 的搬迁修正：launch-profiles 目录已按 GOAL-001 拆除，测试现居 providers" --root /data/home/yale/work/claudecodeui`

   先加 `--dry-run` 观测一次（已验证 dry-run 不落盘：`git status` 不变），确认后再正式写。

   ⚠️ 这不是"改判据让它变绿"：旧目录是 GOAL-001 拆除清单点名的删除对象，重建它会让本仓库的 AC-003（仓库级 grep 无 launch-profiles 引用）与拆除目标正面冲突；搬迁后的两个文件**就是同一份测试**，断言对象一个不减。本次修正的原因（路径搬迁）必须写进 AC 记录（`--origin`）并保留可追溯性。写完复读 `quay goal show AC-024` 确认：`criterion` 逐字正确、**不含** `server/modules/launch-profiles/`、`status` 仍为 `achieved`、`supersedes` 仍含 `AC-017`。若写出的文件落在 worktree 之外的主检出（历史上出现过这种错位），按仓库惯例把该 commit cherry-pick 到任务分支，别把验收面留在分支外。

2. **把丢掉的那半边覆盖补回来**，落在判据命令覆盖到的两个文件里：

   - `server/modules/providers/tests/model-launch-spec.test.ts`：直写库的 denied 行不得进入 `spec.env`；每个被丢弃的键各产出一条点名该键的 warning；白名单内的行照常生效（正对照，防止"全丢式"假绿）。
   - `server/modules/providers/tests/model-spawn-env.test.ts`：同一 fixture 下在【最终环境对象】上断言 —— SDK 路径 `mapCliOptionsToSDK({ model }).env` 与 pty 路径 `spawnPty` 收到的 `opts.env` 里：(a) denied 行的**行内值**（如 `/evil`）不得出现；(b) 宿主环境本身没导出的 denied 键（`LD_PRELOAD`、`NODE_OPTIONS`、`NODE_PATH`、`LD_LIBRARY_PATH`、`BASH_ENV`、`PYTHONPATH`、`CLAUDE_CLI_PATH`、`CLAUDE_CONFIG_DIR`）必须**整键缺失**；(c) 宿主已导出的键（`PATH`、`SHELL`）必须是**宿主继承值**而不是行内值 —— 这正是 AC-001 passthrough 基线的语义；把 (c) 也写成"整键缺失"是**错的断言，会稳定判红**。这条边界必须写进测试注释，否则下一个读者会把继承值误当泄漏。（本轮探针实测：SDK 最终 env 里 `PATH`/`SHELL` 存在且是宿主值，其余 denied 键不存在。）
   - 取假对照：经 `LaunchSpecGuards` 缝隙注入 `{ isAllowedKey: () => true }` 时，上面同一组断言必须判红。这一条同时让 `index.ts:19` 的注释重新为真、缝隙不再是死代码 —— **无需改 `index.ts`**，注释会自动成立。

3. **回归**：`passthrough-parity.test.ts`（AC-001 黄金基准）与 `model-config-write-path.test.ts`（AC-023 写入路径）必须仍绿。本任务只加覆盖、只改 AC 记录，**不改** `launch-spec.service.ts` / `model-launch-spec.service.ts` / `provider-models.service.ts` 的任何行为。

**边界（不做）**：不改白名单集合本身；不改编译语义；不改写入路径校验（AC-023 的对象）；不重建 `server/modules/launch-profiles/`。

## 落地证据

### 判据修正（AC 记录）

修正前 `quay goal gate AC-024 --root /data/home/yale/work/claudecodeui` 退出 1，reason 逐字为 `Could not find 'server/modules/launch-profiles/tests/model-launch-spec.test.ts, server/modules/launch-profiles/tests/model-spawn-env.test.ts'`。`quay goal write`（先 `--dry-run` 确认不落盘）按 Plan 的命令形态重写 `criterion`；修正后同一条 gate 命令退出 0、verdict `pass`、reason `acceptance passed (exit 0)`。`--origin` 保留了原 `origin` 的存量信息（ADR-002、`docs/proposals/launch-profiles.md` 待随之修订）并追加本次修正原因，可追溯。写入落在主检出（`67757285`、`10a8ce99`），按仓库惯例 cherry-pick 进本任务分支（`7bbf86f4`、`6ac72b64`），验收面不留分支外。读完复查：`criterion` 含两个 providers 路径、全文不含 `server/modules/launch-profiles/`、`status: achieved`、`supersedes: [AC-017]` 均在。

### 承重性：lax 变体下判红（逐条用例名）

把 `server/modules/providers/services/model-launch-spec.service.ts` 的 `DEFAULT_GUARDS` 临时改成 `{ isAllowedKey: () => true }`（仅此一处，其余不动），对判据命令覆盖的两个文件 → 退出 1，`pass 9 / fail 3`，失败用例名逐条为：

- `value/secret/envref/unset rows compile with the documented semantics` —— `AssertionError: denied key never compiled`（既有用例：`PATH` 行不再被丢）
- `rows written around the write path are re-filtered on every compile: denied keys never compile, each named by a warning` —— `AssertionError: real: denied row PATH must not compile into spec.env`
- `denied rows written straight to the library never reach either final env, and the compile names every one of them` —— `AssertionError: compile: denied row PATH must not compile`

两个文件各有一处判红，且本轮新增的断言本身就在判红名单里（不是"只有旧用例兜底"）。还原 `DEFAULT_GUARDS` 后同一命令退出 0、`tests 12 / pass 12 / fail 0`，`git diff` 对该 service 文件为空。

留在仓库里的永久承重证明是两个 `fake variant` 负对照：它们在把 `LaunchSpecGuards` 注入 `{ isAllowedKey: () => true }` 后用 `assert.throws` 要求同一组断言判红，因此将来即使生产默认值被改宽，这两个用例仍会红而不是假绿；`index.ts:19` 的注释也因这两个真实消费者重新为真。

### 其余读数

- 判据命令（搬迁后路径）：`tests 12 / pass 12 / fail 0`（本轮新增 4 条：每文件 1 条覆盖 + 1 条负对照）。
- 回归：`passthrough-parity.test.ts` 与 `model-config-write-path.test.ts` → 退出 0、`tests 9 / pass 9 / fail 0`。
- `grep -rn "LaunchSpecGuards" server/ --include=*.ts` 现在含真实测试消费者（两个测试文件各 import 该类型并各有一处 `LAX_GUARD`）。
- pty 路径的 `PATH` 会被 `prioritizeUserNpmGlobalBin` 按宿主自身条目重排，因此最终 env 的断言写的是"没有任何非宿主条目"，而不是"与 `process.env.PATH` 逐字相等"——这条边界连同"宿主已导出的 denied 键必须保留继承值、不能断言整键缺失"一起写进了测试注释。

## AC

- [x] `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal gate AC-024 --root /data/home/yale/work/claudecodeui` 退出 0（AC-024 的判据在真实 gate 里转绿）。
- [x] 该 root 下 `goals/AC-024-a-model-entry-compiles-to-the-real-spawn-env-including-unset.md` 的 `criterion` 逐字包含 `server/modules/providers/tests/model-launch-spec.test.ts` 与 `server/modules/providers/tests/model-spawn-env.test.ts`，且全文不含 `server/modules/launch-profiles/`；`status` 仍为 `achieved`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-launch-spec.test.ts server/modules/providers/tests/model-spawn-env.test.ts` 退出码 0。
- [x] 新增断言真实存在且承重：把 `LaunchSpecGuards` 注入 `{ isAllowedKey: () => true }` 的变体下，上述两个文件里对应断言判红（失败用例名逐条记录进任务证据），还原后全绿。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts server/modules/providers/tests/model-config-write-path.test.ts` 退出码 0（AC-001 黄金基准与 AC-023 写入路径未被带动）。
- [x] `grep -rn "LaunchSpecGuards" server/ --include=*.ts` 的输出里出现真实测试消费者（`server/modules/providers/tests/` 下的测试文件 import 它），不再只有类型定义与 barrel 导出。
- [x] `npm run typecheck`、`npm run lint` 退出码 0；`bash scripts/test.sh --for-task gap-ac-024-criterion-repoint-and-compile-allowlist-coverage --allow-thin` 退出码 0（scoped 自测；全量套件是 fan-in 的合并闸，不是 worker 的自测）。

## DoD

真实落地判据：不是"把判据路径改绿了"就算完成。要求 (a) AC-024 记录里的判据指向**活着的**那份测试，并且"为何修正"（本次搬迁丢了路径）写进记录、可追溯；(b) 一条绕过写入路径直写库的越权键（`LD_PRELOAD` 等）在**最终 spawn 环境**（SDK 的 `sdkOptions.env` 与 pty 的 `opts.env` 两个对象）上被证明进不去、且编译期产出点名该键的 warning —— 这是 AC-004 编译路径半边的真实防线，不是 spec 里一个标记；(c) 该防线的**承重性**由 lax guard 负对照证明，而不是自说自话，且 `LaunchSpecGuards` 缝隙从此有真实消费者；(d) AC-001 黄金基准与 AC-023 写入路径未被本次改动带动。

L_D 该轴仍暗，理由：本段补的是既有编译路径的覆盖与一条 AC 记录的判据指向，不新增领域能力。
L_G 该轴仍暗，理由：同上。

## Touches

- goals/AC-024-a-model-entry-compiles-to-the-real-spawn-env-including-unset.md
- server/modules/providers/tests/model-launch-spec.test.ts
- server/modules/providers/tests/model-spawn-env.test.ts
- tasks/gap-ac-024-criterion-repoint-and-compile-allowlist-coverage.md
