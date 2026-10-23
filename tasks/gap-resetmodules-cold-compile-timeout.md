---
id: gap-resetmodules-cold-compile-timeout
title: vi.resetModules()+用例内动态 import 让整张模块图的冷编译挤进 vitest 默认 5s
  用例预算：并发下被拖红，AC-103 约 7 次红 1 次
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

**现象**：AC-103 的判据（`scripts/suite-concurrency-check.sh`）在 15 次实测里红 1–2 次，红的是它自己的条件①「2 份套件退出码均为 0」。红**不是**签名崩溃（每次红时 `STACK_TRACE_ERROR=0`、`Timeout calling "fetch"=0`，比值读数也远低于 K=4），而是一条**真实的负载敏感**：

```
FAIL src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts
  × a refresh that renames the selected project updates the selected copy          5005ms → Test timed out in 5000ms.
  × a refresh that changes nothing workspace-visible keeps the selected object identity  5008ms → Test timed out in 5000ms.
Test Files  1 failed | 72 passed (73)
```

同一文件在**安静机上**的逐用例读数（`npx vitest run <file> --reporter=verbose`）：

```
✓ a refresh that renames the selected project updates the selected copy   3637ms
✓ 其余 5 个用例                                                            80–150ms
Test Files 1 passed (1) | Tests 6 passed (6) | Duration 4.76s
```

**机制**（两个因素相乘，缺一不成）：

1. `src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts:83` 的 `afterEach(() => { vi.resetModules(); })` 让模块注册表**每个用例失效**，而 `:58` 的 `renderProjectsState()` 在**用例体内**用 `await import('@/modules/project-workspace/hooks/useProjectsState')` 重新求值整张 hook 依赖图（React + testing-library + 该 hook 的全部依赖）。于是**第一个用例**付掉整张图的**冷编译**代价 = 3637ms；此后各用例只付热求值 ≈150ms。这正是「同一文件里第一个用例 3637ms、其余 150ms」的唯一解释。
2. `vitest.config.ts` **没有声明 `testTimeout`** ⇒ 吃 vitest 默认 **5000ms**。3637 / 5000 ⇒ 余量只剩 **27%**。任何 CPU 争抢（另一个套件、另一个 worker、别的重活）都足以把这次冷编译推过线。并发实测里连安静时只要 150ms 的用例也被拖到 5008ms（整个 vitest worker 被饿死），说明红的不止那一条慢用例。

**这不是孤例，是一族**：`vi.resetModules()` + 用例内动态 import 的组合出现在 **11 个测试文件**（`grep -rl resetModules src/ --include='*.test.ts*'` 共 13 个，其中 2 个无动态 import 故不计入本机制）。其中 `src/shared/tests/busySessionIds.test.tsx:43` 正是 AC-103 origin 记录里**另一个被点名**的并发失败文件 —— 两个失败文件同一机制，而 AC-103 的判据只看到「套件 rc≠0」，看不到背后是「一族文件各自在 5s 预算内付冷编译」这一件事。

**⇒ 待办**：把「冷编译挤在某个用例的 5s 预算里」从源头去掉，而不是放宽判据。按下列顺序做（实现者按实测选路，但**不得跳过第 1 步**）：

1. **先做确定性读出（本任务主要产出）**。负载敏感不可复现就无法验收：既有判据只有在负载下才红，且只红 1/7，改完也无法证明改对了。正确形态是**余量**而非红绿 —— 对族内每个文件单独跑，解析最慢用例耗时 `T_max`，与该文件适用的 `testTimeout` 预算 `B` 相比，要求 `T_max ≤ B / K`。该读数是**确定性**的（不依赖机器负载）、且**可红**（当前树上 `3637 / 5000 = 0.73 > 1/K`）。
2. **把冷编译移出用例预算**：族内文件在 `beforeAll` 里预热一次模块图，使冷编译不再计入任何**用例**的 `testTimeout`（`hookTimeout` 是独立预算）。这是首选路径。
3. **只有第 2 步做不到时才动 `testTimeout`**：显式写进 `vitest.config.ts`（不再依赖隐式默认），且必须附实测余量。**单纯抬 `testTimeout` 会削弱套件的挂死探测**（AC-105 正为此而设），故不是首选；若确实要抬，DoD 必须给出「抬后仍能在预算内探到挂死」的读数。

