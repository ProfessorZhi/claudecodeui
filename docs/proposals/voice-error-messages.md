# 语音识别失败时给出可行动的错误提示：稳定错误码、上游分类、本地化文案、持续显示

- 状态：active（对应 GOAL-011）
- 日期：2026-09-24
- 人的裁定（yale，2026-09-24，同意提案全部建议）：
  1. 反转「传输层读到的失败只带文字」的既有决定：`/api/voice/transcribe` 的**所有**失败都带稳定的 `code`。
  2. 账户类错误（未开通、欠费、授权失效）合成**一个** `ACCOUNT_ACCESS`，不拆「未开通」与「欠费」。
  3. 页面上的错误提示改为**持续显示**，直到用户关闭或开始下一次录音，并带一行折叠的技术详情；不再是 4 秒消失。
  4. **不做**上传前的静音检查。
  5. 建成新的 goal（GOAL-011），拆成 task 执行。
- 关联：GOAL-009、GOAL-010（`docs/proposals/voice-capture-server-side.md`）、ADR-004（错误码词汇表）、`server/modules/voice/voice.service.ts`、`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`、`src/modules/chat/hooks/useVoiceInput.ts`。

---

## 摘要

语音识别失败时，用户现在看到的是 `Transcription failed: transcribe 502`。服务端其实已经算出了可用的说明，前端却把它丢掉，只拼状态码；同一件事（没有语音）在两个地方还有两种说法；文案是硬编码的英文，且 4 秒就消失。

本提案建立一条完整的链路：适配器把上游的（状态、响应体里的错误码）分类为稳定的 `code`；服务端所有失败都返回 `code`（外加一个安全的 `upstreamCode`）；前端按 `code` 选取本地化文案，说明发生了什么与怎么办；提示持续显示，带折叠的技术详情。

---

## 背景与证据

### 2026-09-24 的三次真实失败

| 时间 | 页面上显示 | 真实原因 | 用户当时需要做什么 |
|---|---|---|---|
| 17:57 | `Transcription failed: transcribe 404` | 页面每次转写都带共享 backend 的 `x-voice-stt-model`，被当作模型名发给了 DashScope（我们的缺陷，已修） | 无法自己处理；应当被告知是模型名问题 |
| 19:3x | `transcribe 502` | 上游 403 `AccessDenied.Unpurchased`；充值后恢复 | 到阿里云控制台开通或充值 |
| 20:2x | `transcribe 422` | 模型给出空答案（多半录音里没有语音）；服务端日志里连续两条 | 检查麦克风与音量，重新录音 |

### 现状的五个问题

1. **前端丢掉了服务端的说明。** 服务端返回 `{error: "…未开通或余额不足"}`，前端只拼 `transcribe ${status}`（`useVoiceInput.ts:548`）。
2. **只有上游之前的三种拒绝带 `code`。** `voice.service.ts` 的理由是「传输层读到的失败没有按原因选择补救的差别」。上面三次事故推翻了这个前提：404、502、422 的补救完全不同。
3. **文案是硬编码的英文，不走 i18n。** 十二个语言的 `chat.json` 里 `voice` 块没有任何错误键。
4. **只显示 4 秒。** `ChatComposer.tsx` 用 4 秒计时器清掉错误，一句带补救措施的话读不完。
5. **同一件事两种说法。** 空的 200 结果显示 `No speech detected`，服务端 422 却显示 `transcribe 422`。

### 官方错误码与现有映射的差异

依据阿里云百炼官方错误码页（https://www.alibabacloud.com/help/en/model-studio/error-code）：

| 上游情形 | 官方 | 现有处理 | 问题 |
|---|---|---|---|
| `AccessDenied.Unpurchased` | 403，需开通服务并完成实名 | 403 加子串识别，说「未开通或余额不足」 | 与 `Arrearage` 在这个账号上混在一起，见下 |
| `Arrearage` | 400，账户欠费 | 通用的「answered 400」 | 看不到「欠费」 |
| `AllocationQuota.FreeTierOnly`、`Throttling.AllocationQuota` | 429，免费额度或配额耗尽 | 一律 `RATE_LIMITED` | 「稍后重试」是错的，需要付费或申请配额 |
| `Throttling.RateQuota` | 429，频率过高 | `RATE_LIMITED` | 正确 |
| `ModelNotFound` | 404，The model xxx does not exist | 「answered 404」 | 正是 17:57 那次 |
| `InvalidParameter` 音频时长 | 400，1 到 300 秒 | 通用 400 | 应提示录音太短或太长 |
| `DataInspectionFailed` | 400，输入内容被审核拦截 | 通用 400 | 补救是换个说法 |
| `InternalError`、超时 | 500、408 | 502、504 | 应提示可重试 |

两点保留意见：官方把「未开通」与「欠费」拆成两个码，但这个账号实际是 `Unpurchased`、充值后恢复，说明二者在实际中混在一起，所以合成一类；音频时长 1 到 300 秒那一行来自通用表，对 `qwen3.8-omni-flash` 的聊天音频输入是否适用没有验证。

---

## 设计

### 契约

- `/api/voice/transcribe` 的所有失败返回 `{ error, code }`，`error` 仍是英文，给日志与调试用。
- 上游失败另带 `upstreamCode`：上游给出的枚举串（如 `AccessDenied.Unpurchased`），只允许 `[A-Za-z0-9._-]`、长度有界，**不放响应体的其他文本，不放 key**。
- 分类在适配器里做，依据响应体里的错误码串；响应体没有码串时按状态兜底。同一个 400 带不同码要得到不同分类。

### 词汇表

