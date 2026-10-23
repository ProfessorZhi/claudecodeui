# 停顿切开对自我更正的影响（`flushSilenceSec` 选参）

**仅方向**：n 很小（4 条合成脚本 × 3 个停顿 = 24 格，每格 n=20），下面的比率只作方向，不作精确率。

**结论（一句话）**：把一段自我更正**在停顿处切成两个请求**，更正就**不再被解出**——在被测的 2 / 5 /
10 秒三个停顿上，切开的 `resolved` 率都是 **0/60 = 0.000（Wilson 95% [0.000, 0.060]）**，而整段发送
是 **60/60 = 1.000（95% [0.940, 1.000]）**。三个停顿上两者的差都是满格（GAP = 1.000），**没有一个停顿
落在登记容差 0.15 内**，于是按预注册的回退规则（取 GAP 最小者，并列取**更大**的 P——更晚 flush ⇒ 更少
误切）推荐 **`flushSilenceSec = 10`**，并已回写
`src/modules/chat/utils/voiceLiveSegmenter.ts` 的 `DEFAULT_FLUSH_SILENCE_SEC`（**5 → 10**）。

选参所依据的格：`P ∈ {2, 5, 10}` 三行 `whole` 与 `split` 的 pooled 读数，见下面的「判据与选参」。
三条中没有任何一条落在容差内，所以推荐值完全由回退规则的**并列取更大 P** 决定，不是某一个 P 的实测优势。

---

## 1. 取数与花费（真实调用，不是 fixture 识别器）

- 识别器：出货的 `dashscope-omni` 适配器，按 PREREG 登记的口径经 `shared/asr/asrRegistry.ts` 的
  `tryResolve('dashscope-omni')` 解析（不是直接 import 那个模块）；请求体由适配器自己的
  `buildChatRequestBody` 构造。模型 `qwen3.8-omni-flash`，端点 `llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com`。
- 音频：`tools/tts.mjs`（edge-tts，免费）合成四条自我更正脚本的**两个半句**，在更正处断成两块，
  中间注入 P 秒静音。块边界与注入位置由构造给出，是精确真值。音频**不提交**（在
  `experiments/voice-vad/out/`，被仓库的 `out/` 忽略）。
- 调用数：`whole` 60 + `split` 120 + `swapWhole` 60 = **240 次**，全部成功，`missingCells = 0`。
- 累计 token：输入 109,745 / 输出 82,047 / 合计 **191,792**。
- **实际花费 ¥0.309323**，按 `pricing.json` 的单价（输入 ¥0.8 / 输出 ¥2.7 每百万 token）折算；
  硬上限 `budgetCny = ¥1.0`，**未越线**（最坏预估 ¥0.6636 也未越线，故 240 次全部走完，没有触发累计闸）。

冻结快照：`experiments/voice-vad/fixtures/pause-split.json`（存每次调用的转写原文、usage、花费，
离线可重算全部读数）。

## 2. 网格与读数

每条脚本是一次自我更正（`改一下 A，嗯不对，应该是 B`），重复 5 次；4 条脚本、3 个停顿、2 种做法。
`resolved = 提到 B（更正后目标）且不把 A（更正前目标）当作指令对象`（归一化后按完整标识符匹配，见 PREREG §2）。
快照里有两层读数：

- **格 = (做法 × 停顿)**，n = 4 脚本 × 5 重复 = **20**，存在快照的 `byPause[condition][pause]`；
  这是选参用的格。
- **按脚本细分**，n = 5，存在快照的 `cells[condition]['<script>|<pause>']`（4 × 3 × 2 = 24 个子格全在）；
  再往上 `pooled[condition]`（n=60）。

| 做法 | 每格（做法 × 停顿）resolved，n=20 | Wilson 95% |
|---|---|---|
| `whole` @ 2s / 5s / 10s | 20/20 = 1.000（三档相同） | [0.8389, 1.0000] |
| `split` @ 2s / 5s / 10s | 0/20 = 0.000（三档相同） | [0.0000, 0.1611] |

- `whole` pooled：**60/60 = 1.000**，Wilson 95% **[0.9398, 1.0000]**。
- `split` pooled：**0/60 = 0.000**，Wilson 95% **[0.0000, 0.0602]**。
- 按脚本细分的子格（n=5，`cells[condition]['<script>|<pause>']`）：`whole` 每格 5/5 → [0.5656, 1.0000]，
  `split` 每格 0/5 → [0.0000, 0.4345]。

按脚本细分（每格 5 次重复）：

| 做法 | d02 2s | d02 5s | d02 10s | d08 2s | d08 5s | d08 10s | e02 2s | e02 5s | e02 10s | e08 2s | e08 5s | e08 10s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `whole` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| `split` | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |

12 个 `split` 子格、12 个 `whole` 子格全在，缺格数 **0**。

读数的样子（P=5，d02，rep 0 的真实转写）：

