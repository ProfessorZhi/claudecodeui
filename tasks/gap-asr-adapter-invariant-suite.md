---
id: gap-asr-adapter-invariant-suite
title: 对 registry 参数化的离线不变量套件：五组契约不变量（请求 golden / 错误映射 / 大小分流 / 脱敏 /
  MIME）各自独立可红（无 goal_ac，实验/守卫类）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-wire-single-implementation-boundary-probe
goal_ac: " "
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`task_list` 全文检索「不变量 / registry 参数化契约测试」未命中第二条以同一机制立案的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129，落契约、registry 与第一个适配器并证明实现只有一份）与 `gap-asr-extraction-parity-baseline`（AC-130，录两跳逐字节基线）—— 两条都不写「每个 provider 都必须通过同一组与质量无关的契约测试」。本任务是 ADR-004「后续任务 4」的立案。

**现场。** 今天每个识别服务没有一组统一的契约测试：请求怎么构造、上游的 401/403/429/5xx/超时/空响应/非 JSON 各归到哪个语义码、超预算怎么分流、密钥与音频字节会不会泄漏、不在 `acceptsMime` 内的输入在哪一步被拒 —— 全靠各自实现「看起来对」。ADR-004 的 L3(b) 要求「每个 provider 必须通过同一组契约测试，与质量无关」，本任务把这条落成**对 registry 参数化、离线可跑**的套件。

**本任务做什么。** 五组不变量，每组各自成一条**独立可红**的断言：请求构造 golden（含「声明为不支持的提示参数必须**不发**，而不是发空值」）、错误映射（401/403/429/5xx/超时/空响应/非 JSON 各归到哪个语义码）、大小分流、脱敏（密钥与音频字节不出现在返回值、错误消息、日志里）、MIME（不在 `acceptsMime` 内的输入在**发出请求之前**被拒）。套件对 registry 解析出的 provider 列表逐个跑；第一版只有一个 provider 也照样跑，**provider 列表为空即红**（空读数不许绿）。

**离线。** 全部环境依赖经注入（`fetchImpl`、`baseUrl`、`apiKey`、`model`、`timeoutMs`），套件自身零网络：任何真实网络调用即红。

**边界（不做）。** 不落第二个适配器（AC-132）；不改线协议实现与线上字节（AC-129/AC-130）；不做联网真跑（ADR-004 决策 8）；不引入快照测试库（只用 golden 常量 + 注入替身）；不改两条路径的路由与 UI。

## Plan

- **S0 参数化骨架。** 读 registry 的 provider 列表，对每个 provider 跑同一组不变量；列表为空 ⇒ 非零退出。五组各自独立成一条可红断言，互不掩盖。
- **S1 五组不变量。** 请求构造 golden（逐字节等于录制常量，且 `honors.prompt=false` 时**不发** prompt 而不是发空串）；错误映射表；大小分流（`> maxInlineRequestBytes` 走 `oversize` 声明路径且不把整个音频塞进请求）；脱敏（扫描返回值 / message / 日志行）；MIME（发出请求之前拒 `UNSUPPORTED_MIME`）。
- **S2 两条取假控制。** 各成一条独立具名用例；每条先证未变异为绿、再证变异为红。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence。

## AC

