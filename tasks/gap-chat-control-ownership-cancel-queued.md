---
id: gap-chat-control-ownership-cancel-queued
title: AC-198 归属校验单入口抽取与 cancel-queued 规整：回执带 requestId、归属不符 ⇒ forbidden 不调驱动，既有用例全绿
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-chat-stop-task-event-confirmed
  - gap-chat-background-task-foreground-tooluse
goal_ac: AC-198
---
## Proposal

**这条是什么。** AC-198 的判据逐字（`goals/AC-198-*.md`）：先要求三个判据文件存在——新增的 `server/modules/websocket/tests/chat-control-ownership.test.ts`（当前 **ABSENT**，判据红），以及既有的 `chat-edit-send.test.ts`、`chat-permission-mode.test.ts`；随后 `npx tsx --tsconfig server/tsconfig.json --test` 三个文件一起跑。它要把控制面的「归属校验」抽成**单一入口**，并让既有的 `chat.cancel-queued` 与两个新动词（AC-196 的 `chat.stop-task`、AC-197 的 `chat.background-task`）**走同一个函数**；同时给 cancel-queued 补齐**请求关联**（回执带 `requestId`）与**归属校验**（不符 ⇒ `forbidden` 且**不调用驱动**）。设计来源：`docs/proposals/claude-session-activity-dock.md` §4.11（「与 chat.cancel-queued 同构，但补上请求关联与归属校验」）、§4 细节（「已裁定：新动词必须带归属校验，并顺带给 cancel-queued 补齐同样的校验与 requestId」）、§0.1-2 人 yale 2026-10-01 裁定。

**今天的缺口（读代码）。**
- `chat.cancel-queued` 的处理函数 `handleChatCancelQueued`（`server/modules/websocket/services/chat-websocket.service.ts:548`）只做 `readRequiredSessionId` + `messageUuid` 校验 + `sessionsDb.getSessionById`，**没有 userId 归属校验**，**没有 requestId 入参**；回执 kind `queued_input_cancel_result`（同文件 :588）只带 `{sessionId, messageUuid, result, timestamp}`。
- dispatch（同文件 :820 附近的 `case` 表）把 `chat.cancel-queued` 交给 `handleChatCancelQueued(ws, data, dependencies)`，**没有把 `userId` 传进去**（`userId` 在 :798 从 request 读出，只喂给 `chat.edit-send`/`chat.send`）。
- 全仓库 **没有** `assertSessionAccess`（`grep -rn "assertSessionAccess" server/ src/` 只在 `tasks/` 命中，生产代码 0 命中）——单入口由 AC-196 定义，本条复用。
- 判据文件 `server/modules/websocket/tests/chat-control-ownership.test.ts` **ABSENT**；`chat-edit-send.test.ts` 与 `chat-permission-mode.test.ts` 存在且当前全绿。

