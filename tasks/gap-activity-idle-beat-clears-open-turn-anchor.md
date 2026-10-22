---
id: gap-activity-idle-beat-clears-open-turn-anchor
title: AC-184 判据抖动红：run 仍开着时一条 phase=idle 的 activity.heartbeat 清掉回合锚点，恢复后
  elapsed 变 NaN（873f91d2 引入；须区分「回合结束」与「tracker 无 phase」）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-184
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，读任务库与代码）。`grep -rn "^goal_ac: *AC-184" tasks/*.md` → 命中 5 条，**全部 status: done**：`gap-activity-dock-unreachable-degradation`（本判据的建立者）、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-activity-single-dock-global-consistency`、`gap-activity-dock-phase-truthful`、`gap-activity-send-unreachable-draft-retry`。按轮规则，done 不是重复、而是「早先的修复没兜住」的证据。in-flight（todo/ready/needs-human）里 `grep -lE "useActivityFreshness|activity-heartbeat|readSessionTurn|turn anchor|phase.*idle"` → **0 命中**；机制词「心跳 phase=idle 清掉回合锚点」在 in-flight 里也无人认领。⇒ 不是重复，这是同一条坞上尚未闭合的回归。

**判据物与红态基线（本轮直跑，读数不是推断、不是台账尾巴）。** 判据逐字取自 `goals/AC-184-真实浏览器-服务端不可达时坞显示连接中断-不再出现-thinking-计时冻结-停止按钮置灰并说明-恢复后回到真实状态.md` 的 `criterion:`：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`。本轮在 HEAD 直跑 **4 次：3 红 1 绿**。三条红逐字相同，落在 `e2e/activity-dock-truthful.spec.ts:734`：`Error: the recovered dock reports a server-derived elapsed` / `expect(received).toBe(expected) // Object.is equality` / `Expected: true` / `Received: false`，并列读数 `dock.recovered.elapsed=NaNms`（`[data-activity-dock]` 上根本没有 `data-activity-elapsed-ms` 属性）。驱动器台账同形：`.quay/gate-events.jsonl` 里 AC-184 于 `2026-10-04T14:48:47Z`（goal-sweep）与 `14:49:40Z`（goal-cli）连红两次；更早 `00:49–03:37` 的 20 轮几乎逐轮红绿交替（≈50% 红率）。这不是负载假红：命令单独跑也红，红点稳定落在同一条断言。

**根因（本轮实测的帧证据，不是推断）。** 在判据里临时 `console.log` app 自己 socket 收到的帧后重跑（诊断改动已还原，`git diff -- e2e/activity-dock-truthful.spec.ts` 为空），恢复瞬间的帧逐字：
`chat_subscribed|phase=idle|isProcessing=true|ts=…`，紧跟 `activity.heartbeat|phase=idle|isProcessing=undefined|ts=…`（心跳每 300ms 一条，`phase` **恒为 `idle`**）。
即：**服务端在同一条协议里自相矛盾**——hello 说 `isProcessing=true`（run registry 说这个回合开着），心跳却因子据 `phase=idle` 说「没有回合」。心跳的 phase 来自 `readSessionTurn()`（`server/modules/providers/list/claude/claude-runtime.provider.ts:954` → `turnTracker.getTurn()`），其注释白纸黑字「forwarder 从没喂过的会话读 idle」；`claude-turn-phase.service.ts:40` 同义：「`idle` 是没有回合——第一帧之前，或回合 `result` 之后」。AC-184 的夹具场景 `SCENARIO`（`e2e/activity-dock-truthful.spec.ts:148`）只有 `unattended-turn`，**没有任何 phase 帧**（thinking-tokens / tool / text），所以整段回合里 tracker 都停在默认 `idle`，而 run registry 一直 `isProcessing=true`。
客户端把这条心跳当权威：**commit `873f91d2`**（`gap-activity-dock-heartbeat-never-clears-turn-anchor`）在 `src/modules/chat/hooks/useActivityFreshness.ts:220-228` 把心跳的 `phase==='idle'` 映射成 `turn={startedAt:null}`——**清掉 hello 刚锚定的回合起点**。于是恢复后：hello 把锚点设上（`dock.recovered.elapsed` 一度是有限值）→ 紧随的 idle 心跳在 ~50ms 内把锚点清空 → 坞仍是 `in-turn`（本地 `processingSessions` 还在）但 `elapsedMs` 变 null → `data-activity-elapsed-ms` 属性消失 → `Number(null ?? NaN)=NaN`。断言 733（state 仍 in-turn）过、734（elapsed 有限）红——**红绿只取决于 `readDock` 恰好落在那条 idle 心跳之前还是之后**，这正是 ≈50% 抖动。
**确认实验**：给 `SCENARIO` 临时插入 `{ at: 400, op: 'thinking-tokens' }`（使心跳 phase 非 idle）后连跑 **3/3 全绿**（`dock.recovered.elapsed` 稳定 6299/6311/6534ms），诊断改动已还原。⇒ 承重的就是「idle 心跳清锚点」这一条路径。

