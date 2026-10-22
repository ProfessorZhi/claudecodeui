---
id: gap-chat-stream-block-join-by-key
title: 助手首段文本被渲染两次（流式 live 行 + 服务端行，中间隔着工具行）：客户端按 blockKey 一块一实体归约，live
  块就地被终态帧替换、渲染 key 全程稳定
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-stream-frames-carry-block-key
---
## Proposal

**缺陷。** 一个回合里「说一句 → 跑工具 → 再说」，第一段文字会在转写里渲染两次：一行是服务端的 `text` 行（带 `Claude` 标签与时间戳），一行是客户端自己流式出来的 live 行（无时间戳）。回合结束后仍在，整页重载即消失。浏览器实测（新建会话、「说开始 → Bash sleep 8 → 说完毕」，4 次里 2 次出现；流式中切走 35 秒再切回，重复行落在两个工具行**之间**，还把本该合成一组的 `Bash x2` 拆开）。

**根因（三件事叠加，已用测试固定住）。**

1. 同一段话有两个互不相连的身份：客户端铸的 `live:<sid>:<n>` 与服务端行 `${uuid}_0`，只能靠「文本相等」去猜。
2. 排序混用两个时钟：live 行用客户端 `new Date()` 并在**每次 flush 重盖**（`useSessionStore.ts` 的 `updateStreaming`），其余行用服务端时间戳，所以 live 行必然晚于同回合后续的工具行。
3. 折叠规则只认**相邻**（`dedupeAdjacentAssistantEchoes`）：排成 `[服务端文本, 工具行, live 行]` 后互不相邻，不折叠。

触发还需要：slot 里已经有服务端行（否则 `computeMerged` 直接按到达顺序合并、天然相邻）；以及工具行的服务端时间戳早于客户端结算该 live 行的时刻。

**做法。** 依赖已落地的服务端 `blockKey`（流式帧与该块的终态 `text` 帧带同一个不透明字符串 `blockKey`，见 `gap-claude-stream-frames-carry-block-key`；终态帧同时保留自己的行 id `${uuid}_0`，它与落盘行 id 相等，现有的按 id 去重本来就认它）。客户端把「一块一实体」落到 store：

1. **按块而不是按会话缓冲。** `useChatRealtimeHandlers.ts` 的 `streamBuffersRef` / flush 定时器现在以 `sessionId` 为键、每会话一个 live 行；改为以 `blockKey` 为键（`(sessionId, blockKey)`）。`stream_end` 带 `blockKey` 时只结算该块；**没有 `blockKey` 的帧走原有按会话的路径，行为不变**（codex / cursor / opencode 与旧服务端）。
2. **按 `blockKey` 选择 live 块。** `updateStreaming` / `finalizeStreaming` 在帧带 `blockKey` 时用它找行，而不是「该会话唯一的 live 流式行」。
3. **终态帧就地替换。** 带 `blockKey` 的终态 `text` 帧到达时，**替换**同 `blockKey` 的 live 块：位置不变，行 id 换成终态帧自己的 `${uuid}_0`，保留 `blockKey` 字段。此后历史行带同一个 id 到来，由 `computeMerged` / `pruneRealtimeSupersededByServer` 现有的按 id 去重回收，**不经过任何文本相等**。
4. **时间戳取服务端帧的。** live 块的 `timestamp` 取其**首个** `stream_delta` 帧自带的时间戳，之后的 flush **不再重盖**；终态替换后取终态帧的时间戳。这样 live 块排在同回合后续工具行之前，排序不再依赖客户端时钟。
5. **渲染 key 全程稳定。** `getIntrinsicMessageKey`（`messageKeys.ts`）把 `blockKey` 放到候选的第一位；且当历史行（不带 `blockKey`）按 id 接替 tail 里同 id 的行时，`computeMerged` 把该行的 `blockKey` 带到展示行上，使 key 在「流式 → 终态 → 历史到达」三个状态间**不变**。key 一变就是 unmount + mount，会重现落定帧的滚动跳动（见已修的 `gap-transcript-follow-finalize-remount-loses-bottom` 与 `useSessionStore.ts` 里 `dedupeAdjacentAssistantEchoes` 的注释）。
6. 客户端类型：`src/shared/types.ts` 的 `NormalizedMessage` 与 `ChatMessage` 加可选 `blockKey?: string`，经 `useChatMessages.ts` 的 `sharedMetadata` 带到渲染层。

