---
id: gap-ac246-criterion-ledger-red-is-merge-race
title: AC-246 判据台账尾部红是 merge race：实现 b85df7e1（15:13:03+0800）只提交在 task 分支，主检出
  author 停在 task_write 勾选 4a654f3a（树 70fae57c，判据文件 ABSENT）直到 fan-in
  c232ba8e（07:26:06Z）才 ff 落地；52 拍红（末拍 07:25:10.935Z）早于落地约 55s ——
  verification-only 归因入档（当前检出直跑 exit 0，7/7/0），不重新实现
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-246
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。GOAL-020 的 AC-246（`goals/AC-246-项目与会话按名称模糊匹配-唯一命中才接受-多义与无命中报错并列出候选-且任何写操作在目标不明时一律不发生.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-246`、`gate=goal`、`actor=goal-cli` 共 **52 拍、全部 fail**，从 `2026-10-05T02:02:32.524Z` 到 `2026-10-05T07:25:10.935Z`，理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）。但认领 AC-246 的唯一任务 `gap-ac246-mcp-resolve-target-fuzzy-match` 已是 `done`（fan-in `c232ba8e`）。故本轮做**直接现测 + ancestry 复核**，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
```

**本轮直接现测：判据在当前检出上退出 0（工作树满足 AC-246）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD` = `c232ba8e`，树 `9679eba6`）直跑两次（立案前 1 次 + 立案时 1 次），两次读数逐字一致、退出码 0：

```
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

七条用例逐字通过：`(a) a case-insensitive unique title substring resolves`、`(b) …`（以判据文件内实际标题为准确抄，勿复述 expect 文字）。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac245-criterion-ledger-red-is-merge-race`、`gap-ac244-criterion-ledger-red-is-merge-race`、`gap-ac135-criterion-ledger-red-is-merge-race`、`gap-ac178-criterion-ledger-red-is-merge-race`）：

- 实现提交 `b85df7e1`「AC-246: resolve MCP project/session references (id first, unique substring, candidates on ambiguity)」（`2026-10-05 15:13:03 +0800` = `07:13:03Z`）**最初只提交在 task 分支 `task/gap-ac246-mcp-resolve-target-fuzzy-match` 上**（`git show --stat b85df7e1` 新增 `server/modules/mcp-gateway/mcp-resolve-target.ts` 与 `server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`；4 files changed, 882 insertions(+), 6 deletions(-)）。
- `task_write` 的勾选提交 `4a654f3a`（`15:18:03 +0800` = `07:18:03Z`，树 `70fae57c…`）落在**主检出 `author`**（不是 worktree、不是 task 分支）—— 这是已知机制 `quay-task-write-tick-lands-outside-the-worktree`。`git merge-base --is-ancestor b85df7e1 4a654f3a; echo $?` = **1**：两条是 `cd8f8b31` 的兄弟，实现不在被测量的 author 树上；`git cat-file -e 70fae57c:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts` 报 `exists on disk, but not in '70fae57c'`（exit 128）。
- task 分支把 `develop` 合并进来的 `7ba5a8cb`（`15:18:15 +0800` = `07:18:15Z`）只落在 **task 分支**；主检出 `author` 截至 fan-in 前一直停在 `4a654f3a`（树 `70fae57c`）。
- 判据末拍红 `2026-10-05T07:25:10.935Z` 测量的树 `treeSha=70fae57c71db4c6e600795ccb1e64d1392687f59` **就是 `4a654f3a` 的树** ⇒ 判据文件在该树不存在，正是台账理由的来源。
- fan-in 落地提交 `c232ba8e`「tasks: 翻 gap-ac246-mcp-resolve-target-fuzzy-match done（driver 机械 fan-in）」（`15:26:06 +0800` = `07:26:06Z`）才把 `b85df7e1` 带进 `develop`/主检出（`author` Fast-forward）。现 `git merge-base --is-ancestor b85df7e1 develop; echo $?` = 0、`… HEAD` = 0；`git show develop:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts | head -3` 命中文件头 `/** AC-246 criterion: a caller's project/session reference resolves to exactly one`。
- 即：**末拍红 `07:25:10.935Z` 比修复落进 develop/主检出 `07:26:06Z` 早约 55 秒**（`07:26:06 − 07:25:10.935 = 55.065s`）。此后尚无新的一拍 goal 评估（`.quay/goal-round.jsonl` 最新 record 为 round 57 @ `2026-10-05T07:24:05.293Z`，其 AC-246 goal-ring fact 仍读 fail —— 那是**上一拍 gate-event 判决的延续**，中间无新 gate-event，非修复未生效）。

