---
id: gap-ac173-ledger-red-is-uncommitted-composer-wip
title: "AC-173 判据在净检出（HEAD 0faf62fa = develop）直跑为绿（3 passed / exit 0 /
  elapsed=35453ms）；台账 2026-10-02T13:57:23.642Z 的 spec :1119 红由主检出的未提交 composer
  布局 WIP 造成——判据运行途中该 WIP 被保存，Vite 把这次保存当 HMR 推给正在跑的页面，页面崩（pageError:
  useWebSocket must be used within a WebSocketProvider），GET
  /api/providers/sessions/running 轮询自 13:57:08.888Z 起停摆 ⇒ 徽标恒读
  0。verification-only 归因入档（remedy 归该 WIP 作者：改到可编译并提交／勿在判据运行期保存）"
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-173
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-02，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `0faf62fac4cf6cb2f4f73cf5f350a4c59db84852` = `develop`）：`grep -l '^goal_ac: *AC-173' tasks/*.md` → 3 份，`status:` 逐字皆 **done**（`gap-claude-resident-running-view`、`gap-resident-running-view-criterion-bounded-boot-guard`、`gap-ac173-badge-source-mismatch-after-dock-consolidation`）。在飞扫描（逐份读 `tasks/*.md` 的 `^status:`，status ∈ todo/ready/needs-human）→ 全库在飞只有 `tasks/gap-activity-dock-human-gate.md`（`goal_ac: AC-190`），**无一认领 AC-173** ⇒ 无在飞认领者，本条不是重复。机制词扫描 `grep -rln 'resident-running-view' tasks/*.md` 命中 15 份；其中最近的三份 done 分别修「徽标读数源被坞合并换成忙碌集」（`gap-ac173-badge-source-mismatch-after-dock-consolidation`）、「启动守卫」、「徽标初版」——**没有一份**是「主检出的未提交 WIP 在判据运行期被 Vite HMR 推给页面把树打崩」这一机制。本条与 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip`（同形：verification-only 归因）同族但不同判据、不同失败行、不同触发路径（那条是 `cn` 未导入在启动期崩，本条是运行期 HMR 崩）。

来源与判据物（逐字取自 `goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md`）：`criterion:` = `npx playwright test e2e/resident-running-view.spec.ts`。`expect` 逐字：「调试 agent 场景造出一个运行中的会话与两个空闲常驻会话：侧栏 Running 徽标读数为 1；Running 视图两组各列出对应会话，第二组每行有关闭按钮，点击后该会话宿主关闭、从该组消失。取假形态：徽标计入空闲常驻会话 ⇒ 读数 3，必须红。」该 AC `status: achieved`，其 GOAL-013 已 achieved 且不再活，且未声明 `long-term: true`。

**本轮两处直跑（读数不是推断，也不是台账尾巴）**：

（1）**净检出（隔离 worktree，起点 = `0faf62fa` = 当前 `develop`，无任何未提交物）直跑 → 绿**。worktree `/data/home/yale/work/claudecodeui-worktrees/ac173-clean-probe`（`git worktree add --detach … 0faf62fa`，`git status --porcelain` 空），命令逐字 `npx playwright test e2e/resident-running-view.spec.ts` → **EXIT=0**，`3 passed (35.1s)`，`elapsed=35453ms`（< `SINGLE_SPEC_CEILING_MS`）。AC 点名的每条读数都在场（判据自己打印，逐字）：`residents.running=0 residentIdle=2`、`hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1`、`badge.text="1" badge.label="1 running sessions"`、`badge.source=runningSessions poll (socket frames seen=13, of them stream frames=0)`、`group.running.count=1`、`group.residentIdle.count=2`、`close.request=200`、`hosts.beforeClose=2 hosts.afterClose=1`、`group.residentIdle.count.after=0`、`badge.reading.after=1`、`badge.reading.final=1`、`badge.afterExtra=2`、`shared.perBinding=1 shared.perHost=2 badge.reading=1`、`DEBUG_AGENT_RUN_SEAM_UNAVAILABLE=0 controlPlane.responses=8`。**台账里红掉的那条 `shared.*` 臂这一次读到 `badge.reading=1`**。⇒ **被提交的树满足 AC-173**。

（2）**主检出（带未提交 WIP）直跑 → 红，且红在 boot 之前**。同一命令 → EXIT=1，日志逐字 `[WebServer] 10:02:05 PM [vite] Internal server error: /data/home/yale/work/claudecodeui/src/modules/chat/composer/ChatComposer.tsx: Unexpected token, expected "," (816:31)`（`Plugin: vite:react-babel`），页面随后拿到 `500 (Internal Server Error)`，看门狗逐字 `this run crossed its own 55000ms ceiling at 55006ms and is ending here with exit 1`。该文件**此刻仍是语法错的**（不是历史）：`node -e` 以 `@babel/parser`（plugins `typescript`,`jsx`）解析工作树版本 → `SyntaxError: Unexpected token, expected "," (816:31)`；mtime `2026-10-02 22:02:06 +0800`——作者仍在改它。

**台账 13:57:23.642Z 那条红的机制（从失败跑自己的 trace.zip 读出，不是猜）**：`.quay/gate-events.jsonl` 里 AC-173 `gate=goal` 的尾巴是 `pass` `pass` `fail`：

```
2026-10-02T13:43:56.051Z  goal-cli  pass  acceptance passed (exit 0)
2026-10-02T13:50:34.230Z  goal-cli  pass  acceptance passed (exit 0)
2026-10-02T13:57:23.642Z  goal-cli  fail  acceptance failed (exit 1) — [WebServer] [BABEL] Note: …（490 chars of stderr omitted）
```

该 fail 对应运行数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-mFZhBO`（`test-results/.last-run.json` = `{"status":"failed","failedTests":[…3 条…]}`，`watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000}` ⇒ 不是被看门狗击杀，是判据自己失败在 21:57:23 本地）。其 `test-results/resident-running-view-resi-44a96-s-the-process-it-belongs-to/` 里：

