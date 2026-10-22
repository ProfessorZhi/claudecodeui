---
id: gap-voice-clip-single-slot-playback
title: composer 单槽保留最后一条录音并提供回放（麦克风右侧 pill，含时长元信息）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状（行号已对源码核对，并做过浏览器实测）：语音输入把用户说的话**转写完就丢掉了**。`src/modules/chat/hooks/useVoiceInput.ts` 在 `rec.onstop` 里用 chunks 拼出 `blob`（`:90`，函数内局部变量），`:99` 上传到 STT 后端，`:104` 只把 `text` 交给 `onTranscript`；函数返回后 blob 即不可达，下一次 `rec.start()`（`:77`）又把 `chunksRef` 清空。服务端同样不留档（`server/modules/voice/voice.routes.ts:91` 的 `/transcribe` 把字节转发给 STT 后端，见 `server/modules/voice/voice.service.ts:109`，不落盘、不回传音频）。所以「回放我刚才说的话」当前**不可能**：没有任何一处持有录音，也无法从服务端取回。

方案：composer 单槽保留**最后一条**录音（object URL + 元信息），并在麦克风右侧提供一个回放 pill。不做持久化——回放回答的是「我刚说了什么」，不是「整个会话的音频」。

### 硬约束（本任务的关键，已实测）

`src/modules/project-workspace/WorkspaceMain.tsx:156` 渲染的 `ChatInterface` **没有 `key`**，会话只作为 prop 传入；非 chat tab 也只是 CSS 隐藏（`:154` 的 `hidden`）。所以**切换会话、切换 tab 都不会卸载 composer 或其 hook**。不加处理的话，A 会话的录音会出现在 B 会话的 composer 里（而 composer 草稿本身是按 `draftScope` 按会话隔离的）。因此 hook 必须显式接收两个信号：

- `scope`（即 `draftScope`，由 `useChatComposerState` 暴露 → `ChatInterface` → `ChatComposer`）变化时**清空** clip 并停播；
- 不可见时（离开 chat tab，**以及**问答面板顶掉 footer 时）**只停播、不清空**。

实测证据：切换会话后 textarea 节点未被替换（`composerRemounted: false`）；补上 scope 处理后 clip 被清空。问答面板：`ChatComposer.tsx:323` 在 `hasQuestionPanel` 为真时整个 footer 不渲染，此时若 clip 还在播就**没有任何可见控件能停它**（实测音频停在 9.65s；面板撤去后 pill 以原时长回来、录音未丢）。建议把「面板停播」并入同一个 `isActive` 机制（传 `isActive={isActive && !hasQuestionPanel}`），让两条规则共用一条通路，也就不必为它单写一个 effect、且能被单测覆盖。

### 设计要点

