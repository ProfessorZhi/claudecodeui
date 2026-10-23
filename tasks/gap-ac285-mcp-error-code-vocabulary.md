---
id: gap-ac285-mcp-error-code-vocabulary
title: 错误 code 词表唯一来源（AC-285）：MCP_ERROR_CODES 为唯一词表（英文含义+可重试），每工具经 tools/list
  `_meta` 声明可能 code，观察到的 code 属于声明、无死 code、源码值位置字面量经 AST 扫描来自词表
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
goal_ac: AC-285
---
## Proposal

**目标 AC**：`goals/AC-285-错误-code-词表只有一个来源-每个工具声明自己可能返回的-code-观察到的-code-必须属于声明.md`，goal GOAL-024。判据文件固定为 `server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts`，判据命令（带存在性闸）：

```
for f in server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts
```

当前必红：判据文件不存在，闸以退出码 1 打印 `缺判据文件：server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts`。

**与 AC-284 的关系（源码核实）**：判据 (c) 要复跑「上一条的全部探针」，且两端共享 `server/modules/mcp-gateway/mcp-error-envelope.ts`（AC-284 新建并导出 `MCP_ERROR_CODES`）与 `index.ts` barrel，机制上排在其后——用 `depends_on: gap-ac284-mcp-error-envelope` 字段声明（关系边，非仅散文）。`grep -rn "MCP_ERROR_CODES" server/` 当前为空：词表尚不存在。

**现状（源码核实，非推测）**：

