---
id: gap-debug-agent-engine-and-scenario-ops
title: 调试 Agent 的产出引擎与 provider：写真实形态 transcript，帧只来自真实归一化（运行期 provider id，不进
  LLMProvider 联合）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-124
---
## Proposal

**交付物：调试 Agent 的产出引擎与其 provider 实现（不含控制面、不含门控的结构性关闭、不含外部写入判据、不含词表守卫、不含 fixture 清理顺序——各有独立任务）。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md`（2026-09-22 评审通过，见其 Adjudication 小节）的决策 1/2/4/7 与「场景文档 schema」一节，在 `server/modules/debug-agent/` 下实现：场景文档的 schema 与校验（`version: 1`；`dialect` / `home` / `transcript.mode` 三个**闭集**，取值不认识时**拒绝装载**而不猜测；`steps[].at` 为绝对毫秒且非降序；`op` 闭集 `row` / `grow` / `scroll` / `wait`）、方言行构造器、产出引擎、以及一个以**运行期 id** 注册的 provider。

**为什么需要它。** 排查 transcript 贴底/流式增量这类「输入输出形状」的问题时，今天没有可控的复现手段：能端到端产生一次真实输出的路径只有一条——拉起真 CLI 进程，行什么时候出现、一次吐多少字节、中间隔多久全由模型与网络决定。既有的浏览器侧替身（`e2e/transcript-follow.spec.ts` 的 `installWireDouble` / `__injectStreamFrame`）只替换 `window.WebSocket`、只注入 `stream_delta` / `stream_end`，**完全跳过后端**：runtime、按 provider 的归一化、`seq` 与重放、`complete` 触发的 REST 重取都不在链路上。

**承重设计（三条，均来自 ADR 决策，不得偏离）。**

1. **引擎在后端，且只有一份**（决策 1）。产出必须经过真实 runtime 与真实归一化，所以任何跑在浏览器里的引擎都必然是第二套实现；两个面（应用内 Agent / dev-only 控制面）共用的必须是这同一个引擎。
2. **运行期 provider id，刻意不进 `LLMProvider` 联合**（决策 2）。`provider.registry.ts` 的解析入口签名本就接受 `string`；不合法的只是**读**侧那些把 `string` 喂给期望 `LLMProvider` 的映射，做法是一次显式 id cast。按评审**裁决 A**，UI 上必须给它**明确的显示身份**——`PROVIDER_LABELS` 放宽并加一键、`LLMProviderLogo` 在落穿链之前插入该 id 的判断。不接受被落穿显示为 Claude：那不是「无从区分」，是**冒名**。
3. **必须写真实形态 transcript，帧只能来自真实归一化**（决策 4）。`complete` 会触发一次 REST 重取；只发帧不落盘的实现会让实时所见与历史分叉，而「实时与历史不一致」正是本机制要排查的那类缺陷的同族——一个自己就会制造这类不一致的工具不能用来排查这类缺陷。

**方言行的形状**（这是本任务**唯一**应当随 claude 方言变化的东西，也是它与「第二套词表」的分界）：一行 = 一个 JSON 对象，`{ type, uuid, parentUuid, sessionId, cwd, timestamp, message: { role, content: [{ type: 'text', text }] } }`，追加写入 `~/.claude/projects/<bucket>/<session-id>.jsonl`；标题行 `{ type: 'custom-title', sessionId, cwd, timestamp, customTitle }`。行内的 `sessionId` 与 `cwd` 是索引器唯一的信息来源（缺任一则该文件不被索引），`uuid` 决定归一化后的消息 id。

**`row` 与 `grow` 的分界（最容易写错的一处）**：`row` 改变**行数**（N→N+1，带**新** uuid），`grow` **不改变行数**、只改变**字节数**（重写末行、**保** uuid ⇒ 归一化后是同一条消息 id 的内容变化）。任何只数行数的断言对 `grow` 完全失明，而「就地增长」恰恰是流式输出最常见的形状。

**本任务不做**：不实现控制面 HTTP 路由；不实现「关闭即结构性不存在」的三面断言；不实现外部写入路径的判据；不实现静态词表守卫；不做 fixture 的清理顺序与真实 home 断言。以上各有独立任务。不新增任何阈值——几何/时间类数字由运行导出或写成区间。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「调试 Agent / 合成 provider / 场景引擎 / 方言行 / 假 CLI」检索无命中。相邻但机制不同的是 `gap-claude-runtime-frame-forwarding-coverage`（真实 runtime 的转发覆盖）与 `gap-transcript-follow-*` 家族（贴底跟随的触发面）：前者不涉及合成产出源，后者按评审裁决 C 明确**不由**本机制承担（该缺陷已有 GOAL-004 与一条 ready 任务两个占位者）。

## Plan

1. **schema 与校验先行**：三个闭集取值不认识时拒绝装载并给出可读原因；`steps[].at` 非降序违例也拒绝。
2. **方言行构造器只构造行**——源码内**不出现任何帧字段名或事件名**（该边界由词表守卫任务独立把守，本任务先做到不违反）。
3. **provider 的 `sessions` 面复用真实 claude 实现**（`normalizeMessage` 就在那里），只有 `runtime` 是本任务新写的面；这样「调试 Agent 与产品对同一条方言行产出同一个帧」是**复用**而非承诺。
4. **引擎按场景时钟执行步骤**：`row` / `grow` 先落盘，再把**那一行**交给 `context.normalizeMessage`，转发其**全部**输出。
5. **自检块从产物回读评估**（行数、字节数、`mustContain`、`lastRowGrew`），**不复用**引擎的自述——自检的意义就是能与引擎不一致。
6. 索引与寻址：arms 一个场景时先写下种子行（用户行 + 标题行）并触发一次索引，使该会话在驱动它之前就是**可列、可选中、可对话**的。

## AC

- [x] AC1 引擎与 provider 的判据——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts` 退出码 0。该用例即 `goals/AC-124`：装载含 `row` 与 `grow` 两种 op 的场景，断言 (a) transcript 确实落盘且行数与 `expect.rows.delta` 相符、文件内含 `expect.content.mustContain` 每一条；(b) `grow` 使行数不变、末行字节数增加、且归一化为**同一**消息 id 的内容变化；(c) socket 收到的帧 id 集合与 REST 重取（`/api/providers/sessions/:id/messages`）历史的 id 集合之交集，**覆盖本次产出的每一条消息**；(d) 帧上的 `seq` 由 run registry 分配且严格递增。打印四项实际读数。
- [x] AC2 抗假变体（**真跑并留输出**）：**frames-only** —— 让引擎只发帧、不写 transcript（帧仍由真实 helper 产出，客户端看不出区别）。`AC1` 的命令必须因此**退出码非 0**，且红因是「磁盘零行 / 历史缺消息」而非别的。跑完用 `git checkout --` 还原，`git status` 干净，并贴两次输出。
- [x] AC3 provider 以**运行期 id** 注册且不进联合：门控开启时按该 id 解析成功、`listProviders()` 的 id 集合包含它；门控关闭时解析失败，且失败与**拼错一个 id 逐字相同**（同 code、同 message 形态）。命令打印两侧实际读数。取假形态：把它加进 `LLMProvider` 联合会让本判据的「不进联合」半失效——故本判据同时断言 `server/shared/types.ts` 的联合定义行未改动。
- [x] AC4 显示身份（评审**裁决 A**）：侧栏会话行视图的提供商文字位**非空且不是 "Claude"**；`LLMProviderLogo` 对该 id 不落穿到末尾的 claude 分支。命令对一处构造出的会话视图断言并打印实际标签。取假形态：不给它显示身份（保持落穿）时本判据必须红。
- [x] AC5 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到本任务 Touches 内的一条；命中 Touches 之外时逐行打印并以非 0 退出。用 merge-base 而非裸 develop——develop 会随他人 fan-in 前进。

