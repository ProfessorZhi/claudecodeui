---
id: gap-claude-session-cgroup-scope
title: 每个 Claude 会话进自己的 systemd scope 并带内存上限：失控的 claude/MCP 只杀该会话，不再拖垮 server
  所在的 cgroup
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-false-forms-siblings-pid-attribution
---
## Proposal

人（yale）2026-09-25 已批准：允许改动 provider 的 spawn 路径，用 `systemd-run --user --scope` 包装 claude；无 systemd user manager 的环境必须降级为今天的行为。

背景（2026-09-25 现场实测）：`claudecodeui-server.service` 这个 unit 里，server 自身只有约 224MB RSS，而每个 Claude 会话子树（claude 主进程加 pdf、playwright 等 MCP，外加 `npm exec` 包装进程）约 1GB，整个 unit 当时 1.35GB。server 与所有会话在同一个 cgroup 内，`memory.max = max`，所以任何一个失控的 Claude 会话或 MCP 触发的 OOM，会由内核按 unit 收走，server 一并陪葬。这是 cgroup 隔离（`ade2dfb4`）之后下一个会发生的事故形态：那次只把「测试」与「server」分开了，没有把「会话」与「server」分开。

方案：
1. 新增 `server/modules/providers/services/claude-session-scope.service.ts`，导出一个工厂，返回 SDK 的 `spawnClaudeCodeProcess` 钩子（见 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `SpawnOptions`/`SpawnedProcess`）。钩子把命令改写成 `systemd-run --user --scope --quiet --unit=claudecodeui-session-<serverPid>-<随机> -p MemoryMax=<cap> -p MemorySwapMax=0 -- <command> <args>` 后用 `child_process.spawn` 启动，cwd、env、signal 原样透传。`systemd-run --scope` 会在同一 PID 上 exec 目标命令，所以 stdio 与退出语义不变（`scripts/with-memory-cap.sh` 已依赖这一点）。
2. 首次使用时探测一次并缓存：真实地在一个带上限的 scope 里跑一次 `true`（`systemd-run` 失败与命令失败无法靠退出码区分，探测必须是真实执行）。探测不通过时工厂返回 `undefined`，**不设置** `spawnClaudeCodeProcess`，行为与今天逐字节相同，并只打一行说明日志。
3. 上限：`CLAUDE_SESSION_MEMORY_MAX`，默认 8G（实测空闲会话子树约 1.1GB，取 7 倍以上余量；实施者用真实会话重测并写明），`off` 表示不包装。
4. 接线只在 `server/modules/providers/list/claude/claude-runtime.provider.js` 的 `mapCliOptionsToSDK`（约 220-320 行）加一处。新逻辑全部放在上面的 TS 文件里；不要往该 `.js` 里堆逻辑。
5. **必须处理的后果：scope 不在 server 的 unit cgroup 里。** 今天 `serve-scoped.sh stop` 靠 cgroup 收掉所有会话子进程；改用 scope 后它们不会被一起收掉，SIGTERM 的 `shutdownRuntimeServices`（`server/index.ts` 约 389 行）目前也不中止会话。所以要 (a) 在 `shutdownRuntimeServices` 里停掉本 server 拥有的所有 `claudecodeui-session-<serverPid>-*` scope，(b) 启动时清扫「属主 server PID 已不存在」的孤儿 scope（server 被 SIGKILL 时 (a) 不会执行），(c) 记录在案：server 重启不再顺带杀死其托管的会话。
6. 会话进程被 cgroup 上限 OOM 杀死时，SDK 侧看到的只是进程退出；用与 `scripts/test.sh` 相同的办法（`journalctl --user -u <unit>.scope | grep 'OOM killer'`）查一次，命中就打一行 console.error 点名「该会话被内存上限 <cap> 杀死」。journal 不可读时静默，属已知缺口。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts` 退出 0，其中在本机**真实**使用 `systemd-run --user --scope` 的用例不得被跳过（用例内先断言探测为真，探测为假则该用例判红而不是 skip，避免在本机静默变空）：(a) 一个吃内存超过 `MemoryMax=64M` 的子进程只被它自己的 scope 杀死，同时活着的兄弟进程不受影响；(b) 钩子生成的 argv 含 `--scope`、`-p MemoryMax=`、`-p MemorySwapMax=0` 与 `claudecodeui-session-` 前缀的 unit 名；(c) cwd、env、signal 透传（abort signal 触发后子进程退出）。
- [x] 同一测试文件的降级用例：以一个假的 `systemd-run`（PATH 前置，恒失败）跑探测，工厂返回 `undefined`，且 `mapCliOptionsToSDK` 返回的选项里**没有** `spawnClaudeCodeProcess` 键；`CLAUDE_SESSION_MEMORY_MAX=off` 同样如此。
- [x] 同一测试文件的生命周期用例：起 3 个会话 scope，调用新导出的停止函数后 `systemctl --user list-units 'claudecodeui-session-*'` 为空；再造两个属主 PID 已不存在的孤儿 scope（unit 名里编码一个已死 PID），清扫函数只停掉孤儿、不动属主仍存活的 scope。
- [x] 同一测试文件的 OOM 归因用例：被上限杀死的 scope 触发一条点名上限值的日志；被正常退出的 scope 不触发。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 与 `server/modules/providers/tests/claude-background-work.test.ts` 退出 0（既有 runtime 用例不回归）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries：新文件只经模块 barrel 被外部消费；若 `server/index.ts` 需要停止/清扫函数，则通过 `server/modules/providers/index.ts` 导出）。

## DoD

真实落地判据，不是「有一个钩子」：用真实 claude 二进制与真实 SDK 在本机跑一次端到端。(1) 用临时 `DATABASE_PATH`、非 3001 端口启动一个真实 server（**不得重启 :3001**，见记忆中「会话是服务子进程」一条），经真实 WebSocket 发起一个真实会话，读到 `systemctl --user list-units 'claudecodeui-session-*'` 里出现对应 scope、`memory.max` 等于配置值、`cat /sys/fs/cgroup/.../cgroup.procs` 含 claude 及其 MCP 子进程；(2) 在该会话内让某个子进程失控吃内存（或对该 scope 设一个很低的上限重跑），读到该会话被杀、**server 进程与另一个并行会话都存活**、并出现点名上限的日志；(3) 对该 server 分别 SIGTERM 与 SIGKILL，读到前者立即无残留 scope、后者在下次启动的清扫后无残留；(4) 把 (1)-(3) 的关键读数写进 Evidence。AC 全绿但没有这次端到端操作不算完成。文档 `docs/operations/process-isolation-and-memory-caps.md` 增补「会话 scope」一节，并把其中「server 无上限」的表述与新的边界对齐。实施时按 `.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范落位。

