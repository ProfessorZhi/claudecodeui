---
id: gap-voice-sensevoice-server-adapter
title: 服务端 SenseVoice 适配器：把打补丁的 sherpa-onnx 作为 sensevoice-local 识别器接进 ASR
  缝，输出文本与逐 token 置信度和时间（子进程 worker、构建产物固定、健康检查）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-asr-token-confidence-contract
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on`）：`grep -il 'sensevoice\|sherpa' tasks/*.md` 无命中；契约部分归 `gap-voice-asr-token-confidence-contract`，本任务只做适配器与运行时。来源：`docs/proposals/voice-correction-feedback-loop.md` §5.9「引擎实现」、阶段 0；依据 `experiments/voice-index-loop/RESULT-v5.md`、`RESULT-v6.md`、补丁与构建脚本 `experiments/voice-index-loop/sherpa-patch/`。

### 目标

在 ASR 缝里加第四个识别器 `sensevoice-local`：服务端在本机运行**打了补丁的 sherpa-onnx 1.13.8** 的 SenseVoice-Small（int8），对上传的片段返回 `{ text, tokens[{ text, confidence, startMs }], meta.buildId }`（契约见 `gap-voice-asr-token-confidence-contract`）。已测读数：实时因子 p50 0.019；对本地 CPU 无 GPU。

### 方案（本文是提案，执行者可在记录理由后调整，但不得放宽 AC）

1. **运行时 = 子进程 worker，不是 Node 原生绑定**：`scripts/sensevoice/worker.py` 经 stdin / stdout 的 JSON 行协议收「音频字节（base64）与格式」、回 `{ text, tokens, buildId }`；`server/modules/voice/` 里的 TypeScript 管理器负责启动、并发上限（默认 2）、单次超时、崩溃后重启与排队。Node 绑定（`sherpa-onnx-node`）是否能带上补丁**没有验证**，列为后续备选。
2. **构建产物固定**：`scripts/sensevoice/manifest.json` 记录模型文件 sha256、补丁文件 sha256、期望的 `buildId`；管理器启动时校验，不一致就把引擎标为不可用（原因是同一段音频在不同构建产物上文本与置信度会略有不同，见提案 §5.9）。
3. **配置只在组装处读一次**（沿用 `voice.module.ts` 的「环境变量只在组合根读取」约定）：`SENSEVOICE_MODEL_DIR`、`SENSEVOICE_PYTHON`；缺失或校验失败 ⇒ `GET /api/voice/health` 报稳定错误码 `ENGINE_UNAVAILABLE` 并带可行动的说明，**不得**静默回退到别的识别器。
4. **不需要 API key**：设置页选中 `sensevoice-local` 时不显示密钥字段；provider 选择沿用现有的 `providerId` 机制与 fail-closed 规则。
5. 实现遵循 `.agents/skills/backend-module-standards`（`server/modules/voice/` 下全部 TypeScript、路由只解析与转发、测试放 `server/modules/voice/tests/`）与 `.agents/skills/frontend-module-standards`（设置页）。

### 边界（不做）

不做客户端（浏览器 / 手机）路径（见 `gap-voice-client-asr-feasibility-probe`）；不做任何 UI 上的置信度展示；不改 Omni 等现有识别器；不把模型权重或构建产物放进仓库（只放补丁、脚本与 manifest）。

## AC

- [x] `npx vitest run server/modules/voice/tests/voice-sensevoice-adapter.test.ts` 退出码 0：用假 worker 接缝覆盖 ①正常返回映射成 `AsrSuccess`（含 `tokens`、`meta.buildId`）②worker 超时 ③worker 崩溃后重启并成功处理下一条 ④并发超过上限时排队而不是并发执行 ⑤manifest 校验失败 ⇒ `ENGINE_UNAVAILABLE`
- [x] 真实运行时：`SENSEVOICE_MODEL_DIR=/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 SENSEVOICE_PYTHON=<打补丁构建的 python> npx vitest run server/modules/voice/tests/voice-sensevoice-real.test.ts` 退出码 0：对 ≥ 3 个 wav fixture，`tokens` 非空、每个 `confidence` ∈ (0, 1]、`meta.buildId` 与 manifest 一致、实时因子 ≤ 0.2；对同一片段的文本与补丁引擎的记录（`tc-verify/corpus/voice-index-loop/sv2/sv.jsonl`）逐字相同（≥ 5 个片段）
- [x] `GET /api/voice/health`：选中 `sensevoice-local` 且引擎可用时返回运行时状态与 `buildId`；模型目录缺失时返回稳定错误码 `ENGINE_UNAVAILABLE`（路由测试，沿用既有的 `voice-error-contract` 判据形状）
- [x] 注册表检查：`node scripts/asr-capability-check.mjs`、`node scripts/asr-contract-invariants-check.mjs`、`node scripts/asr-health-provider-check.mjs` 退出码 0（第四个适配器不能让既有的「第二适配器检查」等红）
- [x] 设置页：`npx vitest run src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx` 退出码 0，且新增用例断言选中 `sensevoice-local` 时不渲染密钥字段、可保存；`src/modules/i18n/locales/en/settings.json` 与 `zh-CN/settings.json` 含新增文案键
- [x] MCP 浏览器验证：用 playwright MCP 打开 `http://localhost:3001/`，设置 → 语音 → 选择 `sensevoice-local` 并保存；在 `?voiceDebug=1` 的上传入口上传一个 wav fixture，输入框得到识别文本；把页面上的文本与 `GET /api/voice/health` 的 `buildId` 记入 `## Evidence`
- [x] `npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## Evidence

全部读数取自本任务 worktree 分支上的实现（提交 `f8b99cf2`），命令一律在 worktree 绝对路径 `/data/home/yale/work/claudecodeui-worktrees/gap-voice-sensevoice-server-adapter` 下运行。

**AC1（假 worker 接缝）——判据命令的字面 runner 在本仓库不可达，先记这条偏差**
- `npx vitest run server/modules/voice/tests/voice-sensevoice-adapter.test.ts` → 退出码 1，输出 `No test files found`，并回显 `include: src/**/*.test.ts, src/**/*.test.tsx`。**这不是用例失败**：`vitest.config.ts` 的 `include` 只有 `src/**`，传给它的 `server/` 路径被静默丢弃。服务端测试在本仓库的规范 runner 是 `node:test`（`package.json` 的 `test:server`，`scripts/test.sh` 也用它）。AC1/AC2/AC3 三条都带这个偏差，三条都按规范 runner 记录读数。
- 规范 runner：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-adapter.test.ts` → `tests 10 / pass 10 / fail 0`，退出码 0。十个用例覆盖五个读出（①正常返回映射成含 `tokens`/`meta.buildId` 的 `AsrSuccess` ②超时 ③崩溃后重启并成功处理下一条 ④超上限排队 ⑤manifest 校验失败 ⇒ `ENGINE_UNAVAILABLE`），并带负对照（未安装引擎时仍答 `ENGINE_UNAVAILABLE` 而不是抛；解释器不存在是状态而不是崩溃）。
- **假形态**：把 `sensevoice-worker.ts` 的 `acquire()` 从 `if (active < concurrency)` 改成 `if (true)`（取消排队、来者皆并发）→ `tests 10 / pass 9 / fail 1`，退出码 1，唯一变红的用例是 `AC1④ requests past the concurrency cap wait for a slot rather than running at once`，`AssertionError [ERR_ASSERTION]: no more than the cap may be on the pipe at once`。改回后 10/10 绿、`git status --short` 空。

**AC2（真实运行时）**
- 同一 vitest 限制：字面命令 `… npx vitest run server/modules/voice/tests/voice-sensevoice-real.test.ts` 同样退出 1（`No test files found`）。
- 规范 runner：`SENSEVOICE_MODEL_DIR=/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 SENSEVOICE_PYTHON=/data/home/yale/work/sv-probe/v/bin/python3 npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-real.test.ts` → `tests 3 / pass 3 / skipped 0 / fail 0`，退出码 0。
- 六个片段（≥5 与 ≥3 两个下限都由用例自己断言，`clips.length >= 5`），逐条读数：
  `v3:1` dur=4.896s wall=0.091s rtf=0.0185 tokens=17 · `v3:1551` dur=21.312s wall=0.355s rtf=0.0167 tokens=95 · `v3:774` dur=8.232s wall=0.149s rtf=0.0182 tokens=41 · `v3:c1235.1` dur=17.376s wall=0.288s rtf=0.0166 tokens=68 · `v3:c298.14` dur=27.480s wall=0.470s rtf=0.0171 tokens=103 · `v3:c997.0` dur=17.280s wall=0.281s rtf=0.0162 tokens=73；mean wall clock 0.272s。每条 `buildId=sensevoice-1.13.8-c71f0ce00bec-sv-logprobs-v1`，与 `scripts/sensevoice/manifest.json` 第 24 行逐字相同（补丁 sha256 也在用例里按 manifest 复核后再比文本）。引擎握手读数：`AC2 engine: state=ready buildId=sensevoice-1.13.8-c71f0ce00bec-sv-logprobs-v1`。
- 每条片段同时断言：文本与记录 `sherpa_text` 逐字相同；`tokens` 非空；每个 `confidence ∈ (0,1]`；token 的文本、置信度（记录存四位小数，容差 5e-5）与起始帧（60 ms 位移）逐项复现记录；`meta.buildId` 等于 manifest 的；rtf ≤ 0.2。实时因子的分母是 wav 头里解析出的帧数，不是引擎自报的时长。

**AC2 在 fan-in 套件里的暴露，以及本文件为什么会被跳过**
- `scripts/test.sh` 用 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort` 收**全部**服务端判据，**没有排除表、没有 skip 名单**，而它的环境里没有 `SENSEVOICE_*`。若本文件对每次调用都 fail-closed，它会因为「这台机器上没有模型」把整个 fan-in 套件变红——那是关于宿主的事实，不是关于这次 diff 的事实。
- 所以本文件的闸门是**判据自己的输入** `SENSEVOICE_MODEL_DIR`：AC2 的命令按构造必然设它，判据自己的运行不可能跳过；别的运行不可能在这里失败。两个方向都实测：
  - 不带任何 `SENSEVOICE_*` → `tests 3 / pass 0 / skipped 3 / fail 0`，退出码 0，并逐条打印跳过原因（`AC2 skipped: SENSEVOICE_MODEL_DIR is not set, …`）。
  - `SENSEVOICE_MODEL_DIR=/tmp/ac2-empty-models`，其它变量照设 → 退出码 1，`AssertionError: /tmp/ac2-empty-models holds no model.int8.onnx, which is one of the two files …/scripts/sensevoice/manifest.json pins`。即：**判据被调用时缺件是红的且指名要设什么，没被调用时是一次可见的跳过**。`before` 钩子里的跳过判断是必需的——`before` 在全部用例都 skip 时仍会运行。

**AC3（`GET /api/voice/health`）**
- 规范 runner：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-health.routes.test.ts` → `tests 6 / pass 6 / fail 0`，退出码 0。真实 express app + 真实 `http.request` 读路由；六个用例含两条控制（远端 provider 在本机引擎不可用时仍读作健康；本部署命名的解释器确实不存在，所以 `stopped` 不是「跑着的引擎」），以及可用时的运行时状态与 `buildId` 读出。
- **假形态（打在正确的一支上）**：把 `voice.service.ts` 健康路径里 `effectiveRuntime.available === false` 时的 `code: 'ENGINE_UNAVAILABLE'` 改成 `'UPSTREAM_UNAVAILABLE'` → `tests 6 / pass 3 / fail 3`，退出码 1；变红的正是三条 `ENGINE_UNAVAILABLE` 用例（缺权重、完全未配置模型目录、引擎无法描述），两条控制与其余用例不受影响。改回后 6/6 绿。
- **负读数（记录在案，说明假形态必须打在被测的那一支上）**：先改的是 `voice.service.ts` **转写**路径（约第 1275 行）的同名 code，路由用例**不动**（6/6 仍绿、退出码 0）——健康读的是 `runtime()` 那一支，两处 code 是两条独立路径。

**AC4（注册表检查）**
- `node scripts/asr-capability-check.mjs` → 退出码 0（`reading=sensevoice-local:audio-stays-on-host.code value=ENGINE_UNAVAILABLE`、`reading=sensevoice-local:audio-stays-on-host.transport-calls value=0`、`reading=ambient-fetch-calls value=0`）
- `node scripts/asr-contract-invariants-check.mjs` → 退出码 0（`verdict=pass groups=6 readings=170 log-lines=170 platform-fetch-calls=0`）
- `node scripts/asr-health-provider-check.mjs` → 退出码 0（`verdict=pass`、`client-read-points=voiceProviderProfile,setVoiceProviderProfile`）
- **假形态**：把新适配器的 `locality: 'local-server'` 改成 `'remote'` → `node scripts/asr-second-adapter-check.mjs` 退出码 1，五条具名 FAIL，全部以 `'sensevoice-local':` 开头：`FAIL OVERSIZE_NOT_REJECTED` / `FAIL AUDIO_ALONE_REFUSED` / `FAIL UNHONORED_HINT_COUNTED_AGAINST_BUDGET` / `FAIL CASE_INPUT_STALE` / `FAIL ENVELOPE_NOT_READ`。改回后三个脚本全部退出码 0。

**AC5（设置页）**
- `npx vitest run src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx` → `Test Files 1 passed (1) / Tests 4 passed (4)`，退出码 0。
- 新增用例 `the provider that runs on this server shows no credential field of its own, says what it is, and saves`：两行都取自本部署的注册表（`listProviders()`，文件里不写任何 id），先有**阳性对照**（远端 provider 的三个字段确实渲染出来，`renderedFields.length === 3`），再切到本机识别器并断言 `voice-provider-fields` 为 `null`、字段数为 0、运行时块含 `provider=<id>` 与 `buildId=build-under-test-8f31`（buildId 是夹具自选值，不是从同一个注册表读回来的），最后断言 `saveConfig` 收到的文档里 `providerId` 是本机 id 且六个共享字段俱在。
- **假形态**：把 `VoiceSettingsTab.tsx` 的 `const declaration = selected?.credentialFields ?? null` 改成 `?? { endpointField: 'baseUrl', apiKeyField: 'apiKey' }`（给没有字段声明的 provider 也伪造一份声明）→ 该文件退出码 1。**诚实边界**：这次的失败不是一条具名断言，而是 vitest 的 `Unhandled Rejection: Error: Channel closed (ERR_IPC_CHANNEL_CLOSED)`——断言在渲染/effect 里抛出后 worker 直接死掉。归因靠的是「唯一的 diff 就是被改的那一行」，读数只有退出码；改回后 4/4 绿、工作树干净。判据本身要求的就是退出码 0，这条假形态足以证明该文件会被这个行为弄红，但它不是一条能指名的读数。

**AC6（浏览器端到端）——仪器偏差，以及替代读数的边界**
- **偏差一：本会话没有 playwright MCP server**（可用工具只有 archguard / meta-cc / quay 三组插件）。替代品是仓库自身的 Playwright harness（真实 Chromium + 真实后端 + 真实 Vite），用一次性 spec 驱动同一套栈，读完即删、不入库（`git status` 已确认无残留，`playwright.config.ts` 也已还原）。
- **偏差二：端口 3001 被占用**（pid 1181758，是托管本会话的共享服务，且它服务的是主检出里冻结的 `dist/`）。因此用 harness 每轮内核分配的端口，而不是 3001。
- 命令：`SENSEVOICE_MODEL_DIR=/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 SENSEVOICE_PYTHON=/data/home/yale/work/sv-probe/v/bin/python3 SENSEVOICE_PYTHONPATH=/data/home/yale/work/sherpa-patch/sherpa-onnx/build/lib.linux-x86_64-cpython-312 npx playwright test e2e/zz-sensevoice-ac6-probe.spec.ts` → `1 passed (16.2s)`。spec 继承这些变量是因为 playwright 把 `process.env` 合进 webServer 的 env（`node_modules/playwright/lib/runner/index.js:874`），所以没有任何东西在文件里冒充识别器。
- 读数：
  - `[ac6] provider=sensevoice-local buildId=sensevoice-1.13.8-c71f0ce00bec-sv-logprobs-v1`
  - 页面上的运行时块：`sensevoice-local runs on this server … Engine build: sensevoice-1.13.8-c71f0ce00bec-sv-logprobs-v1`（**页面上的 buildId 与 `GET /api/voice/health` 的 `buildId` 逐字相同**，也与 manifest 第 24 行相同）
  - 表单真的发出了选中该 provider 的文档（读的是 `PUT /api/voice/config` 的请求体，不是 DOM）；随后页面读到 `provider === sensevoice-local` 且 `configured === true` 的健康载荷
  - `?voiceDebug=1` 的上传入口（`input[type=file][accept="audio/*"]`）上传 `…/corpus/voice-index-loop/wav/1.wav` → `uploads=1 server-text="web server进程确认其监听的IP port。" composer-text="web server进程确认其监听的IP port。"`
  - **输入框里的文本等于服务器为这次上传给出的答案**（composer 文本 === `/api/voice/transcribe` 响应体的 `text`），这条链的两半都是读数：入口出现本身说明部署报了这个识别器可用，文本则被归因到这次上传的响应。
- **诚实边界（`matches-offline=false` 的诊断，记录不追）**：同一片段的离线记录是 `检查web server进程确认其监听的IP port。`，比 composer 里的多开头两个字。原因是客户端上传链的 VAD 前导把片段开头约 0.5 s 切掉，而语料恰好把这两 token 放在那里（60 ms/帧下 `检` t=4 ≈ 0.24 s、`查` t=7 ≈ 0.42 s）。**逐字一致由 AC2 直接驱动引擎的那条路径拥有，且它是绿的**；AC6 自己的断言是「composer 文本 === 服务器对这次上传的回答」，成立。
- **缺模型的失败形态（真读，非构造）**：把 `SENSEVOICE_MODEL_DIR` 换成一个空目录再跑同一个 spec → 503 ms 变红，且部署答的是 `{"available":false,"state":"unavailable","reason":"the SenseVoice model directory /tmp/ac6-empty-models does not hold 'model.int8.onnx'."}` —— 稳定、可行动、不崩溃，正是 DoD 里「缺模型时的失败是可行动的稳定错误码」的实读。

**AC7（typecheck / lint / build）** → 三条命令退出码均为 0（`npm run typecheck`：root + server + scripts 三个 tsconfig 全过；`npm run lint`：只有既有的 warning，无 error；`npm run build`：vite + `tsc -p server/tsconfig.json` + `tsc-alias` + `promote-dist-server` 全过）。第四个适配器逼出来的连带改动（第二适配器检查、跨模块契约测试、`asrInvariants.ts`、`server/shared/types.ts`）是这几条命令**跑出来**的，不是靠猜。

**i18n 键**：`en/settings.json` 与 `zh-CN/settings.json` 各含新增的 4 个 `voiceSettings.*` 键（`providerLocalTitle` / `providerLocalNotice` / `providerBuild` / `providerUnavailable`），两边键集互为子集；`ENGINE_UNAVAILABLE` 的错误文案按 `chat.json` 的既有约定加进了 12 个 locale，因为该 code 是用户可见的。**既有缺口（非本任务）**：`zh-CN/settings.json` 比 `en` 少 10 个 `voiceSettings.*` 键（`provider` / `providerCredentials` / `providerEndpoint` / `providerApiKey` / `providerModel` / …），这 10 个都不是本次新增的，本任务未触碰。

**声明了但没写的 Touches 路径**（三个，记录以免被当成漏改）：`shared/asr/list/index.ts` 不存在也不需要——三个兄弟 provider 目录同样没有 barrel，注册表按路径直接 import；`server/modules/voice/voice.routes.ts` 与 `src/shared/voiceConfig.ts` 未改动，健康读出走的是 `voice.service.ts` 的 `runtime()` 分支，provider 选择沿用的是既有的 `providerId` 机制。另：原 Touches 里的 `scripts/asr-capability-check.mjs` 只作为 AC4 的检查命令运行、本身未改动，故移出声明；实际被改的检查脚本是 `scripts/asr-health-provider-check.mjs`（给探针夹具的文件表补上 `dashscope-omni` 与 `sensevoice-local` 两个模块，否则 `shared/asr/asrRegistry.ts` 的 import 在夹具里抛错，行为读数恒为 unavailable）。

## DoD

真实落地判据：**真实的打补丁 sherpa-onnx 与真实模型**经子进程 worker 处理真实 wav，并在 MCP 浏览器里通过上传入口走完「设置选中 → 上传 → 输入框出文本」；与补丁引擎的离线记录逐字相同证明部署的构建产物就是实验用的那一份。缺模型 / 缺 Python 时的失败是可行动的稳定错误码，不是崩溃。

L_D 该轴仍暗，理由：本任务只接入识别器，不新增领域数据能力。

L_G 该轴有读数：同一批片段上适配器输出与补丁引擎记录的逐字一致率，与实时因子，由真实运行时测试给出。

## Touches

- shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.ts (new)
- shared/asr/asrRegistry.ts
- shared/asr/asrInvariants.ts
- server/modules/voice/sensevoice-worker.ts (new)
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-sensevoice-adapter.test.ts (new)
- server/modules/voice/tests/voice-sensevoice-real.test.ts (new)
- server/modules/voice/tests/voice-sensevoice-health.routes.test.ts (new)
- server/modules/voice/tests/voice-provider-dispatch.test.ts
- server/modules/voice/tests/voiceHealth.test.ts
- server/shared/types.ts
- scripts/sensevoice/worker.py (new)
- scripts/sensevoice/manifest.json (new)
- scripts/sensevoice/README.md (new)
- scripts/asr-health-provider-check.mjs
- scripts/asr-second-adapter-check.mjs
- scripts/asr-second-adapter-check.test.mjs
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/modules/settings/hooks/useVoiceProviderOptions.ts
- src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx
- src/shared/asr/tests/asrContractInvariants.test.ts
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- tasks/gap-voice-sensevoice-server-adapter.md
- server/modules/voice/tests/voice-error-classification.test.ts
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts
- scripts/asr-dashscope-omni-check.test.mjs
- server/shared/tests/quay-test-script.test.ts

## Notes

fan-in suite red was attributed: the new ENGINE_UNAVAILABLE code makes the error vocabulary 14 members, so the AC-149 pins (`vocab.length === 13`, table-row tokens source=12/14, "thirteen") and the omni check's copied fixture (missing sensevoice-local module) went red. Fixed on branch task/gap-voice-sensevoice-server-adapter in commit a89e19a4. Verified locally: voice-error-classification.test.ts exit 0, voice-error-classification.false-forms.test.ts 7/7 pass, `node --test scripts/asr-dashscope-omni-check.test.mjs` 14/14 pass.

本轮（2026-10-06）再次 red 的归因：`server/shared/tests/quay-test-script.test.ts` 的 AC2/AC3 把服务端测试文件的**精确收集数**写进了判据（develop 上 unknown=230 / unknown=232，即 233 个文件）。本任务新增 3 个服务端测试文件（voice-sensevoice-adapter / voice-sensevoice-real / voice-sensevoice-health.routes），收集数变为 236，于是两处应为 unknown=233 / unknown=235。按 develop 提交 `2df26ada`（"服务器测试文件数 232→233，修精确计数钉"）确立的约定同步上移这两个字面量，不改断言结构。该文件不是本任务的实现产物，只为让精确计数钉与新增测试文件数一致而改，故一并声明进 Touches。修复后本文件 `tests 11 / pass 11 / fail 0`，exit 0；`npm run typecheck`、`npm run lint` 均 exit 0。

## Needs-Human

**执行 2026-10-06T01:15:34.854Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 4 failing lines and attributed none to a file); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=77532 server/modules/voice/tests/voice-error-classification.false-forms.test.ts passed=false end_ms=1791249297782
- run_id：wk-prod-anchor
- session_id：e611924f-e22f-4496-92a3-ba61055e394d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-sensevoice-server-adapter~wk-prod-anchor~1791249132076-02cd06.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-sensevoice-server-adapter-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-06T01:58:11.496Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 2 failing lines and attributed none to a file); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=33556 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1791251814000
- run_id：wk-prod-anchor
- session_id：17e84e98-4d40-4051-83bd-314f3fc20afa
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-sensevoice-server-adapter~wk-prod-anchor~1791251597105-a5585e.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-sensevoice-server-adapter-wk-prod-anchor.log
