---
id: gap-asr-wire-single-implementation-boundary-probe
title: 语音识别线协议只有一份实现：前端/服务端/命令行三处解析到同一路径，边界探针可红可绿（AC-129）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-129
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`tasks/` 内无同机制任务（唯一提及「线协议」的任务都不在 GOAL-008 上）。相邻但**机制不同**的是 `gap-identifier-repair-harness-measures-a-copy`：那条处理的是裁剪／标识符修复模块，本条处理的是语音识别线协议；仅在溯源上指向它，不引用它作为任何前置。AC-129 的 origin 恰好引用了那次失效（「一次判据量的是工装副本而非出货实现，与出货实现 16 条里 6 条不一致」）—— 本任务在语音链路上落同一条纪律。

### 现场：判据今天不可跑，因为线协议有两份生产实现

AC-129 自己的判据命令是 `node scripts/asr-single-implementation-check.mjs`，**该文件今天不存在**；而它要断言的形态今天是反的。

「线协议」在本任务里指识别服务的请求构造（multipart：音频文件 + 模型名，POST 到 `<baseUrl>/audio/transcriptions`，带 Authorization）与转写响应解析：

| 消费者 | 请求构造 | 响应解析 |
| --- | --- | --- |
| 前端（直连） | `src/shared/api.ts` 的 `transcribeVoice` 直连分支 | `src/modules/chat/hooks/useVoiceInput.ts`：`res.json()` 取 `data?.text`，**严格**（非 JSON 直接抛） |
| 服务端（代理） | `server/modules/voice/voice.service.ts` 的 `createTranscriptionFormData` | 同一文件：JSON 取 `text`，**解析失败回落原文**，比直连宽松 |
| 命令行 | 不存在 | 不存在 |

两条路径的容忍度已经分叉：同一个上游异常在直连路径上报错，在代理路径上会被当成一段转写文本填进 composer（ADR-004 事实 2 的更正的读数）。AC-129 要终结的正是这个形态：**实现只有一份，三处消费者导入到同一路径**。

### 方案

1. **先做一次有界的落点尝试，由实证决定落点。** ADR-004 决策 2/3 给出两条候选：**(a) 仓库根 `shared/asr/`**（需要为前端造一条别名，登记点在三处：根 `tsconfig.json` 的 `paths`、`vite.config.js` 的 `resolve.alias`、`.oxlintrc.json` 的 import resolver），或 **(b) `src/shared/asr/`**（ADR 的后备方案）。人 yale 2026-09-22 已预先授权 (b) 作为回落，因此本任务可自主跑完并出结论，不必再开第二轮裁定。ADR 决策 2 自陈的一项**未验证前提**（oxlint 的 resolver 能否吃下一条新别名）在本步出结论。
2. **落一份环境中立的实现。** 请求构造与响应解析各一个纯函数，环境依赖（fetch、密钥、baseUrl）一律注入；响应容忍度**显式参数化**，让两条路径各自的容忍度都能被逐字复现 —— 否则会撞上 AC-130 的逐字节基线。实现须同时满足两套 tsconfig 的编译面（根侧 `lib` 只到 ES2020 + DOM、`types` 只有 `vite/client`；服务端侧是 ES2022 + NodeNext）：不得碰 node 内建，也不得用 ES2021+ 的库特性。
3. **三处消费者改为导入它。** 前端两处（`src/shared/api.ts` 的直连分支、hook 里的响应解析）、服务端一处（`server/modules/voice/voice.service.ts`）、命令行新增一处（`experiments/voice-asr-cli/transcribe.ts`，按 ADR 决策 2 落在 `experiments/` 下并以 `npx tsx` 启动）。本步是**纯重构**：不改任何线上字节。
4. **落探针。** `scripts/asr-single-implementation-check.mjs` 逐个消费者**解析其真实的 import 说明符**到绝对路径（不是读一张硬编码清单 —— 读清单正是「判据量工装」的复发形态），断言实现的绝对路径与三处解析结果四者 realpath 相同；再扫全仓生产源，断言不存在第二处构造转写 multipart、也不存在第二处解析转写响应。一个 `--root` 参数让同一份探针能对工装根跑，于是两条取假形态都成为可执行的用例。

