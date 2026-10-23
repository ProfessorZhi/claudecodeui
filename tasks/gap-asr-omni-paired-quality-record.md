---
id: gap-asr-omni-paired-quality-record
title: DashScope omni 的裁剪配对实验记录：同一运行内 omni × 裁剪臂 × whisper 基线 × 能红的负对照，并把
  PAUSE_CUES_EVIDENCE[dashscope-omni] 指过去（AC-135）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-proxy-provider-dispatch
  - gap-asr-dashscope-omni-wire-and-degradation
goal_ac: AC-135
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源；真正的 gating 是 frontmatter 的 `depends_on` 字段，不是本段提到的任何 id）：立案时 `grep -rn "^goal_ac:" tasks/*.md` 中 AC-135 命中且仅命中一条 —— `tasks/gap-asr-trim-capability-wiring.md`，status `done`（那是本条要在其上重建证据面的机制修，不是同一件事的重复）；`grep -rln "PAUSE_CUES_EVIDENCE" tasks/*.md` 只有 `tasks/gap-asr-gemini-paired-quality-record.md`（done，同一机制在 Gemini 上的既有处置）；`grep -rln "omni-written\|AC-137" tasks/*.md` 命中的是提示词冻结那条（done）。全仓在飞任务只有 AC-141 与 AC-142 两条，两者边界逐字写着「不改 `experiments/` 与 `docs/experiments/` 下任何文件」（AC-141）与「不做 dashscope-omni 适配器本体与线协议」（AC-142），与本条不重叠。

**现场（本轮实测，可复验）。** `node scripts/asr-trim-capability-check.mjs` 退出 **1**，七条检查里只有一条红：

```
check discipline: FAIL dashscope-omni=neutral declares a non-destructive capability with no paired experiment to point at
```

同一次输出里 `declared provider=dashscope-omni pauseCues=neutral evidence=(none)`（另两行分别指 `docs/experiments/2026-09-22-voice-provider-paired-quality.md` 与 `docs/experiments/2026-09-23-gemini.md`），其余六条全绿（declaration / read-point / single-source / decision / default / 空读数各自的判词）。`goals/AC-135-裁剪决策以能力声明为唯一来源-且默认行为不变.md` 的 `criterion` 就是这条命令，`.quay/gate-events.jsonl` 里它此前多次 sweep 均 `pass`（最后一次 2026-09-24T03:38:04Z）。

**为什么上一轮的修没保住。** AC-135 的**机制**那一半（`capabilities` 是裁剪决策的唯一来源、读取点唯一、默认行为不变）由 `gap-asr-trim-capability-wiring`（done）落地，今天仍然绿 —— 本轮输出里 `check single-source: ok 1 production file(s) reach trimDecisionFor …; no file answers 裁不裁 by hand` 与 `check default: ok a deployment that names no provider resolves to openai-compatible …` 就是它。没保住的是**纪律**那一半，而破坏它的不是那条任务：`gap-asr-proxy-provider-dispatch`（done，`goal_ac: AC-139`）把第三个适配器 `dashscope-omni` 登记进 `REGISTERED`，而这条检查的行集取自**注册表**（同一份输出打印「declares 3 row(s)」），于是 `neutral` 这一行**第一次**进入读数面；那一行没有证据指针，检查因此要求一份该服务自己的成对实验记录，而仓库里没有。该任务在自己的完成记录里逐字登记了这条红，写明「修它要么补一份**真实**的成对实验记录、要么改声明」，两者都在它的 Touches 之外（它明写不改 `shared/asr/list/dashscope-omni/*`，AC8 又禁止它改窄这些检查），所以它如实留红并把成因指给 AC-138 的声明侧。本条就是收这条红。

**为什么补记录、而不是把声明改成 `destructive`。**

