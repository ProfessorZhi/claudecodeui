---
id: gap-transcript-follow-ac109-window-baseline-race
title: AC-109 判据偶发假红（本轮 1/3，与 driver 同形同值 −90）：窗口的参照 offset 与写记录锚在设桩之前，慢速流式的一个
  delta（≈120px）落进设桩间隙，被读成「手势没把视图上移」
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-109
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本条判据由 [[gap-transcript-follow-small-gesture-detaches]]（done，AC-109）落地，它把「脱离」从 50px 距底阈值改成用户意图并把这条窗口判据写了出来；[[gap-transcript-follow-key-detach-vs-commit-pin]]（done，AC-109）修的是产品侧的另一个机制（PageUp 已按下、浏览器尚未报 scroll 的那一帧里 commit-time 增长 pin 把视图抢回），与本条的参照系缺陷不同；[[gap-transcript-follow-criterion-boot-dep-reopt-race]]（done，AC-108）与 [[gap-transcript-follow-ac110-case-nav-skips-boot-guard]]（done，AC-110）是同一族「判据可测性缺陷」的姊妹条，本任务沿用它们的取证与对照写法。e2e 工具链本身与登录后置锚点约定出自 gap-session-filter-real-browser-e2e（done）与 gap-e2e-onboarding-anchor-seeded-transcripts（done），本任务不重复申领。

### 现状（2026-09-30 实测，宿主 load1 ≈ 28 / 128 核）

判据：`npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"`。

- 本轮直跑 3 次：**2 绿 1 红**。绿次读数恒为 `wheel: movedUpBy 30, highestOffsetDelta 0, detachFrames 60+, growthsInWindow 4~5, paneWrites [], pageWrites [], buttonVisible true, buttonAppearancesInWindow 1, unpinned [], settledGap 0`（键盘半 `movedUpBy 402`）。
- 红形态（与 driver 留下的那次**同形同值**）：

  ```
  Error: wheel: the gesture has to have moved the viewport up, or "nothing wrote it back" is a statement about a pane the user never moved
  expect(received).toBeGreaterThan(expected)
  Expected: > 0
  Received:   -90
  ```

- driver 的红：`.quay/gate-events.jsonl` 里 `id=bc3f84ef-b439-4954-bbd4-345c021e0f7a`、`item_id/pipeline_id=AC-109`、`gate=goal`、`actor=goal-cli`、`verdict=fail`、`timestamp=2026-09-29T21:40:19.600Z`；其 data-dir 为 `/data/scratch/yale/quay-e2e-geK0h1`（同一目录的 `test-results/transcript-follow-transcri-41527-k-for-the-rest-of-the-reply/error-context.md` 与 `trace.zip` 是那次现场，值与本轮红一致：`Received: -90`）。本轮复现的现场是 `/data/scratch/yale/quay-e2e-Ayo9kW`。

### 机制：窗口的参照系锚在设桩之前（读数缺陷，不是产品缺陷）

`runAc109Window`（`e2e/transcript-follow.spec.ts`）在**手势之前**为「窗口」取了三样东西，而这三样之后还夹着 5~6 次 CDP 往返（`readGeometry` → `installAc109PaneWriteCounter` → `locator.count()`（`buttonAtOpen`）→ `clearInstruments` → `startAc109Sampler` → `page.evaluate(performance.now)` → `pointAtPane` 的 boundingBox + `mouse.move`）：

1. 参照 offset：`const before = await readGeometry(page)`（`before.scrollTop`）；
2. pane 自己的写计数：`installAc109PaneWriteCounter(page)`；
3. 窗口级仪器：`clearInstruments(page)`。

回复每 250ms 吐一个 delta（`AC109_DELTA_INTERVAL_MS`），每个 delta 让转录行长高 ≈100~120px。只要**有一个 delta 落在这段设桩间隙里**，被跟随中的 pane 就会在「参照已读、手势未发」之间合法地继续向下（或由 follow 的 pin 写下去）——那一刻用户还没动手，这不是缺陷。但三条读数都把它算进了窗口：

