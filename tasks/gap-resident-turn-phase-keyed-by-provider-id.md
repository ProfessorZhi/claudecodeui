---
id: gap-resident-turn-phase-keyed-by-provider-id
title: 常驻路径回合相位仍按 provider session id 写入、心跳按 app session id 读取：常驻会话回合中气泡恒为
  Working…（gap-activity-turn-phase-id-space-mismatch 只修了每轮运行路径）
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

**症状。** Claude Code 常驻（resident）会话在回合进行中，活动气泡一直显示 `Working…`，从不出现 `Thinking` / `Writing` / `Running <工具名>` 等相位文案。`ActivityIndicator.tsx` 对没有 label key 的相位 `idle` 回落到 `claudeStatus.actions.working`，所以看到 `Working…` 说明服务端心跳宣告的 `phase` 一直是 `idle`。

**根因（读代码，2026-10-03 部署的服务进程 23:10 启动，已包含 `0e9938f1`）。** `gap-activity-turn-phase-id-space-mismatch`（done）的修复只接通了每轮运行（per-run）路径：`server/modules/providers/list/claude/claude-runtime.provider.ts` 在 `forwardNormalizedFrames` 调用处显式传 `turnSessionId`（app session id）。常驻路径没有同步：

- 写入：`server/modules/providers/list/claude/claude-host-driver.provider.ts` 的 `const sessionId = state.providerSessionId;` 之后调用 `forwardNormalizedFrames({ transformedMessage, sessionId, normalizeMessage, writer })`，**没有传 `turnSessionId`**，转发器因此以 `turnSessionId ?? sessionId` 即 provider/SDK session id 为键喂给相位 tracker。
- 读取：`server/modules/websocket/services/activity-heartbeat.service.ts` 的 `activityAnnouncement(sessionId)` → `readSessionTurn(sessionId)`，其中 `sessionId` 是 `chat.subscribe` 带来的 app session id。
- `getTurn` 对未知 key 返回全新的 `idle`，所以每次心跳都落空、报 `idle`，没有任何报错。常驻状态对象上已经有 `state.appSessionId`（同文件 `state.appSessionId = binding.appSessionId`），修复所需的 id 在手。

**为什么 e2e 没拦住。** debug-agent 夹具把 appSessionId 与 providerSessionId 设成相等，凡依赖"两个 id 空间不同"的判据在 e2e 里空过；单元判据 `claude-turn-phase.test.ts` 只驱动 tracker 本身，不经过常驻驱动的转发调用点。

**修复。** 在 `claude-host-driver.provider.ts` 的 `forwardNormalizedFrames` 调用处传 `turnSessionId: state.appSessionId`。⛔ 不改客户端、不改 `deriveActivityDockView`、不改心跳读取方、不新增 provider→app 的 id 映射表。

**范围外（另案，不在本条）。** (1) tracker 的 `isSubagentFrame` 忽略子代理帧，后台 subagent / Monitor 单独在跑时主线相位仍可为 `idle`，属 GOAL-015；(2) `tool_result` 到达后相位退回 `tool_use` 之前的相位，若此前没有 thinking_tokens 或文本增量则退回 `idle`，工具间隙会闪回 `Working…`——这是读代码的推断，未实测，修复本条后再单独取证。

<!-- dedup-ref --> 机制去重读数：`gap-activity-turn-phase-id-space-mismatch`（done）是同一机制的 per-run 路径修复，本条是它遗漏的常驻调用点；`gap-claude-turn-phase-real-signals` 建立了 tracker。`grep -l turnSessionId tasks/*.md` 没有任何任务覆盖 `claude-host-driver` 的调用点，不是重复。

## AC

- [x] AC1 红→绿判据：新增用例构造一个 `appSessionId !== providerSessionId` 的常驻 host，经 `claude-host-driver` 的真实消息折叠路径喂入至少一次 `tool_use` 回合，回合进行中 `readSessionTurn(appSessionId).phase` 为 `tool` 且 `toolName` 为该工具名；在修复前的代码上该用例必须先红（贴红读数：phase 为 `idle`），修复后绿。命令 `npx vitest run` 对该文件退出码 0。
- [x] AC2 正控制：同一用例文件里，回合的 `result` 帧到达后 `readSessionTurn(appSessionId).phase` 回落 `idle`；并断言以 provider id 读取时不再是承载相位的键（证明是接通 app id，而不是把所有读取都改成非 idle）。
- [x] AC3 守卫：两个 id 相等的夹具不能满足 AC1；用例里 `appSessionId` 与 `providerSessionId` 的字符串不相等是被断言的前置条件，不是隐含假设。
- [x] AC4 真部署落地（同拍读数）：在真实常驻会话（不是 debug-agent 夹具）上发一条会跑 `sleep` 的消息，回合进行中同拍贴出 `GET /api/providers/sessions/running` 含该会话、该会话在部署自身读数里的 app session id 与 provider session id 是两个不同的值（`GET /api/providers/sessions/:id/provider-id` 与 CLI 转录文件名；`GET /api/session-hosts` 的常驻 binding `providerSessionId` 在常驻路径恒为 `null`，成因见 Evidence）、页面 `[data-activity-dock]` 的 `data-activity-phase`（不是 `idle`）与气泡可见文案（相位词，不是 `Working…`）。
- [x] AC5 契约面：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0；`claude-turn-phase.test.ts` 与 per-run 相位既有判据保持绿。
- [x] AC6 Touches 对齐：`git diff --stat` 与 `## Touches` 逐条对齐，无越界文件。

