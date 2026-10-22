---
id: gap-work-segment-export-forced-expand
title: AC-206 导出路径强制展开且逐行内容与合并前等价
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
goal_ac: AC-206
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-02）：`grep -rn "^goal_ac: *AC-206" tasks/*.md` → **0 命中**；`grep -rln "AC-206" tasks/*.md` 只命中四条同轴兄弟任务（AC-202/203/204/205），且每一条都是在「本任务不做的」散文里写「导出路径强制展开归 AC-206」这类让位句，没有任何任务在导出这条链上认领机制；`grep -rln "TranscriptExportDocument\|transcriptExportWorkSegments\|chatExport" tasks/*.md` → 0 命中；`ls src/modules/chat/tests/transcriptExportWorkSegments.test.tsx` → 不存在（本轮已确认）。目标级判据 `goals/AC-206-导出路径强制展开且逐行内容与合并前等价.md` 的 `criterion:` 逐字是 `npx vitest run src/modules/chat/tests/transcriptExportWorkSegments.test.tsx`，本轮实跑读数是 `No test files found, exiting with code 1`。⇒「导出旁路在合并下会不会掉行」无人认领，不是重复。

**现状读数（2026-10-02，读代码）。** 导出 HTML 的渲染链是 `buildTranscriptExport('html', …)`（`src/modules/chat/utils/chatExport.ts`）→ `buildTranscriptHtml.tsx:66` 的 `renderToStaticMarkup(<TranscriptExportDocument/>)`。`src/modules/chat/export/TranscriptExportDocument.tsx:39` 今天走的是旧合并层 `groupConsecutiveTools(messages, true)`（`src/modules/chat/utils/toolGrouping.ts`），逐项渲染 `ToolGroupContainer` / `MessageComponent`，并在第 44 行用 `TranscriptRenderContext.Provider value={{isExporting:true}}` 包住整棵树（`src/modules/chat/context/TranscriptRenderContext.ts:13`，默认 `{isExporting:false}`）。既有「导出强制展开」的先例都在消费这个上下文：`MessageComponent.tsx:409` 的 Reasoning `<Reasoning defaultOpen={isExporting}>`、`CollapsibleSection.tsx:39` 的 `defaultOpen={open || isExporting}`、`ToolGroupContainer.tsx:94` 的 `showChildren = isExpanded || isExporting`、`SubagentPanel.tsx:113` 的 `showTimeline = isOpen || isExporting`。而工具层之上今天**没有**任何「工作段」层：`src/modules/chat/utils/workSegments.ts` 与 `src/modules/chat/transcript/WorkSegmentRecord.tsx` 均由同轴 AC-202 / AC-203 出货、今天仍不存在（本轮已确认）。行内键口径是 `getIntrinsicMessageKey`（`src/modules/chat/utils/messageKeys.ts`，候选 `blockKey > id > messageId > toolId > … > timestamp+content` 兜底）；导出行今天只带 `data-message-timestamp`（`MessageComponent.tsx:175`、`ToolGroupContainer.tsx:105`），没有任何按 `getIntrinsicMessageKey` 寻址的行标记。

**要做的事。** 把导出文档接到段层上，并让它在导出态强制展开——导出是一次 `renderToStaticMarkup`，没有可点的 chevron，凡被折叠藏起来的成员行在文件里等于不存在。

- `TranscriptExportDocument.tsx` 用 AC-202 出货的纯选择器 `groupWorkSegments()`（按出货签名传 `showThinking` / 等价开关，与今天 `groupConsecutiveTools(messages, true)` 同语义）取代旧的同名工具合并层；段项用 AC-203 出货的 `WorkSegmentRecord` 渲染，`renderMember` 注入真实 `MessageComponent`（成员自身形态不动），非段项照旧直接渲染 `MessageComponent`。GOAL-016 非目标第 5 条：段内不再保留同名工具 xN 层。
- **强制展开走既有 `isExporting` 约定**：段在导出渲染里恒为展开（与 Reasoning / ToolGroupContainer / SubagentPanel 的同一机制），使 `WorkSegmentRecord` 的 `renderMember` 对每个成员恰好调用一次、全部成员行落进导出 HTML。
- **可寻址契约（本任务新建，判据与后续读数都按它寻址）**：导出 HTML 里每条真正渲染的消息行都带 `data-message-key="<getIntrinsicMessageKey(该行消息)>"`——成员行由本任务注入的 `renderMember` 包一层带该属性的 div，非段行同样包一层。段头（折叠标题）不得携带 `data-message-key`，否则会给导出凭空添一个夹具里没有的键。这样「行集合」在 HTML 字符串里可机械读出，而不是靠文本片段猜。
- Markdown / JSON 导出路径**不动**：本判据读的是 HTML 路径（`criterion:` 指向同一个 `.tsx` 判据文件）。