- `movedUpBy = before.scrollTop − min(offsets)` = `30 − 120 = −90`：把跟随期的合法增长读成「手势没把视图上移」；
- `highestOffsetDelta = max(offsets) − before.scrollTop` 会把同一段增长读成「被拉回」（这条只是排在 `movedUpBy` 之后，本轮红没走到）；
- `paneWrites` / `pageWrites` 同样把设桩到手势之间的 pin 计入窗口（同样排在后面）。

判 `−90 = 一个 delta 减去手势 30px` 的三条证据：

1. 绿次读数**恒为** `movedUpBy 30`、`highestOffsetDelta 0` —— 只有「设桩间隙里一个 delta 都没落」时才绿；间隙越短（负载越低）越容易绿，恰是本轮 1/3、driver 那次偶发红的形态。
2. 失败现场的页面快照里 **`- button "Scroll to bottom" [ref=f1e296]` 在屏**（`/data/scratch/yale/quay-e2e-Ayo9kW/test-results/transcript-follow-transcri-41527-k-for-the-rest-of-the-reply/error-context.md:215`，`geK0h1` 那份同形）。AC 记录自己写明的假形态是「沿用单一 50px 距底阈值判定脱离、并在增长时 pin（30px 手势仍判为跟随 → 被拉回）」——那个实现**根本不会**让按钮出现。按钮在屏 ⇒ 手势确实脱离了 ⇒ **产品侧的保证成立，红的是窗口的测量**。
3. 键盘半 `movedUpBy 402`（一页 ≈ 400px）：同一处缺陷，只是要它变负需要 ≥400px 的增长落进间隙，量级上更罕见。

### 要落地的不变式

**AC-109 窗口的三个读数——参照 offset、「不得增大（±1）」的上界、写记录——都必须锚在用户手势自己的输入时刻（`wheel` / `keydown`），不得锚在设桩之前。** 跟随在用户动手之前处理掉的增长属于「窗口之前」，不是窗口的行为。

建议实现（择一，或等价物；以不动 liveness 算术者优先）：

- **A（推荐）页内输入锚定**：手势前在 pane 上装 capture 相的 `wheel` / `keydown` 监听，同步记录 `{ t, scrollTop, scrollHeight, clientHeight }`（默认滚动动作发生在事件派发之后，故此值是手势的起点 offset）。窗口的 `movedUpBy` / `highestOffsetDelta` 以该记录为参照，写记录按 `t ≥ 输入时刻` 过滤。采样与写计数的 `t` 都是 `performance.now()`，可直接比较。
- **B（等价）让 delta 不可能落进间隙**：窗口设桩期间闸住 wire double 的投递，手势派发后再放行。窗口内的增长与 `completionPresent === false` / `stream.finished() === false` / `growthsInWindow > 0` 等 liveness 断言不变。

⛔ 不得用「删掉或放宽 `movedUpBy > 0`」来消红：那正是判据自带的假形态钉住的读数（一个从未被移动的 pane 会白过）。修复只改**参照系**，不改判据的区分力。⛔ 不得加 `retries` / `repeat-each` / `test.skip` / `test.fixme`，不得放宽 `AC109_*` 常量。

### 非目标

- **不改 `src/` 的跟随实现**：产品保证成立（证据见「机制」第 2 条），本轮不申领任何产品侧改动。若实现时发现产品侧确有写回，须回到本条说明并另立任务，不得顺手改产品代码。
- 不改 AC-106/107/108/110/111 的语义，但**不得破坏**它们（同一个 spec 文件）。
- 不引入 CSS 钉底技巧、不依赖浏览器 scroll anchoring；不新建 `e2e/*.ts` 文件（会踩 e2e 新文件的 lint 边界）。

## AC

