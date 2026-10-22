---
id: gap-asr-dashscope-user-credential-configured-mask-and-log
title: DashScope 的用户凭据（key 与工作空间地址）存于服务端语音设置：健康检查按 provider 报 configured、key
  掩码回读、一次成功与一次失败的转写后日志无 key 明文与正文，TTS 仍用原 baseUrl/apiKey（AC-141）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-proxy-provider-dispatch
  - gap-asr-proxy-only-ssrf-and-direct-path-zero
goal_ac: AC-141
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源；真正的 gating 在 frontmatter 的 `depends_on`，不是本段提到的任何 id）：立案时 `grep -rn "^goal_ac:.*AC-141" tasks/*.md` 零命中；`AC-141` 在 `tasks/` 下只出现在三条同族任务的**范围让渡**文字里 —— `tasks/gap-asr-dashscope-omni-wire-and-degradation.md`（`goal_ac: AC-138`）、`tasks/gap-asr-proxy-provider-dispatch.md`（`goal_ac: AC-139`）、`tasks/gap-asr-proxy-only-ssrf-and-direct-path-zero.md`（`goal_ac: AC-140`），最后一条逐字写着「不做用户级 provider 选择、key 掩码与健康检查的 `configured` 语义（AC-141）」「不把用户**存的服务地址**接进服务端（那是 AC-141 的词……）」。本条是它们白纸黑字让出的那一半，不是它们的重述；判据文件 `server/modules/voice/tests/voice-dashscope-settings.test.ts` 在 `server/` 下也零命中。

