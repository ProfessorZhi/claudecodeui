---
id: gap-mcp-token-last-used-never-stamped-for-oauth
title: OAuth 访问令牌与授权(grant)的 last_used 从不落库：/mcp 走 OAuth 路径不打点，Settings
  里令牌与已连接应用永远显示"从未使用"
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
机制去重读数（立案时实测）：`task_list({search:"last_used"})` 只命中 `gap-ac224-access-token-service`（done，建的是 PAT 令牌服务，其 AC3 只钉 PAT `verifyToken` 首次打点）、`gap-ac241-mcp-token-auth-shares-service`（done，AC7 (e) 只钉 PAT 令牌经 /mcp 后 `last_used` 非 null）、`gap-ac258-oauth-store-hash-and-revoke-cascade`（done，建 OAuth 三表与 `oauth_grants.last_used` 列但不写它）。三者都不认领「OAuth 路径不打点 + grant 无写入方 + 打点无节流 + 历史数据回填」这一机制 ⇒ 本条不是重复。

**现象（只读实测 `~/.cloudcli/auth.db`）**：`access_tokens` 有 13 行 `oauth_access` + 13 行 `oauth_refresh`、0 行 `pat`，其中 `last_used` 非 null 的为 **0** 行；`oauth_grants` 6 行，`last_used` 非 null 的为 **0** 行；而 `mcp_audit_log` 里却有 **16933** 次调用、涉及 12 个不同 `token_id`。即令牌明明在被大量使用，Settings 的令牌列表与「已连接应用」(connected apps) 行却永远显示"从未使用"。

**根因**：只有 PAT 路径 `createAccessTokensService().verifyToken`（`server/modules/oauth/access-tokens.service.ts:224`）调用 `accessTokensDb.updateLastUsed`。`/mcp` 的 OAuth 路径（`server/modules/mcp-gateway/mcp-gateway.auth.ts` 的 `resolvePrincipal` → `oauth.verifyAccessToken`，`server/modules/oauth/oauth-provider.service.ts` 约 :391）从不写 `last_used`；`oauth_grants.last_used` 列存在于 `server/modules/database/repositories/oauth-grants.db.ts`，但全仓没有任何写入方。另外 PAT 路径现在是"每次校验必写"，/mcp 高频调用下若对 OAuth 路径照搬同样写法会变成每请求一次写库，故需要节流。

**用户已裁定**：节流间隔 **60 秒**。

**要交付**：
1. 节流打点：校验成功时，仅当库中 `last_used` 为 null 或相对**注入时钟**已早于 60s 才写 `access_tokens.last_used`；PAT 的 `verifyToken` 与 OAuth 的 `verifyAccessToken` 两条路径都适用。OAuth 路径同时对所属 `oauth_grants.last_used` 适用同一 60s 规则（在 `oauth-grants.db.ts` 新增写入方，经 database barrel 导出并带消费方注释）。节流判定逻辑只放在**一处**共享 helper，不在两个服务里各抄一份。
2. 一次性回填（`server/modules/database/migrations.ts` 内的迁移，幂等、只填 NULL）：`access_tokens.last_used` = 该 `token_id` 在 `mcp_audit_log` 中的最大时间戳；`oauth_grants.last_used` = 该 grant 名下各令牌的最大值。**先核对 `mcp_audit_log` 的真实列名**（时间戳列与 token 关联列）再写 SQL，不凭记忆。
3. 遵守 `$backend-module-standards`：跨模块只经 barrel、不新建模块私有 types/utils 文件、导出符号带消费方注释。

**需要调和的既有判据（逐个读、原地更新、写进 Touches）**：`server/modules/oauth/tests/access-tokens.service.test.ts` 的 case (b)「a live token verifies and stamps last_used from the injected clock」（首次使用仍须成立；新增：60s 内第二次校验不重写，超过 60s 后重写）；`server/modules/oauth/tests/oauth-provider.test.ts`（新增 OAuth 打点 + grant 打点 + 节流用例）；`server/modules/oauth/tests/oauth-store.test.ts` 与 `server/modules/oauth/tests/oauth-settings.routes.test.ts` 若有断言 `lastUsed` 为 null 的地方需同步调整。

## AC

