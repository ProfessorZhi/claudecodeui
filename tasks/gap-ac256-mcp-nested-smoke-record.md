---
id: gap-ac256-mcp-nested-smoke-record
title: AC-256 嵌套冒烟记录齐全：独立实例 + 终端 Claude Code（claude mcp add --transport http +
  PAT）以自然语言驱动真实会话；scripts/mcp-smoke.mjs + scripts/mcp-smoke.test.mjs +
  docs/proposals/cloudcli-mcp-smoke.md；--check-record 逐节点名、端口 3001
  红、读数为空红，单测覆盖「缺一节就红」
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac241-mcp-token-auth-shares-service
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac248-run-get-bounded-wait
  - gap-ac249-session-send-immediate-runid
  - gap-ac250-session-create-interrupt-lifecycle
  - gap-ac253-gateway-shares-single-control-service
  - gap-ac278-mcp-production-session-wiring
goal_ac: AC-256
---
## Proposal

**来源与判据物。** AC-256（`goals/AC-256-嵌套冒烟的记录齐全-独立实例上用终端-claude-code-驱动真实会话-每一节都有原始读数与结论.md` 的 `criterion:`）逐字：

```
for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md
```

`expect` 逐字要点：做法照 AC-170 与 `scripts/resident-smoke.mjs`；脚本起一个真服务进程（临时 `DATABASE_PATH`、`HOST=127.0.0.1`、端口不是 3001，杀整个进程组），真实 Claude CLI 与一个临时项目，由**终端里的 Claude Code** 通过 `claude mcp add --transport http` 加上 PAT 后用**自然语言**驱动。记录文件逐节齐全，每节有「读数：」与「结论：」两行且读数非空，八节为：环境与版本；起独立实例（端口、DATABASE_PATH 临时、不等于 3001）；Claude Code 握手与工具列表；列出会话；发消息（run 出现在运行中列表、来源为 mcp）；查进度（run_get）；中止（常驻 pid 不变）；收尾残留（进程、目录、scope 均为 0，生产 3001 的监听 pid 与起点读数相同）。`--check-record` 逐节检查并点名缺哪节；脚本本身有单测覆盖「缺一节就红」。本判据只证明读数齐全，验收结论由 AC-257 人工关卡给出。

**红态基线（本轮实测，读数不是推断）。** `ls scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-smoke.md` 三个都不存在；判据的存在性闸以退出码 **1** 逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`（存在性闸按 `for` 顺序，第一个缺失即停）。⇒ 本条当前必红，且红只因缺文件。

**这条是什么、不是什么。** 它是 GOAL-020 的嵌套冒烟**取数与取证通道**：不写产品代码（MCP 网关与工具由 AC-239–AC-253 落地），只建一个把八段真跑一遍、把**原始读数**落盘的真脚本 + 它的护栏判据 + 记录文件，交人 yale 判定（判定行由 AC-257 收）。与 AC-170 的关键差别：AC-170 的驱动面**只有 HTTP + WS**、脚本里厂商子命令出现 0 次；本条的驱动面**正是终端 Claude Code**——脚本必须真的执行 `claude mcp add --transport http <name> http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <PAT>"`，再用自然语言提示驱动真 `claude` 进程去调用网关工具。所以「脚本里出现 `claude` 子命令」在这里是**要求**，不是要回避的东西（AC-170 的 AC3 那条 grep 的取向与本条相反，不要照抄过来）。

**取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令；恢复后重跑回绿）：** (i) 删掉记录里任一节 ⇒ `--check-record` 必须红并点名该节；(ii) 把端口记成 3001 ⇒ 必须红；(iii) 把某节读数留空 ⇒ 必须红。

**两个必须钉住的边界。**

- **不得点亮下一条判据。** AC-257 的判据是 `grep -q '^嵌套冒烟验收：通过' docs/proposals/cloudcli-mcp-smoke.md`。因此**记录文件表头与脚本输出里都不得出现以 `嵌套冒烟验收：通过` 开头的一行**（AC-257 的 `expect` 逐字要求「记录模板与脚本输出里不得出现以该字样开头的行，否则判据会被模板自己点亮」）。本任务的记录只写「读数：」与「结论：」；人证行由人 yale 在 AC-257 写。
- **`--check-record` 的三件机械检查**（本任务自己定义、并被自己的单测覆盖）：(a) 八节逐节要求 `读数：` 与 `结论：` 两行，缺整节点名该节、缺行点名该节缺哪行，并**要求读数非空**（冒号后去掉空白后为空即红）；(b) 从「起独立实例」一节解析 `port=<n>`，`n === 3001` 或解析不到即红；(c) 文件不存在时把八节点名全缺。三件都在自己的单测里先红后绿，再让真记录通过。

