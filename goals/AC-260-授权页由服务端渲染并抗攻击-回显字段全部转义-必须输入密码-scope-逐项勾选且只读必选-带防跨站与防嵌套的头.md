---
id: AC-260
title: 授权页由服务端渲染并抗攻击：回显字段全部转义，必须输入密码，scope 逐项勾选且只读必选，带防跨站与防嵌套的头
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in server/modules/oauth/tests/oauth-consent-page.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/oauth/tests/oauth-consent-page.test.ts
expect: "读数：(a) `GET /oauth/authorize` 返回 HTML，显示客户端名称、回调主机与请求的 scope；客户端名称为
  `<script>alert(1)</script>` 或 `\"><img src=x onerror=1>`
  时原样作为文本呈现、不形成可执行节点；(b) 只读 scope 默认勾选且不可取消，其余默认不勾；(c)
  密码错误：不签发授权码、不跳转，返回带错误说明的页面；密码正确：302 到 `redirect_uri`，带 `code` 与原样回传的
  `state`；(d) 用户取消：302 带 `error=access_denied`；(e) 提交时勾选的 scope
  少于请求的，授权记录里就是勾选的那些，且始终含只读；(f) 表单带每次渲染唯一的 CSRF 令牌，缺失或不匹配的 POST 被拒；(g) 响应头含
  `X-Frame-Options: DENY` 与 `frame-ancestors 'none'`，`Cache-Control:
  no-store`。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 不转义客户端名称 ⇒ (a) 必须红；(ii)
  密码错误仍签发授权码 ⇒ (c) 必须红；(iii) 去掉 CSRF 校验 ⇒ (f) 必须红；(iv) 去掉防嵌套头 ⇒ (g)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。"
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:19:42.616Z
statusLog:
  - at: 2026-10-05T02:19:42.616Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:24:41.883Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:19:42.616Z
---