- [x] 判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"` 退出码 0，且在**同一窗口内有别的 e2e lane 在跑**的条件下连跑 ≥10 次全部退出码 0；逐次记录 `exit=… wall=… self=[…]`、`git rev-parse HEAD` 与每次日志里的 `[e2e] server=… client=…` 行（证明用的是本次运行自己的端口/缓存目录），10 行读数原文写进完成记录。
- [x] 绿次读数里 `wheel: movedUpBy > 0`、`highestOffsetDelta ≤ 1`、`paneWrites []`、`pageWrites []`、`buttonVisible true`、`growthsInWindow > 0`、`unpinned []`、`settledGap ≤ 1`，`keyboard` 半同；给出 10 次里 `movedUpBy` 的最小/最大值（修前绿次恒为 `wheel 30 / keyboard 402`）。
- [x] **阴性对照（修前的读数必须红，且确定性）**：保留一份修前参照实现（或临时把参照切回设桩前的 `before` / 不过滤写记录），并在参照与手势之间注入一段**约 400ms 的停顿**（保证恰好一个 delta 落进间隙）⇒ 判据必须非 0，失败形态落在 AC-109 窗口的 `movedUpBy ≤ 0`（本轮实测 `Received: -90`）；退出码与失败原文登记在证据里，之后全部还原。
- [x] **阳性对照（同一注入 + 修后读数必须绿）**：保留同一段 400ms 停顿、只换成修后的输入锚定读数 ⇒ 判据退出码 0，且该次读数满足上一条的全部字段。AC3 与 AC4 一起证明「锚到手势时刻」是承重的，而不是把断言放宽或加长等待。
- [x] **判据未被削弱（AC-109 自己的两条抗假变体仍必须红）**：(i) 按 AC 记录写明的取法，把脱离改回「单一 50px 距底阈值 + 增长时 pin」⇒ **wheel 半**必须红；(ii) 意图只由 wheel/touchmove 提供、不认键盘滚动键 ⇒ **键盘半**必须红。两条都留输出并还原，`git diff` 证明 `src/` 无残留。
- [x] `git diff` 证明 AC-109 自己的断言（`movedUpBy > 0`、`highestOffsetDelta ≤ AC109_GAP_PX`、`paneWrites == []`、`pageWrites == []`、`buttonAppearancesInWindow > 0`、`buttonVisible === true`、`completionPresent === false`、`growthsInWindow > 0`、`pinnedGrowths > 0`、`unpinned == []`、`settledGap ≤ AC109_GAP_PX`）与常量（`AC109_WHEEL_PX`、`AC109_DETACH_WINDOW_MS`、`AC109_PINNED_TAIL_MS`、`AC109_DELTA_COUNT`、`AC109_DELTA_INTERVAL_MS`、`AC109_SCROLLABLE_MIN_PX`、`AC109_GAP_PX`）以及判据命令 `-g "AC-109"` 一行未删未松；diff 内没有 `retries` / `repeat-each` / `test.skip` / `test.fixme`。
- [x] `npm run lint` 退出码 0（如实登记：root tsconfig 与 oxlint 的 include 都不含 `e2e/`，夹具代码另有 `scripts/test.sh --for-task … --allow-thin` 与 AC1 的真实跑动覆盖）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-109 的尾巴由 `2026-09-29T21:40:19.600Z` 的 fail 转回 pass，并在其后**连续多轮** frozenRecheck 中保持 pass（并发与宿主负载不再把它偶发打红）。
- **真落地**：不是把断言放宽、也不是加长等待，而是 AC-109 窗口的**参照系**换成手势自己的输入时刻——跟随在用户动手之前处理掉的增长不再被读成窗口的行为。证据是 AC1 的 10 个退出码与读数、AC3/AC4 的负正对照。
- **读数原文**：AC1 的 10 行 `exit=… wall=… self=[…]` 与 `[e2e] server=… client=…` 行；AC2 的 `movedUpBy` 最小/最大；AC3/AC4 的两次退出码与读数原文（含注入的 400ms 停顿读数）；AC5 两条抗假变体的退出码与失败断言；AC6 的 diff 统计与 `grep` 退出码。
- **前提与不可复现项如实登记**：必须写明 driver 那次 `21:40:19.600Z` 的红**本轮以同形态、同数值复现**（`Received: -90`，直跑 3 次中 1 红），但**没有**验证它当时也一定是这个间隙竞争——保留的现场只有页面快照与 `error-context.md`/`trace.zip`，其中 `button "Scroll to bottom"` 在屏、而没有 `paneWrites` 之类读数。**不得写成「已确证 driver 那次红的机制」**。另登记：本轮直跑绿次读数、宿主 load1（≈28 / 128 核）、以及每次跑动用的是自己的 data-dir 与端口。
- **L_D = 0**。L_D 该轴仍暗，理由：本任务只改 e2e 判据的参照系，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G = 0**。L_G 该轴仍暗，理由：同上 —— 读数是运行期退出码与几何读数，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

