---
id: gap-ac178-criterion-ledger-red-is-merge-race
title: AC-178 判据台账尾部红是 merge race：goal 记录 criterion 于 15:58:56Z 先改成 "composer
  has no resident switch"，而引入该 test 标题的修复 876147f4 直到 fan-in
  55feb8c4（16:06:08Z）才进 develop/主检出，三次红都测到「标题还不存在的树」（No tests found）——
  verification-only 归因入档（净树直跑 exit 0 ×3 含并发），不重新实现既有修复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-178
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-178 `status: achieved`，其 GOAL-013 已 achieved、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。台账逐字（`.quay/gate-events.jsonl`，`item_id=AC-178`，`gate=goal`）最近四拍：

```
2026-10-04T14:47:24.067Z goal-sweep pass  criterionHash=7bdf4ebb7eb3dd05
2026-10-04T16:01:10.311Z goal-amend fail  criterionHash=12b7d09c19277ab0
2026-10-04T16:02:04.629Z goal-cli   fail
2026-10-04T16:06:05.560Z goal-cli   fail
```

fail 拍逐字理由（三拍同形）：`acceptance failed (exit 1) — … Error: No tests found. Make sure that arguments are regular expressions matching test files. You may need to escape symbols like "$" or "*" and quote the arguments.`

判据物（逐字取自 `goals/AC-178-已经是常驻的会话-输入区不再显示开启开关与知情提示.md` 的 `criterion:`）：`npx playwright test e2e/resident-ui-layout.spec.ts -g "composer has no resident switch"`。`expect` 逐字：「已有会话（无论 lifecycleMode 是 resident 还是 per-run）的输入区 .chat-composer-shell 内不再出现常驻开关 [data-resident-enable="true"]（count=0）；同一次运行里新会话空状态在模型卡片下仍出现同一选择器的开关（count=1，正控制，证明读数不是恒空）。取假形态：composer 仍渲染开关 ⇒ 必须红，且红落在已有会话这一条读数上。」

