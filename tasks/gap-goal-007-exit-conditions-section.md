---
id: gap-goal-007-exit-conditions-section
title: GOAL-007 缺 `## 退出条件` 小节：提议补上独立小节以解除机械短路，并把两处无在域 AC 覆盖的范围项交人裁定
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案：GOAL-007 缺 `## 退出条件` 小节（机械层 goal-driver.ts:866 在任何在域 AC
    被考虑之前短路 ⇒ verdict 恒为 insufficient，语义 judge
    从未被咨询）。本任务只提议文本修订，须人裁定是否采纳，以及两处无在域 AC 覆盖的范围项（「不跑真 CLI」否命题、裁决 A 的 UI
    显示身份）是明示不作退出条件还是另立 AC。
---
---
id: gap-goal-007-exit-conditions-section
title: GOAL-007 缺 `## 退出条件` 小节：提议补上独立小节以解除机械短路，并把两处无在域 AC 覆盖的范围项交人裁定
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案：GOAL-007 缺 `## 退出条件` 小节（机械层 goal-driver.ts:866 在任何在域 AC
    被考虑之前短路 ⇒ verdict 恒为 insufficient，语义 judge
    从未被咨询）。本任务只提议文本修订，须人裁定是否采纳，以及两处无在域 AC 覆盖的范围项（「不跑真 CLI」否命题、裁决 A 的 UI
    显示身份）是明示不作退出条件还是另立 AC。
---
## Proposal

选型 **(b)：修订 GOAL-007 的退出条件文本**——不新增 AC，不改任何 GOAL/AC 状态。

### 未被覆盖的部分（逐字引用）

GOAL-007 的正文**没有 `## 退出条件` 小节**，退出条件从未写下。被漏掉的正是目标标题本身给出的两个半句：

> 调试 Agent：不跑真 CLI 也能产出与历史一致的输出，且关闭态结构性不存在

### 为何现有 AC 集被判 insufficient（机械层的成因，逐行）

`plugin/scripts/goal-driver.ts`：

- `:834` 的 `exitConditionsText()` 经同文件 `:818` 的 `extractSections()` 以正则 `##[ \t]+(退出条件[ \t]*)\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)` 取节；标题**逐字匹配**，`allowHeadingSuffix` 对退出条件**刻意不开**（`:814` 注释：「退出条件**不开**该项：`hasExitConditions` 是机械可证层，其语义不得因本次改动而变」）。
- `:840` 的 `hasExitConditions()` = `exitConditionsText(body).length > 0`。
- `:866` 的 `goalSufficiencyVerdict()` 第一条就是 `if (!hasExitConditions(String(goal.body ?? ""))) return "insufficient";`——在语义判定入口（`:868` 的 `not-evaluated`）**之前**短路返回。
- `:858` 的函数注释**逐字点名本目标**：「insufficient 结构上可证覆盖不成立：GOAL body 无【非空】`## 退出条件` 文本（退出条件从未写下，覆盖无从谈起——**GOAL-005/007/008 空 body 形态**），或零在域 AC（空集合无法覆盖）。」

所以 verdict 恒为 `insufficient`，**语义 judge 从未被咨询**。轮日志逐字为证：`.quay/goal-round.jsonl` round 3395 的 `goal-sufficiency` 事实是 `{"sufficiency":{"goal":"GOAL-007","verdict":"insufficient"}}`，reason `sufficiency=insufficient（在域 AC 6 条）`——reason 里**没有任何语义 judge 的产物**。`.quay/goal-sufficiency-followup.json` 记 `GOAL-007.since=2026-09-22T15:00:02.127Z`、`filedAt=null`（即本任务为首次跟进立案）。

### 为什么本目标只能选 (b)：(a) 解不开这个死锁

