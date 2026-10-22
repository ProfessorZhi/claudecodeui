---
id: GOAL-015
title: Claude 后台工作与计划可观测可控：任务、计划与控制在同一个活动坞里，状态以 SDK 事件为准
status: achieved
kind: goal
origin: docs/proposals/claude-session-activity-dock.md 与
  docs/proposals/claude-background-work-observability.md。人 yale 2026-10-01
  裁定：新增控制动词与 cancel-queued 做归属校验；取消计划任务不做控件；Monitor 事件在投影层折叠；isMeta
  行显示与对等方目录本期不纳入；并同意拆成 GOAL-014 与 GOAL-015。本 goal 依赖 GOAL-014
  的活动坞，暂不激活，等人确认后再激活。
activatedAt: 2026-10-03T15:50:16.636Z
statusLog:
  - at: 2026-10-03T15:50:16.636Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-04T14:17:34.777Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

Claude 会话的后台工作（后台子代理、后台 Bash、Monitor、Workflow）与计划任务（cron、ScheduleWakeup）在 web 页面里几乎看不见。2026-10-01 对真实 SDK 的实测表明，SDK 已经推送了完整的任务生命周期（task_started、task_updated、task_progress、task_notification），以及可主动调用的 stopTask 与 backgroundTasks；服务端只读 task_id 去增删“租约”，其余全部丢弃，客户端于是只能看到一个每秒轮询的租约计数。cron 与 ScheduleWakeup 完全没有 task_* 事件，只能由工具调用与结果、以及 Stop hook 的 session_crons 推出；其中 session_crons 是完整权威的清单，唤醒也在其中。

提案 docs/proposals/claude-session-activity-dock.md 与 docs/proposals/claude-background-work-observability.md 给出统一设计：服务端权威的 Task 与 Schedule 实体，推送加快照，同一个活动坞展示并提供显式控制，控制以 SDK 的事件为确认，不乐观改状态。本 goal 建立在 GOAL-014（活动是真的、单一活动坞）之上，坞本身由 GOAL-014 交付。

人 yale 2026-10-01 裁定：新增的控制动词与既有 chat.cancel-queued 都做归属校验；取消计划任务不做控件，由用户用文本请模型调 CronDelete，坞对计划只读；Monitor 事件在转写投影层折叠成一行，历史不变；历史里的 isMeta 行显示与对等方目录本期不纳入。

## 范围

- 服务端的 Task 归约（含 Workflow、Monitor、嵌套、前台转后台、Stop hook 校准）与计划表（cron、唤醒、下次触发）。
- 活动的 REST 快照与 WS 增量协议，带 rev。
- 活动坞里的任务托盘与计划只读展示，转写里 Agent、Bash、Monitor 卡片按 toolUseId 读任务。
- 租约由任务与计划推出，行为不变（先并存对照）。
- 控制面：停止任务、把运行中的前台工具转后台、规整 cancel-queued（请求关联与归属校验）。
- Monitor 事件在投影层折叠。

## 非目标

- 取消计划任务的专用控件。
- 历史里的 isMeta 行显示（对等会话消息、cron 与唤醒的提示词行）、对等方目录与收件箱。
- 入站对等消息在坞里的实时可见（队列中、已送达）：依赖对真实 cross-session-message 在 JSONL 里出现时序的实测，实测前不纳入。
- 出站 SendMessage 与 ListAgents 的专用工具卡：未裁定，默认不纳入。
- 其它 provider。

## 退出条件

- AC-191 Task 归约覆盖嵌套、Workflow、Monitor 超时、前台转后台、Stop hook 校准，重放幂等。
- AC-192 计划表覆盖 cron 与唤醒、下次触发、触发后消失。
- AC-193 活动协议：快照加增量，带 rev，不连续即重拉。
- AC-194 真实浏览器里坞列出任务与计划，状态不刷新就变化，重载后恢复，卡片读任务，计划只读。
- AC-195 租约由任务与计划推出，与现有路径逐帧对照一致，既有行为不变。
- AC-196 停止任务：校验、限时、以 task_notification 为确认。
- AC-197 前台工具转后台：寻址前台 tool_use，无匹配时明确回执。
- AC-198 归属校验与 cancel-queued 规整，既有用例全绿。
- AC-199 真实浏览器里从坞里停止任务与转后台，以事件为准，连接中断时按钮置灰。
- AC-200 Monitor 事件在投影层折叠，历史不变。
- AC-201 人工关卡：人在真实 resident 会话里确认后台子代理与 Monitor 可见、可停止。
- 上述 AC 全部 achieved；或由人裁定放宽、取消其中任一条。

## 已知限制

- paused 状态没有复现：两次尝试里权限回调从未被调用，本机设置默认放行。设计里把 paused 当作“被阻塞，等待用户”，含义（等权限）只是由 CLI 二进制字符串推断，没有 AC 钉它。
- 真实对等会话消息、Workflow 的多步与失败形态、cron 表达式的更多语法与时区、stopTask 对 Monitor 与 Workflow 与子代理的行为都没有测过。
- 仓库真实 per-run 运行时下的 task_* 时序没有测过：已测的是“持有输入流”的形态，事件形态与 resident 一致。
- SDK 的 stopTask 对未知与已结束的 id 静默成功，服务端必须自己校验；这条校验依赖任务表的完整性，Stop hook 只在回合边界触发，回合进行中新建的任务只靠 task_started 入表。
- 本 goal 依赖 GOAL-014 交付的活动坞；激活是人的动作，不由 goal-driver 完成，激活前所有 AC 均为 draft。
