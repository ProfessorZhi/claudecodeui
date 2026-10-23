---
id: gap-ac258-oauth-store-hash-and-revoke-cascade
title: AC-258 OAuth 表与仓储：oauth_clients / oauth_grants /
  oauth_authorization_codes 三表 + access_tokens 的 OAuth kind 与 grant_id 外键可用 +
  客户端密钥/授权码/OAuth 令牌只存 SHA-256（整库字节无明文）+ 吊销授权/禁用客户端级联其全部令牌 + 迁移幂等；判据
  server/modules/oauth/tests/oauth-store.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-258
---
## Proposal

AC-258（GOAL-021 退出条件 1「存储（AC-258）：三张表、哈希存储、吊销级联、迁移幂等」；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §337–§401「数据表（新增，替换 `api_keys`）」）要求 OAuth 存储层就位：

(a) `oauth_clients`、`oauth_grants`、`oauth_authorization_codes` 三张表按 SPEC 逐字建表；`access_tokens` 增补 OAuth 令牌种类（`kind` ∈ `pat`|`oauth_access`|`oauth_refresh`）与 `grant_id` 外键（`REFERENCES oauth_grants(id) ON DELETE CASCADE`）且可用。
(b) 客户端密钥、授权码、OAuth 令牌在库里**只有 SHA-256 哈希**；明文只在注册/签发时返回一次；扫描整库字节找不到任何明文。
(c) 吊销一个授权（`oauth_grants.revoked_at`）后，它名下的 access 与 refresh 令牌**下一次校验即被拒**，其他授权的令牌不受影响。
(d) 禁用一个客户端（`oauth_clients.disabled_at`）后，它名下**全部**授权的令牌被拒。
(e) 迁移在已有这些表的库上重跑不出错，在没有的库上建表（`CREATE TABLE IF NOT EXISTS` + 受列存在性守卫的 `ALTER TABLE`）。

