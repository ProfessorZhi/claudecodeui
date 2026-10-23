---
id: gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout
title: "AC-175 判据 2026-10-03T09:28:13.036Z 那拍的红由主检出未提交 composer WIP
  在判据运行途中被保存、Vite 把这次保存当 HMR 推给正在跑的页面把树打崩（pageError: useWebSocket must be used
  within a WebSocketProvider ⇒ cancelled 帧未被处理 ⇒ waitForLifecycle 30s
  超时）——verification-only 归因入档：净树直跑 3 passed / exit 0，台账前五拍连续 pass；remedy 归该 WIP
  作者（勿在判据运行期保存主检出）"
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

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-175 `status: achieved`，其 GOAL-013 已 achieved 且不再活，未声明 `long-term: true`；台账尾部 `2026-10-03T09:28:13.036Z` 那拍记为 fail，驱动器在立案前重跑判据得 exit 1，故按 CURRENTLY FALSE 立案。

判据物（逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`）：`npx playwright test e2e/resident-busy-send.spec.ts`。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `a85348f3`，branch `author`）：`grep -rln '^goal_ac: *AC-175' tasks/` → **5 份**，`status:` 逐字皆 **done**（`gap-ac175-criterion-bounded-boot-guard`、`gap-claude-resident-busy-send-ui`、`gap-ac175-criterion-red-is-uncommitted-composer-wip`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`）。在飞扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human）→ 全库只有 `tasks/gap-activity-dock-human-gate.md`（`goal_ac: AC-190`），**无一认领 AC-175** ⇒ 无在飞认领者。按「done 不算重复、是更早修法没兜住的证据」：更早五条里最接近的是 `gap-ac175-criterion-red-is-uncommitted-composer-wip`（**启动期**崩：未提交 WIP 里 `ChatComposer.tsx` 用了未导入的 `cn` ⇒ ReferenceError ⇒ 判据首条「打开会话」30s 超时），本条是**另一条触发路径**：同一份未提交 composer WIP 在**判据运行途中被保存**，Vite 把保存当 HMR 推给正在跑的页面 ⇒ 页面 React 树在**用例进行中**崩 ⇒ 被测的 `cancelled` 帧没被处理（失败行、触发源、remedy 全不同）。同形先例见 `tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md`（它逐字作了同样的区分：「那条是 `cn` 未导入在启动期崩，本条是运行期 HMR 崩」）。⇒ 本条不是重复。

**本轮直接测量（读数不是推断）**

（1）**净检出直跑 → 绿**（立案前在净检出上重跑出货命令）：`npx playwright test e2e/resident-busy-send.spec.ts` → EXIT **0**，`3 passed (36.5s)`，`elapsed=38440ms`。判据自己打印的读数逐字：`resident.queuedCard=0`、`resident.row.present=true`、`resident.row.annotationKey=resident.pending.annotation`、`withdraw.visibleBefore=true`、`click.dispatched=true`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`scenario.cancel_async_message=5c612b9c-…`、`controlResponsesForCancel=0`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`。⇒ **被提交的树满足 AC-175。**

（2）**台账尾巴**：`.quay/gate-events.jsonl` 里 AC-175 `gate=goal` 的末六拍逐字为 `08:57:17.468Z pass` → `09:03:36.129Z pass` → `09:09:30.089Z pass` → `09:14:50.056Z pass` → `09:22:03.250Z pass` → `09:28:13.036Z fail`。**五连 pass 之后一拍 fail**。

（3）**那拍 fail 的机制（从其失败跑自己的 trace.zip 读出，不是猜）**：失败跑数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-JHgwgn`；其 `watchdog-state.json` = `{"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at 40000ms"}`；`test-results/resident-busy-send-residen-7053b-al-is-the-process-s-own-act/error-context.md` 逐字 `Error: expect(received).toBe(expected) // Object.is equality / Expected: true / Received: false` + `Call Log: - Timeout 30000ms exceeded while waiting on the predicate`。解包 `trace.zip` 后，同一页面（`page@cd6f566ebc47e27c1761b82620f32698`，三段 trace 同属 `resident-busy-send.spec.ts:855` 这一条用例）的 `6-trace.trace` 逐字：

