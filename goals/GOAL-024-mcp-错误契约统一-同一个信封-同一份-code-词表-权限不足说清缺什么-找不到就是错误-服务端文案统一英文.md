---
id: GOAL-024
title: MCP 错误契约统一：同一个信封、同一份 code 词表、权限不足说清缺什么、找不到就是错误、服务端文案统一英文
status: achieved
kind: goal
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
activatedAt: 2026-10-06T12:13:28.253Z
statusLog:
  - at: 2026-10-07T02:04:22.198Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---

## 背景

来源是对 CloudCLI 作为面向第三方 MCP 客户端的公开服务的契约审计（实测方法：在隔离实例上用 MCP 协议拉 `initialize`、`tools/list`，并触发 21 种错误与边界调用）。审计发现的主要事实：17 个工具里没有一个参数带说明；错误形状在各工具间不一致且大量中英混杂；权限不足只回一句不说缺哪个 scope 的纯文本；部分失败被当作成功结果返回；`session_create` 带 `message` 等于发送却只需 create；元数据缺 `scopes_supported` 与根路径的受保护资源文档。 本 goal 处理其中最影响模型行为的一块：错误语义。外部模型没有人在旁边解读，能依赖的只有结构化的错误信息；现在同一类问题在不同工具上换着说法，有的甚至不报错。设计依据见本会话的审计清单第 4 节。

## 范围

- 统一错误信封：所有失败返回 `isError: true` 与 `structuredContent: { code, message, retryable, details? }`；不再有「文本里塞 JSON」「纯文本一句话」「看似成功的 ok:false」三种旧形态。
- 唯一的 code 词表 `MCP_ERROR_CODES`，每个工具声明自己可能返回的 code；源码里面向调用方的 code 字面量都来自词表。
- 权限不足：`INSUFFICIENT_SCOPE`，`details.requiredScopes` 点名缺的 scope，说明需要重新授权；通用检查与处理函数内的检查（`session_background` 的 `SCOPE_DENIED`）形状一致。
- 引用不存在是错误：`approval_answer`、`session_cancel_queued`、`run_get`、`quay_snapshot` 不再把「找不到」伪装成成功；真实状态（已开始执行、已完成、无 quay 配置）仍是成功结果。
- 参数校验失败：`INVALID_ARGUMENT` 与 `details.fields`，不再转储整段 zod 输出；未知工具：`UNKNOWN_TOOL`。
- 服务端撰写的文案统一为英文；用户数据（会话标题、项目名、消息正文）原样返回。

## 非目标

- 不改工具的参数集合与功能（参数收敛在 GOAL-027，拆分工具在 GOAL-025）。
- 不改 OAuth 与 HTTP 层的 401 与元数据（在 GOAL-026）。
- 不新增或删除工具，不改 scope 的归属。
- 凡断言旧形状的既有判据（至少涉及 mcp-audit、mcp-approvals、mcp-run-get、mcp-session-host-control、mcp-session-background、mcp-self-target、mcp-cancel-queued、mcp-overview、mcp-oauth-challenge、mcp-session-send、mcp-resolve-target、mcp-session-reconfigure、mcp-read-tools、mcp-session-lifecycle 等测试文件）只许移植到新形状并保持断言强度，不许删除或放宽。

## 退出条件

1. 信封（AC-284）：全部工具的全部失败形状一致，同类问题同一个 code，探针表由注册表驱动。覆盖状态：直接覆盖。
2. 词表（AC-285）：单一来源、每个工具声明、观察到的 code 属于声明，无死 code，源码无自写字符串 code。覆盖状态：直接覆盖。
3. 权限不足（AC-286）：点名缺的 scope，两处检查形状一致，仍写 denied 审计。覆盖状态：直接覆盖。
4. 找不到即错误（AC-287）：四个工具的「找不到」改为错误，真实状态仍是成功。覆盖状态：直接覆盖。
5. 参数错误（AC-288）：简短、可机读，`UNKNOWN_TOOL` 同信封。覆盖状态：直接覆盖。
6. 英文（AC-289）：服务端文案无 CJK，用户数据不被误伤。覆盖状态：直接覆盖。
7. 既有 MCP 判据保持通过：移植到新形状，断言强度不降。覆盖状态：无单独 AC，由每个任务的 scoped 门与 fan-in 全量 suite 守护。
8. 部署：构建与重启由人在会话外执行，不属于判据。
9. typecheck、lint、build 通过。覆盖状态：无单独 AC。

## 已知限制

- 本 goal 是 GOAL-023、025、026 的前置：它们的 AC 引用 `INSUFFICIENT_SCOPE`、信封与词表。每个新增的服务端测试文件，按既有惯例同步仓库里钉住服务端测试文件总数的那处，否则会让全队的全量 suite 变红。
- 改变错误形状会影响已经接入的客户端（ChatGPT、Gemini）对失败的处理；它们在工具列表刷新后才会看到新的说明，错误本身立即生效。