**非目标**：不改任何业务断言；不删 `vi.resetModules()`（它是为用例间模块状态隔离而设，删掉会改测试语义）；不放宽 AC-103 的任一条件（本任务是把条件①变绿，不是在判据上让步）；不引入跨项目重操作令牌。

## AC

- [x] AC1：`bash scripts/test-timeout-margin-check.sh` 存在，且在**当前树上以非零退出**，并在**同一行**打印族内最差文件的 `T_max`、预算 `B`、比值与阈值 `1/K`（红先行：先观测到红，再动手修）。
- [x] AC2：修复后 `bash scripts/test-timeout-margin-check.sh` 退出 0，且读数里族内**每一个**文件的 `T_max ≤ B / K`。
- [x] AC3：`vitest.config.ts` 显式声明 `testTimeout`（`grep -E 'testTimeout' vitest.config.ts` 命中 ≥1 行），且判据脚本把从该显式值读到的 `B` 打进自己的判词（不再隐式假定 5000ms）。
- [x] AC4：`bash scripts/suite-concurrency-check.sh` 连续 5 次退出 0（`for i in $(seq 5); do bash scripts/suite-concurrency-check.sh || echo "run $i red"; done`）。⚠️ 这条只是**旁证**：修复前它本就是 13/15 绿，5 连绿不构成证明；真正的判据是 AC2 的确定性余量读数。

## DoD

真实落地，不是「脚本存在」：

- 族内 11 个文件在安静机上逐个跑出的 `T_max` 表（文件名 / 最慢用例 / 耗时 / 预算 / 比值）作为完成记录写进本任务 —— 这是「余量」这条判据与 K 取值的原始数据。K 的默认值只是首版待钉值，须由该分布数据支撑（本仓既有纪律：分布数据出来之前不设阈值）。
- 至少一次**真实并发**实测：修复后的树上跑完 `scripts/suite-concurrency-check.sh`，其 `concurrent-suite-*.out` 里 `projectsStateSelectionSync.test.ts` 的逐用例耗时**不再出现 5000ms 上限截断**（不再是 `5005ms → Test timed out`），该文件 6/6 通过。
- AC1 的红先行证据保留：修复前的非零退出与读数字样粘贴在本任务下。
- 若最终走第 3 条路径（抬 `testTimeout`），必须另附「故意挂死的用例仍能在预算内被探到」的读数 —— 否则等于用放宽超时掩盖了挂死探测。
- 该轴仍暗，理由：本任务的判据是用例**耗时余量**（T_max 与 testTimeout 预算之比），产出的是时间读数，不产生 L_D（描述长度）或 L_G（生成对齐）读数；本仓从未跑过 archguard 暗轴探针。ADR-007 per-milestone 谓词在本仓尚未生效（全部 43 条任务均 MISSING），此处按 ADR 原文认可的显式声明形式登记该轴仍暗。

## 完成记录

**走的路径：第 2 条（`beforeAll` 预热），不是第 3 条。** `testTimeout` 保持 vitest 默认值 5000ms 未抬 —— 预热之后不需要抬，所以本任务最后一条 DoD（「抬后仍能探到挂死」的读数）不适用。

### 1. 判据读数：改前红（红先行）→ 改后绿

改前（`B=5000ms`，来源是 vitest 默认值 —— config 当时确实没声明）：

```
test-timeout-margin-check: file=src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts T_max=2955ms(a refresh that renames the selected project updates the se) B=5000ms 比值=0.591 1/K=0.250 tests=6 file_ms=3583 status=OVER-BUDGET
test-timeout-margin-check: file=src/modules/project-workspace/tests/projectsStateSessionAlias.test.ts T_max=2832ms(an upsert carrying the provider id replaces the aliased ro) B=5000ms 比值=0.566 1/K=0.250 tests=3 file_ms=3119 status=OVER-BUDGET
test-timeout-margin-check: file=src/modules/project-workspace/tests/projectsInitialFetch.test.tsx T_max=2717ms(the mount fetch runs once even when StrictMode remounts th) B=5000ms 比值=0.543 1/K=0.250 tests=2 file_ms=2874 status=OVER-BUDGET
test-timeout-margin-check: FAIL — 族内 3/13 个文件余量不足或读数不可得（要求每个文件 T_max ≤ B/K）｜ worst=src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts T_max=2955ms B=5000ms(来源：vitest 默认值（vitest.config.ts 未声明 testTimeout）) 比值=0.591 阈值 1/K=0.250 (K=4) 最慢用例='a refresh that renames the selected project updates the se'
EXIT=1
```

