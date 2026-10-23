# 语音识别 Provider 缝（ASR Provider Seam）Proposal

状态：Proposal / 待评审
决策输入：人 yale 2026-09-22（见「已确认的设计决策」一节，五项均已定）
证据基础：

- `docs/experiments/2026-09-22-voice-punctuation.md`（prompt 偏置 / 停顿上限 / 模型臂的配对读数）
- `docs/proposals/voice-vad-trim-before-asr.md`（GOAL-006，裁剪的省时长与质量代价）
- `docs/proposals/voice-identifier-repair-and-temporal-compression.md`（GOAL-005，标识符修复与口径分歧）
- 仓库外工装 `/data/home/yale/work/tc-verify`（`tools/groq.mjs` 等 22 工具 / 14 日志）

关系：

- **决策记录见 `adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md`**。本文件承载完整论证与过程（契约草稿、能力字段的逐条出处、文件布局、分阶段实施）；ADR 取其中的决策，逐条补上代价与被否决的替代。**两者不一致时以 ADR 为准**（它是评审对象，本文件随评审结论一并修订）。
- **局部取代** `docs/proposals/voice-input-gemini-2.5-flash-lite.md` 的「推荐架构」「配置建议」「前端变更范围」三节。该文件的 Gemini 官方能力约束、请求体设计、安全与成本清单仍然有效，不改写。
- **修订** GOAL-005 与 GOAL-006 的非目标条目「不改 `server/modules/voice` 接口契约：保持纯透传」（见「与既有 proposal / goal 的关系」）。

---

## 摘要

今天"支持任意语音识别服务"是**配置层面的假象**：`baseUrl + apiKey + sttModel` 看起来通用，但 OpenAI-compatible 的协议形状被硬编码在**四处**（两跳各自的请求构造与响应解析），且没有任何地方能表达服务之间的能力差异。结果是——把 `sttModel` 改成 `gemini-2.5-flash-lite` 不会工作，不是配置错了，而是请求根本发不出去。

本 proposal 立一条**缝**：一份环境中立的适配器契约 + 每服务一个纯模块 + 一张能力声明表，并把"命令行与库一级的验证"变成落地顺序里的**前置步骤**而不是事后补丁。目标形态是 S0–S3 全部落地后，服务端路由与前端 UI **一行未改**，而新识别服务已经可以用一条命令在真实音频上跑通、并与旧服务在同一批语料上做配对比较。

同时修掉本次勘查发现的**三处真实缺口**（MIME 白名单、大小上限双真相源、`/health` 单一真相源），因为它们在新 provider 面前会立刻变成错误而不是缺陷。

---

## 背景与现状

### 一、四处硬编码，且两跳不同

先分清两跳，否则下面的描述会自相矛盾：

- **客户端 → 服务端（仅代理路径）**：multipart 字段 `audio`，**不带** `model`；模型与密钥走 `x-voice-*` 头（`voice.routes.ts:39-47`）。
- **客户端 → 识别服务（直连）** 与 **服务端 → 识别服务（代理）**：字段 `file` 与 `model`，`Authorization: Bearer`，路径写死 `/audio/transcriptions`。

| # | 位置 | 硬编码了什么 |
|---|---|---|
| 1 | `src/shared/api.ts:610-617` | 直连分支的**请求构造**：multipart `file` + `model`、`Authorization: Bearer`、写死路径 |
| 2 | `src/modules/chat/hooks/useVoiceInput.ts:499` | 直连分支的**响应解析**：`res.json()` 后取 `.text`；**非 JSON 响应会抛异常** |
| 3 | `server/modules/voice/voice.service.ts:107-112,132` | 代理分支的**请求构造**：`file` + `model`，URL 写死 `${config.baseUrl}/audio/transcriptions`；没有 `language`、没有 `prompt`、没有 `response_format` |
| 4 | 同文件 `:139-152` | 代理分支的**响应解析**：只认 `{ text: string }`；**非 JSON body 被当作转写文本原样返回** |

第 2 与第 4 处**容忍度不同**，这比"数量是四处"更重要：同一个上游异常（例如网关返回 HTML 错误页），在直连路径上报错，在代理路径上会被当成一段转写文本填进 composer。**两条路径已经分叉**——这是本提案要消灭的那类不一致的现存实例。

另有一处不对称：代理路径的 base URL 只认服务端 env，**没有任何 `x-voice-base-url`**（这是**有意**的安全约束，见「配置与拓扑」）。

这意味着"支持有差异的服务"在本仓库的真实含义是：**造一条缝，而不是加一个字段**。

### 二、本仓库已经实测过、且证明承重的能力轴

设计不该凭空发明能力字段。下面每一条都对应一个已测量的效应，因此能力声明表里的每一项都有出处：

| 轴 | 已测结论 | 出处 |
|---|---|---|
| `prompt` | 中文 + 出货裁剪下**有害**：句读 2.31→1.25、标识符 33.3%→22.2%；英文未裁剪时 +0.63 | `2026-09-22-voice-punctuation.md` §三 |
| `language` | 已明确**不采用**：真实使用是混合语种，误判比不判更糟 | 同上 §二；`experiments/README.md` 末 |
| 换模型 | `whisper-large-v3` 无收益，两语种 CER 都更差 | 同上「模型臂」 |
| 计费单位 | Groq 有 **10 秒/请求下限**；VAD 的 25.5% / 13.3% 收益就是对着这个下限算的 | `voice-vad-trim-before-asr.md` §依据 |
| 停顿线索 | 裁剪把**中文**句读打到 −89%；而 CER 只 +0.52pp —— **CER 对标点损失失明** | 同上 §四；punctuation §四.5 |

最后一行是本 proposal 最重要的设计输入：**裁剪删掉的停顿，正是标点线索**。在按秒计费的 Whisper 系服务上"裁了省钱"，在多模态大模型上"留着可能换回标点"。所以"裁不裁"必须成为**按识别器声明的决策**，而今天代码里没有任何地方能表达它。

### 三、验证通路的现状：缝已经存在，但在仓库外，且与出货代码不是同一条

