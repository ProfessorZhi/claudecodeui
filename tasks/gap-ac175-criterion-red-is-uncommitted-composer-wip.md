---
id: gap-ac175-criterion-red-is-uncommitted-composer-wip
title: AC-175 判据在净检出上直跑为绿（3 passed），台账红由主检出的未提交 composer 布局 WIP
  造成：ChatComposer.tsx 用了 cn(...) 未导入 ⇒ ReferenceError 崩掉聊天面板，判据首条「打开会话」30s
  超时——verification-only 归因入档，钉住「未提交 WIP 崩 ≠ AC-175 回归」（remedy：随该 WIP 提交 import {
  cn } from '@/shared/utils'）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-175
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-02，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `ccffe44c`，branch `author`）：`grep -rln '^goal_ac: *AC-175' tasks/` → 4 份，**全部 `status: done`**（`gap-claude-resident-busy-send-ui`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`，以及 `gap-resident-composer-hides-enable-affordance` 正文提及）。在飞（todo/ready/needs-human）认领者实测为 **0**：`tasks/` 里 todo/ready/needs-human 的只有 `gap-ac173-badge-source-mismatch-after-dock-consolidation`（goal_ac: AC-173）与 `gap-activity-dock-human-gate`（goal_ac: AC-190）。按「done 不算重复、是更早修复没兜住的证据」本应立新条——但**本条的两处直跑推翻了默认读法**：更早三条修复在净检出上**都还在**，判据净检出直跑为绿，红不在被提交的代码里。

**判据物（逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`）**：`npx playwright test e2e/resident-busy-send.spec.ts`。

**本轮两处直跑（同一 checkout，读数不是推断，也不是台账尾巴）**：

（1）**主检出当前工作树（带未提交改动）直跑 → 红**，退出 1，`1 failed / 2 did not run`：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('.chat-messages-pane')
Expected: visible  Timeout: 30000ms  Error: element(s) not found
  at openSession (e2e/resident-busy-send.spec.ts:352:36)
  at e2e/resident-busy-send.spec.ts:623:5
