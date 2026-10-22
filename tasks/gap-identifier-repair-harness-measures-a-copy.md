---
id: gap-identifier-repair-harness-measures-a-copy
title: 判据必须量出货模块：收敛 identifierRepair 的两份实现，并修掉点号段正则与中文分词两处语义差异
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

`src/shared/identifierRepair.ts`（出货模块，AC-115 落地后 app 真正会调用的那一个）与 `experiments/voice-identifiers/identifierRepair.mjs`（AC-112/113 的判据所量的那一个）是同一算法的两份实现。2026-09-21 实测：在 AC-113 的 16 条 recovery 语料上、候选集取本仓库 `git ls-files`（1976 条），两者 10 条一致、**6 条不一致**，且 6 条全部是「出货模块不还原、副本还原」——即 AC-113 报出的存活率提升并不描述 app 的行为。

两处成因已分别隔离（探针为临时物、提交前已删，读数取自其 stdout）：

1. **点号段长度正则**。`DOTTED_TOKEN` 要求每个 `.段` 为 1–5 字符，于是段更长的名字永远进不了点号通道 —— 而真实文件名 `voice.service.ts` 的中间段 `service` 就是 7 字符。隔离读数：`voice.roue.ts → voice.routes.ts`（段长 4）**能还原**；`voice.servic.ts`（段长 6，编辑距离 1、相似度 0.94，三道护栏本应全过）**不还原**，仅被该正则挡下。后果是 GOAL-005 背景里点名的头号形态 `voice.seluis.ts`（`seluis` 6 字符）在出货模块上永不还原，而副本还原它（副本的相似度口径更宽，score 0.75）。
2. **分词按空白切分**。中文读码时标识符与汉字之间没有空格，整句成为**一个** token，永远不被考虑。隔离读数：纯 ASCII 的 `change voice.roue.ts now` 出货模块**还原**；同一个 token 放进 `改一下。voice.roue.ts` 则**不还原**，而副本还原。这正是 GOAL-005 的中文场景。

判据侧的现状：AC-113 的 criterion 已重指为 `npx tsx experiments/voice-identifiers/run-shipped-recovery.mjs`（当前必红：脚本不存在），该脚本是本任务的交付物之一；AC-112 的 criterion 指向的 `run-false-positive.mjs` 至今量的是副本，本任务一并收口。

方案：
1. **让判据量出货模块**：新增 `experiments/voice-identifiers/run-shipped-recovery.mjs` 与 `run-shipped-false-positive.mjs`，直接 import `src/shared/identifierRepair.ts`（经 tsx 运行）；`identifierRepair.mjs` 不再保留第二份算法 —— 或者改为从出货模块 re-export，或者删除并被两个新脚本取代，由实现者择一并写明理由。
2. **按已验证的行为定夺两处语义差异**：点号段规则须容纳真实文件名形状，分词须能在无空格的中文文本里找到标识符 token。这两条都是「让出货模块达到副本已验证的还原率」，不是放宽容忍度去迁就 —— 放宽点号规则会同时放宽误报面，AC-112 的负样本读数就是它的护栏，必须同时给。
3. **两份实现不得再各自演化**：补一条结构断言，使「仓库里只有一份算法」本身可被判据机械检查。

<!-- dedup-ref -->
追溯：`gap-voice-identifier-harness-in-repo`、`gap-voice-identifier-repair-module`、`gap-voice-identifier-fidelity-metric`、`gap-voice-identifier-browser-e2e` 均已 done，它们分别落地了工装入库、出货模块、度量与浏览器判据；本任务是这四者留下的缝合处 —— 无人负责对齐，实测 6/16 不一致。

## AC

