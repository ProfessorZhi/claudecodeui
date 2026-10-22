---
id: gap-ac188-criterion-body-budget-below-its-turn-walk-floor
title: AC-188 的用例体预算 20s 低于它自身回合行走的实测地板，负载下假红
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

**现象（台账 + 直接重跑，两次独立读数）**

门账本里 AC-188 的 `gate=goal` 事件在 2026-10-07T04:17:04.300Z 与 04:19:13.255Z 两次 pass（树
`0399dd59f91c8de4746a2ae4955f67bd854ea21e`），随后 2026-10-07T04:21:00.709Z 记 fail，树
`e9bf1390f58734e44b82abe833cb172229d481b5` —— 这正是当前树的 treeSha。fail 的 `reason` 被截断到
WebServer 的 stderr（`[BABEL] Note … exceeds the max of 500KB`、`[DEP0190]`），读不出失败落点，所以本轮
**没有再依赖 reason 尾巴**，而是按本仓的方法论直接重跑判据。

本轮立案前直接重跑（同一棵树 `e9bf1390` == `git rev-parse HEAD^{tree}`，spec 与 `playwright.config.ts`
均 clean），四次墙钟：**18798ms pass / 20810ms FAIL / 18864ms pass / 18545ms pass** —— 1/4 假红。

**失败断言（逐字，来自 repeat 1）**

```
Error: the case body must land inside its own budget
expect(received).toBeLessThanOrEqual(expected)
Expected: <= 20000
Received: 20810
  at e2e/activity-dock-truthful.spec.ts:1384
```

即 `console.log('dock.wall=…')` 报出 20810ms，撞上用例自己的 `toBeLessThanOrEqual(20_000)`。

**关键：红的是预算，不是读数。** 同一次失败运行里，AC-188 的**每一个实质读数都是对的**：

- `dock.count.desktop=1  legacy.tab=0  legacy.inline=0  resident.activityMarkers=[]`
- `dock.count.mobile=1  legacy.tab=0  legacy.inline=0  resident.activityMarkers=[]`
- `resident.panel.controls={"start":1,"close":1,"copy":1,"address":1,"pid":1}`
- `consistency.turn.desktop={"dock":"in-turn","sidebar":true,"send":"stop"}`，mobile 同形
- `consistency.afterTurn.{desktop,mobile}` 全为 `{"dock":"absent","sidebar":false,"send":"send"}`

于是这不是「判据假」（`[data-activity-dock]` 数量、旧标记计数、resident 忙闲迁移、各处一致性全部成立），
而是**判据在负载下会红**——与 AC-199（`gap-ac199-criterion-wallclock-load-scaled-fixed-cost`）同形的
负载墙钟假红。

**地板实测（为什么 20s 不够）**

用例体里 `await clock` 走完调试 agent 的一整个回合（`unattended-turn@0` → `turn-end@5000` → `wait@5500`）
实测返回在 **~15.0–15.4s**（`walk-done @15024ms` / `@15373ms`）。行走之后还必须做：收尾后重新导航两个视口、
`await expect(page.locator(DOCK)).toHaveCount(0, { timeout: 20_000 })`、以及对回合结束窗口的 8×55ms 采样
（AC6 的窗口）——合计再加 ~3.5–5.5s。**用例体天然落在 ~18.5–20.8s，而守卫是 20_000ms**，几乎没有余量。
行走的 ~15s 是结构性的（spec 内 `:902-908` 的注释说明控制面拾取请求本身就要数秒），体不可能压到 ~15s 以下。

**为什么早先的修法没守住**

