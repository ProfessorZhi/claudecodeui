---
id: gap-voice-capture-audio-file
title: audio 档把上传字节原样写成文件：行内给出路径与 sha256、目录 0700 文件 0600、多次转写逐次累积不清理、text
  档零文件零目录（AC-145）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-capture-mode-gate-off-fail-closed
  - gap-voice-capture-text-payload
goal_ac: AC-145
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on`）：立案时 `grep -rho '^goal_ac: *AC-145' tasks/*.md` 零命中，`grep -rln 'VOICE_CAPTURE_DIR\|writeAudio\|voice-capture' server/ src/ scripts/` 零命中，`ls server/modules/voice/tests/voice-capture-audio.test.ts` → `No such file or directory`。同族两条在飞任务各自白纸黑字把 audio 档让了出来 —— `gap-voice-capture-mode-gate-off-fail-closed`（`goal_ac: AC-143`，闸门与接缝）边界原文「不做 audio 档写文件与目录/文件权限」，`gap-voice-capture-text-payload`（`goal_ac: AC-144`，text 档载荷）边界原文「不做 audio 档写文件与目录/文件权限（AC-145）」。本条是它们让出的那一半，不是它们的重述；判据文件互不重叠（AC-143 是 `voice-capture-off.test.ts`，AC-144 是 `voice-capture-text.test.ts`，本条是 `voice-capture-audio.test.ts`）。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/voice-capture-audio.test.ts` → `No such file or directory` |
| 目录与写端口 | `grep -rln 'VOICE_CAPTURE_DIR\|writeAudio\|voice-capture' server/ src/ scripts/` → 0 个文件 |
| 接缝本体 | `ls server/modules/voice/voice-capture.ts` → `No such file or directory`：AC-143 的模式解析与捕获端口、AC-144 的记录构造点都还没出货，本条在它们之上加 audio 分支 |
| 唯一尝试出口 | `voice.service.ts` 的 `logAttempt`（`grep -n 'logAttempt'` 一处定义、八处调用），捕获挂在这个出口上；`off` 档它逐字节不变是 AC-143 的读数 |
| 字节与 mime 到不到接缝 | AC-144 的 AC3 要求行里有 `mime`/`bytes`/`sha256` ⇒ 上传字节本来就得到达记录构造点，所以本条的写文件**不需要**再改 `voice.service.ts`（若是实现时发现接缝只给了哈希没给字节，登记为发现，不在本条顺手改 service） |
| 仓库里已有的权限先例 | `grep -rn '0o600\|0o700\|chmod' server/ --include=*.ts`（去 tests）只三处：`database/connection.ts:101` `fs.chmodSync(file, 0o600)`、`:139` `fs.openSync(dbPath,'a',0o600)`、`plugin-registry.service.ts:49` `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` 与 `:51` `fs.writeFileSync(..., { mode: 0o600 })`。**关键区别**：后两条是 mode-at-open，受 umask 掩码削（`plugin-registry` 那处今天在 umask 022 下恰好是对的，不是因为它写对了）；AC-145 要求的是**文件系统上的读数**，所以必须显式 `chmod`/`fchmod` 收口 |
| 默认目录的锚 | `server/load-env.ts:43` 把 `DATABASE_PATH` 缺省设为 `path.join(os.homedir(), '.cloudcli', 'auth.db')` ⇒ 「与数据库同级」即 `path.dirname(process.env.DATABASE_PATH) + '/voice-capture'`，与提案第 12 行一致；`connection.ts` 的 `resolveDatabasePath()` 不导出，本条**不**去改它，只在组装处取 `process.env.DATABASE_PATH` 的目录名 |

**要交付的六件事**

1. **默认目录解析只有一份、且是纯函数**（`server/modules/voice/voice-capture.ts`，沿用 AC-143 的纯解析器形状）：入参**显式**给出（`raw: string | undefined`、`databasePath: string | undefined`），**不读 `process.env`** ⇒ `raw` 非空时逐字等于它，`raw` 为空时 `path.join(path.dirname(databasePath), 'voice-capture')`。`databasePath` 为空时的兜底与 `load-env.ts` 的缺省一致。`off` 档下这个解析函数**零调用**（AC-143 的 AC3 已在读这个不变量，本条不得破坏它）。
2. **写端口在组装处注入**（`server/modules/voice/voice.module.ts`，与 AC-143 的 `capture` 端口同一个组装点）：`process.env.VOICE_CAPTURE_DIR` 在其中**恰好读一次**，与 `resolveVoiceCaptureDir(...)` 的结果一起构成 `writeAudio` 的默认实现；端口签名由实现定，但必须收到**上传的原始字节**与本次尝试的 `captureId`，并交出写入的**绝对路径**。⛔ service 内部不得读 `process.env`、不得直接 `fs.*`（本仓 backend 标准：文件系统工作留在 service/组装面，路由只解析）。
3. **写入的字节只有一份来源**：写进文件的是被捕获的那份上传字节本身（`Buffer`），**不经过任何编码转换**（不做 base64、不做 utf8 往返、不裁剪、不加头部行、不包 JSON）。`sha256` 用 `node:crypto` 的 `createHash('sha256')` 对**同一份字节**算，64 位小写十六进制 —— 这与 AC-144 行里的 `sha256` 是同一个值的两个来源，AC-145 的读数是**从文件重算**的那个。
4. **权限是显式收口的 0700 / 0600**：目录 `mkdirSync(..., { recursive: true, mode: 0o700 })` **之后** `chmodSync(dir, 0o700)`，文件 `writeFileSync(..., { mode: 0o600 })` **之后** `chmodSync(file, 0o600)`（或等价的 `fchmod` 写法）。理由写在读数里：`mode:` 会被进程 umask 掩码削，`umask(0o000)` 下只靠 `mode:` 的实现会落成 0777/0666 —— 判据正是要在那个 umask 下读数。目录**不预建**（AC-143 的失败关闭形态沿用到 audio 档）：只有真的走进 audio 档并有一次写，目录才出现。
5. **文件名自定，但受两条不变量约束**：(a) 路径**在解析出的目录内**（`path.relative(dir, p)` 不以 `..` 开头；上传的 mime 或任何上传内容**不得**被拼进路径），(b) 逐次尝试**互不相同**（否则第二次会盖掉第一次，「逐次累积」不成立）。文件名与 `captureId` 的派生关系不限，但同一次尝试的行内 `path` 与 `captureId` 必须互相自洽（判据按不变量读，不按机制读）。
6. **判据与取假形态**：`server/modules/voice/tests/voice-capture-audio.test.ts`（AC-145 的 `criterion:` 文件，只有这一个文件能认领该判据）＋ `server/modules/voice/tests/voice-capture-audio.false-forms.test.ts`（三个取假形态的可执行旁证，沿用 `voice-dashscope-settings.false-forms.test.ts` 的三段形状：未变异副本先清空整张读数表 → 变异体必须在预测的那一族里红一条并打印红的是哪一条 → 族外至少还有一条是绿的；副本写在与被测文件同树的位置使相对 import 仍可解析、跑完即删）。

**边界（不做）**：不做三档脱敏判据（AC-146）——写进文件的只有上传字节，`key`、`Bearer`、请求头、base64 **一律不写**，但「它们没进日志与文件」是 AC-146 的读数；不做捕获失败隔离（AC-147）——目录不可写、logger 抛错时转写仍成功不属于本条，本条只登记「写失败时不得把异常内容写进任何行」这条边界由 AC-147 判；不做真实进程判据（AC-148）；不改 `off` 档 `voice.transcribe` 行的逐字节形状与启动行（AC-143 的读数）；不改 `voice-capture-text.test.ts` 任何读数；不做保留期、总量上限、自动清理、定时失效；`VOICE_CAPTURE` / `VOICE_CAPTURE_DIR` 不进设置页、不进健康负载、不进客户端；不改适配器与 registry 契约（`acceptsMime` 只读）；不改 TTS 通路；不联网、不重跑实验、不改 `experiments/` 与 `docs/experiments/` 下任何文件。

**一处已登记的跨任务风险（本条必须收掉的那一格）**：AC-143 的 AC4 有一条读数「`process.env.VOICE_CAPTURE` 在 `voice.module.ts` 里**恰好出现一次**」。`process.env.VOICE_CAPTURE_DIR` **包含** `process.env.VOICE_CAPTURE` 这个子串，所以只要那条计数是裸子串计数，本条新增的一次读取就会把它顶成 2 —— 那会让 AC-143 的目标判据变红，而红的原因与本条的机制毫无关系。收法只有一处、只动那一格：把该计数收窄为词边界匹配（`process\.env\.VOICE_CAPTURE(?!_)`）。若 AC-143 出货时已经用了词边界（或等价的 token 化读取），本条**不写**那个文件。这条收窄写在 AC8 里，是本条对该文件的唯一许可写点。

## AC

- [x] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-audio.test.ts` 退出 0；判据自身零子进程、零网络、零真实监听端口；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。
- [x] AC2 目录解析只有一份、来自出货模块、不读全局：判据把解析函数**当参数喂**（不设 `process.env`）——(a) `raw = '<tmp>/explicit'` ⇒ 返回值逐字等于它；(b) `raw = undefined`、`databasePath = '<tmp>/auth.db'` ⇒ 返回值逐字等于 `<tmp>/voice-capture`；(c) `raw = '   '`（空白）⇒ 与 (b) 同（空白不算设置）。逐条打印 `explicit=<…> default=<…> blank=<…>`。另在判据内读 `server/modules/voice/voice.module.ts` 源码断言：`process.env.VOICE_CAPTURE_DIR` 在其中恰好出现一次（词边界计数）且解析函数的符号名在该文件里被调用；打印 `envDirReads=<n> resolverCalled=<b>`。**off 档零调用**：用计数包装读出，`off` 档下解析函数调用次数 `=== 0` ⇒ 打印 `off.dirResolves=<n>`。
- [x] AC3 audio 档一次成功：`VOICE_CAPTURE=audio`、`VOICE_CAPTURE_DIR` 指向本次运行新建的临时父目录下的**不存在**路径；一次成功转写后：恰好 1 行 `voice.capture`（合法单行 JSON，`JSON.parse` 成功且 `split('\n').length === 1`）、`path` 是绝对路径、`path.dirname(row.path) === <VOICE_CAPTURE_DIR>`、`path.relative` 不以 `..` 开头、`fs.readFileSync(row.path)` 与上传 `Buffer` **逐字节相同**（`Buffer.equals` 为 true 且 `length` 相等）、**从文件重算**的 sha256 是 64 位小写十六进制且 `=== row.sha256`。逐项打印 `row.path=<…> pathUnderDir=<b> bytesEqual=<b> lenEqual=<b> shaFromFile=<…> shaInRow=<…> shaMatch=<b> rows=<n>`。
- [x] AC4 权限是文件系统上的读数，且在宽 umask 下成立：判据在 audio 段先 `process.umask(0o000)`（`finally` 里恢复原值），断言 `(fs.statSync(dir).mode & 0o777) === 0o700` 与 `(fs.statSync(row.path).mode & 0o777) === 0o600`（目录与文件都用 `statSync` 的对象本身，不是 `lstat` 的符号链接位）；打印 `umask=<…> dirMode=<…> fileMode=<…> dirExact=<b> fileExact=<b>`。**这是取假形态 (iii) 落点**：只写 `mode:` 不显式 `chmod` 的实现在 umask 0 下读到 0777/0666。
- [x] AC5 逐次累积、一个都不删（带正对照）：同一次运行对同一份输入连做三次成功转写（`captureId` 三次不同）；断言目录里恰好新增 **3** 个文件、三次行内 `path` 两两不同、每个文件与上传字节逐字节相同、每个先前记录的路径在三次跑完后**仍存在且字节不变**；**正对照（这一条让「零删除」不是空集上的零）**：第一次转写**之前**往该目录里放一个哨兵文件（内容唯一、权限 0600），三次跑完后它**仍在**、内容逐字节不变。另读 `voice-capture.ts` 与 `voice.module.ts` 源码断言无 `unlinkSync|rmSync|fs.rm\(|rmdirSync` 调用。打印 `files=<n> distinct=<b> eachEqual=<b> survivingPaths=<n> sentinelKept=<b> sentinelEqual=<b> noDeleteCall=<b>`。
- [x] AC6 text 档零文件零目录、行内不带 path（与 AC3 同一次运行，作 AC3 的正对照的反面）：`VOICE_CAPTURE=text` 同 harness 连做三次成功转写 ⇒ `fs.existsSync(<VOICE_CAPTURE_DIR>) === false`、`fs.readdirSync(<临时父目录>).length === 0`、注入的写端口调用次数 `=== 0`、**全部**捕获行都**不含** `path` 键；并断言同一批行的其余字段齐备（`captureId`/`providerId`/`mime`/`bytes`/`sha256`）⇒ 「零」不是「行也没了」的空实现。打印 `text.dirCreated=<b> text.files=<n> text.writeCalls=<n> text.pathKeyAbsent=<b> text.rows=<n> text.fieldsPresent=<b>`。
- [x] AC7 默认目录与数据库同级：把 `DATABASE_PATH` 指到本次运行的临时 `<tmp>/auth.db`、**不设** `VOICE_CAPTURE_DIR`，用出货的解析函数与端口工厂装配一次 audio 转写 ⇒ 文件落在 `<tmp>/voice-capture/` 下（`path.dirname(path.dirname(row.path)) === <tmp>`），目录权限 0700、文件权限 0600。并断言这套装配下的目录**不是** `~/.cloudcli/voice-capture`（本次运行不得触碰真实家目录）⇒ 打印 `defaultDir=<…> dirCreated=<b> files=<n> dirMode=<…> fileMode=<…> touchedHomeDir=<b>`。
- [x] AC8 既有面不退化（逐条打印退出码，不是空过）：`voice-capture-off.test.ts`（AC-143 的判据）、`voice-capture-text.test.ts`（AC-144 的判据）、`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts`、`voice-provider-dispatch.test.ts` 七条各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0。**跨任务那一格**：`voice-capture-off.test.ts` 里「`process.env.VOICE_CAPTURE` 恰好一次」的计数必须按词边界（`process\.env\.VOICE_CAPTURE(?!_)`）读 `voice.module.ts`；判据打印收窄前后的对照 `envCaptureSubstring=<n> envCaptureToken=<n> offCriterionExit=0`，并说明本条新增的 `VOICE_CAPTURE_DIR` 读取是 `envCaptureToken` 计数不动的正例。**若 AC-143 出货时已是词边界读取，本条不改该文件**，此时打印 `offCriterionExit=0 narrowed=<b>`。
- [x] AC9 三个取假形态是**可执行**的旁证：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-audio.false-forms.test.ts` 退出 0，三段形状（未变异副本先清空整张读数表；变异体在预测族里红一条并打印红的是哪一条；族外至少一条仍绿），再各自指名打红：(`i`) `write-in-text-too`：把 audio 档的守卫去掉、一律走写文件 ⇒ 必须让 AC6 的 `text.dirCreated`/`text.files` 判红；(`ii`) `bytes-reencoded`：写的不是原字节（`Buffer.from(bytes.toString('base64'), 'base64')`）或截断到一半（`bytes.subarray(0, bytes.length >> 1)`，二选一或两者各一例）⇒ 必须让 AC3 的 `bytesEqual`/`shaMatch`（及 AC5 的 `eachEqual`）判红；(`iii`) `mode-only-no-chmod`：删掉显式 `chmod`、只留 open 的 `mode:` ⇒ 在 `umask(0o000)` 下必须让 AC4 的 `fileMode`/`dirMode` 判红。变异体复制到同树临时路径、跑完即删，`git status --porcelain` 在跑完后为空；每条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<…> outsideFamilyGreen=<b>`。
- [x] AC10 如实登记：判据输出与本任务的完成记录里写明「本条只做 audio 档的目录解析、写端口的默认实现与注入、行内 `path` 与从文件重算的 sha256、0700/0600 的显式收口、逐次累积与不清理；判据全程用替身 fetch 与注入日志端口，未接触真实上游、未起真实进程、未触碰真实家目录；脱敏、捕获失败隔离、真实进程分别属 AC-146/AC-147/AC-148」。

## DoD

真实落地判据：不是「多了一个 `fs.writeFileSync`」，而是**同一份出货组装**（`voice.module.ts` 读一次 `VOICE_CAPTURE_DIR`、把写端口注入 `capture`）在 `VOICE_CAPTURE=audio` 下把**上传的那份字节本身**落在目录里，行里给出那个路径与同一份字节的 sha256，权限在**宽 umask 下**也是 0700/0600，多次转写逐次累积且一个都不删（连预先存在的哨兵文件也不动），而同一份输入在 `text` 档一个文件、一个目录都不产生 —— 由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **字节是比出来的，不是声明出来的**（AC3/AC5）：文件与上传 `Buffer.equals`、sha256 从**文件**重算再与行内值比对 —— 重编码、截断、写 base64 往返三条路都在这一条上红，取假形态 (ii) 指名打红的就是它；文件名与路径的两条不变量（在目录内、逐次不同）也在同一族读数里。

(b) **「零」有正例，且两侧同一次运行**（AC3 vs AC6）：audio 档有文件、`text` 档零文件零目录零写调用，取假形态 (i) 指名打红 AC6 —— 「写文件」与「只在 audio 档写文件」是两条读数，不是一句话。

(c) **权限是文件系统上的量、且经得起宽 umask**（AC4）：判据把 umask 设成 `0o000` 后读 `statSync(...).mode & 0o777`，只靠 open 的 `mode:` 的实现读到 0777/0666 并红，取假形态 (iii) 指名打红它 —— 这一条把「写了 mode 参数」与「权限真的是 0700/0600」分开。

**必须如实登记**：本条**不**做三档脱敏判据、**不**做捕获失败隔离、**不**做真实进程判据；**不**改 `off` 档 `voice.transcribe` 行与启动行（AC-143 的读数）；**不**改 `voice-capture-text.test.ts` 任何读数；**不**改适配器与 registry 契约；写进文件的只有上传字节；判据跑在替身 fetch 与注入端口上，未接触真实上游、未起真实进程、未触碰真实家目录。

**已知不等价点**：判据的「上传字节」是判据自己造的 Buffer，不是真实录音的 webm 容器；`sha256` 与 `bytes` 量的也是它；权限读数是在**本条判据的** umask 与文件系统（本机 ext4/tmpfs）上取的，`chmod` 在 NAT 文件系统与 Windows 上语义不同（仓库既有先例 `connection.ts:94` 明写 Windows 跳过 mode 位），本条不承诺跨平台；文件名与后缀是机制选择，判据只读不变量（在目录内、逐次不同），所以换一种命名不会让判据变绿或变红。

L_D 该轴仍暗，理由：本条读数全是布尔、存在性、权限位与逐字节比对，没有可比的数值量；文件字节数等于输入长度是恒等而不是测量，`sha256` 是同一份字节的另一种写法。
L_G 该轴仍暗，理由：目标层的读数是真实服务进程 stdout 上的启动行与捕获行（那条判据要求真实进程与本地替身上游），本条只到 service 与组装面。

## 完成记录

**落地**：`voice-capture.ts` 的 `VoiceCaptureAudioSink` 从 `writeAudio(directory, audio): void` 变为 `resolveDirectory(): string` ＋ `writeAudio(directory, captureId, audio): string`（返回值就是行上那个 `path`），新增出货实现 `createVoiceCaptureAudioSink`：`mkdirSync(..., {recursive:true, mode:0o700})` **之后** `chmodSync(dir, 0o700)`、`writeFileSync(target, bytes, {mode:0o600})` **之后** `chmodSync(target, 0o600)`；文件名由 `captureId` 净化后派生（上传的 mime 与文件名不进路径）。`voice.module.ts` 是 `VOICE_CAPTURE_DIR` 在本进程的唯一读取点（`envDirReads=1`），解析结果注入同一个 `createVoiceCapture({mode, log, audio})` 调用；`recordAttempt` 的 audio 半支**先写文件、再把 `path` 落到行上**。

**读数**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-audio.test.ts`，10/10 通过，`elapsed-ms=55`，`subprocess-or-socket-imports=0`，读数 9/9）：

- AC2 `explicit=<tmp>/explicit default=<tmp>/voice-capture blank=<tmp>/voice-capture`；`envDirReads=1 resolverCalled=true envCaptureSubstring=2 envCaptureToken=1 delta=1`；`off.dirResolves=0 off.writeCalls=0 audio.dirResolves=1 audio.writeCalls=1`。
- AC3 `rows=1 allRowsParse=true absPath=true pathUnderDir=true dirExistedBefore=false bytesEqual=true lenEqual=true shaMatch=true`，`shaFromFile` 与 `shaInRow` 同为 `a78ded3f26729e784d974bb00a8d8eb917635204934367eae1e6ed3dfa7a1a1f`（64 位小写十六进制，从文件重算）。
- AC4 `umask=0o000 dirMode=0700 fileMode=0600 dirExact=true fileExact=true`。
- AC5 `files=3 distinct=true allIdsDistinct=true eachEqual=true survivingPaths=3 sentinelKept=true sentinelEqual=true noDeleteCall=true rows=3`。
- AC6 `text.dirCreated=false text.files=0 text.parentEntries=0 text.writeCalls=0 text.pathKeyAbsent=true text.rows=3 text.fieldsPresent=true`。
- AC7 `defaultDir=<tmp>/default/voice-capture expectedDir=<同> resolverInput=undefined dirCreated=true files=1 dirMode=0700 fileMode=0600 pathGrandparent=<tmp>/default touchedHomeDir=false`。

**取假形态**（`voice-capture-audio.false-forms.test.ts`，6/6 通过，约 27s）：四例各自「未变异副本清空 9/9 → 变异体在预测族里红 → 族外仍绿」——`write-in-text-too` 红 AC6（`text.dirCreated=true text.writeCalls=3`）、`bytes-truncated` 红 AC3（`lenEqual=false bytesEqual=false shaMatch=false`，并连带红 AC5）、`bytes-base64-text` 红 AC3（`bytesEqual=false lenEqual=false`）、`no-permission-setting` 红 AC4（`dirMode=0777 fileMode=0666`）；`outsider-still-green=AC2 directory resolution`。`git status --porcelain` 跑完与本文件启动时逐字相同、无临时副本残留。

**两处已登记的不等价点（AC 点名的形态不可达，已换成可达形态）**

1. AC9 (`iii`) 点名的 `mode-only-no-chmod`（删掉显式 `chmod`、只留 open 的 `mode:`）**在任何 umask 下都不可分**：`mode:` 是 `open(2)`/`mkdir(2)` 的实参，内核施加 `mode & ~umask`，而 umask 只能**清位**，`0o700 & ~umask ⊆ 0o700` 且在本判据的 `umask 0o000` 下**恰好**是 `0o700`。所以「只留 `mode:`」与「`mode:` ＋ `chmod`」读到的数完全一样，那一例会**绿着通过**并测出与它声明相反的东西；不存在能分开两者的 umask（这不是判据的 fixture 能改好的事）。可达的取假形态是「什么权限都不设」（无 `mode:` 实参、无 `chmod`）——在 `umask 0o000` 下落成 `0777`/`0666`，就是本条出货的取假形态 (iii)。本任务出货的 `chmod` 因此由 API 契约与 AC 原文支撑，而不是由那一例支撑；**DoD (c) 里「只靠 open 的 `mode:` 的实现读到 0777/0666 并红」这句不成立**，如实登记在此。
2. AC9 (`ii`) 并列给出的 `Buffer.from(bytes.toString('base64'), 'base64')` 对**任意**字节串都是**恒等**（base64 解码是编码的精确逆运算，含补齐），作为变异体一个字节都不改，不可能让任何读数判红。可达的同义形态是 `bytes-base64-text`（编码发生了、没有解回来），与截断形态 `bytes-truncated` 并列各一例。

**跨任务那一格**：AC-143 出货时**已经**是词边界读取（`voice-capture-off.test.ts:770` 的 `process\.env\.VOICE_CAPTURE(?!_)`，并在 `:771` 另存一个子串计数），所以本条**不**动那个计数，`narrowed=true`。本条新增的 `VOICE_CAPTURE_DIR` 读取正是「子串计数被抬高、词边界计数不动」的正例（`envCaptureSubstring=2 envCaptureToken=1`）。**但该文件仍在本条 Touches 内，理由与计数无关**：它的 AC8 登记读数原本硬断言 `audioWired=false`（`audio-sink-wired=false`），而本条的交付就是接线，接线后必然为真。按 AC-144（commit `0c2a0553`）的先例，把该断言收窄到它自己拥有的不变量 —— 接线状态必须与「模块是否出货了这个工厂」一致（`ok: audioWired === audioSinkShipped`）—— 并把 audio 档的行键集从被测模块推导出来（`audio-row-fields`）而不是写死。`voice-capture-text.test.ts` 只因写端口元数变化做类型兼容修改，**读数一字未动**（AC8 点名了它，Touches 依此补上）。

**边界（未做，如实登记）**：不做三档脱敏判据（AC-146）——写进文件的只有上传字节，key/Bearer/请求头/base64 一律不写，但「它们没进日志与文件」是 AC-146 的读数；不做捕获失败隔离（AC-147）；不做真实进程判据（AC-148）；不改 `off` 档 `voice.transcribe` 行与启动行的逐字节形状（AC-143 的读数，仍绿）；不改适配器与 registry 契约；无保留期、无总量上限、无自动清理、无定时失效（目录只增不减是出货行为，不是遗漏）；判据全程用替身 fetch 与注入日志端口，未接触真实上游、未起真实进程、未触碰真实家目录。

## Touches

- server/modules/voice/voice-capture.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/tests/voice-capture-text.test.ts
- server/modules/voice/tests/voice-capture-off.test.ts
- server/modules/voice/tests/voice-capture-audio.test.ts (new)
- server/modules/voice/tests/voice-capture-audio.false-forms.test.ts (new)
- tasks/gap-voice-capture-audio-file.md

## Needs-Human

**执行 2026-09-24T13:33:37.178Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=27893 server/modules/voice/tests/voice-capture-text.false-forms.test.ts passed=false end_ms=1790256801449
- run_id：wk-prod-anchor
- session_id：dea5c1df-f4b4-43fe-8368-d7afa34400cb
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-capture-audio-file~wk-prod-anchor~1790256699219-e57e75.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-capture-audio-file-wk-prod-anchor.log
