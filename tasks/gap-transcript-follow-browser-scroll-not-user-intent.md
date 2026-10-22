---
id: gap-transcript-follow-browser-scroll-not-user-intent
title: 非用户输入引起的 scroll（浏览器 anchoring/clamp）不得改变跟随意图：视口上方一行变矮 M≥200px 后就地长高
  N≥400px 仍 gap ≤1px 且按钮始终不出现（AC-111 判据 e2e/transcript-follow.spec.ts 由红转绿）
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
goal_ac: AC-111
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提；本任务 frontmatter 里显式声明的唯一前驱是 `gap-transcript-follow-on-content-resize`（AC-106））：本条的判据仪器——`e2e/transcript-follow.spec.ts` 这个文件、`playwright.config.ts` 里服务器**启动前**播种的长 transcript、「手势到位」与「布局与 ResizeObserver 回调之后再采样」的约定、以及把「贴底」的触发从 React 信号（`chatMessages.length`）换成**内容几何**的那个观察器——由 [[gap-transcript-follow-on-content-resize]]（AC-106）建立。同族四条 [[gap-transcript-follow-on-pane-shrink]]（AC-107）、[[gap-transcript-follow-on-real-stream]]（AC-108）、[[gap-transcript-follow-small-gesture-detaches]]（AC-109）、[[gap-transcript-follow-prepend-restore-not-reattaching]]（AC-110）与本条 Touches 重叠，由池的 disjointness 门自动串行，不需要人工再串一条链。
语义分工：AC-109 承载「用户滚动输入（wheel / touchmove / 键盘滚动键）⇒ 立即脱离」的那半边；本条承载它的**逆命题与泛化**——只有真实用户输入才算意图证据，浏览器自己产生的 scroll（scroll anchoring / clamp）**不得**改变跟随意图。AC-110 已在自己的 dedup-ref 里把这条泛化语义让给本条（「不得写成它不可能成立」）。

### 现象（2026-09-21 源码核对 + AC 记录里的实测）

- `src/modules/chat/hooks/useChatSessionState.ts:521-560` 的 `handleScroll` 把**每一个** `scroll` 事件都当成意图证据：`setIsUserScrolledUp(!nearBottom)`。浏览器在内容上方一行的盒子变矮时自己产生的 scroll（scroll anchoring 或 clamp）与用户手势走的是同一条路径，代码里没有任何**按来源**区分的判据。
- 跟随的触发仍是 React 信号：同文件 563-589 行的 `useLayoutEffect` 依赖 `[chatMessages.length, isActive, isUserScrolledUp]`。改变行高不改变条数，所以即使意图没被破坏也不会重贴底——本条判据要求的「就地长高 N≥400px 后 gap ≤1px」必须由 AC-106 建立的几何观察器提供。
- 按钮的可见条件是 `isUserScrolledUp && chatMessages.length > 0`（`src/modules/chat/ChatInterface.tsx:486`），所以「按钮始终不出现」等价于「`isUserScrolledUp` 在整个窗口里从未变为 true」——这是一条可直接采样的机械读数。
- 当前必红的**表层**原因与同族各条相同：`e2e/transcript-follow.spec.ts` 不存在，playwright 报 No tests found（红先行），AC 记录 origin 里写明的就是这一条。

### 场景（AC-111 的 expect，判据就按它写）

真实浏览器；用**手势**贴底（gap=0）；此后**不产生任何输入事件**，直接改 DOM 让视口**上方**的一行变矮 M≥200px——浏览器的 scroll anchoring 或 clamp 会因此改变 scrollTop 并派发 scroll 事件；随后让最后一行**就地**长高 N≥400px。断言：gap ≤ 1px，且「Scroll to bottom」按钮始终不出现。

### 方案

