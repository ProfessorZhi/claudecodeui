---
id: AC-212
title: store 窗口：脱离尾部时实时消息不渲染也不丢，回到尾部后全部出现
status: superseded
kind: criterion
goal: GOAL-017
criterion: for f in src/modules/chat/tests/sessionStoreWindow.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx vitest run
  src/modules/chat/tests/sessionStoreWindow.test.ts
expect: 客户端单测针对 session store 的窗口模型：slot 以绝对序号 [start,end) 表示窗口并带『贴尾』标志。用例：(a)
  以尾部窗口开始，向前加载后 start 减小、end 不变，序号连续无重叠；(b) 跳转到中间窗口后标志为脱离，此时 appendRealtime
  的消息进入 realtime 缓冲，getMessages 不返回它们，计数在『有 N 条更新消息』的读数里；(c) 向后加载直到 end 追上
  total，标志自动回到贴尾，缓冲的实时消息按原顺序出现且无重复；(d) 窗口超过上限（默认 500）时丢弃远离视口那一端，丢弃后 start/end
  仍与保留内容一致；(e) total 在加载期间变化（对端追加）时窗口以 id 对齐，不错位；(f)
  贴尾状态下的既有行为（fetchFromServer、fetchMore、appendRealtime、truncateAt）与改造前同输入同输出。取假形态：脱离后仍把实时消息混进渲染列表、或丢弃一端后不更新
  start、或回到尾部时重复展示缓冲消息，均必须红。当前必红：测试文件不存在，store 无窗口概念。
origin: 设计讨论 2026-10-03/04（人 yale
  裁定：滚动条走自绘、按消息序号计位置；隐藏窗口内原生滚动条；服务端缓存增量化纳入本期）。现状实证：历史读取是尾部 offset 分页，客户端 store
  假定已加载内容为后缀（fetchMore 的 offset=serverMessages.length），每页 20 条且 scrollTop<100
  才触发加载；服务端缓存每次追加整体失效。
activatedAt: 2026-10-03T16:08:24.661Z
statusLog:
  - at: 2026-10-03T16:08:24.661Z
    from: draft
    to: active
    actor: yale-session
    reason: GOAL-017 激活：判据已观测为红（缺判据文件）
  - at: 2026-10-03T17:50:15.945Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-10-04T14:07:25.652Z
    from: achieved
    to: superseded
    actor: yale-session
    reason: 人 yale 2026-10-04 裁定取消 GOAL-017：滚动条恢复原生，刻度条与自绘滚动条移除、改为用户输入目录抽屉（bd393444）
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-03T16:08:24.661Z
---
