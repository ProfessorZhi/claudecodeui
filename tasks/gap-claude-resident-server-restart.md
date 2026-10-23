---
id: gap-claude-resident-server-restart
title: AC-166 服务停止或被杀后不留常驻进程 — 真服务进程（临时 DATABASE_PATH 并 /proc environ 核对、HOST
  固定、kill 进程组、不碰 :3001）+ mock 端点：(1) SIGTERM ⇒ 常驻进程退出且
  closeReason=server-shutdown；(2) SIGKILL ⇒ 下次启动清扫后无残留进程与 scope；(3) 重启后会话仍
  resident、宿主接口读到未运行与重启原因；(4) 下次 chat.send 拉起新 pid；60 秒预算守卫超时 exit 3；假形态（启动不清扫且
  CLI 不因 EOF 退出）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
  - gap-session-hosts-lease-driven-lifecycle
  - gap-session-hosts-rest-list-endpoint
  - gap-claude-session-cgroup-scope
goal_ac: AC-166
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-166" tasks/*.md | wc -l` → **0**；`grep -rln "AC-166" tasks/*.md | wc -l` → **0** —— 不是「未认领」，是**全库零命中**：连任何邻居任务的**非目标**段里都没点过 AC-166。代码侧：`grep -rn "lifecycle_mode" server/ --include=*.ts --include=*.js | wc -l` → **0**；`ls server/modules/providers/list/claude/ | grep -c "claude-host-driver.provider.ts"` → **0**（无 resident driver）；`grep -rn "lifecycle_mode\|notRunning\|restart" server/modules/session-hosts/session-hosts.routes.ts | wc -l` → **0**（宿主接口今天没有「未运行 + 原因」这一面）；判据文件 `server/modules/session-hosts/tests/resident-server-restart.test.ts` 不存在（`ls` → `No such file or directory`）。⇒ AC-166 无认领者，本条不是重复。

<!-- dedup-ref --> 邻居让位逐字在案（下面这条**前置**写进顶层 `depends_on`）：`gap-claude-resident-process-survival`（AC-161，**ready**，resident driver 的**进程存活**面：同 pid 跨轮、abort 只 interrupt、`POST /api/session-hosts/:sessionId/close` 走 stdin EOF 且 `closeReason=user`，并落 `sessions.lifecycle_mode` 列、分派接线与 claude 的 `'resident'` 能力位；它的判据是 `server/modules/providers/tests/claude-resident-process.test.ts`，**不杀服务、不重启、不读重启原因**）。已 done 的三条是本条判据脚下的**能力面**——它们都没有「常驻会话」可谈，故不构成认领：`gap-session-hosts-lease-driven-lifecycle`（AC-157）落 `manager.shutdown()` → 对每个 host `closeHost(hostId,'server-shutdown')`，但判据用**伪 driver、in-process**（`server/modules/session-hosts/tests/session-host-lifecycle.test.ts:555`）；`gap-session-hosts-rest-list-endpoint`（AC-156）落 `GET /api/session-hosts` 的 `HostView` 投影，只列**活着的** host；`gap-claude-session-cgroup-scope`（done）落 scope 包装与**启动清扫** `sweepOrphanClaudeSessionScopes()`（`server/index.ts:379` 调用；`server/modules/providers/services/claude-session-scope.service.ts:454`），其 DoD 只读到「无残留 scope」。`gap-claude-resident-idle-close`（AC-165，todo）是**空闲关闭**（伪 SDK 流 + 注入钟、in-process，判据在 `server/modules/providers/tests/claude-resident-idle.test.ts`），机制是「无保活理由时的到期关闭」，与「服务被杀/重启」无关；AC-162/163/164（无人轮 / 忙时输入 / 可寻址）同样无关。⇒ 本条认领的是它们都让出的那一格：**服务边界本身**——SIGTERM 让常驻进程真的退出并记 `server-shutdown`，SIGKILL 留下的残留在下次启动被清扫，重启后会话仍 `resident` 且宿主接口读到「未运行 + 重启原因」，下一次 `chat.send` 拉起**新** pid。

