---
id: AC-182
title: 服务端按节拍发出业务心跳：bootId 在进程内稳定、重启后改变、进程被杀后不再有帧
status: achieved
kind: criterion
goal: GOAL-014
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/activity-heartbeat.process.test.ts
expect: 起一个真实服务端进程（独立端口，HOME 与 DATABASE_PATH 隔离，参照
  server/modules/session-hosts/tests/resident-server-restart.test.ts），用 ws
  客户端订阅一个会话。节拍用环境变量缩短以便在 60 秒闸内跑完。读数：N 个节拍周期内读到不少于 N-1 条 activity.heartbeat，每条带
  bootId 与 rev，即使 rev 没有变化也照发；同一进程内 bootId 不变；SIGKILL 该进程后连接收到 close
  且此后零帧；再起一个进程，bootId 与前一个不同。出货默认值由同文件另一条用例直接读常量：心跳 5000 毫秒、判定不可达 15000
  毫秒，并且服务端在 hello 或快照帧里把这两个值宣告给客户端。取假形态：(i) bootId 每次心跳都变 ⇒ 稳定性用例必须红；(ii)
  重启后沿用同一个 bootId ⇒ 重启用例必须红；(iii) 只在有变化时才发心跳 ⇒ 节拍用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§9 实测、§10
  夹具调研）。人 yale 2026-10-01 裁定：心跳 5 秒且 15 秒判定不可达；新增控制动词与 cancel-queued
  都做归属校验；取消计划任务不做控件；历史里的 isMeta 行显示与对等方目录本期不纳入。 实测 2026-10-01：现状服务端只有 WS 协议级
  ping（30 秒，浏览器 JS 看不到），客户端没有任何办法知道服务端是否还活着。
activatedAt: 2026-10-01T13:37:55.980Z
statusLog:
  - at: 2026-10-01T13:37:55.980Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-02T03:05:50.796Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-01T13:37:55.980Z
---
