# 客户端本地识别可行性探针（D2）

提案 `docs/proposals/voice-correction-feedback-loop.md` §5.10（D2）要求识别器有一条**客户端本地**
路径（浏览器 / 手机，不经网络），输出与服务端同一种 `{text, tokens[{tok, p, t}]}`。本探针
**只做测量，不改产品代码**：在真实浏览器（headless Chromium）里跑真实的 SenseVoice-Small int8，
读实时因子、加载、内存、置信度一致性，给出 go / no-go。

- 预注册（指标 / 阈值 / 判定规则，取数前提交）：[`PREREG.md`](PREREG.md)
- 结论：[`docs/experiments/2026-10-06-voice-client-asr-probe.md`](../../docs/experiments/2026-10-06-voice-client-asr-probe.md)

## 构建路径：为什么是 onnxruntime-web + 自写前端

两条候选（§提案第 2 条）：

- **(a) sherpa-onnx 官方 WebAssembly 构建 + `sherpa-patch/sv-logprobs-v1.13.8.patch`** — **未采用**。
  需要 emscripten 从源码构建；本机无 emscripten，且 `sherpa-onnx` npm 包只随附 **nodejs** 构建
  （`sherpa-onnx-wasm-nodejs.wasm`，其 glue 依赖 node 的 fs/require，不能在浏览器加载），1.13.8 的
  GitHub release 也没有浏览器离线识别器（ASR）预编译产物（只有 vad / TTS / 语音增强）。
- **(b) onnxruntime-web 直接跑 `model.int8.onnx` + 自写前端** — **采用**。不依赖 emscripten，
  前端在 JS 里实现，逐帧对照项目自己的服务端参考实现（见下）。

前端规格与 `experiments/voice-index-loop/sv/svlib.py`（v5/v6 的「自写前端」）一致：
fbank 80 维、hamming 窗、`snip_edges = true`、`dither = 0`、样本 ×32768、LFR 7 / 6（左补 3 帧首帧）、
CMVN 取自模型元数据 `neg_mean` / `inv_stddev`（**560 维**，按 LFR 维而非按 80 维）、丢弃前 4 个前缀帧、
CTC 贪心 + log-softmax。ONNX 的 `metadata_props` 由 `probe.mjs` 里的最小 protobuf 读取器在**运行时**
从模型读出（不预置常数）。

## 固定版本与哈希

| 产物 | 版本 | 字节数 | sha256 |
|---|---|---|---|
| 模型 `model.int8.onnx`（SenseVoice-Small int8） | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` | 239 233 841 | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `tokens.txt` | 同上目录 | 315 894 | — |
| onnxruntime-web（npm tarball） | **1.30.0** | — | `d2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71` |
| `ort-wasm-simd-threaded.wasm`（tarball 内） | 1.30.0 | 14 MB | `3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2` |

**emscripten 版本**：**未使用** —— 路径 (a) 未选，本探针不需要从源码编译 WASM，所以这里没有
emscripten 版本可固定（本机也没有 emscripten 工具链）。运行时是**预编译**的 `ort-wasm-simd-threaded.wasm`
（onnxruntime-web **1.30.0**，哈希见上表）。若日后改走 (a)，README 必须补上当时用的 emscripten 版本。

前端与 `svlib.py` 的逐帧对照用 `kaldi_native_fbank`（Python）做 oracle，版本随
`/data/home/yale/work/sv-probe/v`。

模型权重、`tokens.txt`、onnxruntime-web 的 js/wasm、音频、`.cache/` **都不入库**（`.cache/` 由仓库根的
`.gitignore` 忽略；`git ls-files experiments/voice-client-asr-probe` 里没有任何 `.onnx/.wav/.wasm/.bin`）。

## 运行

```sh
# 1) 取 onnxruntime-web（固定版本），解到 .cache/
mkdir -p experiments/voice-client-asr-probe/.cache
curl -sL -o experiments/voice-client-asr-probe/.cache/ort.tgz \
  https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz
tar -xzf experiments/voice-client-asr-probe/.cache/ort.tgz -C experiments/voice-client-asr-probe/.cache

# 2) 起静态服务（默认无 COOP/COEP；--isolated 加上它们）
node experiments/voice-client-asr-probe/serve.mjs            # http://127.0.0.1:8791
node experiments/voice-client-asr-probe/serve.mjs --isolated # crossOriginIsolated = true

# 3) 真机 / 手工：用浏览器打开，控制台调
#    window.__probe.info()             → { crossOriginIsolated, wasmSimd, threads, runtime, buildId, ... }
#    await window.__probe.run('/clips/1.wav') → { text, tokens:[{tok,p,t}], ms, audioSec, bytes }
```

`serve.mjs` 的挂载点：`/`（本目录）、`/ort/`、`/model/`（`MODEL_DIR`，默认
`/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`）、`/clips/`
（`VOICE_PROBE_CLIPS_DIR`，默认 `/data/home/yale/work/tc-verify/corpus/voice-index-loop/wav`）。
`--isolated` 在**所有**响应上加 `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` (+ `Cross-Origin-Resource-Policy: same-origin`)。

## 前端忠实性验证（取数前置）

`probe.mjs` 的 `fbank` / `lfrCmvn` 必须与 `svlib.py` 逐帧一致，否则不取数。做法：用
`svlib.py` 的同一 `kaldi_native_fbank` oracle 在片段 `1.wav` 上导出 fbank 帧与 LFR+CMVN 特征，
与 JS 版逐个比较（Float32 精度内）。参考读数：fbank `max|Δ| = 0`（410 帧全等），
LFR+CMVN `max|Δ| = 1.7e-5`（float32 舍入）。`probe.mjs` 里的 fbank 参数（DC 去除打开、预加重首个
样点用自身、mel 不做归一化）就是由这组对照钉住的。

## 目录

```
PREREG.md     预注册（取数前提交）
index.html    探针页：window.__probe = { info(), run(url), runSamples(samples), stats(), meta() }
probe.mjs     WAV 解析 + fbank + LFR/CMVN + ONNX metadata 读取 + CTC 贪心 + createProbe
serve.mjs     静态服务，--isolated 加 COOP/COEP
README.md     本文件
.cache/       下载的 ort / 模型缓存 / 读数 JSON（git-ignored）
```
