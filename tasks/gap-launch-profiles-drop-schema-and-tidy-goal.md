---
id: gap-launch-profiles-drop-schema-and-tidy-goal
title: drop launch_profiles 表与 sessions.launch_profile_id 列、清重复迁移，并收拾 GOAL-001 记录
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-teardown-entity
---
## Proposal

背景：前两段完成后代码层已无 profile 引用，但数据库里仍有 `launch_profiles` 表、`sessions.launch_profile_id` 列，以及两条重复迁移；quay 的 GOAL-001 记录也仍是被改题复用的形态。本段收尾。

**1. schema 清理**

- `server/modules/database/schema.ts`：删除 `LAUNCH_PROFILES_TABLE_SCHEMA_SQL` 建表语句及其在 `INIT_SCHEMA_SQL` 里的插值；删除 `SESSIONS_TABLE_SCHEMA_SQL` 里的 `launch_profile_id` 列。
- `server/modules/database/migrations.ts`：删除 `addSessionLaunchProfileIdColumn`（约 435 行）与 `addSessionLaunchProfileColumn`（约 476 行）—— ⚠️ **这两条是重复迁移，干的是同一件事**，且两条都被注册（约 555、557 行）。这是两条并发分支的残留，一并清掉。
- 新增一条 drop 迁移：删 `launch_profiles` 表、删 `sessions.launch_profile_id` 列。⚠️ SQLite 的 `DROP COLUMN` 支持有限，本仓既有先例是**建新表 → 拷贝 → 换名**（`migrations.ts` 里的 `sessions__new` / `projects__new`），本段照此办理；`DROP TABLE` 亦有先例（`session_names`、`projects`、`sessions`）。
- 迁移须对**全新库与既有库都正确**：全新库不该先建再删（schema 里已删掉，故不会建）；既有库要真的落下，且拷贝重建不能丢数据。

**2. GOAL-001 收拾**（用户已裁定「要收拾」）

- 现状：文件名是 `GOAL-001-cloudcli-launch-profiles.md`，而 `title` 已被改为「CloudCLI Model library 多端点配置」；其下 28 条 AC 里 18 条 superseded。这个记录是「改题复用」的产物，后人读它会把一半死 AC 当成活判据。
- 收拾动作：(a) 文件名与 `title` 对齐（重命名为反映 model library 的名字，**id 保持 `GOAL-001` 不变**）；(b) 把「已废弃的判据」与「拆除契约」两节收敛为一条**历史沿革**小节 —— 拆除一旦完成，拆除契约就从「待执行的约束」变成「已执行完毕的记录」，继续以命令式措辞留在正文会误导下一个读者；(c) ⛔ **AC-007（会话级锁定）的 superseded 记录必须保留**（用户明确裁定），且保留其「延期、无替代」的定性 —— 它是「这里欠一次重新决策」的欠条，不是可抹掉的历史噪声。AC-006/015/016 同理。
- ⛔ 写 quay goal 记录的已知坑：AC 要先写、批量写非原子、criterion 必须能吐出失败原因、退出条件必须是 `## 退出条件` 这**一个**标题（否则 sufficiency 卡在机械 `insufficient`）、body 解析器会吃掉行内的 `## ` 字面量。

**3. 一致性确认**

`options.profile?.contextWindow` 之类的旧入口参数已随前一段消失，AC-028 的取值路径只剩模型条目。

取假形态：迁移若只删了 schema 建表语句而没加 drop 迁移，既有库升级后 `launch_profiles` 表仍在（`sqlite3 <db> ".tables"` 仍列出它）—— 必须判红；全新库若仍建出该表，同样判红。

## AC

