---
id: AC-278
title: 生产装配把四个会话写工具接到网关：server/index.ts 的 createMcpGatewayModule 交出
  sessionCreate / sessionInterrupt / sessionHostControl，四个工具在真装配下不再回
  MCP_TOOL_NOT_IMPLEMENTED
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
expect: 读数：(a) 生产装配静态面——对 `server/index.ts` 解析语法树，`createMcpGatewayModule(`
  实参对象里的 `writeTools` 成员同时含
  `sessionCreate`、`sessionInterrupt`、`sessionHostControl` 三项，三项绑定的标识符与该文件里
  WebSocket 与 scheduled-messages
  路径共用同一批单例（`chatControl`、`sessionsService`、`sessionHostManager`）；带正例对照——对一份删掉
  `sessionInterrupt` 成员的合成源码，同一扫描器必须报出该项缺失（证明这个零有分辨力、不是恒零）。(b) 运行时面——经生产装配同一份
  deps 构造路径拿到网关写工具注册，四个工具名
  `session_create`、`session_interrupt`、`session_start`、`session_close` 逐个调用，返回的
  `code` 都不是 `MCP_TOOL_NOT_IMPLEMENTED`（对不存在的目标应为解析门拒绝），即四个工具在生产装配下确实是真 handler
  而非占位。(c) 反空过负控制——不交这三项 deps 时同一个探针必须拿到 `MCP_TOOL_NOT_IMPLEMENTED` 且 `owner`
  逐字为 `AC-250` 或 `AC-251`（证明探针能把「接上了」与「没接上」分开，不是恒真）。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 从 `server/index.ts` 删掉 `writeTools.sessionCreate` ⇒ (a)
  必须红；(ii) 交上 deps 但让网关内部另造一个实例 ⇒ (b)
  的同一实例断言必须红。红态基线（本轮实测，读数不是推断）：判据文件不存在，存在性闸以退出码 1 逐字输出
  `缺判据文件：server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts`；且即便建了该文件
  (b) 也必红——`grep -c 'sessionCreate\|sessionInterrupt\|sessionHostControl'
  server/index.ts` 现为 **0**，而 `mcp-gateway.write-tools.ts:356` 对未交的 deps 走
  `notImplemented(name,
  PLACEHOLDER_OWNER[name])`，`PLACEHOLDER_OWNER.session_create` 与
  `PLACEHOLDER_OWNER.session_interrupt` 逐字都是 `AC-250`，`session_start` 与
  `session_close` 逐字是 `AC-251`。
origin: 人 yale 2026-10-05 指令；本 AC 由 2026-10-05 manager 检查补立，红态已实测（goal gate
  AC-278 ⇒ fail，cause 逐字为缺判据文件）。
activatedAt: 2026-10-05T15:48:33.319Z
statusLog:
  - at: 2026-10-05T15:48:33.319Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-05T16:33:40.817Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-05T15:48:33.319Z
---
