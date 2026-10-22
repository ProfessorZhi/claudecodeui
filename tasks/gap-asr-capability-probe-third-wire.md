---
id: gap-asr-capability-probe-third-wire
title: AC-132 判据的线词汇表是个闭集：声明 chat-audio 的适配器被折成
  inline-json（凭证头与响应包络都按另一条线读），注册后一个正确的适配器仍必红 —— 教会探针第三条线（hold 在 AC-139 注册之后）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-proxy-provider-dispatch
goal_ac: AC-132
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不含任何被当作要求的前置；真正的前置只有 frontmatter 的 `depends_on`）：`grep -rln "^goal_ac: AC-132" tasks/*.md` 只有 `tasks/gap-asr-second-adapter-inline-only.md`（done）；本机制的关键词 `wireOf` / `credentialHeaderFor` / 「第三条线被折成 inline-json」在 `tasks/` 下零命中（立案时实测）。相邻但机制不同的是 `tasks/gap-asr-proxy-provider-dispatch.md`（`goal_ac: AC-139`）：那条把 provider 注册进 `REGISTERED` 并按 provider 分派，改的是 `shared/asr/asrRegistry.ts` 与 `server/modules/voice/voice.service.ts`；本条只改 AC-132 判据的探针本身，不碰 `shared/asr/` 与 `server/`（AC4 机械钉住）。

**缺陷一（今红，实测）。** AC-132 的 `criterion:` 逐字是 `node scripts/asr-capability-check.mjs`（26 行委托，spawn `scripts/asr-second-adapter-check.mjs`）。今天直接跑，退出 1，唯一一条 FAIL：

    FAIL ADAPTER_UNRESOLVED: shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts declares id 'undefined' but the registry does not resolve it: no ASR adapter is registered for provider id 'undefined'

它是本轮的**新红**，不是旧账：`.quay/gate-events.jsonl` 里 AC-132 自 2026-09-23T21:23:15Z 到 2026-09-24T02:25:04Z 连续六次 sweep `verdict=pass`（`criterionHash` 恒为 `a8cc240093dc2b11`），2026-09-24T03:33:14Z 首次 `fail`；而 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 由 `faae6e25`（2026-09-24T03:10:45Z）落入 —— 首次红在模块落地 22 分钟后。该模块今天只导出提示词常量（`PROMPT_VERSION` / `ROLE` / `RULES` / `EXAMPLES` / `JSON_TASK` / `REASONING_EFFORT` / `DEFAULT_MODEL`），没有 `id`、`capabilities`、`transcribe`，所以探针枚举到它时 `providerModule.id` 是 `undefined`，`registry.resolve(undefined)` 抛错。

**这一半不是本任务的活。** 把 `id` / `capabilities` / `transcribe` 补进模块属 AC-138 的任务，把它注册进 `REGISTERED` 属 AC-139 的任务 —— 而后者自己的 AC8 逐字要求 `node scripts/asr-second-adapter-check.mjs` 退出 0。所以本条 **hold** 在它之后（frontmatter `depends_on`），不重做注册；并跑会让两个 worker 同时动同一批声明文件，而本任务的被测输入在对方落地前根本不存在：探针只对被 `resolve()` 出来的适配器跑用例。

**缺陷二（注册之后仍会红 —— 这是本条存在的理由）。** 探针的线词汇表是个**闭集**，源文件实测（行号为今天的位置）：

