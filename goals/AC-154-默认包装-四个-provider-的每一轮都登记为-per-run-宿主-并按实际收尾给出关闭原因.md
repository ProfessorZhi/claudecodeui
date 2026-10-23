---
id: AC-154
title: 默认包装：四个 provider 的每一轮都登记为 per-run 宿主，并按实际收尾给出关闭原因
status: achieved
kind: criterion
goal: GOAL-012
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/session-hosts/tests/session-host-default-wrap.test.ts
expect: 经 providerRuntimeService（真实分派入口，不直接调用 manager）对
  claude、codex、cursor、opencode 各跑一轮，沿用各自 runtime 现有测试的伪造流或伪造子进程，在运行中与收尾后分别读
  manager 的宿主快照：(1) 运行中每个 provider 恰有一个宿主，mode 为 per-run，state 为 busy，唯一绑定的
  appSessionId 等于本轮会话；(2) 正常结束后宿主为 closed，closeReason 为 turn-complete；(3) 中途
  chat.abort 的那一轮 closeReason 为 aborted；(4) Claude 伪造「complete 已发出、run() 的
  promise 尚未结束」的持有期时，complete 之后、promise 结束之前宿主处于 lingering，promise 结束后
  closeReason 为 released。取假形态：(a) 只给 Claude 登记宿主（沿用其内部 activeSessions）⇒ 另外三个
  provider 的 (1) 必须红；(b) 以 complete 作为宿主关闭时刻 ⇒ (4) 的 lingering
  读数必须红。命令逐字含文件路径，不用 glob。当前必红：测试文件与 session-hosts 模块都不存在。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-A「统一宿主层」并激活；扩展调试 agent 作宿主层对非 Claude provider
  适用性的替身；不加 cloudcli 子命令，只靠 HTTP/WS 加脚本
activatedAt: 2026-09-25T08:59:13.909Z
statusLog:
  - at: 2026-09-25T08:59:13.909Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-26T11:59:59.227Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-25T08:59:13.908Z
---