**本轮直接现测：判据在检出上退出 0（工作树满足 AC-178）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD` = `55feb8c412dac197aa0af684d0cda4f9ac3ba00f`，`git status --porcelain` 无 tracked 修改）直跑三次，退出码全 0：

- run1（单独）：`1 passed (11.8s)`，`elapsed=12573ms`
- run2 + run3（**并发**两跑，模拟 driver 的负载条件）：`1 passed (11.9s)`，`elapsed=11859ms` / `1 passed (12.0s)`，`elapsed=12028ms`

三跑读数一致（逐字）：resident 臂 `resident.composer.switch.count=0` / `resident.page.switch.count=0`；per-run 臂 `per-run.composer.switch.count=0` / `per-run.page.switch.count=0`；正控制 `empty.page.switch.count=1`。⇒ 已有会话（resident 与 per-run 两种）输入区 `[data-resident-enable="true"]` 计数为 0，同一次运行里新会话空状态同一选择器为 1。

**机制：merge race（criterion 先改、引入该 test 标题的修复后到 develop），不是修复失效。** 这是「goal-gate-red-can-race-the-fixs-own-landing」的又一实例：

- AC-178 goal 记录的 `criterion` 于 `a7348a37`「goals: AC-178 field:criterion,expect,origin by cli:4070624」（`2026-10-04 23:58:56 +0800` = `15:58:56Z`）改成 `-g "composer has no resident switch"`，即 criterionHash 由 `7bdf4ebb7eb3dd05`（旧 `-g "resident session hides enable affordance"`）变为 `12b7d09c19277ab0`。台账 fail 块正是从这个新 hash 的首拍（`16:01:10.311Z`）开始——上一拍 pass（`14:47:24.067Z`）仍是旧 hash。
- 引入该 test 标题的修复是 `876147f4`「test(e2e): composer draws no resident switch; AC2 silent-conversion regression leg」（`2026-10-04 23:57:02 +0800` = `15:57:02Z`），它**最初只提交在 task 分支** `task/gap-resident-composer-switch-removed-intent-new-session-only` 上。
- 它**第一次进 develop/主检出**是 fan-in 合并 `55feb8c4`「Merge branch 'develop' into task/gap-resident-composer-switch-removed-intent-new-session-only」（`2026-10-05 00:06:08 +0800` = `16:06:08Z`）。
- 机械证据：`git merge-base --is-ancestor 876147f4 30f42bc1; echo $?` → **1**（`30f42bc1` 是 `00:04:33` 的 develop tip，即合并前最后一拍 develop），而 `git show 30f42bc1:e2e/resident-ui-layout.spec.ts | grep -c "composer has no resident switch"` → **0**；`git merge-base --is-ancestor 876147f4 develop` → **0**，`git show develop:e2e/resident-ui-layout.spec.ts | grep -c "composer has no resident switch"` → **1**。
- 即：三次红测到的树上 spec **根本没有** `-g` 要匹配的那个标题 ⇒ Playwright 报 `No tests found`。最后一拍红 `16:06:05.560Z` 比修复进 develop/主检出 `16:06:08Z` 早约 **2.5 秒**。

⇒ **早先的修复没有失效**（`gap-resident-composer-switch-removed-intent-new-session-only`，done；`gap-resident-composer-hides-enable-affordance`，done）；台账 fail 尾部是 goal 记录 criterion 改写与引入该标题的修复落地之间的竞态。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，`git rev-parse HEAD` = `55feb8c4`）：`grep -rl '^goal_ac: *AC-178' tasks/*.md` 命中 3 条，`status:` 逐字皆 **done**（`gap-ac178-criterion-anchor-retired-by-dock-consolidation`、`gap-resident-composer-hides-enable-affordance`、`gap-resident-composer-switch-removed-intent-new-session-only`）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-178`）→ **0 命中** ⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`，done）与 `gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（`goal_ac: AC-184`，done）是**另一条 AC**，仅归因机制族相同。

**残留的未钉死假设（如实登记）**：本判据的「模式已到达」正信号是 `[data-resident-badge]`（`src/modules/chat/transcript/ResidentSessionBadge.tsx:200`，workspace header 的常驻药丸）；开关的正控制读的是空状态里 `ResidentToggle` 发布的 `data-resident-enable`（`src/modules/chat/composer/ResidentConsentNotice.tsx:92`，唯一 home 在 `ProviderSelectionEmptyState.tsx:249`）。两者都是**结构性标记**：一次把药丸标记改名/删除的产品重构（历史上 `[data-resident-status-bar]` 就曾在 `ad1bb63a` 被并进活动坞，见 `gap-ac178-criterion-anchor-retired-by-dock-consolidation`）会让判据在正信号等待处 30s 超时记红，而 composer 的渲染门其实未动——届时正确的收尾仍是「量具跟着产品走」，不是复活死标记。另外本判据只在 goal 门重跑时被复核；GOAL-013 已 achieved，故本次复核由本 gap 轮驱动。

本任务是 **verification-only 归因入档**：不改实现、判据、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据：`npx playwright test e2e/resident-ui-layout.spec.ts -g "composer has no resident switch"` 一次；再并发跑两次（后台并行两进程），逐字抄三跑的 `1 passed` / `elapsed=` / 五条计数行与退出码。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%H %ci %s' 876147f4`、`git log -1 --format='%H %ci %s' a7348a37`、`git log -1 --format='%H %ci %s' 55feb8c4`、`git rev-parse develop`、`git merge-base --is-ancestor 876147f4 develop; echo $?`、`git merge-base --is-ancestor 876147f4 30f42bc1; echo $?`、`git show 30f42bc1:e2e/resident-ui-layout.spec.ts | grep -c 'composer has no resident switch'`、`git show develop:e2e/resident-ui-layout.spec.ts | grep -c 'composer has no resident switch'`；并复算「最后一拍红 16:06:05Z < fan-in 落地 16:06:08Z」。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-178 `gate=goal` 的 fail/pass 尾部（逐字时间戳 + hash + 理由）。
5. 交付只落在 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次均退出 **0**：一次单独 + 两次并发；`elapsed=NNNNms` 均 < 55_000，五条读数（resident 臂 `.chat-composer-shell` 内 `[data-resident-enable="true"]` count=0、per-run 臂同读数 count=0、正控制空状态同一选择器 count=1）逐字入档。红态基线（本轮立案读数）：台账 `16:06:05.560Z` 拍退出 1，红在 `Error: No tests found`。
- [x] AC2 承重的 ancestry 证据机械入档：`git log -1 --format='%H %ci %s' 876147f4` → 修复提交 `2026-10-04 23:57:02 +0800`；`git log -1 --format='%H %ci %s' 55feb8c4` → fan-in `2026-10-05 00:06:08 +0800`；`git merge-base --is-ancestor 876147f4 30f42bc1; echo $?` → **非 0**（修复**不在**合并前最后一拍 develop tip 上）；`git show 30f42bc1:e2e/resident-ui-layout.spec.ts | grep -c 'composer has no resident switch'` → **0**；`git merge-base --is-ancestor 876147f4 develop; echo $?` → **0** 且 `git show develop:e2e/resident-ui-layout.spec.ts | grep -c 'composer has no resident switch'` → **1**。命令与逐字输出入档。
- [x] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-178`、`gate=goal` 的 fail 尾部（至少 `16:01:10.311Z`、`16:06:05.560Z`）与上一拍 pass（`2026-10-04T14:47:24.067Z`，criterionHash `7bdf4ebb7eb3dd05`）逐字抄出，并写明「最后一拍红（16:06:05Z）早于 fan-in 落地（16:06:08Z）约 2.5s，且 fail 块与 criterionHash 由旧变新的时刻同起」。
- [x] AC4 机制去重复核：`grep -rl '^goal_ac: *AC-178' tasks/*.md` 的命中集合与其 `status:` 逐字入档；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-178`）若命中的是本条自身，须注明；并写明同族先例 `gap-ac135-criterion-ledger-red-is-merge-race` / `gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（各属另一条 AC）。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`（或为空，若 ABI tick 已 push-through 到 develop）；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `src/**`、`goals/**`、`playwright.config.ts`）。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-178**」与「台账 fail 尾部由 goal 记录 criterion 于 `15:58:56Z` 先改成 `composer has no resident switch`、而引入该 test 标题的修复 `876147f4` 直到 fan-in `55feb8c4`（`16:06:08Z`）才进 develop/主检出造成」，并给出残留未钉死假设（正信号 `[data-resident-badge]` 与正控制 `data-resident-enable` 都是结构性标记，产品重构可退役之）；⛔ 不得用 jsdom/单元层读数替代判据本体。

## DoD

- 出货命令（`npx playwright test e2e/resident-ui-layout.spec.ts -g "composer has no resident switch"`，逐字不改；⛔ 不改断言、不改 `-g` 过滤、不改 `SINGLE_SPEC_CEILING_MS`）在净检出上真的跑过、退出 0 三次（含并发两次），五条读数行与 `elapsed=` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、criterion 改写时刻、fan-in 时刻、`merge-base --is-ancestor` 退出码、合并前/后 spec 里 test 标题的命中数、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `876147f4` 有效；台账 fail 尾部是 criterion 改写与修复落地之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据 spec、实现、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- `tasks/gap-ac178-criterion-ledger-red-is-merge-race.md`（自触）
- `e2e/resident-ui-layout.spec.ts`（本条只跑不改：判据本体，`test('composer has no resident switch')` 于 :1498）
- `src/modules/chat/composer/ResidentConsentNotice.tsx`（本条只读不改：`data-resident-enable` 标记发布者，:92）
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`（本条只读不改：开关唯一 home，:249）
- `src/modules/chat/transcript/ResidentSessionBadge.tsx`（本条只读不改：正信号 `[data-resident-badge]`，:200）
- `goals/AC-178-已经是常驻的会话-输入区不再显示开启开关与知情提示.md`（本条只读不改：criterion/expect 逐字来源）

## 完成记录

（本条为 **verification-only 归因入档**：不改实现、判据、宿主配置一个字节，也不动任何在飞 WIP。）

### AC1 — 判据在净检出直跑三次皆 exit 0（一单独 + 两并发）

worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac178-criterion-ledger-red-is-merge-race`
分支：`task/gap-ac178-criterion-ledger-red-is-merge-race`；起点 = 开工时 `develop`；`git rev-parse HEAD` = `e196c6c6c9d440fa8d60d349dabb33c51ba5c552`；开工 `git status --porcelain` = 空。
命令（逐字，三跑同一命令，不改断言 / 不改 `-g` 过滤 / 不改 `SINGLE_SPEC_CEILING_MS`）：
`npx playwright test e2e/resident-ui-layout.spec.ts -g "composer has no resident switch"`

三跑逐字读数：

- run1（单独）：`EXIT=0`；配置行 `elapsed=19514ms`；`1 passed (19.6s)`；墙钟 `wall=20399ms`
  `resident.composer.switch.count=0` / `resident.page.switch.count=0` / `per-run.composer.switch.count=0` / `per-run.page.switch.count=0` / `empty.page.switch.count=1`
- run2（与 run3 **并发**）：`EXIT=0`；`elapsed=11308ms`；`1 passed (11.3s)`；`wall=12037ms`；五条读数同上（`0 / 0 / 0 / 0 / 1`）
- run3（与 run2 **并发**）：`EXIT=0`；`elapsed=11346ms`；`1 passed (11.4s)`；`wall=12088ms`；五条读数同上（`0 / 0 / 0 / 0 / 1`）

三次 `elapsed`（19514 / 11308 / 11346 ms）均 < 55_000。三跑读数一致：已有会话（resident 与 per-run 两臂）`.chat-composer-shell` 内 `[data-resident-enable="true"]` count=0；正控制（新会话空状态，同一选择器）count=1 ⇒ 每个 0 都是读数而非死选择器。
红态基线（本轮立案读数）：台账 `2026-10-04T16:06:05.560Z` 拍 `goal-cli` fail（exit 1），逐字理由尾 `Error: No tests found. Make sure that arguments are regular expressions matching test files. …`。

### AC2 — ancestry 证据（逐字）

（在 `/data/home/yale/work/claudecodeui` 上运行，git 历史跨 worktree 共享）

```
$ git log -1 --format='%H %ci %s' 876147f4
876147f43271a772ee08be78cff8c221d0059f98 2026-10-04 23:57:02 +0800 test(e2e): composer draws no resident switch; AC2 silent-conversion regression leg
$ git log -1 --format='%H %ci %s' a7348a37
a7348a37f16b5abbf68bd9ea7b7d6b6f8bde9c9e 2026-10-04 23:58:56 +0800 goals: AC-178 field:criterion,expect,origin by cli:4070624
$ git log -1 --format='%H %ci %s' 55feb8c4
55feb8c412dac197aa0af684d0cda4f9ac3ba00f 2026-10-05 00:06:08 +0800 Merge branch 'develop' into task/gap-resident-composer-switch-removed-intent-new-session-only
$ git log -1 --format='%H %ci %s' 30f42bc1
30f42bc1675957260fae28df2fdd5006e6ab4e56 2026-10-05 00:04:33 +0800 tasks: gap-resident-composer-switch-removed-intent-new-session-only task_write by cli:31813
$ git merge-base --is-ancestor 876147f4 30f42bc1; echo $?
1
$ git merge-base --is-ancestor 876147f4 develop; echo $?
0
$ git show 30f42bc1:e2e/resident-ui-layout.spec.ts | grep -c 'composer has no resident switch'
0
$ git show develop:e2e/resident-ui-layout.spec.ts | grep -c 'composer has no resident switch'
1
```

即：引入 `-g` 所匹配 test 标题的修复 `876147f4`（`2026-10-04 23:57:02 +0800` = `15:57:02Z`）**不在**合并前最后一拍 develop tip `30f42bc1`（`00:04:33 +0800`）上（`merge-base --is-ancestor` 退出码 **1**，该树 spec 标题命中 **0**）；它**在** develop 上（退出码 **0**，标题命中 **1**）——首次进入 develop/主检出即 fan-in `55feb8c4`（`2026-10-05 00:06:08 +0800` = `16:06:08Z`）。criterion 改写提交 `a7348a37` 时刻 `2026-10-04 23:58:56 +0800` = `15:58:56Z`。

### AC3 — 台账尾巴（逐字）

`.quay/gate-events.jsonl`，`item_id=AC-178`、`gate=goal`：

```
2026-10-04T14:47:24.067Z pass  actor=goal-sweep  criterionHash=7bdf4ebb7eb3dd05   ← fail 块紧邻之前的最后一拍 pass
2026-10-04T16:01:10.311Z fail  actor=goal-amend  criterionHash=12b7d09c19277ab0   ← fail 块起始；criterionHash 由旧变新
2026-10-04T16:02:04.629Z fail  actor=goal-cli
2026-10-04T16:06:05.560Z fail  actor=goal-cli                                    ← 最后一拍红（16:06:05Z）
2026-10-04T16:12:36.787Z pass  actor=goal-cli  acceptance passed (exit 0)          ← fan-in 落地（16:06:08Z）之后第一拍
```

fail 拍逐字理由（三拍同形）：`acceptance failed (exit 1) — … Error: No tests found. Make sure that arguments are regular expressions matching test files. You may need to escape symbols like "$" or "*" and quote the arguments.`

最后一拍红 `16:06:05.560Z` 早于 fan-in 落地 `16:06:08Z` 约 **2.44s**；fail 块起始 `16:01:10.311Z` 的 `criterionHash` 恰由旧 `7bdf4ebb7eb3dd05` 变为新 `12b7d09c19277ab0`，与 criterion 于 `15:58:56Z` 被改写成 `-g "composer has no resident switch"` 同一动作 ⇒ **fail 块与 criterionHash 由旧变新的时刻同起**。fan-in 落地后下一拍（`16:12:36.787Z`，约 +6.5min）即转 pass。

### AC4 — 机制去重复核（逐字）

`grep -rl '^goal_ac: *AC-178' tasks/*.md` 命中 4 条，`status:` 逐字：

```
tasks/gap-ac178-criterion-ledger-red-is-merge-race.md                  status: ready   ← 本条自身
tasks/gap-ac178-criterion-anchor-retired-by-dock-consolidation.md      status: done
tasks/gap-resident-composer-hides-enable-affordance.md                 status: done
tasks/gap-resident-composer-switch-removed-intent-new-session-only.md  status: done
```

在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-178`）→ 唯一命中**本条自身**（`ready`），**无第三方在飞认领者** ⇒ 本条不是重复。（Proposal 记「命中 3 条」为立案时读数：当时本条尚未落入 `tasks/`，故只有其它 3 条；现读为 4 条含自身。）

同族先例 `gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`，现 `status: done`）与 `gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（`goal_ac: AC-184`，现 `status: done`）各属**另一条 AC**，仅归因机制族相同（`goal-gate-red-can-race-the-fixs-own-landing`）。

### AC5 — 承重面未被本条触碰

worktree（`/data/home/yale/work/claudecodeui-worktrees/gap-ac178-criterion-ledger-red-is-merge-race`，HEAD `e196c6c6`）：

- `git diff --name-only develop..HEAD` → **空**
- `git status --porcelain` → **空**（与本条开工快照逐字相同）
- `git status --porcelain -- src goals playwright.config.ts e2e` → **空**
- 主检出 `git status --porcelain` 与本条开工快照逐字相同。

⛔ 未 `stash`、未 `git checkout --`、未编辑任何 `src/**`、`goals/**`、`playwright.config.ts`；e2e 运行日志写在 worktree 外的 `/tmp/ac178-merge-race-worker/`，未污染工作树。交付只落 `tasks/<本条 id>.md`。

### AC6 — 判法（如实登记）

**被提交的树满足 AC-178**：判据 `npx playwright test e2e/resident-ui-layout.spec.ts -g "composer has no resident switch"` 在本条净检出上直跑三次（一单独 + 两并发）皆 exit 0，五条读数一致（已有会话 resident / per-run 两臂 count=0，正控制 count=1）。

**台账 fail 尾部是 merge race，不是修复失效**：goal 记录 criterion 于 `15:58:56Z`（`a7348a37`）先改成 `-g "composer has no resident switch"`（criterionHash 旧→新），而引入该 test 标题的修复 `876147f4`（`15:57:02Z`）**最初只提交在 task 分支** `task/gap-resident-composer-switch-removed-intent-new-session-only` 上，直到 fan-in `55feb8c4`（`16:06:08Z`）才进 develop/主检出 —— 三次红（`16:01:10Z` / `16:02:04Z` / `16:06:05Z`）都测在「标题还不存在的树」上（Playwright 报 `No tests found`）。最后一拍红比修复落地早约 2.44s；落地后下一拍（`16:12:36.787Z`）即转 pass。⇒ **修复 `876147f4` 有效；台账 fail 尾部是 criterion 改写与引入该标题的修复落地之间的竞态。**

**残留未钉死假设（如实登记）**：本判据的「模式已到达」正信号是 `[data-resident-badge]`（`src/modules/chat/transcript/ResidentSessionBadge.tsx:200`，workspace header 的常驻药丸）；开关正控制读的是空状态里 `ResidentToggle` 发布的 `data-resident-enable`（`src/modules/chat/composer/ResidentConsentNotice.tsx:92`，唯一 home 在 `ProviderSelectionEmptyState.tsx:249`）。两者都是**结构性标记**：一次把药丸标记改名/删除的产品重构（历史上 `[data-resident-status-bar]` 就曾在 `ad1bb63a` 被并进活动坞，见 `gap-ac178-criterion-anchor-retired-by-dock-consolidation`）会让判据在正信号等待处 30s 超时记红，而 composer 渲染门其实未动 —— 届时正确收尾仍是「量具跟着产品走」，不是复活死标记。另外本判据只在 goal 门重跑时被复核；GOAL-013 已 achieved，本次复核由本 gap 轮驱动。

⛔ 未用 jsdom/单元层读数替代判据本体。
