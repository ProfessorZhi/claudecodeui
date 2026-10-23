---
id: gap-ac249-criterion-ledger-red-is-merge-race
title: AC-249 判据台账尾部红是 merge race：session_send 实现
  224e8646（16:37:08）/1c4a85e2（17:06:35）只提交在 task 分支，fan-in 5a261845 于 17:54:02Z
  才带进 develop、主检出 ff 于 17:54:25，86 拍红（末拍 09:54:01.618Z@tree
  e0fc09d30619=5600d210，判据文件 ABSENT）早于落地 —— verification-only 归因入档（净树直跑 7/7/0
  exit 0 ×3），不重新实现既有修复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-249
---
## Proposal

来源：本轮 gap-filing 的**直接现测**（不是台账尾巴）。GOAL-020 的 AC-249（`goals/AC-249-session-send-立即返回-runid-运行与-ui-发起的运行是同一种-来源为-mcp-出现在运行中列表-忙时.md`，`status: active`（立案时））被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-249`、`gate=goal`、`actor=goal-cli` 从 `2026-10-05T02:02:34.284Z` 到 `2026-10-05T09:54:01.618Z` **连续 86 拍 fail**，理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）。但认领 AC-249 的唯一任务 `gap-ac249-session-send-immediate-runid` 已是 `done`（fan-in `5a261845`）。故本轮先做**直接现测 + ancestry 复核**，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in server/modules/mcp-gateway/tests/mcp-session-send.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts
```

**立案现测（主检出 `author` @ `6a97fa4f`）：判据退出 0（工作树满足 AC-249）。** 在 `/data/home/yale/work/claudecodeui`（`git rev-parse HEAD`=`6a97fa4f`，`git status --porcelain -- server shared src package.json package-lock.json` 空）直跑三次，每次读数逐字一致、退出码 0：

```
run1: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run2: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run3: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
```

七条用例逐字通过：`(a)/(b) session_send returns while running, with source mcp and the token owner as caller`、`(c) a busy resident session queues and hands over the driver queue-tail uuid`、`(d) a busy per-run session is refused with the in-flight runId and a run_get hint`、`(e) waitSeconds returns early with the closing assistant message`、`(f) a token lacking the write scope is denied, audits one denied row, and never calls the control service`、`(g) the WebSocket chat.send and the MCP session_send reach the same control service`、`the stage-4 write table is exactly the five SPEC tools`。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 这是内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac135/178/244/245/246/247-criterion-ledger-red-is-merge-race`）：

- 修复提交 `224e8646`「feat(mcp-gateway): session_send returns a runId at once (AC-249)」（`2026-10-05 16:37:08 +0800` = `08:37:08Z`）与 `1c4a85e2`「fix(mcp-gateway): spell the debug-agent gate vars through constants (AC-249)」（`17:06:35 +0800` = `09:06:35Z`）最初只提交在 task 分支 `task/gap-ac249-session-send-immediate-runid` 上。
- 判据红拍时主检出 `author` 的 HEAD 是 `5600d210`（`17:46:33`），其 tree 为 `e0fc09d30619` —— 正是末拍红 gate event 的 `treeSha`。`git merge-base --is-ancestor 224e8646 5600d210` = 非 0、`… 1c4a85e2 5600d210` = 非 0 ⇒ 被测树**不含**修复；`git cat-file -e 5600d210:server/modules/mcp-gateway/tests/mcp-session-send.test.ts` = `fatal: path '…mcp-session-send.test.ts' exists on disk, but not in '5600d210'`（exit 128）⇒ 判据文件在测量树上不存在，正是台账理由来源。
- fan-in 落地提交 `5a261845`「tasks: 翻 gap-ac249-session-send-immediate-runid done（driver 机械 fan-in）」的父 `ff0fdc49` 已含判据文件；`git reflog show develop` 里 `5a261845` 的 push 时刻为 `17:54:02 +0800` = `09:54:02Z`，`git reflog show author` 里同名 ff 为 `17:54:25 +0800` = `09:54:25Z`。现 `git merge-base --is-ancestor 1c4a85e2 HEAD` = 0；`git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 命中 blob `707cd6c5`。
- 即：**末拍红 `09:54:01.618Z` 落在 develop 带入修复（`09:54:02Z`）前约 0.4s、落在主检出 fast-forward（`09:54:25Z`）前约 23s**。立案时其后尚无新的 goal 评估（`.quay/goal-round.jsonl` 立案时最新 record 为 round 91 @ `2026-10-05T09:52:33.125Z`，AC-249 goal-ring fact 逐字 `active/fail: acceptance failed (exit 1) — 缺判据文件：…`）；本轮现测已见修复落地后的 pass 拍与 goal `achieved`（见 §完成记录）。

