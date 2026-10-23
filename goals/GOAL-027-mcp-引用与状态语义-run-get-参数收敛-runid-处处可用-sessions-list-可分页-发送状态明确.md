---
id: GOAL-027
title: MCP 引用与状态语义：run_get 参数收敛、runId 处处可用、sessions_list 可分页、发送状态明确、输出结构真实
status: draft
kind: goal
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---

## 背景

来源是对 CloudCLI 作为面向第三方 MCP 客户端的公开服务的契约审计（实测方法：在隔离实例上用 MCP 协议拉 `initialize`、`tools/list`，并触发 21 种错误与边界调用）。审计发现的主要事实：17 个工具里没有一个参数带说明；错误形状在各工具间不一致且大量中英混杂；权限不足只回一句不说缺哪个 scope 的纯文本；部分失败被当作成功结果返回；`session_create` 带 `message` 等于发送却只需 create；元数据缺 `scopes_supported` 与根路径的受保护资源文档。 本 goal 处理引用与状态语义：外部模型「看得到、串得起来、知道是否被截断」。

## 范围

- `run_get`：只保留 `runId`、`session`（二选一）与 `waitSeconds`，去掉 `run`、`wait` 别名；互斥与缺失明确报错；上下界写进 schema，超限被拒而不是静默截断。
- 凡返回一次运行的地方（`session_get`、`overview`、`session_send`、`session_create`）都带 `runId`，且能直接交给 `run_get`。
- `sessions_list` 增加 `limit` 与 `cursor`，输出 `nextCursor` 与 `truncated`；翻页覆盖全部会话。
- `session_send` 的结果带明确的 `state`（`running`、`queued`、`completed`、`failed`、`wait_timed_out`），等待结果有类型。
- 每个工具的成功结果都符合自己声明的 `outputSchema`，不再有声明与实际脱节。

## 非目标

- 不改错误形状与 code（GOAL-024）。
- 不重命名工具，不改 scope。
- 不做 `session_read` 的分页重构（它的两套分页语义混用，另行评估）。

## 退出条件

1. `run_get` 参数（AC-298）：三个参数、二选一、上下界、明确报错。覆盖状态：直接覆盖。
2. runId（AC-299）：四处都带，且互通。覆盖状态：直接覆盖。
3. 分页（AC-300）：翻页覆盖全部、明说是否截断、篡改的 cursor 被拒。覆盖状态：直接覆盖。
4. 发送状态（AC-301）：五种状态各有用例，等待超时不是错误。覆盖状态：直接覆盖。
5. 输出结构真实（AC-302）：全部工具的结果通过自己的 schema。覆盖状态：直接覆盖。
6. 既有 MCP 判据保持通过（移植、不放宽），typecheck、lint、build 通过。覆盖状态：无单独 AC。

## 已知限制

- **前置 GOAL-024**（错误信封）。删除 `run_get` 的别名会让按旧参数调用的客户端得到 `INVALID_ARGUMENT`，已经接入的 ChatGPT 与 Gemini 需要刷新工具列表。凡断言旧形状的既有判据（至少涉及 mcp-audit、mcp-approvals、mcp-run-get、mcp-session-host-control、mcp-session-background、mcp-self-target、mcp-cancel-queued、mcp-overview、mcp-oauth-challenge、mcp-session-send、mcp-resolve-target、mcp-session-reconfigure、mcp-read-tools、mcp-session-lifecycle 等测试文件）只许移植到新形状并保持断言强度，不许删除或放宽。 每个新增的服务端测试文件，按既有惯例同步仓库里钉住服务端测试文件总数的那处，否则会让全队的全量 suite 变红。
