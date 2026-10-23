---
id: gap-claude-resident-permission-interception
title: AC-168 常驻默认 bypass 启动（permissionMode=bypassPermissions 且
  allowDangerouslySkipPermissions=true），切模式经 setPermissionMode
  不重启；无人值守（无连接且无用户轮）时三个需要人回应的入口一律自动拒绝并推送通知、该轮限时结束不挂起：(1) canUseTool 的
  AskUserQuestion/ExitPlanMode（E8 已读到 bypass 下仍走该回调）、(2) onElicitation 用 E9 9.6
  原文 control_request 帧驱动、(3) request_user_dialog 按 sdk.d.ts
  类型伪造帧（注明形态来自类型而非实物）；有连接时三者仍走现有 permission_request 请求帧流程；side_question
  不在本条；假形态（只拦 canUseTool、只拦前两个）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
goal_ac: AC-168
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-168" tasks/*.md | wc -l` → **0**；`grep -rln "AC-168" tasks/*.md | wc -l` → **0** —— 全库零命中，连邻居任务的「非目标」段都没有点名过 AC-168。机制侧同为零：`grep -rn "onElicitation" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "elicitation" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "request_user_dialog" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "allowDangerouslySkipPermissions" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "setPermissionMode" server/ --include=*.ts --include=*.js | wc -l` → **1**（只有 `server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts:73` 的**注释**，不是调用）；`grep -rn "canUseTool" server/ --include=*.ts --include=*.js | wc -l` → **1**（只有 per-run 的 `server/modules/providers/list/claude/claude-runtime.provider.js:902`）。`ls server/modules/providers/list/claude/ | grep -c 'host-driver'` → **1**，即只有 `claude-per-run-host-driver.provider.ts`；`test -f server/modules/providers/list/claude/claude-host-driver.provider.ts` → **ABSENT**（resident driver 还没落地）。⇒ 本条要建的三入口拦截与常驻 bypass 启动在库内不存在，不是重复。

<!-- dedup-ref --> 邻居分工（逐文件核对，避免同机制重开）：`gap-claude-resident-process-survival`（AC-161）建 resident driver 本体与 `setPermissionMode` 所在的活体重配面；`gap-claude-resident-unattended-turn`（AC-162）建无人轮的 run 产出与回放；`gap-claude-resident-busy-input`（AC-163）建忙时输入。本条不接管它们任一条的范围，只在 AC-161 落地的 driver 上补「启动即 bypass」「切模式不重启」「三入口无人值守拒绝」三件事；AC-161 未落地时本条不得自行补 driver 本体。

**来源与判据物。** 判据逐字取自 `goals/AC-168-常驻默认-bypass-启动-无人值守时-askuserquestion-与-exitplanmode-被自动拒绝并通知.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-permissions.test.ts`（命令逐字含文件路径，**不用 glob**）。红态基线（本轮**直跑**，不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-permissions.test.ts'`。

**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts` → 退出 **0**，读数 `tests 10 / pass 10 / fail 0 / duration_ms 479.43` ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮读的码）—— per-run 的请求帧流程已有，常驻侧三个入口一个都没有**

- `server/modules/providers/list/claude/claude-runtime.provider.js:76` 已有 `const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode'])`；`:902` 的 `sdkOptions.canUseTool` 是全仓**唯一**一处该回调，交互类工具（以及非 bypass 下一切未命中 allow/deny 列表的调用）走 `:926` 发 `permission_request` 帧 + `:938 waitForToolApproval(requestId, …)` 等客户端应答（`:124` 定义）。这就是 AC 逐字说的「现有的请求帧流程」；`:903` 的 `requiresInteraction` 分支把它的超时设为 `0`（即无超时）。
- `:896-901` 的注释逐字写着「in 'auto' and 'bypassPermissions' modes the SDK resolves approval at the permission-mode step and skips this callback, so interactive tools (AskUserQuestion, ExitPlanMode) won't reach the UI」——**这条注释已被 E8 实测证伪**：E8 读到 `permissionMode：bypassPermissions` 下 `AskUserQuestion` **仍然**走 `canUseTool`（`拦截到的工具名：AskUserQuestion`，被调用 1 次），可在回调里拦截（`docs/proposals/claude-resident-sessions-experiments.md` 的 E8 节，结论行逐字「结论：bypassPermissions 下 AskUserQuestion **仍然**走 canUseTool」）。所以判据必须**正面证明**该回调在 bypass 下真的被调用（否则「拒绝」断言是空的），并顺手订正这条注释。
- 推送面已存在且可注入：`server/modules/notifications/index.ts` 导出 `createNotificationEvent` / `notifyUserIfEnabled`（`:1-12`），`claude-runtime.provider.js:881` 已在用 `kind:'action_required'` 造事件——本条复用，不新增通知机制。
- SDK 侧的名字与形态（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）：`canUseTool?: CanUseTool`（`:1335`）、`onElicitation?: OnElicitation`（`:1497`）、`onUserDialog?: OnUserDialog`（`:1507`）、`allowDangerouslySkipPermissions?: boolean`（`:1680`；`:1664` 逐字要求 `'bypassPermissions'` 必须配 `allowDangerouslySkipPermissions`）。

