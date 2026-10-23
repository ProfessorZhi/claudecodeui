---
id: gap-ac273-mcp-session-background
title: AC-273 session_background：只读列出该会话持有的 background-task 与 cron lease（含
  id/种类/是否周期，取自宿主快照，cloudcli:read 即可）；带 stopTaskId 时经控制服务 stopTask 停止（需
  cloudcli:session:control，只读令牌被拒且控制服务调用计数为 0）；停止不存在的 id 明确未找到、不虚报已停止；停止后再次列出该
  lease 消失；冷会话（无宿主）列出为空并说明没有宿主；判据
  server/modules/mcp-gateway/tests/mcp-session-background.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac271-mcp-session-cancel-queued
  - gap-ac272-mcp-session-reconfigure
  - gap-ac249-session-send-immediate-runid
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac241-mcp-token-auth-shares-service
goal_ac: AC-273
---
## Proposal

AC-273（GOAL-022 退出条件 3；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 `session_background` §284、scope 表 §329「`cloudcli:session:control` = …、停止后台任务」、阶段 6 §525 与 §284 的「`ChatControlService.stopTask` + 宿主 leases」）要求 MCP 工具 `session_background({ session, stopTaskId? })`：

- (a) 只读列出该会话持有的 `background-task` 与 `cron` lease，含 `id`、种类、是否周期（`recurring`），数据取自**宿主快照**，`cloudcli:read` 即可；
- (b) 带 `stopTaskId` 时经控制服务的 `stopTask` 停止，需要 `cloudcli:session:control`；只读令牌**被拒**且控制服务调用计数为 **0**；
- (c) 停止一个不存在的 id 返回**明确的未找到**，**不虚报已停止**；
- (d) 停止后再次列出，该 lease **消失**；
- (e) 冷会话（无宿主）列出为**空**并**说明没有宿主**。

