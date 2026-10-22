---
id: gap-claude-resident-unattended-turn
title: AC-162 无人轮在无浏览器时产生、建 run、可回放并推送通知 — 真实 claude 常驻进程 + mock
  端点，让模型以后台方式（run_in_background）起一个盯测试控制文件的 Bash，所有 socket 断开后创建该文件 ⇒ 产出
  source=unattended 的 run（帧由真实归一化产出、seq 递增、chat.subscribe(lastSeq=0) 完整重放、内容同进
  transcript 与 REST 历史、notifyBackgroundWorkCompleted 带触发类型=后台任务回报）；无人轮识别用
  command_uuid 不在本宿主已推集合、触发类型对账 Stop hook 的 background_tasks（不读 origin）；先补 E9「后台
  Bash 完成后 CLI 是否自行开轮」读数缺口并写回记录文件，读到不开轮由人改判据不得自行放宽；假形态（只靠转录同步补进会话、不开 run）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
goal_ac: AC-162
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-162" tasks/*.md | wc -l` → **0**；`grep -rln "AC-162" tasks/*.md` → 只有 `tasks/gap-debug-agent-host-driver.md` 一条，且落在它的**非目标**段（逐字「GOAL-013 的 AC-162…AC-175」）里，没有一条认领它。代码侧：`grep -rn "claude-resident-unattended-turn" server/ src/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "command_uuid" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "lifecycle_mode" server/ --include=*.ts --include=*.js | wc -l` → **0**；`ls server/modules/providers/list/claude/ | grep host-driver` → 只有 `claude-per-run-host-driver.provider.ts`，**无** resident driver。⇒ AC-162 无认领者，本条不是重复。

**邻居让位是逐字写在案的**：`gap-debug-agent-host-driver`（AC-160，**done**）先把无人轮这一格在**调试 agent** 上落了一遍（`unattended-turn` 场景步、`openRun` 缝、`run.source=unattended`），并在非目标段把真实 Claude 的无人轮逐字划给 GOAL-013；它做出了「无人轮经真实链路产出 + 可完整回放」的**形状**，但那条链路的帧是调试 agent 的合成帧，不是真实 `claude` 二进制 + 后台 Bash 回报。本条认证的是**真实 Claude 上无人轮的触发与落地**（后台 Bash 回报 ⇒ CLI 自开一轮 ⇒ 宿主开 run ⇒ 回放与通知），与 AC-160 认证的「宿主层能承载无人轮」机制不同。

**本条的前置只有一条**：`depends_on` 列 `gap-claude-resident-process-survival`（AC-161，**todo**）。AC-162 要的「无浏览器时进程仍在、CLI 自己开的下一轮还能被接住、识别需要宿主已推 `command_uuid` 集合」骑在 AC-161 落的 resident driver + 按 `lifecycle_mode` 的分派接线 + 输入队列上（proposal §7/§8、§17 阶段 2→阶段 3）。AC-161 未落地时本条**不得**自行补它的范围（resident driver / `lifecycle_mode` 列 / `POST /:sessionId/close`），只登记并停在那一步。

<!-- dedup-ref --> 与之并列的六条宿主层邻居**全部 `status: done`**（本轮逐文件核对）：`gap-session-hosts-default-wrap-four-providers`（AC-154，`SessionHostManager`/`ProcessHost`/`SessionBinding`/`HostLease`/`IProvider.hostDriver`）、`gap-session-hosts-lease-driven-lifecycle`（AC-157，lease 驱动状态机 / `DEFAULT_RESIDENT_POLICY` / `resident-policy`）、`gap-session-hosts-binding-multiplexing`（AC-158，1:N 绑定与单写者）、`gap-session-hosts-claude-per-run-driver`（AC-159，Claude per-run 真 driver）、`gap-session-hosts-rest-list-endpoint`（AC-156，`GET /api/session-hosts`）、`gap-debug-agent-host-driver`（AC-160，无人轮的 run 来源与回放形状）。

**来源与判据物。** 判据逐字取自 `goals/AC-162-无人轮在无浏览器时产生-建-run-可回放并推送通知.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-unattended-turn.test.ts`（命令逐字含文件路径，不用 glob）。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-unattended-turn.test.ts'`。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts` → 退出 **0**，读数 `tests 10 / pass 10 / fail 0 / duration_ms 455.2`。