**E9 9.6 原文（本条 (2) 的驱动帧，逐字取自 `docs/proposals/claude-resident-sessions-experiments.md`）**：

{"type":"control_request","request_id":"97bacb9a-7e8f-4515-87f7-8126bfc05422","request":{"subtype":"elicitation","mcp_server_name":"e9eliciting","message":"E9 请人回答","mode":"form","requested_schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}}

E9 结论逐字：`elicitation 请求条数：1` —— MCP 工具的 `elicitation/create` 被 CLI 转成一条 `control_request`（`subtype:"elicitation"`，带 `mcp_server_name`/`message`/`mode`/`requested_schema`）交给宿主，这个入口确实要接。**(3) `request_user_dialog` 是读数缺口**：E9 没触发到它的入口，该 subtype 只在 SDK 类型联合里（`sdk.d.ts:3138` 的 `SDKControlRequestUserDialogRequest = { subtype:'request_user_dialog'; dialog_kind:string; payload:Record<string,unknown>; tool_use_id?:string }`；宿主侧回调形态是 `:1507 onUserDialog?: OnUserDialog`，其 `UserDialogRequest = { dialogKind; payload; toolUseID? }` → `UserDialogResult = {behavior:'completed';result} | {behavior:'cancelled'}`）。**判据必须按类型伪造帧，并在测试里逐字注明「形态来自 sdk.d.ts 的类型定义，不是实物读数」**，不得含糊成「实测」。

**要建的东西（AC-168 的最小充分集，全在常驻 driver 一侧）**

1. **常驻默认 bypass 启动**：resident driver 建 query 时 SDK options 必须是 `permissionMode:'bypassPermissions'` **且** `allowDangerouslySkipPermissions:true`（AC 逐字「且」——缺一就没满足 `:1664` 的约束）。
2. **切换权限模式不重启**：常驻会话切到别的模式时调用 `query.setPermissionMode(<新模式>)`，**不重建进程**（同一宿主 pid/hostId 不因切模式而 close/重开）。
3. **无人值守判定**：没有浏览器连接（`connectedClients` 为空，`server/modules/websocket/index.ts` 已导出）**且**没有用户轮在进行（宿主快照的绑定/轮次状态）⇒ 三入口一律自动拒绝或取消。判据把「无连接且无用户轮」这一档钉死，有连接那一档按第 4 点做正对照。
4. **有连接时走现有流程**：三入口仍走 `permission_request` 帧 + `waitForToolApproval`（复用 per-run 那套，不发明第二套请求帧协议）。
5. **(1) canUseTool**：`AskUserQuestion` 与 `ExitPlanMode` 在无人值守时返回拒绝（SDK 等价形态，如 `{behavior:'deny', message: …}`），message **含无人值守说明**（逐字要求「当前无人值守」一类可判定的字样），并**不进入** `waitForToolApproval` 的等待。
6. **(2) onElicitation**：用上面 E9 原文帧驱动 ⇒ 返回拒绝或取消（应答形态以 SDK 类型为准）。
7. **(3) request_user_dialog / onUserDialog**：按 sdk.d.ts 类型伪造帧驱动 ⇒ 收到即按无人值守策略应答（`{behavior:'cancelled'}` 或按类型定义拒绝），不得挂起。
8. **三者共同**：拒绝信息含无人值守说明；推送通知被调用（注入的通知缝至少被调用一次，且带拒绝事实）；**该轮在限定时间内结束而不挂起**。
9. **side_question 不做**：它是宿主→CLI 方向，E9 读到 CLI 认该 subtype 但没有 `control_response`；无人值守**不需要**为它写拒绝分支（AC 逐字）。判据不得为它写断言。

**两臂假形态（绿 = 判据有洞，必须先补判据再继续）**

- (a) 只在 `canUseTool` 拦截（把 (2)(3) 落空）⇒ (2) 或 (3) 的那一轮**挂起到超时** ⇒ 判据**必须红**。
- (b) 只拦 `canUseTool` 与 `onElicitation`（把 (3) 落空）⇒ **(3) 必须红**。

**正对照（缺了它拒绝断言就是空的）**：判据要先证明 `canUseTool('AskUserQuestion'|'ExitPlanMode')` 在 bypass 下**真的被调用了**（E8 读数），再断言它被拒——否则一个「bypass 直接跳过回调」的实现也能让拒绝读数绿。有连接那一档同样要真有 `permission_request` 帧发出（正对照），不能只断言「没拒绝」。

**约束（不要碰的红线）**

- 后端代码遵循 `AGENTS.md`：`.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范（改动全在 `server/`）。跨模块只经 barrel（本仓 boundaries lint）：判据 import 走 `@/modules/providers/index.js` / `@/modules/session-hosts/index.js` / `@/modules/websocket/index.js` / `@/shared/…js`。
- per-run 行为不变：`claude-runtime.provider.js` 的 per-run 请求帧流程（`:902` 的 `canUseTool`、`:926` 的帧、`:938` 的等待）不得静默改语义；`server/modules/providers/tests/claude-host-per-run.test.ts` 与 `server/modules/providers/tests/record-per-run-frame-baseline.test.ts` 必须仍退 0。
- AC 的「命令逐字含文件路径，不用 glob」约束的是**判据命令**：判据入口与 DoD 里的命令都写字面路径，不写 glob。
- 本条**不含**前端（界面告知与自动拒绝卡片是 proposal §15 的独立工作面），也不含 `remoteControlAtStartup` 强制关闭那条保守分支。

## Plan

1. **判据骨架 + 启动读数**：新建 `server/modules/providers/tests/claude-resident-permissions.test.ts`，用 AC-161 落地的 resident driver 的注入缝（`ClaudeHostQueryStream` / `ClaudeHostQueryFactory` 那一族脚本流，见 `claude-per-run-host-driver.provider.ts:63-95`）读回常驻启动的 SDK options ⇒ 先钉 (1) `permissionMode='bypassPermissions'` + `allowDangerouslySkipPermissions:true` 的逐字读数。若 AC-161 实际落地的注入缝与此处描述不一致，按实际缝登记并在完成记录里写明。
2. **切模式不重启**：驱动切模式入口 ⇒ 读回 `query.setPermissionMode(<新模式>)` 被调用且宿主 pid/hostId 不变（未 close/重开）。
3. **三入口拦截 + 无人值守**：实现 (1)(2)(3) 的拒绝/取消分支，带「无人值守说明 + 推送通知 + 限时结束」；判据逐个打点，并加「canUseTool 在 bypass 下真被调用」的正对照。
4. **有连接正对照 + 两臂假形态**：有连接档读 `permission_request` 帧被发出（并进入 `waitForToolApproval` 那一档）；假形态 (a)(b) 各自把对应读数打红。
5. **收尾**：`npm run typecheck` / `npm run lint` 退 0；per-run 既有判据仍退 0；`server/modules/providers/README.md` 增补常驻权限三入口一节。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-permissions.test.ts` 在交付树上退出 **0**；同一命令在 develop 上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-permissions.test.ts'`。
- [x] 判据读回常驻启动的 SDK options：`permissionMode === 'bypassPermissions'` **且** `allowDangerouslySkipPermissions === true`（两者同时出现，逐字）。
- [x] 切换权限模式（切到 `default`/`acceptEdits` 一类非 bypass 模式）时观察到 `query.setPermissionMode(<新模式>)` 被调用，且**同一宿主 pid/hostId 不变**（没有 close/重开读数）。
- [x] (1) 无人值守时 `canUseTool('AskUserQuestion', …)` 与 `canUseTool('ExitPlanMode', …)` 各被调用一次并各返回**拒绝**；拒绝 message 含无人值守说明；且**没有进入** `waitForToolApproval` 的等待（该等待在无人值守档零调用）。
- [x] (1) 的**正对照**：判据证明该回调在 `bypassPermissions` 下**真的被调用**（E8 读数），不是被 SDK 跳过后的空绿。
- [x] (2) 用 E9 9.6 原文帧（`{"type":"control_request",…"subtype":"elicitation","mcp_server_name":"e9eliciting","message":"E9 请人回答","mode":"form","requested_schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}`）驱动 ⇒ 返回**拒绝或取消**，不挂起。
- [x] (3) 用按 `sdk.d.ts` 类型（`:3138` `SDKControlRequestUserDialogRequest` / `:1507` `onUserDialog`）伪造的帧驱动 ⇒ 收到即按无人值守策略应答（拒绝或取消），不挂起；测试内逐字注明「形态来自 sdk.d.ts 的类型定义，不是实物读数」。
- [x] 三入口在无人值守档都：拒绝信息含无人值守说明、**推送通知被调用**（注入的通知缝被调用至少一次且带拒绝事实）、**该轮在限定时间内结束**（判据注入的短预算内返回；超时即判据红，不是全局 exit 3）。
- [x] **有连接档正对照**：同样三入口在有人连接时仍走现有请求帧流程 —— 观察到 `permission_request` 帧被发出（并进入 `waitForToolApproval`），不是直接拒绝。
- [x] 假形态 **(a)**：只在 `canUseTool` 拦截 ⇒ (2) 或 (3) 的那一轮挂起到超时 ⇒ 判据**必须红**。
- [x] 假形态 **(b)**：只拦 `canUseTool` 与 `onElicitation` ⇒ **(3) 必须红**。
- [x] `side_question` 不在本条：判据文件里**没有**为它写的拒绝/取消断言（负向核对）。
- [x] 既有 `server/modules/providers/tests/claude-host-per-run.test.ts` 与 `server/modules/providers/tests/record-per-run-frame-baseline.test.ts` 仍退出 0，断言不改。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries：判据跨模块只经 barrel）。

## DoD

真实落地判据，不是「有一个回调」：在交付的树上**真的**跑一次 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-permissions.test.ts`，读到 (1) 常驻启动 options 里 `permissionMode='bypassPermissions'` 与 `allowDangerouslySkipPermissions=true` 同时逐字出现；(2) 切模式后 `query.setPermissionMode(<mode>)` 被调用而同一宿主 pid/hostId 不变；(3) 无人值守档三入口各自的拒绝/取消读数 + 拒绝信息含无人值守说明 + 通知缝被调用 + 该轮在注入的短预算内结束（不是挂到超时）；(4) 有连接档三入口都发出 `permission_request` 帧（正对照），且 `canUseTool` 在 bypass 下真被调用（E8 正对照）；(5) 结束时无残留宿主（`snapshot()` 里本条起的 host 已 close）。两臂假形态各自把对应读数打红（绿 = 判据有洞，先补判据再继续）。关键读数（启动 options 原文、`setPermissionMode` 入参、pid、三入口的应答形态与拒绝文案、通知缝调用记录、有连接档的 `permission_request` 帧）写进 Evidence。真实落地后，`server/modules/providers/README.md` 增补常驻权限一节（默认 bypass + 无人值守三入口拦截与通知 + `side_question` 不在其列的理由）。

## Touches

- `server/modules/providers/tests/claude-resident-permissions.test.ts` (new: 判据)
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（AC-161 落地的 resident driver；本条在其上加 bypass 启动 options、`setPermissionMode` 切模式、三入口无人值守拦截与通知；若其实际文件名不同，按实际文件登记并在完成记录里写明）
- `server/modules/providers/list/claude/claude-runtime.provider.js`（抽出/复用 `permission_request` 帧 + `waitForToolApproval` 请求帧流程与 `TOOLS_REQUIRING_INTERACTION` 供常驻「有连接」档复用；订正 `:896-901` 与 E8 相反的注释；纯抽线与注释，不堆新逻辑）
- `server/modules/providers/list/claude/claude.provider.ts`（组合根：把 `modules/websocket` 注册表的连接数经 `connectedClientCount` 端口装进 resident driver —— 驱动自身对 `modules/websocket` 零 import，见 `claude-resident-unattended-turn.test.ts` 的结构读数；这条写入是本任务实现中唯一的组合根改动）
- `server/modules/providers/index.ts`（barrel 收口：新增/抽出的导出经此收敛；签名不变则不动）
- `server/modules/providers/README.md`（常驻权限：默认 bypass + 无人值守三入口拦截与通知）
- `tasks/gap-claude-resident-permission-interception.md`（自触）

## Evidence

交付树 = worker worktree（branch `task/gap-claude-resident-permission-interception`，实现 commit `4db6caef`）。判据命令逐字直跑：

```text
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-permissions.test.ts
perm (1) launch permissionMode=bypassPermissions allowDangerouslySkipPermissions=true canUseTool=function onElicitation=function onUserDialog=function
perm (1) E8 conclusion: 结论：bypassPermissions 下 AskUserQuestion **仍然**走 canUseTool（被调用 1 次，工具名 AskUserQuestion），可以在回调里拦截。
perm (2) switch=live setPermissionMode=["default","acceptEdits"] spawns=1 hostId=host-…->host-… pid=4242->4242 hostState=busy reading.permissionMode=default->acceptEdits secondSwitch=live
perm (3) request_user_dialog 帧：形态来自 sdk.d.ts 的类型定义，不是实物读数
perm (3) canUseTool(AskUserQuestion) => {"behavior":"deny","message":"当前无人值守：已自动拒绝 工具 AskUserQuestion。"}
perm (3) canUseTool(ExitPlanMode) => {"behavior":"deny","message":"当前无人值守：已自动拒绝 工具 ExitPlanMode。"}
perm (3) onElicitation => {"action":"cancel"}
perm (3) onUserDialog => {"behavior":"cancelled"}
perm (3) decisions=4 refused=4 viaClient=0 lastConnectedCount=0 pendingApprovals=0 notifications=4
perm (3) control with connected=1 frames=1 pending=1
perm (4) frames=3 kinds=["AskUserQuestion","onElicitation","onUserDialog"] pending=3 pendingTools=["AskUserQuestion","onElicitation","onUserDialog"] notifications=3
perm (4) after-idle hostState=closed closeReason=idle hosts=1 openHosts=0 pendingDeadlines=0
perm grep -c "side_question" server/modules/providers/tests/claude-resident-permissions.test.ts = 3 (commentHits=3 codeHits=0)
perm elapsed=44ms budgetPerCall=1000ms
ℹ tests 1 / pass 1 / fail 0    exit=0
```

**两臂假形态（改的是实现，各跑一次后 `git checkout --` 还原，判据复跑绿、`git status` 干净）：**

- **(a) 只装 `canUseTool`**（删掉 `sdkOptions.onElicitation` / `sdkOptions.onUserDialog` 两行）：`exit=1`，读数行 `onElicitation=undefined onUserDialog=undefined`，失败断言 `AssertionError: the launch must install the elicitation entry`。红落在 (1) 段的安装读数上而不是「挂到超时」——入口由判据直呼，缺装即刻可判，比超时更早且同样可归因。
- **(b) 只装 `canUseTool` + `onElicitation`**（删掉 `onUserDialog`）：`exit=1`，失败断言 `AssertionError: the launch must install the dialog entry`。另外把 (1) 段的安装断言**临时**停掉再跑同一变异，红改落在 `(3) the dialog entry must be installed` ⇒ (3) 段自身也不瞎（探测改动已还原）。

**兄弟判据 / 命令：**

- `server/modules/providers/tests/claude-host-per-run.test.ts` → `tests 7 / pass 7 / fail 0`，exit 0（断言未改）。
- **路径勘误**：AC 第 13 条写的 `server/modules/providers/tests/record-per-run-frame-baseline.test.ts` **在树上不存在**；实际文件是 `server/modules/session-hosts/tests/record-per-run-frame-baseline.test.ts`，直跑 → `tests 1 / skipped 1 / fail 0`，exit 0（该文件按自身前置条件 skip，不是被改坏；照该条的字面路径跑会「找不到文件」退 1，属 AC 笔误，按实际路径登记）。
- `npm run typecheck` → exit 0（三条 tsconfig 全过）；`npm run lint` → exit 0（仅既有 warning，无新增）。boundaries：判据的跨模块 import 只经 `@/modules/session-hosts/index.js` 与 `@/shared/types.js`；`@/modules/providers/list/claude/*` 属本模块内深引用（与相邻常驻判据同款，boundaries lint 允许，exit 0 为准）。
- 红态基线：`git cat-file -e develop:server/modules/providers/tests/claude-resident-permissions.test.ts` → `fatal: path … does not exist in 'develop'`（exit 128）；在主检出（branch `author`，同样无该文件）直跑该命令 → stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-permissions.test.ts'`，exit 1。
- `server/modules/providers/index.ts` **未动**：`requestClientToolDecision` / `resolveToolApproval` / `getPendingApprovalsForSession` 的名字与位置不变（前者的重复导出已去重），无新增导出 ⇒ 命中 Touches 的「签名不变则不动」。
- `server/modules/providers/README.md` 新增「Resident Permissions (Claude)」一节：默认 bypass（两选项成对）、三入口表（无人值守应答 / 有连接应答）、无人值守是活读数（`connectedClientCount` 端口 + 无用户轮）、`side_question` 不在其列的理由。
