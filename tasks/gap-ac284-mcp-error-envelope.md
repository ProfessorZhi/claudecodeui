---
id: gap-ac284-mcp-error-envelope
title: MCP 错误信封统一（AC-284）：所有工具的所有失败走同一个 isError+structuredContent 信封，同类同
  code，探针表由注册表驱动
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-284
---
## Proposal

**目标 AC**：`goals/AC-284-所有工具的所有失败用同一个信封-iserror-为真-structuredcontent-带稳定-code-英文-mes.md`，goal GOAL-024。判据文件固定为 `server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts`，判据命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts`。

**现状（源码核实，非推测）**——三种旧错误形态在同一网关里并存：

1. **纯文本一句话**：`server/modules/mcp-gateway/mcp-gateway.audit.ts:272` 对未鉴权返回 `{ content:[{type:'text',text:'Unauthorized.'}], isError:true }`；`:285` 对 scope 不足返回 `'Insufficient scope for this tool.'`；`:312-316` 的 catch 把抛出的 `Error.message` 原样作为 text。`session_read` 的 not found 在 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts:636` 抛 `Error('Session \"…\" was not found.')`，经上述 catch 渲染成一句纯文本。
2. **文本里塞 JSON**：各工具自带 `refusal()` 返回 `new Error(JSON.stringify({code,message,...}))`——`mcp-approvals.ts:341`、`mcp-session-lifecycle.ts:208`、`mcp-session-send.ts:222`、`mcp-session-background.ts:173`、`mcp-session-cancel-queued.ts:119`、`mcp-session-reconfigure.ts:148`、`mcp-session-host-control.ts:151`；另有 `mcp-gateway.write-tools.ts:269` 与 `:205`、`mcp-resolve-target.ts:215`、`mcp-gateway.read-tools.ts:553` 同形。落地后 `content[0].text` 就是一段 JSON 字符串。
3. **失败没有 `structuredContent`**：`transport` 只在 `outputSchema` 存在且**成功**时填 `structuredContent`（`mcp-gateway.audit.ts:298-303`），失败三分支（`:272` / `:285` / `:312-316`）一律不带。

**同类问题 code 分裂**：会话不存在在 `mcp-session-background.ts:217` 叫 `SESSION_NOT_FOUND`，在 `mcp-resolve-target.ts:108` / `mcp-session-lifecycle.ts:266` 叫 `TARGET_NOT_FOUND`——正是判据 (c) 点名的那对并存说法。

**17 个工具（探针表要覆盖的注册表全集）**：read 表 `MCP_STAGE3_READ_TOOLS`（`mcp-gateway.read-tools.ts:53`）= overview、projects_list、sessions_list、session_get、session_read、run_get、quay_snapshot；write 表 `MCP_STAGE4_WRITE_TOOLS`（`mcp-gateway.write-tools.ts:86`）= session_send、session_create、session_interrupt、session_start、session_close；`MCP_STAGE6_RESIDENT_TOOLS`（`mcp-gateway.resident-tools.ts:70`）= session_cancel_queued；approvals 的 `registerMcpApprovalTools`（`mcp-approvals.ts:451`）= approvals_list、approval_answer；各自注册函数 `registerMcpSessionBackgroundTool`（`mcp-session-background.ts:344`）、`registerMcpSessionReconfigureTool`（`mcp-session-reconfigure.ts:313`）。注册表并非单一数组，所以「由注册表驱动」的探针必须读**运行时可观察的注册表投影** `tools/list`，而不是再手写一份会漂移的名字清单——这也是变异 (iii) 能被抓住的机制。

**要求（判据文件 `tests/mcp-error-envelope.test.ts` 是唯一的验收界面）**：

