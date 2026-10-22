---
id: GOAL-013
title: Claude 常驻会话：进程跨轮存活、无人轮可见、忙时输入与 CLI 一致、空闲自动关闭、界面可管理
status: achieved
kind: goal
origin: "docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 "
activatedAt: 2026-09-27T04:49:41.111Z
statusLog:
  - at: 2026-09-27T04:49:41.111Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 指令：激活 GOAL-013
  - at: 2026-09-29T09:51:30.312Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---

## 背景

per-run 模式下每轮一个 claude 进程，CronCreate 最多触发一次、周期大于 30 分钟不触发、用户一说话就丢；ScheduleWakeup 大于 30 分钟不触发；SendMessage 的 peer 名与 socket 每个进程都变；空闲会话没有进程，不可寻址。提案 docs/proposals/claude-resident-sessions.md 给 Claude 增加常驻模式：进程在两轮之间不退出，stdin 由服务端握着，所有输入推进同一个进程。

本 goal 建立在 GOAL-012（宿主层）之上。人 yale 2026-09-25 裁定本 goal 暂不激活，等 tasks/gap-claude-resident-phase0-experiments 的实验结论写回 proposal 并经人确认后再定稿 AC。2026-09-26 E2/E3 基准已由人确认，E9 已取数；2026-09-27 人 yale 指令激活本 goal，并按结论修订 AC-162、163、165、167、168、175、176 的判据。内存上限的生产数值（E7 的 24 小时浸泡）仍未取得，不在任何 AC 里钉数。

## 范围

- Claude resident driver：不结束的输入队列、读取循环以 system/init 与 result 切分轮次（E9 两条驱动都没读到 session_state_changed，出现时不作依赖）、task_* 事件与 Stop hook 的 session_crons / background_tasks 维护保活理由、interrupt 不杀进程、setModel/setPermissionMode 等在线重配置、关闭即 stdin EOF。
- 无人轮（cron、后台任务回报、跨会话消息；E9 读到 CLI 工具表里没有 Monitor）由 manager 开 run，来源为 unattended，无连接也记录，可回放，并推送通知。
- 忙时输入与 CLI 一致：不拒绝、不在服务端排队，立即写入进程，归入 CLI 实际给出的那一轮。
- 默认 bypassPermissions 启动；无人值守时 AskUserQuestion 与 ExitPlanMode 自动拒绝并通知。
- ~~稳定的 SendMessage 地址（`extraArgs.name`）~~ ⟪2026-09-30 人 yale 裁定修订⟫ 改为**读 Claude Code 自己给进程的派生名**（`~/.claude/sessions/<pid>.json`，`nameSource=derived`）；App 不再传 `--name`，也不承诺地址跨重启不变。原条款把「自造地址」与「不干扰 Claude Code 命名」当成两件事，实为同一个槽位。
- 空闲关闭（24 小时，可配置；cron 保活理由最长 7 天；浏览器停留不算活动）。
- 服务停止与被杀后的关闭与启动清扫；重启后不自动恢复，下一次发送重新拉起。
- 进程层：复用并推广 tasks/gap-claude-session-cgroup-scope 的 scope 服务，给常驻进程单进程上限与 slice 总上限（数值来自实验 E7）。
- sessions 表的 lifecycle_mode 列、能力矩阵 residentFeatures、常驻的 start/close REST。
- 前端（proposal §15）：开启与知情勾选、状态标记与状态条、停止与关闭分开、无人轮呈现、Running 两组与徽标、常驻禁用 Shell、忙时直发。UI 的派工任务以 API 面冒烟的人工关卡为前置；UI e2e 用调试 agent 的常驻场景驱动。

## 非目标

- 服务重启后恢复常驻进程或其 cron。
- 把 CronCreate 持久化为 scheduled-messages。
- Codex、Cursor、OpenCode 的常驻模式。
- 新增 cloudcli 子命令。
- 依赖 Claude Code 自带的 --bg 或 daemon。

## 退出条件

- AC-161 常驻进程跨轮存活，中止不杀进程，关闭后进程退出。
- AC-162 无人轮在无浏览器时产生、建 run、可回放并通知。
- AC-163 忙时输入与 CLI 一致（基准来自实验 E2/E3 与人的确认）。
- AC-164 的 SendMessage 地址可被另一会话使用并产生一轮 —— 承诺已于 2026-09-30 修订为「地址读自 CLI 派生名」，其判据文件仍重述旧规则，须由 tasks/gap-cloudcli-self-assigned-names-outrank-ai-titles 一并修订。
- AC-165 空闲关闭：有 cron 时不在空闲超时处关闭，浏览器停留不阻止关闭。
- AC-166 服务停止或被杀后无残留，重启后显示已随重启关闭，下一次发送重新拉起。
- AC-167 超出内存上限时只有该常驻进程被杀。
- AC-168 默认 bypass，无人值守时交互式请求被自动拒绝并通知。
- AC-169 lifecycle_mode 与能力矩阵的约束，常驻的 start/close 可经 API 操作。
- AC-170 人工关卡：API 面真模型冒烟由人确认通过。
- AC-171 至 AC-175 真实浏览器里的开启知情、状态呈现、Running 分组、Shell 禁用、忙时直发与撤回。
- AC-176 常驻进程的 Remote Control 跨机器可达性被强制关闭，信任边界保持在同一 Unix 用户。
- 上述 AC 全部 achieved；或由人裁定放宽、取消其中任一条。
- 标题中的「cron 跨轮持续触发」不作为 60 秒判据：cron 最小粒度 1 分钟，连续触发要数分钟，超出判据硬超时。其读数由实验 E1 给出并记录在 proposal；目标级判据以后台任务回报驱动的无人轮（AC-162）与 cron 保活理由的记账（AC-165）承载同一不变式。

## 已知限制

- 已按 E1–E9 结论修订判据：忙时推入的消息另起一轮（E2/E3，人已确认）；写入用 later 档；撤回以 command_lifecycle 的 cancelled 事件为准（cancel_async_message 没有 control_response）；elicitation 已读到实物，request_user_dialog 没触发到、只按类型定义构造；side_question 移出无人值守入口；flag settings 能否压过用户 settings 没读到，AC-176 走「检测到 Remote Control 开启即拒绝启动」的保守分支，只覆盖用户级 settings。
- 读数缺口：后台 Bash 完成后 CLI 是否自行开无人轮（AC-162 的触发依赖它，实现任务先取读数，读到不开轮时由人改判据）；next 档的落点；request_user_dialog 的实物形态；E7 的 24 小时浸泡。
- SDK 0.3.165 的类型落后于全局 claude 2.1.282：scheduled_task_fire、side_question 等 subtype 只在 CLI 里出现。判据里的伪造流要包含一条未知 subtype，确认 driver 放过它。
- 真实 claude 二进制类判据受本机全局重装 claude 影响（SDK spawn 测试会红），归因时先看二进制 mtime。