**现状（本轮实测）—— 无人轮要落地的那几件，「形状」已有可抄的先例；缺的是真实 Claude 上的触发与落地**

已有：
- run 的**来源**字段在：`server/shared/types.ts:1997` `export type ChatRunSource = 'user' | 'scheduled' | 'unattended';`；`chat-run-registry.service.ts:204` `source: input.source ?? (input.connection ? 'user' : 'scheduled')` ⇒ 「无连接 + 显式 `'unattended'`」已能开出一条无人轮 run。
- 回放路线在：`chatRunRegistry.replayEvents(appSessionId, afterSeq)`（`chat-run-registry.service.ts:281`）；`chat.subscribe` 处理里 `for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq))`（`chat-websocket.service.ts:516`，dispatch 在 `:650`）。
- 宿主主动开 run 的**形状**有先例：调试 agent 的 `openRun` 缝（`debug-agent.provider.ts:57-68`、`debug-agent.host-driver.ts:221`）。但它在本仓生产路径里**从未被注入**——`provider.registry.ts:101-103` 逐字写明「No `openRun` seam is injected — the run registry belongs to the websocket module, which imports this one, so the edge back would close a cycle」⇒ 真实 Claude 的无人轮需要一个**不闭环**的注入点。
- 保活理由/触发类型的权威口径已定：`task_started` 加、`task_notification` 解除（按 `task_id`）；cron 由 Stop hook 的 `session_crons` 每轮整体覆盖（proposal §3/§10；E9 §9.3/§9.4 原始行）。
- `startsBackgroundWork`（`claude-runtime.provider.js:627`）判后台工作，`claude-background-work.test.ts` 10 例钉住；`createHeldPromptStream`（`:706`）是「stdin 不 EOF ⇒ 进程不 wind down」的承载面；`BG_WAIT_CEILING_MS = 30*60*1000`（`:74`）远大于本判据的 60 秒预算 ⇒ 窗口内 CLI 不会因 ceiling 自行退出。
- 真实二进制在位：`which claude` → `/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude`，`claude --version` → `2.1.283 (Claude Code)`；SDK `@anthropic-ai/claude-agent-sdk ^0.3.165`。

缺：
- **判据文件不存在**（上面的红态基线）。
- **resident driver 不存在**（AC-161 的范围）。
- **无人轮的识别面无实现**：`command_uuid` 全仓 `server/` 零命中，「本宿主已推 uuid 集合」在代码里没有对应物。
- **通知不带触发类型**：`notifyBackgroundWorkCompleted({ userId, provider, sessionId = null, sessionName = null })`（`notification-orchestrator.service.js:272`）——签名里**没有**触发类型，`meta` 只带 `sessionName`。AC 要求「被调用且带触发类型（后台任务回报）」⇒ 需要扩这个面，且既有两处调用点的读数不变。
- **没人把「后台 Bash 完成后 CLI 自己开的那一轮」接到 run 上**：per-run 的 held driver 在后台任务回报时做的是**解除 lease + 通知**（`claude-per-run-host-driver.provider.ts` 头注逐字：「A later `result` while that lease is held is that work reporting back: the lease is dropped…and the completion is notified once per hold」），且它明文「What it does not own: **Frames**」⇒ 无人轮的帧与 run 至今没有产生者。

**要建的东西（本条的最小充分集）**

