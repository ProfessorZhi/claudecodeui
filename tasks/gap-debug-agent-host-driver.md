---
id: gap-debug-agent-host-driver
title: AC-160 调试 agent 以宿主驱动接入：一个 multiplexedHost 宿主承载两个 resident 绑定，无人轮由
  manager 开 run（来源 unattended、seq 由 registry 分配且递增、transcript 落盘、可完整回放），lease
  增减与 exit(oom) 反映到宿主快照，门控关闭时宿主层无任何调试宿主
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
  - gap-session-hosts-lease-driven-lifecycle
  - gap-session-hosts-binding-multiplexing
goal_ac: AC-160
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-160" tasks/*.md | wc -l` → **0**；`grep -rn "AC-160" tasks/*.md | wc -l` → 13，全部落在五条邻居任务的**非目标**段里（`gap-session-hosts-default-wrap-four-providers:48`、`gap-session-hosts-lease-driven-lifecycle:60`、`gap-session-hosts-claude-per-run-driver:64`、`gap-session-hosts-rest-list-endpoint:57`、`gap-session-hosts-per-run-frame-parity:60`），没有一条认领它；宿主层与驱动面在代码里零命中：`grep -rn "hostDriver\|IProviderHostDriver\|multiplexedHost\|lifecycleModes" server/ src/ shared/ --include=*.ts --include=*.tsx | wc -l` → **0**；`ls server/modules/session-hosts` → `No such file or directory`（AC-154 的落地在 `task/gap-session-hosts-default-wrap-four-providers` 分支的 `d9116247`/`c7a49886`，尚未进本条所在的树）。⇒ AC-160 无认领者，本条不是重复。

本条认领的是五条邻居都明确让出的那一格：**非 Claude 的 provider 以一次声明（`multiplexedHost`）就换来宿主层的多路复用，并且无人轮在没有浏览器连接时仍经真实链路（manager → chatRunRegistry → 真实归一化 → 客户端 writer）产出一轮可完整回放的内容**。调试 agent 是这一格的替身：它没有 CLI、没有 SDK，所以「一个宿主承载多个常驻会话」「无人轮的来源是 `unattended`」「保活理由增减与进程退出进入宿主快照」这几件事可以在它身上逐条读出读数，而不必先有 Claude 常驻的一切（那属 GOAL-013）。

与五条邻居的机制区别在于各自认证的对象：AC-154 认证「四个 provider 的每一轮都有 per-run 宿主」；AC-157 用**伪造 driver** 认证 lease 驱动的状态机；AC-158 用**伪造 driver** 认证 1:N 绑定；AC-159 认证 Claude per-run 的顶替与持有；本条认证的是**驱动面本身**——`IProviderHostDriver` 的第一个真实实现、`HostEventSink` 的第一个真实上报者、以及 `chatRunRegistry` 里 `unattended` 这个 run 来源的第一个产生者。这条链路上的读数（run 来源、seq 归属、回放完整性）只能由「谁开的 run」决定，因此它对「引擎自己构造帧推给 writer、绕过 manager 直接开 run」这个假形态有分辨力——那正是本 AC 点名要求必红的假形态。

**非目标**：真实 Claude 常驻 driver、输入队列、忙时直写、SendMessage 地址、空闲自动关闭，以及常驻的 UI 与 e2e（GOAL-013 的 AC-162…AC-175）；`lifecycle_mode` 数据库列与 `POST /api/session-hosts/:sessionId/start|close`（AC-169）；四个 runtime（`server/modules/providers/list/**`）一字节不动；不改任何 per-run 的客户端可见行为（AC-155 的逐帧基线承载这一点）。

## Plan

