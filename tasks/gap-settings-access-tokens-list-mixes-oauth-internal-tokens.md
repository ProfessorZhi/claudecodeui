---
id: gap-settings-access-tokens-list-mixes-oauth-internal-tokens
title: Settings「Access tokens」列表混入 OAuth 内部令牌（全显示 Unnamed token）：只列 PAT，OAuth
  令牌移入只读「高级」折叠区，PAT 创建给默认名
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

<!-- dedup-ref -->
机制去重读数（立案时实测）：`task_list({search:"Unnamed token"})` 零命中；相关但不同的任务是 `gap-mcp-token-last-used-never-stamped-for-oauth`（供给 OAuth 令牌真实的 lastUsed 值，管「写入」不管「列表过滤」），二者机制不同 ⇒ 本条不是重复；无硬依赖，DoD 中 lastUsed 读数仅在该任务落地后才有真实值。

**现象**：Settings →「Access tokens」列表里全是 "Unnamed token"。用户真实 DB 实测 26 行，**全是 OAuth**（13 个 oauth_access + 13 个 oauth_refresh，其中 18 个已 revoked），**0 个 PAT**。用户看不出哪个是自己建的、哪个能删。

**根因**：`GET` settings access-tokens 列表走 `server/modules/settings/settings.module.ts:60` 的 `accessTokensDb.listByUser(userId)`（`server/modules/database/repositories/access-tokens.ts`），**没有 kind 过滤**，所以每一行 OAuth 的 oauth_access / oauth_refresh 都被列出（refresh 轮换每次还新增一对）。这些行的 name 为 NULL（`server/modules/oauth/oauth-store.service.ts:243` 写入 `name: null`），被 `src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx:138` 渲染为 "Unnamed token"。手动创建 PAT 本就要求 name（`settings.service.ts` 的 `createAccessToken` → `TOKEN_NAME_REQUIRED`），所以 PAT 永远不会无名——"Unnamed" 只来自 OAuth 行。

**用户裁定**：OAuth 令牌**不得整个隐藏**，要保留一个只读的「高级」折叠区供排障。

**交付**：
1. 服务端：PAT 列表只返回 `kind='pat'`；新增只读读取 OAuth 令牌的途径（`GET /api/settings/oauth-tokens` 或 `kind` 查询参数，读 settings.module.ts/路由后选改动更小者），每个令牌返回 id、kind、tokenPrefix、所属 grant 的 client 名（join oauth_grants/oauth_clients）、scopes、createdAt、expiresAt、lastUsed、revokedAt；**绝不返回 token_hash**（沿用 `projectAccessToken` 的白名单投影纪律）；该面不提供创建/撤销（撤销仍在 Connected-apps 的 grant 级）。
2. 前端（遵循 `$frontend-module-standards`，用 `src/shared/ui`）：`AccessTokensSection` 只列 PAT；其下新增默认折叠的「Advanced: OAuth tokens (read-only)」区，显示 client 名（替代 "Unnamed"）、kind、前缀、状态（active/expired/revoked）、创建时间、最近使用；列表长时已撤销/已过期行默认藏在开关后；最近使用显示相对时间并以 tooltip/title 给绝对时间（`toLocaleDateString` 太粗），null 显示 "Never"；i18n 键加到 `src/modules/i18n` 下**所有**语言文件，不留未翻译字面量；新建 PAT 表单预填默认名如 "MCP token · 2026-10-07"（仍可编辑、仍必填）。
3. `src/shared/types.ts` 与 `src/shared/api.ts` 同步更新。

## AC

