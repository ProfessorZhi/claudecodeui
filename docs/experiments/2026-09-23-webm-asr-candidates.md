# webm/opus 上传的 ASR 候选：七服务 × 裁剪 × 上下文 × 数字写法归一（2026-09-23）

> 这份记录是第三份配对质量读数。前两份（[2026-09-22-voice-provider-paired-quality.md](./2026-09-22-voice-provider-paired-quality.md)、[2026-09-23-gemini.md](./2026-09-23-gemini.md)）上传的一律是 **wav**；而产品的录音容器是 `audio/webm;codecs=opus`（ADR-004 §缺口①.3）。于是「候选服务在**产品的容器**上表现如何」此前**没有读数**。本记录换的就是这个容器，并把结果冻结成可离线重算的快照。
>
> **它不是闸。** ADR-004 决策 8 把质量读数排除在判据集之外：这里的每个数字都是一条读数，随服务、语料与采样变化。判据只检查「这份读数存在、是出货模块现算的、负对照能红、配对不跨运行」。

## 一、一句话结论

在同一批 8 条中文片段上、**同一次运行**里、**每一次上传都是 webm/opus** 的条件下，七个候选服务全部返回了读数（n=8 × 13 条件 = 104 条，无缺席）。四条结论，一条比一条弱：

1. **原始 CER 最好的一列是 OpenRouter 的 `qwen/qwen3-asr-1.7b`（`or-qwen17`，0.0723）**；换成数字写法归一后的 CER，**最好的是 DashScope 那一族**（`ds-flash|flat` 0.0338、`ds-flash|punct` 0.0372、`ds-flash` 0.0439）—— 口径换了，榜首就换人，因为 DashScope 输出阿拉伯数字而参考文本是中文写法（第四节）。
2. **数字写法归一这一轴不是修饰**：凡输出阿拉伯数字的服务，原始 CER 一律被**同一个常数**高估（`−0.047`，见第四节 d05），而本来就写中文数字的服务一分不动。前两份记录没有这一轴，所以它们对「输出阿拉伯数字的服务」是系统性低估的。
3. **上下文臂：`ds-flash` 被判为 `context honored`，`or-qwenflash` 被判为 `context not honored`** —— 但前者的依据是**位移的形状**而不是重复调用，本记录没有 DashScope 的噪声尺子（第五节、第七节第 1 条）。
4. **本记录预注册的负对照预测（恒等）被实测证伪**：`ds-flash|flat` 与 `ds-flash` 只有 **5/8** 逐字相同（位移 d02/d03/d08）。这是一条**读数**而不是运行失败，但它把第四节的「honored」限定住了 —— 第七节第 1 条是这份记录最该先读的一段。

关于「哪个候选值得接入」：见第七节之后的第十节。**它带着一条硬限定**：这是单一时段、一次采样、没有噪声尺子的一批读数。

## 二、设置

### 2.1 运行标识

```
run id  2026-09-23T15:47:30.000Z
n=8 片段 × 13 条件 = 104 条读数，配对集合 n=8（每个条件都返回了读数，无缺席）
```

一次运行取全部 104 条，**串行**（协议第 7 条，最小间隔 6000 ms，一次只有一个请求在飞）。冻结前检查所有读数同属一个 run id；跨运行的配对会被 runner 拒绝（`--runs=straddle` 变异必须红）。

**单一时段、一次采样、无噪声尺子。** 2026-09-23 的人的裁定取消了跨时段采样：本记录只有一个 run id、一个时段、一次采样。前两份记录里「同一条片段在两个时段各测一次」的那种噪声尺子，在这里**不存在** —— 所以本记录里任何两条条件之间的位移（尤其是 `trim`/`raw`、`punct`/`flat` 之间的差值）**都没有噪声尺子可以对照**，延迟读数也只代表这一个时段。唯一一处**实测**的确定性是 `or-qwenflash|punct` 与 `or-qwenflash|flat`：那两个条件的请求**逐字节相同**（出货适配器把 hint 丢在本地），输出 8/8 逐字相同（第五节）。

### 2.2 条件表

十三列，每列只换一个变量：