改后：

```
test-timeout-margin-check: family=13 files ｜ B=5000ms（来源：vitest.config.ts 显式 testTimeout）｜ K=4 ⇒ 阈值 1/K=0.250 ｜ 串行逐个跑
test-timeout-margin-check: hookTimeout=20000ms（仅报告：预热那笔冷编译的预算，见下 file_ms；本判据只判用例余量）
test-timeout-margin-check: PASS — 族内 13 个文件全部 T_max ≤ B/K（最差比值 0.034），冷编译不在任何用例的 testTimeout 预算内 ｜ worst=src/modules/project-workspace/tests/projectsInitialFetch.test.tsx T_max=172ms B=5000ms(来源：vitest.config.ts 显式 testTimeout) 比值=0.034 阈值 1/K=0.250 (K=4) 最慢用例='an explicit refresh still reaches the server after the mou'
EXIT=0
```

### 2. `T_max` 表（逐文件单独跑，串行，B = 5000ms，本机）

`B` 一栏改前改后同值：改前它来自 vitest 默认 5000ms，改后来自 vitest.config.ts 的显式 5000ms。

| 文件 | 最慢用例 | 改前 T_max | 改后 T_max | 改前比值 | 改后比值 |
| --- | --- | --- | --- | --- | --- |
| project-workspace/tests/projectsStateSelectionSync.test.ts | a refresh that renames the selected project updates the se… | 2955ms | 137ms | 0.591 | 0.027 |
| project-workspace/tests/projectsStateSessionAlias.test.ts | an upsert carrying the provider id replaces the aliased ro… | 2832ms | 135ms | 0.566 | 0.027 |
| project-workspace/tests/projectsInitialFetch.test.tsx | the mount fetch runs once even when StrictMode remounts th… | 2717ms | 172ms | 0.543 | 0.034 |
| chat/tests/transcriptScrollOwnership.test.tsx | does not yank the view back down when the user scrolls up | 155ms | 158ms | 0.031 | 0.032 |
| shared/tests/userSettings.test.ts | a write is readable synchronously and reaches the server a… | 78ms | 78ms | 0.016 | 0.016 |
| settings/tests/settingsControllerCodeEditor.test.ts | opening settings writes no code-editor preference for a us… | 50ms | 53ms | 0.010 | 0.011 |
| chat/tests/sessionStoreTruncate.test.tsx | drops the anchored message and everything after it | 47ms | 46ms | 0.009 | 0.009 |
| shared/tests/authenticatedFetch.test.ts | a live token is sent as a bearer credential | 44ms | 47ms | 0.009 | 0.009 |
| chat/tests/tokenUsageFreshness.test.tsx | leaves the slot untouched when the provider reports none | 44ms | 42ms | 0.009 | 0.008 |
| chat/tests/markdownSyntaxThemeInjection.test.tsx | the dark block declares every custom property a rendered c… | 36ms | 37ms | 0.007 | 0.007 |
| chat/tests/chatProviderModels.test.ts | each provider gets its own model from its own storage key | 36ms | 42ms | 0.007 | 0.008 |
| shared/tests/busySessionIds.test.tsx | a status-text update changes the activity map but not the… | 27ms | 28ms | 0.005 | 0.006 |
| shared/tests/chatDrafts.test.ts | a draft is readable synchronously and reaches the server a… | 17ms | 13ms | 0.003 | 0.003 |

用例名超过 58 字符的在这里按判据脚本的截断长度显示（以 `…` 结尾），未截断的是全名。

### 3. K = 4 的依据（分布数据）

改前分布是**两个互不重叠的簇**：3 个付冷编译的文件 2717–2955ms（比值 0.543–0.591），其余 10 个 ≤ 155ms（比值 ≤ 0.031）。改后 3 个文件落到与其余文件同簇（135–172ms，比值 ≤ 0.034）。

