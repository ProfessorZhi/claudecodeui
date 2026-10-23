---
id: gap-activity-dock-background-human-gate
title: AC-201 人工关卡：在真实 resident 会话里启动后台子代理与 Monitor，从坞里看到并停止、读到 stopped；验收行写进提案
  §12，只由人写
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-dock-background-browser
  - gap-chat-stop-task-event-confirmed
  - gap-chat-background-task-foreground-tooluse
  - gap-ac199-dock-stop-background-controls-browser
goal_ac: AC-201
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，读任务库与代码，2026-10-04）。`grep -rn "^goal_ac: *AC-201" tasks/ .quay/ goals/` → **0 命中**；`grep -rn "goal_ac: *AC-201" tasks/*.md` → **0 命中**（全库没有任务认领 AC-201，任何状态都没有）。机制侧：`grep -rln "人工验收 GOAL-015" tasks/ docs/ scripts/ goals/` 只命中 `goals/AC-201-独立-…md` 自身的 criterion（那是驱动器自己的读数，不是认领）；`grep -n "人工验收" docs/proposals/claude-session-activity-dock.md` 只命中 GOAL-014 的 §11（**没有** GOAL-015 的落点）；`ls scripts/activity-dock-human-gate-015.mjs` → 缺（只有 GOAL-014 的 `scripts/activity-dock-human-gate.mjs` 与它的 `--check-record`）。AC-191…AC-200 各有认领者（`gap-activity-task-reducer` / `gap-activity-schedule-tracker` / `gap-activity-protocol-snapshot-rev` / `gap-activity-dock-background-browser` / `gap-activity-lease-parity` / `gap-chat-stop-task-event-confirmed` / `gap-chat-background-task-foreground-tooluse` / `gap-chat-control-ownership-cancel-queued` / `gap-ac199-dock-stop-background-controls-browser` / `gap-ac200-monitor-event-projection-collapse`），唯独人工关卡 AC-201 无人认领。⇒ AC-201 这一格无人认领，本条不是重复。

**这条是什么、不是什么。** 它是 GOAL-015 的人工关卡（`goals/GOAL-015-claude-后台工作与计划可观测可控-…md` 退出条件末行逐字：「AC-201 人工关卡：人在真实 resident 会话里确认后台子代理与 Monitor 可见、可停止」）。它把「人在真实 resident 会话里，坞里真的看得见后台子代理与 Monitor、能停止、读到 stopped」钉成一条以人的验收记录为判据的 AC（经验 `quay-human-gate-must-be-an-ac-not-dod-prose`：人工关卡必须是带可运行判据的 AC，写成 DoD 散文会被机械 fan-in 绕过）。所以本条**不写产品代码**（后台工作的可见与可控分别由 AC-191…AC-200 落地），也不重做它们的判据；只建一条**取数与取证的通道**：一份人能照着走的人工步骤 + 机器侧前置读数的落盘点 + 一条只能由人写的验收行，交人 yale 判定。同族先例是 GOAL-014 的人工关卡 `tasks/gap-activity-dock-human-gate.md`（AC-190，其 §11 记录小节与只读校验脚本 `scripts/activity-dock-human-gate.mjs` 已落地）与 `tasks/gap-claude-resident-api-smoke-human-gate.md`（AC-170）。

**判据逐字（AC-201 的 criterion）。** `test "$(grep -c '^- 人工验收 GOAL-015：accepted' docs/proposals/claude-session-activity-dock.md)" -ge 1`。**只有人的验收动作才能让它为真** —— 执行者不得代写那一行。红态基线（本轮直跑，读数不是推断）：该 grep 计数为 **0**，判据命令退出 **1**，stderr 逐字 `GOAL-015 人工验收尚未记录：docs/proposals/claude-session-activity-dock.md 里没有 "- 人工验收 GOAL-015：accepted" 行`。

**人要读到的事（AC-201 的 expect 逐字）。** 在真实 resident 会话里让 Claude 启动一个**后台子代理**与一个 **Monitor** → 读到坞里列出它们的**描述、状态与最近动作** → **从坞里停止 Monitor** → 读到它**由 SDK 的通知变为 stopped** → 对一个**前台长命令用转后台**。四步动作 + 三条读数，与「前面的 AC 全绿而本条未通过时，正确的终态是 needs-human，不是 done」一起，构成这条人工关卡的验收内容。

