---
id: gap-dock-stop-control-inert-when-provider-lacks-stoptask
title: 坞里的 Stop task 在真实 Claude 常驻会话上是惰性的：provider 声明 stopTask:false 而控件的
  disabled 从不读能力矩阵，AC-196/AC-199 却绿在替身路径上
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: finding
---
## Finding

<!-- dedup-ref --> **机制去重读数（本轮立案时实测，2026-10-04）**：`grep -rln "provider-capabilities\|stopTask: false" tasks/` 命中的都是别处的任务，**无一条**认领「真实 provider 不能停止任务、而坞的控件对此说谎」这一机制。`gap-chat-stop-task-event-confirmed`（AC-196）与 `gap-ac199-dock-stop-background-controls-browser`（AC-199）是那两条**替身路径** AC 的实现者，不是本机制的认领者。⇒ 不是重复。

**现象（真实 Claude 常驻会话，隔离实例实测，不是推断）。** 在一个真实 resident 会话（`lifecycleMode: resident, running: true`）里，坞的 TASKS 表列出了三条：一条 `subagent`（completed）、一条 `shell`（completed）、一条 `shell` **running**，后者的描述是 `never-appears.txt appearing in proj (expected never)`，行上带 **Stop task** 按钮。点它之后 **12 秒**再读：该行**仍是 `running`**；同一时刻 Monitor 的进程**还活着**（`until [ -f /data/home/yale/ac190-probe/proj/never-appears.txt ]; do sleep 2; done`）；`GET /api/sessions/<id>/activity` 的 `tasks[]` 里那条也一直 `state: running`。**点击没有任何回执，也没有任何状态变化。**

**机制（三处代码，逐条直读）**：
1. **能力闸关着**：`server/modules/providers/services/provider-capabilities.service.ts:147` —— `stopTask: false, // not covered by E1–E8`。同文件 :27-30 的注释逐字：「Default `false` and set `true` only where a driver was measured to hold the verb … A `false` here is what the stop-task control plane answers `unsupported` for, **before it reaches any driver**.」
2. **客户端不看能力矩阵**：`src/modules/chat/hooks/useActivityControls.ts:119` —— `const disabled = liveness === 'unreachable' || !isConnected || !sendMessage;`。`stopTask`(:126) 直接 `sendMessage({ type: 'chat.stop-task', sessionId, taskId, requestId })`。⇒ 只要 socket 活着，按钮就**可点、有 hover**，与 provider 是否支持无关。
3. **能力矩阵本来就拿得到**：客户端已经在 `useChatProviderState.ts:254` 拉 `api.providers.capabilities()`（`src/shared/api.ts:462` → `GET /api/providers/capabilities`，服务端 `provider.routes.ts:817`），dock 的控制面**只是不读它**。

**判据洞（与 `gap-cross-session-message-dropped-by-ismeta-gate` 同形 —— 判据绿在一条生产到不了的路径上）。** 两条相关 AC 都是 `achieved`，而它们的判据**都在替身上跑**：
- **AC-196**：判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-stop-task.test.ts`，其 `expect` 逐字写着「WS 处理函数加驱动（resident 与 per-run 各一条，**Query 用脚本化替身**）」。
- **AC-199**：判据 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`，其 `expect` 逐字写着「**调试 agent 场景**提供一个后台任务与一个前台运行中的工具」。
- 而替身的 host driver 是**接受**的：`server/modules/debug-agent/debug-agent.host-driver.ts:638` `async function stopTask(_appSessionId, _taskId)`，紧邻注释「The substitute's background verb: it accepts.」

⇒ 两条 AC 证明的是「控制面在替身接受时会正确地走完时序」，**没有任何判据碰过真实 provider 的能力闸**。

**波及 AC-201（人工关卡）。** GOAL-015 的 §12.2 第 3 步逐字是「从坞里停止 Monitor」，§12.3 的读数是「由 SDK 的通知变为 `stopped`」—— 正是这条路径。所以该人工关卡按现在的写法**过不了**。AC-201 的机械面已落在 develop（merge `4deb6f5a`：§12 + 通用 checker + 护栏），任务自身 7/7 AC 全绿，停在 `needs-human`；本条的产出（AC1/AC2/AC3 的读数）是决定「改产品还是改关卡文本」的前置。

**非目标**：不改 AC-196 / AC-199 的判据（它们各自测的是控制面与事件确认，都成立）；不动 AC-201 的记录小节文本；不在本条里替人裁定「产品该不该支持停止」——本条只把这条路径变成可判的读数。

