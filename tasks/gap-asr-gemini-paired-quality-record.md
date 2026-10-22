---
id: gap-asr-gemini-paired-quality-record
title: Gemini 配对质量实验记录（S3，不判据化）：同一运行内 Gemini × whisper 基线 × 裁剪臂 × 负对照，并把
  multimodal 的 PAUSE_CUES_EVIDENCE 重指到这份实测
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-multimodal-adapter-real-gemini-wire
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`docs/experiments/` 下三份记录（`2026-09-22-voice-provider-paired-quality.md`、`-voice-punctuation.md`、`-voice-style-negative-control.md`）全是 whisper 家族或 Groq chat 替身，没有一份测过 Gemini；`tasks/` 检索「gemini 配对 / 2026-09-23-gemini」零命中。相邻任务 `gap-asr-paired-quality-experiment-record`（done）建立了配对实验的协议与 runner 形状，本任务沿用其协议、换被测服务。被测的是出货 multimodal 适配器修好线协议之后的行为，该修复由 `depends_on` 字段表达。

**现场。** proposal `docs/proposals/voice-asr-provider-seam.md` 的 S3 要求一份 `docs/experiments/<date>-gemini.md`（同语料、`flat` 负对照、五轴读数），ADR-004 决策 8 把「每接入一个服务就写一份」定为人工义务、不进 CI —— 所以这个缺口没有被任何判据发现。另一处诚实性问题：`shared/asr/asrRegistry.ts` 的 `PAUSE_CUES_EVIDENCE[multimodalId]` 指向那份 whisper 配对记录，而那份记录一个字都没提 multimodal；判据（`scripts/asr-pause-cues-source-check.mjs`）只做 `existsSync`，所以 `pauseCues: 'useful'` 这条非默认声明目前只有 ADR-004 §二 的推断作依据，没有对该服务的实测。

**2026-09-23 的一次性探针读数（未冻结、不跨运行可比，仅作为立案依据）**：同 8 条 o65 语料、同一 CER 口径（去标点与空白逐字编辑距离）——whisper-turbo（旧快照）0.132；gemini-2.5-flash-lite + 逐字指令 0.195；+ 书面化指令 0.456；gemini-3.5-flash-lite + 书面化 0.273；gemini-2.5-flash + 书面化 0.273 但均值 9.7s。Gemini 在长停顿处按行切碎输出，这正是 `pauseCues` 那一轴要回答的：裁掉停顿对 Gemini 是伤害还是帮助。

**本任务做什么：**

- 新 runner `experiments/voice-gemini-paired-quality/run.mjs`，复用 `experiments/voice-provider-paired-quality/fixtures/d0*-o65.wav` 与 `paired.json` 的参考文本（不复制音频），沿用前一份记录的协议：`--live` 落缓存 → `--freeze` 冻结到 `experiments/voice-gemini-paired-quality/fixtures/gemini.json` → 默认离线重算；串行、最小间隔、run id 入快照。
- **同一运行内**的条件（配对比较不跨运行）：`turbo|raw|none`（Groq whisper-turbo，基线，凭据来自仓库外 `tc-verify/.env`）、`g25lite|raw|none`（出货默认模型、出货适配器）、`g25lite|trim|none`（出货裁剪 `trimVoiceAudio` 后再送，`pauseCues` 轴）、`g35lite|raw|none`（模型轴）、`g25lite|raw|punct` 与 `g25lite|raw|flat`（context 带标点 / 去标点，负对照）。
- 被测实现必须是出货模块：Gemini 条件经 `shared/asr/list/multimodal/multimodal.asr-provider.ts#transcribe` 发出，fetch 不包装、不改 body；裁剪经 `src/shared/voiceTrim.ts#trimVoiceAudio`。
- 读数轴：CER、句读数、标识符保真（`src/shared/identifierFidelity.ts`）、延迟、`usageMetadata` token 数；逐片段文本并列。
- 记录 `docs/experiments/2026-09-23-gemini.md`：报 `n`、run id、语料是 TTS 合成；报负对照是否按预测方向移动；**对 `pauseCues: 'useful'` 给出明确结论（支持 / 不支持 / 读数不足）**，并如实登记样本局限。
- 把 `PAUSE_CUES_EVIDENCE[multimodalId]` 改指向新记录；`scripts/asr-trim-capability-check.test.mjs` 的 fixture 拷贝清单随之加入新记录文件（否则其取假夹具在「证据文件不存在」处先红）。
- 在 `docs/experiments/README.md` 登记新记录。

