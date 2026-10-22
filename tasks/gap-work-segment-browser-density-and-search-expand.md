---
id: gap-work-segment-browser-density-and-search-expand
title: AC-207 真实浏览器：缺省折叠态密度降到基线一半以下，且搜索命中折叠段内成员自动展开
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
  - gap-work-segment-expansion-survives-unmount
goal_ac: AC-207
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-02）：`grep -rn "^goal_ac: *AC-207" tasks/*.md` → **0 命中**；机制词扫描（`transcript-work-segments` / `自动展开` / `密度下降`）只命中同轴 AC-203/AC-204 两条任务里的「本任务不做的」散文，二者认领的是别的机制（展开态无损集合相等 / 展开态跨卸载保持）；目标级判据 `npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"` 在 `.quay/gate-events.jsonl` 的读数是 `Error: No tests found`（spec 不存在）。⇒「真实浏览器里的缺省密度与搜索命中可见性」无人认领，不是重复。

**现状读数（2026-10-02，读代码）。** 转写面板 `src/modules/chat/transcript/ChatMessagesPane.tsx` 今天只有 `groupConsecutiveTools` 的同名工具合并层（`src/modules/chat/utils/toolGrouping.ts`），没有任何「工作段」层；`src/modules/chat/utils/workSegments.ts` 与 `src/modules/chat/transcript/WorkSegmentRecord.tsx` 由同轴兄弟出货、今天不存在（本轮已确认）。搜索定位链在本仓已存在且可驱动：侧栏会话搜索（真实 SSE）命中后 `src/modules/sidebar/Sidebar.tsx:334` 把 `{__searchTargetSnippet, __searchTargetTimestamp}` 并进被选中的 session 对象；`src/modules/chat/hooks/useChatSessionState.ts:1439-1449` 读到它并 `setSearchTarget`；滚动 effect（同文件 `:1451-1560`）把目标在**全量转写**里解析成下标、把渲染窗口加宽到覆盖它，再用 `findRenderedMessageElement`（同文件 `:109`）按 `data-message-timestamp` 找行 —— 只有**最后一次重试**（`retriesLeft === 0`，共 `SEARCH_SCROLL_RETRIES = 20` 次 × 150ms）才允许 `allowNearest` 就近落点。这正是 AC 的 origin 记的那条隐式约定：旧同名工具组行盖上该组**首条**消息的时间戳，所以命中组内非首条成员时精确匹配失败、就近落到组行，内容继续藏着；段吸收的行比旧组多得多，折叠态下同理会藏。

**要做的事（本任务 = 一个真实浏览器判据 + 它读的那个行为）。**
- 缺省折叠态由同轴 AC-202/203/204 出货（纯选择器 `groupWorkSegments` / 段记录组件 / 面板接线与 `expandedSegmentKeys`）。本任务**不重做**它们，只**读**它们的出货：在真实浏览器里打开一个固定夹具会话，量缺省态的密度。
- 本任务**新加的行为**：搜索命中落在折叠段**内部成员**时，该段自动展开，且滚动后命中的成员行 `rect` 落在视口内 —— 不得只滚到段行、把命中内容继续藏在折叠里。宿主按 AC-204 的契约放在面板（`expandedSegmentKeys` 的同一层）：面板已经收到 `selectedSession`，而搜索命中后它带着 `__searchTargetSnippet`（`Sidebar.tsx:334` 并入）；面板用已出货、已导出的 `findSearchTargetIndex`（`src/modules/chat/utils/searchTargetLocator.ts`）在 `visibleMessages` 上解出命中的成员下标，再把它所属段的锚点键加入展开集合。判据读的是**行为**（段展开 + 成员可见），不约束实现落在哪一行。
- 固定夹具：`playwright.config.ts` 在 `isDataDirOwner` 段新增一个 seed，产出**真实 claude JSONL**（`content: [{type:'thinking',…}] / [{type:'tool_use',…}]`），一个回合的合并前基线 = 24 行 / 1112px（thinking 8×36px、工具 6×60px，与 GOAL-016 记录的实测同形）；其中至少一段 ≥3 成员，且**命中短语落在该段的非首成员**上（例如第 3 条工具调用的 input），使「只滚到段行」的病态真的会出现。会话 id / 显示名逐字写在 spec 里。
- **登记（AC expect 字面要求）**：`e2e/transcript-work-segments.spec.ts` 必须登记进 `playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES`。同时记录机制读数：debug-agent 的场景方言是闭合集，`row` 只能写 `{role: 'user' | 'assistant', text}`（`server/modules/debug-agent/debug-agent.scenario.ts:195-238`），**写不出 thinking / tool_use 行**，而段的成员判定只吸收 thinking / 工具调用 / 子代理容器（AC-202）——所以密度夹具只能来自 seed 的 claude JSONL，登记所开的 debug-agent 门（`DEBUG_AGENT` / `DEBUG_AGENT_HOME`，只被 debug-agent 模块消费，见 `server/modules/debug-agent/debug-agent.gate.ts`）**不是**夹具的来源，两条读数都不得归因于它。

