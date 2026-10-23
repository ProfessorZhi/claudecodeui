---
id: gap-ac252-mcp-self-target-guard
title: AC-252 自指保护：目标会话 phase='tool'
  且工具名后缀命中网关写工具名时，session_send/session_interrupt/session_close/session_cancel_queued
  返回 SELF_TARGET、控制与宿主服务计数为 0；别名任意、读工具与 phase≠tool 放行、写工具名集合取自注册表；判据
  server/modules/mcp-gateway/tests/mcp-self-target.test.ts
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
  - gap-ac249-session-send-immediate-runid
  - gap-ac250-session-create-interrupt-lifecycle
  - gap-ac251-mcp-session-host-control
goal_ac: AC-252
---
## Proposal

AC-252（GOAL-020 退出条件 9 的第一条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §290–§300「自指保护」、§523 阶段 4、§296 规则）要求：当 MCP 客户端本身就是一个 CloudCLI 会话时，**对它的写操作必须被拒**，以免它中止或关闭自己正在等待工具结果的那一轮，或把消息排到自己之后。判定规则：目标会话当前运行的 `turn.phase === 'tool'` **且** `turn.toolName` 匹配 `^mcp__.+__(<网关写工具名>)$`（网关写工具名**取自工具注册表，不手写第二份**），则对它的 `session_send` / `session_interrupt` / `session_close` / `session_cancel_queued` 一律拒绝，错误码 `SELF_TARGET`，控制服务与宿主服务的调用计数为 0。服务器别名由用户在 `.mcp.json` 随意起，**不得按 `mcp__cloudcli` 前缀判断**；读工具不受影响；阶段不是 `tool`（工具名是上一轮的残留值）时放行。判据文件 `server/modules/mcp-gateway/tests/mcp-self-target.test.ts` 当前不存在，AC-252 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-self-target.test.ts`。

现状（红态基线）：
- `server/modules/mcp-gateway/` 目前只有传输与开关（AC-240：`mcp-gateway.transport.ts` / `mcp-gateway.gate.ts`），没有工具注册、没有写工具、没有守卫。
- 回合状态的唯一来源是 providers barrel 的 `readSessionTurn(sessionId): TurnState`（`{ phase, toolName, toolDurationMs }`，定义在 `server/modules/providers/list/claude/claude-runtime.provider.ts:954`，经 `@/modules/providers/index.js` 导出）；活动存储（`activityStore`，websocket barrel）的默认 `readTurn` 即读它。`TurnState.toolName` 是 `tool_use` 块的原始名字，形如 `mcp__<alias>__<tool>`；目前只有 Claude 的阶段推导器（`claude-turn-phase.service.ts`）产出它，其它 provider 的会话恒为 `idle`，不触发守卫（SPEC §297 已声明这是启发式且只承诺 Claude）。
- 写工具注册表 `MCP_STAGE4_WRITE_TOOLS`（AC-249）是写工具名与 scope 的唯一事实来源；AC-249 的 `registerMcpWriteTools` 经 AC-244 的 `withMcpAudit` 注册这 5 个工具。守卫必须从该注册表（或注入的等价物）取写工具名。
- `session_cancel_queued` 是阶段 6（GOAL-022）的工具，**不在**阶段 4 注册表里，本任务也不注册它（越界）。本任务只交付守卫本身，使 GOAL-022 把该工具加入注册表后**无需改动守卫**即可被覆盖；判据对 `session_cancel_queued` 这个受保护操作的判定走守卫的直接读数（注入注册表 + 注入回合读取器），而不是走一个尚不存在的 HTTP 工具。

要交付：

1. **守卫模块（新文件 `server/modules/mcp-gateway/mcp-self-target.ts`；遵守 `$backend-module-standards`，导出带消费方注释）**：
   - `export const SELF_TARGET_CODE = 'SELF_TARGET';`
   - `export const MCP_SELF_TARGET_WRITE_OPS = ['session_send', 'session_interrupt', 'session_close', 'session_cancel_queued'] as const;`——SPEC §296 规定在自指目标上被拒的四个写操作（`session_start` / `session_create` 不在其中）。消费者是写工具派发点。
   - `export type SelfTargetDeps = { readTurn: (sessionId: string) => TurnState; writeToolNames: readonly string[] };`——两者都可注入；生产默认 `readTurn = readSessionTurn`（providers barrel），`writeToolNames` = `MCP_STAGE4_WRITE_TOOLS.map(t => t.name)`。
   - `export function isSelfTargetTurn(turn: TurnState, writeToolNames: readonly string[]): { blocked: boolean; suffix: string | null; reason: string }`——当且仅当 `turn.phase === 'tool'` **且** `turn.toolName` 形如 `mcp__<任意非空别名>__<name>` 且 `name ∈ writeToolNames` 时为 `blocked`；`suffix` 是命中的写工具名（**按最后一个 `__` 边界取后缀，不做 `mcp__cloudcli` 前缀匹配**——别名任意）；`reason` 可打印，两侧都给。`writeToolNames` 为空、`toolName` 为 `null`、不含 `__`、别名为空、或以 `mcp__` 开头却只有一个分隔段 ⇒ 不拦。
   - `export function buildSelfTargetGuard(deps: SelfTargetDeps): (input: { op: string; targetSessionId: string }) => SelfTargetDecision`——`op ∉ MCP_SELF_TARGET_WRITE_OPS` ⇒ `{ allowed: true }`（读工具与不受保护的写工具直接放行；读工具永远不被拒）；否则读 `deps.readTurn(targetSessionId)` 交给 `isSelfTargetTurn`，命中 ⇒ `{ allowed: false, code: SELF_TARGET_CODE, message, suffix }`，`message` 点名目标会话、命中的工具名与操作（例如 `目标会话 <id> 正在执行网关写工具 <toolName>，对它的写操作（<op>）被拒绝，以免自指卡死。`），未命中 ⇒ `{ allowed: true }`。
   - 守卫内部**只能**从注入的 `writeToolNames` 取写工具名，**不得**再写一份工具名数组（关 (d) 的「手写第二份名单」）。

2. **写工具派发接线（`server/modules/mcp-gateway/mcp-gateway.write-tools.ts` + `mcp-gateway.transport.ts`，AC-249/AC-251 的文件）**：
   - 在受保护写工具的 handler **之前**，用 AC-246 解析门改写后的 sessionId 调守卫（`op` = 工具名，`targetSessionId` = 解析后的会话 id）；`allowed: false` ⇒ 返回 MCP `isError` 结果，`structuredContent` 含 `{ code: 'SELF_TARGET', message }`，**不调用** handler（⇒ 控制服务与宿主服务计数 0）。
   - 守卫的 deps 经 `McpGatewayDeps` 的可注入缝传入，默认 `readTurn = readSessionTurn`、`writeToolNames` 取自 `MCP_STAGE4_WRITE_TOOLS`。判据注入自己的回合读取器与（(d) 用的）自己的注册表。
   - 守卫在认证 + scope 检查**之后**运行：scope 不足的调用仍先由 `withMcpAudit` 以 `denied` 拒绝（判据发的令牌带足 `cloudcli:read` / `cloudcli:session:send` / `cloudcli:session:control`，使守卫成为唯一的拒绝理由）。

3. **barrel（`server/modules/mcp-gateway/index.ts`）**：导出 `buildSelfTargetGuard`、`isSelfTargetTurn`、`SELF_TARGET_CODE`、`MCP_SELF_TARGET_WRITE_OPS`、`SelfTargetDeps`、`SelfTargetDecision`，各写消费方注释，不导出无消费者符号。

4. **判据文件 `server/modules/mcp-gateway/tests/mcp-self-target.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + MCP SDK 客户端 + 真实 better-sqlite3 临时库 + 调试 agent 会话 + 可注入回合读取器/注册表）**：形制照 AC-249/AC-251（`mkdtemp` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发带 `['cloudcli:read','cloudcli:session:send','cloudcli:session:control']` 的真令牌 + 同一 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`，避开 `listen(0)` 的 undici 坏端口——内存 `undici-bad-port-lottery-in-listen0-route-tests`）。会话用调试 agent（`DEBUG_AGENT_PROVIDER_ID` + `createSessionHostManager` + `createDebugAgentHostDriver` + `armDebugAgentScenario`）。**注入**一个回合读取器（按 sessionId 返回判据制造的 `TurnState`）、一个 spy 包装的真控制服务（`send` / `abort` / `cancelQueued` 计数）与宿主服务（`start` / `close` 计数）。读数各自独立成断言并逐字写出原始值：
   - (a) **别名任意 + 四个受保护操作都拒**：phase='tool'，触发工具名取 `mcp__cloudcli__session_send`、`mcp__my-cc-ui__session_interrupt`、`mcp__x__session_close`（任意别名 + 网关写工具名后缀）。对四个操作 `session_send` / `session_interrupt` / `session_close` / `session_cancel_queued`：前三者经真实 MCP 客户端 `tools/call` 断言 `isError` 且 `structuredContent.code === 'SELF_TARGET'`；`session_cancel_queued`（阶段 6、未注册）走 `buildSelfTargetGuard` 直接读数断言 `{ allowed:false, code:'SELF_TARGET' }`。三种触发名 × 四个操作**全部** `SELF_TARGET`；控制服务 `send` / `abort` / `cancelQueued` 与宿主服务 `start` / `close` 计数**全为 0**。逐字写出三个工具名、四个操作、五个计数。
   - (b) **放行**：同一 phase='tool' 目标，工具名取 `Bash`、`mcp__other__list_files`、`mcp__x__session_read`（读工具名）⇒ 守卫放行；经 HTTP `session_send` 成功且控制服务 `send` 计数**恰好 +1**（正例对照：证明守卫不是「一律拒绝」）。逐字写出三个工具名、判定与前后计数。
   - (c) **阶段不是 tool 就放行**：工具名保留上一轮的 `mcp__x__session_close`，phase 依次取 `thinking` / `writing` / `idle` / `awaitingPermission` / `compacting` ⇒ 守卫全部放行；经 HTTP `session_send` 使控制服务 `send` 计数 +1。逐字写出每个 phase 与计数。
   - (d) **写工具名集合取自注册表**：`const base = [...MCP_STAGE4_WRITE_TOOLS]`，`const extended = [...base, { name: 'session_reconfigure', scope: 'cloudcli:session:control' }]`；phase='tool'，工具名 `mcp__x__session_reconfigure`：用 `base` 构建的守卫 ⇒ `allowed: true`；用 `extended` 构建的守卫 ⇒ `SELF_TARGET`（新增写工具被自动覆盖）。逐字写出两个判定与两份注册表名字。
   - (e) **读工具永不被拒**：目标会话自身处于 phase='tool' 且工具名是网关写工具时，读工具（至少一个，如 `session_read` 或 `session_get`）经 HTTP 调用仍成功、结果不是 `SELF_TARGET`，控制服务计数不变。逐字写出该读工具结果。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 守卫只按 `^mcp__cloudcli__` 服务器前缀判断 ⇒ (a) 的两个别名用例（`mcp__my-cc-ui__session_interrupt`、`mcp__x__session_close`）必须红；
   (ii) 守卫手写第二份写工具名名单（不用注入的 `writeToolNames`，改用模块内 `const` 数组）⇒ (d) 必须红（`session_reconfigure` 不被覆盖）；
   (iii) 守卫不看 `phase`、只看 `toolName` ⇒ (c) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-252" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-252`；`grep -rln "AC-252" tasks/` 只命中 AC-245/246/247/248/249/250/251 的边界段（各自声明「自指保护（AC-252）不在本任务」；AC-249 的 Notes 明确「`MCP_STAGE4_WRITE_TOOLS` 是写工具名的唯一事实来源（AC-252 的自指保护读它取网关写工具名，不手写第二份）」，AC-249 的边界段明确「本任务交付写工具注册集合与 `session_send` 一个真实 handler……AC-252 不越界」）。AC-253（装配与 barrel 核对）是不同机制与不同判据文件，本任务不越界。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-239 未落地则判据无法 import SDK 客户端；AC-240 未落地则无 `/mcp` 传输与工具注册缝；AC-241 未落地则无令牌中间件与 `McpPrincipal`；AC-244 未落地则无 `withMcpAudit` 派发缝（守卫挂在其内/其后）；AC-245 未落地则无只读工具（(b)(e) 的读工具读数与工具注册缝消费先例）；AC-246 未落地则写工具的 `session` 字段不会被改写成 sessionId（守卫取不到目标 id）；AC-249 未落地则写工具注册表与 `session_send` 不存在；AC-250 未落地则 `session_interrupt` handler 不存在；AC-251 未落地则 `session_close` handler 与宿主服务接线不存在（(a) 的宿主服务计数无从观测）。AC-240 已 done，仍列出以保持与本 goal 其它任务的声明一致。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-252 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-self-target.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-self-target.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-self-target.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 三个别名（`mcp__cloudcli__session_send` / `mcp__my-cc-ui__session_interrupt` / `mcp__x__session_close`）× 四个受保护操作（`session_send` / `session_interrupt` / `session_close` / `session_cancel_queued`）全部 `SELF_TARGET`；控制服务 `send`/`abort`/`cancelQueued` 与宿主服务 `start`/`close` 计数全 0；逐字写出工具名、操作与五个计数。
