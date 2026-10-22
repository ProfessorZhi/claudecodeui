# 语音输入接入 DashScope Qwen3.8-Omni-Flash：口述直接产出书面化指令

- 状态：draft
- 日期：2026-09-24
- 人的裁定（yale，2026-09-24）：
  1. 提示词采用实验中的 **E 组**（角色 + 规则 + 示例 + 两步 JSON + `reasoning_effort: low`），经每条 10 次重复复核后定型。
  2. DashScope 的 key **由用户提供**（连同其工作空间地址），不由部署方的服务端环境变量提供。
  3. 适配器返回的**书面化指令**直接进入 composer。
  4. **暂不改变输入过程的体验**：不加「已书面化」标记、不加「查看原文 / 换回原文」。
- 关联：ADR-004（`adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md`）、`docs/proposals/voice-asr-provider-seam.md`（本 proposal 完成其 S4 中「路由分派」与「provider 选择」的部分）。

---

## 摘要

新增第三个识别适配器 `dashscope-omni`：把用户的录音（webm/opus）连同一段固定提示词发给阿里云百炼的 `qwen3.8-omni-flash`，让模型先逐字转写、再整理成一条可以直接交给编码 agent 执行的书面指令，适配器把这条指令作为转写结果返回。它是仓库里第一个真正上线的 `style: 'written'` 识别器。

这个端点不允许浏览器直连（CORS 预检 401），所以只能经服务端代理调用；这要求先完成 S4 的「按 provider 分派」，并让能力声明能表达「只能走代理」。

---

## 背景与证据

### 为什么要书面化

编码场景下的口述天然带口头禅、停顿和自我更正（「改一下 A，嗯不对，应该是 B」）。逐字转写把这些原样交给 agent，既啰嗦又有歧义；此前的读数里，逐字转写甚至会把「啊不，是 turbo」断成「啊，不是 turbo」，意思完全反了。

### 实验读数（2026-09-23 至 09-24，均为 webm/opus 上传，8 条 TTS 合成中文片段）

候选比较（逐字转写口径）：

| 服务 | 结论 |
|---|---|
| Gemini 2.5-flash-lite | CER 0.373，漏句 3/8，上下文会被原样吐进结果 |
| OpenRouter Qwen3-ASR 1.7B | CER 0.072，可经现有适配器直接接入，但不能书面化 |
| DashScope qwen-audio-3.1-asr-flash | 统一数字写法后 CER 最低，超级热词只在词表「极短且全对」时有效，给真实项目词表会误插；不能书面化 |
| DashScope qwen3.8-omni-flash | 逐字转写不稳定，但**能按指令书面化** |

书面化提示词对比（DashScope，`qwen3.8-omni-flash`，每组 8 条 × 3 次，随后 C、E 两组补到 × 10 次）：

| 组 | 提示词 | ✅ / ◐ / ❌（8 × 10 = 80 条） | 延迟 p50 / p90 / 最慢 |
|---|---|---|---|
| C | 角色 + 规则 + 示例 | 50 / 26 / 4 | 1.6s / 2.6s / 4.4s |
| **E** | C + 两步 JSON + `reasoning_effort: low` | **58 / 18 / 4** | 3.6s / 10.6s / 30.7s |

判定口径：把输出直接交给编码 agent 执行时，✅ 意图正确，◐ 能靠项目上下文猜回，❌ 会误导。

E 组的定型依据：
- 领先全部来自含标识符的片段；d01 上 E 组 6/10 认出 `voice.service.ts`，C 组 0/10（单侧 Fisher 精确检验 p ≈ 0.005）。
- 机制：E 组的逐字转写常把标识符逐字母拼出（「s e r v i c e」），改写阶段再按读音合成完整名字。
- 两组的 ❌ 一样多（各 4 次），类型相同：把名字压缩或拆开（如 `voice.ts`、`voice.ts` 和 `race.ts`），以及把「A 不对，应该是 B」改写成「把 A 改成 B」。
- 自我更正在两组的逐字转写里 20/20 被听到；E 组的指令正确消解了 d08 的 10/10、d02 的 8/10。

**证据现状**：原始读数目前只在不入库的 `experiments/voice-webm-asr-paired-quality/out/omni/`（`written-ds.jsonl`、`judge.mts`）。第一个实施任务（T1）要把它们整理成冻结快照和实验记录，作为本 proposal 与 `style: 'written'` 声明的证据。

---

## 目标与非目标

### 目标