### 边界（不做）

不做能力声明与第二个 provider（那是 AC-132/133/134/135 的词）；不做 `--dry-run` / `--offline` 语义（AC-131）；不录逐字节基线（AC-130）；不改两条路径的**线上行为**（字段名、URL、Authorization、两条路径各自的容忍度差异都必须与改前一致）；不把命令行提升为 `cloudcli` 子命令。

## Plan

- **S0 有界尝试 (a) 与落点判定**：最小实现模块落在 `shared/asr/transcriptionWire.ts`，登记三处配置点，并把落点目录加进 `npm run lint` 的路径列表（否则只买到「没被判红」，买不到「被覆盖」）；从 `src/modules/**` 与 `server/modules/**` 各导入一次，跑 `npm run typecheck` 与 `npm run lint`。绿 ⇒ 落 (a)；红 ⇒ 落 (b)，并把红的原始判词（失败行原文）记进 Evidence。AC2 的 `--landing` 读数即本步的产物。
- **S1 落实现**：写实现模块（纯函数 + 注入依赖 + 显式容忍度参数），保持两条路径的线上字节与各自容忍度不变。
- **S2 三处接线**：前端两处、服务端一处改为导入；命令行入口新增为第三个消费者。本步只要求它是**真实消费者**并能在 `npx tsx` 下加载；`--dry-run` / `--offline` 属 AC-131 的任务。
- **S3 落探针与取假控制**：探针 + 其测试；两条取假形态在测试里各成一条独立可红的用例，工装根在测试运行时于临时目录构造（不往仓库里放一份固定的「第二份算法」fixture —— 那会让唯一性扫描自伤）。
- **S4 读数**：逐条跑 AC，把 stdout 落进 Evidence。

## AC