| 条件 | 服务 / 模型 | 上传 | 上下文 | 发出路径 | 说明 |
|---|---|---|---|---|---|
| `or-turbo` | OpenRouter `openai/whisper-large-v3-turbo` | webm/opus | 无 | 出货 `openai-compatible` | **网关轴**的一半：前两份记录的基线模型，换网关 |
| `groq-turbo` | Groq `whisper-large-v3-turbo` | webm/opus | 无 | 出货 `openai-compatible` | **网关轴**的另一半：同族模型，与 `or-turbo` 只差网关 |
| `or-qwen17` | OpenRouter `qwen/qwen3-asr-1.7b` | webm/opus | 无 | 出货 `openai-compatible` | Qwen3-ASR 1.7B |
| `or-qwen06` | OpenRouter `qwen/qwen3-asr-0.6b` | webm/opus | 无 | 出货 `openai-compatible` | 同一条线上更小的那一个 |
| `or-qwenflash` | OpenRouter `qwen/qwen3-asr-flash-2026-02-10` | webm/opus | 无 | 出货 `openai-compatible` | 上下文臂在这一列上做 |
| `or-nemotron` | OpenRouter `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b` | webm/opus | 无 | 出货 `openai-compatible` | 多语种 0.6B（探测里最差的一档，作下限参照） |
| `ds-flash` | DashScope `qwen-audio-3.1-asr-flash` | webm/opus | 无 | **runner-local wire** | 上下文臂与负对照的参照条件 |
| `or-qwen17\|trim` | OpenRouter `qwen/qwen3-asr-1.7b` | webm/opus | 无 | 出货 `openai-compatible` | **裁剪轴**：出货 `trimVoiceAudio` 之后再编码为 webm |
| `ds-flash\|trim` | DashScope `qwen-audio-3.1-asr-flash` | webm/opus | 无 | **runner-local wire** | 裁剪轴的另一家 |
| `ds-flash\|punct` | DashScope `qwen-audio-3.1-asr-flash` | webm/opus | 带句末标点的 system 消息 | **runner-local wire** | runner-local wire 真的把它放上线 |
| `ds-flash\|flat` | DashScope `qwen-audio-3.1-asr-flash` | webm/opus | 同一段文本，**只去掉句末标点** | **runner-local wire** | **负对照** |
| `or-qwenflash\|punct` | OpenRouter `qwen/qwen3-asr-flash-2026-02-10` | webm/opus | 带句末标点 | 出货 `openai-compatible` | 上下文臂的另一家 |
| `or-qwenflash\|flat` | OpenRouter `qwen/qwen3-asr-flash-2026-02-10` | webm/opus | 同一段文本，**只去掉句末标点** | 出货 `openai-compatible` | 同上 —— **请求与 `punct` 逐字节相同** |

三根轴：**服务轴**（七个候选）、**裁剪轴**（两条）、**上下文轴**（两条）。

上下文臂的两个条件只差 prompt 里那几个句末标点。**参照条件在取数之前声明为 `none`**（`docs/experiments/README.md` 第 2 条的先例）：本记录的两个上下文臂都被预测为**不被承认**，理由分别是机制（DashScope 那一列由 runner 自己把 system 消息放上线，所以 punct/flat 之间换的**确实**是那一段文本）与声明（出货 `openai-compatible` 适配器声明 `honors.context: false`，把 hint 丢在本地，所以 `or-qwenflash|punct` 与 `or-qwenflash|flat` 的 multipart 请求**逐字节相同**）。

**预注册的负对照预测是恒等**：`ds-flash|flat` 相对 `ds-flash`（`none`）必须逐字相同 —— 一个不承认 system 消息的服务，换掉 system 消息的内容不应当移动任何一条读数。**实测结果是 5/8，预测被证伪**；这条预测的结果是一条读数（不是运行失败），处理方式与它的含义见第五节、第七节第 1 条与第八节。

### 2.3 语料

**TTS 合成**。8 条中文片段（`d01..d08-o65`）是仓库外口述语料 o65 档的一个连续前缀，由语料生成器的脚本原文（`tools/dictation-corpus.mjs` 的 `SCRIPTS`）经 TTS 合成。参考文本是**喂给 TTS 的脚本原文**，构造上是真值。

语料**不复制**：音频与参考文本都从 `experiments/voice-provider-paired-quality/fixtures/` 原地读，与**前两份记录是同一批片段**（跨记录的数字因此可以并列）。本记录的冻结快照按片段 × 裁剪列钉了 wav 与 webm 两个 sha256，离线重算时会在本机重新解码、用出货模块重新裁剪、用主机 `ffmpeg` 重新编码，然后**逐字节比对**（16 条上传记录全部对得上，且全部是 `audio/webm`）。

**编出来的 opus 与产品的 opus 不是同一个编码器**：本记录的 webm 由主机 `ffmpeg`（`6.1.1-3ubuntu5`，`-c:a libopus -b:a 64k -ar 48000 -ac 1 -fflags +bitexact -flags +bitexact`）编出，而产品里是 Chrome `MediaRecorder`。所以这里测的是**容器**，不是编码器参数。

### 2.4 读数口径

| 轴 | 口径 |
|---|---|
| 句读 `marks` | `maskInternalDots` 之后数 `[.!?。！？]`（标点实验的同一个蒙版，含中文修正） |
| 未蒙版 `naive` | 不蒙版的同一个计数，只作口径分歧的可见读数 |
| 逗号 `commas` | 单独报 —— 参考文本的边界**只有逗号**，而 `sentenceMarks` 不数逗号 |
| 标识符 | 两列并列：**出货** `src/shared/identifierFidelity.ts`（逐字敏感）与「四个已知标识符的大小写不敏感子串命中」（宽松，与 README 那节的口径分歧对应）。合计 6 次出现（跨 8 条片段） |
| CER | 归一化（小写、去标点、去空白）后按字符算 Levenshtein |
| `cerNumNorm` | **数字写法归一后**的同一个 CER（0–9999 的中文数字 ↔ 阿拉伯数字双向归一） |
| 漏句 `leaked` | 归一文本长度 < 参考长度的 60% |
| 延迟 | 调用前后各一个时钟，**不含**节流等待；单一时段的读数 |
| 用量 | 只有 DashScope 那一列有（服务自己返回）；出货适配器不填 `AsrSuccess.meta.usage`，所以 OpenRouter/Groq 列一律 `null`（第七节第 6 条） |

