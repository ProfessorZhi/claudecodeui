---
id: gap-ac177-criterion-anchor-retired-by-dock-consolidation
title: AC-177 判据（窄视口常驻弹层关闭按钮可点）的读数锚 [data-resident-status-bar] /
  [data-resident-status-bar-trigger] / [role=dialog] / data-resident-ui-state
  被活动坞合并 ad1bb63a 退役，npx playwright test e2e/resident-ui-layout.spec.ts -g
  "close is reachable" 在首条正信号等待处 30s 超时（element(s) not found）记红——把读数锚回灌到合并后的
  [data-activity-dock] / [data-activity-dock-toggle] /
  [data-resident-panel]，并按合并后的展开面板重排「先展开面板再点起停控件」，同时把结构性恒真的 hitInComposer
  收窄到输入表单
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-177
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，不是关键字碰运气）：`grep -l '^goal_ac: *AC-177' tasks/*.md` → **2** 份，均 **status: done**（`gap-resident-popover-close-reachable-narrow-viewport`、`gap-resident-ui-layout-criterion-bounded-boot-guard`）——按规则 done 不是重复，而是「上一次的修法没兜住」的证据。在飞任务（todo/ready/needs-human）实测 2 份带 `goal_ac`（`gap-activity-dock-human-gate` AC-190、`gap-activity-dock-phase-truthful` AC-187），**无一认领 AC-177**。机制侧扫描：最接近的邻居 `gap-ac178-criterion-anchor-retired-by-dock-consolidation`（done）与 `gap-ac172-criterion-anchor-retired-by-dock-consolidation`（done）是**同源机制的另外两个实例**——同一次产品重构（活动坞合并 `ad1bb63a`）退役了同一族旧标记，各自把退役锚回灌到自己那份 spec；AC-178 那条任务体的非目标逐字写「不修 AC-177 / AC-179」，故它没有、也不打算处理本条的 AC-177 用例。三条 AC（172 / 178 / 177）不同 AC，部分同一文件但**不同 test**，机制同源而不相交。⇒ AC-177 无在飞认领者，本条不是重复。

**判据物**：`criterion:` 逐字 `npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"`。门限不变：driver-anchor 下 goal gate 的硬 60s；`playwright.config.ts` 的 `SINGLE_SPEC_CEILING_MS = 55_000`（spec 里 `elapsed < 55_000` 钉此数）。

**红态基线（本轮立案前直接重跑判据本身，读它的失败输出，不读台账 `reason` 的 stderr 尾巴）**：命令同上 → **1 failed**，失败逐字：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('[data-resident-status-bar]')
Expected: visible   Timeout: 30000ms   Error: element(s) not found
  > 1036 |     await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
     at /data/home/yale/work/claudecodeui/e2e/resident-ui-layout.spec.ts:1036:37