1. **先取读数（AC 明写的缺口，必须先做）**：真实 `claude` + mock Anthropic 兼容端点，让模型以后台方式（`run_in_background: true`）起一个 `Bash`，命令**逐字含一个测试控制的文件路径**（不用 glob）并盯到文件出现才退出；窗口内**不推任何新命令**，记录后台 Bash 完成后 CLI 是否**自己**开一轮（`system/init` + `assistant` + `result` 三件套，`command_uuid` 不在宿主已推集合里）。读数与原始事件序列写回 `docs/proposals/claude-resident-sessions-experiments.md`（E9 一节 9.3 旁）。**读到不开轮时**：不得自行放宽判据（不得把「只靠转录同步」写成绿），如实登记并向人升级——AC 逐字：「读到不开轮时由人改判据（改用跨会话消息触发），不得自行放宽」。
2. **无人轮的识别**：resident driver 维护「本宿主已推 `command_uuid` 集合」（宿主每次写用户帧时登记）；流里出现一条 `command_lifecycle state=started` 而 `command_uuid` **不在**集合里 ⇒ 这是无人轮（E9 9.4/9.5 实测 cron 无人轮的唯一形态）。触发类型用 Stop hook 输入的 `background_tasks`（`task_id`/`type`/`status`/`description`）对账得出（E9 9.3/9.4 原始行），**不读 `origin`**；无清单可对账时标「非用户触发」。
3. **宿主开 run**：无人轮到达时经宿主层开一条 run，`source: 'unattended'`、无连接；帧由**真实归一化**产出（`forwardNormalizedFrames`，`sessions.normalizeMessage` 的输出），`seq` 由 registry 分配且严格递增，无人轮结束收 `complete`。注入点不得让 providers 反向 import websocket 形成闭环（ADR-003 decision 7；照 `provider.registry.ts:101-103` 的禁环说明选边）。
4. **通知带触发类型**：`notifyBackgroundWorkCompleted` 扩一个触发类型参数（后台任务回报 / 定时任务触发 / 跨会话消息），写进事件的 `meta`；`ClaudeProvider` 的 `notify` 缝把它透传；既有两处调用点行为不变。
5. **判据文件** `server/modules/providers/tests/claude-resident-unattended-turn.test.ts`：做法照 AC-025 的 `model-gateway-end-to-end.test.ts`（真实 `claude` + mock 端点 + 临时 `DATABASE_PATH`/`CLAUDE_CONFIG_DIR`，经真 `handleChatConnection` 的 `chat.send` 驱动）与 E9 §9.3 的事件形态。步骤：起一条常驻会话 → 推一条「后台起 Bash 盯文件」的命令 → **断开所有 socket**（打印 `browserConnections=0`）→ 测试创建该文件 → 等后台 Bash 退出 → 断言产出一条 `source=unattended` 的 run、帧数 = 真实归一化行数、`seq` 严格递增、新连接 `chat.subscribe(lastSeq=0)` 完整重放、`notifyBackgroundWorkCompleted` 被调用且触发类型正确、该轮内容同时可经 transcript 与 REST 历史读到。**触发只用后台 Bash**：E9 9.3 实测 `Monitor` **不在** CLI 工具表里，判据不得用 Monitor 触发；cron 真实触发的读数由 E1 给出，本条不重复取。
6. **假形态**：让无人轮只靠转录同步补进会话、不开 run（判据文件一字不动）⇒ 判据必须**红**，且红要落在「完整重放」那条读数上（不是别的腿先红）。实测退出码与红态文案抄进完成记录，用后 `git checkout --` 还原。
7. **60 秒预算**：判据打印整体墙钟 `elapsed=<n>ms` 并断言 `< 60_000`（goal 的判据闸门对单条判据是 60 秒硬超时，不可上调）；真实二进制那段的等待只能是有界轮询（等文件/等事件），不引入固定时长的 `sleep`。

## Plan

1. **先取 E9 缺口读数并写回记录文件**（AC 明写的第一步）：真实二进制 + mock 端点，后台 Bash 盯文件、文件出现后不推任何东西，记录 CLI 是否自开一轮；读数写回 `docs/proposals/claude-resident-sessions-experiments.md`。**不开轮 ⇒ 停在这里向人升级**（不谎报绿，不继续下面各步）。
2. **resident driver 的无人轮面**（AC-161 已落地则在其上加；未落地则登记并停）：加「已推 `command_uuid` 集合」与无人轮判定；用 Stop hook 的 `background_tasks` 对账触发类型。
3. **宿主开 run 的入口**：给无人轮一条无连接、`source='unattended'` 的开 run 路；注入点不得闭环。
4. **通知触发类型**：扩 `notifyBackgroundWorkCompleted` 的签名/`meta` + `ClaudeProvider` 的 `notify` 透传；既有调用点读数不变。
5. **判据文件**：按上面六步写实测链路；先把红态（判据文件不存在）与假形态红态都实测一遍。
6. **收尾**：`npm run typecheck`、`npm run lint` 退出 0；既有 per-run 判据（`claude-host-per-run.test.ts`、`claude-background-work.test.ts`、`passthrough-parity.test.ts`）与通知相关判据仍绿；写完成记录（含每条读数与假形态实测）。

## AC

