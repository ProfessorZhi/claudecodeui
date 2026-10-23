---
id: gap-oauth-consent-spa-ui
title: OAuth 授权页改为 SPA（前端半）：/oauth/consent
  路由用应用主界面组件与主题渲染授权确认页（客户端身份、回调主机、按风险分组的 scope、Allow/Deny），未登录先登录再回到授权
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-oauth-consent-spa-backend-contract
---
## Proposal

用户已裁定：用与主界面一致的 SPA 页面替换 `server/modules/oauth/oauth-consent.routes.ts` 渲染的无样式服务端授权 HTML。后端半是 `gap-oauth-consent-spa-backend-contract`：`GET /oauth/authorize` 校验后 302 到 SPA 路由 `/oauth/consent?<原 oauth 查询串>`；SPA 调 `GET /api/oauth/authorize/context?<查询串>`（JWT）取 `{clientName, callbackHost, redirectUri, scopes:[{scope, description, required, writable}], state}`，再 `POST /api/oauth/authorize/decision`（`{client_id, redirect_uri, state, code_challenge, code_challenge_method, scopes[], action}`）得 `{redirectTo}`，最后 `window.location.assign(redirectTo)`。**最终字段名以后端任务文件为准，与本摘要不符时以后端任务为准并回写本任务。** 本任务只做前端：路由、模块、i18n 与真实浏览器判据；不改后端机制。手机（375px 视口）是主要场景，因为 ChatGPT/Gemini 的授权常在手机上完成。

要交付：

1. **模块与路由**：新建 `src/modules/oauth-consent/`（含 `index.ts` barrel，遵守 `$frontend-module-standards`：`@/` 导入、跨模块只经 barrel、`type` 而非 `interface`、导出带消费方注释）；`src/App.tsx` 增加 `/oauth/consent` 路由，位于项目工作区布局之外。未登录访问时落入既有登录流，登录后带着完整查询串回到 `/oauth/consent`（读 `src/modules/auth` 现有的登录后跳转机制，最小扩展）。
2. **页面内容**（用 `src/shared/ui` 组件与应用主题 token，深/浅色，mobile-first）：客户端名称突出；回调主机突出且视觉上区别于普通文字（防钓鱼提示「You will be sent to <host>」）；明示「当前登录身份」一行；scope 按风险分组——Read 固定勾选且禁用；写/动作类 scope（`session:send`、`session:create`、`session:control`、`approve`、`navigate`）默认不勾选、各带描述，任一写 scope 勾选时出现警告样式（复用 `src/shared/constants` 的 `ACCESS_TOKEN_SCOPE_OPTIONS` 思路与设置页访问令牌的 `writeScopeRisk` 文案）；说明日后如何吊销（设置 → 已连接的应用）；Allow / Deny 按钮，提交中有 loading/禁用态；错误态：无效/未知客户端 → 可读错误且**没有** Allow 按钮；401 → 去登录；网络失败 → 可重试；成功后跳转 `redirectTo`。
3. **api/types**：`src/shared/api.ts` 增加 context/decision 两个调用，`src/shared/types.ts` 增加对应类型（`type`，带用途注释）。
4. **i18n**：所有字符串走 react-i18next，键加到 `src/modules/i18n` 下**全部** locale 文件（既有 e2e 会标记未翻译字面量）。
5. **不引入新依赖。**