[e2e] page console error: ErrorBoundary caught an error: ReferenceError: cn is not defined
    at ChatComposer (http://127.0.0.1:.../src/modules/chat/composer/ChatComposer.tsx:288:18)
```

红落在判据的**第一条读数**（`openSession` 等 `.chat-messages-pane`），**根本没走到 AC 的任何一条断言**——聊天面板整棵被 React ErrorBoundary 换掉，pane 永不出现。

（2）**同一 checkout 把 4 个未提交改动 stash 掉、净树（HEAD `ccffe44c` = `develop` 内容）再直跑 → 绿**，退出 0，`3 passed (36.3s)`：

```
resident.queuedCard=0
resident.row.present=true
resident.row.annotationKey=resident.pending.annotation
resident.row.annotation=Will be handled after this answer finishes
withdraw.visibleBefore=true  click.dispatched=true  ui.withdrawnBeforeEvent=false
ui.withdrawnAfterEvent=true  row.presentAfter=false  turnsAfterWithdraw=0
cancelPayloads=1  controlResponsesForCancel=0  cancelVerdictSource=command_lifecycle
afterStarted.withdrawButton=0  afterStarted.annotationKey=resident.pending.started
perRun.queuedCard=1
withdrawn.run.ok=true status=200  started.run.ok=true status=200
  3 passed (36.3s)
```

AC 点名的每一条读数都在场（resident 不走 `QueuedMessageCard`、标注、撤回三态、per-run 正控制）。⇒ **被提交的树满足 AC-175**。

**机制（本轮定位，含崩溃栈）**：主检出工作树里的 4 个未提交改动是一份**尚未提交的 composer 布局 WIP**（短视口 tier + 工具内联 tier：`useDeviceSettings` 加 `isShortViewport`、`useComposerCompactTier` 加 `areToolsInline`、`ChatComposer` 按其改版），配套未跟踪的 `docs/proposals/mobile-workspace-and-composer-layout.md`。其中 `src/modules/chat/composer/ChatComposer.tsx` 未提交版本在 **549** 与 **899** 两处用了 `cn(...)`，却**没有** `import { cn } from '@/shared/utils'`：

```
$ grep -n 'cn(' src/modules/chat/composer/ChatComposer.tsx        # 工作树
549:      className={cn(
899:          className={cn(
$ grep -n "import.*cn" src/modules/chat/composer/ChatComposer.tsx # 无输出（没有导入）
$ git show HEAD:src/modules/chat/composer/ChatComposer.tsx | grep -c '\bcn\b'
0
```

`cn` 定义在 `src/shared/utils.ts:22`，全仓其它调用点一律 `import { cn } from '@/shared/utils'`；没有任何全局声明 ⇒ 既 `tsc` 报 TS2304，运行时又是 `ReferenceError`。浏览器里 ChatComposer 一挂载就抛，ErrorBoundary 接住，聊天面板整棵不渲染 ⇒ 判据首条读音红。**该 WIP 无归属任务**：`grep -rl 'isShortViewport\|areToolsInline\|短视口' tasks/ goals/` → 0；`git log -S isShortViewport -- src/`、`git log -S areToolsInline -- src/` → 0（从未提交）。

**台账归因读数**：`.quay/gate-events.jsonl` 里 AC-175 `gate=goal` 尾巴是 **`pass` 后接 `fail`**：

```
2026-10-02T12:57:14.694Z  goal-cli   pass  acceptance passed (exit 0)
2026-10-02T13:04:26.537Z  goal-cli   fail  acceptance failed (exit 1) — [WebServer] [BABEL] ...（687 chars of stderr omitted）
```

`fail` 时刻（本地 21:04）与未提交 WIP 落进主检出的时刻（`src/shared/tests/useDeviceSettings.test.ts` mtime = 21:02）同窗；12:57 的 `pass` 在 WIP 落地之前。⇒ 台账这次的红是**主检出的未提交物崩**，不是 AC-175 的承诺退化。

**本条的交付面（verification-only，不改实现/判据/宿主配置一个字节）**：把上面两处直跑读数与归因做成**可复核的入档读数**，并钉住判法「未提交 WIP 崩 ≠ AC-175 回归」。**不在未提交物上改代码**：`cn` 缺导入属于那份 composer 布局 WIP 自身，正确落点是随该 WIP 一起提交 `import { cn } from '@/shared/utils'`（由该 WIP 的作者/归属任务处理），本条只登记，不夹带修它，也不改动那份未提交工作树。

## AC

- [x] AC1 判据在**净树**直跑：把主检出的 4 个未提交改动 stash 后（或用隔离 worktree，起点 = `develop`）跑 `npx playwright test e2e/resident-busy-send.spec.ts`，退出 0，把判据自己打印的读数行**逐字**抄进完成记录（`resident.queuedCard=0`、`resident.row.present=true`、`resident.row.annotationKey=resident.pending.annotation`、`withdraw.visibleBefore=true`、`click.dispatched=true`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`controlResponsesForCancel=0`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.annotationKey=resident.pending.started`、`perRun.queuedCard=1`、`withdrawn.run.ok=true`、`started.run.ok=true`、`3 passed`），并给出跑动时刻（`date -u`）与 `git rev-parse HEAD`。
- [x] AC2 归因可复现（⚠️ 本条 dispatch 时**原读数已不可复现**，故按不变量改写；原逐字文本见本行末「原逐字文本」，复核者可回退）。**不可复现证明**：那份未提交 WIP 在本条启动前已被其作者改版 —— `src/modules/chat/composer/ChatComposer.tsx` mtime = `2026-10-02T13:14:32Z`，`cn(...)` 被换成 `[...].join(' ')`；主检出工作树带未提交改动直跑现为绿 （`3 passed (37.2s)`，exit 0，`date -u` = `Fri Oct  2 01:19:39 PM UTC 2026`）；`grep -n 'cn(' src/modules/chat/composer/ChatComposer.tsx` 与 `grep -n "import.*cn" src/modules/chat/composer/ChatComposer.tsx` 现均**无输出**，`git show HEAD:src/modules/chat/composer/ChatComposer.tsx | grep -c '\bcn\b'` = **0**。**改写后的不变量（可证伪）**：ChatComposer 挂载期抛错时，判据在**首条读数**变红 —— `exit 1`、`1 failed / 2 did not run`、`Error: element(s) not found` for `locator('.chat-messages-pane')`、`at openSession (e2e/resident-busy-send.spec.ts:352:36)`、页面 console 逐字 `ErrorBoundary caught an error: ReferenceError: cn is not defined` at `ChatComposer.tsx`。复现方式：在**本条隔离 worktree**（非主检出、非未提交物）临时把 ChatComposer 一处 `className` 改为 `cn(...)` 且不导入（与原件同机制），跑完**立即回退**，并以 `git status --porcelain` 空 + 工作树文件 `git hash-object` == `git rev-parse HEAD:<file>`（`522e42e7067f408248f73ccc854a7834dbd7d5b4`）证明零残留。**原逐字文本**：「在工作树跑 `npx playwright test e2e/resident-busy-send.spec.ts` 复现退出 1 且红在 `e2e/resident-busy-send.spec.ts:352`（`.chat-messages-pane` not found），并从页面 console 抄到 `ReferenceError: cn is not defined` at `ChatComposer.tsx`；同时用 `grep -n 'cn(' src/modules/chat/composer/ChatComposer.tsx` 给出两处调用行、`grep -n "import.*cn" src/modules/chat/composer/ChatComposer.tsx` 给出**无导入**、`git show HEAD:src/modules/chat/composer/ChatComposer.tsx | grep -c '\bcn\b'` 给出 **0**。」
- [x] AC3 台账归因读数（机械）：用 `python3`/`jq` 读 `.quay/gate-events.jsonl`，打印 AC-175 `gate=goal` 尾巴的 `verdict` 序列（应含那对 `pass`→`fail`）、两条的 `timestamp` 与 `payload.reason` 逐字，并指明 `fail` 时刻与该未提交 WIP 的 mtime 同窗。
- [x] AC4 无归属任务读数：`grep -rl 'isShortViewport\|areToolsInline\|短视口' tasks/ goals/`（应为空或只命中本条）与 `git log --oneline -S isShortViewport -- src/`（应为空），证明该 WIP 无 task/commit 认领。
- [x] AC5 如实登记：若本轮之后 driver 的独立复核里 AC-175 `gate=goal` 尾巴仍为 `fail`，完成记录里**逐字写明**「台账尾巴仍是 fail」并附 AC1 的直跑读数，不得写成已通过，也不得用组件层 jsdom 的绿替代浏览器层的绿。
- [x] AC6 字节纪律：`git diff --name-only develop..HEAD` 只含 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md`；未提交的 4 个 composer 文件与本条启动时逐字相同（本条**未**改 `src/**`、`e2e/resident-busy-send.spec.ts`、`playwright.config.ts`、宿主配置一个字节）。

## DoD

- 判据本体（出货命令 `npx playwright test e2e/resident-busy-send.spec.ts`）在**净树**上被真的跑过一次，读数行逐字入档——不是复述 expect 的文字，也不是读台账尾巴。
- 归因段落里的每一条读数（两处 `cn(` 行号、无导入、HEAD `cn` 计数 0、脏树 `ReferenceError` 崩溃栈、`fail` 与 WIP mtime 同窗）都能由任何人在同一 checkout 上复现。
- 完成记录里明确写出「被提交的树满足 AC-175；台账红是主检出的未提交 composer WIP 崩」，并指出 remedy：随该 WIP 提交 `import { cn } from '@/shared/utils'`。
- 交付物只动 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md`：判据文件、实现、未提交工作树、宿主配置一个字节未动。

## Touches

- tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md
- e2e/resident-busy-send.spec.ts （本条只跑不改：AC1/AC2 的判据本体）
- src/modules/chat/composer/ChatComposer.tsx （本条只读不改：未提交 WIP 的 `cn` 未导入证据）

## 完成记录

本条是 **verification-only**：只把可复核的读数入档，不改实现、判据、宿主配置一个字节。判据本体在**本条自己的隔离 worktree** 上被真的跑过（不是复述 expect、不是读台账尾巴）。

- worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-red-is-uncommitted-composer-wip`，分支 `task/gap-ac175-criterion-red-is-uncommitted-composer-wip`
- 起点 = `develop`；`git rev-parse HEAD`（worktree）= `1139ff069cf9a7e8b09236dcf1c9c5ef37a75466`
- ⚠️ **关键前提变更**：本条立案时的「工作树红」在本条 dispatch **之前**已被 WIP 作者自行修掉 —— `ChatComposer.tsx` 的 `cn(...)`（无导入）于 `2026-10-02T13:14:32Z` 被改成 `[...].join(' ')`，主检出工作树带未提交改动直跑现为绿（`3 passed (37.2s)`，exit 0）。因此 AC2 要求的「修前红」**不可复现**，已按不变量改写（见 AC2 与下节 AC2）。

### AC1 判据在净树直跑（`npx playwright test e2e/resident-busy-send.spec.ts`）

跑动窗口 `date -u` = `Fri Oct  2 01:25:33 PM UTC 2026` → `01:26:10 PM UTC 2026`（= `2026-10-02T13:25:33Z` → `13:26:10Z`）；`git rev-parse HEAD`（worktree）= `1139ff069cf9a7e8b09236dcf1c9c5ef37a75466`；工作树净（`git status --porcelain` 空）。退出码 **0**。判据自己打印的读数行**逐字**抄录：

```
[WebServer] No .env file found or error reading it: ENOENT: no such file or directory, open '/data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-red-is-uncommitted-composer-wip/.env'

Running 3 tests using 1 worker

resident.queuedCard=0
resident.row.present=true
resident.row.annotationKey=resident.pending.annotation
resident.row.annotation=Will be handled after this answer finishes
resident.row.text="draft one — the process has not taken this yet Will be handled after this answer finishes Withdraw"
withdraw.visibleBefore=true
click.dispatched=true
ui.withdrawnBeforeEvent=false
ui.withdrawnAfterEvent=true
row.presentAfter=false
row.textAfter="Withdrawn"
turnsAfterWithdraw=0
turns.control=1
cancelPayloads=1
scenario.cancel_async_message=703605ab-3089-47ff-94b6-32d055346b8e
controlResponsesForCancel=0
cancelAckFrames=1
cancelVerdictSource=command_lifecycle
beforeStarted.withdrawButton=1
afterStarted.withdrawButton=0
afterStarted.annotationKey=resident.pending.started
afterStarted.label=Started processing
perRun.queuedCard=1
perRun.card.text="QUEUED · Will send when this finishes draft three — this one waits for the browser"
perRun.card.label=Queued
withdrawn.run.ok=true status=200
started.run.ok=true status=200
  ✓  1 e2e/resident-busy-send.spec.ts:615:3 › resident busy send › a busy resident session takes the message, and the withdrawal is the process's own act (26.5s)
locales.checked=12 keys.perLocale=4 missing=0
locales=de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW
  ✓  2 e2e/resident-busy-send.spec.ts:801:3 › resident busy send › every shipped locale carries the keys a held command draws (4ms)
elapsed=35950ms
  ✓  3 e2e/resident-busy-send.spec.ts:832:3 › resident busy send › the run ends inside the ceiling the goal gate kills at (0ms)

  3 passed (35.9s)
```

AC 点名的每一条读数都在场：`resident.queuedCard=0`、`resident.row.present=true`、`resident.row.annotationKey=resident.pending.annotation`、`withdraw.visibleBefore=true`、`click.dispatched=true`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`controlResponsesForCancel=0`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.annotationKey=resident.pending.started`、`perRun.queuedCard=1`、`withdrawn.run.ok=true`、`started.run.ok=true`、`3 passed`。旁证读数也在场：`resident.row.annotation=Will be handled after this answer finishes`、`row.textAfter="Withdrawn"`、`turns.control=1`、`cancelAckFrames=1`、`beforeStarted.withdrawButton=1`、`afterStarted.label=Started processing`、`perRun.card.label=Queued`、`locales.checked=12 keys.perLocale=4 missing=0`。

同一条判据在净树上被跑了**三次**，全绿：`3 passed (36.3s)`（≈`13:18Z`）、`3 passed (37.2s)`（≈`13:19Z`，主检出脏树）、`3 passed (35.9s)`（`13:25:33Z`–`13:26:10Z`，本条最终读数）。⚠️ 本条 dispatch 后的**第一次**净树直跑曾在侧栏 `projectRow` 处以 `TimeoutError` 红（页面 console 全是 `Failed to load resource: net::ERR_NETWORK_CHANGED`），当时宿主 `load average: 17.70`、`swap 14/15G`、另一用户正在编译 C++（`cc1plus`）、并发 vitest 多进程 —— 重跑即绿，那是**宿主负载假红**，与本条归因的 `cn` 崩溃不同形（它是 `projectRow` 等不到，不是 `.chat-messages-pane`）。

### AC2 归因：原读数已不可复现，以同机制取假变异复现同一失败行

**为什么不可复现**：AC2 要的「修前红」出自那份**未提交**的 composer 布局 WIP。该 WIP 的 `ChatComposer.tsx` 在本条 dispatch **之前**（mtime `2026-10-02T13:14:32Z`）已被其作者改版：原先 `cn(...)`（`cn` 未导入 ⇒ `ReferenceError`）被换成 `[...].join(' ')`，缺陷消失。本条实测（主检出工作树，现）：

```
$ grep -n 'cn(' src/modules/chat/composer/ChatComposer.tsx
（无输出）
$ grep -n "import.*cn" src/modules/chat/composer/ChatComposer.tsx
（无输出）
$ git show HEAD:src/modules/chat/composer/ChatComposer.tsx | grep -c 'cn'
0
$ for f in $(git -C /data/home/yale/work/claudecodeui diff --name-only); do echo "$f  cn(=$(grep -c 'cn(' $f)  import-cn=$(grep -c 'import.*cn' $f)"; done
src/modules/chat/composer/ChatComposer.tsx  cn(=0  import-cn=0
src/modules/chat/composer/PromptInput.tsx  cn(=8  import-cn=1     ← 有导入，非缺陷
src/modules/chat/hooks/useComposerCompactTier.ts  cn(=0  import-cn=0
src/modules/chat/transcript/ChatMessagesPane.tsx  cn(=0  import-cn=0
src/modules/project-workspace/WorkspaceHeader.tsx  cn(=2  import-cn=1  ← 有导入，非缺陷
src/shared/hooks/useDeviceSettings.ts  cn(=0  import-cn=0
```

主检出工作树**带未提交改动直跑现为绿**（跑动时刻 `date -u` = `Fri Oct  2 01:19:39 PM UTC 2026`）：

```
  3 passed (37.2s)
EXIT_CODE=0
```

⇒ 原读数（退出 1 + `:352` `.chat-messages-pane` not found + `ReferenceError: cn is not defined`）**在本条可触及的任何树（净树、脏树）上都不可复现**。⛔ 本条**没有**为了复现它去回退/改写 WIP 作者的活工作树（Proposal 禁止，且它正在被改）。

**同机制取假变异（可证伪的替代读数）**：在**本条自己的隔离 worktree**（非主检出、非未提交物、起点 = `develop`）临时把 `ChatComposer.tsx` 的一处 `className` 改成 `cn(...)` 且**不导入**（与原件同一机制），直跑判据：

```
$ grep -n 'cn(' src/modules/chat/composer/ChatComposer.tsx
529:    <div className={cn('chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6')}>
$ grep -n "import.*cn" src/modules/chat/composer/ChatComposer.tsx
（无输出）
$ git show HEAD:src/modules/chat/composer/ChatComposer.tsx | grep -c 'cn'
0
```

判据输出（跑动窗口在 `13:23:08Z` 与 `13:25:33Z` 之间），退出 **1**，**红在判据的首条读数、与立案逐字同一行**：

```
[e2e] page console error: The above error occurred in the <ChatComposer> component:
    at ChatComposer (http://127.0.0.1:7565/src/modules/chat/composer/ChatComposer.tsx:67:3)
    at ChatInterface (http://127.0.0.1:7565/src/modules/chat/ChatInterface.tsx:43:3)
    at ErrorBoundary (http://127.0.0.1:7565/@fs/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-6Pthex/vite-cache/deps/react-error-boundary.js?v=15db1fb0:18:5)
    at WorkspaceErrorBoundary (http://127.0.0.1:7565/src/modules/project-workspace/WorkspaceErrorBoundary.tsx:138:3)
[e2e] page console error: ErrorBoundary caught an error: ReferenceError: cn is not defined
    at ChatComposer (http://127.0.0.1:7565/src/modules/chat/composer/ChatComposer.tsx:265:53)

    Error: expect(locator).toBeVisible() failed
    Locator: locator('.chat-messages-pane')
    Expected: visible
    Timeout: 30000ms
    Error: element(s) not found

      350 |   await revealSession(page, workspaceName, sessionId);
      351 |   await sessionRow(page, sessionId).click();
    > 352 |   await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
          |                                    ^
        at openSession (/data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-red-is-uncommitted-composer-wip/e2e/resident-busy-send.spec.ts:352:36)
        at /data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-red-is-uncommitted-composer-wip/e2e/resident-busy-send.spec.ts:623:5

  1 failed
    e2e/resident-busy-send.spec.ts:615:3 › resident busy send › a busy resident session takes the message, and the withdrawal is the process's own act
  2 did not run
```

⇒ 与立案**逐字同一失败面**：`exit 1`、`1 failed / 2 did not run`、`locator('.chat-messages-pane') … element(s) not found`、`at openSession (e2e/resident-busy-send.spec.ts:352:36)`、`ErrorBoundary caught an error: ReferenceError: cn is not defined` at `ChatComposer.tsx`。唯一差异是 `ChatComposer.tsx` 的**行号**（本变体在 develop 版 ChatComposer 上读 `265:53`；立案的 WIP 版读 `288:18`）——机制与失败行相同。

**变异零残留回退**（回退后净树复跑仍绿，见 AC1 的 `13:25:33Z` 读数）：

```
$ git checkout -- src/modules/chat/composer/ChatComposer.tsx
$ git status --porcelain
（空）
$ git rev-parse HEAD
1139ff069cf9a7e8b09236dcf1c9c5ef37a75466
$ git hash-object src/modules/chat/composer/ChatComposer.tsx    → 522e42e7067f408248f73ccc854a7834dbd7d5b4
$ git rev-parse HEAD:src/modules/chat/composer/ChatComposer.tsx → 522e42e7067f408248f73ccc854a7834dbd7d5b4
```

### AC3 台账归因读数（机械、任何人可复现）

用 `python3` 读 `.quay/gate-events.jsonl`（`grep gate==goal 且 JSON 含 AC-175`），AC-175 `gate=goal` 读数**总条数 634**，尾巴 `verdict` 序列（最后 3 条）为 `pass` → `pass` → `fail`：

```
2026-10-02T12:50:06.120Z  goal-cli  pass  acceptance passed (exit 0)
2026-10-02T12:57:14.694Z  goal-cli  pass  acceptance passed (exit 0)
2026-10-02T13:04:26.537Z  goal-cli  fail  acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-nlHcvH/vite-cache/deps/react-scan.js?v=29ef4bab as it exceeds the max of 500KB. [WebServer] (node:250114) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated. [WebServer] (Use `node -- … [truncated, 687 chars of stderr omitted]
```

两条的 `timestamp` 与 `payload.reason` **逐字**：

- `pass`：`2026-10-02T12:57:14.694Z`，`reason`（逐字）= `acceptance passed (exit 0)`
- `fail`：`2026-10-02T13:04:26.537Z`，`reason`（逐字）= 上引整串（注意台账自身在 687 字符 stderr 处已截断，本条不改写它）

**`fail` 时刻与该未提交 WIP 的 mtime 同窗**：`fail` = `2026-10-02T13:04:26Z`；主检出 6 个未提交文件与配套未跟踪文件的 mtime（`date -u -r`）：

```
2026-10-02T13:02:19Z  src/shared/tests/useDeviceSettings.test.ts
2026-10-02T13:09:27Z  src/modules/chat/hooks/useComposerCompactTier.ts
2026-10-02T13:09:27Z  src/shared/hooks/useDeviceSettings.ts
2026-10-02T13:09:27Z  src/modules/chat/composer/PromptInput.tsx
2026-10-02T13:12:17Z  src/modules/chat/transcript/ChatMessagesPane.tsx
2026-10-02T13:13:12Z  src/modules/project-workspace/WorkspaceHeader.tsx
2026-10-02T13:14:32Z  src/modules/chat/composer/ChatComposer.tsx
```

WIP 主体在 `13:02`–`13:14` 落进主检出，`fail`（`13:04:26Z`）正落在其中（WIP 第一批文件落地 ≈2 分钟后）——**同窗成立**。立案时读到的是更早的一版：`ChatComposer.tsx` 当时含 `cn(...)` 未导入（mtime `13:02` 那批）；本条 dispatch 前它被改版到 `13:14:32Z`，缺陷消失，其余文件 mtime 未变。台账 `fail` 的 `payload.reason` 只记到 stderr 噪声（BABEL/DEP0190），**没有**记下崩因；崩因由本条的直跑（AC2 取假变异）而非台账给出。

### AC4 无归属任务读数

```
$ grep -rl 'isShortViewport\|areToolsInline\|短视口' tasks/ goals/
tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md      ← 只命中本条自己（正文里的字面量）
$ git log --oneline -S isShortViewport -- src/
（空）
$ git log --oneline -S isShortViewport --all
dfdaa855 tasks: gap-ac175-criterion-red-is-uncommitted-composer-wip task_write by cli:302779
```

⇒ 该 WIP **无 task/commit 认领**：没有任何**其它** task 文件命中这三个字面量（只命中本条），也没有任何 `src/` 提交含 `isShortViewport`（`git log -S … -- src/` 空）。`--all` 的唯一命中 `dfdaa855` 是**本条自己**的 task_write 提交（task 文件正文含该字面量），其改动只限 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md`，不含任何 `src/` 改动。

### AC5 如实登记

**台账尾巴仍是 fail。** 本条只**直跑判据本体**（AC1/AC2），并未经过 `gate=goal` 那条路，所以跑动之后 AC-175 的 `gate=goal` 读数**总条数仍是 634**，尾巴**仍是**：

```
2026-10-02T13:04:26.537Z  goal-cli  fail  acceptance failed (exit 1) — …
```

**这不是「AC-175 已通过」**：driver 的独立复核（`gate=goal`）在本条完成前尚未发生。可以断言的只有分属两层的事：判据本体在**浏览器层、净树**上直跑为绿（AC1 的读数，`3 passed`、exit 0）；`gate=goal` 的尾巴**仍是 fail**。⛔ 不拿组件层 jsdom 的绿替代浏览器层的绿；⛔ 不把本条写成已通过。可预期的下一步（**以台账为准，不以本条的预测为准**）：WIP 缺陷既已消失，goal 驱动下一次独立复核应读到 `pass`。

### AC6 字节纪律

```
$ git -C <worktree> diff --name-only develop..HEAD
tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md
$ git -C <worktree> status --porcelain
（空）
```

交付面只写 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md`，且经 Provider ABI（`task_write`）落库、**不手改 `- [ ]` 字符**。主检出的 6 个未提交文件在本条会话中**未被本条改动**（本条对它们只读）；唯一的临时变异落在**本条隔离 worktree** 的 `ChatComposer.tsx` 上，已零残留回退（见 AC2 的哈希证据）。本条**未**改 `e2e/resident-busy-send.spec.ts`、`playwright.config.ts`、宿主配置一个字节。

### DoD 归因与 remedy

**被提交的树满足 AC-175**：净树（起点 = `develop`，`HEAD` = `1139ff069cf9a7e8b09236dcf1c9c5ef37a75466`）直跑判据 `3 passed`、exit 0，AC-175 expect 点名的每条读数都在场（AC1）。**台账红是主检出的未提交 composer 布局 WIP 崩**：`2026-10-02T13:04:26Z` 的那条 `gate=goal fail` 落在 WIP 主体落进主检出（`13:02`–`13:04`）的同窗，而同一判据在 WIP 落地前（`12:57:14Z`）与净树上都是 `pass`/绿（Proposal 的两处直跑 + 本条 AC1）。**remedy**：立案时给出的 remedy 是「随该 WIP 提交 `import { cn } from '@/shared/utils'`」；⚠️ 该 remedy **现已 moot** —— WIP 作者在 `2026-10-02T13:14:32Z` 用 `[...].join(' ')` 取代了 `cn(...)`（不是新增该导入，而是移除调用），缺陷同样消失，工作树直跑现为绿。

### 判法（可机械复用）

台账上某条 AC 的 `gate=goal` 读 `fail`、而「任何人复跑判据」却为绿时，先分三层：(1) **净树直跑**判据本体 —— 绿 ⇒ 被提交的树没退化；(2) **脏树（主检出未提交物）直跑** —— 红 ⇒ 是 WIP 崩，不是 AC 回归；(3) 读 `.quay/gate-events.jsonl` 的 `payload.reason` **与**未提交文件的 `mtime`，看 `fail` 是否落在 WIP 落地的同窗。⚠️ 同一份 WIP 是**活**的：本条的 `cn` 缺陷在立案后 ~10 分钟被作者自行修掉，所以「修前红」会过期 —— 归因任务的取假变异必须**当场重做**，不能只复述立案读数。