1. **写入时机：早于上传。** `onstop` 里拼出 blob、过了 `<800` 字节阈值检查后就写入 clip，再置 `transcribing` 并上传。理由：转写失败/超时（`:106` 分支）时用户**更需要**能回放刚才说的话。
2. **单槽用 `useState`，不是 ref** —— pill 是否显示取决于 clip 是否存在，ref 触发不了重渲染。形态 `{ url: string; meta: VoiceClipMeta }`；object URL 本身让 blob 保活，`bytes`/`mimeType`/`durationMs` 在写入时算进 meta，不再回读 blob。**不要**把 revoke 写进 state updater（updater 必须纯，StrictMode 会双调用）：另设一个 ref 只用于「取旧值 + revoke」。
3. **时长用挂钟，且在 `onstop` 里只测一次**（`rec.start()` 前记时间戳，`onstop` 取差）。这里**不是**在绕已知的 `Infinity` 缺陷——实测本 Chromium 的 `MediaRecorder` 产物容器里**带** duration（`audio.duration` 是有限值：18.600839 对挂钟 19s；设了 `src` 后 `loadedmetadata` 自行触发）——而是一个取舍：pill 只显示 `M:SS`，两者差 <1s 不可见，而挂钟同步可得、无需等元素加载。将来做进度条再用容器值（`currentTime` 对两者都可用）。
4. **不需要「别 revoke 正在播的那个」保护**：`start()` 先停播，而新 clip 只能来自一次新录音，被覆盖的 clip 不可能还在播；直接 pause + revoke 即可。实测：播放中 revoke 在 Chromium 下并不会中断播放（元素已持有资源），那条保护本来就是多余的。
5. **新增 presentational 组件 `VoiceClipButton`**，插在麦克风右侧、**只在有 clip 时渲染**（`{voiceClip && ...}`，meta 存在即代表有 clip，不再另设布尔）。显示 `M:SS`，字节数用 `hidden sm:inline` 只在 `sm` 以上显示（沿用 `TokenUsageSummary.tsx:61` 的既有做法）。样式用 ghost 处理（无边框 + `hover:bg-accent`），**不要**做成 `TokenUsageSummary` 那种带边框 pill——两者并排会被读成同类东西，而一个是「上一条内容」、一个是「会话状态」。控件的可访问名称须随状态在播放/停止间切换。
6. **与朗读（TTS）互斥。** `voicePlayer` 是独立单例、自带 `audio` 元素，两路同时出声是噪音。播放 clip 前调 `voicePlayer.stop()`；并订阅 `voicePlayer`，其 `isBusy()` 为真时暂停 clip。为此给 `voicePlayer.ts` 加一个 `isBusy()`——现有接口只有按 utterance 的 `getSnapshot(id)`，缺「是否有任何朗读在播」的入口。实测：clip 播放中点朗读 → clip 停在 1.21s；朗读发起后点 pill → TTS 请求变 `net::ERR_ABORTED`（只有 `voicePlayer.stop()` 会 abort 它）。
7. **`play()` 不 await，但必须 `.catch`。** iOS 只把播放权授予在手势栈内发出的 `play()`，所以不能 await；不 catch 的话 `NotAllowedError` 或格式不支持会让控件永远卡在 loading。reject 时回到 `idle` 并经现有 `onError`（即 `ChatComposer` 的 `handleVoiceError`）弹气泡。两个坑：`DOMException` **不是** `instanceof Error`，消息模板会走 `String(e)` 分支；该气泡 4s 后自动消失，测试不要踩这个窗口。
8. **i18n**：`voice` 组加 `playRecording` / `stopPlayback`，补进**已带 voice 组的 5 个 locale**（en/es/id/ko/zh-CN；其余 7 个 locale 本来没有该组）。

### 被否掉的替代

- **不复用 `voicePlayer`**：它是 TTS 播放器，缓存键是「文本 + 语音配置」的哈希（`voicePlayer.ts:16`），未命中就 `synthesizeVoice` 去**合成**音频。录音没有可靠的文本键（转写可能失败或为空）、音频是本地 blob 而非合成、且只有一条不需要 LRU；硬塞要么伪造内容键、要么给这个类加 blob 分支破坏其单一职责。
- **不做持久化**：要让历史消息也能听，必须把音频当附件上传（`api.assets.uploadFiles`）并与 user message 绑定，是数据模型改动，超出「仅最后一条」。
- **不用 TTS 把转写文本读回来冒充**：那不是用户的声音，且 `MessageSpeakControl` 已对助手消息提供读回。

### 已知诊断（实测，不影响门）

带本实现跑 `npm run lint` 为 **147** 条诊断、退出码 0（干净树基线 144）。新增的 3 条都在 `useVoiceInput.ts`，全是 warning：两条 `react(set-state-in-effect)`（就是上面「外部信号变化 → 停播/清空」那两个 effect，仓库既有同型警告，例如 `useChatComposerState.ts:1057`），一条 `react(immutability)` 落在 `audio.src = clip.url` 那行。如实接受即可，**不要**为消警告扭曲设计。

<!-- dedup-ref -->
相邻但**不同机制**、不在本任务范围内的两点观察（登记以免丢失）：(a) composer 的 commands 与 clear 两个图标按钮同样没有可访问名称，已另立 `gap-composer-icon-buttons-unlabeled`；(b) 只配了 STT 而没有 TTS 的后端（例如 Groq）上，`useVoiceAvailable()` 仅凭 `baseUrl` 非空就判可用，`MessageSpeakControl` 因而渲染，点击后直连 `{baseUrl}/audio/speech` 必然 400（实测 `POST https://api.groq.com/openai/v1/audio/speech => 400`）。

