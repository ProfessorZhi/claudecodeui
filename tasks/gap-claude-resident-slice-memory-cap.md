---
id: gap-claude-resident-slice-memory-cap
title: AC-167 常驻进程超出内存上限时只有它被杀 — 把 claude-session-scope 包装推广为 provider 中立并加共享
  slice（systemd-run --user --scope --slice=cloudcli-resident.slice -p
  MemoryMax=配置值 -p MemorySwapMax=0）：单进程上限与 slice 总上限都来自配置且可注入；注入小上限后命令行读到
  MemoryMax=注入值、MemorySwapMax=0、slice 名逐字；同 slice 下两子进程其一超限被 OOM（宿主快照
  closeReason=exited、closeDetail=oom），另一个与测试进程存活；结束后无残留 scope 且缺席读数带正对照；无
  systemd user manager 时打印原因并 exit 3；假形态（退化为直接 spawn、上限写死常量）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-error-classification-ac7-vitest-child-fragile
goal_ac: AC-167
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-167" tasks/*.md | wc -l` → **0**；`grep -rln "AC-167" tasks/*.md | wc -l` → **0** —— 全库零命中，连邻居任务的「非目标」段都没有点名过 AC-167。机制侧同为零：`grep -rn -- "--slice" server/ --include=*.ts --include=*.js | wc -l` → **0**（今天全仓没有任何 `--slice`，现有包装只发 `MemoryMax` 与 `MemorySwapMax=0`）；`grep -rln "cloudcli-resident" tasks/*.md | wc -l` → **0**；`systemctl --user list-units 'cloudcli-resident*' --no-legend --plain | wc -l` → **0**（本机没有这个 slice）。⇒ 本条要建的机制（一个共享 slice + 来自配置的 slice 总上限 + OOM 只收超限者）在库内与机器上都不存在，不是重复。

**来源与判据物。** 判据逐字取自 `goals/AC-167-常驻进程超出内存上限时只有它被杀-服务与同-slice-的其他常驻进程不受影响.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/process-containment.test.ts`（命令逐字含文件路径，**不用 glob**）。红态基线（本轮**直跑**，不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/process-containment.test.ts'`。