- `src/shared/voiceTrim.ts` 的词汇表注释把三个值定死为**实测结论**：「Which value a recogniser gets is therefore not a preference to be tuned here; it is the conclusion of that recogniser's own paired experiment」。把未测的值按默认断言（`destructive`）与按 `neutral` 断言同样是没有测量的声明 —— 后者把「不知道」写成「中性」，前者把它写成「裁掉不亏」。两者都不该由「改一行」落地。
- 本仓库对同一形状的既有处置是「补一份真的测过该服务的记录，再把指针指过去」：`gap-asr-gemini-paired-quality-record`（done）为 `multimodal` 做了这件事，`docs/experiments/2026-09-23-gemini.md` 结尾并如实写下「指向一份真的测量，和那份测量支持这个值，是两件事」。本条沿用那份任务的形状，只换被测服务。
- proposal `docs/proposals/voice-dashscope-omni-written-instruction.md:155` 已把这件事写在案：`PAUSE_CUES_EVIDENCE['dashscope-omni']` 指向 T1 产出的实验记录，名字形状是 `docs/experiments/<date>-omni-written.md`。那份记录至今不存在（`ls docs/experiments/` 无此文件；AC-137 那条任务在自己的边界里明写「不写 `docs/experiments/` 下的人读记录」）。本条把它补上。
- 改声明为 `destructive` 会真的改掉这条服务的上传体（裁剪 → 重编码 WAV，进入 10 MB 整请求内联预算），而 GOAL-009 的能力表是为这条服务逐项写下的。用一个未测的默认假设覆盖它，等于借纪律的名义做一次没有测量的行为变更。

**本任务做什么。**