## DoD

真实落地判据（不是「模块存在」）：**在一个真实运行的服务上，驱动一次调试 Agent 的场景，产出的帧必须与它写下的 transcript 逐 id 对得上。** 承重性由三件事正面证明：

(a) **实时与历史一致是实测的，不是推断的**——AC1(c) 的交集断言必须覆盖本次产出的每一条消息；只断言「收到帧」或只断言「文件有行」各自都挡不住另一半（前者对 frames-only 放行，后者对「写了但没发」放行）；
(b) **抗假变体真跑过**（AC2），且红因就是该变体的定义特征；
(c) **`row` 与 `grow` 的分界被正面区分**——AC1(b) 的「同一消息 id 内容变化」与 AC1(a) 的「行数 delta」在同一次运行里同时成立，证明两者没有被实现成同一种东西。

另需如实登记：`grow` **产不出 `stream_delta`**（该帧只由 SDK 实时形状产出、从不落 transcript；见 `adr/ADR-003-验证记录.md` 的 e）。本任务**不得**为了制造 delta 形状而绕过归一化——那是决策 7 明令禁止的第二套词表。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制本身，不改变产品领域能力，因此没有可读出的产品领域读数；判定面由 AC1 的四项机械读数与抗假变体承担。
L_G 本目标的判据是 `goals/AC-124`（产出写真实 transcript 且实时与 REST 重取逐 id 一致），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。

