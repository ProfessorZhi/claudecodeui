---
id: gap-claude-resident-idle-close
title: AC-165 空闲关闭由真实 Claude driver 执行 — 伪 SDK 流 + 注入时钟驱动 resident driver：保活理由按
  Stop hook 的 session_crons/background_tasks 与 task_* 事件对账（无清单时退回工具调用推测并标
  inferred），有未过期 cron 时 24 小时不关、清单消失后恢复计时在 24 小时处以 idle 关闭、7 天 expiresAt 后重计时，未知
  subtype 不中断循环，浏览器 chat.subscribe 不改变关闭时刻，关闭后 GET /api/session-hosts 读到
  closeReason=idle；三臂假形态必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
  - gap-session-hosts-lease-driven-lifecycle
  - gap-session-hosts-rest-list-endpoint
goal_ac: AC-165
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-165" tasks/*.md | wc -l` → **0**；`grep -rln "AC-165" tasks/*.md | wc -l` → **0** —— 不是「未认领」，是**全库零命中**：连任何邻居任务的**非目标**段都没点过 AC-165。代码侧：`grep -rn "session_crons" server/ src/ shared/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "scheduled_task_fire" server/ src/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "claude-resident-idle" server/ src/ tasks/ | wc -l` → **0**；`ls server/modules/providers/list/claude/ | grep host-driver` → 只有 `claude-per-run-host-driver.provider.ts`，**无** resident driver；`grep -rn "attachViewer" server/modules/websocket/` → **0**。⇒ AC-165 无认领者，本条不是重复。

<!-- dedup-ref --> 邻居让位逐字在案（下面三条**前置**写进顶层 `depends_on`）：`gap-claude-resident-process-survival`（AC-161，resident driver 的**进程存活**面：同 pid 跨轮、abort 不杀、close 走 stdin EOF；它的判据用真实二进制，**不读 Stop hook 清单、不测空闲关闭**）；`gap-session-hosts-lease-driven-lifecycle`（AC-157，**done**，**manager 侧**由 lease 驱动的状态机与 idle 上限；判据用**伪造 driver** 直接调 `leaseAdded`/`removeLease`，**不读任何 CLI 帧**，其非目标段逐字把「真实 Claude driver 的顶替与持有」让给 GOAL-013，且只把 `attachViewer` 当作 manager 的一个入口、**不接生产**）；`gap-session-hosts-rest-list-endpoint`（AC-156，**done**，`GET /api/session-hosts` 与其关闭后保留窗口）。`gap-claude-resident-unattended-turn`（AC-162，todo，与本条共享「读 Stop hook」这一动作但机制不同：它读 `background_tasks` 只为**无人轮的触发类型**，其 AC 里 `session_crons` 明确「本条不重复取」，它不建保活理由、不管空闲关闭）；`gap-claude-resident-busy-input`（AC-163）与 `gap-claude-resident-addressable`（AC-164）与空闲关闭无关。⇒ 本条认领的是它们都让出的那一格：**driver 按 CLI 清单（Stop hook 的 `session_crons` / `background_tasks` 与 `task_*` 事件）对账保活理由、拿不到清单时退回工具调用推测并标 `inferred`，并让 resident 宿主在无保活理由时由注入时钟在 24 小时处以 `idle` 关闭**。

**来源与判据物。** AC 逐字（`goals/AC-165-空闲关闭由真实-claude-driver-执行-有-cron-时不在空闲超时处关闭-浏览器停留不阻止关闭.md` 的 `criterion:`）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-idle.test.ts`（命令逐字含文件路径，不用 glob）。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-idle.test.ts'`；`ls server/modules/providers/tests/claude-resident-idle.test.ts` → `No such file or directory`。

**伪造帧的字段名与形态取自 E9 原始读数**（`docs/proposals/claude-resident-sessions-experiments.md` §9.3–9.5），不自造：

