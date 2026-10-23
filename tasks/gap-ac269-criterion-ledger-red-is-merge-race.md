---
id: gap-ac269-criterion-ledger-red-is-merge-race
title: AC-269 判据台账尾部红是 merge race：记录文件 + --check-external-record 实现
  bc0d788e（07:22:55 +0800 / 23:22:55Z）只提交在 task 分支，fan-in 5392bf9a（07:28:12
  +0800 / 23:28:12Z）才带进 develop/主检出；末拍 goal 红 23:26:04.572Z@tree 8ba0cbba（记录文件
  ABSENT、scripts/mcp-smoke.mjs PRESENT）早于落地约 128s —— verification-only
  归因入档（当前检出直跑 5 次 exit 0 + 单测 39/39/0），不重新实现既有修复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-269
---
## Proposal

来源：本轮 gap-filing 的**直接现测 + ancestry 复核**（不是台账尾巴本身）。GOAL-021 的 AC-269（`goals/AC-269-外部客户端绑定的记录齐全-客户端-回调主机-是否用-dcr-是否带-resource-是否用-refresh-工具调用超.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-269`、`gate=goal`、`actor=goal-cli` 共 **3 拍，全部 fail / 0 pass** —— `2026-10-05T02:02:46.483Z` @tree `51a58bf0…` 与 `2026-10-05T02:05:14.244Z` @tree `7bd9d0f7…` 理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：scripts/mcp-smoke.mjs`；末拍 `2026-10-05T23:26:04.572Z` @tree `8ba0cbba8409127d66824026d1f4ee6d1181a2c3` 理由逐字 `acceptance failed (exit 1) — 缺判据文件：docs/proposals/cloudcli-mcp-external-client.md`，`evaluationRoot=/data/home/yale/work/claudecodeui`。认领 AC-269 的唯一任务 `gap-ac269-external-client-record` 已是 `done`（fan-in `5392bf9a`）。故本轮先做直接现测 + ancestry 复核，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md
```

**本轮直接现测：判据在检出上退出 0（工作树满足 AC-269）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`；3 跑 @`086a152b`、2 跑 @`37914ac1`，两处 `git status --porcelain -- scripts docs/proposals/cloudcli-mcp-external-client.md` 均空）直跑 **5 次**，每次读数逐字一致、退出码 0：

```
记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串
```

配套护栏单测 `node --test scripts/mcp-smoke.test.mjs` 退出 0、读数 `ℹ tests 39 / ℹ pass 39 / ℹ fail 0`。而台账那批 fail 的逐字理由只到**存在性闸**：判据文件在被测量的那棵树里根本不存在，脚本与记录都未被读取。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 这是内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac135/178/244/245/246/247/249/250-criterion-ledger-red-is-merge-race`）：

- 修复提交 `bc0d788e`「AC-269: external MCP client binding record + --check-external-record」（`2026-10-06 07:22:55 +0800` = `2026-10-05T23:22:55Z`）**最初只提交在 task 分支 `task/gap-ac269-external-client-record` 上**。
- 末拍红 gate event 的 `treeSha` = `8ba0cbba8409127d66824026d1f4ee6d1181a2c3`，其属主提交是 `825bf795`「goals: AC-268 status active→achieved by cli:843066」（`2026-10-06 07:26:03 +0800` = `23:26:03Z`），正是判据被测量的那棵树。`git merge-base --is-ancestor bc0d788e 825bf795` = **exit 1** ⇒ 被测树**不含**修复；`git cat-file -e 8ba0cbba:docs/proposals/cloudcli-mcp-external-client.md` = `fatal: path 'docs/proposals/cloudcli-mcp-external-client.md' exists on disk, but not in '8ba0cbba'`（exit 128）⇒ 记录文件在测量树上不存在，正是台账理由的来源。**同一棵树上 `scripts/mcp-smoke.mjs` 却是 PRESENT（`cat-file -e` exit 0）** —— 即 `gap-ac256` 早先已把冒烟脚本带进 develop，本条缺的只剩记录文件；AC 原文 `expect` 预测的点名文件「`scripts/mcp-smoke.mjs`」已过时（内存 `existence-gate-ac-predicted-missing-file-can-be-stale`）。
- fan-in 落地：`git reflog show develop --date=iso` 的 `5392bf9a develop@{2026-10-06 07:28:12 +0800}: push`「Merge branch 'develop' into task/gap-ac269-external-client-record」（= `23:28:12Z`）；`git ls-tree 5392bf9a -- docs/proposals/cloudcli-mcp-external-client.md` 命中 blob `5e42d39b`。现 `git merge-base --is-ancestor bc0d788e develop` = 0、`… author` = 0。
- 时刻差：末拍红 `23:26:04.572Z` 早于 develop 落地（`23:28:12Z`）约 **128s**、早于主检出可测到它的时刻约同量级，而晚于修复提交（`23:22:55Z`）约 189s —— 与内存描述的「event 时间戳落在修复之后、但测量用的是修复之前的树」同形。

