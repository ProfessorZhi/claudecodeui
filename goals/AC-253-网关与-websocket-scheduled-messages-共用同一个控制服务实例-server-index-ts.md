---
id: AC-253
title: 网关与 WebSocket、scheduled-messages 共用同一个控制服务实例：server/index.ts 里只构造一个，网关拿到的是它
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts
expect: 读数：(a) 对 `server/index.ts` 解析语法树：`createChatControlService(`
  恰好被调用一次，绑定的标识符同时作为实参出现在 `createWebSocketServer`、scheduled-messages 的初始化与
  `createMcpGatewayModule` 的调用里；带正例对照（合成源码里出现第二次构造时同一个扫描器能判出）；(b)
  网关模块跨模块导入只经各模块的
  barrel：`getRunById`、`startResidentHost`、`closeResidentHost`、`getProjectSessionsPage`
  都从 barrel 导出且各自有网关这个消费者，barrel 里不存在没有消费者的新导出；(c) 往同一个实例注入间谍，WebSocket 的
  `chat.send`、定时发送、MCP 的 `session_send` 三处触达同一个 `send`。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 网关内部再 new 一个控制服务 ⇒ (a) 与 (c) 必须红；(ii) 导出一个没人用的符号 ⇒ (b)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:15:31.761Z
statusLog:
  - at: 2026-10-05T02:15:31.761Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T14:03:05.211Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:15:31.761Z
---