短路在 `:866` 发生在**任何**在域 AC 集合被考虑之前——`:867` 那条「零在域 AC ⇒ insufficient」都还没轮到。故**新增一条 AC 不会改变 `hasExitConditions` 的取值**，verdict 仍是机械 insufficient，goal 仍卡在 `active`。要解除死锁，改的必须是**退出条件文本**。这与 `:213-219` 的注释一致：充分性裁决是确定性的，输入变化只可能来自「（a）人改 GOAL 标题/退出条件/范围节，或（b）在域 AC 集合增删改」，而「一个已超过该周期仍未变的 insufficient，**不再有任何机制会自己去改它**；唯一剩下的改变途径正是本条信号要请人做的那件事（改退出条件，或改 AC 集合）」。本目标属 (a) 那一类。

### 同族对照：本形态只剩本目标一条

`grep -c '^## 退出条件' goals/GOAL-*.md` 在 GOAL-001 / 002 / 003 / 004 / 005 / 006 / 008 上均为 **1**，**只有 GOAL-007 为 0**。而 `:858` 点名的三兄弟里，GOAL-005 与 GOAL-008 都已有该小节——GOAL-007 是这个形态的最后一条。

### 同一配方的第三次应用（前两次均已 done）

- `gap-goal-001-exit-conditions-section`（done）：行内退出条件 → 独立小节；其 Evidence 记着修订后 round log 中 GOAL-001 的 verdict 由机械 insufficient 变为语义 judge 给出的 `covered`。
- `gap-goal-003-exit-conditions-section`（done）：同一形态。其 Resolution 记下的根因值得引用——初稿**过度回避任何小节写法**造成的是**死锁**（verdict 恒为机械 insufficient ⇒ goal 永远卡在 active），不只是格式瑕疵；落地的退出条件小节逐条列 AC-103 / AC-104 / AC-105。

### 内容上是否有缺口：两半之一齐，另有两处欠账（如实登记，供人裁定）

- **「关闭态结构性不存在」：齐。** AC-123 的三面（registry 无键 / watcher 无根 / 路由未挂载）逐条覆盖，AC-128 补上「门控关闭时同一路径不以控制面的应答作答」与「门控而非鉴权才是安全边界」。
- **「产出与历史一致」：齐。** AC-124（transcript 真实落盘 + `grow` 同 id 内容变化 + socket 帧 id 集与 REST 重取 id 集之交集覆盖本次产出的每一条 + `seq` 严格递增），AC-125（外部写入经真实观察者送达且 REST 含该内容），AC-126（禁止第二套词表的可判真伪守卫），AC-127（fixture 根来自门控变量）。
- ⚠️ **「不跑真 CLI」这个否命题没有一条直接断言。** AC-124 通过「场景指定的确定性内容必须逐条落盘」与「帧的 `seq` 由 run registry 分配」**间接**排除真 CLI（真 CLI 产不出场景指定的确定性内容），AC-126 只断言调试模块不持有帧词表——这是**蕴含**，不是正面读数。今天没有任何 AC 直接读「本次运行没有拉起任何 CLI 子进程」。
- ⚠️ **范围段第 2 条按裁决 A 的 UI 项未被任何在域 AC 覆盖。** 范围写着「UI 上必须给它**明确的显示身份**，不接受被落穿显示为 Claude」。AC-123..128 中**无一条**覆盖它；它在任务 `gap-debug-agent-engine-and-scenario-ops` 的 AC4 里是**任务级**判据，不是目标级判据。

**这两处欠账不在本任务范围**（本任务只做退出条件文本的结构修订）。它们供人裁定：明示「由 AC-124 / AC-126 的耦合间接保证，不单列退出条件」，或另立 AC。**但它们必须写进退出条件小节并标注覆盖状态**——否则语义 judge 拿到的输入是一份「退出条件 = 六条 AC 全列」的文本，它只会给出 covered，把这两处欠账重新藏回去。

### 建议的修订文本

（与 GOAL-001 / GOAL-003 同一房屋风格：小节标题 + 逐条 AC 编号 + 该条的实质判据。）在 `goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md` 正文末尾新增下列小节：