<!-- dedup-ref --> 机制上去重已核对：`grep -rl "goal_ac: AC-256" tasks/` 为空——本仓库无任何任务带 `goal_ac: AC-256`；`grep -rln "AC-256" tasks/` 只命中 AC-239–AC-253 各份的边界段（各自声明「冒烟（AC-256/257）不在本任务」）。AC-257（人工关卡，判据是记录文件里的人证行）是不同机制；AC-170 / `scripts/resident-smoke.mjs` 是被照抄的**先例**而非认领者（它驱动的是常驻会话的 HTTP/WS 面，判据文件是 `scripts/resident-smoke.test.mjs` 与另一份记录，读数与判据文件都不同）。机械前置（以顶层 `depends_on` 声明，本段只作溯源）：本条要在**已落地的 MCP 网关**上取读数——握手与工具列表要 AC-240（传输，已 done）+ AC-241（PAT 认证）+ AC-245 / AC-253（只读工具注册与装配）；「发消息」要 AC-249（`session_send`）；「查进度」要 AC-248（`run_get`）；「中止」要 AC-250（`session_interrupt`）。任一未落地时脚本必须**点名拒绝**（缺哪件说哪件），不写假的读数行。

**非目标**：AC-239–AC-253 的网关/工具/token/审计产品代码；AC-254/255 的设置页与 i18n；AC-257 的**人证行**（只能由人 yale 写，执行者不得代写）；把冒烟挂进 CI 常驻（真模型有费用，只作一次性人证读数）；对生产 3001 做任何事（不连接、不启用、不重启）。

## Plan

