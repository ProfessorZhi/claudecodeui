---
id: gap-transcript-follow-prepend-restore-not-reattaching
title: 首屏不可滚时向上翻页（prepend）的恢复不得把跟随意图导回「跟随」：原首行偏移在后续增长下稳定 ≤2px 且不被 pin 到底（AC-110
  判据 e2e/transcript-follow.spec.ts 由红转绿）
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
goal_ac: AC-110
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提；本任务 frontmatter 里显式声明的唯一前驱是 `gap-transcript-follow-on-content-resize`（AC-106））：本条的判据仪器——`e2e/transcript-follow.spec.ts` 这个文件、`playwright.config.ts` 里服务器启动前播种的长 transcript、「布局与 ResizeObserver 回调之后再采样」的约定、以及把「贴底」的触发从 React 信号（`chatMessages.length`）换成**内容几何**的那个观察器——由 [[gap-transcript-follow-on-content-resize]]（AC-106）建立，因此本条不重复申领播种与工具链；同族另外三条 [[gap-transcript-follow-on-pane-shrink]]（AC-107）、[[gap-transcript-follow-on-real-stream]]（AC-108）、[[gap-transcript-follow-small-gesture-detaches]]（AC-109）与本条 Touches 重叠，由池的 disjointness 门自动串行，不需要人工再串一条链。「非用户输入引起的滚动不改意图」的**泛化**语义由 AC-111 承载（本任务不申领，也不得写成它不可能成立）。

### 现状（2026-09-21 源码核对）

判据表层红因与同族三条相同：`e2e/transcript-follow.spec.ts` 不存在，playwright 报 No tests found（红先行）。但本条的红因是**另一个机制**，不会被 AC-106/107/108/109 修好：

1. **跟随意图今天由「距底几何」单值导出，且不区分这次 scroll 是谁引起的。** `src/modules/chat/hooks/useChatSessionState.ts:454-459` 的 `isNearBottom()` 是 `scrollHeight - scrollTop - clientHeight < 50`；`handleScroll`（`:521`）第一件事就是 `setIsUserScrolledUp(!nearBottom)`（`:527`）——**无条件**。而 `handleScroll` 同时挂在三条入口上：`ChatInterface.tsx` 传下来的 `onWheel`/`onTouchMove`、以及容器原生 `scroll` 监听（`useChatSessionState.ts:1006`）。⇒ **程序写入 scrollTop 引发的 scroll 回声会回流进这条判定**。
2. **首屏不可滚时，用户手势本身不移动 scrollTop。** `scrollHeight ≤ clientHeight` ⇒ 无滚动条 ⇒ `mouse.wheel` 不产生原生滚动。prepend 反而是 `handleScroll` 里 `scrolledNearTop = container.scrollTop < 100`（`:533`）→ `loadOlderMessages`（`:557`）触发的，与位移无关。⇒ 本条夹具里**唯一的意图信号是手势本身**，「向上移动了 scrollTop」这个信号在这一幕不存在。
3. **恢复写的是几何量，且在该夹具下必然被 clamp 到贴底。** `loadOlderMessages` 把 `captureScrollRestoreState`（`:106-122`）存进 `pendingScrollRestoreRef`（`:501`），布局 effect（`:566-589`）里执行 `container.scrollTop += nextAnchorOffset - anchorOffset`（`:576`）。首屏不可滚时 anchor 取到的是原首行、`anchorOffset ≈ 0`；prepend 后它的 offset ≈ 整页高度 `H_p`，而 scrollTop 的上限是 `H_p + H_page - clientHeight`——由 `H_page ≤ clientHeight` 得**上限 < H_p**。⇒ 这次赋值被浏览器 clamp，恢复的落点**就是数值上的底部**（`gap = 0`）。
4. **于是「离开」被几何重新导回「跟随」。** 上面那两件事合起来：恢复的回声再进 `handleScroll` ⇒ `nearBottom` 为真 ⇒ 置 `isUserScrolledUp = false`；首屏不可滚时「原 mode」本来就是「跟随」，所以这正是 AC 明写的取假形态「prepend 恢复结束后回到原 mode」。此后把视口拉到底的写入者有：`:993-999` 的 50ms 定时器（门是 `!isUserScrolledUpRef.current`，但它在 mode 翻回跟随那一刻被重新排程）、`:813` 的外部刷新回写，以及 AC-106 新加的**内容几何 pin**——「最后一行就地长高」不改 `chatMessages.length`，今天唯一会因它写 scrollTop 的就是这条几何路径。
5. **⇒ 本条要落地的机制**：一次**用户发起**的 prepend（向上翻页）必须在恢复**之前**就把意图记成「脱离」，并且这个意图**不被恢复自身的写入与 clamp 改写**；此后内容增长（含就地长高）不得移动视口，直到用户自己回到贴底或点按钮。几何量（`gap`）在这个夹具里**不可能**承担这个判定——恢复结束时它恒为 0，与「用户从未离开」不可区分；可判别的信号只有「是谁引起了这次 prepend」。

