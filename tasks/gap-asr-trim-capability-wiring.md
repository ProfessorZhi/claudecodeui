---
id: gap-asr-trim-capability-wiring
title: 裁剪 × 识别器能力的接线：pauseCues 驱动裁剪且默认不变，capabilities 成为裁剪决策唯一来源（AC-135）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-extraction-parity-baseline
goal_ac: AC-135
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：全仓无任何任务声明 AC-135；`task_list` 全文检索「裁剪 × 识别器 / 能力接线」未命中以同一机制立案的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129）、`gap-asr-extraction-parity-baseline`（AC-130）、`gap-asr-second-adapter-inline-only`（AC-132，落适配器与能力声明）与 `gap-asr-mime-whitelist-and-size-layering`（AC-133）—— 都不把「裁不裁」接到能力声明上。本任务是 ADR-004「后续任务 9」的立案。

**现场。** 「裁不裁」今天不是一个可声明的属性：裁剪门逻辑住在客户端 hook 里，与识别器无关。而在 ADR-004 背景第二节里，这是一条**已测量**的设计级结论：裁剪把中文句读打到 −89%，而 CER 只 +0.52pp（CER 对标点损失失明）；同时裁剪省下 25.5%（中文）/ 13.3%（英文）的账单 —— 在按秒计费的服务上「裁了省钱」，在多模态大模型上「留着可能换回标点」。因此「裁不裁」必须成为**识别器自己声明的属性**（`capabilities.pauseCues`），而今天没有任何地方能表达它。

**本任务做什么。** `capabilities.pauseCues === 'destructive'` 走裁剪（这是 Whisper 系的实测结论）；裁剪决策的**唯一来源**收敛到 `capabilities` 的读取点；**默认行为不变** —— 既有的「裁剪开/关配对下上传体时长下降」端到端判据保持绿（`isVoiceTrimEnabled()` 默认 `true`，hook 里的裁剪门逻辑不动）。

**一条纪律（记录在案，不改默认）。** 把某个 provider 从 `destructive` 改成 `useful` **必须附带该 provider 自己的配对实验**（同语料、`flat` 负对照、四轴读数），不得只改一行声明；且裁剪与风格化的交互必须**测**，不能推（ADR-004 明确禁止用输出侧差异去解释输入侧变化）。

**边界（不做）。** 不改两条路径的路由与 UI（AC-129/AC-130/AC-133/AC-134）；不落第二个适配器（AC-132）；不做质量实验记录（决策 8）；不调 `PAUSE_CAPS` 与 VAD 参数（`voiceTrim.ts` 已定死）；不把「裁不裁」改成全局开关。

## Plan

- **S0 收敛读取点。** 把裁剪决策的依据收敛到 `capabilities.pauseCues` 的**唯一**读取点；`destructive` ⇒ 按现状裁剪。
- **S1 默认不变。** `isVoiceTrimEnabled()` 默认 `true`，既有裁剪门逻辑不动；既有时长下降端到端判据保持绿。
- **S2 探针与两条取假控制。** 各成一条独立可红用例；先证未变异为绿、再证变异为红。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence。

## 落地证据

### 实现（写入面）

`src/shared/voiceTrim.ts` 新增声明与读取点：`PauseCues`（`'destructive' | 'neutral' | 'useful'`）、`PauseCuesDeclaration`（`provider` / `pauseCues` / `evidence?`）、`OPENAI_COMPATIBLE_PROVIDER`、`DEFAULT_PAUSE_CUES_PROVIDER`、`PAUSE_CUES_DECLARATIONS`（1 行：`openai-compatible` = `destructive`，`evidence` 指 `docs/experiments/2026-09-22-voice-provider-paired-quality.md`）、`pauseCuesFor(provider)`（未声明的 id 落到默认行）、`trimDecisionFor(pauseCues)` —— **唯一**把能力读成「裁不裁」的函数。`src/modules/chat/hooks/useVoiceInput.ts` 的 `prepareUpload` 把 `if (!isVoiceTrimEnabled()) return recorded;` 换成 `pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER)` + `trimDecisionFor(...).trim`，与用户开关**相与**：开关只能把裁剪关掉，不能在没有能力支持时打开它；未声明的识别器回落默认行（`destructive`），故默认行为不变。类型放在 `voiceTrim.ts` 而非 `src/shared/types.ts`，与本模块既有领域类型（`TrimStats` / `TrimResult` / `VadOptions` / `VadSegment`）的落点一致。

