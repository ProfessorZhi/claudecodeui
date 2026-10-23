# 2026-10-06 客户端本地识别可行性探针（D2）

问题：提案 `docs/proposals/voice-correction-feedback-loop.md` §5.10（D2）要求识别器有一条**客户端本地**
路径（浏览器 / 手机，不经网络），输出与服务端同一种 `{text, tokens[{tok, p, t}]}`。§5.10 的表每一行
都标「尚未验证」。本探针**只做测量，不改产品代码**：在**真实浏览器**（headless Chromium，非 jsdom、
非 node 里的 wasm）里跑真实的 SenseVoice-Small int8，读实时因子、加载、内存、置信度一致性，给 go / no-go。

预注册（指标 / 阈值 / 判定规则，**取数之前**提交）：`experiments/voice-client-asr-probe/PREREG.md`
（commit `7ea24479`，commit time `1791236783`，2026-10-06T05:46:23+08:00）。本文件的所有读数一律**填入**
预注册的阈值，不新增阈值、不改判定。

## 0. 结论（go / no-go）

**桌面浏览器 go。** T1–T4 **四项全通过**（见 §8）。默认（宿主不加 COOP / COEP → 单线程 SIMD）
实时因子 p90 = **0.1375**（阈值 ≤ 1.0）；`--isolated`（COOP / COEP → 4 线程）p90 = **0.0675**。
WASM 堆峰值 **590.2 MB**（阈值 ≤ 1.5 GB）。服务端置信度 ≥ 0.85 的 token 里，客户端**同位置同 token**
的一致率 **0.9706**（阈值 ≥ 95%）。

**移动（视口 + 4× CPU 节流）见 §6；真机（PC Windows Chrome、Android Chrome）见 §10：T4 / T3 通过，
T1 按原样读数「未过」**（p90 1.347 / 3.94），但两次都有**连续一段突然变慢再恢复**的干扰（疑为后台 / 熄屏降频，
未证实）；稳定段实时因子约 0.30 / 0.45。预注册不允许剔除数据，所以这里**不折算为通过**，也不据此翻转
桌面 Linux 的 go。真机的 T2、隔离臂、发热降频**没测**。

**宿主是否需要加 COOP / COEP：需要，但要单独评估代价。** 见 §9：加头把实时因子再降一半（2.04×），
代价是所有子资源要能过 `require-corp`、页面不能再用 `window.opener` / 弹窗通信、OAuth 回调式弹窗
受影响。这是**部署层的决策**，本探针只给读数。

### 0.1 go 的产物：后续「客户端 ASR 适配器」任务应包含的接口约束

本探针判 go，但**不写产品适配器**（预注册 §6）。后续任务按 §5.10「对设计的约束」实现时，
下面这几条是**本次读数直接支撑或直接要求**的：

1. **输出形状**：`{ text: string, tokens: [{ tok: string, p: number, t: number }] }` —— 与服务端
   `sv2/sv.jsonl` 的 `tokens` 同形。`t` 是**可直接对齐的轴**（两条路径都从丢弃前缀帧后的局部位起算），
   所以「同位置」不需要额外配准（§3）。
2. **`runsAt: 'client'` 与构建标识进日志**：`info().buildId`（本次为
   `ort-web 1.30.0 | sensevoice-small-int8-2024-07-17 | probe-v1 | sha256:c71f0ce00bec95b0`）
   连同模型 sha256 必须写进每条识别记录，用于定位「同一段音频在两条路径上读数不同」。
3. **一致的判据是置信度 ≥ 0.85 处，不是逐字相同**：本次 0.9706（T4）。适配器**不得**对文本做
   「必须与服务端逐字一致」的断言或重试 —— 46/60 的逐字一致率是模型的正常表现（§4）。
4. **置信度只保证「确定的位置」**：`p` 由 CTC 贪心在重复段上的最大 softmax 给出（丢弃 id 0 空白与
   `<|…|>` 特殊 token）。下游若拿 `p ≥ 0.85` 当「确定」，本次实测支持这个阈值的使用方式。
