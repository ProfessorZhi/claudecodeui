---
id: gap-work-segment-collapsed-title-action-count-elapsed
title: AC-208 折叠行标题：当前动作+计数+耗时三读数从 segment 派生、随段尾增长更新、结束后定格不自动展开
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-work-segment-selector-row-type-pure
  - gap-work-segment-lossless-expand-set-equality
goal_ac: AC-208
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-02）：`grep -rn "^goal_ac: *AC-208" tasks/*.md` → 0 命中；机制词扫描（`折叠行标题` / `workSegmentCollapsedTitle` / `workSegmentTitle` / `当前动作`）只命中 `gap-goal-016-collapsed-title-rule` —— 那是 GOAL-016 的充分性提案任务（它提议并催生了 AC-208），其 frontmatter 无 `goal_ac` 字段，驱动侧按 goal_ac 计数看不到它，AC-208 仍无 todo/ready/needs-human 任务认领。同轴 AC-202..AC-207 的六条执行任务都已 `done` 且各自带 `goal_ac: AC-20X`。⇒ 本条是 AC-208 的 goal_ac 认领执行任务，不是既有提案任务的重复。

**现状读数（2026-10-02，读代码）。** 段层已由同轴兄弟出货并合入 develop：`src/modules/chat/utils/workSegments.ts`（纯选择器，AC-202）与 `src/modules/chat/transcript/WorkSegmentRecord.tsx`（段记录组件，AC-203）都在。但 `grep -rn "workSegmentTitle\|buildWorkSegmentTitle" src/` → 0 命中：折叠头今天没有「当前动作 / 计数 / 耗时」三读数，也没有随流式增长更新或结束定格。判据文件 `src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` 不存在 —— `npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` 的读数是 `No test files found, exiting with code 1`（AC-208 的 `expect` 逐字记的红态基线）。

**要做的事（本任务 = 一个纯规则模块 + 折叠头接线 + 它的判据）。** 新增 `src/modules/chat/utils/workSegmentTitle.ts`，导出一个纯函数（例如 `buildWorkSegmentTitle(segment)`），从段本身派生三个读数：(a) 当前动作 = 段内**末成员**的动作标签，沿用成员自身既有渲染的同一口径（⛔ 不读 `content`/`displayText` 猜动作）；(b) 计数 = 段内成员数；(c) 耗时 ≥ 0。把 `WorkSegmentRecord.tsx` 的折叠头接到该规则，使标题在**未展开**时随段尾追加成员更新，并在末成员 `isStreaming` 结束后定格、不自动展开。三读数必须从当前 `segment` 派生，⛔ 不得是常量；折叠头必须在每次渲染按当前 `segment` 重算，⛔ 不得只在挂载时算一次。

**判据怎么读。** `src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` 用固定夹具段（≥3 成员，含 thinking / 工具 / 子代理容器），三个用例分别承载三读数：(i) 三读数齐备且非退化；(ii) 折叠态下逐条追加成员（≥3 次），计数 +1、动作跟到新末成员、耗时非递减；(iii) 末成员 streaming 结束后再渲染若干轮，三读数定格、折叠态保持折叠。三个用例都必须从**出货**的 `WorkSegmentRecord` 读渲染结果，⛔ 不在测试里内联一份等价的标题函数。

**取假形态（承重）。** 先提交实现与判据，再逐条变异、逐条记录变异 diff / 逐字失败行 / `git checkout -- <file>` 恢复：(a) 任一读数写成常量 ⇒ (i) 红；(b) 标题只在挂载时算一次、不随 segment 变化重算 ⇒ (ii) 红；(c) 段停止增长时自动展开、或结束后耗时继续累加 ⇒ (iii) 红。三条都必须真的红过并落记录。

<!-- dedup-ref --> **本任务不做的。** 段选择器归 AC-202；段记录的无损展开集合与折叠/展开渲染归 AC-203；展开态跨卸载保持归 AC-204；段锚点跨尾部增长稳定归 AC-205；导出强制展开归 AC-206；真实浏览器的密度与搜索命中可见性归 AC-207。本任务只读它们出货的段层，只新加标题规则与折叠头接线。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx` 退出 0。红态基线（本轮实测）：该文件不存在，同一命令读数是 `No test files found, exiting with code 1`；三个用例标题必须能让 AC2/AC3/AC4 各以 `-t "<标题>"` 单独命中。
- [x] AC2（读数 i，承重）三读数齐备且非退化：`npx vitest run src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx -t "collapsed title carries action, count and elapsed"` 退出 0 —— 对固定夹具段（≥3 成员），折叠头同时暴露 a) 当前动作 = 段内**末成员**的动作标签（与成员自身既有渲染同一口径），b) 计数 = 段内成员数，c) 耗时 ≥ 0；三者都从 segment 派生，不是常量。
- [x] AC3（读数 ii，承重）随执行更新：同一文件 `-t "title tracks the growing segment while collapsed"` 退出 0 —— 向段尾逐条追加成员（≥3 次），每次在**未展开**的折叠头上：计数 +1、当前动作跟到新末成员、耗时非递减。
- [x] AC4（读数 iii，承重）结束时定格且不自动展开：同一文件 `-t "title freezes and stays collapsed at end of run"` 退出 0 —— 末成员 streaming 结束后标题三读数定格（再多渲染若干轮不变），折叠态保持折叠、不自动展开。
- [x] AC5 取假形态必须红（承重；先提交实现与判据，再逐条变异；逐条记录变异 diff、逐字失败行与恢复命令）：(a) 标题三读数之一写成常量 ⇒ AC2 红；(b) 标题只在挂载时算一次、不随 segment 变化重算 ⇒ AC3 红；(c) 段停止增长时自动展开、或结束后耗时继续累加 ⇒ AC4 红。三条都必须真的红过并落记录，恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- [x] AC6 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`，注解与路径之间留空格且置于行尾）。

