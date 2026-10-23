---
id: gap-ac245-criterion-ledger-red-is-merge-race
title: AC-245 判据台账尾部红是 merge race：read-tools 实现 85db9402（14:31:39）只提交在 task
  分支，fan-in f466a4b0 于 06:44:56Z 才带进 develop，41 拍红（末拍 06:43:25Z@tree
  8452dcc3/c9ef86a0，判据文件 ABSENT）早于落地约 90s —— verification-only 归因入档（当前检出直跑 exit
  0，6/6/0），不重新实现
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-245
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。GOAL-020 的 AC-245（`goals/AC-245-只读工具在夹具数据上返回正确结果-项目与会话列表-会话详情含宿主状态-读取最近消息与大纲与窗口-长文本按游标分页且拼回原.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-245`、`gate=goal`、`actor=goal-cli` 从 `2026-10-05T02:02:31.920Z` 到 `2026-10-05T06:43:25.855Z` **连续 41 拍 fail**，理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）。但认领 AC-245 的唯一任务 `gap-ac245-mcp-read-tools-fixture-readings` 已是 `done`（fan-in `f466a4b0`）。故本轮先做**直接现测 + ancestry 复核**，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in server/modules/mcp-gateway/tests/mcp-read-tools.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
```

**本轮直接现测：判据在当前检出上退出 0（工作树满足 AC-245）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`）直跑两次（立案前 1 次 + 立案时 1 次），两次读数逐字一致、退出码 0：

```
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

六条用例逐字通过：`(a) tools/list is exactly the stage-3 read tools, none of them a write tool`、`(b) projects_list and sessions_list return the whole fixture and partition it by state`、`(c) session_get carries the resident host and says a cold session has none`、`(d) session_read: latest folds the tool call, outline lists every user turn, around centres a window`、`(e) text over the chunk ceiling is paginated by cursor and reassembles byte for byte`、`(f) every time field carries both the relative and the ISO reading`。

而台账那批 fail 的逐字理由只到**存在性闸**：`缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`（判据文件在被测量的那棵树里根本不存在，测试未被执行）。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac244-criterion-ledger-red-is-merge-race`、`gap-ac135-criterion-ledger-red-is-merge-race`、`gap-ac178-criterion-ledger-red-is-merge-race`）：

- 修复提交 `85db9402`「feat(mcp-gateway): stage-3 read tools over the injected services (AC-245)」（`2026-10-05 14:31:39 +0800`）**最初只提交在 task 分支 `task/gap-ac245-mcp-read-tools-fixture-readings` 上**（`git log --all --diff-filter=A` 显示 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 与 `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 两文件均由 `85db9402` 新增）。
- 任务分支把 `develop` 合并进来的 `f2ba4ee9`（`14:36:08 +0800`）已含 `85db9402`（`git merge-base --is-ancestor 85db9402 f2ba4ee9` = 0），但该合并只落在 **task 分支**，主检出 `author` 当时仍停在 `c9ef86a0`（`14:35:37 +0800`）。
- 判据最后一拍红 `2026-10-05T06:43:25.855Z`（= `14:43:25 +0800`）测量的树 `treeSha=8452dcc3c14d5487bd24895049a0a73fa20035cc` **就是 `c9ef86a0` 的树**；`git cat-file -e c9ef86a0:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 报 `fatal: path '...' exists on disk, but not in 'c9ef86a0'`（exit 128）⇒ 判据文件在测量树上不存在，正是台账理由的来源。
- fan-in 落地提交 `f466a4b0`「tasks: 翻 gap-ac245-mcp-read-tools-fixture-readings done（driver 机械 fan-in）」在 `2026-10-05 14:44:56 +0800`（= `06:44:56Z`；`author` Fast-forward 于 `14:45:10`）才把 `85db9402` 带进 `develop`/主检出。现 `git merge-base --is-ancestor 85db9402 develop` = 0、`… 85db9402 HEAD` = 0；`git show develop:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts | head -3` 命中文件头 `/** AC-245 criterion: the stage-3 read tools answer correctly on fixture data.`。
- 即：**最后一拍红 `06:43:25.855Z` 比修复落进 develop/主检出 `06:44:56Z` 早约 90 秒**（`06:44:56 − 06:43:25.855 = 90.145s`）。此后尚无新的一拍 goal 评估（`.quay/goal-round.jsonl` 最新 record 为 round 46 @ `06:42:26.253Z`，其 AC-245 fact 仍读 fail —— 那是**上一拍 gate-event 判决的延续**，中间无新 gate-event，非修复未生效）。

