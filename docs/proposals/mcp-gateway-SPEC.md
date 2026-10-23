# CloudCLI MCP SPEC —— 把 CloudCLI 的会话控制平面以远程 MCP 服务开放给外部 agent（Gemini / Claude Code / 任意 MCP 客户端）

状态：Draft v3 / 待评审
决策输入：人 yale 2026-10-04 ~ 10-05 的讨论；外部意见（ChatGPT 对 develop 分支的评审）经逐条核实后吸收（见「修订记录」）
关系：

- 建立在 `docs/proposals/claude-resident-sessions.md`（GOAL-013）、GOAL-012（会话宿主层）、`chatRunRegistry` 与 WebSocket chat gateway 之上。**MCP 是控制平面的第二个前端，与 WebSocket 同层**，不是调用 Claude Code CLI 的旁路。
- 新增后端模块 `server/modules/oauth/`、`server/modules/mcp-gateway/`；在 `server/modules/websocket/` 内抽出 `ChatControlService`。
- 退役 `server/modules/agent/`（`POST /api/agent`）与 `api_keys` 明文 key。
- 后端遵守 `.agents/skills/backend-module-standards`，前端设置页遵守 `.agents/skills/frontend-module-standards`。
- 对外部客户端（Gemini）行为的部分假设**尚未核实**，列在「未核实的前提」。

---

## 背景

### 使用模式（2026-10-04 取证）

数据来自 `server.log` 与 `~/.claude/projects/*` 近 14 天的会话记录。

- **人是监督者。** claudecodeui 约 91%、quay 约 86% 的会话由 quay worker / judge / 探针发起；人发出的多是短指令（「继续」「检查进展」「创建 task」「请检查 + 粘贴的 UI 状态」）。
- **多项目交错。** 同一天在 claudecodeui、quay、archguard、meta-cc 之间切换；「我现在在哪、谁卡住了」是最常见的问题。
- **单轮耗时长。** 从人发消息到最后一个助手事件：claudecodeui p50 68 s、p90 466 s；quay p50 120 s、p90 532 s。
- **审批几乎不出现。** 常驻进程以 `bypassPermissions` 运行；只有 `AskUserQuestion` 这类交互型工具偶尔需要人回答。
- **公网入口已有。** cloudflared 隧道（docker，token 方式）与 tailscaled 在运行；服务监听 `0.0.0.0:3001`。

由此得到三条设计约束：

1. 工具面以「看状态 + 发短指令 + 控制会话」为核心，不以「远程写代码」为核心。
2. 触发运行的工具默认**立即返回**，进度靠查询或有界等待；不能把一轮运行挂在一次工具调用上。
3. 输出适合手机屏幕：默认截断，长内容给游标。

### 为什么以 CloudCLI 为底座

同类项目（`claude-code-rc-mcp`：SSH + tmux 粘贴 + 读 JSONL；`claude-mcp-bridge`：每次 `claude -p --resume`；`claude-rc-api`：经 Anthropic 私有 Remote Control 中继）都在会话后端上比 CloudCLI 弱。CloudCLI 已有：

- **常驻会话**：一个 SDK query 跨轮存活，后续轮次写进一直打开的 stdin，pid 不变（`claude-host-driver.provider.ts` 文件头）。
- **忙时输入走 CLI 自己的队列**：`dispatchRun` 在注册表拒绝后询问 `runtime.acceptsBusyInput`，常驻会话以 `supersedeRunning` 开新运行，消息以 `priority: 'later'` 写入（`chat-websocket.service.ts:547-560`，`CLAUDE_QUEUED_INPUT_PRIORITY`）；尚未出队的消息可经 `cancel_async_message` 撤回（driver `:2648`）。
- **宿主层**：`SessionHostManager` 的快照含 `state`、`pid`、`leases`（`turn` / `cron` / `background-task` / `resident-policy`）、`peerName`、`closeReason`；状态由 lease 推导。
- **统一的运行注册表**：`chatRunRegistry` 给每次运行分配 `runId`、逐事件 `seq`、缓冲与重放，`source` 区分 `user` / `scheduled` / `unattended`。
- **多 provider**：Claude、Codex、Cursor、OpenCode 共用会话与运行抽象。

这些借鉴项目只取其外壳：`claude-code-rc-mcp` 的 Streamable HTTP + OAuth 2.1 打包方式，`multiagents` / `claude-rc-api` 的控制词汇，`claude-mcp-bridge` 的简洁返回体。**会话执行与控制全部继续用 CloudCLI 自己的 `SessionHostManager` + 常驻宿主驱动 + `chatRunRegistry`，绝不另起第二套 Claude CLI。**

---

## 已确认的决策

| # | 决策 | 含义 |
|---|---|---|
| D1 | **必须使用 access token** | `/mcp` 只接受带 scope、带过期的 Bearer 令牌 |
| D2 | **退役 `POST /api/agent`** | 删除 `server/modules/agent/` 与挂载点；`/api/agent` 路径释放，留待将来复用 |
| D3 | **重构 API Key 机制** | 明文 `api_keys` 整体替换为哈希存储、带 scope 与过期的令牌表 |
| D4 | **个人访问令牌（PAT）可访问 `/mcp`** | PAT 是 access token 的一种：带 scope、最长 90 天、哈希存储；供 Claude Code、MCP Inspector、curl 使用。Gemini 等走 OAuth |
| D5 | **MCP 是控制平面的第二个前端** | 发送、中止、撤回等应用逻辑从 WebSocket 处理器中抽出为与传输无关的 `ChatControlService`；WebSocket 与 MCP 都只是适配层 |
| D6 | **产品名 CloudCLI MCP，provider 中立** | 工具只讲 session / run / message / state，不暴露 Claude 专有概念；Codex 等接入后工具不变 |
| D7 | **开发期用本地 Claude Code 代替 Gemini 验证** | 在 OAuth 完成前不对公网暴露；本机 Claude Code 以 PAT 连接 `http://localhost:<port>/mcp` 作为第一个客户端（嵌套结构，见专节） |
| D8 | **阶段顺序** | 清理 → 抽 `ChatControlService` 与会话宿主启停 service → 运行按 id 寻址 → 只读 MCP → 写工具 → OAuth 后上公网 → 常驻专有能力与审批 |
| D9 | **`ChatRunSource` 新增 `'mcp'`** | 经 MCP 发起的运行没有 WebSocket 连接，按现有默认会被记成 `scheduled`；新增取值使 UI、日志与审计能区分来源 |
| D10 | **嵌套冒烟与生产分离** | 真实模型的人工冒烟在独立实例（独立端口与 `DATABASE_PATH`、临时项目）上做；生产 3001 启用 MCP 是人在会话外执行的单独步骤，不属于判据 |

---

## 现状（已读代码核实）

### 现有 API Key 机制