### AC1 —— `destructive` 走裁剪

```
$ node scripts/asr-trim-capability-check.mjs
declaration module: src/shared/voiceTrim.ts
check declaration: ok src/shared/voiceTrim.ts declares PAUSE_CUES_DECLARATIONS with 1 row(s)
declared provider=openai-compatible pauseCues=destructive evidence=docs/experiments/2026-09-22-voice-provider-paired-quality.md
check read-point: ok src/shared/voiceTrim.ts reads the capability at trimDecisionFor
check single-source: ok 1 production file(s) reach trimDecisionFor: src/modules/chat/hooks/useVoiceInput.ts; no file answers 裁不裁 by hand
check decision: ok trimDecisionFor takes the trim path for openai-compatible and declines it for useful
check default: ok an undeclared recogniser falls back to destructive and is trimmed; src/shared/voiceDebug.ts's own default is true — the shipped chain still trims
check discipline: ok every declaration outside destructive names its own paired experiment, and every named record exists
$ echo $?
0
```

`decision` 是行为读数而非名字匹配：探针在声明模块的导出里找「对 `destructive` 与 `useful` 给出不同布尔答案」的那一个，并要求它对自己那一行取裁剪分支、对 `useful` 拒绝裁剪。`check decision` 那行逐字给出取值与 provider。

### AC2 —— 默认不变（真实端到端，含取假变体）

真实树绿（`npx playwright test e2e/voice-trim.spec.ts`，真实 Chromium + 真实后端 + 假麦克风）：

```
[1/4] AC-119 the trimmed upload is shorter than the same recording uploaded untrimmed
[voice-trim] uploads: trimmed=1.850s untrimmed=2.640s fixture=2.600s
[2/4] AC-120  [voice-upload] trimmed: file=2.600s uploaded=1.650s source=file
[3/4] AC-121
[4/4] AC-122  [voice-replay] original=2.640s/17416B trimmed=1.850s/177644B
  4 passed (40.2s)
```

取假变体（把唯一那一行的 `pauseCues` 逐字改成 `'useful'`，只改这一个字面量，其余不动）：

```
$ npx playwright test e2e/voice-trim.spec.ts -g "AC-119"
[voice-trim] uploads: trimmed=2.640s untrimmed=2.640s fixture=2.600s
Error: trimmed 2.64s vs untrimmed 2.64s
  expect(received).toBeGreaterThan(expected)
  > 785 | expect(plainSec - trimmedSec, `trimmed ${trimmedSec}s vs untrimmed ${plainSec}s`).toBeGreaterThan(MIN_SAVING_SEC);
  1 failed
$ echo $?
1
```

即「默认改成不裁」确实让既有时长下降判据红 —— 而不是靠断言之外的推理。变异已回退，回退后探针复绿（见 AC3 的 stdout）。AC-119/120/121/122 四条既有端到端读数在真实树上全绿，故「既有语音读数不变」。

### AC3 —— 唯一来源（含取假变体）

唯一读取点的**符号名**由探针打印：`check read-point: ok src/shared/voiceTrim.ts reads the capability at trimDecisionFor`；消费面读数：`check single-source: ok 1 production file(s) reach trimDecisionFor: src/modules/chat/hooks/useVoiceInput.ts; no file answers 裁不裁 by hand`。

取假变体（把 hook 还原成「客户端自己判断」：`prepareUpload` 的门换回 `if (!isVoiceTrimEnabled()) return recorded;`，并去掉能力的三个 import），真实树上实测：