**现状（立案时实测，可复验）**：

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/voice-dashscope-settings.test.ts` → `No such file or directory` |
| DashScope 的用户凭据字段 | `grep -rn "dashscope" --include=*.ts server/ src/` **零命中**；`VoiceSettings`（`server/shared/types.ts:1348`）只有 6 个字段（`baseUrl`/`apiKey`/`sttModel`/`ttsModel`/`ttsVoice`/`ttsFormat`），没有 `providerId`/`dashscopeEndpoint`/`dashscopeApiKey`/`dashscopeModel` |
| key 掩码 | `grep -rni "mask\|redact" server/modules/voice/` **零命中**；`GET /api/voice/config` 原样回读 `apiKey`（`server/modules/voice/tests/voice-config.routes.test.ts:363` 断言 `apiKey === PREFERRED_SENTINEL`），`PUT` 的响应体同理 |
| `configured` 的粒度 | `voice.service.ts` 的 `effectiveBackendConfigured(settings)` 只算一个布尔值（`Boolean(settings.baseUrl.trim() \|\| dependencies.defaults.baseUrl)`），然后喂给**每个** provider 条目（`providers: listProviders().map(... { configured })`）；`VoiceProviderSummary.configured` 的注释自认「Every registered provider reads the same user-level backend in this version」 |
| 生效 provider 的来源 | `effectiveProviderId(undefined, dependencies.defaults)` 只读环境默认；用户的 `VoiceSettings` 里没有 `providerId`，`transcribe` 也拿不到用户的设置（`voice.routes.ts` 只传 `overrides` 与音频字节） |
| 服务端日志面 | `server/modules/voice/` 下没有任何日志调用（全模块唯一一条 `console.warn` 在 `voice-settings.db.ts` 的解码失败分支）；转写路径**没有可被捕获的结构化日志面**，所以「日志里没有 key 与正文」今天既无泄漏也无读数 —— 两者不同形 |
| DashScope 的服务端环境变量 | `grep -rn "VOICE_DASHSCOPE\|DASHSCOPE_API_KEY" --include=*.ts --include=*.md server/ src/ scripts/` **零命中**（按人 2026-09-24 的裁定 2 也不该有） |
| 地址校验规则的归属 | 规则本体（`allowedBaseUrl`，`https:` + `*.maas.aliyuncs.com` 主机白名单）由 AC-140 写在 dashscope-omni 适配器上；本条只在**保存路径**上调用它，不写第二份主机名单 |

**要交付的四件事**：

1. **用户凭据进设置面**：`server/shared/types.ts` 的 `VoiceSettings` 增加 `providerId`、`dashscopeEndpoint`、`dashscopeApiKey`、`dashscopeModel`；`server/modules/database/repositories/voice-settings.db.ts` 的 `VOICE_SETTINGS_FIELDS` 与 `EMPTY_VOICE_SETTINGS` 同步（否则 `decodeSettings` 在读回时把新字段整段丢掉）。`dashscopeEndpoint` 在保存时用 **dashscope-omni 适配器自己声明的规则**校验，不合格返回 `400` + `code: 'INVALID_BASE_URL'` 且不落库。⛔ 不新增 `VOICE_DASHSCOPE_*` 之类的环境变量入口（裁定 2）。
2. **凭据归属由 provider 自己声明，服务端不写第二张按 id 索引的表**：哪个字段是这个 provider 的 key 与地址，由 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 声明（沿用 AC-140「端点规则由拥有该端点的适配器声明」的纪律），`AsrAdapter` 上多一个可选声明位。`server/` 下不得出现 `'dashscope-omni'` 字面量做分支。`createVoiceService().transcribe` 的入参增加用户的 `settings`（与既有的 `getHealth({ settings })` 对称，route 从 `voiceSettingsService` 取），生效 provider 为 `dashscope-omni` 时出站请求的 baseUrl/apiKey/model 取自用户存的三件，而不是 `defaults.baseUrl` / `overrides.apiKey`。
3. **健康检查按 provider 报 `configured`**：`providers[]` 每条的 `configured` 由**该 provider 自己的凭据要求**决定 —— `dashscope-omni` 看 `dashscopeEndpoint` + `dashscopeApiKey`，`openai-compatible` / `multimodal` 看原来的 `baseUrl`（语义不变）。顶层 `configured` 与 `provider` 反映生效 provider（用户存的 `providerId` > 环境默认 > registry 首行；优先级沿用既有的 `effectiveProviderId` 三档，只是把用户设置插到最前，未注册的 id 仍是 503）。
4. **key 掩码 + 日志脱敏**：`GET /api/voice/config` 与 `PUT /api/voice/config` 的响应里，`dashscopeApiKey` 以掩码返回（非空、不等于明文、不包含明文子串、带固定掩码标记）；浏览器自持的 `apiKey` **原样回读** —— 「key 以掩码返回」读作服务端持有的那把 DashScope key（本条里唯一由服务端使用、且不能进浏览器记忆的凭据），浏览器自持的那把若被掩掉，AC-140 保留的直连路径会断、`voice-config.routes.test.ts:363` 会红。转写路径经一个**注入的日志端口**打印每次尝试的一行结构化读数（providerId、outcome/status、latencyMs、promptVersion、writtenFallback），⛔ 不打印 key、音频字节与转写正文（成功与失败两条路径都不打印）。

**边界（不做）**：不做 dashscope-omni 适配器本体与线协议（AC-138）；不做服务端按 provider 分派与 `AsrErrorCode→HTTP` 表（AC-139）；不做 proxy-only 的直连归零，也不写主机白名单规则本体（AC-140，本条只在保存路径上调用它）；不做设置页界面、不做浏览器端到端（AC-142）—— 因此本条不要求客户端整档 `PUT` 时不带新字段也保留旧值（那个 hazard 属 AC-142 的界面范围，本条只在「已知不等价点」里登记）；不改 TTS 的请求形状（URL、Authorization、body 的 model/voice 一律照旧）；不联网、不重跑实验、不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [x] AC1 判据入口与「空读数不是绿」：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-settings.test.ts` 退出 0；每条读数把**自己的名字与实测值**逐行打印（红时可归因，不是只有 token）；文件内维护一个读数计数器，最后一条用例断言计数器 === 文件顶部的 `READINGS_EXPECTED` 常量（少了读数即红），且运行摘要的 `pass` 数 ≥ 该常量；判据末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。
- [x] AC2 不设任何服务端环境变量、用户未填写 ⇒ `dashscope-omni` 的 `configured` 为假：判据在**任何出货模块被 import 之前**删掉 `VOICE_API_BASE_URL` / `VOICE_API_KEY` / `VOICE_PROVIDER_ID` / `VOICE_STT_MODEL` / `VOICE_TTS_MODEL` / `VOICE_TTS_VOICE` / `VOICE_TIMEOUT_MS`，并在断言处 `assert` 它们确实不在 `process.env` 里；用与 `voice.module.ts` 在无环境变量时会构造出的那一组 defaults（空 `baseUrl`/`apiKey`/`providerId` + 出厂模型名）构造服务，`getHealth({ settings: 空档 })` ⇒ `providers.find(id === 'dashscope-omni').configured === false` 且顶层 `configured === false`；打印 `before[dashscope-omni]=<b>`、`before[top]=<b>`、`env-clean=<b>`。
- [x] AC3 保存 key 与地址后为真，且是**按 provider** 为真：同一次运行里先经出货的设置服务与出货 router 落库（`PUT /api/voice/config`，体里带 `dashscopeEndpoint = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com'`、`dashscopeApiKey = 'sk-dashscope-sentinel'`、`dashscopeModel = ''`、`providerId = 'dashscope-omni'`，以及原六字段），再用**落库读回的那份设置**调 `getHealth` ⇒ `dashscope-omni.configured === true`、顶层 `configured === true`、`provider === 'dashscope-omni'`。两条阳性对照不可省：(a) 同一份设置下 `openai-compatible.configured === false`（只填了 dashscope 两件、没填 `baseUrl` —— 把 configured 算成一个全局布尔的实现必红）；(b) 另存一份**只有 `baseUrl`/`apiKey`** 的设置（`providerId` 为空）⇒ `openai-compatible.configured === true` 且 `dashscope-omni.configured === false`（反方向同一对照）。判据打印每条 `configured[<id>]=<b>`。
- [x] AC4 取假形态（两个）是**可执行用例**：`server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts` 里，判据的读数逻辑导出成一个参数化函数（默认指出货模块路径）；该文件把出货文件复制到临时 `.ts` 路径（同一棵树内，好让 `@/*` 与相对 import 照旧解析）、逐条做一次**文本变异**、动态 import 变异体并重跑同一份读数 —— (`i`) `key-plaintext-echo`：把掩码函数改成恒等 ⇒ 必须让 AC5 的那一行读数非零退出/判红；(`ii`) `env-only-configured`：把每条 provider 的 `configured` 改成只读 `defaults.*`（不看用户设置）⇒ 必须让 AC3 的那一行判红。每条**先要求未变异副本退出 0**（正向前置 —— 恒红的工装不能证明任何事），再要求变异后判红并指名是 AC3/AC5 的哪一行；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts` 退出 0；临时文件跑完即删，`git status --porcelain` 在跑完后为空。
- [x] AC5 key 掩码只发生在**回读**路径（取假形态 (1) 的判别力在此）：经出货 router 的 `GET /api/voice/config` 与 `PUT /api/voice/config` 两条回读路径取回的 `dashscopeApiKey` 都必须：非空、`!== 'sk-dashscope-sentinel'`、`!includes('sk-dashscope-sentinel')`、包含固定掩码标记；同一响应里 `baseUrl`/`apiKey`（TTS 那对，浏览器自持）**逐字等于**存进去的值。两条阳性对照：(a) 存 `dashscopeApiKey: ''` 时回读仍是空字符串（掩码不得把「没填」变成「填了」）；(b) 驱动一次生效 provider 为 `dashscope-omni` 的 `transcribe`，替身上游收到的 `Authorization` 头**逐字**是 `Bearer sk-dashscope-sentinel` —— 掩码只在回读面，出站仍是明文，否则 AC3 的「保存后为真」是假的。判据打印 `get.dashscopeApiKey=<长度与前 2 字符>`、`put.dashscopeApiKey=<同形>`、`wire.authorization=Bearer sk-…`（⛔ 判据自己也不得把明文整串打进输出）。
- [x] AC6 TTS 凭据不受影响：同一份已存 dashscope 三件的设置下驱动 `synthesizeSpeech`，替身收到的请求 URL 逐字等于 `` `${原 baseUrl}/audio/speech` ``、`Authorization` 逐字等于 `Bearer <原 apiKey>`、body 里的 `model` 与 `voice` 与原来一致，且请求头与 body 全文里**不出现** `dashscopeEndpoint` 的值与 `dashscopeApiKey` 的值；打印 `tts.url`、`tts.authorization=Bearer <前 3 字符>…`、`tts.carries-dashscope=<b>`（必须 false）。
- [x] AC7 日志无 key 明文、无转写正文（「没有」必须是分辨力）：注入一个收集型日志端口，驱动**一次成功**（替身 200，body 是 E 组形状的 JSON，`transcript` 与 `instruction` 各是一段独特哨兵文本）与**一次失败**（替身 403）的 `transcribe`；对收集到的每一行断言：不含 `sk-dashscope-sentinel`、不含 `Bearer sk-dashscope-sentinel`、不含录音字节的 base64、不含两段哨兵正文。三条阳性对照缺一不可：(a) 收集到的行数 ≥ 2，且成功行与失败行可由 `outcome`/`status` 区分（「什么都没记」不是绿）；(b) 替身上游确实收到了明文 key（同 AC5 (b)）；(c) 成功那一转的返回值里确实带回了那段 instruction 正文 —— 所以「日志里没有」是分辨力，不是「那段正文根本不存在」。日志端口不经 `console` 全局打补丁（出货代码把默认值解析在 `createVoiceService` 内：注入优先、缺省 `console`，因此 `voice.module.ts` 不在本条写入面）。判据打印 `log.lines=<n>`、`log.needleHits=<n>`（必须 0）、`log.carries-outcome=<b>`、`log.body-returned=<b>`。
- [x] AC8 凭据归属只有一份、来自出货的适配器声明：`grep -rn "'dashscope-omni'" server/` 与 `grep -rn '"dashscope-omni"' server/` 均**零命中**（服务端不按 id 分支）；判据打印它读到该声明的**模块相对路径与符号名**（经 `listProviders()` 拿到的那个对象上的字段，不是字面量）；阳性对照：同一 grep 在 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 上**有**命中 —— 「没看」与「看了没问题」不同形。
- [x] AC9 存储往返走真 sqlite：`npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/voice-settings.db.integration.test.ts` 退出 0，其中新增读数断言新四字段经 `voiceSettingsDb.saveSettings` / `getSettings` 逐字往返，且**旧构建写下的、只有原六字段的一行**读回时新字段为空档、其余六字段不受影响（沿用该文件已有的「更少字段的行」用例形状）；打印 `db.roundtrip=<b>`、`db.legacyRow=<b>`。
- [x] AC10 契约与既有读数不被改窄：`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）与 `npm run lint` 退出 0；`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voice.service.test.ts`、`voiceTranscribeGaps.test.ts` 四条判据全部退出 0，其中 `voiceHealth.test.ts` 的「每个 provider 的 configured」与 `voice-config.routes.test.ts` 的凭据回读读数按本条语义更新（`configured` 的粒度、掩码面），取值只许**加**不许减；判据把它们逐条的退出码打印出来（不是空过）。
- [x] AC11 判据自身远快于 60 秒：AC1 的 `elapsed-ms` 读数与 `time` 的 wall clock 都 < 15000；判据文件内零子进程（变异与复制都在 AC4 的那条旁证里，不在 `criterion:` 这一条里）。
- [x] AC12 如实登记：判据输出与本任务的完成记录里写明「本条只做用户提供的 DashScope key/地址的存储、按 provider 的 `configured`、key 掩码与日志脱敏、TTS 凭据不变；不做 dashscope-omni 适配器本体（AC-138）、不做服务端按 provider 分派（AC-139）、不写主机白名单规则本体（AC-140，本条只在保存路径上调用它）、不做设置页界面与浏览器端到端（AC-142）；判据全程注入替身 fetch 与替身日志端口，未接触真实 DashScope（ADR-004 决策 8：真实冒烟归人工）；`qwen3.8-omni-flash` 是别名，服务端升级后行为可能漂移」。