### 方案

**A. `src/modules/chat/hooks/useChatSessionState.ts`：让意图不被恢复回声重导出**

1. 向上翻页的手势（`onWheel`/`onTouchMove`/键盘滚动键进入 `handleScroll` 的那一次）**不论 scrollTop 是否移动**，都按用户意图置「脱离」（钩住 `:527` 那条唯一写点，而不是在别处另立一套状态；`isUserScrolledUp` 的名字与既有消费者——按钮、follow effect、两个延时定时器、`scrollPositionRef` 恢复——保持不变，改的只是判定规则，把影响面压到最小）。由 `handleScroll` 触发的 `loadOlderMessages` 由此天然带上「这是用户意图」的来源标记。
2. 恢复写（`:576` 的 anchor 恢复、以及被 clamp 的那次赋值）与其它**程序写入**（`scrollToBottom`、AC-106 的几何 pin、`:813` 的外部刷新回写）引发的 scroll 回声**不得**改写意图：用一个「正在程序写入」的标记门住 `:527`，或在入口处区分来源。⛔ 不得改成「比较 scrollTop 数值」来猜来源（恢复被 clamp 后数值与「用户滚到底部」完全同形）。
3. 粘性：意图为「脱离」时，follow effect（`:566-589` 的 `becameActive` 分支与 `chatMessages.length` 变化）、`:993-999` 的 50ms 定时器、`:813` 的回写、以及 AC-106 新加的几何 pin 一律不写 scrollTop；`finalize` / 外部刷新引起的行变化同样不得拉回。⛔ 不得反过来置位/清位意图，也不得让新逻辑触发 `loadOlderMessages`。
4. 既有语义保持不变：`pendingScrollRestoreRef`（会话切换/分页恢复）、搜索跳转、`loadOlderMessages`、`scrolledNearTop < 100`、`topLoadLockRef`、`scrollToBottomAndReset`（按钮 onClick 置回跟随并滚到底）一律照旧。
5. 会话切换时（`becameActive` 分支）该意图的复位与今天一致，不得让上一会话的「脱离」泄漏到下一会话。

**B. 判据 spec（`e2e/transcript-follow.spec.ts` 内新增一条用例，标题必须含字面量 `AC-110` 以便 `-g "AC-110"` 选中）**

- 夹具：`test.use({ viewport: { width: 1440, height: <高到首页 20 行不产生滚动条> } })`；种子会话（AC-106 在 `playwright.config.ts` 里 boot 前建立的那一份）需要**多于 `SESSION_MESSAGES_PAGE_SIZE`（=20）行**，使服务端 `hasMore` 为真。前置断言：`pane.scrollHeight <= pane.clientHeight`、可见 `.chat-message` 数 = 20。
- 手势与 prepend：`pane.hover()` 后 `page.mouse.wheel(0, -N)`（⛔ 不得直接调 `loadOlderMessages`、不得 evaluate 改 store、不得直接设 scrollTop），断言 prepend **真的发生**（可见 `.chat-message` 数 20 → 40，或最上方出现更早的 message id）。
- 采样：prepend 完成且恢复写已发生之后，用 message id 定位**原首行**，记 `offset0 = row.getBoundingClientRect().top - pane.getBoundingClientRect().top`；此后 2s 内让最后一行**就地长高一次**（真实 React 重渲染，⛔ 不得改 style/DOM 绕过 React），逐帧采样 offset，断言 `max|offset - offset0| ≤ 2px`；并断言期间 `scrollTop` 不增大（±1）且 `gap > 2px`（「没有被 pin 到底部」的数值化）。采样点必须在布局与 ResizeObserver 回调之后（页面内后注册的 ResizeObserver，或 rAF 内再 setTimeout 0）。
- 抗假变体（真跑、留输出、须还原）：(i) 把「恢复结束后的 mode」置回**恢复前的 mode**（首屏不可滚时即「跟随」）⇒ 本条必须红，并点名是哪个写入者把视口拉到底（几何 pin / 50ms 定时器 / 回写，逐一排除）；(ii) `git diff` 证明 spec 的真实断言一条未删、未经 stub/skip。若实测在 (i) 下「就地长高」这一形态不敏感（无任何写入者反应），必须改用一种该假形态**确实**会作用的增长（例如同一窗口内追加一行，记录该偏离）来取得红灯，⛔ 不得以「假形态不敏感」当作绿灯收场。
- 登录后置锚点不得等 `Choose Your Project` 空态（播种会让该 workspace 自动成为项目），锚在真实视图里必然存在的元素（如 Settings 按钮）上。