判据文件 `server/modules/oauth/tests/oauth-store.test.ts` 当前不存在，AC-258 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-store.test.ts`（已实测）。

现状（红态基线）：
- `grep -rn "oauth_clients\|oauth_grants\|oauth_authorization_codes" server --include=*.ts` 为空——三张表、仓储、服务都不存在。
- `server/modules/database/schema.ts:332` 的 `ACCESS_TOKENS_TABLE_SCHEMA_SQL` 只有 PAT 形状（`user_id, token_hash, token_prefix, name, scopes, expires_at, created_at, last_used, revoked_at`），**没有** `kind` / `grant_id` / `resource`；其注释明说「the OAuth client/grant tables arrive in stage 5」。
- `server/modules/oauth/` 已有 `access-tokens.service.ts`（PAT，`ccp_` 前缀）与 `token-info.routes.ts`；`server/modules/database/repositories/access-tokens.ts` 是 `access_tokens` 的唯一仓储（PAT 专用插入）。
- `server/modules/database/migrations.ts:936` 只用 `db.exec(ACCESS_TOKENS_TABLE_SCHEMA_SQL)` 建 PAT 表；无 OAuth 表、无 `access_tokens` 的 OAuth 列增补。

要交付：

1. **表与迁移（`server/modules/database/schema.ts` + `migrations.ts`；遵守 `$backend-module-standards`）**：
   - 在 `schema.ts` 新增三个导出常量，**逐字照 SPEC §340/§351/§378 DDL**（`CREATE TABLE IF NOT EXISTS`）：
     - `OAUTH_CLIENTS_TABLE_SCHEMA_SQL`：`client_id TEXT PRIMARY KEY`、`client_secret_hash TEXT`（公共客户端 NULL）、`client_name TEXT`、`redirect_uris TEXT NOT NULL`、`metadata TEXT NOT NULL`、`created_via TEXT NOT NULL`、`created_at DATETIME DEFAULT CURRENT_TIMESTAMP`、`disabled_at DATETIME`。
     - `OAUTH_GRANTS_TABLE_SCHEMA_SQL`：`id INTEGER PRIMARY KEY AUTOINCREMENT`、`user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`、`client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE`、`scopes TEXT NOT NULL`、`resource TEXT NOT NULL`、`created_at`、`last_used`、`revoked_at`。
     - `OAUTH_AUTHORIZATION_CODES_TABLE_SCHEMA_SQL`：`code_hash TEXT PRIMARY KEY`、`client_id TEXT NOT NULL`、`user_id INTEGER NOT NULL`、`redirect_uri TEXT NOT NULL`、`code_challenge TEXT NOT NULL`、`scopes TEXT NOT NULL`、`resource TEXT NOT NULL`、`expires_at DATETIME NOT NULL`。
   - 扩 `ACCESS_TOKENS_TABLE_SCHEMA_SQL`：加 `kind TEXT NOT NULL DEFAULT 'pat'`、`resource TEXT NOT NULL DEFAULT ''`、`grant_id INTEGER REFERENCES oauth_grants(id) ON DELETE CASCADE`。`DEFAULT 'pat'`/`DEFAULT ''` 是让既有 PAT 插入路径（`access-tokens.service.ts`）**一字不改**仍可编译运行的关键；`grant_id` 可空，PAT 为 NULL。
   - 在 `runMigrations`（`migrations.ts`）里：**先** `db.exec(OAUTH_CLIENTS_TABLE_SCHEMA_SQL)`、`db.exec(OAUTH_GRANTS_TABLE_SCHEMA_SQL)`（`access_tokens` 的 `grant_id` 外键指向 grants，故 grants 必须先建），再跑既有 `db.exec(ACCESS_TOKENS_TABLE_SCHEMA_SQL)`，**然后** `addAccessTokenOAuthColumns(db)`：用 `PRAGMA table_info(access_tokens)` 守卫，缺 `kind` 就 `ALTER TABLE access_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'pat'`，缺 `resource` 同理 `DEFAULT ''`，缺 `grant_id` 就 `ADD COLUMN grant_id INTEGER REFERENCES oauth_grants(id) ON DELETE CASCADE`（列存在性守卫使重跑是 no-op；grants 已先建，FK 目标存在），最后 `db.exec(OAUTH_AUTHORIZATION_CODES_TABLE_SCHEMA_SQL)`。加 `CREATE INDEX IF NOT EXISTS idx_oauth_grants_client ON oauth_grants(client_id)`、`idx_oauth_grants_user ON oauth_grants(user_id)`、`idx_access_tokens_grant ON access_tokens(grant_id)`（级联按 `grant_id` 扫，无索引会全表扫）。幂等由三条 `IF NOT EXISTS` + 三处列守卫共同保证：已有表不重建、已有列不重 ALTER、数据与行数不动。
2. **仓储（新文件 `server/modules/database/repositories/oauth-clients.db.ts`、`oauth-grants.db.ts`、`oauth-authorization-codes.db.ts`，形制照 `access-tokens.ts`；扩 `server/modules/database/repositories/access-tokens.ts`；全部经 `server/modules/database/index.ts` barrel 导出、带消费方注释）**：
   - `oauthClientsDb.insert({ clientId, clientSecretHash, clientName, redirectUris, metadata, createdVia, createdAt })`；`findById(clientId)`；`disable(clientId, disabledAt): boolean`（`UPDATE ... SET disabled_at = ? WHERE client_id = ? AND disabled_at IS NULL`）；`allRows()`（判据读回整行做哈希扫描）。
   - `oauthGrantsDb.insert({ userId, clientId, scopes, resource, createdAt }): number`；`findById(id)`；`revoke(id, revokedAt): boolean`；`listIdsByClient(clientId): number[]`。
   - `oauthAuthorizationCodesDb.insert({ codeHash, clientId, userId, redirectUri, codeChallenge, scopes, resource, expiresAt })`；`findByHash(codeHash)`；`deleteByHash(codeHash)`（一次性消费的删除原语；「一次性/60 秒」语义属 AC-259，本任务只提供存储原语）。
   - `access-tokens.ts`：`AccessTokenRow` / `InsertAccessTokenInput` 增可选 `kind`（默认 `'pat'`）、`resource`、`grantId`；`insert` 写这三列；新增 `revokeByGrantId(grantId, revokedAt): number`（`UPDATE access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`，返回改动行数）——(c) 的级联动作落在这里。既有 PAT 调用不改一字（新字段可选、默认值照旧）。
3. **OAuth 存储服务（新文件 `server/modules/oauth/oauth-store.service.ts`；经 `server/modules/oauth/index.ts` barrel 导出；遵守 `$backend-module-standards`）**：
   - 私有 `sha256Hex(s) = crypto.createHash('sha256').update(s).digest('hex')`；`randomSecret() = crypto.randomBytes(32).toString('hex')`。
   - `createOAuthStore(options?: { now?: () => Date })`（`now` 默认 `() => new Date()`，判据可注入）返回：
     - `registerClient({ clientName, redirectUris, metadata, createdVia, publicClient }) → { clientId, clientSecret: string | null }`——生成 `client_id` 与（机密客户端才有的）`client_secret` 明文，**只**把 `sha256Hex(secret)` 落库并返回明文一次；`publicClient` 为真时 `client_secret_hash` 为 NULL。
     - `createGrant({ userId, clientId, scopes, resource }) → { grantId }`。
     - `issueAuthorizationCode({ clientId, userId, redirectUri, codeChallenge, scopes, resource }) → { code }`——生成明文 code，只落 `sha256Hex(code)`。
     - `issueOAuthToken({ grantId, kind: 'oauth_access' | 'oauth_refresh', scopes, resource, expiresAt }) → { token, tokenId }`——生成 `cca_`/`ccr_` 前缀明文，只落 `sha256Hex(token)` + `token_prefix` + `kind` + `grant_id` + `resource`。
     - `verifyOAuthToken(token, kind?) → { ok: true, tokenId, grantId, scopes, expiresAt } | { ok: false, reason }`——按 hash 查 `access_tokens`，`revoked_at` 非空即 `revoked`、过期即 `expired`（(c)(d) 的「下一次校验即被拒」靠每次重读 `revoked_at`，不缓存）。
     - `revokeGrant(grantId) → { grantRevoked: boolean; tokensRevoked: number }`——**事务内**先 `oauthGrantsDb.revoke` 再 `accessTokensDb.revokeByGrantId`（(c) 的级联：授权名下 access 与 refresh 一并落 `revoked_at`；其他 grant 的令牌零改动）。
     - `disableClient(clientId) → { clientDisabled: boolean; tokensRevoked: number }`——**事务内** `oauthClientsDb.disable`，再对 `oauthGrantsDb.listIdsByClient(clientId)` 逐个 `revoke` + `revokeByGrantId`（(d) 的级联：该客户端全部授权的令牌被拒）。
   - 越界不做：PKCE 校验、授权码一次性/60 秒判定、refresh 轮换与复用检测、redirect_uri 与受众校验、端点与授权页——全属 AC-259/260+；本任务只落「表 + 仓储 + 哈希写入 + 级联吊销 + 校验读 `revoked_at`」这一存储层。
4. **判据文件 `server/modules/oauth/tests/oauth-store.test.ts`（红先行；真实 better-sqlite3 临时库，形制照 `server/modules/database/tests/api-keys-drop-migration.test.ts`）**：`mkdtemp` 建临时目录、`closeConnection()`、`process.env.DATABASE_PATH` 指向 `oauth.db`、`initializeDatabase()`、插 owner 用户行（`oauth_grants.user_id` 外键）。读数各自独立成断言并逐字写出原始值：
   - (a) **三表就位 + OAuth 列可用**：`sqlite_master` 表名含 `oauth_clients`/`oauth_grants`/`oauth_authorization_codes`；`PRAGMA table_info(...)` 列名逐字等于 SPEC DDL；`PRAGMA table_info(access_tokens)` 含 `kind`/`grant_id`/`resource`；`PRAGMA foreign_key_list(access_tokens)` 含指向 `oauth_grants(id)` 的 `grant_id`；经 `createOAuthStore` 建 client→grant→issue 一个 `oauth_access` 令牌，读回该行断言 `kind === 'oauth_access'` 且 `grant_id` 等于所建 grant。逐字写出表名与列名读数。
   - (b) **只存哈希、整库无明文**：注册一个机密客户端（记 `secret`）、issue 一个授权码（记 `code`）、issue 一个 access 与一个 refresh 令牌（记 `accessToken`/`refreshToken`）；`closeConnection()` 后读 `oauth.db` 及其 `-wal`/`-shm` 兄弟文件的原始字节，断言四条明文字符串**均不出现**；**正例对照**：四条明文各自的 `sha256` 十六进制**出现在**库中（经 `findById`/`findByHash` 读回哈希列逐字比对），且明文与库中哈希不相等。逐字写出四条明文的扫描结果与四条哈希读数。
   - (c) **吊销授权级联、按授权隔离**：建两个 grant `g1`/`g2`，各 issue 一个 access + 一个 refresh；`revokeGrant(g1)` 返回 `{ grantRevoked: true, tokensRevoked: 2 }`；`verifyOAuthToken(t1access)` 与 `verifyOAuthToken(t1refresh)` 均 `{ ok: false, reason: 'revoked' }`；**`verifyOAuthToken(t2access)` 仍 `ok: true`**（其他授权不受影响，正例对照防「全吊销」也通过）；读回 `access_tokens` 断言 g1 两行 `revoked_at` 非空、g2 行 `revoked_at` 仍为 NULL。逐字写出两次校验结果与三行 `revoked_at`。
   - (d) **禁用客户端级联**：客户端 `c1` 有两条授权、各一个令牌；客户端 `c2` 有令牌；`disableClient(c1)` 后 c1 全部授权的令牌 `verifyOAuthToken` 均 `{ ok: false, reason: 'revoked' }`、c2 的令牌仍 `ok: true`；读回 `oauth_clients.disabled_at` 与两客户端名下令牌行。逐字写出状态。
   - (e) **迁移幂等**：记录当前表名集合与各表行数；再次 `runMigrations(getConnection())`（或 `closeConnection()` 后重新 `initializeDatabase()`）**不抛错**，表名集合与 `PRAGMA table_info` 列名**逐字不变**、各表行数不变；并在一个**没有**这些表的新临时库上 `initializeDatabase()` 建表成功（(e) 的另一半）。逐字写出幂等前后表名/行数与新库建表结果。
5. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 授权码明文入库（`issueAuthorizationCode` 直接把明文当 `code_hash` 落库、跳过 `sha256Hex`）⇒ (b) 必须红；
   (ii) 吊销只标记授权、不级联令牌（`revokeGrant` 去掉 `accessTokensDb.revokeByGrantId`，只 `oauthGrantsDb.revoke`）⇒ (c) 必须红；
   (iii) 重跑迁移抛错（去掉某一处列存在性守卫、或把某条 DDL 的 `IF NOT EXISTS` 拿掉，使第二次 `runMigrations` 抛错）⇒ (e) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "^goal_ac: AC-258" tasks/` 为空，`grep -rln "oauth_clients\|oauth_grants\|oauth_authorization_codes\|oauth-store\|grant_id" tasks/` 为空，本仓库无任何任务带 AC-258 或触碰同一机制。GOAL-020 的 AC-239/240/241/244（依赖声明 / 传输 / 令牌认证 / 审计）与 GOAL-021 其余 AC 是不同机制与不同判据文件：本任务只落 OAuth 存储层（三表 + 仓储 + 哈希写入 + 级联吊销 + 迁移幂等），不实现端点、授权页、PKCE/授权码一次性/refresh 轮换（AC-259）、发现元数据（AC-262/263）、客户端注册策略（AC-264）、设置接口与文案（AC-265–267）、端到端与冒烟（AC-268–270）。AC-258 判据自足：临时 `DATABASE_PATH` + `runMigrations` + `oauth-store.test.ts`，不取用 GOAL-020 的任何代码（`access_tokens` 表在 GOAL-018 阶段 0 已落地），故本任务无 `depends_on`。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-258 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/oauth/tests/oauth-store.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/oauth/tests/oauth-store.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-store.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) 三表就位、列名逐字等于 SPEC DDL；`access_tokens` 含 `kind`/`grant_id`/`resource`，`PRAGMA foreign_key_list(access_tokens)` 有指向 `oauth_grants(id)` 的 `grant_id`；经 store 建 grant→issue `oauth_access` 令牌读回 `kind`/`grant_id` 正确；逐字写出表名与列名读数。
