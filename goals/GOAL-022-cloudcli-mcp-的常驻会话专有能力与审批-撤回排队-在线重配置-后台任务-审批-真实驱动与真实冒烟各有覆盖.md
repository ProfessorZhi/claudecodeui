---
id: GOAL-022
title: CloudCLI MCP 的常驻会话专有能力与审批：撤回排队、在线重配置、后台任务、审批，真实驱动与真实冒烟各有覆盖
status: achieved
kind: goal
origin: 人 yale 2026-10-05 指令：创建并激活 GOAL-020 至 GOAL-022 及其 AC；同日 02:10 退回
  draft，理由逐字「等 GOAL-020 达成后再激活」。2026-10-06T23:22:46Z GOAL-020 已 achieved（AC-257
  人证行由 yale 裁定通过后由 goal-driver I2 翻绿），前置条件满足，按原指令重新激活。
activatedAt: 2026-10-05T02:03:55.372Z
statusLog:
  - at: 2026-10-05T02:10:00.918Z
    from: active
    to: draft
    actor: human:yale
    reason: 人 yale 指令：退回 draft，等 GOAL-020 达成后再激活（021、022 的 AC 依赖 020 才能满足，同时激活会让任务因
      mcp-gateway 尚不存在而反复失败并被机械翻成 needs-human）
  - at: 2026-10-05T23:22:58.430Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-05T23:29:18.535Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---

## 背景

GOAL-020 的写工具只覆盖「发、建、停、启、关」。常驻会话真正独特的能力还没有对外：撤回尚未出队的排队消息、在线重配置模型与权限模式、看与停后台任务和计划、回答待审批。这些能力在控制服务里已有（`cancelQueued`、`stopTask`、`answerApproval`、`pendingApprovals`），本 goal 把它们作为 MCP 工具暴露，并补上 SPEC 里承认的缺口：真实 Claude 驱动的 `cancel_async_message` 经控制服务从未被自动判据覆盖。设计见 docs/proposals/mcp-gateway-SPEC.md（v3.1）的阶段 6。本 goal 的 AC 在 GOAL-020 达成之前无法全部满足。

## 范围

- 工具：`session_cancel_queued`、`session_reconfigure`、`session_background`、`approvals_list`、`approval_answer`，各自声明所需 scope（control、control、read 与 control、read、approve）。
- `session_reconfigure`：模型、思考强度、权限模式下一轮生效，常驻会话走驱动的在线重配置；不支持的值明确拒绝并列出可选项。
- `session_background`：只读列出后台任务与 cron，带 `stopTaskId` 时停止。
- 审批：列出待审批并展开 `AskUserQuestion`，回答时转发 `answers`，过期与不存在有明确说法。
- 真实二进制的常驻判据：做法照 AC-161，经控制服务撤回排队消息。
- 冒烟：`scripts/mcp-smoke.mjs` 增加 `--check-resident-record` 模式，记录文件 `docs/proposals/cloudcli-mcp-resident-smoke.md`。

## 非目标

- 不新增 OAuth 或认证能力，不改 GOAL-020、GOAL-021 已有行为。
- 不做跨会话消息工具（`session_send_peer`），不做 agent 团队编排。
- 不改真实驱动的 `cancel_async_message` 实现，只让它经控制服务被覆盖。
- 在生产上启用或调整审批超时（`CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`）不属于判据。

## 退出条件

1. 撤回（AC-271）：用发送返回的 uuid 撤回，之后那条消息不成为一轮，已开始的如实说已不在队列。覆盖状态：AC-271 直接覆盖，在调试驱动上。
2. 重配置（AC-272）：下一轮生效，不重启进程，不支持的值明确拒绝。覆盖状态：AC-272 直接覆盖。
3. 后台任务（AC-273）：只读列出，停止需要 control，结果如实。覆盖状态：AC-273 直接覆盖。
4. 审批（AC-274）：列出、展开、回答、过期与 scope。覆盖状态：AC-274 直接覆盖。
5. 真实驱动（AC-275）：真实 claude 二进制加 mock 端点，经控制服务撤回，pid 不变。覆盖状态：AC-275 直接覆盖；负载下可能假红，按假红处理流程复核，不放宽断言。
6. 冒烟（AC-276、AC-277）：独立实例上经 MCP 对真实常驻会话做排队、撤回、重配置、后台任务与审批的记录齐全，并由人确认。覆盖状态：前者证明读数齐全，后者是人工关卡，缺一不可。
7. 既有行为不回归，typecheck、lint、build 通过。覆盖状态：无单独 AC，由 scoped 门与 fan-in 全量 suite 守护。

## 已知限制

- 审批在 bypassPermissions 下几乎不出现，只有 `AskUserQuestion` 与 `ExitPlanMode` 这类交互型工具会进入审批路径；真实冒烟需要在非 bypass 模式下用一个需要权限的工具来制造审批。
- 无人值守时审批 55 秒无人应答会被自动拒绝，远程审批要么调大 `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`，要么接受「来不及」的结果；`approval_answer` 对已过期请求给出明确说法而不是报错。