- [x] AC1 `node scripts/asr-single-implementation-check.mjs` 退出码 0；stdout 逐行给出实现文件的绝对路径与三处消费者（前端、服务端、命令行）各自解析到的路径，四行 realpath 相同，并有一行 `SECOND_IMPL none`。取假形态：任一处改回本地构造 ⇒ 该命令必须红（由 AC3/AC4 的工装用例机械证明）。
- [x] AC2 `node scripts/asr-single-implementation-check.mjs --landing` 退出码 0；打印 `landing=` 两候选之一，并逐条打印该落点所依赖的配置登记（文件 + 命中行原文）；若落 (b)，同一命令还打印探针在 (a) 上红的原始判词（typecheck / lint 的失败行）。
- [x] AC3 取假形态 (1)：`node --test scripts/asr-single-implementation-check.test.mjs` 退出码 0，其中一条用例对工装根跑同一探针（前端与服务端各写一份），断言探针非零退出且判词含 `paths differ`。
- [x] AC4 取假形态 (2)：同一测试文件内另一条独立用例，在工装根里复制一份算法（第二处构造 multipart 或第二处解析转写响应），断言探针非零退出且判词含 `SECOND_IMPL`。
- [x] AC5 空读数不是绿（正面控制）：同一测试文件内第三条用例，对一个**没有任何实现文件**的工装根跑探针，断言非零退出且判词含 `no implementation`（空 glob 不许退出 0）。
- [x] AC6 唯一性（生产源）：`node scripts/asr-single-implementation-check.mjs --explain-scan` 退出码 0，打印被扫描的 glob 集合与命中集合（命中集合只含唯一实现文件）；独立读数 `grep -rn --include=*.ts --include=*.tsx --exclude=*.test.ts "audio/transcriptions" src/ server/ shared/` 去重后的命中文件数为 1。（`--exclude=*.test.ts` 的口径收窄与理由见 Evidence：不带它时是 3，多出的两个文件是独立钉住该字面量的测试。）
- [x] AC7 `npm run typecheck` 退出码 0（根 tsconfig、服务端 tsconfig、scripts tsconfig 三条都在内 —— 同一份实现文件被两套配置同时编译）。
- [x] AC8 `npm run lint` 退出码 0，且命令打印 oxlint 的路径列表并断言落点目录**在列表内**；取假形态：把落点目录从路径列表里去掉 ⇒ 这一半必须红（「没被判红」≠「被覆盖」）。
- [x] AC9 纯重构、既有读数不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts` 与 `npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts` 各自退出码 0。
- [x] AC10 命令行消费者可加载：`npx tsx experiments/voice-asr-cli/transcribe.ts` 无参数时打印用法并**非零**退出（断言退出码与用法行文本），证该入口在 ADR 决策 2 声明的启动方式下真的可加载，且其源码经探针解析到同一实现文件。

## Evidence

**落点判定（S0 有界尝试）＝ (a) 仓库根 `shared/asr/`。** ADR-004 决策 2 自陈的未验证前提（oxlint 的 resolver 能否吃下一条新别名）在此出结论：**能吃下**。判据是 `npm run typecheck`（三套 tsconfig 同时编译这一个文件）与 `npm run lint`（`importx/no-unresolved` 与 `boundaries/no-unknown` 都放行）双绿，且新增文件在 lint 输出里出现 0 次。落点目录已加进 `npm run lint` 的路径列表（`shared/`），否则只买到「没被判红」。

```
$ node scripts/asr-single-implementation-check.mjs --landing --explain-scan ; echo $?
asr-single-implementation-check root=…/gap-asr-wire-single-implementation-boundary-probe
scan-globs=src/**/*.ts src/**/*.tsx server/**/*.ts server/**/*.js shared/**/*.ts
scan-files=620
scan-hit shared/asr/transcriptionWire.ts markers=endpoint-literal,multipart-file-field,multipart-model-field,parsed-text-field
implementation path=…/shared/asr/transcriptionWire.ts realpath=…/shared/asr/transcriptionWire.ts markers=…
consumer=frontend path=…/shared/asr/transcriptionWire.ts realpath=… imports=2
  site=src/modules/chat/hooks/useVoiceInput.ts:18 specifier=@shared/asr/transcriptionWire -> …
  site=src/shared/api.ts:14 specifier=@shared/asr/transcriptionWire -> …
consumer=server path=…/shared/asr/transcriptionWire.ts realpath=… imports=1
  site=server/modules/voice/voice.service.ts:14 specifier=../../../shared/asr/transcriptionWire.js -> …
consumer=cli path=…/shared/asr/transcriptionWire.ts realpath=… imports=1
  site=experiments/voice-asr-cli/transcribe.ts:31 specifier=../../shared/asr/transcriptionWire.js -> …
SECOND_IMPL none
landing=shared/asr
registration file=tsconfig.json line=21 text="@shared/*": ["shared/*"]
registration file=vite.config.js line=40 text='@shared': fileURLToPath(new URL('./shared', import.meta.url))
registration file=vitest.config.ts line=38 text='@shared': fileURLToPath(new URL('./shared', import.meta.url)),
registration file=.oxlintrc.json line=44 text="shared/**/*.ts",
registration file=.oxlintrc.json line=63 text="type": "repo-shared",
lint-paths=src/ server/ scripts/ shared/
lint-covers-landing=yes (shared/)
0
```

**对任务原文的一处实测更正：别名登记点是四处，不是三处。** 第四处是 `vitest.config.ts`。第一次跑 AC9 的第二条命令时它红在 collect 而不是断言：

```
FAIL  src/shared/tests/voiceConfigHydration.test.ts
Error: Failed to resolve import "@shared/asr/transcriptionWire" from "src/shared/api.ts". Does the file exist?
  Plugin: vite:import-analysis
