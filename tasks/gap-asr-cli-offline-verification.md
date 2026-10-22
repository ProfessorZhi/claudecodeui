---
id: gap-asr-cli-offline-verification
title: 命令行离线可验证：--dry-run 零网络且连音频字节一起脱敏，--offline 回放与录制逐字一致，启动方式判据可红（AC-131）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-wire-single-implementation-boundary-probe
goal_ac: AC-131
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`grep -rn "^goal_ac:" tasks/` 里没有任何任务声明 AC-131；`grep -rln "dry-run\|--offline" tasks/` 的命中中只有 `gap-asr-wire-single-implementation-boundary-probe.md`（AC-129）与 `gap-asr-extraction-parity-baseline.md`（AC-130）在讲这条缝，而两条都白纸黑字把这一半让了出来（前者原文：「`--dry-run` / `--offline` 属 AC-131 的任务」；后者原文：「不做 `--dry-run` / `--offline`（AC-131）」）。本任务与 `gap-asr-wire-single-implementation-boundary-probe.md` 是**真前置关系**并由 `depends_on` 显式声明：那条任务创建 `experiments/voice-asr-cli/transcribe.ts` 这个真实消费者、并落定适配器落点，本条在它之上加三条离线语义与判据。与 `gap-asr-extraction-parity-baseline.md` 只是同族相邻、机械地不同：那条录线上字节基线（抽取前后逐字节），本条判离线回放与脱敏，二者不互为前置。并发立案的同绑任务 `gap-asr-cli-dry-run-offline-replay`（同一 AC-131，晚 16 秒）已置 `superseded`，其在 `## 撤回` 里登记了理由：本条的判据脚本名与 AC-131 记录里的 `criterion:` 同名，且「以 tsx 启动」需由启动方式判而非复述 AC-129 的读数；它的两条可取之处（通路各自成模块、真跑不判据化的显式登记）已被本条吸收。

### 现场：判据文件、离线语义与录制 fixture 今天都不存在

- AC-131 自己的判据命令是 `node scripts/asr-cli-offline-check.mjs` —— **该文件不存在**。
- 命令行入口本身也不存在（由 AC-129 的任务创建为「真实消费者 + 无参数打印用法并非零退出」）；`--dry-run` / `--offline` 两条语义在仓库里**没有任何实现**，也没有任何可注入 fetch 的接缝 —— 出货链路的 ASR 调用内联在 hook 与服务方法里，所以「离线」今天不可能被证明。
- 没有录制响应 fixture，因此「回放与录制一致」这条读数今天是空的。

ADR-004 决策 2 约束 2 的两条实测事实（本机 2026-09-22 复验）决定了本判据的机器读数面，也决定了「以 tsx 启动」可以被**判**而不是被**承诺**：

| 启动方式 | 观测 |
| --- | --- |
| `npx tsx <file>.ts` | `process.execArgv` 含 `tsx/dist/preflight.cjs` 与 `tsx/dist/loader.mjs`，env 含 `TSX_TSCONFIG_PATH` |
| 裸 `node <file>.ts`（含 `--experimental-strip-types`、`--experimental-transform-types`） | 对 `./b.js` 说明符报 `ERR_MODULE_NOT_FOUND` —— `b.ts` 存在也不映射 |

于是 launcher 是由**启动方式**读出来的两臂差，而不是 CLI 打印的一个标签。

### 方案

**S0 注入面（本任务的机械读数面）。** CLI 增三条注入参数：`--fetch-impl <module>`（默认导出为 fetch 兼容实现）、`--base-url <url>`、`--api-key-env <VAR>`。全部走注入：判据自造常量密钥、经自己命名的变量传入，**不读环境里的真实凭据**。替身被调用即向 `$ASR_CLI_CALL_LOG` 追加一行 —— 因此「零网络」的读数是**替身日志为空**，不是 CLI 打印的 `network=none`（自述行一律不作为读数）。

**S1 `--dry-run`：零网络 + 两头脱敏。** 经适配器构造请求，把「将要发出的请求」脱敏后打印，退出 0，且**不调用注入的 fetch**。脱敏面明确两头：