- `system/task_started`（§9.3 `:451`）：`{task_id, tool_use_id, description, is_backgrounded, task_type, uuid, session_id}`（子代理那条另有 `subagent_type`/`spawn_depth`/`prompt`）
- `system/task_notification`（§9.3 `:452`）：`{task_id, tool_use_id, status, output_file, summary, uuid, session_id}`
- `system/background_tasks_changed`（§9.3 `:453`/`:455`）：`{tasks:[{task_id, task_type, description}], uuid, session_id}`，`tasks` 可为 `[]`
- Stop hook 输入的键（§9.4/9.5 `:486`）：`session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons`
- `session_crons` 元素（`:484`）：`{id, schedule, recurring, prompt}`
- `background_tasks` 元素（`:485`）：`{id, type, status, description, command}`
- `scheduled_task_fire`：§9.5 实测**没读到**（`:482`，出过的 subtype 只有 `init`/`background_tasks_changed`/`task_started`），但 CLI 二进制里有 —— 正因如此它是 (6) 要夹的**未知** subtype
- 轮次边界按 `system/init` 与 `result`：proposal §7 `:292` 逐字「常驻 stream-json 与 SDK `query()` 两条路**都没有** `session_state_changed`…driver **不要**等这个事件」
- `expiresAt = 创建时 + 7 天` 的依据是 E1 读到的工具回执逐字（§9.4 `:465`）：「Auto-expires after 7 days.」

**现状（本轮实测的读数）—— manager 侧已就位，缺的是 driver 侧与两处接线：**

- **manager 侧齐了**：`RESIDENT_IDLE_TIMEOUT = 24 * 60 * 60 * 1000`（`server/modules/session-hosts/session-host-manager.service.ts:60`）、`DEFAULT_RESIDENT_POLICY`（`:88-90`，`closeWhenLeasesEmpty: false`）、`resident-policy` lease、按**绝对 epoch** 调度的 `HostScheduler` 接缝、`attachViewer`（`:604`，**不**碰 `lastActivityAt`）与 `noteActivity`（`:616`，碰）—— 判据 (1)(3)(7) 的 manager 半边已由 AC-157 落地并验证。
- **driver 侧为零**：无 resident driver（见上）；`session_crons` 全仓 0 命中 ⇒ 保活理由对账面一行都没有。
- **`attachViewer` 没有生产调用点**：`grep -rn "attachViewer" server/modules/websocket/` → **0** ⇒ `chat.subscribe` 今天不告诉宿主「有浏览器在看」，(7) 没有承载面（AC-157 只验证了「调了 `attachViewer` 也不刷新」这个 manager 不变量，没接生产）。
- **`HostLease` 无 `inferred` 字段**（`server/shared/types.ts:1841-1845`：`turn` / `background-task|monitor` / `cron{id,recurring,expiresAt}` / `resident-policy`）⇒ (4) 要的「保活理由标为 `inferred`」今天无处可标。

**要建的东西（本条的最小充分集）：**

1. **resident driver 的保活理由对账面**（`server/modules/providers/list/claude/claude-host-driver.provider.ts`，AC-161 落的那个文件）：
   - 在 SDK `hooks` 选项里注册 `Stop`（与 `SubagentStop`）回调；每轮结束时用 hook 输入的 `session_crons` **整体覆盖**该绑定的 `cron` 保活理由（`leaseAdded`/`leaseRemoved`，收敛到清单当前值），用 `background_tasks` 核对后台任务；`expiresAt = now() + 7 天`（`now` 是注入的）；
   - `task_started` 加 `background-task` lease、`task_notification` 按 `task_id` 解除（proposal §3 的权威口径）；`background_tasks_changed.tasks` 非空同样成立、变空即解除；
   - 拿不到清单（旧版 CLI / hook 未触发）时退回按流中的 `CronCreate`/`CronDelete` 工具调用推测，**并把该 lease 标 `inferred`**；
   - 读取循环对未知 `system` subtype **放过**：记一次读数、不抛错、不中断（`scheduled_task_fire` 是样本）；
   - driver 要有**可注入的 SDK query 工厂与注入的 `now`** 接缝，判据才能喂伪流、拨时钟（AC-161 的判据用真实二进制，未必要这个接缝 —— 若它落了就复用，没落就本条补）。
