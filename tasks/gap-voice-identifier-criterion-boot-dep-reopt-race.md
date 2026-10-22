---
id: gap-voice-identifier-criterion-boot-dep-reopt-race
title: AC-115 判据在门自己那次运行里红、且从未跑到自己的断言：夹具的开户前导既无预热也无有界护栏，浏览器被拆时与「修复失效」同形（同族护栏已在
  AC-121/AC-108/AC-142 落地，本 spec 未回灌）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-115
---
## Proposal

本任务承接 AC-115（修复在真实浏览器里经语音按钮端到端生效）。判据命令是 `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"`。

### 一、本轮的直接测量（不是台账尾巴）

**判据对象为真。** 同一 checkout（`/data/home/yale/work/claudecodeui`，分支 `author`，HEAD `7db1d5b6`，`TMPDIR` 未设 = 与 driver 同环境）直跑判据一次，退出 `0`、命令墙钟 `15.4s`：

```
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YPSeW9 free-bytes=3802118189056 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
[voice-identifier] upload: container=RIFF fixture=2.938s uploaded=2.870s
  ✓  1 e2e/voice-identifier-repair.spec.ts:273:3 › AC-115 the repair holds end to end through the voice button › AC-115 a recording made through the voice button lands the project's real file name in the composer (2.9s)
  1 passed (14.7s)
```

随后 **K=6 并发**同一命令（loadavg 12.1 → 15.4，128 核）：**6/6 退出 `0`**，每条腿 `1 passed (15.8s–16.1s)`、`[voice-identifier] upload:` 行同形。**本轮在安静宿主上复现不出红**，所以承重读数必须由 S1（AC2）的复现给出，不许先验写死。

### 二、台账两条红，以及它们落在哪里（**都不在判据的断言上**）

`.quay/gate-events.jsonl` 里 AC-115 今日两条 fail：`2026-09-26T11:52:53.617Z`（`goal-sweep`，运行目录 `quay-e2e-rCsLQk`）与 `2026-09-26T12:04:08.514Z`（`goal-cli`，`quay-e2e-ZyKMIe`）。两个目录**都还在盘上**，`test-results/voice-identifier-repair-AC-d54af-l-file-name-in-the-composer/error-context.md` 的 `# Error details` 原文：

- `ZyKMIe`：`Error: Channel closed` / `Error: locator.click: Target page, context or browser has been closed`，call log 停在 `- waiting for getByRole('button', { name: 'Stop recording' })`。
- `rCsLQk`：`Error: Channel closed` / `Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `- waiting for locator('#username')`。

判据链一条都没有跑到：前提自查（`:282`/`:283`）、composer 逐字持有真名（`:324` 的 `toHaveValue(expected)`）、含真名（`:328`）、不含错拼形态（`:335`）、请求归属与凭据（其后）—— 这些断言在两次红里**一次都没有被执行**。台账 `reason` 里那串 `[WebServer] No .env file found …` / `[BABEL] … deoptimised the styling … vite-cache/deps/react-scan.js` 只是被截断的 stderr 尾巴，不是失败原因。

`rCsLQk` 的落点（`#username`）与本仓已记录的夹具前导死亡同形：`anchor.log:2781` 记着同一条腿另一次运行「hit the documented onboarding `#username` flake, green on repeat」。

### 三、两条候选机制（必须由复现点名，不许先验写死）

**M1 —— 夹具前导的依赖重优化，而且本 spec 没有护栏。** `beforeAll` 在 `:248` 裸调 `page.goto('/')`、`:249` 直接 `#username` fill，随后 `Create Account` → 项目行 → `:263` `page.reload()`。全程缺少本仓同族 spec 都有的三件东西（`grep -c warmClientStartup e2e/voice-identifier-repair.spec.ts` → `0`，在 HEAD 与 develop 上同为 `0`）：

