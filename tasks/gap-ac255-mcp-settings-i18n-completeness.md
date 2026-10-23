---
id: gap-ac255-mcp-settings-i18n-completeness
title: AC-255 MCP 区块与令牌 scope 文案在 12 语言齐全：判据
  src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts 遍历
  locales/*/settings.json 的 glob，mcp 必需键 + 与 en 键集合完全一致 +
  正例对照，取假形态两条（删键/值=键名）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac254-mcp-settings-block-scope-checkboxes
goal_ac: AC-255
---
## Proposal

AC-255（GOAL-020 退出条件；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1「前端：设置 → API 页改造」§478–§485 与 scope 词汇 §322–§331）要求 CloudCLI MCP 区块与令牌 scope 说明的文案在**全部 12 种语言**里齐全：缺任何一种语言的任何一个键都不能通过，也不能把键名当文案渲染出来（react-i18next 对缺失键按原名渲染，这正是要防的）。判据文件路径由 AC 钉死为 `src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts`，命令 `npx vitest run src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts`（先过存在性闸）。

现状（红态基线）：判据文件不存在，存在性闸 `[ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }` 以退出码 1 输出缺失的文件名。`src/modules/i18n/locales/*/settings.json` 是 12 个目录（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW），其中 `mcp` 命名空间**已存在**——当前是 MCP Servers 管理 UI 的 13 个键（`title`「MCP Servers」、`addServer`、`editServer`、`deleteServer`、`serverName`、`serverType`、`config`、`testConnection`、`status`、`connected`、`disconnected`、`scope.{label,user,project}`），12 语言的该命名空间键集合当前逐一相同（各 locale 对 `.mcp` 展平后的 md5 一致）。

做法照 AC-229（`src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`，goal_ac: AC-229，done）：本任务只拥有**完整性判据**，不拥有 UI 与文案落地（那是 AC-254），并以顶层 `depends_on` 随 AC-254 之后串行；正常路径下不重写任何 locale。

要交付：

1. 判据 `src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts`（vitest，文件系统读取；形制照 `i18nAccessTokensCompleteness.test.ts`，**不硬编码语言清单**，从 vitest 进程 cwd 解析——jsdom 下 `import.meta.url` 不是 file: URL）：
   - 枚举：`readdirSync(LOCALES_DIR, { withFileTypes: true })` 取目录名排序，与 `globSync('*/settings.json', { cwd: LOCALES_DIR }).sort()` 两个独立枚举必须逐一相等，目录数 ≥ 12。
   - 必需键常量 `REQUIRED_MCP_KEYS`：AC 文案列举的概念为「区块标题、端点、已启用、未启用、接入命令说明、五个 scope 的名称与说明、写权限风险提示」。常量是**独立字面量**（非从 `en` 推导），其精确键名以 **AC-254 已落地组件真实消费的键**为准（实现时 grep `src/modules/settings/tabs/api-settings/` 下的消费点定名）。若 AC-254 落地的命名空间或键名与 AC 文案有出入，以落地契约定常量并在 `## 完成记录` 逐字写出对账——**不得**凭空造键把判据变红。
   - 读数 (a)：检查器 `mcpProblems(namespace)`（空数组=通过）——缺键、非字符串、空串、值等于键名本身（叶名或全路径）各出一条原因；对每个 locale 收集 offenders，断言 `[]`，并写下每种语言该命名空间的扁平键数。
   - 读数 (b)：对每个 locale 展平该命名空间为点分排序键集合，断言与 `en` 的集合**完全相等**（两侧差集皆空）；写下 en 键集合与每语言的差集读数。
   - 读数 (c) 正例对照（同一次运行、同一检查器）：`mcpProblems({})` 必须逐个报出所有必需键缺失；一个只缺一个键的合成 bundle 必须只报这一条；一个完整合成 bundle 返回 `[]`。
   - 判据只读文件系统，不 import 任何 app 模块，零墙钟、零网络、零渲染。

2. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 从任一语言（例：`de/settings.json`）删掉该命名空间的一个必需键 ⇒ (a) 与 (b) 必须红（缺键 + 与 en 集合不等）；(ii) 把任一语言（例：`fr/settings.json`）的一个必需键值改成键名本身 ⇒ (a) 必须红。每条记录恢复命令与恢复后重跑绿。

3. 12 个 locale 的命名空间就位：AC-254 交付全部必需键后本任务只核验（实际写入 locale 清单可能为空）；若 AC-254 确缺键，按 AC6 先用 `task_write` 把相应 locale 加进 `## Touches` 再补齐。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 AC-255 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts`（写下完整命令与完整输出）；实现后同命令退出 0。
- [x] AC2 (a) 12 语言必需键齐全：每种语言的 `REQUIRED_MCP_KEYS` 每个键存在、值为非空字符串、且不等于键名本身（叶名或全路径）；写下每种语言的扁平键数与 offenders 计数（=0）。
- [x] AC3 (b) 键集合与 en 完全一致：每种语言展平点分键集合与 `en` 相等（差集两侧皆空）；写下 en 键集合与每语言的差集读数。
- [x] AC4 (c) 正例对照同一次运行：`mcpProblems({})` 报出全部必需键缺失；只缺一个键的合成 bundle 只报这一条；完整合成 bundle 返回 `[]`。写下三条读数。
- [x] AC5 遍历是 glob 且两枚举一致：`readdirSync` 目录名与 `globSync('*/settings.json')` 逐一相等，目录数 ≥ 12；写下两个枚举。不得出现硬编码语言清单。
- [x] AC6 12 语言该命名空间就位：核验 AC-254 已交付全部必需键；若缺键，先用 task_write 扩展 `## Touches` 再补齐；写下实际写入的 locale 文件清单（可能为空）。
- [x] AC7 取假形态两条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 删一种语言的一个键 ⇒ 含 (a) 与 (b) 的用例红；(ii) 某语言的值写成键名本身 ⇒ (a) 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；判据在 `src/modules/settings/tests/`、用 `@/` 导入（不 import app 模块则无跨模块导入）；写明各命令退出码与 lint error 计数。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)`）；若被迫写 Touches 之外的文件（仅可能是 locale），先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 判据文件真的存在且真跑绿：`npx vitest run src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts` 退出 0，且覆盖 (a)(b)(c)。
- 齐全性是真的对磁盘上的 locale 文件读出来的：12 个目录与 glob 两枚举一致（不硬编码语言清单），每种语言的必需键齐全且与 `en` 键集合相等，读数来自真实 JSON 而不是常量自证。
- 检查器能变红：同一次运行的正例对照（缺键合成 bundle 报出缺失原因）与两条取假形态（删键 ⇒ (a)(b) 红；值=键名 ⇒ (a) 红）都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 12 种语言真的都有 MCP 区块与 scope 文案（不是只有 en），值非空且不是键名——这就是「不能显示成原始键名」的机械守护。
- 遵守 `$frontend-module-standards`（测试在 `src/modules/settings/tests/`、`@/` 导入、只读文件系统不引入状态）；不越界实现 AC-254（区块 UI/scope 勾选框）、AC-243（签发期 scope 校验）、AC-256/257（冒烟）。

## Touches

- src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts (new)
- tasks/gap-ac255-mcp-settings-i18n-completeness.md

## Notes

- 命名空间：AC-255 文案把必需键钉在 `mcp` 命名空间；但 `mcp` 已被 MCP Servers 管理 UI 占用（13 键，12 语言当前一致）。AC-254 若把 CloudCLI MCP 区块键并入 `mcp`，(a) 的常量只列 AC-255 关心的键，(b) 仍比对整个 `mcp` 子树与 `en`；若 AC-254 另立命名空间（如 `mcpGateway`），criterion 以落地命名空间为准并在完成记录逐字对账，同时说明 AC 文案的 `mcp` 指代。
- scope 名称与说明：AC 文案归入 `mcp` 命名空间；若 AC-254 落地在 `accessTokens.scopes.*`，criterion 覆盖落地位置并在完成记录对账（AC-254 的 scope 勾选框在 `AccessTokensSection.tsx`）。
- 依赖 AC-254：顶层 `depends_on` 串行；AC-254 的 DoD 明说「不越界实现 AC-255 的 i18n 完整性判据」，两者不重复。
- 新增测试文件会被边界 lint 拦（内存 `quay-boundaries-lint-blocks-new-test-files`）；`src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts` 已列入 `## Touches`。
- 判据从 vitest 进程 cwd 解析路径（`import.meta.url` 在 jsdom 下不是 file: URL）；只读文件系统，不引入状态。
- `$frontend-module-standards` 适用于本任务（测试在 src/ 下）。