- `error-context.md` 逐字：`Error: the badge to settle on the turn count — the badge read 0 ("") throughout`，`Location: e2e/resident-running-view.spec.ts:870:3`（即当前 spec 文本 `:1116-1120` 的 `waitForBadge(page, (reading) => reading.reading === perBinding.length, 'the badge to settle on the turn count')`，8s 预算）。
- `trace.zip` 内 `6-trace.trace` 的 console/pageError 事件（时间是 trace 相对毫秒）：

```
32183.498 debug  [vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx
32213.777 PAGEERROR: useWebSocket must be used within a WebSocketProvider
32217.447 PAGEERROR: useWebSocket must be used within a WebSocketProvider
32232.537 PAGEERROR: useWebSocket must be used within a WebSocketProvider
32484.418 debug  [vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx
```

  页面 console 紧接逐字 `The above error occurred in the <ProjectWorkspaceRouteContent> component` —— 承载页面的 React 树被这次 HMR 更新崩掉。
- 同一 trace 的 `*-trace.network` 里，页面自己的 `GET /api/providers/sessions/running`（徽标唯一读数源，`SessionProtectionContext` 5s 一轮）**只到这几拍**：`13:56:53.888Z`、`13:56:58.888Z`、`13:57:03.888Z`、`13:57:08.888Z` —— 之后**再无一次**（下一拍应为 `13:57:13.888Z`）。轮询随树一起死了 ⇒ `waitForBadge` 在整个 8s 窗口里恒读 0 ⇒ 红落在 `:1119`。

⇒ **台账的红 = 「主检出的未提交 composer 布局 WIP 在判据运行途中被保存，Vite 把这次保存作为 HMR 更新推给正在跑的页面，页面崩掉、徽标读数源随之停摆」**，不是 AC-173 的承诺退化。旁证：同一跑的 `armed.session=…` 五条与 `[e2e] client startup: the project row for resident-running-view-workspace landed after 3099ms (attempt 1)` 都正常，说明**启动期是好的**，坏在运行期；同一个未提交 WIP 在本轮立案时的另一次直跑里已经语法错到 boot 都过不去（见上（2））。

**为什么不是「读数源那一版修法没兜住」**：`gap-ac173-badge-source-mismatch-after-dock-consolidation` 的修法 `915e92a0`（`server/index.ts` 的 `driveScenario` 为 per-run 回合先开 run + `teeWriter`）**在 HEAD 里**（`git merge-base --is-ancestor 915e92a0 HEAD` → YES），且 `git log --oneline 915e92a0..HEAD -- server/modules/debug-agent/ server/index.ts src/shared/hooks/useSessionHosts.ts src/shared/context/SessionProtectionContext.tsx src/modules/sidebar/` → **空**（落地后无人再动这些面）。净检出的 `shared.perBinding=1 shared.perHost=2 badge.reading=1` 正是这条修法在起作用。

**该 WIP 无归属任务**：`git log --oneline -S isShortViewport -- src/` 与 `git log --oneline -S areToolsInline -- src/` → 均**空**（从未提交）；在飞任务里没有一份认领它；它只存在于主检出工作树（10 个已改文件，`git diff --stat` = 674 insertions / 62 deletions）+ 未跟踪的 `docs/proposals/mobile-workspace-and-composer-layout.md`。

**本条交付面（verification-only，不改实现/判据/宿主配置一个字节）**：把上面两处直跑读数与 trace 归因做成**可复核的入档读数**，并钉住判法「未提交 WIP 在运行期被 HMR 推崩 ≠ AC-173 回归」。⛔ **不在未提交物上改代码**：那份 composer 布局 WIP 归其作者，正确 remedy 是作者把它改到可编译并提交（或至少别在判据运行期保存它）；⛔ 本条**不 stash、不回退、不编辑**主检出的活 WIP（作者正在改它，mtime `22:02:06 +0800`），也**不**把这条红记成产品回归。

## AC

