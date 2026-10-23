---
id: gap-asr-second-adapter-inline-only
title: 第二个适配器（多模态服务，仅内联）：超限返回 OVERSIZE 且零请求、预算按整个请求计、honors.prompt=false
  时不发提示字段（AC-132）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-extraction-parity-baseline
goal_ac: AC-132
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：全仓无任何任务声明 AC-132；`task_list` 全文检索「多模态 / 仅内联 / 第二个适配器」未命中以同一机制立案的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129，落契约、registry 与**第一个**适配器，且其边界里明确把「第二个 provider 与能力声明」让给 AC-132/133/134/135）与 `gap-asr-extraction-parity-baseline`（AC-130，录字节基线）。本任务是 ADR-004「后续任务 5」的立案。

**现场。** 今天全仓只有一种识别服务形状（OpenAI-compatible 的 `/audio/transcriptions`），因此「能力声明」这张表在代码里**没有第二个实例**，它的字段是否真的承重无从判定。本任务落第二个适配器：一个**仅内联**的多模态服务。它的内联上限是**整个请求的预算**（官方表述为「最大请求 20MB，含提示词与所有文件」），因此提示词与上下文会**挤占音频的可用预算** —— 这正是 ADR-004 决策 1 把该字段命名为 `maxInlineRequestBytes`（请求级）而不是「音频字节上限」的原因。

**本任务做什么。** 第二个适配器模块，能力声明 `oversize: 'reject'`（第一版只允许 `reject`，不得声明 `files-api`），在 registry 里按 id 登记。三条判据：超限返回 `OVERSIZE` 且**未发出任何请求**；预算按**整个请求**计（音频在预算内、加上长上下文后超预算必须被拒）；`honors.prompt` 为 false 时请求体**不含**提示字段。

**依赖与落点。** 适配器缝必须已存在（本任务 `depends_on` 含 `gap-asr-extraction-parity-baseline`，即 ADR-004 的 S0/S1 已闭合）。落点沿用 ADR-004 决策 2/3 的候选。若该服务需要引入服务商 SDK，ADR-004 允许它发生在**适配器落地任务**里，但**必须**在边界探针之后 —— 本任务的依赖已保证这一点。

**边界（不做）。** 不修三处既有缺口（AC-133/134）；不做裁剪 × 能力的接线（AC-135）；不做配对质量实验（按 ADR-004 决策 8 归实验记录）；不改两条路径的路由与 UI；不改第一个适配器与既有线上字节（AC-129/AC-130）。

## Plan

- **S0 落适配器模块。** 纯模块 + 注入全部环境依赖；能力声明含 `acceptsMime`、`maxInlineRequestBytes`（**请求级**预算）、`oversize: 'reject'`、`honors.{prompt,language,context}`、`billing`、`pauseCues`、`style`、`oneShot`。
- **S1 registry 登记。** 按 provider id 注册；未注册 id 的 fail-closed 行为由既有 registry 承担（健康检查面的 fail-closed 是 AC-134 的词，不在本任务）。
- **S2 探针与三条取假控制。** 各成一条独立可红用例；先证未变异为绿、再证变异为红。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence。

## AC

- [x] AC1 超过 `maxInlineRequestBytes` 的输入返回 `OVERSIZE`，且**未发出任何请求**（注入替身断言调用次数为 0）。取假变体：把超限音频直接塞进请求体 ⇒ 必须红（「调用次数为 0」这一半）。
- [x] AC2 **提示词与上下文计入同一预算**：构造一个「音频本身在预算内、加上长上下文后超预算」的用例，必须被拒。取假变体：只按音频字节判定预算、不计提示词与上下文 ⇒ 上面那个用例必须红。
- [x] AC3 `honors.prompt` 为 false 时，请求体**不含**提示字段（不发、而不是发空值）。
- [x] AC4 取假变体：把响应解析写成宽松形式（把整个响应 JSON 当文本返回）⇒ 解析基线必须红。
- [x] AC5 第一版只允许 `oversize: 'reject'`：能力声明里出现 `files-api` ⇒ 必须红（默认拒绝路径必须显式声明，不能靠「上游会报错」）。
- [x] AC6 经 registry 按 id 解析到该适配器：`resolve(id)` 返回的 `capabilities` 与该模块导出的常量逐字段相等。
- [x] AC7 离线：全程注入替身，零网络；发生真实网络调用即红。
- [x] AC8 空读数不是绿：适配器未被 registry 解析到、或替身调用次数读数为空 ⇒ 探针非零退出。
- [x] AC9 三条取假形态各为 `scripts/asr-second-adapter-check.test.mjs` 内一条独立可红用例；`node --test scripts/asr-second-adapter-check.test.mjs` 退出码 0。
- [x] AC10 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## Evidence