1 failed
```

即判据死在**第一条正信号等待**上，一个 popover 读数都没取到。同轮 stdout 另证不是启动期那条老路：`[e2e] client startup: the project row for resident-ui-layout-workspace landed after 2404ms (attempt 1)`（有界预热 + 探针工作正常）。

**因果括号（台账时间戳，criterionHash 最后一次绿与两次红相同）**：

- `2026-10-02T07:47:15.756Z` — goal-sweep **pass**（AC-177 最后一次绿，`criterionHash: 953a10c122926b47`）
- `ad1bb63a`（`activity dock: one dock, one source, one answer`）提交于 `2026-10-02 15:40:33 +0800` = `07:40:33Z`，经 fan-in `92ce6fdd`（`2026-10-02 16:35:44 +0800` = `08:35:44Z`）落到 develop
- `2026-10-02T10:27:48.037Z` goal-sweep **fail**（首个红）、`10:31:11.963Z` goal-cli **fail**（`criterionHash` 仍 `953a10c122926b47`）

判据文本一字未动（hash 相同）⇒ 动的是环境，不是判据；最后一次绿落在 `ad1bb63a` 进 develop 之前、首个红落在其后。

**机制。** `ad1bb63a` 把常驻状态条并进活动坞：`ResidentStatusBar` → `ResidentPanel`，生产代码里的 `data-resident-status-bar` / `data-resident-status-bar-trigger` / `data-resident-ui-state` 被删除；坞改用 `[data-activity-dock]` + `data-activity-state`（`src/modules/chat/composer/ActivityIndicator.tsx:138-142`），以 `[data-activity-dock-toggle="true"]` 作展开入口（`:248`）、`[data-activity-dock-panel="true"]` 装 `ResidentPanel`（`:271`，其根是 `data-resident-panel`，`src/modules/chat/transcript/ResidentStatusBar.tsx:133`）。生产代码实测（排除 node_modules 与 worktrees）：`grep -rn 'data-resident-status-bar\|data-resident-ui-state' src/ --include=*.tsx --include=*.ts | grep -v /tests/` → **0**。`git show --stat ad1bb63a` 的 e2e 只列了 `activity-dock-truthful.spec.ts` 与 `mobile-workspace-composer-layout.spec.ts` 两份（提交信息也自述「the two specs that addressed the old markers by name」）——**越过了**同样按旧标记寻址的 `e2e/resident-ui-layout.spec.ts`（AC-177 / AC-179 两半；AC-178 那半已由 `gap-ac178-…` 回灌）。

**为什么「上一次的修法没兜住」必须如实读成「判据的量具退役、产品保证仍在」，而不是「去修一个本来就对的产品」。** AC-177 的产品保证——窄视口下常驻弹层的关闭按钮可点（`elementFromPoint` 命中自身）、真实点击后宿主读回 `closed`——其落地修法 `7b0e553d`（`fix(chat): portal the resident popover out of the transcript clip`）与 `e0a601b8`（`fix(chat): keep the resident status bar out of the transcript's scroll box`）今天仍在：关闭 / 启动 / 地址 / 复制四控件由 `ResidentPanel` 发布 `data-resident-close` / `data-resident-start` / `data-resident-address` / `data-resident-copy`（`ResidentStatusBar.tsx:140/164/176/192`），现在挂在坞的展开面板里。失效的是判据的**量具**：它用来寻址状态条与弹层的旧标记（`[data-resident-status-bar]` 作 BAR、`[data-resident-status-bar-trigger]` 作 TRIGGER、`close.closest('[role="dialog"]')` 作弹层、`data-resident-ui-state` 作就绪信号）在并进活动坞时退役，而那次提交只回灌了两份 spec。本条**不是**「修一个本来就对的产品」，是「量具跟着产品走」的收尾。

**修法（最小充分，只动 spec，不发明新机制；本轮已实测探针，见下）。** 只改 `e2e/resident-ui-layout.spec.ts` 的 AC-177 那一半（`test.describe('resident ui layout', …)`，用例起于 `:1029`）：