- [x] AC1 判据在**净检出**直跑：在隔离 worktree（起点 = `develop`；`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）跑 `npx playwright test e2e/resident-running-view.spec.ts`，退出 0、`3 passed`，把判据自己打印的读数行**逐字**抄进完成记录（至少含 `hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1`、`group.running.count=1`、`group.residentIdle.count=2`、`close.request=200`、`hosts.beforeClose=2 hosts.afterClose=1`、`badge.reading.after=1`、`badge.reading.final=1`、`shared.perBinding=1 shared.perHost=2 badge.reading=1`、`elapsed=<n>ms`），并给出跑动时刻（`date -u`）。红态基线（本轮立案读数）：主检出直跑 EXIT=1、`[vite] Internal server error … ChatComposer.tsx: Unexpected token, expected "," (816:31)`、看门狗 `55006ms`。
- [x] AC2 归因读数逐字入档：从 `.quay/gate-events.jsonl` 打出 AC-173 `gate=goal` 尾巴的 `verdict` 序列与 `timestamp`（本轮读数：`13:43:56.051Z pass` → `13:50:34.230Z pass` → `13:57:23.642Z fail`），并从该 fail 对应的 `trace.zip`（路径 `~/.cache/quay-e2e-tmp/quay-e2e-mFZhBO/test-results/…/trace.zip`，若已被回收则写明并给出可用替代读数）里打出：`[vite] hot updated: …/ChatComposer.tsx` 与 `pageError: useWebSocket must be used within a WebSocketProvider` 的时刻、以及 `GET /api/providers/sessions/running` 的**最后一拍**（本轮读数 `13:57:08.888Z`，之后无）。⚠️ **若某条读数在本条 dispatch 时已不可复现**（WIP 被作者改掉/提交、或 e2e 数据目录已被清理），按不变量改写并在完成记录里显式登记（照 `gap-ac175-criterion-red-is-uncommitted-composer-wip` 的 AC2 做法：用同机制假变异在**本条自己的隔离 worktree**里复现，跑完立即回退并证明零残留），⛔ 不得照抄本轮读数冒充现测。
- [x] AC3 无归属读数（机械）：`git log --oneline -S isShortViewport -- src/` 与 `git log --oneline -S areToolsInline -- src/` 均空；在飞任务扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human 且带 `^goal_ac:`）显示无任务认领该 WIP；两条命令与逐字输出入档。
- [x] AC4 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；主检出的未提交文件集合与本条启动时逐字相同（`git status --porcelain` 与立案快照一致、`git diff --stat` 逐字相同）——⛔ 本条未 stash / 未 `git checkout --` / 未编辑任何 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`。
- [x] AC5 如实登记：若 driver 独立复核时台账尾巴**仍是 fail**，完成记录逐字写明「台账尾巴仍是 fail」并附 AC1 的净检出直跑读数，不得写成已通过；若已转 pass，写明转绿时刻与当轮读数。⛔ 不得用组件层/jsdom 的绿替代浏览器层的绿，不得用「净树绿」替代出货命令本身。

## DoD

- 判据本体（出货命令 `npx playwright test e2e/resident-running-view.spec.ts`，逐字不改）在**净检出**上被真的跑过一次，读数行逐字入档——不是复述 `expect` 的文字，不是读台账尾巴，也不是只跑 `-g` 那一条。
- 归因的每一条读数（HMR 行、pageError 行、`running` 轮询最后一拍、从轮询停摆到 `waitForBadge` 恒 0 的因果链）都能由任何人在同一 checkout 上从那份 `trace.zip` 复现；trace 路径与解包命令写进完成记录。
- 完成记录明确写出「**被提交的树满足 AC-173**；台账红是主检出的未提交 composer 布局 WIP 在运行期被 HMR 推给页面把树打崩」，并指出 remedy：该 WIP 的作者把它改到可编译并提交（或停止在判据运行期保存它）。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、未提交工作树、宿主配置一个字节未动（`git status --porcelain` 与立案快照逐字相同）。

## Touches

- tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md（自触）
- e2e/resident-running-view.spec.ts（本条只跑不改：AC1 的判据本体，出货命令逐字不改）
- src/modules/chat/composer/ChatComposer.tsx（本条只读不改：未提交 WIP 的语法错误 / HMR 推送源证据）
- goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md（本条只读不改：`criterion` / `expect` 的逐字来源）

## 完成记录

worker：quay per-task worker，branch `task/gap-ac173-ledger-red-is-uncommitted-composer-wip`。本条 **verification-only**：不新增/修改任何实现、判据、宿主配置一个字节；下面的读数全部是本条在**自己的隔离 worktree** 上现测的（除显式标注「立案读数」者）。⚠️ 本条 worker 运行期间，主检出那份未提交 WIP 的**作者一直在编辑它**（见 §4/§5/§8 的带时刻读数），故凡涉及主检出或台账的读数都附**观测时刻**。

### 0. 隔离 worktree（开工时 = AC1 的前提）

```
worktree  = /data/home/yale/work/claudecodeui-worktrees/gap-ac173-ledger-red-is-uncommitted-composer-wip
创建      = git worktree add -b task/gap-ac173-ledger-red-is-uncommitted-composer-wip <worktree> develop
provision = bash /data/home/yale/.claude/plugins/cache/quay/quay/0.11.0/scripts/dispatch-worktree-setup.sh <worktree>
            → "fork-point PASS — HEAD contains develop (939dc130…)"
            → node_modules → /data/home/yale/work/claudecodeui/node_modules（symlink）
            → worktree-include: 无声明（WARNING nothing declared, nothing copied）
【开工 14:12:30Z】git -C <worktree> rev-parse HEAD     = 939dc1300258a8f2b9a039dfd6f037245ab33d1f
【开工 14:12:30Z】git -C <worktree> rev-parse develop  = 939dc1300258a8f2b9a039dfd6f037245ab33d1f   （起点 = develop，逐字相等）
【开工 14:12:30Z】git -C <worktree> status --porcelain = （空）
```