- `2026-09-22-voice-punctuation.md` §七 已经把"换识别器"的接口发明出来了：`tools/groq.mjs` 是**唯一碰 HTTP 的模块**，`transcribe(filePath, { prompt, language, responseFormat, model })` 是全部契约；换服务只需实现同名函数，`punct-lib.mjs` 与所有 runner 不必改动。
- 但它在 **`/data/home/yale/work/tc-verify`（仓库外）**。
- 仓库内能离线跑的实验只有 `experiments/voice-trim/*`（frozen fixtures、不联网、量的是出货模块 `src/shared/voiceTrim.ts`）。
- 出货代码里的 ASR 调用则是**内联在 `voice.service.ts` 里的 fetch**，没有任何可 `import` 的纯模块。

结论：**今天无法在新识别服务上做任何"证明出货代码正确"的验证**——因为不存在一个既是出货实现、又能在命令行里直接调用的对象。这就是"命令行与库一级验证"当前缺失的那一环。

---

## 已确认的设计决策（人 yale 2026-09-22）

| # | 议题 | 决策 | 本 proposal 的落实 |
|---|---|---|---|
| D1 | 裁剪 × 识别器耦合 | **保持"默认裁剪"** | 默认行为不变；"不裁"只能由 provider 显式声明 + 该 provider 自己的实验证据触发，不得由配置静默翻转 |
| D2 | 拓扑 | **保持直连模式** | 直连分支保留；新增 provider 必须同时可用于直连与代理两条路径 ⇒ 适配器必须**环境中立** |
| D3 | 输出信封 | provider **优先**返回"书面化 / 去口头语 / markdown"；除非像现有 whisper 系经实验确认无法实现 | 信封从 `{text}` 扩为 `{text, style, transformations}`；并新增一条能红的负对照（见「输出信封」） |
| D4 | 上下文偏置 | **按模型/服务分别测试**后再决定是否启用 | 能力字段 `honors.context` + **默认关闭**；启用需该 provider 自己的配对实验读数 |
| D5 | 与既有 non-goal 冲突 | 既有"保持纯透传"是**阶段性的，必要时就改** | 显式修订 GOAL-005/006 的非目标条目，留修订记录，不改其已 achieved 的 AC |

---

## 目标与非目标

### 目标

1. 语音链路对识别服务的差异**可寻址**：换服务 = 加一个适配器 + 一张能力声明，不改路由、不改 UI、不改 composer。
2. **环境中立**：同一份适配器代码在浏览器（直连）、Node 服务端（代理）、命令行三处运行，且"中立"有机器判据而不是口头承诺。
3. **命令行与库一级可验证**：`--dry-run` 零成本验证请求构造；`--offline` 回放录制响应使验证可在 CI 离线跑；真跑一条命令即可在真实音频上取回文本。
4. **质量可比**：新服务能沿用 `docs/experiments/README.md` 的既有协议（同一批语料、`flat` 负对照、报 `n`、配对比较）产出记录，数字可与历史读数并列。
5. 修掉三处真实缺口，且修法是"由能力声明驱动"，不是再加一个常量。

### 非目标

- 不实现 Gemini Live / 双向实时语音。
- 不做识别结果的持久化与审计（是否保存转写原文仍是 `voice-input-gemini-2.5-flash-lite.md` 的待确认问题）。
- 不在本 proposal 内引入任何新依赖（`@google/genai` 的引入属于 Gemini 适配器的落地任务，且必须先在 S0 闸之后）。
- 不改 `voiceEnabled` 的语义（它仍是 uiPreferences 轴，不进 `/api/voice/config`）。
- 不做 TTS 侧的 provider 化。TTS 有同形的单一化（`synthesizeVoice` 同样写死 `/audio/speech`），但本 proposal 只把 ASR 走通；TTS 复用同一形状是后续独立目标。
- 不调 `PAUSE_CAPS` 与 VAD 参数（`voiceTrim.ts` 已定死）。

---

## 推荐架构

三层，每层都能独立验证。

```
        ┌────────────────────────── 浏览器（直连保留，D2）──────────────────────────┐
        │ src/shared/api.ts → asrRegistry.resolve(id).transcribe(req, ctx)          │
        └───────────────────────────────────┬──────────────────────────────────────┘
                                            │  同一份适配器
┌───────────────────────────────────────────┴──────────────────────────────────────┐
│ L1  契约与能力声明   shared/asr/asrContract.ts                                    │
│ L2  适配器           shared/asr/list/<id>/<id>.asr-provider.ts                    │
│                     shared/asr/asrRegistry.ts                                     │
└───────────────────────────────────────────┬──────────────────────────────────────┘
                                            │  同一份适配器
     ┌──────────────────────────────────────┴───────────────────────────────────┐
     │ server/modules/voice/voice.service.ts（代理，env 兜底）                    │
     │ experiments/voice-asr/run-transcribe.mjs（CLI，`npx tsx` 运行）          │
     └──────────────────────────────────────────────────────────────────────────┘
```

### L1 — 契约与能力声明

