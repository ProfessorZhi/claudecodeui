---
id: gap-voice-false-forms-siblings-pid-attribution
title: voice false-forms 三个兄弟判据（capture-off / capture-text /
  dashscope-settings）共写 server/modules/voice/ 却不按 pid 归因：suite 并发 4 下读到邻居在途的
  __criterion-falsify-* 临时副本 ⇒ 全舰队 fan-in 假红（19 份日志 12 份），且日志引的 not ok 行是一条通过的读数
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象。** `scripts/test.sh` 默认并发 4。`server/modules/voice/tests/` 下有四个 `*.false-forms.test.ts` 判据，各自把变异临时副本 `__criterion-falsify-<mutation>-{base,mut}-<pid>.ts` 写进**同一个** `server/modules/voice/`，并在模块加载时取一次 `git status --porcelain`（`PRE_RUN_PORCELAIN`），在收尾的 case 里再取一次比较。邻居的副本在本文件启动时还活着、到本文件取样时已删掉，两次快照就不等——即使终态树是干净的。特征读数：`git.status-clean=true unchanged=false temp-copies=none`，断言文案 `this run changed the worktree's git status: (empty)`。单独跑同一文件是绿的（约 26–33s），只有 suite 红。

**波及面（2026-09-25 实测）。** 19 份 `.quay/fan-in-suite-*.log` 里 12 份红在 `voice-capture-text.false-forms.test.ts`，横跨 6 个互不相干的任务；`gap-claude-session-cgroup-scope`、`gap-session-hosts-default-wrap-four-providers`、`gap-session-filter-criterion-bounded-boot-guard`、`gap-transcript-follow-ac110-case-nav-skips-boot-guard` 因此各被 driver 连续 2–3 轮红后停进 needs-human，而它们的改动里没有一个 voice 文件。裸的两文件并发（无 suite）就能复现，所以不是 `--test-concurrency` 之类的调参能治的。

**根因就是三个尚未归因的兄弟。** 同目录另两个已经修好、可直接照抄形状：`voice-error-contract.false-forms.test.ts:72-110` 定义 `OWN_TEMP_SUFFIX`/`isTempCopy`/`isOwnTempCopy`/`snapshotDelta`，`:398-460` 的收尾 case 用它们；`voice-error-classification.false-forms.test.ts` 已把副本写进私有 `SCRATCH_DIR`。还没修的三个：

- `voice-capture-off.false-forms.test.ts`：`PRE_RUN_PORCELAIN` 在 `:74`，`leftovers`+`unchanged` 两个断言在 `:312-336`。
- `voice-capture-text.false-forms.test.ts`：`PRE_RUN_PORCELAIN` 在 `:88`，`leftovers`+`unchanged` 两个断言在 `:444-468`。
- `voice-dashscope-settings.false-forms.test.ts`：`:187-215` 的 `leftovers` 断言按 `line.includes(TEMP_PREFIX)` 过滤而不分 pid，别人的副本在它取样时活着就红。它还有**第二条独立通道**：`voice-dashscope-settings.test.ts:936` 的 `AC8 server-branch-scan` 先 `collectSourceFiles(SERVER_DIR)`（`:519`）整树遍历、再逐个 `readFile`；邻居在这个窗口里创建/删除 `__criterion-falsify-*.ts`，遍历时在、读取时不在就抛 ENOENT，`collectReadings` 按读数 catch 成 `{ok:false, value:'threw: ENOENT …'}`，文案上与真命中无法区分，表现为 `the unmutated copy must clear the whole list …; it red at AC8 server-branch-scan`。

**修法（已在 error-contract 上验证过的形状，逐个移植）。** 用 pid 后缀把 porcelain 行归到本进程：本进程自己的残留无条件红；快照差集只在**每一条**差异行都是别的 pid 的 `__criterion-falsify-*` 时才放过；任何别的差异（新增/消失/修改的非临时文件）仍然红。读数同时打印两侧差集与两侧首行，使"脏起点"不再被报成"脏终点"。dashscope 的 AC8 扫描：`collectSourceFiles` 不收 `__criterion-falsify-` 前缀的文件（这是本套件自己写的、不属于要扫的产品源码），这样遍历结果不再随邻居的临时文件抖动；真出现在非前缀产品文件里的 `'dashscope-omni'` 仍然算命中。