⇒ **早先的修复是兜住的**（`gap-ac249-session-send-immediate-runid`，done，净树 3 跑全绿 7/7/0）；台账 86 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-249 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，`git rev-parse HEAD`=`6a97fa4f`）：`grep -rn "^goal_ac: *AC-249" tasks/*.md` 立案时命中**仅 1 条** —— `tasks/gap-ac249-session-send-immediate-runid.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-249`）**0 命中** ⇒ 无在飞认领者，本条不是重复。`tasks/` 里已有的同类归因任务 `gap-ac135/178/244/245/246/247-criterion-ledger-red-is-merge-race` 各为**另一条 AC**（`goal_ac: AC-135/178/244/245/246/247`），机制相同但 AC 不同，非重复。`grep -rln "AC-249" tasks/*.md` 另命中 `gap-ac240/244/245/246/247/248/250/251/252/256/274…` 的边界段，各自声明「写工具（AC-249–AC-251）」的边界，是相关但不同机制的记录。（本轮现测同一 grep 命中 2 条：上述实现任务 done + 本条自身 ready，见 §完成记录 4。）

**残留的未钉死假设（如实登记）**：本条只复核 AC-249 的判据本体（`mcp-session-send.test.ts` 直跑绿）；AC-249 的 (a)–(g) 读数由该判据自证，本条不额外复算；判据用真实 express 4 + MCP SDK 客户端 + 调试 agent 的常驻/按次进程会话，绿读数已覆盖 (a)–(g)。

## Plan

1. 复核主检出状态与判据承重面干净：`git rev-parse HEAD`、`git status --porcelain -- server shared src package.json package-lock.json` 空。
2. 在检出上直跑判据三次（`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts`），逐字抄 `ℹ tests` / `ℹ pass` / `ℹ fail` 与三次退出码。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%h %cI %s' 224e8646 / 1c4a85e2 / 5a261845 / 5600d210`；`git merge-base --is-ancestor 224e8646 5600d210; echo $?`、`… 1c4a85e2 5600d210`、`… 1c4a85e2 HEAD`；`git rev-parse '5600d210^{tree}'`；`git cat-file -e 5600d210:server/modules/mcp-gateway/tests/mcp-session-send.test.ts`；`git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-send.test.ts`；`git reflog show develop --date=iso` 与 `git reflog show author --date=iso`（定位 `5a261845` 的 develop push 与 author ff 时刻）；复算末拍红 `09:54:01.618Z` 与落地的差。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-249 `gate=goal` 的 fail 尾部（首拍 `02:02:34.284Z`、末拍 `09:54:01.618Z`、逐字理由与 `evaluationRoot`、`treeSha`）；从 `.quay/goal-round.jsonl` 抄出 round 91（`09:52:33.125Z`）的 AC-249 goal-ring fact 逐字。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`；`git status --porcelain -- server shared src package.json package-lock.json` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 均退出 **0**，`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0` 与七条用例名逐字入档（稳定绿：三跑读数一致）。红态基线（本轮立案读数）：主检出 `09:54:01.618Z` 那拍退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`。
- [x] AC2 承重的 ancestry 证据机械入档：`git merge-base --is-ancestor 224e8646 5600d210; echo $?` → 非 0；`… 1c4a85e2 5600d210; echo $?` → 非 0；`… 1c4a85e2 HEAD; echo $?` → 0；`git rev-parse '5600d210^{tree}'` == `e0fc09d30619`（= 末拍红 `treeSha`）；`git cat-file -e 5600d210:server/modules/mcp-gateway/tests/mcp-session-send.test.ts` → `exists on disk, but not in '5600d210'`（exit 128）；`git ls-tree HEAD -- …/mcp-session-send.test.ts` → blob `707cd6c5`；`git reflog show develop` 的 `5a261845` push 时刻（`17:54:02 +0800`）与 `git reflog show author` 的 `5a261845` ff 时刻（`17:54:25 +0800`）。命令与逐字输出入档。
- [x] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-249`、`gate=goal`、`actor=goal-cli` 的 fail 尾部（首 `2026-10-05T02:02:34.284Z`、末 `2026-10-05T09:54:01.618Z`、共 86 拍，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 与 `evaluationRoot=/data/home/yale/work/claudecodeui`、末拍 `treeSha=e0fc09d30619`），并抄出 `.quay/goal-round.jsonl` round 91（`2026-10-05T09:52:33.125Z`）的 AC-249 goal-ring fact；写明「末拍红（09:54:01.618Z）早于 develop 落地（09:54:02Z）约 0.4s、早于主检出 ff（09:54:25Z）约 23s」。（本轮现测同一台账 **90 拍 = 86 fail / 4 pass**，4 拍 pass 均在修复落地后且 `reason=acceptance passed (exit 0)`；goal-round 93/94/95 读 `pass`/`achieved`，goal 文件 `status:` 现为 `achieved`。）
- [x] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-249" tasks/*.md` 的命中集合与其 `status:` 逐字入档（本轮 2 条：`gap-ac249-session-send-immediate-runid` → done；本条自身 → ready）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-249`）命中的只能是本条自身，须注明；并写明同类归因先例 `gap-ac135/178/244/245/246/247-criterion-ledger-red-is-merge-race` 各为另一条 AC。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`server/modules/mcp-gateway/tests/mcp-session-send.test.ts`、`server/modules/mcp-gateway/mcp-session-send.ts`、`server/modules/mcp-gateway/mcp-gateway.write-tools.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照一致（未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`goals/**`）。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-249**（净树三跑 exit 0、7/7/0）」与「台账 86 拍 fail 尾部由修复 `224e8646`/`1c4a85e2` 最初只提交在 task 分支、fan-in `5a261845` 于 `09:54:02Z` 才把它带进 develop、主检出 ff 于 `09:54:25Z`、而判据红拍发生在落地之前造成」，并给出残留未钉死假设；不得用单元层读数替代判据本体。