```ts
// shared/asr/asrContract.ts
export type AsrProviderId = 'openai-compatible' | 'gemini' | (string & {});

/** 识别器自己声明的能力。每一项都对应一个已测量的效应，不是预留字段。 */
export type AsrCapabilities = {
  /** 接受的容器/编码。驱动上传前的容器选择与 MIME 白名单（缺口 ①）。 */
  acceptsMime: string[];
  /** 单请求内联上限（字节）。**注意是整个请求的预算，不只是音频**：官方对某多模态服务的
   *  表述是"最大请求 20MB（含提示词与所有文件）"，因此提示词与上下文与音频共享同一预算
   *  （与 D4 上下文偏置相撞，见「上下文偏置」）。 */
  maxInlineRequestBytes: number;
  /** 超过 maxInlineRequestBytes 时的行为。'reject' 在第一版是唯一允许值。 */
  oversize: 'reject' | 'files-api';
  /** 各提示参数是否被该服务承认。false 表示"发了也没用"，适配器必须拒发而非静默丢弃。 */
  honors: { prompt: boolean; language: boolean; context: boolean };
  /** 计费口径。决定省时长读数的折算方式，进而决定裁剪的性价比。 */
  billing: 'audio-seconds' | 'audio-tokens' | 'request';
  /** 停顿线索对该识别器的作用。驱动是否裁剪（D1：默认 'destructive' ⇒ 保持默认裁剪）。 */
  pauseCues: 'destructive' | 'neutral' | 'useful';
  /** 输出风格能力。D3：能书面化的服务声明 'written'。 */
  style: 'verbatim' | 'written';
  /** 一次性还是流式。第一版只允许 true。 */
  oneShot: boolean;
};

export type AsrRequest = {
  audio: { bytes: Uint8Array; mimeType: string; fileName: string; durationSec?: number };
  hints: {
    prompt?: string;     // 仅当 honors.prompt
    language?: string;   // 仅当 honors.language
    context?: AsrContext; // 仅当 honors.context —— D4，默认不发
  };
};

export type AsrResult =
  | {
      ok: true;
      /** 已按 style 处理后的文本，composer 直接可用。 */
      text: string;
      style: 'verbatim' | 'written';
      /** 声明"做了什么"，供 UI 展示与指标选轴。见「输出信封」。 */
      transformations: AsrTransformation[];
      providerId: AsrProviderId;
      meta?: { model?: string; latencyMs?: number; usage?: Record<string, number> };
    }
  | { ok: false; code: AsrErrorCode; message: string; status?: number };

export type AsrErrorCode =
  | 'NOT_CONFIGURED' | 'INVALID_BASE_URL' | 'UNAUTHORIZED' | 'RATE_LIMITED'
  | 'TIMEOUT' | 'UNREACHABLE' | 'OVERSIZE' | 'UNSUPPORTED_MIME'
  | 'NO_SPEECH_DETECTED' | 'UPSTREAM_ERROR';
```

**错误码是契约的一部分**，因为今天的错误映射（`voice.service.ts:62-105`：401/403→502、AbortError→504、无 baseUrl→503、非法 URL→400）是**按 HTTP 状态就地判断**的；多服务之后同一个 400 可能意味着"密钥无效"或"模型不存在"或"音频格式不支持"，必须由适配器翻译成语义码，路由只做码→HTTP 的机械映射。

### L2 — 适配器

```ts
// shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts
export const capabilities: AsrCapabilities = { /* … */ };

/** 由调用方注入全部环境依赖：不读 env、不建 fetch、不碰 express/db。 */
export async function transcribe(
  request: AsrRequest,
  invocation: AsrInvocation,
): Promise<AsrResult>;
```

`AsrInvocation` 的形状（**注入**而非读取，这是"可在 CLI 与库一级跑"的充要条件）：

```ts
/** 一次调用所需的全部环境依赖。与 AsrRequest.hints.context（发给模型的会话上下文）是两回事。 */
export type AsrInvocation = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 注入 fetch，使适配器在 vitest（jsdom）/ node:test / 浏览器三处同构可测。 */
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
};
```

### L3 — 三条验证通路

**(a) CLI（`npx tsx` 运行，沿用 `experiments/` 既有形态）**

```bash
# 零成本：打印脱敏后的出站请求，不联网
node experiments/voice-asr/run-transcribe.mjs --provider gemini --file fixtures/zh-d01.wav --dry-run

# 回放：读录制响应，不联网，CI 可跑
node experiments/voice-asr/run-transcribe.mjs --provider gemini --file fixtures/zh-d01.wav --offline out/gemini-cache.json

# 真跑：一条命令在真实音频上取回文本
GEMINI_API_KEY=... node experiments/voice-asr/run-transcribe.mjs --provider gemini --file fixtures/zh-d01.wav --json
```

为什么 CLI 入口放在 `experiments/` 而不是 `shared/asr/cli/`：**根 `tsconfig.json` 的 `types` 只有 `["vite/client"]`，没有 node 类型**，一个使用 `process.argv` 的文件放进 `shared/` 会直接让 `npm run typecheck` 变红。

**但"与既有 runner 同形"这句话在初版是错的，必须更正**：既有 runner 用**裸 node** 导入出货模块（`experiments/voice-trim/run-savings.mjs` 等），之所以可行，是因为它们导入的 `voiceTrim.ts` / `identifierRepair.ts` 是**零 import** 的单文件，且住在被 `server/tsconfig.json` `exclude` 的 `src/` 里——因此从不经过说明符解析。本方案的适配器是**带相对导入的模块图**，一旦住在被服务端 NodeNext 构建覆盖的目录里，其内部说明符必须是 `.js`，而裸 node 对 `.js` 说明符报 `ERR_MODULE_NOT_FOUND`（实测）。**所以 CLI 改为 `npx tsx` 运行**（已是仓库依赖；`experiments/voice-identifiers/run-shipped-*.mjs` 已是这个跑法）。`experiments/**` 不被任何 tsconfig include，也不在 `npm run lint` 的路径列表里，因此它本身不受静态检查——这一点如实登记。

后续若要提升为操作面命令，再包一层 `cloudcli voice transcribe` 子命令。

**(b) 不变量套件（对 registry 参数化，离线）**

每个 provider 必须通过同一组契约测试，与质量无关：

1. 请求构造 golden：给定固定 `AsrRequest` + 注入的 `fetchImpl` 记录，断言出站 URL / 头 / 体**逐字节等于**录制基线（含 `honors.prompt=false` 时**不发** prompt 而不是发空串）。
2. 错误映射：401/403/429/5xx/timeout/空响应/非 JSON body 各返回哪个 `AsrErrorCode`。
3. 大小分流：`> maxInlineRequestBytes` 必须走 `oversize` 声明的路径，且**不得把整个音频塞进请求**；另需一条"音频本身在预算内、加上长上下文后超预算"的用例（预算含提示词与上下文）。
4. 脱敏：密钥与音频字节**不得**出现在任何返回值、错误 message 或日志行里。
5. MIME：不在 `acceptsMime` 内的输入必须在**发出请求之前**被拒绝（`UNSUPPORTED_MIME`）。