- [x] AC1 红态基线逐字记录：在改动前，用 oauth-provider 判据所用的真实临时库驱动一次 OAuth `verifyAccessToken` 成功，读回该令牌行与所属 grant 行，输出 `last_used` 为 NULL（写下完整命令与原始输出）。
- [x] AC2 节流（注入时钟，PAT 与 OAuth 两路各一组）：t0 首次校验 `last_used` 从 NULL 变为 t0；t0+59s 再校验 `last_used` 仍为 t0（未重写）；t0+61s 再校验 `last_used` 变为 t0+61s。命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-tokens.service.test.ts` 与 `npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-provider.test.ts` 各退出 0，并写下 `# pass` / `# fail` 读数。
- [x] AC3 grant 打点：OAuth 校验成功后 `oauth_grants.last_used` 非 null 且等于注入时钟当时值，同样遵守 60s 节流（59s 不重写、61s 重写）；在 `oauth-provider.test.ts` 中逐字写下读回值。
- [x] AC4 回填：在 `server/modules/database/tests/` 下**既有**的迁移判据文件里新增用例（不得新增测试文件）：造含 NULL `last_used` 的令牌/grant 与若干 `mcp_audit_log` 行，跑迁移后 NULL 被填为 audit 最大时间戳，grant 取其名下令牌最大值，已非 null 的值不被覆盖，重跑迁移结果不变（幂等）；写下该文件路径与 `# pass` 读数。
- [x] AC5 既有判据已调和：`access-tokens.service.test.ts` case (b) 首次使用断言仍成立；`oauth-store.test.ts` 与 `oauth-settings.routes.test.ts` 各单文件运行退出 0，不存在残留的"lastUsed 恒为 null"断言（写下 grep 读数）。
- [x] AC6 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿）：(i) 去掉节流（每次校验都写）⇒ AC2 的 59s 不重写用例红；(ii) 去掉 OAuth 路径打点 ⇒ AC2 的 OAuth 用例红；(iii) 去掉 grant 打点 ⇒ AC3 红；(iv) 回填改为无条件覆盖 ⇒ AC4 的"不覆盖非 null"用例红。
- [x] AC7 仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；节流逻辑只在一处共享 helper（`grep` 读数显示两条校验路径调用同一个 helper，无第二份 60s 比较）；新增导出带消费方注释。⛔ 不得新增任何 `server/**/*.test.ts`（仓库按文件数 pin 测试，新增会让它全线变红）；每个测试文件按 `docs/operations/process-isolation-and-memory-caps.md` 单文件运行，不做无界 `--test` 扇出。
- [x] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；列出实际改动文件清单。

## DoD

真实落地：对真实运行的服务实例，用一个 OAuth 访问令牌调用一次 `/mcp`，随后通过真实的 `GET /api/settings/oauth-grants` 读回，该授权所在行的 `lastUsed` 在节流窗口内变为非 null（写下请求与响应原文）；对应令牌列表接口读回的令牌 `lastUsed` 也非 null。对真实 `~/.cloudcli/auth.db` 的副本跑回填迁移后，13 行 oauth_access 令牌中凡在 `mcp_audit_log` 里出现过的均获得非 null `last_used`。仅「单测通过」不算达标。

## Verification evidence

实现提交：`70b9d262`（分支 `task/gap-mcp-token-last-used-never-stamped-for-oauth`，基点 develop `05c833c9`）。全部读数取自该提交后的工作树。

### AC1 红态基线（改动前）

命令（改动前的工作树，探针 `zz-ac1-baseline.mts` 用 oauth-provider 判据同一套 `createOAuthStore` + `createOAuthProvider` 在真实临时库上跑完 authorize → exchange → `verifyAccessToken` 成功，再读回两行）：

```
$ npx tsx --tsconfig server/tsconfig.json zz-ac1-baseline.mts
```

原始输出：

```
Database schema applied
Database migrations completed successfully
{
  "verifyAccessTokenOk": true,
  "tokenId": 1,
  "tokenLastUsed": null,
  "grantId": 1,
  "grantLastUsed": null
}
Database connection closed
```

即校验**成功**（`verifyAccessTokenOk=true`）却两行 `last_used` 全为 NULL——正是本条要修的缺陷。探针已在提交前删除，不进入 diff。

### AC2 节流（PAT + OAuth 两路）

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-tokens.service.test.ts
...
✔ (b) a live token verifies and stamps last_used from the injected clock, throttled to one write per window (264.85037ms)
ℹ tests 10   ℹ pass 10   ℹ fail 0
```

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-provider.test.ts
...
✔ (h) verifying an OAuth access token stamps the token and its grant, throttled to one write per window (287.661031ms)
ℹ tests 8   ℹ pass 8   ℹ fail 0
```

