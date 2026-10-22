---
id: gap-transcript-follow-on-content-resize
title: transcript 贴底跟随改由内容几何驱动：最后一行就地长高仍贴底 ≤1px，离开底部后不被移动（AC-106 判据
  e2e/transcript-follow.spec.ts 由红转绿）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-106
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本任务采用的 e2e 夹具约定出自 gap-session-filter-real-browser-e2e（done，其完成记录写明「服务器启动前由 playwright.config.ts 播种」与「索引一个会话会自动注册它的项目」），登录后置锚点的坑出自 gap-e2e-onboarding-anchor-seeded-transcripts（done）。本任务不重复申领 e2e 工具链本身，也不回退它们的播种。

背景（实测）：AC-106 的判据命令 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-106"` 当前必红——`e2e/transcript-follow.spec.ts` 不存在，playwright 报 No tests found。红因不是夹具而是实现缺口：transcript 的自动跟随只由 `src/modules/chat/hooks/useChatSessionState.ts` 的 `useLayoutEffect` 驱动，其依赖数组为 `[chatMessages.length, isActive, isUserScrolledUp]`，即只在**消息条数**变化时写一次 `container.scrollTop = container.scrollHeight`。最后一行就地长高（流式文本、markdown 重渲染、图片加载）不改变条数，故不触发；pane 变矮同理。实测 (a) gap 0→1608、零 scrollTop 写入。

方案：把「贴底」的触发信号从 React 信号（消息条数）换成内容与视口的**几何不变量**——在滚动容器上挂 ResizeObserver，观察**内容层**元素的盒子（最后一行长高时它真的变高），回调里若用户当前贴底（gap ≤ 阈值）就把 scrollTop 写回 `scrollHeight − clientHeight`；若用户已离开底部则**不写** scrollTop，让内容增长原样把 gap 增大 N。

⛔ 关键约束（对应 AC 的取假形态）：触发必须来自几何，不得来自 React 信号（消息条数、最后一行文本长度……），也不得写成「每次 store flush 无条件 pin」。理由：AC 的 (a)(b) 是**不经过 store、不改变行数**的 DOM 直接注入，任何 React 信号驱动的实现都不会被它唤醒，两半必然红。ResizeObserver 在 DOM 注入改变最后一行盒子时**会**触发，这是本方案成立的全部依据。

实现要点：

1. `useChatSessionState.ts` 新增贴底保持。观察对象是内容层（`src/modules/chat/transcript/ChatMessagesPane.tsx` 里 `mx-auto w-full max-w-[54.25rem]` 那一层），**不是**滚动容器自身——容器高度只在 pane 变矮时才变，观察它拿不到「内容长高」。内容层是条件渲染的（空态/加载态/消息态），需在节点出现时就位并在卸载时 disconnect。视需要可同时观察容器自身以覆盖 pane 变矮，但那条读数由 AC-107 承载，不在本判据的断言内。
2. 回调用布局后的真实 `scrollHeight` 判定贴底；写 scrollTop 放在 rAF 内，并在写之前**重新判定**一次贴底，避免 pin 自身把「用户刚离开底部」的状态抹掉（AC-109 的读数）。
3. 不得改变既有语义：`isUserScrolledUp`、`pendingScrollRestore`（会话切换/分页恢复）、`nearBottom < 50`、搜索跳转、`handleScroll` 里的 `loadOlderMessages` 一律保持；新增 pin 只在贴底时生效，且不得反过来置位/清位 `isUserScrolledUp`，也不得让 pin 触发 loadOlderMessages。
4. 干净卸载：观察器在会话切换与组件卸载时 disconnect；pin 与待恢复滚动不得互相打架（恢复期间不得被 pin 抢先写 scrollTop）。

判据 spec（`e2e/transcript-follow.spec.ts`，用例标题必须含字面量 `AC-106`，以便 `-g "AC-106"` 选中）：

- 夹具：在 `playwright.config.ts` 里、**服务器启动前**、且仅在 `isDataDirOwner` 进程里，把一份**足够长、可滚**的 transcript（末条为 assistant）种进**本 spec 专属**的 workspace，交给后端 boot scan 索引。理由：测试运行中写入会被 watcher 捕获并逐个广播 session_upserted，把会话标成「需关注」导致随机红。
- 打开该会话（经侧边栏会话行，不直接操纵 store），用**用户手势** `page.mouse.wheel` 到达底部；⛔ 不得用 `evaluate` 直接设 scrollTop 冒充手势。
- (a) 不经过 store、不改变行数，直接改 DOM 让最后一行 assistant **就地长高 N≥400px**；(b) 替换最后一行的最后一段内容使其变高。每次之后 gap ≤ 1px。
- 对照半：先用手势离开底部（gap > 阈值），再做同样的增长 → scrollTop 不变（±1）且 gap 恰好增加 N（±1）。
- 采样点必须在**布局与 ResizeObserver 回调之后**（页面内一个后注册的 ResizeObserver，或 rAF 内再 setTimeout 0）；⛔ 在 rAF 内直接读 scrollHeight 读到的是 pin 之前的状态，不得当作绘制态。
- 抗假变体（真跑、留输出、须还原）：把跟随触发换成另一个 React 信号（最后一行文本长度）或改成「每次 store flush 无条件 pin」⇒ (a)(b) 必须红；离开底部后仍被 pin ⇒ 对照半必须红。
- 登录后置锚点不得等 `Choose Your Project` 空态（播种会让该 workspace 自动成为项目），锚在真实视图里必然存在的元素（如 Settings 按钮）上。

