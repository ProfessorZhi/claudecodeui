---
id: GOAL-007
title: 调试 Agent：不跑真 CLI 也能产出与历史一致的输出，且关闭态结构性不存在
status: achieved
kind: goal
origin: ADR-003 评审通过（人 yale，2026-09-22，见 adr/ADR-003-*.md 的 Adjudication 小节，含裁决
  A–E）。立此目标前已在 worktree 分支 proto/debug-agent-spike 上做过一次热修改实测：845 行模块 + 5 个既有 文件
  89 行改动，两条摄入路径均跑通，全程无真 CLI 进程；该分支是验证工装，不作为实现基础。与 GOAL-001/002/003/004
  同形：单元测试证伪不了"产出是否经由真实链路"，只有目标级判据能抓住。
activatedAt: 2026-09-22T15:00:09.559Z
statusLog:
  - at: 2026-09-22T15:00:09.559Z
    from: draft
    to: active
    actor: yale
    reason: 人 yale 指示激活（"激活该 goal"）。此前已按 ADR-003 评审通过（见该 ADR 的 Adjudication 小节，裁决
      A–E）立此目标，六条 AC-123…128 与六条对应派工任务已立。激活时现场复测六条判据的 criterion，全部
      exit=1（红先行成立）——它们引用的 checker 与模块今天都不存在。
  - at: 2026-09-22T16:36:07.635Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

排查 transcript 贴底/流式增量这类"输入输出形状"的问题时，今天没有可控的复现手段。能端到端产生一次真实输出的路径只有一条：拉起真 CLI 进程，让它按自己的节奏吐字——于是行什么时候出现、一次吐多少字节、中间隔多久，全都不可控、不可复现。

既有的浏览器侧替身（`e2e/transcript-follow.spec.ts` 的 `installWireDouble` / `__injectStreamFrame` / `startWireStream`）只替换了 `window.WebSocket`，注入的也只有 `stream_delta` / `stream_end`。它**完全跳过后端**：runtime、按 provider 的归一化、`seq` 与重放、`complete` 触发的 REST 重取、权限帧，都不在链路上。更关键的是，**被外部 CLI 写入、app 仅旁观的会话**（chokidar 观察 → `session_upserted` 广播 → 客户端 REST 重取整行）这条摄入路径**零 e2e 覆盖**。

一个只能在测试里被驱动的产出源，会在这些地方与真实 provider 分叉；而分叉了的调试工具，不能用来排查"实时与历史不一致"这一类缺陷——它自己就会制造这类不一致。

## 范围

让"不跑真 CLI 也能产生真实输出"成为一个**可装载场景、可推进时钟、可读自检结果**的能力，且产出必须与真实 provider 走同一条链路。范围即 ADR-003 的七条决策：

1. **两个面、一个引擎**：应用内一等公民的调试 Agent（能出现在会话列表、能被选中、能产生真实输出）+ dev-only 控制面（装载场景、推进时钟、读自检）；两面共用同一引擎与同一份场景文档，引擎实现在后端。
2. **运行期 provider id**：只加 registry 键 + 显式 id cast，**刻意不进 `LLMProvider` 联合**（联合是产品声明，进去要改约九处编译强制点外加约十处用户可见数组）。按裁决 A，UI 上必须给它**明确的显示身份**，不接受被落穿显示为 Claude。
3. **env 门控，默认关闭，且关就是结构性关**：按裁决 B 为**三面**（registry 无键、watcher 无根、路由未挂载）——capabilities 由闭集字面量天然免疫，不计入四面，也不为它增加门控耦合。
4. **必须写真实形态的 transcript**，且行→帧交给真实归一化；`complete` 触发的 REST 重取必须与实时所见一致。
5. **两条摄入路径都要能驱动**，含外部写入 → 观察者 → `session_upserted` → REST 重取这条零覆盖区。
6. **控制面走 HTTP + 既有 `authenticateToken`**，门控才是安全边界；不新增 WS 通道、不新增 CLI 脚本。
7. **禁止第二套事件词表**：调试模块只构造方言行，帧只来自 `normalizeMessage` / `createNormalizedMessage`。

判据以 AC 的 checker 读数表达，不以"模块存在"或"配置里出现了哪些行为标志"表达。

## 不做

- **不复现贴底漂移**。ADR-003 的"后续任务 7"经裁决 C 移出本范围：该缺陷今天已有两个占位者——`AC-106/108/111`（GOAL-004，均 `achieved`）与 `tasks/gap-transcript-follow-whole-row-append-drift`（`ready`，其判据已含"几何断言之外必须有内容/行数断言"与抗假变体）。再立一条即是同一缺陷的第三个工件。
- **不做多方言**。v1 只有 claude 一种方言，`dialect` 取值是闭集。
- **不给阈值**。几何/时间类数字由运行导出或写成区间。
- **不合并 `proto/debug-agent-spike`**。它是验证工装，含代码，会让 `gap-debug-agent-synthetic-provider-adr` 的"未产生任何代码"AC 与 DoD(c) 的空读数同时变假。