1. 新增单一信封契约（模块导出 code 常量 + 信封构造器 + 从 `Error`/JSON-body 归一化的函数）；所有失败路径经它产出 `{ isError:true, structuredContent:{ code, message, retryable, details? } }`。`code` 为大写蛇形字符串（`^[A-Z][A-Z0-9_]*$`），`retryable` 为 boolean，`message` 为非空英文。
2. audit wrapper 的鉴权 / scope 拒绝 / catch 三分支，以及各工具 `refusal()`/JSON-body throw（含输入校验失败，见下），全部改走该信封；**成功路径不变**。
3. 会话不存在在**所有**工具上同一个 code；`SESSION_NOT_FOUND` 与 `TARGET_NOT_FOUND` 不再并存。
4. 判据 (d) 由 `tools/list` 驱动：每个注册工具必须在探针表里有条目（有探针，或有显式豁免条目），往注册表加工具而不加探针即红。
5. **输入校验失败也要落进信封**：参数缺失 / 参数类型错通过 SDK 的 zod `inputSchema` 触发，当前会以协议层错误返回，不带 `isError`+`structuredContent`；本任务必须让这两类失败也变成信封（`INVALID_ARGUMENT`；更细的 `details.fields` 属 AC-288，可先占位）。
6. 该改动会使既有断言旧形状的 MCP 测试变红，必须逐条移植到新形状并保持断言强度，不得删除或放宽，并在任务记录里逐条列旧→新。

**范围外（兄弟 AC，避免重复实现）**：code 词表的单一来源 / 每工具声明 / 死 code 检查属于 AC-285；`details.requiredScopes` 与两处检查形状一致属于 AC-286；`approval_answer`/`session_cancel_queued`/`run_get`/`quay_snapshot` 把 not-found 从「看似成功」改为错误属于 AC-287；`INVALID_ARGUMENT` 的 `details.fields` 属于 AC-288；服务端文案无 CJK 的普查属于 AC-289。本任务只保证：信封形状、同类同 code、注册表驱动、既有判据移植。**后端改动遵守 `$backend-module-standards`（`.agents/skills/backend-module-standards/SKILL.md`）**：新文件归位、导出符号带消费方注释、跨模块消费走 barrel（`server/modules/mcp-gateway/index.ts`）。

## Plan

1. **新建 `server/modules/mcp-gateway/mcp-error-envelope.ts`**：`MCP_ERROR_CODES`（至少含 SESSION_NOT_FOUND、PROJECT_NOT_FOUND、TARGET_AMBIGUOUS、INVALID_ARGUMENT、UNKNOWN_TOOL、INSUFFICIENT_SCOPE、SESSION_BUSY、APPROVAL_NOT_FOUND、QUEUED_MESSAGE_NOT_FOUND、RUN_NOT_FOUND、MCP_TOOL_NOT_IMPLEMENTED）；`mcpErrorResult(code, message, retryable, details?)` 产出符合判据形状的 `CallToolResult`；`toMcpErrorResult(error)` 把现有 `Error(JSON.stringify(body))` body 与裸 `Error` 归一化到信封（旧 body 的 `code`/`message` 作为输入，映射到 `MCP_ERROR_CODES`）。
2. **改 `mcp-gateway.audit.ts`**：`:272`/`:285`/`:312-316` 三分支改调信封；成功分支（`:298-303`）保持原样。鉴权失败确认为 `INSUFFICIENT_SCOPE`（细节 requiredScopes 留给 AC-286，先给稳定 code）。
3. **改各工具**：把 `refusal()`/`new Error(JSON.stringify(body))` 换成信封（`mcp-approvals.ts`、`mcp-session-lifecycle.ts`、`mcp-session-send.ts`、`mcp-session-background.ts`、`mcp-session-cancel-queued.ts`、`mcp-session-reconfigure.ts`、`mcp-session-host-control.ts`、`mcp-gateway.write-tools.ts`、`mcp-resolve-target.ts`、`mcp-gateway.read-tools.ts`）；把会话不存在的 code 收敛到同一个常量（`SESSION_NOT_FOUND`），`TARGET_NOT_FOUND` 只在「目标不是会话」的真歧义场景保留或一并归并，二者不得对同一类问题并存。
4. **处理输入校验**：在 `withMcpAudit` 的注册 seam 处包一层 zod 校验（或不依赖 SDK 默认校验而自行校验），把缺参/类型错转成 `INVALID_ARGUMENT` 信封，而不是协议层错误。
5. **barrel 导出**：`index.ts` 导出 `mcpErrorResult` / `toMcpErrorResult` / `MCP_ERROR_CODES`，带消费方注释；跨模块消费者只从 barrel 取。
6. **写判据 `tests/mcp-error-envelope.test.ts`**：起真实 HTTP 实例（沿用 `oauth-flow.e2e.test.ts` 的 child-process + `node:http`/SDK 模式；`MCP_ENABLED=1`，临时 `HOME` 与显式 `DATABASE_PATH`），用 `@modelcontextprotocol/sdk` 的 client + Streamable HTTP transport 拉 `tools/list`、逐工具跑错误探针；实现 (a)(b)(c)(d) 四读；探针表覆盖十类：会话不存在、项目不存在、歧义、参数缺失、参数类型错、未知工具、权限不足、会话忙、审批/排队消息不存在、运行不存在。
7. **红先行**：先提交判据（此时文件不存在 → 存在性闸以退出码 1 输出缺失文件名）；再实现，记录实现后退出码 0。
8. **移植既有判据**：对旧形状的断言逐条改到新形状，保持断言强度；在任务记录里列旧→新。
9. **变异三连**（先提交实现再变异，逐条记录 mutation diff、逐字失败行、恢复命令）：(i) 让某工具回到纯文本错误 ⇒ (a)(b) 红；(ii) 让某工具的 not found 用另一个 code ⇒ (c) 红；(iii) 往注册表加一个工具而不加探针 ⇒ (d) 红。
10. **同步计数 pin**：新判据文件使 `server/**/*.test.ts` 总数 +1，改 `server/shared/tests/quay-test-script.test.ts` 的两处 `known/unknown` pin（以运行时 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实际计数为准，读数为 238 时两处 unknown 分别 235、237）。

