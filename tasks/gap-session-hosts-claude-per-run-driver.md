---
id: gap-session-hosts-claude-per-run-driver
title: AC-159 Claude per-run 的后台持有与顶替由宿主层策略执行：伪造 SDK 流下 result 后 lingering、新一轮
  superseded、30 分钟静默 released 且输入流被结束、后台回报 result released 且
  notifyBackgroundWorkCompleted 恰一次；claude-background-work.test.ts 不改断言照常通过
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
  - gap-voice-falsify-copies-inside-tsc-program
  - gap-debug-agent-ac10-reads-the-whole-branch-delta
goal_ac: AC-159
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-159" tasks/*.md | wc -l` → **0**；`grep -rln "AC-159" tasks/*.md | wc -l` → **5**（合计 8 处命中），全部落在五条邻居任务的**非目标**段（`gap-session-hosts-default-wrap-four-providers`、`gap-session-hosts-lease-driven-lifecycle`、`gap-session-hosts-binding-multiplexing`、`gap-session-hosts-rest-list-endpoint`、`gap-session-hosts-per-run-frame-parity`），没有一条认领它。代码侧：`grep -rn "IProviderHostDriver\|hostDriver\|closeHost\|HostLease\|SessionBinding\|supersedeOnNewTurn\|HostCloseReason" server/ src/ shared/` → **0** 命中；`grep -rn "supersededInstances" server/ src/ shared/` → **4** 命中且**全部**在 `server/modules/providers/list/claude/claude-runtime.provider.js`（`:52`、`:343`、`:1095`、`:1125`）。⇒ AC-159 无认领者；本条要建的机制（Claude per-run 的**真** driver，把「新一轮顶替」与「result 后 30 分钟 stdin 后备持有」这两项从 runtime 内部决策迁到宿主层策略，并使关闭原因可辨为 `superseded`）与五条邻居（默认包装 / lease 状态机 / 1:N 绑定 / REST / 逐帧比较）机制都不同，本条不是重复。

本条的前置是三条已立案的邻居，它们各自认领了本条要驱动的那个对象：`gap-session-hosts-default-wrap-four-providers`（AC-154）落 `SessionHostManager`、`ProcessHost`、`SessionBinding`、`HostLease` 与 facet `IProvider.hostDriver?`；`gap-session-hosts-lease-driven-lifecycle`（AC-157）落 lease 驱动的状态机、`LifecyclePolicy`、`lingering`/`released` 与保活理由集合（`turn`/`background-task`/`monitor`/`cron`/`resident-policy`，见 GOAL-012「背景」段）；`gap-session-hosts-binding-multiplexing`（AC-158）落 per-run 顶替的**先关后起**次序与 `superseded` 的写入路径。三条都在各自的**非目标**里把「真实 Claude driver 的顶替与 30 分钟持有」让给本条（`gap-session-hosts-binding-multiplexing:64`、`gap-session-hosts-lease-driven-lifecycle:60`、`gap-session-hosts-per-run-frame-parity:60`）。故本条顶层 `depends_on` 指向这三条：判据直接驱动它们建出来的 manager 与 facet，先有它们的 module 与共享契约才能落地。

**来源与判据物。** 判据逐字取自 `goals/AC-159-claude-per-run-的后台持有由宿主层策略执行-被新一轮顶替时可辨为-superseded.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`（命令逐字含文件路径，不用 glob）。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-host-per-run.test.ts'`。

**命令形状是好的，红只因缺文件**（这条是本条红态归因的承重件，单独测过）：同一命令形状跑现有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts` → 退出 **0**，读数 `tests 10 / pass 10 / fail 0 / duration_ms 756.650812` ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮实测的读数）—— 持有与顶替今天都在 runtime 内部**

- 两半机制写在 `server/modules/providers/list/claude/claude-runtime.provider.js:55-73` 的注释里，常量 `BG_WAIT_CEILING_MS = 30 * 60 * 1000`（`:73`）：(1) 作为 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 传给被 spawn 的 CLI（`:231`；管后台 **agent** 的等待）；(2) 作为 SDK stdin 在 `result` 之后的后备持有（管后台 **shell**，因为 stdin EOF 被 CLI 读成 print wind-down）。
- 持有面：`createHeldPromptStream`（`:687`，`held` Promise + `release`）、`scheduleRelease`（`:812-825`，`setTimeout(..., BG_WAIT_CEILING_MS)`，**每条后续消息都重置** ⇒ 量的是静默而非总时长）、`releasePromptStream()` 在 `finally`（`:1160-1170`）。
- 顶替面：`queryClaudeSDK` 开头 `getSession(sessionKey())?.releaseInput?.()`（`:806-808`）；`addSession` 里 `supersededInstances.add(existing.instance)` + `existing.releaseInput?.()`（`:339-352`）；读回在 `:1095`、`:1125`。关闭原因今天是内部布尔 `superseded`，**没有**对外的可读 `closeReason`。
- 后台工作识别：`startsBackgroundWork`（`:617`，**已导出**；`claude-background-work.test.ts:4` 逐字 import 它）。通知 `notifyBackgroundWorkCompleted` 在 `:1060`（由 `heldForBackgroundWork` 守卫 ⇒ 今天**恰好一次**）。
- **邻居钉住的两条边界**（它们决定本条的改法）：`server/modules/providers/tests/passthrough-parity.test.ts:50` 与 `:109` 把「`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 必须出现在 `sdkOptions.env` 里」钉成断言 ⇒ 上面第 (1) 半（CLI 侧 env）**必须原样保留**，本条只迁第 (2) 半（服务端 stdin 后备持有）与顶替决策；`claude-background-work.test.ts:4` 以 `.../claude-runtime.provider.js` 这一**路径与扩展名** import `startsBackgroundWork`，而判据第 (5) 项要求该文件**不改断言照常通过** ⇒ `claude-runtime.provider.js` 必须**保持 `.js` 且保持该路径**（⇒ 后端标准里「碰到的 JS 迁 TS」在本条**不可能**在不弄红判据 (5) 的前提下执行；这是有据的、要写进完成记录的有意偏离，不是遗漏）。

