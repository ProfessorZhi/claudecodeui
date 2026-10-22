---
id: gap-voice-capture-isolation
title: 捕获失败的隔离：text 档打印捕获行时抛错、audio 档音频目录不可写两种情形下转写仍返回成功且返回文本逐字不变，恰好一行不含内容的
  voice.capture failed（AC-147）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-capture-mode-gate-off-fail-closed
  - gap-voice-capture-audio-file
  - gap-voice-error-classification-ac7-vitest-child-fragile
goal_ac: AC-147
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on` 上）：立案时 `grep -rho '^goal_ac: *AC-147' tasks/*.md` 零命中；`grep -rln 'AC-147' tasks/` 只命中三份同族任务的**范围让渡**文字（`gap-voice-capture-text-payload`、`gap-voice-capture-audio-file`、`gap-voice-capture-secrets-three-modes`），其中前两份的边界原文写着「不做捕获异常的隔离判据（AC-147）」；`grep -rln 'voice-capture-isolation\|voice\.capture failed' tasks/ server/ src/ scripts/` 零命中。GOAL-010 的六条判据各有一份互不重叠的判据文件，本条只认领 AC-147 的那一份（`-isolation`）：AC-143 是 `voice-capture-off.test.ts`（闸门与接缝），AC-144 是 `voice-capture-text.test.ts`（text 档载荷），AC-145 是 `voice-capture-audio.test.ts`（audio 档写文件），AC-146 是 `voice-capture-secrets.test.ts`（三档脱敏），AC-148 是 `scripts/voice-capture-process-check.mjs`（真实进程）。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/voice-capture-isolation.test.ts` → `No such file or directory` |
| 捕获通道本体 | `grep -rln 'voice-capture\|VOICE_CAPTURE' server/ src/ scripts/` → 0 个文件（接缝由 AC-143 出货，本条只消费） |
| 失败行 | `grep -rn 'voice\.capture failed' server/ src/ scripts/` → 零命中；`grep -rn 'voice-capture-isolation' tasks/` → 零命中 |
| 唯一的尝试日志出口 | `voice.service.ts:717` 的 `logAttempt`，8 处调用（735/757/767/794/800/844/852/867），把行交给注入端口 `voice.service.ts:652` 的 `const log: VoiceLogPort = dependencies.logger ?? console` |
| **捕获抛错今天会变成转写失败** | 成功分支的 `logAttempt('ok', 200, …)` 在 `voice.service.ts:852`，**位于** `voice.service.ts:804` 的 `try {` 之内；其 `catch (error)` 在 `voice.service.ts:861` 把任意抛出折成 `unreachableBackendFailure(error, dependencies.timeoutMs)` 并 `return refusal`（另打一行 `logAttempt('fail', …)`）。捕获若挂在这个出口上而不自带 catch，一次日志端口抛错就把成功的转写**变成失败** —— 这正是 AC-147 要堵的洞，也是取假形态 (i) 的靶子 |
| 两个注入面都真实存在 | 日志端口可注入（`dependencies.logger ?? console`）；音频写端口由 AC-145 在组装处注入（`writeAudio`，收到上传字节与 `captureId`）。所以「打印捕获行时抛错」与「写文件时抛错」两条路都可用真出货件驱动，不需要改契约 |
| 失败行今天无处可生 | 提案要求「捕获全部包在 try/catch 里：失败只打一行 `voice.capture failed`（不含任何内容）」；今天没有任何一行以该字面量开头 |

**要交付的五件事**

1. **隔离与失败行只有一份**（扩 `server/modules/voice/voice-capture.ts`，AC-143 出货的那个模块；不新开第二份）：一个纯函数（名字自定）承担「尝试记录 → 行」的全部工作并把自身包在 try/catch 里；成功时交出那一行，抛出时交出**恰好字面量** `voice.capture failed`（不带任何参数：不拼 error 消息、不拼 error code、不拼捕获记录的任何字段）。
2. **捕获调用点自带 catch，且必须比 `voice.service.ts:804` 的那层更内层**：在捕获的调用点外面包一层**局部** try/catch，使捕获端口与日志端口的抛出**到达不了** `voice.service.ts:861` 的 `catch (error)`；失败时只打那一行，然后**继续走原有的返回路径**（成功分支仍返回 `{ ok: true, value: { text: result.text } }`，失败分支仍返回它自己那一支）。
3. **失败行自己也抛时仍不传播**：失败行的打印必须在同一个保护之内（可以是嵌套 guard）—— 一个对任何以 `voice.capture` 开头的行都抛的端口（`voice.capture failed` 在内）也不得让转写失败，此时那一行当然打不出来（见 AC7）。
4. **`voice.transcribe` 行不被牵连**：捕获抛错不影响该行照常打出，也不改变它的字段（除 AC-143 在非 `off` 档加的 `captureId`）。
5. **判据与取假形态**：`server/modules/voice/tests/voice-capture-isolation.test.ts`（AC-147 的 `criterion:` 文件，只有这一个文件能认领该判据）＋ `server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts`（两条取假形态的可执行旁证，沿用本仓 `voice-dashscope-settings.false-forms.test.ts` 的形状：出货源文件的副本写到同树临时路径使相对 import 仍可解析、单锚点文本变异、动态 import 变异体、重跑同一份读数表、跑完即删；未变异副本必须先退出 0）。

**边界（不做）**：不做闸门与模式解析（AC-143）；不做 text 档载荷细化（AC-144）；不做 audio 档写文件与目录/文件权限（AC-145）；不做三档脱敏判据（AC-146）；不做真实进程判据（AC-148）；不改 `voice.transcribe` 行在 `off` 档的逐字节形状；不改 `voice.module.ts`；不改适配器与 registry 契约；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端；不改 TTS 通路；不联网、不重跑实验、不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [x] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-isolation.test.ts` 退出 0；判据自身零子进程、零网络、零真实监听端口；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。读数表导出为对**任意**模块路径可重跑的 `collectReadings(modulePath)`（取假形态据此驱动变异体），读数名格式 `AC<n> <label>`（保持既有可归因形态）。
- [x] AC2 text 档 · 打印捕获记录行时抛错 ⇒ 结果与文本逐字不变：`VOICE_CAPTURE=text`（把 `process.env.VOICE_CAPTURE` 的**原文**交给出货的模式解析函数，不写字面量，端口也用出货的构造函数建），注入的日志端口在收到以 `voice.capture {` 开头的行时抛一个哨兵错误、其余行原样记录。对同一份录音跑一次成功的转写，与「同一次运行内以不注入 capture 端口构造的基线服务」在同一份输入上的结果比对：`ok` 相同、`status` 相同、`value.text` **逐字相同**。正例（抛过的读数才算数）：打印 `text.captureThrew=<n>`（必须 ≥ 1）、`text.thrownOnCaptureLine=<b>`、`text.resultIdentical=<b>`、`text.textByteIdentical=<b>`。
- [x] AC3 text 档 · 转写行不变且恰好只多一行：同一 arm 里，`voice.transcribe` 行去掉 `captureId=<…>` 记号后与基线的那一行**逐字节相同**；以 `voice.capture` 开头的行恰好 **1** 行，其去掉首尾空白后**逐字等于** `voice.capture failed`。打印 `transcribeLineEqual=<b>`、`failedLines=<n>`、`failedLineVerbatim=<b>`。
- [x] AC4 失败行不含内容（带正例）：同一 arm 里造三个本次运行唯一的针：`TRANSCRIPT_SENTINEL`（替身上游信封里作为返回正文的那一段）、`AUDIO_BYTES`（上传字节，≥ 192 字节）、`KEY_SENTINEL`（`settings.dashscopeApiKey`）。断言并打印：(a) **正例** —— `serviceHadText=<b>`（返回的 `value.text` 含 `TRANSCRIPT_SENTINEL`）、`wireCarriedKey=<b>`（替身 fetch 收到的 `Authorization` 逐字等于 `Bearer <KEY_SENTINEL>`）；(b) **负例** —— `voice.capture failed` 那一行的原始文本里**不含** `TRANSCRIPT_SENTINEL`、`AUDIO_BYTES` 的 base64、`AUDIO_BYTES` 的原始字节子串、`KEY_SENTINEL`、`Bearer `、`Authorization`、`Content-Type` ⇒ `failedLineContentFree=<b>`。音频这一族针的**正例在 AC5**（text 档不写文件，AC-145），本条如实登记这个跨 arm 的控制，不假装它在本 arm 里被读。
- [x] AC5 audio 档 · 音频目录不可写 ⇒ 结果与文本逐字不变，且失败行照出：`VOICE_CAPTURE=audio`，`VOICE_CAPTURE_DIR` 指到本次运行新建的临时目录下**正好落在一个普通文件之下**的路径（`<tmp>/blocker` 用 `writeFileSync` 造成普通文件，路径为 `<tmp>/blocker/voice-capture`），于是出货的 `writeAudio` 默认实现在 `mkdirSync` 上抛 `ENOTDIR`。对同一份录音跑一次成功转写：与 capture-off 基线比对 `ok`/`status`/`value.text` 逐字相同；以 `voice.capture` 开头的行恰好 1 行且去掉首尾空白后逐字等于 `voice.capture failed`；`fs.existsSync(<tmp>/blocker/voice-capture) === false`。正例：`audio.writeAttempts=<n>`（≥ 1）、`audio.writeRefused=<b>`（计数包装确实看到抛出）、`audio.bytesInHand=<b>`（包装把它收到的字节数与 `AUDIO_BYTES.length` 比，逐字节相同）—— 这就是 AC4 里音频那一族针的正面控制。打印 `audio.resultIdentical=<b>`、`audio.textByteIdentical=<b>`、`audio.dirCreated=<b>`、`audio.failedLineVerbatim=<b>`。
- [x] AC6 上游失败的转写其错误状态不因捕获失败而改变：同一运行里再驱动一次上游失败（替身 fetch 对 dashscope 那条请求回 404 + 判据自造的 JSON 错误体），用同一份抛错日志端口：与「捕获关闭时同一次 404」的结果比对，`ok === false` 相同、`status` 相同、`error`（消息）**逐字相同**；其 `voice.capture failed` 行同样逐字出现。打印 `fail.ok=<b>`、`fail.status=<n>`、`fail.errorEqual=<b>`、`fail.failedLines=<n>`。
- [x] AC7 失败行自己也被抛时仍不传播（同一不变量的更硬读法）：同一 arm 换一个「对**任何**以 `voice.capture` 开头的行都抛」的日志端口（`voice.capture failed` 也在内）⇒ 转写仍返回 `ok`、`value.text` 仍与基线逐字相同（此时那一行打不出来，本读数**不**要求它出现）。打印 `hardPort.threw=<n>`（≥ 1）、`hardPortSurvives=<b>`、`hardPort.textByteIdentical=<b>`。
- [x] AC8 既有面不退化：`server/modules/voice/tests/voice-capture-off.test.ts`（AC-143）、`voice-capture-text.test.ts`（AC-144）、`voice-capture-audio.test.ts`（AC-145）、`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts` 各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0；逐条打印退出码（不是空过）。
- [x] AC9 两个取假形态是**可执行**的旁证：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts` 退出 0，其中每条**先要求未变异副本退出 0**（恒红的工装不能证明任何事），再各自指名打红哪一条读数：(`i`) `capture-throw-reaches-the-outer-catch`：去掉捕获调用点的局部 try/catch（让抛出落进 `voice.service.ts:861` 的 `catch (error)`）⇒ 必须让 AC2 的 `text.resultIdentical` 判红（结果由 `ok` 变 `ok:false`）；(`ii`) `failed-line-carries-the-transcript`：让失败行拼上返回正文（例如 `voice.capture failed ` + 返回文本）⇒ 必须让 AC4 的 `failedLineContentFree` 判红（针命中）。变异体复制到同树临时路径（与 `voice-capture-isolation.test.ts` 同目录，使相对导入仍可解析）、跑完即删，`git status --porcelain` 在跑完后为空；每条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<AC2|AC4>`。
- [x] AC10 如实登记：判据输出与本任务的完成记录里写明「本条只做捕获失败的隔离与失败行本身：抛出被局部 catch 吃掉、失败行逐字为 `voice.capture failed` 且不带内容、`ok`/`status`/`text` 与不开启捕获时逐字相同；判据全程用替身 fetch、注入的日志端口与注入的写音频端口（audio 档那一次走的是出货的默认写实现加一个不可写的路径），未接触真实上游、未起真实服务进程」。

## DoD

真实落地判据：不是「多了一个 try/catch」，而是**同一份出货 service 在 `VOICE_CAPTURE=text` / `audio` 下、捕获那一环抛错时，返回给调用方的 `ok`/`status`/`text` 与不开启捕获时逐字相同**，并且账上只多一行字面量 `voice.capture failed` —— 由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **抛出是「真发生过」的**（AC2 的 `captureThrew≥1`、AC5 的 `writeRefused`、AC7 的 `hardPort.threw≥1`）：三条 arm 各有一个「注入面确实抛了」的计数读数；一个从不抛的端口证明不了隔离，所以该计数为 0 时同 arm 的 `*=Identical=<b>` 不算读数（本仓的老坑：**「零」的读数必须配一个正面控制**）。

(b) **抛出真的会伤到转写，所以隔离不是装饰**（AC9 的取假形态 (i)）：`voice.service.ts:852` 的那次 `logAttempt('ok', 200, …)` 就在 `voice.service.ts:804` 的 `try` 之内，其 `catch (error)`（`voice.service.ts:861`）会把任何抛出折成 `unreachableBackendFailure(...)` 的失败 —— 所以「去掉局部 catch」这个变异体必然把 AC2 的 `resultIdentical` 打成 `ok:false`。这把「捕获异常向上传播使转写失败 ⇒ 必须红」从一句担心变成一条可执行读数。

(c) **失败行的「不含内容」是搜出来的**（AC4 + AC5 的跨 arm 正例 + 取假形态 (ii)）：三个针族各有一处正面控制证明它们物理上到过捕获面（返回文本里有正文、线上带着 key、写端口收到的字节数与上传逐字节相同），负例在同一行上搜不到它们；变异体 (ii) 让这一条指名变红 —— 所以「没写正文」与「什么都没写」不是同一句话，而是两条读数。

**必须如实登记**：本条**不**做闸门与模式解析、**不**做 text 档载荷、**不**做 audio 档的写文件与权限、**不**做三档脱敏、**不**做真实进程；判据跑在替身 fetch、注入的日志端口与注入的写音频端口上（audio 档那一次走出货的默认写实现加一个不可写路径），未接触真实上游、未起真实服务进程；`VOICE_CAPTURE` 只在服务端环境变量上，不进设置页与健康负载。

**已知不等价点**：`voice.capture failed` 的**逐字相等**是对提案「失败只打一行、不含任何内容」的直接编码，比 AC 的 `expect` 字面（只说「不含转写正文、音频与 key」）更严 —— 若实现时确有必要在行上带错误类别，登记为发现并改读法，不静默放宽；AC7 读的是同一不变量的更硬形态（连失败行也打不出来时仍不传播），不是第二个命题；替身上游 404 的体是判据自造的，不等于真实 DashScope 的错误体；「不含」是「判据放的针在行里找不到」，不是对全部可能内容的穷举。

L_D 该轴仍暗，理由：本条读数全是布尔、计数与逐字比对，没有可比的数值量；捕获失败是判据注入的常量而不是测量。

L_G 该轴仍暗，理由：目标层的读数是真实服务进程标准输出上「捕获失败不影响转写」的现场（那条判据要求真实进程与本地替身上游），本条只到 service 面与组装面。

## 完成记录

**落地**：代码改动只有一处 —— `server/modules/voice/voice.service.ts` 的 `logAttempt` 里，在 `recording.recordAttempt(captureId, { … })` 这个**调用点**外面包一层**局部** try/catch。它比 `transcribe` 末尾那层 `catch (error)`（把任意抛出折成 `unreachableBackendFailure(...)` 的那一层）更内层，所以捕获通道的抛出**到达不了**它。catch 里**只**打一个字面量 `voice.capture failed`，然后**继续走原有的返回路径**：成功分支仍返回 `{ ok: true, value: { text: result.text } }`，失败分支仍返回它自己那一支。这次失败行的打印**自己也在一个嵌套 guard 之内**（`try { log.info(VOICE_CAPTURE_FAILED_LINE); } catch { … }`），所以失败行自身被端口拒绝时也不再外泄（AC7）。常量 `VOICE_CAPTURE_FAILED_LINE = 'voice.capture failed'` 声明在 `voice.service.ts` 自己的模块体里，**没有**以值的形式 import 捕获模块（理由见「已登记的不等价点」第 6 条）。

**两条路走的是同一个 guard**，因为两条路都是 `recordAttempt` 抛出来的：日志端口拒绝捕获行（`recordAttempt` 末尾那次 `dependencies.log.info(JSON.stringify(row))`），以及 audio 档 `writeAudio` 在不可写目录上抛的 `ENOTDIR`。**捕获模块 `voice-capture.ts` 与出货文本逐字节相同** —— 隔离不在它里面，见下。

**三条锚点在 `voice.service.ts` 里各恰好出现一次**（取假形态据此做单点变异）：`        try {\n          recording.recordAttempt(captureId, {`、`\n        } catch {`、`            log.info(VOICE_CAPTURE_FAILED_LINE);`。

**上一轮的落地为何被撤回（本轮相对上一轮的实质改动）**：上一轮把「建行 + 写音频」搬进捕获模块里的一个模块私有纯函数，并在那里 catch。那个落点让三条既有的兄弟判据变红；本轮把这一半撤回，隔离只剩调用点这一处。三处根因各自有独立读数：

1. **写守卫的拼写与缩进是 `voice-capture-audio.false-forms.test.ts` 的单点变异锚。** 该文件为证明自己的 AC6 读数测的是「模式闸门」，变异 `write-in-text-too` 把 `      if (dependencies.mode === 'audio' && dependencies.audio !== undefined) {` 整行替换成丢掉 mode 的版本。上一轮的搬迁把这一行改成 `input.mode`/`input.audio`、缩进也从 6 格变 4 格，锚点因此在出货文本里出现 **0 次**，该文件红在「an anchor for write-in-text-too occurs 0 times in the shipping module」。撤回后该行唯一且逐字相同。
2. **`voice.service.ts` 对 `./voice-capture.js` 的 import 是 type-only，这是它运行时模块图的既有性质**：捕获模块在运行期只经注入端口到达，转写路径的运行期图不因它多一条边。上一轮加了一个**值** import（`VOICE_CAPTURE_FAILED_LINE`），把捕获模块变成运行期边；`voice-provider-dispatch-falsify` 在临时树里只用 `voice.service.ts` + `shared/asr` 重建这条路径，于是死在 `ERR_MODULE_NOT_FOUND: .../server/modules/voice/voice-capture.js`。这一个红又顺着「既有面不得变红」的读数传给 `voice-error-contract`（AC6）与 `voice-error-classification`（AC7）—— 三红同源。撤回值 import 后三者同时复绿。
3. **本条的取假形态原先把 `git status --porcelain` 的前后快照直接比相等**，而 `__criterion-falsify-` 临时副本所在的目录是与兄弟判据**共享**的、套件又并发跑：兄弟进程在「本文件加载」时刻还持有着的副本，到「本文件读数」时刻已被它自己清掉，于是两个快照不等，读数报 `unchanged=false`，而结束态其实是空的。现按本仓既有协议按 pid 归属：自己的副本（`own-temp-copies`）仍然无条件算红，只有当差异里**每一行**都是别的 pid 的临时副本时才豁免，并打印 `raw-unchanged` / `foreign-temp-copies` / `concurrent-foreign-only`，把被排除的东西显式化成读数而不是隐含在判决里。

**读数**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-isolation.test.ts`，8/8 通过，`elapsed-ms=42`，`subprocess-or-socket-imports=0`，读数 7/7；`elapsed-ms` 随负载浮动，本任务历次落地测得 41–61，均远在 15000 预算之下）：

- AC2 `text.captureThrew=1 text.thrownOnCaptureLine=true text.resultIdentical=true text.textByteIdentical=true`
- AC3 `transcribeLineEqual=true failedLines=1 failedLineVerbatim=true failedLine="voice.capture failed"`；基线行与抛错行去掉 `captureId=<…>` 记号后逐字节相同：`voice.transcribe providerId=dashscope-omni outcome=ok status=200 latencyMs=0 promptVersion=written-e-2026-09-24 writtenFallback=1`
- AC4 `serviceHadText=true wireCarriedKey=true failedLineContentFree=true failedLines=1 needles-present=[] needles=9`
- AC5 `audio.resultIdentical=true audio.textByteIdentical=true audio.dirCreated=false audio.failedLineVerbatim=true audio.failedLines=1 audio.writeAttempts=1 audio.writeRefused=true audio.bytesInHand=true audio.rows=0`
- AC6 `fail.ok=false fail.status=404 fail.errorEqual=true fail.failedLines=1 baseline.ok=false baseline.status=404 error="provider 'dashscope-omni' answered 404"`
- AC7 `hardPort.threw=2 hardPortSurvives=true hardPort.textByteIdentical=true hardPort.failedLines=0 hardPort.threwOnRow=true hardPort.threwOnFailedLine=true`
- AC10 `adapter=dashscope-omni arms=baseline:off textThrow:text audioBlocked:audio failBaseline:off failThrow:text hardPort:text doors=0`，并打印 scope / out-of-scope / fixtures / truth / clock 五格。

**取假形态**（`voice-capture-isolation.false-forms.test.ts`，4/4 通过，约 26s）：两条各自「未变异副本先退出 0 且 7/7 读数全绿 → 变异体在预测族里红并指名哪一条 → 族外至少一条仍绿」：

- `capture-throw-reaches-the-outer-catch`（去掉调用点的局部 try/catch）⇒ 变异体红 6 条读数，族内命中 `AC2`：`text.resultIdentical=false text.textByteIdentical=false`；族外仍绿 `AC10 registration`。
- `failed-line-carries-the-transcript`（失败行拼上返回正文）⇒ 变异体红 4 条读数，族内命中 `AC4`：`failedLineContentFree=false needles-present=[TRANSCRIPT_SENTINEL]`，行原文 `failedLine="voice.capture failedtranscript-…"`、`failedLineVerbatim=false`；族外仍绿 `AC2 text throw isolation`。
- AC8 同一次运行里逐条打印退出码：七条判据各 0（21/10/10/4/7/6/8 个用例）、`npm run typecheck` 0、`npm run lint` 0。
- `falsify/leftovers: git.status-clean=true unchanged=true own-temp-copies=none temp-copies-any=0 foreign-temp-copies=0 raw-unchanged=true added=0 removed=0 concurrent-foreign-only=false`。

**已登记的不等价点（AC 点名的形态按字面不可达或不可满足，已换成可达且更严的形态）**

1. **AC2 点名的「以 `voice.capture {` 开头的行」按字面不可满足**：AC-143/144/145 已把出货的捕获行钉成 `{"event":"voice.capture",…}` —— `voice.capture` 是 `event` 字段的**值**，不是行首前缀；若行首真是 `voice.capture {`，AC3 的「以 `voice.capture` 开头的行恰好 1 行」连同「单行合法 JSON」的读法会一起崩。所以 AC2 的端口改成「**就是**一条捕获记录行」这个结构判据（`event === 'voice.capture'` 且有 `captureId`），它是两种拼写（JSON 与 `voice.capture {…}`）的**超集**，因此比原文更严而不是更松；AC7 的端口在这个结构判据之上**再加**字面量前缀，所以 AC7 的 arm 严格更难（该 arm `failedLines=0`，因为失败行也被它拒了）。判据在 AC2/AC7/AC10 三处读数里都登记了这个读法。
2. **AC9 点名的副本目录按物理不可达**：原文要求副本放「与 `voice-capture-isolation.test.ts` 同目录」，理由是「使相对导入仍可解析」；但 `voice.service.ts` 的副本若落在 `tests/` 下，`./voice-capture.js` 会解析到 `tests/voice-capture.js`、`../../../shared/asr/asrRegistry.js` 会解析到 `server/shared/asr/…`，两者都不存在 —— 与它自己给的理由相反。所以两条的副本都落在**模块自己的目录** `server/modules/voice/` 下（`__criterion-falsify-<name>-{base,mut}-<pid>.ts`），相对导入按原样解析；`server/tsconfig.json` 的 `exclude` 按**名字**（`./**/__criterion-falsify-*`）排除这一族临时副本，副本因此进不了 typecheck 的 `include`。
3. **AC3 的跨 arm 逐字节比对需要冻住时钟**：该行带 `latencyMs=${Date.now() - startedAt}`，两个 arm 之间会因为墙钟差而不同，与接缝无关。所以判据在整段测量里把 `Date.now` 钉到 `FROZEN_NOW` 并在 `finally` 里恢复（AC1 的预算因此在恢复之后测，同进程的兄弟判据不受影响）；两个 arm 都读到 `latencyMs=0`。AC10 的 `clock=` 一格登记了这件事。
4. **AC4 里音频那一族针的正例只能在 AC5 读出**：text 档不写文件（AC-145），所以 `AUDIO_BYTES` 的正面控制（写端口收到的字节与上传逐字节相同）只能挂在 audio 档那一次上；AC4 的「不含音频字节」负例与 AC5 的 `bytesInHand=true` 是**同一次运行**里的两条读数。AC4 的 `expect` 里已明写这个跨 arm 的控制在 AC5，本条不假装它在本 arm 里被读。
5. **取假形态 (i) 让 `transcribe` 从「返回失败」变成「抛出」**：去掉局部 catch 后，抛出落进 `voice.service.ts` 末尾的 `catch (error)`，而它自己的 `logAttempt('fail', …)` 会再进一次 `recordAttempt`、再抛一次，于是 `transcribe` 是**拒绝**而不是返回。所以 `runArm` 把拒绝折进读数视图（一个 `threw` 位），AC2 读到的是 `resultIdentical=false` 这条**可归因**的读数，而不是工装崩溃。
6. **隔离的落点与 `## Touches` 的收窄**：Proposal 的「要交付的五件事」第 1 条把落点写成「扩 `server/modules/voice/voice-capture.ts`」，本轮**不**这么做 —— 隔离只在 `voice.service.ts` 的调用点，捕获模块与出货文本逐字节相同，因此 `## Touches` 里也不再声明它。理由不是省事，而是两条独立读数：(a) 上面第 1 条实测证明，把建造搬进捕获模块会移动兄弟判据的单点变异锚，而没有任何一条 AC 要求隔离住在捕获模块里；(b) AC9(i) 点名的变异是「去掉**捕获调用点**的局部 try/catch」，只有当调用点是**唯一**隔离点时，这条变异才会把 AC2 打红 —— 隔离若同时在捕获模块里，该变异就失去承重性（DoD 的 (b) 条正是靠它把「隔离不是装饰」变成可执行读数）。AC 是权威，Proposal 的机制描述让位于它；此处如实登记这处偏离，不静默放宽。

