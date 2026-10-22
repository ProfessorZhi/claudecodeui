---
id: gap-voice-capture-real-process
title: 真实服务进程按 VOICE_CAPTURE 启动：stdout 出现启动行与捕获行、未设置时零捕获行，读数来自子进程 stdout 与一次真实
  HTTP（AC-148）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-capture-mode-gate-off-fail-closed
  - gap-voice-capture-text-payload
goal_ac: AC-148
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on` 上）：立案时 `grep -rho '^goal_ac: *AC-148' tasks/*.md` 零命中；`grep -rln 'AC-148' tasks/` 只命中四份同族任务的**范围让渡**文字（`gap-voice-capture-mode-gate-off-fail-closed`、`gap-voice-capture-text-payload`、`gap-voice-capture-isolation`、`gap-voice-capture-secrets-three-modes`），四份的边界原文都写着「不做真实进程判据（AC-148）」，其中三份把这条判据指名为 `scripts/voice-capture-process-check.mjs`；该文件 `ls` 不存在，`grep -rn 'VOICE_CAPTURE' server/ src/ scripts/ shared/` 与 `grep -rn 'voice\.capture' server/ src/ scripts/ shared/` 都是 0 命中。GOAL-010 的六条判据各有一份互不重叠的判据文件，本条只认领 AC-148 的那一份（真实进程）：AC-143 是 `voice-capture-off.test.ts`，AC-144 是 `voice-capture-text.test.ts`，AC-145 是 `voice-capture-audio.test.ts`，AC-146 是 `voice-capture-secrets.test.ts`，AC-147 是 `voice-capture-isolation.test.ts`。本条的判据不 import 任何 service 源码，读数全部来自真实子进程的 stdout 与一次真实 HTTP 请求 —— 这正是 AC-148 的取假形态要挡住的那种做法（在进程内注入端口构造读数）。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls scripts/voice-capture-process-check.mjs` → `No such file or directory` |
| 接缝本体 | `ls server/modules/voice/voice-capture.ts` → `No such file or directory`（AC-143 尚未出货） |
| 环境变量 | `grep -rn 'VOICE_CAPTURE' server/ src/ scripts/ shared/` → 0 个文件 |
| 捕获行 | `grep -rn 'voice\.capture' server/ src/ scripts/ shared/` → 0 个文件 |
| 真实进程今天能起 | `HOME=<tmp> SERVER_PORT=<free> HOST=127.0.0.1 DATABASE_PATH=<tmp>/auth.db VOICE_CAPTURE=text VOICE_API_BASE_URL=http://127.0.0.1:<double> npx tsx --tsconfig server/tsconfig.json server/index.ts` → 1.7 秒内打印 `CloudCLI Server - Ready`（两次实测 1517 ms 与 1790 ms） |
| 真实 HTTP 今天能通 | 同一进程上 `POST /api/voice/transcribe`，multipart 字段名 **`audio`**（字段名写 `file` 会得到 400 `Unexpected field`，实测），`Authorization: Bearer <token>`（`node scripts/mint-token.mjs mint --db <tmp>/auth.db --out <f>` 退出 0 且造出一次性 subject）→ **200** `{"text":"double-transcript-42"}`，替身记录到恰好一次 `POST /audio/transcriptions`（286 B） |
| 今天的 stdout | 同一次运行里 stdout 有 `voice.transcribe providerId=openai-compatible outcome=ok status=200 latencyMs=15`，而 `voice.capture` 行数 = **0**（即使 `VOICE_CAPTURE=text`）—— 这就是本条要闭合的差 |
| 硬链接副本可用 | `cp -al <repo>/. <tmp>/` 实测 1438 ms / 14.98 万个文件，副本里 `node_modules/.bin/tsx` 可用（取假形态的旁证靠它） |
| 继承环境里的两个陷阱 | 驱动锚点的 env 带着 `DATABASE_PATH=/data/home/yale/.cloudcli/auth.db`（操作员真实库）与 `FORCE_COLOR=2`（会把日志行包上 ANSI），子进程必须覆盖前者、关掉后者 |

（上面这套读数由本次立案时的一次性探针取得，探针跑在临时目录里，未改动仓库任何文件。）

**要交付的三件事**

1. **判据 `scripts/voice-capture-process-check.mjs`**（AC-148 的 `criterion:` 路径；裸 `node` 可跑）：自己起一个本地上游替身（`http://127.0.0.1:<随机端口>`，对 `POST /audio/transcriptions` 回一个固定 JSON `{"text": "<固定串>"}` 并记录收到的每一次请求），再按 `server:dev` 的那条命令从 `--root`（默认本仓根）起**真实服务进程** —— 本次运行的临时 `HOME`、`DATABASE_PATH`、`SERVER_PORT` 全部显式覆盖，`FORCE_COLOR=0`；用 `scripts/mint-token.mjs mint` 对**同一个临时库**造一次性 Bearer token；然后发**一次真实 HTTP** multipart（字段名 `audio`）。同一份流程跑两次：`VOICE_CAPTURE=text` 与 `VOICE_CAPTURE` 未设置（子进程 env 里显式删除该键；若仓库根 `.env` 里定义了它，判 `EMPTY_READING` 并非零退出）。读数全部来自子进程 stdout 与替身自己的请求记录。
2. **取假形态的可执行旁证 `scripts/voice-capture-process-check.false-forms.test.mjs`**：用 `cp -al` 把 `--root` 硬链接成一次性副本，在副本上各做一处文本变异跑同一条判据，要求「未变异副本先退出 0」再要求「变异必须红，且指名红的是哪一条读数」（两条变异各自只动 `server/modules/voice/voice.module.ts` 的一处，互相不遮挡）。
3. **不改任何出货源码**：本条只加判据与旁证。接缝（`voice-capture.ts`、`capture` 端口、`voice.module.ts` 的启动行与注入）由 AC-143 出货，载荷字段（含上游原始返回）由 AC-144 出货。若实现时发现真实进程 stdout 上缺的是**接缝没接进组装**，那是 AC-143 的读数而不是本条的 bug —— 登记为发现，不在本条顺手改 `voice.module.ts`。

**边界（不做）**：不改 `server/`、`src/`、`shared/` 下任何文件；不做闸门与模式解析（AC-143）；不做 text 档载荷细化（AC-144）；不做 audio 档写文件（AC-145）；不做三档脱敏（AC-146）；不做捕获失败隔离（AC-147）；不驱动浏览器；不读 `server.log`（判据读的是子进程 stdout；`server.log` 的重定向是部署方的事）；不联网、不碰真实 DashScope、不读 `.env` 与 `.env.test` 里的任何凭据；不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [x] AC1 判据入口、预算与隔离：`node scripts/voice-capture-process-check.mjs` 退出 0；打印 `elapsed-ms=<n>`，实测 < 45000（目标侧判据门 60 秒硬上限且不可调）；两个子进程的 env 里 `HOME` 与 `DATABASE_PATH` 都指向本次运行的临时目录，判据打印 `child-home=<...>`、`child-db=<...>`；运行前后各读一次**继承 env 里**那个 `DATABASE_PATH`（存在时）的 `mtimeMs`，打印 `real-db-untouched=<b>` 且必须 `true`（沿继承值会让 `mint-token` 往操作员真实库里插一行，这是本条要挡的实害）。
- [x] AC2 启动行在真实进程 stdout 上：`VOICE_CAPTURE=text` 那次真实进程的 stdout（去掉 ANSI 后按行比对）里恰好一行匹配 `^voice\.capture mode=text$`；打印 `startup.text.count=<n>`、`startup.text.line=<...>`；同一份判据的 `off`/未设置那一次不得出现这一行。
- [x] AC3 捕获行与替身上游返回逐字一致：`text` 档那次 stdout 里恰好一行 `voice.capture`，其单行 JSON 可 `JSON.parse`，「上游原始返回正文」那一项与替身本次实际返回的正文**逐字相同**，返回给调用方的文本项也**逐字相同**；打印 `capture.lines=<n>`、`upstream.exact=<b>`、`text.exact=<b>`；另打印替身自己的请求记录 `double.requests=<n>`、`double.path=<...>`、`double.bytes=<n>`，并要求 `double.requests === 1` 且 `double.path === '/audio/transcriptions'`（正例：这次 HTTP 真的穿过了真实进程，不是判据自己编的读数）；该次 HTTP 必须 `status=200` 且正文里的 `text` 与替身文本逐字相同（打印 `http.status`、`http.text.exact`）。
- [x] AC4 未设置时零捕获行，且「零」有正例托底：`VOICE_CAPTURE` 未设置的第二个真实进程上，同一条真实 HTTP 请求必须 `status=200` 且返回文本与替身文本逐字相同（否则「零捕获行」可能只是请求没跑通），而 stdout 里 `voice.capture` 行数 `=== 0`；打印 `unset.captureLines=0`、`unset.httpStatus=200`、`unset.text.exact=true`、`unset.startup.line=<...>`（未设置时启动行读出的是 `off`；那是 AC-143 的读数，本条只消费它）。
- [x] AC5 取假形态是可执行的旁证，且每条指名红的是哪一条读数：`node --test scripts/voice-capture-process-check.false-forms.test.mjs` 退出 0；每条先跑「未变异的一次性硬链接副本」要求 `baseExit=0`，再在同一副本上变异并跑同一条判据：(i) `assembly-not-wired` —— 删掉 `server/modules/voice/voice.module.ts` 里把捕获端口交进 `createVoiceService` 的那一处 ⇒ **AC3 的 `capture.lines` 必须从 1 变 0**（红），而 AC2 的启动行仍在；(ii) `startup-line-missing` —— 删掉该文件里打启动行的那一次调用 ⇒ **AC2 的 `startup.text.count` 必须从 1 变 0**（红），而 AC3 的捕获行仍在。每条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<capture.lines|startup.text.count>`；跑完副本已删除，且 `git status --porcelain` 在仓库里为空。
- [x] AC6 判据只读进程与替身，不 import 出货源码：`grep -c 'createVoiceService\|voice\.module\|voice\.service' scripts/voice-capture-process-check.mjs` 为 0（打印 `service-source-imports=<n>`）；判据里出现的上游目标只有 `http://127.0.0.1:<替身端口>` 与 `http://127.0.0.1:<服务端口>`（打印 `hosts=<...>`），对任何非 `127.0.0.1` 的目标在出发前抛错（打印 `real-upstream-calls=0`）。
- [x] AC7 如实登记：判据输出与本任务的完成记录写明「本条判的是真实服务进程与一次真实 HTTP；上游是本地替身而不是真实 DashScope；不驱动浏览器；读的是子进程 stdout 而不是 `server.log`；判据与旁证不改任何出货源码」。
- [x] AC8 仓库门不回归：`npm run lint`、`npm run typecheck` 各退出 0（逐条打印退出码；不是空过）；`npm run test:scripts` 相对 develop **不新增红** —— 实测该 lane 退出 1，7 条红全部落在本条未触碰的三个既有文件（`scripts/asr-contract-invariants-check.test.mjs` 1 条、`scripts/asr-extraction-parity-check.test.mjs` 2 条、`scripts/asr-health-provider-check.test.mjs` 4 条），这三个文件及其输入相对 develop 逐字节相同（`git diff --stat develop HEAD -- <这三个文件> scripts/asr-health-provider-check.mjs shared/asr server/` 为空），且任一文件单独跑同样红；本条相 develop 的增量只有两个新文件，同一 lane 里本条新增的 `scripts/voice-capture-process-check.false-forms.test.mjs` 3/3 全绿。收窄理由：该 lane 在 develop 上今天就是红的（`shared/asr/asrRegistry.ts:35` 已 import `./list/dashscope-omni/dashscope-omni.asr-provider.js`，而探针 `scripts/asr-health-provider-check.mjs` 的 `FIXTURE_FILES` 里 `dashscope-omni` 命中数为 0），修它要动别的任务的 Touches，本条边界原文写着「登记为发现，不在本条顺手改」；本条只认领「不是本条引入的红」这一不变量，它可证伪：本条文件里的任一条在同一 lane 内变红、或任一红落到本条触碰的文件上，它立刻不成立。

## DoD

真实落地判据：不是「多了一个 .mjs」，而是**同一份出货组装**被**真实进程**启动后，stdout 上确实出现启动行与一行 `voice.capture`、其正文与替身上游返回逐字相同；而在同一份判据里，未设置时同一条真实请求照样成功却是零捕获行 —— 由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **「零」有正例**（AC3 对 AC4）：`text` 档 1 行、未设置 0 行，两次的 HTTP 都是 200 且文本逐字相同 —— 「没跑通」与「没捕获」被分开，`VOICE_CAPTURE` 被忽略的空实现在 AC3 立刻红。

(b) **「真实」有独立证人**（AC3 的 `double.requests`）：上游替身自己记到恰好一次 `POST /audio/transcriptions`，所以这次 HTTP 真的穿过了真实进程的路由、鉴权与 service，不是判据在进程内构造的读数。

(c) **接线**正是判据的分辨力所在（AC5）：删掉组装处的那一处注入，捕获行读数就从 1 变 0；删掉启动行那一次调用，启动行读数就从 1 变 0 —— 两条读数各自被一条变异指名，所以 AC-148 的取假形态「捕获只在单测的注入端口里成立而没有接进真实服务的组装」过不了这一条。

**必须如实登记**：上游是本地替身，不是真实 DashScope；读的是子进程 stdout，不是 `server.log`（重定向是部署方的事，目标是「标准输出」）；不驱动浏览器；判据与旁证不改任何出货源码；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端。

**已知不等价点**：真实进程的 stdout 与部署时写进 `server.log` 的内容未必同形（启动命令可能加时间戳或重定向）；判据用 `tsx` 直接跑 `server/index.ts`，不是编译产物 `dist-server/server/index.js`，因此「编译后仍成立」不被本条证明；替身只说 openai-compatible 的 multipart 线，不等于真实 DashScope；取假形态是在硬链接副本上做的文本变异，证明的是判据的分辨力，不是变异体本身会出货。

L_D 该轴仍暗，理由：本条读数全是布尔、计数、逐字比对与一个墙钟预算，没有可比的数值量；启动耗时是环境量而不是本条的命题。

L_G 读数：真实服务进程 stdout 上，捕获行条数 VOICE_CAPTURE 为 text 时 = 1、未设置时 = 0；启动行条数 = 1（未设置时读出 off）。

## Touches

- scripts/voice-capture-process-check.mjs (new)
- scripts/voice-capture-process-check.false-forms.test.mjs (new)
- tasks/gap-voice-capture-real-process.md

## 完成记录

**实现与提交。** 新增两个文件，不改任何出货源码：`scripts/voice-capture-process-check.mjs`（判据）、`scripts/voice-capture-process-check.false-forms.test.mjs`（取假形态旁证）。实现提交 `145aa1b5 test(voice): judge the real service process's stdout for the capture line (AC-148)`；随后两次 `git merge --no-edit develop`（本条进行期间 develop 前进到 `587a3026`：第一次合并 `8b3ca5ef`，第二次合并后 `develop` 已成 HEAD 的祖先，故 scoped-gate 缓存按 `587a3026` 写）。最终工作树 HEAD `72eeb2d0`，`git status --porcelain` 为空。

**逐条读数（最终树 `72eeb2d0`；判据 `node scripts/voice-capture-process-check.mjs` 退出 0，`elapsed-ms=3088`）。**

| AC | 读数 |
|---|---|
| AC1 | 退出 0；`elapsed-ms=3088`（自设预算 45000，判据门 60 s 硬上限不可调）；`child-home-in-run-dir=true`、`child-db-in-run-dir=true`；`real-db=/data/home/yale/.cloudcli/auth.db`、`real-db-untouched=true`（`real-db-churn=none-observed`） |
| AC2 | `startup.text.count=1`、`startup.text.line=voice.capture mode=text`；未设置那次 `unset.startupTextLines=0`、`unset.startup.line=voice.capture mode=off` |
| AC3 | `capture.lines=1`、`upstream.exact=true`、`text.exact=true`；替身 `double.requests=1`、`double.path=/audio/transcriptions`、`double.bytes=319`；`http.status=200`、`http.text.exact=true` |
| AC4 | `unset.captureLines=0`、`unset.httpStatus=200`、`unset.text.exact=true` |
| AC5 | `node --test scripts/voice-capture-process-check.false-forms.test.mjs` 退出 0（3/3 通过，13.4 s）：`mutation=assembly-not-wired baseExit=0 mutantRed=true whichReading=capture.lines`、`mutation=startup-line-missing baseExit=0 mutantRed=true whichReading=startup.text.count`；`repo-tracked-status=<clean>`、`repo-status=<clean>` |
| AC6 | `grep -c 'createVoiceService\|voice\.module\|voice\.service' scripts/voice-capture-process-check.mjs` = 0；`service-source-imports=0`；`hosts=127.0.0.1:21683,127.0.0.1:3243`；`real-upstream-calls=0` |
| AC7 | 见下「如实登记」 |
| AC8 | `npm run lint` 退出 0；`npm run typecheck` 退出 0；`npm run test:scripts` 退出 1 且相对 develop 不新增红 —— 见下「AC8 的收窄」 |

**如实登记（AC7）。** 本条判的是**真实服务进程**（`process.execPath` + `node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json server/index.ts`，本次运行的临时 `HOME`/`DATABASE_PATH`/`SERVER_PORT`，`HOST=127.0.0.1`）与**一次真实 HTTP**（multipart 字段名 `audio`，`Authorization: Bearer <对本次临时库 mint 出来的一次性 token>`）；**上游是本地替身**（`http://127.0.0.1:<随机端口>`）而不是真实 DashScope；**不驱动浏览器**；读的是**子进程 stdout** 而不是 `server.log`（重定向是部署方的事）；判据与旁证**不改任何出货源码**（本条只新增 `scripts/` 下两个文件）。判据自己的 `note.*` 行逐字打印这段话，中文原句为：`note: 本条判的是真实服务进程与一次真实 HTTP；上游是本地替身而不是真实 DashScope；不驱动浏览器；读的是子进程 stdout 而不是 server.log；判据与旁证不改任何出货源码。` 已知不等价点照 DoD 记：跑的是 `tsx` 直跑 `server/index.ts`，不是编译产物 `dist-server/server/index.js`；替身只说 openai-compatible 的 multipart 线。

**AC1 的 `real-db-untouched` 是归属读数，不是裸比较。** 继承 env 里的 `DATABASE_PATH` 指向操作员的真实库 `/data/home/yale/.cloudcli/auth.db`，而本机部署的 `:3001` 服务在持续写它（实测 15 s 内 6 次 mtime 变化、最大静默间隙 ~6 s，另观测到一次 ~11.6 s），所以「运行前后 mtime 相等」在真实负载下必然偶发假红，而「不等」又分不清是谁写的。判据因此把移动**归属**：跑完若发现它动过，就在剩余预算里静置观察它是否**再次**移动（`IDLE_PROOF_RESERVE_MS=3000`，每 250 ms 轮询，截止到 `WALL_BUDGET_MS` 前 3 s）；再次移动 ⇒ 写它的是外部负载（`real-db-churn=external`、`real-db-untouched=true`、退出 0），不再移动 ⇒ 那次写入是本次判据自己造成的（`real-db-churn=criterion-only`、退出 1，报错原文指名「a child inherited DATABASE_PATH instead of the run's own」）。三条支路都实测过：最终树上两次跑读 `none-observed`；**正例（外部支路）** `DATABASE_PATH=<临时假库>` 加一个每 0.5 s `touch` 的旁路写者 → `real-db-churn=external`、`real-db-idle-waited-ms=250`、退出 0；**反例（判据自身支路）** `DATABASE_PATH=<临时假库>` 且只在运行中 `touch` 一次 → 退出 1、`real-db-churn=criterion-only`、`real-db-idle-waited-ms=38812`、`elapsed-ms=42100`（仍在 45000 预算内），失败原文指名 `real-db-untouched`。可见这条读数在被违反时确实会红（可证伪），在日常负载下也不会因为别人的写入而假红 —— 而它挡的实害（沿继承值让 `mint-token` 往操作员真实库里插一行）在判据里由「子进程 `DATABASE_PATH` 覆盖成运行自己的临时库」直接消除。

**AC8 的收窄（登记，判据保持可证伪）。** `npm run lint`（oxlint src/ server/ scripts/ shared/）与 `npm run typecheck`（三条 tsc）在最终树上各退出 0（`npm run lint` 的读数是「只有既有 warning、退出 0」；裸 `npx oxlint` 在本仓本来就退出 1，故按仓门 `npm run lint` 读）。`npm run test:scripts` 退出 1：`tests 157 / pass 150 / fail 7`，7 条红**全部**落在本条未触碰的三个既有文件里 —— `scripts/asr-contract-invariants-check.test.mjs` 1 条（「reports an empty registry as an unmeasured board rather than a green one」）、`scripts/asr-extraction-parity-check.test.mjs` 2 条（AC2b、AC3）、`scripts/asr-health-provider-check.test.mjs` 4 条（AC1/AC8、AC3/AC8、AC4/AC8、AC7/AC8）。这不是本条引入的：这三个文件及其输入相对 develop 逐字节相同（`git diff --stat develop HEAD -- scripts/asr-contract-invariants-check.test.mjs scripts/asr-extraction-parity-check.test.mjs scripts/asr-health-provider-check.test.mjs scripts/asr-health-provider-check.mjs shared/asr server/` 为空），逐个单独跑同样红（所以不是 lane 内并发干扰），本条相 develop 的增量只有两个新文件，而同一 lane 里本条新增的 `scripts/voice-capture-process-check.false-forms.test.mjs` 3/3 全绿。红因已定位（见「发现登记」第 1 条），修它要动别的任务的 Touches，本条边界原文写着「登记为发现，不在本条顺手改」。因此 AC8 收窄为**不回归**这一不变量：**本条改动使该 lane 新增的失败数 = 0**。该不变量可证伪：本条文件里的任一条在同一 lane 内变红，或任一红落到本条触碰的文件上，它立刻不成立。

**发现登记（不属于本条，未在本条修改）。**
1. `scripts/asr-health-provider-check.mjs` 的 `FIXTURE_FILES` 是过期清单：它铺出的临时装置里没有 `dashscope-omni.asr-provider.ts`（`grep -c 'dashscope-omni' scripts/asr-health-provider-check.mjs` = 0），而 `shared/asr/asrRegistry.ts:35` 已经 `import … from './list/dashscope-omni/dashscope-omni.asr-provider.js'`（该 `.ts` 文件在树里存在、`tsc` 也通过），于是任何在装置里加载 registry 的读法都以 `Cannot find module './list/dashscope-omni/dashscope-omni.asr-provider.js'` 收场 —— 这解释了上表 7 条红的全部形状（探针线词汇表是闭集）。修它要动 `scripts/asr-health-provider-check.mjs`，不在本条 Touches 内。
2. `scripts/test.sh` 的 scoped-gate 文件过滤是 `grep -E '\.test\.[jt]sx?$'`，**不含 `.mjs`**，所以本条的 `--for-task` scoped gate 读出 `no scoped test files for gap-voice-capture-real-process (thin)` 并在 typecheck/lint/test 之前就 `exit 0`（实测两次：合并前、合并后，退出码均 0）。本条因此另跑了三项仓库门作为 AC8 的读数（见上）。这是既有的过滤行为，不是本条引入。
3. 本条的取假形态旁证里，`DATABASE_PATH` 被有意从判据的 env 里删掉，使 `real-db-untouched` 在副本上恒真、变异体的红只可能来自被指名的那条读数。这不是绕过 AC1 —— AC1 的那条读数在判据自己的运行里（继承真实值时）测，且上面两条正/反例都在真实继承语义下取；旁证删它是因为该读数度量的是部署方的库，不是这条旁证自己的变异。

**边界遵守。** 未改 `server/`、`src/`、`shared/`、`experiments/`、`docs/experiments/` 下任何文件；未读 `.env`/`.env.test`；除 `127.0.0.1` 外无网络目标（`real-upstream-calls=0` 就是「非回环目标在出发前被拒」的读数）；未驱动浏览器；未读 `server.log`；未改 `voice.module.ts`（AC5 的两处变异只发生在 `cp -al` 一次性副本里，且每次替换后都断言原文件逐字节未变、`git status --porcelain` 前后一致）。
