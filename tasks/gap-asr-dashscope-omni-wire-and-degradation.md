---
id: gap-asr-dashscope-omni-wire-and-degradation
title: dashscope-omni 适配器线协议与降级（AC-138 的 checker）：chat-audio 请求形状、书面化解析与
  verbatim 降级、401/403/429/超时映射、超限零请求、hints 不上线
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-omni-prompt-frozen-snapshot
goal_ac: AC-138
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不含任何被当作要求的前置）：`grep -rn "^goal_ac:" tasks/*.md` 中 AC-138 零命中；本机制的关键词 `chat-audio`、`input_audio`、`writtenFallback`、`proxy-only` 在 `shared/`、`server/`、`src/`、`scripts/` 下同为**零命中**（立案时实测）。同族相邻的 `tasks/gap-asr-omni-prompt-frozen-snapshot.md`（`goal_ac: AC-137`）已由 `depends_on` 显式声明为前置：它创建 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 里的四段提示词常量与冻结快照，而本任务的判据要逐字读那四段；它同时把本任务的范围白纸黑字让了出来（其边界原文：「不实现 chat-audio 线协议、JSON 解析与降级、错误映射（AC-138）；不改 `voice.service.ts` 的分派（AC-139）」）。两条判据的命令与文件各不相同，各自独立判定。

**现状（立案时实测，可复验）**：

| 缺什么 | 实测 |
|---|---|
| 适配器实现 | `ls shared/asr/list/` 只有 `multimodal/` 与 `openai-compatible/`；`dashscope-omni/` 由前置任务创建，本任务在它之上补 `capabilities` 与 `transcribe` |
| 判据脚本 | `ls scripts/ \| grep omni` 为空 |
| `chat-audio` 线 | `grep -rn "chat-audio" shared/ src/ server/ scripts/` 零命中 |
| 降级读数位 | `shared/asr/asrRegistry.ts` 的 `AsrSuccess.meta` 只有 `model? / latencyMs? / usage?`，没有 `writtenFallback` |
| 契约行 | `shared/asr/asrRegistry.ts:177` 的 `AsrWire` 只有 `'inline-json'` 与 `'multipart'` 两个成员 |

**本任务交付四件东西：**

1. **适配器实现**（`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`，在前置任务落下的四段常量之外补）：`id`、`capabilities`（`acceptsMime` 八项 webm/ogg/wav/x-wav/mpeg/mp3/aac/amr；`maxInlineRequestBytes = 10 * 1024 * 1024`；`oversize: 'reject'`；`honors` 三项**全为 false**；`billing: 'audio-tokens'`；`pauseCues: 'neutral'`；`style: 'written'`；`oneShot: true`）、`wire: 'chat-audio'`（见第 2 件）、`transcribe`。
   - 线协议（proposal §2）：`POST {baseUrl}/compatible-mode/v1/chat/completions`，`Authorization: Bearer <apiKey>`、`Content-Type: application/json`；体为 `{ model, modalities: ['text'], stream: false, reasoning_effort: 'low', messages: [ {role:'system', content: `${ROLE}\n\n${RULES}\n\n${EXAMPLES}`}, {role:'user', content: [ {type:'input_audio', input_audio:{ data: 'data:audio/<base>;base64,…', format }}, {type:'text', text: JSON_TASK} ]} ] }`。
   - `format` 由**录音的基础 MIME 类型**推出（复用 `baseMimeType` 的剥参数规则，不是新写一套）：`audio/webm;codecs=opus` → `webm`，`audio/ogg` → `ogg`，`audio/wav` / `audio/x-wav` → `wav`，`audio/mpeg` / `audio/mp3` → `mp3`，`audio/aac` → `aac`，`audio/amr` → `amr`。
   - 解析与降级（proposal §2 表）：`choices[0].message.content` 解析出 JSON 且 `instruction` 非空 ⇒ `ok`、`text = instruction`、`style: 'written'`；JSON 不可解析或 `instruction` 为空但 `transcript` 非空 ⇒ `ok`、`text = transcript`、`style: 'verbatim'`、`transformations: []`、`meta.writtenFallback = 1`；两者都空 ⇒ `NO_SPEECH_DETECTED`；内容不是可解析文本 ⇒ `UPSTREAM_ERROR`（**不把原始返回当成转写**）。JSON 允许被 Markdown 围栏或前后文字包裹：取第一个 `{` 到最后一个 `}` 之间解析。
   - 错误映射：401 ⇒ `UNAUTHORIZED`；403 且体含 `AccessDenied.Unpurchased` ⇒ `UNAUTHORIZED` 且 message 指明「未开通」或「余额不足」；其他 403 ⇒ `UNAUTHORIZED`；429 ⇒ `RATE_LIMITED`；超时（自身 `timeoutMs` 计时 + `AbortSignal`）⇒ `TIMEOUT`；网络失败 ⇒ `UNREACHABLE`；其他非 2xx ⇒ `UPSTREAM_ERROR`。
   - **超限在发请求之前拒绝**：请求字节数（含 base64 之后的音频编码、system 三段、JSON_TASK）超过 `maxInlineRequestBytes` ⇒ `OVERSIZE`，且**一次 fetch 都不发**。
   - `honors` 三项全 false ⇒ `hints.prompt` / `hints.context` / `hints.language` 一个字都不上请求体。

