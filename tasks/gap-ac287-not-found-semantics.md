---
id: gap-ac287-not-found-semantics
title: MCP「引用不存在即错误」语义（AC-287）：approval_answer/session_cancel_queued/run_get/quay_snapshot
  的找不到改为 APPROVAL_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND / RUN_NOT_FOUND /
  PROJECT_NOT_FOUND，真实状态（已开始执行、已完成、无 quay 配置）仍是成功结果
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac284-mcp-error-envelope
goal_ac: AC-287
---
## Proposal

**目标 AC**：`goals/AC-287-引用不存在是错误-不是看似成功的结果-approval-answer-session-cancel-queued-run.md`，goal GOAL-024（退出条件 4）。判据文件固定为 `server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts`，判据命令（带存在性闸）：

```
for f in server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts
```

当前必红：判据文件不存在，存在性闸以退出码 1 打印 `缺判据文件：server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts`。

**约定（本 AC 的判定原则）**：结果（成功）表示「一个存在的实体的状态」；错误表示「引用没有指向任何东西」或请求无效。四个工具的「找不到」目前在成功侧，必须移入错误侧；而「已开始执行 / 已完成 / 无 quay 配置」这类真实状态仍留在成功侧。

**现状（源码核实，非推测）**——四处「找不到当成功」各是一种形态：

1. **(a) `approval_answer`（mcp-approvals.ts）**：`buildApprovalAnswer`（`mcp-approvals.ts:398-429`）对控制服务 `answerApproval` 的失败**不抛出**，返回普通载荷 `{ ok:false, requestId, code:'APPROVAL_EXPIRED_OR_NOT_FOUND', message }`（`:410-417`），于是 `isError` 为 false、`structuredContent` 是 `ok:false` 的「成功结果」。控制服务 `chat-control.service.ts` 的 `answerApproval`（`:809-841`）把「已过期（运行时删了条目）」与「从未存在」**collapse 成同一个 code** `APPROVAL_EXPIRED_OR_NOT_FOUND`（`:813-819`，`findApprovalSession` 只在 pending 集合里找，`:381-392`），无法区分。既有判据 `mcp-approvals.test.ts:583-593` 断言两者 `isError === false` 且文案都含 `已过期或不存在`。
2. **(b) `session_cancel_queued`（mcp-session-cancel-queued.ts）**：`buildSessionCancelQueued`（`:139-166`）把控制服务的 `unknown` 当作**成功** outcome 返回（`:159`），`SessionCancelQueuedOutcome = 'cancelled' | 'already-started' | 'unknown'`（`:67`）；outputSchema 是 `outcome: z.string()`（`:210-215`），不是枚举。控制服务 `cancelQueued`（`chat-control.service.ts:584-603`）对「会话不存在 / 提供方没这个 uuid」返回 `'unknown'`；调试驱动 `debug-agent.host-driver.ts` 的 `cancelQueuedInput`（`:624-631`）对**已被 `readOldestQueuedCommand`（`:649-654`）取走**的 uuid 也返回 `'unknown'`（注释见 `:224-225`、`:607-608`），把「已开始执行」折进「从未见过」——而 `server/shared/types.ts:2772-2783` 的 `HostQueuedInputCancelResult` 文档明写 `unknown` 是「没有活跃进程 / 从未 push 过」，且「deliberately not folded into already-started」。既有判据 `mcp-cancel-queued.test.ts:577-578`（已取走读 `unknown` 且 `isError:false`）、`:622-624`（从未见过/跨会话都读 `unknown` 且 `isError:false`）；`debug-agent/tests/debug-agent-control-queue.test.ts`(d)（`:571`）钉住「已出队读 `unknown`」。
3. **(c) `run_get`（mcp-run-get.ts）**：`buildMiss`（`:257-281`）产 `McpRunGetMiss`（`:160-169`）—— `status:'unknown'`、`reason`、`explanation`、`fallback`，作为**成功载荷**返回（`RunGetPayload = McpRunGetHit | McpRunGetMiss`，`:171-172`；`buildRunGet`：`:300-340`）。reason 取值 `'expired' | 'unknown' | 'restarted'`（`:75`），与 AC 要的 `expired | never_issued` 不同名。既有判据 `mcp-run-get.test.ts:536-538`（expired/unknown `isError === false`）、`:576-579`（restarted `isError === false`）全钉在成功侧。restarted 由 `isRestarted`（`:342-346`）判定，跨 boot 的 run 记录仍在但不可用。
4. **(d) `quay_snapshot`（mcp-overview-tools.ts）**：`buildQuaySnapshot`（`:357-377`）**只有** `deps.quay.hasQuayConfig(project)` 一个判据：为 false 一律返回 `{ hasQuayConfig:false, status:'no-quay-config', note:NO_QUAY_NOTE }`（`:362-364`）——项目**不存在**与项目**存在但没有 quay 配置**走同一条分支，混为一谈。项目存在性的真值来源是继承来的 `McpReadToolDeps.projects`（`mcp-gateway.read-tools.ts:126-141` 的 `getProjectsWithSessions` / `getProjectSessionsPage`），当前 `buildQuaySnapshot` 根本没读它。既有判据 `mcp-overview.test.ts:627-631` 断言 no-quay 项目 `isError === false`。
5. **(e) 真实状态目前在成功侧**：run_get 命中（`status:'completed'`/`'running'`，`mcp-run-get.ts:204-245`）、`session_cancel_queued` 的已开始执行、`quay_snapshot` 的存在项目无配置——这些**必须**保持成功，不得被误改成错误。

**要求（判据文件 `tests/mcp-not-found-semantics.test.ts` 是唯一验收界面）**：

