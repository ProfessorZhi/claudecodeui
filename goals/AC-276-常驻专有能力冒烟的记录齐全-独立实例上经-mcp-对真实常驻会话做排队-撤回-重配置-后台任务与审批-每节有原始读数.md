---
id: AC-276
title: 常驻专有能力冒烟的记录齐全：独立实例上经 MCP 对真实常驻会话做排队、撤回、重配置、后台任务与审批，每节有原始读数
status: achieved
kind: criterion
goal: GOAL-022
criterion: for f in scripts/mcp-smoke.mjs
  docs/proposals/cloudcli-mcp-resident-smoke.md; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs
  --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md
expect: 做法照 GOAL-020 的嵌套冒烟：独立实例、真实 Claude CLI、终端 Claude Code 经 PAT
  连接。记录逐节齐全，每节有「读数：」与「结论：」：环境与版本；常驻会话启动与 pid；忙时发送得到 `queuedMessageUuid`；撤回得到
  `cancelled` 且 pid 不变；`session_reconfigure` 下一轮生效；`session_background`
  列出与停止；审批（在非 bypass 权限模式下由一个需要权限的工具触发，经 `approvals_list` 看到、`approval_answer`
  解除）；收尾残留与生产 3001 监听 pid 不变。`--check-resident-record`
  逐节检查并点名缺哪节。本判据只证明读数齐全。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 删掉任一节 ⇒
  必须红并点名；(ii) 撤回一节里 pid 前后不同 ⇒ 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:28:49.461Z
statusLog:
  - at: 2026-10-05T02:28:49.461Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:28:43.188Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:28:49.461Z
---