| 项 | 现状 | 位置 |
|---|---|---|
| 存储 | 表 `api_keys(id, user_id, key_name, api_key UNIQUE, created_at, last_used, is_active)`，**明文** | `server/modules/database/schema.ts:16`，`repositories/api-keys.ts` |
| 格式 | `ck_` + 32 字节随机 hex | `api-keys.ts:39` |
| 管理接口 | `GET/POST /api/settings/api-keys`、`DELETE /api-keys/:keyId`、`PATCH /api-keys/:keyId/toggle`（列表只返回前 10 字符） | `settings.routes.ts:25-28`，`settings.service.ts:57` |
| 前端 | 设置 → API 页 `ApiKeysSection`，链接到 `public/api-docs.html` | `src/modules/settings/tabs/api-settings/*` |
| 唯一消费者 | `POST /api/agent`，经 `x-api-key` 头或 `?apiKey=` | `agent.routes.ts:61-91` |
| 现有数据 | 本机库 0 个 key、1 个用户 | `~/.cloudcli/auth.db`（只读查询） |

另有一个**同名但无关**的机制：`server/index.ts:220` 对整个 `/api` 挂了 `validateApiKey`，比较环境变量 `API_KEY` 与 `x-api-key` 头；未设置时放行，本机未设置。`/mcp`、`/oauth/*`、`/.well-known/*` 不在 `/api` 下，本 SPEC 不改它。

### `/api/agent`

- 调用与 UI 相同的 Claude 运行时（`queryClaudeSDK`），会话写入同一个 `~/.claude/projects/*`，会被 `sessions-watcher` 同步进列表（推断，未实测）。
- 但它绕过 `chatRunRegistry`：`/sessions/running` 看不到它，UI 不能实时订阅、中止或回答审批，与 UI 在同一会话的运行会并发冲突。强制 `bypassPermissions`。
- 引用方：`server/index.ts:113,326`、`server/modules/agent/**`（含测试）、`public/api-docs.html`、`ApiKeysSection.tsx:49`。`git.routes.ts` 自己调用 `queryClaudeSDK`，`githubTokensDb` 另有 `project-clone.service.ts` 使用，二者都不受退役影响。

### 控制平面的现状与缺口

| 能力 | 现状 | 缺口 |
|---|---|---|
| 发送 | `chat.send` → `handleChatSend` → `resolveSendTarget(ws, …)` → `dispatchRun(ws, …)`（`chat-websocket.service.ts:465-560`） | `resolveSendTarget` 以 `sendProtocolError(ws, …)` 报错，无法被非 WebSocket 调用方复用 |
| 无 socket 发送 | `runDetachedChatTurn`（`:1393`），被 scheduled-messages 使用 | **在进入 `dispatchRun` 前自行拒绝忙会话**（`:1420`），绕过了 `acceptsBusyInput` → 常驻会话的忙时排队对它不可用；且在运行**结束后**才 resolve |
| 中止 | `chat.abort` → `handleChatAbort`（`:766`）：`runtime.abort` + `completeRun({aborted:true})` | 逻辑在 WS 处理器内 |
| 撤回排队 | `chat.cancel-queued` → `handleChatCancelQueued`（`:818`）→ `runtime.cancelQueuedInput` | 同上；被排队消息的 uuid 由服务端生成（driver `:3101`、`:3187`）并经事件送达前端（`ChatInterface.tsx:495`），非 WS 调用方目前拿不到 |
| stop-task / background-task | `:960`、`:1164` | 同上 |
| 审批 | `chat.permission-response` → `runtime.resolveToolApproval`；待审批经 `runtime.getPendingApprovalsForSession` | 同上 |
| 运行寻址 | `chatRunRegistry` 是 `Map<appSessionId, ChatRun>`（`chat-run-registry.service.ts:74`），`runId` 已存在（`:237`） | 被 supersede 或完成的运行**不能按 `runId` 查到**；完成后只保留 5 分钟 |
| 宿主控制 | `POST /api/session-hosts/:sessionId/start`、`/close`（`session-hosts.routes.ts:404,538`），`GET /api/session-hosts` 快照 | 无（服务可直接复用） |
| 访问检查 | `assertSessionAccess(userId, session)`：会话行无 owner 列，只校验「已认证」 | 无（沿用） |
| 宿主启停 | 启动 / 关闭逻辑**内联在** `session-hosts.routes.ts:404-540` 的处理器里（读会话、解析宿主驱动、`startResidentSession`、`bindSession`、`closeHost(…, 'user')`），不是 service | 需抽成 service，路由与 MCP 共用 |
| 运行来源 | `ChatRunSource = 'user' \| 'scheduled' \| 'unattended'`（`shared/types.ts:2272`）；`startRun` 无连接时默认记 `scheduled`（`chat-run-registry.service.ts:240`） | MCP 发起的运行没有连接，会被错记为 `scheduled` |
| 装配 | `server/index.ts` 把依赖分别交给 `createWebSocketServer`（`:121`）与 scheduled-messages（`:593`，只传 `providerRuntimeService`） | 没有共享的控制服务实例 |
| 跨模块导出 | 边界 lint 对跨模块深导入报 `error`（`.oxlintrc.json`）；`getProjectSessionsPage` 未从 projects barrel 导出；auth barrel 没有登录校验导出 | 需补 barrel 导出 |

### 依赖

- `@modelcontextprotocol/sdk` 1.29.0 已在 `node_modules`，但只是传递 peer 依赖；`zod` 4.3.6 同样未声明。SDK 自带 `StreamableHTTPServerTransport`（无状态模式）、`mcpAuthRouter`、`OAuthServerProvider` / `OAuthRegisteredClientsStore` 接口、`requireBearerAuth`，token 端点内置 `express-rate-limit`。SDK 自身声明依赖 express 5，用的是它自己 `node_modules` 里嵌套的 5.2.1；项目顶层是 express 4.21。已实测（临时探测，未入库）：`mcpAuthRouter` 与无状态 `StreamableHTTPServerTransport` 挂在 express 4.21 应用上工作正常（元数据端点 200，`tools/list` 200）。该探测在阶段 3 固化为守卫测试，防止 SDK 升级后漂移。
- `server/index.ts` 未设置 `trust proxy`；`public/sw.js` 对导航请求一律走网络，不会吞掉 `/oauth/authorize`。

---

## 目标

1. 外部 MCP 客户端（开发期为本机 Claude Code，之后为 Gemini Web / Android 或其他）能列出项目与会话、读取进展、给会话发消息、新建 / 启动 / 关闭会话、中止运行、撤回排队消息。
2. 经 MCP 发起的运行与 UI 发起的运行**是同一种运行**：同一个 `ChatControlService` 入口、同一个注册表，UI 实时可见、可订阅、可中止；常驻会话的忙时排队语义与 UI 完全一致。
3. 常驻会话的宿主状态（state、pid、leases、peerName）作为一等信息对外可读。
4. 所有凭证哈希存储、带 scope、带过期、可吊销，并有审计记录；OAuth 完成前不对公网暴露。
5. `/api/agent` 与明文 `api_keys` 退役。

## 非目标

- 不做多用户 / 多租户隔离（会话行无 owner 列，沿用「已认证即可访问」）。所有令牌仍映射到具体 CloudCLI 用户，`userId` 一路传入 `ChatControlService`，不传 `null`。
- 不做远程写文件、git commit/push、任意 shell。
- 不改 WebSocket 协议，不改 `chat.subscribe` 的帧序列（受逐运行帧一致性判据保护）。
- 不重构 `chatRunRegistry` 的「每会话一个当前运行」模型，只加按 id 的索引。
- 不改全局 `API_KEY` 中间件。
- `IS_PLATFORM` 模式下拒绝启用 MCP（该模式绕过认证）。
- 不做 Gemini Enterprise 路径；不做 agent-team 编排（`session_send_peer` 等）。