⇒ **早先的修复是兜住的**（`gap-ac246-mcp-resolve-target-fuzzy-match`，done，净树 7/7/0）；台账 52 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态（叠加 `task_write` 勾选落在主检出而非 worktree 的已知机制），不是 AC-246 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rn "^goal_ac: *AC-246" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-ac246-mcp-resolve-target-fuzzy-match.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-246`）**0 命中** ⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac245-criterion-ledger-red-is-merge-race`（`goal_ac: AC-245`，done）、`gap-ac244-criterion-ledger-red-is-merge-race`（`goal_ac: AC-244`，done）、`gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`）、`gap-ac178-criterion-ledger-red-is-merge-race`（`goal_ac: AC-178`）各为**另一条 AC**，仅归因机制相同。

**残留未钉死假设（如实登记）**：

1. 判据 (f) 用**同缝注册的同名 handler**（`session_send`/`session_interrupt`/`session_close`）证明解析门对写路径成立；写工具**本体行为**归 AC-249–AC-251，本判据不测其语义（这是判据自身的口径，非缺陷）。
2. 判据 (g) 的接线腿只覆盖读工具注册缝（`sessions_list`）；写工具的接线归 AC-249–AC-251 的判据。

本任务是 **verification-only 归因入档**：不改实现、判据、goals、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据**三次**（`for f in server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`），逐字抄 `ℹ tests` / `ℹ pass` / `ℹ fail` 与三次退出码；七条用例名逐字入档（稳定绿：三跑读数一致）。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%H %ci %s' b85df7e1` / `4a654f3a` / `7ba5a8cb` / `c232ba8e`；`git merge-base --is-ancestor b85df7e1 4a654f3a; echo $?`（期望 1）、`… b85df7e1 develop; echo $?`（0）、`… b85df7e1 HEAD; echo $?`（0）、`… b85df7e1 c232ba8e; echo $?`（0）；`git cat-file -e 4a654f3a:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`（期望报 `not in '4a654f3a'`，exit 128）；`git show develop:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts | head -3`（命中文件头）；复算「末拍红 `07:25:10.935Z` < fan-in 落地 `07:26:06Z`」≈ 55s。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-246 `gate=goal` 的计数与首拍/尾部（含逐字理由、`evaluationRoot`、`treeSha`）；从 `.quay/goal-round.jsonl` 抄出最新 round（57，`07:24:05.293Z`）的 AC-246 goal-ring fact；用 per-tree 机械判据（`git cat-file -e <treeSha>:<criterion-file>`）把「红树 ABSENT / 现树 PRESENT」对上。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑**三次**：出货命令逐字不改，均退出 **0**，`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0` 与七条用例名逐字入档（稳定绿：三跑读数一致）。红态基线（本轮立案读数）：当前检出直跑 exit 0；台账末拍红 `2026-10-05T07:25:10.935Z` 退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`。
- [x] AC2 承重的 ancestry 证据机械入档：`git log -1 --format='%H %ci %s' b85df7e1` → 实现提交 `2026-10-05 15:13:03 +0800`（task 分支）；`… 4a654f3a` → task_write 勾选提交 `15:18:03 +0800`（主检出 `author`，树 `70fae57c`）；`… 7ba5a8cb` → task 分支合并 develop `15:18:15 +0800`；`… c232ba8e` → fan-in `15:26:06 +0800`（=`07:26:06Z`）；`git merge-base --is-ancestor b85df7e1 4a654f3a; echo $?` → **1**；`… b85df7e1 develop; echo $?` → 0；`… b85df7e1 HEAD; echo $?` → 0；`… b85df7e1 c232ba8e; echo $?` → 0；`git cat-file -e 4a654f3a:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts` → 报 `exists on disk, but not in '4a654f3a'`（exit 128）；`git show develop:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts | head -3` 命中文件头。命令与逐字输出入档；复算 `07:26:06 − 07:25:10.935 = 55.065s ≈ 55s`。
- [x] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-246`、`gate=goal`、`actor=goal-cli` 的判决计数（52 fail / 0 pass）与首拍/尾部（首 `2026-10-05T02:02:32.524Z` 树 `51a58bf0…`、末 `2026-10-05T07:25:10.935Z` 树 `70fae57c…`，理由逐字 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`、`evaluationRoot=/data/home/yale/work/claudecodeui`），并抄出 `.quay/goal-round.jsonl` 最新 round（57，`2026-10-05T07:24:05.293Z`）的 AC-246 goal-ring fact；写明「末拍红（`07:25:10.935Z`）早于 fan-in 落地（`07:26:06Z`）约 55s」；用 per-tree 判据把红树（`51a58bf0` / `70fae57c`）与现树（`9679eba6`）的判据文件存在性直接对上（ABSENT vs PRESENT）。
- [x] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-246" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-ac246-mcp-resolve-target-fuzzy-match`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-246`）命中的只能是本条自身，须注明；并写明同族先例 `gap-ac245-criterion-ledger-red-is-merge-race` / `gap-ac244-…` / `gap-ac135-…` / `gap-ac178-…`（各为另一条 AC）。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`、`server/modules/mcp-gateway/mcp-resolve-target.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `server/**`、`goals/**`）。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-246**（净树三跑 exit 0、7/7/0）」与「台账 52 拍 fail 由修复 `b85df7e1` 最初只提交在 task 分支、`task_write` 勾选 `4a654f3a` 落在主检出 `author`、fan-in `c232ba8e` 于 `07:26:06Z` 才把实现带进 develop/主检出，而判据红拍发生在落地之前造成」，并给出残留未钉死假设（(f) 同缝同名 handler 证明写路径；写工具本体行为归 AC-249–AC-251；(g) 接线腿只覆盖读工具缝）；⛔ 不得用单元层读数替代判据本体。

