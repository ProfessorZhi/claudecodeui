---
id: gap-voice-pause-split-selfcorrect-eval
title: 停顿切开对自我更正的影响：在更正处注入 2/5/10 秒停顿，比较整段识别与切开识别，选定 flushSilenceSec（预算上限 ¥1）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-silence-flush-and-inflight-dot
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md`、人（yale）对 `flushSilenceSec` 默认 5 秒的临时认可。沿用 `experiments/voice-dashscope-omni-paired-quality` 的做法（预注册先于取数、冻结快照、取假形态证明量具敏感），不与它重复：那条比的是 provider/裁剪，本条比的是**切开位置对自我更正的影响**。

### 要回答的问题

`dashscope-omni` 的输出是书面化文本，会解决自我更正：「改一下 A，嗯不对，应该是 B」只输出 B 的指令。若更正前后的停顿超过 `flushSilenceSec`，语音被切成两个请求：

```
段 1：改一下 voice.service.ts            → 「改一下 voice.service.ts」
（停 P 秒）
段 2：嗯不对，应该是 voice.routes.ts      → 「应该是 voice.routes.ts」
```

两段各自完整，但跨段的更正没有被解决，且 `honors.context` 为 false，没法把上一段内容带给下一段。**这个代价在合成数据上从未测过。** 本实验用极低成本量出 P 取 2 / 5 / 10 秒时的差距，选定 `flushSilenceSec`。

### 成本（实际单价：输入 0.8、输出 2.7 元/百万 token）

单次调用约 ¥0.001–0.006（reasoning 低到高）。设计 4 脚本 × 3 种停顿 × 2 种做法 × 5 次重复 = **120 次调用，预计 ¥0.1–0.7**。预算闸 `budgetCny = 1.0`（本实验的硬上限，整体预算 ¥2 内），超过即停。

### 方案

1. 先写 `experiments/voice-vad/PREREG-pause-split.md` 并**提交**，再取数：登记指标、判定规则、容差、负对照。
2. 语料：用 `tc-verify/tools/tts.mjs`（edge-tts，不产生费用）重新合成 4 条「自我更正」脚本（`d02`、`d08`、`e02`、`e08`），**在更正处断成两个音频块**，中间注入 P ∈ {2, 5, 10} 秒静音。块边界与注入位置由构造给出，是精确真值。
3. 两种做法，配对（同一份音频）：
   - **整段**：整条音频（含 P 秒静音）作为**一个**请求；
   - **切开**：在该静音处切成两个请求，分别识别后按序拼接。
4. 主指标 `resolved`（二值）：输出**包含更正后的目标**（如 `voice.routes.ts`），且**不把更正前的目标当作指令对象**。次要：标识符存活率（沿用既有口径）。每格 n=20（4 脚本 × 5 重复），写明 Wilson 95% 置信区间。
5. **负对照**：把整段音频里的更正前后顺序对调（先说更正后的、再说更正前的），`resolved` 必须由高变低，证明量具能看见「没解决」。
6. 预算闸沿用 `experiments/voice-vad/pricing.json` 与既有的 `--dry-run` / 累计闸逻辑（缺单价、占位单价、预估超预算都以非 0 退出并指名原因；累计超预算后不再发起新调用，已有读数落盘）。
7. 结论与回写：以「切开的 `resolved` 率不低于整段的 `resolved` 率减去 PREREG 登记的容差」为准，取满足条件的**最小** P 作为推荐 `flushSilenceSec`，写进结果记录；若与 `voiceLiveSegmenter.ts` 里的默认值不同，**回写该常量**。n 很小，结论首句必须标「仅方向」。

### 边界（不做）

不改切段规则本身；不做跨段上下文传递（provider 不支持）；不评估其他类型的脚本（标识符、数字等）；不把音频原文放进仓库（只放聚合数字，原文留仓库外）。

## AC

- [x] `test -f experiments/voice-vad/PREREG-pause-split.md` 成立，且其首次提交时间早于 `experiments/voice-vad/fixtures/pause-split.json` 的首次提交时间（`git log --diff-filter=A --format=%ct -- <文件>` 比较两个时间戳）
- [x] `node experiments/voice-vad/pause-split.mjs --offline` 从冻结快照重算全部读数，退出码 0，不联网、不用凭据
- [x] 快照网格 4 × 3 × 2 全部有格，每格 n = 20（4 脚本 × 5 重复），缺格数为 0；每格的 `resolved` 率与 Wilson 95% 置信区间写在快照里
- [x] 负对照：`node experiments/voice-vad/pause-split.mjs --offline --variant=swap-order` 的 `resolved` 率相对真实读数下降，方向与 PREREG 一致，退出码 0，输出含「负对照红」字样
- [x] 预算闸（不联网即可验证）：`node experiments/voice-vad/pause-split.mjs --dry-run` 在 ①缺 `pricing.json` ②单价为占位值 ③预估花费超过 `budgetCny` 三种情形下均以非 0 退出并指名原因；合法单价下打印「预估最坏花费」且退出码 0
- [x] 预算闸（累计）：用假 provider 让每次调用返回超大 usage，累计估算超过 `budgetCny` 的那一次之后不再发起任何新调用（假 provider 记录调用数，断言），已有读数仍写入快照
- [x] 快照记录累计 token 与按 `pricing.json` 折算的实际花费，且实际花费 ≤ `budgetCny`（1.0）
- [x] `docs/experiments/2026-10-04-voice-pause-split.md` 首句含「仅方向」，给出推荐 `flushSilenceSec` 与依据格，并且 `src/modules/chat/utils/voiceLiveSegmenter.ts` 里的 `DEFAULT_FLUSH_SILENCE_SEC` 与之一致（`grep` 两处数值相同）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：读数来自**真实的 `dashscope-omni` 调用**（不是 fixture 识别器），并写明实际花费与预算；每个结论写明依据的格与置信区间，保留未解释项（例如 reasoning token 的波动，和两条「合成音脚本」在不同停顿下方向相反这类现象），不为让表格好看而填数。取假形态：对调顺序时 `resolved` 必须变红，否则量具不敏感、整份记录作废重做。凭据缺失必须**指名**缺哪个变量并失败，不得降级为全假 provider 后报绿。

L_D 该轴仍暗，理由：本任务产出的是实验记录，不新增领域数据能力。

L_G 该轴有读数：切开 vs 整段识别在自我更正上的 `resolved` 率，由快照给出。

## Touches

- experiments/voice-vad/PREREG-pause-split.md (new)
- experiments/voice-vad/pause-split.mjs (new)
- experiments/voice-vad/fixtures/pause-split.json (new)
- docs/experiments/2026-10-04-voice-pause-split.md (new)
- docs/experiments/README.md
- src/modules/chat/utils/voiceLiveSegmenter.ts
- tasks/gap-voice-pause-split-selfcorrect-eval.md

## Evidence

真实 `dashscope-omni` 调用 **240 次**（`whole` 60 + `split` 120 + `swapWhole` 60），`missingCells = 0`；
累计 191,792 token，**实际花费 ¥0.309323** ≤ `budgetCny` ¥1.0（最坏预估 ¥0.6636 也未越线）。
冻结快照 `experiments/voice-vad/fixtures/pause-split.json`：每次调用的转写/usage/花费 + `cells`
（每脚本 n=5，24 子格）+ `byPause`（每格 做法×停顿 n=20）+ `pooled`（n=60）+ `budgetGate`。

- `whole` pooled **60/60 = 1.000** [0.9398, 1.0000]；`split` pooled **0/60 = 0.000** [0.0000, 0.0602]；
  2/5/10 秒三档 GAP 均为 1.000，**无一落在容差 0.15 内** ⇒ 登记回退取最大 P ⇒ 推荐
  **`flushSilenceSec = 10`**，已回写 `DEFAULT_FLUSH_SILENCE_SEC`（5 → 10）。
- 负对照 `swap-order`：whole 1.000 → swap 0.217（Δ=0.783；≤0.25 天花板、whole≥0.5），判红，退出码 0。
- `--offline` 退出 0；`--dry-run` 三情形非 0 并指名，合法单价打印「预估最坏花费」退出 0；
  `--provider=fake-huge` 越线后停发（callCount=1），真实 240 条读数不受影响。
- 结果记录 `docs/experiments/2026-10-04-voice-pause-split.md`（首句「仅方向」，含推荐值与依据格、CI、未解释项）。

Commits：`d1b48597`（取数与选参）、`5aa4753a`（`byPause` 落盘 + `--write`）。
