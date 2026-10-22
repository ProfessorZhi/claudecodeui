---
id: gap-transcript-follow-finalize-remount-loses-bottom
title: turn 收尾换 key 导致重挂载：pane 塌陷后可能停在底部之外；增长帧的 offset 亦被浏览器 clamp 到 0 ——
  钉死机制并修到 AC-108 能改回字面量「全程逐帧 gap ≤1px」
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本任务是 [[gap-transcript-follow-on-real-stream]]（AC-108）收尾时**找出但按范围排除**的那件事，读数与证据都由那一轮的 spec 留证（`e2e/transcript-follow.spec.ts` 的 AC-108 用例，`growthFrameGaps` / `postArrival*` / `firstCollapse` / `writesAtExcursions`）。AC-108 的收窄（把「全程最大 gap ≤1px」换成「除增长帧外逐帧贴底 + 增长帧必须下一帧修复 + 不越底」）就是因为本任务要修的东西在那里不可满足；**本任务做完之后，AC-108 应能改回字面量**。兄弟任务 [[gap-transcript-follow-browser-scroll-not-user-intent]]（AC-111，已 achieved）与本任务共享症状面但**场景不同**：AC-111 是「程序改 DOM 让上方一行变矮」，本任务是「turn 收尾时最后一行被换 key 导致重挂载」；[[gap-transcript-follow-on-content-resize]]（AC-106）、[[gap-transcript-follow-on-pane-shrink]]（AC-107）提供几何跟随与采样仪器，本任务不重复申领。⛔ 不重复申领 AC-109/110 的手势/翻页语义。

### 现状（2026-09-21，AC-108 实跑留证）

AC-108 的流式用例里有两个读数，都是**内容塌陷 ⇒ 浏览器把 `scrollTop` clamp 到 0 ⇒ 跟随要么下一帧修、要么没人修**，但两者的确定性不同：

1. **确定发生、且已直接观测：turn 收尾时的塌陷。** `stream_end` 到达后 `finalizeStreaming`（`src/modules/chat/hooks/useSessionStore.ts:836-853`）把该行的 id 由 `__streaming_<sid>` 换成新的 `text_<ts>_<rand>`；React 按 id keyed，所以这是 **unmount + mount** 而不是 reconcile。重挂载期间该行落到 `LazyMessageRow`（`src/modules/chat/transcript/LazyMessageRow.tsx:68-74`）的占位盒上（`height: measuredHeight ?? 100`，`measuredHeight` 只在行**离开**视口时才写），pane 的内容高度随之塌；随后替换回来的高度与塌前**完全一致**，`ResizeObserver` 因此看不到变化、从不回调，跟随也就从不被问「还该不该贴底」。实测：`firstCollapse` 帧读到 `scrollHeight` 落到自己的 `clientHeight`（496），最后一行盒高 240px（= 估算值 + 该行自身的 chrome），紧接着 `complete`。
2. **机制未证：每个 delta 增长那一帧的 clamp。** AC-108 的 `growthFrameGaps` 里 22 个增长帧的 `top` **全部为 0**（不是「落后一步」的 `bottom − step`），最坏读 1393px；同时 `writesAtExcursions` 为空、`zeroWrites 8` —— 那些帧上**没有任何 JS 写 `scrollTop`**，是浏览器自己 clamp 的，说明那一帧内 pane 的内容高度确实短暂塌过。**谁把它塌的还没证。** `LazyMessageRow` 是常驻嫌疑，但它的 observer 是 1200px `rootMargin`、无 threshold（`src/modules/chat/hooks/useLazyRowObserver.ts:49-52`），对一个 1671px 的行按几何算是 intersecting —— 嫌疑不等于结论，⛔ 不要把未证的机制写成本任务的前提。

收尾塌陷的后果**间歇**：一次跑 `postArrivalFrames 48`、`postArrivalSpanMs 765` 仍在窗外未恢复（`lastSampleGap 1355`，pane 停在距底 1355px 处，且此后不再有任何触发信号）；另一次第 409 帧就恢复（`postArrivalRecoveredAtFrame 409`）；还有一次只差 3 帧。间歇本身就是「重挂载与 observer 投递之间是竞态」的证据。

### 方案

