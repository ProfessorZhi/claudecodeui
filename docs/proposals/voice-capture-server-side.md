# 语音识别的服务端捕获：记录每次转写的原始返回与结果，由服务端环境变量选择三档

- 状态：active（对应 GOAL-010）
- 日期：2026-09-24
- 人的裁定（yale，2026-09-24）：
  1. 服务端应当记录语音识别的过程，并支持开关控制是否记录；AC-141 里「日志不含转写正文」的条款是错误的，必须修正（key 明文不进日志的条款是对的，保留）。
  2. 开关分**三档**：`off`、`text`、`audio`。
  3. 开关**只在服务端配置**（环境变量），不进设置页，不做任何额外的客户端交互。
  4. **未设置环境变量时默认 `off`。**
  5. 不为 `audio` 档做定时失效。
  6. 不单独做存储时间或大小的限制，与现有日志机制保持一致；音频目录不做清理。
  7. 音频目录默认 `~/.cloudcli/voice-capture/`（与 `auth.db` 同级，目录 0700、文件 0600），可用 `VOICE_CAPTURE_DIR` 覆盖。
  8. 单条记录里，上游原始返回超过 64 KB 时截断并标记 `truncated`；这只是防上游返回巨大网关页面的单行保护，不是存储限制。
  9. 接受两个后果并在此写明：`text` 档会把口述内容写进 `server.log`（该文件权限现为 664，组可读）；日志文件随每次重启被覆盖，除非启动命令用 `>>` 追加。
- 关联：GOAL-009（`docs/proposals/voice-dashscope-omni-written-instruction.md`）、AC-141（其转写正文条款由本提案修订）、`server/modules/voice/voice.service.ts`。

---

## 摘要

给语音识别的服务端加一条「捕获」通道。`VOICE_CAPTURE=off|text|audio` 决定每次转写尝试留下什么：`off` 什么都不留（与现在字节一致，也是默认）；`text` 在现有的 `voice.transcribe` 日志行之后多打一行 `voice.capture {…}`，含实际使用的模型、上游的原始返回文本和最终返回给页面的文本；`audio` 在此之上把上传的录音原样写成文件。

捕获走现有的日志通道（同一个 `log.info`），不引入保留期或大小限制。它只在服务端配置，页面对它无感知。

---

## 背景与证据

### 现在看不到「说了什么、返回了什么」

2026-09-24 GOAL-009 收口后的真机使用里发生了两件事，都暴露了同一个缺口：

1. **一次 404 靠复现才定位。** 页面语音输入报 404，服务端日志只有 `voice.transcribe providerId=dashscope-omni outcome=fail status=404 latencyMs=952`。原因（页面每次转写都带上共享 backend 的 `x-voice-stt-model`，被当作模型名发给了 DashScope）只能靠人为重放同样的请求头才确认。若日志里有上游返回的错误体，一行就能读出「模型不存在」。
2. **两次成功输入无法复盘。** 日志只有 `outcome=ok status=200 latencyMs=5283 promptVersion=…`：录音、模型给出的 `transcript` 与 `instruction` 两份文本、最终写进 composer 的文本，服务端都没有留下，无法分析「听到什么、改写成什么」。

### 现有日志行是按形状保证「没有自由文本」的

`logAttempt` 只写模块自己算出的字段（id、outcome、status、时长、`promptVersion`），所以 key、录音、转写正文都进不去。这是 AC-141 当时选的保证方式，代价是同时排除了一切诊断内容。

### AC-141 的一条条款是错的

AC-141 的 `expect` 写着「服务端日志中不含 key 明文与转写正文」，其测试 `voice-dashscope-settings.test.ts` 的 needles 里有 `SUCCESS_TRANSCRIPT` 与 `SUCCESS_INSTRUCTION`。人已裁定：key 不进日志是对的，转写正文不进日志是错的。本提案随之修订：key、Bearer 形式、音频 base64 三类保留，转写正文两项去掉。

### 日志文件的性质

`server.log` 是启动命令的 stdout 重定向，不是应用管理的文件：每次重启被覆盖（17:57 那条 404 因此丢失），权限 664，无轮转。这是「与现有日志机制保持一致」的自然后果，本提案不在应用里另做处理。

---

## 设计

### 配置

- `VOICE_CAPTURE=off|text|audio`，服务启动时读一次，与现有 `VOICE_*` 环境变量同一路径（`voice.module.ts` 的组装处）。
- 未设置为 `off`。无法识别的值按 `off` 处理（隐私上失败关闭），并在启动时打一行警告。
- 启动时打一行 `voice.capture mode=<生效模式>`。
- `VOICE_CAPTURE_DIR`：音频目录，未设时为 `<auth.db 所在目录>/voice-capture`。
- 不进设置页、不进用户设置文档、不进健康负载。修改需要重启服务。

### 三档