```
13701.953  console debug  [vite] hot updated: /src/index.css
13702.200  console debug  [vite] hot updated: /src/modules/chat/ChatInterface.tsx
13728.459  pageError      useWebSocket must be used within a WebSocketProvider   (at ProjectWorkspaceRouteContent)
13731.548  pageError      （同）
13742.514  pageError      （同）
13733.849  console error  The above error occurred in the <ProjectWorkspaceRouteContent> component: ...
```

`6-trace.trace` 首行 `wallTime=1791019662914`（= `2026-10-03T09:27:42.914Z`）、`monotonicTime=10248.76` ⇒ HMR 落在 **`09:27:46.367Z`**、pageError 落在 **`09:27:46.394Z`**。同轮 `test.trace`（`wallTime=1791019656469` = `09:27:36.469Z`）显示：用例体自 `t=10234ms` 起，`withdraw` 点击在 `t=10576ms`，`cancelPayloads>=1` 的轮询在 `t≈10627ms` 已过，而被测的 `waitForLifecycle(..., 'cancelled', 30_000)`（spec `:933`，poll 体 `:631`）自 `t=10641.825ms`（= `09:27:43.307Z`）起、到 `t=39692.066ms`（= `09:28:12.357Z`）超时。⇒ 因果链：**点击已发出且已被进程收到（`cancelPayloads>=1`）→ 3.1s 后页面树被 HMR 崩掉 → `cancelled` 帧再没被处理 → 30s 轮询超时 → `09:28:13.036Z` 记 fail**。

**触发源是谁**：`find src e2e playwright.config.ts -newermt '2026-10-03 17:20' ! -newermt '2026-10-03 17:35' -type f`（本地 = UTC+8）只命中 `src/modules/chat/hooks/useChatComposerState.ts` 与 `src/modules/chat/tests/composerDraftScoping.test.tsx` —— 即主检出那份**未提交的 composer WIP**（`ChatInterface.tsx` / `index.css` 出现在 HMR 行里是 Vite 沿 import 链传播的 importer，不是被保存的文件：两者 mtime 分别是 `11:18:47` / `10:46:30`，早于本跑数小时）。该 WIP 随后在 `09:28:22Z` / `09:28:26Z` 再被保存，并在 `09:29:00Z`（本地 `17:29:00`）提交为 develop 的 `cc658aec`（`fix(chat): retire the project draft a first resident send was typed in`）。⇒ **台账那拍红 = 主检出工作树在判据运行途中被保存、Vite 把这次保存当 HMR 推给正在跑的页面、承载页面的 React 树崩掉、被测的 `cancelled` 帧随之无人处理**，不是 AC-175 的承诺退化。

**这条是什么、不是什么**：verification-only 归因入档。它**不**改实现、判据、宿主配置一个字节，也**不**动主检出的活 WIP（`stash` / `git checkout --` / 编辑一律不做——那份 WIP 归其作者）。它交付的是可复核的读数与判法：**「未提交 WIP 在判据运行途中的 HMR 推送把页面打崩 ≠ AC-175 回归」**，以及 remedy —— 该 WIP 的作者不要在判据运行期保存主检出（或把它改到可编译并提交）。

## Plan

