---
id: gap-asr-mime-whitelist-and-size-layering
title: 缺口一与缺口二（有条件）：MIME 白名单按基类型匹配、双向可红；大小上限两层且超限返回 413 而非 400（AC-133）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-wire-single-implementation-boundary-probe
goal_ac: AC-133
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：全仓无任何任务声明 AC-133；`task_list` 全文检索「MIME」命中的都是不同机制的任务（语音设置存储、录音单槽回放），**没有**第二条在落「转写路由的 MIME 白名单 + 大小上限分层」的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129）与 `gap-asr-extraction-parity-baseline`（AC-130）。本任务是 ADR-004「后续任务 6」的立案。

**本任务是有条件的（ADR-004 决策 3）。** 它仅在决策 3 的边界探针走**路径 (a)**（仓库根 `shared/` 可被前端与服务端同时导入）时成立。若探针红并落 (b)，服务端消费不到 `src/shared/asr/`，而缺口一（白名单由 `capabilities.acceptsMime` 决定）与缺口二（per-provider 预算在适配器里执行）**都是服务端路由/适配器的改动**，于是它们退化为「服务端保持现状」。因此本任务 `depends_on` 探针任务，并把「探针走 (a)」写成一条**前提断言 AC**（AC8），不许把它当成隐含前提。

**现场（三处既有缺口之二）。** 缺口一：转写路由没有 MIME 白名单 —— 上传只受大小限制，MIME 只做 `|| 'audio/webm'` 兜底，上传什么就转什么。缺口二：25MB 全局界与 provider 的内联上限互不知情，是两个真相源；超限经 multer 变成 400，而 400 会让客户端以为是格式问题。

**本任务做什么。** 白名单**由所选 provider 的 `capabilities.acceptsMime` 决定**，不新增第二个全局常量；拒绝发生在**读取上游之前**，返回语义码 `UNSUPPORTED_MIME`，且不消耗一次转写请求。**匹配按基类型**（剥离 `;` 之后的参数）—— 浏览器首选录音 MIME 是**带参数**的（`audio/webm;codecs=opus`），而服务商公布的是基类型；按公布列表做精确匹配会把**出货录音器自己的输出**判为不支持。上限**必然分两层**：multer 在 handler 之前按 `LIMIT_FILE_SIZE` 拒绝且无从知道 provider，per-provider 的 `min(全局界, provider 预算)` 只能在适配器里、上传已被缓冲**之后**执行；超限 HTTP 状态码从 400 改为 **413**。

**边界（不做）。** 缺口三（健康检查反映用户有效配置 + 未注册 id fail-closed）是 AC-134 的词；不做裁剪 × 能力接线（AC-135）；不新增第二个全局常量；不改两条路径的线上字节（AC-129/AC-130）；不做质量实验（ADR-004 决策 8）。

## Plan

- **S0 前提断言。** 跑探针的 `--landing` 读数，确认落点候选为 (a)；为 (b) 时不得进入 S1/S2，停在 needs-human 并登记。
- **S1 缺口一。** 白名单来源改为所选 provider 的 `capabilities.acceptsMime`；按基类型匹配；拒绝在读取上游之前，返回 `UNSUPPORTED_MIME`，上游调用次数为 0；客户端能拿到 `acceptsMime`。
- **S2 缺口二。** 两层上限：multer 取「所有 provider 的最大值」或接受两层各自拒绝；per-provider 的 `min(全局界, provider 预算)` 在适配器里执行；超限映射为 **413**。
- **S3 探针与四条取假控制。** 各成一条独立可红用例；先证未变异为绿、再证变异为红。
- **S4 读数。** 逐条跑 AC，stdout 落进 Evidence。

## AC

- [x] AC1 白名单**双向**：白名单内的输入绿、白名单外的输入红且返回不支持 MIME 的语义码。取假变体：把白名单写成恒拒 ⇒ 「内绿」那一半必须红。
- [x] AC2 **带参数的 MIME**（`audio/webm;codecs=opus`）必须被判为**受支持**（按基类型匹配），且裸基类型同样受支持。取假变体：按精确串匹配 ⇒ 带参数的那条用例必须红（这是出货录音器自己的输出）。
- [x] AC3 超限返回 **413** 而不是 400。
- [x] AC4 两条路径（直连 / 代理）产出**同一个**语义码。取假变体：只改代理路径 ⇒ 「两条路径同码」必须红。
- [x] AC5 「切换 provider 后读数改变」读的是**适配器的拒绝**，而不是 multer 的。取假变体：把上限写死回一个常量 ⇒ 「随 provider 变化」必须红。
- [x] AC6 不新增第二个全局常量：白名单来源是所选 provider 的 `capabilities.acceptsMime`；探针打印该来源的**符号名**（不是文件加行号）。
- [x] AC7 拒绝发生在**读取上游之前**：上游调用次数为 0，且不消耗一次转写请求。
- [x] AC8 **前提断言**：探针的 `--landing` 读数为候选 (a)。若为 (b)，本任务不得声称缺口一/二已落地 —— 停在 needs-human 并把探针红的原始判词落进 Evidence。
- [x] AC9 四条取假形态各为 `scripts/asr-mime-size-gaps-check.test.mjs` 内一条独立可红用例；`node --test scripts/asr-mime-size-gaps-check.test.mjs` 退出码 0。
- [x] AC10 空读数不是绿：白名单命中集合为空、或上游调用次数读数为空 ⇒ 探针非零退出。
- [x] AC11 既有读数不变：`server/modules/voice/tests/` 与 `src/shared/tests/voiceConfig*.test.ts` 保持绿；`scripts/asr-health-provider-check.test.mjs` 的取假锚点随守卫语句同步后保持绿；`npm run typecheck` 与 `npm run lint` 退出码 0。

