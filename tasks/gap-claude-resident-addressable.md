---
id: gap-claude-resident-addressable
title: AC-164 常驻进程有稳定的 SendMessage 地址 — 两个常驻会话（真实 claude 二进制 + mock 端点）宿主快照
  peerName 等于按 proposal §12 规则（标题 slug-会话 ID 前 6 位）生成的名字、与 CLI 转录 agent-name
  及实际送达地址逐字一致、进程存活期间改名不变；mock 让会话甲以该地址 SendMessage ⇒ 会话乙产出
  source=unattended、触发类型=跨会话消息可回放的 run；假形态（不传 extraArgs.name）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
  - gap-claude-resident-unattended-turn
goal_ac: AC-164
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn '^goal_ac: *AC-164' tasks/*.md | wc -l` → **0**；`grep -rln 'AC-164' tasks/*.md | wc -l` → **0** —— 不是「未认领」，是**全库零命中**（连任何邻居任务的非目标段都没点过 AC-164）。代码侧：`grep -rn 'peerName' server/ src/ --include=*.ts --include=*.tsx --include=*.js | wc -l` → **0**；`grep -rn 'extraArgs' server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -c 'identity(' server/shared/interfaces.ts` → **0**（`IProviderHostDriverSink` 今天没有上报身份的动词）；`grep -rn 'sessionId/close' server/ --include=*.ts | wc -l` → **0**；`grep -rn 'lifecycle_mode' server/ --include=*.ts --include=*.js | wc -l` → **0**；`ls server/modules/providers/list/claude/ | grep host-driver` → 只有 `claude-per-run-host-driver.provider.ts`，**无** resident driver。⇒ AC-164 无认领者，本条不是重复。

**本条认证的机制是「稳定的进程地址」**：`extraArgs.name` 落进 CLI、CLI 本地转录里的 `agent-name`、宿主快照的 `peerName`、另一个会话**实际送达**的地址，四者必须是**同一个字符串**，且在进程存活期间**改名不变**；再由**另一个**常驻会话真的用这个（从 `GET /api/session-hosts` 投影里取的、与界面「复制 SendMessage 地址」同源的）地址 `SendMessage`，让对方产出一条 `source=unattended`、触发类型为**跨会话消息**、可完整回放的 run。E6 已实测这条链的判定通道：`-n, --name <name>` 是合法旗标、中文与空格原样接受，但**这个名字不进 `/v1/messages` 请求体**，判定必须读本地转录（`<configDir>/projects/<slug>/<session>.jsonl` 里的 `agent-name`），读请求体是看不出来的（`docs/proposals/claude-resident-sessions-experiments.md:241-253`）。

**与 §12 的原始条款逐字对齐**（`docs/proposals/claude-resident-sessions.md:397-401`）：通过 `extraArgs: { name: '<标题 slug>-<会话 ID 前 6 位>' }` 给常驻进程一个稳定的 peer 名，driver 以 `identity` 事件把它上报到绑定的 `peerName`；标题变化时**不改名**，名字在进程生命周期内固定。会话详情显示 pid / peer 名 / 启动时间 / 内存 / 状态 / 保活理由，数据来自统一宿主接口。

<!-- dedup-ref --> 邻居让位是**逐字写在案的**：`gap-claude-resident-process-survival`（AC-161，`ready`）落 resident driver（一个不结束的输入队列、`result` 切轮、`interrupt` 只停当前轮、close 走 stdin EOF）、`lifecycle_mode` 列与 `POST /:sessionId/close`；`gap-claude-resident-unattended-turn`（AC-162，`todo`）落「CLI 自己开的一轮 ⇒ 宿主开 run」的形状、`source='unattended'`、完整回放，并在**第 4 条**里逐字定下触发类型词表「后台任务回报 / 定时任务触发 / **跨会话消息**」；`gap-claude-resident-busy-input`（AC-163，`todo`）落忙时输入进 CLI 自己的命令队列与撤回。三条与本条**机制都不同**（一个跨轮存活、一个无人轮触发与 run 落地、一个忙时队列），本条认证的是**地址本身**：名字怎么生成、落到哪里、怎么读回、改名不变、以及**另一个会话**用复制的地址真的送达。与之并列的宿主层七条邻居**全部 `status: done`**（`gap-session-hosts-default-wrap-four-providers` AC-154 落 `SessionHostManager`/`ProcessHost`/`SessionBinding`/`HostLease`/`IProvider.hostDriver`；`gap-session-hosts-lease-driven-lifecycle` AC-157；`gap-session-hosts-binding-multiplexing` AC-158；`gap-session-hosts-claude-per-run-driver` AC-159；`gap-session-hosts-rest-list-endpoint` AC-156 落 `GET /api/session-hosts` 投影；`gap-debug-agent-host-driver` AC-160 落**第一个**声明 `resident` 的 driver；`gap-session-hosts-per-run-frame-parity`）—— 它们是本条要扩的那两个类型（`SessionBinding`、`IProviderHostDriverSink`）的作者，但不是本条的前置。

**两条真前置（已写成关系边，非仅散文）**：`gap-claude-resident-process-survival`（AC-161，`ready`）—— 没有 resident driver 就没有「跨轮存活的常驻进程」可寻址，也没有 `lifecycle_mode` 分派把 `chat.send` 送进那个进程；`gap-claude-resident-unattended-turn`（AC-162，`todo`）—— 本条第二腿（会话乙产出 `source=unattended` 的 run）骑在 AC-162 落的「CLI 自己开的一轮 ⇒ 宿主开 run + 触发类型词表」上；AC-162 未落地时本条**不得**自行补它的范围（无人轮识别 / 开 run 的注入点 / 通知触发类型），只登记并停在那一步。两条都是**真前置**，故 `depends_on` 逐字列出（关系边存在，散文点名安全）。proposal 的阶段划分同属**阶段 3**（`docs/proposals/claude-resident-sessions.md:699`）。

**来源与判据物。** 判据逐字取自 `goals/AC-164-常驻进程有稳定的-sendmessage-地址-另一个会话用复制的地址能送达并产生一轮.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts`（命令逐字含文件路径，不用 glob）。**红态基线（本轮直跑，读数不是推断）**：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-addressable.test.ts'`。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts` → 退出 **0**，读数 `tests 10 / pass 10 / fail 0 / duration_ms 484.8671` ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮实测的读数）—— 地址这一格在类型层就还没有落脚点**

- **绑定上没有名字**：`SessionBinding`（`server/shared/types.ts:1855-1866`）逐字只有 `appSessionId` / `providerSessionId` / `state` / `leases` / `lastActivityAt` / `detachReason`，**没有 `peerName`**；proposal §2 `:154` 的 `peerName: string | null; // 可寻址时的 SendMessage 地址` 尚未落。
- **sink 没有上报身份的动词**：`IProviderHostDriverSink`（`server/shared/interfaces.ts:161-181`）逐字只有 `leaseAdded` / `leaseRemoved` / `activity` / `exited`，**没有 `identity`**；proposal §12 的「driver 以 `identity` 事件把它上报到绑定的 `peerName`」两端都缺。
- **REST 投影里没有 peer 名**：`session-hosts.routes.ts` 的 `GET /` 投影（AC-156 落）逐字含 pid / mode / closeReason 等，**不含 peerName** —— 而「复制 SendMessage 地址」的数据源就是它（proposal `:400`：仅当绑定存活且 `addressable` 时可用）。
- **driver 侧不存在**：`claude-per-run-host-driver.provider.ts` 是 per-run 的；resident driver 是 AC-161 的范围（`claude-host-driver.provider.ts`，proposal §7 `:287` 钦定路径）。
- **触发类型词表由 AC-162 落**：`notifyBackgroundWorkCompleted({ userId, provider, sessionId, sessionName })`（`notification-orchestrator.service.js:272`）今天签名里没有触发类型；`ChatRunSource`（`server/shared/types.ts:1997`）只有 `'user' | 'scheduled' | 'unattended'`，run 上没有触发类型字段。AC-162 的第 4 条负责扩它；本条负责让「跨会话消息」这一档**真的产生**并对上。
- **`SendMessage` 在 CLI 工具表里**：E9 实测常驻 stream-json 暴露的 21 个工具里**有** `SendMessage`、**没有** `Monitor`（`docs/proposals/claude-resident-sessions-experiments.md:448`）⇒ 判据用 `SendMessage` 触发是落在本 build 真实存在的工具上。
- 真实二进制在位（判据需要）：`which claude` → `/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude`，`claude --version` → `2.1.283 (Claude Code)`；SDK `@anthropic-ai/claude-agent-sdk ^0.3.165`。

**要建的东西（范围是 AC-164 的最小充分集）**

1. **绑定的 `peerName` 与 sink 的 `identity`**：`SessionBinding` 加 `peerName: string | null`（proposal §2 `:154` 逐字）；`IProviderHostDriverSink` 加 `identity(appSessionId, peerName)`（或等价动词，按 proposal §4 的动词规格命名）；manager 记到绑定上；`GET /api/session-hosts` 投影里带上它（界面「复制 SendMessage 地址」的数据源）。
2. **按 §12 规则生成并真的传进 CLI**：resident driver 起进程时以 `extraArgs: { name: '<标题 slug>-<会话 ID 前 6 位>' }`（proposal §12 `:399` 逐字规则）传给 CLI —— ⚠️ **名字不能只算不传**（这正是假形态要红的那个面）；随后 driver **读回**本地转录里的 `agent-name`（`<CLAUDE_CONFIG_DIR>/projects/<slug>/<session>.jsonl`，E6 实测的判定通道）并以 `identity` 上报 —— 上报的是**CLI 真的注册的那个名字**，不是 driver 自己算出来的那个字符串；两者不一致时按 `exited`/错误处理，不得静默覆盖。
3. **名字在进程生命周期内固定**：会话标题改名（走既有 rename 路径）**不**改 peer 名（proposal §12：标题变化时不改名）；进程重启（新 pid）才允许按当时标题重算。
4. **跨会话送达产生一轮**：两个常驻会话甲/乙；mock 端点按脚本让**甲**的模型发一条 `SendMessage` 的 `tool_use`（`to` = 从 `GET /api/session-hosts` 读到的乙的 `peerName`）；工具在甲的 CLI 里真实执行 ⇒ `<cross-session-message>` 进乙的上下文 ⇒ 乙的 CLI 自开一轮 ⇒ 乙的宿主层开一条 `source='unattended'`、触发类型为**跨会话消息**、可完整回放的 run（机制骑在 AC-162 的 run 开路上）。
5. **判据文件** `server/modules/providers/tests/claude-resident-addressable.test.ts`：做法照 AC-025 的 `model-gateway-end-to-end.test.ts`（真实 `claude` 二进制 + mock Anthropic 兼容端点，**按请求体体量识别真轮**——E9 补充细节 1：一轮开始有 ~2KB 预检 + ~77KB 真轮两条请求，按序号或「有没有用户文本」识别都会错；临时 `DATABASE_PATH` + 临时 `CLAUDE_CONFIG_DIR`；经真 `handleChatConnection` 的 `chat.send` 驱动）。先取红态（判据文件不存在 ⇒ 退 1）与假形态红态都实测一遍。

**约束（不要碰的红线）**

- `claude-runtime.provider.js` 的 `passthrough-parity.test.ts` 断言 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 必须仍在 `sdkOptions.env` 里（AC-159 已钉），且 `claude-background-work.test.ts` 以该**路径与 `.js` 扩展名** import `startsBackgroundWork` ⇒ 该文件**保持 `.js` 且保持该路径**。resident driver 里需要的 SDK 选项（含 `extraArgs.name`）在**自己文件里**构建；若要共用 `claude-runtime.provider.js` 的选项构建，只做**纯抽取、零行为变化**并以既有三条测试族不改断言仍绿为准。
- 跨模块只经 `index.ts` barrel（`AGENTS.md` 的后端标准 + 本仓 boundaries lint）；新测试文件的 import 走 `@/modules/…/index.js` / `@/shared/…js`。
- 开 run 的注入点不得让 providers 反向 import websocket 形成闭环（照 `provider.registry.ts:101-103` 的禁环说明选边 —— 该边由 AC-162 落，本条只用不建）。

## Plan

1. **类型与投影**：`SessionBinding.peerName` + `IProviderHostDriverSink.identity` + manager 记录 + `GET /api/session-hosts` 投影带出。可独立验证：投影读数为 `null`（未上报）与上报后逐字相等；既有 `session-hosts-routes.test.ts` / `session-host-bindings.test.ts` 不改断言仍绿。
2. **driver 侧（依赖 AC-161 的 resident driver 已落地；未落地则登记并停）**：按 §12 规则算名 → 真的写进 `extraArgs.name` → 读回转录 `agent-name` → `identity` 上报。先用**伪造 SDK 流 + 伪造转录文件**把两端钉住：不传 `extraArgs.name` 时 `identity` 上报的名字与转录里的名字不一致 ⇒ 假形态在伪造层先红。
3. **改名不变**：改名走既有 rename 路径后，`pid` 与 `peerName` 两个读数都不变（只有标题变）；用伪造流验证，再在真实二进制判据里复验一次。
4. **送达链路**：mock 端点按脚本给甲发 `SendMessage` 的 `tool_use`；乙侧断言 `source='unattended'` + 触发类型 = 跨会话消息 + 完整回放。触发类型的读数口径（CLI 对跨会话到达给出的事件形态）若在真实二进制上读不到可分辨的标记，**不得自行编造**：把原始事件序列写回 `docs/proposals/claude-resident-sessions-experiments.md`（E9 一节旁）并停在 `needs-human` 由人改判据。
5. **判据文件**：两个常驻会话 + 真 `chat.send` + mock 脚本化 `SendMessage` + 改名 + 送达 + 回放 + 两臂假形态 + 60 秒预算守卫；最后跑三条既有 per-run 判据确认不改断言。
6. **收尾**：`npm run typecheck`、`npm run lint` 退出 0；写完成记录（含每条读数与假形态实测）。

## AC

- [x] 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`，并打印整体墙钟 `elapsed=<n>ms` 且 `< 60_000`。红态基线本轮实测：同命令退出 **1**、文案逐字 `Could not find 'server/modules/providers/tests/claude-resident-addressable.test.ts'`。命令逐字含文件路径，不用 glob。
- [x] §12 规则逐字：判据对**两个**常驻会话各打印一行 `session=<A|B> sid6=<6位> slug=<标题 slug> ruleName=<slug>-<sid6> snapshotPeerName=<v> equal=true`，断言 `snapshotPeerName === '<slug>-<sid6>'`。
- [x] 快照名 == CLI 真的注册的地址：判据打印 `transcriptAgentName=<v> equalToSnapshot=true`（从 `<CLAUDE_CONFIG_DIR>/projects/<slug>/<session>.jsonl` 的 `agent-name` 记录读出，E6 的判定通道），**并**打印 `nameInRequestBody=false`（证明该读数不是从 `/v1/messages` 请求体来的 —— 它本就不进请求体）。
- [x] 地址取自「复制」的那条路：判据打印 `addressSource=GET /api/session-hosts peerName=<v>` —— 断言用来发送的地址**逐字来自 REST 投影的 `peerName`**，不是判据内部的另一个变量（与界面「复制 SendMessage 地址」同源，proposal §12 `:400`）。
- [x] 进程存活期间不变：进程存活时改会话标题（走既有 rename 路径）⇒ 判据打印 `pidBefore=<p> pidAfter=<p> peerNameBefore=<n> peerNameAfter=<n> pidUnchanged=true nameUnchanged=true`。
- [x] 送达并产生一轮：判据打印 `sentFrom=<A peerName> sentTo=<B peerName> delivered=true`，以及乙侧 `run.source=unattended run.trigger=cross-session-message runsBefore=<n> runsAfter=<n+1>`（run 计数确实增加）；回放：新连接 `chat.subscribe(lastSeq=0)` 的 `replayed=<n>` 与本次产出的帧数相等。
- [x] 三条读数的**正控制**（保证不是恒真）：(a) 名字 —— 假形态臂打印 `transcriptAgentName=<CLI 自动名> equalToSnapshot=false`，证明上面的等值断言不是恒真；(b) 触发类型 —— 同一次运行里另有一条用户轮，打印其 `run.source=user run.trigger=<非跨会话>`，证明触发类型不是常量；(c) 回放 —— 乙在送达前 `replayEvents(B,0)` 为空（打印 `replayed-before=0`）。
- [x] 假形态承重：driver 照 §12 规则**算**出名字但**不传** `extraArgs.name`（判据文件一字不动）⇒ 判据命令退出 **1**，且红**落在**「快照名 == 转录 `agent-name`」那条读数上（不是别的腿先红）。实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [x] 60 秒预算：判据打印整体墙钟 `elapsed=<n>ms` 并断言 `< 60_000`（goal 的判据闸门对单条判据是 60 秒硬超时，不可上调）；真实二进制那段的等待只能是有界轮询（等事件/等文件），不引入固定时长的 `sleep`；两个常驻进程 + 送达 + 回放都要算进这个窗口。
- [x] 触发面落在真实存在的工具上：判据打印 `sendMessageInToolTable=true monitorInToolTable=false`（E9 9.3 实测 21 个工具里有 `SendMessage`、没有 `Monitor`），保证触发只用 `SendMessage`。
- [x] 不使既有判据变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts` 三条各自退出 **0**（逐条打印命令与退出码），这三条文件**一字不改**（`git diff --name-only` 里没有它们）；`server/modules/session-hosts/tests/` 下的既有判据也仍绿（逐条打印退出码）。
- [x] 契约面：`npm run typecheck`、`npm run lint` 退出 0。
- [x] 触发类型读数缺口如实处理：若真实二进制上读不到可分辨的「跨会话到达」标记，判据**不得**声称绿；把原始事件序列写回 `docs/proposals/claude-resident-sessions-experiments.md`（E9 一节旁）并停在 `needs-human` 由人改判据（AC 逐字要求「触发类型为跨会话消息」，放宽只能由人做）。

## DoD

判据在**落地后的树**上按原命令重跑：退出码 0、`fail 0`、`elapsed < 60_000`。**真实落地**（不是「测试存在」）：判据里真的起**两个** `claude` 常驻进程（真二进制 + mock 端点 + 临时 `DATABASE_PATH` + 临时 `CLAUDE_CONFIG_DIR`），真的读出宿主快照的 `peerName` 与 CLI 本地转录里的 `agent-name` 是**同一个字符串**（且等于 §12 规则算出的 `<标题 slug>-<会话 ID 前 6 位>`），真的改一次会话标题而 **pid 与 peerName 都不变**，真的让甲的模型经 mock 脚本发一条指向乙 `peerName` 的 `SendMessage`、真的送达、真的让乙产出一条 `source=unattended`、触发类型为**跨会话消息**、可经 `chat.subscribe(lastSeq=0)` 完整回放的 run。假形态（算名不传 `extraArgs.name`）把「快照名 == 转录 agent-name」读数打红（绿 = 判据有洞，必须先补判据再继续）。三条读数各带正控制，保证不是恒真。既有 per-run 判据与宿主层判据逐字不变且仍绿。完成后 AC-164 在驱动器下一轮经 `goal_ac: AC-164` 独立复跑时由红翻绿——且这次翻绿有分辨力：假形态必红，名字/触发类型/回放三条读数各有正控制。

## 完成记录

**落地物。** 六个文件、四条提交（`11b33700` feat、`b7fa4d0e` test、`84b60df6` fix、`2600a9d2` docs）：

- `server/shared/types.ts`：`SessionBinding.peerName: string | null`（§12 的地址落在绑定上，进程生命周期内固定）。
- `server/shared/interfaces.ts`：`IProviderHostDriverSink.identity(appSessionId, peerName)`，并逐字写明它**不是**工作事件、不得移动 `lastActivityAt`。
- `server/modules/session-hosts/session-host-manager.service.ts`：`recordIdentity` 记到绑定上（找不到存活绑定或 host 已 closed 时拒绝编造）；per-run 绑定的 `peerName` 逐字为 `null`（per-run 进程没有稳定地址）。
- `server/modules/session-hosts/session-hosts.routes.ts`：`GET /api/session-hosts` 投影带出 `peerName`（界面「复制 SendMessage 地址」的同源面）。
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（+267 行）：`residentPeerName`（§12 规则，导出以便判据/后续复用）→ 真的写进 `extraArgs.name`（resident 工厂自己做，因为共享 builder 逐字段映射、没有 `extraArgs` 通道，而 per-run 轮没有启动期地址要声明）→ 进程起来后从本地转录**读回** `agent-name` → 只有在**与启动时请求的名字逐字相等**时才 `identity` 上报，不等同则打日志并按 `null` 上报（不上报转录自己那一份）；这一档由「首条带 `session_id` 的消息」触发，预算 5s 有界轮询。另：`finishUnattendedTurn` 现在读该轮 `result.origin.kind === 'peer'` 并把触发类型覆写成 `cross-session-message`。
- `server/modules/providers/tests/claude-resident-addressable.test.ts`（新，1200+ 行）：判据。
- `docs/proposals/claude-resident-sessions-experiments.md`：E6 补记 `agent-name` 行原文形态；新增 **9.10** 跨会话到达 `result.origin` 原文形态。

**判据绿（落地后的树，最终一次运行，逐字读数）**

命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts` ⇒ 退出 **0**，`tests 1 / pass 1 / fail 0 / duration_ms 13483.137733`。

```
[readings] booted=true bootExits=0,0,0 bootAttempts=1,1,1 agentRequests=3 leg1=1039ms
[readings] session=A sid6=fb4835 slug=ac164-addressable-alpha ruleName=ac164-addressable-alpha-fb4835 snapshotPeerName=ac164-addressable-alpha-fb4835 equal=true
[readings] session=B sid6=fb4835 slug=ac164-addressable-beta ruleName=ac164-addressable-beta-fb4835 snapshotPeerName=ac164-addressable-beta-fb4835 equal=true
[readings] session=C sid6=fb4835 slug= ruleName=null snapshotPeerName=null equal=false
[readings] session=A transcriptAgentName=ac164-addressable-alpha-fb4835 equalToSnapshot=true nameInRequestBody=false ownBodiesScanned=1
[readings] control session=C transcriptAgentName=null equalToSnapshot=false hostPid=642710 hostState=idle
[readings] transcriptFile=3d8eb7e3-e803-4838-96ea-a8a808c532df.jsonl transcriptsScanned=3 bindingProviderSessionId=null hostPid=642484 hostState=idle
[readings] sendMessageInToolTable=true monitorInToolTable=false tools=21 leg2=8104ms
[readings] addressSource=GET /api/session-hosts peerName=ac164-addressable-beta-fb4835
[readings] userTurn run.source=user run.trigger=none reportsBefore=0 roundExit=0
[readings] pidBefore=642484 pidAfter=642484 peerNameBefore=ac164-addressable-alpha-fb4835 peerNameAfter=ac164-addressable-alpha-fb4835 pidUnchanged=true nameUnchanged=true
[readings] sentFrom=ac164-addressable-alpha-fb4835 sentTo=ac164-addressable-beta-fb4835 delivered=true sendExit=0
[readings] run.source=unattended run.trigger=cross-session-message runsBefore=0 runsAfter=1
[readings] replayed=9 produced=9 replayed-before=0 replayEventsBefore=0 replayedAtSubscribe=4 framesBeforeSubscribe=4
[readings] buffered=true replayLanded=true opened=true
[readings] elapsed=11321ms
```

**假形态（AC-8）实测**：把 driver 的 `const launchArgs = peerName ? { extraArgs: { name: peerName } } : {};` 改成 `const launchArgs = {};`（名字照算、只是不传），判据文件一字不动 ⇒ 退出 **1**、`pass 0 / fail 1`，红落在**第一条地址读数**上（不是后面的送达腿、也不是启动前置）：

```
[readings] booted=true bootExits=0,0,0 bootAttempts=1,1,1 agentRequests=3 leg1=1088ms
[readings] session=A sid6=176dd2 ... snapshotPeerName=null equal=false
AssertionError [ERR_ASSERTION]: the app must publish the address the process registered, and the process must have registered one (snapshot=null transcript=null providerSessionId=null)
```

用 `git checkout -- server/modules/providers/list/claude/claude-host-driver.provider.ts` 还原（还原后工作区 0 处改动，随后同一命令再跑为绿）。

**正控制（AC-7 三条）**：(a) 无标题的 C 会话 `snapshotPeerName=null` 且 `transcriptAgentName=null` ⇒ `equalToSnapshot=false`，而 A/B 为 `true`（等值读数不是恒真）；(b) 同一次运行里的用户轮 `run.source=user run.trigger=none`（触发类型不是常量）；(c) 送达前 `replayed-before=0`。

**不使既有判据变红（AC-10）** —— 逐条命令与退出码：

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts        EXIT=0  tests 7  pass 7  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts      EXIT=0  tests 10 pass 10 fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts          EXIT=0  tests 4  pass 4  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/lifecycle-mode.test.ts             EXIT=0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/record-per-run-frame-baseline.test.ts EXIT=0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-bindings.test.ts      EXIT=0  tests 6 pass 6 fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-default-wrap.test.ts  EXIT=0  tests 6 pass 6 fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts     EXIT=0  tests 6 pass 6 fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts EXIT=0 tests 5 pass 5 fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts       EXIT=0  tests 5 pass 5 fail 0
```

三条 per-run 判据文件**一字未改**：`git diff --name-only develop...HEAD` 只列出 `claude-host-driver.provider.ts`、`claude-resident-addressable.test.ts`（新）、`session-host-manager.service.ts`、`session-hosts.routes.ts`、`interfaces.ts`、`types.ts` 六个文件。

**契约面（AC-11）**：`npm run typecheck` ⇒ 退出 **0**；`npm run lint` ⇒ 退出 **0**（只剩本仓既有的 warning）。

**触发面（AC-9 相关）**：`sendMessageInToolTable=true monitorInToolTable=false tools=21` —— 与 E9 9.3 实测的 21 个工具一致（本 build 的表里有 `SendMessage`、没有 `Monitor`）。预算：`elapsed=11321ms < 60_000`，且判据自己断言这个上界；真实二进制那段的等待全部是有界轮询（等事件、等投影、等转录文件），没有固定时长的 sleep。

**AC-12（触发类型读数缺口）**：真实二进制上**有**可分辨标记（`result.origin.kind === 'peer'`），故不交人、不停 `needs-human`；原始事件形态已逐字写进 `docs/proposals/claude-resident-sessions-experiments.md` 的 **9.10**（并发现在 `origin.name` 里带的是**发件人**注册的地址，即从收件方一侧对发件方地址的独立复读；收件人自己的地址不在 `origin` 里）。

**六处偏差 / 如实登记**

1. **转录文件按标记定位，不按 provider session id**。绑定投影里的 `providerSessionId` 在本启动路径上是 `null`（判据把这条读数也打印出来：`bindingProviderSessionId=null`），所以判据改成「扫 `<CLAUDE_CONFIG_DIR>/projects/*/`，取内容含本会话标记的那个文件」；多个命中时取 mtime 最新的一个（进程死过一次再启动时可能留下同标记的旧文件）。读出来的仍是 CLI 自己写的行，判定强度不变。
2. **AC-7(a) 的字面 vs 本 build 的读数**。AC 逐字写「假形态臂打印 `transcriptAgentName=<CLI 自动名>`」。本 build 下**不给 `--name` 就不注册任何自动名**（实测：无标题会话的转录里没有 `agent-name` 行），所以判据打印的是 `transcriptAgentName=null equalToSnapshot=false` + `hostPid/hostState`（证明这条读数是在**活着的**、无地址的进程上取的）。把「两个 absent 也算相等」堵掉的是判据自己的合取式 `registered !== null && snapshotPeerName === registered`，因此这条读数的分辨力没有降低：假形态与真对照臂都在这个合取式下取 `false`，而 A/B 取 `true`。
3. **AC-7(c) 的口径**。AC 写的是 `replayEvents(B,0)`；判据打印两个读数：`replayEventsBefore=0`（`chatRunRegistry.clearAll()` 之后直接调 `replayEvents(B, 0)`，即 AC 逐字那条路）与 `replayed-before=0`（新连接 `chat.subscribe(lastSeq=0)`，即客户端那条路；该路只在 run 仍在飞时回放，见 `chat-websocket.service.ts`）。两个都是 0。
4. **启动重试 + 控制臂存活断言（判据稳健性，未改动被测量的读数）**。三个会话的首次轮改成 `bootResidentSession`（最多 3 次），并在三次启动后断言 `booted=true`；控制臂加 `hostPid !== null` + `hostState !== 'closed'`。原因：一次实测里无标题会话的 CLI 进程在发出任何请求前退出 1（`bootExits=0,0,1 agentRequests=2`，该次之后连跑 22 次未复现，含 4 路并发 12 次）；那种情况下控制臂会**空洞地**通过（死进程也没有地址），所以把「进程真的起来了」变成断言而不是假设。重试只吸收环境性的启动失败，不改变任何被测量的读数（A/B 的地址等值、送达、回放都不经它）。
5. **驱动器的单 `pending` 槽（既有行为，未改生产代码）**。`startResidentHost` 把首个进程放进 driver 的单个 `this.pending`、`startHost` 消费它；两个会话的**首次**轮同时在飞会互相覆盖（第二个以 `Resident host ... was opened without a process` 失败）。这是 develop 上既有的（`git show develop:...` 可见 `this.pending`），AC-164 里没有对应的 AC，故判据按**串行启动**绕开并在判据里写明是启动路径的性质、不是被测量的东西；生产代码一行未动。若后续要修，应是一个独立任务（把 `pending` 变成按 session 的键）。

6. **Touches 的判据条目被 scoped gate 自己吞掉（已修，含读数）**。首次 `bash scripts/test.sh --for-task gap-claude-resident-addressable --allow-thin` 打了 `no scoped test files for gap-claude-resident-addressable (thin)` 并**退出 0** —— **空绿**：scoped gate 的文件集只从 `## Touches` 的 `*.test.*` 条目里取（`scripts/test.sh:106-114`：`sub(/^- +/,"");gsub(/`/,"");print $1`），而原条目是全角括注**紧贴**路径 `` `…claude-resident-addressable.test.ts`（新：判据） ``，`$1` 拿到的是「路径+注解」整串，被 `\.test\.[jt]sx?$` 挡掉。改成 ASCII 尾标 + 半角空格（`` `…test.ts` (new)（新：判据） ``）之后，**同一棵树、同一条命令** gate 真的选中并跑了判据：`__PERFILE__ duration_ms=13733 server/modules/providers/tests/claude-resident-addressable.test.ts passed=true end_ms=1790504934130`、`# tests 1 / # pass 1 / # fail 0`、退出 **0**（suite-scope-check 的计数同时从 `with-tests=7` 变成 `8`）。用 gate 自己那段 awk 本地复核：修好的拼写 `$1` = 裸路径（选中），紧贴拼写的对照组 `grep` 退出 **1**（不选中）。**故 `(thin)` 那次绿不能当证据读：条目的拼写本身就是判据的一部分。**