- `whole`：``改一下 `voice routes.ts`。`` —— 模型跨静音解出了更正，只留 B。
- `split` 前半句：``改一下 `voice-service.ts`。`` —— 独立成一条指令，对象是 A。
- `split` 后半句：``应该是 `voice routes TS`。`` —— B 单独出现，但此时没有可正确的对象。
- 重组：A 句 + B 句，A 作为指令对象出现，故 `resolved = false`。

## 3. 判据与选参（登记值）

- 容差 `tolerance = 0.15`（绝对）。选参规则：在满足 `splitRate(P) ≥ wholeRate(P) − tolerance` 的 P 中取**最小**者。
- P 对照：

  | P | whole（格 n=20） | split（格 n=20） | GAP = whole − split | split ≥ whole − 0.15 ? |
  |---|---|---|---|---|
  | 2 s | 1.000 | 0.000 | 1.000 | 否（0 < 0.85） |
  | 5 s | 1.000 | 0.000 | 1.000 | 否 |
  | 10 s | 1.000 | 0.000 | 1.000 | 否 |

- 三条都不满足 ⇒ 触发登记回退：取 GAP 最小者（三者并列 1.000）⇒ 并列取**更大**的 P ⇒ **P = 10**。
- 推荐 **`flushSilenceSec = 10`**（回退，记录里明确标「无 P 落在容差内」）。容差未在取数后放宽。
- 语义：切开在任何停顿上都丢更正，所以「等更久再 flush」= 更多停顿**不**触发切分 = 更正更可能留在同一
  buffer 里被解出。10 是网格里最保守的一档；网格到 10 秒为止，本记录的结论也止于此。

## 4. 负对照 `--variant=swap-order`（取数前登记；不红则整份作废）

把**整段**音频的两个半句顺序对调（先 B 句、再静音 P、再 A 句），交给同一个出货适配器。
预测：整段的 pooled `resolved` 率**下降**。

- `pooledWhole = 1.000`，`pooledSwap = 13/60 = 0.217`（Wilson 95% [0.131, 0.336]），Δ = **0.783**。
- 判红三条：Δ ≥ 0.3 ✓、swap ≤ 0.25 ✓、whole ≥ 0.5 ✓ ⇒ **负对照红**。量具对「更正是否被解出」敏感。
- `node experiments/voice-vad/pause-split.mjs --offline --variant=swap-order` 退出码 0，输出含「负对照红」。

## 5. 未解释项（保留，不为让表格好看而填数）

1. **负对照的敏感性随脚本变化**：对调顺序后，`d02`（13→…）、`e02`、`e08` 明显回落，但 `d08` 部分
   重复仍解出更正后的目标——尤其 P=10 时 4/5。原因看起来是 d08 的后半句（`啊不，是 whisper turbo`）
   在音频里排在最前，模型听到「是 whisper turbo」后就把它当成结论，前半句的 `换成 whisper large`
   反而成了正文对象。同一条脚本的两个英文/中文版本方向不一致，未进一步追。pooled 仍满足登记的灭活阈值。
2. **reasoning token 波动大**：240 次调用的 reasoning token 从 45 到 2749（均值约 307），
   completion token 从 75 到 2798（均值约 342）。同一输入逐字节相同、只有模型逐次抖动。
   本次花费仍远低于最坏预估（最坏按每次 1024 输出 token 计）。
3. **切开的后半句本身会退化**：例如 `e02` @ 10s 的 split 后半句有一次识别成
   ``把它改成 `voice.ts`。``（B 被吃掉），即切开不仅让 A 变成指令对象，还可能单独损坏 B。这对结论无影响
   （`split` 已全 0），但说明「切开」的代价不止一种。
4. `whole` 与 `split` 在**所有**格上都是满格分离（60/60 vs 0/60），干净得反常；n 很小，仍只作方向。

## 6. 复算

```
node experiments/voice-vad/pause-split.mjs --offline                      # 从冻结快照重算，退出码 0
node experiments/voice-vad/pause-split.mjs --offline --variant=swap-order  # 负对照，退出码 0，含「负对照红」
node experiments/voice-vad/pause-split.mjs --dry-run                       # 预算闸：打印「预估最坏花费」，退出码 0
node experiments/voice-vad/pause-split.mjs --provider=fake-huge            # 累计闸：超大 usage 越线后停发
node experiments/voice-vad/pause-split.mjs --offline --write              # 按冻结 calls 重算派生读数并回写快照
```

离线路径不联网、不用凭据（脚本内 `NO_NETWORK` 守卫把 `fetch` 换成抛错）。生成路径缺凭据时**指名**
缺 `DASHSCOPE_API_KEY` 并非 0 退出，不降级为假 provider。

## 7. 边界（不做）

不改切段规则本身；不做跨段上下文传递（`dashscope-omni` 的 `honors.context = false`）；不评估其他类型
脚本；不提交音频原文。L_D 轴仍暗（本任务只产出实验记录，不新增领域数据能力）；L_G 轴有读数（切开 vs
整段在自我更正上的 `resolved` 率由快照给出）。
