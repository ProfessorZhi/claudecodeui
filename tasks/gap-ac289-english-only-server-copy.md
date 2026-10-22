---
id: gap-ac289-english-only-server-copy
title: 服务端文案统一为英文（AC-289）：message/note/explanation/hostNote/description/instructions/授权页无
  CJK，用户数据原样返回，判据 server/modules/mcp-gateway/tests/mcp-english-only.test.ts
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
goal_ac: AC-289
---
## Proposal

**目标 AC**：`goals/AC-289-面向调用方的服务端文案统一为英文-message-note-explanation-description-字段里不再有.md`，goal GOAL-024（退出条件 6）。判据文件固定为 `server/modules/mcp-gateway/tests/mcp-english-only.test.ts`，判据命令（带存在性闸）：

```
for f in server/modules/mcp-gateway/tests/mcp-english-only.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-english-only.test.ts
```

当前必红：判据文件不存在，存在性闸以退出码 1 打印 `缺判据文件：server/modules/mcp-gateway/tests/mcp-english-only.test.ts`。

**现状（源码核实，非推测）**——面向调用方的服务端文案里中文成片。`server/modules/mcp-gateway/*.ts` 共 **48 行字符串字面量含 CJK**，分布在 11 个文件，命中 AC 点名的多数类别：

1. `message`（错误/拒绝）：`mcp-self-target.ts:253-255` 自指拒绝 `目标会话 … 正在执行网关写工具 …，对它的写操作（…）被拒绝，以免自指卡死。`；`mcp-session-background.ts:219` `找不到会话 "…"。`、`:258` `停止后台任务需要 cloudcli:session:control。`、`:270` `该会话没有 id 为 "…" 的后台任务或计划。`、`:298-311` 五种停止失败文案；`mcp-session-cancel-queued.ts`、`mcp-run-get.ts`、`mcp-session-lifecycle.ts`、`mcp-session-reconfigure.ts`、`mcp-session-send.ts` 的 refusal/错误同形。
2. `note`：`mcp-run-get.ts:88-92` `NO_ACTIVITY_NOTE='该会话无活动记录。'`、`NO_ASSISTANT_MESSAGE_NOTE='该运行已结束，但该会话没有可读的助手消息。'`、`NO_FALLBACK_SESSION_NOTE='无法确定会话，无从回退。'`；`mcp-approvals.ts` 的 note。
3. `explanation`：`mcp-run-get.ts:77-79` `EXPLANATION_EXPIRED/UNKNOWN/RESTARTED`。
4. `hostNote`：`mcp-gateway.read-tools.ts:664` 声明 `.nullable()`，值为 `:666` `'没有宿主：该会话当前没有宿主进程（按次进程模式且未运行）。'`。
5. `relative`（时间字段，`McpTime.relative`，**每个读工具的输出都带**）：`mcp-gateway.read-tools.ts:278-284` `'刚刚'` / `` `${n} 分钟前` `` / `` `${n} 小时前` `` / `` `${n} 天前` ``——最隐蔽的一类，客户端每次成功读都会看到。
6. **跨模块**：`approval_answer` 的「已过期或不存在」reading 由 `server/modules/websocket/services/chat-control.service.ts:818` 生产 `message: '该审批请求已过期或不存在（可能已超时被自动拒绝）。'`，经 mcp-gateway 的 seam 原样到达 MCP 调用方（既有判据 `mcp-approvals.test.ts:586-593` 现在就断言 `includes('已过期或不存在')`）。这是唯一一处 mcp-gateway 之外的 `message:` 字段字面量（全 `server/modules` + `server/shared` 扫描，注释除外）。
7. 工具/参数 `description`、`initialize` 的 `instructions`：当前网关**不声明**（`mcp-tool-annotations.ts` 0 CJK；`server/modules/mcp-gateway/*.ts` 里 `instructions` 零命中），本轮无中文，但检查器必须把这两处纳入扫描面，一旦将来写入中文即红。
8. 授权页错误文案：`server/modules/oauth/oauth-consent.routes.ts:210` `sendErrorPage` 渲染 `<h1>Authorization error</h1>` 英文页（该文件 0 CJK），检查器仍须实际拉取错误页并断言其服务端文案无 CJK。

**用户数据不是服务端文案**：会话标题、项目名、消息正文、审批问题/选项文本由用户提供，必须原样返回。既有判据里已有中文用户数据夹具（`mcp-approvals.test.ts:430-434/484-545`：问题 `'选哪个？'`、表头 `'选择'`、选项 `'甲'/'乙'`、用户决定 `'不行'`），它们**不能**被当作服务端文案清洗——这些夹具正是 (d) 段的本钱。

