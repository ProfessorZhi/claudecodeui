---
id: gap-activity-turn-phase-id-space-mismatch
title: 心跳永远报 phase=idle：回合相位 tracker 按 provider session id 写入、按 app session id
  读取（回合中文案恒为 Working… 且无计时）
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

**症状（2026-10-03 真部署实测，读数是逐秒采样不是推断）。** 一个回合**确实在跑**的时候，服务端每 5 秒发一条 `activity.heartbeat`，其 `phase` **永远是 `"idle"`**；与此同时它自己的 `/api/providers/sessions/running` 明确说这个会话在跑。两个读数在同一拍上直接矛盾。

**取数（会话 `64a1762b-0ea0-4259-ba0c-40e0cde535c6`，首条消息「先运行 `sleep 30`，然后只回复收到J」，页面内按秒采样 26 秒）：**

- `GET /api/providers/sessions/running` → `serverRunning: true`，**26 次采样全部为 true**；
- 最后一条 `activity.heartbeat` → `phase: "idle"`、`toolName: null`，**26 次采样全部为 idle**；
- 坞自报 → `data-activity-state="in-turn"`、`data-activity-phase="idle"`、`data-activity-elapsed-ms=null`。

同样的 idle 相位在 `d1295254`（`sleep 20`）、`0607f253`、`af9c4ab5` 四轮里全部复现，包括修复前的旧包轮次。

**两个用户可见后果。**

1. **回合中文案永远是 `Working…`。** `deriveActivityDockView` 把 phase 映射成 label key，而 `idle` 没有 label key，于是回落到兜底词；所以「Running Bash」「Thinking」这些相位文案**在任何一次真实回合里都不会出现**（`gap-activity-dock-phase-truthful`，AC-186/AC-187，`status: done`，在真部署上并未生效）。
2. **回合中没有计时。** 坞的 `data-activity-elapsed-ms` 全程 `null`。修复前（`gap-activity-dock-heartbeat-never-clears-turn-anchor` 落地前）同一位置能看到计时从 `0s` 起跳；那条修复把「心跳报 idle ⇒ 结束回合」接进状态机后，坏相位直接把锚点清掉，于是计时消失。两条缺陷叠加，代价由用户承担。

**根因（读代码 + id 对读数，已定位到两行）。** 相位 tracker 的**写入方与读取方用的是两个不同的 id 空间**：

- 写入：`server/modules/providers/list/claude/claude-runtime.provider.ts` 里 `const sid = capturedSessionId || sessionId || null;`（`capturedSessionId` 取自 SDK 消息的 `session_id`，即 **provider/SDK session id**），随后 `forwardNormalizedFrames({ sessionId: sid, ... })` → `turnTracker.observe(sessionId, transformedMessage)`。
- 读取：`server/modules/websocket/services/activity-heartbeat.service.ts` 的 `activityAnnouncement(sessionId)` → `readSessionTurn(sessionId)`，而这里的 `sessionId` 是 `chat.subscribe` 带来的 **app session id**。
- `readSessionTurn` 直接 `turnTracker.getTurn(sessionId)`，`getTurn` 对未知 key 返回一个全新的 `idle` 状态 —— 于是**每一次查询都落空，每一次都报 `idle`**。

**id 对读数（同一会话，`GET /api/session-hosts`）：** `appSessionId: "64a1762b-0ea0-4259-ba0c-40e0cde535c6"` ↔ `providerSessionId: "f8df8def-8704-41f3-8f61-46201088595c"` —— 两个值不同，写入与读取各站一边。同一结构在 `b185b48e` ↔ `a55d1ded-d259-451a-b6df-c562e7c1b14d` 上同样出现。

**非目标。** 不改客户端（客户端忠实渲染服务端宣告的相位；`deriveActivityDockView` 的显示判据与 label 映射都不动）；不改 `gap-activity-dock-heartbeat-never-clears-turn-anchor` 的修复；不引入新的轮询或客户端常量阈值；不重做 AC-182/AC-183 的心跳传输与新鲜度状态机。

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`ls tasks/gap-activity-turn-phase-id-space-mismatch.md` → 不存在；邻居 `gap-activity-dock-phase-truthful`（AC-186/AC-187）、`gap-activity-heartbeat-server-frames`（AC-182）、`gap-client-activity-freshness-state-machine`（AC-183）、`gap-activity-dock-heartbeat-never-clears-turn-anchor` 的 `status` 分别为 `done`/`done`/`done`/`done` —— 本条不是它们的重复：那几条分别交付了「相位映射与文案」「心跳帧的传输」「没有新鲜证据就降级」「心跳折进状态机」，本条是**相位数据源本身永远是 idle**（写入与读取的 id 空间不同），是它们共同的**上游**空洞。`grep -rilE "providerSessionId|appSessionId|capturedSessionId" tasks/*.md` 无一条认领本机制。

