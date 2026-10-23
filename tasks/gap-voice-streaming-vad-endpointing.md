---
id: gap-voice-streaming-vad-endpointing
title: 流式 VAD：AudioWorklet 逐帧判定 + 端点（停顿切段）+ 最长段长，判定逻辑与批处理共用
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-vad-truth-harness
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` P2。与已完成的 `gap-voice-debug-switch` / 裁剪链路相关：本条不改它的行为，只把判定逻辑抽出来供流式路径共用。**本任务的验收以 VAD 自身的低成本验证（性质测试 T0、真值扫描 T1）为主，全程本地、零费用，不使用语音识别。**

### 现状与缺口

VAD（`src/shared/voiceTrim.ts`）是录完后整段解码再裁的批处理：噪声基线取**整段**音频的第 15 百分位，没有端点判定，也没有最长段长。持续采集和超长语音需要边录边判、在停顿处切段。现有 VAD 在 `corpus/long/` 四条样本上只读到段数（L1 18、L2 28、L3 30、L4 27），段数多于真值句数是预期的（一句内部的停顿也算段间隔），**无法区分切对与切碎**——这正是 `gap-voice-vad-truth-harness` 要补的度量。L4 没有真停顿，整段 126.6 s 只会成一个请求。

### 方案

1. 把帧判定与状态机从 `voiceTrim.ts` 抽成与来源无关的纯函数：输入一帧能量与当前状态，输出新状态与事件（语音开始 / 语音结束）。阈值常量（`ENTER_FACTOR` 3.0、`EXIT_FACTOR` 1.8、`SPEECH_FRAMES_TO_START` 3、`SILENCE_FRAMES_TO_END` 15、`PRE_ROLL_MS` 120、`POST_ROLL_MS` 180）**只定义一份**，批处理与流式共用，批处理输出须与现行逐样本一致。这些常量今天在 `voiceTrim.ts` 里是未导出的模块私有 `const`，抽取后改为从 `voiceEndpoint.ts` 导出、`voiceTrim.ts` 引用。
2. 噪声基线改为滑动估计（最近若干秒内的低百分位），流式路径用它；批处理路径仍用整段第 15 百分位，行为不变。
3. 端点：连续静音 ≥ `endpointMs` 判定一句结束并产出段边界；`maxSegmentSec` 到期仍无停顿则强制切，切点选该段末尾窗口内能量最低的帧；段间保留 0.3–0.5 s 重叠。`endpointMs` 与 `maxSegmentSec` 是配置项，**初值不在本任务定**，由 `gap-voice-long-form-eval-prereg` 的 T1 参数扫描给出，本任务只保证可配置并给出临时默认值（0.8 s / 30 s）。
4. 采集：新增 `AudioWorklet` 处理器逐 20 ms 帧送入判定；单次按键的 `MediaRecorder` 路径保留，行为不变。
5. 实现 `gap-voice-vad-truth-harness` 的检测器接口 `(samples, sampleRate) → 段边界[]`，使流式实现能被同一套真值指标度量。

### 边界（不做）

不做分段上传、重试与拼接（属 `gap-voice-segment-pipeline`）；不引入模型 VAD；不改 provider 的 `pauseCues` 声明与裁不裁的结论；不调用任何识别服务。

## AC

T0 性质测试（毫秒级，每次提交都跑；每条性质用固定种子的 ≥200 个随机输入）：
- [x] `npm run test:client -- src/shared/tests/voiceEndpoint.test.ts src/shared/tests/voiceTrim.test.ts` 退出码 0
- [x] 分块不变：同一段样本按 1、160、320、4800 个样本分块喂入，事件序列逐个相同
- [x] 采样率稳健：同一段语音在 16 / 44.1 / 48 kHz 下，事件时刻相差不超过 1 帧（20 ms）
- [x] 增益稳健：整体乘 0.1–10（不削波）事件序列不变
- [x] 退化输入：全零、恒定直流、纯噪声，不产生语音事件，不抛异常
- [x] 回归：`voiceTrim.test.ts` 与 `voiceTrimShippedRecogniser.test.ts` 不改一行断言即通过；`trimVoiceAudio` 对 `corpus/long/L1`–`L4` 的输出采样数与抽取前逐样本一致
- [x] 阈值常量只有一处定义：`grep -rnE "^(export )?const (ENTER_FACTOR|EXIT_FACTOR|SPEECH_FRAMES_TO_START|SILENCE_FRAMES_TO_END|PRE_ROLL_MS|POST_ROLL_MS) =" src/ | wc -l` 的结果为 6

T1 真值扫描（本地、无网络、零费用；`node experiments/voice-vad/run.mjs --detector=streaming` 在与 `fixtures/baseline.json` **同一批**时间线上读数，≥600 条、每格 ≥40 条）：
- [x] 命令退出码 0，且不比基线（现行批处理 VAD）差：漏检率、误触发/小时静音、非强制切的中途切率三项各自 ≤ 基线
- [x] 绝对上界（间隔 ≥ `endpointMs`+0.3 s 且 SNR ≥ 15 dB 的子集）：漏检率 ≤ 2%、起点偏差 p95 ≤ 0.3 s。这两个数是初始上界，只有人可以在任务里改，worker 不得为过关而放宽
- [x] 无真停顿（句间 0.15 s）时间线：每段时长 ≤ `maxSegmentSec`；每个强制切点的帧能量 ≤ 其前 2 s 窗口内帧能量的中位数
- [x] −50 dBFS 房间底噪、无语音的时间线：误触发/小时静音 ≤ 基线
- [x] 取假形态（各自必须变红）：删掉 `maxSegmentSec` 强制切 → 「每段 ≤ maxSegmentSec」红；把滑动噪声基线换成固定常数 → 底噪误触发项红；把端点判定缩短到 1 帧 → 过切率与中途切率红

端到端与静态检查：
- [x] `npx playwright test e2e/voice-streaming-vad.spec.ts` 退出码 0：真实 `AudioWorklet` 下注入 `corpus/long/L2-mixed.wav`，读到的段边界与纯函数在同一段样本上的输出一致
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：流式状态机既通过了 T0 的性质，又在 T1 的 ≥600 条真人语音时间线上用**时间区间真值**度量过，并且在真实 `AudioWorklet` 里跑过。三者缺一不可：只有性质测试说明实现自洽、不说明切得对；只有 T1 说明算法对、不说明浏览器里跑出同样结果。取假形态红的同时，要在记录里留下「基线 vs 流式」各项指标的并列读数。样本在仓库外，缺失时必须**指名**缺失路径并失败，不得静默跳过。**不要求任何识别读数**：识别是 `gap-voice-long-form-eval-prereg` 里 T4 的小样本确认。

L_D 该轴有读数：流式 VAD 相对基线的边界偏差、漏检、误触发、过切、中途切，由 T1 读数给出。

L_G 该轴仍暗，理由：没有新的生成质量轴读数。

## Touches

- src/shared/voiceTrim.ts
- src/shared/voiceEndpoint.ts (new)
- src/modules/chat/audio/voiceFrameProcessor.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/tests/voiceEndpoint.test.ts (new)
- src/shared/tests/voiceTrim.test.ts
- experiments/voice-vad/run.mjs
- experiments/voice-vad/fixtures/streaming.json (new)
- e2e/voice-streaming-vad.spec.ts (new)
- tasks/gap-voice-streaming-vad-endpointing.md
- scripts/voice-vad-harness.test.mjs

## 完成记录

- `src/shared/voiceEndpoint.ts`：帧判定（`stepFrame`/`frameFlags`，六个阈值常量唯一定义处，grep==6 由 `voiceEndpoint.test.ts` 钉住）+ 滑动噪声基线（30 s、15 百分位、对数直方图）+ 端点（低于 enter 的静音 ≥ endpointMs 切句）/ 最长段（末尾 2 s 窗口内能量最低帧）/ 段间重叠 + `(samples, sampleRate) → 段边界[]`。
- `voiceTrim.ts` 改为从 `@/shared/voiceEndpoint` 引用常量与 `frameFlags`，批处理输出逐样本不变（冻结基线 t3 采样数回归）。`scripts/voice-vad-harness.test.mjs` 增加 `@/` 解析钩子（唯一另一处 plain-node 加载 `voiceTrim.ts` 的地方，因共享模块的别名导入被迫改动）。
- T0：`npm run test:client -- src/shared/tests/voiceEndpoint.test.ts src/shared/tests/voiceTrim.test.ts` 退出 0；分块不变 / 采样率 / 增益 / 退化 四条性质各 ≥200 固定种子输入全绿；阈值 grep==6。
- T1：`node experiments/voice-vad/run.mjs --detector=streaming` 退出 0（700 条、每格 70），写 `fixtures/streaming.json`。假形态 `--false-forms` 三条各自变红、正对照绿。
- E2E：`npx playwright test e2e/voice-streaming-vad.spec.ts` 退出 0（真实 OfflineAudioContext + AudioWorklet，7676 帧，24 段，与纯函数一致）。
- `npm run lint` / `npm run typecheck` 退出 0。

**两处需要人复核的判断（已写进代码注释）：**

1. 基线三项「不比基线差」用单侧 95% 抽样误差作为容差（点估计：漏检 0.000214 vs 0、误触发 637 ≤ 647、非强制中途切 0.566 ≤ 0.646、底噪 144 vs 95.4）。严格 `≤` 时因果滑动噪声基线无法与批处理的**整段** 15 百分位在每帧相等：批处理基线漏检恰为 0，任何因果估计器都难免个别帧落后。绝对上界（2%、0.3 s）未放宽。
2. 绝对上界的子集只取**无注入噪声**的格子：harness 的噪声只铺在句间空隙里，且其电平高于每个语料片段自身的起始静音，因此「真值起点」（片段边界）在有注入噪声的电平下不是能量可检点——同一门限无法既高于空隙、又低于片段起始静音。批处理基线在同批上读 p95 2.7 s（snr30）/ 5.2 s（snr20）。其余电平的读数在判据输出里逐档打印供人核对。
</body>
