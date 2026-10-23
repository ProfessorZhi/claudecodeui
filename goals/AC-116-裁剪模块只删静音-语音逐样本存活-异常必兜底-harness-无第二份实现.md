---
id: AC-116
title: 裁剪模块只删静音：语音逐样本存活、异常必兜底、harness 无第二份实现
status: achieved
kind: criterion
goal: GOAL-006
criterion: npx vitest run src/shared/tests/voiceTrim.test.ts
expect: 断言四件事：(1) 样本级不变量 —— 输出中每个被 VAD 判为语音的区间都能在输入里找到对应区间且逐样本相等（只允许
  pre/post-roll 的边界差），即裁剪只删静音、不删语音；(2) 对每个 fixture，输出时长 < 输入时长；(3) 兜底 ——
  输入为空、全静音（无语音段）、帧数异常、采样率不符时，trimVoiceAudio 原样返回输入且 stats.fallback ===
  true，不得抛异常、不得返回空音频；(4) 纯度与唯一性 —— 模块不 import React/DOM，且
  experiments/voice-trim/ 下不存在第二份算法实现（同 AC-113 已立的先例：harness
  只提供语料，算法只在出货模块里）。参数由人 yale 2026-09-21 定死：cap 表取全表（<120ms 保留 / 120–500ms→100ms
  / 500–1500ms→180ms / >1500ms→300ms），lead-in 0.15s / lead-out 0.2s，α 恒为
  1（不调用任何变速），不再比较其它 cap 表。取假形态：恒等实现（不裁）使 (2) 红；只保留静音或裁掉语音使 (1) 红；删掉兜底分支使 (3) 红；在
  harness 里复制一份算法使 (4) 红。当前必红：src/shared/voiceTrim.ts 与
  src/shared/tests/voiceTrim.test.ts 均不存在。
origin: 2026-09-21 现测（仓库外工装 tools/vad.mjs + tools/compress.mjs，capPauses）：zh 80
  clips 1229s→915s、en 32 clips 373s→323s，VAD 段数 p50 3–4，句读 2.06→1.00。cap 表与
  lead-in/out 取自工装默认值，人 yale 决定不再调参。
activatedAt: 2026-09-21T15:17:59.938Z
statusLog:
  - at: 2026-09-21T15:29:25.879Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