- [x] AC4 (b) `Bash` / `mcp__other__list_files` / `mcp__x__session_read` 放行；HTTP `session_send` 成功且控制服务 `send` 计数恰好 +1（正例对照）；逐字写出工具名、判定与前后计数。
- [x] AC5 (c) 工具名残留 `mcp__x__session_close` 而 phase ∈ {`thinking`,`writing`,`idle`,`awaitingPermission`,`compacting`} ⇒ 全部放行、`send` 计数 +1；逐字写出每个 phase 与计数。
- [x] AC6 (d) 用基础注册表时 `mcp__x__session_reconfigure` 放行、用加入 `session_reconfigure` 的扩展注册表时被拦（守卫自动覆盖新写工具）；逐字写出两个判定与两份注册表名字。
- [x] AC7 (e) 目标自身处于自指时读工具仍成功、非 `SELF_TARGET`、控制服务计数不变；逐字写出读工具结果。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 只按 `mcp__cloudcli` 前缀 ⇒ AC3 红；(ii) 手写第二份名单 ⇒ AC6 红；(iii) 不看 phase ⇒ AC5 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；AC-249 判据 `mcp-session-send.test.ts`、AC-250 判据 `mcp-session-lifecycle.test.ts`、AC-251 判据 `mcp-session-host-control.test.ts`、AC-245 判据 `mcp-read-tools.test.ts` 不改一字仍逐字通过（本任务只在 handler 前加守卫，不改工具实现与 handler 语义）。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 守卫**真的**经真实 HTTP + MCP SDK 客户端生效：目标会话处于 `phase='tool'` 且工具名后缀命中网关写工具名时，`session_send` / `session_interrupt` / `session_close` **真的**返回 `SELF_TARGET`，且控制服务与宿主服务**真的**一次都没被调用（spy 计数 0）——不是「函数被调用」或「判据文件存在」就算数。
- 服务器别名**真的**任意：`mcp__cloudcli__`、`mcp__my-cc-ui__`、`mcp__x__` 三种别名**真的**都被拦；(i) 证明前缀匹配是错的写法。
- 写工具名集合**真的**取自注册表：加入一个新写工具后守卫**真的**自动覆盖它，且守卫内**没有**第二份手写名单（(d) 与 (ii) 是这条的机械证据与反证）。
- `phase !== 'tool'` **真的**放行（残留工具名不误伤）；读工具**真的**永不被拒。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不改控制服务与宿主服务本体；不注册 `session_cancel_queued`（GOAL-022）；不越界实现 AC-253–AC-257 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-self-target.ts (new)
- server/modules/mcp-gateway/tests/mcp-self-target.test.ts (new)（判据）
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- tasks/gap-ac252-mcp-self-target-guard.md