## 三、读数

按 `cerNumNorm` 升序（**两个口径并列**，原始 CER 最好的一列另外标出）：

| # | 条件 | cer | cerNumNorm | Δ | marks | naive | commas | id 逐字/宽松 | leaked | 延迟均值 ms (最大) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `ds-flash\|flat` | 0.0809 | **0.0338** | −0.047 | 13 | 22 | 13 | 2/6 · 2/6 | 0/8 | 6938 (13308) |
| 2 | `ds-flash\|punct` | 0.0843 | 0.0372 | −0.047 | 13 | 22 | 13 | 2/6 · 2/6 | 0/8 | 5634 (19662) |
| 3 | `ds-flash` | 0.0911 | 0.0439 | −0.047 | 9 | 18 | 11 | 2/6 · 2/6 | 0/8 | 3768 (9596) |
| 4 | `ds-flash\|trim` | 0.1048 | 0.0576 | −0.047 | 9 | 15 | 13 | 2/6 · 2/6 | 0/8 | 1444 (2343) |
| 5 | **`or-qwen17`** | **0.0723** ← 原始 CER 榜首 | 0.0723 | 0 | 12 | 12 | 14 | 0/6 · 0/6 | 0/8 | 8672 (47689) |
| 6 | `or-qwen17\|trim` | 0.0834 | 0.0834 | 0 | 11 | 11 | 13 | 0/6 · 0/6 | 0/8 | 1346 (2292) |
| 7 | `groq-turbo` | 0.1324 | 0.0853 | −0.047 | 10 | 17 | 4 | 0/6 · 0/6 | 0/8 | 938 (2868) |
| 8 | `or-qwen06` | 0.0921 | 0.0921 | 0 | 17 | 18 | 8 | 0/6 · 0/6 | 0/8 | 19909 (107443) |
| 9 | `or-qwenflash` | 0.1503 | 0.1110 | −0.039 | 27 | 27 | 5 | 0/6 · 0/6 | 0/8 | 1177 (1778) |
| 10 | `or-qwenflash\|punct` | 0.1503 | 0.1110 | −0.039 | 27 | 27 | 5 | 0/6 · 0/6 | 0/8 | 1140 (1940) |
| 11 | `or-qwenflash\|flat` | 0.1503 | 0.1110 | −0.039 | 27 | 27 | 5 | 0/6 · 0/6 | 0/8 | 1238 (3367) |
| 12 | `or-turbo` | 0.2622 | 0.2151 | −0.047 | 16 | 21 | 3 | 0/6 · 0/6 | 0/8 | 2807 (7733) |
| 13 | `or-nemotron` | 0.3518 | 0.3518 | 0 | 8 | 8 | 4 | 0/6 · 0/6 | **1/8** | 2537 (6006) |

怎么读这张表：

- **`or-qwen17` 与 DashScope 那一族是两档不同的事实。** `or-qwen17` 走的是**出货**适配器（可归给代码）；DashScope 四列走的是 **runner-local wire**（不可归给任何出货代码，第七节第 5 条）。把两族并排放在一张表里是为了「同一批片段、同一次运行」这个对照，不是把它们当成同等可接入的候选。
- **标识符只有 DashScope 那一族守住了任何一条**（6 次出现里守住 2 次，逐字敏感口径与宽松口径同为 2/6 —— 说明它守的是**逐字**，不是大小写不敏感的巧合）。七个走 OpenRouter/Groq 的候选**一条都没守住**（0/6）。
- **`or-nemotron` 是唯一漏句的**（1/8），也是两个口径都最差的（0.3518），符合探测里给它「下限参照」的定位。
- **句读数与逗号数没有真值**（参考文本不带句末标点，协议第 5 条）：`marks` 只作条件间比较的读数。`or-qwenflash` 的 `marks` 最高（27，均值 3.38）—— 它是这批里唯一**大量加句号**的一列。
- **延迟是单一时段读数**，且 `or-qwen06` 有一条 107443 ms 的离群（第 8 条片段之外的时段波动，探测里也见过 30–58 s 与 0.4–0.8 s 两个时段）。不能拿它代表服务。

逐片段的原文并列（人读的那一半，协议第 5 条）在**附录 A**，runner 每次运行也会把它整块打到 stdout。

## 四、数字写法归一

`cerNumNorm` 是同一批读数换一个数字口径所得；Δ = cerNumNorm − cer：

| 条件 | cer | cerNumNorm | Δ | 这一列的数字怎么写的 |
|---|---|---|---|---|
| `ds-flash` / `\|trim` / `\|punct` / `\|flat` | 0.0911 / 0.1048 / 0.0843 / 0.0809 | 0.0439 / 0.0576 / 0.0372 / 0.0338 | **−0.047** ×4 | 阿拉伯数字（`15秒`、`50秒`、`5秒`） |
| `or-turbo` | 0.2622 | 0.2151 | **−0.047** | 阿拉伯数字（`30秒`） |
| `groq-turbo` | 0.1324 | 0.0853 | **−0.047** | 阿拉伯数字（`15秒`） |
| `or-qwenflash` ×3 | 0.1503 | 0.1110 | −0.039 | 混写（`15s`、`50s` —— `s` 不是数字词，只归一回一半） |
| `or-qwen17` / `or-qwen17\|trim` | 0.0723 / 0.0834 | 0.0723 / 0.0834 | 0 | 中文数字（`十五秒`）—— 本来就对得上 |
| `or-qwen06` | 0.0921 | 0.0921 | 0 | 中文数字 |
| `or-nemotron` | 0.3518 | 0.3518 | 0 | 中文数字 |

