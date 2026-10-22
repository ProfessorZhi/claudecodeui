---
id: gap-asr-proxy-only-ssrf-and-direct-path-zero
title: proxy-only 的 provider 在直连路径零请求并改走 /api/voice/transcribe（带
  x-voice-provider）；用户填写的 DashScope 地址受主机白名单约束：白名单外 INVALID_BASE_URL
  且零上游请求，白名单内放行（AC-140）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-proxy-provider-dispatch
goal_ac: AC-140
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：立案时 `grep -rln "^goal_ac:.*AC-140" tasks/*.md` 零命中；`AC-140` 在 `tasks/` 下只出现在三条同族任务的**范围让渡**文字里 —— AC-137、AC-138、AC-139 三条各自逐字写着「不加 `transport` 字段与 SSRF 主机白名单、不做 proxy-only 在直连路径零请求（AC-140）」，也就是说本条是它们白纸黑字让出的那一半，不是它们的重述。相邻但机制不同的是 AC-134：`x-voice-provider` 在它那里只是「代理面携带 id 的通道」，既不含直连归零也不含主机白名单。关键词 `maas.aliyuncs.com` 在 `tasks/` 下的唯一命中是一条实验记录里的真实工作空间地址（本任务把它当白名单内的阳性对照用），不是第二条在做主机白名单的任务。

**现状（立案时实测，可复验）**：

| 缺什么 | 实测 |
|---|---|
| `transport` 字段 | `shared/asr/asrRegistry.ts` 的 `AsrCapabilities` 里没有它（只有 `acceptsMime` / `maxInlineRequestBytes` / `oversize` / `honors` / `billing` / `pauseCues` / `style` / `oneShot`）；`grep -rn transport shared/asr/asrRegistry.ts` 命中的全是注释 |
| proxy-only 的声明 | `shared/asr/list/` 下两个模块都不声明 transport |
| 直连路径的分流 | `src/shared/api.ts` 里 `if (config.baseUrl.trim())` 是直连分支的唯一条件，与 provider 的能力声明无关。实测驱动一次（替身 `globalThis.fetch` + 已发布的 profile + 带 baseUrl 的配置），录到的请求是 `["/api/voice/config", "https://<baseUrl>/audio/transcriptions"]` —— 配置了 baseUrl 就一定直连 |
| 客户端侧的 `x-voice-provider` | `grep -rn "x-voice-provider" src/` 零命中；服务端 `server/modules/voice/voice.routes.ts` 已经在读这个头 |
| 主机白名单 | `grep -rn "maas.aliyuncs.com" shared/ server/ src/ scripts/` 零命中。`voice.service.ts` 的 `validateBackendBaseUrl` 只做「protocol ∈ {http,https} 且 hostname 不是 169.254.\*」——它**故意**放行 http 与私网（本地后端是支持场景），这正是不该被白名单管住的那一侧 |
| 实际后果（实测三个地址） | 生效 provider `openai-compatible`、`defaults.baseUrl` 分别取 `https://evil.example.com` / `http://127.0.0.1:8080` / `https://aliyuncs.com.evil.com` 时，`transcribe` 三次全部 `ok:true`，且**每次上游都被调用 1 次** |
| `INVALID_BASE_URL` 的回落 | 这个名字只在 `asrRegistry.ts` 的错误码联合里；`validateConfiguredBackend` 的拒绝是 `{status:400, error:'Invalid voice backend URL.'}`，**不带 code** —— `server/shared/types.ts` 里 `code?` 的注释还把「a bad URL」举成不带码的例子 |
| 判据 | `ls scripts/ \| grep proxy-only` 为空；AC-140 的 `criterion:` 逐字是 `node scripts/asr-proxy-only-ssrf-check.mjs` |

**本任务交付五件东西：**