**来源与判据物。** AC 逐字（`goals/AC-166-服务停止或被杀后不留常驻进程-重启后会话仍是常驻-显示已随重启关闭-下一次发送重新拉起.md` 的 `criterion:`）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts`（命令逐字含文件路径，不用 glob）。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/resident-server-restart.test.ts'`。

**现状（本轮实测的读数）——停机/启动两侧的**能力**已就位，缺的是「真服务进程 + 常驻会话」这条读数链，以及重启后的「未运行 + 原因」面。**

- **停机侧已有**：`server/index.ts:439` `await sessionHostManager.shutdown({ timeoutMs: SESSION_HOST_SHUTDOWN_TIMEOUT_MS })`（`:302` = `5_000`ms；`shutdown()` 内部对每个未关闭 host 走 `closeHost(host.hostId,'server-shutdown')`，`session-host-manager.service.ts:1161`），`SIGTERM`/`SIGINT` 都接（`:454-455`）；同处 `:423` 还会 `stopClaudeSessionScopes()`。`'server-shutdown'` 已在 `HOST_CLOSE_REASONS`（`server/shared/types.ts:1770`）。
- **启动侧已有**：`:379` `sweepOrphanClaudeSessionScopes()`，只停「属主 PID 已不存在」的 scope（`isProcessAlive(ownerPid)`），并打日志 `Swept N orphaned Claude session scope(s)`（`:381`）。
- **但这些都还没被一个常驻会话穿过**：无 resident driver（AC-161 未落地）⇒ 今天没有任何东西会让 `shutdown()` 的 `server-shutdown` 分支真的作用在常驻进程上；`lifecycle_mode` 列也不存在 ⇒ 重启后无从判断「这个会话本来是不是常驻」。
- **「未运行 + 重启原因」这一面零命中**：`HostView` 只列活着的 host（`session-hosts.routes.ts:23-33`），重启后宿主表为空 ⇒ 该会话在接口里**根本不出现**，读不到 `running=false`，更无原因字段。
- **scope 名不带会话 id**：`buildClaudeSessionScopeUnitName(ownerPid, crypto.randomBytes(4).toString('hex'))`（`claude-session-scope.service.ts:318`）⇒ 清扫**不能**把孤儿 scope 归因到某个会话。(2) 的「无残留」只能按**进程 pid** 与**属主前缀**读（见 AC4），不能靠 unit 名。
- 真实二进制在位：`which claude` → `/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude`。
- **E5 实测（proposal `docs/proposals/claude-resident-sessions.md` §10 `:376-378`，2026-09-25）**：扮演服务进程的父进程被 `SIGKILL` 后，常驻 `claude` **120 秒内不退出**（不因 stdin EOF 自行退出）⇒ (2) 的承载面**实际上只能是启动清扫**；「CLI 自己因 EOF 退出」是另一条分支，读到就记、读不到不算失败。这条读数直接决定假形态怎么取（AC8）。

**要建的东西（本条的最小充分集）：**

1. **「未运行 + 重启原因」的宿主接口面**（本条真正的产品代码）：重启后，一个 `lifecycle_mode='resident'` 的会话必须在 `GET /api/session-hosts` 上以 `running=false` + **非空**原因出现。做法由实施者定，但两条要遵守并把理由写进完成记录：(a) 该 endpoint 的 docstring 逐字写着「deliberately does not import `chatRunRegistry` or touch the database」——要读 resident 会话清单就得改这条设计（或新增一个面），**改要给出理由、不改要给出读数**；(b) 原因是**派生**值（proposal 原则 1：宿主/绑定/保活理由都不入库），实施者新增一个常量（名字自定，例如 `residentNotRunningReason`），取值须在判据里以**同一常量**打印并在完成记录写明，不要两边各写一遍字面量。
2. **判据文件** `server/modules/session-hosts/tests/resident-server-restart.test.ts`（新）：**真服务进程**（`tsx --tsconfig server/tsconfig.json server/index.ts` 子进程；`HOST` 钉 `127.0.0.1`；端口用 `listen(0)` 探得的空闲口且断言 `!== 3001`；临时 `DATABASE_PATH` 并在动任何东西前用 `tr '\0' '\n' </proc/<pid>/environ` 证明；日志走文件 fd 不走管道；`detached:true` + `process.kill(-pid, …)` 杀**整个进程组**）+ mock Anthropic 兼容端点（按请求体贴合 AC-161 的形状）+ 经 `scripts/mint-token.mjs` 对**临时**库铸 token（`/api/session-hosts` 在 `authenticateToken` 之后）+ 真 `chat.send`。逐条见 AC。
3. **不改既有行为**：`shutdown()` 的 `5_000`ms 宽限、`'server-shutdown'` 词表、清扫只碰「属主已死」的 scope、per-run 会话的客户端可见行为，逐条不变。

