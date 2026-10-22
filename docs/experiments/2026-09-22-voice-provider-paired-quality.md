# 配对质量实验：provider × 裁剪 × 上下文（一份读数，不是闸）

状态：已测 / 配对读数与负对照方向成立；**prompt 臂跨运行不可复现**（见「四」「五」）
日期：2026-09-22
工装：`experiments/voice-provider-paired-quality/run.mjs`（**在仓库内**，见「六、复现」的理由）
相关：`adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md`（决策 6 / 决策 8，后续任务 10）、`docs/experiments/README.md`（协议 1–8）、`docs/experiments/2026-09-22-voice-punctuation.md`（本轮的对照基线）

---

## 一、起因

ADR-004 决策 8 把「进 AC 的判据」与「只进实验记录的读数」分开，并把质量回归的代价写成一条**人工义务**：质量结论不进 CI，所以质量回归**不会**被自动发现 —— 只能靠「每接入一个服务就写一份实验记录」。决策 6 还要求每接入一个服务就重跑一次该服务的配对实验。

本记录是这条义务的第一次履行，也是「后续任务 10」的立案。它要回答一个形状问题：**在同一批语料上做跨条件配对比较，读数长什么样；以及那个负对照到底能不能红。** 它不回答「哪个 provider 更好」——一次运行、8 条片段不足以支撑那个问题。

三个必须同时成立的条件（`docs/experiments/README.md` 协议 2、3、7）：

1. **配对，不跨运行** —— 所有条件在同一批片段上跑；一条读数缺席就缩小配对集合，而不是换一个集合去比。
2. **负对照能红** —— `flat` 形态（同一个 prompt，只去掉句末标点）。它必须**相对 `none` 下降**，否则「prompt 的标点被镜像」这个解释不成立。
3. **被测实现是出货模块** —— 工装里不得放第二份算法。

## 二、方法

**语料（n=8）**：`experiments/voice-provider-paired-quality/fixtures/` 下 8 条中文片段 `d01-o65.wav` … `d08-o65.wav`，取自仓库外语料 `corpus/dictation` 的 **o65 占比档**（TTS 合成，`tools/dictation-corpus.mjs` 的 SCRIPTS）。参考文本是生成时喂给 TTS 的**脚本原文**，所以是构造上的真值。为什么是这一档：它是已发布标点实验里中文那半用的同一档，**同档才能与已发布数字并列**。

**条件（5 个，同一批片段上全跑）**：

| 条件键 | provider | 音频 | 上下文（prompt） |
|---|---|---|---|
| `turbo\|raw\|none` | `whisper-large-v3-turbo` | 原始 | 无（**参照条件**） |
| `turbo\|raw\|punct` | `whisper-large-v3-turbo` | 原始 | 带句末标点 |
| `turbo\|raw\|flat` | `whisper-large-v3-turbo` | 原始 | **同一个 prompt，只去掉句末标点**（**负对照**） |
| `turbo\|trim\|none` | `whisper-large-v3-turbo` | 裁剪（出货停顿表） | 无 |
| `v3\|raw\|none` | `whisper-large-v3` | 原始 | 无 |

三根轴各换一个变量：provider（`turbo` → `v3`）、裁剪（`raw` → `trim`）、上下文（`none` → `punct` → `flat`）。`trim` 那一列的音**由出货模块现算**，不是预先烘好的文件。

**口径**：

- `句读/片段` —— 先把**标识符内部的点**蒙掉（`maskInternalDots` = `.replace(/\.(?=[\p{L}\p{N}])/gu, '')`），再数 `[.!?。！？]`。已发布实验的那版正则带 `\S*` 前缀，在中文上把整句删空（该实验「五、4」自陈），本轮用的是修正后的版本。
- `naive` —— 不蒙点的同一计数，作为口径分歧的可见读数（README「已知的口径分歧」的同款手法）。
- `标识符存活` —— **出货**模块 `src/shared/identifierFidelity.ts`（逐字敏感口径），工装直接 `import`，没有第二份实现。
- `CER` —— 与参考文本的字符错误率。
- 参考文本**不带句末标点**，所以不计算标点准确率（协议 5）；标点**位置**是否合理靠人读配对文本（runner 把每个片段的 5 个条件原文逐条打到 stdout）。

