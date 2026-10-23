---
id: gap-asr-pause-cues-second-source-contradicts-registry
title: 裁剪能力的第二份声明与 registry 矛盾：客户端用未注册 id `openai-compatible` 答
  `destructive`，与唯一适配器 `multimodal` 的 `useful` 相反（AC-134 回归）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-134
---
## Proposal

现场（时间线精确到秒）：AC-134 于 **2026-09-23 00:51:49** 判 `achieved`（判据 exit 0）；`488218c7`（`gap-asr-trim-capability-wiring` 的实现，标题「feat(voice): let the recogniser's declared pause capability decide 裁不裁」）于 **00:53:31** 落地；此后每一轮 goal round 对 AC-134 都判 `verdict: fail`，而它的 `status` 停在 `achieved`。`achieved` + `fail` 这个组合不会自动发出任务，GOAL-008 因此收不了口。

判词（AC-134 自己的判据 `node scripts/asr-config-resolution-check.mjs`，今天 exit 1）：

```
client-capability-table=declared-in-2-file(s)
failure=AC6: the client declares capabilities of its own in src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx, src/shared/voiceTrim.ts
verdict=fail
```

**不只是「多了一张表」，是两张表互相矛盾**：

| | 位置 | provider id | `pauseCues` | 该值意味着 |
| --- | --- | --- | --- | --- |
| registry，唯一注册的适配器 | `shared/asr/list/multimodal/multimodal.asr-provider.ts:69` | `multimodal` | `'useful'` | **不裁**（该文件注释：「pauses are punctuation cues, which is why this one is not [trimmed]」） |
| 客户端自建表 | `src/shared/voiceTrim.ts:376` | `openai-compatible` | `'destructive'` | 裁 |

而 `'openai-compatible'`（`src/shared/voiceTrim.ts:358`）**不是注册表里的任何 id**：`shared/asr/asrRegistry.ts` 的 `REGISTERED` 只有一项 `{ id: multimodalId }`，而 `id = 'multimodal'`。

读取点的实际形状（`src/modules/chat/hooks/useVoiceInput.ts:228`）：

```ts
const recogniser = pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER);
if (!isVoiceTrimEnabled() || !trimDecisionFor(recogniser.pauseCues).trim) return recorded;
```

`OPENAI_COMPATIBLE_PROVIDER` 是**硬编码**的，registry 的 `resolve` / `tryResolve` 在这条路径上一次都没被调用；`pauseCuesFor` 对未声明的 id 回落到 `DEFAULT_PAUSE_CUES_PROVIDER`（同一个 `'openai-compatible'`，`:367`）⇒ 拿到 `'destructive'` ⇒ `trim: true`。于是**裁剪照旧发生，恰好与唯一那个真实适配器声明的 `useful`（不该裁）相反**。trim 任务的标题声称「capabilities 成为裁剪决策唯一来源」，实际成为唯一来源的是它自己那张表。

**为什么 trim 任务自己的判据抓不到。** `scripts/asr-trim-capability-check.mjs` 量的是「裁剪决策只有一个读取点」这一**机制**（它打印 `check read-point: ok src/shared/voiceTrim.ts reads the capability at trimDecisionFor`），不是「读到的值来自 registry」这一**不变量**。一个读取点接在一张自建表上，对前者恒绿。

<!-- dedup-ref --> 同机制去重结论：`grep -rln "pauseCues|PAUSE_CUES_DECLARATIONS|trimDecisionFor|pauseCuesFor" tasks/` 命中 3 条任务，都不是本机制。`gap-asr-trim-capability-wiring`（AC-135，done）是**制造**这次回归的那条，其边界原文写着「不改两条路径的路由与 UI（AC-129/AC-130/AC-133/AC-134）」—— 它声明不碰 AC-134，却在机制上碰了，故本条不是它的重述，而是它的回归修复。`gap-asr-second-adapter-inline-only`（AC-132，done）落的是 **provider 侧**能力声明（`shared/asr/`），本条目处理的是**客户端侧**的第二份声明与硬编码 id，方向相反。`gap-asr-health-effective-config-fail-closed`（AC-134 的现有声明者，done）交付的是健康检查的 fail-closed 行为，不是这条矛盾。本条目与上述三者只在溯源上相关。

