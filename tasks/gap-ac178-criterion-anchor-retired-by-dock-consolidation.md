---
id: gap-ac178-criterion-anchor-retired-by-dock-consolidation
title: AC-178 判据的「模式已到达」正信号锚 [data-resident-status-bar] 被活动坞合并 ad1bb63a
  退役，判据在正信号等待处 30s 超时记红——把 AC-178 的读数锚回灌到合并后的
  [data-activity-dock-toggle]（渲染门本身未失效）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-178
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，不是关键字碰运气）：`grep -rln '^goal_ac: *AC-178' tasks/` 只命中 `tasks/gap-resident-composer-hides-enable-affordance.md`（**status: done**）——按规则 done 不是重复，而是「上一次的修法没兜住」的证据；在飞任务（`grep -l '^status: \(todo\|ready\|needs-human\)' tasks/*.md` 共 9 份）里带 `goal_ac` 的只有 AC-190 / AC-187 / AC-148 / AC-142 / AC-207，**无一为 AC-178** ⇒ AC-178 无在飞认领者，本条不是重复。同机制扫描：`grep -rln 'data-activity-dock-toggle' tasks/*.md` → **0**；`grep -rln 'ad1bb63a' tasks/*.md` → **0**；`grep -rln 'data-resident-status-bar' tasks/*.md` 命中的 13 份里，没有一份是「把退役标记回灌到 `e2e/resident-ui-layout.spec.ts`」这件事。机制相近但不相交的邻居：`gap-activity-single-dock-global-consistency`（done，就是做这次合并的那条，范围是产品面的合并本身，不负责把退役标记回灌到 AC-177/178/179 共用的 spec）、`gap-resident-ui-layout-criterion-bounded-boot-guard`（done，AC-177，修的是启动期无界等待，与本条的退役标记是两件事）、`gap-resident-status-bar-covers-transcript`（done，AC-179）与 `gap-resident-popover-close-reachable-narrow-viewport`（done，AC-177）——后两条的用例今天同样按退役标记寻址，但各自认领自己的 AC，本条只认领 AC-178 的读数。

**判据物（逐字取自 `goals/AC-178-已经是常驻的会话-输入区不再显示开启开关与知情提示.md` 的 `criterion:`）**：`npx playwright test e2e/resident-ui-layout.spec.ts -g "resident session hides enable affordance"`（命令逐字含文件路径与 `-g` 过滤）。`expect` 逐字（同文件）：「会话宿主列表读回 lifecycleMode 为 resident 之后，输入区不出现常驻开关，也不出现知情提示与勾选框；同一次运行里一个 per-run 的新会话输入区仍出现开关（正控制，证明读数不是恒空）。取假形态：无论会话模式都渲染开关与知情提示 ⇒ 必须红，且红落在已常驻会话这一条读数上。」

**红态基线（本轮立案前直接重跑判据本身，读它的失败输出，不读台账 `reason` 的 stderr 尾巴）**：命令同上 → **EXIT=1**，wall 39.1s，失败逐字：

```
Error: a resident session must draw the bar that proves the mode arrived
expect(locator).toBeVisible() failed
Locator: locator('[data-resident-status-bar]')
Expected: visible   Timeout: 30000ms   Error: element(s) not found
  > 1290 |       .toBeVisible({ timeout: 30_000 });
     at /data/home/yale/work/claudecodeui/e2e/resident-ui-layout.spec.ts:1290:8
```

即判据在**正信号等待**处就死了，一个 composer 读数都没取到。同一轮 stdout 证明这不是启动期那条老路：`resident.session=… / session.lifecycle_mode=resident`（API 已读回常驻）、`[e2e] client startup: the transcript pane for the resident arm (…) landed after 3871ms (attempt 1)`（有界预热 + 探针工作正常）、`pane` 已 `toBeVisible` 通过 —— 死在它之后的那一步。

**因果括号（台账时间戳 vs 提交时间，criterionHash 三次相同）**：

