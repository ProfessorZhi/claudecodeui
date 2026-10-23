---
id: gap-model-library-secret-write-only
title: model-library：secret 行只写、读接口不回传、auth.db 收紧为 0600（AC-022）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-library-config-write-path
goal_ac: AC-022
---
## Proposal

GOAL-001 的 AC-022：ADR-002 决策 2 允许 secret 值存于 config_json，但必须只写。否则“可用性优先”会变成“密钥随列表接口外泄”。三个防线：(a) 任何读接口与错误响应都不回传值，只回 `isSet`；(b) 更新时 secret 行不带 value 表示保持原值、带空串表示清除；(c) `auth.db` 在打开时收紧为 0600（实机测得当前为 0644，任何本机用户可读）。

<!-- dedup-ref -->相关但不同机制：此前 AC-003（secret-never-persisted，现已被本条取代）断言“密钥不落库”，前提已被 ADR-002 推翻；本任务须同时把该旧测试处理掉（移除或改写为新语义），不得悄悄放宽而留下互相矛盾的两套判据。

方案（最小切片）：
1. 读路径：`GET /api/providers/:provider/models` 与单条读取返回的 secret 行为 `{key, kind:'secret', isSet:true}`，绝无 value 字段；envref/value/unset 行照常返回。剥离发生在 service 出口而不是路由或前端，保证任何调用方都拿不到。
2. 内部读路径：编译层需要 secret 真值，因此另设仅供服务端内部使用的读取入口（不挂路由、不导出到 barrel 之外），并在注释里写明约束。
3. 更新语义：PATCH 时 secret 行缺 value → 保持；空串 → 清除；非空 → 替换。这同时是 AC-019 “保存不丢字段”缺陷的正确解法，避免编辑一次模型就清空 token。
4. 错误响应：校验失败、404 等不得回显请求体里的 secret 值。
5. `auth.db` 权限：数据库连接打开时若文件存在且权限宽于 0600 则收紧，新建时以 0600 创建；仅 POSIX，Windows 跳过并注释说明。
6. 新增 `server/modules/providers/tests/model-secret-write-only.test.ts` 与 `server/modules/database/tests/db-file-permissions.test.ts`。取假用例：让列表接口回传 value 时必须判红。

⚠️ 未核实项须登记：我只检查了 provider.routes.ts 与 server/index.ts 没有请求体日志，未查全局日志中间件；实现时须确认 secret 值不会被任何日志或错误路径打印。

依据：ADR-002（配置挂在 Model library 上；密钥允许存于 config_json 但只写；unset 为显式行类型；同 model id 不跨端点；第一版含 LLM 网关模板）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-secret-write-only.test.ts server/modules/database/tests/db-file-permissions.test.ts` 退出码 0（AC-022 的判据命令）。
- [x] 测试证明：列表、单条、错误响应中检索不到 secret 值（只有 isSet）；PATCH 缺 value 保持、空串清除；auth.db 打开后权限为 0600。
- [x] 取假变体（读接口回传值）使该测试判红，红灯输出记录在任务证据中；旧的 secret-never-persisted 测试已被处理且无矛盾判据残留；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实的读路径不回传 secret、真实的数据库打开路径收紧权限。AC-022 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-022` 能独立核验。

## Evidence

- 取假变体（service 出口把 secret value 回传）红灯：`✖ list and create responses expose only isSet for secret rows` (AssertionError: create response must not echo the secret)、`✖ PATCH: ...`、`✖ error responses never echo...`，pass 0 / fail 3；还原后 5/5 绿，`npm run typecheck` 通过。
- 旧 `launch-profiles/tests/secret-never-persisted.test.ts` 仅覆盖 launch-profile 凭据（env 变量名引用），与 ADR-002 的 model-library secret 不冲突；已在文件头注明作用域，无矛盾判据。
- 未核实项：全局日志中间件与 express.json 解析错误（body-parser 的 JSON 语法错误消息可能含请求体片段）未审计；本任务的错误响应测试只覆盖 AppError 路径。
- anti-drift 修复：实现为 secret 行新增了 `server/shared/types.ts` 中的类型（isSet 读形态），该文件此前未列入 Touches，现补入。

## Touches

- server/modules/database/repositories/provider-models.ts
- server/modules/database/connection.ts
- server/modules/providers/services/provider-models.service.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/tests/model-secret-write-only.test.ts (new)
- server/modules/database/tests/db-file-permissions.test.ts (new)
- server/modules/launch-profiles/tests/secret-never-persisted.test.ts
- server/shared/types.ts
- tasks/gap-model-library-secret-write-only.md