`K=4 ⇒ 阈值 1250ms` 落在两簇之间的空档里：比上簇（2781ms 量级）低 45%，比下簇（改后最差 172ms）高 7.3 倍。判别力两头都够 —— 故障态要缩水到原值的 45% 以下才会漏判，正常态要膨胀 7 倍以上才会误判。取 4 也与姊妹判据 `scripts/suite-concurrency-check.sh` 的 `K_RATIO=4` 同值。

### 4. 改动（3 个文件 + config）

- `src/modules/project-workspace/tests/{projectsStateSelectionSync.test.ts, projectsInitialFetch.test.tsx, projectsStateSessionAlias.test.ts}`：各加一个 `beforeAll(async () => { await import('@/modules/project-workspace/hooks/useProjectsState'); })`。**没有任何用例断言被改动**，`vi.resetModules()` 保留（用例间隔离是它存在的理由）。
- `vitest.config.ts`：显式声明 `testTimeout: 5000`（默认值，未抬）与 `hookTimeout: 20000`。`hookTimeout` 是**实测**定的，不是拍的：预热那笔冷编译在安静时 2.8s，在 AC-103 那种并发形状下 file_ms 到 6037–7242ms（扣掉 ~700ms 用例），默认 10000ms 只剩 1.4× 余量 —— 与「在用例预算里 1.8× 余量就已经红过」同一量级，等于把脆弱性搬了个位置。20000 对最差读数仍有 ~2.8×。

机制被直接验证过一次（单文件受控 A/B，改前/改后各两次）：**进程墙钟几乎不变**（4.18–4.43s vs 4.65–6.48s，冷编译照付），变的只是记账位置 —— 该文件的**用例窗口** 3.7s → 0.65s，`T_max` 2964–4863ms → 131–165ms。

### 5. 真实并发实测（DoD 第 2 条）

5 次 `scripts/suite-concurrency-check.sh` 的 10 份 `concurrent-suite-*.out` 里，`projectsStateSelectionSync.test.ts` **每次都 6/6 通过**：

```
✓ src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts (6 tests) 4140ms / 4245ms
✓ … (6 tests) 4683ms / 4987ms
✓ … (6 tests) 6945ms / 7089ms
✓ … (6 tests) 7242ms / 7167ms
✓ … (6 tests) 5684ms / 6096ms
```

对这 10 份并发日志 `grep -rl "Test timed out in 5000ms"` ⇒ **NONE FOUND**，即不再有 5000ms 上限截断。另外单独一次并发实测（改后树上）同样是 6/6、无截断。这里 4140–7242ms 是**文件墙钟**（含预热那笔编译），不是用例耗时；用例预算的读数在 §2。

### 6. AC4：5 连绿

```
run 1: rc=0 GREEN      run 4: rc=0 GREEN
run 2: rc=0 GREEN      run 5: rc=0 GREEN
run 3: rc=0 GREEN
```

各自的服务端逐文件中位耗时劣化比值 = 1.56 / 1.66 / 2.92 / 2.15 / 1.94（K=4）。按 AC4 自己的说明，这只是旁证；run 3 的 2.92 也说明这条判据的噪声底离 K=4 并不远，真正的判据是 §2 的确定性余量。

### 7. 与 Proposal 的三处出入（诚实登记）

1. **族是 13 个文件，不是 11 个。** Proposal 说「13 个里 2 个无动态 import 故不计入」，但 `chatDrafts.test.ts` 与 `userSettings.test.ts` 其实**有**——它们把 `vi.resetModules(); return import(...)` 放在 `loadStore()` 里、由每个用例调用，与族内其余文件同一构造。判据脚本按机制派生（`resetModules` 与动态 `import(` 同时出现）得到 13，是有意为之：新增的同族文件会自动纳入。这两个文件改前就 ≤ 78ms（图很浅），不需要预热，改后仍在同一量级 —— 把它们算进族内的代价是零，收益是判据不会漏掉一个真的会长胖的图。
2. **11 个 Touches 测试文件里只有 3 个需要改。** 其余 8 个改前 `T_max` 就 ≤ 155ms。`Touches` 是**写面**（anti-drift 的声明边界），不是待办清单，所以那 8 个没有被改；它们的余量由判据一并守着。
3. **AC-103 点名的 `busySessionIds.test.tsx` 不是自伤型的。** 它 `T_max = 27–28ms`，占预算 0.6% —— 它在并发里红，是**被别的 worker 饿死**（Proposal 自己也记了「整张 vitest worker 被饿死」这一现象），不是它自己在 5s 预算里付冷编译。本任务修的是「用例预算被自己的冷编译吃掉」这一类，**不降低总 CPU 需求**（编译照付，只是换了预算科目），所以「轻文件被外部争抢饿死」这条路径不在本任务射程内 —— 它只能由 §6 的 AC4 旁证，而那正是 Proposal 自己标注为不足以证明的那条。改后 3 个重文件的用例窗口从 ~3.6s 缩到 ~0.65s，对争抢压力有边际缓解，但这不构成对饿死路径的证明。

