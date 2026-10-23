---
id: AC-193
title: 活动协议：REST 快照加 WS 增量，带 rev，晚加入者先快照后增量，rev 不连续即重拉
status: achieved
kind: criterion
goal: GOAL-015
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/activity-protocol.test.ts
expect: 读数：GET 会话的活动快照返回 turn、tasks、schedules 与当前 rev；任务或计划变化时 WS 推送整条快照式的
  upsert，rev 单调递增；客户端在快照 rev 之后才接受增量；收到 rev
  不连续的增量时测试用的客户端重拉快照而不是自行拼接；同一会话两个连接各自持有游标，互不影响；快照里没有任何会话级的内存泄漏项（会话结束后任务与计划按保留策略淘汰）。取假形态：增量不带
  rev ⇒ 不连续用例必须红；快照与增量用不同来源 ⇒ 一致性用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 设计 2026-10-01：推送与快照必须同源；现状是 1 秒轮询
  /api/session-hosts，隐藏标签页即停，短命任务可能整个错过。
activatedAt: 2026-10-03T15:51:28.019Z
statusLog:
  - at: 2026-10-03T15:51:28.019Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T17:04:02.190Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:28.019Z
---
