---
id: gap-transcript-follow-criterion-llm-coupling
title: AC-108/AC-109 的帧来源改由页内 wire double 夹具驱动：判据不再依赖 LLM 客户端（删掉 ANTHROPIC_*
  仍绿），两条 expect 与 GOAL-004 退出条件同批重写，AC-109 退回 active
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

AC-108（真实流式输出全程贴底）与 AC-109（流式期间向上的小幅手势立即脱离）的判据命令都跑 `e2e/transcript-follow.spec.ts`，而这条 spec 制造「流式」的方式是：经 composer 发一条消息 → 服务端 `claude-runtime.provider.js` 的 Agent SDK `query()` → spawn `claude` CLI 子进程 → HTTP 打到 spec 内 mock gateway 的 SSE → CLI stdout → 归一化 → ws → 客户端。也就是说，一条**前端几何**判据的帧来源是一个真实的 LLM 客户端。

2026-09-21 实测：这条判据在 goal ring 里被评估 **101 次、fail 101 次**，从未通过；而它的产品读数（`unpinnedFrames []`、`maxGrowthFrameGapPx 1`、`nodeRuns [1]`、`offBottomFrames 0`）与通过时**逐项一致**。红因不在产品，而在夹具对进程环境的耦合：

- goal 环用 driver anchor 的进程环境 spawn 判据（`runAcceptance({ command: criterion, cwd: root })`，env 继承 anchor）；
- anchor 环境没有 `ANTHROPIC_DEFAULT_HAIKU_MODEL`；
- spec 的 mock gateway 靠**模型 id** 把「本轮回合」与「SDK 自己起标题的请求」分开（`streamReplyFor`：`if (modelId !== AC108_MODEL.id) return null`）；
- 该变量缺省时，起标题那次调用落在**同一个模型 id** 上 → gateway 把两条请求都 streamed → `expect(streamedHits).toHaveLength(1)`（`e2e/transcript-follow.spec.ts:2738-2743`）直接红。

复现证据（本机实测，非推断）：在我的 shell 环境单跑 `1 passed (18.8s)`；换成 anchor 环境 `rc=1`、红在同一句；A/B 对消——从我的环境删掉 `ANTHROPIC_*` ⇒ 红，给 anchor 环境加回 ⇒ 绿；单变量——只给 anchor 环境加 `ANTHROPIC_DEFAULT_HAIKU_MODEL` ⇒ `rc=0`。

同一套 CLI+gateway 夹具还被 AC-109 用着（同文件、同样 New Session + 选 gateway 模型）。AC-109 只是没有对 `streamedHits` 计数（全文件只有 2739-2743 用它），所以在同一环境下侥幸绿——同一个耦合留在了一条已 achieved 的判据里。

**方案：伪造传输/来源，绝不伪造消费者。** 把帧的来源从 LLM 客户端换成**页内 wire double**——在 app 首个脚本前包装 `window.WebSocket`，向 app 自己 new 出来的实例派发真实 `MessageEvent`（data 为服务端同形的 JSON）。该技术在本文件里已被证明可行：现有的 `instrumentStreamFrames`（`:124-143`）就是同一个包装，而 AC-108 读数里的 `stream_delta: 22` 正是它记下的，说明这个包装确实抓到了 app 自己的 socket 实例；本次只是把它从「观察」变成「可注入」。⛔ 帧只能经 socket 的 message 事件进入 app，不得调 `sessionStore`、不得直接改 DOM。

已排除的方案（本轮回合定案，理由一并记下）：