1. **先把两个塌陷的机制钉死**，而不是先改代码：在 AC-108 的采样仪器上扩一个探针，逐帧记（a）pane 的 `scrollHeight` 与最后一行盒高、（b）该行的 `data-message-timestamp` / React key（重挂载会让 DOM 节点身份变化）、（c）该行是否处在 `LazyMessageRow` 的占位态（盒高 == `measuredHeight ?? 100`）、（d）`scrollTop` 的写入者（是否走过本项目自己的写路径）。增长帧那个 clamp 的写入者是「浏览器 clamp 而非 JS 写」已由 `writesAtExcursions` 为空证到；本步要证的是**谁在那一帧把内容塌了**。
2. **修收尾塌陷**（确定的那一个）。候选方向，实现时择一并记理由：(a) 让 turn 收尾不换 key（或换 key 同时保持 DOM 节点身份，例如把 streaming 行与 settled 行做成同一 key 的两种渲染态）；(b) 让 `finalizeStreaming` 之后跟随被显式问一次（把「贴底」的重申挂在收尾事件上，而不是只挂在几何观察上）；(c) 让 `LazyMessageRow` 对**最后一行**不退化到占位盒。⛔ 不许把「贴底」做成对 `chatMessages.length` 的依赖（那正是 AC-108 的抗假变体 (i) 打死的形态）；⛔ 不许在 pane 上加 CSS 钉底或依赖浏览器 scroll anchoring。
3. **增长帧的 clamp**：机制钉死后若与第 2 步同因，一并修；若不同因，修它并在完成记录里把两者的区别写清楚。两个都修完，AC-108 的第二条应能把豁免去掉、改回字面量「流式全程逐帧 gap ≤1px」。
4. **回归面**：`e2e/transcript-follow.spec.ts` 里 AC-106/107/108/110/111 五条既有用例全部保持绿；AC-108 的活性断言与两个抗假变体的红灯不得被削弱。

### 非目标

- 不实现 AC-109/110/111 的语义（向上手势立即脱离、顶部翻页不被抢回、非用户输入滚动不改意图）。
- 不改 wire 协议；不动 `realtimeMessages` 的修剪/去重规则。
- 不修「流式更新成块到达」（GOAL-004 已明确属于 realtime 刷新链路，另有任务）。

## 完成记录（2026-09-21）

### AC-1 探针：两个塌陷同因，各钉到一处可复跑读数

AC-108 的采样仪每帧记 `lastRowNode`（最后一行 DOM 节点身份）、`lastRowStamp`（其 `data-message-timestamp`）、`scrollHeight`/`clientHeight`、最后一行盒高与 `scrollTop`。修前那句「谁把增长帧塌了还没证」在本轮**证到与收尾塌陷同因**：

- **增长帧**：`nodeRuns [1,2,…,24]` —— 22 个 delta 换来 **24 个不同的 DOM 节点**（每个 delta 一次 unmount+mount）；`unpinnedFrames` 21 帧、`top` **全为 0**（不是「落后一步」的 `bottom − step`），最坏 gap 1393px；`writesAtExcursions []`、`zeroWrites 6` —— 那些帧上**没有任何 JS 写**，是浏览器 clamp。
- **收尾帧**：`firstCollapse` 落在 settle 帧，读到 `scrollHeight` 落到自己的 `clientHeight`（496）、最后一行盒高 **240px**；`postArrivalFrames 2` / `postArrivalMaxGap 1355`。

**机制（点名文件与行）**：两次塌陷同一因，原因是**该行的 React key 在变，key 变 = unmount + mount**。

- key 由 `getIntrinsicMessageKey`（`src/modules/chat/utils/messageKeys.ts:12-37`）给出；live 行在候选里没有 id，落到末位回退 `message-${type}-${timestamp}-${toolName}-${contentPreview}`。
- 那个 `timestamp` 每次 flush 重铸：`updateStreaming`（`src/modules/chat/hooks/useSessionStore.ts:810-812`，`__streaming_<sid>`）；收尾再铸一次：`finalizeStreaming`（同文件 `:836-846`，`text_<ts>_<rand>`）。渲染处 keyed by it：`ChatMessagesPane.tsx:319`。
- 新节点在它被排布的那一帧按 `content-visibility: auto` 的 intrinsic 盒算：`src/index.css:591-599`（`.chat-message { contain-intrinsic-size: auto 180px }`，`.chat-message.assistant { … auto 240px }`）。于是「1671px 的行」在同一帧里换成 240px 盒、pane 内容塌，视口 offset 没变、浏览器把它 clamp 到 0；下一帧真高回来且与塌前**完全一致**，`ResizeObserver` 看不到净变化、从不回调，跟随读到的是被 clamp 的 offset（在它看来是用户移动），于是拒绝钉底。

