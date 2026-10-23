---
id: gap-voice-single-continuous-input-path
title: 语音输入只保留连续路径：边说边按序提交文字、被跟踪的插入区间、停止/发送语义、空闲 2 分钟自动停止
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-live-segmenter
  - gap-voice-replay-pills-duration-only
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` 与人（yale）的裁定：**语音输入只保留连续这一种路径，用户不区分两种模式**（额外的认知负担）。用户应当感受到的是：输入被过滤干净了、识别成本降低了、可以更放心地说长话。本条把切段器（`gap-voice-live-segmenter`）和回放按钮（`gap-voice-replay-pills-duration-only`）接进真实的录音 hook。**只面向 `dashscope-omni`。**

### 现状与缺口

页面上现在仍是「一次按键 = 一段 `MediaRecorder` 录音 = 一次请求」：`useVoiceInput.ts` 在停止后解码、批处理裁剪、整段上传；流式 VAD 只在旁路跑，事件只打到 `voiceDebug` 控制台；`runSegmentPipeline` 没有任何非测试调用方。三个相关任务都标 done，是因为各自验收满足，**没有任务负责最后一步的接线**。

### 方案

手势不变：点麦克风开始、点停止（或直接点发送）结束。短输入（累计语音 < 30 s）仍然是一个请求，用户看到的流程与今天相同；话变长时文字边说边出现。

1. **只保留连续路径**：录音源改为 worklet 的 PCM，经切段器切段，段交给 `runSegmentPipeline`，每段调用现有的 `transcribeVoice`。**移除 `MediaRecorder` 与批处理的 `prepareUpload` / `trimVoiceAudio` / `isVoiceTrimEnabled` 在 hook 里的使用**。
2. **边说边按序提交**：只提交「从第一段起连续完成」的前缀。第 2 段先回来、第 1 段未完成时，第 2 段的文字不进输入框；第 1 段完成后一并按序追加。
3. **被跟踪的插入区间**：起点是开始监听时的光标位置；监听期间用户编辑其他位置，区间随之偏移，已提交的文字始终连续、按序、不被覆盖。纯函数放在新模块 `voiceInsertion.ts`。
4. **失败只用现有红色提示**：某段重试用尽后，用输入框上方已有的 `voice-error-notice` 显示一句话（含该段的起止时间），**输入框里不放任何标记**；其余段的文字不受影响。
5. **停止与发送**：点停止，冲刷当前在说的那一段、等在途请求完成后收尾；监听中点「发送」等价于「停止，等全部完成后发送一次」。
6. **空闲自动停止**：连续 `DEFAULT_IDLE_AUTOSTOP_SEC = 120` 秒没有语音则自动停止，不发请求、不报错。整个输入无语音时同样不发请求。
7. **回放槽**：停止后填 `VoiceClipSlot`：过滤后的音频（各段拼接）总是提供；原始 PCM（16 kHz Int16）总长超过 `ORIGINAL_CAP_SEC = 600` 时 `original` 为 `null`。
8. **调试覆盖项**（仅 `voiceDebug` 下读取，写进 `voiceDebug.ts` 的已知开关）：`voiceMinSegmentSec`、`voiceIdleSec`，让 e2e 用短样本验证长输入逻辑。
9. 文件上传入口（`voiceDebug` 才显示）走**同一条**管线：解码为 PCM 后喂入切段器，不再有第二条批处理路径。

### 边界（不做）

不改服务端；不改 provider 声明；不处理 Groq；不新增任何界面控件、分段条或摘要行；不改切段器与回放按钮本身（它们是前置任务的产物）。

## AC

- [x] `npm run test:client -- src/modules/chat/utils/tests/voiceInsertion.test.ts` 退出码 0：固定种子的 ≥200 个随机编辑序列下，已提交文字始终连续、按序，用户在区间外的编辑被完整保留
- [x] `npx playwright test e2e/voice-continuous.spec.ts` 退出码 0，且包含下列各项（假 provider 拦截 `/api/voice/transcribe`，零费用）
- [x] 短输入：累计语音 < 30 s 的样本，请求数恰好 1，停止后输入框文字等于该请求的返回
- [x] 长输入（`voiceMinSegmentSec` 调小）：请求数 ≥ 2；让第 1 段的返回晚于第 2 段，输入框里第 2 段的文字在第 1 段完成之前**不出现**，之后顺序正确
- [x] 边说边出现：仍在监听时（尚未点停止），至少有一段的文字已经在输入框里
- [x] 失败：让第 2 段始终失败，其余段的文字完整在输入框里；`voice-error-notice` 恰好出现一次；输入框文本不含任何占位或标记
- [x] 无语音：整段静音的输入，请求数为 0，状态回到待机，没有错误提示
- [x] 空闲自动停止：`voiceIdleSec` 调到 2，静音下约 2 s 后自行停止，请求数为 0
- [x] 发送：监听中点发送，等全部段完成后 `onTranscript(text, true)` 恰好被调用一次，文字为全部段按序拼接
- [x] 回放槽：停止后过滤后的按钮存在；总长超过上限时只有过滤后的按钮（用调小的 `ORIGINAL_CAP_SEC` 覆盖验证）
- [x] **退役并处置（人 yale 2026-10-04 授权）**：按本任务的 Proposal 移除批处理裁剪路径 ⇒ `e2e/voice-trim.spec.ts` 的 **AC-119 / AC-121 / AC-122 三条腿授权退役**（它们测的正是被移除的对象：批处理裁剪、`[voice:trim]` 读数、MediaRecorder 原始流；逐字失败行见 完成记录，三条都不可能在不改判据含义的前提下通过）。退役的同时**必须逐条处置**被它们钉住的五个已 done 任务的判据 —— `gap-asr-trim-capability-wiring` AC2、`gap-voice-debug-switch`（`-g "AC-121"`）、`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page` AC1+AC6、`gap-voice-clip-dual-playback`（`-g "AC-122"`）、`gap-ac122-shared-assembly-starves-leg-budget` AC1 —— 每一条都要在**它自己的记录里**登记「其判据随 AC-119/121/122 一同退役」，给出替代读数或明示不再覆盖；**不得让它们静默变红**。其余 3/4 个既有语音 e2e（`voice-identifier-repair` / `voice-error-messages` / `voice-dashscope-written`）继续绿的要求不变。
- [x] `grep -n "MediaRecorder\|trimVoiceAudio\|isVoiceTrimEnabled\|prepareUpload" src/modules/chat/hooks/useVoiceInput.ts | wc -l` 的结果为 0
- [x] 取假形态（各自必须变红）—— **收窄到实际负载的两个变异**（人 yale 2026-10-04 裁定；原第②条「把最小段长删掉」在出货夹具上是**空操作**：夹具是一次连续语音、无 ≥ `cutPauseSec`(2.0s) 的停顿，段数由「是否成段」决定而非最小段长，故按 `false-form-mutation-must-exercise-the-parameter` **本条不再要求它**）：① 按完成顺序而非序号提交文字 → 「第 2 段不早于第 1 段出现」必须红；③ 失败段在输入框里推占位 → 「输入框不含标记」必须红。两条的变异 diff、逐字失败行与恢复命令逐条记录（上一轮两条均已实测为红，读数见 完成记录）。
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## Evidence

本轮（续做轮，复用既有 worktree，分支 head `d0c2d49a`；**本轮未改任何出货源码** —— 三个取假形态的变异全部还原，`git status` 干净）在真实 Chromium + 真后端/Vite 上现测，假 provider 拦截 `/api/voice/transcribe`，零费用：

- `env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts`：`1 failed`（AC-119）+ `3 did not run`（serial 在首腿失败后跳过）。AC-119 读数：`[voice-trim] uploads: trimmed=1.700s untrimmed=1.720s fixture=2.600s` → `untrimmed upload was 1.72s, the fixture is 2.6s`（差 0.88 s > 0.3 s 容差）。
- `-g "AC-121"`：`1 failed`，`the switch-off leg never printed the unconditional fidelity reading, so it never reached the end of the chain`（`fidelityMessages` 为 0）。
- `-g "AC-122"`：`1 failed`，`the original replay is not the recorder's stream`（`Expected "1a45dfa3"` / `Received "52494646"`）。