**检查器与自检**：runner 把「能红」做成机检 —— 七条变异（负对照缺席/置零/反向/抽空、某个条件塌成空、语料为空、一条读数跨运行），每条都必须**非零退出**，且必须红在**预期的那一位**上（红错地方也算失败）。同时真实快照必须绿：缺了正面那一半，一个「永远返回红」的 checker 也能通过全部变异。

**对应关系机检**：冻结快照里每条片段的音频哈希必须是**本模块现算**出来的（`sha256` 逐列重算 + `savedRatio` 逐条重算），并带一个**篡改过的哈希作金丝雀** —— 金丝雀不红，就说明这条检查是瞎的，快照的绿读数一文不值。

**真实服务**：Groq 的 OpenAI 兼容端点 `/audio/transcriptions`（`response_format=json`，**不带 `language` 参数**，与已发布实验一致，因为产品侧是混合语种）。凭据从仓库外 `.env`（mode 600）读，永不打印。**串行**执行，最小间隔 3200 ms（协议 7）。按决策 8，这个读数**不进判据集**。

**缓存**：`experiments/voice-provider-paired-quality/out/quality-cache.json`（`out/` 已被 `.gitignore` 忽略，不入库），按 `条件键|片段` 存 `{text, run, takenAt}`。冻结快照 `fixtures/paired.json` 入库 —— 它**不是缓存**，是这次读数的原文，记录里每个数字都从它离线重算。

## 三、结果

单次运行，run id `2026-09-22T15:35:41.828Z`，**n = 8 片段 × 5 条件 = 40 条读数**，配对集合 = 8（每个条件在每条片段上都返回了文本）。

### 3.1 配对表

| 条件 | 句读/片段 | 均值 | naive | 标识符存活 | CER | 相对 `none` |
|---|---|---|---|---|---|---|
| `turbo\|raw\|none` | **10** | 1.25 | 17 | 0/6 | 0.1324 | — |
| `turbo\|raw\|punct` | **22** | 2.75 | 37 | 1/6 | **0.0761** | **+12**（6↑ 1= 1↓） |
| `turbo\|raw\|flat`（负对照） | **8** | 1.00 | 21 | 2/6 | 0.1360 | **−2**（2↑ 4= 2↓） |
| `turbo\|trim\|none` | **0** | 0.00 | 5 | 0/6 | 0.1519 | **−10**（0↑ 5= 3↓） |
| `v3\|raw\|none` | **5** | 0.63 | 11 | 0/6 | 0.1656 | **−5**（2↑ 3= 3↓） |

`punct − flat = 22 − 8 = 14` —— 隔离出「prompt 里那几个句末标点」这一个变量的对比。

### 3.2 负对照：它按预测方向移动了吗

```
negative control (the `flat` shape — the report must say whether it moved, not that it ran):
  ok   turbo|raw|flat marks=8 vs turbo|raw|none marks=10 (Δ=-2, 2↑ 4= 2↓) —— 按预测方向（down）移动
  predicted: marks down vs turbo|raw|none
```

逐片段句读（`none` → `flat`）：

| 片段 | d01 | d02 | d03 | d04 | d05 | d06 | d07 | d08 |
|---|---|---|---|---|---|---|---|---|
| `none` | 0 | 3 | 4 | 0 | 3 | 0 | 0 | 0 |
| `flat` | 0 | **0** | **0** | 0 | 3 | 0 | **4** | **1** |

**方向成立但幅度小、且有反向的片段**：d02（−3）、d03（−4）按预测下降，d07（+4）、d08（+1）反而上升，4 条不动。8 条片段上净 −2。

这不是「跑了负对照」，是「负对照动了」——而且是**双向**的：去掉 prompt 的标点可以让句读变少，也可以让它变多。一个只会单调增加句读的机制（例如「随便给个 prompt 都让模型更啰嗦」）解释不了 d02/d03 的下降。

**口径修正不改变这条结论**：`flat` 的 8 个句读里有 **4 个是「标识符残点」**（见「五、2」），扣掉后 `flat` 净 4 对 `none` 净 10，Δ 从 −2 变成 **−6** —— 负对照不但没被残点撑着，修正后**更负**。

### 3.3 自检：这些变异真的能红吗

