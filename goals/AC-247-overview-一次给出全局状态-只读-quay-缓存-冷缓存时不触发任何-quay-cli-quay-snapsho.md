---
id: AC-247
title: overview 一次给出全局状态，只读 quay 缓存，冷缓存时不触发任何 quay CLI；quay_snapshot 单独负责刷新，一次一个项目
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in server/modules/mcp-gateway/tests/mcp-overview.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-overview.test.ts
expect: 读数：(a) `overview` 含运行中的会话（项目、标题、回合阶段、已运行时长）、阶段为 `awaitingPermission`
  的会话（经注入的活动存储制造）、保留期内被中止的运行、常驻宿主一览（state 与 leases）；(b) quay 部分——缓存命中的项目带任务计数与
  driver、suite 状态；缓存未命中的项目标为「未知」，且注入的 quay 命令运行器的调用计数为 0（冷缓存零 CLI）；(c)
  `quay_snapshot` 默认读缓存，带 `refresh` 时对该项目恰好触发一次运行器调用，且一次只接受一个项目；(d) 没有 quay
  配置的项目说明「该项目没有 quay」而不是抛错；(e) 项目数很多（20 个）时 `overview` 的运行器调用数仍为
  0，不随项目数增长。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) `overview` 传 `refresh`
  或对未命中的项目现取 ⇒ (b) 与 (e) 必须红；(ii) 漏掉 `awaitingPermission` 的会话 ⇒ (a) 必须红；(iii)
  `quay_snapshot` 的 refresh 不触发运行器 ⇒ (c) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1
  输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:11:27.298Z
statusLog:
  - at: 2026-10-05T02:11:27.298Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T07:57:12.033Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:11:27.298Z
---
