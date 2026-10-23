---
id: gap-voice-trim-default-flipped-by-unregistered-first-adapter
title: 裁剪读数退回全 null 占位：出货识别器从未登记进 registry，未命名 provider 部署的裁剪默认被翻成「不裁」
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-121
---
## Proposal

**现象（本轮的直接测量，不是台账尾巴）**：`npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` 退出 1，8.1s，红在 `e2e/voice-trim.spec.ts:1009`：

```
expect(reading.fallback).toBe(false);   // received: true
```

开关打开的那一腿拿到的是一条**全 null 占位**读数。运行期 trace 里那一行原文是：

```
[voice:trim] {"source":"mic","inputSec":null,"outputSec":null,"savedSec":null,"savedRatio":null}
```

它由 `src/modules/chat/hooks/useVoiceInput.ts:130` 的 `unmeasured()` 产出 —— 也就是 `reportCapture` 收到的是「没量过」的记录，而不是测量结果。

**机制（四跳，逐跳可指）**：

1. `src/modules/chat/hooks/useVoiceInput.ts:232` 取有效识别器：`const recogniser = effectivePauseCuesDeclaration();`
2. `src/modules/chat/hooks/useVoiceInput.ts:233` 在第一道闸就返回：`if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) return recorded;` —— 开关是开的，所以退出的原因是**能力答的不是 `destructive`**。
3. `src/shared/api.ts:654` 的 `effectivePauseCuesDeclaration()` 拿 `voiceProviderProfile` 的 id 去问 registry；那个 id 来自 `server/modules/voice/voice.service.ts:79` 的 `effectiveProviderId()` —— `listProviders()[0]?.id ?? ''`。e2e 不设 `VOICE_PROVIDER_ID`（`server/modules/voice/voice.module.ts:19` 的默认串为空），用户配置只有遗留的 `voiceConfig`（baseUrl/apiKey/sttModel）、不含 provider id，于是**有效 provider = 注册表的第 0 行**。
4. `shared/asr/asrRegistry.ts:221` 的 `REGISTERED` 自建表（`187d98d2`）以来**只有一行** —— `multimodal`。而 `shared/asr/list/multimodal/multimodal.asr-provider.ts` 声明 `pauseCues: 'useful'`，于是 `trimDecisionFor('useful').trim === false`，裁剪从不运行。

**缺的是「第一个适配器」。** `multimodal` 模块自己的文件头写着它是**第二个**识别器（"a multimodal service, inline only … where the first one is an audio-seconds, multipart, verbatim, prompt-shaped one"）。它说的那个「第一个」——出货识别器本身，OpenAI-compatible `/audio/transcriptions` 形状——**从未被登记过**。`docs/proposals/voice-asr-provider-seam.md` 的 S0 明写「契约 + registry + **把现有 OpenAI-compatible 抽成第一个适配器**」，其 L2 给出路径 `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts`，line 422 要求「抽取后**行为零变化**」。S0 只落地了契约、registry 与第二个适配器；`shared/asr/list/` 下至今只有 `multimodal/`。

**后果一句话**：这个部署**报告**自己是 `multimodal`，**实际**把音频 POST 给 `/audio/transcriptions`（`shared/asr/transcriptionWire.ts` 的单一实现，AC-129 已证）—— 有效 provider id 本身就是一句假话，而裁剪读的正是这句假话。

**时间线（到秒）**：`gap-voice-debug-switch`（曾声明 `goal_ac: AC-121`）2026-09-21T16:36:18Z 翻 done，AC-121 在 2026-09-23T03:16:35Z 与 04:17:47Z 两次 sweep 均 pass。`0ae696cd`（"fix(voice): the trim asks the registry for 裁不裁, not a table of its own"，AC-134 的修复）落于 2026-09-23T05:06:05Z，删掉了客户端自带的那张 `destructive` 表；`develop` 于 05:17:13Z 快进到 `079787fd`。**AC-121 首次变红是 05:18:41Z —— 快进后 88 秒**，此前 329 条事件里没有一次失败。

**这不是意外，是 ADR 自己写下的假变体。** `adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md` 后续任务 9：「把默认改成「不裁」⇒ 既有时长下降判据必须红」；`goals/GOAL-008` 的范围与 `AC-135` 的标题都要求**默认行为不变**。`0ae696cd` 的提交信息也如实登记了这次行为变化：有效 provider 是 `multimodal`、声明 `useful`，于是实测听写不再被裁剪（zh-d01-o85 10.910s → 11.887s，en-e01-o45 6.290s → 11.323s），并写明产品裁定不归该任务。所以「早期修复没有守住」的原因是清楚的：AC-121 的修复建立在「裁剪默认会跑」之上，而把裁剪决策改由能力声明驱动的那次修复，让一个**从未登记的出货识别器**变成了有效 provider，默认随之翻面。

