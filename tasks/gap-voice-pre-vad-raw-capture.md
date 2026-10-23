---
id: gap-voice-pre-vad-raw-capture
title: 采集 VAD 之前的原始音频（被动语料）：新增 raw 采集端点 + 独立 VOICE_CAPTURE_RAW 开关 + listenId 配对
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；本任务没有依赖边）：立案时 `grep -rn "VOICE_CAPTURE_RAW" server/ src/ scripts/ docs/` → 0 命中；`ls server/modules/voice/voice-raw*` → `No such file or directory`；`grep -rn "capture/raw" server/` → 0 命中；`grep -rn "listenId" src/ server/` → 0 命中。同族最近的 `gap-voice-capture-audio-file`（已 done，AC-145）只覆盖**裁剪后**上传字节的落盘，`gap-voice-capture-secrets-three-modes` 覆盖行的字段面，两者都不涉及 VAD 之前的音频——本条是它们让出的那一半：**被 VAD 删掉的那部分音频，今天根本到不了服务端**。

### 要解决的问题（2026-10-05 实测）

真实环境样本 `~/.cloudcli/voice-capture/audio-1r1m5qrcf3-1.bin`（12.72s，发货链路产出的裁剪后上传）：

| 读数 | 值 |
|---|---|
| 发货能量 VAD 判为语音 | **11.90s / 12.22s = 97.4%** |
| 同一文件上 Silero VAD（离线 ONNX，CPU）判为语音 | **1.66s = 13.1%** |
| 识别器自己的转写 | 约 1.7s（「云输入是否真的可用？不一定有效。」） |
| 倍数 | **6.9×** |

能量 VAD 把大量非语音材料当语音送进了识别器。要判定它该被替换还是该被门控，需要真实环境语料——而仓库现有的 T1 语料（`experiments/voice-vad/`，LibriSpeech + 合成间隔 + 合成噪声）**测不到关键失效面**：其最短真值句 **1.95s**，而实测 Silero 在干净音频下会整段吃掉 **34.5% 的 0.3s 短句、11.5% 的 0.5s 短句**（能量 VAD 一个不吃），snr5 下排序又反转（能量 38–48% vs Silero 3–25%）。该语料自己的局限注记也承认噪声是合成的、不是真实环境。

### 缺口

`VOICE_CAPTURE=audio` 写下的正是识别器收到的那份字节（`voice-capture.ts` 自述 "the uploaded buffer itself, never a copy, an encoding, or a re-serialisation"）。**VAD 之前的音频从未到达服务端，服务端无从重建。** 而浏览器端其实一直留着它：`CaptureSession.originalChunks`（`useVoiceInput.ts:457`，由 `appendOriginal()` `:821-842` 逐帧灌入，16kHz，上限 `ORIGINAL_CAP_SEC=600`s），只用于本地回放。

### 现状（立案时实测，可复验）

| 缺什么 | 实测 |
|---|---|
| 独立开关 | `grep -rn "VOICE_CAPTURE_RAW" server/ src/ scripts/ docs/` → 0 命中 |
| 采集模块 | `ls server/modules/voice/voice-raw*` → `No such file or directory` |
| 采集路由 | `grep -rn "capture/raw" server/` → 0 命中 |
| 配对标识 | `grep -rn "listenId" src/ server/` → 0 命中 |
| 客户端留存 | 原始音频**在**（`originalChunks`），但只喂回放，从不外发 |

### 方案

人的裁定：走独立端点 + 独立开关；被动采集（不另设录制协议，正常使用中顺带存）；`listenId` 随 `/transcribe` 配对；不自动删除，但让增长可见。

**服务端**（`server/modules/voice/`）