**一个片段说明了整条轴**（d05，参考 `把超时从十五秒改成五十秒，不是五秒`）：

| 条件 | 输出 | cer | cerNumNorm |
|---|---|---|---|
| `or-turbo` | `把超时从15秒改成50秒不是5秒。` | 0.3125 | **0.0000** |
| `groq-turbo` | `把超时从15秒改成。50秒?不是5秒。` | 0.3125 | **0.0000** |
| `ds-flash`（四列同） | `把超时从15秒改成50秒，不是5秒。` | 0.3125 | **0.0000** |
| `or-qwenflash` | `把超时从15s改成50s，不是五秒。` | 0.3750 | 0.1250 |
| `or-qwen17` / `\|trim` | `把超时从十五秒改成五十秒，不是五秒。` | 0.0000 | 0.0000 |
| `or-qwen06` | `把超时从十五秒改成五十秒。不是五秒。` | 0.0000 | 0.0000 |
| `or-nemotron` | `把超时从十五秒改成五十秒不是五秒。` | 0.0000 | 0.0000 |

**读这条轴的注意事项**（不是判据，是读法）：归一**只动数字写法**，不动别的错字 —— 所以它是一把"只治这一种病"的尺子，Δ 全是零的条件不是「更好」，而是「本来就写中文数字，这把尺子对它无效」。这也是为什么两个口径必须**并列**打印：任何只报 `cer` 的读法都会把这批里四个 DashScope 列 + 两个 whisper 列各自低估 0.047。

## 五、上下文臂

两个臂，两个结论，**依据的硬度不同**：

| 臂 | `punct` vs `flat` 逐字相同 | `none` vs `punct` 逐字相同 | 结论 | 依据 |
|---|---|---|---|---|
| `ds-flash`（runner-local wire，system 消息真的上线） | 6/8 | 5/8 | **context honored** | `punct` 与 `flat` 的位移集合 {d02, d03} 是 `none` 与 `flat` 的位移集合 {d02, d03, d08} 的**真子集**，且 `none|flat` 与 `none|punct` 的位移集合**完全相同** —— 这是「system 消息的内容动得越多、动到的片段越多」的嵌套形状；「逐次调用各自翻硬币」不会给出嵌套。**限定**：本服务没有重复调用尺子（第七节第 1 条） |
| `or-qwenflash`（出货适配器，hint 丢在本地） | **8/8** | **8/8** | **context not honored** | `punct` 与 `flat` 的 multipart 请求**逐字节相同**（适配器声明 `honors.context: false`），输出也就逐字相同 —— 这条既是「未被承认」的直接证据，也实测了出货声明本身；它还是本记录**唯一**的确定性尺子 |

两条都是**读数**，判定规则（`punct` vs `flat` 逐字相同 ⇒ 未被承认，否则被承认）在取数之前就写在 runner 里，每次运行都会把它连同依据与形状打到 stdout。

**`ds-flash` 这一臂的结论必须带着它的限定读**：它成立的前提是「位移来自 system 消息的内容」；同一批读数里预注册的恒等预测被证伪（5/8），而那个预测说的正是「这个服务不读 system 消息」。两条事实放在一起只能得出：**该服务确实对 system 消息的内容有反应**（这否掉了「不承认上下文」），但「有反应」与「逐次调用本来就不确定」这两种机制，在本记录里**分不开** —— 区分它们需要同一条件重复调用，而那正是 2026-09-23 的裁定取消掉的那一半（第七节第 1 条）。所以这一格的「honored」是**形状支持、没有噪声尺子背书**的结论。

## 六、裁剪臂

两条，都是「出货 `trimVoiceAudio` 之后再编码为 webm」，与各自的 `raw` 列只差音频本身：

| 服务 | 列 | cer | cerNumNorm | marks | commas | id | leaked | 延迟均值 (最大) |
|---|---|---|---|---|---|---|---|---|
| `or-qwen17` | raw | 0.0723 | 0.0723 | 12 | 14 | 0/6 | 0/8 | 8672 (47689) |
| `or-qwen17` | trim | 0.0834 | 0.0834 | 11 | 13 | 0/6 | 0/8 | **1346** (2292) |
| `ds-flash` | raw | 0.0911 | 0.0439 | 9 | 11 | 2/6 | 0/8 | 3768 (9596) |
| `ds-flash` | trim | 0.1048 | 0.0576 | 9 | 13 | 2/6 | 0/8 | **1444** (2343) |

- **质量上，裁剪在两家都略微变差**：`or-qwen17` +0.011（两个口径同样），`ds-flash` +0.014（原始）/ +0.014（归一）。幅度在同一批读数里算小，但**方向一致**，且没有噪声尺子能说这 0.011 是真是假（第七节第 2 条）。
- **延迟上，裁剪在两家都大幅下降**（8672→1346、3768→1444）。这条**不能**直接读成「裁剪让服务更快」：裁剪后的上传字节数本来就小得多，延迟与**载荷大小**在这批读数里是混在一起的；而且延迟只有一个时段（第七节第 3 条）。
- 标识符与漏句都不变（2/6、0/8 各自稳定），句读数在两家都动 1 以内 —— 这符合「裁剪删的是停顿」的机制。