三个取假形态（探针脚本 `/tmp/ff-voice-mutations.sh`，每则变异后 `git checkout -- src/modules/chat/hooks/useVoiceInput.ts` 还原）：

- 「按完成顺序排空 `settled`」→ 目标「第 2 段不早于第 1 段出现」→ **红**（`not.toContain("charlie delta")` 失败）。
- 「hook `minSegmentSec: 0`」→ 目标「短输入请求数恰好 1」→ **绿，未红**。
- 「给失败段推入占位 part」→ 目标「输入框不含标记」→ **红**（输入框 `alpha bravo [segment 1 failed] echo foxtrot`）。

结论：AC 共 14 条，本轮后仍 12 条已勾、2 条未勾（上列两条 `- [ ]`）。**本任务在 worker 侧不能到达全绿**：一条卡在人工裁定（voice-trim 退役 + 5 个已 done 任务判据的处置），一条卡在假形态②在出货夹具上不可红。worktree 保留，供人工/后续处置。

**2026-10-04 退役实施轮**（复用既有 worktree；分支 head `31b36b8f`；本轮除判据文件 `e2e/voice-trim.spec.ts` 外未改任何出货行为，两次取假形态的变异全部还原，`git status` 只剩该 spec 的改动）。

**退役与处置（人 yale 2026-10-04 授权，见本任务 Resolution）。**