1. 新 runner `experiments/voice-dashscope-omni-paired-quality/run.mjs`：`--live` 落缓存（`out/*-cache.json`，不入库）→ `--freeze` 冻结到 `experiments/voice-dashscope-omni-paired-quality/fixtures/omni.json` → 默认离线重算；串行执行、报 `n`、run id 入快照。语料复用 `experiments/voice-provider-paired-quality/fixtures/d0*-o65.wav` 与 `paired.json` 的参考文本（不复制音频）。
2. **同一运行内**的条件（配对比较不跨运行），至少四臂：一个 whisper 基线（出货 `openai-compatible`）、`omni|raw`（出货 `dashscope-omni` 适配器，`qwen3.8-omni-flash`）、`omni|trim`（出货 `trimVoiceAudio` 之后再过同一个适配器，即 `pauseCues` 那一轴）、以及一个**单变量负对照**。注意本服务的 `honors` 三项全为 `false`，且适配器自身的提示词是被 AC-137 冻结的常量，所以兄弟记录用的 prompt 侧对照（`punct`/`flat`）在这条服务上**不可用**：对照必须换在真的会变的轴上（音频侧或模型侧），且预测方向必须在取数**之前**写进 runner 的判词。
3. 被测实现必须是出货模块（`docs/experiments/README.md` 协议第 3 条）：`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` 与 `src/shared/voiceTrim.ts#trimVoiceAudio`；`chat-audio` 线协议字面量不得在 runner 里出现第二份。语义判定复用 `experiments/voice-omni-written/raw/judge.mts` 的既有口径（✅/◐/❌），不在 runner 里写第二份 rubric。
4. 读数轴：语义判定（✅/◐/❌ —— 这条服务是 `style: 'written'`，逐字 CER 对书面化输出不适用）、标识符逐字保真（`src/shared/identifierFidelity.ts`，出货口径）、句读与逗号、延迟、`usage` token 数；逐片段文本并列。
5. 记录 `docs/experiments/<date>-omni-written.md`：报 `n`、run id、「TTS 合成」、负对照是否按预测方向移动、**对 `pauseCues` 给出三选一的明确结论**（支持 `neutral` / 不支持（指向哪个值）/ 读数不足），并如实登记样本局限；`docs/experiments/README.md` 的索引表与工装表各登记一行。
6. `shared/asr/asrRegistry.ts` 的 `PAUSE_CUES_EVIDENCE` 加 `dashscopeOmniId` 行指向该记录；`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 的模块注释按读数重写 —— 那句「trimming was never measured against this service」在本条之后不再为真。
7. 两条判据工装的 fixture 拷贝清单跟着加第三份证据（`scripts/asr-trim-capability-check.test.mjs` 的 `SHIPPING_FILES`，以及 `scripts/asr-pause-cues-source-check.test.mjs` 里对应的清单），否则取假夹具会先在「证据文件不存在」处红。

文件名：记录按实验运行当日取 `docs/experiments/<YYYY-MM-DD>-omni-written.md`（立案时预计 `2026-09-25`）；若实际运行日不同，按运行日命名并在完成记录里登记这一处与 Touches 的偏差。

**边界（不做）。** 不改窄任何一条既有检查（AC6 用 `git diff` 证明 `scripts/asr-trim-capability-check.mjs` 与 `scripts/asr-pause-cues-source-check.mjs` 一字未动）—— 这正是前一任务让渡时明写「不能做」的那件事；不改路由与 UI（AC-129/130/133/134）；不做 SSRF 白名单与用户凭据（AC-140/141）；不做浏览器端到端（AC-142）；不改 `multimodal` / `openai-compatible` 的声明与证据；不重新联网取 `e-ctx*` 那批读数（那条线属 AC-137）；不写第二份 trim 实现或第二份 rubric。记录的文字质量不进判据（ADR-004 决策 8）。

**已知不等价点与限制。** n=8、TTS 合成语料、单次运行，只界定效应方向、不界定真人语音上的幅度（与两份兄弟记录同形）；质量回归不进 CI，靠人工义务（ADR-004 决策 8）；`qwen3.8-omni-flash` 是别名，服务端升级后可能漂移；本条不改 proposal `docs/proposals/voice-dashscope-omni-written-instruction.md` 的能力表那一行（它是方案记录）—— 若读数为「读数不足」，该行仍然成立；若读数指向别的值，本条改的是出货声明与模块注释，proposal 那一行的同步如实登记为遗留。

## AC

- [x] AC1 runner 报 `n` 且空读数不是绿：`node experiments/voice-dashscope-omni-paired-quality/run.mjs` 默认离线重算退出 0，并打印 `n=8 × <k> condition(s) = <N> row(s)`（k ≥ 4，且条件表含一个 whisper 基线、`omni|raw`、`omni|trim` 与负对照臂）；`--corpus=empty` 退出 1，判词指名空读数而不是静默绿。
- [x] AC2 负对照能红：`--control=absent`、`--control=zero`、`--control=inverted` 三种各退出 1，且红在负对照那一位（判词指名该对照条件名与预测方向）；记录里写明对照条件对是哪一个、相对哪个参照、以及**取数之前**写下的预测方向。
- [x] AC3 不跨运行：冻结快照里所有读数来自同一个 run id；`--runs=straddle` 退出 1 并报 `different runs`。
- [x] AC4 出货模块：`--probe` 打印 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` 与 `src/shared/voiceTrim.ts#trimVoiceAudio` 的绝对路径并断言 runner 内没有第二份请求构造（`grep -nE "input_audio|compatible-mode/v1/chat/completions" experiments/voice-dashscope-omni-paired-quality/run.mjs` 无命中）；退出 0；语义判定走 `experiments/voice-omni-written/raw/judge.mts`，runner 里 `grep -c "✅\|◐"` 不出现第二份 rubric 阈值。
- [x] AC5 记录存在且作答：`ls docs/experiments/ | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}-omni-written\.md$'` 为 1；该文件含 `n=8`、run id、「TTS 合成」字样、负对照方向结论、逐片段并列文本，以及一节以 `pauseCues` 为题且给出「支持 `neutral` / 不支持（指向某值）/ 读数不足」三者之一的结论；`docs/experiments/README.md` 的索引表列出该文件。
- [x] AC6 证据指针与判据转绿，且检查未被改窄：`grep -n "dashscopeOmniId]" shared/asr/asrRegistry.ts` 命中且指向 AC5 的那份记录；`node scripts/asr-trim-capability-check.mjs` 退出 0，输出行 `declared provider=dashscope-omni pauseCues=<值> evidence=<记录路径>` 不再为 `(none)`；`node scripts/asr-pause-cues-source-check.mjs` 退出 0；`git diff --name-only <base>...HEAD` 不含 `scripts/asr-trim-capability-check.mjs` 与 `scripts/asr-pause-cues-source-check.mjs`。
- [x] AC7 取假夹具跟得上：`scripts/asr-trim-capability-check.test.mjs` 的 `SHIPPING_FILES` 加入 AC5 的记录文件（第三份证据），`scripts/asr-pause-cues-source-check.test.mjs` 里对应的清单同样更新；`node --test scripts/asr-trim-capability-check.test.mjs scripts/asr-pause-cues-source-check.test.mjs` 退出 0；且有一条变异用例（把第三份记录从夹具里删掉）红在 `discipline` 那一条上，而不是红在别处。
- [x] AC8 声明与记录一致：AC5 记录给出的 `pauseCues` 结论与 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 的 `capabilities.pauseCues` 逐字一致 —— 结论是「读数不足」则声明不动、注释如实写「读数不足，按 proposal §2 的理由保持 `neutral`」，结论指向别的值就在本条改声明（不留给后续任务：ADR-004 决策 1 的纪律就是声明跟着该服务自己的实测走）；两种情形都必须把模块注释里「trimming was never measured against this service」那一段按读数重写，并点名 AC5 的记录路径。
- [x] AC9 不判据化：runner 末行自陈 `quality numbers are a reading and are NOT a criterion`；`grep -rl voice-dashscope-omni-paired-quality scripts/` 为空。
- [x] AC10 凭据不入库：`git diff --name-only <base>...HEAD` 不含 `.env*`；载入 `.env.test` 的 shell 里 `git log -p <base>..HEAD | grep -cF "$DASHSCOPE_API_KEY"` 为 0（比对 key 的值本身，不比对前缀字面量）；缓存目录 `experiments/voice-dashscope-omni-paired-quality/out/` 不入库。
- [x] AC11 静态门：`npm run typecheck` 与 `npm run lint` 退出 0（lint 只允许仓库既有 warning）。
- [x] AC12 如实登记：完成记录写明「本条只补 AC-135 纪律那一半的证据面；`capabilities` 唯一来源与默认行为不变那一半由 `gap-asr-trim-capability-wiring` 落地且本轮仍绿；这条红是 `gap-asr-proxy-provider-dispatch` 把第三个适配器登记进 `REGISTERED` 的后果，该任务已如实登记并让渡；本条不改路由、不做前端、不动 SSRF 与用户凭据（AC-140/141/142 的范围）；质量读数按 ADR-004 决策 8 不进 CI、依赖人工义务；n=8、TTS 合成语料、单次运行只界定效应方向」。