| 档 | 行为 |
|---|---|
| `off` | 与现在字节一致：不多一行日志，不写文件 |
| `text` | 每次转写尝试多一行 `voice.capture {…}`（单行 JSON，同一个 `log.info`）；同一次的 `voice.transcribe` 行多一个 `captureId=<uuid>` |
| `audio` | `text` 的全部，加上把上传的录音原样写成文件，`voice.capture` 行给出路径、字节数、sha256 |

### `voice.capture` 行的内容

- 身份：`captureId`、`providerId`、实际使用的 `model`、地址的主机名。
- 输入：`mime`、`bytes`、`sha256`（`audio` 档再加文件路径）。
- 上游：`status` 与**原始返回文本**（成功时含 `transcript` 与 `instruction` 两份，失败时是错误体）。超过 64 KB 截断并带 `truncated: true`。
- 结果：解析走了哪条分支（书面 / 逐字降级 / 无语音 / 信封错误）、返回给调用方的 `text`。
- 被预检拒绝的尝试（不受支持的容器、超预算、地址不合规）没有上游：`upstream` 为 `null`，其余照记。

**不记：** 上游请求体（它是「冻结提示词 + 模型 + 音频」的确定函数，`promptVersion` 与 `model` 已足够）、任何请求头、任何 key。

### 接入方式

- 服务本来就通过注入的 `fetchBackend` 端口发出所有上游请求。在这个端口外包一层，读取上游返回的副本；三个 provider 自动全部覆盖，适配器与 registry 契约不改。
- `transcribe` 里的 `logAttempt` 是所有路径的唯一出口，捕获挂在这里，不会漏路径。
- 新增 `capture` 依赖，与 `logger`、`fetchBackend` 并列：`text` 档复用同一个 logger，`audio` 档用一个 `writeAudio` 端口，默认实现由 `voice.module.ts` 组装。
- 捕获全部包在 try/catch 里：失败只打一行 `voice.capture failed`（不含任何内容），转写照常返回。
- 只针对语音识别（`transcribe`），不含朗读（TTS）。

---

## 判据（对应 GOAL-010 的 AC-143 至 AC-148）

| AC | 断言 | 取假形态 |
|---|---|---|
| AC-143 | 未设置、`off`、非法值三种情形下，成功与失败转写的日志与基线逐字节相同、不建目录；非法值告警并按 `off`；启动行读出生效模式。正例：同一测试里 `text` 档必须出现捕获行 | 不看模式一律记录；非法值当 `text` |
| AC-144 | `text` 档下一次成功与一次失败（重放 404）各有一行：`captureId` 与 `voice.transcribe` 行一致；含实际模型、原始返回逐字、结果分支与 `text`；预检拒绝也有一行；无请求体与请求头；无文件；64 KB 截断带标记 | 只记最终 `text`；失败不记；截断缺失或误标 |
| AC-145 | `audio` 档生成的文件字节与上传逐字节相同、sha256 与行内一致、目录 0700 文件 0600；`text` 档零文件；不清理 | `text` 档也写文件；内容被改动；权限过宽 |
| AC-146 | 三档下 DashScope key、共享 key、`Bearer` 形式、音频 base64 都不出现在任何日志行与任何捕获文件里，且这些值确实经过了传输层（正例） | 把请求头记进捕获；把 base64 记进捕获行 |
| AC-147 | logger 抛错、音频目录不可写时转写仍成功且文本不变；出现 `voice.capture failed` 一行且不含内容 | 捕获异常向上传播；失败行带出正文 |
| AC-148 | 真实服务进程用环境变量启动，发一次真实 HTTP，stdout 里读到启动行与对应的捕获行；未设置时没有 | 捕获只在单测的注入端口里成立，没有接进真实组装 |

---

## 任务拆分

1. **修订 AC-141：** 去掉 `expect` 里的转写正文条款，去掉测试 needles 里的两项；key、Bearer、音频 base64 三类保留，仍须能被取假形态打红。
2. **`text` 档核心：** `capture` 依赖、`fetchBackend` 外包、`logAttempt` 挂点、隔离、64 KB 截断（AC-144、AC-146 的 `text` 部分、AC-147）。
3. **配置与 `audio` 档：** 环境变量读取与启动行、`audio` 档写文件、真实进程判据（AC-143、AC-145、AC-148，AC-146 的 `audio` 部分）。

---

## 非目标

- 不做设置页、用户级开关、健康负载暴露，也不做任何客户端回报或查看页面。
- 不做保留期、总量上限、自动清理、`audio` 档的定时失效。
- 不记上游请求体与请求头；不覆盖朗读（TTS）。
- 不在应用里改变 `server.log` 的权限、轮转或重启覆盖行为。
- 不记录前端在转写之后做的处理（裁剪、标识符修复、用户对 composer 的编辑），那些只有页面知道。

## 已知限制

- `text` 档的口述内容写进 `server.log`，权限 664，组可读；`audio` 档的目录与文件是 0700/0600。
- 日志文件随重启被覆盖；要保留请用 `>>` 启动。
- 捕获行没有用户 id，多用户部署下无法按用户区分。
- 模式只能靠重启修改。
- 捕获的是服务端看到的内容，不等于用户最终发出的文字。
