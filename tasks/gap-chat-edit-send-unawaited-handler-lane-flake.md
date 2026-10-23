---
id: gap-chat-edit-send-unawaited-handler-lane-flake
title: chat-edit-send.test.ts 在 fan-in lane 下偶发红：服务端在 providerRewindsForEdit
  里读不到夹具刚同步创建的会话行（SESSION_NOT_FOUND），夹具唯一的同步手段是固定 30ms 的 settle()；单独跑 8/8 绿
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-scope-test-global-namespace-count
---
## Finding

**现场（唯一一次观测）。** `.quay/fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790342649056-665fe6.log`（2026-09-25 21:26–21:29 +0800）：

- `:243` `not ok - server/modules/websocket/tests/chat-edit-send.test.ts: [ERROR] Chat WebSocket error: Session "edit-session" was not found.`
- `__PERFILE__ duration_ms=5977 server/modules/websocket/tests/chat-edit-send.test.ts passed=false`
- 整轮 `# tests 236 / # pass 235 / # fail 1` —— 该文件是这次 fan-in 唯一的红。

**这行不是「通过时的日志被误引」。** 本仓 `scripts/test.sh` 的 `first_error()` 会把测试自己的 stdout 行拼到 `not ok` 后面，所以引用行本身不能当原因。判别方式是直接读：单独跑该文件（`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-edit-send.test.ts`）**两次都是 `tests 8 / pass 8 / fail 0`、exit 0、duration_ms 2889**，且两次的输出里 `grep -c 'was not found'` 都是 **0** —— 健康跑动不打印这行，所以它是失败路径独有的服务端日志，不是恒在的噪声。

**抛出点。** 该文案（`Session "${sessionId}" was not found.`，**不带**尾部那句 `Create it via POST /api/providers/sessions first.`）在全仓非测试代码里有三处，都在 `server/modules/providers/services/sessions.service.ts`：`resolveEditAnchor:440`、`providerRewindsForEdit:466`、`rewindSessionForEdit:483`。其中 `resolveEditAnchor` 的抛出被 `handleChatEditSend` 的 try/catch 接住、转成 `ANCHOR_LOOKUP_FAILED` 协议错误；而 `providerRewindsForEdit` 在同一条路径上是**裸调用**（`const rewinds = sessionsService.providerRewindsForEdit(sessionId);`），抛出会一路冒到 `chat-websocket.service.ts:662` 的 `console.error('[ERROR] Chat WebSocket error:', …)` —— 与日志里那行的形态完全一致。三处内部都是 `sessionsDb.getSessionById(sessionId)` 返回空。

**夹具的同步方式。** `chat-edit-send.test.ts` 的 `withGateway()`（`:84` 起）在同一个同步块里先 `await initializeDatabase()`、再 `sessionsDb.createSession(SESSION_ID, provider, …)`、再 `handleChatConnection(socket, …)`，然后交给用例；用例推帧后**唯一的等待**是 `settle()`（`:133`）—— `setTimeout(resolve, 30)`，注释自陈「The handler is async and the socket listener does not await it」。也就是说：服务端在 30ms 内没把该会话读出来（或读的是另一个库句柄），用例的断言就落在空结果上。

**本地未能复现（如实登记）。** 两次并发加压都没红：一次 6 路兄弟文件（含 `claude-runtime-frame-forwarding` / `claude-sessions` / `shell-websocket.service` / `chat-run-registry` / `codex-runtime` / `session-upsert-broadcast`），一次 8 路更重的（含 `voice-capture-text.false-forms`（会 spawn 子进程）、`debug-agent-external-write`、`claude-session-title-corpus`、`claude-background-work`、`chat-permission-mode`、`claude-compaction`、`claude-session-scope`、`websocket-heartbeat.service`）。两次目标都 exit 0、`was not found` 计数 0。盘上 11 份 `fan-in-suite-*.log` 里该文件红过 **1** 次，所以这是个低频通道，不是每次必现 —— **本任务的第一步就是把复现变成确定性的**（见 AC1），没有确定性复现就不许改夹具。