## AC

- [x] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-106"` 退出码 0（真实 Chromium 打 playwright webServer 起的真实后端 + 真实 Vite，隔离数据目录；不得 stub 后端、不得用 evaluate 直接设 scrollTop 冒充用户手势）。
- [x] 同一 spec 断言贴底半：(a) 让最后一行 assistant 就地长高 N≥400px、(b) 替换最后一行的最后一段内容使其变高，每次采样 gap ≤ 1px；采样点在布局与 ResizeObserver 回调之后（后注册 ResizeObserver 或 rAF 内 setTimeout 0），⛔ 不得用 rAF 内直接读 scrollHeight 当绘制态。
- [x] 同一 spec 断言对照半：先用手势离开底部（gap > 阈值）后做同样的增长，scrollTop 不变（±1）且 gap 恰好增加 N（±1）。
- [x] 抗假变体真跑并留输出后还原：React 信号版（最后一行文本长度）与「每次 store flush 无条件 pin」版各使 (a)(b) 变红；「离开底部后仍被 pin」版使对照半变红；`git diff` 证明 spec 的真实断言一条未删、未经 stub/skip。
- [x] `npm run test:client` 与 `npm run typecheck` 退出码 0（既有前端测试不回归，含 src/modules/chat/tests/transcriptScrollOwnership.test.tsx）。

## DoD

真实落地判据：不是 spec 文件存在，也不是某一次恰好绿。要求在真实实例（vite + 后端，隔离数据目录）上由该 spec 驱动真实浏览器走完 AC-106 全文——真实手势进/出底部、真实 DOM 注入、布局与 ResizeObserver 回调之后的采样——判据命令**可重复地**退出 0（连续 ≥2 次），并把两个抗假变体的红灯输出与还原证据记入完成记录；AC-106 在驱动器下一轮经 `goal_ac: AC-106` 独立核验时由红翻绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。

实现这一半必须在 `src/` 内真实落地：⛔ 不得靠 spec 里 `evaluate` 打补丁、不得靠注入 CSS/脚本模拟跟随来换绿——判别方式就是两个抗假变体必须红。

