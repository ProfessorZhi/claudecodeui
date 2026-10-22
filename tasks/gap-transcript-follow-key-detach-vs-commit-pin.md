---
id: gap-transcript-follow-key-detach-vs-commit-pin
title: 流式期间 PageUp 的向上意图必须在按键处即生效：键已按下、浏览器尚未报告 scroll 的那一帧里 commit-time 增长 pin
  不得覆盖它（AC-109 判据 e2e/transcript-follow.spec.ts 键盘半间歇红）
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

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本条修的是 [[gap-transcript-follow-small-gesture-detaches]]（done）落地后残留的一帧竞态——那条把「是否跟随」从距底阈值改成**方向驱动**，并给 wheel 向上加了一条立即脱离分支，键盘半则复用了 `scroll` 报告的方向判读。同族的 `e2e/transcript-follow.spec.ts` 仪器（播种 transcript、几何 pin、wire double 慢速流式、布局后采样约定）分别出自 [[gap-transcript-follow-on-content-resize]] 与 [[gap-transcript-follow-on-real-stream]]（均 done），本任务不重复申领。

### 现象：AC-109 键盘半间歇红（2026-09-22 实测）

目标驱动的核验最近 8 轮里 7 绿 1 红。红的那一轮的 gate 记录（`gate-events.jsonl`，`item_id=AC-109`，`2026-09-22T07:17:27.356Z`，`verdict=fail`）其 reason 是 stderr-first 被截断的，真实失败留在该轮自己的 e2e 数据目录（goal gate 的 TMPDIR 是 `/data/scratch/yale`）：

`/data/scratch/yale/quay-e2e-JaEpAF/test-results/transcript-follow-transcri-41527-k-for-the-rest-of-the-reply/error-context.md`

```
Error: keyboard: the pane must never be moved back down while the user is holding it, against a baseline of 2207
expect(received).toBeLessThanOrEqual(expected)
Expected: <= 1
Received:   159
```

同一次读数的关键字段（逐字取自该文件）：

- `gesture`：`{"startedAt":8830,"endedAt":8859}`；`inputs`：`[[8850,"keydown"]]` —— 只有 keydown，无 wheel / touch
- `scrolls`：`[8884,8902,8918,…]` —— 浏览器**第一条** `scroll` 报告在 8884
- `writes`：**只有一条** `{"value":2463,"t":8883,"frames":[…"at HTMLDivElement.set [as scrollTop] (eval …)","…/useChatSessionState.ts:150:25","…/useChatSessionState.ts:352:15","at commitHookEffectListMount …"]}`
- `sampled`：`[8830,2207,2703,496]`,`[8849,2207,2703,496]`,`[8868,2366,2862,496]`,… —— 基线 2207，写后一帧 2366（Δ=159），此后随 PageUp 动画递减

即 **app 在 t=8883 写了 scrollTop，而浏览器的第一条 scroll 报告 t=8884 才到**：用户 8850 已按下 PageUp，这一帧里 app 把视口按回了增长后的底部。

我的独立复跑（安静窗口，`env -u QUAY_E2E_DATA_DIR npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"`）退出码 0、22.9s、两半全绿（`movedUpBy=30/434, highestOffsetDelta=0, paneWrites=[], pageWrites=[], unpinned=[], settledGap=0`）。⇒ 这是**竞态**而非必红：上面的红是它的一个样本，也正是 AC-109 判据的间歇假绿面（最近 8 轮 7 绿）。⛔ 不要把它当 flake 关掉。

### 机制（2026-09-22 源码核对，`src/modules/chat/hooks/useChatSessionState.ts`）

1. `onKeyDown`（:955-957）对 `SCROLL_INTENT_KEYS` 只调 `noteInput()`——它开 200ms 手势窗口（`userScrollGestureRef`）并清 `programmaticScrollEchoesRef`，**不置脱离**。
2. 脱离只在 `onScroll`（:877-915）里由**浏览器移动之后的偏移方向**判定（:907 `container.scrollTop < previousTop - 1`）。PageUp 的默认动作是浏览器**动画式**滚动，第一条 `scroll` 报告晚于 keydown 一帧以上（本次 8850 → 8884，34ms）。
3. 这一帧里流仍在到达。一个 delta 提交 ⇒ `chatMessages` 换身份 ⇒ :771 的 `useLayoutEffect`（依赖 `[judgeTranscriptGrowth, chatMessages]`）跑 `judgeTranscriptGrowth()`；它两道门此刻都放行——`isUserScrolledUpRef.current` 仍是 false（脱离要等 scroll 报告才会写），`|scrollTop − previousBottom| ≤ 1` 仍成立（浏览器还没动偏移）。于是 :773 `writeScrollTop(plan.container, plan.bottom)` 按下。
4. :759-762 的注释把这条路径的安全性建立在一个前提上：「a gesture cannot run inside this task … A gesture made before the commit has already moved the offset」——**动画式按键滚动恰好证伪它**：手势已经发生过（app 见过 keydown），但偏移还没动。
5. 延迟路径（:806-812 `scrollToBottom`）有 `lastPlacedTopRef` 这道「键已按下但报告未到」的门（:337-355 的注释正是点这个形状）；本次它也不拦，因为 pane 还停在 `lastPlacedTopRef`(2207) 上。t=8883 时唯一存在、且能说「有输入在飞」的信号是 `userScrollGestureRef`，而 `judgeTranscriptGrowth` 从不读它。

