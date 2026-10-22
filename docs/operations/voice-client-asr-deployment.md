# 浏览器端语音识别（`sensevoice-wasm`）部署说明

本文只讲**怎么让浏览器端识别可用**：把两个模型文件放进一个目录，服务端同源提供给浏览器，
`onnxruntime-web` 随项目分发。**不需要自己托管任何 URL，也不需要设置任何构建期变量。**

配置面只有一处：一个**目录路径**（不是 URL），与在-host 识别器用的
`SENSEVOICE_MODEL_DIR` 是同一个约定。

- 想用浏览器端识别：设置 `VOICE_CLIENT_MODEL_DIR`，或在多数部署里什么都不设（见下）。
- 想用在-host（服务端）识别：设置 `SENSEVOICE_MODEL_DIR`。

两者指向同一个目录即可，服务端会同时供两条路径使用。

---

## 1. 要下载的两个文件

从 HuggingFace 仓库 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
**按文件单独下载**（不要下 GitHub release 的 tar.bz2，它有 1.05 GB，为了 239 MB 不值得）：

| 文件 | 下载地址 | 字节数 | sha256 |
| --- | --- | --- | --- |
| `model.int8.onnx` | `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx` | 239 233 841 | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `tokens.txt` | `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt` | 315 894 | （前端不校验 tokens 的哈希） |

命令行：

```sh
# 随便放一个目录，例如 /opt/sensevoice-model
curl -L -o model.int8.onnx \
  https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx
curl -L -o tokens.txt \
  https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt

# 校验模型字节数与哈希（前端下载后也会按这两个值再校验一次）
wc -c model.int8.onnx                      # 期望 239233841
sha256sum model.int8.onnx                  # 期望 c71f0ce0…cd51
```

> 前端在**下载后、写入 Cache API 之前**校验 sha256 与字节数；校验不通过就不会缓存，
> 该片段直接回退到服务端。字节数或被截断、或不是这个 checkpoint，都会被拒。

---

## 2. 文件放到哪 / 用哪个变量

把两个文件放进**同一个目录**，然后：

- **推荐：什么都不设。** 服务端在 `VOICE_CLIENT_MODEL_DIR` 未设置时**回退到
  `SENSEVOICE_MODEL_DIR`**。如果这台主机已经在跑在-host 识别器，那个目录里**已经有**这两个
  文件，浏览器端识别直接可用。
- 想单独给浏览器端一个目录：设置 `VOICE_CLIENT_MODEL_DIR=/path/to/dir`。它会**优先于**
  `SENSEVOICE_MODEL_DIR`。

```sh
# 单独给浏览器端一个目录（可选）
VOICE_CLIENT_MODEL_DIR=/opt/sensevoice-model

# 或者什么都不设，让服务端回退到在-host 识别器的目录
SENSEVOICE_MODEL_DIR=/opt/sensevoice-model
```

服务端据此同源提供：

- `GET /voice-client/model/model.int8.onnx`
- `GET /voice-client/model/tokens.txt`

白名单只有这两个文件名，目录穿越（`../`、编码后的 `%2e%2e`）一律 404，支持 HTTP Range。
这两个路由**不需要登录**（与静态资源一致：模型是公开发布物，不含任何用户数据）。

`onnxruntime-web@1.30.0` 是本仓库的**精确版本依赖**，随 `npm install` 安装；
服务端从 `node_modules` 解析它的三个文件，同源提供：

- `GET /voice-client/ort/ort.wasm.min.mjs`
- `GET /voice-client/ort/ort-wasm-simd-threaded.mjs`
- `GET /voice-client/ort/ort-wasm-simd-threaded.wasm`（`Content-Type: application/wasm`）

这三个文件不需要部署方做任何事，也不需要版本变量。

---

## 3. 必须经 HTTPS（或 localhost）访问

