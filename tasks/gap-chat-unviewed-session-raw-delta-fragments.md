---
id: gap-chat-unviewed-session-raw-delta-fragments
title: 非当前查看会话的 stream_delta 原始帧被逐 token 落成行：切回该会话即见碎片历史（实测 400 行 / 132 消息），刷新即消失
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷。** 页面当前并未查看的那个会话，其流式增量被以**原始帧**入库；而渲染端把每一条 `stream_delta` 都画成一行助手消息 ⇒ **一个 token 一行**。用户切回该会话时，读到的是一地被切碎的"对话历史"，每片各带一个 MD 徽标。

**症状与证据（2026-09-21 本会话实测，可复跑）。** 用 Playwright MCP 打开本应用（172.28.0.1:3001），页面停在会话 A；让会话 B 流式输出一段长文字；**不刷新页面**、点侧栏切回 B。读数：

- 列表 header 从正常变成 `Showing 400 of 132 messages`（132 条消息渲染成 400 行）；
- 尾部连续 13 行各自只含一个 token：`step` / `—` / `navigate` / `**` / `back` / `**` / `client` / `-side` / `and` / `inspect` / `the` / `rows` / `.`，每行都带自己的 MD 徽标；
- 静置 12 秒，碎片行数不变（24 行）⇒ 不会被自动收敛；
- 整页刷新后归零。反向对照：刷新后直接落在**正在流式**的会话上，碎片行数 0。

原始报告来自会话 9a334a28：其历史里出现 `prom / MD / pt / MD / 偏 / MD / 置 / MD / 至今 / MD / 仍是`，正是该会话最后一条回复「…prompt 偏置至今仍是「另议」，无 goal、无任务」的逐个 token。该会话的落盘 transcript 完全干净（逐行 jq 扫过，无短文本 assistant 记录）——**碎片只活在客户端内存 store 里**，这正是它此前难被归因的原因。

**机制（已定位到行）。**

- 正确的那条：`src/modules/chat/hooks/useChatRealtimeHandlers.ts:189-200` 把 `stream_delta` 累进 `accumulatedStreamRef`，100ms 节流后交给 `updateStreaming`（`src/modules/chat/hooks/useSessionStore.ts:850-871`），后者按 live id **复用同一行**。实测正在查看的会话，整段输出就是一行（高度 439px）。
- 出缺陷的那条：`src/modules/chat/hooks/useChatRealtimeHandlers.ts:201-204` —— 当帧的 sessionId 不等于当前查看的会话时，把**原始增量帧**直接交给 `appendRealtime` 入库。
- 渲染端：`src/modules/chat/hooks/useChatMessages.ts:461-471` 的 `case 'stream_delta'` 把每一条这样的消息都 push 成一行助手消息，`content` 即该增量的文本。
- 为什么赖着不走：`src/modules/chat/hooks/useSessionStore.ts:321-372`（pruneRealtimeSupersededByServer）与 `:265-313`（dedupeAdjacentAssistantEchoes）都靠**全文精确相等**收敛；一个 token 的碎片永远不可能等于落盘的那条完整回复，于是永不被回收，直到整页刷新。

**触发条件（受控复现，非推测）。** 该会话在流式输出时，不是页面当前查看的那个会话 —— 在会话列表上、在别的会话里、或页面尚未解析出选中会话。判据取自 `src/modules/chat/hooks/useChatRealtimeHandlers.ts:80-81` 的 `selectedSession?.id || currentSessionId || null`。

**性质。** 两条路径都是上游代码（`git blame`：`useChatRealtimeHandlers.ts:202` 为 2026-06-11 `f5eac2ec1`；`useChatMessages.ts:461` 为 2026-03-19 `a4632dc4c`），不是本仓库近期改动引入的回归。

**修复方向（供实现参考，不是硬性约束）。** 堵在源头：非当前会话的增量不该以原始帧入库，而应走同一套行内累积。注意 `accumulatedStreamRef` 是**单个共享缓冲**，而抓包实测同一页面同时收到两个会话的帧（711ed4ea 与 332d2c8f 同时在流式），所以此处必须是**按 sessionId 分桶**的缓冲，不能直接复用这一个 ref。备选兜底：`useChatMessages.ts` 的 `stream_delta` 分支只渲染本客户端自己铸造的 live 行（`isLiveRowId(msg.id)`），原始帧一律不落行 —— 但这只治表象，store 里仍会堆积垃圾。

**判据编写注意（本缺陷的特殊性）。** 整页 reload 会清空内存 store，从而**把缺陷洗掉** —— 判据不得靠 reload 后取样，必须走客户端侧导航（点侧栏链接）以保留 store。浏览器侧复现手法：`page.addInitScript` 包装 `window.WebSocket` 记录入站帧，据此确认"每个 token 都是独立一帧"这一前提。

