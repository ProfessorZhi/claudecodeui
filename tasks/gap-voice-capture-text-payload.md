---
id: gap-voice-capture-text-payload
title: text 档捕获行载荷：一次成功、一次上游
  404、一次预检拒绝各一行，含实际模型/宿主名/mime/bytes/sha256/上游原始返回逐字/结果分支/返回文本，超 64KB
  截断带标记而不超限不带，行内无请求体与请求头、不建文件（AC-144）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-capture-mode-gate-off-fail-closed
goal_ac: AC-144
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rln 'AC-144' tasks/` 零命中，`grep -rho '^goal_ac: *AC-144' tasks/` 零命中；`grep -rln 'voice\.capture' tasks/` 只命中 `gap-voice-capture-mode-gate-off-fail-closed`（认领 AC-143）。两者机制不同、判据文件互不重叠：AC-143 的判据是 `server/modules/voice/tests/voice-capture-off.test.ts`（闸门与失败关闭：逐字节等于基线、零目录零文件、启动行、非法值告警），本条是 `server/modules/voice/tests/voice-capture-text.test.ts`（载荷内容与截断）。AC-143 的任务体已把自己的边界写成「不做 text 档载荷细化（实际模型、上游原始返回逐字、结果分支、64KB 截断）」并把该细化指给 `-text` 那份，正是本条。依赖边写在 frontmatter 的 `depends_on` 上（接缝 `voice-capture.ts`、`capture` 端口、`voice.transcribe` 行上的 `captureId` 由那条出货），本条不改那条的任何判据文件。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/voice-capture-text.test.ts` → `No such file or directory` |
| 捕获行 | `grep -rl 'voice\.capture\|captureId' server/ src/ scripts/` → 0 个文件 |
| 上游原始返回 | `voice.service.ts:814` 只把 `adapter.transcribe(...)` 的返回值当读数；上游 `Response` 在适配器内部就被读掉了（`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts:667` 的 `response.text()`），service 手上没有原始返回的任何副本 |
| 结果分支 | 适配器已把分支编码进 `style` / `meta.writtenFallback` / `code`（同文件 689-718 的四条 return），但 `voice.service.ts:860` 只把 `{ text }` 交给调用方，分支不进任何日志 |
| 截断与内容哈希 | `grep -rn 'truncat' server/modules/voice/` 只命中 `voice.module.ts:54` 的一句注释；`grep -rn 'createHash' server/modules/voice/` 零命中（`sha256` 的唯一命中是 `tests/voice-config.routes.test.ts:128` 的 `createHmac('sha256', …)`，JWT 签名，不是内容哈希） |
| 地址宿主名 | `grep -n 'hostname' server/modules/voice/voice.service.ts` 只有 443/444 两处，全在 SSRF 预检里（`169.254.*` 判定），没有一处进日志 |
| 唯一的尝试日志出口 | `voice.service.ts:717` 的 `logAttempt`（`providerId/outcome/status/latencyMs[/promptVersion][/writtenFallback]`）；`voice.capture` 行必须走同一个 `log`（`voice.service.ts:652` 解析的注入端口，缺省 `console`） |
| 承载原始返回的缝 | 三个适配器都只经 `voice.service.ts:831` 注入的 `dependencies.fetchBackend` 出网，所以「上游原始返回的副本」只能在这一层包出来，不在适配器契约里（改适配器契约不在本条） |

**要交付的五件事**