1. **意图只由真实输入产生**：`wheel` / `touchstart` / `touchmove` / 键盘滚动键（以及显式点按钮）是唯一的「用户要离开 / 要回到」证据源。裸 `scroll` 事件**不得**作为意图证据，无论方向与 delta——浏览器自己的 anchoring / clamp 走的正是这条路径。判别依据是**来源**（是否真输入），不是**差值**（scrollTop 是否变小）。
2. **抗假形态（AC 已点名）**：把实现写成「任何非本程序写入的 scroll 事件，只要 scrollTop 变小就判为用户向上并脱离」⇒ 本条必须红。红点有两处可采、两个都要留在输出里：贴底半的 gap ≈ N（意图被误判为脱离后那次长高不再被 pin），以及按钮在收缩瞬间出现（`isUserScrolledUp` 变 true）。
3. **pin 的判定用意图状态、不用现测 gap**：收缩瞬间的 gap 已被浏览器改成偏离值，回调里现测必然判成「已离开底部」而放弃写入（AC-107 方案里 ⛔ 记过同一个坑）。判定唯一依据是 `isUserScrolledUpRef`（同文件 227 行定义、436 行镜像）。
4. 不改变既有语义：`pendingScrollRestoreRef`（会话切换 / 分页恢复）、`nearBottom < 50`、搜索跳转、`handleScroll` 里的 `loadOlderMessages`、程序写入与 pin 的既有约定一律保持；观察器在会话切换与组件卸载时 disconnect；pin 不得反过来置位 / 清位 `isUserScrolledUp`。
5. 夹具复用 AC-106 在 `playwright.config.ts` 里、服务器**启动前**、仅在 `isDataDirOwner` 进程种下的那份长 transcript，本条**不**重新播种（测试运行中写入会被 watcher 捕获并逐个广播 session_upserted，把会话标成「需关注」导致随机红）。

### 判据 spec（`e2e/transcript-follow.spec.ts` 内新增，用例标题必须含字面量 AC-111）

- 打开该会话（经侧边栏会话行，不直接操纵 store），`page.setViewportSize` 到 1440×900，用**手势** `page.mouse.wheel` 到达底部（⛔ 不得用 evaluate 直接设 scrollTop 冒充手势）。此后到断言结束**不得**再产生任何 wheel / touch / 键盘事件。
- **变矮半**：选一行使其盒子变化会让 `scrollHeight` 变小到浏览器必须改 `scrollTop`（视口上方最省事；在视口内也可以，只要能证明锚定/夹取真的动了 scrollTop），直接改 DOM 让它矮 M≥200px（改行高或把内容换成短块，必须是真实盒模型变化；⛔ 不得靠 `overflow-anchor: none` 之类的旁路开关把浏览器自己的 scroll 关掉来回避场景）。**先证明这次改动真的引发了浏览器自己的 scroll**：页面内捕获阶段 `scroll` 监听器把事件写入 `window.__scrollEvents`，变矮后断言其增量 ≥1——若为 0，说明场景是空的（浏览器根本没动），本条必须红而不是假绿。同时用 `page.addInitScript` 包裹 `Element.prototype.scrollTop` 的 setter（保留原 descriptor，只追加 `{ t, value }` 到 `window.__scrollWrites`，**只计数、不改语义**）证明这一段**程序写入增量为 0**：scrollTop 的改变只能来自浏览器自己。
- **贴底半**：让最后一行**就地**长高 N≥400px；采样点必须在**布局与 ResizeObserver 回调之后**（页面内一个**后注册**的 ResizeObserver——RO 回调按注册顺序派发，测试的观察者在应用之后跑——或 rAF 内再 setTimeout 0）；⛔ 在 rAF 内直接读 scrollHeight 读到的是 pin 之前的状态，不得当作绘制态。断言 gap ≤ 1px。
- **按钮半**：整段窗口（变矮前、变矮后、长高后各采样一次，并在页面内挂 MutationObserver 记录按钮节点的出现过）`Scroll to bottom` 按钮的计数必须恒为 0。按钮经 `aria-label` / `title`（`input.scrollToBottom`，默认文案 `Scroll to bottom`）定位。
- **抗假变体**（真跑、留输出、须还原）：把实现换成「非程序 scroll + scrollTop 变小 ⇒ 脱离」⇒ 本条必须红，且红的是 gap ≈ N 与 / 或按钮出现，而不是夹具 / 端口问题。
- 登录后置锚点不得等 `Choose Your Project` 空态（播种会让该 workspace 自动成为项目），锚在真实视图里必然存在的元素（如 Settings 按钮）上。

## AC

