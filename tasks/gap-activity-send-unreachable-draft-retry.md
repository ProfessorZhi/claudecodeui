---
id: gap-activity-send-unreachable-draft-retry
title: AC-185 发送时服务端不可达：5 秒内坞说出「发送失败」、不在本地标成回合中、草稿不丢、重发不产生重复用户消息
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-dock-unreachable-degradation
goal_ac: AC-185
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立此时实测，读代码与任务库）。`grep -rn "^goal_ac: *AC-185" tasks/*.md` → **0 命中**；`grep -rln "AC-185" tasks/` → **0 命中**。机制侧：`grep -rn "activity.patch\|activity.snapshot\|data-activity" src/ server/ shared/` → **0**（整套活动模型尚未建）。GOAL-014 里已认领的三条是同目标下的**不同机制**，本条不重复它们：`gap-activity-heartbeat-server-frames`（`goal_ac: AC-182`）证明服务端按节拍发帧；`gap-client-activity-freshness-state-machine`（`goal_ac: AC-183`）证明没有帧时那个纯状态机怎么降级；`gap-activity-dock-unreachable-degradation`（`goal_ac: AC-184`）证明**回合开着时**服务端消失，坞显示连接中断、计时冻结、停止置灰。三条白纸黑字让出的正是本条这一格：**发送这个动作本身在服务端不可达时**——本地不许把会话标成「回合中」、5 秒内要说出「发送失败」、草稿不许丢、放行后重发不许出现两条同文用户消息。

本条的真前置只有 `gap-activity-dock-unreachable-degradation`（AC-184）一条，由 frontmatter 的 `depends_on` 显式声明（**唯一**的 gating 面）：AC-185 的判据与 AC-184 共用同一个 spec 文件 `e2e/activity-dock-truthful.spec.ts`（由 AC-184 新建并登记进 `DEBUG_AGENT_SPEC_FILES`），读的也是 AC-184 建出来的 `[data-activity-dock]` 与 `data-activity-state`；在同一条坞元素与同一个文件上并发没有意义，所以本条等 AC-184 落地。AC-182/183 经 AC-184 自己的 `depends_on` 传递进来。本条只要求在**发送失败**这一状态下坞说出「发送失败」且不是回合进行中（AC-187 管的是回合中状态下文案的**来源**，AC-188 管的是**全局各处**状态一致）。

**现状读数（2026-10-01，读代码）。** 提交路径 `src/modules/chat/hooks/useChatComposerState.ts`：`handleSubmit` 在发帧**之前**就无条件 `onSessionProcessing?.(targetSessionId, { statusText: null, canInterrupt: true })`（第 950 行），并 `addMessage(userMessage)`（第 945 行）把用户的用户行乐观地加进转写；随后 `sendMessage({type:'chat.send',…})`（第 961 行），再 `setInput('')`、`inputValueRef.current=''`、`recordSentMessage(...)`、`writeDraftText(draftScope,'')`（第 980-994 行）——**草稿在发帧的同一拍被清掉**。而 `src/shared/context/WebSocketContext.tsx:161-166` 的 `sendMessage` 在 `socket.readyState !== WebSocket.OPEN` 时**只 `console.warn('WebSocket not connected')` 就丢掉这一帧**。于是：socket 已被拒时点发送，本地照样进入「处理中」（坞读本地表与本地钟，`src/modules/chat/composer/ActivityIndicator.tsx:35` 的六词 `DEFAULT_ACTION_WORDS` 照转），帧静默丢失，草稿也没了——这正是 AC 的两个假形态要打红的形态。

**要做的事。** 把「发送」做成一个有交付结果的动作，而不是即发即忘：新增一个纯的**发送阶段状态机** `src/modules/chat/utils/sendDelivery.ts`（`sending → delivered | failed`，时间与定时器经注入，出货超时 5000ms 的常量且可配置），`handleSubmit` 用它替换「发帧即本地打标 + 清草稿」：socket 未 OPEN（或新鲜度已判不可达）时**立即**进 failed，不在本地标 processing；socket 曾 OPEN 但阈值内没有任何该消息的应答（`activity.patch` / 该回合的首帧）时到点进 failed。failed 时：坞进一个**不属于回合进行中**的状态 `send-failed` 并显「发送失败/服务端无响应」文案；草稿**回到输入框**（不清、不写盘空串）；已经乐观加进转写的用户行**撤回或标记未送达**（重发复用它，不新增第二行）。放行并重连后可重发，转写里该文本的用户行**恰好一条**。

