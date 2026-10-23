---
id: AC-196
title: 停止任务：处理函数校验会话、归属与任务，限时，以 task_notification 为确认
status: achieved
kind: criterion
goal: GOAL-015
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/chat-stop-task.test.ts
expect: WS 处理函数加驱动（resident 与 per-run 各一条，Query 用脚本化替身）。读数：缺
  sessionId、taskId、requestId 各自被拒；会话不存在 ⇒ 拒绝；会话归属不符 ⇒ forbidden 且不调用驱动；taskId
  不在任务表或已终结 ⇒ unknown-task 且不调用 stopTask（SDK 对未知与已结束的 id
  会静默成功，所以必须由服务端自己校验）；校验通过 ⇒ 调 stopTask，回执带 requestId 且只表示请求已受理；任务的终态由随后到达的
  task_notification(stopped) 驱动任务表变化；限时内没有该事件 ⇒ 回执 timeout，任务保持原状态；stopTask
  抛错或永不返回 ⇒ 不挂住处理函数；能力矩阵里该能力为 false 时回执 unsupported。取假形态：在回执里乐观地把任务标为 stopped ⇒
  终态读数必须红；省略归属校验 ⇒ forbidden 用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 实测 2026-10-01：q.stopTask 对运行中任务约 100
  毫秒后出现 killed 与 stopped 通知；对已结束或不存在的 id 静默成功、没有任何事件。驱动现有的窄类型
  ClaudeResidentQuery 没有声明 stopTask。
activatedAt: 2026-10-03T15:51:35.460Z
statusLog:
  - at: 2026-10-03T15:51:35.460Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T17:56:07.654Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:35.460Z
---
