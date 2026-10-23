---
id: gap-ac224-access-token-service
title: AC-224 访问令牌只存哈希：令牌服务（签发/校验/吊销/过期/scope）落地，判据
  server/modules/oauth/tests/access-tokens.service.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-224
---
## Proposal

AC-224（GOAL-018 退出条件 1；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「认证与令牌」节）要求个人访问令牌只存哈希：明文 `ccp_` 加 64 位 hex 只在签发时出现一次，库里只有 SHA-256 哈希与 8 位前缀；有效令牌被接受；过期、吊销、改写、前缀错误、scope 越权五种反例各自被拒且理由互异；有效期只接受 7/30/90 天；吊销即时生效。

现状（红态基线）：判据文件 `server/modules/oauth/tests/access-tokens.service.test.ts` 不存在，判据的存在性闸以退出码 1 输出缺失的文件名；`server/modules/oauth/` 目录不存在；`access_tokens` 表不存在。

要交付：

1. 表与迁移：在 `server/modules/database/schema.ts` 增加 `ACCESS_TOKENS_TABLE_SCHEMA_SQL`（列：`id` INTEGER PRIMARY KEY AUTOINCREMENT、`user_id` INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE、`token_hash` TEXT NOT NULL UNIQUE、`token_prefix` TEXT NOT NULL、`name` TEXT、`scopes` TEXT NOT NULL、`expires_at` DATETIME NOT NULL、`created_at` DATETIME、`last_used` DATETIME、`revoked_at` DATETIME），在 `server/modules/database/migrations.ts` 的 `runMigrations` 内 `db.exec` 建表（`CREATE TABLE IF NOT EXISTS`）。本任务只建 `access_tokens`：OAuth 相关表属 SPEC 阶段 5；删除 `api_keys` 表与索引属 AC-225，不在本任务。仓储放 `server/modules/database/repositories/access-tokens.ts`（SQL 全在此处，用 `getConnection()`），经 `server/modules/database/index.ts` barrel 导出 `accessTokensDb`（消费方：oauth 服务）。

2. 令牌服务 `server/modules/oauth/access-tokens.service.ts`，经 `server/modules/oauth/index.ts` barrel 导出（消费方：本模块判据，以及 AC-227 的设置路由）：
   - 签发：明文 = `ccp_` + 64 位 hex（32 字节随机数 `crypto.randomBytes(32).toString('hex')`）；库里写 `sha256(明文)`（64 位 hex）与 8 位前缀（明文前 8 字符）；明文只在返回里出现一次。有效期只接受 7/30/90（天），缺省 30；永久/无限期、0、负数、365 一律拒绝（返回可判别错误，不写库）。
   - 校验：以明文算 SHA-256 查库；命中且未过期、未吊销、请求 scope ⊆ 令牌 scope ⇒ 返回 `{ userId, scopes }`，并更新该行 `last_used`。
   - 拒绝理由五种，两两互异：过期、已吊销、哈希未命中（改写明文末位一个字符落此）、前缀不是 `ccp_`、请求 scope 越权。以带判别字段的结果返回（例如 `{ ok: false, reason }`），五条各一个取值。
   - 吊销：写 `revoked_at`；校验每次查库、无缓存 ⇒ 吊销后下一次校验即被拒，无需重启。
   - 时钟可注入：服务以工厂 `createAccessTokensService({ now })`（`now: () => Date`）构造；所有时间列（`created_at`、`expires_at`、`last_used`、`revoked_at`）与过期判定都只用注入时钟，不依赖 SQLite 的 `CURRENT_TIMESTAMP`，判据用可变时钟拨到过期之后。

3. 判据 `server/modules/oauth/tests/access-tokens.service.test.ts`（红先行）：临时 `DATABASE_PATH` + `runMigrations`（或 `initializeDatabase`）建库，注入时钟。五条读数：(a) 明文只出现一次——签发返回 `^ccp_[0-9a-f]{64}$` 的明文；`access_tokens` 里只有 SHA-256 哈希与 8 位前缀；逐列扫描该表（`SELECT *` 全部值转字符串）并对数据库文件字节（含 `-wal`/`-shm` 若存在）扫描，明文出现 0 次；(b) 正例——有效令牌校验通过，返回所属 `userId` 与 scope，`last_used` 被更新；(c) 五种反例各自被拒且 `reason` 互不相同；(d) 7/30/90 接受（含缺省 30），永久/0/负数/365 被拒；(e) 同一令牌吊销前通过、吊销后下一次校验即被拒，同一进程内不重启。

4. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 把明文写进表（额外写一列，或把 `token_hash` 直接写成明文）⇒ (a) 必须红；(ii) 校验时跳过过期检查 ⇒ (c) 的过期一条必须红；(iii) 校验恒返回有效 ⇒ (c) 五条全部必须红。

边界：不实现 `/api/settings/access-tokens`（AC-227）；不删 `api_keys` 表/索引/仓储（AC-225）；不退役 `/api/agent`（AC-226）；不建 OAuth 表、不做授权码/refresh（阶段 5）；不动前端与 i18n。

判定纪律：判据对真实 better-sqlite3 临时库运行，不用内存桩；拒绝要作为可判别的返回值，不许被吞成异常。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-tokens.service.test.ts` 退出 0；用例/子测试涵盖 (a)–(e)。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出文件名）。
- [x] AC2 (a) 明文只出现一次、库中 0 次：签发返回的明文匹配 `^ccp_[0-9a-f]{64}$`；`access_tokens` 行的 `token_hash` 是 64 位 hex 的 SHA-256、`token_prefix` 是明文前 8 字符；对该表每一列（`SELECT *` 全部值转字符串）与数据库文件字节（含 WAL/SHM 若存在）扫描明文，出现 0 次。写下所用扫描范围（列清单/文件清单）与计数。
- [x] AC3 (b) 正例：有效令牌校验通过，返回所属 `userId` 与 scope 集合，且该令牌行 `last_used` 从 NULL 变为注入时钟的当前时间（写明前后读数）。
- [x] AC4 (c) 五种反例各自被拒且理由互异：过期（时钟拨到 `expires_at` 之后）、已吊销、改写明文末位一个字符、前缀不以 `ccp_` 开头、请求 scope 不在令牌 scope 内——五者返回的 `reason` 两两不相同（写下五个取值）。
- [x] AC5 (d) 有效期白名单：7、30、90 接受；不传或缺省为 30；永久/无限期、0、负数、365 天一律被拒且不写库（写下每条的返回与表行数未增）。
- [x] AC6 (e) 吊销即时生效：同一令牌吊销前校验通过，`revoke` 后不重启、下一次校验即被拒（reason 为吊销）；写明两次校验在同一进程内完成。
- [x] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 明文写进表 ⇒ AC2 红；(ii) 跳过过期检查 ⇒ AC4 的过期一条红；(iii) 校验恒有效 ⇒ AC4 全部红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 仓库门与该服务不越界：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；判据跨模块只经 barrel 导入（`@/modules/database/index.js`），同模块经 `@/modules/oauth/index.js`，无深导入（`boundaries/dependencies` 不报错）。写明两条命令退出码与 lint error 计数。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 令牌服务真的被签发/校验/吊销/过期操作过：判据对真实 better-sqlite3 临时库（临时 `DATABASE_PATH` + `runMigrations` 建表）运行，不是内存桩。
- 明文在库里与数据库文件里都 0 次出现，读数是扫描得出的计数；有效令牌返回所属用户与 scope 且 `last_used` 真的被更新；五种反例的理由互不相同；有效期白名单与吊销即时生效各自实测。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 服务以可注入时钟构造，过期判定无墙钟依赖；遵守 `$backend-module-standards`（TypeScript、模块 barrel、仓储在 database 模块、路由未涉及）；不越界实现 AC-225/226/227 或前端。

## Touches

- server/modules/oauth/index.ts (new)
- server/modules/oauth/access-tokens.service.ts (new)
- server/modules/oauth/tests/access-tokens.service.test.ts (new)
- server/modules/database/repositories/access-tokens.ts (new)
- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/index.ts
- tasks/gap-ac224-access-token-service.md

## 完成记录
### AC1 判据绿 / 红态基线
- 红态基线（改动前该判据文件不存在；`git ls-tree -r develop -- server/modules/oauth/` 为空）：把实现整体暂存后工作树回到 develop 态，运行
  `npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-tokens.service.test.ts`
  → `Could not find 'server/modules/oauth/tests/access-tokens.service.test.ts'`，退出码 1。
- 绿：同命令 `tests 10 / pass 10 / fail 0`，退出码 0；(a)–(e) 均有用例，(c) 的五个反例各为独立子测试。

### AC2 (a) 明文只出现一次、库中 0 次
- 明文匹配 `^ccp_[0-9a-f]{64}$`；`token_hash` = 明文 SHA-256（64 位 hex），`token_prefix` = 明文前 8 字符。
- 列扫描：`SELECT *` 1 行，逐列（`id, user_id, token_hash, token_prefix, name, scopes, expires_at, created_at, last_used, revoked_at`）转字符串后扫描明文，命中 0 次。
- 文件扫描：`<db>`、`<db>-wal`、`<db>-shm`（存在者）逐字节扫描明文，命中 0 次。

### AC3 (b) 正例
- 有效令牌校验返回 `{ ok: true, userId: 1, scopes: ['cloudcli:read','cloudcli:session:send'] }`。
- `last_used`：校验前 = `null`，校验后 = 注入时钟当前时间的 ISO 串。

### AC4 (c) 五反例理由互异
- 五个取值：`expired`、`revoked`、`not_found`（改写明文末位一字符）、`invalid_prefix`、`insufficient_scope`；Set 大小 5。

### AC5 (d) 有效期白名单
- 7 / 30 / 90 接受（`expiresAt` = 起点 + N 天）；缺省 = 30。
- `null`（永久）、`Infinity`（无限期）、`0`、`-1`、`365` 均返回 `{ ok: false, reason: 'invalid_expiry' }`，且表行数不变（写前写后均 4）。

### AC6 (e) 吊销即时生效
- 同一进程内：verify 通过 → `revokeToken(id)` → 下一次 verify 即返回 `{ ok: false, reason: 'revoked' }`，不重启。

### AC7 取假形态（先提交实现 `ccb96e74`，再变异；恢复命令 `git -C <worktree> checkout -- server/modules/oauth/access-tokens.service.ts`）
- **(i) 明文写进表**：`tokenHash: hashToken(token)` → `tokenHash: token`

  ```diff
  -        tokenHash: hashToken(token),
  +        tokenHash: token, // FALSIFY(i): plaintext written to the store
  ```

  AC2 (a) 红，逐字失败行 `access-tokens.service.test.ts:114:12`：
  `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: actual: 'ccp_<64hex>' expected: '<sha256-hex>'`。恢复后重跑绿。
- **(ii) 跳过过期检查**：删掉 `if (now().getTime() >= new Date(row.expires_at).getTime()) return { ok:false, reason:'expired' }`

  ```diff
  -      if (now().getTime() >= new Date(row.expires_at).getTime()) {
  -        return { ok: false, reason: 'expired' };
  -      }
  -
  +      // FALSIFY(ii): expiry check removed
  ```

  仅 (c) 的 `expired` 子测试红，逐字失败行 `access-tokens.service.test.ts:187:14`：
  `actual: { ok: true, userId: 1, scopes: [ 'cloudcli:read' ] } / expected: { ok: false, reason: 'expired' }`；其余四条子测试绿。恢复后重跑绿。
- **(iii) 校验恒有效**：`verifyToken` 首行插入常量成功返回

  ```diff
  +      // FALSIFY(iii): verification always succeeds
  +      return { ok: true, userId: 1, scopes: ['cloudcli:read'] };
  ```

  (c) 五条子测试全部红：`expired`、`revoked`、`rewritten plaintext is not found`、`foreign prefix`、`insufficient scope`（`pass 2 / fail 8`）。恢复后重跑绿（10/10）。

### AC8 仓库门与该服务不越界
- `npm run typecheck` 退出码 0。
- `npm run lint` 退出码 0，`: error ` 计数 = 0（仅 warning）。
- 跨模块只经 barrel：判据导入 `@/modules/database/index.js` 与 `@/modules/oauth/index.js`；服务导入 `@/modules/database/index.js`；`boundaries/dependencies` 无报错（改动文件无 lint 输出）。

### AC9 改动清单与 Touches 对齐
- `git diff --name-status develop...HEAD`：
  - `M server/modules/database/index.ts`
  - `M server/modules/database/migrations.ts`
  - `M server/modules/database/schema.ts`
  - `A server/modules/database/repositories/access-tokens.ts`
  - `A server/modules/oauth/index.ts`
  - `A server/modules/oauth/access-tokens.service.ts`
  - `A server/modules/oauth/tests/access-tokens.service.test.ts`
- 与 `## Touches` 逐条对齐，无 Touches 之外写入（`tasks/gap-ac224-access-token-service.md` 由本次 ABI 写入）。