1. 用户在设置页选择 DashScope 识别服务并填入自己的 key 和工作空间地址后，语音按钮录下的口述以**书面化指令**出现在 composer 中。
2. 服务端按 provider 分派到对应适配器（S4）；现有 OpenAI-compatible 路径的行为与线上字节不变。
3. 这个 provider 只能经服务端代理调用；浏览器不会直接请求它，服务端也不会请求白名单以外的主机。
4. 适配器的提示词与实验中评估过的 E 组**逐字相同**，任何改动都会被机械发现。

### 非目标

- 不改输入过程体验：不显示「已书面化」、不提供查看或换回原文。
- 不把项目标识符作为上下文或热词喂给模型：实验显示它会回声和误插。
- 不做服务端环境变量作为 DashScope key 的来源（裁定 2）。
- 不做失败时自动改用其他 provider。
- 不做流式输出、不做实时语音。
- 不改变默认识别器：未选择 DashScope 的用户行为完全不变。

---

## 设计

### 1. 数据流

```
浏览器录音 (webm/opus)
  → POST /api/voice/transcribe        （x-voice-provider: dashscope-omni）
  → voice.service：resolve(providerId).transcribe(request, invocation)
      invocation = { baseUrl: 用户的工作空间地址（已校验）, apiKey: 用户 key, model, timeoutMs: 20000, fetchImpl }
  → POST {baseUrl}/compatible-mode/v1/chat/completions
  ← { text: 书面指令, style: 'written', transformations: [...], providerId, meta }
  → useVoiceInput 照旧：repairIdentifiers(text) → composer
```

### 2. 适配器 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`

**线协议** `wire: 'chat-audio'`：

```json
{
  "model": "qwen3.8-omni-flash",
  "modalities": ["text"],
  "stream": false,
  "reasoning_effort": "low",
  "messages": [
    { "role": "system", "content": "<ROLE>\n\n<RULES>\n\n<EXAMPLES>" },
    { "role": "user", "content": [
      { "type": "input_audio", "input_audio": { "data": "data:audio/webm;base64,…", "format": "webm" } },
      { "type": "text", "text": "<JSON_TASK>" }
    ]}
  ]
}
```

- 提示词四段（附录 A）是模块常量，另有 `PROMPT_VERSION = 'written-e-2026-09-24'`。
- `format` 由录音的基础 MIME 类型推出（`audio/webm` → `webm`，`audio/ogg` → `ogg`，`audio/wav` → `wav` 等）。
- 请求头：`Authorization: Bearer <apiKey>`、`Content-Type: application/json`。

**解析与降级**：

| 上游返回 | 适配器结果 |
|---|---|
| `choices[0].message.content` 能解析出 JSON，且 `instruction` 非空 | `ok`，`text = instruction`，`style: 'written'` |
| JSON 解析失败或 `instruction` 为空，但 `transcript` 非空 | `ok`，`text = transcript`，`style: 'verbatim'`，`transformations: []`，`meta.writtenFallback = 1` |
| 内容能解析，但两者都为空 | `NO_SPEECH_DETECTED` |
| 内容不是可解析的文本 | `UPSTREAM_ERROR`（不把原始返回当成转写） |

JSON 允许被包在 Markdown 代码块或前后文字里：取第一个 `{` 到最后一个 `}` 之间的内容解析。

**错误映射**：

| 上游返回 | `AsrErrorCode` | 信息 |
|---|---|---|
| 401 `InvalidApiKey` | `UNAUTHORIZED` | key 无效 |
| 403 `AccessDenied.Unpurchased` | `UNAUTHORIZED` | 模型未开通或账户余额不足（实验中真实遇到过） |
| 其他 401/403 | `UNAUTHORIZED` | — |
| 429 | `RATE_LIMITED` | — |
| 超过 20 秒 | `TIMEOUT` | 实验 p90 为 10.6s，80 次里有 1 次超过 20s |
| 网络失败 | `UNREACHABLE` | — |
| 其他非 2xx | `UPSTREAM_ERROR` | — |

**能力声明**：

| 字段 | 值 | 依据 |
|---|---|---|
| `acceptsMime` | `audio/webm`、`audio/ogg`、`audio/wav`、`audio/x-wav`、`audio/mpeg`、`audio/mp3`、`audio/aac`、`audio/amr` | webm 实测接受；其余为官方文档所列 |
| `maxInlineRequestBytes` | 10 MB（整个请求） | 官方文档：base64 内联上限 10 MB |
| `oversize` | `'reject'` | — |
| `honors` | `prompt / language / context` 均为 `false` | 上下文实验：回声、误插 |
| `billing` | `'audio-tokens'` | 实测 14.5 秒音频计 100 audio tokens |
| `pauseCues` | `'neutral'` | 未测裁剪对它的影响；`neutral` 意味着不裁剪、上传原始录音 |
| `style` | `'written'` | 本实验 |
| `oneShot` | `true` | — |
| `transport`（新字段，见 §3） | `'proxy-only'` | CORS 预检 401 |

