---
id: gap-fork-from-assistant-reply-anchor
title: fork 按钮从用户气泡挪到 assistant 回复：新增 forkAnchorId（回合末尾 assistant 行），Claude 与
  Codex 同语义
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -il "forkFromHere\|forkAnchor\|createForkedSession\|forkSessionById" tasks/*.md` 只命中已完成的 `gap-lifecycle-mode-matrix-and-host-api`（AC-169，谈的是 fork 不继承 lifecycle_mode，与按钮位置无关）；`gap-session-fork-lineage-list` 只管会话列表的血缘徽标，不碰 transcript 内的 fork 入口。⇒ 无任务认领「fork 入口在哪条消息上」，本条不是重复。

**现状**：fork 按钮只渲染在用户气泡的操作栏里（`src/modules/chat/transcript/MessageComponent.tsx:286`，与「编辑重发」并排），条件是 `message.transcriptAnchorId`。该字段只在 `server/modules/providers/list/claude/claude-sessions.provider.ts:994` 对 `role === 'user'` 的消息写入，assistant 消息没有任何锚点。Claude 的 `upToMessageId`（SDK `forkSession`）按 transcript **文件顺序**包含该行，所以从用户行 fork 得到的是「以这条输入结尾、尚未回答」的会话；Codex 的 `upToAnchorId` 是 turnId，fork 会连带保留这条消息和它得到的回答（`codex-fork.provider.ts` 头注释）。同一个按钮在两个 provider 上语义不一致，且都不是用户想要的「对同一个输出换不同输入」。

**本轮实测读数（决定方案形状，勿再推断）**：
1. 在 3 个真实 resident 会话的 transcript 副本上，对全部 170 个用户输入点跑 SDK `forkSession`：产物悬空 tool_use 为 **0**（含 2 个回合中途插入的输入）；产物全部以该用户行结尾。
2. 真 claude 进程上 resume：以**用户行**结尾的 fork，CLI 在其后插入合成 assistant 回复 `No response requested.` 再接新消息（模型仍记得该输入）；以 **assistant 行**结尾的 fork，模型只记得到该回复为止。两者都能正常 resume。
3. 把会话截在 assistant 的 tool_use 行之后（模拟忙源）做整会话 fork 再 resume：**能 resume**，CLI 自行补处理，模型会在回复里说「之前的调用被中断了」。⇒ 忙源不是硬故障，只是带一个被中断的工具调用。
4. 乐观用户气泡（`useChatComposerState.ts:1064`）没有 `transcriptAnchorId`；锚点来自落盘行，要等 `complete` 触发的 `requestLatestMessages`（`useChatRealtimeHandlers.ts:511` 起）。**未验证**：resident 路径是否每个回合都发 `complete`（`claude-host-driver.provider.ts` 里没 grep 到）。

**方案**：
- **新增 `forkAnchorId`，不复用 `transcriptAnchorId`**。后者被编辑、outline、`LazyMessageRow`、`aroundId` 窗口共用，语义是「用户输入行」；给 assistant 行也写它会牵动这些消费方。`forkAnchorId` 只表示「在这里 fork，得到以这条回复结尾的会话」。
- **Claude**：在 `fetchHistory` 的归一化遍历（已拿到全部行）里，每个回合（两条真实用户提示之间）取**最后一条带文本的 assistant 行**的 uuid，写到该行归一化出的消息的 `forkAnchorId`。末尾那个回合仅当会话不在运行时才写。
- **Codex**：把该回合的 `turnId` 写到该回合最后一条 assistant 消息的 `forkAnchorId`（语义本来就含回答）。
- **前端**：fork 按钮从用户气泡移到 assistant 文本消息的操作栏（与复制按钮同处），条件 `onForkFromMessage && message.forkAnchorId`；用户气泡只保留「编辑重发」；会话运行中隐藏；`ChatInterface.handleForkFromMessage` 改读 `forkAnchorId`。
- **服务端兜底**：`forkSessionById` 带 `upToAnchorId` 时不另做类型校验（SDK 对找不到的 uuid 本就报错）；不带锚点的整会话 fork 保持允许（实测可 resume）。

**不在本任务范围**：fork 是否继承 `lifecycle_mode`（AC-169 与 proposal §13.5 明文规定不继承，另议）；「从某条输入之前分支」（可复用 `resolveEditAnchor`，等需要再立）。

## Plan

1. **前置读数（先于实现，未取到肯定读数不动产品代码）**：确认 resident 路径（`claude-host-driver.provider.ts`）每个回合结束都会让前端收到 `complete` 并触发尾部刷新。读数方式：起真 resident 会话（或判据里的 host driver 替身 + 真 WS），发两轮，记录每轮结束时前端是否收到 `complete`、`requestLatestMessages` 是否被调用。若**不是每回合都有**，把「回合结束时触发一次尾部刷新」并入本任务的实现面并在完成记录写明读数。
2. **判据骨架先红**：在 `claude-sessions.test.ts` / `codex-sessions.test.ts` / 新前端测试里先写出各断言，在当前树上跑出红态文案。
3. **类型**：`server/shared/types.ts` 与 `src/shared/types.ts` 加 `forkAnchorId?: string`（注释写明与 `transcriptAnchorId` 的分工）。
4. **Claude 归一化**：在 `fetchHistory` 遍历里按回合计算并写入；多回合、含 tool_use/tool_result 夹层、末尾回合运行中、回合中途插入的用户输入四种夹具各一条。
5. **Codex 归一化**：turnId → 该回合最后一条 assistant 消息的 `forkAnchorId`。
6. **前端**：`useChatMessages.ts` 把字段带过去；`MessageComponent.tsx` 迁移按钮；`ChatInterface.tsx` 改读 `forkAnchorId` 且运行中隐藏。
7. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑各判据，不做无界 fan-out；写完成记录（含第 1 步读数）。

## AC

- [x] 前置读数已取得并写进完成记录：resident 路径每个回合结束时前端是否收到 `complete`（打印 `residentTurnComplete=<every-turn|not-every-turn>`）；若为 `not-every-turn`，则本任务同时落「回合结束触发尾部刷新」，且下面各项在该实现下成立。
- [x] Claude 归一化：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` 退出码 0，且该文件里新增用例断言——多回合夹具里每个回合恰有**一条**带 `forkAnchorId` 的 assistant 消息，其值等于该回合最后一条带文本的 assistant 行的 uuid；夹在 tool_use 与 tool_result 之间的 assistant 行**没有** `forkAnchorId`；用户消息**没有** `forkAnchorId` 且其 `transcriptAnchorId` 与改前逐字相同（不回归编辑/outline 的锚点）。
- [x] 运行中回合：同文件用例断言，末尾回合在会话运行中读出时**没有** `forkAnchorId`，会话空闲后读出**有**（正控制，防「永远不写」）。
- [x] Codex 归一化：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/codex-sessions.test.ts` 退出码 0，且新增用例断言该回合最后一条 assistant 消息的 `forkAnchorId` 等于该回合 turnId，用户消息不带 `forkAnchorId`。
- [x] fork 产物语义（真 SDK）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-fork.test.ts` 退出码 0，且新增用例在一份含 tool_use 的 transcript 夹具上，用 `forkAnchorId` 作为 `upToAnchorId` fork，产物末行是该 assistant 文本行，且产物里没有悬空 tool_use（打印 `danglingToolUse=0 lastRow=assistant`）。
- [x] 前端：`npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx` 退出码 0（新文件），断言——fork 按钮只出现在带 `forkAnchorId` 的 assistant 文本消息上；用户气泡上**没有** fork 按钮但仍有「编辑重发」；点击后 `api.forkSession` 以 `{ upToAnchorId: <forkAnchorId> }` 调用；会话处于运行中时按钮不渲染。
- [x] 假形态承重：(a) 把 Claude 的写入改回「给 user 行写 forkAnchorId」⇒ 上面 Claude 用例必须红；(b) 在前端把按钮条件改回读 `transcriptAnchorId` ⇒ 前端用例必须红；(c) 把「运行中隐藏」去掉 ⇒ 前端用例必须红。各自还原后转绿，完成记录写出三条的实测红文案。
- [x] `npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出码均为 0（新测试的跨模块 import 全部经 barrel）。

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`）里，经真实浏览器打开一个至少含两个回合的 Claude 会话（其中一个回合带工具调用）：(1) 每个回合的最终回复下出现 fork 按钮，用户气泡上没有；(2) 点击第一个回合回复上的按钮，新会话打开，其 transcript（直接读文件）末行是该回复，且不含第二个回合的任何内容；(3) 在该 fork 里再发一条消息，模型的回答只引用得到第一个回合为止的内容（读回复文本，不是读测试通过与否）；(4) 会话正在运行时，最后一个回合的回复上没有 fork 按钮，回合结束后出现。三处读数连同前置读数一并写进完成记录。若有 resident 会话可用，对一个 resident 会话重复 (1)(2)，记录按钮出现时机相对回合结束的先后。

## Touches

- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/list/codex/codex-sessions.provider.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/services/session-history-cache.service.ts
- server/shared/types.ts
- src/shared/types.ts
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
- server/modules/providers/tests/claude-sessions.test.ts
- server/modules/providers/tests/codex-sessions.test.ts
- server/modules/providers/tests/session-fork.test.ts
- server/modules/providers/tests/claude-resident-process.test.ts
- src/modules/chat/tests/forkFromAssistantReply.test.tsx (new)
- playwright.config.ts
- e2e/transcript-fork-from-answer.spec.ts (new)
- tasks/gap-fork-from-assistant-reply-anchor.md

## 完成记录

### 前置读数（AC1）：`residentTurnComplete=every-turn`

读数取自真 resident 进程 + 真 WS：`npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "three real chat.send rounds" server/modules/providers/tests/claude-resident-process.test.ts` → 退出 0，stdout：

```
[resident] completesBeforeRounds=0 completesPerRound=1,1,1
residentTurnComplete=every-turn
```

该用例的 socket 就是前端的替身（客户端收到 `complete` 后由 `useChatRealtimeHandlers.ts:511` → `:545 requestLatestMessages` 刷新尾部），三个回合各收到**恰好 1** 个终止帧，且没有落在回合窗口之外的帧。为了让读数留在树里而不只是散文，本任务给该用例加了逐回合计数与这一行打印（只加打印，不加断言，不改其通过条件）。

静态佐证：`claude-host-driver.provider.ts` 在每一回合结束都写终止帧——有人值守路径 `createCompleteMessage`（:4306 附近），无人值守路径 `finishUnattendedTurn`（:3655 附近）。

⇒ **本任务不需要另加「回合结束触发尾部刷新」**，AC1 的 `not-every-turn` 分支不触发。

### 各 AC 读数

| AC | 命令 | 结果 |
| --- | --- | --- |
| 2 | `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` | 退出 0，`tests 28 / pass 28 / fail 0` |
| 3 | 同上 | 新增用例 `a running session withholds the final turn's fork anchor, then restores it` 在其中通过（运行中为空、空闲后有值，即正控制） |
| 4 | `... --test server/modules/providers/tests/codex-sessions.test.ts` | 退出 0，`tests 12 / pass 12 / fail 0` |
| 5 | `... --test server/modules/providers/tests/session-fork.test.ts` | 退出 0，`tests 8 / pass 8 / fail 0`，stdout `danglingToolUse=0 lastRow=assistant` |
| 6 | `npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx` | 退出 0，`2 passed` |
| 8 | `npm run typecheck` / `npm run lint` / `npx oxlint server/ src/` | 三个退出码均为 0 |

AC2 新增用例名：`each turn ends with one fork anchor on its final assistant answer`。
AC4 新增用例名：`a Codex turn anchors its last assistant answer with the turn id`。
AC5 新增用例名：`a fork cut at an assistant forkAnchorId ends at that reply with no dangling tool_use`。

### AC7 假形态实测红文案（各自还原后转绿）

**(a) Claude 写入改回「给 user 行写 `forkAnchorId`」**（把归一化里的 `forkAnchorUuids.has(rowUuid)` + 末条 assistant 文本行，换成 `isClaudePromptRow(raw)` + `role === 'user'`）：

```
ℹ tests 2 / ℹ pass 0 / ℹ fail 2
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
+     'user', 'first question', 'u1'
-     'assistant', 'first answer', 'a2'
+     'user', 'second question', 'u3'
-     'assistant', 'second answer', 'a3'
  actual: [ [ 'user', 'first question', 'u1' ], [ 'user', 'second question', 'u3' ] ],
  expected: [ [ 'assistant', 'first answer', 'a2' ], [ 'assistant', 'second answer', 'a3' ] ],
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
+   'u1', 'u3'
-   'a2'
```

**(b) 前端按钮条件改回读 `transcriptAnchorId`**：

```
Test Files  1 failed (1) / Tests  2 failed (2)
AssertionError: the turn-ending answer must offer the fork control; answer row DOM: <div class="w-full">…  (forkFromAssistantReply.test.tsx:372)
AssertionError: once the turn ends, the same answer offers the fork control — so the absence was the running state, not a row that cannot draw it  (forkFromAssistantReply.test.tsx:435)
```

**(c) 去掉「运行中隐藏」（`&& !isSessionRunning`）**：

```
Test Files  1 failed (1) / Tests  1 failed | 1 passed (2)
AssertionError: a reply on a running turn must offer no fork control; answer row DOM: <div class="w-full">…  (forkFromAssistantReply.test.tsx:418)
```

### DoD 实际读数

真实服务实例 + 真实 Chromium，判据文件 `e2e/transcript-fork-from-answer.spec.ts`（新），夹具由 `playwright.config.ts` 的 `seedForkAnchorTranscript` 在 server 启动前写入隔离 HOME；跑法 `npx playwright test e2e/transcript-fork-from-answer.spec.ts`，**1 passed (13.9s)**。走的是**出厂路径全程**：按钮自己的 `onClick` → `ChatInterface.handleForkFromMessage` → `api.forkSession` → `POST /api/providers/sessions/:id/fork` → `sessionsService.forkSessionById` → SDK 真 `forkSession`。

- **(1) 已读**：两个回合的最终回复各**恰有 1 个** `Fork from here` 按钮；两条用户提示上**各 0 个**。夹具的第一个回合带工具调用（thinking + `tool_use` + 其 `tool_result`），第二个回合是纯文本。
- **(2) 已读**：点第一回合回复上的按钮后，目录里出现**恰一个**新 transcript，直接读该文件：末条 message 行是 `[{type:'text', text:'The first answer, about the release notes.'}]`，全文不含第二个回合的提示或回答，且没有悬空 tool_use（`fork-tool-1` 的 `tool_result` 仍在分支里）。新会话确实打开（地址离开了源会话、指向一个新的 36 位 id）。
- **(3) 未读**：需要在 fork 里再发一条消息并由**真模型**作答（DoD 明文要求读回复文本）。本 worker 环境没有可用的真模型端点，夹具是离线 transcript。**没有**用假模型或断言代替——该读数缺，如实记在这里。
- **(4) 未读（浏览器）**：需要在真浏览器里有一个**正在跑的回合**。本任务的离线夹具没有活回合，故未在浏览器读；其组件级等价读数（运行中不渲染、回合结束后同一行渲染出来，且后者是正控制）由 AC6 覆盖并已在上面给出。
- **resident 重复 (1)(2)**：本环境没有可用的 resident 会话来重复；未读。

关于 (3) 与分支上下文的关系，能说的是 (2) 已经直接读到了**分支将要被 resume 的那份文件**——它正是 CLI 会送进模型的上下文——末行停在第一回合的回复。这**不等于** (3)：DoD 要的是模型答复的文本，而那是本环境取不到的读数。