1. **`transport` 进能力声明面**（`shared/asr/asrRegistry.ts`）：`AsrCapabilities.transport: 'direct' | 'proxy-only'`，**必填**（给缺省值等于留一个沉默的第二真相源）；`AsrAdapter` 增一个可选的 `allowedBaseUrl?: (baseUrl: string) => boolean` —— 端点规则由**拥有该端点的适配器**声明，而不是在服务端另写一张按 id 索引的表。两个既有适配器声明 `'direct'`，dashscope-omni 声明 `'proxy-only'` 并带上自己的规则。
2. **白名单一条实现**（`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`）：必须是 `https:`；hostname 匹配 `^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$` 或等于 `dashscope.aliyuncs.com`；不接受端口与用户信息。正文是设计文档 §3（SSRF 防护）逐字那条，不是本任务新发明的规矩。
3. **服务端在解析出的地址上执行它**（`server/modules/voice/voice.service.ts`）：生效 provider 的 `transport === 'proxy-only'` 且 `adapter.allowedBaseUrl` 判否 ⇒ 与今天同一步的**预请求拒绝**，`status 400` + `code: 'INVALID_BASE_URL'`，且**一次 `fetchBackend` 都不发**。`'direct'` 的 provider 一个字节都不改（http 与私网今天合法，仍然合法）。`server/shared/types.ts` 里那句「a bad URL 不带码」的举例要跟着改，否则注释与行为互相打脸。
4. **客户端直连路径按声明分流**（`src/shared/api.ts`）：`transcribeVoice` 在 `if (config.baseUrl.trim())` **之前**读健康检查发布的 profile；`transport === 'proxy-only'` ⇒ 整段跳过直连分支，走 `api.voice.transcribe`（`/api/voice/transcribe`）并带上 `x-voice-provider: <profile.id>`。**未发布 profile 时保持今天的行为** —— 同 `unregisteredProviderRefusal` / `unsupportedContainerRefusal` 的纪律：没有可读的声明就不改路由。头部在 `transcribeVoice` 的调用点组装，而不经 `voiceConfigHeaders()`：后者在 `typeof window === 'undefined'` 时直接返回 `{}`（实测），把路由头放到那条 early return 之后会让它在一个非浏览器环境里静默消失。若实现偏要经它，Touches 要加上 `src/shared/voiceConfig.ts` 并处理那条 early return。
5. **判据与取假形态**：`scripts/asr-proxy-only-ssrf-check.mjs`（AC-140 的 `criterion:` 逐字就是它）+ `scripts/asr-proxy-only-ssrf-check.test.mjs`。
   - 判据用 `tsx/esm/api` 的 `register({ tsconfig })` 让裸 `node` import 树里的 `.ts`（`scripts/asr-second-adapter-check.mjs` 的先例），并且**从 `--root` 指向的那棵树**按路径取模块：客户端半取 `src/shared/api.ts`，服务端半取 `server/modules/voice/voice.service.ts`。两者都在根 tsconfig 下可加载（实测：前者需要它来解 `@/…` 与 `@shared/…` 别名；后者在该 tsconfig 下也能加载，因为它唯一的根别名 import 是类型导入，运行时被擦除）。
   - 客户端半的替身 `globalThis.fetch` 就是观测器：它记录每个 URL，并把 `/api/voice/config` 答成一份带 baseUrl 的配置 —— hydration 的那一次请求因此也在列表里，读数必须数「**发往 baseUrl 的请求**」而不是「总请求数」。需要最小 `localStorage` 替身（实测：`whenVoiceConfigReady()` → `runHydration()` → `api.voice.config()` 这条链路在没有 `window` 时也能跑通）。
   - 服务端半用注入的计数 `fetchBackend`，不碰 `globalThis.fetch`。
   - 取假形态按 `scripts/asr-second-adapter-check.test.mjs` 的先例，由**测试文件运行期从出货文件复制出临时树再逐条变异**，每条先要求未变异退出 0（正向控制），再要求变异后非零 —— 「必红」因此是可执行用例，「恒红」与「改了才红」可区分。
   - **criterion 自身必须远快于 60 秒**（目标侧判据门 60 秒硬上限且不可调）：变异 fixture 的复制与运行全部放在测试文件里，判据只跑一次未变异树、文件里零子进程。

**为什么这样切**：AC-140 的两半各自是一句话的**行为** ——「配置了 baseUrl 也不再直连」与「白名单外的地址一次上游都不发」。所以两半都读**替身记下来的东西**：客户端那半读替身收到的请求列表（去了哪、带没带 `x-voice-provider`），服务端那半读计数 `fetchBackend` 的调用次数。而「谁说了算」各自有正对照：客户端那半有 `'direct'` 的 profile 与「未发布 profile」两条；服务端那半有白名单内两个合法地址（其中一个是实验记录里的真实工作空间地址）与 `'direct'` provider 的私网地址一条。「一律走代理」「一律拒绝」「把白名单套到所有 provider 身上」三种做法各被一条对照抓住。

**边界（不做）**：不把用户**存的服务地址**接进服务端（那是 AC-141 的词；判据在 `createVoiceService` 的 `defaults.baseUrl` 这个解析接缝上注入地址，`voice.module.ts` 今天填的是 `VOICE_API_BASE_URL`）；不做用户级 provider 选择、key 掩码与健康检查的 `configured` 语义（AC-141）；不做浏览器端到端（AC-142）；不改 `chat-audio` 的线协议、解析降级与错误码（AC-137/138）；不改服务端按 provider 分派与 `AsrErrorCode→HTTP` 表（AC-139）—— 本条只在既有的预请求拒绝那一步加一条判否，状态码取值沿用 400；不新增不变量板探针（板子量的是适配器层的请求，本条两半都在适配器之外）；不联网、不重跑实验、不改 `experiments/` 下任何文件。

## AC

