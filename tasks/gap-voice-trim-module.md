---
id: gap-voice-trim-module
title: 纯 DSP 静音裁剪模块（src/shared/voiceTrim.ts）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-116
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-006 的纯 DSP 裁剪模块（AC-116 的实现侧）：在音频送识别器之前把静音裁掉，且**只**删静音。

### 现状与缺口

`src/shared/voiceTrim.ts` 不存在。可用的算法只存在于仓库外工装（`/data/home/yale/work/tc-verify/tools/vad.mjs` 的帧能量 + 迟滞 VAD、`tools/compress.mjs` 的 `capPauses` 停顿表），工装不能作为仓库依赖；而 2026-09-21 已经付过一次「判据量副本」的代价（AC-113 的旧判据与出货模块在 16 条语料上有 6 条不一致）。

### 方案

1. `src/shared/voiceTrim.ts`：纯函数 `trimVoiceAudio(samples: Float32Array, sampleRate: number, opts?)` → `{ samples: Float32Array, stats }`。VAD 口径移植工装（20ms 帧、能量迟滞 enter/exit、pre-roll 120ms / post-roll 180ms）。停顿表由人 yale 2026-09-21 定死，**不做参数搜索**：`<120ms 保留 / 120–500ms→100ms / 500–1500ms→180ms / >1500ms→300ms`；边界保留前导 0.15s + 后导 0.2s，其余边界静音全删；α 恒为 1，不调用任何变速。`stats` 至少含 `inputSec / outputSec / savedRatio / vadSegments / speechKeptRatio / fallback`。
2. `src/shared/tests/voiceTrim.test.ts`：fixture 用**合成信号**（能量包络已知的 burst + 静音，足以驱动 VAD，体积可忽略），断言见 AC 的四条不变量。
3. 兜底：输入为空、无语音段、帧数异常、采样率不符 → 原样返回且 `fallback === true`，绝不因裁剪丢掉一次听写。
4. `.oxlintrc.json`：新增 `src/shared/*.ts` 若被前端模块引用须在该文件的 frontend-shared-file 名单登记，否则 `npm run lint` 红。

### 边界（不做）

不做变速（WSOLA / 任何 α）；不碰 WebAudio / DOM / IO（浏览器适配由 AC-119 承载）；不做读数输出与上传入口（AC-120/AC-121）；不改 `server/modules/voice/` 契约。

## AC

- [x] `npx vitest run src/shared/tests/voiceTrim.test.ts` 退出码 0
- [x] 断言(1)：输出中每个被 VAD 判为语音的区间都能在输入里找到对应区间且逐样本相等（只允许 pre/post-roll 边界差）
- [x] 断言(2)：每个 fixture 的输出时长 < 输入时长
- [x] 断言(3)：空输入 / 全静音 / 帧数异常 / 采样率不符 → 原样返回且 `stats.fallback === true`，不抛异常、不返回空音频
- [x] 断言(4)：模块不 import React/DOM；`experiments/voice-trim/` 下不存在第二份算法实现
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是测试文件存在，而是四条不变量在真实实现上成立且能被假形态打红 —— 恒等实现（不裁）必须使 (2) 红；只保留静音或裁掉语音必须使 (1) 红；删掉兜底分支必须使 (3) 红。参数表按人 yale 2026-09-21 的决定取全表，实现者不得自行调参或引入参数搜索。

L_D 该轴仍暗，理由：本任务只落地一个纯 DSP 裁剪函数及其不变量，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是时长与语音样本存活率，不是生成质量轴读数。

## Touches

- src/shared/voiceTrim.ts (new)
- src/shared/tests/voiceTrim.test.ts (new)
- .oxlintrc.json
- tasks/gap-voice-trim-module.md
