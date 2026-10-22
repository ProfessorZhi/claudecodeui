---
id: gap-client-activity-freshness-state-machine
title: AC-183 客户端新鲜度状态机：没有新鲜证据就降级为不可达，bootId 变化丢弃本地假设，不可达时计时冻结
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-183
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：GOAL-014 里同属「活动真实性」的 AC-182 已由 `tasks/gap-activity-heartbeat-server-frames.md` 认领（`goal_ac: AC-182`），那条讲的是**服务端按节拍发心跳帧**，与本条「客户端新鲜度状态机」是不同机制——前者证明「服务端在发帧」，后者证明「没有帧时客户端怎么降级」。其余 task 里 `grep -rl "goal_ac: AC-183" tasks/` 0 命中，`grep -rln "新鲜度状态机\|activityFreshness\|staleAfter" tasks/` 只命中 AC-182 那条对 AC-183 的旁述（`gap-voice-*`、`gap-asr-*` 等命中的 `unreachable` 讲的是上游不可达/能力读取，与客户端本地状态机无关）。生产源码 `grep -rn "bootId\|staleAfter\|activityFreshness" src --include=*.ts --include=*.tsx` 0 命中，`src/modules/chat/tests/activityFreshness.test.ts` 不存在。⇒ 客户端新鲜度状态机无人认领，不是重复。

**现状读数（2026-10-01，读代码）。** 客户端「处理中」是一张本地表 `processingSessions`（`src/shared/hooks/useSessionProtection.ts`，第 35 行起），只有 `complete`、`protocol_error`、一次空闲订阅应答、成功的轮询能清除；`ActivityIndicator`（`src/modules/chat/composer/ActivityIndicator.tsx`）用本地时钟一直计时；`isConnected`（`src/shared/context/WebSocketContext.tsx`）从不被聊天模块读。于是服务端不可达时它永久显示并计时（提案 §2 表 A1）。提案 §4.4 / §10.2（L2 层）把「客户端新鲜度状态机」裁为与其余解耦、可独立先行的纯函数层：假定时器加假 socket，承担全部边界值；「没有帧时客户端怎么表现」由本条与 AC-184 分担（真实部署由 AC-190 人工确认）。

**要做的事。** 新增一个**纯状态机**：以服务端宣告的 `staleAfter` 为阈值，收到任一帧即 fresh；阈值内无帧则降级 unreachable；socket close 立即 unreachable；bootId 变化丢弃本地进行中假设、以帧所带快照为准；unreachable 期间已用时间由服务端 `asOf` 与 `turn.startedAt` 推算并**冻结**（不随本地时钟自增）。本条只做状态机与它的假定时器/假 socket 判据，不碰真实网络，也不改 UI（UI 接入是 AC-184）。

## Plan

1. 红态先行：写判据文件 `src/modules/chat/tests/activityFreshness.test.ts`（路径由 AC 固定）。用 `vi.useFakeTimers()` + `vi.setSystemTime()` 驱动时间，用一个内存 frame 源（普通函数调用喂帧，不是真实 socket）模拟「假 socket」；实现前该文件红（被导入的模块不存在）。
2. 实现 `src/modules/chat/utils/activityFreshness.ts`：导出纯工厂 `createActivityFreshness(deps?)` 与其帧/状态类型。内部状态：`liveness`、`bootId`、`rev`、`asOf`、`turn.startedAt`、`staleAfter`。`onFrame(frame)`：若帧 `bootId` 与已存不同则以该帧快照为准、丢弃一切本地进行中假设；置 fresh、记录 `asOf`/`turn`/`staleAfter`，并按 `staleAfter` 重排判定定时器。定时器到点（阈值内无帧）⇒ unreachable。`onSocketClose()` ⇒ 立即 unreachable 并清定时器。`getElapsedMs()` = `asOf - turn.startedAt`（无进行中回合时为 null），冻结由「计算里不出现本地时钟」自然得到。时间与定时器经 `deps` 注入（默认取全局 `Date.now` / `setTimeout` / `clearTimeout`），使判据可纯测。
3. 判据逐条覆盖 AC2–AC7 的迁移与边界：初值、任一帧后 fresh、阈值前 1ms 仍 fresh / 阈值处 unreachable、恢复、close 立即、bootId 变化丢弃假设、不可达期间两次读 elapsed 相等。
4. 取假形态（先提交再变异，`git checkout -- <file>` 恢复，登记逐字失败行）：(i) `getElapsedMs` 改回 `Date.now() - startedAt` ⇒ AC7 冻结用例必须红；(ii) `onFrame` 忽略 `bootId` 变化、不丢弃本地假设 ⇒ AC6 重启用例必须红；(iii) 把 unreachable 判定改成永远 fresh（判定定时器不降级）⇒ AC3 迁移用例必须红。
5. `npx vitest run src/modules/chat/tests/activityFreshness.test.ts` 绿；`npm run typecheck` 与 `npm run lint` 绿；`git diff --stat` 与 `## Touches` 逐条对齐。

