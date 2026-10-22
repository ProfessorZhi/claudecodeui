---
id: gap-claude-stream-frames-carry-block-key
title: Claude 实时流式帧缺块级身份：stream_delta / stream_end 与终态 text 帧之间没有可连接的
  blockKey，客户端只能靠文本相等去猜
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**目标。** 让 Claude 的**实时流式帧**带上一个把「流式碎片」和「它最终落成的那一行」连起来的结构化身份 `blockKey`，使客户端不必再靠「文本相等 + 相邻」去猜哪一行是同一段话。本条只做**服务端产出端**；客户端按 key 归约是另一条任务（`gap-chat-stream-block-join-by-key`，依赖本条）。

**为什么需要。** 回合进行中，同一段助手文字会被渲染两次（流式行 + 服务端行），整页重载即消失。机制：`stream_delta` / `stream_end` 帧只带随机 id，没有 `message.id`、没有块 `index`，与随后的终态 `text` 帧之间**没有任何可连接的标识**，客户端只能靠文本相等去折叠，而折叠只认相邻，排序又混用客户端与服务端两个时钟。

**已实测的事实（2026-10-01，`@anthropic-ai/claude-agent-sdk` 0.3.165，`includePartialMessages: true`，「thinking → 文本 → Bash → 文本」，再读它写出的 JSONL）：**

- `message_start.message.id` ＝ 块级 `assistant` 消息的 `message.id` ＝ JSONL 的 `message.id`，恒等。
- 流里的 `index`（0 thinking、1 text、2 tool_use；下一条消息从 0 重来）＝ 该消息在 JSONL 里的行序。
- 每个块的帧序恒为 `content_block_start{index} → content_block_delta{index}… → assistant(该块的终态，content 只含这一个块) → content_block_stop{index}`。**终态 `assistant` 帧先于 `content_block_stop`**，且它自己不带 `index`。
- 块级 `assistant` 消息的 `uuid` ＝ 对应 JSONL 行的 `uuid`，所以现有终态 `text` 帧的 id `${uuid}_0` 与落盘行 id 本来就相等 —— 缺的只是「流式碎片 → 终态行」这一段。

**做法（只改实时帧，不改历史读取）：**

1. `blockKey = <message.id>:<index>`，对不透明字符串使用，客户端不得解析。
2. 在**实时**路径维护「当前打开的块」：`message_start` 记下 `message.id`；`content_block_start` 记下 `index`；`content_block_stop` 关闭。`stream_delta`、`stream_end` 以及**该块的终态帧**（任何块类型：text / thinking / tool_use）都带上 `blockKey`。终态帧归给「当前打开的块」，并保留自己原有的行 id `${uuid}_${partIndex}`。
3. 状态必须按 **(会话, parent_tool_use_id)** 隔离，且在 `message_stop` / run 结束时清理，不得泄漏、不得跨会话串扰。`forwardNormalizedFrames`（`claude-runtime.provider.js`）是 per-run 与常驻两条路径共用的唯一出口，状态应挂在它能触达的、与 writer 同寿命的地方（例如以 writer 为键），这样**常驻路径无需改 `claude-host-driver.provider.ts`**。
4. **历史读取路径一律不得产出 `blockKey`**（历史行没有流状态；`ClaudeSessionsProvider.normalizeMessage` 同时被历史读取使用，有状态的跟踪器不能放在那里，否则正在流式的会话被并发读历史时会把历史行盖上当前打开块的 key）。
5. `NormalizedMessage` 服务端类型加可选 `blockKey?: string`（`server/shared/types.ts`）。字段是**加法**：不改任何现有字段、不改 `seq`、不改 `stream_end` 的触发时机。