**判别（AC-1 要求的「把该原因去掉后那一帧的 `scrollHeight` 不再塌」）**：把 key 的来源去掉后，同一份读数变成 `nodeRuns [1]`、`firstCollapse -1`、`maxGrowthFrameGapPx 1`、`unpinnedFrames []` —— 同一帧的 `scrollHeight` 不再塌。因果成立，不是相关。

**嫌疑被排除**：`src/modules/chat/transcript/LazyMessageRow.tsx` 与 `src/modules/chat/hooks/useLazyRowObserver.ts` **未改一行**（Touches 里保留声明：它们是本任务立项时的嫌疑面，留作复核入口）。占位盒的常数是 `ESTIMATED_ROW_HEIGHT_PX = 100`（`LazyMessageRow.tsx:25`），而塌陷帧读到的最后一行盒高是 **240px** —— 那是 `.chat-message.assistant` 的 intrinsic 值，不是占位盒，所以第一帧的短盒来自 `content-visibility` 的 intrinsic 排布而非懒加载占位态；把 key 稳住后该帧不再出现。

### AC-2 收尾塌陷已修

**实现（方案 2 择 (a)：收尾不换 key）**：

- `src/modules/chat/utils/liveRowIdentity.ts`（新增）：一个 turn 铸一次 `live:<sessionId>:<n>`（模块内计数器），并识别自己铸出的 id。
- `src/modules/chat/hooks/useSessionStore.ts`：`updateStreaming` 首铸后**逐帧保持**该 id（不再逐 flush 重铸 timestamp/text 派生的 key）；`finalizeStreaming` **沿用同一个 id**（不再铸 `text_<ts>_<rand>`）；`pruneRealtimeSupersededByServer` 保留客户端的 live 行；`dedupeAdjacentAssistantEchoes` 把服务端回显的字段折进它。
- `src/modules/chat/hooks/useChatMessages.ts` + `src/shared/types.ts`（`ChatMessage.id?: string`）：把该 id 带到渲染出的消息上，pane 因此以它 keyed。

**修前必红 / 修后连续绿（断言变严，不是变松）**：AC-108 现在断言从该行首次增长起到采样结束**逐帧**贴底（settle 在该区间内，`settleFrame > streamEnd` 证明采样覆盖了它），且**没有**为增长帧开口子：

- `unpinned` / `offBottom` 均 `toEqual([])`、`unrepaired` `toEqual([])`、`minGap ≥ −1`（两侧都界，越底也算不贴）、`rowCountsSeen.length === 1`；
- 机制读数 `nodeRuns.length === 1` 且 `stampChanges ≥ 21`（一帧一投影、一个节点）、`growthStepsInStream ≥ 21`、`finalizeAt > 0`。

修前那份读数里 `firstCollapse` 落在 settle 帧、`unpinnedFrames 21`；修后 `firstCollapse -1`、`unpinnedFrames []`、`nodeRuns [1]`、`maxGrowthFrameGapPx 1`。

**活性断言的收窄（amendment，写在 AC 项内）**：本 AC 原文要求「活性断言要求那次塌陷真的被观测到（未发生塌陷则本用例红）」。修掉之后那次塌陷**不存在**，该子句变成「缺陷不在时必须红」——那不是判据而是自相矛盾（一个必然红的用例不能承担任何判据）。按它守护的不变量收窄为**非空洞**：断言必须在「回复没有真的逐帧流进同一行、且没有在窗口内收尾」的运行里变红。它由上面那组读数承担，且**被证明是承重的**——抗假变体 (ii)（一次性终态）正是红在这一条上（`the last row must grow once per delta (22 deltas, 1 growth steps …)`，Expected ≥ 21），修前那份读数里则是 `nodeRuns [1..24]` + `firstCollapse` 命中。

**AC-108 的既有豁免形态未被留用**：`growthFrameGaps` 与 `postArrival*` 只作为读数保留（回归时会带回原形状），**不再豁免任何断言**。

### AC-3 增长帧的 clamp 已修（与 AC-2 同因，一并修）

