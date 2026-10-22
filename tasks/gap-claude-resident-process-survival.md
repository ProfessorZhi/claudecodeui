---
id: gap-claude-resident-process-survival
title: AC-161 Claude 常驻进程跨轮存活 — 同 pid/hostId 连续三轮各产生 complete、第 2 轮 abort 只
  interrupt 不杀进程且下一轮同 pid 继续、POST /api/session-hosts/:sessionId/close 后 stdin
  EOF 进程限时退出且 closeReason 为 user；判据带 60 秒预算守卫（超时 exit 3），假形态（每轮 --resume
  重启、abort 杀进程）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
  - gap-session-hosts-lease-driven-lifecycle
  - gap-session-hosts-binding-multiplexing
  - gap-session-hosts-claude-per-run-driver
  - gap-session-hosts-rest-list-endpoint
  - gap-debug-agent-host-driver
goal_ac: AC-161
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-161" tasks/*.md | wc -l` → **0**；`grep -rln "AC-161" tasks/*.md | wc -l` → **0** —— 不是"未认领"，是**全库零命中**：连任何邻居任务的**非目标**段里都没有被点名过。代码侧：`grep -rn "lifecycle_mode" server/ src/ --include=*.ts --include=*.tsx | wc -l` → **20**，且**逐条核对**全部是能力矩阵字段 `lifecycleModes`（`provider-capabilities.service.ts`、`debug-agent.*`、`server/shared/types.ts:2013`），**没有一条**是 `sessions` 表的列；`grep -rn "sessionId/close" server/ --include=*.ts | wc -l` → **0**；`ls server/modules/providers/list/claude/ | grep host-driver` → 只有 `claude-per-run-host-driver.provider.ts`，**无** resident driver。

邻居让位是**逐字写在案的**：`gap-session-hosts-claude-per-run-driver`（AC-159，done）的**非目标**段逐字列出「**Claude resident driver**（GOAL-013）、能力矩阵的 `lifecycleModes`/`multiplexedHost` 镜像、…数据库 `lifecycle_mode` 列、前端」，并在「为什么留」里声明「把分派改走 driver 是 mode/turn 集成的事，见 driver 文件头『What it does not own』」；`gap-debug-agent-host-driver`（AC-160，done）把「Claude 常驻」逐字划给 GOAL-013（「那属 GOAL-013」）。⇒ AC-161 无认领者；本条要建的机制（**一个进程跨轮存活**：同 pid/hostId 连续三轮、abort 只 interrupt 不杀进程、close 走 stdin EOF 且 closeReason 为 `user`）与七条已 done 的邻居（默认包装 / lease 状态机 / 1:N 绑定 / per-run 真 driver / REST 列表 / 逐帧不变 / 调试 agent driver）机制都不同，本条不是重复。

**本条的前置是六条已 done 的邻居**，它们各自认领了本条要驱动的那个对象：`gap-session-hosts-default-wrap-four-providers`（AC-154）落 `SessionHostManager`、`ProcessHost`、`SessionBinding`、`HostLease` 与 facet `IProvider.hostDriver?`；`gap-session-hosts-lease-driven-lifecycle`（AC-157）落 lease 驱动的状态机、`LifecyclePolicy`、`DEFAULT_RESIDENT_POLICY` 与 `resident-policy` lease；`gap-session-hosts-binding-multiplexing`（AC-158）落 1:N 绑定与单写者不变量；`gap-session-hosts-claude-per-run-driver`（AC-159）落 Claude per-run 的**真** driver（本条照它的形状建 resident 兄弟）；`gap-session-hosts-rest-list-endpoint`（AC-156）落 `session-hosts.routes.ts`（本条在其上补关闭路由）；`gap-debug-agent-host-driver`（AC-160）落**第一个**声明 `resident` 的 driver（`debug-agent.host-driver.ts:263`），是本条在 Claude 上复刻同一格的参照物。六条**全部 `status: done`**（本轮逐文件核对），故 `depends_on` 不构成挂起。

**来源与判据物。** 判据逐字取自 `goals/AC-161-常驻进程跨轮存活-连续三轮-pid-不变-中止当前一轮不杀进程-关闭后进程退出.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-process.test.ts`（命令逐字含文件路径，不用 glob）。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-process.test.ts'`。