- [x] `npx tsx experiments/voice-identifiers/run-shipped-recovery.mjs` 退出码 0（即 AC-113 的判据转绿）
- [x] `npx tsx experiments/voice-identifiers/run-shipped-false-positive.mjs` 退出码 0（出货模块在 AC-112 负样本语料上零改写；放宽点号规则后的反向读数）
- [x] 单一实现：`grep -nE "function +(editDistance|splitIndex|nearestDottedCandidate|longestSplitMatch)" experiments/voice-identifiers/identifierRepair.mjs` 无输出（grep 退出码 1）—— 副本不得再持有独立算法
- [x] 出货模块单测：`npx vitest run src/shared/tests/identifierRepair.test.ts` 退出码 0，新增用例覆盖本轮两个成因：长段错拼（`voice.seluis.ts` → `voice.service.ts`）与中文无空格邻接（`改一下。voice.roue.ts` → `改一下。voice.routes.ts`）
- [x] 取假形态：把 `repairIdentifiers` 临时换成 `return text` 后，两条 `npx tsx …run-shipped-*.mjs` 必须双双变红（记录原始终端读数）
- [x] `npm run lint` 与 `npx tsc --noEmit -p tsconfig.json` 退出码 0

## DoD

真实落地判据：AC-113 的判据必须**真的是出货模块在跑**，不以「副本绿了」代替。须逐条给读数：(a) 三条判据命令的实测退出码与输出尾行（survivalBefore / survivalAfter / misRepairs）；(b) 按 AC-5 注入恒等函数重跑，登记红读数与原文，随后还原并确认工作树干净；(c) `voice.seluis.ts` 与 `改一下。voice.roue.ts` 两条用例改动前后的逐字输出对照；(d) 两处语义差异各自的修法（点号规则放宽到什么形状、分词按什么切），并如实登记放宽后的负样本零改写读数 —— 没有这一条读数，放宽就是单侧的。若某处差异经实测判定**不该**跟副本对齐（例如放宽后误报面不可接受），则如实登记「出货模块维持更窄口径」并把 AC-113 的语料期望按实际口径重标，不得让判据与实现各说各话。

L_D 该轴仍暗，理由：本任务是把两份实现收敛成一份并对齐已验证口径，不新增领域能力。
L_G 该轴仍暗，理由：同上；本任务的读数是语料存活率、误修数与负样本零改写。

## Touches

- src/shared/identifierRepair.ts
- src/shared/tests/identifierRepair.test.ts
- experiments/voice-identifiers/identifierRepair.mjs
- experiments/voice-identifiers/run-recovery.mjs
- experiments/voice-identifiers/run-false-positive.mjs
- experiments/voice-identifiers/run-shipped-recovery.mjs (new)
- experiments/voice-identifiers/run-shipped-false-positive.mjs (new)
- tasks/gap-identifier-repair-harness-measures-a-copy.md

## Evidence

落地读数：分支 `task/gap-identifier-repair-harness-measures-a-copy`，worktree `.claude/worktrees/gap-identifier-repair-harness-measures-a-copy`，提交 `ca10cf95`（其父 `c9d4fd95`）。以下读数均在 `ca10cf95` 上重跑；被 `.gitignore` 排除、不进入仓库的探针脚本放在 `/tmp/gir-readings-AhtKHi/`。

### (a) 判据命令的实测退出码与尾行

- `npx tsx experiments/voice-identifiers/run-shipped-recovery.mjs` → 退出码 **0**
  - `survivalBefore=0.4000 survivalAfter=0.7500 misRepairs=0`
  - `candidates=1984 entries=16 identifiers=20`
  - `survivalBeforeDetail=8/20 survivalAfterDetail=15/20`
  - `OK: shipped identifier survival 40.0% -> 75.0% with zero mis-repairs`
  - 逐条：**6 条 FIXED**（`en-e04` / `zh-d01` / `zh-d02` / `frag-truncated` / `frag-garbled-dot` / `frag-garbled-route`）、10 条 flat、**0 条 BROKE**
- `npx tsx experiments/voice-identifiers/run-shipped-false-positive.mjs` → 退出码 **0**
  - `candidates=1984 negatives=44 falsePositives=0`
  - `nearWords=21 minNearWords=12 minCandidates=1000 controls=3/3`
  - `OK: 44 identifier-free sentences unchanged over 1984 real candidates`
