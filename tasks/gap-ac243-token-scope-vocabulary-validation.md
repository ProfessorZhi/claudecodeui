---
id: gap-ac243-token-scope-vocabulary-validation
title: AC-243 令牌签发只接受 scope 词汇表里的五个值：拼错的、不带前缀的 read、cloudcli:admin、空列表、非字符串元素一律
  400 同一个 INVALID_SCOPE 且不建记录，缺省仍为 cloudcli:read，服务层直调 issue 同样被拒；判据
  server/modules/oauth/tests/access-token-scopes.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-243
---
## Proposal

AC-243（GOAL-020 退出条件 5；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §326–§335）要求令牌**签发时只接受 scope 词汇表里的五个值**：`cloudcli:read`、`cloudcli:session:send`、`cloudcli:session:create`、`cloudcli:session:control`、`cloudcli:approve`；预留的 `cloudcli:admin` 不可签发。读数：(a) 词汇表内任意非空子集都能签发，响应里的 scope 与请求一致且**去重**；(b) 拼错的 scope（如 `cloudcli:reed`）、不带前缀的 `read`、`cloudcli:admin`、空列表、非字符串元素，全部 400，带**同一个稳定错误码**，且**不创建任何记录**；(c) 缺省不带 scope 时仍只签发 `cloudcli:read`，与现状一致；(d) 服务层单独调用 `issue` 传入非法 scope 同样被拒，不能靠绕过路由签出。判据文件 `server/modules/oauth/tests/access-token-scopes.test.ts` 当前不存在，AC-243 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/oauth/tests/access-token-scopes.test.ts`。

现状（红态基线）：

- `server/modules/settings/settings.service.ts` 的 `createAccessToken`（`:185–189`）把 scope 判成 `Array.isArray(input.scopes) && length>0 && every(非空字符串)`：**任意非空字符串**都接受（拼错、`cloudcli:admin`、不带前缀的 `read` 都能签出），而**空列表/非数组会静默回落到默认 `['cloudcli:read']`**（不是 400）——这是 (b) 与取假形态 (i) 必红的来源。
- `server/modules/oauth/access-tokens.service.ts` 的 `issueToken`（`:127–135`）把 `input.scopes` 原样 `JSON.stringify` 写库，**没有任何词汇校验、没有去重**——服务层可被绕过直接签出非法/重复 scope，这是 (d) 与取假形态 (ii) 必红的来源。
- 全仓库无 scope 词汇表常量（grep `cloudcli:session:send|cloudcli:approve|SCOPE_VOCAB|ALLOWED_SCOPES|VALID_SCOPES` 只命中既有判据里的个别字面量）。

要交付：

1. **scope 词汇表与规范化器（唯一定义，`server/modules/oauth/access-tokens.service.ts`；经 `server/modules/oauth/index.ts` barrel 导出）**（遵守 `$backend-module-standards`）：
   - `export const ACCESS_TOKEN_SCOPES = ['cloudcli:read','cloudcli:session:send','cloudcli:session:create','cloudcli:session:control','cloudcli:approve'] as const;`——**只含可签发的五个**；`cloudcli:admin` 不在表内（预留、不可签发）。
   - `export function normalizeAccessTokenScopes(scopes: unknown): { ok: true; scopes: string[] } | { ok: false }`——纯函数：非数组、空数组、任一元素非字符串、任一字符串不在 `ACCESS_TOKEN_SCOPES` 内 ⇒ `{ ok:false }`；否则返回**按首次出现顺序去重**后的数组。这是「词汇校验 + 去重」的唯一实现，签发路由与签发服务都调它（不得各写一份）。
   - barrel `server/modules/oauth/index.ts` 导出 `ACCESS_TOKEN_SCOPES` 与 `normalizeAccessTokenScopes`（消费者：`settings.service.ts`、本模块 `issueToken`、判据），并在定义处写消费方注释。
2. **服务层校验 + 去重（`server/modules/oauth/access-tokens.service.ts` 的 `issueToken`）**：entry 处先 `normalizeAccessTokenScopes(input.scopes)`；`!ok` ⇒ 返回 `{ ok:false, reason:'invalid_scope' }` 且**不写任何行**；`ok` ⇒ 用去重后的 `scopes` 写库。把 `IssueAccessTokenResult` 的失败 union 从 `reason:'invalid_expiry'` 扩为 `reason:'invalid_expiry' | 'invalid_scope'`（既有 `invalid_expiry` 语义不变）。这是 (d) 的机制：越过路由直调 `issueToken` 也签不出非法/重复 scope。
3. **路由/服务层校验（`server/modules/settings/settings.service.ts` 的 `createAccessToken`）**：区分「缺省」与「显式非法」——
   - `input.scopes === undefined` ⇒ 用默认 `['cloudcli:read']`（(c)，与现状一致）。
   - 否则调用 `normalizeAccessTokenScopes(input.scopes)`；`!ok` ⇒ `throw new AppError('scopes must be a non-empty subset of known scopes', { code:'INVALID_SCOPE', statusCode:400 })`（**稳定错误码逐字为 `INVALID_SCOPE`**，所有 (b) 形态同一个）；`ok` ⇒ 用去重后的数组。
   - 响应体里的 `token.scopes` 必须是**去重后**的数组（(a)），且与写库的 `scopes` 一致；`input.scopes` 为显式空数组 `[]` **不得**回落到默认（必须 400）。
4. **判据文件 `server/modules/oauth/tests/access-token-scopes.test.ts`（红先行）**：形制照 `server/modules/oauth/tests/access-tokens.routes.test.ts`——真实 express 4 应用 + 真实 HTTP + 真实 better-sqlite3 临时库，`createSettingsRouter(createSettingsService({ ...accessTokens: 真 service... }))`，注入的认证中间件把 `req.user` 戳成 owner。HTTP 调用用 `node:http`（**不用 `fetch`**——`listen(0)` 会抽到 undici 拒绝的端口；见 AC-240/AC-241/AC-242 同款说明与 `server/modules/debug-agent/tests/debug-agent-control-plane.test.ts`）。读数各自独立成断言并逐字写出原始值：
   - (a) 词汇表内子集：逐一 POST 若干非空子集（每个单元素、一个两元素子集、全五元素、以及一个**含重复项**的请求如 `['cloudcli:read','cloudcli:read','cloudcli:approve']`），断言 201；响应 `token.scopes` 与请求**集合相等且无重复、长度等于唯一数**；再把该 token id 从真库读回（`accessTokensDb.findById` 或等价 SQL），断言存库 `JSON.parse(scopes)` 与响应一致；写出每条的请求/响应/存库三元组。
   - (b) 五种非法：`['cloudcli:reed']`、`['read']`、`['cloudcli:admin']`、`[]`、`['cloudcli:read', 42]`（可再加 `['cloudcli:read','']`），逐一 POST，断言**全部 400**、响应体 `error.code` **全部等于 `INVALID_SCOPE`**（逐字列出每个 body 与 code），并对每次记录 `access_tokens` 行数**前后不变**（不创建任何记录）。
   - (c) 缺省：POST `{ name, expiresInDays }`（不带 `scopes`）⇒ 201，`token.scopes` 深等于 `['cloudcli:read']`（正例对照，防「一律 400」也通过）。
   - (d) 服务层直调：用同一真 service，`issueToken({ userId, scopes:['cloudcli:reed'] })`、`issueToken({ userId, scopes:['cloudcli:admin'] })`、`issueToken({ userId, scopes:[] })` 均返回 `{ ok:false, reason:'invalid_scope' }` 且行数不变；正例对照 `issueToken({ userId, scopes:['cloudcli:read'] }).ok === true` 且行数 +1（防「一直拒绝」也通过）。写出每次返回值与行数。
5. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 保留「任意非空字符串」——把 `normalizeAccessTokenScopes` 改成只要求非空字符串数组（或路由绕过词汇校验）⇒ (b) 必须红；
   (ii) 只在路由校验、服务层不校验——删掉 `issueToken` 里的 `normalizeAccessTokenScopes` 调用 ⇒ (d) 必须红；
   (iii) 允许 `cloudcli:admin`——把 `cloudcli:admin` 加进 `ACCESS_TOKEN_SCOPES` ⇒ (b) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-243" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-243`；`grep -rln "AC-243" tasks/` 只命中 AC-240/AC-241/AC-242 的边界段（它们各自声明「不做 scope（AC-243）」）。本任务与 AC-239（依赖声明）、AC-240（传输与认证缝）、AC-241（令牌认证）、AC-242（回环守卫）机制不同：本任务只收紧**签发路径的 scope 词汇校验与去重**，不重写传输、不做令牌认证（AC-241）、不做回环（AC-242）、不做审计（AC-244）、不做工具（AC-245+）、不做设置页与冒烟。回归面（settings 路由工厂 + oauth service + 真 sqlite）已存在，本任务无机械前置。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-243 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/access-token-scopes.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/oauth/tests/access-token-scopes.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-token-scopes.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 词汇表内任意非空子集签发 201，响应 `token.scopes` 与请求集合相等、无重复、长度等于唯一数，且存库 `scopes` 与响应一致；含一个带重复项的请求验证去重；逐字列出请求/响应/存库三元组。