- [x] AC1 判据入口与「空读数不是绿」：`node scripts/asr-proxy-only-ssrf-check.mjs` 退出 0，并逐条打印读数（每条带 `ok` 或 `FAIL <TOKEN>`，红时不只有 token、还把被测的**值**打印出来）；`node scripts/asr-proxy-only-ssrf-check.mjs --root <空临时目录>` 非零退出且输出含 `EMPTY_READING`（不得静默跳过）。
- [x] AC2 `transport` 是能力声明面的一块，且 proxy-only 必须带端点规则：判据经 **registry**（不是读模块文件）打印每个 provider 的 `transport[<id>]`，断言 `openai-compatible` 与 `multimodal` 为 `'direct'`、`dashscope-omni` 为 `'proxy-only'`；并断言「每个 `transport === 'proxy-only'` 的已注册 provider 都带一个 `allowedBaseUrl` 函数」，缺一个即 `FAIL PROXY_ONLY_WITHOUT_ENDPOINT_RULE` 并指名该 id。
- [x] AC3 直连路径零请求（读数是替身收到的那串请求）：判据用替身 `globalThis.fetch` 驱动**出货的** `transcribeVoice`（不是判据自写的分流），把健康检查发布的 profile 设为**从 registry 取出的** `dashscope-omni` 的 capabilities，并让客户端配置里的 `baseUrl` 指一个白名单内的工作空间地址；断言 (a) 发往该 baseUrl 的请求数为 **0**；(b) 发往 `/api/voice/transcribe` 的请求恰好 **1** 个，且其请求头 `x-voice-provider` 逐字等于 `dashscope-omni`；(c) 该请求带上了录音字节。同一读数有两条阳性对照：(a) profile 换成 `openai-compatible`（`'direct'`）⇒ 发往 baseUrl 的直连请求恰 1 个、`/api/voice/transcribe` 为 0（「一律走代理」过不了这条）；(b) **未发布** profile ⇒ 直连路径照旧（跳过是**由声明**决定的，不是「有没有 profile」）。判据打印每个 case 的 `direct-path[<case>] direct=<n> proxy=<n> x-voice-provider=<值>`。
- [x] AC4 取假形态 (2)「忽略 proxy-only 仍直连」是**可执行用例**：`node --test scripts/asr-proxy-only-ssrf-check.test.mjs` 退出 0，其中 `direct-despite-proxy-only`（把出货的分流判据改成恒假）非零退出并指名 AC3 的那一行读数；同一 fixture 未变异时先退出 0（正向控制先行 —— 恒红的工装不能证明任何事）。
- [x] AC5 白名单是一扇门（正向对照）：判据用注入的计数 `fetchBackend` 驱动出货 `createVoiceService`，生效 provider 为 `dashscope-omni`；`https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com`（实验记录里那个真实工作空间形态）与 `https://dashscope.aliyuncs.com` 各**放行**：`ok === true` 且上游调用次数 **1**；判据逐条打印 `allow[<host>] ok=<b> calls=<n>`。
- [x] AC6 白名单外一律 `INVALID_BASE_URL` 且上游调用次数为 0：同一驱动器对 `https://evil.example.com`、`https://aliyuncs.com.evil.com`、`https://dashscope.aliyuncs.com.evil.com`、`https://127.0.0.1`、`http://llm-x.cn-beijing.maas.aliyuncs.com`（非 https）、`https://llm-x.cn-beijing.maas.aliyuncs.com:8443`（带端口）、`https://u:p@llm-x.cn-beijing.maas.aliyuncs.com`（带用户信息）、`not-a-url`（不是 URL）各打印一行 `reject[<输入>] ok=<b> status=<n> code=<码> calls=<n>`，断言 `ok === false`、`status === 400`、`code === 'INVALID_BASE_URL'`、**calls === 0**（是计数器，不是从错误码推断出来的）。
- [x] AC7 取假形态 (1)「去掉主机校验」是**可执行用例**：`host-check-removed`（服务端那一步不再查那条规则）非零退出并指名 AC6 的行；未变异先绿。另加两条承重控制：(a) `rule-loosened`（把出货那条规则改成恒真，即规则本体被换掉）⇒ AC6 必须红 —— 它证明判据读的是**出货树里的**规则；(b) `whitelist-for-every-provider`（把白名单也套到 `'direct'` 的 provider 上）⇒ AC8 的对照必须红。
- [x] AC8 白名单只约束 proxy-only，不约束 direct：生效 provider 为 `openai-compatible`（`'direct'`）且地址为 `http://127.0.0.1:8080`（今天的**合法**后端：`validateBackendBaseUrl` 故意放行 http 与私网）⇒ `ok === true` 且上游调用次数 1；判据打印 `direct-provider-passthrough[http://127.0.0.1:8080] ok=true calls=1`。这条是「白名单是一堵墙」的取假形态。
- [x] AC9 规则只有一份、来自出货树：判据打印它 import 的符号名与模块相对路径（相对 `--root` 解析），且 `grep -n "maas\.aliyuncs\.com\|dashscope\.aliyuncs\.com" scripts/asr-proxy-only-ssrf-check.mjs scripts/asr-proxy-only-ssrf-check.test.mjs` **零命中**（工装里没有第二份主机名单）；阳性对照：判据的输出里**确实出现**这两个主机（不是靠「什么都没比」过的）。
  - 登记（本条第二轮的收窄，见 Evidence §8）：`host-bearers` 的扫描面由「`src/**`、`shared/**`、`server/**` 下所有 `.ts`/`.tsx`」收窄为**出货源**（`isTestFile`：路径含 `/tests/` 或后缀 `.test.ts`/`.test.tsx` 的一律不扫）。收窄的理由就是这条读数自己的不变量：「规则只有一份」说的是**出货树**里那条谓词与它据以构造的两个主机名只有一份；而一条驱动 `'proxy-only'` provider 的判据**必须**给出一个规则接受的地址（AC6 逐字就是「其余地址一律在适配器之前被拒」），所以测试文件里出现该地址是**调用方在写自己的输入**，不是规则的第二个副本 —— 把测试算进去会让这条读数对**本条所关于的那个 provider** 恒不可满足，而一条任何正当测试都活不过的检查量错了东西。收窄后仍可执行（负对照实测）：把 `https://dashscope.aliyuncs.com` 写进一个临时新建的出货文件 `shared/__probe_host_control.ts` 时，`host-bearers=shared/__probe_host_control.ts,shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`、`endpoint-rule.single-implementation verdict=FAIL ENDPOINT_RULE_NOT_SINGLE_COPY`、判据退出 1 且输出**指名该文件**；删掉后恢复 `host-bearers=1`、`verdict=ok`、退出 0。两种读法都登记在此。
