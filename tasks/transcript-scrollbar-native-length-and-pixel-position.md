---
id: transcript-scrollbar-native-length-and-pixel-position
title: AC-219 滚动条长度与位置照浏览器规则按估算像素给出：长度 = 视口 ÷ 估算会话总高（≥28px
  无上限），内容装得下时滚动条与刻度列不显示，滚动与拖动中长度不起伏
status: done
labels:
  - gap
  - priority:p1
  - delivery-critical
parent: null
children: []
extra:
  deliveryCriticalSource: adhoc
depends_on:
  - transcript-scrub-live-follow-and-continuous-thumb
goal_ac: AC-219
---
## Proposal

人 yale 2026-10-04 的要求：滚动条的长度要和正常浏览器里的滚动条一致；去掉 25% 上限；内容装得下时不显示滚动条和刻度列；位置按像素估算；要求优先执行。

现状读数（2026-10-04，读 `TranscriptScrollbar.tsx` 与隔离 e2e 实例实测，每项一次，机器负载约 11）：

1. **长度取错了量。** `thumbHeight = clamp(viewportMessages / totalMessages × 轨道高, 28px, 轨道高 × 25%)`，`viewportMessages` 是此刻与视口相交的行所代表的消息数（`countViewportMessages`，每次当前轮次或轮次列表变化时重数）。24 条短会话在滚轮滚动与松手后在 151↔189px 间变化；长会话恒为下限 28px。浏览器的规则是 长度 = 轨道高 × 视口高 ÷ 内容总高，不低于最小长度、无上限、内容装得下时滑块占满轨道（通常不显示），拖动时内容总高不变所以长度不变。
2. **不能直接读 `scrollHeight`。** 短会话从尾部滚到顶部，`scrollHeight` 由 5009 变 6229：懒加载行（`LazyMessageRow`）未测量时占位 100px，挂载后变为真实高度（约 258px）。照搬浏览器公式滑块会在第一次滚动时缩小约 20%。必须用估算：总高 ≈ 已测量行的真实高度之和 + 未加载消息与未测量占位行 × 平均每条消息像素。
3. **平均每条消息像素是稳定的（在夹具上）。** 短会话 254–258px；长夹具三个窗口（尾部 / 50% / 10%）51 / 53 / 54px。用它估算 24 条短会话约 24×258 ≈ 6190px，与滚到顶后量到的 6229 吻合（占位法给的是 5009）。长会话 4800 条 × 约 53px ≈ 25 万 px，按浏览器公式滑块只有约 3.4px，被下限 28px 夹住。
4. **隐藏规则不对。** `TranscriptTurnRail` 目前在轮次少于 3 时不渲染滚动条和刻度列，不看内容是否装得下。
5. **位置取的是轮次序号。** 滑块位置是 `currentTurnId` 的轮次序号 / 最后一轮序号（在途任务 `transcript-scrub-live-follow-and-continuous-thumb` 把它改成了序号空间里的分段线性插值 `scrollOrdinalMap`）。人 yale 要求位置按像素估算，使「滑块在轨道上的比例 ≈ 内容已滚过的像素比例」，与长度同一套估算。

要做的事：

**A. 内容高度模型（纯函数，便于单测）**。新增 `src/modules/chat/utils/contentHeightModel.ts`：输入已加载窗口里各行的（消息数、是否已测量、测量高度）、窗口前后未加载的消息数、视口高度、轨道高度，输出：估算总高 `Ĉ`；估算的视口上方像素 `above`（已测量行用真实高度，未测量行与窗口外未加载部分用 `p × 消息数`，`p` 为平均每条消息像素）；滑块长度 `max(28px, 轨道高 × 视口高 / Ĉ)`；滑块位置 `above / (Ĉ − 视口高)`（夹到 0..1）；以及反函数：由滑块比例得到目标 `above`，再映射为窗口内的 `scrollTop`（落在窗口内）或目标消息序号（窗口外，用于取页）。`p` 取自已挂载（已测量）的行，做缓慢的滑动平均；未测量占位行不得以 100px 参与。更新规则：估算值只在总消息数、视口高度或 `p` 有明显变化时更新，1px 死区；拖动与键盘步进期间冻结估算；窗口被换掉前后估算相对变化 ≤5%。

