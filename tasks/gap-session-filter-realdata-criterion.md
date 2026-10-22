---
id: gap-session-filter-realdata-criterion
title: 会话列表过滤真实数据判据：真实库副本上 292→隐藏 262/可见 30，三条读取路径一致且不多不少，写入跨重启仍在
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-102
---

## Proposal

<!-- dedup-ref -->与三个实现任务（gap-project-session-name-filter-backend / -sidebar-ui / -hide-similar）的区别：它们各自验证本层机制（纯函数、SQL 过滤契约、组件渲染），本任务只立**真实数据上的落地判据**，并把 gap-project-session-name-filter-backend 的 DoD 从「未执行且数字过时」变为可复跑的机械判据。

背景：GOAL-002 的 AC-102 已立（判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/session-filter-realdata.test.ts`，当前红：文件不存在）。backend 任务的 DoD 明写「在本机真实数据库的副本上（只读拷贝 ~/.cloudcli/auth.db）对 claudecodeui 项目设置 `-(task-worker|selector|fix-worker)$` 后，可见会话数从 128 降到约 14，hiddenCount 约 114」——worker 自述未执行，且该数字已过时：实测当前真实数据为 292 个会话（claudecodeui-task-worker 110 / claudecodeui-selector 110 / claudecodeui-fix-worker 42），命中 262、可见 30，且可见的 30 条逐条查过 entrypoint 全是真人会话。

方案：
1. 新增 `server/modules/projects/tests/session-filter-realdata.test.ts`，沿用既有集成测试的项目内前置（`projects-session-filter.integration.test.ts`）：把 `~/.cloudcli/auth.db` **只读复制**到临时目录后设 `DATABASE_PATH` 并 `initializeDatabase()`（绝不对原库写入），用真实 express 应用挂真实 `projects.routes.ts`，经真实 HTTP 路由读写；副本不可得时该测试必须 fail closed（红），不得静默跳过。
2. 经真实 PUT 路由写入规则后，断言三条读取路径一致生效：会话分页（total=30、hiddenCount=262、hasMore 与 total 一致，逐页取完全部 30 条）、最近会话聚合（不含命中会话）、标题搜索（命中项带 filtered=true）。
3. 断言真人会话未被过度隐藏：可见集恰好是这 30 条，不多不少——这是与 hiddenCount 对偶的失败方向，过宽的规则会静默藏掉真人自己的会话。
4. 断言 includeHidden=true 时回到 292。
5. 断言规则写入在重开数据库连接（模拟重启）后仍在。
6. ⚠️ 新测试必须经模块 barrel 导入（`@/modules/database/index.js`、`@/modules/providers/index.js`、`@/modules/projects/projects.routes.js`）；跨模块深导入会被 boundaries lint 拒绝——这条在 backend 任务上已真实发生过并耗尽过一轮重试，故 Touches 预先列出两个 barrel。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/session-filter-realdata.test.ts` 退出码 0，且测试跑在本机 `~/.cloudcli/auth.db` 的只读副本上（不得改用合成数据；副本不可得时必须 fail closed 为红）。
- [x] 同一测试断言：经真实 PUT 路由设规则后 total 等于副本上独立重算的可见会话数、hiddenCount 等于命中数、hasMore 与过滤后的 total 一致，逐页取完全部可见会话且集合与独立重算结果逐条相等，其中不含任何 quay 自动会话。（撰写时读数 total=30 / hiddenCount=262；该库是活库，判据可执行时已涨到 443，故按副本现算而不硬编码该组数字，实跑读数见完成记录。）
- [x] 同一测试断言：可见集恰好等于独立重算的可见集（不多不少）、includeHidden=true 返回副本全部会话、最近会话聚合不含命中会话且仍含全部可见会话、标题搜索的 filtered 与命中规则逐条一致、重开数据库连接后规则仍在。
- [x] 抗假变体：把过滤搬到客户端（分页后再过滤）时 total/hasMore 断言变红；去掉 keepSessionIds 时运行中会话可见性断言变红（两条均已真跑并留输出，见完成记录）。
- [x] `npx oxlint server/` 与 `npm run typecheck` 退出码 0（含 boundaries 规则，无跨模块深导入）。