- [x] AC10 契约面与既有读数不变：`npm run typecheck` 退出 0（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套；新增一个**必填**能力字段会碰到每个适配器的声明）；`npm run lint` 退出 0；并且 `node scripts/asr-second-adapter-check.mjs`、`node scripts/asr-contract-invariants-check.mjs`、`node scripts/asr-capability-check.mjs`、`node scripts/asr-mime-size-gaps-check.mjs`、`node scripts/asr-extraction-parity-check.mjs`、`node scripts/asr-health-provider-check.mjs`、`node scripts/asr-pause-cues-source-check.mjs` 七条全部退出 0，且判据把七条的退出码打印出来（不是空过）。若某条因新行而红，修的是适配器/白名单那一行或本条的接线，**不得**改窄这些检查。
      - 登记（判据把七条的退出码逐条打印，`sibling[<name>] exit=<n> first-fail=<TOKEN>`，并断言七条**都被执行**：`subprocesses=7 (contract readings only)`）。**合并 `develop` 之后实测 `siblings=7/7 exit-0`** —— 七条契约读数全绿，AC10 的「七条全部退出 0」在最末的工作树上逐字成立。立案时的读数曾是 `siblings=5/7 exit-0`：`asr-second-adapter-check` 与它的转发器 `asr-capability-check` 为 `exit=1`，首条 FAIL 同为 `AUDIO_ALONE_REFUSED`。那次红**不是**本任务新行造成的：拿 `git archive develop` 出的纯净树跑同一条探针，五条 FAIL 逐字相同（`AUDIO_ALONE_REFUSED` / `UNHONORED_HINT_COUNTED_AGAINST_BUDGET` / `CREDENTIAL_NOT_ON_WIRE` / `UNEXPECTED_CREDENTIAL_HEADER` / `ENVELOPE_NOT_READ`）—— 原因是那条探针的线词汇表是闭集、把第三条线（`chat-audio`）折成 `inline-json`，属 `gap-asr-capability-probe-third-wire`<!-- dedup-ref:inline --> 的范围（该条自己的 Proposal 逐字预言了这三个 token），本任务只加 `transport` / `allowedBaseUrl` / 分流，一行都没碰任何探针的线与读数。该条的修复在 `develop` 上落地后被本次合并带进工作树（合并带的三个文件正是 `scripts/asr-second-adapter-check.mjs` 及其测试与那条任务的文件），两条因此转绿。判据把 `siblings=` / `siblings-red=` / `siblings-note=` 打进输出，红不被静默吞掉。`npm run typecheck` 与 `npm run lint` 各实测 exit 0。