## 七、未解释 / 未验证

1. **预注册的负对照预测被证伪，而两种解释分不开。** `ds-flash|flat` 与 `ds-flash` 逐字相同 5/8（位移 d02/d03/d08）。这只说明「有东西在动」，不能说明是什么：可能是该服务**真的读** system 消息，也可能是它**逐次调用本来就不确定**。要分开它们，需要**同一个条件重复调用**（同一段音、同一个 prompt、发两次），而 2026-09-23 的裁定把跨时段采样取消了，本服务这一次没有重复调用。**这是本记录最大的未验证项**，它直接限定第五节的 `ds-flash` 结论。（可用的间接依据只有形状：三个两两比较的位移集合呈嵌套 —— 见第五节。）
2. **没有噪声尺子。** 整份记录只有一个 run id、一个时段、一次采样。任何两条条件之间的差值都没有对照。唯一**实测**的确定性来自 `or-qwenflash|punct` 与 `or-qwenflash|flat` 的 8/8（请求逐字节相同）—— 那是**另一个网关、另一个服务**上的尺子，不能搬到 DashScope 上。
3. **延迟只代表一个时段。** `or-qwen06` 有一条 107443 ms 的离群，其余大多在 1–9 s；探测里见过 30–58 s 与 0.4–0.8 s 两个时段。延迟**不是**这批记录能回答的问题。
4. **ffmpeg 的 opus ≠ Chrome `MediaRecorder` 的 opus。** 参数不完全相同（本记录 `-c:a libopus -b:a 64k -ar 48000 -ac 1`）。所以这里测的是产品的**容器**，不是产品的**编码器**。
5. **DashScope 四列测的是服务，不是出货代码。** 仓库里**没有** DashScope 适配器（本任务明确不写），那四列的请求由 runner 本地构造，冻结快照的 `provenance.wireByCondition` 里逐条标为 `runner-local wire (no shipped adapter)`。它们的读数**不能归给任何出货代码**，也不能当作「接进去就会这样」的证据。
6. **用量只有 DashScope 那一列有。** 服务自己返回 `{duration, input_tokens, output_tokens, total_tokens}`；出货适配器不填 `AsrSuccess.meta.usage`，所以 OpenRouter/Groq 列一律 `null` —— 这是**出货解析的读数**，不是那些服务不返回用量。
7. **为什么没有一个 OpenRouter/Groq 候选守住标识符。** 6 次出现里 0/6，包括逐字敏感与宽松两个口径。是模型能力、是 webm 容器、还是 `prompt` 字段没上线（适配器声明 `honors.prompt: false`）—— 本记录分不开。
8. **d08 的句末标点为什么不影响。** `punct` 与 `flat` 只在 d02、d03 上不同，而 `none` 与两者都在 d02、d03、d08 上不同：说明 d08 上「有 system 消息」有关系，「它的句末标点」没关系。为什么，本记录没有读数可答。
9. **参考文本不是标点真值**（协议第 5 条）：它不带句末标点，所以本记录**没有**任何标点正确率数字，`marks`/`naive`/`commas` 只作条件间比较。

## 八、与判据的关系（ADR-004 决策 8）

```
quality numbers are a reading and are NOT a criterion
```

本文件里的**每一个数字**都是读数，不是闸。判据只检查四件事，都和数字大小无关：

1. 这份读数**存在**，且报告的 `n` 非零（空读数不是绿）；
2. 负对照的**预测被执行了**、它的读数是**快照自己的**，且工装能把这两种状态各自打红（`absent` / `zero` / `inverted` / `empty` 四个变异离线自检逐个要求红，并断言每条变异**真的碰到了读数**）；预测的**结果**（成立 / 被证伪）**不进退出码** —— 本记录的预测被证伪而运行是绿的，这正是「负对照能红」的最强形态：不是工装造出来的红，是服务自己红出来的。另一半是**绿**：请求逐字节相同的 `or-qwenflash` 臂必须 8/8 逐字相同，一个「永远返回 against」的比较过不了这一半；
3. 配对的读数**不跨运行**（冻结前检查所有读数同一个 run id，`--runs=straddle` 变异必须红）；
4. 被测实现是**出货模块**（`--probe` 打印绝对路径与符号名，并断言工装源码里没有第二份 OpenAI 兼容请求构造）。

把「预注册的预测必须成立」写进退出码，等于把「答案必须是这个」写进判据 —— 那与这一节的第一行是同一件事的正反面。

## 九、复现

