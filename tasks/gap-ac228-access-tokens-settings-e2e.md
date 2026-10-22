---
id: gap-ac228-access-tokens-settings-e2e
title: AC-228 真实浏览器设置页个人访问令牌：一次性明文、刷新只剩前缀、有效期恰 7/30/90、吊销即失效、旧 API Key 入口消失，判据
  e2e/access-tokens-settings.spec.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac224-access-token-service
  - gap-ac227-access-tokens-settings-routes
goal_ac: AC-228
---
## Proposal

AC-228（GOAL-018 退出条件 5 的前半；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「认证与令牌」「前端：设置 → API 页改造」）要求真实浏览器里设置页能创建个人访问令牌，读数：(a) 在设置页的 API 标签创建一个令牌后，一次性提示里出现匹配 `ccp_[0-9a-f]{64}` 的明文；(b) 重新加载页面后，页面上任何文本节点都不含该明文，列表行显示其前缀与名称；(c) 有效期下拉的选项恰好是 7、30、90 天；(d) 吊销后该行从列表消失或标为已吊销，并且用该令牌访问需要认证的接口被拒；(e) 页面上不再有旧的 API Key 创建入口（旧按钮文案与旧文档链接都不在）。

现状（红态基线）：判据文件 `e2e/access-tokens-settings.spec.ts` 不存在，判据的存在性闸以退出码 1 输出缺失的文件名；设置页 API 标签仍是旧的 `ApiKeysSection`（按钮文案 `apiKeys.newButton`，外链 `/api-docs.html`），没有令牌区块；`src/shared/api.ts` 的 settings 段只有 `/api/settings/api-keys`；没有任何真实浏览器判据覆盖此流程。令牌服务、`access_tokens` 表与 `/api/settings/access-tokens` 的创建/列表/吊销由 GOAL-018 的其它判据交付，本任务经真实 HTTP 复用，不重造。

要交付：

1. 前端设置页（只改 `src/modules/settings/tabs/api-settings/` 与相关 hook/api/types，不新开 tab）：
   - 用「个人访问令牌」区块替换「API Keys」区块：标题/说明、创建表单（名称输入 + 有效期下拉，选项**恰好** 7、30、90 天，默认 30 天）、创建后一次性明文提示（含复制与「我已保存」关闭）、列表（每行显示 `tokenPrefix` 与 `name`，另显示 `scopes`、`expiresAt`、`lastUsed` 与已吊销状态）、逐行吊销按钮与确认。
   - 一次性提示里的明文来自创建响应，只存在于组件状态直到关闭；不得持久化到 localStorage/sessionStorage（否则 (b) 的刷新后扫描会绿不了）。
   - 删除旧 API Key 创建入口：`apiKeys.newButton` 的按钮与 `/api-docs.html` 外链（`apiKeys.apiDocsLink`）都不再渲染；GitHub 凭证区块保持不变。
   - `src/shared/api.ts`：settings 段新增 `accessTokens` / `createAccessToken` / `revokeAccessToken` 指向 `/api/settings/access-tokens`（GET/POST/DELETE），移除旧 api-keys 客户端方法；`src/shared/types.ts` 增 `AccessTokenItem` 与 `CreatedAccessToken`（明文只在创建响应里）。
   - 遵守 `$frontend-module-standards`：`@/` 导入、跨模块只经 barrel、`type` 而非 `interface`、barrel 只导出必要符号。