---

## 总体架构

```
              ┌─ Web / PWA ──────── WebSocket 适配层（chat-websocket.service）─┐
              │                                                               │
外部客户端 ───┼─ 本机 Claude Code ┐                                            ▼
              │                    ├─ MCP 适配层（mcp-gateway）──→  ChatControlService
              └─ Gemini / 其他 ────┘      ▲                              │
                                          │                  ┌──────────┼───────────────┐
                              oauth 模块（令牌校验）          ▼          ▼               ▼
                                                     chatRunRegistry  ProviderRuntime  SessionHostManager
                                                                         Service        （常驻 / per-run）
                                              scheduled-messages ──→ ChatControlService
```

所有入口都在 3001 同一进程内：

```
├─ /.well-known/oauth-authorization-server          ┐
├─ /.well-known/oauth-protected-resource/mcp        │ oauth 模块
├─ /oauth/register | authorize | token | revoke     ┘
├─ /mcp   requireBearerAuth → mcp-gateway（无状态 Streamable HTTP）
├─ /api/settings/access-tokens | oauth-grants | oauth-clients   （JWT，设置页用）
└─ /api/*、/ws  （不变）
```

- **挂载顺序**：`/mcp`、`/oauth/*`、`/.well-known/*` 必须挂在 `createStaticAssetsMiddleware`（`server/index.ts:445`）**之前**。静态路由的 `get('*')` 会对任何未挂载路径返回 SPA 的 200，挂载位置错了，OAuth 元数据会悄悄返回 HTML 且状态码为 200；判据必须断言元数据端点的 content-type 是 JSON，而不是只看状态码。`express.json` / `urlencoded` 的全局解析器对 `/mcp` 与 `/oauth/token`（表单编码）都适用，无需另挂。
- **无状态 Streamable HTTP**：每个请求独立，不依赖内存中的 `Mcp-Session-Id`；服务重启或隧道重连后无需重新握手。
- **模块名用 `mcp-gateway` 而非 `mcp`**：providers 模块已有 `providerMcpService`、`/api/providers/mcp`，含义是「给 provider 配置 MCP 服务器」，同名会混淆。

---

## ChatControlService（阶段 1）

### 位置与边界

- 先放在 websocket 模块内部：`server/modules/websocket/services/chat-control.service.ts`，经 `server/modules/websocket/index.ts` 导出。`chat-websocket.service.ts` 有 1508 行且周围有大量冻结判据，先在模块内抽取以缩小影响面；是否拆成独立 `chat` 模块留待后续。
- 与传输无关：不接受 `WebSocket`，不发协议帧；失败以带稳定错误码的结果返回，由各适配层翻译（WS 翻成 `protocol_error` 帧，MCP 翻成 `isError` 工具结果）。

### 契约

```ts
type ControlCaller = { userId: string | number; via: 'websocket' | 'mcp' | 'scheduled' };

type SendResult =
  | { ok: true; runId: string; queued: boolean; queuedMessageUuid: string | null }
  | { ok: false; code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'RUN_IN_PROGRESS' | 'FORBIDDEN'; message: string };

createChatControlService(deps) => {
  // 与 chat.send 同一条路径：resolveSendTarget → dispatchRun（含 acceptsBusyInput 重试）。
  // 在运行登记后立即 resolve，不等运行结束；运行的结束由注册表承载。
  send(caller, { sessionId, content, options, interruptActiveRun? }): Promise<SendResult>;
  editSend(caller, { sessionId, content, options, editFromMessageId }): Promise<SendResult>;
  abort(caller, { sessionId }): Promise<{ ok: boolean; aborted: boolean; code? }>;
  cancelQueued(caller, { sessionId, messageUuid }): Promise<HostQueuedInputCancelResult | 'forbidden'>;
  stopTask(caller, { sessionId, taskId }): Promise<…>;
  backgroundTask(caller, { sessionId, … }): Promise<…>;
  answerApproval(caller, { requestId, allow, updatedInput?, message?, rememberEntry? }): void;
  pendingApprovals(caller, { sessionId }): unknown[];
}
```

要点：

1. `send` 在 `chatRunRegistry.startRun` 成功后立即返回 `runId`（利用 `dispatchRun` 已有的 `beforeRun(run)` 钩子），运行本身在后台继续，其异常写日志。不依赖「调用后同步读 `getRun`」这种隐式时序。
2. 常驻会话忙时：`queued: true`，`queuedMessageUuid` 为驱动给这条消息分配的 uuid，用于 `cancelQueued`。实现需要驱动把 uuid 交给调用方（目前只经事件流送达前端）。
3. 所有控制动作先过 `assertSessionAccess`（同一个入口，沿用 AC-196/197/198 的「共用一个访问入口」约束）。
4. `scheduled-messages` 改为调用 `send(…, { interruptActiveRun: true })`，`runDetachedChatTurn` 变为 `send` 的薄包装或删除。scheduled-messages 自身的「定时器优先打断」语义保持。

### 装配

- `server/index.ts` 是唯一的装配点：在创建 WebSocket 服务器之前构造**一个** `ChatControlService` 实例（注入 `providerRuntimeService`、`sessionHostManager`、`activityStore` 与访问检查入口），再把**同一个实例**交给 `createWebSocketServer`（`:121`）、`initializeScheduledMessageDispatcher`（`:593`，现在只传 `providerRuntimeService`，改为传实例）与 `createMcpGatewayModule`。
- 网关与 oauth 模块不得自行构造控制服务：两份实例各持一份依赖，「同一个入口」的承诺就落空。
- 判据：注入计数间谍（沿用 AC-198 的形态），断言 WS 的 `chat.send`、scheduled-messages 的发送与 MCP 的 `session_send` 触达的是同一个 `send`。

### 运行来源（D9）

- `ChatRunSource` 增加 `'mcp'`（`server/shared/types.ts`）。`ControlCaller.via` 到来源的映射：`websocket` → `'user'`，`scheduled` → `'scheduled'`，`mcp` → `'mcp'`。`startRun` 不再以「有无连接」推断来源，而由调用方显式传入；未传时保持旧默认，已有调用不受影响。
- 其他消费者：我用 grep 在 `server/`、`src/` 里没找到除注册表默认值之外读取 `source` 的代码；实施时必须再次全库核对，并给穷举 `ChatRunSource` 的测试夹具补上新值。
- `closeHost(…, 'user')` 的关闭原因词汇不动：MCP 发起的关闭沿用 `'user'`，来源区分靠审计日志。

### 会话宿主启停 service

- 现状：启动 / 关闭逻辑在 `session-hosts.routes.ts:404-540` 的路由处理器里，`session_start` / `session_close` 不能直接复用。
- 抽成 session-hosts 模块内的 `startResidentHost(sessionId, deps)` / `closeResidentHost(sessionId, deps)`，经 barrel 导出；路由只解析参数并翻译结果，**既有拒绝码与文案逐字不变**（`SESSION_NOT_FOUND` 404、`LIFECYCLE_MODE_NOT_RESIDENT` 409 等）。
- 验收：现有 session-hosts 判据与路由测试全部保持通过；新增单测覆盖非常驻会话被拒、provider 无宿主驱动、已在运行时幂等返回同一 pid、关闭时 lease 信息可读。

