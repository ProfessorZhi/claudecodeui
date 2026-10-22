---
id: gap-mcp-resolve-deps-production-wiring
title: MCP project/session 参数解析统一：把已实现的 resolveMcpTarget/resolveInputTargets
  接入生产 server/index.ts，并修正 overview 声明 project 却忽略的问题
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Finding（2026-10-07 只读调查，由用户报告 `sessions_list({project:"claudecodeui"})` 返回 `Project not found` 触发）。

现状（已读代码核实）：
- `server/modules/mcp-gateway/mcp-resolve-target.ts` 的 `resolveMcpTarget`/`resolveInputTargets`（AC-246，任务 `gap-ac246-mcp-resolve-target-fuzzy-match`，状态 done）完整实现了「精确 id 优先 → 标题子串唯一匹配 → 多义列候选 → 无命中报错」的解析器，且该任务自己的判据（`server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`）用真实数据库 + 真实 MCP SDK Client 在**判据自己构造的测试挂载**上证明过它能工作（包括该判据 (g) 读数：`sessions_list project="Active Project"` 能用名字片段解析成功）。
- `mcp-gateway.transport.ts` 的模块文档明确：「The gate is applied only when `McpGatewayDeps.resolveDeps` was supplied — an unwired mount keeps AC-240/244/245's exact behaviour」（`const guarded = resolveDeps === undefined ? handle : resolveInputTargets(handle, resolveDeps)`）。
- 对**生产composition root** `server/index.ts` 全文 `grep resolveDeps` **零匹配**——生产装配 `createMcpGatewayModule({...})` 从未构造或传入 `resolveDeps`。因此解析门在生产环境从未生效（本次调查时验证，HEAD `f8ceca9a`）。
- 因此 `sessions_list` 的 `project` 参数原样传给 `getProjectSessionsPage(projectId)` → `projectsDb.getProjectById(projectId)` 的严格精确查找，传名字一律报 `PROJECT_NOT_FOUND`；`quay_snapshot` 的 `buildQuaySnapshot` 同样用 `row.projectId === project` 精确比对，传名字一样报错。
- `overview` 的 `inputSchema` 声明了 `project: z.string().optional()`，但 `mcp-overview-tools.ts` 的 `registerMcpOverviewTools` 注册时写的是 `handler: () => buildOverview(deps)`——**完全不读这个参数**。`buildOverview` 内部确有一个 `projectNameById` 映射，但那是把 id 翻译成显示名用于**输出**展示，方向与「把输入的名字解析成 id」相反。也就是说 `overview` 的 `project` 参数目前是一个声明了但从未生效的死参数，不是「它能解析名字」。
- 结论：三个工具（`sessions_list`/`quay_snapshot`/`overview`）在「名字→id」这件事上目前一致地都不解析，只是表现不同——`overview` 静默忽略参数（看起来"能用"是因为参数被无视），另两个严格拒绝。这本身也是一层不一致（同名参数，一个静默忽略、两个严格拒绝），需要在修复时一并决定统一行为。

要交付：

1. **生产装配**：在 `server/index.ts` 构造 `resolveDeps`（读活跃 project 列表与活跃 session 列表，取 id 与展示名/标题），传给 `createMcpGatewayModule({...})`。这件事本身在 `mcp-gateway.transport.ts` 的注册缝里是「有就包一层 `resolveInputTargets`，没有就保持原行为」的无侵入开关，预期不需要改该文件；但要逐个核对 AC-246/AC-278/AC-284 等既有 criterion 文件里"目标不明 → `PROJECT_NOT_FOUND`"之类的既有断言是否假设了"未接线"状态——若有，这些断言需要在本任务里连带确认仍然成立（因为 `resolveDeps` 打开后，**精确 id** 的既有调用方式行为不变，只有"传一个不是 id 但唯一匹配标题子串的字符串"这种之前必然报错的调用才会变成成功解析；纯按 id 调用的既有判据应不受影响）。
2. **决定并修 `overview` 的 `project` 参数**：在本任务里明确裁定——要么 (a) 让 `overview` 的 `project` 参数真正生效（经同一套解析门解析后只返回该项目范围内的概览），要么 (b) 如果 `overview` 按设计就应该是全局概览、`project` 参数本来就是历史遗留的误加字段，则从 `inputSchema` 移除该参数并在 changelog/commit 里说明。两个选项选哪个需要在本任务执行时结合 `overview` 现有输出结构（它是否天然是跨项目聚合）判断，不能两者都不做（「声明了却忽略」不能保留为最终状态）。
3. 所有改动遵守 `$backend-module-standards`；不改变任何**纯按 id** 调用路径的既有行为（回归红线）。