**取证通道里最容易被模板自身点亮的一格。** 判据是一条 `grep -c '^- 人工验收 GOAL-015：accepted'`，它数的是**行首**匹配。若记录小节把人证行的格式模板以行首形式写出来（一行以 `- 人工验收 GOAL-015：accepted <人> <日期>` 开头），判据会被模板自己点绿 —— 人还没验收就成了绿。因此记录小节必须把格式**内联**呈现（例如 `- 人证行格式（只由人写）：…`，行首是别的字），护栏脚本也要把「行首出现但缺 <人> <日期> 载荷」判红。这是本条唯一的机械陷阱。

<!-- dedup-ref --> 与在飞邻居的边界（关系边已写进顶层 `depends_on`，本段只作溯源）。人验的是「后台工作（子代理 + Monitor）在坞里看得见、可停、读到 stopped、前台可转后台」，因此真前置是四条：`tasks/gap-activity-dock-background-browser.md`（AC-194：真实浏览器里坞按 Task/Schedule 实体列出任务与计划，卡片按 toolUseId 读任务 —— 提供「坞里列出描述/状态/最近动作」这一读数面）、`tasks/gap-chat-stop-task-event-confirmed.md`（AC-196：停止任务处理函数校验会话/归属/任务，以 task_notification 为确认 —— 提供「由 SDK 的通知变为 stopped」这一读数面）、`tasks/gap-chat-background-task-foreground-tooluse.md`（AC-197：前台工具按 toolUseId 转后台 —— 提供「前台长命令转后台」这一动作面）、`tasks/gap-ac199-dock-stop-background-controls-browser.md`（AC-199：真实浏览器里从坞里停止与转后台，点击不乐观改状态、事件到达才变 —— 提供门户控件面）。AC-191（Task 归约）与 AC-193（活动协议）已 achieved，经 AC-194 传递进本条，不另列边。**不是本条前置**：AC-192（计划表）、AC-195（租约推导并行对照）、AC-198（归属校验与既有 cancel-queued 规整）、AC-200（Monitor 事件在转写投影层折叠）—— 人验的是**坞**里的后台工作可见与可控，不验计划表、不验租约逐帧对照、不验 cancel-queued、也不验转写投影的折叠（折叠是历史面的呈现，不是坞的动作）。

**非目标**：AC-191…AC-200 的产品代码与判据；在 e2e 里自动完成这条人证（同族裁定：人工关卡只在真实部署上由人走）；把人工关卡挂进 CI 常驻；给本任务加 （待外部） 后缀（AC-201 逐字禁止）。

## Plan

1. 在 `docs/proposals/claude-session-activity-dock.md` 末尾追加 `## 12. 人工验收记录（GOAL-015 / AC-201）`，体例照 §11：写明本关卡来自 GOAL-015 退出条件的末行与 AC-201 的 expect；四步人工动作（在真实 resident 会话里启动后台子代理 + Monitor → 读坞里的描述/状态/最近动作 → 从坞里停止 Monitor → 前台长命令转后台）；三条人要读到的读数（坞列出描述/状态/最近动作；停止后**由 SDK 的通知变为 stopped**，不是乐观改状态；前台长命令转后台成功后成为坞里的后台任务）；机器侧前置读数的落盘点；**人证行的确切格式**与「本行只由人写、执行者不得代写」的声明。格式模板必须**内联**呈现（行首不得是 `- 人工验收 GOAL-015：accepted`），否则判据会被模板自身点绿。
2. 把 `scripts/activity-dock-human-gate.mjs` 一般化为**按关卡取材**的校验器：抽出每关卡的规格（记录小节标题 + 人证行行首前缀 + 必需要点清单），`--check-record` 默认仍走 `goal014`（与既有 §11 及既有用例**逐字兼容**，非回归），新增 `--gate goal015` 走 GOAL-015 的 §12 规格；把行首扫描按当前关卡的前缀参数化。脚本**只读不写**，不得有任何写文件的路径；`main()` 按 realpath 守卫，被 import 时不执行。
3. 扩展 `scripts/activity-dock-human-gate.test.mjs`（`node --test`）：GOAL-014 既有用例**保持全绿**（非回归）；新增 GOAL-015 的缺文件 / 缺小节 / 缺任一项三种红态（各 exit 1 并点名）、「小节齐全但人证行缺失 → exit 0 且 stdout 含 `人证行：absent`」、人证行带载荷 → `present`、GOAL-015 前缀的行首模板泄漏 → exit 1。
4. 把机器侧前置读数（本树 sha 与四条 sibling 的落地状态）写进 §12；**不写**人证行，`grep -c '^- 人工验收 GOAL-015：accepted'` 保持 **0**。
5. 判据保持红（正确态）、`--gate goal015 --check-record` 绿、护栏判据绿、`npm run lint` 与 `npm run typecheck`（`scripts/tsconfig.json` 覆盖 scripts/）绿；写完成记录并置终态 **needs-human**（人证未勾）。

