---
id: gap-voice-asr-token-confidence-contract
title: ASR 契约增加词级置信度与时间、运行位置与构建标识：能力声明、成功结果的 tokens 字段、不变量与传输解析（不接入任何新识别器）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-correction-feedback-loop.md` §5.9「本地识别器、置信度」、§5.10 与阶段 0；同机制去重：`grep -il 'token.*置信\|tokenConfidence\|词级置信' tasks/*.md` 无命中；相关但不同的是 `gap-asr-adapter-invariant-suite`（已有适配器不变量套件，本任务在它之上**加一条能力声明与对应不变量**）。

### 现状

`shared/asr/asrRegistry.ts` 的 `AsrCapabilities` 只声明 `honors`、`maxInlineRequestBytes`、`billing`、`style`、`pauseCues` 等；`AsrSuccess` 只有 `text`、`style`、`transformations`、`providerId`、`meta`。**没有任何位置能带「每个词的置信度与时间」**，所以本地 SenseVoice（置信度 AUROC 0.93，见提案 §5.9）接进来时没有落点。

### 要交付的五件事

1. `AsrCapabilities` 新增 `tokens: { confidence: boolean; timestamps: boolean }`（现有三个适配器 `openai-compatible`、`multimodal`、`dashscope-omni` 显式声明 `false / false`）和 `locality: 'remote' | 'local-server' | 'local-client'`（现有三个声明 `'remote'`）。
2. `AsrSuccess` 新增可选 `tokens?: Array<{ text: string; confidence?: number; startMs?: number }>`，`AsrSuccess.meta` 新增可选 `buildId?: string`（本地引擎的构建标识：同一段音频在不同构建产物上文本与置信度可能不同，见提案 §5.9）。
3. **不变量**（`shared/asr/asrInvariants.ts`）：声明 `tokens.confidence = true` ⇒ 每个成功结果都带 `tokens`，且每个 token 的 `confidence` ∈ [0, 1]；声明 `tokens.timestamps = true` ⇒ 每个 token 带非负的 `startMs`；声明为 `false` ⇒ 成功结果里不得出现带 `confidence` 的 token。
4. **传输**（`shared/asr/transcriptionWire.ts`）：`/api/voice/transcribe` 的响应带上 `tokens` 与 `meta.buildId`，**向后兼容**——旧客户端忽略未知字段；客户端解析（`parseTranscriptionResponse`）在 strict 模式下**不丢这些字段**。
5. 现有三个适配器的行为**零变化**（回归）：它们的输出与改动前逐字相同。

### 已知陷阱（立案时从仓库记录得到）

在被整体 `vi.mock` 的共享模块里**新增导出**，会让同级测试里没补全 mock 的文件变红（反漂移）。动手前先 `grep -rln "vi.mock(.*asrRegistry\|vi.mock(.*shared/asr" src server shared`，把会受影响的 sibling 测试列进 Touches 并补齐 mock；实现遵循 `.agents/skills/backend-module-standards`（`server/`）与既有 `shared/asr` 的写法。

### 边界（不做）

不新增任何识别器适配器（见 `gap-voice-sensevoice-server-adapter`）；不改 UI；不改 provider 选择逻辑。

## AC

- [x] `npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts` 退出码 0，且该文件新增的用例覆盖：三个现有适配器 `tokens` 都为 `false / false`、`locality` 都为 `'remote'`；声明 `confidence: true` 的假适配器返回带 `tokens` 的成功结果时不变量通过
- [x] 负对照：同一测试里，假适配器声明 `tokens.confidence = true` 但成功结果**不带** `tokens`（或某个 `confidence` 为 1.2、`-0.1`），不变量检查必须抛出；把对应检查注释掉后该断言必须变红（用例里以 `redWhenOff` 形式或等价的对照写出）
- [x] 往返：带 `tokens` 与 `meta.buildId` 的响应体经 `parseTranscriptionResponse(..., 'strict')` 解析后逐项保留；不带 `tokens` 的旧响应体解析结果与改动前的快照逐字相同（单测）
- [x] 回归：`node scripts/asr-contract-invariants-check.mjs`、`node scripts/asr-capability-check.mjs`、`node scripts/asr-health-provider-check.mjs` 退出码 0；三个现有适配器对同一份输入的输出与改动前的录制 fixture 逐字相同（`npx vitest run src/shared/asr/tests/multimodalAdapter.test.ts server/modules/voice/tests/voice-provider-dispatch.test.ts` 退出码 0）
- [x] `grep -rln "vi.mock(.*asrRegistry\|vi.mock(.*shared/asr" src server shared` 列出的每个文件在改动后仍通过：对这些文件执行 `npx vitest run <文件们>` 退出码 0
- [x] `npm run typecheck` 与 `npm run lint` 退出码 0；`npm run build` 退出码 0

## DoD

真实落地判据：一个**真实写出的最小假适配器**（声明 `tokens.confidence = true`）走完整条链——适配器 → `voice.service` 响应 → `parseTranscriptionResponse` → 客户端拿到带置信度的 `tokens`；链上每一环都有断言，不是只测类型。现有适配器的零变化由录制 fixture 的逐字比对证明，不是「测试还绿」。

L_D 该轴仍暗，理由：本任务是契约与不变量，不引入新的领域数据。

L_G 该轴有读数：不变量对「声明与结果不一致」的假适配器报错（负对照），由测试给出。

## Touches

- shared/asr/asrRegistry.ts
- shared/asr/asrInvariants.ts
- shared/asr/transcriptionWire.ts
- shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts
- shared/asr/list/multimodal/multimodal.asr-provider.ts
- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- src/shared/asr/tests/asrContractInvariants.test.ts
- src/shared/asr/tests/multimodalAdapter.test.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-provider-dispatch.test.ts
- tasks/gap-voice-asr-token-confidence-contract.md
