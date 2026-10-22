---
id: gap-ac188-criterion-agreement-loses-poll-source-falsifiability
title: AC-188 的 AC6 回合一致性判据在坞合并后失去对「轮询驱动第二 busy 源」的证伪力——坞成为链路最快的源（回合打开即
  in-turn、回合间 absent），1 秒 /api/session-hosts 轮询侧的假形态在 e3f86d82
  改窄后的任何采样窗口都落不了红；先量坞的心跳节拍与轮询侧真实滞后，再定修窗口还是按 AC-172/177/178 家族先例退役该假形态
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-188
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案前实测，不是关键字碰运气）：`grep -l '^goal_ac: *AC-188' tasks/*.md` → **2** 份——
`gap-activity-single-dock-global-consistency`（**done**，当年建了该用例并设下 20s 用例体守卫）与
`gap-ac188-criterion-body-budget-below-its-turn-walk-floor`（**needs-human**，正在落地预算 20_000→30_000，
并已按人工裁决把假形态 (ii) **移出**到本条）。机制侧扫描 `grep -ln 'afterTurn|轮询驱动|poll-driven|证伪力'` 命中的
邻居 `gap-activity-idle-beat-clears-open-turn-anchor`（**done**，AC-184）、`gap-activity-dock-phase-truthful`
（**done**，AC-187）、`gap-activity-dock-background-browser`（**done**，AC-194）各自是**别的 AC、别的机制**，
无一认领「回合一致性判据的证伪力」。⇒ 本条不是重复：done 的那两份恰恰是「上一次的修法没兜住」的证据，
在飞的只有本条要承接的那个移出项。

**现象（判据实测，不读台账 `reason` 的 stderr 尾巴）**

AC-188 用例（`e2e/activity-dock-truthful.spec.ts` 的 `AC-188` test）里有两条一致性断言：

- 回合**打开**时的窗口（`:1214-1228`，8×70ms）：`!inTurn(s.dock) && (s.sidebar || s.send === 'stop')` 必须为空；
- 回合**结束**后的窗口（`:1319-1332` + `:1366-1372`，每视口 8×55ms）：同一条过滤必须为空。

两条都是**单向**的：只抓「坞不在回合里、而 sidebar 或发送键还在说忙」。这本来正对着「第二个轮询驱动的
busy 源」——用例 `:1183-1196` 的注释逐字写着这个意图：「a sidebar reading the one-second host listing
lights up here, while the dock — reading the server's own activity — does not … One source, one answer:
every sample must agree.」

**这条证伪力已经没有了。** 在 `gap-ac188-criterion-body-budget-below-its-turn-walk-floor` 立案时，把
`src/modules/sidebar/RunningView.tsx` 的 busy 集合改成读 1 秒 `/api/session-hosts` 轮询后重跑，**两种实现
都让判据 exit 0**（逐字读数见 `## Evidence`）：

- 读 `useSessionHosts().snapshot` 的 lease 列表（历史写法，即被 `ad1bb63a` 换掉的那版）→ `/tmp/ac188-falsify-ii.log`：`1 passed`；
- 字面的 1 秒轮询（`api.sessionHosts.list()` + `setInterval(…, 1000)`）→ `/tmp/ac188-literalpoll2.log`：`1 passed`。

关键读数（字面轮询那次）：

```
consistency.turnOpen=[{"dock":"in-turn","sidebar":true,"send":"send"} ×8]
consistency.afterTurn.desktop=[{"dock":"absent","sidebar":false,"send":"send"} ×8]
probe.afterWalk.0={"dock":"in-turn","sidebar":true,"send":"send"}
probe.afterWalk.1={"dock":"in-turn","sidebar":false,"send":"send"}
probe.afterWalk.2={"dock":"absent","sidebar":false,"send":"send"}
```

即：**假形态确实让 sidebar 亮起来了，但它亮着的时候坞正读 `in-turn`**，正落在单向过滤器的容差侧；
等到坞转 `absent`（`probe.afterWalk.2`，约 200ms 后）sidebar 已经自己灭了。**没有任何一个采样时刻同时满足
「坞不在回合里」与「sidebar 说忙」。**