| 位置 | 今天的行为 | 对声明 `chat-audio` 的适配器的后果 |
|---|---|---|
| `wireOf` (:343) | `adapter.wire === 'multipart' ? 'multipart' : 'inline-json'` | 第三条线被当成 `inline-json` 走完全部用例 |
| `credentialHeaderFor` (:218) | `wire === 'multipart' ? 'authorization' : 'x-goog-api-key'` | 向一条 `Authorization: Bearer` 的线索要 `x-goog-api-key` ⇒ `CREDENTIAL_NOT_ON_WIRE`；`authorization` 又被判成「这条线没有声明的头」⇒ `UNEXPECTED_CREDENTIAL_HEADER` |
| `responseCases` (:510) 与 `ENVELOPE_BODY` (:482) | 非 multipart 一律发 `{"candidates":[{"content":{"parts":[…]}}]}` | 而 `chat-audio` 的答案是 `choices[0].message.content`，解析不出 ⇒ `response-envelope` 那条期望 `ok:true` ⇒ `ENVELOPE_NOT_READ` |
| `measuredBytes` (:360) / `oversizeAudioBytes` (:370) / `affordableAudioBytes` (:381) | 只有「按编码」与「按自身字节」两种算术 | 第三条线的超限/预算输入是否落在正确的一侧，没有由声明推出的读数 |

也就是说：**一个完全正确的** `chat-audio` 适配器注册进来，AC-132 的判据依然非零，红在探针不认识第三条线，而不红在被测行为。这恰好与探针自己的设计声明相违（文件头原文）：

> EVERY CASE IS DRIVEN PER WIRE … the case inputs and expectations are derived from that declaration … The declaration is therefore a second thing under test.

**做法。** 让探针的线词汇表跟着 `AsrWire` 走：为第三条线补上它自己的 (a) 预算算术、(b)「一个良构答案」的包络体、(c) 凭证头名、(d) 录音在请求体里的标记形态，四者都由**适配器声明的 `wire`** 决定，不由 provider id 决定（AC2 机械钉住探针里没有 provider 名字面量）。不新增线成员、不改 `AsrWire`（那是 AC-138 在 `shared/asr/asrRegistry.ts` 的那一行）；探针只消费它。

**边界（不做）。** 不注册 provider、不改 `shared/asr/**`、不改 `server/**`（AC-138 / AC-139 / AC-140 / AC-141 的范围）；不改 `goals/` 下任何记录；不新增判据文件、不改 AC-132 的 `criterion:` 名字、不把读数搬进委托；不改窄任何既有检查；不联网。

**承重性**：真实落地不是「探针多了一个分支」，而是**同一个判据在第三条线上给出与被测适配器声明一致的读数，且这三条读数各自可被一个可执行取假形态打红**（AC3）。只有 AC1 绿与 AC3 全红的组合，才能把「教了第三条线」与「把用例跳过」区分开。

## AC