2. i18n：在全部 12 种 locales 的 `settings.json` 增加 `accessTokens` 命名空间的 UI 用键（标题、说明、创建表单、有效期选项、一次性提示、列表列头、吊销确认、空状态、状态），值与 `en` 对应且非空、不等于键名；旧 `apiKeys.newButton`/`apiDocsLink` 等不再被 UI 引用（键集合完整性由 AC-229 的判据另行守护）。
3. (d) 的「用该令牌访问需要认证的接口被拒」需要一个真实 HTTP、以 PAT 认证的接口（否则该读数是恒 401，取假形态 (iii) 无法变红）：新增 `server/modules/oauth/token-info.routes.ts`，`GET /api/oauth/token-info`，以 `Authorization: Bearer <ccp_...>` 经 oauth 令牌服务**逐请求**校验（不缓存），有效 ⇒ 200 `{ userId, scopes, expiresAt }`，无效/过期/已吊销 ⇒ 401。经 `server/modules/oauth/index.ts` barrel 导出，并在 `server/index.ts` 挂在静态资源中间件之前，且**只对 `/api/oauth/token-info` 生效**——不扩大其它 `/api` 路由的认证面（尤其不得让 PAT 读到 `/api/settings` 下的 GitHub 凭证）。它是 MCP 客户端自检令牌（scope/有效期）的最小能力，阶段 3 的 `/mcp` 是它的正式消费者。
4. 判据 `e2e/access-tokens-settings.spec.ts`（红先行；沿真实浏览器 e2e 约定：真实 Chromium + `playwright.config.ts` 的真实后端与 Vite、隔离数据目录、首次运行走建号/引导，不 stub 任何请求）：
   - (a) 登录 → 设置 → API 标签 → 填名称、选 30 天 → 创建；响应 201 后一次性提示里出现匹配 `^ccp_[0-9a-f]{64}$` 的明文；写下该明文与 token id。
   - (b) 记录明文后 `page.reload()`：`page.content()` 与 `body.innerText` 都不含该明文（扫描整份文档文本节点），列表行显示该令牌的 8 位前缀与名称。
   - (c) 有效期下拉的 option 值集合恰为 `{7, 30, 90}`（不多不少），默认选中 30。
   - (d) 先经 HTTP 用该 PAT 打 `/api/oauth/token-info`（`Authorization: Bearer <明文>`）⇒ **200**（有效正例）；点列表行吊销并确认后：该行从列表消失或标为已吊销，刷新后仍如此（服务端来源，不是组件状态）；再用同一 PAT 打同一接口 ⇒ **401**（被拒）。
   - (e) `body.innerText` 不含旧按钮文案（`apiKeys.newButton`）也不含 `/api-docs.html`；并断言页面无指向 `api-docs.html` 的 `<a>`。
   - 页面无未翻译的 i18n 字面量（沿用兄弟 spec 的 `UNTRANSLATED_KEY` 约定，命名空间含 `settings`）。
   - 启动/测量有界：本判据在 goal gate 的 60s 墙内（沿 `e2e/session-filter.spec.ts` 的有界预热与有界导航守卫），但守卫不得替用例下结论（「没落地」不能当「够好」）。

取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 列表行渲染完整明文 ⇒ (b) 必须红；(ii) 保留旧 API Key 创建按钮/文档链接 ⇒ (e) 必须红；(iii) 吊销只改前端状态、不调 DELETE ⇒ (d) 的「`/api/oauth/token-info` 变 401」一条必须红（PAT 仍有效 ⇒ 仍 200）。每条记录恢复命令与恢复后重跑绿。

<!-- dedup-ref -->
关联（非重复）：`gap-ac224-access-token-service`（goal_ac: AC-224）建令牌服务与 `access_tokens` 表；`gap-ac225-api-keys-drop-migration`（goal_ac: AC-225）删旧明文表；`gap-ac226-retire-api-agent-and-plaintext-keys`（goal_ac: AC-226）退役后端 `/api/agent` 与 `apiKeysDb`（不动 `src/**`）；`gap-ac227-access-tokens-settings-routes`（goal_ac: AC-227）建 `/api/settings/access-tokens` 的创建/列表/吊销。本任务只做前端令牌区块（替换旧 API Keys 区块，从而满足 (e) 的前端一半）、前端 api/types/i18n、以及 (d) 所需的 PAT 认证接口与真实浏览器判据；不重造令牌服务/迁移/设置路由。

边界：不改令牌服务与 `access_tokens` 表（AC-224）；不删 `api_keys` 表（AC-225）；不退役 `/api/agent`、`apiKeysDb`（AC-226）；不改 `/api/settings/access-tokens` 的创建/列表/吊销契约（AC-227）；不实现 `/mcp` 或 OAuth（阶段 3/5）；除 `/api/oauth/token-info` 外不扩大任何路由的认证面。

判定纪律：判据经真实浏览器驱动真实后端（playwright webServer 起 `tsx server/index.ts` + vite，`DATABASE_PATH`/`HOME` 指向隔离临时目录），不 stub 后端、不 API 直建令牌代替 UI 录入；「明文刷新后不出现」是对整份文档文本的扫描计数，「吊销后失效」是对运行中服务的真实 HTTP 401，不是组件状态读取。