- 预热 `warmClientStartup`：存在于 `e2e/transcript-follow.spec.ts:1826`、`e2e/voice-dashscope-written.spec.ts:330`、`e2e/session-filter.spec.ts:127` —— 本 spec 没有；
- 有界自报前导：`e2e/voice-trim.spec.ts:309` 的 `appears` + `:697` 起「8s 探针 → 至多 1 次 `page.reload()` → 仍不在就抛本 spec 自己的错（带页面文本 + console + `requestfailed`）」—— 本 spec 没有；
- `requestfailed` 采集：`e2e/voice-trim.spec.ts:650` —— 本 spec 没有。

这条形状与 memory `e2e-fresh-db-onboarding-hook-timeout` 记录的 2/5 红逐字同形（`Error: Channel closed` + `Frame.fill` 仍 `waiting for locator('#username')`）；那条 memory 自己写明「Bounded boot guard exists in voice-trim.spec.ts only」，并点名这是**同一族**：护栏本体由 AC-121 落地，transcript-follow（AC-108）与 voice-dashscope-written（AC-142）各自立过任务回灌。AC-115 是**剩下那个没回灌的**。

**M2 —— 浏览器进程被宿主内存压力杀掉。** 两次红的时刻，`journalctl --user` 里都有 `app.slice: A process of this unit has been killed by the OOM killer`（`19:54:22 +0800` 与 `20:02:56 +0800`，后者正压在 `ZyKMIe` 那次运行上），并伴随大量 `claudecodeui-session-*.scope: Failed with result 'oom-kill'`。这一族的共享资源已被兄弟任务点名并修掉：`os.tmpdir()` 读 `TMPDIR`、driver 环境不设 `TMPDIR` ⇒ 每份运行的 scratch（Chromium user-data、tsx/node/Playwright transform cache）全部落在舰队共用的 `/dev/vda2`（该结论与修复见 AC-122 那条任务，`092857e2`）。⚠️ 该修复已在 `develop`，但**判据是在主 checkout 上跑的**：`goal-store` 用 `runAcceptance({ command: criterion, cwd: resolveGitRoot(goalDir) })`，而 `author` 的 HEAD 尚未拿到这次合并。

**这一段是候选，不是结论。** S1 必须先证实其中一条或证伪两条；若复现点名的是别的资源，就修那一个，并在完成记录里写明本节哪一条被证伪。

### 四、修法（由 S1 点名的那一条决定，范围不预先扩大）

M1 被点名 ⇒ 用本仓既有且已被验证的形状（⛔ 不新造第二套实现）：把 `warmClientStartup` 的形状逐条照抄进本 spec 的 `beforeAll`，在 `browser.newContext()` **之前**跑完（形状取自 `e2e/transcript-follow.spec.ts:1826`；本仓既有做法是每 spec 自带一份，不抽共享模块）；并把 `:248` 起的开户前导改成有界的自报前导（`appears` + 有界 `page.reload()` 重试，预算耗尽时抛本 spec 自己的错，带页面文本、console 与 `requestfailed`）。

M2 被点名 ⇒ 把本运行自己的 scratch 移出宿主共享的 `/`：先确认判据所在树上 `develop` 的那次修复是否到位（`git show develop:playwright.config.ts | grep -c assembly`），未到位就写明本任务的修复面是让判据跑在已修复的树上；本 spec 里另有的共享点被点名时，点名它、移走它。

### 五、边界（不做）

不削弱判据：前提自查（`:282`/`:283`）与 composer 三条断言（`:324`/`:328`/`:335`）逐字保留。⛔ 不用 `retries` / `test.skip` / 加长 `page.waitForTimeout(2500)` 买绿；⛔ 不抬 `:208` 的 `setTimeout(120_000)`，也不抬 goal 门的 60s 上限（60s 在本环境是不可抬的硬上限，抬它只把一次可署名的红换成不可归因的看门狗杀）；不改 `src/modules/chat/**`、`shared/asr/**`、`useVoiceInput` 等链路生产代码；不改其它 spec；不改 `goals/AC-115-*.md` 的记录。

