---
id: gap-debug-agent-external-write-delivery-leg-window
title: AC-125 判据的送达腿窗口只按轮询时钟推导，lane 内正控制行晚于窗口 ⇒ 全舰队 fan-in 假红（该文件第三次咬人）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

**这条判据的**送达腿**（(ii)/(iii)）是全体 fleet 的假红来源，而且它咬的从来不是自己的改动。** 三次记录在案，横跨三个互不相关的任务，形状各不相同：

| 日期 | 任务 | 形状 |
| --- | --- | --- |
| 2026-09-25 | `gap-claude-session-cgroup-scope` | 子进程 tsx 探针 spawn 超时，`the probe child printed no reading` |
| 2026-09-29 | `gap-transcript-follow-ac109-window-baseline-race` | 轮询臂 `[control (iii)] add=1 change=0`（33646ms，单跑绿 30.5s） |
| 2026-10-01 | `gap-chat-subscribe-cursor-needs-run-identity` | 同上形状：`[control (iii)] add=1 change=0`（lane 内 39669ms，单跑绿 29901ms，1.33×） |

**本次现场（本仓，2026-10-01）。** 同一个 worktree、同一份判据：

- lane 内（`.quay/fan-in-suite-gap-chat-subscribe-cursor-needs-run-identity~wk-prod-anchor~1790854268622-132898.log`，child 输出留在 `/data/home/yale/work/claudecodeui-worktrees/gap-chat-subscribe-cursor-needs-run-identity/.quay/suite-logs/20261001T193117-1956212/server__modules__debug-agent__tests__debug-agent-external-write.test.ts.out`）：轮询臂 `[control (iii)] add=1 change=0`、`[delivery (ii)] 1 new upsert(s) … first at +209ms` ⇒ 判据红在 (iii)。
- 单跑（同一 worktree）：`tests 4 / pass 4 / fail 0 / exit 0`，同一条臂读到 `[delivery (ii)] … first at +509ms`、`[control (iii)] add=1 change=1 (after the write: 1)`。
- **与本判据无关的任务也会被它咬**：那一轮 suite 里，被咬任务自己的 delta 测试文件全部 `passed=true`（`chat-run-registry` 8664ms、`claude-resident-unattended-turn` 9898ms、`replayCursorAcrossRuns` 26ms、`permissionPromptReplay` 11ms）。
- 附带读数（归因链路的机械证据）：`node scripts/quay-attribution-probe.mjs --log <该 suite 日志>` 读出 `named failing files=1 / parser-extracted files=0` —— 驱动因此把这轮记成「归因不出任何失败测试文件」，连烧两轮后把任务机械翻 `needs-human`。

**机制假设（本条任务的 AC1 要求先把它变成读数，⛔ 不许拿它当结论）。** (iii) 的正控制是**观察者的那一行 `console.log`**，而那一行在 `server/modules/providers/services/sessions-watcher.service.ts` 的 `onUpdate()` 里是**在 `await sessionSynchronizerService.synchronizeProviderFile()` 之后**才打印的。而等待窗口 `OBSERVATION_WINDOW_MS = 8000` 只按观察者自己的轮询时钟推导（`POLL_INTERVAL_MS 6000 + FLUSH_DEBOUNCE_MS 500 = 6500`，余量 1500ms），**没有把「事件被读到 → 索引完成 → 打印这一行」这一段算进去**；lane 内 16 路并发下这一段会膨胀，于是正控制行落在窗口之外 ⇒ 判据红，而送达链路其实没坏。对照：本文件对 **load 腿**早就做了正确的事——`armObservedFixture` 的窗口是「观察者自身实测延迟」推导出来的，文件自己的注释写着「the window is widened only by the observer's OWN measured latency … never by a number picked here」。**delivery 腿没有享受到同一待遇。**

**为什么必须在判据里解决，而不是靠重派。** 重派只是掷硬币（第三次 park 会再次烧掉一轮 worker）；仓库侧没有任何「服务端测试文件按 load-sensitive 串行化」的机制（`scripts/test.sh` 只有全局并发上限 16），插件的舰队级复发豁免（`judgeRetryExemption` 的 `recurringSignatureTasks`）又因为 `failingTestFilesFromSuiteLog` 的正则只认 `packages|plugin|experiments/*.test.mjs` 而在本仓**结构性不可达**（同 [[quay-suite-red-verdict-can-misattribute]]）。