该轴仍暗，理由：纯服务端进程管理，没有可独立度量的 L_D/L_G 读数；验收以上面的集成用例与端到端运行读数为准。

## 完成记录

**本条做了什么。** 逻辑全部落在新增的 `server/modules/providers/services/claude-session-scope.service.ts`：导出一个工厂，返回 SDK 的 `spawnClaudeCodeProcess` 钩子，把命令改写成 `systemd-run --user --scope --quiet --unit=claudecodeui-session-<serverPid>-<suffix> -p MemoryMax=<cap> -p MemorySwapMax=0 -- <command> <args>`，cwd / env / abort signal 原样透传。`mapCliOptionsToSDK` 只加了一处接线；工厂返回 `undefined` 时**不设**该键，spawn 路径与从前逐字节相同，并只打一行说明日志。上限 `CLAUDE_SESSION_MEMORY_MAX`，默认 `8G`，`off`/`0` 不包装；探测靠真实地在一个带上限的 scope 里跑一次 `true`（`systemd-run` 失败与命令失败无法用退出码区分），结论缓存。scope 不在 server 的 unit cgroup 里 —— 这正是隔离的来源，也意味着 server 消失时没人收它 —— 所以同时做了两件事：`shutdownRuntimeServices` 停掉本 PID 拥有的 scope；启动时清扫「unit 名里编码的属主 PID 已死」的孤儿 scope。OOM 归因照 `scripts/test.sh` 的办法查 `journalctl --user -u <unit>.scope`，命中打一行点名上限的日志；journal 不可读时静默（已知缺口）。