- [x] AC11 离线是强制的、不是声明的：服务端那半全程只用注入的 `fetchBackend`，判据把 `globalThis.fetch` 换成毒药（被调用即记账并抛错），毒药计数为 0；客户端那半的读数**就是**记录型 `globalThis.fetch` 的调用列表（浏览器直连用的本来就是环境 fetch）—— 判据打印 `network=stand-in poison=<n> client-requests=<n>`，两个计数不得同形（毒药为 0 且客户端替身有记账，才算这一条成立）。
- [x] AC12 判据自身远快于 60 秒：`node scripts/asr-proxy-only-ssrf-check.mjs` 打印自身耗时读数 `elapsed-ms=<n>` 且 < 15000（目标侧判据门 60 秒硬上限且不可调；变异 fixture 的复制与运行全在测试文件里，判据文件里零子进程）。
      - 登记：为满足 AC10「判据把七条的退出码打印出来」，判据**起且只起**七个进程（每条一次、并行、`subprocesses=7`），`elapsed-ms` 含它们；「零子进程」这一半按不变量收窄为**「判据不跑任何变异 fixture、不起除七条契约读数之外的进程」**，实测 `elapsed-ms=2923`（合并 `develop` 后复测 `3128`，两次都在 3 s 量级）< 15000（变异 fixture 的复制与运行仍全在 `scripts/asr-proxy-only-ssrf-check.test.mjs`）。
- [x] AC13 如实登记：判据输出与本任务的完成记录里写明「本条只做 proxy-only 的直连归零与 DashScope 地址的主机白名单；不把用户存的服务地址接进服务端、不做 key 掩码与 `configured` 语义（AC-141）；不做浏览器端到端（AC-142）；判据在 `createVoiceService` 的 `defaults.baseUrl` 这个解析接缝上注入地址，全程替身与注入 transport，未接触真实 DashScope（ADR-004 决策 8：真实冒烟归人工）」。
- [x] AC14 兄弟判据的**输入**因新行而失效时，改的是那条非法输入、不是断言：AC-139 的判据 `server/modules/voice/tests/voice-provider-dispatch.test.ts`（不在本条交付面内，但它驱动的是同一个出货 `createVoiceService`）里 `DEFAULTS.baseUrl` 由 `https://voice.example/v1` 改为 `https://dashscope.aliyuncs.com`（**本条白名单内**的公开主机），六条用例的断言逐字未动。实测 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch.test.ts` 退出 0；`.../voice-provider-dispatch-falsify.test.ts` 退出 0（正控未变异树 `control=exit-0`，两条变异各 `exit=1`）。**修前基线**（同一棵树，只差那一行）：该判据 `# fail 2`、三条断言红 —— `AC2 dashscope-omni / chat-audio` 的 `calls.length` `0 !== 1`、`AC5` 的 `NO_SPEECH_DETECTED` `400 !== 422`、`AC10` 的 `result.ok` `false !== true`；三处同源：`dashscope-omni` 声明 `'proxy-only'`，而该判据给它的地址在规则之外，本条的预请求闸在适配器之前就拒绝了它（`calls=0` 正是「拒绝发生在预请求这一步」的证据）。**登记**：这不是把断言改窄 —— 断言逐字未动，改的是一条在本条落地后不再合法的**输入**；该判据量的是「选中的 provider 用哪条线」，与主机无关，故换主机不减其承重。

## Evidence

读数环境：本任务的工作树 `/data/home/yale/work/claudecodeui/.claude/worktrees/gap-asr-proxy-only-ssrf-and-direct-path-zero`（分支 `task/gap-asr-proxy-only-ssrf-and-direct-path-zero`，基于 develop），node v24.21.0。**全程离线**：服务端半的 `fetchBackend` 是注入的计数替身，`globalThis.fetch` 在服务端半期间是「记账并抛错」的毒药。

**1. 行为判据（AC1–AC3、AC5–AC6、AC8、AC11–AC12 的机械读数）** — `node scripts/asr-proxy-only-ssrf-check.mjs`，**exit 0**，58 条 `reading=`（下表的头段与 `sibling[…]` 段是**合并 `develop` 之后**的复测；`elapsed-ms` 与 `siblings` 两行立案时为 `2923` 与 `5/7`，见 AC10/AC12 的登记）：