## Proposal

**把 delivery 腿的等待修成和 load 腿同一等第，⛔ 不是把窗口调大。**

1. 先做 AC1 的机制读数：逐行并排 lane 内 child 输出与单跑，指出 (iii) 那行是被哪一段延迟推到窗口之外的（源码引用 + 实测读数），⛔ 不许以「单跑绿」代替。
2. 再按读到的机制改 delivery 腿，二选一（由实现者根据读数决定，并在完成记录里写明为何选它）：
   - (a) 窗口按**观察者自身实测延迟**推导——沿用 `armObservedFixture` 已有的做法（先量一次「写入 → 观察者自己那行」的延迟，再据此定窗口），窗口值必须能读出算法；
   - (b) 让正控制读到的是**事件被读到的时刻**，而不是索引之后的时刻（例如判据自己探针观察者的原始事件，或在 `onUpdate` 里把「读到事件」与「索引完成」两件事分开）。
3. **等强**：`[readiness]`/`[load]`/`[drain (i)]`/`[delivery (ii)]`/`[control (iii)]`/`[history (iv)]` 六行的字段名与语义一字不改；(i) 仍要求静默 > 一个轮询周期，(ii) 仍要求写入后一条**新的** upsert，(iii) 仍要求观察者自己那条 `change` 行出现在写入**之后**，(iv) 仍要求 REST 重取含追加内容；抗假 `bypass` 臂与 `[blind criterion]` 一行不动。
4. **负控制承重**：加宽/改造之后，`bypass` 臂必须在**新的**窗口里依然红 (ii)+(iii)，且盲判据仍绿。若加宽把 bypass 臂也放绿了，那就是削弱，本任务不成立、如实登记。

**明确不做：**

- ⛔ 不把 (i)/(ii)/(iii)/(iv) 任何一条降级、不删任何反例臂、不引入「等一会儿就算」的等待。
- ⛔ 不为让判据变绿而改产品行为（尤其不动 `sessions-watcher.service.ts` 的事件发射/索引逻辑；若读数指向那一行日志的**时机**本身是错的，改动仅限日志时机，并须给出独立理由与等强负控制）。
- ⛔ 不把本判据改成 skip / todo / 只在某种模式下跑。

## AC

- [x] 机制读数先行：在同一台机、同一个 worktree 上并排打印 lane 内 child 输出与单跑两读，逐行给出轮询臂的 `[readiness]`/`[load]`/`[drain (i)]`/`[delivery (ii)]`/`[control (iii)]` 五行，并指出 (iii) 的正控制行被哪一段延迟推出窗口（源码引用 + 实测读数）。退出码 0。⛔ 「单跑是绿的」不算读数。
- [x] 修法只用观察者自己的时钟：delivery 腿的窗口或正控制取点必须由观察者**自身实测**的延迟推导（或把「读到事件」与「索引完成」分开），且判据输出的窗口值能读出它是怎么算出来的；⛔ 不得只是把窗口换成一个与观察者时钟无关的更大常数（例如直接写 30000）。
- [x] 等强：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 退出码 0、`fail 0`，且六行读数齐备——(i) 静默 > 一个轮询周期、(ii) 写入后新 upsert ≥ 1、(iii) 写入后该文件的 `change` 行 > 0、(iv) REST 重取含追加内容、(load) 装载事件由观察者自己的 `add` 行宣告、(readiness) 就绪证据来自观察者自己。缺项时逐条打印实际值。
- [x] 负控制（抗假臂仍红）：同一次运行里 `bypass` 臂打印 `[criterion] failures=[...]` 同时含 (ii) 与 (iii)，且同一臂 `[blind criterion] failures=[]`（盲判据仍绿）。⛔ 若改造后 bypass 臂变绿，本任务不成立、如实登记为否证。
- [x] 双向对照（能取假 + 能取真）：除 bypass 臂外，另给一次「人为丢帧」读数——让观察者在该次写入后不再能报告它（例如写入后立即 `closeSessionsWatcher()`，或把匹配路径换成不存在的路径）⇒ (iii) 必须红；同一次运行的正向臂必须绿。⛔ 只有正向绿、没有反向红 ⇒ 判据空转。
- [x] 受载复跑：在本机受载条件下（至少 `--test-concurrency=8` 的同批并发，或复现 lane 形状的构造）复跑该文件仍 `fail 0` 退出码 0，并登记两读的墙钟与 (iii) 行读数。
- [x] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。
- [x] 改动全部落在 Touches 内：`git diff develop --name-only` 的每个文件都在 Touches 里；**Touches 里多声明的文件若最终没动，必须从 Touches 删掉并在完成记录里写明理由**（anti-drift 只查「实际 ⊆ 声明」，多声明不算违规，但完成记录要与实际相符）。