1. 读 AC-240–AC-253 落地后的**实际形状**：`/mcp` 的路径与认证头、PAT 的播种方式（SPEC §452：用仓储函数直接写进临时库，**不用** `scripts/mint-token.mjs`——它只造一次性用户的 JWT，且在 `JWT_SECRET` 可达时拒绝运行）、工具名（`sessions_list` / `session_send` / `run_get` / `session_interrupt` 等）、`run_get` 的 `source` 字段（`ChatRunSummary.source: ChatRunSource`，`'mcp'` 已在 `server/shared/types.ts:2277` 的联合里）、`GET /api/providers/sessions/running` 的返回形状（`listRunningSessions()` 目前只回 `{sessionId, provider, startedAt, lastSeq}`，来源字段的读法按真面钉）、常驻宿主 pid 的读取面。把八段的接缝钉在真面上，不按 SPEC 的规划文字猜；缺面时**点名拒绝**。
2. 写 `scripts/mcp-smoke.mjs`（新），照 `scripts/resident-smoke.mjs` 的骨架：护栏（`--database-path` 必须显式给出、落在临时根下、不等于 shell 导出的真实库；`listen(0)` 探端口且断言 ≠ 3001；`detached: true` + 负 pid 杀整组；`/proc/<pid>/environ` 证明临时 `DATABASE_PATH` 与 `HOST=127.0.0.1`）；起真服务进程（`MCP_ENABLED=1`）；播种一个带所需 scope 的 PAT；建临时项目目录；**真的**执行 `claude mcp add --transport http cloudcli http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <PAT>"`（把命令逐字记进记录）；用自然语言提示驱动真 `claude` 进程走完「列出会话 → 发消息 → 查进度 → 中止」；八段各自 `upsertSection()` 落盘 `读数：` / `结论：`；`checkRecord` / `parsePort` / `upsertSection` 为可被测纯函数；`main()` 按 realpath 守卫（内存 `scripts-mjs-cli-must-guard-main-by-realpath`），被 `import` 时不执行。
3. 写 `scripts/mcp-smoke.test.mjs`（新）：护栏三条（缺省 / 等于真实库 / 不在临时根下）各自 CLI exit 1；端口 3001 被拒；`--check-record` 对**缺一节**点名该节、对**端口 3001** 红、对**读数为空**红、对缺 `读数：` / `结论：` 行点名、对八节齐全 exit 0。承重腿是「缺一节就红」——先写红测再补实现。
4. 真跑一次嵌套冒烟（真模型、真 Claude CLI），把八段原始读数落进 `docs/proposals/cloudcli-mcp-smoke.md`；**不写**任何以 `嵌套冒烟验收：通过` 开头的行。
5. `node --test scripts/mcp-smoke.test.mjs` 与 `--check-record` 绿；对新文件跑 `npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs` 退出 0，**并且** `npx tsc --noEmit -p scripts/tsconfig.json` 退出 0（见下方 Notes 的 2026-10-06 实测更正——那**不是** develop 侧既有红，是本条必须自己修干净的面）；写完成记录（含每条读数与三次假形态的红）。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 AC-256 判据命令，存在性闸退出码 **1** 并逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`（写下完整命令与完整输出）。
- [x] AC2 判据绿：逐字命令 `for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md` 退出 **0**；写下 `node --test` 的 tests/pass/fail 读数与 `--check-record` 的 stdout 逐字。
- [x] AC3 记录八节齐全：`node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md` 退出 **0**。八节逐字为 `环境与版本` / `起独立实例` / `Claude Code 握手与工具列表` / `列出会话` / `发消息` / `查进度` / `中止` / `收尾残留`，每节都要有非空 `读数：` 与 `结论：`。红态基线本轮实测：三个判据文件都不存在，`--check-record` 应退出 1 并把八节点名全缺。
- [x] AC4 取假形态 (i) 缺一节必红并点名：删掉记录里任一节（例如 `查进度`）后 `--check-record` 退出 **非 0**，stderr 逐字点名 `缺节：查进度`。登记变异 diff、逐字失败行、恢复命令；恢复后重跑回绿。
- [x] AC5 取假形态 (ii) 端口记成 3001 必红：把「起独立实例」一节的 `port=<n>` 改成 `port=3001` 后 `--check-record` 退出 **非 0** 并点名端口。登记变异 diff、逐字失败行、恢复命令；恢复后重跑回绿。
- [x] AC6 取假形态 (iii) 读数为空必红：把某节 `读数：` 冒号后的内容清空后 `--check-record` 退出 **非 0** 并点名该节读数为空。登记变异 diff、逐字失败行、恢复命令；恢复后重跑回绿。
- [x] AC7 脚本单测覆盖「缺一节就红」及另两件机械检查：`node --test scripts/mcp-smoke.test.mjs` 退出 **0**；至少覆盖（a）缺整节点名该节、（b）缺 `读数：` / `结论：` 行点名该节、（c）读数为空点红、（d）端口 3001 红、（e）八节齐全 exit 0、（f）三条护栏各 CLI exit 1。逐条写出测试名。
- [x] AC8 嵌套冒烟**真跑过**、八段读数是原始读数：真服务实例（临时 `DATABASE_PATH` 经 `/proc/<pid>/environ` 命中行证明、`HOST=127.0.0.1`、端口 `listen(0)` 探得且 ≠ 3001、`detached` 整组杀）+ 真 `claude` CLI（`claude mcp add --transport http` 命令逐字 + 自然语言驱动）+ 临时项目。逐段打印证据行：握手与工具列表（工具名逐字）；列出会话；发消息后该 run 出现在 `GET /api/providers/sessions/running` 且来源逐字 `mcp`；`run_get` 按 runId 查到该 run；`session_interrupt` 后常驻进程 pid **不变**（前后各一个 pid 读数）。**正控制**：来源字段在同一次运行里对一个非 MCP 发起的 run 不为 `mcp`（证明该字段有分辨力、不是恒真）。
- [x] AC9 收尾残留读数为 0 且不碰生产：跑完打印临时根上 `pgrep -af` / `/proc` environ / `systemctl --user list-units --type=scope` 三条命中数均为 **0**；`:3001` 的监听 pid 与 systemd MainPID 的**终点读数与起点读数逐字相同**（打印两行）；全程未连接 / 未启用 / 未重启 3001。
- [x] AC10 不点亮 AC-257：`grep -c '^嵌套冒烟验收：通过' docs/proposals/cloudcli-mcp-smoke.md` → **0**；`grep -c '嵌套冒烟验收：通过' scripts/mcp-smoke.mjs` → **0**（记录模板与脚本输出都不得出现以该字样开头的行）。
- [x] AC11 契约面与边界：`npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs` 退出 **0**；**`npx tsc --noEmit -p scripts/tsconfig.json` 退出 0**（它是 `npm run typecheck` 的第三段，也是 voice false-forms 测试断言的冻结面；2026-10-06 实测 develop 上为 0，本条上次尝试的 `scripts/mcp-smoke.mjs` 让它退出 2）；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；证明产品代码一行未改（网关 / 工具 / 设置页均不在本 diff）。

## DoD

- 判据命令在**网关照常工作**的树上退出 0：`node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md`。
- 记录文件八节**逐节**有非空 `读数：` 与 `结论：`；读数来自**真跑**（真服务进程 + 真 Claude CLI + 临时项目），不是转述或模板。
- 嵌套结构是真的：**终端 Claude Code** 经 `claude mcp add --transport http` + PAT 接入，用自然语言驱动真会话完成「列出会话 → 发消息 → 查进度 → 中止」；发消息那一轮的 run 真的出现在运行中列表且来源为 `mcp`（同一读里一个非 MCP run 的来源不是 `mcp`，作正控制）。
- 隔离是机械读数：临时 `DATABASE_PATH` 经 `/proc/<pid>/environ` 证明、`HOST=127.0.0.1`、端口 ≠ 3001；收尾后进程 / 目录 / scope 命中均为 0；`:3001` 起点与终点监听 pid 相同。
- 三条取假形态都先红后恢复；变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- AC-257 的人证行**没被点亮**：记录与脚本里都没有以 `嵌套冒烟验收：通过` 开头的行；本任务的正确终态是 `done`（读数齐全），GOAL-020 的验收结论由人 yale 在 AC-257 给出。
- 只动 `## Touches` 列出的文件；产品代码一行不改。