## Notes

- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-251 同款说明）。
- 阶段不是 `tool` 时 `turn.toolName` 可能仍是上一轮的工具名（`claude-turn-phase.service.ts` 只在 `result` / `tool_result` 时清空），所以 (c) 的读数专门覆盖「残留工具名 + 非 tool 阶段」这一假阴/假阳来源。
- 守卫按**最后一个 `__` 边界**取后缀：`mcp__my-cc-ui__session_interrupt` 的别名本身含 `-`，别名与工具名之间只有一个 `__`；用「名字 ∈ 注册表」判断，而不是对别名做任何假设。
- `session_cancel_queued` 属于阶段 6（GOAL-022），本任务不注册它；GOAL-022 把它加入注册表后守卫自动覆盖——这正是 (d) 的注册表驱动读数要证明的性质。
- 边界 lint 会拦新增测试文件（内存 `quay-boundaries-lint-blocks-new-test-files`）；本判据文件已列入 `## Touches`。给 mcp-gateway barrel 加导出后，若某兄弟测试对该 barrel 整体 `vi.mock`，需把新导出补进那个 mock 工厂（内存 `adding-an-export-reds-sibling-wholesale-vimocks`）。

## 完成记录

- AC1 红态基线（改动前）：AC-252 存在性闸命令退出码 1，逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-self-target.test.ts`。
- AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-self-target.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-self-target.test.ts` 退出 0，读数 `ℹ tests 6 / ℹ pass 6 / ℹ fail 0`（六个 `✔` 全绿）。
- AC3 (a) 自指一律拒：phase='tool'，三个触发名 `mcp__cloudcli__session_send` / `mcp__my-cc-ui__session_interrupt` / `mcp__x__session_close`（别名任意）× 四个受保护操作 `session_send` / `session_interrupt` / `session_close` / `session_cancel_queued` 共 12 组全部 `SELF_TARGET`；控制服务 spy `send`/`abort`/`cancelQueued` 与宿主服务 spy `start`/`close` 计数全 0（判据逐字输出 `spiesAfter={"send":0,"abort":0,"cancelQueued":0,"start":0,"close":0}`）。
- AC4 (b) 放行 + 正例对照：触发名 `Bash` / `mcp__other__list_files` / `mcp__x__session_read` 均放行；经真实 HTTP `session_send` 成功且控制服务 `send` 计数恰好 +1（守卫不是「一律拒绝」）。
- AC5 (c) 残留工具名 + 非 tool 阶段放行：工具名残留 `mcp__x__session_close`，phase ∈ {`thinking`,`writing`,`idle`,`awaitingPermission`,`compacting`} 五者全部 `blocked:false`；HTTP `session_send` 使 `send` 计数 +1。
- AC6 (d) 写工具名集合取自注册表：基础注册表（`MCP_STAGE4_WRITE_TOOLS`）下 `mcp__x__session_reconfigure` 放行；加入 `session_reconfigure` 的扩展注册表下被拦为 `SELF_TARGET`（新写工具无需改守卫即被覆盖）。
- AC7 (e) 读工具不受影响：目标自身处于 phase='tool' 且工具名为网关写工具时，`session_read` 经 HTTP 成功、`code=null`、五个 spy 计数不变（判据逐字输出 `readTool=session_read isError=false code=null ... spyBefore == spyAfter`）。
- AC8 三条取假形态（先提交实现 980fe05c 再变异，逐条记录变异 diff、逐字失败行、恢复命令；恢复后重跑均 6/6 绿，三次变异后 `git status --porcelain` 为空）：
  - (i) 只按 `^mcp__cloudcli__` 前缀判断：在 `isSelfTargetTurn` 内插入 `if (!toolName.startsWith('mcp__cloudcli__')) return { blocked: false, suffix: null, reason: '不是 cloudcli 前缀，放行。' };` ⇒ 红，读数 `tests 6 / pass 4 / fail 2`，逐字失败行 `AssertionError [ERR_ASSERTION]: session_send against mcp__my-cc-ui__session_interrupt must be refused (text={"runId":"ac252-run","queued":false,"queuedMessageUuid":null,"source":"mcp"})`；恢复命令 `git checkout -- server/modules/mcp-gateway/mcp-self-target.ts`。
  - (ii) 手写第二份名单：以 `const LOCAL_WRITE_TOOL_NAMES = ['session_send','session_interrupt','session_close'];` 取代注入的 `writeToolNames.includes(split.name)` ⇒ 红，读数 `tests 6 / pass 5 / fail 1`，逐字失败行 `AssertionError [ERR_ASSERTION]: adding session_reconfigure to the registry must widen the guard`；恢复命令同上。
  - (iii) 不看 phase、只看 `toolName`：删除 `if (turn.phase !== 'tool') { ... }` 放行分支 ⇒ 红，读数 `tests 6 / pass 5 / fail 1`，逐字失败行 `AssertionError [ERR_ASSERTION]: the residual name on phase thinking must not read as a self-target`；恢复命令同上。
- AC9 不回归与仓库门：`npm run typecheck` 退出 0（`tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 三环全过）；`npm run lint` 退出 0 且 `grep -c ": error "` = 0（仅既有无关 warning）。四个兄弟判据不改一字且全绿：`mcp-session-send` 7/7、`mcp-session-lifecycle` 7/7、`mcp-session-host-control` 6/6、`mcp-read-tools` 6/6。
- AC10 `git diff --stat develop...HEAD`（merge-base = develop `3c76d1c3`）：`5 files changed, 964 insertions(+), 10 deletions(-)`；`--name-status`：`M server/modules/mcp-gateway/index.ts`、`M server/modules/mcp-gateway/mcp-gateway.transport.ts`、`M server/modules/mcp-gateway/mcp-gateway.write-tools.ts`、`A server/modules/mcp-gateway/mcp-self-target.ts (new)`、`A server/modules/mcp-gateway/tests/mcp-self-target.test.ts (new)`；与 `## Touches` 逐条对齐（`tasks/gap-ac252-mcp-self-target-guard.md` 由 task_write 提交、落在 delta 之外，声明在 Touches 中不冲突）。