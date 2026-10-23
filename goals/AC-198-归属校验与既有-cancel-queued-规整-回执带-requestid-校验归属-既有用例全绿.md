---
id: AC-198
title: 归属校验与既有 cancel-queued 规整：回执带 requestId，校验归属，既有用例全绿
status: achieved
kind: criterion
goal: GOAL-015
criterion: '[ -f server/modules/websocket/tests/chat-control-ownership.test.ts ]
  || { echo
  "缺判据文件：server/modules/websocket/tests/chat-control-ownership.test.ts" >&2;
  exit 1; }; [ -f server/modules/websocket/tests/chat-edit-send.test.ts ] || {
  echo "缺判据文件：server/modules/websocket/tests/chat-edit-send.test.ts" >&2; exit
  1; }; [ -f server/modules/websocket/tests/chat-permission-mode.test.ts ] || {
  echo "缺判据文件：server/modules/websocket/tests/chat-permission-mode.test.ts" >&2;
  exit 1; }; npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/chat-control-ownership.test.ts
  server/modules/websocket/tests/chat-edit-send.test.ts
  server/modules/websocket/tests/chat-permission-mode.test.ts'
expect: 读数：chat.cancel-queued 的回执带 requestId；归属不符 ⇒ forbidden 且不调用驱动；归属校验用同一个函数被
  chat.stop-task、chat.background-task、chat.cancel-queued 复用（用例直接断言三者走同一入口）；既有
  chat-edit-send、chat-permission-mode 全部保持绿；若既有用例因多了 requestId
  字段而需同步，只允许把字段加进期望，不得放宽成忽略整个字段。取假形态：cancel-queued 仍不校验归属 ⇒ forbidden 用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§1 与 §9 实测）与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor
  事件在投影层折叠成一行；历史里的 isMeta 行显示与对等方目录本期不纳入。 调查 2026-10-01：除 chat.send 与
  chat.edit-send 外没有哪个 WS 处理函数使用 userId；chat.cancel-queued 只做 getSessionById
  且没有请求关联。
activatedAt: 2026-10-03T15:51:40.509Z
statusLog:
  - at: 2026-10-03T15:51:40.509Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-03T20:00:16.697Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-03T15:51:40.509Z
---
