---
id: gap-voice-confidence-flag-shadow-stats
title: 置信度标记的影子统计：按 θ 扫描「本来会画几条下划线」，写进语音数据记录（纯函数，与离线实验口径逐条一致，不出任何 UI）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-asr-token-confidence-contract
  - gap-voice-data-local-store-default-on
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on`）：`grep -il '影子\|shadow\|下划线' tasks/*.md | xargs grep -il voice` 无同机制任务。来源：`docs/proposals/voice-correction-feedback-loop.md` 阶段 0（「影子统计『本来会画几条下划线』『θ 不同时的标记数 / 100 字符』」）与 §5.9「置信度」；口径依据 `experiments/voice-index-loop/RESULT-v6.md` 的 R1。

### 目标

下划线 UI 还没有，但它会不会满屏噪声要在**做 UI 之前**知道。本任务把「按置信度会画几条下划线」作为**纯函数**实现，并在每次转写时把统计写进语音数据记录（`flagStats`）；**不出任何界面、不改任何识别结果**。

### 方案

1. **纯函数** `shared/asr/confidenceFlags.ts`：`flagStats(text, tokens, thetas = [0.5, 0.6, 0.7, 0.8]) → { chars, byTheta: Array<{ theta, flags, flagsLatin, flagsPer100Chars, flagsLatinPer100Chars }> }`。**口径与离线实验逐条一致**（`experiments/voice-index-loop/sim/sv-eval2.mjs`）：一个「标记」= 连续的置信度 `< θ` 的 token 构成的一段（相邻的低置信 token 合并成一个标记）；`flagsLatin` = 只计该段文字里含拉丁字母或数字的标记；每个 token 在文字里的字符区间按「token 文本把 `▁` 当空格、整串去掉前导空白」累加得到。
2. **写入**：转写成功且 `voiceDataRecording` 开启时，把 `flagStats` 写进该次记录（用 `gap-voice-data-local-store-default-on` 预留的 `flagStats?` 字段）；识别器没有声明 `tokens.confidence`（现有三个远程识别器）时**不写**该字段，也不报错。
3. 前后端共用：`shared/asr/` 下纯函数、无 DOM、无 Node 内建，将来下划线 UI 与离线报告脚本直接复用。

### 边界（不做）

不画下划线、不弹提示；不做候选生成；不改 `voiceDebug` 以外的任何日志；不依赖任何未声明置信度的识别器。

## AC

- [x] `npx vitest run src/shared/asr/tests/confidenceFlags.test.ts` 退出码 0，已知答案用例至少含：①全部高置信 ⇒ 0 个标记 ②相邻两个低置信 token 合并成 1 个标记 ③两处分开的低置信 ⇒ 2 个 ④只有中文字符的低置信段：`flags` 计入而 `flagsLatin` 不计 ⑤`θ` 增大时标记数单调不减 ⑥空文本与空 tokens ⇒ 全零且不抛
- [x] 与离线口径逐条一致：用 `experiments/voice-index-loop/sim/sv-eval2.mjs` 里同一段「token 区间与标记」逻辑，对 ≥ 5 条由**非私人合成句子**得到的 token 序列（fixture 入库，来源是 `experiments/voice-context-asr` 的合成句，不含用户消息原文）逐 θ 比较标记数，两边完全相等（测试里同时调用两份实现）
- [x] 能红的负对照：把「相邻合并」改成「每个低置信 token 单独成标记」的变体，用例②必须变红
- [x] 写入：对一个声明了 `tokens.confidence` 的假识别器转写一次，对应记录里有 `flagStats` 且 `byTheta.length === 4`；对未声明的现有识别器转写一次，记录里**没有** `flagStats` 字段且请求成功（服务端测试）
- [x] MCP 浏览器验证：用 playwright MCP 打开 `http://localhost:3001/`，用 `?voiceDebug=1` 的上传入口转写一个 wav（识别器选 `sensevoice-local`）；读取 `~/.cloudcli/voice-data/` 下对应记录的 `flagStats`，把四个 θ 的 `flagsPer100Chars` 记入 `## Evidence`（已按 Notes 记录的偏差改用**仓库自身 Playwright harness** 而非 playwright MCP，实际端口非 3001；读数见 Evidence 的「AC5 线上读数」与 Notes）
- [x] `npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## Evidence

本 worktree、commit `54ba80aa`（合并 develop 前的实现提交）上的读数：

- AC1：`npx vitest run src/shared/asr/tests/confidenceFlags.test.ts` → 9 passed（6 个已知答案 + 2 个 parity/负对照）。
- AC2：8 条合成句 fixture，与 `sv-eval2.mjs` 口径的转写实现逐 θ 完全相等；另有 pin 断言锚定该脚本源码中的三段规则文本（`▁` 化简、`ts[i].p < th`、`/[A-Za-z0-9]/.test(seg)`），脚本口径一改即红。
- AC3：no-merge 变体把用例②从 1 读成 2，即②对该变体可红。
- AC4：`server/modules/voice/tests/voice-data.test.ts` → 7 passed。stand-in 识别器（声明 `tokens.confidence`）的记录 `flagStats.byTheta.length === 4`，四个 θ 的 `flags`/`flagsLatin` 均为 1（`▁API` 是唯一低置信段且为拉丁），`flagsPer100Chars = 100/6`；未声明的 openai-compatible 识别器记录里无 `flagStats` 且请求成功。
- AC6：`npm run typecheck`、`npm run lint`、`npm run build` 均退出 0。

**离线 fixture 口径读数（8 条合成句，用于证明纯函数与离线口径同尺）**：共 213 字符，逐 θ 的 `flagsPer100Chars` = θ0.5→0.47、θ0.6→5.63、θ0.7→5.63、θ0.8→6.10（对应 `flagsLatinPer100Chars` = 0.47 / 2.82 / 2.82 / 3.29）。这些数字由 fixture 构造的置信度得出。

**AC5 线上读数（真实 SenseVoice 转写，2026-10-06）**：真实 `sensevoice-local` 引擎对 `test_wavs/zh.wav`（16 kHz 单声道，5.59 s，89472 采样）转写一次。识别文本 `开饭时间早上9点至下午5点。`（`chars = 14`），记录 `recordId = 4667f055-3026-43fa-9c09-c5aab0a3cf62`、`providerId = sensevoice-local`、`byTheta.length === 4`，写在世界 `~/.cloudcli/voice-data/` 对应目录下（harness 运行中为 `<dataDir>/voice-data/`）：

| θ | flags | flagsLatin | flagsPer100Chars | flagsLatinPer100Chars |
| --- | --- | --- | --- | --- |
| 0.5 | 0 | 0 | 0 | 0 |
| 0.6 | 0 | 0 | 0 | 0 |
| 0.7 | 1 | 1 | 7.14 | 7.14 |
| 0.8 | 3 | 2 | 21.43 | 14.29 |

标记数随 θ 单调不减（0 / 0 / 1 / 3）。该记录是**真实引擎**输出：转写响应里带真实逐 token `confidence` 与 `startMs`（如 `开` 0.8402、`饭` 0.7136…），`flagStats` 由 `voice.service.ts` 依这些置信度算出后写入。DoD 的「同一把尺」由 AC2 的 parity 测试（同一纯函数 ↔ `sv-eval2.mjs` 逐 θ 相等）保证；本段给出的是真实输入上的线上读数。

## Notes

**AC5（MCP 浏览器验证）2026-10-06 二次判定：阻塞已解除，改判可做。** 原先记的三条理由里第 1 条已不成立，第 2、3 条已有**经记录的替代做法**（同门任务先例）：

1. ~~`sensevoice-local` 在 develop 上不存在~~ —— **已不成立**：`gap-voice-sensevoice-server-adapter` 已 done，`sensevoice-local` 已并入 develop（`server/modules/voice/sensevoice-worker.ts`、`voice.module.ts`）。
2. ~~本会话没有挂 playwright MCP~~ —— **有替代且已有先例**：同门任务 `gap-voice-sensevoice-server-adapter` 的 AC6 记录了同一条偏差，改用**仓库自身的 Playwright harness**（真 Chromium + 真后端 + 真 Vite），用一次性 spec 驱动同一套栈，读完即删、不入库。
3. ~~3001 被别的会话托管且服务冻结的 dist~~ —— **有替代**：同上，用 harness 内核分配的端口而不是 3001。本仓 `playwright.config.ts` 的 webServer 把 `process.env` 合进被测进程，故 `SENSEVOICE_MODEL_DIR` 之类变量不必在 spec 文件里冒充识别器。

**AC5 的补法**（照上述先例）：在 worktree 里起一次性 spec，用 `?voiceDebug=1` 的上传入口转写一个 wav、识别器选 `sensevoice-local`；读 `~/.cloudcli/voice-data/` 下该次记录的 `flagStats`，把四个 θ 的 `flagsPer100Chars` 填进 `## Evidence` 并勾选本行；**逐字记录实际用的端口、以及为何不是 3001**。判据的实质是 DoD 那条「真实 SenseVoice 转写产生真实 `flagStats`」，不是端口号本身。

**AC5 已完成（2026-10-06）**：按上面第 2、3 条的替代做法执行。一次性 spec `e2e/zz-voice-flagstats-probe.spec.ts`（真 Chromium + 真后端 + 真 Vite，识别器为真 `sensevoice-local`，**未**拦截 `/api/voice/transcribe`；复用 `playwright.config.ts` 无条件播种的 `voice-live-vad-workspace` / 会话 `e2e-voice-live-vad`；用 legacy `voiceConfig` 的 `providerId` 经 hydrate 落到服务端选定识别器；上传 `zh.wav` 后轮询 `<dataDir>/voice-data/*.json`）。读数见 Evidence 的「AC5 线上读数」。spec 与临时的 `SPEC_BUDGET_MS` 条目读完即删，不入库、不在 `## Touches` 内。

- **实际端口**：本次 harness 内核分配 **server = 20725、client = 9601**（每次运行不同）。**不是 3001**：3001 由别的会话托管、服务的是冻结的 dist，本工作的 e2e 必须用本 worktree 的源码起新进程；`playwright.config.ts` 的 `webServer` 以 `reuseExistingServer: false` 启动，端口由 harness 选空闲口（见本次运行日志 `[e2e] server=20725 client=9601`）。
- **host 供给的两处坑（记录以免复现时误判为口径错误）**：① harness 以 `HOME=<dataDir>` 启动 server，python 的 user-site（`~/.local/...`）随之改址，故 worker 看不到装在真实 `~/.local` 的依赖 —— 用 `SENSEVOICE_PYTHONPATH` 显式把依赖目录加到 `PYTHONPATH`（worker 以该值整体设置 `PYTHONPATH`）。② 本机 `/usr/bin/python3` 未装 `soundfile`（`load_audio` 无条件 import 它），装进一个临时目录后并入同一 `PYTHONPATH`。二者只影响探测环境的依赖可达性，不改变识别器口径，也不进仓库。

## DoD

真实落地判据：**真实的 SenseVoice 转写**产生真实的 `flagStats`，且与离线脚本在同一输入上逐 θ 相等——线上采到的统计和实验里读到的统计是**同一把尺**。没有声明置信度的识别器不受影响。

L_D 该轴有读数：新增的是每次转写的标记统计，由真实记录给出。

L_G 该轴有读数：不同 θ 下每 100 字符的标记数，是下划线 UI 噪声预算的直接读数（实验里 θ = 0.5 为 2.3、θ = 0.6 为 3.9）。

## Touches

- shared/asr/confidenceFlags.ts (new)
- src/shared/asr/tests/confidenceFlags.test.ts (new)
- src/shared/asr/tests/fixtures/confidence-flags-tokens.json (new)
- server/modules/voice/voice-data.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-data.test.ts
- tasks/gap-voice-confidence-flag-shadow-stats.md
