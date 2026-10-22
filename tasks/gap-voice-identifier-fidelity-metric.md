---
id: gap-voice-identifier-fidelity-metric
title: 标识符逐字存活率指标并接入语音链路读数
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-identifier-harness-in-repo
goal_ac: AC-114
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-005 的标识符逐字存活率指标（AC-114）：既实现指标本身与单元测试，又把该读数接入语音链路的转写回填处，且只输出读数、不改交互。

### 现状与缺口

既有 CER 口径的 `normalize()` 删除空格与标点，于是 `voice.service.ts` 与 `voice service ts` 归一化后完全相同——本指标要证明的正是这件事：以 CER 验收语音质量会产生「指标全绿但 agent 改错文件」的假通过。实测证据：某次改动把 `Use voice.Input` 修成 `useVoiceInput`（标识符实际被修正），而 CER 报告 0.00% 变化。

### 方案

1. `src/shared/identifierFidelity.ts`：导出纯函数，对参考文本与转写文本按保留标点与大小写的口径计算标识符逐字存活率。
2. `src/shared/tests/identifierFidelity.test.ts`：三条断言——(1) 对 `('voice.service.ts', 'voice service ts')` 该指标判存活率 0；(2) 同一对文本经既有 CER 口径归一化后相同，即证明 CER 对本失效失明；(3) 经修复后同一对文本存活率回升到 1。
3. `src/modules/chat/hooks/useVoiceInput.ts`：在转写回填处只输出该读数，⛔ 不改交互、不改请求流程。

按 AGENTS.md，`src/` 适用 `$frontend-module-standards`；新测试须经模块 barrel 导入。

### 边界（不做）

不改交互（请求合并、连续录音、延迟出字一律不做）；不改 `server/modules/voice/` 的接口契约；不实现修复模块（由 AC-113 承载）。

## AC

- [x] `npx vitest run src/shared/tests/identifierFidelity.test.ts` 退出码 0
- [x] 断言 (1)：对 `('voice.service.ts', 'voice service ts')` 该指标判存活率 0
- [x] 断言 (2)：同一对文本经既有 CER 口径归一化后相同（证明 CER 对本失效失明，本条同时是对该论断的回归保护）
- [x] 断言 (3)：经修复后同一对文本存活率回升到 1
- [x] `src/modules/chat/hooks/useVoiceInput.ts` 的转写回填处只输出该读数、不改交互
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是测试文件存在，而是三条断言在真实实现上成立，且指标真的区分得开修复前后（用 CER 代替本指标则 `voice service ts` 会被判满分，断言 (1) 必须红）。语音链路的读数必须在真实回填路径上被输出，而不是测试里的孤立调用；同时用 `git diff develop...HEAD -- src/modules/chat/hooks/useVoiceInput.ts` 证明该文件只增读数、交互行为零改动。

L_D 该轴仍暗，理由：本任务只落地一个读数指标与其接入，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是指标函数在固定文本对上的取值，不是生成质量轴读数。

### 完成记录（2026-09-21）

落地三件：`src/shared/identifierFidelity.ts`（纯函数，无 React/DOM；导出 `findIdentifiers`、`identifierFidelity` 与类型 `IdentifierFidelityReading`）、`src/shared/tests/identifierFidelity.test.ts`（8 例）、`src/modules/chat/hooks/useVoiceInput.ts`（回填处输出读数）。口径：逐字 = 保留标点与大小写、忽略空白。

与仓库内 harness 端口 `experiments/voice-identifiers/identifierFidelity.mjs` 刻意不同，理由写进模块头注释：该端口两侧皆小写，实测对 `Use voice input` → `useVoiceInput` 读作 1/1（失明），本模块读 0 → 1。

命令逐条实录：

