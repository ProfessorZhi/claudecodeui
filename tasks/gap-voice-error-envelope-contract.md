---
id: gap-voice-error-envelope-contract
title: 语音转写路由的失败信封：所有失败带 error 与 code（词表成员），上游失败另带合规
  upstreamCode（[A-Za-z0-9._-]、长度有界、取自上游响应体码串），响应无 key、无 Bearer
  形式、无上游响应体其余文本（AC-150）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-150
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rn "^goal_ac: *AC-150" tasks/*.md` → 0 命中；全量 164 条任务里 `goal_ac` 等于 `AC-150` 的 0 条；`grep -rln "AC-150" --include=*.md --include=*.ts --include=*.mjs .` 只命中 `goals/AC-150-*.md`、`goals/GOAL-011-*.md`、`docs/proposals/voice-error-messages.md` 与同族任务的溯源段落。同族四条判据里 `gap-voice-error-classification-and-status-table`（AC-149）认领的是「分类函数与状态表」这一格，本条认领的是「出货路由的失败信封」这一格：那条把（上游状态、响应体码串）变成 `AsrErrorCode`，本条把换来的 code 连同合规的 `upstreamCode` 送上线路，并保证线路上没有 key、没有 `Bearer` 形式、没有上游响应体里不属于码串的文本。本条的读数**不钉任何 code 字面量**，只读「是出货运行期词表的成员」，所以词表在 13 码扩充前后都成立；`upstreamCode` 的取值是上游响应体里的码串本身（如 `AccessDenied.Unpurchased`），不是分类结果，两格不重叠。

**这条判据要的是什么（AC-150 原文拆开）**

1. 经**出货的路由**驱动四类失败各一次——预检拒绝、上游各类失败、无语音、不可达；每一类的失败响应都含 `error` 与 `code`。
2. 上游失败另含 `upstreamCode`：只由字母、数字、点、下划线、连字符组成、长度有界，且**取自上游响应体里的错误码串**。
3. 响应里不含 key 明文，不含 `Bearer` 加 key 的形式，也不含上游响应体里不属于码串的文本。替身上游把一段**哨兵文本**放进响应体；**正例**是它确实在上游响应里（可读到的正对照），而它不得出现在返回给页面的响应里。
4. 取假形态：(1) 上游失败不带 `code` ⇒ 必须红；(2) 把上游响应体原样放进 `error` 或 `upstreamCode` ⇒ 必须红。

**现状（立案时实测，可复验）**

| 项 | 实测 |
|---|---|
| 判据文件 | 不存在：`ls server/modules/voice/tests/voice-error-contract.test.ts` → `No such file or directory` |
| 失败信封的今天 | 路由的 `sendFailure`（`voice.routes.ts:50-64`）**只在** `result.code !== undefined` 时带 code；上游失败一律不带——`voice.service.ts:1028-1035` 返回 `{ ok: false, status, error: result.message }`，注释原文「The code is deliberately not republished here」 |
| `upstreamCode` | 树里 0 命中：`grep -rn "upstreamCode" shared/ server/ src/ scripts/` 只命中 `docs/proposals/voice-error-messages.md` 与 `goals/`；类型面 `server/shared/types.ts:1398-1415` 的 `VoiceServiceResult.code` 连 `upstreamCode` 字段都还没有 |
| 类型注释写死了旧规则 | `server/shared/types.ts:1400-1401`：「Absent for the failures whose meaning a caller does not branch on — an unreachable backend, a rejected key」，与本条「所有失败都带 code」直接冲突 |
| 上游响应体已经在手 | `voice.service.ts:793-800` 的 `captureTransport` 无条件把 `{ status, body }` 记进 `upstreamAnswer`（与捕获模式无关，`off` 档也安装），所以码串**不需要改适配器**就能取到；`upstreamAnswer` 是 `transcribe` 的局部量，`!result.ok` 那条返回在同一个作用域里 |
| 今天靠什么不泄漏 | 靠 message 的构造方式（`provider 'x' answered 403` 一类），没有机械读数；`readTextQuietly` 读到的 `failureText` 只喂给 `isModelNotPurchased`（`dashscope-omni.asr-provider.ts:566-575`），从不进 message |
| 无语音与不可达两支 | 适配器给出 `NO_SPEECH_DETECTED` / `UNREACHABLE` / `TIMEOUT`，服务在这里把 code 丢掉 ⇒ 线上只剩 `{ error }` |
| 预检拒绝里不带码的两支 | `voice.routes.ts:83-86` 的 `readUploadFailure` 对非 `LIMIT_FILE_SIZE` 的 parser 失败只回 400 不带码；`voice.routes.ts:153` 的 `No audio uploaded` 也只回 `{ error }` |
| 路由驱动配方已存在 | `voiceTranscribeGaps.test.ts:133-183` 的 `postThroughRouter` 把出货 router 当**中间件函数**驱动、用假 response 收 status 与 body，不绑端口——其注释点名理由就是避开 ephemeral-port lottery；本条的判据沿用这个配方 |

**要交付的事**

1. **类型面**（`server/shared/types.ts`）：失败支加 `upstreamCode?: string`，并把 `code` 的注释从「不可达与被拒的 key 不带码」改写成新规则：`/api/voice/transcribe` 的**每一个**失败都带 `code`，`upstreamCode` 只在上游确实答了话且答话里有码串时才有。
2. **上游码串的提取只有一份实现**，落在 `shared/asr/asrRegistry.ts`（与词表同处，供直连路径复用）：入参是上游响应体文本，出参是满足 `^[A-Za-z][A-Za-z0-9._-]{0,63}$` 的码串或 `undefined`。裁定（写进注释）：只取响应体里的**码串**——JSON 里 `code`/`error.code` 一类的字段值、或已知形态的点分驼峰 token；**绝不整段复制**；长度有界（超过 64 的候选不取，或截断到 64，二者择一但必须由判据的超长臂读出结果）；取不到就**不带** `upstreamCode`——不许兜造、不许把 body 塞进去。若 AC-149 的分类器已经落在树上并挑出了匹配串，这条提取器必须复用它而不是并列第二张匹配表。
3. **服务面**（`server/modules/voice/voice.service.ts`）：`!result.ok` 那条返回改成带 `code: result.code` 与 `upstreamCode: <从 upstreamAnswer.body 提取>`；`upstreamAnswer === null`（transport reject = 连不上）或 body 里没有码串 ⇒ 不带 `upstreamCode`。同时改写两处注释：`:318-346` 的表注释块（今天写「只有 pre-upstream 的拒绝 republish code」）与 `:1028-1035` 的分支注释（今天写「deliberately not republished」）。
4. **路由面**（`server/modules/voice/voice.routes.ts`）：`sendFailure` 把 `code` 与 `upstreamCode`（存在时）放进响应体；`readUploadFailure` 的非上限 400 支与 `No audio uploaded` 支**也要带 code**——取值从出货词表里选一个成员（词表是闭集，最合适成员的裁定写进完成记录）。注意这会顶掉 `voiceTranscribeGaps.test.ts:196-200`「非上限的 parser 失败仍 400 且不带 code」那条读数，同一次改动里只改期望值、不放松结构。
5. **判据文件**（`server/modules/voice/tests/voice-error-contract.test.ts`，AC-150 的 `criterion:` 文件，只有它能认领该判据）：出货 router（`createVoiceRouter`）＋出货 `createVoiceService`（注入离线替身 `fetchBackend`）＋替身 `parseAudioUpload`＋记录替身收到的 `init.headers`，整体按 `voiceTranscribeGaps.test.ts` 的中间件配方驱动，读假 response 的 status 与 body。四臂各一次，另加两条对照臂：上游答了 5xx 但 body 里**没有码串**（code 有、`upstreamCode` 缺席）；上游 body 里的候选码串 200 字符（长度界读数）。断言集与打印格式见 AC1-AC4。
6. **取假形态**（`server/modules/voice/tests/voice-error-contract.false-forms.test.ts`，三段形状沿用 `voice-capture-off.false-forms.test.ts`：未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外至少一条仍绿；变异体写在与被测文件同树的临时路径、跑完即删、`git status --porcelain` 不变）：
   - (i) `upstream-failure-without-code`：服务里那条 provider 失败返回去掉 `code`（等价于今天的形状）⇒「上游失败带 code」的读数必须红；
   - (ii) `raw-body-copied-through`：把 `upstreamCode`（或 `error`）换成上游响应体原文 ⇒ 哨兵缺席 / 正则 / 长度界三条读数里至少一条必须红；
   - 族外控制：预检拒绝臂的 status 读数仍绿。
7. **既有面不退化（逐条打印退出码，不是空过）**：`voiceTranscribeGaps.test.ts`（含被本次顶掉的那一条）、`voice-provider-dispatch.test.ts`（AC-139 的判据）、`voice-provider-dispatch-falsify.test.ts`、`voice-config.routes.test.ts`、`voice-capture-text.test.ts`（AC-144 的捕获行，读的是 `logAttempt` 的 meta，不受本条影响但必须逐条读出绿）、`voiceHealth.test.ts`、`voice.service.test.ts` 各退出 0；`npm run typecheck`、`npm run lint` 各退出 0。

**与同族的边界**：本条只做**信封**（线上形状）；词汇表扩充、码串表与状态表是 `gap-voice-error-classification-and-status-table`（AC-149）的交付面，本条不重做、不并列第二张表；十二语言文案（AC-151）、直连路径与代理路径同码（AC-152）、真实浏览器（AC-153）都在本条之外。ADR-004 的词汇表修订与 `voice.service.ts` 注释里「传输层失败不带码」那句的更新由 AC-149 的任务承担，本条只动与自己直接冲突的那两处注释。

**已知不等价点与限制**

- 判据跑在**离线替身 fetch** 上，替身上游的响应体形状（JSON 里带 `code` 字段）不等于真实 DashScope 的响应体；真实上游没被驱动。
- 「取自上游响应体里的错误码串」在判据里只能机械读到「合规 **且** 是 body 的子串」，读不到「它确实是那个语义码串」——语义归属由 AC-149 的分类器负责，本条不重复断言。
- 预检拒绝里「缺文件 / 非上限的 parser 失败」两支的 code 取值在词表里的最合适成员由实现定（词表是闭集），判据只读成员资格与存在性，因此这两支的具体取值不是判据、是完成记录。
- 无语音（空答案）与 422 的文案统一是 AC-151/AC-153 的事，本条只保证这两支**带** code。
- 全部判据不绑端口、不起子进程、不联网；不等于真实部署下的网关行为。

## AC

- [x] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-contract.test.ts` 退出 0；判据自身零子进程、零真实监听端口、零网络（离线替身 `fetchBackend`），末尾打印 `elapsed-ms=<n>` 且实测 < 15000（目标侧判据门是 60 秒硬上限、不可调）。打印 `subprocess-or-socket-imports=<n>`。
- [x] AC2 四臂逐条带 `error` 与 `code`：预检拒绝臂（`LIMIT_FILE_SIZE` 形状的 parser 失败 ⇒ 413；缺文件与格式拒各一条）、上游失败臂（至少三条不同上游状态，各自 body 里带码串）、无语音臂（200 且 envelope 里既无 instruction 也无 transcript ⇒ 422）、不可达臂（`fetchBackend` reject）各驱动一次。逐条打印 `arm=<名> status=<n> code=<c> hasError=<b> upstreamCode=<c|none>`，并断言 `error` 是非空字符串、`code` 是**出货运行期词表的成员**（键集从出货的 `PROVIDER_ERROR_STATUS` 读，不另抄一份字符串数组）。打印 `arms=<n> coded=<n>`。
- [x] AC3 `upstreamCode` 合规且取自响应体：对每条上游失败臂断言 `upstreamCode` 匹配 `^[A-Za-z][A-Za-z0-9._-]{0,63}$`、`length <= 64`、且 `upstreamBody.includes(upstreamCode)` 为真；**非捏造对照**两条——上游答 5xx 但 body 无码串 ⇒ `code` 有而 `upstreamCode` 缺席；不可达臂 ⇒ `upstreamCode` 缺席；**长度界臂**一条——body 里候选串 200 字符 ⇒ 响应里长度 ≤ 64（或缺席），不得出现 200 字符。打印 `upstreamCode=<值> codeCompliant=<b> isSubstringOfBody=<b> noBodyArm=<none|值> unreachableArm=<none|值> oversizeArmLen=<n>`。
- [x] AC4 零泄漏读数带正对照：**正对照先在**——断言替身上游收到的 `init.headers` 里确实有 `Bearer <fakeKey>`、且替身上游的响应体确实含哨兵文本（两条都为真才继续）；随后把返回给页面的整个响应体序列化，断言其中不含 `fakeKey` 明文、不含 `Bearer ` + `fakeKey`、不含哨兵文本；再对 `error` 与 `upstreamCode` 两个字段单独各断言一次。打印 `sentinelInUpstream=<b> keyInUpstreamRequest=<b> sentinelInResponse=<b> keyInResponse=<b> bearerInResponse=<b>`。
- [x] AC5 取假形态可执行：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-contract.false-forms.test.ts` 退出 0；两例各自「未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外仍绿」，并逐例指名：`upstream-failure-without-code` 红 AC2 的上游臂、`raw-body-copied-through` 红 AC3/AC4 的哨兵、正则或长度读数；跑完 `git status --porcelain` 与本文件启动时逐字相同、无临时副本残留。打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<…> outsideFamilyGreen=<b>`。
- [x] AC6 既有面不退化（逐条打印 `exit=<n> name=<…>`，不是空过）：`voiceTranscribeGaps.test.ts`（含本次改为带 code 的那条）、`voice-provider-dispatch.test.ts`、`voice-provider-dispatch-falsify.test.ts`、`voice-config.routes.test.ts`、`voice-capture-text.test.ts`、`voiceHealth.test.ts`、`voice.service.test.ts` 各退出 0；`npm run typecheck` 与 `npm run lint` 退出 0。被顶掉的 `voiceTranscribeGaps.test.ts:196-200` 在完成记录里写清「原来钉什么、现在钉什么」。
- [x] AC7 词表成员读数不另抄一份：判据从 `voice.service.ts` 的出货 `PROVIDER_ERROR_STATUS` 读键集，断言每个观察到的 `code` 都在其中，并打印 `vocab-size=<n> observed-codes=<…> all-members=<b>`；源码里不存在第二份 code 字符串数组（`grep -n "ASR_ERROR_CODES\|ERROR_CODES" server/modules/voice/tests/voice-error-contract.test.ts` 对「本文件自建词表数组」为 0 命中）。
- [x] AC8 如实登记：判据输出与本任务完成记录里写明「本条只做路由失败信封（`code` 全覆盖、`upstreamCode` 的提取与合规、零泄漏读数、两例取假形态）；未做词汇表扩充与分类函数（AC-149）、十二语言文案（AC-151）、直连路径统一（AC-152）、真实浏览器（AC-153）、ADR-004 修订；未改 `voice.transcribe` 行的形状；未联网、未跑真实上游；预检两支的 code 取值选择与 `voiceTranscribeGaps` 那条被改读数逐条登记」。

## DoD

真实落地判据：不是「多了一个字段」，而是**出货的路由加出货的服务**（按 `voice.module.ts` 的组装方式串起来）在四类失败上真的给出了带 `code` 的响应、上游失败真的带上了取自上游响应体的合规 `upstreamCode`，而线路上读不到 key 与上游响应体里不属于码串的文本——由执行读数证明，不由段落文字声明。承重性由四件读数证明：

(a) **信封是全覆盖的**（AC2）：四臂里没有一条只有 `error` 没有 `code`；取假形态 (i) 指名打红上游臂——「上游失败带 code」与「上游失败不带 code」是两条可分辨的读数。

(b) **`upstreamCode` 是从响应体里取的、且合规**（AC3）：正则、长度界与「是 body 子串」三条同时为真；两条非捏造对照（无码串的 5xx、连不上）证明它是取到的而不是兜造的，超长臂证明长度界是真的。

(c) **零泄漏不是空集上的断言**（AC4）：正对照先读出「哨兵确实在上游响应里」「key 确实在上游请求里」，再读「两者都不在返回给页面的响应里」——缺了正对照，一个把替身换成空响应的实现也会绿。

(d) **取假形态是可执行旁证**（AC5）：两例各自在预测族里红一条并指名，族外仍绿，且跑完树是干净的。

**跨判据的连带改动必须如实登记**：`voiceTranscribeGaps.test.ts:196-200`（`a parser failure that is not the ceiling is still 400 and carries no code`）与本条「所有失败都带 code」直接冲突，必须在**同一次改动**里改成新期望值并写进完成记录（改了哪一行、原来钉什么、现在钉什么）；`voice-provider-dispatch.test.ts` 与 `voice-provider-dispatch-falsify.test.ts` 是 AC-139 的判据，本条只允许新增而不得放松，逐条退出码读绿。

**已知不等价点**：替身上游 ≠ 真实 DashScope（响应体形状是判据自己造的）；「码串的语义归属」由 AC-149 的分类器负责，本条只读合规性与子串关系；预检拒绝里缺文件与非上限 parser 失败两支的 code 取值是完成记录项而非判据项。判据不绑端口、不联网，不等于真实部署下的网关行为。

L_D 该轴仍暗，理由：本条读数全是字符串形状与集合成员（正则、长度、子串、键集），没有可比的数值量。
L_G 该轴仍暗，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到 HTTP 响应体。

## Touches

- shared/asr/asrRegistry.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice.routes.ts
- server/shared/types.ts
- server/modules/voice/tests/voice-error-contract.test.ts (new)
- server/modules/voice/tests/voice-error-contract.false-forms.test.ts (new)
- server/modules/voice/tests/voiceTranscribeGaps.test.ts
- scripts/asr-mime-size-gaps-check.mjs
- tasks/gap-voice-error-envelope-contract.md

## 完成记录

**判据与取假形态的实测读数**（`voice-error-contract.test.ts` 27 例全绿、退出 0、`elapsed-ms=128`、`subprocess-or-socket-imports=0`；`voice-error-contract.false-forms.test.ts` 退出 0）

- 四类失败共 12 臂，逐臂 `error` 非空且 `code` 是出货词表成员：`arms=12 coded=12 errored=12 upstream-statuses=6 [401 403 429 404 500 200]`。预检臂 `parser-ceiling:OVERSIZE(413)`、`parser-other:UNSUPPORTED_MIME(400)`、`missing-file:UNSUPPORTED_MIME(400)`、`format-refusal:UNSUPPORTED_MIME(415)`；上游臂 `upstream-401:code=UNAUTHORIZED/upstreamCode=InvalidApiKey`、`upstream-403:code=UNAUTHORIZED/upstreamCode=AccessDenied.Unpurchased`、`upstream-429:code=RATE_LIMITED/upstreamCode=Throttling.RateQuota`、`upstream-404:code=UPSTREAM_ERROR/upstreamCode=Model.NotFound`、`upstream-500:code=UPSTREAM_ERROR/upstreamCode=none`、`upstream-500-overlong:code=UPSTREAM_ERROR/upstreamCode=none`；`no-speech:code=NO_SPEECH_DETECTED(422)`；`unreachable:code=UNREACHABLE(502)`。
- AC3：`upstreamCode=[upstream-401:InvalidApiKey upstream-403:AccessDenied.Unpurchased upstream-429:Throttling.RateQuota upstream-404:Model.NotFound] codeCompliant=true isSubstringOfBody=true noBodyArm=none unreachableArm=none oversizeArmLen=0`（`candidateLen=200 candidateInResponse=false`）。
- AC4：`sentinelInUpstream=true keyInUpstreamRequest=true sentinelInResponse=false keyInResponse=false bearerInResponse=false field-level-clean=true bodies=12`。
- AC7：`vocab-size=10 observed-codes=[OVERSIZE UNSUPPORTED_MIME UNAUTHORIZED RATE_LIMITED UPSTREAM_ERROR NO_SPEECH_DETECTED UNREACHABLE] observed=12 all-members=true`；键集由 `import { PROVIDER_ERROR_STATUS } from '../voice.service.js'` 读入，`grep -n "ASR_ERROR_CODES\|ERROR_CODES" server/modules/voice/tests/voice-error-contract.test.ts` 0 命中。
- AC5：`upstream-failure-without-code` base 绿 → 变异体族内红 11 条（`whichReading=AC2 arm/upstream-401`，`red-reason=... code=none hasError=true ...`），族外仍绿；`raw-body-copied-through` base 绿 → 族内红 9 条（`whichReading=AC3 code/upstream-401`，`upstreamCode={"code":"InvalidApiKey"} codeCompliant=false`）并含 `AC4 leak/serialized-response`；树读数见下一条（第二轮改后：`own-temp-copies=none temp-copies-any=0 foreign-temp-copies=0 raw-unchanged=true added=0 removed=0 concurrent-foreign-only=false`）。
- AC6：`exit=0 name=voiceTranscribeGaps cases=8`、`voice-provider-dispatch cases=6`、`voice-provider-dispatch-falsify cases=1`、`voice-config.routes cases=6`、`voice-capture-text cases=10`、`voiceHealth cases=7`、`voice.service cases=4`、`name=typecheck`、`name=lint`。
- 连带读的 AC-133 判据（`node scripts/asr-mime-allowlist-check.mjs`）退出 0、`verdict=pass`，其中 `transport-non-ceiling=400/UNSUPPORTED_MIME`；同族的 `asr-single-implementation-check` / `asr-proxy-only-ssrf-check(verdict=ok)` / `asr-second-adapter-check` / `asr-contract-invariants-check(verdict=pass)` 均退出 0。

**预检两支 code 取值的裁定**（词表闭集，最合适成员）

`readUploadFailure` 的非上限 400 支与 `No audio uploaded` 支都取 `UNSUPPORTED_MIME`（常量 `MALFORMED_UPLOAD_CODE`，`voice.routes.ts:110`）。理由：词表十个成员里，只有它是对「上传本身长什么样」下判断（其余分别对服务、对音频内容、对大小下判断），而这两支要说的正是「你送来的不是这条路径能接的音频上传」；两处状态码不变（仍 400），因为状态答传输层、code 答原因；不与 `OVERSIZE` 共用（413 有独立补救）。不新造字符串，且在 AC-149 按证据扩表前后都成立。

**与既有判据直接冲突、在同一次改动里改掉的两处（连带改动登记）**

1. `server/modules/voice/tests/voiceTranscribeGaps.test.ts:196-200`：原来钉 `assert.equal(outcome.body.code, undefined)` 一类读数（「非上限的 parser 失败仍 400 且不带 code」）；现在钉 `code === 'UNSUPPORTED_MIME'`，`status`（400）与 `error`（`/Unexpected field/`）两半原样不动，测试名改为 `a parser failure that is not the ceiling is still 400 and carries the vocabulary code`。
2. `scripts/asr-mime-size-gaps-check.mjs`（AC-133 的 criterion `scripts/asr-mime-allowlist-check.mjs` 的 delegate，其 AC3 transport 层控制）：原来要求 `other?.body?.code === undefined`，现在要求「`code` 是字符串且不是 `OVERSIZE`」。GOAL-008 AC3 的文本读数（其余 parser 失败仍是 400）原样保留，被顶掉的只是「不带码」这一枚附加钉子；该文件已登记进 `## Touches`。

**范围登记（AC8）**

本条只做路由失败信封：`code` 全覆盖（上游失败与无语音、不可达都带上）、`upstreamCode` 的一份提取实现（`shared/asr/asrRegistry.ts` 的 `extractUpstreamCode`）与合规（正则 / 长度界 / 取自 body）、零泄漏读数（带正对照）、两例取假形态。未做：词汇表扩充与分类函数（AC-149，注释里点名其分类器必须复用 `extractUpstreamCode` 而不是并列第二张匹配表）、十二语言文案（AC-151）、直连路径与代理路径同码（AC-152）、真实浏览器（AC-153）、ADR-004 词汇表修订；未改 `voice.transcribe` 行的形状（`logAttempt` 的字段未动，`voice-capture-text.test.ts` 读数原样绿）；未联网、未驱动真实上游（替身回答的 body 是判据自己造的）。判据不绑端口、不起子进程、不联网，不等于真实部署下的网关行为。

**有意的例外：仍然不带 `code` 的失败**（「每一个失败都带 code」的边界，写进 `VoiceServiceResult.code` 与表注释）

`validateConfiguredBackend` 的格式拒（「这个设置根本不是 URL」，是部署状态而非关于一次尝试的意义；更窄的 endpoint 规则才是 `INVALID_BASE_URL` 那条）、未注册 provider id（同样是无成员可命名的状态）、以及 TTS 面（共用该类型但不共用识别器词表）。让这三处保持不带码，才使 `voice.service.test.ts:112` 的 `deepEqual` 与既有读数原样成立——即「不放松既有面」与「所有失败带码」两条要求在该交界处按上述边界收敛；这一取舍在 `server/shared/types.ts` 与 `voice.service.ts` 的表注释里各写明一次。

**第二轮：AC5 的树读数按 pid 划界（并发下的跨进程伪红）**

fan-in 的 suite 红在这一条上。原因不是判据的实现被 suite 放大，而是一个**跨进程读数**：`scripts/test.sh` 默认一次跑 4 个服务端文件，而 `server/modules/voice/` 这个目录被四个判据共用——`voice-capture-off.false-forms`、`voice-capture-text.false-forms`、`voice-dashscope-settings.false-forms` 都往同一目录写 `__criterion-falsify-*` 副本。某个同伴在本文件**启动时**还持有副本、到本文件读数时已清掉，于是「快照 vs 终态」的逐字比较在一个**终态为空**的树上读成了 changed：suite 记 `passed=false`，实测读数 `git.status-clean=true unchanged=false temp-copies=none`，断言文 `this run changed the worktree's git status: (empty)`（终态为空，被改的是起点）。⚠️ suite 行里 `not ok - <file>: <…>` 的 reason 是 `first_error` 抓到的**变异体 stdout**（它的 JSON 里有 `error` 字段），不是失败原因；失败原因由下表的前置复现读出。

本轮把那半条读数的断言面按 pid 划到「本次运行自己的产物」：自己的副本仍**无条件红**且比改前更精确（改前会把同伴的副本当成自己的残留来报）；差集**只有**在每一行都是别的 pid 的临时副本时才被原谅；其余增 / 删 / 改一律保持红，且失败时把差集两侧与两侧首行都打印出来（旧消息只打终态，正好把「起点脏」说成「终态脏」）。新增打印字段 `own-temp-copies temp-copies-any foreign-temp-copies raw-unchanged added removed concurrent-foreign-only`。

复现与控制（每例都是该文件的**完整**运行；A 例即 suite 里那次的配置）：

| 控制 | 配置 | 结果 |
|---|---|---|
| 前置复现（改前） | 外来的 `__criterion-falsify-*` 在启动时在位、4s 后删除 | `RC=1`，`git.status-clean=true unchanged=false temp-copies=none`，`AssertionError: this run changed the worktree's git status: (empty)` —— 与 suite 红同形 |
| A（改后，同配置） | 同上 | `RC=0`，`unchanged=true raw-unchanged=false added=0 removed=1 concurrent-foreign-only=true`，并打印 `falsify/concurrent-foreign-only=true (… another process, alive at this file's start and cleaned up by now)` |
| B（改后，负对照：非临时文件） | 运行时新增 `__probe-stray.txt`（不含该前缀） | `RC=1`，`added=[?? server/modules/voice/__probe-stray.txt]`——非同伴产物的增项仍红 |
| C（改后，负对照：本次自己的副本） | 运行时写入以**本进程 pid** 结尾的 `__criterion-falsify-ownprobe-base-<pid>.ts` 且不删 | `RC=1`，`own-temp-copies=?? server/modules/voice/__criterion-falsify-ownprobe-base-2522127.ts`，断言文 `this run left its own temp copies behind: …`——自己泄漏仍是满强度红 |

改后**干净树**上的读数（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-contract.false-forms.test.ts`，退出 0、4 例全绿）：`falsify/leftovers: git.status-clean=true unchanged=true own-temp-copies=none temp-copies-any=0 foreign-temp-copies=0 raw-unchanged=true added=0 removed=0 concurrent-foreign-only=false`。

作用域门（driver 同款）：`bash scripts/test.sh --for-task gap-voice-error-envelope-contract --allow-thin` 在合并 develop 后的树上绿（3 例 3 过、退出 0），`--write-scoped-gate-cache --develop-sha cb2e207e` 已登记。

**同族遗留（不在本条 `## Touches`，未改）**：那三个同伴文件的同类读数仍是「全仓库前缀扫描 + 原始逐字比较」，所以**本文件**的副本在它们快照期间在位时，理论上仍可能红在它们身上（本轮 suite 里没发生）。这属于共用目录的既有并发面；本条只划自己的界，未碰它们的文件。