**AC 判据入口（落地后的树，全部 exit 0）**

| AC | 命令 | 读数 |
|---|---|---|
| AC1–AC4 | `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts` | exit 0；`tests 9 / pass 9 / fail 0 / skipped 0 / todo 0`，`duration_ms 4879`，真机用例未被 skip |
| AC5 | `claude-runtime-frame-forwarding.test.ts` + `claude-background-work.test.ts`（同上入口） | exit 0；`tests 15 / pass 15 / fail 0` |
| AC6 | `npm run typecheck` / `npm run lint` | 两条都 exit 0；typecheck 跑满三个 tsconfig；lint 只有既有 warning，无 error |

9 个用例里有三条走**真实** `systemd-run --user --scope`（运行输出里可见真实 unit 名与真实被杀）：`a session over its cap dies alone; a live sibling is untouched`（1054ms，真机 64M 上限）、`the hook passes cwd, env and the abort signal to the real scope`（150ms）、`a cap kill names the cap; a non-OOM failure does not`（2543ms，输出含 `[claude-session-scope] session killed by the memory cap 64M (unit claudecodeui-session-3898154-e89932ae.scope)`）。降级两条分别走 PATH 前置的恒失败假 `systemd-run` 与 `CLAUDE_SESSION_MEMORY_MAX=off`，运行时各打一行 `no usable systemd user manager; Claude sessions run uncapped`。

**DoD (1) 真实会话进自己的 scope。** 临时 `DATABASE_PATH`、端口 3999（`:3001` 全程未重启），经真实 WebSocket 发起真实会话：

| 读数 | 值 |
|---|---|
| unit | `claudecodeui-session-3694513-c9f4944e.scope` |
| `memory.max` | `8589934592`（= 默认 8G） |
| `memory.current` / `memory.peak` | `367239168` / `484433920` |
| `cgroup.procs` | 真实 `claude` PID 3694712 + 3 个 MCP 子进程 + 该会话自己的 Bash `sleep 900` |

另一次以 `CLAUDE_SESSION_MEMORY_MAX=700M` 启动（端口 3998）的读数：scope 的 `memory.max = 734003200`，**等于配置值**；两个并行会话各自 `memory.current = 408367104` / `394231808`。真实会话子树约 390–470MB，这是默认取 8G 的依据。

**DoD (2) 会话被杀，server 与并行会话都存活。** 两腿：

- **配置上限直接杀**（`CLAUDE_SESSION_MEMORY_MAX=300M`，端口 3997）：scope `claudecodeui-session-3589395-bac8cf57.scope`，`memory.max=314572800`，`memory.current` 由 `200085504` → `243421184` → `308408320` 后被 OOM 收走。journal：`A process of this unit has been killed by the OOM killer.` + `Failed with result 'oom-kill'`。server PID 3589395 **存活**。日志：`[claude-session-scope] session killed by the memory cap 300M (unit claudecodeui-session-3589395-bac8cf57.scope)`。WS 侧先 `error` 后 `complete exitCode=1 success=false`。无残留 scope。
- **并行会话存活**（`CLAUDE_SESSION_MEMORY_MAX=700M`，端口 3998，两个真实会话）：两个 scope 的 `memory.max` 都是 `734003200`。对**其中一个** scope 用 `systemctl --user set-property … MemoryMax=250M` 下调后：`victimClaudeKilled=true`、`survivorClaudeSamePid=true`、`serverAlive=true`；受害 scope 被整体回收（`cgroup.procs` 为空），幸存 scope 在杀前杀后**逐字节相同**（`memory.current=408367104`，claude PID 3658707 未变）；journal 只在受害 unit 上有 OOM 记录，幸存 unit 一条都没有；日志 `[claude-session-scope] session killed by the memory cap 700M (unit claudecodeui-session-3169086-7eacf631.scope)`。
  **如实标注**：这一腿里生效的上限是我下调到的 250M，而日志点名的是该会话**配置**的 700M —— 归因日志读的是会话自己的配置值，不是运行期被改过的 `memory.max`。「配置上限直接杀死会话并点名该值」的读数由上一腿（300M）给出。

