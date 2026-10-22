---
id: gap-claude-resident-remote-control-isolation-arm-outside-harness
title: AC-176 判据的假形态臂 (3)/(4) 在环境 DB 未迁移时恒红：arm (3) 不走 withRemoteControlHarness
  ⇒ createSdkResidentProcess 的 launch-spec 解析读 provider_models 抛 no such table ⇒
  宿主未注册、20s 超时；让判据自带它需要的 DB 事实
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Finding

<!-- dedup-ref --> 本条是机械 fan-in suite 的一个**确定性**红的修复项，不是任何在飞任务的 delta：判据
`server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`（AC-176，拥有者
`gap-claude-resident-remote-control-isolation`，`status: done`）在当前 develop 上恒红，红在它自己的两条假形态臂上，
真断言 (1)/(2a)/(2b)/(5)/(6)/(7) 全绿。相关的独立机制（另一个 in-flight 任务的 delta 都不是这条红）见
`gap-resident-enter-send-bypasses-intent-and-consent-gate` 的 Evidence。

**逐字读数（本轮实测；本仓 main checkout 与任务 worktree 各跑一遍，两处同红）。**

```
✖ (3) 假形态 (a)：检测到开启仍照常启动 ⇒ 门的读数必须红 (20028.841054ms)
  Error: Timed out after 20000ms waiting for the mutated build to open a resident host despite the enabled user settings
✖ (4) 假形态 (b)：启动时不传那两项 flag settings ⇒ 读回的读数必须红 (2.667049ms)
  { code: 'SQLITE_ERROR' }
ℹ pass 6 / fail 2
```

**真因（本轮插桩读到的未捕获 runError，逐字）。** 假形态臂 (3) 直接构造 driver
（`createFakeClock` + `createSessionHostManager({ now, scheduler: clock })` +
`new ClaudeResidentHostDriver({ host, ... createProcess: createScriptedProcess(), userSettingsPath: elsewherePath })`），
**不走 `withRemoteControlHarness`**，因此 `DATABASE_PATH` 仍是环境里的默认值。它的 `createProcess` 调
`createSdkResidentProcess` ⇒ `buildResidentSdkOptions` ⇒ `mapCliOptionsToSDK`
（`server/modules/providers/list/claude/claude-runtime.provider.js:310`）⇒ `resolveModelLaunchSpec`
（`server/modules/providers/services/model-launch-spec.service.ts:35`）⇒ `findCustomProviderModelByModelId` 读 `provider_models` 表：

```
SqliteError: no such table: provider_models
  at Object.findCustomProviderModelByModelId (server/modules/database/repositories/provider-models.ts:74)
  at resolveModelLaunchSpec (server/modules/providers/services/model-launch-spec.service.ts:35)
  at mapCliOptionsToSDK (server/modules/providers/list/claude/claude-runtime.provider.js:310)
  at buildResidentSdkOptions (server/modules/providers/list/claude/claude-host-driver.provider.ts:1396)
  at createSdkResidentProcess (server/modules/providers/list/claude/claude-host-driver.provider.ts:1463)
```

该异常在 `startResidentHost` 里先于 `this.host.openHost(...)` 抛出，所以宿主从未注册进 manager，`waitFor`
（`claude-resident-remote-control-isolation.test.ts:903`）20s 超时；臂 (4) 随后因脏 setup 报 `SQLITE_ERROR`。

**为什么 `provider_models` 不在。** 环境里的默认 `database/auth.db`（被 `.gitignore`（`*.db`）挡住，每个 checkout 各一份）
只有 `app_config` 一张表——本轮实测：worktree 的 `database/auth.db` 与 main checkout 的 `database/auth.db` 都是
`count=1, has provider_models=false`。真断言臂没这个问题，是因为它们跑在 harness 里
（`DATABASE_PATH = <temp>/auth.db`，第 543 行），那份库被迁移过。

**归属证据。** (a) 判据文件在 develop 上逐字未变（拥有者任务已 done），本条的修复面只在判据/其 DB 夹具；
(b) 本轮 suite 日志里 `gap-resident-enter-send-bypasses-intent-and-consent-gate` delta 覆盖的前端测试全 `passed=true`，
三个 `passed=false` 全在 `server/`（另外两个是 model-gateway 的 /tmp teardown 竞态与 voice-dashscope-settings 的 AC8 并发探针竞态，两者单独重跑都退 0）；
(c) main checkout（非 worktree）单独跑同一条命令同样退 1 且同一句。