2. **`inferred` 标记**（`server/shared/types.ts`）：给 `HostLease` 的 `cron` 与 `background-task` 加**可选** `inferred?: boolean`（缺省即权威清单来源）；`snapshot()` 原样透出，使 (4) 可机械断言。这是加可选字段，AC-157 的判据断言不改。
3. **`chat.subscribe` → `attachViewer` 接线**（`server/modules/websocket/services/chat-websocket.service.ts`）：订阅某会话时调 `sessionHostManager.attachViewer(sessionId)`。websocket → session-hosts 不构成环（session-hosts 只 import shared + express），但要在判据里打印该 import 边读数证明未新增反向依赖。
4. **判据文件** `server/modules/providers/tests/claude-resident-idle.test.ts`（新）：伪 SDK 流 + 注入时钟 + 注入调度器，直接驱动 driver + manager；逐条见 AC。

**非目标**：AC-161…AC-164 的各自机制（进程存活 / 无人轮 run / 忙时输入 / 可寻址）本条一概不实现；AC-162 的无人轮 **run 产生**与**通知触发类型**、AC-157 已落地的 manager 状态机与关闭原因枚举、AC-156 的 REST 形状、前端、`cloudcli` 子命令、`claude-runtime.provider.js`（四条既有判据是硬约束，一字节不动）一律不动。

## Plan

1. 读 AC-161 落地后的 resident driver 与 AC-157 落地后的 manager，按实际形状确认接缝（query 工厂、`now`、sink 动词），**不重复造**已有字段。
2. 落 `HostLease` 的 `inferred?: boolean`（可选，加字段）；`npm run typecheck` 绿。
3. driver：Stop hook 注册 + `session_crons` 整体覆盖 + `background_tasks`/`task_*` 事件 + 推测回退（标 `inferred`）+ 未知 subtype 放过 + 注入接缝。
4. 接线：`chat.subscribe` → `attachViewer`；打印 import 边读数。
5. 写判据（8 条判据 + 3 条假形态 + 正控制），伪帧键集照 E9 逐字构造。
6. 实测三臂假形态，抄退出码与红态文案，用后 `git checkout --` 还原。
7. `npm run typecheck`、`npm run lint`、六个既有判据文件全绿；写完成记录。

## AC