### 本 SPEC 新增的跨模块导出

边界 lint 对深导入报 `error`，所有跨模块符号必须经 barrel，并按模块规范在定义处注释消费方。**每个导出随它的第一个消费者一起加**（后端模块规范：不导出没有跨文件消费者的符号）：阶段 1 只导出 `createChatControlService`（消费者 `server/index.ts`）；`getRunById`、宿主启停服务、`getProjectSessionsPage` 随 mcp-gateway（阶段 3）导出；登录校验窄口随 oauth 授权页（阶段 5）导出。下表是最终清单，不是阶段 1 的一次性交付。

| 模块 | 新增导出 | 消费方 |
|---|---|---|
| websocket | `createChatControlService`、`getRunById`、运行摘要类型 | `server/index.ts`、mcp-gateway |
| projects | `getProjectSessionsPage` | mcp-gateway |
| session-hosts | `startResidentHost`、`closeResidentHost` | session-hosts 路由、mcp-gateway |
| auth | 登录校验的窄口（包住 `authService.login`） | oauth 授权页 |
| database | 新仓储（`access_tokens` 等）；删除 `apiKeysDb` | oauth |

Touches 纪律：给被整体 `vi.mock` 的模块加导出，会让兄弟测试变红，每个任务的 Touches 要把这些测试的 mock 补全列进去；边界 lint 会拦新增测试文件，同样要在 Touches 里声明。

### 验收（阶段 1）

- 现有 WebSocket 判据与测试**全部保持通过**，`chat.subscribe` 帧序列不变，Web UI 行为零变化。
- 新增单测：`send` 在运行结束前返回且 `runId` 与 `chatRunRegistry.getRun(sessionId).runId` 一致；常驻会话忙时 `queued: true` 且 `queuedMessageUuid` 非空，用它调用 `cancelQueued` 得到 `cancelled`；per-run 会话忙时返回 `RUN_IN_PROGRESS`；无认证调用方得到 `FORBIDDEN` 且未触达驱动。
- 静态读数：`chat-websocket.service.ts` 的 `chat.send` / `chat.abort` / `chat.cancel-queued` 处理器只做解析 → 调用 `ChatControlService` → 翻译结果，不再直接调用 `dispatchRun` / `runtime.abort` / `runtime.cancelQueuedInput`。
- 单实例装配：三个调用方触达同一个 `send`（见「装配」）。
- 来源：经 `ChatControlService` 以 `via: 'mcp'` 发起的运行，注册表里 `source === 'mcp'`；`via: 'scheduled'` 为 `'scheduled'`；WS 为 `'user'`。含正例对照，防止「恒为默认值」也通过。
- 宿主启停 service 的验收见上一小节。

---

## 运行按 id 寻址（阶段 2）

- 在 `chatRunRegistry` 增加 `runsById: Map<runId, ChatRun>` 索引与 `getRunById(runId)`。被 supersede 的运行与已完成运行仍可按 id 查到，保留期与现有 `COMPLETED_RUN_RETENTION_MS` 一致（5 分钟），可配置。
- 新增运行摘要（只读、与传输无关）：`{ runId, sessionId, source, status: 'running' | 'completed' | 'aborted', startedAt, completedAt, lastSeq, phase, toolName }`，`phase` / `toolName` 来自 `activityStore`。
- 运行超出保留期或服务重启后（`bootId` 变化），按 id 查询返回 `{ status: 'unknown', reason: 'expired' | 'restarted' }`，由调用方回退到读 transcript。
- `chat.subscribe` 的重放逻辑不改；「每会话一个当前运行」不改。

验收：supersede 之后旧运行与新运行都能按 id 查到且状态各自正确；保留期过后返回 `expired`；WebSocket 帧序列判据保持通过。

---

## MCP 工具（`server/modules/mcp-gateway/`）

### 通用约定

- 每个工具返回 `content`（适合手机阅读的纯文本）与 `structuredContent`（同一信息的 JSON，带 `outputSchema`）。
- 文本默认上限 4000 字符；超出截断并给出 `cursor`。所有 id 原样返回。
- **目标解析**：项目接受 `projectId` 或名称子串，会话接受 `sessionId` 或标题子串；唯一命中才接受，多个命中列出候选并报错。口述 id 不现实，这一条是手机可用性的关键。
- 时间同时返回相对时间与 ISO 时间戳。
- 写工具结果附带「在 CloudCLI 中打开」链接（以前端实际路由为准）。
- **读操作做成 Tools**。Gemini 帮助页未提 MCP Resources，许多客户端只用 Tools；Resources（`cloudcli://sessions/{id}` 等）作为后期可选镜像。
- 每个工具注册时声明所需 scope；网关在调用前检查，不满足返回 `isError` 并写 `denied` 审计。
- 工具描述中写明：写操作前先向用户确认目标会话与内容（Gemini 本身也会对写操作要求人工确认）。

### 工具清单

| 工具 | Scope | 输入 | 输出 / 行为 | 背后的服务 | 阶段 |
|---|---|---|---|---|---|
| `overview` | `read` | `{}` | 运行中会话（项目、标题、阶段、时长）；`awaitingPermission` 的会话；保留期内（默认 5 分钟）被中止的运行（注册表只保留完成的运行 5 分钟，摘要里没有退出码，只有 `aborted`）；常驻宿主一览（state、leases）；有 quay 的项目的任务计数、driver 与 suite 状态（**只读 `getQuaySnapshot` 的缓存，不传 `refresh`；缓存未命中的项目标记为「未知」，不触发 quay CLI**，避免对 N 个项目冷启动扇出） | `chatRunRegistry`、`activityStore`、`SessionHostManager` 快照、`quayService.getQuaySnapshot` | 3 |
| `projects_list` | `read` | `{ includeArchived? }` | 项目名、id、路径、会话数、最近活动 | `getProjectsWithSessions` | 3 |
| `sessions_list` | `read` | `{ project?, provider?, state?: 'running' \| 'idle' \| 'resident' \| 'any', limit? = 10, cursor? }` | 标题、id、provider、生命周期模式、宿主 state、是否运行中、最近活动 | `getProjectSessionsPage` / `listRecentSessions` + 宿主快照 | 3 |
| `session_get` | `read` | `{ session }` | 会话元数据 + `host`（state、pid、startedAt、idleFor、peerName、leases）+ 当前运行摘要 + 待审批数 | 宿主快照、运行摘要 | 3 |
| `session_read` | `read` | `{ session, mode?: 'latest' \| 'outline' \| 'around', around?, afterSeq?, limit? = 5, cursor? }` | `latest`：最后 N 条消息（工具调用折叠为一行）；`outline`：所有用户轮次；`around`：以某条消息为中心的窗口；`afterSeq`：当前运行自该 seq 以来的事件摘要 | `fetchHistory`、`fetchOutline`、`fetchWindowAround`、`replayEvents` | 3 |
| `run_get` | `read` | `{ runId, waitSeconds? = 0 }`（上限 25） | 运行摘要；`waitSeconds > 0` 时有界等待，运行结束、进入 `awaitingPermission` 或超时即返回；运行结束时附最后一条助手消息 | 运行摘要 + `fetchHistory` | 3 |
| `quay_snapshot` | `read` | `{ project, refresh? }`（一次一个项目） | 任务计数、最近任务、goal / ADR 计数、driver、suite、fan-in | `quayService.getQuaySnapshot` | 3 |
| `session_send` | `session:send` | `{ session, message, waitSeconds? = 0 }`（上限 25） | `ChatControlService.send` → `{ runId, queued, queuedMessageUuid }`；`waitSeconds > 0` 时等同随后调用一次 `run_get(runId, waitSeconds)` | `ChatControlService` | 4 |
| `session_create` | `session:create` | `{ project, message?, provider? = 'claude', model?, lifecycleMode? }` | `createAppSession`，有 `message` 则随即 `send`；返回 `{ sessionId, runId? }` | `sessionsService`、`ChatControlService` | 4 |
| `session_interrupt` | `session:control` | `{ session }` | `ChatControlService.abort`；常驻会话进程保留 | `ChatControlService` | 4 |
| `session_start` | `session:control` | `{ session }` | 启动常驻宿主 | 会话宿主启停 service | 4 |
| `session_close` | `session:control` | `{ session }` | 关闭宿主；有 `cron` / `background-task` lease 时在结果里点名，要求 `force: true` 才关闭 | 会话宿主启停 service | 4 |
| `session_cancel_queued` | `session:control` | `{ session, messageUuid }` | `ChatControlService.cancelQueued` | `ChatControlService` | 6 |
| `session_reconfigure` | `session:control` | `{ session, model?, effort?, permissionMode? }` | 下一轮生效；常驻会话走驱动的 `setModel` / `setPermissionMode` | providers 现有接口 | 6 |
| `session_background` | `read` / `session:control` | `{ session, stopTaskId? }` | 列出 background tasks 与 crons；带 `stopTaskId` 时停止（需 `session:control`） | `ChatControlService.stopTask` + 宿主 leases | 6 |
| `approvals_list` | `read` | `{ session? }` | 待审批：`requestId`、会话、工具名、输入摘要、已等待时长；`AskUserQuestion` 展开问题与选项 | `ChatControlService.pendingApprovals` | 6 |
| `approval_answer` | `approve` | `{ requestId, allow, answers?, message? }` | `ChatControlService.answerApproval` | `ChatControlService` | 6 |