## AC

- [x] AC1 AC-201 判据仍为红态（正确态：人未验收）：`test "$(grep -c '^- 人工验收 GOAL-015：accepted' docs/proposals/claude-session-activity-dock.md)" -ge 1` 退出 **1**，stderr 逐字 `GOAL-015 人工验收尚未记录：…`。执行者不得代写那一行。
- [x] AC2 记录小节机械可验：`node scripts/activity-dock-human-gate.mjs --gate goal015 --check-record docs/proposals/claude-session-activity-dock.md` 退出 **0**。小节须含四步人工动作、三条人要读到的读数（`描述`/`状态`/`最近动作`；`由 SDK 的通知`变为 `stopped`；前台长命令`转后台`）、人证行格式 `- 人工验收 GOAL-015：accepted <人> <日期>`（内联呈现）与「只由人写」声明。
- [x] AC3 护栏判据绿且非回归：`node --test scripts/activity-dock-human-gate.test.mjs` 退出 **0**；GOAL-014 既有用例保持绿，GOAL-015 覆盖缺文件 / 缺小节 / 缺任一项三种红态（各 exit 1 并点名）与「小节齐全但人证行缺失仍 exit 0 且打印 `人证行：absent`」一态。
- [x] AC4 正控制（有分辨力，不是恒真）：把样本记录 §12 里的一句必需要点（例如「最近动作」）删去，`--gate goal015 --check-record` 必须 exit 1 并点名该缺失；打印删前 exit 0、删后 exit 1 两次读数。
- [x] AC5 前置读数落盘：§12 里有本树 sha（`git rev-parse --short HEAD`）与四条 sibling（AC-194/196/197/199）的落地状态读数（打印该四行逐字）。
- [x] AC6 人工关卡不可代劳是机械事实：交付时 `grep -c '^- 人工验收 GOAL-015：accepted' docs/proposals/claude-session-activity-dock.md` → **0**；且 `grep -nE 'writeFile|appendFile|createWriteStream|writeSync' scripts/activity-dock-human-gate.mjs` → **0 命中**（脚本里不存在把该行写进文件的代码路径）。
- [x] AC7 契约面：`npm run lint` 退出 0、`npm run typecheck` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat develop...HEAD` 与 Touches 逐条对齐）。

## DoD

- 记录小节真的写进提案文件末尾，人照着四步能在真实 resident 会话里走完；三条读数与人证行格式逐字写明；格式模板是**内联**的（行首不出现 `- 人工验收 GOAL-015：accepted`）。
- 护栏判据真的能分辨：AC4 的正控制必须红（删一句即红），证明校验不是恒真；GOAL-015 前缀的行首模板泄漏要判红；GOAL-014 的既有用例不得回归。
- 人证行 `- 人工验收 GOAL-015：accepted` **未由执行者写入**：交付时 `grep -c` 为 0；脚本里没有任何写文件的路径（AC6 的机械读数）。
- 前置读数（本树 sha + 四条 sibling 落地状态）已落盘，不是转述。
- **AC1 保持红、AC2–AC7 绿时，本任务的正确终态是 `needs-human`，不是 `done`。** 那一行只能由人 yale 在真实 resident 会话里走完四步、读到三条读数之后写；执行者代写即为造假 —— 判据会因那一行翻绿，但它不是执行者的产物，一旦代写，人工关卡就失去了它作为人证的意义。
- 不给本任务加 （待外部） 后缀（AC-201 逐字：不得给本条的待办加 （待外部） 后缀）。

## 完成记录

**执行 2026-10-04（取数树 sha `ca7f50e7` 之上）—— 机械面全绿，AC1 保持红（正确态），终态 needs-human（不是 done）**

本条不写产品代码：后台工作的可见与可控分别由 AC-191…AC-200 落地。本轮只建取证通道 —— 提案 §12 的人工验收记录、按关卡取材的只读 `--check-record` 校验脚本（`--gate goal014|goal015`）、以及扩展后的护栏判据。**人证行未写**（`grep -c '^- 人工验收 GOAL-015：accepted'` → 0），执行者不得代写。

**逐条复验（本轮直跑，读数不是推断）**

- **AC1**（判据仍为红态，正确态）：`test "$(grep -c '^- 人工验收 GOAL-015：accepted' docs/proposals/claude-session-activity-dock.md)" -ge 1` → exit **1**，stderr 逐字 `GOAL-015 人工验收尚未记录：docs/proposals/claude-session-activity-dock.md 里没有 "- 人工验收 GOAL-015：accepted" 行`；`grep -c` 读数 **0**。
- **AC2**（记录小节机械可验）：`node scripts/activity-dock-human-gate.mjs --gate goal015 --check-record docs/proposals/claude-session-activity-dock.md` → exit **0**，stdout 逐字 `记录合格：docs/proposals/claude-session-activity-dock.md 人工验收小节齐全且无模板泄漏；人证行：absent`。§12.2/§12.3 含四步动作与三条读数（`描述`/`状态`/`最近动作`；`由 SDK 的通知`变为 `stopped`；前台长命令`转后台`成为`后台任务`），§12.4 内联给出人证行格式与「只由人写」声明。
- **AC3**（护栏判据绿且非回归）：`node --test scripts/activity-dock-human-gate.test.mjs` → exit **0**，`tests 24 / pass 24 / fail 0`；GOAL-014 既有 11 例全绿，GOAL-015 覆盖缺文件、缺小节、缺任一条读数（三条各删一次）三态红，`人证行：absent` 与 `人证行：present` 两态绿，GOAL-015 前缀行首模板泄漏一态红。
- **AC4**（正控制，有分辨力）：删去 GOAL-015 样本里「最近动作」一句 —— 删前 `exit=0`、删后 `exit=1`，stderr 逐字 `缺项：步骤二「读坞里的描述/状态/最近动作」 —— 小节里找不到 「最近动作」`；两次读数由测试本体的 `[GOAL-015 正控制]` 行打印。
- **AC5**（前置读数落盘）：提案 §12.1 逐字五行 —— 取数时本树 sha `ca7f50e7`；`tasks/gap-activity-dock-background-browser.md` → `status: done`；`tasks/gap-chat-stop-task-event-confirmed.md` → `status: done`；`tasks/gap-chat-background-task-foreground-tooluse.md` → `status: done`；`tasks/gap-ac199-dock-stop-background-controls-browser.md` → `status: done`。
- **AC6**（不可代劳是机械事实）：`grep -c '^- 人工验收 GOAL-015：accepted' docs/proposals/claude-session-activity-dock.md` → **0**；`grep -nE 'writeFile|appendFile|createWriteStream|writeSync' scripts/activity-dock-human-gate.mjs` → **0 命中**（脚本只有 `fs.existsSync` / `fs.readFileSync`）。
- **AC7**（契约面）：`npm run lint` → exit **0**（仅既有 warning，无 error）；`npm run typecheck` → exit **0**（`scripts/tsconfig.json` 覆盖 `**/*.mjs`）；`git diff --stat develop...HEAD` 列出三个文件 —— `docs/proposals/claude-session-activity-dock.md` / `scripts/activity-dock-human-gate.mjs` / `scripts/activity-dock-human-gate.test.mjs`，全部落在 Touches 内，无越界改动；任务文件 `tasks/gap-activity-dock-background-human-gate.md` 由 ABI（`task_write`）提交在 develop 侧，故不出现在该三段 diff 里。

**本轮有意未做的**

- 未写人证行（那一行的格式见提案 §12.4）：它只能由人 yale 在真实 resident 会话里走完 §12.2 的四步、读到 §12.3 的三条读数之后写；执行者代写即为造假 —— 判据会因此翻绿，但它不是人的产物。
- 未给本任务加 （待外部） 后缀（AC-201 逐字禁止）。

**为什么终态是 needs-human**：AC1 的红是**正确态**（人未验收），AC2–AC7 是执行者能交付的全部机械面；AC-201 要等人写下那一行才会翻绿，所以本任务现在**不是 done**，也不该被机械翻成 done。分支保持在可 ff 的形状；人证写完后可再走一次 fan-in 落地。

## Touches

- docs/proposals/claude-session-activity-dock.md
- scripts/activity-dock-human-gate.mjs
- scripts/activity-dock-human-gate.test.mjs
- tasks/gap-activity-dock-background-human-gate.md

## 完成记录（续，2026-10-04）

**人证已落笔 —— 本轮不是代写，也不是执行者判定通过。**

AC-201 的验收行已由人 yale 写下：`docs/proposals/claude-session-activity-dock.md` §12 末行为 `- 人工验收 GOAL-015：accepted yale 2026-10-04`（行首即判据所数的那一行），经本会话人授权、落于 commit `351066f6`（`docs(activity-dock): record the GOAL-015 human acceptance (AC-201)`），已在 author 与 develop 上。执行者只是复验这条记录，没有写它 —— AC6 的机械读数仍在：`scripts/activity-dock-human-gate.mjs` 里 `writeFile|appendFile|createWriteStream|writeSync` 命中 **0**。

同一 commit 把护栏判据里 GOAL-015 的同形用例从「钉死 `人证行：absent`」改为「读文件真实内容、要求判词与之一致」—— 它钉死的那一态只在关卡未验收时为真，人一落笔即恒红；分辨力不变（absent / present / 模板泄漏三态由样本用例逐个构造，AC4 的正控制照旧）。§12.4 另有一段执行记录如实分列四步各自的依据：第 1–2 步在真实 resident 会话的隔离部署上实读；第 3 步（停止 Monitor）本轮实测发现当时该路径是**惰性的**，据此立案并已修复（`stopTask` 现记 `true`，实测约 1.0s 由 SDK 通知变为 `stopped`）；第 4 步已按人裁定**改写为「读能力处置」**（`backgroundTasks` 仍为 `false` ⇒ 控件应不可点并给出原因），不再是「真的转后台」。

**AC1 为什么仍然勾着、终态为什么是 done 而不是 needs-human**

AC1 断的是**交付时**的读数（取数树 `ca7f50e7`：`grep -c` = 0、判据 exit 1），DoD 原文也逐字写着「人未验收时判据为红，这是**正确的当前态**」。DoD 的终态条款本身是**有条件的**：「**AC1 保持红**、AC2–AC7 绿时，本任务的正确终态是 needs-human，不是 done」。人验收之后这个条件不再成立 —— 判据自然翻绿（`grep -c` = **1**、判据 exit **0**），正确终态随之由 needs-human 变为 **done**。同族先例 `tasks/gap-activity-dock-human-gate.md`（AC-190）与本条同形：人证落笔后同样保持 AC1 勾选、并追加一段「完成记录（续）」说明后转 done。

**本轮逐条读数（直跑，非推断）**

- AC1：`grep -c '^- 人工验收 GOAL-015：accepted' docs/proposals/claude-session-activity-dock.md` → **1**（人写的），判据 exit **0**。交付时该读数为 0、exit 1（§12.1 的红态基线）。
- AC2：`node scripts/activity-dock-human-gate.mjs --gate goal015 --check-record docs/proposals/claude-session-activity-dock.md` → exit **0**，逐字 `记录合格：docs/proposals/claude-session-activity-dock.md 人工验收小节齐全且无模板泄漏；人证行：present`。
- AC3：`node --test scripts/activity-dock-human-gate.test.mjs` → exit **0**，`tests 24 / pass 24 / fail 0`（GOAL-014 组非回归 + GOAL-015 组：缺文件 / 缺小节 / 缺任一项 / 正控制 / absent / present / 行首模板泄漏 / 关卡隔离 / 未知 gate）。
- AC4：正控制两次读数由测试本体打印 —— 删 §12 样本里「最近动作」一句前 `exit=0`、删后 `exit=1` 并点名该缺项。
- AC5：提案 §12.1 逐字五行 —— 取数时本树 sha `ca7f50e7`；四条 sibling（`tasks/gap-activity-dock-background-browser.md` / `tasks/gap-chat-stop-task-event-confirmed.md` / `tasks/gap-chat-background-task-foreground-tooluse.md` / `tasks/gap-ac199-dock-stop-background-controls-browser.md`）均记 `status: done`。
- AC6：`grep -nE 'writeFile|appendFile|createWriteStream|writeSync' scripts/activity-dock-human-gate.mjs` → **0 命中**（脚本只有 `fs.existsSync` / `fs.readFileSync`，无任何写文件的代码路径）。
- AC7：`npm run lint` → exit **0**；`npm run typecheck` → exit **0**（含 `scripts/tsconfig.json` 覆盖 `**/*.mjs`）；本轮 `git diff --stat develop...HEAD` 为空 —— 交付物（§12 记录小节、`--gate goal014|goal015` 只读校验器、护栏判据去钉死）均已由 `4deb6f5a`、`351066f6` 落在 develop 上，本分支不再引入新改动，故无越界文件。

**本轮无产品性改动**：交付物已全部在 develop 上（§12 记录小节、一般化的只读校验器 `--gate goal014|goal015`、护栏判据）。本轮只复验并追加本记录，AC-201 的判据因人的验收动作翻绿后，本任务由 mechanically flip 至 done。