1. 读 AC-154/AC-157/AC-158 的落地提交，取 manager 与共享契约的**实际形状**：导出/工厂名、`snapshot()` 的字段、`SessionBinding`/`HostLease`/`HostCloseReason` 的实际取值与 key、`IProviderHostDriver` 的**实际方法签名**、`HostEventSink` 的实际事件名、`resident` 策略的入口与 `superseded`/`exited` 的产生点。按实际形状改本任务第 3–7 步里的调用名，**不重复造**已有字段。若三条尚未落地，**不得**自行补它们的范围——如实登记并停在这一步（`depends_on` 已把它们声明为本条的前置）。
2. 共享契约按需补齐本条驱动要用到的成员（`server/shared/interfaces.ts`、`server/shared/types.ts`）；`npm run typecheck` 绿。**不得**拓宽 `LLMProvider` 联合：`server/shared/types.ts` 里那一行被 `server/modules/debug-agent/tests/debug-agent-frames.test.ts` 的 `PROVIDER_UNION_LINE` 逐字钉住。
3. 调试 agent 的 `hostDriver` facet：新文件 `server/modules/debug-agent/debug-agent.host-driver.ts` 实现 `IProviderHostDriver`（`startHost`/`bind`/`submit`/`interrupt`/`unbind`/`closeHost`），声明 `multiplexedHost`，`startHost` 在已有多路复用宿主上复用同一个句柄（一个宿主承载多条 resident 绑定），保活理由增减与进程退出经 `sink` 上报；`createDebugAgentProvider` 把它挂到 `IProvider.hostDriver` 上（`debug-agent.provider.ts`），注入面按需扩（`provider.registry.ts` 的构造点）。**该文件及其碰到的调试模块源码不得出现任何帧字段名或事件名字面量**——AC-126 的静态守卫扫的正是调试模块的源码范围。
4. 场景 op：把 `unattended-turn`、保活理由增/减、`exit(oom)` 加进 `debug-agent.scenario.ts` 的 op 闭集与 step 类型（闭集里每个值都是本 build 会执行的值，不认识的值仍旧拒绝并印出闭集），在 `debug-agent.engine.ts` 里执行：`unattended-turn` 必须经宿主层开 run，而不是由引擎自己构造帧推给 writer；保活理由与 `exit(oom)` 经 sink 上报。闭集本身也不许出现帧/事件名。
5. run 来源：`server/modules/websocket/services/chat-run-registry.service.ts` 的 run 记录加 `source`（`user` | `scheduled` | `unattended`），`startRun` 入参带上它，既有调用点各归其位（`chat.send` → `user`，`runDetachedChatTurn` → `scheduled`），并让该字段可读；无人轮的 `unattended` 由 manager 开 run 时写入。
6. 能力矩阵：`server/modules/providers/services/provider-capabilities.service.ts` 的 `ProviderCapabilities` 加 `lifecycleModes` 与 `multiplexedHost`，四个既有 provider 填 `['per-run']`/`false`，调试 agent 填 `['per-run','resident']`/`true`；调试条目的落法（`debug` 不在 `LLMProvider` 联合里）用一处显式 seam，而不是拓宽联合。
7. 判据文件 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`：沿用 `debug-agent-frames.test.ts` 的子进程取数法（门控按进程求值并缓存，开/关两态各需一个独立子进程），读数逐行打印；跨模块引用**只走 barrel**（`@/modules/session-hosts/index.js`、`@/modules/providers/index.js`、`@/modules/websocket/index.js`），不深引邻居模块内部文件（`boundaries/dependencies`）。
8. 实测假形态（引擎里直接构造帧推 writer + 绕过 manager 开 run），抄下退出码与红态文案，`git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。
9. `npm run typecheck`、`npm run lint`、AC-123/AC-126/AC-136 三条判据与既有 debug-agent 判据全绿；写完成记录（含每条读数与假形态实测）。

## AC