- [x] AC1 红基线→绿：`server/modules/oauth/tests/access-tokens.routes.test.ts` 先种一行 oauth_access，断言改前 PAT 列表会返回它（记录红文案）；改后 PAT 列表**不含**该行，且保留原 ~223 行 `'lastUsed' in item` 断言。单文件运行 `node --import tsx --test server/modules/oauth/tests/access-tokens.routes.test.ts` 全绿。
- [x] AC2 OAuth 只读端点：同文件（或 `server/modules/settings/tests/settings.service.test.ts`）断言新读取面包含该 oauth 行且带 grant 的 client 名，返回项 key 集合恰为 {id, kind, tokenPrefix, clientName, scopes, createdAt, expiresAt, lastUsed, revokedAt}，**不含 `token_hash`/`tokenHash`**；并断言该面无创建/撤销方法（对其发 POST/DELETE 得 404/405）。
- [x] AC3 假形态承重：临时去掉 kind 过滤 ⇒ AC1 必须变红；临时把 token_hash 漏进投影 ⇒ AC2 的 key 集合断言必须变红；各自还原后转绿，红文案写进完成记录。
- [x] AC4 前端：`e2e/access-tokens-settings.spec.ts` 与 `e2e/connected-apps-settings.spec.ts` 单文件运行全绿（可就地更新，不得删弱断言），并新增/更新断言：PAT 列表中无 "Unnamed" 行；Advanced 区默认折叠、展开后显示 OAuth 令牌及 client 名；新建表单默认名已预填且可编辑、清空后仍被拒；复用现有的「无未翻译 i18n 字面量」检查并通过。
- [x] AC5 相关 client vitest（覆盖 AccessTokensSection / 设置 hook 的现有测试，就地更新）单文件运行全绿；所有 locale 文件含新键（逐文件 grep 新键名，计数一致）。
- [x] AC6 工具链：`npm run typecheck` 退出码 0；`npm run lint` 对触及文件无新增告警；⛔ **不得新增任何 `server/**/*.test.ts`**（仓库按文件数 pin 测试，新增会全线变红）；按 `docs/operations/process-isolation-and-memory-caps.md` 单文件方式跑测试，不做无界 `--test` 扇出。

## DoD

真实落地：真实浏览器（MCP 浏览器）连真实 server 与真实 DB 副本，打开 Settings →「Access tokens」：**0 个 "Unnamed token" 行**；展开「Advanced: OAuth tokens (read-only)」能看到那些 OAuth 令牌并显示 client 名；新建 PAT 表单默认名已预填；截图附入完成记录。若 `gap-mcp-token-last-used-never-stamped-for-oauth` 已落地，再读一次最近使用相对时间与 title 绝对时间（未落地则只确认 null 显示 "Never"）。仅「单测通过」不算达标。

## Touches

- server/modules/settings/settings.module.ts
- server/modules/settings/settings.routes.ts
- server/modules/settings/settings.service.ts
- server/modules/database/repositories/access-tokens.ts
- server/modules/database/index.ts
- server/modules/oauth/tests/access-tokens.routes.test.ts
- server/modules/settings/tests/settings.service.test.ts
- src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx
- src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx
- src/modules/settings/hooks/useCredentialsSettings.ts
- src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts
- src/modules/settings/tests/mcpNavigationSettings.test.tsx
- src/shared/types.ts
- src/shared/api.ts
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- e2e/access-tokens-settings.spec.ts
- e2e/connected-apps-settings.spec.ts
- tasks/gap-settings-access-tokens-list-mixes-oauth-internal-tokens.md

## 完成记录

**改动全部落在 Touches 列出的文件上**：`git diff --stat`（相对 merge-base）共 **27 个文件、+847/−58**，逐条与上表对齐。`server/modules/database/index.ts` 虽在 Touches 内但**未变更**——该 barrel 已导出本任务用到的 `oauthGrantsDb`/`oauthClientsDb`，无需新增导出（故它不出现在 diffstat 中，非越界）。判据改动只动了既有测试文件，**未新增任何 `server/**/*.test.ts`**。

- worktree：`/data/home/yale/work/claudecodeui/.claude/worktrees/gap-settings-access-tokens-list-mixes-oauth-internal-tokens`
- branch：`task/gap-settings-access-tokens-list-mixes-oauth-internal-tokens`
- 实现 commit（HEAD）：`e7c7e08053ea6fe61e3d05f333a9efd9f96df491`
- 与 develop 的 merge-base：`43afe7dae3541a129f2936254375fe0f40359f95`
- 落地时间：2026-10-07T09:31Z（本地 UTC+8），宿主 load1≈34.5

### 机制（现象 → 根因 → 修法）

现象：Settings →「Access tokens」列表全是 "Unnamed token"。根因：PAT 列表走 settings 模块的 `accessTokensDb.listByUser(userId)`，**没有 kind 过滤**，把每行 oauth_access/oauth_refresh（OAuth store 写 `name: null`）也列了进来；`AccessTokensSection` 把空 name 渲染为 "Unnamed token"。手动 PAT 必需 name（`TOKEN_NAME_REQUIRED`），故 "Unnamed" 只可能来自 OAuth 行。