**本案不做**：不裁判「该不该裁」这个产品决策（那是 ADR-004 二节的裁定，本条只负责让**唯一那份声明**说话）；不删 `trimDecisionFor`（它是纯映射，是合法的读取点）；不碰 `PAUSE_CAPS` 与 VAD 参数；不改上传体的字段名 / URL / 头 / 容忍度（AC-130 的字节基线仍是守卫）。

## Plan

- **S0 先让不变量可红（判据在前）。** 在 AC-134 既有判据的消费面之外加一条独立读数：把「裁剪决策读到的 `pauseCues` 必须等于 registry 对**当前生效 provider id** 的声明」写成可执行断言，取假形态为「客户端表与 registry 不一致」⇒ 必红。今天这条必然红（`destructive` ≠ `useful`），它把「机制绿、不变量红」变成机械可见。
- **S1 收敛来源。** `src/shared/voiceTrim.ts` 删除承担「声明」职责的部分（`PAUSE_CUES_DECLARATIONS` / `pauseCuesFor` / `OPENAI_COMPATIBLE_PROVIDER` / `DEFAULT_PAUSE_CUES_PROVIDER`），保留 `PauseCues` 类型与 `trimDecisionFor(pauseCues)` 纯映射；调用侧改为向 registry 要值。
- **S2 解开硬编码 id。** `useVoiceInput.ts` 的 `pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER)` 换成「按当前生效 provider id 向 registry 取值」；provider id 从既有的用户配置读取路径来（与 AC-134 的 `configured-field-present=yes` 同一来源），未注册 id 按 fail-closed 处理而不是回落默认行。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence；并如实登记行为变化（若结论是「不再裁」，AC-130 的字节基线**不受影响**，因为基线量的是字段名 / URL / 头 / 容忍度，不是时长）。

## AC

- [x] AC1 主读：`node scripts/asr-config-resolution-check.mjs` 退出码 0，且 stdout 的 `client-capability-table` 读数必须打印且不再是 `declared-in-2-file(s)`。
- [x] AC2 不变量读数是新的且当前必红：新判据 `node scripts/asr-pause-cues-source-check.mjs` 在**未修**的树上退出码非零，判词指名「客户端声明的 `pauseCues` 与 registry 对当前 provider 的声明不一致」，并逐字打印两个值（形如 `client=destructive registry=useful provider=...`）。
- [x] AC3 不变量判据的取假形态：临时工装里只把 `src/shared/voiceTrim.ts` 的表值改成 `'useful'`（其余不动）⇒ 同一命令退出码 0；改成与 registry 不同的第二个值 ⇒ 非零。每条**先对未变异的同一工装断言退出 0**，再变异，并断言变异命中数 `=== 1`（命中 0 处即该用例红）。
- [x] AC4 硬编码 id 消失且可红：命令断言 `src/modules/chat/hooks/useVoiceInput.ts` 不再出现字面量 `OPENAI_COMPATIBLE_PROVIDER`，且裁剪门的 provider id 来自配置读取路径；取假形态为「把该字面量写回」⇒ 必红。
- [x] AC5 唯一性：`grep -rn "pauseCues\s*:" src/` 去重后命中文件数为 0（能力的**声明**只在 `shared/asr/` 侧）；同一命令断言 `grep -rn "pauseCues" shared/asr/` 仍非空（证明没有把能力本身一起删掉）。
- [x] AC6 既有语音读数不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts`、`npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx` 各自退出码 0。
- [x] AC7 AC-130 的守卫不被本任务打穿：`node scripts/asr-extraction-parity-check.mjs` 退出码 0，四组 `equal`。
- [x] AC8 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。
- [x] AC9 行为变化如实登记：命令打印**修改前 / 后**同一段中文与英文样本的裁剪判定与上传体时长；若结论是「不再裁剪」，须在 Evidence 里逐字记录该差值，并把「这是 ADR-004 二节实测结论的期望方向」与「这属于人已裁定的产品决策」两件事分开写。
- [x] AC10 客户端侧的两份手工替身跟上被接走的接缝，且「默认不裁」是被量到的量：`npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 退出码 0（此前 5 + 2 例红，成因见 Evidence：两份替身把 `@/shared/api` 的面写成固定键，新接走的 `effectivePauseCuesDeclaration` 读成 `undefined`，采集路径第一行即抛）；同一命令须打印 20 例全绿，其中包含一条把默认态钉住的用例（开关打开、解码可用、无人声明 ⇒ 仍不裁）；取假形态：把默认声明从「无」改成授权裁剪 ⇒ 恰 1 例红且正是那条钉住默认态的用例，改回后 20 例全绿。