| 变异 | 退出码 | 首条失败原因 |
|---|---|---|
| `--corpus=empty` | **1** | `[n] the paired set is empty — n=0 is not a green reading (snapshot 0 clip(s), 5 condition(s))` |
| `--control=absent` | **1** | `[control] 条件表里没有声明负对照` |
| `--control=zero` | **1** | `[control] turbo\|raw\|flat marks=10 vs turbo\|raw\|none marks=10 (Δ=0, 0↑ 8= 0↓) —— 负对照没有移动` |
| `--control=inverted` | **1** | `[control] … marks=18 vs … marks=10 (Δ=8, 8↑ 0= 0↓) —— 朝预测的**反方向**移动` |
| `--control=empty` | **1** | `[n] the paired set is empty — n=0 is not a green reading (snapshot 8 clip(s), 5 condition(s))` |
| `--drop=turbo\|raw\|none` | **1** | `[n] the paired set is empty — n=0 is not a green reading (snapshot 8 clip(s), 5 condition(s))` |
| `--runs=straddle` | **1** | `[pairing] the readings come from 2 different runs (2026-09-22T15:35:41.828Z (39 reading(s)); 1970-01-01T00:00:00.000Z (1 reading(s))) — a paired comparison must not straddle runs.` |

真实快照下 runner 的自检汇总（离线，一条请求也不发）：

```
real=moved(-2)  control=absent=absent  control=zero=flat  control=inverted=against
control=empty=empty  drop=turbo|raw|none=empty  corpus=empty=n0/0readings  runs=straddle=red
```

`corpus=empty` 那一条是 AC1 的机检形态（n=0 必须红）；`control=*` 四条是 AC2 的（负对照不是「写了就算」）；`runs=straddle` 是 AC4 的（「不跨运行」同样不是一句写在记录里的话）。

### 3.4 对应关系：这些文本真的来自出货模块的输出吗

```
correspondence (the frozen transcript must be this shipping module's audio, byte for byte):
  canary=RED corrupted hash detected
  snapshot=GREEN checked 16 encoded column(s)
```

16 列 = 8 片段 × 2 个音频列（`raw` / `trimFrozen`）。金丝雀（篡改过的哈希）**红**、快照**绿** —— 两条一起才说明这条检查既不瞎也不空。出错的原文（若有）会逐条打在 stdout 上；本轮 0 条。

**成本侧读数**（同一批音频，出货模块现算）：裁剪平均省 **24.98%** 时长（逐片段 21.5%–29.0%）。这与已发布标点实验里中文 `frozen` 的 **25.5%** 一致，可作解码路径的交叉校验 —— 但它**不是**独立测量，两处走的是同一个模块。

### 3.5 配对文本（人读的那一半）

协议 5 说标点位置只能人读，所以这里贴三段最能说明问题的（完整 8 段 × 5 条件在 runner 的 stdout 上）：

```
[d04-o65.wav] reference: 不要动 voice.service.ts，只改 voice.module.ts
    turbo|raw|none     不要动voice.seLuis TS直改voicemodule TS
    turbo|raw|punct    不要动。 voice.se.luis.ts。直改 voice。module.ts。
    turbo|raw|flat     不要动 voice.seLuis.ts 只改 voice.module.ts
    turbo|trim|none    不要动voice.seLouis TS直改voicemodule TS
    v3|raw|none        不要动voice.seLuiz TS只改voicemodule TS

[d07-o65.wav] reference: server 模块下的 voice 目录里加一个 call 的测试
    turbo|raw|none     Server模块下的Voice目录里加一个Code测试
    turbo|raw|punct    Server. 模块下的 voice. 目录里加一个.call 的测试。
    turbo|raw|flat     Server. 模块下的 voice. 目录里加一个. 靠的测试。
    turbo|trim|none    Server模块下的Voice目录里加一个Code测试
    v3|raw|none        Server模块下的Voice目录里加一个Call的测试

[d08-o65.wav] reference: 把默认模型换成 whisper large，啊不，是 whisper turbo
    turbo|raw|none     把默认模型换成WhisperLargeAbu是WhisperTurbo
    turbo|raw|punct    把默认模型换成 whisper.large.abu. 是 whisper.turbo.
    turbo|raw|flat     把默认模型换成 whisper.large.abu.是 whisper.turbo.
    turbo|trim|none    把默认模型换成WhisperLargeAbu是WhisperTurbo
    v3|raw|none        把默认模型换成WhisperLargeAbu是WhisperTurbo
```

人读能得到而口径读不到的三件事：