- **transcript watcher 路径**：查证后不成立。watcher 只广播 `broadcastSessionUpsertedBatch`（`sessions-watcher.service.ts:147`），而该事件的自我说明是「everything a **sidebar** needs」（`session-upsert-broadcast.service.ts:11-19`）；客户端 chat 侧对该帧直接 return（`useChatRealtimeHandlers.ts:176`），打开的会话**不会**因此重取消息。pane 的唯一帧生产者是 `chatRunRegistry.startRun`，只被 `chat-websocket.service.ts:228` 调用（chat.send / edit-send）→ provider runtime → LLM 客户端。今天**不存在**「非 LLM、又能让打开中的 transcript 就地增长」的应用内路径，用它当载体等于测一件不会发生的事。
- **服务端 replay 动词**：为测试在生产 WS 协议上新增动词 + 环境守卫，买的是这条**前端**判据没有声称的服务端真实性。
- **最小修**（把 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 写进模型条目 `config.env`）：只让今天的夹具在任意环境稳定，CLI/SDK 仍在环里，SDK 版本一变仍会翻，不满足「判据不依赖 LLM 客户端」。

**覆盖面转移**（AC-108 改完不再承担的部分，逐条交代去向）：

- 「SDK 的 partial frame → 线上 `stream_delta`」：`server/modules/providers/tests/claude-stream-event-unwrap.test.ts`（其导出注释原文即 without a live CLI in the loop）。
- 「`stream_delta` → 订阅者逐帧、带 seq」：`server/modules/websocket/tests/chat-run-registry.test.ts:48-73`。
- 「消息经 composer 真的发到模型端点」：AC-027（GOAL-001，achieved）。
- **唯一无人守的一环**：`claude-runtime.provider.js:963-977` 的 `for await (const message of queryInstance) { … for (const msg of normalized) ws.send(msg) }`——「归一化出来的每一帧真的交给 writer」。已另立 `gap-claude-runtime-frame-forwarding-coverage` 承接（本条不申领）。

实现要点（留给执行者，都是实测过的坑）：

- 播种会话可直接用：`--resume` 要求 UUID 这件事只对 CLI 成立，夹具没有这个约束。AC-106 已在默认 viewport（1280×720，即 `AC108_VIEWPORT`）上滚动同一个种子会话，故**无需**改 `playwright.config.ts`。
- **不要用 `page.clock` 冻结时钟**：`updateStreaming` 每次 flush 重铸 `timestamp`，冻结后 `stampChanges` 恒为 0，机制断言变成不可观测（AC-108 现有注释已记此事）。改用真实时钟 + 250ms 投递间隔。
- goals 的改动落在**主 checkout**（`QUAY_NATIVE_GOAL_DIR` 是绝对路径），worktree 里那份会保持旧文本：写完把 `goals:` 提交 cherry-pick 到任务分支，否则 fan-in 的 ac-gate 读到的是旧 expect。
- ⛔ 不投 `complete` 帧：它会让 app 去服务端刷新一个夹具里不存在的回合。

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本任务要替换的夹具由 [[gap-transcript-follow-on-real-stream]]（done）建立；AC-108 的收窄与其豁免形态出自 [[gap-transcript-follow-finalize-remount-loses-bottom]]（done，已把豁免改回字面量）；手势与翻页语义分别由 [[gap-transcript-follow-small-gesture-detaches]]、[[gap-transcript-follow-prepend-restore-not-reattaching]] 承载（均 done）；几何仪器由 [[gap-transcript-follow-on-content-resize]]、[[gap-transcript-follow-on-pane-shrink]]、[[gap-transcript-follow-browser-scroll-not-user-intent]] 建立。它们与本条 Touches 重叠，由池的 disjointness 门自动串行，本任务不重复申领它们的语义。

## AC

