# 标点实验：prompt 偏置与停顿上限

状态：已测 / 部分结论为否定
日期：2026-09-22
工装：`/data/home/yale/work/tc-verify`（仓库外）
相关：`docs/proposals/voice-vad-trim-before-asr.md`（GOAL-006）、`docs/proposals/voice-identifier-repair-and-temporal-compression.md`

---

## 一、起因

用户报告：语音识别的输出**不带标点符号**。此前已知「停顿裁剪会把句读从 2.06 压到 1.00」（proposal 自陈的已知代价），但那是在中文语料上测的，且从未测过**能否补救**。

本轮要回答的是「其它几项能不能改进标点」，并明确**不测 `language` 参数**（真实使用是混合语种）。

## 二、方法

**语料**：`corpus/dictation`（中文，16 脚本 × 5 占比档 = 80 clips）、`corpus/dictation-en`（英文，16 脚本 × 2 档 = 32 clips）。两套脚本**逐条对应**，控制内容变量。TTS 合成（中文 edge-tts、英文 Orpheus）。

**识别器**：Groq `whisper-large-v3-turbo`（默认）；模型臂另测 `whisper-large-v3`。

**条件**（同一批片段上全部跑一遍）：

| 条件 | 音频 | 停顿表 | prompt |
|---|---|---|---|
| `raw` | 原始 | — | 无 |
| `rawPunct` | 原始 | — | 带标点 |
| `rawFlat` | 原始 | — | **同一个 prompt，只去掉句末标点** |
| `trimFrozen` | 裁剪 | 出货 | 无 |
| `trimMild` | 裁剪 | 各档放宽约一倍 | 无 |
| `trimPunct` | 裁剪 | 出货 | 带标点 |

`flat` 是负对照：有了它，「标点变多」才能被区分成「prompt 的标点被镜像」而不是「随便给个 prompt 都有用」。

**prompt 对**（`punct` 与 `flat` 只差句末标点，标识符的点两侧都保留）：

```
en punct  Change the timeout in voice.service.ts to thirty seconds. Then look at the useVoiceInput hook, and update voice.routes.ts.
en flat   Change the timeout in voice.service.ts to thirty seconds Then look at the useVoiceInput hook and update voice.routes.ts
zh punct  把 voice.service.ts 的超时改成三十秒。然后看一下 useVoiceInput 这个 hook，再更新 voice.routes.ts。
zh flat   把 voice.service.ts 的超时改成三十秒 然后看一下 useVoiceInput 这个 hook 再更新 voice.routes.ts
```

**口径**：

- `句读/片段` —— 先把**标识符内部的点**蒙掉，再数 `[.!?。！？]`。原 `boundaryCount` 会把 `voice.service.ts` 的点也数进去，是指标缺陷（该文件注释已自陈）。
- `标识符存活` —— **出货**模块 `src/shared/identifierFidelity.ts`（逐字，口径分歧见 README）。
- `CER` —— `tools/metrics.mjs`。
- 参考文本**无句末标点**，故不计算标点准确率；只做条件间配对比较，位置合理性靠人读配对文本。

## 三、结果

### 英文（32 片段，配对）

| 条件 | 句读/片段 | naive | 标识符存活 | CER | 相对 raw |
|---|---|---|---|---|---|
| `raw` | 2.09 | 2.72 | 33.3% (6/18) | 0.1257 | — |
| `rawPunct` | **2.72** | 3.53 | 50.0% (9/18) | **0.0912** | +0.63（9↑ 2↓） |
| `rawFlat` | 1.88 | 2.63 | 55.6% (10/18) | 0.0925 | **−0.22**（2↑ 6↓） |
| `trimFrozen` | 2.31 | 2.94 | 33.3% (6/18) | 0.1271 | +0.22（5↑ 1↓） |
| `trimMild` | 2.31 | 2.94 | 33.3% (6/18) | 0.1284 | +0.22（6↑ 1↓） |
| `trimPunct` | **1.25** | 1.75 | **22.2% (4/18)** | 0.1519 | **−0.84（2↑ 18↓）** |