```text
asr-proxy-only-ssrf-check root=<worktree>
endpoint-rule.modules=1
endpoint-rule.module=shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts symbol=allowedBaseUrl
registry=shared/asr/asrRegistry.ts
registered=openai-compatible,multimodal,dashscope-omni
host-candidates=18
public-host=dashscope.aliyuncs.com workspace-host=llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com
host-bearers=shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
siblings=7/7 exit-0
subprocesses=7 (contract readings only)
elapsed-ms=3128
transport[openai-compatible] direct
transport[multimodal] direct
transport[dashscope-omni] proxy-only
allow[https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com] ok=true calls=1
allow[https://dashscope.aliyuncs.com] ok=true calls=1
reject[https://evil.example.com] ok=false status=400 code=INVALID_BASE_URL calls=0
reject[https://aliyuncs.com.evil.com] ok=false status=400 code=INVALID_BASE_URL calls=0
reject[https://dashscope.aliyuncs.com.evil.com] ok=false status=400 code=INVALID_BASE_URL calls=0
reject[https://127.0.0.1] ok=false status=400 code=INVALID_BASE_URL calls=0
reject[http://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com] ok=false status=400 code=INVALID_BASE_URL calls=0
reject[https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com:8443] ok=false status=400 code=INVALID_BASE_URL calls=0
reject[https://u:p@llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com] ok=false status=400 code=INVALID_BASE_URL calls=0
reject[not-a-url] ok=false status=400 code=INVALID_BASE_URL calls=0
direct-provider-passthrough[http://127.0.0.1:8080] ok=true calls=1
direct-path[proxy-only] direct=0 proxy=1 x-voice-provider=dashscope-omni
direct-path[direct-provider] direct=1 proxy=0 x-voice-provider=<none>
direct-path[unpublished] direct=1 proxy=0 x-voice-provider=<none>
direct-path[direct-provider-2] direct=1 proxy=0 x-voice-provider=<none>
reading=direct-path[proxy-only].proxy-body value=audio:<file name=probe.webm type=audio/webm;codecs=opus size=4096B>
sibling[asr-second-adapter-check] exit=0
sibling[asr-contract-invariants-check] exit=0
sibling[asr-capability-check] exit=0
sibling[asr-mime-size-gaps-check] exit=0
sibling[asr-extraction-parity-check] exit=0
sibling[asr-health-provider-check] exit=0
sibling[asr-pause-cues-source-check] exit=0
network=stand-in poison=0 client-requests=5
```

AC6 那三条「非 https / 带端口 / 带用户信息」的输入是**从矿出的工作空间主机派生**的（`http://<host>`、`https://<host>:8443`、`https://u:p@<host>`），AC 正文写作 `llm-x…` 只是占位；AC9 禁止工装里出现这两条主机字面量，派生让形态与 AC 逐条一致而字面量一个都不写。

**2. 空读数不是绿（AC1 第二半）** — `node scripts/asr-proxy-only-ssrf-check.mjs --root /tmp/empty-probe`，**exit 1**，输出含 2 条 `EMPTY_READING`（并附 `ENDPOINT_RULE_UNRESOLVED` / `REGISTRY_UNRESOLVED` / `PROBE_THREW`，`subprocesses=0`、`siblings-unrun=7 of 7 …`）。

**3. 取假形态（AC4 / AC7，可执行用例）** — `node --test scripts/asr-proxy-only-ssrf-check.test.mjs`，**exit 0**，6/6 通过（合并后 6077 ms），其中四条各自「未变异 fixture 先绿 → 单点变异后非零且指名 token」：

```text
✔ AC4: a proxy-only provider whose route is not taken is caught on the stored address   → direct-despite-proxy-only        ⇒ PROXY_ONLY_STILL_DIRECT
✔ AC7: a server step that no longer asks the rule is caught by the missing code         → host-check-removed               ⇒ REJECTED_NOT_INVALID_BASE_URL
✔ AC7: a rule that admits every well-formed address is caught by the same near-misses   → rule-loosened                    ⇒ REJECTED_NOT_INVALID_BASE_URL
✔ AC7: a rule applied to every provider is caught by the direct provider’s control      → whitelist-for-every-provider     ⇒ DIRECT_PROVIDER_BLOCKED
✔ AC9: the addresses reach the run as inputs while neither file spells them
✔ AC10: the criterion re-takes the seven contract readings and prints their codes
```

**4. 规则只有一份、工装里没有第二份主机名单（AC9）** — `grep -n "maas\.aliyuncs\.com\|dashscope\.aliyuncs\.com" scripts/asr-proxy-only-ssrf-check.mjs scripts/asr-proxy-only-ssrf-check.test.mjs` **零命中**；阳性对照：两个主机确实出现在判据输出里（工作空间主机出现 10 行、公开主机 2 行），`host-bearers=` 只有一个文件且正是规则模块。收窄后的扫描面与它的负对照见 AC9 的登记与 §8。

**5. 静态门（AC10）** — `npm run typecheck` exit 0（根 + `server/tsconfig.json` + `scripts/tsconfig.json`，新增必填字段使三个适配器都必须声明）；`npm run lint` exit 0（0 error，两个新文件零命中）。七条契约读数的退出码见 §1 的 `sibling[…]` 段：合并 `develop` 后七条全部 `exit=0`（立案时 5/7，两条的红为 develop 既有，见 AC10 的登记与 §6）。判据只要求两条：七条都被执行、退出码可读（`subprocesses=7`），且红不被静默吞掉（`siblings-red=` / `siblings-note=`）。

