---
id: transcript-jump-lands-on-target-with-tall-rows
title: AC-221 点击刻度或轨道后目标整行落在视口内并保持（含行高大的会话），点击到落定
  ≤200ms：未测量行占位按平均行高估算，跳转后有位置修正窗口，任何用户输入立即解除
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
  - transcript-scrollbar-native-length-and-pixel-position
goal_ac: AC-221
---
## Proposal

人 yale 2026-10-04 要求再次测试在平板和手机上点击刻度条的效果（含延迟），并起草任务、优先。

实测（:3001 当前版本，61 轮 / 536 条真实会话，只读，鼠标事件非触屏，视口 390×844 与 820×1100；以 pointerup 为 0；每次点击一次读数）：

- 成功 5 次：取页在 0–1ms 内发出、耗时 5–16ms；目标进入视口 53–181ms；位置最后一次变化 169–244ms（其中约 150ms 是 `useChatSessionState.ts` 里 `jumpToMessage` 在窗口落地后排的固定 `setTimeout`，见该函数 `scrollToRenderedTarget` 的 150ms 调度）。
- **失败 3 次**（平板点最早刻度、平板点邻近刻度、手机点轨道 5%）：目标最终在视口下方 2913px / 1327px / 3453px，1.8s 后仍不在视口内，高亮 class 已加上，页面没有任何提示。样本很小（一个会话、8 次点击），只能说明问题真实存在，不能当比例。
- 跳转后约 40ms 会再发一次 `around=<id>_0&before=0&after=50`（窗口向后扩展），来自跳转链路，已查明。

原因（推断）：`jumpToMessage` 把目标居中后只写一次 `scrollTop`，此时目标上方的行大多是 `LazyMessageRow` 的 100px 占位（`ESTIMATED_ROW_HEIGHT_PX`）；写完后视口附近的行进入挂载范围，变成真实高度（该会话约 250px），把目标推到视口下方，之后没有任何修正（`scrollToRenderedTarget` 只在「找不到元素」时重试）。仓库记录里有同一现象：此前为让 AC-213 稳定，读数被改成「窗口首行序号」，等于绕开了它。e2e 夹具 `e2e-transcript-jump` 的行只有约 70px（占位 100px 反而偏大），所以一直测不出。

要做的事：

**A. 未测量行的占位按平均行高估算。** `LazyMessageRow` 的占位高度：已测量过的行沿用上次测量值；从未测量的行不再用固定 100px，改为 `平均每条消息像素 × 该行消息数`。平均每条消息像素来自前置任务 `transcript-scrollbar-native-length-and-pixel-position` 的 `contentHeightModel`（`p`）；在 `ChatMessagesPane` 把它作为属性传给 `LazyMessageRow`，没有估算值时才回退 100px。

**B. 跳转后的位置修正窗口（纯函数决定是否修正，便于单测）。** 新增 `src/modules/chat/utils/jumpAnchorLock.ts`：跳转写完 `scrollTop` 后，约 600ms 内，每当目标行因布局变化相对视口的位置偏离「居中位置」超过 2px，就用 `writeScrollTop` 修正一次；修正窗口在以下任一情形立即结束：任何用户输入（滚轮、触摸、按键、鼠标按下）、窗口超时、目标行不在 DOM（窗口被换掉）。修正必须走已有的 `writeScrollTop` 通道（不得直接写 `container.scrollTop`），并与 `searchScrollActiveRef` 的语义一致，不与「贴底跟随」「用户上滚」意图判断相互打架。窗口结束后不再改写 `scrollTop`。

**C. 去掉定位前的固定等待。** `jumpToMessage` 里窗口落地后的固定 150ms `setTimeout` 去掉，改在窗口提交后的 layout effect（或 rAF）里定位，找不到目标再按 rAF 重试，而不是 150ms 步进（若前置任务 `transcript-scrub-live-follow-and-continuous-thumb` 已做，这里只确认并保持）。取页本身（窗口读取）不动。

**D. 行高大的种子会话。** 在 `playwright.config.ts` 新增种子 `e2e-transcript-jump-tall`（独立 workspace，约 300 个用户轮次，每轮的 assistant 文本 5–6 段、820 宽下行高约 250px，每 5 轮带一个 tool_use 与其结果，含一对同毫秒轮次，总体积 ≤10MB；沿用 `seedTranscriptJumpTranscript` 的写法，不 stub 任何请求）。冷启动加上这个种子后，配置求值加种子阶段的耗时增量 ≤2s（读 `playwright.config.ts` 头注释里的静默基线，写下前后读数）。