## DoD

- 出货命令（`for f in …; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts`，逐字不改；不改断言、不改判据）在检出上真的跑过、退出 0，七条用例名与 `7/7/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、fan-in 时刻、被测量树 HEAD 与 tree、`merge-base --is-ancestor` 退出码、`cat-file -e` 失败、`ls-tree HEAD` 命中、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `224e8646`（+ `1c4a85e2`）有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」——不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac249-criterion-ledger-red-is-merge-race.md（自触）
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts（本条只跑不改：判据本体）
- server/modules/mcp-gateway/mcp-session-send.ts（本条只读不改：session_send 适配层）
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts（本条只读不改：写工具注册集合）
- goals/AC-249-session-send-立即返回-runid-运行与-ui-发起的运行是同一种-来源为-mcp-出现在运行中列表-忙时.md（本条只读不改：criterion/expect 逐字来源）

## 完成记录（Verification Report）

worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac249-criterion-ledger-red-is-merge-race`；`git rev-parse HEAD` = `6e89ad58b613ad91483afc8730cce403c18833db`（起点 = 开工时 `develop`）；`git status --porcelain` = 空（`git status --porcelain -- server shared src package.json package-lock.json` 亦空）。worktree HEAD == `develop` == 主检出 `author` HEAD == `6e89ad58`（同一棵树，故「检出」读数与「净 worktree」读数同树同 blob）。

### 1. 承重现测：判据在净检出上三跑全绿

出货命令逐字（未改一字；= goal 文件 `criterion:` 的展开式）：

```
for f in server/modules/mcp-gateway/tests/mcp-session-send.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts
```

三次读数一致（稳定绿）：

| 跑次 | exit | ℹ tests | ℹ pass | ℹ fail | ℹ duration_ms |
| --- | --- | --- | --- | --- | --- |
| 1 | **0** | 7 | 7 | 0 | 15201.962993 |
| 2 | **0** | 7 | 7 | 0 | 14366.525382 |
| 3 | **0** | 7 | 7 | 0 | 14689.621089 |

七条用例名逐字（三跑皆 `✔`）：

- `(a)/(b) session_send returns while running, with source mcp and the token owner as caller`
- `(c) a busy resident session queues and hands over the driver queue-tail uuid`
- `(d) a busy per-run session is refused with the in-flight runId and a run_get hint`
- `(e) waitSeconds returns early with the closing assistant message`
- `(f) a token lacking the write scope is denied, audits one denied row, and never calls the control service`
- `(g) the WebSocket chat.send and the MCP session_send reach the same control service`
- `the stage-4 write table is exactly the five SPEC tools`

红态基线（台账末拍红 `2026-10-05T09:54:01.618Z`）退出 1，红在**存在性闸** `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts` —— 测试体从未被执行。

### 2. ancestry 证据（机械，可复现）