**接口（本条钉死，供判据断言；与 AC-196/197 同族）。**
- `chat.cancel-queued` 入参新增**必填** `requestId`（非空字符串）；缺 ⇒ `sendProtocolError(ws, 'REQUEST_ID_REQUIRED', ...)`。缺 `sessionId` / `messageUuid` 各自的既有协议错误保持不变。
- 处理函数在**解析/调用驱动之前**先过**单一归属入口**（AC-196 定义的 `assertSessionAccess(userId, session)`）；不符 ⇒ 回执 `{ kind: 'queued_input_cancel_result', sessionId, messageUuid, requestId, result: 'forbidden', timestamp }` 且**直接返回，绝不调用 `dependencies.runtime.cancelQueuedInput`**。
- 通过 ⇒ 照旧调用 `dependencies.runtime.cancelQueuedInput(provider, sessionId, messageUuid)`；回执 kind **保持 `queued_input_cancel_result` 不变**（`src/modules/chat/hooks/useChatRealtimeHandlers.ts:471` 依赖该 kind 丢弃这类控制帧；换成 `control_result` 会让前端把它当普通消息追加，属回归），字段扩为 `{sessionId, messageUuid, requestId, result, timestamp}`，`result ∈ 'withdrawn' | 'already-started' | 'unknown' | 'forbidden'`。
- **单入口可观测（判据的关键缝）**：把归属校验放进 `ChatWebSocketDependencies`（如 `assertSessionAccess`，生产默认值 = AC-196 的同一实现），三个处理函数都经它调用。判据用一个**计数 spy** 注入该依赖，连续驱动 `chat.stop-task`、`chat.background-task`、`chat.cancel-queued`，断言三者都命中了**同一个**入口（各恰好一次），且归属不符时三者都回 forbidden 型回执、都不调用各自驱动。若 AC-196 已把入口做成可注入的同一形态，直接复用其 seam，不另起第二套。
- **真实归属不符臂**：仅注入放行/拒绝 spy 不足以证明生产入口会拒绝非归属者。判据还须用**生产入口**构造一次真不符（按 AC-196 落地的归属模型：单租户下最可能是「连接上是否有已认证 userId」——不符臂 = 不带 `user` 的 socket，即 `readRequestUserId` 得 `null`；若 AC-196 引入会话 owner，则不符臂 = 另一个 user），断言 `forbidden` + 驱动零调用。**不得**用「stub 直接返回 false」冒充归属不符。
- 前端 `src/modules/chat/ChatInterface.tsx:404` 的 `handleWithdrawResidentCommand` 补一个 `requestId`（`crypto.randomUUID()` 等），否则必填校验会让真实撤回路径被协议错误拒绝。

**假形态（写进判据，证明主断言有分辨力）。**
- **省略 cancel-queued 的归属校验**（把入口调用拿掉或永远放行）⇒ 归属不符的 forbidden 用例必须红：spy 未被命中、或回执不是 `forbidden`、或 runtime stub 记录到了驱动调用。
- 归属校验**不复用同一入口**（cancel-queued 自己内联一套、stop-task/background-task 各写一套）⇒「三者命同一个入口」的断言必须红。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-04，读任务库与代码）。** `grep -rn "goal_ac: *AC-198" tasks/ goals/` → **0 命中**。机制词扫描 `grep -rln "chat-control-ownership" tasks/` → **0 命中**；`test -f server/modules/websocket/tests/chat-control-ownership.test.ts` → **ABSENT**。相关但不同机制的在飞任务：`gap-chat-stop-task-event-confirmed`（AC-196，停止动词与 `chat-stop-task.test.ts`）、`gap-chat-background-task-foreground-tooluse`（AC-197，转后台与 `chat-background-task.test.ts`）——两者都在自己的「接口」段里逐字把 `chat.cancel-queued` 的规整与「同一入口」断言让给 AC-198（本条实现的正是那一段），是不同判据文件、不同机制。`gap-activity-lease-parity`、`gap-resident-turn-phase-keyed-by-provider-id` 等只在正文里引用 AC-198 作为背景，均未认领。⇒ 不是重复。

## AC

