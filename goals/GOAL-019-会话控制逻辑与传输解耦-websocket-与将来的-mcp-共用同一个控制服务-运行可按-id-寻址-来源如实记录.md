---
id: GOAL-019
title: 会话控制逻辑与传输解耦：WebSocket 与将来的 MCP 共用同一个控制服务，运行可按 id 寻址，来源如实记录
status: achieved
kind: goal
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal
  及其 AC（决策 D1 至 D10 见该文档）。
activatedAt: 2026-10-04T17:16:37.946Z
statusLog:
  - at: 2026-10-04T20:31:10.141Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---

## 背景

CloudCLI 的会话控制逻辑（发送、中止、撤回排队、停止后台任务、回答审批）直接写在 WebSocket 处理器里：`resolveSendTarget` 用 socket 发协议错误，`runDetachedChatTurn` 在进入 `dispatchRun` 之前自行拒绝忙会话，因此绕过了常驻会话「忙时输入写进 CLI 自己的队列」的路径。要让 MCP 成为与 WebSocket 同层的第二个前端，而不是调用 Claude Code CLI 的旁路，就必须把应用逻辑抽成与传输无关的控制服务，且 WebSocket、定时发送、将来的 MCP 都只是它的适配层。同时，运行只能按会话寻址，被取代或已完成的运行无法按 runId 查到；MCP 发起的运行没有 WebSocket 连接，会被注册表默认记成 scheduled；会话宿主的启动与关闭逻辑内联在路由处理器里。设计见 docs/proposals/mcp-gateway-SPEC.md（v3）的「ChatControlService」与「运行按 id 寻址」。

## 范围

- 在 websocket 模块内部新增 `ChatControlService`（`services/chat-control.service.ts`），经模块 barrel 导出：`send`、`editSend`、`abort`、`cancelQueued`、`stopTask`、`backgroundTask`、`answerApproval`、`pendingApprovals`。与传输无关：不接受 WebSocket 对象，失败以带稳定错误码的结果返回，由各适配层翻译。
- `send` 与 `chat.send` 走同一条路径（含常驻会话的忙时排队）；在运行登记后立即返回 `runId`，常驻会话忙时额外返回 `queued` 与 `queuedMessageUuid`，驱动负责交出该 uuid。所有动作先过同一个访问入口，调用方带用户 id。
- `server/index.ts` 单实例装配：只构造一个控制服务实例，交给 `createWebSocketServer` 与 scheduled-messages；WebSocket 处理器只做解析、调用、翻译；`runDetachedChatTurn` 退化为 `send` 的薄包装或删除，scheduled-messages 的「打断进行中的运行」语义保持。
- `ChatRunSource` 新增 `mcp`，由调用方显式传来源；未传时保持旧默认。
- 运行按 id 寻址：`chatRunRegistry` 增加 runId 索引与运行摘要，被取代与已完成的运行在保留期内可查，过期与未知有明确结果；保留期可注入。
- 会话宿主启动与关闭抽成 session-hosts 模块内的服务，路由与后续的 MCP 共用，既有拒绝码与文案逐字不变。
- 调试 agent 的常驻宿主驱动同样交出排队消息的 uuid，使排队路径可以不跑真 CLI 就被自动判据覆盖。

## 非目标

- 不实现 MCP、OAuth 与任何新的对外端点。
- 不改 WebSocket 协议与 `chat.subscribe` 的帧序列（受按次进程逐帧一致性判据保护），不重构注册表「每个会话一个当前运行」的模型，只加索引。
- 不新增没有跨文件消费者的 barrel 导出：`getRunById`、宿主启停服务、`getProjectSessionsPage`、登录校验窄口等，随各自的消费者（GOAL-020、GOAL-021）一起导出；本 goal 只导出 `createChatControlService`，其消费者是 `server/index.ts`。
- 不改真实 Claude 驱动的 `cancel_async_message` 实现，只让驱动把已有的 uuid 交给调用方。

## 退出条件

1. 立即返回（AC-230）：`send` 在运行登记后立即返回，`runId` 就是注册表里的那个；会话不存在与 provider 不可用有稳定错误码且不登记运行；测试不构造任何 socket。覆盖状态：AC-230 直接覆盖。
2. 忙会话语义（AC-231）：常驻会话忙时排队并返回可撤回的 uuid，按次进程的会话忙时被拒，撤回用的就是返回的 uuid，未知 uuid 得到 unknown。覆盖状态：AC-231 直接覆盖。
3. 访问入口（AC-232）：五个控制动作共用同一个访问入口，未认证一律 FORBIDDEN 且驱动一次都没被碰，生产默认入口同样如此。覆盖状态：AC-232 直接覆盖。
4. 单实例（AC-233）：WebSocket 与 scheduled-messages 触达同一个实例，处理器里不再直接调用分发、中止、撤回，并带扫描器的正例对照。覆盖状态：AC-233 直接覆盖。
5. 来源（AC-234）：mcp、user、scheduled、unattended 各自如实记录，旧默认不变。覆盖状态：AC-234 直接覆盖。
6. 按 id 寻址（AC-235）：被取代与已完成的运行在保留期内可查，过期与未知有明确结果，中止的运行记为 aborted，「每个会话一个当前运行」与重放行为不变。覆盖状态：AC-235 直接覆盖。
7. 宿主启停服务（AC-236）：服务存在，路由只剩解析与翻译，已运行幂等，既有拒绝码与文案不变。覆盖状态：AC-236 直接覆盖。
8. 不回归（AC-237）：17 个既有测试文件逐字不改地通过，含按次进程的逐帧一致性判据与 AC-196、AC-197、AC-198 的访问入口判据。覆盖状态：AC-237 直接覆盖。
9. 调试驱动上的排队与撤回（AC-238）：uuid 由驱动交出，不撤回时成为独立的下一轮，撤回后永远不成为一轮，已开始执行的消息不可撤回。覆盖状态：AC-238 直接覆盖。
10. 真实 Claude 二进制的常驻判据（AC-161 一族）保持通过。覆盖状态：无单独 AC（负载下易假红，不放进判据），由 fan-in 的全量 suite 守护；真实驱动的 `cancel_async_message` 经控制服务的端到端验证由 GOAL-020 的人工门覆盖。
11. typecheck、lint、build 通过，边界 lint 无新违规。覆盖状态：无单独 AC，由每个任务的 scoped 门与 fan-in 守护。

## 已知限制

- `queuedMessageUuid` 由驱动分配并经事件流送达前端；让控制服务的调用方同步拿到它，需要驱动在不改变事件流的前提下把它交出来，这是本 goal 里唯一依赖实现探索的点（SPEC 未核实项 5）。
