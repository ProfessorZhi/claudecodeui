# 停顿切开对自我更正的影响：预注册（flushSilenceSec 选参）

状态：**本文件先于取数提交**。判据：`git log --diff-filter=A --format=%ct -- experiments/voice-vad/PREREG-pause-split.md`
读到的首次提交时间，早于 `experiments/voice-vad/fixtures/pause-split.json` 的首次提交时间
（`git log --diff-filter=A --format=%ct -- experiments/voice-vad/fixtures/pause-split.json`）。
若把这份登记往回调、或先取数后补登记，整份记录作废。

来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md`（§「切分的已知代价」：`dashscope-omni`
的 `honors.context=false`，跨段标识符会断），以及人（yale）对 `flushSilenceSec` 默认 5 秒的临时认可。

**不与** `experiments/voice-dashscope-omni-paired-quality` 重复：那条比的是 provider / 裁剪 / 上下文，
用识别读数；本条比的是**切开位置（停顿长度 P）对自我更正解算的影响**。同样不与
`experiments/voice-vad`（T1/T2/T4）重复：那条选的是 VAD 端点参数，真值是时间区间；本条的真值是
「更正是否被解出」，是语义读数。

被测实现：出货的 `dashscope-omni` 适配器（`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`，
经 `shared/asr/asrRegistry.ts` 的 `tryResolve('dashscope-omni')` 解析——不是直接 import 那个模块，
因为直接 import 只能证明「文件导出 `transcribe`」，证明不了它是出货路径给出的那一个）。
工装不复制适配器、不另拼请求体：请求由适配器自己的 `buildChatRequestBody` 构造。

---

## 1. 语料与音频构造（真值由构造给出）

四条**自我更正**脚本，取自作语料生成器 `tools/dictation-corpus.mjs` 的 `SCRIPTS` / `SCRIPTS_EN`
（仓库外 `/data/home/yale/work/tc-verify`，原文逐字，不重抄）：

| 脚本 | 语言 | 更正前目标 A | 更正后目标 B | 前半句（段 1） | 后半句（段 2） |
|---|---|---|---|---|---|
| `d02` | zh | `voice.service.ts` | `voice.routes.ts` | `改一下 voice.service.ts，` | `嗯不对，应该是 voice.routes.ts` |
| `d08` | zh | `whisper large` | `whisper turbo` | `把默认模型换成 whisper large，` | `啊不，是 whisper turbo` |
| `e02` | en | `voice.service.ts` | `voice.routes.ts` | `Update voice.service.ts,` | `no wait, it should be voice.routes.ts` |
| `e08` | en | `whisper large` | `whisper turbo` | `Switch the default model to whisper large,` | `no, whisper turbo` |

切点由构造给出（在更正标记处），不是检测出来的：段 1 以更正标记（`嗯不对` / `啊不` / `no wait` / `no,`）
之前为界。TTS 用 `tools/tts.mjs`（edge-tts，**不产生 API 费用**），各半句分别合成 16 kHz 单声道。

三种停顿 P ∈ {2, 5, 10} 秒。同一份音频配两种做法：

- **整段**（`whole`）：`concat(段1, 静音(P), 段2)` 作为**一个**请求。
- **切开**（`split`）：段 1、段 2 分别作为**两个**请求（不含注入静音），识别后按序用「。」拼接成重组文本。

重复：每种（脚本 × P × 做法）**5 次**。重复之间输入逐字节相同，量的是模型的逐次抖动。

## 2. 主指标 `resolved`（二值，先登记后取数）

对每格输出的一条**重组文本**计算（`whole` 就是那条转写；`split` 是两段转写的拼接）：

1. 归一化：转小写，删去所有非 `[a-z0-9]` 字符（于是 `voice.service.ts`、`voice-routes.ts`、
   `voiceRoutes.ts`、`voice routes.ts` 都归到 `voiceroutes`+`ts`）。
2. `mentionsA` = 归一化文本**包含**归一化的 A（更正前目标）。
3. `mentionsB` = 归一化文本**包含**归一化的 B（更正后目标）。
4. **`resolved` = `mentionsB && !mentionsA`。**

口径说明（登记）：`resolved` 要求**更正前的目标不作为指令对象出现**。这与 proposal 对切开代价的描述一致
——「两段各自完整，但跨段的更正没有被解决」：切成两段后第一段就是一条 `改一下 A` 的指令，A 会作为指令对象
出现在重组文本里，故 `resolved=false`。仅用「包含 B」是不够的（切开的两段通常都含 B），必须同时排除 A。

标识符匹配用**归一化后的完整标识符**（不是单个词干），因此 `voiceRoutes.ts`（模型把驼峰保留、去掉了点）
仍算命中 B，而 `verse-roots.ts` 不算（它归一化成 `verseroots`，不含 `voiceroutests`）。

每格 `resolvedRate` = 命中数 / n，n = 4 脚本 × 5 重复 = **20**。置信区间用 Wilson 95%
（口径与 `experiments/voice-vad/metrics.mjs#wilsonInterval` 一致；本工装自带同式实现）。