## AC

- [x] 钩子单测：新增 `src/modules/chat/tests/voiceClipPlayback.test.tsx`，`npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 退出码 0，覆盖：录音结束后产生 clip；blob `<800` 字节时不产生 clip；**转写失败仍产生 clip**；第二次录音覆盖第一个并对旧 object URL 调 `revokeObjectURL`；`start()` 会停掉正在播放的 clip；组件卸载时 revoke。
- [x] 生命周期不变式：同一测试文件覆盖：`scope` 变化清空 clip；`isActive=false` 只停播、clip **保留**；`isActive` 恢复为 true 后该 clip 仍可重播。
- [x] 与朗读互斥：同一测试文件覆盖：播放 clip 会调用 `voicePlayer.stop()`（`vi.spyOn` 该单例）；`voicePlayer` 进入 loading/playing 时正在播的 clip 被暂停。
- [x] 失败路径：同一测试文件覆盖：`play()` reject 后 clip 状态回到 `idle`（不得停在 loading），且 `onError` 恰好被调用一次。
- [x] 时长读数：同一测试文件用 fake timers 推进挂钟后断言 `meta.durationMs` 落在录音时长的 ±20% 内；断言失败信息须**打印实测值**，不得只给一句断言失败。
- [x] 渲染面：同一测试文件覆盖：无 clip 时不渲染回放控件；有 clip 时渲染，且其可访问名称在播放/停止两态间切换。
- [x] i18n：`node -e "const fs=require('fs');const ls=['en','es','id','ko','zh-CN'];const bad=ls.filter(l=>{const v=(JSON.parse(fs.readFileSync('src/modules/i18n/locales/'+l+'/chat.json','utf8')).voice)||{};return !v.playRecording||!v.stopPlayback;});if(bad.length){console.error('missing voice keys in:',bad);process.exit(1)}console.log('ok')"` 退出码 0（失败时打印缺失的 locale）。
- [x] 静态门：`npm run lint` 与 `npx tsc --noEmit -p tsconfig.json` 均退出码 0。

## DoD

真实落地判据：要在**真实运行的前端**上用浏览器操作一遍，不以单测代替。(a) 在运行中的实例上完成一次录音（本机 Chromium 无音频设备时，可用 `AudioContext.createMediaStreamDestination()` 合成流喂给 `getUserMedia`；须写明用的是哪种方式，并如实登记「真麦克风未测」）→ composer 出现回放控件且时长为 `M:SS`；(b) 播放/暂停往返一次，记录 `currentTime` 的推进与暂停点；(c) **切到另一个会话**后控件消失——这是本任务的核心不变式，因为它不靠卸载生效；(d) 播放中**切到非 chat tab**，音频停止，且切回 chat 后控件仍在、可重播；(e) 播放中触发**真实**的 AskUserQuestion 面板（发一条让模型调用该工具的消息即可，不许插桩），音频停止，面板撤去后控件回来；(f) 375px 视口截图一份，记录工具行宽度与右簇是否换行，**并给出「临时隐藏该控件后」的同项读数作对照**——否则无法判断换行是不是本控件造成的；(g) 逐步留操作记录。

实施前须加载并遵循 `.agents/skills/frontend-module-standards/SKILL.md`（本任务只改 `src/`）。

如实登记的取舍：(1) 真麦克风采集、iOS 的手势与 `play()` 语义、Firefox/Safari 的 duration 分支均**未验证**（实测机 Chromium 无音频设备）；(2) 录音不持久化、刷新即丢，这是本任务的**范围**而非缺陷，DoD 读数不得被解读为「历史消息可回放」；(3) 会话切换即清空 clip，意味着在 A 会话录完、切到 B 再切回来就听不到了——这是「单槽」的必然代价，若要跨会话保留需另立任务。

L_D 该轴仍暗，理由：本任务是 composer 的交互补全，不新增领域能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；本任务的验证读数是 DoD 里的时长、播放点位与控件的出现/消失。

## 浏览器实测读数（DoD a–g）

环境：Playwright Chromium（headless shell 1243）驱动真实 Express 后端 + Vite 前端，`e2e/playwright.config.ts` 每轮分配独立端口与独立 `QUAY_E2E_DATA_DIR`；模型走真实网关（`v4.1flash`）。**音频输入用的是 Chromium 自带的合成采集设备（`--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`），本 host 无音频设备，真麦克风未测**；STT 后端是本地 mock HTTP 服务（只用来让录音真的发出去，不参与音频本身）。

- (a) 录 4s → composer 出现回放控件，读数 `0:04 56 KB`；录音确实离开客户端：`POST /v1/audio/transcriptions`，57389 字节；服务端语音配置 `{"baseUrl":"http://127.0.0.1:<port>/v1","sttModel":"whisper-1"}`。
- (b) 播放/暂停往返：播放期间 `currentTime` 采样 0.142 → 0.342 → … → 1.342（每 200ms 一次），暂停事件落在 **1.511657**——停在停的地方，既不是 0 也不是结尾。
- (c) 切到另一个会话（`human-alpha`）后回放控件数 **0**。这条不靠卸载生效（`ChatInterface` 无 `key`、始终挂载），是 `scope` 效应单独做到的。
- (d) 播放中切到 **Source Control** tab：暂停事件 `currentTime` = **1.218152**；切回 Chat 后控件仍在、时长不变、可重播。
- (e) 播放中触发**真实** AskUserQuestion 面板（新项目里的新会话发一条让模型调用该工具的消息，无插桩）：模型在发送后 **1894ms** 调用了该工具；15s 的 clip（`0:15 229 KB`）停在 **currentTime 2.938341**、即播放开始后 **2998ms**（远早于 clip 结束的 13.5s 上限，是"被面板停掉"而不是"自己放完"）；面板在位期间回放控件数 **0**；面板撤去后控件回来并重新播放（play 事件 `currentTime` 0）。
- (f) 375×720：带控件时工具行 x=21 宽 **231**、右簇 x=152 宽 **202**、`scrollWidth == clientWidth == 357`（**不横向溢出**）；把该控件临时 `display:none` 作对照，同项读数为工具行宽 **164**（即本控件占 67px）、右簇 x=152 宽 202 **不变**。**换行在带与不带两种状态下都是 true**，即 375px 下右簇本来就换行，与本控件无关。截图 `/tmp/voice-clip-375.png`。
- (g) 操作记录：以上每一步都由探针脚本打印一行 `[dod] …`，本文读数逐字取自这些行。探针脚本是临时物、已在提交前删除，不在 Touches 内。

探针会话说明：种子 transcript 的会话 id 是 `e2e-transcript-follow` 这类夹具名，CLI 拒绝 `--resume`（`--resume requires a valid session ID or session title`），所以 (e) 另建了一个项目、由 app 自己分配会话 id 来跑真实模型轮次。

AC 复读（本轮实测）：`npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` → 13 passed，退出码 0；AC7 的 `node -e` 检查 → `ok`，退出码 0（另核实：全仓只有 en/es/id/ko/zh-CN 五个 locale 带 `voice` 组，不存在漏翻）；`npm run lint` → 退出码 0（146 条 warning 行，其中 `useVoiceInput.ts` 2 条，均为 Proposal 已登记的 `react(set-state-in-effect)`）；`npx tsc --noEmit -p tsconfig.json` → 退出码 0。

如实登记的取舍（与 DoD 一致）：(1) 真麦克风采集、iOS 的手势与 `play()` 语义、Firefox/Safari 的 duration 分支均**未验证**；(2) 录音不持久化、刷新即丢，是本任务的**范围**而非缺陷，以上读数不得被解读为"历史消息可回放"；(3) 会话切换即清空 clip——在 A 会话录完、切到 B 再切回来就听不到，这是"单槽"的必然代价。

## Touches

- src/shared/types.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/utils/voicePlayer.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/VoiceClipButton.tsx (new)
- src/modules/chat/ChatInterface.tsx
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/chat/tests/voiceClipPlayback.test.tsx (new)
- tasks/gap-voice-clip-single-slot-playback.md