**已知陷阱（写在案，省一轮）**：本 shell 已导出 `HOST=172.28.0.1`，不钉 `127.0.0.1` 会绑到不可连地址、探活循环到超时；`tsx` 把 server 跑成**孙进程**，`server.kill('SIGKILL')` 只杀 wrapper ⇒ 必须 `detached:true` + 负 pid，且日志给文件 fd（走管道会让正确的运行以 timeout 的 124 结束）；本 shell 还导出 `DATABASE_PATH=<真实用户库>`，只改 `HOME` 不够（`connection.ts` 优先该 env）⇒ 必须显式覆盖并用 `/proc/<pid>/environ` 证明；临时 `CLAUDE_CONFIG_DIR` 若是空的会落进首启向导三屏（主题→安全→bypass）卡住 CLI，要么从既有 config 目录复制最小片段、要么确认 SDK 的 headless 路径不走向导。

**非目标**：AC-161 的 resident driver 本体、分派接线、`lifecycle_mode` 列、`POST /api/session-hosts/:sessionId/close` 路由（本条只在它们落地后于其上补**服务边界**）；AC-165 的空闲关闭与保活理由；AC-162/163/164；AC-169 的 API 开关与能力矩阵约束；前端 / e2e / `cloudcli` 子命令。既有 per-run 判据与宿主层判据是硬约束，一字节不动。

## Plan

1. 读 AC-161 落地后的 resident driver / 分派 / `lifecycle_mode` 列与 `session-hosts.routes.ts` 的实际形状，确认接缝，**不重复造**已有字段。
2. 落「未运行 + 重启原因」的宿主接口面（含新常量），`npm run typecheck` 绿。
3. 写判据：真服务进程 + mock 端点 + 临时库 + `/proc` 校对 + 进程组杀 + 两段（SIGTERM / SIGKILL→重启）+ 重启后接口读 + 重新拉起 + 60s 进程级守卫。
4. 实测假形态（启动不清扫 + driver 不因 EOF 退出），抄退出码与红态文案，`git checkout --` 还原。
5. `npm run typecheck`、`npm run lint`、既有判据全绿；写完成记录。

## AC