**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts` → 退出 **0**，读数 `tests 7 / pass 7 / fail 0 / duration_ms 2355.5`，墙钟约 2.4s ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮实测的读数）—— 宿主层的 resident 面已就位，缺的是 Claude 侧的 driver、分派与关闭路由**

- 宿主层**已经**有 resident 的一切：`DEFAULT_RESIDENT_POLICY`（`session-host-manager.service.ts:87`，`supersedeOnNewTurn: false` / `closeWhenLeasesEmpty: false`）、`RESIDENT_IDLE_TIMEOUT = 24h`（`:60`）、`resident-policy` lease（`:307`）、`bindSession` 的 `mode` 默认值就是 `resident`（`:203`）、`pid`/`mode`/`closeReason` 已在 `GET /api/session-hosts` 的投影里（`session-hosts.routes.ts:23-33`）。**管理侧不需要新造**。
- 缺的是**驱动这一侧**：`claude-per-run-host-driver.provider.ts` 的 `reconfigure()` 恒返回 `next-turn`（`:327`），`closeHost()` 对非 `turn-complete`/`released` 的原因一律 `stopQuery()`（`:365-368`）—— **abort 会杀进程**，正是 AC-161 假形态 (b) 要红的那个行为面。
- **分派今天不走 driver**：`provider-runtime.service.ts:103` 的 `run()` 走 `sessionHostManager.trackPerRunTurn(...)`，manager 只**观察** writer，runtime 自己的 `queryClaudeSDK` 仍是应用分派路径（AC-159 在「为什么留」里逐字确认）。per-run driver 的 `run()`（`:257`）只是它自己的入口，**没有接线**。
- **关闭路由不存在**：`session-hosts.routes.ts` 今天只有 `GET /`（`:67`）；`grep -rn "sessionId/close" server/` → 0。`POST /api/session-hosts/:sessionId/close`（proposal `:539`）要在本条落。
- **`lifecycle_mode` 列不存在**：`grep -rn "lifecycle_mode" server/` → 0（proposal §6 `:277` 要求 `sessions` 表新增 `lifecycle_mode TEXT DEFAULT 'per-run'`，用 `migrations.ts:32` 的 `addColumnToTableIfNotExists` 写法）。
- **claude 的能力声明还不含 resident**：`provider-capabilities.service.ts:79` claude 的 `lifecycleModes: ['per-run']`；全库只有 `debug-agent.host-driver.ts:263` 声明过 `['per-run','resident']`。
- 真实二进制在位（判据需要）：`which claude` → `/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude`，`claude --version` → `2.1.283 (Claude Code)`；SDK `@anthropic-ai/claude-agent-sdk ^0.3.165`。

**要建的东西（范围是 AC-161 的最小充分集）**

1. **Claude 常驻 host driver** — 新文件 `server/modules/providers/list/claude/claude-host-driver.provider.ts`（proposal §7 `:287` 钦定路径与文件名），实现 `IProviderHostDriver`。与 per-run 的差别（proposal §7 `:299-306` 的对照表）：
   - **一个不结束的 `AsyncIterable<SDKUserMessage>` 输入队列**作为 `query()` 的 `prompt`，贯穿进程生命周期；`submit` 往队列里**写**，不再新建 `query()`（这是"pid 不变"的承载面）；
   - **轮次边界以 `result` 为准**：E9 实测常驻 stream-json 与 SDK `query()` 两条路**都没有** `session_state_changed` ⇒ **不要等这个事件**；一轮开始另有 `system/init`；
   - `result` 只表示一轮结束，**进程继续**；读取循环不随 `result` 结束；未知 system subtype 放过，不中断循环；
   - `interrupt(host, sessionId)` ⇒ `query.interrupt()`，**只停当前一轮**，进程与保活理由保留；`reconfigure` 对常驻返回 `'live'`（proposal §7 表 `:304-305`）；
   - `closeHost(host, reason)` ⇒ **结束输入队列（stdin EOF）**，CLI 正常退出；超时后 `query.close()` 兜底（proposal §7 表 `:306`）。**这条是 AC-161 第三段的实现面**：E5 实测常驻 `claude` 在其父进程被 SIGKILL 后 **120 秒内不自行退出**，所以"限定时间内退出"必须**以 stdin EOF 为主手段**、`close()` 只是超时兜底——不能靠杀进程冒充"退出"。
2. **分派接线** — `provider-runtime.service.ts` 的 `run()`/`abort()` 按会话的 `lifecycle_mode` 选路：resident 会话经 resident driver（`submit` 写入进程输入、`abort` 映射到 `interrupt`），per-run 会话**行为逐字不变**（仍走 `trackPerRunTurn`）。每轮都要产生 `complete` 帧（沿用现有 run 语义，proposal §8 `:321`）。
3. **`POST /api/session-hosts/:sessionId/close`** — `session-hosts.routes.ts`（proposal `:539`）：按 `appSessionId` 找到宿主，`closeHost(hostId, 'user')`；`'user'` 已在 `HOST_CLOSE_REASONS`（`server/shared/types.ts:1789`）。只对 resident 开放（proposal §13.2 `:411`：关闭动作只对 resident 开放）。
4. **`sessions.lifecycle_mode` 列** — `schema.ts` + `migrations.ts`（`addColumnToTableIfNotExists`）+ `sessions.db.ts` 仓储读写；默认 `'per-run'`，写入按能力矩阵的 `lifecycleModes` 校验（proposal §6 `:279`）。
5. **claude 能力声明** — `provider-capabilities.service.ts` 的 claude 行改为 `['per-run', 'resident']`。
6. **判据文件** `server/modules/providers/tests/claude-resident-process.test.ts` — 做法照 AC-025 的 `model-gateway-end-to-end.test.ts`（真实 `claude` 二进制 + mock Anthropic 兼容端点，**按请求体识别**，SDK 标题请求不计；临时 `DATABASE_PATH`，逐字照它的 `runChatSend`/`startMockAnthropic` 形状），经 `handleChatConnection` 的**真** `chat.send` 驱动。

**判据自带的 60 秒预算守卫**（AC-161 逐字要求）：超出时打印预算与实测墙钟并 `exit 3`。⚠️ 这与 `test()` 的 `timeout` 选项**不是**同一件事 —— 守卫必须在**进程级**（`process.exit(3)` + 一条形如 `budget=60s elapsed=<wall>` 的读数），否则超时只会表现为 node:test 的 case failure，而不是判据要求的 exit 3。判据的墙钟预算与 `claude` 冷启动要一起算（真二进制 spawn + 三轮 + abort + close 都在 60 秒内）。

**约束（不要碰的红线）**

- `claude-runtime.provider.js` 的 `passthrough-parity.test.ts` 断言 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 必须仍在 `sdkOptions.env` 里（AC-159 已钉），且 `claude-background-work.test.ts` 以该**路径与 `.js` 扩展名** import `startsBackgroundWork` ⇒ 该文件**保持 `.js` 且保持该路径**。proposal §7 `:308` 说的"把 SDK 选项构建抽出供两模式共用"若需要改这个文件，只做**纯抽取、零行为变化**，并以既有测试族不改断言仍绿为准；做不到就本条**不抽**，在 resident driver 里自行构建选项（`claude-host-per-run.test.ts` / `claude-background-work.test.ts` / `passthrough-parity.test.ts` 三条是硬约束）。
- 跨模块只经 `index.ts` barrel（`AGENTS.md` 的后端标准 + 本仓 boundaries lint）；新测试文件的 import 走 `@/modules/…/index.js` / `@/shared/…js`。

## Plan

1. **共享契约与列**：`lifecycle_mode` 列（schema + 迁移 + `sessions.db.ts` 读写）+ claude 能力声明加 `'resident'`。可独立验证：迁移幂等、默认读回 `'per-run'`、写入不在 `lifecycleModes` 里的模式被拒。
2. **resident driver 骨架（先不接线）**：输入队列 + 读取循环（以 `result` 切轮）+ `interrupt` / `reconfigure` / `closeHost`。先用**伪造 SDK 流**跑通"不重启进程""abort 不杀进程""close 走 EOF"，把假形态两臂在伪造流层面先红出来。
3. **分派接线**：`provider-runtime.service.ts` 按 `lifecycle_mode` 选路；per-run 路径保持逐字不变，跑 `claude-host-per-run.test.ts` 确认未动。
4. **关闭路由**：`POST /api/session-hosts/:sessionId/close` → `closeHost(hostId, 'user')` → 驱动侧结束输入队列。
5. **判据文件**：真实二进制 + mock 端点 + 真 `chat.send` 三轮 + abort 中段 + close，含两臂假形态与 60s 进程级守卫；最后跑三个既有 per-run 测试族确认不改断言。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-process.test.ts` 在交付树上退出 **0**；同一命令在 develop 上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-process.test.ts'`。
- [x] 判据内用**真实** `claude` 二进制 + mock Anthropic 兼容端点（按请求体识别，SDK 标题请求不计），临时 `DATABASE_PATH`：同一常驻会话经真 `chat.send` 连续 **3 轮**，每轮都产生 `complete`，且三轮读到的 `pid` 与 `hostId` **逐轮相同**。
- [x] 第 2 轮进行中 `chat.abort` ⇒ 该轮 `complete` 带 `aborted`，宿主快照仍显示**同一 `pid` 存活**；随后第 3 轮在**同一 pid** 上继续并产生 `complete`。
- [x] `POST /api/session-hosts/:sessionId/close` ⇒ stdin EOF 后进程在限定时间内退出，宿主 `closeReason` 为 `user`。
- [x] 判据自带 **60 秒预算守卫**：超时打印预算与实测墙钟并 `exit 3`（不是 node:test 的 case failure）。
- [x] 假形态 (a)：把每轮改成带 `--resume` 重启新进程 ⇒ **pid 读数必须红**（该臂含在判据文件内，照 AC-025 `(b-fake)` 的形状）。
- [x] 假形态 (b)：把 abort 改成杀进程 ⇒ **必须红**。
- [x] 既有 per-run 行为不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts` 三条均退出 0 且断言不改。

## DoD

真实落地判据（不是"测试存在"）：在交付的树上，**真的**起一个 `claude` 常驻进程（真二进制 + mock 端点 + 临时库 + 临时 `CLAUDE_CONFIG_DIR`），经真 `chat.send` 连发三轮读出**同一个 pid/hostId**；中途 `chat.abort` 后该 pid **仍然存活**并接住下一轮；`POST /api/session-hosts/:sessionId/close` 后该 pid **真的消失**（`/proc/<pid>` 不再存在或子进程已收尸）且宿主 `closeReason` 为 `user`——即"退出"是 stdin EOF 换来的真退出，不是被 kill 掩盖。两臂假形态（每轮 `--resume`、abort 杀进程）各自把对应读数打红（绿 = 判据有洞，必须先补判据再继续）。per-run 会话的客户端可见行为逐字未变。

## 完成记录

判据在**交付树**上按原命令复跑四次，逐次退出 **0**（末次 `tests 7 / pass 7 / fail 0 / duration_ms 13230.9`）。逐条读数：

- **AC1** 红态基线：不含本文件的主检出树上同命令退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-process.test.ts'`；`git cat-file -e develop:<判据路径>` → 不存在。交付树上退出 **0**。
- **AC2** 三轮同 pid/hostId：(a) 读数 `host=host-aab5053d-a3f1-4709-81a1-c8b06b96b14b pid=4100315 alive=true` 三轮逐字相同，且 `/v1/messages=4 turns=3 titleRequestsNotCounted=1`——SDK 的标题请求同打 `/v1/messages` 与同一凭证但模型不同，**按请求体**（`"<model>"` 出现）筛出轮次请求，故"第 2 轮已到达端点"不早于第 2 轮真的发出。
- **AC3** 中止只停轮不杀进程：(b) 读数 `pid=4100552 aliveAfterAbort=true round3pid=4100552`；该轮 `complete.aborted === true`，aborted 终止帧恰一条（`chatRunRegistry` 的 first-complete-wins 由驱动的 `result` 分支在 `settle()` **之前**写帧保证，abort 路径自己的帧被登记为重复而丢弃）。abort 中段的确定性由 `mock.hold()` 保证：该轮在等一个不会到来的响应。
- **AC4** 关闭即 EOF：(c) 读数 `pid=4100862 stateAfterEof=gone closeReason=user`；路由 200 且 `data.closeReason === 'user'`；进程离开期间**无任何信号**发给它，故退出只能是 CLI 读到 stdin 末尾换来的。
- **AC5** 预算守卫是进程级：(f) 子运行 `budget=1ms` 在受判命令下打印 `[budget] budget=1ms elapsed=10ms exit=3 — …（a process-level kill, not a node:test case failure）`；直跑该文件（无 `--test`）读到 `status=3`——node:test 的 case failure 给不出 3，故这条读数区分了这两件事。(g) 全文件 `[budget] budget=60000ms elapsed=9985ms exit=0`。
- **AC6** 假形态 (a)：三只不同 pid `4101403 -> 4102038 -> 4102261`，共享断言经 `assert.throws` 落在 `/must run on the round-1 pid/`。该臂复用主用例的 `assertSameHostAcrossRounds`，故红的是那条读数本身。
- **AC7** 假形态 (b)：`pid=4102695 -> 4102695 alive=false`，共享断言 `assertProcessSurvivesAbort` 经 `assert.throws` 落在 `/must survive the abort/`。变异体走**真实缝**（`sessionHostManager.closeHost(hostId, 'aborted')`，即 per-run 侧对一次停止的回答），不是为凑红另写的分支。
- **AC8** 既有 per-run 族：`claude-host-per-run` 7/7、`claude-background-work` 10/10、`passthrough-parity` 4/4 全绿；三条文件均不在本条 diff 内（断言逐字未改），`claude-runtime.provider.js` 未被触碰。
- **Plan 步 1 的独立验证**（探针跑在临时库上）：迁移连跑两次后 `PRAGMA table_info(sessions)` 中 `lifecycle_mode` 恰一列；既有行与未知 id 均读回 `per-run`；词表外模式抛 `Unknown session lifecycle mode` 且不落库；不存在的行写入返回 `false`。
- **契约面**：`npm run typecheck`、`npm run lint` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；三个 per-run 族与 `claude-runtime.provider.js` 不在其中）。
- **作用域门**：`bash scripts/test.sh --for-task gap-claude-resident-process-survival --allow-thin` 退出 0（读数 `thin`：该脚本的 awk 只取 Touches 行的**首个空白分隔字段**，而本条 Touches 的括注是全角括号且紧贴路径，故解析不到 `.test.ts`；quay 自己的 `parseTouchEntries` 会剥离该括注，anti-drift 不受影响。本行已改用半角空格分隔括注，fan-in 合并 develop 后作用域门即可真跑本判据；fan-in 的全量 suite 无论如何都会跑到它）。