- [x] AC1 判据恢复绿，且绿在第三条线自己的读数上：`node scripts/asr-capability-check.mjs` 退出 0，输出逐字含 `registered-count value=3`、`dashscope-omni:wire value=chat-audio`、`dashscope-omni:credential.header-name value=authorization`、`dashscope-omni:credential.on-the-wire value=true`、`dashscope-omni:credential.stray-header value=false`、`dashscope-omni:oversize-calls value=0`、`dashscope-omni:budget-audio-alone-calls value=1`、`dashscope-omni:response-envelope-ok value=true`、`dashscope-omni:response-non-envelope-json-ok value=false`、`dashscope-omni:response-non-json-ok value=false`；输出不含 `FAIL` 与 `EMPTY_READING`；`dashscope-omni:` 前缀的读数条数不低于同一输出里 `multimodal:` 的条数（不许靠少跑用例变绿）。`diff <(node scripts/asr-capability-check.mjs) <(node scripts/asr-second-adapter-check.mjs)` 退出 0（委托关系与逐字节 stdout 不变）。
- [x] AC2 线的用例由**声明**决定，不由 provider 名决定：`grep -c 'dashscope-omni' scripts/asr-second-adapter-check.mjs` 为 0，且 `grep -c 'chat-audio' scripts/asr-second-adapter-check.mjs` 不小于 1；阳性对照是 AC1 里 `dashscope-omni:wire` 的值逐字等于出货适配器模块导出的 `wire`（用 `node --input-type=module` 读 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 的 `wire` 与该读数比对，两者必须相等 —— 一个把线写死在探针里的实现过不了这一对）。
- [x] AC3 两条取假形态是可执行用例，各先跑未变异树：`node --test scripts/asr-second-adapter-check.test.mjs` 退出 0，其中新增两条用例的 fixture 均由**出货文件**运行期复制到临时树后再变异：(1) `third-wire-declared-as-inline` —— 把 fixture 里第三条线适配器的声明 `wire` 改成 `'inline-json'` 而它的请求体不变 ⇒ 必须非零退出，且输出含 `CREDENTIAL_NOT_ON_WIRE`、`UNEXPECTED_CREDENTIAL_HEADER`、`ENVELOPE_NOT_READ`、`CASE_INPUT_STALE` 四者中至少一个（探针按声明推出的输入与它实际发的东西不一致）；(2) `third-wire-not-modelled` —— 用**修前形态**的探针（线判定退回闭集折叠）对**未变异**的同一 fixture 跑 ⇒ 必须非零退出且输出含 `CREDENTIAL_NOT_ON_WIRE` 与 `ENVELOPE_NOT_READ`。两条各自先要求未变异的同一 fixture 退出 0。实现提示（立案时已核）：变异后的探针副本必须放在**仓内**（ESM 从文件自身目录向上解析裸说明符，放进 `os.tmpdir()` 的副本加载不了 `tsx/esm/api`），且静态门之前必须删除。
- [x] AC4 不碰原因那一侧：`git diff --name-only develop -- shared/asr server goals` 输出为空；`git diff --name-only develop -- scripts/` 只含本任务 Touches 里的那两个脚本。
- [x] AC5 既有两条线的读数不动、邻居探针不红：`node scripts/asr-second-adapter-check.mjs` 的输出里逐字含 `multimodal:wire value=inline-json`、`openai-compatible:wire value=multipart`、`multimodal:credential.header-name value=x-goog-api-key`、`openai-compatible:credential.header-name value=authorization`、`multimodal:oversize-calls value=0`、`openai-compatible:oversize-calls value=0`、`multimodal:budget-audio-alone-calls value=1`、`openai-compatible:budget-audio-alone-calls value=1`（教第三条线不得以重新解释前两条线为代价）；且 `node scripts/asr-contract-invariants-check.mjs`、`node scripts/asr-mime-size-gaps-check.mjs`、`node scripts/asr-health-provider-check.mjs`、`node scripts/asr-pause-cues-source-check.mjs` 四条各退出 0。若某条因第三条线而红，修的是探针里那条线的映射，**不得**改窄这些检查。
- [x] AC6 静态门：`npm run typecheck` 退出 0（根、`server/tsconfig.json`、`scripts/tsconfig.json` 三套；`scripts/*.mjs` 也在第三套下）；`npm run lint` 退出 0（`npx oxlint` 裸跑在本仓本就非零，不是这条的门）。
- [x] AC7 如实登记：完成记录写明修前读数（`ADAPTER_UNRESOLVED` 那条 FAIL；以及注册后会出现的 `CREDENTIAL_NOT_ON_WIRE` / `UNEXPECTED_CREDENTIAL_HEADER` / `ENVELOPE_NOT_READ` 三项及各自在探针里的位置），写明「本条不注册 provider、不改 `shared/asr/**` 与 `server/**`（AC-138 / AC-139 的范围）」「AC-132 的 `criterion:` 仍是 `node scripts/asr-capability-check.mjs`，委托与逐字节 stdout 关系未变」，以及「判据跑在替身 transport 下、`globalThis.fetch` 被换成毒药，未接触真实 DashScope（ADR-004 决策 8：真实冒烟归人工）」。

## DoD

真实落地判据：不是「探针多了一个 `chat-audio` 分支」，而是**同一个判据在第三条线上给出与被测适配器声明一致的读数，并且这三条读数各自可被一个可执行取假形态打红**。三条承重读数：