## DoD

真实落地判据：不是「多了四个字段、一个掩码函数和一个日志端口」，而是**同一份用户设置经由同一份出货代码**，在健康检查里按 provider 报出 `configured`、在回读面上把服务端持有的那把 key 掩掉、在出站请求上仍是明文、在日志里一次都不出现，而 TTS 那对凭据一字未动 —— 由**执行**证明，不由段落文字声明。承重性由四件读数证明：

(a) `configured` 是**按 provider 的**，两个方向都有对照（AC2 / AC3）：只填 dashscope 两件时 `openai-compatible` 仍为假、只填 `baseUrl` 时 `dashscope-omni` 仍为假 —— 「算成一个全局布尔」无论朝哪边倒都过不了。

(b) 掩码只发生在**回读**（AC5）：回读是掩码、出站是明文（替身上游读到 `Bearer sk-dashscope-sentinel`）—— 「既不回读也不出站」与「回读明文」两种偷懒各被一条读数抓住；再叠一条「空值回读仍是空」防止掩码把「没填」变成「填了」。

(c) 「日志里没有」是**分辨力**而不是「什么都没记」（AC7）：日志行数与 `outcome` 可分辨、明文 key 确实上了线、正文确实回到了结果里，三条对照缺一不可 —— 少了任何一条，「没有泄漏」就退化成「没有日志」。

