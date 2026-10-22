---
id: AC-237
title: 搬动控制逻辑不改任何既有行为：WebSocket 帧序列、按次进程的逐帧一致性、定时发送、常驻宿主的既有判据全部原样通过
status: achieved
kind: criterion
goal: GOAL-019
criterion: for f in
  server/modules/websocket/tests/chat-attachment-filter.test.ts
  server/modules/websocket/tests/chat-background-task.test.ts
  server/modules/websocket/tests/chat-control-ownership.test.ts
  server/modules/websocket/tests/chat-edit-send.test.ts
  server/modules/websocket/tests/chat-permission-mode.test.ts
  server/modules/websocket/tests/chat-run-registry.test.ts
  server/modules/websocket/tests/chat-stop-task.test.ts
  server/modules/websocket/tests/claude-stop-task-capability.test.ts
  server/modules/websocket/tests/activity-protocol.test.ts
  server/modules/websocket/tests/session-upsert-broadcast.test.ts
  server/modules/session-hosts/tests/session-host-per-run-parity.test.ts
  server/modules/session-hosts/tests/session-host-default-wrap.test.ts
  server/modules/session-hosts/tests/session-host-bindings.test.ts
  server/modules/session-hosts/tests/session-host-lifecycle.test.ts
  server/modules/session-hosts/tests/lifecycle-mode.test.ts
  server/modules/scheduled-messages/tests/scheduled-messages.test.ts
  server/modules/debug-agent/tests/debug-agent-host-driver.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/websocket/tests/chat-attachment-filter.test.ts
  server/modules/websocket/tests/chat-background-task.test.ts
  server/modules/websocket/tests/chat-control-ownership.test.ts
  server/modules/websocket/tests/chat-edit-send.test.ts
  server/modules/websocket/tests/chat-permission-mode.test.ts
  server/modules/websocket/tests/chat-run-registry.test.ts
  server/modules/websocket/tests/chat-stop-task.test.ts
  server/modules/websocket/tests/claude-stop-task-capability.test.ts
  server/modules/websocket/tests/activity-protocol.test.ts
  server/modules/websocket/tests/session-upsert-broadcast.test.ts
  server/modules/session-hosts/tests/session-host-per-run-parity.test.ts
  server/modules/session-hosts/tests/session-host-default-wrap.test.ts
  server/modules/session-hosts/tests/session-host-bindings.test.ts
  server/modules/session-hosts/tests/session-host-lifecycle.test.ts
  server/modules/session-hosts/tests/lifecycle-mode.test.ts
  server/modules/scheduled-messages/tests/scheduled-messages.test.ts
  server/modules/debug-agent/tests/debug-agent-host-driver.test.ts
expect: 这是回归守卫，不是新行为：列出的 17 个既有测试文件，逐字不改地全部通过，其中含 AC-196、AC-197、AC-198
  的访问入口判据（chat-control-ownership）、`chat.subscribe`
  与活动协议判据、按次进程的逐帧一致性判据（session-host-per-run-parity）、scheduled-messages 与调试 agent
  常驻驱动的判据。迁移规则：如果重构迫使某个既有测试的注入缝换名，只许把它移植到新缝上并保持断言强度，不许删除或放宽；移植要在任务记录里逐条列出。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 让 WebSocket 的 `chat.subscribe` 多发一帧 ⇒ 帧序列判据必须红；(ii) 让
  `chat.cancel-queued` 对未认证调用不返回 forbidden ⇒ chat-control-ownership 必须红；(iii)
  改变按次进程的帧序 ⇒ per-run parity 必须红。这一条在写下时就是绿的（既有测试全部存在且通过），其价值在重构之后仍绿；它不适用红先行。真实
  Claude 二进制的常驻判据（AC-161 一族）不放进本判据（负载下易假红），由 fan-in 的全量 suite 守护。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:25:55.553Z
statusLog:
  - at: 2026-10-04T17:25:55.553Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T17:28:46.148Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:25:55.553Z
---
