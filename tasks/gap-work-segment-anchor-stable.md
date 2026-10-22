---
id: gap-work-segment-anchor-stable
title: AC-205 段锚点跨尾部增长稳定：尾部追加不改键与展开态，两条失稳边界记录在案
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-work-segment-selector-row-type-pure
goal_ac: AC-205
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-02）：`grep -rn "^goal_ac: *AC-205" tasks/*.md` → **0 命中**；`grep -rln "AC-205" tasks/*.md` 只命中同轴 AC-202 任务里的一句让位散文（原文：「锚点的跨尾部增长稳定性由 AC-205 单列」）；`ls src/modules/chat/tests/workSegmentAnchorStability.test.ts` → 不存在（本轮已确认）；目标级判据在 `.quay/gate-events.jsonl` 的读数 4 次全为 fail，reason 都是 `No test files found, exiting with code 1`（2026-10-01 16:35–16:54）。⇒「段锚点在尾部增长下的身份稳定性」无人认领，不是重复。

**现状读数（2026-10-02，读代码）。** 目标级判据文件不存在（红态基线见 AC1）。转写流今天只有 `src/modules/chat/utils/toolGrouping.ts` 的 `groupConsecutiveTools`（同名工具、连续、条数 ≥2 折成 `ToolGroupItem`），没有任何「工作段」层；`src/modules/chat/utils/workSegments.ts` 与 `src/modules/chat/transcript/WorkSegmentRecord.tsx` 均不存在（AC-202/AC-203 尚未落地，本任务依赖 AC-202 出货的选择器）。锚点今天唯一可依据的口径是 `getIntrinsicMessageKey`（`src/modules/chat/utils/messageKeys.ts`）：候选顺序 `blockKey > id > messageId > toolId > toolCallId > blobId > rowid > sequence`，全部缺席时才退回 `type + 时间戳 + toolName + 正文前 48 字` 的内容兜底分支；`ChatMessagesPane.tsx:202-222` 的 `messageKeyMap` 再用「行内键 + 冲突时 `__<出现序号>` 后缀」做 React key。两条边界所需的真实机制仓库里都已存在且可驱动：`mergeOlderServerPage`（`src/modules/chat/utils/sessionMessagePagination.ts:191`，**已导出**，把更老一页前插进 cached 前缀并返回 `prependedCount`）；助手回声去重 `dedupeAdjacentAssistantEchoes`（`src/modules/chat/hooks/useSessionStore.ts:276`，**模块私有**，只折相邻行，已经被 `src/modules/chat/tests/adjacentEchoCollapse.test.tsx` 与 `src/modules/chat/tests/echoSeparatedByToolRow.test.tsx` 用 `renderHook` 夹具经 store 公有方法驱动过）。

**要做的事。** 交付判据 `src/modules/chat/tests/workSegmentAnchorStability.test.ts`，把「段的锚点 = 首成员的行内键，因而只对首成员敏感」这一身份契约钉住 —— 这是 AC-202 出货的段身份、也是 AC-204 面板 `data-work-segment-key` 的同源口径，本任务只 pin 它、不重定它。

- 读数 (i) 尾部增长：用 AC-202 的 `groupWorkSegments` 从夹具取段，把 tail 段的锚点放进一个 `expandedAnchors: Set<string>`（**这就是 AC-204 面板 `expandedSegmentKeys` 的同一机制**：一个按锚点键的集合）；模拟流式，逐条、多次把成员追加到该段尾部，每次追加后重新求值，断言该段的锚点逐字不变、且 `expandedAnchors` 仍然命中它。
- 读数 (ii) 锚点身份：锚点 === `getIntrinsicMessageKey(segment.members[0])`；同一首成员下，追加成员的条数与顺序都不影响它。
- 两条**记录在案的失稳边界**（AC 明写是行为记录、不是缺陷）：历史窗口头部被裁后再加载更多 ⇒ 成员前插到顶段头部 ⇒ 顶段锚点变、其展开态丢；助手回声去重折掉充当终止行的重复正文行 ⇒ 两段合并 ⇒ 后段锚点消失、其展开态丢。两条都必须把「就是会丢」断言出来（旧锚点不再出现在锚点集合里），而不是假装不会。