> ## 退出条件
>
> 标题的两个半句各自落到实处才算达成：
>
> - **AC-123 关闭态结构性不存在（三面）**：门控在**进程启动时**求值，故判据在两个独立子进程里各取一次读数。关闭态逐一断言 registry 无键（按 id 解析失败**与拼错一个 id 逐字相同**）、watcher 无根（fixture 根不在观察路径集合里且该目录不被创建）、路由未挂载（控制面路径**不以控制面的应答作答**——**不得写成状态码 404**，本仓库 SPA catch-all 对无扩展名路径返回 `200 text/html`）；开启态三面对照存在；取值不认识、或开了但 fixture 根为空，一律按关闭处理并打印判定原因。
> - **AC-124 不跑真 CLI 也能产出与历史一致的输出（产出侧）**：装载含 `row` 与 `grow` 两种 op 的场景后**走真实 runtime 产出帧**——transcript 真实落盘、行数与 `expect.rows.delta` 相符、文件含 `expect.content.mustContain` 每一条；`grow` 使行数不变、末行字节数增加、且归一化为**同一条**消息 id 的内容变化；socket 收到的帧 id 集与 REST 重取（`/api/providers/sessions/:id/messages`）历史的 id 集之交集**覆盖本次产出的每一条**；帧上的 `seq` 由 run registry 分配且严格递增。
> - **AC-125 外部写入经真实文件观察者送达**：判据自带排空（先排掉装载那一次 `session_upserted`）、随后要求一条**新的** upsert、并以观察者自己的 `change event for provider "…"` 日志行作**正面控制**；外部追加的内容出现在 REST 重取结果里。
> - **AC-126 禁止第二套词表**：调试模块源码范围内不出现任何帧字段名或事件名字面量，且该模块存在指向归一化入口（`normalizeMessage` / `createNormalizedMessage`）的**真实 import 语句**；守卫**可判真伪**——在调试模块里手写一个帧字面量必须让它红。
> - **AC-127 fixture 根来自门控变量而非 `os.homedir()`**：产物只出现在门控根下、**不在** decoy HOME 下；**正面断言**真实 home 本次运行没有新增（修改时间 + 条目数双读数）；teardown 后整目录删除；清理顺序是**先让索引收敛、再删根**。
> - **AC-128 控制面在门控开启时可用、缺凭据 401，且门控而非鉴权才是安全边界**：装载场景 / 推进时钟 / 读自检结果三个动作各自可达，「读自检结果」在无记录时给出**可辨的 404 而非空 200**；缺凭据 401、凭据有效但无权限 403，两者不混用；门控关闭时同一路径**不以控制面的应答作答**。
> - **AC-123 至 AC-128 六条全部 achieved**；或由人裁定放宽 / 取消其中任一条。
>
> **覆盖状态如实登记（供人裁定）**：标题两半中「关闭态结构性不存在」与「产出与历史一致」已由上列六条逐条承载，内容无缺口，缺的只是结构。以下两处**没有**在域 AC 直接覆盖，需人裁定是「明示不作退出条件」还是「另立 AC」：
> - 标题里的「**不跑真 CLI**」这一**否命题**：AC-124 / AC-126 只**蕴含**它（真 CLI 产不出场景指定的确定性内容，且帧只能来自真实归一化），没有任何 AC 直接读「本次运行没有拉起任何 CLI 子进程」。
> - 范围段第 2 条按**裁决 A** 的「UI 显示身份不得落穿为 Claude」：AC-123..128 无一条覆盖；它今天只是任务级判据。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「goals/GOAL-007 的退出条件小节 / 充分性文本修订」检索零命中。相邻但机制不同的是 GOAL-007 下的六条派工任务（`gap-debug-agent-gate-structural-off` = AC-123、`gap-debug-agent-engine-and-scenario-ops` = AC-124、`gap-debug-agent-external-write-path` = AC-125、`gap-debug-agent-no-second-vocabulary-guard` = AC-126、`gap-debug-agent-fixture-home-isolation` = AC-127、`gap-debug-agent-control-plane-http-auth` = AC-128）：它们各自实现**判据所测的机制**，本任务只修订**退出条件文本**，不写代码、不改那六条 AC 的 criterion，也不是它们的先行条件（本任务不解除任何 AC 的红）。