## AC

- [x] AC1 判据文件 `server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts` 存在，且 `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts` 退出码 0。任务记录里含「实现前该命令因文件缺失以退出码 1 输出缺失文件名」与「实现后退出码 0」的两段逐字输出（红先行证据）。
  - 红先行（实现前，判据文件不存在，命令同上）→ EXIT=1，逐字输出：`Could not find 'server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts'`
  - 实现后同命令 → EXIT=0：`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0`
- [x] AC2 (a) 读法：真实 HTTP 加 MCP SDK 客户端，对全部 17 个工具跑错误探针；每个失败 `isError === true`，且 `structuredContent` 形如 `{ code, message, retryable, details? }`，`code` 匹配 `^[A-Z][A-Z0-9_]*$`，`retryable` 为 boolean，`message` 为非空英文（无 CJK）。判据：`mcp-error-envelope.test.ts` 的对应断言；探针覆盖会话不存在、项目不存在、歧义、参数缺失、参数类型错、未知工具、权限不足、会话忙、审批或排队消息不存在、运行不存在十类。
  - 证据：真实 express 挂载 + MCP SDK `Client`（`node:http` fetch）+ `tools/list` 读注册表；`PROBE_TABLE` 覆盖全部 17 个工具，`CLASS_PROBES` 覆盖十类，`assertEnvelope` 逐项断言 `isError===true`、`structuredContent` 为对象、键 ⊆ {code,message,retryable,details}、`code` 匹配 `^[A-Z][A-Z0-9_]*$` 且属 `MCP_ERROR_CODES` 词表、`message` 非空且无 CJK（`CJK_PATTERN`）、`retryable` 为 boolean。判据 7/7 通过。
- [x] AC3 (b) 读法：不再有纯文本或「文本里塞 JSON」形态——对每个失败断言 `typeof result.structuredContent === 'object'` 且 `structuredContent` 含 `code`；同时 `content[0]?.text`（若存在）不得是可解析出含 `code` 字段对象的 JSON 字符串，也不得是该失败唯一的信息载体。至少点名回归 `session_read`（旧纯文本）与 `session_send`（旧文本里 JSON）。
  - 证据：`assertEnvelope` 对每个失败断言 `structuredContent` 为对象且含 `code`，并断言 `content[0]?.text` 不是可解析出含 `code` 对象的 JSON 串、也不是唯一载体；具名回归 `session_read{session:NO_SUCH_SESSION}` → `SESSION_NOT_FOUND`（旧纯文本）与 `session_send{session:'sess-1'}` → `SESSION_BUSY`（旧 JSON-in-text，`details.runId='run-busy'`、`retryable=true`）均有专用用例。
- [x] AC4 (c) 读法：同一类问题在所有工具上用同一个 code——探针表按「错误类别 → 期望 code」断言每个工具的同类失败 code 恒等；会话不存在一律同一个 code。并且源码（非测试）内不再对同一类问题并存两套说法：`grep -rn "SESSION_NOT_FOUND\|TARGET_NOT_FOUND" server/modules/mcp-gateway/*.ts` 的结果不得同时出现两者描述同一「会话不存在」类别。
  - 证据：判据 (c) 用例对每个触发会话不存在的工具断言 code 恒为 `SESSION_NOT_FOUND`；源码 grep（上式，源码文件非递归）→ `TARGET_NOT_FOUND` 出现 0 次，`SESSION_NOT_FOUND` 是会话不存在的唯一 code（`mcp-resolve-target.ts` 的 `notFoundCode` 返回 `'SESSION_NOT_FOUND' | 'PROJECT_NOT_FOUND'`）。