case (b) 逐字读数（`readLastUsed()`，PAT 路）：NULL → t0 `2026-01-01T00:00:00.000Z` → t0+59s 仍 `2026-01-01T00:00:00.000Z` → t0+61s `2026-01-01T00:01:01.000Z`。leg (h) 的 OAuth 路读数见下。

### AC3 grant 打点（`oauth-provider.test.ts` leg (h) 逐字读回）

```
(h) before verify: token.last_used=null grant.last_used=null
(h) after verify @t0: token.last_used=2026-01-01T00:00:00.000Z grant.last_used=2026-01-01T00:00:00.000Z (clock 2026-01-01T00:00:00.000Z)
(h) after verify @t0+59s: token.last_used=2026-01-01T00:00:00.000Z grant.last_used=2026-01-01T00:00:00.000Z
(h) after verify @t0+61s: token.last_used=2026-01-01T00:01:01.000Z grant.last_used=2026-01-01T00:01:01.000Z (clock 2026-01-01T00:01:01.000Z)
```

grant 与令牌同刻同值，且同样在 59s 处不重写、61s 处重写。

### AC4 回填

落点（既有迁移判据文件，未新建测试文件）：`server/modules/database/tests/api-keys-drop-migration.test.ts`，新用例 `the last_used backfill fills only NULL rows from the audit log and is idempotent`（该文件已补进 Touches）。

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/api-keys-drop-migration.test.ts
✔ a freshly created database carries no api_keys structure and never reports a drop
✔ opening a database that still has the legacy api_keys table drops it, reports the row count, and keeps every row
✔ the last_used backfill fills only NULL rows from the audit log and is idempotent
ℹ tests 3   ℹ pass 3   ℹ fail 0
```

用例断言：`'2026-01-01 00:00:05' / '2026-01-03 00:00:07' / '2026-01-02 00:00:06'` 三行 audit（乱序播种）→ 令牌 `last_used = '2026-01-03T00:00:07.000Z'`（最大时间戳，归一为 ISO-8601 UTC）；无 audit 行的令牌保持 NULL；已非 null 的令牌保持 `'2026-03-01T00:00:00.000Z'`；PAT（无 grant）令牌 `= '2026-02-01T12:00:00.000Z'`；grantA 取其名下令牌最大值；无可用令牌的 grantB 保持 NULL；已打点的 grantC 保持 `'2026-04-01T00:00:00.000Z'`；**重跑 `runMigrations` 后八个读数字典逐一不变**（幂等）。

### AC5 既有判据已调和

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-store.test.ts
ℹ tests 5   ℹ pass 5   ℹ fail 0
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-settings.routes.test.ts
ℹ tests 5   ℹ pass 5   ℹ fail 0
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-auth.test.ts
✔ (e) a successful request stamps last_used and puts the owner id into the principal
ℹ tests 5   ℹ pass 5   ℹ fail 0
```

`grep -rn "lastUsed\|last_used" --include=*.test.ts server/` 读数：全仓不存在"lastUsed 恒为 null"断言。仅有两处涉及取值，均为容差/结构断言，无需改动——`oauth-settings.routes.test.ts:281` `assert.ok(first.lastUsed === null || typeof first.lastUsed === 'string')`；`access-tokens.routes.test.ts:223` `assert.equal('lastUsed' in item, true)`。`oauth-store.test.ts:181` 是列名清单，`settings.service.test.ts` 两处是 fixture。`mcp-auth.test.ts` (e) 只钉**首次**打点（NULL → 非 null），节流下仍成立，已实跑确认。故 `oauth-store.test.ts` / `oauth-settings.routes.test.ts` 无实际改动，已从 Touches 移除（原提案为"若有断言则调整"，实测无需调整）。

### AC6 取假形态（先提交 `70b9d262`，逐条变异 → 失败 → `git checkout --` 恢复 → 复绿）

(i) **去掉节流**（PAT 每次校验都写）——`server/modules/oauth/access-tokens.service.ts`：

```diff
-      const stamp = lastUsedStamp(row.last_used, now());
-      if (stamp !== null) {
-        accessTokensDb.updateLastUsed(row.id, stamp);
-      }
+      accessTokensDb.updateLastUsed(row.id, now().toISOString());
```

失败行（`access-tokens.service.test.ts`，正是 59s 不重写断言）：

