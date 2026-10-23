---
id: AC-240
title: /mcp 是无状态的 Streamable HTTP，挂在静态路由之前，默认关闭：开关未开时不挂载，开着时返回 JSON-RPC 而不是 SPA 页面
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/mcp-gateway/tests/mcp-transport.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-transport.test.ts
expect: 真实 express 4 应用加真实 HTTP。读数：(a) 无状态——同一个客户端连续发两次 `tools/list`，两次都不带
  `Mcp-Session-Id` 也都成功；(b) 返回的是 JSON-RPC（`application/json` 或
  `text/event-stream`），不是 `text/html`；(c) `MCP_ENABLED` 未设为 true
  时生产装配函数不挂载任何东西，`POST /mcp` 得到 404，而不是 401 或 200；(d) 对 `server/index.ts`
  解析语法树：挂载 `/mcp` 的调用在 `createStaticAssetsMiddleware` 的 `app.use`
  之前，并带反例对照（把顺序倒过来的合成源码能被同一个扫描器判出）；(e) SDK 的授权路由与无状态传输挂在 express 4.21
  应用上能正常工作的守卫（元数据 200，`tools/list` 200），防止 SDK 升级后漂移。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 用有状态传输 ⇒ (a) 必须红；(ii) 把挂载移到静态路由之后 ⇒ (d) 与 (b) 必须红；(iii)
  开关未开仍挂载 ⇒ (c) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:06:53.230Z
statusLog:
  - at: 2026-10-05T02:06:53.230Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T03:00:20.990Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:06:53.230Z
---