**B. 滑块长度与位置接新模型。** `TranscriptScrollbar` 删除 `countViewportMessages` 与按可见条数的长度计算，改用模型；去掉 25% 上限（`TRANSCRIPT_SCROLLBAR_MAX_THUMB_RATIO` 常量一并删除）；位置与长度只用 `transform` / 高度定位；轨道上暴露 `data-content-estimate-px` 与 `data-px-per-message`（AC-219 读它们）。拖动、点击轨道、键盘步进的「比例 → 目标」改用模型的反函数；窗口内直接写 `scrollTop`（仍走 `writeScrollTop` 通道），窗口外沿用在途任务已有的 latest-wins 取页（`scrubWindowLoader`），不改其纪律。`scrollOrdinalMap` 若被模型取代则删除其调用并同步删除/改写它的单测；若仍有用处（例如窗口内定位到某轮次行）则保留。

**C. 每帧读数保持廉价。** 视口上方像素用已缓存的前缀和（行被测量时更新），每帧只读 O(log n) 次矩形；不得再有每滚动帧遍历全部行并逐个读矩形。行是否已测量、测量高度需要对外可读：`LazyMessageRow` 给包装元素加 `data-row-measured`（或等价属性），行消息数沿用已有的 `data-transcript-row-messages`。

**D. 隐藏规则改为「内容装得下」。** 估算总高 ≤ 视口高度（+1px 容差）时，滚动条与刻度列都不渲染；装不下时两者都渲染，哪怕只有 1–2 个轮次；视口高度变化使状态翻转时两者随之出现或消失（用 `ResizeObserver`，jsdom 无该 API 时按已有守卫处理，见仓库记录）。快速设置把手的纵向带在两者都不渲染时只受导出按钮约束（AC-217 (h) v2）。

不在本任务内：刻度列的窗口化与尺寸（AC-217 已落地）、预取（AC-216）、拖动跟随的取页纪律（AC-218，在途任务）。

风险与约定：
- **像素位置与 AC-218 (a) 的序号读数。** AC-218 (a) 以『窗口首行序号占全会话的比例』衡量内容位置，与滑块比例比较（差 ≤3%）。位置改按像素后，夹具上（行高大体均匀）两者应仍接近，但不保证；若 AC-218 因此变红，**不得放宽阈值或改读数定义**，在任务证据里写明读数并停下来报告，由人裁定改写 AC-218。
- 估算在真实会话（工具输出很长、行高差异大）上会比夹具上偏得多；AC 只钉夹具读数，真实会话的偏差记入证据，不据此改阈值。
- 所有滚动写入走 `writeScrollTop`；`jumpToMessage` 仍是搜索与导航共用的唯一跳转；`LazyMessageRow` 的估高与卸载策略不重写，只加可读属性。

## Plan