1. **会话内入口**：AC-177 用例对状态条根的读数（BAR，`:1036`）从退役的 `[data-resident-status-bar]` 换成坞根 `[data-activity-dock]`。`const BAR`（`:30`）是 AC-179 共享常量，故按 `gap-ac178-…` 的外科式先例在 AC-177 用例内**局部遮蔽**（`const BAR = '[data-activity-dock]';`），**不动** AC-179 的共享 `BAR`。
2. **展开入口**：`const TRIGGER`（`:764`）从 `[data-resident-status-bar-trigger]` 换成 `[data-activity-dock-toggle="true"]`（`ActivityIndicator.tsx:248`，由 `persistWhenIdle === isResidentSession` 门控，与旧状态条「只对已常驻会话渲染」同理）。
3. **弹层锚**：`measure`（`:909`）的 `close?.closest('[role="dialog"]')` 换成 `close?.closest('[data-resident-panel="true"]')`——合并后的常驻面板不再是 `role="dialog"`，其根是 `data-resident-panel`。
4. **面板要先展开、起停控件在其中**：合并后 `[data-resident-start]` / `[data-resident-close]` / `[data-resident-address]` 都在展开面板里（`persistWhenIdle && panelOpen` 才渲染，`ActivityIndicator.tsx:270-273`）。现用例在 `:1046` 先点 START、`:1055` 才点 TRIGGER 打开弹层——顺序必须改成**先点 TRIGGER 展开面板 → 点 START → 读 ADDRESS → 点 CLOSE**（`panelOpen` 是组件态，点 START / 走 clock 不会关闭它）。
5. **就绪信号**：`:1048` 的 `toHaveAttribute('data-resident-ui-state', 'idle')` 随状态条一并退役，换成一个幸存信号——等 `[data-resident-start]` 从面板消失（host 一旦存活，该控件不再渲染，见 `ResidentStatusBar.tsx:173-188` 的 `!occupied && (!hostAlive || lastReadFailed)` 条件），用 `toHaveCount(0)` 有界等待；**不得**用 `waitForTimeout` 代替（会变成竞态）。
6. **`hitInComposer` 收窄到输入表单（本轮探针发现的关键点，防「删断言换绿」）**：`measure` 里 `const composer = document.querySelector('.chat-composer-shell')` 读的是**整个输入区外壳**；合并后坞（及其面板）就渲染在这个外壳内（`ChatComposer.tsx:529` 的 `.chat-composer-shell` 是根，坞是其中 `absolute bottom-full` 的一层），故 `hitInComposer` 恒为 true、`expect(narrow.hitInComposer, …).toBe(false)` 结构性必红。把该选择器收窄为**输入表单** `.chat-composer-shell form`（`PromptInput.tsx:39` 渲染 `<form>`），断言文本 `nothing in the composer may take the pointer at the close button` **逐字保留**——语义仍是「输入区自己的表单不得盖住关闭按钮」，且仍能红（表单若盖住关闭按钮，`elementFromPoint` 命中的会是表单后代 ⇒ true）。
7. **承重读数逐字保留**：窄视口 `hit.isClose=true`、`panel.inPane=false`、`notice.present=false`（AC-178 保证）、正控制 1440×900 `hit.isClose=true`、注入 `data-e2e-falsifier="cover"` 后 `isClose=false` 且 `hit` 点出该元素、移除后恢复、真实点击后 `state=closed` / `closeReason=user` / 不再 live——断言文本与假形态**逐字保留**，只允许替换 locator / 锚 / 就绪信号。

**探针（本轮两次直接实测，改动已 `git checkout` 还原，工作树干净）**：按上面 1–6 改动后 `npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` → **PIPE_EXIT=0**，`1 passed (11.7s)`，`elapsed=11901ms`。逐字读数：窄视口 `hit.element=button data-resident-close="true" hit.isClose=true`、`notice.present=false`、`panel.inPane=false`、`hit.inComposer=false`（表单口径）；`falsifier.hit.element=div data-e2e-falsifier="cover" falsifier.hit.isClose=false`；宽视口 1440×900 `hit.isClose=true`；`host.present=true`；`close.request=200 host.state.after=closed closeReason.after=user liveHost.after=absent`。第一次探针（只换 BAR/TRIGGER/弹层锚 + 重排顺序，未收窄 composer 口径）在 `:1100` 的 `hitInComposer` 上红（`Received: true`），正是第 6 点的证据。⇒ 产品保证成立、锚可换、判据能在 55s 预算内翻绿，**无需改任何生产代码**。

**⛔ 不变式**：判据命令不改；60s 门限与 `SINGLE_SPEC_CEILING_MS = 55_000` 不动；不加 `retries`、不 skip、不 stub；**不**往生产代码补回任何退役标记（会让 AC-188 / 活动坞一致性判据红）；不修 AC-178 / AC-179 的 test（各认各的 AC）；不删启动期有界预热 + 探针（`warmClientStartup` / `navigateBounded`）；不改 `goal_ac` 归属。

## AC

