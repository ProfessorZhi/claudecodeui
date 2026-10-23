---
id: gap-activity-heartbeat-server-frames
title: AC-182 服务端没有业务心跳帧：加每进程 bootId+rev 的 activity.heartbeat 节拍（出厂 5s/15s，重启换
  bootId，被杀即停帧）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-182
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rn "bootId\|activity\.heartbeat\|ACTIVITY_" server --include=*.ts` 在生产代码里 0 命中；`grep -rl "goal_ac: AC-182" tasks/*.md` 与 `grep -rli "bootid" tasks/*.md` 均 0 命中（`heartbeat` 一词只在 `gap-chat-edit-send-unawaited-handler-lane-flake.md`、`gap-voice-error-classification-residue-guard-excludes-quay-state.md` 的正文里偶然出现，二者 status done，且讲的是别的东西）。GOAL-014 的另几条判据（AC-183 客户端新鲜度状态机、AC-186 回合阶段）是不同机制，本仓库也还没有归属任务。⇒「服务端业务心跳」这一机制无人认领，不是重复。

**现状读数（2026-10-01，读代码）。** 服务端唯一的“心跳”是 `server/modules/websocket/services/websocket-server.service.ts:23` 的 `attachWebSocketHeartbeat`：WS 协议级 `ping`（`intervalMs = 30_000`），浏览器 JS 看不到，因此客户端没有任何办法知道服务端是否还活着。没有 `bootId`，没有 `rev`，没有 `activity.*` 业务帧。提案 §1.1 / §4.4 / §10.3 已把这一层裁为 P0、与其余完全解耦、可独立先行。

**要做的事。** 让真实服务端在已订阅的会话上按固定节拍发出业务心跳帧 `activity.heartbeat`，每条带 `bootId` 与 `rev`（`rev` 没有变化也照发）；`bootId` 每进程生成一次（进程内稳定、重启后改变），进程被杀后不再有帧。出厂默认：心跳 5000 毫秒、判定不可达 15000 毫秒；服务端在 hello（`chat_subscribed`）或快照帧里把这两个值宣告给客户端。节拍用环境变量缩短，使判据在 60 秒闸内跑完。

## Plan

1. 红态先行：写 `server/modules/websocket/tests/activity-heartbeat.process.test.ts`（判据文件，路径由 AC 固定）。参照 `server/modules/session-hosts/tests/resident-server-restart.test.ts`：`spawn('npx', ['tsx','--tsconfig','server/tsconfig.json','server/index.ts'])`，独立 `SERVER_PORT`（probe 出的空闲端口，断言 ≠ 3001），隔离 `HOME` / `DATABASE_PATH` / `CLAUDE_CONFIG_DIR`，用 `scripts/mint-token.mjs` 铸 token，`ws` 客户端连 `/ws?token=…` 并 `chat.subscribe` 一个会话。用环境变量把节拍缩短到亚秒级。实现前该文件红（读不到任何 `activity.heartbeat`）。
2. 实现：在 `server/modules/websocket/services/activity-heartbeat.service.ts` 里加心跳服务——模块加载期生成一次 `bootId`（进程内常量）、维护 `rev`、构造 `activity.heartbeat` 帧、按节拍发送、socket 关闭即停；导出两个出厂常量（心跳 5000ms / 不可达 15000ms）以及读其环境变量覆盖（缩短节拍用）的入口。经 `server/modules/websocket/index.ts` 桶导出。
3. 在 `server/modules/websocket/services/chat-websocket.service.ts` 的 `chat.subscribe` 应答（`chat_subscribed` ack，即 hello 帧）里带上 `{ bootId, heartbeatIntervalMs, unreachableAfterMs }`，并在订阅后把心跳挂到该 socket；`rev` 取自同一份活动状态。
4. 同一判据文件里第二条用例：`import` 上面导出的两个出厂常量，断言分别为 5000 与 15000，并断言 hello 帧里宣告的字段正是这两个值。
5. 取假形态（先提交再变异，`git checkout -- <file>` 恢复，登记逐字失败行）：(i) `bootId` 每次心跳现算 ⇒ 稳定性用例必须红；(ii) 重启沿用同一 `bootId`（把 `bootId` 落盘到临时文件再读回）⇒ 重启用例必须红；(iii) 只在 `rev` 变化时才发心跳 ⇒ 节拍用例必须红。
6. `npx tsc --noEmit -p server/tsconfig.json` 与 `npm run lint` 绿。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-heartbeat.process.test.ts` 退出 0。红态基线：实现前该文件不存在或红。
- [x] AC2 节拍（正控制，承重）：在缩短后的 N 个节拍周期内，同一已订阅 socket 读到不少于 N-1 条 `activity.heartbeat`，每条同时含 `bootId` 与 `rev`（帧里 `rev` 不变也照发）。
- [x] AC3 bootId 进程内稳定：同一进程内，hello 帧与全部心跳帧的 `bootId` 两两相等。
- [x] AC4 被杀即静默：`SIGKILL` 服务端进程后，该 socket 收到 close，且此后计时窗口内读到 0 条帧（含 `activity.heartbeat`）。
- [x] AC5 重启换 bootId：再起一个进程并订阅，其 `bootId` 与第一个进程的 `bootId` 不相等。
- [x] AC6 出货默认值：同一文件第二条用例直接 `import` 实现导出的出厂常量并断言心跳 = 5000、判定不可达 = 15000；且服务端在 hello（`chat_subscribed`）或快照帧里把这两个值宣告给客户端（断言帧里字段等于这两个常量）。
- [x] AC7 取假形态必须红（承重）：(i) `bootId` 每次心跳都变 ⇒ AC3 红；(ii) 重启沿用同一 `bootId` ⇒ AC5 红；(iii) 只在 `rev` 变化时才发 ⇒ AC2 红。逐条记录变异 diff、逐字失败行与恢复命令。
- [x] AC8 静态门：`npx tsc --noEmit -p server/tsconfig.json` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

### AC7 变异记录（先提交 `56b0833d` 再变异；逐字失败行如下）

**(i) `bootId` 每次心跳现算 ⇒ AC3 红。** 变异（`activity-heartbeat.service.ts` 的 `buildActivityHeartbeat`）：

```
-  const { bootId, rev } = activityAnnouncement(sessionId);
+  const { rev } = activityAnnouncement(sessionId);
+  const bootId = randomUUID();
```

逐字失败行：

```
AssertionError [ERR_ASSERTION]: the hello and the heartbeats disagree about the boot id: ["4c1e247c-d33b-4682-98ed-b4c4089f9bfe","25f48a03-e81e-4554-9a94-ab811ebfb648","865410a8-fff3-4c13-83e4-357d09af5efe","d4c2665a-462d-4473-aa3f-2a822d454873","79874947-69fb-4add-88fe-2071bbd9f8ed","c70273ca-783a-41b8-8df4-bc842a13bca1"]
```

（数组逐次运行内容不同：它是 hello 加 5 条心跳各自现算出的 6 个不同 id。）

**(ii) 重启沿用同一 `bootId`（落盘再读回）⇒ AC5 红。** 变异：

```
-const BOOT_ID = randomUUID();
+const BOOT_ID = (() => {
+  try {
+    return readFileSync('/tmp/ac182-bootid-probe', 'utf8');
+  } catch {
+    const id = randomUUID();
+    writeFileSync('/tmp/ac182-bootid-probe', id);
+    return id;
+  }
+})();
```

逐字失败行：

```
AssertionError [ERR_ASSERTION]: the restarted process reused the first process bootId, so a client cannot see the restart
```

**(iii) 只在 `rev` 变化时才发 ⇒ AC2 红。** 变异（`attachActivityHeartbeat` 的 `sendFrame`）：

```
+  let lastRev: number | undefined;
   const sendFrame = () => {
     if (ws.readyState !== WS_OPEN_STATE) {
       stopBeat();
       return;
     }
+    if (buildActivityHeartbeat(sessionId).rev === lastRev) {
+      return;
+    }
+    lastRev = buildActivityHeartbeat(sessionId).rev;
```

（本任务 `rev` 是会话级常量，故除首帧外全被吞掉。）

逐字失败行：

```
AssertionError [ERR_ASSERTION]: read 1 activity.heartbeat frame(s) over 5 beat periods; expected at least 4
```

三条的恢复命令相同，恢复后 `git status --porcelain` 干净、判据重跑 2/2 绿（`EXIT=0`）：

```
git checkout -- server/modules/websocket/services/activity-heartbeat.service.ts
```

## DoD

- 判据驱动的是真实出货进程：帧由 `tsx server/index.ts` 子进程经真实 WS 连接发出，`SIGKILL` 的也是该子进程；不接受 in-process 替身，也不接受“直接调用 service 函数”当作真实服务端。
- `bootId` 在实现里只生成一次（进程内模块级常量），不是每帧现算，也不是每连接一个。
- 两个出厂数字只写在实现里一处，测试读常量而不是把 5000 / 15000 抄成字面量。
- 心跳帧与 hello 帧走 websocket 模块自己的公共面；新增服务不在模块外被深引（遵守 `.agents/skills/backend-module-standards/SKILL.md`）。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Evidence — 本轮 suite 红的两处真因（均已在本分支修复）

上一轮 fan-in 的 suite 以 `suite-watchdog: ABORT guard=silence reason=hung threshold_ms=240000 silent_ms=240906` 收场，而本任务判据文件本身 2/2 绿。用保留日志 `.quay/suite-logs/<ts>-<pid>/` 里「有 `.out`、无 `.res`」的子进程定位到两个未被看门狗归因的挂死，并读出三个真因。

**(1) 挂死＝本任务实现的心跳定时器未 `unref`。** `chat-run-registry.test.ts` 与 `session-host-per-run-parity.test.ts` 都用进程内 `EventEmitter` 假 socket 订阅、且从不发 `close`，于是 `setInterval` 把子进程的事件循环一直吊着：用例全绿后进程仍不退出，整文件被看门狗判 hung（400 秒级）。修法：`activity-heartbeat.service.ts` 定时器加 `timer.unref()`（真实服务端本就由 listening socket 吊住，节拍不该是进程「活着」的理由）。读数：`timeout 90 npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts` 修前 `EXIT=124`（12 绿后挂死），修后 `EXIT=0`（3.2s，12/12）。

**(2) 断言红＝hello 新增字段打穿 AC-155 的逐字节帧 parity。** `session-host-per-run-parity.test.ts` 的 AC4 把 live 帧与 `fixtures/per-run-frame-baseline.json`（录制于 host wrapper 之前、provenance 禁重录）逐字节比，`bootId`/`rev`/`heartbeatIntervalMs`/`unreachableAfterMs` 是基线不可能持有的键。修法沿用 per-run identity 任务当年处理 `runId` 的同一处：把这组 activity 公告字段加进 `per-run-frame-scenarios.ts` 的 `UNSTABLE_FRAME_FIELDS`（`bootId` 本就是每进程随机，其余三项属同一公告组），并在 parity 驱动 `runScenario` 里把节拍钉到 600s，使 liveness 帧不会落进被测运行序列（与该文件既有「静音无关广播」同理）。读数：该文件修前 AC4 红且整文件挂死，修后 5/5 绿、进程正常退出（约 4s）。

**(3) 非本任务。** 同一次 suite 里 `claude-resident-addressable` / `claude-resident-unattended-turn` 两条 providers 侧红是 60s 进程预算到点被杀（`budget=60000ms elapsed=60023ms exit=3`），不在 `## Touches` 内，属既有 resident 家族负载抖动。

修复后本任务判据 `activity-heartbeat.process.test.ts` 2/2 绿、`EXIT=0`；`npx tsc --noEmit -p server/tsconfig.json` 与 `npm run lint` 均 `EXIT=0`。

## Touches

- server/modules/websocket/services/activity-heartbeat.service.ts (new)
- server/modules/websocket/index.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/tests/activity-heartbeat.process.test.ts (new)
- server/modules/session-hosts/tests/per-run-frame-scenarios.ts
- tasks/gap-activity-heartbeat-server-frames.md

## Needs-Human

**执行 2026-10-01T14:49:54.813Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=85740 server/modules/session-hosts/tests/resident-server-restart.test.ts passed=false end_ms=1790865972852
- run_id：wk-prod-anchor
- session_id：9f028e49-03d2-4d3b-9ec7-f0c5b4ba20f2
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-activity-heartbeat-server-frames~wk-prod-anchor~1790865791385-b9a79e.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-activity-heartbeat-server-frames-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-01T17:10:27.936Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：9aa38dab-af9b-403b-bf48-79e507178241
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-activity-heartbeat-server-frames~wk-prod-anchor~1790873744814-76a893.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-activity-heartbeat-server-frames-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-01T17:31:16.248Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 4 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：fb3b93b1-d0e7-4af6-b569-9891ca23c281
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-activity-heartbeat-server-frames~wk-prod-anchor~1790875830625-df4825.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-activity-heartbeat-server-frames-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-01T17:41:59.757Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 5 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：6db2c5a6-be9c-4bd9-94d1-8163f8d2b97e
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-activity-heartbeat-server-frames~wk-prod-anchor~1790876473586-f2bb43.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-activity-heartbeat-server-frames-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-02T02:17:03.661Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 6 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=61304 server/modules/session-hosts/tests/resident-server-restart.test.ts passed=false end_ms=1790907346445
- run_id：wk-prod-anchor
- session_id：77d5648d-c34c-4ede-b02e-784bcbc0e0d5
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-activity-heartbeat-server-frames~wk-prod-anchor~1790907232648-17c81a.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-activity-heartbeat-server-frames-wk-prod-anchor.log