5. **缓存与首次加载**：模型 239 233 841 B（sha256 `c71f0ce0…`）经 Cache API 缓存，二次打开
   1.244 s（T2）；适配器要实现「首次下载 + 校验哈希 + 进度可见」，且**模型不进应用包**。
6. **单线程即可满足阈值**（p90 0.1375）；多线程（2.04×）作为可选部署开关（§9），不作为前提。
7. **回退**：客户端不可用 / 太慢时回退服务端。本次读数里没有「识别失败」这一类错误（60/60 都返回
   了结果），所以回退的触发条件**不是**本次测出来的 —— 它是设计需要，不是读数结论。

## 1. 方法与构建路径

两条候选（预注册 §1）：

- **(a) sherpa-onnx 官方 WebAssembly 构建 + `sherpa-patch/sv-logprobs-v1.13.8.patch`** — **未采用**。
  它要 emscripten 从源码构建；本机**没有 emscripten**，且 `sherpa-onnx` npm 包只随附 **nodejs** 构建
  （glue 依赖 node 的 `fs` / `require`，不能进浏览器），1.13.8 的 GitHub release 没有浏览器离线识别器
  （ASR）的预编译产物（只有 VAD / TTS / 语音增强）。这一条与 `ADR-003` 记的结论一致。
- **(b) onnxruntime-web 直接跑 `model.int8.onnx` + 自写前端** — **采用**。

被测实现是 `experiments/voice-client-asr-probe/probe.mjs` 的 `createProbe()`，由
`index.html` 在浏览器里用 `onnxruntime-web` 驱动。前端规格与 `experiments/voice-index-loop/sv/svlib.py`
（v5/v6 的「自写前端」）一致：fbank 80 维、hamming 窗、`snip_edges = true`、`dither = 0`、样本 ×32768、
LFR 7 / 6（左补 3 帧首帧）、CMVN 取自模型元数据 `neg_mean` / `inv_stddev`（**560 维**，按 LFR 维而不是
按 80 维）、丢弃前 4 个前缀帧、CTC 贪心 + log-softmax。`metadata_props` 由 `probe.mjs` 的最小 protobuf
读取器在**运行时**从模型读出（不预置常数）。

## 2. 环境与构建产物（`window.__probe.info()` 原文）

默认（无 COOP / COEP）与 `--isolated` 两臂各取一次，**逐字**记录：

```json
// 默认，单线程
{"crossOriginIsolated":false,"wasmSimd":true,"threads":1,"runtime":"ort-web",
 "buildId":"ort-web 1.30.0 | sensevoice-small-int8-2024-07-17 | probe-v1 | sha256:c71f0ce00bec95b0",
 "sharedArrayBuffer":false,"hardwareConcurrency":128,"ortVersion":"1.30.0","modelBytes":239233841,
 "modelSha256":"c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51","modelSource":"network",
 "userAgent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36"}

// --isolated（COOP: same-origin + COEP: require-corp）
{"crossOriginIsolated":true,"wasmSimd":true,"threads":4,"runtime":"ort-web",
 "buildId":"ort-web 1.30.0 | sensevoice-small-int8-2024-07-17 | probe-v1 | sha256:c71f0ce00bec95b0",
 "sharedArrayBuffer":true,"hardwareConcurrency":128,"ortVersion":"1.30.0","modelBytes":239233841,
 "modelSha256":"c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51","modelSource":"network",
 "userAgent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36"}
```

模型元数据（`window.__probe.meta()`，运行时从 `metadata_props` 读出）：

```json
{"lfr_window_size":7,"lfr_window_shift":6,"normalize_samples":1,"vocab_size":25055,"model_version":1}
```

固定产物与哈希：