**两条边界（不要把本任务当成别的东西来修）。**

<!-- dedup-ref -->
- 这不是 voice `__criterion-falsify-*` 共写目录那条串扰（`gap-voice-false-forms-siblings-pid-attribution`，已由 `d5f7904b` 修掉）：同一份日志里 voice 判据 0 命中红。
- 也不是 `gap-session-hosts-default-wrap-four-providers` 自己的 delta：该任务只改 `server/modules/session-hosts/`、`provider-runtime.service.ts`、两个 `server/shared/` 文件，`git diff --name-only develop...HEAD` 里没有任何 websocket 文件。本任务与该任务是不同机制，不重复申领它。

## AC

- [x] AC1 先拿到**确定性**复现，再动夹具：给出一个命令，在改动前的树上重复运行 ≥5 次，至少 1 次复现出同样的签名（`passed=false` 且服务端日志出现 `Session "edit-session" was not found.`），逐次记录 `run=N exit=… fail=… reading=…`。做不到确定性复现时，改用等价的证伪替代（`quay-unreproducible-before-reading-falsification-substitute` 的允许形状）：在工作树里把 `sessionsDb.getSessionById` 对 `edit-session` 一次性打桩返回空，证明该抛出点**可达**且红态签名与现场一致（退出码、文案原文抄进完成记录），随后还原。两种读数都要有，且必须在同一份完成记录里写明用的是哪一条。
- [x] AC2 夹具不再靠固定睡眠等待：`withGateway()` 或其调用方改为等待一个**真实信号**（例如等那一轮的运行被登记 / 等帧序列里出现该轮的 complete，或对薄注入的 handler 返回的 promise 做 await），`grep -n 'setTimeout(resolve, 30)' server/modules/websocket/tests/chat-edit-send.test.ts` 在改动后不再命中 `settle` 的定义行；改动只允许改夹具与等待方式，**不得删除或放宽该文件任何一条 `assert`**（`git diff develop -- server/modules/websocket/tests/chat-edit-send.test.ts | grep -c '^-.*assert'` 为 0）。
- [x] AC3 负控制——改了等待之后，被强制的失败仍必须红：AC1 用的那条注入（或确定性复现的触发条件）在改动后的树上再跑一次，仍须退出码非 0 且签名相同。这证明新的等待等的是真信号，而不是把错误吞掉。读数与还原一并登记。
- [x] AC4 回归：该文件连续 5 次单独运行全部 `exit 0` 且 `fail 0`；`npm run typecheck` 与 `npm run lint` 退出 0；`server/modules/websocket/tests/` 下其余文件在该次改动后不变（`git diff --stat develop...HEAD` 逐条对齐 `## Touches`）。
- [x] AC5 范围纪律：若 AC1 的诊断证明根因在产品代码（例如 `initializeDatabase()` / DB 单例与逐用例 `DATABASE_PATH` 切换不同步、或 `getSessionById` 的读路径有缺陷），**停止改夹具并如实把证据写进完成记录**，按机制另立 gap 任务处理产品侧；本任务不把改动伸到 `## Touches` 之外的文件。

## DoD

真实落地判据不是「调大了等待时间」，而是**那条通道不再由夹具自己的时序产生**：AC1 的复现（或证伪替代）在改动前读到过红，AC3 证明同一触发条件在改动后**仍然红**（新等待必须有分辨力，不能是掩盖），AC4 的 5 连绿与两条门读数证明夹具本身没被改松。完成记录必须写明：这份红在盘上只观测到 1/11，本地 6 路与 8 路加压都未复现，所以「修好」的读数强度取决于 AC1 走的是确定性复现还是证伪替代 —— 后者只能说「该抛出点可达且已被有界等待替代」，不能声称「已复现 driver 那次红」。若 AC5 判定根因在产品侧，则本任务的真实落地物是那份证据与新建的 gap 任务，不谎报为已修复。

## Touches

- server/modules/websocket/tests/chat-edit-send.test.ts
- tasks/gap-chat-edit-send-unawaited-handler-lane-flake.md

## 完成记录