<!-- dedup-ref -->同机制关联（记给出处，**不是**本任务的前提）：[[gap-transcript-follow-on-real-stream]]（done，让 `stream_delta` 真的发得出来）、[[gap-transcript-follow-finalize-remount-loses-bottom]]（done，收尾换 key 的重挂载与 live 行身份）、[[gap-transcript-follow-criterion-llm-coupling]]（done，判据夹具化）三者都不申领"非当前查看会话的原始增量帧被逐 token 落行"这一环，与本条 Touches 不重叠。

## AC

- [x] AC1 `stream_delta` 分支不再以原始帧入库：`awk "/if \(msg\.kind === 'stream_delta'\)/,/if \(msg\.kind === 'stream_end'\)/" src/modules/chat/hooks/useChatRealtimeHandlers.ts | grep -c "appendRealtime"` 输出 **0**（实测修复前为 1，即缺陷本身）；且 `npm run typecheck` 退出码 0。
- [x] AC2 新增单测被 scoped gate 选中且全绿：`bash scripts/test.sh --for-task gap-chat-unviewed-session-raw-delta-fragments --allow-thin` 退出码 0，输出中含新测试文件名（证明它被发现并被真跑，而不是被 thin 跳过）；完成记录贴出直接运行该文件的命令、退出码与断言条数。
- [x] AC3 用例覆盖三件事，每件一个独立断言且可分别反红：(a) 两个会话同时流式时，**非当前**会话的 N 个增量在 store 里只产生**一个**流式行；(b) 该行的文本等于各增量按序拼接；(c) 后到的第二个会话的增量不会污染第一个会话的行（按 sessionId 分桶的不变量，而非"调用了哪个函数"）。
- [x] AC4 抗假变体：把非当前会话的路径改回"每条增量各 append 一次" ⇒ AC2 的用例必红；还原后 `git diff -- src/modules/chat` 为空。
- [x] AC5 `npm run lint`（= `oxlint src/ server/`）退出码 0（新测试经模块 barrel 导入，boundaries / unused 规则不红）。

## DoD

在真实浏览器里复现一次并留读数：页面停在会话 A，会话 B 流式输出一段 ≥20 个增量的长文字，全程**不刷新页面**；随后客户端侧切回 B，该段文字在 pane 中呈现为**一行**（而不是每 token 一行），且列表 header 不再出现"已显示数 > 总数"。把这三项读数（碎片行数、该段占用的行数、header 文本）贴进完成记录。同一读数在整页 reload 前后一致 —— 证明修复走的是累积路径本身，而不是靠刷新兜底。

L_D 该轴仍暗，理由：本条修的是客户端 realtime 行的累积与身份，不产出数据/文档语义轴上的量化读数。

## Touches

- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx (new)
- tasks/gap-chat-unviewed-session-raw-delta-fragments.md

<!-- evidence -->
**证据（全部真跑；读数取自本任务 worktree `/data/home/yale/work/claudecodeui/.claude/worktrees/gap-chat-unviewed-session-raw-delta-fragments`；实现提交 `411d903e`，merge develop 后 `1e580068`）。**

**AC1。** `awk "/if \(msg\.kind === 'stream_delta'\)/,/if \(msg\.kind === 'stream_end'\)/" src/modules/chat/hooks/useChatRealtimeHandlers.ts | grep -c "appendRealtime"` → **0**（修复前 1，即缺陷本身）。该 awk 区间现在 8 行，全部是累积路径：`const text = (msg.content as string) || '';` / `if (!text || !sid) return;` / `accumulateStreamDelta(sid, text);` / `return;` + `stream_end` → `settleStream(sid)`。`npm run typecheck` EXIT=0（merge develop 之后复跑，见 AC5 段）。

**AC2。** scoped gate 直接跑：`bash scripts/test.sh --for-task gap-chat-unviewed-session-raw-delta-fragments --allow-thin` → **EXIT=0**；输出含新测试文件名与逐文件判决 `__PERFILE__ duration_ms=13 src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx passed=true`（即它被 `## Touches` 选中并真跑，而非被 thin 跳过），并 `# tests 1 / # pass 1 / # fail 0 / # cancelled 0`、`suite-scope-check: PASS`。直接跑该文件：`npx vitest run src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx` → **EXIT=0 / `Test Files 1 passed (1)` / `Tests 3 passed (3)`**；文件内断言条数 **12**（`grep -c "assert\." ` = 12，3 个用例分摊）。

**AC3。** 三个用例各自独立可反红，用三种互不相同的假实现分别验过（每次先 `cp /tmp/quay-gap-chat-unviewed-212116/hook.bak` 还原再打下一个变体）：(a) 把非当前会话的路径改回「每条增量各 `appendRealtime` 一次」⇒ 三个用例全红（行数断言先红）；(b) 把累积写成 `accumulated = text`（只留最后一帧）⇒ **只有**「行文本 = 各增量按序拼接」那类断言红，行数断言仍过；(c) 把按 sessionId 分桶换成单个共享缓冲 ⇒ **只有**第三个用例（两会话同时流式）红，前两个仍过。即 (b) 与 (c) 各自被一条不同的断言独立抓住，而不是被同一处红掩盖。

