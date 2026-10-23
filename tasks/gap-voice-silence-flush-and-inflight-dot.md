---
id: gap-voice-silence-flush-and-inflight-dot
title: 连续语音：语音结束后静音 5 秒即发出（不论多短）、最小段长降到 20 秒、请求在途时麦克风红方块上加脉动点
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-live-vad-readings
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` 与人（yale）的裁定：**语音结束、静音足够久就应该触发识别，不能等累计到 30 秒语音**。接在 `gap-voice-live-segmenter`（切段器）、`gap-voice-single-continuous-input-path`（接线）之后，修的是它们留下的一个缺口：切段只看「累计语音够不够 30 秒」，没有「最早的未发语音已经等了多久」的规则，稀疏的短句要等到点停止才出字。只面向 `dashscope-omni`。

### 为什么现在可以切短

最小段长 30 秒当初的理由是成本（每个请求 407 个固定提示词 token）。用实际单价（输入 0.8、输出 2.7 元/百万 token）重算：一次 15 秒语音的请求只要 ¥0.001–0.006；一天 30 分钟语音即使切成 180 个请求，日费用也只有约 ¥0.16–1.06。**成本不是障碍，延迟才是。** omni 自身延迟实测约 15–22 秒，所以静音阈值再加 5 秒是可接受的增量。

### 方案

三层规则（切段器内，用 VAD 的**帧计数**判断，不用墙钟定时器，标签页被节流时也不失准）：

1. **静音触发（新增）**：已缓冲语音之后，静音连续达到 `DEFAULT_FLUSH_SILENCE_SEC = 5` 秒，立即发出已缓冲的语音，**不论多短**。发出的那一段不含这 5 秒静音（只带既有的尾留白）。之后继续静音不产出任何段；新的语音开始新的一段。
2. **软切（既有，调参）**：已缓冲语音 ≥ `DEFAULT_MIN_SEGMENT_SEC` 且遇到停顿 ≥ `DEFAULT_CUT_PAUSE_SEC`（2.0 秒）时发出。**`DEFAULT_MIN_SEGMENT_SEC` 由 30 降到 20。**
3. **硬切（既有）**：缓冲到 `DEFAULT_MAX_SEGMENT_SEC`（60 秒）仍无停顿则强制切。
4. 点停止仍然立即发出所有缓冲（不变）。
5. 调试覆盖项 `voiceFlushSilenceSec`（仅 `voiceDebug` 下读取，写进 `voiceDebug.ts` 已知开关），让 e2e 用短样本验证。
6. **在途指示（最小的界面反馈）**：监听中只要有任一请求在途，麦克风按钮上的红色方块旁加一个**小的脉动点**；没有请求在途时不显示；不新增任何控件、文案或语言包键。`VoiceInputButton` 新增一个可选布尔属性 `inFlight`，由 hook 的在途请求数导出。脉动动画用 `motion-safe:` 前缀，尊重「减少动态效果」设置。

### 边界（不做）

不改 `cutPauseSec`、`maxSegmentSec`；不处理 Groq；不新增控件、分段条或摘要；`flushSilenceSec` 的 5 秒是**临时默认值**，由 `gap-voice-pause-split-selfcorrect-eval` 的实验结果最终确定。

## AC

- [x] `npm run test:client -- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts src/modules/chat/tests/voiceInputButton.test.tsx` 退出码 0
- [x] 静音触发时刻：一句 2 秒的语音后接静音，段在**语音结束后第 5.0 秒**（± 1 帧）发出；静音只有 4.9 秒时**不**发出（用 ≥100 个固定种子的随机语音长度验证）
- [x] 发出之后：继续静音（再 60 秒）不产出任何新段，也不抛异常；随后到来的新语音形成序号加一的新段
- [x] 稀疏输入：`corpus/long/L3-sparse`（8 句，间隔 15–45 秒）恰好切出 8 段，每段对应一句，发出延迟（从该句语音结束起算）≤ 5 秒 + 1 帧
- [x] 停顿 < 5 秒不触发：句间停顿都 < 5 秒、累计语音 < 20 秒的时间线（harness 生成，≥100 条）恰好 1 段，speechKeptRatio ≥ 0.99
- [x] 过滤与既有不变量仍成立：段内静音压到 ≤ 1.0 秒、分块不变（按 1、160、320、4800 个样本分块喂入产出相同）、`L4-nonstop` 全部是强制切且每段 ≤ 60 秒
- [x] 默认值：`grep -rnE "^export const (DEFAULT_FLUSH_SILENCE_SEC|DEFAULT_MIN_SEGMENT_SEC) =" src/modules/chat/utils/voiceLiveSegmenter.ts` 输出两行，值分别为 5 与 20，且各只定义一处
- [x] `node experiments/voice-vad/run.mjs --detector=live-segmenter --offline` 退出码 0，快照 `fixtures/live-segmenter.json` 已按新默认值重新生成
- [x] `npx playwright test e2e/voice-continuous.spec.ts e2e/voice-live-vad-ab.spec.ts` 退出码 0（假 provider，零费用），且包含下列各项
- [x] 不点停止也出字：说一句话后静音超过 `voiceFlushSilenceSec`，**尚未点停止**时请求数为 1，文字已进入输入框
- [x] 静音 < 阈值再开口：同一句话中间停顿短于阈值，请求数为 1
- [x] 在途指示：假 provider 把响应压住时，麦克风按钮内存在 `data-testid="voice-inflight-dot"`；响应返回后消失；没有请求在途时不存在；停止收尾后（状态为 transcribing）不显示该点
- [x] 界面不增加控件：composer 内按钮数量与 `data-testid` 集合，除麦克风按钮内部的这个点外，与改动前相同
- [x] 取假形态（各自必须变红）：删掉静音触发 → 「不点停止也出字」红；圆点常驻 → 「没有请求在途时不存在」红；把 `motion-safe:` 去掉 → 渲染测试的类名断言红
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：在真实页面里，用假麦克风喂一句话后保持静音：**没有点停止**，文字就进入了输入框，且从请求发出到文字出现的整个过程中，麦克风按钮上能看到脉动点。把「语音结束 → 请求发出」的实际间隔（应约为 5 秒）写进验收记录。不要求任何识别质量读数；质量归 `gap-voice-pause-split-selfcorrect-eval`。

L_D 该轴仍暗，理由：本任务不新增领域数据能力；读数归既有的 `[voice:live]`。

L_G 该轴仍暗，理由：同上。

## Touches

- src/modules/chat/utils/voiceLiveSegmenter.ts
- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/VoiceInputButton.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceInputButton.test.tsx (new)
- src/shared/voiceDebug.ts
- e2e/voice-continuous.spec.ts
- e2e/voice-live-vad-ab.spec.ts
- experiments/voice-vad/run.mjs
- experiments/voice-vad/fixtures/live-segmenter.json
- tasks/gap-voice-silence-flush-and-inflight-dot.md
- src/modules/chat/tests/activityIndicatorResponsive.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx
- src/modules/chat/tests/composerCompactTier.test.tsx
- src/modules/chat/tests/occupiedSessionReadOnly.test.tsx
- src/modules/chat/tests/residentComposerEnableAffordance.test.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/modules/chat/tests/voiceErrorMessages.test.tsx
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
- src/modules/chat/tests/voiceRawCaptureUpload.test.tsx
- src/shared/tests/voiceUpload16k.test.ts

## Evidence

### 真实落地读数（DoD 要求的「语音结束 → 请求发出」间隔）

真实页面 + 假麦克风，`voiceFlushSilenceSec=5`（出厂默认，非调试缩短值），喂 2 秒语音后按真实时间每 250 ms 推进静音，直到请求发出：

```
[voice-flush] speech-end -> request interval ≈ 4.91s (window 5s)
```

（前一轮同一读数 4.94s；两次都在 5.0 秒 ± 0.1 秒内）。该 leg 同时断言：**未点停止**时 `uploads.length === 1` 且输入框 `toHaveValue(ANSWERS[0])`；随后点停止不再产生第二次请求（`toBe(1)`）。

### 命令读数

| AC | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run test:client -- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts src/modules/chat/tests/voiceInputButton.test.tsx` | exit 0，16 tests passed（13 segmenter + 3 button） |
| 7 | `grep -rnE "^export const (DEFAULT_FLUSH_SILENCE_SEC\|DEFAULT_MIN_SEGMENT_SEC) =" src/modules/chat/utils/voiceLiveSegmenter.ts` | 两行：`DEFAULT_MIN_SEGMENT_SEC = 20`（L68）、`DEFAULT_FLUSH_SILENCE_SEC = 5`（L78），各一处 |
| 8 | `node experiments/voice-vad/run.mjs --detector=live-segmenter --offline` | exit 0，700 timelines；`L3-sparse truth=8` |
| 9–13 | `npx playwright test e2e/voice-continuous.spec.ts e2e/voice-live-vad-ab.spec.ts` | exit 0，**17 passed** |
| 15 | `npm run typecheck` / `npm run lint` | 均 exit 0 |

