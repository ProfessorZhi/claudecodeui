---
id: gap-ac172-criterion-anchor-retired-by-dock-consolidation
title: AC-172 判据的会话内读数锚（[data-resident-status-bar] 及其 data-resident-ui-state /
  data-resident-state-text / data-lease-kind 租约计数）被活动坞合并 ad1bb63a 退役，npx
  playwright test e2e/resident-status-bar.spec.ts 在首条用例正信号等待处 30s 超时（element(s)
  not found）记红——把读数锚回灌到合并后的 [data-activity-dock] 与侧栏 [data-resident-mark]，并按
  AC-188 移除被合法退役的会话内忙闲字样与租约计数读数
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-172
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，不是关键字碰运气）：`grep -l '^goal_ac: *AC-172' tasks/*.md` → **2** 份，均 **status: done**（`gap-claude-resident-status-bar`、`gap-resident-status-bar-criterion-bounded-boot-guard`）——按规则 done 不是重复，而是「上一次的修法没兜住」的证据。在飞任务（todo/ready/needs-human）实测 4 份——`gap-activity-dock-human-gate`（AC-190）、`gap-activity-dock-phase-truthful`（AC-187）、`gap-activity-send-retry-duplicates-user-row`（AC-185）、`gap-goal-016-collapsed-title-rule`（GOAL-016）——**无一认领 AC-172**。机制侧扫描：`grep -rln 'data-resident-status-bar' tasks/*.md` 命中的那些都不是「把 AC-172 判据的退役锚回灌到合并后的坞」。最接近的邻居 `gap-ac178-criterion-anchor-retired-by-dock-consolidation`（done）是**同源机制的另一个实例**，但它修的是**另一份 spec**（`e2e/resident-ui-layout.spec.ts`，认领 AC-178），与本条不同 AC、不同文件，机制同源但不相交。⇒ AC-172 无在飞认领者，本条不是重复。

**判据物**：`criterion:` 逐字 `npx playwright test e2e/resident-status-bar.spec.ts`。门限不变：driver-anchor 下 goal gate 的硬 60s；`playwright.config.ts:317` 的 `SINGLE_SPEC_CEILING_MS = 55_000`（spec `:1247` 的 `elapsed < 55_000` 亦钉此数）。

**红态基线（本轮立案前直接重跑判据本身，读它的失败输出，不读台账 `reason` 的 stderr 尾巴）**：`npx playwright test e2e/resident-status-bar.spec.ts` → **EXIT=1**，wall **41882ms**，失败逐字：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('[data-resident-status-bar]')
Expected: visible   Timeout: 30000ms   Error: element(s) not found
  > 816 |     await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
     at /data/home/yale/work/claudecodeui/e2e/resident-status-bar.spec.ts:816:37