**明确不做：** 不新增 `block.start` / `block.end` 等新帧类型；不流式化 `thinking_delta` / `input_json_delta`（现 normalizer 仍丢弃它们，本条不改）；不改历史读取与行 id 方案；不改 `seq` 作用域；不碰客户端；不碰 codex / cursor / opencode。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-claude-runtime-frame-forwarding-coverage`（done）证明了「normalizer → writer」转发环；`gap-chat-dedupe-missing-text-to-stream-delta-adjacency`（done）补了相邻形态的折叠规则。两条都不涉及在实时帧上**加身份字段**，写入面也不重叠。

**未实测、实现时必须自行验证并如实登记：** 同一条消息里出现**多个文本块**；空文本块 / `redacted_thinking`（现 normalizer 对它们不产出行）是否让 `index` 与帧序错位；子代理（`parent_tool_use_id` 非空）的流事件 —— 一次实测里没有观察到任何带该字段的流事件，故只要求「它们的状态与主线隔离、不污染主线的 key」，不要求为它们产出 key。

## AC

- [x] 新增服务端测试用真实捕获的帧序做夹具（thinking → text → tool_use，及第二条消息的 text；夹具内容见上文「已实测」），断言：该序列经实时出口后，`stream_delta`、对应的 `stream_end`、以及该块的终态 `text` 帧**带同一个** `blockKey = <message.id>:<index>`，且终态 `text` 帧的行 id 仍是 `${uuid}_0`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-stream-block-key.test.ts` 退出码 0。
- [x] thinking 与 tool_use 块的终态帧同样带其块的 `blockKey`，且第二条消息的 `index` 从 0 重新开始、与第一条消息的 key 不相等（`message.id` 不同）。同一测试文件内有独立用例，退出码 0。
- [x] **历史路径不带 key**：同一个 `ClaudeSessionsProvider` 实例上，先喂一半实时流事件（让「当前打开的块」非空），再对同一 `sessionId` 调 `normalizeMessage` 处理一条历史 `assistant` 行 ⇒ 结果行**没有** `blockKey`。独立用例，退出码 0。
- [x] **隔离**：两个会话的流事件交错到达 ⇒ 各自的 key 只用各自的 `message.id`，互不串扰；一条带 `parentToolUseId` 的子代理流事件交错进主线 ⇒ 主线后续帧的 key 不变。独立用例，退出码 0。
- [x] **状态不泄漏**：`message_stop` 之后到达的、没有打开块的终态帧**不带** `blockKey`（不沿用上一个块的 key）；一个会话跑完 100 条消息后，跟踪器内部不残留该会话的条目（用例里直接断言）。独立用例，退出码 0。
- [x] 抗假变体真跑并如实登记：把「给终态帧盖 key」那一处短路 ⇒ 终态帧用例变红而 `stream_delta` 用例仍绿；把「按会话隔离」改成全局单例 ⇒ 隔离用例变红。每个变体用 `git checkout -- <file>` 还原后复跑全绿，完成记录里贴出两次红的断言信息。
- [x] 既有用例全绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-stream-event-unwrap.test.ts server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 退出码 0（它们钉了 `stream_delta` / `stream_end` 的形状与「其它事件不渲染为行」；加字段后若有 `deepEqual` 类断言需同步，且不得为换绿放宽断言）。
- [x] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。
- [x] 常驻路径无需改动的结论被证明：`git diff develop --name-only -- server/modules/providers/list/claude/claude-host-driver.provider.ts` 无输出，且存在一条经 `forwardNormalizedFrames` 的用例，用常驻路径同款调用形态（writer 为假对象）得到带 key 的帧。
- [x] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「字段加上了」：

(a) 在**真实 SDK 运行**上读到过 key：用一次性脚本（`cwd` 放 `/tmp` 下的独立目录，跑完删脚本与它在 `~/.claude/projects` 下留的会话文件）直接调 `@anthropic-ai/claude-agent-sdk` 的 `query`（`includePartialMessages: true`，提示「说甲段 → Bash echo → 说乙段」），把全部 `stream_event` / `assistant` 消息喂给 `forwardNormalizedFrames`，完成记录里贴出：每个 `stream_delta` 与其终态 `text` 帧的 `blockKey` 相等、且等于 JSONL 里对应行的 `<message.id>:<行序>`。夹具测试是必要而不充分，这一条才是「对象真的经过机制」。

(b) 这一条证明的是**身份存在且可连接**，不是「重复已消失」—— 客户端按 key 归约在依赖它的那条任务里才落地，本条完成记录不得声称缺陷已修。

(c) 未实测项（多文本块、空文本块 / `redacted_thinking`、子代理流事件）逐项写明「是否实测、读到什么」，没测的写「未测」，不得省略。

L_D 该轴仍暗，理由：本条为服务端帧字段的加法，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/shared/types.ts
- server/modules/providers/tests/claude-stream-block-key.test.ts (new)
- server/modules/providers/tests/claude-stream-event-unwrap.test.ts
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts
- tasks/gap-claude-stream-frames-carry-block-key.md

## 完成记录