**为什么早先的修复没兜住。** `75a06bff`（`gap-activity-dock-unreachable-degradation`，AC-184 的建立者）当时绿，是因为那时心跳**根本不喂 turn 快照**（`phase` 只用于文案）——idle 心跳无从清锚点，恢复读到的 elapsed 是 hello 锚定的有限值（其完成记录逐字：`dock.recovered.elapsed=6611ms`）。`873f91d2`（2026-10-03）为修**另一个**缺陷（回合结束后锚点永不清、坞卡在 `Working…`、只有刷新才消失）引入「idle 心跳结束回合」，于是把「run 开着但 tracker 无 phase」这一情形也一并判成了「回合结束」，而 AC-184 的夹具恰好就是这一情形。两条要求并存：**回合真的结束 ⇒ 锚点必须清（`873f91d2` 的保证）；回合还开着 ⇒ 锚点必须留（AC-184 的保证）。** 当前实现只能区分 phase，无法区分这两种「idle」。

**要做的事。** 让「回合是否结束」回到权威来源，而不是由 tracker 的 phase 单独承担：心跳（或它读的那份状态）必须携带 run registry 的「run 在飞」这一位；客户端据此结束回合——run 已结束（权威位为假）⇒ 清锚点（保住 `873f91d2`）；run 仍在飞而 tracker 只是无 phase ⇒ 保留锚点、elapsed 继续由服务端快照推算（保住 AC-184）。AC-184 的 `expect` 与 GOAL-014 的已知限制同义：「没有该帧的场景退回为『已开始但还没有文本或工具』的阶段」——回合是真的、phase 未知，坞必须照实显示并有服务端推算的计时。

## Plan

1. **红态固化。** 复跑判据 ≥5 次并逐字记录红率与失败行（现状基线：4 次 3 红，`e2e/activity-dock-truthful.spec.ts:734` / `dock.recovered.elapsed=NaNms`）。**不要**给 `SCENARIO` 补 phase 帧来绕过缺陷——那会把 AC-184 的承重输入（run 开着但 tracker 无 phase）抽掉，等价于改判据而非修产品；判据文件只准在「加强读数、不放宽断言」的方向上动。
2. **服务端：心跳携带权威的 run 在位位。** 候选面（择一，保持 hello 与心跳对同一事实一致）：`server/modules/websocket/services/activity-heartbeat.service.ts` 的 `buildActivityHeartbeat`/`activityAnnouncement` 增加一个「turn in flight」字段；或 `server/modules/websocket/services/chat-websocket.service.ts` 在 `attachActivityHeartbeat` 处注入 run registry 的 `isProcessing`（hello 已在 `chat-websocket.service.ts:1283` 用同一个 `chatRunRegistry.isProcessing(sessionId)`）。权威位必须来自 run registry，不是再对 phase 做一次推断。
3. **客户端：按权威位结束回合。** `src/modules/chat/hooks/useActivityFreshness.ts` 心跳分支改为：权威位存在时以它决定 turn 有无（真 ⇒ 沿用/锚定，假 ⇒ `{startedAt:null}`）；权威位缺失（旧服务器）时回退到现有 phase 映射。必要时扩 `src/modules/chat/utils/activityFreshness.ts` 的 `ActivityFrame`；帧字段加在 `src/shared/types.ts` 的 `ServerEvent`。
4. **单元判据（快速反馈）。** `src/modules/chat/tests/activityDockUnreachable.test.tsx`：喂 hello(`isProcessing:true`) 后接一条 phase=`idle` 且权威位为真的心跳 ⇒ 锚点保留、`elapsedMs` 有限、坞仍 `in-turn` 且 `data-activity-elapsed-ms` 在；**正控制**：run 真的结束（权威位假 / `turn-end`）⇒ 锚点清、坞收起。`src/modules/chat/tests/activityFreshness.test.ts` 覆盖纯机器的这两条迁移。
5. **服务端判据。** `server/modules/websocket/tests/activity-heartbeat.process.test.ts` 断言心跳帧携带权威位，且与同会话 hello 的 `isProcessing` 一致。
6. **假形态（承重，先提交再变异，`git checkout -- <file>` 恢复，逐字登记变异 diff / 失败行 / 恢复命令）。** (a) 把客户端改回「`phase==='idle'` 无条件清锚点」⇒ AC-184 e2e **必须红在 734**（或第 4 步的单元判据红）；(b) 把权威位恒真 ⇒ 第 4 步的正控制（回合结束清锚点）**必须红**。任一条不红按「判据有洞」处理。
7. **静态门与墙钟。** `npm run typecheck`、`npm run lint` 退出 0；判据自报 `dock.wall` ≤20000ms，整次调用仍在 `SINGLE_SPEC_CEILING_MS` / 60s 闸内。
8. **兄弟 AC 不回归。** AC-187 的判据（`-g "AC-187"`）与 `activityDockUnreachable.test.tsx` 全绿，确认没有把「回合结束清锚点」整条删掉。

