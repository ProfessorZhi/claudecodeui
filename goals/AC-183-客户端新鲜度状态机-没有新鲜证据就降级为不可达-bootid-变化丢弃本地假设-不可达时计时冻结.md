---
id: AC-183
title: 客户端新鲜度状态机：没有新鲜证据就降级为不可达，bootId 变化丢弃本地假设，不可达时计时冻结
status: achieved
kind: criterion
goal: GOAL-014
criterion: npx vitest run src/modules/chat/tests/activityFreshness.test.ts
expect: 纯状态机，假定时器加假 socket，不碰真实网络。读数：收到任一帧后为 fresh；在服务端宣告的 staleAfter 内没有任何帧则进入
  unreachable，阈值前 1 毫秒仍为 fresh、阈值处进入 unreachable；之后任一帧到达回到 fresh；socket 的 close
  立即进入 unreachable，不等阈值；收到 bootId 与已存不同的帧时丢弃一切本地进行中假设，以该帧所带快照为准；unreachable
  期间已用时间由服务端的 asOf 与 turn.startedAt 推算并冻结，间隔读两次相等，而不是继续用本地时钟自增。取假形态：(i) 把已用时间改回
  Date.now 与 startedAt 的差 ⇒ 冻结用例必须红；(ii) 忽略 bootId 变化 ⇒ 重启用例必须红；(iii) 把
  unreachable 判定改成永远 fresh ⇒ 迁移用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§9 实测、§10
  夹具调研）。人 yale 2026-10-01 裁定：心跳 5 秒且 15 秒判定不可达；新增控制动词与 cancel-queued
  都做归属校验；取消计划任务不做控件；历史里的 isMeta 行显示与对等方目录本期不纳入。 调查 2026-10-01：现状
  processingSessions 只有
  complete、protocol_error、空闲应答和成功的轮询能清除条目，服务端宕机时都不会发生，ActivityIndicator
  用本地时钟一直计时，聊天模块不读 isConnected。
activatedAt: 2026-10-01T13:38:41.403Z
statusLog:
  - at: 2026-10-01T13:38:41.403Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-01T14:30:21.760Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-01T13:38:41.403Z
---