## Touches

- server/modules/debug-agent/index.ts (new)
- server/modules/debug-agent/debug-agent.scenario.ts (new)
- server/modules/debug-agent/debug-agent.engine.ts (new)
- server/modules/debug-agent/debug-agent.runtime.ts (new)
- server/modules/debug-agent/debug-agent.provider.ts (new)
- server/modules/debug-agent/debug-agent.gate.ts (new)
- server/modules/debug-agent/tests/debug-agent-frames.test.ts (new)
- server/modules/providers/provider.registry.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/services/session-synchronizer.service.ts
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- src/shared/ui/LLMProviderLogo.tsx
- src/modules/sidebar/tests/debugAgentIdentity.test.tsx (new)
- tasks/gap-debug-agent-engine-and-scenario-ops.md

## Evidence

AC1 —— 判据命令在最终树（commit c05f4fd4）上的读数，退出码 0：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts
[AC1(a) rows] file 2 -> 4 rows, delta 2 (expected 2); missing content []
[AC1(b) grow] 1 grow(s); steps[1] rows 3->3, last row 390->436 bytes, id "a60b818b-1efe-49f0-a3dc-cf8d1e3037e7_0"->"a60b818b-1efe-49f0-a3dc-cf8d1e3037e7_0", content changed=true; lastRowGrew=true
[AC1(c) ids] produced ["a60b818b-1efe-49f0-a3dc-cf8d1e3037e7_0","74cf786b-6f64-44e7-a7da-f156dac7fa3e_text_0"] from 2 written row(s); frames carrying a message ["a60b818b-1efe-49f0-a3dc-cf8d1e3037e7_0","74cf786b-6f64-44e7-a7da-f156dac7fa3e_text_0"] (+1 end marker frame(s) carrying none); history ["5514f5ce-92f5-4523-bd33-4df63e902edc_text_0","a60b818b-1efe-49f0-a3dc-cf8d1e3037e7_0","74cf786b-6f64-44e7-a7da-f156dac7fa3e_text_0"] (3 message(s), total 3); intersection ["a60b818b-1efe-49f0-a3dc-cf8d1e3037e7_0","74cf786b-6f64-44e7-a7da-f156dac7fa3e_text_0"]; missing from frames []; missing from history []; frames not in history []; seed ids missing from history []
[AC1(d) seq] [1,2,3,4]; first non-increasing: none
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

读法：本行产出的 2 条消息（行 3 的 assistant 行、行 4 的 user 行）在 socket 帧、磁盘 transcript、REST 重取历史三处逐 id 相同；`grow` 那一步行数 3→3、末行 390→436 字节、消息 id 不变而内容变了 —— (a)(b) 的分界在同一次运行里同时成立。种子行（`..._text_0` 那条 user 行）只出现在历史里，是让三方集合不会「因全空而一致」的对照。

AC2 —— frames-only 变体（引擎只 `forward(row)`、删掉 `appendTranscriptRow`；`grow` 改为只读末行不重写）。同一命令：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts
[AC1(a) rows] file 2 -> 2 rows, delta 0 (expected 2); missing content ["the third one is still being written out","what about the migration guide?"]
[AC1(c) ids] produced [] from 0 written row(s); frames carrying a message [...3 ids...]; history ["b1be7eb5-7c2a-476e-aa02-2f909401ea28_text_0"] (1 message(s), total 1); frames not in history ["8a89912e-1612-4b66-be52-b22d42cd79b8_0","58aa58f7-35e3-4b85-8df7-446e036b0fb8_text_0"]
[AC1(d) seq] [1,2,3,4]; first non-increasing: none
ℹ pass 1
ℹ fail 1
  AssertionError [ERR_ASSERTION]: 磁盘零行: the run wrote 0 row(s) (2 -> 2 on disk); the scenario expects 2