`waitSeconds` 的上限 25 秒是对客户端工具调用超时的保守猜测（见「未核实的前提」），实测后调整。多会话并行的推荐用法是先对多个会话 `session_send`（`waitSeconds = 0`），再逐个 `run_get`，而不是串行等待。

### 自指保护（嵌套结构必需）

当 MCP 客户端本身就是一个 CloudCLI 会话时（例如在 CloudCLI 里开的 Claude Code 会话调用 CloudCLI MCP），它可能对**自己**调用 `session_send` / `session_interrupt` / `session_close`：中止或关闭自己会杀掉正在等待工具结果的那一轮，给自己发消息会在常驻队列里排到自己之后。

保护规则（不需要给子进程注入新环境变量；`AC-001` 要求 `resolveLaunchSpec` 产出的 env 逐字不变，注入会触碰它）：

- `turn.toolName` 是 `tool_use` 块的原始名字，形如 `mcp__<server>__<tool>`，其中 `<server>` 是用户在 `.mcp.json` 里随意起的别名，所以**不能按服务器前缀判断**。规则改为：目标会话当前运行的 `phase == 'tool'` 且 `toolName` 匹配 `^mcp__.+__(<网关写工具名>)$`（网关写工具名取自工具注册表，不手写第二份），则对它的 `session_send` / `session_interrupt` / `session_close` / `session_cancel_queued` 一律拒绝，错误码 `SELF_TARGET`，文本说明原因。
- 这是启发式：别的 MCP 服务器恰好有同名工具时也会被拦，错在安全一侧。`turn.toolName` 目前只有 Claude 的阶段推导器提供（`claude-turn-phase.service.ts`），其他 provider 的会话不会触发该保护；本 SPEC 的嵌套结构只涉及 Claude，不作更多承诺。
- 该规则同时挡住「两个会话在同一时刻互相调用」的情形，这种情形同样会互相卡死，拒绝是正确的。
- 读工具不受限制。

---

## 认证与令牌（`server/modules/oauth/`）

### 令牌种类

| 种类 | 前缀 | 有效期 | 获取方式 | 用途 |
|---|---|---|---|---|
| PAT | `ccp_` | 创建时选择 7 / 30 / 90 天，默认 30 天，**不允许永久** | 设置页 | 本机 Claude Code、MCP Inspector、curl |
| OAuth access token | `cca_` | 1 小时 | `/oauth/token` | Gemini 等 OAuth 客户端 |
| OAuth refresh token | `ccr_` | 30 天；每次使用即轮换 | `/oauth/token` | 换新 access token |
| 授权码 | — | 60 秒，一次性 | `/oauth/authorize` | 换令牌，强制 PKCE S256 |

所有令牌：32 字节随机数；库里只存 `SHA-256(token)` 与前缀；明文只在签发时出现一次。

### 令牌自检接口（阶段 0 已落地）

`GET /api/oauth/token-info`：令牌客户端在依赖令牌之前的自检。以 `Authorization: Bearer ccp_…` 呈递令牌本身，有效返回 200 与 `{ userId, scopes, expiresAt }`；缺头、换了认证方案、未知、已吊销、已过期、前缀错误一律返回同一个 401 体，不成为判断拒绝原因的预言机。每次请求都经令牌服务查库，吊销即时生效。它挂在自己的 router 上，只处理这一条路径，不使其他 `/api` 路由多出令牌认证入口（`server/index.ts`）。

这是 GOAL-018 的 AC-228 为验证「吊销后令牌被拒」而落下的计划外接口（当时还没有任何接口接受 PAT）；人 yale 2026-10-05 裁定保留。`/mcp` 的令牌校验与它共用同一个令牌服务，不复制校验逻辑。

### Scope

| Scope | 允许 | 授权页默认 |
|---|---|---|
| `cloudcli:read` | 所有只读工具 | 勾选（必选） |
| `cloudcli:session:send` | `session_send` | 不勾选 |
| `cloudcli:session:create` | `session_create` | 不勾选 |
| `cloudcli:session:control` | `session_interrupt` / `start` / `close` / `cancel_queued` / `reconfigure`、停止后台任务 | 不勾选 |
| `cloudcli:approve` | `approval_answer` | 不勾选 |
| `cloudcli:admin` | 预留（本 SPEC 无工具使用） | 不提供 |

令牌 scope 不能超出 grant scope；refresh 时只能缩小。

**签发时只接受上表的词汇**，`cloudcli:admin` 预留、不可签发。阶段 0 的实现把任意非空字符串当 scope 接受（`settings.service.ts` 的签发路径没有词汇校验），拼错的 scope 会签出一个什么都做不了、或将来恰好撞上新 scope 的令牌；阶段 3 收紧，由 GOAL-020 的 AC 覆盖。

