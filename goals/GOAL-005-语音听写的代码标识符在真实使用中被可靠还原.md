---
id: GOAL-005
title: 语音听写的代码标识符在真实使用中被可靠还原
status: achieved
kind: goal
origin: docs/proposals/voice-identifier-repair-and-temporal-compression.md（commit
  57b957f7）；证据基础 /data/home/yale/work/tc-verify/FINDINGS.md（仓库外验证工装，22 工具 / 14
  日志）
activatedAt: 2026-09-21T12:38:50.386Z
statusLog:
  - at: 2026-09-21T13:25:05.422Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
  - at: 2026-09-21T13:56:14.865Z
    from: achieved
    to: active
    actor: yale
    reason: 退出条件 4（AC-115 端到端生效）未真正满足：修复未接进客户端，且该判据原不可失败；另实测 AC-113 的判据量的是 harness
      副本而非出货模块，两者 6/16 不一致。重启后按新判据重新收敛。
  - at: 2026-09-21T14:22:26.131Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

CloudCLI 的语音输入是 push-to-talk：一次按键 = 一段录音 = 一次请求（src/modules/chat/hooks/useVoiceInput.ts → transcribeVoice() → src/modules/chat/composer/ChatComposer.tsx:260）。服务端 server/modules/voice/voice.service.ts 是 OpenAI 兼容的纯透传代理，没有项目上下文。

2026-09-21 在仓库外工装上对 Groq whisper-large-v3-turbo 做了端到端实测（工具与日志见 /data/home/yale/work/tc-verify/，报告 FINDINGS.md），得到三条与直觉相反的事实：

1. 质量瓶颈不是音频时长，而是标识符能否被还原。中文代码混读下基线只保住 16.7% 的标识符（voice.service.ts 常被判为 voice.seluis.ts），英文基线 77.8%。对改代码的 agent，wasInput 意味着去改错文件。

2. 现有 CER 对这件事结构性失明。normalize() 删除空格与标点，于是 voice.service.ts 与 voice service ts 归一化后完全相同。实测证据：某次改动把 Use voice.Input 修成了 useVoiceInput（标识符实际被修正），而 CER 报告 0.00% 变化。以 CER 验收语音质量，会产生「指标全绿但 agent 改错文件」的假通过。

3. 修复可行且零成本。app 能免费枚举项目文件清单（既有接口 GET /api/file-tree/projects/:projectId/files，前端 src/shared/api.ts:279 已在调用），于是标识符恢复从「识别问题」变成「字符串匹配问题」。实测中文 16.7%→75.0%、英文 77.8%→88.9%，在 1937 个真实候选（全量 git ls-files）上零误报、零改错。

同时实测排除了若干条曾被认真考虑的路线：WSOLA α=0.8 使中文标识符存活归零（0/12）；α=0.9 在中英双语下均标识符中性；VAD 在 ≥10dB SNR 稳健而 5dB 才崩；prompt 偏置在 n=7 下证据不足。

## 范围

- 标识符逐字存活率（保留标点与大小写）成为语音链路的验收面，与 CER 并列而非从属。
- 确定性修复落地客户端：候选来自既有 file-tree 接口，纯字符串运算，无模型、无额外 API 调用、无延迟。
- 修复的两遍匹配与其护栏在真实项目文件树规模上有可复跑的回归保护。
- 验证工装从仓库外移入仓库，使已知读数可被 CI 复现。

## 非目标

- 不改交互（人 yale 2026-09-21 决定）：请求合并、连续录音模式、延迟出字一律不做。
- 不做时间轴压缩，含已验证安全的 α=0.9。其收益取决于停顿密度，而真实按键分布未知；在测出该分布之前投入实现不经济。压缩相关的全部实测结论留档于 FINDINGS.md。
- 不测中文真人语音（人 yale 2026-09-21 决定）：本次中文语料为 TTS 合成。
- 不做噪音处理链路：VAD 在 ≥10dB 稳健，且 useVoiceInput.ts 已开 noiseSuppression 与 echoCancellation。
- 不做 prompt 偏置：n=7 证据不足。
- 不改 server/modules/voice/ 的接口契约：修复在客户端完成，服务端保持纯透传。
- 不做填充词与口头禅删除。

## 退出条件

- AC-112 修复模块在真实项目文件树（候选 ≥1000）上对不含标识符的文本零改写。
- AC-113 修复模块把错拼的标识符还原为项目真实文件名，存活率提升且零改错。
- AC-114 语音链路可输出标识符逐字存活率，且该指标区分得开修复前后（CER 区分不开）。
- AC-115 修复在真实浏览器里经语音按钮端到端生效：填回 composer 的文本中标识符逐字等于项目真实文件名。

## 不做退出条件的范围内事

- 时长仪表（记录每次录音时长，只写日志、不改交互）：它是后续「请求合并 / 压缩」决策的输入，而那些决策已列为非目标，故不纳入本目标的退出条件。
- 修复模块对 voice.seLuis TS 这类点号被读成空格的 token 形状：实测确认两遍匹配均无法还原，需要先测量其发生率再决定是否值得做第三遍，不预设。
- 修复命中的可视化与 UI 提示：属交互范畴。

## 已知不等价点与限制

- AC-112/113 的语料是 TTS 合成（中文 edge-tts、英文 Groq Orpheus），非真人。真人带口音与自发韵律，标识符识别可能更差，那会提高本目标的价值而不改变方向，但阈值需按真人数据重标。
- 中文对照的样本量小（n=12 标识符），置信区间宽。
- 10 秒计费下限未能本机实测：Groq 响应无 usage 字段，而速率限制计数器按真实时长扣，与计费是两套账本。该条只影响已划出范围的压缩与合并，不影响本目标。
- 全部判据跑在 Node 与 Playwright Chromium 下，不等于真机浏览器。

## 修订记录

2026-09-21：立（人 yale 授权）。来源是一次仓库外的完整验证，结论是质量瓶颈在标识符而非音频时长，且现有 CER 指标会掩盖该失效。四条 AC 已立（红先行），实现范围按「不改交互 / 不测中文真人」收敛。

2026-09-21（人 yale 决定）：本目标非目标中的「不做时间轴压缩」被**局部取代** —— 其中 VAD/停顿裁剪部分改由 GOAL-006 承载（依据当日晚间现测：中文 80 clips 账单口径省 25.5%、英文 32 clips 省 13.3%，标识符中性而 CER +1.1%），WSOLA（含 α=0.9）仍不做。本目标已 achieved 的 AC-112..AC-115 不动。

2026-09-22（人 yale 裁定）：本目标非目标中的「不改 server/modules/voice/ 的接口契约：服务端保持纯透传」被**降级**。依该裁定（决策记录见 ADR-004 决策 9），「纯透传」从「服务端契约」降为「**直连分支的性质**」：引入识别服务适配器缝之后，服务端代理分支需要按 provider 分派，而直连分支（浏览器持键直达识别端点）仍为纯透传。本目标已 achieved 的 AC-112..AC-115 不动，状态不变。