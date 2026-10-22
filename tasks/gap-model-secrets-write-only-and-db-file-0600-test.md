---
id: gap-model-secrets-write-only-and-db-file-0600-test
title: model-library：secret 行值只写（列表/单个/错误响应只回 isSet）、PATCH 缺省保留/空串清除、auth.db
  打开时收紧 0600（AC-022）
status: superseded
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-022
---
## Proposal

GOAL-001 的 AC-022（取代 AC-003）依据 ADR-002 决策 2：secret 行的值允许存于 `provider_models.config_json`，但只写。目前 `provider_models` 没有 `config_json` 列，模型列表接口也没有 `isSet`，`auth.db` 打开后权限为 0644，`tasks/` 中没有任何任务以 `goal_ac: AC-022` 推进该判据，这是结构性缺口（判据测试 `model-secret-write-only.test.ts` 与 `db-file-permissions.test.ts` 均不存在，必红）。AC-003 的“密钥不入库”前提已被 ADR-002 明确推翻，不得悄悄改动其测试。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-secret-never-persisted-test（AC-003，已被 AC-022 取代）针对旧 `launch_profiles` 表的“值绝不落库”，本任务是新模型库的“值可落库但读接口永不回传 + 文件权限收紧”。

方案（最小切片）：
1. `server/modules/database/schema.ts` 与 `migrations.ts`：给 `provider_models` 增加可空 `config_json` 列（幂等迁移，NULL 表示无覆盖）；`server/modules/database/repositories/provider-models.ts` 读写该列，经 `server/modules/database/index.ts` 导出。
2. `config_json` 的 env 行支持类型 value/secret/envref/unset。读路径（模型列表、单个模型、校验失败/404 等错误响应）对 secret 行统一脱敏：不含 value，只回 `isSet: true|false`；错误响应不得回显请求体中的 secret 值。写路径 PATCH：secret 行不带 `value` 表示保持原值，带空串表示清除，带非空值表示覆盖。改动集中在 provider-models 的 service 与 `server/modules/providers/provider.routes.ts`。
3. `server/modules/database/connection.ts`：打开数据库后对 auth.db 文件（存在时也含 -wal/-shm）执行 `chmod 0600`，已是 0600 时幂等，失败不阻断启动但记录日志。
4. 新增 `server/modules/providers/tests/model-secret-write-only.test.ts`：隔离临时库，用独特哨兵值创建含 secret 行的模型；断言列表、单个、以及构造的校验失败与 404 响应的完整序列化文本中检索不到哨兵，且 secret 行 `isSet===true`；PATCH 不带 value 后库内值不变，带空串后 `isSet===false`。取假用例：直接把哨兵塞进响应对象，同一检索函数命中数大于 0。
5. 新增 `server/modules/database/tests/db-file-permissions.test.ts`：先以 0644 预建文件，经真实的打开路径后 `fs.statSync(path).mode & 0o777 === 0o600`；取假用例：不经打开路径的 0644 文件断言为 0600 会失败。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-secret-write-only.test.ts server/modules/database/tests/db-file-permissions.test.ts` 退出码 0（AC-022 的判据命令）。
- [x] 测试对模型列表、单个模型、校验失败与 404 响应的序列化文本用 `assert.strictEqual(hits, 0)` 断言检索不到哨兵 secret 值，且 secret 行返回 `isSet: true`。
- [x] PATCH 语义测试：secret 行不带 value 后再读库内值不变；带空串后 `isSet` 为 false；取假用例（哨兵被塞入响应）命中数大于 0 证明检索会变红。
- [x] 权限测试：预建 0644 的 auth.db 经真实打开路径后 `mode & 0o777` 等于 `0o600`；`grep -n "config_json" server/modules/database/schema.ts` 有命中；`npm run typecheck` 与 `npm test` 退出码 0。

## DoD

真实落地判据：secret 值经真实的 provider-models service/route 写入真实的（临时）sqlite 库，读接口与错误响应经真实路由序列化后检索，而非只测 repository；权限断言经真实的 connection 打开路径，而非直接调用 chmod。AC-022 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-022` 能独立核验该任务。AC-003 的既有测试不被悄悄修改（由 AC-022 取代）。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/connection.ts
- server/modules/database/repositories/provider-models.ts
- server/modules/database/index.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/tests/model-secret-write-only.test.ts
- server/modules/database/tests/db-file-permissions.test.ts
- tasks/gap-model-secrets-write-only-and-db-file-0600-test.md


2026-09-20 撤回：与 gap-model-library-secret-write-only 重复（同绑 AC-022）。driver 的 outer 循环在已有任务存在时仍补建，去重未生效。保留后者，因其额外处理了旧的 secret-never-persisted 测试（与 ADR-002 冲突的判据）。本任务 worktree 与分支保留未删，其实现（含 connection.ts 的 0600 收紧）可供后者对照。