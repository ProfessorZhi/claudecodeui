---
id: AC-228
title: 真实浏览器里设置页能创建个人访问令牌：明文只显示一次，刷新后只剩前缀，吊销后消失，旧的 API Key 创建入口不再存在
status: achieved
kind: criterion
goal: GOAL-018
criterion: for f in e2e/access-tokens-settings.spec.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test
  e2e/access-tokens-settings.spec.ts
expect: 真实浏览器、真实后端、临时数据目录。读数：(a) 在设置页的 API 标签创建一个令牌后，一次性提示里出现匹配
  `ccp_[0-9a-f]{64}` 的明文；(b) 重新加载页面后，页面上任何文本节点都不含该明文，列表行显示其前缀与名称；(c) 有效期下拉的选项恰好是
  7、30、90 天；(d) 吊销后该行从列表消失或标为已吊销，并且用该令牌访问需要认证的接口被拒；(e) 页面上不再有旧的 API Key
  创建入口（旧按钮文案与旧文档链接都不在）。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 列表行渲染完整明文 ⇒ (b)
  必须红；(ii) 保留旧的创建按钮 ⇒ (e) 必须红；(iii) 吊销只改前端状态、不调接口 ⇒ (d)
  的拒绝一条必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:20:27.211Z
statusLog:
  - at: 2026-10-04T17:20:27.211Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T19:21:47.790Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:20:27.211Z
---