## Touches

- `e2e/transcript-follow.spec.ts`
- `tasks/gap-transcript-follow-ac109-window-baseline-race.md`

## 完成记录

**实现（`e2e/transcript-follow.spec.ts`，135 insertions / 16 deletions，唯一改动文件；两个提交 `d2f44458` + `ef6e5111`）**

只换 AC-109 窗口的**参照系**；判据自己的断言、常量与 `-g "AC-109"` 命令一行未动（证据见 AC6）：

- 新增 `installAc109InputAnchor(page)` / `readAc109InputAnchor(page)`：手势前在 window 上装 capture 相的 `wheel` / `keydown` 监听，同步记 `{ t, scrollTop, scrollHeight, clientHeight, type }`。**`{ capture: true, passive: false }` 是承重的，不是样板**：本轮**实测**，passive 监听器读到的 `scrollTop` 已经是本次事件默认滚动**之后**的值（设桩时 pane 立在 539，passive 读到 509，于是 `movedUpBy` 读成 0）——Chromium 对 passive 监听器先滚动再派发，同步读到的才是手势的起点 offset。
- 窗口三个读数改为锚在 `anchor.t`：`anchorOffset = anchor.scrollTop`；`paneWrites` 与 `pageWrites` 按 `t >= anchor.t` 过滤；`windowSamples = detachSamples.filter((s) => s.t >= anchor.t)` 供 `movedUpBy` / `highestOffsetDelta` / `growthsInWindow`。第二个提交把**采样集也在手势处切开**：采样在手势前启动（为了看得见手势两侧的帧），但手势**之前**的帧是跟随还握着的那只 pane，其中落在锚点之下的一个正是锚要排除的那次到达。
- `stubOffset`（设桩前的参照）保留下来**只作诊断**，写进失败信息：`against the gesture's own baseline of … at t… (the stub read …)`。`describeAc109Window` 多收一个 anchor，读数行里多一个 `gesture.anchor` 字段。
- 手势没有以输入事件到达时判据**显式失败**（`expect(anchor).not.toBeNull()`），不退回避桩参照。

### AC1 — 10 连跑（同一窗口内有别的 e2e lane 在跑）

`git rev-parse HEAD` = `ef6e511177bf7410dbcde405f9754c3233ff7100`（10 次同一 sha）。

别的 lane：本 worktree 内重复跑 `e2e/session-filter.spec.ts`（另一个 project、另一份 data-dir、自己的端口），**16 次迭代全部 `exit=0`（每次自报 `5 passed`）**，窗口 `06:14:41 → 06:20:15`，**完整覆盖**判据 10 连跑的 `06:14:45 → 06:19:27`。宿主 load1 ≈ 28 / 128 核。

10 行读数原文（`exit=… wall=… self=[…]` + 该次自己的 `[e2e] server=… client=…` 与 data-dir；每行下附该 run 的 `AC-109 readings:` 原文）：