**要建的东西（范围是 AC-159 的最小充分集）**

1. **Claude per-run host driver**（`server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts`，**拟名**，按 AC-154 落地后的 facet 实际形状对齐；resident driver 是 GOAL-013 的范围，不在本条）。实现 AC-154 的 `IProviderHostDriver`，且必须：
   - **拥有 SDK 输入流**：构造 `prompt` 异步可迭代（即今天 `createHeldPromptStream` 那一份的所有权），把释放句柄经 `HostHandle` 暴露给 manager；`closeHost(host, reason)` ⇒ 结束输入流（EOF），必要时 `interrupt()`。
   - **不再自己顶替**：`run()` 一开局不再 `getSession(key)?.releaseInput?.()`（那是阶段 1a 的旁观包装）。「同一会话新一轮 ⇒ 旧宿主先关」由 manager 的 `supersedeOnNewTurn` 策略执行（AC-157/AC-158 的入口），driver 只按 facet 收 `submit`/`closeHost`。
   - **保活理由**：把每条原始 SDK 消息交给**已导出的** `startsBackgroundWork`（`:617`；**不新起第二份工具分类**），命中时向 sink 报 `leaseAdded`，理由按触发工具落到 `background-task` 或 `monitor`（集合来自 AC-157 的共享枚举）；`result` 到达时撤 `turn` lease。
   - **通知恰好一次**：后台工作回报产生的后续 `result`（今天 `:1060` 的 `heldForBackgroundWork` 语义）⇒ 通知 sink 恰一次（**恰好一次**，不是「至少一次」）。
   - **SDK 注入面**：driver 构造时注入 `createQuery`（默认 = `@anthropic-ai/claude-agent-sdk` 的 `query`）与通知 sink。理由（实测）：仓库 `mock.module` 用法 **0** 处；`claude-runtime.provider.js:20` 是模块级 `import { query }`，模块绑定打桩不可行；`t.mock.method` 的先例（`server/modules/providers/tests/codex-runtime.test.ts:27`）打在 SDK 类原型上，对模块级函数同样不适用 ⇒ 判据要「伪造 SDK 流」，唯一稳的缝是**依赖注入**。假 `query` 返回假 `Query`（异步可迭代的脚本化消息序列 + `interrupt()` + 测试可推消息的 push 句柄），并让 driver 交给它的 `prompt` 迭代器可观测（测试据此断言「输入流被结束」）。
   - **时钟**：30 分钟静默与「29 分钟不释放」两个读数要在不真实等待下产出 ⇒ 复用 AC-157 落地的可注入 scheduler/clock（**不新起第二份计时实现**）；若 AC-157 未暴露该面，用 `node:test` 的 `t.mock.timers.enable({ apis: ['setTimeout'] })` + `tick` 亦可（仓库今天无 `mock.timers` 先例，如实登记实际用的哪一种）。
2. **Runtime 侧的迁移**（`server/modules/providers/list/claude/claude-runtime.provider.js`，**保持 `.js` 与该路径**）：把服务端 stdin 后备持有与内部顶替的**决策**让出——(a) 保留 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 的 env 组装（passthrough-parity 钉住）；(b) 暴露 driver 需要的观察/释放面（原始 SDK 消息的观察点与输入流释放句柄）；(c) `BG_WAIT_CEILING_MS` 计时器与「新一轮 ⇒ releaseInput」不再由 runtime 自己决定（迁到 manager 策略）。**保留** `startsBackgroundWork` 的导出与行为（判据 (5) 与 `claude-background-work.test.ts` 钉住）。
3. **facet 挂载**（`server/modules/providers/list/claude/claude.provider.ts`）：`readonly hostDriver = new ClaudePerRunHostDriver(...)`，与既有 `fork`/`rename` 同形。
4. **判据测例** `server/modules/providers/tests/claude-host-per-run.test.ts`：`node:test` + `node:assert/strict`，import 用 `@/modules/…js` / `@/shared/…js`（与 `claude-background-work.test.ts` 同形），假 SDK 注入 + 计数通知 sink + 注入时钟 + 调用/事件日志。

