---
id: gap-transcript-follow-small-gesture-detaches
title: 流式期间向上的小幅手势（<50px 阈值）与键盘 PageUp 立即脱离跟随且不被拉回，按钮可回到跟随（AC-109 判据
  e2e/transcript-follow.spec.ts 由红转绿）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-transcript-follow-on-content-resize
  - gap-transcript-follow-on-real-stream
goal_ac: AC-109
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提；显式前驱只有 frontmatter 里声明的 `gap-transcript-follow-on-content-resize`（AC-106）与 `gap-transcript-follow-on-real-stream`（AC-108）两条）：`e2e/transcript-follow.spec.ts` 这条判据仪器由 [[gap-transcript-follow-on-content-resize]]（AC-106）建立——`playwright.config.ts` 里服务器启动前播种的长 transcript、手势到位的约定、「布局与 ResizeObserver 回调之后再采样」的约定、以及把「贴底」的触发从 React 信号（`chatMessages.length`）换成**内容几何**；慢速流式夹具（mock gateway 按请求体选中内容请求、SSE 吐 ≥20 个 delta 跨 ≥5s）由 [[gap-transcript-follow-on-real-stream]]（AC-108）建立。本条判据的 `-g "AC-109"` 跑的是同一个文件，四族任务（106/107/108/109）Touches 重叠，由池的 disjointness 门自动串行，不需要人工再串一条链；e2e 工具链本身与登录后置锚点约定出自 gap-session-filter-real-browser-e2e（done）与 gap-e2e-onboarding-anchor-seeded-transcripts（done），本任务不重复申领。

### 现状（2026-09-21 源码核对）

判据表层红因与同族三条相同：`e2e/transcript-follow.spec.ts` 不存在，playwright 报 No tests found（红先行）。但本条的红因是**另一个机制**，**不会被 AC-106/107/108 修好**：

1. 脱离跟随今天只有一个判据——**距底阈值**。`src/modules/chat/hooks/useChatSessionState.ts:454-459` 的 `isNearBottom()` 是 `scrollHeight - scrollTop - clientHeight < 50`，`handleScroll`（`:521-560`）无条件 `setIsUserScrolledUp(!nearBottom)`。⇒ 流式进行中向上 `mouse.wheel` 只要 `deltaY` 绝对值小于 50，gap 仍 < 50，仍被判为「贴底」⇒ `ChatInterface.tsx:484` 的按钮不出现，而且 AC-106 落地后的几何 pin 会把这一行**拉回底部**。AC 明写的取假形态（「沿用单一 50px 距底阈值判定脱离、并在增长时 pin」）就是今天的行为。
2. 意图信号只挂了 wheel/touchmove 两个输入源：`ChatInterface.tsx:435-436` 把 `onWheel={handleScroll}`、`onTouchMove={handleScroll}` 接到 `ChatMessagesPane.tsx:171-172` 的滚动容器上；另有一处原生 `container.addEventListener('scroll', handleScroll)`（`useChatSessionState.ts:1003-1007`）。键盘滚动（PageUp/PageDown/方向键/Home/End）不产生 wheel/touch，只产生 scroll 事件；今天它之所以「也许能过」完全是因为 scroll 监听里那条 `!nearBottom` 的位置判定恰好也被遍历到。一旦实现按本条需求字面上最自然的读法改成「wheel/touchmove 才算用户手势」（在容器上挂 `onWheel`/`onTouchMove` 意图监听），键盘半立刻红——AC 的第二条取假形态就是钉这个，因此实现**必须**把键盘滚动键也算作意图来源（容器需可聚焦）。
3. 「脱离之后零次程序写入 scrollTop」今天是**不可能成立**的：置位 `isUserScrolledUp` 之后仍有若干写入者不受「用户已离开」约束——`:618-660` 的初始滚动 rAF 循环、`:563-589` 的 follow effect（`chatMessages.length` 变化即写）、`:988-1001` 的 `setTimeout(scrollToBottom, 50)`（门是 `!isUserScrolledUp`，但 50ms 后重读 ref 是竞态窗口）、`:811-817` 的 200ms 外部刷新回写。且流结束时的 finalize 用固定 id 行换真实行、会改变 `chatMessages.length`，从而触发 follow effect ⇒ 又写一次。