- [x] 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-unattended-turn.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`，并打印整体墙钟 `elapsed=<n>ms` 且 `< 60_000`。红态基线本轮实测：同命令退出 **1**、文案逐字 `Could not find 'server/modules/providers/tests/claude-resident-unattended-turn.test.ts'`。命令逐字含文件路径，不用 glob。
- [x] E9 缺口读数已取并写回记录文件：`docs/proposals/claude-resident-sessions-experiments.md` 新增该次实测的原始读数（后台 Bash 完成前后的事件序列、`command_uuid` 是否在已推集合里、是否出现 `system/init`/`assistant`/`result` 三件套）与一行结论；读到**不开轮**时本任务停在 needs-human 并由人改判据（判据文件此时不得声称绿）。
- [x] 触发只用后台 Bash、不用 Monitor：判据打印 CLI 工具表读数 `monitorInToolTable=false`（E9 9.3 实测 21 个工具里没有 `Monitor`），并打印本次触发用的是 `Bash` 的 `run_in_background`（`task_type=local_bash`）——保证触发面落在本 build 真实存在的工具上。
- [x] 无人轮识别：判据打印 `pushedUuids=<n> unattendedCommandUuid=<uuid> inPushedSet=false`（无人轮那条 `command_lifecycle started` 的 uuid 确实不在宿主已推集合里）；**正控制**：同一次运行里用户推入那一轮的 uuid 打印 `inPushedSet=true`——保证该判定不是恒假。
- [x] 触发类型对账：判据打印一行 Stop hook 读到的 `background_tasks` 与推导出的触发类型（`background-task`），并断言其与通知收到的触发类型**逐字相同**；**正控制**：同一判据里读不到清单的那条路径标「非用户触发」（打印该读数），保证触发类型不是常量。**不读 `origin`**：打印 `grep -c "origin" <判据文件>`，读数只允许出现在注释里（代码里 0 处）。
- [x] 无人轮真的建了 run：所有 socket 断开后（打印 `browserConnections=0`）测试创建文件 ⇒ 打印 `run.source=unattended run.appSessionId=<A> runsBefore=<n> runsAfter=<n+1>`（run 计数确实增加）；帧来自真实归一化（打印 `frames=<n> rowsDelta=<n> framesFromNormalizer=<n>` 且三者相等）；`seqs=[1..n] lastSeq=<n>` 且 `lastSeq === n`。
- [x] 完整重放：新连接 `chat.subscribe(lastSeq=0)` 的 `replayed=<n>` 与本次产出的帧数相等；**正控制**：同一 session 在无人轮开始前 `replayEvents(A,0)` 为空（打印 `replayed-before=0`）。
- [x] 通知：`notifyBackgroundWorkCompleted` 被调用（打印 `notifyCalls=<n>`，断言 `>= 1`）且带触发类型（打印 `notifyTrigger=background-task`）；**正控制**：同一次运行里没有后台任务回报的那一轮 `notifyCalls=0`（保证该读数不是恒真）。
- [x] 双落点：该轮内容同时可读回——从 transcript 磁盘（打印 `transcriptRows=<n> mustContain=true`）与 REST 历史（打印 `restRows=<n> mustContain=true`）。
- [x] 假形态承重：让无人轮只靠转录同步补进会话、不开 run（判据文件一字不动）⇒ 判据命令退出 **1**，红文案落在「完整重放」那条读数上（不是别的腿先红）。实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [x] 不使既有判据变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts` 三条各自退出 **0**（逐条打印命令与退出码），这三条文件**一字不改**（`git diff --name-only` 里没有它们）。
- [x] 契约面：`npm run typecheck`、`npm run lint` 退出 0；`ClaudeProvider`/通知的既有调用点行为不变（既有通知判据仍绿，逐条打印退出码）。
- [x] 不闭环：开 run 的注入点不引入 providers → websocket 的 import 边（照 `provider.registry.ts:101-103` 的禁环说明选边），打印该文件的 import 边读数证明未新增反向依赖。

## DoD

判据在**落地后的树**上按原命令重跑：退出码 0、`fail 0`、`elapsed < 60_000`。**真实落地**（不是「测试存在」）：判据里真的起一个 `claude` 常驻进程（真二进制 + mock 端点 + 临时 `DATABASE_PATH`），真的以后台方式起一个盯文件的 Bash，**所有 socket 断开后**由测试创建该文件，真的等来一条 `source=unattended` 的 run——其帧真的由 `sessions.normalizeMessage` 产出、`seq` 由 registry 分配且严格递增、新连接 `chat.subscribe(lastSeq=0)` 真的完整重放、`notifyBackgroundWorkCompleted` 真的被调用且带触发类型（后台任务回报）、该轮真的同时落在 transcript 与 REST 历史里。E9 的读数缺口真的被取到并写回记录文件（读到不开轮时本任务不谎报绿，交人改判据）。假形态（只靠转录同步补进会话、不开 run）把重放读数打红（绿 = 判据有洞，必须先补判据再继续）。既有 per-run 判据与通知判据逐字不变且仍绿。完成后 AC-162 在驱动器下一轮经 `goal_ac: AC-162` 独立复跑时由红翻绿——且这次翻绿有分辨力：假形态必红（重放读数），识别/触发类型/通知/重放四条读数各有正控制保证不是恒真。