判据文件 `server/modules/mcp-gateway/tests/mcp-session-background.test.ts` **当前不存在**，AC-273 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-background.test.ts`（已实测复现）。

现状（红态基线）：

- **MCP 工具层尚不存在**：`mountMcpGateway` 目前只注册空的 `tools/list`（`mcp-gateway.transport.ts`，注释「No tools are registered yet — AC-245+ fills them」）；令牌主体 `McpPrincipal`（AC-241）、审计包装与调用期 scope 比较 `withMcpAudit`（AC-244）、只读/写工具注册缝（AC-245/AC-249）、阶段 6 常驻工具集合 `MCP_STAGE6_RESIDENT_TOOLS` + `registerMcpResidentTools`（AC-271，AC-272 已向其追加 `session_reconfigure`）均**未落地**。`session_background` 在 `server/` 全库**零命中**（仅 SPEC §284 一行）。
- **宿主快照已具备 lease（本任务的数据源）**：`HostLease` 联合类型（`server/shared/types.ts:1985`）`{ kind:'turn'; runId }` | `{ kind:'background-task'|'monitor'; id; since?; inferred? }` | `{ kind:'cron'; id; recurring; expiresAt; inferred? }` | `{ kind:'resident-policy' }`；`SessionBinding.leases: HostLease[]`（`types.ts:2004`）。`SessionHostManager.snapshot(): ProcessHost[]`（`server/modules/session-hosts/session-host-manager.service.ts:1435`）与 `liveHostForSession(appSessionId): ProcessHost | null`（:1454）返回**分离副本**，`ProcessHost.bindings` 是 `Map<appSessionId, SessionBinding>`。生产里 lease 由 `addLease`（:697）/`removeLease`（:724）写入，来源有两条：驱动自己的 `observeHeldWorkEvent`/`reconcileHeldWork`/`inferHeldWork`/`cronsFromStopList`（`list/claude/claude-host-driver.provider.ts`）与纯投影 `deriveHeldWorkLeases`（`server/modules/providers/services/claude-activity-lease-deriver.service.ts:124`，cron 行带 `recurring`，常驻路径把 monitor 折进 `background-task`）。`resident-host.service.ts` 有把 lease 重新投影、保证 `since` 的既有先例。
- **控制服务 `stopTask` 已具备（本任务经它停止）**：`createChatControlService`（`server/modules/websocket/services/chat-control.service.ts`）的 `stopTask(caller, { sessionId, taskId })`（:567）先过共享访问入口 `accessEntry`，会话不存在 ⇒ `SESSION_NOT_FOUND`、无 runtime ⇒ `UNSUPPORTED_PROVIDER`，否则 `deps.runtime.controlStopTask?.(provider, sessionId, taskId) ?? 'unsupported'`。返回 `StopTaskResult = ControlStopTaskOutcome | ControlVerbRefusal`：`ControlStopTaskOutcome = 'requested' | 'unsupported' | 'timeout' | 'error'`（`provider-runtime.service.ts:63`）、`ControlVerbRefusal = 'forbidden' | 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER'`（`chat-control.service.ts:174`）。`boundStopTaskCall`（`provider-runtime.service.ts:437`）只在驱动**真的被叫到**时回 `'requested'`（驱动 `false` ⇒ `unsupported`，抛错 ⇒ `error`）。驱动 `stopTask(appSessionId, taskId)`（`claude-host-driver.provider.ts:2326`）当 live 进程的 query 无 `stopTask` 动词时回 `false`，**对 SDK「默默接受未知 id」不回确认**——「真的停了」是 task table 从 `task_notification(stopped)` 帧学到的，**不是**这次调用返回的。
- **WS 侧对照，说明「未找到」的来源**：`handleChatStopTask`（`chat-websocket.service.ts:1114`）在调 runtime 前用 **task table** 的 `getTask` 判 `unknown-task`（:1172–1177），并先用 `residentControlVerbEntry` 判 `unsupported`（:1167）。MCP 侧 `session_background` 的对应来源是 **宿主快照的 lease 列表**——AC-273 (a) 明确要求「数据取自宿主快照」，故「该会话是否持有这个 id」由快照判定，而不是另造一份任务表。
- **scope 词汇**：`cloudcli:read`（只读工具）、`cloudcli:session:control`（含「停止后台任务」）取自 SPEC §329；若 AC-243 已落地 `ACCESS_TOKEN_SCOPES` 常量则从 `@/modules/oauth/index.js` 导入，不重写字面量。
- **调用期 scope 门**：AC-244 的 `withMcpAudit` 在**调用期**按工具注册的 `requiredScopes` 与 `McpPrincipal.scopes` 比较，不足则写 `denied` 审计并**不进 handler**。`session_background` 的 SPEC scope 行是 **`read` / `session:control`** 双 scope（列只读、停要 control），故工具注册的静态 `requiredScopes` 取 `['cloudcli:read']`（让只读令牌能列出），**停止分支的 `cloudcli:session:control` 校验由适配层自己拥有**——本 AC (b) 只要求「只读令牌被拒 + 控制服务调用计数为 0」，不额外要求审计行 outcome（审计行归 AC-244/AC-249 自己的判据）。若 AC-245/AC-249 实际落地的注册缝支持按输入解析 scope（`requiredScopes: string[] | (input) => string[]`），优先用它把 control scope 交还审计门，但**读数要求不变**。

要交付：

