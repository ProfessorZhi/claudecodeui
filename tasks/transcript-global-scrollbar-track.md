---
id: transcript-global-scrollbar-track
title: AC-214 自绘全局滚动条：滑块位置 = 整段历史中的消息序号位置，可拖动、可点击、可键盘操作，拖动只对最终位置取页
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - transcript-turn-rail-and-jump
goal_ac: AC-214
---
## Proposal

现状：转录区只有原生滚动条，它反映的是「已加载那一段」的像素位置。拖到顶并不意味着到了会话开头；已加载窗口在前插时滑块还会因行高被测量而抖动。人 yale 裁定（2026-10-04）：滚动条走自绘轨道，按消息序号（不是像素）计位置。

要做的事：在轮次导航轨道（前置任务交付的 TranscriptTurnRail）上叠加滚动条语义——一个滑块，位置比例 p = (窗口首行的绝对序号 + 窗口内当前首行的偏移序号) / total，只依赖 store 窗口模型的 startIndex 与行的序号，不读 scrollTop/scrollHeight 的像素比，所以前插与行高修正都不会让它抖。交互：(1) 拖动：拖动期间只更新滑块与预览气泡（含该处轮次摘要与时间，摘要来自大纲，不发请求），松手并停顿后才对最终位置发起一次取页（`loadWindowAround`），拖动期间取页请求数 ≤1；(2) 点击轨道空白处跳到该位置；(3) 键盘：滑块是 role="scrollbar" 的可聚焦元素，带 aria-valuenow/min/max 与 aria-orientation，Home/End/PageUp/PageDown/方向键移动；(4) 触屏窄屏也可拖动（Pointer Events，touch-action 设置得当）。滑块位置按序号线性，一轮里有很长的工具输出时像素上会显得走得慢，这是已裁定的取舍。拖动与滚动写入必须走 `writeScrollTop` 通道，不得直接写 container.scrollTop。

不在本任务内：隐藏原生滚动条（下一任务）。本任务完成后两条滚动条会并存。

## Plan

1. 先写判据文件 `e2e/transcript-global-scrollbar.spec.ts` 的 AC-214 用例（共用种子 `e2e-transcript-jump`，读滑块几何、网络层取页计数、键盘与点击）。先看它红。
2. 在 useTurnNavigation 中加入 p 的计算与拖动状态机；TranscriptTurnRail 渲染滑块、预览气泡与 ARIA。
3. 补 i18n 键（滚动条与预览的 aria 文案）。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-global-scrollbar.spec.ts -g "AC-214"` 退出 0。红态基线：spec 文件不存在。
- [x] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) p 取自 scrollTop/scrollHeight ⇒ 跳转后位置断言红；(b) 拖动时每个 pointermove 都取页 ⇒ 取页计数断言红；(c) 窗口前插时 p 随已加载行数变化 ⇒ 单调性断言红。
- [x] AC3 既有行为不回退：`npx playwright test e2e/transcript-follow.spec.ts` 与 `e2e/transcript-jump-to-turn.spec.ts` 保持绿；写下读数。
- [x] AC4 i18n 完整（全语言 chat.json 含新键）。
- [x] AC5 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 滑块位置来自序号而非像素，判据里有「窗口还在尾部而 p≈0.10」的读数。
- 拖动期间零中间位置取页。
- 滑块可被读屏识别为 scrollbar 并可键盘操作。
- 遵守 `frontend-module-standards`；只动 `## Touches` 列出的文件。

## Touches

- src/modules/chat/transcript/TranscriptTurnRail.tsx
- src/modules/chat/hooks/useTurnNavigation.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- e2e/transcript-global-scrollbar.spec.ts (new)
- tasks/transcript-global-scrollbar-track.md

## Evidence