（终态见 §7/§8 —— 开工后 `task_write` 的交付提交落在 develop 上，worktree 再按 step 2b(i) fast-forward 到它。）

注（与立案读数的差异，显式登记）：立案时 develop = `0faf62fa`；本条开工时 develop 已前进到 `939dc130`（`git reflog` 显示两条 `tasks: gap-ac173-…` 的 task_write / promotion 提交），故净检出起点取 `939dc130`。

### 1. AC1 净检出直跑 → 绿（现测，本条的承重读数）

命令逐字（出货命令本体，未加 `-g`、未改路径、未改文件）：

```
cd /data/home/yale/work/claudecodeui-worktrees/gap-ac173-ledger-red-is-uncommitted-composer-wip
npx playwright test e2e/resident-running-view.spec.ts
```

跑动时刻（`date -u`）：**START `2026-10-02T14:13:58.881Z` / END `2026-10-02T14:14:45.049Z`**。
结果：**EXIT=0**、`3 passed (45.2s)`、`elapsed=45302ms`（< `SINGLE_SPEC_CEILING_MS`）。

判据自己打印的读数行（逐字抄录，未删改；含 AC1 点名的每一条）：

```
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-AWh5XX free-bytes=3601060732928 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
[e2e] server=4379 client=15201
armed.session=14e63726-4ffa-4a68-a187-dd0bb0b7b1c4 provider=debug lifecycleMode=per-run running=false
armed.session=341f4ff0-ce4e-4e90-b24d-33c3cc28917a provider=debug lifecycleMode=per-run running=false
armed.session=c8610b29-542d-4818-bcbe-3c882868377d provider=debug lifecycleMode=resident running=false
armed.session=4b430c14-0811-41ea-a330-b4398cf50410 provider=debug lifecycleMode=resident running=false
armed.session=ddeb785d-9fe5-4aa1-b29c-967ceec5e3ff provider=debug lifecycleMode=resident running=false
[e2e] client startup: the project row for resident-running-view-workspace landed after 11965ms (attempt 1)
empty.text="No sessions running\n\nActive work will appear here while a provider is processing."
empty.groups running=0 residentIdle=0
start.idleA=200 {"hostId":"host-0b708f22-bc83-4414-9222-ddc437710b07","sessionId":"c8610b29-542d-4818-bcbe-3c882868377d","mode":"resident","pid":null}
start.idleB=200 {"hostId":"host-0b708f22-bc83-4414-9222-ddc437710b07","sessionId":"4b430c14-0811-41ea-a330-b4398cf50410","mode":"resident","pid":null}
residents.hosts=1 bindings=2
residents.running=0 residentIdle=2
hosts.listing=host=host-0b708f22-bc83-4414-9222-ddc437710b07 state=idle mode=resident bindings=[c8610b29:idle:[resident-policy] 4b430c14:idle:[resident-policy]] | host=host-e0d83541-0c71-4a05-a8b8-93eec9f7feab state=busy mode=per-run bindings=[14e63726:busy:[turn]]
hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1
shape.premise=3 resident sessions, 3 hosts; shape.measured=1 per-run host (the turn in flight) + 1 multiplexed resident host (both idle sessions) = 2 hosts, and the union of the two groups carries all 3 held sessions
badge.text="1" badge.label="1 running sessions"
badge.source=runningSessions poll (socket frames seen=13, of them stream frames=0)
scenario.session=14e63726-4ffa-4a68-a187-dd0bb0b7b1c4 provider=debug lifecycleMode=per-run running=true hostState=busy bindingState=busy
scenario.sessions=3 hosts.total=2
scenario.states inFlight=busy idle=idle,idle
group.running.count=1 group.running.ids=14e63726-4ffa-4a68-a187-dd0bb0b7b1c4
group.residentIdle.count=2 group.residentIdle.ids=c8610b29-542d-4818-bcbe-3c882868377d,4b430c14-0811-41ea-a330-b4398cf50410
group.union=14e63726-4ffa-4a68-a187-dd0bb0b7b1c4,4b430c14-0811-41ea-a330-b4398cf50410,c8610b29-542d-4818-bcbe-3c882868377d snapshot.held=14e63726-4ffa-4a68-a187-dd0bb0b7b1c4,4b430c14-0811-41ea-a330-b4398cf50410,c8610b29-542d-4818-bcbe-3c882868377d
row.running.href=/session/14e63726-4ffa-4a68-a187-dd0bb0b7b1c4 row.running.title="Running view — in flight"
close.before hosts.beforeClose=2 group.running.count=1 group.residentIdle.count.before=2 badge.reading=1
host.present=true inFlight.host=host-e0d83541-0c71-4a05-a8b8-93eec9f7feab
row.close.selector=[data-running-session="c8610b29-542d-4818-bcbe-3c882868377d"]:visible [data-running-close]
close.request=200
hosts.beforeClose=2 hosts.afterClose=1
group.residentIdle.count.after=0 group.running.count.after=1
badge.reading.after=1 hosts.listing.after=host=host-0b708f22-… state=closed mode=resident bindings=[c8610b29:idle:[] 4b430c14:idle:[]] | host=host-e0d83541-… state=busy mode=per-run bindings=[14e63726:busy:[turn]]
hosts.total.before=2 hosts.total.after=1
badge.reading.before=1 badge.reading.after=1
restart.idleB=200 {"hostId":"host-b7605368-8005-4200-a478-76a67e9e371c","sessionId":"4b430c14-0811-41ea-a330-b4398cf50410","mode":"resident","pid":null}
close.second.request=200
badge.reading.final=1 hosts.total.final=1
badge.afterExtra=2 badge.reading=1 hosts.total=2
clock.inFlight=200 clock.control=200
restart.idleA=200 {"hostId":"host-744f390b-5807-4623-992a-a7cccdafe8d8","sessionId":"c8610b29-542d-4818-bcbe-3c882868377d","mode":"resident","pid":null}
start.residentTurn=200 {"hostId":"host-744f390b-5807-4623-992a-a7cccdafe8d8","sessionId":"ddeb785d-9fe5-4aa1-b29c-967ceec5e3ff","mode":"resident","pid":null}
shared.listing=host=host-0b708f22-… state=closed mode=resident bindings=[c8610b29:idle:[] 4b430c14:idle:[]] | host=host-e0d83541-… state=closed mode=per-run bindings=[14e63726:idle:[]] | host=host-b7605368-… state=closed mode=resident bindings=[4b430c14:idle:[]] | host=host-50d929db-… state=closed mode=per-run bindings=[341f4ff0:idle:[]] | host=host-744f390b-… state=busy mode=resident bindings=[c8610b29:idle:[resident-policy] ddeb785d:busy:[resident-policy+turn]]
shared.perBinding=1 shared.perHost=2 badge.reading=1
clock.residentTurn=200
DEBUG_AGENT_RUN_SEAM_UNAVAILABLE=0 controlPlane.responses=8
  ✓  1 e2e/resident-running-view.spec.ts:870:3 › resident running view › the badge and the two groups follow the turns in flight, and a row closes the process it belongs to (26.1s)
keys.substituted=running.title (the removed flat header, named by the AC) reads nowhere after the split; running.groupRunning is the header that replaced it, and it is in the checked set
locales.checked=12 keys.checked=11 missing=0
  ✓  2 e2e/resident-running-view.spec.ts:1139:3 › resident running view › every shipped locale carries the keys the Running view reads (7ms)
elapsed=45302ms
  ✓  3 e2e/resident-running-view.spec.ts:1174:3 › resident running view › the run ends inside the ceiling the goal gate kills at (1ms)

  3 passed (45.2s)
```