- [x] AC1 新仪器下 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0 且墙钟 ≤ 20s；读数满足 `unpinnedFrames []`、`offBottomFrames 0`、`nodeRuns [1]`、`stampChanges ≥ 20`、`growthStepsInStream ≥ 21`、`minGapPx ≥ -1`（读数行原样贴进完成记录）。
- [x] AC2 判据不依赖 LLM 客户端：`env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0——这正是今天必红的那个条件。
- [x] AC3 夹具里不再有 LLM 面：`grep -cE "createServer|AC108_MODEL|streamReplyFor|transcriptFile|pollutedLines" e2e/transcript-follow.spec.ts` 输出 0。
- [x] AC4 帧只能经 socket 进入 app：`grep -cE "updateStreaming\(|sessionStore\.|setMessages\(" e2e/transcript-follow.spec.ts` 输出 0（注入只经 `window.__injectStreamFrame` 派发 `MessageEvent`）。
- [x] AC5 抗假变体在新仪器上重跑并留输出：(i) 跟随触发信号改回 `chatMessages.length` ⇒ 必红；(ii) 一次性终态（单帧投递全文）⇒ 必红（活性 `growthStepsInStream ≥ 21`）。两者各自完整还原后 `git diff -- e2e/transcript-follow.spec.ts` 为空。
- [x] AC6 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-1"` 退出码 0（AC-106/107/109/110/111 在同一次运行里全绿）。
- [x] AC7 四份记录同步：`goals/AC-109-…md` 的 `status` 退回 `active`；`goals/AC-108-…md` 与 `goals/AC-109-…md` 的 `expect` 重写为夹具驱动表述并含「不含任何模型/CLI/外部服务」；`goals/GOAL-004-…md` 的退出条件中对应两行同步；`grep -c "spec 不存在" goals/AC-108-*.md goals/AC-109-*.md` 均为 0。
- [x] AC8 静态与套件：`npm run lint` 退出码 0、`npm run typecheck` 退出码 0、`bash scripts/test.sh --for-task gap-transcript-follow-criterion-llm-coupling --allow-thin` 退出码 0。

## DoD

真浏览器（真实 bundle + 真实服务）里，一条**不含任何模型、CLI 或外部服务**的夹具把 22 个 `stream_delta` + 1 个 `stream_end` 经 app 自己的 socket 投递给客户端；pane 从最后一行首次增长起到采样结束（含收尾帧）逐帧贴底、两侧都界，行始终是同一个 DOM 节点被反复就地重投影（`nodeRuns [1]` 且 `stampChanges ≥ 20`），采样窗口内行数恒定。两个抗假变体在**新仪器**上各自红过并留输出（旧仪器上的红不算数）。AC-106/107/109/110/111 全绿。四份 goal 记录与新判据一致。「不依赖 LLM 客户端」由 AC2 直接证明（删掉 `ANTHROPIC_*` 仍绿），不靠声明。

## 完成记录

夹具形态：`installWireDouble` 在 app 首个脚本前（`page.addInitScript`）包装 `window.WebSocket`，把 app 自己 new 出来的实例登记下来；`__injectStreamFrame` 只对 URL 含 `/ws` 且 `readyState === 1` 的实例 `dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))`。app 的 `websocket.onmessage` 是属性赋值，事件照常送达，帧因此走完 realtime → store → React 的就地改写路径。会话由 app 自己分配（`POST /api/providers/sessions` → `page.goto('/session/<uuid>')`），不再是播种的 transcript id。全程无 mock gateway、无 SSE、无 claude 子进程、无 `ANTHROPIC_*`。

**AC1 新仪器下 AC-108 单跑**

```
$ npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"
rc=0   wall 18.3s（≤ 20s）   1 passed (17.0s)
```

读数行原样：

