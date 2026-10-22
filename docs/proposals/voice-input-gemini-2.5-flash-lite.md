# Gemini 2.5 Flash-Lite 语音输入 Proposal

状态：Proposal / 待评审

## 摘要

为 CloudCLI UI 增加基于 Google Gemini 2.5 Flash-Lite 的语音输入后端。
用户在聊天输入框按下麦克风按钮后录音，服务端将音频发送给 Gemini 做语音转写，
再把文本填回当前 composer，或按现有交互自动发送。该方案复用现有录音、输入框、
会话和消息发送链路，不把音频直接交给 Claude、Codex 或其他聊天 provider。

## 背景与现状

当前项目已经具备语音输入的前端流程：

- `src/modules/chat/hooks/useVoiceInput.ts` 使用 `MediaRecorder` 录制音频。
- `src/modules/chat/composer/VoiceInputButton.tsx` 提供录音按钮和录音中状态。
- `src/modules/chat/composer/ChatComposer.tsx` 支持将转写结果填入输入框或自动发送。
- `server/modules/voice/voice.service.ts` 当前通过 OpenAI-compatible
  `/audio/transcriptions` 接口完成转写。
- `src/modules/settings/tabs/VoiceSettingsTab.tsx` 提供语音开关、后端地址、API Key
  和模型配置。

当前实现没有 Gemini 原生 API 适配器。仅将 `sttModel` 改为
`gemini-2.5-flash-lite` 不能工作，因为 Gemini 使用 `generateContent` 和
`inlineData` / Files API，而不是 OpenAI 的 multipart transcription 协议。

## 官方能力约束

根据 Google 官方文档，`gemini-2.5-flash-lite`：

- 支持文本、图片、视频、音频和 PDF 输入，文本输出。
- 支持 WebM、WAV、MP3、M4A、OGG、Opus 等音频格式；现有浏览器 WebM 录音可复用。
- 小于 20 MB 的请求可使用 inline audio data；更大文件应使用 Files API。
- 音频按每秒 32 tokens 计费，一分钟约 1,920 tokens。
- 当前价格页显示音频输入为 `$0.30 / 1M tokens`，输出另计。
- 该模型适合录音结束后的转写，不应被当作实时双向语音模型。

官方参考：

- <https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite>
- <https://ai.google.dev/gemini-api/docs/audio>
- <https://ai.google.dev/gemini-api/docs/files>
- <https://ai.google.dev/gemini-api/docs/pricing>

## 目标与非目标

### 目标

1. 在不改变现有聊天输入交互的前提下支持 Gemini 语音转写。
2. 让管理员可以通过服务端环境变量启用 Gemini，避免在浏览器暴露共享 API Key。
3. 保留现有 OpenAI-compatible 语音后端，支持按 provider 选择。
4. 对音频格式、大小、超时、错误和配额进行明确处理。

### 非目标

- 本 proposal 不实现 Gemini Live 的实时语音对话。
- 本 proposal 不将原始音频保存进项目会话 transcript。
- 本 proposal 不替换现有聊天 provider；转写结果仍作为普通文本发送。
- 本 proposal 不要求 Gemini 负责文本转语音；现有 TTS 配置可以继续独立工作。

## 推荐架构

将语音后端从单一 OpenAI-compatible 实现抽象为 provider：

```text
POST /api/voice/transcribe
        |
        v
VoiceService
        |
        +-- OpenAICompatibleVoiceProvider
        |
        +-- GeminiVoiceProvider
```

前端继续上传字段 `audio`，服务端根据配置选择 provider，并统一返回：

```json
{ "text": "转写后的文本" }
```

这样 `useVoiceInput` 不需要知道 Gemini 的请求格式，录音结束后的 composer 行为也
保持不变。

## Gemini 请求设计

建议在服务端使用官方 `@google/genai` SDK；也可以使用 REST API。短音频请求的
内容应包含一个严格的转写提示和音频 part：

```json
{
  "contents": [{
    "parts": [
      {
        "text": "请准确转写这段音频。只输出转写内容，不要添加解释。"
      },
      {
        "inline_data": {
          "mime_type": "audio/webm",
          "data": "<base64 audio>"
        }
      }
    ]
  }]
}
```