1. **(a)** `approval_answer` 对不存在或已过期的 `requestId` 返回**错误** `isError:true`、`structuredContent.code === 'APPROVAL_NOT_FOUND'`；`details.reason` 区分「已过期」与「从未存在」（`'expired'` vs `'never_issued'`；曾被持有但已不可决策者——超时被删或已决策——归 `expired`；无任何痕迹者归 `never_issued`）。不再是 `ok:false` 的成功结果。这要求控制服务把区分**透出**：`chat-control.service.ts` 的 `AnswerApprovalResult` 增加 reason，`provider-runtime.service.ts` 暴露一个「该 requestId 是否曾被持有」的读取（经 `permissions` 接口，由 `claude-runtime.provider.ts` 的注册表实现——目前 `pendingToolApprovals`（`:114`）在 `cleanup()`（`:240-242`）里删除后不留痕），`mcp-approvals.ts` 把 `ok:false` 映射成信封错误。
2. **(b)** `session_cancel_queued` 对**从未见过**的 uuid 返回错误 `QUEUED_MESSAGE_NOT_FOUND`；对「消息已被取出开始执行」仍是**成功**结果，`outcome` 为枚举 `'cancelled' | 'already-started'`（`'unknown'` 退出成功枚举），且该枚举写进注册的 `outputSchema`（判据从真实 `tools/list` 读回）。为此调试驱动 `debug-agent.host-driver.ts` 必须不再把「已出队的 uuid」折进 `unknown`：记录被 `readOldestQueuedCommand` 取走的 uuid，`cancelQueuedInput` 对其返回 `'already-started'`（与真实 Claude 驱动 `claude-host-driver.provider.ts:2702` 的 `dequeued ? 'already-started' : 'unknown'` 一致），`unknown` 只留给「从未 push / 无活跃进程」。**这会使 AC-238 的判据 `debug-agent/tests/debug-agent-control-queue.test.ts`(d) 从 `'unknown'` 迁到 `'already-started'`**（该断言的意图「不是 withdrawn」不变，且更精确），必须逐条记录旧→新并保持/提升断言强度。
3. **(c)** `run_get` 对未知或过期的 `runId` 返回错误 `RUN_NOT_FOUND`；`details.reason ∈ {'expired','never_issued'}`（`'expired'` 覆盖保留期过期，`'never_issued'` 覆盖从未发出的 id）；`details` 带回退读取到的最近消息（原 `fallback.messages`，逐字保留）。跨 boot 的 `restarted`（AC 未点名）也归入错误侧（引用不再指向本进程存在的 run），`details.reason` 取 `'expired'`，回退消息保留——该归属在任务记录里写明理由。
4. **(d)** `quay_snapshot`：对**不存在**的项目返回错误 `PROJECT_NOT_FOUND`（2026-10-07 订正：本条原写 `TARGET_NOT_FOUND`，该名已被同族已达成判据 AC-284/AC-285 退役，理由见文末「Resolution」；语义未变）（存在性经 `deps.projects` 读取，不能用 `hasQuayConfig` 代替）；对**存在但没有 quay 配置**的项目仍返回**成功**结果，`status: 'no_quay_config'`（AC 的规定字面量；现状源码写作 `'no-quay-config'`，见 `mcp-overview-tools.ts:161/291/325/363`）。两种情况不再混为一谈。
5. **(e) 不变式**：成功的真实状态一律仍是成功——run_get 命中（`status:'completed'`/`'running'`）`isError:false`；`session_cancel_queued` 的 `'already-started'` `isError:false`；`quay_snapshot` 的存在项目无配置 `isError:false`。不得把 (e) 误改。
6. **既有判据移植**：凡断言旧形状的既有 MCP 判据（见 `## Touches` 测试清单）只许迁移到新形状、断言强度不降，不许删除或放宽；任务记录里逐条列旧→新。
7. **计数 pin 同步**：新增一个 `server/**/*.test.ts` 会让 `server/shared/tests/quay-test-script.test.ts` 的两处 `known/unknown` pin 变红。不要照抄任何写死数字，实现时先跑 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 取当时实际总数 N（我落案时读数为 237），按 pin 的两条构造式写入：`known=3 unknown=N-3`（`:154`）与 `known=1 unknown=N-1`（`:203`）。

**取假形态（先提交实现再变异，逐条记录 mutation diff、逐字失败行与恢复命令）**：(i) 让 `approval_answer` 的不存在仍回 `ok:false` 成功 ⇒ (a) 必须红；(ii) 把「已开始执行」改成错误 ⇒ (e) 必须红；(iii) `quay_snapshot` 把不存在的项目当作无配置 ⇒ (d) 必须红。三条缺一不可。

**红先行**：先提交判据文件（此时文件不存在 ⇒ 存在性闸以退出码 1 输出缺失文件名），再实现，记录实现后退出码 0。

<!-- dedup-ref -->
**关系与范围**：本任务消费 AC-284（`gap-ac284-mcp-error-envelope`）交付的信封与 `MCP_ERROR_CODES`（其 Plan 已列 APPROVAL_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND / RUN_NOT_FOUND / PROJECT_NOT_FOUND——末项为 2026-10-07 订正后的规范名），关系边由本任务顶层 `depends_on` 字段声明；开工时先读 `server/modules/mcp-gateway/mcp-error-envelope.ts` 是否存在，缺失就停手报告。**范围外（兄弟 AC，避免重复实现）**：信封形状本身 / 同类同 code / 注册表驱动探针表 = AC-284；code 词表唯一来源与每工具声明 = AC-285；`INSUFFICIENT_SCOPE` + `details.requiredScopes` + denied 审计 = AC-286；`INVALID_ARGUMENT` 的 `details.fields` 与 `UNKNOWN_TOOL` = AC-288；服务端文案无 CJK 普查 = AC-289；OAuth/HTTP 401 = GOAL-026。本任务只做上述四个工具的「找不到即错误」与 (e) 不变式。

