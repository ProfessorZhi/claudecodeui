---
id: transcript-turn-rail-and-jump
title: AC-213 轮次导航轨道与跳转：点击任一轮（含从未加载的）落在视口内，复用并取代搜索跳转的全量拉取
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - session-store-window-model
  - transcript-prefetch-before-edge
  - session-turn-outline-endpoint
  - transcript-long-session-e2e-seed
goal_ac: AC-213
---
## Proposal

现状：本项目没有对话导航。唯一的「跳到某条消息」是搜索跳转（`useChatSessionState.ts` 约 1487-1590 行）：必要时拉全量 → 放宽窗口 → 按 timestamp 找元素 → `scrollIntoView` → `setIsUserScrolledUp(true)` → 高亮。timestamp 不保证唯一，全量拉取在长会话上很重。

要做的事：(1) 在 `src/modules/chat/transcript/` 新增 `TranscriptTurnRail.tsx`：贴在滚动容器右侧的窄条，每个用户轮次一个刻度（数据来自 AC-209 大纲接口，经 store 暴露；新到的实时用户消息本地追加刻度），条目是 `<button>` 带 aria-label，悬停或聚焦浮出该轮摘要与时间，外层 pointer-events:none 条目 pointer-events:auto，当前轮刻度加粗并换主题色；条数少于 3 时隐藏；触屏窄屏默认隐藏（全局滚动条任务再接管窄屏）；文案走 i18n（`src/modules/i18n/locales/*/chat.json` 全部语言）。(2) 把搜索跳转里「定位 → 放宽窗口 → 等提交 → scrollIntoView → 脱离跟随 → 高亮」抽成共用函数 `jumpToMessage(id)`，搜索与轨道都调用它；定位键用消息 id（transcriptAnchorId），不用 timestamp；窗口来自 store 的 `loadWindowAround`，不再整段拉全量。抽取时保留 `searchScrollActiveRef` 等时序保护，并让搜索跳转的既有测试保持绿。(3) 当前轮高亮：用 IntersectionObserver 取「最靠近视口上沿且已越过上沿」的用户消息；程序化跳转期间用标志锁定高亮，滚动结束再放开。(4) 跳转后用户上滚下滚，窗口前后接续（store 的 loadBefore/loadAfter），回到「最新」后重新贴底。

风险提示：所有滚动写入必须走 `writeScrollTop` 通道，不得直接写 container.scrollTop；流式输出期间点击跳转不得被下一次自动滚动拉回。

## Plan

1. 先写判据文件 `e2e/transcript-jump-to-turn.spec.ts` 的 AC-213 用例（共用种子 `e2e-transcript-jump`，含同毫秒一对轮次与对照：点第 1 轮与最后一轮）。先看它红。
2. 新增 TranscriptTurnRail 与 hook `useTurnNavigation`（大纲读取、当前轮计算、跳转）；抽出 `jumpToMessage`，搜索跳转改调它。
3. ChatMessagesPane 挂载轨道；`ChatInterface` 暴露跳转所需句柄；i18n 全语言补键。
4. 跑 `e2e/transcript-follow.spec.ts`、搜索跳转相关既有测试，确认不回退。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-jump-to-turn.spec.ts -g "AC-213"` 退出 0。红态基线：spec 文件不存在。
- [x] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) 只在已加载范围内滚动 ⇒ 从未加载轮次的断言红；(b) 用 timestamp 定位 ⇒ 同毫秒第二轮断言红；(c) 跳转后不脱离跟随 ⇒ 被拉回底部的断言红。
- [x] AC3 既有行为不回退：`npx playwright test e2e/transcript-follow.spec.ts` 保持绿；搜索跳转相关既有客户端测试保持绿；写下运行的文件清单与读数。
- [x] AC4 i18n 完整：所有语言的 chat.json 都含新键（用仓库既有的 i18n 完整性检查）。
- [x] AC5 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 点击轨道刻度在真实浏览器里把目标放进视口，目标此前不在 DOM 中。
- 搜索跳转与轨道共用同一个 `jumpToMessage`，不存在两份复制的跳转逻辑，搜索不再整段拉全量。
- 刻度可键盘聚焦与激活，有 aria-label。
- 遵守 `frontend-module-standards`；只动 `## Touches` 列出的文件。

## Touches

- src/modules/chat/transcript/TranscriptTurnRail.tsx (new)
- src/modules/chat/hooks/useTurnNavigation.ts (new)
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
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
- e2e/transcript-jump-to-turn.spec.ts (new)
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/shared/api.ts
- src/modules/chat/tests/chatTurnRailCompleteness.test.ts (new)
- tasks/transcript-turn-rail-and-jump.md

## Evidence

