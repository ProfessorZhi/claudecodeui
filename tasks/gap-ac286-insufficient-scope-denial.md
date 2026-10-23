---
id: gap-ac286-insufficient-scope-denial
title: 权限不足说清缺哪个 scope（AC-286）：通用检查与 session_background 处理函数内检查同形同
  code（INSUFFICIENT_SCOPE + details.requiredScopes），被拒仍写带 scope 的 denied 审计，判据
  server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts
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
goal_ac: AC-286
---
## Proposal

**目标 AC**：`goals/AC-286-权限不足的返回说清楚缺哪个-scope-以及怎么补-通用检查与处理函数内的检查形状完全一致.md`，goal GOAL-024（退出条件 3）。判据文件固定为 `server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts`，判据命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts`。

**现状（源码核实，非推测）**——权限不足在两处出现，形状、code、审计归属三者全不一致：

1. **通用检查（纯文本，不说缺什么）**：`server/modules/mcp-gateway/mcp-gateway.audit.ts:275-286`。`const permitted = registration.requiredScopes.every((scope) => principal.scopes.includes(scope))`；不满足时 `recordMcpToolCall({..., outcome: 'denied', args})` 后返回 `{ content: [{ type: 'text', text: 'Insufficient scope for this tool.' }], isError: true }`——没有 `structuredContent`、没有 `code`、没有 `details`、没有一个字点名缺的 scope。其上的 `principal === null` 分支（`:263-273`）同形，回 `'Unauthorized.'`。
2. **处理函数内的检查（第二个 code，形状不同，且被记成 error）**：`server/modules/mcp-gateway/mcp-session-background.ts:253-260`，停止分支在到达 control service 之前自行检查：`if (!ctx.principal.scopes.includes(SESSION_CONTROL_SCOPE)) throw refusal({ code: 'SCOPE_DENIED', session: sessionId, taskId, message: '停止后台任务需要 cloudcli:session:control。' })`。`refusal()`（`:171-174`）是 `new Error(JSON.stringify(body))`；该异常落到 audit wrapper 的 catch（`mcp-gateway.audit.ts:304-317`），于是 (i) code 是第二个说法 `SCOPE_DENIED`，(ii) 形状是文本里塞 JSON 且带 `session`/`taskId`（与通用检查的逐字段形状不同），(iii) 审计 outcome 记成 `'error'` 而不是 `'denied'`，(iv) 审计行里没有 scope。
3. **审计行无处安放缺的 scope**：`mcp_audit_log`（`server/modules/database/schema.ts:410-420`）只有 `id, at, token_id, client_id, tool, args_digest, outcome, duration_ms`；仓储 `InsertMcpAuditLogInput`（`server/modules/database/repositories/mcp-audit-log.db.ts:31-39`）与 `recordMcpToolCall`（`mcp-gateway.audit.ts:106-115`）同样没有字段能带上缺的 scope。
4. **scope 归属的既有事实（探针集合的真值来源，不要手写名单）**：唯一位表 `ACCESS_TOKEN_SCOPES`（`server/modules/oauth/access-tokens.service.ts:38-44`）= `cloudcli:read` / `cloudcli:session:send` / `cloudcli:session:create` / `cloudcli:session:control` / `cloudcli:approve`。只读静态 scope 的工具：`MCP_STAGE3_READ_TOOLS` 全表（`mcp-gateway.read-tools.ts:53-90`，均 `READ_SCOPE`）+ `approvals_list`（`mcp-approvals.ts:456`）+ `session_background`（`mcp-gateway.resident-tools.ts`，静态 read、停止分支自查 control）。需要更高权限的工具：`MCP_STAGE4_WRITE_TOOLS`（`mcp-gateway.write-tools.ts:89-109`：session_send=send、session_create=create、session_interrupt/session_start/session_close=control）+ `session_cancel_queued`（control）+ `session_reconfigure`（control）+ `approval_answer`（approve）。

**依赖**：本任务消费 `gap-ac284-mcp-error-envelope` 交付的信封 seam（`mcp-error-envelope.ts` 的 `MCP_ERROR_CODES` / 信封构造器 / `toMcpErrorResult`）。该任务正文已把这一半显式让出：「细节 requiredScopes 留给 AC-286，先给稳定 code」。所以本任务 depends_on 它，不另起第二个信封模块、不重复实现全量信封；开工时先读 `mcp-error-envelope.ts` 是否存在，缺失就停手报告（这是排序问题，不是可以各自实现两份的问题）。

**要交付（判据文件 `tests/mcp-insufficient-scope.test.ts` 是唯一验收界面）**：

1. **通用检查改走信封并点名缺的 scope**：`withMcpAudit` 的 `!permitted` 分支返回 `{ isError: true, structuredContent: { code: 'INSUFFICIENT_SCOPE', message, retryable, details: { requiredScopes } } }`，其中 `requiredScopes` = 调用方**实际缺的**那些（`registration.requiredScopes.filter((s) => !principal.scopes.includes(s))`），`message` 逐字点名其中每一个 scope 并说明需要重新授权（英文，如 `Missing required scope \"cloudcli:session:control\". Re-authorize with that scope to call session_background.`）。`principal === null` 分支同走信封，但它是未鉴权而非权限不足，沿用 AC-284 定的 code，不改成本 AC 的 `INSUFFICIENT_SCOPE`（不要把它并进来）。
2. **处理函数内的检查与通用检查逐字段同形同 code**：`session_background` 停止分支不再抛 `SCOPE_DENIED`；改抛/返回同一个信封产出，`code` 同为 `INSUFFICIENT_SCOPE`、`details` 键集同为 `{ requiredScopes }`、`retryable` 同值。缺的 scope 由 `requiredScopes` 表达，`session`/`taskId` 不得折进 `details`（否则两处形状不同）——它们是该工具**其它**拒绝（`SESSION_NOT_FOUND`/`TASK_NOT_FOUND`）的上下文，不是权限不足的。源码内不再存在第二个权限不足 code。
3. **被拒绝仍写 `denied` 审计且带上缺的 scope**：给审计行加一个承载字段（建议 `denied_scopes TEXT`，存缺的 scope 的 JSON 数组，非权限不足时为 NULL）：`schema.ts` 的 `MCP_AUDIT_LOG_TABLE_SCHEMA_SQL` 同步加列，`migrations.ts` 用既有的 `addColumnIfMissing`（`:46-53`）模式为既有库补列，`mcp-audit-log.db.ts` 的 `AUDIT_COLUMNS` / `McpAuditLogRow` / `InsertMcpAuditLogInput` / insert 绑定同步，`recordMcpToolCall` 的 `McpToolCallReading` 加可选 `deniedScopes`。并且：**处理函数内的拒绝必须记成 `denied`（不是 `error`）**——为此在信封模块导出一个可判别的拒绝错误类型（如 `McpScopeDeniedError`，携带 `code` 与 `requiredScopes`），`withMcpAudit` 的 catch 识别它后写 `outcome: 'denied'` 并把 `requiredScopes` 落进 `denied_scopes`；其它异常仍记 `error`（`boom` 正控不得被误伤）。
4. **判据**：真实 express + `mountMcpGateway`（经 `createMcpGatewayModule` 装配，参照 `tests/mcp-gateway-wiring.test.ts` 的真 HTTP + SDK client + 临时 `DATABASE_PATH`/`HOME` 模式），用真实签发（`server.issue([...])`，同 `mcp-audit.test.ts`）的令牌驱动，读四组读数 (a)(b)(c)(d)。
5. **既有判据移植**：凡断言旧形状的既有测试逐条移植到新形状、断言强度不降，任务记录里逐条列旧→新（清单见 AC7）。
6. **计数 pin 同步**：新增一个 `server/**/*.test.ts` 会使 `server/shared/tests/quay-test-script.test.ts` 的两处 `known/unknown` pin 变红，按运行时实际计数加一。**注意**：兄弟任务 `gap-ac284-mcp-error-envelope` 也会各加一个测试文件，所以不要照抄任何文档里写死的数字——实现时先跑 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 取当时实际总数 N（今天 N=237），再按 pin 的两条构造式反推：`known=3 unknown=N-3`（`:154`）与 `known=1 unknown=N-1`（`:203`）。