## DoD

真实落地判据不是「`voiceTrim.ts` 里的表被删了」，而是**裁剪决策读到的能力值来自 registry 对当前生效 provider 的声明**，且这件事机械可红：

(a) **不变量有独立读数且当前是红的** —— AC2 在未修的树上必红，AC3 的两支控制分别把它打绿 / 打红（只有「值恰好等于 registry」才绿，不是「把表挪个位置」就绿）；
(b) **硬编码 id 真的没了** —— AC4 断言 `useVoiceInput.ts` 里不再有那个字面量，且取假形态可红；
(c) **能力的声明只剩一份，且在 provider 侧** —— AC5 的 `src/` 扫描为 0、`shared/asr/` 扫描非 0；
(d) **没有把守卫一起打穿** —— AC7 的 AC-130 字节基线仍逐组 `equal`。

**本任务不裁「该不该裁」**：若收敛后 `multimodal` 的 `useful` 生效 ⇒ 不再裁剪 ⇒ 这是行为变更，必须由 ADR-004 二节的裁定背书，本任务只如实登记（AC9），不自行选择方向。若人判定 `openai-compatible` 确为另一个待注册的识别器、其 `pauseCues` 确为 `destructive`，则本条的正确形态是**把它注册进 registry 并在那里声明**，而不是保留客户端表 —— 两条路都不允许「客户端自己声明」。

L_D 该轴仍暗，理由：本任务只把一份已存在的领域能力收敛到唯一声明处，不新增领域数据能力，也没有可读出的领域读数。

L_G 该轴仍暗，理由：本任务量的是「裁剪决策的值来自 registry」这一守卫，不产出目标层读数 —— GOAL-008 的目标层（换识别服务不改路由与 UI）由其余判据承担。

## 落地证据

实现提交 `0ae696cd`（分支 `task/gap-asr-pause-cues-second-source-contradicts-registry`），随后 `git merge --no-edit develop` 合入 `ff0c0d11`（无冲突）。scoped 门：`bash scripts/test.sh --for-task gap-asr-pause-cues-second-source-contradicts-registry --allow-thin` 退出 0，`__PERFILE__ duration_ms=20 src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx passed=true`，`# tests 1 / # pass 1 / # fail 0`。

### AC1

```
$ node scripts/asr-config-resolution-check.mjs
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
$ echo $?
0
```

修前该行是 `client-capability-table=declared-in-2-file(s)`，指名 `src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx, src/shared/voiceTrim.ts`（本任务 Proposal 的判词原文）；现在是 `none`，`src/` 里没有任何一处 capability 声明。注意 `client-read-points` 仍是那两项 —— 健康读数的消费点没有被动过，被移走的只是**声明**。

### AC2（未修的树 = 用实现前的四个文件搭的临时工装）

```
$ RIG=$(mktemp -d /tmp/asr-unfixed-rig.XXXXXX)
$ mkdir -p "$RIG/shared/asr/list/multimodal" "$RIG/src/shared" "$RIG/src/modules/chat/hooks"
$ for f in shared/asr/asrRegistry.ts shared/asr/list/multimodal/multimodal.asr-provider.ts \
           src/shared/voiceTrim.ts src/modules/chat/hooks/useVoiceInput.ts; do
    git show HEAD:"$f" > "$RIG/$f"; done      # HEAD 在实现提交之前
$ node scripts/asr-pause-cues-source-check.mjs --root "$RIG"
registry-module=shared/asr/asrRegistry.ts
registry-provider=multimodal (1 of 1 registered, nothing requested or configured)
registry-pauseCues=useful
registry-declared-by=shared/asr/list/multimodal/multimodal.asr-provider.ts
client-declaration-rows=2
client-pauseCues=destructive
client-declaration-source=src/shared/voiceTrim.ts (provider openai-compatible)
gate-module=src/modules/chat/hooks/useVoiceInput.ts
gate-reads-registry=no
gate-retired-literal=OPENAI_COMPATIBLE_PROVIDER
failure=客户端声明的 `pauseCues` 与 registry 对当前 provider 的声明不一致：client=destructive registry=useful provider=multimodal（client 的声明在 src/shared/voiceTrim.ts，其 provider 列为 openai-compatible）
failure=AC4: src/modules/chat/hooks/useVoiceInput.ts 仍出现字面量 OPENAI_COMPATIBLE_PROVIDER
failure=AC4: src/modules/chat/hooks/useVoiceInput.ts 的裁剪门没读到 registry 的声明读取点（provider id 不来自配置读取路径）
verdict=fail
$ echo $?
1
```