<!-- dedup-ref -->机制上去重已核对：`task_list search="resolveDeps"` 只命中已 done 的 `gap-ac246-mcp-resolve-target-fuzzy-match`（交付解析器本体与判据自建挂载上的验证，不包含生产 `server/index.ts` 的接线——其 Touches 列表里没有 `server/index.ts`），是**消费**关系而非重复：本任务复用它导出的 `resolveMcpTarget`/`resolveInputTargets`，只补生产装配这一步，并额外处理 `overview` 的死参数问题（AC-246 范围完全没有涉及 `overview`）。`task_list search="overview project"` 为空，无重复。

## AC

- [x] `grep -n "resolveDeps" server/index.ts` 改动前为空、改动后有命中（证明从「零接线」变为「已接线」）。
- [x] 回归：现有 `server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`、`mcp-production-session-wiring.test.ts`、`mcp-read-tools.test.ts` 逐文件 `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test <file>` 均退出码 0（确认生产接线不破坏既有判据）。
- [x] 新增或扩展判据断言：用一个**生产同款装配**（不是判据自建的简化挂载）证明 `sessions_list({ project: <display name 子串> })` 能解析成功并返回该项目的 session；再证明传一个**多义**的名字片段返回候选列表而不是猜一个；传一个**精确 project id** 行为与改动前完全一致。
- [x] `grep -n "handler: () => buildOverview(deps)" server/modules/mcp-gateway/mcp-overview-tools.ts` 的结果与第 2 条「要交付」的裁定一致：若选 (a)，该行应变为读取并使用 `args.project`；若选 (b)，`overview` 的 `inputSchema` 中不再出现 `project` 字段（`grep -n "project" server/modules/mcp-gateway/mcp-overview-tools.ts` 的 `inputSchema` 定义处应为空命中）。裁定结果与理由写入本任务 `## Notes`。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 的 `: error ` 计数为 0。

## DoD

在真实运行的服务上实际操作一次：用 PAT 经 `/mcp` 调 `projects_list` 拿到某项目的 `name`，再把这个 `name`（不是 id）传给 `sessions_list` 的 `project` 参数，确认不再报 `Project not found` 而是返回该项目的会话列表；再用一个会匹配多个项目名的片段调用，确认返回候选列表而不是报错或乱猜。仅有测试夹具通过不算完成。

## Touches

- server/index.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- tasks/gap-mcp-resolve-deps-production-wiring.md

## Notes

这是一次跨工具的生产行为变更（影响所有带 `project`/`session` 字符串参数的读/写工具，因为 `resolveInputTargets` 是通用网关层解析门，不是单个工具各写一遍），执行时要通读 `mcp-resolve-target.ts` 消费清单里列出的全部消费方（AC-245 的读工具、AC-249–AC-251 的写工具），确认没有一个工具的既有判据偷偷假设了"目标解析永远失败"之类的前提。

### 第 2 条裁定：(a) 让 `overview` 的 `project` 参数真正生效，理由如下

