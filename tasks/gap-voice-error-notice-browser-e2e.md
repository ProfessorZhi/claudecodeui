---
id: gap-voice-error-notice-browser-e2e
title: 真实浏览器里 403 未开通 / 404 模型不存在 / 空答案 / 服务端 422
  各显示自己的中文文案，提示持续显示到关闭、下次录音时清除，草稿逐字保留，技术详情折叠展开后才读得到状态码与
  upstreamCode，页面上没有拼接句（AC-153）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on: []
goal_ac: AC-153
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rn "^goal_ac: *AC-153" tasks/*.md` → 0 命中；全量 167 条任务里 `goal_ac` 等于 `AC-153` 的 0 条；`grep -rln "AC-153" tasks/*.md` 只命中同族四条任务（`gap-voice-error-classification-and-status-table`、`gap-voice-error-envelope-contract`、`gap-voice-error-messages-i18n-fallback`、`gap-voice-error-single-classifier-two-paths`），四条都只在边界段把 AC-153 列为「不做」，没有认领；`ls e2e/voice-error-messages.spec.ts` → `No such file or directory`；`grep -rn "voice\.errors" src/` → 0 命中。`.quay/gate-events.jsonl` 里该判据的全部 4 条读数都是 `verdict=fail, exit 1`（最近一次 `2026-09-24T13:13:29Z`，stderr 里只有 `[WebServer]` 的 NO_COLOR 警告与 playwright 的「找不到测试文件」）。同族另外四条判据各认领一格：AC-149 词汇表＋分类函数＋状态表、AC-150 代理路由的失败信封与 `upstreamCode`、AC-151 十二语言文案与 code→文案映射、AC-152 两条路径逐行同码；本条认领的是**真实浏览器里的显示行为**这一格，是那四条白纸黑字让出的那一半。

<!-- dedup-ref --> 词表与前置（机制边，不是风格选择）：本条判据要读的三样东西都不在本条内 —— 「403 `AccessDenied.Unpurchased` 显示账户类文案」要求词汇表里有 `ACCOUNT_ACCESS` 且页面按 code 选文案（AC-149 的词汇表＋AC-151 的映射）；「展开后读出 `upstreamCode`」要求线路上真的有那个字段（AC-150 的信封）；「空 200 与 422 显示同一条文案」要求两支都走同一条映射（AC-151）。所以 frontmatter 的 `depends_on` 逐条点名那三条任务；真实的前置是「运行期词表 / 信封带 upstreamCode / 文案映射各只有一份实现」这三个机制，不是某三个 id —— 若其中任一条此后被重立为另一个 id 取代，本条的前置应重新指向取代它的那一条。

**这条判据要的是什么（AC-153 原文拆开）**

1. 在**设置页**选择 DashScope（凭据与地址由界面上填，不是播种配置），上游替身对**同一份录音**分别返回四种情形：403 带 `AccessDenied.Unpurchased`、404 带 `ModelNotFound`、格式正确但**为空**的答案（无语音）、以及服务端 422。
2. 页面上分别出现**对应 code 的文案**，且是**中文界面下读到中文文案**（不是英文、不是 code 字面量）。
3. 文案在 **4 秒之后仍然可见**（今天 4 秒计时清掉）；**点关闭后消失**；**开始下一次录音时也被清除**。
4. composer 里**事先输入的草稿逐字保留**。
5. **折叠的技术详情行在展开前不显示状态码，展开后读出状态码与 `upstreamCode`**。
6. 页面上**不出现** `transcribe 502` 之类的拼接句。
7. **空的 200 结果与 422 显示同一条文案**。
8. 取假形态：(1) 仍用 4 秒计时清除提示 ⇒ 必须红；(2) 仍显示拼接句 ⇒ 必须红；(3) 失败时清空草稿 ⇒ 必须红。

**现状（立案时实测，可复验）**

| 项 | 实测 |
|---|---|
| 判据文件 | 不存在（见上） |
| 计时清除 | `src/modules/chat/composer/ChatComposer.tsx:253-259`：`voiceError` 是 `useState<string \| null>`，`handleVoiceError` 在 `setVoiceError(msg)` 之后立刻 `voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000)`（`:258`）；卸载时清计时器（`:260-262`）。**这就是取假形态 (1) 的今天** |
| 提示的形状 | `src/modules/chat/composer/VoiceInputButton.tsx:35-40`：一个绝对定位的 `<span>`，只渲染 `{errorMsg}` 字符串；`errorMsg?: string \| null`（`:10`）。**没有关闭控件、没有折叠区、没有 `data-testid`、没有 `role="alert"`/`aria-live`**；整个 `src/modules/chat/composer/` 目录 0 个 `data-testid` |
| 失败通道 | `src/modules/chat/hooks/useVoiceInput.ts:331` 的 `onError?: (msg: string) => void` —— **只收一个字符串**，没有 code/status 旁路。`:543-549` 拿到非 2xx 后 `refusalCode(res)`（`:65-73`）读出响应体的 `code`，然后 `:548` 抛 `transcribe ${res.status} (${code})`；`:580-583` 再包成 `Transcription failed: …`。**这就是取假形态 (2) 的今天**（`refusalCode` 读完就丢，code 没有传下去） |
| 草稿的归属 | **不在 `ChatComposer`**：`ChatComposer.tsx:108` 的 `input: string` 是 prop（`:191` 解构，`:471-472` 绑到 textarea）。真身在 `src/modules/chat/hooks/useChatComposerState.ts:211-283`（`inputState` + `setInput`），失败路径一个字节都不碰它：唯一的写入者是 `handleVoiceTranscript`（`:986-992`），而它只被 `onTranscript`（**成功**通道）调用。⇒ 今天「草稿保留」是**没人清**的缺席读数，不是被断言的行为。取假形态 (3) 今天无从谈起 |
| 文案键 | `grep -rn "voice\.errors" src/` → 0 命中。12 个 `src/modules/i18n/locales/*/chat.json` 里**只有 5 个**（en / es / ko / zh-CN / id）有 `voice` 块，各 10 个键，**没有 `errors` 子对象**；fr / zh-TW / ja / ru / de / tr / it **连 `voice` 块都没有**。AC-151 的交付面 |
| zh-CN 的 `voice` 块 | `src/modules/i18n/locales/zh-CN/chat.json:99`，10 键（`input` = 语音输入、`stopRecording` = 停止录音、…），无错误键 |
| 可复用的现成键 | **`common.buttons.close` 在 12 个语言里都在**（zh-CN = 关闭，实测逐语言打印）。⇒ 关闭控件的可及名不必新增语言键，本条**不需要**碰任何 `locales/*.json`（若实现选择新增键，则必须 12 个语言同时补齐，并在完成记录里登记，Touches 相应加上那 12 个文件） |
| 折叠区的现成形状 | 仓库里 `<details>`/`<summary>` 有 5 处，两处就是「技术详情」形：`src/modules/chat/composer/PermissionRequestsBanner.tsx:96`（`<summary>View tool input</summary>` + `<pre>`，**同目录、结构最贴近**）与 `src/modules/project-workspace/WorkspaceErrorBoundary.tsx:53`（`t('misc.errorDetails')` + `<pre>`）。关闭按钮的现成形状：`QueuedMessageCard.tsx:60`、`ComposerAttachment.tsx:74`、`ScheduledMessageList.tsx:63`、以及 `ChatComposer.tsx:530-537` 的 `XIcon` + `tooltip` + `aria-label` 配对 |
| 没有任何既有读数钉着 4 秒计时 | `grep -rn "4000" src/` 只命中 `ChatComposer.tsx:258` 本身与三处无关的采样率/字节数；`grep -rn "voiceError" src/**/tests/` → 0 命中；没有测试渲染过那个气泡。⇒ 去掉计时器**不会**红任何既有前端测试，但 AC-153 的读数需要一个**新的**测试 |
| 会被本次顶到的既有浏览器读数 | `e2e/voice-dashscope-written.spec.ts:748-806` 是 **AC-142 的判据**（`goals/AC-142-….md:7` 的 `criterion:` 逐字是 `npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"`）。它的 `:775` 用 `page.getByText(/Transcription failed/)` 取气泡、`:796-798` 断言 `shown` 含 `'Transcription failed'`、含 `UNAUTHORIZED`、不含 `'No speech detected'`。**这三条断言在本条落地后必红**：气泡里既没有 `Transcription failed` 这句英文，折叠态下也读不到 code。同一处 `:787/:799` 的草稿逐字断言仍成立 |
| 只会变陈旧、不会红的旁证 | `e2e/voice-trim.spec.ts:91-97` 的 `VOICE_ERRORS` 数组（诊断用，只在 `:509-514` 拼一条失败消息，不是断言），其中 `'Transcription failed'` 一项会变成陈旧诊断词 |
| playwright 工装的硬预算 | `playwright.config.ts`：`BOOT_CEILING_MS = 40_000`、`RUN_CEILING_MS = 55_000`、`WATCHDOG_PROBE_MS = 2_000`（`:218-221`）；看门狗到点 `SIGKILL` 掉本次运行的所有子进程组、打一行 `[e2e] watchdog: …`、`process.exit(1)`（`:317-341`）。`:1005-1008` 的注释写明两个上限都刻意压在 60 秒判据门之下。`e2e/voice-trim.spec.ts` 单文件实测 41.1-41.3 秒 ⇒ **本条每多一条腿都在吃这个 55 秒**。AC-142 的实测是 `-g "AC-142"` 两条腿 `criterion-wall-ms=18279`、整文件三条腿 `23451` |
| 工装的自取端口与数据目录 | `playwright.config.ts:32-44`（`dataDir` = `QUAY_E2E_DATA_DIR` 或 `mkdtempSync`，并发布 `QUAY_E2E_DATA_DIR_OWNER`）、`:65-118`（内核分配的一对端口，**不是字面量**）、`:165-174`（预绑定检查）、`:1010-1040`（两个 `webServer`：`tsx server/index.ts` 与 `vite --strictPort`，各自 30 秒上限，`reuseExistingServer: false`）。⇒ **不许设 `QUAY_E2E_DATA_DIR`**，设了种子会被跳过 |
| 每个 spec 一份夹具的约定 | `playwright.config.ts:982-990` 的 `if (isDataDirOwner) { … }` 里逐个调用 `seedVoiceIdentifierWorkspace()` / `seedVoiceTrimWorkspace()` / `seedVoiceDashscopeWorkspace()` / `seedMobileSendKeyWorkspace()`；每份种子自带 `dataDir/<spec>-workspace`、自己的 `dataDir/.claude/projects/<spec>-workspace/` transcript 与自己的 WAV。WAV 必须在 config 求值时写、并通过 `process.env.QUAY_E2E_<NAME>_AUDIO` 发布（`:821-822`、`:527-530`、`:719-721`），因为 **Chromium 在浏览器启动那一刻就打开它**（`:817-820` 的注释） |
| 假麦克风与录制驱动 | 三个语音 spec 同一段 `test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', \`--use-file-for-fake-audio-capture=${AUDIO_FILE}\`, '--autoplay-policy=no-user-gesture-required'] } })`（dashscope `:141-150`）。`--use-fake-device-for-media-stream` 少了它文件被忽略、设备合成蜂鸣，**运行仍会绿**（`:137-139` 的注释）。录制驱动 `recordOnce`：点 `getByRole('button', { name: 'Voice input' })` → 等按钮改名成 `'Stop recording'` 证明真的在录 → `waitForTimeout(CAPTURE_MS)` → 点停止（dashscope `:492-501`） |
| 界面语言是靠 localStorage 播种的 | `src/modules/i18n/config.ts:296-299` 在 `languageChanged` 时 `writeUserPreference('userLanguage', lng)`，`:301-307` 从水合回来的偏好里读回。既有 spec 的 `addInitScript` 一律写三把键：`uiPreferences`、`user-preferences`（含 `userLanguage`）、`userLanguage`（dashscope `:515-527`，值 `'en'`）。⇒ 中文界面 = 把这三把键写成 `'zh-CN'`，随后**所有可及名都变成中文**：录音按钮 = 语音输入、停止 = 停止录音（`zh-CN/chat.json:99-110`），Settings/Voice 页签、项目名、会话名同理 —— 定位器要么用中文名，要么用与语言无关的锚（`select[name="providerId"]`、`[data-slot="prompt-input-textarea"]`、`a[href^="/session/"]`） |
| 上游替身只有浏览器侧一条路 | DashScope 的地址保存时按 workspace 主机名规则校验（`https://<workspace>.<region>.maas.aliyuncs.com`，见 `e2e/voice-dashscope-written.spec.ts:48-52`），**本地 127.0.0.1 的替身服务会被设置页拒掉**，所以 `voice-trim.spec.ts:385-428` 那种「真起一个本地识别器」的路子对 DashScope 走不通。AC-142 因此把 `/api/voice/transcribe`（`:239-260`）与 aliyuncs 主机（`:262-281`）都拦在浏览器侧，并在 `:92-105` 如实登记「这个替身比真实路由多给了一个 code」 |
| 前端测试入口 | `vitest.config.ts:54` 的 include 只收 `src/**/*.test.ts(x)`，`:45` jsdom；`npm run test:client` = `vitest run`。`npm run test:e2e` = `playwright test`；`scripts/test.sh` 只跑 typecheck + lint + server node:test + client vitest，**不含 playwright** ⇒ 浏览器判据不在套件里，要逐条单独驱动 |