`client-declaration-rows=2` 是真的两处，不是误报：`git show HEAD:src/shared/voiceTrim.ts | grep -n "pauseCues: '"` 给出 `379: pauseCues: 'destructive',`（声明表的那一行）与 `402: ?? { provider: DEFAULT_PAUSE_CUES_PROVIDER, pauseCues: 'destructive' }`（未声明 id 的回落行）。客户端侧两处都答 `destructive`，而它自己那张表里没有 `multimodal` 这一行 —— 这正是「用一张表答一个它并不认识的识别器」。

出射侧：`registry` 侧不是照抄常量，是**顺着注册表走到适配器模块**读它自己的 `id` 与 `capabilities.pauseCues`；`client` 侧是扫 `src/` 里 `pauseCues: '<值>'` 这一**形状**，并跟随客户端自己的 `DEFAULT_*PROVIDER` 回落。

### AC3（同一工装、同一命令，只差一个字符串）

```
$ RIG=$(mktemp -d /tmp/ac3-rig.XXXXXX)   # 从出货文件复制四个 FIXTURE_FILES
$ node scripts/asr-pause-cues-source-check.mjs --root "$RIG"     # (1) 未变异
client-pauseCues=none
verdict=ok
$ echo $?
0
$ # 工装里插入客户端自建表，值 = registry 的值 'useful'（断言命中 1 处）
$ node scripts/asr-pause-cues-source-check.mjs --root "$RIG"     # (2) 相等的值
client-declaration-rows=1
client-pauseCues=useful
client-declaration-source=src/shared/voiceTrim.ts (provider multimodal)
verdict=ok
$ echo $?
0
$ # 只把那一行的值改成 registry 的相反值 'destructive'（断言命中 1 处）
$ node scripts/asr-pause-cues-source-check.mjs --root "$RIG"     # (3) 不相等的值
client-pauseCues=destructive
failure=客户端声明的 `pauseCues` 与 registry 对当前 provider 的声明不一致：client=destructive registry=useful provider=multimodal（client 的声明在 src/shared/voiceTrim.ts，其 provider 列为 multimodal）
verdict=fail
$ echo $?
1
```

对照用例（把同一形式固化成可重复的读数，每条**先对未变异的同一工装断言退出 0**，再变异，`patch()` 断言命中数 `=== 1`）：

```
$ node --test scripts/asr-pause-cues-source-check.test.mjs
✔ the shipping tree passes: the client declares nothing and reads the registry
✔ a client table whose value EQUALS the registry stays green
✔ the same rig, with only that value changed to the registry's opposite, reds
✔ AC4: writing the retired literal back into the gate reds it
✔ a tree whose registry cannot be read reds rather than passing an empty scan
ℹ tests 5
ℹ pass 5
ℹ fail 0
$ echo $?
0
```

第 2 与第 3 条驱动的是同一工装、同一命令，差别只有 `pauseCues` 的值 —— 只有「值恰好等于 registry 对当前 provider 的声明」才绿，把表挪个位置或换个名字都不绿。第 5 条是「空读数即失败」的控制：把 `shared/asr/asrRegistry.ts` 删掉后必须非零，读不出来不能读成通过。

### AC4

```
$ grep -c "OPENAI_COMPATIBLE_PROVIDER" src/modules/chat/hooks/useVoiceInput.ts
0
$ echo $?
1
$ grep -n "effectivePauseCuesDeclaration" src/modules/chat/hooks/useVoiceInput.ts
5:import { effectivePauseCuesDeclaration, transcribeVoice } from '@/shared/api';
232:  const recogniser = effectivePauseCuesDeclaration();
```

provider id 的来路：`effectivePauseCuesDeclaration()`（`src/shared/api.ts`）从健康读数发布的 `voiceProviderProfile` 取**当前生效 provider**，再问 `pauseCuesDeclarationFor(id)`；同一 id 就是 `transcribeVoice` 路由所用的那个。未注册 id / 健康读数未落地 ⇒ `null` ⇒ 不裁（fail-closed），而不是回落一张默认行。取假形态见 AC3 对照用例第 4 条：把 `pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER)` 写回门里 ⇒ 非零，且 `gate-retired-literal=OPENAI_COMPATIBLE_PROVIDER`、`gate-reads-registry=no`。

