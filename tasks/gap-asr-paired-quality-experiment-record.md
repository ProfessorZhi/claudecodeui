---
id: gap-asr-paired-quality-experiment-record
title: 配对质量实验记录（不判据化）：同一批语料上的配对比较、报 n、带能红的负对照并报告其是否按预测方向移动（无 goal_ac）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: " "
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：全仓无任何任务声明与本条同一机制；`task_list` 全文检索「配对质量」无命中。与本条相邻的是同为 ADR-004 后续任务的「风格化的双向负对照」（本批另一条实验记录）与「两跳字节基线」（AC-130），机制不同 —— 都不做「同一批语料上跨条件配对比较质量读数」。本任务是 ADR-004「后续任务 10」的立案；本条**不引用任何未完成任务 id 作为前置**。

**性质（ADR-004 决策 8）：质量数值不进判据集。** 本条产出的是**实验记录**而非 AC —— 配对质量实验联网、按条件数计请求、单次约数秒 × 数十条，远超判据运行的时长上限；且其中至少一轴按既有先例只能靠人读。因此本任务**不设 `depends_on`**：它是实验记录，其可执行性由外部条件（可达的识别服务 + 凭据 + 一批语料）决定，而不是由任务依赖图决定。

**现场。** ADR-004 决策 8 明确区分「进 AC」与「只进实验记录」，并把质量回归的代价写成**人工义务**：质量结论不进 CI，因此质量回归不会自动被发现 —— 依赖「每接入一个服务就写一份实验记录」。ADR-004 决策 6 还把「每接入一个服务就要重跑一次该服务的配对实验」写成一条持续的验证义务（上下文偏置的隐私与预算代价随之而来）。

**本任务做什么。** 一份实验记录：同一批语料上的**配对比较**（多个条件：不同 provider / 是否裁剪 / 是否给上下文），报 `n`，并带**能红的负对照**，且报告负对照是否按预测方向移动。记录的形状可以由人工核对清单约束，但**不得把「提到了某个词」当作判据** —— 文本匹配无法区分「做了负对照」与「写了负对照」。协议沿用 `docs/experiments/README.md`：配对比较不跨运行、必须有能红的负对照、被测实现必须是出货模块、指标自己先用中文用例自测、不拿参考文本当标点真值、口径要写明、串行执行、结果落盘缓存。

**边界（不做）。** 不改任何出货代码；不把质量读数做成 CI 判据（决策 8）；不做风格化的双向负对照（那是「后续任务 8」）；不做边界探针与命令行的词（AC-129/AC-131）。

## Plan

- **S0 语料与条件。** 固定一批语料与条件列表（provider × 裁剪 × 上下文），每个条件在同一批语料上跑。
- **S1 runner。** 驱动**出货模块**（不得在工装里放第二份实现），取配对读数，落盘缓存；串行执行。
- **S2 负对照。** 一条能红的负对照（`flat` 形态，沿用既有协议），并报告它是否按预测方向移动；负对照去掉即红。
- **S3 记录与留档。** 记录落在 `docs/experiments/`，在 `docs/experiments/README.md` 登记。
- **交付物。** `docs/experiments/2026-09-22-voice-provider-paired-quality.md`（读数：n=8、40 条配对读数、单次运行 `2026-09-22T15:35:41.828Z`；负对照 Δ=-2 按预测方向 down）、`experiments/voice-provider-paired-quality/run.mjs`（离线重算 + 七条自检变异 + 对应关系机检）、`fixtures/`（8 条固定片段 + 冻结快照 `paired.json`，令记录里每个数字都能离线重算）。`fixtures/*.wav` 是继 `experiments/voice-trim/fixtures/` 之后第二处音频入库，理由登记在 `docs/experiments/README.md`。

## AC

