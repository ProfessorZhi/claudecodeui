---
id: gap-voice-file-upload-input
title: 开关控制的音频文件上传入口，走同一条转写链路
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-browser-e2e
goal_ac: AC-120
---
## Proposal

<!-- dedup-ref --> 本任务落地 AC-120：除麦克风采集外，支持**音频文件上传触发识别**，以便复现与自测（含后续真人语料的验证）。

### 现状与缺口

今天唯一的入口是麦克风：一次按键 = 一段录音 = 一次请求。要验证链路上的任何改动，只能靠假麦克风 + 合成音频（e2e）或真人对着麦克风说。仓库里没有「拿一段已知 WAV 驱动一次转写」的入口，Agent 与人都不便复现，AC-117/AC-118 的取证也只能靠离线 fixture。

### 方案

1. `src/modules/chat/composer/VoiceUploadButton.tsx`（新）：一个 `<input type="file" accept="audio/*">`，可见性由 `src/shared/voiceDebug.ts` 的开关决定（默认不可见 ⇒ 默认交互不变）。
2. `src/modules/chat/composer/ChatComposer.tsx`：开关打开时把它渲染在麦克风旁。
3. `src/modules/chat/hooks/useVoiceInput.ts`：把「拿一个 blob 走完整条链路」抽成一条内部路径（decode → 裁剪 → 重编码 → `transcribeVoice` → 修复 → composer），麦克风与上传共用；来源标记 `source: "mic" | "file"` 进读数（读数由 AC-121 落）。⛔ 上传路径**必须**复用同一个 `transcribeVoice` 调用，不得旁路 `onTranscript` 直接塞文本。
4. `e2e/voice-trim.spec.ts`：`setInputFiles` 提交 `playwright.config.ts` 已为假麦克风播种的那份 WAV fixture（路径经环境变量给出，服务器启动前写好），断言 (a) 落到识别器端点上的请求体确实来自该文件（容器魔力与字节量级对得上，且与麦克风那条的体量不同）；(b) composer 最终持有识别器返回的文本；(c) 开关关闭时入口**不可见**。

### 边界（不做）

不做拖拽上传、批量上传、文件持久化；不改默认交互（入口默认隐藏）；不引入新依赖；不改识别器契约。

## AC

- [x] `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` 退出码 0
- [x] 开关打开时上传入口可见；开关关闭时**不可见**（默认交互不变）
- [x] `setInputFiles` 提交 WAV 后，落到识别器端点的请求体来自该文件（容器魔力 + 字节量级）
- [x] composer 最终持有识别器返回的文本
- [x] 读数里 `source === "file"`
- [x] 入口未旁路 `transcribeVoice`（代码路径可核对，spec 断言上传体非空且非固定体）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是按钮存在，而是**同一段已知音频经真实浏览器上传后，真的走了与麦克风同一条转写链路**。承重性由取假形态证明：入口直接调用 `onTranscript('固定文本')` 必须使「请求体来自该文件」红；把入口做成始终可见必须使「关闭时不可见」红。上传的音频必须与麦克风路径共用裁剪（否则两条路会漂移，且 AC-119 的配对结论不能迁移到上传路径）。入口的可见性开关 `isVoiceDebugEnabled` 与既有的裁剪开关同处 `src/shared/voiceDebug.ts`，所以该文件也在 Touches 内：它是本任务新增开关的落点，不是一个顺带改到的文件。

两条取假形态都在本任务内实测过（改完即跑 `-g "AC-120"`，跑完还原）：旁路形态红在 `the chosen file never reached the recogniser`（Expected 1 / Received 0），常显形态红在 leg 3 的 `toHaveCount(0)`（Expected 0 / Received 1）。

L_D 该轴仍暗，理由：本任务只新增一个验证用入口并复用既有转写链路，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是入口可见性与上传体来源，不是生成质量轴读数。

## Touches

- src/modules/chat/composer/VoiceUploadButton.tsx (new)
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/utils/audioDecode.ts
- src/shared/voiceDebug.ts
- e2e/voice-trim.spec.ts
- playwright.config.ts
- tasks/gap-voice-file-upload-input.md
