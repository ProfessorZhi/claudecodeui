---
id: gap-launch-profiles-partial-update-preserves-fields
title: launch-profiles：PUT 只更新请求里出现的字段，UI 保存不再抹掉 isDefault/deployment 等（AC-019）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-019
---
## Proposal

GOAL-001 的 AC-019 要求：保存 profile 绝不丢弃请求未提交的字段。现状是数据丢失缺陷：`server/modules/launch-profiles/launch-profiles.routes.ts` 的 `parseProfileBody` 把缺失字段当作默认值（`isDefault: raw.isDefault === true` → false，`description` → null，`deployment` → 'gateway'，`sortOrder` 缺省），`PUT /:id` 再把它交给 `updateProfile`，而 `server/modules/database/repositories/launch-profiles.db.ts` 的 `update()` 用整体 UPDATE 覆盖全部列；前端 `src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts` 的 `toRequestBody` 又把 `deployment: 'gateway'` 硬编码进每次保存。结果：用 API 把 profile 设为默认后，经 UI 点一次 Save，isDefault 被清成 false、deployment 被改回 gateway。`tasks/` 中没有任何任务以 `goal_ac: AC-019` 推进该判据，这是结构性缺口。依据 `docs/proposals/launch-profiles.md` 与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-rest-crud-routes-test（AC-008，已 done）建了本路由与整体 UPDATE；本任务只改 PUT 的部分更新语义与前端保存请求体，不动 POST/GET/DELETE。

方案（两段缺一不可，遵循 backend-module-standards 与 frontend-module-standards）：
1. 服务端：PUT 使用「只更新出现的字段」语义。为 PUT 单独解析出 Partial 输入（仅收录 body 中出现且类型合法的 name/provider/description/deployment/isDefault/sortOrder/config，类型非法返回 400），service.updateProfile 先读现有行、与提交字段合并后再写库（或 repository 动态 SET）；未提交的 isDefault/description/sortOrder/deployment 原样保留；config 若提交则按现有校验（内联凭据拒绝、env 白名单）整体替换，未提交则保留原 config；profile 不存在仍 404。POST 语义保持不变。
2. 前端：`toRequestBody` 更新（PUT）时不再携带 `deployment`、`isDefault`、`description`、`sortOrder`，只发送 name/provider 与基于 existing.config 合并出的 config（未编辑键原样带回）；新建（POST）仍可带 deployment: 'gateway'。
3. 新增 `server/modules/launch-profiles/tests/profile-partial-update.test.ts`（真实 router + 临时 sqlite）：先建 profile 并设 isDefault=true、description、sortOrder、deployment 非默认值，仅 PUT `{name}` 后 GET 读回，断言这些字段与 config 全部不变；再 PUT 仅含 config 的一个键变更，断言其余 config 键保留。新增 `src/modules/settings/tests/launchProfileSavePreserves.test.tsx`：用 fetch 桩渲染设置页，编辑已有 profile（含 isDefault: true）点 Save，断言 PUT 请求体不含 isDefault/description/sortOrder/deployment 键，且 config 中未编辑的键仍在。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/profile-partial-update.test.ts` 退出码 0，且经真实 HTTP PUT 仅提交 `{name}` 后 GET 读回的 isDefault/description/sortOrder/deployment 与 config 经 `assert.deepStrictEqual` 与之前一致。
- [x] `npx vitest run src/modules/settings/tests/launchProfileSavePreserves.test.tsx` 退出码 0，且以 fetch 桩断言 PUT 请求体 `JSON.parse` 后不含 `isDefault`、`deployment`、`description`、`sortOrder` 键，config 中未编辑的键仍存在。
- [x] 取假形态：在改动前的实现上两条命令均为红（isDefault 经一次保存即变 false）；`grep -n "deployment: 'gateway'" src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts` 在更新（PUT）路径上无命中。
- [x] `npm run typecheck` 与 `npm test` 退出码 0，既有 profile-rest-api 等测试不回归。

## DoD

真实落地判据：不是仅有测试文件存在。服务端要求请求经真实 Express router、真实 launchProfilesService 与真实临时 sqlite 库走完整链路，验证 API 设为默认的 profile 经部分 PUT 后标记仍在；前端要求真实 hook/组件经 fetch 桩发出的请求体被断言，而非只测函数返回值。AC-019 判据命令（两段以 && 连接）在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-019` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/launch-profiles.routes.ts
- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/database/repositories/launch-profiles.db.ts
- server/modules/launch-profiles/tests/profile-partial-update.test.ts (new)
- src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts
- src/modules/settings/tests/launchProfileSavePreserves.test.tsx (new)
- src/modules/settings/tests/launchProfileSettings.test.tsx
- tasks/gap-launch-profiles-partial-update-preserves-fields.md
