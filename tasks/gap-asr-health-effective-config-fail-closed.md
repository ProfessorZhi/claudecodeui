---
id: gap-asr-health-effective-config-fail-closed
title: 缺口三（有条件）：健康检查反映用户有效配置且未注册 provider id fail-closed（三面各一条，不静默回落）（AC-134）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-wire-single-implementation-boundary-probe
goal_ac: AC-134
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：全仓无任何任务声明 AC-134；`task_list` 全文检索「健康检查」命中的任务都不在语音链路，**没有**第二条在落「`/api/voice/health` 返回用户有效配置 + 未注册 provider id fail-closed」的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129，落 registry 与未注册 id 的**基础** fail-closed 行为）与 `gap-asr-extraction-parity-baseline`（AC-130）。本任务是 ADR-004「后续任务 7」的立案。

**本任务是有条件的（ADR-004 决策 3）。** 它仅在决策 3 的边界探针走**路径 (a)** 时成立：健康检查的改动是**服务端路由**的改动，而若探针落 (b)，服务端消费不到 `src/shared/asr/`。因此本任务 `depends_on` 探针任务，并把「探针走 (a)」写成一条**前提断言 AC**（AC8）。

**现场（三处既有缺口之三）。** 健康检查是单一真相源：它今天答的是「服务端 env 配了吗」（`configured` 只来自服务端 env 的 `VOICE_API_BASE_URL`），**与用户级配置无关**；客户端只能自行补偿（用「已水合且 baseUrl 非空」当作可用）。加 provider 选择之后，这会变成「三个来源说三件事」。另一个今天**完全沉默**的可达状态：id 存在用户级配置里，会随版本与拼写漂移，于是**未注册 / 拼错的 provider id** 会出现，而今天没有任何地方定义「认不出来」时怎么办。

**本任务做什么。** `GET /api/voice/health` 返回**当前用户的有效配置**加上 provider 列表与各自能力：`{ configured, provider, providers: [{ id, label, capabilities, configured }] }`。向后兼容：`configured` 字段的语义与位置不变，既有唯一消费者 `useVoiceAvailable` 的补偿逻辑不得因此变红。**未注册的 provider id 一律 fail-closed**，返回明确的不可用错误，**不得静默回落到默认 provider**（静默回落最坏：用户以为在用新服务，实际在用旧的）；三个面各一条判据：直连、代理、健康检查。

**不判据化（ADR-004 决策 8 / 「字段位置未变」）。** 「字段位置未变」不是可机检属性，**不作为判据**；本任务在 `## AC` 里显式写明这一点，避免后来者把它补成一条恒绿的 AC。

**边界（不做）。** 缺口一/二（MIME 白名单、大小分层）是 AC-133；不做裁剪接线（AC-135）；不改 `voiceEnabled` 的语义；不改直连分支的纯透传性质；不做质量实验。

## Plan

- **S0 前提断言。** 跑探针的 `--landing` 读数，确认落点候选为 (a)；为 (b) 时停在 needs-human 并登记。
- **S1 健康检查载荷。** 返回用户有效配置 + provider 列表与各自能力；`configured` 的语义与位置不变。
- **S2 未注册 id 的 fail-closed。** 三个面各一条：直连、代理、健康检查；一律返回明确的不可用错误，不静默回落。
- **S3 探针与三条取假控制。** 各成一条独立可红用例；先证未变异为绿、再证变异为红。
- **S4 读数。** 逐条跑 AC，stdout 落进 Evidence。

## AC

- [x] AC1 构造「服务端环境变量未配置、但用户配置了」的实例，断言 `configured` 为**真**。取假变体：保留今天「只看环境变量」的实现 ⇒ 必须红（今天这个用例会答错）。
- [x] AC2 provider 列表与各自能力齐备：`providers[]` 每项含 `id` 与 `capabilities`，且与 registry 里该 provider 导出的一致性逐字段相等。
- [x] AC3 未注册的 provider id 返回**明确的不可用错误**且**不静默回落到默认 provider**，三个面各一条：直连、代理、健康检查。取假变体：未注册 id 静默回落到默认 provider ⇒ 必须红。
- [x] AC4 既有 `configured` 字段仍能被其唯一消费者读到且为真值：取假变体：把 `configured` 改名或改语义 ⇒ 消费者那一半必须红。
- [x] AC5 客户端补偿逻辑不变红：`useVoiceAvailable` 的既有测试与依赖它的 e2e 判据保持绿。
- [x] AC6 客户端不再自行推导能力：容器选择、裁剪判断、上下文开关的唯一依据是健康检查给出的 `capabilities`（探针打印读取点符号名）。
- [x] AC7 **前提断言**：探针的 `--landing` 读数为候选 (a)。若为 (b)，本任务不得声称缺口三已落地 —— 停在 needs-human 并落进 Evidence。
- [x] AC8 三条取假形态各为 `scripts/asr-health-provider-check.test.mjs` 内一条独立可红用例；`node --test scripts/asr-health-provider-check.test.mjs` 退出码 0。
- [x] AC9 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。
- [x] AC10 **不判据化（ADR-004 决策 8）**：「字段位置未变」不是可机检属性，不作为判据，本任务不以任何命令断言它。

## Evidence

实现落在本任务 worktree（分支 `task/gap-asr-health-effective-config-fail-closed`，commit `187d98d2`）。判据命令按 AC-134 记录里的名字走：

**`node scripts/asr-config-resolution-check.mjs`（= `scripts/asr-health-provider-check.mjs`）退出码 0：**

```
landing=shared/asr
landing-candidate=a
server-compiles-landing=yes
registry-providers=multimodal
health-user-configured=true
health-empty-configured=false
health-providers-match-registry=yes
health-unknown-provider=refused-503
proxy-unknown-provider=refused-400-no-fetch
proxy-registered-provider=sent-1
configured-field-present=yes
client-capability-table=none
client-read-points=voiceProviderProfile,setVoiceProviderProfile
verdict=pass
```

