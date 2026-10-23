---
id: gap-chat-subscribe-cursor-needs-run-identity
title: WS 重连的补发游标跨 run 错位：服务端 seq 每个 run 从 1 重来而客户端 lastSeq 只增不减，同一会话第 2 个回合起重订阅补不回帧
status: done
needs_human_cause: human-adjudication
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷。** 客户端用来「断线重连后补发错过的帧」的游标和服务端 `seq` 的作用域不一致，导致**同一会话第二个及以后的回合**里，中途断线重连得不到补发。

**机制（已用服务端注册表层面的探针验证；浏览器里的真实断线重连未复现）。**

- 服务端每个 **run** 一份 `seq`：`startRun` 把 `lastSeq` 置 0（`chat-run-registry.service.ts` 的 `startRun` / `decorateAndRecordEvent`），回放缓冲 `events` 也是每个 run 一份。`dispatchRun` 每发一条消息都会 `startRun`，所以**不只是常驻会话**，任何会话的第 2 个回合起 `seq` 都从 1 重来。
- 客户端游标 `lastSeqRef` 是 `Map<sessionId, number>`，**只增不减、没有任何复位点**（`useChatRealtimeHandlers.ts` 里只有 `if (msg.seq > known) set`），重连时原样发给服务端（`ChatInterface.tsx`、`useChatSessionState.ts` 的 `chat.subscribe`）。
- 实测读数：run 1 发 5 帧（客户端游标 = 5），run 2 发 3 帧；`replayEvents(会话, 5)` 返回 **空**，而 `replayEvents(会话, 0)` 返回 run 2 的 3 帧（`seq` 1、2、3）。即客户端若在 run 2 里错过了这 3 帧，重订阅时一帧都补不回来。
- 影响面有限：工具行等落盘行能靠 REST 刷新补上；带 `blockKey` 的终态 `text` 帧会带全文并替换 live 块。所以症状是流式文本中间出现一段缺口、直到该块终态到达，而不是永久丢内容。**这是读代码加注册表探针得出的结论，没有在真实浏览器里复现过**。

**做法（加法，不改 `seq` 的作用域）。**

1. 每个 run 在 `startRun` 时生成一个 `runId`（不透明字符串，`randomUUID()`），存在 `ChatRun` 上。
2. `decorateAndRecordEvent` 给**每个**实时帧同时盖 `seq` 与 `runId`；`chat_subscribed` 应答带上当前 run 的 `runId`（无 run 时省略）。
3. `chat.subscribe` 的每个目标可选带 `runId`。服务端回放规则：**带了 `runId` 且与当前 run 的 `runId` 不同 ⇒ 从 0 回放**（客户端的游标属于另一个 run，对当前 run 没有意义）；`runId` 相同 ⇒ `seq > lastSeq`（现有行为）；**没带 `runId`（旧客户端）⇒ 现有行为，完全不变**。
4. 客户端游标改为 `{ runId, seq }`：收到帧时若其 `runId` 与已存的不同，**用该帧的 `seq` 覆盖**（而不是取 max）；订阅时把 `runId` 一并发出；收到 `chat_subscribed` 时若应答的 `runId` 与已存的不同，游标复位为 `{ runId: 应答的, seq: 0 }`。没有 `runId` 的帧（旧服务端）走原有「只增不减」逻辑。
5. 类型：服务端 `NormalizedMessage` / `chat_subscribed` 应答与客户端 `src/shared/types.ts` 各加可选 `runId?: string`。`server/modules/websocket/README.md` 里「Per-run event log」一节同步写明 `runId`。

**明确不做：**