- 凭据侧：`Authorization` 的值、以及名字匹配 `key|token|secret|sig|auth`（大小写不敏感）的头与查询参数 → `<redacted>`；
- 载荷侧：multipart 的音频字段**不打印字节**，打印 `bytes=<N> sha256=<64hex>`，摘要按实际读到的文件算；
- 打印 `url=`、`method=`、逐字段名与长度，以及 `redacted=credentials,audio-bytes` 一行。

「打印了摘要」这件事本身被正面控制：判据独立复算同一音频的 sha256 并断言 stdout 里那一行等于它 —— 于是空输出与「什么都没脱、什么都没打」都红。

**S2 `--offline <recording.json>`：回放，不联网，两条容忍度都覆盖。** 注入一个由录制驱动的 fetch：按 provider + url + 请求体摘要命中录制条目，**未命中即抛 `offline-miss`，不回落网络**。录制条目自带 `expect`，于是同一份回放机制覆盖两条路径已分叉的容忍度：严格路径遇非 JSON ⇒ `{kind:"error", code:"non-json-response"}`；宽松路径遇非 JSON ⇒ `{kind:"text"}` 原文。录制由 `--record <out.json>` 产出（该模式不判据化），fixture 内含 provenance（`recordedAt`、`recordedFromCommit`、`source`）。回放读出的是**出货适配器的响应解析**，不是 CLI 自己的一份解析。

**S3 判据 `scripts/asr-cli-offline-check.mjs`。** 读数为四类：替身日志（零网络）、判据独立复算的 sha256（脱敏是摘要不是抹掉）、与录制逐字节比对的文本、两条启动臂推导出的 launcher；`--explain-sites` 打印每臂实际驱动的**绝对路径 + 符号名**（不许判据自己写一份请求构造）。

**S4 取假控制 `scripts/asr-cli-offline-check.test.mjs`。** 临时树里按变异表逐臂变异，每条臂**先对未变异的同一棵树断言绿、再施加变异断言红**，并断言变异表里的 `find` 在该文件命中数 `=== 1`（命中 0 或 >1 ⇒ 该臂红；「没改到东西」不许读成绿）。工装树由「CLI 文件 + 适配器实现文件 + 录制 fixture」按相对布局复制而成，复制集合来自 CLI 源里的 import 说明符解析，不是一张硬编码清单。

### 必须挡住的两个形态

1. **自述当读数。** `network=none`、`redacted=all`、`launch=tsx` 这类自述行都不作为读数；读数是替身日志、独立复算的摘要、宿主启动方式的两臂差、以及与录制的逐字比对。
2. **恒红的取假臂。** 每条变异臂先证未变异为绿；否则「变异后红」可能只是因为临时树根本跑不起来 —— 本仓库已经付过这个代价。

### 边界（不做）

- 不做适配器抽取与线协议唯一化（AC-129 的任务）；不录线上字节基线（AC-130 的任务）。
- 不做能力声明、第二个 provider、MIME 白名单、健康检查、裁剪决策（AC-132/133/134/135）。
- 不把 CLI 提升为 `cloudcli` 子命令。
- **不判据化「真跑」（ADR-004 决策 8）**：联网 + 带凭据的「在真实音频上取回非空文本」归实验记录，本任务的 `## AC` 不含任何真跑读数，也不以任何命令断言它 —— 单独登记一条，避免后来者把它补成判据。
- 不改出货链路（`src/shared/api.ts`、`src/modules/chat/hooks/useVoiceInput.ts`、`server/modules/voice/voice.service.ts`）的任何行为 —— 本任务只新增一条命令行验证面。

## Plan