**后端改动遵守 `$backend-module-standards`**（`.agents/skills/backend-module-standards/SKILL.md`）：导出符号带消费方注释、跨模块消费走 barrel（`server/modules/mcp-gateway/index.ts`、`server/modules/providers/index.ts`、`server/modules/websocket/index.ts`），不下沉业务逻辑；prose 里的取值以判据为准。

## Plan

1. **读依赖**：确认 `server/modules/mcp-gateway/mcp-error-envelope.ts` 存在并导出 `MCP_ERROR_CODES`、信封构造器、`toMcpErrorResult`；确认 APPROVAL_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND / RUN_NOT_FOUND / PROJECT_NOT_FOUND 已在词表。
2. **(a) 控制面透出 expired / never_issued**：`claude-runtime.provider.ts` 的权限注册表记录「曾持有过的 requestId」（`waitForToolApproval` 的 `cleanup()` 删除 pending 条目时留一条有界痕迹），并暴露一个读取（如 `classifyMissingApproval(requestId): 'expired' | 'never_issued'`）；`provider-runtime.service.ts` 经 `permissions` 透出；`chat-control.service.ts` 的 `AnswerApprovalResult` 增 `reason` 并在 `findApprovalSession === null` 时给出 `'expired' | 'never_issued'`。**不改** `resolveToolApproval` 语义与 access 检查顺序。
3. **(a) MCP 适配**：`mcp-approvals.ts` 的 `buildApprovalAnswer` 把 `ok:false` 的分支改为**抛出/产出信封错误** `APPROVAL_NOT_FOUND`，`details.reason` 映射自控制面 reason；`FORBIDDEN` 仍走 AC-284 的信封（非同 AC 的 code）。`ApprovalAnswerPayload` 的成功分支形状不变。
4. **(b) 工具映射 + outputSchema 枚举**：`mcp-session-cancel-queued.ts`：`verdict === 'unknown'` ⇒ 信封错误 `QUEUED_MESSAGE_NOT_FOUND`；`'withdrawn'` ⇒ outcome `'cancelled'`（成功）；`'already-started'` ⇒ outcome `'already-started'`（成功）；`'forbidden'` ⇒ 信封。`SessionCancelQueuedOutcome = 'cancelled' | 'already-started'`；`OUTCOME_MESSAGES` 相应收敛；注册的 `outputSchema.outcome` 改为 `z.enum(['cancelled','already-started'])`。
5. **(b) 驱动区分已开始执行**：`debug-agent.host-driver.ts` 记录 `readOldestQueuedCommand` 取走的 uuid（如 `startedByAppSession`），`cancelQueuedInput`：在 queue 中 ⇒ `'withdrawn'`；不在 queue 但在 started 记录 ⇒ `'already-started'`；否则 ⇒ `'unknown'`。同步其模块注释（`:224-225`、`:607-608`）与 `server/shared/types.ts` 的语义（文档本就说 `unknown` 不得与 `already-started` 折叠）。
6. **(c) run_get**：`mcp-run-get.ts`：`buildRunGet` 的 miss 分支（`:302-307`、`:319-324`）改为产**信封错误** `RUN_NOT_FOUND`，`details.reason` = `expired`（保留期过期、以及 restarted）/ `never_issued`（原 `unknown`），`details` 携带原 `fallback` 的 `{ session, messages, note }`；`McpRunGetMiss`/`EXPLANATION_BY_REASON` 的名称与文案相应收敛（保留解释文案强度）。命中路径 `buildHit` 不动。
7. **(d) quay_snapshot 项目存在性**：`mcp-overview-tools.ts` 的 `buildQuaySnapshot` 先经 `deps.projects`（如 `getProjectsWithSessions({ skipSynchronization: true })` 或等价的按 id 读取）判定项目是否存在：不存在 ⇒ 信封错误 `PROJECT_NOT_FOUND`；存在但没有 `.quay/config.yml` ⇒ 成功 `{ hasQuayConfig:false, status:'no_quay_config', note:NO_QUAY_NOTE }`。`overview` 的同类条目可保持现状或一并对齐（不在本 AC 强制）。`McpQuaySnapshotPayload.status` 的取值集合相应更新；若注册的 `outputSchema` 需带 `status`，同步 `mcp-gateway.read-tools.ts` 的 stage-3 表。
8. **barrel**：`index.ts`（及跨模块的 providers/websocket barrel）导出新的读取符号，带消费方注释。
9. **写判据 `tests/mcp-not-found-semantics.test.ts`（红先行）**：真实 express + `mountMcpGateway` + SDK Client + Streamable HTTP（沿用 `mcp-approvals.test.ts` / `mcp-cancel-queued.test.ts` / `mcp-overview.test.ts` 的真 mount 与临时 `DATABASE_PATH`/`HOME` 模式），真签发的令牌，读 (a)(b)(c)(d)(e) 五组读数；`tools/list` 读回 `session_cancel_queued` 的 `outputSchema.properties.outcome.enum`。
10. **移植既有判据**（见 AC 与 Touches），逐条列旧→新。
11. **变异三连** (i)(ii)(iii)，逐条记录 mutation diff、逐字失败行、恢复命令。
12. **同步计数 pin**；跑 `npm run typecheck` / `npm run lint` / `npm run build`。

## AC

