---
id: gap-activity-heartbeat-frame-crashes-realtime-merge
title: AC-175 判据红（跨任务回归）：服务端 activity.heartbeat 控制帧无 id，被聊天实时处理当成消息塞进 realtime
  行，removeOptimisticUserEchoes 对 message.id.startsWith 抛 TypeError 中止整次
  merge，cancelled 生命周期事件因此永不渲染「已撤回」——修法两条腿（实时处理不接收非消息帧 + 合并对无 id 行免疫）+ 两腿负控制
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-175
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-02）：`grep -rln '^goal_ac: *AC-175' tasks/` → 恰 1 条 `tasks/gap-claude-resident-busy-send-ui.md`，其 **status=done**（不是 in-flight，按规则不是重复，而是「早先的修复没兜住」的证据，见下）。按机制词扫 in-flight（todo/ready/needs-human）：`appendRealtime` / `removeOptimisticUserEchoes` / `sessionMessageReconciliation` 命中 **0** 条；`activity.heartbeat` 命中 `tasks/gap-activity-dock-unreachable-degradation.md`（`goal_ac: AC-184`, status=ready）——它把心跳帧接进**新鲜度状态机**（`useActivityFreshness.ts`），不碰聊天消息存储；它 ship 的正是这条控制帧，也就正是造成本缺陷的那一半，但它的判据与 Touches 都不含 `useChatRealtimeHandlers.ts` / `sessionMessageReconciliation.ts`。另一条 `tasks/gap-claude-resident-busy-send-ui.md`（AC-175, done）建的是同一判据的 `command_lifecycle` 路径，与本条的帧源不相交。⇒ 无认领者、无重复，本条是同一根帧在另一条消费链上的缺陷。