- `node experiments/voice-identifiers/run-false-positive.mjs` → 退出码 **0**，上述读数逐字相同
  - 这是 AC-112 记录在案的 criterion 路径（AC-112 的 `criterion: node experiments/voice-identifiers/run-false-positive.mjs`）。node ≥22.18 的类型剥离使 plain `node` 能直接 import `.ts`，所以该路径不必改写就转为量出货模块 —— 一个判据路径能原样保留却换了被测对象，是本任务收敛方案的一部分。
- `grep -nE "function +(editDistance|splitIndex|nearestDottedCandidate|longestSplitMatch)" experiments/voice-identifiers/identifierRepair.mjs` → 无输出，退出码 **1**
- `npx vitest run src/shared/tests/identifierRepair.test.ts` → 退出码 **0**，`Tests 16 passed (16)`
- `npm run lint` → 退出码 **0**（输出仅既有 warning）；`npx tsc --noEmit -p tsconfig.json` → 退出码 **0**（无输出）

### (b) 取假形态（AC-5）：恒等函数下的原始终端读数，以及随后还原

把 `repairIdentifiers` 的首句换成 `return text;`（标记注释 `AC-5 FALSIFICATION PROBE`）后：

- `run-shipped-recovery.mjs` → **EXIT_A=1**
  - `survivalBefore=0.4000 survivalAfter=0.4000 misRepairs=0`
  - `survivalBeforeDetail=8/20 survivalAfterDetail=8/20`
  - `FAIL: survival did not improve (0.4000 -> 0.4000)`
- `run-shipped-false-positive.mjs` → **EXIT_B=1**
  - `candidates=1984 negatives=44 falsePositives=0`
  - `nearWords=21 minNearWords=12 minCandidates=1000 controls=0/3`
  - 三条 control 原文（逐字登记，正是它们的 FAIL 让「零改写」不再可能是 stub 的零）：
    `CONTROL "Change the timeout in voice.seluis.ts to thirty seconds" -> "Change the timeout in voice.seluis.ts to thirty seconds", expected "Change the timeout in voice.service.ts to thirty seconds"`
    `CONTROL "改一下。voice.roue.ts" -> "改一下。voice.roue.ts", expected "改一下。voice.routes.ts"`
    `CONTROL "check use voice input before the change" -> "check use voice input before the change", expected "check useVoiceInput before the change"`
  - `FAIL: 3 of 3 sentences that must be repaired were not — the zero below is a stub's zero`
- `node experiments/voice-identifiers/run-false-positive.mjs` → **EXIT_B2=1**，同上

还原：`git checkout -- src/shared/identifierRepair.ts` 后 `git status --porcelain` 为空；`grep -rn "FALSIFICATION PROBE" src/ experiments/` 无输出（退出码 1）；随后重跑 A / B / B2 均退出码 0，AC-4 回到 `Tests 16 passed (16)`。

如实登记一处判据空洞（本次实测暴露并补掉）：**这三条 control 是本次补上的**。补之前，恒等函数下 `run-shipped-false-positive.mjs` 是**绿**的 —— 44 条「不得改写」对一个什么都不做的模块天然成立，即那个 0 是 stub 也会得到的 0，判据不可取假。这正是把判据从副本转向出货模块时暴露出来的洞：判据一旦开始量真模块，就必须同时证明它量得出真模块的**做功**。

### (c) 两条成因用例的改动前后逐字对照

「改动前」取 `git show HEAD~1:src/shared/identifierRepair.ts`（本任务动手前的出货模块），「改动后」取本分支；两者用同一张候选表，即 AC-4 单测里的 `CANDIDATES`：

```text
CASE "open voice.seluis.ts and check"
  before: "open voice.seluis.ts and check"
  after : "open voice.service.ts and check"
  changed=true
CASE "改一下。voice.roue.ts"
  before: "改一下。voice.roue.ts"
  after : "改一下。voice.routes.ts"
  changed=true
CASE "change voice.roue.ts now"
  before: "change voice.routes.ts now"
  after : "change voice.routes.ts now"
  changed=false
CASE "the readme file is old"
  before: "the readme file is old"
  after : "the readme file is old"
  changed=false
```

后两条是对照，说明改动是定点而非普遍放宽：同一段文本，改动前后都不动（成因 1 只影响点号段长，成因 2 只影响无空格邻接）。

