---
id: gap-ac199-criterion-ledger-red-is-silent-e2e-death
title: AC-199 台账尾红是「e2e 运行无测试输出即死」：同树直跑 2×绿（24.3s/24.4s）、watchdog fired:false、同窗
  AC-120/AC-254 同形红 —— verification-only 归因入档，不重实现既有修复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-199
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是复述台账尾巴）。AC-199 记录 `status: achieved`，其 GOAL-015 已 `achieved`、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。

判据物（逐字取自 `goals/AC-199-真实浏览器-从坞里停止任务与把前台工具转后台-状态以事件为准-连接中断时按钮置灰.md` 的 `criterion:`）：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`。其 `expect:` 要求：点击任务停止**不乐观**改状态、事件到达才变 `stopped`；点击前台工具的「转后台」后任务面板随后出现该任务；终态任务不再有停止按钮；经 `page.routeWebSocket` 分区（夹具同 AC-184）后两个按钮都 `disabled` 并带说明；墙钟实测 ≤ 40s；取假形态「点击后立即置 stopped ⇒ 第一条读数必须红」。

**本轮直接现测：判据在净检出上退出 0（产品面成立）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD` = `b9e7c0b3cd04ca69d9de27edac16c7af2a29e8c3`，`git rev-parse HEAD^{tree}` = `3b116bec29ce55904412d81f7564859d78cde5a4`，`git status --short` 无 tracked 修改）直跑两次，均 exit 0：

```
run1: AC-199 wall clock: 24299ms;  1 passed (24.3s)
run2: AC-199 wall clock: 24424ms;  1 passed (24.0s)
```

逐字读数（两跑一致，spec 自己打印）：`ac2.snapshot.status=200 snapshot.tasks=["task-stop-target:running","task-terminal:completed","task-never:running"] dom.tasks=["task-never","task-stop-target"]`；`ac2.stopTarget.state=running`；`ac5.terminalRows=0 liveRows=2 liveStops=2`；`ac3.main click-instant: before=running after=running green=true`；`ac3.settled`（随后事件到达才 `stopped`）；`ac4.idsBeforeBackground=["task-stop-target","task-never"]`；`ac4.backgrounded: bgTask=task-bg state=running toolUseId=<X> foreground=<X>`（逐字相等）；`ac7.falseForm click-instant: before=running after=stopped green=false`；`ac6.partition: dockState=unreachable stopDisabled=true bgDisabled=true reasons=[… ×3]`。⇒ `expect:` 点名的每一条读数都在场，40s 上限实测 24.3s/24.4s。

**为什么台账尾巴读 fail。** `.quay/gate-events.jsonl` 里 AC-199 `gate=goal` 读数共 **189** 条；尾巴逐字：

```
2026-10-05T16:46:09.279Z goal-sweep pass  tree= c9988b7227f962b1d70938059a9a44edcc78326d
2026-10-05T19:52:27.610Z goal-sweep pass  tree= 8340ba9cc2d512b26fbbb39f257ff1029dbd4b6c
2026-10-05T23:07:48.474Z goal-sweep fail  tree= 3b116bec29ce55904412d81f7564859d78cde5a4
2026-10-05T23:11:05.355Z goal-cli   fail  tree= 3b116bec29ce55904412d81f7564859d78cde5a4
```

两条 `fail` 的 `payload.treeSha` 都是 `3b116bec…`，**正是本条直跑为绿的那棵树**（`git rev-parse HEAD^{tree}`）⇒ 不是「另一棵树上的旧红」。且这两条是 `3b116bec` 上**唯一**的 gate 读数（该 tree 没有一次 pass）。

两条 `fail` 的 `payload.reason` 逐字（前段；两条都以 `[truncated, 489 chars of stderr omitted]` 结尾）：