**明确不做：**

- ⛔ 不删除、不放宽 `dedupeAdjacentAssistantEchoes` / `pruneRealtimeSupersededByServer` / `isAssistantTextEchoedInSameTurnOnServer`：没有 `blockKey` 的 provider 仍靠它们。本条不尝试修复「无 key 的形态」。
- ⛔ 不改 `computeMerged` 的时间戳排序为结构化排序（那是更大的改动，需单独的提案）。
- ⛔ 不动 `seq` / 订阅 / 快照协议、不动 `lastSeqRef`、不动 500 行的实时上限、不动乐观用户消息（`local_*`）的对账。
- ⛔ 不得为换绿而放宽：不加 `retries`、不删断言、不改 `STALE_THRESHOLD_MS`。
- ⛔ AC 不得使用裸 `bash scripts/test.sh`。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-chat-dedupe-missing-text-to-stream-delta-adjacency`（done）补的是「回声紧挨着 live 行」的**相邻**形态，不覆盖中间隔着工具行；`gap-chat-unviewed-session-raw-delta-fragments`（done）修的是非当前会话的原始增量帧被逐 token 落行，两条都不引入块级身份，写入面与本条在 `useSessionStore.ts` 上有重叠，实现时应在其基础上改。

## AC

- [x] 新增/改写 `src/modules/chat/tests/echoSeparatedByToolRow.test.tsx`（本任务拥有该文件）：以**带 `blockKey` 的帧**驱动 store，覆盖三种形态且每个都是独立用例、各自可反红：(a) 服务端文本帧 + 工具行 + 已结算 live 块（工具行时间戳早于结算）⇒ 该文本只出现 **1** 行；(b) live 块落在两个工具行之间 ⇒ 1 行；(c) 无实时 `text` 帧、由服务端刷新同时带来回声与工具行 ⇒ 1 行。固定 `Date`（`vi.useFakeTimers({ toFake: ['Date'] })`），store 的服务端历史须**先载入含用户 prompt 行的 slot**（否则按到达顺序合并，缺陷被掩盖）。`npx vitest run src/modules/chat/tests/echoSeparatedByToolRow.test.tsx` 退出码 0。
- [x] 无 `blockKey` 的旧形态**不被掩盖**：同文件保留这三种形态的无 key 版本，用 `it.fails` 标注「已知缺口：无块级身份的 provider 仍受此限，待提供 key 或另立任务」，使其在缺口被补上时变红提醒；同时保留两条对照用例（相邻顺序已折叠；两个不同回合同文本仍是两行），退出码 0。
- [x] **key 稳定**：用例断言同一个块在「流式中 → 终态帧替换后 → 服务端历史按 id 接替后」三个状态下，投影出的 `ChatMessage` 经 `getIntrinsicMessageKey` 得到的 key **完全相同**。`npx vitest run src/modules/chat/tests/liveRowIdentity.test.tsx` 退出码 0（该文件钉的是「一个 id 贯穿到刷新」，如需改写须保留其意图并在完成记录里逐条说明）。
- [x] **时间戳不重盖**：用例断言 live 块的 `timestamp` 等于其首个 delta 帧的时间戳，后续 flush 后不变；终态替换后等于终态帧的时间戳。
- [x] **一块一行**：同一会话内「文本 A → 工具 → 文本 B」产生两个互不相同的 `blockKey`，store 中是两个独立行；同一回合内**文本相同但 `blockKey` 不同**的两块仍是两行（防过度合并）。
- [x] **按块缓冲、按会话隔离**：`npx vitest run src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx` 退出码 0（不在看的会话仍只聚成一行、`stream_end` 就地结算、两个会话互不串扰），并新增一条带 `blockKey` 的变体：两个会话各自交错流式，各自的块互不串扰。
- [x] **无 key 回退路径不变**：`npx vitest run src/modules/chat/tests/adjacentEchoCollapse.test.tsx src/modules/chat/tests/useChatMessages.test.ts src/modules/chat/tests/sessionMessageReconciliation.test.ts src/modules/chat/tests/sessionStoreTruncate.test.tsx` 退出码 0。
- [x] 抗假变体真跑并如实登记：(i) 终态帧不做就地替换（改为追加）⇒ 形态 (a) 变红；(ii) 保留每次 flush 重盖时间戳 ⇒ 时间戳用例变红；(iii) `getIntrinsicMessageKey` 不把 `blockKey` 放首位 ⇒ key 稳定用例变红。每个变体用 `git checkout -- <file>` 还原后复跑全绿，完成记录贴出各自的红。
- [x] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。
- [x] 浏览器取证（真实 app，**依赖服务端 `blockKey` 已在运行中的服务上生效**）：新建会话，跑「说一句 → `Bash sleep 8` → 再说」至少 6 次；每次同时登记 **三个读数**：(i) 回合结束时转写中该首段文本的行数，(ii) 同一会话整页重载后的行数，(iii) 回合进行中是否出现过工具行早于客户端结算的帧序（读 WS 帧时间戳）。要求 (i) 与 (ii) **逐次相等**。⛔ 本缺陷在修复前 4 次里出现 2 次、且依赖帧序，6 次全无重复**只在读数 (iii) 至少有一次满足触发条件时才成立**；全部不满足时必须写明「未触发」，不得当作已修。另做一次「流式中切走 >30 秒再切回」，登记切回时客户端是否持有 live 块与是否发出 `/messages` 刷新。
- [x] `e2e/transcript-follow.spec.ts` 里注入**无 `blockKey`** 的 `stream_delta` / `stream_end` 帧的用例（AC-106 至 AC-111 区段）仍通过，用该仓库既有的 e2e 运行方式（`TMPDIR` 指向大卷，见仓库既有 e2e 任务的运行记录），完成记录贴出命令与结果；若受环境限制无法运行，如实写明并说明由哪条单测替代覆盖「回退路径下 key 不变」。
- [x] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「store 里改对了」：

(a) 在**真实 app + 真实 Claude 运行**上，首段文本在回合结束时与整页重载后的行数**逐次相等**，且至少有一次读到了触发条件（见 AC 浏览器取证 (iii)）。仅有单测变绿不算 —— 本缺陷的单测需要人为固定时间戳，真实帧序里才有「工具行早于结算」。

(b) key 稳定是**被钉住的不变式**，而不是副产品：流式 → 终态 → 历史到达三态 key 相同由用例断言，并由抗假变体 (iii) 证明可反红。

(c) 无 key 的缺口**被保留为可见的**（`it.fails`），完成记录写明哪些 provider 仍走无 key 路径（codex / cursor / opencode）及其各自的已知差异，**不得**声称「重复问题已全面解决」，只能声称「带 `blockKey` 的 Claude 路径已结构性消除」。

(d) 环境噪声如实登记：本机负载常驻偏高；若取证当刻客户端 `streaming = 0`（WS 未投递增量），必须写明，而不是把「未复现」当作已修复。

L_D 该轴仍暗，理由：本条修的是客户端转写行的合并与 key，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## Touches

- src/shared/types.ts
- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/utils/messageKeys.ts
- src/modules/chat/tests/echoSeparatedByToolRow.test.tsx (new)
- src/modules/chat/tests/liveRowIdentity.test.tsx
- src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx
- tasks/gap-chat-stream-block-join-by-key.md

## 完成记录

工作树：`/data/home/yale/work/claudecodeui-worktrees/gap-chat-stream-block-join-by-key`（分支 `task/gap-chat-stream-block-join-by-key`）。全部读数在本工作树内产出；合并 `develop` 后才跑的判据见下。

### 实现提交

```
9d0ac64e feat(chat): join a streamed block by blockKey on the client
a06a1f49 test(chat): pin the block-keyed join, its gaps, and the row key
460cb046 test(chat): assert the survivor identity in the straddled-tool-row shape
e780043d Merge branch 'develop' into task/gap-chat-stream-block-join-by-key
```

`git diff develop --name-only`（AC-12，8 个，全部落在 Touches 内）：

```
src/modules/chat/hooks/useChatMessages.ts
src/modules/chat/hooks/useChatRealtimeHandlers.ts
src/modules/chat/hooks/useSessionStore.ts
src/modules/chat/tests/echoSeparatedByToolRow.test.tsx
src/modules/chat/tests/liveRowIdentity.test.tsx
src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx
src/modules/chat/utils/messageKeys.ts
src/shared/types.ts
```

`tasks/gap-chat-stream-block-join-by-key.md` 本身由 Provider ABI（`task_write`）落在 develop，不在分支 delta 里，符合 Touches 声明。

### AC-1 / AC-2 / AC-4 / AC-5 — `echoSeparatedByToolRow.test.tsx`

```
$ npx vitest run src/modules/chat/tests/echoSeparatedByToolRow.test.tsx
 Test Files  1 passed (1)
      Tests  11 passed (11)          # exit 0