`transformations`：`['punctuate', 'de-disfluency', 'self-correction-applied', 'written-style']`。

`PAUSE_CUES_EVIDENCE['dashscope-omni']` 指向 T1 产出的实验记录。

### 3. 契约扩展（`shared/asr/asrRegistry.ts`）

1. **`AsrCapabilities.transport: 'direct' | 'proxy-only'`**：现有两个适配器声明 `'direct'`，新适配器声明 `'proxy-only'`。
2. **`AsrWire` 增加 `'chat-audio'`**。
3. **`AsrSuccess.meta` 增加可选字段** `promptVersion?: string`、`writtenFallback?: number`。

不增加「原文」字段（裁定 4：暂不改体验）。

以上都要同步进按 registry 参数化的离线不变量套件（`shared/asr/asrInvariants.ts`）：`chat-audio` 线协议的请求样本、错误映射、超限零请求、脱敏、MIME；以及 `proxy-only` 的 provider 在直连路径上零请求。

### 4. 服务端

- **S4 分派**：`voice.service.ts` 的 `transcribe` 不再写死 multipart 请求，改为调用已解析适配器的 `transcribe`，再把 `AsrErrorCode` 机械映射到 HTTP 状态码。OpenAI-compatible 路径的宽松解析行为和线上字节必须保持不变（`scripts/asr-extraction-parity-check.mjs` 保持绿）。
- **用户提供的配置**：服务端语音设置（`VOICE_SETTINGS_FIELDS`）增加 `providerId`、`dashscopeApiKey`、`dashscopeEndpoint`、`dashscopeModel`（默认 `qwen3.8-omni-flash`）。STT 与 TTS 的凭据从此分开，TTS 继续用原有的 baseUrl/apiKey。
- **SSRF 防护**：`dashscopeEndpoint` 在保存时和每次调用前都要校验：必须是 `https:`，主机名必须匹配 `^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$` 或等于 `dashscope.aliyuncs.com`，不允许路径以外的部分（端口、用户信息）。不合格的地址返回 `INVALID_BASE_URL`，且零上游请求。
- **key 不回显**：读取设置时 key 以掩码形式返回；日志里不出现 key、音频字节和转写正文，只记延迟、token 用量、`promptVersion`、是否降级。
- **健康检查**：`GET /api/voice/health` 的 `providers[]` 带上新 provider 的完整 capabilities（含 `transport`），`configured` 反映当前用户是否已填 key 和地址。

### 5. 前端

- **`src/shared/api.ts`**：生效 provider 的 `transport` 为 `'proxy-only'` 时，一律走 `/api/voice/transcribe` 并带 `x-voice-provider`，忽略浏览器侧的 baseUrl。
- **`VoiceSettingsTab.tsx`**：增加识别服务选择。选 DashScope 时显示 key、工作空间地址、模型（带默认值），并在同一处说明「录音会发送到阿里云百炼」（沿用 ADR-004 关于隐私告知放设置页的裁定）。
- **`useVoiceInput.ts`**：不改。书面指令作为普通转写文本进入 composer，`repairIdentifiers` 照常作用。

### 6. 失败与降级原则

- 上游失败时显示错误，已有草稿不丢，不静默改用其他 provider。
- 书面化失败（JSON 不可解析）时降级为逐字转写，并在 `meta` 里记下。
- 超时 20 秒，不重试。重试会把用户等待时间翻倍，而且结果可能出自不同的采样。

---

## 测试与验收

与 goal 的退出条件一一对应：

| AC | 验收内容 | 判据形态 |
|---|---|---|
| 提示词冻结 | 适配器里的四段提示词、`reasoning_effort`、模型默认值，与冻结实验快照里 E 组的记录逐字一致；快照里 C、E 两组每条 ≥ 10 次读数 | 离线脚本 |
| 适配器线协议 | 请求形状、JSON 解析与降级、错误映射（含 403 未开通）、超限零请求、`honors` 全为假时零上下文上线 | 离线脚本 + 替身 fetch |
| 代理分派 | 服务端按 provider 分派；OpenAI-compatible 路径字节不变 | 服务端测试 |
| 只走代理 + SSRF | `proxy-only` provider 在直连路径零请求；白名单外的地址零上游请求 | 离线脚本 |
| 用户配置 | 用户填了 key 和地址后健康检查 `configured` 为真；key 掩码返回；日志不含 key 与转写正文 | 服务端测试 |
| 浏览器端到端 | 设置页选择 DashScope → 录音 → composer 出现替身返回的书面指令；上游 403 时显示错误且草稿保留 | Playwright，替身模拟上游 |

