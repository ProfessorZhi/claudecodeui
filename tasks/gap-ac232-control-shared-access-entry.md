---
id: gap-ac232-control-shared-access-entry
title: AC-232
  控制服务五个动作（send/abort/cancelQueued/stopTask/backgroundTask）共用同一个可注入访问入口：未认证一律
  FORBIDDEN 且驱动零调用，判据 server/modules/websocket/tests/chat-control-access.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac231-control-busy-queue-cancel
goal_ac: AC-232
---
## Proposal

AC-232（GOAL-019 退出条件 3；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「ChatControlService」要点 3、决策 D5）要求 `ChatControlService` 的五个控制动作——`send`、`abort`、`cancelQueued`、`stopTask`、`backgroundTask`——全部经过**同一个**访问入口 `assertSessionAccess`，且该入口可经依赖注入替换，以便计数间谍证明「共用一个入口」而不是各自动手检查。未认证的调用方（`caller.userId` 为 `null`、`undefined` 或空串）对五个动作一律得到 `FORBIDDEN`，注入的假驱动（provider runtime）与假运行时对五项驱动动词的调用计数为 0；不注入任何间谍、用生产默认入口时，同样五个未认证调用全部被拒。做法照 AC-198（`chat-control-ownership.test.ts`），但读的是新控制服务本身，不构造任何 socket。

前置：本任务建立在 `gap-ac231-control-busy-queue-cancel` 之上——该任务在 `server/modules/websocket/services/chat-control.service.ts` 上交付了忙时分支与 `cancelQueued`（它本身又依赖更早交付 `send` 的那个任务）。本任务在同一个文件上补 `abort`、`stopTask`、`backgroundTask`，并把五个动作统一到**一个可注入的访问入口缝**。判据文件 `server/modules/websocket/tests/chat-control-access.test.ts` 全新。

