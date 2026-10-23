---
id: gap-ac135-criterion-ledger-red-is-merge-race
title: AC-135 判据台账尾部红是 merge race：修复 9f83a332 最初只提交在 task 分支，fan-in 0653ac8b 于
  15:41:40Z 才把它带进 develop/主检出，而红拍（15:38:05Z/15:40:34Z）发生在落地之前 ——
  verification-only 归因入档（净树直跑 exit 0 ×2），不重新实现既有修复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-135
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-135 `status: achieved`，其 GOAL-008 已 achieved、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。台账逐字（`.quay/gate-events.jsonl`，`item_id=AC-135`，`gate=goal`，`actor=goal-cli`）最近五拍：

```
2026-10-04T15:14:45.559Z fail
2026-10-04T15:23:36.319Z fail
2026-10-04T15:26:33.996Z fail
2026-10-04T15:38:05.267Z fail
2026-10-04T15:40:34.549Z fail
```

上一拍 pass 为 `2026-09-23T09:17:28.841Z`（GOAL-008 判 achieved 的同一拍）。

判据物（逐字取自 `goals/AC-135-裁剪决策以能力声明为唯一来源-且默认行为不变.md` 的 `criterion:`）：`node scripts/asr-trim-capability-check.mjs`。

**本轮直接现测：判据在检出上退出 0（工作树满足 AC-135）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD` = `0653ac8b`，`git status --short` 无 tracked 修改）直跑两次，六条 check 全 ok，退出码 0：

```
check declaration: ok the registration table (shared/asr/asrRegistry.ts) declares 3 row(s), read off the adapter modules
check read-point: ok src/shared/voiceTrim.ts reads the capability at trimDecisionFor
check single-source: ok 1 production file(s) reach trimDecisionFor: src/modules/chat/hooks/useVoiceInput.ts; no file answers 裁不裁 by hand
check decision: ok trimDecisionFor takes the trim path for openai-compatible and declines it for useful
check default: ok a deployment that names no provider resolves to openai-compatible (first registered), which declares destructive and is trimmed; src/shared/voiceDebug.ts's own default is true — the shipped chain still trims
check discipline: ok every declaration outside destructive names its own paired experiment, and every named record exists
run1=0 run2=0
```

而台账那批 fail 的逐字理由是：`check single-source: FAIL no production file reaches trimDecisionFor — the capability is declared and never read, so 裁不裁 is still decided elsewhere (trimDecisionFor is unreachable)`。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 这是「goal-gate-red-can-race-the-fixs-own-landing」的又一实例：

- 修复提交 `9f83a332`「voice: the continuous path's gap filter reads the recogniser's pauseCues declaration」（`2026-10-04 23:35:00 +0800` = `15:35:00Z`）把 `trimDecisionFor` 的读取点接进 `src/modules/chat/hooks/useVoiceInput.ts`（第 405 行），它闭合的是 `gap-voice-trim-decision-continuous-path`（done）登记的那条回归。
- 该修复**最初只提交在 task 分支上**；主检出 `author` 在 `15:38:05Z` / `15:40:34Z` 两拍 fail 时的 HEAD 是 `dcddd9f4`（`23:37:02`）。`git merge-base --is-ancestor 9f83a332 dcddd9f4` = **非 0** ⇒ 判据被测的那棵树**不含修复**。
- fan-in 落地提交 `0653ac8b`「tasks: 翻 gap-voice-trim-decision-continuous-path done（driver 机械 fan-in）」（`23:41:40` = `15:41:40Z`）才把 `9f83a332` 带进 `author`/`develop`。现 `git rev-parse develop` = `0653ac8b`，`git merge-base --is-ancestor 9f83a332 develop` = 0，`git show develop:src/modules/chat/hooks/useVoiceInput.ts | grep -n trimDecisionFor` 命中第 `53:` 与 `405:` 行。
- 即：最后一拍红（`15:40:34Z`）比修复落进 develop/主检出（`15:41:40Z`）早约 66 秒。

⇒ **早先的修复是有兜住的**（`gap-voice-trim-decision-continuous-path`，done）；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-135 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，`git rev-parse HEAD` = `0653ac8b`）：`grep -rn "^goal_ac: *AC-135" tasks/*.md` 命中 4 条，`status:` 逐字皆 **done**（`gap-asr-trim-capability-wiring`、`gap-asr-omni-paired-quality-record`、`gap-asr-trim-capability-node-alias-unresolved`、`gap-voice-trim-decision-continuous-path`）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-135`）→ **0 命中** ⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（`goal_ac: AC-184`，ready）是**另一条 AC**（运行期 HMR 崩 React 树，不同判据、不同页面），仅归因机制族相同。

**残留的未钉死假设（如实登记）**：`check single-source` 的 consumer 侧是**文本**判定 —— 对除声明模块外的生产文件取 `\b<readPointName>\b` 正则（此处即 `\btrimDecisionFor\b`），只要文件正文出现该符号即计为 consumer，不校验它是否在**运行时**被调用。所以「连续路径真的按 `pauseCues` 决策裁剪」在本判据里由 `useVoiceInput.ts:405` 的一次文本引用钉住；真正的端到端行为（裁剪 on/off 配对）属 AC-119 的浏览器判据，不在本条重复。

本任务是 **verification-only 归因入档**：不改实现、判据、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据两次：`node scripts/asr-trim-capability-check.mjs`，逐字抄六条 check 行与退出码。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%H %ci %s' 9f83a332`、`git log -1 --format='%H %ci %s' 0653ac8b`、`git rev-parse develop`、`git merge-base --is-ancestor 9f83a332 develop; echo $?`、`git merge-base --is-ancestor 9f83a332 dcddd9f4; echo $?`、`git show develop:src/modules/chat/hooks/useVoiceInput.ts | grep -n trimDecisionFor`；并复算「最后一拍红 15:40:34Z < fan-in 落地 15:41:40Z」。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-135 `gate=goal` 的 fail/pass 尾部（逐字时间戳 + 理由）。
5. 交付只落在 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑两次：`node scripts/asr-trim-capability-check.mjs` 均退出 **0**，六条 check 行（`declaration` / `read-point` / `single-source` / `decision` / `default` / `discipline`）逐字入档，其中 `single-source` 行须含 `src/modules/chat/hooks/useVoiceInput.ts`。红态基线（本轮立案读数）：主检出 `15:40:34Z` 那拍退出 1，红在 `check single-source: FAIL no production file reaches trimDecisionFor … (trimDecisionFor is unreachable)`。
- [x] AC2 承重的 ancestry 证据机械入档：`git log -1 --format='%H %ci %s' 9f83a332` → 修复提交 `2026-10-04 23:35:00 +0800`；`git log -1 --format='%H %ci %s' 0653ac8b` → fan-in `2026-10-04 23:41:40 +0800`；`git merge-base --is-ancestor 9f83a332 dcddd9f4; echo $?` → 非 0（修复**不在**最后一拍红时的主检出 HEAD 上）；`git merge-base --is-ancestor 9f83a332 develop; echo $?` → 0；`git show develop:src/modules/chat/hooks/useVoiceInput.ts | grep -n trimDecisionFor` → 命中 `53:` 与 `405:`。命令与逐字输出入档。
- [x] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-135`、`gate=goal` 的 fail 尾部（至少 `15:38:05.267Z`、`15:40:34.549Z`）与上一拍 pass（`2026-09-23T09:17:28.841Z`）逐字抄出，并写明「最后一拍红（15:40:34Z）早于 fan-in 落地（15:41:40Z）约 66s」。
- [x] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-135" tasks/*.md` 的命中集合与其 `status:` 逐字入档；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-135`）若命中的是本条自身，须注明；并写明同族先例 `gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（另一条 AC）。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `src/**`、`scripts/**`、`goals/**`）。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-135**」与「台账 fail 尾部由修复 `9f83a332` 最初只提交在 task 分支、fan-in `0653ac8b` 于 `15:41:40Z` 才把它带进 develop/主检出、而判据红拍发生在落地之前造成」，并给出残留未钉死假设（`single-source` 为文本判定、端到端配对属 AC-119）；⛔ 不得用 jsdom/单元层读数替代判据本体。

## DoD

- 出货命令（`node scripts/asr-trim-capability-check.mjs`，逐字不改；⛔ 不改断言、不改脚本）在净检出上真的跑过、退出 0，六条 check 行逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、fan-in 时刻、`merge-base --is-ancestor` 退出码、develop 上的 `trimDecisionFor` 命中行、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `9f83a332` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据脚本、实现、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- `tasks/gap-ac135-criterion-ledger-red-is-merge-race.md`（自触）
- `scripts/asr-trim-capability-check.mjs`（本条只跑不改：判据本体）
- `scripts/asr-trim-capability-check.test.mjs`（本条只跑不改：判据自带的反假形态工装）
- `scripts/asr-pause-cues-source-check.mjs`（本条只读不改：registry declarations 的读数来源，被判据 import）
- `src/modules/chat/hooks/useVoiceInput.ts`（本条只读不改：修复落点 / 承重 consumer，第 405 行读 `trimDecisionFor`）
- `src/shared/voiceTrim.ts`（本条只读不改：read point 声明模块）
- `goals/AC-135-裁剪决策以能力声明为唯一来源-且默认行为不变.md`（本条只读不改：criterion/expect 逐字来源）

## 完成记录

worker `gap-ac135-criterion-ledger-red-is-merge-race`，2026-10-04。verification-only 归因入档：不改实现、判据、goals、宿主配置一个字节。

### AC1 — 判据在净检出两跑皆 exit 0

隔离 worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac135-criterion-ledger-red-is-merge-race`
`git rev-parse HEAD` = `d4d2c3281e79a396e5ad2bcdaba60df86d37b270`（= 开工时 `develop`）；`git status --porcelain` 空。

`node scripts/asr-trim-capability-check.mjs` 直跑两次，逐字输出（两跑一致）：

```
scan: 680 production sources under /data/home/yale/work/claudecodeui-worktrees/gap-ac135-criterion-ledger-red-is-merge-race across 5 globs
declaration module: src/shared/voiceTrim.ts
check declaration: ok the registration table (shared/asr/asrRegistry.ts) declares 3 row(s), read off the adapter modules
declared provider=openai-compatible pauseCues=destructive evidence=docs/experiments/2026-09-22-voice-provider-paired-quality.md
declared provider=multimodal pauseCues=useful evidence=docs/experiments/2026-09-23-gemini.md
declared provider=dashscope-omni pauseCues=neutral evidence=docs/experiments/2026-09-24-omni-written.md
check read-point: ok src/shared/voiceTrim.ts reads the capability at trimDecisionFor
check single-source: ok 1 production file(s) reach trimDecisionFor: src/modules/chat/hooks/useVoiceInput.ts; no file answers 裁不裁 by hand
check decision: ok trimDecisionFor takes the trim path for openai-compatible and declines it for useful
check default: ok a deployment that names no provider resolves to openai-compatible (first registered), which declares destructive and is trimmed; src/shared/voiceDebug.ts's own default is true — the shipped chain still trims
check discipline: ok every declaration outside destructive names its own paired experiment, and every named record exists
run1=0 run2=0
```

六条 check（`declaration` / `read-point` / `single-source` / `decision` / `default` / `discipline`）全 ok；`single-source` 行逐字含 `src/modules/chat/hooks/useVoiceInput.ts`。红态基线（台账 AC-135 `gate=goal` `15:40:34.549Z` 拍 payload 逐字）：`check single-source: FAIL no production file reaches trimDecisionFor — the capability is declared and never read, so 裁不裁 is still decided elsewhere (trimDecisionFor is unreachable)`（exit 1）。

### AC2 — ancestry 证据（逐字）

```
$ git log -1 --format='%H %ci %s' 9f83a332
9f83a3326c359c413884ce64b5bbe37c8b6eb5ca 2026-10-04 23:35:00 +0800 voice: the continuous path's gap filter reads the recogniser's pauseCues declaration
$ git log -1 --format='%H %ci %s' 0653ac8b
0653ac8b575661238ed8d3a920420a5c23753c54 2026-10-04 23:41:40 +0800 tasks: 翻 gap-voice-trim-decision-continuous-path done（driver 机械 fan-in）
$ git log -1 --format='%H %ci %s' dcddd9f4
dcddd9f4dc95deb8406ea089c4d2283dae7cfe17 2026-10-04 23:37:02 +0800 tasks: gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout todo→ready（promotion-driver 机械晋升）
$ git rev-parse develop
d4d2c3281e79a396e5ad2bcdaba60df86d37b270
$ git merge-base --is-ancestor 9f83a332 dcddd9f4; echo $?
1
$ git merge-base --is-ancestor 9f83a332 develop; echo $?
0
```

**行号随 develop 前进漂移（机制不变）**：AC 记的 `53:`/`405:` 是 fan-in 提交 `0653ac8b` 上的读数（`git show 0653ac8b:src/modules/chat/hooks/useVoiceInput.ts | grep -n trimDecisionFor` → `53:`/`405:`，与修复提交 `9f83a332` 相同）；`develop` 现为 `d4d2c328`，同一命令 `git show develop:src/modules/chat/hooks/useVoiceInput.ts | grep -n trimDecisionFor` 命中：

```
50:import { trimDecisionFor } from '@/shared/voiceTrim';
402:  if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) {
```

（两行各前移 3 行。）在最后一拍红的主检出 HEAD `dcddd9f4` 上，`git show dcddd9f4:src/modules/chat/hooks/useVoiceInput.ts | grep -n trimDecisionFor` **无任何命中**（rc=1）⇒ 被判据测的那棵树不含修复。

时刻复算：修复 `9f83a332` @ `15:35:00Z`；最后一拍红 `15:40:34.549Z`；fan-in 落地 `0653ac8b` @ `15:41:40Z`。`15:41:40 − 15:40:34 = 66s` ⇒ **最后一拍红早于修复进 develop/主检出约 66 秒**。

### AC3 — 台账尾巴（逐字）

`item_id=AC-135`、`gate=goal`、`actor=goal-cli`：

```
2026-10-04T12:51:18.530Z pass        ← fail 块紧邻之前的最后一拍 pass
2026-10-04T15:14:20.446Z fail        ← fail 块起始
2026-10-04T15:14:45.559Z fail
2026-10-04T15:23:36.319Z fail
2026-10-04T15:26:33.996Z fail
2026-10-04T15:38:05.267Z fail
2026-10-04T15:40:34.549Z fail        ← 最后一拍红
2026-10-04T15:47:48.911Z pass        ← fan-in 落地（15:41:40Z）之后第一拍
2026-10-04T15:49:49.564Z pass
2026-10-04T15:52:01.845Z pass
```

fail 拍逐字理由：`acceptance failed (exit 1) — … check single-source: FAIL no production file reaches trimDecisionFor — the capability is declared and never read, so 裁不裁 is still decided elsewhere (trimDecisionFor is unreachable)`；pass 拍逐字理由：`acceptance passed (exit 0)`。

**勘误（如实登记）**：AC/Proposal 写「上一拍 pass 为 `2026-09-23T09:17:28.841Z`」——该时间戳在 `.quay/gate-events.jsonl` 里**不存在**为 AC-135 事件。全库唯一含 `09:17:28` 的是 `item_id=AC-148`（`2026-09-26T09:17:28.627Z` pass）；AC-135 `gate=goal` 最接近该时刻的三拍 pass 为 `2026-09-23T09:16:39.544Z` / `2026-09-23T09:17:25.499Z` / `2026-09-23T09:18:38.412Z`（GOAL-008 判 achieved 的那批 09:16–09:18 同批读数）。且 fail 块**紧邻的前一拍 pass 实为 `2026-10-04T12:51:18.530Z`**，不是 09-23。勘误不改机制结论。

**landing 后收敛（更强）**：fan-in `15:41:40Z` 把修复带进 develop/主检出后，`gate=goal` 的下一拍（`15:47:48.911Z`，约 +6min）即转 pass，并连续三拍 pass（`15:47:48` / `15:49:49` / `15:52:01`）。即台账尾巴不是「修复失效后的持续红」，而是「修复落地前后的红→绿过渡」。

### AC4 — 机制去重复核（逐字）

`grep -rn "^goal_ac: *AC-135" tasks/*.md`：

```
tasks/gap-ac135-criterion-ledger-red-is-merge-race.md:13:goal_ac: AC-135          status: ready   ← 本条自身
tasks/gap-asr-trim-capability-wiring.md:13:goal_ac: AC-135                        status: done
tasks/gap-asr-omni-paired-quality-record.md:15:goal_ac: AC-135                    status: done
tasks/gap-asr-trim-capability-node-alias-unresolved.md:12:goal_ac: AC-135         status: done
tasks/gap-voice-trim-decision-continuous-path.md:12:goal_ac: AC-135               status: done
```

在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-135`）→ 唯一命中**本条自身**（`ready`），**无第三方在飞认领者** ⇒ 本条不是重复。同族先例 `gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（`goal_ac: AC-184`，现 `status: done`——Proposal 记 ready 是立案时读数，develop 前进后该条已翻 done）是**另一条 AC**（运行期 HMR 崩 React 树，不同判据、不同页面），仅归因机制族相同（`goal-gate-red-can-race-the-fixs-own-landing`）。

### AC5 — 承重面未被本条触碰

`git diff --name-only develop..HEAD` **为空**；`git diff --name-only develop...HEAD` **为空**。原因：ABI 的 `task_write` tick 经 push-through 已落进 develop（`git log` 中 `tasks: <id> task_write by cli:<pid>` 族对 `develop` 是祖先），worktree 合并 develop 后 HEAD 与 develop 树逐字相同 ⇒ 二点树比较为空。这是 AC5 字面「只含 `tasks/<id>.md`」的**更强形态**（连 task 文件都不在差集里，因为两侧同持 tick）。承重面核验：`git diff --name-only develop...HEAD -- src scripts goals` 空；`scripts/asr-trim-capability-check.mjs`、`src/modules/chat/hooks/useVoiceInput.ts`、`src/shared/voiceTrim.ts` 的 blob 均与 develop 相等（`git diff --stat develop -- <file>` 空）。`git status --porcelain` 与本条开工快照（空）逐字相同。⛔ 未 `stash`、未 `git checkout --`、未编辑任何 `src/**`、`scripts/**`、`goals/**`。

### AC6 — 判法

**被提交的树满足 AC-135**：判据 `node scripts/asr-trim-capability-check.mjs` 在净检出上两跑皆 exit 0、六条 check 全 ok。

**台账 fail 尾部是 merge race**：修复提交 `9f83a332`（`15:35:00Z`，「voice: the continuous path's gap filter reads the recogniser's pauseCues declaration」）**最初只提交在 task 分支上**；判据红拍（`15:38:05Z` / `15:40:34Z`）时主检出 HEAD `dcddd9f4` 不含该修复（`git merge-base --is-ancestor 9f83a332 dcddd9f4` = 1；该树上 `useVoiceInput.ts` 无 `trimDecisionFor` 引用）；fan-in `0653ac8b` 于 `15:41:40Z` 才把它带进 develop/主检出（最后一拍红后约 66s）；此后 `gate=goal` 下一拍即转 pass 并连续三拍 pass。

⇒ **修复 `9f83a332` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-135 回归。**

**残留未钉死假设**：`check single-source` 的 consumer 侧是**文本**判定 —— `scripts/asr-trim-capability-check.mjs:433` 对除声明模块外的生产文件取 `new RegExp` 的 `\b<readPointName>\b`（此处 `\btrimDecisionFor\b`）正则，只要文件正文出现该符号即计为 consumer，**不校验它是否在运行时被调用**。所以「连续路径真的按 `pauseCues` 决策裁剪」在本判据里由 `useVoiceInput.ts` 的一次文本引用钉住（引用行随 develop 漂移：`0653ac8b`→405、`d4d2c328`→402）；真正的端到端行为（裁剪 on/off 配对）属 AC-119 的浏览器判据，本条不重复。⛔ 未用 jsdom/单元层读数替代判据本体。