**要交付的事**

1. **判据文件**（`e2e/voice-error-messages.spec.ts`，AC-153 的 `criterion:` 逐字所指，**只有这一个文件能认领该判据**）：真实 Chromium 沿 `playwright.config.ts` 的 webServer 起真后端＋真 Vite，`test.use` 的假麦克风喂 config 写好的 WAV，`serviceWorkers: 'block'` ＋ `permissions: ['microphone']`，`addInitScript` 把界面语言播成 `zh-CN`，走完 onboarding，**在设置页**选 DashScope 并填地址与 key（沿用 AC-142 的 `openVoiceSettings` / `providerSelect` / `fillDeclared` 形状与「provider id 从 `/api/voice/health` 载荷读、不硬编码用来选择」的纪律，`:380-450`、`:399-412`）。四条腿各自驱动一次录制，`page.route` 改的是**同一个** `/api/voice/transcribe` 处理器的应答内容（在腿之间改一个可变变量，**不要每条腿重开一个 page**——见第 6 条的预算）。四条腿的应答形状按 AC-150 定的信封（`{ error, code, upstreamCode? }`）造：
   - (a) 403 `AccessDenied.Unpurchased` ⇒ `code: 'ACCOUNT_ACCESS'`、`upstreamCode: 'AccessDenied.Unpurchased'`；
   - (b) 404 `ModelNotFound` ⇒ `code: 'MODEL_NOT_FOUND'`、`upstreamCode: 'ModelNotFound'`；
   - (c) **格式正确但为空**的 200（envelope 里既无 instruction 也无 transcript）⇒ 走前端 `useVoiceInput.ts:579` 的本地空答案支；
   - (d) 服务端 422 ⇒ `code: 'NO_SPEECH_DETECTED'`。
   腿 (c) 与 (d) 必须在同一次运行里被**互相比对**：两者的页面文案逐字相等。
   **登记**：这个替身比真实路由多给了一个 code（与 AC-142 的 `:92-105` 同一处偏差、同一句话），因为要在浏览器侧把 DashScope 的上游失败造出来；本条读的是**页面**，不是服务端分类。