### 数据表（新增，替换 `api_keys`）

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,              -- 公共客户端（PKCE only）为 NULL
  client_name TEXT,
  redirect_uris TEXT NOT NULL,          -- JSON 数组，精确匹配
  metadata TEXT NOT NULL,               -- RFC 7591 原始元数据（JSON）
  created_via TEXT NOT NULL,            -- 'dcr' | 'manual'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  disabled_at DATETIME
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,               -- RFC 8707 受众 = PUBLIC_BASE_URL + '/mcp'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  revoked_at DATETIME
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- 'pat' | 'oauth_access' | 'oauth_refresh'
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  name TEXT,
  grant_id INTEGER REFERENCES oauth_grants(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  revoked_at DATETIME
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at DATETIME DEFAULT CURRENT_TIMESTAMP,
  token_id INTEGER,
  client_id TEXT,
  tool TEXT NOT NULL,
  args_digest TEXT,                     -- id 原样；自由文本只记长度与前 40 字符
  outcome TEXT NOT NULL,                -- 'ok' | 'denied' | 'error'
  duration_ms INTEGER
);
```

迁移按 `migrations.ts` 现有的 `db.exec(<TABLE>_SCHEMA_SQL)` 惯例建表；**删除** `api_keys` 表与 `idx_api_keys_*` 三个索引，日志打印删除的 key 数量。不把旧 key 转成 PAT：它们唯一的消费者已退役，转换会凭空授予 MCP 权限。阶段 0 只建 `access_tokens`（PAT 所需），OAuth 相关表在阶段 5 建。

### OAuth 流程（阶段 5）

1. 客户端读取 `/.well-known/oauth-protected-resource/mcp` 与 `/.well-known/oauth-authorization-server`。
2. 支持 DCR 则调用 `/oauth/register`；否则使用设置页手工创建的 client_id / secret（Gemini：「Advanced features → Show more」）。**阶段 5 先只做手工客户端**，DCR 随后补上。
3. 浏览器跳转 `/oauth/authorize`，强制 PKCE S256。
4. 授权页（服务端渲染，不经 SPA）显示客户端名称、回调主机、请求的 scope；用户输入 CloudCLI 用户名和密码并逐项勾选 scope。密码由 `authService.login` 校验（应用的 JWT 在 localStorage，服务端渲染页拿不到，必须重新输入）。
5. 写 `oauth_grants` → 签发授权码 → 302 回 `redirect_uri` → 客户端换取 access + refresh token。

`OAuthServerProvider` 与 `OAuthRegisteredClientsStore` 由本模块实现。

### 加固

- **默认关闭**：`MCP_ENABLED=true` 才挂载 `/mcp`；`MCP_OAUTH_ENABLED=true` 且 `PUBLIC_BASE_URL` 为 `https://` 才挂载 `/oauth/*` 与 `/.well-known/*`。阶段 3–4 只开前者，`/mcp` 只接受 PAT。
- **开发期只听本机**：`MCP_OAUTH_ENABLED` 未开启时，`/mcp` 拒绝来自非回环地址的请求（以 socket 远端地址判断，不信任转发头），**并且只要出现任一转发头（`X-Forwarded-For`、`Forwarded`、`CF-Connecting-IP`、`X-Real-IP`）就拒绝**：本机反代或 tailscale serve 经回环转进来时 socket 仍是回环，只有转发头能区分；防止经 cloudflared 或本机反代意外暴露。
- **DCR 限制**：`MCP_DCR=off|allowlist|open`，默认 `off`；`allowlist` 下回调主机须在 `MCP_ALLOWED_REDIRECT_HOSTS` 中。
- **受众绑定**：OAuth 令牌带 `resource`，`/mcp` 只接受匹配的令牌；客户端未发送 `resource` 时以默认受众签发。
- **限速**：授权页密码提交每来源每 15 分钟 10 次；token 端点沿用 SDK 内置限速。
- **真实来源**：cloudflared 从 docker 网桥连入，`req.ip` 恒为网桥地址；新增 `TRUST_PROXY`（交给 `app.set('trust proxy', …)`），限速键优先用 `CF-Connecting-IP`。
- **吊销即时生效**：每次请求查库，不缓存；吊销 grant 级联使其令牌失效。
- **审计**：每次工具调用写 `mcp_audit_log`，保留 90 天。
- **Cloudflare Access（可选，不在本 SPEC 实现）**：若 UI 主机在 Access 之后，需对 `/mcp`、`/oauth/*`、`/.well-known/*` 配 bypass。

---

## 开发期验证：本机 Claude Code 作为第一个客户端（嵌套结构）

阶段 3–4 的验证客户端是本机 Claude Code，不是 Gemini：

```
终端里的 Claude Code（客户端，PAT）
   │  http://localhost:<port>/mcp
   ▼
CloudCLI（被测服务）
   │  ChatControlService
   ▼
CloudCLI 托管的 Claude 会话（per-run / 常驻）
```

接入方式（项目级 `.mcp.json` 或 `claude mcp add`）：

```bash
claude mcp add --transport http cloudcli http://localhost:3001/mcp \
  --header "Authorization: Bearer ${CLOUDCLI_MCP_TOKEN}"
```

约定与注意事项：

1. **客户端优先用终端里独立启动的 Claude Code**，而不是 CloudCLI 里的会话，避免自指；若用 CloudCLI 会话作为客户端，依赖「自指保护」。
2. **自动化判据不连生产 3001。** 判据在临时端口起一个独立服务实例，使用调试 agent 夹具（不跑真 CLI），数据库与数据目录指向临时路径（注意 shell 导出的 `DATABASE_PATH` 会让临时服务写进真库，必须显式覆盖）。判据里用 MCP SDK 的客户端直接调用工具，不经 Claude Code。
   - **用户与 PAT 的播种**：通过仓储函数直接写进临时库（判据进程内，或在起实例前）。不用 `scripts/mint-token.mjs`：它只造一次性用户的 JWT，且在 `JWT_SECRET` 可达时拒绝运行。
   - **排队路径的自动覆盖**：调试 agent 的宿主驱动（`debug-agent.host-driver.ts`）已有 `acceptsBusyInput` / `cancelQueuedInput` 缝，可以不跑真 CLI 验证常驻忙时排队与撤回；但它必须同样把排队消息的 uuid 交给调用方（见「未核实的前提」第 5 条）。
   - **不覆盖的部分**：真实 Claude 驱动的 `cancel_async_message` 只由现有真实 CLI 测试与阶段 4 的人工门覆盖，AC 里要明说，避免被误读为已被自动判据覆盖。
3. **真实模型的端到端验证是人工门，在独立实例上做**：另起一个 CloudCLI 实例（独立端口、独立 `DATABASE_PATH`、一个临时项目、真实 Claude CLI），由终端 Claude Code 用自然语言驱动（「列出正在运行的会话」「给那个会话发一句话」「停掉它」），人在该实例的 UI 里确认运行出现、可订阅、可中止，结果记录到冒烟文档。不对着生产 3001 做：重启它会 `shutdown-close` 所有常驻会话。
4. **不要从被托管的会话里重启 3001**（会杀掉发起重启的会话本身）。在生产上启用 MCP（设置 `MCP_ENABLED` 等并重启）是人在会话外执行的单独步骤，不属于判据，只在阶段 3 的交付说明里列出。
5. **开发服务器**：Vite 只代理 `/api` 与 `/ws`（`vite.config.js:68-72`），Claude Code 要直连后端端口，不经 5173。

这一结构同时证明了目标 2：同一个运行既能被 MCP 客户端驱动，又在 Web UI 里实时可见。