```
{"viewport":{"width":1280,"height":720},"paneClientHeight":496,"deltasDelivered":22,"deltaIntervalMs":250,"sessionId":"3e3dad3d-f999-4387-800e-b65a417edc63","samples":404,"sampledSpanMs":6713,"growthSteps":22,"growthStepsInStream":22,"maxLastRowHeightPx":1671,"rowCountsDuringStream":[1],"rowsBefore":0,"minGapPx":0,"maxGrowthFrameGapPx":0,"growthFrameGaps":[{"t":1847,"gap":0,"top":0},{"t":2098,"gap":0,"top":0},{"t":2360,"gap":0,"top":0},{"t":2614,"gap":0,"top":0},{"t":2876,"gap":0,"top":0},{"t":3130,"gap":0,"top":71},{"t":3393,"gap":0,"top":143},{"t":3645,"gap":0,"top":215},{"t":3910,"gap":0,"top":287},{"t":4161,"gap":0,"top":359},{"t":4415,"gap":0,"top":431},{"t":4676,"gap":0,"top":503},{"t":4934,"gap":0,"top":575},{"t":5193,"gap":0,"top":647},{"t":5452,"gap":0,"top":719},{"t":5710,"gap":0,"top":791},{"t":5964,"gap":0,"top":863},{"t":6226,"gap":0,"top":935},{"t":6480,"gap":0,"top":1007},{"t":6743,"gap":0,"top":1079},{"t":7000,"gap":0,"top":1151},{"t":7260,"gap":0,"top":1247}],"lastDeltaAt":7145,"lastStreamGrowth":332,"firstCollapse":-1,"finalizeAt":7402,"settleFrame":341,"streamSpanFrames":327,"unpinnedFrames":[],"nodeRuns":[1],"stampChanges":22,"offBottomFrames":0,"offBottomGaps":[],"unrepairedFrames":[],"postArrivalFrames":0,"postArrivalMaxGap":0,"postArrivalSpanMs":0,"postArrivalRecoveredAtFrame":334,"lastSampleGap":0,"growthTimeline":["7:+135@gap0","22:+72@gap0","38:+72@gap0","53:+72@gap0","69:+72@gap0","84:+72@gap0","100:+72@gap0","115:+72@gap0","131:+72@gap0","146:+72@gap0","161:+72@gap0","177:+72@gap0","192:+72@gap0","208:+72@gap0","223:+72@gap0","239:+72@gap0","254:+72@gap0","270:+72@gap0","285:+72@gap0","301:+72@gap0","316:+72@gap0","332:+96@gap0"],"offBottomDetail":[],"firstGrowthTrace":["5@t1812:top0/h496-c496=gap0,row0,n0,pane0/1,text0/108,col80,node0,stamp-","6@t1827:top0/h496-c496=gap0,row0,n0,pane0/1,text0/108,col80,node0,stamp-","7@t1847:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","8@t1863:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","9@t1877:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","10@t1894:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","11@t1910:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","12@t1927:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","13@t1944:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","14@t1960:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","15@t1976:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","16@t1993:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","17@t2010:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","18@t2026:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","19@t2043:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224","20@t2059:top0/h496-c496=gap0,row135,n1,pane0/1,text398/398,col135,node1,stamp13:50:20.224"],"postArrivalDetail":["331@t7242:top1151/h1647-c496=gap0,row1575,n1,pane0/1,text8029/8029,col1575,node1,stamp13:50:25.382","332@t7260:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","333@t7275:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","334*@t7292:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","335*@t7309:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","336*@t7325:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","337*@t7342:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","338*@t7359:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","339*@t7375:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","340*@t7392:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.640","341*@t7417:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","342*@t7425:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797"],"tailTrace":["396@t8325:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","397@t8342:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","398@t8358:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","399@t8375:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","400@t8392:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","401@t8408:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","402@t8425:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797","403@t8442:top1247/h1743-c496=gap0,row1671,n1,pane0/1,text8428/8428,col1671,node1,stamp13:50:25.797"],"writesAtExcursions":[],"zeroWrites":0,"paneSwaps":["0/1"],"lastRowNodeRun":["0:0-6","1:7-403"],"placeholderFrames":[],"contentHeightMoves":["1729:0->80","1846:80->135","2097:135->207","2359:207->279","2613:279->351","2876:351->423","3129:423->495","3393:495->567","3644:567->639","3909:639->711","4160:711->783","4414:783->855","4676:855->927","4933:927->999","5193:999->1071","5451:1071->1143","5709:1143->1215","5963:1215->1287","6226:1287->1359","6479:1359->1431","6742:1431->1503","6999:1503->1575","7259:1575->1671"],"rowMutationCount":1,"rowMutationTrace":["1838:added:2026-09-21T13:50:20.224Z"],"frameKinds":{"loading_progress":4,"chat_subscribed":4,"stream_delta":22,"stream_end":1},"streamEndTimes":[7402],"finalizeFrames":["7402:stream_end"]}
```

