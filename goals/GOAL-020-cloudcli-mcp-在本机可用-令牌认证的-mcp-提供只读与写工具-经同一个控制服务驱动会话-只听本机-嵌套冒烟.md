---
id: GOAL-020
title: CloudCLI MCP 在本机可用：令牌认证的 /mcp 提供只读与写工具，经同一个控制服务驱动会话，只听本机，嵌套冒烟由人确认
status: achieved
kind: goal
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:03:54.122Z
statusLog:
  - at: 2026-10-05T23:22:35.845Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---

## 背景

GOAL-018 给了令牌（哈希存储、带 scope 与过期、可吊销），GOAL-019 给了与传输无关的控制服务（立即返回 runId、忙时排队、来源 `mcp`、按 id 寻址、宿主启停服务）。本 goal 在这两块地基上把 MCP 做成会话控制平面的第二个前端：一个无状态的 Streamable HTTP 端点 `/mcp`，用令牌认证，经同一个控制服务驱动会话，而不是调用 Claude Code CLI 的旁路。开发期的验证客户端是本机终端里的 Claude Code，OAuth 完成之前不对公网暴露（GOAL-021）。设计见 docs/proposals/mcp-gateway-SPEC.md（v3.1）的「MCP 工具」「认证与令牌」「开发期验证」。

## 范围

- 新增 `server/modules/mcp-gateway/`：无状态 Streamable HTTP 的 `/mcp`，经 `server/index.ts` 单实例装配，挂在静态路由之前，由 `MCP_ENABLED` 控制，默认关闭。
- 只读工具：`overview`、`projects_list`、`sessions_list`、`session_get`（含常驻宿主的 state、pid、leases、peerName）、`session_read`（latest、outline、around，长文本按游标分页）、`run_get`（可有界等待，上限 25 秒）、`quay_snapshot`。
- 写工具：`session_send`（立即返回 runId，可有界等待）、`session_create`、`session_interrupt`、`session_start`、`session_close`（有 cron 或后台任务时需 `force`）。写工具一律经同一个控制服务与宿主启停服务。
- 项目与会话按 id 或名称子串解析，唯一命中才接受；目标不明时写操作不发生。
- 认证：只接受令牌，401 不泄露原因，校验与 `GET /api/oauth/token-info` 共用同一个令牌服务；`MCP_OAUTH_ENABLED` 未开启时只接受本机直连（非回环拒绝，带任何转发头也拒绝）。
- scope：令牌签发只接受 SPEC 词汇表里的五个值；每个工具声明所需 scope，不足则拒绝并留审计。
- 审计：每次工具调用一行，参数只记摘要，90 天保留期清理。
- 自指保护：目标会话正在执行名字以网关写工具名结尾的 MCP 工具时，对它的写操作被拒。
- 设置页：CloudCLI MCP 区块（端点、启用状态、Claude Code 接入命令）与令牌 scope 勾选，12 种语言文案。
- 依赖：`@modelcontextprotocol/sdk` 与 `zod` 声明进 `dependencies`；跨模块 barrel 导出（`getRunById`、`startResidentHost`、`closeResidentHost`、`getProjectSessionsPage`）随网关这个消费者一起加。
- 冒烟：新增 `scripts/mcp-smoke.mjs`（含 `--check-record`），做法照 `scripts/resident-smoke.mjs`；记录文件 `docs/proposals/cloudcli-mcp-smoke.md`。

## 非目标

- 不实现 OAuth、动态客户端注册、授权页与公网暴露，它们属于 GOAL-021；`/mcp` 在本 goal 只接受令牌且只听本机。
- 不实现常驻专有工具（`session_cancel_queued`、`session_reconfigure`、`session_background`、审批），它们属于 GOAL-022。
- 不做文件、git、任意 shell 工具，不做 MCP Resources，不支持附件与图片。
- 不改 WebSocket 协议，不改全局 `API_KEY` 中间件。
- 在生产 3001 上启用 MCP 不属于判据：那是人在会话外设置 `MCP_ENABLED` 并重启，重启会关闭所有常驻会话。

