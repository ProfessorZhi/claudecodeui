---
id: AC-273
title: session_background：只读列出后台任务与计划（cron），带 stopTaskId 时停止，停止需要 control 权限且结果如实
status: achieved
kind: criterion
goal: GOAL-022
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-session-background.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-background.test.ts
expect: 读数：(a) 只读列出该会话持有的 `background-task` 与 `cron` lease，含
  id、种类、是否周期，数据取自宿主快照，`cloudcli:read` 即可；(b) 带 `stopTaskId` 时经控制服务的 `stopTask`
  停止，需要 `cloudcli:session:control`，只读令牌被拒且控制服务调用计数为 0；(c) 停止一个不存在的 id
  返回明确的未找到，不虚报已停止；(d) 停止后再次列出，该 lease 消失；(e)
  冷会话（无宿主）列出为空并说明没有宿主。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 只读令牌也能停止 ⇒ (b)
  必须红；(ii) 不存在的 id 回「已停止」 ⇒ (c) 必须红；(iii) 列表漏掉 cron ⇒ (a)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:26:50.839Z
statusLog:
  - at: 2026-10-05T02:26:50.839Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:28:06.625Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:26:50.839Z
---