`gap-activity-single-dock-global-consistency`（现 `done`）建了这个用例，并在 AC8 里设下
`expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000)`。它把上限
卡在 20s，而用例的地板本身就在 ~15s 的行走 + 强制的收尾/采样之上——**这个上限从一开始就贴着地板，
没有留出负载余量**。在旧树（`0399dd59`）上它 pass 了 19 次；当 mcp-ui-visible-context 合入、树变成
`e9bf1390`、宿主负载升到 round 425 记录的 `load1: 43.5`（`hostFreeBytes: 4250836992`）时，同一个用例体
越过了这条自己设的线。所以早先的修法不是「被回归打破」，而是**它设的内部守卫本身离地板太近**，在更重的
负载下必然偶发。

**边界的澄清。** AC-188 记录的 `expect:` **没有要求任何墙钟上限**——它要求的是「任一时刻恰有一个
`[data-activity-dock]`、旧标记计数为 0、resident 状态栏不再有忙闲字样、各处状态一致，桌面与移动各读一次，
外加两个假形态」。20_000 是这个任务自己加的用例体守卫，不是 AC 的约束。因此**重标这条内部守卫不等于放宽
AC**（这与 AC-199 的情形不同：那里的 40s 是 `expect:` 明文要求的，不得放宽）。⛔ 但 `SINGLE_SPEC_CEILING_MS
= 55_000` 与 60s 闸门**不动**，任何实质读数**一字不删**。

<!-- dedup-ref -->
追溯：唯一携带顶层 `goal_ac: AC-188` 的任务是 `gap-activity-single-dock-global-consistency`（`done`）——
它已 done，故按机制去重规则不是重复（done 恰恰是「早先修法没守住」的证据），本任务为新立。同机制的同类先例
（均为 `done`，各自别的 AC）：`gap-ac199-criterion-wallclock-load-scaled-fixed-cost`（AC-199）、
`gap-ac180-enter-criterion-load-flake-stabilize`（AC-180）、`gap-suite-criterion-wallclock-budget`（AC-103）。
以上仅为同类机制的追溯参照，不构成任何前置。

## Plan

1. **先量地板，再动预算。** 不改任何断言前，先在同一棵树上重跑判据并采集读数：`dock.wall=` 的序列、
   `walk-done @Xms`（行走地板）、以及回合结束后的收尾耗时（重新导航 + `toHaveCount(0)` + 8×55ms 采样）。
   把这些逐字写进 `## Evidence`——新预算必须从实测地板推出来，不许拍脑袋。
2. **优先削地板，其次才抬上限（二选一，必须给出实测理由）。**
   - 削地板：若能把固定成本做成对负载不敏感——例如把收尾阶段的等待改成对真实信号的确定性握手，或
     在不删 AC6 的回合结束窗口采样、不删 AC7 移动读数的前提下减少重复导航——则优先这么做，预算上限可保持不动。
   - 抬上限：若地板是结构性的（行走的 ~15s 无法压缩，收尾/采样也不能删），则把 `e2e/activity-dock-truthful.spec.ts`
     里 AC-188 用例体的预算（现 `:1384` 的 `toBeLessThanOrEqual(20_000)`）抬到实测地板之上并留出负载余量
     （参考值 **30_000**，须以实测为准）。抬完必须验证整次调用仍落在 `SINGLE_SPEC_CEILING_MS = 55_000`
     与闸门 60s 之内。
3. **保读数是硬约束。** AC-188 的每一条实质断言（单坞数量、`LEGACY_MARKERS` 计数为 0、
   `RESIDENT_ACTIVITY_MARKERS` 为空、`resident.panel.controls`、`consistency.turn` / `consistency.afterTurn`
   的两个视口读数）逐条保留，一个字都不许删或放松；`## DoD` 判的是这些读数仍在，不是「用时更短」。
4. **假形态回归。** 重跑 AC-188 记录里写死的两个假形态，证明它们**仍然会红**：
   (i) 恢复 `.chat-activity-tab` 与 `data-slot="chat-activity-inline"` 的挂载 ⇒ 数量读数必须红；
   (ii) 让 `src/modules/sidebar/RunningView.tsx` 改读 1 秒 `/api/session-hosts` 轮询 ⇒
   `consistency.turnOpen` 必须在回合刚结束的窗口内红。两个假形态必须各给出一条红的实测记录。
   **本轮结果**：(i) 已红（§3）；(ii) 实测不可满足（§4），已按人工裁决移出至 `gap-ac188-criterion-agreement-loses-poll-source-falsifiability`。