## 退出条件

1. 依赖（AC-239）：SDK 与 `zod` 在 `dependencies`，范围合理，lock 一致。覆盖状态：AC-239 直接覆盖。
2. 传输（AC-240）：无状态、返回 JSON-RPC 而不是 SPA、默认关闭、挂在静态路由之前，并有 SDK 与 express 4 的兼容守卫。覆盖状态：AC-240 直接覆盖。
3. 认证（AC-241）：各种无效令牌同一个 401，有效放行，吊销即时生效，校验与 token-info 共用一个令牌服务。覆盖状态：AC-241 直接覆盖。
4. 本机限制（AC-242）：OAuth 未开启时非回环与任何转发头都被拒，守卫在认证之前。覆盖状态：AC-242 直接覆盖。
5. scope 词汇（AC-243）：签发只接受词汇表里的值，服务层与路由层都校验。覆盖状态：AC-243 直接覆盖。
6. 审计（AC-244）：每次调用一行，参数摘要不含全文，保留期清理。覆盖状态：AC-244 直接覆盖。
7. 只读工具（AC-245、AC-246、AC-247、AC-248）：列表、详情、读取与分页正确；名称解析唯一才接受；overview 冷缓存零 quay CLI；run_get 有界等待与过期说明。覆盖状态：四条各自直接覆盖。
8. 写工具（AC-249、AC-250、AC-251、AC-278）：发送立即返回且与 UI 发起的运行是同一种；创建与中止；宿主启停复用同一份服务；**且这四个工具在生产装配里真的接上了**。覆盖状态：AC-249/AC-250/AC-251 各自直接覆盖其注入 deps 的行为，AC-278 直接覆盖 `server/index.ts` 的装配面。⚠️ 2026-10-05 实测：`sessionCreate` / `sessionInterrupt` / `sessionHostControl` 三个 deps 成员在 `server/index.ts` 里出现 **0** 次（`git log -S sessionCreate -- server/index.ts` 为空，从未接上，非回归），生产上四个会话写工具一律回 `MCP_TOOL_NOT_IMPLEMENTED` —— 故本条原先写的「三条各自直接覆盖」对生产装配不成立，由 AC-278 补齐。
9. 自指保护与装配（AC-252、AC-253）：别名任意的自指被拒；只构造一个控制服务实例，barrel 导出各有消费者。覆盖状态：两条各自直接覆盖。
10. 设置页（AC-254、AC-255）：MCP 区块与 scope 勾选在真实浏览器里正确，12 种语言文案齐全。覆盖状态：两条各自直接覆盖。
11. 冒烟（AC-256、AC-257）：独立实例上用终端 Claude Code 驱动真实会话的记录齐全，并由人确认通过。覆盖状态：前者证明读数齐全，后者是人工关卡；两者缺一不可，记录齐全而人未确认时终止状态是 needs-human。
12. 既有行为不回归，typecheck、lint、build 通过，边界 lint 无新违规。覆盖状态：无单独 AC，由每个任务的 scoped 门与 fan-in 的全量 suite 守护；GOAL-019 的回归守卫 AC-237 同样要保持绿。

## 已知限制

- SPEC 写的「回环守卫以 socket 远端地址判断」在本 goal 收紧为「再加转发头存在即拒」：本机反代或 tailscale serve 经回环转进来时，socket 仍是回环，只有转发头能区分；已回填 SPEC。
- SPEC 写的 overview 含「最近 1 小时异常结束的运行」，但注册表只保留完成的运行 5 分钟，且摘要里没有退出码，只有 `aborted`；本 goal 取「保留期内被中止的运行」，已回填 SPEC。
- 真实 Claude 驱动的 `cancel_async_message` 经控制服务的覆盖在 GOAL-022 的真实二进制 AC 里，不在本 goal。