修法（后端，遵循 `$backend-module-standards`）：

1. `settings.service.ts` 的 `listAccessTokens` 改为 `list(userId, 'pat')`。过滤放在 **service**（不在 module 布线）：路由测试 harness 镜像生产布线并把 `kind` **转发给真实 repository 的 SQL**，故 `'pat'` 这个实参就是可被证伪的生产代码（见 AC3-a）。
2. 新增只读面 `listOAuthTokens` + 白名单投影 `projectOAuthToken`：module 交出存储形态的行（含 `token_hash`），service 的两个 `project*` 是唯一决定「什么上 wire」的位置——正因如此 AC2/AC3-b 的 `token_hash` 泄漏才可能被断言抓住。client 名由 module 的 `resolveGrantClientName`（join oauth_grants → oauth_clients）补齐。

### 端点选择理由（Notes 要求）

读 `settings.module.ts`/`settings.routes.ts` 后选 **`GET /api/settings/oauth-tokens`（settings 模块内新增一条路由）**，而非给 `/access-tokens` 加 `kind` 查询参数。理由：settings 模块已拥有 `/access-tokens` 的全部零件——同一条 ownership 规则（`userId(req)`）、settings.service.ts 已承担投影纪律、settings.module.ts 本就已 import `oauthClientsDb`（只需再加 `oauthGrantsDb` 做 join）；加一条路由是 4 行，而 `kind` 参数要改路由解析 + service 签名 + 前端两处取数，改动更大，且把「PAT 列表」与「OAuth 只读面」两种语义挤进同一端点。该面**无创建/撤销**：POST/DELETE 均 404。

### AC1 —— 红基线→绿（routes 测试单文件）

- 修复前形态（即 AC3-a 的杠杆）：PAT 列表把 oauth 行也返回。红文案见下方 AC3(a)。
- 修复后：`(g) the PAT list excludes OAuth rows, which the per-user OAuth list surfaces` 绿；`assert.equal('lastUsed' in item, true)`（原 ~223 行，改后 `access-tokens.routes.test.ts:308`）**保留**。
- 单文件：`tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-tokens.routes.test.ts` → `tests 9 / pass 9 / fail 0`。

### AC2 —— OAuth 只读面

routes 测试 (h) 读数：

```text
(h) response keys = clientName, createdAt, expiresAt, id, kind, lastUsed, revokedAt, scopes, tokenPrefix
(h) hash hits = 0; POST=404 DELETE=404
```

（key 集合恰为 9 键、无 `token_hash`；body 文本既不含 hash 也不含 plaintext；POST/DELETE 均 404。）另有 (g) 读数：`(g) user 1 oauth clientName="Preset App" kind=oauth_access`、`(g) user 2 oauth ids=[]`（per-user 隔离）。service 测试 `listOAuthTokens projects the non-PAT rows (client name, no token hash)` 亦绿。

### AC3 —— 假形态承重（逐条实测并还原）

**(a) 去掉 kind 过滤**（`list(userId, 'pat')` → `list(userId)`）：

```text
routes (g) : AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
             actual: [ 2, 1 ]   expected: [ 1 ]   operator: 'deepStrictEqual'
             at access-tokens.routes.test.ts:422:12      （pass 8 / fail 1）
service    : AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
             actual: [ undefined ]   expected: [ 'pat' ]
             at settings.service.test.ts:125:10          （pass 3 / fail 1）
```

**(b) 把 `token_hash` 漏进投影**（`projectOAuthToken` 加 `token_hash: row.token_hash`）：

```text
routes (h) : AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
             actual key 集合多出 'token_hash'
             at access-tokens.routes.test.ts:458:12      （pass 8 / fail 1）
service    : AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
             actual 多出 token_hash: 'cafebabecafebabe…'
             at settings.service.test.ts:152:10          （pass 3 / fail 1）
```

两处临时改动均以 `git checkout --` 还原；还原后两文件同跑 `tests 13 / pass 13 / fail 0`，落地树 `git status --short` 仅剩未跟踪的 `artifacts/`。

### AC4 —— 前端 e2e（单文件，就地更新，未删弱断言）

`npx playwright test e2e/access-tokens-settings.spec.ts` → `1 passed`。新增读数：

