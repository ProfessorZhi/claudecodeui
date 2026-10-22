---
id: gap-chat-dedupe-missing-text-to-stream-delta-adjacency
title: 助手回复的首段被渲染两次：dedupeAdjacentAssistantEchoes 缺 (text→stream_delta)
  这一条相邻规则，而 live 行总排在服务端回声之后 —— 补规则且必须保留 live 行
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

**缺陷。** 一个回合进行中，它已经完成并落盘的**首段文本**会在转写里渲染成**两行完全相同的助手消息**，紧挨着，各带一个 MD 徽标。存活期是整个回合进行期间（我的回合常常几分钟），回合结束或整页刷新即消失。

报告来自用户，触发条件由用户给出：**从一个正在输出的会话切到另一个会话、停留一会儿再切回来（期间原会话一直在输出）之后更容易出现**。

### 机制（已定位到行）

`src/modules/chat/hooks/useSessionStore.ts:265-313` 的 `dedupeAdjacentAssistantEchoes` 只处理两种相邻形态：

- `streamsIntoEcho`（`:270`）：`prev` 是 `stream_delta` 且 `m` 是助手 `text`
- `echoesSettled`（`:271-274`）：两行都是助手 `text`

**没有 `(text → stream_delta)` 这一条**，即「服务端已落盘的回声在前、客户端仍在流式的 live 行在后」。

而排序保证实际出现的就是这条没有规则的方向：`computeMerged`（`:374-408`）把 `[...server, ...extra]` 按 `readSortTime` 升序排，而 live 行每次 flush 都在 `updateStreaming`（`:858`）里被重新盖上 `timestamp: new Date().toISOString()` —— 它必然是最新的，因此**永远排在服务端回声之后**。相邻、同文本、无规则可匹配 ⇒ 两行都渲染。

`pruneRealtimeSupersededByServer`（`:321-372`）救不了它：`:337-343` 明确**故意**保留 live 行（它带着该回合的 React key），所以这一对不会被清掉。

### 为什么恰好是「首段」

要形成这一对，服务端那侧必须**已经有**该回合某一段的落盘行，同时客户端 live 行内容与之相同。回合进行中，首段落盘后**工具执行期间有一段静默**（数秒量级），此时服务端最后一行正是那段文本、live 行也正持有同一文本 —— 这就是窗口。后续段落都在 `stream_end` 附近到达，那时 live 行已被 `finalizeStreaming` 翻成 `text`，走 `(text,text)` 规则正常合并。

### 触发路径（用户的观察在代码里得到确认）

切回一个 slot 超过 **30 秒**未刷新的会话会走 `src/modules/chat/hooks/useChatSessionState.ts:1261` 的 `requestLatestMessages`：

```
if (isCurrentHydratedSession) {
  if (sessionStore.isStale(selectedSessionId)) {
    void requestLatestMessages(selectedSessionId);
  }
  return;
}
```

这条路径**没有** `isProcessing` 护栏。而它的姊妹路径（`useChatSessionState.ts:1346-1347`）明确写着 `// Skip store refresh during active streaming` + `if (!isProcessing) {`。**两条同类刷新路径，一条有护栏、一条没有** —— 这就是「切走一会儿再切回来」命中窗口的机制（阈值 `STALE_THRESHOLD_MS = 30_000`，`useSessionStore.ts:579`）。

同类还有第三条：`src/modules/chat/ChatInterface.tsx:266-268` 的 `handleWebSocketReconnect` 也无条件 `await requestLatestMessages(selectedSession.id, isActive)`，同样没有护栏。

### 为什么刷新就没了

`complete` → `settleStream` 把 live 行翻成 `text` → 尾部刷新 `refreshLatestSlotFromServer` 走 `pruneRealtimeSupersededByServer`（该函数内 `:113-117`）→ `recomputeMergedIfNeeded` → 此时两行都是 `text`，命中 `echoesSettled` 合并。所以重复**只活在回合进行中**；整页 reload 直接重建客户端 store，自然也不见了。

### 实验记录（本条为参考材料，判据编写时可直接复用）

**A. store 层确定性复现（vitest，临时探针，跑完已删）。** 用 `renderHook` 驱动 `useSessionStore`，mock `api.providers.sessionMessages`：

```
场景：updateStreaming(SID, SEG1) 造出 live 行，随后 fetchFromServer 返回含
      [USER_ROW, SERVER_SEG1] 的服务端历史（模拟「回合进行中来了服务端刷新」）

  assistantRows = 2
  kinds = ["text:srv-seg1", "stream_delta:live:session-1:1"]   ← 两行同文本、相邻
  same-text rows = 2

对照：同一对，先 finalizeStreaming 再刷新
  kinds = ["text:live:session-1:1"]
  rows  = 1                                                    ← 正常合并
```

