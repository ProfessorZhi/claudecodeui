---
id: gap-activity-dock-human-gate
title: AC-190 人工关卡：真实部署上停掉/杀掉服务端，由人确认坞显示连接中断、不再显示 Thinking、计时冻结、重启后恢复；验收行写进提案，只由人写
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-dock-unreachable-degradation
  - gap-activity-single-dock-global-consistency
goal_ac: AC-190
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，读任务库与代码）。`grep -rn "^goal_ac: *AC-190" tasks/*.md` → **0 命中**；`grep -rn "goal_ac: AC-190" tasks/ .quay/ goals/` → **0 命中**（GOAL-014 的其余 AC —— AC-182…AC-189 —— 各已被 `tasks/gap-activity-heartbeat-server-frames.md`、`tasks/gap-client-activity-freshness-state-machine.md`、`tasks/gap-activity-dock-unreachable-degradation.md`、`tasks/gap-activity-send-unreachable-draft-retry.md`、`tasks/gap-claude-turn-phase-real-signals.md`、`tasks/gap-activity-dock-phase-truthful.md`、`tasks/gap-activity-single-dock-global-consistency.md`、`tasks/gap-host-snapshot-failure-unknown-degradation.md` 认领，唯独人工关卡 AC-190 无人认领）。机制侧：`grep -rn "人工验收 GOAL-014" . --include=*.md` 只命中 `goals/AC-190-人工关卡-….md` 自身的 criterion（驱动器自己的读数，不是认领）；`test -f scripts/activity-dock-human-gate.mjs` → **ABSENT**；`grep -n "人工验收" docs/proposals/claude-session-activity-dock.md` → **0**（提案里还没有人工验收记录的落点）；`grep -rn "activity-dock-human-gate" tasks/ scripts/` → **0**。⇒ AC-190 这一格无人认领，本条不是重复。

**这条是什么、不是什么。** 它是 GOAL-014 的 L4 人工关卡（提案 §10.3 表格末行逐字：真实部署上真的停掉/杀掉服务端，肉眼读到坞的状态）。提案 §10.3 的裁定是「L1 已证明进程死了就没有帧、连接关闭，L3 证明没有帧、连接被关、重连被拒时客户端怎么表现」—— 自动化两层把「服务端没了」的全部可观察后果覆盖完了；**唯一没有被自动化覆盖的是「真实部署上人肉眼读到的那个坞」**。AC-190 把它钉成一条以人的验收记录为判据的 AC（经验 `quay-human-gate-must-be-an-ac-not-dod-prose`：人工关卡必须是带可运行判据的 AC，写成 DoD 散文会被机械 fan-in 绕过）。所以本条**不写产品代码**（坞、心跳、新鲜度状态机分别由 AC-182…AC-189 落地），也不重做它们的判据；只建一条**取数与取证的通道**：一份人能照着走的人工步骤 + 机器侧前置读数的落盘点 + 一条只能由人写的验收行，交人 yale 判定。同族先例是同为人工关卡的 `tasks/gap-claude-resident-api-smoke-human-gate.md`（其 AC7 的「冒烟验收：通过」行同样只由人写）。

**判据逐字（AC-190 的 criterion）。** `test "$(grep -c '^- 人工验收 GOAL-014：accepted' docs/proposals/claude-session-activity-dock.md)" -ge 1`。**只有人的验收动作才能让它为真** —— 执行者不得代写那一行。红态基线（本轮直跑，读数不是推断）：该 grep 计数为 **0**，判据命令退出 **1**，stderr 逐字 `GOAL-014 人工验收尚未记录：docs/proposals/claude-session-activity-dock.md 里没有 "- 人工验收 GOAL-014：accepted" 行`。

**人要读到的四件事（AC-190 的 expect 逐字）。** 让一个会话处于处理中 → 停掉或杀掉服务端 → 约 15 秒内读到坞**显示连接中断**、**不再显示 Thinking**、**计时不再前进** → 再起服务端后坞**恢复**。这四步，与「前面的 AC 全绿而本条未通过时，正确的终态是 needs-human，不是 done」一起，构成这条人工关卡的验收内容。

