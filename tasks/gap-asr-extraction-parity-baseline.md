---
id: gap-asr-extraction-parity-baseline
title: 抽取实现后线上字节零变化：两跳 × 两条路径四组读数逐字节等于抽取前录制的基线（AC-130）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-130
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`grep -rn "^goal_ac: AC-130" tasks/` 为空 —— 全仓无任何任务声明 AC-130，也无第二条在录「抽取前后线上字节基线」的任务。相邻的是 `tasks/gap-asr-wire-single-implementation-boundary-probe.md`（那条声明的是 AC-129），它自己把这一半写在边界里让了出来（原文：「不录逐字节基线 —— 那要录两跳的基线，属 AC-130 的任务」），所以本条不是它的重述，而是它明确让出的那一半；两者只在溯源上相关，本条不引用它作为任何前置，基线「录在抽取之前」这件事由判据自己的 provenance 断言机械保证。

### 现场：判据文件与基线今天都不存在，而基线一旦录在抽取之后就再也证明不了「零变化」

AC-130 自己的判据命令是 `node scripts/asr-extraction-parity-check.mjs`，**该文件不存在**，基线文件也不存在。它要断言的形态是「把四处硬编码抽成适配器之后，两跳 × 两条路径的线上字节与改动前逐字节相同」，四组读数：

| 组 id | 跳 | 载重读数 |
| --- | --- | --- |
| `inbound`（仅代理路径） | 客户端 → 服务端 `POST /api/voice/transcribe` | 表单字段 `audio`（该跳**没有** `model`）、`x-voice-*` 头、multipart 归一化体、URL、方法 |
| `direct-outbound` | 客户端 → 识别服务 `POST <baseUrl>/audio/transcriptions` | 表单字段 `file` + `model`、`Authorization`、无 `Content-Type`（体是 FormData） |
| `proxy-outbound` | 服务端 → 识别服务 `POST <baseUrl>/audio/transcriptions` | 表单字段 `file` + `model`、`Authorization` |
| `response-tolerance` | 两条路径各自的响应解析 | 直连：非 JSON ⇒ 抛错；代理：非 JSON ⇒ 当文本 |

AC 自带两条取假形态，两条都在说**这份基线必须覆盖哪一跳**：① 把入站字段 `audio` 改成 `file` ⇒ 若基线只覆盖出站，本变体恒绿 ⇒ 基线必须含入站那一跳；② 把两条路径的响应解析容忍度统一 ⇒ 响应那一半必须红。

### 方案

**S0 先命名一个稳定的读数接缝（纯抽取，行为零变化）。** 直连路径的响应解析今天是 `useVoiceInput.ts` 里的一行 `await res.json()` 加 `String(data?.text || '')`；一行内联表达式没法被出货代码之外的读者驱动，而第四组读数必须在**抽取前后驱动同一处**才成立。因此先把这一行原地提成具名导出 `parseTranscriptionResponse(response): Promise<string>`（落在 `src/shared/api.ts`，语义取今天的严格那一支：非 JSON 抛出），hook 改为调用它。这是纯抽取 —— 字段名、URL、头、容忍度、字节一个都不变。**这一步必须在本任务内先落地并提交**，因为基线的「改动前」是相对抽取的落点而言的。

**S1 录基线。** `--record` 驱动**出货代码**取四组读数，写进 `scripts/__fixtures__/asr-extraction-parity-baseline.json`，同写 provenance：`recordedFromCommit`、`recordedAt`、`recordedInWorktree`、四组归一化捕获与逐组 sha256。音频用确定性合成字节（固定长度与内容），密钥用自造常量 `k-*`，reader 不读任何 `process.env`。

**S2 判据。** 无参数运行即校验：重新驱动四组、与基线逐字节比对、逐组打印 `equal|differ`；任一组不同即非零退出并在 stdout 指名该组。四条 fail-closed —— 读数不是四条 ⇒ 红；reader 非零退出 / 超时 / 文件不存在 ⇒ 红；接缝符号不存在 ⇒ 红；provenance 不满足「抽取前」⇒ 红。

**边界（不做）**：不做适配器抽取本身（那是抽取那条线的词）；不做 `--dry-run` / `--offline`（AC-131）；不加第二个 provider 与能力声明（AC-132/133/134/135）；不改任何线上行为与字节（S0 是行为保持的纯抽取）；不引入快照测试库，只用「一个 JSON 基线 + 一个探针」。

### 必须挡住的两个「量工装」形态