2. **契约面（`shared/asr/asrRegistry.ts`）**：`AsrWire` 增加 `'chat-audio'`；`AsrSuccess.meta` 增加 `writtenFallback?: number` 与 `promptVersion?: string`。**本任务不把适配器注册进 `REGISTERED`** —— 注册与「服务端按 provider 分派」是 AC-139 的范围；也不加 `transport` 字段（AC-140 的范围）。

3. **契约板的新线行（`shared/asr/asrInvariants.ts`）**：`WIRE_MODELS` 的类型是 `Record<AsrWire, AsrWireModel>`，所以给联合加成员是**类型层面强制**同一处加一行 `chat-audio` 模型，这不是可选项。这一行是「新线协议在契约面上的声明」，**不允许成为无读数的声明**：本任务的判据把板子导出的 `probeRequestConstruction` / `probeErrorMapping` / `probeSizeLayering` 直接喂**出货适配器**（不经 registry，故不需要注册），三条各零 FAIL —— 这一行的 `goldenBody` / `answers` / `promptPart` / `contextPart` / 超限算术因此各自有实测。

4. **判据与取假形态**：`scripts/asr-dashscope-omni-check.mjs`（AC-138 记录里的 `criterion:` 逐字就是 `node scripts/asr-dashscope-omni-check.mjs`）+ `scripts/asr-dashscope-omni-check.test.mjs`。
   - 判据用 `tsx/esm/api` 的 `register()` 让裸 `node` 能 import 树里的 `.ts`（`scripts/asr-second-adapter-check.mjs` 已建立的先例），从 `--root`（默认仓根）加载**出货模块**，不走 registry。
   - 全程注入替身 `fetchImpl`，并把 `globalThis.fetch` 换成毒药：伸手抓环境 fetch 的适配器会被毒药抓住，而不是仅仅「不建议」。
   - 取假形态按 `scripts/asr-second-adapter-check.test.mjs` 的先例由**测试文件运行期从出货文件复制出临时 fixture 再逐条变异**，每条先要求未变异退出 0（正向控制），再要求变异后非零 —— 这样「必红」是可执行用例，且「恒红」与「改了才红」可区分。
   - **criterion 自身必须远快于 60 秒**（目标侧判据门有 60 秒硬上限且不可调）：变异 fixture 的复制与运行放在测试文件里，判据只跑一次未变异树。