<!-- dedup-ref -->
边界（dedup）：按机制检索 `oauth/consent` 在任务库中无命中。相邻但不重叠：`gap-ac260-oauth-consent-page`（已有的服务端渲染授权页，被本任务与后端半替换其呈现层）；`gap-ac266-connected-apps-settings-browser-ui`（设置页「已连接的应用」，只作形制与 e2e 约定参照，授权后吊销入口在那里）；`gap-oauth-consent-spa-backend-contract`（机械前置，本任务 `depends_on`，拥有 context/decision 端点与 302 重定向契约）。本任务不实现任何后端端点。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 `for f in e2e/oauth-consent-page.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done`，退出码 1 并逐字输出 `缺判据文件：e2e/oauth-consent-page.spec.ts`。
- [x] AC2 判据绿：存在性闸通过后 `npx playwright test e2e/oauth-consent-page.spec.ts` 退出 0，写下 passed/总数与墙钟；真实 Chromium + 真实后端，不 stub 任何请求。
- [x] AC3 (a) 已登录用户打开授权 URL → 落在 `/oauth/consent`，显示客户端名称、回调主机；Read scope 勾选且禁用；scope 共 6 个；写 scope 全部未勾选。逐字写下读数。
- [x] AC4 (b) 勾选一个写 scope → 风险警告出现；点 Allow → 浏览器到达已注册回调且带 `code` + `state`；该 code 在 `/oauth/token`（PKCE）换得令牌，令牌访问 `/mcp` 成功，且授予的 scope == read + 所勾选项。逐字写下。
- [x] AC5 (c) 点 Deny → 回调带 `error=access_denied` 且**无** `code`。
- [x] AC6 (d) 未登录用户打开授权 URL → 登录 → 回到 `/oauth/consent` 且查询串完整（client_id、redirect_uri、state、code_challenge 逐项相等）。
- [x] AC7 (e) 未注册的 redirect_uri / 未知 client → 错误视图，没有 Allow 按钮，浏览器**未**导航到该坏 uri。
- [x] AC8 (f) 视口 375x812 截图：`scrollWidth <= clientWidth`（无横向溢出），Allow 按钮包围盒完全在视口内；同时轮询文本与几何，不以空占位行满足几何等待。
- [x] AC9 (g) 页面无未翻译 i18n 字面量（沿用兄弟 spec 的 `UNTRANSLATED_KEY`，命名空间含新增的授权页命名空间）；全部 locale 文件键集合与 `en` 一致。
- [x] AC10 (h) 反嵌入：`/oauth/consent` 文档响应带 `X-Frame-Options: DENY`。
- [x] AC11 取假形态必须红：(i) 让页面忽略所勾选的 scope ⇒ AC4 红；(ii) 让 Deny 调用 allow ⇒ AC5 红。每条记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [x] AC12 客户端 vitest：为页面组件补用例（若模块惯例有），`npm run typecheck` 退出 0、`npm run lint` 无 `: error `、`npm run test:client` 退出 0（受影响测试单文件运行，不做无界并发）。
- [x] AC13 若 `scripts/` 内存在 e2e 文件数 pin，则已 bump 并在 Touches 声明；否则写明「已核查无 pin」。
- [x] AC14 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标注 ASCII ` (new)`）。

## DoD

- 真实浏览器对真实服务端与真实 MCP 客户端注册，走完整流程：桌面与 375px 视口各走一遍并附截图；与设置页做主题一致性对比（按 `quay-webui-bootstrap-methodology` 技能做整体视觉审阅，执行者须先查阅该技能）。
- 授权结果由服务端真实决策：勾选的 scope 真的进入令牌，Deny 真的不发 code，坏 redirect_uri 真的不被导航；两条取假形态必须先红后恢复。
- 页面真的用应用主题与 `src/shared/ui` 组件，不是另一份无样式 HTML；未登录路径真的登录后回到授权。
- 遵守 `$frontend-module-standards` 与 AGENTS.md，无新依赖；测试按 `docs/operations/process-isolation-and-memory-caps.md` 单文件运行，不做无界 fan-out。

## Touches

- e2e/oauth-consent-page.spec.ts (new)（判据：真实浏览器全流程 + DoD 视觉腿）
- playwright.config.ts（`connectedAppsSelection` 增本 spec 的 OAuth env 注入缝）
- src/App.tsx（`/oauth/consent` 路由，置于工作区布局之外）
- src/modules/oauth-consent/index.ts (new)（barrel）
- src/modules/oauth-consent/OAuthConsentRoute.tsx (new)（页面组件）
- src/modules/oauth-consent/hooks/useOAuthConsent.ts (new)（状态机 hook）
- src/modules/oauth-consent/tests/oauthConsentPage.test.tsx (new)（组件 vitest）
- src/shared/api.ts（`oauthConsent.context` / `.decide`）
- src/shared/types.ts（context/decision/scope 类型）
- src/modules/i18n/config.ts（注册 consent 命名空间）
- src/modules/i18n/locales/en/consent.json (new)
- src/modules/i18n/locales/de/consent.json (new)
- src/modules/i18n/locales/es/consent.json (new)
- src/modules/i18n/locales/fr/consent.json (new)
- src/modules/i18n/locales/id/consent.json (new)
- src/modules/i18n/locales/it/consent.json (new)
- src/modules/i18n/locales/ja/consent.json (new)
- src/modules/i18n/locales/ko/consent.json (new)
- src/modules/i18n/locales/ru/consent.json (new)
- src/modules/i18n/locales/tr/consent.json (new)
- src/modules/i18n/locales/zh-CN/consent.json (new)
- src/modules/i18n/locales/zh-TW/consent.json (new)
- tasks/gap-oauth-consent-spa-ui.md