### 逐条判据落点

- **AC2/AC3**（`voiceLiveSegmenter.test.ts`）：`a lone short utterance is flushed exactly at the flush window, and not before it` — 120 个固定种子（`mulberry32`），断言发出点 = 语音结束 + 5.0 s（±1 帧）、4.9 s 静音时 `emissions.length === 0`；`silence after a flush produces nothing until new speech opens the next segment` 断言其后 60 秒静音不再产出，新语音开新段。
- **AC4**：`L3-sparse yields one segment per sentence, each released within the flush window of its end` — 与 `manifest.json` 的 8 句真值逐句对齐，每段延迟 ≤ 5 s + 1 帧。e2e 侧同一语料独立复现：`[voice-live-ab] L3-sparse arm=vad-on … segments=8 requests=8`。
- **AC5**：`timelines whose gaps stay under the flush window remain one segment keeping its speech` — 121 个种子，断言恰 1 段且 `speechKeptRatio ≥ 0.99`。
- **AC6**：`internal gaps over 1.0s are compressed to exactly 1.0s…`、`the segments are identical however the PCM is chunked`（chunk 1/160/320 对比 4800，逐段 start/end/forced/sha256 相等）、`L4-nonstop is cut only by the ceiling…`（每段 ≤ 60 s + 1 帧、非末段 forced=true）。
- **AC10/AC11/AC12/AC13**：e2e 新增四 leg —— `a silence flush fills the box without a stop…`、`a pause shorter than the flush window does not spend a request`、`the in-flight dot tracks requests on a still-recording listen`（含停止收尾后不显示）、`the in-flight dot adds no control to the composer`（按钮多重集相等，testid 差集恰为 `voice-inflight-dot`）。
- **AC14 取假形态**（三处变异各自单独施加、跑完即还原，变异均未提交）：
  1. 删掉静音触发（`silenceFlush` 项整体移除）→ `-g "a silence flush fills the box"` **红**：`Error: the silence never reached the flush window`（exit 1）。
  2. 圆点常驻（`{inFlight && (` → `{true && (`）→ `-g "the in-flight dot tracks requests"` **红**：首个「没有请求在途时不存在」断言 `toHaveCount(0)` 失败（exit 1）。
  3. 去掉 `motion-safe:`（`motion-safe:animate-pulse` → `animate-pulse`）→ 渲染测试 **红**：`the dot's pulse must be gated behind motion-safe`（exit 1）。