5. **稳定性验证。** 判据在改后连续 ≥8 次 pass，其中至少一次与立案时同量级的负载下运行（round 425 记
   `load1: 43.5`）。若仍见红，先判定是地板还是别的机制，不要把红藏起来。
6. **静态闸。** 改动文件过 `npm run typecheck`、oxlint 与本仓对该 spec 的静态检查。
7. **落账并自检。** `task-schema-check.js` exit 0、`quay task check <id> --json` 的 `missing: []`，
   只把 `tasks/gap-ac188-criterion-body-budget-below-its-turn-walk-floor.md` 加进提交。

## AC

- [x] 复现并记录：在 HEAD 树上重复跑 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` ≥4 次，逐次记下 `dock.wall=`（立案时的实测序列为 18798 / 20810 / 18864 / 18545 ms，其中 20810ms 红），把序列写进 `## Evidence`
- [x] 地板实测：记录一次 `await clock` 行走的墙钟（`walk-done @Xms`，立案时 ~15.0–15.4s）与回合结束后的收尾耗时，作为新预算的下界依据写进 `## Evidence`
- [x] 预算重标：若走抬上限路线，`e2e/activity-dock-truthful.spec.ts` 中 AC-188 用例体的预算（原 `:1384` 的 `toBeLessThanOrEqual(20_000)`）被抬到实测地板之上并留余量（参考 30_000，以实测为准），且整次调用仍 `< SINGLE_SPEC_CEILING_MS = 55_000`
- [x] 或削地板：若走削地板路线，收尾/行走的固定成本已对负载不敏感，且 AC6 的回合结束窗口采样与 AC7 的移动读数一条未删（二选一，二者必居其一，并给出实测理由）——**未走此路线**（走的是抬上限路线，见上一条），故本条不适用而非未达成；收尾成本经实测仍是刚性的（§2）
- [x] 假形态 (i)：恢复 `.chat-activity-tab` 与 `data-slot="chat-activity-inline"` 的挂载后重跑，AC-188 的数量读数**必须红**，并记下红的输出
- [x] 假形态 (ii)：令 `src/modules/sidebar/RunningView.tsx` 读 1 秒 `/api/session-hosts` 轮询后重跑，`consistency.turnOpen` 在回合刚结束的窗口内**必须红**，并记下红的输出 —— ⛔ 实测**不可满足**：两种实现（读 `useSessionHosts()` 快照的 lease 列表；字面 `api.sessionHosts.list()` + `setInterval(…, 1000)`）都让判据 **exit 0**。根因是本任务之前的 `e3f86d82`（2026-10-02 16:29 把回合结束窗口改成重新导航后采 ~0.5s，见 §4 的更正）、`b9b177d1` + `7fd3598b`（坞不再在回合间读 `idle`），与本次预算改动无关。逐字读数与对照见 `## Evidence` §4；**判据 2026-10-07：人工裁决「拆出 + 落地」**——该假形态移出至 `gap-ac188-criterion-agreement-loses-poll-source-falsifiability`（现 `ready`），本条不再承担它；本节按**移出**结案，而非按达成结案
- [x] 稳定性：改后判据连续 ≥8 次 pass，其中至少一次在与立案同量级的负载（round 425 记 `load1: 43.5`）下运行，且每次 `dock.count`/`legacy.*`/`resident.*`/`consistency.*` 读数与 AC-188 的 `expect:` 相符
- [x] 静态闸：改动文件过 `npm run typecheck` 与 oxlint（或本仓对该 spec 的等价静态检查），exit 0
- [x] 任务自身 `tasks/gap-ac188-criterion-body-budget-below-its-turn-walk-floor.md` 已落账（自触）