（原地条目的落实说明：`src/modules/auth/` **未改动** —— 既有 `ProtectedRoute` 在同一 URL 内联渲染 `LoginForm`，登录后查询串原样保留，最小扩展即零改动；`src/shared/constants.ts` **未使用** —— scope 选项由后端 context 端点提供，页面不复制本地表；`scripts/` **已核查无 e2e 文件数 pin**（见 AC13）。）

## Notes

- 后端半 `gap-oauth-consent-spa-backend-contract` 是机械前置；字段名、重定向与错误语义以其任务文件为准。
- e2e 形制参照 `e2e/connected-apps-settings.spec.ts`（`warmClientStartup`/`navigateBounded`/`UNTRANSLATED_KEY`、`selectedSpecFiles()` 的 env 注入缝：OAuth 端点需 `MCP_ENABLED`/`MCP_OAUTH_ENABLED`/`PUBLIC_BASE_URL` 仅对本 spec selection 注入，若需改 `playwright.config.ts` 须补入 Touches）。
- 避开仓库 e2e 教训：onboarding 走查中不得有无界裸点击；有界等待；文本与几何同谓词轮询；守卫不得替用例下结论。
- e2e spec 不受 server 测试文件数 pin 约束，但 scripts/ 下若有 e2e 计数 pin 须 bump 并声明。
- Touches 中带「实现时列出」的条目在执行时须替换为具体文件，不得留裸目录。

## 完成记录

worktree `/data/home/yale/work/claudecodeui-worktrees/gap-oauth-consent-spa-ui`，分支 `task/gap-oauth-consent-spa-ui`。
- `8bdfc156 feat(oauth-consent): render the authorization screen as an SPA`（22 文件，实现）
- `d791d090 test(oauth-consent): add the DoD visual-review legs to the consent criterion`（DoD 视觉腿）

merge-base `e9914c7f`；退出前 `git merge --no-edit develop` = **Already up to date**（develop 未前进，无冲突）。

### 机制

`/oauth/consent` 路由挂在 `src/App.tsx` 的工作区布局之外。页面 `OAuthConsentRoute.tsx` 是纯渲染层，状态机在 `hooks/useOAuthConsent.ts`：加载 `GET /api/oauth/authorize/context?<查询串>`（经 `authenticatedFetch` 带 JWT），read scope 预勾选并禁用，写 scope 默认清空；提交 `POST /api/oauth/authorize/decision` 后 `window.location.assign(answer.redirectTo)`。**授权判定完全由服务端做**：页面提交的是勾选集合，服务端与 scope 词表求交后才落库。错误面四态（missing-request / invalid-request / unauthorized / network），其中只有 network 给重试按钮；**任何错误面都不渲染 Allow 按钮**，所以校验失败的请求不可能被误批准。头部注释、`SCOPE_MESSAGE_KEYS`（scope→`scopes.<leaf>`）、`ERROR_MESSAGE_KEYS` 与 `ConsentShell` 均为模块私有。

### 逐 AC 读数（最后一条全绿运行的逐字输出）

- **AC1**（改动前）`for f in e2e/oauth-consent-page.spec.ts; do …` → 退出码 **1**，stderr 逐字 `缺判据文件：e2e/oauth-consent-page.spec.ts`。
- **AC2** `npx playwright test e2e/oauth-consent-page.spec.ts` → 退出 **0**，`1 passed (25.2s)`，用例体 13.3s（含 DoD 视觉腿）。真实 Chromium、真实后端、真实 DCR 客户端，无 stub。
- **AC3** `(a) GET /oauth/authorize -> 302, Location: "/oauth/consent?client_id=…&redirect_uri=http%3A%2F%2F127.0.0.1%3A15903%2Fcallback&response_type=code&state=state-e2e-consent&code_challenge=…&code_challenge_method=S256"`
  `(a) page at /oauth/consent; client="E2E Consent App"; callback host="127.0.0.1:15903"; identity="Signed in as e2euser"; scopes=6; checked=["cloudcli:read"]; disabled=["cloudcli:read"]`