**判据怎么读。** 判据是 `.ts`（与目标级判据同名；要驱动 React 时用 `React.createElement` + `@testing-library/react`，先例 `src/modules/command-palette/tests/sessionTitleLiveUpdate.test.ts` —— ⛔ 不要改成 `.tsx`，改名后目标级判据 `filter: ...workSegmentAnchorStability.test.ts` 会找不到文件）。读数 (i)(ii) 是纯读数：段来自真实出货的 `groupWorkSegments`，锚点读的是出货的段身份（不读测试里自己算的第二份）；边界 (a) 用真实出货的 `mergeOlderServerPage` 造「加载更多」；边界 (b) 的折叠后列表必须由真实去重路径取得（`useSessionStore` 公有方法，夹具形状照 `adjacentEchoCollapse.test.tsx` 的 `loadedStore()/refreshFromServer()`），⛔ 不得在测试里手写一份去重。每条边界都要带一条**局部正控制**（没被触及的那条段锚点不变、仍在展开集合里），否则「全丢」这类恒定真断言会冒充读数。

**本任务不做的（属同轴兄弟判据）。** <!-- dedup-ref --> 段选择器本身的边界判定（行类型纯函数、流式不变）归 AC-202，本任务只 import 它出货的 `groupWorkSegments`；段记录的折叠/展开渲染与无损集合相等归 AC-203；展开态的宿主（跨 LazyMessageRow 卸载保持、重挂回缺省折叠）归 AC-204，本任务只对齐它 `expandedSegmentKeys` / `data-work-segment-key` 的口径；导出路径强制展开归 AC-206；真实浏览器读数归 AC-207。本任务只交付自己的判据文件，不修改兄弟任务的出货文件（假形态变异是**瞬态**的，跑完即 `git checkout --` 恢复，见 AC6）。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/workSegmentAnchorStability.test.ts` 退出 0。红态基线（本轮实测）：该文件不存在，`.quay/gate-events.jsonl` 里同一目标级判据 4 次读数是 `No test files found, exiting with code 1`。
- [x] AC2（读数 i，承重）尾部追加不改键、不改展开态：`npx vitest run src/modules/chat/tests/workSegmentAnchorStability.test.ts -t "the tail segment keeps its anchor while members stream into its tail"` 退出 0 —— 对同一夹具逐条追加成员到 tail 段尾部（≥3 次，每次重新求值），每次断言 (a) 该段锚点逐字相等、(b) `expandedAnchors.has(anchor)` 仍为真；(c) 局部正控制：兄弟段锚点也不变但两者锚点互不相等。
- [x] AC3（读数 ii，承重）锚点 = 首成员行内键，追加顺序与次数无关：`-t "the anchor is the first member's intrinsic key"` 退出 0 —— 断言锚点 === `getIntrinsicMessageKey(segment.members[0])`；同一首成员、以不同顺序与不同条数追加 ⇒ 锚点不变。(d) 正控制：夹具首成员必须带稳定身份字段（`blockKey` / `id` / `toolId` 之一，断言它非空），使 `getIntrinsicMessageKey` 走身份分支而非文件末尾的 `content-preview` 兜底分支 —— 否则 (ii) 对内容敏感，是一条空话。
- [x] AC4（边界 a，记录在案的失稳，承重）加载更老一页后顶段重锚、展开态丢：`-t "loading an older page re-anchors the top segment and loses its expansion"` 退出 0 —— 用**真实出货**的 `mergeOlderServerPage(cached, older)` 造「历史窗口头部被裁后再加载更多」，其更老一页的尾部成员与顶段首成员相邻（中间无终止行）；重新求值后断言 (a) 顶段锚点变了、(b) 旧锚点已不在当前锚点集合里（= 展开态丢，断言方向就是「会丢」）、(c) 正控制：下方未被触及的另一条段锚点不变、展开集合仍命中它。
- [x] AC5（边界 b，记录在案的失稳，承重）回声去重折掉终止行 ⇒ 两段合并 ⇒ 后段锚点消失、展开态丢：`-t "echo dedup folds the terminator and loses the second segment's expansion"` 退出 0 —— 折叠后的列表必须由**真实去重路径**取得（`useSessionStore` 公有方法，`dedupeAdjacentAssistantEchoes` 模块私有；夹具照 `src/modules/chat/tests/adjacentEchoCollapse.test.tsx` 的 `loadedStore()/refreshFromServer()`），⛔ 不得在测试里手写去重。断言 (a) 折叠前夹具确实是两段、那条重复正文行在两段之间且确实是终止行；(b) 折叠后段数少一（真的合并）；(c) 后段旧锚点不再出现（展开态丢）。(d) 若实测该真实路径对该夹具**不产生合并**（终止行没有被移走），以实测为准把「会丢」钉在真实失稳形态上，并在 DoD 附上子产物读数 —— 不得为了迎合本条描述伪造一个不存在的合并。
- [x] AC6 取假形态必须红（承重；先提交实现与判据，再逐条变异；逐条记录变异 diff、逐字失败行与 `git checkout -- <file>` 恢复命令）：(a) 锚点 = 首成员键 + 末成员键拼接 ⇒ 尾部追加后锚点变 ⇒ AC2 红；(b) 锚点把成员计数并进去 ⇒ 追加后锚点变 ⇒ AC2 红；(c) 锚点聚合成员内容（全体成员正文的哈希）⇒ 尾部成员的流式正文改变聚合 ⇒ AC2 红。变异必须落在**读数真正消费的那处推导**（AC-202 出货的段身份，或 AC-204 面板 `data-work-segment-key` 的来源），逐条记录被变异的文件与行号。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 判据跑的是真实出货对象：`groupWorkSegments` 来自 `@/modules/chat/utils/workSegments`（AC-202 出货）、`getIntrinsicMessageKey` 来自 `@/modules/chat/utils/messageKeys`、`mergeOlderServerPage` 来自 `@/modules/chat/utils/sessionMessagePagination`、去重经 `useSessionStore` 公有方法；不接受测试内联一份等价的段选择器、分页合并或回声去重。
- 锚点只由首成员决定：读数消费的是出货的段身份（与 AC-204 的 `data-work-segment-key` 同源口径）；测试与实现里都不出现把 `content` / `displayText` / 成员数 / 末成员纳入锚点的读取 —— 除非那正是 AC6 的瞬态变异（跑完必须恢复）。
- 两条边界都真的断言了「就是会丢」（旧锚点不再命中展开集合），且各自带一条局部正控制（未被触及的段仍在、仍展开），使「全丢」这种恒定真断言无法冒充读数。
- 三个假形态都真的红过，且 `git checkout -- <file>` 恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- 判据文件是 `.ts`（与目标级判据 `.../workSegmentAnchorStability.test.ts` 同名同扩展名）；需要 React 时用 `React.createElement`，不改名成 `.tsx`。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件（例如给段身份补一个对外读数），先把该文件加进 `## Touches` 再写。