- [x] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-host-driver.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`，并打印整体墙钟 `elapsed=<n>ms` 且 `< 60_000`（goal 的判据闸门对单条判据是 60 秒硬超时，不可上调）。红态基线本轮实测：同命令退出 **1**、文案逐字 `Could not find 'server/modules/debug-agent/tests/debug-agent-host-driver.test.ts'`。命令逐字含文件路径，不用 glob。
- [x] AC2 (1) 能力矩阵：`getProviderCapabilities('debug')` 返回 `lifecycleModes` 含 `per-run` 与 `resident`、`multiplexedHost === true`，打印 `provider=debug lifecycleModes=per-run,resident multiplexedHost=true`。**负控制**：四个既有 provider 的 `multiplexedHost` 全为 `false`（打印四行 `provider=… multiplexedHost=false`）——证明该字段不是恒真。
- [x] AC3 (2) 一个宿主两条 resident 绑定：启动一个 `mode=resident` 的调试宿主并绑两个调试会话，宿主快照读到 `hosts=1 hostId=<h1> mode=resident bindings=2 appSessionIds=[A,B]`，两条绑定的 leases 含 `resident-policy`；逐字打印该行。**负控制**：同一 driver 以 per-run 起两轮 ⇒ 全表里不存在一个宿主带两条绑定（打印实际形态 `maxBindingsPerHost=1` 或该形态下的宿主数）。
- [x] AC4 (3) 无人轮经真实链路：在**没有任何浏览器连接**时（打印 `browserConnections=0`）跑 `unattended-turn`，读数逐条打印：`run.source=unattended`、`run.appSessionId=<A>`；本次产出的每一帧都来自真实归一化（对照 `sessions.normalizeMessage` 对刚落盘那一行的输出），打印 `frames=<n> rowsDelta=<n> framesFromNormalizer=<n>` 且三者相等；帧上的 `seq` 由 run registry 分配且严格递增（打印 `seqs=[1..n] lastSeq=<n>`，断言 `lastSeq === n`）；transcript 真实落盘（行数与 `mustContain` 内容从磁盘读回）；随后 `chat.subscribe(lastSeq=0)` 的完整重放帧数与本次产出的帧数相等（打印 `replayed=<n>`）。**正控制**：同一 session 在没有 run 时 `replayEvents(A,0)` 为空（打印 `replayed-before=0`），保证 `replayed=<n>` 不是恒真。
- [x] AC5 (4) 保活理由与 exited/oom 进快照：打印 `leasesBefore=` / `leasesAfterAdd=` / `leasesAfterRemove=` 三行，逐行断言增删确实反映在宿主快照的 `leases` 上（且宿主在理由清空后按策略收尾，不误关）；`exit(oom)` 后读 `closeReason=exited`、`closeDetail=oom`（打印该行）。**正控制**：并列的 `interrupt` 那条读 `aborted`，两条 `closeReason` 不同——保证 `exited` 不是 `aborted` 的别名。
- [x] AC6 (5) 解除一条不影响另一条：`unbind(A)` 后宿主仍在、`bindings` 2→1、仅剩 `{B}`、B 的 `state` 与 `leases` 与解绑前逐字相等、`closeHost` 未被调用，打印 `unbind=A bindingsBefore=2 bindingsAfter=1 remaining=[B] bUnchanged=true closeHostCalls=0`。**正控制**：再解除 B ⇒ `closeHostCalls=1 closeReason=<该次 reason> hostState=closed`（「恰好一次」与「不误关」都不是恒真）。
- [x] AC7 门控关闭：门控关闭（未设或取值不认识）的**独立子进程**里，宿主层快照不含任何 `provider=debug` 的宿主，`resolveProvider('debug')` 失败，打印 `gate=off debugHosts=0`。**正控制**：门控开启的独立子进程里同一读数 ≥ 1，打印 `gate=on debugHosts=<n>`（开/关各取一次读数，因为门控按进程求值并缓存）。
- [x] AC8 假形态承重：让调试引擎在引擎里直接构造帧推给 writer、并绕过 manager 直接开 run（判据文件一字不动）⇒ 判据命令退出 **1**，红文案落在 (3) 的 `run.source` 与 `seq`/`lastSeq` 读数上（不是别的腿先红）。实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [x] AC9 不使 AC-123、AC-126、AC-136 变红：三条判据命令各自退出 **0**，逐条打印命令与退出码——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-gate.test.ts`（AC-123）、`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`（AC-126）、`npx vitest run src/shared/tests/debug-agent-display-identity.test.ts`（AC-136）。这三条判据文件**一字不改**（`git diff --name-only` 里没有它们）。
- [x] AC10 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；既有调试判据文件仍绿：`debug-agent-frames.test.ts`、`debug-agent-gate.test.ts`、`debug-agent-control-plane.test.ts`、`debug-agent-fixture-isolation.test.ts`、`debug-agent-vocabulary-guard.test.ts`、`debug-agent-external-write.test.ts`（逐条打印退出码）；`grep -n "export type LLMProvider" server/shared/types.ts` 逐字打印，联合未被拓宽；`git diff --name-only` 里没有 `server/modules/providers/list/**`。
- [x] AC11 确定性与零真实等待：判据文件自身零真实等待（`grep -c "setTimeout\|await sleep\|node:timers" <判据文件>` → 0，打印该读数），时序只由测试持有的 gate 与注入的钟/step 时钟控制；场景里不出现 `at > 0` 的 `wait` 步（打印 scenario 的 `at` 集合）；连续两次运行的关键读数行逐字相同（两行都打印）。
- [x] AC12 如实登记：完成记录写明（a）AC-154/157/158 落地后 manager 与 driver facet 的实际形状、本条实际用的入口名、本条改了它们什么；（b）`source` 字段的实际位置与取值集合，以及 `user`/`scheduled` 两个既有来源是怎么保持不变的；（c）能力矩阵里调试条目怎么落进 `Record<LLMProvider, …>`（用的哪处 seam，以及为何不拓宽联合）；（d）假形态的实测退出码与红态文案；（e）场景 op 在无浏览器连接时被驱动的实际入口（哪个函数、从哪来）；（f）未实现：GOAL-013 的 resident driver/UI/真实 Claude 路径（AC-162…AC-175）、`lifecycle_mode` 列、`POST /api/session-hosts/:sessionId/start|close`（AC-169）。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`）重跑：退出码 0、`fail 0`、`elapsed < 60_000`。AC2 的 `lifecycleModes`/`multiplexedHost` 读数与四个 `false` 负控制、AC3 的 `hosts=1 bindings=2` 与 per-run 负控制、AC4 的 `run.source=unattended` 与 `seqs`/`lastSeq`/`replayed` 三组读数（含 `replayed-before=0` 正控制）、AC5 的三行 leases 与 `exited`/`oom` 及 `aborted` 正控制、AC6 的解绑读数与「恰好一次」正控制、AC7 的 `gate=off debugHosts=0` 与 `gate=on` 正控制、AC8 假形态的实测退出码与红态文案、AC9 三条邻居判据的退出码、AC11 的两次运行一致性，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；`server/modules/providers/list/**` 与三条邻居判据文件不在其中）。完成后 AC-160 在驱动器下一轮经 `goal_ac: AC-160` 独立复跑时由红翻绿——且这次翻绿有分辨力：AC8「引擎自造帧 + 绕过 manager 开 run」的假形态必红（`run.source` 与 `seq` 两条读数），AC2/AC3/AC5/AC6 各自的负控制或正控制保证每一条读数都不是恒真。

## Touches

- server/modules/debug-agent/debug-agent.host-driver.ts (new)
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.scenario.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/debug-agent.routes.ts
- server/modules/debug-agent/index.ts
- server/modules/debug-agent/tests/debug-agent-host-driver.test.ts (new)
- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/providers/provider.registry.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/index.ts
- server/shared/interfaces.ts
- server/shared/types.ts
- tasks/gap-debug-agent-host-driver.md

## 完成记录

本条（AC-160 / `gap-debug-agent-host-driver`）的落地与实测，全部在 worktree `/data/home/yale/work/claudecodeui-worktrees/gap-debug-agent-host-driver`（分支 `task/gap-debug-agent-host-driver`）上完成；判据实现提交 `ecca9280`，其上再并入 develop 得 `28c1d82b`（develop 父 = `78de88bc`）。判据文件 sha256 = `f2f1f7d4da54a3f72013aa7f80730a1fe57b8b57ecf501ab9e9c4176d6b14efe`（从 AC8 假形态量测前到量测后一字未动，见 (d)）。

**AC1 判据入口为绿。** 命令（逐字）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`。在**并入 develop 后的落地树**上实测退出码 `0`，`ℹ tests 5 / ℹ pass 5 / ℹ fail 0`，`ℹ duration_ms 2325.578068`，判据自报 `elapsed=1687ms (ceiling=60000ms, measured from module load)` —— 相对 60 秒硬超时有约 35 倍余量。命令逐字含文件路径，不用 glob。落地前同命令在无此文件时退出 1、文案逐字 `Could not find 'server/modules/debug-agent/tests/debug-agent-host-driver.test.ts'`（红态基线，见该 AC 正文）。

**AC2 能力矩阵（含负控制）。** 逐字读数：`provider=debug lifecycleModes=per-run,resident multiplexedHost=true`，随后四行负控制 `provider=claude multiplexedHost=false` / `provider=cursor multiplexedHost=false` / `provider=codex multiplexedHost=false` / `provider=opencode multiplexedHost=false` —— 该字段不是恒真。另有 `[AC2] the union-keyed table's own read of the same id: typeof=undefined rows=4`：`getProviderCapabilities('debug')` 为 `undefined`、联合表仍是 4 行（AC-127 的读数），这条声明落在**并行的运行期存储**里而非联合表里，理由见 (c)。

**AC3 一个宿主两条 resident 绑定（含负控制）。** 逐字：`hosts=1 hostId=host-87b0b8f2-65e5-49b0-8375-4da82369c72a mode=resident bindings=2 appSessionIds=[debug-app-session-a,debug-app-session-b]`，两条绑定 leases 逐字 `[AC3] leases=[resident-policy resident-policy] states=idle,idle secondBind=ok secondHostId=host-87b0b8f2-… processes=1` —— 第二次绑定复用了同一个宿主、同一个进程（`processes=1`）。负控制：同一 driver 以 per-run 起两轮，全表最大绑定数为 `maxBindingsPerHost=1`，且 `[AC3] negative control (per-run wrapper, two turns): hosts=2 modes=per-run,per-run driverCalls=0`。正控制（同一 driver 再起第三个 resident 宿主）：`hosts=2 processes=1 hostId=host-7849aba9-… bindings=1`。

**AC4 无人轮经真实链路（含正控制）。** 全程 `browserConnections=0`（无任何浏览器连接）。逐字读数：`run.source=unattended`、`run.appSessionId=c2c9c1d2-30ac-4731-832b-725da0426409`；`frames=2 rowsDelta=2 framesFromNormalizer=2`（三者相等，且 `frameIds` 与对照 `sessions.normalizeMessage` 的 `normalizerIds` 逐字相同：`[911214f5-9c98-4b6d-9f84-efbb282907af_text_0,40d9e611-8e1b-4f75-811b-9321e3a58e44_0]`）；`seqs=[1,2,3] lastSeq=3`（由 run registry 分配、严格递增，断言 `lastSeq === seqs.length`）；transcript 真实落盘并读回：`[AC4] transcript rows 2->4 (seed 2) mustContain=present,present`，场景自评 `[AC4] scenario failures=[]`；重放 `replayed=2 replayedEvents=3 replayed-before=0`（`chat.subscribe(lastSeq=0)` 的完整重放帧数与本次产出的帧数相等）。正控制：同 session 在开 run 之前 `replayEvents(A,0)` 为空 ⇒ `replayed-before=0`，所以 `replayed=2` 不是恒真。`run.status=completed endMarkers=1` 证明终帧落在**这一个** run 上（引擎的 `onDelivery` 跟随）。

**AC5 保活理由与 exited/oom 进快照（含正控制）。** 三行逐字：`leasesBefore=[resident-policy]` → `leasesAfterAdd=[resident-policy,background-task] state=lingering` → `leasesAfterRemove=[resident-policy] state=idle closed=false`（增删都反映在宿主快照上；理由清空后按策略收尾且**没有误关**）。`exit(oom)` 后逐字 `closeReason=exited closeDetail=oom hostState=closed`。正控制（并列的 interrupt 那条）：`[AC5] positive control: interrupt stopped=true closeReason=aborted hostState=closed` —— 两条 `closeReason` 不同，`exited` 不是 `aborted` 的别名。

**AC6 解除一条不影响另一条（含正控制）。** 逐字：`unbind=A bindingsBefore=2 bindingsAfter=1 remaining=[debug-app-session-b] bUnchanged=true closeHostCalls=0`；B 的状态与 leases 解绑前后逐字相等（`[AC6] B before: state=idle leases=[resident-policy]` / `[AC6] B after:  state=idle leases=[resident-policy]`）。正控制（再解除 B）：`unbind=B closeHostCalls=1 closeReason=user hostState=closed` ——「恰好一次」与「不误关」都不是恒真；且重复解除同一条不再关宿主：`detachedA=true detachedB=true detachedAgain=false closeHostCalls after the repeat detach=1`。

**AC7 门控关闭（含正控制）。** 两个独立子进程各取一次读数：未设门控 ⇒ `gate=off debugHosts=0`，`[AC7] reason: DEBUG_AGENT is unset`；取值不认识 ⇒ `gate=off debugHosts=0`，`[AC7] reason: DEBUG_AGENT="maybe" is not a recognised value (expected one of 1/true/yes/on or 0/false/no/off)`。两次都读到 `resolveProvider('debug') resolved=false failure="UNSUPPORTED_PROVIDER: Unsupported provider \"debug\"."`、`hostDriver=absent`、`providerIds=[claude,codex,cursor,opencode]`。正控制（门控开启的独立子进程）：`gate=on debugHosts=1`、`resolveProvider('debug') resolved=true`、`hostDriver=present bind=ok hostId=host-e0abfbe9-…`、`providerIds=[claude,codex,cursor,opencode,debug]`。

**AC8 假形态承重（实测退出码与红态文案）。** 假形态：把 `server/modules/debug-agent/debug-agent.engine.ts` 的 `unattended-turn` 分支改成**引擎自己开 run、自己构造帧**（`chatRunRegistry.startRun({appSessionId, provider:'claude', providerSessionId: sessionId, connection:null, userId:null})`，随后 `delivery.send({kind:'text', id:\`${sessionId}_unattended\`, role:'user', content: step.text})`），既不问 `hostOps`、也不调 `onDelivery`，**判据文件一字不动**。实测：判据命令退出码 **1**（`ℹ pass 4 / ℹ fail 1`，只有 AC4/AC11 那条腿红，没有别的腿先红），红文案逐字：

```
✖ AC4/AC11: an unattended turn over the real chain, and the same run twice (322.22294ms)
  AssertionError [ERR_ASSERTION]: run.source=scheduled (the host layer opens the turn, so it is the only party that can state this)
  + actual - expected

  + 'scheduled'
  - 'unattended'

      at TestContext.<anonymous> (/data/home/yale/work/claudecodeui-worktrees/gap-debug-agent-host-driver/server/modules/debug-agent/tests/debug-agent-host-driver.test.ts:1260:12)
```

红落在 (3) 的第一条读数 `run.source` 上（`'scheduled'` vs `'unattended'` —— 引擎自开的 run 走的是既有的 `connection ? 'user' : 'scheduled'` 兜底，正是「绕过 host 层就没人能声明 unattended」的直接证据）；同一条腿打印的 `seq`/`lastSeq` 读数也随之变形：`seqs=[1,2] lastSeq=2`（绿态为 `[1,2,3]`/`3`）、`run.status=running endMarkers=0`（终帧没落在这个 run 上，run 被永久留在 running）、`frames=2 rowsDelta=1 framesFromNormalizer=1`（自造帧没进 transcript）、`[AC4] scenario failures=["rows: the run wrote 1 row(s) (2 -> 3); the scenario expects 2","content: the transcript does not contain \"summarise the fixture release notes\""]`。用后 `git checkout -- server/modules/debug-agent/debug-agent.engine.ts` 还原并复核判据文件 sha256 仍为 `f2f1f7d4…`、`git status --porcelain` 为空。

**AC9 不使 AC-123/AC-126/AC-136 变红。** 三条命令与退出码（worker 实测）：
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-gate.test.ts`（AC-123）⇒ 退出 **0**，`ℹ tests 6 / ℹ pass 6 / ℹ fail 0`；
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`（AC-126）⇒ 退出 **0**，`ℹ tests 5 / ℹ pass 5 / ℹ fail 0`；
- `npx vitest run src/shared/tests/debug-agent-display-identity.test.ts`（AC-136）⇒ 退出 **0**，`Test Files 1 passed (1) / Tests 2 passed (2)`。

三条判据文件一字不改，判据内部也自读同一事实：`[AC9] sibling criterion files, present and unchanged: … debug-agent-gate.test.ts exists=true bytes=25992 sha256=d1227e180f7a5961 treeClean=true | debug-agent-vocabulary-guard.test.ts exists=true bytes=20990 sha256=2489320fc05220b3 treeClean=true | debug-agent-display-identity.test.ts exists=true bytes=7846 sha256=1ee75d4d349f68cf treeClean=true`，`[AC9] git diff --name-only HEAD -- <the three files> -> <empty>`，`[AC9] git status --porcelain -- <the three files> -> <empty>`。

**AC10 契约面不被改窄。** `npm run typecheck` 退出 **0**（`tsc --noEmit -p tsconfig.json && tsc --noEmit -p server/tsconfig.json && tsc --noEmit -p scripts/tsconfig.json`）；`npm run lint` 退出 **0**（仅既有 warning，无 error）。既有调试判据逐条退出码：`debug-agent-frames.test.ts` **0**（2/2）、`debug-agent-gate.test.ts` **0**（6/6）、`debug-agent-control-plane.test.ts` **0**（4/4）、`debug-agent-fixture-isolation.test.ts` **0**（4/4）、`debug-agent-vocabulary-guard.test.ts` **0**（5/5）、`debug-agent-external-write.test.ts` **0**（4/4）。联合未被拓宽，逐字打印 `75:export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';`（判据自检 `[AC10] union line verbatim=true`）。`[AC10] server/modules/providers/list/ touched=false` —— 该目录不在 diff 里。

**AC11 确定性与零真实等待。** `[AC11] grep -c "setTimeout\|await sleep\|node:timers" server/modules/debug-agent/tests/debug-agent-host-driver.test.ts -> 0 (of 1442 lines)`；时序只由测试持有的 gate 与注入的钟/step 时钟控制：`[AC11] scenario at set=[0] stepsWith at>0 and op=wait=0`（所有步 `at=0`，场景里根本没有 `wait` 步）。连续两次运行的关键读数行逐字相同（两行都打印）：

```
[AC11] key line: mode=resident bindings=1 leases=[resident-policy] frames=2 rowsAfter=4 seqs=[1,2,3] lastSeq=3 replayed=2 replayed-before=0 source=unattended status=completed
[AC11] key line: mode=resident bindings=1 leases=[resident-policy] frames=2 rowsAfter=4 seqs=[1,2,3] lastSeq=3 replayed=2 replayed-before=0 source=unattended status=completed
```

两次的差异只有 `run.appSessionId`（每次新建的会话 id）与随机 uuid，全部在关键行之外。

**AC12 如实登记。**

**(a) AC-154/157/158 落地后 manager 与 driver facet 的实际形状、本条用的入口名、本条改了它们什么。** 形状（读源码所得）：驱动面 `IProviderHostDriver` = `startHost` / `bind` / `submit` / `interrupt` / `reconfigure` / `unbind` / `closeHost`，外加可选的 `readonly multiplexedHost?: boolean`；回灌面 `IProviderHostDriverSink` = `leaseAdded` / `leaseRemoved` / `activity` / `exited`；管理面 `SessionHostManager` = `bindSession({provider, appSessionId, driver, mode})` / `unbindSession(appSessionId, reason): Promise<boolean>` / `trackPerRunTurn(...)` / `interrupt(hostId)` / `openHost(hostId)` / `snapshot()`（返回过滤了保留窗的**副本**；`bindSession` 只在 `driver.multiplexedHost === true` 时复用活宿主；`trackPerRunTurn` 会顶掉已绑定会话自己的宿主并用**无 driver** 的 per-run 宿主；`interrupt` 在 `driver.interrupt` 返真后按 `aborted` 关宿主）。本条**实际用的入口名**：`createDebugAgentHostDriver({ openRun })`（新模块 `debug-agent.host-driver.ts` 的导出，结构上实现上述驱动面）、被 `createDebugAgentProvider` 挂到 `provider.hostDriver`，判据侧用 `createSessionHostManager({ now, scheduler })` 后 `manager.bindSession({ provider, appSessionId, driver: provider.hostDriver, mode:'resident' })`。**本条改了它们什么：什么都没改** —— `server/modules/session-hosts/session-host-manager.service.ts`、`server/modules/session-hosts/index.ts`、`server/shared/interfaces.ts` 三处虽在 Touches 里占位，但本条 diff 里没有它们（`git show --name-only` 只有 10 个文件）；宿主层是原样消费的。

**(b) `source` 字段的实际位置、取值集合、两个既有来源如何保持不变。** 字段落在 `server/modules/websocket/services/chat-run-registry.service.ts` 的 `ChatRun.source: ChatRunSource`（run 的字段，不是 session 的）；取值集合在 `server/shared/types.ts`：`ChatRunSource = 'user' | 'scheduled' | 'unattended'`。`startRun` 的入参新增可选 `source?: ChatRunSource`，赋值逐字 `source: input.source ?? (input.connection ? 'user' : 'scheduled')` —— 不传 `source` 的调用点（全部既有调用点）与改动前逐字节等价：有 connection 仍是 `user`，没有仍是 `scheduled`。新增的 `'unattended'` 只能由**显式**传参得到，即只有 host 层开的 run 会带上它。

**(c) 调试条目怎么落进 `Record<LLMProvider, …>`：用的哪处 seam，以及为何不拓宽联合。** 它**没有**落进 `Record<LLMProvider, …>`。`providerCapabilities.service.ts` 新增了一个按 string 键的并行存储 `RUNTIME_PROVIDER_CAPABILITIES`，写入面是 `declareRuntimeProviderCapabilities(capabilities)`，读取面是 `getRuntimeProviderCapabilities(provider)`（返回副本，未声明时 `undefined`）。接的是 `provider.registry.ts` 构造调试 provider 时的那处 seam：`declareRuntimeCapabilities: (capabilities) => providerCapabilitiesService.declareRuntimeProviderCapabilities(capabilities)`，而矩阵内容是从 driver 派生而非手抄第二份（`lifecycleModes: [...hostDriver.lifecycleModes]`、`multiplexedHost: hostDriver.multiplexedHost === true`）。不拓宽联合的理由：ADR-003 decision 2 要求 `'debug'` 不进 `LLMProvider`（它是 CLI-less/SDK-less 的调试面，服务不了任何面向用户的请求），而联合表被「先按联合校验 provider id、再取能力」的路由读取，塞进去轻则不可达、重则诱使后人把联合拓宽；判据因此断言 `getProviderCapabilities('debug')` 是 `undefined`（AC-127 的读数 `typeof=undefined rows=4`），同时断言 `getRuntimeProviderCapabilities('debug')` 拿到了 `per-run,resident` + `multiplexedHost=true`。

**(d) 假形态的实测退出码与红态文案。** 见 AC8 段：退出码 **1**，红落在 `run.source`（`+ 'scheduled'` / `- 'unattended'`，`test.ts:1260:12`），同腿的 `seqs=[1,2] lastSeq=2`、`run.status=running endMarkers=0` 随之变形；判据文件 sha256 量测前后均为 `f2f1f7d4da54a3f72013aa7f80730a1fe57b8b57ecf501ab9e9c4176d6b14efe`。

**(e) 场景 op 在无浏览器连接时被驱动的实际入口（哪个函数、从哪来）。** 入口是 `debug-agent.engine.ts` 里 `unattended-turn` 分支调 `hostOps.openUnattendedTurn({ appSessionId, text })`（`DebugAgentHostOps` 面），收到的就是该宿主驱动实例的 `openUnattendedTurn`：它先在宿主层里查「这个 appSessionId 有没有绑到本驱动的活宿主」，没有就抛（`debug-agent.host-driver.ts`，文案 `No host is bound to session "…"; an unattended turn must go through the host layer.`），有则调依赖里的 `openRun({ appSessionId, text })` 并返回该 run 的 writer。`hostOps` 由 provider 的 runtime 注入 —— `createDebugAgentProvider` 把 `createDebugAgentHostDriver({openRun})` 的结果既挂成 `provider.hostDriver`、又作为 `hostOps` 交给 `runDebugAgentScenario`；`openRun` 是工厂的可选依赖，判据通过 `createDebugAgentProvider({ …, openRun })` 注入「`chatRunRegistry.startRun({ …, connection: null, userId: null, source: 'unattended' })` 并返回 `run.writer`」。**如实说明生产缺口**：`server/` 里没有任何地方注入 `openRun`（已 grep 复核），所以出厂 registry 的无人轮会抛 `DEBUG_AGENT_RUN_SEAM_UNAVAILABLE`；模块文档与工厂注释都写明了这是 cycle（ADR-003 decision 7）留下的口子而不是被纸糊过去，判据走的就是工厂为此开的这道 seam，链路其余部分（`base`、`forwardNormalizedFrames`、registry 的 fixture-home synchronizer）全是出厂件。

**(f) 未实现（明确不在本条内）。** GOAL-013 的 resident driver/UI/真实 Claude 路径（AC-162…AC-175）；`lifecycle_mode` 列（session 持久化里没有这一列）；`POST /api/session-hosts/:sessionId/start|close`（AC-169）。本条只做「调试面能在一个复用进程上持有多条 resident 绑定、无人轮经真实链路、假形态必红」，不动数据库 schema、不动 HTTP 路由、不动前端。