- [x] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-idle.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`，打印整体墙钟 `elapsed=<n>ms` 且 `< 60_000`。红态基线本轮实测：同命令退出 **1**、文案逐字 `Could not find 'server/modules/providers/tests/claude-resident-idle.test.ts'`。命令逐字含文件路径，不用 glob。
- [x] AC2 判据是伪 SDK 流 + 注入时钟：判据文件里没有真实等待（`grep -c "setTimeout\|await sleep\|node:timers" <判据文件>` → 0，判据自己打印 `real-wait-primitives=0`，模式用碎片拼出以免自匹配），钟与调度器由测试持有并同时注入 driver 与 manager。
- [x] AC3 伪帧键集逐字取自 E9：判据打印它构造的每一类帧的键集（`session_crons` / `background_tasks` / `task_started` / `task_notification` / `background_tasks_changed`），并断言键集**等于** §9.3–9.5 列出的键集（多一个键或换名即红）。
- [x] AC4 (1) cron 保活理由 + 7 天 `expiresAt` + 24 小时不关：打印 `lease.kind=cron id=<…> expiresAt=<created+7d>`（`expiresAt - createdAt === 7*24*60*60*1000`），把注入钟拨到 24 小时（`RESIDENT_IDLE_TIMEOUT`）处宿主仍 `state=idle`、`closeReason=null`（**正控制**：「不关」不得是恒真）。
- [x] AC5 (2) 下一轮清单不含该 cron ⇒ 理由消失、恢复计时：模型**从未**调用 `CronDelete`，但第二轮的 `session_crons` 为 `[]` ⇒ 打印 `cronLeaseGone=true`，此后按正常计时在 **24 小时**处 `closed(idle)`，打印 `idle-closed-at=<deadline>`。
- [x] AC6 (3) 清单一直含该 cron ⇒ 7 天过期后再计时关闭：打印 cron 例的两个 deadline（`rearmed-window-start=expiresAt`、`rearmed-deadline=expiresAt+RESIDENT_IDLE_TIMEOUT`），到 `rearmed-deadline` 才 `closed(idle)`；过期**前**一刻仍不关（打印 pending 读数）。
- [x] AC7 (4) 无 Stop hook 输入时退回工具调用推测并标 `inferred`：流里只给 `CronCreate`/`CronDelete` 工具调用（不给任何 hook 输入）⇒ 打印 `lease.kind=cron inferred=true`；下一轮出现 `CronDelete` 调用 ⇒ 理由消失（打印）。**正控制**：有清单那条打印 `inferred=false` —— 保证该标记不是恒真。
- [x] AC8 (5) 后台任务保活理由：`background_tasks` 非空**或** `background_tasks_changed.tasks` 非空 ⇒ 打印 `lease.kind=background-task id=<…>`；清单变空（`tasks:[]`）⇒ 理由消失并恢复计时（打印恢复后的 deadline）。两条来源各有一个用例。
- [x] AC9 (6) 未知 subtype 不中断循环：流里夹一条 `{"type":"system","subtype":"scheduled_task_fire",…}` ⇒ 打印 `unknownSubtypeSeen=true loopAlive=true`，且该例的计时与保活理由读数与不夹那条**逐字相同**（两条读数并列打印）。**正控制**：同一判据里 `scheduled_task_fire` 在 E9 工具表读数中打印为「本 build 未读到」（`scheduledTaskFireInE9=false`）。
- [x] AC10 (7) 浏览器停留不改变关闭时刻：经**真实** `chat.subscribe` 处理路径推 N 条订阅（打印 `subscribe-attach-calls=<n>` 且 `n>0`、`lastActivityAt` 逐字不变）⇒ 关闭时刻仍是原 deadline（打印 `idle-closed-at=` 与期望 deadline 相等）。**正控制**：同一绑定上一次真实活动（一轮边界经 `noteActivity`）把 `lastActivityAt` 推后（打印两个不同的值）—— 保证「不变」不是恒真。
- [x] AC11 (8) 关闭后 REST 读到 `closeReason=idle`：经 `createSessionHostsRouter({ sessionHostManager })`（**同一个** manager 实例）的 `GET /api/session-hosts` 读到该宿主 `closeReason=idle`（打印状态码与该字段）。**正控制**：关闭**前**同一条 REST 读 `closeReason=null`。
- [x] AC12 三臂假形态承重（判据文件一字不动，各臂实测，退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原）：(a) driver 不上报 cron 保活理由 ⇒ (1) 必须红（24 小时处被关）；(b) 只按工具调用推测、不读 `session_crons` ⇒ (2) 必须红（cron 理由一直在 ⇒ 24 小时处**不关**，与期望「关」相反）；(c) 遇未知 subtype 抛错中断循环 ⇒ (6) 必须红（循环死了、计时停摆）。
- [x] AC13 不使既有判据变红（逐条打印命令与退出码）：`server/modules/providers/tests/claude-resident-process.test.ts`（AC-161，若已落地）、`…/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts`、`server/modules/session-hosts/tests/session-host-lifecycle.test.ts`（AC-157）、`…/session-hosts-routes.test.ts`（AC-156）各自退出 **0**，且这六个文件 `git diff --name-only` 里没有。
- [x] AC14 契约面与接线方向：`npm run typecheck`、`npm run lint` 退出 0；`HostLease` 的改动是**加可选字段**（`inferred?: boolean`，仅 `cron` 与 `background-task` 用），既有 lease 形状与 AC-157 判据的断言不改；`chat-websocket.service.ts` 到 `@/modules/session-hosts/index.js` 的 import 边不引入反向依赖（打印该读数），跨模块只经 barrel。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-idle.test.ts`）重跑：退出码 0、`fail 0`、`elapsed < 60_000`。**真实落地**（不是「测试存在」）：判据真的用一个伪 SDK 流（帧的键集逐字取自 E9 §9.3–9.5）驱动**真实** resident driver；真的让 driver 经 sink 报出/收回 `cron` 与 `background-task` 保活理由（不是判据自己调 `leaseAdded` 冒充 driver）；真的用注入的钟把 24 小时与 7 天拨过去；真的在关闭后经真实 `GET /api/session-hosts` 读到 `closeReason=idle`；真的经真实 `chat.subscribe` 处理路径推订阅而 `lastActivityAt` 不动。三臂假形态（不上报 cron 理由 / 只按工具调用推测 / 遇未知 subtype 抛错）各自把对应判据打红（绿 = 判据有洞，必须先补判据再继续）。既有六个判据文件逐字不变且仍绿。完成后 AC-165 在驱动器下一轮经 `goal_ac: AC-165` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：三臂假形态必红，7 天 `expiresAt`、`inferred` 标记、未知 subtype 放过、订阅不刷新、REST 关闭原因五条读数各有正控制保证不是恒真。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（AC-161 落的 resident driver；本条在其上加 Stop hook 对账面与注入接缝；若实际文件名不同按实际登记并在完成记录写明）
- `server/modules/providers/tests/claude-resident-idle.test.ts` (new)
- `server/shared/types.ts`（`HostLease` 的 `cron`/`background-task` 加可选 `inferred`）
- `server/modules/websocket/services/chat-websocket.service.ts`（`chat.subscribe` → `attachViewer`）
- `server/modules/session-hosts/session-host-manager.service.ts`（仅当 `snapshot()` 未透出 `inferred` 时补；否则不动）
- `server/modules/session-hosts/index.ts`（barrel 收口；签名不变则不动）
- `tasks/gap-claude-resident-idle-close.md`（自触）