### 第三轮：fan-in 作用域门「假红」的根因与修复（同一棵树，工人自跑绿、fan-in 红）

第二轮交付后 fan-in 在 scoped-gate 红：`AssertionError: each round is one turn request to the mock endpoint`（`4 !== 3`），而同一命令在工人 shell 里复跑四次全绿。本轮读到**那次失败留下的子进程输出**（`.quay/suite-logs/20260927T140933-3317/…claude-resident-process.test.ts.out`，MANIFEST 逐字写明「per-file child output kept from a run that did not pass」），它的读数行逐字是 `/v1/messages=4 turns=4 titleRequestsNotCounted=0`；绿跑逐字对照是 `/v1/messages=4 turns=3 titleRequestsNotCounted=1`。两次**总请求数都是 4**，差的**是哪一条被算成了轮**。

**根因（已确定性复现）**：判据原来把"轮次请求"定义为 **body 里写了会话模型名**（`body.includes('"resident-custom-model"')`）。SDK 自己的辅助请求（标题与它背后的 small-model 提示）打到同一个 `/v1/messages`、同一凭证，但它*写*哪个模型名取自环境：工人 shell 里有 `ANTHROPIC_DEFAULT_HAIKU_MODEL=v4.1flash` ⇒ 它写 `v4.1flash` ⇒ 不计入 ⇒ `turns=3`；而判据真正被评分的那套 env —— driver anchor 的（与 `/proc/<anchor-pid>/environ` 逐字核对）**没有任何** `ANTHROPIC_DEFAULT_*_MODEL` ⇒ CLI 回落到**会话模型** ⇒ 该请求被算成第 4 轮 ⇒ `4 !== 3`。⇒ 判据的结论取决于**它跑在谁的 env 里**，而不取决于被交付的机制；这正是"工人绿、fan-in 红"的全部原因。