- `e2e/voice-trim.spec.ts` 删除 AC-119 / AC-121 / AC-122 三条腿，连同只被它们读取的 `readings` / `trimMessages` / `nextReading` / `MIN_SAVING_SEC`。删除后 `env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts --list` → `Total: 1 test in 1 file`（只剩 AC-120）。
- 三条腿的 goal 判据逐条落 `superseded`（`quay goal write <AC> --status superseded --actor worker-gap-voice-single-continuous-input-path --reason <逐条写明> --root /data/home/yale/work/claudecodeui`）：AC-119 / AC-121 / AC-122 现均为 `status: superseded`，每条都带书面理由，并给出替代读数或明示不再覆盖。store 同时记下一条 `goal-staleness` 信号（GOAL-006 自身状态未被改动，是否重开是人的决定）。
- 五个被钉住的已 done 任务**逐条在它自己的记录里**登记退役（`quay task edit <id> --append-notes`，五条的 `status` 都仍为 `done`）：`gap-asr-trim-capability-wiring` / `gap-voice-debug-switch` / `gap-e2e-shared-vite-dep-cache-invalidates-inflight-page` / `gap-voice-clip-dual-playback` / `gap-ac122-shared-assembly-starves-leg-budget`。每条都写明其判据随 AC-119/121/122 一同退役、其红不得读成本任务的回归，并给出替代读数或明示不再覆盖（含两处 grep 计数类读数随被删的腿归零）。

**AC-120 是重锚定，不是退役。** 它的被测对象（文件上传入口）按 Proposal 第 9 条保留在同一条管线上；被移除的是它原来的证据通道（`[voice:trim]` 读数的 `source` 字段）。本分支实测该腿因读数归零而红：`the chain printed no [voice:trim] reading for this capture`，`Received: 0`。重锚定后断言改为链路自己的两侧证据 —— 落到识别器上的请求体是链路的音频（RIFF WAV，时长 ≤ fixture + `CAPTURE_TOLERANCE_SEC`），且链内无条件打印的 `[voice] identifier fidelity` 读数确实到达（该打印只在转录步骤内发生，即「文件走的是与录音同一条转写链」）。重跑 `env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` → `1 passed (13.5s)`，读数 `[voice-upload] file=2.600s uploaded=1.500s bytes=48044`（2.6 s 的 fixture 经切段后 1.5 s，落在容差上界内）。⚠️ AC-120 的 goal 记录仍是 `achieved`，其 `expect` 第 (3) 条描述的是已被移除的 `[voice:trim]` 读数，属需要人复核的文字陈旧项 —— 本轮未改它的 `status` 与 `criterion`，只在此记明。