1. **适配层（新文件 `server/modules/mcp-gateway/mcp-session-background.ts`；遵守 `$backend-module-standards`，导出带消费方注释，不导出无消费者符号）**，导出可注入 deps 与实现：
   - `export type McpSessionBackgroundDeps = { sessions: { getSessionById(sessionId: string): { provider: string } | null | undefined }; hosts: { liveHostForSession(sessionId: string): { state: string; pid?: number; bindings: Map<string, { leases: HostLease[] }> } | null }; control: { stopTask(caller: ControlCaller, input: { sessionId: string; taskId: string }): Promise<StopTaskResult> } }`——全部可注入（判据传真单例或自己的 spy）。`hosts` 的形状以 AC-245 落地的 session-hosts dep 为准（`session_get` 已读同一快照）：若 AC-245 暴露的是别的读法（如 `snapshot()` / 投影函数），沿用它，不新造第二份宿主读法。
   - `export type SessionBackgroundTask = { id: string; kind: 'background-task' | 'cron'; recurring: boolean }`（`background-task` 恒 `recurring:false`；`cron` 取 lease 的 `recurring` 逐字）。
   - `export async function buildSessionBackground(input: { session: string; stopTaskId?: string }, ctx: { principal: McpPrincipal }, deps: McpSessionBackgroundDeps): Promise<SessionBackgroundPayload>`：
     - 解析 `session` 到 sessionId（若 AC-246 已落地经其解析器；本判据用精确 session id，唯一命中）。会话不存在 ⇒ 结构化错误 `SESSION_NOT_FOUND`，**零副作用**。
     - **取宿主快照（(a)(e) 的数据源）**：`const host = deps.hosts.liveHostForSession(sessionId)`；`const leases = host?.bindings.get(sessionId)?.leases ?? []`；`const tasks = leases.filter(l => l.kind === 'background-task' || l.kind === 'cron').map(l => ({ id: l.id, kind: l.kind, recurring: l.kind === 'cron' ? l.recurring : false }))`。**两类都要**（漏掉 `cron` ⇒ (a) 红；漏掉 `background-task` 同理）；`turn`/`resident-policy` 不列。
     - **冷会话 (e)**：无实时宿主（`host === null`，或宿主存在但该 binding 不在其中）⇒ 返回 `{ ok:true, session, host:null, tasks:[], message:'该会话当前没有常驻宿主，没有后台任务或计划。' }`（`message` 逐字含「没有宿主」），`isError` 为假。
     - **停止分支 (b)(c)(d)**——仅当 `input.stopTaskId` 非空：
       - **scope 自检先行**：`if (!ctx.principal.scopes.includes('cloudcli:session:control')) return { ok:false, code:'SCOPE_DENIED', message:'停止后台任务需要 cloudcli:session:control。' }`——**在调控制服务之前**，故只读令牌的 control 调用计数为 0；声明为工具结果 `isError`。（若注册缝支持按输入 scope 解析，则把该校验交给它，读数不变。）
       - **成员预检 (c)**：`const target = tasks.find(t => t.id === input.stopTaskId)`；`!target` ⇒ 返回 `{ ok:false, code:'TASK_NOT_FOUND', taskId: input.stopTaskId, message:'该会话没有 id 为 "<x>" 的后台任务或计划。' }`，**不调控制服务**（`:0` 计数），**绝不**把结果读成 `stopped:true`。这是「不存在的 id 明确未找到、不虚报已停止」的落点（WS 侧对应的是 task table 的 `unknown-task`；MCP 侧的「存在」就是宿主快照里的 lease）。
       - **经控制服务停止 (b)**：`const outcome = await deps.control.stopTask({ userId: ctx.principal.userId, via: 'mcp' }, { sessionId, taskId: input.stopTaskId })`。映射（**逐字如实，绝不虚报**）：`'requested'` ⇒ `{ ok:true, stopped:true, taskId, remaining: <重新读快照后的 tasks> }`；`'unsupported' | 'timeout' | 'error'` ⇒ `{ ok:false, code:'STOP_UNSUPPORTED'|'STOP_TIMEOUT'|'STOP_ERROR', taskId, remaining, message }`（**不含** `stopped:true`）；`'forbidden' | 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER'` ⇒ 结构化拒绝（照原样透出，不读成成功）。
       - 停止成功时**重新读一次宿主快照**，把 `remaining` 放进响应（(d) 亦可由随后一次独立 `session_background` 读出）。
     - 返回体至少含 `{ ok:boolean, session, host: {state,pid} | null, tasks: SessionBackgroundTask[], stopped?: boolean, taskId?: string, remaining?: SessionBackgroundTask[], code?: string, message?: string }`。
   - `export function registerMcpSessionBackgroundTool(seam, deps)`：经 AC-244 的 `withMcpAudit` 注册 `session_background`，静态 `requiredScopes: ['cloudcli:read']`（SPEC §329 双 scope 的只读一半；control 一半由第 1 条的自检拥有）。handler 是上面的真实实现。