**根因（两条都在本条之前，都在 HEAD 与 develop 的祖先里）**

1. **`e3f86d82`**（2026-10-02 16:29，"activity dock: share the announced silence budget across dock mounts"）
   把回合结束后的窗口从**活页面**（从坞离开 `in-turn` 起采 **24×55ms ≈ 1.3s**，注释逐字写着
   「span ~1.3s — past the one-second poll's own beat, which is the interval the old sidebar lagged by」）
   改成**重新导航两个页面之后**采 **8×55ms ≈ 0.5s**，起点已是坞转 `absent` 之后约 2.5s：1 秒轮询早已追平。
   （`git log -S"i < 24"` / `-S"one-second poll"` 各只指向 `ad1bb63a` 引入、`e3f86d82` 改写；
   ⚠️ 本条立案前姊妹任务曾把此提交误记为 `421afb84`，已复核更正。）
2. **`b9b177d1`**（2026-10-04，heartbeat 带上 run-in-flight 位）与 **`7fd3598b`**（回合状态画进消息流）之后，
   坞在回合打开时读 `in-turn`、回合间根本不画（`toHaveCount(0)`）。当年那条红是
   `consistency.turnOpen={"dock":"idle","sidebar":true,…}`——靠的是**旧的坞语义**（resident 在回合间留 `idle`），
   这个语义已经不存在了。

两条合起来的效果是：**坞现在是链路里最快的源**。轮询驱动的第二源在原理上只能**慢于**真相，而判据抓住的
方向恰恰要求它**快于**坞——这个方向在现架构里不存在。

**为什么这不是「判据假」。** 同一次运行里 AC-188 的每一条实质读数都是对的：`dock.count.{desktop,mobile}=1`、
`legacy.tab=0 legacy.inline=0`、`resident.activityMarkers=[]`、`resident.panel.controls={start,close,copy,address,pid}`、
`consistency.turn` / `afterTurn` 两视口一致。**绿的读数不是问题，丢的是证伪力**——判据现在无法区分
「一个源」与「一个源 + 一个恰好不越线的慢源」。

**边界。** ⛔ `SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门不动；AC-188 的**每一条实质读数一字不删**；
本条的产物是**判据的证伪力**，不是「用时更短」也不是「多一条测试」。假形态的定义必须**忠实**：
挂载即拉取（首帧就是真相）与只在 tick 上学习（首帧最多滞后一个节拍）是两种不同的源，**两种都要量**，
不能只挑一种然后宣布不可满足。

**非目标。** 不动 AC-188 用例体的预算字面量（`toBeLessThanOrEqual(30_000)`，属
`gap-ac188-criterion-body-budget-below-its-turn-walk-floor` 的范围，不由本条改）；不修 AC-186/AC-187 的相位判据。

## Plan

1. **先量坞的节拍与两个边沿的迁移时刻。** 在**活页面**上量 `[data-activity-dock]` 的 `data-activity-state`
   从服务端 `turn-open` 到首次读 `in-turn`、以及服务端 `turn-end` 到离开 `in-turn` 的实测间隔；
   同时记下心跳的实际节拍（`HEARTBEAT_MS` 或等价常量的字面值与其在页面上的观测间隔）。
   逐字写进 `## Evidence`——判定必须建立在这些读数上，不许拍脑袋。
2. **量轮询侧的真实滞后，两种忠实实现各一次。** (a) 挂载即拉取 + `setInterval(…, 1000)`；
   (b) 只在 tick 上学习（首帧也等一个节拍）。每次记 `probe.afterWalk` 的逐样本序列与判据 exit code。
   加一条**健康树基线对照**（无假形态）过同一个窗口，证明该窗口在健康树上稳定为绿。
3. **判定，二选一，必须以上一步的实测序列为依据。**
   - **(a) 修窗口**：给出一个能让 1 秒轮询假形态**落红**的窗口——起点（相对哪个边沿）、时长、采样对象
     （活页面还是重新导航后的页面）逐条写明；并证明该窗口在**健康树上**连续 ≥8 次绿（即它不是靠健康树
     自身的不稳定来红的）。
   - **(b) 退役**：给出「任何窗口都落不了红」的实测论证（两个边沿 × 两种实现 × 健康树基线对照），
     并按同族先例（`gap-ac172/177/178-criterion-anchor-retired-by-dock-consolidation` 均 done）记录该假形态退役。
