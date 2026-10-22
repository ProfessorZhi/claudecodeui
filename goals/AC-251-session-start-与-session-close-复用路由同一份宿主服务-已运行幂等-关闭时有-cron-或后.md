---
id: AC-251
title: session_start 与 session_close 复用路由同一份宿主服务：已运行幂等，关闭时有 cron 或后台任务则要
  force，既有拒绝码原样呈现
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts
expect: "读数：(a) `session_start` 经由 session-hosts 的 `startResidentHost`
  服务（间谍证明），已运行的常驻会话再次启动返回同一个 pid；(b) `session_close` 经由
  `closeResidentHost`，关闭原因为 `user`；(c) 会话持有 `cron` 或 `background-task` lease 时不带
  `force` 的关闭被拒，错误里点名 lease 的种类与数量，宿主仍在运行；带 `force: true` 时关闭；(d) 非常驻会话得到既有的
  `LIFECYCLE_MODE_NOT_RESIDENT` 拒绝码，provider 无宿主驱动、会话不存在同样原样呈现；(e) 需要
  `cloudcli:session:control`。lease 用宿主管理器的接口在测试里直接制造。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 忽略 lease 直接关闭 ⇒ (c) 必须红；(ii) 网关自带一份启停逻辑而不走服务 ⇒ (a) 与 (b)
  必须红；(iii) 把拒绝码改写成通用错误 ⇒ (d) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:13:40.884Z
statusLog:
  - at: 2026-10-05T02:13:40.884Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T11:11:34.537Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:13:40.884Z
---