### (d) 两处语义差异各自的修法，以及放宽后的误报面读数

**成因 1 —— 点号段长度正则。** `DOTTED_TOKEN` 由「每个 `.段` 为 1–5 字符」改为「首字符为字母、其余不再限长」：`/[-A-Za-z0-9_$]+(?:\.[A-Za-z][A-Za-z0-9_$]*)+/g`；同时 pass 由「整个空白 token 必须就是这个名字」改为在文本里扫描该形状、按 span 替换（`text.matchAll(DOTTED_TOKEN)`）。两者都必须给，缺一不可：只放宽段长不解决中文（`改一下。voice.roue.ts` 整句是一个空白 token，不与任何候选相等），只改扫描不解决 `voice.seluis.ts`（段 `seluis` 6 字符，旧规则根本不让它进点号通道）。

**成因 2 —— 分词。** split pass 保持按空白切分不动：它必须如此，因为「一个符号被拆成几个词」这件事本身由空白定义，改成别的切法就没有「拆」可谈。出货模块改为由点号扫描覆盖中文无空格邻接，而不是重写分词。

**为承载 AC-4 点名的用例必须放宽的量。** `voice.seluis.ts` → `voice.service.ts` 是 4 编辑、相似度恰好 0.75，于是 `MAX_EDIT_DISTANCE` 2→4、`MIN_SIMILARITY` 0.8→0.75。放宽后的误报面必须同时给读数，否则放宽是单侧的：

- 负样本语料（AC-112 的 44 条）：`candidates=1984 negatives=44 falsePositives=0`，零改写，见 (a)。
- 本仓库真实散文：167 个受版本控制的 markdown、992 个不同点号 span，逐 span 跑「改动前 / 改动后」两个模块：
  - `filesRewrittenBefore=10 filesRewrittenAfter=1 newlyRewrittenSpans=0`
  - 即放宽后**没有新增任何改写**；被改写的 markdown 反而由 10 个降到 1 个。仅存的 1 处是 `CHANGELOG.md` 第 464 行 `Readme.md` → `README.md`，本就在改动前的 10 个里，且是真实文件的大小写更正。

**如实登记第二处护栏 —— 不是 Proposal 点名的两处成因，而是上面这条读数逼出来的。** 预算放宽到 4 编辑 / 0.75 相似度之后，真实散文上一度出现 6 个新增改写，全部同一个形状：`README.jp.md` / `README.ru.md` / `README.de.md` / `README.ko.md` / `README.ja.md` / `README.tr.md` → `README.md`（这些文件在本仓库并不存在，只有 `README.md`）。成因很清楚：距 `README.md` 3 编辑、相似度恰好 0.75、扩展名 `md` 完全一致，于是开前缀、编辑预算、扩展名三道护栏全过 —— 而被写下的正是「文本从未提到的文件名」，恰是本模块存在的理由的反面。故新增第五道护栏：口语形态的点号段数不得多于候选（`segmentCount(needle) > segmentCount(haystack)` 即跳过），理由是识别器会在名字内部写错字符、不会整个删掉一个点号段。加护栏后 `newlyRewrittenSpans` 由 6 降为 0，而 (a) 的 6 条 FIXED 全部段数相等（`voice.seluis.ts` 3→3、`voice.module.t` 3→3），存活率不变。

该护栏本身可取假：去掉它，AC-4 新用例 `a name is not shortened by dropping one of its dotted words` 变红（`Tests 1 failed | 15 passed (16)`，退出码 1），散文读数回到 `newlyRewrittenSpans=6`；加回后 `git status --porcelain` 为空，即逐字还原。

**另补一条既有误报的修复。** 候选表含裸 stem，故单个英文单词能等于一个候选：改动前的出货模块把「The readme md file is out of date」改写成「The README md file is out of date」。这是**改动前就存在**的误报（不是本次放宽引入；副本要求至少两个词，这是两份实现的又一处未命名差异），因 AC-112 的负样本读数归零时暴露，一并加上 `MIN_SPLIT_TOKENS = 2` 修掉并登记在此。