**判据怎么读。** `e2e/transcript-work-segments.spec.ts`，两个读数（放同一个被 `-g "AC-207"` 命中的用例，或共享一次服务启动的 serial describe）：(i) 缺省密度：`page.goto('/session/<夹具 id>')` 后**不做任何展开**，在可视区数 `.chat-message`（`src/modules/chat/transcript/MessageComponent.tsx:183` 的行类）的挂载数与夹具回合的总高，断言两者**都严格低于阈值**——阈值 = 「合并前实测基线的一半以下」，基线数与阈值数都逐字写进 spec（`PRE_MERGE_BASELINE_ROWS = 24`、`PRE_MERGE_BASELINE_PX = 1112`、`ROW_LIMIT = 12`、`PX_LIMIT = 556`），断言 `rows < ROW_LIMIT && heightPx < PX_LIMIT`；读数在布局稳定后取（rAF 内再 `setTimeout 0`，先例 `e2e/transcript-follow.spec.ts` 的 `readGeometry`）。(ii) 搜索命中自动展开：经**真实侧栏会话搜索**（conversations 模式，输入夹具里那条唯一短语）拿到结果并点击 —— 这是 `__searchTargetSnippet` 的唯一真实来源；然后断言包含命中的那个**段**处于展开态（其成员行在 DOM）且命中成员行 `rect` 完整落在 `.chat-messages-pane` 视口内（`top >= paneTop && bottom <= paneBottom`）。**不得**只断言滚动位置变化或段行可见。

**本任务不做的（属同轴兄弟判据）。** <!-- dedup-ref --> 段选择器本身归 AC-202；段记录组件的折叠/展开渲染与无损集合相等归 AC-203；展开态跨 `LazyMessageRow` 卸载保持、重挂回缺省折叠归 AC-204；段锚点跨尾部增长稳定归 AC-205；导出路径强制展开归 AC-206。本任务只改面板的搜索命中展开接线、`playwright.config.ts` 的 seed 与登记、自己的 spec，不修改兄弟任务的出货文件（假形态变异是**瞬态**的，跑完即 `git checkout -- <file>` 恢复）。

