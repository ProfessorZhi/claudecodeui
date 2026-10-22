---
id: AC-242
title: OAuth 未开启时 /mcp 只接受本机直连：非回环地址拒绝，带任何转发头的请求也拒绝，防止经 cloudflared 或本机反代意外暴露
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts
expect: 守卫只在 `MCP_OAUTH_ENABLED` 未开启时生效。读数：(a) 以 socket
  远端地址判断：`127.0.0.1`、`::1`、`::ffff:127.0.0.1` 放行；docker 网桥
  `172.17.0.1`、`192.168.1.5`、`10.0.0.2`、远端地址缺失一律 403；(b) 转发头一律不被信任，且只要出现就拒绝：即使
  socket 是回环，带 `X-Forwarded-For`、`Forwarded`、`CF-Connecting-IP`、`X-Real-IP`
  任一头的请求也得 403（本机反代或 tailscale serve 经回环转进来时必带其中之一）；(c) `MCP_OAUTH_ENABLED`
  开启时守卫关闭，非回环请求能走到认证并得到 401 而不是 403；(d) 被守卫拒绝的请求不触发令牌校验（校验间谍计数为
  0）。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 信任 `X-Forwarded-For` 的回环值 ⇒ (b)
  必须红；(ii) 只判远端地址、不看转发头 ⇒ (b) 必须红；(iii) 守卫放在认证之后 ⇒ (d)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:08:00.905Z
statusLog:
  - at: 2026-10-05T02:08:00.905Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T04:30:14.822Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:08:00.905Z
---