**范围外（兄弟 AC，避免重复实现）**：信封形状本身 / 同类同 code / 注册表驱动探针表属 AC-284；code 词表的单一来源与每工具声明属 AC-285；四个工具的 not-found 改错误属 AC-287；`INVALID_ARGUMENT` 的 `details.fields` 属 AC-288；服务端文案无 CJK 的普查属 AC-289。本任务只做：`INSUFFICIENT_SCOPE` + `details.requiredScopes` + 两处检查同形 + denied 审计带 scope + 正控。

**后端改动遵守 `$backend-module-standards`**（`.agents/skills/backend-module-standards/SKILL.md`）：新导出归位 mcp-gateway 模块、导出符号带消费方注释、跨模块消费走 barrel（`server/modules/database/index.ts`、`server/modules/mcp-gateway/index.ts`），仓储留在 database 模块，不新增模块级 `types.ts`/`utils.ts`。

## Plan

1. 读 `server/modules/mcp-gateway/mcp-error-envelope.ts`（AC-284 的产物），确认 `MCP_ERROR_CODES` 含 `INSUFFICIENT_SCOPE` 与信封构造器签名；不存在则停手报告。
2. **信封模块**：加「权限不足」这一档的构造函数（产 `details: { requiredScopes }`，`retryable: false`，message 逐字点名 scope + 重新授权），以及可判别的拒绝错误类型（携 `code` + `requiredScopes`），供处理函数内检查抛出。barrel 导出，带消费方注释。
3. **`mcp-gateway.audit.ts`**：`!permitted` 分支改产信封（`requiredScopes` 取实际缺集），`recordMcpToolCall` 带上 `deniedScopes`；catch 分支先判拒绝错误类型 ⇒ 写 `denied` + `denied_scopes` 并渲染同一个信封，其余异常保持 `error` 语义不变。成功路径与 `principal === null` 分支不动语义。
4. **审计存储**：`schema.ts` 的 `mcp_audit_log` 建表语句加 `denied_scopes TEXT`；`migrations.ts` 用 `addColumnIfMissing` 补列（既有库与新建库两条路都通）；`mcp-audit-log.db.ts` 的 `AUDIT_COLUMNS`、`McpAuditLogRow`、`InsertMcpAuditLogInput`、insert 语句与返回值同步。
5. **`mcp-session-background.ts`**：停止分支改抛拒绝错误类型（`INSUFFICIENT_SCOPE` + `requiredScopes: [SESSION_CONTROL_SCOPE]`），删掉 `SCOPE_DENIED`；该分支仍必须在到达 control service 之前（既有判据钉住 `stopTaskCalls === 0`）。
6. **写判据 `tests/mcp-insufficient-scope.test.ts`**（红先行）：
   - (a) 从真实 `tools/list` 取工具名全集；用只读令牌逐工具调用。只读静态 scope 的工具集合取自模块导出的真值（`MCP_STAGE3_READ_TOOLS` 名字 + `approvals_list` + `session_background`），断言 `tools/list` 全集 == 只读集 ∪ 需更高权限集（集合相等 ⇒ 新加工具而不声明 scope 即红，且探针集不是手写名单）；对需更高权限的每一个工具断言 `isError === true`、`structuredContent.code === 'INSUFFICIENT_SCOPE'`、`retryable` 为 boolean、`details.requiredScopes` 非空且每个元素 ∈ `ACCESS_TOKEN_SCOPES`、∉ 只读令牌的 scope、且 ⊇ 该工具声明的 scope；`message` 逐字含 `requiredScopes` 中每一个 scope 且匹配 `/re-?authoriz|重新授权/i`；并断言没有任何响应是 `content[0].text === 'Insufficient scope for this tool.'`。写下逐工具读数。
   - (a-反空转) 断言只读集里每个工具的调用**不**返回 `INSUFFICIENT_SCOPE`（否则「一律拒绝」也会让 (a) 通过）。
   - (b) 用只读令牌对 `session_background` 停止分支发起调用，取回其失败信封；与 (a) 里通用检查的失败信封做 `code`、`Object.keys(structuredContent).sort()`、`Object.keys(details).sort()`、`retryable` 的逐字段相等断言；`grep -rn \"SCOPE_DENIED\" server/modules/mcp-gateway/*.ts`（不含 tests）无输出。
   - (c) 通用检查拒绝与处理函数内拒绝各写且只写一行审计：`outcome === 'denied'`（处理函数内的不得是 `error`），`denied_scopes` 为 JSON 数组且含所缺 scope；对照正控 `boom` 仍记 `error`。写下两行逐列读数。
   - (d) 持足够权限：`session_background` 停止分支持 `cloudcli:session:control` 真实成功（`stopped: true`，control service 被调 1 次）；且全 scope 令牌下至少一个工具真实成功（`isError === false`），其余工具不返回 `INSUFFICIENT_SCOPE`。