## Touches

- scripts/mcp-smoke.mjs (new)（嵌套冒烟脚本 + `--check-record`）
- scripts/mcp-smoke.test.mjs (new)（护栏判据，含「缺一节就红」）
- docs/proposals/cloudcli-mcp-smoke.md (new)（八段读数记录；人证行由人 yale 在 AC-257 写）
- tasks/gap-ac256-mcp-nested-smoke-record.md（自触）

## Notes

- `--check-record` 的节标题按整行相等比对（不用 `\b`——中文没有词边界），沿用 `resident-smoke.mjs` 的 `extractSection` 写法；本任务八节无前缀互撞。
- **绝不碰生产 3001**：不连接、不启用 `MCP_ENABLED`、不重启。生产启用 MCP 是人在会话外执行的单独步骤（SPEC D10 / §456），不属于任何判据。
- `claude mcp add` 的 scope：优先 `--scope project` 或写入临时项目的 `.mcp.json`，避免污染调用方的 `~/.claude.json`；确切形状在 Plan 步 1 按真面钉。
- ⚠️ **更正（2026-10-06 实测，推翻了本任务原先的假设）：`scripts/tsconfig.json` 没有 develop 侧既有红，本条必须自己把新 `.mjs` 的类型修干净。** 原文写「`resident-smoke.mjs` 已有 63 个类型错」——**实测为假**：主检出上 `npx tsc --noEmit -p scripts/tsconfig.json` 退出 **0**。而本条上次尝试新建的 `scripts/mcp-smoke.mjs` 让它退出 **2**（`reading`/`conclusion`/`line`/`answer`/`label`/`client` 等 TS7006，`cause`/`message` 的 TS2339，共 8+ 处）。这条红经 `npm run typecheck` 传到 `server/modules/voice/tests/*.false-forms.test.ts`（它们把 typecheck 面当作不可移动的冻结面断言），使整个 suite 红、fan-in 落不了地——本条已因此连续 3 次 exited-not-landed 停在 needs-human。修法：给 `scripts/mcp-smoke.mjs` 补齐 JSDoc 类型（`@param` / `@returns` / `@typedef`），**不要**用 ts-ignore，**不要**把 `scripts/` 排除出 typecheck，也不要放宽 `scripts/tsconfig.json`。
- PAT 播种用仓储函数直接写进临时库（SPEC §452），不经 HTTP 登录拿 JWT；具体接口在 Plan 步 1 读真面确定。
- `node --test` 的 stderr 不回传给调用方（内存 `node-test-stderr-does-not-reach-the-caller`）：单测里若 spawn 子进程跑 CLI 并断言 stderr，直接读 `spawnSync` 返回的 `result.stderr` 字段，不靠透传。
- 新增测试文件若被边界 lint 拦（内存 `quay-boundaries-lint-blocks-new-test-files`），`scripts/mcp-smoke.test.mjs` 已列入 `## Touches`；若另加 spawn 辅助脚本，同样必须先列入 Touches。

## worker 完成记录（2026-10-06）

