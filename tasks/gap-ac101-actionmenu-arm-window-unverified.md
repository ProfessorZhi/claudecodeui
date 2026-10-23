---
id: gap-ac101-actionmenu-arm-window-unverified
title: AC-101 台账连红是合并竞态：修法 35cd475c 不在 driver 那批红跑所用的树里（本轮实测 11/11 绿，含并发）；钉住
  ActionMenu「武装晚一帧」留下的未测窗口
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

2026-09-26 gap 轮次：AC-101（GOAL-002「会话列表过滤在真实应用中可用」）的 GOAL 不再活跃且未声明 `long-term`，台账把它记为 CURRENTLY FALSE（最后一条 goal 事件 `2026-09-25T15:37:44.753Z`，actor `goal-cli`，verdict `fail`）。本轮**直接重跑判据**（不是读台账尾巴），取到的读数与台账相反：判据在当前的树上是**绿**的。本任务记录该测量、给出台账为何仍读红的机械证据，并把修法留下的一个未测时序窗口钉住。

**本轮直接读数**（canonical checkout，HEAD `8b7745bd`，树内含 `35cd475c`）：`npm run test:e2e -- e2e/session-filter.spec.ts` → `EXIT=0`、`5 passed`，连续 5 次，墙钟 24.3s / 38s / 37s / 37s / 39s；另加两次**并发**（同一时刻跑两份该 e2e）各自 `EXIT=0`、`5 passed`（31.3s / 26.7s）。合计 11/11 绿，含并发条件。

**台账为什么读红——driver 的 pre-filing 重跑与它自己的 fan-in 赛跑。** 机械判据：`git merge-base --is-ancestor 35cd475c 72c0ec46` → **NO**。`72c0ec46` 是 develop 在 23:30:10 的位置，也正是 canonical checkout 在 23:37:53 之前所处的 HEAD；修法 `35cd475c`（"fix(sidebar): arm ActionMenu viewport dismissal on the next frame"，提交于 23:19:15）到达 develop 是 23:37:25（reflog `8b7745bd develop@{2026-09-25 23:37:25}: push`），canonical checkout fast-forward 到它是 23:37:53。最后一条红的 dataDir `quay-e2e-TaQJfb` 在 23:37:03 被杀，即那次跑起点在 23:36:08 前后，**早于修法落地**；此前那 10 条红（本地 22:05 → 23:34）更全部早于 23:19:15 的修法提交。所以整条红串跑的都是不含修法的树：前一个任务的修法**是有效的**，只是它的落地与 driver 这一轮的复跑重叠了。

**红被保留下来的机制**（取自 `TaQJfb/trace.zip`，在该 dataDir 被回收前取出，仅作机制留档）：`e2e/session-filter.spec.ts:602` 点 ⋯ 成功（44ms），菜单 DOM 渲染出全部 5 个 menuitem（frame-snapshot #5），但 `:603` 的 `getByRole('menuitem', { name: 'Hide similar' })` 永不解析；跑随即被杀于 `Error: Channel closed`，`EXIT=1`；`error-context.md` 在 ~55s 的快照里显示 ⋯ 按钮 `[active]` 而 AX 树中没有 menu。

**本任务真正要补的缺口。** 落地的修法是**单帧**延后武装（`src/shared/ui/ActionMenu.tsx` 里 `window.requestAnimationFrame(() => { addEventListener(...) })`），它的正确性依赖一条没有被钉住的假设：「打开那次点击引发的焦点滚动与 rAF 回调在同一次渲染更新里，且滚动步骤在前」。`src/shared/tests/actionMenuViewportDismissal.test.tsx:54-67` 只钉住了滚动**早于**武装帧的那一支；滚动**晚于**武装帧（渲染变慢时会这样）时菜单会不会被关掉，既没有用例也没有读数。判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 是本目标的退出条件之一、由 driver 每轮复跑，把一条未测的时序假设留在它的必经之路上，就是这一条 AC 反复回红的现实来源。

**做法（测在改之前，改动面限制在两个文件，不新增源文件）**：加一个用例把「滚动晚于武装帧」这一支测出来，并记录实际行为；只有当窗口确实为真（该用例显示菜单被关掉），才在产品侧关掉它，并且必须同时保住既有的对照用例 `a scroll from a later interaction still dismisses the menu`（同文件 `:69`）。若无法在保住对照的前提下关掉窗口，就把 `ActionMenu.tsx` 还原到本任务前的内容、在完成记录里写下这个否证结果——不得拿一个已知为绿的保证去换一个可能为红的改动。

<!-- dedup-ref --> 与同族已完成的 `gap-actionmenu-dismissed-by-open-focus-scroll` 的关系仅作溯源：那个任务的机制是「监听器在打开瞬间就装上，于是被打开点击自己引发的那次滚动命中」，已由 `35cd475c` 修掉且上面实测 11/11 为绿；本任务只处理「武装被推迟恰好一帧、于是晚于一帧到达的滚动仍会命中」这个未被测到的窗口，不是同一个机制，不重做前者。改动同样不得碰 `e2e/session-filter.spec.ts`、`goals/AC-101-*.md` 与夹具播种。