**AC4。** 变体跑完后 `git checkout --` / `cp` 还原，`git diff -- src/modules/chat` **无输出**，同一用例随即复绿（`Tests 3 passed (3)`，EXIT=0）。

**AC5。** `npm run lint`（= `oxlint src/ server/`）**EXIT=0**；诊断全部是 pre-existing warning（`react(set-state-in-effect)` 等，行号在本文件里从 81/83 平移到 91/93），0 error，新测试文件 0 诊断。前端标准的其余验证项：`npm run typecheck` EXIT=0、`npm run build:client` EXIT=0、`npm run test:client` **82 files / 566 tests passed**（EXIT=0）。

**DoD（真实浏览器，一次复现 + 变体对照）。** 探针为一次性 `e2e/tmp-unviewed-fragments.spec.ts`，用与 `e2e/transcript-follow.spec.ts` 同一套 in-page WebSocket 替身把 25 个 `stream_delta` + 1 个 `stream_end` 交给应用自己的 socket；页面停在应用自建的空会话 A，整个投递与导航期间**不刷新页面**（窗口上的存活标记 `__probeAlive` 在两处读数里都仍是 `'kept'`，读数后 `page.goto` 整页 reload 才变 false）——刷新会重建 store 把缺陷洗掉，故切回 B 走的是侧栏链接（`a[href^="/session/"]`）这一客户端侧导航。B = 播种的 `e2e-transcript-follow`（24 条服务端消息，pane 真的分页）。播种 transcript 的时间戳是从启动往前每分钟一条（24 条 ⇒ 最后一条在启动 +23min），而 live 行的时间戳由 store 现取，会被排进这段 transcript 中部（那里 LazyMessageRow 不挂载、pane 的窗口也够不到），因此浏览器时钟先 `page.clock.setFixedTime(+60min)` —— 只冻结 `Date`，应用的定时器（含 100ms 合流）照常跑，两种实现都因此把 live 行排到会话末尾，读数才可比。

修好的版本，切回 B 后（`survivedWithoutReload=true`）：**碎片行数 0**、**该段占用的行数 1**（挂载行里最后一行文本以 `Δ00 The transcript pane keeps the newest…` 开头，25 个 token 在同一行内）、**header 文本 `Showing 21 of 24 messages Scroll up to load more`**（21 = 20 条服务端 + 这 1 行 live 行；**未出现 shown > total**）。整页 reload 后同一组：碎片行数 0、该段占用 0 行（这段文字只活在客户端内存、从未落盘，故 reload 后自然不在）、header `Showing 20 of 24 messages` —— **缺陷签名（碎片行 > 0、shown > total）两侧都不存在**，即 reload 之前的那个状态本身就已经是干净状态，不是靠刷新兜底。

变体对照（把非当前会话的路径改回「每条增量各 `appendRealtime` 一次」，其余不动，同一探针同一夹具）：`fragmentRows: 25`、`passageRows: 25`（`rowTexts` 逐行 `Δ16/Δ17/…/Δ24` 各一行）、header **`Showing 45 of 24 messages`** —— shown(45) > total(24)，与本任务 Proposal 记录的线上形态（`Showing 400 of 132 messages`、13 行逐 token 碎片）同形。变体随即还原（`git diff -- src/modules/chat` 无输出），同一次读数再跑一遍复绿。探针本身已删除，`e2e/tmp-unviewed-fragments.spec.ts` 不在 diff 里（最终 `git status --porcelain` 为空）。

**收尾（本工作流要求的机械步骤）。** `git merge --no-edit develop` 无冲突（merge `1e580068`，parents `411d903e` / `0c543a48`）；merge 之后重跑 scoped gate 仍 EXIT=0（上引读数即 merge 后那一轮）；`worker-driver.js --write-scoped-gate-cache --task gap-chat-unviewed-session-raw-delta-fragments --develop-sha 0c543a48eb06557cb02ba4df1c07045e072d86eb --root /data/home/yale/work/claudecodeui` 回报 `{"event":"scoped-gate-cache-written", … "cacheFile":"/data/home/yale/work/claudecodeui/.quay/scoped-gate-cache.json"}`。

**未关闭（如实登记）。** 本任务只修「非当前查看会话的原始增量帧被逐 token 落行」这一环；`useChatMessages.ts` 的 `case 'stream_delta'` 仍然会把任意 `stream_delta` 画成一行，即渲染端对「非本客户端铸造的 live 行」没有防线（本任务选择的方案是堵源头，未采纳该文件的兜底改法，故 `useChatMessages.ts` 与 `useSessionStore.ts` 虽在 `## Touches` 内却零改动）。另外，两次 DoD 读数都依赖 `page.clock.setFixedTime` 这一测量夹具，而非被测代码。