1. **原始返回副本只能包在传输端口外**：在 `transcribe` 内把注入的 `dependencies.fetchBackend` 包一层**每次尝试一份**的局部函数（不跨尝试共享、不缓存到 service 上），该函数克隆 `Response`、读克隆体的 `status` 与 `text()`，把 `{ status, body }` 记为本次尝试的 `upstream`；适配器拿到的仍是原响应，行为不变。**只记响应**：请求的 `init.body` 与 `init.headers` 一律不进记录（不 spread、不留引用、不做「顺手带上」的字段）。
2. **载荷与截断只有一份构造点**：扩 `server/modules/voice/voice-capture.ts` 里 AC-143 出货的那个唯一的记录构造点（不新开第二份，也不在测试里手写一行 `log.info(JSON.stringify(…))`）。新增的纯函数（名字自定）负责 `host`/`mime`/`bytes`/`sha256`/`upstream`/`branch`/`text` 与截断：哈希用 `node:crypto` 的 `createHash('sha256')` 对上传字节算，输出 64 位小写十六进制；截断阈值是同一个模块导出的常量 `RAW_RETURN_LIMIT_BYTES = 65536`（按 UTF-8 字节数计）。若 AC-143 出货的捕获端口构造不可 import（只存在于组装处内部），本条把它提到 `voice-capture.ts` 并导出 —— 这是本条允许的、也是必要的搬运；**本条不写 `voice.module.ts`**（模式读取、启动行、端口构造都是 AC-143 的；本条的载荷沿着那个唯一的构造点自动进入出货路径）。若实现时发现必须在 `voice.module.ts` 里改什么，说明 AC-143 出货的端口契约没留够，登记为发现，不在这条里顺手改。
3. **结果分支是从适配器自己的读数推出来的全函数**，闭集六个值：`written`（`ok && meta.writtenFallback === undefined`）、`verbatim-fallback`（`ok && meta.writtenFallback !== undefined`）、`no-speech`（`!ok && code === 'NO_SPEECH_DETECTED'`）、`envelope-error`（`!ok && code === 'UPSTREAM_ERROR'`）、`upstream-failure`（其余 `!ok` 且本次尝试真的发过请求，即 `upstream !== null`）、`preflight-refused`（五个预检出口 `unknownProviderFailure`/`containerRefusal`/`budgetRefusal`/`endpointRuleRefusal`/`validateConfiguredBackend`，以及其余没发出任何请求的失败）。
4. **`upstream` 的形状与截断的两头**：`{ status: number, body: string, truncated?: true }`；预检拒绝时 `upstream: null`。原始返回的 UTF-8 字节数 ≤ 65536 时 `body` **逐字等于**原始返回且**不带** `truncated` 键；> 65536 时 `body` 是原始返回的前 65536 字节（前缀性质）且 `truncated === true`。
5. **判据与取假形态**：`server/modules/voice/tests/voice-capture-text.test.ts`（AC-144 的 `criterion:` 文件，只有这一个文件能认领该判据）＋ `server/modules/voice/tests/voice-capture-text.false-forms.test.ts`（三个取假形态的可执行旁证，沿用本仓 `voice-dashscope-settings.false-forms.test.ts` 的形状：把出货源文件复制到同树临时路径、做一次文本变异、动态 import 变异体、重跑同一份读数、跑完即删；未变异副本必须先退出 0）。