## AC

- [x] AC1 判据确定性绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` **连跑 ≥5 次全部退出 0**。红态基线：本轮 4 次 3 红，逐字失败行 `e2e/activity-dock-truthful.spec.ts:734`，读数 `dock.recovered.elapsed=NaNms`。打印 5 次的 `dock.recovered.elapsed` 与 `dock.wall`。
- [x] AC2 读数 (v) 有服务端推算的计时：恢复后 `dock.recovered.elapsed` 为有限值且 ≥ `dock.recovered.gap`（是续、不是重启），打印这两个读数。
- [x] AC3 根因消除（机械）：心跳帧携带 run 在位权威位，且 `isProcessing=true` 的 run 上一条 `phase=idle` 的心跳不再清锚点。机械读数：`grep -n "isProcessing" server/modules/websocket/services/activity-heartbeat.service.ts`（或等价权威位字段）命中；第 4 步单元判据中 hello(`isProcessing:true`)+idle 心跳后 `elapsedMs` 有限。
- [x] AC4 `873f91d2` 的保证不回归：回合真的结束（权威位假 / `turn-end`）⇒ 锚点清、坞收起；第 4 步正控制单元用例通过。
- [x] AC5 兄弟判据不回归：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-187"` 退出 0；`npx vitest run src/modules/chat/tests/activityDockUnreachable.test.tsx` 退出 0。
- [x] AC6 假形态必须红（承重）：(a) 客户端改回 `phase==='idle'` 无条件清锚点 ⇒ AC-184 e2e 红在 734；(b) 权威位恒真 ⇒ AC4 的正控制用例红。逐条记录变异 diff、逐字失败行与恢复命令。
- [x] AC7 静态门与墙钟：`npm run typecheck`、`npm run lint` 退出 0；`dock.wall` ≤20000ms 且整次调用在 55s/60s 闸内。

## DoD

- 判据驱动的是**真实服务端、真实应用、真实调试 agent 回合**，分区经 `page.routeWebSocket` 装在 app 自己那条 socket 上；不得靠给 `SCENARIO` 补 phase 帧、放宽断言或拉长 timeout 来变绿。
- 修复必须让「回合结束」与「tracker 无 phase」**可区分**，而不是把清锚点整条删掉——删掉就退回 `873f91d2` 修的「坞卡在 Working…、只有刷新才消失」缺陷。
- 计时仍由服务端快照（`asOf - turnStartedAt`）推算；不许引入本地时钟，不许改冻结语义。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把它加进 `## Touches` 再写。

## Touches

- `src/modules/chat/hooks/useActivityFreshness.ts`
- `src/modules/chat/utils/activityFreshness.ts`
- `src/shared/types.ts`
- `server/modules/websocket/services/activity-heartbeat.service.ts`
- `server/modules/websocket/services/chat-websocket.service.ts`
- `src/modules/chat/tests/activityDockUnreachable.test.tsx`
- `src/modules/chat/tests/activityFreshness.test.ts`
- `server/modules/websocket/tests/activity-heartbeat.process.test.ts`
- `tasks/gap-activity-idle-beat-clears-open-turn-anchor.md`（自触）

## 完成记录

<!-- AC-184 gap-activity-idle-beat-clears-open-turn-anchor：idle 心跳不再清掉在飞回合的锚点 -->

### 根因与修复（承重）

服务端 `activity.heartbeat` 的 `phase` 来自 `readSessionTurn()`（forwarder 未喂过该会话即读 `idle`），而 run registry 一直 `isProcessing=true`。commit `873f91d2` 把心跳 `phase==='idle'` 映射成结束回合，于是「run 在飞但 tracker 无 phase」也被判成回合结束，清掉 hello 锚定的 `startedAt` → 恢复后 `elapsed` 变 NaN（AC-184 的 ≈50% 抖动）。

