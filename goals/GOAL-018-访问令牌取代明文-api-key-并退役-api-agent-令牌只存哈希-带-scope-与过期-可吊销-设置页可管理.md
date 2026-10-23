---
id: GOAL-018
title: 访问令牌取代明文 API Key，并退役 /api/agent：令牌只存哈希、带 scope 与过期、可吊销，设置页可管理
status: achieved
kind: goal
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal
  及其 AC（决策 D1 至 D10 见该文档）。
activatedAt: 2026-10-04T17:16:37.358Z
statusLog:
  - at: 2026-10-04T19:33:13.022Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---

## 背景

明文 `api_keys`（`ck_` 前缀，无 scope、无过期、明文存库）唯一的消费者是 `POST /api/agent`：它一次性跑完一个 agent，绕过 `chatRunRegistry`，强制 bypassPermissions，UI 看不到也控制不了。人 yale 2026-10-05 裁定该接口对自己没用并退役，路径留作将来复用；访问凭证改为哈希存储、带 scope 与过期、可吊销的令牌，作为 CloudCLI MCP（GOAL-020、GOAL-021）的认证底座。本机库里 `api_keys` 为 0 行、只有 1 个用户，迁移没有存量数据。设计见 docs/proposals/mcp-gateway-SPEC.md（v3）的「认证与令牌」与「/api/agent 退役清单」。

## 范围

- 新增 `server/modules/oauth/`（本 goal 只含个人访问令牌部分）：`access_tokens` 表与令牌服务（签发、校验、吊销、过期、scope）。明文形态 `ccp_` 加 64 位 hex，库里只存 SHA-256 哈希与前缀；有效期只允许 7、30、90 天，默认 30 天，不允许永久。
- 设置接口 `/api/settings/access-tokens`（创建、列表、吊销），替换 `/api/settings/api-keys`。
- 迁移：建 `access_tokens`；删除 `api_keys` 表与 `idx_api_keys_*` 索引并在日志里报告删除的行数；不把旧 key 转成令牌。
- 退役 `server/modules/agent/`、`server/index.ts` 里的挂载与组装、`apiKeysDb` 仓储及其导出与建表语句、设置模块里的 api-keys 部分。
- 设置页的 API 标签：令牌区块替换 API Keys 区块（创建时一次性显示明文，列表只显示前缀、scope、过期、最近使用，可吊销）；全部 12 种语言的 `settings.json` 同步；`public/api-docs.html` 不再描述已退役的接口。

## 非目标

- 不实现 OAuth（授权码、客户端注册、授权页）与 `/mcp`，它们属于 GOAL-020 与 GOAL-021。
- 不声明 `@modelcontextprotocol/sdk` 与 `zod` 依赖：它们的消费者在 GOAL-020，随消费者一起进 `dependencies`，本 goal 不留无人使用的依赖。
- 不改全局 `API_KEY` 环境变量中间件（`server/index.ts` 对 `/api` 的 `validateApiKey`），也不改 GitHub 凭证区块。
- 不迁移旧 key，不给 `/api/agent` 路径挂新用途；删除后该路径的行为就是未挂载 `/api` 路由的既有行为。

## 退出条件

1. 令牌服务（AC-224）：明文只在签发时出现一次，库里只有哈希与前缀；有效令牌被接受；过期、吊销、改写、前缀错误、scope 越权五种各自被拒；有效期只允许 7、30、90 天；吊销即时生效。覆盖状态：AC-224 直接覆盖。
2. 迁移（AC-225）：`api_keys` 与其索引被删，行数写入日志，`access_tokens` 就位，用户数据不动，重复运行与全新库都不出错。覆盖状态：AC-225 直接覆盖。
3. 退役（AC-226）：`server/modules/agent`、挂载、`apiKeysDb`、`createAgentModule`、旧建表语句从生产代码消失，以语法树而不是文本匹配判定，并带正例对照；`public/api-docs.html` 不再宣传已退役的接口。覆盖状态：AC-226 直接覆盖。
4. 设置接口（AC-227）：创建、列表、吊销可用；明文只在创建响应里出现；列表不含明文与哈希；非法有效期被拒；归属校验；旧 `/api/settings/api-keys` 不再被处理。覆盖状态：AC-227 直接覆盖。
5. 设置页（AC-228、AC-229）：真实浏览器里创建后明文只显示一次，刷新后只剩前缀，吊销后消失，旧的创建入口不存在；12 种语言文案齐全且键集合一致。覆盖状态：AC-228 与 AC-229 直接覆盖。
6. 既有行为不回归：除上述被替换的部分外，现有测试套件、typecheck、lint、build 全部保持通过。覆盖状态：无单独 AC，由每个任务的 scoped 门与 fan-in 的全量 suite 守护。
7. 本机真库的迁移：服务重启时自然执行，重启由人在会话外进行；本机真库没有存量 key。覆盖状态：无 AC，不属于判据（重启会关闭常驻会话）。

## 已知限制

- 旧的明文 key 不会被迁移成令牌，现有客户端若有人在用 `x-api-key` 调 `/api/agent`，会在重启后失效；本机没有这样的客户端（库里 0 行）。