**为什么这样切**：AC-138 的全部内容就是「这个适配器在离线替身下说的话是对的」。所以被测对象是**出货模块的 `transcribe`**，读数是**替身收到的那个请求**与**替身给出某个回答后适配器返回的那个结果**，而「零请求」是替身自己的计数器而不是从错误码反推出来的（`asr-second-adapter-check.mjs` 的原话：the second half is a stand-in counter, not an inference from the error code）。提示词与 `JSON_TASK` 从出货模块读、工装里不留第二份正文，与前置任务同一条纪律。

**边界（不做）**：不注册进 `asrRegistry`（AC-139）；不改 `voice.service.ts`（AC-139）；不加 `transport: 'proxy-only'`、不做 SSRF 白名单（AC-140）；不做用户配置、key 掩码、健康检查（AC-141）；不做前端与 Playwright 端到端（AC-142）；不联网、不重跑实验、不新增实验读数（读数是前置任务冻结的那份）；不改 `experiments/` 下任何文件；不写 `docs/experiments/` 的人读记录。

## AC

- [x] AC1 判据入口与「空读数不是绿」：`node scripts/asr-dashscope-omni-check.mjs` 退出 0，并逐条打印读数（每条带 `ok` 或 `FAIL <TOKEN>`，且每条读数把被测的**值**打印出来，红的时候不只有 token）；`node scripts/asr-dashscope-omni-check.mjs --root <空临时目录>` 非零退出且输出含 `EMPTY_READING`（不得静默跳过）。
- [x] AC2 请求形状（读数是替身收到的那个请求）：判据打印 `request.endpoint`（等于 `{baseUrl}/compatible-mode/v1/chat/completions`，method 为 POST，`Content-Type` 为 `application/json`，`Authorization` 为 `Bearer <apiKey>`）、`request.params`（`model` 为 invocation 给的模型、`modalities` 等于 `['text']`、`stream === false`、`reasoning_effort === 'low'`）、`request.system`、`request.user-parts`；user 的 `content` 是**数组**且含一个 `input_audio` 部（其 `input_audio.data` 以 `data:audio/webm;base64,` 开头且解码后等于录音字节）与一个 `text` 部（其 `text` 逐字等于出货模块导出的 `JSON_TASK`）。取假形态：测试文件里的 `system-dropped`（system 去掉一段）与 `params-relaxed`（`stream: true` 且 `reasoning_effort` 换一个值）各非零退出并指名对应 token。
- [x] AC3 提示词三段取自出货常量、工装无第二份：判据打印 `system` 的内容 sha256 与三段（`ROLE` / `RULES` / `EXAMPLES`）各自的 sha256，且断言 `system` 逐字等于 `` `${ROLE}\n\n${RULES}\n\n${EXAMPLES}` ``（三段都非空，故空串导出者不能靠「等于空」过关）；`grep -n "你是编码 agent 的语音指令整理器\|规则：" scripts/asr-dashscope-omni-check.mjs scripts/asr-dashscope-omni-check.test.mjs` **零命中**。取假形态：`prompt-segment-dropped`（出货模块少导出一段或某段被改一个字符）非零退出并指名是哪一段。
- [x] AC4 `format` 由录音基础 MIME 推出：判据对 `audio/webm;codecs=opus`、`audio/webm`、`audio/ogg`、`audio/wav`、`audio/x-wav`、`audio/mpeg`、`audio/mp3`、`audio/aac`、`audio/amr` 各打印一行 `format-by-mime` 读数并给出期望值（带参数的头与不带参数的同一容器必须给出同一个 `format`）。取假形态：`format-hardcoded`（`format` 写成常量）非零退出并指名至少一行。
- [x] AC5 书面化解析：替身返回 `{"transcript":"逐字那一版","instruction":"书面那一版"}`（两者**不同**字符串）⇒ `ok`、`text` 逐字等于 `instruction`（不等于 `transcript`，也不等于原始 content）、`style === 'written'`、`transformations` 含 `'written-style'`；同一断言在 JSON 被 Markdown 围栏包裹、以及被前后解释文字包裹两种形态下同样成立（取第一个 `{` 到最后一个 `}`）。
- [x] AC6 降级为 verbatim：content 不可解析为 JSON 但**含** `transcript`（例如 `transcript` 是裸文本、`instruction` 缺失）⇒ `ok`、`text` 逐字等于该 `transcript`、`style === 'verbatim'`、`transformations` 等于 `[]`、`meta.writtenFallback === 1`。取假形态：AC11 的 `raw-content-as-text` 在这一组必须红（把原始 content 整段当 `text` 返回）。
- [x] AC7 两者都空 ⇒ `NO_SPEECH_DETECTED`：content 是合法 JSON 但 `instruction` 与 `transcript` 都为空、以及 content 是空串，两种输入都给出 `NO_SPEECH_DETECTED` 且 `ok === false`。
- [x] AC8 错误映射：判据对 401、403（体含 `AccessDenied.Unpurchased`）、403（普通 `forbidden`）、429、超时五种输入各打印一行读数并给出期望码 `UNAUTHORIZED` / `UNAUTHORIZED` / `UNAUTHORIZED` / `RATE_LIMITED` / `TIMEOUT`；其中 `AccessDenied.Unpurchased` 那行的 message 必须含「未开通」或「余额不足」，**并且**普通 403 那行的 message 与之**不同**（正对照：这条断言不能被一个常量串满足）。超时由替身按传入的 `AbortSignal` 拒绝、`timeoutMs` 设为很小来构造，且 `error.transport`（网络失败）必须仍映射到 `UNREACHABLE` 而不是 `TIMEOUT`（两个码不许塌成一个）。
- [x] AC9 超限 ⇒ `OVERSIZE` 且替身调用次数为 0：音频字节数使整个请求（含 base64 编码与两段提示）超过 `10 * 1024 * 1024` 时，结果为 `OVERSIZE`，且**替身的计数器读数为 0**（是计数器，不是从错误码推断）。边界另一侧有正对照：同一算术下**刚好装得下**的音频必须发出且 `requests === 1`（「线」不是「墙」）。取假形态：AC11 的 `oversize-still-sends` 必须红。
- [x] AC10 `hints` 不上线且有阳性对照：invocation 带 `hints: { prompt, context, language }` 三个可辨识的哨兵串时，请求体的渲染文本里三者**零命中**；同一读数的阳性对照是录音 data URI 与 `JSON_TASK` **在**请求体里（发空请求的构造者不能靠「什么都没发」过关）。
- [x] AC11 三条 AC 具名的取假形态各是一个可执行用例，且各有正向控制：`node --test scripts/asr-dashscope-omni-check.test.mjs` 退出 0，其中 (1) `raw-content-as-text`（把原始 content 整段当作 `text` 返回）必须红；(2) `403-upstream-error`（403 映射成 `UPSTREAM_ERROR`）必须红；(3) `oversize-still-sends`（超限仍发出请求）必须红；三者的 fixture 均由**出货文件复制**而成，运行期在临时目录里变异；每条先要求未变异的同一 fixture 退出 0。
- [x] AC12 离线是强制的而不是声明的：判据全程只用注入的替身 transport，并把 `globalThis.fetch` 换成毒药（被调用即记账并抛错），毒药计数为 0；判据输出含 `network=stand-in` 与毒药计数。取假形态：`ambient-fetch`（适配器改抓环境 fetch）非零退出。
- [x] AC13 `chat-audio` 进入契约面且该行有读数：`shared/asr/asrRegistry.ts` 的 `AsrWire` 含 `'chat-audio'`、`AsrSuccess.meta` 含 `writtenFallback`；`shared/asr/asrInvariants.ts` 的 `WIRE_MODELS` 有 `chat-audio` 行；判据把 `probeRequestConstruction` / `probeErrorMapping` / `probeSizeLayering` 三个板子探针直接喂出货适配器（不经 registry），三者合计的失败读数为 0，且判据打印每组的读数条数（条数为 0 记失败，不得静默为空）。取假形态：`wire-mislabelled`（适配器声明 `'inline-json'` 而发 chat-audio 体）非零退出。
- [x] AC14 `shared/asr/asrInvariants.ts` 是新线行落点：`npm run typecheck` 退出 0（根配置与 `server/tsconfig.json` 双编译，`AsrWire` 的扩展必须两边都过）；`npm run lint` 退出 0；`node scripts/asr-contract-invariants-check.mjs` 仍退出 0 且其读数与本次改动前一致（本任务不注册 provider，既有板子的读数不得变动）；`node --test scripts/asr-dashscope-omni-check.test.mjs` 退出 0。