**边界（不做）**：不做 audio 档写文件与目录/文件权限（AC-145）；不做三档脱敏判据（AC-146）；不做捕获异常的隔离判据（AC-147）；不做真实进程判据（AC-148）；不改 `voice.transcribe` 行在 `off` 档的逐字节形状（那是 AC-143 的读数，本条只消费它）；不改 `voice.module.ts`；不改适配器与 registry 契约、不改 `transcriptionWire.ts`；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端；不改 TTS 通路；不联网、不重跑实验、不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [x] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-text.test.ts` 退出 0；判据自身零子进程、零网络、零真实监听端口；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。
- [x] AC2 模式与端口来自出货路径，不是测试直接塞：判据把 `process.env.VOICE_CAPTURE` 设为 `'text'`，把它**原文**（不是字面量 `'text'`）交给 `voice-capture.ts` 里 AC-143 出货的唯一模式解析函数，并用同一个模块出货的端口构造函数建出捕获端口注入 `createVoiceService`；打印 `resolverInput=<env>`、`mode=<text>`。对照：同一 harness 在 `process.env.VOICE_CAPTURE` 未设置时捕获行数为 0 ⇒ 打印 `off.captureLines=0`。另断言判据文件里没有任何手写的 `voice.capture` 行构造（行的构造点只有出货模块一个）⇒ 打印 `handRolledRow=<b>`。
- [x] AC3 一次成功（书面分支）：`overrides.providerId='dashscope-omni'`、settings 里 `dashscopeEndpoint` 指到合规宿主（`https://<ws>.<region>.maas.aliyuncs.com`）、`dashscopeApiKey` 是本次运行唯一的哨兵、`dashscopeModel` 留空；替身 fetch 对这一请求回 200，体是 chat-completion 信封，`message.content` 里是含**非空 `transcript` 与非空 `instruction` 两份**的 JSON 对象。断言恰好 1 行 `voice.capture`，是合法单行 JSON（`JSON.parse` 成功且 `split('\n').length === 1`），并逐项打印读数：`idMatch`（其 `captureId` 与同一次 `voice.transcribe` 行上 `captureId=` 的值逐字相同）与 `adjacent`（捕获行紧跟在它的 transcribe 行之后）；`providerId === 'dashscope-omni'`；`model === <适配器模块现读的 DEFAULT_MODEL>`（`'qwen3.8-omni-flash'`）**且** `model !== defaults.sttModel`（判据把 `defaults.sttModel` 设成另一个哨兵，例如 `'whisper-1'`）⇒ `modelFromAdapterDefault=<b>`；`host === new URL(baseUrl).hostname` 且不含 `https://` 也不含 `/` ⇒ `hostIsHostname=<b>`；`mime === 'audio/webm'`、`bytes === AUDIO.length`；`sha256` 是 64 位小写十六进制且等于判据自己用 `createHash('sha256')` 算出的值 ⇒ `sha256Match=<b>`；`upstream.status === 200` 且 `upstream.body` **逐字等于**替身返回的原始响应体字符串 ⇒ `rawVerbatim=<b>`；`upstream` 不带 `truncated` 键 ⇒ `truncatedAbsent=<b>`；`branch === 'written'`；`text` 等于信封里那份 `instruction`（即返回给调用方的文本）。逐项打印上述值。
- [x] AC4 一次上游失败（重放 2026-09-24 的 dashscope 事件形状）：同一 harness、同一次运行，替身对这一请求回 404，体是判据自造的 JSON 错误体（例如 `{"error":{"code":"InvalidParameter","message":"model not found"}}`）。断言恰好 1 行 `voice.capture`，`upstream.status === 404`、`upstream.body` **逐字等于**那个错误体、`branch === 'upstream-failure'`；该行存在本身是读数主体 ⇒ 打印 `failRow=<n>`、`fail.status=<n>`、`fail.rawVerbatim=<b>`、`fail.branch=<v>`；并断言这一次的转写结果是失败。
- [x] AC5 预检拒绝也有一行：同一次运行再驱动一次，`audio.mimeType` 取一个**不在所选适配器声明的 `acceptsMime` 里**的值（判据从 `dashscopeOmni.capabilities.acceptsMime` 现读，取一个不在其中的值，例如 `audio/flac`）—— 这是 `containerRefusal` 那条预检出口。断言替身 fetch 的调用次数在这次尝试前后**相等**（该尝试没出网）⇒ `stubCallsUnchanged=<b>`；恰好 1 行 `voice.capture`，其 `upstream === null`；该行仍带 `captureId`/`providerId`/`model`/`host`/`mime`/`bytes`/`sha256`/`branch` 且 `branch === 'preflight-refused'`；打印 `preflightRow=<n>`、`upstreamNull=<b>`、`preflight.branch=<v>`。
- [x] AC6 分支闭集六值全覆盖：同一次运行再驱动三次 —— (a) 200 + 信封内 `instruction` 为空、`transcript` 非空 ⇒ `branch === 'verbatim-fallback'`；(b) 200 + 信封解析成功但两者皆空 ⇒ `branch === 'no-speech'`；(c) 200 + 体不是 chat-completion 信封 ⇒ `branch === 'envelope-error'`。加上 AC3/AC4/AC5 的三次，六次尝试的 `branch` **两两不同**且恰好覆盖六个值。逐例打印 `case=<…> branch=<…>`，最后打印 `branches=<6> distinct=<6>`。
- [x] AC7 截断的两头：同一次运行再驱动两次 —— (a) 200 体是 70000 个 ASCII 字符（> 65536）⇒ `upstream.body` 的 UTF-8 字节数**恰为 65536**、等于原体的前 65536 字节（前缀性质）、且 `upstream.truncated === true`；(b) 200 体**恰好 65536 字节**（不超限）⇒ `upstream.body` **逐字等于**原体且**不带** `truncated` 键。打印 `over.bodyBytes=<n>`、`over.prefix=<b>`、`over.flag=<b>`、`atLimit.verbatim=<b>`、`atLimit.flagAbsent=<b>`。
- [x] AC8 行内没有请求体与请求头（带正例，缺正例的「零」不算读数）：判据在 settings 的 `dashscopeApiKey`、上传音频里各放一个本次运行唯一的哨兵串；替身 fetch 记录它收到的 `(url, init)`。**(正例)** 打印 `wireCarriedKey=<b>`（替身收到的 `init.headers` 里确实带着那个 key，例如 `Authorization: Bearer <哨兵>`）与 `wireCarriedPrompt=<b>`（`init.body` 里确实带着适配器的冻结提示词 `JSON_TASK`，从适配器模块现读）。**(负例)** 全部 `voice.capture` 行的原始文本里都**不含** key 哨兵、`Bearer`、`Authorization`、`Content-Type`、`x-voice-stt-model`、`JSON_TASK` ⇒ 打印 `rowCarriesSecret=<b>`、`rowCarriesPrompt=<b>`。
- [x] AC9 不建任何文件：`VOICE_CAPTURE_DIR` 指到本次运行新建临时父目录下的**不存在**路径；八次尝试跑完后 `fs.existsSync(该路径) === false`，且 `readdirSync(临时父目录).length === 0`，且注入的写音频端口调用次数 `=== 0`；打印 `dirCreated=<b>`、`filesWritten=<n>`、`writeAudioCalls=<n>`。
- [x] AC10 既有面不退化：`server/modules/voice/tests/voice-capture-off.test.ts`（AC-143 的判据，本条改了它读的那份记录构造）、`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts`、`voice-provider-dispatch.test.ts` 六条各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0；逐条打印退出码（不是空过）。
- [x] AC11 三个取假形态是**可执行**的旁证：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-text.false-forms.test.ts` 退出 0，其中每条**先要求未变异副本退出 0**（恒红的工装不能证明任何事），再各自指名打红哪一条读数：(`i`) `upstream-body-replaced-by-final-text`：把 `upstream.body` 换成返回给调用方的 `text`（只记最终 text、不记原始返回）⇒ 必须让 AC3 的 `rawVerbatim` 判红；(`ii`) `failure-row-dropped`：失败尝试（`outcome === 'fail'`）不构造记录 ⇒ 必须让 AC4 的 `failRow` 判红；(`iii-a`) `no-truncation`：去掉截断（超限体整段记）⇒ 必须让 AC7 的 `over.bodyBytes`/`over.flag` 判红；(`iii-b`) `truncated-always-true`：无条件写 `truncated: true` ⇒ 必须让 AC3 的 `truncatedAbsent` 与 AC7 的 `atLimit.flagAbsent` 判红。变异体复制到同树临时路径（与 `voice-capture-text.test.ts` 同目录，使相对导入仍可解析）、跑完即删，`git status --porcelain` 在跑完后为空；每条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<…>`。
- [x] AC12 如实登记：判据输出与本任务的完成记录里写明「本条只做 text 档载荷（上游原始返回副本、实际模型、宿主名、mime/bytes/sha256、结果分支、返回文本、预检拒绝行、64KB 截断）；判据全程用替身 fetch 与注入的日志端口，未接触真实上游、未起真实进程、未写任何文件」。