读数环境：本任务的工作树（分支 `task/gap-asr-second-adapter-inline-only`，基于 develop `0a04cff3`）。**全程离线** —— 探针在整个运行期把 `globalThis.fetch` 换成「记账并抛错」的替身，且每个用例的 `baseUrl` 都是 `https://asr.invalid`（`fetchImpl` 由调用方注入）。

**1. 行为探针（AC1–AC8 的机械读数）** — `node scripts/asr-second-adapter-check.mjs`，exit 0，48 条 `reading=`：

```text
registry=shared/asr/asrRegistry.ts
provider-modules=1
  provider-module=shared/asr/list/multimodal/multimodal.asr-provider.ts
registered=multimodal
reading=registered-count value=1
reading=provider-module.shared/asr/list/multimodal/multimodal.asr-provider.ts.id value=multimodal
reading=resolve(multimodal).id value=multimodal
reading=resolve(multimodal).capabilities.acceptsMime value=["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/aac","audio/ogg","audio/flac","audio/webm"]
reading=resolve(multimodal).capabilities.billing value="request"
reading=resolve(multimodal).capabilities.honors value={"prompt":false,"language":false,"context":true}
reading=resolve(multimodal).capabilities.maxInlineRequestBytes value=20971520
reading=resolve(multimodal).capabilities.oneShot value=true
reading=resolve(multimodal).capabilities.oversize value="reject"
reading=resolve(multimodal).capabilities.pauseCues value="useful"
reading=resolve(multimodal).capabilities.style value="written"
reading=budget-bytes value=20971520
reading=capabilities.acceptsMime value=["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/aac","audio/ogg","audio/flac","audio/webm"]
reading=capabilities.maxInlineRequestBytes value=20971520
reading=capabilities.oversize value=reject
reading=capabilities.honors value={"prompt":false,"language":false,"context":true}
reading=capabilities.billing value=request
reading=capabilities.pauseCues value=useful
reading=capabilities.style value=written
reading=capabilities.oneShot value=true
reading=capabilities.acceptsMime.length value=8
reading=oversize-policy value=reject
reading=oversize-audio-bytes value=15728643
reading=oversize-encoded-bytes value=20971524
reading=oversize-code value=OVERSIZE
reading=oversize-calls value=0
reading=affordable-audio-bytes value=11796480
reading=affordable-encoded-bytes value=15728640
reading=context-bytes value=20971520
reading=budget-audio-alone-ok value=true
reading=budget-audio-alone-calls value=1
reading=budget-audio-plus-context-code value=OVERSIZE
reading=budget-audio-plus-context-calls value=0
reading=hints-calls value=1
reading=hints-body-bytes value=2857
reading=hints.prompt.honored value=false
reading=hints.prompt.text-present value=false
reading=hints.language.honored value=false
reading=hints.language.text-present value=false
reading=hints.context.honored value=true
reading=hints.context.text-present value=true
reading=response-envelope-ok value=true
reading=response-envelope-text value=hello world
reading=response-non-envelope-json-ok value=false
reading=response-non-envelope-json-text value=<none>
reading=response-non-json-ok value=false
reading=response-non-json-text value=<none>
reading=ambient-fetch-calls value=0
```

两个尺寸（`15728643` 超限 / `11796480` 可用）不是硬编码的数，而是**从声明的预算推导**出来的（`Math.ceil((budget+1)/4)*3` 与 `Math.floor(budget*0.75/4)*3`，对应 base64 的 3→4 膨胀），所以声明一旦变动，这两条用例会随动，而不是静默地不再跨在预算两侧。