**Implementation.** `TranscriptTurnRail.tsx` is where both the position and the interaction live, entirely from data the rail already receives (`turns` — each tick's `index` is its absolute message subscript — and `currentTurnId`). The thumb's fraction is `turns[currentTurn].index / turns[last].index` (`progressOfTurnAt`): the denominator is the last turn's own subscript, so the track's far end is the last turn you can jump to and every value in between is a ratio of two absolute subscripts. No `scrollTop`/`scrollHeight` is read for the position anywhere in the rail. A drag holds its own chosen fraction (plus a preview of the turn under the thumb, with its summary and time), and only on release — after `DRAG_COMMIT_PAUSE_MS` of rest — issues one `onJumpToTurn`, i.e. one `loadWindowAround`; a click and a tick activated by keyboard issue one immediate jump and then follow the position the window actually lands at. The thumb is `role="scrollbar"`, focusable, with `aria-orientation="vertical"`, `aria-valuemin/max/now`, and Home/End/PageUp/PageDown/arrow handling; `touch-action: none` on the thumb plus Pointer Events make it draggable on touch. `turnRail.scrollbar` was added to all twelve locale bundles.

**AC1 — criterion green.** `npx playwright test e2e/transcript-global-scrollbar.spec.ts -g "AC-214"` → `1 passed (18.3s)`, exit 0; re-run on the tree after `develop` was merged in → `1 passed (18.0s)`, exit 0. Real Chromium against the real backend + Vite from `playwright.config.ts` (isolated data dir), the shared `e2e-transcript-jump` seed (1200 turns / 4800 rows) opened through the sidebar's own link. Red baseline: the spec file did not exist before this branch. Readings: (a) first screen at the tail → thumb fraction 0.99×(≥0.97), `aria-valuenow ≥97`; (d) a drag floats the turn preview (summary + time) and fetches nothing; the loaded window stays pinned at the tail (gap ≤2px) while the thumb is dragged to ~10%; release at the track's middle issues exactly one window read, for the turn it rested at, and that window's first row lands at 50%±3%; (b) jumping to turn 121 through its tick reads 0.10±0.03 on the thumb and 0.092 from the loaded window's own first row, while the pane's pixel fraction is ~0.47 — the thumb is not the loaded window's pixels; (c) wheeling up across a real prepend (the window's first row moves towards the start) never moves the thumb backwards by more than 0.5% of the track; (e) clicking the blank track and Home/End/PageUp/PageDown/ArrowUp each move the thumb.

**AC2 — the three false forms each proven RED by mutation.** Committed implementation first (clean tree), then each mutation applied, the criterion rerun, the verbatim failing line recorded, and the tree restored with `git checkout -- src/modules/chat/transcript/TranscriptTurnRail.tsx` before the next; `git status` clean after each.

- (a) *p from the loaded window's pixel ratio* — `scrollFraction` replaced by `pane.scrollTop / (pane.scrollHeight - pane.clientHeight)`. RED at `e2e/transcript-global-scrollbar.spec.ts:513` — `expect(received).toBeLessThanOrEqual(expected)` / `Expected: <= 0.13` / `Received:    0.3830700360135549`; diagnostic `{"afterJump":{"progress":0.3830700360135549,...,"valueNow":38},"jumpedFirstRow":0.09166666666666666,"pixelFraction":0.46624162170998856}` — the post-jump position read the loaded window's pixel ratio (0.383, pixel 0.466) instead of the conversation's ordinal (0.092).
- (b) *a page fetched for every pointermove* — `onJumpToTurn(turn.id)` added to `handleThumbPointerMove`. RED at `e2e/transcript-global-scrollbar.spec.ts:413` — `expect(received).toBe(expected)` / `Expected: 0` / `Received: 8`, message `a drag must not fetch a page for an intermediate position` (eight intermediate positions each issued a window read).
- (c) *p contaminated by the loaded row count* — `scrollFraction` adds `(loadedRows - 20)` to the turn's subscript. RED at `e2e/transcript-global-scrollbar.spec.ts:551` — `expect(received).toBeLessThanOrEqual(expected)` / `Expected: <= 0.005` / `Received:    0.006039738105738768`, message `wheeling up may not move the thumb backwards: [0.10987361784904234,0.10987361784904234,0.10987361784904234,0.11591335595478111]` — a window prepend pushed the thumb backwards by 0.6% of the track.

**AC3 — no regression.** `npx playwright test e2e/transcript-jump-to-turn.spec.ts -g "AC-213"` → `1 passed (16.2s)`, exit 0 (the predecessor's criterion, rerun against the rewritten rail — the tick bisection, jump and current-tick emphasis survive). `npx playwright test e2e/transcript-follow.spec.ts` → `6 passed, 1 failed (54.2s)`: the one red is the last case, `e2e/transcript-follow.spec.ts:3108` "a whole row arriving while pinned keeps the pane at the bottom", whose precondition reads the row's `contain-intrinsic-size` placeholder instead of a measured height (`{"index":1,"firstHeight":1135,...,"settledHeight":1135,"frames":27}`) — the load flake already documented for this host (a pristine `develop` and a six-file revert both fail the identical case under load; that case never mounts the rail). Run alone it passes: `npx playwright test e2e/transcript-follow.spec.ts -g "a whole row arriving while pinned"` → `1 passed (16.3s)`, exit 0. No test was weakened.

**AC4 — i18n complete.** All twelve `src/modules/i18n/locales/*/chat.json` carry `turnRail.scrollbar` (the thumb's accessible name; directory-enumerated, not sampled from `en`). `npx vitest run src/modules/chat/tests/chatTurnRailCompleteness.test.ts src/modules/i18n/tests/localeDuplicateKeys.test.ts` → `Test Files 2 passed (2) / Tests 6 passed (6)`, exit 0.

**AC5 — typecheck / lint / diff.** `npm run typecheck` exit 0; `npm run lint` exit 0 (warnings only; the rail's lone warning is the `react(set-state-in-effect)` shape the repo already carries across chat hooks). `git merge --no-edit develop` was run in the worktree first (develop `a9c2c064`), so `git diff --stat develop HEAD` is exactly this branch's delta: `TranscriptTurnRail.tsx`, the twelve locale bundles, and the new `e2e/transcript-global-scrollbar.spec.ts` (14 files) — every one in `## Touches`.

**Scoped gate.** `bash scripts/test.sh --for-task transcript-global-scrollbar-track --allow-thin` → exit 0; the scope is thin (`no scoped test files for transcript-global-scrollbar-track (thin)`) because no Touches file is a unit-test file, and the script's own suite-scope guards pass. The scoped-gate cache was recorded for the driver (`--write-scoped-gate-cache`).

**DoD.** The thumb's fraction is the current turn's absolute message subscript over the last turn's — no pixel ratio feeds it. The criterion carries the "window still pinned at the tail (gap ≤2px) while the thumb is dragged to ~10%" reading, plus "after resting at 50% the window content's first row is at 50%±3%". A drag issues zero intermediate reads and exactly one for the position it rested at. The thumb is read by assistive tech as a `scrollbar` and is keyboard-operable. Only `## Touches` files changed. One in-scope behaviour note: the tick's reader-facing turn number now comes from the outline's ordering rather than `index + 1`, because `index` is the message subscript — the old label numbered a session's turns 1, 4, 7 when each turn draws several rows.