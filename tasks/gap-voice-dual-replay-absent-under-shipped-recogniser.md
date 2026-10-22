---
id: gap-voice-dual-replay-absent-under-shipped-recogniser
title: 录音槽只剩一条回放：裁剪默认翻面后第二回放消失，登记恢复后两条必须重新并存
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-default-flipped-by-unregistered-first-adapter
goal_ac: AC-122
---
## Proposal

本任务承接 AC-122（回放同时提供原始录音与裁剪后音频两条）。**本轮的直接测量**（不是台账尾巴）：`npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 退出 1、14.2s，红在 `e2e/voice-trim.spec.ts:1129`：

```
Error: the recording slot offers no replay of the trimmed upload: the trim happened and cannot be heard
  Locator: getByRole('button', { name: 'Replay trimmed' })
  Expected: visible — Error: element(s) not found
```

台账同日同形（`.quay/gate-events.jsonl`）：`2026-09-23T04:32:38.031Z` pass → `2026-09-23T05:33:11.686Z` fail（goal-sweep）、`2026-09-23T05:34:06.113Z` fail（goal-cli）。

### 为什么前一次修复没有守住

`gap-voice-clip-dual-playback`（done，`goal_ac: AC-122`）把这条判据做绿过 —— 04:32:38Z 那次 pass 就是它。它建立的第二回放依赖「裁剪默认会跑」。随后 `0ae696cd`（"fix(voice): the trim asks the registry for 裁不裁, not a table of its own"）把裁剪决策从客户端自带表挪到能力声明，`develop` 于 05:17:13Z 快进到它。此后这条链是：

1. `src/modules/chat/hooks/useVoiceInput.ts:232` `const recogniser = effectivePauseCuesDeclaration();`
2. 同文件 `:233` **第一道闸就返回**：`if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) return recorded;` —— `?voiceTrim=on` 开关是开的，所以退出的原因是**能力答的不是 `destructive`**。
3. `src/shared/voiceTrim.ts:370` 的 `trimDecisionFor` 就是 `trim: capability === 'destructive'`。
4. `shared/asr/asrRegistry.ts:221` 的 `REGISTERED` 至今只有一行 `multimodal`（`shared/asr/list/` 下也只有 `multimodal/`），而 `multimodal.asr-provider.ts:69` 声明 `pauseCues: 'useful'`；`src/shared/api.ts:654` 的读点拿有效 provider 的 id 去问 registry，有效 provider 又来自 `listProviders()[0]`。

于是 `prepareUpload` 返回原始录音，`adoptTrimmedClip` 从未收到裁剪体，第二个控件因此不存在。**那条绿是陈的**：它测的是「裁剪跑起来之后两条并存」，而今天这条链上裁剪根本不跑。

前置（另案，已在飞）：`gap-voice-trim-default-flipped-by-unregistered-first-adapter`（ready，`goal_ac: AC-121`）把出货识别器以 `openai-compatible` / `pauseCues: 'destructive'` 登记进 registry —— 那是让裁剪重新默认运行的那一跳。**本任务不重复它**：`depends_on` 已声明，且 AC4 机械地禁止本任务改动 `shared/asr/**`。

<!-- dedup-ref --> 与既有任务的机制区分：`gap-voice-debug-switch`（done，开关与读数）管读数的开关；`gap-asr-trim-capability-wiring`（done，AC-135）管决策接到声明；`gap-asr-pause-cues-second-source-contradicts-registry`（done，AC-134）管读点唯一；`gap-voice-trim-default-flipped-by-unregistered-first-adapter`（ready，AC-121）管登记缺口。本案管的不是裁剪怎么决策，也不是裁剪跑不跑，而是**裁剪跑起来之后录音槽里的两条音频是否真的并存、可辨、互斥** —— 这是录音槽这一层的判据，登记恢复只是它的前提。

### 本任务做什么

在登记恢复、且**出货默认**（`?voiceTrim=on` 的一次真实录音）下，让录音槽重新同时提供两条回放，并把这份并存钉在出货路径上：

1. **取基线**：干净工作树上跑 AC-122 腿，记录它自己打印的 `[voice-replay] original=…s/…B trimmed=…s/…B` 读数。
2. **若已绿**：不改实现 —— 把读数与「两条并存在出货默认下成立」记进完成记录，本判据的守卫就是既有的 AC-122 腿本身，不新增第二实现、不加第二张表。
3. **若仍红**：修 `src/modules/chat/hooks/useVoiceInput.ts` 的两条 clip 路径 —— `original`（原始 blob 的 object URL）与 `trimmed`（裁剪后重编码的那一份，即实际上传体）同时持有、`adoptTrimmedClip` 在裁剪真跑时必被调用、`fallback === true` 时如实不造第二条；必要时下探到 `VoiceClipButton.tsx` / `ChatComposer.tsx` / `src/shared/types.ts`（四个回放键在五份 locale 里都已存在，无需新增文案键），并由单元面 `voiceClipPlayback.test.tsx` 覆盖互斥与 fallback 渲染。
4. **取假验证承重**（见 AC3）：删掉第二控件 ⇒ 必红；两条指向同一 blob ⇒ 必红。

边界（不做）：不改 `shared/asr/**` 的登记与声明、不改 `src/shared/api.ts` 的读点（那是前提任务与 AC-134 的地盘）；不重引入客户端能力表；不削弱 `e2e/voice-trim.spec.ts` 的既有断言；不改「换会话清空 / 离屏停播」语义；不让回放影响上传体（上传永远用裁剪后那份）。

## Plan

- **S0 基线**：确认前提已落地（`tryResolve('openai-compatible')` 非 null 且 `listProviders()[0]` 就是它），再 `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 取读数；红则记下失败行原文，绿则直接进 S3。
- **S1 修复（仅红时）**：两条 clip 的持有、按需建 `Audio` 元素与互斥都在 hook 的同一次状态更新里完成，UI 只读 ABI；每个控件用 `data-clip-url` 公布自己会播的那份源，供判据直接比对而不是反推。
- **S2 单元面**：`npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 覆盖互斥（第二条开始时第一条停）与 `fallback` 下不伪造第二条。
- **S3 取假 + 复核**：两种取假形态各跑一次并记命令与原文；`git diff --name-only` 复核 `shared/asr/` 与 spec 断言都未被改动。

## AC

- [x] AC1 `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 退出 0。修前同一命令退出 1、14.2s、红在 `e2e/voice-trim.spec.ts:1129`（`the recording slot offers no replay of the trimmed upload`）；两份读数原文都记进 DoD。
- [x] AC2 `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 退出 0（互斥、两条不同源、`fallback` 不伪造第二条的单元面）。
- [x] AC3 取假变体两条，各自必须有读数：把第二回放的渲染摘掉 ⇒ AC1 退出非 0 且失败行仍是 `the recording slot offers no replay of the trimmed upload`；把 trimmed 那条改用原始 blob 建 ⇒ AC1 退出非 0 且红在容器判据 `the trimmed replay is not the encoded WAV`。两次退出码与失败行原文记进 DoD。
- [x] AC4 本任务不落在登记面：`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` 输出 `0`；且 `git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^src/shared/api.ts'` 输出 `0`。
- [x] AC5 判据未被削弱：`grep -c "the trimmed replay is not the encoded WAV" e2e/voice-trim.spec.ts`、`grep -c "the recording and the trimmed audio were sounding at once" e2e/voice-trim.spec.ts`、`grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` 各自输出 `1`。
- [x] AC6 `npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-122 在 `.quay/gate-events.jsonl` 里的尾巴由 `2026-09-23T05:33:11.686Z` 的 fail 转回 pass。
- **真落地**：不是「控件存在」，而是**一次真实录音后同一录音槽里两条真实音频并存且可判别** —— 两条 `data-clip-url` 不同、取回的字节容器各异（原始 `1a45dfa3` webm/opus、裁剪那条 `52494646` RIFF PCM）、裁剪那条**时长**严格更短、且任一时刻最多一条在播（以页内 `window.Audio` 注册表读未暂停元素的 src 判定，不读控件标签）。这些读数由 AC-122 腿自己在 trace 里打印（`[voice-replay] original=…/…B trimmed=…/…B`），完成记录里引用同一段原文。
- **前提如实登记**：本判据此前不可能为真（裁剪不跑 ⇒ 没有第二份音频可言）。完成记录里必须写明 `gap-voice-trim-default-flipped-by-unregistered-first-adapter` 的落地提交/合并 sha；前提未落地时不得宣称本任务完成。
- **三次读数原文**（命令 + 退出码 + 失败行）：修前 AC1；取假（摘掉第二控件）后的 AC1；取假（同一 blob）后的 AC1。
- **L_D 该轴仍暗，理由**：本任务只让录音槽里的两条派生音频并存可辨，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 本任务的读数是两条回放的存在性、容器、时长与互斥性，不是生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。

## 完成记录

### 结论：前提落地后本判据已经为真 —— 走 Proposal 步骤 2 的绿路径，本任务不改实现

**前提如实登记**：`gap-voice-trim-default-flipped-by-unregistered-first-adapter`（`goal_ac: AC-121`）的实现提交为 `9c809952`（任务分支 `task/gap-voice-trim-default-flipped-by-unregistered-first-adapter`），由 driver 机械 fan-in 于 `da6bfd5c`（`tasks: 翻 gap-voice-trim-default-flipped-by-unregistered-first-adapter done（driver 机械 fan-in）`）落到 `develop`；`git merge-base --is-ancestor 9c809952 da6bfd5c` **退出 0**。本 worktree 自 `9179f394`（= 本任务立案时的 develop）建出，`git merge --no-edit develop` 报 `Already up to date.`。

前提落地后那条链确实重新跑起来了（逐跳核对，未改动任何一跳）：`listProviders()[0]` 已是 `openai-compatible`（`shared/asr/asrRegistry.ts` 的 `REGISTERED` 首位）→ 其声明 `pauseCues: 'destructive'` → `effectivePauseCuesDeclaration()` 交回它 → `trimDecisionFor(...).trim === true` → `prepareUpload` 真的产出第二份（`encodeWavBlob` 的 PCM WAV）→ `adoptTrimmedClip` 被调用 → 录音槽里两条并存。

### 本轮现场读数（全部在本 worktree；除本任务文件外 `git status --porcelain` 为空）

- **AC1** `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` **退出 0**（16.3s，用例自身 8.6s）。腿自己打印的原文，即「一次真实录音后同一录音槽里两条真实音频并存且可判别」：
  ```
  [voice-replay] original=2.640s/17741B trimmed=1.870s/179564B (the trimmed replay is the larger body: PCM WAV against the recorder's opus)
  ```
  两条 `data-clip-url` 不同；原始那条是录制器的流（`1a45dfa3` webm/opus，2.640s ≈ 夹具 `FIXTURE_SEC`），裁剪那条是**本仓库编码的** `RIFF` PCM WAV、字节各不相同、时长严格更短（−0.770s）且不是整个夹具；互斥以页内 `window.Audio` 注册表读未暂停元素的 src 判定（腿内 (5) 段），不读控件标签。
- **AC2** `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` **退出 0**：`Test Files 1 passed (1)`、`Tests 18 passed (18)` —— 含互斥（第二条开始时第一条停）、两条不同源、`fallback` 下不伪造第二条。本任务未改动该文件。
- **AC3** 两次取假各自现场实测，原文见下节。
- **AC4** `git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` → **`0`**；`… | grep -c '^src/shared/api.ts'` → **`0`**。本任务不落在登记面，也不碰读点。
- **AC5** `grep -c "the trimmed replay is not the encoded WAV" e2e/voice-trim.spec.ts` → **`1`**；`grep -c "the recording and the trimmed audio were sounding at once" e2e/voice-trim.spec.ts` → **`1`**；`grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` → **`1`**。本任务未改动 `e2e/voice-trim.spec.ts`，未削弱任何既有断言。
- **AC6** `npm run typecheck` **退出 0**（`tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 三份全过）；`npm run lint` **退出 0**（输出仅既存 warning，无 error）。

### 三次读数原文（命令 + 退出码 + 失败行）

1. **修前 AC1**（前提未落地时，任务正文所记的立案测量）：`npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` **退出 1**、14.2s，红在 `e2e/voice-trim.spec.ts:1129`：`the recording slot offers no replay of the trimmed upload`。⚠️ 如实说明：这条读数**不在本分支上可复现** —— 复现它必须把前提任务的登记（`shared/asr/**`）回退，而 AC4 与本任务边界都禁止本任务碰登记面。本任务用下面的变体 1 提供**同一条失败行**的可复现读数作为替代。
2. **取假（摘掉第二控件）**：`src/modules/chat/composer/VoiceClipButton.tsx` 里 `{clips.trimmed && (…)}` 临时改为 `{false && clips.trimmed && (…)}`，随后还原。同命令 **退出 1**，红在 `e2e/voice-trim.spec.ts:1129`：
   ```
   Error: the recording slot offers no replay of the trimmed upload: the trim happened and cannot be heard
   Locator: getByRole('button', { name: 'Replay trimmed' })  Expected: visible — Error: element(s) not found
   ```
3. **取假（两条指向同一 blob）**：`src/modules/chat/hooks/useVoiceInput.ts:255` 的 `const trimmedBody = encodeWavBlob(samples, decoded.sampleRate);` 临时改为 `const trimmedBody = blob;`（object URL 仍新建，故两条 URL **字符串不同**，只有字节相同），随后还原。同命令 **退出 1**，红在 `e2e/voice-trim.spec.ts:1172`：
   ```
   Error: the trimmed replay is not the encoded WAV
   Expected: "RIFF"  Received: "E_#"
   ```

两次取假落在**两条不同的判据**上（第二控件的存在性 / 第二条的容器），说明这条腿的两个承重点各自独立可红，不是同一个断言在重复。两次变体随后均还原：`git status --porcelain` 为空、`git rev-parse HEAD` 仍为 `9179f394`。

### 本任务未改动任何实现文件

Proposal 步骤 2 的绿路径：AC-122 在前提落地后已经为真，**本判据的守卫就是既有的 AC-122 腿本身** —— 不新增第二实现、不加第二张表、不重引入客户端能力表、不改 `shared/asr/**` 的登记与声明、不改 `src/shared/api.ts` 的读点。本任务的交付物是**基线与取假读数 + 台账翻正**：`git diff --name-only develop...HEAD -- . ':!tasks'` 为空（机制见上）。

### 关联影响（如实登记）

- 与前提任务的重叠如实说明：`gap-voice-trim-default-flipped-by-unregistered-first-adapter` 的完成记录里已现场重跑过 `-g "AC-122"` 并得绿。本任务不是把那一次再跑一遍：它把那次绿**固化成当前 `develop`（`da6bfd5c`）上的现场读数**，并补齐该任务未承担的三件本层判据 —— 前提 shas（`9c809952` / `da6bfd5c`）、两次取假各自的失败行、AC4/AC5 对「不落在登记面、不削弱判据」的机械复核 —— 据此把 AC-122 在 `.quay/gate-events.jsonl` 的尾巴由 `2026-09-23T05:33:11.686Z` 的 fail 翻回 pass。
- 未受牵连的既存读数（未复跑、非本任务判据）：`scripts/asr-trim-capability-check.mjs` 仍红，原因与归属同前提任务所记（它要求一张 AC-134 有意删除的表，归属 GOAL-008），本任务不改它，也不拿它当本任务的失败。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/VoiceClipButton.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/shared/types.ts
- e2e/voice-trim.spec.ts
- tasks/gap-voice-dual-replay-absent-under-shipped-recogniser.md