**结论：根因在夹具，不在产品代码（AC5 判否）。改动只落在
`server/modules/websocket/tests/chat-edit-send.test.ts` 一个文件。**

### AC1 —— 确定性复现（走的是主路，不是证伪替代）

树：`ceb4990d`（= develop），`git diff develop -- <夹具>` 空行数为 0。命令：
`bash /tmp/chat-edit-probe-yale/ac1-official.sh 5 16` —— 5 轮 × 16 份并发，共 **80 次**
跑动该文件。逐次读数如下（全文 `/tmp/chat-edit-probe-yale/ac1-official.txt`）：

```
run=1 exit=1 fail=1 reading=1
run=2 exit=0 fail=0 reading=0
run=3 exit=0 fail=0 reading=0
run=4 exit=1 fail=1 reading=1
run=5 exit=0 fail=0 reading=0
run=6 exit=0 fail=0 reading=0
run=7 exit=1 fail=1 reading=1
run=8 exit=0 fail=0 reading=0
run=9 exit=0 fail=0 reading=0
run=10 exit=0 fail=0 reading=0
run=11 exit=1 fail=1 reading=1
run=12 exit=0 fail=0 reading=0
run=13 exit=0 fail=0 reading=0
run=14 exit=0 fail=0 reading=0
run=15 exit=0 fail=0 reading=0
run=16 exit=0 fail=0 reading=0
run=17 exit=0 fail=0 reading=0
run=18 exit=0 fail=0 reading=0
run=19 exit=0 fail=0 reading=0
run=20 exit=0 fail=0 reading=0
run=21 exit=0 fail=0 reading=0
run=22 exit=0 fail=0 reading=0
run=23 exit=0 fail=0 reading=0
run=24 exit=0 fail=0 reading=0
run=25 exit=0 fail=0 reading=0
run=26 exit=0 fail=0 reading=0
run=27 exit=0 fail=0 reading=0
run=28 exit=0 fail=0 reading=0
run=29 exit=0 fail=0 reading=0
run=30 exit=0 fail=0 reading=0
run=31 exit=0 fail=0 reading=0
run=32 exit=0 fail=0 reading=0
run=33 exit=0 fail=0 reading=0
run=34 exit=0 fail=0 reading=0
run=35 exit=0 fail=0 reading=0
run=36 exit=0 fail=0 reading=0
run=37 exit=0 fail=0 reading=0
run=38 exit=0 fail=0 reading=0
run=39 exit=0 fail=0 reading=0
run=40 exit=0 fail=0 reading=0
run=41 exit=0 fail=0 reading=0
run=42 exit=0 fail=0 reading=0
run=43 exit=0 fail=0 reading=0
run=44 exit=0 fail=0 reading=0
run=45 exit=0 fail=0 reading=0
run=46 exit=0 fail=0 reading=0
run=47 exit=0 fail=0 reading=0
run=48 exit=0 fail=0 reading=0
run=49 exit=0 fail=0 reading=0
run=50 exit=0 fail=0 reading=0
run=51 exit=0 fail=0 reading=0
run=52 exit=0 fail=0 reading=0
run=53 exit=0 fail=0 reading=0
run=54 exit=0 fail=0 reading=0
run=55 exit=0 fail=0 reading=0
run=56 exit=0 fail=0 reading=0
run=57 exit=0 fail=0 reading=0
run=58 exit=0 fail=0 reading=0
run=59 exit=0 fail=0 reading=0
run=60 exit=0 fail=0 reading=0
run=61 exit=0 fail=0 reading=0
run=62 exit=0 fail=0 reading=0
run=63 exit=0 fail=0 reading=0
run=64 exit=0 fail=0 reading=0
run=65 exit=0 fail=0 reading=0
run=66 exit=0 fail=0 reading=0
run=67 exit=0 fail=0 reading=0
run=68 exit=0 fail=0 reading=0
run=69 exit=0 fail=0 reading=0
run=70 exit=0 fail=0 reading=0
run=71 exit=0 fail=0 reading=0
run=72 exit=0 fail=0 reading=0
run=73 exit=0 fail=0 reading=0
run=74 exit=0 fail=0 reading=0
run=75 exit=0 fail=0 reading=0
run=76 exit=0 fail=0 reading=0
run=77 exit=0 fail=0 reading=0
run=78 exit=0 fail=0 reading=0
run=79 exit=0 fail=0 reading=0
run=80 exit=0 fail=0 reading=0
```