复现与定位：`env -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL npx tsx --tsconfig server/tsconfig.json --test …` ⇒ 逐字得到 `turns=4 titleRequestsNotCounted=0` 与 `4 !== 3`；带 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 时 `turns=3`。定位用的一次性探针（打印每条 `/v1/messages` 的模型名/轮标记/体积/顶层键）读数：4 条里第 3 条是 `model=resident-custom-model r1=false r2=false r3=true len≈4027`（无 `thinking`/`context_management` 键）——即那条辅助请求，它**不带累计对话**。探针已 `git checkout` 逐字还原（`git status` 干净）。

**修复**：判轮改为按**请求体带的累计用户话轮**。一轮会把此前的对话整体重发：第 1 轮带 `round one`，第 2 轮带 `round one`+`round two`，第 3 轮三句都在；三条签名按"带 1..n 且不带 n+1..3"互斥。累计对话是"这一轮"的固有形态，辅助请求**任何一条签名都不匹配**（它只带最后一句），于是结论与 env 无关。`turnRequests` 仍是三条签名之并，故 `turns=3` 的断言、失败信息与两臂假形态的读数**逐字不变**；(b)/(e) 的等待改为按第 2 轮签名（`roundRequests(…, 2).length >= 1`）——原等待 `turnRequests(...).length >= 2` 在同一根因下会被辅助请求**提前满足**，那本身就是 abort 落点不确定的来源。