## DoD

真实落地判据：不是「多了一个字段和一次 `JSON.stringify`」，而是**同一份出货 service** 在 `VOICE_CAPTURE=text` 下把「上游到底返回了什么」按字节留在日志里，并且这个留法对三个出口（成功、上游失败、预检拒绝）都成立、对超限体截断而对其余逐字、对请求体与请求头一无所留 —— 由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **原始返回是「读到的」而不是「算出来的」**（AC3 的 `rawVerbatim` + AC4 的原始错误体逐字）：判据自己造响应体、逐字比对行里的 `upstream.body`；只记最终 `text` 的实现在这里立刻红，且取假形态 (i) 指名打红的就是这一条读数。

(b) **三个出口都有一行**（AC3/AC4/AC5）：成功、上游 404、预检拒绝各有恰好一行，预检拒绝行的 `upstream` 是 `null` 且本次尝试 `stubCalls` 不增 —— 「只挂在上游返回之后」的实现会在 AC5 红，「只记成功」的会在 AC4 红，取假形态 (ii) 指名打红 AC4 那一行。

(c) **截断是两头的读数**（AC7 + 取假形态 iii-a/iii-b）：超限体是前缀且带标记，恰好不超的体逐字且不带标记 —— 不截断与无条件标记各被一条取假形态指名打红，所以「截断缺失」与「误标截断」不是同一句话而是两条读数。