## AC

- [x] AC1 **真实路径的停止真的生效（红态基线必测）**：新增判据证明在真实 Claude 常驻会话上，从坞里停止一个运行中的后台任务/Monitor 之后，它**真的停止** —— 读数可以是进程消失、或 SDK 的 `task_notification` 宣告停止、或 activity 快照里该条 `state` 离开 `running`（给出你选的读法与逐字输出）。**红态基线**：今天这条路径是惰性的（本轮实测：点击后 12s 仍是 `running`，进程仍活），这组读数必须逐字写进完成记录。
- [x] AC2 **分辨力：判据能区分「被接受」与「不支持」两条路径**：当 provider 声明 `stopTask:false`（或替身拒绝）时，点击**不得**被当成成功 —— 要么给出 `unsupported` 的明确回执并让读者看见，要么控件本身**不可点**（DOM `disabled` 为真且带原因）。「可点但静默无效」是本条要消灭的形态。把能力闸去掉（无条件放行）⇒ 该用例必须红。
- [x] AC3 **判据洞被堵上**：AC-196 / AC-199 的判据保持绿，同时新增至少一条**真实 provider 能力面**的读数，使「停止可用」这一承诺不再只由替身路径承载。给出「未修复 ⇒ 红 / 已修复 ⇒ 绿」两次读数。
- [x] AC4 **契约面**：`npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（含任务文件自身）。

## DoD

- 真实 Claude 常驻会话上，从坞里停止一个真的在跑的后台任务/Monitor，**它真的停下来**；停止的**确认来自 SDK 的通知**，不是点击本身（AC-199 已确立的时序不得回退）。
- 判据有分辨力：AC2 的负控制必红；AC3 的两次读数逐字记录。
- 若人的裁定是「产品不支持」：控件在 `stopTask:false` 的 provider 上**不可点并给出原因**，而不是可点却静默无效；AC-201 §12.2 第 3 步随之由人改写（本任务不自作主张改它）。
- 只动 `## Touches` 列出的文件。

## Touches

- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- src/modules/chat/hooks/useActivityControls.ts
- src/modules/chat/transcript/ActivityDockPanel.tsx
- server/modules/websocket/tests/claude-stop-task-capability.test.ts (new)
- server/modules/session-hosts/tests/lifecycle-mode.test.ts
- e2e/activity-dock-background.spec.ts
- tasks/gap-dock-stop-control-inert-when-provider-lacks-stoptask.md

## Completion

**产出**：commit `34abbb3b`（`chat(dock): gate the stop control on the provider capability matrix`）+ 之后的 `Merge branch 'develop' into task/...`。改动文件与 `## Touches` 逐条一致（5 改 + 1 新 + 本任务文件）；补正轮再新增 1 个姊妹守卫文件（见 AC4 小节末）。

**结论（决定「改产品还是改关卡文本」的那组读数）**：`stopTask` **不是**「产品不支持」，而是**从没测过**。实测它可用 ⇒ 已把能力闸打开并让坞的控件读能力矩阵。⇒ 需要改的是**产品**（已改），AC-201 §12.2 第 3 步的文字**不必**改写。

### AC1 — 真实路径的停止真的生效

**选定的读法：SDK 自己的 `task_notification{status:'stopped'}`，并用「任务进程消失」作旁证。**

**真机实测（2026-10-04，本机隔离 scratch，真 `query()` + 真 CLI 2.1.289 + 本机网关）。** 脚本用与常驻同形的「永不结束的 stream input」驱动 `query()`，让模型以 `run_in_background: true` 起一个后台 Bash，再调 `Query.stopTask(taskId)`。逐字输出（后台任务的载荷是 `bash -c 'echo $$ > <marker>; exec sleep 300'`）：

