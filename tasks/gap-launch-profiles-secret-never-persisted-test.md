---
id: gap-launch-profiles-secret-never-persisted-test
title: launch-profiles：带凭据的 profile payload 写入后 sqlite 全库检索不到凭据值，且写进任一列会变红（AC-003）
status: done
needs_human_cause: blocked-outside-task
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-003
---
## Proposal

GOAL-001 的 AC-003 要求：写入带凭据的 profile payload 后，在 sqlite 全库检索不到该凭据值；取假形态：把值写进任一列都会被检索命中而变红。目前 `server/modules/launch-profiles/` 不存在，`launch_profiles` 表与 repository 也未建，`tasks/` 中没有任何任务以 `goal_ac: AC-003` 推进该判据，这是结构性缺口（判据测试 `secret-never-persisted.test.ts` 因模块缺失而红）。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）「数据模型」（明确没有 `launch_profile_secrets` 表，密钥不入库）与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-gateway-end-to-end-test（AC-002）在编译层读取环境变量值并注入子进程，本任务只覆盖持久化层：profile 只存环境变量名（`authEnvVarName`），凭据值绝不落库；白名单归 AC-004 的任务。

方案（最小切片）：
1. 在 `server/modules/database/schema.ts` 新增 `launch_profiles` 建表 SQL（id/provider/name/description/deployment/is_default/config_json/sort_order/时间戳，UNIQUE(provider,name)）及 `sessions.launch_profile_id` 列迁移（`migrations.ts`）；不建任何 secrets 表。
2. 新增 `server/modules/database/repositories/launch-profiles.db.ts`（create/get/list/update/delete），经 `server/modules/database/index.ts` 桶文件导出（模块边界规范要求跨模块只走 index），并在 `server/modules/launch-profiles/` 的 service 写入路径上对 payload 做密钥防护：payload 中只允许凭据的环境变量名引用（`authEnvVarName`），拒绝或剥离内联凭据值字段（如 `apiKey`/`authToken`/`token`），使值无法进入 `config_json`。
3. 新增 `server/modules/launch-profiles/tests/secret-never-persisted.test.ts`：使用隔离的临时 sqlite 库，写入携带独特哨兵凭据（如 `sk-test-SENTINEL-<random>`）的 gateway profile payload；随后对全库做检索——遍历 `sqlite_master` 中每张表的每一列，`SELECT ... WHERE CAST(col AS TEXT) LIKE '%SENTINEL%'`，并对数据库文件原始字节做子串检索（含 WAL 文件），断言命中数为 0。
4. 取假用例：同一测试内直接用原始 SQL 把哨兵值写进 `launch_profiles` 的任一列（`name`、`description`、`config_json` 各一次），断言同一检索函数命中数大于 0，证明该检索在值被写入任一列时会变红（而非恒绿）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/secret-never-persisted.test.ts` 退出码 0（AC-003 的判据命令）。
- [x] 测试写入含哨兵凭据的 profile payload 后，遍历全库所有表所有列及数据库文件原始字节的检索命中数经 `assert.strictEqual(hits, 0)` 断言为 0。
- [x] 取假用例通过：把哨兵值分别写进 `name`、`description`、`config_json` 任一列后，同一检索函数命中数均大于 0（`assert.ok(hits > 0)`），证明判据会变红。
- [x] `grep -n "launch_profiles" server/modules/database/schema.ts` 有命中且 `grep -rn "launch_profile_secrets" server` 无命中；`npm run typecheck` 与 `npm test` 退出码 0（既有 server 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求 payload 经真实的 launch-profiles service 与 repository 写入真实的（临时）sqlite 库，检索覆盖 `sqlite_master` 中全部表的全部列与库文件字节，而不是只查 `launch_profiles` 一张表；取假用例证明检索对任一列的写入都敏感。AC-003 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-003` 能独立核验该任务。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/index.ts
- server/modules/database/repositories/launch-profiles.db.ts (new)
- server/modules/launch-profiles/index.ts (new)
- server/modules/launch-profiles/launch-profiles.service.ts (new)
- server/modules/launch-profiles/tests/secret-never-persisted.test.ts (new)
- tasks/gap-launch-profiles-secret-never-persisted-test.md

## Adjudication 2026-09-20（人 yale 授权：needs-human → todo → ready）

下方 `## Needs-Human` 块已失效，仅作历史记录保留；再次派发的 worker 不应把它读作现行阻塞。

- 裁定：死因是环境性的，不是任务质量问题。worker-driver 连续 3 次 exited-not-landed 撞满重试上限，是机械翻转。
- 根因：下方判词已逐字记下——fan-in-ff-merge 因 `suite_head..tip` delta NOT-EVALUATED 而拒绝 ff，classifier 在每个探测根下都 exit=2「registry file (runner-static-gate.ts) not found」。那个硬编码的 repo 相对路径（select-static-checks-for-touches.ts 中的 TEST_SH_REL）在已安装插件布局与本项目下都解析不到，证书闸只能按未知 delta fail-closed，每次尝试烧掉一整次 suite 运行，直至重试耗尽。
- 修复：已在 develop 落地，commit **f7604c68**（本项目自行提供 plugin/scripts/runner-static-gate.ts）。已在真实任务分支上验证 `--classify-delta` 现在 exit 0，且仅含 tasks/<id>.md 的 delta 判为惰性，证书闸通过、ff 首次尝试即可推进。该重试耗尽路径已不可达。
- 使用的 ABI 动词：lifecycle_adjudicate（只读审计）→ lifecycle_retreat（needs-human → todo，理由记入 GateEvent）→ 状态随后到达 ready。

## Needs-Human（已失效，历史记录）

**执行 2026-09-20T03:50:46.529Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：blocked-outside-task
- 失败步/判词：step=ff: fan-in-ff-merge: 本任务 gap-launch-profiles-secret-never-persisted-test 的 suite 证书未满足 — suite_head..tip delta NOT-EVALUATED — classifier produced no verdict — root=/data/home/yale/work/claudecodeui exit=2 (select-static-checks-for-touches: registry file (runner-static-gate.ts) not found at /data/home/yale/work/claudecodeui/plugin/scripts/runner-static-gate.ts); root=/data/home/yale/.claude/plugins/cache/quay/quay/0.10.0 exit=2 (select-static-checks-for-touches: registry file (runner-static-gate.ts) not found at /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/plugin/scripts/runner-static-gate.ts); root=/data/home/yale/.claude/plugins/cache/quay/quay exit=2 (select-static-checks-for-touches: registry file (runner-static-gate.ts) not found at /data/home/yale/.claude/plugins/cache/quay/quay/plugin/scripts/runner-static-gate.ts); root=/data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/scripts exit=2 (select-static-checks-for-touches: registry file (runner-static-gate.ts) not found at /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/scripts/plugin/scripts/runner-static-gate.ts); 证书闸按未知 delta fail-closed（⛔ 这不是判决：既非惰性、也非被 @static-object 覆盖）; 证书要求 suite_head 是待 ff tip 的祖先、且 suite_head..tip 的 delta 经 --classify-delta 判惰性（无 change/full 检查器 @static-object 覆盖 + 落 doc 面）；塞入 @static-object 覆盖路径 ⇒ 拒（可取假）。NOT acquiring the merge lock
- run_id：wk-prod-anchor
- session_id：96a2d57f-a257-424a-b7ef-128dde79be85
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-secret-never-persisted-test-wk-prod-anchor.log