- 值位置的 `code:` 字符串字面量散落 6 个文件、13 处：`mcp-approvals.ts:414`（`APPROVAL_EXPIRED_OR_NOT_FOUND`）、`:419`（`FORBIDDEN`）、`mcp-session-lifecycle.ts:266`（`TARGET_NOT_FOUND`）、`:281`（`UNSUPPORTED_PERMISSION_MODE`）、`mcp-resolve-target.ts:108`（`TARGET_NOT_FOUND`）、`:161`（`TARGET_AMBIGUOUS`）、`mcp-session-reconfigure.ts:207`（`SESSION_NOT_FOUND`）、`:221`（`UNSUPPORTED_PERMISSION_MODE`）、`mcp-session-cancel-queued.ts:154`（`FORBIDDEN`）、`mcp-session-send.ts:307`（`RUN_IN_PROGRESS`）、`mcp-session-background.ts:217`（`SESSION_NOT_FOUND`）、`:255`（`SCOPE_DENIED`）、`:267`（`TASK_NOT_FOUND`）。另有 3 处**类型位置**的联合类型（`mcp-approvals.ts:69/82`、`mcp-resolve-target.ts:68`）——扫描器必须区分值位置与类型位置，否则误报，这正是 (e) 最容易做错的地方。
- 这些字面量的取值集合：`FORBIDDEN`×3、`UNSUPPORTED_PERMISSION_MODE`×2、`TARGET_NOT_FOUND`×2、`TARGET_AMBIGUOUS`×2、`SESSION_NOT_FOUND`×2、`APPROVAL_EXPIRED_OR_NOT_FOUND`×2、`TASK_NOT_FOUND`、`SCOPE_DENIED`、`RUN_IN_PROGRESS`。这就是 (d) 要逐个证明「有探针触发」或列入显式豁免的候选集。
- **HTTP/OAuth 层**另有 2 个面向调用方的 `code:` 字面量：`mcp-gateway.auth.ts:102`（`ACCESS_TOKEN_INVALID`，401 body）与 `mcp-gateway.loopback.ts:50`（`MCP_LOOPBACK_ONLY`）。GOAL-024 非目标明说「不改 OAuth 与 HTTP 层的 401 与元数据（在 GOAL-026）」，故这两个**不进** `MCP_ERROR_CODES`，扫描器对它们**显式豁免并写理由**——否则 (d)/(e) 会与 GOAL-026 打架。
- **每工具声明的现成落点**：`mcp-tool-annotations.ts` 的 `MCP_TOOL_ANNOTATIONS: Record<McpGatewayToolName, ToolAnnotations>`（total record）+ `readMcpToolAnnotations(name)`（未声明抛错）+ transport 唯一 `audited` seam（`mcp-gateway.transport.ts:159`）为每个工具挂上，是 (b) 的直接先例。SDK `McpServer.registerTool` 的 config 接受 `_meta?: Record<string, unknown>` 并转发（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:703`），`ToolSchema` 带 `_meta`（`types.js:1229` 段），故 `_meta` 会经 `tools/list` 到客户端。AC 原文允许「描述**或**结构化元数据」，用 `_meta` 可避开 GOAL-023 对工具描述的占有。
- **17 个工具**由 `McpGatewayToolName` 全集给定（read 7 + write 5 + resident 1 + `session_reconfigure`/`session_background`/`approvals_list`/`approval_answer` 4），与 `MCP_TOOL_ANNOTATIONS` 的 17 行一致；AC-284 的探针表也以同一 `McpGatewayToolName` 为全集。

**要求（判据文件是唯一验收界面）**：

1. (a) 网关 barrel 导出唯一词表 `MCP_ERROR_CODES`，形如 `Record<McpErrorCode, { message: string; retryable: boolean }>`：每条一句非空英文含义（无 CJK）+ 是否可重试；键集与 `McpErrorCode` 类型同源派生，不得两份。AC-284 已建该常量；本任务保证/收敛其形状满足 (a)。
2. (b) 新增 total record `MCP_TOOL_ERROR_CODES: Record<McpGatewayToolName, readonly McpErrorCode[]>`（仿 annotations，漏一行编译错），由 `withMcpAudit` 转发的新 `_meta` 字段（transport 的唯一 `audited` seam 传入 `readMcpToolErrorCodes(name)`）挂到每个工具的 `tools/list` 上；criterion 从**真实** `tools/list` 读回，不读手写清单。
3. (c) 复跑 AC-284 的全部探针（同一套十类错误、同一批 17 工具），断言观察到的每个 code ∈ 该工具声明的集合 ⊆ 词表键集。
4. (d) 无死 code：词表键集 ⊆ 探针可触发集 ∪ 显式豁免集；豁免必须是可机读的 `{ code, reason }` 条目，不得靠注释。
5. (e) 面向调用方的 `code:` **值位置**字面量都来自词表：用 `typescript` compiler API 对 `server/modules/mcp-gateway/*.ts`（非 tests）做语法树扫描；跳过类型位置；对 HTTP/OAuth 两处（`mcp-gateway.auth.ts` / `mcp-gateway.loopback.ts`）显式豁免并写理由；**带正例对照**——同一扫描函数喂一段含词表外字面量的合成源码，必须报出（证明扫描非空转）。
6. **不变式**：成功路径不变；不改工具参数集合、scope、handler 语义、`requiredScopes`。

**范围外（兄弟 AC，避免重复实现）**：信封形状/同类同 code/注册表驱动探针 = AC-284；`details.requiredScopes` 与两处检查形状 = AC-286；四工具 not-found 改为错误 = AC-287；`INVALID_ARGUMENT` 的 `details.fields` = AC-288；服务端文案 CJK 普查 = AC-289；OAuth/HTTP 401 与元数据 = GOAL-026。**后端改动遵守 `$backend-module-standards`**（`.agents/skills/backend-module-standards/SKILL.md`）：新文件归位、导出符号带消费方注释、跨模块消费走 barrel（`server/modules/mcp-gateway/index.ts`）。

## Plan

1. **对齐 AC-284 的 `mcp-error-envelope.ts`**：确保 `MCP_ERROR_CODES` 是 (a) 要求的 `Record<McpErrorCode,{message,retryable}>`（若 AC-284 只落地了名字集合，此处收敛为 record、让键集与 `McpErrorCode` 同源派生；若已满足，本步只核对）。若此改动触及 AC-284 判据断言，同步迁移其断言（保持强度）。
2. **新建 `server/modules/mcp-gateway/mcp-tool-error-codes.ts`**：`MCP_TOOL_ERROR_CODES`（total over `McpGatewayToolName`）+ `readMcpToolErrorCodes(name)`（未声明抛错，仿 `readMcpToolAnnotations`），导出符号带消费方注释。
3. **`mcp-gateway.audit.ts`**：给 `McpToolRegistration` 加可选 `meta` 字段，并在 `withMcpAudit` 里转发给 `registerTool`（与 `annotations` 同形；缺省不改 AC-244 形状）。
4. **`mcp-gateway.transport.ts`**：在唯一 `audited` seam 里把 `readMcpToolErrorCodes(name)` 作为 `_meta`（如 `{ 'cloudcli/errorCodes': [...] }`）传入——只加声明，不改鉴权/成功/失败任一路径。
5. **`index.ts`**：barrel 导出 `MCP_TOOL_ERROR_CODES` / `readMcpToolErrorCodes`（必要时补 `McpErrorCode`），带消费方注释。
6. **写判据 `tests/mcp-error-vocabulary.test.ts`**：沿用 `mcp-tool-annotations.test.ts` / `oauth-flow.e2e.test.ts` 的模式——真实 express + `mountMcpGateway` + SDK `Client` + `StreamableHTTPClientTransport`，先拉 `tools/list` 读 (b)，再按十类探针逐个触发得 (c)(d)；`typescript` compiler API 的扫描函数与正例对照 fixture 同文件。
7. **红先行**：先提交判据（文件不存在 → 闸退出码 1 打印缺失文件名）；再实现，记录实现后退出码 0。
8. **变异三连**（先提交实现再变异，逐条记录 mutation diff、逐字失败行、恢复命令）：(i) 让某工具返回词表外的 code ⇒ (c) 红；(ii) 往 `MCP_ERROR_CODES` 加一个无探针触发的 code ⇒ (d) 红；(iii) 在某值位置直接写字符串 code ⇒ (e) 红。
9. **计数 pin**：新增判据文件使 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` +1；同步 `server/shared/tests/quay-test-script.test.ts` 两处 `known/unknown`（以运行时实际计数为准，相对本任务落地时基线各 +1；AC-284 落地后又各 +1）。

## AC

- [x] AC1 判据文件 `server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts` 存在，且存在性闸后 `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts` 退出码 0。任务记录含红先行两段逐字输出：实现前该命令以退出码 1 打印 `缺判据文件：server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts`；实现后退出码 0。
- [x] AC2 (a) 从网关 barrel 导入的 `MCP_ERROR_CODES` 是 `Record<McpErrorCode, { message: string; retryable: boolean }>`：判据断言键集非空、键集与 `McpErrorCode` 类型成员一致（两方向）、每条 `message` 为非空英文且无 CJK、`retryable` 为 boolean；判据：本判据文件的 (a) 段。
- [x] AC3 (b) 真实 HTTP + SDK Client 拉 `tools/list`：工具名集 = `MCP_TOOL_ERROR_CODES` 键集（两方向，无漏无幻），且每个工具 `_meta` 里声明的 code 列表深等于该表该工具的行；判据：本判据文件的 (b) 段。
- [x] AC4 (c) 对全部 17 个工具跑十类错误探针，每个失败回带 `code`；断言每个观察到的 code ∈ 该工具 `MCP_TOOL_ERROR_CODES[name]`，且 ∈ `MCP_ERROR_CODES` 键集；两个包含关系都断言；判据：本判据文件的 (c) 段。
- [x] AC5 (d) `MCP_ERROR_CODES` 键集 ⊆ (探针实际触发的 code 集 ∪ 显式豁免集)，豁免集条目形如 `{ code, reason }` 且 `reason` 非空；断言不存在「既未被任何探针触发又未豁免」的 code；判据：本判据文件的 (d) 段。
- [x] AC6 (e) 用 `typescript` compiler API 扫描 `server/modules/mcp-gateway/*.ts`（非 tests）的值位置 `code:` 字面量，全部 ∈ `MCP_ERROR_CODES` 键集；类型位置（联合类型）不误报；`mcp-gateway.auth.ts`（`ACCESS_TOKEN_INVALID`）与 `mcp-gateway.loopback.ts`（`MCP_LOOPBACK_ONLY`）两处 HTTP/OAuth 层豁免带理由；正例对照：同一扫描函数对含词表外字面量的合成源码必须报出；判据：本判据文件的 (e) 段。
- [x] AC7 变异三连（先提交实现再变异，逐条记录 mutation diff、逐字失败行、恢复命令，缺一不可）：(i) 让某工具返回词表外的 code ⇒ (c) 变红；(ii) 往 `MCP_ERROR_CODES` 加一个无探针触发的 code ⇒ (d) 变红；(iii) 在某值位置直接写字符串 code ⇒ (e) 变红。
- [x] AC8 计数 pin：`server/shared/tests/quay-test-script.test.ts` 两处 `known/unknown` 按运行时实际计数同步（相对本任务落地时基线 +1），`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0。
- [x] AC9 scoped 门：`bash scripts/test.sh --for-task gap-ac285-mcp-error-code-vocabulary` 退出码 0；diff 中无删除 `assert` 或把严格断言放宽成 truthy/跳过。

## DoD

- 一个真实的 MCP 客户端（真 HTTP、SDK client）拉 `tools/list` 时，**实际看到**每个工具声明的 code 集合（`_meta`），不是测试桩里手写的结构。
- 唯一词表是实证的：源码里面向调用方的 `code` 值位置字面量都指向词表（扫描器实证 + 正例对照证明扫描非空转）；HTTP/OAuth 两处豁免写明理由。
- 每个词表 code 要么被某个探针真实触发，要么列入显式豁免并给出为什么不能触发；没有静默死 code。
- 三个变异各能让对应读法变红并记录恢复命令，不是「改完仍绿」。
- 遵守 `$backend-module-standards`：新文件按放置规则归位、导出符号带消费方注释、跨模块消费走 barrel，不下沉业务逻辑。
- 同步了测试文件计数 pin，未使全量 suite 因新增一个 `server/**/*.test.ts` 而变红。

## Worker note（2026-10-06）

红先行（提交实现前，逐字）：

- 命令：`for f in server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts`
- 实现前：退出码 1，stderr 逐字 `缺判据文件：server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts`
- 实现后：退出码 0，`tests 5 / pass 5 / fail 0`（(a)(b)(c)(d)(e) 五段全绿；日志逐字含 `vocabulary (a) vocabulary: 16 codes …`、`vocabulary (b) tools/list read back 17 tools …`、`vocabulary (c) 43 observed codes across 17 tools: all declared, all in-vocabulary`、`vocabulary (d) 16 codes: 16 covered (11 triggered, 5 exempted), 0 dead`、`vocabulary (e) scanned 28 files: 18 non-exempt value-position literals, all in-vocabulary; controls held`）

变异三连（先提交实现 `c42bc05c`，再逐条变异，每条跑完 `git checkout --` 恢复）：

- (i) mutation diff：
  `- session_send: [...WRAPPER_CODES, ...SESSION_TARGET_CODES, 'SESSION_BUSY'],`
  `+ session_send: [...WRAPPER_CODES, ...SESSION_TARGET_CODES],`
  ⇒ (c) 红，逐字失败行：`AssertionError [ERR_ASSERTION]: class/session_send: observed code SESSION_BUSY must be declared by "session_send" (declared: INVALID_ARGUMENT, INSUFFICIENT_SCOPE, INTERNAL_ERROR, SESSION_NOT_FOUND, TARGET_AMBIGUOUS)`。恢复：`git checkout -- server/modules/mcp-gateway/mcp-tool-error-codes.ts`
- (ii) mutation diff：在 `mcp-error-envelope.ts` 的 `APPROVAL_EXPIRED_OR_NOT_FOUND` 之前加
  `+ ORPHANED_CODE_NO_PROBE_MINTS: { code: 'ORPHANED_CODE_NO_PROBE_MINTS', message: 'A vocabulary entry nothing can reach.', retryable: false },`
  ⇒ (d) 红，逐字失败行：`AssertionError [ERR_ASSERTION]: these vocabulary codes are dead: neither a probe triggers them nor an exemption explains why (ORPHANED_CODE_NO_PROBE_MINTS)`；（同时 (a) 的键集双向 pin 亦红：`AssertionError [ERR_ASSERTION]: the vocabulary keys and the McpErrorCode checklist must be the same set (no extra, no missing)`）。恢复：`git checkout -- server/modules/mcp-gateway/mcp-error-envelope.ts`
- (iii) mutation diff（`mcp-approvals.ts:419`）：
  `- code: 'APPROVAL_EXPIRED_OR_NOT_FOUND',`
  `+ code: 'NOT_IN_THE_VOCABULARY',`
  ⇒ (e) 红，逐字失败行：`AssertionError [ERR_ASSERTION]: mcp-approvals.ts:419 writes code "NOT_IN_THE_VOCABULARY" in value position, which is not in MCP_ERROR_CODES`。恢复：`git checkout -- server/modules/mcp-gateway/mcp-approvals.ts`

实现摘要：`MCP_ERROR_CODES` 的值由字符串改为描述符 `{ code, message, retryable }`（`code` 镜像自身键；`as const satisfies Record<string, McpErrorDescriptor>`），`McpErrorCode = keyof typeof MCP_ERROR_CODES` 同源派生；`mcpErrorResult` / `McpToolError` 接受 `string | McpErrorDescriptor`，故既有的约 30 处 `MCP_ERROR_CODES.X` 调用点一字未改、语义不变。新文件 `mcp-tool-error-codes.ts` 是 total over `McpGatewayToolName` 的 `MCP_TOOL_ERROR_CODES` + `readMcpToolErrorCodes(name)`（未声明抛错）；`mcp-gateway.audit.ts` 的 `McpToolRegistration` 增可选 `meta` 并转发为 `registerTool` 的 `_meta`；transport 唯一 `audited` seam 传入 `meta: { 'cloudcli/errorCodes': readMcpToolErrorCodes(name) }`；barrel 补导出。

合并后复核（`git merge --no-edit develop` 干净无冲突，merge commit `3c59b5c1`）：`npx tsc --noEmit -p server/tsconfig.json` 退出码 0；AC-284 判据与 AC-285 判据同跑 `pass 12 / fail 0`；`npx tsx … --test server/shared/tests/quay-test-script.test.ts` `pass 11 / fail 0`。

scoped 门：`bash scripts/test.sh --for-task gap-ac285-mcp-error-code-vocabulary` 退出码 0，逐字尾行 `# tests 3 / # pass 3 / # fail 0 / # cancelled 0`（scoped 三文件 `mcp-error-envelope.test.ts`、`mcp-error-vocabulary.test.ts`、`quay-test-script.test.ts` 均 `passed=true`）。diff 未删除任何 `assert`，未把严格断言放宽为 truthy/跳过；`mcp-error-envelope.test.ts` 的唯一改动是 `Object.values(MCP_ERROR_CODES)` → `Object.keys(MCP_ERROR_CODES)`（词表值已由字符串改为描述符，键集才是 code 集）。

## Touches

- server/modules/mcp-gateway/mcp-error-envelope.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts (new)
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-ac285-mcp-error-code-vocabulary.md (self-touch)