```
[04:14:16.788] EVENT task_started {"type":"system","subtype":"task_started","task_id":"b42w8h44z","tool_use_id":"call_00_cWX8e6Qe7Cv7pAsccXBx4358","description":"Start background sleep probe task","task_type":"local_bash","uuid":"27842103-2d42-4073-8683-9f026e737232","session_id":"17aa179d-8c37-43ce-b410-8b820ef30b94"}
[04:14:16.888] captured taskId=b42w8h44z pid=1762563 aliveBefore=true
[04:14:16.888] calling query.stopTask(b42w8h44z)
[04:14:16.890] stopTask resolved
[04:14:17.943] EVENT task_updated {"type":"system","subtype":"task_updated","task_id":"b42w8h44z","patch":{"status":"killed","end_time":1791087256890},...}
[04:14:17.943] EVENT task_notification {"type":"system","subtype":"task_notification","task_id":"b42w8h44z","tool_use_id":"call_00_cWX8e6Qe7Cv7pAsccXBx4358","status":"stopped","output_file":"","summary":"Start background sleep probe task",...}
[04:14:18.244] *** STOPPED; pidAliveAfter=false
[04:14:18.245] SUMMARY taskId=b42w8h44z pid=1762563 aliveBefore=true aliveAfter=false stopLatencyMs=1055 verdict=STOPPED
```

⇒ 三个读数同时成立：`task_notification{status:'stopped'}` 在调用后 **1055ms** 到达；后台进程 `pid=1762563` 在调用前 `alive=true`、在通知后 `alive=false`；调用本身 2ms 返回。第一次探针（`sleep 300`，未写 pid 文件）给出同一形状：`*** STOPPED EVENT after 712ms from the call`。

**红态基线（本条立案时的实测，逐字复用）**：真实常驻会话里点坞里的 Stop task 之后 **12 秒**再读，该行**仍是 `running`**，Monitor 的进程**还活着**，`GET /api/sessions/<id>/activity` 的 `tasks[]` 那条也一直 `state: running` —— 点击没有任何回执、没有任何状态变化。修复前的成因由新判据逐字复现：能力闸读 `false` ⇒ 控制面回答 `unsupported`，驱动一次都没被碰到（见下 AC3 的「未修复」读数）。

**新增判据**：`server/modules/websocket/tests/claude-stop-task-capability.test.ts`。它跑的是**真的** `providerRuntimeService` + **真的** `ClaudeResidentHostDriver` + **真的** `chat.stop-task` 处理函数（只把 SDK 进程按脚本替换，与 AC-196 同一条边界）。逐字读数：

```
stop-task-capability (capability) shipped.residentFeatures.stopTask=true
stop-task-capability (AC1) placed=true liveReading={"result":"requested","driverCalls":["b-resident-live"],"stateBeforeEvent":"running","stateAfterEvent":"stopped"}
```

⇒ 真实装配下：收据 `requested`；活着的 query 收到了被寻址的 task id；行在事件**之前**仍是 `running`，在 `task_notification` **之后**才是 `stopped`（停止由事件确认，不是点击，也不是收据）。

### AC2 — 分辨力

**两层都读，且负控制都真跑过。**

服务端（`unsupported` 明确回执 + 驱动未被触碰）：

```
stop-task-capability (AC2 addressed) {"result":"unsupported","driverCalls":[],"stateBefore":"running","stateAfter":"running"}
stop-task-capability (AC2 table-independent) {"result":"unsupported","driverCalls":[],"stateBefore":null,"stateAfter":null}
[readings] gate removed: red
stop-task-capability (AC2 control) openResult=requested placed=true driverCalls=["b-open"]
```

- 「已寻址」与「表里根本没有」两条都答 `unsupported`——拒绝是关于**动词**的，与点了哪个 task 无关；
- **能力闸去掉（无条件放行）⇒ 红**：把「放行」的数据（`result:'requested'` + 有一次驱动调用）喂给同一个判定函数 `assertUnsupportedPlacesNothing`，它 `throws`（`/must answer unsupported/`），日志逐字 `[readings] gate removed: red`；
- 正面控制：同一装配、同一请求，能力声明为真时驱动被调用且走完确认（`requested`）。

浏览器（控件本身不可点 + 带原因），在**真浏览器 + 真服务端**上读，session 是 resident 而 provider（`debug`）没有声明该动词：

```
capabilityGate.host={"appSessionId":"fcc027e5-c3cf-4a3d-84ca-a8ea333a4ed8","provider":"debug","lifecycleMode":"resident","running":false,"reason":"No resident host is running for this session; the last server stop or restart dropped it.","occupiedBy":null} capabilityRow=null
capabilityGate.main capability-gate: lifecycleMode=resident declared=undefined shouldBeDisabled=true domDisabled=true green=true reasons=["This provider cannot stop a background task, so there is nothing to place"]
capabilityGate.falseForm capability-gate: lifecycleMode=resident declared=undefined shouldBeDisabled=true domDisabled=false green=false
```