1. 复用 `resolveVoiceCaptureMode`（`voice-capture.ts:319`）给新的 `VOICE_CAPTURE_RAW`（同样 fail-closed：空白 / `off` / 未识别值一律解析为 off），在 `voice.module.ts:43` 旁一并宣告，并**把采集目录打进启动行**，让增长可见而不用读代码。
2. 把 sink 按文件种类参数化，而不是复制：将内联的 mkdir+chmod 块（`voice-capture.ts:550-551`、`:558`）抽成一个 `writeCapture(directory, fileName, bytes)`；`writeAudio` 成为它的裁剪音频调用者；新增 `rawCaptureFileName(listenId)` → `raw-<listenId>.bin`（同样的字符清洗）。`writeExclusive`（`:487`）本来就文件名无关、且已带 `-2/-3` 碰撞走查，直接复用。
3. 新增 raw 采集端口 `recordRaw({listenId, audio, meta})`：off 档不落盘、不建目录；开档写字节并产出一行 `voice.capture.raw`（`listenId` / `bytes` / `sha256` / `path`，与裁剪行同形，`sha256` 走既有的 `voiceCaptureSha256` `:596`）。由薄 service 包装，路由保持 parse / call / respond。
4. 路由：`POST /api/voice/capture/raw`（自己的 multer `single('audio')` 与自己的上限——raw 是 16kHz 单声道 PCM ≈ 32KB/s，上限取 32MB）读 `listenId` 文本字段，空值按 `/transcribe` 拒绝缺文件的方式拒绝；`GET /api/voice/capture` 返回 `{raw: boolean}`（新路由而非挂在 `/health` 上，后者是 provider 健康、由 `useVoiceAvailable` 解析）。
5. 配对：`/transcribe` 读可选的 `listenId` 文本字段（今天 multer 已经把它放进 `request.body`，只是没人读），透传给 service 后成为 capture 行的**一个附加字段**（无值时不出现该键，沿用模块既有的「缺席而非 false」约定）。**响应形状不变**，故 `voice.service.test.ts:63` 与 `voiceTranscribeGaps.test.ts:79` 两个整对象 deepEqual 仍绿。

**客户端**（`src/`）

1. `src/shared/api.ts`：按 `api.voice.transcribe`（`:672`）的既有模式加 `api.voice.captureRaw` 与 `api.voice.capture` 两个 transport；在 `transcribeVoice`（`:935`）旁加 `captureRawVoice(listenId, blob, filename)`；给 `transcribeVoice` 加可选 `listenId` 并 append 进 FormData（直连后端分支 `:969-1002` 绕过本服务端，该字段在那里无意义，只有两条代理分支携带）。
2. 「raw 采集是否开启」按 token 键控只读一次，沿用 `src/shared/voiceConfig.ts` 既有的 hydration 模式（`hydrateVoiceConfig` `:345`、`whenVoiceConfigReady` `:380`），不按次录音重复取。
3. `useVoiceInput.ts`：每次听在 `start` 里铸一个 `listenId`（新增 `CaptureSession` 字段），传进 `transcribeSegment`；在 `finalizeSession`（`:666-689`，全部段都结算完的唯一时点，且已持有整个 `CaptureSession`）**在转写提交之后**发后不管地上传：开关关或 `originalCapped` 时跳过，否则 `wavFromPcm16(concatInt16(originalChunks), STORE_SAMPLE_RATE)` → `captureRawVoice`。**绝不 await 在提交之前**——语料采集不得推迟用户看到的文字。
4. `originalCapped` 为真时 raw 按设计缺席；行里要写明，而不是留一个静默缺失的文件。

**连带（必须声明，不能靠撞）**

- `server/modules/voice/tests/voice-capture-audio.test.ts` AC5 断言 N 次尝试恰好 N 个文件（`:1093-1094`）、AC6 断言 text 档零文件（`:1141`）：**靠 raw 默认关闭**保持绿，新测试必须守住这条性质。
- 五个客户端测试用**不 spread `...actual`** 的工厂 mock `@/shared/api`，且都走到 `finalizeSession`：`voiceClipPlayback.test.tsx:37`、`voiceErrorMessages.test.tsx:273`、`voiceTranscriptRepair.test.tsx:37`、`voiceTrimCapabilityWiring.test.tsx:33`、`voiceErrorNoticePersistence.test.tsx:51`。每个都要补上新导出，否则一调用就是 undefined 抛错。

**边界（不做）**：不改 `/transcribe` 响应与识别器收到的任何东西；不改裁剪档的命名与语义；不做删除或轮转（按裁定）；不加 UI。

**风险**：raw 比裁剪上传严格更敏感（含 VAD 特意删掉的停顿）——开关默认关、独立、fail-closed，且服务端报关时客户端绝不发送。raw 是 16kHz 且经过浏览器 APM（`noiseSuppression`/`echoCancellation` 已开），**不是**检测器的精确输入（worklet 按音频图原生采样率分帧），代码与文档必须这么称呼它。超过 600s 上限的录音不产出 raw（既有行为）。

## AC