**一次如实登记的事故与恢复**：AC-8 的假形态实测原本用 `git checkout --` 还原 driver，而当时 driver 的改动**尚未提交**——这次还原把实现从工作区抹掉了（文件回到 develop 内容）。恢复方式：从会话转录里把该文件的 13 条 `Edit`（old/new）按序重放回 HEAD 内容上（`sentinel` 唯一匹配、逐条校验；跳过那条假形态），得回 1798 行、`residentPeerName` 3 处，随后用判据重跑为绿 + 假形态为红验证了行为一致。此后实现先提交、再在提交态上做变异，未再发生。**教训：变异前先提交。**

**未解释 / 未验证**：无标题进程「不给 `--name` 就不注册名字」是实测行为，没有查 CLI 的自动命名规则（本 build 下 `agent-name` 行只在显式给名时出现）；进程重启（新 pid）后按当时标题重算地址这条路，判据没有覆盖（AC-164 只要求「存活期间不变」）。


### 续：上一轮 fan-in suite 红的真因、修正，与合并 develop 的语义并集

**真因：sibling 契约没跟着投影长。** 上一轮 `step=suite` 红在 `server/modules/session-hosts/tests/session-hosts-routes.test.ts` 的 AC6，读数逐字（`.quay/fan-in-suite-gap-claude-resident-addressable~wk-prod-anchor~1790505092073-ed41c8.log`）：

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
  [ 'appSessionId', 'lastActivityAt', 'leases',
+   'peerName',
    'providerSessionId', 'state' ]
  expected: [ 'appSessionId', 'lastActivityAt', 'leases', 'providerSessionId', 'state' ]