**取假形态（本轮现测，各自必须变红）。** 变异临时改 `src/modules/chat/hooks/useVoiceInput.ts` 的 `drainCommitted`，跑完立即 `git checkout -- src/modules/chat/hooks/useVoiceInput.ts` 还原；两次之后 `git status --porcelain` 都只剩本任务的 spec 改动。

① 按完成顺序而非序号提交 —— 把「只排空从第一段起连续完成的那个前缀」换成按 `settled` 的插入（即完成）顺序全量排空。变异 diff（`git diff -- src/modules/chat/hooks/useVoiceInput.ts`）：
```
@@ -474,10 +474,9 @@ export function useVoiceInput(
    */
   const drainCommitted = (session: CaptureSession) => {
     let advanced = false;
-    while (session.settled.has(session.nextCommit)) {
-      const outcome = session.settled.get(session.nextCommit)!;
-      session.settled.delete(session.nextCommit);
-      session.nextCommit += 1;
+    for (const [settledIndex, outcome] of [...session.settled]) {
+      session.settled.delete(settledIndex);
+      session.nextCommit = Math.max(session.nextCommit, settledIndex + 1);
       advanced = true;
       if (outcome.ok && outcome.text.trim()) {
         session.parts.push({ index: outcome.index, text: outcome.text, failed: false });
```
逐字失败行（`env -u TMPDIR npx playwright test e2e/voice-continuous.spec.ts -g "commits in spoken order"` → **exit 1**，`1 failed`）：
```
Error: a later segment was committed before the earlier one
Expected substring: not "charlie delta"
Received string:        "charlie delta"
> 322 |     expect(await composer().inputValue(), 'a later segment was committed before the earlier one').not.toContain(ANSWERS[1]);
```
恢复命令：`git checkout -- src/modules/chat/hooks/useVoiceInput.ts`（已执行）。

③ 失败段在输入框里推占位 —— 在 `drainCommitted` 的成功分支后追加一个带标记的 part。变异 diff：
```
@@ -481,6 +481,8 @@ export function useVoiceInput(
       advanced = true;
       if (outcome.ok && outcome.text.trim()) {
         session.parts.push({ index: outcome.index, text: outcome.text, failed: false });
+      } else if (!outcome.ok) {
+        session.parts.push({ index: outcome.index, text: `[segment ${outcome.index} failed]`, failed: false });
       }
     }
```
逐字失败行（`env -u TMPDIR npx playwright test e2e/voice-continuous.spec.ts -g "leaves no marker"` → **exit 1**，`1 failed`）：
```
Error: expect(locator).toHaveValue(expected) failed
Received: "alpha bravo [segment 1 failed] echo foxtrot"
> 354 |     await expect(composer()).toHaveValue(`${ANSWERS[0]} ${ANSWERS[2]}`, { timeout: 20_000 });
```
（红落在「失败段不贡献文字」那条精确取值等待上：占位一进输入框，该值就不可能成立，紧随其后的 `not.toMatch(/\[|\]|failed|segment \d/i)` 也就没有机会执行 —— 目标不变量「输入框不含标记」同样被证伪。）恢复命令：`git checkout -- src/modules/chat/hooks/useVoiceInput.ts`（已执行）。

## DoD