- [x] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`，打印整体墙钟 `elapsed-ms=<n>` 且 `< 60000`。红态基线本轮实测：同命令退出 **1**、文案逐字 `Could not find 'server/modules/session-hosts/tests/resident-server-restart.test.ts'`。命令逐字含文件路径，不用 glob。
- [x] AC2 判据驱动的是**真服务进程**（不是 in-process 装配）：打印 `server-boot pid=<n> port=<n> log=<path>`，且 (a) 端口 `!== 3001`（正控制：本 shell 导出的 `SERVER_PORT=3001` 不得被继承）、(b) `tr '\0' '\n' </proc/<pid>/environ` 里能看到**临时** `DATABASE_PATH` 与 `HOST=127.0.0.1`（打印命中行），(c) 判据文件里没有「就地改 `process.env.DATABASE_PATH` 再跑本进程」的 in-process 装配（`grep -c "process.env.DATABASE_PATH *=" <判据文件>` → 0）。
- [x] AC3 (1) 正常停止：先从 `GET /api/session-hosts` 读到该常驻宿主 `pid=<a>` 且 `/proc/<a>` 存在（**正控制**：「当时活着」不是恒真），再对服务**进程组**发 `SIGTERM`；打印 `sigterm resident-pid=<a> alive-before=true gone-after-ms=<n> closeReason=<…>`，其中 `closeReason` 逐字为 `server-shutdown`、`/proc/<a>` 在宽限期内消失（`<n>` 有值）。
- [x] AC4 (2) 被杀：新起一轮（新服务进程 + 新常驻会话，读到 `pid=<b>`），对服务进程组发 `SIGKILL`；打印 `sigkill survivor=<true|false>`（E5 预期 `true`）与下次启动的清扫读数 `swept=<n>`（`n>=1`），并断言**下次启动后** `/proc/<b>` 不存在，且 `systemctl --user list-units 'claudecodeui-session-<被杀服务 pid>-*'` 为空（打印该命令的输出）。两种分支都接受（EOF 自退 **或** 被清扫），但**最终读数必须是无残留**；若系统无 systemd user manager（该探针为假），该例按 scope 面跳过并**打印 `systemd=false`**，只读 `/proc/<b>` 不存在——不得静默变绿。
- [x] AC5 (3) 重启后仍是常驻且接口读到「未运行 + 原因」：重启后的服务进程上 `GET /api/session-hosts` 读到该会话 `lifecycle_mode=resident`、`running=false`、原因**非空**（打印逐字字段名与值；原因常量与实现同源）。**正控制**：同一读里一个 per-run 会话的原因字段为 `null`——保证该字段不是恒真。若实施者把该面放在别的路径（如会话列表），打印实际路径并在完成记录写明理由；`/api/session-hosts` 仍是首选读数面。
- [x] AC6 (4) 下一次发送拉起新 pid：重启后对**同一会话**发一条真 `chat.send`，打印 `old-pid=<a> new-pid=<c> distinct=true`，且 `/proc/<c>` 存在、`<c> !== <a>`；宿主快照在该会话上重新出现（打印 `running=true`）。
- [x] AC7 判据自带 **60 秒进程级预算守卫**：打印 `budget-ms=60000 elapsed-ms=<n>`；守卫的**阈值**是承重的、不是恒真：把预算判定抽成纯函数并在判据内断言 `guard({elapsedMs: 60001, budgetMs: 60000}) === 3` 与 `guard({elapsedMs: 0, budgetMs: 60000}) === 0`（打印两个返回值）。超预算时以 `process.exit(3)` 退出（不是 node:test 的 case failure）。
- [x] AC8 假形态承重（**判据文件一字不动**，源上改一处、实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原）：把 (a) 启动清扫改为 no-op（`server/index.ts:379` 的调用点短路）**且** (b) resident driver 的 `closeHost` 不再结束输入队列（即 CLI 不因 EOF 退出，正是 E5 的实测行为）⇒ AC4 的 (2) 必须**红**（`/proc/<b>` 仍在 或 `swept=0`）。**正控制**：还原后同一条 AC4 读数必须回到绿。
- [x] AC9 不使既有判据变红（逐条打印命令与退出码）：`server/modules/session-hosts/tests/session-host-lifecycle.test.ts`、`…/session-hosts-routes.test.ts`、`…/session-host-per-run-parity.test.ts`、`server/modules/providers/tests/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts` 各自退出 **0**，且这些文件 `git diff --name-only` 里没有。
- [x] AC10 契约面与边界：`npm run typecheck`、`npm run lint` 退出 0；新判据文件跨模块 import 只经 barrel（`@/modules/<m>/index.js`），未因新符号而需要的 barrel 再导出按需登记进 Touches；改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐）。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts`）重跑：退出码 0、`fail 0`、`elapsed-ms < 60000`。**真实落地**（不是「测试存在」）：判据真的起一个**真** `tsx server/index.ts` 服务进程（临时 `DATABASE_PATH` 并经 `/proc/<pid>/environ` 证明、`HOST=127.0.0.1`、端口 ≠ 3001、日志走文件 fd、杀整个进程组），真的让一个**真** `claude` 常驻进程经 mock 端点起来并读到它的 pid；真的对服务发 `SIGTERM` 并读到该 pid 消失且关闭原因是 `server-shutdown`；真的对服务发 `SIGKILL` 并在**下一次启动**后读到该 pid 与 scope 都不在了（E5 预期这一步靠清扫而不是 EOF）；真的重启后经**真 HTTP** 读到该会话仍是 `resident`、未运行、带原因；真的再发一条 `chat.send` 读到**新** pid。假形态（启动不清扫 + driver 不因 EOF 退出）把 (2) 打红（绿 = 判据有洞，必须先补判据再继续），还原后回绿。既有六条判据逐字不变且仍绿。完成后 AC-166 在驱动器下一轮经 `goal_ac: AC-166` 独立复跑时由红翻绿——且这次翻绿有分辨力：AC3 的「发 SIGTERM 前 pid 活着」、AC5 的「per-run 原因字段为 null」、AC7 的阈值纯函数两侧、AC8 的还原回绿四处正控制保证每条读数都不是恒真。