2. **阶段 6 常驻工具集合追加**（`server/modules/mcp-gateway/mcp-gateway.resident-tools.ts`，AC-271 已建、AC-272 已追加 `session_reconfigure`；**不修改 AC-271/AC-272 的判据**）：向 `MCP_STAGE6_RESIDENT_TOOLS` 追加 `{ name: 'session_background', scope: 'cloudcli:read' }`（该集合仍是阶段 6 工具名的**唯一事实来源**），并在 `registerMcpResidentTools` 里经同一审计包装注册本工具（复用第 1 条的 handler）。
3. **接线（`server/modules/mcp-gateway/mcp-gateway.transport.ts` + `server/modules/mcp-gateway/index.ts`）**：`mountMcpGateway` 用 AC-249 已注入的**同一个**控制服务单例（不新建实例），并取 AC-245 已注入的 session-hosts 读缝作为 `hosts`；barrel 导出 `buildSessionBackground`、`McpSessionBackgroundDeps`、`SessionBackgroundTask`、`SessionBackgroundPayload`、`registerMcpSessionBackgroundTool`，各写消费方注释。跨模块只经 barrel。**若 AC-245/AC-249 落地的缝不允许在注册时注入 deps（需改 `server/index.ts` 或别的文件），先用 `task_write` 把该文件加进本任务 `## Touches` 再改**（`quay-touches-must-match-actual-write-sites`）。
4. **判据文件 `server/modules/mcp-gateway/tests/mcp-session-background.test.ts`（红先行）**：形制照 AC-245/AC-249/AC-271——`mkdtemp` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发**两枚**真令牌（`T_read` 带 `['cloudcli:read']`；`T_ctl` 带 `['cloudcli:read','cloudcli:session:control']`）+ 同一 express 4 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；客户端用 MCP SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`（避开 `listen(0)` 的 undici 坏端口，内存 `undici-bad-port-lottery-in-listen0-route-tests`）。**常驻会话用真实 `createSessionHostManager` + 真实 `ClaudeResidentHostDriver`（其 `createSdkResidentProcess` 只替换 `createQuery`，形制照 `server/modules/providers/tests/claude-resident-permissions.test.ts`：脚本化 query 暴露 `stopTask` 间谍与固定 `PROCESS_PID`）**，接进真实 `createProviderRuntimeService({ sessionHostManager, ... })`；宿主里为会话 `S` 绑定 resident，并用 manager 自己的 `addLease` 播下三类 lease：`{ kind:'background-task', id:'bg-1' }`、`{ kind:'cron', id:'cron-1', recurring:true, expiresAt: now+7*24h }`、`{ kind:'cron', id:'wake-1', recurring:false, expiresAt: now+7*24h }`。MCP 网关的控制服务用真 `createChatControlService` 包一层**计数代理**（`stopTask` 委托真实现并计数）；脚本化 query 的 `stopTask(taskId)` 在到达时调 `manager.removeLease(S, 'background-task', taskId)`（即生产终结帧 `task_notification(stopped)` 经 `reconcileHeldWork` 走的同一条 `removeLease`），使 (d) 的「列表消失」是**真**读数而非判据自改状态。冷会话 `S_cold` 在库里但无实时宿主。读数各自独立成断言并逐字写出原始值：
   - (a) **列出两类 lease、含 id/种类/是否周期、只读令牌即可**：`T_read` 经 MCP `session_background({ session:S })` ⇒ 工具 `isError` 为假；`tasks` 集合逐字等于 `[{bg-1, background-task, recurring:false}, {cron-1, cron, recurring:true}, {wake-1, cron, recurring:false}]`（按 id 排序后逐一写出）；`host.state`/`host.pid` 非空。正例对照：`tasks` 非空且**同时**含 `background-task` 与 `cron` 两种 kinds（防「空列表」与「漏一类」也通过）。
   - (b) **只读令牌被拒且控制计数 0；control 令牌经控制服务停止**：`T_read` 经 MCP `session_background({ session:S, stopTaskId:'bg-1' })` ⇒ 工具结果 `isError` 为真、（若可读）`code==='SCOPE_DENIED'`；计数代理 `stopTask` 计数为 **0**；随后 `T_read` 再列 `session_background({ session:S })` ⇒ `bg-1` **仍在**。再 `T_ctl` 同一停止调用 ⇒ `isError` 为假、`stopped===true`、count 变为 **1**；把脚本化 query 的 `stopTask` 间谍收到的 `taskId` 逐字写出（等于 `'bg-1'`）。逐字写出两侧返回、计数前后、`bg-1` 前后。
   - (c) **不存在的 id 明确未找到、不虚报已停止、控制计数不变**：`T_ctl` 经 MCP `session_background({ session:S, stopTaskId:'no-such-id' })` ⇒ 工具结果 `isError` 为真、`code==='TASK_NOT_FOUND'`、响应**不含** `stopped:true`；计数代理 `stopTask` 计数在本调用前后**不变**；随后再列，lease 集合逐字不变。正例对照（防「一切都回未找到」）：用**存在**的 id 的取消读数见 (b) 成功一侧。可选加读：让脚本化 query 的 `stopTask` 返回 `false`（动词缺失）⇒ 工具回 `ok:false`/`code==='STOP_UNSUPPORTED'`、**不** `stopped:true`——「请求被放置 ≠ 已停止」的如实读数，逐字写出。
   - (d) **停止后再次列出，该 lease 消失**：承接 (b) 的成功停止（脚本化 query 已 `removeLease('bg-1')`），`T_ctl` 经 MCP `session_background({ session:S })` ⇒ `tasks` 含 `cron-1`/`wake-1`、**不含** `bg-1`（逐字写出停止前后两份 `tasks` 与两组 id）。正例对照：`cron-1`/`wake-1` 仍在（防「清空整张表」也通过）。
   - (e) **冷会话列出为空并说明没有宿主**：`T_read`（或 `T_ctl`）经 MCP `session_background({ session:S_cold })` ⇒ 工具 `isError` 为假、`tasks` 为空数组、`host` 为 `null`（或等价的明确「无宿主」字段）、`message` 逐字含「没有宿主」。正例对照：`S` 的同一调用 `host` 非空（防「一律说没有宿主」也通过）。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) **只读令牌也能停止**（去掉适配层的 `cloudcli:session:control` 自检，或让停止分支绕过它）⇒ (b) 必须红（只读令牌的停止调用到达 control，计数 ≥1）；
   (ii) **不存在的 id 回「已停止」**（去掉宿主快照的成员预检，直接把 control 的 `'requested'` 读成 `stopped:true`）⇒ (c) 必须红；
   (iii) **列表漏掉 cron**（投影只保留 `kind==='background-task'`，滤掉 `cron`）⇒ (a) 必须红。
   每条记录变异 diff、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。
5. **不回归与仓库门**：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写明计数）；AC-271 判据 `mcp-cancel-queued.test.ts`、AC-272 判据 `mcp-session-reconfigure.test.ts`、AC-249 判据 `mcp-session-send.test.ts`、AC-245 判据 `mcp-read-tools.test.ts` **不改一字**仍逐字通过；`chat-stop-task.test.ts`、`claude-resident-permissions.test.ts` 不改一字仍逐字通过。跨模块只经 barrel。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-273" tasks/` 为空；本仓库无任何任务带 `goal_ac: AC-273`。`grep -rln "AC-273" tasks/` 只命中 `gap-ac272-mcp-session-reconfigure.md` 的边界段（其声明「不越界实现 AC-273–AC-277」）。相关但不同：`gap-ac271-mcp-session-cancel-queued`（AC-271）交付 `mcp-gateway.resident-tools.ts` 与阶段 6 注册缝（本任务向集合追加，不重写）；`gap-ac272-mcp-session-reconfigure`（AC-272）交付 `session_reconfigure` 并同向该集合追加（本任务紧随其后，避免并发改同一文件）；`gap-ac249-session-send-immediate-runid`（AC-249）交付写工具与 `session_send`；`gap-ac245-mcp-read-tools-fixture-readings`（AC-245）交付只读工具与 `session_get`（已读宿主 `leases`，本任务复用同一 session-hosts 读缝）；`gap-ac244-mcp-audit-log-outcomes-and-retention`（AC-244）交付 `withMcpAudit` 与调用期 scope 门；`gap-ac241-mcp-token-auth-shares-service`（AC-241）交付 `McpPrincipal` 与令牌认证。WS 侧 `chat-stop-task.test.ts`（AC-233）覆盖的是 **`chat.stop-task` 处理器**用 task table 判 `unknown-task` 的既有行为，本任务覆盖的是 **MCP 工具 `session_background`** 从**宿主快照 lease** 判存在/列出/停止的对外行为与 scope 语义，判据文件不同、机制不同（快照 vs 任务表），不改 WS 路径。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-271/AC-272 未落地则无 `mcp-gateway.resident-tools.ts` 注册缝与阶段 6 集合；AC-249 未落地则无写工具注册先例与单例控制服务接线；AC-245 未落地则无只读工具缝与 session-hosts 读缝；AC-244 未落地则无审计包装与调用期 scope 门；AC-241 未落地则无 `McpPrincipal` 与 `scopes`。AC-275（真实 claude 二进制）不列为硬前置：本判据用脚本化 query 的常驻驱动，真实二进制的停止语义归 AC-275 直接覆盖；AC-277（人工关卡）不列为硬前置（它是 GOAL-022 的最终人工门）。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-273 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-background.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-session-background.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-background.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 经真实 HTTP + MCP `session_background({session})` 用只读令牌读出该会话的 `background-task` 与 `cron` lease，`tasks` 逐字含 `id`/`kind`/`recurring`（`bg-1`/`cron-1(recurring:true)`/`wake-1(recurring:false)`），`isError` 为假、`host` 非空；逐字写出返回。
- [x] AC4 (b) 只读令牌带 `stopTaskId` ⇒ `isError` 为真、（可读则）`code==='SCOPE_DENIED'`、控制服务 `stopTask` 计数为 **0**、lease 仍在；control 令牌同调 ⇒ `isError` 为假、`stopped===true`、计数为 **1**、脚本化 query 的 `stopTask` 收到 `'bg-1'`；逐字写出两侧返回与计数前后。
- [x] AC5 (c) 控制令牌停一个不存在的 id ⇒ `isError` 为真、`code==='TASK_NOT_FOUND'`、响应不含 `stopped:true`、控制计数**不变**、lease 集合不变；逐字写出返回与前后计数（可选：驱动回 `false` ⇒ 如实 `STOP_UNSUPPORTED`、不 `stopped:true`）。
- [x] AC6 (d) 成功停止（脚本化 query 已 `removeLease`）后经 MCP 再列 ⇒ `tasks` 含 `cron-1`/`wake-1`、**不含** `bg-1`；逐字写出停止前后两份 `tasks` 与两组 id。
- [x] AC7 (e) 冷会话（无宿主）经 MCP 列出 ⇒ `isError` 为假、`tasks` 为空、`host` 为 `null`（或明确「无宿主」字段）、`message` 逐字含「没有宿主」；正例对照 `S` 的 `host` 非空；逐字写出两侧。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 只读令牌也能停止 ⇒ AC4 红；(ii) 不存在的 id 回「已停止」⇒ AC5 红；(iii) 列表漏掉 cron ⇒ AC3 红。每条记录恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`mcp-cancel-queued.test.ts`、`mcp-session-reconfigure.test.ts`、`mcp-session-send.test.ts`、`mcp-read-tools.test.ts`、`chat-stop-task.test.ts`、`claude-resident-permissions.test.ts` 不改一字仍逐字通过；跨模块只经 barrel。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- `session_background` **真的**经真实 HTTP + MCP SDK 客户端驱动，落到**真** `createSessionHostManager` 的**真**宿主快照（真 lease）与**真** `createChatControlService` + **真**常驻 claude 驱动（脚本化 query）上——不是「函数被调用」或「判据文件存在」就算数。
- 列表**真的**取自宿主快照：`background-task` 与 `cron` 两类**真的**都列出，`id`/`kind`/`recurring` **真的**逐字来自 lease；漏掉 `cron` 会让 (a) 真红。
- 停止**真的**经控制服务的 `stopTask`：control 令牌调用时计数**真的** +1、驱动 `stopTask` **真的**收到那个 `taskId`；只读令牌**真的**在控制服务之前被拒、计数**真的**为 0。
- 不存在的 id **真的**明确未找到：`TASK_NOT_FOUND`、**不**含 `stopped:true`、控制服务**一次都没被调**——不是把 `'requested'` 读成已停止。
- 停止后**真的**消失：脚本化驱动经 `removeLease` 移出后，第二次列表**真的**不再含该 id，且其它 lease **真的**仍在。
- 冷会话**真的**列出为空并**真的**说明没有宿主。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖；不改控制服务本体、驱动本体与 WS `chat.stop-task` 路径；不越界实现 AC-274–AC-277 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-session-background.ts (new)
- server/modules/mcp-gateway/mcp-gateway.resident-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-session-background.test.ts (new)（判据）
- server/shared/tests/claude-cli-path.test.ts（续做轮：隔离 ambient `CLAUDE_CLI_PATH` 以解除与本任务 delta 无关的 fan-in suite 阻断）
- tasks/gap-ac273-mcp-session-background.md