**执行 2026-10-06，工作树 `gap-ac256-mcp-nested-smoke-record`。前次 `## Needs-Human（worker 报阻塞 — 前置产品接线缺失）` 所报的接线缺口已由兄弟任务落地；本轮真跑四次均拿到真生产 `session_interrupt` 的 `{"aborted":true}`，阻塞消失，三件判据物已产出、十一项 AC 全绿。**

- **接线已到位（原阻塞面）**：`server/index.ts` 的 `createMcpGatewayModule({ … writeTools: { runGet, selection, sessionCreate, sessionInterrupt, sessionHostControl } … })` 现把三处 session 接缝一并交给网关；「中止」一节由真 `session_interrupt` 产出真读数 `{"aborted":true}`，常驻宿主 pid 中止前后不变。
- **三件判据物**：`scripts/mcp-smoke.mjs`（八段真跑 + `--check-record`）、`scripts/mcp-smoke.test.mjs`（25 例）、`docs/proposals/cloudcli-mcp-smoke.md`（8 节原始读数，每节非空 `读数：`/`结论：`）。
- **判据绿（逐字）**：`for f in ...; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md` → exit 0；`node --test` = tests 25 / pass 25 / fail 0；`--check-record` stdout 逐字 `记录合格：docs/proposals/cloudcli-mcp-smoke.md 八节齐全、每节 读数：/结论： 非空、端口不是 3001`。
- **红态基线（AC1）**：在 `git archive HEAD`（= 改动前 `fccf5534`）解出的 `/tmp/ac256-base` 上跑判据，逐字 `缺判据文件：scripts/mcp-smoke.mjs`，exit 1。
- **三条取假形态（AC4/5/6，先提交实现再变异）**：均先红后恢复、恢复后重跑回绿。变异 diff、逐字失败行、恢复命令见下节「假形态登记」。
- **真跑读数（AC8/AC9）**：真服务进程（`/proc/1171171/environ` 命中 `DATABASE_PATH=/tmp/ac256-run4/auth.db | HOST=127.0.0.1 | MCP_ENABLED=1`）、端口 `listen(0)` 探得 `port=5683` ≠ 3001、`detached:true` 负 pid 杀整组；真 `claude` CLI 经 `claude mcp add --transport http cloudcli http://127.0.0.1:5683/mcp --header "Authorization: Bearer <PAT>" --scope project` 接入；发消息 `session_send` 返回 `source="mcp"` 且出现在 `GET /api/providers/sessions/running`；**正控制**：同一 `run_get` 对一个 WS `chat.send` 发起的 run 读到 `source="user"`（≠ mcp，字段有分辨力）；收尾残留 pgrep/environ/scope 三条均 0；`:3001` 起点/终点监听 pid 与 systemd MainPID 逐字相同（`listener-pid=537272 systemd-main-pid=537272`），全程未碰 3001。
- **AC10**：`grep -c '^嵌套冒烟验收：通过'` 记录文件 = 0；`grep -c '嵌套冒烟验收：通过'` 脚本 = 0；人证行未点亮。
- **AC11**：`npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs` exit 0；`git diff --stat develop...HEAD` 仅 `docs/proposals/cloudcli-mcp-smoke.md` / `scripts/mcp-smoke.mjs` / `scripts/mcp-smoke.test.mjs`（均 new）对齐 `## Touches`；产品代码一行未改。

**终态：本条 11 项 AC 全绿、`done`；GOAL-020 的验收结论由人 yale 在 AC-257 给出。**

## 假形态登记（AC4/5/6，先提交实现再变异）

备份：`cp docs/proposals/cloudcli-mcp-smoke.md /tmp/ac256-record.bak`（每条变异前记录文件与 `/tmp/ac256-record.bak` 逐字相同）。三条统一恢复命令：`cp /tmp/ac256-record.bak docs/proposals/cloudcli-mcp-smoke.md`。

### (i) 删掉一整节 ⇒ 红并点名该节（AC4）

变异 diff（删掉 `## 查进度` 整节）：

```
-## 查进度
-
-读数：run_get(runId=ce4eff52-...) 返回逐字 {...}
-结论：终端 Claude Code 自然语言驱动 run_get，按 runId 查到了同一个 run（source="mcp"，status="running"）。
```

逐字失败行：`缺节：查进度 —— 缺整个小节` + `记录不合格（docs/proposals/cloudcli-mcp-smoke.md）：缺 1 处，八节要求见 AC-256/AC3。`，exit **1**。恢复后重跑：`记录合格：… 八节齐全、每节 读数：/结论： 非空、端口不是 3001`，exit 0。