1 failed, 3 did not run
```

spec `:699` 是 `test.describe.configure({ mode: 'serial' })`，首条红即跳过余下三条 ⇒ 一个四态读数都没取到，死在**正信号等待**处。

**因果括号（台账时间戳 vs 提交时间，criterionHash 三次相同）**：

- `2026-10-02T07:23:07.263Z` — goal-sweep **pass**（AC-172 最后一次绿，`.quay/gate-events.jsonl`，`criterionHash: 2e28f6b79b80cc05`）
- `2026-10-02 15:40:33 +0800` = `07:40:33Z` — **`ad1bb63a`** 落地（`activity dock: one dock, one source, one answer`）
- `2026-10-02T09:32:47.189Z` goal-sweep **fail**（首个红）、`09:35:23.486Z` goal-cli **fail**（`criterionHash` 仍 `2e28f6b79b80cc05`）

判据文本一字未动（hash 相同）⇒ 动的是环境，不是判据。

**机制。** `ad1bb63a` 把常驻状态条并进活动坞：`ResidentStatusBar` → `ResidentPanel`，生产代码里的 `data-resident-status-bar` / `data-resident-status-bar-trigger` / `data-resident-state-text` / `data-resident-ui-state` / `data-lease-kind`（及 `data-resident-lease-summary` / `-lease-total`）被删除；坞改用 `[data-activity-dock]` + `data-activity-state` 表达活动（`src/modules/chat/composer/ActivityIndicator.tsx:138-142`），用 `[data-activity-dock-toggle="true"]` 作展开入口（`:248`）、`[data-activity-dock-panel="true"]` 装 `ResidentPanel`（`:271`，其根是 `data-resident-panel`，`src/modules/chat/transcript/ResidentStatusBar.tsx:133`）。全仓实测（排除 node_modules 与 worktrees）：生产代码里 `grep -rn 'data-resident-status-bar' src/ --include=*.tsx --include=*.ts | grep -v /tests/` → **0**；`data-resident-ui-state` → **0**；`data-lease-kind` → **0**。`git show --stat ad1bb63a` 的 e2e 只列了 `activity-dock-truthful.spec.ts` 与 `mobile-workspace-composer-layout.spec.ts` 两份（提交信息也自述「the two specs that addressed the old markers by name」）——**越过了**同样按旧标记寻址的 `e2e/resident-status-bar.spec.ts`。

**为什么「上一次的修法没兜住」必须如实读成「判据的量具退役、产品保证仍在（一部分被更新的 AC 合法退役）」，而不是「去修一个本来就对的产品」。**

- 上一轮做绿 AC-172 的两条任务落对的东西今天仍在，只是**寻址面**被合并：**四态读数是侧栏的 `ResidentMark`**（`src/modules/sidebar/ResidentMark.tsx:60-62` 仍发布 `data-resident-mark` / `data-resident-state` / `data-resident-exit-detail`，其 `readResidentProcessState` 词表与 spec 的 `MARK_SHAPES` 逐字相同：hollow/solid/solid+spinner/exited，spec `:138-143`）；**地址 / pid / 复制 / 起停关闭仍在**（`ResidentStatusBar.tsx:140/156/164/176/193` 发布 `data-resident-address` / `data-resident-pid-text` / `data-resident-copy` / `data-resident-start` / `data-resident-close`，现在挂在坞的展开面板里）；**无人轮分隔与发送方仍在**（`data-unattended-divider` / `data-unattended-row` / `data-unattended-sender`）。
- 但 AC-172 的 expect 里有两句**已被更新且仍然生效的 AC-188 合法退役**：①「会话内状态条分别显示 proposal §15.1 规定的形态」的**会话内**那半（坞只报活动 idle/working，进程四态改由侧栏标记承载）；②「状态条的定时任务与监视计数等于宿主保活理由的数目」——AC-188（GOAL-014，achieved，criterion `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`）的 expect 逐字要求「resident 状态栏里不再有自己的忙闲状态与租约计数（地址、pid、起停关闭保留，并入坞的展开面板）」，其落地任务 `gap-activity-single-dock-global-consistency`（done）的 AC4 更把 `data-resident-ui-state` 的 busy/idle 呈现、`data-resident-lease-summary` / `-lease-total`、`data-lease-kind` / `data-lease-count` 的**计数为 0** 列为承重读数。⇒ 往坞里补回租约计数会让 AC-188 红，**不许**。

**修法（最小充分，不发明新机制；与 AC-178 兄弟同源）。** 把 AC-172 判据的读数锚从退役标记回灌到合并后的真实表面，并按 AC-188 移除被合法退役的两句读数：

1. **会话内入口**：`const BAR` 从 `[data-resident-status-bar]` 换成坞根 `[data-activity-dock]`；`const TRIGGER` 从 `[data-resident-status-bar-trigger]` 换成 `[data-activity-dock-toggle="true"]`（`ActivityIndicator.tsx:248`，`persistWhenIdle === isResidentSession`，与旧状态条「只对已常驻会话渲染」是同一读法）。坞的 `data-activity-state` 是**活动**读数（idle/working/unreachable/…），不是进程四态。
2. **四态读数移到侧栏标记**：`readBar`（spec `:329`）里对 BAR 的 `data-resident-ui-state` 与 `STATE_TEXT`（`data-resident-state-text`）读数，改读侧栏 `ResidentMark` 的 `data-resident-state` / `data-resident-mark`——spec 已有的 `readMark(page, sessionId)`（`:361`）就是它；四态（unstarted/idle/busy/exited）与 `MARK_SHAPES` 逐字不变。
3. **租约计数整体移除**：`LEASE_PILL`（`data-lease-kind`）、`readBar` 的 `counts`、`describeCounts` / `totalOf` / `readCountReading` 及四处 `counts.*` 断言按 AC-188 退役删除；`resident.statusBar.counts.*` 的 i18n 键**不删**（i18n 完整性用例 test 3 仍断言其存在且 12 个 locale 都有，删键会红）。
4. **popover 变成坞的展开面板**：`ADDRESS` / `COPY` / `CLOSE` / `START` 四个选择器不变（仍在 `ResidentPanel` 里，只是现在面板由 `[data-activity-dock-toggle]` 展开、由 `[data-resident-panel]` 标识）；`readBar` 打开面板的入口改用坞 toggle。**保留**地址复制与关闭进程两条核心读数。
5. **停止只中止一轮**：`resident.stopResident` 的停止按钮仍在 composer，`host.hostId` / `pid` / `startedAt` 的不变读数**保留**；`bar.pid` 的读数改读面板的 `data-resident-pid-text`。
6. **无人轮**：分隔标签、发送方、非用户消息样式的三条断言**逐字保留**。
7. **两条假形态（承重）按新锚改写**：(i) 把侧栏标记的状态源改成**本地镜像**（不再从 `GET /api/session-hosts` 刷新）⇒ 场景切换状态后四态读数必须红；(ii) 把无人轮渲染成用户消息样式（`isUserStyle` 为真 / 去掉 `unattended` 行类）⇒ 无人轮断言必须红。两条都登记变异 diff、失败断言逐字、退出码；恢复后回绿。

**⛔ 不变式**：判据命令（`npx playwright test e2e/resident-status-bar.spec.ts`）不改；60s 门限与 55s spec 上限不动；不加 `retries`、不 skip、不 stub；不往生产代码补回任何退役标记（那会让 AC-188 红）；不删 `resident.statusBar.*` / `resident.divider.*` 的 i18n 键（test 3 断言其存在）；不修 AC-177 / AC-179 / AC-175 各自的 spec（各认各的 AC）；不改 `goal_ac` 归属。

**AC-172 记录的修订（written reason）**：在 `goals/AC-172-真实浏览器里常驻会话的状态标记-状态条与关闭按钮反映宿主状态-无人轮带触发类型标签.md` 的 body 追加一段日期化 `## 修订记录（2026-10-02）`，逐字写明上面 §「为什么」的两句被 AC-188 / `ad1bb63a` 合法退役、本判据现测的是幸存保证。**不编辑 frontmatter**（`quay goal write` 无 `--expect` 写面，直编 frontmatter 的 `: ` / 折叠标量风险会整店变空），`criterion` / `status: achieved` / `goal: GOAL-013` 逐字不动。