**green 76 / red 4**（红的是 run=1、4、7、11，全是第 1 轮）。四次红逐字同形
（`ac1-official/r1-c1|c4|c7|c11.out`，`rc=1`）：

```
Database connection closed
[ERROR] Chat WebSocket error: Session "edit-session" was not found.
✖ a refused send never rewinds the conversation (653..673ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: undefined,
    expected: 'RUN_IN_PROGRESS',
```

即 driver 那次红的签名（`passed=false` 且服务端日志出现该行）**逐字复现**，且是**同一条
用例**——第 7 题 `a refused send never rewinds the conversation`。盘上 1/11 的频率与这里
4/80 的档位一致。

lane 同形读数（整棵服务端测试集按 fan-in 形状跑：129 文件、并发 16，
`bash /tmp/chat-edit-probe-yale/lane-repro.sh 6`）：第 3 轮该文件 `exit=1 reading=1`，
签名同上，落在 `/tmp/chat-edit-probe-yale/lane/round-3-target.out`（该文件 mtime 22:48:15
早于夹具首次改动，且它读到的失败形态只可能出自未改的夹具）；第 1、2 轮 0。

**被否掉的路径（如实登记）**：单独跑 8 次（含 `taskset -c 0` + 4 个压核进程的 CPU 饥饿）
0 复现；6/8 路兄弟文件加压 0 复现。需要的是 **16 路并发造成的 /tmp 文件系统争用**——
被拉长的正是夹具从临时目录读转录本那一步。AC1 用的就是这条确定性复现主路，**没有**退到
证伪替代；打桩形状只在 AC3 里用作「被强制的失败」的负控制。

### 根因（AC5 的证据）

抛出点确如任务所述，是 `chat-websocket.service.ts:378` 那次裸调用
`providerRewindsForEdit` 里的 `sessionsDb.getSessionById`。但**会话行不是没写进去，
而是被夹具自己搬走了**：

1. 每一次红里紧挨日志行之前的都是 `Database connection closed` —— 那是 `withGateway()`
   的 `finally`（`closeConnection()`），即**夹具的拆卸**；
2. 失败的断言是 `socket.frames.at(-1)?.code` 读到 `undefined`，说明 `await settle()`
   的 30ms 先到，第 7 题的 handler 仍停在 `await resolveEditAnchor`（codex rollout 读盘）里；
3. handler 随后恢复：`getConnection()` 已置空，于是**新开**一个连到已还原的
   `DATABASE_PATH` 的连接，那里没有 `edit-session` → 抛 `SESSION_NOT_FOUND`。

产品代码没有任何一处会删这一行：同一次请求里 `resolveSendTarget`（`:190`）刚成功读到它。
产品侧没有可修的机制，故 AC5 判否，改动不伸到 Touches 段之外。

### AC2 / AC3 / AC4 读数

- **AC2**：`grep -n 'setTimeout(resolve, 30)' <夹具>` 无输出（该串已整条不存在，`settle`
  标识符也已移除）；`git diff develop -- <夹具> | grep -c '^-.*assert'` = **0**（一条
  assert 未改未删）。等待改为两种**真信号**：帧交给 `handleChatConnection` 注册的那个
  async listener 返回的 promise 并 await；第 7 题那个**故意留在飞行中**的回合改等
  `runs.length === 1`（运行已登记）。
- **AC3**：改后的树上把 `providerRewindsForEdit` 那次读一次性打桩返回空，3/3
  `exit=1 fail=1 reading=1`，日志同文（`/tmp/chat-edit-probe-yale/ac3-forced-1..3.out`）；
  打桩已还原，夹具 md5 回到 `7cc9ac655637d0045f9c67fbc01292b7`。新等待没吞错。
