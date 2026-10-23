---
id: gap-worker-selfcheck-scoped
title: worker 自测改跑 scoped：任务 AC 从全量套件改为 --for-task &lt;自身 id&gt;，并在 test.sh 前置加机械守卫
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

**要解决的问题**：本项目并发套件的**乘法来自一条约定**，不是来自某个开关。`.quay/config.yml` 的 `loop:` 段没有任何并发键，派发并发来自插件的 `scripts/drivers.yml` 默认 `kinds.worker.cap: 5`；而**每一个任务 worker 的自测 AC 都写着 `bash scripts/test.sh`（全量）**。于是 `cap: 5` 的真实含义变成「最多 5 个全量套件同时抢一台机器」——**前者管派发，后者才是成本，而两者互不知情**。

**为什么这是错配**：全量套件本该是 **fan-in 的合并闸**（它在合并前对被测树跑一次），worker 自己只需要证明**它改的那部分**没坏。quay 的 `integration-batch-merge.sh:948` 逐字建议 worker 这么做：

> 先在自己 worktree 自测绿：`node --test <文件>` 或 **scoped test.sh（`bash scripts/test.sh --for-task <task-id> --allow-thin`）**，得到 `scope=worktree+state=green` 记录后再 fan-in

而 `runner-static-gate.ts:1157` 明说 scoped 路径**刻意跳过**全量静态闸——它就是为「便宜」设计的。

**机制已经现成**：`scripts/test.sh:29-39` 已实现 `--for-task <id>`（从该任务 `## Touches` 里抽 `*.test.*` 文件）；本项目**已有 7 条任务在用**。

**⚠️ 关键约束（本任务的第一条设计约束，别踩）**：`--for-task` **只抽 `*.test.*`**。若一个任务的 Touches 里**没有**测试文件（例如交付物是 `scripts/*.sh` 检查器），`--for-task` 会抽到 0 个文件、走 `scripts/test.sh:36-38` 打印 `no scoped test files for <id> (thin)` 并 **exit 0** —— **那是一个取不了假的绿，比全量更糟**（quay 的 init 契约文档对同形有逐字告警：「a green that cannot go red is not a measurement」）。所以守卫**不得**无条件要求改成 `--for-task`。

要做的事：
1. 新增 `scripts/suite-scope-check.sh`，规则**两条并列**：
   - (a) 对每一个非 `done`/`superseded` 的任务：若它的 `## AC` 里出现**全量** `bash scripts/test.sh`（未带 `--for-task`），**且它的 `## Touches` 含 `*.test.*` 文件**（scoped 在该任务上语义成立），判违规并列出任务 id——改法是改用 `--for-task <自身 id>`；
   - (b) 对**不**含测试文件的任务：`--for-task` 豁免（避免假绿），但其 AC **不得**以全量套件充当自测——改为直接跑它自己交付的检查器（`scripts/*.sh`）。
   - 两类都要**把任务 id 写进判词**（本仓库 AC 硬校验：criterion 的失败退出必须同行输出原因），不得用裸 `grep -q` 链。`done`/`superseded` 的历史任务**原样保留**（不改历史账）。
2. 在 `scripts/test.sh` 的**前置**加一次该守卫（对照 quay 的 `check_group_declarations` 前置位置，`scripts/test.sh:1035`），使「没人主动跑」不可能发生。⛔ 不得破坏既有的 flag 消费契约（`--buckets|--root|--state-dir|--runner|--log-file|--run-id) shift 2`）与 `__PERFILE__` 输出格式。
3. **必须把当前非 done 的违规任务改到位**——否则守卫生来即红、AC1 不可能满足。范围仅限于此：`done`/`superseded` 的历史一律不动，不扩散到无关任务。当前已知的活跃违规者只有 3 条，且都是本轮新立/新改的（其中一条含测试文件、属 (a) 类；两条交付物是 `scripts/*.sh`、属 (b) 类）。

## AC