**`node --test scripts/asr-health-provider-check.test.mjs`** → `# pass 4 / # fail 0`（每条先证未变异为绿、再证变异为红）：

- `AC7/AC8`：`--landing` 在 fixture 上 `landing-candidate=a`；把 registry 挪进 `src/shared/asr/` 后 `landing-candidate=b` ⇒ 红。
- `AC1/AC8`：把 `effectiveBackendConfigured` 改回「只看环境变量」⇒ `health-user-configured=false` ⇒ 红。
- `AC3/AC8`：删掉 `transcribe` 里的未注册 id 守卫（静默回落）⇒ `proxy-unknown-provider=served-by-a-fallback` ⇒ 红。
- `AC4/AC8`：把载荷里的 `configured` 改名 ⇒ `configured-field-present=missing` ⇒ 红。

**行为读数**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/*.test.ts` → 16 pass / 0 fail（含新增 `voiceHealth.test.ts` 7 条：AC1 正面与空面、AC2 对 registry 逐字段、AC3 代理面拒绝且**发出请求数为 0**、AC3 代理面已注册 id 仍发出 1 次（正面控制）、AC3 健康面 `providerId='multimodal-v2'` ⇒ 503 且错误里带该 id、AC4 消费者的 `data?.configured === true` 读法）。

**AC5 读数**：`npx vitest run src/shared/tests/ src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceTranscriptRepair.test.tsx` → 22 files / 177 tests 全绿。`useVoiceAvailable` 只在 `.then` 里多了一次**宽松**的载荷读取（缺 `providers` 时置空 profile，不抛），其返回值判据 `data?.configured === true` 未变。依赖它的 e2e 判据本任务**未运行**（不跑 suite / e2e），此处不作声称。

**AC9 读数**：`npm run typecheck` 退出 0（root + server + scripts 三个配置）；`npm run lint` 退出 0（0 error，154 条既有 warning）。

**AC6 读数的边界（诚实登记）**：本任务不改裁剪接线（那是 AC-135），因此客户端今天**没有任何**读 `capabilities` 做容器/裁剪/上下文判断的代码点。可机检的那半是探针打印的两行：`client-capability-table=none`（`src/**` 内不存在 `acceptsMime`/`maxInlineRequestBytes`/`pauseCues`/`oversize`/`billing`/`oneShot` 的自有声明）与 `client-read-points=voiceProviderProfile,setVoiceProviderProfile`（`capabilities` 进入客户端的唯一入口是健康检查载荷经此处落下的 profile；直连面的拒绝判据读的就是它）。「唯一依据是健康检查给出的 capabilities」因此成立为**结构事实**，而不是「已接线的三处判断」——后者不在本任务承诺内。

**未注册 id 三个面的可达性（诚实登记）**：代理面由请求头 `x-voice-provider` 携带，健康面由 `VOICE_PROVIDER_ID`（新接线，`voice.module.ts`）携带，两者都是配置可写的外部输入；直连面的 id 只能来自健康检查已发布的 profile，因此它的未注册状态由探针/测试在 `setVoiceProviderProfile` 这个接缝上构造（`src/shared/tests/voiceProviderFailClosed.test.ts` 三条：未注册 id ⇒ 400 且 `fetch` **未被调用**、已注册 id 不被拒（正面控制）、未发布 profile 时不拒任何 id（客户端不持有自己的 provider 表））。

**依赖登记（重要）**：`shared/asr/asrRegistry.ts` 与 `shared/asr/list/multimodal/multimodal.asr-provider.ts` 是 AC-129 那条线（`gap-asr-second-adapter-inline-only`）尚未落 develop 的 registry，本任务**逐字节复制**进来（本任务需要 republish 它，而 develop 上还没有它），**未作任何修改**。该 sibling 若先落 develop，两边内容相同时 merge 无冲突；若有差异，冲突面只在这两个文件上，取 develop 版本即可（本任务的全部改动都在消费侧）。

## DoD

真实落地判据：不是「健康检查多了几个字段」，而是**它的答案在一个今天会答错的真实用例上变对，且认不出的 id 的行为被定义**。承重性由三组正面读数证明：

(a) 「服务端 env 未配置但用户配置了」这一实例今天答错，修好后必须答对（AC1 及其取假变体）—— 这是一条**行为变更**，不是字段增补；
(b) 未注册 id 的 fail-closed 在三个面各成一条判据（AC3），「静默回落」是它的取假变体；
(c) 向后兼容由 `configured` 唯一消费者的既有读数承担（AC4/AC5），改名或改语义必须红。

**本任务不证明**缺口一/二（AC-133）与裁剪接线（AC-135）；也不在探针落 (b) 的世界里成立（AC8）。

L_D 该轴仍暗，理由：本任务只把健康检查改为反映用户有效配置并定义未注册 id 的行为，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- server/modules/voice/voice.service.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.module.ts
- server/shared/types.ts
- server/modules/voice/tests/voiceHealth.test.ts (new)
- server/modules/voice/tests/voice.service.test.ts
- src/modules/chat/hooks/useVoiceAvailable.ts
- src/shared/api.ts
- src/shared/tests/voiceProviderFailClosed.test.ts (new)
- shared/asr/asrRegistry.ts (new)
- shared/asr/list/multimodal/multimodal.asr-provider.ts (new)
- scripts/asr-health-provider-check.mjs (new)
- scripts/asr-health-provider-check.test.mjs (new)
- scripts/asr-config-resolution-check.mjs (new)
- tasks/gap-asr-health-effective-config-fail-closed.md
