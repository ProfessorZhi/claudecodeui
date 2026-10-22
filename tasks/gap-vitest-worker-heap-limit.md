---
id: gap-vitest-worker-heap-limit
title: vitest 工作进程堆上限：失控用例在配置层被秒级掐死，不再靠 24G 的 cgroup 兜底、也不因直接 npx vitest 绕过
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（2026-09-25 实测，证据见 `docs/operations/process-isolation-and-memory-caps.md`）：一个失控的 vitest 用例（`chatComposerResponsive.test.tsx`，工作树里一行 `ChatComposer.tsx` 改动）14 秒内长到 12G，在没有上限时 scope 峰值 218.8G/252G，OOM killer 收走了整个 tmux scope，包括 :3001 server。用户 journal 里同一天另有 60G、217.8G、31.9G 三次同形态的 OOM，未逐一定根因。现有护栏 `scripts/with-memory-cap.sh`（默认 24G）只挂在 `npm run test:client` 与 `scripts/test.sh` 的 client 阶段；**直接 `npx vitest run` 不经过它**，9/25 08:58 那次正是这样发生的。且 24G 太宽：失控要吃到 24G 才死，宿主同时还有别人的进程。

方案：在 `vitest.config.ts` 里给 worker 固定 V8 堆上限（vitest 3.2.7 用 `test.poolOptions.forks.execArgv: ['--max-old-space-size=<MB>']`；先在本仓确认默认 pool 确为 forks，若不是则改对应 pool 的选项）。配置层的上限对任何入口（npx、npm run、scripts/test.sh、编辑器插件）一律生效，失控用例在秒级以清晰的 heap-limit 失败，而不是拖垮同 cgroup 的其他进程。

约束与取舍：
1. 上限值必须由实测推出，不许凭感觉：先用 `vitest run --logHeapUsage` 跑一遍完整 client 套件，记下单文件最大堆读数，上限取该读数的 3 倍以上并写明倍数；允许 `QUAY_VITEST_HEAP_MB` 环境变量覆盖（`off` 表示不加参数，供排障与本任务的对照用）。
2. V8 堆上限只约束 JS 堆，不约束 Buffer/external/原生内存；失控若走这些通道，仍由 `with-memory-cap.sh` 的 cgroup 上限兜底。两层是叠加关系，不替换：不得删除或放宽 `with-memory-cap.sh`。
3. 判据的正对照必须有：一个只占用上限 30% 左右的良性用例必须仍然绿，防止上限把正常用例误杀。

## AC

- [x] `bash scripts/vitest-heap-limit-check.sh` 退出 0：脚本用一个临时的「不断保留对象」失控夹具，**直接** `npx vitest run`（不经过 `with-memory-cap.sh`，也不设 `QUAY_MEMORY_MAX`），断言 (a) vitest 退出码非 0，(b) 输出含堆耗尽或 worker 异常退出的证据，(c) 整个进程树的 RSS 峰值（采样 /proc）不超过上限的 1.5 倍，(d) 总墙钟不超过 30 秒。任何一项不满足，判词在同一行带出具体读数与成因。
- [x] 同一脚本的正对照通过：占用约上限 30% 的良性夹具退出 0，判词写出其读到的堆用量与上限。
- [x] 同一脚本的证伪模式 `bash scripts/vitest-heap-limit-check.sh --falsify` 退出非 0：把 `QUAY_VITEST_HEAP_MB=off` 后同一失控夹具越过上限 3 倍（由脚本自己的看门狗在该处杀掉并记为「未受限」），证明判据在没有配置上限时会红，而不是无论如何都绿。
- [x] `node --test scripts/vitest-heap-limit-check.test.mjs` 退出 0：断言脚本的判词分支（受限/未受限/良性误杀/夹具残留）各有一条用例，且脚本结束后 `git status --porcelain` 不含夹具文件（夹具必须在 trap 里清除，包括失败与被信号打断的路径）。
- [x] `npx tsc --noEmit -p scripts/tsconfig.json` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是配置里多了一行。要求 (1) 在完整 client 套件上实跑 `npm run test:client`，退出 0，并把 `--logHeapUsage` 的单文件最大堆读数、所选上限与倍数写进 Evidence；(2) 在一次性工作树里重放 9/25 的原始失控（`ChatComposer.tsx` 去掉 `!hasPendingPermissions` 一处条件后跑 `chatComposerResponsive.test.tsx`）。若能复现，记录它在新上限下多快失败、RSS 峰值多少；若该失控走的是非 JS 堆通道、上限拦不住，如实写出并说明仍由 24G cgroup 兜底，**不得**只用合成夹具就宣称原事故已堵。(3) 文档 `docs/operations/process-isolation-and-memory-caps.md` 增补两层护栏的分工与覆盖变量。实施前先读 AGENTS.md 指向的前端模块规范，本任务只改配置与脚本，不碰 `src/` 业务代码。

