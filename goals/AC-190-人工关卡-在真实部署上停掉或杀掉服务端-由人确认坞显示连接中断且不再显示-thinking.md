---
id: AC-190
title: 人工关卡：在真实部署上停掉或杀掉服务端，由人确认坞显示连接中断且不再显示 Thinking
status: achieved
kind: criterion
goal: GOAL-014
criterion: test "$(grep -c '^- 人工验收 GOAL-014：accepted'
  docs/proposals/claude-session-activity-dock.md)" -ge 1 || { echo 'GOAL-014
  人工验收尚未记录：docs/proposals/claude-session-activity-dock.md 里没有 "- 人工验收
  GOAL-014：accepted" 行' >&2; exit 1; }
expect: 只有人的验收动作才能让它为真：人在真实部署上让一个会话处于处理中，然后停掉或杀掉服务端，读到坞在约 15 秒内显示连接中断、不再显示
  Thinking、计时不再前进；再起服务端后坞恢复。人在 docs/proposals/claude-session-activity-dock.md
  里加一行 "- 人工验收 GOAL-014：accepted <人> <日期>"。前面的 AC 全绿而本条未通过时，正确的终态是
  needs-human，不是 done。不得给本条的待办加 （待外部） 后缀。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§9 实测、§10
  夹具调研）。人 yale 2026-10-01 裁定：心跳 5 秒且 15 秒判定不可达；新增控制动词与 cancel-queued
  都做归属校验；取消计划任务不做控件；历史里的 isMeta 行显示与对等方目录本期不纳入。 经验：人工关卡必须是一条带可运行判据的 AC，写成 DoD
  散文会被机械 fan-in 绕过。
activatedAt: 2026-10-01T13:46:57.741Z
statusLog:
  - at: 2026-10-01T13:46:57.741Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T03:31:17.033Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-01T13:46:57.741Z
---