## AC

- [x] **AC1 退出条件小节落地**：`grep -c '^## 退出条件' goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md` 输出 **1**，且按 `goal-driver.ts` 的**同一条正则** `##[ \t]+(退出条件[ \t]*)\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)` 取出节体、去空白后字符数 **≥ 40**。命令逐行打印实际计数与字符数；不足时打印实际取到的节体，并以非 0 退出。
- [x] **AC2 人（yale）已裁定并被记录**：本任务的 `## Resolution` 小节写明 (i) 是否采纳本修订（采纳 / 改措辞 / 不采纳并另立 AC），以及 (ii) 两处无在域 AC 覆盖的范围项（「不跑真 CLI」否命题、裁决 A 的 UI 显示身份）各自的处理方式——**明示不作退出条件**，或**另立 AC 并给出任务 id**。二者缺一即本 AC 不满足。
- [x] **AC3 机械短路不再触发，且语义判官确被咨询**（2026-09-22 人裁定加固）：修订后`.quay/goal-round.jsonl` 中 GOAL-007 最新 `goal-sufficiency` 的 reason 必须**同时**满足三条——(a) verdict ∈ {`covered`, `insufficient`}（机械层 `goalSufficiencyVerdict()` 只可能返回 `insufficient` / `not-evaluated`，故 `covered` 只可能来自语义路径）；(b) reason 中**不含** `cause=`（语义判官不可用 / 超时 / 读不懂时产出 `sufficiency=not-evaluated（cause=judge-unavailable）…`，它同样『不是机械短路形态』，原措辞可被一次 spawn 失败冒充达标）；(c) **正面控制**——`sufficiencyCacheKey(goal, inScopeAcs)` 算出的键在 `.quay/goal-sufficiency-cache.json` 的 `entries` 中**存在**（只有真跑过判官才会写缓存；本任务立案时 GOAL-007 的键不在其中，19 条缓存无一属于它）。命令打印该 goal 的 `goal-sufficiency` 序列**最后两条**、上面三条的逐条读数，以及缓存键的命中与否。
- [x] **AC4 本任务未触及 Touches 之外的文件**：命令 `git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中 Touches 之外时逐行打印并以非 0 退出。用 merge-base 而非裸 develop——develop 会随他人 fan-in 前进。

## DoD

人工授权后，由**被授权的 goal 写入路径**（而非本 agent）真实修改 `goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md`：新增上面那节退出条件文本；并在其后的**真实 round log** 中观察到 GOAL-007 的 sufficiency verdict 不再恒为机械 insufficient（语义 judge 被实际咨询并给出结论）。**仅有文本改动而无后续 verdict 观察不算完成。**

承重性由三件事正面证明：

(a) **死锁的成因被指名，不是猜的**——`goal-driver.ts:866` 的短路在语义判定入口之前，且 `:858` 的注释逐字点名 GOAL-007；本提案据此说明为何 (a) 新增 AC 解不开、必须是 (b) 改文本（否则这份提案只是「照抄 GOAL-003」而说不出为什么）；
(b) **落地后 `hasExitConditions` 由 false 变 true**，verdict 越过短路落到 `not-evaluated` / 语义判定——AC3 要求在**真实轮日志**上读到这一变化，而不是在提交信息里声称；
(c) **两处欠账被写进小节并在人面前显式登记**（AC2），不被一份「退出条件 = 六条 AC 全列」的文本藏回去——否则语义 judge 只会给 covered，而欠账仍在。

另需如实登记：本任务**不**让 AC-123..128 中任何一条转绿（它们的 checker 与模块由那六条派工任务承担——`gap-debug-agent-gate-structural-off` 的验证记录显示其 checker 已存在并在 worktree 上跑过，但 AC-123 在 round 3395 的轮日志上仍为 `fail`）；本任务也不裁决两处欠账该不该另立 AC——**只要求裁定被写下**。

本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态，不把任何 AC 标 achieved / active / draft / retired。

## Resolution

**人（yale）2026-09-22 裁定：采纳本修订，并加固 AC3；两处欠账按「CLI 明示不作 + UI 另立 AC」处理。**

### (i) 是否采纳本修订：**采纳**

退出条件小节按提案文本落地，并另立一条目标级判据 AC-136（见下）。落地经**被授权的 goal 写入路径**完成，非本 agent 手改文件。

### (ii) 两处无在域 AC 覆盖的范围项，各自的处理方式

- **「不跑真 CLI」否命题 —— 明示不作独立退出条件。**
  依据：标题原文是「不跑真 CLI **也能**产出与历史一致的输出」，「也能」是**能力**断言而非禁令。该能力已由 AC-124 **正面**承载——判据要求逐条落盘**场景指定的确定性内容**并按 `expect.rows.delta` 核对行数，真 CLI 结构上产不出这些确定值；AC-126 再补上「调试模块不持有帧词表、帧只来自真实归一化」的静态半。若另立「本次运行未拉起任何 CLI 子进程」的判据，读的是**进程表**（机制），而不是「产出可复现」这一不变式——那是测机制而非测不变式。
- **范围段第 2 条按裁决 A 的「UI 显示身份不得落穿为 Claude」—— 另立目标级 AC。**
  任务 id：**`goals/AC-136-调试-agent-在-ui-上有明确显示身份-不落穿为-claude.md`**（无独立派工任务 id，见下）。
  判据：`npx vitest run src/shared/tests/debug-agent-display-identity.test.ts`，**红先行实测 exit=1**。
  理由：该承诺此前只作为**任务级**判据存在于 `gap-debug-agent-engine-and-scenario-ops` 的 AC4，会随该任务关闭而离开复验域（AC-216 记录的正是这一形态）；且其失败形态是**静默错标**——`LLMProviderLogo` 对未知 id 落穿到 claude 分支，客户端功能全绿，只有一个错误的 "Claude" 标签，没有判据就没人会看见。

### AC3 加固（本次裁定的附加项，非提案原文）

AC3 原措辞只要求「reason **不再是**纯机械短路形态，**而是**语义 judge 给出的 `covered` / `insufficient` 结论」。这个措辞有一个可被环境失败冒充的洞：语义路径**不可用**时驱动产出 `sufficiency=not-evaluated（cause=judge-unavailable）（在域 AC 6 条）`——它同样**不是**机械短路形态，于是一次 spawn 失败（判官根本没跑起来）即可让 AC3 看起来达标。已改为三条合取：(a) verdict ∈ {`covered`, `insufficient`}；(b) reason 不含 `cause=`；(c) **正面控制**——`sufficiencyCacheKey` 算出的键存在于 `.quay/goal-sufficiency-cache.json`（只有真跑过判官才会写缓存；本任务立案时 GOAL-007 的键**不在**那 19 条缓存里，这正是「判官从未被咨询」的独立证据）。AC3 正文已按此改写。

### AC-136 的派工任务：由 G9 缺口环立案（已实测发生）

本任务**不**为 AC-136 立派工任务。依据：一条新立的 active AC 零任务牵引正是 G9 缺口环的输入，按设计由该环立案。**该预测已兑现**：`tasks/gap-debug-agent-display-identity.md`（`goal_ac: AC-136`）已由该环立案（commit `45afebcc`，`cli:2686942`），并已被 promotion-driver 机械晋升 `todo→ready`（commit `a8cf6b1d`），无需人工介入。

## Evidence

**2026-09-22（主 checkout，分支 `author`）——落地读数**

- **落地路径（非手改）**：`quay goal write GOAL-007 --body <新正文>`，自提交 commit **`9c62a3e6`**「goals: GOAL-007 field:body by cli:2610190」。本 agent **未**编辑 `goals/*.md` 任何字节（`goals/` 下有活的写入者，手改会在数秒内被回滚）——全程走 CLI 的 goal 写入路径。
- **AC1**：`grep -c '^## 退出条件' goals/GOAL-007-…md` = **1**；用 goal-driver `extractSections(body,"退出条件")` 的**同一条正则**（`allowHeadingSuffix` 不开）取出节体、去空白后 **2136** 字符（判据要求 ≥ 40）。全文 `^## ` 标题 **4** 个（背景 / 范围 / 不做 / 退出条件），`## ` 出现次数 = 4 ⇒ 无行内小节名被解析器吃掉。
- **AC-136 创建**：commit **`4a59f0de`**「goals: AC-136 create by cli:2575475」，`status=active`（在域），`goal=GOAL-007`。红先行实测：`npx vitest run src/shared/tests/debug-agent-display-identity.test.ts` → **exit=1**（该测试文件不存在）。
- **AC3 —— 三条读数，均指向「语义判官已被实际咨询」**（判据的三项合取逐条满足）：
  1. **轮日志**：`.quay/goal-round.jsonl` 中 GOAL-007 的 `goal-sufficiency` 由 **round 3418**（`15:43:58Z`）的 `{"verdict":"insufficient"}` / reason `sufficiency=insufficient（在域 AC 6 条）` 变为 **round 3419**（`15:48:34Z`）的 `{"verdict":"covered"}` / reason `sufficiency=covered（在域 AC 7 条）`，**round 3420**（`15:49:33Z`）复现同一读数（稳定，非单轮抖动）。(a) verdict=`covered`——机械层 `goalSufficiencyVerdict()` 只可能返回 `insufficient` / `not-evaluated`，**`covered` 在语义路径之外不可达**；(b) reason 中**无** `cause=`（不是 `not-evaluated（cause=judge-unavailable）` 那类环境失败）；(c) 在域 AC 由 **6 条变 7 条**——新立的 AC-136 被计入，证明驱动读到的是**修订后**的记录集。
  2. **正面控制——缓存键**：`.quay/goal-sufficiency-cache.json` 由 **19 条增至 20 条**，新增项 `key=87a8dd74650fc97ca14f7b0c7c149d54b2df057c77ccfed7e36126391efee6c6`、`verdict="covered"`、`ts=2026-09-22T15:45:01.710Z`；而立案时 `.quay/goal-sufficiency-followup.json` 记下的 stall 实例键 `b3bd256d260b1b6bf191aeabe1c09351d8bb8dbb5965dfbd782251202595eb47` **已不在**缓存中。该键的定义（`goal-driver.ts:1140` 的 `sufficiencyCacheKey`）逐字含 `exit: exitConditionsText(body)`，故键变 ⟺ 退出条件节文本（或标题/范围节/AC 集合）变——正是本次修订。只有真跑过判官才会写这张缓存。
  3. **时间线**：body 写入 commit **`9c62a3e6`**（`2026-09-22T15:44:17Z`）→ 判官裁决写入缓存 **`15:45:01Z`**（+44s）→ 轮记录 **3419 / `15:48:34Z`**。该轮耗时明显长于前几轮（约 50s 一节），与「本轮真的 spawn 了一次语义判官」相符。
- **AC-136 的派工任务（实测）**：`tasks/gap-debug-agent-display-identity.md` 由 G9 缺口环自动立案（`goal_ac: AC-136`，commit `45afebcc`「task_write by cli:2686942」），并经 promotion-driver 机械晋升 `todo→ready`（commit `a8cf6b1d`）——「新立的 active AC 会自动获得任务牵引」这条预测已兑现，无需人工立案。
- **未做的一项（如实登记）**：提案与 GOAL-003 的证据都把缓存键**用驱动导出的 `sufficiencyCacheKey()` 原样复算**了一次。本次**未能复算**——本仓的 tsx 无法在插件 vendored bundle 之外加载 `plugin/scripts/goal-driver.ts`（先缺 `yaml` 解析，绕过后又在 module 图上抛 `TransformError`）。上述第 2 条因此是**基于键定义 + 键的消失/新生 + 在域 AC 数 6→7** 的推定，不是「复算出逐字节相同的键」那一种正面读数。**这一条弱于 GOAL-003 的证据强度，如实标注。**
- **AC4**：本次三个提交（`4a59f0de` / `9c62a3e6` / `a8b5a9c7`）触及的文件逐一为 `goals/AC-136-…md`（new）、`goals/GOAL-007-…md`、`tasks/gap-goal-007-exit-conditions-section.md`——**全部在 Touches 内**。⚠️ 判据原命令 `git diff --name-only "$(git merge-base develop HEAD)"` 在本仓**读数为空（退化）**：`author` 已被同步到与 `develop` 同一提交，merge-base == HEAD ⇒ 空集恒过，且会把并发他人的提交（同区间内 `tasks/gap-asr-paired-quality-experiment-record.md` 由另一进程写入）一并算进来。改用「逐提交列文件 + `git merge-base --is-ancestor` 确认三个提交都已进 develop」得到上面的有意义读数；三个提交均已确认是 develop 的祖先。
- **AC4（Touches 补记）**：Touches 已加入 `goals/AC-136-…md (new)`。它是本次裁定「另立 AC」实际写入的新文件，属本任务真实写入面，故必须登记——否则 AC4 会把它判为 Touches 之外的文件而红。

### 2026-09-22（worker 复核，worktree `task/gap-goal-007-exit-conditions-section`）—— 缓存键**已复算**，前述「推定」升级为逐字节正面读数

上文「未做的一项」记的是：本仓无法加载 `goal-driver.ts`，故 AC3(c) 的缓存键只能**推定**。本次复核**复算成功**，读数为逐字节相同：

- **可加载的产物是 dist bundle，不是 TS 源**：`/data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/scripts/dist/goal-driver.js` 可被 node 直接 `import`（99 个导出），其中 `sufficiencyCacheKey` / `inScopeAcsOf` / `listGoalRecords` 均在导出表内。上文失败的路径是加载 `plugin/scripts/goal-driver.ts` 源文件（缺 `yaml` / `TransformError`）——**换产物即可**，与 AC 无关。
- **复算取值**：`listGoalRecords(null, ROOT)`（`scriptRoot=null` 走 `resolveKernelPluginRoot()` 的 vendored CLI；传 repo root 会退化成 `quay-cli-unresolved` 而 exit 1）→ 取 `GOAL-007` 记录 → `inScopeAcsOf(records,'GOAL-007')` = **7 条**（AC-123…128 + AC-136）→ `sufficiencyCacheKey(goal, inScope)` = **`87a8dd74650fc97ca14f7b0c7c149d54b2df057c77ccfed7e36126391efee6c6`**。
- **命中**：该键**逐字节**等于缓存第 20 条（`.quay/goal-sufficiency-cache.json`，`{"verdict":"covered","ts":"2026-09-22T15:45:01.710Z"}`）。AC3(a)(b)(c) 三条合取**全部为真**（轮日志最后两条 round 3423/3424 均为 `verdict=covered`、reason `sufficiency=covered（在域 AC 7 条）`、不含 `cause=`）。
- ⇒ 上文那条「弱于 GOAL-003 的证据强度」的自我标注**不再适用**：AC3(c) 现在是正面控制（驱动自己的键函数复算命中），不是推定。

**未做（如实登记）**：本次复核**不**新增/修改任何 `goals/` 文件，**不**改任何 GOAL/AC 状态；AC-123…128 中仍有多条 `fail`（见 round 3420 的 `goal-ring`），本任务不让其中任何一条转绿。
## Touches

- goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md
- goals/AC-136-调试-agent-在-ui-上有明确显示身份-不落穿为-claude.md (new)
- tasks/gap-goal-007-exit-conditions-section.md