- [x] AC1 判据翻绿：`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` 退出 **0**，1 个用例通过，stdout 的 `elapsed=NNNNms` < 55_000。验证：`echo $?` + `1 passed` + `elapsed=` 三行逐字登记（红态基线见 Proposal：1 failed / `:1036` `element(s) not found`）。
- [x] AC2 AC-177 用例不再指向退役锚或结构上恒真的读数：AC-177 用例区间（约 `:1029`–`:1170`）内 `grep -c 'data-resident-status-bar\|data-resident-ui-state\|role="dialog"'` = **0**（注释行亦不得出现）；同区间 `grep -c 'data-activity-dock\|data-resident-panel'` ≥ 1；且 `measure` 的 composer 选择器为 `.chat-composer-shell form`。验证：三条命令逐字输出。
- [x] AC3 没有回补死契约：生产代码 `grep -rn 'data-resident-status-bar\|data-resident-ui-state' src/ --include=*.tsx --include=*.ts | grep -v /tests/` 输出为**空**。验证：该命令逐字输出为空。
- [x] AC4 承重读数两视口都成立：窄视口 780×493 下 `hit.isClose=true`、`panel.inPane=false`、`notice.present=false`；正控制 1440×900 下 `hit.isClose=true`；真实点击后 `GET /api/session-hosts` 读回该宿主 `state=closed`、`closeReason=user`、不再是 live host。验证：一次绿 run 的 `hit.isClose=` / `panel.inPane=` / `close.request=` / `host.state.after=` / `closeReason.after=` / `liveHost.after=` 打印行。
- [x] AC5 承重假形态仍然红（逐字保留）：注入 `data-e2e-falsifier="cover"` 覆盖关闭按钮中心 ⇒ `falsifier.hit.isClose=false` 且 `falsifier.hit.element` 含 `data-e2e-falsifier="cover"`；移除后 `uncovered.isClose=true`。验证：绿 run 的这三行打印 + `git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^-.*data-e2e-falsifier'` = 0。
- [x] AC6 只认领 AC-177 的范围：不改 AC-178（`-g "resident session hides enable affordance"`）与 AC-179（`-g "status bar does not cover the transcript"`）命中的 test 标题与其断言。验证：`npx playwright test e2e/resident-ui-layout.spec.ts --list` 退出 0 且仍列出 3 个用例、标题逐字未变；`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^[-+].*test('` = 0。
- [x] AC7 启动期有界守卫未被削弱：`warmClientStartup` / `navigateBounded` / `STARTUP_PROBE_DEADLINE_MS` 仍在，且绿 run stdout 出现 `[e2e] client warm-up:` 与 `[e2e] client startup: … landed after` 两行。验证：两条打印逐字登记 + `git diff develop -- e2e/resident-ui-layout.spec.ts | grep -cE '^-.*(navigateBounded|warmClientStartup)'` = 0。
- [x] AC8 边界：`git diff develop -- package.json playwright.config.ts` 为空；spec diff 不新增 `test.skip` / `retries`；`npm run typecheck` 退出 0。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑 `npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` 翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-177 的台账尾部不再是 CURRENTLY FALSE），且这条绿不是「恰好那次没抖」——AC1 的 `1 passed` 与 `elapsed=`、AC4 的两视口命中与真实关闭读数、AC5 的假形态三行一并逐次写进完成记录。完成记录必须如实写明这一次红的性质：**不是**产品修复——AC-177 的产品保证（窄视口下展开面板里的关闭按钮可点、真实点击关闭宿主）自 `7b0e553d` / `e0a601b8` 起仍在，本轮探针实测仍成立（`hit.isClose=true` 两视口 + `close.request=200` 宿主 `closed`/`user`）；失效的是判据的**量具**：状态条并进活动坞时其旧标记与「坞在输入区外」的旧结构假设一并过时，而 `ad1bb63a` 只回灌了 `activity-dock-truthful` 与 `mobile-workspace-composer-layout` 两份 spec。⛔ **不许**为旧标记往生产代码补死契约（AC3 机械证明），**不许**用改判据命令 / skip / retries / 删承重断言（AC4 / AC5）换绿；`hitInComposer` 只许按 AC2 的读法收窄到输入表单，不许整条删除。

L_D：该轴仍暗，理由：本任务只把一条 AC 判据的读数锚跟着一次产品重构收尾，不产出新的领域判据，无可读的两轴读数。

## Touches

- e2e/resident-ui-layout.spec.ts
- tasks/gap-ac177-criterion-anchor-retired-by-dock-consolidation.md

## 完成记录

**这一次红的性质（如实）**：**不是产品修复**。AC-177 的产品保证——窄视口下展开面板里的关闭按钮可点（`elementFromPoint` 命中其自身）、真实点击后宿主读回 `closed` / `closeReason=user`、不再是 live host——自 `7b0e553d` / `e0a601b8` 起就成立，本任务**一行生产代码未改**（`git diff --name-only develop` 只有 `e2e/resident-ui-layout.spec.ts` 一个文件；AC3 机械证明 `src/` 下退役标记计数为 0）。失效的是判据的**量具**：`ad1bb63a` 把常驻状态条并进活动坞，退役了 `[data-resident-status-bar]` / `[data-resident-status-bar-trigger]` / `data-resident-ui-state`，弹层也不再是 ARIA dialog（改挂 `[data-resident-panel="true"]`），而那次提交只回灌了 `activity-dock-truthful` 与 `mobile-workspace-composer-layout` 两份 spec——本 spec 因此死在首条正信号等待上（`:1036`，`element(s) not found`），一个读数都没取到。本轮只把读数锚与展开顺序跟着产品走。

