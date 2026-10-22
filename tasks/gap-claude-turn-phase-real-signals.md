---
id: gap-claude-turn-phase-real-signals
title: AC-186 回合阶段与工具名来自真实信号：新增按会话的 Turn Tracker（thinking/writing/tool/等待权限/压缩/idle）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-186
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rl "goal_ac: AC-186" tasks/*.md` 0 命中；`grep -rli "turn-phase\|turnPhase\|Turn Tracker\|回合阶段" tasks/*.md` 只命中 `tasks/gap-activity-heartbeat-server-frames.md` 的正文旁述——该条 `goal_ac: AC-182`，且文中明说「AC-186 回合阶段…本仓库也还没有归属任务」。`grep -rl "goal_ac: AC-18" tasks/*.md` 显示 GOAL-014 的 AC-182（`gap-activity-heartbeat-server-frames`）、AC-183（`gap-client-activity-freshness-state-machine`）、AC-184（`gap-activity-dock-unreachable-degradation`）、AC-185（`gap-activity-send-unreachable-draft-retry`）各已被认领，唯独 AC-186 无人认领。生产源码 `grep -rn "turnPhase\|TurnPhase\|thinking_tokens" server --include=*.ts` 0 命中，判据文件 `server/modules/providers/tests/claude-turn-phase.test.ts` 不存在。⇒「回合真实阶段（Turn Tracker）」这一机制无人认领，不是重复。

**现状读数（2026-10-01，读代码）。** 服务端目前没有任何位置读 `system/thinking_tokens`（`grep` 0 命中）——实测一次运行有 215 条，全被忽略；`system/compact_boundary` 被 `server/modules/providers/list/claude/claude-sessions.provider.ts:771` 归一化成一条 `text` 行，压缩信号在归一化之后已经消失；`content_block_delta` 经 `claude-sessions.provider.ts:721` 变成 `stream_delta`。也就是说：唯一同时看得见 `system/thinking_tokens`、`stream_event`/`content_block_delta`、`assistant` 里的 `tool_use` 块与 `user` 里的配对 `tool_result` 块、`system/compact_boundary`、`result` 的接缝，是 run loop 手上的**原始 SDK 消息**（`claude-host-driver.provider.ts` 的 message handler，即 `forwardNormalizedFrames` 的入参 `transformedMessage` 那一层）。提案 `docs/proposals/claude-session-activity-dock.md` §4.3 把这条输入（S1 SDK 流）与权限请求（S4）划给 Turn Tracker，§4.5 给出 phase↔信号表。

**要做的事。** 新增一个按会话的 Turn Tracker（纯归约器），把真实帧序归约成 `Turn`：`phase`（idle / thinking / writing / tool / awaitingPermission / compacting）加 `toolName`。它消费原始 SDK 消息与权限迁移，**绝不看本地时钟**——阶段来自信号，不来自已用时间。`toolName` 取自 `tool_use` 块的 `name`，在与它 `id` 配对的 `tool_result` 到达时才离开 tool（不是「下一条 assistant 消息」）。门面经 providers barrel 收口；本任务只做这个归约器与它的判据，不接 UI、不改转写、不做真实浏览器验证（那是 AC-187）。

## Plan

1. **红态先行**：写判据文件 `server/modules/providers/tests/claude-turn-phase.test.ts`（路径由 AC 固定）。夹具是 2026-10-01 实测捕获的真实帧序，逐条注明来源与形状出处：`system/thinking_tokens`；`stream_event` 包裹的 `content_block_delta`（包裹形状由 `claude-stream-event-unwrap.test.ts` 钉住：外层 `type: 'stream_event'`，事件在 `event` 下）；`assistant` 消息里带 `id`/`name` 的 `tool_use` 块；随后的 `user` 消息里带 `tool_use_id` 的 `tool_result` 块；`permission_request` 帧；`system/compact_boundary`（形状由 `claude-compaction.test.ts` 钉住）；回合的 `result`。实现前该文件红（被导入的模块不存在）。
2. **实现** `server/modules/providers/services/claude-turn-phase.service.ts`：导出 `createClaudeTurnTracker()`，返回 `{ observe(sessionId, message), observePermission(sessionId, event), getTurn(sessionId) }` 及 `TurnPhase` / `TurnState` 类型。每个 tracker 实例持一份 `Map<sessionId, TurnState>`——**不得**用模块级可变单例（这正是串扰用例要钉住的性质）。`observe` 的判别：
   - `message.type === 'system' && message.subtype === 'thinking_tokens'` ⇒ `thinking`；
   - `message.type === 'stream_event' && message.event?.type === 'content_block_delta'`（文本增量，即 `stream_delta`）⇒ `writing`；
   - `message.type === 'assistant'` 里含 `tool_use` 块 ⇒ `tool`，`toolName = block.name`，记下 `block.id` 待配对；
   - `message.type === 'user'` 里含 `tool_result` 块 ⇒ 按 `tool_use_id` 与已记的 `id` 配对，配对后离开 tool（回到配对前的非 tool 阶段）；
   - `message.type === 'system' && message.subtype === 'compact_boundary'` ⇒ `compacting`；
   - `message.type === 'result'` ⇒ `idle`。
   带 `parent_tool_use_id`（子代理）的帧不改写主线阶段。
3. **权限**：`observePermission(sessionId, { kind: 'permission_request' | 'permission_resolved', requestId })`——请求 ⇒ `awaitingPermission`；应答 ⇒ 恢复到**请求前**的阶段（状态里记住前相，不硬编码成 idle）。live 喂入口（`canUseTool`/`permission_request` 帧）不在本条范围，本条只保证归约器读得对。
4. **不编造耗时**：没有任何 `tool_progress` 帧时，`getTurn` 的耗时字段为 `null`，不由本地时钟推算（帧序夹具里根本没有 `tool_progress`——提案 §4.5 记「实测未出现」）。
5. 判据逐条覆盖 AC2–AC10，含两臂串扰（两个 sessionId 交错喂帧、断言各自读回自己的阶段）与子代理帧（`parent_tool_use_id` 非 null 的 tool_use 不改主线）。
6. **取假形态**（先提交再变异，`git checkout -- <file>` 恢复，登记变异 diff、逐字失败行与恢复命令）：(i) 把 tool 的结束条件从「配对的 `tool_result`」改成「下一条 `assistant` 消息」⇒ AC4 的配对用例必须红；(ii) 把状态从按 `sessionId` 的 Map 改成模块级单例 ⇒ AC9 的串扰用例必须红。
7. `npx tsc --noEmit -p server/tsconfig.json` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

### AC11 取假形态记录（两次变异均已 `git checkout --` 恢复，分支上无残留）

初始提交：`cea23b7d feat(providers): add per-session Claude Turn Tracker (AC-186)`。

**(i) tool 结束条件改成「下一条 assistant 消息」**——`assistant` 分支开头插入「若 `phase === 'tool'` 则离开 tool」（9 行），并让 `user` 分支在 id 校验后直接 `return`，`tool_result` 不再结束 tool。

- 变异 diff（`git diff server/modules/providers/services/claude-turn-phase.service.ts`）：
  - `assistant` 分支：`+ // MUTANT (i): the next assistant message ends the tool.` + `+ const state = stateFor(sessionId);` + `+ if (state.phase === 'tool') { state.phase = state.phaseBeforeTool; state.phaseBeforeTool = 'idle'; state.toolName = null; state.toolDurationMs = null; state.pendingToolUseId = null; }`（原 `const state = stateFor(sessionId);` 相应下移）；
  - `user` 分支：`+ // MUTANT (i): a tool_result no longer ends the tool.` + `+ return;`。
- 逐字失败行：`✖ AC4 tool is named from the tool_use block and ends only on its paired tool_result (1.842498ms)` / `AssertionError [ERR_ASSERTION]: a following assistant message must not end the tool` / `actual: 'thinking', expected: 'tool'`（同因另红 AC5、AC9 与「the captured turn ends idle」三例；`pass 7 / fail 4`）。
- 恢复命令：`git checkout -- server/modules/providers/services/claude-turn-phase.service.ts`，随后判据 `pass 11 / fail 0`。

**(ii) 状态改成模块级单例**——模块级新增一份共享 `SessionTurn`，`stateFor` 与 `getTurn` 都忽略 `sessionId`。

- 变异 diff：`+ // MUTANT (ii): one module-level state shared by every tracker instance.` + `+ const MUTANT_SHARED_STATE: SessionTurn = createSessionTurn();`，`stateFor` 改为 `(_sessionId) => MUTANT_SHARED_STATE`，`getTurn` 改读 `MUTANT_SHARED_STATE`。
- 逐字失败行：`✖ AC9 two sessions fed interleaved frames never read each other (0.224255ms)` / `AssertionError [ERR_ASSERTION]: session A reads its own phase` / `actual: 'tool', expected: 'writing'`（同因另红 AC3×2、AC10 与「the captured turn ends idle」四例；`pass 6 / fail 5`）。
- 恢复命令：`git checkout -- server/modules/providers/services/claude-turn-phase.service.ts`，随后判据 `pass 11 / fail 0`。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-turn-phase.test.ts` 退出 0。红态基线：实现前该文件不存在或红。
- [x] AC2 thinking 来自真实信号（正控制）：喂入 `system/thinking_tokens` 帧后 `getTurn(id).phase === 'thinking'`。
- [x] AC3 writing 来自真实信号：喂入 `stream_event`+`content_block_delta`（文本增量）后 phase 为 `'writing'`。
- [x] AC4 tool 与 toolName，配对才结束（承重）：喂入带 `name` 的 `tool_use` 后 phase 为 `'tool'`、`toolName` 等于该 `name`；同一 `id` 的 `tool_result` **到达前**仍为 `'tool'`，**到达后** phase 不再是 `'tool'`。反向判据：结束条件改成「下一条 `assistant` 消息」时，这一条必须红。
- [x] AC5 等待权限：`permission_request` ⇒ `'awaitingPermission'`；`permission_resolved` ⇒ 恢复到请求前的阶段（夹具里请求前是 `'tool'`，断言恢复后仍为 `'tool'`，不是 idle）。
- [x] AC6 压缩：`system/compact_boundary` ⇒ `'compacting'`。
- [x] AC7 回合结束回空闲：回合的 `result` 帧 ⇒ `'idle'`，且 `toolName` 清空。
- [x] AC8 无 tool_progress 不编造耗时：整段夹具没有 `tool_progress`，`getTurn` 的耗时字段恒为 `null`（不是本地时钟算出来的数）。
- [x] AC9 并发会话不串扰（承重）：两个 sessionId 交错喂入不同阶段，各自读回的 phase/toolName 互不影响；改成模块级单例时这一条必须红。
- [x] AC10 子代理帧不改主线：带 `parent_tool_use_id`（非 null）的 `tool_use`/`tool_result` 帧到达前后，主线的 phase 与 toolName 不变。
- [x] AC11 取假形态必须红（承重）：(i) tool 结束条件改成下一条 assistant 消息 ⇒ AC4 红；(ii) 状态改成模块级单例 ⇒ AC9 红。逐条记录变异 diff、逐字失败行与恢复命令。
- [x] AC12 静态门：`npx tsc --noEmit -p server/tsconfig.json` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 归约器是纯的：不 import 网络 / 进程 / fs / React，也不 import `@/shared/context/*`；实现里不出现 `Date.now()` / `performance.now()`（用 grep 证明），阶段完全由信号驱动。
- 每个实例一份按 sessionId 的 `Map`，无任何模块级可变状态；tool 只在配对的 `tool_result` 到达后结束，`toolName` 只来自 `tool_use` 块的 `name`（不来自查找表、不来自时间）。
- 判据夹具是 2026-10-01 的真实捕获（逐条注明来源与形状出处），不是凭空写的字面量；`stream_event` 包裹与 `compact_boundary` 形状对齐既有判据钉住的形状。
- 门面经 `server/modules/providers/index.ts` barrel 收口，不在模块外深引服务文件；遵守 `.agents/skills/backend-module-standards/SKILL.md`（`type` 优先、导出就地声明、私有细节不导出）。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- server/modules/providers/services/claude-turn-phase.service.ts (new)
- server/modules/providers/index.ts
- server/modules/providers/tests/claude-turn-phase.test.ts (new)
- tasks/gap-claude-turn-phase-real-signals.md