**要交付（判据文件是唯一验收界面）**：

1. **注册表驱动的收集器**：从运行时的 `tools/list`（注册表投影，`gap-ac284-mcp-error-envelope` 的机制）取全部注册工具，对每个工具跑「至少一条成功路径 + 一条失败探针」；另取 `initialize` 的 `instructions`（有则扫）、授权页错误页 HTML。新增工具未被探针覆盖即红（与 AC-284 同源）。
2. **服务端文案字段扫描面**：主判据为白名单 `SERVER_AUTHORED_FIELDS`（至少 `message`、`note`、`explanation`、`hostNote`、`relative`，加上 `tools/list` 里工具/参数的 `description`、`instructions`），白名单键下的字符串必须无 CJK；**补充判据**：响应里任何 CJK 出现，其 JSON 路径都必须落在声明的用户数据键下，否则红——这条兜住白名单遗漏（`relative` 就是典型）。**不整树无差别清洗字符串**。
3. **用户数据反例夹具**：造中文标题的会话、中文项目名、中文正文消息（并沿用审批中文问题/选项），经真实工具读回，断言这些字段**逐字等于**原中文串（`===`，非「去 CJK 后相等」），证明检查器按字段作用域、既不误判也不清洗用户数据。
4. **(b) 同 code 语言一致**：收集所有失败的 `(code, message)`，按 `code` 分桶；每桶内每条 message 都通过英文判据，并打印 `code → messages[]` 读数。同一 code 在任何工具上都不出现中文。
5. **(c) 正例对照（检查器自证有判别力）**：把判据抽成纯函数（如 `containsCjk(s)` / `assertServerCopyEnglish(field, s)`），在合成中文句（如 `'找不到会话 "x"。'`）上断言其**变红**、在合成英文句上通过。这是 (i) 变异能被抓住的前提。
6. **生产文案翻译**：把命中扫描面的中文串逐条改为英文（注释里的中文不属于面向调用方文案，可保留），逐条列旧→新，至少覆盖上面第 1–6 条点名处与 `chat-control.service.ts:818`。翻译只改文案、不改 code、不改语义；跨模块的那条在源头改（`chat-control.service.ts`），或在 mcp-gateway seam 渲染自己的英文 message 并同步迁移断言——二选一，记录理由。
7. **既有判据移植、强度不降**：凡断言旧中文**服务端文案**的既有测试逐条迁移到新英文串（保持等值/`includes` 断言强度）；凡中文是**用户数据夹具**的保持中文并继续断言原样返回。记录旧→新或保留理由。

<!-- dedup-ref -->
**关系与范围**：本任务消费 `gap-ac284-mcp-error-envelope` 交付的 `server/modules/mcp-gateway/mcp-error-envelope.ts`（信封与 `message` 字段的载体）及其 `tools/list` 驱动的注册表投影；`depends_on` 由顶层字段声明，开工时先确认该文件与探针机制存在，缺失即停手报告（排序问题，不另起信封模块）。范围外（兄弟 AC，避免重复实现）：信封形状/同类同 code/注册表探针 = AC-284；code 词表唯一来源与每工具声明 = AC-285；`INSUFFICIENT_SCOPE` + `details.requiredScopes` = AC-286；四工具 not-found = AC-287；`INVALID_ARGUMENT`/`details.fields`/`UNKNOWN_TOOL` = AC-288。本任务只做：服务端文案无 CJK 的收集器与判据、生产文案翻译、用户数据不被误伤的夹具、per-code 语言一致、正例对照与两条假形态。

后端改动遵守 `$backend-module-standards`（`.agents/skills/backend-module-standards/SKILL.md`）：文案常量按放置规则归位 mcp-gateway 模块、导出符号带消费方注释、跨模块消费走 barrel（`server/modules/mcp-gateway/index.ts`），不下沉业务逻辑。

## Plan

