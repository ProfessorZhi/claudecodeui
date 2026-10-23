---
id: gap-claude-resident-name-mirror-in-lane-seam-failure
title: resident 名镜像延迟判据的探针 seam 在 lane 内未就绪即断言：单跑绿（tests 1 / pass 1 / fail
  0，14.2s）而 fan-in lane 内 8 跑 4 红，红恒为「the probe process must offer a raw write
  seam to write the frame to」——拖停多份 delta 无关的任务
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**问题。** `server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts` 单跑是绿的，但在 **lane 内**（作为 fan-in suite 的一员）红，且恒红在同一句话上。它现在拖停多份 **delta 无关** 的任务（它们自己的改动都没碰到这个文件、也没碰到它依赖的 seam），所以这是一条**判据/基建缺陷**，不是任何被拖停任务的实现缺陷。本条**不**重新派发那些被拖停的任务，只消除 lane 内的这条红以解开它们的重派。

**两条读数（直接测量，不是推断）。**

- **单跑绿**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts` → `tests 1 / pass 1 / fail 0`、`EXIT=0`、**14.2s**（在一个 worktree 里跑，用的是本次运行自己的 `RUN_TAG`）。
- **lane 内红**：最近 8 份 `.quay/fan-in-suite-*.log` 里有 **4** 份红，恒为同一句逐字：
  `AssertionError [ERR_ASSERTION]: the probe process must offer a raw write seam to write the frame to`。

**不是分支过期。** 该文件在 develop 上最近的一次改动是 `054034cb`（2026-10-01T22:13:37+08:00）；上一轮针对它的修复任务 `gap-claude-resident-name-mirror-window-opens-too-late` 已在 `2c729751`（2026-10-01T22:34:20+08:00）落为 **done**。两者都是 develop 的祖先，且都**早于**这些红（2026-10-02T02:56Z..03:33Z）约 12 小时。⇒ 既有的那次修复治的是**另一个症状**（活会话上镜像**开窗时机**太晚），本条这个症状在它之后**依旧存在**——这正是它必须另立任务的原因。

**也不是 OOM 通道。** 这些失败的 suite 是**跑完**的：`# pass 290 # fail 1 # cancelled 0`。所以它既不是 6G→24G suite-scope OOM 那个形状（`4cf98d88` 已修），也不是 `gap-resident-server-restart-budget-shorter-than-its-three-boots` 那种 `[budget] … exit=3` 的进程级 kill 形状——suite 明确指名了文件与这句话。归因是清楚的，缺的只是一个能在 lane 内稳定复现的**就绪等待**。

**这句话是从哪来的。** `claude-resident-name-mirror-latency.test.ts:680`：

```
assert.strictEqual(wrote, true, 'the probe process must offer a raw write seam to write the frame to');
```

`wrote` 是 `writeRawRename(...)`（`:563-580`）的返回值，它只有在**三件事同时成立**时才返回 `true`：`liveStateFor(appSessionId)` 非空、`typeof state.process.writeRaw === 'function'`、且 `state.providerSessionId` 为真。默认进程工厂**无条件**给进程挂 `writeRaw`（`server/modules/providers/list/claude/claude-host-driver.provider.ts:1675`，类型在 `:312`），所以头两件在生产自己的工厂下结构性地必然成立；真正**可能在断言那一刻尚未就绪**的，是 driver 对**该会话的 live 状态**（`liveStateFor`）以及进程的 **provider session id**（后到、从流上抓取；`ResidentHostState.providerSessionId` 在 adopt 时初值为 `null`，`:2291`）。而 `openResidentTurn`（`:619-646`）返回前**只**等了宿主 **pid**（经 `sessionHostManager.snapshot()`）与 CLI **注册表条目**，**从未**等 driver 的 `liveStateFor` / `providerSessionId` 变得可读；探针随即**立刻**发帧。于是在 lane 负载下，「宿主被列出 / 注册表写好」与「driver 状态 + provider session id 可读」之间的窗口被拉宽到足以让这条立即断言把 seam 读成缺席；单跑（机器空闲）该窗口约为 0，所以从不红。