- **reader 里不得有第二份实现。** reader 只做三件事 —— 注入替身、调用出货符号、把观测序列化；它不得自己拼 multipart、不得自己解析转写响应。由 `--explain-sites` 打印每组读数实际驱动的**绝对路径 + 符号名**（四组 realpath 必须在出货树内），并辅一条独立读数：`experiments/voice-asr-parity/` 下不得出现 `audio/transcriptions` 字面量。
- **比对的是归一化读数，不是裸字节。** multipart 的 boundary 每次序列化都不同，裸字节比对恒红。基线里存的是把 boundary 归一成常量后的体字节 + sha256（含各 part 的 `name`、`filename`、`Content-Type` 与音频字节），加上 URL、方法、头集合。这条写进读数定义，否则第一组读数从第一天起就是「永远红」—— 一个恒红的判据与一个恒绿的判据一样不可用。

## Plan

- **S0 命名接缝（纯抽取）**：`src/shared/api.ts` 新增 `parseTranscriptionResponse`，`src/modules/chat/hooks/useVoiceInput.ts` 改为调用它。本步只求行为零变化，读数见 AC7 / AC8。
- **S1 reader 与探针**：`experiments/voice-asr-parity/read-client.ts`（`npx tsx --tsconfig tsconfig.json`，驱动 `inbound` / `direct-outbound` / 直连那一半的 `response-tolerance`）与 `read-server.ts`（`npx tsx --tsconfig server/tsconfig.json`，驱动 `proxy-outbound` 与代理那一半）。为什么不合成一个 reader：根 tsconfig 的 `@/*` 指 `src/*`，服务端 tsconfig 的 `@/*` 指 `server/*`，同一进程里两套别名互斥 —— 两套消费者今天正是这么分家的。`experiments/**` 不在任何 tsconfig include、也不在 `npm run lint` 的路径列表里，这一点如实登记：reader 自身不受静态门约束，所以探针必须**断言四条读数真的被打印出来**（空读数、非零退出、文件缺失都判红，不许静默绿）。
- **S2 录基线并提交**：`--record` 在当前 HEAD 上录一次。若抽取已经落地（`git show HEAD:src/shared/api.ts` 已不含内联的入站字段写入），则在**抽取之前的那个提交**上开一个临时 git worktree 录，把 `recordedFromCommit` 指过去并置 `recordedInWorktree: true` —— 因为录在抽取之后会把抽取本身的结果当成基线，「零变化」就再也证明不了了。
- **S3 四条取假控制**：`scripts/asr-extraction-parity-check.test.mjs`，每条控制是独立具名用例；每条**先对未变异的同一临时树跑一次同一命令并断言退出 0**，再施加变异并断言非零 —— 否则「变异后必红」可能只是因为临时树本身跑不起来（本仓库已经付过代价的取假形态）。
- **S4 读数**：逐条跑 AC，stdout 落进 Evidence。

## AC

- [x] AC1 主读：`node scripts/asr-extraction-parity-check.mjs` 退出码 0；stdout 逐行给出 `inbound` / `direct-outbound` / `proxy-outbound` / `response-tolerance` 四组，每组带 `equal`，并有一行 `baseline sha256=<64hex>` 与一行 `baseline recordedFromCommit=<sha>`。
- [x] AC2「抽取前录制」是机械断言而不是承诺：`--check` 打印 `pre-extraction ok`，判词取自 `git show <recordedFromCommit>:src/shared/api.ts` 仍含内联的入站字段写入（`append('audio'`）且该提交是 HEAD 的祖先。取假控制：在工装里把基线 JSON 的 `recordedFromCommit` 改成一个不含该内联写入的提交，同一命令必须非零退出且判词含 `baseline-not-pre-extraction`。
- [x] AC3 取假形态 ①：临时 git worktree 里把入站字段 `audio` 改成 `file`（改的是**出货源文件**；替换处数断言 `=== 1`；命中文件由 `grep -rl "append('audio'" src/ shared/ server/` 解析而不是写死路径），`node scripts/asr-extraction-parity-check.mjs --root <工装>` 非零退出且 stdout 指名 `inbound`；同一份工装在**未变异**时同一命令退出 0。
- [x] AC4 取假形态 ②：另一条独立用例，在临时 worktree 里把接缝 `parseTranscriptionResponse` 的非 JSON 分支改成返回原文（即与代理同一种容忍度），同一命令非零退出且 stdout 指名 `response-tolerance`；未变异时退出 0。
- [x] AC5 空读数不是绿：把工装里的 reader 删掉 ⇒ 非零退出且判词含 `reader-missing`；把 reader 改成打印空读数并退出 0 ⇒ 非零退出且判词含 `no readings`。
- [x] AC6 驱动的是出货代码：`node scripts/asr-extraction-parity-check.mjs --explain-sites` 退出码 0，逐组打印所驱动的绝对路径 + 符号名，四组 realpath 全在出货树内（`src/shared/api.ts`、`server/modules/voice/voice.service.ts`，或抽取后承载同一实现的那些文件）；独立读数 `grep -rn "audio/transcriptions" experiments/voice-asr-parity/` 无命中。
- [x] AC7 静态门：`npm run typecheck` 退出码 0（新增的 `scripts/*.mjs` 由 `scripts/tsconfig.json` 的 `checkJs` 覆盖）；`npm run lint` 退出码 0。
- [x] AC8 既有语音读数不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts`、`npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts`、`npx vitest run src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 三条命令各自退出码 0。
- [x] AC9 控制文件真的会被跑：`node scripts/list-script-tests.mjs` 退出码 0 且输出含 `scripts/asr-extraction-parity-check.test.mjs`；`node --test scripts/asr-extraction-parity-check.test.mjs` 退出码 0，AC2–AC5 的每条控制各为一个具名用例。
- [x] AC10 控制的控制：每个变异用例在施加变异前先对同一临时树断言退出 0（防「恒红」），变异后断言非零，并断言变异命中数 `=== 1`（命中 0 处即该用例红 —— 「没改到东西」不许读成绿）。
- [x] AC11 基线里没有环境值：`grep -rn "process.env" experiments/voice-asr-parity/ scripts/asr-extraction-parity-check.mjs` 无命中；基线 JSON 的 `audio.sha256` 等于 reader 声明的合成音频常量的 sha256，且 `--explain-sites` 打印 `fixture synthetic`。

