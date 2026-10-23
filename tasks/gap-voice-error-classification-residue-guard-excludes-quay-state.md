---
id: gap-voice-error-classification-residue-guard-excludes-quay-state
title: AC-152 判据的 no-residue 守卫把 quay 自己的运行时状态（被 gitignore 的
  .quay/）算成残留，驱动每写心跳/每文件账目就假红一次（1990 条读数里 397 条）⇒ 残留读数只覆盖 worktree 的 git
  可见面，且守卫的牙仍在
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-152
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rln "treeSnapshot\|left files behind\|no residue\|SNAPSHOT_AT_START\|residue-probe" tasks/*.md` → 0 命中；`grep -rln "\.quay/anchor\.json" tasks/*.md` → 0 命中；`grep -rn "^goal_ac: *AC-152" tasks/*.md` 只命中 `gap-voice-error-single-classifier-two-paths`（status=done）。**没有在飞（todo/ready/needs-human）的第二条认领者**，本条是新立的第二条。与那条 done 任务的关系是**证据关系**，不是重复：那条落地了 AC-152 的实质保证（分类只有一份实现、两条路径逐行同码），本条处理的是**它自己的判据不自洽**这一格 —— 见下。

**这条判据今天为什么是假（直接测量，不是台账尾巴）**

`AC-152` 的 `criterion:` 逐字是 `npx vitest run src/shared/tests/voiceErrorClassification.test.ts`。该文件里 `AC1: budget, doors, and no residue` 带了一条自守断言：

- `src/shared/tests/voiceErrorClassification.test.ts:383-411` 的 `treeSnapshot()` 从 `REPO_ROOT` 递归走一遍，对每个文件记 `${path}:${mtimeMs}:${size}`；`:413` 在**模块加载时**取一次 `SNAPSHOT_AT_START`；`:669` 在 `AC1` 里再走一遍，差集即「残留」；`:679` 是 `expect(residue, 'the run left files behind: …').toEqual([])`。
- `:384` 的 `skip` 集合逐字是 `['.git','node_modules','dist','coverage','artifacts','.vite']` —— **不含 `.quay`**。

而 `.quay/` 是 quay 驱动自己的运行时状态目录，被 `.gitignore:155` 的 `.quay/*` 忽略（`:156-157` 只放行 `config.yml` 与 `profiles.yml`），并且**在判据运行期间被并发改写**：

- `.quay/anchor.json` —— 锚进程（PID 2725523，`node …/driver-anchor.js __anchor --root /data/home/yale/work/claudecodeui`）的心跳文件，395 字节，按周期重写。
- `.quay/per-file-cpu-<rand>/<hash>.{cpu,mem}` —— 驱动的**每文件 CPU/内存账目**，在判据跑的同一刻落盘。

台账 `.quay/gate-events.jsonl` 里 `AC-152` 共 **1990 条读数**（首条 `2026-09-24T12:38:24.665Z`，末条 `2026-09-27T07:59:29.772Z`）。其中 `verdict=fail` 且理由含 `the run left files behind` 的 **397 条**（09-25 125、09-26 211、09-27 41），命中的残留**无一例外**全在 `.quay/` 下，逐字形态如：

```
/.quay/anchor.json:1790495969449.582:395
/.quay/anchor.json:1790483408258.6726:395, /.quay/per-file-cpu-mfigapac/9f5fcbb95bb7a857.cpu:1790483408283.6724:9, /.quay/per-file-cpu-mfigapac/9f5fcbb95bb7a857.mem:1790483408283.6724:7
/.quay/per-file-cpu-mfigapvo/85290c5c6e06b2f4.cpu:1790483582950.0107:8, /.quay/per-file-cpu-mfigapvo/85290c5c6e06b2f4.mem:1790483582950.0107:7
```

同期 `pass` 1422 条 ⇒ **约 21% 的读数是这一条自守断言的假红**；而判据的实质部分（21 行逐行同码、`classifier-defs=1`、两条取假形态仍红）在这些红里**从未**失败过。

**确定性复现（立案时在本仓实测，非推测）**：连续 6 次运行判据命令，同时用一个后台循环反复 `touch` 一个 `.quay/` 下的 scratch 文件 ⇒ **6/6 红**，每次红在 `the run left files behind: /.quay/.residue-probe-<pid>.tmp:<mtime>:0`。探针文件已删除，`git status --porcelain` 与本任务启动时逐字相同。

**根因**：`AC1` 自称读的是 `git status --porcelain` 那一个事实（`:377-379` 注释逐字如此），但**那个机制永远看不到 `.quay/*`**（被 gitignore）。走 `.quay/` 的 mtime 快照把「git 根本不管的 harness 运行时状态」也算进了残留 —— 于是**判据与它自己的驱动抢同一个文件**：驱动每写一次心跳/账目，判据就假红一次。这**不是**被测代码的缺陷（分类器与两条路径的同码读数是真绿的），是判据自守面的取景错误。

**修法方向（实现者定杠杆，读数由 AC 钉死）**：让残留读数只覆盖 worktree 的 **git 可见面**。最小面是把 `.quay` 加进 `:384` 的 `skip` 集合 —— 与既有的 `.git` / `node_modules` / `dist` 同一纪律（它们都是「别人写的目录」，`:379-381` 的注释已经把这个理由写死）。若实现者选择从 `.gitignore` 派生排除面（更耐未来新增的 quay 运行时目录：`.workflow-events/`、`orchestration/`、`milestones/fast-mode-telemetry/` 同属这一类，见 `.gitignore:158-167`），亦可，但**必须**在注释里写明与 `.gitignore` / `git status --porcelain` 的关系，并**不得**碰 `:669` 的差集语义、`:679` 的断言形状、21 行夹具与两条取假形态。**不得**删掉残留守卫本身 —— 那会把 AC1 的一条读数整根拔掉，属于把判据改绿而不是改对。

**改动面**：出货代码一行不动；被测文件只有 `src/shared/tests/voiceErrorClassification.test.ts` 一个，且只动 `:384` 的 `skip` 集合与紧邻解释该排除的注释（`treeSnapshot()` 的差集语义、`:679` 的断言形状、21 行夹具、两条取假形态、`:678` 与 `:680` 的 doors/预算断言都不动）。另一处是本任务自身的记录文件。

**边界（不做）**：不改分类器、码串表、状态表或任何出货代码（AC-149/150 的实质交付面原样）；不改 21 行夹具与两条取假形态；**不写、不改、不删 `.quay/` 里的任何驱动文件**（只读观察；AC1 的探针文件是全程唯一的例外，且用后即删）；不改 `.gitignore`；不做真实浏览器（AC-153）；不放宽 `:680` 的 30s 预算与 `:678` 的 doors 断言；不引入子进程（`AC1` 自守面要求判据无子进程，见 `:363-372` 与 `:374-382` 的注释）。

## AC

- [x] AC1 判据在**并发写 `.quay/`** 下连续 20 次全绿：`rm -f .quay/.residue-probe-*.tmp && touch .quay/.residue-probe-ac152.tmp`，后台起 `for i in $(seq 1 1200); do touch .quay/.residue-probe-ac152.tmp; sleep 0.02; done &`，随后连跑 20 次 `npx vitest run src/shared/tests/voiceErrorClassification.test.ts`；每次退出 0 且 stdout 含 `git-clean-after=true` 与 `6 passed` ⇒ **20/20**。跑完 `kill` 探针并 `rm -f` 探针文件。**取假形态（修复前必红）**：同一根探针、同一命令，在修复落地前连跑 ≥5 次必须 ≥5/5 红且红在 `the run left files behind`；两臂只差修复状态，实测读数记入完成记录。
- [x] AC2 守卫的牙仍在（正对照，防「把判据改绿」）：跑之前先确认 `git check-ignore -v src/shared/tests/.ac152-residue-probe.tmp` **退出 1**（该路径不被 gitignore，因此在任何「从 `.gitignore` 派生排除面」的修法下都必须仍算残留）；随后 `touch src/shared/tests/.ac152-residue-probe.tmp` 并起同样的后台循环，跑同一条判据命令 ⇒ **必须红**，stderr 含 `the run left files behind` 且指名该探针。跑完删除探针，`git status --porcelain` 与本任务启动时逐字相同。
- [x] AC3 实质读数不变（一次干净运行，退出 0）：stdout 逐条含 `rows=21`、`agreed=21`、`openai-family=4`、`classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true`、`mutation=client-second-table` 那行的 `mutant-red=true`、`mutation=direct-status-only` 那行的 `mutant-red=true`、`subprocess-imports=0`、`ports=0`；且 `6 passed`。
- [x] AC4 排除面的书写与事实一致：`grep -n "\.quay" src/shared/tests/voiceErrorClassification.test.ts` 的命中处落在 `skip` 集合的**代码**里（不是只在注释里）；同文件注释里出现 `gitignore` 或 `git status --porcelain` 字样说明理由；`git check-ignore -v .quay/anchor.json` 退出 0（证明 `.quay/` 确实是 git 看不到的面）。

## DoD

判据在**本仓真实并发**下（锚进程正按周期重写 `.quay/anchor.json`、驱动正在写 `.quay/per-file-cpu-*`）连续 20 次全绿，并且 `.quay/gate-events.jsonl` 里 `AC-152` 的**下一轮读数翻成 `verdict=pass`**（台账尾巴不再每隔几轮翻红）——即缺陷是**在真实运行条件下**消失的，不是靠运气没被并发命中。取假形态有一份可复算的记录：同一根「并发 touch 一个文件」的杠杆，探针放在 `.quay/` 下判据保持绿、放在 `src/shared/tests/` 下判据必红 —— 证明修的是**取景**（git 可见面 vs harness 运行时目录），不是把守卫的牙拔掉。探针清理后 `git status --porcelain` 与本任务启动时逐字相同；未新增 `*.test.*` 文件；未改任何出货代码。

## Touches

- src/shared/tests/voiceErrorClassification.test.ts
- tasks/gap-voice-error-classification-residue-guard-excludes-quay-state.md

## 完成记录

**结论：修的是取景，不是把守卫改绿。** 残留读数现在只覆盖 worktree 的 git 可见面：`.quay` 与既有的 `.git` / `node_modules` / `dist` / `coverage` / `artifacts` / `.vite` 同列进 `treeSnapshot()` 的 `skip` 集合（`src/shared/tests/voiceErrorClassification.test.ts:392`，逐字 `['.git', 'node_modules', 'dist', 'coverage', 'artifacts', '.vite', '.quay']`），紧邻注释写明它与 `.gitignore` / `git status --porcelain` 的关系。`treeSnapshot()` 的差集语义、`:679` 的断言形状、21 行夹具、两条取假形态、`:678` 的 doors 与 `:680` 的 30s 预算逐字未动；出货代码一行未改 —— `git diff --stat develop...HEAD` 只有 `src/shared/tests/voiceErrorClassification.test.ts | 10 +++++++++-`（1 file changed, 9 insertions(+), 1 deletion(-)），未新增任何 `*.test.*` 文件。实现提交 `ecab9014`。

### 取假形态（同一根杠杆，两臂只差修复状态）

杠杆 = 后台循环每 20ms `touch` 同一根探针（`for i in $(seq 1 4000); do touch <probe>; sleep 0.02; done`，pid 写进 `/tmp` 文件，跑完按 pid `kill`）。

**臂 A —— 修复前，探针在 `.quay/`：5/5 红。** 命令 `npx vitest run src/shared/tests/voiceErrorClassification.test.ts`：

```
RUN 1 exit=1 residue=the run left files behind: /.quay/.residue-probe-ac152.tmp:1790496288633.364:0
RUN 2 exit=1 residue=the run left files behind: /.quay/.residue-probe-ac152.tmp:1790496289684.3599:0
RUN 3 exit=1 residue=the run left files behind: /.quay/.residue-probe-ac152.tmp:1790496290781.3557:0
RUN 4 exit=1 residue=the run left files behind: /.quay/.residue-probe-ac152.tmp:1790496291878.3516:0
RUN 5 exit=1 residue=the run left files behind: /.quay/.residue-probe-ac152.tmp:1790496292990.3472:0
```

**臂 B —— 修复后，探针在 `src/shared/tests/`：3/3 红。** 同一根杠杆、同一条命令，只把探针路径换到 `src/shared/tests/.ac152-residue-probe.tmp`：

```
CTL RUN 1 exit=1 residue=the run left files behind: /src/shared/tests/.ac152-residue-probe.tmp:1790496343458.1538:0
CTL RUN 2 exit=1 residue=the run left files behind: /src/shared/tests/.ac152-residue-probe.tmp:1790496344556.1494:0
CTL RUN 3 exit=1 residue=the run left files behind: /src/shared/tests/.ac152-residue-probe.tmp:1790496345635.1453:0
```

两臂只差「探针落在 `.quay/` 还是 git 可见的 `src/shared/tests/`」⇒ 改的是取景，守卫的牙仍在。

### AC1 —— 并发写 `.quay/` 下连续 20 次全绿

`rm -f .quay/.residue-probe-ac152.tmp && touch .quay/.residue-probe-ac152.tmp` 后起后台循环，连跑 20 次：

```
RUN 01..20 exit=0 git-clean-after=1 6passed=1   （无一条 residue）
=== PASSED 20 / 20
```

每次 `exit=0`、stdout 含 `git-clean-after=true` 与 `6 passed`，20/20。跑完按 pid `kill` 循环、`rm -f` 探针；`.quay/` 回到只剩 `config.yml` 与 `profiles.yml`，无残留进程（`ps -eo pid,args | grep -c '[a]c152-loop'` 为 0）。

### AC2 —— 守卫的牙仍在（正对照）

`git check-ignore -v src/shared/tests/.ac152-residue-probe.tmp` 逐字输出为空、**退出 1**（该路径不被 gitignore）；随后同一根循环 + 同一命令 ⇒ 3/3 红，stderr 指名 `/src/shared/tests/.ac152-residue-probe.tmp`（读数见上「臂 B」）。跑完删除探针。

### AC3 —— 实质读数不变（一次干净运行，退出 0）

```
rows=21 openai-family=4 agreed=21 unknown-code-fallback=UNAUTHORIZED
classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true
mutation=client-second-table base-green=true mutant-red=true which=403|AccessDenied.Unpurchased outside-family-green=true
mutation=direct-status-only base-green=3/2/2 mutant-red=true which=403|AccessDenied.Unpurchased outside-family-green=true
reading AC1 scope = elapsed-ms=38 subprocess-imports=0 [] git-clean-after=true offline-transport=injected ports=0 shipped=true
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

逐条 marker 命中计数：`rows=21`=1、`agreed=21`=1、`openai-family=4`=1、`classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true`=1、`mutation=client-second-table … mutant-red=true`=1、`mutation=direct-status-only … mutant-red=true`=1、`subprocess-imports=0`=1、`ports=0`=1、`6 passed`=1；退出 0。

### AC4 —— 排除面的书写与事实一致

```
383: * `.quay` is skipped on the same discipline — it is a directory somebody else writes. It holds
384: * quay's own runtime state, which the driver rewrites while this criterion runs (`.quay/anchor.json`
385: * is a heartbeat file, `.quay/per-file-cpu-*` are its per-file account files), and it is exactly the
386: * surface `git status --porcelain` cannot see: `.gitignore` ignores `.quay/*`, re-including only the
392:  const skip = new Set(['.git', 'node_modules', 'dist', 'coverage', 'artifacts', '.vite', '.quay']);
```

`:392` 是 `skip` 集合的**代码**命中；注释里同时出现 `gitignore` 与 `git status --porcelain` 说明理由。`git check-ignore -v .quay/anchor.json` → `.gitignore:155:.quay/*	.quay/anchor.json`、**退出 0**（证明 `.quay/` 确实是 git 看不到的面）。

### 收尾状态

探针全部清理后，worktree 的 `git status --porcelain` 只剩本次实现改动；主检出（`/data/home/yale/work/claudecodeui`）的 `git status --porcelain` 与本任务启动时**逐字相同**（`?? .codex/`、`?? artifacts/`、`?? docs/proposals/mobile-workspace-and-composer-layout.md`、`?? e2e/zz-diag-session-filter.spec.ts`）。未写、未改、未删 `.quay/` 里的任何驱动文件；未改 `.gitignore`。本轮 `scripts/test.sh --for-task … --allow-thin` 作用域门在合并 develop 后的树上绿：`__PERFILE__ duration_ms=40 src/shared/tests/voiceErrorClassification.test.ts passed=true`、`# pass 1 / # fail 0`、退出 0。