```
$ node scripts/asr-trim-capability-check.mjs
check single-source: FAIL no production file reaches trimDecisionFor — the capability is declared and never read, so 裁不裁 is still decided elsewhere (trimDecisionFor is unreachable)
reason single-source: no production file reaches trimDecisionFor — the capability is declared and never read, so 裁不裁 is still decided elsewhere (trimDecisionFor is unreachable)
$ echo $?
1
```

第二处「自行判断」的形态（消费者在读取点旁边手写 `pauseCues === 'destructive'`）由 `scripts/asr-trim-capability-check.test.mjs` 里的独立用例覆盖；探针的手写比较扫描跑在**全部**生产文件上（不只是读取点的消费者），所以「既读了能力又自己判断」也红。变异已回退。

### AC4 —— 两条取假形态各一条独立可红用例

```
$ node --test scripts/asr-trim-capability-check.test.mjs
✔ the shipped tree decides 裁不裁 from the recogniser declaration
✔ green fixture — the falsifiers below start from a passing tree
✔ a consumer that keeps deciding 裁不裁 for itself reds single-source (AC3 fake: the capability is never read)
✔ a consumer that answers 裁不裁 by hand beside the read point reds single-source (AC3 fake: a second read point)
✔ changing the declared default to "do not trim" reds default (AC2 fake: the shipped pairing must red)
✔ a read point that answers the same thing for both capabilities reds read-point (AC5 fake: the empty reading)
✔ a non-destructive declaration with no experiment to point at reds discipline (AC7)
✔ a fixture whose declaring module is deleted reds declaration rather than passing on an empty scan
✔ a declaration table with no rows reds declaration with the zero-row cause (AC5)
ℹ tests 9
ℹ pass 9
ℹ fail 0
$ echo $?
0
```

每例先跑未变异 fixture 并要求绿（`greenFixture` 内断言），再施加**恰好一处**变异（`patch` 断言目标串在文件里恰好出现一次，否则报错而不是静默测了未变异的树），并要求指定 check 名失败 —— 只证「退出非零」是不够的，一个本来就坏的 fixture 也能满足。fixture 由**出货文件复制**而成（`cpSync`，不是手写桩），因此探针读的是真文件。

### AC5 —— 空读数不是绿（两条臂，真实树）

臂一（读数条数为 0：把声明表置空 `= [];`）：

```
$ node scripts/asr-trim-capability-check.mjs
check declaration: FAIL no exported declaration table in src/shared/voiceTrim.ts has a row — a table with 0 rows is a zero-row reading, not a pass
$ echo $?
1
```

臂二（唯一读取点解析为空：读取点被掏空成对两种能力同答，探针找不到判别性导出）：

```
check read-point: FAIL no export of src/shared/voiceTrim.ts answers differently for destructive than for useful — the capability is not read anywhere
$ echo $?
1
```

（臂二由 `scripts/asr-trim-capability-check.test.mjs` 的 `read point gutted` 用例在 fixture 上断言；声明模块被删的空扫描形态亦有一条用例。）两处变异均已回退。

### AC6 —— 既有语音读数不变

```
$ npx vitest run src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
 Test Files  1 passed (1)
      Tests  3 passed (3)
$ echo $?
0
$ npm run typecheck   ; echo $?
0
$ npm run lint        ; echo $?
0
```

### AC7 —— 纪律可核

探针逐行打印当前取值与其 provider：`declared provider=openai-compatible pauseCues=destructive evidence=docs/experiments/2026-09-22-voice-provider-paired-quality.md`。取假变体（把该行改成 `useful` 并删掉 `evidence`，真实树实测）：

```
$ node scripts/asr-trim-capability-check.mjs
check decision: FAIL no declared recogniser takes the trim path — the decision is inert
check default: FAIL an undeclared recogniser falls back to useful, which does not take the trim path — the default changed what gets uploaded
check discipline: FAIL openai-compatible=useful declares a non-destructive capability with no paired experiment to point at
$ echo $?
1
```