## Touches

- `server/modules/session-hosts/tests/resident-server-restart.test.ts` (new)（判据）
- `server/modules/session-hosts/session-hosts.routes.ts`（重启后 resident 会话的「未运行 + 原因」投影）
- `server/modules/session-hosts/session-host-manager.service.ts`（若该投影需要 manager 提供 resident 会话视图或新原因常量）
- `server/modules/session-hosts/index.ts`（barrel 收口）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（AC-161 落的 resident driver；仅当 (1) 的 `server-shutdown` 路径需要 driver 侧改动时动，否则不动）
- `server/index.ts`（仅当清扫 / 停机接线需要调整时动，否则不动）
- `tasks/gap-claude-resident-server-restart.md`（自触）

## 完成记录

**本轮（2026-09-27）承接上一轮 `exited-not-landed`，唯一实质改动是任务声明面：`## Touches` 的第一条形状写错，`anti-drift-touches-check` 因此硬失败。** 实现面（`0e14412d`）未重做，判据在还原后的树上逐条复跑，全部读数重取。

**为什么只有声明面要改。** `anti-drift-touches-check` 的 `stripTouchAnnotation` 只剥离**行尾**的括注（全角 `（…）`，或行尾的 ASCII `(…)`）；原条目写作「反引号路径 + 半角空格 + `(new)` + `破折号 + 判据`」，`(new)` 不在行尾，于是 `parseTouchEntries` 产出的 glob 逐字为 `server/modules/session-hosts/tests/resident-server-restart.test.ts\` (new) — 判据`——反引号与散字都进了 glob，判据文件自然「matches no declared Touches glob」。现改成与兄弟任务 `gap-claude-resident-busy-input` 相同的形状：路径 + 半角空格 + `(new)` + **行尾**全角括注。**路径本身一字未改**，其余六条未动。`scripts/test.sh --for-task` 的选择器（`gsub` 掉反引号后取 `$1`）对两种拼法等价，故 scoped 门选中的文件集合不因本次改写而变。