- `2026-10-02T07:01:21.640Z` — goal-sweep **pass**（`.quay/gate-events.jsonl` 里 AC-178 最后一次绿，`criterionHash: 7bdf4ebb7eb3dd05`）
- `2026-10-02 15:40:33 +0800` = `07:40:33Z` — **`ad1bb63a`** 落地（`activity dock: one dock, one source, one answer`）
- `2026-10-02T08:41:01.784Z` goal-sweep **fail**（首个红）、`08:43:22.927Z` goal-cli **fail**（`criterionHash` 仍是 `7bdf4ebb7eb3dd05`）

判据文本一字未动（hash 三次相同）⇒ 动的是环境，不是判据。

**机制。** `ad1bb63a` 把常驻状态条并进活动坞：`ResidentStatusBar` → `ResidentPanel`，生产代码里的 `data-resident-status-bar="true"` 被整体删除，坞改用 `[data-activity-dock]` + `data-activity-state` 表达活动、用 `data-resident-panel` 表达展开后的常驻事实面板（`ActivityIndicator.tsx:139` / `:240` / `:271`，`ResidentStatusBar.tsx:133`）。全仓实测：`grep -rn 'data-resident-status-bar' --include=*.tsx --include=*.ts .`（排除 node_modules 与 worktrees）在生产代码里 **0 命中**，只剩 4 份测试仍按旧契约寻址——`e2e/resident-ui-layout.spec.ts:30`、`e2e/resident-busy-send.spec.ts:80`、`src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx:60`、`src/modules/chat/tests/hostSnapshotFailure.test.ts:159`。`git show --stat ad1bb63a` 里 e2e 只列了 `activity-dock-truthful.spec.ts` 与 `mobile-workspace-composer-layout.spec.ts` 两份（提交信息也自述「the two specs that addressed the old markers by name」）——**越过了**同样按旧标记寻址的 `e2e/resident-ui-layout.spec.ts`。

**为什么「上一次的修法没兜住」必须如实读成「判据的量具退役、产品保证仍在」。** AC-178 的产品面修法是 `f8382b78`（`ChatComposer.tsx:770` 的渲染门 `canRunResident && showResidentSwitch && !isResidentSession`）。本轮实测该门逐字未动：`git log -S'!isResidentSession &&' -- src/modules/chat/composer/ChatComposer.tsx` 只有 `f8382b78` 一条，而坞合并对 `ChatComposer.tsx` 的全部改动只有一行 `+ persistWhenIdle={isResidentSession}`。所以本条**不是**「修法失效」，而是判据用来确认前提取到的那个锚（旧状态条）被产品重构退役、而回灌时漏了本份 spec —— 这一点写进任务体，是为了不让下一个执行者去修一个本来就正确的渲染门。

**探针（本轮两次直接实测；改动已 `git checkout` 还原，工作树干净）**：把 `e2e/resident-ui-layout.spec.ts:30` 的 `const BAR` 指向合并后的坞（`[data-activity-dock-toggle="true"]`），其余一字不动 →

- 第 1 次：`1 passed (11.3s)`，`elapsed=11317ms`；resident 臂 `composer.switch.count=0 / notice=0 / checkbox=0`，per-run 臂 `composer.switch.count=1 / marker="true"`。
- 第 2 次（额外印两臂坞计数）：`1 passed (11.4s)`，`elapsed=11500ms`；`dockToggle.count` resident = **1**、per-run = **0**。

⇒ 保证成立、锚可换、判据能在 55s 预算内翻绿；两臂计数证明新锚有区分力（不是「两臂都空」的假绿）。