修复：心跳携带 run registry 的权威在位位 `isProcessing`（每拍读一次），客户端以该位定回合有无——
- `isProcessing === false` ⇒ 清锚点（保住 `873f91d2`：回合真结束不得无限计时）；
- `isProcessing === true` ⇒ 保留/锚定（保住 AC-184：run 在飞即使 `phase=idle` 也保留锚点，elapsed 由服务端快照续算）；
- 字段缺失（旧服务器）⇒ 回退到原 `phase` 映射。

改动文件：`server/modules/websocket/services/activity-heartbeat.service.ts`（`buildActivityHeartbeat(sessionId, isProcessing)`、`attachActivityHeartbeat(ws, sessionId, readTurnInFlight)`）、`server/modules/websocket/services/chat-websocket.service.ts`（注入 `() => chatRunRegistry.isProcessing(sessionId)`）、`src/modules/chat/hooks/useActivityFreshness.ts`（心跳分支按权威位）。

### AC 验证读数

- AC1 判据确定性绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` 连跑 5 次全部 exit 0。
  - run1: exit=0 dock.recovered.elapsed=6573ms dock.recovered.gap=3108ms dock.wall=14511ms
  - run2: exit=0 dock.recovered.elapsed=6530ms dock.recovered.gap=3095ms dock.wall=14512ms
  - run3: exit=0 dock.recovered.elapsed=6280ms dock.recovered.gap=3118ms dock.wall=14512ms
  - run4: exit=0 dock.recovered.elapsed=6548ms dock.recovered.gap=3111ms dock.wall=14512ms
  - run5: exit=0 dock.recovered.elapsed=6571ms dock.recovered.gap=3108ms dock.wall=14512ms
  - 红态基线（本轮立案）：4 次 3 红，红在 `e2e/activity-dock-truthful.spec.ts:734`，`dock.recovered.elapsed=NaNms`。
- AC2 读数 (v) 有服务端推算的计时：5 次 `elapsed` 均有限且 ≥ `gap`（6573≥3108 / 6530≥3095 / 6280≥3118 / 6548≥3111 / 6571≥3108）——是续、不是重启。
- AC3 根因消除（机械）：`grep -n "isProcessing" server/modules/websocket/services/activity-heartbeat.service.ts` 命中 133/141/148/161/181 行；单元判据 `activityDockUnreachable.test.tsx > "AC3 an idle phase on a run still in flight keeps the anchor"` 通过（hello(isProcessing:true) + heartbeat(phase=idle, isProcessing:true) ⇒ state=in-turn, data-activity-elapsed-ms=5000）。
- AC4 `873f91d2` 保证不回归：单元判据 `"AC4 the registry ending the run clears the anchor, whatever the phase still says"` 通过（heartbeat(phase=thinking, isProcessing:false) ⇒ dock absent, elapsed null）。
- AC5 兄弟判据不回归：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-187"` exit 0（dock.afterTurn=absent, dock.wall=15641ms）；`npx vitest run src/modules/chat/tests/activityDockUnreachable.test.tsx` exit 0（8/8）。
- AC6 假形态必须红（承重）：
  - (a) 客户端改回「`phase==='idle'` 无条件清锚点」（变异 diff：`useActivityFreshness.ts` 权威为真分支改为 `reportedPhase === 'idle' ? { startedAt: null } : {...}`）⇒ AC-184 e2e **红在 734**，逐字 `dock.recovered.elapsed=NaNms` / `Error: the recovered dock reports a server-derived elapsed` / `Expected: true` `Received: false`；单元判据亦红（`state=absent elapsed=null`）。恢复命令：`git -C <worktree> checkout -- src/modules/chat/hooks/useActivityFreshness.ts`。
  - (b) 权威位恒真（变异 diff：`const reportedInFlight = true;`）⇒ AC4 正控制单元判据红（`an ended run must clear the anchor even while the phase still says thinking; readings: after ended run: state=in-turn elapsed=5000`）。恢复命令同上。
- AC7 静态门与墙钟：`npm run typecheck` exit 0；`npm run lint` exit 0；5 次 e2e `dock.wall`=14511/14512ms ≤20000ms；单次调用 ~23.7s，在 55s/60s 闸内。
- 兄弟 AC-182 服务端判据：`server/modules/websocket/tests/activity-heartbeat.process.test.ts` 通过（新增断言：每拍 `isProcessing` 为 boolean 且与同会话 hello 一致），scoped 门 3/3 绿。