⇒ 这是 done 任务的判据对**环境默认 DB** 的隐含依赖，被后来的共享依赖（`buildResidentSdkOptions` 走 DB 的 launch-spec 解析）打穿。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 在**环境 `database/auth.db` 只有 `app_config` 一张表**的 checkout 里退出 **0**（该条件下的红态基线：退出 1，`fail 2`，红在 (3)/(4)，`runError` 逐字含 `no such table: provider_models`）。
- [x] 假形态臂 (3) 的承重读数恢复：`waitFor` 不再超时，`manager.snapshot()` 里出现 `mode === 'resident' && state !== 'closed'` 的宿主，且随后 `assert.strictEqual(runError, null, 'the mutated gate must let the launch through, not refuse it')` 通过（逐字登记该臂的 `假形态 (a)：……仍起了常驻宿主 <hostId>` 读数行）。
- [x] 假形态臂 (4) 不再报 `SQLITE_ERROR`（若其依赖 (3) 的 setup，随 (3) 一起恢复）。
- [x] 修复**不改**真断言臂 (1)/(2a)/(2b) 的读数语义：修复后该文件 `pass 8 / fail 0`，真断言仍逐字读回拒绝码、两项 flag settings、请求值/检测值两个字段。
- [x] 独立负控制：在**环境 DB 已迁移**（`database/auth.db` 含 `provider_models`）的 checkout 里，修复前该文件也退 0——即修复针对的是「环境 DB 未迁移」这一条件，不是把断言放宽或跳过。
- [x] `npm run typecheck` 与 `npm run lint` 退出 0（判据 import 仍只经 barrel）。

## DoD

真落地：在交付树上**真的**在「环境 `database/auth.db` 只有 `app_config`」的条件下跑一次判据命令，读到 `tests 8 / pass 8 / fail 0`、退出 0；把修复前后的两段读数（`fail 2` 的 (3)/(4) 与 `pass 8`）逐字写进 Evidence。修复须让判据**自带**它需要的 DB 事实——例如把 (3)/(4) 也放进 `withRemoteControlHarness`，或显式把 `DATABASE_PATH` 指向一份迁移过的临时库，或注入 launch-spec 缝——不得靠「跑之前手工迁移仓库里的 `database/auth.db`」，那正是它在别的 checkout 上恒红的原因。若最终选择改产品侧（让 launch-spec 解析在缺表时回退），在完成记录里写明理由与该回退的负控制读数。

## Touches

- `server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`
- `tasks/gap-claude-resident-remote-control-isolation-arm-outside-harness.md`

## Evidence

**环境条件（AC1 的那一条，逐字）**：worktree 自己的 `database/auth.db` 修复前只有 `app_config`
（`select name from sqlite_master where type='table'` → `app_config`；`has provider_models: 0`）。
判据命令即 AC1 的逐字命令，cwd = 本任务 worktree。

**修复前 —— 退出 1（逐字）**

```
✖ (3) 假形态 (a)：检测到开启仍照常启动 ⇒ 门的读数必须红 (20038.097814ms)
  Error: Timed out after 20000ms waiting for the mutated build to open a resident host despite the enabled user settings
✖ (4) 假形态 (b)：启动时不传那两项 flag settings ⇒ 读回的读数必须红 (3.014639ms)
  { code: 'SQLITE_ERROR' }
ℹ tests 8
ℹ pass 6
ℹ fail 2
```

**修复后 —— 退出 0（逐字；`database/` 目录先删除、由该次运行重建，重建后仍只有 `app_config`）**