`overview` 的工具描述是 "Project overview"，其输出结构本身就是按项目聚合的（`quay` 每项带 `projectId`，`running`/`hosts`/`awaitingPermission`/`aborted` 每项都能解析出所属 project），所以 `project` 不是「历史遗留的误加字段」，而是「把这份项目级概览限定到某个项目」的自然参数；选 (b) 删字段会丢掉一个合理能力，且必须改 `inputSchema` 定义处（`mcp-gateway.read-tools.ts` 的 `TOOL_BODIES`，不在本任务 Touches 内，会造成越界）。裁定为 (a)：注册行由 `handler: () => buildOverview(deps)` 改为 `handler: (args) => buildOverview(deps, readOverviewProjectArgument(args))`；`buildOverview(deps, projectId?)` 把 `running`/`awaitingPermission`/`aborted`/`hosts`/`quay` 五个列表全部按该项目过滤；给了 `project` 但不是任何已登记 project id 时抛 `PROJECT_NOT_FOUND`（而不是返回一份空的成功读数——空读数会被误读成「这个项目很安静」）；不给 `project` 时行为与改动前逐字一致。

AC4 的 grep 印证：`grep -n "handler: () => buildOverview(deps)"` 现为**空命中**（旧行已不存在），新行为第 530 行 `handler: (args) => buildOverview(deps, readOverviewProjectArgument(args))`。

### 生产接线（第 1 条）要点

`server/index.ts` 在 `createMcpGatewayModule({...})` 内新增 `resolveDeps`，两列表都用**同步**读、且只含**活跃**行：projects 用 `projectsDb.getProjectPaths()`（`isArchived=0`），sessions 用 `sessionsDb.getAllSessions()`（全部非归档 session，而非 recents 分页），所以一次门调用是一次索引 SELECT，且一个「合法但排在 recents 第一页之后」的 session id 仍能按精确 id 解析，不会被分页误拒。project 的 title 与 `projects_list` 报的 `name` 同源（`custom_project_name?.trim() || basename(project_path)`）。

### DoD 真实服务读数（2026-10-07）

起**真** `server/index.ts`（`node <tsx-cli> --tsconfig server/tsconfig.json server/index.ts`，临时 `DATABASE_PATH` + `HOME`，`HOST=127.0.0.1`，`SERVER_PORT` 由 `listen(0)` 探得，`MCP_ENABLED=true`，`PUBLIC_BASE_URL=http://127.0.0.1:<port>`，`CLAUDE_SESSION_SCOPE_SWEEP=off`），向该临时库播种一个 `ccp_` 前缀、带全部 scope 的真 PAT，再用真 MCP SDK `Client` 经 `/mcp` 驱动（`projects_list` → 取 `name` → 传给 `sessions_list`）：

- `projects_list` isError=false，读出 `name="dod-prod-alpha"`、`id="5bde72b9-af83-4abc-bf49-f38657181f6b"`；
- 把该 **name**（不是 id）传给 `sessions_list({project:"dod-prod-alpha"})` → isError=false，`{"sessions":[{"id":"dod-alpha-session","title":"DOD alpha session","provider":"claude","projectId":"5bde72b9-…","lifecycleMode":"per-run","hostState":null,"running":false,…}],"total":1}`——**不再报 `Project not found`**；
- 传多义片段 `"dod-prod"` → isError=true，`code=TARGET_AMBIGUOUS`，`details.candidates` 同时列出 `dod-prod-alpha` 与 `dod-prod-beta`，不猜；
- 传精确 id → 与 name 路径**逐字相同**的读数（`total:1`，同一条 session）。

探针为一次性脚本（不属 Touches），跑完即删，未留在仓库。

### 回归读数

AC2 逐文件：mcp-resolve-target 7/7、mcp-production-session-wiring 5/5、mcp-read-tools 7/7，均 EXIT=0。另跑整目录 `server/modules/mcp-gateway/tests/*.test.ts`（--test-concurrency=4）213/213 全绿。AC5：`npm run typecheck` 退出码 0；`npm run lint` 的 `: error ` 计数为 0。