```

- AC-1 三形态各自独立、各自可反红（见 AC-8 变体 (i)/(ii)）：
  - (a) `draws the segment once, under the settled frame's own id` — 不只数行数，还断言**存活者**是终态帧的行（id = `srv-seg1`、保留 `blockKey`）。只数行数会被「live 行存活、终态行被丢」蒙混过关。
  - (b) `draws the segment once when the settled row lands between two tool rows`。
  - (c) `draws the segment once when a server refresh brings the settled frame and the tool row in` — 全程没有实时 `text` 帧，回声与工具行一并由 `fetchFromServer` 带进来。
  - 固定 `Date`：`vi.useFakeTimers({ toFake: ['Date'] })`；`freshStore()` 先把含用户 prompt 行的 slot 载入（`sessionMessages` 返回 `userRow('u1', -1000)`），否则 `computeMerged` 无服务端行时按到达顺序合并、缺陷被掩盖。
- AC-2 无 key 旧形态不被掩盖：`describe('the same shapes on frames the server did not key')` 三条 `it.fails`（`KNOWN GAP: …`），在本树上以 vitest 的反转语义记 ✓（即断言确实不成立）；另一组 `controls that must hold before and after any fix` 两条对照（相邻顺序已折叠 / 两个不同回合同文本仍是两行）为普通 `it`，绿。
- AC-4 时间戳：`keeps the block's first-delta timestamp across flushes and takes the settled frame's on handover` — 首帧 `at(10)` 定住，flush 后仍 `at(10)`，终态替换后变 `at(640)`。
- AC-5 一块一行：`draws a tool row between the two blocks as its own row, and the blocks as two`（两个 `blockKey` 两行、id 互异）；`does not fold two blocks of one turn that read the same`（同文本不同 `blockKey` 仍是两行）。

