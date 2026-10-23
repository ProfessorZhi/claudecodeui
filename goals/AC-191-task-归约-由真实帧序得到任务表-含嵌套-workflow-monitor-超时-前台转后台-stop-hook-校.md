---
id: AC-191
title: Task 归约：由真实帧序得到任务表，含嵌套、Workflow、Monitor 超时、前台转后台、Stop hook 校准，重放幂等
status: achieved
kind: criterion
goal: GOAL-015
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-activity-task-reducer.test.ts
expect: 用 2026-10-01 真实捕获的帧序做夹具（后台子代理与其内部 Bash、后台 Bash、Monitor、Workflow、前台 Bash
  被转后台）。读数：(a) 嵌套任务的 parentTaskId 由 tool_use_id 与 parent_tool_use_id 还原；(b)
  Monitor 超时的 task_updated(killed) 加 task_notification(stopped) ⇒ state 为
  stopped，不是 failed；(c) Workflow 的 kind 为 workflow，带 workflowName，stepLabel
  取最近一条 task_progress 的 description；(d) 前台 Bash 在被转后台之前不是任务，task_started 与
  task_updated(is_backgrounded) 同刻出现后才有；(e) 只有 task_updated(completed) 而没有
  task_notification 的后台 Bash 也能终结；(f) Stop hook 的 background_tasks
  校准：清单里没有的未终结任务标为已结束且原因未知，清单里有而事件里没见过的补建并标 origin 为 stop-hook-snapshot；(g)
  同一事件重放结果不变；(h) 一个会话的任务不出现在另一个会话。取假形态：把 stopped 当成 failed ⇒ (b) 必须红；不看
  is_backgrounded 而在 tool_use 时就建任务 ⇒ (d) 必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 实测 2026-10-01：SDK 推送完整的
  task_started、task_updated、task_progress、task_notification，服务端只读 task_id
  增删租约，其余全部丢弃。
activatedAt: 2026-10-03T15:51:26.236Z
statusLog:
  - at: 2026-10-03T15:51:26.236Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T17:03:59.155Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:26.235Z
---