## DoD

真实落地判据：不是「多了一个适配器文件和一个脚本」，而是**这个适配器在零真实网络下，替身收到的那个请求就是 chat-audio 形状、替身给什么回答它就给出什么语义结果、超限时它一次请求都不发** —— 而这三件事由**执行**证明，不由段落文字声明。承重性由三件读数证明：

(a) **三条「必须红」是产物不是声明**（AC11）：`raw-content-as-text`、`403-upstream-error`、`oversize-still-sends` 各是一个在临时 fixture 上运行的可执行用例，且每条都先跑未变异树确认绿 —— 一个恒红或恒绿的判据过不了它自己的正向控制。

(b) **「零请求」是计数器、「是哪一段」是判据自己的输出**（AC2、AC3、AC8、AC9）：超限的零请求读的是替身计数器的值（`asr-second-adapter-check.mjs` 的纪律：不是从错误码推断）；`AccessDenied.Unpurchased` 与普通 403 的 message 必须**不同**，因此「未开通」这句话不可能来自一个常量串；提示词不一致时判据自己指名是哪一段并给出两侧 sha256。

(c) **适配器的话与契约板的行是同一条**（AC13）：`WIRE_MODELS` 的 `chat-audio` 行不是装饰 —— 板子的三个探针直接喂出货适配器，`goldenBody` / `answers` / 提示部分 / 上下文部分 / 超限算术各有一条实测读数，故「新线协议进了契约面」这句话有读数支撑，而不是靠类型逼出来的死代码。