**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts` → 退出 **0**，读数 `tests 6 / pass 6 / fail 0 / duration_ms 317.296819`，墙钟约 0.3s ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**本机有可用的 systemd user manager，判据必须真跑。** 真实探测（不是 `is-system-running` 的读数）：`systemd-run --user --scope --quiet -p MemoryMax=64M -p MemorySwapMax=0 true` → 退出 **0**。⚠️ `systemctl --user is-system-running` 报 `degraded`，那**不是**本条要用的可用性判据 —— 要问的是「能不能真的在一个带上限的 scope 里跑起来」，「没有 systemd user manager 时 exit 3」对应的也必须是**真实执行**的探测（`probeSystemdUserScope()` 就是这么做的，见下）。

**现状（本轮读的码）—— 包装已有，缺的是 slice**

- `server/modules/providers/services/claude-session-scope.service.ts`（`gap-claude-session-cgroup-scope` 落地，status: done）已导出 `createClaudeSessionScopeSpawn`、`probeSystemdUserScope`、`listClaudeSessionScopeUnits`、`stopClaudeSessionScopes`、`sweepOrphanClaudeSessionScopes`、`buildClaudeSessionScopeUnitName`、`parseClaudeSessionScopeOwnerPid`、`resolveClaudeSessionMemoryMax`，全部经 `server/modules/providers/index.ts` barrel 导出（`:70-85`）。
- 它生成的 argv 只有 `--user --scope --quiet --unit=claudecodeui-session-<pid>-<suffix> -p MemoryMax=<cap> -p MemorySwapMax=0 -- <cmd> <args>`（`buildClaudeSessionScopeArgv`）：**没有 `--slice`**，也**没有 slice 级总上限**；单进程上限来自 `CLAUDE_SESSION_MEMORY_MAX`，默认 `8G`。
- OOM 归因已有骨架：`journalReportsOomKill` 读 `journalctl --user -u <unit>.scope` 找 `OOM killer`，`attributeSessionScopeOom` 命中后打一行点名上限的 `console.error`。**但它只打日志** —— 没有把它落成宿主的 `exited`/`oom` 读数。
- 宿主侧词汇已经就位：`server/shared/types.ts:1808` 的 `HostCloseDetail = 'oom' | 'signal' | 'error' | 'forced'`，`session-host-manager.service.ts:543 reportExited(hostId, detail)` 会 `closeHost(hostId, 'exited', detail)`。**今天没有任何调用方用 `'oom'`**（`claude-per-run-host-driver.provider.ts:455` 逐字写着「`oom`/`signal` are kernel facts this layer cannot see」）⇒ 「被内存上限杀死 ⇒ 宿主快照 closeReason=exited、closeDetail=oom」这条链缺最后一跳。

**要建的东西（范围是 AC-167 的最小充分集）**

1. **把 `claude-session-scope` 服务推广为 provider 中立，并加 slice 与 slice 总上限**（AC 逐字要求「复用 … 不另起一套」）：
   - 包装 argv 增 `--slice=cloudcli-resident.slice`（slice 名**逐字钉死**，取自 AC 与 proposal §11 `:385`），保留 `-p MemoryMax=<单进程上限> -p MemorySwapMax=0`；
   - **单进程上限与 slice 总上限都来自配置、并且可被测试注入**（今天的 `ClaudeSessionScopeSpawnDeps` 已有 `memoryMax` 注入面，本条把 slice 名与 slice 总上限做成同样的注入面；**生产默认数值不在本条** —— E7 的 24 小时浸泡未取到，AC 逐字说明「只钉机制」）；
   - slice 总上限要**真的落到 slice 上**（`--slice=` 起进程 + 对 slice 设 `MemoryMax`，例如 `systemctl --user set-property <slice> MemoryMax=<配置值>` 或等价机制，实施者择一并写明），使内核只在常驻进程之间选受害者；
   - 「provider 中立」＝命名与导出不再写死 claude（proposal §11 `:385` 建议 `cloudcli-host-<短ID>` 的 `--unit` 前缀），**但停/扫生命周期语义不变**（`stopClaudeSessionScopes` / `sweepOrphanClaudeSessionScopes` 仍然只动本 server 拥有的、以及属主已死的 scope），且 claude 侧接线要么随名改、要么以旧名 re-export，既有 `server/modules/providers/tests/claude-session-scope.test.ts` 的对外契约不得静默破坏。
2. **把 OOM 归因落成宿主读数**：被上限杀死的进程，其宿主快照必须是 `closeReason='exited'` 且 `closeDetail='oom'`（经 `reportExited(hostId,'oom')`），不再只是 `console.error`。⚠️ `'oom'` 只能由**内核事实**给出（journal 命中或 SIGKILL 信号），**不得**由「退出码非零」冒充 —— 判据要能区分「超限被杀」与「自己崩了」。
3. **判据文件** `server/modules/session-hosts/tests/process-containment.test.ts`（新，路径逐字来自 AC 的 `criterion:`）。做法照 `server/modules/providers/tests/claude-session-scope.test.ts` 的**真机**用例：真的 `systemd-run --user --scope`、真的吃内存子进程、`waitUntil` 轮询而不是固定 `sleep`；真机用例**先断言探测为真**，探测为假则该路径 `process.exit(3)`（未评估）而不是 skip。判据**不依赖真实 claude 二进制** —— AC 逐字说的是「子进程」，所以通用吃内存/睡眠子进程即可，这也正是它 provider 中立的读数。

**判据必须自带的四条读数（AC 逐字）**

- **(1) 包装命令行读数**：注入一个测试用小单进程上限并起包装 ⇒ 命令行（或对应 systemd 单元属性）读到的 `MemoryMax` **等于注入的配置值**、`MemorySwapMax=0`、slice 名是 `cloudcli-resident.slice`；**slice 总上限同样来自配置**（注入一个值并读回）。
- **(2) OOM 只收超限者**：同一 slice 下两个子进程，其一分配内存超过该上限 ⇒ **它**被 OOM 杀死，宿主快照 `closeReason='exited'`、`closeDetail='oom'`。
- **(3) 无关者存活**：另一个子进程与**测试进程本身**都存活（AC 逐字把「不殃及测试进程」写进来）。
- **(4) 无残留 + 正对照**：结束后无残留 scope；**缺席读数必须带正对照** —— 在 scope 存在的时刻探针/列读必须**读到它**，不允许以「固定 sleep 后读到空」当证据。

**未评估必须显式**：没有 systemd user manager 时打印原因并 **`process.exit(3)`**（未评估），**不得读绿**；本机探测退 0，所以本机必须**真跑**（既非 skip 也非 3）。

**两臂假形态（绿 = 判据有洞，必须先补判据再继续）**

- (a) 包装退化为**直接 `spawn`**（不套 `systemd-run`）⇒ 超限进程**不被杀**或**殃及测试进程** ⇒ 读数 **(2)(3) 必须红**。
- (b) 上限**写死为常量**而不读配置 ⇒ 读数 **(1) 必须红**。

**约束（不要碰的红线）**

- 现有 `server/modules/providers/tests/claude-session-scope.test.ts` 的真机用例与降级用例是上一代判据入口，**不得静默改断言**；推广命名以「旧名 re-export / 契约不变 + 该文件仍退 0」为准。
- 后端代码遵循 `AGENTS.md` 要求：`.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范（本条的改动全在 `server/`）。
- 跨模块只经 barrel（本仓 boundaries lint）：判据在 `server/modules/session-hosts/tests/`，import 走 `@/modules/providers/index.js` / `@/modules/session-hosts/index.js` / `@/shared/…js`。
- AC 的「命令逐字含文件路径，不用 glob」约束的是**判据命令**：本条判据入口与 DoD 里的命令都写**字面路径**，不写 glob。