**跨任务那一格**：本条不改任何 AC-143/144/145 的判据文件（七条判据在 AC8 里逐条退出 0，读数一字未动）；`voice-capture-audio.ts` 的 `VoiceCaptureAudioSink.writeAudio` 契约（AC-145 出货的 `(directory, captureId, audio) => string`）被本条**原样消费**，只多了一个「它抛错时被调用点的 guard 接住」的读法。撤回上一轮的落地后，`voice-capture.ts` 对 AC-143/144/145 而言回到逐字节相同，`voice-provider-dispatch-falsify` / `voice-error-contract` / `voice-error-classification` 三条兄弟判据复绿（各自 standalone 退出 0）。

**边界（未做，如实登记）**：不做闸门与模式解析（AC-143）、不做 text 档载荷细化（AC-144）、不做 audio 档写文件与权限（AC-145）、不做三档脱敏（AC-146）、不做真实进程判据（AC-148）；不改 `voice.transcribe` 行在 `off` 档的逐字节形状；不改 `voice.module.ts`；不改适配器与 registry 契约；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端；无重试、无退避、无告警上报（失败只留一行，这是出货行为不是遗漏）；判据全程用替身 `fetchBackend`、注入的日志端口与注入的写音频端口（audio 档那一次走出货的默认写实现加一个不可写路径），未接触真实上游、未起真实服务进程、未开监听端口。

