---
id: gap-ac230-control-send-immediate-runid
title: AC-230 控制服务 send 在运行登记后立即返回 runId：ChatControlService.send（无 socket、共用
  dispatchRun），判据 server/modules/websocket/tests/chat-control-send.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-230
---
## Proposal

AC-230（GOAL-019 退出条件 1；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「ChatControlService」节）要求控制服务的 `send` 在运行登记后立即返回 `{ ok: true, runId }`，不等运行结束，且 `runId` 就是 `chatRunRegistry` 里那次运行的 id；会话不存在返回 `SESSION_NOT_FOUND`、provider 无运行时返回 `UNSUPPORTED_PROVIDER`，两者都不登记运行；整个判据不构造任何 WebSocket 对象。

现状（红态基线）：判据文件 `server/modules/websocket/tests/chat-control-send.test.ts` 不存在，判据的存在性闸以退出码 1 输出缺失的文件名；`server/modules/websocket/services/chat-control.service.ts` 不存在；`server/modules/websocket/services/chat-websocket.service.ts` 的 `dispatchRun`/`resolveSendTarget` 目前是模块私有，只被 `chat.send` 与 `chat.edit-send` 调用。

要交付：

1. 新增 `server/modules/websocket/services/chat-control.service.ts`，导出工厂 `createChatControlService(deps)`（跨文件消费者：本模块判据 `chat-control-send.test.ts`；后续 AC-233 的 `server/index.ts` 装配）。与传输无关：不接受任何 socket、不构造也不发送协议帧，失败以带稳定错误码的判别结果返回。本任务只实现 `send`（`editSend`/`abort`/`cancelQueued`/`stopTask`/`backgroundTask`/`answerApproval`/`pendingApprovals` 分别由 AC-231/232 补齐）：
   - 签名按 SPEC：`send(caller, { sessionId, content, options?, interruptActiveRun? })`，其中 `caller = { userId: string | number; via: 'websocket' | 'mcp' | 'scheduled' }`；返回 `{ ok: true; runId: string } | { ok: false; code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'RUN_IN_PROGRESS' | 'FORBIDDEN'; message: string }`。
   - 传输无关解析（在登记之前完成，注册表里不留运行）：`sessionsDb.getSessionById(sessionId)` 未命中 ⇒ `SESSION_NOT_FOUND`；`deps.runtime.hasRuntime(session.provider)` 为假 ⇒ `UNSUPPORTED_PROVIDER`。归属检查经 `assertSessionAccess`（沿用 AC-196/197/198 的同一入口；本任务不测 FORBIDDEN，AC-232 负责）。
   - 立即返回：与 `chat.send` 共用同一条登记/分发路径（GOAL-019 范围第 2 条），复用 `chat-websocket.service.ts` 现有的 `dispatchRun`——把该函数 `export`（模块内导出，供控制服务调用，并加一句说明消费方的注释），`send` 以 `ws = null` 调入并传入 `beforeRun(run)` 钩子；钩子被调用即表示 `chatRunRegistry.startRun` 已成功且拿到该次运行的 `run`，据此立即 resolve `{ ok: true, runId: run.runId }`，**不 `await` 运行本身**。`dispatchRun` 的拒发（返回 `started: false`）先于 `beforeRun` 发生，`send` 用「runId 先到还是 dispatch 先落定」的顺序竞速区分「已登记」与「被拒」，绝不依赖超时判定。
   - 后台运行的 `dispatchPromise` 挂 `.catch`（记录日志），确保放行后运行正常结束时没有未处理的拒绝（读数 (c)）。
   - 保持 `dispatchRun` 既有行为逐字不变（常驻会话忙时 `acceptsBusyInput` 重试、`completeRunIfCurrent` 兜底、`RUN_IN_PROGRESS` 分支等），只加 `export` 与注释，不改其逻辑，以保 AC-237（既有 WebSocket 判据逐字通过）。

2. 判据 `server/modules/websocket/tests/chat-control-send.test.ts`（红先行；取 `chat-control-ownership.test.ts` 的注入式形态——临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入假 runtime——但**不构造任何 socket**）。假 runtime 的 `run` 被一个可控延迟对象卡住（`new Promise((resolve) => { release = resolve; })`），`hasRuntime` 可切换布尔。读数：
   (a) `await send(...)` 已返回 `{ ok: true, runId }` 时，延迟对象尚未放行——断言 `released === false`，**顺序断言**，不是「N 毫秒内返回」的超时断言；随后等待假运行确实被调用（有界轮询）仍断言未放行。
   (b) 返回的 `runId` === `chatRunRegistry.getRun(sessionId).runId`，且该次运行 `status === 'running'`。
   (c) 放行延迟对象后，假运行正常结束，`chatRunRegistry.getRun(sessionId).status === 'completed'`；全程监听 `unhandledRejection`，计数为 0。
   (d) 会话不存在 ⇒ 返回 `code === 'SESSION_NOT_FOUND'` 且 `chatRunRegistry.getRun(sessionId) === undefined`；`hasRuntime` 为假 ⇒ 返回 `code === 'UNSUPPORTED_PROVIDER'` 且同样不登记运行。
   (e) 整个判据文件不 import `ws`、不 `new WebSocket(`、不用 socket/事件发射器发消息——(a)–(d) 全部读数在无 socket 下完成。

3. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 让 `send` `await` 运行结束才返回 ⇒ (a) 必须红；(ii) `send` 返回自造的 `randomUUID()` 而不是注册表的 `run.runId` ⇒ (b) 必须红；(iii) 会话不存在时仍先登记运行再返回错误 ⇒ (d) 必须红。

边界：不实现 `editSend`/`abort`/`cancelQueued`/`stopTask`/`backgroundTask`/`answerApproval`/`pendingApprovals`（归 AC-231/232）；不做 `server/index.ts` 单实例装配、不改 `chat.send` 处理器走向（归 AC-233）；不给 `server/modules/websocket/index.ts` 加 barrel 导出（跨模块消费者随 AC-233 的装配一起加，遵守「不导出没有跨文件消费者的符号」）；不加 `ChatRunSource` 的 `mcp`（归 AC-234）；不动 `chatRunRegistry` 的按 id 索引（归 AC-235）；不改真实 Claude 驱动；不改 WebSocket 协议与 `chat.subscribe` 帧序列。

判定纪律：`send` 不构造 socket、不发帧；失败是可判别的错误码返回值，不吞成异常；立即返回用顺序读数（`released === false`）断言，不用超时；改动的 `chat-websocket.service.ts` 不影响既有判据。

## AC

- [x] AC1 判据绿：`for f in server/modules/websocket/tests/chat-control-send.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-send.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-send.test.ts`）。
- [x] AC2 (a) 立即返回、顺序断言：`await send(...)` 返回 `{ ok: true, runId }` 时延迟对象仍被卡住（写下 `released` 读数与断言先后顺序）；随后确认假运行已被调用（有界轮询，非超时断言）。
- [x] AC3 (b) runId 即注册表那次运行：返回的 `runId` === `chatRunRegistry.getRun(<sessionId>).runId`；该运行 `status === 'running'`（写下两个读数）。
- [x] AC4 (c) 放行后完成且无泄漏拒绝：放行延迟对象后运行正常结束，`chatRunRegistry.getRun(sessionId).status === 'completed'`；测试期间 `unhandledRejection` 计数为 0（写下计数）。
- [x] AC5 (d) 两种错误码且都不登记运行：会话不存在 ⇒ `code === 'SESSION_NOT_FOUND'`、`getRun` 为 undefined；`hasRuntime === false` ⇒ `code === 'UNSUPPORTED_PROVIDER'`、`getRun` 为 undefined（写下两条返回与两条 `getRun` 读数）。
- [x] AC6 (e) 无 WebSocket 参与：写下用于核对的 grep 命令与空输出——判据文件不 import `ws`、不 `new WebSocket(`、不构造 socket；且 (a)–(d) 全部读数在该文件内无 socket 完成。
- [x] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) `send` await 运行结束 ⇒ AC2 红；(ii) 返回自造 id ⇒ AC3 红；(iii) 会话不存在仍登记运行 ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 不回归与仓库门：改动后既有 WebSocket 判据保持逐字通过——至少 `chat-control-ownership.test.ts`、`chat-edit-send.test.ts`、`chat-run-registry.test.ts`、`chat-stop-task.test.ts`、`chat-background-task.test.ts`（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级，写明计数）；判据跨模块只经 barrel 导入、无深导入。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 控制服务的 `send` 真的在假运行仍被卡住时返回了 `runId`，且该 `runId` 就是 `chatRunRegistry` 里那次运行的 id；放行后该运行真的完成——三段读数均由判据实测，不是「实现看起来对」。
- 会话不存在与 provider 无运行时各自返回稳定错误码，且注册表里确实没有该会话的运行；整个判据不构造任何 socket。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- `send` 与 `chat.send` 走同一条登记/分发路径（共用 `dispatchRun`），不是第二份注册逻辑；遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不越界导出无消费者符号）；不越界实现 AC-231/232/233，不改协议。

## Touches

- server/modules/websocket/services/chat-control.service.ts (new)
- server/modules/websocket/tests/chat-control-send.test.ts (new)
- server/modules/websocket/services/chat-websocket.service.ts
- tasks/gap-ac230-control-send-immediate-runid.md

## Evidence

