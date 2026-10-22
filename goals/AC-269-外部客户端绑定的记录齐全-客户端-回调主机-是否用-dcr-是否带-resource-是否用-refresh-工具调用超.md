---
id: AC-269
title: 外部客户端绑定的记录齐全：客户端、回调主机、是否用 DCR、是否带 resource、是否用 refresh、工具调用超时实测、overview 结果
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in scripts/mcp-smoke.mjs
  docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs
  --check-external-record docs/proposals/cloudcli-mcp-external-client.md
expect: 记录文件逐节齐全，每节有「读数：」与「结论：」两行：所用客户端与版本（Gemini Web 与 Android、Claude.ai
  连接器或其他）；经 cloudflared 暴露的公网基址（不含令牌）；回调主机（用于填
  `MCP_ALLOWED_REDIRECT_HOSTS`）；是否使用 DCR；是否发送 `resource`；是否使用 refresh
  token；实测的工具调用超时（决定 `waitSeconds` 上限）；`overview` 在该客户端上的实际返回；`MCP_DCR` 收紧为
  `allowlist` 之后重新绑定仍成功的读数。`--check-external-record`
  逐节检查并点名缺哪节。本判据只证明读数齐全。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 删掉记录里任一节 ⇒
  必须红并点名；(ii) 公网基址写成含 `ccp_` 或 `cca_` 令牌的 URL ⇒ 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1
  输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:23:51.500Z
statusLog:
  - at: 2026-10-05T02:23:51.500Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:36:48.311Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:23:51.500Z
---
