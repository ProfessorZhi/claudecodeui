---
id: gap-goal-003-exit-conditions-section
title: GOAL-003 缺 `## 退出条件` 小节：提议把行内退出条件提升为独立小节，使充分性判定不再被机械短路（AC-103/AC-104
  内容无缺口，缺的只是结构）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

选型 (b)：修订 GOAL-003 的**退出条件文本**（不新增 AC，不改任何 GOAL/AC 状态）。

**未被覆盖的部分（逐字引用）**：目标正文把退出条件写成一行普通段落，而不是 `## 退出条件` 小节：

「退出条件：AC-103（并发 checker）与 AC-104（归因 checker）均 achieved，即两条判据由红转绿；或由人裁定放宽 / 取消其中任一条。」

GOAL-003 标题「测试机制：并发套件互不拖红，且套件红可归因」的两个半句分别由 AC-103、AC-104 承载；下面说明为何这不构成内容缺口，缺的只是**结构**。

**为何现有 AC 集被判 insufficient**：机械层要求目标正文含**非空的 `## 退出条件` 小节**。`plugin/scripts/goal-driver.ts:1009` 的 `exitConditionsText()` 经同文件 `:993` 的 `extractSections()` 以正则 `##[ \t]+(退出条件[ \t]*)\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)` 取节：标题**逐字匹配**且**不允许带后缀**（`allowHeadingSuffix` 对退出条件刻意不开）；`:1041` 的 `goalSufficiencyVerdict()` 第一条就是 `if (!hasExitConditions(...)) return "insufficient";` —— 在语义判定入口（`:1043` 的 `not-evaluated`）**之前**就短路返回。

`goals/GOAL-003-测试机制-并发套件互不拖红-且套件红可归因.md` 正文**没有任何 `## ` 标题**（`grep -c '^#'` 为 0；背景 / 范围 / 非目标 / 退出条件四段都是行内散文）。故 `hasExitConditions` 为 false，verdict 恒为 `insufficient`，**语义 judge 从未被咨询**。对照：GOAL-001（第 52 行）与 GOAL-002（第 47 行）都写成了 `## 退出条件` 小节，两者均已 achieved。

**内容上并无缺口**：AC-103 逐字覆盖标题前半句「并发套件互不拖红」（并发两组退出码均为 0、`STACK_TRACE_ERROR` 与 `[vitest-worker]: Timeout calling "fetch"` 计数均为 0、服务端逐文件中位耗时 ≤ K 倍安静基线）；AC-104 逐字覆盖后半句「套件红可归因」（reason 落在基建类取值、无法归因的条目进 `unattributed` 段而不进 `failures[]`）。二者与该行内句逐条一一对应；目标自身的 `范围` 段也写着「判据以两条 AC 的 checker 读数表达，不以配置里出现了哪些行为标志」。**缺的只是结构，不是内容** —— 因此本提案不新增 AC。

**证据**：`.quay/goal-round.jsonl` round 744 与 745 均含 `{"name":"goal-sufficiency","value":{"sufficiency":{"goal":"GOAL-003","verdict":"insufficient"}},"state":"verified","reason":"sufficiency=insufficient（在域 AC 2 条）"}`；reason 中不含任何语义 judge 的产物，与上述机械短路一致。`.quay/goal-sufficiency-followup.json` 记 `GOAL-003.since=2026-09-20T14:47:54.848Z`、`filedAt=null`（即本任务为首次跟进立案）。

**同类先例（同一配方，第二次应用）**：`gap-goal-001-exit-conditions-section`（status=done）对 GOAL-001 的**同一形态**缺陷做了同一件事（行内句 → `## 退出条件` 小节），其 Evidence 记着修订后 round log 中该 goal 的 verdict 由机械 insufficient 变为语义 judge 给出的 `covered`。本任务不是新机制，是该配方的复用。

**建议的修订文本**（与 GOAL-001/GOAL-002 同一房屋风格：小节标题 + 逐条 AC 编号 + 该条的实质判据），在 `goals/GOAL-003-测试机制-并发套件互不拖红-且套件红可归因.md` 正文末尾新增下列小节，并把原行内「退出条件：…」句删除以免重复：

## 退出条件