---

## `/api/agent` 退役清单（阶段 0）

| 动作 | 位置 |
|---|---|
| 删除模块 | `server/modules/agent/`（含 `tests/agent.routes.test.ts`） |
| 删除挂载与组装 | `server/index.ts:113`（`createAgentModule`）、`:326` |
| 删除仓储 | `server/modules/database/repositories/api-keys.ts`、`database/index.ts:7` 的导出、`schema.ts:16` 的 `API_KEYS_TABLE_SCHEMA_SQL` 与 `:343-345` 的索引；迁移中 drop 表 |
| 设置模块 | `settings.module.ts:17-21`、`settings.service.ts:9,57-80`、`settings.routes.ts:25-28` 的 api-keys 部分删除，PAT 管理由 `oauth` 模块的设置路由提供 |
| 前端 | `src/shared/api.ts:610-614` 改为 access-tokens 接口；`ApiKeysSection`、`NewApiKeyAlert`、`useCredentialsSettings` 改造；i18n 键改名 |
| 文档 | `public/api-docs.html` 改写为「CloudCLI MCP 接入与 PAT」，或删除 |

删除后 `/api/agent` 返回 SPA 的 200（未挂载 `/api` 路由的既有行为）。如需显式信号，可在原位置挂一个 `410 Gone`，待新用途确定后替换。

---

## 前端：设置 → API 页改造

在 `src/modules/settings/tabs/api-settings/` 内改造，不新开 tab。

1. **CloudCLI MCP**：显示端点 URL（复制按钮）与启用状态；附一段本机 Claude Code 接入命令。
2. **个人访问令牌**（阶段 0，替换 API Keys 区块）：名称、scope 勾选、过期时间；创建后一次性展示明文；列表显示前缀、scope、过期、最近使用；可吊销。
3. **已连接的应用**（阶段 5）：每个 OAuth grant 一行；可吊销。
4. **OAuth 客户端（高级）**（阶段 5）：手工创建 client_id / secret 与 redirect URI；列出 DCR 客户端，可禁用。
5. GitHub 凭证区块不变。

---

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `MCP_ENABLED` | `false` | 挂载 `/mcp` |
| `MCP_OAUTH_ENABLED` | `false` | 挂载 OAuth 与发现文档；未开启时 `/mcp` 只听回环地址 |
| `PUBLIC_BASE_URL` | 无 | 公网 https 基址；OAuth issuer 与资源受众的前缀 |
| `MCP_DCR` | `off` | `off` / `allowlist` / `open` |
| `MCP_ALLOWED_REDIRECT_HOSTS` | 空 | `allowlist` 模式下允许的回调主机 |
| `TRUST_PROXY` | 空 | 透传给 `app.set('trust proxy', …)` |
| `MCP_ACCESS_TOKEN_TTL_SEC` | `3600` | OAuth access token 有效期 |
| `MCP_REFRESH_TOKEN_TTL_DAYS` | `30` | refresh token 有效期 |
| `CHAT_RUN_RETENTION_MS` | `300000` | 完成运行的按 id 保留期 |
| `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` | `55000`（既有） | 非交互型审批的自动拒绝时限 |

---

## 交付阶段

| 阶段 | 内容 | 对外暴露 | 验证客户端 |
|---|---|---|---|
| 0 | 退役 `/api/agent` 与 `api_keys`；`access_tokens` 表与 PAT；设置页 PAT 区块（含 i18n 与一条 e2e） | 无 | — |
| 1 | websocket 模块内抽出 `ChatControlService`；`server/index.ts` 单实例装配，WS 处理器与 scheduled-messages 改走它；会话宿主启停抽成 service；`ChatRunSource` 新增 `'mcp'`；barrel 导出 | 无 | 现有测试 + 新单测 |
| 2 | 运行按 id 寻址与运行摘要 | 无 | 单测 |
| 3 | `/mcp`（无状态）+ SDK 与 `zod` 声明进 `dependencies`（生产是 `npm install -g`，不装 `devDependencies`；随消费者进入，不提前声明）+ PAT 校验 + scope + 审计（含保留期清理）+ 回环限制；只读工具；express 4 兼容守卫 | 仅本机 | 判据（SDK 客户端）+ 终端 Claude Code |
| 4 | 写工具（send / create / interrupt / start / close）+ 自指保护 | 仅本机 | 同上；**人工门**：独立实例上的真实模型嵌套冒烟 |
| 5 | OAuth（先手工客户端，再 DCR）+ 授权页 + 已连接的应用；经 cloudflared 上公网 | 公网 | **人工门**：Gemini Web 绑定、Android 调用（或 Claude.ai 连接器） |
| 6 | 常驻专有能力（cancel queued、reconfigure、background / cron）与审批 | 公网 | 判据 + 人工抽查 |

各阶段的验收标准在对应专节；阶段 0、3–6 的要点：

- **阶段 0**：生产代码中找不到 `apiKeysDb`、`createAgentModule`、`/api/agent` 的引用；迁移在含 `api_keys` 的旧库上运行后该表不存在且日志报告删除数，在新库上幂等；PAT 明文不落库，过期、吊销、scope 越权都被拒绝，且同一次运行里有一个有效 PAT 被接受作为正例；设置页能创建 PAT 且明文只显示一次（一条 Playwright 用例）；各语言 `settings.json` 的新键齐全（沿用 i18n 完整性判据）。
- **阶段 3**：无令牌访问 `/mcp` 返回 401；过期 / 吊销 PAT 被拒；非回环来源被拒（`MCP_OAUTH_ENABLED` 未开启时）；`cloudcli:read` 令牌调用写工具被拒并留审计；每个只读工具在夹具数据上返回正确结果（含正例对照，防止「什么都不返回」也通过）；名称模糊匹配的唯一 / 多义 / 无命中三种情形；元数据端点（`/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource/mcp`）返回 JSON content-type 而不是 SPA 的 HTML（`MCP_OAUTH_ENABLED` 开启时）；SDK 授权路由与无状态传输挂在 express 4 应用上的守卫测试（元数据 200、`tools/list` 200）；`overview` 在冷缓存下不触发任何 quay CLI 调用（以注入的命令运行器计数为 0），并有正例对照（缓存命中时返回计数）；审计日志超过保留期的记录被清理。
- **阶段 4**：`session_send` 在运行结束前返回且 `runId` 可被 `run_get` 查到；该运行出现在 `/api/providers/sessions/running`，UI 订阅可重放；常驻会话忙时 `queued: true`；`session_interrupt` 后常驻进程 pid 不变；`session_close` 遇到 `cron` lease 无 `force` 时拒绝；自指保护：目标会话正在执行名字以网关写工具名结尾的 MCP 工具（服务器别名任意）时拒绝写操作，对不在执行此类工具的会话放行；经 MCP 发的运行 `source` 为 `'mcp'`，并出现在会话运行列表里。人工门：在**独立实例**（独立端口与 `DATABASE_PATH`、临时项目、真实 Claude CLI）上用终端 Claude Code 驱动真实会话完成「发消息 → 查进度 → 中止」，结果写入冒烟文档；生产 3001 启用 MCP 是人在会话外执行的单独步骤（需重启，会关闭常驻会话），不属于判据。
- **阶段 5**：OAuth 单测覆盖 PKCE 缺失或错误、授权码重放与过期、refresh 轮换后旧 refresh 失效、受众不匹配、吊销 grant 后 access token 立即失效；无令牌访问 `/mcp` 的 401 带 `WWW-Authenticate` 与 `resource_metadata`。人工门：外部客户端完成绑定并调用 `overview`，记录回调主机、是否用 DCR、是否发送 `resource`、实测工具调用超时。
- **阶段 6**：用 provider 运行时替身制造待审批与排队消息，`approval_answer` / `session_cancel_queued` 各自生效；`AskUserQuestion` 的选项回答送达。

