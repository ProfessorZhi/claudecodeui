---
id: gap-ac226-retire-api-agent-and-plaintext-keys
title: AC-226 /api/agent 与明文 key 机制从生产代码真正消失：删模块目录/挂载/apiKeysDb
  导出/API_KEYS_TABLE_SCHEMA_SQL 建表常量并改写 api-docs，判据
  server/modules/oauth/tests/agent-retirement.test.ts（语法树 + 正例对照）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac225-api-keys-drop-migration
goal_ac: AC-226
---
## Proposal

AC-226（GOAL-018 退出条件 3、范围「退役」）要求 `/api/agent` 与明文 key 机制从生产代码里真正消失，且判据读语法树而不是 grep 文本、自带正例对照，逐条读数 (a)–(e)、取假形态 (i)–(iii)。

现状（红态基线）：判据文件 `server/modules/oauth/tests/agent-retirement.test.ts` 不存在，存在性闸 `[ -f "$f" ]` 以退出码 1 打印缺失文件名。要退役的生产面仍在：

- `server/modules/agent/`（`agent.module.ts`、`agent.routes.ts`、`index.ts`、`tests/agent.routes.test.ts`）存在；
- `server/index.ts:43` `import { createAgentModule } from './modules/agent/index.js'`、`:107-108` 只被 agent 用的 `queryCodex`/`queryOpenCode`、`:113-118` 组装 `agentRoutes`、`:326` `app.use('/api/agent', agentRoutes)`；
- `server/modules/database/repositories/api-keys.ts` 存在，`server/modules/database/index.ts:7` 导出 `apiKeysDb`；
- `server/modules/database/schema.ts:15` `export const API_KEYS_TABLE_SCHEMA_SQL`（`INIT_SCHEMA_SQL` 里的组合引用由 AC-225 摘除，常量本身由本任务删除）；
- `server/modules/settings/settings.module.ts:2,17-21` 导入并接线 `apiKeysDb`；`settings.service.ts` 的 `ApiKeyRow`、`apiKeys` 依赖类型与 `listApiKeys`/`createApiKey`/`deleteApiKey`/`toggleApiKey` 四方法；`settings.routes.ts:25-28` 四条 `/api-keys` 路由；`settings/tests/settings.service.test.ts` 的 apiKeys 桩与 `listApiKeys` 用例；
- `public/api-docs.html` 含 9 处 `/api/agent` 与 6 处 `ck_`。

<!-- dedup-ref -->
关联（非重复）：`gap-ac224-access-token-service`（goal_ac: AC-224）建 `access_tokens` 表与令牌服务；`gap-ac225-api-keys-drop-migration`（goal_ac: AC-225）把 `${API_KEYS_TABLE_SCHEMA_SQL}` 与三行 `idx_api_keys_*` 从 `INIT_SCHEMA_SQL` 组合里摘除并 drop 旧表。两者都不删 `api-keys.ts` 仓储、`API_KEYS_TABLE_SCHEMA_SQL` 常量、`/api/agent` 挂载与 `createAgentModule`——那正是本任务。AC-227 负责新增 `/api/settings/access-tokens` 替换旧设置接口，AC-228/AC-229 负责前端 API Keys 区块与 i18n 改造；本任务只做后端退役，不新增任何接口、不动 `src/**`。

要交付：

1. 退役生产面（逐条对应判据读数）：
   - (a) 删除整个 `server/modules/agent/`（四个文件）。
   - (b) `server/index.ts`：删除第 43 行 import、第 107-108 行只被 `agentRoutes` 使用的 `queryCodex`/`queryOpenCode`、第 113-118 行 `agentRoutes` 组装、第 326 行 `app.use('/api/agent', agentRoutes)`；保留 `queryClaude`/`queryCursor`（`createGitModule` 仍用）。
   - (c) 删除 `server/modules/database/repositories/api-keys.ts`；从 `server/modules/database/index.ts` 删除 `export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';`；从 `server/modules/database/schema.ts` 删除 `API_KEYS_TABLE_SCHEMA_SQL` 常量声明；在 `server/modules/settings/` 里把 `apiKeysDb` 接线整体摘除——`settings.module.ts` 去掉 import 与 `apiKeys` 依赖块，`settings.service.ts` 去掉 `ApiKeyRow` 类型、`apiKeys` 依赖类型与四个方法，`settings.routes.ts` 去掉四条 `/api-keys` 路由，`settings/tests/settings.service.test.ts` 去掉 apiKeys 桩与 `listApiKeys` 用例。目标：判据 (c) 对 `apiKeysDb`、`createAgentModule`、`API_KEYS_TABLE_SCHEMA_SQL` 三个标识符在 `server/**`+`src/**` 非测试 `.ts`/`.tsx` 上各 0 次。
   - (e) 把 `public/api-docs.html` 改写为不再描述已退役接口的页面：整份文件中既不出现 `/api/agent` 也不出现 `ck_`（满足「要么不存在，要么两者皆无」的存在支）。保留文件本身，因此不改 `package.json` 的 `files` 清单、不改 `src/**`（前端 API Keys 区块与 i18n 归 AC-228/AC-229）。