```
✔ (1) 用户级 settings 开启 Remote Control ⇒ 常驻启动被拒，且没有进程、没有请求、没有宿主 (494.300607ms)
✔ (2a) 用户 settings 不含 remoteControlAtStartup ⇒ 启动成功，两项 flag settings 逐字读回 (834.199497ms)
✔ (2b) 用户 settings 为 remoteControlAtStartup:false ⇒ 同样启动成功，检测值读到 false (841.567813ms)
[remote-control] 假形态 (a)：尽管 /data/scratch/yale/claude-resident-gate-arm-ptql1x/claude-config/settings.json 说开启，仍起了常驻宿主 host-9677105a-7c07-4626-8ab2-6c81207744d4
✔ (3) 假形态 (a)：检测到开启仍照常启动 ⇒ 门的读数必须红 (190.72574ms)
[remote-control] 假形态 (b)：不传 flags ⇒ 读回=null
[remote-control] 假形态 (b)：传错值 ⇒ 读回={"remoteControlAtStartup":true,"isolatePeerMachines":false}
✔ (4) 假形态 (b)：启动时不传那两项 flag settings ⇒ 读回的读数必须红 (132.951323ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

真断言臂 (1)/(2a)/(2b) 的读数语义未变：拒绝码 `remote-control-enabled`、两项 flag settings 逐字
`{"remoteControlAtStartup":false,"isolatePeerMachines":true}`、检测值分别 `null`（未设置）/ `false`。

**独立负控制（AC5）**：用本仓 `initializeDatabase()` 把该 checkout 自己的 `database/auth.db` 迁移成含
`provider_models`（逐字表集 `app_config,users,sqlite_sequence,api_keys,user_credentials,user_notification_preferences,vapid_keys,push_subscriptions,notification_channel_endpoints,projects,sessions,scan_state,provider_models,user_preferences,session_drafts,superseded_provider_sessions,user_voice_settings,scheduled_messages`），
把判据文件换回 develop 的逐字版本（sha1 `71a8ab49852a84aeb2dfe69bf75fc179de4ca435`），同一条命令退出 0：

```
✔ (3) 假形态 (a)：检测到开启仍照常启动 ⇒ 门的读数必须红 (54.836107ms)
✔ (4) 假形态 (b)：启动时不传那两项 flag settings ⇒ 读回的读数必须红 (1.973533ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

⇒ 红是由「环境 DB 未迁移」这一条件造成的，修复针对的正是该条件本身，没有放宽或跳过任何断言。
（负控制完成后已删除该 `database/`；上面「修复后」那段就是在只有 `app_config` 的条件下重跑所得。）

**AC6**：`npm run typecheck` 退出 0（`tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 三个全过）；
`npm run lint` 退出 0（输出里的 warning 均为既有的、不在本文件）。判据 import 仍只经
`@/modules/database/index.js`、`@/modules/providers/index.js`、`@/modules/session-hosts/index.js`、
`@/modules/websocket/index.js`、`@/shared/types.js` 五个 barrel，未新增 import。

**修复面**：新增 `withMigratedDatabase(run)`——建一份临时迁移库、把它设为 ambient `DATABASE_PATH`、
跑完拆掉并还原；臂 (3)/(4) 的测试体改成 `await withMigratedDatabase(runFakeArmA / runFakeArmB)`，
臂体本身逐字未改。产品侧未改（没有让 launch-spec 解析在缺表时回退）。
**本轮复核（复用 worktree、续跑）——交付面全绿；上轮 `step=suite` 的红已归因为与本 delta 无关的既有 flake**

- **AC1 逐字命令复核**：cwd = 本任务 worktree，其 `database/auth.db` 仍只有 `app_config`（`has provider_models: false`；判据跑完后仍只有 `app_config`，未被改动）→ 退出 **0**，`ℹ tests 8 / pass 8 / fail 0`，逐字含 `✔ (3) 假形态 (a)…`、`✔ (4) 假形态 (b)…`。
- **AC6 复核**：`npm run typecheck` 退出 0；`npm run lint` 退出 0（warning 均为既有、不在本文件）。本条对 develop 的 diff 未新增 import，仍只经原有五个 barrel。
- **scoped 门复核**：`bash scripts/test.sh --for-task gap-claude-resident-remote-control-isolation-arm-outside-harness --allow-thin` 退出 **0**，`__PERFILE__ duration_ms=5199 server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts passed=true`，`# tests 1 / # pass 1 / # fail 0`；scoped-gate 缓存按「与门测量同刻、且为 HEAD 祖先的 develop sha」（即 `git merge` 后的 `HEAD^2`）写入，活值见 `.quay/scoped-gate-cache.json`。
- **上轮 suite 红的归属（不是本条 delta）**：失败文件为 `server/modules/session-hosts/tests/resident-server-restart.test.ts`（AC-166 的判据），不在本条改动面内——本条对 develop 的 diff 逐字只有 `server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 一个文件；本条的判据文件在 suite 日志里 `passed=true`（`__PERFILE__ duration_ms=15575 … passed=true`）。
- **该红的真因是判据内的 systemd 竞态**：子产物逐字 `sigkill survivor=true killed=4 spared=1 server-pid=4138846 resident-pid=4142725` → `sigkill-residue pid=4142725 alive-at-next-boot=false swept=0`。同树上隔离单跑同一条命令退 **0** 且读到 `alive-at-next-boot=false swept=1`——差别只在 transient scope unit 是否在下次 boot 前被 systemd 收走（`sweptFrom` 数的是 `Swept N orphaned Claude session scope(s)` 行）。suite 里该文件耗时 26280ms，隔离单跑 10022ms，即并发下的时序位移。
- **同类先例（既有、低复现率）**：同一句判词已把兄弟任务 `gap-resident-enter-send-bypasses-intent-and-consent-gate` 连续两轮机械翻成 `needs-human`（见其 `## Needs-Human` 第二、三条，`session_id 3db02389-572e-4c24-b529-7c3dd022f9b3`），可见它不是可实现的缺陷。
- **不可达性**：本条 delta 只新增一个 test-local 夹具（临时迁移库 + ambient `DATABASE_PATH`），不触 `session-hosts`、不触 systemd scope 生命周期、不触 `server/index.ts` 的 sweep 调用点；且 `resident-server-restart.test.ts` 的 harness 自己把 `DATABASE_PATH` 从子进程 env 里删掉并用自有临时库（`server-environ DATABASE_PATH=<temp>/auth.db`），故本条的 ambient 改动对它不可达。

## Needs-Human

**执行 2026-09-29T06:49:26.709Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/session-hosts/tests/resident-server-restart.test.ts:   AssertionError [ERR_ASSERTION]: the next boot swept nothing (swept=0); the orphan was not there to reap
- run_id：wk-prod-anchor
- session_id：68649bf3-14d0-4333-8e7c-28937c444d83
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-resident-remote-control-isolation-arm-outside-harness~wk-prod-anchor~1790664325302-0c3672.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-resident-remote-control-isolation-arm-outside-harness-wk-prod-anchor.log