- **AC4** `(b) ticking cloudcli:navigate showed the risk warning: "This application will be able to send, create and control sessions. Only allow it if you trust it."`
  `(b) browser reached the callback: http://127.0.0.1:15903/callback?code=8f906474…&state=state-e2e-consent`
  `(b) POST /oauth/token -> 200, token_type="Bearer"`
  `(b) POST /mcp with the minted token -> 200 "event: message\ndata: {\"result\":{\"protocolVersion\":\"2025-06-18\",…`
  `(b) the server stored grant scopes: ["cloudcli:read","cloudcli:navigate"]`
- **AC5** `(c) browser reached the callback: http://127.0.0.1:15903/callback?error=access_denied&state=state-e2e-consent`（无 `code` 参数）
- **AC6** `(d) signed out, the URL is /oauth/consent?client_id=5258b261…&redirect_uri=…&response_type=code&state=state-e2e-consent&code_challenge=…&code_challenge_method=S256`
  `(d) after login the browser is at /oauth/consent?client_id=5258b261…&redirect_uri=…&response_type=code&state=state-e2e-consent&code_challenge=…&code_challenge_method=S256`（四参数逐项相等）
- **AC7** `(e) GET /oauth/authorize (unregistered redirect_uri) -> 400, Location: null`
  `(e) unregistered redirect_uri -> "This authorization request is not valid. It may have expired or come from an unregistered application."；browser still at /oauth/consent`
  `(e) GET /oauth/authorize (unknown client) -> 400, Location: null`
- **AC8** `(f) 375x812: scrollWidth=375 clientWidth=375; Allow={"text":"Allow","left":41,"top":667,"right":334,"bottom":707,"width":293,"height":40}`（无横向溢出；包围盒四边均在 375×812 内；几何与文案同谓词轮询）
- **AC9** `(g) page text carries an untranslated key: no`
  `(g) consent namespace key count 25 in every locale: de=25, en=25, es=25, fr=25, id=25, it=25, ja=25, ko=25, ru=25, tr=25, zh-CN=25, zh-TW=25`
- **AC10** `(h) GET /oauth/consent -> 302, X-Frame-Options: "DENY", CSP: "frame-ancestors 'none'"`
  （说明：开发态无 `dist/index.html`，`static-assets.module.ts` 的 `onMissingIndex` 使该请求落到 302 而非 200；头部断言在重定向上仍成立，200 文档面由后端判据 `server/modules/oauth/tests/oauth-consent-page.test.ts` (h) 在真实静态层上另行证明。）

### AC11 两条取假形态（先红后恢复）

**(i) 页面忽略所勾选的 scope** —— 变异 `useOAuthConsent.ts` 的提交体：`scopes: action === 'allow' ? selectedScopes : []` → `scopes: []`。
逐字红（`/tmp/oauth-mut-i.log`）：
```
(b) the server stored grant scopes: ["cloudcli:read"]
    Error: expect(received).toEqual(expected) // deep equality
    - Expected  - 1
    + Received  + 0
      Array [
    -   "cloudcli:navigate",
        "cloudcli:read",
      ]
      478 |     expect([...granted].sort()).toEqual([READ_SCOPE, WRITE_SCOPE].sort());
```
（写 scope 勾了却未进令牌 ⇒ AC4 红。）

**(ii) Deny 调用 allow** —— 变异 `OAuthConsentRoute.tsx` 的 Deny 按钮：`onClick={() => decide('deny')}` → `onClick={() => decide('allow')}`。
逐字红（`/tmp/oauth-mut-ii.log`）：
```
(c) browser reached the callback: http://127.0.0.1:1105/callback?code=a2da181e…&state=state-e2e-consent
    Error: expect(received).toBe(expected) // Object.is equality
    Expected: "access_denied"
    Received: undefined
      485 |     expect(denied.params.error).toBe('access_denied');
```
（Deny 竟发出 code ⇒ AC5 红。）

恢复命令：两处 `git checkout -- src/modules/oauth-consent/hooks/useOAuthConsent.ts src/modules/oauth-consent/OAuthConsentRoute.tsx`；恢复后重跑判据回到 `1 passed`。

### AC12 工具链