```
✖ (b) a live token verifies and stamps last_used from the injected clock, throttled to one write per window
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: '2026-01-01T00:00:59.000Z',
    expected: '2026-01-01T00:00:00.000Z',
    operator: 'strictEqual',
ℹ tests 10   ℹ pass 9   ℹ fail 1
```

恢复：`git checkout -- server/modules/oauth/access-tokens.service.ts` → 复跑 `ℹ pass 10  ℹ fail 0`。

(ii) **去掉 OAuth 路径打点**（令牌 + grant 的整块打点删除）：

```diff
-      const stampAt = now();
-      const tokenStamp = lastUsedStamp(row.last_used, stampAt);
-      if (tokenStamp !== null) {
-        accessTokensDb.updateLastUsed(row.id, tokenStamp);
-      }
-      if (grant) {
-        const grantStamp = lastUsedStamp(grant.last_used, stampAt);
-        if (grantStamp !== null) {
-          oauthGrantsDb.updateLastUsed(grant.id, grantStamp);
-        }
-      }
```

失败行（`oauth-provider.test.ts` leg (h) 的令牌断言）：

```
✖ (h) verifying an OAuth access token stamps the token and its grant, throttled to one write per window
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: null,
    expected: '2026-01-01T00:00:00.000Z',
    operator: 'strictEqual',
ℹ tests 8   ℹ pass 7   ℹ fail 1
```

恢复：`git checkout -- server/modules/oauth/oauth-provider.service.ts` → 复跑 `ℹ pass 8  ℹ fail 0`。

(iii) **去掉 grant 打点**（保留令牌打点）：

```diff
       if (tokenStamp !== null) {
         accessTokensDb.updateLastUsed(row.id, tokenStamp);
       }
-      if (grant) {
-        const grantStamp = lastUsedStamp(grant.last_used, stampAt);
-        if (grantStamp !== null) {
-          oauthGrantsDb.updateLastUsed(grant.id, grantStamp);
-        }
-      }
```

失败行（令牌断言先通过，随后 grant 断言红——与 (ii) 可区分）：

```
✖ (h) verifying an OAuth access token stamps the token and its grant, throttled to one write per window
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: null,
    expected: '2026-01-01T00:00:00.000Z',
    operator: 'strictEqual',
ℹ tests 8   ℹ pass 7   ℹ fail 1
```

恢复：`git checkout -- server/modules/oauth/oauth-provider.service.ts` → 复跑 `ℹ pass 8  ℹ fail 0`。

(iv) **回填改为无条件覆盖**（`server/modules/database/migrations.ts` 的 access_tokens 语句删去 `WHERE last_used IS NULL AND EXISTS(...)`）：

```diff
                  ORDER BY datetime(mcp_audit_log.at) DESC
                  LIMIT 1
-              )
-        WHERE last_used IS NULL
-          AND EXISTS (SELECT 1 FROM mcp_audit_log WHERE mcp_audit_log.token_id = access_tokens.id)`
+              )`
```

失败行（AC4 用例的"已非 null 不被覆盖"断言）：

```
✖ the last_used backfill fills only NULL rows from the audit log and is idempotent
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: '2026-01-05T00:00:00.000Z',
    expected: '2026-03-01T00:00:00.000Z',
    operator: 'strictEqual',
ℹ tests 3   ℹ pass 2   ℹ fail 1
```

恢复：`git checkout -- server/modules/database/migrations.ts` → 复跑 `ℹ pass 3  ℹ fail 0`。

四轮变异后 `git status --porcelain` 为空。

### AC7 仓库门

```
$ npm run typecheck   → exit 0（tsc -p tsconfig.json && -p server/tsconfig.json && -p scripts/tsconfig.json）
$ npm run lint        → exit 0；grep -c ': error ' = 0（warning 226 条，均在既有前端/测试文件，与本案无关）
```

单处共享 helper 的 grep 读数：

```
$ grep -rn "function lastUsedStamp\|LAST_USED_STAMP_INTERVAL_MS" --include=*.ts server/
server/shared/utils.ts:1478:const LAST_USED_STAMP_INTERVAL_MS = 60 * 1000;
server/shared/utils.ts:1496:export function lastUsedStamp(previousLastUsed: string | null, now: Date): string | null {
$ grep -rn "lastUsedStamp(" --include=*.ts server/
server/shared/utils.ts:1496:export function lastUsedStamp(...)          ← 唯一定义
server/modules/oauth/access-tokens.service.ts:231:  const stamp = lastUsedStamp(row.last_used, now());      ← PAT 消费方
server/modules/oauth/oauth-provider.service.ts:429: const tokenStamp = lastUsedStamp(row.last_used, stampAt);  ← OAuth 消费方
server/modules/oauth/oauth-provider.service.ts:434: const grantStamp = lastUsedStamp(grant.last_used, stampAt); ← grant 消费方
```

