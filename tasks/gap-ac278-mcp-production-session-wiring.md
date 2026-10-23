---
id: gap-ac278-mcp-production-session-wiring
title: AC-278 生产装配接线：server/index.ts 的 createMcpGatewayModule 交出 sessionCreate /
  sessionInterrupt / sessionHostControl，四个会话写工具在真装配下不再回
  MCP_TOOL_NOT_IMPLEMENTED；判据
  server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-278
---
## Proposal

**交付物：把 AC-250 与 AC-251 已经实现、但从未接进生产装配的三个 deps 交给网关。**

现状（本轮实测，读数不是推断）：

- `server/index.ts:600` 的 `createMcpGatewayModule({ … writeTools: { runGet, selection } … })` 只交两件；`sessionCreate` / `sessionInterrupt` / `sessionHostControl` 一件没交。
- 三者都是 `McpWriteToolDeps` 的 optional 成员（`server/modules/mcp-gateway/mcp-gateway.write-tools.ts:140/146/157`）；未交时 `registerMcpWriteTools` 落到 `notImplemented(name, PLACEHOLDER_OWNER[name])`（同文件 :356），`PLACEHOLDER_OWNER` 里 `session_create` 与 `session_interrupt` 逐字为 `AC-250`，`session_start` 与 `session_close` 逐字为 `AC-251`。
- `git log -S "sessionCreate" -- server/index.ts` 为空 —— 从未接上过，不是回归。
- 传输层是通的：`mcp-gateway.transport.ts:95-96` 与 `:336-342` 已声明这三个成员会到达 `registerMcpWriteTools`；只差顶层装配把它们交出来。

**为什么是缺口（这一面谁都没判过）。** AC-250 与 AC-251 都已 done，判据分别是 `tests/mcp-session-lifecycle.test.ts` 与 `tests/mcp-session-host-control.test.ts`，两者都在测试里**自己注入 deps**，于是「生产装配到底交没交」没有任何 AC 读。AC-253 确实解析 `server/index.ts` 的语法树，但它只读 `createChatControlService` 的单例与 barrel 消费者，不读 `writeTools` 的成员。GOAL-020 退出条件 8 原先逐字写「三条各自直接覆盖」，对生产装配不成立。

**影响面（本条为什么值得单独立案）。** 四个工具在生产上全部回占位错误，直接卡住：AC-256（要 `session_interrupt` 的真读数，已因此停在 needs-human）、AC-276（要 `session_create` 与常驻工具），以及传递依赖它们的 AC-257 / AC-269 / AC-270 / AC-277。看板当前 5 条 todo 加 1 条 needs-human 全部堵在这一处。

**这条是什么、不是什么。** 它是**装配任务**：只改 `server/index.ts` 的 `createMcpGatewayModule` 调用点，交出三个 deps，并补一条读**生产装配面**的判据。它**不**改 `session_create` / `session_interrupt` / `session_start` / `session_close` 的 handler 行为（那些由 AC-250/AC-251 交付且已绿），不改传输层注册缝，不改任何 MCP 工具语义。

<!-- dedup-ref --> 机制上去重已核对：`grep -rl "goal_ac: AC-278" tasks/` 为空；`grep -rln "sessionHostControl" tasks/` 只命中 AC-250/AC-251 自身的交付描述与 AC-256 的 needs-human 诊断段，无任何任务认领「把这三件接进 `server/index.ts`」。相关但不同：AC-250（`gap-ac250-session-create-interrupt-lifecycle`）交付 handler 行为，其 Touches 不含 `server/index.ts`；AC-251（`gap-ac251-mcp-session-host-control`）同理；AC-253（`gap-ac253-gateway-shares-single-control-service`）含 `server/index.ts` 但只做「单控制服务实例」那一层。

**非目标**：MCP 工具行为（AC-249–AC-251 已交付）；OAuth、动态客户端注册、公网暴露（GOAL-021）；常驻专有工具与审批（GOAL-022）；`scripts/mcp-smoke.mjs` 与其记录（AC-256）；对生产 3001 做任何事（不连接、不启用、不重启）。

## Plan

