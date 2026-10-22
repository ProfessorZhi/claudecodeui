---
id: gap-resident-ondemand-start-uses-bind-session
title: 常驻状态条的 [启动]/[重新启动] 对真实 claude 会话恒不可达：/start 把「复用活进程」的 bindSession
  当成「按需开一个进程」用 ⇒ 别的 claude 常驻宿主存在时 409 host-not-multiplexed、不存在时
  driver.startHost 抛 opened-without-a-process；前端又把整个响应吞掉（sessionHosts.start 不读
  response.ok，actionError 只渲染在已关闭的 popover 内）⇒ 用户只看到点了没反应。修法：driver 加可选
  startResidentSession + providers 层组装冷启动 options + 路由换入口 + 前端如实就地报错
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-30）：`grep -rn '^goal_ac: *AC-169' tasks/*.md | wc -l` → **1**（唯一认领者是 `gap-lifecycle-mode-matrix-and-host-api` 自己）；`grep -rln 'startResidentSession' tasks/ server/ src/ | wc -l` → **0**（全库无此机制）；`grep -rln 'host-not-multiplexed' tasks/ | wc -l` → **2**，逐条核对：`gap-session-hosts-binding-multiplexing`（AC-158，done）建的是**复用规则本身**（多路 driver 下同一宿主承载两条绑定、解绑不误关、最后一条恰好一次 closeHost），`gap-claude-resident-remote-control-isolation` 只在拒绝臂里带过该 code —— 两条都不是「按需启动走错了入口」这个机制。`grep -rln 'data-resident-start' tasks/ | wc -l` → **0**。⇒ 本条机制无认领者，不是重复。

**现象（人 yale 2026-09-30 报告）**：会话内状态条显示 `Resident · Not running（No resident host is running for this session; the last server stop or restart dropped it.）`，右边那个 [Start] 按钮点下去**没有任何反应**。

**实测读数（本轮，对运行中的 :3001；只读方式取 `jwt_secret` 临时签发 5 分钟 token，用完即毁；未落任何副作用）**

- `GET /api/session-hosts` → 200，`data.hosts.length = 6`、`data.sessions.length = 3004`；其中 `lifecycleMode === 'resident' && running === false` 的会话 **10** 个，`reason` 逐字即上面那句（常量在 `server/modules/session-hosts/session-hosts.routes.ts:173` 的 `RESIDENT_NOT_RUNNING_REASON`）。
- 对其中一个真实常驻会话复现按钮发出的同一条请求：`POST /api/session-hosts/971428c4-ba9a-4352-bf57-0672ce033cf2/start` ⇒ **409**，body 逐字 `{"success":false,"error":{"code":"LIFECYCLE_MODE_HOST_UNAVAILABLE","message":"Session \"971428c4-ba9a-4352-bf57-0672ce033cf2\" could not be bound to a host (host-not-multiplexed)."}}`。该请求被拒，**没有拉起任何进程**。
- 负控制：`POST /api/session-hosts/does-not-exist-yale/start` ⇒ 404 `SESSION_NOT_FOUND` —— 证明路由、鉴权、body 解析这条链本身是通的，409 不是「路由没挂上」。

**前端为什么连一个字都不显示（两条互相独立的吞咽）**

1. `src/shared/api.ts:406-411` 的 `sessionHosts.start/close` 直接把 `post()` 拿到的**裸 `Response`** 返回，从不调 `readApiJson`；`src/shared/hooks/useSessionHosts.ts:356-364` 的 `start`/`close` 也从不读 `response.ok`（该文件 `readApiJson` 出现 2 次，全在 listing 读路径 `:62-63`；`.ok` 出现 **0** 次）。⇒ 4xx/5xx **正常 resolve**：`ResidentStatusBar.tsx:193-206` 的 `runAction` 捕不到任何东西、`actionError` 保持 `null`、快照不变、DOM 与 `data-resident-*` 一字不差，视觉上就是「没反应」。
2. 即便 `actionError` 被写上了，那段 `<p data-resident-action-error>`（`ResidentStatusBar.tsx:393-397`）渲染在 portal 面板**内部**，而面板只在 `isOpen && anchor` 时才存在（`:317`）—— 收起态永远显示不出来。所以这一层今天**没有任何一条路**能把拒绝告诉用户。