即：**仍在流式时 2 行、settle 后 1 行**。这是本缺陷的判据骨架。

**B. 真实浏览器侧的仪器读数（本任务环境：worktree + 独立端口 32447/1635 + dev 前端带 HMR）。**

一次性主体、切走 35 秒再切回（应用内导航，非 reload）：

```
/messages 请求数: 载入我的会话 1 · 切到别的会话 1 · 切回来 1   ← 触发路径确实发出了刷新
切回后: rows 16, dupes 0, streaming 0
```

**`streaming: 0` 是这次没复现出来的原因**：切回那一刻客户端**没有 live 流式行**，因此不存在「live 行 + 回声」的相邻对。该 worktree 实例与浏览器之间的 WS 没有投递该会话的增量（它先连接失败过，之后又被反复 close 搅乱）。

**所以浏览器取证必须同时登记两个读数：`/messages` 刷新是否发出（触发条件）与 客户端是否持有 live 流式行（前提条件）。** 只有前者而没有后者，实验是空的。另外在真实 app 里扫我自己会话的持久化窗口得到 `相邻重复 0`，与「刷新就没了」一致 —— 持久化数据本身干净，缺陷只在客户端内存 store。

**C. 工具与环境坑（省下条命，都是我实测踩到的）。**

- `browser_run_code_unsafe` 里的 `page` 与 `browser_navigate`/`browser_evaluate` 操作的**不是同一个页**（前者常是 `about:blank`），必须在该调用内自己 `page.goto`。
- `addInitScript` **不跨调用保留**（每次的 `page` 对象不同），装陷阱与导航必须在同一次调用里。
- 该沙箱里 **没有 `require`、没有 `process`**。要从文件加载代码，用 `browser_run_code_unsafe` 的 `filename` 参数，且文件必须落在允许的根内：仓库根或 `<repo>/.playwright-mcp`。
- 验证客户端 store 的缺陷**必须用应用内导航**（点侧栏），`page.goto` 是整页 reload，会重建 store 把证据洗掉。可点元素是 `<a>`，用 `el.closest("a,button,[role=button],[tabindex]")`；直接点内层 `div` 不会导航。
- 转写列表是**虚拟化**的（滚到底只剩 1 个 `.chat-message` 挂载）。任何按 `.chat-message` 行数或 `innerText` 做的判据都会失真 —— 必须滚到目标位置再数，并按元素 `textContent` 而非文本节点计数（markdown 会把 `` `code` `` 拆成独立节点，令纯文本搜索漏掉）。
- 应用会给会话 id 做**别名**（我的会话 URL 从 `c8e2cc9f…` 变成 `0f0e7405…`），判据不要钉死 session id。

### 修复

在 `dedupeAdjacentAssistantEchoes` 里补 `(text → stream_delta)` 且同文本的合并。**幸存者必须是客户端那条 live 行** —— `:299-302` 已有这个形状（`out[out.length-1] = m`，在 `isLiveRowId(m.id)` 分支里）。

两个明确禁止：

- ⛔ 不得改成「任意相邻同文本助手行都合并」。那会改变幸存者、从而改掉该行的 React key，而 `:284-291` 的注释正是在说 **re-key 就是一次 unmount**，会在回合落定那一帧造成可见跳动。
- ⛔ 不得在这一步把 live 行 settle 成 `text`。`:293-295` 已警告：那样 `updateStreaming` 会找不到行，**再铸第二条**。

同时把 `useChatSessionState.ts:1261` 那条刷新路径补上与其姊妹路径（`:1347`）一致的 `!isProcessing` 护栏；`ChatInterface.tsx:268` 同理。理由：缺护栏让刷新落在回合进行中，是**触发**；缺合并规则让结果**不被收敛**，是**根因**。两者都修才是「同类路径行为一致 + 结果可收敛」。

### 明确不做