**必须如实登记**：本条**不**做 audio 档、**不**做脱敏判据、**不**做捕获失败隔离、**不**做真实进程判据；**不**改 `voice.transcribe` 行在 `off` 档的逐字节形状（AC-143 的读数，本条只消费）；**不**写 `voice.module.ts`；判据跑在替身 fetch 与注入的日志端口上，未接触真实上游、未起真实进程；`VOICE_CAPTURE` 只在服务端环境变量上，不进设置页与健康负载。

**已知不等价点**：替身上游返回的响应体是判据自己写的，不等于真实 DashScope 的信封；「行内不带请求体与请求头」是「判据放的哨兵与冻结提示词在行里找不到」＋正例证明它们确实上过线，不是对全部可能请求头的穷举；`sha256` 与 `bytes` 量的是判据的音频，不是真实录音；六值分支闭集是对 `dashscope-omni` 的四条 return 加两个非解析出口的映射，注册第四个适配器时该映射要跟着改。

L_D 该轴仍暗，理由：本条读数全是布尔、存在性、逐字比对与固定阈值，没有可比的数值量；截断阈值是常量而不是测量。
L_G 该轴仍暗，理由：目标层的读数是真实服务进程标准输出上的捕获行（那条判据要求真实进程与本地替身上游），本条只到 service 与组装面。

## Touches

- server/modules/voice/voice-capture.ts
- server/modules/voice/tests/voice-capture-off.test.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-capture-text.test.ts (new)
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts (new)
- tasks/gap-voice-capture-text-payload.md
## 完成记录

**结论：text 档的一次尝试把「上游到底返回了什么」按字节留在日志里 —— 成功、上游 404、预检拒绝三个出口各恰好一行，超限体截断带 `truncated` 标记而恰好不超的逐字且不带该键，行内不含请求体/请求头/凭据，且全程零目录零写入；`off` 档同一 harness 零行。由执行读数证明，不由段落文字声明。**