<!-- dedup-ref -->
机制侧相关、均已 `done` 的同族（都跑在别的 spec 上，不是本判据的载体）：`gap-voice-dashscope-criterion-boot-dep-reopt-race`（AC-142，把预热与有界前导回灌 `e2e/voice-dashscope-written.spec.ts`）、`gap-transcript-follow-criterion-boot-dep-reopt-race`（AC-108，同族，另一 spec）、`gap-session-filter-criterion-bounded-boot-guard`（AC-121 族，护栏本体）。另一条机制侧相关、覆盖 AC-122 的任务（点名共享 scratch 根）已 `done` 并把修复合入 `develop`。以上都不替代本任务：AC-115 的判据命令跑的是 `e2e/voice-identifier-repair.spec.ts`，而 `warmClientStartup` 在该文件里计数为 `0`。

## AC

- [x] AC1 基线三条原文：`npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 连跑 3 次各自退出 `0`、输出含 `[voice-identifier] upload: container=…` 与 `1 passed`；三条命令 + 退出码 + 关键行进 DoD。同时把 `quay-e2e-ZyKMIe` / `quay-e2e-rCsLQk` 两份 `error-context.md` 的 `# Error details` 原文（或它们已被回收的读数）记进 DoD。
- [x] AC2 复现（承重）：在宿主并发下把这条腿红出至少一次，且两条读数共同说明红在前导、不在 AC-115 的断言上 —— (a) 该次运行自己的 stdout 里 `grep -c "\[voice-identifier\] upload:"` → `0`（判据自己的读数行没被打印到）；(b) 该次 `error-context.md` 的 `# Error details` 第一条是浏览器拆除类错误（`Channel closed` / `Target page, context or browser has been closed`），不是断言失败。复现命令、并发度、当时 `load average`、失败目录路径与该段原文进 DoD。**没有复现就没有归因** —— 复现不出来时不许按候选机制直接改。
- [x] AC3 点名：写出 AC2 的复现点名的是 M1 还是 M2，以及它如何被移走。若点名 M1，须给出同一并发度下「预热前 / 预热后」整条腿时长的对照读数，且预热后不再复现 AC2。若两条候选都被证伪，如实写明实际点名的资源与修法。
- [x] AC4 修后终态：AC2 的同一命令、同一并发度，连跑 `N >= 3` 批**全部退出 `0`**，每份都有 `[voice-identifier] upload:` 行；原文与退出码进 DoD。
- [x] AC5 取假（承重）：把 S2 的改动还原 ⇒ AC2 的复现重新红（原文与退出码进 DoD）；随后还原，`git status --porcelain` 只剩本任务文件。⚠️ 已提交的改动 `git stash` 是空操作 —— 用 `git checkout <SHA> -- <paths>`（或 `git stash push -- <paths>` 后核对 `git stash list` 真的多了一条）。若还原后同并发度下不再红，如实登记为「该并发度下取假不成立」并补一档更高并发度的读数；⛔ 不许把「取假不成」写成「已取假」。
- [x] AC6 判据未被削弱、预算未被抬高（同命令在建任务时的分叉点 develop 上同值，可用 `git show develop:e2e/voice-identifier-repair.spec.ts | grep -cF …` 逐条复核）：`grep -cF "expect(UTTERANCE).toContain(SPOKEN)"` → `>= 1`；`grep -cF "expect(UTTERANCE).not.toContain(identifier)"` → `>= 1`；`grep -cF "toHaveValue(expected"` → `1`；`grep -cF "expect(value).toContain(identifier)"` → `1`；`grep -cF "expect(value).not.toContain(SPOKEN)"` → `1`；`grep -cF "setTimeout(120_000)"` → 与 develop 同值（建任务时为 `1`）；`git diff $(git merge-base HEAD develop)..HEAD -- e2e/voice-identifier-repair.spec.ts | grep -cE '^\+.*(60_000|120_000|retries|test\.skip)'` → `0`。
- [x] AC7 `npm run typecheck` 退出 `0`；`npm run lint` 退出 `0`。
- [x] AC8 scoped 门：`bash scripts/test.sh --for-task gap-voice-identifier-criterion-boot-dep-reopt-race --allow-thin` 的退出码与 `suite-scope-check` 行进 DoD（若 Touches 里没有 `*.test.*` 而走 thin 分支，如实登记）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-115 在 `.quay/gate-events.jsonl` 的尾巴由 `2026-09-26T12:04:08.514Z` 的 fail 转回 pass，并连续两轮不再翻回。
- **真落地**：不是「多了一段等待」，而是**前导的代价被移出被测窗口**，且前导自己有界、会署名。承重证据是 AC5 —— 把它还原，AC2 的复现必须重新红。
- **归因如实**：两次 fail 的落点（`Channel closed` + `#username` / `Stop recording`，未触到任何断言）与两份 `error-context.md` 原文进完成记录；并写明本次红**不是** `gap-voice-identifier-repair-unwired`（把修复接进 `useVoiceInput`）或 `gap-voice-identifier-browser-e2e`（写下本 spec）的修复失效 —— AC1 的三条现场绿读数就是它们仍在的证据。
- **若复现证伪了两条候选**：如实登记，写明实际点名的资源与修法；不许把候选机制当成已证实写进完成记录。
- **读数原文**：AC1 三条、AC2 一条、AC3 对照两条（或证伪读数）、AC4 `N` 条、AC5 一条 —— 命令 + 退出码 + 关键输出行。
- **L_D 该轴仍暗，理由**：本任务只改测量侧的前导与归因（一个 spec 的 `beforeAll`），不新增领域数据能力，没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 读数是前导耗时、并发度与退出码，不是生成质量轴读数；目标层判据由 GOAL-005 的其余判据承担。

