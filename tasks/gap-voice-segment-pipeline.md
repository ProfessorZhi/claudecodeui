---
id: gap-voice-segment-pipeline
title: 语音分段流水线：段序号 + 重叠去重 + 单段重试 + 按序拼回
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-streaming-vad-endpointing
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` P3。段边界由 `gap-voice-streaming-vad-endpointing` 产出，本条消费它；与 `gap-asr-proxy-provider-dispatch`（单次请求的 provider 分发）相关但不重叠：那条管一次请求发给谁，本条管一串请求怎么并发、重试、拼回。**验收以可控的假 provider + 随机化性质测试为主；真实 provider 只做一次冒烟。**

### 现状与缺口

`transcribeVoice`（`src/shared/api.ts`）是一次录音一次请求，没有序号、没有重试策略、没有「多段结果拼成一段文本」的概念。超过单请求上限的长语音和持续采集需要把流切成多段、分别识别、按序拼回。`dashscope-omni` 的 `honors.context` 为 false，上一段内容无法作为上下文传入，所以每段必须自成完整句子，跨段的标识符会断；Groq 限流 20 RPM，段切得碎会撞上。

### 方案

1. 每段带序号、起止时间和段时长；并发提交，返回可能乱序，结果按序号拼回。
2. 单段失败只重试该段（有限次数、退避），其余段不受影响；最终失败的段在结果里留**显式占位**（带序号与时间范围），不静默丢弃。
3. 并发受 provider 限流约束：段过短（短于配置下限）时与相邻段合并后再提交；并发度上限可配置。
4. 文本拼接：相邻段有 0.3–0.5 s 的音频重叠，拼回时在文本层对重叠部分去重；去重只在重叠窗口对应的文本头尾做，不全局去重。
5. 记录每段序号、时长、字节数、端到端延迟，写进 `voice.transcribe` 日志行（与已落地的 `usage=` 并列），使真实分布可事后统计。

### 边界（不做）

不做流式识别协议（WebSocket）；不做段内上下文传递（provider 不支持）；不改单次按键模式（它仍是单段、单请求）；不评估识别质量（归 `gap-voice-long-form-eval-prereg` 的 T4）。

## AC

- [x] `npm run test:client -- src/modules/chat/utils/tests/voiceSegments.test.ts` 退出码 0
- [x] 乱序：把 N=6 段的返回顺序打乱，拼回的文本顺序与序号顺序一致（可控的假 provider，用固定种子随机化 ≥200 种返回顺序）
- [x] 单段失败：让任意一段始终失败（遍历每个序号），其余段文本完整、序号正确；结果里该段是带序号和时间范围的占位，且只被重试了配置的次数
- [x] 随机组合：固定种子的 ≥200 个「乱序 × 失败段 × 重叠」随机组合下，拼回文本等于按序号拼接的期望文本（失败段位置为占位）
- [x] 重叠去重：构造相邻两段文本头尾重复同一短语，拼回后该短语只出现一次；构造两段文本不重复时，拼回后无任何字符被删
- [x] 限流：把并发上限设为 2，假 provider 记录同时在途请求数，峰值不超过 2
- [x] 过短段合并：短于配置下限的段与相邻段合并后再提交，提交总数少于段数，且合并后各段起止时间连续、无间隙
- [x] 单次按键模式回归：不经过分段流水线，请求数仍为 1，上传体与改动前逐字节一致
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：流水线逻辑在可控假 provider 下被随机化性质覆盖，**并且**用 `corpus/long/L2-mixed.wav`（153.5 s，10 句，含 20 s 静音）对真实 `dashscope-omni` 做**一次**冒烟：流式 VAD 切段、分段提交、按序拼回，读到每段的序号、时长、延迟与 `usage`，拼回后句数与真值句数一致（`manifest.json`）。冒烟只证明链路通，不是质量评估，不比较参数。凭据缺失必须**指名**缺哪个变量并让冒烟失败，不得降级为全假 provider 后报绿。取假形态：把拼回改成按完成顺序而非序号，乱序用例必须红；把失败段吞掉不留占位，单段失败用例必须红。

L_D 该轴仍暗，理由：本任务不新增领域数据能力。

L_G 该轴仍暗，理由：质量读数归 `gap-voice-long-form-eval-prereg`，本任务不产出生成质量轴读数。

## Touches

- src/modules/chat/utils/voiceSegments.ts (new)
- src/shared/api.ts
- src/modules/chat/hooks/useVoiceInput.ts
- server/modules/voice/voice.service.ts
- src/modules/chat/utils/tests/voiceSegments.test.ts (new)
- tasks/gap-voice-segment-pipeline.md