## DoD

这是一次**判据可复现性**的落地，不是「测试存在」。判据是真实浏览器上的 `npx playwright test
e2e/activity-dock-truthful.spec.ts -g "AC-188"`，且在真实宿主负载下运行：

- 改后该判据连续 ≥8 次绿，并跨过一次与立案时同量级的负载（round 425 的 `load1: 43.5`）；早先那种「1/4 假红」
  不再出现。**真实对象是被操作过的**：真实 webServer + Vite 客户端 + 调试 agent 时钟，桌面与移动两个视口各读一次。
- 只用例体这一层的内部预算被重标（或地板被削），`SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门未动；
  AC-188 的 `expect:` 未要求任何墙钟上限，故这是内部守卫的重标，不是放宽 AC。⛔ 不得放宽或删除任何实质读数。
- 假形态 (i)（旧标记挂载）**仍然会红**，有其机读记录（§3）；假形态 (ii)（1s 轮询 busy）经实测**不可满足**（§4），
  已按人工裁决移出至 `gap-ac188-criterion-agreement-loses-poll-source-falsifiability`。本任务的证伪力由 (i) 承担——重标预算没有把它削掉。
- `## Evidence` 里逐字留档：墙钟序列、`walk-done @Xms` 地板、两个假形态的红、稳定性运行的读数。

## Evidence

落地：分支 `task/gap-ac188-criterion-body-budget-below-its-turn-walk-floor`，实现提交 `34659e8a`，
pre-merge 合并提交 `ca5e0720`（`git merge --no-edit develop`，无冲突）。改动仅一处断言：
`e2e/activity-dock-truthful.spec.ts:1395` 的 `toBeLessThanOrEqual(20_000)` → `toBeLessThanOrEqual(30_000)`
（原在 `:1384`，加了说明注释后移三行），并补上其上方的实测理由注释。实质读数一字未动。
⚠️ 同一文件里 `:743`、`:833`、`:1600` 还有三处同形的 `20_000` 守卫（分别属于别的用例，含 AC-187 的），
本任务范围外，**未动**。

### §1 立案红的逐字读数（`/tmp/ac188-repeat-1.log`）

```
dock.wall=20810ms
    Error: the case body must land inside its own budget
    expect(received).toBeLessThanOrEqual(expected)
    Expected: <= 20000
    Received:    20810
      at e2e/activity-dock-truthful.spec.ts:1384
```

立案序列（`dock.wall=` 逐字）：18798 / 20810(红) / 18864 / 18545 ms。

### §2 地板实测（`walk-done @Xms` = `await clock` 返回那一刻）

| 组 | `walk-done` | `dock.wall` | 收尾 = wall − walk-done |
|---|---|---|---|
| 改动前 4 次 | 15070 / 15011 / 15009 / 15034 ms | 18885 / 18795 / 18534 / 19235 ms | 3.82 / 3.78 / 3.53 / 4.20 s |
| 改动后 8 次稳定性 | 15019 / 15018 / 14969 / 15033 / 15011 / 15041 / 15009 / 15031 ms | 18653 / 18457 / 18460 / 18675 / 18471 / 18757 / 18585 / 18788 ms | 3.63 / 3.44 / 3.49 / 3.64 / 3.46 / 3.72 / 3.58 / 3.76 s |
| 改动后 1 次加载运行（`load1` 30.70 → 40.34，32 个 `yes` spinner） | 15112 ms | 19686 ms | 4.57 s |

- 行走地板 14.97–15.41s：`unattended-turn@0 → turn-end@5000 → wait@5500` 这一整个调试 agent 回合，
  控制面拾取请求本身要数秒，**压不动**。
- 收尾刚性的来源：重新导航两个视口各拿一次新鲜 `chat_subscribed`（本用例回合后窗口读的就是这个确定性信号）
  + `toHaveCount(0)` + 每个视口 8×55ms 采样 — 一条都删不得（Plan step 3）。