```
run=01 exit=0 wall=29.15s self=[1 passed (28.3s)] [e2e] server=21581 client=4211 data-dir=/data/scratch/yale/quay-e2e-Sf92sM at=06:15:14
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":69,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":186,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":65,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":282,"pinnedGrowths":18,"unpinned":[],"settledGap":0}]
run=02 exit=0 wall=28.48s self=[1 passed (27.6s)] [e2e] server=27163 client=9927 data-dir=/data/scratch/yale/quay-e2e-gNzW40 at=06:15:43
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":76,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":200,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":306,"pinnedGrowths":18,"unpinned":[],"settledGap":0}]
run=03 exit=0 wall=27.99s self=[1 passed (27.2s)] [e2e] server=17065 client=10669 data-dir=/data/scratch/yale/quay-e2e-XHfEEY at=06:16:11
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":77,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":198,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":318,"pinnedGrowths":19,"unpinned":[],"settledGap":0}]
run=04 exit=0 wall=28.16s self=[1 passed (27.4s)] [e2e] server=2171 client=11601 data-dir=/data/scratch/yale/quay-e2e-2Um6Q2 at=06:16:39
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":78,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":196,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":318,"pinnedGrowths":19,"unpinned":[],"settledGap":0}]
run=05 exit=0 wall=28.02s self=[1 passed (27.1s)] [e2e] server=12349 client=21791 data-dir=/data/scratch/yale/quay-e2e-aDq1QR at=06:17:07
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":77,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":192,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":75,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":316,"pinnedGrowths":18,"unpinned":[],"settledGap":0}]
run=06 exit=0 wall=28.06s self=[1 passed (27.3s)] [e2e] server=21011 client=6841 data-dir=/data/scratch/yale/quay-e2e-sIXOm3 at=06:17:35
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":75,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":186,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":310,"pinnedGrowths":19,"unpinned":[],"settledGap":0}]
run=07 exit=0 wall=27.71s self=[1 passed (27.0s)] [e2e] server=20229 client=24225 data-dir=/data/scratch/yale/quay-e2e-ZiDNBd at=06:18:03
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":76,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":198,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":-10,"detachFrames":72,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":318,"pinnedGrowths":19,"unpinned":[],"settledGap":0}]
run=08 exit=0 wall=27.91s self=[1 passed (27.1s)] [e2e] server=16839 client=29599 data-dir=/data/scratch/yale/quay-e2e-3f3GbH at=06:18:31
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":76,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":202,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":318,"pinnedGrowths":18,"unpinned":[],"settledGap":0}]
run=09 exit=0 wall=28.55s self=[1 passed (27.7s)] [e2e] server=23151 client=24645 data-dir=/data/scratch/yale/quay-e2e-B826Ft at=06:18:59
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":76,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":198,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":318,"pinnedGrowths":19,"unpinned":[],"settledGap":0}]
run=10 exit=0 wall=27.81s self=[1 passed (27.0s)] [e2e] server=3335 client=12769 data-dir=/data/scratch/yale/quay-e2e-x4Jt1h at=06:19:27
  AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":75,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":184,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":71,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":313,"pinnedGrowths":18,"unpinned":[],"settledGap":0}]
```

判据命令：`npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"`；10 次退出码全 0（`nonzero_exits=0`），每行的端口对与 data-dir 两两不同（21581/4211、27163/9927、17065/10669、2171/11601、12349/21791、21011/6841、20229/24225、16839/29599、23151/24645、3335/12769）——每次用的都是它自己那份服务与缓存目录，不是别的 run 的。

### AC2 — 读数的最小/最大（10 次）

- `movedUpBy`：`wheel` min **30** / max **30**；`keyboard` min **402** / max **402**（与修前绿次恒为 `wheel 30 / keyboard 402` 一致）。
- `highestOffsetDelta`：`wheel` 10 次全 **0**；`keyboard` 8 次 **0**、2 次 **−10**（`run=07`、以及此前一轮的 `run=10` 同类读数）——全部 ≤ 1（负值是窗口内向下的取样抖动，方向无害）。
- 其余字段 10 次全满足：`paneWrites []`、`pageWrites []`、`buttonVisible true`、`buttonAppearancesInWindow 1`、`completionPresent false`、`growthsInWindow 5`（>0）、`pinnedGrowths 11/18`（>0）、`unpinned []`、`settledGap 0`（≤1）、`detachFrames 65~80`。

### AC3 — 阴性对照（修前参照 + 400ms 注入 ⇒ 确定性红）