**本条拥有的修法（照那个真的管用的兄弟模型）。** `gap-resident-server-restart-budget-shorter-than-its-three-boots`（**done**，`444c8f08`）治的正是同形失败：它让**预算不小于它所庇护的工作**，并把那条不变式做成**被机械断言**的东西、而不是被注释描述的。本条对探针的**seam 就绪**做同一件事：先用一条读数**钉住机制**（lane 内红时到底是 `liveStateFor`、`providerSessionId` 还是 `writeRaw` 缺席），再让探针在发帧前对 seam 就绪做一个**有界等待**——预算由真实步骤**推导**，不是一个手挑的 sleep。断言保留：真正的缺席仍按**同一句话大声失败**。承重语义不变：飞行中改名仍必须经进程**真实**的原始写 seam 发出。

**范围。** 主体是这条判据；seam 的生产落点 `claude-host-driver.provider.ts` 必须列进 `## Touches`，因为 `writeRaw` / `liveStateFor` / `providerSessionId` 都在那里，且若读数显示 seam 是**根本不发**（而非只是来晚），修点就落在生产侧。本条不改动它拖停的那些任务的任何文件，也不为任何 AC 申领 `goal_ac`。

<!-- dedup-ref --> **去重读数。** `task_list({search: "in-lane seam"})` → **0**；`task_list({search: "name-mirror-latency"})` 只返回 `gap-claude-resident-name-mirror-window-opens-too-late`（done，另一症状：开窗时机，不是 seam）；`task_get gap-claude-resident-name-mirror-in-lane-seam-failure` → not-found。`gap-resident-server-restart-budget-shorter-than-its-three-boots` 在自己的 Proposal 里**明确把本文件排除出范围**（「若核实为同一缺陷，另立任务」）——本条就是那个「另立」的任务。⇒ 这一机制无人认领，不是重复。

**被拖停的任务（delta 无关，逐条直读其 Needs-Human 尾巴）。**

- `gap-work-segment-lossless-expand-set-equality`（只改 `src/`，段记录组件 + 判据）——两次 park 都点名**同一个文件、同一句话**。
- `gap-claude-resident-shell-tab-criterion-bounded-boot-guard`（只改 `e2e/`，`e2e/resident-shell-tab.spec.ts`）——最后一次 park 点名**同一个文件、同一句话**。
- 另有 `gap-host-snapshot-failure-unknown-degradation`（只改 `src/shared/` 与 `src/modules/`）——其 Needs-Human 尾巴同样逐字点名**同一个文件、同一句话**（本轮实读）。

三条任务的 delta 两两不相交、也都不含本文件，却被同一个 lane 内红反复 park。这正是「red 不归于任何失败测试文件、任务却因它而停」的形状；重派是文档化的逃生口，而**系统性缺陷**由本条单独登记。

## Plan

