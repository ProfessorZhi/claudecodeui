---
id: gap-voice-error-classification-and-status-table
title: 适配器按响应体错误码串分类为稳定 code（403 Unpurchased 与 400 Arrearage 归
  ACCOUNT_ACCESS、429 配额类归 QUOTA_EXHAUSTED、5xx/超时/连不上归 UPSTREAM_UNAVAILABLE），词汇表
  13 码且状态表恰有一行，同 400 不同码串必须不同（AC-149）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-149
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rn "^goal_ac: *AC-149" tasks/*.md` → 0 命中；全量 163 条任务里 `goal_ac` 等于 `AC-149` 的 0 条；`ls server/modules/voice/tests/voice-error-classification.test.ts` → `No such file or directory`；`grep -rn "classifyUpstreamFailure\|ASR_ERROR_CODES\|ACCOUNT_ACCESS" shared/ server/ src/ scripts/` → 0 命中（新词汇表一个字都还没进树）。在飞的两条任务（`gap-ac103-worktree-state-drag-and-unbudgeted-confirm`、`gap-asr-cli-dry-run-offline-replay`）与本条机制无关；同族另外四条判据（AC-150 契约 / AC-151 文案 / AC-152 单一实现 / AC-153 真实浏览器）都还没有任务认领，本条只认领「分类与状态表」这一格。

**这条判据要的是什么（AC-149 原文拆开）**

1. 分类依据是**响应体里的错误码串**，响应体里没有码串时才按状态兜底；表外的码串落到兜底而不是被错误归类。
2. 逐行的（上游状态、响应体码串）→ 预期 code：`AccessDenied.Unpurchased`@403 与 `Arrearage`@400 → `ACCOUNT_ACCESS`；`InvalidApiKey`@401 与不带任何已知码串的 403 → `UNAUTHORIZED`；`AllocationQuota.FreeTierOnly`@429 与 `Throttling.AllocationQuota`@429 → `QUOTA_EXHAUSTED`；`Throttling.RateQuota`@429 → `RATE_LIMITED`；`ModelNotFound`@404 → `MODEL_NOT_FOUND`；`InvalidParameter` 且指向音频时长@400 → `AUDIO_REJECTED`；`DataInspectionFailed`@400 → `CONTENT_FLAGGED`；5xx、超时、连不上 → `UPSTREAM_UNAVAILABLE`；格式正确但既无指令也无转写的答案 → `NO_SPEECH_DETECTED`。
3. **同为 400 但码串不同的两行必须得到不同的 code**（这一条就是「只按状态分类」的取假形态）。
4. 码到 HTTP 状态的表对词汇表里的每个 code **恰有一行，不多不少**。

**现状（立案时实测，可复验）**

| 项 | 实测 |
|---|---|
| 判据文件 | 不存在（见上） |
| 分类实现 | **每个适配器各一份**：`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts:569`、`shared/asr/list/multimodal/multimodal.asr-provider.ts:449`、`shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts:148` 三个同名 `errorCodeForStatus(status)`，都只读状态（`401\|403→UNAUTHORIZED`、`429→RATE_LIMITED`、其余 `UPSTREAM_ERROR`）——**响应体一个字节都不看**，所以 `AccessDenied.Unpurchased` 与普通 403 同码、`Arrearage` 与 `DataInspectionFailed` 同码 |
| 词汇表 | `shared/asr/asrRegistry.ts:132-142` 的 `AsrErrorCode` = NOT_CONFIGURED / INVALID_BASE_URL / UNAUTHORIZED / RATE_LIMITED / TIMEOUT / UNREACHABLE / OVERSIZE / UNSUPPORTED_MIME / NO_SPEECH_DETECTED / UPSTREAM_ERROR；没有 ACCOUNT_ACCESS / QUOTA_EXHAUSTED / MODEL_NOT_FOUND / AUDIO_REJECTED / CONTENT_FLAGGED / UPSTREAM_UNAVAILABLE |
| 状态表 | `voice.service.ts:349` 的 `PROVIDER_ERROR_STATUS`，10 行，与今天的词汇表等长（类型 `Readonly<Record<AsrErrorCode, number>>` 只保证**不缺**，不保证**不多**） |
| 状态表的唯一例外 | `voice.service.ts:375-381` 的 `providerFailureStatus`：`UPSTREAM_ERROR` 且带 `status` 的失败按上游状态原样放行（AC-139 的判据读的就是这一格：`passthrough upstream=404 client=404`） |
| 会被本条顶到的既有读数 | (a) `scripts/asr-dashscope-omni-check.mjs:1204-1208`（AC-138 的判据：`403-unpurchased→UNAUTHORIZED`、`500→UPSTREAM_ERROR`）与 `:1259` 超时钉 `TIMEOUT`、`:1287` 连不上钉 `UNREACHABLE`；(b) `server/modules/voice/tests/voice-provider-dispatch.test.ts:365-487`（AC-139 的判据）驱动 `TIMEOUT`/`UNREACHABLE`/`UPSTREAM_ERROR` 并逐项钉 `PROVIDER_ERROR_STATUS` 的数；(c) `shared/asr/asrInvariants.ts:1037-1047` 的错误行（500/503/400→`UPSTREAM_ERROR`、transport→`UNREACHABLE`、timeout→`TIMEOUT`），被 `src/shared/asr/tests/asrContractInvariants.test.ts` 与 `scripts/asr-contract-invariants-check.mjs` 两个 runner 驱动；(d) 两处取假形态按**源码行**变异：`scripts/asr-contract-invariants-check.test.mjs:167-191`、`scripts/asr-dashscope-omni-check.test.mjs:266-267` |
| 类型期的边界 | `PROVIDER_ERROR_STATUS` 是 `Readonly<Record<AsrErrorCode, number>>` ⇒「缺一行」在 `npm run typecheck` 就红；「多一行」只有运行期读键集才红——而词汇表今天是 type union，运行期被擦除 ⇒「恰有一行」这条读数**需要一个运行期词表**可读 |
| 类型使用的其它落点 | `server/shared/types.ts:1418` 的 `code?: AsrErrorCode`（外部形状不变，本条不动它）、`server/modules/voice/voice-capture.ts:486` 的 `input.code === 'UPSTREAM_ERROR'` 从句、`src/shared/asr/tests/asrContractInvariants.test.ts:49,102` 从 multimodal 适配器 import 的 `errorCodeForStatus` 与它自带的替身（`TIMEOUT`/`UNREACHABLE`/`UPSTREAM_ERROR` 三个字面量） |

**词汇表（本条定死，13 个 code）**

`ACCOUNT_ACCESS`（新：未开通 / 欠费 / 授权失效）· `UNAUTHORIZED` · `QUOTA_EXHAUSTED`（新：免费额度或配额耗尽）· `RATE_LIMITED` · `MODEL_NOT_FOUND`（新）· `AUDIO_REJECTED`（新）· `CONTENT_FLAGGED`（新）· `NO_SPEECH_DETECTED` · `UPSTREAM_UNAVAILABLE`（新：**合并**今天的 5xx、超时、连不上）· `NOT_CONFIGURED` · `INVALID_BASE_URL` · `OVERSIZE` · `UNSUPPORTED_MIME`。

⇒ `TIMEOUT` / `UNREACHABLE` / `UPSTREAM_ERROR` 从词汇表里**消失**。这不是顺手清理：AC-149 的夹具行原文就是「5xx、超时、连不上都是 UPSTREAM_UNAVAILABLE」，留着三个旧 code 会让同一条件有两个 code，而 AC-152 之后还要求直连与代理两条路径对同一上游失败给出**同一个** code；`docs/proposals/voice-error-messages.md:83` 的词汇表「沿用」一栏也只列了 NOT_CONFIGURED / INVALID_BASE_URL / OVERSIZE / UNSUPPORTED_MIME。

**要交付的事**

1. **词汇表与运行期词表只有一处**（`shared/asr/asrRegistry.ts`）：`AsrErrorCode` 改成上面 13 个；同一文件导出运行期常量（名字由实现定，如 `ASR_ERROR_CODES`），并对它做静态对齐（`satisfies` / `Record<AsrErrorCode, true>` 一类），使「union 与运行期数组不一致」在 `npm run typecheck` 就红。运行期词表是「状态表恰有一行」这条读数的**唯一**来源：判据不再另抄一份字符串数组。
2. **分类只有一份实现，且落在 registry 里**（不在适配器里）：一个纯函数（名字由实现定），入参是**上游状态（可能缺席）＋响应体文本**，出参 `AsrErrorCode`。放这里的两个理由要写进注释：(a) 直连路径与代理路径都要用它（AC-152 读的是两条路径同码）；(b) 适配器从 registry 取 `baseMimeType`/`declaredAcceptsMime` 已经是一条值边，反方向再让 registry 引适配器就成环（`server/modules/voice/tests/voice-provider-dispatch.test.ts:17-37` 记了这个 TDZ）。三个适配器各自那份映射的**逻辑**由它取代；是否保留同名导出由实现定，但保留的那份只能是**转发**，不得再有自己的映射表。
3. **码串表（响应体优先）**：`AccessDenied.Unpurchased`→ACCOUNT_ACCESS；`Arrearage`→ACCOUNT_ACCESS；`InvalidApiKey`→UNAUTHORIZED；`AllocationQuota.FreeTierOnly`→QUOTA_EXHAUSTED；`Throttling.AllocationQuota`→QUOTA_EXHAUSTED；`Throttling.RateQuota`→RATE_LIMITED；`ModelNotFound`→MODEL_NOT_FOUND；`DataInspectionFailed`→CONTENT_FLAGGED；`InvalidParameter` 且文本指向音频时长（含 `audio` / `duration` / `seconds` 之一，或官方那句 `1 to 300`）→AUDIO_REJECTED。匹配是**子串**匹配（上游把码串包在 `error.code` 或消息里，夹具形状见 `scripts/asr-dashscope-omni-check.mjs:1199-1201`），但**顺序敏感**：`Throttling.AllocationQuota` 与 `AllocationQuota.FreeTierOnly` 必须先于任何更宽的 `Allocation` 规则判定，`Throttling.RateQuota` 不得被更宽的 `Throttling.` 规则抢走——用「长码串优先」还是别的手段不限，判据只读结果。
4. **状态兜底（表外的码串与无码串都落这里，不误归类）**：401/403→UNAUTHORIZED（AC-149 原文点名「不带任何已知码串的 403」是 UNAUTHORIZED）；429→RATE_LIMITED；其余（其它 4xx、5xx、408、以及**没有状态**的连不上 / 超时）→UPSTREAM_UNAVAILABLE。⇒ `AccessDenied.Unpurchased` 之外的 403 仍是 UNAUTHORIZED，`Throttling.*`/`AllocationQuota.*` 之外的 429 仍是 RATE_LIMITED：这两格正是让 AC-138 的 `403-plain` 与 `429` 两条既有读数不被顶掉的原因。
5. **状态表补齐且恰有一行**（`voice.service.ts` 的 `PROVIDER_ERROR_STATUS`）：13 行，键集逐字等于运行期词表。既有数**一个都不许动**（别的判据钉着）：`NOT_CONFIGURED 503`、`INVALID_BASE_URL 400`、`UNAUTHORIZED 502`、`RATE_LIMITED 429`、`OVERSIZE 413`、`UNSUPPORTED_MIME 415`、`NO_SPEECH_DETECTED 422`（`voice-provider-dispatch.test.ts:477-482` 逐项钉，且 `voice-provider-dispatch-falsify.test.ts:101` 的变异体锚的就是 `  UNAUTHORIZED: 502,` 这一行原文）。新增行的数由实现定，但必须让「带的失败按上游状态放行」那一格继续成立：`providerFailureStatus` 的例外从句从 `UPSTREAM_ERROR` 改名到 `UPSTREAM_UNAVAILABLE`（`voice-provider-dispatch.test.ts:504-512` 的 `passthrough upstream=404 client=404` 是这条读数的既有形态）。
6. **三个适配器接到同一份分类上**：`dashscope-omni`（响应分支把响应体文本交给分类器；`AccessDenied.Unpurchased` 的**文案**分支与 `isModelNotPurchased` 保留——`scripts/asr-dashscope-omni-check.mjs:1236-1249` 读的是「未开通/余额不足」这句文案与两条文案互不相同，只有 code 换）、`multimodal`、`openai-compatible`（后两者 abort / 连不上分支同样落 `UPSTREAM_UNAVAILABLE`）。抽掉的三段 per-adapter 映射不得以第二张表的形式留在任何地方。
7. **判据文件**（`server/modules/voice/tests/voice-error-classification.test.ts`，AC-149 的 `criterion:` 文件，只有这一个文件能认领该判据）：夹具表逐行；同状态不同码的分组断言；状态表键集与运行期词表的**双向**相等；再用一个**离线替身 fetch** 把出货的 dashscope 适配器按同一批（状态、响应体）驱动一遍，读到的 code 与纯函数、与夹具预期逐行相同（否则那张夹具表只是在描述一个没人用的函数——替身形状沿用 `voice-provider-dispatch.test.ts`）。**导入形状**：`from '../../../../shared/asr/asrRegistry.js'`（NodeNext 要求 `.js` 后缀，与 `voice-provider-dispatch.test.ts:40` 同形）；**不要静态 import dashscope 适配器**（registry↔adapter 是值边、成环，静态进入会在 registry 初始化前求值 → TDZ），要驱动它就用顶层 `await import(...)`（同文件 `:37` 的形状）。
8. **取假形态是可执行旁证**（`server/modules/voice/tests/voice-error-classification.false-forms.test.ts`，三段形状沿用 `voice-capture-audio.false-forms.test.ts`：未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外至少一条仍绿；变异体写在与被测文件同树的临时路径、跑完即删、`git status --porcelain` 不变）：
   - (i) `status-only`：分类改回只读状态（等价于今天的 `errorCodeForStatus`）⇒ 同为 400 的两行（`Arrearage` vs `DataInspectionFailed`）必须红，429 三行也必须塌成两码；
   - (ii) `429-all-rate-limited`：`429` 一律 `RATE_LIMITED` ⇒ 两条 QUOTA_EXHAUSTED 行必须红；
   - (iii) `table-missing-a-code` / `table-extra-a-code`：状态表删一行、加一行 ⇒ 键集相等那条读数必须红（缺与多各一例）。
9. **既有面不退化（逐条打印退出码，不是空过）**：被词汇表变更顶到的既有读数在**同一次改动**里改成新词汇表下的正确期望——`shared/asr/asrInvariants.ts` 的错误行、`src/shared/asr/tests/asrContractInvariants.test.ts` 的替身适配器、`scripts/asr-dashscope-omni-check.mjs` 的 `statusCases` 与超时 / 连不上两行、`scripts/asr-dashscope-omni-check.test.mjs` 与 `scripts/asr-contract-invariants-check.test.mjs` 的按行变异、`server/modules/voice/tests/voice-provider-dispatch.test.ts` 的三个驱动与逐项钉的数、`voice-capture.ts:486` 的从句。这些文件是**同一次语义变更的落点**，不是顺手改：每一处只把旧 code 换成新词汇表下的对应 code，读数结构、判据语义与取假形态一个都不放松；改了哪一行、原来钉什么、现在钉什么，写进完成记录。

**边界（不做）**：不做 ADR-004 词汇表修订与 `voice.service.ts` 里「传输层失败不带码」注释的更新（GOAL-011 的范围内事，由契约那条任务承担）；不做路由响应体带 `code` / `upstreamCode`（AC-150）；不做十二语言文案（AC-151）；不把分类另抄一份给直连路径（AC-152 的读数）；不做真实浏览器（AC-153）；不改 `voice.transcribe` 日志行的逐字节形状（AC-143）；不改识别行为、提示词（`PROMPT_VERSION`）与模型；不加失败重试、不做上传前静音检查；不改 `acceptsMime` 契约、不改 `server/shared/types.ts` 的 `code?: AsrErrorCode` 形状；不联网、不跑真实 DashScope。

## AC

- [x] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.test.ts` 退出 0；判据自身零子进程、零真实监听端口、零网络（离线替身 fetch）；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。打印 `subprocess-or-socket-imports=<n>`。
- [x] AC2 夹具逐行：AC-149 原文那 12 类行各一条，逐行打印 `row=<上游状态>|<码串> expected=<code> observed=<code>` 并断言相等。必须覆盖：403 `AccessDenied.Unpurchased`→ACCOUNT_ACCESS、400 `Arrearage`→ACCOUNT_ACCESS、401 `InvalidApiKey`→UNAUTHORIZED、403 无码串→UNAUTHORIZED、429 `AllocationQuota.FreeTierOnly`→QUOTA_EXHAUSTED、429 `Throttling.AllocationQuota`→QUOTA_EXHAUSTED、429 `Throttling.RateQuota`→RATE_LIMITED、404 `ModelNotFound`→MODEL_NOT_FOUND、400 `InvalidParameter`+音频时长→AUDIO_REJECTED、400 `DataInspectionFailed`→CONTENT_FLAGGED、500 与 503 各一条→UPSTREAM_UNAVAILABLE、408→UPSTREAM_UNAVAILABLE、连不上（transport reject）→UPSTREAM_UNAVAILABLE、超时（AbortError）→UPSTREAM_UNAVAILABLE、200 且 envelope 里既无 instruction 也无 transcript→NO_SPEECH_DETECTED。**表外码串兜底**另一条：403 带一个不在码串表里的码（如 `SomethingElse.New`）→UNAUTHORIZED（不是被猜成别的 code）。打印 `rows=<n> matched=<n> unknown-code-fallback=<code>`。
- [x] AC3 同状态不同码必须不同（「只按状态分类」的直接读数）：按状态分组后断言 400 组内码集大小 ≥ 2 且 `Arrearage` 与 `DataInspectionFailed` 两行码不等；429 组内码集大小 == 2 且两条 QUOTA_EXHAUSTED 与 `Throttling.RateQuota` 那条不等；**正对照**：同状态同码的两行确实存在（401 与 403 无码串同为 UNAUTHORIZED），使「不等」不是空集上的断言。打印 `status=400 codes=<a,b> status=429 codes=<c,d> distinct400=<n> distinct429=<n> same-code-control=<b>`。
- [x] AC4 状态表对词表恰有一行（不多不少）：从 registry 读运行期词表、从 `voice.service.ts` 读 `PROVIDER_ERROR_STATUS`，断言两者排序后**逐字相等**且 `length === 13`；逐行打印 `table-row <CODE>=<status>`；再断言词表里每个 code 都能索引到且不是 `undefined`。打印 `vocab=<n> table=<n> sameSet=<b> missing=<…> extra=<…>`。
- [x] AC5 分类只有一个实现、且是出货适配器在用的那一份：判据用离线替身 fetch 把出货的 **dashscope 适配器**按 AC2 的全部（状态、响应体）夹具驱动一遍（`await import(...)` 动态进入），断言适配器读到的 code 与纯函数、与 AC2 预期三者逐行相同；并读源码断言三个适配器里不再存在各自的映射表（三份 per-adapter 映射要么不存在、要么函数体只有一次转发调用）。打印 `adapter=<id> rows=<n> adapter-vs-pure-same=<b> per-adapter-tables=<n>`。
- [x] AC6 取假形态可执行：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 退出 0；三例各自「未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外仍绿」，并逐例指名：`status-only` 红同 400 两行与 429 组、`429-all-rate-limited` 红两条 QUOTA_EXHAUSTED、状态表缺一行与多一行各红键集相等那条；跑完 `git status --porcelain` 与本文件启动时逐字相同、无临时副本残留。打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<…> outsideFamilyGreen=<b>`。
- [x] AC7 既有面不退化（逐条打印 `exit=<n> name=<…>`，不是空过）：`voice-provider-dispatch.test.ts`（AC-139 的判据，含其 `passthrough upstream=404 client=404` 与 `UNAUTHORIZED: 502` 锚）、`voice-provider-dispatch-falsify.test.ts`（AC-139 的取假形态）、`src/shared/asr/tests/asrContractInvariants.test.ts`、`node scripts/asr-dashscope-omni-check.mjs`（AC-138 的判据）、`node scripts/asr-contract-invariants-check.mjs` 各退出 0；`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts`、`voice-capture-off.test.ts`、`voice-capture-text.test.ts`、`voice-capture-audio.test.ts` 各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0。
- [x] AC8 词汇表与运行期词表同源（类型期读数）：判据打印 `shared/asr/asrRegistry.ts` 里那次静态对齐的构造存在（读源码一行即可），并如实说明它是类型期而非运行期读数；实测旁证：临时删掉 union 里一个 code 而运行期数组不动（或反之）⇒ `npm run typecheck` 必红。打印 `alignment=<构造名> typecheck-reds-on-drift=<b>`。
- [x] AC9 如实登记：判据输出与本任务完成记录里写明「本条只做词汇表、单一分类函数、三个适配器的接线、状态表补齐与三处取假形态；未做 ADR-004 修订、路由响应体的 `code`/`upstreamCode`（AC-150）、十二语言文案（AC-151）、直连路径的统一（AC-152）、真实浏览器（AC-153）；未改 `voice.transcribe` 行形状；未联网、未跑真实上游」。

## DoD

真实落地判据：不是「多了一张码串表」，而是**出货的三个适配器**对同一批（上游状态、响应体）夹具真的给出 AC-149 逐行点名的那些 code——由执行读数证明，不由段落文字声明。承重性由四件读数证明：

(a) **响应体优先于状态**（AC2/AC3）：`AccessDenied.Unpurchased`@403 与无码串@403 在同一次运行里读到**两个不同**的 code，`Arrearage`@400 与 `DataInspectionFailed`@400 也是；取假形态 (i) 指名打红同 400 的两行——「按状态分类」与「按码串分类」是两条读数。

(b) **429 不是一码**（AC2/AC3 + 取假形态 (ii)）：两条配额类与一条频率类三行落在**两个** code 上，取假形态 (ii) 指名打红 QUOTA_EXHAUSTED 那两行。

(c) **表与词表互为倒影**（AC4 + 取假形态 (iii)）：键集相等是双向读数，缺一行与多一行各有一例打红；词表来自 registry 的运行期常量，判据不另抄一份。

(d) **夹具不是描述**（AC5）：同一批夹具再经**出货的 dashscope 适配器**（离线替身 fetch）跑一遍，逐行同码——纯函数与适配器之间不允许有第二张表。既有绿读数（AC-139 的 `UNAUTHORIZED: 502` 锚与 404 放行、AC-138 的 `403-plain`/`429` 行与两条文案互不相同）在改动后逐条仍绿，由 AC7 的退出码读出。

**跨判据的连带改动必须如实登记**：`TIMEOUT`/`UNREACHABLE`/`UPSTREAM_ERROR` 三个 code 从词汇表消失是本条交付的一部分（AC-149 的夹具行原文要求超时 / 连不上落 UPSTREAM_UNAVAILABLE），因此 AC-138 的判据脚本与 AC-139 的判据测试里钉着这三个 code 的行必须在**同一次改动**里改成新词汇表下的期望值，且只改期望值、不放松任何读数结构；这两处改动在完成记录里逐条列出（改了哪一行、原来钉什么、现在钉什么）。

**已知不等价点**：官方错误码页是通用表，`InvalidParameter`＋音频时长那一行对 `qwen3.8-omni-flash` 是否适用没有验证（提案 `docs/proposals/voice-error-messages.md:137` 已记），所以码串表按**子串**匹配 + 状态兜底，表外的码串一律落兜底。判据跑在离线替身 fetch 上，不等于真实 DashScope 的响应体形状。

L_D 该轴仍暗，理由：本条读数全是枚举与集合相等（code 字符串、键集大小），没有可比的数值量。
L_G 该轴仍暗，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到适配器与状态表。

## Touches

- shared/asr/asrRegistry.ts
- shared/asr/asrInvariants.ts
- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- shared/asr/list/multimodal/multimodal.asr-provider.ts
- shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice-capture.ts
- server/modules/voice/tests/voice-error-classification.test.ts (new)
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts (new)
- server/modules/voice/tests/voice-provider-dispatch.test.ts
- server/modules/voice/tests/voice-error-contract.test.ts
- server/shared/types.ts
- src/shared/asr/tests/asrContractInvariants.test.ts
- src/shared/asr/tests/multimodalAdapter.test.ts
- scripts/asr-dashscope-omni-check.mjs
- scripts/asr-dashscope-omni-check.test.mjs
- scripts/asr-contract-invariants-check.test.mjs
- tasks/gap-voice-error-classification-and-status-table.md

## 完成记录

**判据入口（AC1/AC2/AC3/AC4/AC5/AC8/AC9 的读数都落在这里）**

`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.test.ts` → 退出 0，`tests 7 / pass 7 / fail 0`，`elapsed-ms=24`（< 15000），`subprocess-or-socket-imports=0 []`，`readings=6/6`，`offline-transport=injected`。逐条：

- AC1：`elapsed-ms=24 subprocess-or-socket-imports=0 [] readings=6/6 offline-transport=injected`。
- AC2：`rows=19 matched=19 unknown-code-fallback=UNAUTHORIZED`；19 行 `row=<上游状态>|<码串> expected=<code> observed=<code> via=pure|adapter` 逐行相等。覆盖 AC-149 原文点名的 12 类，另加 408、两条表外码串兜底（403/400 `SomethingElse.New`）、以及 401 与无码串 403 同码的正对照。
- AC3：`status=400 codes=ACCOUNT_ACCESS,AUDIO_REJECTED,CONTENT_FLAGGED,UPSTREAM_UNAVAILABLE status=429 codes=QUOTA_EXHAUSTED,RATE_LIMITED distinct400=4 distinct429=2 same-code-control=true`。
- AC4：`vocab=13 table=13 sameSet=true missing=[] extra=[] source=13`，13 行 `table-row <CODE>=<status>` 逐行打印，并逐键断言可索引且非 `undefined`。
- AC5：`adapter=dashscope-omni rows=19 adapter-vs-pure-same=true per-adapter-tables=0`；另打印三行 `adapter-source <path> own-table=false delegates=true`。
- AC8：`alignment=ASR_ERROR_CODE_ALIGNMENT ... declared=true typed-to-the-union=true runtime-derived=true runtime-length=13`，并如实说明这是类型期读数、运行期旁证在取假形态文件里（AC1 要求判据自身零子进程）。
- AC9：scope 段逐条登记未覆盖面与两处测量偏差。

**取假形态（AC6/AC7/AC8 的退出码读数都在这个文件里）**

`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` → 退出 0，`tests 7 / pass 7 / fail 0`（duration ≈120s，其中 AC7 一项 ≈118s，全是子进程）。四例各走三段形状（未变异副本先绿 → 变异体红在预测族 → 族外仍绿），预测值与实测逐项相符：

| 变异 | 未变异副本 | 变异体 | 预测读数 | 实测 |
|---|---|---|---|---|
| `status-only`：分类只读状态（等价于旧 `errorCodeForStatus`） | exit 0 red=0 | mutantRed=true | `matched=12 distinct400=1 adapter-vs-pure-same=false` | 三项全中；红 AC2+AC3+AC5，同 400 的 `Arrearage`/`DataInspectionFailed` 与两条 429 配额行都塌码 |
| `429-all-rate-limited`：429 一律 `RATE_LIMITED` | exit 0 red=0 | mutantRed=true | `matched=17 distinct429=1 adapter-vs-pure-same=false` | 三项全中；红 AC2+AC3+AC5 |
| `table-missing-a-code`：删 `QUOTA_EXHAUSTED: 429,` | exit 0 red=0 | mutantRed=true | `missing=[QUOTA_EXHAUSTED] source=12` | `vocab=13 table=13 sameSet=false missing=[QUOTA_EXHAUSTED] extra=[] source=12`；只红 AC4 |
| `table-extra-a-code`：加 `UPSTREAM_ERROR: 502,` | exit 0 red=0 | mutantRed=true | `extra=[UPSTREAM_ERROR] source=14` | `sameSet=false missing=[] extra=[UPSTREAM_ERROR] source=14`；只红 AC4 |

每例都断言：锚点在副本里恰好命中一次；`shippingOf(copyOf(x)) === x`（副本与出货文本只差「重定 import 根」这一处）；变异体写在**新路径**（ESM 按 URL 缓存）。收尾读数：`scratch-remains=false own-temp-copies=none git-unchanged=true concurrent-foreign-copies=0`。

**AC7 逐条退出码（`exit=<n> name=<…>`，非空过；tally 与 marker 双查）**

`voice-provider-dispatch.test.ts cases=6` 0 · `voice-provider-dispatch-falsify.test.ts cases=1` 0 · `src/shared/asr/tests/asrContractInvariants.test.ts cases=9`（vitest tally `Tests 9 passed`）0 · `node scripts/asr-dashscope-omni-check.mjs`（`platform-fetch-calls=0`、`failures=0`）0 · `node scripts/asr-contract-invariants-check.mjs`（`verdict=pass`、`platform-fetch-calls=0`）0 · `node --test scripts/asr-dashscope-omni-check.test.mjs cases=14` 0 · `node --test scripts/asr-contract-invariants-check.test.mjs cases=9` 0 · `voice.service.test.ts cases=4` 0 · `voiceHealth.test.ts cases=7` 0 · `voice-config.routes.test.ts cases=6` 0 · `voiceTranscribeGaps.test.ts cases=8` 0 · `voice-capture-off.test.ts cases=21` 0 · `voice-capture-text.test.ts cases=10` 0 · `npm run typecheck` 0 · `npm run lint` 0。

**一处如实登记（不是静默跳过）**：AC7 点名的 `voice-capture-audio.test.ts` 在本树里**不存在**（AC-145 尚未落地），读数打印 `exit=SKIPPED name=server/modules/voice/tests/voice-capture-audio.test.ts gap=not-in-this-tree` 并注明原因，既没有伪造一个 0，也没有把它藏起来。同理 AC6 原文点名 `voice-capture-audio.false-forms.test.ts` 作三段形状模板（同因不存在），本任务改用在树的 `voice-capture-text.false-forms.test.ts` 同形实现。

**AC8 的 compiler 旁证（跑在取假形态文件里）**：`typecheck-reds-on-drift=true baseExit=0 mutantExit=2 names-the-deleted-code=true names-the-alignment-type=true`，第一条错误 `TS2353: Object literal may only specify known properties, and 'NO_SPEECH_DETECTED' does not exist in type 'Readonly<Record<AsrErrorCode, true>>'`。即 union 删一个成员而运行期数组不动 ⇒ 项目自身的编译选项下必红，且报错点名被删的 code 与那个对齐构造。

**两处测量偏差（已在判据 AC9 段与文件头登记，不藏）**：(i) 变异副本建在 gitignore 的 `tmp/__criterion-falsify-voice-error-classification/` 而不是被测模块旁 —— AC8 的 drift 变异体**故意**类型不合法，而套件里同时有六个兄弟判据在跑 `npm run typecheck`，写在已编译目录里会红别人的门；(ii) drift 用 `extends ../../server/tsconfig.json`（项目自身选项）编译那份副本，而不是对出货文件做瞬时变异后跑 `npm run typecheck`，同因。出货树的 `npm run typecheck` 仍在 AC7 里真跑、真读退出码。

**连带的同语义落点（旧钉 → 新钉；只换期望值，读数结构与取假形态一处不放松）**

| 文件 | 旧钉 | 新钉 |
|---|---|---|
| `shared/asr/asrInvariants.ts` | `error.status-500` / `status-503` / `status-400` / `body-not-json` → `UPSTREAM_ERROR`；`error.transport` → `UNREACHABLE`；`error.timeout` → `TIMEOUT` | 六行同落 `UPSTREAM_UNAVAILABLE`（行 id 与 step 形状不变）；组头注释改写成「差异是词汇表划的、不是状态号暗示的」并写明第三组为什么是一个 code 而不是三个 |
| `src/shared/asr/tests/asrContractInvariants.test.ts` | 替身适配器 import 适配器自带的 `errorCodeForStatus`；catch 分支 `aborted ? 'TIMEOUT' : 'UNREACHABLE'`；非 JSON 响应 → `UPSTREAM_ERROR` | import registry 的 `classifyUpstreamFailure`；catch 分支两种失败同落 `UPSTREAM_UNAVAILABLE`；非 JSON 响应改走 `classifyUpstreamFailure(response.status, await response.text())` —— 替身从此跑**出货分类器本身**，不再是第二份实现 |
| `scripts/asr-dashscope-omni-check.mjs` | `403-unpurchased` → `UNAUTHORIZED`；`500` → `UPSTREAM_ERROR`；超时钉 `TIMEOUT`、连不上钉 `UNREACHABLE`（token `TRANSPORT_COLLAPSED_INTO_TIMEOUT`）；期望码集合含 `UPSTREAM_ERROR` / `NON_ENVELOPE_NOT_UPSTREAM_ERROR` | `403-unpurchased` → `ACCOUNT_ACCESS`（两条 403 从此是 code 与文案两条独立读数，注释写明）；`500` → `UPSTREAM_UNAVAILABLE`；超时与连不上同落 `UPSTREAM_UNAVAILABLE`，token 改 `TRANSPORT_NOT_MAPPED`（失败形态改成「传输失败以别的 code 到达调用方」）；期望码集合换 `UPSTREAM_UNAVAILABLE` / `NON_ENVELOPE_NOT_UPSTREAM_UNAVAILABLE` |
| `scripts/asr-dashscope-omni-check.test.mjs` | AC8 取假形态变异**适配器**里的 `if (status === 401 或 403) return 'UNAUTHORIZED'`（原文用两个竖线） | 变异**registry** 的 `{ token: 'AccessDenied.Unpurchased', code: 'ACCOUNT_ACCESS' },` → `code: 'UNAUTHORIZED'`。映射搬进 registry 后原锚点已不在适配器里，锚点漂移的用例会为与主张无关的原因变红，故随实现迁移；用例标题与注释一并改写 |
| `scripts/asr-contract-invariants-check.test.mjs` | `error-mapping` 变异体是适配器里三行（`no-unauthorized` / `no-rate-limited` / `abort-is-upstream`），断言 401/403/429/timeout 四行红 | 变异体改为把 registry 的 `classifyUpstreamFailure` 置常数，断言 401/403/429 三行红，且 **`UPSTREAM_UNAVAILABLE` 组八行（500/503/400/timeout/transport/body-not-json/envelope-without-text/transcript-arrives）全绿** ——「另一侧仍绿」的断言比原来多一倍 |
| `server/modules/voice/tests/voice-provider-dispatch.test.ts` | 驱动 `TIMEOUT` / `UNREACHABLE` / `UPSTREAM_ERROR` 三种失败；钉 `TIMEOUT 504`、`UNREACHABLE 502`、`UPSTREAM_ERROR 502` | 三个驱动同落 `UPSTREAM_UNAVAILABLE`；`TIMEOUT 504` 与 `UNREACHABLE 502` 两钉消失（该成员已不在词汇表里），新钉 `UPSTREAM_UNAVAILABLE 502` 与五条新增码的行。**AC-139 原有的 `NOT_CONFIGURED 503` / `INVALID_BASE_URL 400` / `UNAUTHORIZED 502` / `RATE_LIMITED 429` / `OVERSIZE 413` / `UNSUPPORTED_MIME 415` / `NO_SPEECH_DETECTED 422` 七个数一个未动**；`passthrough upstream=404 client=404` 读数与 `UNAUTHORIZED: 502` 变异锚仍在 |
| `server/modules/voice/voice-capture.ts` | 从句 `input.code === 'UPSTREAM_ERROR'` + 两行注释 | 同落 `UPSTREAM_UNAVAILABLE`；从句语义不变（2xx 上的该码是「答非所问」而不是「拒绝」，故 404 仍落到传输判定） |
| `server/shared/types.ts` | `VoiceServiceResult` 文档段引用 `TIMEOUT`/`UNREACHABLE`/`UPSTREAM_ERROR` 三个词 | 改述为 `UPSTREAM_UNAVAILABLE` 一类 + 响应体挣来的细码（`ACCOUNT_ACCESS`/`QUOTA_EXHAUSTED`/`MODEL_NOT_FOUND`/`AUDIO_REJECTED`/`CONTENT_FLAGGED`，并指向 `classifyUpstreamFailure`）；`code?: AsrErrorCode` 形状未动 |
| `src/shared/asr/tests/multimodalAdapter.test.ts` | 三处 `code: 'UPSTREAM_ERROR'` | 三处 `code: 'UPSTREAM_UNAVAILABLE'` |
| `server/modules/voice/tests/voice-error-contract.test.ts` | 三行注释里的 `UPSTREAM_ERROR` | 三处 `UPSTREAM_UNAVAILABLE`（纯注释，断言零变化） |

**Touches 登记**：上表里 `server/modules/voice/tests/voice-error-contract.test.ts`、`server/shared/types.ts`、`src/shared/asr/tests/multimodalAdapter.test.ts` 三个文件，是改动词汇表后不得不跟着走的既有面（它们的断言或注释钉着已消失的 `UPSTREAM_ERROR`），已补进本任务 Touches。

**一处 develop 级的既有红，本任务一并修好并如实归因**：`scripts/asr-contract-invariants-check.test.mjs` 的 `empty-registry` 用例，原文把 `REGISTERED` 的头两行与紧随的 `];` 一起写进 find 串，而 dashscope 适配器行（连同解释它位置承重的注释）早已被更早的任务追加在两者之间 ⇒ 锚点命中 0 次、用例红。**在 develop 上就是红的**（`git show develop:shared/asr/asrRegistry.ts` 上同样 0 命中；本任务对 `shared/asr/asrRegistry.ts` 的改动从不触碰 `REGISTERED`），因为它在我的 Touches 里、scoped gate 会读它，故一并修：find 串改为只锚 `const REGISTERED: readonly AsrAdapter[] = [\n` 这一行声明（往数组里追加行不会再移动它），用例语义（空注册表必须非零退出、`verdict=empty`、`readings=0`、五组全 `UNMEASURED`）逐条不变；被 `];` 顶到下一行的数组用 `export` 声明，以免引入未用绑定。AC7 的读数因此从「`cases=8` 且红一条」变成 `cases=9` 全绿。

**AC7 与 AC8 的分工**：AC1 的「判据自身零子进程」与 AC7 的「逐条退出码」不能同时落在判据文件里，所以退出码读数全部落在取假形态文件；AC8 的编译器旁证同因也落在那里（以 `extends` 项目自身选项的方式），判据文件只读源码里的对齐构造并如实声明它是类型期读数。
