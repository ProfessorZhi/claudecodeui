# qwen3.8-omni-flash 书面化实验：原始读数（未冻结）

GOAL-009（`docs/proposals/voice-dashscope-omni-written-instruction.md`）的证据来源。这里是 2026-09-23 至 09-24 的**原始**读数与生成、判定它们的一次性脚本，原样保存，还不是冻结快照。整理成冻结快照与 `docs/experiments/` 下的实验记录是后续任务的事（AC-137 读的是那份快照，不是这里）。

所有文件都不含 API key，也不含音频字节（音频只以片段名引用）。

## 文件

| 文件 | 内容 |
|---|---|
| `written-ds.jsonl` | **定型依据**。DashScope 端点，`qwen3.8-omni-flash`，六组提示词 V/A/B/C/D/E；V/A/B/D 每条 3 次，C 与 E 每条 10 次（前 3 次与后 7 次是两次运行）。每行一次调用：`cond, clip, rep, status, ms, text, err, usage` |
| `written.jsonl` | 同样六组提示词经 OpenRouter（`qwen/qwen3.8-omni-flash`，provider 固定为 Alibaba），每条 3 次 |
| `results.jsonl` | Omni 阶段 1–3：思考档位、早期书面化提示词（指令放在音频之后，基本被忽略）、上下文臂（含完整 2387 个项目标识符） |
| `qwen-audio-bias/results.jsonl` | 对照：`qwen-audio-3.1-asr-flash` 的上下文、即时热词、项目标识符来源实验 |
| `written.mts` | 六组提示词的原文与调用代码（`GW=ds` 走 DashScope，否则走 OpenRouter；`REPS`、`ONLY` 控制重复次数与组别）。**E 组提示词以这里为准**。2026-09-24 补上 `argv[1]` 守卫：`e-ctx.mts` 会 import 本模块，缺守卫时一次 import 就会先跑起它自己的 run 循环（`omni.mts` 一直有这条守卫）|
| `judge.mts` | 语义判定规则（✅ 意图正确 / ◐ 可猜回 / ❌ 会误导），把人工判定的口径写成代码。**定型读数以它为准**：C ✅50 ◐26 ❌4，E ✅58 ◐18 ❌4（各 80 条） |
| `dump.mts` | 逐条列出 C、E 两组的 160 条输出、判定与 E 组的逐字转写 |
| `written-an.mts` | 早期的机械检查汇总；分母写死为 3，C、E 两组补到 10 次后该列不再准确，以 `judge.mts` 为准 |
| `omni.mts`、`an.mts`、`probe0.mjs` | 阶段 1–3 的调用与分析；`probe0.mjs` 是最初确认 webm、流式与思考档位的探针 |
| `qwen-audio-bias/ds-bias*.mts` | 对照实验的调用与分析 |
| `e-ctx.jsonl` | **E 组 × 上下文**（2026-09-24）：`E-twostep-low` 的五臂——无、4 个真名、70 名干草堆、全量项目名（今日 2447 个）、全量+护栏句；每条 10 次，共 400 次。上下文以独立的 `text` part 放在音频之后、JSON_TASK 之前（出货 multimodal 适配器渲染 `hints.context` 的约定） |
| `e-ctx.mts` | 上面那一轮的调用代码。提示词直接 import `written.mts` 的 E 条件、名单构造器直接 import `omni.mts`，不重写第二份 |
| `e-ctx-an.mts` | 分析：一条 rubric 轴（调 `judge.mts`，与 C/E 同源）+ 一条**插入轴**（名单里有、音频没说的名字——rubric 看不见的那一面） |
| `e-ctx-ext.jsonl`／`e-ctx-ext.mts`／`e-ctx-ext-an.mts`／`judge-ext.mts` | **扩展集**（`n01`…`n05`，2026-09-24 由真实会话消息改写成口语后合成的 5 条）：同一批臂跑在新语料上。`judge-ext.mts` 是新片段自己的判据（`judge.mts` 的规则逐片段写死，覆盖不到），**新旧只可比计数、不可比规则** |
| `e-ctx-real.jsonl`／`e-ctx-real.mts`／`e-ctx-real-an.mts` | **E 组 × 真实会话历史**（2026-09-24）：上下文不再是名单，而是一条**真实助手回复**（会话 78a2065f，7748 字符，逐字取用，已查无片段泄漏），冻结在 `fixtures/real-ctx.json`。臂 = `r-none`／`r-asst-1k`（同一条消息截到 1000 字符，隔离长度）／`r-asst-8k`／`r-asst-8k-guard`。13 条片段（旧 8 + 扩展 5），分析按集合分派判据 |
| `e-ctx-ext-dump.txt`／`e-ctx-real-dump.txt` | 上两轮的全文转储（含 `transcript` 逐字层），由各自的 `-an.mts texts` 生成 |

## 复现

所有脚本都必须**在仓库根目录**运行（路径相对仓库根）。

- 只重算判定、不联网：`npx tsx experiments/voice-omni-written/raw/judge.mts`，加参数 `texts` 输出逐条结果。
- 由于 `omni.mts` 在导入时会读取 webm，而 webm 位于不入库的 `experiments/voice-gemini-paired-quality/out/webm/`，重算前需要先用 ffmpeg 生成：

  ```bash
  mkdir -p experiments/voice-gemini-paired-quality/out/webm
  for f in experiments/voice-provider-paired-quality/fixtures/d0*-o65.wav; do
    ffmpeg -hide_banner -loglevel error -y -i "$f" -c:a libopus -b:a 64k -ar 48000 -ac 1 \
      "experiments/voice-gemini-paired-quality/out/webm/$(basename "${f%.wav}").webm"
  done
  ```

- 重新取读数要联网并计费：凭据从仓库根的 `.env.test` 读取（被 git 忽略），例如 `GW=ds REPS=10 ONLY=E-twostep-low npx tsx experiments/voice-omni-written/raw/written.mts run`。结果会追加到本目录的 jsonl。

## 限制

8 条 TTS 合成中文片段；语义判定是规则化的人工口径；不同运行之间有时段差异（延迟尤其明显）。