**后端为什么必然失败（这才是根因）**

`server/modules/session-hosts/session-hosts.routes.ts:343` 把 start 交给 `sessionHostManager.bindSession()`。而 `bindSession` 的语义是「**哪个活进程能接这个会话**」（`session-host-manager.service.ts:902-925`）：它先 `findReusableHost(provider, mode)`（`:1000-1009`）取同 provider+mode 的最新活宿主，driver 只要没声明 `multiplexedHost === true` 就回 `host-not-multiplexed`（`:923`）。claude 常驻 driver 逐字 `readonly multiplexedHost = false`（`claude-host-driver.provider.ts:1830`）⇒ **只要还有任何一个别的 claude 常驻宿主活着**，start 恒 409 —— 而「别的常驻会话还活着」正是用了一段时间之后的常态（本机 listing 里就有多个）。

而**没有**别的宿主时这条路同样是死的：`bindSession` 落到 `openHost`（`:919`）→ `driver.startHost`，常驻 driver 在 `this.pending === null` 时直接抛 `Resident host ${host.hostId} was opened without a process; a resident host is started by the driver's run entry.`（`claude-host-driver.provider.ts:1964`），经 `asyncHandler` 变成 5xx。

这不是隐藏行为，是 driver 自己文件头逐字写下的契约：`:60-66`「## Why a fresh start asks for a host rather than a binding —— `openHost`, not `bindSession`… 对不 multiplex 的 driver，`bindSession` 的答案就是拒绝」，`:576-577` 又写「`bindSession` 只透传给 per-run driver」。常驻进程真实的诞生路径是 `run()`（`:1909`；`:2749` 先 spawn、再拿真 pid 调 `openHost`），它需要一轮 turn + writer + `ProviderRuntimeContext`。**路由根本没有这条路径**，所以 `/start` 对真实 claude 常驻会话无解 —— 不是偶发失败，是恒不可达。

**为什么两个已验收的判据都读不到（它能带着 achieved 活到今天的原因）**

<!-- dedup-ref --> AC-172 的 e2e 走**调试 agent** 替身，它的 driver 逐字 `multiplexedHost: true`（`server/modules/debug-agent/debug-agent.host-driver.ts:739`）⇒ `bindSession` 复用成功，`host-not-multiplexed` 分支永不触发。AC-169 的判据（`server/modules/session-hosts/tests/lifecycle-mode.test.ts:87-98`）用的假 driver，`startHost` 是**空实现**（其注释自己写着「a driver that starts nothing and a driver that starts a process are the same」）⇒ `openHost` 不抛，`:535` 的 (4a)「start 拉起宿主」绿。两个替身各自把这件事的一个前提替掉了：一个是「多路复用」，一个是「进程必须已由 run 起来，`startHost` 才会成功」。`tasks/gap-lifecycle-mode-matrix-and-host-api.md:40` 逐字记着当初的设计决定（「**resident** 才解析该 provider 的 `hostDriver` 并 `manager.bindSession({provider, appSessionId, driver})`」）—— 所以这不是实现走样，是**当初选错了入口**，而选错的原因恰恰是替身不需要真进程。

**要建的东西（最小充分集）**

