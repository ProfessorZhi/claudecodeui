---
id: AC-192
title: 计划表：由 Stop hook 的 session_crons 与工具结果得到 cron 与唤醒，计算下次触发，触发后消失
status: achieved
kind: criterion
goal: GOAL-015
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-activity-schedules.test.ts
expect: 用 2026-10-01 真实读数做夹具：session_crons 项形如
  id、schedule、recurring、prompt，ScheduleWakeup 表现为 recurring 为 false 的一次性项且
  schedule 是绝对分钟。读数：cron 与唤醒都进入计划表；nextFireAt 由 5 段表达式算出（覆盖 "*/2 * * * *"、"58 20
  * * *"、每分钟）；粒度是分钟；回合进行中新建的计划先由 CronCreate 与 ScheduleWakeup 的 tool_result 文本（含
  id、Every 2 minutes、in 115s）显示，回合结束后由 Stop hook 校准；唤醒触发后下一次 Stop hook
  里消失，计划表随之删除；cron 带 7 天过期时间；同一分钟的两个计划各自存在。取假形态：只认 CronCreate 而忽略 ScheduleWakeup
  ⇒ 唤醒用例必须红；不被 Stop hook 校准 ⇒ 触发后消失用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 实测 2026-10-01：CronCreate 与
  ScheduleWakeup 都没有 task_* 事件，Stop hook 的 session_crons 是完整权威的清单，现有
  inferHeldWork 只处理 CronCreate 与 CronDelete。
activatedAt: 2026-10-03T15:51:27.133Z
statusLog:
  - at: 2026-10-03T15:51:27.133Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T17:42:24.835Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:27.132Z
---
