---
id: gap-ac253-gateway-shares-single-control-service
title: AC-253 装配与 barrel 核对：server/index.ts 只构造一个
  createChatControlService，同一标识符交给
  createWebSocketServer、initializeScheduledMessageDispatcher 与
  createMcpGatewayModule；getRunById/startResidentHost/closeResidentHost/getProjectSessionsPage
  各经 barrel 导出且有网关消费者；三触达点经间谍证明同一 send；判据
  server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac239-sdk-zod-declared-in-dependencies
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac241-mcp-token-auth-shares-service
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac246-mcp-resolve-target-fuzzy-match
  - gap-ac247-overview-quay-cache-readonly
  - gap-ac248-run-get-bounded-wait
  - gap-ac249-session-send-immediate-runid
  - gap-ac250-session-create-interrupt-lifecycle
  - gap-ac251-mcp-session-host-control
  - gap-ac252-mcp-self-target-guard
goal_ac: AC-253
---
## Proposal

AC-253（GOAL-020 的装配与 barrel 核对；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 装配 §199–§203、跨模块导出 §217–§229、验收 §236）要求 MCP 网关、WebSocket 与 scheduled-messages 共用**同一个** `ChatControlService` 实例，且这件事在 `server/index.ts` 里有可机械读出的形态；网关模块跨模块导入只经各模块 barrel，四个符号各有网关这个消费者，barrel 里不存在没有消费者的新导出。判据文件 `server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts` 当前不存在，AC-253 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts`（已实测）。

现状（红态基线）：
- `server/index.ts:118` 已经 `const chatControl = createChatControlService({ runtime: providerRuntimeService })`（全仓库唯一构造点）；`:128` 经 `chat: { control: chatControl }` 交给 `createWebSocketServer`；`:607` 交给 `initializeScheduledMessageDispatcher(chatControl)`。但网关装配是 `mountMcpGateway(app)`（`:445`），**没有** `createMcpGatewayModule` 这个调用，也没有把 `chatControl` 传进去——(a) 的第三处缺失。
- barrel：`getProjectSessionsPage`（`server/modules/projects/services/projects-with-sessions-fetch.service.ts:363`）**未**从 projects barrel 导出；`getRunById` 是 `chatRunRegistry` 的方法（`websocket/index.ts` 只导出 `chatRunRegistry`），**没有**独立 barrel 导出；`startResidentHost`/`closeResidentHost` 由 AC-251 落地并导出。SPEC §223–§225 把这三组符号列为 GOAL-020 新增跨模块导出，消费者是 mcp-gateway。

机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-239 未落地则判据无法 import MCP SDK 客户端；AC-240 未落地则无 `/mcp` 传输与装配点；AC-241 未落地则无令牌中间件与 `McpPrincipal`（(c) 要发真令牌）；AC-244 未落地则无工具派发缝；AC-245 未落地则无只读工具注册与 MCP 客户端夹具形制、`getProjectSessionsPage` 无消费者；AC-246 未落地则 `session` 字段不被改写成 sessionId；AC-247/AC-248 未落地则网关的 overview/run_get deps 与运行摘要 barrel 导出不齐；AC-249 未落地则 `session_send` 与控制服务注入缝不存在（(c) 无从触达）；AC-250/AC-252 未落地则网关的写工具 handler 与自指守卫装配不齐；AC-251 未落地则 `startResidentHost`/`closeResidentHost` 的 barrel 导出与网关消费者不存在（(b) 无从核对）。

要交付：

1. **网关装配入口 `createMcpGatewayModule`**（`server/modules/mcp-gateway/index.ts` 导出；实现可落 `mcp-gateway.transport.ts` 或新文件，遵守 `$backend-module-standards`）：签名接受 `{ app, control, ...AC-245/247/248/249/251/252 各自的工具 deps }`，内部委派既有的挂载函数（AC-240 的 `mountMcpGateway`），返回挂载读数。**保留 `mountMcpGateway` 原名与语义**，使 AC-240/245/249/251 的判据不改一字仍通过；`createMcpGatewayModule` 只是那个被 AC-253 命名的组合入口。`server/index.ts` 把 `mountMcpGateway(app)` 一行替换为 `createMcpGatewayModule(app, { control: chatControl, ... })`——`chatControl` 与交给 `createWebSocketServer`、`initializeScheduledMessageDispatcher` 的是**同一个标识符**，(a) 由此成立。
2. **barrel 核对补齐**：
   - `getRunById`：从 websocket barrel 导出（薄包装 `chatRunRegistry.getRunById` 或按 SPEC §223 的实际落地形态），消费方注释点名 mcp-gateway（`run_get`/`session_send` 读当前运行）；若 AC-248 已以 `chatRunRegistry.getRunById` 形态消费，以实际落地为准合并，不重复导出。
   - `getProjectSessionsPage`：从 projects barrel 导出，消费方注释点名 mcp-gateway（`sessions_list`）。
   - `startResidentHost`/`closeResidentHost`：核对 AC-251 已在 session-hosts barrel 导出且消费者是网关适配层；缺则补。
   - 三个 barrel 中**不得**存在没有消费者的 GOAL-020 新导出。
3. **判据文件 `server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts`（红先行）**：
   - (a) 抽一个**纯函数** `scanSingleControlServiceWiring(source: string)`（导出自测试文件内的本地模块或 gateway 的一个可测模块），对 `server/index.ts` 源码解析语法树（用 TypeScript compiler API，仓库已依赖 TS）：断言 `createChatControlService(` 调用**恰好一次**，取其绑定标识符，断言该标识符作为实参出现在 `createWebSocketServer`、`initializeScheduledMessageDispatcher`、`createMcpGatewayModule` 三个调用里（允许嵌在对象字面量参数中，扫描器须递归）。**正例对照**：喂入一份合成源码，其中出现第二次 `createChatControlService(` ⇒ 同一扫描器判出「不恰好一次」并逐字报出两个构造点；再喂入一份把标识符从 `createMcpGatewayModule` 实参里挪走的合成源码 ⇒ 判出缺失。逐字写出真实 `server/index.ts` 的构造点数与三处命中证据。
   - (b) barrel 审计：读取 `server/modules/{websocket,session-hosts,projects}/index.ts` 源码，断言 `getRunById`、`startResidentHost`、`closeResidentHost`、`getProjectSessionsPage` 四者各自**被导出**；断言 `server/modules/mcp-gateway/` 下的**非测试**实现文件通过 `@/modules/<模块>/index.js`（barrel）而非深路径导入这些符号（边界 lint 同款形态）；断言不存在「导出于 barrel、却没有任何网关实现文件经 barrel 导入」的 GOAL-020 新导出。**负例对照**：往 barrel 源码追加一个没有消费者的合成导出 ⇒ 审计判出该符号无消费者并逐字报出符号名。逐字写出四条导出行与网关侧导入行。
   - (c) 同一实例间谍：像 `server/index.ts` 那样组装一个**真实**的装配——`createChatControlService` 包一层计数 spy（记录收到的 `caller`/`SendInput`）——把同一 spy 实例交给 `createWebSocketServer`（`chat.control`）、`initializeScheduledMessageDispatcher`、`createMcpGatewayModule`。用**真实** express 4 应用 + 真实 better-sqlite3 临时库 + owner 用户 + 真令牌 + MCP SDK `Client`/`StreamableHTTPClientTransport`（传基于 `node:http` 的 `fetch`，避开 `listen(0)` 的 undici 坏端口——内存 `undici-bad-port-lottery-in-listen0-route-tests`）+ 调试 agent 会话。三处各触达一次：WebSocket `chat.send`、定时发送（造一条到期的定时消息并驱动 `initializeScheduledMessageDispatcher` 的派发，或复用其导出的派发入口）、MCP `session_send`；断言同一个 spy 三处计数各 +1、且三处收到的 `caller.via` 分别为 `'websocket'`/`'scheduled'`/`'mcp'`（逐字写出三组读数与 spy 对象身份）。**正例对照**：三条路径的 `runId` 都可从同一 `chatRunRegistry` 读到（防「spy 被调用但没走真 send」）。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 网关内部再 `new` 一个控制服务（`createMcpGatewayModule` 里自造实例、`server/index.ts` 不再把 `chatControl` 传给它）⇒ (a) 与 (c) 必须红；
   (ii) 往某个 barrel 导出一个没人用的符号 ⇒ (b) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 AC-253 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 扫描器对真实 `server/index.ts`：`createChatControlService(` 恰好一次，其绑定标识符出现在 `createWebSocketServer`、`initializeScheduledMessageDispatcher`、`createMcpGatewayModule` 三处实参；正例对照两则（第二次构造被判出、标识符被挪走被判出）逐字写出扫描器输出。
- [x] AC4 (b) 四条 barrel 导出行逐字写出；网关侧经 barrel 的导入行逐字写出；负例对照（合成无消费者导出）被判出并报出符号名。
- [x] AC5 (c) 同一 spy 实例三处各 +1、三处 `caller.via` 分别为 websocket/scheduled/mcp，三处 `runId` 均可从同一注册表读到；逐字写出三组计数与身份判定。
- [x] AC6 取假形态 (i) 网关自造控制服务 ⇒ (a)(c) 红；记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [x] AC7 取假形态 (ii) barrel 无消费者导出 ⇒ (b) 红；记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [x] AC8 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；AC-240 判据 `mcp-transport.test.ts`、AC-245/248/249/251 判据、既有控制服务判据 `chat-control-*.test.ts` 与 scheduled-messages 判据不改一字仍逐字通过。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- WebSocket `chat.send`、定时发送、MCP `session_send` 三处**真的**触达同一个控制服务实例的同一个 `send`（同一 spy 三处计数各 +1、对象身份判定），不是三份各自 new 的实例。
- `server/index.ts` 的语法树读数**真的**是「一次构造 + 同一标识符传给三个调用」，并有合成源码正例对照证明扫描器不是恒真。
- `getRunById`/`startResidentHost`/`closeResidentHost`/`getProjectSessionsPage` **真的**各经 barrel 导出且**真的**有网关这个消费者；barrel 里**真的**不存在没有消费者的 GOAL-020 新导出（负例对照证明）。
- 两条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不改控制服务本体、不改工具集合的名字与 scope；不越界实现 AC-254–AC-257 的读数与判据。

## Touches

- server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts (new)（判据）
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/index.ts
- server/modules/websocket/index.ts
- server/modules/projects/index.ts
- server/modules/session-hosts/index.ts
- tasks/gap-ac253-gateway-shares-single-control-service.md

## Notes

- `createMcpGatewayModule` 这个名字是 AC-253 判据的机械读数，实现必须以该名导出并在 `server/index.ts` 被调用；`mountMcpGateway`（AC-240）保留原名与语义，`createMcpGatewayModule` 委派它，避免 AC-240/245/249/251 判据变红。
- 扫描器用 TypeScript compiler API（`typescript` 已在仓库依赖），对 `server/index.ts` 只做静态读取，不 import 该文件（import 会拉起整个进程侧效应）。
- (c) 驱动定时发送沿用调度器既有测试形制（`scheduled-messages.test.ts` 的 `createControl` 假件换成真控制服务 spy）；造一条 `status` 待派发、`scheduled_for` 已过期的行并触发派发。
- 边界 lint 会拦新增测试文件（内存 `quay-boundaries-lint-blocks-new-test-files`）；判据文件已列入 `## Touches`。给 websocket/projects barrel 加导出后，若某兄弟测试对该 barrel 整体 `vi.mock`，需把新导出补进那个 mock 工厂（内存 `adding-an-export-reds-sibling-wholesale-vimocks`）。
- 判据的 SDK 客户端用基于 `node:http` 的 `fetch`（内存 `undici-bad-port-lottery-in-listen0-route-tests`）。
- (b) 的「无消费者新导出」以**声明的 GOAL-020 新增导出清单**（SPEC §221–§226 四符号 + 运行摘要/查询类型）为准做判定，不把历史存量导出误判为「新导出」；负例对照证明该判定有效。

## 完成记录

实现提交：`dfc32f8e`（分支 `task/gap-ac253-gateway-shares-single-control-service`）。

### 实现形态
- `server/modules/mcp-gateway/index.ts` 新增导出 `createMcpGatewayModule` / `McpGatewayModuleDeps`（消费方注释点名 `server/index.ts`）。
- `server/modules/mcp-gateway/mcp-gateway.transport.ts` 新增 `createMcpGatewayModule`：接受 `{ control, readTools?, writeTools, residentTools?, ... }`，把 projects / session-hosts / `chatRunRegistry` 三处 barrel 缝与 `runs` 从本模块派生，返回既有的 `McpGatewayDeps`。它**返回** deps 而**不**自行挂载，以保留 AC-240 冻结判据扫描的 `mountMcpGateway(...)` 调用形态。
- `server/index.ts` 保留 `mountMcpGateway(app, ...)` 调用，并把 `createMcpGatewayModule({ control: chatControl, ... })` 嵌为其实参：`chatControl` 是 `:143` 唯一构造点绑定的标识符，同名字符串交给 `createWebSocketServer`、`initializeScheduledMessageDispatcher` 与 `createMcpGatewayModule`。顺带删除一条已无用的 projects barrel 顶层导入（`mcpGateway` 装配现经 `createMcpGatewayModule` 取用）。
- `getRunById` 按 Notes 转义条款以 `chatRunRegistry`（AC-248 已消费的方法形态）落地，**不**新增第二个具名导出；`getProjectSessionsPage`、`startResidentHost`/`closeResidentHost` 的 barrel 导出在 AC-248/AC-251 已落地，无需改动（Touches 声明的三个 barrel 因此是 declared-but-unchanged）。

### AC1 红态基线
实现前该判据文件不存在。以移开文件复现存在性闸（等价于 `dfc32f8e^` 状态），逐字输出：
```
$ for f in server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts
缺判据文件：server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts
EXIT=1
```

### AC2 判据绿
`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts` 退出 0：
```
✔ (a) server/index.ts constructs one control service and hands the same identifier to all three consumers
✔ (b) the three barrels export the GOAL-020 symbols and the gateway consumes each through a barrel
✔ (c) the WebSocket, scheduled and MCP front ends reach one control-service instance
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

### AC3 (a) 扫描器读数
```
(a) real.constructCount=1 lines=[143]
(a) real.identifier="chatControl" consumers={"websocket":true,"scheduled":true,"gateway":true}
(a) two.constructCount=2 lines=[5,6] bindings=["chatControl","chatControlSecond"]
(a) moved.consumers={"websocket":true,"scheduled":true,"gateway":false} identifier="chatControl"
```
正例对照一：合成源码第二次 `createChatControlService(` ⇒ `constructCount=2 lines=[5,6]`（两构造点逐字报出）。正例对照二：把标识符从 `createMcpGatewayModule` 实参挪走 ⇒ `gateway:false`（websocket/scheduled 仍 true，证明不是恒假）。

### AC4 (b) barrel 审计读数
四条 barrel 导出行逐字：
```
server/modules/projects/index.ts:12   getProjectSessionsPage,
server/modules/session-hosts/index.ts:21 export { closeResidentHost, startResidentHost } from './resident-host.service.js';
server/modules/websocket/index.ts:42  export { chatRunRegistry, createChatRunRegistry } from './services/chat-run-registry.service.js';   // getRunById 以 chatRunRegistry 方法形态（转义条款，不重复导出）
server/modules/websocket/index.ts:51-55 export type { ChatRunLookupMiss, ChatRunLookupResult, ChatRunSummary } from './services/chat-run-registry.service.js';
```
网关侧经 barrel 的导入行逐字：
```
server/modules/mcp-gateway/mcp-gateway.transport.ts: import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/index.js';
server/modules/mcp-gateway/mcp-gateway.transport.ts: import { chatRunRegistry } from '@/modules/websocket/index.js';
server/modules/mcp-gateway/mcp-run-get.ts: import type { ActivityProtocolSnapshot, ChatRunLookupResult } from '@/modules/websocket/index.js';
server/modules/mcp-gateway/mcp-session-host-control.ts: import { closeResidentHost, sessionHostManager, startResidentHost } from '@/modules/session-hosts/index.js';
```
审计读数与负例对照：
```
(b) exports={"sessionHostsStart":true,"sessionHostsClose":true,"projectsSessionsPage":true,"websocketGetRunById":"registry","summaryTypesPresent":true}
(b) gateway={"projectsBarrelImport":true,"websocketBarrelImport":true,"sessionHostsBarrelImport":true,"getRunByIdCallOnRegistry":true,"deepImports":[]}
(b) unconsumed=[]
(b) negative.unconsumed=["ac253UnconsumedProbe"]
```
（`ChatRunSummary`/`ChatRunLookupMiss` 是被消费的联合类型 `ChatRunLookupResult` 的成员，审计按「消费联合锚点即消费其成员」处理；负例对照的合成导出 `ac253UnconsumedProbe` 被逐字报出。）

### AC5 (c) 同实例 spy 读数
```
(c) reading={"counts":{"send":3},"callers":[{"userId":1,"via":"websocket"},{"userId":1,"via":"scheduled"},{"userId":1,"via":"mcp"}],"runs":{"websocket":{"runId":"1684f832-42d4-43e4-9b00-cc5f1af3b883","source":"user"},"scheduled":{"runId":"95fa9229-3ee1-446b-876d-4cb893c3c3d7","source":"scheduled"},"mcp":{"runId":"1444a2b9-fd80-41ee-b3fb-e8eee0bebd94","source":"mcp"}},"mcpIsError":false}
```
同一 spy 的 `counts.send` 恰为 3；三处 `caller.via` 为 websocket/scheduled/mcp，`userId` 均为 owner；三条 `runId` 各不相同、`source` 分别为 user/scheduled/mcp，且都能从同一 `chatRunRegistry.getRunById` 读到（`status !== 'unknown'`）。

### AC6 取假形态 (i)：网关自造控制服务
变异 diff（`git diff`）：
```
server/index.ts:582
-        control: chatControl,
+        control: createChatControlService({ runtime: providerRuntimeService }),
server/modules/mcp-gateway/mcp-gateway.transport.ts
-      control,
+      control: { ...control, send: async () => ({ ok: true, runId: 'gateway-own', queued: false, queuedMessageUuid: null, completion: Promise.resolve({ started: true, error: null }) }) },
```
逐字失败行：`gateway-wiring (a) real.constructCount=2 lines=[143,582]`、`✖ (a) … AssertionError [ERR_ASSERTION]: server/index.ts must construct the chat control service exactly once`、`gateway-wiring (c) reading={"counts":{"send":2},"callers":[{"userId":1,"via":"websocket"},{"userId":1,"via":"scheduled"}],"runs":{…,"mcp":null},…}`、`✖ (c) …`，`ℹ pass 1 / ℹ fail 2`。
恢复命令：`cp /tmp/ac253-index.bak2 server/index.ts && cp /tmp/ac253-transport.bak2 server/modules/mcp-gateway/mcp-gateway.transport.ts`；重跑 `ℹ tests 3 / pass 3 / fail 0`。

### AC7 取假形态 (ii)：barrel 无消费者导出
变异 diff：`server/modules/projects/index.ts` 追加 `export const ac253UnconsumedProbe = 1;`；判据 `DECLARED_NEW_EXPORTS` 补入 `'ac253UnconsumedProbe'`（因审计只判定声明的 GOAL-020 新导出，新符号须同时声明）。
逐字失败行：`gateway-wiring (b) unconsumed=["ac253UnconsumedProbe"]`、`✖ (b) … AssertionError [ERR_ASSERTION]: no declared GOAL-020 export may lack a consumer`，`ℹ pass 2 / ℹ fail 1`。
恢复命令：`cp /tmp/ac253-projects.bak server/modules/projects/index.ts && cp /tmp/ac253-criterion.bak server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts`；重跑 `ℹ tests 3 / pass 3 / fail 0`。判据内另有常驻负例对照 `(b) negative.unconsumed=["ac253UnconsumedProbe"]` 逐字复现该判定。

### AC8 仓库门
```
$ npm run typecheck   → exit 0
$ npm run lint | grep -c ': error '   → 0
$ npx tsx --tsconfig server/tsconfig.json --test \
    server/modules/mcp-gateway/tests/{mcp-gateway-wiring,mcp-transport,mcp-read-tools,mcp-run-get,mcp-session-send,mcp-session-host-control}.test.ts \
    server/modules/websocket/tests/chat-control-{access,busy,ownership,send,source,wiring}.test.ts \
    server/modules/scheduled-messages/tests/scheduled-messages.test.ts
ℹ tests 70
ℹ pass 70
ℹ fail 0
```
AC-240 (`mcp-transport.test.ts`)、AC-245 (`mcp-read-tools.test.ts`)、AC-248 (`mcp-run-get.test.ts`)、AC-249 (`mcp-session-send.test.ts`)、AC-251 (`mcp-session-host-control.test.ts`)、既有 `chat-control-*.test.ts` 与 `scheduled-messages.test.ts` 均不改一字仍通过。

### AC9 改动清单
`git diff --name-status develop...HEAD`：
```
M server/index.ts
M server/modules/mcp-gateway/index.ts
M server/modules/mcp-gateway/mcp-gateway.transport.ts
A server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts   (new)
```
四条全部落在 `## Touches`。Touches 声明的 `server/modules/{websocket,projects,session-hosts}/index.ts` 是 declared-but-unchanged（其导出在 AC-248/AC-251 已落地）；anti-drift 判 `actual ⊆ declared`（单向），故不需也**不**删这些声明（内存 `quay-touches-must-match-actual-write-sites` 例 F）。控制服务本体（`chat-run-registry.service.ts` / `chat-control.service.ts`）未改，遵守转义条款。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-253" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-253`；`grep -rln "AC-253" tasks/` 只命中 AC-249/250/251/252 的边界段（各自声明「装配与 barrel 核对（AC-253）是不同机制与不同判据文件，本任务不越界」，并明确 AC-251 只加它自己消费的 `startResidentHost`/`closeResidentHost` 导出、`getRunById`/`getProjectSessionsPage` 等归各自消费者任务、AC-253 负责跨 barrel 核对）。AC-253 的机制是「唯一装配 + 跨 barrel 消费者核对 + 三触达点同实例」，与 AC-249 (g) 的「WS 与 MCP 两处同实例」不同（AC-253 增入 scheduled 一处，且多出 (a) 语法树读数与 (b) barrel 审计两个独立机制）。前述 `depends_on` 声明的机械前置均由字段承载。