| 产物 | 版本 | 字节数 | sha256 |
|---|---|---|---|
| `model.int8.onnx` | sense-voice-zh-en-ja-ko-yue **2024-07-17** | 239 233 841 | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `tokens.txt` | 同上 | 315 894 | — |
| onnxruntime-web（npm tarball） | **1.30.0** | — | `d2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71` |
| `ort-wasm-simd-threaded.wasm`（tarball 内） | 1.30.0 | 14 MB | `3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2` |

浏览器：HeadlessChrome 153.0.8010.12（Playwright chromium-1243 驱动，`--no-sandbox --disable-dev-shm-usage`）。
宿主：Linux 6.8.0-124，128 逻辑核。**取数走 `page.evaluate` 在真实浏览器里调 `window.__probe`** —— 等价于
MCP 浏览器工具的 `browser_navigate` + `browser_evaluate`（会话里没有暴露 MCP 浏览器，用 Playwright 库驱动
同一套 Chromium）。

### 取得每项读数所用的 evaluate 调用摘要

逐条记在读数 JSON 的 `evaluateCalls` 里，四条臂相同：

| 读数 | 调用 |
|---|---|
| 探针页就绪 | `browser_navigate http://127.0.0.1:PORT/`，等 `window.__probeReady === true` |
| 环境（§2 info 原文） | `browser_evaluate () => window.__probe.info()` |
| 模型元数据 | `browser_evaluate () => window.__probe.meta()` |
| 逐片段 `text/tokens/ms/audioSec` + 堆 | `browser_evaluate async () => { const t=performance.now(); const r=await window.__probe.run('/clips/<id>.wav'); return {...r, wall:performance.now()-t, audioSec:r.audioSec, stats:window.__probe.stats()}; }`（对 60 个 id 各一次） |
| 首次加载耗时 | `browser_evaluate () => window.__probe.readyMs`（冷，模型走网络） |
| 二次加载耗时 | 页面 reload 后再 `browser_evaluate () => window.__probe.readyMs`（热，模型走 Cache API） |
| 负控制 | `browser_evaluate () => window.__probe.runSamples(new Float32Array(0))` 与 `new Float32Array(16000*2)` |
| WASM 堆峰值 | 每次 run 后 `browser_evaluate () => window.__probe.stats().wasmHeapBytes`，取 max（`index.html` 里 patch 了 `WebAssembly.Memory` 收集实例） |

`--isolated` 臂 = 服务端加 `--isolated` 后重复以上全部；移动 / 节流臂 = 建 `BrowserContext` 时给
`viewport: {width:390,height:844}`，节流臂再经 CDP `Emulation.setCPUThrottlingRate {rate: 4}`。

## 3. 前端忠实性（取数前置）

按预注册 §1 / §4，JS 前端必须先与 Python `svlib.py` 逐帧 / 逐 token 对齐，**不一致就不取数**。
用 `svlib.py` 的同一 `kaldi_native_fbank` oracle 在片段 `1.wav` 上导出中间量，与 JS 版逐个比较：

| 层 | oracle | JS | 一致 |
|---|---|---|---|
| fbank 帧（410 帧 × 80 维） | `kaldi_native_fbank`（svlib.py 同参数） | `probe.mjs#fbank` | `max|Δ| = 0`（逐位相等） |
| LFR + CMVN 特征（560 维） | svlib.py | `probe.mjs#lfrCmvn` | `max|Δ| = 1.7e-5`（float32 舍入） |
| token 序列（`tok` + `t`，片段 1 前 6 个） | `sv2/sv.jsonl` | 浏览器 `window.__probe.run` | 逐个相同：`检/t=4 查/t=7 we/t=12 b/t=15 ▁server/t=18 进/t=25` |
| token 总数（片段 1） | 17（服务端，`p≥0.85` 记 17） | 18（客户端） | 差 1 —— 见 §4「文本层差异」 |

`t` 是可直接对齐的轴：两条路径的 `t` 都从丢弃前缀帧后的局部位起算，所以「同位置」= 同 `t`，不需要
额外配准。前端三个关键参数（DC 去除打开、预加重首样点用自身、mel 不做归一化）就是由这组对照钉住的：
错一个，fbank 的 `max|Δ|` 从 0 跳到 4.92。

