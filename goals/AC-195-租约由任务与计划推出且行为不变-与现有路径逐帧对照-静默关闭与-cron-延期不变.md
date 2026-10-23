---
id: AC-195
title: 租约由任务与计划推出且行为不变：与现有路径逐帧对照，静默关闭与 cron 延期不变
status: achieved
kind: criterion
goal: GOAL-015
criterion: '[ -f
  server/modules/providers/tests/claude-activity-lease-parity.test.ts ] || {
  echo
  "缺判据文件：server/modules/providers/tests/claude-activity-lease-parity.test.ts"
  >&2; exit 1; }; [ -f
  server/modules/providers/tests/claude-resident-idle.test.ts ] || { echo
  "缺判据文件：server/modules/providers/tests/claude-resident-idle.test.ts" >&2; exit
  1; }; [ -f server/modules/providers/tests/claude-background-work.test.ts ] ||
  { echo "缺判据文件：server/modules/providers/tests/claude-background-work.test.ts"
  >&2; exit 1; }; npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-activity-lease-parity.test.ts
  server/modules/providers/tests/claude-resident-idle.test.ts
  server/modules/providers/tests/claude-background-work.test.ts'
expect: 对同一批真实帧序（任务嵌套、Monitor 停止、cron 与唤醒、Stop hook 清单变化），由 Task 表与计划表推出的租约集合与现有
  observeHeldWorkEvent 加 reconcileHeldWork
  路径得到的租约集合逐帧相等；两条路径并存期间不一致即红并打印第一处不一致的帧序号。既有的 claude-resident-idle 与
  claude-background-work 全部保持绿，静默关闭上限与 cron 延期行为不变。取假形态：推导里漏掉一类终态 ⇒ 对照用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 设计
  2026-10-01：租约决定进程能不能关，行为不能变；先并存对照再收敛。
activatedAt: 2026-10-03T15:51:34.574Z
statusLog:
  - at: 2026-10-03T15:51:34.574Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T18:23:02.704Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:34.574Z
---