1. **读依赖**：确认 `server/modules/mcp-gateway/mcp-error-envelope.ts` 存在并导出信封构造器；确认 AC-284 的 `tools/list` 驱动探针机制可复用。缺失则停手报告。
2. **文案常量归位/翻译**：逐文件把扫描面下的中文改为英文——`mcp-self-target.ts`、`mcp-session-background.ts`、`mcp-session-cancel-queued.ts`、`mcp-session-host-control.ts`、`mcp-session-lifecycle.ts`、`mcp-session-reconfigure.ts`、`mcp-session-send.ts`、`mcp-run-get.ts`、`mcp-gateway.read-tools.ts`（含 `formatMcpTime` 的 relative 与全角标点）、`mcp-overview-tools.ts`、`mcp-resolve-target.ts`，以及跨模块 `server/modules/websocket/services/chat-control.service.ts:818`。每条记旧→新。
3. **检查器纯函数**：`containsCjk`（覆盖基本区 U+4E00–U+9FFF、扩展 A U+3400–U+4DBF、全角标点 `，。：（）`）；`assertServerCopyEnglish(field, value)`；声明 `SERVER_AUTHORED_FIELDS` 与用户数据键说明。
4. **判据 `tests/mcp-english-only.test.ts`（红先行）**：真实 express + `mountMcpGateway`（或 `createMcpGatewayModule` 装配）+ `@modelcontextprotocol/sdk` Client + StreamableHTTP、真签发令牌（沿用 `mcp-audit.test.ts` / `oauth-flow.e2e.test.ts` 真 HTTP + 临时 `DATABASE_PATH`/`HOME` 模式）。读数段：
   - (a) `tools/list` 驱动全部工具「成功 + 失败」探针，扫白名单字段 + 补充 CJK 路径判据；附 `initialize.instructions`、授权页错误页。
   - (b) `(code, message)` 分桶，逐 code 断言英文一致，打印分桶读数。
   - (c) 合成中文必红 / 合成英文必过的纯函数自测。
   - (d) 中文用户数据夹具（会话标题/项目名/正文，复用审批中文问题与选项）读回逐字相等。
5. **计数 pin 同步**：新增一个 `server/**/*.test.ts` 使 `server/shared/tests/quay-test-script.test.ts` 两处 known/unknown 变红。先取当时实际 N（落案基线 N=237），按构造式写 `known=3 unknown=N-3`（`:154`）与 `known=1 unknown=N-1`（`:203`）。
6. **仓库门**：`npm run typecheck` / `npm run lint`（无 error 级）/ `npm run build` 退出码 0；`bash scripts/test.sh --for-task gap-ac289-english-only-server-copy` 退出码 0。

## AC