**6. 复现实验（立案时的红不是本任务造成的）** — `git archive develop | tar -x -C /tmp/dv-tree` 后 `node scripts/asr-second-adapter-check.mjs --root /tmp/dv-tree`，得到的 5 条 FAIL 与在本分支上跑出的**逐字相同**（`AUDIO_ALONE_REFUSED`、`UNHONORED_HINT_COUNTED_AGAINST_BUDGET`、`CREDENTIAL_NOT_ON_WIRE`、`UNEXPECTED_CREDENTIAL_HEADER`、`ENVELOPE_NOT_READ`）；`--root` 确为模块解析根（删掉 `/tmp/dv-tree/shared/asr/list/dashscope-omni` 后同一条探针报 `provider-modules=2` 并从 `/tmp/dv-tree/...` 解析）。该形态由 `gap-asr-capability-probe-third-wire`<!-- dedup-ref:inline --> 修复，本次合并把它带进工作树之后这七条全绿。

**7. 如实登记（AC13）** — 本条只做 proxy-only 的直连归零与 DashScope 地址的主机白名单；**不**把用户存的服务地址接进服务端（那是 AC-141 的词），判据在 `createVoiceService` 的 `defaults.baseUrl` 这个**解析接缝**上注入地址，而 `voice.module.ts` 今天填的是 `VOICE_API_BASE_URL` 环境变量；不做用户级 provider 选择、key 掩码与健康检查的 `configured` 语义（AC-141）；不做浏览器端到端（AC-142）；判据跑在替身与注入 transport 之下，**不等于**真实 DashScope 与真机浏览器（ADR-004 决策 8：真实冒烟归人工）；`qwen3.8-omni-flash` 是别名，服务端升级后行为可能漂移；白名单内两个地址之所以是那两个，是因为它们是设计文档与实验记录里出现过的形态，不是从真实 key 上跑出来的。

**8. 第二轮：fan-in suite-red 的成因与修法（AC14 + AC9 的收窄登记）。**

上一次 fan-in 的 suite 红在**两条**文件，`__PERFILE__ … passed=false` 逐条为 `server/modules/voice/tests/voice-provider-dispatch.test.ts` 与 `server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts`（`# fail 2`，两条都 `kind=assert`）；后者是前者的派生物（它的正控要在未变异的临时树上跑**前者**，前者一红它就红在 `the unmutated temp tree must pass the criterion`）。两条都不是本条的 Touches 文件，所以本条的 scoped 门（`--for-task`，只跑 Touches 里的 `*.test.*` 条目）此前是 thin 空过 —— 这条红只有全量 suite 能看见。

**成因（实测，不是推断）。** 前者是 AC-139 的判据，它用**同一个**出货 `createVoiceService` 驱动 `dashscope-omni`，而它的 `DEFAULTS.baseUrl` 是 `https://voice.example/v1` —— 本条落地后这个地址在 `dashscope-omni` 的规则之外，本的预请求闸在适配器之前（因此也在任何 `fetchBackend` 之前）拒绝它。三条断言的红逐条对得上这一个原因：`AC2 dashscope-omni / chat-audio` 读到 `calls.length === 0`（拒绝发生在发请求之前）、`AC5` 的 `NO_SPEECH_DETECTED` 驱动读到 `400`（闸的状态）而不是 `422`（适配器的码）、`AC10` 读到 `result.ok === false`。三条驱动**都**把地址放在 `createVoiceService` 的 `defaults.baseUrl` 上，与本条判据的注入接缝**同一个**（`resolveVoiceConfig` 只从 `defaults.baseUrl` 取 baseUrl，用户设置侧今天没接线 —— 那是 AC-141），所以没有可分辨的接缝能让闸只对本条生效而放过 AC-139 的用例。**故改的是那条输入，不是任何断言。**

**修法与其读数。** `DEFAULTS.baseUrl` → `https://dashscope.aliyuncs.com`（白名单内的公开主机；`'direct'` 的出厂 provider 不受规则约束，它那几条读数只跟着换了主机名，形状断言逐条不变）。