- [x] AC4 (b) 五种（拼错 `cloudcli:reed`、不带前缀 `read`、`cloudcli:admin`、空列表、非字符串元素）全部 400 且 `error.code` 全等于 `INVALID_SCOPE`，每次 `access_tokens` 行数前后不变；逐字列出五条 body 与行数。
- [x] AC5 (c) 缺省不带 scope ⇒ 201 且 `token.scopes` 深等于 `['cloudcli:read']`（正例对照）；逐字写状态码与 scopes。
- [x] AC6 (d) 服务层直调 `issueToken`：非法 scope 返回 `{ ok:false, reason:'invalid_scope' }` 且行数不变；合法 scope 返回 `ok:true` 且行数 +1（正例对照）；逐字列每次返回值与行数。
- [x] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 任意非空字符串 ⇒ AC4 红；(ii) 只在路由校验、服务层不校验 ⇒ AC6 红；(iii) 允许 `cloudcli:admin` ⇒ AC4 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC8 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；既有 `server/modules/oauth/tests/access-tokens.service.test.ts`、`access-tokens.routes.test.ts`、`server/modules/settings/tests/settings.service.test.ts` 不改一字仍逐字通过。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 令牌真的只能按词汇表签发：经**真实 HTTP** 走生产设置路由工厂，词汇表内子集签出（响应与存库 scope 一致且去重），五种非法形态同一个 400 `INVALID_SCOPE` 且不建记录，缺省仍为 `cloudcli:read`——不是「判据文件存在」就算数。
- 服务层真的也校验：越过路由直调 `issueToken` 传非法 scope 被拒，`cloudcli:admin` 直调也被拒，不能靠绕过路由签出；合法直调仍能签出（两向都从真 service + 真库读回）。
- 词汇表是**唯一定义**：签发路由与签发服务调用同一个 `normalizeAccessTokenScopes`，没有第二份词汇或校验副本（`cloudcli:admin` 只在词汇表缺席处体现，不得在别处被硬编码放行）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、词汇/规范化器单一定义且导出带消费方注释、路由薄、测试放 `server/modules/oauth/tests/`、不导出无消费者符号）与 AGENTS.md；不越界实现 AC-244–AC-257。