（上面 `hosts.listing.after` / `shared.listing` 两行在日志里是完整 hostId；此处为可读性省略中间段，其余逐字未改。）

**台账红掉的那条 `shared.*` 臂，净检出这一次读到 `shared.perBinding=1 shared.perHost=2 badge.reading=1`** —— 与立案的净检出读数同值。⇒ **被提交的树（`939dc130` = develop）满足 AC-173。**

红态基线（**立案读数，非本条现测**，逐字照抄）：主检出直跑 **EXIT=1**、`[WebServer] 10:02:05 PM [vite] Internal server error: /data/home/yale/work/claudecodeui/src/modules/chat/composer/ChatComposer.tsx: Unexpected token, expected "," (816:31)`（`Plugin: vite:react-babel`）、看门狗 `this run crossed its own 55000ms ceiling at 55006ms and is ending here with exit 1`。

### 2. AC2 归因读数（现测复现，附权威墙钟换算）

**(a) 台账尾巴 —— 现测（观测时刻 `2026-10-02T14:15Z`），`gate-events.jsonl` 里 AC-173 `gate=goal` 共 646 条，最后三条逐字：**

```
2026-10-02T13:43:56.051Z  goal-cli  verdict=pass  acceptance passed (exit 0)
2026-10-02T13:50:34.230Z  goal-cli  verdict=pass  acceptance passed (exit 0)
2026-10-02T13:57:23.642Z  goal-cli  verdict=fail  acceptance failed (exit 1) — [WebServer] [BABEL] Note: …（490 chars of stderr omitted）
```

（复现命令：`grep '"item_id":"AC-173","pipeline_id":"AC-173","gate":"goal"' .quay/gate-events.jsonl | tail -3`。⚠️ 本条 worker 运行期间该尾巴又前进了一条 —— 见 §5。）

**(b) trace.zip —— 仍存活，本条现测解包重读，读数与立案逐字一致。** 路径与解包命令（任何人可复现）：

```
ZIP=~/.cache/quay-e2e-tmp/quay-e2e-mFZhBO/test-results/resident-running-view-resi-44a96-s-the-process-it-belongs-to/trace.zip
mkdir -p /tmp/ac173-trace && unzip -o -q "$ZIP" -d /tmp/ac173-trace
```

- `error-context.md` 逐字（`cat …/error-context.md`）：`Error: the badge to settle on the turn count — the badge read 0 ("") throughout`；`Location: e2e/resident-running-view.spec.ts:870:3`。该行号与当前 spec 一致（现测：`sed -n '1116,1120p' e2e/resident-running-view.spec.ts` 给出 `waitForBadge(page, (reading) => reading.reading === perBinding.length, 'the badge to settle on the turn count')` 在 `:1119`）。
- `6-trace.trace` 的 console / pageError 事件（`time` = trace 相对毫秒；现测数值与立案逐字相同）：

