---
id: transcript-scrub-live-follow-and-continuous-thumb
title: AC-218 拖动滚动条时页面逐帧跟随、松手即落定、滑块连续移动：去掉 220ms 静止等待与 150ms
  固定定时器，窗口内直接滚动，窗口外按最新位置优先取页
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on: []
goal_ac: AC-218
---
## Proposal

用户反馈（2026-10-04）：当前滚动条很卡，拖动时会显示提示，但页面不会持续滚动，要放开鼠标才会跳过去。实测（隔离 e2e 实例、1200 轮 / 2596 行夹具、机器负载约 11、每场景一次；探针是临时的，已删除，读数记录在 AC-218 的 origin 与本节）：

1. **拖动期间页面不动。** 4 次拖动（各 30 步加 500ms 按住）里 `scrollTop` 变化 0 次、取页 0 次。这是 AC-214 (d) 原先的设计（「拖动期间取页 ≤1」），现已由人 yale 同意改写为「允许拖动中取页，但同一时刻只有一个在途」。
2. **松手后的延迟几乎全是自加的等待。** 以 pointerup 为 0：取页请求在 221ms 才发出（`TranscriptScrollbar.tsx` 的 `DRAG_COMMIT_PAUSE_MS = 220`）；请求只花 5–6ms（缓存命中，`around=…&before=40&after=40`）；目标行进 DOM 约 255ms；位置在 384–394ms 才落定（`useChatSessionState.ts` 的 `jumpToMessage` 在窗口落地后又排了固定 150ms 的 `setTimeout` 才第一次找目标并写 `scrollTop`，找不到再每 150ms 轮询）。约 390ms 里约 370ms 是等待，真正的加载加提交只有约 35ms。
3. **窗口内的小幅拖动也走网络。** 拖约 14 个轮次（目标本来就在已加载窗口里）仍发起一次 `around` 取页，约 480ms 落定。
4. **滑块在正常滚动时是阶梯式的。** 30 次滚轮共 152 帧，`scrollTop` 在 104 帧里变化，滑块只在 30 帧里变化（约 29%）；页面滚了 4569px，滑块只走了轨道的 2.5%。原因是滑块位置取自 `currentTurnId`（视口顶上最后一个用户轮次），轮次不变滑块就不动。
5. **松手后多出一次未解释的取页。** 5 个读数里第一次拖动松手后只有 1 次 `/messages` 请求，后三次各有 2 次，第二次的 URL 探针没记录。
6. 每帧开销在这个规模下不是瓶颈（帧间隔 p50 18.3ms、p95 22.6ms，每帧约 30 次 getBoundingClientRect），但读数随窗口行数线性增长（`useTurnNavigation` 每个滚动帧遍历全部带 anchor 的行并逐个读矩形；`turnAtFraction` 每次 pointermove 线性扫描全部轮次）。

要做的事（顺序即实施顺序）：

**A. 查明第 5 条。** 先把松手后的全部 `/messages` 请求 URL 记下来（在 AC-218 的 spec 里就带这个读数），找出第二次请求的来源；若来自跳转链路就去掉，若是合法的尾部刷新则确认它不由 `jumpToMessage` 发出。结论写进任务证据。

**B. 位置映射改成连续（纯函数，便于单测）。** 新增 `src/modules/chat/utils/scrollOrdinalMap.ts`：输入当前窗口里各用户轮次行的（绝对消息序号，行顶部像素），以及容器 scrollTop/clientHeight，输出当前位置的连续序号比例（相邻两个轮次行之间按像素线性插值，所以长轮次内部也是连续的）；反函数：给定比例，若落在已加载窗口内则返回应写入的 scrollTop，否则返回 null。滑块位置改用这个连续比例（rAF 节流、只用 `transform` 定位，不再同时改 `top`），不再取自 `currentTurnId` 的轮次序。

**C. 拖动时内容逐帧跟随。**
- 窗口内：pointermove → 比例 → `scrollOrdinalMap` 反函数 → 每帧用已有的 `writeScrollTop` 通道写 `scrollTop`（不得直接写 `container.scrollTop`）；拖动期间设「拖动中」标记，让贴底跟随、锚点恢复、懒挂载的占位高度变化不与之打架（照 `jumpToMessage` 里 `searchScrollActiveRef` 的做法）。窗口内拖动不发取页。
- 窗口外：在 store 里新增按最新位置优先的取页：同一时刻最多一个 `loadWindowAround` 在途；落地时若已有更新的目标就丢弃该窗口并立即为最新位置发下一个；落地的窗口对应最新位置时才应用；客户端缓存最近几个窗口（上限 4，按窗口起点索引），来回拖动时直接命中。拖动期间滑块始终以指针为准，内容去追它，不得反向拉动滑块。
- 松手：立即提交（去掉 `DRAG_COMMIT_PAUSE_MS` 的静止等待，键盘步进仍保留短去抖）。