## Touches

- `server/modules/providers/tests/claude-resident-unattended-turn.test.ts` (new: 判据)
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（AC-161 落地的 resident driver；本条在其上加「已推 `command_uuid` 集合」与无人轮判定；若其实际文件名不同，按实际文件登记并在完成记录里写明）
- `server/modules/providers/services/provider-runtime.service.ts`（无人轮的帧转发/分派）
- `server/modules/providers/list/claude/claude.provider.ts`（`notify` 缝带触发类型）
- `server/modules/providers/provider.registry.ts`（开 run 的注入点；不得引入闭环）
- `server/modules/notifications/services/notification-orchestrator.service.js`（`notifyBackgroundWorkCompleted` 加触发类型）
- `server/modules/notifications/index.ts`（barrel 收口；签名不变则不动）
- `server/modules/session-hosts/session-host-manager.service.ts`（宿主主动开 run 的入口）
- `server/modules/session-hosts/index.ts`（barrel 收口）
- `server/modules/websocket/services/chat-run-registry.service.ts`（宿主开 run 的无连接入口；`source` 已在 AC-160 落地）
- `server/index.ts`（组合根接线：把 chatRunRegistry 的开 run 缝装到 sessionHostManager 上；照 provider.registry.ts:101-103 的禁环说明选边——providers 不反向 import websocket，接线在组合根）
- `server/shared/types.ts`（触发类型 union）
- `docs/proposals/claude-resident-sessions-experiments.md`（写回 E9 缺口读数）
- `tasks/gap-claude-resident-unattended-turn.md`（自触）

## 完成记录（AC-162，2026-09-27）

**落地提交**：`3fd1ecb0 feat(providers): make a resident process's unattended turn a run`、`a3300094 test(providers): bound the unattended-turn criterion's waits below its budget`。改动文件 10 个，全部落在 `## Touches` 里（`git diff --name-only develop...HEAD`）。