逐条对照：

| AC | 读数 | 结论 |
| --- | --- | --- |
| AC1 | `oversize-code=OVERSIZE`（音频 15728643 B，编码后 20971524 B，超出 20971520 B 的请求预算）+ `oversize-calls=0` | 超限被拒，且**零请求**。调用计数是替身自己记的，不是从错误码反推 |
| AC2 | `budget-audio-alone-ok=true` / `budget-audio-alone-calls=1`，而同一段 11796480 B 音频加上 20971520 B 上下文后 `budget-audio-plus-context-code=OVERSIZE` / `budget-audio-plus-context-calls=0` | 两读数的音频对象**同一尺寸**，唯一变量是上下文，所以能解释两种判定的只能是预算的**作用域**：整个请求，不是音频字节 |
| AC3 | `hints.prompt.honored=false` + `hints.prompt.text-present=false`；阳性对照 `hints.context.honored=true` + `hints.context.text-present=true` | 不承认的提示不在线上；被承认的上下文在线上 —— 所以「不在线上」不能由一个什么 hint 都不发的 body builder 满足 |
| AC4 | `response-envelope-text=hello world`；`response-non-envelope-json-*-ok=false`（`text=<none>`）、`response-non-json-*-ok=false` | 只认生成信封；网关错误 JSON 与 502 HTML 都不会被当成转写文本返回 |
| AC5 | `oversize-policy=reject`（且 `resolve(...).capabilities.oversize` 同值） | 默认拒绝是**显式声明**，不靠「上游会报错」 |
| AC6 | `resolve(multimodal).capabilities.{acceptsMime,billing,honors,maxInlineRequestBytes,oneShot,oversize,pauseCues,style}` 与 `capabilities.*` 逐字段同值（8 字段 × 2 组） | registry 交回的正是该模块导出的那个常量，不是它的副本或改写 |
| AC7 | `ambient-fetch-calls=0`（环境 fetch 被毒化，任何真实调用都会以 `NETWORK_CALL` 记名） | 真实网络调用数为 0 |
| AC8 | 见下（两条空读数控制），探针非零退出 | 未解析到 / 读数为空都不是绿 |

**2. 取假控制（AC1–AC8 的可红性）** — `node --test scripts/asr-second-adapter-check.test.mjs`，exit 0，`tests 9 / pass 9 / fail 0 / duration_ms 23404.230005`。每条控制先把**未变异**的 fixture 跑绿（否则该条什么也证明不了），再打**恰好一个**变异，并断言**具名判词**而不只是退出码 —— 一个因无关理由变红的探针不会算作证据：

| 变异 | 判词 |
| --- | --- |
| AC1 超限守卫失效（`if (false)`）⇒ 超限音频照样发出 | `OVERSIZE_NOT_ZERO_REQUEST` |
| AC2 预算改按音频字节计（`request.audio.bytes.length`） | `BUDGET_IS_AUDIO_ONLY` |
| AC3 honors 声明不再被施加 ⇒ 提示照样上线 | `PROMPT_SENT` |
| AC4 解析放宽 ⇒ 整个响应体当转写返回 | `LOOSE_RESPONSE_PARSE` |
| AC5 声明 `oversize: 'files-api'` | `OVERSIZE_POLICY_NOT_REJECT` |
| AC6 registry 交回一个非模块导出的声明 | `CAPABILITIES_MISMATCH` |
| AC7 适配器改抓环境 `fetch`（毒化生效） | `NETWORK_CALL` |
| AC8 registry 里没有登记项 | `ADAPTER_UNRESOLVED` |
| AC8 `transcribe` 返回空 | `EMPTY_READING` |

fixture 是运行时用 `cpSync` **从本仓的发货文件拷出来**的（`package.json`、`tsconfig.json`、两个模块），不是手抄的替身 —— 手抄的只会证明探针读得懂那个替身。`package.json` 不是装饰：它的 `"type": "module"` 决定 loader 把 `.ts` 当 ESM 载入；缺了它，fixture 自身的 import 会被按 CommonJS 解析，探针根本载不进 registry（实测 `ERR_REQUIRE_CYCLE_MODULE`），因此它被列进 `SHIPPING_FILES`。