**D. 缩短 `jumpToMessage` 的定位延迟。** 去掉窗口落地后的固定 150ms `setTimeout`；窗口提交后在 layout effect（或 rAF）里定位，找不到目标再按 rAF 重试而不是 150ms 步进。

**E. 降低每帧开销。** 当前轮次的计算改用二分（行按文档顺序，顶部单调），每帧只读 O(log n) 次矩形；`turnAtFraction` 用二分代替线性扫描。

不在本任务内：窗口体积与服务端缓存的真实会话负载测量（夹具消息体很短、缓存是热的，5–6ms 不能当通用值）、预取与每页大小（AC-216 已落地）。

## Plan

1. 先写判据：新建 `e2e/transcript-scrub-smooth.spec.ts`（用例标题含 `AC-218`，用共用种子 `e2e-transcript-jump`），按 AC-218 的 (a)–(f) 读数；改写 `e2e/transcript-global-scrollbar.spec.ts` 里 AC-214 的两个用例标题 `AC-214 v2` → `AC-214 v3` 并把 (d) 改成「允许拖动中取页但同一时刻只有一个在途、不应用过期窗口」。先看两者红。埋点用页内 `performance.now()`（pointerup 时刻、fetch 日志的起止、rAF 采样），不用墙钟；可参照 `/tmp/zz-probe-scrub.spec.ts.keep`（若已不在，按 AC-218 expect 重写）。
2. 做第 A 步，把第二次取页的来源查出来。
3. 纯函数与单测：`scrollOrdinalMap.ts` 加 `src/modules/chat/tests/scrollOrdinalMap.test.ts (new)`（覆盖轮次内插值连续、两端夹取、目标在窗口外返回 null、行高被测量修正后比例不跳）；latest-wins 取页器的单测 `src/modules/chat/tests/scrubWindowLoader.test.ts (new)`（并发在途 ≤1、过期窗口被丢弃、LRU 命中不发请求）。
4. 实现 B、C、D、E；`TranscriptScrollbar` 与 `useTurnNavigation` 接新映射；`useSessionStore` 增加 latest-wins 取页与窗口缓存；`useChatSessionState` 的 `jumpToMessage` 去掉固定定时器并暴露拖动用的滚动写入口。
5. 跑守卫：AC-214 v3、AC-218、AC-213 v2、AC-215、AC-216、AC-217、`transcript-follow` 全部绿；把改动前后的 AC-218 读数并排写进证据。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-scrub-smooth.spec.ts -g "AC-218"` 退出 0（run25：1 passed）。读数：(a) 拖动期间 `scrollTop` 变化 106 帧，起 250ms 后滑块与内容位置差 ≤3% 的采样帧 175/175（share 1.0），拖动帧间隔 p95 31.2ms；(b) 拖动期间两两 `/messages` 区间不重叠、松手后为最终位置只发 ≤1 次读；(c) 远距 5 次松手到落定 `[117,75,20,15,62]` p95 117ms ≤150；(d) 窗口内拖动取页 0、松手到落定 0ms ≤100；(e) 滚轮段 94 个 `scrollTop` 变化帧中内容真正移动 30 帧（其余 63 帧是该行惰性挂载导致的滚动锚定：Δ偏移 = Δ内容高，内容没动、滑块也不应动），滑块在 30/30 移动（≥90%），相邻帧跳变 ≤0.5%，随上滚单调不增；(f) 轮滚动帧间隔 p95 ≤33ms。
- [x] AC2 改写后的 AC-214 判据绿：`npx playwright test e2e/transcript-global-scrollbar.spec.ts` 退出 0（3 passed，含 `AC-214 v3`、`AC-214 v3 (f)`、`AC-215`）。(d) 已改为「允许拖动中取页但同一时刻只有一个在途、不应用过期窗口」：实测拖动期间请求区间无重叠、最后一条读就是落定窗口、松手后 ≤1 次读。
- [x] AC3 既有守卫：`AC-213 v2`、`AC-215`、`AC-216`、`AC-217` 均退出 0（一次合并运行 12 passed / 1 failed）。`e2e/transcript-follow.spec.ts` 全文件运行 6 passed / 1 failed，失败用例 `a whole row arriving while pinned...` 是夹具前置断言（注入行首帧高度 240px 未超过视口 460px）；在 develop（`e5d21814^`）上以同一文件跑同一用例也失败（1 failed / 6 passed，同族断言），属既有夹具/时序红，与本改动无关；该用例单独 `-g` 运行退出 0。
- [x] AC4 取假形态（先提交实现 `e5d21814` 再变异，每条变异后 `git checkout e5d21814 -- src/modules/chat` 恢复）：(a) 松手加 220ms 静止等待 ⇒ AC-218 (c) 红（`settleFar [344,301,238,230,271]` p95 344 > 150）；(b) 拖动期间不写 `scrollTop` ⇒ AC-218 (a) 红（agreeing 80/127 = 0.63 < 0.9）；(c) 每个 pointermove 额外发一次未入队的读 ⇒ AC-218 (b) 在途重叠红（相邻两读区间重叠，如 7868.9–7882.8 与 7869.9–7882.8）；(d) 与 (c) 同一并发机制（先发请求可晚落地覆盖后发窗口），(b) 的过期窗口读法同样红；完全串行的“先发后落地”需绕过 store 的 `enqueueHistoryMutation`——该队列本身即串行保证。(e) 滑块改回 `currentTurnId` 轮次序 ⇒ AC-218 (e) 红（thumbMoving 0/30 < 0.9，distinctProgress 31）；(f) 窗口内拖动仍发取页（绕过 loader 缓存）⇒ 判据红（该变异同时把远距拖动打成读风暴，红在 (a)：judged 0；判据 (d) 的 `nudgeFetches === 0` 读法同样会红）；(g) 松手保留 150ms 固定定时器（本实现的松手已不走 `jumpToMessage`，故等价地延迟放位 150ms）⇒ AC-218 (c) 红（`settleFar [239,215,153,155,212]` p95 239 > 150）。
- [x] AC5 单测绿：`npx vitest run src/modules/chat/tests/scrollOrdinalMap.test.ts src/modules/chat/tests/scrubWindowLoader.test.ts` 退出 0（19 tests passed），含轮次内插值连续、两端夹取、窗口外 covered=false、行高修正/预置不跳、latest-wins 单飞、过期丢弃、LRU 命中不发请求。
- [x] AC6 第 A 步结论：松手后多余的一条 `/messages` 是无 `around` 的 `offset` 尾页（来自 `requestLatestMessages`/`loadOlderMessages` 的尾部刷新），不是跳转链路发出的；现由 `searchScrollActiveRef` 在拖动/跳转中抑制这三处（`requestLatestMessages`、`loadOlderMessages`、`loadNewerMessages`）。松手只为最终位置发一次 `around` 读，AC-218 (b) 的「松手后取页 ≤1」为绿。
- [x] AC7 `npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条一致（新增文件已用 ASCII `(new)`）。

