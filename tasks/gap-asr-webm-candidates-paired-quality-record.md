---
id: gap-asr-webm-candidates-paired-quality-record
title: webm-only ASR 候选配对质量记录（不判据化）：OpenRouter Qwen3-ASR
  1.7B/0.6B/Flash、Nemotron、whisper-turbo（双网关）与 DashScope
  qwen-audio-3.1-asr-flash，数字写法归一 CER、句读、上下文、单一运行
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`tasks/` 全文检索 `openrouter` / `dashscope` / `qwen3-asr` / `qwen-audio` 零命中。相邻的已完成记录 `gap-asr-paired-quality-experiment-record`（whisper 家族，wav）与 `gap-asr-gemini-paired-quality-record`（Gemini，wav）建立了协议与 runner 形状；本任务沿用其协议，换被测服务、**只用 webm/opus**，并补上它们没有的数字写法归一。本条不设 `depends_on`：它是实验记录，可执行性由外部条件（凭据 + 可达服务 + ffmpeg）决定。

**性质（ADR-004 决策 8）：质量数字不进判据集**，只进实验记录。

**立案依据：2026-09-23 的一次性探针（未冻结，仅作方向）。** 同 8 条 o65 中文片段，同一 CER 口径（小写、去标点与空白、逐字编辑距离）：

| 条件 | CER | 漏句 | 备注 |
|---|---|---|---|
| OpenRouter `qwen/qwen3-asr-1.7b`（wav） | 0.076 | 0/8 | 出货 `openai-compatible` 适配器原样可用 |
| OpenRouter `qwen/qwen3-asr-0.6b`（wav） | 0.084 | 0/8 | 同上 |
| OpenRouter `qwen/qwen3-asr-flash-2026-02-10`（wav） | 0.150 | 0/8 | 同上 |
| OpenRouter `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`（wav） | 0.441 | 2/8 | 同上 |
| OpenRouter `openai/whisper-large-v3-turbo`（wav） | 0.258 | 0/8 | 与 Groq 同名模型读数不同 |
| Groq `whisper-large-v3-turbo`（旧快照，wav） | 0.132 | 0/8 | — |
| DashScope `qwen-audio-3.1-asr-flash`（webm） | 0.084 | 0/8 | 唯一逐字认出 `useVoiceInput`、`voice.module.ts` 的；输出阿拉伯数字，d05 单条因「15/十五」记 0.313 |

另三条事实：(1) OpenRouter 的 ASR 模型走 `https://openrouter.ai/api/v1/audio/transcriptions`，multipart + Bearer，返回 `{text, usage:{seconds,cost}}`，`prompt`/`context`/`instructions`/`hotwords`/`corpus` 五个表单字段对四个模型**零影响**；浏览器 CORS 预检 204、`allow-origin: *`。(2) DashScope 走专属端点 `https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`，JSON，音频为 `data:<mime>;base64,…` 且**必须**带 `parameters.format`（缺失 ⇒ 400 `format is empty`；裸 base64 ⇒ 500），文本在 `output.text`；`webm`/`opus` 两种 format 均被接受；OpenAI 兼容的 `/compatible-mode/v1/audio/transcriptions` 与 `/v1/audio/transcriptions` 均 404；CORS 预检 401 无任何 CORS 头 ⇒ **浏览器不能直连**。system 消息里放术语对 d04 零影响（单条、无对照）。(3) 延迟分时段：22:45–22:50 全部 30–58s，23:00 后 webm 0.4–0.8s —— **一个时段的延迟读数不能代表服务**。

**本任务做什么：**