- [x] AC1 判据文件 `server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts` 存在，且存在性闸后判据命令退出码 0。任务记录含「实现前该文件不存在、存在性闸以退出码 1 打印 `缺判据文件：…`」与「实现后退出码 0」两段逐字输出（红先行证据）。
- [x] AC2 (a) 真实 HTTP + MCP SDK 客户端调用 `approval_answer`：对**已过期**与**从未存在**的 `requestId` 都断言 `isError === true`、`structuredContent.code === 'APPROVAL_NOT_FOUND'`；两者 `details.reason` 分别为 `'expired'` 与 `'never_issued'`（互不相等）；`details` 键集与码值逐字记录；并断言不存在 `ok:false` 的成功结果（旧形状消失）。写下两条调用的逐字读数。
- [x] AC3 (b) `session_cancel_queued`：(i) 对从未见过的 uuid `isError === true` 且 `code === 'QUEUED_MESSAGE_NOT_FOUND'`；对跨会话的 uuid 同样；(ii) 对**已被取出开始执行**的消息 `isError === false`、`outcome === 'already-started'`；(iii) 从真实 `tools/list` 读回该工具 `outputSchema.properties.outcome.enum`，深等于 `['cancelled','already-started']`（顺序不计，集合相等）。写下三组读数与枚举读数。
- [x] AC4 (c) `run_get`：对保留期过期的 `runId`、从未发出的 `runId`、跨 boot 的 `runId` 三个探针，均断言 `isError === true`、`code === 'RUN_NOT_FOUND'`、`details.reason ∈ {'expired','never_issued'}`；且 `details` 带回退读取到的最近消息（非空、逐字等于 fixture 消息）；命中探针（`status:'completed'` / `'running'`）仍 `isError === false`。写下逐探针读数。
- [x] AC5 (d) `quay_snapshot`：对**不存在**的项目 `isError === true`、`code === 'PROJECT_NOT_FOUND'`；对**存在但无 quay 配置**的项目 `isError === false`、`status === 'no_quay_config'`；对存在且有配置的项目仍 `isError === false`（`status:'cached'|'refreshed'`）。三种情况互不混同；写下三条读数。**（2026-10-07 订正并落勾：本条原写 `TARGET_NOT_FOUND`。该字面量在本仓库已不可满足——同族已达成判据 AC-284 要求在 `server/modules/mcp-gateway/*.ts` 里不出现该名（一类问题一个 code），AC-285 的 `MCP_ERROR_CODES` 键集与其期望集双向深等、亦不含该名。经人 yale 裁定，按本仓唯一规范码 `PROJECT_NOT_FOUND` 对齐，goal AC-287 的 `expect` 同步订正。断言强度未降，语义（引用不存在即错误、与「存在但无配置」不再混同）未变；裁决与证据见文末「Resolution」。）**
- [x] AC6 (e) 不变式：`session_cancel_queued` 的 `already-started` 成功读数（AC3-ii）与 `quay_snapshot` 的 `no_quay_config` 成功读数（AC5）与 `run_get` 命中成功读数（AC4）同时成立——真实状态仍成功，未被误改成错误。
- [x] AC7 取假形态三条先红后恢复，逐条记录 mutation diff、逐字失败行、恢复命令：(i) `approval_answer` 的不存在回 `ok:false` 成功 ⇒ AC2 红；(ii) 把 `already-started` 改成错误 ⇒ AC6 红；(iii) `quay_snapshot` 把不存在项目当作无配置 ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 既有判据移植、强度不降：至少覆盖 `mcp-approvals.test.ts`(d)（`:583-593` 旧 `isError:false` + 文案 `已过期或不存在`）、`mcp-cancel-queued.test.ts`(b)(c)（`:577-578`、`:622-624` 旧 `outcome:'unknown'` 成功）、`mcp-run-get.test.ts`(f)(g)（`:536-538`、`:576-579` 旧 miss 成功）、`mcp-overview.test.ts`(d)（`:627-631` 旧 no-quay 成功，新增不存在项目探针）、`debug-agent/tests/debug-agent-control-queue.test.ts`(d)（`:571` 旧 `verdict:'unknown'` → `'already-started'`）；每条记旧断言→新断言，新断言强度不低于旧，diff 中无删除 `assert`、无放宽为 truthy/skip。`bash scripts/test.sh --for-task gap-ac287-not-found-semantics` 退出码 0。
- [x] AC9 计数 pin 同步：`server/shared/tests/quay-test-script.test.ts` 两处 `known/unknown` 按实现时实际计数写入（先取 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实际 N，再写 `known=3 unknown=N-3` 与 `known=1 unknown=N-1`），`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0。写下 N 的读数与改后的两个 pin 字符串。
- [x] AC10 仓库门：`npm run typecheck` 退出码 0；`npm run lint` 无 `: error `（只看 error 级）；`npm run build` 退出码 0。写明三条命令退出码与 lint error 计数。
- [x] AC11 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 `task_write` 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 一个真实的 MCP 客户端（真 HTTP、SDK client、真签发 access token）对四个工具触发「找不到」时，**实际收到**的是 `isError:true` + `structuredContent.code ∈ {APPROVAL_NOT_FOUND, QUEUED_MESSAGE_NOT_FOUND, RUN_NOT_FOUND, PROJECT_NOT_FOUND}`，不是测试桩里伪造的结构——即新形状经由 `withMcpAudit` 的真实渲染路径到达线上。
- `approval_answer` 的 `details.reason` 真的区分「已过期」与「从未存在」（控制面把区分透出，不是适配器猜测）；`run_get` 的 `details` 真的带回退读取到的最近消息。
- `session_cancel_queued` 的「已开始执行」真的仍是成功结果，且该 `outcome` 枚举真的从真实 `tools/list` 的 `outputSchema` 读得到（不是只在单测里手写一份枚举）。
- `quay_snapshot` 的「项目不存在」与「存在但没有 quay 配置」真的走两条路：前者错误 `PROJECT_NOT_FOUND`，后者成功 `status:'no_quay_config'`；存在性判定读的是项目真值来源，不是 `hasQuayConfig` 的 false。
- 三个取假形态各能让对应读法变红并记录恢复命令，不是「改完仍绿」。
- 既有断言旧形状的判据（含 AC-238 的 `debug-agent-control-queue.test.ts`(d)）是真的迁移到新形状且断言强度不降，不是删除/放宽/改成 `assert.ok(真)`；任务记录里逐条列旧→新。
- 遵守 `$backend-module-standards`：导出符号带消费方注释、跨模块消费走 barrel、仓储/注册表留在原模块、不新增模块级 types/utils 文件，不下沉业务逻辑。
- 同步了测试文件计数 pin，未使全量 suite 因新增一个 `server/**/*.test.ts` 而变红。

## Touches

- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/mcp-gateway/mcp-session-cancel-queued.ts
- server/modules/mcp-gateway/mcp-run-get.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-error-envelope.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/modules/websocket/services/chat-control.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/index.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/modules/providers/index.ts
- server/modules/debug-agent/debug-agent.host-driver.ts
- server/shared/types.ts
- server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts (new)
- server/modules/mcp-gateway/tests/mcp-approvals.test.ts
- server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts
- server/modules/mcp-gateway/tests/mcp-run-get.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/debug-agent/tests/debug-agent-control-queue.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-ac287-not-found-semantics.md (self-touch)

## Change notes (worker)

Commits on `task/gap-ac287-not-found-semantics`: `15530fc0` feat + `39880d99` test-type fixes; then `cc b5e783` merge develop; then `b4d8e752` **merge develop again** (this round), reconciling AC-289's English-only copy with AC-287's not-found semantics, and `4be50767` (the post-merge test migrations + count pin). AC state recorded via `task_write`.

### Post-merge reconciliation (2026-10-07, develop → branch) — READ THIS FIRST

AC-289 (server-authored caller copy is English-only) landed on `develop` **after** AC-287's implementation, so the second merge required the four tools' server-authored sentences to move from CJK to English. The readings the AC2/AC4/AC7 notes below quote are the **pre-merge** branch's CJK bodies; on the merged tree the same envelope fields carry:

| field | pre-merge (branch) | merged (English) |
| --- | --- | --- |
| `approval_answer` error `message` | `该审批请求已过期或不存在（可能已超时被自动拒绝）。` | `The approval request has expired or does not exist (it may have timed out and been auto-denied).` |
| `session_cancel_queued` `QUEUED_MESSAGE_NOT_FOUND` `message` | `该会话队列里没有这个消息 uuid（可能从未存在、属于别的会话，或没有常驻宿主）。` | `The session queue has no message with this uuid (it may never have existed, belong to another session, or there is no resident host).` |
| `session_cancel_queued` `cancelled` `message` | (CJK) | `The queued message was withdrawn and will not become a turn.` |
| `session_cancel_queued` `already-started` `message` | (CJK) | `The message is no longer in the queue (it was taken out to start executing) and can no longer be withdrawn.` |
| `run_get` `expired` `message` | (CJK, 「保留期」) | `This run existed but is past its retention window; its result can no longer be retrieved.` |
| `run_get` `never_issued` `message` | (CJK, 「从未」) | `This runId was never issued.` |
| `run_get` restarted `message` | (CJK, 「重启」) | `The service restarted; this run belongs to a previous boot.` |
| `quay_snapshot` `no_quay_config` `note` | `该项目没有 quay` | `This project has no quay` |

Consequently the branch's own criteria were re-pointed at the English sentences (strength unchanged): `mcp-approvals.test.ts`(d) asserts `includes('expired or does not exist')`; `mcp-run-get.test.ts`(f)(g) assert `/retention/`, `/never issued/`, `/restarted/i` (and `doesNotMatch(/retention/)`); `mcp-not-found-semantics.test.ts` asserts `/restarted/i`. The AC7 false-form records below remain valid history — they were captured pre-merge and quote the then-current CJK bodies; the assertions they red are the same assertions that still red today.

**AC-289's own criterion migrated (6th AC8 file).** `mcp-english-only.test.ts` is AC-289's achieved criterion (landed on develop; outside AC-287's original `## Touches` — now declared). After the merge it probed three shapes AC-287 retires, so it reds without migration; migrated, strength raised:

