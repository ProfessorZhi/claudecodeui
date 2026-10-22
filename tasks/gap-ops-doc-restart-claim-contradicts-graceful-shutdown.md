---
id: gap-ops-doc-restart-claim-contradicts-graceful-shutdown
title: 运维文档称「服务重启不再杀掉它托管的会话」，与代码和实测相反：优雅重启（SIGTERM）会停掉所有会话 scope，只有 SIGKILL
  才留下；订正该条并补一节「重启共享服务之前」
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（2026-10-06 取证，journal + 会话转录 + 代码）**：`docs/operations/process-isolation-and-memory-caps.md` 在同一小节里自相矛盾。第 276–277 行写「`shutdownRuntimeServices` 停掉本服务拥有的每个 scope，所以 `serve-scoped.sh stop` 与 `restart` 仍会带走它们的会话」；第 281 行却写「**A server restart no longer kills the sessions it hosts**」。后一句只对被 `SIGKILL` 的服务成立（会话继续跑，直到下一次启动的孤儿清扫），对正常重启是错的，且会误导读它的人以为重启是安全的。

**实测（当天 5 次重启，每次都先 `Stopping claudecodeui-server.service`，随后 `Stopped claudecodeui-session-*.scope` 以约每秒一个的节奏出现，是优雅关闭的特征，不是 OOM）**：

| 时间（CST） | 被停的会话 scope | 触发 |
|---|---|---|
| 08:30:15 | 2 | `db94ee35` 会话写的「detached safe restart」脚本 |
| 08:48:00 | 2 | 同上 |
| 09:01:29 | 4 | 同上 |
| 09:29:21 | 2 | `serve-scoped.sh restart`（`~/.ccui-restart/restart-unit.log`） |
| 10:21:44 | 8 | `db94ee35` 会话的部署脚本（转录里 10:21:40 创建） |

代码侧：`server/index.ts` 的 `process.on('SIGTERM'…)` 与 `process.on('SIGINT'…)` 都调用 `shutdownRuntimeServices`，它停掉本进程拥有的所有会话 scope（`claude-session-scope.service.ts` 头注释：「starts up by sweeping orphaned scopes and shuts down by stopping the scopes this server owns」）。在 `session-hosts` 与 `claude-session-scope.service.ts` 中**没有**找到「新服务接管旧 scope」的逻辑（只有启动时清扫孤儿 scope），所以当前不存在「重启而会话存活」的路径；被停的会话只能靠客户端 `--resume` 重新拉起，进行中的工具调用会被中断（这也是会话里出现「Background shell command didn't finish before the previous session ended」的原因）。

**改动（只改文档）**：①把第 281 行那一条改写成准确语义：优雅停止或重启（SIGTERM/SIGINT，包括 `systemctl --user restart`、`serve-scoped.sh restart`、`scripts/restart-server-detached.sh`）会停掉该服务托管的**全部**会话 scope，规模约每秒一个（8 个会话约 5 秒）；只有服务被 `SIGKILL` 或被 OOM 杀掉时，会话才会暂时留着，等下一次启动的清扫当作孤儿回收，实际上随后也会死，所以「会话存活」不能作为任何操作的前提。②新增小节 `### Before restarting the shared server`，写三条可执行的检查：先 `systemctl --user list-units 'claudecodeui-session-*'` 数一数会影响几个会话；把同一次部署的改动攒成一次重启，不要每个小修复各重启一次（当天一个会话就重启了 4 次）；不要从被重启的服务所托管的会话里发起重启（沿用该文档已有的 `restart-server-detached.sh` 建议，并指向它）。③同一文档里其他暗示「重启不影响会话」的句子一并核对订正。

**不做**：不改任何代码；不实现「重启时会话存活并由新服务接管」——那是需要新增接管能力的设计变更，改动面大，另行评估，不在本任务内；不改 `scripts/serve-scoped.sh`、`scripts/restart-server-detached.sh`。

<!-- dedup-ref -->相关但机制不同：`gap-claude-session-cgroup-scope`（已完成：引入会话 scope 与 `shutdownRuntimeServices` 的停 scope 行为，文档第 276 行的来源）；`gap-session-hosts-lease-driven-lifecycle`（已完成：会话宿主的租约式生命周期，与服务重启时的 scope 回收无关）。

## AC

- [x] AC1 错误断言已删除：`grep -c 'A server restart no longer kills the sessions it hosts' docs/operations/process-isolation-and-memory-caps.md` 的输出为 `0`。
- [x] AC2 准确语义已写入：该文档中，包含 `SIGTERM` 的段落同时出现 `every` 或「全部」字样与 `serve-scoped.sh restart`；并且出现 `SIGKILL` 与 `orphan` 字样（说明只有 `SIGKILL`/OOM 才暂时留下会话，之后由清扫回收）：`grep -nE 'SIGTERM' …` 与 `grep -nE 'SIGKILL.*orphan|orphan.*SIGKILL' …` 各至少 1 处。
- [x] AC3 新小节存在且可执行：`grep -c '^### Before restarting the shared server' docs/operations/process-isolation-and-memory-caps.md` 为 `1`；该小节内至少 3 个以 `- ` 或 `1.` 开头的条目，且含字面量 `list-units 'claudecodeui-session-*'` 与 `restart-server-detached.sh`。
- [x] AC4 文档断言与代码前提一致（落地时的漂移守卫，不是新测试）：`grep -c "process.on('SIGTERM', () => void shutdownRuntimeServices())" server/index.ts` 的输出为 `1`，`grep -c "process.on('SIGINT', () => void shutdownRuntimeServices())" server/index.ts` 的输出为 `1`。
- [x] AC5 同文档没有残留的、与新语义冲突的句子：`grep -nEi 'restart.{0,40}(no longer|does not|doesn.t) (kill|take|stop)|sessions? (survive|outlive).{0,30}restart' docs/operations/process-isolation-and-memory-caps.md` 无输出（grep 退出码 1）。
- [x] AC6 范围受控：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列；其中不含 `server/` 下任何文件，也不含 `scripts/`。

