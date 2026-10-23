---
id: gap-ac250-criterion-ledger-red-is-merge-race
title: AC-250 判据台账尾部红是 merge race：session_create/session_interrupt 实现
  061da3d2（10:08:04Z）只提交在 task 分支、fan-in 6e89ad58（10:20:24Z）才带进 develop、主检出 ff 于
  10:20:31Z，末拍红 10:19:16Z 早于落地 —— verification-only 归因入档（净树直跑 7/7/0 exit 0
  ×3），不重新实现既有修复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-250
---
## Proposal

来源：本轮 gap-filing 的**直接现测**。GOAL-020 的 AC-250（`goals/AC-250-session-create-与-session-interrupt-创建会话-可带首条消息-中止运行但常驻进程保留-对.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-250`、`gate=goal`、`actor=goal-cli` 自 `2026-10-05T02:02:34.885Z` 至 `2026-10-05T10:19:16.066Z` **连续 90 拍 fail**，理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）。认领 AC-250 的唯一任务 `gap-ac250-session-create-interrupt-lifecycle` 已是 `done`（fan-in `6e89ad58`）。故本轮先做**直接现测 + ancestry 复核**，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
```

**本轮直接现测：判据在检出上退出 0（工作树满足 AC-250）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD`=`6e89ad58`，tree=`1e89b65c`，`git status --porcelain -- server shared src package.json package-lock.json` 空）直跑三次，每次读数逐字一致、退出码 0：

```
run1: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run2: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run3: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
```

