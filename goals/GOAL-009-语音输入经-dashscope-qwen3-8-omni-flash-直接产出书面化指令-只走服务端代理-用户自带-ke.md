---
id: GOAL-009
title: 语音输入经 DashScope Qwen3.8-Omni-Flash 直接产出书面化指令：只走服务端代理、用户自带 key、提示词与实验逐字一致
status: achieved
kind: goal
origin: docs/proposals/voice-dashscope-omni-written-instruction.md（2026-09-24 人
  yale 裁定：E 组提示词定型；key 由用户提供；书面指令进 composer；本轮不改输入体验）
activatedAt: 2026-09-24T03:03:54.633Z
statusLog:
  - at: 2026-09-24T03:03:54.633Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-09-24T08:52:51.605Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

编码场景下的口述带着口头禅、停顿和自我更正（「改一下 A，嗯不对，应该是 B」）。逐字转写把这些原样交给编码 agent，既啰嗦又有歧义，此前还观察到「啊不，是 turbo」被断成「啊，不是 turbo」这样的反义。

2026-09-23 至 09-24 的实验（webm/opus 上传、8 条 TTS 合成中文片段）比较了 Gemini、OpenRouter 上的 Qwen3-ASR、DashScope 的 qwen-audio-3.1-asr-flash 与 qwen3.8-omni-flash。只有 qwen3.8-omni-flash 能按指令把口述整理成书面指令；六种提示词设计里，E 组（角色 + 规则 + 示例 + 两步 JSON + reasoning_effort low）在每条 10 次的复核中得到 58/80 条意图正确、4/80 条误导，优于 C 组的 50/80 与 4/80，代价是中位延迟 3.6 秒、p90 10.6 秒。

人 yale 2026-09-24 裁定：采用 E 组提示词；DashScope 的 key 由用户提供；书面指令直接进入 composer；本轮不改变输入过程的体验。设计见 docs/proposals/voice-dashscope-omni-written-instruction.md。

## 范围

- 新增第三个识别适配器 dashscope-omni：以 chat-audio 线协议调用用户工作空间的 qwen3.8-omni-flash，返回 E 组 JSON 中的书面指令作为转写结果，书面化失败时降级为逐字转写。
- 完成 S4 的服务端按 provider 分派，现有 OpenAI-compatible 路径的线上字节与解析行为不变。
- 能力声明新增 transport 字段，用来表达「只能走服务端代理」；DashScope 端点不允许浏览器直连。
- 用户在设置页选择识别服务并填写自己的 key 与工作空间地址，服务端保存；STT 与 TTS 的凭据分开；工作空间地址受主机白名单约束以防 SSRF。
- 适配器中的提示词与冻结实验快照中的 E 组逐字一致，任何改动都能被机械发现。

## 非目标

- 不改输入体验：不显示「已书面化」，不提供查看或换回原文。
- 不把项目标识符作为上下文或热词送给模型（实验显示会回声与误插）。
- 不支持由服务端环境变量提供 DashScope 的 key。
- 上游失败时不自动改用其他 provider；不做重试。
- 不做流式输出与实时语音；不改变默认识别器。
- 书面化质量的数值不进判据集，只以实验记录的形式存在（沿用 ADR-004 决策 8）。

## 退出条件

- AC-137 提示词冻结：适配器导出的四段提示词、reasoning_effort 与默认模型，与冻结快照中 E 组逐字一致；快照中 C、E 两组每条 ≥10 次读数。
- AC-138 适配器离线成立：chat-audio 请求形状、书面指令解析与降级、401/403/429/超时的错误映射（含「未开通或余额不足」）、超限零请求、提示与上下文不上线。
- AC-139 服务端分派：代理路径按 provider 调用对应适配器；OpenAI-compatible 路径逐字节不变，既有抽取一致性基线保持绿。
- AC-140 只走代理与 SSRF：proxy-only 的 provider 在直连路径零请求；白名单外的工作空间地址零上游请求，白名单内放行。
- AC-141 用户配置：key 与地址由用户提供并存于服务端；健康检查据此报告 configured；key 掩码返回且不入日志；转写正文不入日志；TTS 凭据不受影响。
- AC-142 浏览器端到端：选择 DashScope 后语音按钮经代理拿到书面指令并写入 composer，页面不直连阿里云主机；上游失败时报错且草稿不丢。

## 不做退出条件的范围内事

- 实验记录本身（把 out/omni 的读数整理成 docs/experiments 下的记录与冻结快照）：它是 AC-137 的前提，但记录的文字质量属于人读范畴，不另设判据。
- ADR-004 的修订（记录 transport 字段与 chat-audio 线协议）：属于决策记录，不设判据。
- 设置页里「录音会发送到阿里云百炼」的告知文案：属产品文案。
- 用真实 key 与真实录音走完整链路的冒烟：联网且计费，按 ADR-004 决策 8 归入人工验证，不进 CI。

## 已知不等价点与限制

- 书面化只解决口头禅与自我更正，不解决听错标识符：E 组在含标识符的片段上多数只到「可猜回」，d04 的禁改文件 20/20 未被认对。
- 改写可能编造操作：80 条中有 1 条把「A 不对，应该是 B」改写成「把 A 改成 B」；本轮不展示原文，用户只能从 composer 文本自行发现。
- 延迟长尾：p90 10.6 秒、最慢 30.7 秒；20 秒超时下约 1/80 的请求会报错，长尾是否只属于实验时段未知。
- 样本限制：8 条 TTS 合成中文片段，其中只有 2 条含自我更正；结论只说明方向。
- qwen3.8-omni-flash 是模型别名，服务端升级后效果可能漂移。
- 全部判据跑在 Node、替身上游与 Playwright Chromium 下，不等于真实 DashScope 与真机浏览器。