## DoD

真实落地判据，不是「窗口变大了」：

(a) **第一读数必须是 lane 里的一读**：本任务自己那次 fan-in 的 suite 日志里，`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 的 `__PERFILE__` 行 `passed=true`，且全日志 `# fail 0`；同时贴出 2026-10-01 那份修复前 lane 红日志的对照（`[control (iii)] add=1 change=0`）。⛔ 单跑绿**不是**落地证明。若本机在完成时拿不到 lane 读数，必须明写「未落地」并给出等强替代（例如 `--test-concurrency=8` 同批连跑 ≥ 3 次全绿），⛔ 不得把单跑当端到端证明。

(b) 完成记录里必须写明**选的是 (a) 还是 (b) 修法、依据是哪一条读数**，以及改造后 `bypass` 臂仍然红的那两行原文。⛔ 不得只声称「窗口按观察者延迟推导」而不贴出算法与读数。

(c) 只允许声称「这条判据的送达腿不再因观察者的索引延迟而假红」，⛔ 不得声称「观察者永不再漏事件」或「外部写入链路被修好了」——本任务判定面是判据的等待结构，不是产品链路。

L_D 该轴仍暗，理由：本条修的是调试判据的等待结构，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担（AC-125 的判据即本文件），不新增 goal 判据。

## Touches

- server/modules/debug-agent/tests/debug-agent-external-write.test.ts
- tasks/gap-debug-agent-external-write-delivery-leg-window.md

（`server/modules/providers/services/sessions-watcher.service.ts` 原先声明在 Touches 里，但按 AC8 已删去：它只在「读数指向那行日志的时机本身是错的」时才动，而本次读数指向的是**判据自己的等待结构**——`waitForUpsertAfter` 在**首个任意 session 的 upsert** 上就返回，早于本文件自己那条被轮询发现的 `change` 行。`onUpdate()` 里 `:728` 的 `await synchronizeProviderFile()` 与 `:733` 的 `console.log` 的先后本身是对的（索引完成才宣告），且 (iii) 要的正是「观察者自己那条 change 行出现在写入之后」；选 (a) 修法后，量得的「写入 → 观察者自己那行」延迟**本身就包含**索引那一段，窗口按它推导即已覆盖。故未改产品代码。）

## 完成记录

**判定面**：本任务只修**判据自己的等待结构**。不声称「观察者永不再漏事件」，也不声称「外部写入链路被修好了」（DoD(c)）。

### 机制读数（AC1）

lane 内那份 child 输出（`gap-chat-subscribe-cursor-needs-run-identity/.quay/suite-logs/20261001T193117-1956212/server__modules__debug-agent__tests__debug-agent-external-write.test.ts.out`）在 fan-in 收尾时被 `cleanup` 步 `pruned 3 suite attempt log(s)` 清掉了（见 `/data/home/yale/work/claudecodeui/.quay/fan-in-gap-chat-subscribe-cursor-needs-run-identity-wk-prod-anchor.log`），本机全盘也搜不到副本。故 lane 一侧用 finding 已记录的读数；它由本轮保留的**步级日志**佐证：2026-10-01 那天该 task 的 suite 连红两次（`suite-end … exit 1 suite red`，11:27:12 与 11:35:01），第三次（12:06:33）才绿。

并排两读（同为轮询臂；lane 一侧 finding 只记录了 (ii)/(iii) 两行）：