`discipline` 还检查被点名的实验记录**文件存在**（`existsSync`），所以「指向一个不存在的实验」同样红。变异已回退。

### 记录修正（Touches）

写入面除 Touches 已列的五个文件外，还改了 `src/modules/chat/tests/voiceClipPlayback.test.tsx`：它用 `vi.mock('@/shared/voiceTrim', () => ({ trimVoiceAudio }))` **整体替换**该模块，于是 hook 新读的 `pauseCuesFor` / `trimDecisionFor` 在那里是 `undefined`，5 条既有用例红（`No "pauseCuesFor" export is defined on the "@/shared/voiceTrim" mock`）。修法是让该 mock 先 `...await importOriginal()` 再只覆盖 `trimVoiceAudio` —— 它自己不该携带「裁不裁」的答案。按 anti-drift 的要求把该字面路径补进 Touches，由 AC6 强制。修正后该文件 17 passed。

### 诚实边界

- 探针把**测试文件**排除在「生产源码」之外（`*.test.*` / `tests/` 路径段），否则本任务自己的 spec 会被算成第二个消费者，`single-source` 读数会虚高。这一排除不改变两条取假形态的可红性。
- 本任务不证明某个 provider 的 `pauseCues` 取值是对的；AC7 只要求「取值非 `destructive` 时必须指得到自己的配对实验记录」。
- AC2 的取假变体是在真实树上真实跑出来的（见上），不是推理。

### 合并 develop 后的观察（指出面，不在本任务写入面内）

合并 `develop`（`ecf5c41e`）后，AC-132 的适配器缝进入本分支，树上出现**第二处** `pauseCues` 声明面：`shared/asr/asrRegistry.ts:61` 的 `AsrCapabilities.pauseCues: 'destructive' | 'neutral' | 'useful'`，以及 `shared/asr/list/multimodal/multimodal.asr-provider.ts:69` 的 `pauseCues: 'useful'` —— 后者**没有**指向任何配对实验（`grep -rn multimodal docs/` 无命中；`docs/experiments/` 下唯一的相关记录是 `2026-09-22-voice-provider-paired-quality.md`，讲的是 `turbo`/`v3` 两个 openai-compatible provider）。

本任务**没有**覆盖它：探针的声明面读数只读**裁剪决策**的声明表（`src/shared/voiceTrim.ts` 的 `PAUSE_CUES_DECLARATIONS`），而浏览器裁剪路径的识别器是 `OPENAI_COMPATIBLE_PROVIDER` —— `shared/asr/*` 是服务端/CLI 编译的注册表，`useVoiceInput` 不读它。所以 AC7 的「某 provider 取值为 `useful` 必须指到实验」目前只在**能到达裁剪路径**的声明上成立（该表只有一行 `destructive`，这条臂在出货树上为空真）。把两条缝并成一条（让浏览器侧读 `AsrCapabilities`、并让 multimodal 那行 `useful` 指到它自己的配对实验）需要改 `shared/asr/*`，而那是 AC-132 的写入面、不在本任务 Touches 内（anti-drift 会硬失败），故按边界如实记录而不越界修改。合并后探针仍绿（`scan: 622 production sources`，六条检查全 ok）。

## AC

