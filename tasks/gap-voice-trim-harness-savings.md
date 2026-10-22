---
id: gap-voice-trim-harness-savings
title: 裁剪省时长的仓库内读数（量出货模块，含正对照）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-module
goal_ac: AC-117
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-006 的省时长读数（AC-117）：把「裁剪真的省了多少时长、且一个语音样本都没丢」变成仓库内可复跑的判据，且**量的是出货模块**。

### 现状与缺口

仓库内没有任何裁剪读数。全部证据在仓库外工装：`/data/home/yale/work/tc-verify`（语料 `corpus/dictation` 38MB / `corpus/dictation-en` 11MB，脚本 `tools/measure-r.mjs`、`tools/sweep-savings.mjs`）。工装体积不适合整体入库，且工装自带算法副本的先例已经出过事（AC-113 的旧判据与出货模块在 16 条语料上 6 条不一致）。

### 方案

1. `experiments/voice-trim/fixtures/`：入库**小样本真音频**（16kHz 单声道 wav，从工装语料里挑，总量 ≤ 4MB），文件名固定为下方 Touches 所列，覆盖三个中文占用率档（o85 / o65 / o45）与两个英文档（o65 / o45）—— 判据里的**单调性断言**需要跨档样本，这是它存在的理由。
2. `experiments/voice-trim/run-savings.mjs`：
   - 只 `import` 出货模块 `src/shared/voiceTrim.ts`，**harness 内不得有第二份算法**（含不得把 VAD/停顿表抄进来）。
   - 对每个 clip 打印 `baselineSec / trimmedSec / savedRatio`，并聚合成 `aggregate savedRatio`、`speechKeptRatio`、`fallbacks`。
   - 同一个 runner 内打印**恒等实现的正对照行**（savedRatio = 0），使「零损失」不是一个惰性实现也能拿的分。
   - 支持 `VOICE_TRIM_CORPUS=<dir>` 指向仓库外全量语料，打印全量读数（例：zh 25.5% / en 13.3%），但**不作为阈值来源**；阈值只压在入库 fixture 上。
   - 退出码：任一断言不满足即 exit 1，失败原因写 stderr（判据门是 stderr-first，读的是 stderr）。

### 边界（不做）

不改出货模块（本任务只读它）；不做质量读数（AC-118 承载）；不调用任何识别器、不联网；不引入参数搜索（参数由人 yale 定死）。

## AC

- [x] `node experiments/voice-trim/run-savings.mjs` 退出码 0
- [x] 每个入库 clip 裁剪后时长 < 输入时长
- [x] 单调性：aggregate savedRatio(o45) > savedRatio(o65) > savedRatio(o85)
- [x] aggregate savedRatio ≥ 0.15
- [x] speechKeptRatio == 1.0（VAD 判为语音的样本一个不丢）
- [x] 同一 runner 内打印恒等实现的正对照行（savedRatio = 0）
- [x] 被测实现是 `src/shared/voiceTrim.ts`；harness 无第二份算法实现
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是脚本文件存在，而是读数在**出货模块**上跑出来且能被假形态打红 —— 恒等实现（不裁）必须使「时长下降」与「单调性」两条红；把静音也当语音送进去必须使 aggregate 阈值红；裁掉语音必须使 `speechKeptRatio == 1.0` 红；把算法抄一份进 harness 必须使唯一性断言红。fixture 必须入库（判据不得依赖仓库外路径），且文件名为 Touches 所列，改名须同步改 Touches。

L_D 该轴仍暗，理由：本任务只把已有的时长读数落成仓库内可复跑的判据，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是音频时长与语音样本存活率，不是生成质量轴读数。

## Touches

- experiments/voice-trim/run-savings.mjs (new)
- experiments/voice-trim/fixtures/zh-d01-o85.wav (new)
- experiments/voice-trim/fixtures/zh-d10-o85.wav (new)
- experiments/voice-trim/fixtures/zh-d02-o65.wav (new)
- experiments/voice-trim/fixtures/zh-d06-o65.wav (new)
- experiments/voice-trim/fixtures/zh-d03-o45.wav (new)
- experiments/voice-trim/fixtures/zh-d13-o45.wav (new)
- experiments/voice-trim/fixtures/en-e01-o65.wav (new)
- experiments/voice-trim/fixtures/en-e01-o45.wav (new)
- tasks/gap-voice-trim-harness-savings.md