| 行 | lane 内（2026-10-01，记录值） | 单跑（本机，本轮实测） |
| --- | --- | --- |
| `[readiness]` | —（finding 未记录） | `Measured 6009ms … over 12 append(s) at 500ms apart` |
| `[load]` | —（finding 未记录） | `add line observed on attempt 1 of 1 … window=6500ms waited=5992ms` |
| `[drain (i)]` | —（finding 未记录） | `2 upsert(s) observed; silence 6545ms (> one polling period 6000ms); settled after 7016ms` |
| `[delivery (ii)]` | `1 new upsert(s) … first at +209ms` | `1 new upsert(s) in a 12492ms window; first at +5454ms` |
| `[control (iii)]` | `add=1 change=0 (after the write: 0)` | `add=1 change=1 (after the write: 1)` |

**哪一段延迟把 (iii) 推出窗口——由读数直接推出，不靠假设。** 旧等待 `waitForUpsertAfter(upserts, sinceAppend, 8000)` 的返回条件是 `upserts.length > since`，即**首个任意 session 的新 upsert** 一到就返回。lane 那轮 `[delivery (ii)]` 记的是 `first at +209ms` ⇒ 该等待**在 +209ms 就返回了**（有 upsert 在，它不可能再等满 8000ms），随后立刻读 (iii) 的正控制行数 ⇒ 读到 0。而本文件自己那条 `change` 行在**每一次绿跑**里都落在 +5.4s 附近（本轮单跑 +5454ms；8 路并发 24 跑落在 5.41–5.51s）——观察者是 6000ms 轮询（`POLL_INTERVAL_MS`），写入要等下一次 poll 才被读到。+209ms 只有本文件自己那条送达延迟的 ~1/26，且观察者的一条 `change` 行必然先于它的 upsert（`queuePendingWatcherUpdate` 之后还有 500ms flush debounce），所以 +209ms 那个 upsert **不可能是本文件的送达**，只可能是 load/readiness 阶段排队、被 debounce/`watcherRefreshInFlight` 推迟到 drain 的「静默」之后才落地的**陈旧 flush**。

⇒ 这条红的机制是 **等待绑错了证据**（绑在「任意 upsert」而非「本文件自己那条 `change` 行」），⛔ 不是「8000ms 窗口装不下索引那一段」。

**索引那一段在哪：** 正控制行的产生点在 `sessions-watcher.service.ts:733`，晚于 `:728` 的 `await sessionSynchronizerService.synchronizeProviderFile()`——所以一条 `change` 行的时刻天然是「poll 命中 + 索引完成」。本文件 load 腿的 `armObservedFixture` 量的正是「写入 → 观察者自己那行」，**这一段已被量进去**；把 delivery 腿的窗口改成同一推导即可同时覆盖它（选 (a) 的直接理由）。

### 修法（AC2，DoD(b)）

选 **(a)**：delivery 腿的窗口由**观察者自身实测延迟**推导，并把**等待的返回条件**绑到 (iii) 自己的证据上。

- `deriveDeliveryWindowMs(measuredLineLatencyMs) = POLL_INTERVAL_MS + max(measuredLineLatencyMs, 0) + FLUSH_DEBOUNCE_MS`。测量值来自 load 步（`armObservedFixture` 的 `latencyMs`，即「写入 → 观察者自己那行」），本轮单跑 5992ms、8 路并发下 5981–6032ms。窗口每次运行打印为新行 `[delivery window]`：
  `[delivery window] 12492ms = poll 6000ms + observer's own measured line latency 5992ms + flush debounce 500ms — the observer's own clock, widened by the observer's own measurement.`
  并有 `assert.equal(windowMs, deriveDeliveryWindowMs(measuredLineLatencyMs))` 把算法钉死——换成与观察者时钟无关的更大常数会直接红。
- `waitForDeliveryEvidence(...)`：只有 **本文件自己的 `change` 行（`line.at >= appendAt`）到了** 且 **有新 upsert** 才返回；否则跑到推导出的 deadline。bypass / drop-write 两臂拿不到那条行，跑满 deadline 并如实读到 0。
- 六行读数（`[readiness]`/`[load]`/`[drain (i)]`/`[delivery (ii)]`/`[control (iii)]`/`[history (iv)]`）字段名与语义**一字未改**；`[delivery (ii)]` 那行同形（只把窗口值从常量换成推导值）。`bypass` 臂与 `[blind criterion]` 未动。