⚠️ 这不是 commit-time pin 独有的洞：只要脱离仍等到 scroll 报告，**任何**在报告到达之前落地的程序写入（延迟定时器、observer 帧、finalize）都能赢同样的竞态。所以修法必须落在「输入的时点」，而不是给某一个写入者打补丁。

### 方案

**A. 让向上的意图在输入处立即生效**（`src/modules/chat/hooks/useChatSessionState.ts`）

- 给向上的滚动键（`ArrowUp` / `PageUp` / `Home`）加一条与 wheel 向上同形的**立即脱离**：`onKeyDown` 里判到向上键、且事件目标是 pane（`isOverPane` 对 pane 自身也成立）⇒ 立刻脱离，不等浏览器报告。
- **同时写 ref 与 state**：`isUserScrolledUpRef` 由 :577-590 的被动 `useEffect` 从 state 镜像而来，而 pin 读 ref 发生在 **layout** effect 里。React 实践上会在下一次渲染前 flush 被动 effect，但这一帧的先后正是本竞态的赌注——直接写 ref 把这份不确定去掉。
- ⛔ 只对向上键：`ArrowDown`/`PageDown`/`End`/空格不得脱离。
- ⛔ 不得改成「`userScrollGestureRef` 开着就不 pin」：若某次手势以回到贴底结束（wheel 向下到底），200ms 静默窗口内 pane 会被晾着不 pin，AC-108 的逐帧 ≤1px 与 AC-106/107 都会破。
- ⛔ 不得改动 `onScroll` 的方向判读与 `noteInput()` 的现成语义（wheel / 触摸 / 拖滚动条路径保持原样）；⛔ 不得让新分支触发 `loadOlderMessages`；⛔ 不得动 `pendingScrollRestore` / 搜索跳转。
- **保留 AC-111**：本分支只由 keydown 输入驱动，浏览器自身的 anchoring / clamp 不经过它。

**B. 单测定点钉死这一帧**（`src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 的 `describe('content-growth follow')` 内新增）

- 走**提交路径**而不是 observer 路径：`mountFollow()` → `container.grow(400)` → 在 pane 上派发 `PageUp` 的 `keydown`（app 已见到输入；jsdom 不会移动任何偏移，正好等价「报告未到」）→ 触发一次**带增长的重渲染** → 断言 `container.writes` 为 `[]`。
- ⚠️ 这一步最容易假绿：`:545` 每次渲染都重新读 `sessionStore.getMessages(id)`，而 `chatMessages`（:547）memo 在 `[storeMessages, pendingUserMessage]` 上——夹具的 `getMessages` 返回**同一个数组实例**，裸 `rerender` 不会换 `chatMessages` 的身份，:771 的 layout effect 也就不会重跑，用例会「绿」得毫无意义。必须让 `getMessages` 在增长那次渲染返回**新数组**（把 `store` 从 `mountFollow` 里返回出来再 mock，或为这条用例单写一个 mount），并**证明这次重渲染真的走到了 pin**（见下条正向对照）。
- 正向对照（避免「零写入」由 pin 已死凑出）：同形但**不派发** keydown 的那一次提交必须写入 `container.bottom`。
- 该单测在改源码**之前**必须确定性红，改完必须绿；两次读数与退出码都记入完成记录。

**C. 判据不改**

`e2e/transcript-follow.spec.ts` 已经能判别这个形态（它就是这样红的），本任务不动它；若为取读数临时加过打印，必须还原。**故不列入 Touches**：声明了却不写的文件会触发 anti-drift 硬失败。

### 非目标

- 不重写脱离判据的方向语义，不动 `isNearBottom` 的 50px；AC-106/107/108/110/111 一行不破。
- 不改 `e2e/transcript-follow.spec.ts` 的任何断言；不缩短 ≥20 delta / ≥5s 的夹具下限。
- 不做 `docs/architecture/05-scrolling.md` / `02-realtime-stream.md` 的同步（那是 GOAL-004 退出条件里的独立一条，不在本 AC 的判据面内）。
- 不引入 CSS 钉底技巧、不依赖浏览器 scroll anchoring。

## AC

- [x] 单测（**改源码之前**）确定性红：pane 上派发 `PageUp` 的 `keydown`（无任何偏移移动、无 scroll 报告）后触发一次带增长的提交，`container.writes` 非空（pin 落在 keydown 之后）；输出、退出码与失败读数记入完成记录。
- [x] 同一单测在改完之后绿：同形场景 `container.writes` 为 `[]`，且在提交渲染之前 `result.current.isUserScrolledUp` 已为 true（意图在输入处生效，而不是等报告）。
- [x] 正向对照绿：同形但**不派发** keydown 的那次提交写入 `container.bottom`，证明重渲染确实走到了 pin，「零写入」不是空实现凑出来的。
- [x] 向下键不脱离：`ArrowDown`/`PageDown`/`End` 的 keydown 之后 `isUserScrolledUp` 仍为 false（断言在单测内，与向上键同批）。
- [x] `npm run test:client` 退出码 0（含 `transcriptScrollOwnership.test.tsx` 全绿）。
- [x] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"` 连续 ≥3 次退出码 0，每次记 wall time（必须落在 goal gate `runAcceptance` 的 60s 硬超时之内）。
- [x] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0（挡住「把 commit-time pin 一票门掉」那类过度修法——它会让 pane 在静默窗口内不再逐帧贴底）。
- [x] `npm run typecheck` 退出码 0；`npm run lint`（= `oxlint src/ server/`；⛔ 裸 `npx oxlint` 在干净 checkout 上就退出 1，不作为判据）退出码 0。

