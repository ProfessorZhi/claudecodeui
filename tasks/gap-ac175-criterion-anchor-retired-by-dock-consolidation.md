---
id: gap-ac175-criterion-anchor-retired-by-dock-consolidation
title: AC-175 判据的「忙」读数锚 [data-resident-status-bar] / data-resident-ui-state
  被活动坞合并 ad1bb63a 退役，npx playwright test e2e/resident-busy-send.spec.ts
  在首条「会话忙」等待 30s 超时（element(s) not found）记红——把该 spec 的三处读数换锚到合并后的
  [data-activity-dock] + data-activity-state="in-turn"，判据的
  QueuedMessageCard/标注/撤回三态/per-run 正控制逐条保留
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-175
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-02，checkout `/data/home/yale/work/claudecodeui`，HEAD `10aeb20f`，branch `author`）：`grep -rln '^goal_ac: *AC-175' tasks/` → 2 份，`gap-claude-resident-busy-send-ui`（status: done，建了判据本体与整条 `command_lifecycle` 路径）与 `gap-activity-heartbeat-frame-crashes-realtime-merge`（status: done，修的是同判据的另一层——`activity.heartbeat` 无 id 帧毒化 merge 让「已撤回」不渲染）。**两条都 done，按规则不是重复，而是「上一次的修法没兜住」的证据。** 在飞认领者（todo/ready/needs-human）实测：`grep -l '^status: \(todo\|ready\|needs-human\)' tasks/*.md` 的 6 份里，顶层 `goal_ac` 为 AC-190 / AC-208 / AC-142，**无一为 AC-175**。机制侧：做活动坞合并的 `gap-activity-single-dock-global-consistency`（done）与其收尾 `gap-ac178-criterion-anchor-retired-by-dock-consolidation`（done）**逐字把自己的非目标写成「不修 AC-177 / AC-179 / AC-175（`e2e/resident-busy-send.spec.ts:80` 同因的那条红）」**——即 AC-175 的换锚是被显式让位、留给独立任务的，无人认领。⇒ 本条不是重复。

**判据物（逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`）**：`npx playwright test e2e/resident-busy-send.spec.ts`。`expect` 逐字（同文件）：「基准已定（E2/E3 与 E9 9.8 一致，人 yale 已确认）：忙时推入的消息另起一轮，不并入当前回答……(1) 发送后不出现 QueuedMessageCard，消息立即出现在记录里，标注为「将在当前回答结束后处理」；(2) 消息尚未出队时带 [撤回]，点击后场景收到对应 uuid 的 cancel_async_message；界面在收到 cancelled 事件后提示「已撤回」并把该消息从记录中移除、不产生一轮，未收到 cancelled 事件前不显示「已撤回」；(3) 出队（started）后 [撤回] 消失，显示「已开始处理」；(4) per-run 会话忙时仍出现 QueuedMessageCard。取假形态：(a) 常驻会话仍走本地排队 ⇒ (1) 必须红；(b) 撤回只在前端隐藏 ⇒ (2) 必须红；(c) 点击后立即显示「已撤回」而不等 cancelled 事件 ⇒ (2) 必须红。」

**本轮直接测量（不是台账尾巴，也不是推断）。** 在净检出 HEAD `10aeb20f` 上按判据命令逐字重跑：

```
$ npx playwright test e2e/resident-busy-send.spec.ts
Running 3 tests using 1 worker
✘ 1 e2e/resident-busy-send.spec.ts:615:3 › resident busy send › a busy resident session takes the message, and the withdrawal is the process's own act (30.2s)
- 2 ...every shipped locale carries the keys a held command draws
- 3 ...the run ends inside the ceiling the goal gate kills at
1 failed / 2 did not run
Error: expect(locator).toBeVisible() failed
Locator: locator('[data-resident-status-bar]')
Expected: visible / Timeout: 30000ms / Error: element(s) not found
  at e2e/resident-busy-send.spec.ts:624:37
