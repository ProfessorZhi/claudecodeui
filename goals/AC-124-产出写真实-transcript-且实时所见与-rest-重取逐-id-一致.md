---
id: AC-124
title: 产出必须写真实形态 transcript，且实时所见与 REST 重取逐 id 一致
status: achieved
kind: criterion
goal: GOAL-007
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/debug-agent/tests/debug-agent-frames.test.ts
expect: 装载一个场景文档（整行追加 + 就地增长两种 op 都有），**走真实 runtime 产出帧**，然后从产物回读、逐条断言，
  而不是断言"引擎说它做了什么"：(1) **落盘**——transcript 文件真实存在于门控指定的 fixture 根下，行数与
  `expect.rows.delta` 相符，且文件里**含** `expect.content.mustContain` 的每一条；(2)
  **就地增长**—— `grow` 步让行数 N 不变、末行字节数增加，且归一化后是**同一条**消息 id 的内容变化；(3) **实时与历史一致**——
  把 socket 上收到的帧按 id 集合与 REST 重取（`/api/providers/sessions/:id/messages`）回来的历史按
  id 集合取交， 交集必须覆盖本次产出的每一条消息（这是本判据的承重项：`complete` 会触发一次 REST 重取，只发帧不落盘的实现
  会在这一步与实时分叉）；(4) **帧由真实归一化产出**——帧上的 `seq` 由 run registry 分配且严格递增。
  取假形态：**frames-only**——只发帧、不写 transcript（帧仍可由真实 helper 产出，客户端看不出区别）。该变体必须让 (1)
  与 (3) 同时红：客户端全绿而磁盘零行、历史缺消息。命令必须逐字含文件路径，**不得用 glob**（glob 无命中时 `node --test` 退出
  0，会在模块不存在时假绿）。当前必红：该测试文件不存在。
origin: ADR-003 决策 4 与后续任务 1、3。裁决 C 移出的是"贴底漂移"那一条，不涉及本条——本条测的是产出是否落盘 且两条读法一致，与贴底无关。
activatedAt: 2026-09-22T14:45:00.000Z
statusLog:
  - at: 2026-09-22T14:45:00.000Z
    from: draft
    to: active
    actor: yale
    reason: 随 GOAL-007 立；红先行。该取假变体已在 ADR-003 的现场验证里实测过一次（客户端 3 帧全绿、 transcript 0
      行、历史 1 条 vs 实时 3 条）。
  - at: 2026-09-22T15:52:51.736Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
