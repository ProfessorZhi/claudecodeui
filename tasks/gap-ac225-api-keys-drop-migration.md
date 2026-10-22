---
id: gap-ac225-api-keys-drop-migration
title: AC-225 迁移删除旧明文 api_keys 表与 idx_api_keys_* 三索引并报告删除行数：access_tokens
  就位、用户数据不动、重复运行与全新库都不出错，判据
  server/modules/database/tests/api-keys-drop-migration.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac224-access-token-service
goal_ac: AC-225
---
## Proposal

AC-225（GOAL-018 退出条件 2、范围「迁移」）要求：迁移删除旧的明文 `api_keys` 表与 `idx_api_keys_*` 三个索引，并在迁移日志里报告删除的行数；`access_tokens` 就位；用户数据不动；同一库重复运行既不抛错也不再输出删除日志；全新库（从不存在 `api_keys`）迁移不抛错、不输出删除日志。

现状（红态基线）：判据文件 `server/modules/database/tests/api-keys-drop-migration.test.ts` 不存在，判据的存在性闸以退出码 1 输出缺失的文件名；`runMigrations`（`server/modules/database/migrations.ts`）里没有任何删除 `api_keys` 的逻辑（只建表，从不删）；`INIT_SCHEMA_SQL`（`server/modules/database/schema.ts` 以 `${API_KEYS_TABLE_SCHEMA_SQL}` 与三行 `idx_api_keys_*` 组合）仍为全新库建 `api_keys` 与三个索引。

关联（非重复）：`gap-ac224-access-token-service`（goal_ac: AC-224）拥有 `access_tokens` 表的创建（`schema.ts` 的 `ACCESS_TOKENS_TABLE_SCHEMA_SQL` 与 `migrations.ts` 里的建表语句），并把「删除 api_keys 表与索引」明确划给本任务。两者是相邻但不同的机制：AC-224 是令牌服务与新表；本任务是删旧明文表、报告行数、幂等。本任务靠 AC-224 落地的 `access_tokens` 满足读数 (b)，且两者都改 `server/modules/database/migrations.ts`（避免并发写同一文件），故以顶层 `depends_on` 随后者。

要交付：

1. 迁移函数 `dropLegacyApiKeysStructures(db)` 加入 `server/modules/database/migrations.ts`，在 `runMigrations` 里被调用（与 `workspace_original_paths` 的 drop 并列，位置不得干扰 sessions 表重建的列顺序约束）：
   - `if (tableExists(db, 'api_keys'))`：先 `SELECT COUNT(*)` 取行数；`console.log` 一行报告删除的行数（格式须含表名与数字，例如 `Running migration: Dropping the legacy api_keys table (2 rows removed)`）；再 `db.exec('DROP TABLE api_keys')`（SQLite 一并删除该表索引）；另以 `db.exec('DROP INDEX IF EXISTS idx_api_keys_key')` 等三条兜底（防表已不在而索引残留）。
   - 表不存在时直接返回：不 `console.log`、不抛错。
   - 不把旧 key 迁成令牌；不动 `users`/`user_credentials` 等任何其它表；不删 `server/modules/database/repositories/api-keys.ts`（属 AC-226）。

2. 让全新库不再携带 `api_keys`：从 `server/modules/database/schema.ts` 的 `INIT_SCHEMA_SQL` 组合里移除 `${API_KEYS_TABLE_SCHEMA_SQL}` 与三行 `idx_api_keys_*` 索引，使全新库与已退役结构（`launch_profiles`）一致、不含遗留表。`API_KEYS_TABLE_SCHEMA_SQL` 常量本身的删除属 AC-226，本任务只把它从组合里摘掉。`access_tokens` 的建表属 AC-224，本任务不动。

3. 判据 `server/modules/database/tests/api-keys-drop-migration.test.ts`（红先行，做法照 `server/modules/database/tests/launch-profiles-drop-migration.test.ts`：`mkdtemp` + 临时 `DATABASE_PATH` + `closeConnection`，`withIsolatedDatabase` 包装）：
   - 旧库：`initializeDatabase()` 建出基础表后，手工 `CREATE TABLE api_keys (…)`（照旧 DDL 逐字：`id/user_id/key_name/api_key/created_at/last_used/is_active` + `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`）、三条 `idx_api_keys_*` 索引，插入 1 行 `users` 与 2 行 `api_keys`。
   - 捕获 `console.log`（`t.mock.method(console, 'log')` 或等价包装），记录 `users` 行与各表行数作为基线；`closeConnection()` 后 `initializeDatabase()` 触发迁移。
   - 读数 (a) `sqlite_master` 无 `api_keys` 表、无三个 `idx_api_keys_*` 索引；(b) 有 `access_tokens` 表；(c) `users` 那一行逐字保留（前后 `SELECT *` 相等）；(d) 捕获日志含报告删除 2 行的那一行（含数字 2）；(e) 再 `closeConnection()` + `initializeDatabase()` 不抛错，捕获日志不再含该删除行；(f) 另起临时库仅 `initializeDatabase()`（从不建 `api_keys`），不抛错、日志无删除行，且无 `api_keys` 与三索引。

4. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) `dropLegacyApiKeysStructures` 不删表（注释 `DROP TABLE`）⇒ (a) 必须红；(ii) 迁移顺手 `DROP TABLE users` ⇒ (c) 必须红；(iii) 第二次运行抛错（去掉 `tableExists` 守卫，表不在时 `throw`）⇒ (e) 必须红；(iv) 删表但不输出行数日志 ⇒ (d) 必须红。

边界：不实现令牌服务（AC-224）；不删 `api-keys.ts` 仓储 / `API_KEYS_TABLE_SCHEMA_SQL` 常量 / `/api/agent` / `createAgentModule`（AC-226）；不实现设置接口（AC-227）；不动前端与 i18n；不迁移旧 key。

判定纪律：判据对真实 better-sqlite3 临时库运行（临时 `DATABASE_PATH` + `runMigrations`），不用内存桩；日志读数来自对 `console.log` 的捕获，不是「我看到了」。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/api-keys-drop-migration.test.ts` 退出 0；用例涵盖 (a)–(f)。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出文件名）。
- [x] AC2 (a) 迁移删表与三索引：迁移后 `sqlite_master` 中无 `api_keys` 表与 `idx_api_keys_key`/`idx_api_keys_user_id`/`idx_api_keys_active`；写下查询与读数。
- [x] AC3 (b) `access_tokens` 就位：迁移后 `sqlite_master` 有 `access_tokens` 表（写查询与读数）。
- [x] AC4 (c) 用户数据不动：旧库 `users` 1 行迁移前后逐字相等；其它表行数不变（写前后读数）。
- [x] AC5 (d) 报告删除行数：捕获的 `console.log` 中有报告删除 2 行的那一行（逐字写下该行）。
- [x] AC6 (e) 重复运行幂等：同一库第二次 `runMigrations`/`initializeDatabase` 不抛错，且捕获日志不再有删除 api_keys 的行。
- [x] AC7 (f) 全新库无删除日志：新建临时库（从不存在 `api_keys`，仅走 `initializeDatabase`），不抛错、日志无删除行，且无 `api_keys` 与三索引。
- [x] AC8 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 不删表 ⇒ AC2 红；(ii) 顺手删 `users` ⇒ AC4 红；(iii) 第二次运行抛错 ⇒ AC6 红；(iv) 删表不报行数 ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC9 仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；判据只在本模块内导入（可经 barrel `@/modules/database/index.js` 取 `runMigrations`，或照参考文件用同模块深导入），无跨模块深导入。写明两条命令退出码与 lint error 计数。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 迁移真的在真实 better-sqlite3 临时库上删除了旧 `api_keys` 表与三个索引，并真的把删除行数写进日志（读数是捕获到的日志行，不是「我看到了」）；`access_tokens` 真的就位；`users` 行逐字未动；同一库第二次运行真的不抛错且不再输出删除日志；全新库真的不抛错、不输出删除日志。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 迁移对真实旧库形态（`api_keys` 表 + 三索引 + 2 行）有效，不用内存桩；不越界实现 AC-224/226/227 或前端；遵守 `$backend-module-standards`（迁移与判据都在 database 模块内）。

## Touches

- server/modules/database/migrations.ts
- server/modules/database/schema.ts
- server/modules/database/tests/api-keys-drop-migration.test.ts (new)
- tasks/gap-ac225-api-keys-drop-migration.md

## 完成记录

### AC1 判据绿 / 红态基线
- 红态基线（改动前该判据文件不存在）：`git cat-file -e develop:server/modules/database/tests/api-keys-drop-migration.test.ts` → 退出码 128，逐字 `fatal: path 'server/modules/database/tests/api-keys-drop-migration.test.ts' exists on disk, but not in 'develop'`。把判据文件临时移开后运行 `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/api-keys-drop-migration.test.ts` → 逐字 `Could not find 'server/modules/database/tests/api-keys-drop-migration.test.ts'`，退出码 1。
- 绿：同命令 `tests 2 / pass 2 / fail 0`，退出码 0。用例 1 覆盖 (f)；用例 2 覆盖 (a)–(e)。

### AC2 (a) 删表与三索引
- 迁移后 `SELECT name FROM sqlite_master WHERE type = 'table'` → 不含 `api_keys`；`SELECT name FROM sqlite_master WHERE type = 'index'` 过滤 `idx_api_keys_key`/`idx_api_keys_user_id`/`idx_api_keys_active` → 空集。判据断言 `!tableNames().includes('api_keys')` 与三索引过滤为空，均通过。

### AC3 (b) access_tokens 就位
- 迁移后 `tableNames()` 含 `access_tokens`（由 `runMigrations` 的 `db.exec(ACCESS_TOKENS_TABLE_SCHEMA_SQL)` 建；`INIT_SCHEMA_SQL` 不建它）。判据断言通过。

### AC4 (c) 用户数据不动
- 旧库 1 行 `users`：迁移前 `SELECT * FROM users ORDER BY id` 取基线，迁移后逐字 `deepEqual` 相等（判据 `assert.deepEqual(userRows(), usersBefore, 'the users row must survive the upgrade verbatim')` 通过）。
- 行数：迁移前 `api_keys = 2`（断言 `legacyRowCount === 2` 通过），其余各表计数（含 `users = 1`、`access_tokens = 0`）；迁移后删除 `api_keys` 后 `rowCounts()` 与排除 api_keys 的 survivingCounts 逐字 `deepEqual` 相等。

### AC5 (d) 报告删除行数
- 捕获的 `console.log`（`t.mock.method(console, 'log')`）逐字含该行：`Running migration: Dropping the legacy api_keys table (2 rows removed)`。判据 `assert.ok(loggedLines(logMock).some((line) => line.includes('Dropping the legacy api_keys table (2 rows removed)')))` 通过。

### AC6 (e) 重复运行幂等
- 同一临时库第二次 `closeConnection()` + `initializeDatabase()` 不抛错；以第二次 open 前的 `logMock.mock.calls.length` 为界切片，第二次新增日志行中不含 `api_keys`；`tableNames()` 仍不含 `api_keys`。判据两条断言均通过。

### AC7 (f) 全新库无删除日志
- 另起临时库（`mkdtemp` 新目录，全程从未手工建 `api_keys`），仅走 `initializeDatabase()`：不抛错；`tableNames()` 不含 `api_keys`；三索引均不在 `indexNames()`；捕获日志中含 `api_keys` 的行数为 0。判据断言通过。

### AC8 取假形态（先提交实现 `2ea2a96b`，再变异；恢复命令 `git -C /data/home/yale/work/claudecodeui-worktrees/gap-ac225-api-keys-drop-migration checkout -- server/modules/database/migrations.ts`）
- **(i) 不删表**：
  ```diff
  -    db.exec('DROP TABLE api_keys');
  +    // MUTATION (i): db.exec('DROP TABLE api_keys');
  ```
  AC2 红，逐字失败行：`AssertionError [ERR_ASSERTION]: the upgrade must drop the api_keys table`。恢复后重跑绿（2/2）。
- **(ii) 顺手删 users**：
  ```diff
  +    db.exec('DROP TABLE users'); // MUTATION (ii)
  ```
  AC4 红，逐字失败行：`{ code: 'SQLITE_ERROR' }`（迁移后读 `users` 时表已被删）。恢复后重跑绿（2/2）。
- **(iii) 去掉 tableExists 守卫、表不在时 throw**：
  ```diff
  -  if (tableExists(db, 'api_keys')) {
  -    const { count } = db.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as {
  -      count: number;
  -    };
  -    console.log(`Running migration: Dropping the legacy api_keys table (${count} rows removed)`);
  -    db.exec('DROP TABLE api_keys');
  +  if (!tableExists(db, 'api_keys')) {
  +    throw new Error('MUTATION (iii): api_keys table is missing');
    }
  ```
  覆盖 (e) 的用例红，逐字失败行：`Error: MUTATION (iii): api_keys table is missing`（`at dropLegacyApiKeysStructures (migrations.ts:858:11)`，经 `withIsolatedDatabase → initializeDatabase → runMigrations`）。恢复后重跑绿（2/2）。
- **(iv) 删表但不报行数**：
  ```diff
  -    console.log(`Running migration: Dropping the legacy api_keys table (${count} rows removed)`);
  +    console.log(`Running migration: Dropping the legacy api_keys table`); // MUTATION (iv): row count not reported
  ```
  AC5 红，逐字失败行：`AssertionError [ERR_ASSERTION]: the migration must log the number of dropped rows`。恢复后重跑绿（2/2）。

### AC9 仓库门
- `npm run typecheck` 退出码 0（`tsc --noEmit` 三个 project 全过）。
- `npm run lint` 退出码 0，`: error ` 计数 = 0（仅 warning）。
- 判据只在本模块内导入：`@/modules/database/connection.js`、`@/modules/database/init-db.js`（照 `launch-profiles-drop-migration.test.ts` 的同模块深导入），无跨模块深导入。

### AC10 改动清单与 Touches 对齐
- `git diff --name-status develop...HEAD`：
  - `M server/modules/database/migrations.ts`
  - `M server/modules/database/schema.ts`
  - `A server/modules/database/tests/api-keys-drop-migration.test.ts`
- 与 `## Touches` 逐条对齐（新增文件 `(new)`）；无 Touches 之外写入。`tasks/gap-ac225-api-keys-drop-migration.md` 由本次 ABI（task_write）写入。

### 边界与纪律
- 未实现令牌服务（AC-224 已落地，本任务仅消费其 `access_tokens` 表）；未删 `server/modules/database/repositories/api-keys.ts` / `API_KEYS_TABLE_SCHEMA_SQL` 常量 / `/api/agent` / `createAgentModule`（AC-226）；未实现设置接口（AC-227）；未动前端与 i18n；未迁移旧 key（明文 key 只计数后连同表一起删除）。
- 判据对真实 better-sqlite3 临时库（临时 `DATABASE_PATH` + `initializeDatabase`/`runMigrations`）运行，不用内存桩；(d) 的读数来自对 `console.log` 的捕获，不是人工观察。
