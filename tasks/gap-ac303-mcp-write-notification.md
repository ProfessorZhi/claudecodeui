---
id: gap-ac303-mcp-write-notification
title: AC-303 外部客户端成功写调用推送一条通知（不打断、60 秒内合并、通知器抛错不影响结果）；判据
  server/modules/mcp-gateway/tests/mcp-write-notification.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-303
---
## Proposal

**AC-303（GOAL-028 退出条件 1；GOAL-028 范围「来源为 `mcp` 的写调用成功后，经现有的通知模块 `notifyUserIfEnabled` 推送一条通知」）。** 外部客户端（ChatGPT/Gemini 等）放宽确认弹窗后，每次成功写调用必须留下一条事后可见、又不打断的通知：内容含**客户端名称、工具名、目标会话标题、消息前 40 个字符**，**不含**令牌、授权码、完整消息；只读工具与被拒/出错的调用不通知；同一客户端 60 秒内超过 5 次写调用合并成一条带次数的汇总；经 UI WebSocket 的发送与定时发送不触发——只有来源为 `mcp` 的才触发；通知器自己抛错不影响工具调用结果。判据文件 `server/modules/mcp-gateway/tests/mcp-write-notification.test.ts` 当前不存在，AC-303 的存在性闸以退出码 1 逐字输出缺失路径（红先行）。

现状（红态基线）：

- 工具调用的唯一审计 choke point 是 `server/modules/mcp-gateway/mcp-gateway.audit.ts` 的 `withMcpAudit`：它对每次调用写恰好一行 `mcp_audit_log`，并且是唯一知道结果 `ok`/`denied`/`error`、工具名、调用者（`principal.userId`/`tokenId`/`clientId`）与原始 `args` 的地方。它就是「来源为 `mcp`」的判定点——UI WebSocket 发送与定时发送直接驱动共享的 `ChatControlService`（`via: 'websocket'` / `via: 'scheduled'`），从不进入这里。
- 工具是否「只读」有唯一来源：`server/modules/mcp-gateway/mcp-tool-annotations.ts` 的 `MCP_TOOL_ANNOTATIONS`，由 transport 的 `audited` 缝挂到每个生产注册上。`readOnlyHint === false` 即写工具集合——AC-303(a) 的名单由它派生，不硬编码；AC-292 拆分出的 `session_background_stop` 出现后自然纳入。
- 全仓库无任何「写调用通知」：`grep -rn "mcp-write-notification\|notifyMcpWrite" server/` 为空；`server/modules/mcp-gateway/tests/` 无该判据文件。

要交付：

1. **通知模块（新文件 `server/modules/mcp-gateway/mcp-write-notification.ts`；遵守 `$backend-module-standards`）**
   - `export type McpWriteNotificationPayload = { clientName: string; tool: string; sessionTitle: string | null; messagePreview: string | null; count: number };`——`count` 为合并计数，逐条通知时为 1。仅承载这四项事实，**不承载** `args` 原样、令牌、授权码或完整消息。
   - `export type McpWriteNotifier = (payload: McpWriteNotificationPayload) => void | Promise<void>;`——可注入的通知器缝（判据注入间谍；生产默认包裹 `notifyUserIfEnabled`）。
   - `export function createMcpWriteNotifier(deps)`：入参含 `sink: McpWriteNotifier`、`now?: () => number`（默认 `Date.now`）、`windowMs`（默认 60_000）、`threshold`（默认 5）、`resolveClientName(principal)`、`resolveSessionTitle(sessionId)`。返回 `{ notify(input: { principal; tool; args }): void }`：
     - 先按 `readMcpToolAnnotations(tool).readOnlyHint !== false` 判定只读 ⇒ 直接返回，**不调 sink**。
     - 否则构造 payload：`messagePreview` = `typeof args.message === 'string' ? args.message.slice(0, 40) : null`（**绝不写全量**）；`sessionTitle` = `resolveSessionTitle(args.session)`；`clientName` = `resolveClientName(principal)`。
     - 合并规则：以调用者为键（`tokenId` 优先，回退 `clientId`），自 `now()` 起 60_000ms 窗口内；前 `threshold`(=5) 条各调一次 `sink`（`count: 1`）；第 `threshold+1` 条及以后**不再逐条调 sink**，而是在该窗口内只发一条汇总 payload（`count` = 该窗口累计写调用次数），随后该调用者的窗口重置。窗口状态是**工厂实例内**的闭包（不是 module-level），这样同一进程里多次挂载与判据注入的假时钟不会互相遮蔽。
   - 生产装配 `export function createMcpWriteNotification(deps)`（或等价导出）：默认 `sink` 调 `notifyUserIfEnabled`（经 `@/modules/notifications/index.js` barrel），默认 `resolveClientName` 由 `principal.clientId` 读 OAuth 客户端名（经 `@/modules/oauth/index.js` barrel；`clientId === null` 的 PAT 回退到令牌标签/固定串），默认 `resolveSessionTitle` 由 `args.session` 读 `sessionsDb`（经 `@/modules/database/index.js` barrel）。全部经 barrel，不深引其它模块。