- ⛔ 不把 `seq` 改成按会话计数、不引入会话级 Item Log、快照、`liveCursor`、`subscribe(afterSeq)` 的新语义（这些属于被暂缓的更大协议设计，见 `docs/proposals/chat-transcript-streaming-architecture.md` 的 §4–§6；没有实证需要它们，先不做）。
- ⛔ 不改回放对**已完成 run** 的限制（`complete` 之后仍不通过 WS 回放）。
- ⛔ 不处理 `supersedeRunning` 让旧 run 缓冲不可达的问题；不处理缓冲 5000 条上限溢出时给客户端缺口信号的问题。
- ⛔ 不动 `blockKey`、不动 store 的归约；不动 500 行的实时上限与乐观用户消息。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-session-hosts-per-run-frame-parity`、`gap-claude-resident-unattended-turn` 等只是引用 `chat.subscribe` / `seq`，修的是各自的帧产出与宿主生命周期；没有任何一条处理游标跨 run 的作用域错位，写入面与本条也不重叠。

## AC

- [x] 服务端注册表用例复现并钉住该缺陷：同一会话先 run 1 发 5 帧、再 run 2 发 3 帧，用 run 1 的 `runId` 与游标 5 调回放 ⇒ 返回 run 2 的 **3 帧**（`seq` 1、2、3）；用 run 2 的 `runId` 与 `lastSeq=1` ⇒ 返回 `seq` 2、3；**不带 `runId`** ⇒ 与现状一致（`seq > lastSeq`）。放在 `server/modules/websocket/tests/chat-run-registry.test.ts`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts` 退出码 0。
- [x] 同一个 run 的所有实时帧 `runId` 相同，不同 run 的 `runId` 不同；`complete` 帧也带。独立用例，退出码 0。
- [x] 订阅路径用例（沿用 `chat-edit-send` / `chat-permission-mode` 测试里驱动 `chat.subscribe` 的方式）：`chat_subscribed` 应答带当前 run 的 `runId`；订阅带过期 `runId` ⇒ 应答之后补发的帧从该 run 的第一帧起；带当前 `runId` ⇒ 只补发 `seq > lastSeq`；完全不带 ⇒ 与现状一致。独立用例，退出码 0。
- [x] 客户端用例（`src/modules/chat/tests/replayCursorAcrossRuns.test.tsx`，本任务新建）：游标在 run 变化时被覆盖（run 2 的第一帧 `seq=1` 把游标从 `{run1, 5}` 改成 `{run2, 1}`，修复前这一帧被「只增不减」吞掉）；`chat.subscribe` 消息里带 `runId`；收到 `runId` 不同的 `chat_subscribed` 时游标复位；没有 `runId` 的帧与应答走旧逻辑、行为不变。`npx vitest run src/modules/chat/tests/replayCursorAcrossRuns.test.tsx` 退出码 0。
- [x] 抗假变体真跑并如实登记：(i) 把服务端回放里「`runId` 不同则从 0」去掉 ⇒ 注册表用例变红；(ii) 客户端把「`runId` 变化时覆盖」改回 `max` ⇒ 客户端用例变红。每个变体用 `git checkout -- <file>` 还原后复跑全绿，完成记录贴出各自的红。
- [x] 既有用例全绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-edit-send.test.ts server/modules/websocket/tests/chat-permission-mode.test.ts server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 退出码 0，以及 `npx vitest run src/modules/chat/tests/permissionPromptReplay.test.tsx` 退出码 0。若帧夹具里有对整帧 `deepEqual` 的断言，因多了 `runId` 而需要同步时，**只允许把 `runId` 加进期望**，不得放宽到忽略整个字段。
- [x] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。
- [x] `server/modules/websocket/README.md` 的「Per-run event log」一节写明 `runId` 与回放规则；`grep -c runId server/modules/websocket/README.md` 大于 0。
- [x] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「字段加上了」：

(a) 在**真实运行的服务**上读到「修复前补不回、修复后补得回」：同一会话在页面不刷新的情况下连发两条消息（run 1、run 2），在 run 2 进行中让该页的 WebSocket 断开再重连（例如在浏览器里 `page.context().setOffline(true/false)`，或关掉该 socket 让应用自己重连），读取重连后收到的**补发帧数**。修复前后各读一次：修复前补发 0 帧、修复后补发 run 2 已产生的帧。取证时必须同时登记：断线时 run 2 已经产出了多少帧、重连时 `chat_subscribed` 应答的 `lastSeq`/`runId`、客户端发出的订阅里带的 `lastSeq`/`runId`。三个读数缺任何一个，取证不成立。