- [x] AC4 (b) 客户端密钥/授权码/access/refresh 四条明文在 `oauth.db`(+`-wal`/`-shm`) 原始字节中均不出现；正例对照四条 SHA-256 十六进制在库中读回且与明文不等；逐字写出扫描结果与哈希读数。
- [x] AC5 (c) `revokeGrant(g1)` 返回 `tokensRevoked: 2`，其 access 与 refresh 下一次校验均 `reason:'revoked'`，`g2` 令牌仍 `ok:true`；读回 g1 两行 `revoked_at` 非空、g2 行 NULL；逐字写出。
- [x] AC6 (d) `disableClient(c1)` 后 c1 全部授权令牌校验被拒、c2 令牌仍 `ok:true`；逐字写出 `disabled_at` 与两客户端令牌读数。
- [x] AC7 (e) 已有表且有数据的库上再次 `runMigrations`/`initializeDatabase` 不抛错、表名与列名逐字不变、行数不变；无表新库 `initializeDatabase` 建表成功；逐字写出。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 授权码明文 ⇒ AC4 红；(ii) 只标授权不级联 ⇒ AC5 红；(iii) 重跑迁移抛错 ⇒ AC7 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；既有 `server/modules/oauth/tests/access-tokens.service.test.ts`、`server/modules/oauth/tests/token-info.routes.test.ts`、`server/modules/database/tests/api-keys-drop-migration.test.ts` 不改一字仍逐字通过。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 三张表与 `access_tokens` 的 OAuth 列**真的**在真库就位且可用：经 `createOAuthStore` 建 client→grant→issue 真令牌，从真库 `PRAGMA table_info`/`foreign_key_list` 与读回行验证，不是「文件存在」或「函数被调用」就算数。
- 明文**真的**不落库：客户端密钥、授权码、access、refresh 四条明文对真库文件**原始字节**扫描均不出现，且各自 SHA-256 哈希真在库中（正例对照证明扫描器不是恒真）。
- 吊销/禁用**真的**级联：`revokeGrant(g1)` 后其 access+refresh 下一次校验真被拒、g2 真不受影响（读回 `revoked_at` 佐证）；`disableClient(c1)` 后 c1 全部授权令牌真被拒、c2 真不受影响——不是「只标了 grant/client」就算数。
- 迁移**真的**幂等：已有表且有数据的库上重跑不抛错、列与行数不变；无表新库真建表。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、DDL/仓储落 database 模块、服务落 oauth 模块、导出带消费方注释、不导出无消费者符号、≥2 处使用的工具进 `server/shared/utils.ts`）与 AGENTS.md；不引入新依赖（只用既有 better-sqlite3 与 node 内置）；不越界实现 AC-259–AC-269。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/oauth-clients.db.ts (new)
- server/modules/database/repositories/oauth-grants.db.ts (new)
- server/modules/database/repositories/oauth-authorization-codes.db.ts (new)
- server/modules/database/repositories/access-tokens.ts
- server/modules/database/index.ts
- server/modules/oauth/oauth-store.service.ts (new)
- server/modules/oauth/index.ts
- server/modules/oauth/tests/oauth-store.test.ts (new)（判据）
- tasks/gap-ac258-oauth-store-hash-and-revoke-cascade.md