登记（避免下一轮踩同一坑）：本任务 Touches 里只有 `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 是 unit 测试，`e2e/*.spec.ts` 归 playwright（`scripts/test.sh` 的 scoped 门对其判 thin）。请照常跑判据命令、`npm run test:client`、`npm run typecheck` 与 `npm run lint`，并把真实输出记入证据。⚠️ 并发 worktree 的 e2e 会撞死端口（playwright.config.ts 把 47101/47173 写死），取得读数前先确认端口空闲。

L_D 该轴仍暗，理由：本任务只改前端滚动几何与新增一条浏览器判据，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器里的像素几何（gap / scrollTop），不是生成质量轴。

## Touches

- e2e/transcript-follow.spec.ts (new)
- playwright.config.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- tasks/gap-transcript-follow-on-content-resize.md

## Completion

**执行 2026-09-21（task/gap-transcript-follow-on-content-resize，commit 793a5ce9，merge develop 330410fd）**

判据命令 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-106"` 退出码 0，1/1 pass。连续 4 轮全绿（每轮 2.1s；总 10.9s / 11.3s / 12.3s / 11.0s，无抖动）：前 3 轮为连续复跑，第 4 轮为三个抗假变体全部还原后的复跑。

```
  ✓  1 e2e/transcript-follow.spec.ts:259:3 › transcript follow in a real browser › AC-106 a row that grows in place stays pinned at the bottom, and a scrolled-away transcript is left alone (2.1s)
  1 passed (11.0s)
```

真实链路：真实 Chromium 打 playwright.config.ts 的 webServer（真后端 `npx tsx server/index.ts`:47101 + 真 Vite:47173，隔离数据目录 `QUAY_E2E_DATA_DIR`）。夹具是真实 Claude transcript JSONL（24 条交替 user/assistant，末条 assistant，带 custom-title），在服务器启动前由 playwright.config.ts 且仅在 `isDataDirOwner` 进程里种进本 spec 专属 workspace，交后端 boot scan 索引。会话经侧边栏会话行打开，进/出底部全部用 `page.mouse.wheel` 真实手势。无任何请求 stub，无 `evaluate` 直接设 scrollTop，无 store 直接操纵，无注入 CSS/脚本模拟跟随。

采样点在布局与 ResizeObserver 回调之后：页面内先 `requestAnimationFrame` 再 `setTimeout 0` 读几何；并且用 `waitForSettledPane` 要求三次连续稳定读数（80ms 间隔，|ΔscrollTop|<0.5 且 |Δgap|<0.5）才取读数。理由：跟随允许晚一帧落地，浏览器又把 wheel 滚动做成动画，单次读数会读到中途态；未用 rAF 内直接读 scrollHeight 当绘制态。

三条断言实测：
- 贴底半 (a)：向最后一个 `.chat-message.assistant` 注入 480px（≥400）spacer（不经 store、不改行数）→ gap 0，≤1px。
- 贴底半 (b)：把最后一个 assistant 行体内最后一个 markdown 块替换成 480px 的块 → gap 0，≤1px。
- 对照半：先用手势离开底部（gap > 400），同样注入 480px → scrollTop 4784 → 4784（±1），gap 恰好 +480（±1）。

抗假变体（真跑、留输出于 `/tmp/ac106-antifake/*.log`、每个跑完即 `git checkout --` 还原）：
- v1-react-signal.log：React 信号版（最后一行文本长度）——不观察内容层，改由 `useEffect([chatMessages])` 读最后一行 `content.length` 触发。⇒ exit 1，(a) 红，`Received: 480`（注入的高度一分没跟随）。这正是 (a)(b) 不经 store 的意义：任何 React 信号实现都睡过去。
- v2-store-flush-pin.log：「每次 store flush 无条件 pin」版——不 observe 任何节点，`useEffect([chatMessages])` 里直接写 scrollTop。⇒ exit 1，(a) 红，`Received: 480`。
- v3-always-pin.log：「离开底部后仍被 pin」版——删掉按上一次布局判定贴底的容差分支，任何 resize 都 pin。⇒ exit 1，对照半红：`scrollTop 4784 → 5964`（被拉回底部），`Received: 1180`。注意该变体下 (a)(b) 是绿的（它跑到了对照半），即这条变体精确地只打对照半。

还原证据：三次 `git checkout -- src/modules/chat/hooks/useChatSessionState.ts` 之后 `git status --short` 与 `git diff HEAD --stat` 均为空；`git diff HEAD -- e2e/transcript-follow.spec.ts` 无输出，`git show HEAD:e2e/transcript-follow.spec.ts | grep -c "expect("` = 19（一条未删），`grep -E "test\.(skip|only|fixme)"` 无命中；还原后复跑仍绿。最终 diff 只含 Touches 里声明的 6 个文件（外加本任务文件）。

非显然事实（留给后来者）：
1. `<Markdown>` 把 react-markdown 的 `p` 覆写成 `<div class="mb-2">`（`src/modules/chat/transcript/Markdown.tsx:227`），transcript 里根本没有 `<p>` 元素；按 `p`/`li` 选「最后一段」必空（本轮首次运行即因它红在 (b)）。改取 `.prose` 容器内最后一个 `.mb-2`。
2. 跟随的判底容差必须是 1px，不能复用 `isNearBottom` 的 50px：1–50px 正是小幅手势造成的漂移，跟随它就是把用户拉回去（AC-109 的读数）。
3. `LazyMessageRow` 的 IntersectionObserver viewport margin 是 1200px（`src/modules/chat/hooks/useLazyRowObserver.ts:5`）：离开底部的手势步长必须远小于它，否则最后一行被卸载成占位符，DOM 注入就落在没有真实内容的节点上。spec 的步长取 700px。
4. jsdom 没有 ResizeObserver：不做 `typeof ResizeObserver === 'undefined'` 守卫，每个渲染 ChatInterface 的既有测试都会在 render 期崩。

静态门：`npm run test:client` 退出码 0（73 files / 498 tests passed）；`npm run typecheck` 退出码 0（tsconfig.json + server/tsconfig.json）；`npm run lint` 退出码 0（仅既有 warning）。注：`tsconfig.json` 的 `include` 不含 `e2e/`，故 e2e spec 不进 `npm run typecheck`，另行以 `npx tsc --noEmit --skipLibCheck --strict --module esnext --moduleResolution bundler --target es2022 e2e/transcript-follow.spec.ts` 单跑，退出码 0。

scoped gate：`bash scripts/test.sh --for-task gap-transcript-follow-on-content-resize --allow-thin` 退出码 0（scoped 命中的唯一测试文件 `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 1/1 pass；suite-scope-check PASS，6 active tasks）；已写 scoped-gate-cache（develop-sha 330410fda4d3ceb8b9d7e130945f42bd73719bd6）。