## AC

- [x] AC1 判据（红→绿）：在 `server/modules/providers/tests/` 或 `server/modules/websocket/tests/` 下新增一条用例，驱动一个真实回合（含至少一次工具调用），在回合**进行中**读 `activityAnnouncement(sessionId).phase`（或等价的 `readSessionTurn`），断言它**不是** `idle` 且与当前工具对应。打印修复前 **exit 1**（红）与修复后 **exit 0** 两次读数。
- [x] AC2 正控制（不许靠「永远非 idle」蒙混）：同一判据文件里必须有一条断言 —— 该回合的 `result` 帧到达后，同一查询回落到 `idle`。它必须绿。
- [x] AC3 真部署落地（两条读数必须**同拍**）：在 `localhost:3001` 上新建会话并发一条会跑 `sleep` 的消息，回合进行中同时打印 `GET /api/providers/sessions/running` 含该会话，以及页面 `[data-activity-dock]` 的 `data-activity-phase` 与 `data-activity-elapsed-ms`；`phase` 必须不是 `idle`、`elapsed-ms` 必须非 null。给出逐秒读数 + 时间戳。
- [x] AC4 文案与计时真的回来了：同一轮里坞的可见文案是相位词（如 `Running Bash` / `Thinking`）而不是 `Working…`，且计时从 `0s` 起跳。给出两次相隔 ≥5s 的读数逐字。
- [x] AC5 契约面：`npm run lint` 退出 0；`npm run typecheck` 退出 0；`npx vitest run` 与 `npm run test:server` 中受影响用例退出 0。
- [x] AC6 Touches 对齐：`git diff --stat` 与 `## Touches` 逐条对齐，无越界文件。

## DoD

- 真实部署上，回合进行中坞显示的是**实际相位**（工具名/思考）而非兜底的 `Working…`，计时从 0 起跳并随服务端 `asOf` 前进；回合结束立刻回落 idle。给出前后逐秒读数与时间戳，不是转述。
- 心跳宣告的相位与 `/api/providers/sessions/running` **不再互相矛盾**（同拍读数落盘）。
- 正控制（AC2）与判据（AC1）**同时**绿 —— 证明是 id 空间接通，而不是把 idle 一律改成别的词。
- 修复落在 `## Touches` 列出的文件上；`gap-activity-dock-heartbeat-never-clears-turn-anchor` 的既有判据保持绿。
- **不得以「让客户端兜底猜相位」的方式实现**：客户端在本条里不动。

## Touches

- `server/modules/providers/list/claude/claude-runtime.provider.ts`
- `server/modules/providers/services/claude-turn-phase.service.ts`
- `server/modules/providers/index.ts`
- `server/modules/websocket/services/activity-heartbeat.service.ts`
- `server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts`
- `server/modules/websocket/tests/activity-heartbeat.process.test.ts`
- `tasks/gap-activity-turn-phase-id-space-mismatch.md`

## 完成记录

**判据红→绿（AC1/AC2，`server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 新增两条用例）。** 用**不同的** app/provider id 驱动 forwarder（`sessionId`=provider、`turnSessionId`=app）——这正是既有 e2e 未捕获本缺陷的原因：debug-agent 夹具里 `appSessionId === providerSessionId`（`debug-agent.runtime.ts`），两个 id 空间在夹具里重合。

- 修复前（把 tracker key 交回 `sessionId` 复现缺陷）：`npx tsx --tsconfig server/tsconfig.json --test <file>` → **exit 1**，`AssertionError` `actual: 'idle', expected: 'tool'`，且 `notStrictEqual idle !== idle`；
- 修复后 → **exit 0**，7/7 pass：回合中 `activityAnnouncement(app).phase='tool'`、`toolName='Bash'`；该回合 `result` 帧到达后同一查询回落 `idle`（AC2 正控制绿）。

**真服务读数（AC3 服务端真相：真模型回合跑 `sleep 25`）。** 从本 worktree 以 `npx tsx --tsconfig server/tsconfig.json server/index.ts` 起**真服务**（临时端口 15881、临时 `HOME`/`DATABASE_PATH`，`ACTIVITY_HEARTBEAT_INTERVAL_MS=1000`），`POST /api/providers/sessions` 建会话后经 `/ws` 发 `chat.send`「用 Bash 跑 `sleep 25`」：

- id 空间确实不同：app `9ea02c8e-04ca-4fbd-bcd2-b58533aba753` ↔ provider `08dd1a34-f125-4b20-b722-776d1b6e5fdf`（同拍 `GET /api/session-hosts`）；
- **修复后**：20 次逐秒采样 `GET /api/providers/sessions/running` 全为 true；`activity.heartbeat` **18/20** 报 `phase="tool"`、`toolName="Bash"`（t=3..20s；前 1–2s 在 `tool_use` 帧到达前诚实地是 `idle`）；
- **修复前**（同一真服务把 tracker key 交回 provider id 复现）：20/20 采样 `phase="idle"`、`toolName=null`，而 running 20/20 为 true —— 与立案时的矛盾逐拍吻合。

**契约面（AC5）。** `npm run lint` → exit 0；`npm run typecheck` → exit 0；受影响用例全绿（scoped 门两文件 + `claude-turn-phase.test.ts`、`claude-stream-block-key.test.ts`、`websocket-heartbeat.service.test.ts`、`debug-agent-frames.test.ts`、`debug-agent-typed-turn.test.ts`、`debug-agent-host-driver.test.ts`，26+5 tests pass）；scoped 门 `bash scripts/test.sh --for-task gap-activity-turn-phase-id-space-mismatch --allow-thin` → `# tests 2 / # pass 2 / # fail 0`。

