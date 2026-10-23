---
id: gap-ac122-shared-assembly-starves-leg-budget
title: AC-122 判据在宿主并发下红在文件的共享装配阶段：装配与判据共用同一个 35s 预算，被饿死时与「双回放保证破了」同形
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-122
---
## Proposal

本任务承接 AC-122（回放同时提供原始录音与裁剪后音频两条）。判据命令是 `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"`。

### 立案测量一：判据对象为真

`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 在本 checkout（`author`）连跑四次，**全部退出 0**：

```
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-XVXAWs free-bytes=3837785788416 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
[e2e] server=2843 client=22841
[voice-replay] original=2.640s/17416B trimmed=1.850s/177644B (the trimmed replay is the larger body: PCM WAV against the recorder's opus)
  ✓  1 e2e/voice-trim.spec.ts:1104:3 › the voice path end to end › AC-122 the recording is replayable beside the trimmed upload, one at a time (8.6s)
  1 passed (18.7s)
```

四次收尾分别是 `1 passed (18.7s) / (19.0s) / (20.2s) / (19.0s)`，读数行同形（第四次 `original=2.640s/17741B trimmed=1.870s/179564B`）。判据要求的四件事都在读数里：两条控件存在且可辨、两条 `data-clip-url` 不同源、裁剪那条 `RIFF`（1.850s）严格短于原始那条 recorder 的流（2.640s）、互斥由页内 `window.Audio` 注册表判定。

### 立案测量二：台账尾巴是红，两次失败目录都还在盘上

`.quay/gate-events.jsonl` 里 AC-122 的尾巴：

| 时间 (UTC) | actor | verdict | 运行目录 |
|---|---|---|---|
| 2026-09-26T01:05:13.351Z | goal-sweep | fail | `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-o3wIsz` |
| 2026-09-26T01:10:49.802Z | goal-cli | fail | `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-iqkbb2` |

两次的 `test-results/voice-trim-the-voice-path--95e1c-rimmed-upload-one-at-a-time/error-context.md` 原文（两个目录都在盘上，可直接复核）：

- `o3wIsz`：
  ```
  Test timeout of 35000ms exceeded.
  Error: locator.click: Target page, context or browser has been closed
  Call log:
    - waiting for getByRole('button', { name: /^voice-trim-workspace/ }).first()
  ```
  死在 `expandProject()` —— 侧栏还没渲染出该工程行。
- `iqkbb2`：
  ```
  Test timeout of 35000ms exceeded.
  Error: locator.click: Target page, context or browser has been closed
  Call log:
    - waiting for getByRole('button', { name: 'Stop recording' })
  ```
  死在 `recordOnce()`。失败时刻的 page snapshot 里 composer 已渲染、语音按钮仍叫 `Voice input`（录音不在进行中），而那两行 AC-122 专属文字（`[voice-replay]`、`the recording slot offers no replay of the trimmed upload`）**不在**这次失败里。

**两次都没有触到 AC-122 四条断言中的任何一条。** 台账 `reason` 里那串 `[WebServer] No .env file found…` / `[BABEL] … deoptimised the styling … /vite-cache/deps/react-scan.js` 只是 stderr 尾巴，不是失败原因。

### 机制：装配与判据共用同一个 35s 预算，且装配阶段没有署名

`e2e/voice-trim.spec.ts:1112` 的 `test.setTimeout(35_000)` 是**整条腿**的预算，它同时覆盖：

1. 文件共享装配：`page.goto` → `expandProject()` → `sessionLink().click()` → composer 渲染（`openComposer` 自带 15s 预算）；
2. 判据自己的录音与回放：`recordOnce()`（`Voice input` → `Stop recording` 的 start→stop 往返）到四条断言。

于是「装配被宿主并发饿死」与「双回放保证破了」在**退出码与失败行上同形**：都是退出 `1` 加一个裸的 `Test timeout of 35000ms exceeded.`。`the recording slot offers no replay of the trimmed upload` 是这条判据唯一能给「回放没了」署名的句子，而它只在装配成功之后才可能被读到 —— 装配一红，判据连说话的机会都没有。

### 已经修过的共享资源（只作溯源，本任务不重做）

<!-- dedup-ref --> 这条判据是同一族缺陷的第 N 次显形；前几次各自点名并移走了一个共享资源。下面只作溯源，不构成任何关系：`gap-e2e-hardcoded-ports-collide`（done，端口按运行从内核取一对并在启动前探测）、`gap-e2e-data-dir-lands-on-a-full-root-fs`（done，data dir 按可用空间选点、不够则拒绝启动）、`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（done，`VITE_CACHE_DIR` 指到本运行自己的目录）。这三处今天都在生效 —— 失败目录里并存着 `vite-cache/`、`[e2e] data-dir=… free-bytes=… min-free-bytes=…` 与 `[e2e] server=… client=…` 三行读数就是它们。**判据仍然红，说明被点名的资源不是这一类里剩下的那一个。**

### 本任务的候选机制（必须由复现点名，不许先验写死）

per-run cache 的代价是它**每一次运行都是冷的**：浏览器第一次 `page.goto` 时才触发 esbuild 现做一次依赖预打包 —— 失败目录里 `vite-cache/deps/react-scan.js` 的存在、以及每次运行都出现的 `[WebServer] [BABEL] Note: The code generator has deoptimised the styling of …/vite-cache/deps/react-scan.js`，都是这件事的痕迹。并发 N 份 e2e 同时从冷 cache 起步 ⇒ N 份预打包争 CPU ⇒ 首次页面加载被推过预算，而失败落在装配阶段，没有任何判据专属文字可署名。

**这是候选，不是结论。** S1 的复现必须先把它证实或证伪；若复现点名的是别的资源，就修那一个，并在完成记录里写明本段被证伪。

### 边界（不做）

不削弱 AC-122：四条断言逐字不动（`data-clip-url` 两源、容器/字节/时长、互斥的 `window.Audio` 注册表读法），`the recording slot offers no replay of the trimmed upload` 与 `the recording and the trimmed audio were sounding at once` 两句各保留 1 处；**不抬高** `test.setTimeout(35_000)`，也不抬高 goal gate 的 60s 上限（60s 在本环境是不可抬的硬上限，抬它只会把一次可署名的红换成不可归因的看门狗杀）。不改 `src/modules/chat/**`、`shared/asr/**`、`src/shared/api.ts`、`src/shared/types.ts`。不改其它 spec 的判据。不引入第二份回放实现。

## Plan

- **S0 基线**：`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 三次，记命令 + 退出码 + `[voice-replay]` 行；把上面两份 `error-context.md` 抄进完成记录（先确认两个目录还在盘上；若已被回收，写明并改用本轮自己的复现原文）。
- **S1 复现（承重）**：在宿主并发下把这条腿红出来。建议两条路：`K` 份同命令并发（`K` 从 2 起逐步加，上限是不把宿主压到 `load average > nproc`），或与 `scripts/test.sh` 的全量套件同时跑。直到复现出一次 `Test timeout of 35000ms exceeded`，记下：失败时刻的 `error-context.md` 原文、当时还在跑的进程与 `load average`、`vite-cache/deps/` 里被预打包的文件与时间戳。**没有复现就没有归因** —— 复现不出来时不许按候选机制直接改。
- **S2 点名 + 修**：由 S1 的复现点名剩下的那个资源，并按本族纪律**移走它**（不改任何人的预算、不放宽任何断言）。若复现指向冷 cache 预打包：把「浏览器第一次加载之前依赖预打包必须已完成」做成有界、可署名的一步 —— 新增 `scripts/e2e-assembly-budget.mjs` 承载决策（给定候选预热目标与预算，返回要预热什么、或一条拒绝理由），`playwright.config.ts` 只调用它，在 `webServer` 起好后、用例开始前完成预热；超出预算则点名是哪个目标超了、超了多少。预热读数必须能被外部复核（打印预热对象、耗时、判定）。
- **S3 单价（纯函数面）**：`scripts/e2e-assembly-budget.test.mjs`（`node --test`）覆盖四件：从没预热过 ⇒ 给出预热目标；已在预算内完成 ⇒ 不重复预热；预热本身超界 ⇒ 给出拒绝理由与超界的目标；显式给出的目标不被覆盖。
- **S4 取假**：把 S2 的改动整条还原 ⇒ S1 的复现必须重新红成 `Test timeout`。⚠️ 已提交的改动 `git stash` 是空操作 —— 用 `git checkout <SHA> -- <paths>`（或 `git stash push -- <paths>` 后核对 `git stash list` 真的多了一条）。随后还原，`git status --porcelain` 只剩本任务文件。
- **S5 复核**：`git diff --name-only $(git merge-base HEAD develop)..HEAD` 只落在 Touches 内；四条断言与两句专属文字、`setTimeout(35_000)`、60s 上限的 `grep -c` 读数。

## AC

- [x] AC1 基线三条原文：`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 三次各自退出 `0`、输出含 `[voice-replay] original=…s/…B trimmed=…s/…B` 与 `1 passed`；三条命令 + 退出码 + 关键行进 DoD。同时把 `quay-e2e-o3wIsz` / `quay-e2e-iqkbb2` 两份 `error-context.md` 的原文（或它们已被回收的读数）记进 DoD。
- [x] AC2 复现：在宿主并发下把这条腿红出至少一次 `Test timeout of 35000ms exceeded`，且失败时刻的 `error-context.md` 里**不含** `the recording slot offers no replay of the trimmed upload` 与 `[voice-replay]`（即红在装配阶段、不在 AC-122 的断言上）。复现命令、并发度、当时 `load average`、失败目录路径与 `error-context.md` 原文进 DoD。
- [x] AC3 点名：写出 S1 复现点名的那个共享资源，以及它如何被移走。若点名的是冷 cache 预打包，须给出「预热前 / 预热后」在同一并发度下首次页面加载耗时与整条腿耗时的对照读数，且预热后不再复现 AC2。若复现点名的是别的资源，写下本 Proposal 里那段候选机制被证伪。
- [x] AC4 修后终态：AC2 的同一复现命令、同一并发度，连跑 `N >= 3` 次**全部退出 0**（每次都有 `[voice-replay]` 行）；原文与退出码进 DoD。
- [x] AC5 取假（承重）：把 S2 的改动还原 ⇒ AC2 的复现重新红（退出 `1`、`Test timeout`），原文与退出码进 DoD；随后还原，`git status --porcelain` 只剩本任务文件。
- [x] AC6 判据未被削弱、预算未被抬高：`grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` → `1`；`grep -c "the recording and the trimmed audio were sounding at once" e2e/voice-trim.spec.ts` → `1`；`grep -c "setTimeout(35_000)" e2e/voice-trim.spec.ts` → 与本任务分叉点（develop）**同为 `3`**（数值未变）；⚠️ 原文此处写 `1`，是不可达快照：该字面量在 develop 上就是 `3`（AC-119 第 738 行、AC-120 第 831 行、AC-122 第 1108 行三条同级腿共用），而本任务逐字未改 `e2e/voice-trim.spec.ts`，故按作者自注的「数值未变」把这一处收窄到它守护的不变量（判据未被削弱、预算未被抬高），该不变量由紧随其后的 diff 读数承担；审阅者可以还原此行；`git diff $(git merge-base HEAD develop)..HEAD -- e2e/voice-trim.spec.ts playwright.config.ts | grep -cE '^\+.*(60_000|35_000)'` → `0`；`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` → `0`；`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^src/modules/chat/'` → `0`。
- [x] AC7 `npm run typecheck` 退出 `0`；`npm run lint` 退出 `0`；`node --test scripts/e2e-assembly-budget.test.mjs` 退出 `0`（用例数进 DoD）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-122 在 `.quay/gate-events.jsonl` 的尾巴由 `2026-09-26T01:10:49.802Z` 的 fail 转回 pass，并连续两轮不再翻回。
- **真落地**：不是「多加了一句提示」，而是**被点名的那个资源真的不再被共享/争用**。承重证据是 AC5 —— 把它还原，AC2 的复现必须重新红。
- **归因如实**：本判据今日两次 fail 的机制（装配阶段超时、未触到任何 AC-122 断言）与两份 `error-context.md` 原文进完成记录；并写明本次红**不是** `gap-voice-clip-dual-playback` / `gap-voice-dual-replay-absent-under-shipped-recogniser` 的修复失效（AC1 的三条现场绿读数就是它们仍在的证据）。
- **若复现证伪了候选机制**：如实登记，写明实际点名的资源与修法；不许把候选机制当成已证实写进完成记录。
- **读数原文**：AC1 三条、AC2 一条、AC3 对照两条、AC4 `N` 条、AC5 一条 —— 命令 + 退出码 + 关键输出行。
- **L_D 该轴仍暗，理由**：本任务只改测量侧的装配与归因，不新增领域数据能力，没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 读数是装配耗时、并发度与拒绝行为，不是生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。
- **scoped 门**：`bash scripts/test.sh --for-task gap-ac122-shared-assembly-starves-leg-budget --allow-thin` 的退出码与 `suite-scope-check` 行进完成记录；若因 Touches 里的 `*.test.*` 是 `.mjs` 而落在 thin 分支，如实登记（本族前例同形，scoped 文件集的正则不含 `.mjs`）。

## Touches

- playwright.config.ts
- scripts/e2e-assembly-budget.mjs
- scripts/e2e-assembly-budget.test.mjs
- e2e/voice-trim.spec.ts
- tasks/gap-ac122-shared-assembly-starves-leg-budget.md

## 完成记录
**第 3 轮（续做 + 重退）**：实现仍是上一轮落地的 `092857e2`（`playwright.config.ts` / `scripts/e2e-assembly-budget.mjs` / `scripts/e2e-assembly-budget.test.mjs`，`+552 / -1`），本轮**净改动为零**（唯一的写入是按 Plan S4 把 `playwright.config.ts` 还原取假、再还原，见 AC5；`git diff HEAD -- playwright.config.ts` 为空）。本轮补上上一轮登记为「欠账」的 AC2–AC5 承重读数，并把两次 suite 红归因出去。

### 一、那次 suite 红的归因（本轮的首要交付）

上一次 `exited-not-landed` 的判词是 `step=suite: __PERFILE__ duration_ms=3145 server/modules/providers/tests/model-config-write-path.test.ts passed=false end_ms=1790387333503`（= `2026-09-26T01:48:53Z`）。三条读数说明它不是本 delta：

1. **在日志内即可排除**：`…1790387301864-d9013c.log` 里本任务的两个门内判读为 `__PERFILE__ duration_ms=11440 typecheck passed=true` 与 `__PERFILE__ duration_ms=7975 lint passed=true`；本任务 delta 的三个文件（`playwright.config.ts`、两个 `scripts/e2e-assembly-budget*.mjs`）都不是套件测试文件，在该日志里**没有** `__PERFILE__` 行（`grep -nE 'assembly-budget|playwright\.config|voice-trim'` 命中 0）。`git diff --name-only $(git merge-base HEAD develop)..HEAD` 恰为那三个文件。
2. **独立复跑绿**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-config-write-path.test.ts` → `exit 0`、`ℹ tests 5 / pass 5 / fail 0`、`duration_ms 1649`。
3. **形状是该文件的已知抽签**：该文件第 37 行 `app.listen(0, '127.0.0.1')` 取临时端口、第 50 行起 `fetch`；日志里是 `__PERFILE_KIND__ … kind=assert` + **文件级** `not ok - <file>:   [TypeError: fetch failed] {`（消息槽不是断言，且被固定宽度截断）。机制：undici 有一份 18 个端口的硬黑名单（本机 `/proc/sys/net/ipv4/ip_local_port_range` = `1024 65535`，18 个全部可达），每次 `listen(0)` 约 `18/64512` 命中，命中即在开 socket 之前抛 `fetch failed`。上一轮的同类红落在**另一个**文件（`server/modules/file-tree/tests/file-tree.routes.test.ts`、`652ms`、同样的 `[TypeError: fetch failed]`）：**两次点名不同文件**正是这条随机通道的指纹，不是本 delta 的。

逃逸按本族纪律是**重新派发**：不重实现、不改那个文件（它在本任务 `## Touches` 之外，改它会触发 anti-drift 硬失败）。driver 的 `prior exited-not-landed attempts` 列表是每轮重新拼装的常量字符串，「同样理由两次」不等于「确定性」。

### 二、AC1 基线（本轮现跑）

`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 连跑 3 次，退出码 `0 / 0 / 0`，每次关键行同形：

```
[voice-replay] original=2.640s/17416B trimmed=1.850s/177644B (the trimmed replay is the larger body: PCM WAV against the recorder's opus)
```

收尾 `1 passed (24.6s)` / `1 passed (18.3s)` / `1 passed (18.5s)`。台账两次 fail 的运行目录本轮复核**仍在盘上**，`error-context.md` 原文与 Proposal 引文一致（此处不重录）：`quay-e2e-o3wIsz` 死在 `expandProject()`（`waiting for getByRole('button', { name: /^voice-trim-workspace/ }).first()`）、`quay-e2e-iqkbb2` 死在 `recordOnce()`（`waiting for getByRole('button', { name: 'Stop recording' })`），两份都只有裸的 `Test timeout of 35000ms exceeded.`。

### 三、AC2 / AC5 复现与取假（同一批实验）

复现做法：把 S2 还原（`git checkout HEAD^2 -- playwright.config.ts`，`planAssembly` 计数 `2→0`，`git status --porcelain` = `M playwright.config.ts`），然后**同一命令、并发度 6、`TMPDIR` 未设**，在 load average `12.97`（128 核）下跑一批：

| run | 退出 | 腿时长 | 失败原因 |
|---|---|---|---|
| 1 | 1 | 14.8s | `Error: the recording never started sounding` |
| 2 | 1 | 4.9s | `Error: page.goto: Target page, context or browser has been closed` |
| 3 | **1** | **35.0s** | **`Test timeout of 35000ms exceeded.`** |
| 4 | 0 | 9.2s | —（绿） |
| 5 | **1** | **35.0s** | **`Test timeout of 35000ms exceeded.`** |
| 6 | 1 | 14.8s | `Error: the recording never started sounding` |

整批 wall `47s`，**5/6 红**。AC2 点名的两条（run3 / run5）：

- run3（`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-K0WfJE/test-results/voice-trim-the-voice-path--95e1c-rimmed-upload-one-at-a-time/error-context.md`）：`Test timeout of 35000ms exceeded.` / `Error: locator.click: Target page, context or browser has been closed` / `- waiting for getByRole('button', { name: /^voice-trim-workspace/ }).first()`；该文件里 `the recording slot offers no replay of the trimmed upload` 计数 **0**、`[voice-replay]` 计数 **0**。
- run5（`…/quay-e2e-dX7XFn/…`）：同形，两个计数同为 **0**。

**如实登记一处**：run1 / run6 的 `error-context.md` 里那两句面的计数各为 `1` —— 但那是 Playwright 打印的**源码 code frame**（`1145 | 'the recording slot offers no replay of the trimmed upload: the trim happened and cannot be heard',` 与 `1173 | \`[voice-replay] original=…\``），它们的失败原因写的是 `Error: the recording never started sounding`。所以 AC2 的「error-context 不含该判据文字」由 run3 / run5 承担，**不**由 run1 / run6 承担。

**AC5 取假**：上表即取假读数（还原 ⇒ 退出 `1` + `Test timeout`，run3 / run5）。随后还原：`git checkout HEAD -- playwright.config.ts` → `planAssembly` 计数回到 `2`、`git diff HEAD -- playwright.config.ts` 为空、`git status --porcelain` 为空。

### 四、AC3 点名（Proposal 的候选机制被证伪）与「预热前 / 预热后」对照

复现点名的资源**不是** Proposal 里的候选（per-run 冷 cache 的 vite 依赖预打包）—— **该候选被证伪**：per-run `VITE_CACHE_DIR` 与 per-run data dir 这两处前序修复在本轮全程在位（每份失败目录里都并存 `vite-cache/`、`[e2e] data-dir=… free-bytes=…`、`[e2e] server=… client=…` 三行），而 S2 一还原就 5/6 红。

真正被点名的是**共享根文件系统上的 scratch**：Chromium 的 user-data 目录、`tsx` 的 transform cache、Node 的 compile cache、Playwright 自己的 transform cache 都建在 `os.tmpdir()` 下，而 `os.tmpdir()` 读 `TMPDIR`，driver 的环境里 `TMPDIR` 未设 ⇒ 它们全部落在 `/`（`/dev/vda2`，`50G`，舰队共用）上。判据整条腿只有 35s 预算（装配 + 录音 + 四条断言共用），共用的根文件系统被舰队压住时首次页面加载就超出它，失败落在装配阶段、没有任何判据文字可署名。S2 把每份运行的 scratch 指到**该运行自己的** data dir 内（已在选点时挑过余量、在 `/data` 这个 4TB 卷上），并在预算内（`DEFAULT_ASSEMBLY_BUDGET_MS = 35_000`，不高于它守护的那条腿）完成准备，超界则点名是哪个目标超了、超了多少。

同一命令、同一并发度（6）的「预热前 / 预热后」对照：

| 状态 | 批次 | wall | 每条腿时长（6 条） | 结果 |
|---|---|---|---|---|
| 预热前（S2 还原） | revert-before | 47s | 35.0 / 35.0 / 14.8 / 14.8 / 9.2 / 4.9 | **5/6 红** |
| 预热后（S2 在位） | fix-b1 | 21s | 9.2 / 9.3 / 9.2 / 9.2 / 9.3 / 9.2 | 6/6 绿 |
| 预热后 | fix-b2 | 21s | 9.2 / 9.4 / 9.3 / 9.2 / 9.4 / 9.2 | 6/6 绿 |
| 预热后 | fix-b3 | 23s | 9.7 / 10.3 / 10.8 / 9.4 / 9.4 / 9.4 | 6/6 绿 |

修复侧自己的装配读数（每份运行的 config 打印，可外部复核），18 份里 `elapsed-ms ∈ {0, 1}`：

```
[e2e] assembly-scratch=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-<id>/tmp prepared=now elapsed-ms=0 available-bytes=3824567836672
```

⚠️ **如实说明**：「首次页面加载耗时」没有被单独 instrumentation —— AC6 禁止改动 `e2e/voice-trim.spec.ts`（该文件本轮逐字未改），所以上表以**整条腿时长**（红 4.9–35.0s vs 绿 9.2–10.8s）与**装配步的 `elapsed-ms`** 作为上界读数，没有更细的页面加载计时。

### 五、AC4 修后终态

AC2 的同一命令、同一并发度（6），`N = 3` 批 → **18/18 退出 `0`**，每一份都打印 `[voice-replay] original=2.640s/17416B trimmed=1.850s/177644B`（见上表）。

### 六、AC6 / AC7 读数

- `grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` → `1`
- `grep -c "the recording and the trimmed audio were sounding at once" e2e/voice-trim.spec.ts` → `1`
- `grep -c "setTimeout(35_000)" e2e/voice-trim.spec.ts` → `3`（`git show develop:e2e/voice-trim.spec.ts | grep -c` 同为 `3`，数值未变；本任务对该文件 `git diff --stat $(git merge-base HEAD develop)..HEAD` 为空 = 逐字未改）
- `git diff $(git merge-base HEAD develop)..HEAD -- e2e/voice-trim.spec.ts playwright.config.ts | grep -cE '^\+.*(60_000|35_000)'` → `0`
- `git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` → `0`；`… | grep -c '^src/modules/chat/'` → `0`
- `node --test scripts/e2e-assembly-budget.test.mjs` → 退出 `0`、`ℹ tests 6 / pass 6 / fail 0`（`duration_ms 45.8`）
- `npm run typecheck` → 退出 `0`；`npm run lint` → 退出 `0`（只有既有 oxlint warning，无一条落在本任务文件上）

### 七、L_D / L_G

两条轴仍暗，理由同 DoD：本任务只改测量侧的装配与归因（`playwright.config.ts` 调用预热决策 + `scripts/` 两个文件），不新增领域数据能力，也不读生成质量轴 —— 读数是预热对象、耗时、判定、并发度与退出码，没有可读出的领域数据轴或生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。

### 八、本轮的边界与门读数

Touches 段与实现均未扩：`git diff --name-only $(git merge-base HEAD develop)..HEAD` 仍恰为 `playwright.config.ts` / `scripts/e2e-assembly-budget.mjs` / `scripts/e2e-assembly-budget.test.mjs` 三个文件。scoped 门 `bash scripts/test.sh --for-task gap-ac122-shared-assembly-starves-leg-budget --allow-thin` → 退出 `0`，`suite-scope-check: PASS — 15 active task(s) scanned`；文件集走 thin 分支（`no scoped test files for gap-ac122-shared-assembly-starves-leg-budget (thin)`）—— 本任务 Touches 段里的 `*.test.*` 是 `.mjs`，scoped 文件集正则不含 `.mjs`，本族前例同形。
## Needs-Human

**执行 2026-09-26T01:51:03.955Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=3145 server/modules/providers/tests/model-config-write-path.test.ts passed=false end_ms=1790387333503
- run_id：wk-prod-anchor
- session_id：2f3f2d07-fb4b-4c3f-b61b-c3ce00816110
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac122-shared-assembly-starves-leg-budget~wk-prod-anchor~1790387301864-d9013c.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac122-shared-assembly-starves-leg-budget-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-26T02:17:34.689Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-sessions.test.ts:   AssertionError [ERR_ASSERTION]: open-a.jsonl was opened by a scan that should have skipped it
- run_id：wk-prod-anchor
- session_id：239b7b85-6261-44c0-9734-b546546173c0
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac122-shared-assembly-starves-leg-budget~wk-prod-anchor~1790388878653-138691.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac122-shared-assembly-starves-leg-budget-wk-prod-anchor.log


### 九、第 4 轮（续做）：上一次 suite 红的归因，以及本轮的零改动

本轮**实现零改动**：分支上的实现仍是第 3 轮的三个文件（`git diff --name-only $(git merge-base HEAD develop)..HEAD` 恰为 `playwright.config.ts` / `scripts/e2e-assembly-budget.mjs` / `scripts/e2e-assembly-budget.test.mjs`，`+552 / -1`）。`git status --porcelain` 为空。本轮唯一的写入是把 develop（领先 38 个提交）并入本分支（无冲突）与本节记录。

上一次 `exited-not-landed` 的判词是 `step=suite: not ok - server/modules/providers/tests/claude-sessions.test.ts:   AssertionError [ERR_ASSERTION]: open-a.jsonl was opened by a scan that should have skipped it`（suite 日志 `…1790388878653-138691.log`，该文件 `duration_ms=10126`、`__PERFILE_KIND__ … kind=assert`）。**这条红不在本 delta 上**，四条读数：

1. **被判红的文件在本分支上与 develop 逐字相同**：`git diff develop HEAD -- server/modules/providers/tests/claude-sessions.test.ts` 为空（本分支连把它列进 Touches 都没有）。
2. **本 delta 的三个文件全套件都不会被加载**：server 车道的收集式是 `find server -name '*.test.ts' -o -name '*.test.js'`（`scripts/test.sh:486`），两个 `scripts/*.mjs` 不在其中 —— 判红那份日志的 237 条 `__PERFILE__` 里没有一条 `scripts/`。而 `playwright.config.ts` 只被 playwright 加载：`grep -n playwright scripts/test.sh` 命中 0，所以本任务那行 `process.env.TMPDIR = assemblyTarget` 在套件里**根本没有执行路径**。
3. **同一份日志里本任务自己的两道门是绿的**：`__PERFILE__ duration_ms=11639 typecheck passed=true`、`__PERFILE__ duration_ms=8027 lint passed=true`。
4. **被判红的文件在本分支上 37 次连跑全绿**：3 次单跑（退出 `0 / 0 / 0`，`ℹ tests 26 / pass 26 / fail 0`，`duration_ms 5574`）；10 份**同文件并发**（退出 `0` ×10）；3 轮 × 8 个同车道邻居并发（`claude-session-scope` / `session-orphan-prune` / `sessions-watcher-mode` / `session-rename-writeback` / `codex-sessions` / `opencode-sessions` + 两个本舰队公认的负载发生器 `voice-capture-text.false-forms`），共 24 份退出 `0`，loadavg 27–39，`grep -c "was opened by a scan that should have skipped it"` 在每个输出里都是 `0`。**37/37 无一次复现。**

**被点名的机制（已定位，未证实）**：那条断言守的是「游标排除的 transcript 不许被打开」，而 develop 上确有一条**无视游标**的读取通道 —— `ClaudeSessionSynchronizer.synchronize()` 第一步无条件调 `backfillLastActivity()`（`server/modules/providers/list/claude/claude-session-synchronizer.provider.ts:248`），它按 `sessionsDb.getSessionsWithTranscriptPath()`（同文件 `:341-342`）**逐行读取每一个已入库 transcript**，唯一的闸门是一枚一次性 `app_config` 标记 `claude_last_activity_backfill_v1`（`:335-338`）。而这枚闸门是 **fail-open** 的：`appConfigDb.get()` 吞掉一切异常并返回 `null`（`server/modules/database/repositories/app-config.ts:26-29`，注释自陈"Swallow errors so early-startup reads … do not crash"）。于是一次瞬态的 DB 读错误就足以让这个 pass 在下一次 `synchronize()` 时重跑、把那 4 个被游标排除的文件重新读一遍 ⇒ atime 移动 ⇒ 退出码不变、`synchronize(cursor)` 仍返回 `0`、而唯一的署名句恰好是那句 `open-a.jsonl was opened by a scan that should have skipped it`。该测试之所以平时能过，只是因为它的第一次 `synchronize()` 已经把标记写下了。

⚠️ **如实登记**：我没能观察到那次被吞掉的 DB 错误，因此这是**已定位的候选机制**（fail-open 通道经代码复核确认），不是已证实的根因。它所在的文件在本任务 `## Touches` 之外（随 `e7534bcc` 于 2026-09-22 落地，属 `gap-session-lastactivity-from-file-mtime`），按本族纪律**逃逸是重新派发**：不重实现、不改那个文件（改它会触发 anti-drift 硬失败）。另按 `[fan-in suite red]` 族的指纹，被判红的文件集每一轮都不同（本任务三轮分别是 `file-tree.routes` → `model-config-write-path` → `claude-sessions`），这也是它不是本 delta 的证据。

**本轮门读数**：`bash scripts/test.sh --for-task gap-ac122-shared-assembly-starves-leg-budget --allow-thin` 见本节随后的登记（第 3 轮同命令退出 `0`、`suite-scope-check: PASS — 15 active task(s) scanned`、文件集走 thin 分支）。`quay task check` → `ok:true, acTotal 7, acChecked 7`。


### 十、第 4 轮读数（全部在合并 develop 之后的树上重测）

承第九节末的登记。本轮已把 develop（领先 38 个提交）并入本分支且无冲突；合并后 `git merge-base HEAD develop` = `ac467188`，`git diff --name-only $(git merge-base HEAD develop)..HEAD` 仍**恰为**三个文件（`playwright.config.ts` / `scripts/e2e-assembly-budget.mjs` / `scripts/e2e-assembly-budget.test.mjs`，`+552 / -1`）。

- **AC1（重测）**：`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 连跑 3 次 → 退出 `0 / 0 / 0`，每条都打印 `[voice-replay] original=2.640s/17416B trimmed=1.850s/177644B (the trimmed replay is the larger body: PCM WAV against the recorder's opus)`，收尾分别是 `1 passed (19.0s) / (18.8s) / (18.6s)`，三份的 `[e2e] data-dir=` 各是自己的一份（`quay-e2e-6touPl` / `PBRbOR` / `xAc2ly`）。
- **AC4（重测）**：AC2 的同一命令、同一并发度（6）一批 → **6/6 退出 `0`**，batch wall `21s`，6 条腿 `1 passed (20.1 / 19.7 / 19.7 / 20.1 / 19.7 / 19.6s)`，每份都有 `[voice-replay]` 行（其中一份 `original=2.640s/17734B` —— 录制体字节随录音抖动，不是异常）。loadavg `17.7 → 21.9`（128 核）。第 3 轮同项为 `N = 3` 批 18/18 绿，本轮为合并后的一批 6/6 绿。
- **修复在合并后的树上仍在生效**（每份运行自己的 config 打印，可外部复核）：`[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-<id> free-bytes=… min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)` 与 `[e2e] assembly-scratch=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-<id>/tmp prepared=now elapsed-ms=0 available-bytes=…`；同一份运行第二次求值时打印 `prepared=already` —— 即 worker 继承 `TMPDIR`、靠预热留下的探针文件判定「已备好」，这是修复自己声明的「重复求值免费」行为，在合并后的树上逐字复现。
- **AC6（重测）**：`grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` → `1`；`grep -c "the recording and the trimmed audio were sounding at once"` → `1`；`grep -c "setTimeout(35_000)" e2e/voice-trim.spec.ts` → `3`，`git show develop:e2e/voice-trim.spec.ts | grep -c "setTimeout(35_000)"` → `3`（数值未变）；`git diff $(git merge-base HEAD develop)..HEAD -- e2e/voice-trim.spec.ts playwright.config.ts | grep -cE '^\+.*(60_000|35_000)'` → `0`；`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` → `0`、`… | grep -c '^src/modules/chat/'` → `0`；`git diff --stat develop HEAD -- e2e/voice-trim.spec.ts` 为空（该文件在合并后的树上仍与 develop 逐字相同）。
- **AC7（重测）**：`npm run typecheck` → 退出 `0`；`npm run lint` → 退出 `0`（只有既有 oxlint warning，无一条落在本任务文件上）；`node --test scripts/e2e-assembly-budget.test.mjs` → 退出 `0`、`ℹ tests 6 / pass 6 / fail 0`（`duration_ms 63.9`）。
- **scoped 门（本轮，合并后）**：`bash scripts/test.sh --for-task gap-ac122-shared-assembly-starves-leg-budget --allow-thin` → 退出 `0`；`suite-scope-check: scan tasks=205 skipped(done/superseded)=191 active=14 with-tests=10 no-tests=4` 与 `suite-scope-check: PASS — 14 active task(s) scanned: every active task whose ## Touches lists *.test.* carries --for-task in its ## AC self-test … (line 101 < stage line 428)`；随后 `no scoped test files for gap-ac122-shared-assembly-starves-leg-budget (thin)` —— 与第 3 轮同形：Touches 段里的 `*.test.*` 是 `.mjs`，而 scoped 文件集的正则不含 `.mjs`（本族前例同形）。
- **scoped 门缓存**：`worker-driver.js --write-scoped-gate-cache --task gap-ac122-shared-assembly-starves-leg-budget --develop-sha "$(git rev-parse develop)" --root …` → `{"event":"scoped-gate-cache-written", …}`，写入 `.quay/scoped-gate-cache.json`。
- **`quay task check`** → `ok:true, acTotal 7, acChecked 7`；7 条 AC 在本轮逐条复核后全部保持 `- [x]`，**未翻动任何一条**（实现零改动，读数只是重测）。


判据退役登记（2026-10-04，人 yale 授权，见 tasks/gap-voice-single-continuous-input-path.md 的 Resolution）：本任务 AC1 与 AC4 的判据都点名 `env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"`，该腿随 AC-122 一同退役，判据命令必然 No tests found；AC6 里对该 spec 的三处 grep 读数（the recording slot offers no replay of the trimmed upload 等）同样随被删的腿归零 —— 这些红都不是本任务修复失效，不得据此回退。本任务修好的装配预算缺陷继续独立可测：AC7 的 `node --test scripts/e2e-assembly-budget.test.mjs` 与 playwright.config.ts 的装配预算不受影响。明示不再覆盖：该腿不再存在，其基线/复现/取假读数不再被重跑。