- 新 runner `experiments/voice-webm-asr-paired-quality/run.mjs`，从 `experiments/voice-provider-paired-quality/fixtures/d0*-o65.wav` 与 `paired.json` 原地读音频和参考文本（不复制音频）。**上传一律为 webm/opus**：runner 用主机 `ffmpeg`（`-c:a libopus -b:a 64k -ar 48000 -ac 1`）把每条片段（及裁剪列的 PCM）编码到 `out/webm/`（`.gitignore:16` 已忽略 `out/`），并把每个 webm 的 sha256 与 `ffmpeg -version` 首行写进冻结快照；离线重算时逐字节比对。缺 ffmpeg ⇒ 非零退出并打印缺失原因（不静默回退到 wav）。**任何条件都不得上传 wav**。
- 条件表（全部 webm）：`or-turbo`（OpenRouter whisper-large-v3-turbo，网关对照）、`groq-turbo`（Groq whisper-large-v3-turbo，凭据取仓库外 `/data/home/yale/work/tc-verify/.env`）、`or-qwen17`、`or-qwen06`、`or-qwenflash`、`or-nemotron`、`ds-flash`（DashScope）；裁剪臂：`or-qwen17|trim` 与 `ds-flash|trim`（出货 `src/shared/voiceTrim.ts#trimVoiceAudio` 后再编码为 webm）；上下文臂：`ds-flash|punct` 与 `ds-flash|flat`（system 消息分别放带句末标点 / 去句末标点的同一段文本），`or-qwenflash|punct` 与 `or-qwenflash|flat`（`prompt` 表单字段）。
- **被测实现**：OpenRouter 与 Groq 条件经出货 `shared/asr/asrRegistry.ts` 解析的 `openai-compatible` 适配器 `transcribe` 发出，fetch 不包装。DashScope **没有出货适配器**，其请求由 runner 本地构造 —— 记录必须如实写明这一列测的是服务而不是出货代码。
- **读数轴**：CER 与**数字写法归一后的 CER**（0–9999 的中文数字 ↔ 阿拉伯数字双向归一后再算）；句读数（沿用 `maskInternalDots` 蒙版的 `sentenceMarks`，另报逗号数，因为参考文本的边界只有逗号）；标识符逐字保留（参考文本中 `voice.service.ts` / `voice.routes.ts` / `voice.module.ts` / `useVoiceInput` 的大小写不敏感子串命中，另报出货 `src/shared/identifierFidelity.ts` 的读数）；漏句（归一文本长度 < 参考 60%）；延迟中位/最大；上游返回的计费用量。
- **上下文负对照**：参照条件按 `docs/experiments/README.md` 第 2 条先例在取数**之前**声明 —— 若该服务不承认上下文，参照是 `none`、`punct`/`flat` 的位移按采样噪声解读；记录必须对每个上下文臂给出「上下文被承认 / 未被承认」的结论与依据（输出逐字相同即为未被承认的直接证据）。
- **单一运行**：`--live` 只跑一次，快照带一个 run id，所有配对比较都在这一次运行内做。（2026-09-23 人的裁定：取消跨时段采样。）记录必须如实写明：只有一个时段、一次采样，**没有噪声尺子**，延迟读数只代表该时段。
- 记录 `docs/experiments/2026-09-23-webm-asr-candidates.md`：报 `n`、run id、「TTS 合成」、每条件表格、逐片段文本并列、上下文结论、裁剪结论、对「哪个候选值得接入」给出带限定的结论；在 `docs/experiments/README.md` 登记。

**边界（不做）**：不改任何出货代码与能力声明；不写 DashScope 适配器；不接路由分派；不把质量数字做成判据；不上传 wav。

## AC