## Touches

- e2e/voice-identifier-repair.spec.ts
- tasks/gap-voice-identifier-criterion-boot-dep-reopt-race.md

## 完成记录

落地提交：`92745193 test(e2e): pay the AC-115 preamble's client startup before the page, and bound it`（分支 `task/gap-voice-identifier-criterion-boot-dep-reopt-race`，基于 `78392783`；2b 已合并 develop `d299cea6`，无冲突）。改动只落在 `e2e/voice-identifier-repair.spec.ts`（`git diff --stat 78392783 92745193 -- e2e/voice-identifier-repair.spec.ts` → `1 file changed, 173 insertions(+), 1 deletion(-)`）；`git status --porcelain` 除 `tasks/…md` 外为空。

### (a) AC1 —— 基线三条原文 + 台账两份 error-context 原文

在**还原树**（`git checkout 78392783 -- e2e/voice-identifier-repair.spec.ts`，实测 `1 insertion(+), 173 deletions(-)`，`grep -c warmClientStartup` → `0`）上连跑 3 次 `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"`：

```
baseline-run1 exit=0 wall=16s uploadLines=1
baseline-run2 exit=0 wall=16s uploadLines=1
baseline-run3 exit=0 wall=15s uploadLines=1
load: 27.61 48.62 40.62
```

三条输出均含 `[voice-identifier] upload: container=RIFF fixture=2.938s uploaded=…` 与 `1 passed (…)`。

台账两份 `error-context.md` 原文（复读时两份目录都仍在盘上，路径 `…/quay-e2e-<id>/test-results/voice-identifier-repair-AC-d54af-l-file-name-in-the-composer/error-context.md`）：