## DoD

- 真实常驻会话上，回合进行中气泡显示实际相位词（如 `Running Bash` / `Thinking`）而非 `Working…`；给出至少两次相隔 5 秒以上的逐字读数与时间戳，不是转述。
- 判据（AC1）在修复前红、修复后绿的两次读数都贴出；⛔ 只贴绿侧不算。
- 判据用的是两个 id 不相等的常驻 host，而不是 id 相等的 debug-agent 夹具；真部署读数里两个 id 同样不相等。
- 修复只落在 `## Touches` 列出的文件上，未触碰客户端、心跳读取方和 `deriveActivityDockView`。

## Touches

- tasks/gap-resident-turn-phase-keyed-by-provider-id.md (self-touch)
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/tests/claude-resident-turn-phase-app-id.test.ts (new)

## Evidence

**AC1 红→绿（同一文件，两次真实读数）**
- 红（修复前的 driver，代码改动尚未落盘时运行）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-turn-phase-app-id.test.ts` →
  `AssertionError [ERR_ASSERTION]: app id must carry the running phase (read: {"phase":"idle","toolName":null,"toolDurationMs":null})` / `'idle' !== 'tool'`，`fail 1`。
- 绿（落盘修复后，同命令）→ `✔ AC1 resident turn phase is keyed by the app session id, not the provider id`，`pass 1`。
- 注：本仓服务端判据跑在 `node:test`（`vitest.config.ts` 的 `include` 只含 `src/**`），故用服务端 runner；`npx vitest run <server test file>` 只会报 "No test files found"。

**AC4 真部署（同拍读数；本 worktree 的代码，真 `claude` CLI + 本机网关 `127.0.0.1:26510`）**
- 会话 app id `a57b1e70-77ff-4a8b-af53-a247e6f821d9`；provider id `f06cb4c5-b39c-4d1e-860e-1d9d3d498a21`
  （`GET /api/providers/sessions/:id/provider-id` 与 CLI 转录文件名 `f06cb4c5-…jsonl` 两个独立读数一致）→ 两个 id 空间确实不同，`differ=true`。
- t1 `2026-10-03T16:17:18.704Z`：`GET /api/providers/sessions/running` 含该会话（`inRunning=true`）；真实 `activity.heartbeat` 帧 `phase=tool` `toolName=Bash`（帧自带 `hbAt=2026-10-03T16:17:17.698Z`）。
- t2 `2026-10-03T16:17:24.709Z`（与 t1 相隔 6.005s）：`inRunning=true`；`phase=tool` `toolName=Bash`（`hbAt=2026-10-03T16:17:22.699Z`）。
- 页面（真 chromium + 真 Vite 客户端，另一轮会话 `c5116326-…`）：t1 `2026-10-03T16:16:34.562Z`
  `[data-activity-dock]` `data-activity-phase=tool`、`data-activity-state=in-turn`、可见文案 `"Running Bash… 0s"`；
  t2 `2026-10-03T16:16:40.572Z`（+6.010s）`data-activity-phase=tool`、`"Running Bash… 5s"`。气泡是相位词，不是 `Working…`。
- ⚠️ `GET /api/session-hosts` 的常驻 binding `providerSessionId` 读数为 `null`，不是"两个不同的值"：`binding.providerSessionId` 只由 per-run 路径的 `createObservingWriter` 写入
  （`session-host-manager.service.ts:1044-1077`，其唯一调用点在 1209 的 per-run 分支），常驻 driver 的 sink 没有 id 通道，`toSessionHostStateView` 也不把 provider id 放上线（只用于 `occupiedBy`）。
  这是本任务范围外的产品面事实（修复不新增 id 映射表），故 AC4 的"两个不同的值"取自部署自身的 provider-id 面（上），不取自 binding；它与相位修复无关，且不影响相位读数。

**AC5** `npm run typecheck` → exit 0；`npm run lint` → exit 0；`claude-turn-phase.test.ts` + `claude-runtime-frame-forwarding.test.ts` → 18/18 green。

**AC6** `git show --stat HEAD` → `claude-host-driver.provider.ts`（+9/-1）与 `claude-resident-turn-phase-app-id.test.ts`（new），与 `## Touches` 逐条对齐；取证用的 scratch 探针脚本已删净（未留在树里）。