**修法（最小充分，不发明新机制）。** 把 AC-178 用例（`e2e/resident-ui-layout.spec.ts:1242` 起）的「模式已到达」正信号，从退役的 `[data-resident-status-bar]` 换成合并后坞里等价的那一个：`[data-activity-dock-toggle="true"]` —— `ActivityIndicator.tsx:240` 以 `persistWhenIdle` 门控该按钮，而 `persistWhenIdle === isResidentSession`（`ChatComposer.tsx:546`），与旧状态条「只对已常驻会话渲染」是同一个读法，且它与渲染门读的是同一个 `findSessionHostState`。该用例对 `BAR` 的引用只有 `:1289` **一处**（逐行核对过：`:1242`–`:1352` 区间内不再有第二个 `BAR`），故取**外科式**改法：**不动**共享的 `const BAR`（`:30`）。实现上给该用例一个局部 `const BAR`（值即 `[data-activity-dock-toggle="true"]`）遮蔽模块级常量：这样「模式已到达」那一条 `expect` 的**文本逐字不改**（AC3 的 `git diff … | grep -c '^-.*expect('` = 0 由它保证），而 AC-179 / AC-177 仍按各自退役标记寻址、红形态不变、属各自 AC 的范围。断言面一字不改（见 AC3）。

**非目标。** 不改判据命令、不改 60s 门限与 `SINGLE_SPEC_CEILING_MS = 55_000`；不加 `retries`、不 skip、不 stub；不复活旧状态条、**不**为兼容旧标记往生产代码里补一个 `data-resident-status-bar`（那会把一次「量具跟着产品走」的收尾变成往生产里加回死契约）；不修 AC-177 / AC-179 / AC-175（`e2e/resident-busy-send.spec.ts:80` 同因的那条红）。

## AC

- [x] AC1 判据翻绿：`npx playwright test e2e/resident-ui-layout.spec.ts -g "resident session hides enable affordance"` 退出 **0**（命令逐字不改），且该用例自报的 `elapsed=NNNNms` < 55_000（不触发 `SINGLE_SPEC_CEILING_MS`）。验证：`echo $?` + 用例 stdout 的 `1 passed` 与 `elapsed=` 两行逐字登记。
- [x] AC2 读数锚不再指向退役标记：AC-178 用例区间内 `[data-resident-status-bar]` 命中数 = **0**；该用例的「模式已到达」正信号实测读 `[data-activity-dock-toggle="true"]`。验证：`awk 'NR>=1242 && NR<=1360' e2e/resident-ui-layout.spec.ts | grep -c 'data-resident-status-bar'` = 0，且 `sed -n '1242,1360p' e2e/resident-ui-layout.spec.ts | grep -c 'data-activity-dock-toggle'` ≥ 1（两条命令逐字输出登记）。
- [x] AC3 两臂断言面一字未改：`resident` 臂 `composer.switch.count` / `composer.notice.count` / `composer.checkbox.count` 三条 = 0、`per-run` 臂 `composer.switch.count` = 1 且 `per-run.switch.marker="true"` 的 `expect` 逐字保留；`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^-.*expect('` = **0**。验证：该 grep 的逐字输出 + 一次运行 stdout 的 `composer.switch.count=` / `composer.notice.count=` / `composer.checkbox.count=` / `per-run.switch.marker=` 四行。
- [x] AC4 替换锚有区分力（承重的两臂对照，防「新锚恒空」的假绿）：同一选择器在两臂的实测计数为 `resident` = **1**、`per-run` = **0**（本轮探针读数，见 Proposal），新读数以两臂对照写进用例并登记。验证：运行 stdout 的两行 `dockToggle.count` 读数（实现为两臂各自的计数打印或一条两臂对照 `expect`，两者皆可，只要两臂读数都出现在完成记录里）。
- [x] AC5 负控制（红必须落在正信号这一条读数上）：把正信号锚临时改回任一不存在于生产的标记（如 `[data-resident-status-bar]`）后，判据必红且红在正信号等待处（30s 超时、`element(s) not found`），还原后回绿。验证：两次运行的 `echo $?` + 失败行逐字（含超时毫秒与 `Locator:` 行）一并登记。
- [x] AC6 只认领 AC-178 的范围：不改 AC-177（`-g "close is reachable"`）与 AC-179（`-g "status bar does not cover the transcript"`）命中的 test 标题与其断言。验证：`npx playwright test e2e/resident-ui-layout.spec.ts --list` 退出 **0** 且仍列出 **3** 个用例、标题逐字未变，且 `git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^[-+].*test('` = **0**。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿，并把 pass 写进 `.quay/gate-events.jsonl`（AC-178 的台账尾部不再是 CURRENTLY FALSE）。且这条绿不是「恰好那次没抖」——AC1 的 `elapsed=` 与 AC4 的两臂计数（resident=1 / per-run=0）逐次写进完成记录。⛔ 不得用改判据命令 / 改断言 / `skip` / `retries` / 改 `SINGLE_SPEC_CEILING_MS` 换绿；AC3 与 AC6 机械证明两臂与兄弟用例的 `expect`/标题一字未改。完成记录必须如实写明这一次红的性质：**不是** AC-178 的产品保证（`ChatComposer.tsx:770` 的 `!isResidentSession` 渲染门）失效——该门自 `f8382b78` 起逐字未动，本轮探针也证明它仍然成立（resident 臂三计数 = 0、per-run 臂开关 = 1）——失效的是判据的**量具**：它用来确认「模式已到达」的正信号锚 `[data-resident-status-bar]` 在 `ad1bb63a` 被并进活动坞时退役，而该提交只回灌了 `activity-dock-truthful` 与 `mobile-workspace-composer-layout` 两份 spec。据此本条交付的是「量具跟着产品走」的收尾，不是产品修复。