另有一次**人工真实服务冒烟**（不进 CI）：用真实 key 和一条 webm 录音走完整链路，拿回书面指令。

---

## 分阶段实施

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 实验记录 | 把 `out/omni/` 的 V/A/B/C/D/E 读数（DashScope、C 与 E 各 × 10）整理为冻结快照和 `docs/experiments/<date>-omni-written.md`，含语义评价和规则判定脚本 | — |
| T2 S4 分派 + 凭据分离 | §4 前两项 | — |
| T3 契约扩展 | §3，加上不变量套件 | — |
| T4 DashScope 适配器 | §2，提示词逐字取自 T1 的快照 | T1、T3 |
| T5 用户配置 + SSRF + 前端 | §4 后三项、§5 | T2、T3、T4 |
| T6 端到端 | Playwright 替身用例 | T5 |

---

## 风险与已知限制

- **标识符仍是短板**：E 组 80 条里，含标识符片段的结果多数只到 ◐；d04 的禁改文件 20/20 都没认对（要改的目标全对）。
- **改写可能编造操作**：80 条里有 1 次把「A 不对，应该是 B」改写成「把 A 改成 B」。这一轮不做原文展示（裁定 4），用户只能从 composer 里的文字自己发现。
- **延迟长尾**：p90 10.6 秒、最慢 30.7 秒，按 20 秒超时约 1/80 的请求会报错。长尾是否只属于那一时段未知。
- **样本限制**：8 条 TTS 合成中文片段，只有 2 条含自我更正；结论只说明方向。
- **提示词与模型版本耦合**：`qwen3.8-omni-flash` 是别名，服务端升级模型后效果可能漂移。若有快照型号，应固定快照。
- **数据出境与计费**：录音发送到阿里云，费用由用户自己的账户承担。

---

## 与 ADR-004 的关系

- 这是第一个真正上线的 `style: 'written'` 识别器。ADR-004 决策 5 的输出信封 `{text, style, transformations}` 足以表达它。
- `transport` 能力字段和 `chat-audio` 线协议是对 ADR-004 契约的扩展，需要以 ADR-004 修订或新 ADR 的形式记录。
- 「key 只由用户提供、服务端不读环境变量」与 ADR-004 对「浏览器持键可接受、并支持服务端环境变量作为第二来源」的裁定不冲突：本 provider 只取其中一条来源。

---

## 待确认问题

1. DashScope 是否提供 `qwen3.8-omni-flash` 的快照型号可供固定？
2. 长尾延迟是否需要在 UI 上给出「仍在处理」的提示？这属于输入体验，按裁定 4 本轮不做，留待下一轮。
3. 真人录音语料（而非 TTS）何时补测？

---

## 附录 A：E 组提示词（逐字）

**system**（三段以空行连接）：

ROLE：

> 你是编码 agent 的语音指令整理器。用户对着麦克风口述了一条给编码 agent 的指令，你收到的是这段录音。你的任务不是逐字转写，而是输出一条清晰、书面化、可以直接交给编码 agent 执行的指令。

RULES：

```
规则：
1. 说话人自我更正（如“嗯不对”“啊不”“不是…是…”）时，只保留更正后的意思，删掉被否定的部分。
2. 删掉口头禅和填充词（嗯、那个、就是、啊）。
3. 文件名、函数名、hook 名等代码标识符用反引号包起来，按听到的拼写写出，不要猜测或替换。
4. 数字一律用阿拉伯数字。
5. 不得添加录音里没有的信息，不得省略录音里的任何要求。
6. 只输出整理后的指令本身，不要解释。
```

EXAMPLES：

```
示例（口述 → 整理后的指令）：
口述：嗯，那个，把 README 里的端口，就是 3000，改成八千零八十
指令：把 `README` 里的端口从 3000 改成 8080。
口述：给 login 页面加个校验，啊不对，是 signup 页面
指令：给 signup 页面加上校验。
口述：删掉 utils 目录下那个 date 的 helper，嗯，别动测试
指令：删掉 `utils` 目录下的 date helper，不要改动测试。
```

**user** 的文字部分（放在音频之后）：

```
先逐字转写录音，再按规则整理成指令。只输出一个 JSON 对象：{"transcript": "逐字转写", "instruction": "整理后的指令"}，不要输出其他内容。
```

请求参数：`model: qwen3.8-omni-flash`、`modalities: ["text"]`、`stream: false`、`reasoning_effort: "low"`。