(a) AC1 的 `dashscope-omni:` 行是**计数器与声明**，不是从错误码反推：超限零请求读的是替身计数器的值；`credential.header-name` 是 `authorization`（由声明推出，而不是 `x-goog-api-key`）；`response-envelope-ok` 是这条线自己的答案体被读懂了。

(b) AC3 的两条取假形态各先跑未变异树 —— 一个恒红或被跳过的判据过不了它自己的正向控制；其中 `third-wire-not-modelled` 就是**修前形态**，它必须红，才说明 AC1 的绿是修复换来的。

(c) AC5 的既有两条线读数逐字不动、四条邻居探针仍绿 —— 「教第三条线」不能以重新解释前两条线或改窄检查为代价。

**必须如实登记**：本任务不注册 provider、不改 `shared/asr/**` 与 `server/**`（AC-138 / AC-139 的范围）；不改 `goals/` 记录；判据跑在 Node 与替身上游下，不等于真实 DashScope。

L_D 该轴仍暗，理由：本任务只让既有判据认识一条新的请求形状，不新增用户数据通路或数据结构（provider 注册与分派在 AC-139，用户凭据与设置通路在 AC-141）。

L_G 该轴仍暗，理由：目标层判据（口述经服务端代理产出书面指令并写入 composer）要求适配器先被注册、服务端按 provider 分派；本任务不改 `shared/asr/**` 与 `server/**`，目标层行为在本任务前后不变。

## Touches

- scripts/asr-second-adapter-check.mjs
- scripts/asr-second-adapter-check.test.mjs
- tasks/gap-asr-capability-probe-third-wire.md

## 完成记录

**本条做了什么。** AC-132 判据的探针 `scripts/asr-second-adapter-check.mjs` 不再把「非 multipart 一律折成 `inline-json`」：线词汇表现在是一张表 `WIRE_MODELS`（:254），**一条声明一行**，每行四个字段 —— `credentialHeader` / `audioCharge`（`'raw' | 'encoded'`）/ `audioMarker`（`'file-part' | 'encoded'`）/ `wellFormedAnswer()`。四条读数 —— (a) 预算算术、(b)「一个良构答案」的包络体、(c) 凭证头名、(d) 录音在请求体里的标记形态 —— 全部由**适配器声明的 `wire`** 推出，不由 provider id 推出（AC2 机械钉住：探针里 `dashscope-omni` 零命中）。`wireOf`（:464）现在只是透传：声明缺席时仍是 `'inline-json'`（出厂默认未变），但声明了什么就返回什么；表里没有的行**不折成别的行**，而是报 `WIRE_NOT_MODELLED`（:694）—— 一个探针没有模型的声明，不得被按有模型的那条线打分。不新增线成员、不改 `AsrWire`；不改 `shared/asr/**` 与 `server/**`。

**修前读数（实测，逐字）。** 两段，分别是本任务之前、以及注册之后被判据读到的红：

(1) 立案时的红（模块已落地、尚未注册）：`node scripts/asr-capability-check.mjs` 退出 1，唯一 FAIL ——

    FAIL ADAPTER_UNRESOLVED: shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts declares id 'undefined' but the registry does not resolve it: no ASR adapter is registered for provider id 'undefined'

这一半不是本条的活（补 `id`/`capabilities`/`transcribe` 属 AC-138、注册属 AC-139），本条 hold 在其后。