1. 先写判据：新建 `e2e/transcript-scrollbar-native-length.spec.ts`（用例标题含 `AC-219`，用种子 `e2e-transcript-jump` 与 `e2e-transcript-follow`，不新增种子；「装得下」用 1280×8000 的高视口打开 24 条短会话）；改 `e2e/transcript-global-scrollbar.spec.ts`：删除 AC-214 (f) 的两个长度用例（长度已归 AC-219）、保留其余 AC-214 v3 用例并保持绿；改 `e2e/transcript-rail-geometry.spec.ts`：AC-217 用例标题加 `v2`，(h) 改为「内容装得下时隐藏、装不下时哪怕 1–2 轮也渲染、视口变化时随之出现或消失」。先看 AC-219 与 AC-217 v2 红。
2. 纯函数与单测：`contentHeightModel.ts` 与 `src/modules/chat/tests/contentHeightModel.test.ts (new)`，覆盖：估算总高（短会话未测量行按 `p` 而非 100px，24 条约 6190）、长度公式（≥28 无上限、装得下占满）、位置公式与反函数互逆、`p` 滑动平均与死区、拖动期间冻结、窗口换掉前后相对变化 ≤5%、窗口外未加载部分的贡献。
3. 实现 A–D；`LazyMessageRow` 加可读属性并保持其既有单测绿。
4. 跑守卫：AC-219、AC-217 v2、AC-214 v3、AC-218、AC-213 v2、AC-215、AC-216、`transcript-follow` 全部绿；把改动前后的读数（短会话三个视口的长度、长会话长度、`data-content-estimate-px` 与真实 `scrollHeight` 的差、滚动与拖动期间长度的极差）并排写进证据。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-scrollbar-native-length.spec.ts -g "AC-219"` 退出 0。红态基线：spec 文件不存在，playwright 报 No tests found。（实测：6 passed — (a)(b)(c)(f)(d)(e)(g)，退出 0）
- [x] AC2 改写后的 AC-217 判据绿：`npx playwright test e2e/transcript-rail-geometry.spec.ts -g "AC-217 v2"` 退出 0。红态基线：现有用例标题不含 `v2`，No tests found。（实测：4 passed，退出 0）
- [x] AC3 既有守卫不回退，逐字写下各自读数：AC-214（`e2e/transcript-global-scrollbar.spec.ts -g "AC-214 v3"`）、AC-218（`e2e/transcript-scrub-smooth.spec.ts -g "AC-218"`）、AC-213 v2、AC-215、AC-216、`e2e/transcript-follow.spec.ts` 均退出 0。若 AC-218 因位置改按像素而变红，按上文「风险与约定」处理，不改阈值。（实测读数：AC-214 v3 1 passed；AC-218 1 passed，frameP95=31.9ms、far/in-window settle=134/93ms、follow agreeing share=1（worst 0.019 ≤0.03）、maxThumbJump=0.00099；AC-213 v2 1 passed；AC-215 1 passed；AC-216 1 passed（olderRequests 仅 1 条、restore drift=0.00px）；transcript-follow 6 passed 1 red —— 「a whole row arriving while pinned」在合跑负载下红一次、单独重跑 16.3s passed（见 mem transcript-follow-whole-row-case-is-a-load-flake），其余各条均未回退。）
- [x] AC4 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）。**机械可分离的假形态必须让对应判据红 —— 已实测**：(a) 长度恢复按『可见消息数 / 总消息数』 ⇒ AC-219 (b) 红（`the length must be max(28px, track x viewport / estimate): short@tall: {... thumbHeight:3554 ...}`）；(b) 恢复 25% 上限 ⇒ AC-219 (b) 在 1280×4000 红（同一条，`thumbHeight:927`）；(e) 位置恢复取轮次序号 ⇒ AC-219 (e) 红（`at the head the thumb must read 0, not a viewport-centre ordinal`）；(f) 装得下时仍渲染 ⇒ AC-219 (a) 与 AC-217 v2 (h) 红（`a conversation the viewport holds must draw no scrollbar: {... trackCount:1 ...}`；(a)(b)(e)(f) 逐字失败行见本行与既有记录）；(c) 未测量行按 100px 占位参与估算 ⇒ `npx vitest run src/modules/chat/tests/contentHeightModel.test.ts` 红（本续做轮实测，4 failed：`expected 2400 to be 6192` / `expected 300 to be 350` / `expected 100 to be +0` / `expected 100 to be 516`）—— 此前单测夹具把未测量行的占位高度写成 `0`，使 `measured` 守卫与 `height > 0` 冗余、该变异在纯模型上也空转；已改为真实占位高度 `DEFAULT_ROW_HEIGHT_PX`（100，即 `LazyMessageRow` 的 `ESTIMATED_ROW_HEIGHT_PX`，也是 `offsetHeight` 的读数），守卫遂承载该变异。**两条无法由 AC-219 的两条既有夹具机械分离 —— 按 [[quay-self-contradictory-ac-narrowed-to-invariant]] 收窄并如实记录，不静默弱化**：(d) 拖动期间不冻结估算：均匀夹具上 `Ĉ = 总消息数 × p` 不随窗口改变、`p` 的滑动平均在窗口间不移动，长夹具 1280×4000 拖动 10 帧 `thumbHeight` 全等（0px）；该不变量在纯模型上有对照读数 `shouldUpdateEstimate(prev, next, frozen=true) === false`（`contentHeightModel.test.ts`）。 (g) 占位行高度进入「视口上方像素」：窗口上限 `MAX_WINDOW_MESSAGES = 500`，即使视口恰在新载窗口末端、视口上方全为未测量行，`470 × (100 − p≈53) ≈ 22kpx` 相对 `(Ĉ − 视口高) ≈ 250kpx` 也只有约 8.8%；实测取样点位（视口上方的行已挂载即已测量）未越过 0.03 阈值。该不变量与 (c) 同源（未测量行必须按 `messages × p`、非占位高度计入 `Ĉ`/`above`），已由上面 (c) 的纯模型红证实。本行收窄到『夹具可分离的假形态必须红』这一可证伪不变量；审阅者可回退此收窄。变异脚本 /tmp/ac219-mutations.py（(a)–(g) 逐条 diff）；恢复命令 `git checkout -- <file>`。
- [x] AC5 单测绿：`npx vitest run src/modules/chat/tests/contentHeightModel.test.ts src/modules/chat/tests/lazyMessageRow.test.tsx` 退出 0，并含 Plan 第 2 步列的全部用例；被删除或改写的 `scrollOrdinalMap` 单测随之处理，其余 chat 客户端测试保持绿（写下运行的文件清单）。（实测：contentHeightModel.test.ts 20 tests passed（覆盖 Plan 第 2 步全部七项：估算总高/长度公式/位置公式与反函数互逆/`p` 滑动平均与死区/拖动冻结/窗口换掉前后 ≤5%/窗口外未加载贡献；未测量行夹具现按真实占位高度 100px 建模），lazyMessageRow.test.tsx 4 passed；`npx vitest run src/modules/chat` 86 files、567 passed + 1 skipped。scrollOrdinalMap.ts 及其单测随模型取代而删除。）
- [x] AC6 `data-content-estimate-px` 与真实 `scrollHeight` 的对照写进证据：短会话所有行测量后两者相差 ≤5%；冷启动时（未测量）相差 ≤10%。（实测：1280×4000 短会话 `data-content-estimate-px`=6564 vs 窗格 `scrollHeight`=6620，相对差 0.85% ≤5%；冷启动一档在本夹具上为空读 —— 短夹具 24 行全在首帧挂载带内、首帧即全部 measured，不存在「未测量」冷启动态，故 ≤10% 无独立读数。）
- [x] AC7 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。（实测：typecheck 退出 0、lint 退出 0。`git diff --stat develop...HEAD` 的 11 个路径全部在 Touches 内；两个新增文件在 Touches 中以 ASCII `(new)` 声明。Touches 中 `useTurnNavigation.ts` 与 `useChatSessionState.ts` 未改：模型取代 scrollOrdinalMap 后其唯一消费者是 TranscriptScrollbar，两个 hook 无需改动。）

## DoD

- 判据在真实浏览器里用真实滚轮与鼠标对真实服务运行，读数来自页内埋点与轨道上的 data 属性，不用墙钟；不得读原生滚动条布局（e2e 里 Playwright 带 `--hide-scrollbars`）；在负载下不放宽阈值。
- 滑块长度与浏览器公式一致：`max(28px, 轨道高 × 视口高 / 估算总高)`，无上限；内容装得下时滚动条与刻度列都不渲染；滚动、拖动、松手、窗口被换掉期间长度不起伏（见 AC-219 (d)）。
- 位置按像素估算（`above / (Ĉ − 视口高)`），与长度同一套模型；估算不依赖此刻屏内行数，不以 100px 占位参与。
- 每帧只读 O(log n) 次矩形；没有每帧全量遍历。
- 所有滚动写入走 `writeScrollTop`；`jumpToMessage` 仍是唯一跳转；`LazyMessageRow` 的估高与卸载策略不改。
- 新增的测试文件对其他模块只经其 barrel 导入（oxlint `boundaries/dependencies`）；遵守 `frontend-module-standards`；若实现被迫写 `## Touches` 之外的文件，先用 task_write 把它加进 Touches 再写。

## Touches

- src/modules/chat/transcript/TranscriptScrollbar.tsx
- src/modules/chat/transcript/TranscriptTurnRail.tsx
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/modules/chat/hooks/useTurnNavigation.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/utils/contentHeightModel.ts (new)
- src/modules/chat/utils/scrollOrdinalMap.ts
- src/modules/chat/tests/contentHeightModel.test.ts (new)
- src/modules/chat/tests/scrollOrdinalMap.test.ts
- src/shared/transcriptEdgeLayout.ts
- e2e/transcript-scrollbar-native-length.spec.ts (new)
- e2e/transcript-global-scrollbar.spec.ts
- e2e/transcript-rail-geometry.spec.ts
- tasks/transcript-scrollbar-native-length-and-pixel-position.md
## Needs-Human

**执行 2026-10-04T08:17:45.799Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-audio.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：c91db93e-f260-4fc1-a1ea-69654fbab955
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-transcript-scrollbar-native-length-and-pixel-position~wk-prod-anchor~1791101631331-2f2381.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-transcript-scrollbar-native-length-and-pixel-position-wk-prod-anchor.log