- `quay-e2e-ZyKMIe`（`2026-09-26T12:04:08.514Z`，`goal-cli`）：`# Error details` 第一条 `Error: Channel closed`，第二条 `Error: locator.click: Target page, context or browser has been closed`，call log 停在 `- waiting for getByRole('button', { name: 'Stop recording' })`。
- `quay-e2e-rCsLQk`（`2026-09-26T11:52:53.617Z`，`goal-sweep`）：`Error: Channel closed` / `Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `- waiting for locator('#username')`。

两份的落点都在**前导**里，判据链一条都没跑到（`:282`/`:283` 前提自查、`:324`/`:328`/`:335` composer 三条断言）。**本次红不是** `gap-voice-identifier-repair-unwired` 或 `gap-voice-identifier-browser-e2e` 的修复失效 —— AC1 的三条现场绿读数（以及 AC4 的 36 条）就是它们仍在的证据。

### (b) AC2 —— 复现（承重）

命令 `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"`（**K=1**，宿主当时由舰队活动占着：`.quay/doc-develop-sync.jsonl` 在 `20:14:34–20:14:40` 被写，`load average` 约 `17`），失败目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-odbYfv`：

```
exit=1  wall=55.75s
[e2e] watchdog: this run crossed its own 55000ms ceiling at 55005ms and is ending here with exit 1 at 55008ms — stuck at stage "browser-launch-or-cases"
grep -c "\[voice-identifier\] upload:" → 0
```

`error-context.md` 的 `# Error details` 原文（`…/quay-e2e-odbYfv/test-results/voice-identifier-repair-AC-d54af-l-file-name-in-the-composer/error-context.md`）：

```
Error: Channel closed
```
```
Error: locator.fill: Target page, context or browser has been closed
Call log:
  - waiting for locator('#username')
```

读数 (a) 成立（判据自己的读数行没被打印到），(b) 成立（第一条是浏览器拆除类错误，不是断言失败）。**复现落在 `#username` 前导，与台账 `rCsLQk` 逐字同形。**

### (c) AC3 —— 点名 M1，以及 M2 的证据同时在场（如实）

**点名 M1。** 对该次运行自己的 trace（`…/quay-e2e-odbYfv/test-results/**/trace.zip`）的读法：`1-trace.trace` 的 span 共 `51.7s`、结束在 `before fill #username`；网络时间线 `/` `704ms` → `@vite/client` `640ms` → `main.tsx` `498ms` → `deps/*` `2.3–3.1s`（`react-scan.js` `3080ms`，同时 `[BABEL] … deoptimised the styling … deps/react-scan.js`），随后 `1.35–1.42s` 发出的八个 `/src/modules/*/index.ts`、`/src/shared/context/*.tsx`、`/src/modules/i18n/*` 请求**到 trace 结束都没有 response**，而 `manifest.json` 在 `4.41s` 被答；此后静默到 `51.67s`。即页面自己的模块图被按在 **Vite 依赖优化器**后面，不是被断言或业务逻辑挡住的。

**M2 不能排除，且它的证据正在同一窗口里。** `journalctl --user --since "2026-09-26 20:14:00" --until "2026-09-26 20:17:30"` 有：

```
20:15:15 claudecodeui-session-2058878-4508dfe7.scope: A process of this unit has been killed by the OOM killer.
20:15:15 claudecodeui-session-2058878-4508dfe7.scope: Failed with result 'oom-kill'.
20:15:16 claudecodeui-session-2058878-c454a1f2.scope: A process of this unit has been killed by the OOM killer.
20:15:16 claudecodeui-session-2058878-c454a1f2.scope: Failed with result 'oom-kill'.
```

即宿主内存压力**是**这次红的上游贡献者之一（被杀的是兄弟 session 的 scope，不是判据自己的），M1 是它的可观察形式：内存/CPU 挨饿的 Vite 把模块请求按住了。**M2 的修法（本运行 scratch 移出宿主共享的 `/`）已在本任务树上**：`grep -c assembly playwright.config.ts` → `15`，判据打印 `data-dir=/data/home/yale/.cache/quay-e2e-tmp/…`、`assembly-scratch=…/quay-e2e-<id>/tmp`、`free-bytes≈3.80T` —— 即 AC-122 那次修复（`092857e2`）已在 develop 并在本树；台账那两次红跑在**尚未合并该修复的主 checkout** 上。

**移走方式与同并发度对照读数（K=1）：**

