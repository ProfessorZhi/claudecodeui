---
id: AC-188
title: 真实浏览器：页面上只有一个活动坞，旧的活动页签与 resident 状态栏的忙闲字样不再存在，各处状态一致
status: achieved
kind: criterion
goal: GOAL-014
criterion: npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"
expect: 调试 agent 场景保持回合开着，再让它结束。读数：任一时刻页面里恰有一个
  [data-activity-dock]；旧的独立活动页签与内联行的选择器计数为 0；resident
  状态栏里不再有自己的忙闲状态与租约计数（地址、pid、起停关闭保留，并入坞的展开面板）；回合开着期间坞为回合中、侧栏运行视图与发送按钮的停止态一致，回合结束后全部一致回到空闲，任何时刻不出现坞说空闲而别处说忙。桌面与移动两个视口各读一次。取假形态：保留旧
  ActivityIndicator 的挂载 ⇒ 数量读数必须红；让状态栏继续读 1 秒轮询的 busy ⇒ 一致性读数在回合刚结束的窗口内必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§9 实测、§10
  夹具调研）。人 yale 2026-10-01 裁定：心跳 5 秒且 15 秒判定不可达；新增控制动词与 cancel-queued
  都做归属校验；取消计划任务不做控件；历史里的 isMeta 行显示与对等方目录本期不纳入。 调查
  2026-10-01：现状有四个互不相干的忙来源（processingSessions、/api/session-hosts
  轮询、发送按钮、侧栏），可以互相矛盾。
activatedAt: 2026-10-01T14:07:21.519Z
statusLog:
  - at: 2026-10-01T14:07:21.519Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-02T08:39:28.199Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-01T14:07:21.519Z
---