浏览器端识别依赖 `crypto.subtle`（校验哈希）与 Cache API（缓存 239 MB 模型）。
这两个 API **只在安全上下文**（HTTPS，或 `http://localhost` / `http://127.0.0.1`）可用。
用普通 HTTP 打开远端页面时，引擎会判定不可用并回退服务端，原因文案会指向本文档。

反向代理只需把 `/voice-client` 一并转发到应用服务即可（与 `/api` 同级）。

---

## 4. 子路径部署

应用支持子路径部署（见 `docs/nginx-subpath-template.conf`）。前端把上述路径拼在
`import.meta.env.BASE_URL` 之后，所以子路径部署下 `tokens.txt` 的请求是
`https://host/<sub>/voice-client/model/tokens.txt`，无需额外配置。反向代理按同样的前缀转发。

---

## 5. 怎么知道配置好了

服务端的就绪读数在 `GET /api/voice/client-assets`（走现有登录鉴权）：

```jsonc
{
  "configured": true,
  "directory": "/opt/sensevoice-model",
  "source": "VOICE_CLIENT_MODEL_DIR",   // 或 "SENSEVOICE_MODEL_DIR"；未配置时为 null
  "model":  { "name": "model.int8.onnx", "present": true, "bytes": 239233841, "expectedBytes": 239233841 },
  "tokens": { "name": "tokens.txt",      "present": true, "bytes": 315894,    "expectedBytes": null },
  "ready": true
}
```

- `ready` 为 `true` 的唯一条件是：`model.int8.onnx` 存在**且字节数为 239 233 841**，且
  `tokens.txt` 存在。缺哪个就说缺哪个。
- 设置页把识别器选成 `sensevoice-wasm` 后，`useVoiceAvailable` 读这个读数：**`ready` 为
  `false` 时麦克风不会出现**，并且适配器返回 `ENGINE_UNAVAILABLE`，原因文案同时指出目录变量
  （`VOICE_CLIENT_MODEL_DIR` / `SENSEVOICE_MODEL_DIR`）与本文档路径，
  **不会去发起任何对 `/voice-client/model/` 的下载**。

---

## 6. 首次下载：先把时间算进来

**首次下载**要拉 239 233 841 字节（228.1 MiB）的 `model.int8.onnx`。下载耗时**完全取决于
浏览器到本服务器的出口带宽**，不是固定的几秒：

| 出口带宽 | 239 MB 首次下载的大致耗时 |
| --- | --- |
| 100 KB/s | 约 40 分钟 |
| 1 MB/s | 约 4 分钟 |
| 10 MB/s | 约 25 秒 |

本部署（`cloudcli.lrfz.com`）**实测约 100 KB/s**，所以首次下载要**数十分钟**（2026-10-06 实测，
见 `docs/experiments/2026-10-06-voice-client-asr-probe.md`）。设置面板会显示已下载 / 总字节、
实时速度（KB/s）与剩余时间，并在**选中该识别器时**就开始下载，所以这段等待是可以看见、也可以
提前开始的。

**下载期间片段走回退识别器。** 模型没就绪（`stopped` / `starting`）时，语音片段**立刻**交给
回退识别器（设置面板里选定的那个，或服务端自己的选择），不等 30 秒的单段超时，也不会出现
「服务端没有 `sensevoice-wasm` 引擎」的 503；回退原因（「模型仍在下载 / 尚未加载」及当前进度）
显示在设置面板上。下载在后台继续，完成后新的片段自动回到本机识别，无需刷新页面。

同一浏览器再次打开时，模型命中 Cache API、**零网络请求**；重新部署或改了目录（URL 变化）会
重新下载。

---

## 7. 相关文件

- 探针与真机读数：`docs/experiments/2026-10-06-voice-client-asr-probe.md`
- 环境变量样例：`.env.example`（`VOICE_CLIENT_MODEL_DIR`）
- 子路径模板：`docs/nginx-subpath-template.conf`