---

## 未核实的前提

1. **Gemini 自定义应用要求人在美国**（Google 帮助页原文：「Be 18 or over and in the US」，且仅英文、个人账号、需开启 Keep Activity）。需确认账号能否看到 Custom apps 入口；看不到时，阶段 5 的人工门改用 Claude.ai 自定义连接器或其他 MCP 客户端。
2. Gemini 的 OAuth 回调主机、是否发送 RFC 8707 `resource`、是否使用 refresh token。
3. Gemini 与 Claude Code 的工具调用超时（决定 `waitSeconds` 上限）。
4. Gemini 对工具数量、描述长度、`structuredContent` 的支持程度。
5. 常驻驱动能否在不改变事件流的前提下把排队消息的 uuid 同步交给调用方（阶段 1 的实现前提）。调试 agent 的宿主驱动同样需要做到，否则排队路径无法被自动判据覆盖；真实 Claude 驱动的 `cancel_async_message` 只由现有真实 CLI 测试与阶段 4 的人工门覆盖。
6. cloudflared 当前映射到 3001 的公网主机名，以及是否在 Cloudflare Access 之后。
7. `/api/agent` 跑出的会话是否确实出现在 UI 会话列表中（只是补充确认，不阻塞）。

已核实：Gemini 支持手工输入客户端凭证（无 DCR 时）；连接只能在 Web 完成，之后 Web 与手机都可用；Gemini 对写操作要求人工确认。

## 风险

| 风险 | 缓解 |
|---|---|
| 对外暴露的 `/mcp` 可驱动 `bypassPermissions` 的 agent，等于远程执行任意命令 | 默认关闭；OAuth 前只听回环；写操作分 scope；短期令牌；即时吊销；审计；授权页要密码并限速 |
| 会话输出中的提示注入经客户端反过来触发写工具 | 写 scope 默认不勾选；工具描述要求写前确认；Gemini 对写操作人工确认；审计可追溯 |
| 抽取 `ChatControlService` 触碰冻结的 WebSocket 判据 | 阶段 1 只搬逻辑不改协议；验收以现有判据全部通过为准 |
| 嵌套结构中会话中止或关闭自己 | 自指保护 |
| 判据误连生产服务或写进真库 | 判据起临时实例并显式覆盖数据库路径 |
| 服务重启清空注册表 | 按 id 查询返回 `restarted`，回退读 transcript |
| SDK 传递依赖漂移；SDK 自带 express 5 而项目为 express 4 | 显式声明并锁定版本；阶段 3 的 express 4 兼容守卫测试 |
| `overview` 对 N 个项目冷启动 quay CLI，在有 OOM 历史的宿主上形成无上限扇出 | 只读缓存，未命中标记「未知」，刷新只能经 `quay_snapshot` 且一次一个项目 |
| 元数据端点挂在静态路由之后，悄悄返回 SPA 的 200 | 挂载顺序写入架构；判据断言 JSON content-type |
| 两份 `ChatControlService` 实例导致「同一个入口」落空 | `server/index.ts` 单实例装配；计数间谍判据 |
| 嵌套冒烟对着生产 3001，重启会关闭所有常驻会话 | 冒烟在独立实例上做；生产启用是人在会话外的单独步骤 |

## 待决问题

1. 授权页除密码外是否需要第二因素（如 TOTP）？本 SPEC 不包含。
2. `session_send` 是否支持附件 / 图片？本 SPEC 不包含。
3. `ChatControlService` 何时从 websocket 模块拆成独立模块？

## 修订记录

- **v1（2026-10-05）**：初稿。
- **v2（2026-10-05）**：吸收外部评审并逐条核实。
  - 改正：v1 用 `runDetachedChatTurn` 发送，会绕过常驻会话的忙时排队（它在 `dispatchRun` 前自行拒绝忙会话）；v1 写的「会话正忙返回 `RUN_IN_PROGRESS`」对常驻会话是错的。改为抽出 `ChatControlService`，与 `chat.send` 同一条路径（D5）。
  - 新增：运行按 id 寻址（`runId` 已存在，缺的是按 id 查询被 supersede / 已完成的运行）；常驻宿主状态作为一等信息；`session_start` / `close` / `cancel_queued` / `reconfigure`；provider 中立命名（D6）；更细的 scope；自指保护；本机 Claude Code 作为开发期客户端（D7）。
  - 未采纳：读操作只做 Resources（客户端支持不明，读仍为 Tools）；新建独立 `chat` 模块（先在 websocket 模块内抽取）；模块名 `mcp`（与 providers 的 MCP 配置概念冲突）；OAuth 排在写工具之后对外暴露（改为 OAuth 前只听回环）。
  - 合并：`session_send_and_wait` 合并为 `session_send` 的 `waitSeconds` 参数。
- **v3.2（2026-10-05）**：落成 quay goal：阶段 0 对应 GOAL-018，阶段 1 与 2 对应 GOAL-019（均已达成），阶段 3 与 4 对应 GOAL-020，阶段 5 对应 GOAL-021，阶段 6 对应 GOAL-022。回填两处与初稿的偏离：回环守卫收紧为「转发头存在即拒」；overview 的「异常结束的运行」取保留期内被中止的运行。
- **v3.1（2026-10-05）**：GOAL-018、GOAL-019 达成后回填。保留计划外的 `GET /api/oauth/token-info`（见「令牌自检接口」）；记录 PAT 签发尚无 scope 词汇校验，归 GOAL-020。
- **v3（2026-10-05）**：对照 CloudCLI 的实际接入点审计后补齐（9 处缺口）。落成 quay goal 时再作两处修正：SDK 与 `zod` 的依赖声明、跨模块 barrel 导出都改为随各自的第一个消费者进入，而不是在阶段 0 / 1 提前声明（见 GOAL-018、GOAL-019 的非目标）。
  - 决策：D9 `ChatRunSource` 新增 `'mcp'`；D10 嵌套冒烟与生产分离。
  - 接入：`server/index.ts` 单实例装配；挂载须在静态路由之前并断言 JSON content-type；会话宿主启停抽成 service（原逻辑内联在路由里）；跨模块 barrel 导出清单与 Touches 纪律。
  - 设计修正：自指保护改为按工具名后缀匹配（服务器别名由用户随意起）；`overview` 只读 quay 缓存。
  - 验证：播种用户与 PAT 的方式；调试 agent 能覆盖排队路径、真实 Claude 驱动的撤回只由真实 CLI 测试与人工门覆盖；SDK 与 express 4 的兼容已实测并固化为守卫；SDK 与 `zod` 进 `dependencies`；PAT 设置页的 i18n 与 e2e；审计保留期清理进阶段 3。
