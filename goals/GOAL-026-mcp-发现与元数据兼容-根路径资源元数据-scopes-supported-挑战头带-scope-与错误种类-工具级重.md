---
id: GOAL-026
title: MCP 发现与元数据兼容：根路径资源元数据、scopes_supported、挑战头带 scope 与错误种类、工具级重新授权提示
status: draft
kind: goal
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---

## 背景

来源是对 CloudCLI 作为面向第三方 MCP 客户端的公开服务的契约审计（实测方法：在隔离实例上用 MCP 协议拉 `initialize`、`tools/list`，并触发 21 种错误与边界调用）。审计发现的主要事实：17 个工具里没有一个参数带说明；错误形状在各工具间不一致且大量中英混杂；权限不足只回一句不说缺哪个 scope 的纯文本；部分失败被当作成功结果返回；`session_create` 带 `message` 等于发送却只需 create；元数据缺 `scopes_supported` 与根路径的受保护资源文档。 本 goal 处理 OAuth 发现与元数据对 ChatGPT、Gemini 与其它通用客户端的兼容缺口，依据 OpenAI 文档对受保护资源元数据、挑战头与工具级重新授权的要求（本会话内已逐条抓取核对）。

## 范围

- 受保护资源元数据在根路径与带路径两处都返回同一份 JSON；`/.well-known/openid-configuration` 返回 404 JSON，不再被 SPA 兜底成 200 HTML。
- 两份元数据补齐 `scopes_supported`（等于签发词表）、`resource_name`、`bearer_methods_supported`、`response_modes_supported` 等字段，并守住「不带 scope 的授权流程」不变。
- 401 的挑战头带 `scope`；令牌无效或过期带 `error="invalid_token"`，响应体对原因仍不泄露。
- 工具级权限不足的结果带 `_meta["mcp/www_authenticate"]`，使 ChatGPT 能触发重新授权界面。

## 非目标

- 不实现 RFC 9207 的 `iss` 参数与 CIMD：DCR 已够用，而改动授权响应会影响已经跑通的 Gemini 链路，等有客户端确实需要再立项。
- 不改授权页与 scope 词表。

## 退出条件

1. 路径（AC-294）：根路径与带路径同文，openid-configuration 为 404 JSON，挂载先于静态路由。覆盖状态：直接覆盖。
2. 字段（AC-295）：两份元数据字段齐全且一致，无 scope 的授权流程回归守卫。覆盖状态：直接覆盖。
3. 挑战头（AC-296）：缺令牌与无效令牌可区分且不泄露原因。覆盖状态：直接覆盖。
4. 重新授权提示（AC-297）：`INSUFFICIENT_SCOPE` 带 ChatGPT 识别的 `_meta`。覆盖状态：直接覆盖。
5. 对 Gemini 与 ChatGPT 的真实回归：改动元数据后各自重新绑定一次仍成功。覆盖状态：无 AC，由人在会话外验证。
6. 既有行为不回归，typecheck、lint、build 通过。覆盖状态：无单独 AC。

## 已知限制

- **前置 GOAL-024**：AC-297 依赖统一的 `INSUFFICIENT_SCOPE`。元数据改动对线上已绑定的客户端的影响只能靠真实重新绑定验证。每个新增的服务端测试文件，按既有惯例同步仓库里钉住服务端测试文件总数的那处，否则会让全队的全量 suite 变红。