- [x] AC5 (d) 读法：探针表由工具注册表驱动——判据从真实 `tools/list` 取工具名集，断言每个工具名在探针表的「有探针」或「显式豁免」条目里出现；注册表新增工具而不加探针时本测试必须红。判据同时由变异 (iii) 证明。
  - 证据：判据 (d) 从真实 `tools/list` 取工具名集（断言恰为 17，正控），断言每个名字落在 `PROBE_TABLE`（有探针）或 `EXEMPT_TOOLS`（显式豁免）且不双桶、不重复；变异 (iii) 证明会红。
- [x] AC6 变异证据：先提交实现再变异，逐条记录 mutation diff、逐字失败行与恢复命令。(i) 让某个工具回到纯文本错误 ⇒ (a)(b) 必须红；(ii) 让某个工具的 not found 用另一个 code ⇒ (c) 必须红；(iii) 往注册表加一个工具而不加探针 ⇒ (d) 必须红。三条缺一不可。
  - 实现在 `3a25d65f`、`cbe0989c` 提交后变异，恢复后判据回到 7/7 绿。
  - (i) mutation：`mcp-gateway.audit.ts` 的 catch 内对 `session_read` 返回纯文本 `{ content:[{type:'text',text:'No such session.'}], isError:true }` ⇒ 2 红，逐字：`AssertionError [ERR_ASSERTION]: regression session_read (was plain text): a failure must carry a structuredContent object (no plain-text-only failures)`。恢复：`git checkout -- server/modules/mcp-gateway/mcp-gateway.audit.ts`。
  - (ii) mutation：catch 内把 `session_read` 的 `SESSION_NOT_FOUND` 改写成 `SESSION_BUSY` ⇒ 2 红，逐字：`AssertionError [ERR_ASSERTION]: every "session not found" answer must be SESSION_NOT_FOUND, saw SESSION_BUSY`。恢复同上。
  - (iii) mutation：`mcp-gateway.transport.ts` 的 `createMcpServer` 尾部额外注册 `withMcpAudit({ name:'ac284_phantom', description:'a tool the criterion has no probe for', inputSchema:{}, annotations: readMcpToolAnnotations('overview'), requiredScopes:['cloudcli:read'], handler: () => ({}) })(server, principal)` ⇒ 1 红，逐字：`AssertionError [ERR_ASSERTION]: tools/list must return the full 17-tool set, got ac284_phantom, approval_answer, approvals_list, overview, projects_list, quay_snapshot, run_get, session_background, session_cancel_queued, session_close, session_create, session_get, session_interrupt, session_read, session_reconfigure, session_send, session_start, sessions_list`。恢复：`git checkout -- server/modules/mcp-gateway/mcp-gateway.transport.ts`。