- [x] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-111"` 退出码 0（真实 Chromium 打 playwright webServer 起的真实后端 + 真实 Vite，隔离数据目录；不得 stub 后端、不得用 evaluate 直接设 scrollTop 冒充用户手势）。
- [x] 同一 spec 断言**变矮半**：视口上方一行变矮 M≥200px 后，页面内捕获阶段 scroll 计数增量 ≥1（浏览器自己确实改了 scrollTop 并派发 scroll），且同区间 `window.__scrollWrites` 增量为 0（这段 scrollTop 变化不是程序写的）。
- [x] 同一 spec 断言**贴底半**：随后让最后一行就地长高 N≥400px，在布局与 ResizeObserver 回调之后的采样点 gap ≤ 1px。
- [x] 同一 spec 断言**按钮半**：整段窗口（变矮前 / 后、长高后）`Scroll to bottom` 按钮计数恒为 0；且事件序列里不含任何 wheel / touch / 键盘输入（`page.mouse.wheel` 只在贴底那一次使用，之后到断言结束为零）。
- [x] **抗假变体真跑并留输出后还原**：「非程序 scroll + scrollTop 变小 ⇒ 脱离」的版本使本条变红（gap ≈ N 与 / 或按钮出现）；`git diff` 证明 spec 的真实断言一条未删、未经 stub/skip，实现已还原。
- [x] `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 新增用例：合成一次 `scroll` 事件（先让 scrollTop 变小再 dispatch）**不得**改变跟随意图（零脱离、按钮态零次），而合成的 `wheel` 向上**必须**脱离——证明判别依据是输入来源而不是 scrollTop 差值；`npm run test:client`、`npm run typecheck`、`npm run lint` 退出码 0。

## DoD

真实落地判据：不是 spec 文件存在，也不是某一次恰好绿。要求在真实实例（vite + 后端，隔离数据目录）上由该 spec 驱动真实浏览器走完 AC-111 全文——真实手势贴底、零输入前提下由 DOM 直改触发的**浏览器自身** scroll、随后的就地长高、布局与 ResizeObserver 回调之后的采样——判据命令**可重复地**退出 0（连续 ≥2 次），并把抗假变体的红灯输出与还原证据记入完成记录；AC-111 在驱动器下一轮经 `goal_ac: AC-111` 独立核验时由红翻绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。

实现这一半必须在 `src/` 内真实落地：⛔ 不得靠 spec 里 `evaluate` 打补丁、不得靠注入 CSS/脚本（含关掉 `overflow-anchor`）制造「浏览器没动」的假场景来换绿——判别方式就是抗假变体必须红，且变矮半的 scroll 计数必须 ≥1。

⛔ 已知仪表风险，如实记录而不是谎报绿：goal gate 的 `runAcceptance` 有 60s 硬超时，而本条判据要起两个 webServer（后端 tsx + vite）再跑一次 Chromium。取得读数时**同时记 wall time**；若某次以「acceptance timed out」收场，那是判据仪表的读数丢失，点名它，不要把超时当成绿、也不要把超时当成代码缺陷。

登记（避免下一轮踩同一坑）：`src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 是既有单元测试文件，扩展它即可（不新建测试文件就不受 boundaries lint 对新增测试文件的桶导入要求；若确实要新建，必须经模块 barrel 导入）。e2e 端口 47101/47173 写死在 `playwright.config.ts`：并发 worktree 的 e2e 会撞死端口，取得读数前先确认端口空闲。`scripts/test.sh` 的 scoped 门对 `e2e/*.spec.ts` 判 thin，照常跑判据命令、`npm run test:client`、`npm run typecheck`、`npm run lint`，并把真实输出记入证据。预期既不需要改 `playwright.config.ts`（夹具复用 AC-106），也不需要改 `ChatMessagesPane.tsx`（容器 ref 已在 hook 内）；若确实需要，先把它们加进 Touches 再改。

L_D 该轴仍暗，理由：本任务只改前端滚动意图状态机与新增一条浏览器判据，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器里的像素几何（gap）与事件来源计数（scroll / scrollWrites / 按钮出现次数），不是生成质量轴。

## Touches

- e2e/transcript-follow.spec.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- tasks/gap-transcript-follow-browser-scroll-not-user-intent.md
