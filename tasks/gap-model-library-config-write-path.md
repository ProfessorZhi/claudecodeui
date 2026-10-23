---
id: gap-model-library-config-write-path
title: model-library：provider_models 增加 config_json，写入路径校验 env 行（AC-023）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-023
---
## Proposal

GOAL-001 的 AC-023：自定义模型条目可携带 `config.env` 行，POST/PATCH `/api/providers/:provider/models` 校验后落库。这是 ADR-002 方案 B 的存储基座——此前 provider_models 只有 (provider, model_id, model_name, sort_order)，路由 `parseCustomProviderModelPayload` 只接受 {id, model}，`config.env` 会被忽略。

方案（最小切片）：
1. schema：`provider_models` 增加可空列 `config_json`（NULL 表示无覆盖）；必须给已存在的数据库补迁移（参照 `sessions.launch_profile_id` 的加列做法），新库与旧库都得到该列。
2. 行类型：`config.env` 为有序数组，元素 `{key, kind, value?}`，`kind ∈ value | secret | envref | unset`。envref 只存变量名（放在 value 字段，语义为“读哪个宿主变量”）；unset 无 value。
3. 校验：键名走现有白名单函数 `isAllowedLaunchEnvKey`（复用，不复制）——LD_PRELOAD、PATH、NODE_OPTIONS、CLAUDE_CLI_PATH、CLAUDE_CONFIG_DIR 等 400 且不落库；unset 允许白名单内的键（如 ANTHROPIC_API_KEY）；同一键出现两行 400；`(provider, model_id)` 重复 409（ADR-002 决策 5 接受的限制，须有用例登记）；内置模型 id 不可创建带配置的条目（沿用现有 MODEL_ID_ALREADY_EXISTS）。
4. 路由保持薄：解析→调 service→回响应；校验放在 provider-models.service.ts。共享类型按后端标准放 `server/shared/types.ts`。
5. 新增 `server/modules/providers/tests/model-config-write-path.test.ts`：真实临时 sqlite + 真实 router；覆盖上述每条拒绝规则、合法行 201/200、重复 409、旧库迁移。取假用例：把白名单校验换成放行变体时同一断言必须判红。

依据：ADR-002（配置挂在 Model library 上；密钥允许存于 config_json 但只写；unset 为显式行类型；同 model id 不跨端点；第一版含 LLM 网关模板）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-config-write-path.test.ts` 退出码 0（AC-023 的判据命令）。
- [x] 测试证明 LD_PRELOAD/PATH/NODE_OPTIONS 各自 4xx 且全库检索不到该键名；unset ANTHROPIC_API_KEY 合法；重复键 400；重复 (provider, model_id) 409；旧库经迁移获得 config_json。
- [x] 取假变体使该测试判红，红灯输出记录在任务证据中；`provider-models.db.integration.test.ts` 与既有 provider 测试仍退出码 0；`npm run typecheck` 通过。

证据：把 `isAllowedLaunchEnvKey` 校验替换为放行变体后，`model-config-write-path.test.ts` 5 例中 2 例失败（"disallowed env keys are rejected 400 and never persisted"、"PATCH validates config..."），还原后 5/5 通过；typecheck 通过；provider-models 相关测试 23/23 通过（db.integration 与 service 测试因新增 config/config_json 列做了同步更新）。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实的 create/update 写入路径校验并持久化 config，且新库与旧库都有 config_json 列。AC-023 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-023` 能独立核验。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/provider-models.ts
- server/modules/database/tests/provider-models.db.integration.test.ts
- server/modules/providers/services/provider-models.service.ts
- server/modules/providers/tests/provider-models.service.test.ts
- server/modules/providers/provider.routes.ts
- server/modules/launch-profiles/index.ts
- server/shared/types.ts
- server/modules/providers/tests/model-config-write-path.test.ts (new)
- tasks/gap-model-library-config-write-path.md