**唯一一处「不只是换锚」的改动，以及它为什么是必须的**：`measure` 的 `hitInComposer` 从 `.chat-composer-shell` 收窄到 `.chat-composer-shell form`。合并后坞（及其展开面板）就渲染在该外壳之内（`ChatComposer` 的根即 `.chat-composer-shell`，坞是其中 `absolute bottom-full` 的一层），故整壳口径恒为 true、`expect(hitInComposer).toBe(false)` 结构性必红。收窄到输入表单后语义不变（表单若盖住关闭按钮，`elementFromPoint` 命中的会是其后代 ⇒ 仍能红），断言文本逐字未改，**不是删断言换绿**。

**AC1 —— 判据翻绿**：`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` → `PIPE_EXIT=0`、`1 passed`、`elapsed=11227ms`（< 55_000）。merge develop（`bb71e9a0`）后复测同样绿（`1 passed (11.2s)`）；合并前为 `elapsed=17211ms`。两次都没有用 `retries` / `skip` / `waitForTimeout`。

**AC4 + AC5 —— 同一次绿 run 的逐字打印**：

```
viewport=780x493 hit.element=button data-resident-close="true" hit.isClose=true
hit.inNotice=false hit.inComposer=false
notice.present=false panel.inPane=false popover.overlapsPaneEdge=true
falsifier.hit.element=div data-e2e-falsifier="cover" falsifier.hit.isClose=false
uncovered.isClose=true
viewport=1440x900 hit.element=button data-resident-close="true" hit.isClose=true panel.inPane=false
host.present=true host.id=host-2ed1875d-861f-41bd-b1c1-39b1581fb935
close.request=200 host.state.after=closed closeReason.after=user liveHost.after=absent
```

`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^-.*data-e2e-falsifier'` = 0（假形态三处断言逐字未动；本轮只为「移除后恢复」这条腿补了一行 `console.log`，没有删改任何断言）。

**AC2 / AC3 / AC6 / AC7 / AC8 —— 机械读数**：

- **AC2**：AC-177 用例体（`:1062`–`:1219`）内 `data-resident-status-bar|data-resident-ui-state|role="dialog"` = **0**（注释行亦为 0）；`data-activity-dock|data-resident-panel` = **1**；`querySelector('.chat-composer-shell form')` 出现 1 处。按 AC 原文的 `:1029`–`:1170` 切片复测同为 **0 / 1**。
- **AC3**：`grep -rn 'data-resident-status-bar\|data-resident-ui-state' src/ --include=*.tsx --include=*.ts | grep -v /tests/` → **空（0 行）**——没有为旧标记回补死契约。
- **AC6**：`npx playwright test e2e/resident-ui-layout.spec.ts --list` 退出 0，仍列出 **3** 个用例且标题逐字未变（`status bar does not cover the transcript` / `the popover close is reachable at a narrow viewport and closes the process` / `resident session hides enable affordance`）；`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^[-+].*test('` = **0**（AC-178 / AC-179 的 test 与断言未被触碰；AC-177 用例内**局部遮蔽** `BAR`，模块级共享 `BAR` 原样保留给 AC-179）。
- **AC7**：`warmClientStartup` / `navigateBounded` / `STARTUP_PROBE_DEADLINE_MS` 仍在（14 处引用）；绿 run stdout 出现 `[e2e] client warm-up: pre-bundle committed in 1781ms` 与 `[e2e] client startup: the project row for resident-ui-layout-workspace landed after 2335ms (attempt 1)`；`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -cE '^-.*(navigateBounded|warmClientStartup)'` = **0**。
- **AC8**：`git diff develop -- package.json playwright.config.ts` 为**空**；spec diff 不新增 `test.skip` / `retries`（计数 0）；`npm run typecheck` 退出 **0**（merge develop 后复测仍 0）。