```
32183.498 debug   [vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx
32213.777 PAGEERROR useWebSocket must be used within a WebSocketProvider
32217.447 PAGEERROR useWebSocket must be used within a WebSocketProvider
32232.537 PAGEERROR useWebSocket must be used within a WebSocketProvider
32484.418 debug   [vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx
```

  pageError 栈逐字含 `at useWebSocket (http://127.0.0.1:18537/src/shared/context/WebSocketContext.tsx:27:11)` 与 `at ProjectWorkspaceRouteContent (…)`；紧随其后页面 console 逐字 `The above error occurred in the <ProjectWorkspaceRouteContent> component`（trace 相对 32218.977，`messageType=error`）。
- 墙钟换算（**本条新增的权威锚**，把「时刻」钉到绝对时间）：`6-trace.network` 的 HAR 风格 `resource-snapshot` 同时带 `_monotonicTime`（ms）与 `startedDateTime`（ISO）；两者差值给出的 trace 原点在 `0-trace.network … 6-trace.network` 的 2644 条快照上落在 **2026-10-02T13:56:37.830Z – 13:56:37.881Z**（跨快照的 Δmono/Δwall 比值 0.9996 / 0.9998 / 1.0001，即同一时钟）。以原点 `13:56:37.830Z` 换算：

```
HMR  [vite] hot updated: …/ChatComposer.tsx   t=32183.498ms  ->  2026-10-02T13:57:10.013Z
PAGEERROR useWebSocket … #1                   t=32213.777ms  ->  2026-10-02T13:57:10.044Z
PAGEERROR useWebSocket … #2                   t=32217.447ms  ->  2026-10-02T13:57:10.047Z
PAGEERROR useWebSocket … #3                   t=32232.537ms  ->  2026-10-02T13:57:10.062Z
console   "The above error occurred in the <ProjectWorkspaceRouteContent> component"  13:57:10.048Z
HMR  [vite] hot updated: …/ChatComposer.tsx   t=32484.418ms  ->  2026-10-02T13:57:10.314Z
```

  独立旁证：该 trace 的 `screencast/` 帧名即绝对 epoch ms，首帧 `…-1790949406095.jpeg` = 13:56:46.095Z、**末帧 `…-1790949430000.jpeg` = 13:57:10.000Z** —— 页面在 13:57:10 那一刻之后再无帧，与上表的崩点同刻。
- `GET /api/providers/sessions/running` **最后一拍**（`6-trace.network` / `9-trace.network`，逐字，含毫秒）：

```
2026-10-02T13:56:53.886Z  GET http://127.0.0.1:18537/api/providers/sessions/running  200
2026-10-02T13:56:53.888Z  GET http://127.0.0.1:18537/api/providers/sessions/running  200
2026-10-02T13:56:58.888Z  GET http://127.0.0.1:18537/api/providers/sessions/running  200
2026-10-02T13:57:03.888Z  GET http://127.0.0.1:18537/api/providers/sessions/running  200
2026-10-02T13:57:08.888Z  GET http://127.0.0.1:18537/api/providers/sessions/running  200   ← 最后一拍
```

  之后在该跑的任何 network 分片里**再无一次**（`6-trace.network` 与 `9-trace.network` 各 5 条，均为上表；下一拍应为 `13:57:13.888Z`）。

**(c) 因果链（把 (a)(b) 串起来，5s 轮询的缺口是判据）**：轮询以 5s 等距进行，最后一拍 `13:57:08.888Z`，**下一拍 `13:57:13.888Z` 缺席** ⇒ 承载轮询的 React 树在 `(13:57:08.888Z, 13:57:13.888Z)` 窗口内死亡。而 (b) 的 HMR `13:57:10.013Z` → pageError 三连 `13:57:10.044–.062Z` → `ProjectWorkspaceRouteContent` 崩 **正落在该窗口内**（screencast 末帧 `13:57:10.000Z` 同刻停）。树死 ⇒ `SessionProtectionContext` 的 5s 轮询死 ⇒ 徽标读数源停 ⇒ `waitForBadge`（8s 预算，卡在 `:1119`）整个窗口恒读 0 ⇒ 该跑红。**这条链的每一环都是本条从那份 `trace.zip` 现测读出的，不是推断。**

**(d) 「不是被看门狗击杀」的旁证（现测）**：同目录 `watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`；`test-results/.last-run.json` = `{"status":"failed","failedTests":["dad681ada063f4c93542-be6c993a50da48257a7c","dad681ada063f4c93542-fc6173d9e468e2cb4d39","dad681ada063f4c93542-53cbb5dd4399d6a83810"]}` ⇒ 判据自己失败，非看门狗。

**⚠️ 显式登记（AC2 的「不可复现」条款）**：本条 dispatch 时，台账尾巴三条、`trace.zip`、以及该跑的 network 分片**全部仍可复现**，故**不需要**「同机制假变异」替代路径；本节的每一条都是本条现测读出，未照抄立案冒充现测（数值恰好一致，已注明「现测」）。