- [x] `bash scripts/suite-scope-check.sh` 退出码 0：非 `done`/`superseded` 任务中，凡 Touches 含 `*.test.*` 者其 AC 的自测命令均带 `--for-task <自身 id>`（不出现缺省 `--for-task` 的全量 `scripts/test.sh` 调用）；不含测试文件者不以全量套件充当自测。
- [x] 取假（确定性，**两个方向都要**）：①临时把一个**含测试文件**的活跃任务 AC 改回全量 → 守卫非零退出并打印其 id；②临时让一个**不含测试文件**的任务 AC 改回全量 → 同样被列出。两次改回后均转绿。
- [x] ⛔ 守卫**不得**把「不含测试文件的任务」判成「应该改用 `--for-task`」——必须区分「scoped 语义成立」与「scoped 会掏空成假绿」两种情况（用一个不含测试文件的样本断言它给出 (b) 类判词而非 (a) 类）。
- [x] `bash scripts/suite-scope-check.sh` 退出码 0；该守卫已在 `scripts/test.sh` 前置被调用（守卫自带接线判据：删掉该调用行即非零退出）；既有 `__PERFILE__` 行格式未变（`--for-task gap-model-env-kind-explanations` 的 scoped 实跑退出 0，且其 `__PERFILE__` 行仍匹配 quay 锚定正则、真正执行了 ≥1 个测试文件）。

## DoD

真实落地判据：不是「守卫脚本存在」。要求：①守卫被 `scripts/test.sh` 前置调用（改动后的 test.sh 实跑一次、退出 0）；②**真的把一个含测试文件的活跃任务改成 scoped 并跑通**（`bash scripts/test.sh --for-task <id>` 实跑退出 0，且**不是 thin 空跑**——输出须显示它确实执行了至少一个测试文件）；③两个取假方向各有一次实跑输出。三段输出记入完成记录。⛔ 仅新增守卫脚本、或交付一个只会四处 `--for-task` 的实现，不算完成。

- 该轴仍暗，理由：本任务的判据是 worker 自测的**作用域**（`--for-task` 是否真的执行到测试文件、两个取假方向各一次实跑），产出的是作用域读数，不产生 L_D（描述长度）或 L_G（生成对齐）读数；本仓从未跑过 archguard 暗轴探针。ADR-007 per-milestone 谓词在本仓尚未生效（全部 43 条任务均 MISSING），此处按 ADR 原文认可的显式声明形式登记该轴仍暗。

## Touches

- scripts/test.sh
- scripts/suite-scope-check.sh
- tasks/gap-worker-selfcheck-scoped.md

## 完成记录

**交付物**：`scripts/suite-scope-check.sh`（新增）+ `scripts/test.sh` 里的一处前置调用（插在 arg 解析 `while` 循环之后、`FILE_TIMEOUT` 块之前，现为第 48 行）。`scripts/test.sh` 其余部分一字未动（flag 消费契约与 `__PERFILE__` 格式原样）。

### ① 守卫被 `scripts/test.sh` 前置调用 —— 改后的 test.sh 全量实跑，rc=0

```
suite-scope-check: scan tasks=52 skipped(done/superseded)=48 active=4 with-tests=2 no-tests=2 tasks_dir=<worktree>/tasks
suite-scope-check: PASS — 4 active task(s) scanned: every active task whose ## Touches lists *.test.* carries --for-task in its ## AC self-test, and no active task without *.test.* touches uses the full suite as its self-test; this guard is wired into <worktree>/scripts/test.sh's prelude (line 48 < stage line 178)
__PERFILE__ duration_ms=10339 typecheck passed=true end_ms=1789920099572
__PERFILE__ duration_ms=7883 lint passed=true end_ms=1789920107457
…
# tests 176
# pass 176
# fail 0
# cancelled 0
```

