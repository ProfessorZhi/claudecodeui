# 预注册：客户端本地识别可行性探针（D2）

状态：**在取数之前提交。** 本文件登记指标、阈值与判定规则；阈值与判定一旦提交即不改，
后续读数只填入 `docs/experiments/2026-10-06-voice-client-asr-probe.md`。

## 0. 问题

提案 `docs/proposals/voice-correction-feedback-loop.md` §5.10（D2）要求：识别器要有**客户端本地**
路径（浏览器 / 手机，不经网络），输出与服务端同一种 `{text, tokens[{tok, p, t}]}`。§5.10 的表
每一行都标「尚未验证」。本探针**只做测量，不改产品代码**，回答：SenseVoice-Small 能否在
**真实浏览器**里经 WASM 跑起来、多快、多大内存、置信度与服务端在确定 token 上是否一致，
并给出 go / no-go。

## 1. 构建路径（预注册选择）

两条候选，本探针走 **(b) onnxruntime-web + 自写前端**：

- (a) sherpa-onnx 官方 WebAssembly 构建 + `sherpa-patch/sv-logprobs-v1.13.8.patch`：需要 emscripten
  从源码构建。**本次不选**，原因记录在结论里（本机无 emscripten；且 npm 包只随附 nodejs 构建，
  浏览器构建无预编译产物，见 `ADR-003`）。
- (b) onnxruntime-web 直接跑 `model.int8.onnx`（SenseVoice-Small int8），前端在 JS 里实现，规格
  与 `experiments/voice-index-loop/sv/svlib.py`（v5/v6 的「自写前端」）一致：fbank 80 维、hamming 窗、
  `snip_edges = true`、`dither = 0`、样本 ×32768、LFR 7 / 6（左补 3 帧首帧）、CMVN 取自模型元数据
  `neg_mean` / `inv_stddev`、丢弃前 4 个前缀帧、CTC 贪心 + log-softmax。

前端正确性用 Python 参考（`svlib.py`，与 `sv2/sv.jsonl` 同源）在**同一批片段**上逐帧 / 逐 token
交叉核对：JS 与 Python 的 token 序列（含 `t`）必须一致，作为「前端忠实」的取数前置；不一致则不取数。

## 2. 数据

- 语料：`tc-verify/corpus/voice-index-loop/wav/*.wav`（仓库外，`VOICE_PROBE_CLIPS_DIR` 指定），
  16 kHz 单声道 PCM。
- 取 `sv2/sv.jsonl` 中 id 形如 `v3:<N>`（纯数字）且磁盘上有 `<N>.wav` 的片段，按 id 升序取
  **前 60 条**（≥50 条，固定集合，预注册后不改）。
- 服务端对照：`sv2/sv.jsonl` 的 `tokens`（`{tok, p, t}`）。

## 3. 指标与阈值（预注册）

环境口径：**桌面 Chromium（headless）+ 单线程 SIMD WASM**（宿主不加 COOP / COEP 时
`crossOriginIsolated = false`，无 `SharedArrayBuffer`，只能单线程）。

| # | 指标 | 阈值 | 判定 |
|---|---|---|---|
| T1 | 实时因子 p90（解码秒 ÷ 音频秒，单线程） | ≤ 1.0 | 通过 / 不通过 |
| T2 | 二次打开（模型已在缓存）到可识别耗时 | ≤ 10 s | 通过 / 不通过 |
| T3 | WASM 堆峰值 | ≤ 1.5 GB | 通过 / 不通过 |
| T4 | 一致率：服务端置信度 ≥ 0.85 的 token 中，客户端**同位置（同 `t`）同 token** 的比例 | ≥ 95% | 通过 / 不通过 |

另记（**只作描述，不设阈值**）：首次加载耗时、模型下载字节数、实时因子 p50 / max、文本逐字相同
比例、WASM 字节数、多线程（`--isolated`）实时因子与相对单线程的加速比、移动视口（390×844）与
4× CPU 节流下的实时因子。

**go / no-go 规则**：T1–T4 **全部通过 = go**；任一不通过 = no-go（若仅 T1 在移动视口 / 节流下
不通过而桌面通过，判为「桌面 go、移动待真机」，并写明）。读数缺失（前端交叉核对未过、浏览器
起不来）＝**无法判定**，不折算为通过。

## 4. 对照与负控制

- **前端忠实性对照**：JS 前端 vs Python `svlib.py`，同一批片段，token 序列（tok + t）完全一致。
  不一致则不取数。
- **置信度对照**：客户端 token 的位置由 `t`（LFR 帧序号，与前缀帧丢弃后的局部位一致）定义；
  只比较服务端 `p ≥ 0.85` 的 token（§5.10 的「确定的位置」）。
- **负控制**：把片段换成静音 / 空数组时，探针必须返回空 token 序列而不是崩溃或返回缓存的文本；
  该负控制的读数与主读数分开记。

## 5. 判定与执行

1. 先提交本文件，再取数。
2. `node experiments/voice-client-asr-probe/serve.mjs` 起静态服务；用真实 Chromium 打开探针页，
   调 `window.__probe.info()` 与 `window.__probe.run(clipUrl)` 取数。
3. 记录 `--isolated`（COOP / COEP）与默认两种情形的读数。
4. 移动视口重跑；CDP 可用则做 4× CPU 节流。
5. 逐条给出 T1–T4 的读数与通过 / 不通过，写入结论文档；并给出宿主是否要加 COOP / COEP 的建议与代价。
6. 真机（iOS Safari、Android Chrome）由人 yale 补测，本文件不设其阈值，结论里标「待外部」。

## 6. 边界

不改 `src/`、`server/`、`shared/`；不入库模型权重、音频与构建产物；不在本任务里写客户端 ASR 适配器。