2. **审计包装器的 ok 分支挂钩（`server/modules/mcp-gateway/mcp-gateway.audit.ts`）**：给注册/工厂增加一个可选通知缝；**只在 `ok` 分支**（handler 正常返回、写审计行之后）调用，且整段包 `try/catch`——通知器抛错被吞掉，**不改变**返回的 `CallToolResult`，也不改变审计行。`denied` / `error` 分支绝不调用。缝缺席时行为与今日**逐字相同**（AC-244 的判据不受影响）。
3. **transport 线程化（`server/modules/mcp-gateway/mcp-gateway.transport.ts`）**：`McpGatewayDeps` 增加可选 `writeNotifications` 缝，`audited` 助手把它交给 `withMcpAudit`；缺席保持旧行为。
4. **生产装配（`server/index.ts`）**：经 `createMcpGatewayModule` 把生产通知器接上（不是只在测试里存在），让线上真的会推送。barrel 导出在 `server/modules/mcp-gateway/index.ts` 补齐。
5. **判据（新文件 `server/modules/mcp-gateway/tests/mcp-write-notification.test.ts`）**：真实 HTTP（`node:http`，**不用 `fetch`**——`listen(0)` 会抽到 undici 拒绝的坏端口，见 AC-240/244 同款说明），挂**生产装配**（真 `withMcpAudit`、真 token 中间件、temp sqlite），注入通知器间谍与假时钟（`now`），读数 (a)–(e) 见 AC。
6. **同步钉数**：本任务新增一个服务端测试文件，必须同 commit 把 `server/shared/tests/quay-test-script.test.ts` 的两处钉数从 `known=3 unknown=234` / `known=1 unknown=236` 改为 `known=3 unknown=235` / `known=1 unknown=237`，否则全队全量 suite 变红且被驱动报成 UNATTRIBUTABLE（见 `## Notes`）。

## AC