- [x] AC1 `pauseCues: destructive` 走裁剪：断言裁剪决策读到的取值与走裁剪一致。（`check decision: ok trimDecisionFor takes the trim path for openai-compatible and declines it for useful`）
- [x] AC2 **默认行为不变**：既有的「裁剪开/关配对下上传体时长下降」端到端判据保持绿。取假变体：把默认改成「不裁」⇒ 既有时长下降判据必须红。（真实树 `4 passed`，`trimmed=1.850s untrimmed=2.640s`；取假变体 `1 failed`，`trimmed 2.64s vs untrimmed 2.64s`）
- [x] AC3 `capabilities` 的读取成为裁剪决策的**唯一来源**：探针打印唯一读取点的**符号名**；出现第二处「自行判断裁剪」的读取点即红。取假变体：把裁剪决策仍留在客户端各自判断（不读能力）⇒ 「能力是唯一来源」必须红。（`reads the capability at trimDecisionFor`；取假变体 `single-source: FAIL … trimDecisionFor is unreachable`，退出 1）
- [x] AC4 两条取假形态各为 `scripts/asr-trim-capability-check.test.mjs` 内一条独立可红用例；`node --test scripts/asr-trim-capability-check.test.mjs` 退出码 0，且每条先证未变异为绿、再证变异为红。（`tests 9 / pass 9 / fail 0`，退出 0）
- [x] AC5 空读数不是绿：裁剪决策的读数条数为 0、或唯一读取点解析为空 ⇒ 探针非零退出。（置空声明表 ⇒ `declaration: FAIL … a table with 0 rows is a zero-row reading`，退出 1；掏空读取点 ⇒ `read-point: FAIL`）
- [x] AC6 既有语音读数不变：`npx vitest run src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx` 退出码 0；`npm run typecheck` 与 `npm run lint` 退出码 0。（三者退出码均为 0；vitest `3 passed`）
- [x] AC7 纪律可核（不改默认）：探针打印 `pauseCues` 的当前取值与其对应的 provider；若某 provider 取值为 `useful`，必须能指到该 provider 自己的配对实验记录路径，否则红。（`declared provider=openai-compatible pauseCues=destructive evidence=docs/experiments/…`；取假变体 `discipline: FAIL … with no paired experiment to point at`，退出 1。覆盖范围见「合并 develop 后的观察」）

## DoD

真实落地判据：不是「多了一次 `capabilities` 读取」，而是**「裁不裁」由识别器的能力声明唯一决定，且默认行为与既有端到端读数都不变**。承重性由三组正面读数证明：

(a) `destructive` 走裁剪，且**默认不变** —— 既有的「裁剪开/关配对下上传体时长下降」判据仍绿（AC1/AC2 的读数）；
(b) 「能力是唯一来源」是可红的：把裁剪决策留在客户端各自判断的形态必须是红（AC3 及其取假变体）；
(c) 把默认改成「不裁」必须让既有时长下降判据红（AC2 的取假变体）—— 否则「默认行为不变」是一句没被测量的声明。

**本任务不证明**某个 provider 的 `pauseCues` 声明是对的 —— 那要靠该 provider 自己的配对实验（AC7 只要求「取值为 `useful` 时能指到实验记录」）。

L_D 该轴仍暗，理由：本任务只把裁剪决策接到能力声明上并保持默认，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/voiceTrim.ts
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx (new)
- scripts/asr-trim-capability-check.mjs (new)
- scripts/asr-trim-capability-check.test.mjs (new)
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- tasks/gap-asr-trim-capability-wiring.md


判据退役登记（2026-10-04，人 yale 授权，见 tasks/gap-voice-single-continuous-input-path.md 的 Resolution）：本任务 AC2 的判据（既有「裁剪开/关配对下上传体时长下降」端到端判据，即 `npx playwright test e2e/voice-trim.spec.ts -g "AC-119"`）随 AC-119 一同退役 —— 该腿的被测对象（MediaRecorder 原始流与批处理裁剪 on/off 配对）已由 gap-voice-single-continuous-input-path 按 Proposal 移除，判据命令在出货树上必然 No tests found，不得再把它的红读成本任务的回归。替代读数：本任务守护的不变量（默认行为不变）改由 e2e/voice-continuous.spec.ts 承担 —— 短输入（voiceMinSegmentSec=30）恰好 1 个请求、输入框等于该请求返回（该 spec 的 a short dictation is exactly one request and fills the box with its answer 腿）。AC1 与 AC3..AC7 的判据与结论不受影响。