⇒ DOM `disabled` 为真且旁边画出了原因（英文文案逐字如上）；假形态（闸被去掉、控件仍可点）在同一个判定函数下 `green=false`。**「可点但静默无效」这个形态在两层都被消灭**：不可点的控件 + 表无关的 `unsupported` 回执。

### AC3 — 判据洞被堵上

**AC-196 保持绿**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-stop-task.test.ts server/modules/websocket/tests/chat-background-task.test.ts server/modules/websocket/tests/chat-control-ownership.test.ts` → `# tests 16 / # pass 16 / # fail 0`。

**AC-199 保持绿**：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"` → `1 passed (22.4s)`，读数与修复前一致（`ac3.main click-instant: before=running after=running green=true`、`ac6.partition: ... stopDisabled=true bgDisabled=true`）。per-run 会话不走能力闸（矩阵的 `residentFeatures` 描述的是常驻进程，per-run 是另一条放置路径），所以它不受影响。

**新增的真实 provider 能力面读数**（不再只由替身承载）：`stop-task-capability (capability) shipped.residentFeatures.stopTask=true` 读的是**出货的**能力矩阵本身，且上文的 AC1 读数是在**不注入**能力读数的情况下（`createProviderRuntimeService` 不覆盖 `residentStopTaskSupported`，由矩阵回答）走完整条链得到的。

**两次读数（逐字）**：

- **未修复 ⇒ 红**：把能力闸恢复成本条立案时的值（`stopTask:false`，两层都注入）后，同一条 AC1 判定逐字得到
  `stop-task-capability (AC3 unfixed) reading={"result":"unsupported","driverCalls":[],"stateBeforeEvent":"running","stateAfterEvent":"running"}` ⇒ `[readings] pre-fix capability: red`（`assert.throws(..., /must receive exactly the addressed task id/)`）。
- **已修复 ⇒ 绿**：`stop-task-capability (AC1) placed=true liveReading={"result":"requested","driverCalls":["b-resident-live"],"stateBeforeEvent":"running","stateAfterEvent":"stopped"}`。

### AC4 — 契约面

- `npm run typecheck` → 退出 0（合并 develop 后在 worktree 上重跑）。
- `npm run lint` → 退出 0（仅既有 warning）。
- `git diff --stat`（相对 develop）：`e2e/activity-dock-background.spec.ts`、`server/modules/providers/services/provider-capabilities.service.ts`、`server/modules/websocket/services/chat-websocket.service.ts`、`server/modules/websocket/tests/claude-stop-task-capability.test.ts`（新）、`src/modules/chat/hooks/useActivityControls.ts`、`src/modules/chat/transcript/ActivityDockPanel.tsx` —— 与 `## Touches` 逐条一致，无第七个代码文件。
- 补正轮（2026-10-04，fan-in 全量 suite 红于 `server/modules/session-hosts/tests/lifecycle-mode.test.ts` 的 `residentFeatures` 穷举守卫）新增第 7 个文件 `server/modules/session-hosts/tests/lifecycle-mode.test.ts`：该守卫把 `stopTask` 钉在「未实测 ⇒ false」组，而本轮已把能力矩阵改为实测 `true`，故把该断言移入「已实测 ⇒ true」组并同步注释；文件已声明进 `## Touches`。
- scoped 门：`bash scripts/test.sh --for-task gap-dock-stop-control-inert-when-provider-lacks-stoptask --allow-thin` → `# pass 1 / # fail 0`。
- 前端回归：`npx vitest run src/modules/chat/tests src/shared/tests` → `Test Files 109 passed / Tests 722 passed`。

### 遗留（明确交给人，不是本条自作主张）

- 本条**只**为 `stopTask` 做了实测并打开；兄弟动词 `backgroundTasks` 仍是 `false`（2026-10-04 的探针被 CLI 自己的「standalone sleep」护栏挡下，工作负载没跑起来，因此**得不出**该动词的结论，按矩阵纪律维持保守值）。坞的「Move to background」控件因此同样按能力矩阵置灰并给出原因 —— 于是 AC-201 §12.2 第 4 步「前台长命令转后台」在真机上仍不可走。**该步要不要改文本、还是先给 `backgroundTasks` 补一次实测，是人的裁定**，本条不替人决定。
- AC-201 §12.2 第 3 步（从坞里停止 Monitor）**不需要**改写：路径已通，停止由 SDK 通知确认。