**本轮读数（合并 develop 后的交付树，HEAD=`9e211b17`，develop=`2107be23`）**：

- 修复后判据在**两套 env 下都绿**，且逐字读数相同：agent shell（有 `ANTHROPIC_DEFAULT_HAIKU_MODEL`）⇒ `tests 7 / pass 7 / fail 0`；anchor 形态（三个 `ANTHROPIC_DEFAULT_*_MODEL` 全 unset，即 fan-in 那套）⇒ 同样 `tests 7 / pass 7 / fail 0`；两边的判据读数行都是 `endpoint: /v1/messages=4 turns=3 titleRequestsNotCounted=1`（与修复前的绿跑读数一致）。
- 假形态仍红（同文件内经**共享读数函数**由 `assert.throws` 落实）：`[resident] fake (a) pids: 208045 -> 208485 -> 208968` → `/must run on the round-1 pid/`；`[resident] fake (b): pid=209788 -> 209788 alive=false` → `/must survive the abort/`。
- 预算守卫：(f) 直跑子进程读到 `status=3`，(g) 全文件 `[budget] budget=60000ms elapsed=9299ms exit=0`。
- **作用域门**：`env -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u … bash scripts/test.sh --for-task gap-claude-resident-process-survival --allow-thin` 退出 **0**，读数 `__PERFILE__ duration_ms=13640 …/claude-resident-process.test.ts passed=true` —— 即**在 fan-in 那套 env 下真跑本判据并绿**（不再是 `thin`）。scoped-gate 缓存已按 `HEAD^2`（= `2107be2341dc0a513927644c8429c6e80e854f9b`）写入。
- AC8 三条 per-run 族复跑：`claude-host-per-run` 7/7、`claude-background-work` 10/10、`passthrough-parity` 4/4；`git diff --name-only develop...HEAD` 逐条核对，delta 恰为 Touches 的 9 个代码文件，三条族与 `claude-runtime.provider.js` 均不在其中。
- 契约面：`npm run typecheck`、`npm run lint` 退出 0。