2. 判据 `server/modules/oauth/tests/agent-retirement.test.ts`（`node:test` + `node:assert/strict`，用 `typescript` 编译器 API 解析，零墙钟、零网络、零 DB；仓库根照 `server/modules/debug-agent/tests/debug-agent-gate.test.ts` 的 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')` 解析）：
   - 扫描器：`ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)`（`.tsx` 用 `ts.ScriptKind.TSX`，`.ts` 用 `TS`），递归 `forEachChild`；标识符取 `ts.SyntaxKind.Identifier` 节点的 `text`；import 说明符取 `ImportDeclaration.moduleSpecifier` 为字符串字面量时的 `text`；`app.use` 取 `CallExpression` 且 `expression` 是属性访问、属性名为 `use`、对象名为 `app`、首参为字符串字面量时的 `text`。
   - 文件集：`server/**` 与 `src/**` 下扩展名 `.ts`/`.tsx`，排除 `node_modules`、`dist*`，排除测试文件（路径任一段为 `tests`/`test`，或文件名以 `.test.ts`/`.test.tsx`/`.spec.ts`/`.spec.tsx` 结尾）。遍历用自写递归 `readdirSync(..., { withFileTypes: true })`。
   - (a) `fs.existsSync(<repo>/server/modules/agent)` 为 false。
   - (b) 解析 `<repo>/server/index.ts`：断言没有 import 说明符含 `modules/agent`；断言没有 `app.use('/api/agent', ...)` 调用。写下两集合读数。
   - (c) 对整个文件集扫描：三个标识符各自节点计数为 0；写下扫描文件数与三个计数。
   - (d) 正例对照（同一次运行、同一扫描器，三支都要）：
     (d1) 合成源码含 `const apiKeysDb = 1;`、`function createAgentModule() {}`、`const API_KEYS_TABLE_SCHEMA_SQL = 1;` 三个代码位置标识符，同段又把这些字样写进 `// 注释` 与 `"字符串"`——断言三标识符各恰得 1 次（代码位置命中、注释与字符串不命中）。
     (d2) 对 `<repo>/server/modules/database/index.ts` 断言扫到已知存在的 `userDb` ≥1 次，证明零读数不是扫描器失灵。
     (d3) 合成 index.ts 含 `import { x } from './modules/agent/index.js'`、`app.use('/api/agent', r)`、注释 `// app.use('/api/agent')` 与普通字符串 `"modules/agent"`，断言 (b) 的两个探测器各命中 1 次且不被注释/普通字符串骗过；再合成一段含字符串字面量 `"/api-docs.html"` 的源码，断言字符串字面量探测器能找到它（这是 (e) 不存在支的探测器）。
   - (e) 若 `public/api-docs.html` 存在 ⇒ 读全文断言 `!text.includes('/api/agent') && !text.includes('ck_')`；若不存在 ⇒ 对 `src/**` 的字符串字面量扫描断言无 `/api-docs.html`。两条分支都要写在判据里（实现选改写，故当前走存在支）。
   - 红先行：先只提交判据文件（实现未改）⇒ 判据在 (a)(b)(c)(e) 上红；再落实现，记录红→绿全流程。

3. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 在 `server/index.ts` 重新加入 `import { createAgentModule } from './modules/agent/index.js';` ⇒ (b) 必须红；(ii) 在 `server/modules/database/index.ts` 恢复 `export { apiKeysDb } ...`（并恢复 `repositories/api-keys.ts`）⇒ (c) 必须红；(iii) 把 `public/api-docs.html` 恢复为含 `/api/agent` 的版本 ⇒ (e) 必须红。每条记录恢复命令与恢复后重跑绿。

边界：不实现令牌服务与 `access_tokens` 表（AC-224）；不做删 `api_keys` 表的迁移（AC-225）；不新增 `/api/settings/access-tokens`（AC-227）；不改前端 `src/**`（AC-228/AC-229）；不迁移旧 key。删除 `/api/settings/api-keys` 后，`src/shared/api.ts` 的 `apiKeys()` 等方法指向不再存在的后端路由，该前端改造由 AC-228/AC-229 收口，本任务不动前端。