## DoD

- 出货命令（`for f in server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`，逐字不改；⛔ 不改断言、不改判据）在净检出上真的跑过、退出 0，七条用例名与 `7/7/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（实现提交时刻、task_write 勾选提交时刻、task 分支合并时刻、fan-in 时刻、`merge-base --is-ancestor` 退出码、`git cat-file -e` 读数、`git show develop:…` 命中、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `b85df7e1` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- `tasks/gap-ac246-criterion-ledger-red-is-merge-race.md`（自触）
- `server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`（本条只跑不改：判据本体）
- `server/modules/mcp-gateway/mcp-resolve-target.ts`（本条只读不改：解析器 / 解析门实现）
- `goals/AC-246-项目与会话按名称模糊匹配-唯一命中才接受-多义与无命中报错并列出候选-且任何写操作在目标不明时一律不发生.md`（本条只读不改：criterion/expect 逐字来源）

## 完成记录（Verification Report）

**判法：修复 `b85df7e1` 有效；台账 52 拍 fail 尾部是 fan-in 落地（`c232ba8e` @ `2026-10-05T07:26:06Z`）与判据测量之间的竞态，不是 AC-246 回归。** 本条为 verification-only 归因入档：不改实现、判据、goals、宿主配置一个字节。

### 1. 承重现测：判据在净检出上三跑全绿

隔离 worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac246-criterion-ledger-red-is-merge-race`
起点 = 开工时 `develop`（`72d49bc0`），`git rev-parse HEAD` = `72d49bc0adef4ad1a27f8238640a2cea47324ce4`，`git status --porcelain` = 空（开工快照为空，交付时仍为空）。