**修法**：把出货识别器按它**本来的**能力登记进 registry —— 以 `openai-compatible` 为 id、`pauseCues: 'destructive'` 的第一个适配器。这正是 ADR-004 §二 的实测结论所指的那一家（中文句读 −89%，账单省 25.5%/13.3%），proposal line 330 原文：「`capabilities.pauseCues === 'destructive'` ⇒ 按现状裁剪」。**声明仍是唯一来源**（AC-134 的机制一字不动），不重引入任何客户端表，不削弱 `e2e/voice-trim.spec.ts`。

**为什么不选别的**：

- 不改 `multimodal` 的声明为 `destructive`：那是**假声明**。它的配对实验（`docs/experiments/2026-09-22-voice-provider-paired-quality.md`，即它自己的 `PAUSE_CUES_EVIDENCE` 行）量出的就是 `useful`。
- 不 supersede AC-121：ADR 明写当前状态是缺陷方向（假变体），不是「这条保证已非本仓意图」。
- 不改 e2e 断言：把断言放松等于把金丝雀的眼睛蒙上，之后同类翻面再也不会被发现。
- 本任务**不**把直连/代理/CLI 三个消费者改接到适配器的 `transcribe` 上（那是 seam 的 S4 路由分派）：改接会引入 parity 风险，而本任务要的是「能力有唯一来源」，不是「路由已分派」。适配器的 `transcribe` 由既有契约套件对着替身 fetch 证明。

<!-- dedup-ref -->
本案与 `gap-voice-debug-switch`（done，开关与读数）、`gap-asr-pause-cues-second-source-contradicts-registry`（done，AC-134，把读点从客户端自带表挪到 registry）、`gap-asr-trim-capability-wiring`（done，AC-135，把裁剪决策接到能力声明）机制互不相同：三者都已 done，本案不是它们的重复，而是它们落地之后暴露出的**登记缺口** —— 声明有了唯一来源，可那个来源里从来没有出货识别器这一行。

**关联影响（如实登记，不属于本任务）**：AC-119 上一次 sweep 是 05:16:51Z、AC-122 是 04:32:38Z，都早于 05:17:13Z 的 `develop` 快进，它们的绿是**陈的**，下一轮 sweep 会红，本任务修好之后应当一并转绿。另：`scripts/asr-trim-capability-check.mjs` 当前退出 1，原因是它要求 `src/shared/voiceTrim.ts` 里存在一张导出声明表，而那张表正是 AC-134 有意删除的 —— 机制不同、归属 GOAL-008 的判据，本任务不改动它，也不因它变红而宣称本任务失败。

## Plan

- **S0（不变量先行）**：`scripts/asr-contract-invariants-check.mjs` 已对**每一个**注册适配器参数化。先跑它并记下当前读数（缺登记时的正对照），S2 之后重跑，新适配器一登记就自动进套件。
- **S1**：新建 `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts`，导出 `id` / `capabilities` / `transcribe`。能力字段**必须与出货路径今天已经执行的东西逐项一致** —— MIME 白名单、单请求体积上限与 `oversize`、`honors`、`billing: 'audio-seconds'`、`style: 'verbatim'`、`oneShot: true`，以及 `pauseCues: 'destructive'`（唯一一个不由「现状」读出、而由 ADR-004 §二 的配对实测得出的值）。`transcribe` 组合既有的 `shared/asr/transcriptionWire.ts`（`createTranscriptionRequest` / `parseTranscriptionResponse`）与注入的 `invocation`：**不读 env、不建 fetch、不碰 express/db**，这份文件被两套编译配置同时编译。
- **S2**：在 `shared/asr/asrRegistry.ts` 的 `REGISTERED` **首位**登记它，并在同文件的 `PAUSE_CUES_EVIDENCE` 加它的行，指向一份**实际存在**的记录（`scripts/asr-trim-capability-check.mjs:459` 会 `existsSync` 校验所名字的文件）。登记后重跑 S0 与三个次序敏感的读者 —— `scripts/asr-pause-cues-source-check.mjs`、`scripts/asr-health-provider-check.mjs`、`scripts/asr-mime-size-gaps-check.mjs`（后两者读 `listProviders()[0]`）—— 把它们读到的「第一个适配器」对齐到新事实；若某个读者的期望值本身是硬编码的旧身份，就在同一提交里改它的期望，不改它的问题。
- **S3**：新建 `src/shared/tests/voiceTrimShippedRecogniser.test.ts`：断言 `pauseCuesDeclarationFor(<出货 id>)` 非 null、`capability === 'destructive'`、`trimDecisionFor(...).trim === true`，并断言 `listProviders()[0]` 就是它（有效 provider 与出货识别器同一）。取假变体：把登记从 `REGISTERED` 移除，该用例与 AC1 都必须红。
- **S4**：重跑 AC-121 / AC-119 / AC-122 全腿，并核对 `e2e/voice-trim.spec.ts` 未被改动。
- **本案不做**：不改接三个消费者；不动 `e2e/voice-trim.spec.ts` 的任何断言与腿；不处理 `scripts/asr-trim-capability-check.mjs` 的红；不给任何 provider 声明造假值。