**依赖边（真实关系，非 prose 声明）。** 本任务声明 `depends_on` 指向同轴三兄弟的出货任务：选择器、段记录、面板接线。这三者是 spec 运行的必要条件，且面板文件（`ChatMessagesPane.tsx`）与 AC-204 共写，没有边时二者可能被并发派发。若其中任何一条前置最终以 `superseded` 而非 `done` 收场，这条边会把本任务永久挂在 `todo`（`ready-pool-check` 只认 `done`）—— 届时按实测重议边，不要默默删边。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"` 退出 0。红态基线（本轮实测）：spec 不存在，`.quay/gate-events.jsonl` 同一判据读数是 `Error: No tests found`；spec 内的用例标题必须含 `AC-207`（判据命令就是 `-g "AC-207"`）。
- [x] AC2（读数 i，承重）缺省折叠密度降到基线一半以下：同一命令退出 0，且用例内断言可视区 `.chat-message` 挂载数 `< 12` 且夹具回合总高 `< 556`；四个常量（基线 24 / 1112、阈值 12 / 556）逐字写在 spec 的常量声明里，基线出处（一回合 24 行 / 1112px）写在旁的注释里。
- [x] AC3（读数 i 的正控制，承重）阈值真的分得开，不是对任何输入都成立：同一夹具在**合并关闭**（一行一块）下量得的行数 / 高度 `>= 基线`（`>= 24` 行 / `>= 1112px`）—— 用假形态 (a) 的瞬态测量把这条读数落盘（spec 内的可切换分支，或变异记录里的实测两列）。没有这条，`< 12 / < 556` 在「夹具本来就没几行」时也会绿，读数 (i) 是空话（对照 `zero-claim-criterion-needs-positive-controls`）。
- [x] AC4（读数 ii，承重）搜索命中折叠段内成员后该段自动展开且成员可见：同一命令退出 0，且断言 (a) 命中成员行在 DOM；(b) 其 `rect` 完整落在 `.chat-messages-pane` 视口内（`top >= paneTop && bottom <= paneBottom`）；(c) 局部正控制：夹具里另一条**不含命中**的段仍处于折叠态（其成员行不在 DOM），证明展开由命中驱动，不是「全部展开」。
- [x] AC5（读数 ii 的非空正控制，承重）命中确实落在段内非首成员：断言夹具那条唯一短语位于某段 `members[1..]`（⛔ 不是 `members[0]`），且该段 `members.length >= 3`；否则「精确匹配失败、就近落到段行」的病态根本不会出现，读数 (ii) 是空话。
- [x] AC6 取假形态必须红（承重；先提交实现与判据，再逐条变异；逐条记录变异 diff、逐字失败行与 `git checkout -- <file>` 恢复命令）：(a) 把段合并改回「一行一块」（段选择器不再折叠工作段）⇒ AC2 红（行数 / 高度回到基线以上）；(b) 关掉搜索命中自动展开（面板不再把命中段的锚点加入展开集合）⇒ AC4 红，且失败方向必须是「段仍未展开 / 命中成员不在 DOM」，不得是别的腿先红。
- [x] AC7 spec 已登记且夹具来源记录在案：`grep -n "transcript-work-segments.spec.ts" playwright.config.ts` 命中 `DEBUG_AGENT_SPEC_FILES` 数组内一条；spec 内逐字记录「夹具来自 seed 的 claude JSONL；debug-agent 场景方言（`row` 闭合集只有 `role` + `text`）写不出 thinking / tool_use 行，故两条读数不归因于该门」。
- [x] AC8 判据预算：判据安静态整跑墙钟（含 server + vite 启动）实测并记录，**明显低于目标门 60s 硬顶**（先例 `unattributable-60s-criterion-kill-is-a-hang-not-a-slowdown`）；两个读数共享一次服务启动（一个 `-g "AC-207"` 用例，或 serial describe 的 `beforeAll`），不各起一次服务。
- [x] AC9 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`；注解与路径之间留空格且注解置于行尾 —— 贴着的注释会让 scoped gate 的 `print $1` 吞掉文件名）。

## DoD

- 判据跑的是真实服务端 + 真实应用：`npx playwright test` 由 `playwright.config.ts` 起真服务与真 vite；夹具会话由后端同步器在启动时索引、经侧栏打开（不是页内注入的假 store）；搜索走真实侧栏会话搜索（真实 SSE），⛔ 不是测试里手写一份 `__searchTargetSnippet`。
- 缺省密度读数读的是**出货的段层**：折叠由 AC-202/203/204 出货的选择器与段记录产生；测试里不内联一份等价的段选择器或折叠渲染。
- 搜索命中展开读的是行为：命中成员行真的在 DOM 且 `rect` 落在视口内；实现里不出现「只把段行滚进视口就算过」的分支。
- 两个假形态都真的红过，且 `git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- 夹具固定且确定：同一 seed 在重复运行下产出同样的行数，spec 显式设定 viewport，高度读数在固定视口下可复现。
- 只动 `## Touches` 列出的文件；不修改 AC-202/203/204/205/206 的出货文件 —— 若确实需要（例如给成员行补一个可寻址属性），先把该文件加进 `## Touches` 再写，并确认不与兄弟任务当前在飞的文件集相撞。

