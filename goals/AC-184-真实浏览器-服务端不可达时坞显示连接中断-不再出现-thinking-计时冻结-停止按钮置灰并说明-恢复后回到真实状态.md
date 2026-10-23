---
id: AC-184
title: 真实浏览器：服务端不可达时坞显示连接中断，不再出现 Thinking，计时冻结，停止按钮置灰并说明，恢复后回到真实状态
status: achieved
kind: criterion
goal: GOAL-014
criterion: npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"
expect: 真实服务端与真实应用，调试 agent 场景保持一个回合开着（spec 须登记进 playwright.config.ts 的
  DEBUG_AGENT_SPEC_FILES）；经 page.routeWebSocket 在 app 自己的 socket
  上分区（丢弃服务端到页面的帧，随后以 1006 关闭并拒绝重连，夹具机制已在 §10.2 实测）。判定阈值由服务端宣告，该 e2e
  把它缩到亚秒级；出货默认值由 AC-182 断言。必须同时登记五个读数：(i) 分区前坞状态为回合中且不是 unreachable；(ii) 阈值之后
  [data-activity-dock] 的 data-activity-state 为
  unreachable，且坞内文本不含任何回合进行中的文案（Thinking、Processing、Analyzing 等）；(iii) 间隔不少于 1
  秒的两次读数，已用时间文本相等；(iv) 停止按钮 disabled 且带说明文字；(v)
  放行后在一个重连周期内回到回合中状态，已用时间由快照推算。墙钟须实测不超过 20 秒。取假形态：坞仍读本地 processingSessions
  与本地计时器 ⇒ (ii) 与 (iii) 必须红；把冻结改回本地自增 ⇒ (iii) 必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§9 实测、§10
  夹具调研）。人 yale 2026-10-01 裁定：心跳 5 秒且 15 秒判定不可达；新增控制动词与 cancel-queued
  都做归属校验；取消计划任务不做控件；历史里的 isMeta 行显示与对等方目录本期不纳入。 用户报告：服务器挂了 Thinking 仍在显示。§10.2
  实测：routeWebSocket 分区夹具在本仓库真实 e2e 环境可行，整次运行 25 秒。
activatedAt: 2026-10-01T13:39:23.787Z
statusLog:
  - at: 2026-10-01T13:39:23.787Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-02T04:40:21.448Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-01T13:39:23.787Z
---