- AC-103 并发套件互不拖红：同一台机器上**并发**（非串行）启动的两个全量套件退出码均为 0，两份输出中 `STACK_TRACE_ERROR` 与 `[vitest-worker]: Timeout calling "fetch"` 计数均为 0，且服务端逐文件耗时中位数不超过安静基线的 K 倍（K 由首次实测钉死后写回本条）。
- AC-104 套件红可归因：制造一次必然的基建失败后，该轮落盘轮记录的 reason 必须落在基建类取值（infra-error / aborted / crashed / timeout / hung）之一而不得是 failed，且无法归因到具体文件的失败条目进 `unattributed` 段、不进 `failures[]`。
- 或由人裁定放宽 / 取消其中任一条。

<!-- dedup-ref -->相关但不同：AC-103 的 checker `scripts/suite-concurrency-check.sh` 与 AC-104 的 checker `scripts/suite-infra-attribution-check.sh` 至今不存在（gate exit 127），其实现由既有的 `gap-suite-concurrency-checker` 与 `gap-suite-infra-attribution` 两条任务承担；本任务只做**退出条件文本的结构修订**，不写这两个脚本，也不是那两条任务的先行条件。

**附带观察（供人裁定，不在本任务范围）**：AC-103 的 expect 里 K 仍是占位符（「K 由首次实测钉死后写回本条」）。修订退出条件**不会**让 AC-103 / AC-104 转绿，本任务只解除「verdict 恒为机械 insufficient ⇒ goal 永远卡在 active」这一死锁；K 的钉死属实现任务。

## AC
- [x] `grep -c '^## 退出条件' goals/GOAL-003-测试机制-并发套件互不拖红-且套件红可归因.md` 输出 1，且该小节去空白后的字符数 ≥ 40。
- [x] 人（yale）已在本任务下裁定是否采纳本修订（采纳 / 改措辞 / 不采纳并另立 AC），裁定记录写进本任务的 Resolution 小节。
- [x] 修订后下一轮 `.quay/goal-round.jsonl` 中 GOAL-003 最新 `goal-sufficiency` verdict 的 reason 不再是无语义产物的纯机械短路形态（即不再是「sufficiency=insufficient（在域 AC 2 条）」这一类），而是语义 judge 给出的 covered / insufficient 结论。

## DoD
人工授权后，由**被授权的 goal 写入路径**（而非本 agent）真实修改 `goals/GOAL-003-测试机制-并发套件互不拖红-且套件红可归因.md`：新增 `## 退出条件` 小节、删除原行内「退出条件：…」句；并在其后的**真实 round log** 中观察到 GOAL-003 的 sufficiency verdict 不再恒为机械 insufficient（语义 judge 被实际咨询并给出结论）。仅有文本改动而无后续 verdict 观察不算完成。本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态。

## Touches
- goals/GOAL-003-测试机制-并发套件互不拖红-且套件红可归因.md
- tasks/gap-goal-003-exit-conditions-section.md

## Resolution

**人（yale）2026-09-20 裁定：采纳。**

- **裁定依据**：本任务提议「把行内退出条件提升为独立小节」，而该修订已实质落地——GOAL-003 正文现为 背景 / 范围 / 非目标 / 退出条件 / 决定记录 / 修订单 六个真小节（`^## ` 标题 6 个），与 GOAL-001 / GOAL-002 同一房屋风格。
- **AC1 实测（2026-09-20）**：`grep -c '^## 退出条件' goals/GOAL-003-测试机制-并发套件互不拖红-且套件红可归因.md` = **1**；该小节去空白后 **92** 字符（判据要求 ≥ 40）。
- **与建议文本的偏差（如实登记）**：本任务立案时只列 AC-103 / AC-104；落地版退出条件小节逐条列了 **AC-103 / AC-104 / AC-105** 三条——AC-105（挂死看门狗）是在本任务立案之后新立的，同属该目标的判据，漏掉它会重造同一条死锁。建议文本中「删除原行内退出条件句」那半不适用：落地方案是**整份 body 重排**而非追加小节，原本就不存在重复句。
- **根因（值得记，属本任务最贵的一条产出）**：初稿 body 的 `grep -c '^#'` 为 **0**——整份正文一个小节都没有。成因是为规避另一条已知坑（「body 解析器会吃掉行内 `## X` 字面量」）而**过度回避**了任何小节写法；那条告诫针对的是「在散文里**提及**小节名」，**不是**「不许写小节」。过度遵守与不遵守同样偏离，且它造成的这次是**死锁**（verdict 恒为机械 insufficient ⇒ goal 永远卡在 active），不只是格式瑕疵。
- **状态说明**：AC1 与 AC2 已满足；**AC3 仍未满足**——它要求修订后下一轮 `.quay/goal-round.jsonl` 里 GOAL-003 的 `goal-sufficiency` verdict 是语义 judge 的结论而非机械短路形态。该读数要等 goal-driver 跑一轮才会产生，故本任务不会即刻全绿。

