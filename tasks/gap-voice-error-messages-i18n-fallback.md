---
id: gap-voice-error-messages-i18n-fallback
title: 十二语言 chat 文案补齐 voice.errors.<code> 与兜底
  unknown（非英文不与英文逐字相同），code→文案映射只有一份实现，出货 composer 不再显示 transcribe+状态码
  的拼接句（AC-151）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-error-classification-and-status-table
goal_ac: AC-151
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rn "^goal_ac: *AC-151" tasks/*.md` → 0 命中；全量 165 条任务里 `goal_ac` 等于 `AC-151` 的 0 条；`grep -rln "AC-151" tasks/*.md` 只命中两条同族任务（`gap-voice-error-classification-and-status-table` 与 `gap-voice-error-envelope-contract`），两条都只是在边界段把 AC-151 列为「不做」，没有认领；`ls src/modules/chat/tests/voiceErrorMessages.test.tsx` → `No such file or directory`；`grep -rn "voice.errors" src/ shared/ server/` → 0 命中（十二个 `chat.json` 的 `voice` 块里没有任何错误键）；`grep -rn "voiceErrorMessage\|voiceErrorKey" src/` → 0 命中。同族另外两条判据（AC-152 直连与代理同码、AC-153 真实浏览器）也还没有任务认领，本条只认领「十二语言文案 + 兜底 + 映射函数」这一格。

<!-- dedup-ref --> 词表来源与前置（机制边，不是风格选择）：本条的读数要「对共享词汇表里的每个 code」成立，而今天的 `AsrErrorCode` 是**类型 union、运行期被擦除**（`shared/asr/asrRegistry.ts:132`），运行期不可枚举 —— 十二语言文案的完备性因此只能在**一个运行期词表**上成立。那份运行期词表是 `gap-voice-error-classification-and-status-table`（AC-149）的交付面（它把 union 改成 13 码并导出运行期常量，判据不许另抄数组）。所以本条 `depends_on` 那条任务，判据必须 import 出货的那个运行期常量。若那份词表在实现时还不存在，本条**不得**自建第二份词表，也不得把它抄进前端 —— 如实报告阻塞。若那条任务此后被重立为另一个 id 取代，本条的前置应重新指向取代它的那一条（真正的前置是「运行期词表只有一处」这个机制，不是某个 id）。

**这条判据要的是什么（AC-151 原文拆开）**

1. 对共享词表里的每个 code，十二个语言的 chat 文案里都有 `voice.errors.<code>`，且非空。
2. 另有 `voice.errors.unknown` 作兜底。
3. 非英文语言的文案不与英文文案逐字相同（未翻译的占位视为缺失）。
4. 没有任何文案形如「transcribe 加状态码」的拼接句。
5. 前端把 code 映射成文案的函数对词表内每个 code 返回对应文案；对未知 code 与没有 code 的失败返回兜底文案，并保留状态码。
6. 取假形态：(1) 词表新增一个 code 而不加文案 ⇒ 必须红；(2) 任一语言缺键 ⇒ 必须红；(3) 未知 code 直接显示为拼接句 ⇒ 必须红。

**现状（立案时实测，可复验）**

| 项 | 实测 |
|---|---|
| 判据文件 | `src/modules/chat/tests/voiceErrorMessages.test.tsx` → `No such file or directory` |
| 十二语言的 voice 文案 | `src/modules/i18n/locales/*/chat.json` 的 `voice` 块（en 的 `:106-117`）只有 input / stopRecording / transcribing / speak / stopSpeaking / loading / replayOriginal / replayTrimmed / stopReplayOriginal / stopTrimmedPlayback 十个键，**没有 `errors` 子对象** |
| 语言集合 | `src/modules/i18n/languages.ts` 出货 12 项（en fr es ko zh-CN zh-TW ja ru de tr it id），与 `src/modules/i18n/locales/` 的 12 个目录一一对应，每个目录都有 `chat.json` |
| 前端今天的失败文案 | `useVoiceInput.ts:548` 在拿到失败响应后抛出拼接句 `transcribe ${res.status}` 或 `transcribe ${res.status} (${code})`，`:582` 再包成 `Transcription failed: …` |
| 今天读 code 的唯一位置 | `useVoiceInput.ts:65-73` 的 `refusalCode(response)` 读响应体的 `code`（只为拼那句，读完就丢）—— code 已经在线路上，前端只是没有把它映射成文案 |
| 失败通道的形状 | `onError` 只收一个 `string`；code 与 status 在拼句那一刻就被压平，composer 再也拿不回来（这正是「保留状态码」要改的那一格） |
| 本地失败（与词表无关） | 另有 6 处 `onError`：`:507` `Recording too short` / `Audio file too small`、`:579` `No speech detected`、`:582` `Transcription failed: …`、`:647` `Mic error: …`、`:727` `Playback failed: …` |
| 展示 | `ChatComposer.tsx:253-262` 把错误当 `string` 存进 `voiceError`，4 秒计时器清掉；`handleVoiceError`（`:291`）传给 hook；`VoiceInputButton.tsx` 的 `Props.errorMsg?: string \| null` 只把字符串渲染进气泡 |
| 前端已有的 shared 值边先例 | `useVoiceInput.ts:18` 值导入 `@shared/asr/transcriptionWire`；`src/shared/tests/voiceTrimShippedRecogniser.test.ts:36` 值导入 `@shared/asr/asrRegistry` —— 前端 vitest 里值导入 shared/asr 有先例 |
| 驱动出货 composer 的配方已存在 | `src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 文件头部：`vi.hoisted` + `vi.mock('@/shared/api')` 只切 `transcribeVoice`（其余走真货），然后渲染真 `ChatComposer` 并用真 mic 按钮驱动 —— 本条的判据沿用这个配方，不绑端口、不联网、不起子进程 |
| 前端测试入口 | `vitest.config.ts` 的 include 只收 `src/**/*.test.ts(x)`，jsdom，`@shared` 别名已注册；`npm run test:client` = `vitest run` |