保留既有的码，按证据新增：

| 码 | 含义 | 补救 | 可重试 |
|---|---|---|---|
| `ACCOUNT_ACCESS`（新） | 未开通、欠费或授权失效 | 到控制台开通或充值 | 否 |
| `UNAUTHORIZED` | key 无效 | 检查设置里的 key 与地址 | 否 |
| `QUOTA_EXHAUSTED`（新） | 免费额度或配额用完 | 付费或申请配额 | 否 |
| `RATE_LIMITED` | 频率过高 | 稍等再试 | 是 |
| `MODEL_NOT_FOUND`（新） | 模型名不存在 | 检查设置里的模型名，留空用缺省 | 否 |
| `AUDIO_REJECTED`（新） | 录音太短或太长、格式被拒 | 重录 | 否 |
| `CONTENT_FLAGGED`（新） | 内容被审核拦截 | 换个说法 | 否 |
| `NO_SPEECH_DETECTED` | 没有听到语音 | 检查麦克风与音量，重录 | 是 |
| `UPSTREAM_UNAVAILABLE`（新，合并 5xx、超时、连不上） | 服务暂时不可用 | 稍后重试 | 是 |
| `NOT_CONFIGURED`、`INVALID_BASE_URL`、`OVERSIZE`、`UNSUPPORTED_MIME` | 沿用 | 沿用 | 沿用 |

每个码在「码到 HTTP 状态」表里恰有一行。

### 前端

- `code` 映射到 `chat.json` 的 `voice.errors.<code>`，文案是「发生了什么 + 怎么办」；另有一条 `voice.errors.unknown` 作兜底。
- 后端没有 `code`（旧服务、网络断开）时用兜底文案并保留状态码，不再拼英文句子。
- 空的 200 结果与服务端 422 都映射到 `NO_SPEECH_DETECTED`，同一句话。
- 浏览器直连路径（Groq 等）看到的是上游原始状态与响应体，用**同一份**分类函数，放在 `shared/asr` 里做单一实现，两条路径说同样的话。

### 显示

- 提示持续显示到用户关闭，或开始下一次录音时清除；不再用 4 秒计时器。
- 一行折叠的「技术详情」，展开后显示状态码与 `upstreamCode`。
- composer 里已有的草稿保持不变（AC-142 已要求）。

### 日志

- GOAL-010 的 `text` 档捕获落地后，`voice.capture` 行增加 `code` 与 `upstreamCode`（属于本提案的收尾项，不进判据，因为它依赖 GOAL-010 的实现）。
- 现有 `voice.transcribe` 行**不改**：AC-143 要求关闭态下它与基线逐字节相同。

---

## 判据（对应 GOAL-011 的 AC-149 至 AC-153）

| AC | 断言 | 取假形态 |
|---|---|---|
| AC-149 | 夹具逐行：上游（状态、响应体码串）分类为预期的 `code`；同状态不同码得到不同分类；每个 `code` 在状态表里恰有一行 | 只按状态分类；429 一律 `RATE_LIMITED` |
| AC-150 | 经出货路由，所有失败都含 `error` 与 `code`；上游失败含合规的 `upstreamCode`；响应不含 key、Bearer 形式与上游响应体的其余文本（哨兵） | 上游失败不带 `code`；把上游响应体原样放进响应 |
| AC-151 | 每个 `code` 在全部语言里都有非空文案且非英文语言不与英文逐字相同；有兜底文案；文案不含 `transcribe <状态>` 形态 | 新增 `code` 不加文案；某语言缺键 |
| AC-152 | 同一批夹具经浏览器直连路径与经代理路径得到相同的 `code`；分类函数只有一份实现 | 客户端另写一份分类 |
| AC-153 | 真实浏览器里 403 未开通、404 模型不存在、空答案三种情形显示各自的文案，4 秒后仍可见，关闭后消失，开始下一次录音时清除；草稿逐字保留；折叠的技术详情读出状态与 `upstreamCode`；页面上不再出现拼接句；空的 200 与 422 说同一句话 | 仍用 4 秒计时；仍显示拼接句；失败清空草稿 |

---

## 任务拆分

1. **适配器分类与状态表**：新增词汇表，适配器按响应体码串分类，状态表补齐（AC-149）。
2. **服务端契约**：所有失败带 `code`，上游失败带 `upstreamCode`，并修订 ADR-004 与 `voice.service.ts` 里「传输层失败不带码」的注释与相关测试（AC-150）。
3. **共享分类与直连路径**：把分类做成 `shared/asr` 里的单一实现，浏览器直连路径复用（AC-152）。
4. **前端文案与显示**：十二个语言的 `voice.errors.*`、`code` 到文案的映射、持续显示与技术详情（AC-151、AC-153）。

---

## 非目标

- 不做上传前的静音检查（误判会丢口述，且要等 GOAL-010 的捕获数据看清 422 的实际成因）。
- 不做失败后的自动重试，不做「一键打开设置」之类的跳转按钮。
- 不改 `voice.transcribe` 日志行的形状。
- 不改变识别本身的行为、提示词或模型。

## 已知限制

- 官方错误码页是通用表，个别条目（如音频时长范围）对 `qwen3.8-omni-flash` 是否适用未验证；分类以响应体码串为准、状态兜底，所以遇到表外的码时会落到 `UPSTREAM_UNAVAILABLE` 或兜底文案，而不是错误地归类。
- 「未开通」与「欠费」合成一类，用户看到的补救是「开通或充值」，不区分。
- 与 GOAL-010 的任务在 `voice.service.ts` 上有交叠，合并时可能需要处理冲突。