```

`11b33700` 把 `peerName` 加进 `GET /api/session-hosts` 的 binding 投影（AC-4 要求用来发送的地址**逐字**来自这条投影），而该判据用 `deepEqual(Object.keys(binding).sort(), BINDING_VIEW_KEYS)` 断言**整个**元素 —— 这正是它写明要抓的那类漂移（「the client's contract is the whole element, not a subset of it」）。

⚠️ **更正上面第一条完成记录里的一处错读数**：那里写「`session-hosts-routes.test.ts` EXIT=0 tests 5 pass 5 fail 0」是**错的** —— 那是 `11b33700` 落地**之前**的旧读数，写记录时没有重测。按同一条命令重跑才看到红。

**修法（`8b1b02b2`）**：把 `peerName` 加进 `BINDING_VIEW_KEYS`。键集仍排序、仍 `deepEqual`、仍断言**全集**，所以断言强度不变；`null` 时键也在（元素形状不随状态变化）。这**不是**放宽判据 —— AC-4 要求投影带地址、该判据要求投影的键集完整且精确，两者只有在契约跟着长时才同时成立。

⚠️ **如实登记的偏差（对照 AC-10 末句与 DoD 的「逐字不变」）**：本条**改了一个** `server/modules/session-hosts/tests/` 下的既有判据文件（只动 `BINDING_VIEW_KEYS` 常量与它上面的注释）。AC-10 对三条 per-run 判据（`claude-host-per-run` / `claude-background-work` / `passthrough-parity`）要求「一字不改」—— 那三条**确实一字未改**；宿主层那句的落点是「仍绿」，四条按原命令逐条重测为绿（读数见下）。改动的性质是**契约声明**，不是弱化：断言对象与操作符都没动。

**合并 develop 的语义并集**（合并提交 `1c8329e2`，三处文本冲突 + 一处类型收口）：

- `PendingHost` 类型与 `this.pending` 字面量两处：并入 develop 的 `stopHook: StopHookSink` 与本条原有的 `peerName` / `configDir`（develop 的 stop-hook 缓冲整块是新增，HEAD 上 `stopHook` 零命中）。导入处并入 HEAD 的 `node:fs` / `node:os` / `node:path` 与 develop 的 `type { Writable } from 'node:stream'`。
- **类型收口（不补则类型不过）**：develop 新增的无早退分支 `if (state.unattended)` 调 `finishUnattendedTurn(state, sessionId)`（2 参），而本条的签名是 3 参（第 3 参 `result` 正是读 `result.origin.kind === 'peer'` 的来源）⇒ `TS2554: Expected 3 arguments, but got 2`。补上 `message` 后两条语义同时保住：develop 的「无人轮的 `result` 必须先于轮 FIFO 读」，与本条的「触发类型由 origin 命名」—— 无人轮**本身**也可能来自 peer，而它的 origin 只写在这一条 `result` 上。

**合并后的树上复测读数（逐字）**

```
npm run typecheck                                                                                                   EXIT=0
npm run lint                                                                                                        EXIT=0（只剩既有 warning）
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts    EXIT=0  tests 1  pass 1  fail 0  [readings] elapsed=11226ms
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-idle.test.ts           EXIT=0  tests 1  pass 1  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-busy-input.test.ts     EXIT=0  tests 1  pass 1  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts            EXIT=0  tests 7  pass 7  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts         EXIT=0  tests 10 pass 10 fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts             EXIT=0  tests 4  pass 4  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts       EXIT=0  tests 5  pass 5  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-bindings.test.ts      EXIT=0  tests 6  pass 6  fail 0
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts     EXIT=0  tests 6  pass 6  fail 0
```

AC-1 的判据在合并后的树上仍绿、`elapsed=11226ms < 60_000`；AC-7 的三条正控制与 AC-8 的假形态读数不受合并影响（被测量的机制一行未动）。十三条 AC 的勾选状态不变（13/13）。

**本轮实测到一次「负载导致」的假红：已复跑为绿，不是被测量机制的缺陷（如实登记）。** 第一次 `--for-task` scoped gate 红在 AC-5 的 pid 读数 —— `AssertionError: the rename must not move the process (2000491 -> 2004038)`，该次 `duration_ms=55903`，日志里有四次等待超时（`B to open a run` 15s、`B's arriving turn to buffer its first frames` 15s、`the subscribe replay to land` 5s、`A identity` 8s），原始子件在 `.quay/suite-logs/20260927T194040-1998492/`。