**要交付的事**

1. **十二语言文案**（12 个 `src/modules/i18n/locales/<lang>/chat.json`）：在 `voice` 块下新增 `errors` 对象，键 = 出货运行期词表里的每个 code 逐字（AC-149 落地后是 13 个），另加 `unknown`。每条是「发生了什么 + 怎么办」的一句话，非空；非英文语言的每一条必须与英文那条不同（不许把英文抄过去顶格，也不许留 `TODO` / 空串）。措辞质量是人读范畴，判据只读存在、非空、非英文 ≠ 英文、不是拼接句。
2. **code→文案只有一份实现**（新文件 `src/modules/chat/utils/voiceErrorMessages.ts`）：入参是「失败」（至少含 `code?: string` 与 `status?: number`，上游码串可选），出参是文案键或文案。要求：
   - 词表内每个 code → `voice.errors.<code>`；
   - 词表外的 code（未知 code）与**没有 code** 的失败 → `voice.errors.unknown`；
   - 状态码与上游码串**保留**在失败里，并由同一模块的一个「技术详情」访问器按需渲染成含状态码数字（有上游码串时也含它）的字符串 —— 判据断言数字是它的子串，**不钉周围格式**；
   - 词表来源：`import { <运行期词表常量> } from '@shared/asr/asrRegistry'`（**值**导入，名字取 AC-149 实际出货的那个；`import type` 取不到运行期数组）。**不得在本条里另抄一份 code 字符串数组**，判据文件里也不许；
   - 若 `shared/asr/asrRegistry.ts` 里还没有那个运行期常量，本条不得自建词表，如实报告阻塞。