- `npm run typecheck` → 退出 **0**。
- `npm run lint` → 退出 **0**，无 `: error ` 行（余下均为未触及文件的既有 warning）。
- 受影响客户端测试 6 文件 / 40 用例（`oauthConsentPage.test.tsx` 8、`localeDuplicateKeys.test.ts` 3、`readApiJson.test.ts` 4、`sendOnEnter.test.tsx` 8、`useScheduledMessagesSessionSwitch.test.tsx`、`voiceClientAsrRouting.test.ts`）→ 全绿退出 0；按文件/目录运行，未做无界并发。
- **AC13** 穷举检索 `scripts/`（含 `list-script-tests.mjs`、`asr-*`、`e2e-*`）**未发现任何 e2e 文件数 pin**；无需 bump。
- **AC14** `git diff --stat develop...HEAD` = **22 files changed, 1905 insertions(+), 2 deletions(-)**，与 `## Touches` 逐条对齐（新增文件均标 ` (new)`）。

### DoD 视觉审阅

按 `quay-webui-bootstrap-methodology` 作整体视觉审阅。**机械半**：该技能要求的 Lighthouse（a11y≥90 / best-practices≥90）在本机不可执行 —— `lighthouse`/`chromium` 二进制不在 PATH，`lighthouse`/`@axe-core/playwright`/`playwright-lighthouse` 均非依赖，且本任务明令「不引入新依赖」，故如实记录不可执行，改用无依赖的就地读数作为替代证据（读渲染后的文档：所有可见 `button, a[href], input, select, textarea` 的可访问名、标题层级序列、以及每条文本按 WCAG AA（大字号 3:1 / 常规 4.5:1）的对比度）。读数：`(visual) unnamed controls=[]; headings=[1]; below-AA text runs=[]`。
（该探针首跑曾误报回调提示 low-contrast —— 它把 `bg-amber-500/10` 的半透明覆盖层当作不透明底色，量到 1.29；改为自底向上合成每个祖先层的 alpha 后，真实底色是卡片深色面，读数转晴。这是探针缺陷，非页面缺陷。）

**整体视觉审阅**：fresh-context 子代理（未读过实现）对 5 张截图给出结论 **CONCERNS**，摘要与我的裁定：

| # | 审阅意见 | 裁定 |
|---|---|---|
| 1 | 1280×800 与 375×812 默认滚动位下 Allow/Deny 在首屏之下 | **成立**，且属设计取舍：6 条 scope 各带描述，动作置于权限清单之后（授权页的常规形制）；卡片整体超出视口可滚动，未被裁切（AC8 已在视口内验证包围盒）。 |
| 2 | 授权页 H1 用衬线体，设置页全无衬线 | **不成立**：`font-serif … font-bold tracking-tight` 是本仓库整页标题的既有惯例 —— `src/modules/auth/AuthScreenLayout.tsx:44`（登录整页）与 onboarding 各步骤同款；审阅者的参照是设置「弹窗」，弹窗用无衬线，二者不冲突。 |
| 3 | 每条 scope 各占一个有边框盒子，与设置页单一分组面板不同 | **成立但接受**：每条是可独立点按、且各带说明的 targets，盒子承载点按区域。 |
| 4 | 锁定的 read scope 无「(required)」/锁形提示 | **与设置页同形**：`AccessTokensSection.tsx:158` 读基线同样是 `disabled` + 勾选，无额外标注。 |
| 5 | 浅色下禁用勾选框的白勾对浅灰底对比偏弱 | **与设置页同构**：`AccessTokensSection.tsx:158-166` 用完全相同的 `className="h-4 w-4 rounded border-input"` 原生 checkbox + `disabled`，本页 `ScopeRow` 照搬该惯例；非本页引入的偏离。 |
| 6 | 浅色回调提示正文对比「临界」 | **探针读数不支持**：合成 alpha 后该 14px/400 文本达 AA；`below-AA text runs=[]`。 |
| 7 | 头部用 CloudCLI 自己的 logo 会误指认请求方 | **不成立**：这是 CloudCLI 自身的授权页，展示自身标识是常规做法；请求方以文本 `context.clientName` 单列呈现。 |
| 8 | 「Permissions」缺少设置页的设置项图标/标题处理 | **相近**：设置页同位置是 `<legend className="mb-1 … text-sm text-muted-foreground">`，本页为 `<legend … text-sm font-medium text-foreground>`。 |
| 9 | 身份行 `Signed in as …` 是全卡最弱最小文字 | **与设置页 muted 次级文字同色阶**；且身份为次要信息。 |

审阅局限（如实记录）：未捕获「勾选写 scope / 风险警告」与错误、提交中、Deny 后各态截图，dark 主题下按钮样式因截图越界未能入镜；无浅色参照页可对比。以上局限均属截取面，不属页面缺陷。