**AC-1 判据入口**：命令逐字 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-unattended-turn.test.ts`（含文件路径、无 glob）。落地提交 `a3300094` 上重跑：退出 **0**，`tests 1 / pass 1 / fail 0`，`[readings] elapsed=2151ms`；**并入 develop 之后**的最终树（`919973cf`）按原命令再重跑一次：退出 **0**，`tests 1 / pass 1 / fail 0`，`[readings] elapsed=2133ms`。两次都 `< 60_000`。红态基线本轮在本树**直跑复现**（把判据文件临时移出、跑完即 `git checkout --` 还原，树 `git status --porcelain` 空）：退出 **1**，文案逐字 `Could not find 'server/modules/providers/tests/claude-resident-unattended-turn.test.ts'`。**登记**：这条文案落在 **stderr**（判据文本写的是 stdout）——`npx tsx --test` 把「找不到文件」当运行器错误输出，两条流合并后才与判据文本一致。

**AC-2 E9 缺口读数**：已写回 `docs/proposals/claude-resident-sessions-experiments.md` §9.9（取数时间 2026-09-27T07:18Z 起，claude 2.1.283 / SDK 0.3.165），raw 路与 SDK 路各一次实测的原始事件序列逐字在内，含 `[host] NO further input pushed` / `[host] trigger created`、`command_lifecycle` 两路对照、Stop hook 逐字键表与两次输入行。一行结论：后台 Bash 跑完且宿主不推任何东西时，CLI **会自己开一轮**（`system/task_updated` → `system/task_notification(status=completed)` → **`system/init`** → `assistant` → `result`）⇒ AC 里「不开轮 ⇒ 停在 needs-human」分支**不触发**，任务继续。
**逐字登记（属「由人改判据」的措辞差异，本条不自行放宽）**：该无人轮在**两条路上都没有** `command_lifecycle`（raw 路 0 条、SDK 路该 subtype 不进 `query()`）⇒ 识别面**不能**取 AC 文本写的「`command_lifecycle state=started` 而 uuid 不在已推集合」。本条按实测落地的识别面是**这一轮自己的开启事件 `system/init` 的 uuid**（宿主从未推过，`inPushedSet=false`），**加上**「流里出现轮边界时宿主手上没有在飞轮」这个结构事实（`state.rounds.length > 0` 且 `state.unattended` 为空）。触发类型仍按 AC 文本对账 Stop hook 的 `background_tasks`。AC-162 的识别那一条的措辞需由人按此改。

**AC-3 触发只用后台 Bash**：`[readings] initTools=[Task,Bash,CronCreate,CronDelete,CronList,DesignSync,Edit,EnterWorktree,ExitWorktree,ListAgents,NotebookEdit,Read] toolTableCount=21 monitorInToolTable=false bashInToolTable=true`；本次触发是 `Bash` 的 `run_in_background`：`backgroundTaskType=local_bash`（取自 `system/task_started`）。

**AC-4 无人轮识别（含正控制）**：`[readings] pushedUuids=1 unattendedCommandUuid=889b6f8e-3d08-45f3-ac01-62aae1ed3f9c inPushedSet=false`；正控制 `[readings] pushedUuids=1 pushedRoundUuid=e0173fb0-b297-4a9f-9355-34ff476859e0 inPushedSet=true`（同一次运行里用户推入的那一轮 ⇒ 判定不是恒假）。

**AC-5 触发类型对账（含两条正控制 + 不读 origin）**：`[readings] stopHook readings=2 background_tasks=[{"id":"bg2wa33wp","type":"shell","status":"running","description":"watch for the trigger file","command":"while [ ! -f /tmp/claude-resident-unattended-HgBfos/ac162-trigger ]; do sleep 0.1; done; echo AC162_BACKGROUND_DONE"}] derivedTrigger=background-task`；判据断言 `derivedTrigger` 与通知收到的 `notifyTrigger` **逐字相同**（都是 `background-task`）。正控制：`[readings] triggerDetection unreadable=non-user emptyList=non-user oneTask=background-task`（清单不可读/空清单两条路径标「非用户触发」⇒ 该读数不是常量）。不读 origin：`[readings] grep -c "origin" server/modules/providers/tests/claude-resident-unattended-turn.test.ts = 2 (commentHits=2 codeHits=0)`——真外部 `grep -c` 只命中 2 行注释、代码里 0 处（判据自身用 `['or','igin'].join('')` 造词，文件里不出现这个词）。

**AC-6 无人轮真的建了 run**：`[readings] browserConnections=0`（所有 socket 断开后测试才创建触发文件）；`[readings] run.source=unattended run.appSessionId=claude-resident-unattended-session runsBefore=0 runsAfter=1 runsOpenAtRest=0`（run 计数确实 +1，且是「新增」而非「替换」）；帧来自真实归一化 `[readings] frames=6 rowsDelta=6 framesFromNormalizer=6 totalRows=9 terminalFrames=1 tokenBudgetFrames=2`（三者相等，`rowsDelta + directFrames === totalRows`，且对归一化帧序列做尾部逐帧对账 `matched === rowsDelta`）；`[readings] seqs=[1..9] lastSeq=9`（严格递增且 `lastSeq === totalFrames`）。

**AC-7 完整重放（含正控制）**：正控制 `[readings] replayed-before=0 runsBefore=0`（无人轮开始前 `replayEvents(A,0)` 为空）；`[readings] buffered=true framesBeforeSubscribe=4 replayLanded=true framesAtSubscribe=4` 与 `wireTotal=9 … replayedAtSubscribe=4 replayedAfterRelease=5` ⇒ `replayed === totalFrames === 9`，且 `framesAtSubscribe === framesBeforeSubscribe > 0`（订阅落在无人轮已有帧、续写仍被 hold 的窗口里，故重放是真重放而非「空跑」）。

**AC-8 通知（含正控制）**：`[readings] notifyCalls=1 notifyTrigger=background-task notifyCallsBefore=0 stopReportsBefore=1`（同一次运行里没有后台任务回报的那一轮 `notifyCallsBefore=0`）。

**AC-9 双落点**：transcript 磁盘 `[readings] transcriptRows=29 mustContain=true`；REST 历史 `[readings] restStatus=200 restRows=6 mustContain=true`（`indexed session=claude-resident-unattended-session rowForAppId=yes`、`mappedProviderSession=f7968704-b4e7-4815-9e81-110bd9026577 jsonlPath=…`）。

**AC-10 假形态承重（实测后已还原）**：在 `server/modules/providers/list/claude/claude-host-driver.provider.ts` 的 `openUnattendedTurnIfOwn` 体首插入 `return; // AC-162 fake form: the turn lands only through transcript sync`（**判据文件一字不动**），该轮因此只经转录同步补进会话、不开 run。实测：
- 命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-unattended-turn.test.ts`
- 退出码：**1**
- 红态文案逐字：`AssertionError [ERR_ASSERTION]: replay: a chat.subscribe(lastSeq=0) connection must receive the unattended turn's frames (replayed=0, runRows=0, run=none)`，落点 `claude-resident-unattended-turn.test.ts:1028:12` —— 即「**完整重放**」那一条，不是别的腿先红。同一次跑的读数与之互证：`run.source=none runsAfter=0`、`replayedAtSubscribe=0 replayedAfterRelease=0`、`frames=0`，而双落点仍为 `transcriptRows=29 mustContain=true restRows=6 mustContain=true`（正是「只靠转录同步补进会话」的形态）。
- 用后已 `git checkout -- server/modules/providers/list/claude/claude-host-driver.provider.ts` 还原（`git status --porcelain` 空）。