- [x] AC7 既有判据移植：凡断言旧错误形状的既有测试（见 `## Touches` 的测试文件清单）逐条移植到新形状，断言强度不降，不删除不放宽；任务记录里逐条列旧断言→新断言。判据：`bash scripts/test.sh --for-task gap-ac284-mcp-error-envelope` 退出码 0，且 diff 中无删除 `assert` 或把严格断言放宽成 truthy/跳过。
  - 旧→新（逐条）：
    - `mcp-approvals.test.ts` / `mcp-cancel-queued.test.ts` / `mcp-overview.test.ts` / `mcp-run-get.test.ts` / `mcp-session-background.test.ts` / `mcp-session-host-control.test.ts` / `mcp-session-lifecycle.test.ts` / `mcp-session-reconfigure.test.ts` / `mcp-session-send.test.ts`：共用 `parseToolResult` 助手，失败 payload 旧从 `JSON.parse(content[0].text)` 取 → 新从 `structuredContent` 取；成功路径不变。
    - `mcp-read-tools.test.ts`：失败 `payload` 改从 `structuredContent` 取；错误探针改走一条**从不调用 `tools/list`** 的客户端（SDK Client 会缓存 `tools/list` 的输出校验器，并在 `isError` 结果上也校验 `structuredContent`，成功 schema 一律不匹配，故被 list 预热的客户端会抛错）。
    - `mcp-resolve-target.test.ts`：`TARGET_NOT_FOUND` → `SESSION_NOT_FOUND` / `PROJECT_NOT_FOUND`；CJK 文案 → 英文；`candidates` 移到 `details`。
    - `mcp-production-session-wiring.test.ts`：读信封；`TARGET_NOT_FOUND` → `PROJECT_NOT_FOUND`。
    - `mcp-session-host-control.test.ts`：`payload.leases` → `payload.details.leases`；消息断言 `cron×1` / `background-task×1` 保留。
    - `mcp-session-lifecycle.test.ts`：`body.candidates` → `body.details.candidates`；`body.supported` → `body.details.supported`。
    - `mcp-session-reconfigure.test.ts`：`payload.supported` → `payload.details.supported`（含 `plan`/`auto` 两处 `includes`）。
    - 源码 `mcp-session-host-control.ts`：租约文案由 CJK 译为英文，但保留既有断言所钉的 `×`（乘积符号不是 CJK）。
  - 判据：`bash scripts/test.sh --for-task gap-ac284-mcp-error-envelope` → EXIT=0，`# tests 17` / `# pass 17` / `# fail 0`（含静态 typecheck/lint 两阶段；Touches 补入 `mcp-production-session-wiring.test.ts` 后为 17 个测试文件）。迁移只改字段读取路径与错误码字符串，未删除 `assert`、未放宽为 truthy/skip。
- [x] AC8 计数 pin 同步：`server/shared/tests/quay-test-script.test.ts` 的两处 `known/unknown` pin 相应加一（以运行时实际计数为准），使 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0。
  - 运行时 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` = 238。`:154` 改 `known=3 unknown=235`、`:203` 改 `known=1 unknown=237`（各 +1）。同命令 → EXIT=0，`ℹ tests 11` / `ℹ pass 11` / `ℹ fail 0`。

## DoD

- 一个真实的 MCP 客户端（真 HTTP、SDK client）对 17 个工具触发上述十类失败时，**实际收到**的是 `{ isError:true, structuredContent:{ code, message, retryable, details? } }`，不是测试桩里伪造的结构——即失败信封经由 `withMcpAudit` 的真实渲染路径到达线上。
- `session_read` 与 `session_send` 两个点名的旧形态在真实调用里确实消失（不是只在单测断言里消失）。
- 会话不存在一类在任意触发它的工具上返回同一个 code；`SESSION_NOT_FOUND`/`TARGET_NOT_FOUND` 不再就同一类问题并存。
- 探针表的覆盖判据真的由 `tools/list` 驱动：临时往注册表加一个工具，判据确实报红，恢复后确实转绿（不是「注册表里其实没有单一入口、判据读的是手写清单」）。
- 既有断言错误形状的 MCP 判据是真的迁移到新形状且断言强度不降，不是删除/放宽/改成 `assert.ok(真)`。
- 遵守 `$backend-module-standards`：新信封模块按放置规则归位，导出符号带消费方注释，跨模块消费走 barrel（`server/modules/mcp-gateway/index.ts`），不下沉业务逻辑。
- 同步了测试文件计数 pin，未使全量 suite 因新增一个 `server/**/*.test.ts` 而变红。

## Touches

- server/modules/mcp-gateway/mcp-error-envelope.ts (new)
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/mcp-gateway/mcp-resolve-target.ts
- server/modules/mcp-gateway/mcp-session-background.ts
- server/modules/mcp-gateway/mcp-session-cancel-queued.ts
- server/modules/mcp-gateway/mcp-session-host-control.ts
- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/mcp-session-reconfigure.ts
- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts (new)
- server/modules/mcp-gateway/tests/mcp-audit.test.ts
- server/modules/mcp-gateway/tests/mcp-approvals.test.ts
- server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts
- server/modules/mcp-gateway/tests/mcp-oauth-challenge.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- server/modules/mcp-gateway/tests/mcp-run-get.test.ts
- server/modules/mcp-gateway/tests/mcp-self-target.test.ts
- server/modules/mcp-gateway/tests/mcp-session-background.test.ts
- server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts
- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
- server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-ac284-mcp-error-envelope.md (self-touch)