1. **driver 侧的按需启动动词**：`server/shared/interfaces.ts` 的 `IProviderHostDriver` 加**可选** `startResidentSession?(appSessionId: string, …): Promise<{ hostId: string; pid: number | null }>`，语义是「为这个会话开它**自己**的常驻进程」，与 `multiplexedHost` 正交（后者管的是**复用**，不管开不开）。claude 常驻 driver 用**空输入队列**复用既有 `startResidentHost`（`claude-host-driver.provider.ts:2621`）：不推任何轮次消息、不开 round、不写 writer，`openHost` 拿到的仍是 spawn 出来的真 pid。
2. **冷启动 options 的组装（本条的承重件）**：`startResidentHost` 的入参 `turn.options` 今天是**客户端给的**（`chat-websocket.service.ts:309-353` 组 `runtimeOptions`：`model`/`effort`/`permissionMode` 来自 composer，`cwd`/`projectPath` 回落 `session.project_path`）。无轮启动必须在服务端组装出「下一轮本来会带的 options」：`sessionId` 与 `cwd`/`projectPath` 取自会话行，`model`/`effort`/`permissionMode` 取 `providerModelsService` 的**已存值**（`chat-websocket.service.ts:317-330` 每次发送都写这三个）。这个组装属于 providers 层，**不得**写进 `session-hosts` —— 该模块的设计是只经注入缝读外部事实（见 `session-hosts.routes.ts:196-215` 的 `SessionReader` 理由），自己读库会破坏它「不 import providers、不读 sessions 仓储」的边界。
3. **路由换入口**：`POST /:sessionId/start` 不再走 `bindSession`，改走第 2 条那条按需启动缝；缝由 `server/index.ts`（组合根，两边都 import）注入，沿用既有 `resolveHostDriver` 的理由与形状（避免 `session-hosts → providers` 闭环，逐字理由见 `tasks/gap-lifecycle-mode-matrix-and-host-api.md:41`）。
4. **前端如实报错**：`sessionHosts.start/close` 经 `readApiJson`（失败抛 `ApiRequestError`，带服务端 `code`/`status`/`message`）；`actionError` 改在状态条**本体旁**（popover 之外）渲染，使收起态也可见；成功路径行为一字不变。
5. **判据（承重）**：见 AC —— 必须用**真实 `ClaudeResidentHostDriver`** 驱动（经 driver 既有的 `createProcess` 缝注入假 SDK 进程，**不 spawn 真 cli**），并在「另一个 claude 常驻宿主已存活」的前提下断言第二个宿主被开出。

**非目标**：不改 AC-169 与 AC-172 已验收判据的文本本身（AC-169 的 (4a) 用空实现假 driver 是否算判据洞，是**人**的裁定；本条只如实登记并把有分辨力的新判据立起来）；不动 `bindSession` 的复用规则（它对 turn 派发是对的）；不动 `close` 的入口选择；不给 claude 以外的 provider 加常驻；不碰 `multiplexedHost` 的语义；不做「忙宿主上按需启动」这类新策略。

## Plan

1. **先量再改（红态基线）**：在判据内用真 `sessionHostManager` + 真 `ClaudeResidentHostDriver`（`createProcess` 替身）+ 假进程，先复现两条原始拒绝文案：别的常驻宿主存活时的 `host-not-multiplexed`，与无宿主时的 `opened without a process`。同时量一件今天没数的事：**空输入队列能不能让 SDK 进程起来并停在 idle**（`startResidentHost` 里 `queue.push(...messages)` 后进程以 `prompt: queue.stream` 启动）—— 若空队列不足以让 CLI 建会话，就在这一步取数并如实登记，据此决定是否需要带 `resume`/`providerSessionId` 的冷启动形态。读数写进完成记录。
2. `server/shared/interfaces.ts`：加可选 `startResidentSession`，按其既有注释风格写明与 `multiplexedHost` 的正交性、以及「谁负责组装 options」的边界。
3. claude 常驻 driver：把 `startResidentHost` 中与 turn 无关的部分（config dir 与 remote-control 门、model 解析、queue/ledger/stopHook/permissions scope、spawn、`openHost`）抽成共用 launch 路径，让「无轮启动」与「首轮启动」走**同一条**，不复制第二份 launch 代码；按需启动只多一条「空队列 + 无 round + 无 writer」的入口。按 `.agents/skills/backend-module-standards` 执行。
4. providers 层：在 `provider-runtime.service.ts` 加「为某会话组装冷启动 options 并调 driver 按需启动」的入口（复用既有 `createRuntimeContext`，`providerModelsService` 读已存 model/effort/permissionMode）；`server/index.ts` 把它作为新依赖注入 `createSessionHostsRouter`。
5. `session-hosts.routes.ts`：`/start` 换入口，**保留**既有三种拒绝与其具名 code（404 `SESSION_NOT_FOUND` / 409 `LIFECYCLE_MODE_NOT_RESIDENT` / 409 `LIFECYCLE_MODE_HOST_UNAVAILABLE` 与「已运行 ⇒ 成功而非拒绝」的幂等语义），这些读数今天的判据就在读，一条都不许回退。
6. 前端：`api.ts` 的 start/close 走 `readApiJson`；`useSessionHosts` 不再吞；`ResidentStatusBar.tsx` 把 `actionError` 移到 popover 之外并加「启动中」态，与 `data-resident-*` 属性对齐便于判据读。按 `.agents/skills/frontend-module-standards` 执行。
7. 判据文件：新增 server 侧两条 + 前端一条（见 AC），每条都带自己的假形态臂与正控制。

