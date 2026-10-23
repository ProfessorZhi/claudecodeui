---
id: GOAL-021
title: 经 OAuth 对外接入 CloudCLI MCP：授权服务器、授权页、客户端注册与吊销，外部客户端绑定由人确认
status: achieved
kind: goal
origin: 人 yale 2026-10-05 指令：创建并激活 GOAL-020 至 GOAL-022 及其 AC；同日 02:10 退回
  draft，理由逐字「等 GOAL-020 达成后再激活」。2026-10-06T23:22:46Z GOAL-020 已 achieved（AC-257
  人证行由 yale 裁定通过后由 goal-driver I2 翻绿），前置条件满足，按原指令重新激活。
activatedAt: 2026-10-05T02:03:54.776Z
statusLog:
  - at: 2026-10-05T02:10:00.493Z
    from: active
    to: draft
    actor: human:yale
    reason: 人 yale 指令：退回 draft，等 GOAL-020 达成后再激活（021、022 的 AC 依赖 020 才能满足，同时激活会让任务因
      mcp-gateway 尚不存在而反复失败并被机械翻成 needs-human）
  - at: 2026-10-05T23:22:57.407Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-06T01:53:00.128Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---

## 背景

GOAL-020 之后，`/mcp` 在本机靠令牌可用，但只听本机。要让 Gemini 等外部客户端连进来，需要一个标准的 OAuth 2.1 授权服务器：发现文档、客户端注册、带 PKCE 的授权码流程、refresh 轮换、吊销，以及一个由服务端渲染的授权页（用 CloudCLI 的用户名与密码把关）。该端点一旦经 cloudflared 暴露到公网，一个令牌就能在这台机器上驱动 bypassPermissions 的 agent，所以限速、受众绑定、转义与即时吊销都是本 goal 的一部分，不是可选项。设计见 docs/proposals/mcp-gateway-SPEC.md（v3.1）的「认证与令牌」「OAuth 流程」「加固」。本 goal 的 AC 在 GOAL-020 达成之前无法全部满足。

## 范围

- 在 `server/modules/oauth/` 内新增授权服务器：`oauth_clients`、`oauth_grants`、`oauth_authorization_codes` 三张表与仓储，实现 SDK 的 `OAuthServerProvider` 与 `OAuthRegisteredClientsStore`；令牌沿用 `access_tokens`。
- 端点：`/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource/mcp`、`/oauth/register`、`/oauth/authorize`、`/oauth/token`、`/oauth/revoke`；挂在静态路由之前；`MCP_OAUTH_ENABLED` 与 `PUBLIC_BASE_URL`（必须 https，localhost 例外）控制。
- 授权页：服务端渲染，所有回显字段转义，密码校验经 auth 模块的窄口，scope 逐项勾选且只读必选，CSRF 令牌，防嵌套与不缓存的头；密码提交限速（每来源每 15 分钟 10 次），来源取自 `TRUST_PROXY` 配置下的 `CF-Connecting-IP`。
- 语义：PKCE 强制 S256，授权码 60 秒一次性，refresh 轮换并检测复用，受众绑定到 `PUBLIC_BASE_URL/mcp`，scope 只能缩小。
- 客户端注册：`MCP_DCR=off|allowlist|open`，默认 off；手工创建客户端；密钥只显示一次且哈希存储。
- `/mcp` 在 OAuth 开启后的认证：401 带资源元数据指引，PAT 与 OAuth 令牌并存，回环守卫自动关闭。
- 设置接口与设置页：已连接的应用（列出、吊销授权）、OAuth 客户端（高级：手工创建、禁用），12 种语言文案。
- 端到端流程判据与外部客户端绑定的记录与人工关卡（`scripts/mcp-smoke.mjs` 增加 `--check-external-record` 模式）。

## 非目标

- 不做第二因素（TOTP）、不做 Cloudflare Access 配置、不做 Gemini Enterprise 路径。
- 不改工具集，不改 GOAL-020 已有工具的行为。
- 不做授权页的多用户选择：所有授权都映射到唯一的 CloudCLI 用户。
- 在生产上启用 OAuth 与改 cloudflared 配置不属于判据，由人在会话外执行。

## 退出条件

1. 存储（AC-258）：三张表、哈希存储、吊销级联、迁移幂等。覆盖状态：AC-258 直接覆盖。
2. 授权服务器语义（AC-259）：PKCE、授权码一次性与过期、refresh 轮换与复用检测、受众、redirect_uri 精确匹配、有效期。覆盖状态：AC-259 直接覆盖。
3. 授权页（AC-260、AC-261）：转义、密码、scope、CSRF、防嵌套头；限速与来源判定。覆盖状态：两条各自直接覆盖。
4. 元数据与挂载（AC-262、AC-263）：端点返回 JSON 而不是 SPA，基址必须 https；`/mcp` 的 401 指引、令牌并存、受众与回环守卫的切换。覆盖状态：两条各自直接覆盖。
5. 客户端注册（AC-264）：DCR 三档策略与手工客户端。覆盖状态：AC-264 直接覆盖。
6. 管理（AC-265、AC-266、AC-267）：设置接口、真实浏览器与 12 种语言文案。覆盖状态：三条各自直接覆盖。
7. 端到端（AC-268）：发现、注册、授权、换令牌、调用、刷新、吊销后被拒，正反例同一次运行。覆盖状态：AC-268 直接覆盖。
8. 外部客户端（AC-269、AC-270）：外部客户端经 OAuth 绑定并调用成功的记录齐全，并由人确认。覆盖状态：前者证明读数齐全，后者是人工关卡，缺一不可；人无法使用 Gemini 时可用 Claude.ai 连接器或其他客户端，记录里写明。
9. 公网暴露本身（cloudflared 映射、域名、Cloudflare Access 的 bypass）与 `MCP_DCR` 收紧为 allowlist 后的重新绑定。覆盖状态：无独立 AC 点亮，后者的读数是 AC-269 的一节；前者是人在会话外的操作。
10. 既有行为不回归，typecheck、lint、build 通过。覆盖状态：无单独 AC，由 scoped 门与 fan-in 全量 suite 守护。

## 已知限制

- Gemini 的 OAuth 行为（是否支持 DCR、回调主机、是否发送 `resource`、是否使用 refresh、工具调用超时）在 SPEC 里是未核实前提，答案来自外部客户端那份记录，可能迫使调整本 goal 的某些默认值。
- Google 帮助页写明 Gemini 自定义应用要求账号在美国、仅英文、个人账号、开启 Keep Activity；人若无法使用，本 goal 的人工关卡改由其他 MCP 客户端完成。