判定纪律：判据读语法树（`typescript` 编译器 API 的 Identifier 节点），不 grep 文本，因此不被注释与退役说明里的字样骗过；(d) 的正例对照在同一次运行里证明扫描器既发报也不误报。判据不做网络/DB 依赖，读数是 AST 计数。

## AC

- [x] AC1 判据文件存在且绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/agent-retirement.test.ts` 退出 0，用例涵盖 (a)–(e)。逐字记录红态基线（改动前 `[ -f ... ]` 存在性闸退出码 1 并打印缺失文件名）。
- [x] AC2 (a) `server/modules/agent` 不存在：`test -d server/modules/agent` 非零；写下命令与读数。
- [x] AC3 (b) `server/index.ts` 语法树无含 `modules/agent` 的 import 说明符、无首参 `/api/agent` 的 `app.use`：写下说明符集合与 `app.use` 首参集合两个读数，并逐字记录旧位置（`:43`/`:113-118`/`:326`）。
- [x] AC4 (c) 标识符零命中：对 `server/**`+`src/**` 非测试 `.ts`/`.tsx` 扫 `apiKeysDb`/`createAgentModule`/`API_KEYS_TABLE_SCHEMA_SQL`，各 0；写下扫描文件数与三个计数，并逐条列出被删除/改写的旧命中位置。
- [x] AC5 (d) 正例对照到位：(d1) 合成源码上三标识符各恰 1 次、注释与字符串 0 次；(d2) `database/index.ts` 上 `userDb` ≥1；(d3) 合成 index.ts 上 import 与 `app.use` 探测器各 1、被注释与普通字符串不命中，且 `"/api-docs.html"` 字符串字面量探测器命中。写下全部读数。
- [x] AC6 (e) `public/api-docs.html` 改写后既无 `/api/agent` 也无 `ck_`（写下 `grep -c` 两个值均为 0）；并证明判据同时实现了「文件不存在时扫 `src/**` 字符串字面量」分支（以 (d3) 的字符串字面量探测器用例为机械证据）。
- [x] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 重引 `createAgentModule` import ⇒ (b) 红；(ii) 恢复 `apiKeysDb` 导出 ⇒ (c) 红；(iii) 恢复含 `/api/agent` 的 api-docs.html ⇒ (e) 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 仓库门与该模块窄测：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/settings/tests/settings.service.test.ts` 退出 0（删除 apiKeys 桩后不残留失败用例）；判据只经本模块 `tests/` 组织、跨模块经 barrel，无深导入。写明各命令退出码与 lint error 计数。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（删除文件用 `(delete)`、新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 生产代码里真的找不到 `/api/agent` 的挂载与 `createAgentModule` 的 import：`server/modules/agent/` 目录不在，`server/index.ts` 不再 import/组装/挂载，判据以语法树读数为证，不是 grep 文本。
- `apiKeysDb`、`createAgentModule`、`API_KEYS_TABLE_SCHEMA_SQL` 三个标识符在 `server/**`+`src/**` 非测试源里各 0 次（读数为扫描计数），其中 `API_KEYS_TABLE_SCHEMA_SQL` 常量本身与 `api-keys.ts` 仓储真的被删，settings 模块不再接线旧仓储。
- `public/api-docs.html` 真的不再宣传已退役接口（`/api/agent` 与 `ck_` 各 0 次），是删掉描述不是注释掉。
- 正例对照在同一次运行里证明扫描器能报且不误报（合成源码代码位置命中、注释/字符串不命中；`userDb` 命中）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards`（删模块其内部文件；settings 改动保持 service/routes 薄；判据在本模块 `tests/`；跨模块只经 barrel）；不越界实现 AC-224/225/227 或前端。

## Touches

- server/modules/agent/index.ts (delete)
- server/modules/agent/agent.module.ts (delete)
- server/modules/agent/agent.routes.ts (delete)
- server/modules/agent/tests/agent.routes.test.ts (delete)
- server/index.ts
- server/modules/database/repositories/api-keys.ts (delete)
- server/modules/database/index.ts
- server/modules/database/schema.ts
- server/modules/settings/settings.module.ts
- server/modules/settings/settings.service.ts
- server/modules/settings/settings.routes.ts
- server/modules/settings/tests/settings.service.test.ts
- public/api-docs.html
- server/modules/oauth/tests/agent-retirement.test.ts (new)
- tasks/gap-ac226-retire-api-agent-and-plaintext-keys.md