- **S0 入口与注入面**：`experiments/voice-asr-cli/transcribe.ts` 只做参数解析与分派，增 `--fetch-impl` / `--base-url` / `--api-key-env` 与 launcher 证据行（打印**原始** `execArgv=<json>` 与 `tsxEnv=<bool>`，launcher 由判据从原始证据推导，不由标签行决定）；两条通路各自成模块：`experiments/voice-asr-cli/dryRun.ts` 与 `experiments/voice-asr-cli/offlineReplay.ts`。
- **S1 `--dry-run`（`dryRun.ts`）**：适配器构造请求 + 具名脱敏函数（凭据侧与载荷侧各一处），退出 0，注入的 fetch 零调用。
- **S2 `--offline` / `--record`（`offlineReplay.ts`）**：回放 fetch（未命中抛 `offline-miss`）+ 录制 fixture 落 `experiments/voice-asr-cli/fixtures/recorded-transcriptions.json`，含两条容忍度各自的一条录制。
- **S3 判据**：`scripts/asr-cli-offline-check.mjs` + 禁网替身 `scripts/__fixtures__/no-network-fetch.mjs`（被调用即记一行并返回假响应，于是「调用发生」可读）。
- **S4 取假面**：`scripts/asr-cli-offline-check.test.mjs` 的变异表与七条具名臂，逐臂先绿后红。
- **S5 读数**：逐条跑 AC，stdout 落进 Evidence。

## AC