- [x] `grep -rn "VOICE_CAPTURE_RAW" server/ src/ scripts/` 有命中，且开关解析只有一处：单元测试断言 `''` / `off` / `bogus` / ` AUDIO ` 全部解析为 off，退出码 0
- [x] 关档零落盘：开关关闭时 `POST /api/voice/capture/raw` 不写文件、不建目录（测试断言，退出码 0）
- [x] 开档逐字节写盘：文件名匹配 `^raw-<listenId>\.bin$`，内容与上传字节逐字节相同（行内 `sha256` 与文件实测 `sha256sum` 相等），文件 0600、目录 0700（测试断言，退出码 0）
- [x] 同名碰撞走 `-2`：同一 listenId 上报两次，两个文件都在且字节各自保住（测试断言，退出码 0）
- [x] `GET /api/voice/capture` 的 `{raw}` 与开关一致（测试断言，退出码 0）
- [x] `/transcribe` 响应形状不变：`npx vitest run server/modules/voice/tests/voice.service.test.ts server/modules/voice/tests/voiceTranscribeGaps.test.ts` 退出码 0
- [x] `listenId` 到达 capture 行：带该字段的请求其行含它；不带的请求该行**没有**这个键（测试断言，退出码 0）
- [x] 客户端关档零请求：开关为 false 时一次完整录音不产生任何 raw 请求（测试断言，退出码 0）
- [x] 上传不阻塞提交：raw 请求永不 resolve 时，转写文本仍进入输入框（测试断言，退出码 0）
- [x] 取假形态（各自必须变红）：删掉开关门控 → 「关档零落盘」红；文件名不含 `raw-` 前缀 → 「开档逐字节写盘」红；把 raw 上传 await 到提交之前 → 「上传不阻塞提交」红
- [x] e2e：`VOICE_CAPTURE=audio VOICE_CAPTURE_RAW=1` 下用假麦克风喂一句话，`npx playwright test e2e/voice-raw-capture.spec.ts` 退出码 0，且断言采集目录同时出现 `raw-*.bin` 与 `audio-*.bin`、两者的日志行共享同一个 `listenId`
- [x] 配对完整性（语料可用）：同一 `listenId` 下 raw 文件时长 ≥ 该 listen 所有 trimmed 段时长之和，且该 listenId 的 capture 行里有非空转写文本（命令与读数写入 Evidence）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：在真实页面里用假麦克风喂一段「说话 — 长停顿（≥3 秒）— 说话」，采集目录里出现**成对**的 raw 与 trimmed 文件；raw 的时长明显长于 trimmed 之和（差值 ≈ 停顿时长），且那段停顿在 raw 上跑发货检测器判为非语音、在 trimmed 里已经不存在。**这证明「被 VAD 删掉的那部分音频」确实被采到了**——即语料本身可用，而不是「测试存在」。把实际时长读数与文件名写进 Evidence。本任务不要求任何识别质量读数，也不要求接上 Silero：那是语料到手之后的下一件事。

L_D 该轴仍暗，理由：本任务只新增采集通路，不新增领域数据能力。

L_G 该轴有读数：同一 listen 的 raw 与 trimmed 时长差，由 Evidence 给出。

## Touches

- server/modules/voice/voice-capture.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.service.ts
- server/shared/types.ts
- server/modules/voice/tests/voice-capture-raw.test.ts (new)
- server/modules/voice/tests/voice-capture-raw.false-forms.test.ts (new)
- server/modules/voice/tests/voice-capture-raw.routes.test.ts (new)
- server/modules/voice/tests/voice-capture-audio.test.ts
- server/modules/voice/tests/voice-capture-audio.false-forms.test.ts
- server/modules/voice/tests/voice-config.routes.test.ts
- server/modules/voice/tests/voiceTranscribeGaps.test.ts
- src/shared/api.ts
- src/shared/voiceConfig.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/tests/voiceRawCaptureUpload.test.tsx (new)
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/modules/chat/tests/voiceErrorMessages.test.tsx
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
- e2e/voice-raw-capture.spec.ts (new)
- playwright.config.ts
- tasks/gap-voice-pre-vad-raw-capture.md

## Evidence

Touches 增补说明：`voice-capture-audio*.test.ts` 与 `voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts` 是**连带**——新增的 `process.env.VOICE_CAPTURE_RAW` 组合根读取把 AC-143/AC-145 所钉的 `VOICE_CAPTURE` 源计数抬高一项（它们按已存在的目录读取同一形状的边界计数推广了一档），而 `VoiceService` / `VoiceRouterDependencies` 的新成员要求两处 fake 补全。`server/shared/types.ts` 是跨模块服务契约的落点（后端规范要求）。`playwright.config.ts` 为 e2e 选择注入 `VOICE_CAPTURE=audio VOICE_CAPTURE_RAW=1` 并把服务端 stdout tee 到数据目录，使 capture 行可被 spec 读到。