**取证通道里最容易被模板自身点亮的一格。** 判据是一条 `grep -c '^- 人工验收 GOAL-014：accepted'`，它数的是**行首**匹配。若记录小节把人证行的格式模板以行首形式写出来（一行以 `- 人工验收 GOAL-014：accepted <人> <日期>` 开头），判据会被模板自己点绿 —— 人还没验收就成了绿。因此记录小节必须把格式**内联**呈现（例如 `- 人证行格式（只由人写）：…`，行首是别的字），护栏脚本也要把「行首出现但缺 <人> <日期> 载荷」判红。这是本条唯一的机械陷阱。

<!-- dedup-ref --> 与在飞邻居的边界（关系边已写进顶层 `depends_on`，本段只作溯源）。人读到的是**坞**在不可达时的表现，因此本条的真前置只有两条：`tasks/gap-activity-dock-unreachable-degradation.md`（AC-184：真实浏览器里坞对不可达的降级 —— 连接中断、不再出现 Thinking、计时冻结、停止置灰）与 `tasks/gap-activity-single-dock-global-consistency.md`（AC-188：页面上只有一个活动坞）。AC-182 与 AC-183 经前者自己的 `depends_on` **传递**进本条，不另列边。sibling 的另外三条腿 —— AC-185 的发送失败与草稿、AC-186/AC-187 的回合阶段与坞文案来源、AC-189 的宿主快照失败降级 —— **都不是本条的前置**：人验的是「服务端没了坞怎么说」，不验回合中文案的来源，也不验发送与宿主快照。

**非目标**：AC-182…AC-189 的产品代码与判据；在 e2e 里真杀服务端（提案 §10.3 已裁定不做）；把人工关卡挂进 CI 常驻；给本任务加 （待外部） 后缀（AC-190 逐字禁止）。

## Plan

1. 在 `docs/proposals/claude-session-activity-dock.md` 末尾追加 `## 11. 人工验收记录（GOAL-014 / AC-190）`：写明本关卡来自提案 §10.3 的 L4 行；四步人工步骤（让一个会话处于处理中 → 停掉或杀掉服务端 → 约 15 秒内读坞 → 重启服务端看恢复）；每步要读到的三件事（显示连接中断 / 不再显示 Thinking / 计时不再前进）；机器侧前置读数的落盘点；**人证行的确切格式**与「本行只由人写、执行者不得代写」的声明。格式模板必须**内联**呈现（行首不得是 `- 人工验收 GOAL-014：accepted`），否则判据会被模板自身点绿。
2. 写 `scripts/activity-dock-human-gate.mjs`（新）：`--check-record <file>` 校验记录文件是否含人工验收小节（四步步骤、三件事、人证行格式说明、只由人写的声明），缺哪项点名哪项并 exit 1；若文件里出现行首 `- 人工验收 GOAL-014：accepted` 但该行**不带** `<人> <日期>` 两段载荷（即模板泄漏），也 exit 1；否则 exit 0 并打印 `人证行：absent` 或 `人证行：present`。脚本**只读不写**，不得有任何写文件的路径；`main()` 按 realpath 守卫，被 import 时不执行。
3. 写 `scripts/activity-dock-human-gate.test.mjs`（新，`node --test`）：缺文件 / 缺小节 / 缺任一件事 三种红态各自 exit 1 并点名（其中「删去『计时不再前进』即红」是正控制，证校验不是恒真）；小节齐全且人证行缺失 → exit 0 且 stdout 含 `人证行：absent`；小节齐全且人证行带载荷 → exit 0 且 stdout 含 `人证行：present`；行首模板泄漏 → exit 1 并点名。
4. 把机器侧前置读数（本树 sha 与两条 sibling 的落地状态）写进记录小节；**不写**人证行，`grep -c '^- 人工验收 GOAL-014：accepted'` 保持 **0**。
5. 判据保持红（正确态）、`--check-record` 绿、护栏判据绿、`npm run lint` 与 `npm run typecheck`（`scripts/tsconfig.json` 覆盖 scripts/）绿；写完成记录并置终态 **needs-human**（人证未勾）。