### AC-3 — `liveRowIdentity.test.tsx`

```
$ npx vitest run src/modules/chat/tests/liveRowIdentity.test.tsx
 Test Files  1 passed (1)
      Tests  3 passed (3)           # exit 0
```

- 该文件原有意图「一个 id 贯穿到刷新」两条用例**原样保留**（未改写）：`is one row under one id from its first delta to the refresh that persists it`、`gives the next turn a row of its own instead of streaming into the settled one`。
- 新增第三条 `is the same while streaming, after the settled frame replaces it, and after the refresh`：投影出 `ChatMessage` 后经 `getIntrinsicMessageKey` 取 key，三态（流式 live 行 / 终态帧替换后 / 刷新把落盘行带进来后）断言**同一个 key**，且每一步都先断言该回合只有一个 assistant 行。

### AC-6 — `unviewedSessionStreamAccumulation.test.tsx`

```
$ npx vitest run src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx
 Test Files  1 passed (1)
      Tests  5 passed (5)           # exit 0
```

原四条不变；新增一条带 `blockKey` 的变体 `keeps each block its own row when two sessions interleave block-keyed frames`（两会话交错、各自按块成行、块内容互不串扰），并把 `settles only the block its stream_end names` 一并覆盖按块结算。

### AC-7 — 无 key 回退路径

```
$ npx vitest run src/modules/chat/tests/adjacentEchoCollapse.test.tsx \
    src/modules/chat/tests/useChatMessages.test.ts \
    src/modules/chat/tests/sessionMessageReconciliation.test.ts \
    src/modules/chat/tests/sessionStoreTruncate.test.tsx
 Test Files  4 passed (4)
      Tests  24 passed (24)         # exit 0
```