- [x] AC1 请求构造 golden（第一组）：给定固定请求 + 注入的 `fetchImpl` 记录，断言出站 URL / 头 / 体逐字节等于录制常量，**含「声明为不支持的提示参数必须不发，而不是发空值」**。取假变体：把提示参数实现成「发空字符串」⇒ 本组必须红。
- [x] AC2 错误映射：401/403/429/5xx/超时/空响应/非 JSON 各归到哪个语义码，逐条断言。取假变体：把某个适配器的错误映射换成「一律返回上游错误」⇒ 401/429/超时三组必须红。
- [x] AC3 大小分流：`> maxInlineRequestBytes` 必须走 `oversize` 声明的路径，且**不得把整个音频塞进请求**。
- [x] AC4 脱敏：密钥与音频字节**不得**出现在任何返回值、错误 message 或日志行里。
- [x] AC5 MIME：不在 `acceptsMime` 内的输入必须在**发出请求之前**被拒绝（`UNSUPPORTED_MIME`），上游调用次数为 0。
- [x] AC6 五组各自成一条**独立可红**的断言：单独打破任一组时只有该组红，不牵连其余四组（否则「一组红」读不出是哪一组）。
- [x] AC7 空读数不是绿：registry 解析出 0 个 provider，或某组的读数条数为 0 ⇒ 套件必须非零退出（不许静默绿）。
- [x] AC8 离线：套件全程零网络（注入替身记录到任何真实网络调用即红）。
- [x] AC9 控制文件真的会被跑：`node scripts/list-script-tests.mjs` 输出含 `scripts/asr-contract-invariants-check.test.mjs`；`node --test scripts/asr-contract-invariants-check.test.mjs` 退出码 0，AC1/AC2 的两条取假变体各为一条具名用例。
- [x] AC10 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

真实落地判据：不是「多了一个测试文件」，而是**每个 provider 都被同一组、与质量无关的契约不变量覆盖，且这组不变量自身是可红的**。承重性由三件正面读数证明：

(a) 五组各自独立可红（AC6）—— 一个把五组合成一个 `expect` 的套件读不出失败在哪一组，不算落地；
(b) 两条取假变体各自能把它打红：错误映射「一律返回上游错误」使 401/429/超时三组红（AC2）；提示参数「发空字符串」使第一组红（AC1）；
(c) 空读数不是绿（AC7）：provider 列表为空、或某组读数条数为 0，都必须红 —— 空 glob 退出 0 是本仓库已经付过代价的形态。

**本任务不证明**质量（那是实验记录）与「换识别服务不改路由与 UI」（AC-132/133/134/135）；它只把契约面钉住。

L_D 该轴仍暗，理由：本任务只把契约不变量落成可红的套件，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据由 GOAL-008 的其余判据承担，本任务只承担「同一组契约不变量对每个 provider 可红」这一条。

## Touches

- shared/asr/asrInvariants.ts (new)
- src/shared/asr/tests/asrContractInvariants.test.ts (new)
- scripts/asr-contract-invariants-check.mjs (new)
- scripts/asr-contract-invariants-check.test.mjs (new)
- tasks/gap-asr-adapter-invariant-suite.md

## 完成记录

**承重形状：一组板，两个 runner。** 五组探针全部写在 `shared/asr/asrInvariants.ts`；运算符命令（`scripts/asr-contract-invariants-check.mjs`）与常驻套件（`src/shared/asr/tests/asrContractInvariants.test.ts`）只负责跑它并打印读数。板子按 registry 参数化（`listProviders()`），因此明天注册进来的 provider 当天就被量到；板子自身零网络：所有环境依赖经 `AsrInvocation` 注入，`fetchImpl` 是每次探测新建的替身。

**取假控制的形状：一组一条变异，其余四组必须仍绿。** `scripts/asr-contract-invariants-check.test.mjs` 每次复制 `shared/` 到临时目录、按字面锚点改写（锚点先断言恰好命中一次），再要求**只有**被打破的那组红：

- 第一组：`honoredHints` 改成无条件转发 + 体构造器去掉空串守卫 ⇒ `request.prompt.unsupported-omitted observed=prompt-part-present`、`request.prompt.empty-hint-omitted observed=empty-prompt-part`、`request.body.golden` 三条红 —— 这正是 AC1 的「发空值」变体，两条读数分别覆盖「不发」与「不发空值」。
- 第二组：401/403 与 429 的分支短路 + abort 归一 ⇒ 401/403/429/timeout/transport 红，而 500/503/400/非 JSON/空信封/正样本**仍绿**（它们本来就期望那个码）——「区分码」而非「一有失败就红」。
- 第三组：预算守卫短路 ⇒ 超预算音频与「同音频 + 长上下文」都变成 `ok: … requests=1`（被发了出去），预算内的那条仍绿。
- 第四组：把密钥写进失败 message ⇒ `absent-from-message` 与 `absent-from-result` 红，而 `reaches-the-wire` 与两条植入针仍绿（说明「不在答案里」是区分而不是空断言）。
- 第五组：MIME 守卫短路 ⇒ 两个 `mime.reject.*` 变成 `ok: …`，两个 `mime.accept.*` 仍绿。
- registry 清空 ⇒ 五组全 `UNMEASURED`、`verdict=empty`、`readings=0`、退出码非零。