## Evidence

**2026-09-20（worker，worktree `gap-goal-003-exit-conditions-section`）——AC1 / AC3 实测**

- **落地路径**：修订由**被授权的 goal 写入路径**完成，commit `f4b9f181`「goals: GOAL-003 field:body by cli:2703735」，已在 develop（`git merge-base --is-ancestor f4b9f181 develop` 成立）。本 worker **未**再次改动 `goals/*.md`，未增删 AC，未改任何 GOAL/AC 状态。
- **AC1**：`grep -c '^## 退出条件'` = **1**；用 goal-driver `extractSections(body,"退出条件")` 的**同一条正则** `##[ \t]+(退出条件[ \t]*)\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)`（`allowHeadingSuffix` 不开）取出节体，去空白后 **92** 字符（判据 ≥ 40）；全文 `^## ` 标题 6 个。与 Resolution 记录的数值一致。
- **AC3 —— 三层证据，均指向「语义 judge 已被实际咨询」**：
  1. **机械短路不再触发**：对 GOAL-003 的**当前**记录调用 goal-driver 导出的 `goalSufficiencyVerdict()`，得 **`not-evaluated`**（不再是 `insufficient`）——`hasExitConditions` 为真、在域 AC 3 条非空，函数越过第 1041 行的短路，落到语义判定入口。**这是本任务要修的那一处。**
  2. **语义裁决确属 GOAL-003 修订后的输入**：`.quay/goal-sufficiency-cache.json` 中 `ts=2026-09-20T15:05:12.489Z`、`verdict="covered"`、`key=4e7fcbca…e1d7`。用 goal-driver 导出的 `sufficiencyCacheKey(goal, inScopeAcs)` 对 GOAL-003 当前记录（id / title / 退出条件节 / `## 范围` 节 / 在域 AC 的 id,title,expect 三元组）重算，得**逐字节相同**的 `4e7fcbca76624b2f76a17c21f89f8bbb96e20b2753bdce82e46cec6bdb23e1d7`。该 key 含退出条件节文本与标题，故只能由**修订后**的 body 产生——裁决不是别的目标、也不是修订前的输入。且 `covered` 在 `parseSemanticSufficiencyVerdict()` 之外**不可达**（机械 `goalSufficiencyVerdict` 只可能返回 `insufficient` / `not-evaluated`）。
  3. **轮日志**：`.quay/goal-round.jsonl` 中 GOAL-003 的 `goal-sufficiency` 序列 —— round 749–752 为 `sufficiency=insufficient（在域 AC 3 条）`（纯机械短路形态），**round 753–756 变为 `sufficiency=covered（在域 AC 3 条）`**；最新一轮 **round 756**（ts `2026-09-20T15:16:40.687Z`）即 `covered`。如实登记一处细节：round 752（15:03:43Z）晚于 commit `f4b9f181`（15:03:13Z）30 秒，读数仍是机械形态；自 round 753（15:06:23Z）起稳定为语义结论，与第 2 条的缓存写入时刻 15:05:12Z 吻合。AC3 要求的是「修订后……最新 verdict」，round 756 满足。
- **未改动项（如实登记）**：AC-105 的 checker `scripts/suite-hang-watchdog-check.sh` 仍不存在（gate exit 127），该 AC 转绿属 `gap-suite-hang-watchdog` 任务范围，不在本任务；AC-103 的 K 仍是占位符，属实现任务。本任务只解除「verdict 恒为机械 insufficient ⇒ goal 永远卡在 active」这一死锁。