- **交付**：`server/modules/voice/voice-capture.ts` 扩 AC-143 出货的那个唯一记录构造点 —— `buildVoiceCapturePayload`（唯一的载荷构造点，`recordAttempt` 里唯一的调用者）、`truncateVoiceCaptureReturn`（截断的两头，阈值是同一模块导出的 `RAW_RETURN_LIMIT_BYTES = 65536`）、`voiceCaptureBranch`（六值闭集的全函数）、`voiceCaptureHost`/`voiceCaptureSha256`。`server/modules/voice/voice.service.ts` 在 `transcribe` 内把注入的 `fetchBackend` 包一层**每次尝试一份**的 `captureTransport`（只记克隆体的 `{ status, body }`，原响应交回适配器；`init.body`/`init.headers` 不 spread、不留引用），并把 `upstream`/`requestSent` 与载荷输入一起交给 `recordAttempt`。判据 `server/modules/voice/tests/voice-capture-text.test.ts`（9 条读数）＋取假形态 `server/modules/voice/tests/voice-capture-text.false-forms.test.ts`（4 个变异 ＋ AC10 的八个面 ＋ 工装自清）。
- **读数**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-text.test.ts` 退出 0，10/10，`elapsed-ms=71 subprocess-or-socket-imports=0 socket-doors=0 readings=9/9`）：
  - AC2 模式与端口来自出货路径：`resolverInput=text mode=text off.mode=off off.captureLines=0 text.captureLines=8 attempts=8 handRolledRow=false` —— 解析函数的入参是 `process.env.VOICE_CAPTURE` 的**原文**，端口用出货的 `createVoiceCapture` 建；`off` 那半边是同一次运行里 `delete process.env.VOICE_CAPTURE` 后的同一份 harness，所以那个 0 是**对照读数**而不是空实现的零。
  - AC3 一次成功：`idMatch=true adjacent=true providerId=dashscope-omni model=qwen3.8-omni-flash modelFromAdapterDefault=true host=llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com hostIsHostname=true mime=audio/webm bytes=91 sha256Match=true upstream.status=200 rawVerbatim=true truncatedAbsent=true branch=written text="整理后的指令"` —— `model` 是适配器模块**现读**的 `DEFAULT_MODEL`，且判据把 `defaults.sttModel` 设成 `whisper-1` 哨兵，所以「那个 id 没进这条 provider 的行」是读数；`rawVerbatim` 比的是替身自己交出去的那个字符串。
  - AC4 一次上游 404：`failRow=1 fail.status=404 fail.rawVerbatim=true fail.branch=upstream-failure result.ok=false result.status=404`。
  - AC5 预检拒绝：`preflightRow=1 preflight.mime=audio/flac upstreamNull=true preflight.branch=preflight-refused stubCallsUnchanged=true preflight.captureId=text-3 preflight.providerId=dashscope-omni preflight.model=qwen3.8-omni-flash preflight.host=<同上> preflight.bytes=91 preflight.sha256=<64 位小写十六进制>`；`audio/flac` 是从适配器 `capabilities.acceptsMime` 现读后**取一个不在其中的值**（候选表在判据里，取到谁由声明决定）。
  - AC6 分支闭集：`case=empty-instruction branch=verbatim-fallback case=empty-both branch=no-speech case=not-an-envelope branch=envelope-error branches=6 distinct=6 [written upstream-failure preflight-refused verbatim-fallback no-speech envelope-error] missing=[]`。
  - AC7 截断的两头：`limit=65536 over.bodyBytes=65536 over.prefix=true over.flag=true atLimit.verbatim=true atLimit.flagAbsent=true over.sourceBytes=70000 atLimit.sourceBytes=65536` —— 前缀性质比的是替身原体的前 65536 字节，两个 fixture 的字节数本身也在读数里。
  - AC8 行内没有请求体与请求头（带正例）：`wireCarriedKey=true wireCarriedPrompt=true wireCarriedAudio=true rowCarriesSecret=false rowCarriesPrompt=false rowCarriesUpload=false rows=8 calls=14` —— 三条正例先证明那些哨兵确实上过线（key 在 `init.headers.Authorization`、提示词与音频在 `init.body`，提示词按 `JSON_TASK` 的两种拼写各找一次），三条负例才是有内容的零。
  - AC9 不建文件：`dirCreated=false filesWritten=0 writeAudioCalls=0 control.dirCreated=true control.filesWritten=1 control.writeAudioCalls=1` —— 后三条是**正控制**：同一个 harness 形状的 sink 在 `audio` 档被真的驱动一次，确实建了配置目录、写了一个文件，所以前三条的 0 不是「sink 根本不会写」。
  - AC12 登记（就是下面这份「如实登记」，读数里逐字打印）：`transport-calls=7/7 off-transport-calls=7/7 socket-doors=0 control-writes=1`（两档各 7 次出网/7 个排队的应答，预检拒绝那次一次都没出网）。
- **取假形态**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-text.false-forms.test.ts` 退出 0，6/6）：每条先要求未变异副本 `baseExit=0 readings=9 red=0`，再指名打红 —— `mutation=upstream-body-replaced-by-final-text baseExit=0 mutantRed=true whichReading=AC3/rawVerbatim`（`rawVerbatim=false`，另有 AC4/AC7 连带判红）；`mutation=failure-row-dropped baseExit=0 mutantRed=true whichReading=AC4/failRow`（`failRow=0`）；`mutation=no-truncation baseExit=0 mutantRed=true whichReading=AC7/over.bodyBytes+over.flag`（`over.bodyBytes=70000 over.flag=false`）；`mutation=truncated-always-true baseExit=0 mutantRed=true whichReading=AC3/truncatedAbsent+AC7/atLimit.flagAbsent`。每条还断言「预测的那条读数判红**且**它的读数串里含被变动的那个数字」（只判红不算，红得是这条原因），并留一条族外读数仍绿（`outsider-still-green=AC2 …`）。跑完 `git.status-clean=true unchanged=true temp-copies=none`。
- **AC10 既有面**（子进程半，在取假形态文件里逐条打印退出码）：`exit=0 cases=21 :: voice-capture-off.test.ts`、`cases=4 :: voice.service.test.ts`、`cases=7 :: voiceHealth.test.ts`、`cases=6 :: voice-config.routes.test.ts`、`cases=8 :: voiceTranscribeGaps.test.ts`、`cases=6 :: voice-provider-dispatch.test.ts`、`exit=0 cases=n/a :: npm run typecheck`、`exit=0 cases=n/a :: npm run lint`。
- **一处必要的收窄（发现，如实登记）**：AC-143 的判据里有一条读**同一行** `voice.capture` 的字段集合（`row-fields` 恰好等于它声明的五个）。本条按 AC5 给这行加了载荷字段，而那条判据的读数就必然红。出货的 `voice.module.ts` 是本条边界外（不写），`off` 档不带载荷，载荷又必须存在 —— 所以只有一处最小改动：把那条读数收窄到它真正拥有的**不变量**，期望集合 = 五个声明字段 ∪ **被测模块自己** `buildVoiceCapturePayload` 的键集（模块没有 builder 时就是那五个字段，比原断言更严不更松），并把 `payload-fields=[…]` 与 `row-fields=[…]` 一起打印。改完那条判据 21/21 绿、它自己的两个取假形态仍各自判红。`server/modules/voice/tests/voice-capture-off.test.ts` 因此进了本条的 `## Touches`（AC10 已把它列为必须退出的既有面之一）。
- **如实登记（AC12）**：本条**只做 text 档载荷**（上游原始返回副本、实际模型、宿主名、mime/bytes/sha256、结果分支、返回文本、预检拒绝行、64KB 截断）；**不**做 audio 档写文件与目录/文件权限（AC-145）、**不**做三档脱敏判据（AC-146）、**不**做捕获失败隔离（AC-147）、**不**做真实进程判据（AC-148）；**不**改 `voice.transcribe` 行在 `off` 档的逐字节形状（AC-143 的读数，本条只消费）；**不**写 `voice.module.ts`；**不**改适配器与 registry 契约、不改 `transcriptionWire.ts`；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端；不改 TTS 通路。判据全程用替身 `fetchBackend` 与注入的日志端口，未接触真实上游、未起真实进程（`socket-doors=0`）、除正控制那一个文件外未写任何文件。
- **不等价点（沿用 DoD 的登记）**：替身上游的响应体是判据自己写的，不等于真实 DashScope 的信封；「行内不带请求体与请求头」是「判据放的哨兵与适配器现读的冻结提示词在行里找不到」＋正例证明它们确实上过线，不是对全部可能请求头的穷举；`sha256`/`bytes` 量的是判据的音频；六值分支闭集是对 `dashscope-omni` 四条 return 加两个非解析出口的映射，注册适配器时该映射要跟着改；「恰好 65536 字节不带标记」用的是判据构造的等长体，不是真实流量的尺寸分布。
- **一处范围划分（如实登记）**：AC10 的子进程读数（六条既有判据、`npm run typecheck`、`npm run lint`）落在取假形态文件里，而不是判据文件里 —— AC1 要求判据文件自身零子进程且 15 秒预算内（那八个面合计实测约 25 秒，远超），所以两半的划分与理由写在两个文件的头部注释里。