3. **失败通道改成结构化的**（`useVoiceInput.ts`）：把服务端失败的 `{ code?, status, upstreamCode? }` 原样传给 `onError`（具体形状由实现定），由 composer 侧经第 2 步的映射取文案。**本地失败**（录音太短 / 文件太小 / `No speech detected` / `Mic error` / `Playback failed`）保持它们今天各自的专门文案，不得被兜底文案顶掉；空答案那支的 code 归 AC-149/AC-150，本条只让它走同一条映射。
4. **composer 侧**（`ChatComposer.tsx`）：把收到的失败经 `useTranslation('chat')` 的 `t` 换成文案再进 `voiceError`；**显示行为一个都不动** —— 4 秒计时器、单行气泡、无关闭按钮、无折叠详情都保持今天的样子（那是 AC-153 的交付面）。`VoiceInputButton` 的 `errorMsg` 形状不变（composer 解析完再传下去），因此本条的 Touches 不含它。
5. **判据文件**（`src/modules/chat/tests/voiceErrorMessages.test.tsx`，AC-151 的 `criterion:` 文件，只有它能认领该判据）：vitest + jsdom，按 `voiceTranscriptRepair.test.tsx` 的配方；十二语言的 `chat.json` 静态导入，词表从 `@shared/asr/asrRegistry` **值**导入。i18next 初始化时**必须关掉 `fallbackLng`**（或直接读资源对象）—— 否则某语言缺键会静默回落到英文，这条判据就成了空读数。
6. **取假形态在同一次运行内可执行**（判据里的独立 test，三段）：都通过**出货的那一份**词表/映射代码驱动，逐例打印 `base=green mutant=red which=<读的是哪条>` 与族外仍绿；变异是内存里的克隆，不写临时文件、不留残留、不起子进程。

**边界（不做）**

- 不做持续显示、关闭按钮、折叠技术详情、去掉 4 秒计时器、草稿保留（AC-153）。
- 不扩词表、不做分类函数、不改 `PROVIDER_ERROR_STATUS`（AC-149）；不改路由信封与 `upstreamCode` 的提取与合规（AC-150）；不把分类搬到前端复用（AC-152 的读数）。
- 不做 ADR-004 修订；不改 `voice.transcribe` 行形状（AC-143）；不改识别行为、提示词、模型；不联网、不跑真实上游、不跑真实浏览器。
- 不改本地失败（录音太短 / 文件太小 / `Mic error` / `Playback failed`）的既有文案，也不给它们编 code。

**已知不等价点**

- 判据读的是**文案的存在性与非同一性**，不是措辞质量：「非英文 ≠ 英文」是机器可读的替代读数，一个把英文抄成占位符的实现在这里红，但一句机器翻得别扭的中文不会红。
- 前端跑在 jsdom 上、`transcribeVoice` 是替身：不代表真实服务端信封（AC-150）与真实浏览器（AC-153）。
- `voice.errors.unknown` 是**兜底**，不代表未知 code 的语义被正确解释；语义归属是 AC-149 分类器的事。
- 「十二个语言」是 `languages.ts` 今天的出货集合：新增语言会让 AC2 的集合相等读数红，需要在同一次改动里补文案，这是有意的耦合。

## AC