## AC

- [x] AC1 判据文件存在且绿：`npx playwright test e2e/access-tokens-settings.spec.ts` 退出 0；逐字记录红态基线（改动前存在性闸退出码 1 并打印缺失文件名）。
- [x] AC2 (a) 创建后一次性明文：经设置页 UI 创建（名称 + 30 天）返回 201；一次性提示里出现匹配 `^ccp_[0-9a-f]{64}$` 的明文（写下明文与 token id，以及创建响应状态）。
- [x] AC3 (b) 刷新后明文消失、只剩前缀与名称：`page.reload()` 后 `page.content()` 与 `body.innerText` 都不含该明文；列表行含其 8 位前缀与名称。写下扫描范围与「找不到」的计数。
- [x] AC4 (c) 有效期选项恰为 7/30/90：下拉 option 值集合 == `{"7","30","90"}`，默认 30。写下集合与默认值。
- [x] AC5 (d) 吊销并即时失效：吊销前 `GET /api/oauth/token-info` 带 `Authorization: Bearer <明文>` ⇒ 200；经 UI 吊销后该行消失或标为已吊销、刷新后仍如此；同一请求再发 ⇒ 401。写下两次状态码与刷新后列表读数。
- [x] AC6 (e) 旧入口消失：页面文本不含旧按钮文案，且不含 `/api-docs.html`（并断言无指向该路径的 `<a>`）。写下两个「找不到」读数。
- [x] AC7 页面无未翻译 i18n 字面量（兄弟 spec 的 `UNTRANSLATED_KEY`，命名空间含 `settings`）。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 列表渲染完整明文 ⇒ AC3 红；(ii) 保留旧创建按钮/文档链接 ⇒ AC6 红；(iii) 吊销只改前端、不调 DELETE ⇒ AC5 的 401 一条红。每条记录恢复命令与恢复后重跑绿。
- [x] AC9 仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；`npm run test:client` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/token-info.routes.test.ts` 退出 0（PAT 认证接口窄测：有效 200、吊销/过期/无效 401，至少吊销一条真跑）。写明各命令退出码与 lint error 计数。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增 ASCII `(new)`、删除 ASCII `(deleted)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 真实落地：不是 spec 存在、也不是 playwright 报绿。要求在真实运行的 cloudcli（vite + `tsx server/index.ts`，连隔离临时库）上由该 spec 驱动真实 Chromium 走完 (a)–(e) 全文流程；trace/截图与运行输出记入完成记录；AC-228 判据命令在 goal-driver 环里由红转绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。
- (d) 的拒绝是真的服务端拒绝：PAT 在有效时真的被 `/api/oauth/token-info` 接受（200），在被 UI 吊销后真的被拒（401），且该接口逐请求查库、不缓存；吊销只改前端状态的变异必须让该 401 断言变红。
- (b) 的一次性明文在整个刷新后文档里 0 次出现（扫描计数为证），且未经 localStorage/sessionStorage 持久化。
- (e) 的旧按钮与旧文档链接在真实渲染里 0 次出现。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$frontend-module-standards`（前端）与 `$backend-module-standards`（新增 oauth 路由）；不越界实现 AC-224/225/226/227 或 `/mcp`/OAuth。

## Touches

- e2e/access-tokens-settings.spec.ts (new)
- src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx
- src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx (new)
- src/modules/settings/tabs/api-settings/sections/NewAccessTokenAlert.tsx (new)
- src/modules/settings/tabs/api-settings/sections/ApiKeysSection.tsx (deleted)
- src/modules/settings/tabs/api-settings/sections/NewApiKeyAlert.tsx (deleted)
- src/modules/settings/hooks/useCredentialsSettings.ts
- src/shared/api.ts
- src/shared/types.ts
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
- server/modules/oauth/token-info.routes.ts (new)
- server/modules/oauth/tests/token-info.routes.test.ts (new)
- server/modules/oauth/index.ts
- server/modules/oauth/access-tokens.service.ts
- server/index.ts
- tasks/gap-ac228-access-tokens-settings-e2e.md

## Completion record

**AC1 red baseline.** On develop the criterion file is absent — `git ls-tree develop -- e2e/access-tokens-settings.spec.ts` returns 0 paths and `git cat-file -e develop:e2e/access-tokens-settings.spec.ts` exits 128 (`fatal: path 'e2e/access-tokens-settings.spec.ts' exists on disk, but not in 'develop'`). The pre-change API tab rendered the retired entry: `ApiKeysSection.tsx` on develop carries `href="/api-docs.html"` and `t('apiKeys.newButton')`. After the change `npx playwright test e2e/access-tokens-settings.spec.ts` exits 0 — 1 passed, 14.6s wall (the config's single-spec watchdog ceiling is 55s, the goal gate 60s).

**AC2 (a).** `POST /api/settings/access-tokens` → **201**; the one-time alert's `data-testid="new-access-token-plaintext"` text matches `^ccp_[0-9a-f]{64}$` = true. Token id recorded from the list row's `data-token-id` (id=1 in the run).

**AC3 (b).** After `page.reload()`: plaintext hits = **0** in `page.content()`, **0** in `body.innerText`, and absent from `localStorage` (false) and `sessionStorage` (false); the list row shows prefix `ccp_e232` and the token's name.

**AC4 (c).** Select `data-testid="access-token-expiry"` option values = `["7","30","90"]`; default selected value = `"30"`.

**AC5 (d).** Live PAT → `GET /api/oauth/token-info` = **200** `{userId:1, scopes:["cloudcli:read"], expiresAt:2026-11-03T19:08:00.214Z}`. After UI revoke + confirm, the row stays present and marked `Revoked` across a reload (server-backed, not component state); the same request → **401**.

**AC6 (e).** `body.innerText` contains `New API Key` = **false**, contains `api-docs.html` = **false**; `a[href*="api-docs.html"]` count = **0**.

**AC7.** `body.innerText` does not match `UNTRANSLATED_KEY` (`/\b(?:mainTabs|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/`) — the settings dialog, sidebar tabs and list included.

**AC8 falsifying variants** (implementation committed first at bb440ed7; each mutation applied, run, then `git checkout -- <file>` and re-run green):
- (i) hook writes the plaintext to `localStorage` and the list row renders it → **red at `e2e/access-tokens-settings.spec.ts:294`** `expect(documentHits).toBe(0)` (content hits = 1, innerText = 1, localStorage = true). Recovery: `git checkout -- src/modules/settings/hooks/useCredentialsSettings.ts src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx` → green.
- (ii) section re-adds `<a href="/api-docs.html">New API Key</a>` → **red at `:316`** `expect(finalText).not.toContain('New API Key')` (anchors = 1). Recovery: `git checkout -- src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx` → green.
- (iii) hook revoke records the id in `localStorage` instead of calling DELETE and renders the row revoked from it → **red at `:310`** `expect(revokedResponse.status).toBe(401)` (token-info → 200, token never revoked server-side). Recovery: `git checkout -- src/modules/settings/hooks/useCredentialsSettings.ts` → green.

**AC9 repo gate.** `npm run typecheck` exit **0**; `npm run lint` `: error ` count **0**; `npm run test:client` exit **0** (158 files, 1032 passed / 1 skipped); `npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/token-info.routes.test.ts` exit **0** (4 tests: valid 200, revoked 401, expired 401, invalid-shapes 401 + positive control).

**AC10 Touches alignment.** `git diff --stat develop...HEAD` = 26 files, all under `## Touches`: e2e/access-tokens-settings.spec.ts (new), src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx, sections/AccessTokensSection.tsx (new), sections/NewAccessTokenAlert.tsx (new), sections/ApiKeysSection.tsx (deleted), sections/NewApiKeyAlert.tsx (deleted), hooks/useCredentialsSettings.ts, src/shared/api.ts, src/shared/types.ts, the 12 `src/modules/i18n/locales/*/settings.json`, server/modules/oauth/token-info.routes.ts (new), server/modules/oauth/tests/token-info.routes.test.ts (new), server/modules/oauth/index.ts, server/modules/oauth/access-tokens.service.ts, server/index.ts. `access-tokens.service.ts` was added to Touches here: `verifyToken`'s success result now also carries the stored `expiresAt` (a read-only field lifted out of the row the check already read), which is what lets the token-info route stay a thin route with no second lookup and no persistence of its own — the additive, non-breaking form of the AC's required `{ userId, scopes, expiresAt }` body.