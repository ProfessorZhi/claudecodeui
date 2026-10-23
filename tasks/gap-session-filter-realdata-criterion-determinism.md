---
id: gap-session-filter-realdata-criterion-determinism
title: 会话过滤真实数据判据去随机化：快照取一致点、断言不读活库近因窗、失败首行可归因（30 连绿）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-102
---
## Proposal

<!-- dedup-ref -->同族但机制不同的既有任务：`gap-session-filter-realdata-criterion`（status=done，commit 95112dc0）建成了本判据这颗仪器；本任务不动它测什么，只去掉仪器的随机性——它现在会在代码没变的情况下自己变红。`gap-project-session-name-filter-real-browser-e2e`（done，AC-101）覆盖浏览器层，与本任务无交集。

### 现象：判据在未变的代码上由绿转红，再转绿

判据命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/session-filter-realdata.test.ts`。`.quay/gate-events.jsonl` 的 AC-102 goal 事件，criterionHash 全程为 `ac7878df711f4400`（同一个判据）：

- pass 2026-09-20T23:12:31Z（goal-sweep）
- pass 2026-09-21T00:12:56Z（goal-sweep）
- pass 2026-09-21T01:13:27Z（goal-sweep）
- **fail 2026-09-21T02:13:52Z（goal-sweep）**
- **fail 2026-09-21T02:13:56Z（goal-cli，driver 立案前的复跑）**

这五轮之间没有任何提交落地：`git reflog` 显示 HEAD `ab441a24` 自 2026-09-21 06:51:14+0800（=22:51Z）起未变，`git status` 无跟踪改动。红色之后立刻复跑：25 次循环 + 15 次循环 + 6 次 + 11 次 + 若干单次，合计 50+ 次全绿（每轮 `fail 0`），读数稳定在 `__REALDATA__ total=497 hidden=463 visible=34`、`__REALDATA_ANTIFAKE__ newest page hidden=1 visible=4`。

结论：判据的判定不是被测代码的函数——同一棵树、同一判据，几十分钟内 pass→fail→pass。作为 AC 的仪器，它现在既不能证真也不能证假。

### 上一版判据为什么没兜住（三个具体缺陷，均已实测）

1. **被测对象是一只活的、正在被写的库。** `lsof ~/.cloudcli/auth.db` 显示 `node … server/index.ts`（pid 3808481，本仓库的 dev server）以 fd 32u 持有该文件；在本判据一次都不跑的空转下，其 mtime 每几秒就推进（实测 10:18:14 推进到 :23、:26、:38）。判据每轮 `copyFile` 的正是这个热文件。
2. **快照不是一致点。** 复制只带 `-wal`/`-shm` 两个 sidecar，独独不带 `-journal`；而该库的 `journal_mode` 实测为 `delete`，回滚日志的 sidecar 恰好就是 `auth.db-journal`。写者在提交途中被复制时，副本可能撕成半个事务。我们做过压力验证：在活库被真实写者持续写的同时复制 21012 次，`pragma integrity_check` 0 次报错——所以这是一条**潜在**缺陷而不是本轮红的确证成因；但判据不该把自己的成败押在这种竞态上，所以本任务要把它去掉。
3. **断言读的是活库的「最近窗口」，不是机制。** `hiddenOnNewestPage > 0`（`'the newest real page holds no auto session, so this project no longer needs the rule'`）断言的是 `ORDER BY datetime(COALESCE(updated_at, created_at)) DESC` 下前 5 行（`server/modules/database/repositories/sessions.db.ts` 的 `getSessionsByProjectPathPage`）里有没有自动会话——即「这台机器最近被碰过的是哪几条」。实测余量只有一行（`hidden=1 visible=4`），而挤掉这一行的正是人在这个项目里真实产生的会话。标题搜索那条同理：`matchesRule`（活搜索返回的 title）与 `isHidden`（副本的 custom_name）跨两个数据源比较。

### 失败还是不可归因的（这条是本轮必须自己重新推导的原因）

`runAcceptance` 只把一段有界 stderr 折进 gate reason（`packages/quay/src/gate/acceptance-runner.ts`），而开头约 400 字符被 node 的 `NO_COLOR`/`FORCE_COLOR` 警告吃掉：02:13:52Z 那条 reason 记的是 `… [truncated, 497 chars of stderr omitted]`，**没有任何断言文本**。是「哪条断言红了」至今无据可查——下一个 worker 也是从零重推。这是判据自身的缺陷：一次红必须留下能读的原因。

### 方案

1. 快照换成 SQLite 自己给出的一致点：以只读方式打开真实库，走 backup API / `VACUUM INTO` 产出副本，不再 `copyFile` 活文件，也不再依赖「恰好有哪个 sidecar」。库不存在时仍 fail closed。
2. 去掉依赖活库近因/改名状态的断言：把「客户端侧过滤会把自动会话摆上首页」这条证据改为从副本自身排序里构造（在副本自己的顺序里定位一个 hidden 与 visible 同页的 offset，再翻到那一页断言），而不是断言「当下前 5 行恰好是混合的」；标题搜索的前置同样从副本导出，不与活搜索的返回耦合。
3. 任何失败都把一行自述原因（`__REALDATA_FAIL__ <哪条前置/断言 + 当时读数>`）**作为 stderr 的第一行**打出来，让被截断的 gate 摘录仍能指认成因；既有 `__REALDATA__` 读数保留。
4. 不靠删断言变绿：三条读取路径（分页 / 最近会话聚合 / 标题搜索）、`includeHidden`、`keepSessionIds`、重开连接后规则仍在、「不多不少」这六类断言在改动后逐条仍在。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/session-filter-realdata.test.ts` 退出码 0；且同一条命令**连跑 30 次**（不间断、同一棵树）30 次全部退出码 0、每次 `fail 0`，完成记录里写明连跑次数与至少 3 次的完整读数行。
- [x] 快照是一致点而非活文件拷贝：`grep -c 'copyFile' server/modules/projects/tests/session-filter-realdata.test.ts` 为 0，且文件里对真实库是只读打开（`mode=ro` 或等价）后取快照；真实库的 `projects.session_filter` 在判据跑完后仍与跑前一致（原库未被写入）。
- [x] 没有任何断言的成立依赖活库的 `updated_at` 近因窗：把副本改成「前 5 行全是真人会话」的形态（用副本外的前置构造）后判据仍退出码 0；改动前同形态必红（两条输出都记进完成记录）。
- [x] 失败可归因：`HOME=/tmp/empty-home npx tsx --tsconfig server/tsconfig.json --test <判据文件>` 退出码非 0，且它的**第一条非 node 警告的 stderr 行**是 `__REALDATA_FAIL__` 开头的一行、点名未满足的前置（`real store unavailable …`）；输出记进完成记录。断言失败路径同样要先打这一行。
- [x] 抗假形态仍然为红（两条都真跑并留输出、跑完 revert、`git status` 干净）：(a) 把过滤搬到客户端（分页后再过滤）⇒ total/hasMore 断言红；(b) 去掉 `keepSessionIds` ⇒ 运行中会话可见性断言红。
- [x] 断言未被删弱：完成记录里逐条点名分页 / 最近会话聚合 / 标题搜索 / `includeHidden` / `keepSessionIds` / 重开连接持久 / 可见集「不多不少」七条仍在，且能指出各自在文件中的断言位置。
- [x] `npx oxlint server/` 与 `npm run typecheck` 退出码 0。

## DoD

判据的判定必须是过滤机制的函数，而不是这台机器当下数据的函数：同一棵树上连跑 30 次全绿（读数留档），并且一次刻意的失败在 gate 账本被截断的摘录里就能读出成因（`__REALDATA_FAIL__` 首行）。把机制改坏（客户端侧过滤 / 去掉 `keepSessionIds`）仍必须让它变红——不能变红的判据不是判据。整轮真实库只读：跑完后原库 `projects.session_filter` 不变。

该轴仍暗，理由：本轮判据的对象是判据这颗仪器是否可信，不涉及能力面的行为判据。

## Touches

- server/modules/projects/tests/session-filter-realdata.test.ts
- tasks/gap-session-filter-realdata-criterion-determinism.md