4. **落地（按第 3 步的判定）。**
   - 走 (a)：把窗口改进 `e2e/activity-dock-truthful.spec.ts` 的 AC-188 用例，并**当场用假形态 (ii) 复现红**
     （逐字贴出红的输出）——退役与修复的分界是「有没有一条真的红」。
   - 走 (b)：在 AC6 断言处写明它保留的方向（只抓坞 outstay 回合）与它**不再覆盖**轮询驱动的第二源，
     并把该判定逐字记入 `## Evidence`；⛔ 不得删除任何实质读数。
5. **稳定性。** 改后 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 连续 ≥3 次 pass
   （走 (a) 时另加：健康树 ≥8 次绿）。若仍见红，先判定是窗口还是别的机制，不要把红藏起来。
6. **静态闸。** 改动文件过 `npm run typecheck` 与 oxlint（`e2e/` 不在 lint 路径内时，
   单独 `npx oxlint e2e/activity-dock-truthful.spec.ts` 并说明既存错误）。
7. **落账并自检。** `task-schema-check.js` exit 0、`quay task check <id> --json` 的 `missing: []`，
   只把 Touches 里列出的文件加进提交。

## AC

- [x] 节拍实测：活页面上量出坞在回合打开/结束两个边沿的状态迁移间隔与心跳节拍，逐字写入 `## Evidence`，并给出「坞落后服务端 ≤ X ms」的实测上界
- [x] 轮询侧滞后实测：两种忠实实现（挂载即拉取；只在 tick 上学习）各跑一次，逐次记 `probe.afterWalk` 逐样本序列与判据 exit code；另加一次无假形态的健康树基线对照过同一窗口
- [x] 判定：以上述实测序列为依据，二选一写出结论——(a) 修窗口（起点/时长/采样对象逐条写明）或 (b) 退役（「任何窗口都落不了红」的实测论证），二者必居其一
- [x] 落地：走 (a) 时改后的窗口能让 1 秒轮询假形态落红并逐字贴出红的输出；走 (b) 时 AC6 断言处写明其保留方向与不再覆盖的范围，退判决逐字入 `## Evidence`；两条路都⛔不得删除任何实质读数，`SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门不动
- [x] 稳定性：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 改后连续 ≥3 次 pass；走 (a) 时另加健康树窗口连续 ≥8 次绿
- [x] 静态闸：改动文件过 `npm run typecheck` 与 oxlint（或本仓对该 spec 的等价静态检查），exit 0
- [x] 任务自身 `tasks/gap-ac188-criterion-agreement-loses-poll-source-falsifiability.md` 已落账（自触）

## DoD

这是一次**判据证伪力**的落地，不是「多一条测试」也不是「文档已写」：

- 交付物是**被真实操作过的** `e2e/activity-dock-truthful.spec.ts`（真实浏览器、真实 webServer + Vite 客户端 +
  调试 agent 时钟），不是一份设计说明。走 (a) 时它必须**当场**被假形态 (ii) 打红过一次；走 (b) 时它必须
  带着写明的退役理由仍是绿的，且判定所依据的实测序列逐字在 `## Evidence` 里。
- 判定所依据的两组读数（坞的边沿迁移间隔、轮询侧两种实现的逐样本滞后）与一次健康树基线对照，
  在 `## Evidence` 里逐字留档——**没有这两组读数就不算落地**，无论选了哪条路。
- AC-188 的每一条实质读数一条未删、`SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门未动。

## Evidence

本条的立案读数来自姊妹任务 `gap-ac188-criterion-body-budget-below-its-turn-walk-floor` 的 `## Evidence` §4
（该任务的 Plan step 4 要求重跑这两个假形态，其中 (ii) 被证不可满足后按人工裁决移出到本条）。
留档日志（立案时仍在盘上）：