注入：临时把参照切回设桩之前——`const anchorOffset = stubOffset; const anchorT = 0;`（等于不过滤写记录、不切采样集），并在**参照与采样器之间**（`const stubOffset = (await readGeometry(page)).scrollTop;` 之后）注入 `await page.waitForTimeout(400);`，保证恰好一个 delta 落进原间隙。

`EXIT=1`，**3/3 同一形态**，失败落在 AC-109 窗口的第一条断言上：

```
Error: wheel: the gesture has to have moved the viewport up, or "nothing wrote it back" is a statement about a pane the user never moved
expect(received).toBeGreaterThan(expected)
Expected: > 0
Received:   -96
```

`Received: -96` 与 AC 记录里本轮实测的 `-90` **同形同值类**（= 一个 delta 减去手势 30px，随该次 delta 高度在 ~90~100 间浮动），且是确定性的（3/3 全红，不再是要撞的偶发）。

登记一条反例以免误导：第一次把这段停顿放在**采样器启动之后**、手势之前时，失败的 `Received:` 是 **`0`**（`min(offsets)` 落在采样器启动后、pin 生效前的那一帧，恰等于 stub）——同样满足「`movedUpBy ≤ 0`」，但没有复现出 `−90` 的形状。**停顿的位置决定它是否落在原缺陷的间隙里**：只有在「参照已读、采样未启」之间注入，才重现 `−90` 那一类读数。上面 3/3 的红用的是后一个（正确的）位置。

**注入已全部 `cp` 还原**：还原后 worktree 的 spec 与 `/tmp/ac109-spec-final.ts` 逐字节相同（`sha1=1a9eabce75596ade86195022784c6d11c69ff989`），`git status --porcelain` 空。

### AC4 — 阳性对照（同一 400ms 注入 + 修后读数 ⇒ 绿）

保留**同一段、同一位置**的 400ms 停顿，只把参照换回 `anchor`（`anchorOffset = anchor!.scrollTop; anchorT = anchor!.t;`）：**5/5 `EXIT=0`**（自报 `1 passed`，27~28s）。读数原文（`run=01` / `run=02`）：

```
[{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":80,"growthsInWindow":4,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":171,"pinnedGrowths":9,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":-10,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":293,"pinnedGrowths":17,"unpinned":[],"settledGap":0}]
[{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":77,"growthsInWindow":4,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":194,"pinnedGrowths":10,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":402,"highestOffsetDelta":0,"detachFrames":74,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":269,"pinnedGrowths":17,"unpinned":[],"settledGap":0}]
```

AC3 与 AC4 是**同一处注入、同一份树**，只差参照系：`-96` / 红 ⇔ `30 / 0` / 绿。所以绿的来源是「锚到手势时刻」，不是把断言放宽、也不是加长等待。

### AC5 — 两条抗假变体仍必须红

两条都改 `src/modules/chat/hooks/useChatSessionState.ts`（产品侧），跑完即 `cp` 还原，`git diff` 证明 `src/` 无残留。

**(i) 脱离改回「单一 50px 距底阈值 + 增长时 pin」⇒ wheel 半红。** 取法：`onScroll` 里把方向判定换成距离判定 `if (!isNearBottom()) { setIsUserScrolledUp(true); return; }`，并按假形态的定义**摘掉两条输入驱动的脱离**（`onWheel` 里「朝上且仍有过往页 ⇒ 记脱离」、`onKeyDown` 里的按键脱离），只留 50px 阈值 + 默认的增长 pin。

`EXIT=1`，**2/2 同一形态**，红在 wheel 半：

```
Error: wheel: the control has to mount inside the window — a gesture is what takes the pane, so the control coming back is this gesture's reading and a control that was already mounted belongs to whatever happened before it
expect(received).toBeGreaterThan(expected)
Expected: > 0
Received:   0
```

