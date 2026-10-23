---
id: gap-ac276-mcp-resident-smoke-record
title: AC-276 常驻专有能力冒烟记录齐全：scripts/mcp-smoke.mjs 追加 --check-resident-record +
  docs/proposals/cloudcli-mcp-resident-smoke.md 八节逐节非空；缺节必红、撤回节 pid 前后不同必红；不点亮
  AC-277
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac249-session-send-immediate-runid
  - gap-ac250-session-create-interrupt-lifecycle
  - gap-ac256-mcp-nested-smoke-record
  - gap-ac271-mcp-session-cancel-queued
  - gap-ac272-mcp-session-reconfigure
  - gap-ac273-mcp-session-background
  - gap-ac274-mcp-approvals
goal_ac: AC-276
---
## Proposal

**来源与判据物。** AC-276（`goals/AC-276-常驻专有能力冒烟的记录齐全-独立实例上经-mcp-对真实常驻会话做排队-撤回-重配置-后台任务与审批-每节有原始读数.md` 的 `criterion:`）逐字：

```
for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-resident-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md
```

`expect` 逐字要点：做法照 GOAL-020 的嵌套冒烟（AC-256）——独立实例、真实 Claude CLI、终端 Claude Code 经 PAT 连接。记录逐节齐全，每节有「读数：」与「结论：」，八节为：环境与版本；常驻会话启动与 pid；忙时发送得到 `queuedMessageUuid`；撤回得到 `cancelled` 且 pid 不变；`session_reconfigure` 下一轮生效；`session_background` 列出与停止；审批（在非 bypass 权限模式下由一个需要权限的工具触发，经 `approvals_list` 看到、`approval_answer` 解除）；收尾残留与生产 3001 监听 pid 不变。`--check-resident-record` 逐节检查并点名缺哪节。本判据只证明读数齐全，验收结论由 AC-277 人工关卡给出。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 删掉任一节 ⇒ 必须红并点名；(ii) 撤回一节里 pid 前后不同 ⇒ 必须红。

