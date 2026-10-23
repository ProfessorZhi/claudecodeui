---
id: gap-voice-clip-dual-playback
title: 录音槽两条回放：原始与裁剪后并存
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-debug-switch
goal_ac: AC-122
---
## Proposal

<!-- dedup-ref --> 本任务落地 AC-122：录音槽同时提供**原始录音**与**裁剪后音频**两条回放，人能核对「剪掉了什么」。

### 现状与缺口

录音槽今天只保留最后一条录音（`useVoiceInput` 的 `voiceClip` + `VoiceClipButton` 的 pill），且上传的就是这一条。接入裁剪后，上传体与录音槽里的不再是同一份音频 —— 若回放只给一条，人就无法判断裁剪是否剪掉了不该剪的东西（说话人自己听不出来，指标也只覆盖了转写文本）。人 yale 2026-09-21 定：**两种都提供**。

### 方案

1. `src/modules/chat/hooks/useVoiceInput.ts`：录音槽同时持有两条 clip —— `original`（原始 blob 的 object URL）与 `trimmed`（裁剪后重编码的 object URL，即实际上传的那份）；两者各自可播，任一时刻最多一条在播（第二条开始时第一条停）。`fallback === true` 时裁剪那份**不存在**，UI 要如实反映，不得造一条假的。scope/isActive 的既有规则（换会话清空、离屏停播）对两条同样生效。每条的 `Audio` 元素按需建（`ensureClipAudio(track)`），互斥由 `startingPlay(track)` 在同一次状态更新里把另一条写成 `idle` 实现，另有 `clipStartingRef` 挡住被取代的 `play()` 拒绝。
2. `src/modules/chat/composer/VoiceClipButton.tsx`：两个回放控件，accessible name 稳定可辨（`Replay original` / `Replay trimmed`，激活态 `Stop original playback` / `Stop trimmed playback`）；文案不得只靠翻译键而无可断言的名字（参照 `tabs.git` 的教训：可访问名是翻译后的标签，e2e 不能凭直觉猜）。控件另挂 `data-clip-url` 公布自己会播的那份源，供测试直接比对而不是反推。
3. `src/modules/chat/composer/ChatComposer.tsx`：把两条 clip 传到按钮。
4. `src/shared/types.ts`：`VoiceClipSlot` / `VoiceClipTrack` / `VoiceClipPlayState` 是 hook、按钮与 composer 共用的 ABI。
5. `e2e/voice-trim.spec.ts`：一次真实录音后断言两个控件都存在、指向不同的音频源、裁剪那条的容器与时长可判别地不同、且第二条开始时第一条停；回放不改变 composer 文本。
6. 五份 `src/modules/i18n/locales/*/chat.json`：四个新键（`voice.replayOriginal` / `voice.replayTrimmed` / `voice.stopReplayOriginal` / `voice.stopReplayTrimmed`）缺一份，该语言下的可访问名就会退化成键名，第 2 条判据随之失守。

### 边界（不做）

不做持久化、不做波形图、不做逐段试听；不改变既有「换会话清空 / 离屏停播」语义；不让回放影响上传体（上传永远用裁剪后那份）。

### AC-122 第 (3) 条的修正（本任务内，已写入 AC）

目标 AC-122 的 `expect` 第 (3) 条写作「裁剪后那条的字节数与时长严格小于原始那条」。**字节数方向对不上**：原始那条是 MediaRecorder 的 opus/webm，裁剪那条是重编码的 16-bit PCM WAV（约 96 kB/s 固定码率），所以剪短之后字节数反而大一个量级。本任务实测一次 2.640 s 录音：

```
original 2.640s /  17416B  (webm/opus, 容器头 1a45dfa3)
trimmed  1.850s / 177644B  (RIFF PCM WAV, 容器头 52494646)
```

「更短」在这条链上唯一可判别的读数是**时长**；字节数若能严格更小，反而说明裁剪那条不是 PCM WAV，也就是**不是实际上传的那份** —— 即它已经离开了本任务要断言的对象。因此 AC 第 4 条按这个不变量收窄（只要求时长严格更小），并把「两条字节不同、容器各异」提升为独立的第 3 条 —— 它才是挡住「两个控件指向同一份音频」这个真正假形态的判据。目标 AC-122 `expect` 第 (3) 条需要另行修正，本任务无该文件的写权限，仅在此记录。

