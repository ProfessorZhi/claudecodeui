---
id: AC-270
title: 人工关卡：外部客户端经 OAuth 绑定并调用成功由人确认，之后 GOAL-021 才算达成
status: achieved
kind: criterion
goal: GOAL-021
criterion: grep -q '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md
  || { echo '缺人工验收行：docs/proposals/cloudcli-mcp-external-client.md
  里没有以「外部客户端验收：通过」开头的一行（只能由人 yale 写入）' >&2; exit 1; }
expect: 记录文件里存在一行以「外部客户端验收：通过」开头、由人 yale
  写入的验收行。执行者不得代写；模板与脚本输出里不得出现以该字样开头的行。Gemini 自定义应用要求账号在美国、仅英文、个人账号、开启 Keep
  Activity（Google 帮助页原文），人若无法使用 Gemini，可用 Claude.ai 连接器或其他 MCP
  客户端完成，记录里写明所用客户端。上一条判据齐全而本条不过时，终止状态是 needs-human。（红先行）当前必红：验收行不存在，grep
  非零并输出缺失原因。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:24:05.496Z
statusLog:
  - at: 2026-10-05T02:24:05.496Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-06T01:52:18.503Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:24:05.496Z
---
