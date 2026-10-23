---
id: gap-activity-dock-heartbeat-never-clears-turn-anchor
title: 活动坞卡在 Working…：心跳帧从不携带 turn 快照，本地回合锚点永不清除（新建会话首条消息必现，刷新才消失）
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

**症状（人报 + 本轮实测复现）。** 在真实部署上新建一个会话、发首条消息，回合早已结束、助手回复已经渲染，坞却**永久停在 `Working…`**，已用时间一秒一秒往前爬，Stop 按钮保持可点；**刷新页面才消失**。同一会话的**第二条**消息不出现这个现象。

**取数环境（本轮直跑，读数不是推断）。** 部署是 transient systemd user unit `claudecodeui-server.service` → `node dist-server/server/index.js`（pid 1007215），监听 `0.0.0.0:3001`；入口 chunk `dist/assets/index-C1fMtsnH.js`（2026-10-03 09:22 构建，服务 09:23:40 起）。浏览器为 playwright MCP，取数于 2026-10-03 11:19–11:35 CST。

**三个会话的读数（同一部署）。**

- `e2d9cef9`（「活动坞验证」）——首条消息 11:19:31 发出；SDK 转写 `086e0591` 里 `assistant end_turn` 落在 **11:19:35.769Z**（+ 一条 `cost-state`）；坞此后一直 `Working…`，最后一次读数 **4m 55s**；刷新后消失。
- `b185b48e`（「会话控制」，正控制）——首条消息 11:28:13；服务端 host `state: closed` / `closeReason: released` / binding `state: idle`、`lastActivityAt` **11:28:25**；坞仍 `Working… 1m 10s`。
- `e7e84203`（取证轮，装了 WebSocket 帧记录器）——首条消息 11:34:36；坞自报 `data-activity-state="in-turn"`、`data-activity-phase="idle"`、`data-activity-elapsed-ms="125040"`，文案 `Working…`。

**服务端是对的，坞在说谎（同一时刻的三份读数）。** `GET /api/providers/sessions/running` 只含 `394523bd`（当前交互会话）；两个新建会话**都不在**运行列表里。`GET /api/session-hosts` 对 `b185b48e` 给出 `state: closed` / `closeReason: released` / binding `state: idle`。**负控制**：`e2d9cef9` 在 11:25:19 发第二条消息，坞正常退场，无 `Working…`、无 Stop。

**心跳帧铁证（`e7e84203` 轮，页面内 WebSocket 录音，12 条）。** 从 03:34:40Z 到 03:35:25Z 的**每一条** `activity.heartbeat` 携带的都是 `phase: "idle"`（`chat_subscribed` hello 同样 `idle`）。也就是说服务端每 5 秒都在说「这个会话的回合是 idle」，坞仍然一动不动。

**根因（读代码，已定位到行）。** 锚点的清除在 `src/modules/chat/utils/activityFreshness.ts` 的 `onFrame` 里**只有一条路径**：

```
if (frame.turn) { turnStartedAt = frame.turn.startedAt; ... }
else if (!turnIsLocal) { asOf = frame.asOf; }
```

而 `src/modules/chat/hooks/useActivityFreshness.ts` 里，**只有 hello 分支传 `turn`**（由 `event.isProcessing === true` 决定），**心跳分支不传**：

```
machine.onFrame({ bootId, rev, asOf, staleAfter: slot.staleAfter });   // 没有 turn
```

于是：一条 `isProcessing: true` 的 hello 把 `turnStartedAt` 钉住之后，后续每一条心跳都只能推进 `asOf`（`getElapsedMs()` 因此在涨），**没有任何一条能把它清成 null**。心跳带回的 `phase: "idle"` 只被写进 `slot.phase`，而 `deriveActivityDockView` 的显示判据**不看 phase**（只看 `activity === null && !hasTurnAnchor` 与 unreachable），phase 只决定**文案**——`idle` 没有 label key，于是回落到 `'Working'`。三件事凑成一个永动机：`in-turn` 的状态 + `Working…` 的文案 + 递增的计时。