- `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch.test.ts` → **exit 0**，六条全绿，关键读数：`dispatch-request provider=dashscope-omni wire=chat-audio url=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`、`dispatch-shape-pair openai-compatible=multipart(url=https://dashscope.aliyuncs.com/audio/transcriptions) dashscope-omni=json-chat(url=…) mutually-exclusive=true`、十行 `provider-error-status`（`NO_SPEECH_DETECTED=422`）与十次 `provider-error-drive` 各回表里的值。
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts` → **exit 0**：`falsification mutation=multipart-for-every-provider exit=1`、`falsification mutation=unauthorized-row-moved exit=1`、`falsification control=exit-0 mutations=2`。
- 同目录其余四条（`voice.service` / `voiceTranscribeGaps` / `voiceHealth` / `voice-config.routes`）共 19 条用例通过。

**AC9 的收窄为何是收窄而不是豁免。** 把 `https://dashscope.aliyuncs.com` 写进 AC-139 的判据后，本条的 `host-bearers` 读数由 1 变 2（第二个 bearer 正是那个判据文件），判据 `FAIL ENDPOINT_RULE_NOT_SINGLE_COPY`。该读数原来的扫描面是「`src/**`/`shared/**`/`server/**` 下所有 `.ts`/`.tsx`」，把测试文件也算在内 —— 但**任何**驱动 `'proxy-only'` provider 的判据都必须写出一个规则接受的地址（AC6 就是「其余地址一律在适配器之前被拒」），所以「测试文件里不得出现该主机」这条读数对**本条所关于的那个 provider** 恒不可满足：它量的不是「规则是否只有一份」，而是「有没有测试敢驱动这个 provider」。收窄面因此落在**出货源**上（`isTestFile` 排除 `/tests/` 与 `*.test.ts(x)`），不变量本身未动，并且仍然可执行 —— 负对照：临时新建 `shared/__probe_host_control.ts`（内容一行注释 + `export const PROBE_HOST = "https://dashscope.aliyuncs.com"`）后判据 **exit 1**、`host-bearers=shared/__probe_host_control.ts,shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`、`endpoint-rule.single-implementation verdict=FAIL ENDPOINT_RULE_NOT_SINGLE_COPY` 且输出**指名该文件**；删掉该文件后恢复 `host-bearers=1`、`verdict=ok`、**exit 0**（`siblings=7/7 exit-0`、`elapsed-ms=2957`）。收窄前后的同一条读数都是 `host-bearers=<规则模块>`，两个读数都登记在 AC9 的登记段。

## DoD

真实落地判据：不是「多了一个字段、一个函数和一个脚本」，而是**同一个 `transcribeVoice` 在 `proxy-only` 的声明下不再碰用户填写的 baseUrl、同一个 `createVoiceService` 对白名单外的地址一次上游都不发** —— 由**执行**证明，不由段落文字声明。承重性由三件读数证明：

(a) **零请求是替身自己的计数**（AC3 的请求列表、AC6 的计数器），不是从错误码反推出来的（`asr-second-adapter-check.mjs` 的纪律：the second half is a stand-in counter, not an inference from the error code）。

(b) **白名单既是门也是墙，两侧都有对照**（AC5、AC6、AC8）：「一律拒绝」过不了 AC5 与 AC8，「一律放行」过不了 AC6，「白名单套到所有 provider 身上」过不了 AC8 —— 三种偷懒的做法各被一条正对照抓住，且每条都是读数而不是声明。

(c) **规则只有一份，且工装里没有第二份主机名单**（AC9）：判据读的是出货树里的那条规则（`rule-loosened` 变异体证明这一点），工装里的主机字面量 grep 零命中，而判据输出里那两个主机确实出现 —— 「没看」与「看了没问题」不同形。

**必须如实登记**（写进判据输出与本任务）：本条**不**把用户存的服务地址接进服务端（那是 AC-141 的词）—— 判据在 `createVoiceService` 的 `defaults.baseUrl` 这个**解析接缝**上注入地址，而 `voice.module.ts` 今天填的是 `VOICE_API_BASE_URL` 环境变量；本任务证明的是「地址一旦到达该接缝，proxy-only 的 provider 受白名单约束，direct 的 provider 不受」；不做用户级 provider 选择、key 掩码与健康检查的 `configured` 语义（AC-141）；不做浏览器端到端（AC-142）；判据跑在替身与注入 transport 之下，**不等于**真实 DashScope 与真机浏览器（ADR-004 决策 8）；`qwen3.8-omni-flash` 是别名，服务端升级后行为可能漂移；白名单内两个地址之所以是那两个，是因为它们是设计文档与实验记录里出现过的形态，不是从真实 key 上跑出来的。

L_D 该轴仍暗，理由：本任务只给能力声明加一个字段、给服务端加一道预请求拒绝、给客户端加一个按声明的分流；不新增用户数据通路，也不新增持久化结构（用户级 provider 选择与 DashScope 凭据落在 AC-141）。

L_G 该轴仍暗，理由：目标层判据（真实浏览器里经语音按钮拿到书面指令并写入 composer）还要求用户配置与浏览器端到端（AC-141/142）；本条的读数全部离线，浏览器里还没有可选的服务与可填的地址。

## Touches

- shared/asr/asrRegistry.ts
- shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts
- shared/asr/list/multimodal/multimodal.asr-provider.ts
- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- src/shared/api.ts
- server/modules/voice/voice.service.ts
- server/shared/types.ts
- scripts/asr-proxy-only-ssrf-check.mjs (new)
- scripts/asr-proxy-only-ssrf-check.test.mjs (new)
- server/modules/voice/tests/voice-provider-dispatch.test.ts (AC-139 的判据；本条只改它的输入地址与 `host-bearers` 的扫描面，见 AC14 与 AC9 的登记)
- tasks/gap-asr-proxy-only-ssrf-and-direct-path-zero.md