## AC

- [x] AC1 `npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` 退出 0。修前同一命令退出 1、红在 `e2e/voice-trim.spec.ts:1009`（`fallback` 收到 `true`）；两份读数原文都记进 DoD。
- [x] AC2 `npx playwright test e2e/voice-trim.spec.ts`（整文件，AC-119/120/121/122 全腿）退出 0 —— 没有哪条腿被本改动弄红。
- [x] AC3 `npx playwright test e2e/voice-trim.spec.ts -g "AC-119"` 与 `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 各自退出 0（两条的上一次 sweep 都早于 `develop` 快进，绿是陈的）。
- [x] AC4 取假变体：把新适配器从 `REGISTERED` 移除后重跑 —— AC1 必须**退出非 0**，且 `npx vitest run src/shared/tests/voiceTrimShippedRecogniser.test.ts` 必须**退出非 0**。两次假形态的退出码与失败行原文记进 DoD。
- [x] AC5 `node scripts/asr-contract-invariants-check.mjs` 退出 0（新适配器自动进入该套件）；`npx vitest run src/shared/tests/voiceTrimShippedRecogniser.test.ts` 退出 0。
- [x] AC6 次序敏感的读者对齐新事实：`node scripts/asr-pause-cues-source-check.mjs`、`node scripts/asr-health-provider-check.mjs`、`node scripts/asr-mime-size-gaps-check.mjs` 各自退出 0；其中第一条的输出仍须含 `client-pauseCues=none` 与 `client-declaration-source=none`（没有在客户端重引入第二张表）。
- [x] AC7 `npm run typecheck` 退出 0；`npm run lint` 退出 0（新适配器被根配置与 `server/tsconfig.json` 两套配置同时编译）。
- [x] AC8 开关语义与无条件读数未被改动：`git diff --name-only <base>..HEAD | grep -c 'e2e/voice-trim.spec.ts'` 输出 `0`；且 AC2 的整文件跑里「`?voiceDebug=off&voiceTrim=on` 下 0 条 `[voice:trim]`、而 `[voice] identifier fidelity` 读数仍然到达」这一腿通过。

## DoD

- 真落地：e2e 环境里一次**真实录音**走完 录音 → 解码 → 裁剪 → 编码 → 上传 → 填回，`[voice:trim]` 读数带非 null 的 `inputSec / outputSec / savedSec / savedRatio / vadSegments / speechKeptRatio`、`fallback: false`、`identifiers.before.rate / identifiers.after.rate / repairHits` 齐备 —— 这是「对象真的经过了机制」，不是「用例存在」。
- 账本翻正：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-121 的台账尾巴由 fail 转 pass。
- 三次取假运行的原文（命令 + 退出码 + 失败行）：
  1. 修前 AC1 → 退出 1，红在 `e2e/voice-trim.spec.ts:1009`；
  2. 摘掉登记后的 AC1 → 退出非 0；
  3. 摘掉登记后的不变量用例 → 退出非 0。
- 关联影响如实写进完成记录：AC-119/AC-122 的旧绿是陈的；`scripts/asr-trim-capability-check.mjs` 仍红，原因是它要求一张 AC-134 有意删除的表，归属 GOAL-008，本任务不改它，也不拿它当本任务的失败。
- L_D 该轴仍暗，理由：本任务只修复「有效 provider 与出货识别器不一致」这一处登记缺口，不新增领域数据能力，也没有可读出的领域读数。
- L_G 该轴仍暗，理由：同上 —— 目标层判据由 GOAL-006 的其余判据承担，本任务只承担「裁剪默认回到出货行为，读数重新字段齐备」这一条。

## 完成记录

### 落地（实现提交 `9c809952`，任务分支 `task/gap-voice-trim-default-flipped-by-unregistered-first-adapter`）

- 新建 `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts`：`id = 'openai-compatible'`，`capabilities` 与出货路径今天已经在执行的东西逐项一致（multipart / audio-seconds / verbatim / one-shot / `oversize: 'reject'` / `maxInlineRequestBytes` / MIME 白名单 / `honors`），外加那个不由现状读出、而由 ADR-004 §二 配对实测得出的 `pauseCues: 'destructive'`。`transcribe` 只组合既有的 `shared/asr/transcriptionWire.ts` 与注入的 `invocation`：不读 env、不建 fetch、不碰 express/db。
- `shared/asr/asrRegistry.ts`：`REGISTERED` **首位**登记它（`wire: 'multipart'`），`multimodal` 退居第二（`wire: 'inline-json'`）；`PAUSE_CUES_EVIDENCE` 加它的行，指向实际存在的 `docs/experiments/2026-09-22-voice-provider-paired-quality.md`。
- 新建 `src/shared/tests/voiceTrimShippedRecogniser.test.ts`（4 条，全绿）：登记存在且 registry 交回适配器**自己的**声明；有效 provider 声明 `destructive` ⇒ `trimDecisionFor(...).trim === true`；**名字不等于身份** —— 驱动 registry 交回的那一行 `transcribe`，断言 URL 为 `transcriptionEndpoint(...)` 且 body 是 `FormData`；未登记的 id 仍答 `null`（没有长出「任何 id 都答话」的兜底行）。

### 一处未登记却必须改的文件：`src/modules/chat/hooks/useVoiceAvailable.ts`（AC 命中：AC1）

**只登记适配器不足以让 AC1 转绿。** `useVoiceAvailable.ts` 的 `check()` 在 `readVoiceConfig().baseUrl.trim()` 为真时直接 `setAvailable(true); return;` —— 而 e2e 种的正是这种形态（`voiceConfig.baseUrl = recognizerUrl`）。这条早退路径从不调用 `checkVoiceHealth()`，而 `checkVoiceHealth()` 是 `setVoiceProviderProfile(...)` 的唯一调用者，也就是 `voiceProviderProfile` 的唯一发布点。于是 `src/shared/api.ts` 的 `effectivePauseCuesDeclaration()` 拿到的 id 为空、答 `null`，裁剪门在第二道闸（`recogniser === null`）就返回 —— **与登记与否无关**。

取证（临时插桩，随后全部还原，`git diff --stat` 为空）：修前 e2e 运行中 47 次 `direct-path early return; health never asked`、49 次 `gate {"trimEnabled":true,"recogniser":null}`。

修法：在这条早退路径上**照样**问一次健康读数并 `await`（不是 fire-and-forget —— 紧随其后开始的录音仍要看到那份声明），失败被 `catch(() => {})` 吞掉而不是并进 `available`：自己配了后端的用户不该因为这台服务器答不上就丢麦克风。服务器答不上时 profile 仍不发布，即这条路径原来的答案（「不裁」），绝不是坏麦克风。

### 三次取假运行（命令 + 退出码 + 失败行）

1. **修前 AC1** → `npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` **退出 1**（8.2s），红在 `e2e/voice-trim.spec.ts:1009`：`expect(reading.fallback).toBe(false)` → `Expected: false / Received: true`。
2. **摘掉登记后的 AC1**（把新适配器行从 `REGISTERED` 移除、其余不动）→ 同上命令 **退出 1**，红在同一行 `e2e/voice-trim.spec.ts:1009`（`fallback` 收到 `true`）。
3. **摘掉登记后的不变量用例** → `npx vitest run src/shared/tests/voiceTrimShippedRecogniser.test.ts` **退出 1**，失败行原文：`expected 'multimodal' to be 'openai-compatible'` 与 `expected 'useful' to be 'destructive'`。

变体随后还原：`git status --porcelain` 为空，HEAD 仍为 `9c809952`。

### 其余读数（全部现场实测，本 worktree）

- AC1：`npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` **退出 0**（9.7s）。
- AC2：`npx playwright test e2e/voice-trim.spec.ts`（整文件 4 腿）**退出 0**：AC-119 8.2s / AC-120 3.7s / AC-121 9.5s / AC-122 8.3s。
- AC3：`-g "AC-119"` **退出 0**；`-g "AC-122"` **退出 0**。
- AC5：`node scripts/asr-contract-invariants-check.mjs` **退出 0**，读数 `verdict=pass groups=5 readings=88 platform-fetch-calls=0`（新适配器自动进了套件）；`npx vitest run src/shared/tests/voiceTrimShippedRecogniser.test.ts` **退出 0**（4/4）。
- AC6：三个次序敏感的读者各 **退出 0**；`scripts/asr-pause-cues-source-check.mjs` 的输出仍含 `client-pauseCues=none` 与 `client-declaration-source=none`（客户端没有第二张表）。
- AC7：`npm run typecheck` **退出 0**；`npm run lint` **退出 0**。
- AC8：`git diff --name-only develop..HEAD | grep -c 'e2e/voice-trim.spec.ts'` → **`0`**；AC2 的整文件跑里 `?voiceDebug=off&voiceTrim=on` 那一腿（0 条 `[voice:trim]`、`[voice] identifier fidelity` 仍到达）包含在 4 条全绿之内。
- 三个受次序影响读者的取假对照同样绿：`scripts/asr-second-adapter-check.test.mjs` 9/9、`scripts/asr-pause-cues-source-check.test.mjs` 5/5、`scripts/asr-health-provider-check.test.mjs` 4/4、`scripts/asr-mime-size-gaps-check.test.mjs` 5/5。
- 未受牵连的回归：`src/shared/tests/voiceProviderFailClosed.test.ts` 一字未改且绿；`npx vitest run` 整前端单测 98 files / 672 tests 通过；`npm run test:server` 674 pass / 0 fail / 1 skipped；`npm run build:client` 退出 0。

### `## Touches` 修正（如实登记，逐条给出被哪个 AC 逼出）