## Touches

- e2e/resident-ui-layout.spec.ts
- tasks/gap-ac178-criterion-anchor-retired-by-dock-consolidation.md

## 完成记录

**这一次红的性质（如实登记）：不是产品修复，是「量具跟着产品走」的收尾。** AC-178 的产品保证 —— `ChatComposer.tsx:770` 的渲染门 `canRunResident && showResidentSwitch && !isResidentSession`（自 `f8382b78` 起逐字未动）—— 本轮实测仍成立：resident 臂 `composer.switch.count=0 / notice=0 / checkbox=0`，per-run 臂 `composer.switch.count=1 / marker="true"`。失效的只是判据用来确认「模式已到达」的正信号锚：旧标记 `[data-resident-status-bar]` 在 `ad1bb63a` 被并进活动坞时退役，而该提交只回灌了 `activity-dock-truthful` 与 `mobile-workspace-composer-layout` 两份 spec。本条的改动只把 AC-178 这条用例的读数锚换到合并后坞里等价的 `[data-activity-dock-toggle="true"]`（`persistWhenIdle === isResidentSession`，与渲染门读同一个 `findSessionHostState`），断言文本与 AC-177 / AC-179 的用例一字未动。

**实测读数（逐次）：**

- 绿 run 1：`EXIT=0`，`1 passed (10.7s)`，`elapsed=10712ms`；resident 臂 `composer.switch.count=0 / composer.notice.count=0 / composer.checkbox.count=0`、`dockToggle.count=1`；per-run 臂 `composer.switch.count=1`、`per-run.switch.marker="true"`、`dockToggle.count=0`。
- 绿 run 2（还原锚后复跑）：`EXIT=0`，`1 passed (23.4s)`，`elapsed=23434ms`；两臂读数同上（resident `dockToggle.count=1` / per-run `dockToggle.count=0`）。两次 `elapsed` 均 < 55_000。
- 负控制（把局部锚临时改成 `[data-resident-status-bar]`）：`EXIT=1`，红落在正信号等待处，逐字 `Error: a resident session must draw the bar that proves the mode arrived` / `expect(locator).toBeVisible() failed` / `Locator: locator('[data-resident-status-bar]')` / `Timeout: 30000ms` / `Error: element(s) not found`；随后还原 → run 2 回绿。
- 机械核查：`awk 'NR>=1242 && NR<=1360' … | grep -c 'data-resident-status-bar'` = 0；`sed -n '1242,1360p' … | grep -c 'data-activity-dock-toggle'` = 1；`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^-.*expect('` = 0；`… | grep -c '^[-+].*test('` = 0；`npx playwright test e2e/resident-ui-layout.spec.ts --list` = `EXIT=0`，3 个用例标题逐字未变。