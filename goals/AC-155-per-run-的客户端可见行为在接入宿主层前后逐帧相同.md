---
id: AC-155
title: per-run 的客户端可见行为在接入宿主层前后逐帧相同
status: achieved
kind: criterion
goal: GOAL-012
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/session-hosts/tests/session-host-per-run-parity.test.ts
expect: 对四个 provider，经真实 chat websocket 分派（chat.send、chat.abort、chat.subscribe
  重放）各跑同一组场景：正常一轮、中途中止、run 进行中重复发送、断线后按 lastSeq 重放。客户端收到的帧序列（类型、seq、complete 的
  exitCode 与 aborted、RUN_IN_PROGRESS 错误帧）与接入宿主层之前录下的基线逐条比较，必须完全相同。基线 fixture
  在接入宿主层的提交之前录制，随测试提交，fixture 头部写明录制时所在的提交。取假形态：(a) 宿主关闭时补发一个合成 complete ⇒
  多出一帧，必须红；(b) 常驻的忙时直写逻辑泄漏到 per-run，run 进行中重复发送不再返回 RUN_IN_PROGRESS ⇒
  必须红。命令逐字含文件路径，不用 glob。当前必红：测试文件不存在。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-A「统一宿主层」并激活；扩展调试 agent 作宿主层对非 Claude provider
  适用性的替身；不加 cloudcli 子命令，只靠 HTTP/WS 加脚本
activatedAt: 2026-09-25T08:59:47.634Z
statusLog:
  - at: 2026-09-25T08:59:47.634Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-09-26T12:36:30.689Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-25T08:59:47.634Z
---
