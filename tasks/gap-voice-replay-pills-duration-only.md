---
id: gap-voice-replay-pills-duration-only
title: 回放按钮只标时长：去掉字节数、超过一小时用 H:MM:SS、原始录音可缺席（超过 10 分钟不提供）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` 与人（yale）对界面的裁定。与已完成的 `gap-voice-clip-dual-playback`（两条轨回放）、`gap-voice-clip-single-slot-playback`（单槽播放）相关：本条不改它们的播放语义，只改**显示**与**槽的形状**。界面原则：**保持简洁，不加任何新控件**。

### 现状与缺口

`VoiceClipButton.tsx` 的每个回放按钮显示「▶ + 时长 + 字节数」（字节数小屏隐藏）。过滤后的音频是 PCM，字节数反而比原始 opus 大，会让用户觉得「过滤后更差」；用户要看的是「过滤前后各多长」。时长格式 `formatDuration` 只有 `M:SS`，长输入（超过一小时）会显示成 `61:23`。`VoiceClipSlot.original` 现在是必有的，但连续输入的原始 PCM 要设上限（10 分钟，16 kHz Int16 约 19 MB），超过后只保留过滤后的一条。

### 方案

1. `VoiceClipButton.tsx`：按钮只显示 `▶/■` 加时长，**删除字节数**；时长小于一小时显示 `M:SS`，达到一小时显示 `H:MM:SS`。
2. `src/shared/types.ts`：`VoiceClipSlot` 改为 `{ original: VoiceClip | null; trimmed: VoiceClip | null }`，至少有一条非空；`original` 为空表示原始录音超过上限，**按钮不渲染（不是禁用）**，与现有「trimmed 缺席则不渲染」同一做法。
3. 顺序与名称不变：左边原始，右边过滤后；无障碍名称沿用 `voice.replayOriginal` / `voice.replayTrimmed`（不改措辞，不动语言包）。
4. 不新增任何控件、提示或文案。

### 边界（不做）

不改播放逻辑与「同一时刻最多一条在播」的规则；不改语言包；不产生/填充槽（槽由 `gap-voice-single-continuous-input-path` 填）。

## AC

- [x] `npm run test:client -- src/modules/chat/tests/voiceClipPlayback.test.tsx` 退出码 0
- [x] 按钮文本不含字节数：渲染一个 `bytes` 为 2 MB 的 clip，按钮的 `textContent` 不含 `MB`、`KB`、` B`
- [x] 时长格式：`3 s → 0:03`、`59 s → 0:59`、`61 s → 1:01`、`3599 s → 59:59`、`3600 s → 1:00:00`、`3723 s → 1:02:03`、`0 → 0:00`
- [x] `original` 为 `null` 时只渲染过滤后的一个按钮（`data-clip-url` 属于 trimmed），且没有被禁用的原始按钮；两者皆非空时两个按钮顺序为原始、过滤后
- [x] 既有的播放互斥与停止行为断言不改一行即通过
- [x] `grep -rn "formatBytes" src/modules/chat/composer/VoiceClipButton.tsx | wc -l` 的结果为 0
- [x] 依赖 `VoiceClipSlot` 的既有测试（`composerCompactTier`、`chatComposerResponsive`、`residentComposerEnableAffordance`、`occupiedSessionReadOnly`）仍通过
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不只是单元渲染，而是在真实页面的 composer 里，两个回放按钮并排显示「▶ 0:47」「▶ 0:19」这样的纯时长。用现有的 e2e 录音注入方式走一次录音，读到两个按钮的文本只含时长。取假形态：把字节数加回去，「按钮文本不含字节数」必须红；把 `3600 s` 的格式改回 `M:SS`，时长格式用例必须红。

L_D 该轴仍暗，理由：本任务只改显示，不新增领域数据能力。

L_G 该轴仍暗，理由：同上。

## Touches

- src/modules/chat/composer/VoiceClipButton.tsx
- src/shared/types.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- tasks/gap-voice-replay-pills-duration-only.md