**DoD (3) 生命周期：SIGTERM 无残留，SIGKILL 的残留由下次启动清扫。**

| 步骤 | 读数 |
|---|---|
| SIGTERM（server 3694513，scope 里有活的 8G 会话） | 该 PID 名下 scope 变为 `[]`；日志 `[Sessions] Stopped 1 Claude session scope(s)`；server 退出 |
| SIGKILL（server 3811737，scope 里有活会话） | **孤儿存活**：`claudecodeui-session-3811737-951a158a.scope` 仍在，仍持有活的 claude，`memory.current` 长到 `465838080` |
| 下一次启动（server 3818711） | `[INFO] Swept 1 orphaned Claude session scope(s): claudecodeui-session-3811737-951a158a.scope`；孤儿消失；**另一个仍在运行的 server** 的会话 scope（`claudecodeui-session-3169086-62bccb91.scope`）原封不动 |

**文档。** `docs/operations/process-isolation-and-memory-caps.md`：标题与「两道防线」表补入 Claude 会话一行；新增 `### Session scopes: claude-session-scope.service.ts` 一节（argv、上限/unit 名/降级表、生命周期后果 —— 含「server 重启不再顺带杀死其托管的会话」、died-on-its-own scope 需 `reset-failed`、journal 归因）；并把「server 无上限」的表述与新的边界对齐：systemd user service 对其 `ExecStart` 之后自己 fork 出来的进程不是 cgroup 边界，隔离是从会话离开该 cgroup 才开始的。

**测量环境。** 真实 server（`node_modules/.bin/tsx server/index.ts`）+ 真实 claude 二进制 + 真实 WebSocket；临时 `DATABASE_PATH=/tmp/sscope/data/auth.db`；端口 3994–3999，`:3001` 未重启。观测 token 由 `scripts/mint-token.mjs` 一次性签发，四条 subject 用完已 `revoke` 并各自验证 `GET /api/auth/user → 401`。并行会话那一腿额外用 `sleep 900` 的 keeper 把两个 scope 都撑住，让读数不依赖模型回合的长短；它是观测辅助（几百 KB），不是被测行为（其余读数里 scope 内的 `sleep 900` 是会话自己的 Bash 调用）。harness 全部在 `/tmp/sscope`（仓外）；退出前已停掉全部测试 server、采样器与 keeper，`systemctl --user list-units 'claudecodeui-session-*'` 为空。


## Touches

- server/modules/providers/services/claude-session-scope.service.ts (new)
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/index.ts
- server/index.ts
- server/modules/providers/tests/claude-session-scope.test.ts (new)
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-claude-session-cgroup-scope.md

## Needs-Human

**执行 2026-09-25T05:20:35.319Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=26702 server/modules/debug-agent/tests/debug-agent-external-write.test.ts passed=false end_ms=1790313528133
- run_id：wk-prod-anchor
- session_id：d0fc82e0-c63d-43eb-a3b2-9d63b17b7d78
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-session-cgroup-scope~wk-prod-anchor~1790313469198-1bdab7.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-session-cgroup-scope-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-25T10:17:05.447Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=29759 server/modules/voice/tests/voice-capture-text.false-forms.test.ts passed=false end_ms=1790331332699
- run_id：wk-prod-anchor
- session_id：b5584087-3db1-499d-bfed-2b7f0c027f64
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-session-cgroup-scope~wk-prod-anchor~1790331249354-d7370c.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-session-cgroup-scope-wk-prod-anchor.log
