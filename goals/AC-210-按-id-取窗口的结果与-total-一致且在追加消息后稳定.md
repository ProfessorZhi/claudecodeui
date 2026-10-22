---
id: AC-210
title: 按 id 取窗口的结果与 total 一致且在追加消息后稳定
status: superseded
kind: criterion
goal: GOAL-017
criterion: for f in
  server/modules/providers/tests/session-window-around.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/providers/tests/session-window-around.test.ts
expect: 服务端测试：对一个 ≥1200 条的夹具会话，请求『围绕消息 id=X 取前 B 条、后 A 条』。断言：返回窗口恰是完整历史数组中 X 前 B
  条到后 A 条的切片（越界时收窄且 hasMoreBefore / hasMoreAfter 为真），并带 startIndex（绝对序号）与
  total；窗口内 X 的位置为 B（或收窄后的真实位置）。随后向转录追加 N 条消息再以同一 id 请求，窗口内容与 startIndex
  不变、total 增加 N；对一个已不存在的 id 返回明确的『未找到』而不是回落到尾部页。既有 limit/offset
  接口行为逐字不变（同一夹具上的既有读数相等）。取假形态：用 total-offset 的尾部偏移实现并在追加后不重算 startIndex、或未知 id
  静默回落最新页，均必须红。当前必红：接口与测试文件均不存在。
origin: 设计讨论 2026-10-03/04（人 yale
  裁定：滚动条走自绘、按消息序号计位置；隐藏窗口内原生滚动条；服务端缓存增量化纳入本期）。现状实证：历史读取是尾部 offset 分页，客户端 store
  假定已加载内容为后缀（fetchMore 的 offset=serverMessages.length），每页 20 条且 scrollTop<100
  才触发加载；服务端缓存每次追加整体失效。
activatedAt: 2026-10-03T16:07:24.977Z
statusLog:
  - at: 2026-10-03T16:07:24.977Z
    from: draft
    to: active
    actor: yale-session
    reason: GOAL-017 激活：判据已观测为红（缺判据文件）
  - at: 2026-10-03T17:29:24.569Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-10-04T14:07:24.922Z
    from: achieved
    to: superseded
    actor: yale-session
    reason: 人 yale 2026-10-04 裁定取消 GOAL-017：滚动条恢复原生，刻度条与自绘滚动条移除、改为用户输入目录抽屉（bd393444）
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-03T16:07:24.977Z
---