- 同因的一半：一个 turn 一个 id ⇒ live 行的 key 不再回退到内容派生值 ⇒ 每个 delta 不再 unmount/mount ⇒ 那一帧的 `scrollHeight` 不再塌（`nodeRuns [1]`）。
- 另一半（提交时机）：一次 flush 提交的增长现在**在提交它的那个 task 里被答复** —— `src/modules/chat/hooks/useChatSessionState.ts` 的 `useLayoutEffect` 以 `chatMessages` 的数组身份为依赖，在 DOM 变更同一 task 内同步写下贴底 offset，所以增长帧按「已贴底」绘制；`ResizeObserver` 那条路径**保留它一帧的延迟写入**，于是落在那一帧里的手势仍然赢过钉底（`transcriptScrollOwnership.test.tsx` **未改一行**保持绿）。两条路径共用同一个判据 `judgeTranscriptGrowth`。
- **AC-108 第二条已改回字面量「流式全程逐帧 gap ≤1px」**：`unpinned` 不再排除增长帧，`minGap ≥ −1` 两侧都界。
- 读数与墙钟：修后 `maxGrowthFrameGapPx 1`；`npx playwright test e2e/transcript-follow.spec.ts -g "AC-1"` 连续两次绿 —— run3 **31.9s**、run4 **31.5s**（各 5 passed）。交接前又对**最终字节**复跑一次（spec 内两处机制注释改正之后）：**30.9s / 5 passed / rc=0**，读数 `nodeRuns [1]`、`unpinnedFrames []`、`maxGrowthFrameGapPx 1`、`firstCollapse -1`、`growthStepsInStream 22`、`stampChanges 23`。修前同一命令红：`maxGrowthFrameGapPx 1393`、增长帧 `top` 全 0、`writesAtExcursions []` / `zeroWrites 6`。

### AC-4 既有用例与抗假变体

- `npx playwright test e2e/transcript-follow.spec.ts -g "AC-1"`（AC-106/107/108/110/111）退出码 0，连续两次（同上），交接前对最终字节第三次复跑亦绿（30.9s，5 passed）。
- 抗假变体 (i)（把信号改成 `chatMessages.length`）：红在判据断言上（331 unpinned / 253 offBottom 帧），留输出后**完整还原**（`git diff HEAD` 为空、无 `VARIANT` 残留）。
- 抗假变体 (ii)（一次性终态）：红在活性子句上（`22 deltas, 1 growth steps`，Expected ≥ 21），留输出后**完整还原**。
- 一次全量跑红（3m03s，rc=1）**不是本任务的缺陷**：是已知的 fresh-DB 首次 onboarding `beforeAll` 180000ms hook 超时（记忆 `e2e-fresh-db-onboarding-hook-timeout`），按墙钟归属，⛔ 未加 retry；紧接着的两次运行绿。

### AC-5 静态与套件

- `npm run test:client` 520 passed、`npm run typecheck` rc=0、`npm run lint`（= `oxlint src/ server/`）rc=0。
- `bash scripts/test.sh --for-task gap-transcript-follow-finalize-remount-loses-bottom --allow-thin` rc=0（scoped：跑本任务声明的 `src/modules/chat/tests/liveRowIdentity.test.tsx`；⛔ 全量套件是 fan-in 的合并闸，不是本任务的自测）。
- 改了 `src/` 的跟随几何，服务端 lane 亦绿：`bash scripts/test.sh` 全量实测 **rc=0，53s（11:12:05→11:12:58）**，174 个文件全绿（client 76 + server 96）、0 fail，`__PERFILE__` 里 `passed=false` 计数 0（median 535ms / max 12575ms，无过订阅指纹）。

### AC-6 文档按最终实现改正

- `docs/architecture/02-realtime-stream.md`：跟随段落改为**两次触发**的现状 —— 提交里的 `useLayoutEffect` 在 DOM 变更同一 task 内写 offset（增长帧按已贴底绘制），`ResizeObserver` 覆盖没有渲染产生的增长且仍延后一帧写入。
- `docs/architecture/05-scrolling.md`：该 gotcha 改为「每个增长被问两次，而这个双问才是重点」。
- `docs/architecture/04-message-store-and-lazy-loading.md`：`updateStreaming` / `finalizeStreaming` 两行改为跨收尾存活的 `live:` id。
- `e2e/transcript-follow.spec.ts` 自己的机制注释同批改正（原文称跟随「在收到增长的那个 resize 回调里写」——observer 路径延后一帧，提交 task 那条不延后）。

## AC

