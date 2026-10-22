---
id: gap-ac234-control-run-source-fidelity
title: AC-234 运行来源如实记录：ChatRunSource 新增 mcp，控制服务按 caller.via
  显式映射来源（websocket→user、scheduled→scheduled、mcp→mcp），无人轮仍 unattended，旧默认（有连接
  user/无连接 scheduled）不变；判据
  server/modules/websocket/tests/chat-control-source.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac233-control-single-instance-wiring
goal_ac: AC-234
---
## Proposal

AC-234（GOAL-019；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3 决策 D9 与「运行来源（D9）」节）要求运行来源如实记录：经 MCP 发起的运行注册表里 `source === 'mcp'`，WebSocket 发起的为 `'user'`，定时发送的为 `'scheduled'`，宿主层无人轮（`openUnattendedRun`）仍为 `'unattended'`；调用方未显式传来源时保持旧默认（有连接 `'user'`、无连接 `'scheduled'`），已有调用方行为不变。判据 `server/modules/websocket/tests/chat-control-source.test.ts` 给出 (a)–(e) 五组读数与四条取假形态。

现状（红态基线）：判据文件 `server/modules/websocket/tests/chat-control-source.test.ts` 不存在，判据的存在性闸以退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-source.test.ts`。`ChatRunSource` 目前为 `'user' | 'scheduled' | 'unattended'`（`server/shared/types.ts:2272`），无 `'mcp'`；`chatRunRegistry.startRun`（`server/modules/websocket/services/chat-run-registry.service.ts:240`）的默认是 `input.source ?? (input.connection ? 'user' : 'scheduled')`；`openUnattendedRun`（:281）以 `source: 'unattended'` 调 `startRun`；`dispatchRun`（`server/modules/websocket/services/chat-websocket.service.ts:527`）构造 `startInput` 时不传 `source`；`chat-run-registry.test.ts` 目前没有穷举 `ChatRunSource` 的夹具。

<!-- dedup-ref -->
前置与边界：本任务依赖的 `ChatControlService.send` 与 `dispatchRun` 的导出/装配由 `gap-ac233-control-single-instance-wiring`（及链上 `gap-ac232`/`gap-ac231`/`gap-ac230`）交付；本条不重做控制服务动作、不做单实例装配，只做「类型加取值 + 控制服务按 `caller.via` 显式映射来源 + 穷举夹具」。

要交付：

1. **类型**（`server/shared/types.ts`）。`ChatRunSource` 增加 `'mcp'`：`'user' | 'scheduled' | 'unattended' | 'mcp'`，并在类型的文档注释里补 `mcp` 的一句——经 MCP 网关发起、没有 socket；因与 `scheduled` 共享「无连接」形态，二者必须能区分。

2. **`dispatchRun` 透传来源**（`server/modules/websocket/services/chat-websocket.service.ts`）。`dispatchRun` 增加一个可选尾参 `source?: ChatRunSource`，把它并入 `startInput`，使**两次** `startRun` 调用（首次探测 :547 与 `supersedeRunning` 重试 :559）都带上它。既有调用方（`handleChatSend` :476、`handleChatEditSend` :714、无人轮分发路径 :1435）一律不传 ⇒ `startRun` 的 `input.source ?? (input.connection ? 'user' : 'scheduled')` 保持逐字不变（读数 (d)）。不改 `dispatchRun` 其余逻辑，以保既有 WebSocket 判据逐字通过。

3. **控制服务显式映射**（`server/modules/websocket/services/chat-control.service.ts`，AC-230 交付）。`send` 在调 `dispatchRun` 前按 `caller.via` 映射并显式传入来源：`websocket` → `'user'`、`scheduled` → `'scheduled'`、`mcp` → `'mcp'`。这是本条**承重**的改动：AC-230 的 `send` 恒以 `ws = null` 调 `dispatchRun`，若依赖「有无连接」的旧默认，`via: 'websocket'` 的发送会被错记为 `'scheduled'`；显式映射才使 (b) 成立。映射写成一张穷举 `Record<ControlCaller['via'], ChatRunSource>` 常量（新增 `via` 取值时 tsc 报错），不写链式三元。

4. **无人轮不变**（`chat-run-registry.service.ts` 的 `openUnattendedRun`）。逐字不改，仍 `source: 'unattended'`（读数 (c)）。

5. **穷举夹具**（`server/modules/websocket/tests/chat-run-registry.test.ts`）。新增穷举常量 `const ALL_CHAT_RUN_SOURCES: Record<ChatRunSource, true> = { user: true, scheduled: true, unattended: true, mcp: true }`（给 `ChatRunSource` 加值而不更新它 ⇒ `npm run typecheck` 报错），并加一个用例：对 `Object.keys(ALL_CHAT_RUN_SOURCES)` 的四个取值各以显式 `source` 调 `startRun`，断言读回的 `run.source === value`（四种取值各一正例，防止「恒为默认值」也通过）。

6. **判据 `server/modules/websocket/tests/chat-control-source.test.ts`**（红先行；取 `chat-control-ownership.test.ts` 的注入式形态——临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入假 runtime 网关——**不构造任何 socket**；`send` 用可控延迟假运行使其保持在 running 以便读 `source`）。读数：
   (a) `send({ userId, via: 'mcp' }, { sessionId, content })` 返回 `ok: true` 后，`chatRunRegistry.getRun(sessionId)?.source === 'mcp'`（写下读数）。
   (b) 同形态 `via: 'websocket'` ⇒ `source === 'user'`；`via: 'scheduled'` ⇒ `source === 'scheduled'`（各在独立会话上读，写下两条读数）。
   (c) 对一条新会话调 `chatRunRegistry.openUnattendedRun({ appSessionId, provider, providerSessionId: null, userId })` ⇒ 读回 `getRun(...)?.source === 'unattended'`（写下读数）。
   (d) 直接调 `chatRunRegistry.startRun({ …, connection: <假连接>, userId })`（**不传** `source`）⇒ `source === 'user'`；`connection: null`（不传 `source`）⇒ `source === 'scheduled'`（写下两条读数）。
   (e) 类型含 `'mcp'`：判据文件里写一个同形穷举常量 `const _exhaustive: Record<ChatRunSource, true> = { user: true, scheduled: true, unattended: true, mcp: true }`，由 `npm run typecheck` 机械核对（写下 typecheck 结果）。

7. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 让 `send` 对所有调用方都不传来源（`dispatchRun(..., source)` 参数去掉或传 `undefined`）⇒ (a) 必须红（mcp 发送因无连接落回 `'scheduled'`）；
   (ii) 把映射里 `mcp` 的取值改成 `'scheduled'` ⇒ (a) 必须红；
   (iii) 改写 `openUnattendedRun` 的来源（如改成 `'scheduled'`）⇒ (c) 必须红；
   (iv) 改掉 `startRun` 旧默认（如恒为 `'scheduled'`）⇒ (d) 必须红。
   每条记录恢复命令与恢复后重跑绿。

边界：不实现 MCP 网关/OAuth/新端点；不做单实例装配与处理器改造（归 AC-233）；不做运行保留期/摘要/`getRunById`（归 AC-235）；不改 `closeHost(…, 'user')` 的关闭原因词汇（SPEC：MCP 发起的关闭沿用 `'user'`，来源区分靠审计，不在本 AC）；不改 `startRun` 对既有调用方的语义与签名必填性；不改 WebSocket 协议与 `chat.subscribe` 帧序列。

判定纪律：来源是「运行登记时被实测读回」的事实，不是「代码看起来会传」；四种取值各有一个正例；(d) 的旧默认两臂都要读；`dispatchRun`/控制服务改动不影响既有 WebSocket 判据；遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不越界导出无消费者符号）。

## AC

- [x] AC1 判据绿：`for f in server/modules/websocket/tests/chat-control-source.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-source.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-source.test.ts`）。
- [x] AC2 (a) mcp 正例：经控制服务 `send({ userId, via: 'mcp' }, …)` 发起的运行，`chatRunRegistry.getRun(sessionId)?.source === 'mcp'`（写下返回与读数）。
- [x] AC3 (b) user/scheduled 正例：`via: 'websocket'` ⇒ `source === 'user'`；`via: 'scheduled'` ⇒ `source === 'scheduled'`（各在独立会话，写下两条读数）。
- [x] AC4 (c) 无人轮不变：`openUnattendedRun(…)` 开的运行 `source === 'unattended'`（写下读数）。
- [x] AC5 (d) 旧默认两臂：直接 `startRun` 不传 `source`，有连接 ⇒ `'user'`，无连接 ⇒ `'scheduled'`（写下两条读数）。
- [x] AC6 (e) 类型含 mcp + 穷举夹具：`ChatRunSource` 含 `'mcp'`；`chat-run-registry.test.ts` 的 `Record<ChatRunSource, true>` 夹具覆盖四种取值、四取值循环断言 `run.source === value` 通过；判据内同形穷举常量使 `npm run typecheck` 退出 0。写明命令与结果。
- [x] AC7 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) `send` 不传来源 ⇒ AC2 红；(ii) `mcp` 映射成 `scheduled` ⇒ AC2 红；(iii) 改写无人轮来源 ⇒ AC4 红；(iv) 改掉旧默认 ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 不回归与仓库门：既有 WebSocket 判据逐字通过——至少 `server/modules/websocket/tests/chat-run-registry.test.ts`、`server/modules/websocket/tests/chat-control-ownership.test.ts`、`server/modules/websocket/tests/chat-control-send.test.ts`、`server/modules/providers/tests/claude-resident-unattended-turn.test.ts`（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级，写明计数）；跨模块只经 barrel、无深导入。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 四种来源各有一次由判据实测的正例：mcp 经控制服务 `send` 读回 `'mcp'`、websocket 读回 `'user'`、scheduled 读回 `'scheduled'`、无人轮读回 `'unattended'`；`send` 恒以 `ws = null` 调用，因此 `'user'`/`'mcp'` 的成立只能来自显式映射，不可能来自旧默认——这是「如实记录」的实据。
- 旧默认两臂都被实测：直接 `startRun` 不传来源时有连接记 `'user'`、无连接记 `'scheduled'`，既有调用方行为不变。
- `ChatRunSource` 真的含 `'mcp'`，且 `chat-run-registry.test.ts` 的穷举夹具在 tsc 下拒绝「加取值不改夹具」，四取值循环断言全部读回自身。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号）；不越界实现其它 AC 的范围（见边界）；不改协议与既有判据。

## Touches

- server/shared/types.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/services/chat-control.service.ts
- server/modules/websocket/tests/chat-run-registry.test.ts
- server/modules/websocket/tests/chat-control-source.test.ts (new)
- tasks/gap-ac234-control-run-source-fidelity.md

## 完成记录

实现（commit `6588622c`）：

- `ChatRunSource` 增 `'mcp'`（`server/shared/types.ts`）。
- `dispatchRun` 增可选尾参 `source?: ChatRunSource`，并入 `startInput`，两次 `startRun` 都带；既有调用方不传 ⇒ 旧默认逐字不变。
- `chat-control.service.ts` 增穷举 `SOURCE_BY_VIA: Record<ControlCaller['via'], ChatRunSource>`，`send` 显式传入（`websocket`→`user`、`scheduled`→`scheduled`、`mcp`→`mcp`）。
- `openUnattendedRun` 逐字不改。
- `chat-run-registry.test.ts` 增 `ALL_CHAT_RUN_SOURCES` 夹具与四值循环用例。
- 判据 `server/modules/websocket/tests/chat-control-source.test.ts`（新）。

读数（判据 stdout，`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-source.test.ts`，4 passed / exit 0）：

- (a) `control-source (a) mcp: result={"ok":true} source=mcp`
- (b) `control-source (b) websocket=user scheduled=scheduled`
- (c) `control-source (c) unattended: opened=true source=unattended`
- (d) `control-source (d) defaultWithConnection=user defaultNoConnection=scheduled`
- (e) `control-source (e) exhaustiveMembers=["mcp","scheduled","unattended","user"]`；`npm run typecheck`（三条 tsc 环）退出 0。

取假形态（先提交实现 `6588622c` 再变异，每条先红后恢复）：

(i) `chat-control.service.ts`：`SOURCE_BY_VIA[caller.via]` → `undefined`。红：`AssertionError [ERR_ASSERTION]: an MCP-dispatched run must be recorded as mcp`（(a) `source=scheduled`，exit 1）。恢复：`git checkout -- server/modules/websocket/services/chat-control.service.ts`，复跑 4/4 绿。
(ii) 同文件：`mcp: 'mcp'` → `mcp: 'scheduled'`。红：同上失败行（(a) `source=scheduled`，exit 1）。恢复同上，4/4 绿。
(iii) `chat-run-registry.service.ts`：`openUnattendedRun` 的 `source: 'unattended'` → `'scheduled'`。红：`AssertionError [ERR_ASSERTION]: a host-opened run must stay unattended`（(c) `source=scheduled`，exit 1）。恢复：`git checkout -- server/modules/websocket/services/chat-run-registry.service.ts`，4/4 绿。
(iv) 同文件：`input.source ?? (input.connection ? 'user' : 'scheduled')` → `input.source ?? 'scheduled'`。红：`AssertionError [ERR_ASSERTION]: the old default records a connected run as user`（(d) `defaultWithConnection=scheduled`，exit 1）。恢复同上，4/4 绿。

回归与仓库门：

- `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts server/modules/websocket/tests/chat-control-ownership.test.ts server/modules/websocket/tests/chat-control-send.test.ts server/modules/providers/tests/claude-resident-unattended-turn.test.ts` → 22/22 pass。
- `chat-control-wiring.test.ts` / `chat-control-busy.test.ts` / `chat-edit-send.test.ts` / `chat-control-access.test.ts` → 20/20 pass。
- `npm run typecheck` 退出 0；`npm run lint` 0 个 `: error `。