（AC-230 执行记录，2026-10-05，worker worktree 分支 `task/gap-ac230-control-send-immediate-runid`，实现提交 `4187dc27`。）

红态基线（AC1）：改动前 `server/modules/websocket/tests/chat-control-send.test.ts` 与 `server/modules/websocket/services/chat-control.service.ts` 在 develop 上均不存在（`git show develop:<path>` 失败）；存在性闸在 develop 上退出 1 并输出 `缺判据文件：server/modules/websocket/tests/chat-control-send.test.ts`。

AC1 绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-send.test.ts` 退出 0，`tests 4 / pass 4 / fail 0`。

AC2/AC3 读数（判据实测）：
- `(a) releasedAtReturn=false runCalledAtReturn=true result={"ok":true,"runId":"290b189a-4e47-4427-a864-20f163c912e6"}`
- `(b) returnedRunId=290b189a-4e47-4427-a864-20f163c912e6 registryRunId=290b189a-4e47-4427-a864-20f163c912e6 status=running`

说明：`await send(...)` 返回时 `runtime.released === false`（顺序断言，非「N 毫秒内返回」超时断言）；随后有界轮询确认假运行确已被调用且仍被卡住。

AC4 读数：`(c) statusAfterRelease=completed unhandledRejections=0`。

AC5 读数：
- `(d) missingSession={"ok":false,"code":"SESSION_NOT_FOUND"} missingGetRun=undefined`
- `(d) unsupportedProvider={"ok":false,"code":"UNSUPPORTED_PROVIDER"} unsupportedGetRun=undefined runCalled=false`

AC6 读数：`grep -nE "from ['\"]ws['\"]|new WebSocket\(|new EventEmitter\(" server/modules/websocket/tests/chat-control-send.test.ts` 无输出（退出 1，即无匹配）；判据内静态守卫同时实测 `(e) socketReferences=[]`。

AC7 取假形态（先提交实现 `4187dc27`；逐条变异 → 必红 → 恢复 → 重跑绿）：
- (i) 变异：在 `if (!outcome.registered)` 之后插入 `// MUTATION (i): wait for the whole run to settle before returning.` 与 `await dispatchPromise;`。逐字失败行：`✖ send returns the registered runId while the run is still in flight (2225.15731ms)` + `  Error: timed out: send to return without the run ending`（整文件退出 1、2 fail、6.4s 内终止无挂起）。恢复：`git checkout -- server/modules/websocket/services/chat-control.service.ts`；恢复后 4 pass。
- (ii) 变异：`beforeRun` 钩子 `resolveRunId(run.runId)` → `resolveRunId('mutation-self-minted-run-id')`。逐字失败行：`✖ send returns the registered runId while the run is still in flight (269.215988ms)` + `  AssertionError [ERR_ASSERTION]: the returned runId is the registered run`（actual=注册表 id，expected='mutation-self-minted-run-id'）。恢复同上；恢复后 4 pass。
- (iii) 变异：会话不存在分支在返回 `SESSION_NOT_FOUND` 前 `chatRunRegistry.startRun({...})`。逐字失败行：`✖ an unknown session and a runtime-less provider are refused without registering a run (215.836039ms)` + `  AssertionError [ERR_ASSERTION]: an unknown session must register no run`（actual=[Object]，expected=undefined）。恢复同上；恢复后 4 pass。

AC8 不回归与仓库门：
- 既有 WebSocket 判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-ownership.test.ts server/modules/websocket/tests/chat-edit-send.test.ts server/modules/websocket/tests/chat-run-registry.test.ts server/modules/websocket/tests/chat-stop-task.test.ts server/modules/websocket/tests/chat-background-task.test.ts` ⇒ `tests 36 / pass 36 / fail 0`。
- `npm run typecheck` 退出 0。
- `npm run lint` 退出 0；`: error ` 计数 0（仅 warning 级，且无一条落在本次新增/改动文件）。
- 新增判据跨模块导入仅经 barrel（`@/modules/database/index.js`、`@/shared/types.js`）；websocket 模块内符号经同模块 `services/` 路径导入，非跨模块深导入。

AC9 对齐：`git diff --stat develop...HEAD` ⇒
`server/modules/websocket/services/chat-control.service.ts | 205 ++++ (new)`、
`server/modules/websocket/services/chat-websocket.service.ts | 8 +-`、
`server/modules/websocket/tests/chat-control-send.test.ts | 303 ++++ (new)`、
`tasks/gap-ac230-control-send-immediate-runid.md`（由 task_write 提交）。
与 `## Touches` 逐条一致，无 Touches 外文件。

边界遵守：未实现其余控制动词（AC-231/232）；未改 `server/index.ts` / `chat.send` 处理器 / barrel 导出 / `ChatRunSource` / `chatRunRegistry` 按 id 索引 / 真实驱动 / WebSocket 协议。