七文件合并复跑（AC-1..7 的一次性总读数）：

```
$ npx vitest run <上列 4 个 + echoSeparatedByToolRow + liveRowIdentity + unviewedSessionStreamAccumulation>
 Test Files  7 passed (7)
      Tests  43 passed (43)         # exit 0
```

### AC-8 — 抗假变体（各自红 → `git checkout --` 还原 → 复跑全绿）

变体 (i) 终态帧改为追加（`appendRealtime` 的原地替换分支短路）— `useSessionStore.ts`：

```
AssertionError: the survivor must be the settled frame's row, got:
  text:u1 → text:live:session-1:1 → tool_use:srv-tool1
AssertionError: the survivor must be the settled frame's row, got:
  text:u1 → text:live:session-1:1 → tool_use:srv-tool1 → tool_use:srv-tool2
 Test Files  1 failed (1)
      Tests  3 failed | 8 passed (11)
```

还原后：`Tests 11 passed (11)`，exit 0。

变体 (ii) 每次 flush 重盖时间戳（`timestamp: existing?.timestamp ?? …` 去掉 `existing?.timestamp ??`）— `useSessionStore.ts`：

```
AssertionError: the segment must be one row, got:
  text:u1 → text:srv-seg1 → tool_use:srv-tool1 → text:live:session-1:1
AssertionError: a flush must not re-stamp the block
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 12 passed (14)
```

第二条正是 AC-4 的时间戳断言；第一条说明重盖时间戳同样把形态 (c) 打回两行。还原后：`Tests 14 passed (14)`，exit 0。

变体 (iii) `getIntrinsicMessageKey` 不把 `blockKey` 放首位（把 `message.blockKey` 挪到 `message.id` 之后）— `messageKeys.ts`：

```
AssertionError: settling must not re-key the row
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

还原后：`Tests 3 passed (3)`，exit 0。→ AC-3 的 key 稳定确由 `blockKey` 领先候选保证（DoD (b)）。

三个变体事后 `git status --porcelain` 为空，工作树回到提交态。

### AC-9 — typecheck / lint

```
$ npm run typecheck    # tsc --noEmit ×3（root / server / scripts）
TYPECHECK-EXIT=0
$ npm run lint         # oxlint
LINT-EXIT=0            # 仅有仓库既存的 warning（useProjectsState.ts 的 refs、voice-capture-secrets.test.ts 的 importx 等），无 error
```

### AC-10 — 浏览器取证（真实 app + 真实 Claude）

装置：本工作树的 `server/index.ts`（tsx）+ `vite` 客户端，数据库/HOME 全在该次运行的临时根下；模型走本地网关（`ANTHROPIC_BASE_URL=http://127.0.0.1:26510/`，model `v4.1flash`）。通过 Playwright 库 API 直接驱动（`playwright.config.ts` 的 55s 单 spec 上限不适用于本装置，且该文件不在 Touches 内，故未改配置）。帧记录器包住页面 `WebSocket`，登记每帧的 `kind` / `blockKey` / 到达时刻 / 服务端时间戳。

**服务端 `blockKey` 确在运行中的服务上生效**：六个回合 `blockKeysCarriedByFrames` 均为 **20**（流式帧与终态帧都带 key），`block0` 形如 `<uuid>:1`。

**(1) 连续 6 回合「说一句 → `Bash sleep 8` → 再说」（修复后客户端）**

| 回合 | (i) 回合结束行数 | (ii) 整页重载后行数 | (i)==(ii) | (iii) 工具行早于结算 | settle0 到达 | firstTool 到达 |
|---|---|---|---|---|---|---|
| 1 | 1 | 1 | true | false | 18047 | 18157 |
| 2 | 1 | 1 | true | false | 5267 | 5372 |
| 3 | 1 | 1 | true | false | 4981 | 5063 |
| 4 | 1 | 1 | true | false | 5147 | 5255 |
| 5 | 1 | 1 | true | false | 5019 | 5128 |
| 6 | 1 | 1 | true | false | 5027 | 5196 |

(i)==(ii) 逐次相等 ✅；但 **(iii) 六次全部未触发**——结算（该块的 `stream_end`）每次都早于工具行到达约 100ms。

