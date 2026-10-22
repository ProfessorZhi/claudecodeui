---
id: AC-243
title: 令牌签发只接受 scope 词汇表里的值：拼错的、预留的 cloudcli:admin、空列表都被拒，设置接口给出稳定错误码
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/oauth/tests/access-token-scopes.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/oauth/tests/access-token-scopes.test.ts
expect: 用生产的设置路由工厂加注入的认证中间件，经真实 HTTP。词汇表就是 SPEC
  里的五个：`cloudcli:read`、`cloudcli:session:send`、`cloudcli:session:create`、`cloudcli:session:control`、`cloudcli:approve`。读数：(a)
  词汇表内任意非空子集都能签发，响应里的 scope 与请求一致且去重；(b) 拼错的 scope（如 `cloudcli:reed`）、不带前缀的
  `read`、`cloudcli:admin`、空列表、非字符串元素，全部 400，带同一个稳定错误码，且不创建任何记录；(c) 缺省不带 scope
  时仍只签发 `cloudcli:read`，与现状一致；(d) 服务层单独调用 `issue` 传入非法 scope
  同样被拒，不能靠绕过路由签出。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 保留现在的「任意非空字符串」 ⇒ (b)
  必须红；(ii) 只在路由校验、服务层不校验 ⇒ (d) 必须红；(iii) 允许 `cloudcli:admin` ⇒ (b)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:08:40.355Z
statusLog:
  - at: 2026-10-05T02:08:40.355Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T03:46:18.760Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:08:40.355Z
---
