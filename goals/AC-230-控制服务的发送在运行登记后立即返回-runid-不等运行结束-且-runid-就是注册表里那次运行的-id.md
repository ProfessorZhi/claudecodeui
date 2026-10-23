---
id: AC-230
title: 控制服务的发送在运行登记后立即返回 runId，不等运行结束，且 runId 就是注册表里那次运行的 id
status: achieved
kind: criterion
goal: GOAL-019
criterion: for f in server/modules/websocket/tests/chat-control-send.test.ts; do
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/websocket/tests/chat-control-send.test.ts
expect: "用 chat-control-ownership.test.ts 那样的注入式假运行时，让假 provider
  的一次运行被一个可控的延迟对象卡住，不依赖真 CLI。读数：(a) `send` 在假运行仍被卡住时已经返回 `{ ok: true, runId
  }`（返回先于延迟对象被放行，用顺序断言而不是超时断言）；(b) 返回的 `runId` 等于
  `chatRunRegistry.getRun(sessionId).runId`，注册表里该运行状态为 running；(c)
  放行后该运行正常完成，注册表状态变为 completed，且没有未处理的拒绝；(d) 会话不存在返回
  `SESSION_NOT_FOUND`，provider 无运行时返回 `UNSUPPORTED_PROVIDER`，两者都不登记运行；(e) 没有
  WebSocket 对象参与：测试里不构造任何 socket 就完成上述全部读数。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 让 `send` 等运行结束才返回 ⇒ (a) 必须红；(ii) 返回自造的 id 而不是注册表的 ⇒ (b)
  必须红；(iii) 会话不存在时仍登记运行 ⇒ (d) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:21:46.953Z
statusLog:
  - at: 2026-10-04T17:21:46.953Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T18:35:13.030Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:21:46.952Z
---