**判据（命令逐字）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` → 退出 **0**、`tests 1 / pass 1 / fail 0 / duration_ms 6483.99`，打印 `elapsed-ms=6042`（< 60000）。

读数（还原后的落树实跑，逐字）：

- **AC2 真服务进程**：`server-boot pid=1542174 port=5385 log=/tmp/resident-server-restart-Onx2SL/server-5385.log`；`server-environ DATABASE_PATH=/tmp/resident-server-restart-Onx2SL/auth.db | HOST=127.0.0.1`——端口 5385 ≠ 3001（正控制：本 shell 导出的 `SERVER_PORT=3001` 未被继承），临时库与 `HOST` 都经 `/proc/<pid>/environ` 证明。
- **AC3 正常停止（SIGTERM）**：`sigterm-precondition resident-pid=1543779 alive-before=true`；`sigterm resident-pid=1543779 alive-before=true gone-after-ms=503 closeReason=server-shutdown`——「发信号前活着」是先打印的正控制；`gone-after-ms=503` 在 5000ms 宽限内。
- **AC4 被杀（SIGKILL）**：`sigkill-in-flight resident-pid=1544729 held-replies=1 alive=true`；`sigkill survivor=true killed=4 spared=1 server-pid=1544351 resident-pid=1544729`（E5 预期 `true`：被杀的父进程留下了孤儿）；下次启动后 `sigkill-residue pid=1544729 alive-at-next-boot=false swept=1`、`sigkill-reaped pid=1544729 alive-after-sweep=false`——`swept=1 ≥ 1`，且 `scopes pattern=claudecodeui-session-1544351-* output=""`（systemd user 面存在、该探针为真，故走「读 scope 为空」这一支而不是跳过支）。
- **AC5 重启后「未运行 + 原因」**：`sessions stopped lifecycle_mode=resident running=false reason="No resident host is running for this session; the last server stop or restart dropped it."`；同一次读里的正控制 `sessions control lifecycle_mode=per-run running=false reason=null`——该字段不是恒真。原因值经 barrel 与实现同源（`RESIDENT_NOT_RUNNING_REASON`，判据把它与投影填的值一起打印）。
- **AC6 下一次发送拉起新 pid**：`restart old-pid=1543779 new-pid=1545322 distinct=true alive=true running=true`。
- **AC7 60 秒进程级预算守卫**：`guard({elapsedMs:60001,budgetMs:60000})=3`、`guard({elapsedMs:0,budgetMs:60000})=0`（阈值两侧都断言，非恒真）；`budget-ms=60000 elapsed-ms=6042`。
- **AC8 假形态承重（判据文件一字未动）**：把 (a) `server/index.ts` 的 `sweepOrphanClaudeSessionScopes()` 调用点短路为 `const sweptSessionScopes: string[] = []`、且 (b) resident driver `closeHost` 的 `state.queue.end()` 删掉（CLI 不因 EOF 退出，正是 E5 的实测行为）之后，同命令退出 **1**、`pass 0 / fail 1`，读数为 `sigkill survivor=true killed=4 spared=1 server-pid=1570258 resident-pid=1570691`、`sigkill-residue pid=1570691 alive-at-next-boot=true swept=0`，失败断言文案逐字：`AssertionError [ERR_ASSERTION]: the next boot swept nothing (swept=0); the orphan was not there to reap`（`resident-server-restart.test.ts:1007`）。`git checkout --` 还原两处后同命令回到退出 **0**、`pass 1 / fail 0`、`sigkill-residue pid=1576127 alive-at-next-boot=false swept=1`、`elapsed-ms=6124`（正控制：还原即回绿）。
- **AC9 既有六条判据**：`git diff --name-only develop...HEAD` 只列出本任务的四条（`server/index.ts`、`server/modules/session-hosts/index.ts`、`server/modules/session-hosts/session-hosts.routes.ts`、判据文件），六条既有判据一个未动，各自退出 0——`session-host-lifecycle.test.ts`（`tests 6 / pass 6 / fail 0`）、`session-hosts-routes.test.ts`（`5/5`）、`session-host-per-run-parity.test.ts`（`5/5`）、`claude-host-per-run.test.ts`（`7/7`）、`claude-background-work.test.ts`（`10/10`）、`passthrough-parity.test.ts`（`4/4`）。
- **AC10 契约面**：`npm run typecheck` 退出 0（三条 tsconfig 全过）；`npm run lint` 退出 0（只有既存 warning）。新判据跨模块 import 只经 barrel；改动只落在 `## Touches` 列出的文件上。

**scoped 门**（在**合入 develop 之前**的本工作树上实测；顺序如此是因为任务文件自己的提交必须先于 merge、而 merge 又必须是分支的最后一步，否则 develop 不再是 HEAD 的祖先、驱动的 `merge --ff-only` 会失败）：`bash scripts/test.sh --for-task gap-claude-resident-server-restart --allow-thin` 退出 **0**，`suite-scope-check: PASS — 16 active task(s) scanned`，`__PERFILE__ duration_ms=7373 server/modules/session-hosts/tests/resident-server-restart.test.ts passed=true`，`# tests 1 / # pass 1 / # fail 0`——scoped 选择器解析到了上面改正后的路径并**真跑过判据本身**，不是 `(thin)` 空跑（这正是本轮的修复点：改写前的拼法在 scoped 一侧同样取不到路径）。改写只动声明、不动路径，故该文件集合在 merge 前后一致；scoped-gate 缓存在合入 develop 之后按当时实测的 develop sha 写入，key 以 `.quay/scoped-gate-cache.json` 的实测值为准，本文不写死字面量。

**非目标复查**：`shutdown()` 的 `5_000`ms 宽限、`'server-shutdown'` 词表、清扫只碰「属主已死」的 scope、per-run 会话的客户端可见行为——逐条未改；AC-161 的 resident driver 本体与分派接线不在本条改动内（分支 diff 里没有 `claude-host-driver.provider.ts`）。