该轴仍暗，理由：纯测试基础设施，没有可独立度量的 L_D/L_G 读数；验收以上面的脚本判据与完整套件实跑读数为准。

## Touches

- vitest.config.ts
- scripts/vitest-heap-limit-check.sh (new)
- scripts/vitest-heap-limit-check.test.mjs (new)
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-vitest-worker-heap-limit.md

## Evidence

本轮在该任务自己的工作树 `gap-vitest-worker-heap-limit`（分支 `task/gap-vitest-worker-heap-limit`）上继续：复用前一轮已落地的 1 个提交（`vitest.config.ts` 的上限 + 判据脚本 + 其测试 + 文档），随后 `git merge develop` 全自动合并（无冲突，`ort` 策略），未重做已落地的实现。

**AC-1（判据绿）** — `bash scripts/vitest-heap-limit-check.sh` → **退出码 0**，判词：
```
vitest-heap-limit-check: PASS — 受限：直接 npx vitest run（memcap=unset）下失控夹具退出码=1、墙钟=5167ms、堆耗尽证据=1、整树 RSS 峰值=5107MB≤1.5×6528MB；正对照（目标约上限 30%）退出码=0，读到的堆用量=1360MB（--logHeapUsage 1359MB）上限=4352MB（worker 观测 4544MB=配置 4352MB+192MB）；上限来源=vitest.config.ts
```
四条子断言逐条落位：(a) 退出码 1≠0；(b) 堆耗尽/worker 异常证据=1；(c) 整树 RSS 峰值 5107MB ≤ 1.5×4352=6528MB；(d) 墙钟 5167ms ≤ 30000ms。上限确实**到达 worker**：worker 自报 `heap_size_limit` 4544MB = 配置 4352MB + 实测 V8 差额 192MB。

**AC-2（正对照）** — 同一脚本内，占用约上限 30% 的良性夹具 **退出码 0**，它自报并写入判词的堆用量 = **1360MB**（`--logHeapUsage` 独立读到 1359MB），上限 4352MB ⇒ 既没被杀、也确实占了约 31%。

**AC-3（证伪模式红）** — `bash scripts/vitest-heap-limit-check.sh --falsify` → **退出码 1**：
```
vitest-heap-limit-check: FAIL — 未受限：QUAY_VITEST_HEAP_MB=off 时配置上限 4352MB 没有到达 worker（worker 观测堆上限=17600MB，有上限时应为 4544MB=配置+192MB），失控夹具越过 3×4352=13056MB，由本脚本的看门狗在该处杀掉；RSS 峰值=13174MB 墙钟=6391ms 退出码=137
```
上限关掉后同一个夹具在自己报出的堆上限 17600MB 下越过 3× 参照上限（13056MB），由脚本自己的看门狗在该处收掉 ⇒ 判据在这个输入下确实有观测面，不是「无论如何都绿」。

**AC-4（判词分支用例）** — `node --test scripts/vitest-heap-limit-check.test.mjs` → **退出码 0**，`tests 6 / pass 6 / fail 0`，四个判词分支各一条用例（T1 受限、T2 未受限、T3 良性误杀、T4 夹具残留）+ T5 信号路径 + T6 收尾（`git status --porcelain` 无夹具）。T1/T2 的 RSS 峰值与「越过 3×」由测试自己采样 `/proc` 后代树独立量出，不复述脚本读数。

**AC-5（typecheck + lint）** — `npx tsc --noEmit -p scripts/tsconfig.json` → **退出码 0**；`npm run lint` → **退出码 0**（166 条既有 warning，0 error）。

**DoD(1) 完整 client 套件实跑** — `bash scripts/with-memory-cap.sh npx vitest run --logHeapUsage` → **退出码 0**，`Test Files 103 passed (103) / Tests 725 passed (725)`，Duration 10.68s。单文件最大堆读数 **1398MB**（`src/shared/asr/tests/asrContractInvariants.test.ts`），次高 561MB；上限 4352MB = **3.11×** 该最大值（>3× 下限，且是 3× 之上最紧的一档）。