**改动形状。** `forwardNormalizedFrames`（`claude-runtime.provider.js` —— per-run 与常驻两条路径共用的唯一出口）在转发每个原始帧之前先过 `trackStreamBlock`：`message_start` 记下 `message.id`，`content_block_start` 记下 `index`，`content_block_stop` 关块，`message_stop` 删条目。跟踪器放在 `WeakMap<writer, Map<scopeKey, {messageId, index}>>`，`scopeKey = <sessionId>\u0000<parentToolUseId>` —— 状态与 writer 同寿命，所以**常驻路径一行未改**（AC9）。`stream_delta` / `stream_end` / 终态 `text|thinking|tool_use` 四类帧被盖上 `blockKey = <message.id>:<index>`；其余帧类型不带。`ClaudeSessionsProvider.normalizeMessage` 未动，历史读取因此一行 key 也产不出（AC3）。`NormalizedMessage` 加可选 `blockKey?: string`，加法，未改任何既有字段。`server/modules/providers/index.ts` barrel **未**加导出（不在 Touches 内）；测试由 `@/modules/providers/list/claude/claude-runtime.provider.js` 深引 `countOpenStreamBlocks`。

实现提交：`03a8e9e5 feat(claude): give live streaming frames a block-level identity`（分支 `task/gap-claude-stream-frames-carry-block-key`，develop `eb021f73`）。

**AC 逐条读数。**

1. `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-stream-block-key.test.ts` → `tests 7 / pass 7 / fail 0`，exit 0。夹具即捕获的帧序：`stream_end(msg:0)`、`stream_delta(msg:1)`、`stream_end(msg:1)`、`stream_end(msg:2)`；终态 `text` 行 id 仍是 `u-text-1_0`。
2. 同条命令，用例「thinking and tool_use blocks carry their own key, and a second message restarts at index 0」绿：thinking `msg_01AAAAAAAA:0`、tool_use `msg_01AAAAAAAA:2`；第二条消息 `msg_02BBBBBBBB:0` 且 `assert.notEqual(…, 'msg_01AAAAAAAA:0')`。
3. 用例「the history read path never stamps a blockKey…」绿：先喂 `message_start` + `content_block_start` 让块真的开着，**正控制** `assert.equal(countOpenStreamBlocks(writer), 1)` 先过，随后同一 provider 实例的 `normalizeMessage` 结果行 `blockKey === undefined` 且 `!('blockKey' in row)`。
4. 用例「interleaved sessions and a subagent never share a block」绿：两个 `sessionId` 交错 ⇒ `['msg_session_a:1', 'msg_session_b:0']`；再交错一条带 `parentToolUseId` 的子代理流 ⇒ 其 key 为 `msg_subagent:0`，而主线后续帧仍是 `msg_session_a:2`（未被子代理污染）。
5. 用例「a settled record after message_stop carries no key, and finished messages leave no tracker entries」绿：`message_stop` 后到达的孤儿终态帧 `blockKey === undefined`；跑满 100 条消息后 `countOpenStreamBlocks(manyWriter) === 0`。
6. 抗假变体两次真跑，见下「AC6 两次红」。
7. `claude-stream-event-unwrap.test.ts` + `claude-runtime-frame-forwarding.test.ts` → `tests 10 / pass 10 / fail 0`，exit 0。**这两个文件未被改动**，其断言（`stream_delta` / `stream_end` 形状、其它事件不渲染为行）加字段后无需同步，也没有为换绿放宽任何断言。
8. `npm run typecheck` exit 0；`npm run lint` exit 0（仅既存 warning，无一落在改动文件）。
9. `git diff develop --name-only -- server/modules/providers/list/claude/claude-host-driver.provider.ts` **无输出**；同文件内用例「the resident call shape — a plain writer object — reaches the same keyed frames」经 `forwardNormalizedFrames` 用假 writer（只有 `send`）得到 `stream_delta` 与 `text` 同为 `msg_01AAAAAAAA:1`。
10. `git diff develop --name-only` → 三行：`server/modules/providers/list/claude/claude-runtime.provider.js`、`server/modules/providers/tests/claude-stream-block-key.test.ts`、`server/shared/types.ts` —— 全部在 Touches 内。`claude-sessions.provider.ts` 与两个既有测试文件在 Touches 内但**无需改动**，故未出现在 diff 里。

**AC6 两次红（真跑，均已还原）。**

- 变体 1 —— 把「终态帧盖 key」那一处短路（`assistant` 分支 `return null`）：`a streaming fragment and the stream_end that closes its block carry the block key` **仍绿**，而 `each block’s settled record — text, thinking and tool_use — carries its block key` **变红**，exit 1，断言信息：
  `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected … + blockKey: undefined, - blockKey: 'msg_01AAAAAAAA:0' … - blockKey: 'msg_01AAAAAAAA:1' … - blockKey: 'msg_01AAAAAAAA:2'`
  （含 AC2 用例与常驻形态用例共三条红。）
