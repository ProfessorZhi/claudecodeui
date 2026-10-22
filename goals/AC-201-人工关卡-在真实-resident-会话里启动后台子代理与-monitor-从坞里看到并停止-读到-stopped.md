---
id: AC-201
title: 人工关卡：在真实 resident 会话里启动后台子代理与 Monitor，从坞里看到并停止，读到 stopped
status: achieved
kind: criterion
goal: GOAL-015
criterion: test "$(grep -c '^- 人工验收 GOAL-015：accepted'
  docs/proposals/claude-session-activity-dock.md)" -ge 1 || { echo 'GOAL-015
  人工验收尚未记录：docs/proposals/claude-session-activity-dock.md 里没有 "- 人工验收
  GOAL-015：accepted" 行' >&2; exit 1; }
expect: 只有人的验收动作才能让它为真：人在真实 resident 会话里让 Claude 启动一个后台子代理与一个
  Monitor，读到坞里列出它们的描述、状态与最近动作；从坞里停止 Monitor，读到它由 SDK 的通知变为
  stopped；对一个前台长命令用转后台。人在 docs/proposals/claude-session-activity-dock.md 里加一行 "-
  人工验收 GOAL-015：accepted <人> <日期>"。前面的 AC 全绿而本条未通过时，正确的终态是 needs-human，不是
  done。不得给本条的待办加 （待外部） 后缀。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 经验：人工关卡必须是一条带可运行判据的 AC。
activatedAt: 2026-10-03T15:51:47.280Z
statusLog:
  - at: 2026-10-03T15:51:47.280Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-04T14:16:08.474Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:47.280Z
---