- 退出码 0（`FULL_RC=0`）。
- `grep -c '^__PERFILE__'` = 176，其中按 quay 的**锚定正则**复核为 **176/176 匹配**（`^__PERFILE__ duration_ms=([0-9.]+) (\S+) passed=(true|false)( end_ms=([0-9]+))?$`，不匹配行 0 条）——既有行格式未被破坏。
- 全量实跑里 `server/shared/tests/quay-test-script.test.ts passed=true`（该文件本身就 spawn `scripts/test.sh`）——新增前置不破坏它的断言。
- 判词尾部的 `line 48 < stage line 178` 就是接线自证的读数：守卫在**任何** stage / 文件收集之前。

### ② 真的把一个含测试文件的活跃任务改成 scoped 并跑通 —— 非 thin

`bash scripts/test.sh --for-task gap-model-env-kind-explanations`（rc=0，wall **3.440s**；对照同一棵树的 176 项全量实跑 ≈57s）：

```
suite-scope-check: PASS — 4 active task(s) scanned: …
__PERFILE__ duration_ms=554 src/modules/settings/tests/modelLibrarySettings.test.tsx passed=true end_ms=1789920167126

# tests 1
# pass 1
# fail 0
# cancelled 0
```

「不是 thin 空跑」的三条证据：① 输出里**没有** `no scoped test files for … (thin)`；② **有** `__PERFILE__` 行（thin 分支在 `exit 0` 前不产出任何 `__PERFILE__`）；③ `# tests 1`，且该行指名一个真实测试文件。该任务原 AC 写的是全量 `bash scripts/test.sh`，本轮已按 (a) 类改为 `--for-task gap-model-env-kind-explanations`。

### ③ 两个取假方向各有一次实跑输出（确定性；用夹具目录 + `--tasks-dir`，不改真账）

取假①（(a) 类：**含**测试文件的任务 AC 改回全量）→ 非零退出、判词**点名 id**：

```
suite-scope-check: scan tasks=52 skipped(done/superseded)=48 active=4 with-tests=2 no-tests=2 tasks_dir=/tmp/scopecheck/fx-a/tasks
suite-scope-check: VIOLATION(a) task=gap-model-env-kind-explanations — its ## AC self-tests with the FULL suite (span: `bash scripts/test.sh`) while ## Touches lists 1 *.test.* file(s) (first: src/modules/settings/tests/modelLibrarySettings.test.tsx), so a scoped self-test IS well-defined here: change it to `bash scripts/test.sh --for-task gap-model-env-kind-explanations` — the full suite is fan-in's merge gate, not a worker's self-test
suite-scope-check: FAIL — 1 violation(s) (gap-model-env-kind-explanations(a)); the full suite belongs to fan-in's merge gate — a worker only has to prove the part it changed
rc=1
```

取假②（(b) 类：**不含**测试文件的任务 AC 改回全量）→ 同样非零退出，且**判词形态与①可区分**（这正是 AC3 要的）：

```
suite-scope-check: scan tasks=52 skipped(done/superseded)=48 active=4 with-tests=2 no-tests=2 tasks_dir=/tmp/scopecheck/fx-b/tasks
suite-scope-check: VIOLATION(b) task=gap-worker-selfcheck-scoped — its ## AC self-tests with the FULL suite (span: `bash scripts/test.sh`) while ## Touches lists NO *.test.* file, so `--for-task gap-worker-selfcheck-scoped` would resolve to 0 files and take scripts/test.sh's thin path ("no scoped test files for gap-worker-selfcheck-scoped (thin)", exit 0) — a green that cannot go red is not a measurement; self-test by running this task's own delivered checker (scripts/*.sh) instead
suite-scope-check: FAIL — 1 violation(s) (gap-worker-selfcheck-scoped(b)); the full suite belongs to fan-in's merge gate — a worker only has to prove the part it changed
rc=1
```

取假③（**接线**也取得到假：「没人主动跑」必须可判）：

