---
id: gap-voice-upload-16khz-mono
title: 语音上传改 16 kHz 单声道（请求体约 1/3，长音频的单请求上限随之放大）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` P1。与 `gap-asr-mime-whitelist-and-size-layering`（上传体积分层）相关但机制不同：那条管「超限怎么拒」，本条管「同样的音频发多少字节」。

### 现状与缺口

`useVoiceInput.ts` 的 `prepare` 依次 `decodeVoiceBlob`（`DECODE_SAMPLE_RATE = 48000`）→ `trimVoiceAudio` → `encodeWavBlob`，上传的是 **48 kHz 16 位 PCM WAV，每秒 96 KB**，base64 后约 128 KB/秒。`dashscope-omni` 的 `maxInlineRequestBytes` 是 10 MB 且含整个请求，所以一次大约只能发 80 秒；本轮用 `corpus/long/L4-nonstop`（140.8 s）按字节推算，现行格式约 12.2 MB，会被 `OVERSIZE` 拒绝。ASR 本来就在 16 kHz 上工作，48 kHz 对识别没有预期收益。

### 方案

1. `src/modules/chat/utils/audioDecode.ts`：新增带抗混叠的降采样（不做隔点取样），把解码后的单声道样本降到 16 kHz；`encodeWavBlob` 按传入采样率写头，不改其签名。
2. `src/modules/chat/hooks/useVoiceInput.ts`：`prepare` 在 `trimVoiceAudio` 之后、`encodeWavBlob` 之前降采样。**VAD 仍在解码的原始采样率上跑**，不改变已上线的裁剪读数；`AudioReading` 的 `inputSec / outputSec` 语义不变。
3. 回退路径不变：任何 guard 触发时仍发原始 webm，不降采样。

### 边界（不做）

不改 VAD 的任何阈值与停顿封顶；不改 provider 声明；不碰服务端（服务端是字节透传）；不引入新的编码（仍是 WAV，不重新有损编码）。

## AC

- [x] `npm run test:client -- src/shared/tests/voiceUpload16k.test.ts` 退出码 0
- [x] 测试断言：同一段输入，降采样输出的采样率为 16000、时长与输入相差不超过 1 个采样点对应的时间，且 WAV 头的采样率字段为 16000
- [x] 测试断言：一段 1 kHz 正弦在 48 kHz 输入下降采样后主频仍为 1 kHz；一段 20 kHz 正弦（高于 16 kHz 奈奎斯特频率）降采样后能量低于输入的 1%（抗混叠有效，不是隔点取样）
- [x] 测试断言：`prepare` 在 guard 触发（回退路径）时仍返回原始 webm，不是降采样后的 WAV
- [x] 对 `corpus/long/L4-nonstop.wav` 的样本规模，上传 WAV 字节数 ≤ 现行 48 kHz 格式的 36%（约 1/3），测试里用同一段样本两种格式的字节数比较
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是「函数能降采样」，而是 `prepare` 在真实录音路径上产出 16 kHz WAV 并被 provider 接受。人工/e2e 各留一条证据：用现有 e2e 夹具（`e2e/voice-trim.spec.ts` 的录音注入方式）走一次录音→转写，抓上传请求体，读 WAV 头采样率为 16000；并且转写文本与同一夹具在 48 kHz 下的文本逐字相同或差异在预注册容差内（容差由 `gap-voice-long-form-eval-prereg` 的预注册给出，未建前以「标识符存活率不下降」为准）。取假形态：把降采样改成隔点取样，抗混叠断言必须红。

L_D 该轴仍暗，理由：本任务只改上传采样率，不新增领域数据能力。

L_G 该轴仍暗，理由：同上，没有新的生成质量轴读数。

## Touches

- src/modules/chat/utils/audioDecode.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/tests/voiceUpload16k.test.ts (new)
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- tasks/gap-voice-upload-16khz-mono.md