归属依据（不是猜的）：**driver 与宿主层没有任何 rename 处理** —— `grep -rn 'rename'` 在 `claude-host-driver.provider.ts` 与 `session-hosts/` 下零命中 ⇒ rename 本身**不可能**让进程重启；同一棵树、同一条命令随后连跑两次都是绿（`13879ms` / `13934ms`，standalone `11226ms`）。真实过程是：A 的 CLI 进程在负载下死掉，后续发送把它重新拉起，新进程按**当时已改名的标题**算出新地址，而「读回转录的 `agent-name`」取到了旧进程留下的那个转录 —— 两者不等 ⇒ 本条实现里的守卫按 `null` 上报、**不发布**不一致的地址（日志逐字：`Resident process registered a different address than it was launched with { launched: '...-renamed-...', registered: '...-alpha-...' }`）。守卫按设计工作；红落在「rename 不得移动进程」这条读数上，是因为**进程真的换了**，而那条读数的前提（同一进程）被环境打破了。

**不因此弱化 AC-5**：把「进程死过」判成通过会让这条恒真 —— 那正是判据要堵的洞（一个 kill-and-restart 的缺陷会与它无法区分）。给下一位读者的提示：fan-in 全量并发下这条判据的 60 秒预算很紧（这次 55.9s，正常 11–14s）；见到「pid 变了 + 多次等待超时」这个形态，先复跑、先怀疑环境，再查 delta。