- [x] AC1 判据文件 `server/modules/mcp-gateway/tests/mcp-english-only.test.ts` 存在；存在性闸后判据命令退出码 0。任务记录含红先行两段逐字输出：实现前退出码 1 打印 `缺判据文件：server/modules/mcp-gateway/tests/mcp-english-only.test.ts`；实现后退出码 0。
- [x] AC2 (a) 检查器由 `tools/list` 驱动，枚举全部注册工具（写下工具数）；每个工具至少一条成功路径 + 一条失败探针；对 `SERVER_AUTHORED_FIELDS` 断言无 CJK，并跑补充判据（响应内任何 CJK 必须落在声明的用户数据键下，否则红）；覆盖 `initialize.instructions`（若有）与授权页错误页 HTML。新增工具无探针即红。
- [x] AC3 (a) 逐条记录收集到的服务端文案字段（文件:行 → 字段 → 英文值），并断言全部无 CJK；含 `relative` 时间字段与 `hostNote` 的实际读数。
- [x] AC4 (b) 收集所有 `(code, message)`，按 code 分桶；每桶每条 message 无 CJK（同 code 在所有工具上语言一致）；打印 `code → messages[]` 分桶读数。
- [x] AC5 (c) 正例对照：`containsCjk`/`assertServerCopyEnglish` 在合成中文句（如 `'找不到会话 "x"。'`）上变红、在合成英文句上通过；判据：本判据文件的 (c) 段。
- [x] AC6 (d) 用户数据不被误伤：中文标题会话 / 中文项目名 / 中文正文（及审批中文问题与选项）经真实工具读回，逐字等于原中文串（`===`）；判据：本判据文件的 (d) 段。
- [x] AC7 假形态 (i)：提交实现后，把某个 `message` 改回中文（记录 mutation diff）⇒ (a) 断言红（记录逐字失败行）；恢复命令后重跑绿。
- [x] AC8 假形态 (ii)：把用户数据当服务端文案去清洗（记录 mutation diff，例如让清洗/判据作用于会话标题）⇒ (d) 的中文标题逐字断言红；恢复后重跑绿。
- [x] AC9 计数 pin 同步：`server/shared/tests/quay-test-script.test.ts` 两处 known/unknown 按实现时实际计数写入（先取 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实际 N，再写 `known=3 unknown=N-3`（`:154`）与 `known=1 unknown=N-1`（`:203`））；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0；写下 N 与两条 pin 字符串。
- [x] AC10 既有判据移植、强度不降：凡断言旧中文**服务端文案**的既有测试逐条迁移为新英文串（核对 `mcp-run-get.test.ts`、`mcp-read-tools.test.ts`、`mcp-session-background.test.ts`、`mcp-self-target.test.ts`、`mcp-session-lifecycle.test.ts`、`mcp-session-reconfigure.test.ts`、`mcp-cancel-queued.test.ts`、`mcp-overview.test.ts`、`mcp-resolve-target.test.ts`、`mcp-approvals.test.ts` 等）；中文**用户数据夹具**（`mcp-approvals.test.ts` 的问题/选项、`mcp-session-send.test.ts` 的正文字符串）保持中文并继续断言原样返回。diff 中无删除 `assert`、无放宽为 truthy/skip；任务记录逐条列旧→新或保留理由。`bash scripts/test.sh --for-task gap-ac289-english-only-server-copy` 退出码 0。
- [x] AC11 仓库门：`npm run typecheck` 退出码 0；`npm run lint` 无 `: error `（只看 error 级）；`npm run build` 退出码 0。写明三条退出码与 lint error 计数。
- [x] AC12 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 `task_write` 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 一个真实 MCP 客户端（真 HTTP、SDK client、真签发 access token）**实际收到**的服务端文案（`message`/`note`/`explanation`/`hostNote`/`relative`、`tools/list` 描述、授权页错误文案）确实无 CJK，不是测试桩伪造。
- 中文用户数据**确实**原样返回：中文标题/项目名/正文/审批问题与选项逐字相等，检查器不是靠「一律清 CJK」通过。
- 两条假形态各能让对应读法变红并记录恢复命令：(i) 改回中文 ⇒ AC2/AC3 红；(ii) 清洗用户数据 ⇒ AC6 红。不是「改完仍绿」。
- (c) 正例对照成立：检查器在合成中文上确有判别力；且在合成英文上不误报。
- 既有断言旧中文文案的判据真的迁移、强度不降；中文用户数据夹具未被误伤。
- 遵守 `$backend-module-standards`：文案常量按放置规则归位、导出符号带消费方注释、跨模块消费走 barrel，不下沉业务逻辑。
- 同步了测试文件计数 pin，未使全量 suite 因新增一个 `server/**/*.test.ts` 而变红。

## Touches

- server/modules/mcp-gateway/mcp-error-envelope.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/mcp-gateway/mcp-resolve-target.ts
- server/modules/mcp-gateway/mcp-run-get.ts
- server/modules/mcp-gateway/mcp-self-target.ts
- server/modules/mcp-gateway/mcp-session-background.ts
- server/modules/mcp-gateway/mcp-session-cancel-queued.ts
- server/modules/mcp-gateway/mcp-session-host-control.ts
- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/mcp-session-reconfigure.ts
- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/websocket/services/chat-control.service.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts (new)
- server/modules/mcp-gateway/tests/mcp-run-get.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-session-background.test.ts
- server/modules/mcp-gateway/tests/mcp-self-target.test.ts
- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
- server/modules/mcp-gateway/tests/mcp-session-reconfigure.test.ts
- server/modules/mcp-gateway/tests/mcp-cancel-queued.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- server/modules/mcp-gateway/tests/mcp-approvals.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-ac289-english-only-server-copy.md (self-touch)

## Evidence

**AC1 红先行两段逐字输出**
- 实现前（判据文件不存在）：
  ```
  缺判据文件：server/modules/mcp-gateway/tests/mcp-english-only.test.ts
  ```
  退出码 **1**。
- 实现后：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-english-only.test.ts` → `# tests 10 # pass 10 # fail 0`，退出码 **0**。