## 4. 主读数：默认（单线程 SIMD，无 COOP / COEP）

同一批 **60** 条片段（`sv2/sv.jsonl` 里 `v3:<N>` 且磁盘有 `<N>.wav`，按 id 升序取前 60；固定集合），
同一台机器，同一次会话内跑完（配对比较，不跨运行）。总音频 **532.7 s**。

| 读数 | 值 |
|---|---|
| 实时因子 p50 | **0.12878** |
| 实时因子 p90 | **0.13754** ← T1 |
| 实时因子 max | 0.14903 |
| 实时因子 mean | 0.12972 |
| 聚合实时因子（Σ解码 ÷ Σ音频） | 0.1319（70.2 s / 532.7 s） |
| 首次加载 → 可识别（冷） | wall 2377 ms（`readyMs` 2334.9；模型下载 989.8 ms，会话创建 1123.7 ms） |
| 二次打开 → 可识别（热，模型来自 Cache API） | **1244.4 ms** ← T2 |
| WASM 堆峰值 | **590.2 MB**（618 856 448 B）← T3 |
| 置信度一致率（≥0.85 的服务端 token 中同 `t` 同 token） | **0.9706**（1847 / 1903）← T4 |
| 文本逐字相同 | 46 / 60 = 0.7667 |
| 客户端 token 总数 vs 服务端 | 2227 vs 2224 |

**T1–T4 全部通过**（默认臂）。

### 文本层差异（描述，不设阈值）

逐字相同的 46 / 60；14 条不同里，**9 条只差标点**（例：客户端 `检查web server进程，确认其监听的IP port。`
vs 服务端 `检查web server进程确认其监听的IP port。` —— 同一串 token，客户端在某帧给出逗号），
**5 条是内容差异**，且都是**同一个字被替换或吃掉**的邻位情形：

| id | 客户端 | 服务端 |
|---|---|---|
| 49 | 请继续**指**回复second下划线… | 请继续**只**回复second下划线… |
| 100 | P **the** loop test下划线command… | P **的** loop test下划线command… |
| 129 | contextwin**d** per profile test… | contextwin per profile test… |

这与 §5.10 的预期一致：同一模型换编译 / 浮点路径后，**文本不会逐字相同**，差别落在不确定的位置。
T4 只要求「服务端置信度 ≥ 0.85 的 token 在确定的位置上与客户端一致」——这条过了 0.9706。

## 5. `--isolated`（COOP / COEP → 4 线程 SIMD）

同样的 60 条，同样的机器，同一次会话；`serve.mjs --isolated` 给所有响应加
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
(+ `Cross-Origin-Resource-Policy: same-origin`)，页面因此 `crossOriginIsolated = true`、
`SharedArrayBuffer` 可用，onnxruntime-web 起 4 个线程。

| 读数 | 单线程（默认） | 4 线程（`--isolated`） | 比值 |
|---|---|---|---|
| 实时因子 p50 | 0.12878 | **0.05836** | 2.21× |
| 实时因子 p90 | 0.13754 | **0.06748** | **2.04×** |
| 实时因子 max | 0.14903 | 0.08867 | 1.68× |
| 聚合实时因子 | 0.1319 | 0.0580 | 2.27× |
| WASM 堆峰值 | 590.2 MB | 591.3 MB | ≈ 持平 |
| 首次加载 wall | 2377 ms | 2356 ms | ≈ 持平 |
| 二次打开 `readyMs` | 1244.4 ms | 1692.4 ms | 4 线程稍慢（线程池初始化） |

token 序列、T4 一致率（0.9706）、文本逐字（46 / 60）在两臂**逐条相同** —— 多线程只改速度，不改结果。

## 6. 移动视口 390×844 与 4× CPU 节流

视口（390×844）只改布局，不改 wasm 的线程数或指令路径；4× CPU 节流（CDP
`Emulation.setCPUThrottlingRate {rate: 4}`）改的是这台机器的 CPU 供给，用来近似一台慢一个档的手机。