## DoD

真实落地判据：不是测试文件存在。要求在真实数据库副本上真的跑出 292 / 隐藏 262 / 可见 30 这组读数并把输出记入任务的完成记录；AC-102 判据命令在 goal-driver 环里由红转绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。取假变体：把过滤搬到客户端（分页后再过滤）时该判据必须变红——仅有绿而无抗假变体证据不算完成。

## Touches

- server/modules/projects/tests/session-filter-realdata.test.ts (new)
- server/modules/database/index.ts
- server/modules/projects/index.ts
- tasks/gap-session-filter-realdata-criterion.md

## Needs-Human

**执行 2026-09-20T12:32:48.692Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 <60000ms 快速死亡（退避上限）；成因类：ordinary（快速死亡成因分类器取值，⛔ 非 human-adjudication 模板）
- 成因类：human-adjudication

## Completion

**执行 2026-09-20（task/gap-session-filter-realdata-criterion，commit 95112dc0）**

判据命令 `npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/session-filter-realdata.test.ts` 退出码 0，2/2 pass。实跑读数（同一轮内两次采样，可见真实库在测试运行期间仍在增长）：

```
__REALDATA__ project=/data/home/yale/work/claudecodeui total=443 hidden=410 visible=33
__REALDATA__ project=/data/home/yale/work/claudecodeui total=444 hidden=411 visible=33
__REALDATA_ANTIFAKE__ client-shape total=444 rows=5 | server-shape total=33 rows=5
__REALDATA_ANTIFAKE__ newest page hidden=4 visible=1
```

⚠️ 判据不硬编码 292 / 262 / 30：那是撰写本任务时的读数。判据可执行时真实库已从 292 涨到 443（同上，一轮内 443→444，因为 fleet 自身在写这个库）。因此 AC 的判据改为「与副本上独立重算的结果逐条相等（不多不少）」，读数由 `__REALDATA__` 行如实记录——写死数字会让判据在几分钟内变红，反而失去判据价值。

fail closed 证据（副本不可得）：`HOME=/tmp/empty-home npx tsx --tsconfig server/tsconfig.json --test <判据文件>` → 退出码 1，`fail 2 / skipped 0`，报错 `real store unavailable at /tmp/empty-home/.cloudcli/auth.db: ENOENT ... — this criterion must run on a read-only copy of the real database and deliberately fails closed instead of skipping`。

原库未被写入：判据跑完后 `~/.cloudcli/auth.db` 中 claudecodeui 项目的 `projects.session_filter` 仍为 null（规则只写进了临时副本）。

抗假变体（两条均真跑并留输出）：

1. 把过滤搬到客户端（分页后再过滤）：把 `readProjectSessionsPageByPath` 的可见性参数去掉、改为取回整页后在 JS 里 filter 且 total 取未过滤总数 ⇒ 退出码 1，`fail 2`，`AssertionError: total must stay constant across pages — actual: 444, expected: 33`。
2. 去掉 keepSessionIds：`buildSessionVisibility` 返回 `keepSessionIds: []` ⇒ 退出码 1，`fail 1`，`AssertionError: a kept session joins the visible total — actual: 33, expected: 34`。

两条变体均已 revert（`git checkout --`），最终 diff 只含新增的判据文件。

静态门：`npx oxlint server/` 退出码 0（0 error；本文件无任何 finding，含 boundaries 规则，未跨模块深导入）；`npm run typecheck` 退出码 0。

scoped gate：`bash scripts/test.sh --for-task gap-session-filter-realdata-criterion --allow-thin` → 退出码 0（`__PERFILE__ duration_ms=3403 server/modules/projects/tests/session-filter-realdata.test.ts passed=true`），已写 scoped-gate-cache（develop-sha 3a587687）。