**为什么偏偏是「新建会话的首条消息」。** 生产路径上设置锚点的只有 hello 的 `isProcessing`（`markLocalTurnStarted` 在 `src/` 下**没有调用方**，是死路）。新建会话时创建动作本身已经起了一个 run，此刻的 hello 报 `isProcessing: true` → 锚点被钉住 → 永不脱落；而已有会话在重新订阅时 hello 报 `false`，锚点为 null，所以第二条消息正常。

**非目标。** 不重做 AC-182/183/184/188 的判据与夹具；不改 e2e 夹具；**不引入任何新的客户端常量阈值**（阈值必须继续由服务端 `unreachableAfterMs` 宣告）；不把「刷新页面」当作通过条件。

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`ls tasks/gap-activity-dock-heartbeat-never-clears-turn-anchor.md` → 不存在；邻居 `gap-client-activity-freshness-state-machine`（AC-183）、`gap-activity-heartbeat-server-frames`（AC-182）、`gap-activity-dock-unreachable-degradation`（AC-184）、`gap-activity-dock-phase-truthful`（AC-186/AC-187）、`gap-activity-single-dock-global-consistency`（AC-188）`status` **全部为 `done`** —— 本条不是它们的重复，而是已交付机制上的一个新缺陷（心跳路径从未把服务端的 turn 快照折叠进状态机）。`grep -rilE "心跳.*(锚|anchor)|anchor.*heartbeat|turnStartedAt|isProcessing" tasks/*.md` 命中的都是上述任务的旁述或无关机制（`gap-chat-dedupe-*`、`gap-claude-resident-consent-gate` 等），无一条认领本机制。

## AC

- [x] AC1 判据（红→绿）：在 `src/modules/chat/tests/activityFreshness.test.ts` 或 `activityDockUnreachable.test.tsx` 里新增一条用例，用 delta 帧驱动状态机/坞：先 `chat_subscribed`（`isProcessing: true`），再喂一条 `phase: "idle"` 的 `activity.heartbeat`，断言坞离开 `in-turn`（`data-activity-state` 不再是 `in-turn`）。打印该用例在修复前的 **exit 1**（红）与修复后的 **exit 0** 两次读数。
- [x] AC2 正控制（不许靠「永不上锚」蒙混）：同一判据文件里必须有一条断言 —— hello `isProcessing: true` 且**没有**后续 idle 心跳时，坞**确实**是 `in-turn`。它必须绿；否则说明修复是把锚点整个废掉，而不是把清除路径接上。
- [x] AC3 计时不撒谎：修复后，当服务端已报 `idle`，坞的 `data-activity-elapsed-ms` 不再增长。给出相隔 ≥5s 的两次读数逐字。
- [x] AC4 契约面：`npm run lint` 退出 0；`npm run typecheck` 退出 0；`npx vitest run src/modules/chat/tests/activityFreshness.test.ts src/modules/chat/tests/activityDockUnreachable.test.tsx` 退出 0。
- [x] AC5 真部署落地：在 `localhost:3001` 上新建会话并发首条消息，回合结束后 ≤2 个心跳周期（≤10 秒）内页面里 `document.querySelector('[data-activity-dock]')` 的 `data-activity-state` 不再是 `in-turn`（打印该属性在发送后 10 秒与 60 秒的两次读数 + 时间戳）。**以刷新页面取得的读数不算通过。**
- [x] AC6 Touches 对齐：`git diff --stat` 与 `## Touches` 逐条对齐，无越界文件。

## DoD