## Touches

- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-capture-isolation.test.ts (new)
- server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts (new)
- tasks/gap-voice-capture-isolation.md

## Needs-Human

**执行 2026-09-27T06:09:25.530Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=116668 server/modules/voice/tests/voice-error-classification.false-forms.test.ts passed=false end_ms=1790488558926
- run_id：wk-prod-anchor
- session_id：aa525928-f360-4921-864b-1b561b37a35d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-capture-isolation~wk-prod-anchor~1790488396306-3adff6.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-capture-isolation-wk-prod-anchor.log
## 人工复核（2026-09-27，人 yale 指令「检查和推进」）

停在 needs-human 的判词是 `server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 红。核对：

- 本任务自己的 `## Touches` 判据在同一份日志里都是 `passed=true`：`voice-capture-isolation.test.ts`、`voice-capture-isolation.false-forms.test.ts`。
- 红的文件不在本任务 Touches 里，属另一个任务（AC-149 一族）的判据文件。读该文件保留的子进程日志：红在它自己的 AC7 用例，AC7 以子进程形式跑 `npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts`，那一次子进程调用退出非零；而同一份 suite 日志里套件自己并发跑的 `src/shared/asr/tests/asrContractInvariants.test.ts` 在别的时刻是 `passed=true`。两次跑的是同一个文件、同一时间窗口内的舰队并发，符合"每个任务点掉一个共享资源"的已知形状（vitest 自身的依赖预打包/配置编译在高并发下的资源竞争），不是该文件本身的断言缺陷，更不是本任务的 delta。

