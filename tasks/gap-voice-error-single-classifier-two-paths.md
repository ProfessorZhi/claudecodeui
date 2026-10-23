---
id: gap-voice-error-single-classifier-two-paths
title: 浏览器直连路径与代理路径适配器对同一批（状态、响应体码串）夹具逐行同码，分类只有一份实现在共享识别目录，码串表补 OpenAI
  兼容四条拼写（invalid_api_key / model_not_found / insufficient_quota /
  rate_limit_exceeded）（AC-152）
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
goal_ac: AC-152
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rln "^goal_ac: *AC-152" tasks/*.md` → 0 命中；全量 166 条任务里 `goal_ac` 等于 `AC-152` 的 0 条；`grep -rln "AC-152" tasks/*.md` 只命中同族三条任务（`gap-voice-error-classification-and-status-table`、`gap-voice-error-envelope-contract`、`gap-voice-error-messages-i18n-fallback`），三条都只在边界段把 AC-152 列为「不做」，没有认领；`ls src/shared/tests/voiceErrorClassification.test.ts` → `No such file or directory`；`grep -rn "invalid_api_key\|model_not_found\|insufficient_quota\|rate_limit_exceeded" shared/ server/ src/ scripts/` → 0 命中（四条 OpenAI 兼容拼写一个字都还没进树）；`grep -rn "errorCodeForStatus" shared/ server/ src/ scripts/` → 只命中三份**各自独立**的 per-adapter 映射与两个既有判据。相邻但机制不同的三条：AC-149 认领「词汇表扩充 + 状态表恰一行 + 分类函数落在共享识别目录」，AC-150 认领「代理路由的失败信封与 `upstreamCode` 合规」，AC-151 认领「十二语言文案与 code→文案映射」；本条认领的是**两条路径逐行同码 + 码串表含 OpenAI 兼容拼写 + 直连路径接线**这一格。

<!-- dedup-ref --> 与 `gap-voice-error-classification-and-status-table`（AC-149）的关系（机制边，不是风格选择）：AC-152 的判据原文要的是「同一批夹具**分别经**浏览器直连路径的分类与经代理路径适配器的分类，得到逐行相同的 code」，而且要「分类函数在仓库里只有一份实现，位于共享的识别目录，前端与适配器都从那里取用」——这两条读数都**以那一份分类函数存在为前提**。那份函数是 AC-149 的交付面（它把 `AsrErrorCode` 改成 13 码、把分类放进 `shared/asr/asrRegistry.ts`、并让三个适配器都接到它上面）。所以本条 `depends_on` 那条任务；本条**不得**自建第二份分类函数或第二张码串表 —— 若实现时那份函数还不存在，如实报告阻塞。AC-149 的任务在自己的边界段逐字写着「不把分类另抄一份给直连路径（AC-152 的读数）」，本条是它白纸黑字让出的那一半。若那条任务此后被重立为另一个 id 取代，本条的前置应重新指向取代它的那一条（真正的前置是「共享识别目录里只有一份分类实现」这个机制，不是某个 id）。

**这条判据要的是什么（AC-152 原文拆开）**

1. 同一批（上游状态、响应体）夹具，经**浏览器直连路径的分类**与经**代理路径适配器的分类**，得到**逐行相同**的 code。
2. 夹具**既含百炼的码串**，也含 **OpenAI 兼容服务的常见码串**：`invalid_api_key`、`model_not_found`、`insufficient_quota`、`rate_limit_exceeded`。
3. 分类函数在仓库里**只有一份实现**，位于共享的识别目录，**前端与适配器都从那里取用**。
4. 取假形态：(1) **客户端另写一份分类函数** ⇒ 必须红；(2) **直连路径只按状态分类** ⇒ 同状态不同码串的夹具行必须红。

**现状（立案时实测，可复验）**

| 项 | 实测 |
|---|---|
| 判据文件 | 不存在（见上）。AC-152 的 `criterion:` 逐字是 `npx vitest run src/shared/tests/voiceErrorClassification.test.ts` |
| 「两条路径」在树里是什么 | 同一条缝的两个分支，都在 `src/shared/api.ts` 的 `transcribeVoice`（`:724`）：`:746` 的 `transport === 'proxy-only'` 分支走 CloudCLI 代理（`api.voice.transcribe`，`:757`），`:758` 的 `if (config.baseUrl.trim())` 分支是**浏览器直连**上游端点（`createTranscriptionRequest` 之后 `:770` 原样 `return fetch(request.url, request.init)`），`:777` 是无 baseUrl 时的代理回落。另一侧的「代理路径适配器」是服务端 `voice.service.ts` 按 provider id 从 `shared/asr/asrRegistry.ts` 的 `resolve(id)` / `listProviders()` 选出的适配器（id 实测：`openai-compatible`、`multimodal`、`dashscope-omni`） |
| **直连路径今天根本不分类** | `src/shared/api.ts:770` 原样把上游的状态与响应体交回调用方，**一个 code 都不算**。调用方 `src/modules/chat/hooks/useVoiceInput.ts:65-73` 的 `refusalCode` 只从响应体里**读** `code`（上游原始响应体里没有这个字段），`:548` 于是拼出 `transcribe <status>`。⇒ AC-152 要的「直连路径的分类」在树里今天是**空的** |
| **OpenAI 兼容的四条拼写不在任何表里** | `grep -rn "invalid_api_key\|model_not_found\|insufficient_quota\|rate_limit_exceeded" shared/ server/ src/ scripts/` → 0 命中。今天三份 `errorCodeForStatus`（`openai-compatible.asr-provider.ts:148`、`multimodal.asr-provider.ts:449`、`dashscope-omni.asr-provider.ts:569`）都只读状态：`401\|403→UNAUTHORIZED`、`429→RATE_LIMITED`、其余 `UPSTREAM_ERROR` |
| **代理侧 openai-compatible 适配器不读响应体** | `openai-compatible.asr-provider.ts:226-232`：`if (!response.ok) { return { ok: false, code: errorCodeForStatus(response.status), … } }` —— 整个文件没有 `readTextQuietly`。⇒ 即使码串表里有了那四条拼写，这个适配器也**看不见**它们。对照另外两个：`dashscope-omni`（`:648-662`，`readTextQuietly` + `isModelNotPurchased`）与 `multimodal`（`:520-539`，`readTextQuietly` + `looksLikeInvalidApiKey`）都在 `!ok` 分支里读体 |
| 今天的词汇表 | `shared/asr/asrRegistry.ts:132-142` 的 `AsrErrorCode` = NOT_CONFIGURED / INVALID_BASE_URL / UNAUTHORIZED / RATE_LIMITED / TIMEOUT / UNREACHABLE / OVERSIZE / UNSUPPORTED_MIME / NO_SPEECH_DETECTED / UPSTREAM_ERROR；`AsrFailure`（`:179`）是 `{ ok: false; code; message; status? }` |
| 适配器的驱动缝 | `shared/asr/asrRegistry.ts` 的 `resolve(providerId)`（`:454`）/ `tryResolve`（`:449`）/ `listProviders()`（`:444`）；`AsrAdapter.transcribe(request, invocation)`（`:326`）的 `invocation` 带 `fetchImpl` 与 `timeoutMs`（`:193-215`），所以出货适配器可用替身 transport 端到端驱动，判据不需要深路径 import 任何适配器模块 |
| 直连路径的驱动配方已存在 | `src/shared/tests/voiceProviderFailClosed.test.ts`：`vi.stubGlobal('fetch', …)` + `setVoiceProviderProfile({ id, capabilities })`（从 `@/shared/api` 导出）+ `resetVoiceConfig()`，然后真的 `await transcribeVoice(new Blob(['audio']), 'recording.webm')` —— 出货的直连分支被端到端驱动，不绑端口、不联网。配置水合的配方在 `src/shared/tests/voiceConfigHydration.test.ts` |
| 适配器的驱动配方已存在 | `src/shared/tests/voiceTrimShippedRecogniser.test.ts:36` 起：把出货适配器用替身 `invocation.fetchImpl` 驱动，读回来的 `AsrResult.code`。`@shared/asr/asrRegistry` 的**值**导入在前端 vitest 里有先例（同文件，别名见 `vitest.config.ts:38` → 仓库根 `shared/`） |
| 前端测试入口 | `vitest.config.ts:54` 的 include 是 `src/**/*.test.ts(x)`，`:45` 是 jsdom —— 判据文件名必须正好落在 `src/shared/tests/`，判据命令只收这一个文件 |

**要交付的事**

1. **码串表补上 OpenAI 兼容的四条拼写**（表在 `shared/asr/asrRegistry.ts`，AC-149 的落地处；本条只加行、不改表的形状与匹配纪律）：`invalid_api_key`→`UNAUTHORIZED`、`model_not_found`→`MODEL_NOT_FOUND`、`insufficient_quota`→`QUOTA_EXHAUSTED`、`rate_limit_exceeded`→`RATE_LIMITED`。真实 OpenAI 形状是 `{"error":{"message":…,"type":"invalid_request_error","code":"invalid_api_key"}}` —— 码串在 `error.code` 里、也可能出现在 `error.type` 或消息里，沿用 AC-149 定下的**子串**匹配即可。**顺序敏感**：`insufficient_quota` 与 `rate_limit_exceeded` 都是 429，不得被更宽的 429 状态兜底抢走；`model_not_found` 不得被更宽的 `not_found` 一类规则抢走。若 AC-149 的实现已经用「长码串优先」一类手段，本条不另立规则。
2. **代理侧 `openai-compatible` 适配器开始读响应体**（`openai-compatible.asr-provider.ts` 的 `!response.ok` 分支，`:226-232`）：读体文本、交给共享分类器，与另外两个适配器同形（读不到体就是空串 ⇒ 走状态兜底，不是错误）。这是本条**独有**的一格 —— AC-149 的判据只把夹具驱动到**出货的 dashscope 适配器**（它 AC5 的原文），openai-compatible 是否读体没有被它钉住，而今天实测不读。若 AC-149 落地时顺手接上了，本条只确认并把它纳入判据的驱动面，不做重复改动。
3. **浏览器直连路径接线**（`src/shared/api.ts` 的直连分支，`:758-771`）：上游答了非 2xx（或传输层 reject / abort）时，用**共享的那一份**分类函数把（状态、响应体文本）分类，并把结果作为该次失败的 `code` 交给调用方 —— 信封形状与 AC-150 在代理路由上定的保持一致（`{ error, code, upstreamCode? }`），因为前端两条路径读的是同一个字段。**判据读的是「出货的直连分支端到端驱动一次，读回来的 code」**：返回一个带信封的 `Response` 还是另出一个具名入口由实现定，但必须是**出货的缝**，且客户端不得另写一张表。传输层 reject / abort ⇒ 无状态 ⇒ `UPSTREAM_UNAVAILABLE`。读体必须 clone，不能把调用方还要用的响应耗掉（`useVoiceInput.ts:65-73` 已是这个纪律）。
4. **判据文件**（`src/shared/tests/voiceErrorClassification.test.ts`，AC-152 的 `criterion:` 逐字所指，**只有这一个文件能认领该判据**）：同一批夹具逐行驱动三条出货缝 —— (a) 直连路径 `transcribeVoice`（`vi.stubGlobal('fetch')` + 已发布 profile + 带 baseUrl 的配置），(b) 出货 `openai-compatible` 适配器，(c) 出货 `dashscope-omni` 适配器（后两者经 `resolve(id).transcribe(request, invocation)` 驱动，`invocation` 带替身 `fetchImpl`）。夹具表、分组读数、单一实现读数与**两例取假形态**都写在本文件里 —— 判据命令只收这一个文件，取假形态放进第二个文件会**不被驱动**。**导入形状**：值导入 `@shared/asr/asrRegistry`（`import type` 取不到运行期值）。
5. **两例取假形态在同一文件内可执行**：都用**出货的缝**驱动、变异在内存里（`vi.mock` / 模块替身），不写临时文件、不留残留、不起子进程；每例「未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外至少一条仍绿」。见 AC5。

**边界（不做）**：不扩词汇表、不做分类函数本体与状态表（AC-149）—— 本条只在既有码串表上**加四行**并把那份既有函数接到直连路径上；不改代理路由的信封与 `upstreamCode` 的提取与合规（AC-150）；不做十二语言文案与 code→文案映射（AC-151）；不做持续显示、折叠技术详情与真实浏览器（AC-153）；不做 ADR-004 修订；不改 `voice.transcribe` 行形状（AC-143）；不改 `multimodal` 适配器与 `dashscope-omni` 适配器（AC-149 已把它们接到共享分类上，本条只驱动它们读数，不写它们）；不改识别行为、提示词（`PROMPT_VERSION`）与模型；不改 `acceptsMime` 契约；不改 `server/shared/types.ts` 的 `code?: AsrErrorCode` 形状；不加失败重试、不做上传前静音检查；不联网、不跑真实上游。

## AC

- [x] AC1 判据入口与预算：`npx vitest run src/shared/tests/voiceErrorClassification.test.ts` 退出 0；判据自身零子进程、零真实监听端口、零网络（`globalThis.fetch` 是替身）；末尾打印 `elapsed-ms=<n>`，实测 < 30000（目标侧判据门是 60 秒硬上限、不可调）；打印 `subprocess-imports=<n>` 与 `git-clean-after=<b>`（跑完 `git status --porcelain` 与启动时逐字相同）。
- [x] AC2 夹具逐行、两条路径同码：夹具表每条是 `(上游状态, 响应体文本) → 预期 code`；逐条经 (a) 出货直连路径与 (b) 出货适配器各驱动一次，断言 `direct === adapter === expected`。逐行打印 `row=<状态>|<码串> expected=<code> direct=<code> adapter=<code>`。必须覆盖：403 `AccessDenied.Unpurchased`→ACCOUNT_ACCESS、400 `Arrearage`→ACCOUNT_ACCESS、401 `InvalidApiKey`→UNAUTHORIZED、403 无码串→UNAUTHORIZED、429 `AllocationQuota.FreeTierOnly`→QUOTA_EXHAUSTED、429 `Throttling.AllocationQuota`→QUOTA_EXHAUSTED、429 `Throttling.RateQuota`→RATE_LIMITED、404 `ModelNotFound`→MODEL_NOT_FOUND、400 `InvalidParameter`+音频时长→AUDIO_REJECTED、400 `DataInspectionFailed`→CONTENT_FLAGGED、500 / 503 / 408 各一条→UPSTREAM_UNAVAILABLE、传输层 reject→UPSTREAM_UNAVAILABLE、200 且 envelope 里既无 instruction 也无 transcript→NO_SPEECH_DETECTED，**以及 OpenAI 兼容四条**：401 `invalid_api_key`→UNAUTHORIZED、404 `model_not_found`→MODEL_NOT_FOUND、429 `insufficient_quota`→QUOTA_EXHAUSTED、429 `rate_limit_exceeded`→RATE_LIMITED。**表外码串兜底**一条：403 带 `SomethingElse.New`→UNAUTHORIZED（落状态兜底，不被猜成别的码）。末尾打印 `rows=<n> openai-family=<n> agreed=<n> unknown-code-fallback=<code>`，断言 `agreed === rows` 且 `openai-family >= 4`。
- [x] AC3 同状态不同码必须不同（「只按状态分类」的直接读数）：按状态分组，断言 400 组码集大小 ≥ 2 且 `Arrearage` 与 `DataInspectionFailed` 两行码不等；429 组码集大小 == 2 且两条 QUOTA_EXHAUSTED（`AllocationQuota.FreeTierOnly`、`insufficient_quota`）与两条 RATE_LIMITED（`Throttling.RateQuota`、`rate_limit_exceeded`）分属两个码；404 组码集大小 == 2（`ModelNotFound` / `model_not_found` 的 MODEL_NOT_FOUND 与裸 404 的 UPSTREAM_UNAVAILABLE）。**正对照**（防「不等」是空集上的断言）：同状态同码的两对确实存在 —— 401 `InvalidApiKey` 与 401 `invalid_api_key` 同为 UNAUTHORIZED；403 无码串与 403 `SomethingElse.New` 同为 UNAUTHORIZED。打印 `status=400 codes=<a,b,…> status=429 codes=<…> status=404 codes=<…> distinct400=<n> distinct429=<n> distinct404=<n> same-code-control=<b>`。
- [x] AC4 分类只有一份实现、两条路径都从它取用：打印 `classifier-defs=<n> table-defs=<n> adapter-local-tables=<n> client-local-tables=<n> client-imports-shared=<b>`。断言：分类函数的**定义点**在仓库里恰好一处且落在 `shared/asr/`（名字从出货导出读）；码串表的定义点恰好一处；三个适配器里不再有各自的映射表（保留的同名导出只允许是一次转发调用）；`src/shared/api.ts` 到达分类函数的方式是**从 `@shared/asr/…` 值导入出货符号**，不是本地重述。**这一条是源码读数、不是主读数**：按行文本的 grep 会命中注释（本仓库已有先例），所以这条只允许读**导入语句与定义点**这两类构造，承重性由 AC5 的可执行变异提供 —— 完成记录里要写明这一点。
- [x] AC5 两例取假形态可执行：两例各自「未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外至少一条仍绿」，变异在内存里（模块替身），跑完 `git status --porcelain` 与启动时逐字相同、无残留；逐例打印 `mutation=<名> base-green=<b> mutant-red=<b> which=<读的是哪条> outside-family-green=<b>`：
  - (i) `client-second-table`（**取假形态 (1)**：客户端另写一份分类函数）：把**共享分类器**换成「无条件 `UPSTREAM_UNAVAILABLE`」的替身并重驱直连路径 —— 直连路径的夹具行必须**全部跟着变**（红）。这条读的是**耦合**：客户端的答案完全由共享那一份决定；若客户端自己带一张表，它的答案不会跟着变 ⇒ 变异不红 ⇒ 被抓住。同一根杠杆对 (b) 适配器行集合同样施加一次，证明**适配器**也完全由共享那一份决定。
  - (ii) `direct-status-only`（**取假形态 (2)**：直连路径只按状态分类）：把共享分类器换成**只读状态**的替身（等价于今天的 `errorCodeForStatus`）并重驱直连路径 —— AC3 点名的同状态不同码行必须红（400 组塌成一个码、429 组塌成一个码、404 组塌成一个码，200 那一行不再可能是 NO_SPEECH_DETECTED），而 AC3 的**正对照**行（401 两行同为 UNAUTHORIZED、403 两行同为 UNAUTHORIZED）仍绿。
  - 若实现时 `vi.mock` 拦不住某条缝的模块边，实现可以改用等价的**内存替换**手段，但必须在完成记录里写明用的是哪根杠杆、为什么 `vi.mock` 不适用；判据只读「变异后预测族是否红、族外是否绿」。
- [x] AC6 既有面不退化（逐条打印 `exit=<n> name=<…>`，不是空过）：`npx vitest run src/shared/tests/voiceProviderFailClosed.test.ts`（**驱动出货直连路径的那一个**，本条最可能顶到的既有面）、`npx vitest run src/shared/tests/voiceConfigHydration.test.ts src/shared/tests/voiceTrimShippedRecogniser.test.ts src/modules/chat/tests/voiceTranscriptRepair.test.tsx src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx src/shared/asr/tests/asrContractInvariants.test.ts`、`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch.test.ts`（AC-139 的判据）各退出 0；`npm run test:client`、`npm run typecheck`、`npm run lint` 各退出 0。被本条的码串表扩充顶到期望值的既有读数（若有）在同一次改动里只改期望值、不放松结构，并在完成记录里逐条写「原来钉什么、现在钉什么」。
- [x] AC7 如实登记：判据输出与本任务完成记录里写明「本条只做码串表加四条 OpenAI 兼容拼写、代理侧 openai-compatible 适配器读响应体、浏览器直连路径接上共享分类、两路径逐行同码判据与两例取假形态；未做词汇表扩充与分类函数本体、状态表（AC-149）、代理路由信封与 `upstreamCode`（AC-150）、十二语言文案（AC-151）、真实浏览器与持续显示（AC-153）、ADR-004 修订；未改 `voice.transcribe` 行形状；未联网、未跑真实上游」；并把**直连路径分类结果的实际形状**（返回带信封的 `Response` 还是具名入口）与**共享分类函数 / 码串表的实际符号名与所在文件**记下来 —— AC4 与 AC5 的读数依赖这两个名字。

## DoD

真实落地判据：不是「判据文件存在」，而是**出货的浏览器直连路径**与**出货的代理路径适配器**对同一批（上游状态、响应体码串）夹具真的给出**逐行相同**的 code，且这个 code 由**共享识别目录里的那一份实现**产生 —— 由执行读数证明，不由段落文字声明。承重性由四件读数证明：

(a) **两条路径真的同码**（AC2）：同一批夹具分别经三条出货缝（`transcribeVoice` 直连分支、`openai-compatible` 适配器、`dashscope-omni` 适配器）驱动，`direct === adapter === expected` 逐行为真。夹具里同时有百炼码串与 OpenAI 兼容码串 —— 后者今天在整个仓库里零命中，是本条独有的交付面。

(b) **不是「只按状态分类」**（AC3 + 取假形态 (ii)）：400 组三个码、429 组两个码、404 组两个码，且同状态同码的正对照两对同时为真；把分类器换成只读状态的替身，这些分组立刻塌掉而正对照仍绿 —— 「按码串分类」与「按状态分类」是两条可分辨的读数。

(c) **只有一份实现**（AC4 + 取假形态 (i)）：AC4 读定义点与导入边（不是读散文），AC5 (i) 用「共享那一份被换掉后两条路径的答案都跟着变」证明客户端与适配器都不带自己的表 —— 一个客户端自带表的实现不会跟着变，从而被抓住。

(d) **既有面逐条绿**（AC6）：直连路径最直接的既有判据 `voiceProviderFailClosed.test.ts` 与 AC-139 的 `voice-provider-dispatch.test.ts` 逐条退出码读出绿。

**已知不等价点**：判据跑在**替身 fetch** 上，上游的响应体形状（JSON 里 `error.code`）是判据自己造的，不等于真实百炼或真实 OpenAI 的响应体；「码串来自哪个上游」在判据里只是夹具标签 —— 两条路径用的是同一份函数，所以判据读到的是**同码**，而不是「两个上游各自被正确区分」。`vi.mock` 的变异是**模块替身**，它证明的是耦合方向，不等于逐字节复制了一份出货实现。L_D 该轴仍暗，理由：本条读数全是字符串相等与集合大小（code 字符串、码集大小、定义点个数），没有可比的数值量。L_G 该轴仍暗，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到 HTTP 响应与适配器返回值。

## Touches

- shared/asr/asrRegistry.ts
- shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts
- src/shared/api.ts
- src/shared/tests/voiceErrorClassification.test.ts (new)
- tasks/gap-voice-error-single-classifier-two-paths.md

## 完成记录

**本条做了什么**（AC-152）：(1) `shared/asr/asrRegistry.ts` 的码串表 `UPSTREAM_CODE_RULES` 加四条 OpenAI 兼容拼写 —— `invalid_api_key`→`UNAUTHORIZED`、`model_not_found`→`MODEL_NOT_FOUND`、`insufficient_quota`→`QUOTA_EXHAUSTED`、`rate_limit_exceeded`→`RATE_LIMITED` —— 按该表既有的「长码串优先」纪律插在长度对应的位置（四条都短于它们上面的每一条点号规则、不短于下面的），不另立规则、不改表的形状与匹配纪律。(2) 代理侧 `openai-compatible` 适配器读响应体：**AC-149 落地时已经接上**（`classifyUpstreamFailure(response.status, await readTextQuietly(response))`），今天实测已在读体，本条只确认并把该行纳入判据的驱动面，**未做重复改动**。(3) `src/shared/api.ts` 的浏览器直连分支接线。(4) 新判据 `src/shared/tests/voiceErrorClassification.test.ts`（AC-152 的 `criterion:` 逐字所指，只此一个文件）。

**直连路径分类结果的实际形状**（AC7 点名要记）：**返回带信封的 `Response`**，不是另出具名入口。非 2xx 与传输层失败都返回 `new Response(JSON.stringify({ error, code, upstreamCode? }), { status })`，字段形状与 `server/modules/voice/voice.routes.ts` 的 `sendFailure` 逐字一致（前端两条路径读的是同一个字段，见 `refusalCode`）。`2xx` 且信封里读得到文本时**原样返回上游那个 `Response`**（调用方照旧自己解析，既有行为一字未改）；`2xx` 且信封里既无 `instruction` 也无 `transcript` 时返回 `422` + `code: 'NO_SPEECH_DETECTED'`，与代理路由对该失败的 422 一致。传输层 reject / abort 没有状态可说 ⇒ `UPSTREAM_UNAVAILABLE`，状态 502。读体一律走 `response.clone()`，不耗掉调用方还要用的响应；替身 transport 没有 `clone()` 时退回自身，且只在失败行上 —— 那里原响应已被替换掉。

**共享分类函数与码串表的实际符号名与所在文件**（AC4/AC5 的读数依赖这两个名字）：分类函数 `classifyUpstreamFailure(status, body)`，定义点 `shared/asr/asrRegistry.ts`（`export function`，全仓恰好一处）；码串表 `UPSTREAM_CODE_RULES`，同文件（`const`，全仓恰好一处）。`src/shared/api.ts` 以**值导入**取用：`import { classifyUpstreamFailure, extractUpstreamCode } from '@shared/asr/asrRegistry'`（`extractUpstreamCode` 是本次新加的第二个符号，只用来给信封补 `upstreamCode`，与 AC-150 对齐）。

**判据读数**（`npx vitest run src/shared/tests/voiceErrorClassification.test.ts`，6 个用例全绿、exit 0）：`rows=21 openai-family=4 agreed=21 unknown-code-fallback=UNAUTHORIZED`；`status=400 codes=ACCOUNT_ACCESS,AUDIO_REJECTED,CONTENT_FLAGGED status=429 codes=QUOTA_EXHAUSTED,RATE_LIMITED status=404 codes=MODEL_NOT_FOUND,UPSTREAM_UNAVAILABLE distinct400=3 distinct429=2 distinct404=2 same-code-control=401:UNAUTHORIZED=UNAUTHORIZED 403:UNAUTHORIZED=UNAUTHORIZED`；`classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true`；`mutation=client-second-table base-green=true mutant-red=true which=403|AccessDenied.Unpurchased outside-family-green=true`（`direct-followed-shared=15`、`adapter-followed-shared=15`）；`mutation=direct-status-only base-green=3/2/2 mutant-red=true which=403|AccessDenied.Unpurchased outside-family-green=true`（`groups-after=1/1/1`、`envelope-row-red=true`、`controls-green=true`、`strays=0`）；`elapsed-ms≈40 subprocess-imports=0 git-clean-after=true offline-transport=injected ports=0`。

**AC1 的 `git-clean-after` 用的是等价机制**：AC1 同时要求判据「零子进程」与「跑完 `git status --porcelain` 与启动时逐字相同」，两条字面上不能同时成立（跑 `git` 就是子进程）。判据改用**无子进程的等价读数**：启动与收尾各做一次工作树递归 `path -> mtime:size` 快照（跳过 `.git`/`node_modules`/`dist`/`coverage`/`artifacts`/`.vite`），两次逐字相同即「本次运行没写任何东西」。`subprocess-imports` 按本仓库既有先例（`server/modules/voice/tests/voice-capture-off.test.ts` 的 `openDoors`，把说明符拆开拼以免扫到自己的正文）读判据自身源码里有没有 `child_process`/`net`/`http`/`https`/`dgram`，实测 0。

**AC5 的两根杠杆，以及为什么第二根需要多遮一处**：两例都是**内存里的模块替身**（`vi.mock`），无临时文件、无子进程、跑完快照逐字相同。(i) `client-second-table`：把共享分类器换成「无条件 `UPSTREAM_UNAVAILABLE`」的替身，重驱直连路径与两个出货适配器，各 15/15 行全部跟着变；族外（分类器不承载的行 —— `500`/`503`/`408`、传输层失败、裸 `404`，以及那条 `200`）保持期望码不变。这条读的是**耦合**：客户端或适配器自带一张表的话不会跟着变，从而被抓住。**适配器那一半需要额外一招**，理由写进判据了：`vi.mock` 工厂里的 `importOriginal()` 加载的是**原始模块图**，那条图里的适配器绑定的是**原始 registry**，所以 mock 到不了它们（实测过一次：直连路径跟随、适配器不跟随）。判据用 `vi.resetModules()` 清空模块注册表后**动态再导入一次出货适配器模块**，它便落在被 mock 的图里 —— 同一份出货源码，只换掉一个依赖，仍是内存替身、无残留。(ii) `direct-status-only`：把共享分类器换成只按状态的替身，**并同时遮住直连路径分类的另一半输入**（把共享 wire 的解析替成「总能看见文本」）。理由：`AC-149` 的分类器对 `2xx` 无论读不读体都答 `UPSTREAM_UNAVAILABLE`，只换分类器动不了那条 `200` 行；遮住读体输入才是「这条路径只看状态」这个状态本身。结果：400/429/404 三组各塌成一个码，`200` 那行不再可能是 `NO_SPEECH_DETECTED`，而 AC3 的**正对照**（401 两行同码、403 两行同码）仍绿，族外零行误动。

**AC4 是源码读数、不是主读数**：判据只读**定义点与导入语句**两类构造（`/^export\s+function\s+classifyUpstreamFailure\s*\(/m`、`/^\s*const\s+UPSTREAM_CODE_RULES\b/m`、`/^\s*(?:export\s+)?function\s+errorCodeForStatus\s*\(/m`、客户端本地表的定义点、以及 `@shared/asr/...` 的值导入形态），不按行文本 grep —— 三个适配器的注释里都还写着 `errorCodeForStatus` 这个名字（正在解释它们不再持有那张表），按行文本 grep 会命中注释（本仓库已有先例）。**承重性由 AC5(i) 的可执行变异提供**，不由这段散文提供。

**AC6 既有面逐条读数**（每条都是实跑，不是空过）：`npx vitest run src/shared/tests/voiceProviderFailClosed.test.ts` → exit=0（3 passed）；`npx vitest run src/shared/tests/voiceConfigHydration.test.ts src/shared/tests/voiceTrimShippedRecogniser.test.ts src/modules/chat/tests/voiceTranscriptRepair.test.tsx src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx src/shared/asr/tests/asrContractInvariants.test.ts` → exit=0（5 files / 27 passed）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch.test.ts`（AC-139）→ exit=0（6 passed）；`npm run test:client` → exit=0（100 files / 696 passed）；`npm run typecheck` → exit=0（根 + server + scripts 三个 tsconfig）；`npm run lint` → exit=0。另跑 AC-149 的判据 `server/modules/voice/tests/voice-error-classification.test.ts` → exit=0（7 passed），证明码串表加行没有顶掉它的任何期望值。**期望值一处都没改**：本条的码串表扩充没有顶到任何既有读数，没有「原来钉什么、现在钉什么」的条目。

**全量 server 套件的一次读数**（不在 AC6 清单里，登记备查）：`npm run test:server` 出了两个红，都与本条无关、标准重跑即绿 —— (a) `server/modules/file-tree/tests/file-tree.routes.test.ts` 报 `TypeError: fetch failed` / `cause: Error: bad port`（本仓库已知的 undici 坏端口抽签），单独重跑 4 passed / exit 0；(b) `server/modules/voice/tests/voice-capture-text.false-forms.test.ts` 的 `AC11: the temp copies are gone and git status --porcelain gained nothing`（`unchanged=false` 而收尾 porcelain 为空）—— 该判据在模块加载时抓 `PRE_RUN_PORCELAIN`，而同一个 `server/modules/voice/` 目录是**跨进程共享的**，套件并发跑时另一个判据的 `__criterion-falsify-*` 临时副本落进了它的基线；单独重跑该文件 exit=0、`git.status-clean=true unchanged=true temp-copies=none`。（中途我曾 kill 过一次该文件，留下一个 `__criterion-falsify-…-base-<pid>.ts`，已删除，工作树已干净。）

**边界与已知不等价点**（AC7）：未做词汇表扩充、分类函数本体与状态表（AC-149）—— 只在既有码串表上加了四行并把既有函数接到直连路径；未做代理路由的信封与 `upstreamCode` 的提取与合规（AC-150）；未做十二语言文案与 code→文案映射（AC-151）；未做持续显示、折叠技术详情与真实浏览器（AC-153）；未做 ADR-004 修订；未改 `voice.transcribe` 行形状（AC-143）；未改 `multimodal` 与 `dashscope-omni` 适配器；未改识别行为、提示词（`PROMPT_VERSION`）与模型；未改 `acceptsMime` 契约；未改 `server/shared/types.ts` 的 `code?: AsrErrorCode` 形状；未加失败重试、未做上传前静音检查；未联网、未跑真实上游（判据的 `fetch` 全是替身，适配器的 `baseUrl` 是 `.invalid`）。判据跑在**替身 fetch** 上，上游响应体的形状（`error.code`）是判据自己造的，不等于真实百炼或真实 OpenAI 的响应体；「码串来自哪个上游」在判据里只是夹具标签 —— 两条路径用的是同一份函数，所以判据读到的是**同码**，而不是「两个上游各自被正确区分」。`vi.mock` 的变异是**模块替身**，它证明的是耦合方向，不等于逐字节复制了一份出货实现。**L_D 该轴仍暗**，理由：本条读数全是字符串相等与集合大小（code 字符串、码集大小、定义点个数），没有可比的数值量；**L_G 该轴仍暗**，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到 HTTP 响应与适配器返回值。