**AC2 判据不依赖 LLM 客户端**

```
$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_HAIKU_MODEL \
      -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL \
      npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"
rc=0   1 passed (17.0s)
```

这正是本任务开头实测必红的那个条件（旧夹具下 rc=1，红在 `expect(streamedHits).toHaveLength(1)`）。旧夹具按模型 id 分辨「本轮回合」与「SDK 自己起标题的请求」，缺 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 时两条请求落在同一 id 上。新夹具没有「请求」这个概念，该变量无从参与。

**AC3 夹具里不再有 LLM 面**

```
$ grep -cE "createServer|AC108_MODEL|streamReplyFor|transcriptFile|pollutedLines" e2e/transcript-follow.spec.ts
0
```

**AC4 帧只能经 socket 进入 app**

```
$ grep -cE "updateStreaming\(|sessionStore\.|setMessages\(" e2e/transcript-follow.spec.ts
0
```

注入路径只有一条：`window.__injectStreamFrame` → `socket.dispatchEvent(new MessageEvent('message', …))`。

**AC5 抗假变体（新仪器上重跑）**

**(i) 跟随的提交期触发信号改回 `chatMessages.length`。** 改 `src/modules/chat/hooks/useChatSessionState.ts` 的 `useLayoutEffect` 依赖 `[judgeTranscriptGrowth, chatMessages]` → `[judgeTranscriptGrowth, chatMessages.length]`（流式是同一行就地改写，长度恒为 1，effect 不再重跑，提交期那次 pin 随之消失）：

```
$ npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"
rc=1
Error: the pane must be at the bottom at every frame of the reply (404 frames sampled, 17 off it)
  at e2e/transcript-follow.spec.ts:2379  →  expect(unpinned).toEqual([])
```

判别读数（同一仪器，只有触发信号变了）：`unpinnedFrames` 17 个（绿时 `[]`），`maxGrowthFrameGapPx` 96（绿时 0），首帧漂移出现在第 6 步增长之后（`6:+135@gap0` → `84:+72@gap71`）。`growthStepsInStream` 仍 22、`nodeRuns` 仍 `[1]`——红的是几何，不是活性。

**(ii) 一次性终态（单帧投递全文）。** 改 AC-108 的投递序列为 `[AC108_DELTAS.join(''), ...AC108_DELTAS.slice(1).map(() => '')]`——第一帧就把全文交出去，其余 21 帧是空片，于是投递计数保持诚实（`deltasDelivered 22`）而增长只剩一步：

```
$ npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"
rc=1
Error: the last row must grow once per delta (22 deltas, 1 growth steps inside the reply's span
of 2 frames; 1 in the whole sample)
  at e2e/transcript-follow.spec.ts:2351  →  expect(growthStepsInStream).toBeGreaterThanOrEqual(21)
```

判别读数：`growthStepsInStream` 1（绿时 22）、`stampChanges` 1（绿时 22）、`maxGrowthFrameGapPx` 1247（绿时 0）。即「帧数对、内容一次到位」的假流式被活性断言拦下。

两者各自完整还原后：

```
$ git diff -- e2e/transcript-follow.spec.ts
（空）
```

还原后又跑了一次 AC-108 复核：rc=0，读数与 AC1 逐项一致（`unpinnedFrames []`、`growthStepsInStream 22`、`stampChanges 22`）。

**AC6 同一文件其余五条**

```
$ npx playwright test e2e/transcript-follow.spec.ts -g "AC-1"
rc=0   6 passed (44.6s)
  ✓ AC-106 … (2.1s)   ✓ AC-107 … (3.2s)   ✓ AC-111 … (1.9s)
  ✓ AC-110 … (5.6s)   ✓ AC-108 … (8.5s)   ✓ AC-109 … (15.0s)
```

AC-109 读数原样：