- `/tmp/ac188-falsify-ii.log` —— 历史 store-read 实现，`1 passed`
- `/tmp/ac188-literalpoll2.log` —— 字面 1 秒轮询，`1 passed`，含 `probe.afterWalk` 逐样本序列
- `/tmp/ac188-baseline-afterwalk.log` —— 无假形态的健康树基线对照：活页面在 `walk-done` 之后以 100ms 间隔
  连采 25 次，`{dock,sidebar,send}` = `in-turn,false,send` ×3 → `absent,false,send` ×22，**25/25 一致**
- `/tmp/ac188-falsification/fake-ii.diff`、`fake-ii-literal-poll.RunningView.tsx` —— 假形态源码存档

⚠️ 本条**不重新认定**该任务的结论，只承接它：第 1 步要量的是它没有量的那一半——**坞自己落后服务端多少**。
它当年只量了轮询侧（≤150ms），没量坞侧，所以「即便把活页面窗口搬回来也无从稳定落红」这句话目前只有一半证据。

### §1 坞在两个边沿上落后服务端多少（活页面仪测，4 次运行）

仪器（**只在测量运行里存在，不随本条提交**）：在活页面上以 40ms 间隔读 `[data-activity-dock]` 的
`data-activity-state`（`probe.dockLog`）；以 40ms 间隔 `GET /api/session-hosts` 记服务端 `turn` lease 的
迁移（`probe.serverLease`，每次 322–350 个样本）；抓 WS 文本帧里的 `activity.heartbeat`（`probe.beats`）。
四个日志：`/tmp/ac188-evidence/instr-healthy-2.log`、`fake-a-1.log`、`fake-a-2.log`、`fake-a-3.log`。

**心跳节拍。** 该 spec 的选择注入 300ms（`playwright.config.ts` 对本 spec 的选择注入
`ACTIVITY_HEARTBEAT_INTERVAL_MS=300` / `ACTIVITY_UNREACHABLE_AFTER_MS=900`；出货值仍是 5_000）。四次实测：

```
instr-healthy-2  probe.beats count=48 intervalMs={"min":264,"p50":300,"max":1950}
fake-a-1         probe.beats count=47 intervalMs={"min":250,"p50":300,"max":2492}
fake-a-2         probe.beats count=48 intervalMs={"min":286,"p50":300,"max":1663}
fake-a-3         probe.beats count=48 intervalMs={"min":287,"p50":300,"max":1672}
```

p50 = 300ms，即注入值；`max` 跨过回合结束后的空转段，是节拍的**缺席**，不是抖动。

**turn-open 边沿**（服务端 lease 上升 → 坞首次读 `in-turn`）：

| 运行 | lease 上升 t | 坞首次 `in-turn` t | **Δ** |
| --- | --- | --- | --- |
| instr-healthy-2 | 1791355500714 | 1791355500714 | **0 ms** |
| fake-a-1 | 1791355560774 | 1791355560914 | **140 ms** |
| fake-a-2 | 1791355595100 | 1791355595141 | **41 ms** |
| fake-a-3 | 1791355627363 | 1791355627411 | **48 ms** |

fake-a-1 同一次运行里，携带 `isProcessing:true` 的首个心跳落在上升后 121ms
（`probe.beat.transitions=[{"t":1791355560895,"isProcessing":true},…]`）——坞的起点就是这个心跳，不是别的。
两个 40ms 采样器相位不同，故 Δ 本身带 ≤40ms 量化误差；观测上界 **≤ 140 ms**，机理上界是一个节拍（300ms）。

**turn-end 边沿**（服务端 lease 下降 → 坞离开 `in-turn`）：

| 运行 | lease 下降 t | 携带 `isProcessing:false` 的心跳 | Δ心跳 | `await clock` 返回 | Δwalk | 坞离开 `in-turn` | **Δ坞** | Δ坞−Δwalk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| instr-healthy-2 | 1791355514703 | 1791355515277 | 574 ms | 1791355515178 | 475 ms | 1791355515455 | **752 ms** | 277 ms |
| fake-a-1 | 1791355574733 | 1791355575397 | 664 ms | 1791355575241 | 508 ms | 1791355575521 | **788 ms** | 280 ms |
| fake-a-2 | 1791355609071 | 1791355609674 | 603 ms | 1791355609564 | 493 ms | 1791355609851 | **780 ms** | 287 ms |
| fake-a-3 | 1791355641346 | 1791355641966 | 620 ms | 1791355641827 | 481 ms | 1791355642097 | **751 ms** | 270 ms |

