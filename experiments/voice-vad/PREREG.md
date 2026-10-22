# VAD 切分参数：预注册（T1 合成真值扫描 + T2 真人标注 + T4 识别确认）

状态：**本文件先于取数提交**。判据：`git log --diff-filter=A --format=%ct` 读到的本文件首次提交时间，
早于 `experiments/voice-vad/fixtures/sweep.json` 的首次提交时间。若把这份登记往回调、或先取数后补登记，
整份记录作废。

来源与分工：`docs/proposals/voice-continuous-capture-vad-segmentation.md`「验证梯度」。
**不与** `experiments/voice-dashscope-omni-paired-quality`（那条比 provider/裁剪，用识别读数）重复：
本条选的是 **VAD 的切分参数**（`endpointMs`、`maxSegmentSec`），参数由**本地、无网络、零费用**的
真值扫描选定；识别只在最后用极少量样本确认切点没伤到识别，不参与选参，且受硬预算约束（≤ 人民币 2 元）。

度量的量具是 `experiments/voice-vad/run.mjs`（`gap-voice-vad-truth-harness` 交付，本任务扩展出
`--sweep` / `--recognition`），真值来自 `timeline.mjs` 的构造（T1）与 CORAAL 的人工时间戳（T2）。
出货被测实现是 `src/shared/voiceEndpoint.ts` 的 `StreamingVad`，id 不复制、算法不复制。

---

## 1. 主指标（全部对真值区间计算，先登记后取数）

| 指标 | 定义 | 用途 |
|---|---|---|
| `missRate` | 真值句没有任何检出段与其相交的条数占比 | 漏检上界 |
| `startDeviationP95` / `endDeviationP95` | 每句最佳重叠段的边界与真值边界的绝对偏差的 p95（先每时间线取 p95，再取中位数） | 边界精度 |
| `falseAlarmSecPerHour` | 检出语音落在所有真值区间之外的秒数 / 时间线静音时长 × 3600 | 误触发 |
| `oversegRate` | 被 ≥2 个检出段相交的真值句占比（**端点轴选参与负对照的主指标**：一句被切成多段） | 过切 / 中途切 |
| `midCutRate` | 有**非强制**检出边界（含覆盖该句的那个检出段自己的起止）严格落在其内部的真值句占比 | 次要读数（见下方口径说明） |

**口径说明（先登记）**：`midCutRate` 按 `metrics.mjs#computeMetrics` 的定义，会把**覆盖该句的检出段自己的起止**也算作「内部边界」——检出起点比真值晚、或终点落在句内，都会被计入。因此它随端点变化不明显，只作次要读数（宽松下界 0.35），**不用于选参**。选参与负对照用 `oversegRate`：一句被检出切成 ≥2 段，才是「切在句中」的可操作定义。
| `maxSegmentViolations` | 长于该格 `maxSegmentSec` 的检出段数 | 段长上界（`maxSegmentSec` 轴主指标） |
| 强制切能量排名 | 每个强制切点的帧能量是否 ≤ 其尾随 2 s 窗中位数 | 强制切点是否落在低谷 |

置信区间：比率用 Wilson 95%（`metrics.mjs#wilsonInterval`）。**每格的样本数与 CI 写进快照**
（`cells_summary`），离线重算的读数必须与冻结时一致。

## 2. 取样网格（单因素，一次只动一个参数，其余取默认）

默认：`endpointMs` 800 ms、`maxSegmentSec` 30 s、`overlapSec` 0.3 s、`noiseWindowSec` 30 s。

| 轴 | 档 | 固定其余 | 说明 |
|---|---|---|---|
| `endpointMs` | 400 / 600 / 800 / 1200 / 1600 ms | `maxSegmentSec`=30, `noise`=clean, 语句间隔族=mixed | 端点越长，句中切越少、但合句越多 |
| `maxSegmentSec` | 10 / 20 / 30 / 60 s | `endpointMs`=800, `noise`=clean, 间隔族=nonstop | 只在无真停顿的时间线上有意义 |
| `noise` | SNR 30/20/15/10/5 dB 与 −50 dBFS 房间底噪 | `endpointMs`=800, `maxSegmentSec`=30, 间隔族=mixed | 噪声只在**空隙**里铺（见 run.mjs 的 limitations） |

**每格 ≥ 40 条时间线**，取 45；共 15 格 ⇒ **675 条时间线**（≥ 600）。同一轴内各档使用**相同种子**，
所以配对比较的是**同一批音频**，唯一变的是那个参数。

## 3. 判定规则与容差（登记值，作为选参依据）

- 漏检上界 `missRateMax = 0.02`。零漏检下 95% 置信的样本量下限 150 句（三法则 3/n）；每格 ≥ 320 句
  远高于它，故 675 条已足够。