七条用例逐字通过：`(a) session_create with a message returns the live runId; without one it starts nothing`、`(b) an ambiguous project name is refused creating nothing; a unique one creates the row`、`(c) a token lacking cloudcli:session:create is denied, audits one denied row, and never creates`、`(d) session_interrupt aborts the running resident turn and leaves the host pid unchanged`、`(e) session_interrupt on an idle session reports aborted:false with the no-run message`、`(f) a token lacking cloudcli:session:control is denied, audits one denied row, and never aborts`、`the stage-4 write table still names the five SPEC tools with their scopes`。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 这是内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac135/178/244/245/246/247/249-criterion-ledger-red-is-merge-race`）：

- 修复提交 `061da3d2`「feat(mcp-gateway): implement session_create and session_interrupt (AC-250)」（`2026-10-05 18:08:04 +0800` = `10:08:04Z`）最初只提交在 task 分支 `task/gap-ac250-session-create-interrupt-lifecycle` 上。
- 判据红拍时主检出 `author` 所测的树是 `c3abfc0397c76487911c806547d027c5066f91c2`（= 提交 `f770b89f`，`18:11:46 +0800`）——正是末拍红 gate event 的 `treeSha`。`git merge-base --is-ancestor 061da3d2 f770b89f` = 非 0 ⇒ 被测树**不含**修复；`git cat-file -e c3abfc0:server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` = `fatal: path '…mcp-session-lifecycle.test.ts' exists on disk, but not in 'c3abfc0'`（exit 128）⇒ 判据文件在测量树上不存在，正是台账理由来源。
- fan-in 落地提交 `6e89ad58`「tasks: 翻 gap-ac250-session-create-interrupt-lifecycle done（driver 机械 fan-in）」（`18:20:24 +0800` = `10:20:24Z`）；`git reflog show develop --date=iso` 的 `6e89ad58 develop@{2026-10-05 18:20:24 +0800}: push`、`git reflog show author --date=iso` 的 `6e89ad58 author@{2026-10-05 18:20:31 +0800}: merge develop: Fast-forward`。现 `git merge-base --is-ancestor 061da3d2 HEAD` = 0；`git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` 命中 blob `b17610b0`。
- 即：**末拍红 `10:19:16.066Z` 落在 develop 带入修复（`10:20:24Z`）前约 68s、落在主检出 fast-forward（`10:20:31Z`）前约 75s**。此后尚无新的 goal 评估（`.quay/goal-round.jsonl` 最新 record 为 round 95 @ `2026-10-05T10:17:16.139Z`，AC-250 goal-ring fact 逐字 `active/fail: acceptance failed (exit 1) — 缺判据文件：…`）。

⇒ **早先的修复是兜住的**（`gap-ac250-session-create-interrupt-lifecycle`，done，净树 3 跑全绿 7/7/0）；台账 90 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-250 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，`git rev-parse HEAD`=`6e89ad58`）：`grep -rn "^goal_ac: *AC-250" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-ac250-session-create-interrupt-lifecycle.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-250`）**0 命中** ⇒ 无在飞认领者，本条不是重复。`tasks/` 里已有的同类归因任务 `gap-ac135/178/244/245/246/247/249-criterion-ledger-red-is-merge-race` 各为**另一条 AC**（`goal_ac: AC-135/178/244/245/246/247/249`），机制相同但 AC 不同，非重复。

**残留的未钉死假设（如实登记）**：本条只复核 AC-250 的判据本体（`mcp-session-lifecycle.test.ts` 直跑绿）；AC-250 的 (a)–(f) 读数由该判据自证，本条不额外复算；判据用真实 express 4 + MCP SDK 客户端 + 真实 better-sqlite3 临时库 + 调试 agent 的常驻/按次进程会话，绿读数已覆盖 (a)–(f) 与三条取假形态。

## Plan

1. 复核主检出状态与判据承重面干净：`git rev-parse HEAD`、`git status --porcelain -- server shared src package.json package-lock.json` 空。
2. 在检出上直跑判据三次（`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`），逐字抄 `ℹ tests` / `ℹ pass` / `ℹ fail` 与三次退出码。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%h %cI %s' 061da3d2 / f770b89f / 6e89ad58`；`git merge-base --is-ancestor 061da3d2 f770b89f; echo $?`、`… 061da3d2 HEAD; echo $?`；`git rev-parse 'f770b89f^{tree}'`；`git cat-file -e c3abfc0397c76487911c806547d027c5066f91c2:server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`；`git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`；`git reflog show develop --date=iso` 与 `git reflog show author --date=iso`（定位 `6e89ad58` 的 develop push 与 author ff 时刻）；复算末拍红 `10:19:16.066Z` 与落地的差。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-250 `gate=goal` 的 fail 尾部（首拍 `02:02:34.885Z` @tree `51a58bf0…`、末拍 `10:19:16.066Z` @tree `c3abfc0…`、共 90 拍、逐字理由与 `evaluationRoot`）；从 `.quay/goal-round.jsonl` 抄出 round 95（`10:17:16.139Z`）的 AC-250 goal-ring fact 逐字。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**检出**（`git status --porcelain -- server shared src package.json package-lock.json` 空；打印 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` 均退出 **0**，`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0` 与七条用例名逐字入档。红态基线（本轮立案读数）：主检出 `10:19:16.066Z` 那拍退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`。
- [x] AC2 承重的 ancestry 证据机械入档：`git merge-base --is-ancestor 061da3d2 f770b89f; echo $?` → 非 0；`… 061da3d2 HEAD; echo $?` → 0；`git rev-parse 'f770b89f^{tree}'` == `c3abfc0397c76487911c806547d027c5066f91c2`（= 末拍红 `treeSha`）；`git cat-file -e c3abfc0:server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` → `exists on disk, but not in 'c3abfc0'`（exit 128）；`git ls-tree HEAD -- …/mcp-session-lifecycle.test.ts` → blob `b17610b0`；`git reflog show develop` 的 `6e89ad58` push 时刻（`18:20:24 +0800`）与 `git reflog show author` 的 `6e89ad58` ff 时刻（`18:20:31 +0800`）。命令与逐字输出入档。
- [x] AC3 台账尾部逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-250`、`gate=goal`、`actor=goal-cli` 的 fail 尾部（首 `2026-10-05T02:02:34.885Z` @tree `51a58bf0…`、末 `2026-10-05T10:19:16.066Z` @tree `c3abfc0…`、共 90 拍，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` 与 `evaluationRoot=/data/home/yale/work/claudecodeui`），并抄出 `.quay/goal-round.jsonl` round 95（`2026-10-05T10:17:16.139Z`）的 AC-250 goal-ring fact；写明「末拍红（`10:19:16.066Z`）早于 develop 落地（`10:20:24Z`）约 68s、早于主检出 ff（`10:20:31Z`）约 75s」。
- [x] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-250" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-ac250-session-create-interrupt-lifecycle`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-250`）0 命中；并写明同类归因先例 `gap-ac135/178/244/245/246/247/249-criterion-ledger-red-is-merge-race` 各为另一条 AC。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`、`server/modules/mcp-gateway/mcp-session-lifecycle.ts`、`server/modules/mcp-gateway/mcp-gateway.write-tools.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照一致（未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`goals/**`）。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-250**（净树三跑 exit 0、7/7/0）」与「台账 90 拍 fail 尾部由修复 `061da3d2` 最初只提交在 task 分支、fan-in `6e89ad58` 于 `10:20:24Z` 才把它带进 develop、主检出 ff 于 `10:20:31Z`、而判据红拍发生在落地之前造成」，并给出残留未钉死假设；不得用单元层读数替代判据本体。

