---
id: GOAL-010
title: 语音识别的服务端捕获：由服务端环境变量选择 off、text、audio 三档，记录每次转写的原始返回与结果，默认关闭
status: achieved
kind: goal
origin: docs/proposals/voice-capture-server-side.md（2026-09-24 人 yale 裁定：三档
  off/text/audio、只在服务端配置、默认 off、无保留期与大小限制、音频目录不清理、AC-141 的转写正文条款错误需修订）
activatedAt: 2026-09-24T11:17:02.397Z
statusLog:
  - at: 2026-09-24T11:17:02.397Z
    from: draft
    to: active
    actor: claude-session
    reason: 人 yale 2026-09-24 裁定：按提案 docs/proposals/voice-capture-server-side.md 激活
  - at: 2026-09-27T16:06:42.650Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

2026-09-24 GOAL-009 收口后的真机使用暴露了一个诊断缺口。页面语音输入报 404 时，服务端日志只有一行 voice.transcribe 的状态与耗时，原因（页面每次转写都带共享 backend 的 x-voice-stt-model，被当作模型名发给了 DashScope）只能靠人为重放同样的请求头才确认。两次成功的输入则完全无法复盘：录音、模型给出的 transcript 与 instruction 两份文本、最终写进 composer 的文本，服务端都没有留下。

现有日志行是按形状保证没有自由文本的，AC-141 当时选了这种保证，代价是同时排除了一切诊断内容。人 yale 2026-09-24 裁定：key 明文不进日志是对的，转写正文不进日志是错的；服务端应当记录语音识别的过程，并支持开关控制。设计见 docs/proposals/voice-capture-server-side.md。

## 范围

- 新增服务端捕获通道，由环境变量 VOICE_CAPTURE 选择 off、text、audio 三档；未设置时为 off，无法识别的值按 off 处理并在启动时告警；启动时打一行生效模式。
- text 档：每次转写尝试（成功、上游失败、预检拒绝）在现有 voice.transcribe 行之后多打一行 voice.capture，单行 JSON，走同一个 log.info，含 captureId、实际使用的模型、上传的 mime、字节数与 sha256、上游状态与原始返回文本、结果分支与返回给调用方的文本；原始返回超过 64 KB 时截断并标记 truncated。
- audio 档：在 text 档之上，把上传的录音原样写成文件，目录默认 ~/.cloudcli/voice-capture/（与数据库同级，目录 0700、文件 0600），可用 VOICE_CAPTURE_DIR 覆盖，不做清理。
- 捕获接在服务已经注入的传输端口之外与 logAttempt 这个唯一出口上，三个识别 provider 自动覆盖，适配器与 registry 契约不改；捕获的任何失败都不影响转写。
- 修订 AC-141：去掉其 expect 与测试 needles 里的转写正文条款，key、Bearer 形式、音频 base64 三类保留。

## 非目标

- 不做设置页、用户级开关、健康负载暴露，不做任何客户端回报或查看页面。
- 不做保留期、总量上限、自动清理，不为 audio 档做定时失效。
- 不记上游请求体与请求头；不覆盖朗读。
- 不在应用里改变 server.log 的权限、轮转或重启覆盖行为。
- 不记录前端在转写之后做的处理（裁剪、标识符修复、用户对 composer 的编辑）。

## 退出条件

- AC-143 关闭态：未设置、off、非法值三种情形下，日志与基线逐字节相同、不建目录，非法值告警并按 off，启动行读出生效模式；同一测试里 text 档必须出现捕获行。
- AC-144 text 档：成功、上游失败（重放 404）、预检拒绝各有一行捕获，含实际模型、原始返回逐字、结果分支与文本，无请求体与请求头，无文件，64 KB 截断带标记。
- AC-145 audio 档：文件字节、sha256、权限与路径成立，text 档零文件，不清理。
- AC-146 机密：任何一档下 key 明文、Bearer 形式、音频 base64 都不出现在任何日志行或捕获文件里，且这些值确实经过了传输层。
- AC-147 隔离：捕获失败不影响转写的结果、状态与文本，只多一行不含内容的失败记录。
- AC-148 真实进程：真实服务进程按环境变量启动后，标准输出里出现启动行与对应的捕获行；未设置时没有。

## 不做退出条件的范围内事

- AC-141 的修订（其记录的 expect 与测试 needles）：它修的是一条被人裁定为错误的条款，属于本目标的第一个任务，不另设判据；key、Bearer、音频 base64 三类的取假形态仍由 AC-141 自己的测试与 AC-146 承担。
- 提案文档的文字质量属于人读范畴。
- 启动命令如何重定向 server.log（是否用追加）是部署方的事，不进判据。

## 已知不等价点与限制

- text 档会把口述内容写进 server.log，该文件权限现为 664（组可读）；audio 档的目录与文件是 0700 与 0600。
- server.log 随每次重启被覆盖，除非启动命令用追加；本目标不改变这一点。
- 捕获行没有用户 id，多用户部署下无法按用户区分。
- 模式只能靠重启服务修改。
- 捕获的是服务端看到的内容，不等于用户最终发出的文字。
- 全部判据跑在 Node 与替身上游下，不等于真实 DashScope。