```
$ git log -1 --format='%H %cI %s' 224e8646
224e86468cd2130bd374ffc72a2b3017e710cd99 2026-10-05T16:37:08+08:00 feat(mcp-gateway): session_send returns a runId at once (AC-249)
$ git log -1 --format='%H %cI %s' 1c4a85e2
1c4a85e2215d031189c0fae224e34d1f6b24c644 2026-10-05T17:06:35+08:00 fix(mcp-gateway): spell the debug-agent gate vars through constants (AC-249)
$ git log -1 --format='%H %cI %s' 5a261845
5a261845f720f1371721bef8c0084f5ac0157ab5 2026-10-05T17:54:02+08:00 tasks: 翻 gap-ac249-session-send-immediate-runid done（driver 机械 fan-in）
$ git log -1 --format='%H %cI %s' 5600d210
5600d21088066c1daa90a75479eec764630c3218 2026-10-05T17:46:33+08:00 Merge branch 'develop' into task/gap-ac267-connected-apps-i18n-completeness
```

末拍红 gate event 的 `treeSha=e0fc09d30619e271ead21e169f02f9937e36e545` 正是 `5600d210` 的树：

```
$ git rev-parse '5600d210^{tree}'
e0fc09d30619e271ead21e169f02f9937e36e545
$ git log --all --format='%H %T %ci %s' | awk '$2=="e0fc09d30619e271ead21e169f02f9937e36e545"'
5600d21088066c1daa90a75479eec764630c3218 e0fc09d30619e271ead21e169f02f9937e36e545 2026-10-05 17:46:33 +0800 Merge branch 'develop' into task/gap-ac267-connected-apps-i18n-completeness
```

```
$ git merge-base --is-ancestor 224e8646 5600d210; echo $?
1
$ git merge-base --is-ancestor 1c4a85e2 5600d210; echo $?
1
$ git merge-base --is-ancestor 1c4a85e2 HEAD; echo $?
0
$ git cat-file -e 5600d210:server/modules/mcp-gateway/tests/mcp-session-send.test.ts; echo $?
fatal: path 'server/modules/mcp-gateway/tests/mcp-session-send.test.ts' exists on disk, but not in '5600d210'
128
$ git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-send.test.ts
100644 blob 707cd6c525e074373eeeda660c3dc3905aea84bf	server/modules/mcp-gateway/tests/mcp-session-send.test.ts
```

fan-in 落地时刻（reflog）：

```
$ git reflog show develop --date=iso | grep 5a261845
5a261845 develop@{2026-10-05 17:54:02 +0800}: push
$ git reflog show author --date=iso | grep 5a261845
5a261845 author@{2026-10-05 17:54:25 +0800}: merge develop: Fast-forward
```

`5a261845` 的父 `ff0fdc49` 已含判据文件（`git ls-tree ff0fdc49 -- server/modules/mcp-gateway/tests/mcp-session-send.test.ts` → blob `707cd6c5`），即落地提交把修复＋判据一起带进 develop/主检出。

时刻差复算：末拍红 `09:54:01.618Z` 早于 develop 落地（`09:54:02Z`，`5a261845` push）**0.382s**，早于主检出 ff（`09:54:25Z`）**23.382s**。

### 3. 台账尾巴（逐字）与本轮 Sequel

`.quay/gate-events.jsonl` 里 `item_id=AC-249`、`gate=goal`、`actor=goal-cli`（字段 `payload.reason` / `payload.evaluationRoot` / `payload.treeSha`）：