## DoD

- 出货命令（`for f in …; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`，逐字不改；不改断言、不改判据）在检出上真的跑过、退出 0，七条用例名与 `7/7/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、fan-in 时刻、被测量树 HEAD 与 tree、`merge-base --is-ancestor` 退出码、`cat-file -e` 失败、`ls-tree HEAD` 命中、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `061da3d2` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」——不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac250-criterion-ledger-red-is-merge-race.md（自触）
- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts（本条只跑不改：判据本体）
- server/modules/mcp-gateway/mcp-session-lifecycle.ts（本条只读不改：session_create/session_interrupt 适配层）
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts（本条只读不改：写工具注册集合）
- goals/AC-250-session-create-与-session-interrupt-创建会话-可带首条消息-中止运行但常驻进程保留-对.md（本条只读不改：criterion/expect 逐字来源）

## 完成记录（Verification Report）

### 1. 判据本体直跑（AC1 / DoD）

**主检出（台账 `evaluationRoot=/data/home/yale/work/claudecodeui`）现测一跑**：跑前 `git rev-parse HEAD`=`42d52ab9dccad86405835e9585d60366cd5bd951`，`git status --porcelain -- server shared src package.json package-lock.json` 空。出货命令逐字（`for f in …` 存在性闸 + `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`）执行读数：**`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0` / `exit 0`**。跑后同款 `git status --porcelain` 与跑前逐字相同（空），无残留 —— 直接反驳台账理由 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`。

**隔离 worktree 检出三跑**（`/data/home/yale/work/claudecodeui-worktrees/gap-ac250-criterion-ledger-red-is-merge-race`，branch `task/gap-ac250-criterion-ledger-red-is-merge-race`，`git rev-parse HEAD`=`5e1e9405`；`git merge-base --is-ancestor 061da3d2 HEAD; echo $?` → `0`；`git status --porcelain -- server shared src package.json package-lock.json` 空）：

```
run1: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run2: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run3: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
```

七条用例名逐字（✔）：

```
✔ (a) session_create with a message returns the live runId; without one it starts nothing
✔ (b) an ambiguous project name is refused creating nothing; a unique one creates the row
✔ (c) a token lacking cloudcli:session:create is denied, audits one denied row, and never creates
✔ (d) session_interrupt aborts the running resident turn and leaves the host pid unchanged
✔ (e) session_interrupt on an idle session reports aborted:false with the no-run message
✔ (f) a token lacking cloudcli:session:control is denied, audits one denied row, and never aborts
✔ the stage-4 write table still names the five SPEC tools with their scopes
```

红态基线（立案读数）：末拍红 `2026-10-05T10:19:16.066Z` 退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`（见 §3）。

### 2. merge race 的 ancestry 证据（AC2 / DoD）

命令与逐字输出（worktree，共享同一对象库）：

```
$ git log -1 --format='%h %cI %s' 061da3d2
061da3d2 2026-10-05T18:08:04+08:00 feat(mcp-gateway): implement session_create and session_interrupt (AC-250)
$ git log -1 --format='%h %cI %s' f770b89f
f770b89f 2026-10-05T18:11:46+08:00 tasks: gap-ac250-session-create-interrupt-lifecycle task_write by cli:1033890
$ git log -1 --format='%h %cI %s' 6e89ad58
6e89ad58 2026-10-05T18:20:24+08:00 tasks: 翻 gap-ac250-session-create-interrupt-lifecycle done（driver 机械 fan-in）