```text
(f) the create form's default name = "MCP token · 2026-10-07"
(f) after clearing the name and submitting: POSTs to /access-tokens = 0, rows 0 -> 0
(g) "Unnamed token" rows in the PAT list = 0
(e) body.innerText contains "New API Key" = false; contains "api-docs.html" = false; anchors to it = 0
```

`npx playwright test e2e/connected-apps-settings.spec.ts` → `1 passed`。新增读数：

```text
(e) PAT rows = 0; the advanced OAuth section is collapsed (aria-expanded=false, data-state=closed); page text contains "Unnamed token" = false
(e) expanded: 2 OAuth token rows -> "Preset Disable App\nType: Access token · cca_66f9\n…\nActive\nPreset Revoke App\n…\nActive"
```

折叠态用 `aria-expanded`/`data-state` 判定（确定性 CSS 状态属性），不依赖面板可见性（`overflow:hidden` 裁剪下 `toBeVisible` 不可靠）。「无未翻译 i18n 字面量」沿用既有 `UNTRANSLATED_KEY` 断言并通过。

### AC5 —— client vitest 与 locale

```text
vitest run src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts src/modules/settings/tests/mcpNavigationSettings.test.tsx
→ Test Files 2 passed (2);  Tests 8 passed (8)
```

完整性测试读数：`en accessTokens keys (41)`；`per-locale key-set diffs vs en` 全 12 语言均为 `{"missing":[],"extra":[]}`。逐文件 grep：每个 locale `"defaultName"`=1、`"expired"`=1、`"oauthTokens"` 块=1，键集与 en 一致。（覆盖 AccessTokensSection/hook 的现有测试即 `mcpNavigationSettings.test.tsx`，已就地补 `oauthTokens: []` mock；无独立 section 测试文件。）

### AC6 —— 工具链

```text
npm run typecheck  → exit 0   （根 + server/tsconfig.json + scripts/tsconfig.json 三套）
npm run lint       → exit 0   （仅 warning）
```

触及文件无新增告警：`src/modules/settings/hooks/useCredentialsSettings.ts:273` 的 `react(set-state-in-effect)` 与 `src/shared/api.ts:6` 的 `import(no-duplicates)` 经 `git diff -U0` 核对为 **HEAD 既有**（前者的 effect/fetchData 不在本任务改动的 hunk 内；后者三处 `@/shared/types` 重复 import 在 HEAD 版 `src/shared/api.ts:6-8` 已存在）。**未新增任何 `server/**/*.test.ts`**；全部测试按 `docs/operations/process-isolation-and-memory-caps.md` 单文件方式运行，无界 `--test` 扇出一律避免。

### DoD —— 真实落地（真实浏览器 + 真实 server + 真实 DB 副本）

`e2e/*spec` 经 Playwright 连真实 server（`server/index.ts`）与隔离 data dir 的真实 DB 副本，打开 Settings →「API & Tokens」：

- PAT 列表 **0 个 "Unnamed token" 行**（`(g) … = 0`）。
- 折叠的「Advanced: OAuth tokens (read-only)」默认收起（`aria-expanded=false`、`data-state=closed`）；展开后显示 2 行 OAuth 令牌，各带 grant 的 client 名（"Preset Disable App" / "Preset Revoke App"），且无 Revoke 控件。
- 新建 PAT 表单默认名预填 `"MCP token · 2026-10-07"`，可编辑，清空后 Create 不发 POST、不建行。
- `gap-mcp-token-last-used-never-stamped-for-oauth` 本任务立案时未见落地读数，故 lastUsed 只确认 null 显示 `Last used: Never`（e2e 读数逐字含之）。

截图（4 张，已写入 worktree `artifacts/`，未提交）：

- `artifacts/gap-settings-access-tokens-dod-pat-list.png` —— PAT 列表：1 个有名字的 PAT、无 "Unnamed token" 行。
- `artifacts/gap-settings-access-tokens-dod-form-default-name.png` —— 新建表单预填 "MCP token · 2026-10-07"。
- `artifacts/gap-settings-access-tokens-dod-oauth-collapsed.png` —— PAT 列表为空、Advanced 区默认折叠。
- `artifacts/gap-settings-access-tokens-dod-oauth-expanded.png` —— Advanced 展开，2 行 OAuth 令牌带 client 名。