```

vitest 优先读 `vitest.config.ts`，不从 `vite.config.js` 继承任何东西 —— 「bundle 能解析」与「单测能解析」是两件独立的事。补上第四处后同一条命令绿（`Test Files 2 passed (2)` / `Tests 25 passed (25)`）。`tsconfig.json` 与 `vite.config.js` 里「三处」的注释已同步改成四处；探针的 `--landing` 现在逐条打印并逐条断言这四处（缺一条即红）。这是 AC8 那条纪律的延伸：登记点少一处不会「被判红」，只会静默不工作。

**取假形态的原始判词**（工装根在测试运行时于临时目录用**出货文件**构造，不往仓库里放固定 fixture；`node --test scripts/asr-single-implementation-check.test.mjs` → 4/4 pass）：

- AC3（前端与服务端各写一份并各自指向自己的副本）
  `FAIL paths differ: the consumers resolve to 3 different files: …/transcriptionWire.ts …/transcriptionWireFrontend.ts …/transcriptionWireServer.ts`
- AC4-1（逐字复制一份算法，无人 import）
  `FAIL SECOND_IMPL server/modules/voice/transcriptionWireCopy.ts markers=endpoint-literal,multipart-file-field,multipart-model-field,parsed-text-field`
- AC4-2（只抄**请求半**：第二处 multipart 构造，不含 endpoint 字面量）
  `FAIL SECOND_IMPL src/shared/legacyTranscriptionBody.ts markers=multipart-file-field,multipart-model-field`
- AC4-3（只抄**响应半**：第二处 `JSON.parse` 取 `text`，不含请求侧）
  `FAIL SECOND_IMPL src/shared/legacyTranscriptionResponse.ts markers=parsed-text-field`
- AC5（工装根没有实现文件）
  `FAIL no implementation: none of … (3 file(s) scanned, tests excluded) defines the transcription wire protocol`
- AC8 后半（把 `shared/` 从 lint 路径列表里去掉）
  `FAIL landing=shared/asr is not covered by npm run lint: shared/ is absent from the oxlint path list (only being un-flagged is not the same as being linted)`

AC4-2 / AC4-3 是本探针的承重点：只认 endpoint 字面量（或只认响应解析）的检查器在这两条上会保持绿。三条变体各自单独加入、单独判红、随后移除并复核恢复为绿 —— 免得一条用例的绿掩盖另一条的红。每条取假用例都先断言未变异的工装根为绿，故「红」不可能是恒红。

**判据的机械承重点落在哪条 lane（runner 实测，非推断）**：AC3/AC4/AC5 的控制**不在** `scripts/test.sh` 的两条 lane 里。scoped 门对本任务读薄 —— `scripts/test.sh:112` 用 `grep -E '\\.test\\.[jt]sx?$'` 从 Touches 取测试文件，`.test.mjs` 的 `m` 不在 `[jt]` 内，故取到 0 个文件并走 `scripts/test.sh:114` 的薄路径；读数是 `no scoped test files for gap-asr-wire-single-implementation-boundary-probe (thin)` / `EXIT=0`。全量 suite 也不跑这条 lane：它的文件集是 `find server -name '*.test.ts' -o -name '*.test.js'`（`scripts/test.sh:482`）加一次 vitest（`CLIENT_FILES=__all__`，include 为 `src/**/*.test.ts(x)`）。`scripts/**/*.test.mjs` 由 `npm run test:scripts`（`node scripts/list-script-tests.mjs && node --test "scripts/**/*.test.mjs"`）执行：探针文件自身 4/4 pass，该 lane 全体 26/26 pass。**登记这条不是抱怨，是披露**：假形态控制是 AC3/4/5 的全部机械承重，读者应当知道它跑在哪条 lane，而不是从「scoped 门是绿的」推出「控制跑过了」。把 `.mjs` 接进 scoped 门的正则、或把 scripts lane 接进 suite，都超出本任务的写入面，故只登记不改。

**AC6 判据命令的一处收窄（口径，非不变式）。** 原文命令去重后是 **3** 个文件，不是 1；多出的两个是**测试**：`server/modules/voice/tests/voice.service.test.ts:49`、`src/shared/tests/voiceConfigHydration.test.ts:152,162`，各自独立钉住 `…/v1/audio/transcriptions` 这个字面量。这两个字面量正是 AC9「既有读数不变」的**独立性**来源：若改成从实现派生（拼 `TRANSCRIPTION_PATH`），实现换了 URL 它们会跟着换，AC9 就变成空的。故按 AC6 自己的标题「唯一性（生产源）」把命令收窄为 `--exclude=*.test.ts`：生产源去重后 = 1（`shared/asr/transcriptionWire.ts:28`），且仍可红（把逻辑抄回 `src/shared/api.ts` 即 2，与 AC3 同形）。收窄的是取数口径，不是不变式。

**第二轮：一次 suite 红的根因，与合并 develop 时的语义并集**（本任务交付时的最终树 = HEAD `a19a1e2d`，develop = `92a72b64`，`git merge-base --is-ancestor develop HEAD` 成立）。

第一次 fan-in 的 suite 红在两个文件上：`src/modules/chat/tests/voiceClipPlayback.test.tsx`（17 条里 2 条红）与 `src/modules/chat/tests/voiceTranscriptRepair.test.tsx`（2 条全红），判词都指向「composer 没收到转写文本」。根因不是这两条测试，是**这次重构改掉了直连路径读取响应体的方式**。本分支早先的形态是 `parseTranscriptionResponse(await res.text(), 'strict')`，而这两条测试的 `transcribeVoice` 桩只实现了 `.json()`：`{ ok: true, json: async () => ({ text: … }) }`。`.text()` 不是函数 ⇒ 抛 ⇒ 落进 hook 自己的 catch ⇒ 转写永远到不了 composer。

这个形态之所以看起来无害，是因为它对**真** `Response` 逐字等价 —— 一行 `await res.text()` 加 `JSON.parse` 与 `await res.json()` 对真实响应给出同一结果。判据来自 develop 上并发落地的 `a87ba539`（AC-130 的前置）：它把直连路径的解析**具名**成 `src/shared/api.ts` 的 `parseTranscriptionResponse(response: Response)`，其体就是原本的内联表达式，且两处测试以 `parseTranscriptionResponse: actual.parseTranscriptionResponse` **真跑**它（注释原文："a second copy of the parse here would be a second copy of the thing under test"）。两条路径**原始**的读取方式本来就不一样：直连走 `json()`，代理走 `text()`（服务端先要把 `responseText` 交给自己的失败分支）。

故修法是把**读取方式也一并参数化进唯一实现**：`parseTranscriptionResponse(response: Response, tolerance)` —— `strict` 走 `await response.json()`，`lenient` 走 `await response.text()` 再 `JSON.parse`。两条路径各自停在它一直用的那个调用上，谁都没有被「统一」成另一个的写法；这不是把 `res.text()` 换个写法，而是让这次重构**真的**不动线上行为。`src/shared/api.ts` 保留 develop 那个具名导出（AC-130 的 `experiments/voice-asr-parity/read-client.ts` 按名字驱动它，`scripts/asr-extraction-parity-check.mjs` 按 `export async function parseTranscriptionResponse` 定位 seam），体改为一行委派给唯一实现 —— 这就是与 develop 的**语义并集**：develop 的「给直连路径的解析一个名字」与本任务的「实现只有一份」同时成立，而不是二选一。合并冲突只有 hook 一处（import 段被 git 自动并成两行同名 import，也是错的，一并收成一行）。

一处只有这一轮才会暴露的实测：`Response.json()` 在根 tsconfig 的 DOM lib 下是 `any`，在 `@types/node` 下是 `unknown`，故 `const data: { … } | null = await response.json()` 在 `server/tsconfig.json` 下报 `TS2322`。改成对结果做断言（`as { text?: unknown } | null`）后两套配置同时编译 —— AC7 的「同一份实现被两套配置同时编译」不只是登记，是真的会咬人。

**纯重构的逐字核对**（回应 DoD 的「不改线上行为」）：

- 直连 URL 拼接：旧 `voiceDirectUrl(baseUrl, '/audio/transcriptions')` = `` `${baseUrl.replace(/\/$/, '')}${path}` ``，新的 `transcriptionEndpoint` 逐字相同（`voiceDirectUrl` 保留给同文件的 TTS 路径，不在本任务边界内）。
- 代理 URL 拼接：旧为 `` `${config.baseUrl}/audio/transcriptions` ``（不裁尾斜杠），新为 `transcriptionEndpoint`。可达状态下逐字相同：`config.baseUrl` 只能来自 `voice.module.ts` 的 `(process.env.VOICE_API_BASE_URL || '').replace(/\/$/, '')`，且 `resolveVoiceConfig` 不允许请求覆盖 baseUrl。
- 直连响应：旧 `const data = await res.json(); String(data?.text || '')`，新的 strict 分支逐字相同（含 `data` 为 `null` 时走 `?.` 这一历史行为）。
- 代理响应：旧 `const responseText = await response.text();` 加 `try { JSON.parse; typeof parsed.text === 'string' ? parsed.text : '' } catch { responseText }`，新的 lenient 分支逐字相同（含 `JSON.parse('null')` 时读 `.text` 抛 TypeError 而落回原文这一历史行为）。服务端把 `response.text()` 移进了失败分支，两边都只读一次体。
- multipart：字段名 `file` / `model`、Blob 容器、Authorization 头均未变。`server/modules/voice/voice.service.ts` 里留给 TTS 的本地 `authorizationHeader` 与本模块内的同名私有函数并存 —— TTS 不在 AC-129 的词内（ADR-004 决策 2 只覆盖转写线），刻意不动。

**独立复核：AC-130 的逐字节基线**（不是本任务的判据，是一条顺手可跑的独立读数）。`node scripts/asr-extraction-parity-check.mjs` 用 `experiments/voice-asr-parity/` 的两个 reader 驱动**出货符号**（`transcribeVoice` / `parseTranscriptionResponse` / `createVoiceService`），与 develop 上记下的基线逐组比对：

```
group inbound equal sha256=dc18ceac9e46f623c0eb7d4fe5616ead48864f4185eea6f8159335ca5016c871
group direct-outbound equal sha256=6985b92a09881c3ff249aa14a35ccd06a71925ea1f5937691f223e344d834c87
group proxy-outbound equal sha256=93899fb6cc81f87b52aa0e4d2ff6389ed1723974196c7c7b5ae3ecb43423c8fd
group response-tolerance equal sha256=aa0189610da7bdd63ed65f6c436ee725426dc69d20c440943606584aa11026c2
observed sha256=81f24ac8852349d3cefead3eb3d40dd461e6773d73778f8cbb48465afc7730a6
verdict PASS
```

四组全部 `equal`，整体 `observed sha256` 与基线 sha256 逐字相同。这是「纯重构」最硬的一处外部证据：转写链两跳的请求字节、以及两条路径各自的响应容忍度，在被本任务改过之后与改之前**逐字节相同**。它同时也否证了本轮修法的一个可能误读 —— 把 strict 改成 `.json()` 并没有动直连路径的线上读数。

**接线之外的写入面**：新增 `vitest.config.ts` 一处别名登记（AC9 需要，见上）；落点判定后 Touches 里未落的那一支 `src/shared/asr/transcriptionWire.ts` 已移除 —— 写入面声明应当只声明真实写入面，未落的后备落点记在这里而不是留在声明里。`src/shared/api.ts` 保留 develop 那个具名导出属于**合并并集**，不是新增写入面（该文件本来就已在 Touches 内）。

**未覆盖项（如实登记，不在本任务词内）**：`experiments/` 与根级配置文件（`vite.config.js` / `vitest.config.ts` / `tsconfig.json` / `.oxlintrc.json`）都不在 `npm run lint` 的路径列表内，所以命令行入口与这几处别名登记本身没有任何 lint 读数；`experiments/voice-asr-cli/transcribe.ts` 还不在任何一条 tsconfig 的 `include` 内（由 `npx tsx` 直接执行），因此它也没有 typecheck 读数 —— AC10 给的是「真能加载」的运行读数。这是本仓库既有形态，扩 lint 路径列表 / tsconfig include 超出 AC-129 的词与写入面，故只登记不改。

**后端/前端模块规范的适用说明**（AGENTS.md 要求）：本任务改动了 `server/` 与 `src/` 下的代码，两份 SKILL 均已加载。`server/modules/voice/voice.service.ts` 仍是「路由薄、服务承重」的既有形态，跨模块导入仍走 `@/shared/types.js` 桶，删除的是模块内私有 helper（无导出、只有一个消费者），未新建模块局部 `types.ts`/`utils.ts`。前端的「API 端点集中在 `src/shared/api.ts`」一条与 ADR-004 决策 2 相抵：端点必须被三套配置同时编译，而 `server/tsconfig.json` 明确 `exclude` 了 `../src`，所以这一份不能落在 `src/shared/api.ts`。解法是 AC-129 本身的词：`src/shared/api.ts` 仍是前端 API helper 的家（`transcribeVoice` 留在原处、只把线协议构造委派出去；`parseTranscriptionResponse` 也留在原处、只把解析委派出去），端点定义收敛到唯一一份而不是散落 —— 与该条的意图同向。`useVoiceInput.ts` 只导入响应解析，不重定义任何端点细节。

## DoD

真实落地判据：不是探针文件存在，而是**三处消费者真的经由同一条路径落到同一份线协议实现**，且**判据自己是可红的**。承重性由三组正面读数证明：

(a) **探针解析的是真实的 import 说明符，不是一张清单** —— 对工装根里「前端与服务端各写一份」的形态必红（AC3）；
(b) **唯一性扫描不是空读数** —— 对「工装里复制一份算法」必红（AC4），对「什么都没有」的工装根同样必红（AC5）；空 glob 退出 0 是本仓库已经付过代价的形态，不允许在这里复发；
(c) **纯重构** —— typecheck / lint / 既有语音测试全绿（AC7/AC8/AC9），两条路径各自的字段名与容忍度差异都与改前一致。

本任务**不证明**线上字节逐字节不变 —— 那要录两跳的基线，属 AC-130 的任务；本任务只保证重构不改变行为语义与容忍度分叉（AC-130 的基线在本次交付的树上独立跑为 `verdict PASS`，见 Evidence，但那是顺手复核而非本任务的判据）。若落 (b)，须如实登记「服务端能否消费该落点」的实测结论，以及它对 GOAL-008 缺口一／三（AC-133／AC-134）的后果。

**若两条落点都无法让三处消费者解析到同一路径**：不得自行放宽判据（例如把消费者从三处改成两处、或把命令行从三处里去掉），必须停在 needs-human 并给出两次尝试的原始判词。

L_D 该轴仍暗，理由：本任务只把一份线协议实现收敛到一处并落一条边界探针，不新增领域数据能力，也没有可读出的领域读数。

L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担，本任务只承担「实现只有一份、三处同一路径」这一条。

## Touches

- shared/asr/transcriptionWire.ts (new)
- src/shared/api.ts
- src/modules/chat/hooks/useVoiceInput.ts
- server/modules/voice/voice.service.ts
- experiments/voice-asr-cli/transcribe.ts (new)
- scripts/asr-single-implementation-check.mjs (new)
- scripts/asr-single-implementation-check.test.mjs (new)
- tsconfig.json
- vite.config.js
- vitest.config.ts
- .oxlintrc.json
- package.json
- tasks/gap-asr-wire-single-implementation-boundary-probe.md