**(c) 质量谱系（沿用既有协议，不新造）**

`docs/experiments/README.md` 的八条协议原样适用：配对比较不跨运行、必须有能红的负对照、**被测实现必须是出货模块**、指标自己先用中文用例自测、不拿参考文本当标点真值、口径要写明、串行执行、结果落盘缓存。新 provider 产出一份 `docs/experiments/<date>-<provider>.md`。

### 文件落点与其证明义务（S0 闸）

**落点：仓库根 `shared/asr/`。** 依据是两套 tsconfig 的 include 事实：

- 根 `tsconfig.json`：`"include": ["src", "shared", "vite.config.js"]`
- `server/tsconfig.json`：`"include": ["./**/*.js", "./**/*.ts", "../shared/**/*.js", "../shared/**/*.ts"]`，`"rootDir": ".."`，产物落 `dist-server/shared/`，并且 `"exclude": [..., "../src"]`

也就是说 `shared/` 是**唯一**被前端与后端两套编译同时纳入的目录。今天它只有一个文件 `shared/networkHosts.js`，消费者是 `server/index.ts:20` 与 `vite.config.js:5`。

**但"唯一被两套 tsconfig include"远不等于"能被两侧导入"。** 评审实测出四个障碍，任一个都能让探针红：

1. **前端 lint 禁止相对导入，且没有任何别名能到达仓库根 `shared/`**。`.oxlintrc.json` 对 `src/modules/**` 与 `src/shared/*.ts` 施加 `no-restricted-imports`（正则 `^\.{1,2}/`，error，提示语"使用 `@/` 源根别名"）。而 `@` 映射到 `src`，`package.json` 里没有 `imports`、也不是 workspace 布局——**不存在通往仓库根 `shared/` 的别名**。三条路全堵：相对导入 ⇒ 该规则报错；`@/shared/asr/…` ⇒ 落进 `src/shared/asr/`（错树）；裸写 ⇒ `importx/no-unresolved`（同一 override 里也是 error）。旁证：今天 `src/modules/**` 与 `src/shared/**` 的相对导入数为 **0**，即该规则真的在生效。
2. **`.js` 说明符与"裸 node 跑 CLI"不可兼得**。`server/tsconfig.json` 是 NodeNext + 发射式构建，其内部相对导入**必须**写 `.js`（服务端 TS 一律如此，全仓无一处 `.ts` 说明符）。而裸 node 对说明符做**字面**解析、不把 `.js` 映射到 `.ts`：实测 `b.ts` 存在而 `a.ts` 写 `from './b.js'` 时，裸 node 报 `ERR_MODULE_NOT_FOUND`；同一文件 `npx tsx` 运行则通过。
3. **`shared/` 不在 lint 路径里**。`npm run lint` 的路径列表是 `src/ server/ scripts/`，**不含 `shared/`**。登记 `boundaries/elements` 买到的是"不被 `no-unknown` 判红"，**不是**"被 lint 覆盖"。`experiments/` 同理，所以 CLI 也不受静态检查。
4. **`.ts` 那半从未被证明过**：`shared/` 今天唯一的文件是纯 JS，两侧能解析 `.js` **不蕴含**能解析 `.ts`——而上面三个障碍恰好都住在 `.ts` 那一侧。

**由"两套 tsconfig 同时编译同一份文件"推出的硬约束**（违反必然在其中一侧失败）：

1. **导入形式必须是两侧都接受的那一种** —— 而它**目前不存在**，需由别名路径创造。（⚠️ 本文件初版此处写的是"只用相对导入，禁止 `@/`"，那条**在前端侧恰好是错的杠杆**：前端 lint 禁止的正是相对导入。这是评审最有价值的一条产出——一个从服务端编译要求推出的约束，在另一侧正好是反的。）
2. **相对导入的说明符扩展名由服务端构建决定（`.js`）**，因此 CLI 必须以 `npx tsx` 运行。备选是给 `server/tsconfig.json` 加 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（实测 tsc 退出 0，且把 `./b.ts` 重写为 `./b.js`、产物裸 node 可跑），但它**动的是全局构建配置**，波及面远大于改一个 CLI 的启动方式。
3. **不碰 node 内建**。根侧 `types` 只有 `["vite/client"]`、`lib` 只到 `ES2020 + DOM`：`process`、`Buffer`、`node:*` 无类型。这正是 CLI 入口不能放在 `shared/asr/cli/` 的原因。
4. **也不要用 ES2021+ 的库特性** —— 上一条**对称的另一半**，初版漏了：服务端 `lib` 是 `ES2022`、根侧是 `ES2020`，所以 `replaceAll`、`Array.at`、`Error.cause`、`structuredClone` 在服务端编得过、在前端侧**编不过**。
5. **`isolatedModules: true`**（根侧）：类型再导出必须写 `export type`，并配合前端 lint 的 `typescript/consistent-type-imports` 用 `import type`。
6. **环境依赖一律注入**（`fetchImpl`、`baseUrl`、`apiKey`、`model`、`timeoutMs`）：既满足约束 3，又让同一个适配器在三处同构可测。

因此 S0 必须先做一个**边界探针**，且**必须先解决上面障碍 1、2**。可选路径只有两条：

- **(a) 为仓库根 `shared/` 创造一条别名**，三处同时（根 `tsconfig.json` 的 `paths`、`vite.config.js` 的 `resolve.alias`、oxlint 的 resolver），并把 CLI 改为 `npx tsx`；
- **(b) 落回 `src/shared/asr/`**，即后备方案。

探针步骤：最小模块落在候选落点，从 `src/modules/**` 与 `server/modules/**` 各导入一次；`npm run typecheck` 退出 0（这同时是"环境中立"的**机器判据**：必须同时满足 `lib: DOM` + `moduleResolution: Bundler` 与 `lib: ES2022` + `NodeNext` + `types: node`）；`npm run lint` 退出 0，**且断言 lint 路径列表确实包含该目录**（否则只证明"没被判红"，不证明被覆盖）。