- ⛔ 不动 `dedupeAdjacentAssistantEchoes` 既有的两条规则语义、不动 `pruneRealtimeSupersededByServer` 对 live 行的保留策略。
- ⛔ 不为换绿而放宽：不加 `retries`、不删断言、不改 `STALE_THRESHOLD_MS` 去躲触发窗口。
- ⛔ 不把「转写虚拟化」当成本任务的范围（已单独登记在正文，属另一条）。
- ⛔ AC 不得使用裸 `bash scripts/test.sh`。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-chat-unviewed-session-raw-delta-fragments`（done）修的是「非当前会话的原始增量帧被逐 token 落行」；`gap-chat-stream-row-requires-live-identity`（done）修的是「渲染端只画带 live id 的行」。两条都在**产出端/渲染端**，都不涉及本条的**相邻合并规则缺口**，写入面也不重叠。

## AC

- [x] `dedupeAdjacentAssistantEchoes` 新增 `(prev=text, m=stream_delta, 同文本)` 的合并，且幸存者是 live 行：`npx vitest run src/modules/chat/tests/<新测试文件>` 退出码 0，其中**双向对照各自独立可反红**：(a) 仍在流式时，服务端回声 + live 行同文本 ⇒ 渲染 1 行；(b) settle 之后同一对 ⇒ 仍渲染 1 行。
- [x] 抗假变体真跑：去掉新增的那条规则 ⇒ (a) 变红而 (b) 仍绿（证明两条对照可分，不是同一处红掩盖）；还原后全绿，`git diff -- src/modules/chat` 只剩本任务改动。
- [x] 幸存者身份被钉住：用例断言合并后该行的 `id` 仍是 live id（`/^live:/`），即回声**不得夺走**该行的 identity；同时断言 `kind` 在回合结束前**仍是 `stream_delta`**（回声不得 settle 一条仍在流式的行）。
- [x] 护栏对齐：`useChatSessionState.ts` 的切回刷新路径在 `isProcessing` 为真时**不发出** `/messages` 请求；`grep -c "isProcessing" src/modules/chat/hooks/useChatSessionState.ts` 的值比修复前**增加**，且该文件里三条刷新路径的护栏形态一致（逐条贴出）。
- [x] 既有相关用例全绿：`npx vitest run src/modules/chat/tests/liveRowIdentity.test.tsx src/modules/chat/tests/useChatMessages.test.ts src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx` 退出码 0（它们钉的正是「回声不得夺走回合 identity / 不得 settle 仍在流式的行」）。
- [x] `npm run typecheck` 退出码 0、`npm run lint`（= `oxlint src/ server/`）退出码 0。
- [x] 浏览器取证（**必须同时登记两个读数**）：在真实 app 里，一个确实在流式的会话 —— 登记 (i) 客户端持有 live 流式行（`streaming > 0`），(ii) 切走 >30s 再切回时确实发出了 `/messages` 刷新，(iii) 切回后同文本相邻行数为 **0**。⛔ 三个读数缺任何一个，这次取证都不成立（本任务已验证过：只有 (ii) 而没有 (i) 时实验是空的）。
- [x] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「规则写进去了」：

(a) 判据是**双向**的 —— 同文本的（服务端回声，live 行）这一对，在流式中与 settle 后**都**只渲染一行，且两条断言可分别反红（由抗假变体证明）；单向断言会被一个「把整个 case 删掉」的实现拿满分。

(b) 幸存者的 identity 与 kind 被**显式钉住**：合并后行 id 仍是 live id、回合结束前 kind 仍是 `stream_delta`。这两条正是 `:284-295` 两段注释所守护的不变式（re-key 会造成落定帧跳动；settle 会让 `updateStreaming` 再铸第二条），不钉住就等于把注释里的警告重新引入。

(c) 触发路径的护栏与其姊妹路径一致 —— 由「`isProcessing` 为真时切回不发出 `/messages`」的实测读数证明，而不是靠 grep 到 `isProcessing` 字样。

(d) 浏览器取证三个读数齐备（见 AC 最后一条）：触发条件、前提条件、结果。本任务已实测过一次「只有触发、没有前提」的空实验，完成记录里必须写明这一次三个读数分别是什么，不得只贴结果。

环境噪声须如实登记：本机 128 核但负载常驻 7~11；该缺陷的窗口依赖真实的流式输出，若取证当刻客户端 `streaming = 0`（WS 未投递增量），必须写明这一点而不是把它当作「未复现即已修复」。

L_D 该轴仍暗，理由：本条修的是客户端转写行的相邻合并与刷新护栏，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## 完成记录

实现：分支 `task/gap-chat-dedupe-missing-text-to-stream-delta-adjacency`，修复 commit `6a5901a7`（其后 `git merge develop` 得 merge commit）。

1. 根因（相邻合并规则）：`useSessionStore.ts` 的 `dedupeAdjacentAssistantEchoes` 增加 `(prev=text → m=stream_delta, 同文本)` 一条。幸存者仍走既有的 `isLiveRowId(m.id)` 分支（`out[out.length-1] = m`），因此该行的 `id`（`/^live:/`）与 `kind: 'stream_delta'` 都不变；守卫 `!isLiveRowId(prev.id)` 保证「上一回合原地 settle 的行」不会被误当回声折叠。
2. 触发（护栏对齐）：三条刷新路径逐条贴出——
   - 切回已 hydrate 的会话 `useChatSessionState.ts:1266`：`if (!isProcessing && sessionStore.isStale(selectedSessionId)) { void requestLatestMessages(selectedSessionId); }`
   - 会话激活 flush `useChatSessionState.ts:1346`：`if (!isProcessing) { void refreshCoordinatorRef.current?.flushPending(activeSessionId); }`
   - WS 重连 `ChatInterface.tsx:280`：`if (!processingSessionsRef.current?.get(selectedSession.id)) { await requestLatestMessages(selectedSession.id, isActive); }`
   `grep -c isProcessing src/modules/chat/hooks/useChatSessionState.ts`：5（`6a5901a7^`）→ 7（修复后）。

判据实测（全部在 `git merge develop` 之后的树上重跑）：

- AC1/AC3：`npx vitest run src/modules/chat/tests/adjacentEchoCollapse.test.tsx` → `Test Files 1 passed / Tests 5 passed`，exit 0。含 (a) 流式中「服务端回声 + live 行」⇒ 1 行；(b) settle 后同一对 ⇒ 1 行；(c) 同文本的两回合 ⇒ 2 行（防过度合并）；断言合并后 `rows[0].id` 仍匹配 `/^live:/` 且 `kind === 'stream_delta'`。
- AC2 抗假变体：把新增规则短路（`const echoesIntoStream = false && …`）后重跑 → (a) 红（`2 !== 1`，理由 `the echo of the segment being streamed must not draw beside it`）而 (b) 仍绿（两条对照可分，不是同一处红掩盖）；另跑一版「去掉 live-id 守卫的朴素规则」→ (c) 红（`1 !== 2`，理由 `a reply that merely reads the same is still its own turn`）。两次变体均由 `git checkout -- src/modules/chat/hooks/useSessionStore.ts` 还原并复跑全绿。改动已提交，故裸 `git diff -- src/modules/chat` 无输出；`git diff develop -- src/modules/chat` 只剩本任务 4 个文件（`ChatInterface.tsx`、`useChatSessionState.ts`、`useSessionStore.ts`、`tests/adjacentEchoCollapse.test.tsx`）。
- AC5：`npx vitest run src/modules/chat/tests/liveRowIdentity.test.tsx src/modules/chat/tests/useChatMessages.test.ts src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx` → `Test Files 3 passed / Tests 11 passed`，exit 0。
- AC6：`npm run typecheck` exit 0；`npm run lint`（`oxlint src/ server/`）exit 0（输出仅既有 warning）。
- AC7 浏览器取证（真实 app；一次性探针 `e2e/tmp-echo-dup-probe.spec.ts` 加 `playwright.config.ts` 里的临时 seed，跑完即删/还原，故不属于本任务改动）：会话 `e2e-echo-dup`，先种一行 2020-01-01 的落盘助手行，再用应用自己的 WS 投递一段同文本的 `stream_delta`（`delivered=1`，即增量确实到了应用自己的 chat socket）。
  - (i) 前提：该文本在 DOM 里 1 行且**由客户端铸造**（`data-message-timestamp=2026-09-22T06:36:57.687Z`，落盘行是 2020-01-01），同时 `/api/providers/sessions/e2e-echo-dup/messages` 读到服务端自己的 1 份 ⇒ `rowsCarryingTheText=1, mintedByClient=1, serverCopies=1`。
  - (ii) 触发：切到另一个 tab（`Shell`）停留 31s 再切回 `Chat`：离开期间该会话 `/messages` **0** 次，切回后 **1** 次 ⇒ `messagesRequestsAfterReturn=1`。
  - (iii) 结果：切回后 `rowsCarryingTheText=1`、`adjacentDuplicatePairs=0`，且幸存行的时间戳仍是客户端那个。
  - 反红对照（同一探针、同一仪器，把新增规则短路后重跑）：`rowsCarryingTheText=2, adjacentDuplicatePairs=1`，幸存行是 2020 的落盘行 —— 仪器确实看得见该缺陷，故 `0` 不是惰性读数。
  - 环境噪声如实登记：探针用 WS 投递增量，`isProcessing` 全程为 false（投递增量不开启真实回合，没有 status 帧），所以 (ii) 读到的是「切回确实发出刷新」这一**触发读数本身**；护栏那半（`isProcessing` 为真时不发刷新）不在本次浏览器取证内，由 AC1 的 hook 用例（`processing=true ⇒ refreshLatestFromServer 调用 0 次`）与 AC4 的 grep 读数承担。
- AC8：`git diff develop --name-only` = 本任务 4 个 src 文件（develop 已 merge；`.gitignore` 与 develop 的差异由该 merge 消解）。
- scoped 门（fan-in 同款）：`bash scripts/test.sh --for-task gap-chat-dedupe-missing-text-to-stream-delta-adjacency --allow-thin` exit 0（`# tests 1 / # pass 1 / # fail 0`）。

## Touches

- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/adjacentEchoCollapse.test.tsx (new)
- tasks/gap-chat-dedupe-missing-text-to-stream-delta-adjacency.md