### AC6 变异证据（逐条：变异 diff、逐字失败行、恢复命令）

变异目标：`src/modules/chat/utils/workSegments.ts:65`（`groupWorkSegments` 内段身份的推导 `key: getIntrinsicMessageKey(message)` —— 正是读数真正消费的那处）。三条都先提交实现与判据（commit `5cf6e495` / `90fa3ffe`）再变异。

- (a) 首末成员键拼接 —— diff：
  `- key: getIntrinsicMessageKey(message)`
  `+ key: \`${getIntrinsicMessageKey(message)}::${getIntrinsicMessageKey(members[members.length - 1])}\``
  逐字失败行：`AssertionError: append #1 must not re-mint the tail anchor`，位置 `src/modules/chat/tests/workSegmentAnchorStability.test.ts:170:12`。
  恢复：`git checkout -- src/modules/chat/utils/workSegments.ts`
- (b) 成员计数入键 —— diff：`+ key: \`${getIntrinsicMessageKey(message)}#${members.length}\``；逐字失败行同上（`...:170:12`，`append #1 must not re-mint the tail anchor`）；恢复命令同上。
- (c) 成员正文聚合入键 —— diff：`+ key: \`${getIntrinsicMessageKey(message)}@${members.map((member) => member.content ?? '').join('~')}\``；逐字失败行同上（`...:170:12`，`append #1 must not re-mint the tail anchor`）；恢复命令同上。
- 三条恢复后：`npx vitest run src/modules/chat/tests/workSegmentAnchorStability.test.ts` 重新绿（4 passed），`git status --porcelain -- src/modules/chat/utils/workSegments.ts` 为空。

### AC5 机制读数（实测，附 AC5(d) 子产物）

实测：`dedupeAdjacentAssistantEchoes` 只把相邻的一对折成**一行**，终止行始终留一行，因此它单独**不会**让两段合并（对全部 2^6 个 tool/text 小列表 × 3 条流式文本的穷举探针 0 命中）。真正把充当终止行的重复正文行移走、使两段合并的真实路径，是同一 store 的助手回声调和 `pruneRealtimeSupersededByServer` → `isAssistantTextEchoedInSameTurnOnServer`：客户端实时持有的回复副本在服务端同一回合已有持久副本时被剪除。读数经 `useSessionStore` 公有方法（`appendRealtime` / `fetchFromServer`）驱动，未在测试里手写去重，夹具形状照 `adjacentEchoCollapse.test.tsx`。实测读数：折叠前 3 段（含一条未被触及的正控制段），折叠后 2 段（真的合并，段数少一），后段旧锚点不再命中展开集合、正控制段锚点与展开态保持。

## Touches

- src/modules/chat/tests/workSegmentAnchorStability.test.ts (new)
- tasks/gap-work-segment-anchor-stable.md