## AC

- [x] AC1 判据在最终树上为绿：`npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0 且输出含 `5 passed`；完成记录里写下该次跑的 dataDir 与墙钟毫秒。
- [x] AC2 窗口被测量并钉住：`npx vitest run src/shared/tests/actionMenuViewportDismissal.test.tsx` 退出码 0，且该文件里存在一个「开到菜单、跑过武装帧、再派发滚动」的用例；该用例的实际读数（菜单仍在 / 菜单被关）逐字写进完成记录。
- [x] AC3 对照仍在且为绿：同名文件里 `a scroll from a later interaction still dismisses the menu` 一例仍存在且通过——不许把关闭策略整段删成「永不关闭」。
- [x] AC4 若 AC2 显示窗口为真并因此改了 `src/shared/ui/ActionMenu.tsx`，则 AC1 必须在**改后的树**上重跑并为绿；若在保住 AC3 对照的前提下关不掉窗口，则 `ActionMenu.tsx` 被还原为本任务前的内容，完成记录里写下否证。
- [x] AC5 未走捷径：本任务的改动范围内 `git diff --stat` 不含 `e2e/session-filter.spec.ts`、`goals/AC-101-*.md`、`playwright.config.ts`；该 spec 里没有新增 `scrollIntoViewIfNeeded()` / retry / `skip`。

## DoD

落地标准是**对象真的被运行过**，不是「有用例存在」。完成记录必须逐字带上：(1) AC1 那次 criterion 跑的退出码、`5 passed`、dataDir、墙钟毫秒；(2) AC2 新增用例的名字与它的实际读数（菜单仍在 / 被关）；(3) 若做了产品侧修改，改后 AC1 的重跑读数；若走否证分支，给出 `git diff` 证明 `ActionMenu.tsx` 与本任务前逐字节相同；(4) AC3 对照用例通过的那一行 vitest 输出。夹具与用例是必要条件，不是充分条件。

## Touches

- src/shared/ui/ActionMenu.tsx
- src/shared/tests/actionMenuViewportDismissal.test.tsx
- tasks/gap-ac101-actionmenu-arm-window-unverified.md

## 完成记录

**结论：窗口为真（AC2 在改前读到「菜单被关」），已在 `src/shared/ui/ActionMenu.tsx` 内修掉，未走否证分支。**

改动两个文件、不新增源文件：`src/shared/ui/ActionMenu.tsx`（+28/-2 行）与 `src/shared/tests/actionMenuViewportDismissal.test.tsx`（+29/-0 行）。机制：「下一帧武装」原样保留；新增一个**同步的、只记录不动作**的 scroll 观察者，记住「打开那次滚动」是否在武装帧之前就被看到。武装后看到的第一个 scroll：只有在「武装前一次 scroll 都没看到过」时才放行一次（此时它可能与打开那次滚动是同一个事件，只是渲染慢、晚到了），否则照旧关闭；第二个 scroll 必定关闭。既有对照用例逐字节未动。

### AC1 —— 判据在最终树上为绿

最终树 = `ac1cd4c8`（本任务的实现提交，其父是本轮 `git merge --no-edit develop` ff 进来的 develop 尖）之上再合并 develop 之后的树。跑这次判据时 HEAD = `a763a01a` + 两个已改文件；之后的 develop 合并只带进别的任务的 `tasks/*.md`，`git diff --stat ac1cd4c8 HEAD -- src/` 为空 ⇒ 这次读数所在的 `src/` 与最终树逐字节相同。

```
$ npm run test:e2e -- e2e/session-filter.spec.ts
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-dwHNxy free-bytes=3857649577984 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
  ✓  1 e2e/session-filter.spec.ts:443:3 › session name filter in a real browser › the editor previews the rule, saving converges the list, and Show/Hide survive a reload (3.4s)
  ✓  2 e2e/session-filter.spec.ts:509:3 › session name filter in a real browser › a matching session that is currently selected stays visible under the rule (579ms)
  ✓  3 e2e/session-filter.spec.ts:540:3 › session name filter in a real browser › a session flagged for attention stays visible under the rule (1.1s)
  ✓  4 e2e/session-filter.spec.ts:576:3 › session name filter in a real browser › a hidden session found by title search is marked as filtered (1.4s)
  ✓  5 e2e/session-filter.spec.ts:597:3 › session name filter in a real browser › "hide similar" prefills the derived rule and writes nothing (690ms)

  5 passed (21.5s)
EXIT=0  WALL=22132ms
```

`grep -c "flaky\|retries"` = **0**。改前（`ActionMenu.tsx` 仍是 develop 内容、同一份 src）也跑过一次判据：`EXIT=0`、`WALL=27591ms`、`5 passed (26.7s)`、dataDir `quay-e2e-GkD3Gf` —— 两次都绿，说明这次修复没有把判据那条绿换成别的绿。

### AC2 —— 窗口被测量并钉住

新增用例名：`a scroll that arrives only after the arming frame is tolerated once, then dismisses`（开到菜单 → `await nextFrame()` 跑过武装帧 → 派发 scroll → 再派发一次 scroll）。

- **改前实际读数：菜单被关（窗口为真）。** 用例先写、`ActionMenu.tsx` 未改时：`× a scroll that arrives only after the arming frame is tolerated once, then dismisses`、`AssertionError: a scroll the arming frame never saw before it armed must not close the menu`、`Tests 1 failed | 2 passed (3)`、`EXIT=1`。
- **改后实际读数：菜单仍在；第二次 scroll 才把菜单关掉。** `npx vitest run src/shared/tests/actionMenuViewportDismissal.test.tsx` → `Tests 3 passed (3)`、`EXIT=0`：第一次 scroll 之后 `menu()` 仍在（菜单仍在），第二次 scroll 之后 `menu()` 为 `null`（菜单被关）。

红-绿可复现（还原腿用 `git checkout`，不是对已提交改动无效的 `stash`；断言是真的断言）：

```
$ git checkout ac1cd4c8^ -- src/shared/ui/ActionMenu.tsx && npx vitest run src/shared/tests/actionMenuViewportDismissal.test.tsx
   ✓ the scroll an opening click causes does not dismiss the menu it opened
   ✓ a scroll from a later interaction still dismisses the menu
   × a scroll that arrives only after the arming frame is tolerated once, then dismisses
     → AssertionError: a scroll the arming frame never saw before it armed must not close the menu
      Tests  1 failed | 2 passed (3)     EXIT=1
$ git checkout ac1cd4c8 -- src/shared/ui/ActionMenu.tsx && npx vitest run src/shared/tests/actionMenuViewportDismissal.test.tsx
      Tests  3 passed (3)                EXIT=0
$ git diff --stat HEAD -- src/shared/ui/ActionMenu.tsx     # 空 ⇒ 还原后与修复提交逐字节相同
```

### AC3 —— 对照仍在且为绿

```
 ✓ src/shared/tests/actionMenuViewportDismissal.test.tsx > a scroll from a later interaction still dismisses the menu 26ms
```

该用例逐字节未动（本任务只在该文件尾部追加了一个用例）。关闭策略没有被删成「永不关闭」：放行只发生一次，且只发生在「武装前一次 scroll 都没看到过」的那一支；对照里武装前的那次 scroll 让后续每次 scroll 都照旧关闭。

### AC4 —— 产品侧修改后的判据重跑

AC2 显示窗口为真，因此改了 `ActionMenu.tsx`，并按第一支在**改后的树**上重跑 AC1：`EXIT=0`、`5 passed`、`WALL=22132ms`（即 AC1 那次）。未走否证分支 —— `ActionMenu.tsx` 不是本任务前的内容，本任务的实现面是 `git diff --stat $(git merge-base develop HEAD)...HEAD` = 两个文件、`57 insertions(+), 2 deletions(-)`。

### AC5 —— 未走捷径

```
$ git diff --stat $(git merge-base develop HEAD)...HEAD
 .../tests/actionMenuViewportDismissal.test.tsx     | 29 +++++++++++++++++++++
 src/shared/ui/ActionMenu.tsx                       | 30 ++++++++++++++++++++--
 2 files changed, 57 insertions(+), 2 deletions(-)
$ git diff develop -- e2e/session-filter.spec.ts goals/ playwright.config.ts | wc -l
0
$ grep -c "scrollIntoViewIfNeeded\|retry\|skip" e2e/session-filter.spec.ts
1     # 唯一命中在 :335 既有注释里（retry until the rows are really on screen）；该 spec 与 develop 逐字节相同
```

### 静态门与前端回归（$frontend-module-standards）

```
$ npm run test:client    # EXIT=0  Test Files 106 passed (106)  Tests 749 passed (749)
                         #   ✓ src/shared/tests/actionMenuViewportDismissal.test.tsx (3 tests) 139ms
$ npm run typecheck      # EXIT=0
$ npm run lint           # EXIT=0（没有一条 warning 来自 ActionMenu.tsx / actionMenuViewportDismissal.test.tsx）
```

新增测试落在 `src/shared/tests/`（共享前端代码的测试位置），导入仍走 `@/shared/ui` barrel；未引入 interface、新类型、新 state 或相对导入。

**该轴仍暗，理由：纯前端交互时序修复，没有可独立度量的 L_D/L_G 读数；验收以判据重跑绿、AC2 的红-绿两条读数与 AC3 的对照读数为准。**