实现细节：

1. 小于 20 MB 的音频使用 inline data。
2. 超过 inline 限制时上传到 Files API，并在 generateContent 中引用文件 URI。
3. 从第一个有效 candidate 的文本 part 提取结果，去除空白后返回统一响应。
4. 没有可提取文本时返回明确的 `NO_SPEECH_DETECTED` 或等价错误。
5. 不记录 base64 音频、完整请求体或 API Key。

## 配置建议

建议增加服务端配置：

```dotenv
VOICE_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_VOICE_MODEL=gemini-2.5-flash-lite
VOICE_TIMEOUT_MS=300000
```

兼容现有配置：

```dotenv
VOICE_PROVIDER=openai-compatible
VOICE_API_BASE_URL=https://api.openai.com/v1
VOICE_API_KEY=...
VOICE_STT_MODEL=whisper-1
```

`VOICE_PROVIDER` 未配置时应继续使用现有行为，避免升级后破坏已有部署。若产品
需要用户级 API Key，可在设置页增加 Gemini provider，但应明确提示该密钥保存在
浏览器本地，并优先推荐服务端配置。

## 前端变更范围

第一版不需要修改录音和发送流程，只需要在语音设置中：

- 增加 provider 选择项。
- 对 Gemini 显示模型名和 API Key 配置。
- 隐藏不适用于 Gemini 的 OpenAI TTS 字段，或明确标注其仍由独立 TTS 后端使用。
- 保持 `voiceEnabled` 开关和麦克风按钮行为不变。

如果采用纯服务端配置，前端只需要通过 `/api/voice/health` 获得
`{ configured: true, provider: "gemini" }`，无需读取密钥。

## 安全、可靠性与成本

- Gemini API Key 只在服务端环境变量或受控密钥系统中保存。
- 限制 MIME 类型、上传大小和最大录音时长；当前 25 MB Multer 限制需要与 Gemini
  的 20 MB inline 限制协调。
- 为转写路由增加认证、速率限制和并发限制。
- 为 Gemini 请求设置超时，并将 401、403、429、5xx 映射为用户可理解的错误。
- 不把音频写入会话 transcript；如果使用 Files API，应在处理完成后删除远端文件，
  或设置明确的清理策略。
- 上传音频到 Google 前，应在设置页或隐私说明中告知用户。
- 以 32 tokens/秒估算成本，并在异常长录音前给出限制或提示。

## 测试与验收标准

### 单元测试

- Gemini 请求包含正确的模型、提示、MIME 类型和音频数据。
- 正确解析正常文本响应、空响应和错误响应。
- provider 选择和默认回退行为正确。
- API Key 不会出现在日志和错误消息中。

### 集成测试

- WebM、WAV、M4A 等受支持格式可以转写。
- 小于 20 MB 走 inline data；大文件走 Files API 或被明确拒绝。
- Gemini 超时、限流和无语音结果能返回稳定错误。
- 现有 OpenAI-compatible provider 测试不回归。

### 浏览器验收

1. 开启语音输入并进入任意项目会话。
2. 点击麦克风，允许麦克风权限，录制一段短语音。
3. 停止录音后，转写文本出现在 composer 中。
4. 点击发送或使用自动发送，文本通过现有 WebSocket 会话发送。
5. Gemini 不可用时，UI 显示错误且不会丢失已有草稿。

## 分阶段实施

1. 增加 `GeminiVoiceProvider` 和服务端配置，先支持小于 20 MB 的 inline audio。
2. 为设置页增加 provider 选择和健康状态显示。
3. 增加 Files API 路径、清理策略、限流和完整错误映射。
4. 补齐单元、集成和浏览器测试，再考虑是否支持 Gemini TTS 或 Live API。

## 待确认问题

- Gemini API Key 是仅由部署管理员配置，还是允许每个用户自行配置？
- 是否需要保留用户自定义 OpenAI-compatible 后端？本 proposal 默认保留。
- 语音输入的最大时长和最大并发数是多少？
- 是否需要审计或保存转写原文？默认不保存原始音频，仅随会话发送转写文本。