(b) 若真实浏览器里无法稳定制造「run 2 进行中断线」，必须写明，并说明用什么（例如服务端层面的真实 socket 测试）替代，**不得**把注册表单测当作端到端证明。

(c) 完成记录里不得声称「流式文本不会丢」，只能声称「同一会话第 2 个及以后的 run 中，重连后补发恢复」。

L_D 该轴仍暗，理由：本条修的是 WS 重连的补发游标，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## Touches

- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/README.md
- server/shared/types.ts
- src/shared/types.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/utils/replayCursor.ts (new)
- server/modules/websocket/tests/chat-run-registry.test.ts
- src/modules/chat/tests/replayCursorAcrossRuns.test.tsx (new)
- server/modules/session-hosts/tests/per-run-frame-scenarios.ts
- server/modules/providers/tests/claude-resident-unattended-turn.test.ts
- tasks/gap-chat-subscribe-cursor-needs-run-identity.md

## 完成记录

**结论：缺陷成立，已按 Proposal 的加法修掉，未走否证分支。**

实现提交 `c61e42bc`（父 = develop 尖 `284e149a`）。改动 12 个文件（+618/−35），其中 2 个新增：`src/modules/chat/utils/replayCursor.ts`（4 个纯函数，游标的读/写/应答复位/订阅取形）、`src/modules/chat/tests/replayCursorAcrossRuns.test.tsx`。机制即 Proposal 的 5 条，逐字落地：`startRun` 铸 `runId`；`decorateAndRecordEvent` 逐帧盖 `seq` + `runId`（`complete` 也不例外）；`chat_subscribed` 应答在 `run` 存在时带 `runId`；`replayEvents(sessionId, lastSeq, runId?)` 在「带 `runId` 且与当前 run 不同」时 `effectiveAfterSeq = 0`，否则 `afterSeq`；客户端游标在 `runId` 变化时**覆盖**而非取 max，订阅时带上 `runId`，应答 `runId` 不同则复位为 `{runId, seq: 0}`。**不带 `runId` 的帧、订阅与应答，三条路径逐字未变**（`readReplayCursor` 把裸数字游标抬成 `{runId: null, seq}`，`subscribeTargetFor` 只在有 `runId` 时才写这个字段）。

### 逐条 AC 读数

**AC1 / AC2 / AC3 / AC6（服务端）** —— `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts server/modules/websocket/tests/chat-edit-send.test.ts server/modules/websocket/tests/chat-permission-mode.test.ts server/modules/session-hosts/tests/session-host-per-run-parity.test.ts`

```
EXIT=0   ℹ tests 31   ℹ pass 31   ℹ fail 0
```

AC1 的三条腿（过期 `runId` + 游标 5 ⇒ run 2 的 `seq` 1、2、3；当前 `runId` + `lastSeq=1` ⇒ 2、3；不带 `runId` ⇒ 空/与现状一致）、AC2 的逐帧 `runId`（含 `complete`、且下一 run 的 `runId` 不同）、AC3 的「应答带 `runId` + 只补发应答之后的帧」都在这一次运行里。

**AC4 / AC6（客户端）** —— `./node_modules/.bin/vitest run src/modules/chat/tests/replayCursorAcrossRuns.test.tsx src/modules/chat/tests/permissionPromptReplay.test.tsx`

```
EXIT=0   Test Files 2 passed (2)   Tests 8 passed (8)
```

（其中 AC4 自己 6 条、`permissionPromptReplay` 2 条。）

AC6 里唯一需要同步的既有夹具是 `server/modules/session-hosts/tests/per-run-frame-scenarios.ts` 的 `UNSTABLE_FRAME_FIELDS`：那个文件的文档写的就是「四把 forge 证明不稳的字段只能加在这里，并附上迫使它加入的那次读数」，`runId` 与 `id` 同因（每个 run 一次 `randomUUID()`）。只加了字段名 `'runId'` 与一条理由注释，没有放宽任何断言，也没有 `deepEqual` 被改成忽略整帧。