**两处修正，都记在这里。**

1. **声明面少了一个文件。** `## Touches` 原写 `shared/asr/tests/asrContractInvariants.test.ts (new)`（该路径从未写过：写在 `shared/` 一侧永远不会被 vitest 的 `include: ['src/**/*.test.ts']` 收集），而真正承重的 `shared/asr/asrInvariants.ts` 未声明。`anti-drift-touches-check` 在本工作树上给出唯一一条 `out-of-declared: task wrote shared/asr/asrInvariants.ts`，即该写入由本任务自己的 AC 强制（AC1–AC8 的每一组探针都落在该文件里）。据此把 Touches 更正为上面五条字面路径，无 glob。

2. **接地的那条缝是任务进行中落地的。** 本任务开工时 `shared/asr/asrContract.ts`/`asrRegistry.ts` 尚不存在（AC-129 还在同一条 develop 线上推进）。我先按自己的契约写了一份平行的 registry 与适配器，AC-132 的 `shared/asr/asrRegistry.ts` + `shared/asr/list/multimodal/multimodal.asr-provider.ts` 落地后删除平行实现、`git merge develop` 后按**已落地的缝**重写整块板子：`AsrAdapter`/`AsrInvocation`/`AsrErrorCode` 与 20 MiB 的**请求级**预算都是那条缝的既有形状，本任务不再定义任何契约类型。这一步也消掉了 AC-129 的 `SECOND_IMPL`：`shared/asr/asr-single-implementation-check.mjs` 退出 0、`SECOND_IMPL none`（早先板子文件曾在注释里拼出端点字面量，被按「第二份实现」计过）。

**读数（本工作树）。** `node <tsx> scripts/asr-contract-invariants-check.mjs` ⇒ 五组 PASS，`verdict=pass groups=5 readings=44 log-lines=44 platform-fetch-calls=0`，退出码 0；`--groups ''` ⇒ `verdict=empty`、退出码 1。`node --test scripts/asr-contract-invariants-check.test.mjs` ⇒ 9/9 通过（含 AC1/AC2 两条具名取假变体），退出码 0。`npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts` ⇒ 9/9 通过（含「量一个不是自己写的声明」：一个承认 prompt 的替身在 `request.prompt.unsupported-omitted` 上读出 `prompt-part-present`；把该声明套在真适配器上则读出 `no-prompt-part` 并对 `prompt-part-present` 红）。`npm run typecheck` 退出 0（`shared/` 被两套 tsconfig 各编译一次），`npm run lint` 退出 0，`node scripts/list-script-tests.mjs` 输出含本控制文件，`node scripts/asr-single-implementation-check.mjs` 退出 0 / `SECOND_IMPL none`，`node scripts/asr-extraction-parity-check.mjs` `verdict PASS`。

**脱敏那一组为什么要两个相向读数。** 「没扫到」与「扫不出来」是同一条读数，所以每组脱敏读数都配一对植入针（密钥 / 音频编码各一，必须被找到）与一条干净行（必须不被找到）；再配 `redaction.credential.reaches-the-wire` / `redaction.payload.reaches-the-wire` 两条非空性读数 —— 请求上确实带着密钥与编码音频，「答案里没有」才有意义。针是**录制常量**（音频的 base64 由 `python3 -c base64.b64encode` 独立算出，不取自适配器的编码器）；早先版本曾改成「从请求体里正则抽长 token」，第一组变异立刻把它打了红：`systemInstruction`（17 字符）本身就是一条合法 base64 run，于是 golden 行被当成载荷泄漏 —— 抽取式针法既与适配器同源又会误报，已回到录制常量。