- [x] AC1 判据入口与预算：`npx vitest run src/modules/chat/tests/voiceErrorMessages.test.tsx` 退出 0；判据自身零子进程、零真实监听端口、零网络（`transcribeVoice` 是替身）；末尾打印 `elapsed-ms=<n>` 且实测 < 30000（目标侧判据门是 60 秒硬上限、不可调）。打印 `subprocess-imports=<n>`。
- [x] AC2 十二语言 × 词表逐格覆盖：code 集合从 `@shared/asr/asrRegistry` 的出货运行期常量读（判据里不另抄数组）；语言集合从 `src/modules/i18n/languages.ts` 的出货 `languages` 读，并断言判据导入的 `chat.json` 数据集与它逐字相等（防「只挑几个语言」）。对词表里每个 code 断言十二个语言的 `voice.errors.<code>` 存在、是 `string`、`trim()` 后非空；`voice.errors.unknown` 同样断言一遍。逐语言打印 `lang=<值> keys=<n> missing=<…>`，末尾打印 `langs=<n> vocab=<n> cells=<n> missing=<n>`，断言 missing 为 0。**取假形态 (1) 的正式读数**：词表新增一个 code 而文案不动 ⇒ 这条必红（判据迭代的是出货词表本身）。
- [x] AC3 非英文不与英文逐字相同（未翻译占位视为缺失）：对 11 个非英文语言、每个键断言 `非英文文案 !== 英文文案`，且不等于键名、不含 `TODO` / `translation missing` 一类占位串、`trim()` 后非空。逐语言打印 `lang=<值> identical-to-en=<n>`，末尾打印 `identical=<n>`，断言为 0。**取假形态 (2) 的正式读数**：任一语言缺键或抄英文 ⇒ 这条必红。
- [x] AC4 不是拼接句（含出货路径的读数）：(a) 十二语言的全部 `voice.errors.*` 字符串里没有一条匹配 `/transcribe\s*\(?\d+/i`，也没有一条以 `transcribe` 开头；(b) 驱动**出货的 `ChatComposer`**（`transcribeVoice` 替身返回 **502 且响应体不带 `code`** 的失败），读气泡里实际显示的那句话，断言它等于当前语言的 `voice.errors.unknown` 文案（这条等式本身就是取假形态 (3)：显示拼接句则不等）；(c) 同一次失败里状态码仍被前端保留：断言失败载荷的 `status` 是 502，且出货的「技术详情」访问器对该载荷的输出**包含子串 `502`**（不钉格式）。打印 `concat-hits=<n> composer-text=<…> equals-unknown=<b> status-preserved=<b>`。
- [x] AC5 映射对所有词表 code 成立、有兜底、且有正对照：对词表里每个 code 断言映射（en 与 zh-CN 各一遍）返回的文案 === 该语言 `voice.errors.<code>` 字符串；对词表外的 code（如 `Some.Future.Code`）与**没有 code**（`undefined`）的失败断言返回该语言的 `voice.errors.unknown` 字符串。**正对照**（防「一律返回兜底」的空过）：(i) 词表内至少两个 code 的文案互不相同；(ii) 每个 code 的文案 !== 兜底文案。打印 `vocab=<n> mapped=<n> distinct-messages=<n> fallback-distinct=<b> unknown-code=<b> no-code=<b>`。
- [x] AC6 取假形态可执行（同一次运行内，三段各自 base 绿 → 变异红并指名 → 族外绿）：(i) `vocab-gains-a-code`：把出货词表克隆后追加一个合成 code ⇒ AC2 的覆盖读数必须报它十二个语言全缺，未克隆那一份同时报 0 缺（同一段代码两个方向都读得出）；(ii) `locale-missing-a-key`：把某一语言克隆后删掉一个 `voice.errors.<code>` ⇒ 覆盖读数必须恰好报出（该语言, 该 code），未克隆那份报 0；(iii) `concat-fallback`：断言拼接句形状 `transcribe 502` 确实被 AC4 的读数判红（`/transcribe\s*\(?\d+/i` 命中，且 **不等于** 当前语言的 `voice.errors.unknown`），同时出货路径的读数判绿 —— 三条一起证明「等式 + 正则」这对读数真的能分辨，而不是恒真。逐例打印 `mutation=<名> base-green=<b> mutant-red=<b> which=<…> outside-family-green=<b>`。三段都是内存克隆：不写文件、不留残留、不起子进程；跑完 `git status --porcelain` 与本任务开工时逐字相同。
- [x] AC7 既有面不退化（逐条打印 `exit=<n> name=<…>`，不是空过）：`npx vitest run src/modules/chat/tests/voiceTranscriptRepair.test.tsx src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceInputButtonName.test.tsx src/modules/chat/tests/composerDraftScoping.test.tsx src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx` 退出 0（这五个都驱动真 `ChatComposer` / 真 hook，是本条最可能顶到的既有面）；`npm run test:client`、`npm run typecheck`、`npm run lint` 各退出 0。
- [x] AC8 如实登记：判据输出与本任务完成记录里写明「本条只做十二语言 `voice.errors.*` 文案、code→文案映射与技术详情访问器、失败通道结构化、composer 的文案解析；未做持续显示 / 关闭 / 折叠详情 / 4 秒计时器移除（AC-153）、词表与分类（AC-149）、路由信封与 `upstreamCode`（AC-150）、直连路径同码（AC-152）、ADR-004 修订；未改 `voice.transcribe` 行形状；未联网、未跑真实上游与真实浏览器；本地失败（录音太短 / 文件太小 / `Mic error` / `Playback failed`）的既有文案保持原样、未给它们编 code」，并把所用运行期词表常量的**实际名字**与它当时含的 code 数记下来。

## DoD

真实落地判据：不是「加了 12 × N 个键」，而是**出货的 composer** 在一批失败上真的显示出按 code 选中的本地化文案、在没有 code 时显示出兜底文案，且那句话不是 `transcribe <状态码>` 的拼接句 —— 由执行读数证明，不由段落文字声明。承重性由四件读数证明：