**判据测例怎么搭**（每个子例逐行打印读数；除注入时钟外没有真实等待）

- 共享脚手架：假 `query` 形如 `{ async *[Symbol.asyncIterator]() { for await (const m of scripted) yield m; }, async interrupt() {} }`，`scripted` 由测试的 push 句柄喂；driver 交给它的 `prompt` 迭代器被记在 `inputStream` 上，测试可 `await` 它完成 ⇒ 这是「输入流被结束」的读数来源。通知 sink 记 `notifyBackgroundWorkCompleted` 的调用次数。
- **(1) result 后 lingering**：脚本给一轮含 `Bash{run_in_background:true}`（或 `Monitor`）的工具调用 + 一条 `result` ⇒ 打印 `afterResult state=lingering leases=[background-task]`（`Monitor` 那一形打印 `leases=[monitor]`）。**正控制**：同形状但一轮只有 `Read` + `result` ⇒ `noBackground state=closed closeReason=turn-complete`——没有它，`lingering` 可能只是默认态。
- **(2) 顶替 superseded**：在 (1) 的持有期内对**同一会话**开新一轮 ⇒ 打印旧宿主 `closeReason=superseded`、新宿主 `state=busy`、该会话绑定数恰为 1。**正控制**：旧宿主 `closeReason` **不是** `released`、**不是** `turn-complete`（这正是假形态要打的读数）。
- **(3) 30 分钟静默 ⇒ released 且输入流结束**：推进注入时钟 30 分钟 ⇒ `after30m state=closed closeReason=released inputStreamEnded=true`；**正控制**：推进到 29 分钟 ⇒ `at29m state=lingering inputStreamEnded=false`——没有它「30 分钟」这个数值不承重。
- **(4) 后台回报的后续 result ⇒ released 且通知恰一次**：在 (1) 之后推入后台工作回报的后续 `result` ⇒ `notifyCount=1 state=closed closeReason=released`；**正控制**：释放后再推一条 `result` ⇒ `notifyCount` 仍为 **1**。
- **(5) 现有用例不改断言**：`git diff --name-only` 不含 `server/modules/providers/tests/claude-background-work.test.ts`；该文件按判据命令跑出 `pass 10 / fail 0`。
- 末尾打印 `elapsed=<n>ms`。

**假形态（判据的分辨力证明，必须实测）**

判据逐字指定的那一形：**保留阶段 1a 的旁观包装——顶替仍在 runtime 内部完成**（不让 manager 的 `supersedeOnNewTurn` 决策；`run()` 一开局照旧 `getSession(key)?.releaseInput?.()`，manager 只观察收尾）⇒ 判据命令必须退出 **1**，红文案落在 (2) 的 `closeReason` 读数上（读成 `released` 而非 `superseded`）。只改实现、判据文件一字不动；实测完 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。**如实登记**：若该假形态下 (2) 是以别的读数先红的（例如新宿主 `state` 不符），把实际红文案逐字抄进完成记录——红必须落在 `closeReason` 读数上，否则这条假形态没有承重。

**非目标**：默认包装与四个 provider 的真实分派入口登记（AC-154）、逐帧不变（AC-155）、`GET /api/session-hosts`（AC-156）、lease 状态机/停机/关闭原因穷举（AC-157）、1:N 解绑与单写者（AC-158）、调试 agent 的 `hostDriver` 与场景 op（AC-160）、**Claude resident driver**（GOAL-013）、能力矩阵的 `lifecycleModes`/`multiplexedHost` 镜像（无 AC 判据覆盖）、`process-containment.service.ts`、数据库 `lifecycle_mode` 列、前端。**不改 `server/modules/providers/list/{codex,cursor,opencode}/**`、不改 `server/modules/websocket/**`**，不改任何 per-run 的客户端可见行为。

## Plan

1. 读 AC-154 / AC-157 / AC-158 的落地提交：manager 的实际形状（工厂名、`snapshot()`、`HostHandle`、driver facet 的方法名与 sink 事件、`LifecyclePolicy.supersedeOnNewTurn`、`lingering`/`released`/`superseded` 的实际产生入口、可注入时钟的实际面）。按实际形状改第 1 条的调用名与测例脚手架，**不重复造**已有字段/入口；若发现三条前置尚未落地，**不得**自行补它们的范围（那是它们的前置），如实登记并停在这一步。
2. 落 Claude per-run driver（`claude-per-run-host-driver.provider.ts`）：输入流所有权与 `releaseInput`/`closeHost`、注入的 `createQuery` 与通知 sink、`startsBackgroundWork` 驱动的 lease 增减、后续 `result` 的通知恰一次。
3. Runtime 迁移：暴露 driver 需要的观察/释放面；把 `BG_WAIT_CEILING_MS` 计时与「新一轮 ⇒ releaseInput」的**决策**让给 manager（保留 env 组装与 `startsBackgroundWork` 导出，文件保持 `.js` 与该路径）。
4. 挂 facet（`claude.provider.ts`），`npm run typecheck` 绿。
5. 写判据测例（五个子例 + (1)(3)(4) 的正控制），注入时钟与假 SDK 流，读数逐行打印。
6. 实测假形态（顶替留在 runtime 内部），抄退出码与红态文案，`git checkout --` 还原。
7. `npm run typecheck`、`npm run lint`；邻居判据文件（`claude-background-work.test.ts`、`passthrough-parity.test.ts`，以及 AC-155 落地后的 `session-host-per-run-parity.test.ts`）全绿；写完成记录。