**C. 单测（`src/modules/chat/tests/transcriptScrollOwnership.test.tsx`）**

沿用该文件既有的 `createContainer` scrollTop 写计数仪表（`src/modules/chat/tests/transcriptScrollOwnership.test.tsx:47-64`）：构造「首屏不可滚」（`scrollHeight === clientHeight`）+ 有 hasMore 的夹具，经真实 `onWheel` 入口触发一次 prepend 与恢复写，断言 (a) 恢复写与 clamp 之后意图仍为「脱离」；(b) 此后内容增长（`scrollHeight` 增大 / `chatMessages.length` 变化）产生**零次** scrollTop 写入。

### 非目标

- 不实现 AC-106/107/108/109/111 的语义（几何 pin、pane 变矮、真实流式帧的服务端开启与 unwrap、键盘脱离、泛化的「任何程序写入不改意图」）——但**不得破坏**它们。
- 不修「恢复落点被 clamp 到贴底 ⇒ 用户翻上去后第一眼看到的仍是最新页」这个观感问题：由 `H_page ≤ clientHeight`（夹具前提，即首屏不可滚）可得恢复量的 clamp 上限严格小于所需值，**恢复在数学上必然落在底部**。⇒ 本条不可能靠「把恢复算对」通过；判别的实体只能是「此后增长是否移动视口」。若要另立观感任务，不要塞进本条。

## AC