```
suite-scope-check: VIOLATION(wiring) — /tmp/scopecheck/test-stripped.sh never calls scripts/suite-scope-check.sh on a non-comment line: the guard is dead code, and "nobody runs it" is exactly the failure it exists to prevent
suite-scope-check: FAIL — 1 violation(s); the full suite belongs to fan-in's merge gate — a worker only has to prove the part it changed
rc=1
```

（`test-stripped.sh` = `scripts/test.sh` 删掉那行调用后的副本，用 `--test-sh <副本>` 指过去。）

**两次取假各自的回绿对照**：把该夹具恢复为现行文本后，同一夹具目录实跑 `rc=0`、判词为 `suite-scope-check: PASS — 4 active task(s) scanned: …`。即两个方向都是**可逆的**——红是判据造成的，不是环境造成的。（`/tmp/scopecheck/fx-a`、`fx-b`、`fx-green` 三个夹具目录同源，只有被测任务的一行文本不同。）

### 检测规则（刻意窄且可复核，已写进守卫头注释）

只认 `## AC` 段里**以命令词开头**（`bash` / `sh` / `node` / `npx` / `./`）且其命令路径为 `scripts/test.sh` 的**行内代码 span**，且该 span **不带** `--for-task`。裸路径提及（span 本身以路径开头，例如某个 AC 在复述本规则时引用文件名）**不是命令**，不参与判定。`done` / `superseded` 的历史任务原样保留（不改历史账；扫描读数 `skipped(done/superseded)=48`）。守卫自身成本实测 **0.16–0.33s**。

### 范围（仅 3 条活跃任务的 AC 文本，且都是本轮新立/新改的）

- `gap-model-env-kind-explanations`（(a) 类，Touches 含 1 个测试文件）→ 全量改为 `--for-task`（develop `f4b9aa93`，1 行）。
- `gap-suite-hang-watchdog`（(b) 类，交付物是 `scripts/*.sh` 检查器）→ AC3 改以 `bash scripts/suite-hang-watchdog-check.sh` 领头，而把 `__PERFILE__` 格式与 `--test-concurrency=4` 两条断言改成指向其完成记录第 5 项的实测指针，不再以全量套件充当自测（develop `b1eb178b`，1 行）。
- 本任务自身（(b) 类）→ AC1 去掉命令形态的全量 span、AC4 改为交付物自测（develop `dfadb829`，2 行）。

三条**均经 Provider ABI（`bash bin/quay task edit --body-file`）写入**，未手改 `tasks/*.md`。

### 诚实备注

本任务自身 Touches 不含 `*.test.*`，属 (b) 类，故 `bash scripts/test.sh --for-task gap-worker-selfcheck-scoped --allow-thin` 走 thin 路径（打印 `no scoped test files for gap-worker-selfcheck-scoped (thin)`，exit 0）。**那不是本任务的证据**——一个取不了假的绿不算测量。本任务的证据是上面 ①②③ 四段实跑输出。

### ⑩ 收尾：ADR-007 声明行从 `## Touches` 移进 `## DoD`（anti-drift）

上一轮 exited-not-landed 的**唯一**原因是 anti-drift HARD FAIL 1 条 `overbroad-declaration`，它与守卫实现本身无关 —— 是**任务体格式**问题：本轮之前，ADR-007 的显式声明行（`- 该轴仍暗，理由：…`）写在 `## Touches` 段内。anti-drift 的 `parseTouchEntries` 把该段里**每一行 `- …` 都当成声明的写面**，而这一行没有 `/`、又含 Markdown 粗体 `**作用域**`，于是 `isOverbroadDeclaration` 在第一个段（`concrete = 0 < 2`）上撞见 `*` ⇒ 整行被判成「过宽的写面声明」。判词逐字：

```
ANTI-DRIFT HARD FAIL: task gap-worker-selfcheck-scoped — 1 violation(s)
  overbroad-declaration: task declares "该轴仍暗，理由：…" (too broad to validate stray writes against)
```

