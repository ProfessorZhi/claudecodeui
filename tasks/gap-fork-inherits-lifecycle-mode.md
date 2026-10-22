---
id: gap-fork-inherits-lifecycle-mode
title: fork 继承源会话的 lifecycle_mode（resident 源 → resident fork）：推翻 AC-169 判据 (3)「分叉不继承」
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -il "createForkedSession\|forkSessionById" tasks/*.md` 命中已完成的 `gap-lifecycle-mode-matrix-and-host-api`（AC-169）——它**正是本条要推翻的那一条**：其判据 (3) 与假形态 (b) 要求「分叉不继承 lifecycle_mode」。无任何在飞任务在改 `createForkedSession` 的列清单；`gap-fork-from-assistant-reply-anchor` 只动锚点与按钮位置，不碰落库列。⇒ 不是重复。

**人的裁定（yale，2026-10-07，对话原话）**：「AC-169 作废。fork 后自动继承 resident。」即：`docs/proposals/claude-resident-sessions.md` §13.5「分叉出的会话默认 per-run，不继承 `lifecycle_mode`」与 §14「分叉会话：新会话默认 per-run，不继承常驻」不再成立；一个 resident 会话被 fork 后，新会话的 `lifecycle_mode` 为 `resident`。

**现状（实测）**：`server/modules/providers/services/sessions.service.ts` 的 `forkSessionById` 调 `sessionsDb.createForkedSession` 时传了 `model` / `effort` / `permissionMode`，**没传** lifecycle_mode；`server/modules/database/repositories/sessions.db.ts` 的 `createForkedSession` 的 INSERT 列清单也不含 `lifecycle_mode`，新行拿列默认 `'per-run'`。线上库读数：最近 15 个 fork 里，10-05 与 10-06 的三个 resident 源产出的 fork 全是 per-run（共 136 个 resident、5413 个 per-run 会话）。发送路径（`server/index.ts:473`）按 `getSessionLifecycleMode` 选 resident / per-run，所以 fork 会静默退回 per-run。

**方案**：
1. `createForkedSession` 入参加 `lifecycleMode`，写进 INSERT 的 `lifecycle_mode` 列。
2. `forkSessionById` 用 `sessionsDb.getSessionLifecycleMode(sessionId)`（未知值回落 `per-run`）取源会话的模式并传入。
3. **只复制偏好值，不拉起进程**：fork 出来的会话没有 host，进程在第一次发送时才起（偏好不等于进程已存在，`schema.ts` 对该列的注释）。fork 之后 `sessionHostManager.notifyHostsChanged()` 已在位，无需另加。
4. **知情确认**：本条按裁定「自动继承」，不为 fork 另加知情勾选（源会话进入 resident 时已过 `gap-claude-resident-consent-gate` 的知情面）。这一点在完成记录里如实写明，不扩展成新的确认流。
5. **推翻侧的同步**：`lifecycle-mode.test.ts` 的 `(3)` 用例与 `assertForkDoesNotInherit` 改为断言「继承」，假形态 (b) 反向（fork 丢掉模式 ⇒ 红）；`docs/proposals/claude-resident-sessions.md` §13.5 与 §14 写明被 2026-10-07 裁定取代。per-run 源 fork 后仍是 per-run（正控制）。

**不在本任务范围**：`goals/AC-169-*.md` 的状态与 `expect` 文案——那是 goal 层对象，由人或 goal-driver 处理，worker 不改（见 AC 中的（待外部）项）。fork 按钮位置与锚点见 `gap-fork-from-assistant-reply-anchor`。

## Plan

1. **先红**：在 `session-fork.test.ts` 加「resident 源 fork 后读回 resident」用例，在当前树上跑出红态文案（`forkedMode=per-run`）。
2. 改 `createForkedSession` 与 `forkSessionById`（上面方案 1–3）。
3. 同步 `lifecycle-mode.test.ts` 的 (3) 与假形态 (b)；跑出反向假形态的红态读数。
4. 改 proposal §13.5 / §14。
5. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑各判据；写完成记录（含「不另加知情确认」的说明）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-fork.test.ts` 退出码 0，且新增用例断言——resident 源 fork 后新会话 `lifecycle_mode` 读回 `resident`（打印 `sourceMode=resident forkedMode=resident`），`forked_from_session_id` 指向源，且 fork 之后**没有**任何 host 被拉起（打印 `hostsStartedByFork=0`，证明只复制偏好、不启进程）。
- [x] 正控制：同文件用例断言 per-run 源 fork 后仍是 `per-run`（打印 `sourceMode=per-run forkedMode=per-run`），防「一律写 resident」。
- [x] 推翻侧同步：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/lifecycle-mode.test.ts` 退出码 0 且 `fail 0`；其 (3) 用例现断言继承（`sourceMode=resident forkedMode=resident`），文件里不再有断言 `forkedMode` 为 `per-run` 的 resident 源用例；其余 (1)(2)(4)(5) 用例与假形态 (a)(c)(d)(e) 不变且仍绿。
- [x] 假形态承重：把 `forkSessionById` 改回不传 lifecycleMode 后，上面两个命令里与「继承」相关的用例**必须红**（完成记录写出实测红文案）；还原后转绿。
- [x] `docs/proposals/claude-resident-sessions.md` 的 §13.5 与 §14 不再写「默认 per-run，不继承」，并注明被 2026-10-07 人的裁定取代：`grep -n "不继承" docs/proposals/claude-resident-sessions.md` 的剩余命中逐条核对，没有一处仍在主张 fork 不继承（核对结果写进完成记录）。
- [x] `npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出码均为 0。
- [ ] `goals/AC-169-*.md` 的状态与 `expect`（其中 (3) 仍写「分叉出的会话为 per-run」）按人的裁定作废或改写，该行只能由人或 goal-driver 写入，执行者不得代写（待外部）

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`）里，用一个 `lifecycle_mode='resident'` 的会话（已有 transcript），经真实路由 `POST /api/providers/sessions/:sessionId/fork` 对它 fork：(1) 直接读库，新行 `lifecycle_mode` 为 `resident`、`forked_from_session_id` 为源 id；(2) `GET /api/session-hosts` 里 fork 之后**没有**为它新增的 host；(3) 对该 fork 发第一条消息后，该会话出现在 `GET /api/session-hosts` 的投影里且 `mode=resident`（走的是 resident 发送路径，不是 per-run）。同样对一个 per-run 会话 fork，读回 `per-run`。三处读数写进完成记录。

## Touches

- server/modules/database/repositories/sessions.db.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/tests/session-fork.test.ts
- server/modules/providers/tests/sessions.service.test.ts
- server/modules/session-hosts/tests/lifecycle-mode.test.ts
- docs/proposals/claude-resident-sessions.md
- tasks/gap-fork-inherits-lifecycle-mode.md

## 完成记录

实现提交：`283da6f0`（分支 `task/gap-fork-inherits-lifecycle-mode`）。改动文件 6 个（列于 Touches）。

### AC 逐条读数

- **AC1（继承，退出 0）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-fork.test.ts` → `ℹ tests 10 / ℹ pass 10 / ℹ fail 0`，退出 **0**。新增用例打印 `sourceMode=resident forkedMode=resident hostsStartedByFork=0`；断言 `sourceMode==='resident'`、`forkedMode==='resident'`、`forkedRow.forked_from_session_id===源 id`、`hostsStartedByFork===0` 且 `hostsAfter===hostsBefore`（fork 后 `sessionHostManager.snapshot()` 无绑定该 fork 的 host）。
- **AC2（正控制）**：同文件用例 `'a fork of a per-run session stays per-run'` 打印 `sourceMode=per-run forkedMode=per-run`，断言两者皆 `per-run`——防「一律写 resident」。
- **AC3（推翻侧同步）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/lifecycle-mode.test.ts` → `ℹ tests 9 / ℹ pass 9 / ℹ fail 0`，退出 **0**。(3) 用例已更名 `'(3) a fork of a resident session inherits its mode and points at its source'`，打印 `[lifecycle] fork: sourceMode=resident forkedMode=resident`，末断言 `assert.equal(forkedMode, 'resident', 'a fork must inherit the source lifecycle mode')`；原 `assertForkDoesNotInherit` 更名 `assertForkInherits`，文件中不再有断言 resident 源 fork 为 per-run 的用例。(1)(2)(4)(5) 与假形态 (a)(c)(d)(e) 未动、仍绿（假形态用例 `the five fake forms each red the reading they are aimed at` ✔）。
- **AC4（假形态承重，实测红文案）**：临时删除 `forkSessionById` 里 `lifecycleMode: sessionsDb.getSessionLifecycleMode(sessionId),` 一行后重跑两条命令，两个文件里与继承相关的用例**均红**：
  - `session-fork.test.ts`：`AssertionError: a fork must inherit the source lifecycle mode`，`+ actual 'per-run' - expected 'resident'`；
  - `lifecycle-mode.test.ts` (3)：同一 `AssertionError`，`+ actual 'per-run' - expected 'resident'`。
  还原该行后两条命令转绿（AC1/AC3 的上述读数）。
- **AC5（proposal 同步）**：`grep -n "不继承" docs/proposals/claude-resident-sessions.md` 退出码 **1**、零命中（`不继承` 已从文件清除）。§13.5、§14 表格行、§15.2 三处均已改写为「fork 继承源的 `lifecycle_mode`」并注明被 2026-10-07 人的裁定取代（AC-169 作废）。核对结果：无一处仍在主张 fork 不继承。
- **AC6（工具链）**：`npm run typecheck` 退出 **0**；`npm run lint` 退出 **0**；`npx oxlint server/ src/` 退出 **0**（0 warning / 0 error）。
- **AC7（待外部，未勾）**：`goals/AC-169-*.md` 的状态与 `expect` 属 goal 层对象，按人的裁定作废或改写，**只能由人或 goal-driver 写入**。worker 不代写，故保持未勾；构词含 `（待外部）`，fan-in 的 ac 门按 `pass-external` 处理。

### DoD 真实服务读数

探针（临时 `HOME` + 临时 `DATABASE_PATH`，起真实服务实例，经真实路由 `POST /api/providers/sessions/:sessionId/fork`），退出 **0**：

```
[DoD-1] residentFork.mode=resident residentFork.forkedFrom=dod-resident-source (source=dod-resident-source)
[DoD-1] perRunFork.mode=per-run perRunFork.forkedFrom=dod-perrun-source (source=dod-perrun-source)
[DoD-2] hostsTotal=0 hostsForResidentFork=0 hostsForPerRunFork=0
[DoD-3] projection.residentFork.lifecycleMode=resident running=false reason=No resident host is running for this session; the last server stop or restart dropped it.
[DoD-3] projection.perRunFork.lifecycleMode=per-run running=false reason=null
[DoD-3] sendPath: residentFork.readSessionLifecycle.mode=resident perRunFork.readSessionLifecycle.mode=per-run
```

- (1) 读库：resident 源 fork 的新行 `lifecycle_mode='resident'`、`forked_from_session_id='dod-resident-source'`；per-run 源 fork 的新行 `'per-run'`、源 id 同步。
- (2) fork 后 `GET /api/session-hosts` 内与两个 fork 相关的 host 数均为 **0**（只复制偏好，不启进程）。
- (3) 落在发送路径的**判定点**（`sessionsService.readSessionLifecycle(sessionId).mode`，即 `server/index.ts` 发送分派所读的同一值）：resident fork 读回 `resident`、per-run fork 读回 `per-run`；服务投影中 resident fork 的 `lifecycleMode=resident`。

**如实说明（未回避的缺口）**：本条环境无可用在线模型端点，DoD(3) 要求的「对该 fork **发第一条消息**后」这一**在线发送**读数**未取得**——resident fork 的真实发送会经 resident host 启动路径，而本环境未接 `startResidentSession` 驱动 seam（尝试经 `/start` 路由触发时返回 `500 INTERNAL_ERROR`）。因此 DoD(3) 记的是发送路径的**判定点读数**（`readSessionLifecycle.mode=resident`）+ 服务投影，而非端到端的在线回执。此缺口不勾任何 AC（AC1–AC6 的判据均不依赖在线模型），仅如实记录，不代写「已发送」的结论。

### 知情确认（方案 4）

按人的裁定「自动继承」，本任务**未**为 fork 新增任何知情勾选：fork 的 resident 偏好是复制源会话的既有选择，源会话进入 resident 时已经过 `gap-claude-resident-consent-gate` 的知情面，故不扩展成新的确认流。

### Touches 说明

`server/modules/providers/tests/sessions.service.test.ts` 为本次新增到 Touches：它是 `createForkedSession` 的第三个调用点，`lifecycleMode` 成为必填入参后该调用点需补 `lifecycleMode: 'per-run'`（源未设模式，读回列默认）。已声明在 Touches 中。