## DoD

真实落地判据：不是「多了一份 md、多了一行指针」，而是**出货 dashscope-omni 适配器与出货裁剪模块在同一运行、同一批语料上真的跑过真实 DashScope**，读数冻结可离线重算，且 `pauseCues: 'neutral'` 这条非默认声明的证据指针终于指向一份**实际测过这条服务裁剪轴**的记录 —— 判据 `node scripts/asr-trim-capability-check.mjs` 从退出 1 变成退出 0，而那六条本来就绿的检查一条都没有变窄。承重性由四件读数证明：

(a) 空读数不是绿（AC1）、负对照能红（AC2）、不跨运行（AC3）；
(b) 被测的是出货模块而不是 runner 自造的请求（AC4）—— 否则测到的是 runner 的线协议，而这条服务的线协议恰好是第三种形状（`chat-audio`），最容易在工装里被重写一遍；
(c) 记录对 `pauseCues` 给出三选一的明确结论（AC5），且声明与该结论一致（AC8），不是只列数字；
(d) 证据指针与检查一起绿，并且检查本身一字未动（AC6 的 `git diff`）。

**为什么这不是「再修一次同一个东西」。** 上一轮 AC-135 的机制修仍然有效（`single-source` 与 `default` 两条本轮依然绿）；本条补的是它的**证据面**，而破坏证据面的是后一次注册（第三个适配器进入读数行集）。修复面与破坏面分属两个任务，本条只碰证据面与判据工装的夹具清单，一行检查逻辑都不动。

**必须如实登记**：n=8、TTS 合成语料、单次运行只界定效应方向；质量读数不进 CI（ADR-004 决策 8，真实冒烟归人工）；真实 DashScope 的延迟、配额与别名漂移不在读数里。