### AC5

```
$ grep -rn "pauseCues\s*:" src/ | cut -d: -f1 | sort -u | wc -l
0
$ grep -rn "pauseCues" shared/asr/ | wc -l
10
```

`src/` 侧 0 个文件（含测试文件在内），`shared/asr/` 侧仍非空 —— 能力本身没有被一起删掉。声明只剩一份，在 provider 侧：`AsrCapabilities.pauseCues`（适配器模块）+ `pauseCuesDeclarationFor`（registry 的查找）。

### AC6

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts
ℹ tests 4 / pass 4 / fail 0
$ echo $?
0

$ npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts \
                 src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
✓ src/shared/tests/voiceConfig.test.ts (17 tests)
✓ src/shared/tests/voiceConfigHydration.test.ts (8 tests)
✓ src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx (4 tests)
Test Files  3 passed (3)
     Tests  29 passed (29)
$ echo $?
0
```

接线用例由 3 条扩到 4 条：声明改为在 `@/shared/api` 的 `effectivePauseCuesDeclaration()` 处驱动（即 hook 真正问的那个接缝），`trimDecisionFor` 不再被 mock，真实映射在每条里都跑；新增的第 4 条是 fail-closed 臂（无可读声明 ⇒ 录音原样上传）。断言的观察量仍是上传体的容器与字节 —— `audio/wav` 是被裁过的，`audio/webm` 是原录音。

### AC7

```
$ node scripts/asr-extraction-parity-check.mjs
pre-extraction ok recordedFromCommit=2506f8d3a5d4f69ed648419c32da403a9a2ed58d
group inbound equal sha256=dc18ceac9e46f623c0eb7d4fe5616ead48864f4185eea6f8159335ca5016c871
group direct-outbound equal sha256=6985b92a09881c3ff249aa14a35ccd06a71925ea1f5937691f223e344d834c87
group proxy-outbound equal sha256=93899fb6cc81f87b52aa0e4d2ff6389ed1723974196c7c7b5ae3ecb43423c8fd
group response-tolerance equal sha256=aa0189610da7bdd63ed65f6c436ee725426dc69d20c440943606584aa11026c2
baseline sha256=81f24ac8852349d3cefead3eb3d40dd461e6773d73778f8cbb48465afc7730a6
observed sha256=81f24ac8852349d3cefead3eb3d40dd461e6773d73778f8cbb48465afc7730a6
verdict PASS
$ echo $?
0
```

四组 `equal`，AC-130 的字节基线 sha 未变。

### AC8

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p server/tsconfig.json && tsc --noEmit -p scripts/tsconfig.json
$ echo $?
0

$ npm run lint
$ echo $?
0
```

`lint` 只剩既有 warning（`react(set-state-in-effect)` 等），新脚本与新用例 0 warning 0 error。`scripts/tsconfig.json` 是 `checkJs: true` + `strict`，新判据的每个 JSDoc 参数与返回类型都是为它补的。

### AC9 行为变化（如实登记）

命令（用 `experiments/voice-trim/fixtures/` 里那两段实测样本，16 kHz PCM16 单声道；判定取「修改前客户端表对当前生效 provider 的答案 `destructive`」与「修改后 registry 对同一 provider 的声明 `useful`」，上传体时长 = 判定为裁时 `trimVoiceAudio` 的 `outputSec`，否则 = 输入时长）：

```
$ npx tsx ac9-scratch.ts
before: capability=destructive trim=true  source=client table row for openai-compatible (the pre-fix answer for the effective provider)
after:  capability=useful      trim=false source=registry declaration of multimodal (docs/experiments/2026-09-22-voice-provider-paired-quality.md)

sample=zh-d01-o85.wav sampleRate=16000 inputSec=11.887 before: truncated=true uploadedSec=10.910 after: truncated=false uploadedSec=11.887 deltaSec=0.977
sample=en-e01-o45.wav sampleRate=16000 inputSec=11.323 before: truncated=true uploadedSec=6.290  after: truncated=false uploadedSec=11.323 deltaSec=5.033
$ echo $?
0
```

结论逐字：**中文样本 10.910s → 11.887s（+0.977s），英文样本 6.290s → 11.323s（+5.033s）**，即**不再裁剪**。（临时脚本用完即删，未进提交。）

两件事分开写：