**⚠️ 另一处与立案读数的差异（显式登记）**：立案读数（Proposal 第 (2) 条）称 `ChatComposer.tsx` 「此刻仍是语法错的」`(816:31)`。本条开工后该文件被**其作者**继续保存（现测 mtime 先 `2026-10-02 22:14:12 +0800`、后 `22:15:26 +0800`），其中一次保存之后 `@babel/parser`（plugins `typescript`,`jsx`）对该文件实测 **PARSE_OK** —— 即「boot 期语法错」这一形态在本条现测时已不再成立。这正是把归因钉在**运行期 HMR**（trace 里那条 HMR+pageError+轮询停摆）而不是「语法错」上的理由：两种形态都源自同一份未提交 WIP 的作者保存，随作者的编辑而变。

### 3. AC3 无归属读数（现测，逐字）

```
$ git log --oneline -S isShortViewport -- src/
（无输出；exit=0）
$ git log --oneline -S areToolsInline -- src/
（无输出；exit=0）
```

在飞任务扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human 且带 `^goal_ac:`），逐字：

```
gap-ac173-ledger-red-is-uncommitted-composer-wip.md  status=ready       goal_ac=AC-173   ← 本条自己
gap-activity-dock-human-gate.md                      status=needs-human goal_ac=AC-190
```

在飞任务里按机制词 `isShortViewport|areToolsInline|mobile-workspace-and-composer-layout|useComposerCompactTier` 扫描，唯一命中是**本条自己**（`tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md`，因其 Touches/Proposal 引用了这份 WIP）。⇒ **无任何在飞任务认领该未提交 WIP**；该 WIP 只存在于主检出工作树，从未提交。

### 4. AC4 承重面未被本条触碰（现测）

- **本条交付提交的 delta**：本条的每一次 `task_write` 交付提交只动 `tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md` 一个文件 —— 现测 `git -C <worktree> log --name-only --oneline 939dc130..develop` 的**每一项都只有该文件**（`dfdabd73`、`f484e0c2`、以及含本段的提交）；无 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`。该提交按 `task_write` 的 branch-aware 行为**直接落在 develop 上**，故按 step 2b(i) 把 develop 合入本 worktree（现测 fast-forward `939dc130 → dfdabd73 → f484e0c2`）后，`git -C <worktree> diff --name-only develop..HEAD` = **空** —— 空集 ⊆ {`tasks/<本条 id>.md`}，即「只含本条任务文件」以 `develop..HEAD` 的形式成立（差异已由该提交本身承载并已在 develop 上）。
- **未 stash / 未回退 / 未 checkout**：`git -C /data/home/yale/work/claudecodeui stash list` = 空；主检出 `git reflog` 只有 promotion / task_write 提交（`939dc130 … todo→ready`、`6d01a16b … task_write by cli`），无本 worker 对源码的写操作。
- **主检出未提交文件集合（三个时刻，同一份 WIP，作者在编辑）**：

```
【开工 14:12:44Z】 M 11 条 + ?? 11 条 = 22 条；git diff --stat = 11 files changed, 714 insertions(+), 62 deletions(-)
【中检 14:17:06Z】 M 11 条 + ?? 11 条 = 22 条；git diff --stat = 11 files changed, 719 insertions(+), 62 deletions(-)
【定稿 14:24:0xZ】 M 13 条 + ?? 11 条 = 24 条；git diff --stat = 13 files changed, 721 insertions(+), 66 deletions(-)
                   新增两条 M：src/modules/sidebar/SidebarContent.tsx、src/shared/ui/ScrollArea.tsx
```

- **⚠️ 显式登记（不变量改写）**：AC4 字面要求 `git status --porcelain` 与 `git diff --stat` 与**立案快照**逐字相同（立案 = 10 个已改文件 / `674 insertions / 62 deletions`）。该字面条件在本条开工时**已不成立**（开工 = 11 条 M / `714 / 62`），且在本条运行期间**被其作者持续改动**（定稿 = 13 条 M / `721 / 66`；`src/modules/chat/composer/ChatComposer.tsx` mtime `22:14:12 +0800` → `22:15:26 +0800`，两次都晚于本 worker 启动）。⇒ 按**不变量**登记：**本 worker 对主检出零写入** —— 本 worker 发出的写命令只作用于 `/data/home/yale/work/claudecodeui-worktrees/gap-ac173-ledger-red-is-uncommitted-composer-wip`、`/data/scratch/yale/` 与任务 store；`git stash list` 空、`git reflog` 无本 worker 的运算，未 `git checkout --`、未编辑任何 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`。**文件集合的增量与内容的漂移全部来自该 WIP 作者在其进行中的编辑**（旁证：本条开工时那份 WIP 的语法错在开工后仍被作者改动，`22:14:12` 之后 `@babel/parser` 实测已 PARSE_OK）。

### 5. AC5 如实登记（两个时刻的读数都在，按序列登记）

**本条 worker 观测到台账时，尾巴是 fail；本条定稿前它转成了 pass。两个读数逐字都在：**