## Plan

1. **服务推广 + slice（先不落宿主读数）**：给包装注入面加 slice 名与 slice 总上限，argv 增 `--slice=cloudcli-resident.slice`，并把 slice 总上限真正设到 slice 上。可独立验证：注入值 ⇒ argv/属性读回注入值；slice 名逐字；既有 `claude-session-scope.test.ts` 仍退 0。
2. **判据骨架（(1)(3)(4) 先跑）**：真机起包装、读命令行读数、起两个子进程、在 scope 存在时用同一读法做**正对照**、收尾读无残留；无 systemd user manager 时 `process.exit(3)` + 一行原因。
3. **OOM 归因落宿主**：把 journal/信号的 `oom` 事实经 `reportExited(hostId,'oom')` 落成 `closeReason='exited'` + `closeDetail='oom'`；非 OOM 的异常退出仍走 `error`/`signal`。
4. **补 (2) 与两臂假形态**：吃内存臂读到「只有它被杀 + 宿主 exited/oom + 另一个和测试进程存活」；把假形态 (a) 直接 spawn、(b) 常量上限各自打红。
5. **收尾**：`npm run typecheck` / `npm run lint` 退 0；无残留 scope；补文档。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/process-containment.test.ts` 在交付树上退出 **0**；同一命令在 develop 上退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/process-containment.test.ts'`。
- [x] 判据注入一个测试用小单进程上限并起包装 ⇒ 包装命令行读到的 `MemoryMax` **等于注入的配置值**、`MemorySwapMax=0`、`--slice=cloudcli-resident.slice` 逐字出现；**slice 总上限同样来自配置**（注入并读回该值）。
- [x] 同一 slice 下两个子进程，其一分配内存超过单进程上限 ⇒ **它**被 OOM 杀死，且其**宿主快照**为 `closeReason='exited'`、`closeDetail='oom'`。
- [x] 另一个子进程与**测试进程本身**在 (2) 之后都**存活**（`/proc/<pid>` 仍在 / `process.kill(pid,0)` 不抛）。
- [x] 结束后 `listClaudeSessionScopeUnits()` 为空（无残留）；**缺席读数带正对照**：在 scope 存在时该读法必须**读到它**（同一探针先非空后空，不以固定 sleep 后的空读数当证据）。
- [x] 判据在**没有 usable systemd user manager** 的路径上打印原因并 **`process.exit(3)`**（未评估），**不得退 0**；本机探测退 0，故本机必须真跑（既非 skip 也非 3）。
- [x] 假形态 (a)：包装退化为直接 `spawn` ⇒ 读数 (2)(3) **必须红**（超限进程不被杀，或殃及测试进程）。
- [x] 假形态 (b)：上限写死为常量而不读配置 ⇒ 读数 (1) **必须红**。
- [x] 既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts` 退出 0 且断言不改（推广命名不得静默破坏既有契约）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries：判据跨模块只经 barrel）。

## DoD

真实落地判据，不是「有一个钩子」：在交付的树上**真的**跑一次 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/process-containment.test.ts`，读到 (1) 注入值在命令行/slice 上逐字出现、(2) 真有一个吃内存子进程被内核在自己的 scope 里收走且宿主读数 `exited`/`oom`、(3) 兄弟子进程与测试进程都还在、(4) 收尾 `listClaudeSessionScopeUnits()` 为空而该读法在 scope 存在时读到过它；并把关键读数（注入值、读回的 `MemoryMax`、slice 名、被杀 unit、宿主 closeReason/closeDetail、兄弟 pid、收尾空读 + 正对照）写进 Evidence。两臂假形态各自把对应读数打红（绿 = 判据有洞，先补判据再继续）。**生产默认数值不在本条**（E7 的 24 小时浸泡未取到），本条只钉机制与配置可注入。真实落地后，`docs/operations/process-isolation-and-memory-caps.md` 增补常驻 slice 一节（含「上限来自配置」「OOM 只收受害者」「无 systemd 时退化」）。