- **AC4**：改后同一加压形状 **80/80 全绿、0 签名**（`post-fix-readings.txt`）；单独连跑
  5 次全 `exit=0 / tests 8 / pass 8 / fail 0 / reading 0`；`npm run typecheck` 退出 0；
  `npm run lint` 退出 0（只剩既有告警）；`git diff --stat develop` 只有夹具一个文件。

### 诚实边界

- 本地 6 路/8 路加压与 CPU 饥饿都不复现；本任务用 16 路并发把该通道放大到 4/80 才拿到
  确定性读数，因此可以说「复现了 driver 那次红的通道、位置与签名」，不声称「就是那一次
  同一根因序列」。
- 夹具现在没有任何固定时长参与同步；`waitFor` 里的 5000ms 只是**失败上界**（超时转成具名
  断言失败），不是等待本身。

### 轮次 2（2026-09-26）—— 上一轮 exit-not-landed 的红不是本任务的 delta

上一轮 `step=suite` 判词停在兄弟文件，本轮**未改任何代码**，只做归因核实与 pre-merge 链条：

1. **直接读那一轮的原始 suite 日志**（`…1790349548241-61217f.log`，不是判词行）：本任务唯一
   的 delta 文件 `__PERFILE__ … chat-edit-send.test.ts passed=true` —— **绿**。红的是两个
   **兄弟**：`server/modules/providers/tests/claude-session-scope.test.ts`（`passed=false`，
   `timed out after 10000ms waiting for: one surviving session scope`，saw 的三个 scope 带的是
   **别的 pid**：`-1173991` / `-1177720` / `-264422`）与
   `server/modules/providers/tests/model-config-write-path.test.ts`（`TypeError: fetch failed`，
   本仓已知的 undici 坏端口彩票）。整轮 `# tests 236 / # pass 234 / # fail 2`。
2. **fleet-wide 证据**：`claude-session-scope.test.ts` 的红在**另一个任务**的 fan-in 里也出现过
   （`fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790350562645-af8de5.log`），
   即并发跑动造成的 scope 泄漏，不是本任务 delta 的产物。上一轮更早那次的红
   （`voice-capture-off.false-forms.test.ts`）同样是兄弟文件，且与 `d5f7904b` 已修的共写目录串扰同族。
3. **本轮链条读数**：merge develop 进工作树**无冲突**（`tasks/<id>.md` 取 per-hunk 并集，develop 的
   `## Needs-Human` 与分支的 AC tick 都在）；合并后重跑本任务 scoped 门
   `bash scripts/test.sh --for-task gap-chat-edit-send-unawaited-handler-lane-flake --allow-thin`
   → `__PERFILE__ … chat-edit-send.test.ts passed=true`、`# tests 1 / # pass 1 / # fail 0`、exit 0；
   再单独连跑 5 次全 `exit=0 reading=0`；`npm run typecheck` 退出 0、`npm run lint` 退出 0；
   `git diff --stat develop...HEAD` 仍只有夹具一个文件（72+/36−）。scoped-gate cache 已按
   `develop=49fe47a7` 登记（`HEAD^2` 同值）。

结论：本任务的落地物在前一轮已完成且未被触碰；上一轮的红是 fleet-wide 兄弟红，按重派逃生。
若本轮 suite 再在兄弟文件上红，应归因到该兄弟文件自己的机制，而不是本任务。

## Needs-Human

**执行 2026-09-25T15:21:47.344Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-session-scope.test.ts:   AssertionError [ERR_ASSERTION]: timed out after 10000ms waiting for: one surviving session scope, saw ["claudecodeui-session-1173991-e710433d.scope","claudecodeui-session-1177720-a25be588.scope","claudecodeui-session-264422-f8cfcacc.scope"]
- run_id：wk-prod-anchor
- session_id：01b5d4f1-5cb2-4ea4-97a6-5697cc888720
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-chat-edit-send-unawaited-handler-lane-flake~wk-prod-anchor~1790349548241-61217f.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-chat-edit-send-unawaited-handler-lane-flake-wk-prod-anchor.log
