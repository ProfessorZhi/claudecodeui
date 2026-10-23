# 2026-10-04 · VAD 切分参数：T1 合成真值扫描 + T2 真人标注 + T4 小样本确认

任务：`gap-voice-long-form-eval-prereg`。预注册： [`experiments/voice-vad/PREREG.md`](../../experiments/voice-vad/PREREG.md)（**先于取数提交**）。
冻结快照： [`experiments/voice-vad/fixtures/sweep.json`](../../experiments/voice-vad/fixtures/sweep.json)。
工装： [`experiments/voice-vad/run.mjs`](../../experiments/voice-vad/run.mjs)（本任务新增 `--sweep` / `--recognition`），
真值/指标： `timeline.mjs` / `metrics.mjs`（`gap-voice-vad-truth-harness` 交付，未复制算法）。
出货被测实现： `src/shared/voiceEndpoint.ts` 的 `StreamingVad`（id 不复制、算法不复制）。

**结论首句（仅方向）**：在 675 条合成真人语音时间线（T1，单因素扫描）与 489 段 CORAAL 人工标注（T2）上，
推荐初值 **`endpointMs = 400`、`maxSegmentSec = 60`**。T4 的识别读数本次来自**离线 fixture 识别器**、
**未对真实服务运行**，故本记录的一切识别结论**只作方向**，见「T4 确认」一节。

---

## 协议合规（`docs/experiments/README.md` 的八条）

1. **配对比较，不跨运行。** 同一轴内各档用**相同种子** ⇒ 同一批音频，唯一变的是那个参数；每条读数旁打印 `n`。
2. **有能红的负对照**，预测**取数之前**写在 PREREG §4：`cut-mid-sentence` 把每条真值句中点强制切一刀，
   `oversegRate`（一句被检出切成 ≥2 段）必须由真实读数（endpointMs 轴 pooled 0.0229）升到 ≥ 0.5。实测 **1.0000**，红。
3. **被测实现是出货模块**：`run.mjs` 直接 `import { StreamingVad } from '../../src/shared/voiceEndpoint.ts'`，
   id 不含第二份算法。
4. **指标自测**：`scripts/voice-vad-harness.test.mjs` 的四个假检测器仍全绿（本任务未改 `metrics.mjs`）。
5. **不拿参考文本当标点真值**：T1/T2 的指标只对**时间区间**计算，与文本无关。
6. **口径写清楚**：本记录的「中途切率」有两个口径，见下 §1 表与 §2；不混用。
7. **串行执行**：T1/T2 是本地 CPU；T4 本次无真实请求。
8. **结果落盘**：原始读数冻在 `fixtures/sweep.json`，本记录全部由它离线重算。

---

## 1. T1：合成真值单因素扫描（`--sweep`）

网格：`endpointMs` 5 档 × `maxSegmentSec` 4 档 × `noise` 6 档 = **15 格，每格 45 条，共 675 条时间线**
（≥ 600，每格 ≥ 40，缺格 0）。每格的样本数与 Wilson 95% 置信区间写在快照 `cells_summary`。

指标口径（先登记）：
- `oversegRate`：真值句被 **≥2 个**检出段相交的占比 —— **端点轴选参与负对照的主指标**（「一句被切成多段」）。
- `midCutRate`：有**非强制**检出边界（**含覆盖该句的那个检出段自己的起止**）严格落在句内的真值句占比 —— **次要读数**。
  它随端点不明显（一个覆盖句子的段的起止本就落在句内），故**不用于选参**，登记下界放宽到 0.35。
- `startDeviationP95`：每句最佳重叠段起点与真值起点的绝对偏差 p95（先每时间线取 p95 再取中位数）。
- `falseAlarmSecPerHour`、`maxSegmentViolations`、强制切数（`forcedCuts`）同 `metrics.mjs` 口径。

### endpointMs 轴（`maxSegmentSec`=30，clean，mixed 间隔族，n=45，truth=315）