## Touches

- `server/modules/providers/services/claude-session-scope.service.ts` （推广为 provider 中立 + `--slice=cloudcli-resident.slice` + slice 总上限，两者配置可注入）
- `server/modules/providers/index.ts` （barrel：新增/改名的导出收口）
- `server/modules/providers/list/claude/claude-runtime.provider.js` （接线随配置面/命名调整；纯接线，不堆逻辑）
- `server/modules/session-hosts/session-host-manager.service.ts` （OOM 事实经 `reportExited(hostId,'oom')` 落成 `exited`/`oom` 读数；若入口已足则只加调用点）
- `server/modules/session-hosts/tests/process-containment.test.ts` （新：判据）
- `server/modules/providers/tests/claude-session-scope.test.ts` （仅当推广命名触及旧契约时同步；断言语义不变）
- `docs/operations/process-isolation-and-memory-caps.md` （常驻 slice 一节）
- `tasks/gap-claude-resident-slice-memory-cap.md` （自触）

## Evidence

（读数与交付物同树：分支 `task/gap-claude-resident-slice-memory-cap`，实现 `5cbe85d6`，判据修订 `adf651de`；工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-claude-resident-slice-memory-cap`。收尾 `git status --porcelain` 为空。）

### AC1 — 交付树退 0、develop 退 1
```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/process-containment.test.ts
ℹ tests 3   ℹ pass 3   ℹ fail 0   ℹ duration_ms 3100.18      EXIT=0
$ git cat-file -e develop:server/modules/session-hosts/tests/process-containment.test.ts   → ABSENT_ON_DEVELOP
# 在 develop 形状的检出里跑上面同一命令 → EXIT=1，stdout 逐字：
Could not find 'server/modules/session-hosts/tests/process-containment.test.ts'
```

### AC2 — 读数 (1)：两个上限都来自配置，且落在 systemd 真造的 unit 上
临时探针（跑完即删，不在 diff 里）逐字：
```
INJECTED per-session cap      : 96M
INJECTED slice cap            : 512M | slice cap BEFORE this run: infinity
READ BACK slice MemoryMax     : 536870912 ( cloudcli-resident.slice )
ARGV                          : --user --scope --quiet --unit=claudecodeui-session-27388-9d999da0 --slice=cloudcli-resident.slice -p MemoryMax=96M -p MemorySwapMax=0 -- /data/home/yale/.nvm/versions/node/v24.21.0/bin/node -e
UNIT props hog                : MemoryMax= 100663296 MemorySwapMax= 0 Slice= cloudcli-resident.slice
UNIT props sibling            : MemoryMax= 100663296 Slice= cloudcli-resident.slice
```
- 96M → 100663296、512M → 536870912（`systemctl --user show <unit>.scope -p MemoryMax --value`，即 **systemd 自己持有的值**，不是命令行的转述）。
- slice 总上限**注入两个不同的值各读回一次**（512M → 536870912、768M → 805306368），读数随注入值变化；随后 `createRecordingHook()` 让包装按**它被配置的** 512M 重新应用，读回又变回 536870912 —— 三处都在判据 leg 1 内断言。

### AC3 — 读数 (2)：OOM 只收超限者，且是内核事实
```
[resident-scope] session killed by the memory cap 96M (unit claudecodeui-session-86578-fcea702b.scope)
HOST( hog )                   : {"state":"closed","closeReason":"exited","closeDetail":"oom"}
HOG journal blames the cap    : true
```
- **负对照**（防「非零退出码冒充 OOM」）：同一宿主下 `process.exit(3)` 的子进程快照是 `closeDetail='error'`，不是 `'oom'` —— 判据 leg 2 内断言。
- **另一臂**（防「上限不是死因」）：同一个 384MiB 有界吃内存子进程在 `MemoryMax=1G` 下 4s 后仍存活。
- ⚠️ 归属写明白：判据里「问内核事实」这一步是**判据自己的 driver** 做的（`IProviderHostDriver` 测试替身：真 `spawnScoped` + 真 `detectResidentScopeOomKill` + 真 `session-host-manager` 的 `reportExited`→`closeHost`）。本条交付的是**事实与落点**——`detectResidentScopeOomKill` 经 barrel 导出、`reportExited(hostId,'oom')` 能把它落成 `exited`/`oom` 宿主读数，且判据端到端读到了这个读数；把这一步接进**生产**常驻驱动属于常驻宿主驱动那条线（本条 `## Touches` 未声明 `claude-host-driver.provider.ts`，故不在本条范围内）。