## 完成记录（worker，2026-10-01）

实现 `src/modules/chat/utils/activityFreshness.ts`（纯工厂 `createActivityFreshness(deps?)`，无可变全局；`liveness`/`bootId`/`rev`/`asOf`/`staleAfter`/`turnStartedAt`/`turnIsLocal` 均为每次调用私有）。判据 `src/modules/chat/tests/activityFreshness.test.ts`：`npx vitest run src/modules/chat/tests/activityFreshness.test.ts` → 6 passed，退出 0。

DoD 的本地时钟证明：`awk '/const getElapsedMs = /,/^  };$/' src/modules/chat/utils/activityFreshness.ts | grep -n 'Date.now\|deps.now'` → 0 命中；全文件仅第 89 行注入默认时钟 `now: () => Date.now()`（deps 接缝）。冻结是「已用时间计算路径里不出现本地时钟」的直接后果，不是额外分支。

取假形态（逐条先提交再变异，`git checkout -- src/modules/chat/utils/activityFreshness.ts` 恢复；现已还原、`git status` 干净）：
- (i) `getElapsedMs` 改回 `Date.now() - turnStartedAt` ⇒ AC7 红：`Expected values to be strictly equal: 7000 !== 17000`（`activityFreshness.test.ts:116`）。
- (ii) `const bootIdentityChanged = frame.bootId !== bootId;` 改成 `= false;`（忽略 bootId 变化）⇒ AC6 红：`9000 !== null`（`activityFreshness.test.ts:100`，本地进行中假设未被丢弃）。
- (iii) 判定定时器回调删去 `liveness = 'unreachable';` ⇒ AC3 红：`+ 'fresh' - 'unreachable'`（`activityFreshness.test.ts:53`）。

静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅仓库既有 warning）。`git diff --name-status develop...HEAD` 恰为两个新增文件（ASCII `(new)`），与 `## Touches` 前两条对齐。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/activityFreshness.test.ts` 退出 0。红态基线：实现前该文件不存在或红。
- [x] AC2 没有证据即降级：全新状态（未收到任何帧）为 unreachable；收到任一帧后 `getLiveness() === 'fresh'`（同一用例断言两个读数）。
- [x] AC3 阈值边界（承重）：在服务端宣告的 `staleAfter` 内推进 `staleAfter - 1` 毫秒仍为 fresh，再推进 1 毫秒（到达阈值处）进入 unreachable。
- [x] AC4 恢复：进入 unreachable 后，任一帧到达即回到 fresh。
- [x] AC5 close 立即不可达：不推进阈值时钟，`onSocketClose()` 调用后立即为 unreachable。
- [x] AC6 bootId 变化丢弃假设（承重）：先建立携带本地进行中假设的状态（如本地打标一个回合），再送入 `bootId` 与已存不同、且其所带快照为另一种状态的帧；断言本地假设被丢弃、读数完全以该帧所带快照为准。
- [x] AC7 不可达期间计时冻结（承重）：unreachable 期间，间隔推进墙钟后两次读 `getElapsedMs()` 相等，且等于 `asOf - turn.startedAt`（不是本地时钟自增）。
- [x] AC8 取假形态必须红：改为永远 fresh ⇒ AC3 红；(ii) 忽略 bootId 变化 ⇒ AC6 红；(iii) 已用时间改回本地时钟（`Date.now() - startedAt`）⇒ AC7 红。逐条登记变异 diff、逐字失败行与恢复命令。
- [x] AC9 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 状态机是纯的：不 import React、不 import `@/shared/context/WebSocketContext`、不建立任何真实网络/socket；时间与定时器经注入或全局假定时器驱动，判据里用的是 `vi.useFakeTimers()` 与内存 frame 源。
- 已用时间只由帧携带的 `asOf` 与 `turn.startedAt` 推算：实现里 elapsed 的计算路径不出现 `Date.now()`（用 grep 证明），冻结是这一事实的直接后果而非额外分支。
- 只被本条判据消费；不改共享类型、不改其它模块、不碰 UI，遵守 `.agents/skills/frontend-module-standards/SKILL.md`（`@/` 导入、`.ts` 非 JSX、用 `type` 不用 `interface`、无 module-local `utils.ts` 命名）。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- src/modules/chat/utils/activityFreshness.ts (new)
- src/modules/chat/tests/activityFreshness.test.ts (new)
- tasks/gap-client-activity-freshness-state-machine.md