(2) 注册之后、**修前探针仍红**（本条存在的理由）。用修前的闭集折叠（`return adapter.wire === 'multipart' ? 'multipart' : 'inline-json';`）对**未变异**的出货 fixture 跑，退出 1，五条 FAIL：

    FAIL AUDIO_ALONE_REFUSED: 'dashscope-omni': an audio well inside the budget was not sent ({"ok":false,"code":"UPSTREAM_ERROR","text":null}, 1 call(s)) — the pair below can only show the budget is request-level if this half is accepted
    FAIL UNHONORED_HINT_COUNTED_AGAINST_BUDGET: 'dashscope-omni': the same audio that was accepted alone returned {"ok":false,"code":"UPSTREAM_ERROR","text":null} once a context the declaration does not acknowledge joined it (1 call(s)) — an unacknowledged hint is left off the wire, so it cannot be what pushes a request over the budget
    FAIL CREDENTIAL_NOT_ON_WIRE: 'dashscope-omni': a configured key is not on the request under 'x-goog-api-key', the header this wire declares — such a request is refused before its body is read
    FAIL UNEXPECTED_CREDENTIAL_HEADER: 'dashscope-omni': the request announces the credential in 'authorization', which the 'inline-json' wire does not declare — the credential has one declared home per wire
    FAIL ENVELOPE_NOT_READ: 'dashscope-omni' response-envelope: a well-formed answer read as {"ok":false,"code":"UPSTREAM_ERROR","text":null} instead of 'hello world'

AC7 点名的那三项在**修前探针**里的位置与机理：`credentialHeaderFor`（立案时 :218，`wire === 'multipart' ? 'authorization' : 'x-goog-api-key'`）向一条 `Authorization: Bearer` 的线索要 `x-goog-api-key` ⇒ `CREDENTIAL_NOT_ON_WIRE`；同一请求上真实存在的 `authorization` 又被判成「这条线没声明的头」⇒ `UNEXPECTED_CREDENTIAL_HEADER`；`responseCases`（立案时 :510）配 `ENVELOPE_BODY`（立案时 :482）对非 multipart 一律发 `{"candidates":[{"content":{"parts":[…]}}]}`，而这条线的答案是 `choices[0].message.content`，解析不出 ⇒ `ENVELOPE_NOT_READ`。头两条 `AUDIO_ALONE_REFUSED` / `UNHONORED_HINT_COUNTED_AGAINST_BUDGET` 是同一原因的**次生**读数：替身按错的包络作答（`UPSTREAM_ERROR`），于是「预算内、本该被接受」的那一次读成了拒绝。修后同一个未变异 fixture 退出 0。

**边界与如实登记。**
- 本条**不注册 provider**、**不改 `shared/asr/**` 与 `server/**`**（AC-138 / AC-139 的范围），不改 `goals/` 下任何记录。AC4 机械钉住：`git diff --name-only develop -- shared/asr server goals` 输出为空；`-- scripts/` 只有本任务 Touches 里的两个脚本。
- AC-132 的 `criterion:` **仍是** `node scripts/asr-capability-check.mjs`（26 行委托，spawn 探针）：`diff <(node scripts/asr-capability-check.mjs) <(node scripts/asr-second-adapter-check.mjs)` 退出 0，逐字节 stdout 关系未变。
- 判据跑在**替身 transport** 下、`globalThis.fetch` 被换成毒药，**未接触真实 DashScope**（ADR-004 决策 8：真实冒烟归人工）。
- 教第三条线不以重新解释前两条线为代价：`multimodal:wire value=inline-json` / `openai-compatible:wire value=multipart` / 两条线的 `credential.header-name`（`x-goog-api-key` 与 `authorization`）/ 两条线的 `oversize-calls value=0` / 两条线的 `budget-audio-alone-calls value=1` 共八条读数逐字不动。
- `chat-audio` 行有一处**故意不建模**的量：这条线的请求里还带一段冻结提示词（~3 KB UTF-8），而本行的 `audioCharge: 'encoded'` 只按音频自身编码后的长度计费。这是行内注释里登记的上界近似，不是遗漏 —— AC1 的 `budget-audio-alone-calls value=1` 与 `oversize-calls value=0` 两个读数正是在这个近似下取到的（预算内 5898240 B → 7864320 B 在 10 MB 预算内；超限 7864323 B → 10485764 B 在其外），两侧都站得住。

**读数（本工作树，全部实测）。**

