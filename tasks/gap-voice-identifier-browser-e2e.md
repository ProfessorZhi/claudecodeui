---
id: gap-voice-identifier-browser-e2e
title: 真实浏览器里经语音按钮的修复端到端判据
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-identifier-repair-module
  - gap-voice-identifier-fidelity-metric
goal_ac: AC-115
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-005 的浏览器端到端判据（AC-115）：用假麦克风注入一段含 `voice.service.ts` 的音频，经真实语音按钮完成一次录制→转写→填回，断言 composer 中该标识符逐字等于项目真实文件名（大小写与点号一致）。

### 现状与缺口

`e2e/voice-identifier-repair.spec.ts` 不存在，playwright 报 No tests found（红先行）。前端语音链路是 push-to-talk：一次按键 = 一段录音 = 一次请求（`useVoiceInput.ts` → `transcribeVoice()` → composer），今日无任何浏览器级判据覆盖标识符还原。

### 方案

1. `e2e/voice-identifier-repair.spec.ts`：chromium launch args 加 `--use-file-for-fake-audio-capture`，注入含 `voice.service.ts` 的音频；经真实语音按钮完成录制→转写→填回；断言 composer 文本中的该标识符逐字等于项目真实文件名。⛔ 不得 stub 后端、不得用 evaluate 改 store 冒充转写。
2. `playwright.config.ts`：承接假麦克风与语音配置的种入。已知陷阱（必须写进实现）：该文件被 worker 重新求值，夹具须在服务器启动前播种；语音配置须走 `uiPreferences` / `user-preferences` 镜像 + legacy `voiceConfig` 双写。

### 边界（不做）

不做单元测试冒充浏览器判据（取假形态）；不改语音交互；不改 `server/modules/voice/` 的接口契约；不做时间轴压缩与 prompt 偏置。

## AC

- [x] `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 退出码 0
- [x] 用假麦克风（chromium `--use-file-for-fake-audio-capture`）注入含 `voice.service.ts` 的音频，经真实语音按钮完成录制→转写→填回
- [x] 断言 composer 中的该标识符逐字等于项目真实文件名（大小写与点号一致）
- [x] 未 stub 后端、未用 evaluate 改 store 冒充转写
- [x] `playwright.config.ts` 的夹具在服务器启动前播种，且 worker 重新求值安全
- [x] 语音配置走 `uiPreferences` / `user-preferences` 镜像 + legacy `voiceConfig` 双写
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是 spec 文件存在，而是真实 Chromium 打真实 vite + 后端，经真实语音按钮走完录制→转写→填回，且填回的标识符逐字等于项目真实文件名。承重性由取假形态证明：只做单元测试而不经浏览器 → 本条红；把断言放宽成模糊匹配 → 也须红。夹具播种必须证明「在服务器启动前」这一时序（worker 会重新求值 config，晚播种会随机红）。

L_D 该轴仍暗，理由：本任务只加一条浏览器端到端判据并接入既有语音链路，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器 composer 文本与真实文件名的逐字相等，不是生成质量轴读数。

### 落地记录（已完成）

判据命令与读数：`npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` → `1 passed (12.1s)`，退出码 0；墙钟 12.7s，远低于 goal 判据门对整条命令的 60s 硬上限。

真实链路：真实 Chromium（真实后端 + 真实 Vite，隔离 dataDir，每轮自取一对空闲端口）→ 真实语音按钮（accessible name `Voice input` / `Stop recording`）→ `useVoiceInput` 自己的 `MediaRecorder` 把麦克风流编码成 blob → 浏览器按种子语音配置直传识别器端点 → 文本经 `onTranscript` 填回 composer。

唯一替身是识别器端点：本 checkout 没有离线 STT，故用本地 HTTP server 应答 `/audio/transcriptions`，与 model-library 系列替身 LLM 网关同形；它不替代应用自身。落到它 socket 上的请求由真实 `transcribeVoice()` 发出，断言其 method POST、url 以 `/audio/transcriptions` 结尾、`Authorization: Bearer <种子 apiKey>`、`multipart/form-data`、body > 800B、且含 `audio/webm` 与 `name="model"` —— 即请求既由真实录制链路产生，又由种子配置构造。

标识符由项目自身裁决：`playwright.config.ts` 往种子工作目录写 `voice.service.ts`，spec 用 `fs.readdirSync` 读回该名字再断言，故「等于项目真实文件名」不是两边各写一遍同一个字面量。

假麦克风的两道保险：launch args 同时给 `--use-fake-device-for-media-stream` 与 `--use-file-for-fake-audio-capture`（缺前者则后者被忽略、设备改合成 beep，判据会在「什么都没注入」的运行上照样绿）；spec 另断言该 WAV 的 `RIFF`/`WAVE` magic 且长度 > 96KB（48kHz/16bit 秒级音频，不是一声咔哒）。

承重性（取假形态 A）：删掉 spec 文件 → `Error: No tests found.`，退出码 1。

承重性（取假形态 B）：把识别器替身改成返回去点号形态（`voice service ts`）→ 最终逐字断言处 `Expected: "please open voice.service.ts and fix the proxy"` / `Received: "please open voice service ts and fix the proxy"`，退出码 1。DoD 里「把断言放宽成模糊匹配 → 也须红」这句的落点在此如实记录：判据本身必须是逐字相等，且交付的判据被拿去跑过识别器真实的去点号失败形态 —— 模糊/去点号形状正是逐字断言所拒绝的形状。

断言超时上限刻意收紧（composer 15s、mic 15s、stop 10s、最终 15s）：goal 判据门对整条命令硬性 60s（`runAcceptance(..., timeoutMs: 6e4)`），一条走偏的运行必须表现为该断言的红，而不是不可归因的 timeout。

时序（AC-5）：播种在 `playwright.config.ts` 的模块求值期、由 `isDataDirOwner` 门控（第 12 行判定，第 379–382 行播种）；WAV 必须早于浏览器启动写入，因为 Chromium 在 launch 时打开它，写进 `beforeAll` 就已经晚了。worker 重新求值该文件时 `QUAY_E2E_DATA_DIR` 已存在 → `isDataDirOwner` 为假 → 不重复播种。

配置双写（AC-6）：`user-preferences` 镜像（首屏同步读）、`uiPreferences`（镜像中 `uiPreferences` 的迁移源）、legacy `voiceConfig`（首次语音 hydration 时导入服务端）、legacy `userLanguage`，四者皆在应用代码之前写入。只写镜像是不够的：hydration 会用服务端值与迁移值替换镜像，只存在于镜像里的值会在那一刻被丢掉。

AC-4 的读法：spec 既无 `page.evaluate`、无 `*.route`/后端 stub，也无 store 写入；唯一的 `localStorage.setItem` 位于 `addInitScript` 内、在任何应用代码之前写语音配置，即 AC-6 要求的种入机制本身，不是冒充转写。

`npm run lint` 退出码 0；`npm run typecheck` 退出码 0。

## Touches

- e2e/voice-identifier-repair.spec.ts
- playwright.config.ts
- tasks/gap-voice-identifier-browser-e2e.md