<!-- dedup-ref -->
关联（非重复）：`gap-ac254-mcp-settings-block-scope-checkboxes`（goal_ac: AC-254）交付 CloudCLI MCP 区块 UI、五个 scope 勾选框与 12 语言键；其任务体明说「不越界实现 AC-255 的 i18n 完整性判据」。本任务只拥有**完整性判据**，顶层 `depends_on` 随 AC-254 之后串行，正常路径下不重写 locale。`gap-ac243-token-scope-vocabulary-validation`（签发期 scope 词汇校验，ready）与 `gap-ac229-access-tokens-i18n-completeness`（旧 accessTokens 键完整性，done）是不同机制。

## 完成记录

实现提交：`b4702005`（判据文件）＋ 本次 `task_write`（勾选 AC）。

### 命名空间对账（AC-254 落地契约 vs AC 文案）

- AC 文案把必需键钉在 `mcp` 命名空间。**AC-254 实际落地为独立命名空间 `mcpGateway`**（8 键），未并入 `mcp`（后者仍是 MCP Servers 管理 UI 的旧命名空间，本例不触碰）。criterion 以落地命名空间 `mcpGateway` 为准；AC 文案的 `mcp` 即指 CloudCLI MCP 区块（`McpGatewaySection.tsx`，`t('mcpGateway.*')`）。
- scope 名称与说明：AC 文案归入 `mcp`；**AC-254 实际落地在 `accessTokens.scopes.*`**（`AccessTokensSection.tsx` 的 `` t(`accessTokens.scopes.${option.labelKey}`) ``，5 个 labelKey = read/sessionSend/sessionCreate/sessionControl/approve，来源 `src/shared/constants.ts:239`）。criterion 覆盖落地位置。五个 scope 的「说明」内嵌在各 label 值里（如 `Read (cloudcli:read)`），未另立 description 键——以落地契约为准，未凭空造键。
- 写入风险提示落地为 `accessTokens.form.writeScopeRisk`；勾选框组标题落地为 `accessTokens.form.scopesLabel`。

### REQUIRED_MCP_KEYS（独立字面量，15 键；读 (a) 用）

```
mcpGateway.title, mcpGateway.description, mcpGateway.status.enabled, mcpGateway.status.disabled,
mcpGateway.connectLabel, mcpGateway.enableHint, mcpGateway.copy, mcpGateway.copied,
accessTokens.form.scopesLabel, accessTokens.scopes.read, accessTokens.scopes.sessionSend,
accessTokens.scopes.sessionCreate, accessTokens.scopes.sessionControl, accessTokens.scopes.approve,
accessTokens.form.writeScopeRisk
```

### AC1 红态基线

命令：
```
for f in src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx vitest run src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts
```
改动前输出（逐字）：`缺判据文件：src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts`，退出码 1。
实现后同一判据命令退出 0：`Test Files 1 passed (1)` / `Tests 4 passed (4)`。

### AC2 (a) 12 语言必需键齐全

每语言受管子树（`mcpGateway` ＋ `accessTokens.scopes`）扁平键数：de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW 均 = 13。
offenders 计数 = 0（`[AC2] offenders (0): []`）。

### AC3 (b) 键集合与 en 完全一致

en 键集合（13）：`accessTokens.scopes.approve, accessTokens.scopes.read, accessTokens.scopes.sessionControl, accessTokens.scopes.sessionCreate, accessTokens.scopes.sessionSend, mcpGateway.connectLabel, mcpGateway.copied, mcpGateway.copy, mcpGateway.description, mcpGateway.enableHint, mcpGateway.status.disabled, mcpGateway.status.enabled, mcpGateway.title`。
每语言差集：全部 `{missing:[], extra:[]}`（12/12），`[AC3] per-locale key-set diffs vs en` 逐条为空。

