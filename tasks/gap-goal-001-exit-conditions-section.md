---
id: gap-goal-001-exit-conditions-section
title: GOAL-001 缺 `## 退出条件` 节：提议把行内退出条件提升为独立小节并显式标注范围内 UI 项的覆盖
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

选型 (b)：修订 GOAL-001 的退出条件文本（不新增 AC，不改任何状态）。

**未被覆盖的部分（逐字引用）**：目标正文以行内句子给出退出条件，而非 `## 退出条件` 小节：「退出条件：AC-001 至 AC-007 全部为真，即向后兼容不破、网关请求真实落地、密钥不入库、env 注入面封闭、上下文窗口随 profile、终端 resume 保真、会话 profile 锁定生效。」

**为何现有 AC 集判为 insufficient**：机械层要求目标正文含非空的 `## 退出条件` 小节；goals/GOAL-001-cloudcli-launch-profiles.md 没有该标题（退出条件埋在单段正文里），所以机械层判 insufficient，语义 judge 从未被咨询。AC-001..AC-007 与该行内句子逐条一一对应，内容上并无缺口，缺的只是结构。

**附带观察（供人裁定，不在本任务范围）**：范围内列了「Settings 管理页」「会话创建入口的选择」，7 条 AC 均未直接覆盖 UI 层；若人认为它们属退出条件，应另立 AC；否则应在文本中明示「UI 由后端 AC 间接保证/不作为退出条件」。

**建议的修订文本**：在 goals/GOAL-001-cloudcli-launch-profiles.md 正文末尾新增

## 退出条件
- AC-001 至 AC-007 全部为真：向后兼容不破、网关请求真实落地、密钥不入库、env 注入面封闭、上下文窗口随 profile、终端 resume 保真、会话 profile 锁定生效。
- 范围内 UI 项（Settings 管理页、会话创建入口选择）不单列退出条件，其正确性由上述 AC 的后端契约保证（若人裁定需要，另立 AC）。

并把原行内「退出条件：…」句删除以免重复。此修订使机械层可解析出非空退出条件，语义 judge 才会被咨询。

## Resolution

2026-09-20 人（yale）裁定：选 (a)——范围内 UI 项（Settings 管理页、会话创建入口选择）明示不入退出条件，由 AC-001..AC-007 的后端契约间接保证，不另立 AC。据此已修订 goals/GOAL-001-cloudcli-launch-profiles.md：新增 `## 退出条件` 小节并删除行内「退出条件：…」句。剩余待观察：下一轮 goal-sufficiency round log 中该 goal 的最新 verdict 由语义 judge 给出（第 3 条 AC）。

## Evidence

- 2026-09-20：`.quay/goal-round.jsonl` round 125（ts 2026-09-20T03:44:03Z）中 GOAL-001 `sufficiency: {"goal":"GOAL-001","verdict":"covered"}`，reason「sufficiency=covered（在域 AC 7 条）」；`.quay/goal-sufficiency-cache.json` 记录语义 judge verdict=covered（03:38:25Z）。不再是机械 insufficient。

## AC
- [x] `grep -c '^## 退出条件' goals/GOAL-001-cloudcli-launch-profiles.md` 输出 1，且该小节非空白字符数 ≥ 40。
- [x] 人（yale）已在本任务下裁定 UI 项处理方式（明示不入退出条件，或另立 AC 的任务 id）；裁定记录在本任务 Resolution 中。
- [x] 修订后下一轮 goal-sufficiency 判定不再因「无退出条件小节」产生机械 insufficient（读 round log 该 goal 的最新 verdict）。

## DoD
人工授权后，真实修改 GOAL-001 目标文件（经授权的 goal 写入路径，而非本 agent），并在下一轮实际 round log 中观察到判定结果由机械 insufficient 变为由语义 judge 给出；仅有文本改动而无后续 verdict 观察不算完成。本任务由跟进 agent 只提议，不改 goals/*.md，不改任何 GOAL/AC 状态。

## Touches
- goals/GOAL-001-cloudcli-launch-profiles.md
- tasks/gap-goal-001-exit-conditions-section.md

## Adjudication 2026-09-20（人 yale 授权：needs-human → todo → ready）

下方 `## Needs-Human` 块已失效，仅作历史记录保留；再次派发的 worker 不应把它读作现行阻塞。

- 裁定：死因是环境性的，不是任务质量问题。worker-driver 连续 3 次 exited-not-landed 撞满重试上限，是机械翻转。
- 根因：quay fan-in 以硬编码的 repo 相对路径 `plugin/scripts/runner-static-gate.ts` 解析其 static-check registry（select-static-checks-for-touches.ts 中的 TEST_SH_REL）。该路径在已安装插件布局与本项目下都解析不到，导致 `--classify-delta` exit=2；fan-in 的 suite 证书闸对 `suite_head..tip` delta（flip-done 刚提交 tasks/<id>.md 所推进的那段）fail-closed，ff 被拒——每次尝试烧掉一整次 suite 运行，直至重试耗尽。
- 修复：已在 develop 落地，commit **f7604c68**（本项目自行提供 plugin/scripts/runner-static-gate.ts）。已在真实任务分支上验证 `--classify-delta` 现在 exit 0，且仅含 tasks/<id>.md 的 delta 判为惰性，证书闸通过、ff 首次尝试即可推进。该重试耗尽路径已不可达。
- 留意：本任务记录的近因判词是 `step=scoped-gate: bash: scripts/test.sh: No such file or directory`，与上述 classify-delta 缺陷并非同一处。重新派发时若再次出现 scripts/test.sh 缺失，应作为独立的基建缺口另行定位，而不是判本任务不合格。
- 使用的 ABI 动词：lifecycle_adjudicate（只读审计）→ lifecycle_retreat（needs-human → todo，理由记入 GateEvent）→ 状态随后到达 ready。

## Needs-Human（已失效，历史记录）

**执行 2026-09-20T03:45:59.791Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=scoped-gate: bash: scripts/test.sh: No such file or directory
- run_id：wk-prod-anchor
- session_id：2d0336a6-f021-467b-b687-52f588c26e0c
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-goal-001-exit-conditions-section-wk-prod-anchor.log
