---
id: gap-voice-vad-truth-harness
title: VAD 真值度量 harness：真人单句合成时间线 + 精确真值 + 边界/漏检/过切/中途切指标（本地、无网络、可大批量）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md`「验证梯度」T1–T2。本条是 VAD 的**度量工具**，不改任何运行时代码；与 `experiments/voice-trim`（裁剪省多少秒、识别代价）不重叠：那条以识别为判据，本条以时间区间真值为判据，完全不调用识别。**全程本地 CPU，零费用。**

### 现状与缺口

VAD 好不好今天只有两种读数：段数（无真值，无法区分「切对了」与「切碎了」）和识别结果（付费、慢、同类输入的 reasoning token 差几十倍，且无法归因到切点）。切分判定本质上是一个时间区间问题，应当用**时间区间真值**度量：真值由构造给出，不靠识别。仓库外已有现成的低成本语料：LibriSpeech dev-clean 2703 条真人单句（`/data/home/yale/work/tc-verify/corpus/public/LibriSpeech/dev-clean`，每个文件天然是一句，句边界即文件边界）与 CORAAL 即兴访谈 490 段（`corpus/spontaneous/*_segments/`，文件名带人工给出的起止时间）。

### 方案

1. `experiments/voice-vad/timeline.mjs`：按种子把真人单句随机拼成长时间线（每条约 8 句），句间间隔取自一族分布（0.15 s–45 s，含长尾）；可叠加噪声（复用 `tc-verify/tools/noise.mjs`，按 SNR 5–30 dB 与 −50 dBFS 房间底噪）、整体增益、前后留白。输出样本与**精确真值**（每句 [起, 止] 秒）。同一种子逐字节可复现，因此可做配对比较：只改一个参数，其余相同。
2. `experiments/voice-vad/metrics.mjs`：对「检测器产出的事件/段」与真值计算：起点/终点偏差的 p50/p95；漏检率（真值句没有任何事件）；误触发数/小时静音；过切率（一句被切成多段的比例）；**中途切率**（切点落在真值语音区间内的比例，强制切除外）；`maxSegmentSec` 违反数；强制切点的能量排名；各比率的置信区间。
3. 检测器是一个接口：`(samples, sampleRate) → 段边界[]`。本任务只接**现行** `trimVoiceAudio` 的 `vadSegments`，产出**基线读数**；后续流式 VAD 实现同一接口接入。
4. `experiments/voice-vad/run.mjs`：按**单因素扫描**（一次只动一个因素，其余取默认，不做全组合）跑检测器，输出冻结快照 `fixtures/baseline.json`；`--offline` 从快照重算全部读数。
5. T2 读取器：把 CORAAL 段按文件名时间戳还原为带人工区间真值的时间线，同一套指标。

### 边界（不做）

不调用任何识别服务、不需要任何凭据与网络；不改 `voiceTrim.ts` 或任何运行时代码；不做 UI；不做全组合扫描。

## AC

- [x] `node --test scripts/voice-vad-harness.test.mjs` 退出码 0
- [x] 确定性：同一种子两次生成的时间线样本逐字节相同、真值区间完全相同（测试里比较哈希）
- [x] 真值精确：对任一生成的时间线，真值区间互不重叠、按时间递增，每个区间内的样本与对应源句逐样本相同，区间之外的样本是静音或叠加的噪声（测试里逐区间核对）
- [x] 指标自检（取假形态，每个必须使对应指标变红）：①检测器恒返回「全是语音」→ 误触发/小时静音大幅上升；②恒返回「无语音」→ 漏检率为 1；③把真实检测结果整体平移 0.5 s → 起点偏差 p50 ≥ 0.5 s；④在每句中点处强行加一个切点 → 中途切率为 1
- [x] `node experiments/voice-vad/run.mjs --offline` 退出码 0，从冻结快照重算全部读数；快照里对现行 `trimVoiceAudio` 的基线读数覆盖 ≥ 600 条时间线（单因素扫描，每格 ≥ 40 条），缺格数为 0
- [x] 语料缺失时 harness 必须指名缺失的路径并以非 0 退出，不得静默跳过或改用更小的样本集
- [x] 全程无网络：测试运行期间设置 `NO_NETWORK` 守卫使任何 `fetch`/`http` 调用抛错，仍通过
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是「指标函数能算出数」，而是**一个真实检测器**（现行 `trimVoiceAudio`）的基线读数落了快照，并且量具对「检测器变差」敏感——四个取假形态都能让对应指标变红。基线读数里**如实记录**现行 VAD 的已知弱点（例如本轮已测得 `corpus/long/L4` 无真停顿时整段 126.6 s 只会成一个请求），不为让表格好看而回避。局限写进记录：LibriSpeech 是朗读，句内停顿没有标注，所以「过切」按句计不按词计；句间间隔由我们注入而不是取自语料。

L_D 该轴有读数：现行 VAD 在合成真人语音上的边界偏差、漏检、误触发基线，由快照给出。

L_G 该轴仍暗，理由：本任务不产出生成质量轴读数。

## Touches

- experiments/voice-vad/timeline.mjs (new)
- experiments/voice-vad/metrics.mjs (new)
- experiments/voice-vad/run.mjs (new)
- experiments/voice-vad/fixtures/baseline.json (new)
- scripts/voice-vad-harness.test.mjs (new)
- tasks/gap-voice-vad-truth-harness.md