| 读数 | 桌面（默认视口） | 视口 390×844 | 视口 390×844 + 4× 节流 |
|---|---|---|---|
| 实时因子 p50 | 0.12878 | 0.13277 | **0.54030** |
| 实时因子 p90 | 0.13754 | 0.15516 | **0.62617** |
| 实时因子 max | 0.14903 | 0.18652 | **0.69366** |
| 聚合实时因子 | 0.1319 | 0.1356 | **0.5649** |
| WASM 堆峰值 | 590.2 MB | 590.2 MB | 590.2 MB |
| 二次打开 `readyMs` | 1244.4 ms | 1276.5 ms | **5537.6 ms**（会话创建 4003.1 ms 被同样放慢 4×） |
| T4 一致率 | 0.9706 | 0.9706 | 0.9706（逐条相同） |

视口臂的实时因子与桌面臂同一量级（+13%），说明**布局与解码两条路互不干扰**。节流臂：p90 = 0.6262
恰好是未节流移动臂 0.15516 的 **4.03×**，与 `setCPUThrottlingRate(4)` 的比例一致 —— 这条读数支持
「整条解码路径是 **CPU 密集且可线性缩放**」的结论，也说明节流器确实生效了（否则会看到 ≈1×）。

节流臂仍是**同一台机器按比例放慢 CPU**，不是真机 —— **不能替代真机**（真机还有内存上限、发热降频、
iOS Safari 的 JIT 差异，以及节流器不模拟的**单核峰值性能**差异）。真机一节见 §10。
注意 **p90 = 0.6262 仍在阈值 1.0 以内**，所以「桌面 go」的判定对 4× 慢 CPU 也不翻转。

## 7. 负控制

按预注册 §4：把片段换成静音 / 空数组时，探针必须返回**空** token 序列，而不是崩溃或返回缓存的文本。

| 输入 | 客户端返回 | 判定 |
|---|---|---|
| `Float32Array(0)`（0 样点） | `{text: "", tokens: []}` | 通过（0 token） |
| 2 s 全零（静音） | `{text: "그.", tokens: [2 个]}` | **不为空** —— 见下 |

**静音臂诚实地记成「不为空」**：模型对纯静音吐了 2 个 token（韩文 `그.`）。这**不是缓存 bug** ——
读数里 `silenceIsCachedText = false`，即这串文本**不在**本批 60 条的任一输出里，是模型的幻觉（同一段
静音在服务端路径上也会取决于编译而定地吐/不吐东西）。所以这条负控制的**具体形态**是：
「空数组 → 空 token」通过；「静音 → 空 token」**不成立**，且**可重复**（三个臂逐字相同）。
真正的价值在于：它证明「返回了文本」不可能是缓存命中 —— 输出与语料里任何一条都不同。

## 8. go / no-go 表

| # | 指标 | 阈值 | 单线程（默认） | 4 线程（`--isolated`） | 判定 |
|---|---|---|---|---|---|
| T1 | 实时因子 p90 | ≤ 1.0 | 0.13754 | 0.06748 | **通过** |
| T2 | 二次打开到可识别 | ≤ 10 s | 1.244 s | 1.692 s | **通过** |
| T3 | WASM 堆峰值 | ≤ 1.5 GB | 590.2 MB | 591.3 MB | **通过** |
| T4 | ≥0.85 置信度 token 一致率 | ≥ 95% | 0.9706 | 0.9706 | **通过** |

按预注册 §3：**T1–T4 全部通过 = go**。桌面浏览器（Chromium）**go**。移动臂（§6）在视口下 p90 = 0.1552、
在 4× CPU 节流下 p90 = 0.6262，**都未触到阈值 1.0**；但按预注册 §5 第 6 条，真机由人补测（读数见 §10：T1 按原样未过，T3 / T4 通过，T2 未测），
本文件的 go **不含真机**。