⇒ **早先的修复是兜住的**（`gap-ac245-mcp-read-tools-fixture-readings`，done，净树 6/6/0）；台账 41 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-245 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rn "^goal_ac: *AC-245" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-ac245-mcp-read-tools-fixture-readings.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-245`）**0 命中**（唯一命中者是 done 那条）⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac244-criterion-ledger-red-is-merge-race`（`goal_ac: AC-244`，done）、`gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`）、`gap-ac178-criterion-ledger-red-is-merge-race`（`goal_ac: AC-178`）各为**另一条 AC**，仅归因机制相同。

**残留未钉死假设（如实登记）**：
1. **常驻夹具的宿主驱动是脚本书写驱动，不是调试 agent 驱动**：`provider.registry.ts` 在模块加载时就调 `createDebugAgentProvider`，把 DEBUG_AGENT 闸读成 closed，判据自身的（传递）静态导入恒使 `createDebugAgentHostDriver` 返回 null；夹具经 `createSessionHostManager` + `bindSession` + lease 账本 + 文档化 identity sink 上报 peerName/lease，从 `snapshot()`/`liveHostForSession()` 读回 —— AC 的「调试 agent 宿主驱动」以管理器机制兑现，未字面用调试 agent 驱动（与内存 `debug-agent-gate-is-sealed-closed-by-any-providers-barrel-import` 一致）。
2. **`overview`/`run_get`/`quay_snapshot` 的行为尚未实现**：本判据只按名字/scope/输入 schema 注册这三个工具，handler 返回 `MCP_TOOL_NOT_IMPLEMENTED` 并注明归 AC-247/AC-248；(a) 的「恰好是只读工具集合」成立，但这三个工具的行为归 AC-247/AC-248 的判据。
3. **`McpReadToolDeps` 只声明本判据真读到的成员**（`runs: { listRunningRuns }`）；`getRunById`、`activity` 归 AC-247/AC-248，落地时由该任务扩展 deps。
4. **scope 字面量 `cloudcli:read`**：AC-243 已落地时从 `@/modules/oauth/index.js` 导入该常量，判据按常量校验。