| endpointMs | miss | overseg [95% CI] | midCut | startDev p95 | maxSegViol | forcedCuts |
|---|---|---|---|---|---|---|
| 400 | 0.0000 | **0.0444** [0.0267, 0.0732] | 0.1841 | **0.1384** | 0 | 2 |
| 600 | 0.0000 | 0.0190 [0.0088, 0.0409] | 0.1841 | 0.1399 | 0 | 2 |
| 800 | 0.0000 | 0.0095 [0.0032, 0.0276] | 0.1841 | 3.7224 | 0 | 3 |
| 1200 | 0.0000 | 0.0127 [0.0049, 0.0322] | 0.1683 | 9.7780 | 0 | 4 |
| 1600 | 0.0000 | 0.0286 [0.0151, 0.0534] | 0.1429 | 14.2654 | 0 | 9 |

读法：`oversegRate` 随端点先降后升（U 形），`startDeviationP95` 从 800 ms 起暴涨——端点 ≥800 ms 会把一个普通
停顿（0.6–0.8 s）两侧的句子并成一段，覆盖开头那句的段起点就离后面每句的真值起点很远。400 与 600 都满足
`miss ≤ 0.02`、`overseg ≤ 0.05`、`startDev ≤ 0.3`，登记规则取**最小**的 ⇒ **400**。

### maxSegmentSec 轴（`endpointMs`=800，clean，nonstop 间隔族，n=45，truth=407）

| maxSegmentSec | miss | overseg | startDev p95 | maxSegViol | forcedCuts |
|---|---|---|---|---|---|
| 10 | 0.0000 | 0.4226 | 6.53 | 0 | 199 |
| 20 | 0.0000 | 0.1646 | 10.03 | 0 | 56 |
| 30 | 0.0000 | 0.0885 | 16.52 | 0 | 25 |
| 60 | 0.0000 | 0.0270 | 19.08 | 0 | **0** |

读法：无真停顿族里所有档 `maxSegmentViolations = 0`（检出器按各自天花板强制切）；天花板越大强制切越少
（60 s 档 0 刀 vs 10 s 档 199 刀）。登记规则取**零违反中最大**的档 ⇒ **60**。16 kHz 单声道 60 s ≈ 1.9 MB，
远低于 provider 单请求上限。**上限到 60 s 为止是本扫描的边界，最优可能在 60 以外**（见局限）。

### noise 轴（`endpointMs`=800，`maxSegmentSec`=30，mixed 间隔族，n=45，truth=315）

| noise | miss | overseg | startDev p95 | falseAlarm/hr |
|---|---|---|---|---|
| snr30 | 0.0000 | 0.0190 | 0.4473 | 136.2 |
| snr20 | 0.0000 | 0.0381 | 0.4729 | 297.2 |
| snr15 | 0.0000 | 0.0571 | 4.9233 | 735.2 |
| snr10 | 0.0000 | 0.1016 | 12.9711 | 1572.8 |
| snr5 | 0.0032 | 0.1619 | 16.9527 | 2197.1 |
| floor(−50 dBFS) | 0.0000 | 0.0254 | 0.4542 | 153.5 |

读法：注入噪声只铺在**空隙**里（见 run.mjs 的 limitations），故这些格读的是「噪声时间去误触发」，
不是「带噪语音上的检测」。噪声越强，误触发与合并越重；漏检只在 snr5 出现（0.32%，CI 上界 1.8%，仍 ≤ 2%）。

## 2. 推荐值与依据

登记规则（PREREG §3，机械应用于快照 `recommendation` 字段）：

- **`endpointMs = 400`**：满足 `miss ≤ 0.02`、`overseg ≤ 0.05`、`startDevP95 ≤ 0.3` 的**最小**档。
  依据样本组：endpointMs 轴 400 档，n=45 时间线 / 315 句，overseg 0.0444 [0.0267, 0.0732]，startDevP95 0.1384。
- **`maxSegmentSec = 60`**：零 `maxSegmentViolations` 中**最大**的档（强制切最少）。
  依据样本组：maxSegmentSec 轴 60 档，n=45 时间线 / 407 句，viol 0，forcedCuts 0。