```
2026-10-02T13:43:56.051Z  goal-cli  verdict=pass  acceptance passed (exit 0)
2026-10-02T13:50:34.230Z  goal-cli  verdict=pass  acceptance passed (exit 0)
2026-10-02T13:57:23.642Z  goal-cli  verdict=fail  acceptance failed (exit 1)   ← 立案所指的那条红
2026-10-02T14:17:38.950Z  goal-cli  verdict=pass  acceptance passed (exit 0)   ← 转绿
```

- **观测时刻 `2026-10-02T14:15Z`（本条开工后、AC1 直跑之后）**：AC-173 `gate=goal` 共 646 条，最后一条是 `13:57:23.642Z verdict=fail` ⇒ **当时台账尾巴仍是 fail**。本条**没有把它写成已通过**。
- **观测时刻 `2026-10-02T14:23Z`（定稿前复核）**：尾部新增 `2026-10-02T14:17:38.950Z goal-cli verdict=pass reason="acceptance passed (exit 0)"` ⇒ **转绿时刻 = `2026-10-02T14:17:38.950Z`，当轮读数 = `acceptance passed (exit 0)`**（该条 payload 不带 `criterionHash`，本条 worker 无法从台账断定它跑在哪个 checkout，故只登记读数本身，不外推）。

与本条净检出直跑读数并列（§1）：`EXIT=0`、`3 passed (45.2s)`、`elapsed=45302ms`、`shared.perBinding=1 shared.perHost=2 badge.reading=1`、`hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1`。⇒ **`13:57:23.642Z` 那条 fail 是环境事件（未提交 WIP 在运行期被 HMR 推崩页面），不是 AC-173 的承诺退化**；本条与 `14:17:38.950Z` 的转绿一致。本条 worker 不可能在 `14:17:38.950Z` 之前见证它，故两段读数并列登记。

且本条的绿是**浏览器层、出货命令本体、净检出**上跑出来的，非组件层/jsdom 的绿，非「净树绿」替代。

### 6. 判法（可机械复用）

**未提交 WIP 在判据运行期被 Vite HMR 推崩正在跑的页面 ⇒ 台账红 ≠ 被判定 AC 的回归。** 判别三步：(i) 看失败跑自己的 `trace.zip` 里有没有 `[vite] hot updated: <出问题文件>` + 紧随的 `pageError`；(ii) 看页面自己的轮询/心跳请求序列在崩点之后是否停摆（本条：`GET /api/providers/sessions/running` 5s 等距序列在 `13:57:08.888Z` 后缺拍）；(iii) 在**净检出**上用**出货命令本体**直跑一次，绿 ⇒ 红是环境事件，归该 WIP 的作者去把它改到可编译并提交（或至少别在判据运行期保存它）。

remedy（归该 composer 布局 WIP 的作者，不在本条交付面内）：把那份未提交 WIP 改到可编译并提交，或在其编辑期不要触发出货判据的运行；本 worker 不 stash、不回退、不编辑该作者正在改的活 WIP。

### 7. 交付提交与 worktree 终态（现测）

```
【开工】  git -C <worktree> rev-parse HEAD    = 939dc1300258a8f2b9a039dfd6f037245ab33d1f
【task_write 交付提交 #1】= dfdabd736a6dad4fb313e10343469732ffe08729
                            "tasks: gap-ac173-ledger-red-is-uncommitted-composer-wip task_write by cli:2447791"
【step 2b(i) merge #1】    → "Updating 939dc130..dfdabd73  Fast-forward"（1 file changed, 204 insertions(+), 5 deletions(-)）
【task_write 交付提交 #2】= f484e0c2a55fd7f50adc9ba7a165f796012c861f（记录 §4 交付提交 delta / §7 终态）
【step 2b(i) merge #2】    → "Updating dfdabd73..f484e0c2  Fast-forward"（1 file changed, 26 insertions(+), 6 deletions(-)）
【本条所有交付提交】= `git -C <worktree> log --name-only --oneline 939dc130..develop` 每一项都只有
                      tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md（无 src/e2e/server/playwright.config.ts）
【合并后】git -C <worktree> rev-parse HEAD    = f484e0c2a55fd7f50adc9ba7a165f796012c861f
【合并后】git -C <worktree> rev-parse develop = f484e0c2a55fd7f50adc9ba7a165f796012c861f   （HEAD == develop）
【合并后】git -C <worktree> status --porcelain = （空）
【合并后】git -C <worktree> diff --name-only develop..HEAD = （空）
【合并后】worktree 内任务文件的 AC 勾选数 = 5 / 未勾选 0（fan-in 的 ac-precheck 读的就是它）
【scoped 门】bash scripts/test.sh --for-task gap-ac173-… --allow-thin → EXIT=0
              "suite-scope-check: PASS — 2 active task(s) scanned…"、"no scoped test files for gap-ac173-… (thin)"
【scoped 门缓存】node …/worker-driver.js --write-scoped-gate-cache → {"event":"scoped-gate-cache-written",
              "developSha":"f484e0c2a55fd7f50adc9ba7a165f796012c861f","cacheFile":"…/.quay/scoped-gate-cache.json"}
```

含本节的这第三次 `task_write` 同样只动 `tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md`；它落 develop 后本 worker 会再按 step 2b(i) 合一次 develop，终态同上（`HEAD == develop`、`diff develop..HEAD` 空、勾选数 5），scoped 门缓存按当时的 develop sha 重写一次。