## DoD

文档里每一条关于行为的断言，都要能在代码或 journal 里找到对应的读数，完成记录要贴出：①`server/index.ts` 里 SIGTERM/SIGINT 两行的行号；②`shutdownRuntimeServices` 内停 scope 的调用位置；③当天 5 次重启的 journal 计数表（上表）至少被引用一次，作为「优雅重启会停会话」的实测依据。真实落地的检验是：由一位**没有参与撰写**的人（或会话）只读这份文档，回答「我现在重启共享服务，会话会怎样」，答案必须是「全部被停，之后要靠恢复」；把这次问答原文贴进完成记录。未验证项：「被停的会话是否都会被客户端自动恢复」取决于客户端行为，文档只写已观察到的现象（当天重启后有部分会话被重新拉起），不做保证性表述。

## Touches

- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-ops-doc-restart-claim-contradicts-graceful-shutdown.md

## 完成记录

**结论：文档已订正为准确语义；错误断言删除，新增可执行小节。**

改动一个文件、不新增源文件：`docs/operations/process-isolation-and-memory-caps.md`（+28/-4 行）。未碰任何代码（`server/`、`scripts/` 均为空 diff），符合「不做」约束。

### ① SIGTERM/SIGINT 两行行号（`server/index.ts`）

- L983 `process.on('SIGTERM', () => void shutdownRuntimeServices());`
- L984 `process.on('SIGINT', () => void shutdownRuntimeServices());`

（`grep -c` 各为 1，即 AC4。）

### ② `shutdownRuntimeServices` 内停 scope 的调用位置

`server/index.ts` L959：`const stoppedSessionScopes = stopClaudeSessionScopes();`（在 `shutdownRuntimeServices`（定义于 L913–L982）的 try 块内，紧接关闭 session hosts 之后）。该调用停掉本进程拥有的每个会话 scope，因此优雅 stop/restart 会带走全部托管会话。

### ③ journal 计数表（实测依据）

2026-10-06 当天 5 次重启（每次先 `Stopping claudecodeui-server.service`，随后 `Stopped claudecodeui-session-*.scope` 以约每秒一个出现）：

| 时间（CST） | 被停的会话 scope | 触发 |
|---|---|---|
| 08:30:15 | 2 | `db94ee35` 会话写的「detached safe restart」脚本 |
| 08:48:00 | 2 | 同上 |
| 09:01:29 | 4 | 同上 |
| 09:29:21 | 2 | `serve-scoped.sh restart`（`~/.ccui-restart/restart-unit.log`） |
| 10:21:44 | 8 | `db94ee35` 会话的部署脚本 |

复核读数：`journalctl --user --since "2026-10-06 00:00:00" | grep 'Stopping claudecodeui-server.service'` 列出的时间含上表全部 5 个；`journalctl --user --since "2026-10-06 10:21:00" --until "2026-10-06 10:22:31" | grep -cE 'Stopping .*claudecodeui-session-.*\.scope'` = `8`，与表中 10:21:44 的 8 一致。该表以「五次重启 08:30–10:21 各停 2–8 个 scope，最大一次 8 个约 5 秒」写入文档，作为「优雅重启会停会话」的实测依据。

### 独立读者问答（DoD 的落地检验）

由一位**未参与撰写**的会话（只读该文档、未被告知答案）回答「我现在重启共享服务，会话会怎样」，原文：

> Restarting the shared :3001 server ends every session it hosts. The document states: "A graceful stop or restart ends **every** session this server hosts (see `### Resident scopes` below for why), and nothing comes back afterwards except what a client re-`--resume`s." It also says: "So `systemctl --user restart`, `serve-scoped.sh restart`, and `scripts/restart-server-detached.sh` all take **every** hosted session with them, at roughly one scope per second." Only a client that re-`--resume`s restores anything.

结论符合 DoD 要求的「全部被停，之后要靠恢复」。

### AC 复核读数

- AC1 `grep -c 'A server restart no longer kills the sessions it hosts' <doc>` = `0`。
- AC2 `grep -cE 'SIGTERM' <doc>` = 1（L300），该段落含 `every`（3 处）与 `serve-scoped.sh restart`；`grep -nE 'SIGKILL.*orphan|orphan.*SIGKILL' <doc>` = 1（L305）。
- AC3 `grep -c '^### Before restarting the shared server' <doc>` = `1`；该小节内 3 个 `- ` 条目；含 `list-units 'claudecodeui-session-*'` 与 `restart-server-detached.sh`。
- AC4 两条 `grep -c` = 1 / 1。
- AC5 冲突正则无输出（grep 退出码 1）。
- AC6 `git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ {`docs/operations/process-isolation-and-memory-caps.md`, `tasks/gap-ops-doc-restart-claim-contradicts-graceful-shutdown.md`}（= Touches），不含 `server/`、`scripts/`。

### 未验证项（照 DoD 声明）

被停的会话是否都会被客户端自动恢复取决于客户端行为，文档只写已观察到的现象（当天重启后有部分会话被重新拉起），不做保证性表述。