```

红落在判据的**第一条读数**——「会话忙」等待（`e2e/resident-busy-send.spec.ts:624`），**根本没走到 AC 的任何一条断言**。同一次运行的页面快照（`test-results/.../error-context.md`）里，会话已打开、坞已在画「Working… 25s」与 Stop / Resident process details，产品面正常；缺的只是本 spec 读的那个旧标记。

**机制。** `ad1bb63a`（"activity dock: one dock, one source, one answer"，2026-10-02 15:40，已在 `develop` 与 `author`）把常驻状态条并进活动坞：生产代码里 `grep -rn 'data-resident-status-bar\|data-resident-ui-state' src/ --include=*.tsx --include=*.ts`（排除 tests）→ **0 命中**；坞改发 `[data-activity-dock]` + `data-activity-state`（`ActivityIndicator.tsx:151-155`；`ActivityDockState = 'hidden' | 'in-turn' | 'unreachable' | 'send-failed'`，`src/shared/types.ts:328`），常驻会话无回合时以 `persistWhenIdle` 保持 `idle`。而本判据 spec 从建起从未改过锚（`git log --oneline -- e2e/resident-busy-send.spec.ts` → 只有 `21a95867`）：`:80` 的 `const BAR = '[data-resident-status-bar]'`、`:625`/`:737` 的 `toHaveAttribute('data-resident-ui-state', 'busy')` 全指向已退役契约。**忙的继任读法是 `data-activity-state="in-turn"`**——`e2e/activity-dock-truthful.spec.ts:651` 逐字用它读「回合在飞」。

**修法（本轮已实测翻绿，是探针不是落地）。** 把三处读数换锚：`:80` → `const BAR = '[data-activity-dock]'`；`:625`、`:737` → `toHaveAttribute('data-activity-state', 'in-turn', …)`。在净检出的同一 HEAD 上**只改这三行**后重跑：**`3 passed (36.6s)`**（`elapsed=37144ms` < 55s 门限），且 stdout 逐条读数正确：`resident.queuedCard=0`、`resident.row.annotationKey=resident.pending.annotation`、`resident.row.annotation=Will be handled after this answer finishes`、`withdraw.visibleBefore=true` / `click.dispatched=true` / `ui.withdrawnBeforeEvent=false` / `ui.withdrawnAfterEvent=true` / `row.presentAfter=false` / `turnsAfterWithdraw=0` / `turns.control=1`、`beforeStarted.withdrawButton=1` / `afterStarted.withdrawButton=0` / `afterStarted.annotationKey=resident.pending.started` / `afterStarted.label=Started processing`、`perRun.queuedCard=1`。即**前一层的修复（心跳帧，`6a5ba32d`）是好的，卡住的只是量具**；换锚后判据的每条断言（含三条假形态的分辨力）逐条复活。（探针后已把 spec 还原到净检出态，未留下改动。）

**为什么早先的 done 没兜住。** `gap-claude-resident-busy-send-ui`（done）建的是判据本体；`gap-activity-heartbeat-frame-crashes-realtime-merge`（done，修法 `6a5ba32d` 2026-10-02 12:10）修的是 merge 被无 id 帧毒化的问题，**在 15:40 的坞合并之前验证通过**；`gap-ac178-criterion-anchor-retired-by-dock-consolidation`（done）把自己的 spec `e2e/resident-ui-layout.spec.ts` 换好锚，并在非目标里逐字把 AC-175 留出。此后没人再动 `e2e/resident-busy-send.spec.ts`，于是判据从 15:40 起恒红在第一条等待。本条正是那次显式让位的收尾。

**非目标。** 不改判据命令、不改门限与 `SINGLE_SPEC_CEILING_MS`；不加 `retries`、不 skip、不 stub；**不复活旧状态条、不为兼容旧标记往生产代码补回 `data-resident-status-bar` / `data-resident-ui-state`**（那等于往生产里加回死契约）；不改写 expect 语义或删断言——换锚只换 locator 与属性名/属性值，`QueuedMessageCard`、标注、撤回三态、per-run 正控制的判别力逐条保留；不修 AC-177 / AC-179（各自的 spec 各自认领）。

## Touches

- `e2e/resident-busy-send.spec.ts`（换锚三处：`:80` 的 `BAR`、`:625` 与 `:737` 的忙态属性）
- `tasks/gap-ac175-criterion-anchor-retired-by-dock-consolidation.md`（本任务自身）

## AC

- [x] `npx playwright test e2e/resident-busy-send.spec.ts` 退出码 0、输出含 `3 passed`、墙钟 < 55_000ms、无 `skipped`。
- [x] `grep -n "data-resident-status-bar\|data-resident-ui-state" e2e/resident-busy-send.spec.ts` → 0 命中；`grep -n "const BAR = " e2e/resident-busy-send.spec.ts` 读回 `'[data-activity-dock]'`；`grep -n "data-activity-state" e2e/resident-busy-send.spec.ts` 命中 `:625` 与 `:737` 且属性值为 `in-turn`。
- [x] 同一次运行 stdout 逐条读到：`resident.queuedCard=0`、`resident.row.annotationKey=resident.pending.annotation`、`withdraw.visibleBefore=true`、`click.dispatched=true`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`beforeStarted.withdrawButton>=1`、`afterStarted.withdrawButton=0`、`afterStarted.annotationKey=resident.pending.started`、`perRun.queuedCard=1`。
- [x] `grep -rn "data-resident-status-bar\|data-resident-ui-state" src/ --include=*.tsx --include=*.ts | grep -v /tests/` → 0 命中（证明换的是量具，不是往生产补回死标记）。

## DoD

换锚后的 `e2e/resident-busy-send.spec.ts` 起真 Chromium + 真后端 + 调试 agent 的常驻替身，真的让三个会话各自处于忙，真的推入消息并按 AC 的 (1)-(4) 逐条读出；判据命令在落地后的树上按原命令重跑，退出 0、墙钟 < 55s、`3 passed`。三条假形态仍须有分辨力：常驻仍本地排队 ⇒ (1) 红；撤回只在前端隐藏 ⇒ (2) 红（场景零 `cancel_async_message`）；点击即标已撤回 ⇒ (2) 红（未收到 `cancelled` 就读到「已撤回」）。完成后 AC-175 在驱动器下一轮以 `goal_ac: AC-175` 独立复跑时由红翻绿。**不**以「文件改了/测试存在」收工——读数必须是 `3 passed` 及其 stdout 逐行。

## Notes

换锚三处（`:80` 的 `BAR`、`:625`/`:737` 的忙态属性），断言语义零改动。判据在落地树上按原命令重跑：`3 passed`，exit 0，墙钟 37034ms < 55_000ms，AC 列的 12 条 stdout 读数逐条命中。

**承重控制（本轮实测）**：把三处锚还原成已退役的 `[data-resident-status-bar]` / `data-resident-ui-state` 后重跑 → exit 1，红落在 `:624` `locator('[data-resident-status-bar]')`（element(s) not found），与立案记录的签名逐字相同 ⇒ 红可归因于旧锚，新锚正是让它翻绿的那一处（判据不是恒真）。

**三条假形态（本轮实测，逐条变异后还原）**：

- (b) 撤回只在前端隐藏：`ChatInterface.tsx:399` 的 `handleWithdrawResidentCommand` 改为不发 `chat.cancel-queued` → exit 1，红落在 `:677` `cancelPayloads >= 1`（「the click must reach the process that holds the command」），同 run `resident.queuedCard=0` 仍正确读出 ⇒ 场景零 `cancel_async_message` 必红。
- (c) 点击即标已撤回：`useChatRealtimeHandlers.ts:471` 那条被显式丢弃的 `queued_input_cancel_result` ack 改为直接 `applyCommandLifecycle(…, 'cancelled')` → exit 1，红落在 `:691` `withdrawnBeforeEvent === 0`，读数 `ui.withdrawnBeforeEvent=true` ⇒ 未收到 `cancelled` 就读到「已撤回」必红。
- (a) 常驻仍本地排队：本轮未做端到端变异（`busySendGoesToProcess` 只决定按钮文案，不是路由；诚实记下未完成）。该读数在同一次绿跑里有阳性对照：`perRun.queuedCard=1` 证明计数法在同 run 能数到卡，故 `resident.queuedCard=0` 即「常驻没走浏览器队列」。

（三处变异均已 `git checkout --` 还原：落地树 = 提交 a6a9ed26，工作区干净。）