## DoD

- 判据跑的是真实出货实现：标题规则从 `@/modules/chat/utils/workSegmentTitle`（或等价出货模块）导入，折叠头是 `@/modules/chat/transcript/WorkSegmentRecord` 本体；⛔ 不接受测试内联一份等价的标题函数。
- 真实落地：在真实浏览器里，多秒长的一次工作段的折叠行标题**实际渲染出**这三个读数 —— 计数等于该段成员数、耗时非零、当前动作是末成员的动作。可复用 AC-207 的 `e2e/transcript-work-segments.spec.ts` 夹具并新增一条读标题文本的读数（若写该文件，先把 `e2e/transcript-work-segments.spec.ts` 加进 `## Touches`）。仅有单测绿而浏览器里折叠行仍是常量文案，不算完成。
- 三个假形态都真的红过，`git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- 只动 `## Touches` 列出的文件；标题的动作标签沿用成员既有口径，⛔ 不得读 `content`/`displayText` 猜动作（成员自身渲染不改）。

## Touches

- src/modules/chat/utils/workSegmentTitle.ts (new)
- src/modules/chat/transcript/WorkSegmentRecord.tsx
- src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx (new)
- e2e/transcript-work-segments.spec.ts
- tasks/gap-work-segment-collapsed-title-action-count-elapsed.md

## Notes

**交付已由同轴兄弟落盘。** 本任务三件套（规则 `workSegmentTitle.ts`、接线 `WorkSegmentRecord.tsx`、判据 `workSegmentCollapsedTitle.test.tsx`）在 develop 上已由 commit `e18c57e8`（task `gap-goal-016-collapsed-title-rule`）出货，本分支相对 develop 的代码增量因此只有 DoD 要求的真实浏览器读数（`e2e/transcript-work-segments.spec.ts`）。三个已落盘文件保留在 `## Touches` 作为本任务声明的范围；anti-drift 是单向判定（actual diff ⊆ declared Touches），故声明未变的文件不会红。

**AC5 取假形态（逐条实测，先跑后 `git checkout -- <file>` 恢复；每条恢复后 `git status --porcelain` 对该文件干净、判据重新绿）。**

(a) 任一读数写成常量 —— 变异：
```
-  return { action: getMemberActionLabel(last), count: messages.length, elapsedMs };
+  return { action: 'Work', count: messages.length, elapsedMs };
```
AC2 红：`AssertionError: the title action must be the last member’s own label`（workSegmentCollapsedTitle.test.tsx:107）。

(b) 标题只在挂载时算一次 —— 变异：
```
-  const title = buildWorkSegmentTitle(segment);
+  const title = useMemo(() => buildWorkSegmentTitle(segment), []);
```
AC3 红：`AssertionError: count must grow to 2 on append 1`（:158）。

(c) 结束后耗时继续累加 —— 变异：
```
-  const elapsedMs = Math.max(0, toEpochMs(last.timestamp) - toEpochMs(messages[0].timestamp));
+  const elapsedMs = Math.max(0, Date.now() - toEpochMs(messages[0].timestamp));
```
AC4 红：`AssertionError: the settled run’s span must be its members’ span`（:195）。

**DoD 真实落地读数。** `npx playwright test e2e/transcript-work-segments.spec.ts`（真实 Chromium + 真实后端 + Vite，隔离 data-dir）1 passed（14.1s）：三个折叠头分别渲染 count `{5, 7, 8}`（= 夹具三段 7/8/5 成员）、耗时各 ≥ 4000ms（非零多秒）、当前动作取末成员 —— Bash 结尾的 8 人段读 `Bash`，两条 thinking 结尾段读 `Thinking`，且动作不全相同（常量文案不能过）。

**静态门。** `npm run typecheck` 退出 0；`npm run lint` 退出 0（仅存量 warning，无 error）。