全仓只有一处 `60 * 1000` 节流比较（`server/shared/utils.ts:1478`），两模块内的其他 `60 * 1000` 常量均为既有的 authorization-code TTL / 限流窗口 / `MS_PER_DAY`，与本案无关。新增导出 `lastUsedStamp` 带消费方注释（`Consumers: …access-tokens.service.ts… oauth-provider.service.ts…`），`oauthGrantsDb.updateLastUsed`、`accessTokensDb.updateLastUsed` 同样带消费方注释。

`server/**/*.test.ts` 未新增（`git status --porcelain` 只有 10 个 `M`，无 `??`）——仓库的测试文件数 pin 不受影响。各判据均按 `docs/operations/process-isolation-and-memory-caps.md` 单文件运行，无无界 `--test` 扇出。

### AC8 diff 与 Touches

```
$ git diff --stat develop...HEAD
 server/modules/database/index.ts                   |   3 +-
 server/modules/database/migrations.ts              |  76 ++++++++++
 server/modules/database/repositories/access-tokens.ts |   7 +-
 server/modules/database/repositories/oauth-grants.db.ts |  19 ++-
 server/modules/database/tests/api-keys-drop-migration.test.ts | 154 +++++++++++++++++++++
 server/modules/oauth/access-tokens.service.ts      |  16 ++-
 server/modules/oauth/oauth-provider.service.ts     |  29 +++-
 server/modules/oauth/tests/access-tokens.service.test.ts |  21 ++-
 server/modules/oauth/tests/oauth-provider.test.ts  |  76 +++++++++-
 server/shared/utils.ts                             |  40 ++++++
 10 files changed, 427 insertions(+), 14 deletions(-)
```

实际改动文件清单与 `## Touches` 的 10 条逐一相符（外加任务文件自身）。

### DoD（真实服务 + 真实库副本）

**(a) 真实 server 进程**：临时 `DATABASE_PATH`/`HOME`/端口上起真实的 `server/index.ts`（`npx tsx --tsconfig server/tsconfig.json server/index.ts`，`MCP_ENABLED=1 MCP_OAUTH_ENABLED=1 MCP_DCR=open`），走完 DCR → 授权页 → 同意 POST → `/oauth/token`，再用该 OAuth 访问令牌调用 `/mcp`。原文：

```
POST /oauth/register -> 201 {"...","client_id":"3705eaf1c0ca6e1963e88124630a6f7e",...}
GET /oauth/authorize -> 200 text/html; charset=utf-8
POST /oauth/authorize -> 302 location=https://app.example/cb?code=00674ae8...&state=bb6c56c9...
POST /oauth/token -> 200 {"access_token":"cca_f3e66484...","token_type":"Bearer","expires_in":3600,"refresh_token":"ccr_3ef7043e..."}

GET /api/settings/oauth-grants (before /mcp) -> 200
{"grants":[{"id":1,"clientId":"3705eaf1c0ca6e1963e88124630a6f7e","clientName":"dod-probe","redirectHost":"app.example","scopes":["cloudcli:read"],"createdAt":"2026-10-07T08:42:45.202Z","lastUsed":null}]}

POST /mcp tools/list (OAuth access token) -> 200
data: {"result":{"tools":[{"name":"projects_list",...}]}}

GET /api/settings/oauth-grants (after /mcp) -> 200
{"grants":[{"id":1,"clientId":"3705eaf1c0ca6e1963e88124630a6f7e","clientName":"dod-probe","redirectHost":"app.example","scopes":["cloudcli:read"],"createdAt":"2026-10-07T08:42:45.202Z","lastUsed":"2026-10-07T08:42:45.228Z"}]}

GET /api/settings/access-tokens (after /mcp) -> 200
{"tokens":[{"id":2,"tokenPrefix":"ccr_3ef7",...,"lastUsed":null,...},
           {"id":1,"tokenPrefix":"cca_f3e6",...,"lastUsed":"2026-10-07T08:42:45.228Z",...}]}

VERDICT grant.lastUsed="2026-10-07T08:42:45.228Z" token.lastUsed="2026-10-07T08:42:45.228Z"
```