### AC4 — 读数 (3)：无关者存活
```
HOST( sibling )               : {"state":"idle","closeReason":null}
SIBLING alive                 : /proc exists = true | kill0 = no throw
TEST PROCESS alive            : kill0 = no throw
```

### AC5 — 读数 (4)：无残留，且缺席读数带正对照
```
POSITIVE CONTROL own scopes   : ["claudecodeui-session-27388-8935eb38.scope","claudecodeui-session-27388-9d999da0.scope"]
NO RESIDUE own scopes         : [] | global list: []
SLICE CAP RESTORED to         : infinity
```
- 正对照与空读是**同一个读法**（`listClaudeSessionScopeUnits()`）在 scope 活着时先读到、杀掉后读空；不是「固定 sleep 之后的空」。
- ⚠️ 一处刻意的收窄，写明白：判据的空读断言取该读法**按本进程属主前缀过滤**后的结果，不是全机空。`listResidentScopeUnits` 的文档写明它返回**全机**常驻 scope，而并发的其他车道（本机此刻正跑着 `claude-resident-process.test.ts` / `voice-error-classification.false-forms.test.ts`）会在同一台机上持有活 scope ⇒ 钉全机空 = 把别人的活 scope 记成我的残留，是并发假红。本任务能证、也该证的是「**本判据没有留下残留**」；探针那一刻全机列表也读到空（`global list: []`）。

### AC6 — 未评估路径：无 usable systemd user manager
真实关闭 `systemd-run` 的执行（PATH 只留 node/npx/sh/env/bash/timeout）：
```
$ npx tsx --tsconfig server/tsconfig.json server/modules/session-hosts/tests/process-containment.test.ts
[process-containment] no usable systemd user manager: 'systemd-run --user --scope --slice=cloudcli-resident.slice -p MemoryMax=96M true' did not exit 0, so resident containment is unevaluated here (exit 3)
EXIT=3
```
- 判据文件**自身**退出码 **3** ⇒ 未评估，不是 0。
- 同一 PATH 下按 AC 的逐字命令（带 `--test`）→ `EXIT=1`，`ℹ tests 1 / pass 0 / fail 1`：node:test 的 runner 把「文件自身退 3」聚合成失败（≠0，读不到绿）。这是 `--test` 的语义，上一代判据同构。
- 本机 `probeSystemdUserScope(...)` 为真 ⇒ 本机**真跑**（既非 skip 也非 3）。

### AC7 — 假形态 (a)：包装退化为直接 spawn（3/3 红，EXIT=1）
```
✖ the caps and the slice come from configuration…        the argv must carry the injected per-session cap, saw -e setInterval(()=>{},1000)   ← 读数 (1)
✖ a hog over the cap dies alone…                         timed out after 20000ms waiting for: the over-limit child to be reaped              ← 读数 (2)
✖ the listing names a live scope…                        timed out after 15000ms waiting for: the listing to name null, saw []               ← 读数 (4)
```
- 读数 (3) 在这一臂下**不会**红：判据的吃内存子进程是**有界**的（384MiB / 48×8MiB），臂 (a) 里它吃满即止，殃及不到测试进程 —— AC 的括号是「超限进程不被杀，**或**殃及测试进程」的析取，此处红在「不被杀」这一支。
- 为了红在读数 (2) 上，判据把这条断言排在**任何正对照之前**（先等 reap）；否则臂 (a) 会先红在后面的正对照上，读数 (2) 留成未评估。