**DoD(2) 原始失控重放 —— 未复现，如实记录** — 在一次性工作树（`git worktree add --detach`，基线 = 本任务 HEAD）里按 DoD 描述把 `ChatComposer.tsx` 的 tab 守卫去掉（`{!hasPendingPermissions && (` → `{(`）后跑 `chatComposerResponsive.test.tsx`：**退出码 0，整树 RSS 峰值 945MB**，即原封不动。未复现的**原因**是构造性的，不是环境问题：该测试只以 `activity: null`、`pendingPermissionRequests: []` 渲染，`hasPendingPermissions` 恒为 `false`，所以 `!hasPendingPermissions` 恒为 `true` —— 去掉这个守卫后渲染出的是一棵**逐字节相同**的树，守卫什么都不短路（同一改动在 :311 的 `hasPendingPermissions` 分支上同理）。218G/12G 那次失控的**原始复现输入因此不可复原**：记载该改动的 `tasks/gap-mobile-activity-inline-single-stop.md`（:142）只说「把 tab 的 `!hasPendingPermissions` 守卫去掉」，而按此形状在承载该守卫的树上跑不出失控。**故本轮不宣称原事故已被本上限堵住**（DoD 明文禁止只用合成夹具宣称）。

**DoD(2) 补充实测：上限到底拦得住哪条通道**（各以 2G cgroup 作安全网）——
| 通道 | 命令 | 读数 |
|---|---|---|
| JS 老生代（保留对象） | `node --max-old-space-size=300 -e 'for(;;)h.push(new Array(1e6).fill(1.5))'` | **266ms** 中止，rc=134，`FATAL ERROR: Reached heap limit … JavaScript heap out of memory` ⇒ 层 1 单独就停住 |
| Buffer/external | `node --max-old-space-size=300 -e 'for(;;)b.push(Buffer.alloc(32*1024*1024))'` | **越过** 300MB 老生代上限，直到 **52.2s** 才被 2G cgroup 杀掉，rc=137，**无**任何堆耗尽证据 ⇒ 层 1 对此通道失明 |
- 同一类 JS 堆失控注入**真实被测组件**（`ChatComposer.tsx` 渲染期无界保留，非合成夹具文件），经事故点名的那条测试 `chatComposerResponsive.test.tsx` 跑 `npx vitest run`：整轮墙钟 **3.8s** 死在 `FATAL ERROR: Reached heap limit` + `ERR_IPC_CHANNEL_CLOSED`，整树 RSS 峰值 **5162MB**（≤1.5×4352=6528MB）。⇒ 若该测试走的是 JS 堆通道，上限确实秒级停住它。
- 推论边界：本机 node 默认 `heap_size_limit` = **4288MB**（实测 `v8.getHeapStatistics()`），所以**单进程 12G** 不可能是纯老生代通道的结果；原始失控走的是哪条通道**未定**。层 2（24G cgroup）因此仍是那条通道的兜底 —— `scripts/with-memory-cap.sh` 一字未动（`git diff develop -- scripts/with-memory-cap.sh` 空），约束 2 保持。

**DoD(3) 文档** — `docs/operations/process-isolation-and-memory-caps.md` 增补：层 1/层 2 的叠加关系与各自覆盖的入口（含「裸 `npx vitest run` 绕过层 2」这一事故成因）、上限值的实测推导与复算命令、`QUAY_VITEST_HEAP_MB`/`QUAY_MEMORY_MAX`/`QUAY_MEMORY_UNIT`/`QUAY_HEAP_CHECK_SKIP_CLEANUP` 四个覆盖变量的表，以及本轮实测的通道边界与「原始失控不可复原、不得宣称已堵」一段。

**前端模块规范** — 本轮未触碰 `src/` 业务代码（注入失控的那次改动在一次性工作树里，已随该工作树移除；主工作树 `git status --porcelain` 干净）；改动面仅 `vitest.config.ts` + `scripts/` 两个新文件 + `docs/operations/`。

## 完成记录

- 复用既有工作树与既有 1 个提交，未重做实现；`git merge develop` 自动合并（无冲突，无未合并路径）。
- 5 条 AC 逐条以命令读数核对通过，读数见 `## Evidence`。
- DoD(1) 完整 client 套件实跑绿：103 文件 / 725 用例 / 退出码 0，单文件最大堆 1398MB，上限 4352MB = 3.11×。
- DoD(2) 原始失控**未能复现**，且不可复原（该测试的 props 让那个守卫成为 no-op）；按 DoD 要求如实写出，**不宣称**原事故已堵，层 2 仍为其兜底。另附两条通道的实测边界与「真实被测组件」的 JS 堆失控读数。
- DoD(3) 文档已增补两层分工、覆盖变量与上述实测。
- `L_D` / `L_G` 两轴仍暗，理由见 DoD（纯测试基础设施，无可独立度量的读数）。

## Needs-Human

**执行 2026-09-25T05:14:21.675Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: the unmutated copy must clear the whole list before the mutation means anything; it red at AC8 server-branch-scan
- run_id：wk-prod-anchor
- session_id：ba87c226-9b9d-4289-b9e9-c920591cc3b5
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-vitest-worker-heap-limit~wk-prod-anchor~1790313111277-228589.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-vitest-worker-heap-limit-wk-prod-anchor.log