```
AC-109 readings: [{"label":"wheel","movedUpBy":30,"highestOffsetDelta":0,"detachFrames":79,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":205,"pinnedGrowths":11,"unpinned":[],"settledGap":0},{"label":"keyboard","movedUpBy":434,"highestOffsetDelta":0,"detachFrames":76,"growthsInWindow":5,"paneWrites":[],"pageWrites":[],"buttonVisible":true,"buttonAppearancesInWindow":1,"completionPresent":false,"pinnedFrames":327,"pinnedGrowths":19,"unpinned":[],"settledGap":0}]
```

两个窗口都 `unpinned: []`、`paneWrites: []`、`pageWrites: []`、`settledGap: 0`，按钮在两个窗口里都出现过一次）。

**AC7 四份记录同步**

```
$ grep -h "^status:" goals/AC-109-*.md
status: active                     ← 已从 achieved 退回，新 expect 才会被重新评估

$ grep -c "不含任何模型/CLI/外部服务" goals/AC-108-*.md goals/AC-109-*.md
1  1

$ grep -c "spec 不存在" goals/AC-108-*.md goals/AC-109-*.md
0  0

$ grep -n "wire double" goals/GOAL-004-*.md
- AC-108 由页内 wire double 夹具（不含任何模型/CLI/外部服务：无 mock gateway、无 SSE、无 claude
  子进程、无 ANTHROPIC_* 环境变量）投递的慢速流式输出全程 gap ≤ 1px（走 realtime → store → React
  就地改写的真实路径）。
- AC-109 同一夹具下，流式期间向上 30px 的滚轮手势、以及 PageUp，都立即脱离跟随且此后不被拉回；
  按「Scroll to bottom」后恢复贴底。
```

两处 expect 都把旧的「经 e2e 内的 mock gateway 以 SSE 慢速吐出」换成页内 wire double 的表述，并显式写上夹具不含模型/CLI/外部服务；旧尾部「当前必红：e2e/transcript-follow.spec.ts 不存在」已随之删除。

⚠️ 这两条记录写的是**主检出**的 `goals/`（`QUAY_NATIVE_GOAL_DIR` 是绝对路径），本次已把 `goals:` 提交 cherry-pick 到任务分支（`849ea155`、`d86bf4e0`、`3a713979`、`9027c51b`），两边读数一致。

**AC8 静态与套件**

```
$ npm run lint          rc=0   （输出只有既存 warning）
$ npm run typecheck     rc=0   （tsc --noEmit × 2）
$ bash scripts/test.sh --for-task gap-transcript-follow-criterion-llm-coupling --allow-thin
rc=0
suite-scope-check: PASS — 1 active task(s) scanned…
no scoped test files for gap-transcript-follow-criterion-llm-coupling (thin)
```

「thin」是 e2e-only Touches 集合的正常通过形态，不是门没跑。

**实现要点（留给后来者）**

- 帧里**不发 `seq`**：没有在飞的 provider run，客户端没有「漏了第几帧」可言；谎报一个 seq 会让重连簿记去续一个不存在的回合。
- **不发 `complete` 帧**：它会让 app 去服务端刷新一个夹具里不存在的回合。
- **不用 `page.clock`**：`updateStreaming` 每次 flush 重铸 `timestamp`，冻结时钟后 `stampChanges` 恒为 0，机制断言变得不可观测。改用真实时钟 + 250ms 投递间隔。
- 会话必须是 app 自己分配的 UUID（`POST /api/providers/sessions`）；播种的 transcript id 不是 UUID，`--resume` 会被 CLI 拒（本夹具不经 CLI，但 `page.goto('/session/<id>')` 的会话解析同样只认 app 注册过的）。

## Touches

- e2e/transcript-follow.spec.ts
- goals/AC-108-真实流式输出全程贴底.md
- goals/AC-109-流式期间向上的小幅手势立即脱离跟随且不被拉回-按钮可回到跟随.md
- goals/GOAL-004-对话流在真实浏览器里跟随几何变化-贴底时始终看到最新输出-离开时不被拉回.md
- tasks/gap-transcript-follow-criterion-llm-coupling.md
