---
id: AC-234
title: 运行来源如实记录：经 MCP 发起的运行是 mcp，WebSocket 是 user，定时发送是 scheduled，宿主层的无人轮仍是 unattended
status: achieved
kind: criterion
goal: GOAL-019
criterion: for f in server/modules/websocket/tests/chat-control-source.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/websocket/tests/chat-control-source.test.ts
expect: 读数：(a) 以调用方标记 mcp 经控制服务 `send` 发起的运行，注册表里 `source === 'mcp'`；(b) 标记
  websocket 的为 `user`，标记 scheduled 的为 `scheduled`；(c)
  宿主层开的无人轮（`openUnattendedRun`）仍为 `unattended`，既有取值不被改写；(d) 调用方未显式传来源、直接调
  `chatRunRegistry.startRun` 时，保持旧默认：有连接记 `user`，无连接记 `scheduled`，已有调用方行为不变；(e)
  `ChatRunSource` 类型含 `mcp`，并且 `chat-run-registry.test.ts`
  里穷举该类型的夹具与断言都已补上新值。四种取值各有一个正例，防止「恒为默认值」也通过。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 让 `send` 对所有调用方都不传来源 ⇒ (a) 必须红；(ii) 把 mcp 映射成 scheduled ⇒
  (a) 必须红；(iii) 改写无人轮的来源 ⇒ (c) 必须红；(iv) 改掉旧默认 ⇒ (d)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:24:32.836Z
statusLog:
  - at: 2026-10-04T17:24:32.836Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T20:15:09.686Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:24:32.836Z
---