7. **红先行**：先提交判据文件（此时文件不存在 ⇒ 存在性闸以退出码 1 输出缺失文件名）；再实现，记录实现后退出码 0。
8. **移植既有判据**（AC7 清单），逐条列旧→新。
9. **变异三连**（先提交实现再变异，逐条记录 mutation diff、逐字失败行、恢复命令）。
10. **同步计数 pin**；跑 `npm run typecheck` / `npm run lint` / `npm run build`。

## AC

- [x] AC1 判据文件 `server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts` 存在且 `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts` 退出码 0。任务记录含「实现前该文件不存在、存在性闸以退出码 1 输出缺失文件名」与「实现后退出码 0」两段逐字输出（红先行证据）。
- [x] AC2 (a) 通用检查：真实 HTTP + MCP SDK 客户端，持只读令牌（仅 `cloudcli:read`）调用每一个需更高权限的工具；每个返回 `isError === true`、`structuredContent.code === 'INSUFFICIENT_SCOPE'`、`retryable` 为 boolean、`details.requiredScopes` 为非空数组且元素 ∈ `ACCESS_TOKEN_SCOPES`、∉ 只读令牌 scope、⊇ 该工具声明 scope；`message` 逐字点名其中每个 scope 并匹配 `/re-?authoriz|重新授权/i`。探针集由 `tools/list` ∪ 模块导出的 scope 真值驱动（`tools/list` 全集 == 只读集 ∪ 需更高权限集），不是手写名单。断言不存在 `content[0].text === 'Insufficient scope for this tool.'`。写下逐工具覆盖清单与 requiredScopes 读数；并断言只读集内每个工具不被 `INSUFFICIENT_SCOPE` 拒绝（反「一律拒绝」空转）。
- [x] AC3 (b) 两处检查逐字段同形同 code：`session_background` 停止分支的失败信封与通用检查的失败信封，`code` 相同（均 `INSUFFICIENT_SCOPE`）、`Object.keys(structuredContent)` 相同、`details` 键集相同（均恰为 `requiredScopes`）、`retryable` 相同；`grep -rn \"SCOPE_DENIED\" server/modules/mcp-gateway/*.ts`（不含 tests）无输出。写下两段信封的逐字 JSON。
- [x] AC4 (c) 被拒绝仍写 `denied` 审计且带上缺的 scope：通用检查拒绝与处理函数内拒绝各写且只写一行 `mcp_audit_log`，两行 `outcome === 'denied'`（处理函数内的不得记 `error`），两行 `denied_scopes` 为 JSON 数组且含所缺 scope；正控：抛裸异常的 `boom` 路径仍记 `error`。写下两行逐列读数。
- [x] AC5 (d) 正控（防「一律拒绝」）：持 `cloudcli:session:control` 时 `session_background` 停止分支真实成功（`isError === false`、`stopped === true`、control service 恰好被调 1 次）；全 scope 令牌下至少一个工具真实成功（`isError === false`），其余工具不返回 `INSUFFICIENT_SCOPE`。写下两次调用的读数。
- [x] AC6 取假形态三条必须先红后恢复，逐条记录 mutation diff、逐字失败行、恢复命令：(i) 通用检查回到纯文本 `'Insufficient scope for this tool.'` ⇒ AC2 红；(ii) 处理函数内仍用 `SCOPE_DENIED`（或形状带 `session`/`taskId`）⇒ AC3 红；(iii) 拒绝不再写 `denied` 审计（或 `denied_scopes` 不再带 scope）⇒ AC4 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC7 既有判据移植、强度不降：至少覆盖 `server/modules/mcp-gateway/tests/mcp-tool-annotations.test.ts:275`（旧 `/Insufficient scope/` 文本匹配）、`mcp-session-background.test.ts:548`（旧 `payload?.code === 'SCOPE_DENIED'`）、`mcp-audit.test.ts:313-322`（denied 行，需加 `denied_scopes` 断言）、`mcp-cancel-queued.test.ts:653-658`、`mcp-approvals.test.ts:617-622`、`mcp-session-host-control.test.ts:666-682`、`mcp-oauth-challenge.test.ts:497-500`、`mcp-session-send.test.ts:645-652`；每条记旧断言→新断言，新断言强度不低于旧（等同或更严），diff 中无删除 `assert`、无放宽为 truthy/skip、无跳过用例。`bash scripts/test.sh --for-task gap-ac286-insufficient-scope-denial` 退出码 0。
- [x] AC8 计数 pin 同步：`server/shared/tests/quay-test-script.test.ts` 两处 `known/unknown` pin 按实现时实际计数加一（先取 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实际 N，再写 `known=3 unknown=N-3` 与 `known=1 unknown=N-1`），`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0。写下 N 的读数与改后的两个 pin 字符串。
- [x] AC9 仓库门：`npm run typecheck` 退出码 0；`npm run lint` 无 `: error `（只看 error 级）；`npm run build` 退出码 0。写明三条命令退出码与 lint error 计数。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 `task_write` 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 一个真实的 MCP 客户端（真 HTTP、SDK client、真签发的 access token）**实际收到**的是 `isError: true` + `structuredContent.code === 'INSUFFICIENT_SCOPE'` + `details.requiredScopes`，不是测试桩伪造的结构——即新形状经由 `withMcpAudit` 的真实渲染路径到达线上。
- 处理函数内的检查（`session_background` 停止分支）在真实 mount 上走的是与通用检查**同一条**信封路径：两段信封的 `code`、键集、`details` 键集逐字段相等，源码里不再有 `SCOPE_DENIED`。
- 被拒绝时审计行的 `outcome` 真的是 `denied`（处理函数内的那条也**不是** `error`），且 `denied_scopes` 真的是含所缺 scope 的 JSON 数组；抛裸异常的正控仍记 `error`。
- 正控成立：持足够权限的同一调用真的通过（停止真的发生、至少一个工具真的成功），证明判据不是靠「一律拒绝」通过。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 既有断言旧形状的 MCP 判据真的迁移到新形状且断言强度不降，不是删除/放宽/改成 `assert.ok(真)`，任务记录里逐条列旧→新。
- 新增列走 `addColumnIfMissing`（既有库可迁移）+ 建表语句同步（新库有列）两条路；遵守 `$backend-module-standards`：导出符号带消费方注释、跨模块只经 barrel、仓储留在 database 模块、不新增模块级 types/utils 文件。
- 同步了 `server/shared/tests/quay-test-script.test.ts` 的计数 pin（按运行时实际计数，不照抄写死数字），未使全量 suite 因新增一个 `server/**/*.test.ts` 而变红。

## Touches

- server/modules/mcp-gateway/mcp-error-envelope.ts
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-session-background.ts
- server/modules/mcp-gateway/index.ts
- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/mcp-audit-log.db.ts
- server/modules/database/index.ts
- server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts (new)
- server/modules/mcp-gateway/tests/mcp-tool-annotations.test.ts
- server/modules/mcp-gateway/tests/mcp-session-background.test.ts
- server/modules/mcp-gateway/tests/mcp-audit.test.ts
- server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts
- server/modules/mcp-gateway/tests/mcp-approvals.test.ts
- server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts
- server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-ac286-insufficient-scope-denial.md (self-touch)