## DoD

真实落地判据：不是「路由里多了一个 MIME 数组」，而是**白名单与上限都由能力声明驱动、且差异可红**。承重性由四组正面读数证明：

(a) 白名单双向（AC1）—— 恒拒的实现必须红，「内绿」那一半是它的取假变体；
(b) **基类型匹配**（AC2）是缺口一要防的那件事的另一种机制：出货录音器发的是带参数的 MIME，精确匹配会把用户自己的录音拒掉；
(c) 上限**不是单点**（AC5）——「切换 provider 后读数改变」必须读**适配器的拒绝**，若读 multer 的会把两层之间张冠李戴；
(d) 两条路径同码（AC4），且 413 取代 400（AC3）。

**必须如实登记的一处必然代价**：小于全局界、但大于本 provider 预算的请求会**先被完整缓冲**再被拒 —— 这是「两层」这个事实的后果，不是实现缺陷。

**本任务不证明**缺口三（AC-134）与裁剪接线（AC-135）；也不在探针落 (b) 的世界里成立（AC8）。

L_D 该轴仍暗，理由：本任务只把两处既有缺口改为由能力声明驱动，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Evidence

S0 前提断言（AC8）：

```
$ node scripts/asr-mime-size-gaps-check.mjs --landing
landing=shared/asr
landing-candidate=a
server-compiles-landing=yes
verdict=pass            # exit 0
```

S4 读数（完整探针 stdout，exit 0）：

```
$ node scripts/asr-mime-size-gaps-check.mjs
landing=shared/asr
landing-candidate=a
server-compiles-landing=yes
whitelist-source=capabilities.acceptsMime
client-whitelist-source=profile.capabilities.acceptsMime
transport-ceiling-source=adapter.capabilities.maxInlineRequestBytes
mime-constant-tables=none
declared-container-bare=served
declared-container-parameterised=served
declared-container-case=served
outside-container=refused-415-UNSUPPORTED_MIME
outside-container-upstream-calls=0
oversize=refused-413-OVERSIZE
oversize-upstream-calls=0
inside-budget=served
provider-switch-container=follows-declaration
provider-switch-budget=follows-declaration
transport-ceiling=413/OVERSIZE
transport-non-ceiling=400/no code
direct-declared-container=200
direct-parameterised-container=200
direct-outside-container=415/UNSUPPORTED_MIME
direct-outside-container-upstream-calls=0
two-paths-same-code=yes-UNSUPPORTED_MIME
verdict=pass
```

S3 四条取假控制（AC9，`node --test scripts/asr-mime-size-gaps-check.test.mjs`，exit 0）：

```
✔ AC8: the landing reading is candidate (a), and a frontend-tree landing is refused
✔ AC1/AC9: a whitelist that refuses everything is reported by the half it breaks
    -> declared-container-bare=refused-415-UNSUPPORTED_MIME
✔ AC2/AC9: an exact-string match is reported instead of the recorder's own output
    -> declared-container-parameterised=refused-415-UNSUPPORTED_MIME
✔ AC4/AC9: a browser face that gates nothing is reported by the two-path comparison
    -> two-paths-same-code=no
✔ AC5/AC9: a budget written down in the gate is reported as not following the declaration
    -> provider-switch-budget=constant
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

AC10 两个方向各自是红的（在临时 fixture 上归一化后运行）：

```
# 白名单来源无法命名
whitelist-source=unnamed
failure=AC6: the server gate's whitelist source could not be named in server/modules/voice/voice.service.ts
verdict=fail            # exit 1
# 上游调用次数读数为空（读数根本没被取到）
server-reading=unavailable
failure=reading: the reader produced no reading (exit 1): ...
verdict=fail            # exit 1
```

AC11 既有读数：

```
$ npx tsx --tsconfig server/tsconfig.json --test "server/modules/voice/**/*.test.ts"
ℹ tests 24  ℹ pass 24  ℹ fail 0
$ npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts
ℹ Test Files 3 passed (3)  Tests 28 passed (28)
$ npm run typecheck          # exit 0
$ npm run lint               # exit 0
$ node --test scripts/asr-health-provider-check.test.mjs   # exit 0
```

## Touches

- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voiceTranscribeGaps.test.ts (new)
- server/shared/types.ts
- shared/asr/asrRegistry.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/api.ts
- scripts/asr-mime-size-gaps-check.mjs (new)
- scripts/asr-mime-size-gaps-check.test.mjs (new)
- scripts/asr-health-provider-check.test.mjs
- tasks/gap-asr-mime-whitelist-and-size-layering.md