## 3. 取样网格

| 轴 | 档 | 说明 |
|---|---|---|
| 脚本 | `d02` / `d08` / `e02` / `e08` | 两条中文、两条英文；每条一次自我更正 |
| 停顿 P（秒） | 2 / 5 / 10 | 覆盖 `flushSilenceSec` 候选与它两侧 |
| 做法 | `whole` / `split` | 配对：同一份音频的两种发送方式 |

4 × 3 × 2 = **24 格**，每格 n=20，缺格数必须为 **0**。

## 4. 判定规则与容差（登记值，作为选参依据）

- `tolerance = 0.15`（绝对）：切开的 `resolvedRate` 允许比整段的低至多 15 个百分点。
- **选参规则**：在满足 `splitRate(P) ≥ wholeRate(P) − tolerance` 的 P 中取**最小**的 P，作为推荐
  `flushSilenceSec`。
- **回退（若无 P 满足）**：取 `GAP(P) = wholeRate(P) − splitRate(P)` 最小的 P；**并列时取更大的 P**
  （更晚 flush ⇒ 更少误切 ⇒ 对自我更正更保守；这条与「并列取更小延迟」的直觉相反，理由是本实验要保的
  量是更正不被切开，延迟是次要项）。并在结果记录里明确标「无 P 落在容差内」。
- 容差**不在看到数据后放宽**。一旦放宽，登记作废。

## 5. 负对照（取数之前登记；不红则整份作废）

- 变体：`--variant=swap-order`。对**整段**条件的音频，把两半句的**顺序对调**（先放段 2、再静音 P、再段 1），
  交给同一个出货适配器识别。这是需**真实调用**的变体（离线不可从既有转写推出）。
- 预测方向：整段的 pooled `resolvedRate` **下降**——顺序对调后模型解出的是「更正前目标」的那条指令。
- 判红条件：`pooledSwap ≤ pooledWhole − negativeControlMinDrop`，且 `pooledSwap ≤ negativeControlResolvedCeiling`，
  且真实整段的 `pooledWhole ≥ realResolvedFloor`。登记值：
  - `negativeControlMinDrop = 0.3`（绝对）
  - `negativeControlResolvedCeiling = 0.25`
  - `realResolvedFloor = 0.5`
- `node experiments/voice-vad/pause-split.mjs --offline --variant=swap-order` 只有在上述三条同时成立时打印
  「负对照红」并退出 0；否则非 0 退出（量具不敏感 ⇒ 整份记录作废重做）。

## 6. 预算闸（硬上限 `budgetCny = 1.0` 元）

- 单价（人 yale 于 2026-10-04 从控制台给出，写入 `experiments/voice-vad/pricing.json`）：输入 0.8 元/百万
  token、输出 2.7 元/百万 token。缺失、占位（非数或 ≤0）单价 → 立即中止并**指名**原因；worker 不得猜测。
- 最坏情形按每次 `worstTokensPerCall = 1024` 个输出 token 计（短片段；实测 completion ~112、reasoning ~83，
  1024 是约 10× 冗余，覆盖 reasoning 抖动）。计划调用数 = `whole` 60 + `split` 120 + `swapWhole` 60 = **240**。
  最坏 = 240 × 1024 × 2.7 / 1e6 = **¥0.663 ≤ 1.0**。
- `--dry-run`：①缺 `pricing.json` ②单价为占位值 ③预估最坏花费 > `budgetCny` 三种情形均以非 0 退出并指名
  原因；合法单价下打印「预估最坏花费」且退出码 0。
- **累计闸**：真实/假 provider 逐次调用，一旦累计花费**超过** `budgetCny`，此后不再发起任何新调用，已产生的
  读数照常落盘。以 `--provider=fake-huge`（每次返回超大 usage）验证：断言累计越线后调用数为 0。
- 快照记录累计 token 与按单价折算的实际花费，实际花费必须 ≤ 1.0 元。

## 7. 边界（不做）

不改切段规则本身；不做跨段上下文传递（provider 的 `honors.context=false`）；不评估其他类型脚本
（标识符、数字等）；不把音频原文放进仓库（只放聚合数字，音频在 `experiments/voice-vad/out/`，被 `.gitignore` 的 `out/` 覆盖）。
n 很小，结论首句必须标「**仅方向**」。

## 8. 结果去向

- 冻结快照：`experiments/voice-vad/fixtures/pause-split.json`（存每次调用的 usage、花费、转写原文，
  离线可重算全部读数）。
- 结果记录：`docs/experiments/2026-10-04-voice-pause-split.md`，首句标「仅方向」，给出推荐
  `flushSilenceSec` 与依据格、n、CI、未解释项。
- 推荐值回写：`src/modules/chat/utils/voiceLiveSegmenter.ts` 的 `DEFAULT_FLUSH_SILENCE_SEC`。