- 变体 2 —— 把 `blockScopeKey` 改成常量（全局单例）：只有 `interleaved sessions and a subagent never share a block` **变红**，exit 1，断言信息：
  `actual: [ 'msg_session_b:0', 'msg_session_b:0' ], expected: [ 'msg_session_a:1', 'msg_session_b:0' ]`
- 两个变体各以 `git checkout -- server/modules/providers/list/claude/claude-runtime.provider.js` 还原，复跑全文件 **7/7 全绿**。

**DoD(a) 真实 SDK 运行。** 一次性脚本（`cwd=/tmp/block-key-capture-YHPGy8`，`includePartialMessages: true`，`permissionMode: bypassPermissions`，SDK 0.3.165，模型 v4.1flash），提示为「同一条回复里：① 说甲段 → ② Bash `echo block-key-probe` → ③ 说乙段 → ④ Task 派一个子代理」。把全部 `stream_event` / `assistant` 消息喂给 `forwardNormalizedFrames`，并与同一会话写出的 JSONL 对读。该次运行 108 帧、**108 帧全部带 key**：

| 块 key | 流式 | 折叠到的终态行 | JSONL 对应行 |
| --- | --- | --- | --- |
| `12bab9f1-…-c5f8a128d131:1` | `stream_delta × 8`（首字「甲」） | `a9d12923-…_0` text「甲段：这是第一段话。」 | 同 uuid 行，`12bab9f1-…:1` |
| `328f4f57-…-06e299217ce1:1` | `stream_delta × 8`（首字「乙」） | `fff8c315-…_0` text「乙段：这是第二段话。」 | 同 uuid 行，`328f4f57-…:1` |
| `9766c1d1-…-38c240606dc4:1` | `stream_delta × 76`（首字「四」） | `1cf69f33-…_0` text「四件事已按顺序全部完成…」 | 同 uuid 行，`9766c1d1-…:1` |

三条读数全绿、退出码 0：

- check1 —— 每个终态行的 live `blockKey` 等于它在 JSONL 里那行的 `<message.id>:<行序>`：**8/8 ok**（含 thinking `…:0`、tool_use `…:2`）。
- check2 —— 每个 `stream_delta` 的 key 都能折叠到同一块自己的终态行：**3/3 ok**（`deltas=92`）。
- check3 —— 每个 key 的 `message.id` 在盘上存在、`index < 该消息的块数`：**8/8 ok**。`RESULT check1=true check2=true check3=true deltas=92 settled=8`。
- 脚本与它在 `~/.claude/projects/-tmp-block-key-capture-YHPGy8/` 下留的会话文件（`59b9d8b5-…`、`00753440-…`、`c46c4484-…` 及两个子代理目录）连同 `/tmp` 会话目录**已全部删除**，删除后逐个验证不存在。

**DoD(b)。** 本条只证明**身份存在且可连接**：`blockKey` 真的从 SDK 一路流到 writer。**缺陷本身（同一段文字被渲染两次）未修**，本条不声称已修；客户端按 key 归约落在依赖它的 `gap-chat-stream-block-join-by-key`。

**DoD(c) 三个未实测项，逐条。**

- **同一条消息里的多个文本块**：**已实测，未出现**。三次真实运行里每条消息的块布局都是 `0:thinking 1:text [2:tool_use]`，每条消息恰 1 个 text 块。⇒ 「一条消息里 2 个及以上 text 块时，帧序与 `index` 是否仍对齐」**未测**，夹具也未覆盖该形态（夹具与实测同形态）。
- **空文本块 / `redacted_thinking`**：**已实测，未出现**（未观察到空 text/thinking 块，也未观察到 `redacted_thinking`）。**但第 2 次运行给出了一条相关读数**：消息 `b2a4641f-…-07d0d8a50a54` 在 JSONL 里有 `:0 thinking` + `:1 text` 两行，而实时路径只为 `:1` 的 text 产出了终态行（key `…:1` 与盘上一致），`:0` 的 thinking 没有产出终态行 —— 即「一个块不产生终态行」时，后续块的 `index` **没有**错位。该块的内容当时未捕获，故只能说「缺块不致错位」，不能说它为何缺。空块让 `index` 与帧序错位的情形**未测**。
- **子代理流事件（`parent_tool_use_id` 非空）**：**已实测，未出现**。第 3 次运行里子代理确实跑了（出现 `system:task_started` / `system:task_notification`，主消息里也有 `Agent` 的 `tool_use` 块），但整轮 691 个 `stream_event` 中**没有一个**带非空 `parent_tool_use_id`；三次运行合计同样为零。⇒ 真实运行下子代理的**流式**事件不走这条通路；「子代理状态与主线隔离、不污染主线 key」只由夹具用例钉住（AC4）。