## DoD

真实落地判据：不是「e2e 恰好绿了一次」——那正是本竞态的假绿面（最近 8 轮 7 绿）。实体是**单测的那一帧**：`PageUp` 的 keydown 已经到达 app、浏览器的 `scroll` 报告还没到的这一帧里，一次带增长的提交不得再写 scrollTop。改源码前该单测必须红、改完必须绿，两次输出与退出码都记入完成记录；随后 AC-109 判据连续 ≥3 次绿（安静窗口、每次记 wall time），并由驱动器下一轮经 `goal_ac: AC-109` 独立核验时在 `.quay/gate-events.jsonl` 看到 verdict 由 fail 翻 pass。

⛔ 不得靠 spec 里 `evaluate` 打补丁、不得靠放宽 wheel/键盘窗口或缩短夹具换绿；不得删改任何既有断言（判别方式：改源码前单测是红的，且无 keydown 的正向对照仍然写入）。

⛔ 已知仪表风险，如实记录而不是谎报绿：goal gate 的 `runAcceptance` 有 60s 硬超时（同形既有实测 ~23–27s，本任务新增的两次 AC-109/AC-108 复跑都要单独记时）。若某次以 `acceptance timed out` 收场，那是判据仪表的读数丢失——点名它，不要把超时当绿，也不要把超时当代码缺陷。本竞态的 e2e 触发概率约 1/9（2026-09-22 的 8 轮核验里 1 红），故 e2e 的连续绿**不能**单独作为修复证据，单测那一帧才是。

登记（避免下一轮踩同一坑）：e2e 端口每次运行 `listen(0)` 现取（`playwright.config.ts`），但同一 checkout 内并发跑 playwright 仍会共享 `test-results/` 而产生确定性 trace ENOENT，请在**安静窗口**取读数；取读数时⛔ 不要自行设置 `QUAY_E2E_DATA_DIR`——那会让 `isDataDirOwner` 为 false（`playwright.config.ts:12`）从而跳过 `seedTranscriptFollowTranscript()`，workspace 永不出现，`beforeAll` 会以「找不到项目行」假红（2026-09-22 实测踩过）。`scripts/test.sh` 的 scoped 门对 `e2e/*.spec.ts` 判 thin，那是通过、不是坏门。

L_D 该轴仍暗，理由：本任务只改前端滚动意图的生效时点并新增一条 jsdom 单测，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器里的 scrollTop 写入次数与帧几何（gap），不是生成质量轴。

## Touches

- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- tasks/gap-transcript-follow-key-detach-vs-commit-pin.md

## 完成记录

工作树 `task/gap-transcript-follow-key-detach-vs-commit-pin`（worktree `.claude/worktrees/gap-transcript-follow-key-detach-vs-commit-pin`），先 `git merge --no-edit develop`（fast-forward 到 `4cb5a7c9`，仅 `tasks/gap-session-fork-lineage-list.md` 变动，与本案两个源文件无交集）。

