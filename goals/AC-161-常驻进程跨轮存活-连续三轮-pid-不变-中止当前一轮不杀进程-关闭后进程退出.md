---
id: AC-161
title: 常驻进程跨轮存活：连续三轮 pid 不变，中止当前一轮不杀进程，关闭后进程退出
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-process.test.ts
expect: 真实 claude 二进制 + mock Anthropic 兼容端点（做法照 AC-025，按请求体识别，SDK 标题请求不计），临时
  DATABASE_PATH：同一常驻会话经 chat.send 连续 3 轮，每轮都产生 complete，pid 与 hostId 不变；第 2 轮进行中
  chat.abort ⇒ 该轮 complete 带 aborted，进程仍在，下一轮在同一 pid 上继续；POST
  /api/session-hosts/:sessionId/close ⇒ stdin EOF 后进程在限定时间内退出，closeReason 为
  user。判据自带 60 秒预算守卫：超出时打印预算与实测墙钟并 exit 3。取假形态：(a) 每轮带 --resume 重启进程 ⇒ pid
  读数必须红；(b) abort 杀进程 ⇒ 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
activatedAt: 2026-09-27T04:51:55.456Z
statusLog:
  - at: 2026-09-27T04:51:55.456Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-27T06:44:46.680Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T04:51:55.456Z
---