原 Touches 登记了 6 个文件，实际提交是 12 条路径。补登记 6 条，每条的强制来源：

- `src/modules/chat/hooks/useVoiceAvailable.ts` —— **AC1**（没有它 AC1 恒红，机制与取证见上）。
- `shared/asr/asrInvariants.ts` —— **AC5**。不变量板对**每一个**注册适配器参数化；新适配器一登记，它的 `AsrWire`（可选类型，**缺省即 `inline-json`**）就必须进模型，否则 `node scripts/asr-contract-invariants-check.mjs` 在 wire 分组上判红。
- `scripts/asr-contract-invariants-check.test.mjs` —— **AC5** 的取假对照（`empty-registry` 锚点必须跟着新的两行 `REGISTERED` 字面量走）。
- `scripts/asr-second-adapter-check.mjs`、`scripts/asr-second-adapter-check.test.mjs` —— 既有判据 **AC-132** 的探针；它必须随传输线形状走，否则「第二个适配器」的读数会把新登记的第一行误当成第二个。
- `scripts/asr-pause-cues-source-check.test.mjs` —— **AC6** 的取假对照（被读的 `scripts/asr-pause-cues-source-check.mjs` 是已登记文件）。

### 关联影响（如实登记）

- AC-119（05:16:51Z）与 AC-122（04:32:38Z）的上一次 sweep 绿是**陈的**，都早于 05:17:13Z 的 `develop` 快进。本轮 AC2/AC3 已现场重跑，两条都退出 0 —— 悬置读数到此为止，且未为此做任何额外改动。
- `scripts/asr-trim-capability-check.mjs` 仍退出 1（`npm run test:scripts` 里 9 条相关用例红）。**这是既存读数，不是本任务引入**：已在不含本改动的 `develop` 主检出上复跑同一文件，同样 9/9 红。原因如任务正文：它要求 `src/shared/voiceTrim.ts` 里存在一张导出声明表，而那张表正是 AC-134 有意删除的，机制不同、归属 GOAL-008。本任务不改它，也不拿它当本任务的失败判据。

## Touches

- shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts (new)
- shared/asr/asrRegistry.ts
- shared/asr/asrInvariants.ts (被 AC5 逼出：不变量板按注册适配器参数化)
- src/shared/tests/voiceTrimShippedRecogniser.test.ts (new)
- src/shared/tests/voiceProviderFailClosed.test.ts (覆盖面登记，未修改)
- src/modules/chat/hooks/useVoiceAvailable.ts (被 AC1 逼出：用户配置路径上的健康读数发布点)
- scripts/asr-contract-invariants-check.mjs
- scripts/asr-contract-invariants-check.test.mjs (被 AC5 逼出：取假对照)
- scripts/asr-pause-cues-source-check.mjs
- scripts/asr-pause-cues-source-check.test.mjs (被 AC6 逼出：取假对照)
- scripts/asr-health-provider-check.mjs
- scripts/asr-mime-size-gaps-check.mjs
- scripts/asr-second-adapter-check.mjs (AC-132 的探针须随传输线形状走)
- scripts/asr-second-adapter-check.test.mjs (同上)
- tasks/gap-voice-trim-default-flipped-by-unregistered-first-adapter.md