### 8. 顺带发现（未修，越界）

`scripts/test.sh --for-task` 用 `awk … print $1` 取 `## Touches` 的路径，而本任务两条 Touches 的注解紧贴路径（`` `path`（注解） ``），于是 `$1` 把中文注解一起吞掉、被 `\.test\.[jt]sx?$` 过滤掉 —— 这次实际只有 **9/11** 个测试文件进了 scoped gate，缺的恰好包含本任务的核心文件 `projectsStateSelectionSync.test.ts`。**没有改任务文件的 Touches**：fan-in 侧的 `parseTouchEntries`/`stripTouchAnnotation` 正是靠全角 `（…）` 来剥注解的，换成空格加破折号会让 glob 变成「路径 + 注解」，触发 anti-drift HARD FAIL。缺口已用等价手段补齐：11 个文件全部用 `scripts/test.sh` 显式位置参数跑过一遍（`# tests 11 / # pass 11 / # fail 0`），scoped gate 本身 9/9 退出 0。`scripts/test.sh` 不在本任务 Touches 内，故未改。

### 9. 收尾：ADR-007 声明行从 `## Touches` 移进 `## DoD`（anti-drift）

上一轮 exited-not-landed 的唯一原因是 anti-drift HARD FAIL 1 条 `overbroad-declaration`，它与修复本身无关 —— 是**任务体格式**问题：本轮之前，ADR-007 的显式声明行（`- 该轴仍暗，理由：…`）写在 `## Touches` 段内。anti-drift 的 `parseTouchEntries` 把该段里**每一行 `- …` 都当成声明的写面**，而这一行没有 `/`、又含 Markdown 粗体 `**耗时余量**`，于是 `isOverbroadDeclaration` 在第一个段（`concrete = 0 < 2`）上撞见 `*` ⇒ 整行被判成「过宽的写面声明」。

声明行本身不能删：`dark-axis-record-check` 认它，删掉状态会从 `DISCLAIMED` 退回 `MISSING`。修法是把该行**移进 `## DoD`**（`classifyDarkAxisRecord` 扫全文、不限段），`## Touches` 只留真正的写面条目 —— **一个 Touches 条目都没改**，也没有任何判据/代码改动。

读数（本工作树）：

```
ANTI-DRIFT OK: task gap-resetmodules-cold-compile-timeout — 5 actual file(s), all within declared Touches (14 glob(s))
dark-axis-record-check: state: DISCLAIMED (declared: line 50)
```

即：本任务 `## Touches` 末尾不再有声明行 —— 声明在 DoD。


## Touches

- `scripts/test-timeout-margin-check.sh`（新增：本任务的确定性判据）
- `vitest.config.ts`（显式 `testTimeout`；走第 3 条路径时必改）
- `src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts`（已验证的失败文件，冷编译须移出用例预算）
- `src/shared/tests/busySessionIds.test.tsx`（同族，AC-103 origin 点名的另一个并发失败文件）
- `src/modules/project-workspace/tests/projectsStateSessionAlias.test.ts`
- `src/modules/project-workspace/tests/projectsInitialFetch.test.tsx`
- `src/modules/chat/tests/markdownSyntaxThemeInjection.test.tsx`
- `src/modules/chat/tests/chatProviderModels.test.ts`
- `src/modules/chat/tests/sessionStoreTruncate.test.tsx`
- `src/modules/chat/tests/transcriptScrollOwnership.test.tsx`
- `src/modules/chat/tests/tokenUsageFreshness.test.tsx`
- `src/modules/settings/tests/settingsControllerCodeEditor.test.ts`
- `src/shared/tests/authenticatedFetch.test.ts`
- `tasks/gap-resetmodules-cold-compile-timeout.md`（本任务自身）