**AC2 收集器覆盖**
- 工具数 **17**（7 读工具 + 5 写工具 + 5 常驻工具）；`SUCCESS_TABLE` 与 `FAILURE_TABLE` 的键集对 `tools/list` 名称集 `deepEqual`——多一个注册工具而无探针即红。
- 每个工具：1 条成功路径 + 1 条失败探针（INVALID_ARGUMENT 浅探针）；另有 `CLASS_FAILURES` 9 条分类失败（SESSION_NOT_FOUND ×2、PROJECT_NOT_FOUND ×2、TARGET_AMBIGUOUS、UNKNOWN_TOOL、INSUFFICIENT_SCOPE、SESSION_BUSY、TASK_NOT_FOUND）。
- `initialize.instructions`：网关未声明（读数 `absent`）——已纳入扫描面，若将来写入 CJK 即红。
- 授权页错误页：真拉 `GET /authorize`（无 client_id）→ HTTP 400，HTML 含 `Authorization error` 且 0 CJK。
- 补充判据：任何 CJK 的 JSON 路径必须落在声明的用户数据键下，否则红。

**AC3 服务端文案字段读数（文件 → 字段 → 英文值）**
- `mcp-gateway.read-tools.ts` `hostNote` → `No host: this session currently has no host process (per-invocation process mode and not running).`
- `mcp-gateway.read-tools.ts` `formatMcpTime` → `relative`：`just now` / `${n} minutes ago` / `${n} hours ago` / `${n} days ago`（实测 `30 minutes ago`、`1 minutes ago`）。
- `mcp-overview-tools.ts` `note` → `This project has no quay`；`Unknown: this project has no cached snapshot (overview does not load it; use quay_snapshot to refresh)`。
- `mcp-run-get.ts` `explanation` → `This run existed but is past its retention window; its result can no longer be retrieved.` / `This runId was never issued.` / `The service restarted; this run belongs to a previous boot.`；`note` → `This session has no activity record.` / `This run has ended, but the session has no readable assistant message.` / `No session can be determined, so there is nothing to fall back to.`
- `mcp-self-target.ts` `message` → `Target session <id> is executing gateway write tool <tool>; the write operation (<op>) against it is refused to avoid a self-target deadlock.`
- `mcp-session-background.ts` `message` → `This session currently has no host, so it has no background tasks or schedules.`；同文件 TASK_NOT_FOUND → `This session has no background task or schedule with id "<id>".`
- `mcp-session-cancel-queued.ts` `OUTCOME_MESSAGES` → 三句英文（cancelled / already-started / unknown）。
- `mcp-session-lifecycle.ts` `NO_RUN_TO_ABORT_MESSAGE` → `This session currently has no run in flight, so there is no run to abort.`
- `mcp-session-reconfigure.ts` `NO_LIVE_MESSAGE` / `NOT_LIVE_MESSAGE` / `NOT_PLACED_MESSAGE` → 三句英文（live reconfiguration / next start,next turn / next turn）。
- 跨模块 `chat-control.service.ts:818` `message` → `The approval request has expired or does not exist (it may have timed out and been auto-denied).`

**AC4 分桶读数（code → 条数）**
`INVALID_ARGUMENT → 17`、`SESSION_NOT_FOUND → 2`、`PROJECT_NOT_FOUND → 2`、`TARGET_AMBIGUOUS → 1`、`UNKNOWN_TOOL → 1`、`INSUFFICIENT_SCOPE → 1`、`SESSION_BUSY → 1`、`TASK_NOT_FOUND → 1`。共 8 个 code，每桶每条 message 均过英文判据。

**AC5 (c) 正例对照读数**
- 合成中文 `'找不到会话 "x"。'` → `containsCjk=true`，`assertServerCopyEnglish` 抛 `/server-authored copy must be English \(no CJK\)/`。
- 合成英文 → 通过（不误报）。
- 全角标点样本 `全角，标点` / `句末。` / `（括号）` 均判为 CJK。

**AC6 (d) 用户数据逐字读数**
`示例项目`、`中文标题的会话`（sessions_list / session_get / overview 三处 `===`）、`这是一条中文正文消息。`（session_read content 包含）、`选哪个？` / `选择` / `甲` / `乙` / `echo 你好`（approvals_list questions/options `===`）。

**AC7 假形态 (i)**
- mutation diff：`-const NO_HOST_MESSAGE = 'This session currently has no host, so it has no background tasks or schedules.';` → `+const NO_HOST_MESSAGE = '该会话当前没有宿主，没有后台任务或计划。';`
- 逐字失败行：`AssertionError: session_background message: server-authored copy must be English (no CJK), saw "该会话当前没有宿主，没有后台任务或计划。"`（(a) 成功载荷段）；另 (d) 源码扫描段 `server-authored string literals must be English (no CJK)`；(a) notable-readings 段 `session_background.message must be the translated English sentence`。共 3 段红。
- 恢复：把该常量改回英文后重跑绿（10/10）。