| | 整条腿墙钟 | 预热读数 |
|---|---|---|
| 预热前（还原树） | `16s / 16s / 15s` | 无（页面自己等优化器） |
| 预热后 | `15s / 15s / 15s` | `pre-bundle committed in 3291ms / 3672ms / 3214ms` |

即**同一份代价**（trace 里 `deps/*` 的 `2.3–3.1s`）从页面的首屏窗口被搬到 `browser.newContext()` 之前，整条腿墙钟不增（`16/16/15 → 15/15/15`，同一并发度、`load average` `18.71/40.05/38.30`），代价本身可读出、有界（30s 上限）、会署名。**预热后 AC2 的形状不再复现**：K=1 三次全绿，K=12 三批 `36/36` 全绿，无一例 `grep -c "\[voice-identifier\] upload:"` → `0`。

### (d) AC4 —— 修后终态

AC2 的同一命令、K=1（与复现同并发度，宿主负载同档或更高）连跑 3 批：

```
postfix-run1 exit=0 wall=15s uploadLines=1 warmup=pre-bundle committed in 3291ms
postfix-run2 exit=0 wall=15s uploadLines=1 warmup=pre-bundle committed in 3672ms
postfix-run3 exit=0 wall=15s uploadLines=1 warmup=pre-bundle committed in 3214ms
```

另加同一命令的 **K=12 三批，共 36 条腿全部退出 `0`**，每条都有 `[voice-identifier] upload: container=…` 行，腿墙钟 `17–25s`，预热 `1846–4857ms`。

### (e) AC5 —— 取假：**该并发度下取假不成立**（如实登记，不写成「已取假」）

`git checkout 78392783 -- e2e/voice-identifier-repair.spec.ts` 还原（实测 `1 insertion(+), 173 deletions(-)`，**不是** `git stash`），随后：

- **K=1（AC2 的并发度）**：`3/3 退出 0`（即 (a) 的三条基线）—— **不复现**。
- **K=12（更高一档）**：`24/24 退出 0` —— **不复现**。
- **K=20（再高一档）**：`2/20` 红，但两条都是**断言形状**（`Error: the upload was 2.99s / 3.05s of a 2.938s fixture`，`uploadLines=1`），**不是** AC2 的 `#username` 前导形状。

同一 K=20 在**修后**树上另有 `3/20` 红（腿 1/4/17），预热都成功（`6217ms / 6962ms / 6723ms`），`# Error details` 是 `Error: Channel closed` + `Error: locator.click: Target page, context or browser has been closed` / `- waiting for getByRole('button', { name: /^voice-identifier-workspace/ }).first()` —— 死在 `expandProject()` 的**项目行 click**（`page.reload()` 之后的同名无界等待，`:189–203` / `:264`），**不在**本次改动覆盖的开户前导里。

**结论（如实）：** 这次红的可复现性是**宿主负载的函数**，本任务在 K≤20 的每一档都没能把 AC2 的 `#username` 前导形状按需重现；因此 AC5 的**主形态（还原 ⇒ 重新红）不成立**，走的是 AC5 自己写明的后备分支（「如实登记为『该并发度下取假不成立』并补一档更高并发度的读数」）。据此，DoD 的「承重证据是 AC5 —— 把它还原，AC2 的复现必须重新红」这一条**按原样未达成**，本条只提供：可观察的机制读数（trace）、代价搬移的可测读数（(c) 的表）、以及修后 36+3 条腿的现场绿。**本记录不主张「已取假」。** 另：`expandProject()` 的 click 与 `expect(projectRow()).toBeVisible({timeout: 30_000})` 仍是同一 `beforeAll` 里未被本次改动覆盖的无界等待（K=20 的修后红即落在此），按「范围不预先扩大」留给后续，不在此处顺手扩大。

### (f) AC6 / AC7 / AC8

