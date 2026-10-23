---
id: gap-voice-client-asr-feasibility-probe
title: 客户端本地识别可行性探针：在浏览器里用 WASM 跑 SenseVoice-Small，用 MCP
  浏览器读实时因子、内存、首次加载与置信度一致性，给出 go / no-go（D2，不改产品）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-correction-feedback-loop.md` 的已确认决策 D2（本地识别器要支持浏览器 / 手机本地）与 §5.10「浏览器 / 手机本地识别」；引擎选择依据 `experiments/voice-index-loop/RESULT-v5.md`、`RESULT-v6.md`。立案时对 `tasks/` 做过同机制去重（`grep -il 'sensevoice\|sherpa\|wasm.*asr' tasks/*.md` 无命中），没有同机制的已有任务。

### 要回答的问题

§5.10 的表里每一行都是「尚未验证」：能否在浏览器经 WASM 运行 SenseVoice-Small（229 MB int8）、手机 / 浏览器单线程的实时因子、体积与首次加载、置信度与服务端是否一致、内存、回退。本任务**只做测量，不改产品代码**，用 MCP 浏览器（playwright MCP）在真实浏览器里读数，给出 go / no-go。

### 立案时已测的环境事实（MCP 浏览器，`http://localhost:3001/`，Chromium 153 headless）

| 项 | 读数 |
|---|---|
| WebAssembly / SIMD | 都支持 |
| `crossOriginIsolated`、`SharedArrayBuffer` | **false、undefined**——应用的响应头里没有 COOP / COEP，**多线程 WASM 不可用**；基线只能是单线程 SIMD |
| OPFS、Cache API、AudioWorklet、getUserMedia | 都可用 |
| 存储配额 | 约 10.9 GB |
| WebGPU | 存在（headless；不作为前提，iOS Safari 无） |

### 方案

1. 先写 `experiments/voice-client-asr-probe/PREREG.md` 并**提交**，再取数：登记指标、阈值、判定规则（沿用 `docs/experiments/README.md` 协议）。
2. **构建路径二选一，也可两条都做**，在结论里记录选了哪条及原因：
   - (a) sherpa-onnx 官方 WebAssembly 构建（需 emscripten），套用 `experiments/voice-index-loop/sherpa-patch/sv-logprobs-v1.13.8.patch` 以拿到 token 置信度；
   - (b) onnxruntime-web 直接跑 `model.int8.onnx`，探针里用 JS 实现与 sherpa 一致的前端：fbank 80 维、hamming 窗、`snip_edges = true`、样本乘 32768、LFR 7 / 6（左补 3 帧首帧、右补末帧）、CMVN（取自模型元数据 `neg_mean`、`inv_stddev`）、丢弃前 4 个前缀帧、CTC 贪心 + log-softmax（规格见 `RESULT-v5.md` 与 `PREREG-v6.md` §0）。
3. 探针页 `experiments/voice-client-asr-probe/index.html` 暴露 `window.__probe = { info(), run(clipUrl) }`；`run` 返回 `{ text, tokens: [{ tok, p, t }], ms }`。静态服务器脚本 `serve.mjs` 提供 `--isolated` 开关（加 COOP / COEP 头），用来读「宿主加这两个头能否启用多线程、快多少」。
4. 语料：沿用 `tc-verify/corpus/voice-index-loop/wav/` 的合成语音片段（仓库外，用环境变量 `VOICE_PROBE_CLIPS_DIR` 指定；不入库）；服务端对照用 `sv2/sv.jsonl`（补丁引擎的文本与 token 置信度）。
5. 用 MCP 浏览器执行并读数：`browser_navigate` 打开探针页，`browser_evaluate` 调 `__probe.run`，`browser_resize` 到移动视口；若 `browser_run_code_unsafe` 能走 CDP，则用 `Emulation.setCPUThrottlingRate`（4×）做手机估算，不能则记录「不支持」。
6. **阈值（预注册，桌面 Chromium 单线程 SIMD）**：实时因子 p90 ≤ 1.0（不慢于实时，才能随 VAD 切段即时上屏）；二次打开（模型已在缓存）到可识别 ≤ 10 s；WASM 堆峰值 ≤ 1.5 GB；**服务端置信度 ≥ 0.85 的 token，客户端在同位置输出同一 token 的比例 ≥ 95%**（文本逐字相同不作要求：这个模型对浮点细节敏感，见提案 §5.9）。
7. 结论文档给出 go / no-go 表，并明确「宿主是否需要加 COOP / COEP 头」的建议与代价（跨源嵌入的影响见 `docs/proposals/voice-kit-SPEC.md`）。

### 边界（不做）

不改 `src/`、`server/`、`shared/` 下任何产品代码；不入库模型权重与音频；不在本任务里写客户端 ASR 适配器（探针 go 之后另立任务）；真机（iOS Safari、Android Chrome）读数只能由人读取（见 AC 末项）。

## AC

- [x] `experiments/voice-client-asr-probe/PREREG.md` 的首次提交时间早于 `docs/experiments/2026-10-06-voice-client-asr-probe.md` 的首次提交时间（`git log --diff-filter=A --format=%ct -- <文件> | tail -1` 逐个取值比较，前者更小），且 PREREG 含 §Proposal 第 6 条的全部阈值
- [x] `ls experiments/voice-client-asr-probe/` 含 `PREREG.md`、`index.html`、探针脚本、`serve.mjs`、`README.md`（README 写明构建复现步骤与所用 emscripten / onnxruntime-web 版本）；`git ls-files experiments/voice-client-asr-probe | grep -E '\.(onnx|wav|webm|bin|wasm)$'` 无输出（权重、音频、构建产物不入库）
- [x] 用 playwright MCP 的 `browser_navigate` 打开探针页后，`browser_evaluate` 调 `window.__probe.info()` 返回含 `crossOriginIsolated`、`wasmSimd`、`threads`、`runtime`（`sherpa-wasm` 或 `ort-web`）、`buildId` 的对象，该返回值逐字记入结论文档
- [x] 至少 50 条片段上的读数全部由 MCP 浏览器 `browser_evaluate` 取得并写入结论文档：实时因子 p50 / p90 / max、首次加载与二次加载耗时、模型下载字节数、WASM 堆峰值；文档列出取得每项读数所用的 evaluate 调用摘要
- [x] 置信度一致性：同一批片段上，探针输出与 `sv2/sv.jsonl` 对比，文档给出「服务端置信度 ≥ 0.85 的 token 中，客户端同位置同 token 的比例」，并另报文本逐字相同的比例（只作描述）
- [x] `node experiments/voice-client-asr-probe/serve.mjs --isolated` 下 `crossOriginIsolated === true` 且 `SharedArrayBuffer` 可用，文档给出多线程下的实时因子读数；无 `--isolated` 时仍为 false（两种情形的 `browser_evaluate` 读数都记入文档）
- [x] 移动视口：`browser_resize` 到 390×844 重跑一遍；MCP 浏览器支持 CDP 时再做 4× CPU 节流重测，不支持时文档写明「不支持」及原因
- [x] 结论文档含 go / no-go 判定表，逐条阈值给出读数与通过 / 不通过，并对 `crossOriginIsolated = false` 的后果与是否需要宿主加 COOP / COEP 头给出明确建议
- [x] `docs/proposals/voice-correction-feedback-loop.md` §5.10 的「要先测量」表每一行末尾追加「读数：」并指向结论文档对应小节（`awk '/^### 5.10/,/^## 6/' docs/proposals/voice-correction-feedback-loop.md | grep -c '读数：'` ≥ 6）
- [ ] 真机（iOS Safari、Android Chrome）读数：由人 yale 在真机上用同一探针页读取，并写入结论文档的「真机」小节（待外部）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：读数来自**真实的 SenseVoice-Small 模型在真实浏览器（MCP 浏览器）里运行**，不是 mock 或预置结果；每个结论写明所依据的片段数、读数与未测项（真机、多线程在无 COOP / COEP 下的不可用）；go / no-go 是对预注册阈值的逐条判定，不是印象。若 go：在结论里列出「客户端适配器」后续任务应包含的接口约束（输出 `{ text, tokens[{ tok, p, t }] }`、构建标识、与服务端在置信度 ≥ 0.85 处一致）。

L_D 该轴仍暗，理由：本任务产出的是实验记录与探针，不新增领域数据能力。

L_G 该轴有读数：浏览器 WASM 路径的实时因子、内存、置信度一致性，由结论文档给出。

## Touches

- experiments/voice-client-asr-probe/PREREG.md (new)
- experiments/voice-client-asr-probe/index.html (new)
- experiments/voice-client-asr-probe/probe.mjs (new)
- experiments/voice-client-asr-probe/serve.mjs (new)
- experiments/voice-client-asr-probe/README.md (new)
- docs/experiments/2026-10-06-voice-client-asr-probe.md (new)
- docs/experiments/README.md
- docs/proposals/voice-correction-feedback-loop.md
- tasks/gap-voice-client-asr-feasibility-probe.md