**若探针变红（后备方案）**：线协议实现只能有**一个**家，即 `src/shared/asr/`。此时**服务端代理不新增 provider**——因为在 `server/modules/voice/providers/` 里再写一份，会精确重演 AC-113 已经付过代价的错误（判据量的是副本而不是出货实现，16 条里 6 条不一致）。

**后备方案有一个初版没有承认的后果，必须写在这里：它会让缺口一与缺口三变成不可实现。** 因为 `server/tsconfig.json` 的 `exclude` 含 `../src`、服务端的 `@/` 映射到 `server/*`，所以**服务端消费不到 `src/shared/asr/`**；而缺口一（白名单由 `capabilities.acceptsMime` 决定）与缺口三（健康检查返回 provider 与能力）**都是服务端路由的改动**。因此**缺口一、缺口三对应的任务是有条件的**（仅当路径 (a) 成立），其判据必须写明这个前提。

---

## 输出信封与风格化（D3）

### 问题

D3 要求 provider **优先**返回书面化 / 去口头语 / markdown 的文本。这带来一个本仓库必须直面的后果：**现有判据会失明或失义**。

`src/shared/identifierFidelity.ts` 量的是**逐字存活**（`voice.service.ts` 算命中 `voice.service.ts`，`Voice.service.ts` 不算）。一份"书面化"的文本本来就不逐字等于口语原话，逐字口径会把它判成退化——但它可能恰恰是**更好**的结果。你在 2026-09-21 的会话里对这一点已有判断："这些都应被看作是有效的——对后续处理这些文本的 LLM 来说这些输入是可理解的。"

### 信封

`AsrResult.text` 是**已处理好**的文本（composer 直接可用），另有 `style` 与 `transformations` 声明做了什么：

```ts
type AsrTransformation =
  | 'punctuate' | 'de-disfluency' | 'written-style' | 'markdown'
  | 'identifier-canonicalized' | 'self-correction-applied';
```

`transformations` 是必需的，理由有三：给 UI 一个"这条被改写了吗"的依据；给指标一个**选轴的依据**（逐字轴还是语义轴）；给"该不该继续跑客户端 `repairIdentifiers`"一个判据（已经 `identifier-canonicalized` 的文本不应被二次改写）。

### 指标必须分轴，且"风格化"需要一条能红的负对照

| 轴 | 适用 | 说明 |
|---|---|---|
| A 逐字标识符存活 | `style: 'verbatim'`（whisper 系） | 现有 `identifierFidelity`，口径不变 |
| B **语义等价 / 下游可理解** | `style: 'written'` | 新口径。**负对照：含文件路径与代码片段的句子必须逐字保留**——书面化最容易顺手把 `voice.service.ts` 改写成 `voice service ts`，这条负对照就是量它 |
| C 句读 / 片段 | 全体 | 蒙掉标识符内部的点之后再数；口径见 punctuation §二 |
| D CER | 全体（辅助） | **已知对标点失明**（punctuation §四.5），只能作辅，不得单独作闸 |
| E 账单 | 全体 | 按 `capabilities.billing` 折算：`audio-seconds` 用 Groq 的 10 秒下限口径，`audio-tokens` 用 32 tokens/秒 |

轴 B 的负对照是本 proposal 新增的**必须能红的判据**：如果"把含标识符的句子交给风格化 provider"之后标识符逐字仍全数存活，那说明风格化根本没发生（实现是惰性的）；如果全数损毁，说明服务不可用。两个方向都要能红。

---

## 裁剪 × 识别器的耦合（D1）

**默认行为不变：`isVoiceTrimEnabled()` 默认 `true`，`useVoiceInput.ts:183-217` 的裁剪门逻辑不动。**（D1）

但缝必须存在，且其形状是：

- `capabilities.pauseCues === 'destructive'` ⇒ 按现状裁剪（这是 Whisper 系的实测结论：中文句读 −89%，但省 25.5%/13.3% 账单）。
- `capabilities.pauseCues === 'useful'` ⇒ **不裁剪**，把停顿作为标点线索交给识别器。
- 把某个 provider 从 `destructive` 改成 `useful`，**必须附带该 provider 自己的配对实验**（同语料、`flat` 负对照、四轴读数），不得只改一行声明。

需要同时记录的一条已知交互：若某 provider 能"补回"标点（轴 B/C 上升），裁剪造成的标点损失可能被下游恢复——但这是**待测假设，不是结论**。punctuation §五.1 已明确把"为什么损失是中文特有"列为未解释项，且禁止用输出侧差异（空格、词形）去解释输入侧变化。本 proposal 不重复这个错误：裁剪与风格化的交互必须**测**，不能推。

---

## 上下文偏置（D4）

D4：**按模型/服务分别测试**后再决定是否启用。落实为：

- 能力字段 `honors.context: boolean`，**未声明的 provider 一律不发 context**。
- context 载荷必须是**有界且可审的**：形状固定（最近 N 轮 assistant 输出 + 当前可见对话 + 文件树标识符候选）、有字节上限、有开关、开关状态在 UI 可见。
- **隐私**：context 会连同音频一起送到第三方。启用前必须让用户知道这一条，且默认关闭。
- **一条与 L1 能力字段相撞的硬约束（评审补）**：上下文进的是**同一个请求**，而多模态服务的内联上限是**整个请求的预算**（"含提示词与所有文件"）。因此上下文越长，音频的可用预算越小。这也是该字段命名为 `maxInlineRequestBytes` 而不是"音频上限"的原因——按音频建模会让一个长上下文请求在音频侧被误判为可发。
- **已有反面证据**：prompt 偏置在中文 + 出货裁剪下把句读从 2.31 打到 1.25、标识符从 33.3% 打到 22.2%（punctuation §三）。因此"给了上下文就更准"是**假设**，每个 provider 必须各自用配对实验判定。
- 与现有 `repairIdentifiers` 的关系：客户端确定性修复（候选来自项目文件树，`ChatComposer.tsx:18,292`）是**独立于 provider 的一层**，继续保留；context 是"把同样的信息以提示形式给模型"，两者不是替代关系。若 provider 声明 `identifier-canonicalized`，则跳过客户端修复以免二次改写。

