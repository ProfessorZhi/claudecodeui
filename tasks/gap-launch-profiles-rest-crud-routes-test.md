---
id: gap-launch-profiles-rest-crud-routes-test
title: launch-profiles：经 REST 路由层建出 profile 并读回（新增 launch-profiles.routes.ts +
  挂载，AC-008）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-008
---
## Proposal

GOAL-001 的 AC-008 要求：经 REST 路由层建出一个 launch profile 并读回，使 profile 可被应用管理而非只能直写库；取假形态：模块当前没有 `launch-profiles.routes.ts`，判据测试 `profile-rest-api.test.ts` 今天必红。`tasks/` 中没有任何任务以 `goal_ac: AC-008` 推进该判据，这是结构性缺口。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-secret-never-persisted-test（AC-003）已建 `launchProfilesService.createProfile` 与 `launch-profiles.db.ts` repository，只覆盖持久化层；本任务只加 HTTP 路由层（Express router），复用该 service，不重写持久化。

方案（最小切片，遵循 backend-module-standards：router 工厂 + 依赖注入，跨模块只走 index）：
1. 新增 `server/modules/launch-profiles/launch-profiles.routes.ts`，导出 `createLaunchProfilesRouter(service)`：`POST /`（创建，入参含 provider/name/config，复用 service 的内联凭据拒绝，违规返回 400）、`GET /`（列表）、`GET /:id`（读回，不存在 404）、`PUT /:id`、`DELETE /:id`。如 service/repository 缺 list/get/update/delete，则在 `launch-profiles.service.ts` 与 `server/modules/database/repositories/launch-profiles.db.ts` 中补齐。
2. 经 `server/modules/launch-profiles/index.ts` 导出 `launchProfilesRoutes`（模块装配在 `launch-profiles.module.ts`），并在 `server/index.ts` 以 `app.use('/api/launch-profiles', authenticateToken, launchProfilesRoutes)` 挂载（与 settings 路由同式）。
3. 新增 `server/modules/launch-profiles/tests/profile-rest-api.test.ts`：用临时 sqlite 库与真实 router 挂到内存 Express 应用（真实 HTTP 请求），POST 创建 profile、GET 列表与 GET /:id 读回并断言字段一致；再断言携带内联凭据的 POST 返回 400 且库中无该行；取假用例：未挂载路由时同一请求返回 404，证明测试非恒绿。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/profile-rest-api.test.ts` 退出码 0（AC-008 的判据命令）。
- [x] 测试经真实 HTTP POST 创建 profile 后，GET /:id 与 GET / 读回的 name/provider/config 经 `assert.deepStrictEqual` 与提交内容一致；含内联凭据的 POST 断言返回 400。
- [x] `test -f server/modules/launch-profiles/launch-profiles.routes.ts` 且 `grep -n "api/launch-profiles" server/index.ts` 有命中；取假用例（未挂载路由 → 404）在同一测试内通过。
- [x] `npm run typecheck` 与 `npm test` 退出码 0（既有 server 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求请求经真实 Express router、真实 launchProfilesService 与真实（临时）sqlite 库走完整链路，创建后由 REST 读回，而非直接调 repository；路由在 `server/index.ts` 真实挂载并受 `authenticateToken` 保护。AC-008 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-008` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/launch-profiles.routes.ts (new)
- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-profiles.module.ts
- server/modules/launch-profiles/index.ts
- server/modules/database/repositories/launch-profiles.db.ts
- server/index.ts
- server/modules/launch-profiles/tests/profile-rest-api.test.ts (new)
- tasks/gap-launch-profiles-rest-crud-routes-test.md