(a) **词表是判据的输入，不是判据的副本**（AC2 + 取假形态 (1)）：code 集合来自 `@shared/asr/asrRegistry` 的出货运行期常量，语言集合来自 `languages.ts`；克隆后追加一个 code，同一段覆盖读数立刻报它全缺。「判据里另抄了一份词表」会让这条读数恒绿，所以 AC6 (i) 必须红在新增 code 上。

(b) **非英文是翻译，不是英文的拷贝**（AC3 + 取假形态 (2)）：11 × N 条逐字比较，删一个键立刻被指名。

(c) **显示的不是拼接句**（AC4 + 取假形态 (3)）：出货 composer 在无 code 的 502 上显示的那句话 **等于** 当前语言的 `voice.errors.unknown`；同时 `transcribe 502` 这个形状被同一对读数判红；状态码仍被保留（技术详情访问器输出含 `502`）。

(d) **有兜底不是一律兜底**（AC5 正对照）：词表内每个 code 都返回各自的文案、至少两条互不相同、没有一条等于兜底文案；只有未知 code 与无 code 才落兜底。

**跨判据的连带改动必须如实登记**：本条把 `useVoiceInput.ts` 的失败通道从 `string` 改成结构化载荷，顶到 `ChatComposer.tsx` 的 `handleVoiceError` 与它传给 `VoiceInputButton` 的 `errorMsg`；完成记录里逐条写「原来传什么、现在传什么、显示行为为什么一个都没动（那是 AC-153 的交付面）」。

**已知不等价点**：判据读存在性与非同一性，不读措辞质量；前端跑在 jsdom 与 `transcribeVoice` 替身上，不代表真实服务端信封（AC-150）与真实浏览器（AC-153）；`voice.errors.unknown` 是兜底文案，不代表未知 code 的语义被正确解释（那是 AC-149 分类器的事）；「十二个语言」是 `languages.ts` 今天的出货集合，新增语言会让 AC2 的集合相等读数红，需在同一次改动里补文案。

L_D 该轴仍暗，理由：本条读数全是字符串的存在性、相等/不等与集合大小，没有可比的数值量。
L_G 该轴仍暗，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到 jsdom 里的气泡文本。

## Touches

- src/modules/chat/utils/voiceErrorMessages.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceErrorMessages.test.tsx (new)
- src/shared/types.ts (AC4/AC5：结构化失败载荷 VoiceTranscriptionFailure / VoiceFailureReport 被 useVoiceInput 生产、ChatComposer 消费、voiceErrorMessages 映射、判据断言四处共用；AGENTS.md 强制的 frontend-module-standards 规定两个以上文件使用的同一类型落在 src/shared/types.ts 且禁止模块内另立类型文件，故该位点由规范强制；其 CHAT VOICE 组已有 VoiceSnapshot / VoicePlayState / VoiceClipPlayState 先例)
- src/modules/i18n/index.ts
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- tasks/gap-voice-error-messages-i18n-fallback.md

## 完成记录

### 交付面（做了什么）