---

## 配置与拓扑（D2）

**直连模式保留。** 因此：

- 适配器**环境中立**是硬要求，不是风格偏好：同一份代码在浏览器（持键直连）与 Node（代理）两处运行。
- 新增 provider 必须在两条路径上都能工作：`src/shared/api.ts:610-621` 的直连分支与 `server/modules/voice/voice.service.ts` 的代理分支都要改为"解析 provider → 调适配器"。
- **直连的既然后果**：Gemini 走直连时，API key 存在浏览器。这是 D2 的已接受代价，但必须在设置页明确告知（复用 `gap-voice-settings-server-storage` 建立的边界约定：密钥在浏览器是**有意为之**，见 `voiceConfig.ts:16-19`）。服务端 env 配置仍然保留给不愿在浏览器放键的部署。
- 三条配置轴今天已经并存（服务端 env 兜底 / 用户级 `user_voice_settings` / `voiceEnabled` 的 uiPreferences），加 provider 会变成第四条。**必须明确 provider id 只在用户级配置里，env 只提供"默认 provider id"**，不允许出现"env 说 A、用户配置说 B"时无从判断的情形。
- **未注册 / 拼错的 provider id 的行为必须定义（评审补，初版完全沉默）**，而它是可达状态：id 存在用户级配置里，会随版本与拼写漂移。沿用既有 registry 的失败模式——未注册 id 一律 fail-closed 并返回明确的不可用错误，**不得静默回落到默认 provider**（静默回落最坏：用户以为在用新服务，实际在用旧的）。三个面各需一条判据：直连分支、代理分支、健康检查。
- **一条必须显式保留的安全不变式（评审补）**：代理路径的 `VoiceRequestOverrides` **刻意不含 base URL**（`server/shared/types.ts:1285-1287`），即"客户端不得控制服务端的出站目的地"。把 provider id 放进用户级配置**并没有**重开这条规矩——端点始终由适配器按 id 固定，用户选的是**哪份适配器**，不是**往哪里发**。这一点要写明，否则下一个读代码的人会把 provider id 误当成一个可被客户端扩张的字段。

---

## 三处真实缺口的修改要求

这三处是本次勘查发现的既有缺陷。它们不因新 provider 才存在，但**新 provider 会把它们从"缺陷"变成"错误"**，因此纳入本 proposal 范围。

### 缺口 ①：`POST /api/voice/transcribe` 没有 MIME 白名单

现状：multer 只限大小（`voice.module.ts:42`），MIME 只做 `|| 'audio/webm'` 兜底（`voice.routes.ts:110`），上传什么就转什么。仓库内的先例是 `server/modules/assets/assets.routes.ts:31` 的 `fileFilter`。

修改要求：

1. 白名单**由所选 provider 的 `capabilities.acceptsMime` 决定**，不新增第二个全局常量。
2. 拒绝必须发生在**读取上游之前**，返回语义码 `UNSUPPORTED_MIME`，且**不得消耗一次转写请求**（不产生上游调用、不计费）。
3. **匹配必须按基类型（剥离 `;` 之后的参数）**。这条是评审补的，初版漏了：浏览器首选录音 MIME 是**带参数**的（`MIME_CANDIDATES` 首项 `audio/webm;codecs=opus`），而服务商公布的是**基类型**（`audio/webm`，无参数）。按公布列表做**精确匹配**会把**出货录音器自己的输出**判为不支持——正是本条要防的那件事，只是机制不同。
4. 客户端必须能拿到 `acceptsMime`：录音容器今天是 `MIME_CANDIDATES` 里的第一个受支持项（`useVoiceInput.ts:18-24`），裁剪路径还会重编码为 WAV（`encodeWavBlob`）。**容器选择必须按 provider 能力收敛**，否则会出现"录了 webm、provider 只收 wav、白名单把用户自己的录音拒了"。
5. 该拒绝路径需要双向负对照：不在白名单内的输入必须红，在白名单内的（**含带参数形式**）必须绿（避免把白名单写成恒拒或写成精确匹配）。

### 缺口 ②：25MB 全局界与 provider 的**请求预算**互不知情，是两个真相源

现状：`voice.module.ts:42` 写死 `fileSize: 25 * 1024 * 1024`；而多模态服务的内联上限是 **20MB 的整个请求预算**（含提示词与所有文件，不止音频）；Groq 又是另一个数。超限时 multer 错误经路由变成 **400**，不是 413。

修改要求：

1. **"单一计算点"这个说法是错的，初版写错了，这里更正。** 上限**必然分两层**：
   - multer 在 **handler 之前**按 `LIMIT_FILE_SIZE` 拒绝（`voice.routes.ts:92-96`），此时它**无从知道 provider**，只能取一个与 provider 无关的界；
   - per-provider 的 `min(全局界, provider 预算)` 只能在**适配器里**、上传已被缓冲**之后**执行。

   落地形态二选一：让 multer 取"所有 provider 的最大值"而由适配器执行本 provider 的界；或接受两层各自拒绝。**判据读"切换 provider 后读数改变"时，必须读适配器的拒绝，而不是 multer 的**，否则这条读数会在两层之间张冠李戴。
2. 超限返回语义码 `OVERSIZE`，HTTP 映射为 **413**（现状 400 是误导：客户端会以为是格式问题）。`voice-input-gemini-2.5-flash-lite.md` 已写明"当前 25MB Multer 限制需要与 Gemini 的 20MB inline 限制协调"，本条即其落实。
3. **预算按整个请求计**：提示词与上下文与音频共享同一预算（与 D4 相撞）。因此判定超限时不能只看音频字节。
4. **必须登记的一处必然代价**：小于全局界、但大于本 provider 预算的请求，会**先被完整缓冲**再被拒。这是"两层"这个事实的后果，不是实现缺陷。
5. `oversize: 'files-api'` 在第一版**不得被任何 provider 声明**（第一版只允许 `'reject'`）；声明它的 provider 必须同时给出远端文件的生命周期与清理策略，否则不允许合入。

