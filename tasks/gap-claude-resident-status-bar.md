---
id: gap-claude-resident-status-bar
title: AC-172 真实浏览器里常驻会话的侧栏标记与状态条读宿主接口：未运行/空闲/运行中/exited(oom)
  四态各自成形、计数等于宿主保活理由、popover 复制 SendMessage
  地址并关闭常驻进程、停止只中止一轮、无人轮带触发类型标签且跨会话消息显示发送方（两条假形态必须红）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-api-smoke-human-gate
  - gap-lifecycle-mode-matrix-and-host-api
  - gap-claude-resident-addressable
goal_ac: AC-172
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn '^goal_ac: *AC-172' tasks/*.md | wc -l` → **0**；`grep -rln 'AC-172' tasks/*.md | wc -l` → **1**，唯一命中是 `tasks/gap-claude-resident-consent-gate.md:48` 的**非目标段让位**（逐字「AC-172–175 的状态标记、Running 分组、Shell 禁用、忙时直发」），不是认领。⇒ AC-172 无认领者，本条不是重复。

**来源与判据物。** 判据逐字取自 `goals/AC-172-真实浏览器里常驻会话的状态标记-状态条与关闭按钮反映宿主状态-无人轮带触发类型标签.md` 的 `criterion:`：`npx playwright test e2e/resident-status-bar.spec.ts`（命令逐字含文件路径，不用 glob）。`expect` 逐字（同文件 `:8-12`）：「后端用调试 agent 的常驻场景驱动（不拉起 claude）：未运行、空闲、运行中、exited(oom) 四种状态下，侧栏图标与会话内状态条分别显示 proposal §15.1 规定的形态，状态条的定时任务与监视计数等于宿主保活理由的数目；popover 里能复制 SendMessage 地址并能关闭常驻进程；composer 的停止按钮只中止当前一轮、进程仍在；无人轮前有触发类型分隔标签，跨会话消息显示发送方，且不以用户消息样式显示。取假形态：(a) 状态条读本地状态而不读宿主接口 ⇒ 场景切换状态后读数必须红；(b) 无人轮以用户消息样式显示 ⇒ 必须红。」

**红态基线（本轮直跑，读数不是推断）**：`npx playwright test e2e/resident-status-bar.spec.ts --list` 退出 **1**，stdout 逐字 `Error: No tests found.` / `Make sure that arguments are regular expressions matching test files.` / `Total: 0 tests in 0 files`（`--list` 只做收集、不起 webServer，所以这条读数与判据同为「该文件不存在」这同一个事实）。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑既有 `npx playwright test e2e/model-env-kind-explanations.spec.ts --list` → 退出 **0**，读数逐字 `model-env-kind-explanations.spec.ts:37:3 › model env kind explanations › every kind explains itself in the browser and unset is linked via aria-describedby` / `Total: 1 test in 1 file`。

**现状（本轮实测的读数）—— 常驻的状态面在前端一行都没有，替身也还差三件**

- **判据文件不存在**：`ls e2e/resident-status-bar.spec.ts` → `No such file or directory`；`ls e2e/ | grep -ci resident` → **0**。
- **前端零常驻面**：`grep -rn 'resident' src/ --include=*.ts --include=*.tsx | wc -l` → **0**；`grep -rn 'session-hosts' src/ --include=*.ts --include=*.tsx | wc -l` → **0**（`src/shared/api.ts` 里没有宿主列表的客户端）；`grep -rn 'lifecycle_mode\|lifecycleMode' src/ --include=*.ts --include=*.tsx | wc -l` → **0**。能力矩阵那格的现成读法是 `src/shared/hooks/useProviderCapabilities.ts:63` 的 `useSessionForkingProviders`（AC-171 那条任务要照它写 `useResidentProviders`）。
- **宿主接口只在后端**：`GET /api/session-hosts` 挂在 `server/modules/session-hosts/session-hosts.routes.ts:61`（`server/index.ts:213` 装配），投影 `HostView`（`:24-46`）逐字有 `hostId/provider/mode/state/pid/startedAt/closeReason/bindings`，`bindings[].leases: HostLease[]`（`server/shared/types.ts:1841` 逐字 `turn` / `background-task` / `monitor` / `cron{id,recurring,expiresAt}` / `resident-policy`）。**没有 `peerName`**（`grep -rn 'peerName' server/ src/ --include=*.ts --include=*.tsx | wc -l` → **0**）；**也没有** `POST /:sessionId/start|close`（该路由文件只有那一个 GET，`wc -l` → 98）。
- **消息的 `origin` 在类型层就不存在**：`grep -rn '\borigin\b' server/ src/ --include=*.ts --include=*.tsx` 的 55 处**逐条是 git remote `origin`**（`agent.routes.ts` / `git.routes.ts` / `git.test.ts`），没有一处是消息或转录行的字段 ⇒ §15.6「触发类型与发送方读用户消息的 `origin`」今天没有任何落脚点。
- **调试 agent 的常驻场景已能表达四态里的三态半**：`DEBUG_AGENT_OPS`（`server/modules/debug-agent/debug-agent.scenario.ts:58`）逐字 `exit / grow / keepalive-add / keepalive-remove / row / scroll / unattended-turn / wait`；`exit.detail` 闭集含 **`oom`**（`:112` 的 `DEBUG_AGENT_EXIT_DETAILS`）；`DEBUG_AGENT_KEEPALIVE_KINDS` 逐字只有 **`background-task` 与 `monitor`**（`:104`，注释逐字「These two and no others」）；`unattended-turn` 的 step 形状逐字只有 `{ at, op, text }`（`:145`）——**不带触发类型、不带发送方**，引擎那条分支只写一条无 origin 的 `user` 行（`debug-agent.engine.ts:231-236`）。`keepalive-add` 落成 `{ kind: input.kind, id: input.kind }`（`debug-agent.host-driver.ts:236-238`）。**调试 provider 的能力矩阵已经声明常驻**：`debug-agent.host-driver.ts:263` 逐字 `lifecycleModes: ['per-run', 'resident']` ⇒ 本判据要的 resident 门控不依赖 claude 行的那格。
- **出厂链路里无人轮会抛**：`server/index.ts:227-244` 的控制面 `driveScenario` 走 `providerRuntimeService.run`，而工厂的 `openRun` 缝**没有任何生产注入点**（`debug-agent.provider.ts:207` 逐字 `createDebugAgentHostDriver({ openRun: dependencies.openRun ?? unwiredOpenRun })`，未接时是 `DEBUG_AGENT_RUN_SEAM_UNAVAILABLE`（`:91`）；AC-160 的任务自己登记过这条缺口，逐字「`server/` 里没有任何地方注入 `openRun`…所以出厂 registry 的无人轮会抛」）⇒ 浏览器里要看到无人轮，这条缝得先接上。
- **e2e 的服务器今天不带调试 agent 门控**：`playwright.config.ts:1334-1346` 的 server `webServer.env` 逐字只有 `SERVER_PORT/HOST/DATABASE_PATH/HOME`，没有 `DEBUG_AGENT`；门控关闭时 provider 根本不注册（`server/modules/providers/provider.registry.ts:70-71` 逐字 `if (!isDebugAgentEnabled()) { return false; }`）。而配置**已经会读本次选中的判据文件**：`playwright.config.ts:332` 的 `selectedSpecFiles()`（`:344` 的 `RUN_CEILING_MS` 正用它）⇒「只对含本判据的选择开门」有现成接缝，不必给所有 e2e 开门。
- **判据有 55 秒上限**：`playwright.config.ts:285` 逐字 `const SINGLE_SPEC_CEILING_MS = 55_000;`，其注释逐字「The gate's 60s kill is what `SINGLE_SPEC_CEILING_MS` is derived against」；`SPEC_BUDGET_MS`（`:287`）只有 `mobile-workspace-composer-layout.spec.ts` 一个例外，而那条**没有任何 AC 在跑**（`grep -rln 'mobile-workspace-composer-layout.spec.ts' goals/ | wc -l` → **0**）⇒ 单文件判据必须在 **55s** 内自己结束。
- **停止面已有，但语义是 per-run 的**：作曲家中断面是 `src/modules/chat/composer/ActivityIndicator.tsx:20` 的 `onAbort` 与 `src/modules/chat/composer/PromptInput.tsx:192` 的 `PromptInputSubmit`（`ChatComposer.tsx:722` 用它），`ChatComposer.tsx:370` 逐字 `t('input.stop')`。§15.4 要求常驻会话里它只调 `interrupt()`。
- **状态条要挂的位置是现成的**：`src/modules/chat/transcript/ChatMessagesPane.tsx:210-223` 已经是贴在消息区顶部、标题下方的 sticky 区（`ChatExportMenu`），§15.3 的状态条就落在它旁边（不在 composer 底栏）。用户消息样式的分支在 `src/modules/chat/transcript/MessageComponent.tsx:97-99`（逐字 `message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : …`）。
- **文案面是 12 个 locale**：`src/modules/i18n/locales/{de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW}/{chat,sidebar}.json` 各 12 个都在；本仓补键的惯例是**12 个全补**（`74186716 fix(i18n): 补齐 7 个 locale 缺失的 input.queue.*` 就是把缺的补回来）。

<!-- dedup-ref --> **三条真前置（关系边已写成顶层 `depends_on`，本段只作溯源）**：`gap-claude-resident-api-smoke-human-gate`（`goal_ac: AC-170`，status=todo）—— AC-170 的 `expect` 逐字「UI 相关 AC（AC-171 至 AC-175）的派工任务以本条对应的任务为前置」，人 yale 在 `docs/proposals/claude-resident-sessions-smoke.md` 写下 `冒烟验收：通过` 之前，本条不得开工。`gap-lifecycle-mode-matrix-and-host-api`（`goal_ac: AC-169`，status=todo）—— 本条判据要读的「这个会话是不是常驻」是它落的 `sessions.lifecycle_mode` 列与能力矩阵，popover 的 [关闭常驻进程] 与状态条的 [启动] 是它落的 `POST /api/session-hosts/:sessionId/start|close`。`gap-claude-resident-addressable`（`goal_ac: AC-164`，status=todo）—— popover 的「复制 SendMessage 地址」必须读它落在 `GET /api/session-hosts` 投影上的 `peerName`（该字段今天全库不存在），本条**不得**在前端另算一遍 §12 的名字（那就是第二份实现）。三条机制与本条不相交（一条人工冒烟、一条偏好列与宿主 API、一条地址生成与读回），故硬串行、不并发。`gap-claude-resident-process-survival`（AC-161）经 AC-169 传递覆盖，`gap-claude-resident-unattended-turn`（AC-162）经 AC-164 传递覆盖，都不重复加边。

**要建的东西（范围是 AC-172 的最小充分集）**

1. **e2e 替身可驱动（承重件）**：`playwright.config.ts` 在 `selectedSpecFiles()` 含本判据时，给 server 的 `webServer.env` 加 `DEBUG_AGENT=1` 与 `DEBUG_AGENT_HOME=<QUAY_E2E_DATA_DIR 下的 fixture 根>`；**其它选择逐字不变**（今天所有 e2e 都不带门控，这条改动不得把它们带上）。
2. **调试 agent 场景把四态补全**：未运行（常驻会话、无宿主）/ 空闲（宿主在、有保活理由、无 turn）/ 运行中（有 turn）/ `exited(oom)`。`exit`+`oom`、`keepalive-add/remove` 已在；要补的是「常驻但未启动」与「忙」在**出厂 HTTP 控制面**上的可达性（不是判据内部直接建 manager）。第一步先量实际形状：`armDebugAgentScenario` + `driveScenario` 这条链今天把会话绑不绑成 resident 宿主、`unattended-turn` 开出的 run 在时钟推进期间是否让 binding 处于 `busy`。读不到就补，读到了就如实登记入口名与读数。
3. **保活理由的计数**：§15.1 的状态条要「N 个定时任务 · M 个监视」，而场景今天只能报 `background-task` 与 `monitor`。**要么**把 `DEBUG_AGENT_KEEPALIVE_KINDS` 扩到含 `cron`（连通 `HostLease` 的 `cron` 形状 `{id, recurring, expiresAt}` 与 `debug-agent.host-driver.ts` 的落 lease 处），**要么**在状态条上把显示的类别绑定到场景能产出的 lease 种类。二选一，但**只允许一份词表**：判据必须打印「宿主快照里的 lease 计数」与「界面计数」两行并断言相等，并把「界面类别名 ← lease kind」的对应关系逐条打印出来，不得在 spec 里另写一套中文标签去猜。
4. **无人轮的触发类型与发送方**：`unattended-turn` 的 step 要能带上触发类型（词表取自 `gap-claude-resident-unattended-turn` 第 4 条逐字定下的「后台任务回报 / 定时任务触发 / 跨会话消息」）与跨会话的发送方（§12 的 `peerName`），并让这条信息随该轮的消息到达前端（今天只写一条无 origin 的行）。前端据此渲染分隔标签；读不到时统一「非用户触发」。
5. **前端宿主读路径**：`src/shared/api.ts` 加 `GET /api/session-hosts` 的客户端；一个 hook（`src/shared/hooks/useSessionHosts.ts`）把「某会话的宿主与 lease」投影给 UI，并有**刷新路径**（轮询或复用 `session_upserted` 广播）—— 假形态 (a) 就钉在这里：状态条读本地状态时，场景切换状态后读数必须红。
6. **侧栏常驻标记**（`SidebarSessionItem.tsx` / `SidebarRecentConversations.tsx` 的 provider logo 旁、`SessionBranchBadge` 的位置）：未运行=空心、空闲=实心、运行中=实心+现有旋转图标、`exited`/OOM=红色；带稳定 DOM 契约（如 `[data-resident-mark][data-resident-state=…]`）与可访问名。
7. **会话内状态条 + popover**（`ChatMessagesPane.tsx` 顶部，不在 composer 底栏）：四态文案按 §15.1（`常驻 · 未运行（原因）`+[启动] / `常驻 · 空闲 · N 个定时任务 · M 个监视` / `常驻 · 运行中 · …` / exited 的横幅+[重新启动]）；计数取自宿主快照的 lease；popover 里显示并可**复制 SendMessage 地址**（读 AC-164 的 `peerName`）、pid/启动时间/内存、后台工作清单、以及 [关闭常驻进程]（危险样式，有后台工作时二次确认）→ 调 AC-169 的 close。
8. **停止与关闭分开**（§15.4）：常驻会话的 composer 停止只调 `interrupt()`，文案「停止当前回答（进程和定时任务保留）」；关闭入口只出现在状态条 popover 与会话菜单，不出现在 composer。
9. **无人轮的聊天记录呈现**（§15.6）：每个无人轮前的分隔标签（`⏰ 定时任务触发 · HH:MM` / `✉ 来自 <发送方> 的跨会话消息 · HH:MM` / `📡 监视通知 · <名字>`）；跨会话消息用独立气泡并**显示发送方**，**不得**走 `MessageComponent.tsx:97-99` 的 `message.type === 'user'` 分支。
10. **文案进 12 个 locale**（`chat.json` 与 `sidebar.json`），判据运行期从出货目录读句子，不抄进 spec。
11. **判据 `e2e/resident-status-bar.spec.ts`**：真浏览器、真服务、真调试 agent 场景；四态 + 计数 + popover + 停止 + 无人轮标签各一段读数，两条假形态臂。

**非目标**：AC-171 的知情门控与开关（同期兄弟任务）；AC-173 的 Running 视图与侧栏徽标分组；AC-174 的 Shell 标签禁用；AC-175 的忙时直发与撤回（`QueuedMessageCard` / `cancel_async_message`）；AC-169 的 `lifecycle_mode` 列、能力矩阵与 `start|close` 路由本身；AC-164 的地址生成、改名不变与「另一会话送达」；AC-162 的真实 Claude driver 无人轮；任何真实 claude 二进制、任何 subprocess 形状。

## Plan

1. **量三条前置落地后的实际形状**（任一未落地时判据**点名拒绝**，缺哪件就打印哪件，不写假读数）：`lifecycle_mode` 的字段名与读回投影；`POST /api/session-hosts/:sessionId/start|close` 的调用形状与错误码；`GET /api/session-hosts` 投影里 `peerName` 的字段名与位置。把它们钉进门控与读数，不按 proposal 的规划文字猜。
2. **替身接线**：`playwright.config.ts` 按 `selectedSpecFiles()` 条件开门（fixture 根落在本次 run 的 dataDir 下）；`server/index.ts` 给调试 agent provider 注入 `openRun`（复用 `chatRunRegistry.startRun({ connection: null, userId: null, source: 'unattended' })` 并返回 `run.writer`）。
3. **场景 op 扩展**：`unattended-turn` 带触发类型与发送方；`DEBUG_AGENT_KEEPALIVE_KINDS` 的取舍（Proposal 3）；四态在控制面上的可达性；`debug-agent.scenario.ts` 的闭集校验与拒绝文案同步；既有 `--test` 判据（`server/modules/debug-agent/tests/debug-agent-host-driver.test.ts` 等）不得回归。
4. **消息面**：把触发类型/发送方从场景行带到归一化消息与前端（只一份词表，与 AC-162 的词表逐字一致）。
5. **前端宿主读路径 + 侧栏标记**（含刷新路径）。
6. **状态条 + popover + 停止语义**。
7. **无人轮分隔标签与跨会话气泡**。
8. **12 个 locale 的文案**。
9. **写判据**：四态 + 计数（含正控制：加一条 lease ⇒ 计数变大）+ popover 复制/关闭 + 停止后宿主仍在 + 无人轮标签且非用户样式；打印整体墙钟并断言 `< 55_000`。
10. **两条假形态承重变异**：(a) 状态条改读本地状态 ⇒ 红在「场景切换状态后计数/状态读数」那条断言；(b) 无人轮走用户样式分支 ⇒ 红在「非用户样式」那条断言。各登记变异 diff、失败断言逐字、退出码；恢复。
11. `npm run lint` / `npm run typecheck` 绿；`npx playwright test --list` 的收集总数与改动前逐字相同；写完成记录。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-status-bar.spec.ts` 退出 **0**，并打印整体墙钟 `elapsed=<n>ms` 且 `< 55_000`（`playwright.config.ts:285` 的单文件上限；超过会被配置自己的看门狗终结）。红态基线本轮实测：`--list` 退出 **1**、`Error: No tests found.` / `Total: 0 tests in 0 files`；正控制同形状跑 `e2e/model-env-kind-explanations.spec.ts --list` 退出 **0**、`Total: 1 test in 1 file`。
- [x] AC2 四态各自成形（侧栏标记 + 状态条）：判据对四态各打印 `state=<未运行|空闲|运行中|exited(oom)> mark=<hollow|solid|solid+spinner|exited>` 与 `bar=<UI 文案> snapshot.state=<HostView.state> closeReason=<…> detail=<…>`；断言 mark 与 §15.1 的表逐条对应，且 `bar` 的状态词与 `snapshot` 一致；每次切换打印来源 `via=<scenario-step|start|close>`。
- [x] AC3 计数等于宿主保活理由的数目（**假形态 (a) 的落点**）：判据打印 `host.leases=<按 kind 的计数>`（运行期读 `GET /api/session-hosts`）与 `ui.counts=<界面读数>` 两行并断言相等；**正控制**：同一运行里加一条 lease（场景 `keepalive-add`）后重读，打印 `counts.before=<…> counts.after=<…>` 且 `after > before`（保证不是常量）；`界面类别 ← lease kind` 的对应关系逐条打印。
- [x] AC4 popover：复制地址与关闭进程。判据打印 `popover.address=<v> snapshot.peerName=<v> equal=true`（地址逐字来自 `GET /api/session-hosts` 投影，不是前端另算）、`copy.clipboard=<v> equalToAddress=true`、`close.request=<POST …/close 的状态码>`、`hosts.beforeClose=<n> hosts.afterClose=<n>`（后者更小）、`mark.afterClose=hollow`。**正控制**：关闭前同一 hostId 在快照里（打印 `host.present=true`）。
- [x] AC5 停止只中止当前一轮、进程仍在（§15.4）：常驻会话有一轮在飞时点 composer 的停止 ⇒ 判据打印 `run.status=<aborted>`、`host.hostId.before=<h> host.hostId.after=<h> same=true`、`host.state.after=<idle|lingering>`、`pid.before=<p> pid.after=<p> same=true`、`host.closeReason.after=null`。
- [x] AC6 无人轮的触发类型标签与跨会话发送方（**假形态 (b) 的落点**）：场景发一条 `定时任务触发`、一条 `跨会话消息`（发送方 = §12 的 `peerName`）。判据打印 `divider=<标签文案>`（逐字含触发类型）与 `sender=<发送方>`；并打印 `row.class=<…> isUserStyle=<true|false>`，断言其为 **false**；**正控制**：同一次运行里一条真用户轮打印 `userRow.isUserStyle=true`（证明该读数不是恒假）。
- [x] AC7 假形态 (a) 必须红（承重）：把状态条改成读本地状态（不再依赖 `GET /api/session-hosts`），判据命令退出**非 0**，且红**落在 AC3 的「场景切换状态后计数/状态必须变」那条断言**上（登记变异 diff、失败断言逐字、退出码）。恢复后判据回到 0。
- [x] AC8 假形态 (b) 必须红（承重）：把无人轮按用户消息样式渲染（走进 `MessageComponent.tsx:97-99` 的 user 分支），判据命令退出**非 0**，且红**落在 AC6 的「非用户样式」那条断言**上（登记变异 diff、失败断言逐字、退出码）。恢复后判据回到 0。
- [x] AC9 替身改动不波及别的判据：门控仅对含本判据的选择生效 —— `npx playwright test e2e/model-env-kind-explanations.spec.ts` 仍退出 **0**（打印退出码与墙钟），且 `npx playwright test --list` 的收集总数与改动前**逐字相同**（打印改动前后两个数）。
- [x] AC10 出厂链路的无人轮不再抛：判据打印 `unattended.run.source=<unattended>` 与 `seam.unwired=false`（场景的 `unattended-turn` 在**出厂 HTTP 控制面**上真的开出了 run，不是判据内部另接的 seam）；该次运行里 `DEBUG_AGENT_RUN_SEAM_UNAVAILABLE` 出现次数为 **0**（打印计数）。
- [x] AC11 文案取自运行期读的出货目录（`src/modules/i18n/locales/en/chat.json` 与 `…/sidebar.json`），spec 里不抄句子；新增 key 在 **12 个 locale** 的 `chat.json`（与用到的 `sidebar.json`）里都存在且非空，任一缺失以非 0 退出并打印是哪个文件哪个 key。
- [x] AC12 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --stat` 与 Touches 逐条对齐（多写的文件须由判据强制）。

## DoD

- 判据在**真浏览器**里跑：真服务、真会话、调试 agent 的常驻场景驱动，**不拉起 claude**；四态的读数来自 `GET /api/session-hosts` 的服务端事实，不是前端本地状态。
- 四态、计数、popover、停止、无人轮标签都是判据的**原始输出行**（`state.*` / `host.leases` / `ui.counts` / `popover.*` / `row.class` / `divider`），不是转述。
- 计数有**反向腿**（加一条 lease 后计数变大）与**正控制**（真用户轮的样式读数为真），证明两条被断言的性质都不是恒真/恒假。
- 两条假形态**真的跑过并真的红**，各自红在承重的断言上（不是任何一条断言都行）。
- popover 的地址**逐字**来自 `GET /api/session-hosts` 的投影（与 AC-164 同源），前端没有第二份名字生成。
- 单文件判据在 **55s** 内自己结束（打印墙钟），不是被看门狗或 60s 闸门外部击杀。
- 只动 Touches 列出的文件；不改 AC-161/162/164/169/171/173/174/175 的范围。

## Touches

- `e2e/resident-status-bar.spec.ts` (new)
- `playwright.config.ts`
- `server/index.ts`
- `server/shared/types.ts`
- `server/modules/debug-agent/debug-agent.scenario.ts`
- `server/modules/debug-agent/debug-agent.engine.ts`
- `server/modules/debug-agent/debug-agent.host-driver.ts`
- `server/modules/debug-agent/debug-agent.provider.ts`
- `server/modules/debug-agent/debug-agent.routes.ts`
- `server/modules/debug-agent/debug-agent.runtime.ts`
- `server/modules/debug-agent/index.ts`
- `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`
- `server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`
- `server/modules/providers/services/provider-runtime.service.ts`
- `server/modules/session-hosts/session-hosts.routes.ts`
- `server/modules/session-hosts/tests/session-hosts-routes.test.ts`
- `src/shared/api.ts`
- `src/shared/hooks/useSessionHosts.ts` (new)
- `src/modules/chat/transcript/ResidentStatusBar.tsx` (new)
- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/modules/chat/transcript/MessageComponent.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/chat/hooks/useChatMessages.ts`
- `src/shared/types.ts`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/sidebar/ResidentMark.tsx` (new)
- `src/modules/sidebar/SidebarSessionItem.tsx`
- `src/modules/sidebar/SidebarRecentConversations.tsx`
- `src/modules/i18n/locales/de/chat.json`
- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/es/chat.json`
- `src/modules/i18n/locales/fr/chat.json`
- `src/modules/i18n/locales/id/chat.json`
- `src/modules/i18n/locales/it/chat.json`
- `src/modules/i18n/locales/ja/chat.json`
- `src/modules/i18n/locales/ko/chat.json`
- `src/modules/i18n/locales/ru/chat.json`
- `src/modules/i18n/locales/tr/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/locales/zh-TW/chat.json`
- `src/modules/i18n/locales/de/sidebar.json`
- `src/modules/i18n/locales/en/sidebar.json`
- `src/modules/i18n/locales/es/sidebar.json`
- `src/modules/i18n/locales/fr/sidebar.json`
- `src/modules/i18n/locales/id/sidebar.json`
- `src/modules/i18n/locales/it/sidebar.json`
- `src/modules/i18n/locales/ja/sidebar.json`
- `src/modules/i18n/locales/ko/sidebar.json`
- `src/modules/i18n/locales/ru/sidebar.json`
- `src/modules/i18n/locales/tr/sidebar.json`
- `src/modules/i18n/locales/zh-CN/sidebar.json`
- `src/modules/i18n/locales/zh-TW/sidebar.json`
- `tasks/gap-claude-resident-status-bar.md`（自触）

## 完成记录（2026-09-28）

**判据（在合并 develop 后的树上重测，树 = HEAD `5dda0d51`）**：`npx playwright test e2e/resident-status-bar.spec.ts` → 退出 **0**，`4 passed`，`elapsed=30414ms`（< `SINGLE_SPEC_CEILING_MS = 55_000`）。合并前的同一条读数亦为退出 0、`elapsed=30956ms`；合并只带进 `server/modules/providers/*`、`server/modules/session-hosts/tests/*`、`server/modules/voice/*` 与两份文档，未触及本条的浏览面，故重测值与原值同形。

**逐条读数（判据的原始输出行，不是转述）**

- **AC1** 退出 0 / `elapsed=30414ms`。基线（本轮直跑）：`--list` 在文件不存在时退出 1、`Total: 0 tests in 0 files`；同形状的 `model-env-kind-explanations.spec.ts --list` 退出 0、`Total: 1 test in 1 file`。
- **AC2** 四态各打印一行：`state=空闲 mark=solid bar="Resident · Idle" snapshot.state=idle closeReason= detail= via=start` / `state=运行中 mark=solid+spinner bar="Resident · Running" snapshot.state=busy … via=scenario-step` / `state=未运行 mark=hollow mark.afterClose=hollow bar="Resident · Not running (…)" snapshot.state=closed closeReason=user via=close` / `state=exited(oom) mark=exited bar="Resident process exited (oom)" snapshot.state=closed closeReason=exited detail=oom via=scenario-step`。每次切换的 `via=` 都打印。
- **AC3** `host.leases=resident-policy:1,turn:1` 与 `ui.counts=resident-policy:1,turn:1` 两行断言相等；正控制 `counts.before=resident-policy:1` → `counts.after=monitor:1,resident-policy:1`（严格变大）；对应关系逐条打印 `界面类别 ← lease kind：Resident session ← resident-policy(1)`。
- **AC4** `popover.address="peer-resident-status-bar" snapshot.peerName="peer-resident-status-bar" equal=true`、`copy.clipboard="peer-resident-status-bar" equalToAddress=true`、`close.request=200 hosts.beforeClose=1 hosts.afterClose=0`、`mark.afterClose=hollow`；正控制 `host.present=true host.id=host-…`。**注**：`GET /api/session-hosts` 保留已关闭宿主的记录（`state='closed'`），故 `hosts.length` 不动；判据按 AC 的语义数**存活**宿主（`state !== 'closed'`），1 → 0。
- **AC5** `run.status=aborted`、`host.hostId.before=host-6d32ac02… host.hostId.after=host-6d32ac02… same=true`、`host.state.after=lingering`、`pid.before=(none) pid.after=(none) same=true startedAt.before=… startedAt.after=… startedAt.same=true`、`host.closeReason.after=null`。
- **AC6** `divider="⏰ Scheduled task · 12:15 AM" trigger=cron sender=""`、`divider="✉ Cross-session message from peer-resident-status-bar · 12:15 AM" trigger=cross-session sender="peer-resident-status-bar"`；`row.text="unattended turn opened by a scheduled task" row.class=unattended isUserStyle=false`（第二条同形）；正控制 `userRow.isUserStyle=true`。
- **AC7** 假形态 (a) 真跑过：`/tmp/ac7-mutation.diff`（状态条改读本地状态），判据退出 **1**，红落在 AC3 承重断言上，逐字 `Error: the bar counts the leases the listing reports, kind for kind` / `Expected: "resident-policy:1,turn:1"` / `Received: "resident-policy:1"`（spec `:739`）。`git checkout --` 恢复后判据回到 0。
- **AC8** 假形态 (b) 真跑过：`/tmp/ac8-mutation.diff`（`rendersAsUser = message.type === 'user' || message.type === UNATTENDED_TURN_MESSAGE_TYPE`），判据退出 **1**，红落在 AC6 承重断言上，逐字 `Error: a turn nobody typed must not wear the user's own bubble style` / `Expected: not "user"`（spec `:923`），同一跑里 `row.class=user isUserStyle=true`。恢复后判据回到 0（`4 passed`，`elapsed=30956ms`）。
- **AC9** 兄弟判据 `npx playwright test e2e/model-env-kind-explanations.spec.ts` → 退出 **0**，墙钟 **10776ms**（首跑退出 1，红在 `ensureSignedIn` 的登录闸门、即本条触及面之前；复跑绿，判为宿主抖动并如实登记）。收集总数：门控在位 **69 tests in 14 files**，把 `playwright.config.ts` 回退到 merge-base 后 **69 tests in 14 files**，两次数出的 69 行测试清单 `diff` 逐字相同。门控只改 `webServer.env` 的条件三元，`testDir`/`testMatch`/`testIgnore` 一律未动。
- **AC10** `unattended.run.source=unattended seam.unwired=false`、`run.seamRefusals=0`（判据统计该次 server 日志里 `DEBUG_AGENT_RUN_SEAM_UNAVAILABLE` 的出现次数）。无人轮走的是出厂 HTTP 控制面（`server/index.ts` 注入的 `openRun`），不是 spec 内部另接的缝。
- **AC11** 第 3 条测试绿：逐字读出货目录的 12 个 locale × `chat.json`/`sidebar.json`，缺键或空值以非 0 退出并点名文件与 key。
- **AC12** `npm run lint` 退出 **0**（仅既有 warning）；`npm run typecheck` 退出 **0**（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）；`git diff --name-only $(git merge-base develop HEAD) HEAD` = **52** 个文件，全部落在 `## Touches` 内（`anti-drift-touches-check.js --worktree … --merge-target develop` → `52 actual file(s), all within declared Touches (53 glob(s))`）。本轮把 12 个此前**改了但未声明**的文件补进 `## Touches`：`debug-agent.provider.ts` / `debug-agent.routes.ts` / `debug-agent.runtime.ts` / `index.ts` / 两份 debug-agent `tests/*.test.ts` / `provider-runtime.service.ts` / `session-hosts.routes.ts` / `session-hosts-routes.test.ts` / `ChatInterface.tsx` / `useChatMessages.ts` / `src/shared/types.ts`。

**范围外的一处必要根因修复**：`debug-agent.provider.ts` 的 `withMessageOrigin` 是 claude sessions face 的 Proxy，`fetchHistory` 内部用 `this.normalizeMessage` 重新归一化每一行，绑定到 target 就会绕过陷阱 ⇒ 实时帧带 `origin`、REST 历史（刷新路径）丢 `origin`，无人轮的分隔标签与发送方在刷新后归零。改为把转发的方法绑到 proxy `face` 而非 `target`。`debug-agent.host-driver.ts` 与 `provider-runtime.service.ts` 的 `RunEntry` 值透传同步放宽到 `Promise<unknown>`。

**工作树读取面**：`task_write` 的提交落在主检出（`author`），故本轮按 `git merge --no-edit author` 把 ABI 写出的字节搬到 `task/<id>` 分支上，再 `git merge --no-edit develop`；合并后 `fan-in-ac-completion-gate.js --worktree …` 读 `AC 全勾（12/12）`，`scripts/test.sh --for-task gap-claude-resident-status-bar --allow-thin` 退出 **0**（`# tests 3 / # pass 3 / # fail 0`，跑的是本轮刚声明的 3 个 `*.test.ts`，证明 Touches 修订真的生效、不是拿旧清单蒙混）。