**AC1 结论：坞落后服务端 ≤ 800 ms**（turn-end 边沿四次观测 751–788 ms；turn-open 边沿 0–140 ms）。
要紧的是这个滞后**几乎全部**是等那一个携带清除位的心跳（574–664 ms），不是坞自己的处理——
所以判据的窗口必须从**心跳到达之前**起算，且必须长过一个 1 秒轮询的节拍。

### §2 轮询侧的滞后：两种忠实实现 + 健康树基线

两种假形态都只改 `src/modules/sidebar/RunningView.tsx` 的 busy 源（源码存档
`/tmp/ac188-falsification/fake-ii-literal-poll.RunningView.tsx`、`fake-ii-tickonly.RunningView.tsx`；
还原由 `/tmp/ac188-evidence/run-fake-final.sh` 的 `trap restore EXIT` +
`diff -q … && echo restored=IDENTICAL` 保证，两次运行的还原断言都打印了 `restored=IDENTICAL`）：

- **(a) 挂载即拉取**：`useState(new Set())` + 挂载时立即 `tick()`，随后 `setInterval(() => void tick(), 1000)`；
  `tick` 读 `api.sessionHosts.list()` 并收集 `binding.leases.some(l => l.kind === 'turn')`，
  再交给 `classifyRunningSessions(polledBusy, snapshot)` —— 首帧就是真相，之后每秒一个节拍；
- **(b) 只在 tick 上学习**：同 (a)，唯一差异是**去掉**挂载时的 `tick()`，首帧也要等一个节拍。

逐样本序列（`consistency.afterTurnLive.{desktop,mobile}`；格式 `坞/侧栏/发送键`：
`I`=`in-turn`、`-`=`absent`；`S`=sidebar 说忙、`s`=不忙；`T`=stop、`t`=send）× 判据 exit code：

```
(a) 挂载即拉取
  a-1  exit 0   desktop Ist ×4 -st ×20                 | mobile Ist ×4 -st ×20
  a-2  exit 1   desktop ISt ×4 -St ×3 -st ×17          | mobile ISt ×4 Ist -st ×19
  a-3  exit 1   desktop ISt ×4 -St ×3 -st ×17          | mobile ISt ×4 -St -st ×19
(b) 只在 tick 上学习
  b-1  exit 1   desktop ISt ×4 -st ×20                 | mobile ISt ×4 -St ×4 -st ×16
  b-2  exit 1   desktop ISt ×4 -St ×3 -st ×17          | mobile ISt ×4 ISt -St ×2 -st ×17
  b-3  exit 1   desktop ISt ×4 -St -st ×19             | mobile ISt ×3 Ist -st ×20
健康树基线（无假形态，同一个窗口）
  final-healthy-1..10  每一次、每一页都是 ISt ×2..4 → -st ×rest，从无一个 -St，disagreements = 0
```

（`-St` 段就是判据抓的形态：坞已经 `absent`，而侧栏还在说忙。`ISt` 与 `-st` 都是**一致**的读数。）

判读：

1. **健康树上侧栏与坞在同一个 55ms 桶里落下**（`ISt → -st`，中间没有 `-St` 样本）：
   `final-healthy-1..10` 的 10 次 × 2 页 = 20 个视野读数，`disagreements` 全 0；
2. 假形态下侧栏**落后坞 1–4 个样本（55–220 ms）**，这就是判据抓到的 `-St` 段；
3. **(b) 3/3 落红，(a) 2/3 落红，合计 5/6**——两种忠实实现都被抓到，「两种都要量、不能只挑一种」的要求满足；
4. (a) 的 a-1 是绿，原因**不是判据失效而是合取式未成立**：那两个页面的侧栏在**整个窗口**里都读 `s`（不忙），
   所以「坞不在回合里 ∧ 侧栏说忙」从未同时为真。诚实记下这条判据的**方向边界**：它抓的是
   「坞先灭、慢源还亮着」；一个在窗口里**一直说空闲**的慢源不会被它抓到——那不是 AC6 保留的方向，
   同向的第二条守卫（`the live window must observe the dock leave the turn`）也管不着它。