1. **读真面，不按规划文字猜。** 读 `server/index.ts` 里 `chatControl`、`sessionsService`、`sessionHostManager` 当下绑定的实例，以及 WebSocket 路径与 scheduled-messages 路径用的是哪一批标识符；逐个读 `McpSessionCreateDeps` / `McpSessionInterruptDeps` / `McpSessionHostDeps` 的成员（`server/modules/mcp-gateway/mcp-session-*.ts`）；读 `mcp-gateway.transport.ts` 这三个成员如何被转交。缺面时**点名拒绝**。
2. 在 `server/index.ts` 的 `writeTools` 成员上补 `sessionCreate` / `sessionInterrupt` / `sessionHostControl`，绑到与 WebSocket 与 scheduled-messages 路径**同一个**实例（`chatControl` 已在同作用域；`sessionHostManager`、`sessionsService` 同理）。若三个 deps 的构造较长，提成同文件内的具名函数；若判据的运行时面要求它可导入，则提成**可导出的具名构造器**——这是本条允许的实现动作。
3. 写判据 `server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts`（红先行）：(a) 静态面——解析 `server/index.ts` 语法树，断言 `createMcpGatewayModule(` 实参对象的 `writeTools` 成员同时含三项且绑定到同一批单例；带正例对照（对删掉一项的合成源码，同一扫描器必须判出）。(b) 运行时面——经生产装配同一份构造路径得到写工具注册，逐个调用四个工具名，断言 `code !== 'MCP_TOOL_NOT_IMPLEMENTED'`；不存在的目标应得解析门拒绝。(c) 负控制——不交这三项时同一探针必须拿到 `MCP_TOOL_NOT_IMPLEMENTED` 且 `owner` 逐字为 `AC-250` 或 `AC-251`。
4. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令，恢复后重跑确认回绿）：(i) 从 `server/index.ts` 删掉 `writeTools.sessionCreate` ⇒ (a) 必须红；(ii) 交上 deps 但让网关内部另造一个实例 ⇒ (b) 必须红。
5. `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts` 绿；`npx oxlint` 对新/改文件退出 0；写法照 AC-253 的 `tests/mcp-gateway-wiring.test.ts` 的语法树解析做法。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 AC-278 判据命令（完整文本见 goals/AC-278-*.md 的 criterion），存在性闸退出码 **1** 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts`；并记录 `grep -c 'sessionCreate\|sessionInterrupt\|sessionHostControl' server/index.ts` 为 **0**。写下完整命令与完整输出。
- [x] AC2 判据绿：逐字命令退出 **0**，写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 生产装配交了三个 deps（静态面）：逐字打印 `server/index.ts` 的 `createMcpGatewayModule` 实参里 `writeTools` 的三个成员名与其绑定标识符，并证明与 WebSocket 与 scheduled-messages 路径是同一批单例；正例对照逐字打印（合成源码删掉 `sessionInterrupt` 后同一扫描器判出缺失）。
- [x] AC4 四个工具不再是占位（运行时面）：`session_create`、`session_interrupt`、`session_start`、`session_close` 逐个调用，逐字打印返回的 `code`，四条都 **≠** `MCP_TOOL_NOT_IMPLEMENTED`。
- [x] AC5 负控制有分辨力：不交这三项 deps 时同一探针拿到 `MCP_TOOL_NOT_IMPLEMENTED`，逐字打印 `owner`（`AC-250` 或 `AC-251`）——证明该探针能把「接上了」与「没接上」分开，不是恒真。
- [x] AC6 取假形态 (i)：从 `server/index.ts` 删掉 `writeTools.sessionCreate` ⇒ 判据退出**非 0**，逐字记录失败行；登记变异 diff 与恢复命令；恢复后重跑回绿。
- [x] AC7 取假形态 (ii)：交上 deps 但让网关内部另造一个实例 ⇒ (b) 的同一实例断言红，逐字记录失败行；登记变异 diff 与恢复命令；恢复后重跑回绿。
- [x] AC8 只动 Touches：`git diff --stat develop...HEAD` 与 Touches 逐条对齐（新增文件用 ASCII ` (new)` 标注）；四个工具的 handler 行为与传输层注册缝一行未改。
- [x] AC9 契约面：`npx oxlint` 对新/改文件退出 **0**；若提取了具名构造器，其新文件已在 Touches 里。

## DoD

- 判据命令退出 0，且判据读的是**生产装配面**（真解析 `server/index.ts`，并经与它同一份 deps 构造路径），**不是**测试里另拼的一套——那正是本条要堵的洞。
- 真落地判据（不是「AC 全勾」）：在生产装配的同一份构造路径上，四个会话写工具 `session_create` / `session_interrupt` / `session_start` / `session_close` 逐个调用都拿到**真 handler** 的答复（对不存在的目标是解析门拒绝），没有一个回 `MCP_TOOL_NOT_IMPLEMENTED`；且负控制证明缺 deps 时同一探针确实拿到占位错误。
- 两次取假形态都先红后恢复；变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 四个工具的 handler 行为与传输层注册缝一行未改；产品代码改动限于 `server/index.ts`（及判据允许的具名构造器提取）。
- AC-256 与 AC-276 的冒烟脚本与记录文件不在本 diff；对生产 3001 全程未连接、未启用、未重启。

- 该轴仍暗，理由：本任务只做装配接线与取证，不新增可测量的架构面（无新模块、无新依赖、无跨模块边），故不记 L_D/L_G 读数。

## Touches

- server/index.ts（在 createMcpGatewayModule 的 writeTools 上补 sessionCreate / sessionInterrupt / sessionHostControl）
- server/modules/mcp-gateway/mcp-session-write-deps.ts (new)（可导出的具名构造器：session_create / session_interrupt 两个 deps 的生产装配，供 server/index.ts 与判据走同一份构造路径）
- server/modules/mcp-gateway/index.ts（导出上面两个构造器）
- server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts (new)（判据：静态面 + 运行时面 + 负控制）
- tasks/gap-ac278-mcp-production-session-wiring.md（自触）

## Notes

- 后端改动，按 AGENTS.md 先加载 `$backend-module-standards` 再动手。
- 这三个 deps 是 optional 是**有意的**（AC-249 的注册缝要跨 AC 稳定，先注册占位再被后续任务替换）；本条**不改** optional 性，只交实例。
- **不要在测试里自己拼一套 deps 就算过**——那正是本条要堵的洞：那样写出来的判据在改动前也是绿的，属于假绿。判据必须读生产装配面。
- 判别器是 `code`：真 handler 对不存在的目标回解析门拒绝（AC-246 的通用解析门），占位回 `MCP_TOOL_NOT_IMPLEMENTED`；两者 `code` 不同，正是 (b) 与 (c) 的分离点。
- 若提取具名构造器新增了文件，**先**用 `task_write` 把它加进 Touches 再写（内存 `quay-touches-must-match-actual-write-sites`）。
- 语法树解析照 AC-253 的 `server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts`，不新造解析器。