## DoD

- 判据在真实浏览器里用真实鼠标对真实服务运行，读数全部来自页内埋点的 `performance.now()` 与 fetch 日志，不用墙钟；在负载下不放宽阈值（若负载导致假红，按仓库记录处理，不改阈值）。
- 拖动期间内容逐帧跟随滑块；窗口内拖动零取页；窗口外同一时刻最多一个取页在途，且不应用过期窗口。
- 松手到落定 p95 ≤150ms（窗口内 ≤100ms）；滑块在 ≥90% 的滚动帧里移动，相邻帧跳变 ≤0.5% 轨道长度。
- 所有滚动写入走 `writeScrollTop` 通道，没有直接写 `container.scrollTop`；`jumpToMessage` 仍是搜索与导航共用的唯一跳转。
- 前后读数并排写进证据（拖动期间 scrollTop 变化帧数、松手到落定、滑块变化帧占比、每帧矩形读取次数）。
- 新增的测试文件对其他模块只经其 barrel 导入（oxlint `boundaries/dependencies`）；遵守 `frontend-module-standards`（`@/` 导入、`type` 不用 `interface`、`import type`、导出带消费方注释）；若实现被迫写 `## Touches` 之外的文件，先用 task_write 把它加进 Touches 再写。

## Touches

- src/modules/chat/transcript/TranscriptScrollbar.tsx
- src/modules/chat/hooks/useTurnNavigation.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/utils/scrollOrdinalMap.ts (new)
- src/modules/chat/utils/scrubWindowLoader.ts (new)
- src/modules/chat/context/TranscriptScrubContext.ts (new)
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/scrollOrdinalMap.test.ts (new)
- src/modules/chat/tests/scrubWindowLoader.test.ts (new)
- e2e/transcript-scrub-smooth.spec.ts (new)
- e2e/transcript-global-scrollbar.spec.ts
- tasks/transcript-scrub-live-follow-and-continuous-thumb.md