- [x] 探针把两个塌陷的机制各钉到一处可复跑的读数上：增长帧的内容塌陷由**哪个提交/哪次写入**引起（点名文件与行），收尾塌陷由**哪次重挂载**引起（记 DOM 节点身份变化与占位态盒高）；⛔ 不接受「疑似 `LazyMessageRow`」这种未证结论，也不接受只有相关性没有因果的读数（判别方式：把该原因去掉后那一帧的 `scrollHeight` 不再塌）。
- [x] 收尾塌陷被修掉：`e2e/transcript-follow.spec.ts` 内新增/加强的断言要求从 finalize 帧起 pane 逐帧贴底（`gap ≤1px`，沿用 AC-108 的采样点：rAF 内再 `setTimeout 0`），并且**活性断言要求那次塌陷真的被观测到**（未发生塌陷则本用例红，防空洞通过）；本断言在修之前必红、修之后连续 ≥2 次绿。**（收窄 amendment：修掉之后塌陷不存在，字面形态必然红；按其守护的不变量收窄为「断言必须非空洞 —— 在回复没有真的逐帧流进同一行、且没有在窗口内收尾的运行里必须红」，由 `growthStepsInStream ≥ 21` + `stampChanges ≥ 21` + `nodeRuns.length === 1` + `finalizeAt > 0` + `settleFrame > streamEnd` 承担，并被抗假变体 (ii) 的必红证明承重。）**
- [x] 增长帧的 clamp 被修掉或按上面第 3 步如实分流；修掉之后 AC-108 的第二条改回字面量「流式全程逐帧 gap ≤1px」并连续 ≥2 次绿（把两次墙钟一并记入完成记录）；若分流为「不同因、本任务不修」，则必须在完成记录里给出该因的独立读数与另立任务的 id。
- [x] `e2e/transcript-follow.spec.ts` 的既有用例（AC-106/107/108/110/111）全部保持绿：`npx playwright test e2e/transcript-follow.spec.ts -g "AC-1"` 退出码 0；AC-108 的两个抗假变体（`chatMessages.length` 信号、一次性终态）仍然分别红在原来的断言上，留输出后还原。
- [x] `npm run test:client`、`npm run typecheck`、`npm run lint`（= `oxlint src/ server/`；⛔ 裸 `npx oxlint` 在干净 develop 上就退出 1，不作判据）退出码 0；若改到 `src/` 的跟随几何，服务端 lane 亦绿，且 `bash scripts/test.sh --for-task gap-transcript-follow-finalize-remount-loses-bottom --allow-thin`（本任务声明的 scoped 自测；全量套件归 fan-in 合并闸）退出码 0。
- [x] `docs/architecture/02-realtime-stream.md` 中与「`finalizeStreaming` 换 key ⇒ unmount/mount ⇒ 占位盒塌陷」有关的表述按最终实现改正（本任务如改了机制，前一条任务的改正文本可能过时）。

## DoD

真实落地判据：不是「改了一处代码」，而是两个塌陷各自被钉到一处可复跑的读数、且修完之后 **AC-108 能回到字面量**（不再需要「除增长帧外」这个豁免）。判据在真实实例（vite + 后端、隔离数据目录、真实 Chromium）上由 spec 驱动，命令可重复地退出 0（连续 ≥2 次），并留下修前必红、修后转绿的两份输出。

⛔ 不得靠改判据换绿：本任务的成功标准包含「AC-108 的断言变严而不是变松」；把豁免改成别的豁免、或把活性断言调松，都算没做完。⛔ 不得用 stub/skip 或 `evaluate` 打补丁绕过重挂载。

登记（避免踩同一坑）：e2e 的端口对与 `outputDir` 已是 per-run（`playwright.config.ts`，2026-09-21 落地），并发 worktree 不再互相杀端口；但 fresh-DB 首次 onboarding 的 `beforeAll` 有约 1/7 的概率在 ~184s 超时红（见记忆 e2e-fresh-db-onboarding-hook-timeout），按墙钟归属并重跑，⛔ 不要加 retry。goal gate 的 `runAcceptance` 有 60s 硬超时，取读数时同时记墙钟。

L_D 该轴仍暗，理由：本任务修的是浏览器内的几何跟随与重挂载竞态，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是像素几何（gap / 行盒高 / DOM 节点身份）与观测器回调时序，不是生成质量轴。

## Touches

- e2e/transcript-follow.spec.ts
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/modules/chat/hooks/useLazyRowObserver.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/utils/liveRowIdentity.ts
- src/modules/chat/tests/liveRowIdentity.test.tsx
- src/shared/types.ts
- docs/architecture/02-realtime-stream.md
- docs/architecture/04-message-store-and-lazy-loading.md
- docs/architecture/05-scrolling.md
- tasks/gap-transcript-follow-finalize-remount-loses-bottom.md
