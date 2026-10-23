---
id: gap-session-hosts-per-run-frame-parity
title: AC-155 per-run 客户端可见帧逐帧不变：四个 provider 经真实 chat websocket（send / abort /
  忙时重复发送 / subscribe 重放）与接入宿主层之前录下的基线 fixture 深比较
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
goal_ac: AC-155
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rln 'goal_ac: *AC-155' tasks/*.md` → 0 个文件；`grep -rln 'per-run-parity' tasks/*.md` → 0 个文件；`ls tasks/ | grep session-hosts` → 只有 `gap-session-hosts-default-wrap-four-providers.md` 一个。同区两条相邻任务都不重复：`gap-session-hosts-default-wrap-four-providers`（AC-154）只认领「宿主登记与关闭原因」，它的 AC9 只做一次「绕过 manager 直跑 runtime」对「经 providerRuntimeService 跑」的帧深比较，并明确把「客户端可见行为的逐帧不变」让给本条；`gap-claude-runtime-frame-forwarding-coverage`（done）只补归一化器→writer 之间那一环的转发覆盖。本条的判据必须跑在**含宿主层包装**的树上（否则「接入前后逐帧相同」在这棵树上没有后半句），故顶层 `depends_on` 指向 AC-154 的落地任务：先 AC-154 把包装接进 `provider-runtime.service.ts`，再本条落下基线 fixture 与比较判据。

**来源与判据物。** 判据逐字取自 `goals/AC-155-per-run-的客户端可见行为在接入宿主层前后逐帧相同.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts`。红态基线（本轮**直跑**，不是推断）：该命令在当前树上退出 **1**，文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-per-run-parity.test.ts'`；`ls server/modules/session-hosts/` 无此目录。

**现状（本轮实测的读数，逐条都有出处）**

- **真实 ws 分派面**：`server/modules/websocket/services/chat-websocket.service.ts` 里 `handleChatConnection` 在 `:620`，`case 'chat.send'` `:644`、`'chat.abort'` `:647`、`'chat.subscribe'` `:650`；`handleChatSend` `:154` → `dispatchRun` `:216`。忙时重复发送的拒绝在 `:235-247`：`chatRunRegistry.startRun` 返回 null ⇒ `sendProtocolError(ws, 'RUN_IN_PROGRESS', …)`；`sendProtocolError` 在 `:126`，走 `sendJson` `:116` **直发、不带 seq**（所以它在投影里只能用 `kind + code` 认）。中止：`handleChatAbort` `:432` → `:449` `dependencies.runtime.abort(run.provider, sessionId)` → `:453` `chatRunRegistry.completeRun(sessionId, { exitCode: success ? 0 : 1, aborted: true })`（被中止那一轮的 terminal complete 由 ws 层**代发**）。订阅/重放：`handleChatSubscribe` `:465`，ack 帧 `kind: 'chat_subscribed'` `:503`，`attachConnection` `:495`，重放 `:516` `chatRunRegistry.replayEvents(sessionId, lastSeq)`；`lastSeq` 缺省 0（`:484-487`），且**只对 RUNNING 的 run 重放**（`:512-518`）。
- **seq 与帧装饰**：`server/modules/websocket/services/chat-run-registry.service.ts` 的 `decorateAndRecordEvent` `:84`，每帧 `run.lastSeq += 1` 并写回 `seq`（`:93-98`）；`startRun` `:167`（`lastSeq: 0`）；`replayEvents` `:265`；`clearAll` `:307`；`MAX_BUFFERED_EVENTS_PER_RUN = 5000` `:51`。**exactly-one-complete 去重在 `:88-92`**：`kind === 'complete'` 且 run 已 `completed` ⇒ 直接 `return null` 丢弃（假形态 (a) 的第一个陷阱）。
- **complete 帧**：构造器 `createCompleteMessage` 在 `server/shared/utils.ts:376`（`kind: 'complete'`、`exitCode` 默认 1、`aborted`）。
- **可复用的驱动面（既有测试的写法，不是发明）**：`server/modules/websocket/tests/chat-edit-send.test.ts` 的 `createFakeSocket()` `:17-26`（EventEmitter + `readyState = 1` + `frames` 收 `JSON.parse`）、`withGateway()` `:84-135`（存/恢复 `DATABASE_PATH`、临时库、`sessionsDb.createSession`、`handleChatConnection(socket, { user: { id: 1 } }, { runtime })`，finally 里 `connectedClients.clear()` + `chatRunRegistry.clearAll()` + `closeConnection()`）、`holdTheNextRun()` `:70-78`（把一轮按住不结算——`:265` 那条 RUN_IN_PROGRESS 断言就是这么造的）、`settle()` `:138`（30ms 定时器）。
- **生产分派入口**：`server/modules/providers/services/provider-runtime.service.ts` 的 `createProviderRuntimeService` `:42`、真正调 `provider.runtime.run(...)` `:72`、`abort` `:90-91`、生产单例 `:108`；`isProviderInstalled` 探测失败时返回 true（`:59-66`），所以不需要伪造 auth。四个 provider 的 runtime 都有 abort（claude `server/modules/providers/list/claude/claude-runtime.provider.js:1268`、codex `server/modules/providers/list/codex/codex-runtime.provider.ts:509`、cursor `server/modules/providers/list/cursor/cursor-runtime.provider.js:386`、opencode `server/modules/providers/list/opencode/opencode-runtime.provider.js:429`）。
- **仓库里没有已提交的 JSON fixture 先例**（`find server -path '*test*' -name '*.json'` → 0），本条是第一个：fixture 必须**随测试提交**，不是运行时生成。

**要建的东西**（全部落在 `server/modules/session-hosts/tests/` 下）

1. `per-run-frame-scenarios.ts` —— 场景驱动 + 每个 provider 的假进程 + 帧投影。**不 import `server/modules/session-hosts/index.ts`**：它要在基线录制树（AC-154 之前那棵树）里也能跑，而那个树上宿主模块还不存在。驱动必须用**真实**的 `handleChatConnection`、真实的 `chatRunRegistry`、真实的 `providerRuntimeService`（`provider-runtime.service.ts:108` 的生产单例）当 `dependencies.runtime`，只把 provider 的**进程**换成假，伪造在进程/原型层（不替换 provider 对象、不另造 `ProviderRuntimeContext`，否则「经真实分派入口」就不成立）：
   - **codex**：`t.mock.method(Codex.prototype, 'startThread' | 'resumeThread')` 返回假 `Thread`，其 `runStreamed()` 返回 `{ events: (async function* () {…})() }`（机制出处 `server/modules/providers/tests/codex-runtime.test.ts:27-41`）。
   - **opencode**：临时目录里写 `#!/bin/sh` + `node` 的 shim、`chmod 0o755`、PATH 前插（机制出处 `server/modules/providers/list/opencode/opencode-runtime.provider.test.js:25-58` 的 `createFakeOpenCodeExecutable`）。
   - **cursor**：同一形态的假 `cursor-agent`（`cursor-runtime.provider.js:159` `spawnFunction('cursor-agent', args, …)`）。
   - **claude**：`CLAUDE_CLI_PATH` 指向临时目录里的假 CLI（`claude-runtime.provider.js:238` 读 `resolveClaudeCodeExecutablePath`，`server/shared/claude-cli-path.ts:143`），按 SDK stream-json 协议输出 `system/init` → `assistant` → `result`，且提供闸门。
   **这四个假必须在 driver 里自带一份，不能 import AC-154 的测试文件**：录制基线的那棵树在 AC-154 之前，`tests/session-host-default-wrap.test.ts` 在那棵树上不存在。假进程必须 emit **确定性**的 session id 与文本，并提供一个测试可放的**闸门**（不结算即可制造「run 仍在进行」）。
2. **四个场景 × 四个 provider = 16 条录制**：① 正常一轮（`chat.send` 到 terminal `complete`）；② 中途中止（run 在飞行中 `chat.abort`）；③ 忙时重复发送（第一轮按住不结算，同 socket 再 `chat.send` ⇒ 基线里必须有 `RUN_IN_PROGRESS` 的 `protocol_error` 帧）；④ 断线后按 lastSeq 重放（第一轮跑到**被观测到的第 N 帧**后，新 socket `chat.subscribe` 带一个中途 `lastSeq`，收 ack + 重放帧）。推进一律**按观测到的帧**轮询（带上限超时），**不许用固定 sleep 当同步手段**——录制被截断会读成更短的序列，是假红/假绿的来源。
3. `session-host-per-run-parity.test.ts`（判据）—— 读 fixture，按上面的驱动逐条重放，与基线逐帧深比较；另加「活的这棵树真的接进了宿主层」的断言（见不变式 2）。fixture 用 `fileURLToPath(new URL('./fixtures/per-run-frame-baseline.json', import.meta.url))` + fs 读，**不要** `import … with { type: 'json' }`。
4. `record-per-run-frame-baseline.test.ts`（录制器）—— 默认 skip（`{ skip: !process.env.PER_RUN_PARITY_RECORD_COMMIT }`），并在**写文件前硬拒绝**：除非 `git cat-file -e <PER_RUN_PARITY_RECORD_COMMIT>:server/modules/session-hosts/index.ts` **失败**（那棵树确实还没有宿主模块）而当前 HEAD 的同一路径存在，否则 throw 且不写。这个拒绝闸就是「fixture 不是事后补录」的机械保证。
5. `fixtures/per-run-frame-baseline.json` —— 头部 `{ recordedAtCommit, recordedAt, providers, scenarios }`，主体是 16 条投影后的帧序列。

**基线怎么录（顺序本身是判据的一部分）**：宿主层落地提交 `HOST_COMMIT=$(git log --diff-filter=A --format=%H -1 -- server/modules/session-hosts/index.ts)`，锚点 `PRE=$(git rev-parse ${HOST_COMMIT}^)`。在**仓库根目录内**开临时 worktree（`git worktree add .worktrees/parity-record $PRE`；放仓内是为了让 Node 的模块解析沿父目录找到仓库根的 `node_modules`——worktree 自己不装依赖），把 `per-run-frame-scenarios.ts` 与 `record-per-run-frame-baseline.test.ts` 按同样相对路径拷进去，在那棵树里跑 `PER_RUN_PARITY_RECORD_COMMIT=$PRE npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/record-per-run-frame-baseline.test.ts` 产出 fixture，把 fixture 拷回主 checkout 提交，`git worktree remove` 清掉，保证 `git status --short` 干净。

**两个假形态（判据的分辨力证明，必须实测）**

- **(a) 宿主关闭时补发一个合成 complete** ⇒ 多出一帧，必须红。**已知陷阱（必须先用读数确认，再登记）**：`chat-run-registry.service.ts:88-92` 的 exactly-one-complete 去重会把「run 已 completed 之后再来的 complete」直接丢掉，所以最朴素的写法（经由 `run.writer`）**很可能到不了 socket**、变成 no-op（那会儿判据照绿，而你会以为它在承重）。实现者必须先证明这条变体真的往 socket 多送了一帧（直写连接那一支是可达形态），并把「朴素版本是 no-op」的读数也抄进完成记录。
- **(b) 忙时直写逻辑泄漏到 per-run** ⇒ 场景③不再返回 `RUN_IN_PROGRESS`，必须红。做法是让 per-run 宿主在 busy 时也走「直接写入进程、不返回 RUN_IN_PROGRESS」的忙时输入分支（即 proposal §8 / AC-157 的常驻规则漏给 per-run），于是场景③的 `protocol_error` 帧消失。**如实登记**：常驻侧的真实现今天还不存在（AC-157 / AC-159 未落地），所以这条变体是**构造出来的**，不是真回归；完成记录要写「构造的」，并给出它红在哪一条读数上。
- 两个形态都**只改实现、判据文件一字不动**；实测完 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。

**不变式与正控制（不许让「相同」变成恒真）**

1. 比较是**零差**声明，所以每条录制必须自证非空、非平凡：投影后每条序列帧数 > 0；正常一轮那条含且仅含一个 terminal `complete`（并读它的 `exitCode` 与 `aborted`）；场景③那条含 `RUN_IN_PROGRESS` 的 `protocol_error`；场景④那条含 ack `chat_subscribed` 且至少有 1 条 `seq > lastSeq` 的重放帧。这些读数逐条打印。
2. 判据自己也要证明「这棵树上确实有宿主层」：正常一轮进行中，`sessionHostManager.snapshot()` 里该会话恰有一个 `mode=per-run` 的宿主（读数打印）。否则 AC-154 被回退时判据会**假绿**（帧没变，因为什么都没接进来）——这条把「接入后」那半句钉住。
3. **比较器自测（反红可达性）**：喂给它 `(基线, 基线去掉最后一帧)` 必须报「缺帧」并点名那条帧；`(基线, 基线追加一条合成 complete)` 必须报「多帧」。这直接证明假形态 (a) 的检出路径存在，而不是一条永不触发的断言。
4. **录制确定性自测**：同一 provider 的同一场景连跑两次，投影必须逐字节相同；不同则判据红（否则基线与活体的比较是噪声）。
5. **投影不许悄悄放宽**：默认丢弃的只有 `timestamp`；`kind` 与 `seq` 永不丢；`complete` 带 `exitCode`/`aborted`，`protocol_error` 带 `code`。若某字段在假进程下无法稳定（例如运行时生成的 provider 侧 id），可以把它也丢进投影，但**必须逐个登记字段名 + 不稳定原因 + 实测读数**；帧数与顺序严格相等，任何一帧都不许被丢。

**非目标**：AC-154（宿主登记与关闭原因）、AC-156 的两条 REST、AC-157 的状态机/停机/关闭原因穷举、AC-158 的 1:N 解绑与顶替、AC-159 的 Claude 常驻 driver、AC-160 的调试 agent 场景 op。本条**不改任何生产代码**：不改四个 runtime（`server/modules/providers/list/**`）、不改 ws 分派语义、不改 `chat-run-registry.service.ts`；只加测试与 fixture，录制与重放共用同一份 `per-run-frame-scenarios.ts`（不新起第二份实现）。若假 CLI 在预算内无法满足 SDK 协议（已知风险：`result`/`init` 的字段形状随 SDK 版本收紧），**不得**换 provider 顶替、也不得把 claude 那一格降级成 manager 单测；改用真 CLI + mock 端点（`server/modules/providers/tests/model-gateway-end-to-end.test.ts` 的 `startMockAnthropic()` `:60` / `createFakeSocket()` `:89` / `runChatSend()` `:102`）覆盖，并如实登记；若连它也超预算，把读数与阻塞点写进完成记录并另立一条只覆盖缺口的任务，不得把判据改成「跳过 claude」。

## Plan

1. 先读 AC-154 的落地提交，取 `HOST_COMMIT` 与 `PRE`，确认 `git cat-file -e ${PRE}:server/modules/session-hosts/index.ts` 失败、HEAD 上同路径存在。
2. 写 `per-run-frame-scenarios.ts`：四个假进程（codex Thread mock / cursor+opencode 假可执行文件 / claude 假 CLI）、闸门、四个场景、帧投影。先逐 provider 单跑一条场景、把帧打印出来看覆盖，不比较。
3. 写 `record-per-run-frame-baseline.test.ts`（默认 skip + 拒绝闸），按上面的 worktree 流程在 `$PRE` 上录出 16 条基线，拷回主 checkout。
4. 写 `session-host-per-run-parity.test.ts`：fixture 深比较 + 不变式 2 的宿主快照读数 + 不变式 3 的比较器自测 + 不变式 4 的确定性自测。
5. 实测两个假形态 (a)(b)（先确认 (a) 的朴素版本是否 no-op），抄退出码与红态文案，还原。
6. 跑判据命令（目标退出 0）、`npm run typecheck`、`npm run lint`、既有 `server/modules/websocket/tests/chat-run-registry.test.ts` 与 `chat-edit-send.test.ts`；确认 `git status --short` 只剩 Touches。

## AC

- [x] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`。红态基线已测：同命令当前退出 1、文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-per-run-parity.test.ts'`。
- [x] AC2 四条场景 × 四个 provider = 16 条录制，全部经真实 `handleChatConnection`（`chat-websocket.service.ts:620`）分派、`chatRunRegistry` 与 `providerRuntimeService`（`:108` 单例）为真、只换进程；逐行打印 `provider=… scenario=… frames=… kinds=…`，16 行都在。
- [x] AC3 非平凡正控制：投影后每条序列帧数 > 0；正常一轮那条含且仅含 1 个 `kind: 'complete'` 且打印其 `exitCode`/`aborted`；忙时重复发送那条含 1 个 `kind: 'protocol_error'` 且 `code == 'RUN_IN_PROGRESS'`；重放那条含 1 个 `kind: 'chat_subscribed'` 且重放帧数 ≥ 1（打印 `replayed=…`）。
- [x] AC4 宿主层确实在路径上（防「AC-154 被回退 ⇒ 假绿」）：正常一轮进行中 `sessionHostManager.snapshot()` 里该会话恰有一个 `mode=per-run` 宿主，逐 provider 打印 `provider=… hosts=… mode=per-run`；同时 16 条帧序列与基线相同。
- [x] AC5 基线确实是接入之前录的：fixture 头部有 `recordedAtCommit`；判据断言 `git cat-file -e <recordedAtCommit>:server/modules/session-hosts/index.ts` 失败、而当前 HEAD 的同一路径存在；两条腿分别打印，失败时点名是哪条腿。
- [x] AC6 比较器自测（反红可达性）：`(基线, 基线去掉最后一帧)` 报缺帧并点名该帧；`(基线, 基线 + 一条合成 complete)` 报多帧；两种输入各打印一次判定。
- [x] AC7 录制确定性：同一 provider 同一场景连跑两次的投影逐字节相同（至少 4 例，打印 `run1=… run2=… equal=…`）。
- [x] AC8 假形态 (a) 承重：宿主关闭路径补发合成 complete ⇒ 判据退出 **1**，红文案点名多出的那条帧；并登记「朴素版本是否被 `chat-run-registry.service.ts:88-92` 去重吞掉（no-op）」的实测读数。实测退出码与红态文案抄进完成记录，用后还原。
- [x] AC9 假形态 (b) 承重：忙时直写泄漏到 per-run ⇒ 判据退出 **1**，红文案点名场景③少了 `RUN_IN_PROGRESS` 帧；登记该变体是「构造的」（常驻侧真实现尚未落地）。实测退出码与红态文案抄进完成记录，用后还原。
- [x] AC10 生产面零改动：`git diff --name-only` 里没有 `server/modules/providers/list/**`、没有 `server/modules/websocket/services/**`、没有 `server/modules/providers/services/provider-runtime.service.ts`；落地的只有 Touches 列出的文件（`git diff --stat` 逐条对齐）。
- [x] AC11 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts` 与 `…/chat-edit-send.test.ts` 退出 0。
- [x] AC12 如实登记：完成记录写明（a）四个 provider 各自的假进程形态与出处（codex 的 mock 面、cursor/opencode 的假可执行文件、claude 假 CLI 的协议与「`result` 之后不退出」如何做到）；（b）`$PRE` 的实际 sha 与「它确实不含宿主模块」的读数；（c）两个假形态的实测退出码与红态文案，含 (a) 的 no-op 读数；（d）投影里除 `timestamp` 外还丢了哪些字段、为什么；（e）未实现：AC-156…AC-160 与常驻侧的一切。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts`）重跑：退出码 0 且 `fail 0`。16 条 `provider=… scenario=… frames=…` 读数、AC3 的四类非平凡读数、AC4 的宿主快照读数、AC5 的两条腿读数、AC6 的比较器自测判定、AC8/AC9 两个假形态的实测退出码与红态文案（含 (a) 的 no-op 读数）、fixture 的 `recordedAtCommit` 与「该 sha 不含宿主模块」的读数，一并写进完成记录。fixture 已随测试提交（`git log --oneline -1 -- server/modules/session-hosts/tests/fixtures/per-run-frame-baseline.json` 有输出）。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上，生产面零改动。完成后 AC-155 在驱动器下一轮经 `goal_ac: AC-155` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC8「合成 complete」的变体必红、AC9「忙时直写泄漏」的变体必红、把 AC-154 的包装摘掉（宿主快照为空）必红。

## Touches

- server/modules/session-hosts/tests/session-host-per-run-parity.test.ts (new)
- server/modules/session-hosts/tests/per-run-frame-scenarios.ts (new)
- server/modules/session-hosts/tests/record-per-run-frame-baseline.test.ts (new)
- server/modules/session-hosts/tests/fixtures/per-run-frame-baseline.json (new)
- tasks/gap-session-hosts-per-run-frame-parity.md

## Completion

**改动：** 只加测试与 fixture，生产面零改动。`git diff --stat develop...HEAD` = 4 files changed, 1723 insertions(+)：`session-host-per-run-parity.test.ts`（判据，377 行）、`per-run-frame-scenarios.ts`（驱动 + 投影 + 比较器，664 行）、`record-per-run-frame-baseline.test.ts`（录制器，137 行）、`fixtures/per-run-frame-baseline.json`（16 条投影帧，545 行）。`git diff --name-only develop...HEAD | grep -E '^server/modules/providers/list/|^server/modules/websocket/services/|^server/modules/providers/services/provider-runtime.service.ts'` → **空**。判据命令被跑过多次，逐轮读数见下。

### AC1 判据为绿

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts
→ exit 0   ℹ pass 5   ℹ fail 0   ℹ duration_ms 6349  （另两轮 7239 / 12265；宿主 load average 215 @ 128 核）
```

红态基线（未落地时直跑，不是推断）：exit **1**，文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-per-run-parity.test.ts'`。

### AC2 16 条录制（逐行读数）

```
provider=claude   scenario=turn    frames=3 kinds=text,text,complete
provider=claude   scenario=abort   frames=3 kinds=text,text,complete
provider=claude   scenario=busy    frames=4 kinds=text,text,protocol_error,complete
provider=claude   scenario=replay  frames=3 kinds=chat_subscribed,text,complete
provider=codex    scenario=turn    frames=3 kinds=text,text,complete
provider=codex    scenario=abort   frames=3 kinds=text,text,complete
provider=codex    scenario=busy    frames=4 kinds=text,text,protocol_error,complete
provider=codex    scenario=replay  frames=3 kinds=chat_subscribed,text,complete
provider=cursor   scenario=turn    frames=3 kinds=stream_delta,stream_delta,complete
provider=cursor   scenario=abort   frames=3 kinds=stream_delta,stream_delta,complete
provider=cursor   scenario=busy    frames=4 kinds=stream_delta,stream_delta,protocol_error,complete
provider=cursor   scenario=replay  frames=3 kinds=chat_subscribed,stream_delta,complete
provider=opencode scenario=turn    frames=4 kinds=stream_delta,stream_delta,stream_end,complete
provider=opencode scenario=abort   frames=3 kinds=stream_delta,stream_delta,complete
provider=opencode scenario=busy    frames=5 kinds=stream_delta,stream_delta,protocol_error,stream_end,complete
provider=opencode scenario=replay  frames=4 kinds=chat_subscribed,stream_delta,stream_end,complete
```

全部经真实 `handleChatConnection` 分派、真实 `chatRunRegistry` 排序/重放、生产 `providerRuntimeService` 单例跑，只换进程。

### AC3 非平凡正控制

16 条帧数全部 > 0。正常一轮的 terminal complete（**按有无打印，不按值**）：

```
claude   hasExitCode=true  hasAborted=true  exitCode=0 aborted=false
codex    hasExitCode=false hasAborted=false exitCode=undefined aborted=undefined
cursor   hasExitCode=true  hasAborted=true  exitCode=0 aborted=false
opencode hasExitCode=true  hasAborted=true  exitCode=0 aborted=false
```

**codex 的 `complete` 根本不带 `exitCode`/`aborted`** —— 这是 codex emit 侧的形状，不是投影丢的：基线（接入宿主层**之前**录的）里同样没有，投影也只丢 `id`/`timestamp`。判据因此按「字段在不在」打印，而不是按值，免得把 `undefined` 读成「被宿主层吃掉了」。

忙时那条：4/4 provider 各含 1 个 `protocol_error` 且 `code == 'RUN_IN_PROGRESS'`。重放那条：

```
claude   ackLastSeq=2 replayed=1 kinds=text
codex    ackLastSeq=2 replayed=1 kinds=text
cursor   ackLastSeq=2 replayed=1 kinds=stream_delta
opencode ackLastSeq=2 replayed=2 kinds=stream_delta,stream_end
```

`replayed` 只数 ack 之后 `seq > lastSeq` 的**非 terminal** 帧（terminal complete 是闸门放开后生的，算进去会把重放功劳记到没重放的东西上）。

### AC4 宿主层确实在路径上

正常一轮进行中（闸门关着）取 `sessionHostManager.snapshot()`：

```
claude   session=claude-turn-parity   hosts=1  mode=per-run=1  host-299cf01e…(mode=per-run state=busy)
codex    session=codex-turn-parity    hosts=5  mode=per-run=1  host-57c44de8…(mode=per-run state=busy)
cursor   session=cursor-turn-parity   hosts=9  mode=per-run=1  host-52293faa…(mode=per-run state=busy)
opencode session=opencode-turn-parity hosts=13 mode=per-run=1  host-7c4a42d8…(mode=per-run state=busy)
```

`hosts=N` 递增是 `snapshot()` 有意不裁剪已关闭宿主（关闭原因要留在读数里），所以每轮多一台；关键是**绑定在该会话上的 `mode=per-run` 恰好 1 台**。摘掉 AC-154 的包装则这条为 0 ⇒ 判据红，而不是帧没变就假绿。

同时 16 条逐帧深比较：

```
baseline compared: 16 sequences, 55 frames, 0 differences (projection drops id + timestamp)
```

### AC5 基线录在接入之前

```
leg1 recordedAtCommit=53739649d1c6c953338561fef0d67e6327bbadc0 containsHostModule=false -> PASS
leg2 HEAD=7cc6c6633aa680c0dbf76c505a13328ce2f4b81f containsHostModule=true -> PASS
```

两腿分别打印；任一条不成立时断言文案点名是哪条腿。`$PRE` 的实际读数：`git cat-file -e 53739649…:server/modules/session-hosts/index.ts` → `fatal: path … exists on disk, but not in '53739649…'`，退出 128。

### AC6 比较器自测

```
comparator baseline-minus-last-frame       -> missing frame at #2 {"kind":"complete",…,"exitCode":0,"success":true,"aborted":false,"seq":3}
comparator baseline-plus-synthetic-complete -> extra frame at #3 {"kind":"complete",…,"exitCode":0,"success":true,"aborted":false,"seq":4}
```

两种输入各点名了那一条帧 —— 这是假形态 (a) 检出路径的存在性证明，不是一条永不触发的断言。

### AC7 录制确定性

```
claude/turn    run1=3 run2=3 rawEqual=false equal=true
codex/busy     run1=4 run2=4 rawEqual=false equal=true
cursor/replay  run1=3 run2=3 rawEqual=false equal=true
opencode/turn  run1=4 run2=4 rawEqual=false equal=true
```

`rawEqual=false` 而 `equal=true` 是**投影承重**的读数：不丢 `id`/`timestamp` 两轮就不等，丢了就逐字节相等。判据断言「至少一对 raw 不等」，否则丢字段这件事没人挣得。AC7 的「第一次跑」用的是前面 16 条里已录的那次读数（不是新跑一遍），这样比较横跨整个文件的墙钟、且把判据的驱动数从 24 降到 20 —— 判据在驱动器里有硬超时，机器又常被整队 fan-in 压满（本轮实测 load 215）。

### AC8 假形态 (a)：朴素版本是 no-op，可达形态必红

判据文件一字未动，只改生产实现，测完 `git checkout --` 还原。

**(a-i) 朴素写法 = no-op，被去重吞掉。** 在 `provider-runtime.service.ts` 的宿主关闭时机（`start` 返回的 promise 结算后）经 `observingWriter.send(createCompleteMessage(...))` 补发合成 complete：

```
exit 0   ℹ pass 5   ℹ fail 0        ← 判据照绿，你会以为它在承重
```

**正控制（证明钩子确实活着、被吞的就是去重那一条）：** 同一钩子、同一 writer，只把帧换成 `{kind:'text', content:'variant-a-probe'}`：

```
exit 1   ℹ fail 1
AssertionError: claude/turn: extra frame at #3 {"kind":"text","provider":"claude","role":"assistant","content":"variant-a-probe","sessionId":"claude-turn-parity","seq":4}
```

即钩子真跑了、writer 真到了 socket、还真拿到了 `seq`（=4）。所以 (a-i) 的 no-op 不是「钩子没到」，就是 `chat-run-registry.service.ts:88-92` 的 exactly-one-complete 去重丢的。

**(a-ii) 可达形态：直写连接。** 生产里通往客户端的出口只有一个 —— `ChatSessionWriter`。`send()` 与 `sendComplete()` 都过 `decorateOutboundEvent`（就是那条去重），只有连接级的 `forward()` 不过。所以「直写连接那一支」= 走 `forward`。在宿主关闭时取 `chatRunRegistry.getRun(appSessionId)` 再 `forward` 一份合成 complete：

```
exit 1   ℹ fail 2
AssertionError: claude/turn must end in exactly one terminal complete
AssertionError: claude/turn: extra frame at #3 {"kind":"complete","provider":"claude","sessionId":"claude-turn-parity","actualSessionId":"claude-turn-parity","exitCode":0,"success":true,"aborted":false}
```

红文案点名了多出的那条帧，且它**没有 `seq`** —— 正是绕过注册表的直写签名（和 `protocol_error` 一样直发不带 seq）。

顺带一个更强的结构性读数：`decorateAndRecordEvent` 里 `run.writer.send(message)` **不是**直写 —— `run.writer` 就是那个装饰 writer，`send` 会回头再进 `decorateOutboundEvent`。实测这样写在单条 `claude/turn` 上产生 **2657 次** `decorateAndRecordEvent` 重入（3 次真帧 + 2654 次自噬），既是重入陷阱也不是出口。

### AC9 假形态 (b)：构造的，红在点名那条读数上

常驻侧的真实现今天不存在（AC-157 / AC-159 未落地），所以这条是**构造出来的**，不是真回归。做法：`chat-websocket.service.ts` 忙时分支 (`:235-247`)，当该会话有活 run 时，走「把新输入写进活着的进程、不再拒绝」的常驻规则，于是不再发 `RUN_IN_PROGRESS`；帧流上表现为恰好少一帧。

```
exit 1   ℹ fail 2
AssertionError: claude/busy must carry exactly one RUN_IN_PROGRESS protocol_error for the refused second send (found 0; kinds=text,text,complete)
AssertionError: claude/busy: missing frame at #2 {"kind":"protocol_error","code":"RUN_IN_PROGRESS","error":"Session \"claude-busy-parity\" already has a run in progress.","sessionId":"claude-busy-parity"}
```

### AC10 生产面零改动

`git diff --name-only develop...HEAD` = 恰好 4 个文件（判据、驱动、录制器、fixture），全部在 Touches 里；`server/modules/providers/list/**`、`server/modules/websocket/services/**`、`provider-runtime.service.ts` 一个都没有。两个假形态的临时改动均已 `git checkout --` 还原，`git status --short` 干净。

### AC11 契约面不被改窄

`npm run typecheck` → exit 0（三条 tsc 全过）。`npm run lint` → exit 0（输出里没有本条的任何一个文件）。既有 `chat-run-registry.test.ts` → exit 0（9 pass / 0 fail）；`chat-edit-send.test.ts` → exit 0（8 pass / 0 fail）。

### AC12 如实登记

**(a) 四个假进程的形态与出处。** 四者都只在**进程层**伪造，provider 对象、`ProviderRuntimeContext`、`handleChatConnection`、`chatRunRegistry`、`providerRuntimeService` 全是真的。

- **codex**：`Codex.prototype.startThread` / `resumeThread` 换成返回假 `Thread`（`runStreamed()` 给一个 async generator，按序 yield `thread.started` → `item.completed`(alpha) → `item.completed`(omega) → 等闸门 → `turn.completed`）。机制出处 `server/modules/providers/tests/codex-runtime.test.ts`。`item.completed` 只有 alpha 带 `id`，omega 不带 —— 正因为这个不稳定字段才需要投影。
- **cursor / opencode**：临时目录里写可执行 shim（`chmod 0o755`）并前插 `PATH`，形态照 `opencode-runtime.provider.test.js` 的 `createFakeOpenCodeExecutable`。两者都必须带 `--version` 守卫：opencode 的 runtime 在子进程 `code === null` 时会 `await context.isProviderInstalled()` 探 `opencode --version`，假进程若无视 argv 就地停住，探测会超时 ~5s 并**伪造一条 `error` 帧**污染读数（实测 abort 场景 5254ms + 多一帧；加守卫后 289ms）。cursor 同理。
- **claude**：`CLAUDE_CLI_PATH` 指向临时目录里的假 CLI，按 SDK stream-json 协议输出 `system/init` → `assistant`(alpha) → `assistant`(omega) → 等闸门 → `result`。**「`result` 之后不退出」怎么做到**：闸门是环境变量轮询（`process.env.PER_RUN_PARITY_RELEASE`，10ms 一次，上限 15s），`result` 之后靠 `process.stdin.on('end', …)` 收尾；中断靠 SDK 的 control_request —— 解析 stdin 的 `control_request`，`subtype === 'interrupt'` 时 20ms 后 `process.exit(0)`。**这一条是必须的**：不认 interrupt 的话 claude 那一格会一直停在闸门上直到 15s 上限（实测 abort 15369ms；认了之后 350ms）。
- 四个假自带一份、不 import AC-154 的测试文件；`per-run-frame-scenarios.ts` 不 import `@/modules/session-hosts`（只在注释里提到），所以它也能在 `$PRE` 那棵树上跑（录制器正是这么用的）。

**(b) `$PRE` 的实际 sha 与读数。** `HOST_COMMIT=d911624794e844b5ed9613bf0629a05355405fb3`（`git log --diff-filter=A --format=%H -1 -- server/modules/session-hosts/index.ts`），`PRE=53739649d1c6c953338561fef0d67e6327bbadc0`。`git cat-file -e 53739649…:server/modules/session-hosts/index.ts` **失败**（`fatal: path … exists on disk, but not in '53739649…'`，exit 128）；同一路径在 `HEAD` 上存在。fixture 头 `recordedAtCommit: "53739649d1c6c953338561fef0d67e6327bbadc0"`、`recordedAt: "2026-09-26T12:13:25.240Z"`。录制在仓内临时 worktree `.worktrees/parity-record` 上做（放仓内是为了让 Node 沿父目录找到仓库根的 `node_modules`），录完拷回、`git worktree remove` 清掉。

**(c) 两个假形态的实测退出码与红态文案。** 见上面 AC8 / AC9 两节（含 (a-i) 的 no-op 读数 `exit 0 / fail 0`、它的 `text` 正控制 `exit 1` 点名该帧、(a-ii) 的 `exit 1` 点名多帧、以及 (b) 的 `exit 1` 点名缺 `RUN_IN_PROGRESS` 帧）。两个形态都只改实现、判据文件一字未动，用后还原。

**(d) 投影除 `timestamp` 外还丢了哪些字段、为什么。** 丢的字段是 `id` 与 `timestamp` 两个，逐个有实测理由：同一 provider 同一场景连跑两轮，逐字段比对（`rawEqual=false`）显示**只有**这两个字段变动，其余全稳。`id` 是运行时/假进程侧生成的帧标识，`timestamp` 是墙钟。两者都不是客户端可见语义（前端不按它们做去重或排序 —— 排序用的是 `seq`），故进投影丢弃清单。**`kind` 与 `seq` 永不丢**（比较两者是「逐帧不变」的骨架）；`complete` 的 `exitCode`/`aborted` 与 `protocol_error` 的 `code` 同样永不丢 —— codex 那格 `complete` 里它们**本就不存在**，判据读的是「字段在不在」，不拿投影去糊成统一形状。

**(e) 未实现：** AC-156 的两条 REST、AC-157 的状态机/停机/关闭原因穷举、AC-158 的 1:N 解绑与顶替、AC-159 的 Claude 常驻 driver、AC-160 的调试 agent 场景 op，以及常驻侧的一切。本条不改任何生产代码。

### 一处判据修正（由 AC9 实测换来）

AC9 的实测第一次跑出来，红文案点的是**错的帧**：基线比较报 `missing frame at #3 {"kind":"complete",…}`，而真正消失的是 `#2` 的 `protocol_error`。原因是 `compareFrames` 先比长度、把任何更短的序列都归成「缺了尾巴」。改成**先定位第一处分歧、再分类**：中间少一帧就点名它消失的位置，中间插一帧就点名它落下的位置。改完 (b) 的红文案变成 `missing frame at #2 {"kind":"protocol_error","code":"RUN_IN_PROGRESS",…}` —— 点名点对了。这条修正不是预想的，是假形态实测逼出来的：**如果只登记「变体红了」而不读红文案，这个错归因会被原样留在判据里。**