不在本任务内：右侧留白、把手、触摸热区（AC-220，另一任务）；像素估算与滑块长度（前置任务）；拖动跟随与取页纪律（`transcript-scrub-live-follow-and-continuous-thumb`）。

风险与约定：
- 修正窗口不得与用户滚动对抗：任何用户输入立即解除，输入之后应用不再写 `scrollTop`；这一条有取假形态把关。
- 修正读的是目标行的位置，最好用 `ResizeObserver` / 布局变化事件触发，而不是定时器轮询；若用 rAF，只在窗口期内运行。
- AC-221 只钉夹具读数；真实会话的行高差异更大，落点偏差记入证据，不据此放宽阈值。

## Plan

1. 先写判据：新建 `e2e/transcript-jump-landing.spec.ts`（用例标题含 `AC-221`），按 AC-221 的 (a)–(f) 读数，三种视口（手机点轨道、平板与宽屏点刻度）各 ≥8 次点击，行高大的 `e2e-transcript-jump-tall` 与既有短行夹具 `e2e-transcript-jump` 各跑一遍；埋点用页内 `performance.now()`（pointerup、fetch 日志、rAF 采样目标行位置），不用墙钟。先看它红（在 tall 夹具上至少一次落错）。
2. 做 D（新增种子），确认冷启动增量。
3. 纯函数与单测：`jumpAnchorLock.ts` 与 `src/modules/chat/tests/jumpAnchorLock.test.ts (new)`（偏离 >2px 才修正、用户输入立即解除、超时解除、目标行消失解除、解除后不再修正）；`LazyMessageRow` 的占位高度逻辑单测（已测量沿用、未测量按估算、无估算回退 100px），更新 `src/modules/chat/tests/lazyMessageRow.test.tsx`。
4. 实现 A、B、C。
5. 跑守卫：AC-221、AC-213 v2、AC-214 v3、AC-215、AC-216、AC-217 v2、AC-218、AC-219、`transcript-follow` 全部绿；把改动前后读数（24 次点击的落点偏差、点击到落定的 p50/p95/最大、占位与真实高度之比的中位数）并排写进证据。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-jump-landing.spec.ts -g "AC-221"` 退出 0。红态基线：spec 文件不存在，playwright 报 No tests found。
- [x] AC2 既有守卫不回退，逐字写下各自读数：AC-213 v2、AC-214 v3、AC-215、AC-216、AC-217 v2、AC-218、AC-219、`e2e/transcript-follow.spec.ts` 均退出 0。
- [x] AC3 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(a) 跳转只写一次 `scrollTop`、不做修正 ⇒ AC-221 (a)(c) 在 tall 夹具上红；(b) 未测量行恢复固定 100px 占位 ⇒ AC-221 (e) 红；(c) 修正不被用户输入解除 ⇒ AC-221 (c) 的输入条款红；(d) 修正窗口无限期不结束 ⇒ AC-221 (c) 红；(e) 保留 150ms 固定定时器 ⇒ AC-221 (d) 红。
- [x] AC4 单测绿：`npx vitest run src/modules/chat/tests/jumpAnchorLock.test.ts src/modules/chat/tests/lazyMessageRow.test.tsx` 退出 0，并含 Plan 第 3 步列的全部用例；其余 chat 客户端测试保持绿（写下运行的文件清单）。
- [x] AC5 新种子对冷启动的增量写进证据：配置求值加种子阶段的耗时前后读数，增量 ≤2s。
- [x] AC6 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 判据在真实浏览器里用真实鼠标对真实服务运行，读数来自页内埋点与目标行的几何位置，不用墙钟；不放宽阈值；在负载下若出现假红按仓库记录处理，不改阈值。
- 点击刻度或轨道后目标整行落在视口内并保持（落定后 1.5s 内位置变化 ≤2px），24 次点击（三种视口）全部通过；点击到落定 p95 ≤200ms。
- 所有滚动写入走 `writeScrollTop` 通道；`jumpToMessage` 仍是搜索与导航共用的唯一跳转；用户输入立即解除修正。
- `LazyMessageRow` 的卸载与挂载策略不重写，只改未测量行的占位高度来源。
- 新增的测试文件对其他模块只经其 barrel 导入；遵守 `frontend-module-standards`；若实现被迫写 `## Touches` 之外的文件，先用 task_write 把它加进 Touches 再写。

## Touches

- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/utils/contentHeightModel.ts
- src/modules/chat/utils/jumpAnchorLock.ts (new)
- src/modules/chat/tests/jumpAnchorLock.test.ts (new)
- src/modules/chat/tests/lazyMessageRow.test.tsx
- playwright.config.ts
- e2e/transcript-jump-landing.spec.ts (new)
- tasks/transcript-jump-lands-on-target-with-tall-rows.md