## Touches

- src/modules/chat/transcript/ChatMessagesPane.tsx
- e2e/transcript-work-segments.spec.ts (new)
- playwright.config.ts
- tasks/gap-work-segment-browser-density-and-search-expand.md

## Evidence

判据读数（安静态整跑 `npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"`，墙钟 15s/16s，含 server + vite 启动；一个用例承载两条读数，共享一次服务启动，AC8）：
- 读数 i（缺省折叠，无展开）：`.chat-message` 挂载 7 行 / 回合总高 410px，断言 `< 12` 与 `< 556` 均通过（AC2）。
- 读数 i 正控制（把三段全部展开 ⇒ 与合并关闭同形的逐行渲染）：27 行 / 1287px，断言 `>= 24` 与 `>= 1112` 均通过 ⇒ 阈值确实把折叠态与逐行态分开（AC3）。
- 读数 ii（真实侧栏 conversations 搜索）：输入夹具唯一短语 → 真实 SSE 返回结果 → 点击结果 → 命中段 `message-assistant-seg-tool-4`（8 成员）自动展开，命中短语位于 `members[1]`（≥1）且成员数 ≥3；命中成员行在 DOM、其 `rect` 完整落在 `.chat-messages-pane` 视口内；另两段保持折叠（成员行 0）（AC4/AC5）。
- 固定视口 1280×1200；三次重复运行读数完全一致（7/410、27/1287）。

AC6 假形态（先提交实现与判据 b0c23a9d / e2449885，再逐条变异，跑完即恢复）：
- (a) 段选择器改回一行一块：`src/modules/chat/utils/workSegments.ts` 的 `groupWorkSegments` 首行插入 `return messages;`（+3 行，diff 见 `/tmp/ac207runs/mut-a.diff`）。失败行逐字：``Error: the collapsed transcript drew 20 rows at height 954px`` / `Expected: < 12` / `Received: 20`（spec `:210`）⇒ AC2 红（行数回到基线以上）。恢复：`git checkout -- src/modules/chat/utils/workSegments.ts`；恢复后 `git status --porcelain` 对该文件为空，判据重新绿。
- (b) 关掉搜索命中自动展开：`src/modules/chat/transcript/ChatMessagesPane.tsx` 的命中展开 effect 首行插入 `return;`（+3 行，diff 见 `/tmp/ac207runs/mut-b.diff`）。失败行逐字：``Error: the segment holding the search hit never opened`` / `Expected: > 0` / `Received: 0`（spec `:275`，poll 20s 超时）⇒ AC4 红，失败方向为「段仍未展开 / 命中成员不在 DOM」；同一次运行的密度读数 7/410 与 27/1287 仍通过，证明红的是 AC4 这条腿而非别的腿先红。恢复：`git checkout -- src/modules/chat/transcript/ChatMessagesPane.tsx`；恢复后文件干净、判据重新绿。

静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅仓库既有 warning）。`git diff --stat`（merge-base..HEAD）三条与 `## Touches` 逐条对齐。develop 已并入（`git merge --no-edit develop`，无冲突），合入后判据复跑仍绿；scoped gate `scripts/test.sh --for-task gap-work-segment-browser-density-and-search-expand --allow-thin` 退出 0（thin：本任务 Touches 无 `*.test.*`，scoped 文件集为空），并已写入 scoped-gate 缓存（develop sha b080450b）。