## AC

- [x] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`（命令逐字含文件路径，不用 glob）。红态基线已测：同命令当前退出 1、stdout 逐字 `Could not find 'server/modules/providers/tests/claude-host-per-run.test.ts'`；同一命令形状跑既有 `server/modules/providers/tests/claude-background-work.test.ts` 退出 0（`tests 10 / pass 10 / fail 0 / duration_ms 756.650812`）⇒ 红只因缺文件。
- [x] AC2 (1) result 后 lingering 且保活理由对应触发工具：含 `Bash{run_in_background:true}` 的一轮 ⇒ 打印 `afterResult state=lingering leases=[background-task]`；含 `Monitor` 的一轮 ⇒ 打印 `leases=[monitor]`。**正控制**：只有 `Read` 的一轮 ⇒ `noBackground state=closed closeReason=turn-complete`（打印该行）。
- [x] AC3 (2) 顶替可辨为 superseded：持有期内同一会话开新一轮 ⇒ 打印旧宿主 `closeReason=superseded`、新宿主 `state=busy`、该会话绑定数 **1**；**正控制**：该 `closeReason` 读数行里 `released` 与 `turn-complete` 都不出现（`grep -c` 为 0，打印该读数）。
- [x] AC4 (3) 30 分钟静默 ⇒ released 且输入流被结束：推进注入时钟 ⇒ `after30m state=closed closeReason=released inputStreamEnded=true`；**正控制**：29 分钟 ⇒ `at29m state=lingering inputStreamEnded=false`。两行都打印。
- [x] AC5 (4) 后台回报的后续 result ⇒ released 且 `notifyBackgroundWorkCompleted` 恰一次：`notifyCount=1 state=closed closeReason=released`；**正控制**：释放后再推一条 `result` ⇒ `notifyCount` 仍为 1。两行都打印。
- [x] AC6 (5) 现有用例不改断言照常通过：`git diff --name-only` **不含** `server/modules/providers/tests/claude-background-work.test.ts`，且该文件按判据命令跑出 `pass 10 / fail 0`（打印读数）；`server/modules/providers/tests/passthrough-parity.test.ts` 退出 0（它钉住 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 仍在 `sdkOptions.env` 里）。
- [x] AC7 假形态承重：把顶替留在 runtime 内部（manager 只观察）⇒ 判据命令退出 **1**，红文案落在 (2) 的 `closeReason` 读数上（读成 `released` 而非 `superseded`）。实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [x] AC8 确定性与可重复：判据文件里没有真实等待（`grep -c "await new Promise\|await sleep\|setTimeout(" server/modules/providers/tests/claude-host-per-run.test.ts` → 0，打印该读数；唯一的时序控制是注入时钟与 promise 结算），连续两次运行的关键读数行逐字相同（两行都打印），墙钟 `elapsed=<n>ms` 且 `< 60_000`。
- [x] AC9 复用而非第二份实现：`grep -n "startsBackgroundWork" server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts` 有输出（import 自 `claude-runtime.provider.js`）；`grep -n "1800000\|30 \* 60\|BG_WAIT_CEILING" <driver-file>` **无**输出（30 分钟来自 manager 策略，不在 driver 里重声明）；`grep -c "run_in_background" <driver-file>` → 0（前台/后台的判定不重写）。三条读数都打印。
- [x] AC10 契约面与边界：`npm run typecheck`、`npm run lint` 退出 0；`git diff --name-only` 只含 Touches 列出的文件；`ls server/modules/providers/list/claude/claude-runtime.provider.js` 存在（**判据 (5) 的 import 路径与扩展名不变**）；`git diff --name-only` 里没有 `server/modules/providers/list/codex/**`、`.../cursor/**`、`.../opencode/**`、`server/modules/websocket/**`。
- [x] AC11 如实登记：完成记录写明（a）AC-154/157/158 落地后 manager 与 facet 的实际形状、本条实际用的入口名；（b）SDK 注入面的实际形状与假流是怎么喂进去的；（c）假形态的实测退出码与红态文案；（d）runtime 内部顶替/持有代码是删除还是留而失效、为什么；（e）时钟用的是 AC-157 的注入面还是 `t.mock.timers`；（f）`claude-runtime.provider.js` 保持 `.js` 的理由（判据 (5) 钉住 import 路径）与后端标准「碰到的 JS 迁 TS」在本条被有意偏离；（g）未实现：AC-154…AC-158、AC-160、resident（GOAL-013）、前端。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`）重跑：退出码 0 且 `fail 0`。AC2 的 lingering 两形与其正控制、AC3 的 `superseded`/`busy`/绑定数三个读数与「不是 released/turn-complete」的正控制、AC4 的 `after30m`/`at29m` 两行与 `inputStreamEnded`、AC5 的 `notifyCount=1` 与释放后仍为 1、AC6 的邻居读数与「`git diff` 不含被钉住的测试文件」、AC7 的假形态实测退出码与红态文案、AC8 的两次运行一致性与 `elapsed`，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；四个 runtime 里只动 claude，且它保持 `.js` 与该路径）。完成后 AC-159 在驱动器下一轮经 `goal_ac: AC-159` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC7「顶替留在 runtime 内部」的假形态必红（`closeReason` 读数那条），AC2 的无后台正控制保证 `lingering` 不是默认态，AC4 的 29 分钟正控制保证「30 分钟」这个数值承重，AC5 的释放后读数保证「恰好一次」不是恒真。

## Touches

- server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts (new)
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/list/claude/claude.provider.ts
- server/modules/providers/tests/claude-host-per-run.test.ts (new)
- tasks/gap-session-hosts-claude-per-run-driver.md

## 完成记录

### (a) AC-154/157/158 落地后 manager 与 facet 的实际形状，本条实际用的入口名

（以下均为本轮实测，不是拟名）

- manager 工厂与注入面：`createSessionHostManager(options)`（`server/modules/session-hosts/session-host-manager.service.ts:230`），`options = { now, scheduler, createHostId, createRunId, perRunPolicy, residentPolicy }`；单例 `sessionHostManager` 由 `@/modules/session-hosts/index.js` 导出。AC-157 暴露的时钟缝是 `HostScheduler = { now(): number; schedule(at, run): () => void }`（取消句柄在截止后必须是 no-op），本条**复用它**（见 (e)）。
- facet：`IProvider.hostDriver?: IProviderHostDriver`（`server/shared/interfaces.ts:84`），方法 `startHost/bind/submit/interrupt/reconfigure/unbind/closeHost` + 可选 `multiplexedHost?: boolean`；sink `IProviderHostDriverSink = { leaseAdded, leaseRemoved, activity, exited }`。
- 本条实际用的入口：`bindSession({ provider: 'claude', appSessionId, driver, mode: 'per-run' })` → `HostBindResult`；`snapshot()` 取回 `ProcessHost`（bind 的答复只带 hostId）；sink 四动词；driver 侧 `startHost/bind/submit/unbind/closeHost` 与 `interrupt/reconfigure`。**未使用** `HostHandle`（AC-154 落地的形状是 driver 自己持有输入流句柄、manager 只经 `closeHost` 通知）与 `multiplexedHost`（per-run 一宿主一绑定，无需声明多路复用）。
- 关闭原因实测产生：`turn-complete`（无后台的轮次结束）、`superseded`（`supersedeOnNewTurn` 策略）、`released`（30 分钟静默、后台回报）。
- lease 实际取值：`turn`（submit 时报，轮次自己的 `result` 撤）、`background-task` 与 `monitor`（后台工作；`monitor` 只给 `Monitor` 工具，其余走 `background-task`）。

### (b) SDK 注入面的实际形状与假流是怎么喂进去的

- driver 构造注入 `createQuery`（`ClaudeHostQueryFactory = ({ prompt, options }) => ClaudeHostQueryStream`），默认 `sdkQuery` = `@anthropic-ai/claude-agent-sdk` 的 `query`，只在边界处收窄为 `AsyncIterable<AnyRecord> & { interrupt(): Promise<void> }`。理由与 Proposal 的实测一致：仓库 `mock.module` 用法 0 处、runtime 的 `import { query }` 是模块级绑定、`t.mock.method` 只能打在 SDK 类原型上 ⇒ 唯一稳的缝是**依赖注入**；本条**没有**用模块打桩。
- manager 同样以 port 注入：`ClaudeHostPort = Pick<SessionHostManager, 'bindSession' | 'snapshot'>`，故判据能注入带自己时钟的 manager（30 分钟因此可达而不必真等）。
- 假流：`{ [Symbol.asyncIterator]: () => queue.iterator(), async interrupt() { ... } }`；队列由 `EventEmitter` 支撑，测试 `push(msg)` 喂消息，`deliver(msg)` = push + `await taken(n)`（**交接屏障**，解析于消费方真的把这条消息取走时）+ 固定跳数的微任务让行 ⇒ 每个读数都归属到「这条消息已被 driver 读到」。
- 输入流的可观测面：driver 交给假 query 的 `prompt` 就是 runtime `createHeldPromptStream` 的 `stream`，判据对它做泵（`for await`），泵结束即置 `inputEnded = true` ⇒ 这是「输入流被结束」读数的来源。

### (c) 假形态（AC7）实测退出码与红态文案

变体（只改实现，判据一字不动）：在 `run()` 开头把同一会话已有 run 的 `turn`/后台 lease 由 driver 自己撤掉并 `endHold`（即阶段 1a「driver 自己顶替、manager 只观察」的形状）。实测：退出码 **1**，唯一红的是 AC3，红文案逐字：

```
✖ AC3: a new turn on a lingering session is the manager superseding it (2.443283ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'released'
  - 'superseded'

      at TestContext.<anonymous> (/data/home/yale/work/claudecodeui-worktrees/gap-session-hosts-claude-per-run-driver/server/modules/providers/tests/claude-host-per-run.test.ts:484:10)
```

该形态下 (2) 的读数行逐字：`supersede old=h1 closeReason=released new=h2 state=busy liveBindings=1 hostRecordsCarryingTheBinding=2`，同行证据 `supersede evidence oldInputEnded=true oldInterrupts=0` ⇒ 红**正是**落在 `closeReason` 读数上（读成 `released`，应读 `superseded`），且紧随其后的 `state=busy`/`liveBindings=1` 本身成立 ⇒ 该形状的差别只在「谁做了顶替决定」。用后 `git checkout -- server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts` 还原（`git status --short` 空；`grep -c "FALSIFYING VARIANT" <driver>` → 0）。

### (d) runtime 内部顶替/持有代码：**留而未删**，只对 driver 路径失效

- `claude-runtime.provider.js` 的 `scheduleRelease`/`releaseInput`/`supersededInstances`/`BG_WAIT_CEILING_MS` 计时**全部保留**，本轮只给 `buildPromptMessages` 与 `createHeldPromptStream` 加了 `export`（各附一段 JSDoc 说明消费方是 per-run host driver）。
- 为什么留：AC6 钉住 `claude-background-work.test.ts` **不改断言**且 `passthrough-parity.test.ts`（钉 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 必须仍在 `sdkOptions.env` 里）退出 0；runtime 自己的 `queryClaudeSDK` 路径仍是**应用分派的今天**（把分派改走 driver 是 mode/turn 集成的事，见 driver 文件头「What it does not own」），删掉 runtime 自己的持有会改 per-run 的**客户端可见行为**，而任务**非目标**明令不改。
- 因此 driver 路径**绕过**这些内部决策（driver 自己持有输入流、自己撤 lease），runtime 的那些决策对 host 驱动的 run 不生效。

### (e) 时钟：用 AC-157 的注入面，不是 `t.mock.timers`

`createSessionHostManager({ now: () => clock.now(), scheduler: clock, createHostId: () => 'h' + (++serial) })`；`clock` 是判据内的 `FakeClock implements HostScheduler`——`advanceTo(at)` 按截止顺序触发，并在触发前把时钟置到**该截止时刻**（这样 handler 里再排的截止也按同一时刻计量）。判据里**没有** `t.mock.timers`，也没有任何真实等待。

### (f) `claude-runtime.provider.js` 保持 `.js` 是有意偏离

AC6 要求 `server/modules/providers/tests/claude-background-work.test.ts` 不改断言照常通过，而该文件第 4 行以 `.../claude-runtime.provider.js` 这一**路径与扩展名** import `startsBackgroundWork` ⇒ 迁 TS 会弄红本条的判据 (5)。故 backend-module-standards 的「碰到的 JS 迁 TS」在本条被有意偏离（同一理由已写进 Proposal）。

### (g) 未实现（如实登记）

AC-154…AC-158、AC-160、Claude resident driver（GOAL-013）、前端、能力矩阵的 `lifecycleModes`/`multiplexedHost` 镜像、`process-containment.service.ts`、数据库 `lifecycle_mode` 列；应用分派入口**未**改（仍走 runtime 自己的 `run`）；`server/modules/providers/list/{codex,cursor,opencode}/**` 与 `server/modules/websocket/**` 未改。

### 判据读数（AC1–AC9）

在**落地后的树**（本轮分支 HEAD = `05db7d4a`，尚未并入 develop 时的一次）上按原命令跑，退出码 **0**：

```
classifier backgroundedBash=true monitor=true readOnly=false
afterResult state=lingering leases=[background-task] inputStreamEnded=false
afterResult state=lingering leases=[monitor]
noBackground state=closed closeReason=turn-complete inputStreamEnded=true
supersede old=h1 closeReason=superseded new=h2 state=busy liveBindings=1 hostRecordsCarryingTheBinding=2
supersede evidence oldInputEnded=true oldInterrupts=1
supersede control forbiddenTokens=0 reading=<supersede old=h1 closeReason=superseded new=h2 state=busy liveBindings=1 hostRecordsCarryingTheBinding=2>
quiet deadline=+1800000ms ceiling=1800000
at29m state=lingering inputStreamEnded=false
after30m state=closed closeReason=released inputStreamEnded=true
heldWork notifyCount=1 state=closed closeReason=released
heldWork control afterReleasePush notifyCount=1 pushed=4 taken=4
gitDiff workingTreeFiles=0 vsDevelopFiles=4 containsNeighbour=false driverExists=true driverInDelta=true
neighbour server/modules/providers/tests/claude-background-work.test.ts exit=0 tests=10 pass=10 fail=0
parity server/modules/providers/tests/passthrough-parity.test.ts exit=0 tests=4 pass=4 fail=0
server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts startsBackgroundWorkLines=[22,53,174,183,195]
driver ceilingLiterals=0 runInBackgroundLiterals=0
criterionSource await new Promise -> lines=0
criterionSource await sleep -> lines=0
criterionSource setTimeout( -> lines=0
--- key readings ---
afterResult state=lingering leases=[background-task] inputStreamEnded=false
afterResult state=lingering leases=[monitor]
noBackground state=closed closeReason=turn-complete inputStreamEnded=true
supersede old=h1 closeReason=superseded new=h2 state=busy liveBindings=1 hostRecordsCarryingTheBinding=2
at29m state=lingering inputStreamEnded=false
after30m state=closed closeReason=released inputStreamEnded=true
heldWork notifyCount=1 state=closed closeReason=released
heldWork control afterReleasePush notifyCount=1 pushed=4 taken=4
gitDiff containsNeighbour=false driverExists=true
driver startsBackgroundWorkLines=5
driver ceilingLiterals=0 runInBackgroundLiterals=0
criterionSource await new Promise lines=0
criterionSource await sleep lines=0
criterionSource setTimeout( lines=0
--- end key readings ---
keyReadings lines=14 sha256=79ae7d64ee666919
elapsed=1721ms
✔ AC2: a turn that starts work outliving itself leaves the host lingering (4.099205ms)
✔ AC3: a new turn on a lingering session is the manager superseding it (0.631655ms)
✔ AC4: the quiet ceiling is the manager releasing a host it no longer needs (0.748103ms)
✔ AC5: the held work reports back exactly once, and then the host releases (0.419341ms)
✔ AC6: the criteria this one leans on are untouched and still green (1710.409391ms)
✔ AC9: the driver delegates the background-work decision and carries no ceiling (0.730063ms)
✔ AC8: the criterion waits on no clock, and its key readings are reproducible (0.710064ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2185.469701
```

- **AC1**：入口退出 0、`ℹ fail 0`。红态基线（Proposal 逐字实测）：同命令退出 1、stdout 逐字 `Could not find 'server/modules/providers/tests/claude-host-per-run.test.ts'`；同一命令形状跑既有 `claude-background-work.test.ts` 退出 0（`tests 10 / pass 10 / fail 0`）⇒ 红只因缺文件。
- **AC2**：`afterResult state=lingering leases=[background-task] inputStreamEnded=false`、`afterResult state=lingering leases=[monitor]`、正控制 `noBackground state=closed closeReason=turn-complete inputStreamEnded=true`。三行都打印；另外先打印 `classifier backgroundedBash=true monitor=true readOnly=false` —— 那是把三个 fixture 先喂给 runtime **自己的** `startsBackgroundWork` 的正控制，保证 leg 的绿不是因为 fixture 什么都没要求。
- **AC3**：`supersede old=h1 closeReason=superseded new=h2 state=busy liveBindings=1 hostRecordsCarryingTheBinding=2`（`liveBindings`＝该会话仍被服务的进程数，恰 1；闭宿主保留绑定记录，故同行的 `hostRecordsCarryingTheBinding=2` 也打印，不藏）。正控制：`supersede control forbiddenTokens=0 reading=<...>` —— 该读数行里 `released` 与 `turn-complete` 都不出现。旁证 `supersede evidence oldInputEnded=true oldInterrupts=1`：旧进程真被 interrupt 且输入流真被结束，不是只改了标签。
- **AC4**：`quiet deadline=+1800000ms ceiling=1800000`（截止 = manager 策略的常量，不是 driver 里的数）、正控制 `at29m state=lingering inputStreamEnded=false`、`after30m state=closed closeReason=released inputStreamEnded=true`。三行都打印。
- **AC5**：`heldWork notifyCount=1 state=closed closeReason=released`；正控制 `heldWork control afterReleasePush notifyCount=1 pushed=4 taken=4` —— 释放后再推一条 `result`，通知仍为 1，且 `taken=pushed=4` 证明那条消息**真的被读走**（沉默是 driver 的决定，不是没人读）。
- **AC6**：`gitDiff workingTreeFiles=0 vsDevelopFiles=4 containsNeighbour=false driverExists=true driverInDelta=true`（工作区 diff 0 文件 ⇒ 判据没碰被钉住的邻居；对 develop 的 delta 4 文件见 AC10）；邻居读数 `neighbour .../claude-background-work.test.ts exit=0 tests=10 pass=10 fail=0`，`parity .../passthrough-parity.test.ts exit=0 tests=4 pass=4 fail=0`。
- **AC7**：见 (c)，退出 1、红落在 AC3 的 `closeReason` 读数。
- **AC8**：判据文件里 `criterionSource await new Promise lines=0`、`await sleep lines=0`、`setTimeout( lines=0`（三个 needle 在文件内由 `'await' + ' new Promise'` 这类片段拼出，故该 grep 不会命中检查自身）；连续两次运行关键读数逐字相同（`keyReadings lines=14 sha256=79ae7d64ee666919`，两次同值），墙钟 `elapsed=1721ms`/`1759ms`，两次都 `< 60_000`。**如实登记**：node:test 的每例 `(x.xxms)` 与 `ℹ duration_ms` 两次不同，那是运行器耗时统计，不是判据读数，未计入 key 块。
- **AC9**：`startsBackgroundWork` 在 driver 里 5 行命中（`[22,53,174,183,195]`，import 自 `claude-runtime.provider.js`）；`grep -n "1800000\|30 \* 60\|BG_WAIT_CEILING" <driver>` **无**输出（`driver ceilingLiterals=0`）；`grep -c "run_in_background" <driver>` → 0（`driver runInBackgroundLiterals=0`）。三条都打印。



### 作用域门（worker 侧先行）

`bash scripts/test.sh --for-task gap-session-hosts-claude-per-run-driver --allow-thin`：**合并 develop 前**（分支 HEAD = `05db7d4a`）与**并入 develop 后**（合并提交，`HEAD^2` = 并入的那枚 develop 尖端）各按原命令实跑；并后在每次只动本任务文件的合并之后都再跑一次。退出码全部 **0**，读数一致：

- `suite-scope-check: PASS`；扫描行是 **develop 当时的快照**（随其他任务前进而变，不是本条的读数）：并后各次均为 `tasks=206 skipped(done/superseded)=198 active=8 with-tests=6 no-tests=2`，并前那次为 `skipped=197 active=9 with-tests=7 no-tests=2`；本条的文件集恒为下面那一个文件；
- `__PERFILE__ server/modules/providers/tests/claude-host-per-run.test.ts passed=true`（`duration_ms` 每次约 2.5s 浮动，是运行器的耗时统计、不是判据读数——同 AC8 处的如实登记）；
- `# tests 1 / # pass 1 / # fail 0 / # cancelled 0` —— 文件集恰为本条判据一个文件，来源是 Touches 的 `*.test.*`。

判据本身在并入 develop 后的树上按原命令重跑：退出 **0**、`ℹ fail 0`、`keyReadings lines=14 sha256=79ae7d64ee666919`（与并前**逐字相同**；唯一变化是运行器耗时 `elapsed`，每次约 1.7s 上下浮动，属机器噪声）⇒ 合并 develop 没有改动本条的任何读数。

作用域门缓存按管道约定写入：`node …/worker-driver.js --write-scoped-gate-cache --task gap-session-hosts-claude-per-run-driver --develop-sha "$(git rev-parse HEAD^2)" --root /data/home/yale/work/claudecodeui`，键取**合并提交真正并入的那枚 develop 尖端**（按构造成本分支 HEAD 的祖先）；本条不把任何合并提交 sha 当作终态——worker 退出后管道自己还要再并 develop。

### 顺序说明

本轮按 ABI 记录 AC 状态**先行**：写入前 `task_check` 读数 `ok:false acTotal=11 acChecked=0`；写入用 `quay task edit <id> --body-file`（即 `task_write` 的 CLI 形，同一 provider 路径，提交信息自称 `tasks: <id> task_write by cli:<pid>`），写入后 11/11 勾选。随后 `git merge --no-edit develop` → 作用域门 → `node .../worker-driver.js --write-scoped-gate-cache --develop-sha "$(git rev-parse HEAD^2)"`（`HEAD^2` 即合并提交真正并入的那枚 develop 尖端，按构造成 HEAD 的祖先）。

## Needs-Human

**执行 2026-09-26T13:23:06.455Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=22544 server/modules/voice/tests/voice-capture-off.false-forms.test.ts passed=false end_ms=1790428890265
- run_id：wk-prod-anchor
- session_id：cd9bb781-90f7-45f2-89bf-2ff78cb96bed
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-session-hosts-claude-per-run-driver~wk-prod-anchor~1790428823628-e49d55.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-session-hosts-claude-per-run-driver-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-27T02:57:46.683Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/debug-agent/tests/debug-agent-host-driver.test.ts:   AssertionError [ERR_ASSERTION]: no file under server/modules/providers/list/ may be touched
- run_id：wk-prod-anchor
- session_id：dd827080-c5b1-4d95-89c2-f6afd5540312
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-session-hosts-claude-per-run-driver~wk-prod-anchor~1790477694071-5d8ef4.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-session-hosts-claude-per-run-driver-wk-prod-anchor.log