- 真实部署上新建会话、发首条消息，回合结束后坞**自行退场**，不需要刷新；前后 `data-activity-state` / `data-activity-elapsed-ms` 读数与时间戳落盘在完成记录里，不是转述。
- 正控制（AC2）与判据（AC1）**同时**绿 —— 证明修复是把「服务端已报 idle」这条证据接进状态机，而不是把上锚路径删掉。
- 没有引入新的客户端常量阈值：`grep -nE '15000|15_000|5000|5_000' src/modules/chat/hooks/useActivityFreshness.ts` → 0 命中；`unreachableAfterMs` 仍只来自 hello 的宣告。
- 修复落在 `## Touches` 列出的文件上；`activityDockUnreachable.test.tsx`（hook 的既有判据）保持绿。

## Touches

- `src/modules/chat/hooks/useActivityFreshness.ts`
- `src/modules/chat/utils/activityFreshness.ts`
- `src/modules/chat/tests/activityFreshness.test.ts`
- `src/modules/chat/tests/activityDockUnreachable.test.tsx`
- `server/modules/websocket/services/activity-heartbeat.service.ts`
- `tasks/gap-activity-dock-heartbeat-never-clears-turn-anchor.md`

## 完成记录

**AC5 真部署独立复验（2026-10-03 14:30–14:38 CST，由非执行者复跑，全程未刷新页面）**

复验前先发现交付时的 `:3001` **跑的不是含修复的包**：交付部署的入口 chunk 是 `dist/assets/index-C1fMtsnH.js`（11:58:13 构建），而修复提交 `873f91d2` 的时间是 **12:02:26** —— 部署比修复早 4 分钟；在该包上复跑仍读到 `data-activity-state="in-turn"` / `phase="idle"` / `elapsed="25002"`（回复已渲染）。所以先重建再复验：

- `npm run build`（exit 0，20.7s）→ 新入口 chunk `dist/assets/index-DK6AqfVU.js`；页面实际加载 `/assets/index-DK6AqfVU.js`（`hasOldChunk: false`）。
- `systemctl --user restart claudecodeui-server.service` → 14:30:38 起，`/api/auth/status` HTTP 200，服务端 pid 2209686。

**两段都拍到的读数**（页面内按秒采样 `document.querySelector('[data-activity-dock]')` 的 `data-activity-state`）：

- 会话 `d1295254`（首条消息「先运行 `sleep 20`，然后只回复收到G」）：**06:37:16–06:37:37 为 `in-turn`** —— 回合进行中坞确实在场，正控制成立，排除「坞压根不出现」的空过；**06:37:38 起为 ABSENT**，与助手回复「收到G」出现的**同一次采样**；06:37:38–06:37:55 保持 ABSENT，再不回来。
- 会话 `0607f253`（普通首条消息）：发送后约 5 秒采样即已在 DOM 中找不到 `[data-activity-dock]`，回复「收到F」已渲染。

**结论**：回合结束的**同一秒**坞即退场，不需要刷新；同一动作在修复前的读数是 4m55s 仍卡在 `in-turn`。修复在真实部署上成立，AC5 的 `[x]` 现有可复现读数支撑。

**遗留观察已查实，并另案立案。** 上述 `d1295254` 轮里「回合进行中坞自报 `phase=idle` 且 `elapsed-ms=null`」不是采样假象 —— 在 `64a1762b`（`sleep 30`）上做了 26 秒逐秒对拍：`GET /api/providers/sessions/running` **每一拍都是 `true`**，而每一条 `activity.heartbeat` 的 `phase` **每一拍都是 `"idle"`**；坞自报 `data-activity-state="in-turn"` / `phase="idle"` / `elapsed-ms=null`。根因是相位 tracker **写入方用 provider session id**（`claude-runtime.provider.ts` 的 `const sid = capturedSessionId || sessionId || null`）、**读取方用 app session id**（心跳的 `readSessionTurn(sessionId)`），两个 id 空间不同，查询永远落空 → 永远 idle；id 对读数 `64a1762b-…` ↔ `f8df8def-…`（`/api/session-hosts`）。已另立 `gap-activity-turn-phase-id-space-mismatch`。**本条修复不受影响**：`in-turn` 的显示判据不看 phase，PHASE2 那 26 秒里 `state` 一直是 `in-turn`，回合结束才退场。