## Notes

- `access_tokens` 已是既有表：新库由更新后的 `ACCESS_TOKENS_TABLE_SCHEMA_SQL` 直接建全列；老库由 `addAccessTokenOAuthColumns` 的列守卫 `ALTER` 增补。`kind`/`resource` 的 `DEFAULT` 是让既有 PAT 插入路径（`access-tokens.service.ts`）**零改动**继续工作的关键——本任务**不改** `server/modules/oauth/access-tokens.service.ts`（AC-241 ready、AC-244 todo 正在同一文件上工作）。
- 若扩 `access-tokens.ts` 仓储反而使某个整体 `vi.mock('@/modules/database/index.js')` 的兄弟测试变红（内存 `adding-an-export-reds-sibling-wholesale-vimocks`），按同款修法把新导出补进那个 mock 工厂并把该测试文件加进 `## Touches`；或改为新增 `oauth-tokens.db.ts` 承载 OAuth 写入（二者择一，以实际写点为准确认 Touches，内存 `quay-touches-must-match-actual-write-sites`）。
- 新增测试文件可能被边界 lint 拦截（内存 `quay-boundaries-lint-blocks-new-test-files`）；判据文件已列入 `## Touches`。
- (b) 的整库扫描须在 `closeConnection()` 后读 `oauth.db` 及其 `-wal`/`-shm` 兄弟（避免 WAL 未落盘造成假阴性），并对四条明文各配一条「哈希在库中」正例对照（对 `findById`/`findByHash` 读回的哈希列逐字比对），防「扫描器恒不命中」也通过。
- 服务用 `now` 注入时钟（默认 `() => new Date()`）；`revokeGrant`/`disableClient` 的两次写落在同一 `db.transaction(...)` 内，使「标记 + 级联」原子。
- 判据是本任务的机械读数，文件即 AC-258 `criterion:` 所点名的那个；不新建第二个判据文件。