结论：红是舰队并发下的资源竞争型抽签，不在本任务的 Touches 范围内，不是本任务实现缺陷。工人已正确判断「归因不出任何失败测试文件」并按协议停止重派；现按人工裁定重新排队，交给下一轮 fan-in 重跑。

## Needs-Human

**执行 2026-09-27T07:34:59.081Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=117144 server/modules/voice/tests/voice-error-classification.false-forms.test.ts passed=false end_ms=1790494480750
- run_id：wk-prod-anchor
- session_id：e94a0cd6-64ad-4f32-9c56-f4d6ad5d8e31
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-capture-isolation~wk-prod-anchor~1790494316350-a9f8f7.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-capture-isolation-wk-prod-anchor.log

## 人工复核（更正，2026-09-27 第二轮）

上一条「人工复核」把这条红判成稀疏的舰队抽签、建议重新排队——**这个判断被接下来的一轮复现推翻**：重新排队后同一红以完全相同的签名（`voice-error-classification.false-forms.test.ts` 的 AC7，同一条 `asrContractInvariants.test.ts` 断言）再次出现，累计三轮无一幸免。

真因已定位并立案：`gap-voice-error-classification-ac7-vitest-child-fragile`。AC7 会为 `src/shared/asr/tests/asrContractInvariants.test.ts` 额外拉起一个独立的 `npx vitest run` 子进程，与套件自己并发跑的同一文件互相超订 vitest 的 worker 池（`vitest.config.ts` 注释原文点名这个机制，并点名这份文件是堆内存最重的一份）；standalone 稳定绿，红只在舰队并发下出现。按 `quay-fan-in-suite-red-is-fleet-wide-redispatch-is-the-escape` 的例外条款——已落地的兄弟判据读全局事实 ⇒ 干净树 standalone 也红 ⇒ **重新派发对这个红无效**，需要先让 `gap-voice-error-classification-ac7-vitest-child-fragile` 落地。

本任务保持 needs-human；depends_on 已加入该修复任务。修复落地后再由人或机制重新排队。

## 人工复核（再更正，2026-09-27 第三轮）

上一条把状态留在 `needs-human` 并加了 `depends_on` 是自相矛盾的：`depends_on` 门控的是 `ready-pool-check.ts` 的
`todo→ready` 机械晋升扫描（`.filter((t) => t.status === TASK_STATUS.TODO && …)`），只看 `status: todo` 的任务；
`needs-human` 根本不在这条流水线里，加在它身上的 `depends_on` 是摆设，不会被机械晋升消费，仍然要靠人手动重派——
等于什么都没解决。

改正：状态转 `todo`（不是 `ready`——修复任务 `gap-voice-error-classification-ac7-vitest-child-fragile` 还没
`done`，现在派发只会再撞同一次红）。`depends_on` 已经指向该修复任务；`gap-claude-resident-busy-input`
（AC-163）现在就是同一种"卡在 todo 等前置"的形状。修复落地为 `done` 后，`ready-pool-check` 的机械晋升会自动把
本任务转 `ready`，不需要再人工干预。