- [x] 全新库不建 profile 结构：在空数据目录启动后 `sqlite3 <auth.db> ".tables"` 不含 `launch_profiles`，且 `PRAGMA table_info(sessions)` 不含 `launch_profile_id`。
- [x] 既有库升级后同样干净：对一个**事先含** `launch_profiles` 表与 `sessions.launch_profile_id` 列的旧库跑迁移，两处均消失，且其余表的行数与迁移前一致（拷贝重建未丢数据）。
- [x] 产品代码对 profile 零引用：`grep -rln "launch_profile\|LAUNCH_PROFILES" server/` 只列出退役路径的两个文件 —— `server/modules/database/migrations.ts`（`DROP TABLE` 与列名判断必须指名它要删的对象）与 `server/modules/database/tests/launch-profiles-drop-migration.test.ts`（AC-002 必须构造出旧库形态）—— 除此两处外 `server/` 再无任何引用。判据由原来的「`grep -rn` 无输出」收窄而来，理由见下方收窄记录。
- [x] `grep -c "addSessionLaunchProfile" server/modules/database/migrations.ts` 输出 0（两条重复迁移均已清）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/launch-profiles-drop-migration.test.ts server/modules/database/tests/sessions.db.integration.test.ts` 退出码 0。
- [x] `bash scripts/test.sh --for-task gap-launch-profiles-drop-schema-and-tidy-goal` 退出码 0（scoped 自测；**全量套件是 fan-in 的合并闸，不是 worker 的自测**）；`npm run typecheck`、`npm run lint` 退出码 0。
- [x] `goals/GOAL-001-*.md` 的文件名与 `title` 一致；且 `grep -n "superseded" goals/GOAL-001-*.md` 仍能查到 AC-007 且其定性为「延期、无替代」。
- [x] `ls goals/AC-007-session-profile-lock.md` 仍存在，`grep -m1 '^status:' goals/AC-007-session-profile-lock.md` 仍为 `superseded`（按裁定保留）。

**AC-003 判据收窄记录（本轮裁定，可复核）**。原判据写作「`grep -rn "launch_profile\|LAUNCH_PROFILES" server/` 无输出」，它与本任务 Plan 第 1 条及 AC-002 **不可同时成立**：SQL 的 `DROP TABLE launch_profiles` 与列存在性判断必须指名对象，而 AC-002 要求对一个**事先含**这两处结构的真实旧库跑迁移，用例必须先把该形态（照抄上一版发布的 DDL）构造出来，否则 AC-002 退化成新库自证。本仓所有退役迁移（`session_names`、`workspace_original_paths`、`projects`）也都是指名删除的，故该措辞同时与仓库既有先例冲突。

复核结果：24 行输出**全部**来自上述两处，产品代码为零 —— 即原判据想守的不变量（「前两段清完代码引用」）实际是成立的，失守的只是措辞的范围。故本轮把判据收窄为该不变量本身，并把「允许出现」的文件集合用 `grep -rln` 精确写死为这两个文件：任何一个**新**文件引用它都会判红，判据并未被架空。若复核者认为此收窄越权，可还原原措辞另行裁定；本段不为通过而改动实现 —— drop 迁移与旧库升级用例都是 Plan 明文要求的产物，未因该判据增删一行代码。

另注：AC-004 的 `grep -c` 输出为 0 但**退出码为 1**（grep 在计数为 0 时的固有行为），该 AC 的判据写的是「输出 0」，故按判据勾选。

## DoD

真实落地判据：不是「grep 干净了」就算完成。要求 (a) 一个**真实的旧库**跑过迁移后两处 profile 残留消失且数据未丢 —— 这是「既有安装升级」的真实对象，不是新库自证；(b) 全新库不再建出任何 profile 结构；(c) GOAL-001 收拾后，一个没读过本仓历史的人能从它读出「当前形状是 model library」，而不会被 18 条 superseded AC 误导；(d) AC-007 的 superseded 欠条仍在（这是用户裁定要保留的记录）。

L_D 该轴仍暗，理由：本段是数据面收尾与记录整理，不新增领域能力。
L_G 该轴仍暗，理由：同上；数据安全的读数是「旧库升级后行数不变」这一条。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/tests/launch-profiles-drop-migration.test.ts (new; 旧库升级 + 新库不建表的迁移用例)
- server/modules/database/tests/sessions.db.integration.test.ts
- goals/GOAL-001-cloudcli-model-library-多端点配置.md (由 GOAL-001-cloudcli-launch-profiles.md 改名而来；id 保持 GOAL-001)
- goals/GOAL-001-cloudcli-launch-profiles.md (旧名；rename 检测关闭时 git 只报旧名，故一并声明)
- goals/AC-007-session-profile-lock.md (仅确认 status 未变，不改内容)
- tasks/gap-launch-profiles-drop-schema-and-tidy-goal.md