30px 的手势把 pane 留在 50px 带内 ⇒ 仍判「跟随」⇒ 下一次增长把视图 pin 回去，控制从不出现（`buttonAppearancesInWindow 0`）。**正是 AC 记录写的假形态**，也是「快照里按钮在屏」能反证产品侧保证成立的同一个读数。

**(ii) 意图只由 wheel/touchmove 提供、不认键盘滚动键 ⇒ 键盘半红。** 取法：`onKeyDown` 里去掉键盘的意图记录（`noteInput()`）与按键脱离，`SCROLL_INTENT_KEYS` / `SCROLL_UP_INTENT_KEYS` 的门还在但不再产生意图——等于键盘不承重。

`EXIT=1`，**2/2 同一形态**，红在 keyboard 半：

```
Error: keyboard: the control has to mount inside the window — a gesture is what takes the pane, so the control coming back is this gesture's reading and a control that was already mounted belongs to whatever happened before it
expect(received).toBeGreaterThan(expected)
Expected: > 0
Received:   0
```

PageUp 不再产生意图 ⇒ 意图仍「跟随」⇒ 增长把视图 pin 回去 ⇒ 键盘半的窗口测不到脱离。两条变体**各自只红自己那一半**（i 只红 wheel、ii 只红 keyboard），说明这条判据对两种假形态的区分力仍在。

**还原证据**：`cp /tmp/ac109-follow-final.ts src/modules/chat/hooks/useChatSessionState.ts` 后 —— `sha1=af972add9be68622a9589578377022b0529e1a0b`（与注入前逐字节相同）；`git status --porcelain` **空**；`git diff --stat` **空**；`git diff -- src | wc -l` = **0**；`grep -rn "AC5(i) VARIANT\|AC5(ii) VARIANT\|AC3 PROBE\|AC4 PROBE\|AC109DIAG" e2e src | wc -l` = **0**。

### AC6 — 判据未被削弱（diff 证明）

`git -C <worktree> diff --stat <merge-base>..HEAD`（merge-base = `a42f38c3`，即当时 develop）：

```
 e2e/transcript-follow.spec.ts | 151 +++++++++++++++++++++++++++++++++++++-----
 1 file changed, 135 insertions(+), 16 deletions(-)
```

- 删除行里**没有**任何断言谓词：`git diff … | grep -E '^-' | grep -E 'toBeGreaterThan|toBeLessThanOrEqual|toEqual|\.toBe\(|toContain'` → **空**。
- `AC109_*` 常量的**定义**一行未动：`grep -E '^[-+].*const AC109_'` → **空**。现存常量（`grep -n`）：`AC109_WHEEL_COMPLETION_MARKER :1248`、`AC109_KEY_COMPLETION_MARKER :1249`、`AC109_DELTA_COUNT :1260`、`AC109_DELTA_INTERVAL_MS :1261`、`AC109_SCROLLABLE_MIN_PX :1264`、`AC109_WHEEL_PX :1267`、`AC109_DETACH_WINDOW_MS :1277`、`AC109_PINNED_TAIL_MS :1280`、`AC109_GAP_PX :1283`。
- 判据命令 `-g "AC-109"` 未改（删除行里没有任何含 `AC-109` 的行）。
- 删除的 16 行只含：`const before = await readGeometry(page)` 这条参照读取、由它派生的三条读数表达式、两条失败信息串（把「a baseline of ${before.scrollTop}」换成「the gesture's own baseline of … (the stub read …)」），以及被新的 `windowSamples` 取代的 `detachSamples` 写法。
- `git diff … | grep -nE '^\+.*(retries|repeat-each|test\.skip|test\.fixme|describe\.configure|waitForTimeout|\.setTimeout\()'` → **空**（没有加 retries / repeat-each / skip / fixme，也没有加等待）。

### AC7 — lint

`npm run lint`（`oxlint src/ server/ scripts/ shared/`）→ **exit 0**，输出只有既有的 warning（`react-hooks(exhaustive-deps)` 等，与本任务无关）。如实登记：root tsconfig 与 oxlint 的 include 都不含 `e2e/`，夹具代码另有 `scripts/test.sh --for-task gap-transcript-follow-ac109-window-baseline-race --allow-thin` 与 AC1 的 10 次真实跑动覆盖。