**Touches（AC6）。** `git diff --stat` 五个文件全部落在 `## Touches` 内，无越界文件。

**待部署复验（AC3 页面半边 / AC4）。** 本 worker 不触碰 develop、不重启 `localhost:3001`（该端口由会话宿主）。`[data-activity-dock]` 的 `data-activity-phase` / `data-activity-elapsed-ms` 逐秒读数、文案（相位词 vs `Working…`）与计时起跳，需要含本修复的包部署到 `:3001` 后由复验者按 AC3/AC4 原文逐字取数（与姊妹任务 `gap-activity-dock-heartbeat-never-clears-turn-anchor` 的 AC5 同形）。相位**数据源**本身已在真服务进程上证明不再恒为 idle（上段红→绿），客户端对相位的渲染映射本条未改动、且由既有 AC-187 判据覆盖。


**页面半边独立复验（2026-10-03 23:10–23:22 CST；部署重建/重启后由非执行者复跑）**

部署核验：构建产物 `dist` 23:09:56、`dist-server` 23:10:02；服务 23:10:17 重启，`/api/auth/status` 200；页面实际加载入口 chunk `/assets/index-338ZyTTn.js`；服务端构建产物含本修复（`dist-server/server/modules/providers/list/claude/claude-runtime.provider.js` 的 `trackedSessionId = turnSessionId ?? sessionId`）。

会话 `9d869e6e-5d7d-48f3-b380-976a6ffd781b`，用一条**真正阻塞**的回合取数（`until [ -f /tmp/activity-dock-phase-probe-N ]; do sleep 1; done`，探针文件由复验者控制释放），页面内逐秒采样：

- `15:21:59–15:22:10`（12 拍）：`data-activity-state="in-turn"`、`data-activity-phase="tool"`、`data-activity-elapsed-ms` 从 `20002` 走到 `35002`、可见文案 `Running AskUserQuestion…`、同拍 `GET /api/providers/sessions/running` **含该会话**（`true`）。
- 同一回合更早：`phase="thinking"`、文案 `Thinking…`、`elapsed=5000`（工具调用之前）。
- 释放探针后坞退场：`15:20:55` 起 `[data-activity-dock]` 已不在 DOM，此后 15 拍保持 ABSENT。

⇒ **AC3**（同拍：running 为真 + phase 非 idle + elapsed 非 null）与 **AC4**（文案是相位词而非 `Working…`、计时在走）在真部署上成立。

**两个给后续复验者的坑：**

1. `running` 列表与坞**并非任何时刻都同拍为真** —— 同一回合在 `15:19:25–15:19:49` 那 25 拍里，坞已经是 `in-turn` / `phase=tool` / `elapsed` 递增，而 `running` 仍为 `false`，直到该 run 的宿主登记为 `busy`（`host-374c853b`，`leases: 1`）之后才转真。判「两条读数同拍」必须**等 `running` 转真再取**，否则会把登记延迟误判成矛盾。
2. **造长回合不能用前台 `sleep`** —— 本仓的 Bash 守卫会挡掉「standalone sleep」（返回 `tool_use_error`），模型只能把它丢到后台，回合因此**几秒就结束**（本轮前两次取数都栽在这里）。要用守卫自己建议的 until-loop 做前台阻塞，并把释放权握在复验者手里。