## AC

- [x] AC1 判据翻绿：`npx playwright test e2e/resident-status-bar.spec.ts` 退出 **0**，4 个用例全过，且 stdout 的 `elapsed=NNNNms` < 55_000（不触发 `SINGLE_SPEC_CEILING_MS`）。验证：`echo $?` + `4 passed` + `elapsed=` 三行逐字登记（红态基线见 Proposal：EXIT=1 / wall 41882ms / `:816` `element(s) not found`）。
- [x] AC2 会话内读数锚不再指向退役标记：`grep -n 'data-resident-status-bar\|data-resident-status-bar-trigger\|data-resident-state-text\|data-lease-kind\|data-resident-ui-state' e2e/resident-status-bar.spec.ts` 输出为**空**（注释行亦不得出现）；同文件 `grep -c 'data-activity-dock\|data-resident-mark\|data-resident-panel'` ≥ 1。验证：两条命令逐字输出。
- [x] AC3 没有回补死契约：生产代码 `grep -rn 'data-resident-status-bar\|data-resident-ui-state\|data-lease-kind' src/ --include=*.tsx --include=*.ts | grep -v /tests/` 输出为**空**（AC-188 仍绿的条件）。验证：该命令逐字输出为空。
- [x] AC4 四态读数仍在且承重：`e2e/resident-status-bar.spec.ts` 的 walk 用例仍断言 unstarted/idle/busy/exited 四态，且每一态与 `GET /api/session-hosts` 的宿主读数比对（不是本地镜像）；四态读数经 `readMark` 的 `data-resident-state` / `data-resident-mark` 取得。验证：`grep -n "data-resident-state\|readMark(" e2e/resident-status-bar.spec.ts` 输出 + 一次绿 run 的 `state=` / `mark=` 打印。
- [x] AC5 被退役的两句读数如实移除并留书面理由：spec 里不再有基于 `data-resident-state-text` 的状态字样断言、也不再有任何租约计数断言（`LEASE_PILL` / `data-lease-kind` / `readCountReading` / `describeCounts` / `totalOf` 均不再出现）；且 `goals/AC-172-*.md` 的 body 新增一段日期化修订记录，逐字点名 **AC-188** 与 **ad1bb63a**，写明会话内忙闲字样与租约计数已合法退役、判据现测幸存保证。验证：`grep -n 'LEASE_PILL\|data-lease-kind\|readCountReading\|describeCounts\|totalOf\|data-resident-state-text' e2e/resident-status-bar.spec.ts` 输出为空 + `grep -n 'AC-188\|ad1bb63a' goals/AC-172-*.md` 命中 ≥ 2 + `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal show AC-172 --root /data/home/yale/work/claudecodeui` 的 `criterion` 逐字不变、`status: achieved`、`goal: GOAL-013`。
- [x] AC6 承重假形态仍然红（两条）：(i) 把侧栏标记的状态源改成**本地镜像**（场景切换状态后不再跟随宿主接口）⇒ 判据退出**非 0**，红落在四态那条读数上；(ii) 把无人轮渲染成用户消息样式（`isUserStyle` 为真 / 去掉 `unattended` 行类）⇒ 判据退出**非 0**，红落在无人轮那条断言上。两条都登记变异 diff、失败断言逐字、退出码；恢复后判据回 0。验证：两次变异跑与两次还原跑的 `echo $?`。
- [x] AC7 幸存读数未删弱：坞展开面板里的地址复制（`data-resident-copy`）与关闭常驻进程（`data-resident-close`）、composer 停止只中止一轮、无人轮分隔标签/发送方/非用户样式这些断言在 spec 里**逐字保留**（只允许 locator / 锚替换，不允许删除或放宽）。验证：`grep -c "a turn nobody typed must not wear the user's own bubble style"` ≥ 1、`grep -c "stopping a turn must not replace the process"` ≥ 1、`grep -c "a stopped turn must not close the host"` ≥ 1、`grep -c "data-resident-copy\|data-resident-close"` ≥ 1，四条逐字登记。
- [x] AC8 边界：`git diff develop -- package.json playwright.config.ts` 为空；`git diff develop -- e2e/resident-status-bar.spec.ts` 不新增 `test.skip` / `retries`；`npx playwright test e2e/resident-status-bar.spec.ts --list` 仍列出 **4** 个用例（walk 用例标题去掉「the counts track the leases」子句须登记，其余标题逐字不变）；`npm run typecheck` 退出 0。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑 `npx playwright test e2e/resident-status-bar.spec.ts` 翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-172 的台账尾部不再是 CURRENTLY FALSE），且这条绿不是「恰好那次没抖」——AC1 的 `4 passed` 与 `elapsed=` 逐次写进完成记录，AC6 两条假形态的变异 diff / 失败逐字 / 退出码与还原读数一并登记。完成记录必须如实写明这一次红的性质：**不是**产品修复——AC-172 的产品保证（侧栏四态标记、坞面板的地址 / pid / 起停关闭、停止只中止一轮、无人轮分隔）自 `ad1bb63a` 起仍在，本轮实测仍成立；失效的是判据的**量具**：会话内状态条的旧标记在并进活动坞时退役，而该提交只回灌了两份 spec。其中「会话内忙闲字样 + 租约计数」两句已被更新的 **AC-188** 合法退役（其落地任务 `gap-activity-single-dock-global-consistency` 的 AC4 逐字要求这些计数为 0），故判据的读数面随之收窄到幸存保证——**不许**为旧标记往生产代码补死契约（AC3 机械证明），**不许**用改判据命令 / skip / retries / 删幸存断言换绿。