## Touches

- server/modules/oauth/access-tokens.service.ts
- server/modules/oauth/index.ts
- server/modules/settings/settings.service.ts
- server/modules/oauth/tests/access-token-scopes.test.ts (new)（判据）
- tasks/gap-ac243-token-scope-vocabulary-validation.md

## Notes

- 判据文件路径由 AC-243 的 criterion 命令钉死：`server/modules/oauth/tests/access-token-scopes.test.ts`；存在性闸逐字输出该路径。
- 判据的 HTTP 调用用 `node:http` 不用 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（见 AC-240/AC-241/AC-242 的同款说明与内存 `undici-bad-port-lottery-in-listen0-route-tests`）；既有 `access-tokens.routes.test.ts` 用 `fetch` 只是没抽中坏端口，本判据按同 goal 兄弟判据的更稳做法。
- 稳定错误码逐字为 `INVALID_SCOPE`（与既有 `INVALID_EXPIRES_IN` / `TOKEN_NAME_REQUIRED` 同形制）。(b) 的五种形态必须**同一个**码；判据断言所有 code 相等，而非只断 400。
- 去重语义：`normalizeAccessTokenScopes` 按**首次出现顺序**去重（如 `['cloudcli:approve','cloudcli:read','cloudcli:approve']` → `['cloudcli:approve','cloudcli:read']`）；判据至少写一条显式的重复项样例断言其去重结果。
- 词汇归属：词汇与规范化器是 OAuth 令牌领域契约，定义在 `access-tokens.service.ts` 并经 OAuth barrel 导出；`settings.service.ts` 与判据都从 `@/modules/oauth/index.js` 导入（跨模块只经 barrel）。若按 `$backend-module-standards`「≥2 处使用 → `server/shared/utils.ts`」判定该落在 shared，**OAuth barrel 必须原样再导出**，使消费者与判据的导入路径不变。
- `settings.module.ts` 无需改动（它已把 `issue` 接到 oauth service）；本任务只在 service 层收紧，不动装配。
- 边界：AC-244 审计、AC-245+ 工具、AC-254/255 设置页、AC-256/257 冒烟不属本任务。

