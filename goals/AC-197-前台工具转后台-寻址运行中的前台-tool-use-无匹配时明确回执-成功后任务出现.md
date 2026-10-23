---
id: AC-197
title: 前台工具转后台：寻址运行中的前台 tool_use，无匹配时明确回执，成功后任务出现
status: achieved
kind: criterion
goal: GOAL-015
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/chat-background-task.test.ts
expect: 读数：目标是 Turn Tracker 里尚未配对 tool_result 的前台 tool_use，不是任务表；toolUseId
  没有匹配的前台工具 ⇒ 回执 no-foreground-match（对应 SDK 返回 false）且不改任何状态；成功 ⇒ 回执受理，随后
  task_started 与 task_updated(is_backgrounded) 到达，任务表出现该任务；不带 toolUseId
  的全部转后台形态不被暴露；归属与 requestId 校验同 AC-196。取假形态：把 taskId 当寻址对象 ⇒
  前台工具用例必须红（前台工具转后台之前根本没有 taskId）。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 实测 2026-10-01：前台 Bash 在被转后台之前没有
  task_started；q.backgroundTasks(toolUseId) 返回 true 的同时才出现 task_started 与
  is_backgrounded，对没有匹配前台工具的 id 返回 false。
activatedAt: 2026-10-03T15:51:36.359Z
statusLog:
  - at: 2026-10-03T15:51:36.359Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T19:27:41.611Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:36.359Z
---