真实落地判据：不是各部件单独通过，而是**在真实页面里完整走通一次**：用 e2e 注入 `corpus/long` 的样本经真实 `AudioWorklet`，输入框里的文字按说话顺序出现、停止后回放槽里有过滤前后的两条、没有第二条上传路径残留。并且用 `corpus/long/L2-mixed` 对真实 `dashscope-omni` 做**一次**冒烟（受 `gap-voice-long-form-eval-prereg` 的 2 元预算约束，沿用其预算闸与 `pricing.json`，缺单价则冒烟必须指名原因并失败，不得降级报绿）：读到请求数、各段时长与 `usage`，拼回后的句数与真值一致。取假形态红的同时，保留一份「改前 vs 改后」的对照记录（改前：一个请求、整段时长；改后：段数、实发时长）。

L_D 该轴仍暗，理由：本任务是接线，不新增领域数据能力；读数归 `gap-voice-live-vad-readings`。

L_G 该轴仍暗，理由：质量读数归评估任务，本任务只做链路冒烟。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/VoiceInputButton.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/utils/voiceInsertion.ts (new)
- src/modules/chat/utils/tests/voiceInsertion.test.ts (new)
- src/modules/chat/utils/tests/voiceSegments.test.ts
- src/modules/chat/tests/voiceCaptureTestHarness.ts (new)
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/modules/chat/tests/voiceErrorMessages.test.tsx
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
- src/shared/tests/voiceUpload16k.test.ts
- src/shared/voiceDebug.ts
- src/shared/types.ts
- e2e/voice-continuous.spec.ts (new)
- e2e/voice-trim.spec.ts (AC-119/121/122 三条腿退役，AC-120 腿重锚定)
- e2e/voice-error-messages.spec.ts
- playwright.config.ts
- tasks/gap-voice-single-continuous-input-path.md


## Resolution

**人 yale 裁定（2026-10-04，经管理者会话下达）—— 本条的两处欠账各按下列方式处置：**

### (A) 退役 `voice-trim.spec.ts` 的 AC-119 / AC-121 / AC-122：**授权退役**，并**同时处置**被它们钉住的五条已 done 判据

- **授权范围**：AC-119 / AC-121 / AC-122 三条腿退役。它们的被测对象正是本任务按 Proposal 移除的批处理裁剪路径、`[voice:trim]` 读数与 MediaRecorder 原始流，因此不可能在不改判据含义的前提下通过（逐字失败行见本条 AC 行与 完成记录）。
- **同时必须处置**（核心要求：**不得让它们静默变红**）：`gap-asr-trim-capability-wiring` AC2、`gap-voice-debug-switch`、`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page` AC1 与 AC6、`gap-voice-clip-dual-playback`、`gap-ac122-shared-assembly-starves-leg-budget` AC1 —— 每一条都要在**它自己的记录里**登记「其判据随 AC-119/121/122 一同退役」，并给出替代读数或明示不再覆盖。
- 其余 3/4 既有语音 e2e（`voice-identifier-repair` / `voice-error-messages` / `voice-dashscope-written`）继续绿的要求不变。

### (B) 假形态：**收窄到实际负载的两个变异**

- ① 「按完成顺序而非序号提交文字」与 ③ 「失败段在输入框里推占位」**保留**（上一轮实测两条都红，逐字失败行见 完成记录）。
- ② 「把最小段长删掉」**从本条移除**：它在出货夹具上是空操作（`e2e/voice-continuous.spec.ts:296` 的 `__voiceFake.speak(3)` 是一次连续语音、无 ≥ `cutPauseSec`=2.0s 的停顿，段数由「是否成段」决定），按 `false-form-mutation-must-exercise-the-parameter` 不作为本条的取假形态。

**边界**：本记录只落人的裁定 —— 不改任何 GOAL/AC 状态；退役与五条判据的处置由本任务重新派工后的 worker 执行，本任务的 AC 行已按此收窄。

## Needs-Human

**执行 2026-10-04T13:41:28.268Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：AC 未全勾（checked 12/14，剩余未勾 2）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：1e64b39b-1eef-4ba3-9c5b-bef92b83c855