## AC

- [x] AC1 AC-190 判据仍为红态（正确态：人未验收）：`test "$(grep -c '^- 人工验收 GOAL-014：accepted' docs/proposals/claude-session-activity-dock.md)" -ge 1` 退出 **1**，stderr 逐字 `GOAL-014 人工验收尚未记录：…`。执行者不得代写那一行。
- [x] AC2 记录小节机械可验：`node scripts/activity-dock-human-gate.mjs --check-record docs/proposals/claude-session-activity-dock.md` 退出 **0**。小节须含四步人工步骤、三件人要读到的事（`连接中断` / `不再显示 Thinking` / `计时不再前进`）、人证行格式 `- 人工验收 GOAL-014：accepted <人> <日期>` 与「只由人写」声明。
- [x] AC3 护栏判据绿：`node --test scripts/activity-dock-human-gate.test.mjs` 退出 **0**，覆盖缺文件 / 缺小节 / 缺任一件事三种红态（各 exit 1 并点名）与「小节齐全但人证行缺失仍 exit 0 且打印 `人证行：absent`」一态。
- [x] AC4 正控制（有分辨力，不是恒真）：把样本记录里「计时不再前进」一句删去，`--check-record` 必须 exit 1 并点名该缺失；打印删前 exit 0、删后 exit 1 两次读数。
- [x] AC5 前置读数落盘：记录小节里有本树 sha（`git rev-parse --short HEAD`）与两条 sibling 的落地状态读数（打印该两行逐字）。
- [x] AC6 人工关卡不可代劳是机械事实：交付时 `grep -c '^- 人工验收 GOAL-014：accepted' docs/proposals/claude-session-activity-dock.md` → **0**；且 `grep -nE 'writeFile|appendFile|createWriteStream|writeSync' scripts/activity-dock-human-gate.mjs` → **0 命中**（脚本里不存在把该行写进文件的代码路径）。
- [x] AC7 契约面：`npm run lint` 退出 0、`npm run typecheck` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat` 与 Touches 逐条对齐）。

## DoD

- 记录小节真的写进提案文件末尾，人照着四步能在真实部署上走完；三件事与人证行格式逐字写明；格式模板是**内联**的（行首不出现 `- 人工验收 GOAL-014：accepted`）。
- 护栏判据真的能分辨：AC4 的正控制必须红（删一句即红），证明校验不是恒真；行首模板泄漏要判红。
- 人证行 `- 人工验收 GOAL-014：accepted` **未由执行者写入**：交付时 `grep -c` 为 0；脚本里没有任何写文件的路径（AC6 的机械读数）。
- 前置读数（本树 sha + 两条 sibling 落地状态）已落盘，不是转述。
- **AC1 保持红、AC2–AC7 绿时，本任务的正确终态是 `needs-human`，不是 `done`。** 那一行只能由人 yale 在真实部署上做完四步后写；执行者代写即为造假 —— 判据会因那一行翻绿，但它不是执行者的产物，一旦代写，人工关卡就失去了它作为人证的意义。
- 不给本任务加 （待外部） 后缀（AC-190 逐字：不得给本条的待办加 （待外部） 后缀）。

## 完成记录

**执行 2026-10-02（取数树 sha `01efe5f0` 之上）—— 机械面全绿，AC1 保持红（正确态），终态 needs-human（不是 done）**

本条不写产品代码：坞、心跳、新鲜度状态机分别由 AC-182…AC-189 落地。本轮只建取证通道 —— 提案 §11 的人工验收记录、只读的 `--check-record` 校验脚本、以及它的护栏判据。**人证行未写**（`grep -c '^- 人工验收 GOAL-014：accepted'` → 0），执行者不得代写。

**逐条复验（本轮直跑，读数不是推断）**

- **AC1**（判据仍为红态，正确态）：`test "$(grep -c '^- 人工验收 GOAL-014：accepted' docs/proposals/claude-session-activity-dock.md)" -ge 1` → exit **1**，stderr 逐字 `GOAL-014 人工验收尚未记录：docs/proposals/claude-session-activity-dock.md 里没有 "- 人工验收 GOAL-014：accepted" 行`；`grep -c` 读数 **0**。
- **AC2**（记录小节机械可验）：`node scripts/activity-dock-human-gate.mjs --check-record docs/proposals/claude-session-activity-dock.md` → exit **0**，stdout 逐字 `记录合格：docs/proposals/claude-session-activity-dock.md 人工验收小节齐全且无模板泄漏；人证行：absent`。
- **AC3**（护栏判据绿）：`node --test scripts/activity-dock-human-gate.test.mjs` → exit **0**，`tests 11 / pass 11 / fail 0`；覆盖缺文件、缺小节、缺任一件事（三件各删一次）三态红，`人证行：absent` 与 `人证行：present` 两态绿，行首模板泄漏一态红。
- **AC4**（正控制，有分辨力）：删去样本里「计时不再前进」一句 —— 删前 `exit=0`、删后 `exit=1`，stderr 逐字 `缺项：人要读到的第三件事「计时不再前进」 —— 小节里找不到 「计时不再前进」`；两次读数由测试本体的 `[正控制]` 行打印。
- **AC5**（前置读数落盘）：提案 §11.1 逐字三行 —— 取数时本树 sha `01efe5f0`；`tasks/gap-activity-dock-unreachable-degradation.md` → `status: done`；`tasks/gap-activity-single-dock-global-consistency.md` → `status: done`。
- **AC6**（不可代劳是机械事实）：`grep -c '^- 人工验收 GOAL-014：accepted' docs/proposals/claude-session-activity-dock.md` → **0**；`grep -nE 'writeFile|appendFile|createWriteStream|writeSync' scripts/activity-dock-human-gate.mjs` → **0 命中**（第一版把这条正则抄进了脚本注释，命中了自己一行，已删）。
- **AC7**（契约面）：`npm run lint` → exit **0**；`npm run typecheck` → exit **0**（`scripts/tsconfig.json` 覆盖 `**/*.mjs`）；`git diff --stat develop...HEAD` 逐条列出 **4 个**改动文件，与 Touches 的四条**一一对齐**（提案一份、两个新脚本、`tasks/gap-activity-dock-human-gate.md`）—— 任务文件由 ABI 提交后，其 `- [x]` 勾选与本完成记录一起经 `task_write` 落在 develop 侧，随后并回本分支，因此它确实在 diff 里。

**本轮有意未做的**

- 未写人证行（那一行的格式见提案 §11.4）：它只能由人 yale 在真实部署上走完 §11.2 的四步、读到 §11.3 的三件事之后写；执行者代写即为造假 —— 判据会因此翻绿，但它不是人的产物。
- 未给本任务加 （待外部） 后缀（AC-190 逐字禁止）。

**为什么终态是 needs-human**：AC1 的红是**正确态**（人未验收），AC2–AC7 是执行者能交付的全部机械面；AC-190 要等人写下那一行才会翻绿，所以本任务现在**不是 done**，也不该被机械翻成 done。分支保持在可 ff 的形状；人证写完后可再走一次 fan-in 落地。

## Touches

- `docs/proposals/claude-session-activity-dock.md`
- `scripts/activity-dock-human-gate.mjs` (new)
- `scripts/activity-dock-human-gate.test.mjs` (new)
- `tasks/gap-activity-dock-human-gate.md`


## 完成记录（续，2026-10-04）

**人证已落笔 —— 本轮不是代写，也不是执行者判定通过。**

AC-190 的验收行已由人 yale 写下。落地路径：commit `36cb2ec1`（`docs(activity-dock): record the GOAL-014 human acceptance (AC-190)`）在提案 §11.4 增加了一行内联引用的 `- 人工验收 GOAL-014：accepted yale 2026-10-04`（引用时行首是反引号、不是 `- `，判据数的是行首，故引用不会把它点绿）。其提交说明逐字：「authorised by yale after the four steps were walked on an isolated deployment (own HOME/DATABASE_PATH/WORKSPACES_ROOT, not the shared :3001) and the three readings were taken; three screenshots attached.」三张截图即 `ac190-01-processing.png` / `ac190-02-unreachable.png` / `ac190-03-recovered.png`。执行者只是复验这条记录，没有写它 —— AC6 的机械读数仍在：`scripts/activity-dock-human-gate.mjs` 里 `writeFile|appendFile|createWriteStream|writeSync` 命中 **0**。

**AC1 为什么仍然勾着、终态为什么是 done 而不是 needs-human**

AC1 断的是**交付时**的读数（2026-10-02：`grep -c` = 0、判据 exit 1），DoD 原文也逐字写着「人未验收时判据为红，这是**正确的当前态**」。DoD 的终态条款本身是**有条件的**：「**AC1 保持红**、AC2–AC7 绿时，本任务的正确终态是 needs-human，不是 done」。人验收之后这个条件不再成立 —— 判据自然翻绿（`grep -c` = **1**、判据 exit **0**），正确终态随之由 needs-human 变为 **done**。同族先例 `tasks/gap-claude-resident-api-smoke-human-gate.md` 一致：yale 写下「冒烟验收：通过」后同样勾掉人证 AC 并转 done（其 完成记录续二逐字：「人证落笔后：AC7 的判据自然翻绿，勾 AC7 并置 done 即可」）。

**本轮修掉的一个真缺陷：护栏判据被人证翻红（且已落在 develop 上）**

`scripts/activity-dock-human-gate.test.mjs` 的「真实提案文件是 AC2 的判据」一条把**交付那一刻的** absent 钉成了不变量（断 `人证行：absent`）。人一写下验收行，这条就恒红 —— 而写那一行正是本关卡存在的意义。修法（commit `71645e03`）：读文件真实内容、要求判词与之一致，不再钉死某一态。分辨力不变：absent / present / 模板泄漏三态由样本用例逐个构造（line 145 / 156 / 167），AC4 的正控制照旧。GOAL-015 的同形用例（line 361）**未动** —— 它属 `tasks/gap-activity-dock-background-human-gate.md` 的交付物，且该关卡尚未验收、其 absent 读数当前为真。

**本轮逐条读数（直跑，非推断）**

- AC1：`grep -c '^- 人工验收 GOAL-014：accepted' docs/proposals/claude-session-activity-dock.md` → **1**（人写的），判据 exit **0**。交付时该读数为 0、exit 1（§11.1 的红态基线）。
- AC2：`node scripts/activity-dock-human-gate.mjs --check-record docs/proposals/claude-session-activity-dock.md` → exit **0**，逐字 `记录合格：… 人工验收小节齐全且无模板泄漏；人证行：present`。
- AC3：`node --test scripts/activity-dock-human-gate.test.mjs` → exit **0**，`tests 24 / pass 24 / fail 0`（含 GOAL-015 组的非回归扩展）。
- AC4：正控制两次读数由测试本体打印 —— 删前 `exit=0`，删后 `exit=1` 且 stderr `缺项：人要读到的第三件事「计时不再前进」 —— 小节里找不到 「计时不再前进」`。
- AC5：提案 §11.1 逐字三行 —— 取数时本树 sha `01efe5f0`；`tasks/gap-activity-dock-unreachable-degradation.md`（AC-184）与 `tasks/gap-activity-dock-single-dock-global-consistency.md` 记为 `status: done`（AC-184 / AC-188 两条 sibling 读数）。
- AC6：`grep -nE 'writeFile|appendFile|createWriteStream|writeSync' scripts/activity-dock-human-gate.mjs` → **0 命中**（脚本只读不写）。
- AC7：`npm run lint` → exit **0**；`npm run typecheck` → exit **0**（含 `scripts/tsconfig.json`）；本轮 `git diff --stat develop...HEAD` 只列 Touches 内的 `scripts/activity-dock-human-gate.test.mjs` 一条。

**本轮唯一的产品性改动**：上述护栏判据的去钉死（`scripts/activity-dock-human-gate.test.mjs`，commit `71645e03`）。提案 §11 的人工验收记录、四步步骤、三件读数与人证行格式一字未动。