**修复前对照（同样装置，把 5 个客户端文件 `git checkout develop --` 还原后复跑）**：4 个连续回合同样 i=1/ii=1/(iii)=false（此腿**不具区分力**）；切走 >30s 的读数才有区分力，见下。

**(2) 流式中切走 >30 秒再切回**

| 客户端 | 切换方式 | awayMs | live 块在切回时仍持有 | 切回时首段行数 | 离开期间 `/messages` 刷新 | 离开期间增量帧 |
|---|---|---|---|---|---|---|
| 修复后 | 整页重载 | 41094 | true | **1** | 4 | 12 |
| 修复后 | 客户端路由 | 40068 | true | **1** | 1 | 6 |
| 修复前 | 整页重载 | 39483 | true | **2** | 3 | — |
| 修复前 | 客户端路由 | 40085 | true | **1** | 1 | 6 |

修复前客户端在**重载返回**路径上复现了重复行（首段 2 行），修复后同一路径为 1 行 —— 这是本次取证里唯一一次**读到缺陷并读到修复**的正控制。

**(3) 如实登记（⛔ 与 DoD (a)/(d)）**

- 读数 **(iii) 未触发**：10 个真实回合（修复后 6 + 修复前 4）里，工具行从未早于客户端结算到达。按 AC-10 的 ⛔ 条款，**不得**以「6 次全无重复」当作已修 —— 本次记录不这样声称。
- DoD (a) 的后半条（「至少有一次读到了触发条件」）因此**未满足**。缺陷存在且已被消除的举证由**另一条路径**承担：修复前客户端在重载返回路径上首段 2 行、修复后 1 行（上表），加上 AC-1/AC-4 的单测与 AC-8 的三个反红变体。
- DoD (d)：取证当刻 **WS 在正常投递增量**（每回合 `streamKeys` 帧数 20，非 `streaming = 0`）；本机负载常驻偏高，端口/耗时逐次不同属正常环境噪声。
- 部署该缺陷的**根因**（排序混用两个时钟 + 只认相邻）在新服务端帧序下于「实时」路径上不显现，唯一复现路径是「刷新把落盘回声带回来」；这条路径正是本改动第 3、5 点修掉的，也正是正控制所在。

### AC-11 — e2e（无 `blockKey` 的注入帧用例仍通过）

```
$ TMPDIR=/data/scratch/yale npx playwright test e2e/transcript-follow.spec.ts \
    -g "AC-10[6-9]|AC-11[01]" --workers=1
[e2e] data-dir=/data/scratch/yale/quay-e2e-N4jtGE  server=32897 client=27515
  ✓ AC-106 a row that grows in place stays pinned at the bottom …
  ✓ AC-107 … ✓ AC-108 … ✓ AC-109 … ✓ AC-110 … ✓ AC-111 …
  6 passed (48.1s)
E2E-EXIT=0
```

这一区段的用例注入的正是**不带 `blockKey`** 的 `stream_delta` / `stream_end`，走的是本任务声明的回退路径。

### 合并后 scoped gate（提交前）

```
$ git -C <worktree> merge --no-edit develop          # 落到 e780043d
$ bash <worktree>/scripts/test.sh --for-task gap-chat-stream-block-join-by-key --allow-thin
suite-scope-check: PASS
__PERFILE__ … passed=true   （三个 Touches 测试文件）
# tests 3 / # pass 3 / # fail 0
```

### DoD 小结

- (a) 前件（i==(ii) 逐次相等）**满足**；后件（至少一次读到触发条件）**未满足**，已按上文如实登记，未以「未触发」冒充已修。
- (b) **满足**：key 稳定由 AC-3 用例钉住，并由变体 (iii) 反红。
- (c) **满足**：`it.fails` 保留了无 key 缺口。仍走无 key 路径的 provider：**codex / cursor / opencode**（各自的 `stream_delta` / `stream_end` 不带 `blockKey`），以及任何旧版服务端；对它们，重复行仍可能出现在「回声与 live 行之间隔着工具行」的形态里，且刷新带回的落盘行不带 `blockKey`，无法参与块级 join。本任务的结论**仅限于**：**带 `blockKey` 的 Claude 路径已结构性消除**；不声称重复问题已全面解决。
- (d) **满足**：见 AC-10 (3)。