1. **这是 ADR-004 二节实测结论的期望方向。** 该节量的是「裁剪对每个识别器的准确率做了什么」；唯一注册的适配器 `multimodal` 的配对实验结论是它的停顿**是标点线索**（`pauseCues: 'useful'`，见 `shared/asr/list/multimodal/multimodal.asr-provider.ts` 的注释与 `docs/experiments/2026-09-22-voice-provider-paired-quality.md`）。对这样的识别器裁剪，正是 ADR-004 二节判为有害的方向；收敛到唯一声明处之后行为朝这个方向移动，是**声明的忠实执行**，不是本任务挑的方向。
2. **这属于人已裁定的产品决策。** 「出货配置里到底裁不裁」不由本任务裁定：本任务只让唯一那份声明说话，并把差值登记在此。若人裁定 `openai-compatible` 是另一个**待注册**的识别器、其 `pauseCues` 确为 `destructive`，正确形态是把**它注册进 registry 并在那里声明**（`AsrCapabilities.pauseCues`），客户端侧仍然一个字都不写；两条路都不允许客户端自己声明。AC-130 的字节基线（字段名 / URL / 头 / 容忍度）不受影响，AC7 已复查四组 `equal`。

### 边界副作用（本任务写作面之外，如实登记）

本任务删掉的是 `src/shared/voiceTrim.ts` 里的客户端声明表，而 AC-135 的判据**要求**那张表存在，因此它现在红了：

```
$ node scripts/asr-trim-capability-check.mjs
scan: 624 production sources ... across 5 globs
declaration module: src/shared/voiceTrim.ts
check declaration: FAIL no exported declaration table in src/shared/voiceTrim.ts has a row — a table with 0 rows is a zero-row reading, not a pass
$ echo $?
1

$ node --test scripts/asr-trim-capability-check.test.mjs
ℹ tests 9
ℹ pass 0
ℹ fail 9
$ echo $?
1
```

这是结构性的、不是回归：AC-135 的判据要求声明模块（它按 `export type PauseCues =` 找到 `src/shared/voiceTrim.ts`）导出一张带 `provider` / `pauseCues` 行的表，且至少一行裁、一个回落行也裁；本任务的 AC5 与 DoD(c) 要求 `src/` 里 `pauseCues:` 出现 0 次。两者不能同时成立，而 DoD 已明确「两条路都不允许客户端自己声明」—— 即本次修复必然让 AC-135 的该判据失去对象。另：AC-135 的判据是**纯 node 导入**声明模块，把 `PauseCues` 类型搬到 `shared/asr/asrRegistry.ts` 也不行（该模块 `import ... from './list/.../x.js'`，裸 node 解析不了），所以它不可能改指 provider 侧。

`scripts/asr-trim-capability-check.mjs` 与其 `.test.mjs` 都不在本任务的 `## Touches` 内，本条无权修改；同因，两者也不在 scoped 门的文件集里（门只跑 Touches 的 `*.test.*`），`scripts/test.sh` 自身不跑 `scripts/**/*.test.mjs`（已核：`grep -n "test:scripts\|scripts/\*\*/\*.test" scripts/test.sh` 无命中），故本次 fan-in 不受影响。**AC-135 的判据需要由它的所有者按 provider 侧声明重新推导**（那是 `gap-asr-trim-capability-wiring` 的判据面，本任务只登记事实）。

### AC10（续轮：两份麦克风替身跟上被接走的接缝 —— fan-in 套件红的真因）

上一轮 fan-in 套件红 2 例，判词是

```
not ok - src/modules/chat/tests/voiceClipPlayback.test.tsx: AssertionError [ERR_ASSERTION]: the transcript still reaches the composer
not ok - src/modules/chat/tests/voiceTranscriptRepair.test.tsx: AssertionError [ERR_ASSERTION]: the composer must be handed the project's real file name, not the recogniser's spelling
# tests 213 / # pass 211 / # fail 2
```

真因**不是**这两条断言本身，是两份**手工复写 `@/shared/api` 面**的替身没有跟着长：hook 现在从该模块新接走 `effectivePauseCuesDeclaration`，而替身的 `vi.mock` 工厂返回的是固定键集合，于是

```
Transcription failed: [vitest] No "effectivePauseCuesDeclaration" export is defined on the "@/shared/api" mock. Did you forget to return it from "vi.mock"?
```