- [x] 判据文件 `server/modules/mcp-gateway/tests/mcp-write-notification.test.ts` 存在；`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-write-notification.test.ts` 退出码 0。存在性闸当前以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-write-notification.test.ts`（红先行）。

- [x] (a) 读数为真实 HTTP + 注入通知器间谍：写工具集合**由 `tools/list` 返回的 `annotations.readOnlyHint === false` 派生**（注册表驱动，不硬编码名单；今天至少含 `session_send` / `session_create` / `session_interrupt` / `session_start` / `session_close` / `session_cancel_queued` / `session_reconfigure` / `session_background` / `approval_answer`，`session_background_stop` 出现后自然纳入）。对每个写工具各发一次成功调用，断言间谍各被调用恰好一次（`count: 1`）；payload 含客户端名称、工具名、目标会话标题（对 `session_send` 这类有标题目标断言其出现）、`args.message` 的前 40 字符；且**不含**令牌字符串、`args` 里的授权码/密钥值、以及完整消息（用一个 >40 字的消息，断言第 41 字符起不出现在 payload 的任一字段）。

- [x] (b) 只读工具调用、scope 不足被拒（审计 `denied`）、handler 抛错（审计 `error`）三类各发真实 HTTP 调用，断言间谍计数不变（对三类各自断言，且三类均真的发生：读工具的 `ok`、被拒的 `denied`、抛错的 `error` 各至少一行审计，审计行错位也红）。

- [x] (c) 假时钟下同一客户端（同 `tokenId`/`clientId`）60 秒内发 6 次写调用：断言前 5 次各一条逐条通知，第 6 次**不产生第 6 条逐条通知**，而是出现一条 `count === 6`（或该窗口累计次数）的汇总通知；把假时钟推过 60 秒后再发一次，断言恢复逐条。全程不真等 60 秒。

- [x] (d) 驱动 UI WebSocket 发送路径（共享 `ChatControlService`，`via: 'websocket'`）与定时发送路径（`via: 'scheduled'`）各一次，断言间谍计数不变；随后一次经 `/mcp` 的写调用计数 +1。

- [x] (e) 注入一个抛错的通知器，发一次成功写调用：断言 HTTP 返回的成功载荷与审计行 `outcome = 'ok'` 与通知器不抛时**逐字相同**（通知器抛错不改变工具结果，也不产生 `error`）。

- [x] 变异 (i)（只读工具也通知 ⇒ (b) 必须红）：先提交实现与判据，再把 `createMcpWriteNotifier` 中判定 `readOnlyHint` 的分支改成恒真放行，运行判据，(b) 必须红；逐字记录 `git diff`、失败行、恢复命令（`git checkout -- server/modules/mcp-gateway/mcp-write-notification.ts`），随后恢复并复跑至绿。

- [x] 变异 (ii)（通知里带完整消息 ⇒ (a) 必须红）：把 `messagePreview` 换成完整 `args.message`，运行判据，(a) 必须红；记录 diff/失败行/恢复命令，恢复后复跑至绿。

- [x] 变异 (iii)（通知器抛错时工具调用失败 ⇒ (e) 必须红）：移除 ok 分支的 `try/catch` 使 sink 抛错冒泡，运行判据，(e) 必须红；记录 diff/失败行/恢复命令，恢复后复跑至绿。

- [x] `server/shared/tests/quay-test-script.test.ts` 两处钉数同步为 `known=3 unknown=235` 与 `known=1 unknown=237`；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0。

- [x] `npm run typecheck`、`npm run lint`、`npm run build` 通过（GOAL-028 退出条件 3）。

## DoD

- **真落地**：在生产装配路径（`server/index.ts` → `createMcpGatewayModule` → `mountMcpGateway`）上，一个真实的 `/mcp` 写调用会经注入的通知器缝推送出含四项事实、不含令牌/完整消息的 payload；同一机制在 UI WebSocket 与定时发送路径上不推送。不是「测试里存在」——是生产装配真的武装了通知器。
- **红先行证据**：判据文件落地前，AC-303 的存在性闸以退出码 1 输出缺失文件名；判据文件落地后全绿。
- **三条变异记录**逐字入任务完成记录：每条含变异 `git diff`、判据的逐字失败行、恢复命令与恢复后复跑读数；每条只让指定腿变红（(i)→(b)、(ii)→(a)、(iii)→(e)）。
- **不回归**：AC-244 的 `mcp-audit.test.ts` 全绿（审计行为逐字不变——通知缝缺席/存在都不改审计行与工具返回）；钉数同步后 `quay-test-script.test.ts` 全绿。
- **后端规范**：新增/改动的 `server/` 代码遵守 `$backend-module-standards`——跨模块走 barrel（notifications / oauth / database），导出只给必要成员并附消费方注释，无 module-local types/utils。

## Touches

- server/modules/mcp-gateway/mcp-write-notification.ts (new)
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-write-notification.test.ts (new)（判据）
- server/shared/tests/quay-test-script.test.ts（同步钉数 known/unknown 各 +1）
- tasks/gap-ac303-mcp-write-notification.md

## Notes

- 判据的 HTTP 调用用 `node:http` 不用 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的固定端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-244 同款说明）。
- 写/读分类只能有一个来源：`MCP_TOOL_ANNOTATIONS.readOnlyHint`。不要在本任务里另立一份写工具名单——那正是「注册表驱动、新工具自然纳入」要求排除的漂移（AC-292 的 `session_background_stop` 出现后应零改动纳入）。
- 合并窗口的状态放在 `createMcpWriteNotifier` 返回的闭包里，不要放 module-level 缓存：否则同一进程内的多次挂载与判据的假时钟会互相污染（AC-244 的保留期缝就是为同一理由无 module-level 计时器）。
- 通知器抛错被吞（`try/catch`）是硬要求 (e)：吞掉后仍返回原来的成功载荷、审计仍记 `ok`。
- 生产 `sink` 走既有 `notifyUserIfEnabled`（`@/modules/notifications/index.js`）；不新增设置项、不改通知偏好模型（AC-304 才做回看接口，不在本任务范围）。

## 完成记录（2026-10-06）

实现提交：`0606f9db`（branch `task/gap-ac303-mcp-write-notification`）。

### 判据读数（逐字）

AC 命令（存在性闸 + 单文件运行）：

    npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-write-notification.test.ts

    ✔ (a) every write tool from tools/list notifies once with the four facts and nothing else
    ✔ (b) a read-only ok, a denied write and an erroring write notify nobody and leave their own audit row
    ✔ (c) six writes inside one window collapse from five individuals to one summary
    ✔ (d) the shared control service is driven by websocket/scheduled without notifying; /mcp notifies
    ✔ (e) a throwing notifier leaves the payload and the ok audit row identical
    ℹ tests 5  ℹ pass 5  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0
    退出码 0

腿 (a) 的写工具集合由 `tools/list` 的 `annotations.readOnlyHint === false` 派生，实读：`["approval_answer","session_background","session_cancel_queued","session_close","session_create","session_interrupt","session_reconfigure","session_send","session_start"]`（9 个；`session_background_stop` 落地后自然纳入，零改动）。

### 三条变异记录（先提交实现与判据，逐条变异、读红、恢复、复绿）

#### 变异 (i)：只读工具也通知 ⇒ (b) 必须红

变异 `git diff`：

    diff --git a/server/modules/mcp-gateway/mcp-write-notification.ts b/server/modules/mcp-gateway/mcp-write-notification.ts
    @@ -183,7 +183,7 @@ export function createMcpWriteNotifier(deps: McpWriteNotifierDeps): McpWriteNoti
    -      if (readMcpToolAnnotations(input.tool).readOnlyHint !== false) {
    +      if (readMcpToolAnnotations(input.tool).readOnlyHint !== false && false) {

逐字失败行：

    AssertionError [ERR_ASSERTION]: a read-only, a denied and an erroring call must notify nobody (got [{"clientName":"个人访问令牌","tool":"approvals_list",...,"count":1}])
    ℹ tests 5  ℹ pass 4  ℹ fail 1

（红在 (b) 腿；只读的 `approvals_list` 也被通知，其余四腿不受影响。）

恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-write-notification.ts`
恢复后复跑：(b) 腿通过，`tests 5 / pass 5 / fail 0`。