**红态基线（本轮实测，读数不是推断）。** `ls scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-resident-smoke.md` 两个都不存在；判据的存在性闸以退出码 **1** 逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`（存在性闸按 `for` 顺序，第一个缺失即停）。⇒ 本条当前必红，且红只因缺文件。

**这条是什么、不是什么。** 它是 GOAL-022 常驻专有能力的嵌套冒烟**取数与取证通道**：不写产品代码（MCP 工具由 AC-271–AC-274 落地），只在 AC-256 已交付的 `scripts/mcp-smoke.mjs` 上**追加** `--check-resident-record` 模式 + 一个把八段真跑一遍、把**原始读数**落盘的真记录，交人 yale 判定（判定行由 AC-277 收）。它**不**重复 AC-256 的 `--check-record`（那是 GOAL-020 八节的机械检查，节集合不同、记录文件不同）。

**八节与机械检查（本任务定义）。** `RESIDENT_SECTION_TITLES` 八节逐字：`环境与版本` / `常驻会话启动与 pid` / `忙时发送` / `撤回与 pid 不变` / `重配置下一轮生效` / `后台任务列出与停止` / `审批` / `收尾残留与生产监听 pid`。

`--check-resident-record` 的三件机械检查（本任务自己定义、并被自己的单测覆盖）：(a) 八节逐节要求非空 `读数：` 与 `结论：` 两行，缺整节点名该节、缺行点名该节缺哪行；(b) 第 4 节 `撤回与 pid 不变` 的 `读数：` 行必须含 `pid-before=<n>` 与 `pid-after=<n>` 且二者相等，解析不到或不等即红并点名（这正是假形态 (ii)）；(c) 文件不存在时把八节点名全缺。

**取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令；恢复后重跑回绿）：** (i) 删掉记录里任一节（例如 `审批`）⇒ `--check-resident-record` 必须红并点名该节；(ii) 把第 4 节的 `pid-after=` 改成与 `pid-before=` 不同的值 ⇒ 必须红并点名 pid 不等。

**两个必须钉住的边界。** 其一，**不得点亮下一条判据**：AC-277 的判据是 `grep -q '^常驻专有能力验收：通过' docs/proposals/cloudcli-mcp-resident-smoke.md`，因此记录文件表头、八节正文与脚本输出里都不得出现以 `常驻专有能力验收：通过` 开头的一行——本任务的记录只写「读数：」与「结论：」，人证行由人 yale 在 AC-277 写。其二，**不重写 `--check-record`**：`--check-resident-record` 与 `--check-record` 并存，两个节集合常量分开，不改 AC-256 的 `--check-record` 行为与它的记录文件 `docs/proposals/cloudcli-mcp-smoke.md`。

机械前置：本条要在**已落地的 MCP 网关与常驻工具**上取读数——先要 AC-256 交付 `scripts/mcp-smoke.mjs` 骨架与「临时实例 + PAT 播种 + `claude mcp add`」驱动面；「常驻会话启动」要 AC-250 的 `session_create`；「忙时发送」要 AC-249 的 `session_send`；「撤回」要 AC-271 的 `session_cancel_queued`；「重配置」要 AC-272 的 `session_reconfigure`；「后台任务」要 AC-273 的 `session_background`；「审批」要 AC-274 的 `approvals_list` / `approval_answer`。任一未落地时脚本必须**点名拒绝**（缺哪件说哪件），不写假的读数行。

<!-- dedup-ref --> 机制上去重已核对：`grep -rl "goal_ac: AC-276" tasks/` 为空——本仓库无任何任务带 `goal_ac: AC-276`；`grep -rln "AC-276" tasks/` 也为空（无人认领、无人越界声明）。相关但不同：AC-256（`gap-ac256-mcp-nested-smoke-record`，GOAL-020）交付 `scripts/mcp-smoke.mjs` 与 `--check-record`，记录 `docs/proposals/cloudcli-mcp-smoke.md`；本条在**同一脚本**上追加 `--check-resident-record`，记录到**不同文件** `docs/proposals/cloudcli-mcp-resident-smoke.md`，节集合是常驻专有能力（启动/忙发/撤回/重配置/后台/审批/收尾），与 AC-256 的「列出会话/发消息/查进度/中止」不同。AC-277（人工关卡，判据是记录文件里的人证行）是不同机制。先例 `scripts/resident-smoke.mjs`（AC-170）是被照抄的**骨架**而非认领者：它驱动的是常驻会话的 HTTP/WS 面，判据文件与记录都不同。相关但非本任务前置（仅溯源）：AC-241（PAT 认证）与 AC-245（只读工具）由 AC-256 传递依赖；AC-275（真实 claude 二进制经控制服务撤回）是本条「真实常驻会话撤回」的驱动层对照，不是本条要交付或复用的产物。

**非目标**：AC-256 的 `--check-record` 与其记录；AC-271–AC-275 的产品代码（网关/工具/审批）；AC-277 的**人证行**（只能由人 yale 写，执行者不得代写）；把冒烟挂进 CI 常驻（真模型有费用，只作一次性人证读数）；对生产 3001 做任何事（不连接、不启用、不重启）。

## Plan

1. 读 AC-256 落地后的 `scripts/mcp-smoke.mjs` **实际形状**：`SECTION_TITLES` / `extractSection` / `upsertSection` / `checkRecordText` / `parsePort` / `main(argv)` / realpath 守卫，以及 `main` 里按 `argv` 分派 `--check-record` 的位置；护栏（临时 `DATABASE_PATH`、`listen(0)` 端口、`detached` 整组杀）与「真服务实例 + PAT 播种 + `claude mcp add` + 自然语言驱动 + 记录写入」的复用点。把 `--check-resident-record` 的接缝钉在真面上，不按 AC-256 的规划文字猜；缺面时**点名拒绝**。
2. 读 AC-271–AC-275 落地后的**实际工具形状**：`session_cancel_queued` 返回 `queuedMessageUuid` 的来源与 `cancelled`/`already-started`/`unknown` 的说法；`session_reconfigure` 的模型/强度/权限模式「下一轮生效」读数面；`session_background` 的 `stopTaskId` 列出与停止读数面；`approvals_list` / `approval_answer` 的待审批读法与回答语义；常驻会话 pid 的读取面（宿主快照 `pid`/`running`）。缺面时**点名拒绝**。
3. 在 `scripts/mcp-smoke.mjs` 追加：`RESIDENT_SECTION_TITLES`（八节逐字）；`parseResidentSection` / `parseCancelPids` / `checkResidentRecordText` / `checkResidentRecordFile`；`main` 增加 `--check-resident-record <file>` 分派（纯读，不起实例）。机械检查三件照 Proposal 的 (a)(b)(c)。保持 `--check-record` 行为不变。
4. 追加真跑：在 AC-256 的临时实例/`claude mcp add` 驱动面上，用真 `claude` CLI + 自然语言驱动走完八段——常驻会话启动（记 `pid=`）、忙时发送（记 `queuedMessageUuid=`）、撤回（记 `pid-before=` 与 `pid-after=`，两者相等）、重配置（记下一轮生效读数）、后台任务（列出与停止）、审批（非 bypass 模式 + 需权限工具触发，`approvals_list` 看到、`approval_answer` 解除）、收尾残留（进程/目录/scope 命中数 0，`:3001` 起终点监听 pid 逐字相同）。八段各自 `upsertResidentSection()` 落盘 `读数：` / `结论：`；**不写**任何以 `常驻专有能力验收：通过` 开头的行。
5. 写单测 `scripts/mcp-smoke-resident.test.mjs`（新）：对 `checkResidentRecordText` 覆盖（a）缺整节点名该节、（b）缺 `读数：`/`结论：` 行点名、（c）读数为空点红、（d）撤回节 `pid-after` ≠ `pid-before` 点红（假形态 (ii) 的机械版）、（e）解析不到 pid 点红、（f）八节齐全 exit 0、（g）文件不存在八节全缺。承重腿是「缺一节就红」与「撤回节 pid 不等就红」——先写红测再补实现。子进程断言 stderr 时直接读 `spawnSync` 返回的 `result.stderr`（内存 `node-test-stderr-does-not-reach-the-caller`）。
6. `node --test scripts/mcp-smoke-resident.test.mjs` 与 `--check-resident-record` 绿；对新/改文件跑 `npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke-resident.test.mjs` 退出 0；**并且**要求 `npm run typecheck` 退出 0。⛔ 原文此条写的是「**不**要求 `npm run typecheck` 退出 0（`scripts/tsconfig.json` 的 `allowJs + checkJs` 在 `scripts/*.mjs` 上的红是 develop 侧既有）」——该理由经本任务实测为**假**（develop 上 `npm run typecheck` 退出 **0**），且正是它让前两轮把本任务自己引入的类型错当成环境问题；见 `## Evidence`。写完成记录（含每条读数与两次假形态的红）。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 AC-276 判据命令，存在性闸退出码 **1** 并逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`（写下完整命令与完整输出）。
  - 完整命令（在改动前的干净树 `/tmp/ac276-base`＝`git archive develop | tar -x -C /tmp/ac276-base` 里跑，即本变更落地前的真实树）：
    `for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-resident-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md`
  - 完整输出（stderr 逐字）：`缺判据文件：docs/proposals/cloudcli-mcp-resident-smoke.md`；退出码 **1**。
  - 与 Proposal 快照的差异（逐字记录，不掩饰）：Proposal 写于 AC-256 尚未落地时，断言「两个文件都不存在、逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`」。AC-256 现已落地 `scripts/mcp-smoke.mjs`（`git cat-file -e develop:scripts/mcp-smoke.mjs` 命中），故存在性闸按 `for` 顺序在**第二个**文件（本任务新建的记录文件）上先停，逐字输出的是 `缺判据文件：docs/proposals/cloudcli-mcp-resident-smoke.md`。判据命令仍退出 **1**、红只因为缺判据文件——AC1 的实质（改动前必红、红因缺判据文件）成立；差异仅是「第一个缺失的是哪个文件」。
- [x] AC2 判据绿：逐字命令 `for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-resident-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md` 退出 **0**；写下 stdout 逐字。
  - stdout 逐字：`记录合格：docs/proposals/cloudcli-mcp-resident-smoke.md 八节齐全、每节 读数：/结论： 非空、撤回节 pid-before == pid-after`；退出码 **0**。
- [x] AC3 记录八节齐全：`node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md` 退出 **0**。八节逐字为 `环境与版本` / `常驻会话启动与 pid` / `忙时发送` / `撤回与 pid 不变` / `重配置下一轮生效` / `后台任务列出与停止` / `审批` / `收尾残留与生产监听 pid`，每节都要有非空 `读数：` 与 `结论：`。红态基线本轮实测：两个判据文件都不存在，判据命令应退出 1 并逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`。
  - 实测：`node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md` 退出 **0**，stdout 同 AC2。记录文件 `## ` 标题逐字：环境与版本 / 常驻会话启动与 pid / 忙时发送 / 撤回与 pid 不变 / 重配置下一轮生效 / 后台任务列出与停止 / 审批 / 收尾残留与生产监听 pid；每节 `读数：`/`结论：` 均非空（见 AC7 逐段读数）。红态基线见 AC1（实际输出点名的是记录文件，因 AC-256 已先行落地脚本）。
- [x] AC4 取假形态 (i) 缺一节必红并点名：删掉记录里任一节（例如 `审批`）后 `--check-resident-record` 退出 **非 0**，stderr 逐字点名该节缺。登记变异 diff、逐字失败行、恢复命令；恢复后重跑回绿。
  - 变异：删掉 `## 审批` 整节（`## 审批` 标题 + 空行 + 其 `读数：` 行 + 其 `结论：` 行，共 5 行）。
  - 变异 diff（`diff -u /tmp/ac276-record-backup2.md docs/proposals/cloudcli-mcp-resident-smoke.md`）逐字：
    `@@ -39,11 +39,6 @@` … 删去 `-## 审批` / `-` / `-读数：approvals_list …` / `-结论：…` / `-`（5 行删除，retention 见记录）。
  - 逐字失败行（stderr）：`缺节：审批 —— 缺整个小节`，随后 `记录不合格（docs/proposals/cloudcli-mcp-resident-smoke.md）：缺 1 处，八节要求见 AC-276/AC3`；退出码 **1**。
  - 恢复命令：`cp /tmp/ac276-record-backup2.md docs/proposals/cloudcli-mcp-resident-smoke.md`；恢复后 `--check-resident-record` 重跑回绿（exit 0，stdout 同 AC2）。
  - 本轮（修复提交后）逐字重跑复现，读数同上（删 42–46 行）；恢复后回绿。
- [x] AC5 取假形态 (ii) 撤回节 pid 前后不同必红：把 `撤回与 pid 不变` 一节的 `pid-after=` 改成与 `pid-before=` 不同的值后 `--check-resident-record` 退出 **非 0** 并点名 pid 不等。登记变异 diff、逐字失败行、恢复命令；恢复后重跑回绿。
  - 变异：撤回节读数里 `pid-after=3891032` → `pid-after=9999999`（`pid-before` 保持 3891032）。
  - 变异 diff（`diff -u /tmp/ac276-record-backup.md docs/proposals/cloudcli-mcp-resident-smoke.md`）逐字：
    `@@ -26,7 +26,7 @@` 中 `-…pid-before=3891032 pid-after=3891032…` / `+…pid-before=3891032 pid-after=9999999…`（仅该字段）。
  - 逐字失败行（stderr）：`缺节：撤回与 pid 不变 —— pid 不等：pid-before=3891032 pid-after=9999999（撤回不得换进程）`，随后 `记录不合格（docs/proposals/cloudcli-mcp-resident-smoke.md）：缺 1 处，八节要求见 AC-276/AC3`；退出码 **1**。
  - 恢复命令：`cp /tmp/ac276-record-backup.md docs/proposals/cloudcli-mcp-resident-smoke.md`；恢复后 `--check-resident-record` 重跑回绿（exit 0，stdout 同 AC2）。
  - 本轮（修复提交后）逐字重跑复现，读数同上（第 29 行 `pid-after` 3891032→9999999）；恢复后回绿。
- [x] AC6 单测覆盖「缺一节就红」与「撤回节 pid 不等就红」：`node --test scripts/mcp-smoke-resident.test.mjs` 退出 **0**；至少覆盖（a）缺整节点名该节、（b）缺 `读数：`/`结论：` 行点名、（c）读数为空点红、（d）撤回节 `pid-after` ≠ `pid-before` 点红、（e）解析不到 pid 点红、（f）八节齐全 exit 0、（g）文件不存在八节全缺。逐条写出测试名。
  - `node --test scripts/mcp-smoke-resident.test.mjs` → `ℹ tests 14 / ℹ pass 14 / ℹ fail 0`，退出码 **0**。测试名逐条：
    (a) `(a) 缺整个「审批」节点名该节`、`(a) CLI：缺一节退出非 0，stderr 逐字点名该节`；
    (b) `(b) 缺 \`读数：\` 行点名该节缺行`、`(b) 缺 \`结论：\` 行点名该节缺行`；
    (c) `(c) \`读数：\` 冒号后为空点红并点名该节`、`(c) \`结论：\` 冒号后为空点红并点名该节`；
    (d) `(d) 撤回节 pid-after ≠ pid-before 点红并点名 pid 不等`、`(d) CLI：撤回节 pid 不等退出非 0，stderr 逐字点名 pid 不等`；
    (e) `(e) 撤回节没有 pid-before/pid-after 两个字段时点红`、`(e) parseCancelPids 只解析 \`<n>\`，\`pid-before=xpid-before=7\` 不误命中`；
    (f) `(f) 八节齐全（撤回节 pid 相等）exit 0`、`(f) parseResidentSection 三种读法：整段/读数/结论`；
    (g) `(g) 文件不存在时八节点名全缺`；
    另：`AC9 脚本源里没有以 \`常驻专有能力验收：通过\` 开头的行`。
  - 本轮（修复提交后）逐字重跑仍为 `tests 14 / pass 14 / fail 0`，退出 **0**（其中 (f) 那两条补了 `assert.ok(parsed !== null, …)` 收窄，测试名不变）。
- [x] AC7 常驻冒烟**真跑过**、八段读数是原始读数：真服务实例（临时 `DATABASE_PATH` 经 `/proc/<pid>/environ` 命中行证明、`HOST=127.0.0.1`、端口 `listen(0)` 探得且 ≠ 3001、`detached` 整组杀）+ 真 `claude` CLI（`claude mcp add --transport http` 命令逐字 + 自然语言驱动）+ 临时项目。逐段打印证据行：常驻会话 pid；忙时发送返回 `queuedMessageUuid`（非空、逐字）；撤回答复逐字含 `cancelled` 且 `pid-before == pid-after`；`session_reconfigure` 后**下一轮**运行取到新值（同一 pid，逐字打印新旧值）；`session_background` 列出当前后台任务、带 `stopTaskId` 停止并读回停止结果；审批在**非 bypass** 权限模式下由需权限工具触发，`approvals_list` 逐字看到该待审批、`approval_answer` 解除（读回消失/已答）。
  - 命令：`node scripts/mcp-smoke.mjs --run-resident --temp-root /tmp/ac276-resident-20261006-063224 --database-path /tmp/ac276-resident-20261006-063224/auth.db --record <worktree>/docs/proposals/cloudcli-mcp-resident-smoke.md`，退出码 **0**。
  - 八段证据行逐字（记录文件 `读数：`）：环境与版本（`claude --version = 2.1.289 (Claude Code)`；port=18193；`claude mcp add --transport http cloudcli http://127.0.0.1:18193/mcp --header "Authorization: Bearer ccp_…" --scope project`）；常驻会话启动与 pid（`sessionId=6f79fd6a-…`、`pid=3891032`、`bgTask=bhihe608z`）；忙时发送（逐字 `{"runId":"ccfad47a-…","queued":true,"queuedMessageUuid":"435e3bca-3cdb-416e-8985-0201b880806d","source":"mcp"}`）；撤回与 pid 不变（`{"outcome":"cancelled",…}` 且 `pid-before=3891032 pid-after=3891032`）；重配置下一轮生效（旧值 `permissionMode="bypassPermissions"` → `session_reconfigure` 逐字 `{"ok":true,"stored":{"permissionMode":"default"},"applied":"live","liveSupported":true}` → 新值 `permissionMode="default"`；下一轮 `runId=72d1140d-…` 用**需权限的 Write** 撞权限墙挂起；pid 前后同为 3891032）；后台任务列出与停止（列出 2 条 `kind=background-task`，`stopTaskId=bhihe608z` → 逐字 `{"stopped":true,"taskId":"bhihe608z","remaining":[]}`）；审批（`approvals_list` 逐字 `{"approvals":[{"requestId":"7e42df8b-…","toolName":"Write","inputSummary":"…/resident-permission-probe.txt","waitedMs":1449}]}` → `approval_answer` 逐字 `{"ok":true,"requestId":"7e42df8b-…","decision":"allow"}` → 再列该 requestId 已消失、且被放行的 Write 真的写盘 `存在=true`）；收尾残留与生产监听 pid（见 AC8）。
  - 关键点：审批靶子是 **Write**（需权限工具）。`Bash sleep/echo` 一类安全命令被 CLI 直接放行、根本不经过 `canUseTool`，故不能作靶子；Write 在 `default` 下才被交到审批面（`bypass` 下静默写盘）——正是「下一轮真的取了 default」的判别器。
- [x] AC8 收尾残留读数为 0 且不碰生产：跑完打印临时根上 `pgrep -af` / `/proc` environ / `systemctl --user list-units --type=scope` 三条命中数均为 **0**；`:3001` 的监听 pid 与 systemd MainPID 的**终点读数与起点读数逐字相同**（打印两行）；全程未连接 / 未启用 / 未重启 3001。
  - 残留读数逐字：`临时根 /tmp/ac276-resident-20261006-063224：pgrep-命中=0、/proc environ-命中=0、systemctl --user scope-命中=0`（等待后剩余 0）。
  - `:3001` 起点读数逐字：`listener-pid=2286735 systemd-main-pid=2286735`；终点读数逐字：`listener-pid=2286735 systemd-main-pid=2286735`（起终点逐字相同——监听 pid 与 systemd MainPID 均未被触动）。
  - 全程未连接 / 未启用 / 未重启 3001（冒烟实例端口 18193，`listen(0)` 探得且 ≠ 3001）。
- [x] AC9 不点亮 AC-277：`grep -c '^常驻专有能力验收：通过' docs/proposals/cloudcli-mcp-resident-smoke.md` → **0** 且 `grep -c '常驻专有能力验收：通过' scripts/mcp-smoke.mjs` → **0**（记录模板与脚本输出都不得出现以该字样开头的行）。
  - 实测：记录文件计数 **0**；`scripts/mcp-smoke.mjs` 计数 **0**。人证行（AC-277）未点亮。本轮修复提交后重测仍为 0 / 0。
- [x] AC10 契约面与边界：`npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke-resident.test.mjs` 退出 **0**；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；证明产品代码一行未改（网关 / 工具 / 审批 / AC-256 的 `--check-record` 与它的记录均不在本 diff）。
  - `npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke-resident.test.mjs` → 退出码 **0**（无诊断）。
  - `npm run typecheck` → 退出 **0**（修复提交 `8997645f` 前为 **2**；见 `## Evidence`——原文 Plan §6/Notes 称这条红是 develop 侧既有，实测为假）。同理 `npm run lint` → 退出 **0**。
  - `git diff --stat develop...HEAD` 逐字（修复提交 `8997645f` 后重取）：`docs/proposals/cloudcli-mcp-resident-smoke.md | 51 ++`（new，A）、`scripts/mcp-smoke-resident.test.mjs | 233 +++++++`（new，A）、`scripts/mcp-smoke.mjs | 896 +++…`（M）；`git diff --name-status develop...HEAD`：`A docs/proposals/cloudcli-mcp-resident-smoke.md`、`A scripts/mcp-smoke-resident.test.mjs`、`M scripts/mcp-smoke.mjs`——与 `## Touches` 逐条对齐。（`232`/`885` 是纯注解修复前的旧读数。）
  - 产品代码一行未改：`git diff --name-only develop...HEAD | grep -E '^server/|^src/'` 为空；AC-256 的 `--check-record` 行为与其记录 `docs/proposals/cloudcli-mcp-smoke.md` 均不在本 diff（回归读数见 `## Evidence`）。

## DoD

- 判据命令在**网关照常工作**的树上退出 0：`node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md`。
- 记录文件八节**逐节**有非空 `读数：` 与 `结论：`；读数来自**真跑**（真服务进程 + 真 Claude CLI + 临时项目 + 终端 Claude Code 经 PAT），不是转述或模板。
- 常驻专有能力是**真的被操作过**：忙时发送真的拿到 `queuedMessageUuid`；撤回真的报 `cancelled` 且 `pid-before == pid-after`；`session_reconfigure` 真的在**下一轮**生效；`session_background` 真的列出并停止；审批真的在非 bypass 模式下被 `approvals_list` 看到并被 `approval_answer` 解除。
- 隔离是机械读数：临时 `DATABASE_PATH` 经 `/proc/<pid>/environ` 证明、`HOST=127.0.0.1`、端口 ≠ 3001；收尾后进程 / 目录 / scope 命中均为 0；`:3001` 起点与终点监听 pid 相同。
- 两次取假形态都先红后恢复；变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- AC-277 的人证行**没被点亮**：记录与脚本里都没有以 `常驻专有能力验收：通过` 开头的行；本任务的正确终态是 `done`（读数齐全），GOAL-022 的验收结论由人 yale 在 AC-277 给出。
- 只动 `## Touches` 列出的文件；产品代码一行不改（含不改 AC-256 的 `--check-record` 与其记录）。
- 本任务不得把仓库级冻结面打红：`npm run typecheck` 与 `npm run lint` 退出 0（见 `## Evidence`）。

## Touches

- scripts/mcp-smoke.mjs（在 AC-256 交付的脚本上追加 `--check-resident-record` 与 `RESIDENT_SECTION_TITLES`）
- scripts/mcp-smoke-resident.test.mjs (new)（resident 记录检查的护栏单测，含「缺一节就红」与「撤回节 pid 不等就红」）
- docs/proposals/cloudcli-mcp-resident-smoke.md (new)（八段读数记录；人证行由人 yale 在 AC-277 写）
- tasks/gap-ac276-mcp-resident-smoke-record.md（自触）

## Notes

- `--check-resident-record` 的节标题按整行相等比对（不用 `\b`——中文没有词边界），沿用 `resident-smoke.mjs` 的 `extractSection` 写法；本任务八节无前缀互撞。
- **绝不碰生产 3001**：不连接、不启用 `MCP_ENABLED`、不重启。生产启用 MCP 是人在会话外执行的单独步骤（SPEC §456），不属于任何判据。
- 撤回节的判据物是「`pid-before` 与 `pid-after` 相等」——这正是假形态 (ii)。记录里必须**显式**写出这两个字段（`pid-before=<n> pid-after=<n>`），否则解析不到也要红（假形态 (ii) 的负控制）。
- 记录文件是 AC-277 的判据物但**不是**本任务写的验收行：`--check-resident-record` 只读它，脚本输出里也**不得**出现以 `常驻专有能力验收：通过` 开头的行。
- ⛔ **原文此处曾写「新增 `scripts/*.mjs` 会让 `scripts/tsconfig.json`（`allowJs + checkJs`）多报类型错——这是 develop 侧既有的红（`resident-smoke.mjs` 63 个），本条不修它，也不把 `npm run typecheck` 退出 0 写进 AC」，该说法已被实测推翻，勿再采信。** `scripts/tsconfig.json` 确在 `npm run typecheck` 的第三条腿里，但它在 develop 上**是绿的**（`git archive develop` 后跑 `npm run typecheck` → 退出 **0**；`npx tsc --noEmit -p scripts/tsconfig.json` → 退出 **0**）。新增 `scripts/*.mjs` 带进来的类型错**不是**既有的：它会让 `npm run typecheck` 退出 2，进而把 `server/modules/voice/tests/*.false-forms.test.ts` 的**冻结面断言**打红（那些文件把 `npm run typecheck` 当「本任务不得移动的面」并断言其退出 0），造成 suite `# fail 8` 与 fan-in 的 `exited-not-landed`。本条已把那 7 处类型错补注解修掉，`npm run typecheck` 现退出 0（见 `## Evidence`）。
- `node --test` 的 stderr 不回传给调用方（内存 `node-test-stderr-does-not-reach-the-caller`）：单测里若 spawn 子进程跑 CLI 并断言 stderr，直接读 `spawnSync` 返回的 `result.stderr` 字段，不靠透传。
- 新增测试文件已在 `## Touches` 列出（内存 `quay-boundaries-lint-blocks-new-test-files`）；`.mjs` 测试可能不被 scoped 门正则覆盖（内存 `scoped-gate-regex-excludes-mjs-tests`），故 AC6 的真跑靠自己 `node --test` 证明，不假设门会跑它。
- 权限靶子必须是**需权限工具**（Write），不能是 `Bash sleep/echo`：后者命中 CLI 的安全命令表被直接放行、不经 `canUseTool`，等不到待审批。这是本轮取假/取真的关键读数（见 AC7）。

## Evidence

### 本轮（worker 第 4 轮）真因：typecheck 红 → voice false-forms 冻结面红

前两轮 `step=suite` 的逐字失败行是 `server/modules/voice/tests/voice-capture-audio.false-forms.test.ts: AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red`。机械 delta-relatedness 对全部 8 条都判 **UNRELATED**（失败文件不在一跳 import 面上），但那是**误导**：真因在本任务自己的 delta 里，判据只看了 import 图。

- 真因（套件日志逐字，第一行失败）：`not ok - typecheck: scripts/mcp-smoke-resident.test.mjs(204,16): error TS18047: 'parsed' is possibly 'null'.` 同段另一条把本任务的类型错直接写成失败签名：`not ok - server/modules/voice/tests/voice-capture-off.false-forms.test.ts: AC6 FAIL cases=n/a :: npm run typecheck (exit=2) | sig: scripts/mcp-smoke-resident.test.mjs(204,16): error TS18047: 'parsed' is possibly 'null'.`
- 机制（读源码确认，不是推断）：`server/modules/voice/tests/voice-capture-audio.false-forms.test.ts:765` 把 `runCommand('npm', ['run', 'typecheck'], false)` 放进冻结面集合，并在 `:786` 断言其中没有非 0 项（`'a surface this task must not have moved is red'`）；`voice-error-classification.false-forms.test.ts:617` 同样把 `npm run typecheck` 列为冻结面。本任务红 ⇒ 这些断言红 ⇒ `# fail 8`。
- **推翻了任务原文的声明**：Plan §6 与 Notes 称「`scripts/*.mjs` 的 typecheck 红是 develop 侧既有」。实测（`git archive develop | tar -x -C /tmp/ac276-devbase-9f3a` 后跑）：`npm run typecheck` → 退出 **0**；`npx tsc --noEmit -p scripts/tsconfig.json` → 退出 **0**。7 处类型错**全部由本任务引入**（首建提交 `e9cadf75` 即已带上 204 行那处）。
- 逐条修复（提交 `8997645f`，**仅 JSDoc/注解，无逻辑变更**）：
  1. `scripts/mcp-smoke-resident.test.mjs(204,16)/(205,16)` TS18047 —— `parseResidentSection` 返回 `… | null`，补 `assert.ok(parsed !== null, …)` 收窄；
  2. `scripts/mcp-smoke.mjs` TS7006 ×2 —— `residentPendingApprovals` / `residentHostPid` 的 `smoke` 隐式 any，补 `@param {Smoke} smoke`；
  3. `scripts/mcp-smoke.mjs` TS2349 + TS2345 —— `legs` 数组字面量被推成 `(string | 函数)[]`，标注 `@type {Array<[string, (smoke: Smoke) => unknown]>}`；
  4. `scripts/mcp-smoke.mjs` TS2345 —— `main` 把 `Record<string, string | undefined>` 传给 `runResidentMain`，其 `@param` 放宽为 `string | undefined`（函数体本就以 `??` 兜底）。

### 修复后的逐字复跑读数

- 套件日志 `# fail 8` 的**全部 8 条**逐条复跑，现全绿（测试命令：`npx tsx --tsconfig server/tsconfig.json --test <file>`）：
  - `typecheck`：`npm run typecheck` → 退出 **0**。
  - `voice-capture-audio.false-forms.test.ts` → `ℹ pass 9 / ℹ fail 0`，退出 **0**；其 AC8 九条面逐条 `AC8 exit=0`（7 条既有判据 + `npm run typecheck` + `npm run lint`）。
  - `voice-capture-isolation.false-forms.test.ts` → `pass 4 / fail 0`，退出 **0**。
  - `voice-capture-off.false-forms.test.ts` → `pass 4 / fail 0`，退出 **0**。
  - `voice-capture-secrets.false-forms.test.ts` → `pass 4 / fail 0`，退出 **0**。
  - `voice-capture-text.false-forms.test.ts` → `pass 6 / fail 0`，退出 **0**。
  - `voice-error-classification.false-forms.test.ts` → `pass 7 / fail 0`，退出 **0**。
  - `voice-error-contract.false-forms.test.ts` → `pass 4 / fail 0`，退出 **0**。
- `npm run lint` → 退出 **0**（仅 warning）。
- 本任务自己的门在修复后逐字重跑仍全绿：判据命令（含存在性闸）退出 **0**、stdout 同 AC2；`node --test scripts/mcp-smoke-resident.test.mjs` → `ℹ tests 14 / ℹ pass 14 / ℹ fail 0`，退出 **0**；`npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke-resident.test.mjs` → 退出 **0**。
- AC-256 未回归：`node --test scripts/mcp-smoke.test.mjs` → `tests 25 / pass 25 / fail 0`，退出 **0**；`node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md` → `记录合格：…端口不是 3001`，退出 **0**。
- 两次假形态在修复后**逐字重跑**，读数与 AC4/AC5 记录一致：删 `## 审批` → stderr `缺节：审批 —— 缺整个小节`，退出 **1**，恢复后回绿；`pid-after` 3891032→9999999 → stderr `缺节：撤回与 pid 不变 —— pid 不等：pid-before=3891032 pid-after=9999999（撤回不得换进程）`，退出 **1**，恢复后回绿。
- 合并 develop 后重测（develop 本轮由 `48d0f154` 前进到 `7425fba4`，只改了 `.quay/config.yml` 的 quay 版本号，与本 delta 无关）：`npm run typecheck` 退出 **0**、判据命令退出 **0**、`git merge develop` 无冲突、无未合并路径、`git merge-base --is-ancestor develop HEAD` 成立（ff 可成功）。