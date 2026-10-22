---
id: AC-252
title: 自指保护：目标会话正在执行名字以网关写工具名结尾的 MCP 工具时，对它的写操作被拒；服务器别名任意，读工具不受影响
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/mcp-gateway/tests/mcp-self-target.test.ts; do
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-self-target.test.ts
expect: 活动存储可注入，制造目标会话的回合阶段与工具名。读数：(a) 阶段为 `tool`、工具名为
  `mcp__cloudcli__session_send`、`mcp__my-cc-ui__session_interrupt`、`mcp__x__session_close`
  等任意别名加网关写工具名后缀时，`session_send`、`session_interrupt`、`session_close`、`session_cancel_queued`
  都返回 `SELF_TARGET`，控制服务与宿主服务调用计数为 0；(b) 工具名为
  `Bash`、`mcp__other__list_files`、`mcp__x__session_read`（读工具）时放行；(c) 阶段不是
  `tool`（例如已回到 `thinking`，工具名是上一个遗留值）时放行；(d)
  判定用的写工具名集合取自工具注册表，不手写第二份：往测试用注册表里加一个新写工具，守卫自动覆盖它；(e)
  读工具永远不被拒。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 只按 `mcp__cloudcli` 前缀判断 ⇒
  (a) 的别名用例必须红；(ii) 手写第二份名单 ⇒ (d) 必须红；(iii) 阶段不看、只看工具名 ⇒ (c)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:14:47.161Z
statusLog:
  - at: 2026-10-05T02:14:47.161Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T13:34:58.734Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:14:47.160Z
---