1. **`flat` 的句读有一部分不是句读**：d07 的 `Server. 模块`、`voice. 目录`、`一个. 靠` 和 d08 的 `large.abu.` 都是**标识符的点的残骸**（点后跟了空格，蒙版正则看不见），不是断句。这就是 3.2 里那 4 个残点的来源 —— 也是 `flat` 2/6 标识符存活里的 1 个（d04 的 `voice.module.ts` 是**真的逐字对了**）。
2. **`punct` 臂的标识符存活（1/6）与 `flat` 臂（2/6）都比 `none` 臂（0/6）高**，而 `none` 臂在 d04 上把 `voice.module.ts` 读成了 `voicemodule TS`。也就是说 prompt 臂**不是**一律更差。
3. **裁剪那一列把中文句读清零，但在英文语料上不成立**（已发布实验的结论），且它**不动标识符**（d07 的两列逐字相同）。

### 3.6 与已发布读数的对撞：同一批 8 条片段上的两次运行

已发布标点实验的中文臂也是 o65 档、也用同一套口径，本轮的 8 条是它的**前 8 条**。把它的缓存原文按同样口径重算，逐片段对:

| 片段 | `none` 本轮 | 已发布 `raw` | 原文逐字相同 | `punct` 本轮 | 已发布 `rawPunct` | `flat` 本轮 | 已发布 `rawFlat` |
|---|---|---|---|---|---|---|---|
| d01 | 0 | 0 | **✓** | 1 | 0 | 0 | 0 |
| d02 | 3 | 3 | **✓** | 5 | 0 | 0 | 0 |
| d03 | 4 | 4 | **✓** | 1 | 0 | 0 | 0 |
| d04 | 0 | 0 | **✓** | 4 | 0 | 0 | 0 |
| d05 | 3 | 3 | **✓** | 3 | 0 | 3 | 0 |
| d06 | 0 | 0 | **✓** | 3 | 0 | 0 | 0 |
| d07 | 0 | 0 | **✓** | 3 | 0 | 4 | 0 |
| d08 | 0 | 0 | **✓** | 2 | 0 | 1 | 0 |
| **Σ** | **10** | **10** | **8/8** | **22** | **0** | **8** | **0** |

（`trim` 那一臂也逐字相同：`turbo|trim|none` 与已发布的 `trimFrozen` 8/8 一致 —— 一并验证过，未列进表。）

**同一个模型名、同一个端点、同一批音频，只差 `prompt` 参数**：无 prompt 的两臂**逐字复现**（连 `voicemodule TS` 这种错法都一样），prompt 两臂从 `0 / 0` 变成 `22 / 8`。CER 方向也跟着反了。这是「四、3」那条结论的原始读数。

## 四、结论

1. **配对比较成立且可离线复算。** n=8、40 条读数、单次运行（run id 打在 stdout 上并入库）、配对不跨运行；`--runs=straddle` 证明这条协议是机检的而不是文档里的。整张表、负对照方向、七条变异都能在**不联网**的情况下从 `fixtures/paired.json` 重算出来。
2. **负对照按预测方向移动，且是双向的。** `flat` 相对 `none` 净 −2（修正口径后 −6），其中 2 个片段下降、2 个上升、4 个不动。「prompt 的标点被镜像」这个解释成立，但它**不是一个单向增益** —— 单向增益可以「任何 prompt 都让模型更啰嗦」解释，双向位移不能。
3. **本轮最强的一条读数是否定的：prompt 臂跨运行不可复现。** 在**同一批 8 条片段**上，`none`/`raw` 臂与已发布实验的原文 **8/8 逐字相同**（连 `voicemodule TS` 这种错法都一样），而 prompt 两臂从已发布的 `rawPunct = 0`、`rawFlat = 0` 变成本轮的 **22** 和 **8**；CER 方向也反了（已发布：prompt 让中文 CER 变差；本轮：`punct` 让 CER 从 0.1324 变好到 0.0761）。同一台机器、同一个模型名、同一个端点，两次运行之间只有 `prompt` 这个参数不同 —— 但**臂的绝对值差到没法并读**。
   直接后果有两条：(a) 任何**基于 prompt 臂的阈值都不可导出**，这是决策 8「阈值不可导出」的一次实测印证，而不是一句原则；(b) 已发布实验「不要加 prompt」这个**决定仍然成立**（本轮也找不到采纳它的理由），但它的**理由不能再引用**「中文 prompt 臂句读为 0」—— 那个读数复现不了。