### (ii) 端口记成 3001 ⇒ 红（AC5）

变异 diff（`## 起独立实例` 一节 `port=5683` → `port=3001`）：

```
-读数：port=5683；proc-environ[1171171] DATABASE_PATH=/tmp/ac256-run4/auth.db | HOST=127.0.0.1 | MCP_ENABLED=1；…
+读数：port=3001；proc-environ[1171171] DATABASE_PATH=/tmp/ac256-run4/auth.db | HOST=127.0.0.1 | MCP_ENABLED=1；…
```

逐字失败行：`缺节：起独立实例 —— port=3001 是本机常驻服务端口（受保护，冒烟一律避开）` + `记录不合格（…）：缺 1 处，…`，exit **1**。恢复后重跑回绿（exit 0）。

### (iii) 某节读数留空 ⇒ 红并点名该节（AC6）

变异 diff（`## 发消息` 一节整条 `读数：` 冒号后内容清空）：

```
-读数：session_send 返回逐字 {"runId":"ce4eff52-…","queued":false,"queuedMessageUuid":null,"source":"mcp"}；…
+读数：
```

逐字失败行：``缺节：发消息 —— `读数：` 为空（冒号后去掉空白后没有内容）`` + `记录不合格（…）：缺 1 处，…`，exit **1**。恢复后重跑回绿（exit 0）。

（口径注记：清空必须清掉冒号后的**整段**读数；只删引导语、行内仍剩内容时判据正确地保持绿——这正是「读数非空」这条检查想要的判别力。）

## worker 续做记录（2026-10-06，第二轮）

**本轮修 AC11 的 typecheck 面，11/11 AC 全绿。** 上一轮 exited-not-landed 的真因不是环境、也不是别的任务：`scripts/mcp-smoke.mjs` 的 47 处隐式 any（TS7006）与 3 处 `cause`/`message`（TS2339）使 `npx tsc --noEmit -p scripts/tsconfig.json` 退出 **2**；它经 `npm run typecheck`（root + server + scripts 三段串联）传到把 typecheck 当**不可移动冻结面**断言的 `server/modules/voice/tests/*.false-forms.test.ts`（voice-capture-audio / -isolation / -off / -secrets / -text、voice-error-classification / -contract），一次红 8 条，整个 suite 落不了地。delta-relatedness 标为 UNRELATED 的正是这些断言冻结面的 voice 测试——这也解释了那 8 条红：红因是本条自己的 `.mjs`，那些测试只是把上游的 typecheck 面照实报红。

- **修法**：给 `scripts/mcp-smoke.mjs` 补 JSDoc（`@param` / `@returns` / `@typedef` + 少量内联 `@type` 收窄），并把 `api()` 的 catch-cause 折成 `errorText(unknown)` 助手；**不用** ts-ignore、**不**排除 `scripts/`、**不**放宽 `scripts/tsconfig.json`。无产品逻辑改动（`git diff` 仅注解 + 该等价重构 + 构造器补 `mcpRunId=''` 初值）。
- **AC11 逐条回绿**：`npx tsc --noEmit -p scripts/tsconfig.json` exit **0**；`npm run typecheck`（root + server + scripts 三段）exit **0**；`npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs` exit **0**；`git diff --stat develop...HEAD` 仅 `docs/proposals/cloudcli-mcp-smoke.md` / `scripts/mcp-smoke.mjs` / `scripts/mcp-smoke.test.mjs`（均 new），与 `## Touches` 对齐；产品代码一行未改。
- **未回归上一轮读数**：判据命令 exit 0（`node --test` = tests 25 / pass 25 / fail 0；`--check-record` 逐字 `记录合格：docs/proposals/cloudcli-mcp-smoke.md 八节齐全、每节 读数：/结论： 非空、端口不是 3001`）；AC10 两条 grep 均 0；并把上一轮红的三条 voice false-forms（audio / off / secrets）本地点验 **17/17 绿**，其内部 `npm run typecheck` 与 `npm run lint` 两臂均 exit 0，确认级联已随根因消失。
- **终态**：11/11 AC 绿；GOAL-020 的验收结论仍由人 yale 在 AC-257 给出。

## Needs-Human

**执行 2026-10-05T17:11:48.613Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-audio.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：e6db8590-94aa-4bc4-a618-60a7f2248104
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac256-mcp-nested-smoke-record~wk-prod-anchor~1791219795547-52a021.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac256-mcp-nested-smoke-record-wk-prod-anchor.log
