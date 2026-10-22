---
id: AC-200
title: Monitor 事件在转写投影层折叠成一行：历史不变，超时显示为已停止，不同任务不合并
status: achieved
kind: criterion
goal: GOAL-015
criterion: npx vitest run src/modules/chat/tests/monitorEventCollapse.test.ts
expect: useChatMessages 的投影：同一 task-id 的连续 Monitor
  事件用户行折叠成一行，显示描述与事件个数，可展开看事件列表；同一输入的非折叠投影仍含全部原始行（历史与存储不变，转写仍是 CLI
  的权威记录）；Monitor 超时那条（事件正文 Monitor timed out）显示为已超时或已停止，不是错误样式；不同 task-id
  的事件不合并；被其它消息隔开的同一 task-id 事件不跨过隔断合并。取假形态：按文本相等合并 ⇒ 不同任务同文事件用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 实测 2026-10-01：Monitor 的每个事件都是一条排队的
  task-notification 用户行，既进转写又触发一个无人回合；超时表现为 task_updated(killed) 加
  task_notification(stopped)。
activatedAt: 2026-10-03T15:51:46.819Z
statusLog:
  - at: 2026-10-03T15:51:46.819Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T18:03:06.417Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:46.819Z
---