声明行本身**不能删**：`dark-axis-record-check` 认它，删掉状态会从 `DISCLAIMED` 退回 `MISSING`。修法是把该行**移进 `## DoD`**（`classifyDarkAxisRecord` 扫全文、不限段），`## Touches` 只留真正的写面条目 —— 一个 Touches 条目都没改，也没有任何判据/代码改动：本轮对任务体的 diff **只有这一行的位置变化**（`git diff` 为 2 增 1 删）。这与本仓此前 `gap-resetmodules-cold-compile-timeout` 的收尾是**同一次失败的第二次出现**，修法逐字相同。

改后读数（本工作树，develop 已并入）：

```
ANTI-DRIFT OK: task gap-worker-selfcheck-scoped — 2 actual file(s), all within declared Touches (3 glob(s))
dark-axis-record-check: gap-worker-selfcheck-scoped  state: DISCLAIMED (declared: line 34)
```

### ⑪ 第二轮复核：develop 并入后的四条 AC 全部重跑

develop 在此期间并入 **14 个提交**（`scripts/test.sh` 被别处改动 +302 行），故四条 AC 在**合并后的树**上逐条重跑，读数如下（守卫代码与接线位置未变）：

**AC1 / AC4 前半**：`bash scripts/suite-scope-check.sh` rc=0（`active=2 with-tests=1 no-tests=1`；原先的 `active=4` 是 develop 并入前两条任务尚未翻 done 时的读数，非判据变化）：

```
suite-scope-check: scan tasks=52 skipped(done/superseded)=50 active=2 with-tests=1 no-tests=1 tasks_dir=<worktree>/tasks
suite-scope-check: PASS — 2 active task(s) scanned: every active task whose ## Touches lists *.test.* carries --for-task in its ## AC self-test, and no active task without *.test.* touches uses the full suite as its self-test; this guard is wired into <worktree>/scripts/test.sh's prelude (line 53 < stage line 432)
rc=0
```

**AC2 / AC3**（取假两方向 + 接线方向，夹具目录与上轮同构，只有被测任务的一行文本/一行调用不同；每组后附回绿对照）：三组全部 rc=1 且判词形态可区分 —— (a) 点名 `gap-model-env-kind-explanations` 并给出「改成 `--for-task <自身 id>`」，(b) 点名本任务并给出「改跑自己交付的 `scripts/*.sh` 检查器」（**不是** (a) 类判词，这正是 AC3 的判据），(wiring) 判 `test-stripped.sh` 从不调用守卫。回绿对照 `fx-green` rc=0、判词为 `PASS`。

**AC4 后半**：`bash scripts/test.sh --for-task gap-model-env-kind-explanations` rc=0（wall 4.22s），**非 thin** ——

```
__PERFILE__ duration_ms=376 src/modules/settings/tests/modelLibrarySettings.test.tsx passed=true end_ms=1789921061172

# tests 1
# pass 1
# fail 0
```

`__PERFILE__` 行按 quay 锚定正则 `^__PERFILE__ duration_ms=([0-9.]+) (\S+) passed=(true|false)( end_ms=([0-9]+))?$` 机械复核：**1/1 匹配**，非匹配 0 条；输出无 `no scoped test files for … (thin)`，故既有行格式未变且真的执行了 ≥1 个测试文件。

**驱动侧 scoped 门**：`bash scripts/test.sh --for-task gap-worker-selfcheck-scoped --allow-thin` rc=0（本任务 Touches 无 `*.test.*`，走 thin 分支 —— 照旧**不构成证据**，只是驱动门本身）。

**DoD ① 的全量实跑**（合并后的 `scripts/test.sh`，含新增前置）：

```
suite-scope-check: PASS — 2 active task(s) scanned: …
__PERFILE__ duration_ms=10386 typecheck passed=true end_ms=1789921079613
__PERFILE__ duration_ms=7259 lint passed=true end_ms=1789921086876
…
FULL_RC=0  wall=55.98s
```

`FULL_RC=0`，`grep -c '^__PERFILE__'` = 176，按锚定正则复核 176/176 匹配。