### AC4 (c) 正例对照（同一次运行、同一检查器）

- `mcpProblems({})` = 15 条 `${key} is missing`（按声明顺序）。
- 只缺 `mcpGateway.connectLabel` 的合成 bundle = `['mcpGateway.connectLabel is missing']`（仅 1 条）。
- 完整合成 bundle = `[]`。
（另含 blank / 叶名 / 全路径三条臂的对照，均通过。）

### AC5 两枚举一致

readdir 目录（12）：`["de","en","es","fr","id","it","ja","ko","ru","tr","zh-CN","zh-TW"]`。
glob `*/settings.json`（12）：`["de/settings.json","en/settings.json","es/settings.json","fr/settings.json","id/settings.json","it/settings.json","ja/settings.json","ko/settings.json","ru/settings.json","tr/settings.json","zh-CN/settings.json","zh-TW/settings.json"]`。
逐一相等，目录数 12 ≥ 12。无硬编码语言清单（`readdirSync` ＋ `globSync` 双枚举）。

### AC6 12 语言该命名空间就位

AC-254 已交付全部 15 个必需键（见 AC2/AC3 读数）。**实际写入的 locale 文件清单：空**（未重写任何 locale，无需扩展 Touches）。

### AC7 取假形态（先提交实现 b4702005 再变异）

(i) 删键：`de/settings.json` 删 `mcpGateway.connectLabel`。
变异 diff：`-    "connectLabel": "Verbindungsbefehl",`
逐字失败行：
```
[AC2] offenders (1): ["de/settings.json: mcpGateway.connectLabel is missing"]
AssertionError: de/settings.json key set vs en: expected { …(2) } to deeply equal { missing: [], extra: [] }
+     "mcpGateway.connectLabel",
FAIL src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts > ... > gives every locale every required MCP / scope key, non-empty and not the key name
FAIL src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts > ... > gives every locale exactly the same MCP / scope key set as en
Tests  2 failed | 2 passed (4)
```
(a) 与 (b) 皆红。
恢复命令：`git checkout -- src/modules/i18n/locales/de/settings.json`；恢复后重跑绿：`[AC2] offenders (0): []` / `Tests 4 passed (4)`。

(ii) 值=键名：`fr/settings.json` 的 `accessTokens.scopes.approve` 写成 `"approve"`。
变异 diff：`-      "approve": "Approuver (cloudcli:approve)"` / `+      "approve": "approve"`
逐字失败行：
```
[AC2] offenders (1): ["fr/settings.json: accessTokens.scopes.approve is the raw key name, not a label"]
AssertionError: expected [ Array(1) ] to deeply equal []
+     "fr/settings.json: accessTokens.scopes.approve is the raw key name, not a label",
FAIL src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts > ... > gives every locale every required MCP / scope key, non-empty and not the key name
Tests  1 failed | 3 passed (4)
```
(a) 红。
恢复命令：`git checkout -- src/modules/i18n/locales/fr/settings.json`；恢复后重跑绿：`[AC2] offenders (0): []` / `Tests 4 passed (4)`。

### AC8 仓库门

- `npm run typecheck` → 退出码 0。
- `npm run lint` → 退出码 0，`: error ` 计数 = 0（仅 warning）。
- 判据在 `src/modules/settings/tests/`；仅 import `node:fs` / `node:path` / `vitest`（无 app 模块导入，故无跨模块导入，不需要 `@/`）。

### AC9 改动清单

`git diff --stat develop...HEAD`：仅 `src/modules/settings/tests/i18nMcpSettingsCompleteness.test.ts (new) | 243 +++++++++`（1 file changed, 243 insertions）。
与 `## Touches` 对齐：判据文件 (new) ✓；`tasks/gap-ac255-mcp-settings-i18n-completeness.md` 由本次 `task_write` 提交（勾选 AC）。无 Touches 之外的文件（未改写任何 locale）。