**改动面**（与 Touches 一致，无第三方文件）：

- `src/modules/chat/hooks/useChatSessionState.ts`：新增模块级 `SCROLL_UP_INTENT_KEYS = {ArrowUp, PageUp, Home}`；`onKeyDown` 在原有 `noteInput()`（语义未动）之后，对「向上键 + `isOverPane(event)`」立刻 `setIsUserScrolledUp(true)` **并** `isUserScrolledUpRef.current = true`。写 ref 是必需的：pin 在 layout effect 里读 ref，而 ref 由被动 effect 从 state 镜像，state-only 的写会让本竞态要修的那一次提交仍读到旧值。向下键（`ArrowDown`/`PageDown`/`End`/空格）路径一行未动。`onScroll` 的方向判读、`noteInput()`、`lastPlacedTopRef`、`pendingScrollRestore` / 搜索跳转均未触碰。
- `src/modules/chat/tests/transcriptScrollOwnership.test.tsx`：`mountFollow` 现额外返回 `rerender`/`store`/`messages`/`session`，并新增绑定的 `commitGrownRow()`——它向 store **追加一条新行**（新数组身份），以此驱动 `chatMessages` 换身份、真正重跑 :771 的 layout effect（裸 `rerender` 复用同一数组会假绿）；`store` 因此从内联构造改为具名 `messages`。新增 3 条用例（提交路径 + 正向对照 + 向下键），既有 14 条断言一行未改。
- `tasks/gap-transcript-follow-key-detach-vs-commit-pin.md`（AC 勾选与本节）。

**改源码之前**（`npx vitest run src/modules/chat/tests/transcriptScrollOwnership.test.tsx -t "scroll key the browser has not reported"`）：

```
{ intentAtInput: false, writes: [ 4900 ] }   ← 期望 { intentAtInput: true, writes: [] }
Test Files 1 failed (1) / Tests 1 failed | 16 skipped (17)
EXIT=1
```

`writes: [4900]` 正是 `container.bottom`（grow(400) 之后 5000+400−500）——pin 落在 keydown 之后，与线上 `Δ=159` 同形。两条读数放在**同一个** `assert.deepEqual` 里，红时不至于只报最先命中的那一半。

**改完之后**（同一文件全量）：`Test Files 1 passed (1) / Tests 17 passed (17)`，`EXIT=0`。

**逐条 AC 读数**：

1. 改源码前确定性红 ✓ —— 上框；`EXIT=1`。
2. 改完绿 ✓ —— 同用例 `{intentAtInput: true, writes: []}`，`EXIT=0`。`intentAtInput` 在提交**之前**读取，故「意图在输入处生效」不是提交凑出来的。
3. 正向对照 ✓ —— `pins the same growth when no scroll key was pressed` 断言 `writes == [container.bottom]`，绿 ⇒ 同一次提交确实走到了 pin。
4. 向下键 ✓ —— `does not detach on a scroll key that asks for the bottom` 断言 `[false,false,false]`（`ArrowDown`/`PageDown`/`End`），绿。
5. `npm run test:client` ✓ —— `Test Files 86 passed (86) / Tests 597 passed (597)`，`EXIT=0`。
6. AC-109 连续 4 次 ✓ —— `EXIT=0`，wall **25s / 24s / 24s / 23s**（安静窗口，未设 `QUAY_E2E_DATA_DIR`），全部远在 60s 硬超时内。每次两半读数一致：wheel `movedUpBy=30`、keyboard `movedUpBy=434`，两者均 `highestOffsetDelta=0, paneWrites=[], pageWrites=[], unpinned=[], settledGap=0`。
7. AC-108 ✓ —— `EXIT=0`，wall **17s**；`minGapPx=0, maxGrowthFrameGapPx=0, offBottomFrames=0, unrepairedFrames=[], unpinnedFrames=[]`，22 个 delta 逐帧贴底 ⇒ 「把 commit-time pin 一票门掉」那类过度修法已被判据挡下。
8. `npm run typecheck` `EXIT=0`（三个 tsconfig 全过）；`npm run lint` = `oxlint src/ server/ scripts/` `EXIT=0`（余下为既存 warning）。

⛔ 无超时发生，故没有「读数丢失」需要点名；e2e 每次都单独记了 wall time。本竞态 e2e 触发概率约 1/9，故不用 e2e 的连续绿单独作修复证据——证据是上面单测那一帧（改前 `writes:[4900]`、改后 `[]`）与正向对照。`e2e/transcript-follow.spec.ts` 与 `playwright.config.ts` 一行未改。