## DoD

真实落地判据不是「探针文件存在」、也不是「基线 JSON 存在」，而是三件事同时成立：

(a) **基线录在抽取之前，且这件事机械可红** —— provenance 的 `recordedFromCommit` 上 `src/shared/api.ts` 仍含内联的入站字段写入（AC2）；把它换成抽取之后的提交，判据必须红；
(b) **抽取之后同一命令逐字节复现四组读数** —— AC1 全绿，且两组取假形态各自能把它打红（AC3 / AC4），其中入站那一跳与响应那一半**各自**被覆盖（这正是 AC 点名的两条变体）；
(c) **判据自己不是空读数** —— reader 缺失、reader 空输出、接缝缺失三种情况都红（AC5），每条控制先证未变异为绿再证变异为红（AC10），且所驱动的四组读数 realpath 全在出货树内（AC6）。

**本任务不证明**目标层命题（换识别服务不改路由与 UI）—— 那要第二个 provider 与能力声明（AC-132/133/134/135）；本任务只证明「抽取这一步本身不产生任何线上字节变化」，它是那条目标命题的守卫，不是它本身。

**若客户端 reader 在 `npx tsx` 下无法加载出货客户端模块**（未知的 import 链障碍）：不得自行放宽判据 —— 不许把入站那一跳从四组里去掉、不许改成驱动 reader 自己的一份实现、不许把 `--root` 控制降级成「只跑一次看看」；必须把原始判词（进程 stdout/stderr 原文）落进 Evidence 并停在 needs-human。

**接缝消失同样是判据红，不是判据过时**：删掉 `parseTranscriptionResponse` 的人必须把本判据的读数点搬到新接缝上 —— `--explain-sites` 存在的唯一理由就是让这次搬迁被看见。

L_D 该轴仍暗，理由：本任务只录一条字节基线并钉住它，不引入任何领域数据能力，也没有可读出的领域读数。

L_G 该轴仍暗，理由：本任务量的是「抽取前后字节相等」这一守卫，不产出目标层读数 —— 「换识别服务不改路由与 UI」由 GOAL-008 的其余判据承担。

## Touches

- src/shared/api.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- experiments/voice-asr-parity/read-client.ts (new)
- experiments/voice-asr-parity/read-server.ts (new)
- scripts/asr-extraction-parity-check.mjs (new)
- scripts/asr-extraction-parity-check.test.mjs (new)
- scripts/__fixtures__/asr-extraction-parity-baseline.json (new)
- tasks/gap-asr-extraction-parity-baseline.md

## Needs-Human

**执行 2026-09-22T15:50:43.573Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=5540 server/modules/debug-agent/tests/debug-agent-gate.test.ts passed=false end_ms=1790092215314
- run_id：wk-prod-anchor
- session_id：a688f7bb-06e5-4f78-8e74-75f8d35bdefc
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-asr-extraction-parity-baseline~wk-prod-anchor~1790092126525-f66c65.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-asr-extraction-parity-baseline-wk-prod-anchor.log