1. 建本条的隔离 worktree（起点 = 开工时的 `develop`；`git status --porcelain` 空），在**其中**跑出货命令两次：一次普通跑（读退出码 / `3 passed` / `elapsed`），一次带 `--trace on`（留一份**净树**的 trace 作对照）。
2. 从净树那次 trace 里读出同一条用例的页面事件，证明净树跑里**没有** `pageError`、**没有** `[vite] hot updated`（与本条的失败跑逐字对照）——这是本条归因的承重分辨力。
3. 从失败跑留下的 `trace.zip` 里把 Proposal(3) 的每条读数**重新解包、逐字抄**（trace 路径与解包命令写进完成记录）；若该目录已被 6h TTL 回收，改用本条隔离 worktree 里的同机制复现：在跑动途中保存一个 `src/modules/chat/**` 文件制造 HMR，读到同一 pageError 后立即回退并证明零残留。
4. 机械核对「触发源是谁」与「无归属」：`find` 窗口读数、两条 composer 文件的 mtime、`cc658aec` 的提交时刻、在飞任务扫描（无 AC-175 认领者）。
5. 如实登记台账尾巴与本条读数；交付只落在 `tasks/<id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条自己的隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**、`3 passed`、`elapsed < 55_000ms`，并把判据自己打印的读数行逐字抄进完成记录（至少含 `resident.queuedCard=0`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`perRun.queuedCard=1`）。红态基线（本轮立案读数）：主检出直跑那跑 EXIT=1、`Timeout 30000ms exceeded while waiting on the predicate`。
- [x] AC2 分辨力（承重）：净树那次带 `--trace on` 的跑里，同一条用例的页面事件中 `pageError` 计数为 **0**、`[vite] hot updated` 计数为 **0**；把两条计数命令与逐字输出入档，并与失败跑的 `pageError=3` / `hot updated=27`（15×`index.css` + 12×`ChatInterface.tsx`）逐字对照。⚠️ 若净树跑因宿主原因出现无关 pageError，点名归因并给出可区分读数，不得含糊。
- [x] AC3 归因读数逐字入档：从 `~/.cache/quay-e2e-tmp/quay-e2e-JHgwgn/test-results/resident-busy-send-residen-7053b-al-is-the-process-s-own-act/trace.zip` 解包，打出 `6-trace.trace` 的 `hot updated` 行与 `pageError` 行的**相对时刻 + 由 `wallTime`/`monotonicTime` 换算出的绝对时刻**（本轮读数：HMR `09:27:46.367Z`、pageError `09:27:46.394Z`），以及 `test.trace` 里被测轮询的起止（`09:27:43.307Z` → `09:28:12.357Z`）；trace 路径与解包命令写进完成记录。若该目录已被回收，按 Plan(3) 用同机制复现替代，并证明复现后零残留（`git status --porcelain` 回到空）。
- [x] AC4 触发源与归属（机械）：`find src e2e playwright.config.ts -newermt '2026-10-03 17:20' ! -newermt '2026-10-03 17:35' -type f` 只命中两份 composer 文件；`stat -c '%y %n'` 给出两份文件 mtime（本轮 `17:28:26` / `17:28:22`）；`git log -1 --format='%h %ad %s' --date=iso cc658aec` 给出提交时刻（`17:29:00`）；在飞任务扫描显示无任务认领 AC-175。四条命令与逐字输出入档。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；主检出 `git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`）。
- [x] AC6 如实登记：完成记录逐字写明「被提交的树满足 AC-175」与「台账 `09:28:13.036Z` 那拍红由主检出未提交 composer WIP 在运行途中的 HMR 推送造成」，并附 AC1 的净树读数；⛔ 不得用组件层/jsdom 的绿替代浏览器层的绿。

## DoD

- 出货命令（`npx playwright test e2e/resident-busy-send.spec.ts`，逐字不改；⛔ 不加 `-g`、不 skip、不加 `retries`、不改断言）在净检出上真的跑过，读数行逐字入档——不是复述 `expect` 的文字，不是读台账尾巴。
- 归因的每一条读数（HMR 行 + pageError 行的时刻、被测轮询的起止、触发文件与提交时刻）都能由任何人在同一 checkout 上从那份 `trace.zip`（或本条隔离 worktree 里的同机制复现）复现；trace 路径与解包命令写进完成记录。
- 完成记录明确写出判法：**「未提交 WIP 在判据运行途中的 HMR 推送把页面打崩 ≠ AC-175 回归」**，并给出 remedy：该 WIP 的作者不要在判据运行期保存主检出（或把它改到可编译并提交）。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、未提交工作树、宿主配置一个字节未动。
- 若净树直跑为**红**（即红不依赖运行期编辑），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」——⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout.md（自触）
- e2e/resident-busy-send.spec.ts（本条只跑不改：AC1/AC2 的判据本体，出货命令逐字不改）
- src/modules/chat/hooks/useChatComposerState.ts（本条只读不改：触发保存的文件 / mtime 与提交时刻证据）
- src/modules/chat/tests/composerDraftScoping.test.tsx（本条只读不改：同一窗口的第二份被保存文件）
- goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md（本条只读不改：criterion/expect 的逐字来源）

## 完成记录

worker：quay per-task worker，branch `task/gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`。本条 **verification-only**：不新增/修改任何实现、判据、宿主配置一个字节；下列读数除显式标注「立案读数」外，均为本条在**自己的隔离 worktree** 上现测。

### 0. 隔离 worktree（AC1 前提）

```
worktree  = /data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout
创建      = git worktree add -b task/gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout <worktree> develop
provision = bash /data/home/yale/.claude/plugins/cache/quay/quay/0.11.0/scripts/dispatch-worktree-setup.sh <worktree>
            → "fork-point PASS — HEAD contains develop (a00ac423ef555ef84dcd6345be9e16e75d0a4085)"
            → node_modules -> /data/home/yale/work/claudecodeui/node_modules（symlink）
            → worktree-include: 无声明（WARNING nothing declared, nothing copied）
