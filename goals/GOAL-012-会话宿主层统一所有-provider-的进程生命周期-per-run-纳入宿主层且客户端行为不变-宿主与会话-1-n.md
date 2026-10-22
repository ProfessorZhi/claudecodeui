---
id: GOAL-012
title: 会话宿主层统一所有 provider 的进程生命周期：per-run 纳入宿主层且客户端行为不变，宿主与会话 1:N
status: achieved
kind: goal
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-A「统一宿主层」并激活；扩展调试 agent 作宿主层对非 Claude provider
  适用性的替身；不加 cloudcli 子命令，只靠 HTTP/WS 加脚本
activatedAt: 2026-09-25T08:55:05.067Z
statusLog:
  - at: 2026-09-25T08:55:05.067Z
    from: draft
    to: active
    actor: claude-session
    reason: 人 yale 2026-09-25 裁定：按 docs/proposals/claude-resident-sessions.md 拆两个
      goal，GOAL-A（本 goal）激活；AC-154…160 现场 gate 均 exit 1（判据引用的测试文件不存在），红先行成立
  - at: 2026-09-27T03:22:08.681Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

四个 provider 的运行时各自维护活跃会话表（Claude 的 activeSessions、Codex 的 activeCodexSessions、Cursor 与 OpenCode 的活跃进程表），管理层只能从 chatRunRegistry 看到「有没有一轮在跑」，看不到进程为什么还活着。Claude 已经存在「进程比轮次活得长」的状态：启动了后台工作的一轮在 result 时就向客户端发出 complete，但持有 stdin 最长 30 分钟，run() 的 promise 要等进程退出才结束；这段持有期不可列出、不可手动关闭、不可归因。

提案 docs/proposals/claude-resident-sessions.md 为此新增宿主层：进程或宿主的生命周期从轮次里拆出来，用保活理由（turn、background-task、monitor、cron、resident-policy）驱动一个两种模式共用的状态机，用一个关闭原因枚举解释每次关闭。人 yale 2026-09-25 裁定 per-run 完整纳入宿主层，第一步只包装、不改行为；宿主与会话按 1:N 建模；本 goal 只做宿主层，Claude 常驻模式在 GOAL-013。

## 范围

- 新模块 server/modules/session-hosts：SessionHostManager（宿主表、会话绑定、保活理由、策略、关闭原因、停机）与宿主驱动接口 IProviderHostDriver（IProvider 上的可选 hostDriver facet）。
- 默认包装：没有 hostDriver 的 provider 由 manager 用现有 run/abort 生成 per-run 宿主；writer 上看到 complete 时解除 turn 保活理由，run() 的 promise 尚未结束则进入 lingering。
- Claude per-run driver：把顶替与 30 分钟持有从 Claude runtime 内部迁到 manager 的策略，顶替可辨为 superseded。
- 宿主与会话 1:N：ProcessHost 对多个 SessionBinding，保活理由与空闲判定挂在绑定上，最后一个绑定解除时宿主关闭；同一会话最多一个绑定。
- 两种策略参数（per-run 与 resident）都在 manager 里实现并以伪造 driver 验证；resident 的真实 Claude driver 属于 GOAL-013。
- GET /api/session-hosts（需鉴权）：列出所有 provider 的宿主，含状态、绑定、保活理由、关闭原因。
- 能力矩阵新增 lifecycleModes 与 multiplexedHost。
- 调试 agent 实现 hostDriver，作为宿主层对非 Claude provider 与 1:N 多路复用适用性的替身，并提供 unattended-turn、保活理由增减、exit(oom) 等场景 op，供 GOAL-013 的 UI e2e 使用。
- 停机时经 manager 以 server-shutdown 关闭全部宿主。

## 非目标

- Claude 常驻模式本身（输入队列、无人轮、bypass、SendMessage 地址、空闲自动关闭的真实 driver、UI）：属于 GOAL-013。
- Codex app-server、opencode serve 的真实多路复用 driver：以后再做；本 goal 以调试 agent 证明接口能容纳。
- 进程层（systemd scope、内存上限、启动清扫）：属于 GOAL-013，并复用 tasks/gap-claude-session-cgroup-scope 的服务。
- 新增 cloudcli 子命令：不做，只靠 HTTP/WS 加脚本。
- 改变任何 per-run 的客户端可见行为。

## 退出条件

- AC-154 默认包装：四个 provider 的每一轮经真实分派入口登记为 per-run 宿主，按实际收尾给出 turn-complete、aborted、released；Claude 持有期读成 lingering。
- AC-155 per-run 的客户端可见行为在接入宿主层前后逐帧相同（接入前录制的基线 fixture）。
- AC-156 GET /api/session-hosts 需鉴权，列出所有 provider 的宿主及其状态、绑定、保活理由、关闭原因；lingering 的宿主可见。
- AC-157 状态机由保活理由驱动，两种策略、每种关闭原因与停机都有用例产生并断言。
- AC-158 宿主与会话 1:N，解绑不误关，同一会话不能有第二个绑定，per-run 顶替先关旧宿主。
- AC-159 Claude per-run 的顶替与持有由 manager 策略执行，顶替可辨为 superseded。
- AC-160 调试 agent 以宿主驱动接入，一个宿主承载多个常驻会话，无人轮经真实链路产出且可回放；不使 AC-123、AC-126、AC-136 变红。
- AC-154 至 AC-160 全部 achieved；或由人裁定放宽、取消其中任一条。

## 已知限制

- 「现有测试不改一行照常通过」由 AC-155 的逐帧比较承载，而非对测试文件做字节钉住；钉字节会把以后任何合法的测试修改都读成回归。
- 宿主快照里的 pid 在默认包装下可能为空（runtime 不对外暴露 pid），迁到各自的 driver 后再补齐。