按预注册 §3 的 go / no-go 规则，只有「仅 T1 在移动视口 / 节流下不通过而桌面通过」才需要判
「桌面 go、移动待真机」；本次视口 / 节流臂都通过，所以该分支不适用于模拟臂 —— 移动端的判定**以 §10 的真机读数为准**。

## 9. COOP / COEP 建议与代价

**读数**：加 `COOP: same-origin` + `COEP: require-corp` 把实时因子 p90 从 0.13754 降到 0.06748
（**2.04×**），内存基本不变。对「边录边识别、要即时上屏」这个用例，2× 不是决定性的（0.14 已经远低于
1.0）；它的价值主要在**长片段的尾延迟**（max 0.149 → 0.089）与**移动端 CPU 更弱时的余量**。

**代价**（选择性地，不是全部）：

1. `require-corp` 要求**所有**子资源（图片 / 字体 / 脚本 / 媒体）要么同源、要么带
   `Cross-Origin-Resource-Policy: cross-origin` 或过 CORS。若应用里有第三方 CDN 资源，要逐条加头。
2. 跨源隔离会**切断** `window.opener` / `document.domain` 一类的同源复用；弹窗 OAuth 回调、
   嵌入式 iframe 通信要重新审。
3. 一旦加错（漏一条子资源），页面会**整块白屏**而不是降级 —— 它没有「自动退回单线程」这个中间态：
   头在 → 隔离；头不在 → 单线程。所以落地的形态通常是**两条部署配置**（隔离版 / 普通版），
   由能力探测选，而不是一处改全局。

**建议**：D2 的产品实现**先按单线程（不加头）落**，因为 0.1375 已满足阈值；把 COOP / COEP 作为
**可选的部署开关**，在「长片段 / 移动端」被实测证明需要时再打开。若要打开，必须按上面第 1、2 条
逐条核过子资源与弹窗路径 —— 这是本探针**没有**测的（本探针只有同源资源）。

## 10. 真机读数（yale 补测）

经公网 HTTPS（Cloudflare tunnel → 本机 `serve.mjs`）打开探针页，点「跑 60 条并上传」，结果由页面 POST 回
服务端（`.cache/device-readings/`，git-ignored）。同一批 60 条、同一模型哈希；T4 对照 `sv2/sv.jsonl` 重算。
**两台设备都只测了单线程（无隔离）臂**，且都是首次加载（`modelSource = network`），**没有测 T2**。

| 项 | 桌面 Linux 无头（§4） | PC · Windows Chrome 154 | 手机 · Android 10 Chrome 154 |
|---|---|---|---|
| 逻辑核 / 线程 | 128 / 1 | 16 / 1 | 8 / 1 |
| 实时因子 p50 | 0.129 | 0.303 | 0.465 |
| 实时因子 p90（T1） | 0.138 | **1.347** | **3.940** |
| 实时因子 max | 0.149 | 2.191 | 4.417 |
| 稳定段实时因子 | — | 0.28–0.33 | 0.44–0.47 |
| WASM 堆峰值（T3） | 590.2 MB | 590.2 MB | 590.2 MB（未被杀） |
| T4 一致率 | 0.9706 | **0.9706** | **0.9706**（均 1847 / 1903，逐位同） |
| 会话创建 | 1.1 s | 52.4 s | 81.4 s |
| 首次加载（下载） | 2.4 s | 655 s（602 s） | 530 s（446 s） |
| T2 二次打开 | 1.244 s | 未测 | 未测 |

**T1 按原样读数：两台真机都未过**（1.347 / 3.940 > 1.0）。但分布是**两段式**，不是均匀慢：

- PC：60 条里第 11–31 条前后连续 1.1–2.2，其余稳定在 0.28–0.33。
- 手机：稳定在 0.44–0.47（偶尔 0.5–0.7），另有 10 条在 1.9–4.4，集中成三组（第 15–19、43–45、54–55 条），
  之后立刻恢复，慢约 9 倍。