出货命令（逐字不改，⛔ 未改断言/判据）：

```
for f in server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
```

三跑读数（逐字）：

| 跑次 | ℹ tests | ℹ pass | ℹ fail | exit |
| --- | --- | --- | --- | --- |
| 1 | 7 | 7 | 0 | 0 |
| 2 | 7 | 7 | 0 | 0 |
| 3 | 7 | 7 | 0 | 0 |

稳定绿：三跑读数一致，均退出 0。

七条用例名逐字（取自 `ℹ` 行）：

1. `✔ (a) a title substring resolves case-insensitively to the one matching entry`
2. `✔ (b) an exact id wins over another entry whose title contains it`
3. `✔ (c) several title hits list every candidate and select none`
4. `✔ (d) no hit names the query and the kind`
5. `✔ (e) archived projects and sessions are never matched and never listed`
6. `✔ (f) an unclear target leaves every write tool with zero service calls`
7. `✔ (g) the transport resolves a named project to its id before the tool body runs`

红态基线：台账末拍红 `2026-10-05T07:25:10.935Z` 退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`。

### 2. ancestry 证据（机械，可复现）

命令与逐字输出：

```
$ git log -1 --format='%H %ci %s' b85df7e1
b85df7e18c7c81cd5c1b2454118923c2947bda19 2026-10-05 15:13:03 +0800 AC-246: resolve MCP project/session references (id first, unique substring, candidates on ambiguity)
$ git log -1 --format='%H %ci %s' 4a654f3a
4a654f3aeecb7aeba43f7cb17ed3b5fecb86b65a 2026-10-05 15:18:03 +0800 tasks: gap-ac246-mcp-resolve-target-fuzzy-match task_write by cli:1882835
$ git log -1 --format='%H %ci %s' 7ba5a8cb
7ba5a8cbb80ef4ffc57725fe57d6f3222a67fd47 2026-10-05 15:18:15 +0800 Merge branch 'develop' into task/gap-ac246-mcp-resolve-target-fuzzy-match
$ git log -1 --format='%H %ci %s' c232ba8e
c232ba8e7de2e152a9ef62fd03b6c29c9f973edb 2026-10-05 15:26:06 +0800 tasks: 翻 gap-ac246-mcp-resolve-target-fuzzy-match done（driver 机械 fan-in）

$ git merge-base --is-ancestor b85df7e1 4a654f3a; echo $?
1
$ git merge-base --is-ancestor b85df7e1 develop; echo $?
0
$ git merge-base --is-ancestor b85df7e1 HEAD; echo $?
0
$ git merge-base --is-ancestor b85df7e1 c232ba8e; echo $?
0

$ git cat-file -e 4a654f3a:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
fatal: path 'server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts' exists on disk, but not in '4a654f3a'
$ echo $?
128