### §3 判定：走 (a) 修窗口

依据 §1 与 §2 两组读数，**二选一取 (a)**：

- 坞离开 `in-turn` 落后服务端 751–788 ms（§1），而 1 秒轮询的慢源清在 (0, 1000 ms]，两者的交叠**必然存在**：
  窗口只要覆盖 lease 下降后的 (0, 1000 ms]，就**一定**能同时读到「坞已灭」与「慢源还亮」（§2 的 `-St` 段）。
- 旧窗口（`e3f86d82` 之后）从**重新导航两个页面之后**的 settled 读数里取 8×55 ms，起点已在坞转 `absent` 之后约 2.5 s——
  轮询早已追平，故永远为绿。这不是「任何窗口都落不了红」，是**那个**窗口落不了红（§2 已实测：同一棵树、同一判据，
  窗口换成活页面后 5/6 落红）。

修复后的窗口，逐条：

- **采样对象：活页面。** 就是 AC5 读数用的那两个视口页（`page` 1280×800 与 `mobile` 390×844），
  它们从回合打开起就在看，回合结束前**没有**被重新导航。旧窗口的采样对象是**重新导航之后**的页面，
  那正是它失效的原因。
- **起点：`await clock` 返回（`walk-done`）那一刻。** 它落在 lease 下降后 475–508 ms（§1），
  **早于**坞自己的离开时刻（751–788 ms），所以窗口连「坞还在 `in-turn`」的那一段也读到了——
  那既是 `-St` 段的对照样本，也是第二条守卫（必须读到坞离开回合）的前提。
- **时长：`LIVE_WINDOW_SAMPLES = 24` × `LIVE_WINDOW_PERIOD_MS = 55` ≈ 1.3 s**（实测 1299–1379 ms；
  结构下界 23×55 = 1265 ms）。从起点读到 lease 下降后约 1.8 s，**跨过 1 秒轮询最晚的清除时刻**（下降后 1000 ms）。
- **采样方式：`sampleBurst()`——在页面内连采，不是每次一个往返。** 跨两页 24×2 个读数若每次经 harness
  `count()` 往返，在负载下会把 1.3 s 的窗口拉成几十秒，撞上 55 s 的 run watchdog
  （本会话撞过两次，`/tmp/ac188-evidence/healthy-3.log` 的
  `watchdog: … crossed its own 55000ms ceiling … stuck at stage "browser-launch-or-cases"`），
  那样红的是窗口，不是判据。选择器与 `sample()` 逐字相同，只是换成 `querySelector`；
  二者唯一可能不同的地方是 shadow DOM，而 `src/` 下没有任何 `attachShadow`。
- **断言：同向一条 + 非空性一条。** 在既有 AC6 过滤旁新增同一方向的
  `!inTurn(s.dock) && (s.sidebar || s.send === 'stop')` 必须为空；再加一条守卫：
  窗口里必须至少有一个样本读到坞离开回合，否则这条窗口什么都没测。

### §4 落地：红的逐字输出

在**提交的这棵树**上、用 §2 的假形态重跑（`/tmp/ac188-evidence/final-fake-a.log`，`final-fake-b.log`；
行号即提交文件的行号）：

```
final-fake-a  exit 1   desktop ISt ×4 -St ×4 -st ×16  | mobile ISt ×4 -St ×2 -st ×18   (window=1308ms)
final-fake-b  exit 1   desktop ISt ×4 -St ×3 -st ×17  | mobile ISt ×4 -St ×1 -st ×19   (window=1304ms)
```

`final-fake-a.log` 的失败段逐字：