这种「整段连续变慢、随后自行恢复」的形态与单条片段难度无关，更像外部干扰。手机一次，yale 记录**中途有熄屏**；
PC 一次**没有记录**干扰来源。页面当时没有记录 `visibilityState`，所以**干扰原因是推测，不是读数**。
稳定段的 0.30 / 0.45 约为桌面 Linux 的 2.3× / 3.5×，与 §6 的 4× 节流预测（p90 0.63）同一量级。

**判定**：T4、T3 在真机通过；T1 按预注册「不剔除」口径未过，**不折算为通过**。这不翻转 §8 桌面 go（那是
Linux 无头 Chromium 的读数）。真机的结论只能是：能装下、能跑完、结果与服务端一致；不被打断时有约 2 倍余量；
被打断（熄屏 / 后台）时会慢一个量级，**最坏情形超过阈值**。对「边录边识别」这类用例，这意味着客户端路径
**必须有回退到服务端的条件**（§0.1 第 7 条），且回退的触发不能只看平均速度。

**没测的**：T2（二次打开）、隔离臂（`probe-iso`）在真机上的可用性、连续 10 分钟的发热降频、锁屏后解码是否
继续（只间接看到熄屏时变慢，不知道是被挂起还是降频）。

### 10.1 真机测试方法（复现）

```sh
cd experiments/voice-client-asr-probe
# 公网访问：长期运行用 systemd 用户单元，不要 nohup（会话 scope 轮换会连带杀掉子进程）
systemd-run --user --unit=voice-probe-8791 --working-directory=$PWD node serve.mjs --host 172.17.0.1 --port 8791
systemd-run --user --unit=voice-probe-8792 --working-directory=$PWD node serve.mjs --host 172.17.0.1 --port 8792 --isolated
# 再在 tunnel 里把域名映射到这两个端口；页面必须经 HTTPS（或 localhost）打开，否则 crypto.subtle 不存在
```

页面提供「跑 60 条并上传」按钮与下载进度条；模型 239 MB，上行带宽约 0.4 MB/s 时首次加载约 10 分钟。
注意：8791 / 8792 是不同的源，Cache API 互相独立。**探针服务没有任何访问保护**（`/clips/` 是语音语料，
`POST /result` 可写），测完应撤掉 tunnel 映射与 DNS 记录并停服务。

## 11. 未解释 / 未验证

- **静音导致幻觉**（§7）：模型对纯静音吐 2 个 token。原因未定位（可能是 CTC 在无语音帧上的
  短时噪声输入），**不影响 go 判定**（空数组为 0 token），但它是「用返回文本非空来判断有没有语音」
  这条路不能走的证据。
- **文本层 5 条内容差异**（§4）：只观察到「同音 / 形近字替换」的形态，**没有**定位到是 int8 量化、
  编译路径还是浮点归约顺序导致的。T4 的一致率是为这一类差异设的容差，不是对它的解释。
- **`--isolated` 二次打开反而慢**（1.69 s vs 1.24 s）：多线程的线程池初始化落在 `readyMs` 里，
  未拆开定位；对 T2 的 10 s 阈值无影响。
- **节流臂的准确性**：4.03× 与 4× 节流率一致，说明**这台机器上**解码近似纯 CPU 线性；但它**没有**
  模拟真机的内存带宽瓶颈、小核调度、或热降频后的**非线性**变慢。真机的 p90 可能比 0.6262 更差，
  也可能更好（真机 CPU 更强 / 更弱）—— 这条读数**只证明「慢 4 倍仍过阈值」**，不预测真机。
- **真机的干扰来源**（§10）：两台真机的 T1 都出现连续变慢再恢复；手机有熄屏，PC 无记录；页面当时没记
  `visibilityState` / Wake Lock，所以无法区分「后台降频」「省电降频」「被挂起」。
- **真机仍未测**：T2、隔离臂、发热降频、锁屏后解码是否继续。
- **真机会话创建很慢**（52 s / 81 s，对比桌面 1.1 s）：未拆开定位；它在首次加载里，用户感知明显。
- **本探针没有实现客户端 ASR 适配器**（不在任务边界内，预注册 §6）：它只证明「能跑、多快、多大、
  一致性多少」，不证明「接进产品后 VAD 切段 + 上屏的端到端延迟」。