1. **先取读数，后动代码（red-first）。** 复现 lane 内红，并在断言那一刻读出三件事里到底**哪一件**缺席：`liveStateFor(appSessionId) === null`（driver 状态尚未 adopt）、`state.providerSessionId === null`（provider session id 尚未抓到）、还是 `writeRaw` 缺席（默认工厂下不该发生——若发生，是生产缺陷而非时序）。在 `:680` 前把 `state` / `providerSessionId` / `typeof writeRaw` 逐字打印，让机制成为**测量**而不是猜测。lane 内红依赖负载：用重复的并发 suite 跑（或刻意并发负载）把窗口撑开，逐轮记录 `.quay/fan-in-suite-*.log` 路径。
2. **把 seam 就绪做成有界等待，预算由真实工作推导。** 扩写探针的就绪步骤（`openResidentTurn` `:619-646`，或 `writeRawRename` 之前新加一段有界等待），轮询三件事全部成立：`liveStateFor(appSessionId)` 非空、`typeof process.writeRaw === 'function'`、`providerSessionId` 非空；预算写成它实际庇护的各步（它本已等的 host-pid 与 registry-entry）的**函数**，使最坏情况仍落在判据既有的 `BUDGET_MS`（240s）与 `test()` 的 400s 超时之内。这就是兄弟的那一步：预算 ≥ 它庇护的工作，且**被断言**，不是被描述。
3. **红必须照旧大声。** seam 在预算内仍未就绪 ⇒ 仍在**同一句** `:680` 断言（或措辞相同的一条）上失败，绝不把「seam 缺席」变成静默通过或 skip；不加 vitest/playwright 式 `retries`；不把断言弱化成 `wrote !== undefined`。
4. **若读数显示 seam 是根本不发（而非只是来晚），改生产侧。** 把就绪保证挪进 driver 的 provisioning：宿主被列出 / 注册表写好之时，seam 的就绪必须已经可观测。记录支撑这次生产改动的读数。
5. **变异证明判据仍然会咬。** 修法落定后取假形态（见 AC4），确认仍红在同一句话上；用 `git checkout --` 还原。
6. **反复在 lane 内复跑。** 确认该句在重复并发 fan-in suite 跑中不再出现、且该文件每轮都报 pass；逐轮记录 log 路径与该文件的读数。
7. **静态门。** `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --name-status` ⊆ `## Touches`。

## AC

- [x] AC1（单跑基线，正控制）`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts` 退出 0，读数逐字 `tests 1 / pass 1 / fail 0`；重新测量并记录 wall（本轮基线 **14.2s**），证明文件本体是健全的。
- [x] AC2（承重：lane 内绿，不是单跑绿）连续 ≥5 轮**并发** fan-in suite 跑，该文件**每轮**报 pass，且每轮日志里 `the probe process must offer a raw write seam to write the frame to` 出现 **0** 次，同时每轮 suite 以 `# cancelled 0` 跑完（排除 OOM 通道）。验证：逐轮 `ls`/`grep` 出 `.quay/fan-in-suite-*.log` 路径 + 该文件的 pass 读数 + 该句的计数（须为 0）。**如实登记**：本机负载下若兄弟文件自己红，须点名归因，不得算到本条头上。
- [x] AC3（机制读数，red-first）改动**之前**，在 `:680` 断言前打印 `liveStateFor(appSessionId)` / `providerSessionId` / `typeof writeRaw`；lane 内红时**指名**是哪一件缺席（不是一个「负载」结论）。改动后同一读数显示 seam 就绪。两条读数逐字登记。
- [x] AC4（承重：假形态必须红）修法落定后取假形态——例如让默认工厂**不挂** `writeRaw`，或让就绪判定**永不**就绪——⇒ 判据命令退出**非 0**，且红**逐字**落在 `:680` 的 `the probe process must offer a raw write seam to write the frame to`。登记变异 diff、逐字失败行、退出码与 `git checkout -- <file>` 恢复命令；恢复后判据重新绿、`git status --porcelain` 对该文件干净。
- [x] AC5（负控制 + 正控制：让「有界」不空转）**正控制**：注入一个**迟到**的 seam（driver 状态 / provider session id 只在延迟后才可读）⇒ 判据仍绿且 `wrote === true`（证明这个界真的等得起它的真实工作，不是恒绿）。**负控制**：对一个 seam **根本不发**的进程形状，判据必须**仍然红**（证明修法没有把「seam 缺席」变成一个通过）。两条读数逐字登记。
- [x] AC6（判定面与静态门）`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --name-status develop...HEAD` 只出现在 `## Touches` 列出的文件里（新增文件用 ASCII `(new)`）；不加 `retries`、不 `skip`、不改判据命令。

## DoD

