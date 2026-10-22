---
id: AC-194
title: 真实浏览器：坞里看到任务与计划，状态不刷新就变化，重载后由快照恢复，卡片按 toolUseId 读任务，计划只读
status: achieved
kind: criterion
goal: GOAL-015
criterion: npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"
expect: 调试 agent 场景发出 task_started、task_progress、task_updated、task_notification
  与一个 cron 计划（若现有场景操作不足，扩展调试 agent 是本条的实现面，且不得改变其它场景的行为；spec 须登记进
  DEBUG_AGENT_SPEC_FILES）。读数：坞摘要显示后台任务数与计划数；展开面板按类型列出任务，含描述、状态、已运行时间、最近动作，计划含表达式、下次触发倒计时、提示词；任务完成后状态在不刷新页面的情况下变化；整页重载后面板由快照恢复；转写里
  Agent 与 Bash 卡片的头部读 Task，显示实时状态而不是只写 running；计划行没有任何取消控件（选择器计数为 0）。墙钟须实测不超过 40
  秒。取假形态：卡片继续只读折叠行推断状态 ⇒ 卡片读数必须红；面板数据改为轮询 /api/session-hosts ⇒
  重载恢复与不刷新变化两条读数至少一条必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 调查
  2026-10-01：现状客户端没有任务实体、列表、进度；弹层只数每种租约的个数；cron 与唤醒没有任何展示。
activatedAt: 2026-10-03T15:51:32.423Z
statusLog:
  - at: 2026-10-03T15:51:32.423Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T19:43:52.757Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:32.423Z
---