⇒ 本条要落地的机制：**把「是否跟随」从几何距离改判为用户意图**——任何**用户滚动输入**（wheel / touchmove / 键盘滚动键）只要把 scrollTop 向上移动，就**立即**脱离（无论 gap 是否 < 50）；这个脱离是**粘性**的：内容增长、几何 pin、finalize、外部刷新都不得把它拉回；只有用户自己回到贴底（gap ≤ 阈值）或点按钮，才重新跟随。程序写入（pin 自己）不得被当成用户意图——反方向那条由 AC-111 承载，本条只需**不破坏**它。

### 方案

**A. `src/modules/chat/hooks/useChatSessionState.ts`：把脱离判据换成意图驱动**

1. 意图来源接全：(i) `wheel`、(ii) `touchmove`、(iii) 键盘滚动键（`keydown` 的 PageUp/PageDown/ArrowUp/ArrowDown/Home/End）、(iv) 既有的原生 `scroll` 监听（用于「用户自己滚回底部」时按 `gap ≤ 阈值` 重新跟随）。
2. `handleScroll` 里的 `setIsUserScrolledUp(!nearBottom)` 改成三态规则：向上移动且来源是用户输入 ⇒ 一律置 `true`（**不再看 50px**）；向下移动且 `gap < 阈值` ⇒ 置 `false`（重新跟随）；pin 自身的程序写入 ⇒ 不改意图（用一个「正在程序写入」的 ref 门住，或用 rAF 内的一次性抑制标记）。`isUserScrolledUp` 这个名字与既有消费者（按钮、follow effect、两个延时定时器、`scrollPositionRef` 恢复）保持不变，改的只是**判定规则**，把影响面压到最小。
3. 粘性：`isUserScrolledUp` 为真时，`:563-589` 的 follow effect、`:988-1001` 的 50ms 定时器、`:811-817` 的 200ms 回写、以及 AC-106 新加的几何 pin 一律不写 scrollTop；finalize 导致的 `chatMessages.length` 变化同样不得拉回。⛔ 不得反过来置位/清位 `isUserScrolledUp`，也不得让新逻辑触发 `loadOlderMessages`。
4. `scrollToBottomAndReset`（按钮 onClick）保持既有语义：置回跟随并滚到底，点击后按钮隐藏。
5. 不得改动 `pendingScrollRestore`（会话切换/分页恢复）、搜索跳转、`loadOlderMessages`、`scrolledNearTop < 100` 的既有行为。

**B. `src/modules/chat/transcript/ChatMessagesPane.tsx` + `src/modules/chat/ChatInterface.tsx`：把意图来源接全**

- 滚动容器加 `tabIndex={-1}`（可编程聚焦，PageUp 才会滚动它自己）；新增 `onKeyDown`（或等价的原生 `keydown` 监听）prop，由 `ChatInterface.tsx` 传入键盘滚动键处理；保留既有的 `onWheel`/`onTouchMove`。⛔ 不得只加 wheel/touchmove 而不加键盘路径——那正是取假形态 2。

**C. 判据 spec（`e2e/transcript-follow.spec.ts` 内新增一条用例，标题必须含字面量 `AC-109` 以便 `-g "AC-109"` 选中）**