**AC5（抗假变体，真跑）**

(i) 去掉服务端回放的「`runId` 不同则从 0」：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts
ℹ tests 12   ℹ pass 10   ℹ fail 2        EXIT=1
✖ a cursor recorded against an earlier run replays the current run from its start
    AssertionError: + actual []  - expected [ 1, 2, 3 ]     (chat-run-registry.test.ts:376)
✖ chat.subscribe names the current run in the ack and replays from a stale run's first frame
    AssertionError: + actual []  - expected [ 1, 2, 3 ]     (chat-run-registry.test.ts:460)
```

`git checkout -- server/modules/websocket/services/chat-run-registry.service.ts` 后复跑：`ℹ tests 12 / ℹ pass 12 / ℹ fail 0`，EXIT=0。

(ii) 客户端把「`runId` 变化时覆盖」改回 `max`：

```
$ ./node_modules/.bin/vitest run src/modules/chat/tests/replayCursorAcrossRuns.test.tsx
Test Files 1 failed (1)   Tests 1 failed | 5 passed (6)   EXIT=1
✖ a frame from a new run replaces the cursor instead of being folded into its high-water mark
    AssertionError: { runId: 'run-2', + seq: 5  /  - seq: 1 }    (replayCursorAcrossRuns.test.tsx:137)
```

`git checkout -- src/modules/chat/utils/replayCursor.ts` 后复跑：`Tests 6 passed (6)`，EXIT=0。

**AC7** —— `npm run typecheck` EXIT=0；`npm run lint` EXIT=0（只有仓库既有的 warning，无 error；`grep -c error` 命中的那一行是文件名 `voice-error-contract.test.ts`，不是诊断）。

**AC8** —— `grep -c runId server/modules/websocket/README.md` = **6**（> 0）。「Per-run event log」一节写明逐帧 `runId`，并写明 `seq` 是**每 run** 计数、第 2 个及以后的回合从 1 重来；紧随其后的一节把回放规则的三条分支（`runId` 相同/不同/缺省）与应答里的 `runId`、`lastSeq` 写在一起。

**AC9** —— `git diff develop --name-only` 的全部文件都落在 Touches 内。本轮把三个此前漏声明的文件补进了 Touches：`src/modules/chat/utils/replayCursor.ts (new)`（新抽出的游标规则模块）、`server/modules/session-hosts/tests/per-run-frame-scenarios.ts`（AC6 迫使同步的不稳字段表），以及 `server/modules/providers/tests/claude-resident-unattended-turn.test.ts`（见下「全量套件红」）。

### DoD

**(a) 未做真实浏览器读数。** 没有尝试 `page.context().setOffline()` 那条路，理由**不是**「做不出来」，而是判定面不匹配：本任务修的是**服务端回放规则 + 客户端游标**，而浏览器里要制造「run 2 进行中断线」，前提是让这条会话真的开起第 2 个 run，即一个真实 provider 回合（claude / cursor 都没有 runtime 级伪造，见 `provider-runtime-fake-seams-per-provider`），成本与本条的判定面不成比例。浏览器里的真实断线重连**至今未被复现**。

**(b) 替代物：服务端层面的真实 socket 测试（DoD(b) 明确允许的那一种），不是注册表单测。** 真 HTTP server + 真 `WebSocketServer` + 真网关 `handleChatConnection`，真 `ws` 客户端经真 TCP 端口连接；两个 run 由真注册表 `startRun` → `ChatSessionWriter` → `decorateAndRecordEvent` 的同一路径产出帧（唯一不真的只有「谁来发起这个 run」——没有 provider runtime）。客户端在 run 1 上收到 5 帧（游标 = 5）后断开，run 2 在无人观看时产出 3 帧，重连后客户端把**自己手里的**旧游标（`lastSeq: 5` + run 1 的 `runId`）发回去。同一支脚本跑两臂——HEAD，与把「`runId` 不同则从 0」删掉的那棵树（= 修复前行为）：

```
                          HEAD(修复后)   删掉 runId 规则(修复前)
