---
id: gap-launch-profiles-session-profile-lock-test
title: launch-profiles：已锁定会话传入不同 launchProfileId 时以已存值为准并回带
  profileLocked，不报错不中断（AC-007）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-007
---
## Proposal

GOAL-001 的 AC-007 要求：已锁定会话传入不同 `launchProfileId` 时以已存值为准并回带 `profileLocked`，不报错不中断；取假形态：客户端值被采纳，或请求被拒绝，两者都红。目前 `server/modules/launch-profiles/` 不存在，`sessions.launch_profile_id` 列未建，`chat-websocket.service.ts` 的 `dispatchRun` 也没有任何 profile 锁定逻辑（`tasks/` 中没有任何任务以 `goal_ac: AC-007` 推进该判据，判据测试 `session-profile-lock.test.ts` 因模块缺失而红），这是结构性缺口。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）「锁定语义的实现」一节与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-secret-never-persisted-test（AC-003）建立 `sessions.launch_profile_id` 列迁移与 launch_profiles 表；gap-launch-profiles-env-injection-closed-test（AC-004）同样改动 `dispatchRun` 入口的 client options 处理。本任务只覆盖会话级锁定语义：首次 send 写入、其后以已存值为准，与白名单和持久化防护无关。

方案（最小切片）：
1. 在 `server/modules/launch-profiles/` 新增纯决策函数 `resolveSessionProfileLock(storedId, clientId)`：已存值为空时采纳客户端值并标记需写入；已存值非空且与客户端值不同时返回已存值与 `profileLocked: true`；相同或客户端未传时返回已存值且不带锁定标记。永不抛错。
2. 在 `server/modules/websocket/services/chat-websocket.service.ts` 的 `dispatchRun` 中，首次 send 通过 sessions 仓库写入 `launch_profile_id`；其后以已存值覆盖 `runtimeOptions.launchProfileId`，并向 `run.writer` 所在连接回带 `profileLocked: true`，run 照常继续，不发协议错误。
3. 新增 `server/modules/launch-profiles/tests/session-profile-lock.test.ts`：经真实 `dispatchRun` 入口与注入的 runtime 捕获 `runtimeOptions`，先以 profile A 首次发送，再以 profile B 发送，断言运行时收到的是 A、响应含 `profileLocked: true`、run 正常完成且无 error 事件；再断言相同 id 与未传 id 时不带 `profileLocked`。
4. 取假变体：把实现临时换成「采纳客户端值」与「抛错/拒绝请求」两种，测试都必须变红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/session-profile-lock.test.ts` 退出码 0（AC-007 的判据命令）。
- [x] 测试断言：已锁定会话以不同 `launchProfileId` 发送时，注入 runtime 收到的 `runtimeOptions.launchProfileId` 等于已存值，且回带消息含 `profileLocked: true`（`assert.strictEqual`）。
- [x] 测试断言该次请求不报错不中断：`dispatchRun` 返回 `started: true`、`error: null`，没有 `sendProtocolError` 调用，run 正常收到 `complete`。
- [x] 取假变体通过：采纳客户端值的变体与拒绝请求的变体各自使测试变红；`npm run typecheck` 与 `npm test` 退出码 0（既有 server 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求测试经由真实的 `chat-websocket.service.ts` `dispatchRun` 入口与真实（临时）sqlite 的 `sessions.launch_profile_id` 列驱动两次 send，而不是只直接调用纯决策函数；两种取假变体（采纳客户端值、拒绝请求）都被证明使测试变红。AC-007 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-007` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/session-profile-lock.ts (new)
- server/modules/launch-profiles/index.ts (new)
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/launch-profiles/tests/session-profile-lock.test.ts (new)
- server/modules/database/migrations.ts
- server/modules/database/schema.ts
- server/modules/database/repositories/sessions.db.ts
- tasks/gap-launch-profiles-session-profile-lock-test.md

## Needs-Human

**执行 2026-09-20T03:54:52.111Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-launch-profiles-session-profile-lock-test — 3 violation(s)
- run_id：wk-prod-anchor
- session_id：1753df93-1c0d-4053-9404-4c5b6685c080
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-session-profile-lock-test-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-20T05:54:36.288Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7104 lint passed=false end_ms=1789883644084
- run_id：wk-prod-anchor
- session_id：addceda4-14e4-4556-88e5-20c5e39c931e
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-launch-profiles-session-profile-lock-test~wk-prod-anchor~1789883620689-4b84d8.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-session-profile-lock-test-wk-prod-anchor.log