- `answerApproval` fixture: `ok:false` not-found (which the OLD shape counted as an eligible success) → `{ ok:true, requestId:'req-1' }`, so the English-copy walk answers a held approval and the verb **succeeds**;
- `run_get` miss probe: read the old success payload's `.explanation` → reads the error envelope (`isError === true`, `code === 'RUN_NOT_FOUND'`, `message === 'This runId was never issued.'`, `details.fallback.note`), and `assertServerCopyEnglish` now covers `run_get.message` / `run_get.details.fallback.note`;
- `session_cancel_queued` uuid loop: `uuid-other` read a success outcome → now `isError === true` + `code === 'QUEUED_MESSAGE_NOT_FOUND'`; `uuid-started` asserts `isError === false` + `outcome === 'already-started'`; both still assert the exact English `message`.

Result: `mcp-english-only.test.ts` 10/10 green.

**AC-284's own criterion migrated (7th AC8 file).** `mcp-error-envelope.test.ts` is AC-284's achieved criterion (landed on develop; outside AC-287's original `## Touches` — now declared). Its header explicitly framed two of its ten probe classes — `审批或排队消息不存在` / `运行不存在` — as pinned *pending AC-287's conversion*, so AC-287's landing invalidates the pins; both were migrated from `kind:'exempt'` into `kind:'envelope'`, strength raised:

- `审批或排队消息不存在`: exempt (pinned "not an error", `reading:'not-an-error'`) → `kind:'envelope'`, `tool:'session_cancel_queued'`, args `{session:'sess-1', messageUuid:'no-such-uuid'}`, `expect:'QUEUED_MESSAGE_NOT_FOUND'` — asserts the code, strictly stronger than the retired `isError === false` pin.
- `运行不存在`: exempt (pinned "not plain text", `reading:'not-plain-text'`) → `kind:'envelope'`, `tool:'run_get'`, `expect:'RUN_NOT_FOUND'`. This required wiring `run_get` in the criterion's own `readTools` bag — it was deliberately left unwired ("Overview / run_get / quay_snapshot stay unwired on purpose"), so the probe had been reading `MCP_TOOL_NOT_IMPLEMENTED` (verbatim: `{"isError":true,"structuredContent":{"code":"MCP_TOOL_NOT_IMPLEMENTED","message":"run_get is registered by AC-245 but its behaviour is delivered by AC-248.",...}}`), not its named class. The bag now supplies a `runGet` deps bundle whose `runs.getRunById` answers every id `{status:'unknown', reason:'unknown'}` (the "never issued" reading), so the class probe genuinely reads `RUN_NOT_FOUND`. The `exempt` arm is kept as the documented escape hatch (the class-coverage test still guards that any entry states a reason) though no class uses it now.

Result: `mcp-error-envelope.test.ts` 7/7 green; the class walk now prints `error-envelope class 运行不存在 -> RUN_NOT_FOUND (run_get, probe)`.

**Count pin re-synced (supersedes the AC9 note's numbers).** The AC9 note's `N = 244` / `known=3 unknown=241` / `known=1 unknown=243` were the **pre-merge** branch readings. Merging develop adds `mcp-english-only.test.ts`, so on the merged tree `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` → **N = 245**; pins written `known=3 unknown=242` (`server/shared/tests/quay-test-script.test.ts:154`) and `known=1 unknown=244` (`:203`). `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → **11/11, exit 0**.

**Diff vs Touches (supersedes the AC11 note's file list).** `git diff --name-status develop...HEAD` = **23** files; the two outside the AC11 note's list are `server/modules/mcp-gateway/tests/mcp-english-only.test.ts` and `server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts`, both now declared in `## Touches`. The other 21 are as the AC11 note lists (with `mcp-run-get.test.ts` etc. as `M`, `mcp-not-found-semantics.test.ts` as `A`). No file outside `## Touches` is written.

### AC1 — red-first

- Before the criterion existed: the existence gate printed `缺判据文件：server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts` and exited 1 (`GATE_EXIT=1`).
- After: gate exits 0; criterion `--test server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts` → `ℹ tests 5 / ℹ pass 5 / ℹ fail 0`.

### AC2/AC3/AC4/AC6 — readings (all via the real `/mcp` mount, real token, MCP SDK client)

- (a) expired `requestId` → `isError:true`, `structuredContent.code='APPROVAL_NOT_FOUND'`, `details.reason='expired'`; never-minted → same code, `details.reason='never_issued'`; the two reasons `notEqual`; both messages carry the `expired or does not exist` sentence; resolver never called. No `ok:false` success remains (the false form (i) is exactly what reds this).
- (b) never-held uuid (own + cross-session) → `isError:true`, `code='QUEUED_MESSAGE_NOT_FOUND'`; already-started uuid → `isError:false`, `outcome='already-started'`; `tools/list` reads `session_cancel_queued.outputSchema.properties.outcome.enum` deep-equal `['already-started','cancelled']` (set equality).
- (c) expired / never-issued / cross-boot runIds → `isError:true`, `code='RUN_NOT_FOUND'`, `details.reason` `'expired'` / `'never_issued'`, messages matching `/retention/` / `/never issued/` / `/restarted/i`; `details.fallback.messages` deep-equals the fixture messages; cross-boot `details.bootId === BOOT_TWO`; run hit stays `isError:false`.
- (d) missing project id → `isError:true`, `code='PROJECT_NOT_FOUND'`, `details.project=<id>`; config-less existing project → `isError:false`, `status='no_quay_config'`; with-config project → `isError:false`, `status='cached'` / `'refreshed'`.
- (e) invariants: already-started, no_quay_config and the run hit are all successes.

### AC5 — the deviation and its resolution (worker found it; human ruled it on 2026-10-07)

AC5 names the missing-project code as the literal `TARGET_NOT_FOUND`. That literal is **unsatisfiable in this repository**:

1. `MCP_ERROR_CODES` has no `TARGET_NOT_FOUND` member, and AC-285's achieved criterion (`tests/mcp-error-vocabulary.test.ts`) deep-equals the vocabulary key set in **both** directions at runtime — adding the code would red it.
2. AC-284's achieved criterion (`tests/mcp-error-envelope.test.ts`) scans `server/modules/mcp-gateway/*.ts` and fails if the literal `TARGET_NOT_FOUND` appears at all (AC-284's goal retired the two-name situation).
3. AC-284's criterion already maps project-not-found → `PROJECT_NOT_FOUND`.

Worker resolution (locked): implement and assert `PROJECT_NOT_FOUND` (the project-side code of the one-code-per-category vocabulary); leave AC5 unticked; park the task `needs-human`. The criterion's header records this deviation on purpose, and the missing-project probe does error with `PROJECT_NOT_FOUND` — the *semantics* AC-287 asks for (a reference to nothing is an error, not a success) are delivered; only the name differs.

### AC7 — three false forms, red then restored

Shared runner: `PATH="$PWD/node_modules/.bin:$PATH" QUAY_MEMORY_MAX=8G bash scripts/with-memory-cap.sh env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts`

**(i) `approval_answer` miss back to `ok:false` success** — `server/modules/mcp-gateway/mcp-approvals.ts`:

```diff
@@ -435,9 +435,13 @@
-    throw new McpToolError(MCP_ERROR_CODES.APPROVAL_NOT_FOUND, result.message, false, {
-      reason: result.reason,
-    });
+    // MUTATION (i)
+    return {
+      ok: false,
+      requestId: input.requestId,
+      code: 'APPROVAL_EXPIRED_OR_NOT_FOUND',
+      message: result.message,
+    } as unknown as ApprovalAnswerPayload;
```

Verbatim failure (pre-merge, CJK body): `✖ (a) approval_answer: expired and never-minted are APPROVAL_NOT_FOUND errors, reasons distinguished` — `AssertionError [ERR_ASSERTION]: (a) expired: the error envelope must carry details (payload={\"ok\":false,\"requestId\":\"ac287-req-held-then-dropped\",\"code\":\"APPROVAL_EXPIRED_OR_NOT_FOUND\",\"message\":\"该审批请求已过期或不存在（可能已超时被自动拒绝）。\"})`; `ℹ tests 5 / ℹ pass 4 / ℹ fail 1`.
Restore: `git checkout -- server/modules/mcp-gateway/mcp-approvals.ts` → re-run `ℹ tests 5 / ℹ pass 5 / ℹ fail 0`.

**(ii) `already-started` made an error** — `server/modules/mcp-gateway/mcp-session-cancel-queued.ts`:

```diff
-  if (verdict === 'unknown') {
+  // MUTATION (ii): already-started treated as an error alongside unknown.
+  if (verdict !== 'withdrawn') {
```

Verbatim failures (pre-merge, CJK body): `✖ (b) session_cancel_queued: never-held uuid is QUEUED_MESSAGE_NOT_FOUND, already-started is a success` — `AssertionError: an already-started message must stay a success (text=该会话队列里没有这个消息 uuid（可能从未存在、属于别的会话，或没有常驻宿主）。)`; `✖ (e) the real states stay successes: already-started, no_quay_config and a run hit` — `AssertionError: already-started must stay a success`; `ℹ tests 5 / ℹ pass 3 / ℹ fail 2`.
Restore: `git checkout -- server/modules/mcp-gateway/mcp-session-cancel-queued.ts`.

**(iii) missing project swallowed into no-config** — `server/modules/mcp-gateway/mcp-overview-tools.ts`:

```diff
   if (!projects.some((row) => row.projectId === project)) {
-    throw new McpToolError(
-      MCP_ERROR_CODES.PROJECT_NOT_FOUND,
-      `No project has id "${project}".`,
-      false,
-      { project },
-    );
+    // MUTATION (iii)
+    return { project, hasQuayConfig: false, status: 'no_quay_config', note: NO_QUAY_NOTE };
   }
```

Verbatim failure (pre-merge, CJK note): `✖ (d) quay_snapshot: a missing project errors, an existing config-less project succeeds` — `AssertionError: a project id nothing matches must be an error (text={\"project\":\"ac287-no-such-project\",\"hasQuayConfig\":false,\"status\":\"no_quay_config\",\"note\":\"该项目没有 quay\"})`; `ℹ tests 5 / ℹ pass 4 / ℹ fail 1`.
Restore: `git checkout -- server/modules/mcp-gateway/mcp-overview-tools.ts` → `ℹ tests 5 / ℹ pass 5 / ℹ fail 0`; `git status --porcelain` empty.

### AC8 — migrated criteria, old → new (strength raised, no assertion deleted or relaxed)

- `mcp-approvals.test.ts`(d): old `assert.equal(expired.isError, false)` + `assert.equal(never.isError, false)` (miss is a success) → new `isError === true`, `payload.code === 'APPROVAL_NOT_FOUND'`, `details.reason` `'expired'` / `'never_issued'`, the two reasons `notEqual`, both messages still carry `expired or does not exist`, resolver call count 0. Three assertions became six; the sentence assertion retained.
- `mcp-cancel-queued.test.ts`(b): old dequeued uuid read `outcome:'unknown'`, `isError:false` → new `isError:false` + `outcome === 'already-started'` (kept `notEqual('cancelled')`). (c): old never-held read `'unknown'` success → new `isError === true` + `code === 'QUEUED_MESSAGE_NOT_FOUND'`.
- `mcp-run-get.test.ts`(f): old expired/unknown miss `isError:false` → new `isError === true` + `code === 'RUN_NOT_FOUND'` + `details.reason` + message regexes (`/retention/`, `/never issued/`) + `fallback.messages` deep-equal. (g): old restarted miss success → new `isError === true` + `details.reason === 'expired'` + `/restarted/i` + `doesNotMatch(/retention/)` + `details.bootId === BOOT_TWO` + `notEqual(firstBoot)` + fallback deep-equal.
- `mcp-overview.test.ts`(d): old no-quay `isError === false` retained and now also asserts `status === 'no_quay_config'`; **added** a missing-project probe asserting `isError === true` / `code === 'PROJECT_NOT_FOUND'` / `details.project === missingId`, plus a positive control that an existing project with config still succeeds.
- `debug-agent/tests/debug-agent-control-queue.test.ts`(d): old `assert.equal(reading.verdict, 'unknown')` for a dequeued uuid → new `assert.equal(reading.verdict, 'already-started', 'a message already started cannot be withdrawn')`; kept `assert.notEqual(reading.verdict, 'withdrawn')`.
- `mcp-english-only.test.ts` (AC-289's criterion): see the Post-merge reconciliation section above — three probes migrated to the error shapes, strength raised, 10/10 green.
- `mcp-error-envelope.test.ts` (AC-284's criterion): see the Post-merge reconciliation section above — two class probes migrated from the exempt arm into the envelope arm, strength raised (envelope code asserted, not merely "not an error"/"not plain text"), 7/7 green.
- Scoped gate `bash scripts/test.sh --for-task gap-ac287-not-found-semantics` → exit 0, `# pass 9 / # fail 0` (9 `*.test.*` files in `## Touches`), green after the develop merge.

### AC9 — count pin

See the Post-merge reconciliation section: pre-merge `N = 244` (pins `known=3 unknown=241`, `known=1 unknown=243`); merged `N = 245` (pins `known=3 unknown=242` at `:154`, `known=1 unknown=244` at `:203`). `quay-test-script.test.ts` 11/11 green.

### AC10 — repo gates

- `npm run typecheck` → exit **0** (the first run exited 2 on two test-file types — a partial `ActivityProtocolSnapshot` fake and two untyped `details.reason` reads — fixed in `39880d99`; test-only). Re-run this round on the merged tree → exit **0**.
- `npm run lint` → exit **0**, `: error ` lines = **0** (warnings only, all pre-existing/unrelated files). Re-run this round → exit **0**, `: error ` count **0**.
- `npm run build` → exit **0**. Re-run this round → exit **0**.

### AC11 — actual diff vs `## Touches`

`git diff --name-status develop...HEAD` = **23** files (all declared in `## Touches`, which now also carries `server/modules/mcp-gateway/tests/mcp-english-only.test.ts` and `server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts`):

`server/modules/debug-agent/debug-agent.host-driver.ts`, `.../tests/debug-agent-control-queue.test.ts`, `server/modules/mcp-gateway/index.ts`, `.../mcp-approvals.ts`, `.../mcp-error-envelope.ts`, `.../mcp-overview-tools.ts`, `.../mcp-run-get.ts`, `.../mcp-session-cancel-queued.ts`, `.../mcp-tool-error-codes.ts`, `.../tests/mcp-approvals.test.ts`, `.../tests/mcp-cancel-queued.test.ts`, `.../tests/mcp-english-only.test.ts`, `.../tests/mcp-error-envelope.test.ts`, `.../tests/mcp-not-found-semantics.test.ts (new)`, `.../tests/mcp-overview.test.ts`, `.../tests/mcp-run-get.test.ts`, `server/modules/providers/index.ts`, `.../list/claude/claude-runtime.provider.ts`, `.../services/provider-runtime.service.ts`, `server/modules/websocket/services/chat-control.service.ts`, `.../chat-websocket.service.ts`, `server/shared/tests/quay-test-script.test.ts`, `server/shared/types.ts`.

Declared in `## Touches` but **unmodified**: `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` (its `quay_snapshot` outputSchema is `{ snapshot: z.unknown().optional() }` — no `status` enum to sync) and `server/modules/websocket/index.ts` (no new websocket-barrel export was needed; `MissingApprovalReason` rides `@/shared/types.js`). No file outside `## Touches` is written. `tasks/gap-ac287-not-found-semantics.md` is the self-touch (this write).

### Resolution (2026-10-07, human-ruled — task unparked)

The task was parked `needs-human` because AC5 named a code the repository's achieved sibling criteria actively forbid. Human yale ruled: align AC-287 to the canonical code rather than reopen AC-284/AC-285.

**Independently re-verified before the tick** (in the task worktree at `ccb5e783`, clean tree):

- Criterion re-run: `PATH="$PWD/node_modules/.bin:$PATH" QUAY_MEMORY_MAX=8G bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts` → `ℹ tests 5 / ℹ pass 5 / ℹ fail 0`, exit **0**. The (d) probe prints verbatim: `mcp-not-found (d) missing   isError=true payload={\"code\":\"PROJECT_NOT_FOUND\",\"message\":\"No project has id \\\"ac287-no-such-project\\\".\",\"retryable\":false,\"details\":{\"project\":\"ac287-no-such-project\"}}` and `mcp-not-found (d) noConfig  isError=false payload={\"project\":\"…\",\"hasQuayConfig\":false,\"status\":\"no_quay_config\",\"note\":\"This project has no quay\"}`.
- Repo gates re-run on the same tree: `npm run typecheck` → exit **0**; `npm run lint` → `: error ` count = **0**.

**Why the old literal really is unsatisfiable** (re-checked at source, not taken from the worker's word):

1. `server/modules/mcp-gateway/mcp-error-envelope.ts` `MCP_ERROR_CODES` has `PROJECT_NOT_FOUND` and no `TARGET_NOT_FOUND` member; AC-285's achieved criterion `tests/mcp-error-vocabulary.test.ts:619-628` deep-equals the key set against `EXPECTED_ERROR_CODES` in both directions.
2. AC-284's achieved criterion `tests/mcp-error-envelope.test.ts:747-766` reads every top-level `server/modules/mcp-gateway/*.ts` and asserts `retiredMentions` for `TARGET_NOT_FOUND` `deepEqual []`; AC-284's own goal `expect` (c) states the retirement was deliberate — one code per problem class, no `SESSION_NOT_FOUND` / `TARGET_NOT_FOUND` duality.

So the only alternatives were (a) rename in AC-287, or (b) reopen two achieved goals to reinstate the name AC-284 was written to delete. (a) chosen.

**What changed in this write** (the code and the criterion are untouched — only the contract's prose):

- AC5 text: `TARGET_NOT_FOUND` → `PROJECT_NOT_FOUND`, ticked. Assertion strength unchanged.
- Proposal requirement (d), the `<!-- dedup-ref -->` scope note, Plan steps 1 and 7, and the two DoD bullets that named the literal: same rename, each with a pointer to this section.
- goal `AC-287`'s `expect` (d) clause: same rename, recorded in one `quay goal batch` commit (`adc68b07`). The goal's `criterion` command is unchanged and already passes once this branch lands, which is what flips the goal to `achieved`.

**No other AC moved.** AC1–AC4 and AC6–AC11 were already ticked and their readings are untouched (except the message-language reconciliation recorded at the top).