1. **`src/modules/chat/utils/voiceErrorMessages.ts`（新）**：code→文案只有一份实现。`voiceErrorKey(failure)` 用**值**导入的运行期词表 `ASR_ERROR_CODES`（来自 `@shared/asr/asrRegistry`）决定句子键 —— 词表内 → `voice.errors.<code>`，未知 code 与没有 code → `voice.errors.unknown`；`voiceErrorMessage(failure, t)` 用调用方自己的 `t` 解析成文案（语言是调用方的，不是模块级意见）；`voiceErrorTechnicalDetail(failure)` 是技术详情访问器，输出 `状态码 · code · upstreamCode`（不翻译、不钉格式，载荷为空则输出空串）。
2. **十二个 `src/modules/i18n/locales/<lang>/chat.json`**：`voice.errors` 新增 13 个 code 键 + `unknown`，共 14 键 × 12 语言 = **168 格**。en/es/ko/zh-CN/id 五个本来已有 `voice` 块，在块内追加 `errors`；fr/zh-TW/ja/ru/de/tr/it 七个**本来没有 `voice` 块**，新建的块**只含 `errors`** —— 同块里今天缺的其余十个 `voice.*` 键（input / stopRecording / …）保持缺失、仍回落英文。判断依据：AC 只要求 `voice.errors.*`，补那 70 条没人要求、也没有判据读它，属本条的边界外。
3. **`src/modules/chat/hooks/useVoiceInput.ts`**：`refusalCode` → `refusalDetail`，返回 `{ status, code?, upstreamCode? }`（两个码串都读，且不是一回事）。服务端失败不再 `throw new Error('transcribe <status> (<code>)')`，而是把结构化载荷交给 `onError` 后 `return`；`finally` 照旧跑，读数仍上报、状态仍回 idle。`onError` 形参类型 `string` → `VoiceFailureReport`。**本地失败**（`Recording too short` / `Audio file too small` / `No speech detected` / `Transcription failed: …` / `Mic error: …` / `Playback failed: …`）**原样仍是 string**，未被兜底顶掉，也未给它们编 code。
4. **`src/modules/chat/composer/ChatComposer.tsx`**：`handleVoiceError` 形参 `string` → `VoiceFailureReport`；string 直通，结构化载荷经 `voiceErrorMessage(failure, t)` 换成当前语言文案再进 `voiceError`；`useCallback` 依赖加 `t`。
5. **`src/shared/types.ts`**：`CHAT VOICE` 组新增 `VoiceTranscriptionFailure`（`code?` / `status?` / `upstreamCode?`）与 `VoiceFailureReport = string | VoiceTranscriptionFailure`。
6. **`src/modules/chat/tests/voiceErrorMessages.test.tsx`（新）**：AC-151 的 `criterion:` 文件，9 个 test（含一条前置探针 + AC2/AC3/AC4a/AC4b/AC4c/AC5/AC6 + AC1 预算与门禁）。

### 跨判据的连带改动（逐条登记）

- **`useVoiceInput` 的失败通道**：原来 `onError?: (msg: string) => void`，服务端拒绝经 `throw` 后在 `catch` 里被压成 `Transcription failed: transcribe 502 (UNSUPPORTED_MIME)` 一个 string；现在 `onError?: (failure: VoiceFailureReport) => void`，服务端拒绝是 `{ status, code?, upstreamCode? }` 对象；`catch` 现在只再兜 `prepareUpload` / `parseTranscriptionResponse` / 网络异常这些非拒绝类错误，其文案 `Transcription failed: <msg>` 原样保留。
- **`ChatComposer.handleVoiceError`**：原来收 `string` 直接 `setVoiceError(msg)`；现在收 `VoiceFailureReport`，string 直通、对象走映射换文案。
- **传给 `VoiceInputButton` 的 `errorMsg`**：**形状一个都没动**，仍是 `string | null`，composer 解析完再传下去（所以 Touches 不含 `VoiceInputButton.tsx`，该文件确实未被改）。
- **显示行为一个都没动**：4 秒计时器（`setTimeout(…, 4000)`）、单行气泡、无关闭按钮、无折叠技术详情 —— 全部保持原样，那是 AC-153 的交付面。`voiceErrorTimer` 的 ref 与 cleanup 未改。
- **`src/modules/i18n/index.ts`（Touches 新增这一行）**：re-export `languages` 与 `Language` 类型。原因是判据文件住在 `src/modules/chat/tests/`，要读 `src/modules/i18n/languages.ts` 出货的 `languages`，而 oxlint 的 `boundaries/dependencies` 要求跨模块读走 barrel —— 实测不走 barrel 时 `npm run lint` 报一条 error（`src/modules/chat/tests/voiceErrorMessages.test.tsx:62:27: error boundaries(dependencies)`）。词表来源未变：判据读到的仍是 `languages.ts` 出货的那个值，barrel 只是 re-export。

### 判据与读数（实测）

`npx vitest run src/modules/chat/tests/voiceErrorMessages.test.tsx` → **exit 0**，9 tests passed，`elapsed-ms=370`（< 30000），`subprocess-imports=0`。