- 起点偏差上界 `startDeviationP95Max = 0.3 s`（在注入间隔 ≥ `endpointMs`+0.3 s、且无注入噪声的子集上）。
- 过切（中途切）上界 `oversegRateMax = 0.05`；`midCutRateMax = 0.35`（次要读数的宽松下界）。
- **`endpointMs` 选参规则**（登记）：在 pooled `missRate ≤ 0.02`、`oversegRate ≤ 0.05`、
  `startDeviationP95 ≤ 0.3` 三者同时成立的档中取**最小**的 `endpointMs`（端点越早、延迟越低）；
  若无档同时成立，取 `oversegRate` 最低者（并列取更小端点）。
- **`maxSegmentSec` 选参规则**（登记）：在无真停顿族上 `maxSegmentViolations = 0` 的档中取**最大**的
  `maxSegmentSec`（强制切最少，16 kHz 上传仍远低于 provider 单请求上限）；若无档零违反，取违反数最少者
  （并列取更大档）。
- 上表容差**不在看到数据后放宽**。一旦放宽，登记作废。

## 4. 负对照（取数之前登记；不红则整份作废）

- 变体：`--variant=cut-mid-sentence` —— 在每条真值句的**中点**强制插入一个切点（其余一切照旧）。
- 读数子集：**endpointMs 轴**（干净、mixed 间隔族）上的 pooled 过切率；真实与变体读同一子集（配对）。
  噪声轴与 maxSegmentSec 轴的过切率是另一回事，不参与这条对照。
- 预测方向：`oversegRate` **上升**。判红下限 `negativeControlOversegFloor = 0.5`：变体的 pooled 过切率
  必须 ≥ 0.5，且严格高于真实读数，且真实读数仍 ≤ `oversegRateMax`。
- 若变体**没有**按此方向变红，则量具对「切在句中」不敏感，**整份记录作废重做**（run.mjs 打印
  `负对照红` 且退出 0 才算通过；否则非零退出）。

## 5. T2（CORAAL 人工标注段）

- 样本：`corpus/spontaneous/DCA_se1_ag3_f_01_1_segments`，490 段人工时间戳（≥ 200 段）。
- 同指标、同口径重复一次。**方向一致性容差**（登记）：CORAAL 的 `startDeviationP95` 不得超过 T1
  干净子集读数的 `t2StartDeviationRatioMax = 3` 倍；CORAAL 的 pooled 过切率不得超过 T1 同族读数
  `t2OversegDeltaMax = 0.1`（绝对）。
- 超出容差的格/读数**全部**列入结果记录的「未解释项」，不静默放过；T2 精度粗于 T1（人工标注），只用于
  确认方向不变。

## 6. T4（识别确认，付费，硬预算闸）

- 样本 ≤ 5 条（取长样本 L1–L4，共 4 条，含 > 60 s），调用 ≤ 12 次：整段 vs 切段各 1 次 × 4 条 = 8；
  再取前 2 条比较 16 kHz 与 48 kHz 上传 = 2；合计 **10 次**。
- 硬上限 `budgetCny = 2.0` 元。最坏情形按每次 `t4WorstTokensPerCall = 3000` token、全部按输出单价计：
  12 × 3000 = 3.6 万 token；输出单价 ≤ 55 元/百万 token 时上限 ≤ 1.98 元。
- **单价不在仓库里**：`experiments/voice-vad/pricing.json` 是**占位模板**，由人从控制台填入；
  worker 不得猜测。缺文件、单价为占位值、预估超预算、累计超预算——**任一情形立即中止**，已产生的读数
  照常落盘。
- 识别读数**只作确认**，不用来比较两个相近的参数：本轮实测同类输入的 reasoning token 波动 77–2328，
  远大于音频节省，识别读数噪声太大（见 proposal 依据 §3）。
- 本任务在离线环境执行：`pricing.json` 未由人填价，故 T4 对**真实服务**的运行**未做**，冻结快照的
  `recognition` 组来自**确定性离线 fixture 识别器**（只验证预算闸/记账/标识符轴，不验证真实识别质量），
  结果记录须如实写明并首句标「仅方向」。真实服务的 T4 留给人工在填价后执行。

## 7. 结果去向

- 冻结快照：`experiments/voice-vad/fixtures/sweep.json`。
- 结果记录：`docs/experiments/2026-10-04-voice-vad-sweep.md`，给出 `endpointMs` / `maxSegmentSec` 的
  推荐初值与依据的样本组、n、CI、未解释项。
- 推荐值回写：只改 `src/shared/voiceEndpoint.ts` 里的默认常量（不改其它运行时代码）。