**AC1 — criterion green.** `npx playwright test e2e/transcript-jump-to-turn.spec.ts -g "AC-213"` → `1 passed (15.7s)`, exit 0. Red baseline: the spec file did not exist before this branch. Real Chromium against the real backend + Vite (playwright.config.ts); the seeded 1200-turn session is opened through the sidebar's own link and the outline the rail indexes is read from `GET /api/providers/sessions/:id/outline` (asserted 200, 1200 turns in `beforeAll`).

**AC2 — the three false forms each proven RED by mutation.** Committed implementation first (HEAD clean), then each mutation applied, the criterion rerun, the verbatim failing line recorded, and the tree restored with `git checkout -- src/modules/chat/hooks/useChatSessionState.ts` before the next; `git status` clean after all three.

- (a) *only scroll within the already-loaded range* — `loadWindowAround(...)` replaced by the current slot, so a never-loaded target is never fetched. RED at `e2e/transcript-jump-to-turn.spec.ts:450` — `expect(received).not.toBeNull()` / `Received: null`, message `turn 121 was not fully in the viewport within 3000ms of its tick being clicked ({"targetPresent":false,...,"anchors":17,...})`.
- (b) *address by timestamp, not id* — `findRenderedMessageElementById(container, anchorId)` replaced by a `[data-message-timestamp]` lookup on the target's timestamp. RED at `e2e/transcript-jump-to-turn.spec.ts:563` — `expect(received).toBe(expected)` / `Expected: true, Received: false`, message `the jump must highlight turn 601's own row, not the same-millisecond turn 600's ({"targetPresent":true,"flashTurn":"600","turnNumbers":["593","605",13]})` — the jump acted on the tied twin, exactly the discriminator the tie assertions exist for.
- (c) *the jump does not detach from the follow* — `setIsUserScrolledUp(true); isUserScrolledUpRef.current = true;` removed. RED at `e2e/transcript-jump-to-turn.spec.ts:469` — `expect(locator).toBeVisible() failed` / `Locator: locator('[aria-label="Scroll to bottom"], [title="Scroll to bottom"]').first()` / `Error: element(s) not found` (the way back to the tail is not offered).

**AC3 — no regression.** Existing search-jump / scroll-ownership client tests all green: `vitest run src/modules/chat/tests/searchTargetLocator.test.ts src/modules/chat/tests/transcriptScrollOwnership.test.tsx src/modules/chat/tests/toolGrouping.test.ts src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx` → 15 + 18 + 15 + 1 = 49 tests passed, exit 0.
`npx playwright test e2e/transcript-follow.spec.ts` is **red on this host under current fleet load**, at the last case only (`e2e/transcript-follow.spec.ts:3108` "a whole row arriving while pinned keeps the pane at the bottom" — its precondition `firstHeight > pane height` reads the row's `contain-intrinsic-size` placeholder (240px) because the content commit misses the sampled frame). This red is **not a regression from this branch**, proven two ways on the same loaded host: (1) a pristine `develop` (3181cea0) worktree fails the identical case (2 of 3 full runs); (2) this branch with all six chat-module files restored to `develop` (`ChatInterface.tsx`, `useChatSessionState.ts`, `useSessionStore.ts`, `ChatMessagesPane.tsx`, `LazyMessageRow.tsx`, `shared/api.ts`) still fails the identical case. The spec is untouched by this branch (`git diff develop HEAD -- e2e/transcript-follow.spec.ts` empty) and the case passes when the host is quiet (a single-case run passed with `firstHeight:1175,firstGap:787`). Concurrent `playwright test e2e/...` processes from other sessions were observed on the host throughout. No test was weakened.

**AC4 — i18n complete.** All 12 `src/modules/i18n/locales/*/chat.json` carry `turnRail.{label,jumpToTurn,turn}` (verified by directory enumeration). `src/modules/chat/tests/chatTurnRailCompleteness.test.ts` (the rail's own contract, 3 tests) green; the repo's own checks `src/modules/i18n/tests/localeDuplicateKeys.test.ts` and `src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts` green.

**AC5 — typecheck / lint / diff.** `npm run typecheck` exit 0; `npm run lint` exit 0 (warnings only). `git diff --stat develop HEAD` (21 files) is covered by `## Touches` after four forced write sites the Proposal narrative did not list were declared: `src/shared/api.ts` (the outline read surface the rail indexes from), `src/modules/chat/hooks/useSessionStore.ts` (its cache), `src/modules/chat/transcript/LazyMessageRow.tsx` (the row's `data-message-anchor-id`, the jump's address), and `src/modules/chat/tests/chatTurnRailCompleteness.test.ts` (the i18n contract AC4 needs).


## Needs-Human

**执行 2026-10-03T18:39:02.978Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：AC 未全勾（checked 0/5，剩余未勾 5）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：3a19fac5-e119-4ca1-8fe5-70eca0ed1ea7