4. **裁剪仍然毁中文句读，且本轮更强。** `raw` 1.25 → `trim` **0.00**（10 → 0，6 条有句读的片段里 3 条被清零）。与已发布 1.13 → 0.13 同向；本轮在 o65 这 8 条上把中文句读打到 0。标识符与 `none` 臂一样是 0/6，所以这条损失**不会被标识符口径看见**。
5. **provider 轴上没有正面证据。** `v3` 相对 `turbo`：句读 5 vs 10（−5），CER 0.1656 vs 0.1324（更差）。换模型在本轮是净负，与已发布实验的结论同向。
6. **本轮唯一的稳定量是「无 prompt 路径的确定性」** —— 它是工程属性，不是质量读数。它让「同一批片段上重跑」成为一种可用的校验手段（正是靠它，第 3 条才被看见）。

## 五、未解释 / 未验证

**1. prompt 臂为什么不可复现？机制未确定。**（本轮最重要的一条未解释）

可能的方向至少三个，本轮一个都没测：

- **服务端漂移**。两次运行相隔一段时间，服务端的模型版本/量化/路由可能变过。这条**不能**用「`none` 臂逐字不变」直接否掉 —— 一个只影响长上下文（prompt 会显著加长解码上下文）的改动可以只打在 prompt 路径上。
- **prompt 路径特有的非确定性**。`/audio/transcriptions` 没有 temperature 这类参数，所以如果 prompt 路径在服务端走了带采样回退的解码配置，客户端无从控制、也无从察觉。
- **prompt 与音频长度/语料的交互**。已发布实验用的 16 条（o65 档全部）与本轮的 8 条是**子集关系**，但两次运行的片段集合不同（本轮是前 8 条）。子集上的绝对数不同是可以预期的；**不可预期的是已发布的 8 条子集上的读数（0/0）与本轮的 8 条（22/8）差这么远**。

要回答它，最小可做的实验是：**同一天内**把 `none` 与 `punct` 两臂各重复 N 次（N≥3），先量**臂内**方差。若 `none` 臂内逐字一致而 `punct` 臂内就不一致，则「服务端漂移」被排除、第 2 个方向成立；若两臂都不稳，则第 1 个方向成立。**本轮没有做这个对照**，所以本记录只能说「prompt 臂的绝对值不可采信」，不能说「慢」在哪一层。

**2. 句读口径有一个已知的残余盲点：标识符残点会被读成句读。**

`maskInternalDots` 只蒙「点**后紧跟**字母/数字」的点。解码器把标识符吐成 `Server. 模块`（点后是空格）时，那个点被保留下来并被 `sentenceMarks` 数成一个句读。本轮 prompt 两臂各有 **4 个**这样的残点（`punct` 22 里有 4、`flat` 8 里有 4），`none`/`trim`/`v3` 三臂是 **0**。

- 修正后的净句读：`none` 10、`punct` 18、`flat` 4、`trim` 0、`v3` 5。
- 方向**不变**（`punct − flat` 仍是 +14；负对照修正后更负，−2 → −6），所以 3.1/3.2 的结论不靠残点支撑。
- 但口径本身该记成**缺陷**：它把「标识符被拆成 `X. Y`」误读成「多了一个句读」，而「拆点」恰恰是 prompt 臂的一种典型损坏方式。**一个只看句读的判据会因此给受损文本加分。**要修，需要把「点 + 空白 + CJK」也纳入蒙版，但那会连带蒙掉真实的中英混排断句，所以正确做法是**分列一个「标识符残点」读数**，而不是改蒙版。本轮没做。

**3. 样本极小，且口语语料是合成的。** n=8 片段、单服务、两次运行（本轮 1 次 + 已发布 1 次）。标识符那一轴尤其薄：8 条里只有 3 条含标识符、共 6 个实例，任何比例都不稳。TTS 合成语料界定的是**效应方向与机制是否存在**，不是真人语音上的幅度。真人语音、真实口音、真实停顿都没测。

**4. prompt 只测了一条固定字符串。** 措辞、长度、位置都没变；`prompt=""`（空串）与「不给 prompt」的差别也没测 —— 而按第 1 条，这正是最该测的那个对照。

**5. 「不跨运行」这条协议的代价没有量化。** 本轮为了满足它，把 5 个条件一次跑完（40 条读数、约 7 分钟）。接入更多条件时这个组合数会线性放大请求数（决策 6 提到「上下文偏置的隐私与预算代价」正是这个）。本记录只登记这个代价，不估计它。

