---
id: transcript-prefetch-before-edge
title: AC-216 向上滚动在窗口边缘之前预取：触发点距边缘约两屏，每页 ≥50 条，前插锚点保持
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - transcript-long-session-e2e-seed
goal_ac: AC-216
---
## Proposal

现状读数（2026-10-04 读代码）：`useChatSessionState.ts` 的 `handleScroll`（约 1127-1175 行）在 `scrollTop < 100` 且未全量加载时才调用 `loadOlderMessages`，每页 `SESSION_MESSAGES_PAGE_SIZE = 20`（`utils/sessionMessagePagination.ts:3`）。用户已经滚到顶部边缘才开始取页，匀速向上滚动会撞到未加载的空白；页又小，一次连续滚动要发很多请求。

要做的事：(1) 触发点由绝对像素 100 改为「距已加载内容顶部边缘 ≤ 1.5～2 个视口高度」，按 clientHeight 计算，保留既有的 `topLoadLock` 防重入语义；(2) 页大小提高到 ≥50（取 50 起，实现者按真实夹具的读数调整并写下依据）；(3) 前插后沿用既有 `captureScrollRestoreState` 锚点恢复，漂移 ≤1px；(4) 一次连续滚动的取页请求数不得膨胀（每次触发后到响应落地前不重复触发）。本任务只改「向上加载」这条既有路径，不引入窗口模型（那是 store 窗口任务），也不改导航轨道。

## Plan

1. 先写判据文件 `e2e/transcript-prefetch.spec.ts` 的 AC-216 用例（用共用长会话种子 `e2e-transcript-jump`），含「触发点设回 scrollTop<100 时 (a) 必须红」的对照。先看它红。
2. 改 handleScroll 的触发条件与页大小常量；确认 wheel 上滚处理（约 989 行）使用同一触发语义。
3. 在 src/modules/chat/tests 里补一条纯逻辑单测：触发点按 clientHeight 计算、锁在响应落地前不重复触发。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-prefetch.spec.ts -g "AC-216"` 退出 0。红态基线：spec 文件不存在。
- [x] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) 页大小改大但触发点仍为 scrollTop<100 ⇒ (b) 断言红；(b) 预取但前插后不做锚点恢复 ⇒ (d) 断言红。
- [x] AC3 既有跟随不回退：`npx playwright test e2e/transcript-follow.spec.ts` 保持绿（AC-106 至 AC-111），逐字写下读数。
- [x] AC4 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 判据在真实浏览器里用真实滚轮对真实服务运行，网络层时间戳来自真实请求。
- 触发点与页大小的取值有实测依据，写在任务证据里。
- 遵守 `frontend-module-standards`；只动 `## Touches` 列出的文件。

## Touches

- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/utils/sessionMessagePagination.ts
- src/modules/chat/tests/prefetchTrigger.test.ts (new)
- e2e/transcript-prefetch.spec.ts (new)
- tasks/transcript-prefetch-before-edge.md

## Evidence

### 判据读数（AC-216；真实 Chromium + 真实滚轮 + 真实服务；多轮读数一致）
- 视口 1200×460，pane clientHeight 200 ⇒ 预取带 = 2 × 200 = 400px。
- 开屏：scrollTop 1525（在带外，1525 > 400，故下面这次取页只能是滚轮引起的）、rows 15。
- 首次向上取页（真实 wheel）：scrollTop 339、clientHeight 200、limit 50、offset 20 ⇒ 339 > 100（未到边缘）且 339 ≤ 402（在带内）。
- 取页后 rows 15 → 52（+37 行）：种子每 4 条消息折叠成 ~3 行渲染，50 条消息画 ~37 行，旧 20 条页只画 ~15 行。
- 锚点恢复：drift 0.00px；并且记录到应用自己对 pane scrollTop 的写入一次（value 5711）—— 是应用 `writeScrollTop` 的写，浏览器 scroll anchoring 不走 JS setter，故该写证明恢复确实运行。
- 一次连续滚动只有 1 次 older 取页请求（offset 20 唯一，无重复）。

### 触发点/页大小取值依据
- 触发带取 2 个视口高度（`OLDER_PAGE_PREFETCH_VIEWPORTS = 2`）：实测在 clientHeight 200 时于 scrollTop 339 触发，早于边缘 100 约 240px，且该页取完前不再重复触发。
- 每页取 50（`OLDER_MESSAGES_PAGE_SIZE = 50`）：与 latest/首屏页 `SESSION_MESSAGES_PAGE_SIZE = 20` 解耦。原因见实测——AC-110 断言首屏恰为 20 行（合并后读数 `rowsBeforePrepend:20` 仍成立），故本任务只提升「向上加载」这条路径的页；把共享常量改成 50 会把首屏顶到 50 行而红掉 AC-110，且 Touches 不含该 spec。50 满足 AC 的 ≥50 下限。

### AC2 变异（先提交再变异；基线提交 995a934f）
(a) 触发点退回绝对 100：diff —— `sessionMessagePagination.ts` 中 `const prefetchBand = OLDER_PAGE_PREFETCH_VIEWPORTS * input.clientHeight;` 改为 `const prefetchBand = 100;`。逐字失败行：`Error: the older page must be asked for before the viewport reaches the top edge, not at it (asked at scrollTop 99)`（`Expected: > 100` / `Received: 99`，`e2e/transcript-prefetch.spec.ts:336`）。恢复：`git -C <worktree> checkout -- src/modules/chat/utils/sessionMessagePagination.ts`。
(b) 前插后不做锚点恢复：diff —— `useChatSessionState.ts` 中 `pendingScrollRestoreRef.current = scrollRestoreState;` 改为 `void scrollRestoreState;`。逐字失败行：`Error: the prepend must re-place the viewport with the anchor restore — no pane write was made after the fetch at t8826 (writes [])`（`Expected: > 0` / `Received: 0`，`e2e/transcript-prefetch.spec.ts:419`）。恢复：`git -C <worktree> checkout -- src/modules/chat/hooks/useChatSessionState.ts`。
说明：(b) 下 drift 读数为 0.00px —— Chromium 自身的 scroll anchoring 会替应用把行按住，故 drift 单读不足以分辨；判据因此同时要求「应用自己 write 过 pane 偏移」，该读在 (b) 下为空 `[]` 而红。

### AC3 既有跟随读数
`npx playwright test e2e/transcript-follow.spec.ts`：AC-106 / AC-107 / AC-111 / AC-110 / AC-108 / AC-109 全部 ✓（一轮 6 passed）。另一处非 AC 用例 `a whole row arriving while pinned keeps the pane at the bottom` 在负载轮先红（首帧 row 3 尚未长到 >pane），单跑复现即绿 —— 既有负载抖动，非本改动路径。AC-110 逐字读数：`rowsBeforePrepend:20`、`rowsAfterPrepend:24`、`scrollTopAfterRestore:880`、`driftPx:0`、`downwardWritesInWindow:0`。

### AC4
`npm run typecheck` exit 0；`npm run lint` exit 0；`git diff --stat 7432b31f..HEAD` 只列 Touches 的 4 个源文件（第 5 项本任务文件由 task_write 提交）。
