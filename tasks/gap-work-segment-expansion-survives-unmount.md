---
id: gap-work-segment-expansion-survives-unmount
title: AC-204 展开态跨 LazyMessageRow 卸载保持，重新挂载回到缺省折叠
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
goal_ac: AC-204
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rn "^goal_ac: *AC-204" tasks/*.md` → **0 命中**；`grep -rln "展开态\|expandedSegment\|workSegmentExpansion" tasks/*.md` 只命中两条与段无关的任务（reasoning 折叠间距、侧栏分隔条）与同轴 AC-202 任务里的一段让位散文；`ls src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx src/modules/chat/transcript/WorkSegmentRecord.tsx src/modules/chat/utils/workSegments.ts` 三者均不存在（本轮已确认）。AC-202 与 AC-203 两条同轴任务的 Proposal 都白纸黑字把「面板采用该组件、以及段在 LazyMessageRow 卸载/重挂下的保持」让了出来。⇒「展开态住在哪一层」无人认领，不是重复。

**现状读数（2026-10-02，读代码）。** 目标级判据 `npx vitest run src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx` 本轮实跑的读数是 `No test files found, exiting with code 1`（判据文件不存在）。转写面板 `src/modules/chat/transcript/ChatMessagesPane.tsx` 今天只有一层 `groupConsecutiveTools` 的同名工具 xN，没有任何段记录；而 `src/modules/chat/transcript/LazyMessageRow.tsx` 在行滚出视口时把 children 整个卸载、只留一个定高占位（`isMounted ? children : null`）。AC-204 钉的正是这两者的交叉点：**展开态必须住在比 LazyMessageRow 的子树长寿、但比 pane 本次挂载短命的那一层** —— 住错任何一边，两个读数里必有一个变假。

**要做的事。** 面板采用段记录层，并把展开态的所有权放到 pane 本次挂载的 React 状态里。

- 面板渲染：以 AC-202 出货的纯选择器 `groupWorkSegments()` 取代今天的 `groupConsecutiveTools` 分组（GOAL-016 非目标第 5 条：段内不再保留同名工具 xN 层）；段项以 AC-203 出货的 `WorkSegmentRecord` 渲染，整段仍包在既有 `LazyMessageRow` 里；成员行的渲染经 `renderMember` 注入真实 `MessageComponent`，成员自身的形态不动。
- 展开态所有权：pane 持有段锚点键的集合（`expandedSegmentKeys`），以 `expanded` / `onToggle` 下发给 `WorkSegmentRecord`。⛔ 它既不是模块级单例、也不是段组件内部的 `useState`：模块级会在读数 (ii) 假绿（重挂后仍记得），段内 `useState` 会在读数 (i) 假红（卸载即丢）。
- 缺省 = 空集合 = 全折叠：pane 每一次真实挂载都从空集合开始，不读上一次挂载的遗留。
- 寻址契约（pane 自有，判据与后续浏览器读数都按它寻址）：每个段行由 pane 包一层 `div[data-work-segment-key="<段锚点键>"]`，键与 React `key` 同源（`getIntrinsicMessageKey` 取首成员）；`LazyMessageRow` 照旧带该段锚点的时间戳作为 `data-message-timestamp`。

**判据怎么读（两个读数，各自的假形态都要红）。** `src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx` 渲染真实 `ChatMessagesPane`（沿用 `src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx` 的 `paneProps()` 形状），用 `src/modules/chat/tests/lazyMessageRow.test.tsx` 的 `StubIntersectionObserver` 手动驱动段行由 near → far → near。读数 (i)：点该段折叠头展开、断言成员行（成员自己的 `data-message-timestamp`）可见 → 驱动该行 far（**先断言成员内容真的从 DOM 消失、占位元素还在**，否则「卸载后仍展开」是一句空话）→ 驱动 near → 断言仍是展开态且成员可见。读数 (ii)：对同一夹具 `unmount()` 后重新 `render()` 一个新 pane → 断言该段无任何成员行挂载、折叠头暴露的成员计数等于夹具段成员数。

**本任务不做的（属同轴兄弟判据）。** <!-- dedup-ref --> 段选择器本身归 AC-202（本任务只 import 它的出货函数）；段记录组件的折叠/展开渲染与无损集合相等归 AC-203（本任务只传 `expanded` / `onToggle`，不重做它的树）；导出路径强制展开归 AC-206；真实浏览器密度与搜索命中展开归 AC-207。本任务只改面板接线、pane 级状态与自己的判据文件，避免与兄弟任务的 `## Touches` 相撞。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx` 退出 0。红态基线（本轮实测）：该文件不存在，同一命令读数是 `No test files found, exiting with code 1`。
- [x] AC2（读数 i，承重）跨卸载保持：`npx vitest run src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx -t "expansion survives the row leaving the viewport"` 退出 0 —— 展开后驱动段行 far，断言成员行不在 DOM（卸载真的发生）、且 `LazyMessageRow` 的占位元素（按 `data-message-timestamp` 寻址）仍在；再驱动 near，断言该段仍是展开态、成员行集合与展开时逐键相等。
- [x] AC3（读数 i 的正控制，承重）卸载确实由驱动触发：同上文件 `-t "member content is mounted before the far transition"` 退出 0 —— 在 fire far **之前**断言成员行已在 DOM；没有这条，(i) 的「消失」可能对任何输入都成立（恒定真），(i) 就是空话。
- [x] AC4（读数 ii，承重）重挂回到缺省折叠：`-t "a fresh pane mount starts every segment collapsed"` 退出 0 —— 同一夹具 `unmount()` 后重新 `render()`，断言该段成员行挂载数为 0，且折叠头暴露的成员计数等于夹具段成员数（缺省是折叠，不是记住上次）。
- [x] AC5（读数 iii）假形态必须红（承重；先提交实现与判据，再逐条变异；逐条记录变异 diff、逐字失败行与 `git checkout -- <file>` 恢复命令）：(a) 把展开态改回 `WorkSegmentRecord` 内部的 `useState`（pane 不再持集合）⇒ AC2 红，且失败方向必须是「滚回后该段丢了展开」；(b) 把缺省值改成展开（空集合改成全集）⇒ AC4 红；(c) 把展开态搬进模块级 `Map`（跨 pane 挂载存活）⇒ AC4 红 —— (c) 是读数 (ii) 的分辨力负控制，证明 AC4 读的是 pane 级状态而不是「有没有保存」。
- [x] AC6 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 判据跑的是真实出货接线：测试 `import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane'`，段来自 AC-202 出货的 `groupWorkSegments`、记录组件来自 AC-203 出货的 `WorkSegmentRecord`，不接受测试内联一份等价的面板、段选择器或段记录。
- 展开态的宿主是 pane 的 React 状态：`ChatMessagesPane` 组件作用域持有被展开段的键集合，卸载段行不改变它，整块 pane 重新挂载从空集合开始；实现里不出现模块作用域的展开态容器（模块级 `Map`/`Set`/可变单例）。
- 两个读数都由真实机制产生：读数 (i) 的「卸载」由 `LazyMessageRow` 的 near/far 状态机在判据里真的走了一遍（占位元素与成员行的出现/消失都被断言），不是靠直接卸载整块 pane 冒充。
- 三个假形态都真的红过，且 `git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件（例如给 `WorkSegmentRecord` 加一个可寻址契约），先把该文件加进 `## Touches` 再写。

## Touches

- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx (new)
- tasks/gap-work-segment-expansion-survives-unmount.md