## AC

- [x] `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 退出码 0
- [x] 录音完成后同时存在两个回放控件，accessible name 稳定可辨（`Replay original` / `Replay trimmed`）
- [x] 两者指向不同的音频源：两条 `data-clip-url` 不相等、取回后的字节序列不相等，且裁剪那条是 RIFF WAV 容器（`52494646`）而原始那条是 webm（`1a45dfa3`）
- [x] 裁剪那条的**时长**严格小于原始那条（不变量收窄理由与实测读数见 Proposal 末节），且原始那条的时长落在录音长度容差内
- [x] 任一时刻最多一条在播（第二条开始时第一条停）：以页内 `window.Audio` 注册表读**未暂停元素的 src** 判定，而不是读控件标签 —— 标签只说明应用「认为」谁在响
- [x] 回放不改变 composer 文本
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是多了一个按钮，而是**同一个录音槽里两条真实音频并存且可判别**（不同源、裁剪那条更短、不混播）。承重性由取假形态证明，四种形态都真跑过（在实现提交 `13f47ca3` 的工作树上改，跑完 `git checkout -- <file>` 复位）：

- 取假 A「只留一个控件」：不渲染 trimmed 控件 ⇒ 红在 `the recording slot offers no replay of the trimmed upload`。
- 取假 B「两条指向同一份字节」：trimmed 那条用原始 blob 建 ⇒ 先红在容器判据（`the trimmed replay is not the encoded WAV`）；撤掉容器判据后红在字节判据；再撤掉后红在时长判据（`the trimmed replay is 2.640s of a 2.640s recording`）。三连红是「不同源」与「更短」两条判据各自承重的证据，不是同一条判据的三种说法。
- 取假 C「第二条开始不暂停第一条」：⇒ 红在 `sounding`（`the recording and the trimmed audio were sounding at once`，Expected 1 Received 2）。**这一形态在只看标签判据下是绿的** —— `startingPlay(track)` 在同一次更新里把另一条写成 `idle`，标签始终自洽；所以互斥性必须从音频元素读，这正是 e2e 里 `addInitScript` 包装 `window.Audio` 建注册表的原因。
- 取假 D「`fallback` 路径上伪造一条裁剪回放」：⇒ 红在 (6) 段（`Expected: 0, Received: 1`）；该段的前提（上传体确实是录音自己的容器，`1a45dfa3`）先被断言，否则「控件缺失」可能只是「裁剪跑了但没剪掉」，断言就落空。

`fallback === true` 时不得伪造一条裁剪回放控件 —— 上条 D 即此判据。同一 ABI 的单元面在 `src/modules/chat/tests/voiceClipPlayback.test.tsx`（17 例，含互斥与 fallback 渲染）。

L_D 该轴仍暗，理由：本任务只让录音槽多保留一条派生音频并提供回放，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是两条回放的存在性、容器、时长与互斥性，不是生成质量轴读数。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/VoiceClipButton.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/shared/types.ts
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- e2e/voice-trim.spec.ts
- tasks/gap-voice-clip-dual-playback.md


判据退役登记（2026-10-04，人 yale 授权，见 tasks/gap-voice-single-continuous-input-path.md 的 Resolution）：本任务全部判据（`npx playwright test e2e/voice-trim.spec.ts -g "AC-122"`，以及双回放控件、两条不同音频源、时长严格更短、任一时刻最多一条在播）随 AC-122 一同退役 —— 原始那条回放取自 MediaRecorder 的流，该流已由 gap-voice-single-continuous-input-path 按 Proposal 移除，判据命令必然 No tests found，不得再把它的红读成本任务的回归。替代读数：回放槽改由 e2e/voice-continuous.spec.ts 的 after a stop the replay slot offers the filtered audio, and drops the raw track past the cap 腿覆盖（过滤后的音频总是提供；原始 PCM 总长超过 ORIGINAL_CAP_SEC 时 original 为 null）。