### 缺口 ③：`GET /api/voice/health` 只反映服务端 env，是单一真相源

现状：`{ configured }` 只来自服务端 env 的 `VOICE_API_BASE_URL`（`voice.service.ts:121`），**与用户级配置无关**；客户端只能自行补偿——`useVoiceAvailable.ts:48-54` 用"已水合且 baseUrl 非空"当作可用。加 provider 选择之后，这会变成"三个来源说三件事"。

修改要求：

1. `GET /api/voice/health` 返回**当前用户的有效配置**：`{ configured, provider, providers: [{ id, label, capabilities, configured }] }`。
2. **向后兼容**：`configured` 字段的语义与位置不变，`useVoiceAvailable` 的既有补偿逻辑不得因此变红（现有测试与 e2e 依赖它）。
3. `providers[].capabilities` 是客户端做容器选择、裁剪判断、上下文开关的**唯一**依据——客户端不得再自行推导能力（今天 `repairIdentifiers` 的候选来源、MIME 选择、裁剪门都在客户端各自判断，加 provider 后必须收敛到这一处）。
4. 探针要求：一个"服务端 env 未配置但用户配置了"的实例，其 `configured` 必须为真——这是今天会答错的用例（也是 `f0cc3206` 那次会话里"Base URL 字段实际上是死的"同族问题）。

---

## 测试与验收标准

沿用 `voice-vad-trim-before-asr.md` §测试的三条原则，并补两条：

1. **被测实现必须是出货模块**：CLI 与套件 import `shared/asr/**` 的实际文件，不得在工装里放第二份线协议实现（AC-113 已付代价）。
2. **"能跑通"与"质量不降"必须同时断言**，否则恒等实现能靠一半拿分。
3. **零值要有正对照**：同一个 runner 里打印基线行（现有 provider 的读数）。
4. **（新）风格化 provider 的负对照**：含标识符的句子在风格化后必须逐字保留（见输出信封轴 B），两个方向都要能红。
5. **（新）离线可跑**：不变量套件与 `--dry-run` 必须零网络；只有"真跑"与质量谱系可以联网。

### 单元 / 契约

- 每个 provider 通过 L3(b) 的五组不变量（请求 golden、错误映射、大小分流、脱敏、MIME）。
- 现有 `openai-compatible` 适配器抽取后**行为零变化**：`server/modules/voice/tests/*`、`src/shared/tests/voiceConfig*.test.ts` 全部保持绿。

### 集成

- CLI 三条路径可跑：`--dry-run` 打印脱敏请求且退出 0；`--offline` 回放得到与录制一致的文本；真跑取回非空文本。
- 直连与代理两条路径都能选到新 provider（D2）。
- `UNSUPPORTED_MIME` / `OVERSIZE` / `NOT_CONFIGURED` 三个语义码在三处（直连、代理、CLI）产出**同一个码**。

### 浏览器验收

1. 设置页可选 provider；选 Gemini 时只显示 Gemini 适用的字段（OpenAI 专有字段隐藏或明确标注其仍服务于独立 TTS 后端）。
2. 录一段短语音，composer 得到文本；`transformations` 非空时 UI 有可见标识。
3. provider 不可用时 UI 显示错误且**不丢失已有草稿**（沿用 `voice-input-gemini-2.5-flash-lite.md` 的验收项）。
4. 直连模式下浏览器确实直连（e2e 已有 `/audio/transcriptions` 替身先例，`e2e/voice-trim.spec.ts:386`、`e2e/voice-identifier-repair.spec.ts:142`），代理模式下确实经服务端。

---

## 分阶段实施

| 阶段 | 内容 | 触碰面 | 前置 |
|---|---|---|---|
| **S0** | 契约 + registry + 把现有 OpenAI-compatible 抽成第一个适配器；**边界探针**（`shared/` 双向导入 + typecheck + lint + `boundaries` 登记） | `shared/asr/**`、`.oxlintrc.json`、`voice.service.ts`、`api.ts` | — |
| **S1** | CLI（`--dry-run` / `--offline` / 真跑）+ 不变量套件 | `experiments/voice-asr/**`、`shared/asr/tests/**` | S0 |
| **S2** | 多模态适配器（仅 inline；超**请求预算**明确拒绝） | `shared/asr/list/<provider>/**` | S1 |
| **S3** | 配对实验记录 `docs/experiments/<date>-gemini.md`（同语料、`flat` 负对照、五轴读数） | `docs/experiments/**` | S2 |
| **S4** | 三处缺口修复 + `GET /api/voice/providers` 能力快照 + 设置页 provider 选择 + 路由分派 | `voice.routes.ts`、`voice.module.ts`、`voice.service.ts`、`VoiceSettingsTab.tsx`、`useVoiceAvailable.ts` | S3 |
| **S5** | 限流 / 并发 / 审计 / Files API（若届时需要） | — | S4 |

**S0–S3 不碰路由契约、不碰 UI、不碰 e2e**：新 provider 完全由 CLI 与套件证明。S3 结束时"命令行与库一级的验证"闭环，而服务端与前端只改了"抽取适配器"这一处纯重构。

S0 的边界探针必须先于其它任何工作：**它是一个可能整体否定本方案落点的闸**（见「文件落点与其证明义务」的后备方案）。

---

## 待确认问题