<!-- dedup-ref -->
机制去重复核：`grep -l "^goal_ac: *AC-269" tasks/*.md` 立案前仅命中 `gap-ac269-external-client-record`（`status: done`，认领 AC-269 的唯一实现任务，fan-in `5392bf9a` 已落地）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-269`）**0 命中**；本仓库此前**没有** AC-269 的归因任务。同族归因先例 `gap-ac135/178/244/245/246/247/249/250-criterion-ledger-red-is-merge-race` 各为另一条 AC（`goal_ac: AC-135/178/244/245/246/247/249/250`），机制相同但 AC 不同。本条只归因，不重新实现。

要交付：verification-only **归因入档** —— 把「被提交的树满足 AC-269」与「台账 3 拍 fail 尾部来自 fan-in 落地与判据测量之间的竞态」两件事按可复现命令逐字入档，不改判据、不改实现、不动 `goals/**`。AC-269 要求的**九节读数记录与 `--check-external-record` 已由 `bc0d788e` 落地**；本条不重写它们。

残留未钉死假设（如实登记）：AC-269 的判据是**结构性**的（九节齐全 + 每节 读数：/结论： 非空 + 公网基址无令牌串），它**证不了九节读数是真的外部客户端绑定** —— 把真读数与一份格式合格但编造的记录区分开，属于 AC-270 的人工关卡（`gap-ac270-external-client-human-gate`，`status: ready`）。本条不触碰该假设，GOAL-021 的验收结论仍由人 yale 在 AC-270 给出。

## AC

- [x] AC1 判据在**检出**直跑 ≥3 次全部退出 **0**：命令 `for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md`（逐字不改），stdout 逐字 `记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串`；并跑 `node --test scripts/mcp-smoke.test.mjs` 退出 0、读数 `ℹ tests 39 / ℹ pass 39 / ℹ fail 0`；跑前跑后 `git status --porcelain` 逐字一致（空）。红态基线（立案读数）：末拍 `2026-10-05T23:26:04.572Z` 退出 1，红在存在性闸 `缺判据文件：docs/proposals/cloudcli-mcp-external-client.md`。
- [x] AC2 承重的 ancestry 证据机械入档：`git merge-base --is-ancestor bc0d788e 825bf795; echo $?` → 非 0；`git merge-base --is-ancestor bc0d788e develop; echo $?` → 0；`git log --all --format='%H %T %cI %s' | awk '$2=="8ba0cbba8409127d66824026d1f4ee6d1181a2c3"'` → 属主提交 `825bf795`；`git cat-file -e 8ba0cbba:docs/proposals/cloudcli-mcp-external-client.md` → `exists on disk, but not in '8ba0cbba'`（exit 128）而 `git cat-file -e 8ba0cbba:scripts/mcp-smoke.mjs` → PRESENT（exit 0）；`git ls-tree 5392bf9a -- docs/proposals/cloudcli-mcp-external-client.md` → blob `5e42d39b`；`git reflog show develop --date=iso | grep 5392bf9a` → `07:28:12 +0800 push`；`git log -1 --format='%H %cI %s' bc0d788e` → `07:22:55 +0800`。命令与逐字输出入档。
- [x] AC3 台账尾部逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-269`、`gate=goal`、`actor=goal-cli` 的 **3 拍全 fail / 0 pass**（两条首拍理由逐字 `acceptance failed (exit 1) — 缺判据文件：scripts/mcp-smoke.mjs`、末拍逐字 `acceptance failed (exit 1) — 缺判据文件：docs/proposals/cloudcli-mcp-external-client.md`，含 `evaluationRoot=/data/home/yale/work/claudecodeui` 与各拍 `treeSha`），并抄出 `.quay/goal-round.jsonl` round 8（`2026-10-05T02:29:13.351Z`）的 AC-269 goal-ring fact（`status:draft / verdict:fail`）；写明「末拍红 `23:26:04.572Z` 早于 develop 落地 `23:28:12Z` 约 128s」。
- [x] AC4 机制去重复核：`grep -l "^goal_ac: *AC-269" tasks/*.md` 的命中集合与各自 `status:` 逐字入档（立案前仅 `gap-ac269-external-client-record`，done；本条自身写出后为第 2 条，须按内存 `retirement-grep-criterion-matches-its-own-obituary` 排除自身读）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-269`）0 命中；写明同族归因先例各为另一条 AC。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`git diff --stat develop -- scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-external-client.md` 为空（三文件 blob 与 `develop` 相等）；未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`scripts/**`、`goals/**`。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-269**（检出直跑 5 次 exit 0、单测 39/39/0）」与「台账 3 拍 fail 尾部由修复 `bc0d788e` 最初只提交在 task 分支、fan-in `5392bf9a` 于 `23:28:12Z` 才把它带进 develop、而末拍红发生在落地之前造成」，并给出残留未钉死假设（判据只证读数齐全，读数的真实性归 AC-270 人工关卡）；不得用单测读数替代判据本体。

## DoD

- 出货判据命令（`for f in …; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md`，逐字不改；不改断言、不改判据、不改记录文件）在检出上真的跑过、退出 0，stdout 与 `39/39/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻 `bc0d788e`、fan-in 落地提交 `5392bf9a` 与其 `07:28:12 +0800` push 时刻、被测树属主提交 `825bf795` 与 tree `8ba0cbba`、`merge-base --is-ancestor` 两个退出码、`cat-file -e` 对记录文件失败而对 `scripts/mcp-smoke.mjs` 命中、`ls-tree 5392bf9a` 命中 blob、红拍/落地时刻差 ~128s）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `bc0d788e` 有效；台账 3 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设（读数的真实性归 AC-270 人工关卡）。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、`goals/**`、工作树一个字节未动。
- 若直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac269-criterion-ledger-red-is-merge-race.md（自触）
- scripts/mcp-smoke.mjs（本条只跑不改：判据本体，含 `--check-external-record` 模式）
- scripts/mcp-smoke.test.mjs（本条只跑不改：九节检查的护栏单测，39 例）
- docs/proposals/cloudcli-mcp-external-client.md（本条只读不改：九节「读数：/结论：」记录，判据的被检对象）
- goals/AC-269-外部客户端绑定的记录齐全-客户端-回调主机-是否用-dcr-是否带-resource-是否用-refresh-工具调用超.md（本条只读不改：criterion/expect 逐字来源）

## Completion

**判法结论：修复 `bc0d788e` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态（merge race），不是修复失效。** 本条为 verification-only 归因入档 —— 判据、实现、`goals/**`、记录文件一个字节未改。全部读数在本条 worktree 检出 `/data/home/yale/work/claudecodeui-wk-gap-ac269-criterion-ledger-red-is-merge-race`（branch `task/gap-ac269-criterion-ledger-red-is-merge-race`，rev `d3d6fcd64fb07745fe8255022fce98276cdb5551`）上现测；该检出上三个承重文件与 `develop` 的 blob 相等（见 AC5），故与立案时在主检出上的读数同源。

### AC1 现测：判据在检出上退出 0

命令（逐字不改）：

```
for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md
```

**5 跑，5 次退出 0，stdout 逐字一致：**

```
run 1 exit=0 stdout=记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串
run 2 exit=0 stdout=记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串
run 3 exit=0 stdout=记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串
run 4 exit=0 stdout=记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串
run 5 exit=0 stdout=记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串
```

护栏单测 `node --test scripts/mcp-smoke.test.mjs`，退出 0，读数逐字：

```
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2979.048039
```

跑前 / 跑后 `git status --porcelain` 均**空**（逐字一致，判据无写副作用）。

> **判据本体读数已给出**（上）+ 单测读数只是配套护栏；本条不以 `39/39/0` 替代判据本体。

红态基线（立案读数，未变）：末拍 `2026-10-05T23:26:04.572Z` 退出 1，红在存在性闸 `缺判据文件：docs/proposals/cloudcli-mcp-external-client.md`。

### AC2 ancestry 证据（命令与逐字输出）

| # | 命令 | 逐字输出 | 退出码 |
|---|---|---|---|
| 1 | `git merge-base --is-ancestor bc0d788e 825bf795; echo $?` | `1` | 1 |
| 2 | `git merge-base --is-ancestor bc0d788e develop; echo $?` | `0` | 0 |
| 2b | `git merge-base --is-ancestor bc0d788e author; echo $?` | `0` | 0 |
| 3 | `git log --all --format='%H %T %cI %s' \| awk '$2=="8ba0cbba8409127d66824026d1f4ee6d1181a2c3"'` | `825bf7952d59d116f79f4ed9cae109ecffa9068f 8ba0cbba8409127d66824026d1f4ee6d1181a2c3 2026-10-06T07:26:03+08:00 goals: AC-268 status active→achieved by cli:843066` | 0 |
| 4 | `git cat-file -e 8ba0cbba:docs/proposals/cloudcli-mcp-external-client.md; echo $?` | `fatal: path 'docs/proposals/cloudcli-mcp-external-client.md' exists on disk, but not in '8ba0cbba'` / `128` | 128 |
| 5 | `git cat-file -e 8ba0cbba:scripts/mcp-smoke.mjs; echo $?` | （无输出，PRESENT）`0` | 0 |
| 6 | `git ls-tree 5392bf9a -- docs/proposals/cloudcli-mcp-external-client.md` | `100644 blob 5e42d39b20b645a73c64f3f22ac08c76fdbfb204	docs/proposals/cloudcli-mcp-external-client.md` | 0 |
| 7 | `git reflog show develop --date=iso \| grep 5392bf9a` | `5392bf9a develop@{2026-10-06 07:28:12 +0800}: push` | 0 |
| 8 | `git log -1 --format='%H %cI %s' bc0d788e` | `bc0d788e8883602a5338f408b4e94185fb480d6e 2026-10-06T07:22:55+08:00 AC-269: external MCP client binding record + --check-external-record` | 0 |

修复提交 `bc0d788e` 的内容（`git show --stat`）正是三件套，无第四处改动：

```
 docs/proposals/cloudcli-mcp-external-client.md |  55 +++++++++
 scripts/mcp-smoke.mjs                          | 132 ++++++++++++++++++++++
 scripts/mcp-smoke.test.mjs                     | 149 +++++++++++++++++++++++++
 3 files changed, 336 insertions(+)
```

### AC3 台账尾部（逐字）+ goal-round round 8

`.quay/gate-events.jsonl` 中 `item_id=AC-269`、`gate=goal`、`actor=goal-cli` 的全部记录，按 timestamp 升序逐字：

```json
{"actor": "goal-cli", "gate": "goal", "id": "e040d2a7-eed9-4f56-b038-8065e5dc3a53", "item_id": "AC-269", "payload": {"evaluationRoot": "/data/home/yale/work/claudecodeui", "reason": "acceptance failed (exit 1) — 缺判据文件：scripts/mcp-smoke.mjs", "treeSha": "51a58bf06d323e086c62616d6fe600dc0a59a286"}, "pipeline_id": "AC-269", "timestamp": "2026-10-05T02:02:46.483Z", "verdict": "fail"}
{"actor": "goal-cli", "gate": "goal", "id": "0dc85bf5-666d-4242-8890-1e6b74c651d9", "item_id": "AC-269", "payload": {"evaluationRoot": "/data/home/yale/work/claudecodeui", "reason": "acceptance failed (exit 1) — 缺判据文件：scripts/mcp-smoke.mjs", "treeSha": "7bd9d0f7e5adee26d68c3033c05732f18fd0ab7f"}, "pipeline_id": "AC-269", "timestamp": "2026-10-05T02:05:14.244Z", "verdict": "fail"}
{"actor": "goal-cli", "gate": "goal", "id": "596d096e-82a3-4f4a-af7d-9edcc7ba18d4", "item_id": "AC-269", "payload": {"evaluationRoot": "/data/home/yale/work/claudecodeui", "reason": "acceptance failed (exit 1) — 缺判据文件：docs/proposals/cloudcli-mcp-external-client.md", "treeSha": "8ba0cbba8409127d66824026d1f4ee6d1181a2c3"}, "pipeline_id": "AC-269", "timestamp": "2026-10-05T23:26:04.572Z", "verdict": "fail"}
{"actor": "goal-cli", "gate": "goal", "id": "6eae1273-9ce5-4086-8925-86839fe20524", "item_id": "AC-269", "payload": {"evaluationRoot": "/data/home/yale/work/claudecodeui", "reason": "acceptance passed (exit 0)", "treeSha": "dd2cfdbb6b63b6ceec3779645441fcc093d31fee"}, "pipeline_id": "AC-269", "timestamp": "2026-10-05T23:36:48.145Z", "verdict": "pass"}
```

> **登记时读数（stale-delta，如实入档）**：AC3 立案时台账为「3 拍全 fail / 0 pass」。本轮登记时该集合已是 **4 拍 = 3 fail + 1 pass**，第 4 拍（`23:36:48.145Z`，`verdict: pass`，理由逐字 `acceptance passed (exit 0)`）**在本次登记之前就已落到台账里**，不是本条产生的。这**加强**而非削弱归因（见下）。AC3 要求的「3 拍 fail 逐字 + 各自理由 + evaluationRoot + treeSha」全部逐字入档如上，故按内存 `existence-gate-ac-predicted-missing-file-can-be-stale` 记 stale-note 后仍然 tick。

**每拍被测树的实测内容（本条新增的机械解释，逐字）：**

| 拍 | treeSha | 记录文件 `docs/proposals/cloudcli-mcp-external-client.md` | 脚本 `scripts/mcp-smoke.mjs` | 台账理由点名的文件 |
|---|---|---|---|---|
| 1 fail | `51a58bf0` | ABSENT | ABSENT | `scripts/mcp-smoke.mjs` ✓（循环里第一个缺的） |
| 2 fail | `7bd9d0f7` | ABSENT | ABSENT | `scripts/mcp-smoke.mjs` ✓ |
| 3 fail | `8ba0cbba` | ABSENT | present `ec023c02…` | `docs/proposals/cloudcli-mcp-external-client.md` ✓ |
| 4 pass | `dd2cfdbb` | present `5e42d39b…` | present `e58a0acc…` | —— |

判据的存在性闸在循环里报**第一个**缺失文件，所以点名文件从 `scripts/mcp-smoke.mjs`（拍 1/2）变成记录文件（拍 3）—— 正是 `gap-ac256` 先把脚本带进 develop、只剩记录文件的结果；这与 AC 原文 `expect` 预测的点名文件已过时相符（内存 `existence-gate-ac-predicted-missing-file-can-be-stale`）。

**第 4 拍的树属主**（`git log --all --format='%H %T %cI %s'` 按 `%T` 反查）：`d3d6fcd64fb07745fe8255022fce98276cdb5551 dd2cfdbb… 2026-10-06T07:35:16+08:00 tasks: 翻 gap-ac257-mcp-nested-smoke-human-gate done（driver 机械 fan-in）` —— 即 pass 用的树已含 fan-in 落地，且 `git merge-base --is-ancestor 5392bf9a d3d6fcd6` = **0**、`git merge-base --is-ancestor bc0d788e d3d6fcd6` = **0**。**这是归因的独立正控制：修复进 develop 之后的第一拍立刻 pass，理由逐字 `acceptance passed (exit 0)`。**

`.quay/goal-round.jsonl` 第 13982 行，round 8，`ts=2026-10-05T02:29:13.351Z`，AC-269 的 goal-ring fact 逐字：

```json
{"goal": "GOAL-021", "id": "AC-269", "reason": "acceptance failed (exit 1) — 缺判据文件：scripts/mcp-smoke.mjs", "status": "draft", "verdict": "fail"}
```

**时刻差（本条复算，逐字）：** 末拍红 `2026-10-05T23:26:04.572Z` **早于** develop 落地 `2026-10-05T23:28:12Z`（= `2026-10-06 07:28:12 +0800`）**约 128s**（精确 127.4s）；修复提交 `2026-10-05T23:22:55Z` 早于末拍红 190s；落地早于第 4 拍 pass `23:36:48.145Z` 516s。

### AC4 机制去重复核（逐字）

```
$ grep -l "^goal_ac: *AC-269" tasks/*.md
tasks/gap-ac269-criterion-ledger-red-is-merge-race.md
tasks/gap-ac269-external-client-record.md

$ for f in $(grep -l "^goal_ac: *AC-269" tasks/*.md); do printf '%s -> %s\n' "$f" "$(grep -m1 '^status:' "$f")"; done
tasks/gap-ac269-external-client-record.md -> status: done
tasks/gap-ac269-criterion-ledger-red-is-merge-race.md -> status: ready
```

排除自身（内存 `retirement-grep-criterion-matches-its-own-obituary`：本条自身也带 `goal_ac: AC-269`，必须排除自身读）：

```
$ grep -l "^goal_ac: *AC-269" tasks/*.md | grep -v "gap-ac269-criterion-ledger-red-is-merge-race.md"
tasks/gap-ac269-external-client-record.md
```

⇒ 除本条外，AC-269 的**唯一**认领任务是 `gap-ac269-external-client-record`（`status: done`，即 `bc0d788e` 的修复任务，fan-in `5392bf9a` 已落地）。

在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-269`）逐字命中：

```
HIT tasks/gap-ac269-criterion-ledger-red-is-merge-race.md status=ready
```

⇒ **0 个第三方在飞任务**（唯一命中是本条自身）。本仓库此前没有 AC-269 的其它归因任务；同族先例 `gap-ac135/178/244/245/246/247/249/250-criterion-ledger-red-is-merge-race` 各为**另一条** AC（`goal_ac: AC-135/178/244/245/246/247/249/250`），机制相同但 AC 不同。`AC-269` 字样在 `scripts/`、`server/`、`src/` 下的命中只有 `scripts/mcp-smoke.mjs` 与 `scripts/mcp-smoke.test.mjs`（即判据本体与其护栏单测，属只跑不改的 Touches）。

### AC5 承重面未被本条触碰（逐字）

```
$ git diff --name-only develop...HEAD -- server src goals scripts
(空)

$ git diff --stat develop -- scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-external-client.md
(空)

$ # blob 相等
scripts/mcp-smoke.mjs:                            HEAD=e58a0accb02b2e0ad8041cd26ecd63b8c4302b27  develop=e58a0accb02b2e0ad8041cd26ecd63b8c4302b27
scripts/mcp-smoke.test.mjs:                       HEAD=05f10ff6b4ba379349847251307c78f2ccc42960  develop=05f10ff6b4ba379349847251307c78f2ccc42960
docs/proposals/cloudcli-mcp-external-client.md:   HEAD=5e42d39b20b645a73c64f3f22ac08c76fdbfb204  develop=5e42d39b20b645a73c64f3f22ac08c76fdbfb204

$ git stash list
(空)

$ git status --porcelain
(空)
```

未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`scripts/**`、`goals/**`；交付物只动 `tasks/<本条 id>.md`（经 `task_write`）。

### AC6 如实登记

**被提交的树满足 AC-269**：检出（rev `d3d6fcd6`，三承重文件 blob 与 `develop` 相等）直跑判据 **5 次全部 exit 0**，stdout 逐字 `记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串`；配套护栏单测 `node --test scripts/mcp-smoke.test.mjs` exit 0、`39/39/0`。**判据本体读数已给出，不以单测读数替代。**

**台账 3 拍 fail 尾部由 merge race 造成**：修复 `bc0d788e`（`2026-10-05T23:22:55Z`，三件套 = 记录文件 + `--check-external-record` 实现 + 39 例护栏单测）最初只提交在 task 分支 `task/gap-ac269-external-client-record` 上；fan-in `5392bf9a` 于 `2026-10-05T23:28:12Z`（`develop@{2026-10-06 07:28:12 +0800}: push`）才把它带进 develop。末拍红发生在 `23:26:04.572Z`，**早于落地约 128s**，其被测树 `8ba0cbba`（属主 `825bf795`）里 `cat-file -e` 对记录文件 128、对冒烟脚本 0 —— 即那棵树根本没带修复。修复进 develop 之后的第一拍（`23:36:48.145Z`，树 `dd2cfdbb`，含 `5392bf9a`）立刻 `verdict: pass` / `acceptance passed (exit 0)`，构成独立正控制。

**残留未钉死假设（如实登记，本条不触碰）**：AC-269 的判据是**结构性**的（九节齐全 + 每节 `读数：`/`结论：` 非空 + 公网基址不含令牌串）。它**证不了九节读数是真的外部客户端绑定** —— 把真读数与一份格式合格但编造的记录区分开，属于 **AC-270 的人工关卡**（`gap-ac270-external-client-human-gate`，`status: ready`）。GOAL-021 的最终验收结论仍由人 yale 在 AC-270 给出；本条只把「判据在净检出上是绿的」与「台账尾部红是竞态」两件事入档。

**未走停手上报分支**：本条的直跑为**绿**（5/5 exit 0），DoD 的 `needs-human` 分支不适用。