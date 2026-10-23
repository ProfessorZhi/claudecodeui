---
id: AC-186
title: 回合阶段与工具名来自真实信号：thinking、writing、tool、等待权限、压缩，回合结束回到空闲
status: achieved
kind: criterion
goal: GOAL-014
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-turn-phase.test.ts
expect: 用真实捕获的帧序做夹具（2026-10-01 实测的
  system/thinking_tokens、content_block_delta、assistant 的 tool_use 与随后的
  tool_result、permission_request、compact_boundary），驱动服务端的 Turn
  Tracker。读数：thinking_tokens 在流 ⇒ thinking；stream_delta 在流 ⇒ writing；tool_use
  已发出且尚无配对的 tool_result ⇒ tool 且 toolName 取自 tool_use.name，配对后离开
  tool；permission_request ⇒ awaitingPermission，应答后恢复；回合的 result ⇒ idle。没有
  tool_progress 时不得编造耗时。两个并发会话的阶段互不串扰；带 parentToolUseId 的子代理帧不改写主线阶段。取假形态：把 tool
  的结束条件改成下一条 assistant 消息（而不是配对的 tool_result）⇒ 配对用例必须红；全局单例而不是按会话 ⇒ 串扰用例必须红。
origin: docs/proposals/claude-session-activity-dock.md（§0.1 人的裁定、§9 实测、§10
  夹具调研）。人 yale 2026-10-01 裁定：心跳 5 秒且 15 秒判定不可达；新增控制动词与 cancel-queued
  都做归属校验；取消计划任务不做控件；历史里的 isMeta 行显示与对等方目录本期不纳入。 调查 2026-10-01：服务端对 Claude
  从不发带文本的 status 帧，statusText 恒为空，标签是按已用时间轮换的
  Thinking、Processing、Analyzing，不携带信息；实测一次运行有 215 条 thinking_tokens，服务端目前忽略它们。
activatedAt: 2026-10-01T13:41:32.077Z
statusLog:
  - at: 2026-10-01T13:41:32.077Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-01T14:40:01.494Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-01T13:41:32.076Z
---