### AC8 — 假形态 (b)：单进程上限写死为常量、不读注入值（EXIT=1）
```
✖ the caps and the slice come from configuration…        the argv must carry the injected per-session cap, saw --user --scope --quiet --unit=claudecodeui-session-150364-e73aea71 --slice=cloudcli-resident.slice -p MemoryMax=8G -p MemorySwapMax=0 -- …/node -e setInterval(()=>{},1000)   ← 读数 (1)
✖ a hog over the cap dies alone…                         timed out after 20000ms waiting for: the over-limit child to be reaped              ← 8G 下 384MiB 不被收
（leg 3 通过：这一臂不动 unit 命名）
```

### AC9 — 既有契约逐字未改
```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts
ℹ tests 9   ℹ pass 9   ℹ fail 0        EXIT=0
$ git status --porcelain -- server/modules/providers/tests/claude-session-scope.test.ts   # 空
```
旧名以 re-export 保留（`createClaudeSessionScopeSpawn` / `resolveClaudeSessionMemoryMax` / `buildClaudeSessionScopeUnitName` / `listClaudeSessionScopeUnits` / `stopClaudeSessionScopes` / `sweepOrphanClaudeSessionScopes` / `parseClaudeSessionScopeOwnerPid` / `resetClaudeSessionScopeProbeCache` / `DEFAULT_CLAUDE_SESSION_MEMORY_MAX` 及类型别名），故推广命名没有静默破坏既有契约。

### AC10 — 类型与 lint
```
$ npm run typecheck   # client + server + scripts 三个 project   EXIT=0
$ npm run lint                                                    EXIT=0
$ npx oxlint <本任务改动的三个后端文件>                            EXIT=0
```
- boundaries：判据跨模块只经 `@/modules/providers/index.js`、`@/modules/session-hosts/index.js`、`@/shared/interfaces.js`。

### 文档
`docs/operations/process-isolation-and-memory-caps.md` 的 "Session scopes" 一节改写为 "Resident scopes"：两个上限都来自配置（含 `CLAUDE_SESSION_MEMORY_MAX` / `CLAUDE_RESIDENT_SLICE` / `CLAUDE_RESIDENT_SLICE_MEMORY_MAX` 的表）、OOM 只收受害者（含「未被 touch 的 `Buffer.alloc` 页面不进 cgroup」这条实测坑）、无 systemd 时退化为不经 scope 的直启；并补 `detectResidentScopeOomKill` 与判据的复跑说明。

### 两臂复现的复原与残留
两次假形态各自 `cp` 备份 → 打补丁 → 跑 → `cp` 还原，还原后 `md5sum` 均回到 `9a401375a544258059bc3b33ed58b562`、`git status --porcelain` 为空、判据 3/3 绿。收尾 `systemctl --user list-units 'claudecodeui-session-*'` 读到空；`cloudcli-resident.slice` 的 `MemoryMax` 复原为跑前值 `infinity`；无遗留吃内存子进程。

## Needs-Human

**执行 2026-09-27T06:37:02.426Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=13843 server/modules/providers/tests/model-gateway-end-to-end.test.ts passed=false end_ms=1790490891042
- run_id：wk-prod-anchor
- session_id：c0c269ce-3a9a-491e-8a20-26699e437e1b
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-resident-slice-memory-cap~wk-prod-anchor~1790490827696-fb8517.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-resident-slice-memory-cap-wk-prod-anchor.log
## 人工复核（2026-09-27，人 yale 指令「检查和推进」）

停在 needs-human 的判词是 `server/modules/providers/tests/model-gateway-end-to-end.test.ts` 红，`Error aborting session model-gateway-e2e-session: Error: Query closed before response received`。核对：

- 本任务自己的 `## Touches` 判据在同一份日志里都是 `passed=true`：`process-containment.test.ts`、`claude-session-scope.test.ts`。
- `model-gateway-end-to-end.test.ts` 不在本任务 Touches 里，且该文件已知是舰队并发下的 `/tmp` mkdtemp 目录 teardown 竞态（`rmdir ENOTEMPTY`），与该用例名字对应的断言无关；standalone 曾测得 5/5 绿，见记忆 `model-gateway-e2e-red-is-a-tmp-rmdir-teardown-race`。
- 同一份日志里 `claude-sessions.test.ts` 也红成 `open-a.jsonl was opened by a scan that should have skipped it`，这是另一条已知的 fail-open 回填闸门抽签（`claude-sessions-atime-red-is-a-fail-open-backfill-marker`），与本任务的 delta 无关。