- **前置探针**（判据自己必须没有回退语言）：`fallback-probe en="EN" de="probe" no-fallback=true` —— 只加在 en 上的探针键在 de 上解析回键名本身，证明 `fallbackLng: false` 真的生效；否则「某语言缺键」会静默读成英文，AC2/AC4 恒绿。
- **AC2**：`langs=12 vocab=13 cells=168 missing=0`，逐语言 `lang=<v> keys=14 missing=0`；语言集合从 `languages.ts` 的出货 `languages` 读并与判据导入的十二个 `chat.json` 数据集做集合相等断言。
- **AC3**：`identical=0`（11 个非英文语言 × 14 键逐字比较；另逐格查非空、≠ 键名、无 `TODO` / `translation missing` 一类占位串）。
- **AC4**：`concat-hits=0`；十二个语言各驱动一次真 `ChatComposer`（`transcribeVoice` 替身返回 **502 且响应体不带 `code`**），读气泡里实际显示的那句话，**逐字等于**该语言 `voice.errors.unknown`，`equals-unknown=true`；取自真 `useVoiceInput` 的失败载荷 `status=502`，`technical-detail="502"`，`status-preserved=true`。
- **AC5**：`vocab=13 mapped=26 distinct-messages=26 fallback-distinct=true unknown-code=true no-code=true`（en 与 zh-CN 各一遍；正对照两条：26 条互不相同、每条的文案 ≠ 兜底文案）。
- **AC6**：三段全 `base-green=true mutant-red=true outside-family-green=true`：
  - `vocab-gains-a-code` → 十二个语言各报一格缺（`en:SYNTHETIC_FUTURE_CODE` … `id:SYNTHETIC_FUTURE_CODE`），未克隆那份同时报 0 缺；
  - `locale-missing-a-key` → 恰好报 `de:ACCOUNT_ACCESS` 一格，未克隆那份报 0；
  - `concat-fallback` → `transcribe 502` 被 `/transcribe\s*\(?\d+/i` 命中且 ≠ 当前语言 `voice.errors.unknown`，同一次运行内出货路径的读数判绿。
  三段全是内存克隆：`shipped-intact=true clones-in-memory=true`，不写文件、不留残留、不起子进程。
- **AC6 末句的残留读数**：判据跑完后 `git status --porcelain` 与跑前**逐字相同**（`diff` 为空），且只列出本任务的实现文件，没有任何由判据运行产生的文件。该读数由 worker 在判据外取（AC1 禁判据自身起子进程），判据内对应面是 `shipped-intact=true`。
- **AC7（逐条，全部 exit 0）**：`exit=0 name=src/modules/chat/tests/voiceTranscriptRepair.test.tsx`、`…/voiceClipPlayback.test.tsx`、`…/voiceInputButtonName.test.tsx`、`…/composerDraftScoping.test.tsx`、`…/voiceTrimCapabilityWiring.test.tsx`、`npm run test:client`（100 files / 699 tests passed）、`npm run typecheck`、`npm run lint`。

### AC8 如实登记：本条只做了什么 / 没做什么

**只做**：十二语言 `voice.errors.*` 文案（13 code + unknown）、code→文案映射（`voiceErrorKey` / `voiceErrorMessage`）、技术详情访问器（`voiceErrorTechnicalDetail`）、失败通道结构化、composer 侧的文案解析、以及为判据让路的一行 barrel re-export。

**未做**：持续显示 / 关闭按钮 / 折叠技术详情 / 去掉 4 秒计时器 / 草稿保留（AC-153）；词表扩展、分类函数、`PROVIDER_ERROR_STATUS`（AC-149）；路由信封与 `upstreamCode` 的提取与合规（AC-150）；直连路径与代理路径同码（AC-152）；ADR-004 修订；`voice.transcribe` 行形状未改（AC-143）；识别行为 / 提示词 / 模型未改；**未联网、未跑真实上游、未跑真实浏览器**；本地失败（录音太短 / 文件太小 / `No speech detected` / `Mic error` / `Playback failed`）的既有文案保持原样、未给它们编 code。

**所用运行期词表常量**：**`ASR_ERROR_CODES`**，来自 `shared/asr/asrRegistry.ts`（`Object.keys(ASR_ERROR_CODE_ALIGNMENT)`，类型级对齐保证它与 `AsrErrorCode` union 双向一致），落地时含 **13** 个 code：`ACCOUNT_ACCESS` / `UNAUTHORIZED` / `QUOTA_EXHAUSTED` / `RATE_LIMITED` / `MODEL_NOT_FOUND` / `AUDIO_REJECTED` / `CONTENT_FLAGGED` / `NO_SPEECH_DETECTED` / `UPSTREAM_UNAVAILABLE` / `NOT_CONFIGURED` / `INVALID_BASE_URL` / `OVERSIZE` / `UNSUPPORTED_MIME`。判据与出货代码都只读这一个常量，判据文件里没有另抄数组。