`punct − flat = +0.84`（11↑ 20= 1↓）—— 隔离出「prompt 的标点」这一变量的对比。
`flat − raw = −0.22` —— **负对照按预测方向动了**，这是双向镜像的证据；单向增益可以被「任何 prompt 都有用」解释，反向损失不能。

### 中文（16 片段 o65，配对）

| 条件 | 句读/片段 | naive | 标识符存活 | CER | 相对 raw |
|---|---|---|---|---|---|
| `raw` | **1.13** | 1.56 | 0/9 | **0.1369** | — |
| `rawPunct` | **0.00** | 0.38 | 0/9 | 0.2211 | **−1.13（0↑ 6↓）** |
| `rawFlat` | 0.06 | 0.38 | 0/9 | 0.2540 | −1.06（1↑ 6↓） |
| `trimFrozen` | **0.13** | 0.44 | 0/9 | 0.1421 | **−1.00（0↑ 5↓）** |
| `trimMild` | **0.50** | 0.75 | 0/9 | 0.1435 | −0.63（1↑ 3↓） |

### 成本侧（离线，纯 DSP，`test9-caps-savings.mjs`）

按 Groq 的 **10 秒/请求计费下限** 折算：

| 停顿表 | 英文账单节省 | 中文账单节省 |
|---|---|---|
| `frozen`（出货） | 13.3% | **25.5%** |
| `mild`（各档放宽一倍） | 12.1% | **20.8%** |
| `noCap`（保留全部间隔） | −1.6% | −1.7% |

`noCap` 为负是因为语料在生成时已裁掉首尾静音，它保留间隔却仍加前导/后导与前后导填充 —— 它是**分解点，不是候选方案**，其节省数字不得当作产品数字引用。本表的 `frozen` 列与 proposal 的 25.5% / 13.3% 一致，可作为解码路径的交叉校验。

### 模型臂（16 片段 o65，配对）

| | 句读/片段 | 标识符存活 | CER |
|---|---|---|---|
| 英文 turbo | 2.06 | 33.3% | **0.1250** |
| 英文 whisper-large-v3 | 2.50 | 44.4% | 0.1430 |
| 中文 turbo | **1.13** | 0/9 | **0.1369** |
| 中文 whisper-large-v3 | 0.88 | 0/9 | 0.1427 |

英文标点略好（16 个里 4 好 1 差 11 同），但 CER 两种语言都更差；中文反而略差。

## 四、结论

1. **停顿裁剪确实毁标点 —— 但只在中文。** 中文 1.13 → 0.13（**−89%**）；英文 2.09 → 2.31（**+0.22**，不降反升）。proposal 的「句读塌陷」结论成立且**是中文特有**。
2. **放宽停顿上限是唯一有价值且安全的改动。** 中文救回约一半（0.13 → 0.50，5 个受损片段救回 2 个），**标识符与 CER 不变**；英文**完全无变化**（32 个片段逐一相同，音频确已不同——按字节验证）。代价：中文 4.7pp、英文 1.2pp 的账单节省。停顿表是全局常量，所以这是**全局取舍**。
3. **不要加 prompt。** 英文未裁剪有用（+0.63）；中文 **1.13 → 0.00**、CER 反而更差；英文**开着出货默认的裁剪**时是全表最差（句读 2.31 → 1.25，标识符 33.3% → 22.2%）。由于产品侧不使用 `language`，应用无法区分语种来规避。英文里成立的「镜像」机制是真的，但不是安全杠杆。
4. **换模型无效。** 无收益证据，CER 两语种均变差，且中文（真正有问题的一侧）略差。
5. **CER 对标点损失失明（真实数字确认）。** 中文 `trimFrozen` vs `raw`：CER 仅 +0.52pp（0.1369 → 0.1421），而句读 −89%。任何以 CER 为闸的判据都会放行裁剪而标点消失 —— 这是 AC-118 必须单列句读轴的原因。