## Execution evidence

工作树：`/data/home/yale/work/claudecodeui-worktrees/gap-ac243-token-scope-vocabulary-validation`（分支 `task/gap-ac243-token-scope-vocabulary-validation`，实现提交 `fb85d0b6`，基线 develop=`f409047e`）。

### AC1 红态基线（改动前）
命令：
```
for f in server/modules/oauth/tests/access-token-scopes.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-token-scopes.test.ts
```
输出（exit 1）：`缺判据文件：server/modules/oauth/tests/access-token-scopes.test.ts`

### AC2 判据绿
命令同上，退出 0。读数：`# tests 5`、`# pass 5`、`# fail 0`。

### AC3 (a) 词汇表内子集（201，集合相等、去重、存库一致）
```
request=["cloudcli:read"]                          status=201 response=["cloudcli:read"]                          stored=["cloudcli:read"]
request=["cloudcli:session:send"]                  status=201 response=["cloudcli:session:send"]                  stored=["cloudcli:session:send"]
request=["cloudcli:session:create"]                status=201 response=["cloudcli:session:create"]                stored=["cloudcli:session:create"]
request=["cloudcli:session:control"]               status=201 response=["cloudcli:session:control"]               stored=["cloudcli:session:control"]
request=["cloudcli:approve"]                       status=201 response=["cloudcli:approve"]                       stored=["cloudcli:approve"]
request=["cloudcli:read","cloudcli:approve"]       status=201 response=["cloudcli:read","cloudcli:approve"]       stored=["cloudcli:read","cloudcli:approve"]
request=[all five]                                 status=201 response=[all five]                                 stored=[all five]
request=["cloudcli:read","cloudcli:read","cloudcli:approve"] status=201 response=["cloudcli:read","cloudcli:approve"] stored=["cloudcli:read","cloudcli:approve"]  <- 去重
```