- [x] AC1 空读数不是绿：`node experiments/voice-webm-asr-paired-quality/run.mjs --corpus=empty` 退出 1；默认离线重算退出 0 并打印 `n=8 × <k> condition(s)`，`k` ≥ 13 且条件 key 覆盖 Proposal 所列全部条件。
- [x] AC2 只用 webm：离线重算打印每条上传的 mime 与 sha256，全部为 `audio/webm`；`grep -nE "audio/wav|format: *'wav'" experiments/voice-webm-asr-paired-quality/run.mjs` 只命中「读 fixture」处，不命中任何请求构造；`--probe` 断言快照中无 wav 上传记录并退出 0。
- [x] AC3 缺 ffmpeg 不静默：以 `PATH` 去掉 ffmpeg 所在目录运行 `--live --dry-run`（不联网）⇒ 非零退出且 stderr 含 `ffmpeg`。
- [x] AC4 出货模块：`--probe` 打印 `shared/asr/asrRegistry.ts` 解析出的 `openai-compatible` 适配器 `transcribe` 与 `src/shared/voiceTrim.ts#trimVoiceAudio` 的绝对路径；runner 源码无 `/audio/transcriptions` 字面量（OpenRouter/Groq 请求不由 runner 自造）；DashScope 列在快照 `provenance` 中标为 `runner-local wire (no shipped adapter)`。
- [x] AC5 单一运行：快照内全部读数来自同一个 run id；`--runs=straddle`（把一条读数改成另一 run）⇒ 退出 1 并报 `different runs`。
- [x] AC6 负对照与上下文结论：`--control=absent` / `--control=zero` / `--control=inverted` 各退出 1 且判词指名 `flat`；离线重算为每个上下文臂打印 `context honored` 或 `context not honored` 与依据。
- [x] AC7 数字归一：离线重算对每个条件同时打印 `cer` 与 `cerNumNorm`；单元自检 `--selftest` 断言 `十五秒`↔`15秒`、`三十`↔`30`、`五十秒，不是五秒`↔`50秒，不是5秒` 归一后逐字相等，退出 0。
- [x] AC8 记录作答：`docs/experiments/2026-09-23-webm-asr-candidates.md` 存在，含 `n=8`、run id、「TTS 合成」、「单一时段、一次采样、无噪声尺子」、`cerNumNorm` 列、上下文结论、裁剪结论、以及「DashScope 列测的是服务而非出货代码、浏览器不能直连（CORS）」两句；`docs/experiments/README.md` 列出该文件。
- [x] AC9 不判据化与凭据不入库：runner 末行含 `quality numbers are a reading and are NOT a criterion`；`grep -rl voice-webm-asr-paired-quality scripts/` 为空；在载入 `.env.test` 的 shell 里 `git log -p develop..HEAD | grep -cF "$OPENROUTER_API_KEY"` 与 `grep -cF "$DASHSCOPE_API_KEY"` 均为 0；`out/` 不入库。
- [x] AC10 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

真实落地判据：不是「多了一份 md」，而是**七个候选服务在同一次运行、同一批片段、只用 webm 上传的条件下真的被跑过**，读数冻结可离线重算，且对「哪个值得接入」给出结论并注明它没有噪声尺子。承重性由三件读数证明：

(a) 空读数不是绿（AC1），负对照能红（AC6）；
(b) 上传格式被机械限定为 webm（AC2、AC3）—— 不然延迟与质量读数会混进 wav 的上传代价；
(c) 数字写法归一后的 CER 与原始 CER 并列（AC7）—— 不然「输出阿拉伯数字」的服务会被系统性低估。

**必须如实登记**：n=8、TTS 合成、单一语言、单一时段一次采样（无噪声尺子，延迟只代表该时段）；ffmpeg 编出的 opus 与 Chrome MediaRecorder 的输出参数不完全相同；DashScope 列测的是服务本身；质量回归不进 CI（ADR-004 决策 8）。

L_D 该轴仍暗，理由：本任务只产出实验记录，不新增领域数据能力。
L_G 该轴仍暗，理由：目标层判据（换识别服务不改路由与 UI）需要 S4 路由分派，本任务不接路由。

## Touches

- experiments/voice-webm-asr-paired-quality/run.mjs (new)
- experiments/voice-webm-asr-paired-quality/fixtures/snapshot.json (new)
- docs/experiments/2026-09-23-webm-asr-candidates.md (new)
- docs/experiments/README.md
- tasks/gap-asr-webm-candidates-paired-quality-record.md