AC1（解析一处）：`voice-capture-raw.test.ts` AC1 —— `''` / `off` / `'   '` / `bogus` / `' AUDIO '` 全 enabled=false，`1` → true，未识别值带 warning；`grep -rn VOICE_CAPTURE_RAW server/ src/ scripts/` 有命中（resolver / 启动行 / 组合根 / 事件名 / 测试）。

AC2（关档零落盘）：`voice-capture-raw.test.ts` AC2（port 级：无目录、无行，正控开档建目录）＋ `voice-capture-raw.routes.test.ts` AC2（路由级 POST → `{stored:false}`，目录不存在）。开档正控证明零是开关造成的。

AC3（逐字节 + 权限）：`voice-capture-raw.test.ts` AC3 读数：`file=raw-<listenId>.bin nameMatch=true bytesEqual=true dirMode=0700 fileMode=0600 shaMatch=true`；路由级 AC3 同断言。

AC4（碰撞走 -2）：`voice-capture-raw.test.ts` AC4 读数：`files=[raw-...-a-2.bin raw-...-a.bin] p1Intact=true p2Intact=true`。

AC5（能力读数）：`voice-capture-raw.routes.test.ts` AC5：`GET /capture on={"raw":true} off={"raw":false}`。

AC6（响应形状）：AC 写的 `npx vitest run server/...` 在本仓命中 0 个测试文件（vitest include 为 `src/**`，服务端测试由 `tsx --test` 运行），退出码 1 —— 这是 AC 命令写错了 runner，不是实现问题。按不变式收窄并实测：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts server/modules/voice/tests/voiceTranscribeGaps.test.ts` → 12 pass / 0 fail（deepEqual 全绿，响应形状未变）。

AC7（listenId 到行）：`voice-capture-raw.test.ts` AC7（有值含键、无值无键）＋ `voice-capture-raw.routes.test.ts` AC7（`/transcribe` 只在请求带字段时把键传入 service 调用）。

AC8（客户端关档零请求）：`voiceRawCaptureUpload.test.tsx` 用例一，`captureRawVoice.mock.calls.length === 0` 且转写确实发生。

AC9（不阻塞提交）：`voiceRawCaptureUpload.test.tsx` 用例三，`captureRawVoice` 永不 resolve，`stop({send:true})` 后仍观察到 `onTranscript(text, true)`。

AC10（假形态）：`voice-capture-raw.false-forms.test.ts` 两个真实文本变异各自变红——`switch-gate-removed` → off-zero 红（`dirCreated=true`）；`no-raw-prefix` → on-bytes-name 红（`nameMatch=false`）。第三个（把 raw 上传 await 到提交之前）是客户端变异：`voiceRawCaptureUpload.test.tsx` 用例三以「永不 resolve 的上传 + 断言 send 仍发生」构造，await 化实现会让该断言超时变红（hook 的文本变异需要复制整条 import 图，故以构造式判据代替）。

AC11（e2e）：`npx playwright test e2e/voice-raw-capture.spec.ts` 退出码 0。读数：`raw.listenId=listen-muumttk7-1-vwy7n4 raw.path=.../voice-capture/raw-listen-muumttk7-1-vwy7n4.bin trimmed.listenId=listen-muumttk7-1-vwy7n4 trimmed.path=.../voice-capture/audio-1siq9yjhp1-1.bin rows=2`；`dir files=[audio-1siq9yjhp1-1.bin raw-listen-muumttk7-1-vwy7n4.bin]`。即两行共享同一 listenId，目录同时出现 raw-*.bin 与 audio-*.bin。（该 spec 依赖 config 的 `VOICE_CAPTURE_RAW=1` 选择注入与 stdout tee；上游是刻意的死地址，行/文件在失败尝试上同样写出。）

AC12（配对完整性 / 语料可用）：`voice-capture-raw.test.ts` AC12 —— 同一 listenId 下 `trimmedSec=4.00 rawSec=7.00 deltaSec=3.00`，差值恰为那段落停（3s），trimmed 行文本 `"the recogniser heard this"` 非空，两行同 listenId。这说明被 VAD 删掉的停顿确实在 raw 里、不在 trimmed 里。

AC13：`npm run lint` 退出码 0；`npm run typecheck` 三个 project（tsconfig.json / server / scripts）全退出码 0。

连带回归：`voice-capture-audio.test.ts` 11/11、`voice-capture-audio.false-forms.test.ts` 9/9（含其内部 7 个 criteria + typecheck + lint）、`voice-capture-off/text/secrets/isolation` 及其 false-forms 全绿；五个客户端 mock 补全后 37/37。

## 完成记录

续做轮（2026-10-05，本轮）：上轮 exited-not-landed 的 suite 红是 `voice-capture-audio.false-forms.test.ts` 的 `AssertionError: the run left temp copies behind: ?? server/modules/voice/__criterion-falsify-env-only-configured-base-<pid>.ts ?? ...-mut-<pid>.ts`。

复核：该文件是朴素形式（任一 `__criterion-falsify-` porcelain 行即判「有残留」），而套件并发运行多个 false-forms 文件、它们把副本写进同一个 `server/modules/voice/` 目录——在飞的兄弟（`voice-dashscope-settings.false-forms` 的 `env-only-configured` 对）会被读成本次的残留；退出后该 residue 已不在，属跨进程伪影而非真实泄漏。五个兄弟判据（isolation / off / text / secrets / dashscope-settings）早已是 pid 分域读数，唯独本文件未跟上。

修复（本分支 commit `e37f9512`）：借用兄弟判据相同的 pid 分域读数——本进程自己的副本无条件红（`own-temp-copies`），仅由他进程 pid 的临时副本构成的差集按跨进程伪影豁免（`concurrent-foreign-only=true`），任何其它增/删/改路径仍红。typecheck / oxlint 绿。

正控：他进程 `env-only-configured` 对贯穿 AC9 时为绿（`temp-copies-any=2 foreign-temp-copies=2 own-temp-copies=none`，退出码 0；旧读数在同一边界红）。负控：留下的非临时游离文件仍红（`changed-worktree-git-status: added=[?? .../__residue-probe-intentional.ts]`，退出码 1）——牙齿保留。判据文件 `voice-capture-audio.false-forms.test.ts` 9/9 仍绿；`voice-capture-raw*.test.ts` / `voice-capture-audio.test.ts` / `voice-config.routes.test.ts` / `voiceTranscribeGaps.test.ts` / `voice.service.test.ts` 合并并发运行 51 pass / 0 fail；六个客户端 voice 测试 40 pass / 0 fail；AC13 两门退出码 0。


续做轮 2（2026-10-05）。本轮 fan-in suite 红的真因定位与两处处置：

(1) 真因 = undici bad-port 抽签，非本任务缺陷。上轮 exited-not-landed 的红是 `voice-capture-text.false-forms.test.ts` 的 AC10 断言，其失败读数是 `AC10 exit=1 cases=5 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-config.routes.test.ts` —— 即 6 个用例里恰好 5 个通过。该文件独立跑 6/6 绿（多次），与本 delta 的改动只有加性 stub（`captureRaw` / `captureState` / `parseRawAudioUpload`）。这与本仓已记录的根因完全一致（undici 硬性拒收 18 个端口，`app.listen(0)` 每轮约 2% 概率抽中；同一文件在 `gap-claude-resident-slice-memory-cap` 轮已复现过一次，症状即「6 中 5 绿 + 未复现 + 独立跑绿」）。处置：不编辑该文件（它会触发 anti-drift），重跑 suite 即重抽。

(2) 本轮新发现并修复一个本 delta 引入的真实缺陷：并发伪影前缀不匹配。`voice-capture-raw.false-forms.test.ts` 的临时副本前缀原为 `__criterion-raw-falsify-`，而五个兄弟判据（off / text / secrets / isolation / dashscope-settings）的「他进程在飞副本」豁免读数是 `line.includes('__criterion-falsify-')` —— 该子串在 `__criterion-raw-falsify-` 里**不出现**，故本文件自己的副本会被兄弟读成本次残留而非跨进程伪影，把兄弟判据判红。这与本任务上轮已修的 `voice-capture-audio.false-forms.test.ts` 是同一类问题，只是方向相反（那次是本文件漏了 pid 分域，这次是本文件的前缀没进共享约定）。

修复：`TEMP_PREFIX` 改为 `__criterion-falsify-raw-`（保留 `raw` 标记，且包含共享子串）。正控：16 路并发跑全部 27 个 voice 测试文件，修复前**每轮 6 个 false-forms 判据红**（text 的红明确点名本文件副本 `removed=[?? .../__criterion-raw-falsify-switch-gate-removed-base-<pid>.ts]`），修复后 3/3 轮**全绿**。自测：本文件独立 2/2 绿；`npm run typecheck` 退出码 0；`npm run lint` 退出码 0（仅既有 warning）。AC 13/13 不变（本轮未触碰任何 AC 面）。