L_D 该轴仍暗，理由：本条交付的是一份实验记录、一行证据指针与一处注释，判据读数是退出码、文件是否存在与三个取假变体，没有可比的数值量；裁剪轴的数值读数（标识符保真、语义判定计数、延迟、token）记在实验记录里、不进判据。

## Touches

- experiments/voice-dashscope-omni-paired-quality/run.mjs (new)
- experiments/voice-dashscope-omni-paired-quality/fixtures/omni.json (new)
- docs/experiments/2026-09-24-omni-written.md (new)
- docs/experiments/README.md
- shared/asr/asrRegistry.ts
- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- scripts/asr-trim-capability-check.test.mjs
- scripts/asr-pause-cues-source-check.test.mjs
- tasks/gap-asr-omni-paired-quality-record.md

## 完成记录

**结论：读数支持 `pauseCues` 保持 `'neutral'`，声明一个字未改；证据指针指向本条的记录。**

- **交付**：新 runner `experiments/voice-dashscope-omni-paired-quality/run.mjs`（4 臂：whisper 基线 / `omni|raw` / `omni|trim` / `omni|head` 负对照，同一运行、同一批 8 条 **TTS 合成**片段）、冻结快照 `fixtures/omni.json`、记录 `docs/experiments/2026-09-24-omni-written.md`、`PAUSE_CUES_EVIDENCE[dashscopeOmniId]` 一行、适配器 `pauseCues` 注释按读数重写、两条判据工装的自检夹具清单各加第三份证据。
- **读数（run=2026-09-24T08:01:20.915Z，n=8，单次运行）**：负对照 `omni|head|none` 的满分 `0` vs 参照 `omni|raw|none` 的 `7`（Δ=-7），**按取数前写下的方向（down）移动**；裁剪臂 `omni|trim|none` 满分 `6/8`，相对参照**没有一条片段变好**、d02 掉了一条满分；标识符两臂都是 `3/6`（d01 被裁剪修好、d02 被裁剪弄坏，净额为零）；`tokens` 因出货适配器的 `meta` 不带 `usage` 而记 n/a。
- **文件名偏差（Proposal 要求登记）**：Touches 立案时按预计运行日写作 `docs/experiments/2026-09-25-omni-written.md`；实际取数运行发生在 **2026-09-24**，记录按运行日命名为 `docs/experiments/2026-09-24-omni-written.md`，上面的 Touches 行已改为实际路径。
- **AC12 的边界如实登记**：本条只补 AC-135 **纪律那一半**的证据面 —— `capabilities` 唯一来源、读取点唯一、默认行为不变那一半由 `gap-asr-trim-capability-wiring`（done）落地，本轮探针输出里 `check single-source` 与 `check default` 两条仍然绿；这条红是 `gap-asr-proxy-provider-dispatch` 把第三个适配器登记进 `REGISTERED` 之后**第一次**进入读数面的后果，该任务已在完成记录里如实登记并让渡。本条不改路由、不做前端、不动 SSRF 与用户凭据（AC-140/141/142 的范围），不改 `multimodal` / `openai-compatible` 的声明与证据，没有重取 `e-ctx*` 读数，没有写第二份 trim 实现或第二份 rubric，检查脚本本体一字未动。
- **质量读数按 ADR-004 决策 8 不进 CI**，依赖人工义务；n=8、TTS 合成语料、单次运行只界定效应方向，不界定真人语音上的幅度。
- **scoped gate 的实情**：`bash scripts/test.sh --for-task gap-asr-omni-paired-quality-record --allow-thin` 退出 0，但输出是 `no scoped test files … (thin)` —— 该脚本按 `.test.[jt]sx?$` 收 Touches 里的测试文件，两条 `.test.mjs` 不在其内（仓库既有性质，不是本条引入）。所以那一步是空转；两条测试文件另行直接跑过：`node --test scripts/asr-trim-capability-check.test.mjs scripts/asr-pause-cues-source-check.test.mjs` = 18/18 通过、退出 0，fan-in 的全量套件会真正覆盖它们。