### 第四轮：fan-in suite 红在**兄弟判据**上，同树 standalone 绿（并发假红，不可归于本 delta）

第三轮交付后 fan-in 在 **suite** 红，红的不是本条判据，而是兄弟判据
`server/modules/voice/tests/voice-error-classification.false-forms.test.ts`（`__PERFILE__ … passed=false`）。
读它的留存子输出（`.quay/suite-logs/20260927T143121-991150/…voice-error-classification.false-forms.test.ts.out`）
得红态逐字读数：`AssertionError: a surface this task must not have moved is red` /
`actual: ['src/shared/asr/tests/asrContractInvariants.test.ts']` —— 即该兄弟判据 AC7 顺序 spawn 的 14 个命令里，
`npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts` 那一次子运行 `exit=1`。逐条读数：

- **同一次 fan-in 运行，同一文件在 suite 自己的 lane 上是绿的**：`__PERFILE__ duration_ms=4870 src/shared/asr/tests/asrContractInvariants.test.ts passed=true` ⇒ 同树同文件，一次绿一次红。
- **该文件 standalone 绿**：`npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts` → `Tests 9 passed (9)`，exit 0。
- **兄弟判据整文件 standalone 绿**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` → `tests 7 / pass 7 / fail 0`，含 `✔ AC7 the criteria, the check scripts and the repository gates still exit 0 (105840.9ms)` 且 `exit=0 name=src/shared/asr/tests/asrContractInvariants.test.ts cases=9` ⇒ 红态在本树上**不可复现**。
- **并发证据**：复跑期间同一宿主上观察到**另一个任务的 worktree**（`…/gap-claude-resident-slice-memory-cap`）正并发跑**同一个**兄弟判据；该判据的 AC7 自身会顺序 spawn 14 个命令（含 `npm run typecheck`、`npm run lint` 与又一次 vitest），其"子运行必须绿"的读数在舰队并发下会因共享资源竞争而假红。

**归属判定**：本条 delta（`git diff --name-status develop...HEAD` 的 9 个文件）不含 `src/shared/asr/**`、`server/modules/voice/**`、`scripts/asr-*`，也不含任何 vitest 配置；故该红**不可归因于本 delta**，属舰队并发假红一族（红态不可复现 ⇒ 逃逸是重新派发，不是改判据）。

**本轮读数（merge 后：develop=`b0c1b37b`，HEAD=`62fcae23`）**

- 本条判据：`env -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL bash scripts/test.sh --for-task gap-claude-resident-process-survival --allow-thin` 退出 **0**，真跑本判据 `__PERFILE__ duration_ms=13431 …/claude-resident-process.test.ts passed=true`（不再是 `thin`）；scoped-gate 缓存已按 develop sha `b0c1b37b61787111c664942916bb9ff3a990ee04`（= `HEAD^2`）写入 `/data/home/yale/work/claudecodeui/.quay/scoped-gate-cache.json`。
- AC8 三条 per-run 族在 merge 后的树上复跑：`claude-host-per-run` 7/7、`claude-background-work` 10/10、`passthrough-parity` 4/4，三条均 exit 0，且三条文件都不在本条 diff 内。
- AC1 红态基线：`git cat-file -e develop:server/modules/providers/tests/claude-resident-process.test.ts` → `exists on disk, but not in 'develop'`。
- merge `develop` 无冲突（只并入 `tasks/*.md` 的状态翻转）；`git status` 干净。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （新：resident driver）
- `server/modules/providers/list/claude/claude.provider.ts` （挂上 resident driver）
- `server/modules/providers/services/provider-runtime.service.ts` （按 `lifecycle_mode` 分派 run/abort）
- `server/modules/providers/services/provider-capabilities.service.ts` （claude 加 `'resident'`）
- `server/modules/session-hosts/session-hosts.routes.ts` （`POST /:sessionId/close`）
- `server/modules/session-hosts/index.ts` （新增导出经 barrel 收口）
- `server/modules/database/schema.ts` （`lifecycle_mode` 列）
- `server/modules/database/migrations.ts` （`addColumnToTableIfNotExists`）
- `server/modules/database/repositories/sessions.db.ts` （`lifecycle_mode` 读写）
- `server/modules/providers/tests/claude-resident-process.test.ts` （新：判据）
- `tasks/gap-claude-resident-process-survival.md` （自触）