## Plan

1. **红态先行。** 在 AC-184 建出的 `e2e/activity-dock-truthful.spec.ts` 里追加一个标题含 `AC-185` 的用例（判据用 `-g "AC-185"` 过滤），复用 AC-184 的夹具与调试 agent 播种，但把 `page.routeWebSocket` 的分区**装在点发送之前**：app 自己的 `/ws` 被拒（`close({code:1006})` 且拒绝重连，§10.2 实测 app 每 3.0 秒重连一次都被拒），此时点发送。实现前该用例红：`data-activity-state` 仍读到一个回合中状态、且草稿被清空。
2. **发送阶段状态机。** 新增 `src/modules/chat/utils/sendDelivery.ts`：导出纯工厂 `createSendDelivery(deps?)`，状态 `sending | delivered | failed`，`begin()` / `ack()` / `fail()` / 定时器到点自动 failed；超时默认 5000ms 出货常量并可用环境变量缩短（照 `QUAY_E2E_DEBUG_AGENT_HOME` 的 per-selection 形状）。时间与定时器经 `deps` 注入，便于 vitest 纯测。
3. **提交路径改造。** `useChatComposerState.ts` 的 `handleSubmit`：发帧前若 socket 未 OPEN / 新鲜度 unreachable，直接走 failed 分支（**不**调 `onSessionProcessing`）；否则 `begin()` 并在 ack 到达时 `delivered`；failed 分支把草稿原样留在输入框（撤掉 `setInput('')` / `writeDraftText(scope,'')` 的乐观清空，改为仅在 `delivered` 时清）。乐观用户行带一个客户端投递标记，failed 时撤回或标记未送达，重发复用同一个客户端 id。
4. **坞与视图。** `data-activity-state` 增加 `send-failed`（**不属于**回合进行中的集合），`activityDockView.ts` 与 `ActivityIndicator.tsx` 渲染「发送失败/服务端无响应」文案（六词一个不出现），并给 composer 一个可重发的入口。状态联合类型加在 `src/shared/types.ts`。
5. **文案。** 「发送失败」「服务端无响应」「重发」三类新键加进 `src/modules/i18n/locales/*/chat.json` **全部 12 个**文件（缺一个就会有 i18n 完整性判据红）。
6. **组件级单元判据（快速反馈）。** 新增 `src/modules/chat/tests/sendDelivery.test.ts`：socket 未 OPEN 点发送 ⇒ 立即 failed、**不**调用 processing 标记、草稿读数不变；socket OPEN 但阈值内无 ack ⇒ 到点 failed；ack 到达 ⇒ delivered 且草稿清空（**正控制**，证明「failed 不清草稿」不是「根本不清草稿」）；用 `vi.useFakeTimers()` 跨阈值边界。AC-184 的 `src/modules/chat/tests/activityDockUnreachable.test.tsx` 补一个 send-failed 用例。
7. **假形态（承重，先提交再变异，`git checkout -- <file>` 恢复，逐字登记变异 diff / 失败行 / 恢复命令）。** (i) 保留发送时的本地打标（仍调 `onSessionProcessing`）⇒ 读数 (i) **必须红**；(ii) 发送失败后清空草稿 ⇒ 读数 (ii) **必须红**；(iii) 去掉 5 秒超时（永远停在 sending / 永不 failed）⇒ 读数 (i) **必须红**；(iv) 重发再 `addMessage` 一行、不撤回未送达行 ⇒ 读数 (iii) **必须红**。任何一条没红按「判据有洞」处理，先补判据再继续。
8. **墙钟。** 用例自己记起止并断言**用例体** ≤ `20_000`ms（打印 `send.wall=…ms`），整次调用须在 `SINGLE_SPEC_CEILING_MS = 55_000` 与 60 秒闸之内；5 秒发送超时用 per-selection 环境变量缩短到亚秒级。
9. **静态门与对齐。** `npm run typecheck`、`npm run lint`、`npx vitest run src/modules/chat/tests/sendDelivery.test.ts` 均退出 0；新测试文件在 `src/modules/chat/tests/` 下（属 boundaries `include`），跨模块 import 一律走 barrel —— 本文件只引同模块深路径，若确需引别的模块，先把符号补进对方 `index.ts` 并写进 `## Touches`；`git diff --stat` 与 `## Touches` 逐条对齐。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"` 退出 0，`--list` 列出该用例。红态基线：AC-184 已建出该 spec 文件但无 `AC-185` 用例，实现前该用例红（本地打标 + 清草稿）。
- [x] AC2 读数 (i)（承重）：socket 先被拒，点发送后 **5000ms 内** `[data-activity-dock]` 的 `data-activity-state` **不是任何回合进行中的状态**（`{sending, thinking, writing, tool, awaitingPermission, compacting, in-turn}` 一个都不出现），且坞内文本含「发送失败」或「服务端无响应」的字样。打印 `send.state.afterSend`、`send.text.afterSend`、`send.latency=…ms`。
- [x] AC3 读数 (ii)（承重）：发送失败后，composer 输入框的值**逐字等于**发送前敲入的草稿（不清空、不回落到空串）。打印 `draft.beforeSend` 与 `draft.afterSend`（须相等）。
- [x] AC4 读数 (iii)（承重）：放行分区并等待重连（§10.2 实测重连间隔 3.0 秒，取 ≤5000ms）后重发同一文本；转写里该文本的**用户行恰好一条**（打印 `transcript.userRows=[…]`，长度必须为 1），且重发这一次 `chat.send` 真的被服务端接受。
- [x] AC5 墙钟：用例体实测 ≤ `20_000`ms（打印 `send.wall=…ms`），整次调用在 55s/60s 闸内退出。
- [x] AC6 假形态必须红（承重）：(i) 保留发送时的本地打标 ⇒ AC2 红；(ii) 发送失败后清空草稿 ⇒ AC3 红；(iii) 去掉 5 秒超时、永不 failed ⇒ AC2 红；(iv) 重发新增第二行、不撤回未送达行 ⇒ AC4 红。逐条记录变异 diff、逐字失败行与恢复命令；任何一条没红按「判据有洞」处理，先补判据。
- [x] AC7 单元判据与静态门：`npx vitest run src/modules/chat/tests/sendDelivery.test.ts` 退出 0（含「socket 未 OPEN 立即 failed 且不调用 processing 标记」「阈值前 1ms 仍 sending / 阈值处 failed」「ack 后 delivered 且清草稿」三组）；`npm run typecheck`、`npm run lint` 均退出 0；`git diff --stat` 只落在 `## Touches` 列出的文件上（新增文件用 ASCII `(new)`）。