$ git merge-base --is-ancestor 061da3d2 f770b89f; echo $?
exit=1
$ git merge-base --is-ancestor 061da3d2 HEAD; echo $?
exit=0
$ git rev-parse 'f770b89f^{tree}'
c3abfc0397c76487911c806547d027c5066f91c2
$ git cat-file -e c3abfc0397c76487911c806547d027c5066f91c2:server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts; echo $?
fatal: path 'server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts' exists on disk, but not in 'c3abfc0397c76487911c806547d027c5066f91c2'
exit=128
$ git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
100644 blob b17610b0ae559f465808d0c13c6dd04e0e262ade	server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts

$ git reflog show develop --date=iso | grep 6e89ad58
6e89ad58 develop@{2026-10-05 18:20:24 +0800}: push
$ git reflog show author --date=iso | grep 6e89ad58
6e89ad58 author@{2026-10-05 18:20:31 +0800}: merge develop: Fast-forward
```

追加机械读数：

```
$ git merge-base --is-ancestor 061da3d2 6e89ad58; echo $?      → exit=0
$ git rev-parse '6e89ad58^{tree}'                              → 1e89b65c20bb8362b10f184976fa99a2894d045d
$ git cat-file -e 6e89ad58:…/mcp-session-lifecycle.test.ts     → PRESENT
$ git diff --stat f770b89f 6e89ad58 -- …/mcp-session-lifecycle.test.ts
 .../tests/mcp-session-lifecycle.test.ts | 775 +++++++++++++++++++++
 1 file changed, 775 insertions(+)