- [x] AC1 runner 在同一批语料上产出**配对比较**读数，并报 `n`（`n` 为语料条数）；`n` 为 0 或读数条数为 0 ⇒ 非零退出（空读数不是绿）。`--corpus=empty` ⇒ 退出码 1（`[n] the paired set is empty — n=0 is not a green reading`），真实快照打印 `n=8 × 5 condition(s) = 40 row(s)`。
- [x] AC2 **负对照能红**：把负对照去掉（或置零）⇒ 读数必须红；负对照本身不是「写了就算」，它必须能被触发。`--control=absent` ⇒ 1（`条件表里没有声明负对照`）、`--control=zero` ⇒ 1（Δ=0 `负对照没有移动`）、`--control=inverted` ⇒ 1（`朝预测的**反方向**移动`）、`--control=empty` ⇒ 1。
- [x] AC3 记录报告**负对照是否按预测方向移动**（而不是只报「跑了负对照」）：runner 每次运行都打印 `ok turbo|raw|flat marks=8 vs turbo|raw|none marks=10 (Δ=-2, 2↑ 4= 2↓) —— 按预测方向（down）移动` 与逐片段句读，记录 3.2 节引用了它并给出逐片段表。
- [x] AC4 协议：配对比较不跨运行（run id 落进快照并打印；`--runs=straddle` ⇒ 1，报 `the readings come from 2 different runs`）、被测实现必须是**出货模块**（`--probe` 打印绝对路径 + 符号名 `src/shared/voiceTrim.ts#trimVoiceAudio`、`src/shared/identifierFidelity.ts#identifierFidelity`，并断言两者都在出货树内、工装内无第二份实现）、串行执行（`one call in flight`，最小间隔 3200 ms，写入 `provenance.throttle`）、结果落盘缓存（`out/quality-cache.json` + 入库的冻结快照 `fixtures/paired.json`）。
- [x] AC5 **不判据化（ADR-004 决策 8）**：质量数值不进判据集；且**不得**把「记录里提到了某个词」当作任何判据 —— 文本匹配无法区分「做了负对照」与「写了负对照」。本任务的 `## Touches` 无 `*.test.*`，`scripts/test.sh --for-task … --allow-thin` 报 `no scoped test files … (thin)` 并退出 0；记录与 runner 都不被任何判据脚本引用，runner 末行自陈 `quality numbers are a reading and are NOT a criterion`。
- [x] AC6 不改任何出货代码：本任务的 diff 只含 `docs/experiments/` 与 `experiments/voice-provider-paired-quality/` 下的新文件。`git diff --name-only develop...HEAD` 共 12 个文件，全部落在这两个前缀下。

## DoD

真实落地判据：不是「多了一份实验 md」，而是**同一批语料上的配对比较真的跑了、报了 `n`，且负对照是能红的（并报告了它是否按预测方向移动）**。承重性由两件正面读数证明：

(a) 空读数不是绿：`n` 为 0 或读数条数为 0 必须红（AC1）；
(b) 负对照能红：去掉负对照必须使读数红（AC2）—— 一个「写了负对照但不触发它」的记录等于没有负对照。

**必须如实登记（决策 8 的代价，已被裁定 5 接受）：** 质量结论不进 CI，因此质量回归不会自动被发现，依赖人工义务。本任务**不证明**质量阈值 —— 阈值不可导出（语料是合成的、样本量小、效应方向明确而幅度不确定），一个拍出来的阈值会在下一次语料变化时变成假判据。本轮另有一条实测印证：同一批 8 条片段上 no-prompt 两臂与已发布读数逐字相同（8/8），prompt 两臂从 0/0 变成 22/8 —— **prompt 臂跨运行不可复现**，基于它的阈值更不可导出。

L_D 该轴仍暗，理由：本任务只产出配对质量实验记录，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- docs/experiments/2026-09-22-voice-provider-paired-quality.md (new)
- docs/experiments/README.md
- experiments/voice-provider-paired-quality/run.mjs (new)
- experiments/voice-provider-paired-quality/fixtures/paired.json (new)
- experiments/voice-provider-paired-quality/fixtures/d01-o65.wav (new)
- experiments/voice-provider-paired-quality/fixtures/d02-o65.wav (new)
- experiments/voice-provider-paired-quality/fixtures/d03-o65.wav (new)
- experiments/voice-provider-paired-quality/fixtures/d04-o65.wav (new)
- experiments/voice-provider-paired-quality/fixtures/d05-o65.wav (new)
- experiments/voice-provider-paired-quality/fixtures/d06-o65.wav (new)
- experiments/voice-provider-paired-quality/fixtures/d07-o65.wav (new)
- experiments/voice-provider-paired-quality/fixtures/d08-o65.wav (new)
- tasks/gap-asr-paired-quality-experiment-record.md