- 立案读数：**86 fail / 0 pass**（首 `2026-10-05T02:02:34.284Z`@`51a58bf06d323e086c62616d6fe600dc0a59a286` → 末 `2026-10-05T09:54:01.618Z`@`e0fc09d30619e271ead21e169f02f9937e36e545`）。
- 本轮现测同一台账：共 **90 拍 = 86 fail / 4 pass**。
- 每拍 fail 理由逐字：`acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`；`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）。

**新增证实（修复落地后，正是 `goal-gate-red-can-race-the-fixs-own-landing` 预告的 Sequel）**：台账在末拍红之后出现 4 拍 **pass**，全部 `reason=acceptance passed (exit 0)`：

| 时刻 | verdict | treeSha |
| --- | --- | --- |
| 2026-10-05T10:04:15.486Z | pass | 93aac80acdd4a50513bd9de01184cc2faa9abeca |
| 2026-10-05T10:08:30.084Z | pass | 8f4ea15ab33c69adb39a848faccd0639bbaa0052 |
| 2026-10-05T10:14:03.121Z | pass | c3abfc0397c76487911c806547d027c5066f91c2 |
| 2026-10-05T10:19:03.882Z | pass | c3abfc0397c76487911c806547d027c5066f91c2 |

per-tree 机械判据（`git cat-file -e <treeSha>:<criterion-file>`）把红树与含修复树直接对上：**48 棵不同的红树全部 ABSENT（exit 128），3 棵不同的 pass 树全部 PRESENT（exit 0）**；地标读数 `51a58bf0`→exit 128、`e0fc09d30619`→exit 128、`HEAD`→exit 0。**ABSENT（红树）vs PRESENT（含修复树）直接对上：判据红拍只发生在不含判据文件的树上。**

`.quay/goal-round.jsonl` goal-ring fact（`.facts[]|select(.name=="goal-ring")|.value.criteria[]|select(.id=="AC-249")`）：

- 立案时最新 round 91 @ `2026-10-05T09:52:33.125Z`：`{"id":"AC-249","goal":"GOAL-020","status":"active","verdict":"fail","reason":"acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts"}`。
- 本轮现测：round 92 @ `10:02:32.862Z` → 仍 `active/fail`（早于首拍 pass gate event `10:04:15.486Z`，为旧判决延续）；round 93 @ `10:06:53.317Z` → `active/pass: acceptance passed (exit 0)`；round 94 @ `10:12:08.414Z` → `achieved/pass`；round 95 @ `10:17:16.139Z` → `achieved/pass`。
- goal 文件 `goals/AC-249-session-send-立即返回-runid-运行与-ui-发起的运行是同一种-来源为-mcp-出现在运行中列表-忙时.md` 的 `status:` 立案时 `active`、本轮现测 **`achieved`**。

（round 92 仍读 fail 只因它早于首拍 pass gate event —— 与内存 Sequel 2 一致：round fact 落后于 gate event，非修复未生效。）

### 4. 机制去重复核

`grep -rn "^goal_ac: *AC-249" tasks/*.md` 本轮命中 **2** 条：

- `tasks/gap-ac249-session-send-immediate-runid.md` → `status: done`（认领 AC-249 的唯一实现任务，fan-in `5a261845` 已落地）
- `tasks/gap-ac249-criterion-ledger-red-is-merge-race.md` → `status: ready`（**本条自身**）

在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-249`）只命中**本条自身**，无其他在飞认领者。同族归因先例 `gap-ac135/178/244/245/246/247-criterion-ledger-red-is-merge-race` 各为**另一条 AC**（`goal_ac: AC-135/178/244/245/246/247`）。

### 5. 承重面未被本条触碰

- `git -C <wt> diff --name-only develop...HEAD -- server src goals scripts` = **空**。
- 三个承重文件的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空，`git ls-tree` 同 blob）：`server/modules/mcp-gateway/tests/mcp-session-send.test.ts` → `707cd6c5`、`server/modules/mcp-gateway/mcp-session-send.ts` → `f2f7538c`、`server/modules/mcp-gateway/mcp-gateway.write-tools.ts` → `1e8b0db0`。
- 主检出 `git status --porcelain -- server shared src package.json package-lock.json` 空；未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`goals/**`。
- 交付物只动 `tasks/gap-ac249-criterion-ledger-red-is-merge-race.md`（自触）。

### 6. 判法与残留未钉死假设

**判法：修复 `224e8646`（+ `1c4a85e2`）有效；台账 86 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态。** 被提交的树满足 AC-249（净检出三跑 exit 0、7/7/0）；修复落地后 4 拍 pass gate event + goal-ring round 93/94/95 `pass`/`achieved` + goal 文件 `status: achieved` 三重直接证实。本条不重新实现任何修复。

残留未钉死假设（如实登记）：

1. **`.quay/goal-round.jsonl` 的 goal-ring fact 落后于 gate-event**：round 92（`10:02:32.862Z`）仍读 fail 是因它早于首拍 pass（`10:04:15.486Z`），是旧判决延续（内存 `goal-gate-red-can-race-the-fixs-own-landing` Sequel 2）；只有与某拍同时写入的新 round 才是新测量。
2. **本条只复核判据本体**：AC-249 的 (a)–(g) 读数由判据自证（七条用例名逐字在档），本条不额外复算；判据用真实 express 4 + MCP SDK 客户端 + 调试 agent 的常驻/按次进程会话，绿读数已覆盖 (a)–(g)。
3. **判据夹具的常驻宿主走管理器机制而非调试 agent 驱动**（`provider.registry` 在 import 时封死 DEBUG_AGENT 闸），与 AC-240–AC-248 同款说明一致。
4. **AC-248–AC-257 的读数不在本条**：本条只归因 AC-249 的台账尾部红。