## Evidence

- 续做轮（2026-10-05）：实现与判据未变（分支既有 3 提交照旧）。上轮 fan-in suite 红于 `server/shared/tests/claude-cli-path.test.ts`，与本任务 delta 无关。
- 根因：该文件 4 个用例显式传 `undefined` 触发 `resolveClaudeCodeExecutablePath` 的默认参数 `configuredPath = process.env.CLAUDE_CLI_PATH`；本机 systemd user 环境导出 `CLAUDE_CLI_PATH=/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude`，于是断言读到该路径（`+ actual '/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude'` vs `- expected undefined` / `- expected 'claude'` / `- expected <win32 native exe>`）。
- 复现：ambient 环境下该文件 `tests 8 / pass 4 / fail 4` exit 1；`env -u CLAUDE_CLI_PATH` 下 `tests 8 / pass 8 / fail 0` exit 0。
- 修复：给该用例文件加文件级 `before`/`after` 钩子，在文件执行期删除并恢复 `process.env.CLAUDE_CLI_PATH`（node:test 逐文件独立进程，隔离不外泄）；不改任何断言、不改实现语义。与仓库既有隔离惯例一致（`model-config-write-path.test.ts` / `model-spawn-env.test.ts` 列举 `CLAUDE_CLI_PATH`）。
- 复跑（ambient 环境）：该文件 `tests 8 / pass 8 / fail 0` exit 0；`env -u CLAUDE_CLI_PATH` 下同 8/8。
- 判据与门：`mcp-session-background.test.ts` 6/6 exit 0；非回归集 `mcp-cancel-queued` 6/6、`mcp-session-reconfigure` 5/5、`mcp-session-send` 7/7、`mcp-read-tools` 6/6、`chat-stop-task` 6/6、`claude-resident-permissions` 1/1 全 exit 0；`npm run typecheck` exit 0；`npx oxlint server/shared/tests/claude-cli-path.test.ts` exit 0。
- 实际改动文件（`git diff --stat develop...HEAD`）：`server/index.ts`、`server/modules/mcp-gateway/index.ts`、`server/modules/mcp-gateway/mcp-gateway.resident-tools.ts`、`server/modules/mcp-gateway/mcp-gateway.transport.ts`、`server/modules/mcp-gateway/mcp-session-background.ts (new)`、`server/modules/mcp-gateway/tests/mcp-session-background.test.ts (new)`、`server/shared/tests/claude-cli-path.test.ts`。

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-272 同款说明）。
- 「不存在的 id」的来源是**宿主快照的 lease 列表**，不是另造任务表：WS 侧 `chat.stop-task` 用 task table 判 `unknown-task`（AC-233 的机制），MCP 侧 (a) 明确要求数据取自宿主快照，故本 AC 的成员预检读同一份 lease。两处不冲突（不同传输、不同数据源、不同判据）。
- 控制服务的 `stopTask` 只回 `'requested' | 'unsupported' | 'timeout' | 'error'`（+refusals），**没有** `'stopped'`；驱动对 SDK「默默接受未知 id」不回确认。因此 `stopped:true` 只在「预检确认 id 真在该会话的 lease 里」+「control 回 `requested`」时给出；未知 id 由快照预检拦在 control 之前——这正是 (c)「不虚报已停止」的落点。
- (d) 的「lease 消失」在真实链路里由 `task_notification(stopped)` 帧经驱动 `reconcileHeldWork` → `manager.removeLease` 完成，**不是** `stopTask` 调用本身；判据的脚本化 query 在 `stopTask` 到达时调同一条 `removeLease`，使该读数是真状态迁移。若改走「脚本化 query 发终结帧、驱动/reducer 投影」的路径也可，读数要求不变。
- SPEC §329 把本工具列为 `read` / `session:control` 双 scope：静态注册 `requiredScopes: ['cloudcli:read']`（让只读令牌能列出），停止分支的 `cloudcli:session:control` 自检由适配层拥有，且在**任何**控制服务调用之前。若落地缝支持按输入解析 scope，优先交还审计门，但 (b)(c) 的读数（只读被拒、control 计数 0、未找到不虚报）不变。
- `MCP_STAGE6_RESIDENT_TOOLS` 是阶段 6 工具名的唯一事实来源；AC-252 的自指保护从工具注册表取网关写工具名，SPEC 的自指清单不含 `session_background`（本任务不改该清单）。