| 命令 | 结果 |
|---|---|
| `node scripts/asr-capability-check.mjs` | 退出 0；`FAIL` 0 条、`EMPTY_READING` 0 条；十条要求字符串逐字命中；`dashscope-omni:` 读数 43 条 = `multimodal:` 43 条（未靠少跑用例变绿） |
| `diff <(node scripts/asr-capability-check.mjs) <(node scripts/asr-second-adapter-check.mjs)` | 退出 0（stdout 逐字节相同；stderr 里 tsx 的 `NO_COLOR`/`FORCE_COLOR` 警告带 pid，不被进程替换捕获） |
| `grep -c 'dashscope-omni'` / `grep -c 'chat-audio'`（对探针） | 0 / 2 |
| 阳性对照：`node --input-type=module` 读出货模块 `wire` | `module.wire="chat-audio"`，与读数 `dashscope-omni:wire value=chat-audio` 逐字相等 |
| `node --test scripts/asr-second-adapter-check.test.mjs` | 退出 0；`tests 12 / pass 12 / fail 0`；新增 `third-wire-declared-as-inline` 与 `third-wire-not-modelled` 各绿，且每条先要求未变异 fixture 退出 0 |
| 四个邻居探针 | `asr-contract-invariants-check.mjs` / `asr-mime-size-gaps-check.mjs` / `asr-health-provider-check.mjs` / `asr-pause-cues-source-check.mjs` 各退出 0 |
| `npm run typecheck` | 退出 0（根 + `server/tsconfig.json` + `scripts/tsconfig.json`） |
| `npm run lint` | 退出 0（只有既有 warning；`npx oxlint` 裸跑非零不是本条的门） |
| `bash scripts/test.sh --for-task gap-asr-capability-probe-third-wire --allow-thin` | 退出 0，前序 `suite-scope-check: PASS`；`no scoped test files … (thin)` —— scoped 门槛的 awk 正则 `\.test\.[jt]sx?$` 不收 `.mjs`，本条用例由上面的 `node --test` 直接读数与全量 suite 的 `npm run test:scripts` 覆盖 |
| `git merge --no-edit develop` | 干净合并；develop 在本条期间前进一拍（`25d0a65d goals: AC-139 status active→achieved`），故上述读数在合并后重跑 |
| `worker-driver.js --write-scoped-gate-cache --develop-sha "$(git rev-parse develop)"` | `scoped-gate-cache-written`，`developSha=25d0a65d983dbb1bc16e8400fcae72c6b3bc5185` |

**AC3 的两条取假形态（可执行，各先跑未变异树）。** `third-wire-declared-as-inline`：把 fixture 里第三条线适配器的 `export const wire: AsrWire = 'chat-audio';` **只改成** `'inline-json'`（请求体一字不动）⇒ 非零退出，命中的是 `^FAIL (CREDENTIAL_NOT_ON_WIRE|UNEXPECTED_CREDENTIAL_HEADER|ENVELOPE_NOT_READ|CASE_INPUT_STALE):` 之一 —— 即「探针按声明推出的输入与它实际发的东西不一致」，而这正是折叠给每一条第三线适配器同时制造的缺陷。`third-wire-not-modelled`：用**修前形态**的探针（线判定退回闭集折叠）对同一未变异 fixture 跑 ⇒ 非零退出，且 `CREDENTIAL_NOT_ON_WIRE` 与 `ENVELOPE_NOT_READ` 两条都命中（上面第 (2) 段逐字列出了它们）；若这一对哪天不再命中，就说明 AC1 的绿不是靠教会探针一个形状买来的。变异后的探针副本写在**仓内**（`scripts/.probe-mutant-*`；ESM 从文件自身目录向上解析裸说明符，放进 `os.tmpdir()` 的副本找不到 `tsx/esm/api`，它的红就会归因于副本位置而非变异），用例结束即删、文件名不含 `.test.` 段，静态门之前已确认工作树干净。criterion 文件本身保持零子进程。