回写：`src/shared/voiceEndpoint.ts` 的 `DEFAULT_ENDPOINT_MS = 400`、`DEFAULT_MAX_SEGMENT_SEC = 60` 与之一致
（两处数值相同）。

## 3. 负对照（`--variant=cut-mid-sentence`）

命令：`node experiments/voice-vad/run.mjs --sweep --offline --variant=cut-mid-sentence`（退出 0）。
读数子集：endpointMs 轴（干净、mixed）——真实与变体读**同一子集**（配对）。

| | pooled oversegRate | 判定 |
|---|---|---|
| 真实 | 0.0229 | ≤ 0.05（绿） |
| cut-mid-sentence | **1.0000** | ≥ 0.5（红） |

方向与 PREREG §4 登记一致，输出含「负对照红」。**量具对「切在句中」敏感，记录不作废。**

## 4. T2：CORAAL 人工标注（`--sweep --offline` 的 `t2=coraal` 行）

样本：`DCA_se1_ag3_f_01_1_segments`，**489 段人工时间戳**（≥ 200），总时长 601.2 s。同一套指标、同一口径。

| 读数 | T2（CORAAL） | T1（干净 endpointMs 轴） | 容差 | 判定 |
|---|---|---|---|---|
| missRate | 0.0082 [0.0032, 0.0208] | 0.0000 | ≤ 0.02 | 通过 |
| oversegRate | 0.0511 [0.0349, 0.0744] | 0.0229 | delta ≤ 0.10 | 通过（delta 0.0283） |
| startDeviationP95 | 17.1578 | 0.1384（400 档）/ 4.379（轴中位数） | ratio ≤ 3 | **超出** |
| falseAlarm/hr | 0.00 | 337.2（T1，含空隙噪声） | — | 见下 |

**未解释项（超出 PREREG 容差，不静默放过）：**

1. **T2 起点偏差 p95 = 17.16 s，远大于 T1 干净读数。** 对 400 档（0.138 s）是 124×，对轴中位数（4.38 s）是 3.9×，
   两者都超过登记的 3× 容差。最可能的原因：CORAAL 的标注段在访谈里**近于连续**（相邻段间隔常小于 800 ms 端点），
   检出器把多个人工段并成一段，于是靠后的句子的「最佳重叠段」起点落在很前面。这既可能是检出器在即兴连续语音上
   真的欠切，也可能是 T2 的合成床（段落铺在静音上、相邻段无真静音）使然——**本次无法区分**，故列为未解释项。
2. **T2 过切率 0.0511 略高于绝对下界 0.05**（对 T1 的 delta 0.0283 在 0.10 容差内）。CI 下界 0.0349，点估计刚越线；
   同 1 的合并机制。

T2 的方向性结论：漏检与过切在即兴语音上量级与 T1 相当（均在容差内），**方向不变**；起点偏差一项在 CORAAL 上
不成立，已如实列为未解释项。

## 5. T4 确认（**仅确认，不选参**；本次未对真实服务运行）

计划（≤ 12 次、n ≤ 5）：长样本 L1–L4（n=4，含 3 条 > 60 s）—— 整段识别 vs 切段识别各 1 次 × 4 = 8 次，
再取前 2 条比较 16 kHz 与 48 kHz 上传 = 2 次，合计 **10 次**。

**本次运行**：`pricing.json` 是**占位模板**（单价需人从控制台填入，worker 不得猜测），且离线环境无对应服务凭据，
故**未对真实服务发起任何调用**。冻结快照的 `recognition` 组来自**确定性离线 fixture 识别器**
（`provider: "fixture"`，只验证**预算闸 / 记账 / 标识符轴**，不验证真实识别质量）：