**判据物与红态基线（本轮直跑，读数不是推断、不是台账尾巴）。** 判据逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`：`npx playwright test e2e/resident-busy-send.spec.ts`。本轮在 HEAD（`5a6278c6`，branch `author`）直跑，退出 **1**，`1 failed / 2 did not run`，红落在主判据 `e2e/resident-busy-send.spec.ts:696`：`Error: expect(received).toBe(expected)` / `Expected: 1` / `Received: 0`（poll 计时 10s 到期，断言形如 `${withdrawnRowSelector}${WITHDRAWN}` 计数）。并列读数逐字来自同一次运行的 stdout：`ui.withdrawnBeforeEvent=false`（点击前不宣告，正确）、`click.dispatched=true`、`cancelPayloads=1`（撤回请求确实到了宿主）——即**帧全对，界面就是没渲染出「已撤回」**。

**机制（本轮定位，含服务端帧源与客户端崩溃栈）。** 同一次运行的页面 console 逐字：

```
[e2e] page console error: WebSocket listener error: TypeError: Cannot read properties of undefined (reading 'startsWith')
    at http://127.0.0.1:30937/src/modules/chat/utils/sessionMessageReconciliation.ts:53:21
    at Array.filter (<anonymous>)
    at removeOptimisticUserEchoes (http://127.0.0.1:30937/src/modules/chat/utils/sessionMessageReconciliation.ts:52:27)
    at computeMerged (http://127.0.0.1:30937/src/modules/chat/hooks/useSessionStore.ts:249:30)
    at recomputeMergedIfNeeded (http://127.0.0.1:30937/src/modules/chat/hooks/useSessionStore.ts:275:17)
    at Object.applyCommandLifecycle (http://127.0.0.1:30937/src/modules/chat/hooks/useSessionStore.ts:674:5)
    at handleEvent (http://127.0.0.1:30937/src/modules/chat/hooks/useChatRealtimeHandlers.ts:224:24)
```

链条逐段：

1. **帧源（新引入）。** `server/modules/websocket/services/activity-heartbeat.service.ts:114-126` 的 `buildActivityHeartbeat(sessionId)` 逐字返回 `{ kind: 'activity.heartbeat', sessionId, bootId, rev, timestamp }`——**没有 `id`**（它是控制帧，不是消息）。它在 `chat.subscribe` 时起拍（该模块头部注释：「`chat.subscribe` 是唯一说『浏览器现在在看这个会话』的消息」），默认 `ACTIVITY_HEARTBEAT_INTERVAL_MS = 5_000`（`:22`）。引入提交 `56b0833d`（AC-182，"emit activity.heartbeat business frames on subscribed sessions"，2026-10-01 22:10 +0800），`9ffe8276` 同模块跟随；两者均在 HEAD（`git merge-base --is-ancestor` 实测 YES）。
2. **消费链一（聊天，没有分支）。** `src/modules/chat/hooks/useChatRealtimeHandlers.ts` 的 `handleEvent`：`activity.heartbeat` **没有任何分支**（本轮 `grep -rn 'activity.heartbeat' src/` → **0** 命中），第一段 switch 不接、`stream_delta` / `stream_end` / `command_lifecycle` / `queued_input_cancel_result` 都不匹配，`shouldPersist` 判真（不是 complete/status/permission），于是走到 `:473 sessionStore.appendRealtime(sid, msg as NormalizedMessage)`——把这条**没有 id 的控制帧当成一条消息**塞进 `realtimeMessages`。
3. **崩溃（一次性污染后续所有合并）。** `pruneRealtimeSupersededByServer` → `removeOptimisticUserEchoes(server, realtime)`（`src/modules/chat/utils/sessionMessageReconciliation.ts:99-118`）里的 `if (!message.id.startsWith('local_'))`（`:106`）对 `undefined` 调 `.startsWith` → TypeError。该异常从 `computeMerged` 抛出、冒泡到 `recomputeMergedIfNeeded`，**中止整次 merge**；此后**每一次**合并（含 `cancelled` 生命周期事件触发的 `applyCommandLifecycle` → `recomputeMergedIfNeeded`）都抛——所以 `cancelled` 到了、`applyCommandLifecycle` 也改了行，但 `slot.merged` 永不刷新，`PendingResidentMessage` 永不重画成「已撤回」。这就是 `spec:696` `Received: 0` 的成因。

**为什么早先那条 AC-175 任务（`df558ecc` 落地，2026-09-28）没兜住。** 它建的是 `command_lifecycle` 从替身方言行 → 产品归一化 → run writer → 客户端那一条路，并在**它自己的树上**跑绿（完成记录：`3 passed (35.4s)`、`cancelPayloads=1`、`ui.withdrawnAfterEvent=true`）。它成立的隐含假设是「realtime 行只会是带 `id` 的 provider 消息」——它自己的三条假形态都长在这个假设内。`activity.heartbeat` 这条控制帧是**另一条任务**（AC-182，`56b0833d`）在**同一根 socket** 上新增的，两条任务的测试面不相交：AC-175 的判据不读心跳语义，AC-182 的判据不读聊天存储的合并。所以这不是「早先修复写错了」，而是「合并层假定了一个它不曾拥有的不变量」——跨任务回归，且 AC-175 的判据是唯一撞上它的证词（它恰好在一个已订阅的忙会话上读一次合并）。

**修法（两条腿，缺一会留洞）。**

- **腿 1（根因）：实时处理不接收非消息帧。** `useChatRealtimeHandlers.ts` 显式识别并**忽略** `activity.heartbeat`（它是 AC-183/AC-184 新鲜度状态机的输入，由 `useActivityFreshness.ts` 自己的订阅消费，不进消息存储）。读数：该帧到达后 `sessionStore` 的 realtime 行数不变。
- **腿 2（防御，承重）：合并对「没有字符串 id 的行」免疫。** `sessionMessageReconciliation.ts` 的 `removeOptimisticUserEchoes` 及 `computeMerged` 读 `id` 的其它处不得假定 `message.id` 是字符串——无 id 的行不是本客户端的乐观回显，原样放过。理由：腿 1 只堵住**今天已知**的这一根帧；只要「一条坏行中止整次 merge」的结构还在，下一根未知控制帧会以同样方式复发，而症状总是落在另一个无关 AC 的判据上。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**（含 `e2e/resident-busy-send.spec.ts:696` 那条 `Expected: 1 / Received: 0` 断言通过），且同一次运行的页面 console 捕获里不再出现该 `startsWith` TypeError。红态基线（本轮直跑）：退出 1、`1 failed`、`spec:696`。
- [x] AC2 帧被忽略（腿 1）：`npx vitest run src/modules/chat/tests/chatRealtimeIgnoresActivityHeartbeat.test.tsx` 退出 0——经 `handleEvent` 喂一条 `{ kind: 'activity.heartbeat', sessionId, bootId, rev, timestamp }`，断言聊天存储 realtime 行数与喂之前**逐字相同**；正控制：同形状喂一条真消息，行数 +1（证明读数非恒空）。
- [x] AC3 合并免疫（腿 2，承重）：`npx vitest run src/modules/chat/tests/sessionMessageReconciliation.test.ts` 退出 0——`removeOptimisticUserEchoes([], [{ id: undefined, …合法字段 }])` 不抛，且该行被原样放过；对照腿：同形状、`id: 'local_…'` 的乐观回显仍被正常退休。
- [x] AC4 负控制（两腿各自承重，先提交再变异、逐条登记 diff 与逐字失败行、`git checkout --` 还原）：(a) 只还原腿 1（心跳帧仍进存储）⇒ AC1 红于 `spec:696` 且 console 重现 TypeError；(b) 只还原腿 2（无 id 行仍使 `removeOptimisticUserEchoes` 抛）⇒ 同红。逐条证明单独失效任一腿都不能让判据绿。
- [x] AC5 无回归：`npx vitest run src/modules/chat/tests/` 全绿；`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 退出 0（per-run 忙时逐帧契约未改窄）。
- [x] AC6 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0。

## DoD

真落地（不只是「测试存在」）：在真 Chromium + 真后端 + 调试 agent 常驻替身场景上按原命令直跑 AC-175 判据，`e2e/resident-busy-send.spec.ts` 退出 0 且三个 test 全过（主判据 + 12 locale 文案 + 墙钟 `< SINGLE_SPEC_CEILING_MS`），完成记录逐字给出 `resident.queuedCard`、`cancelPayloads`、`ui.withdrawnAfterEvent`、`row.textAfter` 与整体 `elapsed` 读数；给出 `ui.withdrawnBeforeEvent=false` 的并列读数，证明修复没有把「点击即宣告」偷偷放回来。两条腿的负控制必须逐条实测并还原，还原后 `git status --short` 干净。页面 console 的 `startsWith` TypeError 必须归零（用判据运行的 console 捕获读数证明，不是「看不见就当没有」）。

## Touches

- `src/modules/chat/hooks/useChatRealtimeHandlers.ts`
- `src/modules/chat/utils/sessionMessageReconciliation.ts`
- `src/modules/chat/tests/sessionMessageReconciliation.test.ts`
- `src/modules/chat/tests/chatRealtimeIgnoresActivityHeartbeat.test.tsx` (new)
- `tasks/gap-activity-heartbeat-frame-crashes-realtime-merge.md`（自触）