- 夹具同 AC-108：mock gateway 按**请求体**选中内容请求（SDK 起标题的请求走同一 base URL，不得按 URL 选），以 SSE 慢速吐 ≥20 个 `content_block_delta`、整段 ≥5s；经真实 UI 发送一条消息（⛔ 不得 stub 后端、不得 evaluate 改 store 冒充发送）；用**用户手势** `page.mouse.wheel` 到达底部后开始采样。
- 半一（wheel）：`page.mouse.wheel(0, -30)`（|deltaY| < 50，即阈值内的手势）⇒ 从此刻到流结束（点击按钮之前）：**零次程序写入 scrollTop**、`scrollTop` 不增大（±1）、`aria-label="Scroll to bottom"` 的按钮可见。随后 `click` 按钮 ⇒ 回到底部，剩余流式期间逐帧 `gap ≤ 1px`。
- 半二（键盘）：同样的贴底开局，`pane.focus()` 后 `page.keyboard.press('PageUp')`（真实浏览器只产生 scroll 事件，无 wheel/touch，⛔ 不得派发合成的 wheel/touch）⇒ 同样三条断言成立；点按钮后同样 `gap ≤ 1px`。
- 「零次程序写入」的仪表：在页面内、手势**之前**给该容器实例装一个 `scrollTop` 的 own-property 描述符（get 转读原型描述符、set 计数并转发），原生滚动与 PageUp **不**经过 JS setter，故该计数只数程序写入；再用 rAF 采样 `scrollTop` 数值本身，防「用 `scrollTo()`/`scrollBy()`/`scrollIntoView()` 绕开 setter」——AC 的「scrollTop 不增大（±1）」是这层的断言，两层一起才封死。
- `gap = scrollHeight − scrollTop − clientHeight`，采样点必须在**布局与 ResizeObserver 回调之后**（页面内一个后注册的 ResizeObserver，或 rAF 内再 setTimeout 0）；⛔ 在 rAF 内直接读 `scrollHeight` 读到的是 pin 之前的状态，不得当作绘制态。
- 抗假变体（真跑、留输出、须还原）：(i) 把脱离改回单一 50px 距底阈值 + 增长时 pin ⇒ 半一必须红（30px 手势仍判为跟随 ⇒ 被拉回）；(ii) 意图只由 wheel/touchmove 提供、不认键盘滚动 ⇒ 半二必须红；`git diff` 证明 spec 的真实断言一条未删、未经 stub/skip。
- 登录后置锚点不得等 `Choose Your Project` 空态（播种会让该 workspace 自动成为项目），锚在真实视图里必然存在的元素（如 Settings 按钮）上。

### 非目标

- 不实现 AC-106/107/108 的语义（几何 pin、pane 变矮、真实流式帧的服务端开启与 unwrap）；不实现 AC-110/111（顶部翻页恢复、非用户输入滚动不改意图）——但**不得破坏**它们。
- 不引入 CSS 钉底技巧、不依赖浏览器 scroll anchoring。

## AC