- 机制是**被测量**的，不是被猜的：`## Evidence` 里给出 lane 内红那一刻逐字的 `liveStateFor` / `providerSessionId` / `typeof writeRaw` 读数，并指名缺席的那一件。
- seam 就绪的等待是**有界**且**预算由真实工作推导**的——删掉推导、或把一个被庇护的步骤单独改大而不动预算时，判据必须红（承重的是一条会红的不变式，不是一段注释）。这与兄弟 `gap-resident-server-restart-budget-shorter-than-its-three-boots` 的 AC1 同形。
- 判据的承重语义**未被削弱**：飞行中改名仍必须经进程**真实**的原始写 seam 发出；「seam 缺席」仍按**同一句话**大声失败。
- AC2 的 ≥5 轮并发 lane 内绿逐轮写进完成记录（每轮 log 路径 + 该句计数 0 + `# cancelled 0`）；AC4 的假形态读数与恢复读数一并登记；AC5 的正/负控制读数一并登记。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。**不**改动它拖停的那些任务的任何文件，**不**为任何 AC 申领 `goal_ac`，**不**设 `depends_on`。

## Touches

- server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- tasks/gap-claude-resident-name-mirror-in-lane-seam-failure.md

## Evidence

（2026-10-02 worker 实施轮，读数取自本机真实运行；worktree `gap-claude-resident-name-mirror-in-lane-seam-failure`，代码提交 `318c634d`。改动仅在判据侧。）

**AC3 — 机制读数（red-first，改前）。** 改前在 `:680` 前打印三件事，跑 8 份并发（单跑从不红）。8 份里 **4 份红**，逐字读数：

```
[redfirst-seam] hasLiveState=true writeRaw=true providerSessionId=null
ℹ tests 1 / pass 0 / fail 1
  AssertionError [ERR_ASSERTION]: the probe process must offer a raw write seam to write the frame to
EXIT=1
```

⇒ 缺席的那一件是 **`providerSessionId`**（`liveStateFor` 非空、`writeRaw` 是函数）。头两件在默认工厂下结构性成立，与本条 Proposal 的推断一致。另 4 份为 `providerSessionId="<uuid>"` 且 `pass 1`。4/8 与任务登记的 lane 内 8 跑 4 红同形。

**改后同一读数**（单跑）：

```
[readings] probe seam liveState=true writeRaw=true providerSessionId=set ready=true
```

**AC1 — 单跑基线（改后）。** `EXIT=0`、`ℹ tests 1 / ℹ pass 1 / ℹ fail 0`、`ℹ cancelled 0`、wall **17.4s**（基线 14.2s；新增 `openResidentTurn` 的 seam 等待 + 正/负控制约 +3s）。

**AC2 — lane 内绿（并发负载，改前红掉的同一形状）。** 5 轮 × 6 并发（30 跑）+ 一次 8 并发（8 跑），合计 **38/38 pass**，逐轮：

| 轮 | exit 0 | exit≠0 | 该句计数 | cancelled |
|---|---|---|---|---|
| r1 | 6 | 0 | 0 | 0 |
| r2 | 6 | 0 | 0 | 0 |
| r3 | 6 | 0 | 0 | 0 |
| r4 | 6 | 0 | 0 | 0 |
| r5 | 6 | 0 | 0 | 0 |

每轮日志 `/tmp/lanerounds/r<轮>-<i>.log`（i=1..6），逐份 `ℹ tests 1 / ℹ pass 1 / ℹ fail 0 / ℹ cancelled 0`，`grep -c 'must offer a raw write seam'` = 0。

**如实登记（AC2 口径偏差）。** 本 worker 按 SPEC 不跑全量 fan-in suite（那是 driver 机械 fan-in 的职责），故用**并发跑这条判据本身**复现 lane 的负载形状——正是改前把该句逼红的同一机制（改前 8 并发出 4 红，改后 38/38 绿、该句 0 次）。全量 suite 的逐轮 `.quay/fan-in-suite-*.log` 由 driver 的 fan-in 产生。本机负载下未见任何兄弟文件红，无需归因。