- `npx vitest run src/shared/tests/identifierFidelity.test.ts` → 8 passed / exit 0。
- 断言 (1)：`identifierFidelity('voice.service.ts', 'voice service ts')` → `{total:1, survived:0, rate:0, missing:['voice.service.ts']}`。
- 断言 (2)：同一对文本 `cerNormalForm` 相等且 `cer(...) === 0`，而本指标 `rate === 0`——同一份数据上满分与零分的反向判决就是失明本身。该 CER 口径逐字抄自 `/data/home/yale/work/tc-verify/tools/metrics.mjs` 的 `normalize()` / `chars()` / `cer()`，刻意留在测试内、不进生产模块（生产侧多一个无人使用的相似度口径会让这条论断自证）。
- 断言 (3)：`identifierFidelity('voice.service.ts', 'voice.service.ts')` → `rate: 1, missing: []`。
- 负对照（承重性）：把 `identifierFidelity` 换成 CER 口径（`rate = 1 - cer(ref, hyp)`）后重跑，断言 (1) 与 (2) 均红（`expected 1 to be +0`），8 例中 5 红；`sha256sum -c` 证回字节一致（还原前后同为 `8cc2d4dded203d087ca46f43358702feba0e27c5a3d1a65f2a552a1c49cb97bd`），还原后 8/8 绿。
- 真实回填路径（临时探针驱动真实 `useVoiceInput`，`vi.mock('@/shared/api')` 掉 `transcribeVoice`，跑完即删，未留在提交里）：转写 `Look at how the Use voice input hook handles recording.` → 读数 `{total:0,survived:0,rate:null}`、`onTranscript` 收到 `'Look at how the Use voice input hook handles recording.'`；转写 `…useVoiceInput…` → `{total:1,survived:1,rate:1}`；命名对 `voice service ts` → `{total:0,…}`。即读数确实由真实回填路径产出，且 `onTranscript` 的实参与调用条件在改动前后一致。
- 指标确实区分得开修复前后（在 harness fixture en-e03 上，候选集 1962 个）：`experiments/voice-identifiers/identifierRepair.mjs` 对 `Use voice input` 给出 `{from:'Use voice input', to:'useVoiceInput', score:1, exact:true}`；以 `intended` 为参考，本指标对该对文本 before `rate 0 / missing ['useVoiceInput']` → after `rate 1`。
- `npm run lint` → exit 0；`npm run typecheck` → exit 0。

关于 Touches 里新增的 `.oxlintrc.json`：`useVoiceInput.ts` 属 `frontend-module`，import 新的 `src/shared/identifierFidelity.ts` 时 oxlint 的 `boundaries/no-unknown` 判其「Dependencies to unknown elements are not allowed」，因为该文件不在 `boundaries/elements` 的 `frontend-shared-file` 显式名单内。按同层既有文件 `src/shared/voiceConfig.ts` 的做法把它加入名单；不加入则 `npm run lint` 退出码 1，即 AC 直接失败。这是 AC 强制要求的写入面，故一并声明。

`git diff develop -- src/modules/chat/hooks/useVoiceInput.ts` 只有两类改动：一行 import，以及把 `const text = String(data?.text || '').trim()` 拆成 `raw` / `text` 两句并在 `if (text)` 分支内加一行 `console.debug`。`onTranscript(text, shouldSend)` 的实参、调用条件与 `else onError?.('No speech detected')` 的原有行为均未变，交互与请求流程零改动。

### 自评：本读数当前是 handoff 基线，不是质量读数

参考文本取的是识别器自己返回的 `raw`，因此只要转写里出现了标识符 `rate` 就是 1——它量的是「识别器给的文本有没有被后续环节改写」，而不是「识别器有没有听对」。这是链路当前的真实状态（回填处此刻没有任何东西夹在两个文本之间），所以它是基线读数；它的价值在于给确定性标识符修复钉一个可测的边界：修复一旦接入，`missing` 非空就意味着修复改写了转写从未携带的名字。读数经 `console.debug` 输出是刻意的：只存在于调试分支上的读数，不足以让真实路径被评判。

## Touches

- src/shared/identifierFidelity.ts (new)
- src/shared/tests/identifierFidelity.test.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- .oxlintrc.json
- tasks/gap-voice-identifier-fidelity-metric.md