- 用例体 **18.46–19.69s**。**加载运行 19686ms 距旧的 20000 守卫只剩 314ms**，与立案的 20810ms 同形——
  这条守卫本来就贴着地板，负载多给一点墙钟就越线。抬到 30_000 后，最差实测体还余 ~10.3s，
  且整次调用（含 boot 与 teardown）远在 `SINGLE_SPEC_CEILING_MS = 55_000` 内。

### §3 假形态 (i)：红（已复现，`/tmp/ac188-falsify-i.log`）

恢复 `ActivityIndicator.tsx` 中 `.chat-activity-tab` 与 `[data-slot="chat-activity-inline"]` 的挂载后重跑：

```
Error: desktop: the old tab class and the inline slot must not match anything
  - Expected  - 1
  + Received  + 4
  - Array []
  + Array [
  +   ".chat-activity-tab",
  +   "[data-slot=\"chat-activity-inline\"]",
  + ]
    at e2e/activity-dock-truthful.spec.ts:1346
```

### §4 假形态 (ii)：实测**不可满足**（判据 exit 0），且非本次改动所致

令 `RunningView.tsx` 的 busy 集合改读 1 秒 `/api/session-hosts` 轮询，两种实现都试过：

- 读 `useSessionHosts().snapshot` 的 lease 列表（历史写法，即被 `ad1bb63a` 换掉的那版）→ `/tmp/ac188-falsify-ii.log`：**exit 0**。
- 字面上的 1 秒轮询（`api.sessionHosts.list()` + `setInterval(…, 1000)`）→ `/tmp/ac188-literalpoll2.log`：**exit 0**。

逐字读数（字面轮询那次）：

```
consistency.turnOpen=[{"dock":"in-turn","sidebar":true,"send":"send"} ×8]
consistency.turn.desktop={"dock":"in-turn","sidebar":true,"send":"stop"}
consistency.afterTurn.desktop=[{"dock":"absent","sidebar":false,"send":"send"} ×8]
dock.wall=20556ms  →  1 passed
```

判据的回合打开断言只抓一个方向：`!inTurn(s.dock) && (s.sidebar || s.send === 'stop')`。
假形态让 sidebar 在一个**坞正读 `in-turn`** 的时刻亮起来，正落在断言的容差侧。
（另注：该窗口是单向的——基线在回合打开时读的是 `{"dock":"in-turn","sidebar":false,"send":"send"}`，
即「坞在前、sidebar 在后」，判据本来就容忍这一侧。）

根因（两条都在本任务之前，且都在 HEAD 与 develop 的祖先里）：

⚠️ **2026-10-07 复核更正**：本条早先记为 `421afb84`（17:00 的 bounded startup guard）。复核不成立——
`git show 421afb84 -- e2e/activity-dock-truthful.spec.ts` 的 spec diff **完全不触**回合结束窗口；
`git log -S"i < 24"` 与 `-S"one-second poll"` 都只指向 `ad1bb63a`（引入 24×55ms 活页面窗口）与
**`e3f86d82`**（改写为重新导航后 8×55ms），两者都是 HEAD 的祖先（`git merge-base --is-ancestor` 各返回 0）。
结论不变（窗口确已被改窄、假形态 (ii) 确实惰性），但根因提交更正为 `e3f86d82`。

1. **`e3f86d82`**（2026-10-02 16:29，"activity dock: share the announced silence budget across dock mounts"，
   即 `ad1bb63a` 之后 49 分钟）把回合结束后的窗口从**活页面**（从坞离开 `in-turn` 起采 **24×55ms ≈ 1.3s**，
   注释明写「span ~1.3s — past the one-second poll's own beat, which is the interval the old sidebar lagged by」）
   改成**重新导航两个页面之后**采 **8×55ms ≈ 0.5s**，起点已是坞转 `absent` 之后约 2.5s：1 秒轮询早已追平。