```

时刻差：末拍红 `10:19:16.066Z` 早于 develop 落地（`6e89ad58` push `18:20:24 +0800` = `10:20:24Z`）约 **68s**，早于主检出 ff（`author@{2026-10-05 18:20:31 +0800}` = `10:20:31Z`）约 **75s**。

### 3. 台账尾部逐字 + 落地后 Sequel（AC3）

`.quay/gate-events.jsonl`，`item_id=AC-250`、`gate=goal`、`actor=goal-cli`（字段在 `payload`：`reason` / `evaluationRoot` / `treeSha`）：

- 立案读数：**90 拍全 fail**（首 `2026-10-05T02:02:34.885Z` @tree `51a58bf06d323e086c62616d6fe600dc0a59a286` → 末 `2026-10-05T10:19:16.066Z` @tree `c3abfc0397c76487911c806547d027c5066f91c2`）。
- 本轮现测同一台账：共 **91 拍 = 90 fail / 1 pass**；90 拍 fail 理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）；90 拍跨 52 棵不同 `treeSha`（尾部数拍为 `c3abfc0…`）。
- **落地后新增证实（Sequel）**：末拍红之后出现 **1 拍 pass**：

| 时刻 | verdict | treeSha | reason |
| --- | --- | --- | --- |
| 2026-10-05T10:28:08.425Z | **pass** | ed43d9285f1fb16d3eb7f42ca40c76a49e96fa45 | acceptance passed (exit 0) |

`.quay/goal-round.jsonl` 的 goal-ring fact（`.facts[]|select(.name=="goal-ring")|.value.criteria[]|select(.id=="AC-250")`）：

- 立案读数：round 95 @ `2026-10-05T10:17:16.139Z` → `{"id":"AC-250","goal":"GOAL-020","status":"active","verdict":"fail","reason":"acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts"}`。
- 本轮现测：round 96 @ `2026-10-05T10:25:55.955Z` → 仍逐字同一 `active/fail`（**旧判决延续**，机制见 §4；其 ts 虽晚于落地，投影的是落地前的末拍红）。

### 4. round 96 仍读 fail 的机制：goal-round 是 gate-event 台账的投影

逐轮对照（每轮 AC-250 fact 的 verdict == 该轮 ts 之前最近一拍 gate event 的 verdict）：

| goal-round | ts | 该轮前最近 AC-250 gate event | fact verdict |
| --- | --- | --- | --- |
| 93 | 10:06:53.317Z | 10:04:16.483Z fail | fail |
| 94 | 10:12:08.414Z | 10:08:40.399Z fail | fail |
| 95 | 10:17:16.139Z | 10:14:14.572Z fail | fail |
| 96 | 10:25:55.955Z | 10:19:16.066Z fail | fail |

⇒ goal-ring fact 是 **gate-event 台账最新判决的投影**，不在 round 时刻重跑判据；round 96 投影落地前 `10:19:16` 那拍，故仍读 fail。真正落地后的新测量是 `10:28:08.425Z` 的 pass gate event（晚于 round 96）。此形态与内存 `goal-gate-red-can-race-the-fixs-own-landing` 的 Sequel 一致（同族先例 `gap-ac249` 亦记录 goal-round 落后于 gate event）。

### 5. 机制去重复核（AC4）

`grep -rn "^goal_ac: *AC-250" tasks/*.md` 本轮命中 **2** 条：

- `tasks/gap-ac250-session-create-interrupt-lifecycle.md` → `status: done`（认领 AC-250 的唯一实现任务，fan-in `6e89ad58` 已落地）
- `tasks/gap-ac250-criterion-ledger-red-is-merge-race.md` → `status: ready`（**本条自身**）

在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-250`）只命中**本条自身**，无其他在飞认领者 ⇒ 本条不是重复。同族归因先例 `gap-ac135/178/244/245/246/247/249-criterion-ledger-red-is-merge-race` 各为**另一条 AC**（`goal_ac: AC-135/178/244/245/246/247/249`），机制相同但 AC 不同。立案时 Proposal 记「仅 1 条」为**本条任务文件写出前**的读数；文件写出后自触命中使其变为 2 条（内存 `retirement-grep-criterion-matches-its-own-obituary`：该 grep 判据自匹配其自身殡文，须排除自身读）。

### 6. 承重面未被本条触碰（AC5）

- `git -C <wt> diff --name-only develop...HEAD -- server src goals scripts` = **空**。
- 三个承重文件 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）：`server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`、`server/modules/mcp-gateway/mcp-session-lifecycle.ts`、`server/modules/mcp-gateway/mcp-gateway.write-tools.ts`。
- worktree `git status --porcelain` 空；未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`goals/**`。
- 交付物只动 `tasks/gap-ac250-criterion-ledger-red-is-merge-race.md`（自触）。

### 7. 判法与残留未钉死假设（AC6）

**判法：修复 `061da3d2` 有效；台账 90 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态。** 被提交的树满足 AC-250（主检出 1 跑 + 隔离 worktree 3 跑，均 `exit 0`、`tests 7 / pass 7 / fail 0`，七条用例名逐字在档）；修复落地后出现 1 拍 pass gate event（`10:28:08.425Z` @tree `ed43d928`），round 96 仍读 fail 已由逐轮投影机制解释。本条**不重新实现**任何修复。

残留未钉死假设（如实登记）：

1. **goal-round fact 落后于 gate-event**：round 96（`10:25:55.955Z`）仍读 fail 是投影落地前末拍红，非落地后复测；只有与某拍同时写入的新 round 才是新测量。
2. **本条只复核判据本体**：AC-250 的 (a)–(f) 读数由该判据自证（七条用例名逐字在档），本条不额外复算；判据用真实 express 4 + MCP SDK 客户端 + 真实 better-sqlite3 临时库 + 调试 agent 的常驻/按次进程会话，绿读数已覆盖 (a)–(f) 与三条取假形态。
3. **三跑读数取在隔离 worktree 检出**（worker 不得在主检出写文件）；承重面 blob 已证与 `develop` 相等（§6），且主检出任取一跑同绿（§1），故读数可迁移。
4. **AC-251–AC-257 的读数不在本条**：本条只归因 AC-250 的台账尾部红。