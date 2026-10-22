---
id: GOAL-023
title: MCP 工具契约文档：描述、参数说明、服务级 instructions 与由 tools/list 生成的公开参考，并固化为长期有效的契约检查
status: draft
kind: goal
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---

## 背景

来源是对 CloudCLI 作为面向第三方 MCP 客户端的公开服务的契约审计（实测方法：在隔离实例上用 MCP 协议拉 `initialize`、`tools/list`，并触发 21 种错误与边界调用）。审计发现的主要事实：17 个工具里没有一个参数带说明；错误形状在各工具间不一致且大量中英混杂；权限不足只回一句不说缺哪个 scope 的纯文本；部分失败被当作成功结果返回；`session_create` 带 `message` 等于发送却只需 create；元数据缺 `scopes_supported` 与根路径的受保护资源文档。 本 goal 处理描述与参数说明，并在最后固化成一条长期有效的契约检查，以后任何新增或修改的工具都被同一套规则约束。

## 范围

- 每个工具的描述写清何时用、何时不用、相邻工具的区别、需要的 scope；每个参数写说明，数字参数有上下界与默认值，有限取值写成枚举或列全。
- `initialize` 的 `instructions`（引用规则、工作流、写前先确认、scope 含义、错误信封读法）、公开的 `serverInfo`（名称、标题、版本取自包版本、网址）、`capabilities.tools.listChanged` 改为 `false`。
- 描述与行为一致：`session_start` 与 `session_close` 说明是常驻宿主，`quay_snapshot` 说明 `refresh` 的默认，`overview` 说明实际返回的键。
- 由 `tools/list` 生成的公开参考文档 `docs/mcp/README.md` 及其同步检查。

## 非目标

- 不改行为，不改参数集合（那是 GOAL-024、025、027）。
- 不重命名工具：`session_start` 与 `session_close` 保留名字，只修描述。
- 不做授权页的多语言。

## 退出条件

1. 契约检查（AC-280）：描述、参数说明、数字上下界、枚举、无裸 any，且检查器自己能变红。覆盖状态：直接覆盖。
2. 服务级说明（AC-281）：`instructions`、`serverInfo`、`listChanged`。覆盖状态：直接覆盖。
3. 描述即行为（AC-282）：三处描述与实际行为一致，由行为反推。覆盖状态：直接覆盖。
4. 参考文档（AC-283）：生成、同步检查、含接入章节。覆盖状态：直接覆盖。
5. 既有行为不回归，typecheck、lint、build 通过。覆盖状态：无单独 AC。

## 已知限制

- **前置 GOAL-024**：参考文档要列出每个工具可能返回的 code，描述要引用统一的错误信封；AC-280 的「输出结构无裸 any」与 GOAL-027 的输出结构工作有重叠，先落地者为准。建议在 GOAL-024、025、027 达成之后再激活，使文档描述的是最终契约。每个新增的服务端测试文件，按既有惯例同步仓库里钉住服务端测试文件总数的那处，否则会让全队的全量 suite 变红。