**判据怎么读（集合相等，不是比条数、也不是比文本包含）。** `src/modules/chat/tests/transcriptExportWorkSegments.test.tsx`（⛔ 文件名逐字固定为这个，`goals/AC-206-*.md` 的 `criterion:` 就是它；改成别的名字目标级判据 `filter:` 会找不到文件）在 jsdom 下：夹具会话含至少一段 ≥3 成员的段（thinking 行 + ≥2 条工具调用行，成员各带 `blockKey` / `id` 等身份字段，使 `getIntrinsicMessageKey` 走身份分支而非文件末尾的 `content-preview` 兜底），段外有非成员行（用户行、正文行）。基准 = `new Set(夹具 messages.map(getIntrinsicMessageKey))`；实测 = `buildTranscriptExport('html', 夹具, exportedAt)` 得到的字符串里 `data-message-key` 的取值集合；断言二者排序后 `assert.deepEqual` 相等——既不许多（段头不得造键），也不许少（差集必须为空）。

**假形态（承重）。** 去掉导出态的强制展开（段在导出渲染里按折叠走，`renderMember` 一次不被调用）⇒ 段内成员行不再出现在 HTML 里 ⇒ AC2 的差集非空、必须红。第二条：在 `renderMember` 里只渲染首成员（或漏掉尾成员）⇒ AC2 同样红。

**本任务不做的（属同轴兄弟判据）。** 段选择器本身归 AC-202，段记录组件的折叠/展开渲染归 AC-203，面板接线与展开态宿主归 AC-204，段锚点稳定性归 AC-205，真实浏览器密度与搜索命中归 AC-207；本任务只改导出文档、加自己的判据文件，不修改兄弟任务的出货文件（假形态变异是**瞬态**的，跑完即 `git checkout -- <file>` 恢复）。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/transcriptExportWorkSegments.test.tsx` 退出 0。红态基线（本轮实测 2026-10-02）：该文件不存在，同一命令读数是 `No test files found, exiting with code 1`。
- [x] AC2（承重）导出 HTML 的行键集合与合并前逐键相等：`npx vitest run src/modules/chat/tests/transcriptExportWorkSegments.test.tsx -t "the exported document keeps every pre-merge row key"` 退出 0 —— `buildTranscriptExport('html', …)` 的 HTML 里 `data-message-key` 取值集合与 `new Set(messages.map(getIntrinsicMessageKey))` 排序后 `deepEqual` 相等；差集（少一行）与并集之外的多余键（段头造键）都必须为空。
- [x] AC3（承重，AC2 的非空正控制）夹具真的经过一段多成员段：`-t "the fixture actually contains a multi-member work segment"` 退出 0 —— 断言 `groupWorkSegments(夹具)` 产出至少一段 `members.length >= 3`，其中同时含 thinking 行与工具调用行，且段外存在非成员行；没有这条，AC2 在「选择器其实没折叠任何东西」时也会绿，(ii) 就是空话（对照 zero-claim-criterion-needs-positive-controls）。
- [x] AC4（承重）假形态必须红（先提交实现与判据，再逐条变异；逐条记录变异 diff、逐字失败行与 `git checkout -- <file>` 恢复命令）：(a) 去掉导出态的强制展开（让段在导出渲染里按折叠走，展开位为假）⇒ 段内成员键从 HTML 消失 ⇒ AC2 红；(b) `renderMember` 只渲染首成员 / 漏掉尾成员 ⇒ AC2 红。变异必须落在导出文档真正消费的那处推导（段渲染的展开位或成员遍历）。
- [x] AC5（承重）段头不造键：`-t "the segment header contributes no row key"` 退出 0 —— 导出的 `data-message-key` 集合里不存在任何不在夹具键集合里的值（把 AC2 的「不许多」半边单独钉一次），并断言段头元素本身不带 `data-message-key`。
- [x] AC6 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 判据跑的是真实出货链路：`buildTranscriptExport('html', …)` → `buildTranscriptHtml` → `renderToStaticMarkup(TranscriptExportDocument)`；段来自 AC-202 出货的 `groupWorkSegments`（`@/modules/chat/utils/workSegments`），段记录来自 AC-203 出货的 `WorkSegmentRecord`（`@/modules/chat/transcript/WorkSegmentRecord`）；不接受测试内联一份等价的导出文档、段选择器或段记录，也⛔不得在测试里自建一棵转录树代替导出文档。
- 导出文档在段项上强制展开：`WorkSegmentRecord` 收到的展开位在导出渲染里恒为真，走的是既有 `isExporting` 覆盖（与 `MessageComponent.tsx:409` 的 Reasoning / `ToolGroupContainer.tsx:94` 同一约定）；实现里不出现「导出态折叠段」的分支。
- 行可寻址：导出 HTML 里每条真正渲染的消息行带 `data-message-key = getIntrinsicMessageKey(该行消息)`；段头不携带该属性。测试断言的是集合相等（neither extra nor missing），不是「包含」。
- 两个假形态都真的红过，且 `git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- 只动 `## Touches` 列出的文件；不修改 AC-202/203/204/205 的出货文件——若确实需要（例如 `WorkSegmentRecord` 必须先认得导出态），先把该文件加进 `## Touches` 再写，并确认不与兄弟任务的 Touches 相撞（同一文件集被两个任务同时声明会触发 anti-drift 判定）。

## Touches

- src/modules/chat/export/TranscriptExportDocument.tsx
- src/modules/chat/tests/transcriptExportWorkSegments.test.tsx (new)
- src/modules/chat/tests/transcriptExport.test.tsx
- tasks/gap-work-segment-export-forced-expand.md