L_D：该轴仍暗，理由：本任务只把一条 AC 判据的读数锚跟着一次产品重构收尾，不产出新的领域判据，无可读的两轴读数。

## Touches

- e2e/resident-status-bar.spec.ts
- goals/AC-172-真实浏览器里常驻会话的状态标记-状态条与关闭按钮反映宿主状态-无人轮带触发类型标签.md
- tasks/gap-ac172-criterion-anchor-retired-by-dock-consolidation.md

## 完成记录

**这一次红的性质（如实登记）：不是产品修复，是「量具跟着产品走」的收尾。** AC-172 的产品保证 —— 侧栏四态标记、坞展开面板里的地址 / pid / 起停关闭、composer 停止只中止一轮、无人轮分隔标签 / 发送方 / 非用户样式 —— 自 `ad1bb63a` 起仍在，本轮实测仍成立（绿 run 读数见下）。失效的是判据的**量具**：会话内状态条的旧标记在并进活动坞时退役，而那次提交只回灌了 `activity-dock-truthful` 与 `mobile-workspace-composer-layout` 两份 spec。其中「会话内忙闲字样 + 租约计数」两句已被更新的 **AC-188** 合法退役（其落地任务 `gap-activity-single-dock-global-consistency` 的 AC4 逐字要求这些计数为 0），故判据的读数面随之收窄到幸存保证。**未**为旧标记往生产代码补死契约（AC3 机械证明），**未**用改判据命令 / skip / retries / 删幸存断言换绿。