**6. 未做的事（边界）。** 不改任何出货代码；不把质量读数做成 CI 判据（决策 8）；不做风格化的双向负对照（由 `2026-09-22-voice-style-negative-control.md` 承担）；未测 `language` 参数（沿用既有产品决定：产品侧混合语种）；未做成本侧的独立复算（只报出货模块给出的 `savedRatio`）；未做重复运行以量方差（见第 1 条）。

**L_D 该轴仍暗，理由：** 本任务只产出配对质量实验记录，不新增领域数据能力，也没有可读出的领域读数。
**L_G 该轴仍暗，理由：** 同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## 六、复现

工装**在仓库内**，理由与 `experiments/voice-trim/`（同一形状：`fixtures/*.wav` + 冻结转写 + `run*.mjs`）和 `experiments/voice-style-negative-control/` 一致：协议 3 要求被测实现是**出货模块**，仓库外的工装 `import` 不到 `src/shared/voiceTrim.ts` 与 `src/shared/identifierFidelity.ts`；且本任务的 `## Touches` 指定了这个路径。

`fixtures/*.wav`（3.9 MB，8 条）是**唯一一处**音频入库，理由单独登记在 `docs/experiments/README.md`：冻结快照的**每个数字**（句读、CER、标识符、`savedRatio`、音频哈希）都要能在这个仓库里**离线重算**，而重算必须重新解码原始音频。语料全集仍在仓库外，只有这 8 条固定片段进来。

```bash
# 离线：从 fixtures/paired.json 重算全部配对表 + 负对照方向 + 七条自检变异（不联网、不发请求）
node experiments/voice-provider-paired-quality/run.mjs

# 只打印所驱动的出货模块（绝对路径 + 符号名）
node experiments/voice-provider-paired-quality/run.mjs --probe

# 联网：只补缺失的读数（串行，3200 ms 最小间隔，写 out/quality-cache.json）
node experiments/voice-provider-paired-quality/run.mjs --live

# 联网：重取全套并换一个新的 run id（忽略旧缓存；全套同一个新 run，所以配对照旧不跨运行）。
# 它会**覆盖** fixtures/paired.json —— 也就是重做本记录的 3.1 节。想单看跨运行断言，用 --runs=straddle。
node experiments/voice-provider-paired-quality/run.mjs --live --fresh --freeze

# 七条自检变异：每条都必须非零退出，且红在预期的那一位
node experiments/voice-provider-paired-quality/run.mjs --corpus=empty
node experiments/voice-provider-paired-quality/run.mjs --drop='turbo|raw|none'
node experiments/voice-provider-paired-quality/run.mjs --control=absent
node experiments/voice-provider-paired-quality/run.mjs --control=zero
node experiments/voice-provider-paired-quality/run.mjs --control=inverted
node experiments/voice-provider-paired-quality/run.mjs --control=empty
node experiments/voice-provider-paired-quality/run.mjs --runs=straddle
```

凭据解析顺序：`VOICE_PAIRED_API_KEY` / `VOICE_PAIRED_BASE_URL` / `VOICE_PAIRED_MODEL` 环境变量，其次 `VOICE_PAIRED_ENV_FILE`（或 `--env-file <path>`）指向的文件，默认落到 `/data/home/yale/work/tc-verify/.env` 的 `GROQ_*`。**凭据永不打印。**

节流可用 `VOICE_PAIRED_MIN_INTERVAL_MS` 覆盖（默认 3200 ms，对应 Groq on_demand ≈ 20 RPM）。

## 七、对后续「接入新识别服务」的接口

换识别器时**协议不变**（README），改动面就在 `run.mjs` 的 `runLive` 那一层：它是唯一碰 HTTP 的地方，契约是 `POST /audio/transcriptions`、`response_format=json`、可选 `prompt`、可选 `model`。新增一个服务时：

- 加一个 `PROVIDERS` 条目（端点 + 模型名 + 凭据变量名），**不要**新写一份 runner；
- **沿用同一批 8 条 fixture 与同一套条件键命名**（`<provider>|<trim>|<context>`），否则不能与本次数字并列；
- 必须带上 `flat` 负对照并报告它**是否按预测方向移动**；
- 必须报 `n` 与 run id，并注明语料是 TTS 还是真人；
- 如果换了句读口径，先按 README 协议 4 用中文用例自测（本记录「五、2」是这个坑的第二次现身）；
- 若新服务支持 prompt，**先做第 1 条那个重复运行对照**，再决定要不要把 prompt 臂的数字写进结论。