```
acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-inGCF7/vite-cache/deps/react-scan.js?v=… as it exceeds the max of 500KB. [WebServer] (node:218171) [DEP0190] DeprecationWarning: … [WebServer] (Use `node -- … [truncated, 489 chars of stderr omitted]
```

捕获到的 stderr 只有 **webServer 自己转发的 stdout（vite 依赖预打包的一条 Note）**，**没有测试输出、没有 Playwright 的失败报告**。

**指纹：同一「启动即哑」形态在同夜命中了互不共享源文件的其它浏览器判据。** `gate=goal` 在 `2026-10-05T21:00Z–23:30Z` 窗口内（剔除人为红：AC-256 缺文件 / AC-257 缺人工验收行）：

```
2026-10-05T21:24:17.689Z goal-sweep AC-120 fail  一条 BABEL Note，无截断标记（整段 stderr 仅此一行）
2026-10-05T21:54:13.466Z goal-cli   AC-254 fail  同上
2026-10-05T22:14:32.727Z goal-cli   AC-254 fail  同上
2026-10-05T23:07:48.474Z goal-sweep AC-199 fail  同上 + DEP0190
2026-10-05T23:11:05.355Z goal-cli   AC-199 fail  同上 + DEP0190
```

**5 条红 / 3 条互不共享判据文件的 AC**（AC-120 / AC-254 / AC-199，三条连 spec 文件都不同）—— `3 条独立回归`不成立；这是**宿主级运行故障**的指纹（同族判法见 `gap-ac153-ledger-red-is-host-quota` 的 AC3）。

**watchdog 对 AC-199 的两条红 `fired:false`（不是被自己的天花板杀的）。** `playwright.config.ts` 把本次运行的 watchdog 状态写进 `<dataDir>/watchdog-state.json`（`WATCHDOG_STATE_FILE = path.join(dataDir, 'watchdog-state.json')`）。逐字读出（这五个 data dir 仍在 `/data/home/yale/.cache/quay-e2e-tmp/`）：

```
quay-e2e-inGCF7  (AC-199 23:07:48Z 那次): {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
quay-e2e-WY3mdE  (AC-199 23:11:05Z 那次): 同上，fired:false
quay-e2e-YSfbh2  (AC-120 21:24Z 那次):    同上，fired:false
quay-e2e-J8CjkH  (AC-254 21:54Z 那次):    {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55006ms"}
quay-e2e-mvE2AS  (AC-254 22:14Z 那次):    {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55004ms"}
```

⇒ AC-199 与 AC-120 那几次是**运行自己 exit 1**（boot 40s（`BOOT_CEILING_MS`）/ run 55s（`RUN_CEILING_MS`）两个天花板都没到），AC-254 那两次是被 **55s 运行天花板**杀的。两种死法，同一种「无测试输出」的捕获。

**机制（本轮能钉到的程度）。** AC-199 是一次全栈浏览器 e2e（配置求值 + data-dir 选择 + server boot + vite boot + 浏览器启动 + beforeAll + 一个 12.9s 的用例），整条 `npx playwright test` 调用必须在 **40s** 内跑完；安静时 24.3–24.4s，余量约 16s。窗口内宿主 `load1` 9.36–20.3（AC-199 自己 2026-10-04T23:51 的独立复核还记到 `hostFreeBytes=6.47e9`），boot/用例预算被吃光后运行在**产出任何测试输出之前** exit 1。**这不是产品回归**：同一棵树直跑两跑皆绿。

**残留未钉死假设（如实登记，本条必须让 worker 收敛它，或两条都登记）。** 本轮**未**钉死那两次 AC-199 运行的确切死亡点（driver 把 stderr 截在 489 字符，stdout 不在 `reason` 里）。两个候选并存：(i) 用例内的负载敏感计时（spec 的 20s 任务行、15s disabled 读数、30s pane 等等待）在负载下超时；(ii) `3b116bec` 是**第一次携带新落地 voice 模块**的 gate 运行（`server/modules/websocket/services/chat-websocket.service.ts` 新增 `import { voiceLexicon } from '@/modules/voice/index.js'` 与 `dispatchRun` 里的 `voiceLexicon.observeSentText(...)`），并发/磁盘状态下 boot 或首帧慢。⛔ 不得用 (i) 一句「负载」把 (ii) 抹掉。

<!-- dedup-ref --> **机制去重读数（本轮立案实测）。** `grep -rln "^goal_ac: *AC-199" tasks/` 只命中 1 条：`tasks/gap-ac199-dock-stop-background-controls-browser.md`，`status: done`。在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-199`）→ **0 命中** ⇒ 无在飞认领者。那条 done 任务交付的**产品面**（坞控件 + 调试 agent 控制缝 + e2e）在本轮直跑里**成立**（见上面 AC1 读数），所以本条**不是**「再修一次既有实现」，而是台账红尾的归因入档（同族先例 `gap-ac135-criterion-ledger-red-is-merge-race`、`gap-ac153-ledger-red-is-host-quota`、`gap-ac178-criterion-ledger-red-is-merge-race`，皆为 verification-only）。本条**不做**任何实现 / 判据 / 宿主配置改动。

**非目标 / 标准适用性。** 不改 `e2e/activity-dock-background.spec.ts`、`playwright.config.ts`、`src/**`、`server/**`、`goals/**`、`.quay/config.yml`；不重实现 AC-199 的产品面；不在本条内修宿主负载或回收问题。本条不触碰任何 `server/**` 或 `src/**` 的生产代码 ⇒ AGENTS.md 的 `$backend-module-standards` / `$frontend-module-standards` 均不适用。

## Plan

1. 建本条隔离 worktree（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据 ≥2 次（出货命令逐字不改）：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`；逐字抄退出码、墙钟、以及 spec 自己打印的读数行（`ac2.*` / `ac3.*` / `ac4.*` / `ac5.*` / `ac6.*` / `ac7.*` / `AC-199 wall clock`）。
3. 机械复算台账：用 `python3` / `jq` 读 `.quay/gate-events.jsonl`，打印 AC-199 `gate=goal` 总条数、尾部 `verdict` 序列与 `treeSha`，并断言两条 fail 的 `treeSha == git rev-parse HEAD^{tree}`。
4. 机械复算指纹：打印同窗（21:00Z–23:30Z）内 AC-120 / AC-254 / AC-199 的 fail `reason`（逐字），并逐字读出五个 `watchdog-state.json`。
5. 尝试钉死死亡点：在净 worktree 上以**并发负载**（至少再起 2–3 个兄弟 e2e，或人工 `stress`）重复跑判据，记录是否复现红、复现时的失败阶段与捕获输出；查 `dmesg` / cgroup OOM 记录；若不可复现，如实登记两条候选假设与已排除项。
6. 交付只落在 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在净 worktree 直跑 ≥2 次皆 exit **0**，逐字入档墙钟与 spec 读数行（至少 `ac3.main … green=true`、`ac4.backgrounded … toolUseId==foreground`、`ac6.partition … stopDisabled=true bgDisabled=true`、`AC-199 wall clock ≤ 40000`）；给出 worktree 路径、`git rev-parse HEAD` 与 `git rev-parse HEAD^{tree}`。红态基线（本轮立案读数）：两条 fail 的 `treeSha=3b116bec…` 与本条 worktree tree 相等而判据红。
- [x] AC2 台账归因机械入档：用 `python3` 读 `.quay/gate-events.jsonl`，打印 AC-199 `gate=goal` 总条数（本轮 189）、尾部序列（`… pass/c9988b72 → pass/8340ba9c → fail/3b116bec → fail/3b116bec`）、两条 fail 的逐字 `payload.reason`；并断言 `payload.treeSha == git rev-parse HEAD^{tree}`。
- [x] AC3 指纹与 watchdog 机械入档：打印同窗 AC-120（21:24:17.689Z）、AC-254（21:54:13.466Z、22:14:32.727Z）、AC-199（23:07:48.474Z、23:11:05.355Z）五条 fail 的逐字 `reason`，指出其捕获只有 webServer 的 BABEL Note（无测试输出）；逐字打印五个 `watchdog-state.json`，并写明 AC-199 那两次 `fired:false`、AC-254 那两次 `fired:true`（55s 运行天花板）。
- [x] AC4 死亡点钉定**或**两条假设都如实登记：在净 worktree 上做过一次「并发 / 加载下重跑」的复现尝试（记录命令、并发度、是否复现、复现时的阶段与捕获），并检查该窗口的 `dmesg` / OOM 记录；完成记录必须明确写出结论是 (i) 负载敏感计时、(ii) 新 voice 模块的并发敏感 boot、还是「两条都未能排除」，⛔ 不得只写「负载」了事。若判据在净 worktree 上**也红**，停手上报并置 `needs-human`（本条归因不成立）。
- [x] AC5 空 delta：本条对 base 的净改动（排除 `tasks/<本条 id>.md` 自身）为空 —— `git diff --stat <base>..HEAD -- e2e/ playwright.config.ts src/ server/ goals/ .quay/` 打印为空，且 `git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash`、未 `git checkout --`、未编辑任何 `e2e/**`、`playwright.config.ts`、`src/**`、`server/**`、`goals/**`）。
- [x] AC6 判法可复用且如实：完成记录给出可机械复用的判法 —— `gate=goal` 红而捕获只有 webServer 引导输出、无测试输出、且同窗存在**互不共享文件的 AC** 同形红 ⇒ 宿主级运行死，不是「判据假」；并写明 AC-199 的产品保证由本条的**浏览器层**直跑读数钉住（⛔ 不得用 jsdom / 单元层读数替代），以及写完成记录时台账尾巴是否已被 driver 重判为 pass（若无，逐字写明「尾巴仍是 fail」）。

## DoD

- 判据本体（真实浏览器 spec，出货命令逐字不改）在净检出上**真的跑过 ≥2 次**、exit 0，读数行逐字入档 —— 不是复述 `expect:`、不是读台账尾巴。
- 归因段落里每一条读数（台账总条数 / 尾部 / treeSha、同窗五条 fail 的 `reason`、五个 `watchdog-state.json`）都能由任何人在同一 checkout 上用 `python3` / `jq` / `cat` 复现，不依赖本条转述。
- 死亡点结论明确（或两条假设都登记且说明未排除的理由）；若净树直跑为红，本条按 AC4 停手上报，⛔ 不把环境红写成产品绿、不据此改断言。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、`playwright.config.ts`、宿主配置一个字节未动。

## Touches

- `tasks/gap-ac199-criterion-ledger-red-is-silent-e2e-death.md`（自触）
- `e2e/activity-dock-background.spec.ts`（本条只跑不改：判据本体）
- `playwright.config.ts`（本条只读不改：`BOOT_CEILING_MS` / `RUN_CEILING_MS` / `WATCHDOG_STATE_FILE` 读数来源）
- `goals/AC-199-真实浏览器-从坞里停止任务与把前台工具转后台-状态以事件为准-连接中断时按钮置灰.md`（本条只读不改：`criterion:` / `expect:` 逐字来源）

## Evidence

### AC1 — 判据在净 worktree 直跑 ≥2 次皆绿（真实 chromium，浏览器层）

worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac199-criterion-ledger-red-is-silent-e2e-death`（reuse 既有 worktree）。开工快照 `HEAD=8f889899ea04c40358ca93e69dfe7697113b23d9`、`tree=8c370c1400afe808b11e0feda5c3631c7d158cb6`、`git status --porcelain` 空。开工时先 `git merge --no-edit develop`（fast-forward，无冲突）→ `git rev-parse HEAD` = `086a152b09b62c275fcfcc6ee7d80c7bab466fb1`（== 当时的 develop），`git rev-parse HEAD^{tree}` = `c46c04000d5b16e102239fdf552fa69581454f13`。

出货命令逐字不改：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`

```
RUN 1  start 2026-10-06T07:31:26+08:00  EXIT=0  WALL=24375ms
RUN 2  start 2026-10-06T07:31:50+08:00  EXIT=0  WALL=24123ms
```

spec 自印读数（run1 逐字，日志 `/data/home/yale/.cache/ac199-probe/run1.log`）：

```
ac2.snapshot.status=200 snapshot.tasks=["task-stop-target:running","task-terminal:completed","task-never:running"] dom.tasks=["task-never","task-stop-target"] foreground=6cdebefc-130b-4996-baff-bf232f44c5e4
ac2.stopTarget.state=running
ac5.terminalRows=0 liveRows=2 liveStops=2
ac3.main click-instant: before=running after=running green=true
ac4.idsBeforeBackground=["task-stop-target","task-never"]
ac3.settled: the stop event settled the task, and the panel dropped its row
ac4.backgrounded: bgTask=task-bg state=running toolUseId=6cdebefc-130b-4996-baff-bf232f44c5e4 foreground=6cdebefc-130b-4996-baff-bf232f44c5e4
ac7.falseForm click-instant: before=running after=stopped green=false
ac6.partition: dockState=unreachable stopDisabled=true bgDisabled=true reasons=["Stop is unavailable while the server is unreachable","Stop is unavailable while the server is unreachable","Stop is unavailable while the server is unreachable"]
AC-199 wall clock: 23626ms
  1 passed (23.5s)
```

### AC1 续 — 红态基线树直跑（「两条 fail 的 treeSha == worktree tree」在红树上逐字成立）

同一 worktree 内 `git checkout b9e7c0b3cd04ca69d9de27edac16c7af2a29e8c3`（`b9e7c0b3` 是 develop 的祖先；`git rev-parse b9e7c0b3^{tree}` = `3b116bec29ce55904412d81f7564859d78cde5a4` **正是两条 fail 的 `payload.treeSha`**）→ 该 checkout 上 `git rev-parse HEAD^{tree}` = `3b116bec…`。

```
CHECKOUT HEAD=b9e7c0b3cd04ca69d9de27edac16c7af2a29e8c3 TREE=3b116bec29ce55904412d81f7564859d78cde5a4
REDTREE1 EXIT=0 WALL=24124ms
REDTREE2 EXIT=0 WALL=24370ms
```

spec 读数（redtree1/redtree2 逐字）：`ac3.main click-instant: before=running after=running green=true`；`ac4.backgrounded: bgTask=task-bg state=running toolUseId=9c387c5d-88d2-450c-93bb-6605ecab5613 foreground=9c387c5d-88d2-450c-93bb-6605ecab5613`（逐字相等）；`ac6.partition: dockState=unreachable stopDisabled=true bgDisabled=true reasons=[… ×3]`；`ac7.falseForm click-instant: before=running after=stopped green=false`；`AC-199 wall clock: 23345ms`（redtree1）/ `23599ms`（redtree2），均 ≤ 40000。跑完 `git checkout task/gap-ac199-criterion-ledger-red-is-silent-e2e-death` 复原 → `HEAD=086a152b… TREE=c46c0400…`，`git status --porcelain` 空。

⇒ 台账判红的那棵树（`3b116bec`）在净检出上直跑**两跑皆绿**（24.1s / 24.4s）；红是宿主级运行故障，不是产品回归。

### AC2 — 台账归因（机械复算）

快照：`.quay/gate-events.jsonl` **100806** 行，mtime `2026-10-06 07:30:57.998 +0800`。AC-199 的 gate 只有 `goal` 一种，共 **191** 条（立案轮记 189；之后追加 2 条）；verdict 计数 pass=145 / fail=46。

尾部 8 条（`timestamp verdict treeSha actor`）：

```
2026-10-05T10:15:49.795Z pass c3abfc0397c76487911c806547d027c5066f91c2  goal-sweep
2026-10-05T13:21:19.994Z pass 60184fbdb55ad9cc6bd7fbdd097bc1b48e157fd7  goal-sweep
2026-10-05T16:46:09.279Z pass c9988b7227f962b1d70938059a9a44edcc78326d  goal-sweep
2026-10-05T19:52:27.610Z pass 8340ba9cc2d512b26fbbb39f257ff1029dbd4b6c  goal-sweep
2026-10-05T23:07:48.474Z fail 3b116bec29ce55904412d81f7564859d78cde5a4  goal-sweep
2026-10-05T23:11:05.355Z fail 3b116bec29ce55904412d81f7564859d78cde5a4  goal-cli
2026-10-05T23:23:49.509Z fail e4cf8ead767a87eafc255b59bfa84a7f25be31da  goal-cli      ← 立案后新增
2026-10-05T23:30:57.995Z pass c46c04000d5b16e102239fdf552fa69581454f13  goal-cli      ← 立案后新增（尾巴已被重判为 pass）
```

两条立案点名 fail 的逐字 `payload.reason`：

```
2026-10-05T23:07:48.474Z fail tree=3b116bec…
'acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-inGCF7/vite-cache/deps/react-scan.js?v=34976701 as it exceeds the max of 500KB. [WebServer] (node:3887120) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated. [WebServer] (Use `node - … [truncated, 490 chars of stderr omitted]'

2026-10-05T23:11:05.355Z fail tree=3b116bec…
'acceptance failed (exit 1) — [WebServer] [BABEL] Note: … /quay-e2e-WY3mdE/vite-cache/deps/react-scan.js?v=4504202c as it exceeds the max of 500KB. [WebServer] (node:218171) [DEP0190] … [truncated, 489 chars of stderr omitted]'
```

**`treeSha` 断言（如实）：** `payload.treeSha == git rev-parse HEAD^{tree}` 在**收工时的分支尖端不成立** —— 收工时 `HEAD=086a152b…` / `tree=c46c0400…`，两条 fail 是 `3b116bec…`。原因是 develop 在立案后前进（`086a152b` → `d3d6fcd6`）。该断言要证明的**同一性在红态基线树 checkout 上逐字成立**：`HEAD^{tree}=3b116bec…` 时判据两跑皆绿（见 AC1 续）。且两棵红树与绿树的**代码路径逐字相同**（见 AC4）。

### AC3 — 指纹与 watchdog（机械复算）

同窗（`2026-10-05T21:00Z–23:30Z`）五条立案点名 fail + 立案后新增的一条，逐字 `payload.reason`（每条捕获**只有 webServer 转发的引导输出**，无测试输出）：

- AC-120 `21:24:17.689Z` tree=`d26f9881…`：`'acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YSfbh2/vite-cache/deps/react-scan.js?v=f3ebd2ba as it exceeds the max of 500KB.'`（整段 stderr 仅此一行）
- AC-254 `21:54:13.466Z` tree=`8d6c0388…`：同上单行（`/quay-e2e-J8CjkH/…?v=472c2030`）
- AC-254 `22:14:32.727Z` tree=`48be9abc…`：同上单行（`/quay-e2e-mvE2AS/…?v=f6e28b2f`）
- AC-199 `23:07:48.474Z` tree=`3b116bec…`：BABEL Note + DEP0190 + 截断
- AC-199 `23:11:05.355Z` tree=`3b116bec…`：BABEL Note + DEP0190 + 截断
- AC-199 `23:23:49.509Z` tree=`e4cf8ead…`（立案后新增）：BABEL Note + DEP0190 + 截断（`/quay-e2e-KkIGnM/…?v=92c55778`）

⇒ 5 条点名红 / 3 条互不共享判据文件的 AC（AC-120 / AC-254 / AC-199，连 spec 文件都不同）同形 —— 宿主级运行故障指纹。

六个 `watchdog-state.json` 逐字（`/data/home/yale/.cache/quay-e2e-tmp/<dir>/watchdog-state.json`）：

```
quay-e2e-inGCF7 (AC-199 23:07): {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
quay-e2e-WY3mdE (AC-199 23:11): {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
quay-e2e-KkIGnM (AC-199 23:23): {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
quay-e2e-YSfbh2 (AC-120 21:24): {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
quay-e2e-J8CjkH (AC-254 21:54): {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55006ms"}
quay-e2e-mvE2AS (AC-254 22:14): {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55004ms"}
```

⇒ AC-199 三次 `fired:false`（不是被自己的天花板杀的）；AC-254 两次 `fired:true`（55s 运行天花板）。

### AC4 — 死亡点已钉死：判据自身的 40s 预算被负载吃穿（结论 = (i)，(ii) 排除）

**决定性证据：三个 AC-199 fail 的 data dir 里留着 Playwright 的失败工件**（`<dataDir>/test-results/activity-dock-background-…/error-context.md` + `trace.zip`），逐字：

```
Error: the criterion must complete within 40s
expect(received).toBeLessThanOrEqual(expected)

Expected: <= 40000
Received:    49607      (quay-e2e-inGCF7, 23:07:48Z)
Received:    49866      (quay-e2e-WY3mdE, 23:11:05Z)
Received:    46688      (quay-e2e-KkIGnM, 23:23:49Z)
```

该断言是 `e2e/activity-dock-background.spec.ts:755` 的 `expect(elapsedMs, 'the criterion must complete within 40s').toBeLessThanOrEqual(40_000)` —— 它是**用例体的最后一句**（其后仅 `});`）。⇒ 那些红跑里 **ac2–ac7 与 walk-complete 的产品断言全部通过**，唯一失败的是判据给自己定的 40s 墙钟预算。这也解释了 `fired:false`：46.7–49.9s 没到 55s 运行天花板。

**并发/加载复现尝试（本条执行）：** 同一净 worktree，4 路并发同命令（`for i in 1 2 3 4; npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199" &`），日志 `/data/home/yale/.cache/ac199-probe/conc.log`：

```
LOAD before: 07:32:47 load average 11.04, 13.48, 15.66
CONC1 EXIT=0 WALL=24643ms   CONC4 EXIT=0 WALL=24813ms
CONC3 EXIT=0 WALL=24823ms   CONC2 EXIT=0 WALL=25115ms
LOAD after:  07:33:13 load average 13.49, 13.87, 15.73
```

⇒ 4 路并发（load 11→13）**未复现**，全部 exit 0、墙钟 24.6–25.1s，均产出测试输出（`ac3.main … green=true` 等）。

**OOM / dmesg 检查：** `journalctl --since "2026-10-06 06:55:00" --until "2026-10-06 07:30:00"`（= AC-199 三次红的窗口）grep `oom|killed by the OOM killer` → **空**；`dmesg` 无记录。⇒ AC-199 那三次**不是 OOM 杀的**。（同窗更早 05:03–06:40 确有 OOM 记录，多为 `quay-anchor-negctl-*` 负控探针与 `app.slice`；AC-120/AC-254 的点名红附近有 OOM，但那两条一为 `fired:false` 一为 `fired:true`，死法不同。）

**代码同一性（排除「另一棵树上的旧红」）：**

```
git diff --name-only 3b116bec… develop -- server/ src/ e2e/ playwright.config.ts package.json package-lock.json   → 空
git diff --name-only e4cf8ead… develop -- server/ src/ e2e/ playwright.config.ts package.json package-lock.json   → 空
```

`e2e/activity-dock-background.spec.ts` blob = `8919713f03ef330f071b6cee05556da18d696226`、`playwright.config.ts` blob = `01b844bc887bedee60a4f66e88bd88ddb23f98b2` —— 在 `3b116bec`、`e4cf8ead`、`develop` 三棵树上**逐字相同**。`3b116bec..develop` 的 32 个差异文件全是 `docs/`、`goals/`、`tasks/`、`scripts/mcp-smoke*`，无 `server/**` 或 `src/**`。

**结论（AC4 要求三选一）：(i) 负载敏感计时 —— 成立且已钉死**（判据整条 40s 自定预算在宿主负载下被吃穿：安静 23.4–24.4s → 负载下 46.7–49.9s > 40000）。**(ii) 新 voice 模块的并发敏感 boot —— 排除**：红树与绿树的 `server/**` / `src/**` 逐字相同（`chat-websocket.service.ts` 在 `3b116bec` 与 `develop` 上是同一 blob），且死亡发生在**用例体最后一句**而非 boot（boot 天花板 40s 与运行天花板 55s 均未触发，`fired:false`）。⛔ 未用「负载」一句抹掉 (ii)，而是用代码同一性 + 死亡位置把它排除。判据在净树与红态树上**均未红** ⇒ 未触发 AC4 的停手上报分支。

### AC5 — 空 delta

```
git diff --stat develop..HEAD -- e2e/ playwright.config.ts src/ server/ goals/ .quay/   → 空
git status --porcelain                                                                   → 空
```

未 `stash`、未 `git checkout --`（仅一次临时 `git checkout b9e7c0b3` 及复原，见 AC1 续，已复原）、未编辑任何 `e2e/**`、`playwright.config.ts`、`src/**`、`server/**`、`goals/**`、`.quay/**`。本条唯一写入是 `tasks/gap-ac199-criterion-ledger-red-is-silent-e2e-death.md`（经 `task_write`）。开工快照 `git status --porcelain` 空，收工仍空。

### AC6 — 可复用判法 + 尾巴状态

**判法（可机械复用）**：某 `gate=goal` 判据红，且 (a) 捕获的 stderr 只有 webServer 转发输出、无测试输出，且 (b) 同窗存在**互不共享文件的 AC** 同形红 ⇒ 宿主级运行死，不是「判据假」。本条把该判法推进一格：**去 data dir 读 Playwright 失败工件**（`<dataDir>/test-results/<spec>/error-context.md`）即可把死因从「无输出」钉到**具体那条断言**（本例是判据自定的 40s 墙钟预算），比只读 driver 截断后的 `payload.reason` 强得多。

**AC-199 的产品保证由本条的浏览器层直跑读数钉住**（真实 chromium，非 jsdom / 单元层）：`ac2.snapshot.status=200 …`、`ac3.main … green=true`、`ac4.backgrounded … toolUseId==foreground`（逐字相等）、`ac5.terminalRows=0 liveRows=2 liveStops=2`、`ac6.partition … stopDisabled=true bgDisabled=true reasons=[… ×3]`、`ac7.falseForm … green=false`、`AC-199 wall clock ≤ 40000`（见 AC1 / AC1 续）。

**写本条时台账尾巴状态**：**尾巴已被 driver 重判为 pass** —— `2026-10-05T23:30:57.995Z goal-cli pass tree=c46c04000d5b16e102239fdf552fa69581454f13`（不再是 fail）。