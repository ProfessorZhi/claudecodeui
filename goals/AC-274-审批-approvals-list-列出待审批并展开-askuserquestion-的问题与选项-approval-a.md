---
id: AC-274
title: 审批：approvals_list 列出待审批并展开 AskUserQuestion 的问题与选项，approval_answer
  解除审批，过期或不存在的请求有明确说法
status: achieved
kind: criterion
goal: GOAL-022
criterion: for f in server/modules/mcp-gateway/tests/mcp-approvals.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-approvals.test.ts
expect: "假运行时的 `getPendingApprovalsForSession` 与 `resolveToolApproval`
  可观测。读数：(a) 有待审批时 `approvals_list` 返回
  `requestId`、会话、工具名、输入摘要、已等待时长；`AskUserQuestion` 展开成问题文本与各选项；(b)
  `approval_answer` 的 `allow: true`、`allow: false` 分别以对应的决定调用
  `resolveToolApproval`，带 `message` 时一并转发；(c) `AskUserQuestion` 的 `answers` 作为
  `updatedInput` 转发；(d) 已过期（超过审批超时被自动拒绝）或不存在的 `requestId`
  返回明确的「已过期或不存在」，不抛异常，不调用 `resolveToolApproval`；(e) 需要 `cloudcli:approve`，没有该
  scope 的令牌被拒并写 `denied` 审计；(f) `overview` 里 `awaitingPermission`
  的会话与这里的待审批一致。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 过期的请求仍调用解析 ⇒ (d)
  必须红；(ii) `answers` 被丢弃 ⇒ (c) 必须红；(iii) 不检查 approve scope ⇒ (e)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:27:33.159Z
statusLog:
  - at: 2026-10-05T02:27:33.159Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:28:12.071Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:27:33.159Z
---
