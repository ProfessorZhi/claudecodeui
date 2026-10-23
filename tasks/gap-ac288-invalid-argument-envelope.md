---
id: gap-ac288-invalid-argument-envelope
title: 参数校验失败即 INVALID_ARGUMENT 信封（AC-288）：details.fields 逐字段英文原因、message ≤300 无
  zod 转储、未知工具 UNKNOWN_TOOL 同信封，判据
  server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
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
goal_ac: AC-288
---
## Proposal

**目标 AC**：`goals/AC-288-参数校验失败返回简短-机器可读的-invalid-argument-不是整段-zod-输出.md`，goal GOAL-024（退出条件 5）。判据文件固定为 `server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts`，判据命令（带存在性闸）：

```
for f in server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
```

当前必红：判据文件不存在，存在性闸以退出码 1 打印 `缺判据文件：server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts`。

**现状（源码核实，非推测）**——SDK 1.29.0 的默认校验形态正是 AC 要替换的：

1. `McpServer` 构造时用 `this.server.setRequestHandler(CallToolRequestSchema, …)` 安装 tools/call 分发器（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:102`）。未知工具抛 `McpError(ErrorCode.InvalidParams, \`Tool ${name} not found\`)`（`:104`）；参数校验经 `validateToolInput` 的 `safeParseAsync`，失败抛 `McpError(InvalidParams, \`Input validation error: Invalid arguments for tool ${toolName}: ${getParseErrorMessage(error)}\`)`（`:167-178`）。
2. 该分发器的 `catch` 把所有异常（含上述两根 McpError）交给 `createToolError(message)`（`mcp.js:135-145`），返回 `{ content:[{type:'text', text: message}], isError:true }`。于是调用方实际收到的是：`isError:true` 的一句**纯文本**，**没有 `structuredContent`、没有 `code`**，`message` 是整段 zod/JSON 输出（可远超 300 字符），未知工具是 `Tool X not found` 文本而不是 `UNKNOWN_TOOL`。
3. 网关自己的注册 seam 是 `withMcpAudit`（`server/modules/mcp-gateway/mcp-gateway.audit.ts:245-319`），它在 `server.registerTool` 上把各工具的 zod raw shape 作为 `inputSchema` 交给 SDK（`:251`），**没有接管 `tools/call` 的低层处理器**：`grep -n "CallToolRequestSchema" server/modules/mcp-gateway/*.ts` 当前只在 `mcp-gateway.transport.ts:128` 命中 `ListToolsRequestSchema`，`CallToolRequestSchema` 零命中。
4. 生产工具统一经 `mcp-gateway.transport.ts:142-163` 的 `audited` seam 进入 `withMcpAudit`；`McpToolRegistration.inputSchema`（`:170`）就是校验真值来源，不需要第二份名字→形状表。
5. 现有入参约束：必填见于 `session_send`（`session`/`message`）、`session_cancel_queued`（`session`/`messageUuid`）、`session_create`（`project`）、`approval_answer`（`requestId`/`allow`）、`session_reconfigure`/`session_background`（`session`）；枚举见于 `session_read.mode`（`['latest','outline','around']`）与 `sessions_list.state`（`['running','idle','resident','any']`）。**当前没有任何 schema 声明 `minimum`/`maximum` 或互斥约束**（`grep -n "\.min(\|\.max(\|\.refine(" server/modules/mcp-gateway/*.ts` 无非业务命中）——(a) 的这两类读数必须由实现真实表达（见 Plan 第 3 步），不能只在测试里假设。

**要交付（判据文件是唯一验收界面）**：

1. **五类参数失败一律信封**：缺必填 / 类型错 / 枚举外 / 超出 `minimum` 或 `maximum` / 同时给出互斥参数，每个都返回 `{ isError:true, structuredContent:{ code:'INVALID_ARGUMENT', message, retryable, details:{ fields:[…] } } }`。
2. **`details.fields` 是数组**，每项 `{ path, problem }`：`path` 是参数路径（点号连接，如 `message`；嵌套/数组下标同样可读），`problem` 是一句英文原因（如 `required`、`expected string`、`must be one of \"latest\",\"outline\",\"around\"`、`must be >= 0`、`must be <= N`、互斥的英文说明）。AC 原文示例：`{ path: "message", problem: "required" }`。
3. **`message` ≤ 300 字符**，且不含原始的 zod / JSON Schema 转储：不得出现 zod issue 的序列化结构（`"code":"invalid_type"` / `"path":[…]` / `"expected":"…"` 等整段），不得是 `Input validation error: Invalid arguments for tool …` 这类 SDK 原文。`message` 必须是一句可读英文，无 CJK。
4. **未知工具**：`{ isError:true, structuredContent:{ code:'UNKNOWN_TOOL', message, retryable } }`，同样是这个信封；SDK 的 `Tool X not found` 文本不得成为调用方唯一/主要的信息载体。
5. **合法调用不受影响（正例对照）**：同批工具用合法参数调用仍非错误，成功形状与现状一致（含 output schema 行为不变）。
6. **校验真值与 `tools/list` 同源**：校验读的是注册时声明的 `inputSchema`；若为覆盖 (a) 的 min/max 与互斥而给真实 schema 加约束，`tools/list` 广告的 JSON Schema 必须与校验同源，并同步迁移断言 schema 的既有判据。
7. **既有判据移植**：凡断言旧校验形状的既有测试只许迁移到新形状、断言强度不降，任务记录里逐条列旧→新。

**机制（须实证选择并记录）**：在 tools/call 的单一分发点接管校验。推荐：`withMcpAudit` 注册工具时把 `{ name, inputSchema }`（真值）登记到该 server 的注册表，并在低层 `server.server` 上用 `setRequestHandler(CallToolRequestSchema, …)` 安装分发器——未知名字 ⇒ `UNKNOWN_TOOL` 信封；`z.object(inputSchema)`（必要时含 object-level refine）`safeParse` 失败 ⇒ `ZodError.issues` 映射为 `INVALID_ARGUMENT.details.fields`；成功 ⇒ 走该工具的（audited）回调并按现状渲染结果（含 output schema 行为）。备选：在 transport 层把 SDK 的 `McpError` 渲染改写为信封。任一选择都必须证明对合法调用与既有行为零回归（既有 mcp-transport / mcp-audit / mcp-read-tools 判据仍绿）。

**实现纪要（实证后落定）**：取推荐路线，且**用工具真实的声明 schema 注册**（而非 `z.object(rawShape)` 重建），使 `tools/list` 广告与校验同源（AC6）。`withMcpAudit` 把回调提为工厂 `createAuditedRunner`，同一函数对象既交给 `registerTool` 又记入模块级 `WeakMap<McpServer, Map<string, McpAuditedRunner>>`；全部注册完成后 `installMcpCallDispatcher(server)` 用 `server.server.setRequestHandler(CallToolRequestSchema, …)` 整体替换 SDK 分发器：未知名 ⇒ `unknownToolResult(name)`；已知名 ⇒ 其 audited runner。约束以真实 schema 表达：`session_read` 的 `inputSchema` 升为 `ZodObject` + `.superRefine()`（`aroundId` 与 `cursor` 互斥）、`limit` 声明 `.int().min(1).max(200)`。因 `_zod` 判别而把注册槽类型 `inputSchema` 放宽为 `z.ZodRawShape | z.ZodType`（`McpToolInputSchema`）。

<!-- dedup-ref -->
**关系与范围**：本任务消费 `gap-ac284-mcp-error-envelope` 交付的 `server/modules/mcp-gateway/mcp-error-envelope.ts`（`MCP_ERROR_CODES` 含 `INVALID_ARGUMENT` / `UNKNOWN_TOOL`、信封构造器、`toMcpErrorResult`），关系边由顶层 `depends_on` 字段声明；开工时先读该文件是否存在，缺失就停手报告（这是排序问题，不另起第二份信封模块）。AC-284 正文已显式把「更细的 `details.fields`」让给本任务。范围外（兄弟 AC，避免重复实现）：信封形状本身 / 同类同 code / 注册表驱动探针表 = AC-284；code 词表唯一来源与每工具声明 = AC-285；`INSUFFICIENT_SCOPE` + `details.requiredScopes` = AC-286；四工具 not-found = AC-287；服务端文案 CJK 普查 = AC-289。本任务只做 `INVALID_ARGUMENT` + `details.fields` + 简短 `message` + `UNKNOWN_TOOL` + 正例对照 + 既有判据移植。

后端改动遵守 `$backend-module-standards`（`.agents/skills/backend-module-standards/SKILL.md`）：新文件归位 mcp-gateway 模块、导出符号带消费方注释、跨模块消费走 barrel（`server/modules/mcp-gateway/index.ts`），不下沉业务逻辑。

## Plan

1. **读依赖**：确认 `server/modules/mcp-gateway/mcp-error-envelope.ts` 存在且导出 `MCP_ERROR_CODES`（含 `INVALID_ARGUMENT`、`UNKNOWN_TOOL`）与信封构造器；不存在则停手报告。
2. **信封模块**：在 `mcp-error-envelope.ts` 增加/确认 `INVALID_ARGUMENT` 的 `fields` 变体构造，以及 `ZodError.issues → { path, problem }[]` 的映射辅助（导出并带消费方注释）。若 AC-284 已提供 `toMcpErrorResult`，只补 fields 映射与 `UNKNOWN_TOOL` 的构造入口，不重复实现信封本体。
3. **约束表达（覆盖 min/max 与互斥）**：选 1–2 个真实工具，把这两类约束写进其 `inputSchema` 真值——例如给 `run_get.waitSeconds`（或 `session_send.waitSeconds`）声明数值上下界；给 `session_read` 声明互斥（如 `aroundId` 与 `cursor`/`before`/`after` 不得同时给出，或 `mode` 与 `aroundId` 的一致性）。若裸 `ZodRawShape` 的注册槽装不下 object-level `.refine()`，则把该槽扩展为可接受 `ZodObject` 对象 schema（或新增可选 refine 槽），并保证 `tools/list` 广告与校验同源。每处改动记旧→新，并同步迁移断言这些 schema 的既有测试。
4. **校验 seam**：在 `withMcpAudit` 注册时登记 `{ name, inputSchema }`（真值，所有注册路径——`registerTools` seam 与 read/write/resident seam——都经过它）；在低层 `server.server` 安装 `CallToolRequestSchema` 分发器：未知 ⇒ `UNKNOWN_TOOL`；校验失败 ⇒ `INVALID_ARGUMENT` + `details.fields`；合法 ⇒ 现有回调路径（保持 output schema 与成功形状不变）。不改变任何工具的参数集合、scope、handler 语义。
5. **barrel**：`index.ts` 导出新符号（fields 映射 / 分发器入口如需），带消费方注释。
6. **判据 `tests/mcp-invalid-argument.test.ts`（红先行）**：真实 express + `mountMcpGateway`（或 `createMcpGatewayModule` 装配）+ `@modelcontextprotocol/sdk` 的 Client + StreamableHTTP transport，真签发令牌（沿用 `mcp-audit.test.ts` / `oauth-flow.e2e.test.ts` 的真 HTTP + 临时 `DATABASE_PATH`/`HOME` 模式），读五组读数：
   - (a) 五类失败各返回 `isError===true` 且 `structuredContent.code==='INVALID_ARGUMENT'`；写下逐类逐字读数。
   - (b) 每类失败 `details.fields` 是非空数组，每项有 `path`（字符串）与 `problem`（非空英文、无 CJK）；断言 `{ path:'message', problem:'required' }` 这一项（AC 原文示例）。
   - (c) `message.length <= 300`，且不含 zod/JSON Schema 转储特征（断言不含 zod issue 序列化、不含 `Input validation error:` SDK 原文、无 CJK）。
   - (d) 未知工具（如 `{ name:'definitely_not_a_tool', arguments:{} }`）返回 `isError===true` 且 `code==='UNKNOWN_TOOL'`，信封形状与前同族。
   - (e) 正例对照：合法参数调用上述工具（至少覆盖被加约束的工具）`isError` 非真、成功形状与现状一致。
7. **移植既有判据**：若既有测试断言旧校验形状（当前 grep 未见 `Input validation error` / `INVALID_ARGUMENT` / `UNKNOWN_TOOL` 命中，但仍须核对 `mcp-transport` / `mcp-audit` / `mcp-read-tools` / `mcp-run-get`），逐条迁移并在记录里列旧→新。
8. **变异（先提交实现再变异，逐条记录 mutation diff、逐字失败行、恢复命令）**：(i) 让校验回到 SDK 默认整段输出 ⇒ (c) 必须红；(ii) 缺 `details.fields` ⇒ (b) 必须红；(iii) 未知工具回到 SDK 的 `Tool X not found` 文本 ⇒ (d) 必须红（AC 明列 (i)(ii)，(iii) 一并做）。
9. **计数 pin 同步**：新增一个 `server/**/*.test.ts` 使 `server/shared/tests/quay-test-script.test.ts` 两处 `known/unknown` 变红。不照抄写死数字——先跑 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 取当时实际 N（本任务落案基线 N=237），按两条构造式写：`known=3 unknown=N-3`（`:154`）与 `known=1 unknown=N-1`（`:203`）。
10. **仓库门**：`npm run typecheck` / `npm run lint`（无 error 级）/ `npm run build` 退出码 0；`bash scripts/test.sh --for-task gap-ac288-invalid-argument-envelope` 退出码 0。

## AC

- [x] AC1 判据文件 `server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts` 存在，且存在性闸后 `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts` 退出码 0。任务记录含红先行两段逐字输出：实现前该命令以退出码 1 打印 `缺判据文件：server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts`；实现后退出码 0。
  **证据**：红先行（实现前）——同一命令 exit 1，stderr 逐字 `缺判据文件：server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts`；存在性闸可复现——对不存在的同名路径跑同一段闸 exit 1，逐字 `缺判据文件：server/modules/mcp-gateway/tests/mcp-ac288-absent.test.ts`。实现后——exit 0，stdout 逐字 `ℹ tests 4` / `ℹ pass 4` / `ℹ fail 0`。
- [x] AC2 (a) 真实 HTTP + MCP SDK 客户端，五类参数失败（缺必填、类型错、枚举外、超出 `minimum`/`maximum`、互斥参数同给）各返回 `isError===true` 与 `structuredContent.code==='INVALID_ARGUMENT'`；`retryable` 为 boolean；判据：本判据文件的 (a) 段。写下逐类逐字读数与所用工具/参数。
  **证据**：(a) 段真实 HTTP + SDK Client（真签发 access token，经 `mountMcpGateway` 的 `/mcp`）；五类均 `isError===true`、`code==='INVALID_ARGUMENT'`、`retryable` 为 boolean（读数均为 `false`）。逐类（工具/参数 → 逐字 `details.fields`）：缺必填 `session_send{session:'sess-1'}` → `[{"path":"message","problem":"required"}]`；类型错 `session_get{session:5}` → `[{"path":"session","problem":"expected string"}]`；枚举外 `sessions_list{state:'bogus'}` → `[{"path":"state","problem":"must be one of \"running\", \"idle\", \"resident\", \"any\""}]`；超上界 `session_read{session:'sess-1',limit:9999}` → `[{"path":"limit","problem":"must be <= 200"}]`；互斥同给 `session_read{session:'sess-1',aroundId:'turn-1',cursor:'page-2'}` → `[{"path":"aroundId","problem":"aroundId and cursor cannot be combined; name only one."}]`。
- [x] AC3 (b) 每类失败的 `structuredContent.details.fields` 是非空数组，每项含字符串 `path` 与非空英文（无 CJK）`problem`；断言含 `{ path:'message', problem:'required' }`（AC 原文示例）；判据：本判据文件的 (b) 段。
  **证据**：(b) 段断言每类 `details.fields` 非空，且每项**恰为** `{path, problem}` 两键、两值均为非空字符串、`problem` 无 CJK；并显式断言 AC 原文示例项 `{ path: 'message', problem: 'required' }`（缺必填一类）。五组读数见 AC2。与实现前对照：`problem` 不再来自整段 zod，而由 `problemForIssue` 生成——`invalid_type` 经 `valueAtPath(args, issue.path)` 区分「缺失 ⇒ `required`」与「类型错 ⇒ `expected <type>`」。
- [x] AC4 (c) 每类失败 `message.length <= 300`，且不含原始 zod/JSON Schema 转储（不含 zod issue 序列化结构、不含 SDK 的 `Input validation error:` 原文、无 CJK）；判据：本判据文件的 (c) 段。
  **证据**：(c) 段六次失败读数（五类 + 未知工具）的 `message` 长度逐字为 51 / 50 / 50 / 49 / 52 / 63 字符，均 ≤300；断言不含 `DUMP_MARKERS = ['input validation error','zoderror','zod','invalid_type','invalid_value','too_small','too_big','received']` 任一、无 CJK，且 `JSON.parse(message)` 必须抛（message 不是序列化结构）。
- [x] AC5 (d) 未知工具返回 `isError===true` 且 `structuredContent.code==='UNKNOWN_TOOL'`，信封形状与 INVALID_ARGUMENT 同族（含 `message`/`retryable`）；判据：本判据文件的 (d) 段。
  **证据**：(d) 段 `{ name:'no_such_tool_zzz', arguments:{} }` → `isError===true`、`code==='UNKNOWN_TOOL'`、`retryable===false`，信封同族（同 `code`/`message`/`retryable`/`details` 形状）。非空洞性由同批 `listClient.listTools()` 证明 `no_such_tool_zzz` 不在已注册名字集合内；文本不含 `'not found'`（不复用 SDK 原文）且点明该工具名。
- [x] AC6 (e) 正例对照：合法参数调用（至少覆盖被加了 min/max 与互斥约束的工具）`isError` 非真；`tools/list` 广告的参数 schema 与校验同源、参数集合语义未变；判据：本判据文件的 (e) 段。
  **证据**：(e) 段八个合法调用（含被加约束的 `session_read`/`sessions_list`）全部 `isError===false`；`sessions_list`/`session_read`/`session_send`/`session_get` 的 `tools/list` 广告参数键集合与 `DECLARED_KEYS` 逐键相等（无增删键）；广告边界与校验消息同源——`session_read.limit` 广告 `type:'integer'`、`minimum===1`、`maximum===200`，失败消息逐字 `must be <= 200` 与之对应。
- [x] AC7 变异先红后恢复，逐条记录 mutation diff、逐字失败行、恢复命令：(i) 校验回到 SDK 默认整段输出 ⇒ AC4 红；(ii) 缺 `details.fields` ⇒ AC3 红；(iii) 未知工具回到 SDK 文本 ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
  **证据**：实现已提交 `0f39aae9`，故可复现的恢复命令为 `git checkout -- server/modules/mcp-gateway/mcp-gateway.audit.ts`（变异当时实现尚未提交，恢复为反向应用同一处 one-line diff，恢复后重跑绿）。
  (i) mutation diff：`invalidArgumentResult` 内 `- invalidArgumentMessage(tool, fields)` → `+ error.message`；逐字失败行 exit 1：`✖ (c) … AssertionError [ERR_ASSERTION]: missing required argument: envelope.message must not carry the dump marker "invalid_type", saw "[\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"message\"\n    ],\n    \"message\": \"Invalid input: expected string, received undefined\"\n  }\n]"`；恢复后重跑 exit 0（4/4 绿）。
  (ii) mutation diff：`mcpErrorResult(..., false, { fields })` 去掉第三参 → `- false,\n- { fields },` → `+ false,`；逐字失败行 exit 1：`✖ (a)/(b) … AssertionError [ERR_ASSERTION]: missing required argument: an INVALID_ARGUMENT envelope must carry details`；恢复后重跑 exit 0。
  (iii) mutation diff：`installMcpCallDispatcher` 未知分支 `- return unknownToolResult(request.params.name);` → `` + return { content: [{ type: 'text' as const, text: `Tool ${request.params.name} not found` }], isError: true }; ``；逐字失败行 exit 1：`✖ (d) … AssertionError [ERR_ASSERTION]: unknown tool: a failure must carry a structuredContent object (no plain-text-only failures)`（(c) 段因同一原因同时红）；恢复后重跑 exit 0。
- [x] AC8 既有判据移植、强度不降：凡断言旧校验/schema 形状的既有测试逐条迁移（核对 `mcp-transport.test.ts`、`mcp-audit.test.ts`、`mcp-read-tools.test.ts`、`mcp-run-get.test.ts` 及任何因本任务加约束而受影响者），diff 中无删除 `assert`、无放宽为 truthy/skip；任务记录逐条列旧断言→新断言。`bash scripts/test.sh --for-task gap-ac288-invalid-argument-envelope` 退出码 0。
  **证据**：逐条旧→新：
  - `tests/mcp-error-envelope.test.ts`：`CLASS_PROBES.未知工具` 由 `kind:'exempt'`（断言 `structuredContent === undefined`，即「无信封」）**迁移**为 `kind:'envelope', expect:'UNKNOWN_TOOL'`；原豁免分支里的 `if (probe.tool === 'no_such_tool') { … }` 死分支及其随附断言被移除，改由 `assertEnvelope` 承接——同一 `isError===true` 断言被保留并**加强**（新增 `code`/`message`/`retryable`/无 CJK 断言），断言强度不降。该文件头部原称未知工具是本任务「不能封装的第三类」的段落同步改写。
  - `tests/mcp-transport.test.ts` / `tests/mcp-audit.test.ts` / `tests/mcp-read-tools.test.ts` / `tests/mcp-run-get.test.ts`：核对后无断言旧校验文本（`Input validation error` / `Tool … not found`）或旧 schema 形状者；`mcp-read-tools.test.ts` 断言 `tool.inputSchema.type === 'object'` 仍成立（`session_read` 的 `ZodObject` 经 `toJsonSchemaCompat` 广告 `type:'object'`），故四文件零改动且各自全绿（4/0、5/0、6/0、7/0）。
  `bash scripts/test.sh --for-task gap-ac288-invalid-argument-envelope` 退出码 0（6 个判据文件，`# fail 0`）。
- [x] AC9 计数 pin 同步：`server/shared/tests/quay-test-script.test.ts` 两处 `known/unknown` 按实现时实际计数写入（先取 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实际 N，再写 `known=3 unknown=N-3` 与 `known=1 unknown=N-1`），`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0。写下 N 的读数与改后的两个 pin 字符串。
  **证据**：实现时读数 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` = **242**（新增本判据文件后）；Plan 第 9 步记的基线 237 已过时，改前实际为 241。改后两处 pin 逐字：`:154` 行 `… known=3 unknown=239`、`:203` 行 `… known=1 unknown=241`。`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0（11 pass / 0 fail）。
- [x] AC10 仓库门：`npm run typecheck` 退出码 0；`npm run lint` 无 `: error `（只看 error 级）；`npm run build` 退出码 0。写明三条命令退出码与 lint error 计数。
  **证据**：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0 且 `: error ` 计数 = 0（改动文件上无诊断）；`npm run build` 退出码 0（仅写 gitignore 产物）。
- [x] AC11 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 `task_write` 加进 Touches 再写。列出实际改动文件清单。
  **证据**：`git diff --stat develop...HEAD` 共 10 个文件：`server/modules/mcp-gateway/index.ts`(+25)、`server/modules/mcp-gateway/mcp-error-envelope.ts`(+114)、`server/modules/mcp-gateway/mcp-gateway.audit.ts`(+416)、`server/modules/mcp-gateway/mcp-gateway.read-tools.ts`(+54)、`server/modules/mcp-gateway/mcp-gateway.transport.ts`(+18)、`server/modules/mcp-gateway/mcp-overview-tools.ts`(+9)、`server/modules/mcp-gateway/mcp-run-get.ts`(+8)、`server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts`(+47)、`server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts`(new, +677)、`server/shared/tests/quay-test-script.test.ts`(+4)。其中 `mcp-overview-tools.ts`（放宽 `McpOverviewRegistration.inputSchema` 类型）与 `tests/mcp-error-envelope.test.ts`（迁移未知工具断言）为本任务被迫改动的 **Touches 外**文件，已按 AC11 先用本 `task_write` 加入 `## Touches` 再写；其余全部在 Touches 内；`tasks/gap-ac288-invalid-argument-envelope.md` 为 self-touch。

## DoD

- 一个真实的 MCP 客户端（真 HTTP、SDK client、真签发 access token）对五类参数失败与未知工具**实际收到**的是 `isError:true` + `structuredContent.code ∈ {INVALID_ARGUMENT, UNKNOWN_TOOL}` + `details.fields`，不是 SDK 默认的纯文本 `createToolError`——即新形状经由网关真实的 tools/call 分发路径到达线上，不是测试桩伪造。
- `message` 真的简短可读（≤300、无 zod 转储），`details.fields` 真的逐项带参数路径与英文原因；`UNKNOWN_TOOL` 真的与 `INVALID_ARGUMENT` 同信封族。
- 正例成立：合法调用真的不被误伤（至少覆盖被加 min/max 与互斥约束的工具），证明判据不是靠「一律拒绝」通过。
- 三条变异各能让对应读法变红并记录恢复命令，不是「改完仍绿」。
- 既有断言旧形状的判据真的迁移到新形状且断言强度不降，不是删除/放宽/改成 `assert.ok(真)`。
- 遵守 `$backend-module-standards`：新符号按放置规则归位、导出符号带消费方注释、跨模块消费走 barrel，不下沉业务逻辑。
- 同步了测试文件计数 pin，未使全量 suite 因新增一个 `server/**/*.test.ts` 而变红。

## Touches

- server/modules/mcp-gateway/mcp-error-envelope.ts
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-run-get.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts (new)
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/tests/mcp-transport.test.ts
- server/modules/mcp-gateway/tests/mcp-audit.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-run-get.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-ac288-invalid-argument-envelope.md (self-touch)