- [x] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"` 退出码 0（真实 Chromium 打真实的 vite + 后端，隔离数据目录；不得 stub 后端、不得用 evaluate 直接改 store 或直接设 scrollTop 冒充手势），并把 wall time 记入完成记录。
- [x] 同一 spec 的 wheel 半：贴底开局、流式进行中 `page.mouse.wheel` 向上 `deltaY=-30`（|Δ| < 50px 阈值）后，到流结束（点击按钮之前）**零次程序写入 scrollTop**、`scrollTop` 不增大（±1）、`Scroll to bottom` 按钮可见；点击按钮后回到底部，剩余流式期间逐帧 `gap ≤ 1px`。
- [x] 同一 spec 的键盘半：同样贴底开局，聚焦 pane 后 `page.keyboard.press('PageUp')`（真实浏览器只产生 scroll 事件，无 wheel/touch，不得派发合成 wheel/touch）⇒ 同样三条断言成立；点按钮后同样 `gap ≤ 1px`。
- [x] 采样点在后注册 ResizeObserver 或 rAF 内 setTimeout 0（布局与 ResizeObserver 回调之后）；⛔ 不得用 rAF 内直接读 scrollHeight 当绘制态。
- [x] 抗假变体真跑并留输出后还原：(i) 单一 50px 距底阈值 + 增长时 pin ⇒ wheel 半红；(ii) 意图只认 wheel/touchmove ⇒ 键盘半红；`git diff` 证明 spec 真实断言一条未删、未经 stub/skip。
- [x] `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 新增单测（沿用其既有 `createContainer` 的 `scrollTop` 写计数仪表）：一次小幅向上的用户 scroll 输入使跟随置假，且此后内容增长/pin 产生**零次** `scrollTop` 写入；`npm run test:client` 退出码 0。
- [x] `npm run typecheck` 与 `npm run lint` 退出码 0（`npm run lint` = `oxlint src/ server/`；⛔ 裸 `npx oxlint` 在干净 develop 上就退出 1，不作为判据）。

## DoD

真实落地判据：不是 spec 文件存在，也不是某一次恰好绿。要求在真实实例（vite + 后端，隔离数据目录）上由该 spec 驱动真实浏览器走完 AC-109 全文——真实的 ≥5s 慢速流式、真实的 `mouse.wheel` 小幅向上手势、真实的 PageUp 键盘滚动、程序写入 scrollTop 的计数仪表、以及布局与 ResizeObserver 回调之后的逐帧采样——判据命令**可重复地**退出 0（连续 ≥2 次），并把两个抗假变体的红灯输出与还原证据记入完成记录；AC-109 在驱动器下一轮经 `goal_ac: AC-109` 独立核验时由红翻绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。

实现这一半必须在 `src/` 内真实落地：⛔ 不得靠 spec 里 `evaluate` 打补丁、不得靠注入脚本模拟「脱离」换绿——判别方式就是两个抗假变体必须红。⛔ 也不得把判据缩短成「按钮可见即算脱离」：程序写入计数与「scrollTop 不增大」才是「没被拉回」的实体。

⛔ 已知仪表风险，如实记录而不是谎报绿：goal gate 的 `runAcceptance` 有 60s 硬超时，而本条要跑**两段** ≥5s 的慢速流式、两个 webServer 再跑一次 Chromium（同形既有 spec 实测整条命令 14.86s，且只跑 4 个不发送的用例）。取得读数时**同时记 wall time**；若某次以「acceptance timed out」收场，那是判据仪表的读数丢失，点名它，不要把超时当绿、也不要把超时当代码缺陷。若实测逼近 60s，允许的削减手段是**夹具成本**（例如在 `beforeAll` 里经 REST 建账户/模型），⛔ 不得削减 ≥5s/≥20 delta 的下限，也不得把「经界面发送」降级成直接调 API。

登记（避免下一轮踩同一坑）：e2e 端口 47101/47173 写死在 `playwright.config.ts`，并发 worktree 的 e2e 会撞死端口，取得读数前先确认端口空闲（`ss -ltnp | grep -E '47101|47173'`）；同一 checkout 内并发跑 playwright 还会因共享 `test-results/` 产生确定性 trace ENOENT，请在**安静窗口**取读数。`scripts/test.sh` 的 scoped 门对 `e2e/*.spec.ts` 判 thin，照常跑判据命令、`npm run test:client`、`npm run typecheck`、`npm run lint`。

L_D 该轴仍暗，理由：本任务只改前端滚动的意图判定与新增一条浏览器判据，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器里的 scrollTop 写入次数与像素几何（gap），不是生成质量轴。

## 完成记录

（2026-09-21，worktree `.claude/worktrees/small-gesture-detaches`，分支 `task/gap-transcript-follow-small-gesture-detaches`，实现提交 `90393b98`）

### 判据命令与 wall time

| # | 命令 | 退出码 | wall time | 日志 |
| --- | --- | --- | --- | --- |
| 1 | `npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"` | 0 | 25.94s | `ac109-g1.log` |
| 2 | 同上 | 0 | 26.35s | `ac109-g2.log` |
| 3 | 同上（两个抗假变体还原之后，未再改任何文件） | 0 | 25.72s | `ac109-g3.log` |
| 4 | 同上 | 0 | 24.98s | `ac109-g4.log` |

连续 2 次退出 0（3、4 为最终态；1、2 为同一实现态的另一次连续两绿）。实测 24.98–26.35s，均在 goal gate `runAcceptance` 的 60s 硬超时之内，本轮未出现 `acceptance timed out`。真实 Chromium 打真实 vite + 后端；经 composer 真实发送，未 stub 后端、未用 evaluate 改动 store 或直接设 scrollTop 冒充手势。

### 两条半的读数（g1/g2 输出的 `AC-109 readings`，逐字保留）

- wheel 半：`movedUpBy=30, highestOffsetDelta=0, detachFrames=74, growthsInWindow=5, paneWrites=[], pageWrites=[], buttonVisible=true, buttonAppearancesInWindow=1, completionPresent=false, unpinned=[], settledGap=0`
- keyboard 半：`movedUpBy=434, highestOffsetDelta=0, detachFrames=74, growthsInWindow=1, paneWrites=[], pageWrites=[], buttonVisible=true, buttonAppearancesInWindow=1, completionPresent=false, unpinned=[], settledGap=0`

即两个窗口都是「零次 scrollTop 程序写入、scrollTop 不增大（±1）、按钮可见；点按钮后剩余流式逐帧 gap ≤ 1px」。采样点取自 `startAc109Sampler`：`requestAnimationFrame` 内再 `setTimeout(0)`（spec 的 1316–1330 行），即布局与该帧 ResizeObserver 回调之后。

### 抗假变体（真跑、留输出、已还原）

变体 (i)「沿用单一 50px 距底阈值判定脱离、并在增长时 pin」：把 `onScroll` 的方向判据换回 `setIsUserScrolledUp(!isNearBottom())`。退出码 1，**wheel 半红**，wall 19.03s（`variant-i.log`）：

```
Error: wheel: the control has to mount inside the window — a gesture is what takes the pane, so the control coming back is this gesture's reading and a control that was already mounted belongs to whatever happened before it
Expected: > 0
Received:   0
```

变体 (ii)「意图只由 wheel/touchmove 提供、不认键盘滚动」：把 `onKeyDown` 换成 `void event;`。退出码 1，**keyboard 半红**（wheel 半仍通过，用例在 9.4s 处红），wall 27.20s（`variant-ii.log`）：

```
Error: keyboard: the control has to mount inside the window — a gesture is what takes the pane, so the control coming back is this gesture's reading and a control that was already mounted belongs to whatever happened before it
Expected: > 0
Received:   0
```

还原证据：`grep -rn "VARIANT" src/ e2e/` 无输出；`grep -nE "test\.skip|test\.only|describe\.skip|\.only\(|xit\(|xdescribe|expect\.soft" e2e/transcript-follow.spec.ts` 无输出；spec 内 `expect(` 计数 110（断言一条未删，未经 stub/skip）；两个处理器恢复为 `const onPointerDown = (event: Event) => { if (isOverPane(event)) noteInput(); };` 与 `const onKeyDown = (event: KeyboardEvent) => { if (SCROLL_INTENT_KEYS.has(event.key)) noteInput(); };`；还原后连跑 2 次绿（上表 3、4）。

### 判据此前为何不判别：一次实现修正（诚实记录）

变体 (ii) 第一次跑**没有红**。诊断（临时页面仪表 + `AC109_DEBUG` 日志，已随还原删除）读数：keyboard 半窗口打开时按钮**已挂着**（`buttonCount=1`，窗口内零次挂载），即该半开场时 pane 已是「脱离」态——PageUp 只是在一个已脱离的 pane 上继续上移，三条断言全都不成立地通过。

根因不在判据而在实现：窗口打开前那次「发送」的 mousedown 落在**发送按钮**上（不在 pane 内），却开了 200ms 意图窗口；窗口内浏览器自身的滚动调整（视口上方某行的懒加载占位在重渲染时收缩）把 scrollTop 向上移动，被方向判据读成「用户接管」，于是刚发出去的消息不再被跟随。

修法：press / touch 只有落在 pane 内才算手势（复用既有的 `isOverPane`，与 wheel 同一判据）。修好后 keyboard 半窗口打开时按钮计数 0、窗口内出现 1 次挂载。

同时把判据本身收紧：`runAc109Window` 在手势**之前**断言按钮不在屏上（开场必须处于跟随态），并在窗口内断言**控制条至少挂载一次**（挂载是这次手势的读数，提前挂着的属于上一次状态）。上面两个变体的红灯就落在这一条上。

### 顺手修掉的判据缺陷

keyboard 半初次红在 `toContainText("AC109KEYDONE")`：在恢复会话的请求体里从前向后 `find` 提示标记会命中**上一轮**的标记（实测该请求体里 `AC109WHEELPROMPT` 在偏移 704、`AC109KEYPROMPT` 在 22240），键盘半因此永远等不到自己的完成标记。改为取**最后一次**出现的标记（`lastIndexOf` 最大者）。

### 单元判据与三个门

- `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 新增 `refuses a deferred placement once the pane has moved up, before any report says so`：先由 `scrollToBottom()` 落底并断言只写一次；再让 pane 上移 30px（不经过任何报告）——在意图仍读作「跟随」的前提下，`scrollToBottom()` **零写入**。
- `npm run test:client`：76 files / 523 tests 全绿，退出码 0。
- `npm run typecheck` 退出码 0；`npm run lint`（`oxlint src/ server/`）退出码 0。
- 额外（非 AC 要求）读数：去掉 `scrollToBottom` 的两道守卫后，上述单测确定性变红（`got [5000]`）——守卫的必要性在单测层被钉住。

### 仪表与环境

e2e 端口为每次运行 `listen(0)` 现取，读数前 `ss -ltnp` 确认 47101/47173 空闲；读数在安静窗口取得，同 checkout 无并发 playwright。

## Touches

- e2e/transcript-follow.spec.ts
- playwright.config.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- tasks/gap-transcript-follow-small-gesture-detaches.md