<!-- dedup-ref -->
**相关但机制不同。** 原先跟踪这条通道的 `gap-ac103-worktree-state-drag-and-unbudgeted-confirm` 已随其目标 AC 改为 `superseded`，其 §5 点名的这条"仍存通道"没有任何在册任务接手，本任务即接手；它与 `gap-debug-agent-load-observation-determinism`（`debug-agent-external-write` 的负载通道，已 done）是不同机制，不在本任务范围内。同样不在范围内：`scripts/test.sh` 的 `first_error()` 把通过的读数行（其文案含 "failed" 一词）当失败原因引用——那是另一个机制（归因文案），本任务只消除会触发它的假红。

## AC

- [x] **AC1 外来副本被放过（capture-off 与 capture-text 各一次）：** 工作树根下，先创建一个 pid 后缀不是本进程的未跟踪文件 `server/modules/voice/__criterion-falsify-plant-99999999.ts`，随即启动 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/<file>`，4 秒后删掉该文件；`<file>` 取 `voice-capture-off.false-forms.test.ts` 与 `voice-capture-text.false-forms.test.ts`，两次退出码都为 0，且 stdout 含 `concurrent-foreign-only=true`。同一探针在改动前的 develop 上必须读到退出码 1（把这个红读数记进完成记录，证明探针有分辨力）。
- [x] **AC2 非临时文件的差异仍然红（负控制）：** 与 AC1 相同的时序，但植入并在 4 秒后删除的是一个**不带** `__criterion-falsify-` 前缀的未跟踪文件 `server/modules/voice/__stray-probe.ts`；capture-off 与 capture-text 两次都必须退出码非 0，红态文案含 `removed=[` 且点名该文件。
- [x] **AC3 本进程的残留仍然红（负控制）：** 在 capture-text 的一份**临时副本**（放在 `server/modules/voice/tests/` 下、跑完删除）里把 `finally` 中的两处 `rm(basePath…)`/`rm(mutantPath…)` 去掉，跑该副本必须退出码非 0，红态文案含 `this run left its own temp copies behind`；对 capture-off 做同样的变体，结论相同。变体文件跑完已删除，`git status --porcelain` 与跑之前逐字相同。
- [x] **AC4 dashscope 的两条通道：** (a) `voice-dashscope-settings.false-forms.test.ts` 在 AC1 的植入时序下退出码为 0，且改动前同探针读到非 0；(b) 在 `voice-dashscope-settings.test.ts` 里新增用例，循环 20 次：每次先在 `server/modules/voice/` 创建再删除一个 `__criterion-falsify-ac8probe-<n>.ts`，并发调用 `collectReadings`，断言 `AC8 server-branch-scan` 这一条 20 次全部 `ok=true` 且 `files=` 计数不随之抖动；同一用例再植入一个**不带前缀**、内容含 `'dashscope-omni'` 的非 `tests/` 产品文件，断言该读数变为 `ok=false` 且 `shipping-hits=1`（正控制，证明前缀排除没有把真命中一起吞掉），用例收尾把该文件删掉。
- [x] **AC5 并发下三次全绿：** 在 `--test-concurrency=4` 下同时跑 `server/modules/voice/tests/*.false-forms.test.ts` 与 `voice-dashscope-settings.test.ts`，连续 3 轮，每轮退出码 0；三轮的 `falsify/leftovers` 读数逐行写进完成记录（读 `unchanged`，不读 `status-clean`）。
- [x] **AC6 门与范围：** `npm run typecheck` 与 `npm run lint`（不是裸 `oxlint`）退出码 0；`git diff --stat develop...HEAD` 只出现在 `## Touches` 列出的文件里，且没有任何非 `tests/` 的 `server/` 文件。

## DoD

真实落地的标准不是"测试文件里多了几个函数"，而是**那条会红的通道被真正操作过**：AC1 与 AC4(a) 的植入探针在改动前的树上读到过红、改动后读到绿，两侧读数（退出码、`unchanged`/`removed`/`concurrent-foreign-only` 字段）都原样写进完成记录；AC2、AC3 两条负控制证明放过外来副本没有连带放过真差异；AC4(b) 的 20 次扰动与正控制证明扫描既稳定又没漏；AC5 三轮并发全绿。完成后，再有 fan-in 的 suite 因 `voice-capture-text`/`voice-capture-off`/`voice-dashscope-settings` 这三个文件红时，那必须是真红而不是共享目录的串扰——这是可以从此后 fan-in 日志里读回来的：`.quay/fan-in-suite-*.log` 里这三个文件的 `unchanged=false temp-copies=none` 读数不再出现。不修改任何产品源码，也不碰已经修好的 `voice-error-contract`/`voice-error-classification` 两份。

## Touches

- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts
- server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts
- server/modules/voice/tests/voice-dashscope-settings.test.ts
- tasks/gap-voice-false-forms-siblings-pid-attribution.md

## 完成记录

### 提交、预合并与范围门

- 实现提交：`d5f7904b voice false-forms: attribute the shared directory's temp copies by pid`（分支 `task/gap-voice-false-forms-siblings-pid-attribution`，父提交 `e4d5e97b` = develop 尖端）；工作树 `git status --porcelain` 为空。
- 预合并：`git merge --no-edit develop` → `Already up to date`（develop 已是本分支祖先，无冲突）。
- 范围门：`bash scripts/test.sh --for-task gap-voice-false-forms-siblings-pid-attribution --allow-thin` 退出码 0，`__PERFILE__ voice-capture-off.false-forms.test.ts passed=true duration_ms=24952` / `voice-capture-text.false-forms.test.ts passed=true duration_ms=27210` / `voice-dashscope-settings.false-forms.test.ts passed=true duration_ms=2112` / `voice-dashscope-settings.test.ts passed=true duration_ms=11433`，`tests 4 / pass 4 / fail 0`；suite-scope-check PASS。
- scoped-gate 缓存已写：`{"event":"scoped-gate-cache-written","task":"gap-voice-false-forms-siblings-pid-attribution","developSha":"e4d5e97b5abc60db3da2648c5bb9b5bd1f6ee856","cacheFile":".quay/scoped-gate-cache.json"}`。

### 改动

只动 `## Touches` 列的四个文件，无产品源码改动：

- 三个 `*.false-forms.test.ts`：新增 `OWN_TEMP_SUFFIX` / `isTempCopy` / `isOwnTempCopy` / `snapshotDelta`，收尾读数改为「先无条件断言本进程自己的副本为空（`own-temp-copies`，比旧读数更严——旧读数把兄弟的副本当成本次运行的残留），再比较快照差集」；差集只在**每一条**差异行都是别的 pid 的 `__criterion-falsify-*` 时才放过（`concurrent-foreign-only=true`），失败文案同时打印 `added=[…] removed=[…]` 与两侧首行；文件头补一段说明该目录是共享的。capture-off / capture-text 此前是 `leftovers` + `unchanged` 两个断言；dashscope-settings 此前只有不分 pid 的 `leftovers` 过滤，本次另加 `PRE_RUN_PORCELAIN`。
- `voice-dashscope-settings.test.ts`：`collectSourceFiles` 按名字不收 `__criterion-falsify-` 前缀（本套件自己写的临时副本不属于要扫的产品源码）；新增 AC4(b) 用例（20 次扰动 + 正控制）。

### AC1（外来副本被放过）—— 探针两侧读数

探针：工作树根下植入 `server/modules/voice/__criterion-falsify-plant-99999999.ts`，随即 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/<file>`，4 秒后 `rm` 该文件。改动前的读数取自 develop（`e4d5e97b`）的独立 scratch 检出（未触碰 develop 工作树）。

| 文件 | 改动前 | 改动后 |
| --- | --- | --- |
| capture-off | exit=1，`falsify/leftovers: git.status-clean=true unchanged=false temp-copies=none`，`AssertionError: this run changed the worktree's git status: (empty)` | exit=0，`falsify/leftovers: git.status-clean=true unchanged=true own-temp-copies=none temp-copies-any=0 foreign-temp-copies=0 raw-unchanged=false added=0 removed=1 concurrent-foreign-only=true` |
| capture-text | exit=1，同上读数与同一条断言文案 | exit=0，同上读数，`removed=1` |

改动后的两次运行都另打印 `falsify/concurrent-foreign-only=true (the only delta was 1 temp copy line(s) belonging to another process, alive at this file's start and cleaned up by now)`。

改动前的读数正是本任务的现象特征：**终态树干净**（`git.status-clean=true`）、`temp-copies=none`，唯一差异是植入文件在起点活着、终点已删——这就是「脏起点被报成脏终点」。

### AC2 / AC3 负控制

- AC2（非临时文件的差异仍然红）：同样时序，植入不带前缀的 `server/modules/voice/__stray-probe.ts`。capture-off 与 capture-text 都 exit=1，`removed=[?? server/modules/voice/__stray-probe.ts]`，`started-with=["?? server/modules/voice/__stray-probe.ts"] ended-with=["(empty)"]`。
- AC3（本进程的残留仍然红）：把 capture-off / capture-text 各复制一份到 `server/modules/voice/tests/__criterion-variant-<name>.ts`，去掉 `finally` 里的两处 `rm(basePath…)/rm(mutantPath…)`，跑副本。两者都 exit=1，文案 `this run left its own temp copies behind: ?? …__criterion-falsify-gate-permanently-open-base-<pid>.ts …`（capture-off 4 份、capture-text 8 份）；跑完删掉变体与本轮留下的副本后 `git status --porcelain` 与跑之前逐字相同（`porcelain-identical=true`）。

### AC4（dashscope 的两条通道）

- (a) 假红通道：改动前 exit=1，`falsify/leftovers: git.status-clean=false temp-copies=?? server/modules/voice/__criterion-falsify-plant-99999999.ts`，`the run left temp copies behind: …`；改动后 exit=0，`unchanged=true own-temp-copies=none temp-copies-any=1 foreign-temp-copies=1 raw-unchanged=true added=0 removed=0 concurrent-foreign-only=false`。这个文件比植入的 4 秒短（约 2.1s），植入文件在两次快照里都在，差集为空、连放过分支都没走到——正是「两侧快照都在的外来副本不产生差异」那一档。
- (b) AC8 扫描通道：20 次扰动循环读数 `ac8-churn-summary repetitions=20 distinct-files-counts=1 files=322 all-ok=true`（每次 `ac8-churn n=… delay-ms=… ok=true`，延迟 0→1300ms 递增）；正控制把 `export const providerId = 'dashscope-omni';` 写进 `server/modules/voice/tmp/__stray-shipping-probe.ts`（`tmp/` 是 git-ignored，因此不会污染兄弟判据的快照差集），读数变为 `ac8-positive-control ok=false server-branch-scan files=323 shipping-hits=1 [modules/voice/tmp/__stray-shipping-probe.ts] test-fixture-hits=5 […]`，用例收尾 `rm -rf server/modules/voice/tmp`。

### AC5（并发三轮全绿）

`npx tsx --tsconfig server/tsconfig.json --test --test-concurrency=4` 跑六个文件（五个 `*.false-forms.test.ts` 加 `voice-dashscope-settings.test.ts`），连续 3 轮，每轮 exit=0 且 `tests 56 / pass 56 / fail 0`。收尾读数逐行（读 `unchanged`，不读 `git.status-clean`），三轮一致：

- capture-off / capture-text / error-contract：`unchanged=true own-temp-copies=none`
- dashscope false-forms：`git.status-clean=false unchanged=true own-temp-copies=none temp-copies-any=1 foreign-temp-copies=1 raw-unchanged=false added=1 removed=0 concurrent-foreign-only=true`——旧代码会把这一条报成本次运行的残留。
- error-classification：`scratch-remains=false own-temp-copies=none git-unchanged=true`

### AC6（门与范围）

`npm run typecheck` 退出码 0；`npm run lint` 退出码 0（输出只有既有的 `react-hooks`/`tailwind`/`react` 告警）；`git diff --stat develop...HEAD` 恰为 `## Touches` 的四个 `*.test.ts`（492 insertions / 49 deletions），`git diff --name-only develop...HEAD | grep '^server/' | grep -v '/tests/'` 为空。未触碰 `voice-error-contract` 与 `voice-error-classification` 两份。