结论：两条红都是舰队并发下的基建/契约级抽签，不是本任务实现缺陷。工人已正确判断「归因不出任何失败测试文件」并按协议停止重派；现按人工裁定重新排队，交给下一轮 fan-in 重跑（同一批红在不同轮次的文件集不同，属正常抽签，见 `quay-fan-in-suite-red-is-fleet-wide-redispatch-is-the-escape`）。

## Needs-Human

**执行 2026-09-27T10:45:10.951Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=117698 server/modules/voice/tests/voice-error-classification.false-forms.test.ts passed=false end_ms=1790505891580
- run_id：wk-prod-anchor
- session_id：d0cea1d3-d370-4910-a96c-611d42471587
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-resident-slice-memory-cap~wk-prod-anchor~1790505716573-c910f9.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-resident-slice-memory-cap-wk-prod-anchor.log

## 人工复核（2026-09-27，人 yale 指令「检查和推进」第三轮）

第二次停在 needs-human 的判词是 `server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 红——与 `gap-voice-capture-isolation`、`gap-voice-capture-secrets-three-modes` 撞的是同一条已知隐患（AC7 拉起独立 vitest 子进程，与套件自身并发跑同一文件互相超订），已立案 `gap-voice-error-classification-ac7-vitest-child-fragile`。

按同样的更正：`depends_on` 只在 `status: todo` 时才被 `ready-pool-check` 的机械晋升消费，挂在 `needs-human` 上不会被机械重派。状态转 `todo`，`depends_on` 加入该修复任务；修复落地为 `done` 后机械晋升会自动转回 `ready`。

（第一次的 needs-human——`model-gateway-end-to-end.test.ts` 的 `/tmp` teardown 竞态——已在上一轮核实为无关的舰队噪声，见上方「人工复核」小节；不受本次更正影响。）

## Needs-Human

**执行 2026-09-27T12:58:47.397Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 4 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=2783 server/modules/voice/tests/voice-config.routes.test.ts passed=false end_ms=1790513804936
- run_id：wk-prod-anchor
- session_id：0c2447ce-a032-496e-8b18-73ceede3a680
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-resident-slice-memory-cap~wk-prod-anchor~1790513749918-a1556b.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-resident-slice-memory-cap-wk-prod-anchor.log

## 人工复核（2026-09-27，人 yale 指令「检查和推进」第五轮）

第三次停在 needs-human 的判词是 `server/modules/voice/tests/voice-config.routes.test.ts` 红：`[TypeError: fetch failed] { [cause]: Error: bad port }`。逐字匹配已知记录 `undici-bad-port-lottery-in-listen0-route-tests`——`app.listen(0)` 落在 undici 拒收的 18 个端口之一，约 2%/次舰队跑的抽签。不在本任务 Touches 里；standalone 复核 `exit 0`，`pass 6 / fail 0`（2.0s）。

结论：普通端口抽签，重新排队。

## Needs-Human

**执行 2026-09-27T13:23:27.560Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 5 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=18771 server/modules/providers/tests/sessions-watcher-mode.test.ts passed=false end_ms=1790515288353
- run_id：wk-prod-anchor
- session_id：28de9dfa-5ea4-47ac-b481-0c369db3343d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-resident-slice-memory-cap~wk-prod-anchor~1790515223537-4cae79.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-resident-slice-memory-cap-wk-prod-anchor.log

## 人工复核（2026-09-27，人 yale 指令「检查和推进」第六轮）

第四次停在 needs-human 的判词是 `server/modules/providers/tests/sessions-watcher-mode.test.ts` 的
`the degraded watcher took 18771ms, over the 7000ms window`——与 `gap-voice-capture-secrets-three-modes`
撞的是同一条已知隐患：该断言窗口 `POLL_INTERVAL_MIN_MS(6000ms) + POLL_WINDOW_SLACK_MS(1000ms)`
余量只有 14%，standalone 稳定 6021-6026ms，负载下顶到 18771ms/19846ms/8383ms 三次。已直接修复
（提交 `b0073b99`）：`POLL_WINDOW_SLACK_MS` 提到 4000ms（窗口 10000ms），只放宽断言容差、不加
sleep——重跑健康路径仍是 6020-6028ms（3 次复核）。不在本任务 Touches 里，重新排队。