2. **四条腿各自的文案**：每条腿读到的那句话必须**等于**该语言（zh-CN）下 `chat.json` 的 `voice.errors.<该腿的 code>`（腿 (c) 是 `NO_SPEECH_DETECTED`）。判据从**出货的** `zh-CN/chat.json` 静态导入取那句话来比，不另抄一份字符串；同时断言那句话是中文（与 en 的同键文案**不相等**），且四条腿之间至少有三个互不相同的句子（防「一律同一句」的空过）。腿 (c)/(d) 的那一对**必须相等**。
3. **提示的持续性与三种消失方式**（这是取假形态 (1) 的正式读数）：在一条腿里让失败真的发生（**正对照**：提示可见），随后 `waitForTimeout` 到 **4 秒之后**（如 4.5-5 秒）再断言它**仍然可见**且**逐字未变**；再点关闭控件（可及名 = zh-CN 的 `common.buttons.close`，实测 关闭）断言**消失**；另一条腿里先让提示出现、再开始下一次录音（点语音输入按钮）断言**被清除**。三个读数各自先读「清除前可见」，缺了这个正对照，「不见了」是空集上的断言。
4. **草稿逐字保留**（取假形态 (3) 的正式读数）：录制前 `fill` 一段**本轮唯一**的草稿字符串，读回确认逐字相等；每条腿失败之后（提示已真的出现）再读一次，断言仍逐字相等。**正对照**：同一段里断言提示确实出现过 —— 否则「什么都没发生所以草稿还在」也能绿。
5. **折叠的技术详情 + 没有拼接句**（取假形态 (2) 的正式读数）：**展开前**断言提示区内读不到该腿的状态码数字、也读不到 `upstreamCode` 串；点开摘要（`<details>`/`<summary>` 的现成形状见上表）后断言**读得到**状态码数字（用页面实际收到的那个状态，不硬编码）**与** `upstreamCode` 串。**正对照**在这儿是承重的：没有它，「展开前读不到」可以被一个什么都不显示的实现在空集上满足。另外，**整个运行过程中**页面上任何地方都不得出现匹配 `/transcribe\s*\(?\d+/i` 的句子（逐腿读一次 `body.innerText()`），且**页面上出现的文案不得等于拼接句**（与第 2 条的等式一起构成两条互相独立的读数）。
6. **预算（硬约束，不是建议）**：`playwright.config.ts` 的看门狗在 `RUN_CEILING_MS = 55_000` 处 SIGKILL 整次调用并 `exit 1`，60 秒判据门再外面一层；`e2e/voice-trim.spec.ts` 单文件已实测 41.1-41.3 秒。因此判据必须**共用同一个 page/context**、腿之间只改替身的应答（不重开 page、不重走 onboarding）、`CAPTURE_MS` 取既有 spec 的 1_500、只在一个地方付那次 4 秒以上的等待。判据末尾打印 `criterion-wall-ms=<n>` 并断言 < 45000（AC-142 的同类判据 `-g` 两条腿 18279、整文件三条腿 23451 是基线）；同时打印看门狗那行**没有**出现的证明（`[e2e] watchdog:` 出现在输出里即失败）。
7. **新 spec 的夹具**（`playwright.config.ts`）：按 `seedVoiceDashscopeWorkspace`（`:835-871`）的形状加一份**本条自己的**种子 —— `dataDir/voice-error-messages-workspace` 工作区、自己的一句 utterance、自己写的 WAV（在 config 求值期写、经 `process.env.QUAY_E2E_VOICE_ERROR_AUDIO` 发布，理由与注释照抄 `:817-820`）、以及 `dataDir/.claude/projects/voice-error-messages-workspace/` 下的 transcript（一条带 turn、一条带 `customTitle`，理由照抄 `:824-833`：后端启动时扫一次 `~/.claude/projects` 才起 `ignoreInitial` 的 watcher）；在 `:982-990` 的 `isDataDirOwner` 块里挂上。**判据的定位器必须锚在它自己的会话名/工作区上**，因为同一次 config 求值会把所有种子都写进去，侧栏里会有别的 spec 的会话行。
8. **联动改动（同一次改动里落地，逐条登记）**：`e2e/voice-dashscope-written.spec.ts:748-806` 是 AC-142 的判据，其 `:775`/`:796-798` 的三条断言（气泡含 `'Transcription failed'`、含 `UNAUTHORIZED`、不含 `'No speech detected'`）与本条直接冲突 —— 在同一次改动里把期望值改成新形态（提示文案按 code 选中、状态码与 `upstreamCode` 在展开后的技术详情里），**只改期望值与取提示的方式，不放松任何读数结构**：`:787/:799` 的草稿逐字断言、`:802-803` 的 `proxyPosts === 1` 与 `aliyuncsLedger === []` 一条都不许动。完成记录里逐条写「原来钉什么、现在钉什么」。`e2e/voice-trim.spec.ts:91-97` 的 `VOICE_ERRORS` 是诊断词表（不是断言），其中 `'Transcription failed'` 会变陈旧，一并更新并登记。
9. **取假形态的可执行旁证**（`src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`（新），jsdom + vitest，驱动**出货的** `ChatComposer` / 提示组件）：三例各自「未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外至少一条仍绿」：
   - (i) `four-second-timer`：把 4 秒计时清除**放回去**（等价于今天的 `ChatComposer.tsx:258`）⇒ 第 3 条的「4 秒后仍可见」必须红，而「点关闭后消失」仍绿（族外）；
   - (ii) `concat-message`：让提示显示 `transcribe <status>` 拼接句 ⇒ 第 2 条的等式与第 5 条的拼接句正则必须红，而「提示持续显示」仍绿（族外）；
   - (iii) `clear-draft-on-failure`：让失败路径在报错时清空草稿（`setInput('')`）⇒ 第 4 条的草稿逐字断言必须红，而「提示持续显示」仍绿（族外）。
   变异手段由实现定（内存克隆 / 模块替身 / 同树临时副本后即删），但必须在完成记录里写明用的是哪根杠杆、为什么其它手段不适用（AC-152 的判据用了同一句免责）；跑完 `git status --porcelain` 与本文件启动时逐字相同、无临时副本残留。**浏览器层不另造变异工装**：一次浏览器运行就是 40 秒上下，在 55 秒看门狗下跑不了「基线＋三例变异」，这一点如实登记。