$ git show develop:server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts | head -3
/**
 * AC-246 criterion: a caller's project/session reference resolves to exactly one
 * id, or the call is refused with the candidates — and an unclear target performs
```

树 SHA 复核：`4a654f3a^{tree}` = `70fae57c71db4c6e600795ccb1e64d1392687f59`（= 台账末拍红树）；`c232ba8e^{tree}` = `9679eba6c530204abafcd934cdecb5a0d656b79f`（= 立案时现树）；worktree HEAD `72d49bc0^{tree}` = `9c1adaf5cc2315d2d4f89d692f14bd0b464ebb68`。

时刻差复算：`07:26:06 − 07:25:10.935 = 55.065s ≈ 55s` —— 末拍红早于修复落进 develop/主检出约 55 秒。

### 3. 台账尾巴（逐字）

`.quay/gate-events.jsonl` 里 `item_id=AC-246`、`gate=goal`、`actor=goal-cli` 共 **52 条，全部 fail（52 fail / 0 pass）**：

- 首拍：`2026-10-05T02:02:32.524Z`，`treeSha=51a58bf06d323e086c62616d6fe600dc0a59a286`
- 末拍：`2026-10-05T07:25:10.935Z`，`treeSha=70fae57c71db4c6e600795ccb1e64d1392687f59`
- 理由逐字（每拍同）：`acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`
- `evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）

`.quay/goal-round.jsonl` 最新 round（57 @ `2026-10-05T07:24:05.293Z`）的 AC-246 goal-ring fact 逐字：`{"id":"AC-246","goal":"GOAL-020","status":"active","verdict":"fail","reason":"acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts"}`（该 fact 是上一拍 gate-event 判决的延续，中间无新 gate-event）。

per-tree 判据把红树与现树的存在性直接对上（`git cat-file -e <treeSha>:<criterion-file>`）：

| 树 | 来源 | `cat-file -e` exit | 判据文件 |
| --- | --- | --- | --- |
| `51a58bf0…` | 台账首拍红树 | 128 | ABSENT |
| `70fae57c…` | 台账末拍红树（= `4a654f3a`） | 128 | ABSENT |
| `9679eba6…` | 立案时现树（= `c232ba8e`） | 0 | PRESENT |
| `9c1adaf5…` | 本条 worktree HEAD（= `72d49bc0`） | 0 | PRESENT |

**新增证实（立案后）**：`.quay/gate-events.jsonl` 出现一条晚于末拍红的 AC-246 goal 判决 —— `2026-10-05T07:33:13.961Z`，`verdict=pass`，`reason=acceptance passed (exit 0)`，`treeSha=9c1adaf5cc2315d2d4f89d692f14bd0b464ebb68`（正是含修复的树，与本条 worktree HEAD 同树）。这是 fan-in 落地（`07:26:06Z`）后第一次在含修复的树上测得，直接证实「修复有效、红尾是竞态」，而非修复未生效。

（同期 `.quay/goal-round.jsonl` 最新 record 已推进到 round 58 @ `2026-10-05T07:31:58.546Z`，其 AC-246 goal-ring fact 仍读 fail —— 因 round 58 的 `07:31:58.546Z` 仍早于该 pass gate-event 的 `07:33:13.961Z`，同样是旧判决的延续，非修复未生效。）

### 4. 机制去重复核

`grep -rn "^goal_ac: *AC-246" tasks/*.md` 命中 2 条：

- `tasks/gap-ac246-mcp-resolve-target-fuzzy-match.md` → `goal_ac: AC-246`，`status: done`（认领 AC-246 的唯一任务，已落地）
- `tasks/gap-ac246-criterion-ledger-red-is-merge-race.md` → `goal_ac: AC-246`，`status: ready`（**本条自身**）

在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-246`）只命中**本条自身**，无其他在飞认领者。

同族先例（各为另一条 AC，仅归因机制相同）：`gap-ac245-criterion-ledger-red-is-merge-race`（AC-245，done）、`gap-ac244-criterion-ledger-red-is-merge-race`（AC-244，done）、`gap-ac135-criterion-ledger-red-is-merge-race`（AC-135，done）、`gap-ac178-criterion-ledger-red-is-merge-race`（AC-178，done）。

### 5. 承重面未被触碰

- `git diff --name-only develop...HEAD -- server src goals scripts` → 空
- `git diff --stat develop -- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts server/modules/mcp-gateway/mcp-resolve-target.ts` → 空（blob 与 develop 相等）
- `git status --porcelain` → 空，与本条开工快照逐字相同；⛔ 未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`goals/**`
- 唯一交付物：`tasks/gap-ac246-criterion-ledger-red-is-merge-race.md`（AC 勾选 + 本完成记录）

### 6. 残留未钉死假设（如实登记）

1. 判据 (f) 用同缝注册的同名 handler（`session_send`/`session_interrupt`/`session_close`）证明解析门对写路径成立；写工具**本体行为**归 AC-249–AC-251，本判据不测其语义（这是判据自身的口径，非缺陷）。
2. 判据 (g) 的接线腿只覆盖读工具注册缝（`sessions_list`）；写工具的接线归 AC-249–AC-251 的判据。