#### 变异 (ii)：通知里带完整消息 ⇒ (a) 必须红

变异 `git diff`：

    diff --git a/server/modules/mcp-gateway/mcp-write-notification.ts b/server/modules/mcp-gateway/mcp-write-notification.ts
    @@ -131,7 +131,7 @@ function sessionIdOf(args: Record<string, unknown>): string | null {
     function messagePreviewOf(args: Record<string, unknown>): string | null {
    -  return typeof args.message === 'string' ? args.message.slice(0, PREVIEW_LENGTH) : null;
    +  return typeof args.message === 'string' ? args.message : null;

逐字失败行：

    AssertionError [ERR_ASSERTION]: session_send's preview is the first 40 chars or null
    ℹ tests 5  ℹ pass 4  ℹ fail 1

（红在 (a) 腿：完整消息的第 41 字符起泄进 payload。）

恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-write-notification.ts`
恢复后复跑：(a) 腿通过，`tests 5 / pass 5 / fail 0`。

#### 变异 (iii)：通知器抛错时工具调用失败 ⇒ (e) 必须红

变异 `git diff`：

    diff --git a/server/modules/mcp-gateway/mcp-gateway.audit.ts b/server/modules/mcp-gateway/mcp-gateway.audit.ts
    @@ -312,12 +312,7 @@ export function withMcpAudit(
           if (writeNotifications !== undefined) {
    -            try {
    -              writeNotifications.notify({ principal, tool: registration.name, args });
    -            } catch {
    -              // Swallowed by design — the audit row above is already `ok` and the
    -              // caller still receives the handler's result.
    -            }
    +            writeNotifications.notify({ principal, tool: registration.name, args });
           }

逐字失败行：

    AssertionError [ERR_ASSERTION]: a throwing notifier must NOT turn the call into an error result
    ℹ tests 5  ℹ pass 4  ℹ fail 1

（红在 (e) 腿：sink 抛错冒泡到外层 catch，成功调用被写成 `error` / `isError`。）

恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-gateway.audit.ts`
恢复后复跑：(e) 腿通过，`tests 5 / pass 5 / fail 0`。

### 不回归与其他读数（逐字）

- `mcp-audit.test.ts`（AC-244）：`tests 5 / pass 5 / fail 0`，退出码 0。
- `quay-test-script.test.ts`：`tests 11 / pass 11 / fail 0`，退出码 0。
- `npm run typecheck`：退出码 0（`tsc --noEmit` × root/server/scripts 三个 tsconfig）。
- `npm run lint`：退出码 0。
- `npm run build`：退出码 0。

### 钉数说明：实读 `unknown=236` / `unknown=238`，非任务书所写 235 / 237

任务书（Proposal 第 6 条与 AC）要求同步为 `known=3 unknown=235` / `known=1 unknown=237`（对应服务端测试文件数 238）。落地时服务端测试文件数**已经是 238**（自本任务撰写后，另一任务先落了一个测试文件），本任务再加一个后为 239，故**正确的**钉数是 `known=3 unknown=236` 与 `known=1 unknown=238`（各比任务书多 1）。实读 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` = 239；pin 测试 11/11 绿。若照任务书写 235/237，`quay-test-script.test.ts` 会因 stale pin 变红，并被驱动报成 UNATTRIBUTABLE。