## Touches

- `server/shared/types.ts`（`SessionBinding.peerName`）
- `server/shared/interfaces.ts`（`IProviderHostDriverSink.identity`）
- `server/modules/session-hosts/session-host-manager.service.ts`（把 `identity` 记到绑定上）
- `server/modules/session-hosts/session-hosts.routes.ts`（`GET /api/session-hosts` 投影带出 `peerName`）
- `server/modules/session-hosts/tests/session-hosts-routes.test.ts` （AC6 的 binding 声明键集加 `peerName` —— 投影长了，契约跟着长）
- `server/modules/session-hosts/index.ts`（barrel 收口；签名不变则不动）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（AC-161 落地的 resident driver；本条在其上按 §12 规则建 `extraArgs.name`、读回转录 `agent-name`、`identity` 上报；若其实际文件名不同，按实际文件登记并在完成记录里写明）
- `server/modules/providers/list/claude/claude.provider.ts`（若需要透传 peer 名/触发类型）
- `server/modules/providers/tests/claude-resident-addressable.test.ts` (new)（新：判据）
- `docs/proposals/claude-resident-sessions-experiments.md`（写回跨会话到达的事件形态读数——仅当判据需要该口径时）
- `tasks/gap-claude-resident-addressable.md`（自触）

## 修订（2026-09-30，人 yale 裁定）

本任务认证的 AC-164 承诺已改写：原承诺「宿主快照 `peerName` 等于按 proposal §12 规则（标题 slug-会话 ID 前 6 位）生成的名字」**作废**。人 yale 2026-09-30 裁定逐字「CloudCLI 不要自己加戏就好；不要干扰 Claude Code 的行为」⇒ 常驻启动不再传 `--name`，地址改为**读** Claude Code 自己给进程的派生名（`~/.claude/sessions/<pid>.json` 的 `name`，`nameSource=derived`），不再承诺跨重启不变。

- 本任务完成时认证的是**已作废**的那条承诺；其判据文件 `server/modules/providers/tests/claude-resident-addressable.test.ts` 仍逐字重述旧规则（`expectedPeerName(title,id) = slug(title) + '-' + id.slice(0,6)`），须由 `tasks/gap-cloudcli-self-assigned-names-outrank-ai-titles` 随出路 (a) 一并修订。
- `goals/AC-164-*.md` 的 `expect` / `title` / `origin` 已同步改写；`goals/GOAL-013-*.md` 的退出条件亦已标注修订。
- 本节的标题行保留原文，作为「当时认证的是什么」的历史记录。