## 12. 复现

```sh
cd experiments/voice-client-asr-probe
# 1) 取 onnxruntime-web 1.30.0 到 .cache/（见 README.md 的两行 curl/tar）
# 2) 起服务（默认单线程；--isolated 4 线程）
node serve.mjs            # http://127.0.0.1:8791
node serve.mjs --isolated
# 3) 用真实 Chromium 打开，控制台：
#    window.__probe.info() / meta() / stats()
#    await window.__probe.run('/clips/1.wav')
```

读数 JSON（60 条 × 每条）落在 `.cache/readings-*.json`（git-ignored），本文件的表格全部由它们重算。
工装 `experiments/voice-client-asr-probe/` 只测不改：**不动 `src/`、`server/`、`shared/`**，
**不入库模型权重 / 音频 / 构建产物**（`git ls-files experiments/voice-client-asr-probe` 里没有任何
`.onnx / .wav / .wasm / .bin`）。

## 13. 产品实现的接线（`gap-voice-client-asr-wasm-adapter` 交付，供 §10 真机复核启用）

本节只写「怎么把客户端路径打开」，**不含任何读数**——真机的读数按 AC 由 yale 写进 §10。

- **开关是选识别器，不是一个新开关。** 在设置页把识别器选成 `sensevoice-wasm`（`locality: 'local-client'`）才走客户端路径；选别的仍完全不碰。客户端路径下，是否出麦克风由服务端的就绪读数决定（见下），模型还没下载也算可用，否则首下 8–10 分钟里麦克风会被误藏。
- **交付面是一个目录路径，没有构建期变量。** `onnxruntime-web@1.30.0` 是本仓库的**精确版本依赖**，服务端从 `node_modules` 解析它的三个文件，同源提供在 `/voice-client/ort/<file>`；模型与 `tokens.txt` 放在**一个目录**里，由 `VOICE_CLIENT_MODEL_DIR` 指定、未设置时回退到 `SENSEVOICE_MODEL_DIR`，服务端同源提供在 `/voice-client/model/<file>`（白名单只这两个文件名，不支持目录穿越，支持 Range，不要求登录）。前端用 `import.meta.env.BASE_URL` 前缀拼出这些固定路径，子路径部署也成立。下载地址、字节数与 sha256 见 `docs/operations/voice-client-asr-deployment.md`。
- **可用性由服务端告知，不是先下 239 MB 再发现缺文件。** `GET /api/voice/client-assets` 回报目录是否配置、两个文件是否存在、`model.int8.onnx` 是否 239 233 841 B；`useVoiceAvailable` 读它的 `ready`（未就绪就不出麦克风），适配器据此返回 `ENGINE_UNAVAILABLE`，原因文案同时含目录变量名与文档路径，且**不发起任何对 `/voice-client/model/` 的下载请求**。
- **首次下载与二次打开怎么读**：下载**先校验 sha256、后写 Cache API**（探针那版是先写后校验，本实现在产品里补上了）；之后每次打开先读缓存并重新校验哈希，命中则**零网络请求**。进度与降级提示从 `observeVoiceClientAsrEngine({ onProgress, onNotice })` 取（`useVoiceAvailable` 只是个布尔，不看进度）。
- **两条回退怎么人为触发**（都先在 `window` 上发一条 `voice-client-asr:fallback` 事件，不静默）：引擎不可用——把 `VOICE_CLIENT_MODEL_DIR` / `SENSEVOICE_MODEL_DIR` 指向一个缺文件的目录，或让页面拿不到 `caches` / `crypto.subtle`（非 HTTPS 打开）；单条片段太慢——把页面 CPU 压到 §6 那个量级，让**某一条**片段的实时因子超过 1.0，其余片段仍留在客户端（判据按片段，不按平均）。