**边界（不做）**：不改 `pauseCues`/`style` 等声明本身 —— 若读数不支持 `useful`，记录写明，并另立 gap 任务改声明；不接路由分派；不把质量数字做成判据。

**实现注记（落地时与 Proposal 的偏差，如实登记）：**

- **上下文条件的参照是 `punct` 而不是 `none`。** 负对照的预测必须在取数前写下且必须是单变量：本份里被测 provider 真的接受上下文（`honors.context: true`），`none` 与 `flat` 之间换的是两个变量（有没有上下文 + 上下文里有没有句末标点），只有 `punct` 与 `flat` 只差一个。`docs/experiments/README.md` 协议第 2 条原本把 whisper 那份记录的参照（`none`）写成了通则，已改为陈述单变量这一不变式，并登记两份记录各自的参照。实测：`flat` 4 vs `punct` 19，Δ=-15，8/8 片段下降。
- **`usageMetadata` token 轴读不到。** 契约里 `AsrSuccess.meta.usage` 存在，但两个出货适配器都没填（multimodal 的 `meta` 只带 `model`）。如实记 `n/a`，不拿别处的数字冒充；本记录因此不做成本侧结论。
- **`pauseCues` 轴的结论是「读数不足」，不是「支持」。** 裁剪是实打实的（削掉 21.5%–29.0% 样本，均值 25.0%），但句读 4 对 4、逐片段位移互相抵消、CER 反而略降 0.54 pp。判「读数不足」而不是「不支持」的理由是这套语料+口径对这句话**是盲的**：参考文本没有句末标点（协议第 5 条），而参考文本里唯一的边界是逗号，`sentenceMarks` 不数逗号；且 16 个格子里 14 个句读为 0（地板效应）。按边界条款，声明不改，另立 gap 任务。
- **最重要的产品读数：`hints.context` 会被回声进转写。** 8 条里 3 条（d04/d07/d08）的 `punct` 臂转写**整条就是 prompt 原文**，音频内容消失。这同时解释了上下文臂的标识符存活 5/6（相对三个 `none` 臂的 0/6）与 CER > 1 —— 两者同源于 prompt 文本被吐出，不是识别变好。适配器的能力声明不在本任务 Touches 内，只登记结论。

## AC

- [x] AC1 runner 报 `n` 并在空读数时红：`node experiments/voice-gemini-paired-quality/run.mjs --corpus=empty` 退出 1；默认离线重算退出 0 且打印 `n=8 × 6 condition(s) = 48 row(s)`（条件数以实际表为准，须 ≥ 6 且含上述六个 key）。
- [x] AC2 负对照能红：`--control=absent`、`--control=zero`、`--control=inverted` 三种各退出 1，且红在负对照那一位（打印的判词指名 `flat`）。
- [x] AC3 不跨运行：快照内所有读数来自同一 run id；`--runs=straddle` 退出 1 并报 `different runs`。
- [x] AC4 出货模块：`--probe` 打印 `shared/asr/list/multimodal/multimodal.asr-provider.ts#transcribe` 与 `src/shared/voiceTrim.ts#trimVoiceAudio` 的绝对路径，并断言 runner 内没有第二份 Gemini 请求构造（grep runner 源码无 `generateContent` / `inlineData` 字面量）；退出 0。
- [x] AC5 记录存在且作答：`docs/experiments/2026-09-23-gemini.md` 存在；含 `n=8`、run id、「TTS 合成」字样、负对照方向结论、以及一节以 `pauseCues` 为题且给出「支持 / 不支持 / 读数不足」三者之一的结论。`docs/experiments/README.md` 列出该文件。
- [x] AC6 证据重指：`grep -n "multimodalId]: 'docs/experiments/2026-09-23-gemini.md'" shared/asr/asrRegistry.ts` 命中；`node scripts/asr-pause-cues-source-check.mjs` 与 `node scripts/asr-trim-capability-check.mjs` 退出 0；`node --test scripts/asr-pause-cues-source-check.test.mjs scripts/asr-trim-capability-check.test.mjs` 退出 0。
- [x] AC7 不判据化：runner 末行自陈 `quality numbers are a reading and are NOT a criterion`；记录与 runner 不被任何 `scripts/*` 判据脚本引用（`grep -rl voice-gemini-paired-quality scripts/` 为空）。
- [x] AC8 凭据不入库：`git diff --name-only develop...HEAD` 不含 `.env*`；在载入 `.env.test` 的 shell 里 `git log -p develop..HEAD | grep -cF "$GEMINI_API_KEY"` 为 0（比对 key 的值本身，不比对前缀字面量 —— 本任务正文就含前缀字样，按前缀 grep 必然自红）；缓存目录 `experiments/voice-gemini-paired-quality/out/` 不入库。
- [x] AC9 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。