### 前提与不可复现项（逐条对应 DoD）

1. **driver 那次红本轮以同形态、同数值类复现，但机制未确证**：直跑 3 次 1 红，`Received: -90`，失败信息与 `21:40:19.600Z` 那条逐字相同；AC3 的注入也稳定重现同一类读数（`-96`）。但**没有**验证 driver 那次当时也一定是这个设桩间隙竞争——保留的现场只有页面快照与 `error-context.md`/`trace.zip`，其中 `button "Scroll to bottom"` 在屏，而**没有** `paneWrites` / 采样 `t` 这类读数。**不写成「已确证 driver 那次红的机制」**；本任务确证的是：这条判据在「一个 delta 落进设桩间隙」时必然误红，且该条件可被确定性地注入（AC3）与消除（AC4）。
2. **本轮直跑绿次读数**：`wheel movedUpBy 30 / highestOffsetDelta 0 / growthsInWindow 5 / paneWrites [] / pageWrites [] / buttonVisible true / unpinned [] / settledGap 0`，`keyboard movedUpBy 402`（AC1 的 10 行原文）。
3. **宿主与端口前提**：宿主 load1 ≈ 28 / 128 核；每次跑动自己在日志里报了 `[e2e] server=… client=…` 与自己的 `data-dir`（AC1 的 10 对端口 + 10 份 data-dir 两两不同），不是复用的服务。
4. **一处曾观察到、未认领的形态**：控制实验期间（在窗口前注入 400ms 探针、且用 `passive: true` 的监听）曾读到 wheel 交付后 pane 反而**向下**（`anchor 635 → samples 725`）的一例；该例在 `passive: true`（≈ 修前配置）下 5 次中 1 次出现，而修后配置无探针时 6/6 绿。判据侧只把它当作「探针相位会暴露另一处既有竞争」的观察，**本任务不认领其机制**，也没有在 AC1 的 10 连跑（无探针）里再出现。

### 2b — 预合并与 scoped 门

- `bash <worktree>/scripts/test.sh --for-task gap-transcript-follow-ac109-window-baseline-race --allow-thin` → **exit 0**（`suite-scope-check: PASS — 1 active task(s) scanned …`；`no scoped test files for gap-transcript-follow-ac109-window-baseline-race (thin)`——本任务 Touches 里没有 `*.test.*`，scoped 门走 thin 路径；e2e 判据由 AC1 的 10 次真实跑动覆盖）。
- **合并与 cache 重打跑了多轮，因为账本写会推进 develop**：每次 `task_write`（Provider ABI）都把 `tasks/<id>.md` 落在 checkout 侧并前推 develop（`a42f38c3` → `48799157` → `8d34f273`），而 scoped-gate cache 的 key 必须是**分支 HEAD 含有的** develop sha。所以每次账本写之后都重跑一遍：`git -C <worktree> merge --no-edit develop` → 再 `test.sh --for-task … --allow-thin` → 再 `--write-scoped-gate-cache`。过程里的合并提交：`7b9439e6`、`ebe0124f`（都只带进 `tasks/gap-transcript-follow-ac109-window-baseline-race.md`，无冲突）。
- **最终状态**：`.quay/scoped-gate-cache.json` 的 `developSha` 是**最后一次账本写之后的 develop tip**，且分支 HEAD 含它（`git -C <worktree> merge-base --is-ancestor <cache.developSha> HEAD` 为真）；`developSha` 之后 develop 纵有新的**账本-only** 提交，分支 delta 不变，cache 仍覆盖本任务的 scoped 判据。
- 分支上的代码提交：`d2f44458`（输入锚定）、`ef6e5111`（采样集在手势处切开）。

### 轴读数

- L_D = 0，理由：该轴仍暗——本任务只改 e2e 判据的参照系，不新增领域数据能力，没有可读出的领域数据轴读数。
- L_G = 0，理由：该轴仍暗——读数是运行期退出码与几何读数，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。