- [x] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-110"` 退出码 0（真实 Chromium 打真实的 vite + 后端，隔离数据目录；不得 stub 后端、不得用 evaluate 直接改 store 或直接设 scrollTop 冒充手势），并把 wall time 记入完成记录。
- [x] 同一条用例内，夹具前置断言成立且由命令自身产出：`pane.scrollHeight <= pane.clientHeight`（首屏不可滚）、可见 `.chat-message` 数 = `SESSION_MESSAGES_PAGE_SIZE`（20）、服务端仍有更早的页（`hasMore`）。
- [x] 向上翻页由**真实手势**触发且 prepend 真的发生：`page.mouse.wheel` 向上后可见行数由 20 增到 40（或出现更早 message id）；⛔ 不得直接调用 `loadOlderMessages`、不得 evaluate 改 store、不得直接设 scrollTop。
- [x] 恢复完成后的 2s 窗口内（含一次经真实 React 重渲染的「最后一行就地长高」）：原首行相对 pane 顶部的偏移变化 ≤ 2px、期间 `scrollTop` 不增大（±1）、且 `gap > 2px`（未被 pin 到底部）；采样点在布局与 ResizeObserver 回调之后（⛔ 不得用 rAF 内直接读 scrollHeight 当绘制态）。
- [x] 抗假变体真跑并留输出后还原：把恢复结束后的 mode 置回「恢复前的 mode」（首屏不可滚时即「跟随」）⇒ 本条必须红，且红灯出自本条自己的断言；`git diff` 证明 spec 真实断言一条未删、未经 stub/skip。若该形态下「就地长高」不敏感，按 Proposal 的偏离条款取得红灯并把偏离记入完成记录。
- [x] `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 新增用例：恢复写与 clamp 之后意图仍为「脱离」，且此后内容增长产生**零次** scrollTop 写入；`npm run test:client` 退出码 0。
- [x] `npm run typecheck` 与 `npm run lint` 退出码 0（`npm run lint` = `oxlint src/ server/`；⛔ 裸 `npx oxlint` 在干净 develop 上就退出 1，不作为判据）。

## Touches

- e2e/transcript-follow.spec.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- tasks/gap-transcript-follow-prepend-restore-not-reattaching.md

## DoD

真实落地判据：不是 spec 文件存在，也不是某一次恰好绿。要求在真实实例（vite + 后端，隔离数据目录）上由该 spec 驱动真实浏览器走完 AC-110 全文——首屏不可滚的真实视口、真实的 `mouse.wheel` 向上翻页、真实 prepend 与它的 anchor 恢复（含被 clamp 到底部的那次赋值）、此后 2s 内一次真实的就地长高、以及布局与 ResizeObserver 回调之后的逐帧采样——判据命令**可重复地**退出 0（连续 ≥2 次），并把抗假变体的红灯输出与还原证据记入完成记录；AC-110 在驱动器下一轮经 `goal_ac: AC-110` 独立核验时由红翻绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。

实现这一半必须在 `src/` 内真实落地：⛔ 不得靠 spec 里 `evaluate` 打补丁、不得靠注入脚本模拟「脱离」或直接设 scrollTop 换绿——判别方式就是抗假变体必须红。⛔ 也不得把判据缩短成「按钮可见即算脱离」：偏移的稳定性与「scrollTop 不增大」才是「没被抢回」的实体。

⛔ 已知仪表风险，如实记录而不是谎报绿：goal gate 的 `runAcceptance` 有 60s 硬超时，而本条命令要再起两个 webServer 并跑一次 Chromium（同形既有 spec 实测整条命令 14.86s，且只跑 4 个不发送的用例）。取得读数时**同时记 wall time**；若某次以「acceptance timed out」收场，那是判据仪表的读数丢失，点名它，不要把超时当绿、也不要把超时当代码缺陷。若实测逼近 60s，允许的削减手段是夹具成本（例如在 `beforeAll` 里经 REST 建账户/模型），⛔ 不得削减前置断言或把「真实手势触发 prepend」降级成直接调用内部函数。

登记（避免下一轮踩同一坑）：e2e 端口 47101/47173 写死在 `playwright.config.ts`，并发 worktree 的 e2e 会撞死端口，取得读数前先确认端口空闲（`ss -ltnp | grep -E '47101|47173'`）；同一 checkout 内并发跑 playwright 还会因共享 `test-results/` 产生确定性 trace ENOENT，请在**安静窗口**取读数。`scripts/test.sh` 的 scoped 门对 `e2e/*.spec.ts` 判 thin，照常跑判据命令、`npm run test:client`、`npm run typecheck`、`npm run lint`。

L_D 该轴仍暗，理由：本任务只改前端滚动的意图判定与新增一条浏览器判据，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器里的像素几何（原首行 offset / gap / scrollTop 写入）与一次 prepend 的真实发生，不是生成质量轴。

## 完成记录

- 落地提交：`55dfad8b chat: keep a wheel-driven prepend detached across its own restore`。机制落在 `src/modules/chat/hooks/useChatSessionState.ts`：`programmaticScrollEchoesRef` 回声预算 + `writeScrollTop`（程序写入记一次回声额度，`onScroll` 先消费额度再谈意图）+ 输入入口 `noteInput()`（真实输入清空额度，因为此后「谁欠谁」不再成立）+ 轮子分支「`deltaY < 0` 且落在 pane 上且服务端还有更早的页 ⇒ 立刻记「脱离」」。意图的**唯一**写点与消费者（按钮、follow effect、两个延时定时器、`scrollPositionRef`）都没变，改的只是判定规则。
- AC-1 读数（可重复）：`npx playwright test e2e/transcript-follow.spec.ts -g "AC-110"` 退出码 0；用例自身 5.1s，整条命令 `real 15.5s`（另一次 `1 passed (15.0s)`）。两次读数逐字段相同，且远在 goal gate 的 60s 硬超时之内。
- 判据输出（修好后，连续两次同值）：`AC-110 readings {"viewport":{"width":1440,"height":6000},"rowsBeforePrepend":20,"rowsAfterPrepend":24,"scrollHeightBefore":5776,"scrollHeightAfterPrepend":6620,"paneClientHeight":5776,"restoreWrite":[683],"gapAfterRestorePx":179,"scrollTopAfterRestore":665,"offset0Px":485,"samples":12,"offsets":[485×12],"scrollTops":[665×12],"gaps":[299×12],"driftPx":0,"scrollTopRisePx":0,"smallestGapPx":299,"scrollWritesInWindow":[0],"downwardWritesInWindow":0}`。`scrollWritesInWindow:[0]` 是输入框自己的那一次（`fill()` 带来的），`downwardWritesInWindow:0`。
- AC-2/3/4 由命令自身产出：首屏 `scrollHeight 5776 = clientHeight 5776`（真不可滚）、可见 `.chat-message` = 20、`hasMore` 真（页面上有 "Scroll up to load more"）。`page.mouse.wheel(0,-600)` 向上后可见行 20 → 24，且最上方换成了更早的 message id —— 取 AC 里「或出现更早 message id」这一支：种子 transcript 共 24 轮、首屏 20，服务端只剩 4 行更早的页，所以不可能出现 20 → 40。此后 2s 窗口内一次真实 React 重渲染造成的增长下，原首行 offset 全程 485、`scrollTop` 全程 665、`gap` 全程 299。
- 抗假变体（真跑、留输出、已逐字节还原）：把「恢复结束后的 mode」置回「恢复前的 mode」（首屏不可滚时即「跟随」）在本夹具**等价于**把 `onWheel` 里「朝上且仍有过往页 ⇒ 记脱离」那一行短路掉（一行 `if (false && …)`）——因为这一幕里唯一的意图信号就是手势本身，短路之后 mode 从头到尾都是「跟随」，正是 AC 写的取假形态。判据 100% 红，红灯出自本条自己的 `drift ≤ 2px` 断言：`driftPx 120`、`scrollTopRisePx 120`、`smallestGapPx 0`、`gapAfterRestorePx 0`、`restoreWrite [683,6620]`、`scrollWritesInWindow [0,964,6740]`、`downwardWritesInWindow 2`。spec sha256 `7ea65cf2c0d054ca79ee85ae7d3b7f47a676afd688ac3dfd7d5db2eb905d1d56`。
- 把视口拉到底的写入者点名（按仪器记的「被赋的值」逐一排除）：`964` = `scrollHeight - clientHeight` ⇒ AC-106 的内容几何 pin（`followTranscriptGrowth`，`useChatSessionState.ts:594`）；`6740` = `container.scrollHeight` ⇒ `scrollToBottom()`（`:648`），由 `chatMessages.length` 变化后重新排程的 50ms 定时器（`:1336-1338`）触达；`0` = 输入框自身。**回写路径在本夹具被排除**：回声门吃掉了恢复自己那次 scroll 报告（mode 保持「脱离」，于是才会轮到上面两个写入者开火）；这是「逐一排除」里被去掉的那一支。`git diff` 证明 spec 的真实断言一条未删、未经 stub/skip —— 该提交里 spec 的改动只有新增用例、读数打印与四条断言。
- 记录在案的偏离：(a) 用 `page.setViewportSize({width:1440,height:6000})` 而不是 `test.use({viewport})` —— 本 spec 的 page 来自外层 `beforeAll` 建好的共享页面，`test.use` 改不了它；观感等价（首屏 20 行不产生滚动条），前置断言照旧在命令自身里产出。(b) 增长形态用「经真实 React 重渲染追加一行」（composer 里跑 `/memory` 命令）：实测在假形态下「最后一行就地长高」**单独不引任何写入者反应**（无敏感度），按 AC 的偏离条款改用该假形态确实会作用的增长，并把时钟用 `page.clock.setFixedTime(种子最后时间戳 + 1h)` 钉在种子之后，免得分页那一页的行按时间戳插进 transcript 中间（`computeMerged` 按时间戳排序）。
- AC-6：`npm run test:client` = 73 文件 / 501 用例全绿、退出码 0（7.7s）。新增单测「keeps a prepend the wheel asked for out of the follow's hands」另做了两次一行式反证并已逐字节还原（hook `sha256 131c9dee…`）：拿掉回声门 ⇒ 红在「恢复自己的 scroll 报告不得把视口交回跟随」；让 50ms 延时写入者无视意图 ⇒ 红在该条与既有「deferred scroll-to-bottom」条上（`got [7297,7297]`）。单测里还有一条**活性断言**：会话首屏那次滚到底的帧必须真的跑过（`sessionOpenWrites > 0`），否则「排空」本身什么也证明不了。
- AC-7：`npm run typecheck` 与 `npm run lint` 均退出 0（lint 只有 develop 上既有的 warning）。