(d) TTS 凭据与 DashScope 凭据**真的分开**（AC6）：同一份设置下 TTS 的 URL 与 `Authorization` 逐字等于原来的 `baseUrl`/`apiKey`，且请求里不出现 dashscope 的地址与 key —— 「把用户存的 key 也塞给 TTS」或「TTS 跟着新字段漂移」都过不了。

**必须如实登记**（写进判据输出与本任务）：本条**不**做 dashscope-omni 的适配器本体与线协议（AC-138），**不**做服务端按 provider 分派与 `AsrErrorCode→HTTP` 表（AC-139），**不**写 `transport` / 主机白名单规则的本体（AC-140 —— 本条只是在保存路径上调用它声明的那条规则），**不**做设置页界面与浏览器端到端（AC-142）；判据跑在注入的替身 fetch、注入的日志端口与真 sqlite 的临时库上，**不等于**真实 DashScope 与真机浏览器（ADR-004 决策 8：真实冒烟归人工）；`qwen3.8-omni-flash` 是别名，服务端升级后效果可能漂移；白名单内的那个地址取自实验记录里出现过的工作空间形态，不是从真实 key 上跑出来的。

**已知不等价点与限制**：客户端 `src/shared/voiceConfig.ts` 今天把六个字段整档 `PUT` 回服务端，而服务端把「字段缺失」读作「清空」—— 因此在 AC-142 把新字段接进设置页之前，一个只认识旧六字段的客户端保存一次就会把已存的 dashscope 三件清掉。本条**不**修这条通路（界面与端到端属 AC-142），只在此登记，以免它被误读成本条的实现缺陷。