## Completion

落地在 `task/gap-claude-resident-idle-close`（worktree `/data/home/yale/work/claudecodeui-worktrees/gap-claude-resident-idle-close`）：实现 1 个 commit（`e64c0e3d`）+ 判据 4 个 commit（`624a536c` / `1abc0c64` / `7deac216` / `e44916e5`），外加一次 `merge develop`。判据命令逐字重跑：退出 **0**、`fail 0`、`elapsed=62ms`（< 60_000）、自打印 `real-wait-primitives=0`（`grep -c "setTimeout\|await sleep\|node:timers"` → 0）。

### AC1 读数（逐字）

命令 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-idle.test.ts` → `ℹ tests 1` / `ℹ pass 1` / `ℹ fail 0`，`idle elapsed=62ms`。红态基线（立案时实测，未变）：同命令退出 1、`Could not find 'server/modules/providers/tests/claude-resident-idle.test.ts'`。

### AC12 三臂假形态（判据文件一字未动；各臂只改 driver，用后 `git checkout --` 还原，工作树复原为 0 dirty）

| 臂 | driver 改动 | 退出码 | 红态文案逐字 | 落点 |
| --- | --- | --- | --- | --- |
| (a) 不上报 cron 理由 | `reconcileHeldWork` 里把 `this.settleCrons(state, cronsFromStopList(...))` 换成 `void cronsFromStopList(...)` | 1 | `AssertionError [ERR_ASSERTION]: the hook named one job and the binding holds it` + `0 !== 1` | (1) ✔ 按要求红 |
| (b) 只按工具调用推测 | `if (Array.isArray(crons))` → `if (false && Array.isArray(crons))` | 1 | `AssertionError [ERR_ASSERTION]: the retracted job leaves no cron lease` + `1 !== 0`，同轮读数 `cronLeaseGone=false cronDeletesSent=0 cronsAuthoritative=false` | (2) ✔ 按要求红 |
| (c) 未知 subtype 抛错 | 记一次 `unhandledSystemSubtypes` 后 `throw new Error("unknown system subtype: …")` | 1 | `AssertionError [ERR_ASSERTION]: a frame pushed after the unknown subtype was still read` + `false !== true`，读数 `unknownSubtypeSeen=true loopAlive=false frameAfterUnknownRead=false` | (6) ✔ 按要求红 |

(c) 的第一版判据读的是「宿主 state 尚未 closed」当存活读数，被该臂**挂死**而非打红（循环死在帧中，state 还停在 `busy`，`endRound` 等一个永不 settle 的轮）。判据已改成直接读数：未知 subtype **之后**再推一条本 build 读得懂的帧（`task_started id=b3liveness`），它的 lease 出现才叫循环还活着；该帧在同一轮结束前用 `task_notification` 收回，两例的 settled 读数保持逐字可比。改完 (c) 落成有界退出码 1。

### AC13 六个既有判据

各自 `npx tsx --tsconfig server/tsconfig.json --test <file>`：

- `server/modules/providers/tests/claude-resident-process.test.ts` 退出 0（tests 7 / pass 7 / fail 0）
- `server/modules/providers/tests/claude-host-per-run.test.ts` 退出 0（7 / 7 / 0）
- `server/modules/providers/tests/claude-background-work.test.ts` 退出 0（10 / 10 / 0）
- `server/modules/providers/tests/passthrough-parity.test.ts` 退出 0（4 / 4 / 0）
- `server/modules/session-hosts/tests/session-host-lifecycle.test.ts` 退出 0（6 / 6 / 0）
- `server/modules/session-hosts/tests/session-hosts-routes.test.ts` 退出 0（5 / 5 / 0）

六个文件都不在 `git diff --name-only develop` 也不在 `git diff --name-only 12b36ea1` 里（逐文件 `grep -c` → 0）。本条实际动到的文件只有四个：`server/modules/providers/list/claude/claude-host-driver.provider.ts`、`server/modules/providers/tests/claude-resident-idle.test.ts`、`server/modules/websocket/services/chat-websocket.service.ts`、`server/shared/types.ts`。`session-host-manager.service.ts` 与 `session-hosts/index.ts` **未动** —— `snapshot()` 用展开复制每个 lease（`binding.leases.map((lease) => ({ ...lease }))`），可选的 `inferred` 原样透出，barrel 签名不变。（`git diff --name-only develop` 另有两个 `tasks/*.md` 因 develop 在立案后前进而出现在 diff 里，非本条所改。）

### AC14 契约面读数

- `npm run typecheck` 退出 **0**；`npm run lint` 退出 **0**（仅既有 warning）。
- `HostLease` 改动是加可选字段：`background-task|monitor` 与 `cron` 两个变体各加 `inferred?: boolean`，`turn` 与 `resident-policy` 不加。既有 lease 形状不变，AC-157 判据的断言不改。
- import 边读数：`grep -rn "session-hosts" server/modules/websocket/ | grep -v /tests/` → 只有两条，`chat-websocket.service.ts:7` 与 `:8`，都走 barrel `@/modules/session-hosts/index.js`；反向 `grep -rn "modules/websocket" server/modules/session-hosts/ | grep -v /tests/` → **0 命中**，无反向依赖，跨模块只经 barrel。

### 两处按实际形状偏离 AC 措辞（读数在此在案）

1. **AC4 的「宿主仍 `state=idle`」**：(1) 在 24 小时处实际读到的是 **`binding.state=idle` + `host.state=lingering`**，`closeReason=null`。这不是偏差而是 manager 共享词表本身的口径 —— `deriveState` 对任何非 `resident-policy` 的 lease 都把宿主读成 `lingering`、把绑定读成 `idle`，AC-157 落地的判据断言的正是这一条（`gap-session-hosts-lease-driven-lifecycle`）。判据把两个读数都打印出来，并断言 `binding.state === "idle"` 且 `closeReason === null` 且 `host.state !== "closed"`，另外在同一次拨钟上跑一个**正控制**（只有 `resident-policy` 的裸常驻宿主在同一次 24 小时拨钟后 `closed(idle)`），保证「不关」不是恒真。
2. **Touches 段里新判据那一行**原写作 `` `…/claude-resident-idle.test.ts`（新：判据） ``，全角括注直接贴住路径 ⇒ scoped gate 的 `awk '{print $1}'` 切不出以 `.test.ts` 结尾的路径、读数 `no scoped test files … (thin)`、什么都不跑。已改成 ASCII `` `…/claude-resident-idle.test.ts` (new) ``。