采集路径第一行即抛 ⇒ 转写文本根本到不了 composer，两条断言读到的是「什么都没发生」。这不是新形态：同一处的上一轮 `2506f8d3`（「test(voice): list the seam in the two module doubles that drive the mic」）就是同样成因、同样改法 —— 手工替身是模块面的**描述**，面长了描述就过时了。

```
$ npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceTranscriptRepair.test.tsx
× a finished recording lands in the clip slot
× the trimmed upload lands beside the recording, as its own track
× the two tracks never sound at once
× a rejected play() returns the pill to idle and reports the error once
× the replay controls exist only while a clip does, one per track, and rename themselves while playing
   Test Files  1 failed (1)   Tests  5 failed | 12 passed (17)      ← voiceClipPlayback
× a mis-heard name is repaired against the project the composer is open in
× a sentence carrying no identifier arrives character for character
   Test Files  1 failed (1)   Tests  2 failed (2)                   ← voiceTranscriptRepair
$ echo $?
1
```

**改法**（两份文件都已进 `## Touches`，故 AC10 覆盖到）：

- `voiceTranscriptRepair.test.tsx` —— 按 `2506f8d3` 的先例直接取真访问器（`effectivePauseCuesDeclaration: actual.effectivePauseCuesDeclaration`）。该文件的主语是修复 join，不是谁答裁不裁；本仓没有发布 voice profile，它答「无可读声明」⇒ 原录音上传，正是那些读数被取的输入，而不是它们依赖的状态。
- `voiceClipPlayback.test.tsx` —— 同样以真访问器作答，另加一个可变的声明位（`voiceProfile.declaration`）供用例**显式交出授权裁剪的声明**，因为该文件的主语正是那对轨道的 UI，而那对轨道只能由一份授权裁剪的声明产生。五条「裁」的用例改为同时交出开关与声明 —— 两者都必须说 yes，这才让「谁决定」在这一侧也可变。

```
$ npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceTranscriptRepair.test.tsx
 Test Files  2 passed (2)
      Tests  20 passed (20)
$ echo $?
0
```

新增的第 18 例 `a recogniser that asks for nothing keeps the recording: the switch alone authorises nothing` 把**默认态本身**变成被量到的量：开关打开、解码可用、没有识别器声明 ⇒ 仍是原录音一条轨道（这也是出货配置的读数：唯一注册的适配器声明 `useful`，读到的上传体与原录音相同）。取假形态**实测**（只把默认声明改成授权裁剪，其余不动）：

```
$ # 把 beforeEach 里的 voiceProfile.declaration = null 改成 = TRIMS_PAUSES
$ npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx
× a recogniser that asks for nothing keeps the recording: the switch alone authorises nothing 10ms
 Test Files  1 failed (1)      Tests  1 failed | 17 passed (18)
$ # 改回后：2 文件 20 例全绿
```

恰 1 例红，且正是那条钉住默认态的用例 —— 「开关打开就裁」这一读法在这里可红，而 AC6 的接线用例里也可红（那是另一次读数）。

**其余读数在续轮后逐一复跑未变**：AC1 `verdict=pass`（`client-capability-table=none`）；AC2 树侧 `verdict=ok`（`client-declaration-rows=0`、`gate-reads-registry=yes (effectivePauseCuesDeclaration)`、`gate-retired-literal=absent`）；AC3 `node --test scripts/asr-pause-cues-source-check.test.mjs` 5/5；AC4 `grep -c` = 0；AC5 `src/` 去重后 0 文件、`shared/asr/` 10 命中；AC6 `ℹ tests 4 / pass 4 / fail 0` + vitest 3 文件 29 例；AC7 四组 `equal`、基线 sha `81f24ac8…` 未变；AC8 `npm run typecheck` / `npm run lint` 均退出 0（lint 只剩既有 warning）。旁证：`npx vitest run src/modules/chat/tests/` 全目录 44 文件 325 例全绿。

**本续轮只动两份麦克风替身，未动生产代码**（`git diff --stat`：2 files changed, 79 insertions(+), 4 deletions(-)），故 AC9 登记的行为结论不变、没有新的行为差值。


## Touches

- src/shared/voiceTrim.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx
- src/shared/api.ts
- shared/asr/asrRegistry.ts
- scripts/asr-pause-cues-source-check.mjs (new)
- scripts/asr-pause-cues-source-check.test.mjs (new)
- tasks/gap-asr-pause-cues-second-source-contradicts-registry.md