1. **`shared/` 的边界探针会不会红？** 探针结果决定 S2 以后是否被边界阻塞。这是本 proposal 唯一可能在 S0 就改变形态的未知。
2. **Gemini 的 key 放哪？** D2 保留直连 ⇒ 浏览器持键是可接受的；但服务端 env 路径是否也要支持 Gemini（即同一个 provider 两个键来源）尚未定。
3. **风格化 provider 的"用户可见改写"程度**：`transformations` 要不要在 composer 里可回退（显示"已书面化"并可查看原文）？这关系到是否需要保存原始转写文本。
4. **轴 B 的口径**：语义等价需要人读还是可自动判定？punctuation §二 的先例是"标点位置合理性靠人读配对文本"——轴 B 很可能也只能如此，那它就不是 CI 判据而是一次性实验读数。
5. **`oversize: 'files-api'`** 的生命周期与清理策略（远端文件何时删、失败时是否残留）未设计。
6. **TTS 侧**是否复用同一形状（`synthesizeVoice` 同样写死 `/audio/speech`）？本 proposal 不覆盖。
7. **10 秒计费下限仍未在本机实测**（`voice-vad-trim-before-asr.md` 待确认 2）。在 `billing: 'audio-seconds'` 的折算上，这仍是一个未闭合的假设。

---

## 与既有 proposal / goal 的关系

### 对 `voice-input-gemini-2.5-flash-lite.md`

本 proposal **局部取代**其三节：

- 「推荐架构」：从"VoiceService 下挂两个 provider 类"改为"环境中立的适配器 + 能力声明 + registry"，因为后者才满足 D2（直连）。
- 「配置建议」：`VOICE_PROVIDER` / `GEMINI_API_KEY` 等服务端 env 从"主路径"降为"不愿在浏览器放键的部署的备选"；provider id 的真相源是用户级配置。
- 「前端变更范围」：前端不再只是"加一个 provider 选择项"，还要消费 `capabilities` 并据此决定容器、裁剪与上下文开关。

其「官方能力约束」「Gemini 请求设计」「安全、可靠性与成本」「待确认问题」四节**保持有效**，不改写；其分阶段实施被本 proposal 的 S0–S5 取代。

### 对 GOAL-005 与 GOAL-006 的非目标修订

两个目标都写了：

> 不改 `server/modules/voice` 的接口契约：保持纯透传。

**该条目是阶段性的，现予修订**（D5）。修订内容：

- 原文的意图是"**不让语音功能迫使服务端契约变化**"，当时的语境是裁剪与修复都在客户端完成，服务端确实不必参与。
- 引入 provider 缝之后，服务端**必须**参与：它要么分派适配器，要么（在直连模式下）继续纯透传。两者可共存——**直连分支保持纯透传不变**，"纯透传"从"服务端契约"降为"直连分支的性质"。
- 修订方式：在 GOAL-005 / GOAL-006 各追加一行修订记录（照 `voice-vad-trim-before-asr.md` 末尾"局部取代"的写法），**不动其已 achieved 的 AC**（AC-112..AC-115、AC-116..AC-122）。

### 对 `docs/experiments/README.md` 的接口

punctuation §七 描述的换识别器接口（`tools/groq.mjs` 是唯一碰 HTTP 的模块，`transcribe(filePath, {…})` 是全部契约）**就是本 proposal 的 L1/L2 形状**。本 proposal 做的事是把它从仓库外**提升为出货契约**，而不是另发明一套。新实验记录的协议、条件命名、负对照要求原样沿用。

---

## 修订记录

- 2026-09-22 立（人 yale 授权）。依据当日勘查：三处硬编码单一化（`api.ts:610-621`、`voice.service.ts:107-112,132`、`:139-152`）、`experiments/README.md` 与 punctuation §七 所记的换识别器接口、两套 tsconfig 的 include 事实。同日决策五项（D1 默认裁剪 / D2 保持直连 / D3 优先风格化 / D4 上下文按服务分别测 / D5 既有 non-goal 是阶段性的），并纳入本次勘查发现的三处真实缺口（MIME 白名单、大小上限双真相源、`/health` 单一真相源）作为范围内的修改要求。

- 2026-09-22 **第二版修订**（人 yale 指示，依据一次全新上下文的独立对抗评审 + 作者的实测探针）。**决策记录见 `adr/ADR-004`，本文件随其第二版一并修订。** 本版更正的项目：

  - **协议硬编码点由"三处"更正为"四处"**，并区分**两跳**（入站字段 `audio` vs 出站字段 `file`）；初版"代理发 `audio`"一句对它所命名的那个分支是**错的**。
  - **响应解析更正为两处且容忍度不同**：直连分支的契约在客户端 hook 里（`res.json()`，非 JSON 抛异常），代理分支才把非 JSON 当文本返回。这本身就说明两条路径已经分叉。
  - **CLI 由"裸 node"改为 `npx tsx`**，并写明既有先例为何没暴露这个问题（先例导入的是**零 import** 的单文件，且住在被服务端构建 exclude 的 `src/` 里）。
  - **落点新增四个障碍**（前端 lint 禁相对导入且无别名可达 `shared/`；`.js` 说明符与裸 node 不可兼得；`shared/` 不在 lint 路径里，登记≠覆盖；`.ts` 那半从未被证明过），并给出两条可选路径 (a)/(b)。**初版第一条硬约束"只用相对导入，禁止 `@/`"在前端侧恰好是错的杠杆，已更正。**
  - **后备方案新增后果**：它会让缺口一、缺口三变成不可实现（服务端消费不到 `src/shared/asr/`），两条任务因此**转为有条件**。
  - **内联上限更正为整个请求的预算**（含提示词与所有文件），字段改名 `maxInlineRequestBytes`，并写明与 D4 相撞。
  - **MIME 白名单新增匹配语义**：必须按基类型匹配（浏览器发的是带参数的 `audio/webm;codecs=opus`，精确匹配会拒掉出货录音器自己的输出）。
  - **缺口二更正**：`min(全局, provider 预算)` **不是单一计算点**，必然分两层（multer 在 handler 之前、且不知道 provider），并登记"先缓冲再拒"这一必然代价。
  - **补上对称的另一半约束**：`lib` 是 `ES2020 + DOM`，所以 ES2021+ 的库特性在前端侧编不过。
  - **补上未注册 provider id 的行为**（fail-closed、不静默回落，三个面各一条判据）。
  - **补上一条须显式保留的安全不变式**：provider id 进用户配置并未重开"客户端不得控制服务端出站目的地"。