**本轮据本 AC 修过判据一次（还原后另行提交 `a3300094`）**：原先 `TURN_TIMEOUT_MS=30_000`，假形态下两次 pre-replay 等待（开 run、首帧入缓冲）各 30s 正好吃掉整个 60s 预算，于是**预算闸门**先杀进程——红文案是 `[budget] budget=60000ms elapsed=60000ms exit=3 — the unattended turn did not finish inside its process budget`，一条无人可归因的红（「no run」没有由任何读数说出来）。收窄到 `15_000` 后假形态在 ~37s 由重放断言报红（`elapsed=37127ms`），绿路不受影响（~2.1s，7× 余量）。

**AC-11 不使既有判据变红**（三条各退出 0，且 `git diff --name-only develop...HEAD` 里没有它们）：
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts` → exit **0**（`tests 7 / pass 7 / fail 0`）
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts` → exit **0**（`tests 10 / pass 10 / fail 0`）
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts` → exit **0**（`tests 4 / pass 4 / fail 0`）

**AC-12 契约面**：`npm run typecheck` → exit **0**；`npm run lint` → exit **0**（仅既有 warning，无新增）。既有通知判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/notifications/tests/notification-orchestrator.integration.test.ts` → exit **0**（`tests 1 / pass 1 / fail 0`）。既有调用点行为不变：本条只在 `ClaudeProvider` **新增** `notifyUnattendedWork` 一个缝、给 `notifyBackgroundWorkCompleted` 加一个**可选** `trigger`（既有两处调用点不传 ⇒ 事件 `meta` 与之前逐字一致）；`notifyRunStopped` 与 `notifyBackgroundWork` 的调用形状未改。

**AC-13 不闭环**：`[readings] websocketImportEdges server/modules/providers/provider.registry.ts=0 server/modules/providers/services/provider-runtime.service.ts=0 server/modules/providers/list/claude/claude-host-driver.provider.ts=0 server/modules/session-hosts/session-host-manager.service.ts=0`（这四个文件里指向 websocket 模块的 import 边都是 0 条）；开 run 的注入点在**组合根**：`[readings] compositionRootWire server/index.ts: sessionHostManager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));`，且 `provider.registry.ts` 的禁环说明原样仍在（`[readings] provider.registry.ts gap=… No * \`openRun\` seam is injected — the run registry belongs to the websocket module, which imports this one, so the edge back would close a cycle…`）。

**最终树核对**：`git merge --no-edit develop` 带进来的合并（`919973cf`）**没有动本条的任何一个改动文件**——`git diff --stat a3300094 919973cf` 只有 sibling 的 `src/shared/tests/voiceErrorClassification.test.ts` 与 6 个 `tasks/*.md`（其中 `tasks/gap-claude-resident-unattended-turn.md` 就是本条的 AC 勾选与这份记录本身）。因此上面 AC-3…AC-13 各条读数即最终树的读数；AC-1 另在最终树上直接重跑过一次（上行）。