```bash
# 离线：从冻结快照重算全部读数 + 负对照 + 上下文臂 + 自检（不联网，退出 0）
node experiments/voice-webm-asr-paired-quality/run.mjs

# 只打印所驱动的出货模块的绝对路径 + 符号名，并断言快照里没有 wav 上传记录（退出 0）
node experiments/voice-webm-asr-paired-quality/run.mjs --probe

# 把每条片段 × 每条裁剪列编码成 webm 并打印请求计划（要 ffmpeg；不联网、不用凭据）
node experiments/voice-webm-asr-paired-quality/run.mjs --live --dry-run

# 重新取真实读数（联网 + 凭据，串行，写 out/quality-cache.json，冻成 fixtures/snapshot.json）
node experiments/voice-webm-asr-paired-quality/run.mjs --live --freeze

# 指标自检（数字归一、蒙版句读、CER 四个口径的已知答案用例）（退出 0）
node experiments/voice-webm-asr-paired-quality/run.mjs --selftest

# 自检变异，各应**非零**退出
node experiments/voice-webm-asr-paired-quality/run.mjs --corpus=empty      # n=0
node experiments/voice-webm-asr-paired-quality/run.mjs --drop=ds-flash|flat # 负对照读数被抽走
node experiments/voice-webm-asr-paired-quality/run.mjs --control=absent     # 预测没被执行
node experiments/voice-webm-asr-paired-quality/run.mjs --control=zero       # 读数被置零（工装自造）
node experiments/voice-webm-asr-paired-quality/run.mjs --control=inverted    # 读数被推离参照条件（工装自造）
node experiments/voice-webm-asr-paired-quality/run.mjs --control=empty      # 读数被抽走
node experiments/voice-webm-asr-paired-quality/run.mjs --runs=straddle      # 配对跨运行
```

**被测实现只能是出货模块**：OpenRouter 与 Groq 的每一列都经 registry 解析出的 `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts#transcribe` 发出（`fetchImpl` 就是全局 `fetch`，不包装、不改 body）；裁剪列的音由 `src/shared/voiceTrim.ts#trimVoiceAudio` 现算；标识符口径是 `src/shared/identifierFidelity.ts`。

**DashScope 列测的是服务而非出货代码**：仓库里**没有** DashScope 适配器（本任务明确不写），所以那一列（`ds-flash`、`ds-flash|trim`、`ds-flash|punct`、`ds-flash|flat`）的请求由 runner 本地构造，冻结快照的 `provenance.wireByCondition` 里逐条标为 `runner-local wire (no shipped adapter)`。读这一列的人必须知道：它的读数**不能归给任何出货代码**。

**DashScope 浏览器不能直连（CORS）**：该端点（`https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`）的 CORS 预检返回 **401 且不带任何 CORS 头**，所以浏览器的直连路径不存在 —— 要走这条服务必须有一个服务端中转。这与 OpenRouter 那一侧相反（预检 204、`allow-origin: *`），也是「候选服务能不能直接接进前端」这条产品问题的读数之一。

## 十、哪个候选值得接入（带限定）

按**能不能接**与**接进去好不好**两问分开答，因为这两问的答案来源不同：

- **能直接接进现有出货路径的，只有 OpenRouter 与 Groq 的六列**（都经 `openai-compatible` 适配器发出，`acceptsMime` 含 `audio/webm`，浏览器侧预检 204 + `allow-origin: *`）。这六列里的质量榜首是 **`or-qwen17`（`qwen/qwen3-asr-1.7b`，原始 CER 0.0723，也是这六个里唯一一个原始与归一两个口径重合的榜首）**；`or-qwen06` 是它更小的一档（0.0921），`or-qwenflash` 明显更差（0.1503，且它是唯一大量加句号的），`or-nemotron` 是下限参照（0.3518，1/8 漏句）。
- **两个 whisper 的对照（`or-turbo` vs `groq-turbo`）**：同一个族、只换网关，原始 CER 0.2622 vs 0.1324 —— 网关这一轴的差值比很多模型间的差值都大，说明**这批读数不能跨网关搬用**。
- **DashScope 那一族（归一后 0.0338–0.0576）看起来最好，但它现在不是一个可接入项**：仓库里没有它的适配器（读数不可归给出货代码），浏览器不能直连（必须有服务端中转），而且它的负对照预测被证伪、没有噪声尺子（第七节第 1 条）。要把它变成候选，先要写适配器 + 服务端中转，再重取一次带重复调用的读数。
- **裁剪**：两家都「质量略降、延迟大幅降」，但延迟与载荷混在一起，且只有一个时段 —— 所以这笔账现在**算不清**，只能记为「裁剪不至于毁掉识别质量」（标识符与漏句都没变）。
- **硬限定**（必须跟着上面每一条读）：单一语料（TTS 合成的 8 条中文）、单一语言、单一时段、一次采样、没有噪声尺子、ffmpeg 的 opus 不等于产品的 opus。质量数字**不进 CI**（ADR-004 决策 8）。

## 附录 A：逐片段文本并列（8 条片段 × 13 列）

下面这一块与 runner 打到 stdout 的那一块**同一份**（`node experiments/voice-webm-asr-paired-quality/run.mjs` 的 `paired transcripts` 段落）。位置是否合理只能人读，所以原文必须落在记录里。