## AC

- [x] AC1 真实 driver 的按需启动：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-ondemand-start.test.ts` 退出 0；`fail 0`。读数：在**已有一个 claude 常驻宿主存活**（同 provider 同 mode、`multiplexedHost === false`）的前提下对**第二个**会话调按需启动 ⇒ 成功、`snapshot()` 里宿主数 **+1**、新宿主的 `bindings` 含第二个会话、`pid` 等于注入假进程给的 pid（并排打印两行）。**正控制**：同一会话重复调用是幂等成功（同一 `hostId`、宿主数不再涨）。**假形态**：把入口改回 `bindSession` ⇒ 必须红，且红在「宿主数未 +1 / 抛 `host-not-multiplexed`」这条读数上。
- [x] AC2 路由层：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-ondemand-start-route.test.ts` 退出 0；`fail 0`。读数：`POST /api/session-hosts/:sessionId/start` 在 AC1 的前提下返回 **200**，且该会话在随后 `GET /api/session-hosts` 的投影里 `running === true`（打印该行）；同时**逐条复跑**既有三条拒绝并并排打印其 code，要求互不相同：per-run 会话 409 `LIFECYCLE_MODE_NOT_RESIDENT`、provider 无 driver 409 `LIFECYCLE_MODE_HOST_UNAVAILABLE`、不存在 404 `SESSION_NOT_FOUND`。**假形态**同上：入口改回 `bindSession` ⇒ 必红在 200 那条断言上。
- [x] AC3 前端不吞拒绝、且收起态可见：`npx vitest run src/modules/chat/tests/residentStatusBarStartRefusal.test.tsx` 退出 0。读数：服务端回 409（`success:false`，`message` 为具名那句）时，**popover 未打开**的状态条上 `[data-resident-action-error]` 的 `textContent` **逐字包含**该 message，且 `data-resident-ui-state` 仍为 `unstarted`、`[data-resident-start]` 仍在（并排打印）。**正控制**：服务端回 200、listing 随后变为 running 时，不出现错误文本且 `[data-resident-start]` 消失。**假形态**：把 `sessionHosts.start` 的 `response.ok`/`readApiJson` 检查删掉 ⇒ 必须红在「错误文本不存在」这条断言上。
- [x] AC4 不回归：`npx vitest run src/modules/chat/tests/residentStatusBarLeaseSummary.test.tsx src/modules/chat/tests/residentStatusBarCloseReachable.test.tsx src/modules/chat/tests/residentComposerEnableAffordance.test.tsx` 与 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/lifecycle-mode.test.ts server/modules/session-hosts/tests/session-host-bindings.test.ts` 全部退出 0（AC-169/AC-158/AC-172 的既有读数一条不掉）；`npm run typecheck` 与 `npm run lint` 退出 0，读数写进完成记录。

## DoD

真浏览器里对一个 claude 常驻会话点状态条的 [启动]：**真的开出该会话自己的常驻进程** —— `GET /api/session-hosts` 读回该会话 `running: true`、新 pid、`bindings` 含该会话，且这台机器上**同时还有别的 claude 常驻宿主**（这正是今天必 409 的场景，也是本条与「碰巧只有一个宿主」的区别所在）。失败时（per-run / provider 无 driver / 会话不存在 / driver 拒绝）拒绝原因**逐字出现在收起态的状态条上**，用户不需要点开 popover 才能知道为什么。回归面：AC-169、AC-158、AC-172 的既有判据逐条重跑仍绿，`npm run typecheck`、`npm run lint` 绿，改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐）。新判据必须有分辨力，且这一点要**实测**而不是声称：把路由入口改回 `bindSession` ⇒ AC1/AC2 必红；删掉 `sessionHosts.start` 的响应检查 ⇒ AC3 必红；两条反向读数都写进完成记录。

- 该轴仍暗，理由：本条是入口选错 + 前端吞咽的缺陷修复，不引入新的架构面，L_D/L_G 两组读数均未量，不编造数值。

## Touches

- server/shared/interfaces.ts
- server/shared/types.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/session-hosts/session-hosts.routes.ts
- server/index.ts
- src/shared/api.ts
- src/shared/hooks/useSessionHosts.ts
- src/modules/chat/transcript/ResidentStatusBar.tsx
- server/modules/providers/tests/claude-resident-ondemand-start.test.ts (new)
- server/modules/session-hosts/tests/resident-ondemand-start-route.test.ts (new)
- src/modules/chat/tests/residentStatusBarStartRefusal.test.tsx (new)
- tasks/gap-resident-ondemand-start-uses-bind-session.md

## 完成记录

**改动（本分支）**

- 实现 `3123e563`：`server/shared/types.ts`（`HostResidentLaunch` = `options` + provider 侧 `context`；`HostResidentStartResult` = `hostId` + 可空 `pid`）、`server/shared/interfaces.ts`（`IProviderHostDriver` 加**可选** `startResidentSession?`，注释写明与 `multiplexedHost` 正交、options 由调用方组装）、`claude-host-driver.provider.ts`（按需启动动词**复用**既有 `startResidentHost`，只多一条「空队列 + 无 round + 无 writer」入口，没有第二份 launch 代码）、`provider-runtime.service.ts`（`defaultResidentLaunchOptions` 从会话行取 `cwd/projectPath`、从 `providerModelsService.resolveSessionModel` 取 `model/effort/permissionMode`，**故意不填** `providerSessionId` 让 driver 注入 → `sdkOptions.resume`；公开 `startResidentSession(provider, sessionId)`）、`session-hosts.routes.ts`（`/start` 换入口到注入缝，三条拒绝与「已运行 ⇒ 200」幂等语义逐条保留，**保留** `bindSession` 回落）、`server/index.ts`（组合根注入缝）、`src/shared/api.ts`（start/close 经 `readApiJson`）、`ResidentStatusBar.tsx`（`actionError` 移出 portal 落到状态条本体第二行；新增 `startPending` → `data-resident-start-pending` + `disabled`）。
- 判据 `41b12fb8`：`claude-resident-ondemand-start.test.ts`(AC1)、`resident-ondemand-start-route.test.ts`(AC2)、`residentStatusBarStartRefusal.test.tsx`(AC3)。

**AC1 读数**（真 `ClaudeResidentHostDriver` + 注入假进程 pid 4242；`tests 3 / pass 3 / fail 0`）

```
ondemand-start refusal#1 entry=bindSession liveHost=1 code=host-not-multiplexed liveHosts=1 spawns=1
ondemand-start refusal#2 entry=bindSession liveHost=0 liveHosts=0 spawns=0 message="Resident host host-807ef3d9-… was opened without a process; a resident host is started by the driver's run entry."
ondemand-start before hostId=host-72db413c-… mode=resident provider=claude pid=4242 state=busy bindings=[ac1-ondemand-held]
ondemand-start after  hostId=host-2cf91a5a-… mode=resident provider=claude pid=4242 state=idle bindings=[ac1-ondemand-second]
ondemand-start idempotent hostId=host-2cf91a5a-… pid=4242 liveHosts=2 spawns=2
ondemand-start cold-start hostId=host-7f98a05b-… mode=resident provider=claude pid=4242 state=idle bindings=[ac1-ondemand-cold]
```

AC1 假形态（driver 入口改回 `bindSession`，`git checkout --` 复原）：腿 (2) 红在 `Error: bindSession refused: host-not-multiplexed`（`claude-host-driver.provider.ts:1939`），腿 (3) 红在 `Resident host … was opened without a process`（`startHost:2012` ← `openHost` ← `bindSession:919`），腿 (1) 仍绿 —— 即红在 AC1 具名的那两条读数上。

**AC2 读数**（`tests 2 / pass 2 / fail 0`）

```
ondemand-route start status=200 data={"hostId":"host-02172ba3-…","sessionId":"ondemand-route-resident","mode":"resident","pid":4242} message=""
ondemand-route listing row {"appSessionId":"ondemand-route-resident","provider":"claude","lifecycleMode":"resident","running":true,"reason":null}
ondemand-route host hostId=host-02172ba3-… pid=4242 state=idle mode=resident
ondemand-route launch cwd=/data/scratch/yale/ondemand-start-route-LRIaV6 model=default keys=[sessionId,cwd,projectPath,model,effort,permissionMode]
ondemand-route idempotent status=200 hostId=host-02172ba3-… launches=1 spawns=1
ondemand-route refusals perRun=409/LIFECYCLE_MODE_NOT_RESIDENT noDriver=409/LIFECYCLE_MODE_HOST_UNAVAILABLE unknown=404/SESSION_NOT_FOUND
```

AC2 假形态（`/start` 的按需分支关掉 ⇒ 入口回到 `bindSession`）：`start status=500 data=null message="Internal server error"`，`console.error` 的因果行逐字 `Error: Resident host host-3b4c8914-… was opened without a process; a resident host is started by the driver's run entry.`，断言 `actual: 500 / expected: 200` —— 红在 AC2 具名的 200 断言上，且成因可归因（不是裸数字）。