### 上一轮修复的两处既有缺陷（测试侧，非产品逻辑）

1. **静音 leg 继承了上一 leg 的 `voiceIdleSec=2`**：调试开关记在 `localStorage`，`a silent listen auto-stops…` 那条 leg 把空闲自动停止调到 2 秒；新增的 flush leg 没有重新声明它，于是被压住的 4 秒在途请求期间麦克风自动关闭（失败页快照里按钮已是 `Voice input`、输入框已有 `alpha bravo`），第二次说话打到了已停止的采集上。修法：新增常量 `IDLE_WINDOW_SEC = 120`，四条 flush leg 显式声明 `voiceIdleSec`（并显式声明 `voiceMinSegmentSec`），符合该 spec 自己写下的「flags are remembered」纪律。
2. **两个 spec 在同一次 `playwright test` 调用里抢同一个账号**：`playwright.config.ts` 一次调用只建一个 data dir / 一个 `auth.db`（`workers: 1`），而 `voice-continuous` 与 `voice-live-vad-ab` 的 `beforeAll` 都填 `#username` + `input[type=password].nth(1)` 建 `e2euser`。第一个 spec 建完账号后，第二个 spec 的 `/` 渲染的是 `LoginForm`（`#username` + 仅 1 个 password 字段），`nth(1)` 永不出现 → beforeAll 60 秒超时。修法：以 `#confirmPassword`（只有 `SetupForm` 有、且始终渲染）区分两种表单，无此字段则改走 `Sign In`。两份 spec 对称修改，因此与调用顺序无关。

### 本轮修复（suite 红：漏补的一处整模块 mock 键）

上一轮 fan-in 的 suite 红落在一个具体文件：`src/modules/chat/tests/voiceRawCaptureUpload.test.tsx`（3/3 tests failed，`AssertionError: the send must happen even while the raw upload is still in flight`）。

- **根因**：本任务给 `useVoiceInput` 新增了 `voiceDebugFlushSilenceSec()` 调用（listen 开始时读静音触发窗口）。该测试对 `@/shared/voiceDebug` 做整模块 `vi.mock`，键集合里缺 `voiceDebugFlushSilenceSec` → 每次 `toggle()`/`start()` 都抛 `TypeError: voiceDebugFlushSilenceSec is not a function`，转写请求从未发出；第三例（raw upload 不阻塞 send）因此永远等不到 send。机制与 `export-addition-forces-undeclared-collateral-mock-edits` 记录的「新增 export 逼出未声明的附带 mock 补全」完全一致。
- **为何漏了这份**：其余 10 份整模块 mock `@/shared/voiceDebug` 的文件（均在 `## Touches`）上一轮已补全，唯独这份的 import 面（经 `useVoiceInput` 间接）在一跳检查里没被算进 delta，故上一轮的 delta-relatedness 报了 UNRELATED；它其实是本任务 delta 的附带碰撞，属真实发现。
- **修法**：按同一格式补 `voiceDebugFlushSilenceSec: () => undefined`（= 出厂 5 秒默认），并把该文件加入 `## Touches`（写入点必须声明）。
- **读数**：`npm run test:client -- <该文件 + voiceClipPlayback / occupiedSessionReadOnly / composerCompactTier / chatComposerResponsive / residentComposerEnableAffordance / voiceUpload16k>` → **64 passed（7 files）**；`npm run typecheck`、`npm run lint` 均 exit 0。

### 门

- 合并 `develop` 后 `bash scripts/test.sh --for-task gap-voice-silence-flush-and-inflight-dot --allow-thin` → **exit 0**（`voiceInputButton.test.tsx`、`voiceLiveSegmenter.test.ts` 均 passed）。