- [x] `test -f server/modules/websocket/tests/chat-control-ownership.test.ts` 退出 0（判据文件落地）。
- [x] 判据逐字命令全绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-ownership.test.ts server/modules/websocket/tests/chat-edit-send.test.ts server/modules/websocket/tests/chat-permission-mode.test.ts`。
- [x] 新用例断言：cancel-queued 回执带 requestId（`frame.requestId === <sent>`）。
- [x] 新用例断言：归属不符 ⇒ `result === 'forbidden'` 且 runtime stub 的 `cancelQueuedInput` 调用次数为 0。
- [x] 新用例断言：三者（stop-task / background-task / cancel-queued）都命中同一注入入口（计数 spy 各 1 次）。
- [x] 既有 chat-edit-send 与 chat-permission-mode 保持绿；若因多了 requestId 字段需同步，只把字段加进期望，不得放宽成忽略整个字段。
- [x] 假形态实测：临时移除 cancel-queued 的归属校验，ownership 用例出现红（留输出），恢复后转绿。

## DoD

真实落地：不是「测试文件存在」。判据命令在 quay fan-in 中由红转绿，且三条断言跑在**真实 WS 网关**上（`handleChatConnection` + 假 socket + 注入 runtime stub，与 `chat-edit-send.test.ts` 同一套路），不是对入口纯函数的单元测试。前端 `ChatInterface.tsx` 的撤回调用真的带上 requestId（真实路径不被协议错误拒绝），`useChatRealtimeHandlers.ts` 的 kind 丢弃分支不变。假形态（去掉归属校验）实测为红并留证。下一轮 driver 通过 `goal_ac: AC-198` 能独立核验。

## Touches

- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/tests/chat-control-ownership.test.ts (new)
- server/modules/websocket/tests/chat-edit-send.test.ts
- server/modules/websocket/tests/chat-permission-mode.test.ts
- server/modules/providers/tests/claude-resident-busy-input.test.ts （AC-163 判据，也是 chat.cancel-queued 的真实客户端：该动词现在必填 requestId，本文件的 requestWithdrawal 须同步补上）
- src/modules/chat/ChatInterface.tsx
- tasks/gap-chat-control-ownership-cancel-queued.md

归属入口的落点若与 `chat-websocket.service.ts` 不同（AC-196 另有裁定，例如放到 `server/modules/sessions/` 的公开面），实现时把那个具体模块文件一并写进本段。

## Evidence

判据（2026-10-04，worktree 实测）：

- `npx tsx --tsconfig server/tsconfig.json --test` 三文件：18 tests / 18 pass / 0 fail。
- 读数（criterion 自带 `say` 行）：
  - AC3 `granted={"kind":"queued_input_cancel_result","requestId":"<uuid>","messageUuid":"msg-owned","result":"withdrawn","driverCalls":1}`
  - AC4 `denied={"result":"forbidden","requestId":"<uuid>","driverCalls":0}`（生产入口，匿名 socket）
  - AC2 `missingRequestIdCode=REQUEST_ID_REQUIRED`
  - AC5 `{"stopCalls":1,"backgroundCalls":1,"cancelCalls":1,"total":3}`（三者命中同一注入入口各 1 次）
  - AC5 forbidden `{"results":{"stop":"forbidden","background":"forbidden","cancel":"forbidden"},"entryCalls":3,"drivers":{"stop":0,"background":0,"cancel":0}}`
- 假形态实测（AC7）：临时把 cancel-queued 的 `accessEntry(dependencies)(userId, session)` 换成 `if (false)`，criterion 转红——`AssertionError: an unauthorized request must answer forbidden (got withdrawn)`；`chat.cancel-queued must go through the shared entry exactly once`；forbidden 臂 `cancel:"withdrawn"` / `entryCalls:2` / cancel driver 1。恢复后转绿（3/3 pass）。
- 邻接控制动词回归：`chat-stop-task.test.ts` + `chat-background-task.test.ts` 一并跑，30 tests / 30 pass / 0 fail。
- 类型：`tsc -p server/tsconfig.json` 与 `tsc -p tsconfig.json` 均 exit 0；`oxlint` 改动文件 exit 0（仅存量 memoization warning）。

**兄弟判据回归修复（2026-10-04，本轮）。** `chat.cancel-queued` 必填 `requestId` 后，既有 AC-163 判据
`server/modules/providers/tests/claude-resident-busy-input.test.ts` 的 `requestWithdrawal` 仍按旧协议发
（无 `requestId`），网关以 `REQUEST_ID_REQUIRED` 拒绝、不再回 `queued_input_cancel_result`，于是该文件在
全量 suite 转红（`__PERFILE_KIND__ kind=assert`，读数 `cancelControlFrame=null` / `cancelResult=no-verdict-frame`）。
它不在本任务原 `## Touches` 内，**scoped 门看不见它**（[[scoped-gate-file-set-is-touches-test-bullets-only]]）。
修复 = 给该客户端补上 `requestId: withdraw-<messageUuid>`（与前端 `ChatInterface.tsx` 同一契约），并把该文件
写进 `## Touches`。单跑该文件 1/1 绿：`cancelControlFrame={"type":"control_request","request":{"subtype":"cancel_async_message",...}}`、
`cancelResult=withdrawn`、`command_lifecycle.state=cancelled`、`textInAnyTurn=false`。