**AC3 读数**（`2 passed`）

```
resident-start-refusal pending data-resident-start-pending=true disabled=true
resident-start-refusal refused status=409 message="Session "session-start-refused" is stored as "per-run"; only a resident session can be started on demand." uiState=unstarted pending=false
resident-start-refusal control status=200 uiState=idle startControl=absent
```

AC3 假形态（删掉 `api.sessionHosts.start` 的 `readApiJson`）：红在 `the refusal must be readable with the popover shut`（Expected true / Received null），正控制臂仍绿 —— 即红的正是 AC3 具名的「错误文本不存在」那条。两条读数都打印于断言之前（假形态下也留下现场）。

**AC4 读数**：`npx vitest run` 三个前端文件 `Test Files 3 passed / Tests 6 passed`；`npx tsx --test` 服务端两个文件 `tests 15 / pass 15 / fail 0`（其中 `(4a) start really starts the injected driver and the host appears in the listing` 即 `bindSession` 回落臂，仍绿）；`npm run typecheck` 退出 0（三份 tsconfig）；`npm run lint` 退出 0（两个新判据文件零 finding）。

**如实登记的三件事**

1. **AC2 的 driver 是判据自建的替身，不是生产类**。`boundaries/dependencies` 把「`session-hosts` 侧 import `list/claude/claude-host-driver.provider.ts`」判为 error（该文件在 providers 模块之外的所有引用都为 0，providers barrel 也不 re-export 它），所以本文件**不能**用真 driver。Proposal §5「必须用真实 `ClaudeResidentHostDriver`」由 AC1 满足（AC1 逐字用真类 + 既有 `createProcess` 缝，并量到两条原始拒绝）。AC2 的替身只保留路由正确性与该条假形态共同依赖的那一条性质：**常驻宿主由一次 launch 起来，不是由一条记录起来**（`startHost` 只在它自己的按需动词设了 pending 时接管，其余入口拒绝 —— 这正是真 driver 抛 `opened without a process` 的规则，AC1 逐字量过）。替身的其余成员是 `lifecycle-mode.test.ts` 已有的空实现形状。此限制写在 AC2 文件头。
2. **`src/shared/hooks/useSessionHosts.ts` 只改了文档注释**。吞咽点确实在 `api.ts`（`sessionHosts.start/close` 返回裸 `Response`），hook 的 `.ok` 从来没被读过；Touches 里列出该文件是因为它那句注释（「`readApiJson` 是唯一把拒绝变成 throw 的地方」）在改动前与代码不符。
3. **两条判据都得先给自己造世界**：AC1 把 Remote Control 的 user-settings 读指向自建临时根、并自建并迁移一份 DB（`resolveModelLaunchSpec` 会查 model 目录，裸 runner 上会 `SQLITE_ERROR`）；AC2 跑在自己的 `DATABASE_PATH` 上，并逐字镜像组合根的错误中间件（含 `details` 与 `console.error`），这条镜像正是假形态那 500 能被归因的原因。