| 读数 | 值 |
|---|---|
| 调用数 | 10（≤ 12） |
| 样本数 n | 4（< 5） |
| 累计 token | 输入 16185、输出 1657、合计 17842 |
| 按单价折算花费 | **¥0.019499** ≤ `budgetCny` = ¥2.0 |
| 最坏花费估计 | ¥0.06（10 次 × 3000 token × ¥2/M 测试单价，打印「预估最坏花费」） |

识别读数（L_G 轴，**只作确认**）：标识符存活率 整段 17/17、切段 17/17、48k 整段 9/9；句读标记数 整段 88、
切段 88、48k 46。**整段与切段的读数完全相同**——这正说明 fixture 根本不建模声学损伤，**它的读数是方向的**：
它只能证明「切段臂的标识符/句读统计通路接通」，**不能**用它回答「切点是否伤了识别」。

**为什么识别读数不能用来选参**（proposal 依据 §3 的实测）：同类输入同一服务的 reasoning token 从 77 到 2328，
d02 的裁剪臂总量反而是不裁臂的 2.7 倍；识别读数的噪声远大于切分参数带来的音频节省。故 T4 只在参数已由 T1–T2
选定之后作确认。

**预算闸证据**（均可离线复算）：

- `--recognition --dry-run` 三情形均非 0 退出并指名原因：①缺文件（`--pricing /nonexistent.json`）②占位单价（默认
  `pricing.json`）③预估超预算（合法单价 + `--price-output 100` ⇒ ¥3.0 > ¥2）；合法单价 + ≤12 次 ⇒ 打印
  「预估最坏花费」退出 0。
- **累计闸**（`--provider=fake-huge`，每次返回超大 usage）：第 1 次调用后累计 ¥6 越过 `budgetCny`，其后再无新调用
  （断言通过，已有读数照常落盘）。

**真实服务的 T4 待人工执行**：填入 `pricing.json` 的真实单价并配置该服务凭据后运行
`node experiments/voice-vad/run.mjs --recognition --pricing experiments/voice-vad/pricing.json`。届时把真实读数补进本节，
并据实更新结论首句的「仅方向」。

## 6. 局限

- 时间线是**合成**的：一句 = 一个 LibriSpeech 片段，真值是**构造**出来的；句内停顿未标注，故「过切」按句计不按词计。
- 噪声**只铺在空隙**里：噪声格读的是误触发，不是带噪语音上的检测。
- `maxSegmentSec` 轴上限 60 s，最优可能在 60 以外。
- T2 的床是**静音**、相邻人工段可能无真静音，起点偏差一项在 CORAAL 上的成因未定（未解释项 1）。
- T4 本次是 fixture，真实识别确认**未做**；一切识别结论**仅方向**。

## 7. 复算命令（不联网、不用凭据）

```bash
# T1 冻结快照的全量读数（退出 0）
node experiments/voice-vad/run.mjs --sweep --offline
# 负对照：中途切率变红、输出「负对照红」（退出 0）
node experiments/voice-vad/run.mjs --sweep --offline --variant=cut-mid-sentence
# 预算闸 dry-run（缺文件 / 占位单价 / 超预算 ⇒ 非 0；合法单价 ⇒ 打印「预估最坏花费」退出 0）
node experiments/voice-vad/run.mjs --recognition --dry-run --pricing experiments/voice-vad/pricing.json
node experiments/voice-vad/run.mjs --recognition --dry-run --pricing experiments/voice-vad/fixtures/pricing.test.json
node experiments/voice-vad/run.mjs --recognition --dry-run --pricing experiments/voice-vad/fixtures/pricing.test.json --price-output 100
# 累计闸（假 provider 每次超大 usage，断言超预算后再无新调用）
node experiments/voice-vad/run.mjs --recognition --provider=fake-huge --pricing experiments/voice-vad/fixtures/pricing.test.json --out /tmp/vad-gate.json
# 重新生成冻结快照（需要国库外的 LibriSpeech/CORAAL/long 语料与 ffmpeg）
VAD_SWEEP_REPLICAS=45 node experiments/voice-vad/run.mjs --sweep --pricing experiments/voice-vad/fixtures/pricing.test.json
```