2. **`b9b177d1`**（2026-10-04，「heartbeat carries run-in-flight bit so an idle phase no longer clears a live turn anchor」）
   与 **`7fd3598b`**（"feat(chat): draw the turn's status in the message flow at every viewport"）之后，
   坞在回合打开时读 `in-turn`、回合间读 `absent`。立案记录里那条红是
   `consistency.turnOpen={"dock":"idle","sidebar":true,"send":"send"}`——靠的是**旧的坞语义**（resident 在回合间留 `idle`），
   这个语义已经不存在了。

对照实验（真·健康树、无假形态）：活页面在 `walk-done` 之后以 100ms 间隔连采 25 次
（`/tmp/ac188-baseline-afterwalk.log`）：`{dock,sidebar,send}` = `in-turn,false,send` ×3 → `absent,false,send` ×22，
**25/25 一致**。这条窗口在健康树上稳定为绿；而 1 秒轮询在回合结束时的实测滞后 **≤150ms**
（`/tmp/ac188-literalpoll2.log` 的 `probe.afterWalk`：`0` 是 `{dock:in-turn,sidebar:true,send:send}`，
`1` 已是 `{dock:in-turn,sidebar:false,send:send}`），被坞自己的 220ms 退出动画（`EXIT_ANIMATION_MS`）盖住——
**即便把活页面窗口搬回来，也无从稳定落红**。

结论：AC6 断言的「必须红」在当前树上**不可满足**，且与预算改动无关（预算字面量在 `:1395` 求值，
比任何一致性窗口都晚）。判据若要有这条证伪力，得先补回一个能落红的窗口，或承认该假形态已随坞语义失效。
这一条**未打勾**，任务置 `needs-human`，留给人工裁决。

### §4b 人工裁决（2026-10-07）

对 §4 的处置：**拆出 + 落地**。假形态 (ii) 的证伪力问题不是本任务能修的（它是判据窗口的缺陷，不是预算的缺陷），
故移出为独立任务 `gap-ac188-criterion-agreement-loses-poll-source-falsifiability`（labels `gap,defect`，`goal_ac: AC-188`，先量坞的心跳节拍与轮询侧真实滞后，
再定修窗口还是按 AC-172/177/178 家族先例退役该假形态）；本任务据此把 AC(ii) 按移出结案，其余 AC 全绿后落地。

### §5 静态闸

- `npm run typecheck` → exit 0（`tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 三处全过）
- `npm run lint`（oxlint `src/ server/ scripts/ shared/`）→ exit 0，仅既有 warning
- `e2e/` 不在 lint 路径内；单独 `npx oxlint e2e/activity-dock-truthful.spec.ts` 只报一条**既存**错误
  （`:910` `CONSOLIDATION_SCENARIO` declared but never used，HEAD 上同样存在），与本次改动无关。

### §6 产物

- 实现提交：`34659e8a`；pre-merge：`ca5e0720`
- 工作树：`/data/home/yale/work/claudecodeui-worktrees/gap-ac188-criterion-body-budget-below-its-turn-walk-floor`
- 日志：`/tmp/ac188-stab-{1..8}.log`、`/tmp/ac188-stab-load.log`、`/tmp/ac188-falsify-i.log`、
  `/tmp/ac188-falsify-ii.log`、`/tmp/ac188-literalpoll2.log`、`/tmp/ac188-baseline-afterwalk.log`、
  `/tmp/ac188-walksample.log`、`/tmp/ac188-falsification/`（假形态源码与 diff 存档）

## Touches

- `e2e/activity-dock-truthful.spec.ts`（AC-188 用例体的预算与/或收尾固定成本）
- `playwright.config.ts`（仅当需要为该 spec 声明 per-file 预算时；否则不动）
- `tasks/gap-ac188-criterion-body-budget-below-its-turn-walk-floor.md`（自触）