```
paired transcripts (one block per clip; the human-read half of this record):
  [d01-o65.wav] reference: 把 server 里的 voice.service.ts 的超时改成三十秒
      or-turbo           把server李的voice.seLuis TS的超时改成30秒
      groq-turbo         把server里的voice.seluis.ts的超时改成30秒
      or-qwen17          把server里的voice点se_rists的超时改成三十秒。
      or-qwen06          把server里的race点se race.ts的超时改成三十秒。
      or-qwenflash       把server里的voice点se、rests的超时改成30s。
      or-nemotron        理的 wos de SETS 的超时改成三十秒。
      ds-flash           把server里的voice.se-voice-tts的超时改成30秒。
      or-qwen17|trim     把server里的voice点se_rests的超时改成三十秒。
      ds-flash|trim      把server里的Voice点SEVoiceTS的超时改成30秒。
      ds-flash|punct     把server里的voice.se-voice-tts的超时改成30秒。
      ds-flash|flat      把server里的voice.se-voice-tts的超时改成30秒。
      or-qwenflash|punct 把server里的voice点se、rests的超时改成30s。
      or-qwenflash|flat  把server里的voice点se、rests的超时改成30s。
  [d02-o65.wav] reference: 改一下 voice.service.ts，嗯不对，应该是 voice.routes.ts
      or-turbo           改一下。voice.seLuis Ts嗯不对。应该是。Voice.roUTS
      groq-turbo         改一下。voice.seluis.ts嗯,不对。应该是。voice.roUts.ts
      or-qwen17          改一下，voice点s e，voice t s，嗯，不对，应该是voice点r o，u s t s。
      or-qwen06          改一下，Voice点SE，VoiceTS。嗯，不对，应该是Voice点RO，UseTS。
      or-qwenflash       改一下。voice点se。voice点ts。嗯不对。应该是。voice点ro。use点ts。
      or-nemotron        改一下 WSD SETS 嗯, 不对, 应该是 WSDROCTS。
      ds-flash           改一下，voice.se voice.ts 嗯，不对，应该是 voice.ro uds.ts。
      or-qwen17|trim     改一下，voice点se，voice ts，嗯，不对，应该是voice点ro，voice ts。
      ds-flash|trim      改一下，Voice.se，Voice ts，嗯，不对，应该是Voice.ro，Youth ts。
      ds-flash|punct     改一下，voice.se，voice.ts，嗯不对，应该是voice.ro，use.ts。
      ds-flash|flat      改一下，voice.se，voice.ts，嗯不对，应该是voice.ro，utils.ts。
      or-qwenflash|punct 改一下。voice点se。voice点ts。嗯不对。应该是。voice点ro。use点ts。
      or-qwenflash|flat  改一下。voice点se。voice点ts。嗯不对。应该是。voice点ro。use点ts。
  [d03-o65.wav] reference: 看一下 useVoiceInput 这个 hook 是怎么处理 recording 的
      or-turbo           看一下。Yous VoiceInput JiggerFolk是怎么处理?Recordant.Gida
      groq-turbo         看一下。Use voiceInput这个。Hook是怎么处理。RecordingG的。
      or-qwen17          看一下，usefuls input这个hook是怎么处理？recording记得。
      or-qwen06          看一下，use voice input这个hook是怎么处理。recorden记得。
      or-qwenflash       看一下。useless input这个hook是怎么处理recorded g的。
      or-nemotron        看一下 Input这个是怎么处理 recorden G 的。
      ds-flash           看一下 useVoiceInput 这个 hook 是怎么处理 Recorder 的。
      or-qwen17|trim     看一下，usefuls input这个hook是怎么处理recording G的。
      ds-flash|trim      看一下 useVoiceInput 这个 Hook 是怎么处理 Recorder API 的。
      ds-flash|punct     看一下。 useVoiceInput这个。 hook。 是怎么处理？ recording。 g的。
      ds-flash|flat      看一下。 useVoiceInput这个。 hook。 是怎么处理？ recording。 的。
      or-qwenflash|punct 看一下。useless input这个hook是怎么处理recorded g的。
      or-qwenflash|flat  看一下。useless input这个hook是怎么处理recorded g的。
  [d04-o65.wav] reference: 不要动 voice.service.ts，只改 voice.module.ts
      or-turbo           不要动!voice.seLuis Ts直改Wars。Module - TS
      groq-turbo         不要动voice.seLuis TS直改voicemodule TS
      or-qwen17          不要动。voice点se，voice ts，只改voice，module ts。
      or-qwen06          不要动。Voice点S E。Voice T S。只改Voice。Module T S。
      or-qwenflash       不要动。voice点se。voice点ts。只改voice。module点ts。
      or-nemotron        不要动 wos de SETS 指改 WS ma Johns.
      ds-flash           不要动voice.se，voice.ts只改voice.module.ts。
      or-qwen17|trim     不要动。voice点se，voice ts，只改voice module ts。
      ds-flash|trim      不要动voice.se，voice.ts只改voice.module.ts。
      ds-flash|punct     不要动voice.se，voice.ts只改voice.module.ts。
      ds-flash|flat      不要动voice.se，voice.ts只改voice.module.ts。
      or-qwenflash|punct 不要动。voice点se。voice点ts。只改voice。module点ts。
      or-qwenflash|flat  不要动。voice点se。voice点ts。只改voice。module点ts。
  [d05-o65.wav] reference: 把超时从十五秒改成五十秒，不是五秒
      or-turbo           把超时从15秒改成50秒不是5秒。
      groq-turbo         把超时从15秒改成。50秒?不是5秒。
      or-qwen17          把超时从十五秒改成五十秒，不是五秒。
      or-qwen06          把超时从十五秒改成五十秒。不是五秒。
      or-qwenflash       把超时从15s改成50s，不是五秒。
      or-nemotron        把超时从十五秒改成五十秒不是五秒。
      ds-flash           把超时从15秒改成50秒，不是5秒。
      or-qwen17|trim     把超时从十五秒改成五十秒，不是五秒。
      ds-flash|trim      把超时从15秒改成50秒，不是5秒。
      ds-flash|punct     把超时从15秒改成50秒，不是5秒。
      ds-flash|flat      把超时从15秒改成50秒，不是5秒。
      or-qwenflash|punct 把超时从15s改成50s，不是五秒。
      or-qwenflash|flat  把超时从15s改成50s，不是五秒。
  [d06-o65.wav] reference: 嗯…那个…就是这个 composer 的按钮，嗯…再加个快捷键
      or-turbo           嗯,那个,就是这个Composer的安妞。嗯,在家的快捷键
      groq-turbo         嗯,那个,就是这个Composer的按钮嗯,再加个快捷键
      or-qwen17          嗯，那个就是这个 composer 的按钮。嗯，再加个快捷键。
      or-qwen06          嗯，那个就是这个 Composer 的按钮。嗯，再加个快捷键。
      or-qwenflash       嗯，那个，就是这个。composer。的按钮。嗯，再加个快捷键。
      or-nemotron        嗯, 那个就是这个 composer按钮。 嗯, 再加个快捷键。
      ds-flash           嗯，那个，就是这个，Composer 的按钮，嗯，再加个快捷键。
      or-qwen17|trim     嗯，那个就是这个 composer 的按钮。嗯，再加个快捷键。
      ds-flash|trim      嗯，那个就是这个，Composer 的按钮，嗯，再加个快捷键。
      ds-flash|punct     嗯，那个，就是这个，Composer 的按钮，嗯，再加个快捷键。
      ds-flash|flat      嗯，那个，就是这个，Composer 的按钮，嗯，再加个快捷键。
      or-qwenflash|punct 嗯，那个，就是这个。composer。的按钮。嗯，再加个快捷键。
      or-qwenflash|flat  嗯，那个，就是这个。composer。的按钮。嗯，再加个快捷键。
  [d07-o65.wav] reference: server 模块下的 voice 目录里加一个 call 的测试
      or-turbo            Server.  模块下的。  Voice.  目录里加一个。  CODE 測試.
      groq-turbo         Server模块下的Voice目录里加一个Code测试
      or-qwen17          Server 模块下的 Voice 目录里加一个 Call 的测试。
      or-qwen06          Server模块下的Voice目录里加一个Code测试。
      or-qwenflash       server模块下的voice目录里加一个call的测试。
      or-nemotron        魔快下的目录里加一个靠的测试。
      ds-flash           server模块下的voice目录里加一个call的测试。
      or-qwen17|trim     server 模块下的 voice 目录里加一个 call 的测试。
      ds-flash|trim      server模块下的voice目录里加一个call的测试。
      ds-flash|punct     server模块下的voice目录里加一个call的测试。
      ds-flash|flat      server模块下的voice目录里加一个call的测试。
      or-qwenflash|punct server模块下的voice目录里加一个call的测试。
      or-qwenflash|flat  server模块下的voice目录里加一个call的测试。
  [d08-o65.wav] reference: 把默认模型换成 whisper large，啊不，是 whisper turbo
      or-turbo           把默认模型换成。WhisperLarge阿波是Whisper。特勃
      groq-turbo         把默认模型换成WhisperLargeAbu是WhisperTurbo
      or-qwen17          把默认模型换成 Whisper Large。啊，不是 Whisper Turbo。
      or-qwen06          把默认模型换成 Whisper Large。阿布是 Whisper Turbo。
      or-qwenflash       把默认模型换成。Whisper。Large。不。是Whisper。Turbo。
      or-nemotron        把默认模型换成 Wisper Large Rhisper Turbo
      ds-flash           把默认模型换成Whisper Large？啊不，是Whisper Turbo。
      or-qwen17|trim     把默认模型换成Whisper Large。啊，不是Whisper Turbo。
      ds-flash|trim      把默认模型换成Whisper Large？啊不，是Whisper Turbo。
      ds-flash|punct     把默认模型换成Whisper Large啊，不是Whisper Turbo。
      ds-flash|flat      把默认模型换成Whisper Large啊，不是Whisper Turbo。
      or-qwenflash|punct 把默认模型换成。Whisper。Large。不。是Whisper。Turbo。
      or-qwenflash|flat  把默认模型换成。Whisper。Large。不。是Whisper。Turbo。
```

## 附录 B：runner 的收尾自检行（同一次离线运行）

```
falsifiers (each variant must red, and red for the stated reason):
  real=against(Δchars 4)  control=absent=absent  control=zero=against  control=inverted=against  control=empty=empty  drop=ds-flash|flat=empty  or-qwenflash=绿 8/8  corpus=empty=n0/0readings  runs=straddle=red

voice-webm-asr-paired-quality: OK — n=8, 104 paired reading(s), negative control against (5/8 verbatim, Δchars 4；预注册的恒等预测被证伪，这是一条读数); quality numbers are a reading and are NOT a criterion (ADR-004 decision 8)
```