**必须如实登记**（写进判据输出与本任务）：本任务**不注册** provider，也不改 `voice.service.ts`（分派是 AC-139）；不加 `transport` 与 SSRF 白名单（AC-140）；不做用户配置、key 掩码与健康检查（AC-141）；不做浏览器端到端（AC-142）；判据跑在 Node 与替身上游下，**不等于**真实 DashScope（真实服务的冒烟按 ADR-004 决策 8 归人工、不进 CI）；`qwen3.8-omni-flash` 是别名，服务端升级后行为可能漂移；提示词与 `JSON_TASK` 的正文不在工装里，工装只持有它们的 sha256 与来自出货模块的引用。

L_D 该轴仍暗，理由：本任务只实现一个适配器的离线线协议与解析降级，不新增用户数据通路或数据结构（provider 注册与分派在 AC-139，用户凭据与设置通路在 AC-141）。

L_G 该轴仍暗，理由：目标层判据（口述经服务端代理产出书面指令并写入 composer）要求适配器先被注册、服务端按 provider 分派、用户配置落地；本任务不注册 provider、不改 `voice.service.ts`，因此目标层行为在本任务前后不变。

## Touches

- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- shared/asr/asrRegistry.ts
- shared/asr/asrInvariants.ts
- scripts/asr-dashscope-omni-check.mjs (new)
- scripts/asr-dashscope-omni-check.test.mjs (new)
- tasks/gap-asr-dashscope-omni-wire-and-degradation.md