```
  1) e2e/activity-dock-truthful.spec.ts:1236:3 › activity dock consolidation › AC-188 one dock, no legacy surface, and one answer across the dock, the sidebar and the send button

    Error: desktop: no live reading may show the dock leave the turn while the sidebar or the send button still says busy

    expect(received).toEqual(expected) // deep equality

    - Expected  -  1
    + Received  + 22

    - Array []
    + Array [
    +   Object {
    +     "dock": "absent",
    +     "send": "send",
    +     "sidebar": true,
    +   },
    +   Object {
    +     "dock": "absent",
    +     "send": "send",
    +     "sidebar": true,
    +   },
    +   Object {
    +     "dock": "absent",
    +     "send": "send",
    +     "sidebar": true,
    +   },
    +   Object {
    +     "dock": "absent",
    +     "send": "send",
    +     "sidebar": true,
    +   },
    + ]

      1558 |         liveDisagreements,
      1559 |         `${tier}: no live reading may show the dock leave the turn while the sidebar or the send button still says busy`,
    > 1560 |       ).toEqual([]);
           |         ^
      1561 |       // ...and the window is only evidence if it watched the turn end at all: a window whose
      1562 |       // every sample still read `in-turn` would satisfy the claim above while measuring nothing.
      1563 |       expect(
        at /data/home/yale/work/claudecodeui-wt-gap-ac188-criterion-agreement-loses-poll-source-falsifiability/e2e/activity-dock-truthful.spec.ts:1560:9
```

（`+ Received + 22` 是 Playwright 差分块的行数——4 个对象 × 5 行 + 首尾两行 = 22，对应 §4 那段序列里 desktop 的 4 个 `-St` 样本。）

### §5 稳定性与静态闸

**AC5 稳定性。** 改后 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` **连续 10 次 pass**
（`/tmp/ac188-evidence/final-healthy-1..10.log`，31.0–40.7 s），20/20 视野读数 `disagreements = 0`，
每次都读到坞离开回合，窗口实测 1301–1330 ms。合并 develop 后（无冲突）再连续 3 次 pass
（`postmerge-healthy-1..3.log`）。

（同一窗口的**更早**一组基线：`healthy-1,2,4,5,6,7,8.log` 7 次绿，那时窗口还是 harness 逐样本往返的写法，
实测 1695–2429 ms，`healthy-3.log` 在负载下撞了 55 s watchdog——这正是 §3 换成 `sampleBurst` 的理由；
`instr-healthy-2.log` 是换成 `sampleBurst` 后的仪测基线（1305 ms，绿）。
三组加起来健康树共 18 次绿 × 2 页 = 36 个视野读数，`disagreements` 全 0。）

**AC6 静态闸。** `npm run typecheck` → **exit 0**。`npx oxlint e2e/activity-dock-truthful.spec.ts` → exit 1，
**唯一**一条是既存错误：

```
e2e/activity-dock-truthful.spec.ts:948:7: error eslint(no-unused-vars): Variable 'CONSOLIDATION_SCENARIO' is declared but never used.
```

对 develop 的同文件跑同一命令得到**逐字相同**的一条（`/tmp/ac188-evidence/oxlint-develop.log`）⇒ 本次改动零新增。
本仓的 lint 脚本是 `oxlint src/ server/ scripts/ shared/`，**不含 `e2e/`**，所以这是按 Plan step 6 单独跑的结果。
（另跑一次独立 `tsc --noEmit … e2e/activity-dock-truthful.spec.ts`：只有一条既存的
`afterTurnIdle` 缺失（`readings.push({…})` 处），develop 上同一处同样报——`e2e/` 不在 `tsconfig.json` 内，
这条不在任何门路上，本次未新增。）

**边界未动。** `git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -E '^[-+].*(30_000|55_000|60_000)'`
为空——`toBeLessThanOrEqual(30_000)`、`SINGLE_SPEC_CEILING_MS = 55_000` 与 60 s 闸门逐字未改；
实质读数 `dock.count.{desktop,mobile}`、`legacy.tab`、`legacy.inline`、`resident.activityMarkers`、
`resident.panel.controls`、`consistency.turn.*`、`consistency.afterTurn.*`、`settled` 一条未删。

## Touches

- `e2e/activity-dock-truthful.spec.ts`（AC-188 用例的一致性窗口与/或其注释）
- `tasks/gap-ac188-criterion-agreement-loses-poll-source-falsifiability.md`（自触）
