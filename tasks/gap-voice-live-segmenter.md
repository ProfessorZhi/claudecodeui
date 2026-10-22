---
id: gap-voice-live-segmenter
title: 连续语音切段器：worklet 转发 PCM + 缓冲 + 按停顿切段（最小段长 30 s、过滤长静音），纯函数、可用真值度量
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md`。`gap-voice-streaming-vad-endpointing`（已 done）交付了流式 VAD，`gap-voice-segment-pipeline`（已 done）交付了并发/重试/拼回；本条补上它们之间**缺失的一环**：把实时 PCM 按 VAD 事件切成可发送的段。**只面向 `dashscope-omni`**（按 token 计费，无请求计费下限），Groq 的 10 秒下限不在本任务范围。

### 现状与缺口

`voiceFrameProcessor.ts` 现在只向主线程发 `frame`（rms）、`event`、`segments` 三类消息，**不发音频本身**；`useVoiceInput.ts` 把事件仅当作 `voiceDebug` 控制台读数。没有任何代码把 PCM 缓冲起来、按事件时刻切出一段、降到 16 kHz 并编码成可上传的 WAV。`runSegmentPipeline` 没有任何非测试调用方。

成本事实决定了切法（本轮 6 次真实调用实测）：每个 omni 请求带 **407 个固定的提示词文本 token**，音频约 7 token/秒，所以一次请求的固定开销约等于 58 秒音频。段切得越碎越贵，**切分的目标是「尽量长」而不是「尽量细」**。

### 方案

1. `voiceFrameProcessor.ts`：新增一类消息 `{ type: 'pcm', samples: Float32Array, atSample }`，以 transferable 转发每个 20 ms 帧的原始样本；既有三类消息不变。
2. 新增纯模块 `src/modules/chat/utils/voiceLiveSegmenter.ts`（**只用相对路径导入**，使 node 里的 harness 也能加载它）：
   - 输入：PCM 帧与 VAD 事件；输出：待发送的段（16 kHz WAV 字节、起止秒、是否强制切）。
   - **最小段长** `DEFAULT_MIN_SEGMENT_SEC = 30`：已缓冲的**语音**累计不足 30 s 时，停顿处不切，继续攒。累计达到后，在**第一个**长度 ≥ `DEFAULT_CUT_PAUSE_SEC`（0.8 s）的静音里切。
   - **最大段长** `maxSegmentSec`（沿用 `DEFAULT_MAX_SEGMENT_SEC = 60`）：到期仍无停顿则强制切在窗口内最安静的帧，**仅强制切才**在相邻两段间保留 `OVERLAP_SEC = 0.4` 的重叠；在停顿处切不需要重叠（那一段是静音）。
   - **过滤**：段内两句之间的静音超过 `DEFAULT_KEEP_GAP_SEC`（1.0 s）时压到 1.0 s；不超过的**原样保留**，不改动短停顿（停顿是标点线索，见 `pauseCues` 的既有结论）。
   - 停止时冲刷：未满最小段长的剩余语音作为**最后一段**发出；整个输入累计语音不足 30 s 时，因此恰好是一个段。
   - 输入全无语音：不产出任何段。
3. 与 `PAUSE_CAPS` 的关系：这里不再使用批处理的 `PAUSE_CAPS` 压缩短停顿（那一档在 omni 上的实验里「没有多赢一个判定、反而输了一个」，所以 omni 声明为 `neutral`）。过滤只作用于超过 1.0 s 的长静音，是更保守的一档。

### 边界（不做）

不改录音 hook（归 `gap-voice-single-continuous-input-path`）；不改界面；不处理 Groq 的计费下限；不引入模型 VAD；不调用任何识别服务。

## AC

- [x] `npm run test:client -- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts` 退出码 0
- [x] 短输入退化：用 harness 生成累计语音 < 30 s 的时间线（≥ 100 条，固定种子），分段结果**恰好 1 段**，且该段保留的真值语音占比（speechKeptRatio）≥ 0.99
- [x] 长输入：累计语音 ≥ 90 s 的时间线（≥ 100 条）切出 ≥ 2 段；除最后一段外，每段累计语音 ≥ 30 s；每个**非强制**切点都落在长度 ≥ 0.8 s 的静音内（中途切率为 0）
- [x] 无真停顿：`corpus/long/L4-nonstop`（138.5 s 连续语音）切出的每段时长 ≤ `maxSegmentSec`，全部是强制切，强制切点的帧能量 ≤ 其前 2 s 窗口内帧能量的中位数；相邻两段重叠 0.4 s ± 1 帧
- [x] 过滤正确：输出段内的静音总长 = Σ min(各间隔, 1.0 s) ± 1 帧；间隔 ≤ 1.0 s 的片段逐样本原样保留
- [x] 输入无语音（全零、−50 dBFS 纯底噪）：不产出任何段，不抛异常
- [x] 分块不变：同一段 PCM 按 1、160、320、4800 个样本分块喂入，产出的段（起止、字节哈希）逐个相同
- [x] 上传可行：每段的 WAV 采样率为 16000，`dashscope-omni` 的 `measureChatRequestBytes` 对任一段 ≤ 10 MB（最大 60 s 段约 2.6 MB）
- [x] worklet：`npx playwright test e2e/voice-streaming-vad.spec.ts` 退出码 0，且新增断言：worklet 转发的 PCM 总时长与注入样本相差 ≤ 50 ms，既有的段边界断言不变
- [x] 取假形态（各自必须变红）：删掉最小段长规则 → 「短输入恰好 1 段」红；改成固定时刻切 → 「非强制切点落在长静音内」红；删掉强制切重叠 → 「重叠 0.4 s」红
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：切段器在**真人语音时间线**（`gap-voice-vad-truth-harness` 的 LibriSpeech 构造，带精确真值）上用时间区间真值度量过，并且 worklet 的 PCM 转发在真实浏览器音频线程里跑过。把 harness 接成 `--detector=live-segmenter` 读数（`experiments/voice-vad/run.mjs`，快照 `fixtures/live-segmenter.json`），读到中途切率、过切率、段数、强制切数，与流式 VAD 的既有快照并列。样本在仓库外，缺失时必须**指名**缺失路径并失败，不得静默跳过。不要求任何识别读数。

L_D 该轴有读数：切段器在合成真人语音上的中途切率、过切率、强制切数。

L_G 该轴仍暗，理由：本任务不产出生成质量轴读数。

## Touches

- src/modules/chat/audio/voiceFrameProcessor.ts
- src/modules/chat/utils/voiceLiveSegmenter.ts (new)
- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts (new)
- e2e/voice-streaming-vad.spec.ts
- experiments/voice-vad/run.mjs
- experiments/voice-vad/fixtures/live-segmenter.json (new)
- tasks/gap-voice-live-segmenter.md