--- 退出码 1
```

AC2 —— 第二个变体（落盘正确，但同一条消息又以一个新 uuid 多转发一次：socket 上出现历史永远不会有的消息）。同一命令：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts
[AC1(c) ids] produced ["5e0b31fd-b99d-4351-8b95-54ea7ca7ee50_0","33c8e7aa-365f-4edc-9582-54be4028ecc3_text_0"] from 2 written row(s); frames carrying a message [...4 ids...]; history ["faf755f0-8f09-4eec-aa80-1afb6f697b93_text_0","5e0b31fd-b99d-4351-8b95-54ea7ca7ee50_0","33c8e7aa-365f-4edc-9582-54be4028ecc3_text_0"] (3 message(s), total 3); missing from frames []; missing from history []; frames not in history ["bfce8480-1f54-4c03-ac4a-a27f1fab8c62_0","bc23e86d-151c-402f-ab60-9db87e5ec3be_text_0"]
ℹ pass 1
ℹ fail 1
  AssertionError [ERR_ASSERTION]: 历史缺消息: a frame reached the socket that the REST read does not contain (["bfce8480-1f54-4c03-ac4a-a27f1fab8c62_0","bc23e86d-151c-402f-ab60-9db87e5ec3be_text_0"])
--- 退出码 1
```

两次变体各走一次「两半」：只发帧挡在 `磁盘零行`，写了但多发了历史里没有的消息挡在 `历史缺消息`。还原与树状态（`git checkout -- server/modules/debug-agent/debug-agent.engine.ts` 之后）：

```
$ git checkout -- server/modules/debug-agent/debug-agent.engine.ts
$ git status --porcelain
（无输出）
```

AC3 —— 门控两侧的实际读数（同一 `frames` 用例的子进程模式打印）：

```
--- gate open ---
[gate] OPEN (DEBUG_AGENT="on" with DEBUG_AGENT_HOME=".../fixture")
[ids] ["claude","codex","cursor","opencode","debug"]
[resolve('debug')] resolved -> debug
[resolve('claud')] AppError/UNSUPPORTED_PROVIDER/400
--- gate closed ---
[gate] CLOSED (DEBUG_AGENT is unset); home=<none>
[ids] ["claude","codex","cursor","opencode"]
[resolve('debug')] AppError/UNSUPPORTED_PROVIDER/400
[resolve('claud')] AppError/UNSUPPORTED_PROVIDER/400
[normalized] debug="Unsupported provider \"<id>\"." typo="Unsupported provider \"<id>\"."
[union] server/shared/types.ts: export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';
```

关闭态的 debug 与拼错 id 在把请求的 id 抹掉之后逐字相同（同 error class、同 code、同 statusCode）；联合定义行按本判据断言未改动。

AC4 —— 显示身份（`npx vitest run src/modules/sidebar/tests/debugAgentIdentity.test.tsx`，3 tests passed）：

```
[AC4] session row provider text slot for provider="debug": rendered "Debug Agent session", label "Debug Agent"
[AC4] control — provider="claud" renders the slot as " session"
[AC4] LLMProviderLogo mark for provider="debug": aria-label "Debug Agent", 475 chars (claude's: 2381, unrecognised provider's: 2381)
```

对照即取假形态：没有词条时该文字位渲染成空串、未识别 id 仍然落穿成 claude 的图（2381 chars == claude 的 2381 chars），所以「不落穿」这句是被证明的而不是被假设的。

AC5 —— 每个改动文件都在 Touches 内（`git diff --name-only "$(git merge-base develop HEAD)"`，base=13149f4f；本任务新增了 `src/modules/sidebar/tests/debugAgentIdentity.test.tsx` 一条 Touches 后才转绿）：

```
OK   server/modules/debug-agent/debug-agent.engine.ts
OK   server/modules/debug-agent/debug-agent.provider.ts
OK   server/modules/debug-agent/debug-agent.runtime.ts
OK   server/modules/debug-agent/debug-agent.scenario.ts
OK   server/modules/debug-agent/index.ts
OK   server/modules/debug-agent/tests/debug-agent-frames.test.ts
OK   server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
OK   server/modules/providers/provider.registry.ts
OK   server/modules/providers/services/session-synchronizer.service.ts
OK   src/modules/sidebar/tests/debugAgentIdentity.test.tsx
OK   src/modules/sidebar/utils/sidebarProjectFormatting.ts
OK   src/shared/ui/LLMProviderLogo.tsx
--- verdict ---
PASS: every changed file is declared in ## Touches
```

未加该条 Touches 前，同一检查对 `src/modules/sidebar/tests/debugAgentIdentity.test.tsx` 打印 `MISS` 并以 1 退出 —— 检查本身是会红的，不是恒真。

另：`npm run lint` 在改动文件上零告警零错误；`tsc --noEmit` 对 `tsconfig.json` 与 `server/tsconfig.json` 均退出 0。