10. **既有面不退化（逐条打印退出码，不是空过）**：`npx playwright test e2e/voice-dashscope-written.spec.ts`（**含被本次改期望值的 AC-142 腿**）、`npx playwright test e2e/voice-trim.spec.ts`、`npx playwright test e2e/voice-identifier-repair.spec.ts` 各退出 0；`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceInputButtonName.test.tsx src/modules/chat/tests/composerDraftScoping.test.tsx src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）与 `npm run lint` 退出 0。

**边界（不做）**：不做词汇表、分类函数、状态表（AC-149）；不做代理路由的失败信封与 `upstreamCode` 的提取与合规（AC-150）；不做十二语言 `voice.errors.*` 文案与 code→文案映射（AC-151）；不做直连路径的分类与同码（AC-152）—— 本条**消费**这四条的交付面，不复制；不做 ADR-004 修订；不改 `voice.transcribe` 日志行的形状（AC-143）；不改识别行为、提示词（`PROMPT_VERSION`）与模型；不做上传前静音检查、不做失败后自动重试、不做「打开设置」跳转按钮；不改 `acceptsMime` 契约；不改 `server/shared/types.ts` 的 `code?: AsrErrorCode` 形状；不联网、不跑真实 DashScope、不跑真机浏览器。

**已知不等价点与限制**

- 判据把 `/api/voice/transcribe` 拦在**浏览器侧**，替身直接给出带 `code`/`upstreamCode` 的信封 —— 服务端的分类与信封（AC-149/AC-150）**没有被这条判据驱动**，本条读的是页面拿到信封之后的行为。这个偏差与 AC-142 的 `:92-105` 是同一处，本条照同样的方式登记。
- 「中文文案」是机器可读的**存在性读数**（等于出货 `zh-CN/chat.json` 的那一句、且与英文不相等），不是措辞质量；一句机器翻得别扭的中文不会红。
- 上游替身 ≠ 真实 DashScope：真实 403 的响应体形状由 AC-149/AC-150 负责，本条只在替身造的短语料上读页面。
- 取假形态 (i)(ii)(iii) 的**可执行旁证在组件层（jsdom）**，不是浏览器层；它证明的是那三条读数对那三种实现在**同一个出货组件上**会变红，不证明浏览器层的同一变异也会红（浏览器层每跑一次要 40 秒上下，55 秒看门狗下跑不了四次）。这一点在第 9 条与完成记录里如实写明。
- 「开始下一次录音时也被清除」的读数是「点下一次录音之后提示消失」；它不区分「清除」与「被新一次录音的转写覆盖」。

## AC

- [x] AC1 判据入口与预算：`npx playwright test e2e/voice-error-messages.spec.ts` 退出码 0，输出里四条腿与全部行为断言都 passed；同一次运行的 wall clock 打印为 `criterion-wall-ms=<n>` 且 **< 45000**（`playwright.config.ts` 的 `RUN_CEILING_MS=55000` 看门狗会 SIGKILL 整次调用，60 秒判据门再外面一层且不可调）。断言输出里**没有** `[e2e] watchdog:` 行（有即失败，打印 `watchdog-line=<b>`）。打印 `legs=<n> passed=<n> criterion-wall-ms=<n> watchdog-line=<b>`。
- [x] AC2 四条腿各自的文案（中文界面）：设置页选 DashScope 并填地址与 key（provider id 从 `/api/voice/health` 载荷读，不硬编码用于选择）；四条腿各驱动一次录制（腿间只改替身应答，**不重开 page**），逐腿打印 `leg=<名> status=<n> code=<信封里的 code> page-said=<…> expected=<zh-CN 的 voice.errors.<code>> equals=<b> is-chinese=<b>`，并断言 `equals` 为真、`is-chinese`（该句 ≠ 同键的 en 文案）为真。四条腿的页码文案里至少 3 句互不相同。末尾打印 `legs=4 coded=<n> distinct=<n> chinese=<n>`。
- [x] AC3 空 200 与服务端 422 显示同一条文案：腿 (c)（格式正确但为空的 200）与腿 (d)（服务端 422 带 `NO_SPEECH_DETECTED`）的页面文案**逐字相等**，且都等于 zh-CN 的 `voice.errors.NO_SPEECH_DETECTED`；两条腿的 code 读数一起打印（腿 (c) 走的是前端空答案支，其「code」记为 `local-empty`）。打印 `empty-200=<…> server-422=<…> equal=<b> both-equal-vocab=<b>`。
- [x] AC4 提示持续显示到关闭（取假形态 (1) 的正式读数）：某条腿里失败真的发生（**正对照**：提示先可见，打印 `visible-first=<b>`），`waitForTimeout` 到 4 秒之后（≥4500ms）再断言**仍然可见**且文案**逐字未变**；随后点关闭控件（可及名 = zh-CN 的 `common.buttons.close`，实测「关闭」）断言**消失**；另一条腿里先让提示出现、再开始下一次录音断言**被清除**。打印 `visible-first=<b> visible-after-4s=<b> text-unchanged=<b> closed=<b> cleared-on-next-recording=<b>`。**这一条就是「仍用 4 秒计时 ⇒ 必须红」的落点**：计时器还在时 `visible-after-4s` 必为假。
- [x] AC5 草稿逐字保留（取假形态 (3) 的正式读数）：录制前 `fill` 一段本轮唯一的草稿、读回逐字相等（打印 `draft-before=<…>`）；每条腿的提示真的出现之后（打印 `notice-shown=<b>`，**正对照**）再读一次，断言仍逐字相等。打印 `draft-before=<…> notice-shown=<b> draft-after=<…> drafts-kept=<n>/<n>`。
- [x] AC6 技术详情折叠 + 没有拼接句（取假形态 (2) 的正式读数）：某条腿里展开前断言读不到该腿的状态码数字与 `upstreamCode` 串（`collapsed-hides-code=<b>`、`collapsed-hides-upstream=<b>`），点开摘要后断言读得到（`expanded-shows-status=<b>`、`expanded-shows-upstream=<b>`），展开后的读数就是「展开前读不到」的**正对照**（缺了它，一个什么都不显示的实现在空集上也满足）。四条腿每次读 `body.innerText()`，断言全轮没有任何位置匹配 `/transcribe\s*\(?\d+/i`（`concat-hits=0`），且页面文案不等于拼接句。打印 `collapsed-hides-code=<b> collapsed-hides-upstream=<b> expanded-shows-status=<b> expanded-shows-upstream=<b> status-read=<n> upstream-read=<…> concat-hits=<n>`。
- [x] AC7 夹具播种与自锚（`playwright.config.ts`）：新增本条自己的种子函数、工作区、WAV 与两条 transcript，在 `isDataDirOwner` 块里挂上；WAV 在 config 求值期写并经 `process.env.QUAY_E2E_VOICE_ERROR_AUDIO` 发布。判据的会话/项目定位器锚在本条自己的会话名上（侧栏里同时存在别的 spec 播种的会话行）。打印 `audio-file=<路径> exists=<b> workspace=<路径> session-anchor=<名> own-rows=<n>`，并断言 `QUAY_E2E_DATA_DIR` **未被**外部设置（`dataDir-owner=true`）。
- [x] AC8 取假形态可执行：`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 退出 0；三例各自「未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外至少一条仍绿」，逐例指名：`four-second-timer` 红 AC4 的 `visible-after-4s`、`concat-message` 红 AC2 的等式与 AC6 的 `concat-hits`、`clear-draft-on-failure` 红 AC5 的草稿逐字断言；跑完 `git status --porcelain` 与本文件启动时逐字相同、无临时副本残留。打印 `mutation=<名> lever=<杠杆> base-green=<b> mutant-red=<b> which=<读的是哪条> outside-family-green=<b>`。**浏览器层不另造变异工装**，这一点在同一段输出里写明理由（55 秒看门狗下跑不了「基线＋三例」）。
- [x] AC9 既有的浏览器判据不退化（逐条打印 `exit=<n> name=<…>`，不是空过）：`npx playwright test e2e/voice-dashscope-written.spec.ts`（**含被本次改期望值的 AC-142 腿**，其草稿逐字断言、`proxyPosts === 1`、`aliyuncsLedger === []` 一条不许放松）、`npx playwright test e2e/voice-trim.spec.ts`、`npx playwright test e2e/voice-identifier-repair.spec.ts` 各退出 0；`npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceInputButtonName.test.tsx src/modules/chat/tests/composerDraftScoping.test.tsx src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 退出 0；`npm run typecheck`（三套）与 `npm run lint` 退出 0。被改掉期望值的每一处逐条写「原来钉什么、现在钉什么」。
- [x] AC10 如实登记：判据输出与本任务完成记录里写明「本条只做真实浏览器里的显示行为（四条腿各自的本地化文案、持续显示到关闭、下次录音时清除、草稿逐字保留、折叠技术详情、无拼接句、空 200 与 422 同句）与其组件层三例取假形态；未做词汇表与分类与状态表（AC-149）、代理路由信封与 `upstreamCode`（AC-150）、十二语言文案与 code→文案映射（AC-151）、直连路径同码（AC-152）、ADR-004 修订；未改 `voice.transcribe` 行形状；未联网、未跑真实 DashScope 与真机浏览器；替身伪装上游失败与真实路由的偏差与 AC-142 的 `:92-105` 同一处；`upstreamCode` 的取值由替身造的响应体决定，不是真实上游响应体」，并把实际用到的运行期词表常量名、`voice.errors` 的实际键名、关闭控件实际复用的 i18n 键、以及技术详情摘要的实际构造逐条记下来。

## DoD

真实落地判据：不是 spec 文件存在，而是**真实 Chromium 里的出货页面**在设置页选中 DashScope 之后，对四种上游情形分别显示出**按 code 选中的中文文案**，提示**过了 4 秒还在**、点关闭才消失、下一次录音时被清除，事先输入的草稿**逐字还在**，折叠的技术详情**展开后才**读得到状态码与 `upstreamCode`，而页面上没有一句 `transcribe 502` 那样的拼接句 —— 由执行读数证明，不由段落文字声明。承重性由四件读数证明：

(a) **文案是按 code 选的，不是同一句话**（AC2 + AC3）：四条腿的页面文案里至少三句互不相同，而「无语音」那一对（空 200 与服务端 422）**逐字相等**。一个把什么都映射到同一句的实现会在「至少三句互不相同」上红；一个把两支分开写的实现会在那一对相等上红。

(b) **持续性不是「没被覆盖」而是「真的还在」**（AC4 + 取假形态 (i)）：4 秒之后仍可见且逐字未变，且这个读数前有「提示先可见」的正对照；把 4 秒计时放回去，同一读数在组件层立刻红。关闭与「下次录音时清除」各自也先读「清除前可见」。

(c) **草稿保留不是「什么都没发生」**（AC5 + 取假形态 (iii)）：同一段里先读提示真的出现过，再读草稿逐字相等；失败即清空的实现被指名打红。

(d) **折叠是真的折叠**（AC6 + 取假形态 (ii)）：展开前读不到、展开后读得到，两条读数是同一对；全轮 `concat-hits=0` 与「页面文案 ≠ 拼接句」是两条互相独立的读数（正则 + 等式），把 `transcribe <status>` 显示出来的实现被指名打红。

**跨判据的连带改动必须如实登记**：`e2e/voice-dashscope-written.spec.ts:748-806` 是 AC-142 的判据，其 `:775`（`getByText(/Transcription failed/)`）与 `:796-798`（含 `'Transcription failed'`、含 `UNAUTHORIZED`、不含 `'No speech detected'`）与本条的显示形态直接冲突，必须在**同一次改动**里改成新期望值 —— 取提示的方式与断言的字面量换掉，**读数结构与其余断言（草稿逐字、`proxyPosts === 1`、`aliyuncsLedger === []`）一条都不放松**；改了哪一行、原来钉什么、现在钉什么，写进完成记录。`e2e/voice-trim.spec.ts:91-97` 的诊断词表同步更新并登记。

**已知不等价点**：浏览器侧的替身直接给出带 `code`/`upstreamCode` 的信封，服务端的分类与信封（AC-149/AC-150）不被本条驱动；「中文文案」是存在性与非同一性的机械读数，不是措辞质量；取假形态的可执行旁证在 jsdom 组件层，不是浏览器层（55 秒看门狗下跑不了「基线＋三例」浏览器变异），这一点如实登记；上游替身 ≠ 真实 DashScope；`upstreamCode` 的取值由替身造的响应体决定。判据不联网、不跑真机浏览器。

L_D 该轴仍暗，理由：本条读数全是字符串相等/不等、可见性与集合大小（文案、状态码数字、正则命中数），没有可比的数值量。
L_G 该轴仍暗，理由：目标层要求的「真实浏览器里各类失败显示各自的文案」本条已到（这是 AC-153 自身），但「真机浏览器与真实 DashScope 的响应体形状」不在本条内 —— 判据跑在 Playwright Chromium 与浏览器侧替身上，真实上游的响应体形状归 AC-149/AC-150，真机冒烟归人工（ADR-004 决策 8）。

## Touches

- e2e/voice-error-messages.spec.ts (new)
- playwright.config.ts
- e2e/voice-dashscope-written.spec.ts
- e2e/voice-trim.spec.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/VoiceInputButton.tsx
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx (new)
- src/modules/chat/tests/voiceErrorMessages.test.tsx
- tasks/gap-voice-error-notice-browser-e2e.md

## 完成记录

### 交付面（每个文件钉什么）

| 文件 | 改了什么 |
|---|---|
| `e2e/voice-error-messages.spec.ts`（新） | AC-153 的判据本身：`playwright.config.ts` 的 webServer 起真后端＋真 Vite，假麦克风录真 WAV，`addInitScript` 把界面语言播成 zh-CN，走完 onboarding 后在设置页选 DashScope（provider id 从 `/api/voice/health` 读）并填地址与 key；**同一个 page/context 四条腿**，腿间只改浏览器侧替身的应答；打印每条腿的 `status/code/page-said/expected/equals/is-chinese`、`legs=4 coded=4 distinct=3 chinese=4`、`empty-200/server-422` 同句、`visible-first/visible-after-4s/text-unchanged/closed/cleared-on-next-recording`、`drafts-kept=4/4 notices-shown=4/4`、`collapsed-hides-code/…/concat-hits=0`、`dataDir-owner=true`、`close-reachable: … reaches=true`、`legs=4 passed=4 criterion-wall-ms=<n> watchdog-line=<b>`。 |
| `playwright.config.ts` | 本条自己的种子 `seedVoiceErrorMessagesWorkspace()`：工作区 `voice-error-messages-workspace`、自己的一句 utterance、**config 求值期**写 WAV 并经 `QUAY_E2E_VOICE_ERROR_AUDIO` 发布（Chromium 在浏览器启动那一刻就打开它）、`dataDir/.claude/projects/voice-error-messages-workspace/` 下两条 transcript（一条带 turn、一条带 `customTitle`），挂在 `isDataDirOwner` 块里；另把看门狗状态写进 `dataDir/watchdog-state.json`，因为 AC1 的 `watchdog-line=<b>` 是**运行器进程**打印的，spec 读不到自己的 stdout，只能读这个状态文件（`armed=true` 作正对照）。 |
| `src/modules/chat/composer/VoiceInputButton.tsx` | 默认导出回到「只有按钮」（`{state,onToggle}`）；新增命名导出 `VoiceFailureNotice`：句子在**渲染期**按 failure 的 code 解出（`voiceErrorMessage`），关闭控件复用 `common.buttons.close`，技术详情是 `<details>/<summary>`（`<pre>` 只在展开时挂载，所以折叠态提示区文本就是句子本身）。提示**不渲染在按钮里**：composer 的 form 是 `relative overflow-hidden`（`PromptInput` 的壳，为了把高亮层裁到圆角），锚在按钮上方画出去的提示会被裁掉，关闭控件那一行正好落在 form 盒外、由聊天面板接走指针。 |
| `src/modules/chat/composer/ChatComposer.tsx` | `voiceFailure` 存 `VoiceFailureReport` 而不是字符串；**4 秒计时器与卸载清理删除**；提示层渲染在 `chat-composer-shell`（与既有的 ActivityIndicator 同层、同为 form 的兄弟），`handleVoiceToggle` 在开始下一次录音时清除，`dismissVoiceFailure` 是关闭控件的回调。 |
| `src/modules/chat/hooks/useVoiceInput.ts` | 本地空答案支 `onError?.('No speech detected')` → `onError?.({ status: res.status, code: 'NO_SPEECH_DETECTED' })`（**这一处由 AC3 强制**，见下）。 |
| `e2e/voice-trim.spec.ts` | `VOICE_ERRORS` 诊断词表最后一项从字面量 `'No speech detected'` 改成读出货 `en/chat.json` 的 `voice.errors.NO_SPEECH_DETECTED`。 |
| `src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`（新） | 取假形态三例（组件层 jsdom，驱动**出货的** `ChatComposer`）。 |

### 为什么 `useVoiceInput.ts` 进了 Touches（预检读数）

用 dist 的 `checkTaskAntiDrift` 在提交后的树上对 `develop...HEAD` 的实际改动集预检：

- 按立案时声明的 Touches：`ok=false`，`{"type":"out-of-declared","file":"src/modules/chat/hooks/useVoiceInput.ts"}`
- 补上那一行后：`ok=true`（9 个 glob，0 violation）

这一改由 AC3 强制：「空的 200 结果与 422 显示**同一条**文案」要求本地空答案支把 `NO_SPEECH_DETECTED` 这个 **code** 交出去（而不是它今天写死的那句英文）；没有它，腿 (c) 的 `equals` 与 `is-chinese` 都必红。空答案与上游 422 是同一个条件（录到了、但没话可写），所以两支必须落到同一个词表成员上，而句子的语言归属留在显示层。

### AC 读数（逐条）

- **AC1** `exit=0`；`legs=4 passed=4 criterion-wall-ms=24249 watchdog-line=false`（`1 passed (24.2s)`；预算 45000，看门狗 55000）。`watchdog-line` 由 config 写下的 `watchdog-state.json` 读回：`armed=true fired=false`。
- **AC2** 四腿各 `equals=true is-chinese=true`：
  - `leg=account-403 status=403 code=ACCOUNT_ACCESS page-said="该账户无法使用这个语音服务——请确认订阅与模型权限已生效，然后重试。"`
  - `leg=model-404 status=404 code=MODEL_NOT_FOUND page-said="该账户用不了这个转写模型——请在语音提供方设置里换一个模型。"`
  - `leg=empty-200 status=200 code=local-empty page-said="录音里没有检测到人声——请靠近麦克风重新录制。"`
  - `leg=server-422 status=422 code=NO_SPEECH_DETECTED page-said="录音里没有检测到人声——请靠近麦克风重新录制。"`
  - `legs=4 coded=4 distinct=3 chinese=4`（三句互不相同；那一对相等即 AC3）。
- **AC3** `empty-200="录音里没有检测到人声——请靠近麦克风重新录制。" server-422="…（逐字相同）" equal=true both-equal-vocab=true`。腿 (c) 的「code」记为 `local-empty`，因为它走的是前端空答案支，线路信封里没有 code。
- **AC4** `visible-first=true visible-after-4s=true text-unchanged=true closed=true cleared-on-next-recording=true`。正对照 `visible-first` 先读，4 秒读数取 `waitForTimeout(≥4500)` 之后；关闭控件的可及名是 zh-CN 的 `common.buttons.close`（关闭）。另打印 `close-reachable: notice-top=468 notice-bottom=549 form-top=553 element-at-close=path reaches=true` —— 这条读数就是「提示必须画在 form 之外」的证据：提示底边 549、form 顶边 553，落在关闭控件中心的是提示自己。
- **AC5** `drafts-kept=4/4 notices-shown=4/4`，四腿各 `draft-before="keep this failure-message draft character for character <n> <腿名>"` 与 `draft-after` 逐字相等（`draft-before` 是录制前 `fill` 进去再读回的**本轮唯一**字符串）。
- **AC6** `collapsed-hides-code=true collapsed-hides-upstream=true expanded-shows-status=true expanded-shows-upstream=true status-read=403 upstream-read=AccessDenied.Unpurchased concat-hits=0`；四条腿每次读 `body.innerText()`，全轮没有位置匹配 `/transcribe\s*\(?\d+/i`。
- **AC7** `audio-file=/data/scratch/yale/quay-e2e-BQeZKv/voice-error-messages-utterance.wav exists=true workspace=/data/scratch/yale/quay-e2e-BQeZKv/voice-error-messages-workspace session-anchor=voice-error-messages own-rows=1`、`dataDir-owner=true`（`QUAY_E2E_DATA_DIR` 未被外部设置 ⇒ 种子没有被跳过）。`own-rows=1` 是锚在本条自己的会话名上的侧栏行数，同一次 config 求值还写了别的 spec 的种子。
- **AC8** `npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` → `Tests 3 passed (3)`：
  - `mutation=four-second-timer lever=the pre-change timer restored in the failure handler, unmutated copy imported first base-green=true mutant-red=true which=AC4 visible-after-4s outside-family-green=true (AC4 closed-on-close-control) noticed=true`
  - `mutation=concat-message lever=the failure handler hands the notice the chain's own concatenated sentence base-green=true mutant-red=true which=AC2 sentence-equals-code-copy + AC6 concat-hits outside-family-green=true (AC4 visible-after-4s) noticed=true`
  - `mutation=clear-draft-on-failure lever=the failure handler clears the composer's own input through the channel it is given for it base-green=true mutant-red=true which=AC5 draft-kept outside-family-green=true (AC4 visible-after-4s) noticed=true`
  - `[voice-error-mutation] copies-written=3 removed-now=3 leftover-in-tree=[]`；跑完 `git status --porcelain` 与该文件启动时逐字相同（`diff` 为空），目录里 0 个 `__mutation-*` 残留。
- **AC9** 逐条（`exit=<n> name=<…>`）：
  - `exit=0 name=npx playwright test e2e/voice-dashscope-written.spec.ts`（3 passed, 23.0s，**含被兄弟提交改过期望值的 AC-142 腿**）
  - `exit=0 name=npx playwright test e2e/voice-trim.spec.ts`（4 passed, 39.8s）
  - `exit=0 name=npx playwright test e2e/voice-identifier-repair.spec.ts`（1 passed, 13.8s）
  - `exit=0 name=npx vitest run …voiceClipPlayback …voiceInputButtonName …composerDraftScoping …voiceTranscriptRepair`（4 passed）
  - `exit=0 name=npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`（3 passed）
  - `exit=0 name=npm run typecheck`（`tsc -p tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 三套各 0）
  - `exit=0 name=npm run lint`
  - 另：`e2e/**` 与 `playwright.config.ts` 不在任何工程 tsconfig 里，用一条 ad-hoc 命令单独验（`--strict --moduleResolution bundler --resolveJsonModule`，四个 spec ＋ config）：`exit=0`。
- **AC10** 见下。

### 联动改动：原来钉什么、现在钉什么

1. **AC-142 的腿**（`e2e/voice-dashscope-written.spec.ts:748-806`）：这条腿的期望值在本条落地前已经**被兄弟提交 `38c1025c` 改到新形态**（在 develop 上，本条只验证不重改 —— 本条对该文件的 delta 为空）。原来钉：`page.getByText(/Transcription failed/)` 取气泡，`shown` 含 `'Transcription failed'`、含 `'UNAUTHORIZED'`、不含 `'No speech detected'`。现在钉：按 code 从运行期读出的出货英文句子（`en/chat.json` 的 `voice.errors`），「录音前不存在 → 录音后出现」两端，以及 `REFUSAL_ENVELOPE.code` 选中的那句与 `NO_SPEECH_DETECTED`、`unknown` 兜底三者两两不等。**没有放松任何读数结构**：草稿逐字、`proxyPosts === 1`、`aliyuncsLedger === []` 均未动（该文件的 delta 为空即可证明）。
2. **`e2e/voice-trim.spec.ts:91-97` 的诊断词表**：原来第 4 项是字面量 `'No speech detected'`（本地空答案支当时直接交给 composer 的英文）。现在读 `src/modules/i18n/locales/en/chat.json` 的 `voice.errors.NO_SPEECH_DETECTED` = `"No speech was found in the recording — record again and speak closer to the microphone."`。三项**链自身**写死的英文（`'Recording too short'` / `'Audio file too small'` / `'Transcription failed'` / `'Microphone access denied'`）保持字面量：它们是 `useVoiceInput` 自己写的传输层失败，没有语言层拥有它们；`Transcription failed:` 那句在 `useVoiceInput.ts` 的 catch 支里仍然存在（请求**抛错**时走它），所以它不是死词。这是**诊断词表**（只在失败消息里拼一行 `app reported=…`），不是断言，也不改变徽标行为。该文件还顺手把这条从 JSON 读取写成了 `fs.readFileSync(path.resolve(process.cwd(), …))`：本包是 ESM、spec 由 Node 的 ESM 加载器求值，JSON 静态 import 需要 `with { type: 'json' }`，而本仓库没有 spec 那么写（第一版用了静态 import，运行器直接 `TypeError: Module … needs an import attribute of "type: json"`，改后正常）。

3. **AC-151 的判据取提示的方式**（`src/modules/chat/tests/voiceErrorMessages.test.tsx`，其 `criterion:` 见 `goals/AC-151-每个错误码在全部语言里都有非空文案-并有兜底文案-文案不是拼接的状态句.md:7`）：这条判据的 AC4b（「出货 composer 在每种语言下都显示该语言的兜底句」）原本从**麦克风按钮**往上爬两层、取「第一个既不是按钮也不含按钮的子元素」的 `textContent` —— 那正是 `VoiceInputButton` 自己渲染气泡时的形状（`<span class="relative inline-flex">{句子}<PromptInputButton/></span>`）。本条落地后那个气泡不在了：composer 的 form 是 `relative overflow-hidden`，画在 form 里面的提示会被 form 顶边裁掉，关闭控件（提示的第一行）落在 form 盒外、由聊天面板接走指针 —— 而 AC4 要求点得动关闭控件（判据自己读 `close-reachable: … reaches=`），所以提示只能是 form 的兄弟、从 composer 自己的 shell 画出来（与它上面的 ActivityIndicator 同层）。于是 AC4b 的**取提示的方式**改到提示自己的层（`[data-testid="voice-error-notice"]`），**读数结构一条没放松**：仍是整层的全部 `textContent`、仍与 `voice.errors.unknown` **逐字相等**（不是 `includes`，所以「正确句子后面粘着传输层句子」仍是另一个字符串）、仍在该层不存在时返回 `null`（「什么都没显示」不能读成「显示了正确句子」）。这与 AC-142 的腿在本条显示形态落地时得到的处理是同一类：**只改取提示的方式与期望值，不放松读数**。`bubbleText` → `noticeSentence` 的文档注释里写明了搬家理由与那条 `close-reachable` 读数。
   **实测（同一个文件，改前改后）**：改前 12 种语言全部 `composer-text="" equals-unknown=false`（爬到了按钮自己的图标层，读到空串）→ 该用例红；改后 12 种语言全部 `composer-text="<该语言的 voice.errors.unknown>" equals-unknown=true` → `9 passed (9)`。这一对读数同时证明新取法**不是空过**：什么都没显示时它照样红。

### 取假形态的杠杆（AC8）

三例用**同一根杠杆**：读出货 `src/modules/chat/composer/ChatComposer.tsx` 的源码 → 在一个锚点（`voiceFailure` 状态 + `handleVoiceError` 那 4 行）上做**一次**字符串替换（`split(anchor)` 命中数必须恰好为 1，否则抛错，避免改错文件）→ 写到同目录 `__mutation-<名>-ChatComposer.tsx` → 动态 import → 读读数 → `afterAll` 删除并断言目录里 0 个 `__mutation-*`。三根被否的杠杆：模块替身（`vi.mock`）要**再实现一遍**被测组件，读到的是替身不是出货文件；原地改留下变异树，本文件一旦崩溃就删不掉；内存克隆无法作为模块 import 到 JSX 变换里。三例都是「出货源码 + 一处锚定编辑」，别的字节不动。

第 (iii) 例的形态值得记一句：composer 的草稿是**受控 prop**（`input` + `onInputChange`，真身在 `useChatComposerState`），组件能清草稿的唯一通道就是它拿到的那个回调，所以变异体走的就是那条通道（`onInputChange({target:{value:''}})`）——这正是改动前的父层 `setInput('')` 等价物。

**浏览器层不另造变异工装**：一次判据运行实测 24.2-24.5 秒，`playwright.config.ts` 的看门狗在 55 秒处 SIGKILL 整次调用、60 秒判据门外再一层，跑不了「基线＋三例」；三例的可执行旁证因此在**同一个出货组件的 jsdom 层**，判据文件只读出货构建。这一点连同理由写在 AC8 的输出里（`[voice-error-mutation] registration: …`）。

### 登记（AC10）

本条只做**真实浏览器里的显示行为**：四条腿各自的本地化文案、提示持续显示到关闭、下次录音时清除、草稿逐字保留、折叠技术详情、无拼接句、空 200 与服务端 422 同句；以及组件层三例取假形态。**不做**：词汇表/分类函数/状态表（AC-149）、代理路由的失败信封与 `upstreamCode` 的提取（AC-150）、十二语言 `voice.errors.*` 文案与 code→文案映射（AC-151）、直连路径的分类与同码（AC-152）——本条**消费**这四条的交付面。不做 ADR-004 修订；未改 `voice.transcribe` 日志行形状；未改识别行为/提示词/模型；未做上传前静音检查、失败自动重试、「打开设置」跳转按钮；未联网、未跑真实 DashScope、未跑真机浏览器。

实际用到的运行期事实，逐条记下：

- **运行期词表常量**：`ASR_ERROR_CODES`（`@shared/asr/asrRegistry`），经 `voiceErrorKey`（`src/modules/chat/utils/voiceErrorMessages.ts`）映射到语言键；判据在输出里打印了常量名与映射函数的路径。
- **`voice.errors` 的实际键名**（读出货 `zh-CN/chat.json`）：`[ACCOUNT_ACCESS,UNAUTHORIZED,QUOTA_EXHAUSTED,RATE_LIMITED,MODEL_NOT_FOUND,AUDIO_REJECTED,CONTENT_FLAGGED,NO_SPEECH_DETECTED,UPSTREAM_UNAVAILABLE,NOT_CONFIGURED,INVALID_BASE_URL,OVERSIZE,UNSUPPORTED_MIME,unknown]`（14 个）。
- **关闭控件复用的 i18n 键**：`common.buttons.close`（zh-CN = 关闭）；没有新增任何语言键，`locales/*.json` 一个字节未动。
- **技术详情摘要的实际构造**：`<details data-testid="voice-error-details">` + `<summary data-testid="voice-error-details-summary" aria-label="Technical details" title="Technical details">`（字面量——没有语言键命名 disclosure，详见该文件里的理由）+ `<pre data-testid="voice-error-technical">` 只在展开时挂载；所以折叠态提示区的 `textContent` 是**句子本身**（关闭控件的名字在 `aria-label`/`title` 里，摘要的名字也在属性里，都不是文本节点）。
- **替身与真实路由的偏差**：与 AC-142 的 `e2e/voice-dashscope-written.spec.ts:92-105` 同一处、同一句话——替身在**上游拒绝**时多给了一个 code（真实路由只为上游**之前**的拒绝码重发 code）。`upstreamCode` 的取值由替身造的响应体决定，不是真实上游响应体；服务端的分类/信封没有被本条判据驱动。
- **写库方式**：`quay task edit … --body-file`（Provider ABI 的 CLI 前端，与 MCP `task_write` 同一写路径），写后用 byte diff 验证落库内容与送出的 body 逐字相同 —— 不手改任何 `- [ ]`/`- [x]` 字符。

## Needs-Human

**执行 2026-09-24T18:10:34.959Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=32305 server/modules/voice/tests/voice-capture-text.false-forms.test.ts passed=false end_ms=1790273323418
- run_id：wk-prod-anchor
- session_id：5debdf69-c242-42c2-8b34-6cc625de4671
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-error-notice-browser-e2e~wk-prod-anchor~1790273242324-15ad43.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-error-notice-browser-e2e-wk-prod-anchor.log

### 第 4 轮（2026-09-27）suite 红归因：landed 的兄弟判据在任何非空 delta 上必红，重派发不能逃逸

**唯一红**：`server/modules/providers/tests/claude-host-per-run.test.ts`（`kind=assert`，890ms），逐字：

    not ok - server/modules/providers/tests/claude-host-per-run.test.ts:
      AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts

**机制（确定性，不是负载抖动）。** 该判据的 `AC6`（`:575-613`）在 delta 非空时断言：

    const vsDevelop = filesOf(gitMaybe(['diff', '--name-only', 'develop...HEAD']));
    if (vsDevelop.length > 0) assert.equal(vsDevelop.includes(DRIVER_PATH), true, '…');

fan-in 的 `merge-develop` 让 `develop` 成为 HEAD 的祖先，于是 `develop...HEAD` 恰好是**当前 worktree 自己那条分支的 delta**：只有**创建 driver 的那一条分支**才含 `DRIVER_PATH`，**其它任何任务分支**必不含 ⇒ 必红。兄弟任务自己的完成记录正是这条的正面读数：`gap-session-hosts-claude-per-run-driver` 的 AC6 打印 `vsDevelopFiles=4 … driverInDelta=true`。

**本任务树上的 standalone 读数**（工作树逐字干净）：

    $ npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts
    gitDiff workingTreeFiles=0 vsDevelopFiles=8 containsNeighbour=false driverExists=true driverInDelta=false
      AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, …

`vsDevelopFiles=8` 就是本任务 Touches 列表里的 8 个文件；`workingTreeFiles=0` 证明判据没有碰到任何未提交文件；`DRIVER_PATH` 在 develop 上存在（`driverExists=true`）且既不在本任务 delta 里、**也不可能在**（本条不碰 `providers/**`）。

**其它文件全绿（in-log 读数）**：`src/modules/chat/tests/voiceErrorMessages.test.tsx passed=true`、`src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx passed=true`、`voice-capture-text.false-forms.test.ts passed=true`；该轮 `# tests 246 / pass 245 / fail 1`。

**同轮第二个任务、完全不同 delta、同一个唯一红**：`gap-ac027-gateway-wait-weaker-than-assertion`（delta 只有一个文件 `e2e/model-library.spec.ts`）在同一时段（`suite-end 2026-09-27T04:21:56Z`）也是 `# tests 245 / pass 244 / fail 1`，唯一红就是同一个文件、同一句文案（931ms）。两条 delta 交集为空 ⇒ 这是 fleet 级串扰，不是任何一条任务的 delta。

**为什么重派发解决不了**：该断言对「delta 非空且不含 driver」的**每一个** worktree 都成立，且 `900ms` 内即抛（没有 spawn、没有超时）。develop 上当前没有任何修复提交 —— `git log --all --oneline -- server/modules/providers/tests/claude-host-per-run.test.ts` 只有 `05db7d4a`（判据自身的落地提交），它随 driver 任务的 fan-in 在 `2026-09-27T03:21:16Z` 才落到 develop，本任务 `04:16Z` 的全量 suite 是它落地后的第一次全量。

**需要的修法（与已 done 的 `gap-debug-agent-ac10-reads-the-whole-branch-delta` 同类同形）**：给该断言**按分支设门** —— 仅当 `git rev-parse --abbrev-ref HEAD` 等于 `task/gap-session-hosts-claude-per-run-driver` 时求值；其它分支上打印分支名与理由、**不求值**（读数行仍在，不是静默跳过）。⛔ 不得删掉或改成恒真，并须配负控制（在 owner 分支上违反不变量时仍然红）。这正是 ac10 立案时给出的修法 (a)，其落地提交 `b5d6c663` 已在 develop 上，形状可照抄。本轮已按此形状另立修复任务 `gap-claude-host-per-run-delta-scope-gate`（Touches 指向该判据文件），以免 fleet 上每条带代码 delta 的任务都停在这一条断言上。

**本任务自身状态**：10/10 AC 保持满足（工作树 delta 与本文件启动时逐字相同）；本轮 scoped gate 绿（`scripts/test.sh --for-task … --allow-thin` → `# tests 2 / pass 2 / fail 0`，exit 0）；scoped-gate cache 已按 develop sha `5b6d3f3f70b39675798a8732e3212df2142b4347` 写入。承重的浏览器判据（四条腿、4 秒持续、草稿逐字、折叠技术详情、无拼接句）在最近一次全绿运行里的读数见上一节，本轮未改任何实现字节。

## Needs-Human

**执行 2026-09-27T04:35:00.255Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-host-per-run.test.ts:   AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts
- run_id：wk-prod-anchor
- session_id：9011c081-ce58-45ad-95f5-ec245943aee4
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-error-notice-browser-e2e~wk-prod-anchor~1790483390115-bfb12b.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-error-notice-browser-e2e-wk-prod-anchor.log


**第 5 轮（2026-09-27）闭环：第 4 轮判定的 suite 红已由 develop 修复，本任务 10/10 AC 保持满足。** 第 4 轮另立的修复任务 `gap-claude-host-per-run-delta-scope-gate` 已落地 develop `d320ac5b`（`fix(providers): scope AC6's driver-in-delta assertion to its own branch`）：该判据的 AC6 现在按分支设门，仅在 owner 分支 `task/gap-session-hosts-claude-per-run-driver` 上求值，其它分支打印读数并记 `evaluated=false`。本工作树已 merge 该提交，standalone 读数 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts` → `# tests 7 / # pass 7 / # fail 0`（该文件即上一轮唯一红，`kind=assert`，890ms 即抛、无 spawn）。本轮**未改任何实现字节**（`git diff 85a0083e HEAD -- src/ e2e/ playwright.config.ts` 为空 ⇒ 此前四条腿的浏览器读数仍对应同一棵树）。`fan-in-ac-completion-gate --worktree` = 10/10；anti-drift = 8 actual ⊆ 10 declared；scoped gate `# tests 2 / # pass 2 / # fail 0`，exit 0。故上面两条「标 needs-human」的阻碍原因已消除，不再需要人工介入。