**另有一条不在本轮问题上、但读数可见的代价**：裁剪也损坏**中文标识符**。文本层面 `voice.seluis.ts` → `voice.se.`（d01）、`voice.seLuis.ts` → `voice.sereasts`（d02）。标识符口径读 0/9，看不见这个差别，只有读配对文本才看得到。

## 五、未解释 / 未验证

**1. 为什么这个损失是中文特有的？机制未确定。**

需要明确：**不能用「英文有空格和词形变化做冗余」来解释**。空格与词形同样是模型的**输出**，不是输入的属性；用输出侧的差异去解释「输入变化（删停顿）为何只在一侧造成标点损失」，是把待解释的现象换了个说法。这是一个**输入→输出**的因果问题，本轮没有做能回答它的实验。

要回答它，至少需要区分：停顿线索本身在两种语言里的信息量、模型对两种语言的标点条件方式、以及语料差异（中文 1.13 基线 vs 英文 2.09 基线，是否只是触底效应）。本轮一条都没测。

**2. prompt × 裁剪 的交叉效应方向明确，但机制被自己的数据否掉。**
我提出的假设是「prompt 挤占短音频的上下文」，测量结果相反（`outSec` 与损失量的相关系数 r = **+0.226**，且最短/最长两半差异很小 1.31 vs 1.63）。该假设**不成立**，机制留空。

**3. 边界。** 语料是 TTS 合成，所以这些数字界定的是**效应方向**，不是真人语音上的幅度。中文每臂 n=16、英文 n=32，`mild` 的「救回 2 个片段」样本很小。prompt 只测了**一个固定字符串**，换措辞未测。

**4. 早先读数的一次更正（口径缺陷）。**
英文 `rawPunct` 首版报的是 2.47、`punct − raw` = +0.38，那是用有缺陷的蒙版正则算的：`\S*\.(?=[\p{L}\p{N}])` 中的 `\S*` 贪婪且只被空白界定，**中文没有空白** → 一次匹配从句子开头吃到最后一个标识符点，把整句删空；英文也会在 `Ummm...so...` 这类省略号上少数。192 个请求里英文有 5 个受影响。修正后为 2.72 与 **+0.63**。`punct − flat = +0.84` 不变。**只测英文会得到一个干净且完全错误的中文结论** —— 这是 README 协议第 4 条的由来。

## 六、复现

```bash
cd /data/home/yale/work/tc-verify
node tools/test11-summary.mjs      # 上述全部配对表，读缓存，不联网
node tools/test9-caps-savings.mjs  # 成本表，纯 DSP，不联网
```

新跑条件（联网，按条件 × 片段数计请求，串行约 4 秒/请求）：

```bash
LANG_TARGET=en LEVELS=all CONDS=raw,trimFrozen,trimMild node tools/test10-punct-run.mjs
LANG_TARGET=zh LEVELS=o65 CONDS=raw,rawPunct,rawFlat  node tools/test10-punct-run.mjs
MODEL=whisper-large-v3 LANG_TARGET=en LEVELS=o65 CONDS=raw node tools/test10-punct-run.mjs
```

## 七、对后续「其它识别模型/服务」实验的接口

换识别器时，**协议不变**（README），只需替换 `tools/groq.mjs` 这一层：它已经是唯一碰 HTTP 的模块，`transcribe(filePath, { prompt, language, responseFormat, model })` 是全部契约。要接入新的服务，实现同名函数即可，`punct-lib.mjs` 与所有 runner 不必改动。

新增一份实验记录时：

- 沿用同一套条件命名（`raw` / `trimFrozen` / `trimMild` / `trimPunct`）与同一批语料，**否则不能与本次数字并列**；
- 必须带上 `flat` 负对照并报告它是否按预测方向动了；
- 必须报 `n`，并注明语料是 TTS 还是真人；
- 如果换了标点口径，先按 README 第 4 条自测中文用例。