**已知不等价点（复核后仍成立）**：判据读的是文案的存在性与非同一性，不是措辞质量 —— 一个把英文抄成占位符的实现在这里红，但一句机器翻得别扭的中文不会红；前端跑在 jsdom 与 `transcribeVoice` 替身上，不代表真实服务端信封（AC-150）与真实浏览器（AC-153）；`voice.errors.unknown` 是兜底文案，不代表未知 code 的语义被正确解释（那是 AC-149 分类器的事）；「十二个语言」是 `languages.ts` 今天的出货集合，新增语言会让 AC2 的集合相等读数红，需在同一次改动里补文案。

**遗留**：`voiceErrorTechnicalDetail` 目前只被判据读，页面上没有展示入口 —— 折叠技术详情面板是 AC-153 的交付面；它是本条明确要求的交付物（「按需渲染成含状态码数字的字符串」），不是投机 helper。

**L_D 该轴仍暗**，理由：本条读数全是字符串的存在性、相等/不等与集合大小，没有可比的数值量。
**L_G 该轴仍暗**，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到 jsdom 里的气泡文本。

### Touches 更正（第二轮，anti-drift 硬失败后补登）

第一轮 fan-in 的 anti-drift 硬失败读数（可复现，退出码 1）：`out-of-declared: task wrote src/shared/types.ts (matches no declared Touches glob)` —— 共 1 条，正是本记录的漏登项。

漏登原因不是顺手多写：`VoiceTranscriptionFailure` 与 `VoiceFailureReport` 是**跨文件共用**的类型 —— `useVoiceInput.ts` 生产它、`ChatComposer.tsx` 消费它、`utils/voiceErrorMessages.ts` 以它作映射入参、判据文件断言它，共四处。`AGENTS.md` 强制要求前端代码遵循 `frontend-module-standards`，该规范写明「两个以上文件使用的同一类型放在 `src/shared/types.ts`」并禁止为回避导入而在模块内另立类型文件或复制类型。也就是说这个写入位点是规范强制的，不是可以换地方的实现选择；且 `src/shared/types.ts` 的 `CHAT VOICE` 组本来就住着 `VoiceSnapshot` / `VoicePlayState` / `VoiceClipPlayState`（由更早落地的语音任务加入），本条落在这里与同模块既有先例一致。

**实现与判据一个字节都没有改**：本轮只补登声明位点，随后重跑判据与既有面读数确认仍然全绿（读数见下）。为什么这条位点被判据需要：AC4 读的就是这条结构化失败载荷（驱动出货 composer、断言 `status` 保留为 502 且技术详情含子串 `502`），AC5 的映射入参也是它。

**本轮重跑读数**（实现与判据未改动，以下为补登后在当前树上重取）：

- 判据 `npx vitest run src/modules/chat/tests/voiceErrorMessages.test.tsx` → **exit 0**，9 tests passed：`fallback-probe en="EN" de="probe" no-fallback=true`、`langs=12 vocab=13 cells=168 missing=0`、`identical=0`、`concat-hits=0`、`vocab=13 mapped=26 distinct-messages=26 fallback-distinct=true unknown-code=true no-code=true`、`status=502 technical-detail="502" status-preserved=true`、三段取假形态 `base-green=true mutant-red=true outside-family-green=true`、`shipped-intact=true clones-in-memory=true`、`subprocess-imports=0`、`elapsed-ms=397`（< 30000）。
- AC7 既有面逐条：五个文件 `npx vitest run …` → **exit 0**（5 files / 32 tests passed）；`npm run test:client` → **exit 0**（100 files / 699 tests passed）；`npm run typecheck` → **exit 0**；`npm run lint` → **exit 0**（仅既有 warning，无新增）。
- anti-drift 自检（本轮补登后重跑）：`ANTI-DRIFT OK`，18 个实际文件全部落在 19 条声明位点内，0 violation。