【开工 09:42:12Z】git -C <worktree> rev-parse HEAD     = a00ac423ef555ef84dcd6345be9e16e75d0a4085
【开工 09:42:12Z】git -C <worktree> rev-parse develop  = a00ac423ef555ef84dcd6345be9e16e75d0a4085   （起点 = develop，逐字相等）
【开工 09:42:12Z】git -C <worktree> status --porcelain = （空）
```

### 1. AC1 净检出直跑 → 绿（现测，本条承重读数）

命令逐字（出货命令本体，未加 `-g`、未改路径、未改文件）：

```
cd /data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout
npx playwright test e2e/resident-busy-send.spec.ts
```

跑动时刻（`date -u`）：START `2026-10-03T09:43:39Z` / END `2026-10-03T09:44:15Z`。
结果：**EXIT=0**、`3 passed (35.8s)`、`elapsed=35754ms`（< `55_000ms`）；数据目录 `[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-NoxYML`。

判据自己打印的读数行（逐字抄录；AC1 点名的每一条都在场）：

```
resident.queuedCard=0
resident.row.present=true
resident.row.annotationKey=resident.pending.annotation
resident.row.annotation=Will be handled after this answer finishes
withdraw.visibleBefore=true
click.dispatched=true
ui.withdrawnBeforeEvent=false
ui.withdrawnAfterEvent=true
row.presentAfter=false
row.textAfter="Withdrawn"
turnsAfterWithdraw=0
turns.control=1
cancelPayloads=1
scenario.cancel_async_message=80caaaa9-ef7d-48c4-afb0-ca2efa23fe17
controlResponsesForCancel=0
cancelAckFrames=1
cancelVerdictSource=command_lifecycle
beforeStarted.withdrawButton=1
afterStarted.withdrawButton=0
afterStarted.annotationKey=resident.pending.started
afterStarted.label=Started processing
perRun.queuedCard=1
perRun.card.label=Queued
withdrawn.run.ok=true status=200
started.run.ok=true status=200
locales.checked=12 keys.perLocale=4 missing=0
elapsed=35754ms
  ✓  1 e2e/resident-busy-send.spec.ts:855:3 › resident busy send › a busy resident session takes the message, and the withdrawal is the process's own act (26.5s)
  ✓  2 e2e/resident-busy-send.spec.ts:1041:3 › resident busy send › every shipped locale carries the keys a held command draws (5ms)
  ✓  3 e2e/resident-busy-send.spec.ts:1072:3 › resident busy send › the run ends inside the ceiling the goal gate kills at (0ms)
```

红态基线（立案读数）：主检出直跑 EXIT=1、`Timeout 30000ms exceeded while waiting on the predicate`；台账 AC-175 `gate=goal` 末六拍 `08:57:17.468Z pass` → `09:03:36.129Z pass` → `09:09:30.089Z pass` → `09:14:50.056Z pass` → `09:22:03.250Z pass` → `09:28:13.036Z fail`。

### 2. AC2 分辨力（承重）：净树带 `--trace on` 直跑 → 崩因计数为 0

第二条跑（净树、同一条用例、`--trace on` 留全量 trace）：`npx playwright test e2e/resident-busy-send.spec.ts --trace on`；START `2026-10-03T09:45:36Z` / END `2026-10-03T09:46:14Z`；**EXIT=0**、`3 passed (38.0s)`、`elapsed=37790ms`；数据目录 `[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-JQN49W`。（`playwright.config.ts:1550` = `trace: 'retain-on-failure'`，故净树跑须显式 `--trace on` 才留 trace。）

计数命令（`6-trace.trace` = 承载用例主页面 / 与失败跑同一角色，title 同为 `resident-busy-send.spec.ts:855`）：

```
$ grep -o '"method":"pageError"' <6-trace.trace> | wc -l
FAILURE run (quay-e2e-JHgwgn/…/trace.zip → 6-trace.trace): 3
CLEAN   run (quay-e2e-JQN49W/…/trace.zip → 6-trace.trace): 0

$ grep -o 'hot updated: [^"]*' <6-trace.trace> | sort | uniq -c
FAILURE run:      15 hot updated: /src/index.css
                  12 hot updated: /src/modules/chat/ChatInterface.tsx
CLEAN   run:      （无输出 = 0）
```

⇒ 与失败跑 `pageError=3` / `hot updated=27`（15×`index.css` + 12×`ChatInterface.tsx`）**逐字对照**，净树同页面两计数**全为 0**。

⚠️ **净树跑确有 1 个无关 pageError —— 点名归因（AC2 的 ⚠️ 要求）**：全 trace（`0..6-trace.trace`）`pageError` 总数净树 = 1、失败 = 4。净树那 1 个在**早段上下文** `3-trace.trace`（wallTime `2026-10-03T09:45:43.298Z`），逐字：

```
SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.
   abs=2026-10-03T09:45:43.341Z   （rel=7117.46，monotonicTime=7073.962）
```

失败跑的**同一早段上下文** `3-trace.trace`（wallTime `2026-10-03T09:27:40.393Z`）里**逐字同一个** pageError（abs `2026-10-03T09:27:40.436Z`）。⇒ 该 pageError 是**两次跑都有的每跑常量**（各 1 个、早段上下文、同一 message），**不是** HMR 崩因。可区分读数把它摘掉：HMR 崩因签名 = `useWebSocket must be used within a WebSocketProvider`，其原始出现次数 **失败 6-trace=6（3 事件 ×2：message+stack）/ 净树 6-trace=0**。两跑差异**只**落在 HMR 崩因那一条上。

### 3. AC3 归因读数逐字入档（从失败跑自己的 trace.zip 解包）

trace 路径（立案那座 `~/.cache/quay-e2e-tmp/quay-e2e-JHgwgn` 在 dispatch 时**尚未被 6h TTL 回收**，本条直接现测，无需 Plan(3) 的同机制复现）：

```
~/.cache/quay-e2e-tmp/quay-e2e-JHgwgn/test-results/resident-busy-send-residen-7053b-al-is-the-process-s-own-act/trace.zip
解包: SCRATCH=$(mktemp -d) && cd "$SCRATCH" && unzip -o <上面的 trace.zip>
```

`6-trace.trace` 上下文头 `wallTime=1791019662914`（=`2026-10-03T09:27:42.914Z`）、`monotonicTime=10248.76`、`origin=library`；换算 `abs = wallTime + (rel − monotonicTime)`。逐字：

```
rel= 13701.953  abs=2026-10-03T09:27:46.367Z  console:debug  [vite] hot updated: /src/index.css
rel= 13702.200  abs=2026-10-03T09:27:46.367Z  console:debug  [vite] hot updated: /src/modules/chat/ChatInterface.tsx
rel= 13728.459  abs=2026-10-03T09:27:46.393Z  pageError      useWebSocket must be used within a WebSocketProvider
rel= 13731.548  abs=2026-10-03T09:27:46.396Z  pageError      useWebSocket must be used within a WebSocketProvider
rel= 13733.849  abs=2026-10-03T09:27:46.399Z  console:error  The above error occurred in the <ProjectWorkspaceRouteContent> component: …
rel= 13742.514  abs=2026-10-03T09:27:46.407Z  pageError      useWebSocket must be used within a WebSocketProvider
```

（立案读数写 pageError `09:27:46.394Z`；本条按 `abs=1791019666393.699ms` 逐字给出截断值 `09:27:46.393Z`，进位即 `09:27:46.394Z` —— 同一拍，差 0.7ms 为取整。）

被测轮询（`test.trace`，`origin=testRunner`，上下文头 `wallTime=1791019656407`（=`2026-10-03T09:27:36.407Z`）、`monotonicTime=3741.674`；⚠️ 立案读数写 `wallTime=1791019656469`，那是同轮 `0-trace.trace` 的上下文头，本条以 `test.trace` 自身的头换算）：

```
Poll call (Test.expect, params.expected="true"):
  startTime = 10641.825  → abs=2026-10-03T09:27:43.307Z
  endTime   = 39692.066  → abs=2026-10-03T09:28:12.357Z   （≈29050ms，30_000ms 预算耗尽）
  after.error.message 逐字: Error: expect(received).toBe(expected) // Object.is equality / Expected: true / Received: false / Call Log: - Timeout 30000ms exceeded while waiting on the predicate
  after.error.stack  逐字: e2e/resident-busy-send.spec.ts:643:6 function "waitForLifecycle"
```

spec 行锚（净树文件逐字核对）：`waitForLifecycle` 定义体 `await expect` 起 `:631`、`.toBe(true)` 在 `:643`；调用点 `:933` = `await waitForLifecycle(page, withdrawnSessionId, withdrawnUuid, 'cancelled', 30_000);`；用例标题 `:855`。

⇒ 因果链：`withdraw` 点击在 `09:27:43.241Z` 发出且进程已收到（`cancelPayloads>=1` 在 `09:27:43.293Z` 已过）→ 轮询自 `09:27:43.307Z` 起等 `cancelled` → **3.06s 后**（`09:27:46.367Z`）HMR 推 `index.css`+`ChatInterface.tsx` → `09:27:46.393Z` 起页面树三连 pageError 崩 → `cancelled` 帧再无人处理 → `09:28:12.357Z` 轮询 30s 超时 → `09:28:13.036Z` 台账记 fail。

### 4. AC4 触发源与归属（机械读数）

四条命令与逐字输出（主检出 `/data/home/yale/work/claudecodeui`，本地时区 UTC+8）：

```
$ find src e2e playwright.config.ts -newermt '2026-10-03 17:20' ! -newermt '2026-10-03 17:35' -type f
src/modules/chat/hooks/useChatComposerState.ts
src/modules/chat/tests/composerDraftScoping.test.tsx

$ stat -c '%y %n' src/modules/chat/hooks/useChatComposerState.ts src/modules/chat/tests/composerDraftScoping.test.tsx
2026-10-03 17:28:26.302333862 +0800 src/modules/chat/hooks/useChatComposerState.ts
2026-10-03 17:28:22.640347034 +0800 src/modules/chat/tests/composerDraftScoping.test.tsx

$ git log -1 --format='%h %ad %s' --date=iso cc658aec
cc658aec 2026-10-03 17:29:00 +0800 fix(chat): retire the project draft a first resident send was typed in
   （git merge-base --is-ancestor cc658aec develop → YES）

$ 在飞扫描（tasks/*.md 的 ^status: ∈ todo/ready/needs-human 且 ^goal_ac:）
IN-FLIGHT AC-175 claimant: ready  gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout.md   ← 只命中本条自己
```

⇒ 触发窗 `17:20–17:35` 内被保存的**只有两份 composer 文件**（`17:28:26` / `17:28:22`）；这本身份 WIP 于 `17:29:00` 提交为 `cc658aec`（已在 develop 内）。在飞任务里**除本条自己外**无任何任务认领 AC-175。

### 5. AC5 承重面未被本条触碰

主检出 `git status --porcelain` 与本条开工快照对照（观测 `2026-10-03T09:53:55Z`）：**只多 4 个新未跟踪文件** —— `?? experiments/voice-draft/s1/audit-dump.mts`、`?? experiments/voice-draft/s1/semantic.mts`、`?? experiments/voice-draft/s2/asr.jsonl`、`?? experiments/voice-draft/s2/drafts.jsonl`（全在 `experiments/voice-draft/`，**非本条所写**；本条对主检出一律只读）。**无任何条目消失**；2 个 `M`（`experiments/voice-draft/s1/results.jsonl`、`experiments/voice-draft/s2/manifest.json`）与原 9 个 `??` 逐字不变；`src/**`、`e2e/**`、`server/**`、`playwright.config.ts` 的跟踪状态一字未动。⛔ 本条**未** `stash`、**未** `git checkout --`、**未**编辑上述任何路径；两次跑动均从**隔离 worktree** 发起，数据写 `~/.cache/quay-e2e-tmp/**`。

worktree 侧：交付提交经 provider 的 branch-aware 落库（`author` 上提交后 ff 到 `develop`）；worktree fast-forward 到它后 `git diff --name-only develop..HEAD` = **空**（task 分支相对 develop 零额外 delta，交付面全在该 task 文件的提交里）。逐字见 §7。

### 6. AC6 如实登记与判法

**被提交的树满足 AC-175**：净检出（起点 = develop `a00ac423`，`HEAD` 逐字相等；`git status --porcelain` 空）上直跑出货命令 `3 passed` / EXIT 0 / `elapsed=35754ms`，判据点名的每条读数都在场（§1）。

**台账 `2026-10-03T09:28:13.036Z` 那拍红 = 主检出未提交 composer WIP 在运行途中被保存、Vite 把它当 HMR 推给正在跑的页面、把承载页面的 React 树推崩（`pageError: useWebSocket must be used within a WebSocketProvider`），被测的 `cancelled` 帧随之无人处理 ⇒ `waitForLifecycle` 30s 超时**，**不是** AC-175 的承诺退化。分辨力（§2）：净树同一条用例、同一页面角色上崩因计数 = 0；失败跑同一页面 `pageError=3` / `hot updated=27`。触发源（§4）：`17:20–17:35` 窗口只被保存两份 composer 文件，随后 `17:29:00` 提交为 `cc658aec`。

⛔ 本条**未**用组件层/jsdom 的绿替代浏览器层的绿（只跑出货命令本体与同命令 `--trace on`）；**未**读台账尾巴冒充现测。

**remedy**：该 WIP 的**作者**不要在判据运行期保存主检出（或把它改到可编译并提交 —— `cc658aec` 已是该 WIP 的落地；本条不动主检出的活/已提交 WIP）。

**判法（可机械复用）**：台账某 AC 的 `gate=goal` 读 `fail`、而任何人净树复跑判据为绿时，读该 fail 对应数据目录的 `trace.zip`：若在用例**进行中**出现 `[vite] hot updated` 行、且其后紧跟 `pageError` 把承载页面的 React 树打崩，则红是运行期 HMR 推送所致，非该 AC 的回归；分辨力取同一页面角色上「净树 `pageError`/`hot updated` 计数 = 0」。

### 7. 终态

`task_write`（Provider ABI）把交付提交落库。首笔（**观测 `2026-10-03T09:54Z`，即完成记录定稿这笔 task_write 之前**）：

```
$ git -C /data/home/yale/work/claudecodeui show --stat --format='%h %s' 743c6d57
743c6d57 tasks: gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout task_write by cli:1251972

 ...-is-mid-run-hmr-of-live-edited-main-checkout.md | 190 ++++++++++++++++++++-
 1 file changed, 183 insertions(+), 7 deletions(-)
```

该提交在 `author` 上落，随后 provider 的 branch-aware ff（`git push . author:develop`）把 `develop` 一并推进 ⇒ `author` == `develop` == `743c6d5725f863981711bad3eb5174bcba5370f3`。worktree step 2b(i) `git -C <worktree> merge --no-edit develop` 逐字 `Updating a00ac423..743c6d57 / Fast-forward`；随后：

```
$ git -C <worktree> rev-parse HEAD ; git -C <worktree> rev-parse develop
743c6d5725f863981711bad3eb5174bcba5370f3
743c6d5725f863981711bad3eb5174bcba5370f3

$ git -C <worktree> diff --name-only develop..HEAD
（空）
```

⇒ **AC5 承重面读出**：交付提交只含 `tasks/<id>.md`（1 file changed）；task 分支相对 develop 零额外 delta；主检出 tracked 面与开工快照逐字一致（§5）。完成记录定稿这笔 task_write 同形（provider 对 body 变更加 `## 完成记录` 判为 must-propagate，照旧 `author`→ff `develop`；worktree 再 ff 一次）。