**AC8 假形态 (ii)**
- mutation diff：`-    title: row.sessionTitle,` → `+    title: row.sessionTitle.replace(/[一-鿿]/g, ''),`
- 逐字失败行：`AssertionError: the session title must come back byte-for-byte`，仅 (d) 段红（9/10 pass）。
- 恢复：改回 `title: row.sessionTitle,` 后重跑绿。

**AC9 计数 pin**
- N = **244**（`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`）。
- `:154` → `known=3 unknown=241`；`:203` → `known=1 unknown=243`。
- `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 **0**。

**AC10 既有判据移植（旧→新；中文用户数据夹具保留）**
- `mcp-approvals.test.ts:593,598` `includes('已过期或不存在')` → `includes('expired or does not exist')`（含 :9/:36/:572 注释与标题同步）。
- `mcp-read-tools.test.ts:770,784,800` `` `${n} 分钟前` `` → `` `${n} minutes ago` ``（`55 minutes ago` / `56 minutes ago`）。
- `mcp-run-get.test.ts:548,549,587` `/保留期/` → `/retention/`、`/从未/` → `/never issued/`、`/重启/` → `/restarted/i`（注释 :34 同步）。
- `mcp-session-background.test.ts:666` `/没有宿主/` → `/no host/i`。
- `mcp-session-lifecycle.test.ts:858` `includes('没有可中止的运行')` → `includes('no run to abort')`。
- `mcp-session-reconfigure.test.ts:727,728` `/不支持在线重配置/` → `/live reconfiguration/`、`/下一轮/` → `/next/`。
- 保留（用户数据夹具）：`mcp-approvals.test.ts` 问题 `选哪个？` / 表头 `选择` / 选项 `甲`/`乙` / 用户决定 `不行` / answers 键；`mcp-session-send.test.ts`、`mcp-run-get.test.ts` 的中文正文夹具。
- 未改动（不 CJK，无需迁移）：`mcp-self-target.test.ts`、`mcp-cancel-queued.test.ts`、`mcp-overview.test.ts`（断言 `NO_QUAY_NOTE`/`UNKNOWN_QUAY_NOTE` 英文常量）、`mcp-resolve-target.test.ts`（断言英文片段）。
- diff 中无删除 `assert`、无放宽为 truthy/skip。
- `bash scripts/test.sh --for-task gap-ac289-english-only-server-copy` 退出码 **0**（12 个文件全部 passed=true，含 11 个 Touches 内测试文件 + `server/shared/tests/quay-test-script.test.ts`）。

**AC11 仓库门**
`npm run typecheck` 退出码 **0**；`npm run lint` 退出码 **0** 且 `: error ` 计数 = **0**；`npm run build` 退出码 **0**。

**AC12 diff ↔ Touches**
`git diff --stat develop...HEAD` = **18** 个文件，全部落在 `## Touches` 内；新增文件 `server/modules/mcp-gateway/tests/mcp-english-only.test.ts` 已标 `(new)`；无 Touches 之外的文件。
实际改动文件清单：`mcp-approvals.ts`、`mcp-gateway.read-tools.ts`、`mcp-overview-tools.ts`、`mcp-run-get.ts`、`mcp-self-target.ts`、`mcp-session-background.ts`、`mcp-session-cancel-queued.ts`、`mcp-session-lifecycle.ts`、`mcp-session-reconfigure.ts`、`tests/mcp-english-only.test.ts (new)`、`tests/mcp-approvals.test.ts`、`tests/mcp-read-tools.test.ts`、`tests/mcp-run-get.test.ts`、`tests/mcp-session-background.test.ts`、`tests/mcp-session-lifecycle.test.ts`、`tests/mcp-session-reconfigure.test.ts`、`chat-control.service.ts`、`server/shared/tests/quay-test-script.test.ts`。

**范围说明（不整树无差别清洗）**
`mcp-write-notification.ts` 未被判据扫描面纳入——它构造的是写入调用给 CloudCLI 用户的应用内通知（标题/正文），不是发给 MCP 调用方的文案，且不在 AC-289 点名字段内；判据文件在源码扫描里显式排除它并写明理由。`mcp-error-envelope.ts`、`mcp-resolve-target.ts`、`mcp-session-host-control.ts`、`mcp-session-send.ts`、`index.ts` 已在 Touches 但源码 0 CJK 文案、无需改动。