L_D 该轴仍暗，理由：本条不给该轴任何读数 —— 它的判据全是布尔与形态读数（configured 的真假、掩码与否、日志含不含哨兵、TTS 头逐字相等），没有可比的数值量；用户凭据进的是既有的 `user_voice_settings` JSON 文档，未新增表、未新增列，出站字节与既有转写路径同形，只是凭据来源不同。

L_G 该轴仍暗，理由：目标层判据（真实浏览器里经语音按钮拿到书面指令并写入 composer）还要求设置页界面与浏览器端到端（AC-142）；本条只证明服务端的凭据面、`configured` 面与脱敏面，浏览器里还没有可选的服务、也没有可填的 key 与地址。


### 本机运行记录（author worktree，2026-09-24）

AC10 逐条退出码（`npx tsx --tsconfig server/tsconfig.json --test <file>`，全部 `exit=0`，`pass` 为运行摘要的通过数）：

| 判据 | exit | pass | wall |
|---|---|---|---|
| `server/modules/voice/tests/voice-dashscope-settings.test.ts`（AC1–AC8） | 0 | 31 | ~1.0s |
| `server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts`（AC4） | 0 | 3 | ~1.7s |
| `server/modules/voice/tests/voiceHealth.test.ts` | 0 | 7 | ~0.7s |
| `server/modules/voice/tests/voice-config.routes.test.ts` | 0 | 6 | ~1.9s |
| `server/modules/voice/tests/voice.service.test.ts` | 0 | 4 | ~0.6s |
| `server/modules/voice/tests/voiceTranscribeGaps.test.ts` | 0 | 8 | ~0.8s |
| `server/modules/database/tests/voice-settings.db.integration.test.ts`（AC9） | 0 | 7 | ~1.7s |