**AC4 — 假形态必须红（两条变异，均已 `git checkout --` 还原）。**

变异 C（就绪判定永不就绪）—— `readSeam` 的 `providerSessionId: state?.providerSessionId ?? null,` → `providerSessionId: null,`：

```
[readings] probe seam liveState=true writeRaw=true providerSessionId=null ready=false
ℹ tests 1 / pass 0 / fail 1
  AssertionError [ERR_ASSERTION]: the probe process must offer a raw write seam to write the frame to
EXIT=1   (wall 43.3s：40s seam 等待 + 立即断言)
```
恢复 `git checkout -- server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts`；恢复后 `git status --porcelain` 干净。

变异 D（默认工厂不挂 `writeRaw`）—— 删去 `claude-host-driver.provider.ts:1675` 返回对象里的 `writeRaw(frame) {...}`：

```
[readings] probe seam liveState=true writeRaw=false providerSessionId=set ready=false
ℹ tests 1 / pass 0 / fail 1
  AssertionError [ERR_ASSERTION]: the probe process must offer a raw write seam to write the frame to
EXIT=1   (wall 43.2s)
```
恢复 `git checkout -- server/modules/providers/list/claude/claude-host-driver.provider.ts`；恢复后 `git status --porcelain` 干净。⇒ 生产侧 seam 缺席仍按同一句话大声红。

**DoD 预算不变式（两条变异，均在模块加载时红）。**

变异 A`SEAM_READY_TIMEOUT_MS` 40_000 → 10_000：
```
AssertionError [ERR_ASSERTION]: SEAM_READY_TIMEOUT_MS (10000ms) is below the readiness steps it follows (host pid + registry entry = 40000ms): a slow-but-ready raw write seam would be read as absent, which is the in-lane failure this criterion exists to rule out.
EXIT=1
```
变异 B`READ_TIMEOUT_MS` 20_000 → 100_000（被庇护的步骤改大而不动预算）：
```
AssertionError [ERR_ASSERTION]: SEAM_READY_TIMEOUT_MS (40000ms) is below the readiness steps it follows (host pid + registry entry = 200000ms): ...
EXIT=1
```
两条均还原，`git status --porcelain` 干净。

**AC5 — 正/负控制（常驻，每个绿轮都跑）。**

```
[readings] positiveControl seamReady=true injectedDelayMs=1500 waitedMs=1500
[readings] positiveControl afterWait wrote=true
[readings] waitFor timed out after 1000ms: negative-control absent seam
[readings] negativeControl seamReady=false budgetMs=1000
```
⇒ 正控制：注入 1500ms 迟到的 seam，等待真的等满 1500ms 后才就绪，随后真实写入 `wrote=true`（这个界不是恒绿）；负控制：seam 根本不发时等待**不**报就绪（配合变异 C/D，缺席仍红）。承重语义未削弱：飞行中改名仍经进程**真实**的 `writeRaw` 发出，`wrote` 断言逐字保留在 `:680` 同一句。

**AC6 — 静态门。** `npx tsc --noEmit -p server/tsconfig.json` exit 0；`npm run lint` exit 0（仅存量 warning）。`git diff --name-status develop...HEAD` 仅判据文件与 `tasks/gap-claude-resident-name-mirror-in-lane-seam-failure.md`，均在 `## Touches` 内；未加 `retries`、未 `skip`、未改判据命令。

**未改生产侧。** 读数显示 seam **会发**（改后 `providerSessionId=set`；改前红态里它也只是在断言瞬间未及可读），只是**来晚**，因此修点落在判据侧的有界等待；`claude-host-driver.provider.ts` 最终未改动（仍在 `## Touches` 内，因为它是 seam 的生产落点、也是变异 D 的落点）。