即：调用前该 grant 行 `lastUsed` 为 `null`；用 OAuth 访问令牌调用一次 `/mcp` 后，`GET /api/settings/oauth-grants` 读回该行 `lastUsed` 非 null（`2026-10-07T08:42:45.228Z`，节流窗口内），令牌列表接口读回对应 `cca_` 令牌 `lastUsed` 同为非 null；同一轮的 `ccr_` 刷新令牌（未被使用）仍为 `null`——说明打点跟随真实使用而非发放。探针在提交前删除。

**(b) 真实 `~/.cloudcli/auth.db` 副本**：`cp ~/.cloudcli/auth.db /tmp/dod-backfill-auth.db` 后经生产 `initializeDatabase()`（内含回填迁移）跑一遍，原文：

```
Running migration: Adding denied_scopes column to mcp_audit_log table
Running migration: Backfilled last_used for 15 token/grant row(s)
Database migrations completed successfully
oauth_access tokens: 13
oauth_access tokens seen in mcp_audit_log: 12
oauth_access tokens with non-null last_used after migration: 12
oauth_grants with non-null last_used after migration: 3 / 6
sample rows:
  {"id":1,"kind":"oauth_access","last_used":"2026-10-06T16:58:02.000Z","audit_max":"2026-10-06 16:58:02"}
  {"id":3,"kind":"oauth_access","last_used":"2026-10-06T03:34:44.000Z","audit_max":"2026-10-06 03:34:44"}
  ...
```

13 行 oauth_access 中出现在 `mcp_audit_log` 的 12 行**全部**在迁移后获得非 null `last_used`，且与 audit 最大时间戳逐一相符（`audit_max` 归一为 ISO-8601 UTC）；唯一未出现的 1 行保持 NULL；6 个 grant 中 3 个（名下有已用令牌的）获得非 null 值。

## Touches

- server/shared/utils.ts
- server/modules/oauth/access-tokens.service.ts
- server/modules/oauth/oauth-provider.service.ts
- server/modules/database/repositories/access-tokens.ts
- server/modules/database/repositories/oauth-grants.db.ts
- server/modules/database/index.ts
- server/modules/database/migrations.ts
- server/modules/database/tests/api-keys-drop-migration.test.ts
- server/modules/oauth/tests/access-tokens.service.test.ts
- server/modules/oauth/tests/oauth-provider.test.ts
- tasks/gap-mcp-token-last-used-never-stamped-for-oauth.md

## Notes

- 回填迁移的测试用例放进 `server/modules/database/tests/` 下已有的迁移判据文件（执行者选定后须把该文件补进 Touches，`quay-touches-must-match-actual-write-sites`）；若确无合适的既有文件，则把用例并入上面已列的 oauth 测试文件，不得新建。→ 选定 `server/modules/database/tests/api-keys-drop-migration.test.ts`（该目录唯一的 `*-migration.test.ts` 迁移判据文件，其交接的 `access_tokens` 表正是回填对象），已补进 Touches。
- 共享节流 helper 的落点由执行者按 `$backend-module-standards` 决定（两个消费者都在 oauth 模块内，可放 oauth 模块既有服务文件并导出；若选择别处，先把该文件补进 Touches 再写）。→ 落在 `server/shared/utils.ts`（`server/shared/` 是标准允许的共享工具落点，且避免把节流常量塞进某个服务文件），已补进 Touches。
- `mcp_audit_log` 列名、`token_id` 与 `access_tokens.id` 的对应关系以真实 schema 为准，立案时未核对，是执行者的第一步。→ 实测：`mcp_audit_log(id, at, token_id, client_id, tool, args_digest, outcome, duration_ms, denied_scopes)`；`at` 生产写入为 SQLite `CURRENT_TIMESTAMP` 的 `'YYYY-MM-DD HH:MM:SS'`(UTC)，测试可传 ISO。故取最大值用 `ORDER BY datetime(at) DESC` 而非字典序 `MAX`，落库归一为其余写方一致的 ISO-8601 UTC（混格式会被节流的 `new Date(...)` 按本地时区解读）。
- 节流间隔 60 秒是用户裁定值，不要改成可配置项。→ 硬编码为 `server/shared/utils.ts` 的 `LAST_USED_STAMP_INTERVAL_MS`，非可配置。