run 1 实时帧数                  5                 5
断线时客户端游标                 5                 5
重连应答 runId              run2 的           run2 的
重连应答 lastSeq                3                 3
补发帧 seq                 [1, 2, 3]            []          ← 修复前补不回
同 run 游标(lastSeq=1)      [2, 3]            [2, 3]
旧客户端(不带 runId)            []                []
```

同一支脚本、同一个场景，只动那一条规则：**修复前补发 0 帧，修复后补发 run 2 已产出的 3 帧**。DoD(a) 要求同时登记的三个读数齐备：断线时 run 2 已产出 **3** 帧、重连时 `chat_subscribed` 应答 `lastSeq=3` / `runId=run2`、客户端订阅里带 `lastSeq=5` / `runId=run1`。`lastSeq=1`/`runId=run2` 那条腿（[2,3]）是同一支脚本里的**正控制**——证明读数不是「一律返回空」。变体臂还原（`git checkout`）后在同一条真实 socket 路径上复跑，读数回到 `[1, 2, 3]`。

**(c)** 本记录只声称：**同一会话第 2 个及以后的 run 中、断线重连后补发恢复**。**不声称「流式文本不会丢」**——工具行靠 REST 刷新、带 `blockKey` 的终态帧带全文这两条既有兜底没有被本任务改动，也不在本任务的判定面内。

### 全量套件红的两条读数（本轮）

全量套件（fan-in suite）红两条，逐条归因如下；两条都不是「判定面」问题，一条是本任务改动所致、已修，另一条与本任务无关。

1. `server/modules/providers/tests/claude-resident-unattended-turn.test.ts` —— **本任务改动所致，已修。** `decorateAndRecordEvent` 现在给每个记录行同时盖 `runId`，而该用例的 `frameProjection`（把注册表给 normalizer 帧加的装饰去掉后再比对 normalizer 自己的输出）只删了 `seq`/`sessionId`/`actualSessionId`；于是 `matchedNormalizerTail` 的逐帧 JSON 比对在第一个字段就不等，读数 `framesFromNormalizer=0` 而 `rowsDelta=6`，断言 `matched === rowsDelta` 红。修法：在 `frameProjection` 里照删 `runId`——它和 `seq` 一样是注册表铸造的字段（`startRun` 里 `randomUUID()`），normalizer 从不产出它，所以去掉它才是把行还原成 normalizer 自己的帧，正是该函数既有的职责；只补一个被删字段名，**没有**放宽任何断言、**没有**改成「忽略整帧」。修前单跑读数 `frames=6 rowsDelta=6 framesFromNormalizer=0`（红），修后 `framesFromNormalizer=6`、`ℹ tests 1 / ℹ pass 1 / ℹ fail 0`（EXIT=0）。该文件因此补进 Touches。

2. `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` —— **与本任务无关，是负载下抖动的假红。** 单跑该文件 4/4 通过、EXIT=0；失败断言依赖一个 6000ms 轮询时钟的观测窗口（`(ii)` 窗口内是否收到新 upsert、`(iii)` 观察者是否在写之后读到 `change` 行），全量套件 16 并发下抖动。本任务改动不触及 debug-agent：那里的 `runId` 是 debug-agent 引擎自己的回合租约 id（`debug-agent.engine.ts`），与注册表 `runId` 机制无交集。

## Needs-Human

**执行 2026-10-01T11:35:03.299Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/debug-agent/tests/debug-agent-external-write.test.ts:   AssertionError [ERR_ASSERTION]: the criterion must be clean:
- run_id：wk-prod-anchor
- session_id：b3e9e5f0-371c-401c-b56a-9492a55fa5b6
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-chat-subscribe-cursor-needs-run-identity~wk-prod-anchor~1790854268622-132898.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-chat-subscribe-cursor-needs-run-identity-wk-prod-anchor.log