本任务是 **verification-only 归因入档**：不改实现、判据、goals、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据**三次**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`），逐字抄 `ℹ tests` / `ℹ pass` / `ℹ fail` 与三次退出码；六条用例名逐字入档（稳定绿：三跑读数一致）。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%H %ci %s' 85db9402` / `f2ba4ee9` / `f466a4b0` / `c9ef86a0`；`git merge-base --is-ancestor 85db9402 c9ef86a0; echo $?`、`… 85db9402 f466a4b0; echo $?`、`… 85db9402 develop; echo $?`、`… 85db9402 HEAD; echo $?`；`git cat-file -e c9ef86a0:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`；`git show develop:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts | head -3`；复算「最后一拍红 `06:43:25.855Z` < fan-in 落地 `06:44:56Z`」≈ 90s。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-245 `gate=goal` 的 fail 首拍与尾部（含逐字理由、`evaluationRoot`、`treeSha`）；从 `.quay/goal-round.jsonl` 抄出最新 round（46，`06:42:26.253Z`）的 AC-245 goal-ring fact；用 per-tree 机械判据（`git cat-file -e <treeSha>:<criterion-file>`）把「红树 ABSENT / 现树 PRESENT」对上。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 均退出 **0**，`ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0` 与六条用例名逐字入档（稳定绿：三跑读数一致）。红态基线（本轮立案读数）：当前检出直跑 exit 0；台账末拍红 `2026-10-05T06:43:25.855Z` 退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`。
- [x] AC2 承重的 ancestry 证据机械入档：`git log -1 --format='%H %ci %s' 85db9402` → 修复提交 `2026-10-05 14:31:39 +0800`（task 分支）；`… f2ba4ee9` → task 分支合并 develop `14:36:08 +0800`；`… f466a4b0` → fan-in `14:44:56 +0800`（=`06:44:56Z`）；`… c9ef86a0` → 末拍红时主检出 HEAD `14:35:37 +0800`；`git merge-base --is-ancestor 85db9402 c9ef86a0; echo $?` → **非 0**；`… 85db9402 f466a4b0; echo $?` → 0；`… 85db9402 develop; echo $?` → 0；`… 85db9402 HEAD; echo $?` → 0；`git cat-file -e c9ef86a0:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` → 报 `exists on disk, but not in 'c9ef86a0'`；`git show develop:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts | head -3` 命中文件头。命令与逐字输出入档；复算 `06:44:56 − 06:43:25.855 = 90.145s ≈ 90s`。
- [x] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-245`、`gate=goal`、`actor=goal-cli` 的判决计数（41 fail）与首拍/尾部（至少首 `2026-10-05T02:02:31.920Z`、末 `2026-10-05T06:43:25.855Z`，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`、`evaluationRoot=/data/home/yale/work/claudecodeui`、`treeSha`），并抄出 `.quay/goal-round.jsonl` 最新 round（46，`2026-10-05T06:42:26.253Z`）的 AC-245 goal-ring fact；写明「最后一拍红（`06:43:25.855Z`）早于 fan-in 落地（`06:44:56Z`）约 90s」；用 per-tree 判据把红树（`8452dcc3`/`c9ef86a0`）与现树（`develop`/`HEAD`）的判据文件存在性直接对上（ABSENT vs PRESENT）。
- [x] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-245" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-ac245-mcp-read-tools-fixture-readings`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-245`）命中的只能是本条自身，须注明；并写明同族先例 `gap-ac244-criterion-ledger-red-is-merge-race` / `gap-ac135-…` / `gap-ac178-…`（各为另一条 AC）。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`、`server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `server/**`、`goals/**`）。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-245**（净树三跑 exit 0、6/6/0）」与「台账 41 拍 fail 尾部由修复 `85db9402` 最初只提交在 task 分支、fan-in `f466a4b0` 于 `06:44:56Z` 才把它带进 develop/主检出、而判据红拍发生在落地之前造成」，并给出残留未钉死假设（脚本书写宿主驱动而非调试 agent 驱动；`overview`/`run_get`/`quay_snapshot` 行为归 AC-247/248；deps 只声明 `listRunningRuns`；scope 常量来源）；⛔ 不得用单元层读数替代判据本体。

## DoD

- 出货命令（`for f in server/modules/mcp-gateway/tests/mcp-read-tools.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`，逐字不改；⛔ 不改断言、不改判据）在净检出上真的跑过、退出 0，六条用例名与 `6/6/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、task 分支合并时刻、fan-in 时刻、被测量树 HEAD、`merge-base --is-ancestor` 退出码、`git show develop:…` 命中、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `85db9402` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- `tasks/gap-ac245-criterion-ledger-red-is-merge-race.md`（自触）
- `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`（本条只跑不改：判据本体）
- `server/modules/mcp-gateway/mcp-gateway.read-tools.ts`（本条只读不改：只读工具实现 / `paginateMcpText` / `formatMcpTime`）
- `goals/AC-245-只读工具在夹具数据上返回正确结果-项目与会话列表-会话详情含宿主状态-读取最近消息与大纲与窗口-长文本按游标分页且拼回原.md`（本条只读不改：criterion/expect 逐字来源）

## 完成记录（verification-only 归因入档；本轮 worker，2026-10-05）

**判法（逐字）**：修复 `85db9402` 有效；台账 41 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态。**被提交的树满足 AC-245**（净树三跑 exit 0、6/6/0）。本条未改实现、判据、goals、宿主配置一个字节，未动任何在飞 WIP。

### AC1 净检出直跑三次 —— 判据绿

- worktree 路径：`/data/home/yale/work/claudecodeui-worktrees/gap-ac245-criterion-ledger-red-is-merge-race`
- worktree `git rev-parse HEAD` = `680281039fffcb4252703b6680fbd8a27c625d81`（= 开工时 `develop`；主检出 `author` 同此 SHA）
- worktree `git branch --show-current` = `task/gap-ac245-criterion-ledger-red-is-merge-race`
- worktree `git status --porcelain` = 空（0 行，与开工快照逐字相同）
- worktree 起点 = `develop`（`dispatch-worktree-setup.sh` 自检 `fork-point PASS — HEAD contains develop (680281039fffcb4252703b6680fbd8a27c625d81)`），node_modules 已 `<main>/node_modules` 符号链接

出货命令（逐字，cwd = worktree）：

```
for f in server/modules/mcp-gateway/tests/mcp-read-tools.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
```

三次读数逐字一致：

```
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

退出码：`RUN1 EXIT=0`、`RUN2 EXIT=0`、`RUN3 EXIT=0`（三次 `duration_ms` 分别 5080.061133 / 4350.468607 / 4487.821048）。

六条用例名（逐字，均 `✔` 通过）：

1. `(a) tools/list is exactly the stage-3 read tools, none of them a write tool`
2. `(b) projects_list and sessions_list return the whole fixture and partition it by state`
3. `(c) session_get carries the resident host and says a cold session has none`
4. `(d) session_read: latest folds the tool call, outline lists every user turn, around centres a window`
5. `(e) text over the chunk ceiling is paginated by cursor and reassembles byte for byte`
6. `(f) every time field carries both the relative and the ISO reading`

**红态基线（对照，取自台账，本轮未复现）**：主检出 `2026-10-05T06:43:25.855Z` 那拍退出 1，红在**存在性闸** `缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` —— 即判据文件在**被测量的那棵树**里根本不存在，测试未被执行（非断言失败）。

### AC2 ancestry 证据（机械复核，命令与逐字输出）

```
$ git log -1 --format='%H %ci %s' 85db9402
85db94022cdaf4114f79a355db802b6a14e0d96a 2026-10-05 14:31:39 +0800 feat(mcp-gateway): stage-3 read tools over the injected services (AC-245)
$ git log -1 --format='%H %ci %s' f2ba4ee9
f2ba4ee913c469f4dd668274df76f3d9911f5516 2026-10-05 14:36:08 +0800 Merge branch 'develop' into task/gap-ac245-mcp-read-tools-fixture-readings
$ git log -1 --format='%H %ci %s' f466a4b0
f466a4b08b5f49f01650ec7d1307efdc5be18827 2026-10-05 14:44:56 +0800 tasks: 翻 gap-ac245-mcp-read-tools-fixture-readings done（driver 机械 fan-in）
$ git log -1 --format='%H %ci %s' c9ef86a0
c9ef86a03c285bcf2434ca6d6c1616f07d7b3eee 2026-10-05 14:35:37 +0800 tasks: gap-ac245-mcp-read-tools-fixture-readings task_write by cli:3118751

$ git merge-base --is-ancestor 85db9402 c9ef86a0; echo $?
1
$ git merge-base --is-ancestor 85db9402 f2ba4ee9; echo $?
0
$ git merge-base --is-ancestor 85db9402 f466a4b0; echo $?
0
$ git merge-base --is-ancestor 85db9402 develop; echo $?
0
$ git merge-base --is-ancestor 85db9402 HEAD; echo $?
0

$ git cat-file -e c9ef86a0:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts; echo $?
fatal: path 'server/modules/mcp-gateway/tests/mcp-read-tools.test.ts' exists on disk, but not in 'c9ef86a0'
128

$ git show develop:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts | head -3
/**
 * AC-245 criterion: the stage-3 read tools answer correctly on fixture data.
 *

$ git rev-parse c9ef86a0^{tree}
8452dcc3c14d5487bd24895049a0a73fa20035cc
$ git rev-parse develop HEAD
680281039fffcb4252703b6680fbd8a27c625d81
680281039fffcb4252703b6680fbd8a27c625d81
```

读法：`85db9402` 在**被测量树 `c9ef86a0` 里不是祖先**（exit 1），判据文件在该树不存在（`exists on disk, but not in 'c9ef86a0'`，exit 128）；而它**已是 `f2ba4ee9` / `f466a4b0` / `develop` / `HEAD` 的祖先**（exit 0），`git show develop:…` 命中文件头。

**时刻换算**：`85db9402` = `06:31:39Z`；`f2ba4ee9` = `06:36:08Z`；`c9ef86a0` = `06:35:37Z`；`f466a4b0` = `06:44:56Z`。`c9ef86a0^{tree}` = `8452dcc3…` = 台账末拍红的 `treeSha`。时刻差：`06:44:56 − 06:43:25.855 = ` **90.145s ≈ 90s**。

### AC3 台账尾巴 + 竞态闭合（本轮新增读数）

`.quay/gate-events.jsonl` 里 `item_id=AC-245`、`gate=goal`、`actor=goal-cli` 的判决计数：**41 fail + 1 pass**（共 42 拍；`evaluationRoot` 逐字恒为 `/data/home/yale/work/claudecodeui`）。

fail 首拍（逐字）：

```json
{"id":"2e97b610-61df-4e52-8e5e-00a8cf60b14f","item_id":"AC-245","pipeline_id":"AC-245","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-10-05T02:02:31.920Z","payload":{"reason":"acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts","evaluationRoot":"/data/home/yale/work/claudecodeui","treeSha":"51a58bf06d323e086c62616d6fe600dc0a59a286"}}
```

fail 尾部（逐字，最后两拍）：

```json
{"id":"1ac0438e-3fe8-4a0d-93ee-6af17fa707e8","item_id":"AC-245","pipeline_id":"AC-245","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-10-05T06:38:52.389Z","payload":{"reason":"acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts","evaluationRoot":"/data/home/yale/work/claudecodeui","treeSha":"8452dcc3c14d5487bd24895049a0a73fa20035cc"}}
{"id":"50dba50b-e150-45e2-bf2e-70ffb077ceab","item_id":"AC-245","pipeline_id":"AC-245","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-10-05T06:43:25.855Z","payload":{"reason":"acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts","evaluationRoot":"/data/home/yale/work/claudecodeui","treeSha":"8452dcc3c14d5487bd24895049a0a73fa20035cc"}}
```

`.quay/goal-round.jsonl` 最新 round（47，`2026-10-05T06:49:43.965Z`）AC-245 goal-ring fact（逐字）：

```json
{"id":"AC-245","goal":"GOAL-020","status":"active","verdict":"fail","reason":"acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-read-tools.test.ts"}
```

（round 46 `2026-10-05T06:42:26.253Z` 逐字同上；round 47 仍读 fail 是**上一拍 gate-event 判决的延续** —— 其前最近一拍仍是 `06:43:25.855Z` 的 fail，中间无新 gate-event。）

**「最后一拍红（`06:43:25.855Z`）早于 fan-in 落地（`06:44:56Z`）约 90s」** —— 成立（`90.145s`）。

**竞态闭合（立案时台账尚无的读数，本轮实测补入）**：修复落地后 goal 环形评估**翻绿**，`gate-events.jsonl` 出现唯一一拍 pass：

```json
{"id":"41d4cfa1-e7fe-469a-8ae3-db99ff9b8ee9","item_id":"AC-245","pipeline_id":"AC-245","gate":"goal","actor":"goal-cli","verdict":"pass","timestamp":"2026-10-05T06:50:49.172Z","payload":{"reason":"acceptance passed (exit 0)","evaluationRoot":"/data/home/yale/work/claudecodeui","treeSha":"6a9e29cae0d539375c1eee464c15cd853cccfbfe"}}
```

`goals/AC-245-只读工具在夹具数据上返回正确结果-项目与会话列表-会话详情含宿主状态-读取最近消息与大纲与窗口-长文本按游标分页且拼回原.md` frontmatter 现为 `status: achieved`（`cbc7dbcc goals: AC-245 status active→achieved by cli:1415180`）。

**per-tree 机械判据（决定性）**：把三棵被测量树与判据文件的存在性直接对上 ——

```
51a58bf06d323e086c62616d6fe600dc0a59a286 -> ABSENT   (02:02:31.920Z 首拍红, exit 128)
8452dcc3c14d5487bd24895049a0a73fa20035cc -> ABSENT   (06:38:52.389Z / 06:43:25.855Z 尾部红, exit 128; = c9ef86a0 的树)
6a9e29cae0d539375c1eee464c15cd853cccfbfe -> PRESENT  (06:50:49.172Z 拍绿, exit 0)
```

即：**同一判据、同一命令，只在「修复已落地」的树上才存在判据文件** —— 红/绿的唯一自变量是**被测量树含不含修复**，与判据本身无关。

### AC4 机制去重复核

```
$ grep -rn "^goal_ac: *AC-245" tasks/*.md
tasks/gap-ac245-mcp-read-tools-fixture-readings.md:19:goal_ac: AC-245
tasks/gap-ac245-criterion-ledger-red-is-merge-race.md:14:goal_ac: AC-245
--- statuses ---
tasks/gap-ac245-criterion-ledger-red-is-merge-race.md -> status: ready
tasks/gap-ac245-mcp-read-tools-fixture-readings.md -> status: done
```

- 认领 AC-245 的唯一既有任务 `gap-ac245-mcp-read-tools-fixture-readings` = `status: done`（fan-in `f466a4b0`）。
- 在飞扫描（`status` ∈ todo/ready/needs-human 且 `goal_ac: AC-245`）**唯一命中是本条自身**（`gap-ac245-criterion-ledger-red-is-merge-race`，`ready`）⇒ 无第二条在飞认领者，本条不是重复。
- 同族先例（各为**另一条 AC**，非本 AC 重复）：`gap-ac244-criterion-ledger-red-is-merge-race`（`goal_ac: AC-244`，done）、`gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`）、`gap-ac178-criterion-ledger-red-is-merge-race`（`goal_ac: AC-178`）。仅归因机制相同（merge race）。

### AC5 承重面未被本条触碰

```
$ git diff --name-only develop...HEAD -- server src goals scripts
(空，0 行)

$ git diff --stat develop -- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
(空)
$ git diff --stat develop -- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
(空)
$ git rev-parse HEAD:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts develop:server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
fdb99951784871c28aa08f0fc2fad35349e9c697
fdb99951784871c28aa08f0fc2fad35349e9c697
$ git rev-parse HEAD:server/modules/mcp-gateway/mcp-gateway.read-tools.ts develop:server/modules/mcp-gateway/mcp-gateway.read-tools.ts
b51367af97949727011ec71fcbf7547a3f5b5c73
b51367af97949727011ec71fcbf7547a3f5b5c73

$ git status --porcelain
(空，0 行 —— 与开工快照逐字相同)
$ git diff --name-only develop...HEAD
(空，0 行)
```

未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`goals/**`；本 worktree 的唯一提交是 `tasks/<本条 id>.md`（`task_write` 自提交）。

### AC6 残留未钉死假设（如实登记）

1. **常驻夹具的宿主驱动是脚本书写驱动，不是调试 agent 驱动**：`provider.registry.ts` 在模块加载时就调 `createDebugAgentProvider`，把 DEBUG_AGENT 闸读成 closed，判据自身的（传递）静态导入恒使 `createDebugAgentHostDriver` 返回 null；夹具经 `createSessionHostManager` + `bindSession` + lease 账本 + 文档化 identity sink 上报 peerName/lease，从 `snapshot()` / `liveHostForSession()` 读回 —— AC 的「调试 agent 宿主驱动」以管理器机制兑现，未字面用调试 agent 驱动（与内存 `debug-agent-gate-is-sealed-closed-by-any-providers-barrel-import` 一致）。
2. **`overview` / `run_get` / `quay_snapshot` 的行为尚未实现**：本判据只按名字/scope/输入 schema 注册这三个工具，handler 返回 `MCP_TOOL_NOT_IMPLEMENTED` 并注明归 AC-247 / AC-248；(a) 的「恰好是只读工具集合」成立，但这三个工具的行为归 AC-247 / AC-248 的判据。
3. **`McpReadToolDeps` 只声明本判据真读到的成员**（`runs: { listRunningRuns }`）；`getRunById`、`activity` 归 AC-247 / AC-248，落地时由该任务扩展 deps。
4. **scope 字面量 `cloudcli:read`**：AC-243 已落地时从 `@/modules/oauth/index.js` 导入该常量，判据按常量校验。

**⛔ 未使用单元层读数替代判据本体**：AC1 的 6/6/0 是判据本体（`npx tsx --test`）在净检出上的真实执行读数；AC2 / AC3 是 git ancestry 与台账逐字记录，非复述 AC 文字。
