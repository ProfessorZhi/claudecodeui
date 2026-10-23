---
id: AC-227
title: 令牌设置接口 /api/settings/access-tokens 能创建、列出、吊销，明文只在创建响应里出现，旧的 api-keys 接口不再存在
status: achieved
kind: criterion
goal: GOAL-018
criterion: for f in server/modules/oauth/tests/access-tokens.routes.test.ts; do
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/oauth/tests/access-tokens.routes.test.ts
expect: 用生产的设置路由工厂加注入的认证中间件（设置 `req.user`）在进程内起 express，经真实 HTTP 请求。读数：(a)
  创建——POST 带名称与有效期（7、30、90）返回 201，响应体含匹配 `^ccp_[0-9a-f]{64}$` 的明文；(b) 列表——GET
  的整个响应体里找不到该明文，也找不到哈希，只有前缀、名称、scope、过期、最近使用；(c) 有效期不在 7、30、90 之内一律
  400，且不创建任何记录；(d) 吊销——DELETE 后同一令牌的校验被拒，再删一次返回 404；(e) 归属——另一个用户的令牌 id
  不能被当前用户吊销（404），列表也只含当前用户的令牌；(f) 旧接口——`/api/settings/api-keys` 的 GET 与 POST
  不再被设置路由处理（不返回旧的 `apiKeys` 响应形状）。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i)
  列表直接返回整行（含哈希）⇒ (b) 必须红；(ii) 创建接受任意天数 ⇒ (c) 必须红；(iii) 吊销不校验归属 ⇒ (e) 必须红；(iv)
  旧路由仍挂着 ⇒ (f) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:19:57.311Z
statusLog:
  - at: 2026-10-04T17:19:57.311Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T18:55:45.557Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:19:57.311Z
---
