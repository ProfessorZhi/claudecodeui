---
id: gap-project-session-name-filter-backend
title: 项目级会话名过滤（后端）：projects.session_filter 存一组隐藏正则，会话分页在 SQL 层过滤并返回
  hiddenCount，includeHidden 可绕过
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景：本项目由 quay 驱动开发，quay 用 `claude -p -n <role>` 自动启动大量会话（claudecodeui 项目 128 个会话中约 114 个是 `*-task-worker` / `*-selector` / `*-fix-worker`），侧边栏被淹没。会话名（`sessions.custom_name`，没有则用标题）能可靠区分它们；entrypoint 区分不了（quay 在 cloudcli 会话里派发时继承 `sdk-ts`，与真人会话相同）。会话列表是服务端分页（`limit/offset`，返回 `total/hasMore`），所以过滤必须在服务端 SQL 层做，客户端过滤会破坏分页。

方案（已与人讨论确认的设计）：
1. `projects` 表新增列 `session_filter TEXT`（JSON：`{"hide": string[]}`，NULL 等于无规则），写入 `server/modules/database/schema.ts` 与 `migrations.ts` 的幂等迁移；`projects.db.ts` 提供 get/set。新项目默认无规则，不做任何自动建议。
2. 新增纯函数模块 `server/modules/projects/services/session-name-filter.service.ts`：`validateSessionFilter(input)`（每条须为可编译的 JS 正则、长度 ≤200、条数 ≤20，非法则整体拒绝并指出行号）与 `compileSessionFilter(hide)`，把多条正则合成一个不锚定、忽略大小写的匹配器；只匹配会话显示名，不匹配 entrypoint。
3. `projects-with-sessions-fetch.service.ts`：会话分页在 SQL `WHERE` 里通过 better-sqlite3 注册的函数（`db.function`）排除命中规则的会话，使 `total/hasMore` 与过滤后一致；分页接口新增 `includeHidden=true` 查询参数（跳过过滤），响应新增 `hiddenCount`（命中规则的会话数）。项目列表响应带上 `sessionFilter`。
4. `projects.routes.ts`：新增 `PUT /api/projects/:projectId/session-filter`（保存，非法返回 400 并带行号）与 `POST /api/projects/:projectId/session-filter/preview`（用草稿规则返回命中数、未命中数及各自最新若干会话名，不写库）。
5. 例外：正在运行的会话不被隐藏，服务端在过滤时不排除传入 `keepSessionIds` 列表里的会话（前端传运行中/需关注/当前选中的 id）。
6. 最近会话聚合列表按各自项目的规则过滤（同一匹配器）；标题搜索（`session-conversations-search.service.ts`）忽略过滤，结果里每条带 `filtered: boolean` 标记。归档视图不受影响。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/session-name-filter.service.test.ts` 退出码 0：覆盖合法/非法正则（含非法行号、超长、超条数）、多条合并、忽略大小写、不锚定、空规则不过滤。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/projects-session-filter.integration.test.ts` 退出码 0：用真实临时 sqlite 建 30 个会话（其中 20 个名字命中 `-task-worker$`），设 `limit=5` 逐页翻完，断言可见总数 10、`hasMore` 与 `total` 一致、`hiddenCount=20`；`includeHidden=true` 时返回 30。
- [x] 同一测试断言 `keepSessionIds` 中的命中会话仍出现在结果里，且 PUT 保存非法正则返回 400 并含行号，preview 不改变库内 `session_filter`。
- [x] 同一测试断言标题搜索命中被隐藏的会话时返回项带 `filtered: true`，最近会话聚合列表按项目规则排除命中的会话。
- [x] 迁移幂等：对已有 `projects` 表（无该列）连续跑两次迁移，第一次加列、第二次无操作，既有行 `session_filter` 为 NULL（`server/modules/database/tests/projects.db.integration.test.ts` 内新增断言，退出码 0）。
- [x] `npm run typecheck` 与 `npm test` 退出码 0（既有 server 测试不回归）。

## DoD

真实落地判据：不是仅有纯函数与测试文件存在。要求经真实的 `projects.routes.ts` 路由（临时 sqlite + 真实 express 应用）PUT 保存规则，再经真实的会话分页与最近会话接口读取，看到规则在服务端分页里生效（`total/hasMore/hiddenCount` 一致、`includeHidden` 与 `keepSessionIds` 行为正确）；并在本机真实数据库的副本上（只读拷贝 `~/.cloudcli/auth.db`）对 claudecodeui 项目设置 `-(task-worker|selector|fix-worker)$` 后，可见会话数从 128 降到约 14，`hiddenCount` 约 114，结果记入任务的完成记录。取假变体：把过滤改成客户端侧（分页后再过滤）时，分页断言必须变红。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/index.ts
- server/modules/database/repositories/projects.db.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/tests/projects.db.integration.test.ts
- server/modules/projects/index.ts
- server/modules/projects/services/session-name-filter.service.ts (new)
- server/modules/projects/services/projects-with-sessions-fetch.service.ts
- server/modules/projects/projects.routes.ts
- server/modules/providers/index.ts
- server/modules/providers/services/session-conversations-search.service.ts
- server/modules/providers/services/sessions.service.ts
- server/shared/types.ts
- server/modules/projects/tests/session-name-filter.service.test.ts (new)
- server/modules/projects/tests/projects-session-filter.integration.test.ts (new)
- tasks/gap-project-session-name-filter-backend.md

## Needs-Human

**执行 2026-09-20T07:40:23.207Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-project-session-name-filter-backend — 1 violation(s)
- run_id：wk-prod-anchor
- session_id：f3828eb2-fe58-4be9-ac4c-3062521c5911
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-project-session-name-filter-backend-wk-prod-anchor.log