## DoD

- 判据驱动的是**真实服务端与真实应用**：`npx playwright test` 起的真实 webServer + Vite 客户端、真实调试 agent 播种的会话、经 `page.routeWebSocket` 装在 app 自己那条 socket 上的拒绝/分区。不接受 in-page 替身、不接受 stub 掉 socket、不接受由 spec 自己往 DOM 写 `data-activity-state`、不接受把 `[data-activity-dock]` 的读数换成读某个内部 React state。
- 「不本地打标」是从行为上读到的：发送失败后 `data-activity-state` 不是任何回合进行中的状态，且**不是**因为构件根本没渲染活动坞（同一次读数里坞元素必须存在且文本非空——正控制）。
- 草稿是**真的还在输入框**（读输入元素的值），不是被写进某个 draft 存储后 UI 里空着。
- 重发的去重是转写层的：该文本的用户行恰好一条，不是靠 CSS 隐藏、也不是靠 `recordSentMessage` 的输入历史去重。
- 5 秒超时是一个出货常量（默认 5000ms），e2e 里只允许用 per-selection 环境变量缩短；测试不把 5000 抄成断言字面量。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- e2e/activity-dock-truthful.spec.ts
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/utils/sendDelivery.ts (new)
- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/utils/activityDockView.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/composer/ChatComposer.tsx
- playwright.config.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/shared/types.ts
- src/modules/chat/tests/sendDelivery.test.ts (new)
- src/modules/chat/tests/activityDockUnreachable.test.tsx
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- tasks/gap-activity-send-unreachable-draft-retry.md
