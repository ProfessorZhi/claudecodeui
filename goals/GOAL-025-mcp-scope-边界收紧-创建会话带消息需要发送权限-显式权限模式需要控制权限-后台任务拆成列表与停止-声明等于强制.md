---
id: GOAL-025
title: MCP scope 边界收紧：创建会话带消息需要发送权限、显式权限模式需要控制权限、后台任务拆成列表与停止、声明等于强制
status: draft
kind: goal
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---

## 背景

来源是对 CloudCLI 作为面向第三方 MCP 客户端的公开服务的契约审计（实测方法：在隔离实例上用 MCP 协议拉 `initialize`、`tools/list`，并触发 21 种错误与边界调用）。审计发现的主要事实：17 个工具里没有一个参数带说明；错误形状在各工具间不一致且大量中英混杂；权限不足只回一句不说缺哪个 scope 的纯文本；部分失败被当作成功结果返回；`session_create` 带 `message` 等于发送却只需 create；元数据缺 `scopes_supported` 与根路径的受保护资源文档。 本 goal 处理 scope 边界：声明的与实际强制的是否一致，以及几处「scope 边界形同虚设」的工具。

## 范围

- `session_create` 带非空 `message` 需要 `cloudcli:session:send`，不再只靠 create。
- 显式指定 `permissionMode`（`session_create` 与 `session_reconfigure`）需要 `cloudcli:session:control`，且权限检查先于「支持哪些模式」的提示。
- `session_background` 拆成只读的列表与需要 control 的 `session_background_stop`，各自的 annotations 准确；旧的 `stopTaskId` 用法明确拒绝并指路。
- 每个工具的所需 scope 写进 `_meta.requiredScopes` 与描述，并有「声明等于强制」的守卫测试。

## 非目标

- 不改 scope 词表本身与授权页（已完成）。
- 不做按授权限定项目范围（另行评估）。
- 不改错误形状（GOAL-024）。

## 退出条件

1. create 与 send（AC-290）：只有 create 的令牌带 message 被拒且不产生副作用。覆盖状态：直接覆盖。
2. permissionMode（AC-291）：显式模式需要 control，两处一致。覆盖状态：直接覆盖。
3. 拆分（AC-292）：两个工具、scope 与 annotations 准确、旧参数明确拒绝。覆盖状态：直接覆盖。
4. 声明等于强制（AC-293）：逐工具验证，声明与强制漂移时测试变红。覆盖状态：直接覆盖。
5. 既有行为不回归，typecheck、lint、build 通过。覆盖状态：无单独 AC。

## 已知限制

- **前置 GOAL-024**：本 goal 的 AC 使用 `INSUFFICIENT_SCOPE` 与统一信封。拆分 `session_background` 会让已经接入的客户端看到一个新工具名，需要它们刷新工具列表。每个新增的服务端测试文件，按既有惯例同步仓库里钉住服务端测试文件总数的那处，否则会让全队的全量 suite 变红。