**实测读数（逐次）：**

- 绿 run（实现后）：`EXIT=0`，`4 passed (31.2s)`，`elapsed=31160ms` < 55_000。四态读数逐字：`state=空闲 mark=solid snapshot.state=idle`（START 后）、`state=运行中 mark=solid+spinner snapshot.state=busy`、`state=空闲 mark=solid snapshot.state=idle`（turn 结束）、`state=exited(oom) mark=exited snapshot.state=closed closeReason=exited detail=oom`；arm A 关进程后 `state=未运行 mark=hollow`。四态皆经 `readMark` 的 `data-resident-state` / `data-resident-mark` 取得，逐态与 `GET /api/session-hosts` 读数比对（非本地镜像）。
- 绿 run（AC6 还原后复跑）：`EXIT=0`，`4 passed (31.9s)`，`elapsed=31838ms`。
- AC6(i) 变异（侧栏标记改本地镜像：`ResidentMark.tsx` 加模块级 `MIRROR` Map，首次读数即冻结，不再跟随 `GET /api/session-hosts`；diff 见实施 commit 记录）：`EXIT=1`，红落在四态读数，逐字 `Error: expect(locator).toHaveAttribute(expected) failed` / `Locator: locator('a[href="/session/<id>"]').first().locator('[data-resident-mark]')` / `Expected: "idle"` / `Received: "unstarted"` / `Timeout: 15000ms`，失败行 `> 790 | await expect(markOf(page, armA)).toHaveAttribute('data-resident-state', 'idle', { timeout: 15_000 });`。还原后回绿。
- AC6(ii) 变异（无人轮渲染成用户消息样式：`MessageComponent.tsx` 改为 `data-message-style={rendersAsUser || isUnattendedTurn ? 'user' : message.type}`）：`EXIT=1`，红落在无人轮断言，逐字 `Error: a turn nobody typed must not wear the user's own bubble style` / `expect(received).not.toBe(expected)` / `Expected: not "user"`，失败行 `> 1108 | expect(row.style, 'a turn nobody typed must not wear the user\'s own bubble style').not.toBe('user');`。（该变异首跑曾先在 `:963` 的 post-`reload` 落地处发生一次既有的启动竞态红——`element(s) not found`——复跑即落在承重断言上。）还原后回绿。
- 机械核查：AC2 两条 grep（退役标记 = 空；`data-activity-dock\|data-resident-mark\|data-resident-panel` = 5）；AC3 `grep -rn 'data-resident-status-bar\|data-resident-ui-state\|data-lease-kind' src/ --include=*.tsx --include=*.ts | grep -v /tests/` = 空；AC5 spec 内 `LEASE_PILL\|data-lease-kind\|readCountReading\|describeCounts\|totalOf\|data-resident-state-text` = 空、`goals/AC-172-*.md` 命中 `AC-188\|ad1bb63a` = 3 行、`quay goal show AC-172` 的 `criterion` 逐字不变 / `[achieved]` / `→ GOAL-013`；AC7 四条 `grep -c` 均 ≥ 1；AC8 `git diff develop -- package.json playwright.config.ts` = 空、spec diff 无新增 `test.skip`/`retries`、`--list` = 4 个用例、`npm run typecheck` = `EXIT=0`。
