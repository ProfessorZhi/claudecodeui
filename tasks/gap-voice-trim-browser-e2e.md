---
id: gap-voice-trim-browser-e2e
title: 真浏览器里裁剪 on/off 配对：上传体时长真的变短
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-module
goal_ac: AC-119
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-006 的浏览器端到端判据（AC-119）：裁剪真的接进了真实录音链路，且真浏览器里能证明上传体变短。

### 现状与缺口

`src/modules/chat/hooks/useVoiceInput.ts` 把整段录音（`rec.start()` 到 `rec.stop()` 之间的全部音频）直接交给 `transcribeVoice` 上传，没有任何裁剪；也没有能把裁剪关掉的开关。`e2e/voice-trim.spec.ts` 不存在。仓库里已有的同类骨架是 `e2e/voice-identifier-repair.spec.ts`（假麦克风 + 识别器替身 + 服务器启动前播种 + `uiPreferences`/`user-preferences` 镜像与 legacy `voiceConfig` 双写），本任务复用它。

### 方案

1. `src/modules/chat/utils/audioDecode.ts`（新）：`decodeAudioData` 得 `Float32Array` + 采样率；裁后重编码（wav 或 webm/opus）。只有这个文件碰 WebAudio。
2. `src/modules/chat/hooks/useVoiceInput.ts`：上传前 `decode → trimVoiceAudio（出货模块 src/shared/voiceTrim.ts）→ 重编码 → transcribeVoice(裁剪后)`；`fallback === true` 时上传**原始** blob。原始 blob 仍进回放槽（AC-122 再补第二条回放）。
3. `src/shared/voiceDebug.ts`（新）：开关模块，形态为 URL 参数 + localStorage（`?voiceDebug=1` / `?voiceTrim=off`，URL 命中时写回 localStorage 使刷新与 SPA 切换后仍生效）。本任务只落 `voiceTrim` 这一个控制点；读数由 AC-121 落。⛔ 不用 `import.meta.env.DEV` 单条件：构建产物里它为 false，而 e2e 需要可驱动。
4. `e2e/voice-trim.spec.ts`（新）：真实 Chromium + 真实后端/Vite（`playwright.config.ts` 起，隔离 dataDir，每轮自取空闲端口）+ 假麦克风（`--use-fake-device-for-media-stream` 与 `--use-file-for-fake-audio-capture` **必须同时给**，缺前者则后者被忽略、设备改合成 beep）+ 与 AC-115 同形的识别器替身。同一 spec 内配对跑两次：`?voiceTrim=off` 与默认，断言两次上传体都能解析出音频时长、裁的那次严格更短、两次 composer 都持有识别器返回的文本、不裁那次的上传体时长 ≈ fixture 时长。

### 边界（不做）

不改 `server/modules/voice/` 契约；不做读数输出（AC-121）、上传入口（AC-120）、第二条回放（AC-122）；不改裁剪算法（AC-116 承载）。

## AC

- [x] `npx playwright test e2e/voice-trim.spec.ts -g "AC-119"` 退出码 0
- [x] 假麦克风注入音频并经真实语音按钮完成录制→裁剪→转写→填回
- [x] 裁剪 on/off 配对：on 的上传体音频时长严格小于 off
- [x] 不裁那次的上传体时长 ≈ fixture 时长（证明「关」真的是不裁，不是两次都失败成同一个值）
- [x] 两次 composer 都持有识别器返回的文本
- [x] 未 stub 后端、未用 evaluate 改 store 冒充转写；语音配置走既有种入约定
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是 spec 文件存在，而是真实 Chromium 经真实语音按钮走完录制→裁剪→转写→填回，且**同一次运行内的配对**证明上传体变短。承重性由取假形态证明：裁剪没接线（on == off）必须使配对断言红；把 off 那次也裁掉必须使「≈ fixture 时长」红。时长断言不得用「看着像」的间接证据（例如只看字节数而不解析容器），否则编码差异会冒充裁剪效果。

L_D 该轴仍暗，理由：本任务只把裁剪接进既有语音链路并加一条浏览器判据，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是上传体时长与 composer 文本，不是生成质量轴读数。

## Touches

- e2e/voice-trim.spec.ts (new)
- playwright.config.ts
- src/modules/chat/utils/audioDecode.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/voiceDebug.ts (new)
- .oxlintrc.json
- tasks/gap-voice-trim-browser-e2e.md