- [x] AC1 主读：`node scripts/asr-cli-offline-check.mjs` 退出码 0；stdout 逐行给出四项读数并各带 verdict —— `dry-run calls=0`、`redaction audio-bytes=elided sha256=<64hex>`、`offline text=<与录制逐字相同>`、`launch tsx` —— 并有一行 `arms=<n> red=0`。
- [x] AC2 零网络由替身日志判定：同一命令的 `--dry-run` 臂运行时 `$ASR_CLI_CALL_LOG` 为空或不存在。取假形态 ①：变异臂把 dry-run 分支里「不调用注入 fetch」那一处改成真的调用 ⇒ 该臂必须红且判词含 `dry-run made N calls`；未变异时该臂绿。
- [x] AC3 脱敏两头都脱、且是正面控制：`--dry-run` 的 stdout 内不含判据自造的密钥常量、不含 `Authorization` 的值、也不含传入音频的任一 32 字节窗口；同时**必须**含一行 `sha256=<64hex>`，其值等于判据独立复算的音频 sha256。取假形态 ②：变异臂只脱密钥、不脱音频 ⇒ 该臂红，且断言此刻密钥仍被脱掉（红的是音频那一半，不是别的原因）。
- [x] AC4 回放与录制逐字一致：`--offline` 臂产出的文本与录制 `expect.text` **逐字节相同**（含非 JSON 录制：严格路径 ⇒ 非零退出且判词含 `non-json-response`；宽松路径 ⇒ 文本等于原文），两条路径各自的容忍度都被回放机制覆盖。取假形态：变异臂在响应解析处加一次 trim 或大写 ⇒ 该臂红且判词含 `offline text differs`。
- [x] AC5 回放不联网：`--offline` 与 `--fetch-impl scripts/__fixtures__/no-network-fetch.mjs` 同时传入时替身日志必须为空（回放 fetch 优先，未命中即抛 `offline-miss`）。取假形态 ③：变异臂把回放 fetch 换成注入的 transport ⇒ 该臂红，且断言此刻替身日志**非空**（证明红的正是「联网」这一半）。
- [x] AC6 启动方式判定：同一份 CLI 两条启动臂 —— `npx tsx <cli> --dry-run …` 退出 0 且 launcher 推导为 `tsx`；`node <cli> --dry-run …` 必须**不能**产出「以 tsx 启动」的读数（要么加载失败非零退出，要么 launcher 推导为 `node`）。launcher 由 CLI 打印的原始证据（`execArgv=<json>`、`tsxEnv=<bool>`）推导。取假形态：变异臂把适配器相对导入的说明符由 `.js` 改成 `.ts`（裸 node 于是也能加载）⇒ 该臂红且判词含 `cli-not-tsx-launched`。
- [x] AC7 空读数不是绿：删掉录制 fixture ⇒ 非零退出且判词含 `recording-missing`；把 `--dry-run` 的输出改成空 ⇒ 非零退出且判词含 `no readings`。
- [x] AC8 驱动的是出货代码：`node scripts/asr-cli-offline-check.mjs --explain-sites` 退出码 0，逐臂打印所驱动的绝对路径 + 符号名，realpath 全落在出货树内（CLI 入口与适配器实现文件）；独立读数 `grep -rn "audio/transcriptions" scripts/asr-cli-offline-check.mjs scripts/__fixtures__/no-network-fetch.mjs` 无命中 —— 即本任务落地的两个文件都不自己拼识别端点路径，这条缝只能经出货适配器抵达。判据收窄说明：原判据扫描 `scripts/__fixtures__/` 整目录，实测对该树的任何实现都不可能为绿 —— 同族相邻任务 AC-130 已提交的 `scripts/__fixtures__/asr-extraction-parity-baseline.json` 里有 2 处命中，那是录下的请求 URL 基线，逐字保留才有意义。红线不变：仍是「本任务这两个文件不自己拼端点」，取假面由 AC10 的具名用例 AC8 承担，它独立断言这两个文件各 0 处命中。
- [x] AC9 静态门：`npm run typecheck` 退出码 0（新增的 `scripts/*.mjs` 由 `scripts/tsconfig.json` 的 `checkJs` 覆盖）；`npm run lint` 退出码 0。
- [x] AC10 控制文件真的会被跑：`node scripts/list-script-tests.mjs` 退出码 0 且输出含 `scripts/asr-cli-offline-check.test.mjs`；`node --test --test-reporter=tap scripts/asr-cli-offline-check.test.mjs` 退出码 0 且输出含 `# tests <N>`，N ≥ 7（AC2–AC7 的每条取假臂各为一个具名用例）。注：`node --test` 只在文件**失败**时打印文件名，因此「文件名出现在输出里」不作为读数。
- [x] AC11 既有语音读数不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts` 与 `npx vitest run src/shared/tests/voiceConfig.test.ts` 各自退出码 0。

## DoD

真实落地判据不是「判据脚本存在」，而是四件事同时成立：

(a) **零网络是可读出的**：`--dry-run` 的替身日志为空（AC2），且变异成「真的发请求」后必红 —— 自述行不算；
(b) **脱敏两头都在，且脱敏不是抹掉**：stdout 无密钥、无音频字节窗口，同时含判据独立复算得出的 sha256（AC3），只脱密钥不脱音频的变体必红；
(c) **回放与录制逐字一致，且覆盖两条路径已分叉的容忍度**（AC4），回放联网的变体必红（AC5）；
(d) **启动方式由启动方式判定**：tsx 臂绿、裸 node 臂不得给出「以 tsx 启动」的读数（AC6），使「改成 `.ts` 说明符以便裸 node 也能跑」这一变体必红。

每条取假臂先对未变异的同一棵树证绿、再证变红，且变异命中数 `=== 1`（AC10）。

**本任务不证明**「换识别服务不改路由与 UI」（GOAL-008 的目标层命题，由 AC-132/133/134/135 承担），也不证明线上字节逐字节不变（AC-130 的任务）；本任务只证明命令行这条验证通路真的离线、真的脱敏、真的回放，且这条通路的判据自己是可红的。

**若 CLI 图在 `npx tsx` 下无法加载**（例如适配器落点让 CLI 无法解析到同一实现）：不得自行放宽判据 —— 不许把「以 tsx 启动」这一半删掉、不许把脱敏面缩成只脱密钥、不许把回放降级成「跑一次看看」；必须把原始判词（进程 stdout/stderr 原文）落进 Evidence 并停在 needs-human。

L_D 该轴仍暗，理由：本任务只新增一条命令行离线验证面（脱敏、回放、启动方式判定），不引入任何领域数据能力，也没有可读出的领域读数。

L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担，本任务只承担「命令行可离线验证」这一条。

## Touches

- experiments/voice-asr-cli/transcribe.ts
- experiments/voice-asr-cli/dryRun.ts (new)
- experiments/voice-asr-cli/offlineReplay.ts (new)
- experiments/voice-asr-cli/fixtures/recorded-transcriptions.json (new)
- scripts/asr-cli-offline-check.mjs (new)
- scripts/asr-cli-offline-check.test.mjs (new)
- scripts/__fixtures__/no-network-fetch.mjs (new)
- tasks/gap-asr-cli-offline-verification.md