现状（红态基线）：判据文件 `server/modules/websocket/tests/chat-control-access.test.ts` 不存在，判据的存在性闸以退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-access.test.ts`；`chat-control.service.ts` 在 gap-ac230/231 完成前不存在。

要交付：

1. **可注入访问入口缝**（`chat-control.service.ts`）。`createChatControlService(deps)` 的 `deps` 增加可选 `assertSessionAccess?: (userId: string | number | null, session: ReturnType<typeof sessionsDb.getSessionById>) => boolean`，缺省为 `chat-websocket.service.ts` **已导出**的生产入口 `assertSessionAccess`（写成 `deps.assertSessionAccess ?? assertSessionAccess`——绝不另写一份恒真默认）。加一个私有 `accessEntry(deps)` 帮助函数（与 gateway 里的同名帮助函数同形），**五个动作**都只经它取入口，且**第一件事**就是调用它，先于任何会话查询、注册表读取或驱动调用。

2. **五个动作的 FORBIDDEN 与「入口先行」**（`chat-control.service.ts`）。入口返回 `false`（未认证）时立刻返回稳定结果、不碰任何下游：
   - `send` → `{ ok: false, code: 'FORBIDDEN', message: … }`；
   - `abort` → `{ ok: false, aborted: false, code: 'FORBIDDEN' }`；
   - `cancelQueued` / `stopTask` / `backgroundTask` → 各自的字符串结果 `'forbidden'`（沿用 gateway 控制动词的既有词汇；stop/background 的结果类型已含 `'forbidden'`）。
   判据用同一个归一化读数函数把两者都读成 "FORBIDDEN"。

3. **补齐 `abort`、`stopTask`、`backgroundTask`**（`chat-control.service.ts`）。三者与传输无关：入口通过后按各自语义走 `deps.runtime`（`abort`/`controlStopTask`/`controlBackgroundTask`），不构造 socket、不发帧。本任务只要求它们**到达入口、入口先行、可被已认证调用方执行**（判据 (a) 只计入口命中次数与该次调用确实越过入口到达驱动）；完整的上游逻辑与 handler 改造归 AC-233，本任务不改 `chat-websocket.service.ts` 里任何处理器走向。会话不存在 / provider 无运行时返回各自稳定错误码（`SESSION_NOT_FOUND` / `UNSUPPORTED_PROVIDER`），不碰驱动。

4. **判据 `server/modules/websocket/tests/chat-control-access.test.ts`**（红先行；复用 AC-198 的注入式形态——临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入假 runtime——但**直接构造 `createChatControlService(deps)`，不构造任何 socket**）。读数：
   (a) 注入计数间谍 `deps.assertSessionAccess`（委托生产 `assertSessionAccess`，因此判决是真的），用一个已认证调用方（`userId` 非空）对五个动作各调用一次：间谍恰好被调用 5 次，逐动作增量各为 1（写下五次增量与总数）；**正例对照**——同一次已认证调用确实越过了入口到达各自驱动（`abort`/`controlStopTask`/`controlBackgroundTask` 计数各 ≥1），证明这 5 次不是「入口后一律拒绝」的空计数。
   (b) 未认证调用方（`userId` 为 `null`，以及空串 `''`）对五个动作各调用一次：五者全部读作 FORBIDDEN；注入的假 runtime 的 `run`/`abort`/`cancelQueuedInput`/`controlStopTask`/`controlBackgroundTask` 五项调用计数全为 0（写下两种调用方各自的判决与五项计数）。
   (c) 不注入间谍、用生产默认入口：同样的五个未认证调用全部读作 FORBIDDEN，假 runtime 五项计数全为 0（防止判据靠替身自证）。
   整个判据文件不 import `ws`、不 `new WebSocket(`、不构造 socket。

5. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 让其中任一动作内联自己的检查、绕过入口（例如 `stopTask` 自己判 `if (!userId) return 'forbidden'`）⇒ (a) 该动作的间谍增量必须为 0 而红；
   (ii) 去掉某一动作的入口检查（例如 `abort` 直接走 `runtime.abort`）⇒ (b) 的驱动计数必须非 0 而红；
   (iii) 默认入口恒放行（把 `deps.assertSessionAccess ?? assertSessionAccess` 的缺省改成恒真的 lambda）⇒ (c) 必须红。
   每条记录恢复命令与恢复后重跑绿。

边界：不做 `server/index.ts` 单实例装配、不改 `chat.send`/`chat.abort`/`chat.cancel-queued`/`chat.stop-task`/`chat.background-task` 的处理器走向（归 AC-233）；不加 `ChatRunSource` 的 `mcp`（归 AC-234）；不做运行保留期/摘要/`expired`（归 AC-235）；不实现宿主启停服务（归 AC-236）；不实现 `editSend`/`answerApproval`/`pendingApprovals`；不改 WebSocket 协议与 `chat.subscribe` 帧序列；不构造 socket；不给 `websocket/index.ts` 新增没有跨文件消费者的导出（`createChatControlService` 的 barrel 导出随 AC-233 的 `server/index.ts` 装配一起加）。

判定纪律：五个动作**只**经一个入口；未认证时驱动零调用是实测计数，不是「实现看起来对」；生产默认入口那一臂 (c) 不能靠注入替身通过；改动的 `chat-control.service.ts` 不影响既有 WebSocket 判据。

## AC

- [x] AC1 判据绿：`for f in server/modules/websocket/tests/chat-control-access.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-access.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-control-access.test.ts`）。
- [x] AC2 (a) 五个动作共用一个入口：注入计数间谍（委托生产入口），已认证调用方对 `send`/`abort`/`cancelQueued`/`stopTask`/`backgroundTask` 各调用一次；间谍总调用恰好 5 次，逐动作增量各 1（写下五次增量与总数）；且同一次已认证调用的 `abort`/`controlStopTask`/`controlBackgroundTask` 驱动计数各 ≥1（正例对照，证明不是入口后一律拒绝）。
- [x] AC3 (b) 未认证一律 FORBIDDEN 且驱动零调用：`userId` 为 `null` 与空串 `''` 两种调用方下，五个动作全部读作 FORBIDDEN；假 runtime 的 `run`/`abort`/`cancelQueuedInput`/`controlStopTask`/`controlBackgroundTask` 五项计数全为 0（写下两种调用方各自的判决与五项计数）。
- [x] AC4 (c) 生产默认入口同样拒绝：不注入任何间谍（走 `assertSessionAccess` 默认），五个未认证调用全部读作 FORBIDDEN，假 runtime 五项计数全为 0（写下判决与计数）。
- [x] AC5 无 WebSocket 参与：写下用于核对的 grep 命令与空输出——判据文件不 import `ws`、不 `new WebSocket(`、不构造 socket；AC2–AC4 全部读数在该文件内直接对 `createChatControlService` 完成。
- [x] AC6 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 某动作内联检查绕过入口 ⇒ AC2 该动作增量 0 而红；(ii) 去掉某动作入口检查 ⇒ AC3 驱动计数非 0 而红；(iii) 默认入口恒放行 ⇒ AC4 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC7 不回归与仓库门：既有 WebSocket 判据保持逐字通过——至少 `chat-control-ownership.test.ts`、`chat-control-send.test.ts`、`chat-control-busy.test.ts`、`chat-edit-send.test.ts`、`chat-stop-task.test.ts`、`chat-background-task.test.ts`（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级，写明计数）；控制服务跨模块只经 barrel 导入、无深导入。
- [x] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 五个动作真的只经过一个入口：计数间谍在已认证调用下总命中 5、逐动作 1；未认证（`null` 与空串 `''`）下五者全部被拒且假驱动的五项计数实测为 0——三段读数均由判据实测，不是「实现看起来对」。
- 不注入任何间谍时，生产默认入口（`assertSessionAccess`）同样拒绝五个未认证调用，驱动零调用；判据不构造任何 socket。
- `abort`/`stopTask`/`backgroundTask` 真实存在于控制服务、入口先行、可被已认证调用方执行；完整 handler 改造留给 AC-233，不越界。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号）；不越界实现其它 AC 的范围（见边界）；不改协议与既有判据。

## Touches

- server/modules/websocket/services/chat-control.service.ts
- server/modules/websocket/tests/chat-control-access.test.ts (new)
- tasks/gap-ac232-control-shared-access-entry.md

## Evidence (AC-232)

判据命令（AC1）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-access.test.ts` → 4 tests / 4 pass / 0 fail（exit 0）。

红态基线（AC1，改动前判据文件不存在）。存在性闸逐字输出：`缺判据文件：server/modules/websocket/tests/chat-control-access.test.ts`，exit 1。

(a) 已认证（AC2）：increments `{send:1,abort:1,cancelQueued:1,stopTask:1,backgroundTask:1,total:5}`；drivers `{run:1,abort:1,cancelQueuedInput:1,controlStopTask:1,controlBackgroundTask:1}`。
(b) 未认证（AC3）：caller=null 与 caller=empty-string 两臂均 verdicts 五项 `FORBIDDEN`、drivers 五项 `0`；entryCalls=10。
(c) 生产默认入口（AC4）：verdicts 五项 `FORBIDDEN`、drivers 五项 `0`（未注入任何间谍）。
(AC5) grep：`grep -nE "from ['\"]ws['\"]|new WebSocket\(|new EventEmitter\(" server/modules/websocket/tests/chat-control-access.test.ts` → 空输出（exit 1）；判据内自检读数 `socketReferences=[]`。

AC6 取假形态（先提交实现 7d921771 再变异；每条恢复命令 `git checkout -- server/modules/websocket/services/chat-control.service.ts`，恢复后重跑 4/4 绿）：
(i) `stopTask` 内联检查绕过入口，diff：`-    if (!accessEntry(deps)(caller.userId, session)) {` → `+    if (caller.userId === null || \`${caller.userId}\`.trim().length === 0) {`。逐字失败行：(a) `actual: { send: 1, abort: 1, cancelQueued: 1, stopTask: 0, backgroundTask: 1, total: 4 }` vs `expected: { ... stopTask: 1, ... total: 5 }`。
(ii) 去掉 `abort` 的入口检查（直接走 `runtime.abort`），diff 删除 abort 的 `accessEntry` 块。逐字失败行：(b) `caller null must be refused on all five`，`actual: { send: 'FORBIDDEN', abort: 'OK', ... }`，`drivers={"run":0,"abort":1,...}`（abort 驱动计数 1）。
(iii) 默认入口恒放行，diff：`-  return dependencies.assertSessionAccess ?? assertSessionAccess;` → `+  return dependencies.assertSessionAccess ?? (() => true);`。逐字失败行：(c) `the production entry must refuse all five`，`actual: { send: 'OK', abort: 'OK', cancelQueued: 'WITHDRAWN', stopTask: 'REQUESTED', backgroundTask: 'REQUESTED' }`。

AC7 不回归：`chat-control-ownership` 4/4、`chat-control-send` 4/4、`chat-control-busy` 5/5、`chat-edit-send` 8/8、`chat-stop-task` 6/6、`chat-background-task` 6/6（均 exit 0）；`npm run typecheck` exit 0；`npm run lint` 的 `: error ` 计数 0（仅 warning）；`chat-control.service.ts` 跨模块 import 仅 `@/modules/database/index.js`、`@/modules/providers/index.js`、`@/shared/types.js` 的 barrel 与同模块 websocket service（无跨模块深导入）。

AC8 `git diff --stat develop...HEAD`：`server/modules/websocket/services/chat-control.service.ts | 258 +++--`、`server/modules/websocket/tests/chat-control-access.test.ts | 375 +++`（2 files changed, 600 insertions, 33 deletions），与 `## Touches` 逐条对齐（task 文件经 task_write 提交）。