## 退出条件

标题的两个半句各自落到实处才算达成。

- **AC-123 关闭态结构性不存在（三面）**：门控在**进程启动时**求值，故判据在两个独立子进程里各取一次读数。关闭态逐一断言 registry 无键（按 id 解析失败**与拼错一个 id 逐字相同**）、watcher 无根（fixture 根不在观察路径集合里且该目录不被创建）、路由未挂载（控制面路径**不以控制面的应答作答**——**不得写成状态码 404**，本仓库 SPA catch-all 对无扩展名路径返回 `200 text/html`）；开启态三面对照存在；取值不认识、或开了但 fixture 根为空，一律按关闭处理并打印判定原因。
- **AC-124 不跑真 CLI 也能产出与历史一致的输出（产出侧）**：装载含 `row` 与 `grow` 两种 op 的场景后**走真实 runtime 产出帧**——transcript 真实落盘、行数与 `expect.rows.delta` 相符、文件含 `expect.content.mustContain` 每一条；`grow` 使行数不变、末行字节数增加、且归一化为**同一条**消息 id 的内容变化；socket 收到的帧 id 集与 REST 重取（`/api/providers/sessions/:id/messages`）历史的 id 集之交集**覆盖本次产出的每一条**；帧上的 `seq` 由 run registry 分配且严格递增。
- **AC-125 外部写入经真实文件观察者送达**：判据自带排空（先排掉装载那一次 `session_upserted`）、随后要求一条**新的** upsert、并以观察者自己的 `change event for provider "…"` 日志行作**正面控制**；外部追加的内容出现在 REST 重取结果里。
- **AC-126 禁止第二套词表**：调试模块源码范围内不出现任何帧字段名或事件名字面量，且该模块存在指向归一化入口（`normalizeMessage` / `createNormalizedMessage`）的**真实 import 语句**；守卫**可判真伪**——在调试模块里手写一个帧字面量必须让它红。
- **AC-127 fixture 根来自门控变量而非 `os.homedir()`**：产物只出现在门控根下、**不在** decoy HOME 下；**正面断言**真实 home 本次运行没有新增（修改时间 + 条目数双读数）；teardown 后整目录删除；清理顺序是**先让索引收敛、再删根**。
- **AC-128 控制面在门控开启时可用、缺凭据 401，且门控而非鉴权才是安全边界**：装载场景 / 推进时钟 / 读自检结果三个动作各自可达，「读自检结果」在无记录时给出**可辨的 404 而非空 200**；缺凭据 401、凭据有效但无权限 403，两者不混用；门控关闭时同一路径**不以控制面的应答作答**。
- **AC-136 调试 Agent 在 UI 上有明确显示身份（裁决 A）**：运行期 provider id 刻意不进 `LLMProvider` 联合，故 UI 侧没有编译期强制点，显示身份只能显式给出。对一处构造出的侧栏会话视图断言提供商文字位**非空且逐字不等于 "Claude"**，且 `LLMProviderLogo` 对该 id **不落穿**到末尾的 claude 分支；取下假形态（不给显示身份、保持落穿）时该判据必须红。
- **AC-123 至 AC-128、AC-136 全部 achieved**；或由人裁定放宽 / 取消其中任一条。

**两处范围项的处理（人 yale 2026-09-22 裁定，记录见 `tasks/gap-goal-007-exit-conditions-section.md` 的 Resolution 小节）**

- 标题里的「**不跑真 CLI**」这一否命题**明示不作独立退出条件**。原文是「不跑真 CLI **也能**产出与历史一致的输出」——「也能」是**能力**断言而非禁令。该能力已由 AC-124 正面承载（判据要求逐条落盘**场景指定的确定性内容**并按 `expect.rows.delta` 核对行数，真 CLI 结构上产不出这些确定值），AC-126 再补上「调试模块不持有帧词表、帧只来自真实归一化」的静态半。若另立「本次运行未拉起任何 CLI 子进程」的判据，读的是**进程表**（机制），而不是「产出可复现」这一不变式。
- 范围段第 2 条按**裁决 A** 的「UI 显示身份不得落穿为 Claude」**已另立目标级 AC-136**（上文已列）。原因是它此前只作为 `gap-debug-agent-engine-and-scenario-ops` 的**任务级**判据存在，会随该任务关闭而离开复验域（AC-216 记录的正是这一形态），且其失败形态是**静默错标**——客户端功能全绿，只有一个错误的标签。