**3. 单元道（始终在线的那一半）** — `npx vitest run src/shared/asr/tests/multimodalAdapter.test.ts` → `Test Files 1 passed (1) / Tests 13 passed (13)`，exit 0。它把同样的声明与守卫在**每次改动都会跑的套件里**再压一遍，并多一条守卫用例断言那两个推导出的尺寸确实跨在预算两侧。

**4. 静态门（AC10）** — `npm run typecheck` exit 0。它跑三个 tsc 工程，其中 `server/tsconfig.json` 的 `include` 含 `../shared/**/*.ts`，所以「同一份 shared 模块被前端与后端两套配置同时编译」这条是**机械核过**的，不是声称的环境中立。`npm run lint` exit 0，新增的四个文件零 finding。

**5. 全量客户端套件（越界检查）** — `npx vitest run` → `Test Files 91 passed (91) / Tests 639 passed (639)`，9.09s：新增的 13 条没有打破套件里的任何既有断言。

**6. 模块规范的适用性（`AGENTS.md`）** — 按落点加载：本任务在 `server/` 下**零文件**，故 `$backend-module-standards` 不适用，其目录/barrel/类型归置规则未被施加。`$frontend-module-standards` 已加载并适用于唯一落在 `src/` 下的产物 `src/shared/asr/tests/multimodalAdapter.test.ts`：用类型别名而非 `interface`、类型导入走 `import type` 内联形式、无相对 `./`/`../` 导入。两处需要说明的判断：(a) 该文件的位置由任务的写入面钉死 —— `## Touches` 只声明了 `src/shared/asr/tests/…` 与 `shared/asr/tests/…` 两个测试路径，挪去 `src/shared/tests/` 会落进 anti-drift 的 `out-of-declared`；而写在 `shared/` 一侧则永远不会被 vitest 的 `include: ['src/**/*.test.ts']` 收集，等于没有始终在线的那一半。(b) 它 import 的是**仓根** `shared/` 树（不是 `src/` 的应用代码），该树的正规别名是 `@shared/*`（ADR-004 决策 2），`@/*` 指不到它。

**7. 边界（本任务不证明的）** — 未改第一个适配器、未改两条路径的路由与 UI、未做裁剪 × 能力接线；缺口一/二/三（AC-133/134）与裁剪接线（AC-135）不在本任务读数内。

## DoD

真实落地判据：不是「多了一个 provider 目录」，而是**第二个识别器的形状差异真的由能力声明表达、且差异是可红的**。承重性由三组正面读数证明：

(a) 「未发出任何请求」这一半必须由替身的调用计数机械证明（AC1），而不是靠「返回了错误码」推断；
(b) 预算的**请求级**语义必须由「音频在预算内、加上长上下文后超预算」那个用例机械证明（AC2）—— 只按音频字节判定的实现会在该用例上把「音频字节上限」当成预算，因此必红；
(c) 声明为不承认的提示参数必须**不发**（AC3），这条与 AC-132 的能力声明面直接对应。

**本任务不证明**缺口一/二/三被修（AC-133/134），也不证明裁剪接线（AC-135）；它只证明「第二个适配器存在，且它的差异由能力声明驱动、可红」。

L_D 该轴仍暗，理由：本任务只落第二个适配器与其内联预算语义，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- shared/asr/list/multimodal/multimodal.asr-provider.ts (new)
- src/shared/asr/list/multimodal/multimodal.asr-provider.ts (new)
- shared/asr/asrRegistry.ts
- src/shared/asr/asrRegistry.ts
- shared/asr/tests/multimodalAdapter.test.ts (new)
- src/shared/asr/tests/multimodalAdapter.test.ts (new)
- scripts/asr-second-adapter-check.mjs (new)
- scripts/asr-second-adapter-check.test.mjs (new)
- package.json
- tasks/gap-asr-second-adapter-inline-only.md