**依据的读数**：lane 的 `first at +209ms` 对着 `change=0`（等待提前返回），以及本文件自己那条 `change` 行在 24 次受载复跑里稳定落在 +5.4s——决定的是「等谁」，不是「等多久」。

### 逐条 AC 读数

- **AC1**：见上表 + 源码 `sessions-watcher.service.ts:728,733`。本机按 lane 形状做了复现尝试（8 路并发 × 3 轮，跑**修复前**那份判据，`/tmp/ac1-old-4176570`）：24 跑全绿，复现不出红——该抖是稀有的；故 lane 一侧按上面「记录值 + 步级日志」给。退出码 0。
- **AC2**：`deriveDeliveryWindowMs` + `[delivery window]` 行 + 重算断言；窗口值可读出算法。✅
- **AC3**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts` → `EXIT=0`、`ℹ pass 5 / ℹ fail 0`；六行齐备（单跑一次、合并 develop 后又一次，均绿）。
- **AC4**：同一次运行，bypass 臂 `[criterion] failures=["(ii) no NEW upsert arrived after the external write (0 in a 12485ms window)","(iii) the observer logged no \`change\` event for this transcript after the write (0 change line(s) for this file in total), so the upsert cannot be attributed to it"]`，同臂 `[blind criterion] failures=[]`。✅
- **AC5**：新增 `drop-write` 臂——观察者留在 loop 里过 load 与 drain，写入落盘瞬间 `closeSessionsWatcher()`；该臂 `[control (iii)] add=1 change=0`、`[delivery window] … The wait ended on the deadline, with no \`change\` line for this file`、`[criterion] failures` 含 (iii)；**同一次运行**的正向臂 `[criterion] failures=[]`。✅
- **AC6**：3 轮 × 8 并发（128 核机，loadavg 20–41）：24 跑 `EXIT=0 / ℹ fail 0`，墙钟 35464 / 35528 / 36022 ms（单跑 ~26–30s ⇒ 1.3×，与 lane 的 1.33× 同量级）；(iii) 读数全部 `add=1 change=1`，两条必红臂各 2 处 `change=0`。日志 `/tmp/ac6-load-4007750`、`/tmp/ac6-load-rounds.log`。
- **AC7**：`npm run typecheck` EXIT=0；`npm run lint` EXIT=0（仅既有 warning，本文件零告警）。
- **AC8**：合并 develop 后 `git diff develop --name-only` 只有 `server/modules/debug-agent/tests/debug-agent-external-write.test.ts`（在 Touches 内）；Touches 里多声明的 `sessions-watcher.service.ts` 已删并写明理由（见 Touches 段）。✅

### DoD

- **(a) 落地：未落地。** 本任务自己那次 fan-in 的 suite 日志在我退出后才生成，本机此刻拿不到，故按 DoD(a) 明写「未落地」并给等强替代：`--test-concurrency=8` 同批 **3 轮 24 跑全绿**（AC6），外加 scoped gate 在合并树上 `__PERFILE__ duration_ms=34763 … passed=true`、`# fail 0`、EXIT=0。对照的修复前 lane 红：`[control (iii)] add=1 change=0`（2026-10-01），步级日志见上。
- **(b) 修法**：选 (a)；依据是 lane 的 `first at +209ms` 对着 `change=0`（等待提前返回）与本文件 `change` 行在 24 次受载复跑里稳定 +5.4s。改造后 `bypass` 臂仍红的两行原文：
  `[criterion] failures=["(ii) no NEW upsert arrived after the external write (0 in a 12485ms window)","(iii) the observer logged no \`change\` event for this transcript after the write (0 change line(s) for this file in total), so the upsert cannot be attributed to it"]`
  `[blind criterion] failures=[] (satisfied by an upsert that predates the write: true)`
- **(c)** 只声称「这条判据的送达腿不再因**等待绑错证据**（在任意 upsert 上提前返回、早于本文件自己那条被轮询发现的 `change` 行）而假红」；⛔ 不声称观察者永不再漏事件，⛔ 不声称外部写入链路被修好。