`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）`exit=0`；`npm run lint` `exit=0`（`error` 计数 0，输出里只有既有的 `warning`）。取值只加不减：`voiceHealth.test.ts` 的按 provider `configured` 与 `voice-config.routes.test.ts` 的凭据回读读数按本条语义更新，原断言一条未删。

AC11：AC1 的 `elapsed-ms=357`（最近一次实测 341），`time` 的 wall clock ≈ 1.0s，均 < 15000；判据文件内零 `child_process`。AC10 的这组退出码因此记在这里而不是由 AC1 自己打印 —— AC11 明令 AC1 判据文件零子进程，旁证（复制与文本变异）在 AC4 的那条文件里。

AC4 两个变异体实测红线（未变异副本先全绿 `red=0`）：

- `key-plaintext-echo`（掩码函数改恒等）⇒ 红 `AC5 get.dashscopeApiKey` 与 `AC5 put.dashscopeApiKey`，首条红读数 `get.dashscopeApiKey=len=21 head=sk… masked=false`；family 外的 `AC2 env-clean` 仍绿。
- `env-only-configured`（`configured` 只读 `defaults.*`）⇒ 红 `AC3 configured-rows` 与 `AC3 top`，首条红读数 `configured[openai-compatible]=false,configured[multimodal]=false,configured[dashscope-omni]=false`；family 外的 `AC2 env-clean` 仍绿。
- 临时副本跑完即删：clean tree 上实跑 `falsify/leftovers: git.status-clean=true temp-copies=none`，且运行前后 `git status --porcelain` 均为空。

AC2/AC3/AC5/AC6/AC7/AC8 的实测读数（判据逐行打印）：`env-clean=true`、`before[dashscope-omni]=false`、`before[top]=false`、`configured[openai-compatible]=false,configured[multimodal]=false,configured[dashscope-omni]=true`、`top=true`、`provider=dashscope-omni`、对照 (a) `configured[openai-compatible]=false`、对照 (b) `put.status=200 configured[openai-compatible]=true` 且 `configured[dashscope-omni]=false`、`get/put.dashscopeApiKey` 均为 `len=8 head=••… masked=true`、`get/put.verbatim-pair` 逐字（另一用户文档里非空的那对）、`empty.put=(empty) empty.get=(empty)`、`wire.authorization=Bearer sk-… verbatim=true`、`tts.url=https://api.groq.com/openai/v1/audio/speech`、`tts.body.model=tts-1 tts.body.voice=alloy unchanged=true`、`tts.carries-dashscope=false`、`log.lines=2`、`log.carries-outcome=true`、`log.needleHits=0`、`log.body-returned=true`、`log.port-or-console port-lines=1 console-lines=1 restored=true`、`server-branch-scan files=311 shipping-hits=0 test-fixture-hits=3`（三条都在 `tests/` 下，判据按路径列出，含它自己）、`declaration=shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#credentials … registry-shares-the-object=true`、`control-provider-module-hits=1`、`db.roundtrip=true fields=10/10`、`db.legacyRow=true row=6-fields`。

AC12 登记（与判据末尾打印的 `scope:` 段同一份文字）：本条只做用户提供的 DashScope key 与工作空间地址的存储、按 provider 的 `configured`、key 掩码回读与日志脱敏、TTS 凭据不变；**不**做 dashscope-omni 适配器本体与线协议（AC-138），**不**做服务端按 provider 分派与 `AsrErrorCode→HTTP` 表（AC-139），**不**写 `transport` 与主机白名单规则本体（AC-140 —— 本条只在保存路径上调用它声明的那条规则），**不**做设置页界面与浏览器端到端（AC-142）。判据全程注入替身 fetch、注入日志端口与真 sqlite 的临时库，**不等于**真实 DashScope 与真机浏览器（ADR-004 决策 8：真实冒烟归人工）；`qwen3.8-omni-flash` 是别名，服务端升级后效果可能漂移；判据里那个工作空间地址取自实验记录里出现过的形态，不是从真实 key 上跑出来的。已知不等价点（登记不修）：`src/shared/voiceConfig.ts` today 把六字段整档 `PUT`，服务端把「字段缺失」读作「清空」，故 AC-142 接好设置页之前，旧客户端保存一次会清掉已存的 dashscope 三件 —— 该通路属 AC-142。

## Touches

- tasks/gap-asr-dashscope-user-credential-configured-mask-and-log.md
- server/shared/types.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice.routes.ts
- server/modules/database/repositories/voice-settings.db.ts
- shared/asr/asrRegistry.ts
- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- server/modules/voice/tests/voice-dashscope-settings.test.ts
- server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts
- server/modules/voice/tests/voiceHealth.test.ts
- server/modules/voice/tests/voice-config.routes.test.ts
- server/modules/voice/tests/voice.service.test.ts
- server/modules/voice/tests/voiceTranscribeGaps.test.ts
- server/modules/database/tests/voice-settings.db.integration.test.ts