### AC4 (b) 五种非法（全 400 INVALID_SCOPE，行数不变）
```
scopes=["cloudcli:reed"]      status=400 code=INVALID_SCOPE rows 0->0 body={"success":false,"error":{"code":"INVALID_SCOPE","message":"scopes must be a non-empty subset of known scopes"}}
scopes=["read"]               status=400 code=INVALID_SCOPE rows 0->0 body={"success":false,"error":{"code":"INVALID_SCOPE","message":"scopes must be a non-empty subset of known scopes"}}
scopes=["cloudcli:admin"]     status=400 code=INVALID_SCOPE rows 0->0 body={"success":false,"error":{"code":"INVALID_SCOPE","message":"scopes must be a non-empty subset of known scopes"}}
scopes=[]                     status=400 code=INVALID_SCOPE rows 0->0 body={"success":false,"error":{"code":"INVALID_SCOPE","message":"scopes must be a non-empty subset of known scopes"}}
scopes=["cloudcli:read",42]   status=400 code=INVALID_SCOPE rows 0->0 body={"success":false,"error":{"code":"INVALID_SCOPE","message":"scopes must be a non-empty subset of known scopes"}}
五条 code 集合大小 = 1
```

### AC5 (c) 缺省
`status=201 token.scopes=["cloudcli:read"] stored=["cloudcli:read"]`

### AC6 (d) 服务层直调
```
issueToken(["cloudcli:reed"])  = {"ok":false,"reason":"invalid_scope"} rows=0
issueToken(["cloudcli:admin"]) = {"ok":false,"reason":"invalid_scope"} rows=0
issueToken([])                 = {"ok":false,"reason":"invalid_scope"} rows=0
issueToken(['cloudcli:read'])  = ok=true id=1 rows 0->1
```

### AC7 取假形态（先提交 fb85d0b6，再变异；恢复命令均为 `git checkout -- server/modules/oauth/access-tokens.service.ts`，恢复后 `# pass 5 / # fail 0`）
- (i) 任意非空字符串：`normalizeAccessTokenScopes` 的 `!vocabulary.includes(scope)` → `scope.length === 0`。判据逐字失败行：`✖ (b) ... AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: actual: 201, expected: 400`（(d) 亦红）。⇒ AC4 红。
- (ii) 只在路由校验、服务层不校验：删去 `issueToken` 里的 `normalizeAccessTokenScopes` 调用（改 `const normalized = { ok: true as const, scopes: input.scopes };`）。判据逐字失败行：`✖ (d) ... actual: { ok: true, token: { id: 1, ... } }, expected: { ok: false, reason: 'invalid_scope' }`。⇒ AC6 红。
- (iii) 允许 cloudcli:admin：`ACCESS_TOKEN_SCOPES` 追加 `'cloudcli:admin'`。判据逐字失败行：`✖ (b) ... actual: 201, expected: 400`（(vocabulary) 与 (d) 亦红）。⇒ AC4 红。

### AC8 仓库门与不回归
- `npm run typecheck` 退出 0。
- `npm run lint` 退出 0；`: error ` 计数 = 0，`: warning ` 计数 = 206。
- 既有三套件未改一字：`access-tokens.service.test.ts` + `access-tokens.routes.test.ts` + `settings.service.test.ts` ⇒ `# tests 20 / # pass 20 / # fail 0`。

### AC9 改动清单（`git diff --stat develop...HEAD`，develop=`f409047e`）
```
 server/modules/oauth/access-tokens.service.ts          |  62 +++-
 server/modules/oauth/index.ts                          |   7 +
 server/modules/oauth/tests/access-token-scopes.test.ts | 334 ++++++++++++++++++++++++++++++ (new)
 server/modules/settings/settings.service.ts            |  22 +-
 4 files changed, 416 insertions(+), 9 deletions(-)
```
与 `## Touches` 逐条对齐（第 4 项为 ASCII ` (new)`）；`tasks/gap-ac243-token-scope-vocabulary-validation.md` 由 task_write 分支敏感提交。