**逐条证据（每条判据的实跑结论）：**

| AC | 实跑 | 结果 |
|---|---|---|
| AC1 | `node …/run.mjs` | 退出 0，打印 `readings: n=8 × 6 condition(s) = 48 row(s), n = clips = 8`；条件表恰为六个声明的 key |
| AC1 | `node …/run.mjs --corpus=empty` | 退出 1，`[n] the paired set is empty — n=0 is not a green reading` |
| AC2 | `--control=absent` | 退出 1，`[control] g25lite\|raw\|flat 不在本次条件表里 —— 「marks 相对 g25lite\|raw\|punct down」这条预测没有被执行` |
| AC2 | `--control=zero` | 退出 1，`[control] g25lite\|raw\|flat marks=19 vs g25lite\|raw\|punct marks=19 (Δ=0, 0↑ 8= 0↓) —— 负对照没有移动` |
| AC2 | `--control=inverted` | 退出 1，`[control] … (Δ=8, 8↑ 0= 0↓) —— 朝预测的**反方向**移动` |
| AC3 | `--runs=straddle` | 退出 1，`[pairing] the readings come from 2 different runs …` |
| AC3 | 冻结快照 | `provenance.runIds = ["2026-09-23T10:27:39.515Z"]`（单一 run） |
| AC4 | `--probe` | 退出 0，打印两个出货模块的绝对路径与符号名；`grep -n "generateContent\|inlineData" run.mjs` 无命中（返回 1） |
| AC5 | 文件与 README | `n=8` ×3、run id ×2、「TTS 合成」×2、`## 六、pauseCues：…` 一节给出「读数不足」、README 索引与工装表各一行 |
| AC6 | grep / 两个 check / `node --test` | grep 命中 `shared/asr/asrRegistry.ts:336`；两个 check 各退出 0；`node --test` 17 项全过 |
| AC7 | 末行 + grep | 每次运行的末行都是那句自陈（含红路径与 `--probe` 路径）；`grep -rl voice-gemini-paired-quality scripts/` 无命中 |
| AC8 | diff / patch / 缓存 | `.env` 命中 0；载入 `.env.test` 后 `grep -cF "$GEMINI_API_KEY"` 为 0；`out/` 命中 0，`git ls-files` 只有 `fixtures/gemini.json` 与 `run.mjs` |
| AC9 | `npm run typecheck` / `npm run lint` | 各退出 0（lint 只剩仓库既有的 warning） |

## DoD

真实落地判据：不是「多了一份 md」，而是**出货 multimodal 适配器在同一运行里、与 whisper 基线同批语料上真的跑过真实 Gemini**，读数冻结可离线重算，且 `pauseCues: 'useful'` 这条非默认声明的证据指针终于指向一份实际测过该服务的记录（AC6）。承重性由三件读数证明：

(a) 空读数不是绿（AC1），负对照能红（AC2）；
(b) 被测的是出货模块而不是 runner 自造的请求（AC4）—— 否则测到的是 runner 的线协议；
(c) 记录对 `pauseCues` 给出三选一的明确结论（AC5），而不是只列数字。

**必须如实登记**：n=8、TTS 合成语料、单次运行，只界定效应方向，不界定真人语音上的幅度；质量回归不进 CI，依赖人工义务（ADR-004 决策 8）。

L_D 该轴仍暗，理由：本任务只产出实验记录与一处证据指针，不新增领域数据能力。
L_G 该轴仍暗，理由：目标层判据（换识别服务不改路由与 UI）需要 S4 路由分派，本任务不接路由。

## Touches

- experiments/voice-gemini-paired-quality/run.mjs (new)
- experiments/voice-gemini-paired-quality/fixtures/gemini.json (new)
- docs/experiments/2026-09-23-gemini.md (new)
- docs/experiments/README.md
- shared/asr/asrRegistry.ts
- scripts/asr-trim-capability-check.test.mjs
- scripts/asr-pause-cues-source-check.test.mjs
- tasks/gap-asr-gemini-paired-quality-record.md