AC6（本树 vs `develop`，`grep -cF` 逐条同值；分叉点 `78392783`）：`expect(UTTERANCE).toContain(SPOKEN)` → `1`（≥1）；`expect(UTTERANCE).not.toContain(identifier)` → `1`（≥1）；`toHaveValue(expected` → `1`；`expect(value).toContain(identifier)` → `1`；`expect(value).not.toContain(SPOKEN)` → `1`；`setTimeout(120_000)` → `1`（与 develop 同值）。`git diff $(git merge-base HEAD develop)..HEAD -- e2e/voice-identifier-repair.spec.ts | grep -cE '^\+.*(60_000|120_000|retries|test\.skip)'` → `0`。前提自查（`:282`/`:283`）与 composer 三条断言（`:324`/`:328`/`:335`）逐字未动；未用 `retries` / `test.skip` / 未加长 `page.waitForTimeout(2500)`；未抬 `:208` 的 `setTimeout(120_000)`。

AC7：`npm run typecheck` 退出 `0`；`npm run lint` 退出 `0`（仅既有 warning，无 error）。

AC8：`bash scripts/test.sh --for-task gap-voice-identifier-criterion-boot-dep-reopt-race --allow-thin` 退出 `0`，走 thin 分支（Touches 里没有 `*.test.*`，判据载体是 `e2e/*.spec.ts`）：

```
suite-scope-check: scan tasks=206 skipped(done/superseded)=194 active=12 with-tests=9 no-tests=3
suite-scope-check: PASS — 12 active task(s) scanned: every active task whose ## Touches lists *.test.* carries --for-task in its ## AC self-test, and no active task without *.test.* touches uses the full suite as its self-test; this guard is wired into …/scripts/test.sh's prelude (line 101 < stage line 428)
no scoped test files for gap-voice-identifier-criterion-boot-dep-reopt-race (thin)
```

2b：`git merge --no-edit develop`（`d299cea6`）无冲突；随后重跑同一 scoped 门仍退出 `0`；scoped-gate 缓存已写（`{"event":"scoped-gate-cache-written","task":"gap-voice-identifier-criterion-boot-dep-reopt-race","developSha":"d299cea62a632c1466748f602d29944451f8806f","cacheFile":"/data/home/yale/work/claudecodeui/.quay/scoped-gate-cache.json"}`，该 sha 即 `HEAD^2`）。

### (g) 落地形状（供复核）

只动 `beforeAll` 与其前置常量/助手，逐条照抄本仓既有形状（不新造第二套实现、不抽共享模块、不新增文件）：

- `CLIENT_WARM_DEADLINE_MS = 30_000` + `warmClientStartup(CLIENT_URL)`（形状取自 `e2e/transcript-follow.spec.ts:1826`：shell `/` → 入口 `/src/main.tsx` → 重读入口取 `deps/*.js?v=<hash>` → 取该 dep 得 200 才算提交），在 `browser.newContext()` **之前** 跑完，成功打印 `[e2e] client warm-up: pre-bundle committed in <n>ms`。
- 开户前导有界自报：`appears()`（形状取自 `e2e/voice-trim.spec.ts:309`）+ 有界 `page.reload()` 重试（`STARTUP_PROBE_MS = 8_000` / `STARTUP_RELOAD_PROBE_MS = 4_000` / `STARTUP_PROBE_DEADLINE_MS = 18_000`）；预算耗尽抛**本 spec 自己的错**，带 `readStartupEvidence(page)`（`console` 的 error 类型 + `requestfailed`，形状取自 `e2e/voice-trim.spec.ts:650` 一族）。首屏探针 `ACCOUNT_FORM_PROBE = '#username'`。
- 未落地的候选（如实）：`appears`/`requestfailed` 之外未引入新助手；`expandProject()` 保持原形（见 (e) 末）。

### (h) L_D / L_G

**L_D 该轴仍暗**：本任务只改测量侧的前导与归因（一个 spec 的 `beforeAll`），不新增领域数据能力，没有可读出的领域数据轴读数。

**L_G 该轴仍暗**：同上 —— 读数是前导耗时、并发度与退出码，不是生成质量轴读数；目标层判据由 GOAL-005 的其余判据承担。
