---
id: gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout
title: AC-184 判据 2026-10-04T15:27:13.669Z 那拍的红由主检出未提交 voice WIP 在判据运行途中被保存、Vite
  把这次保存当 HMR 推给正在跑的页面把 ProjectWorkspaceRouteContent 的 React 树打崩（坞的活动订阅随之死掉，分区后
  10s 内读不到 unreachable，红在 :680）——verification-only 归因入档：工作树直跑 14/14 exit
  0；remedy 归该 WIP 作者（勿在判据运行期保存主检出）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-184
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-184 `status: achieved`，其 GOAL-014 已 achieved 且不再活，未声明 `long-term: true`；台账 `gate=goal` 尾部为 `2026-10-04T15:24:37.022Z pass (goal-cli)` → `2026-10-04T15:27:13.669Z fail (goal-cli)`，故按 CURRENTLY FALSE 立案。本轮在 HEAD（`author`，`b4c3cebc`）上直跑判据本体 **14 次全部 exit 0**（5 次串行 + 1 次与 5 条兄弟判据并发 + 4+4 两波各四路并发），读数 `dock.recovered.elapsed` 稳定在 6556–6630ms、`dock.wall`≈14512ms —— **工作树满足 AC-184**。下面给出 15:27:13.669Z 那拍红的机制：它不是坞的承诺退化，而是判据运行途中的 Vite HMR 把承载页面的 React 树打崩。

判据物（逐字取自 `goals/AC-184-真实浏览器-服务端不可达时坞显示连接中断-不再出现-thinking-计时冻结-停止按钮置灰并说明-恢复后回到真实状态.md` 的 `criterion:`）：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `b4c3cebc`，branch `author`）：`grep -rn "^goal_ac: *AC-184" tasks/*.md` → **2 命中**，`status:` 逐字皆 **done**（`gap-activity-dock-unreachable-degradation` 本判据的建立者、`gap-activity-idle-beat-clears-open-turn-anchor` 修「idle 心跳清锚点」）。在飞扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human 且 `^goal_ac: AC-184`）→ **0 命中** ⇒ 无在飞认领者。同机制先例 `gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（`goal_ac: AC-175`，done）是**另一条 AC**（同一类运行期 HMR 机制，不同判据、不同页面）。⇒ 本条不重复。

（1）**工作树直跑 → 绿**（立案前在 HEAD 上重跑出货命令）：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` → 14/14 EXIT 0。逐字读数（其中一次）：`dock.state.before=in-turn`、`dock.text.before="Working… 0s"`、`dock.composer.stop.enabled.before=true`、`dock.server.unreachableAfterMs=900`、`dock.state.after=unreachable`、`dock.words.hit=[]`、`dock.frozen.gap=3057ms`、`dock.frozen.samples=["0s","0s"]`、`dock.stop.count=0`、`dock.composer.stop.disabled=true`、`dock.recovered.elapsed=6525ms`、`dock.wall=14513ms`、`1 passed`。⇒ 承重的五条读数 (i)–(v) 全部在场，`:734`（elapsed 有限）从未红。

（2）**台账尾巴**：`.quay/gate-events.jsonl` 里 AC-184 `gate=goal` 的近期逐字：`15:04:46.659Z fail` → `15:07:29.424Z fail` → `15:09:52.636Z fail` → `15:12:33.077Z fail` → `15:15:23.550Z fail` → `15:24:37.022Z pass` → `15:27:13.669Z fail`（后两拍 actor 均 `goal-cli`）。15:04–15:15 那批 fail 对应的是**尚未含修复**的 recheck head（`gap-activity-idle-beat-clears-open-turn-anchor` 的修复 `b9b177d1` 提交于 `15:07:35Z`，随后才进入 develop 祖先；同轮 frozenRecheck 于 15:25:16Z 在含修复的 head `672d6632` 上把 AC-184 记为 pass/now-true）。**修复之后仍有一拍 fail：`15:27:13.669Z`**，即本条归因的那一拍。

（3）**那拍 fail 的机制（从其失败跑自己的 trace.zip / error-context.md 读出，不是猜）**：失败跑数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-jbXl5A`；`test-results/activity-dock-truthful-act-4a2b3-e-app-socket-is-partitioned/error-context.md` 逐字：

```
Error: expect(locator).toHaveAttribute(expected) failed
Locator: locator('[data-activity-dock]')
Expected: "unreachable"
Timeout: 10000ms
Call log:
  - Expect "toHaveAttribute" locator('[data-activity-dock]') with timeout 10000ms
  - waiting for locator('[data-activity-dock]')
    5 × locator resolved to <div data-activity-dock="" data-activity-phase="idle" data-activity-elapsed-ms="0" data-activity-state="in-turn" class="pointer-events-none bg-transparent chat-activity-enter">…</div>
      - unexpected value "in-turn"
```

即：分区之后 10s 内坞一直是 `in-turn`，从未降到 `unreachable` —— 红在 `e2e/activity-dock-truthful.spec.ts:680`（读数 (ii)），**不是** `:734`（读数 (v)）。

解包该跑 `trace.zip` 后 `6-trace.trace` 逐字（换算 `abs = wallTime + (rel − monotonicTime)`，头 `wallTime=1791127622736`、`monotonicTime=10428.458`）：

```
rel=11227.724  abs=2026-10-04T15:27:03.535Z  console:debug  [vite] hot updated: /src/index.css
rel=11227.931  abs=2026-10-04T15:27:03.535Z  console:debug  [vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx
rel=11260.042  abs=2026-10-04T15:27:03.568Z  console:error  The above error occurred in the <ProjectWorkspaceRouteContent> component: ...
```

同跑页面 console 另有 `Failed to load resource: the server responded with a status of 400 (Bad Request)` ×2、`404 (Not Found)` ×3。⇒ 因果链：分区后坞的读数源（会话活动订阅）随 `<ProjectWorkspaceRouteContent>` 的 React 树一起崩掉 ⇒ 页面再没有帧、也没有降级判定 ⇒ 坞卡在 `in-turn`，`data-activity-elapsed-ms="0"` ⇒ 10s 断言超时 ⇒ `15:27:13.669Z` 记 fail。

（4）**触发源是谁**：`find src e2e server playwright.config.ts -newermt '2026-10-04 23:26:00' ! -newermt '2026-10-04 23:27:30' -type f`（本地时区 UTC+8）命中 16 份，全部属于一条**并发的 voice 功能开发 WIP**：`src/modules/chat/hooks/useVoiceInput.ts`、`src/modules/chat/utils/voiceLiveReading.ts`、`src/shared/voiceDebug.ts`、`playwright.config.ts`、`e2e/voice-live-vad-ab.spec.ts` 以及一批 `src/modules/chat/tests/*voice*` 测试。关键四份 mtime 逐字：`2026-10-04 23:27:03.272 +0800`（= `15:27:03.272Z`）—— 与 HMR 推送（`15:27:03.535Z`）相差 263ms。⚠️ `[vite] hot updated:` 行里点名的路径是 update 链的 importer，未必是被保存的文件；承重的是「保存时刻（15:27:03.272Z）紧邻 HMR 时刻（15:27:03.535Z）」。判据跑在主检出工作树上，故任何与之重叠的保存都会走到这一步。

（5）**这条是什么、不是什么**：verification-only 归因入档。它**不**改实现、判据、宿主配置一个字节，也**不**动主检出的活 WIP（`stash` / `git checkout --` / 编辑一律不做 —— 那份 WIP 归其作者）。它交付的是可复核读数与判法：**「未提交 WIP 在判据运行途中的 HMR 推送把承载页面的 React 树打崩 ≠ AC-184 回归」**，以及 remedy —— 该 WIP 的作者不要在判据运行期保存主检出（或把它改到可编译并提交）。

**为什么早先的修复没兜住（如实区分）**：`gap-activity-idle-beat-clears-open-turn-anchor`（done，commit `b9b177d1`）修的是另一条路径 —— 「run 在飞但 tracker 无 phase 时，`phase=idle` 的心跳清掉回合锚点」⇒ 恢复后 `elapsed=NaN`（红在 `:734`）。那一条**是有效的**：本轮 14/14 直跑里 `dock.recovered.elapsed` 稳定有限（6556–6630ms），`:734` 从未红。本拍的红红在 `:680`（分区后读不到 `unreachable`），机制是运行期 HMR 崩 React 树，与回合锚点无关 —— **不是**早先修复失效，是一条独立的、环境性的红。

## Plan

1. 建本条的隔离 worktree（起点 = 开工时的 `develop`；`git status --porcelain` 空），在**其中**跑出货命令两次：一次普通跑（读退出码 / `1 passed` / `dock.wall`），一次带 `--trace on`（留一份**净树**的 trace 作对照）。
2. 从净树那次 trace 里读出同一条用例的页面事件，证明净树跑里**没有** `[vite] hot updated`、**没有** `<ProjectWorkspaceRouteContent>` 的 `console:error`（与本条的失败跑逐字对照）—— 这是本条归因的承重分辨力。
3. 从失败跑留下的 `trace.zip` 里把 Proposal(3) 的每条读数**重新解包、逐字抄**（trace 路径与解包命令写进完成记录）；若 `~/.cache/quay-e2e-tmp/quay-e2e-jbXl5A` 已被 6h TTL 回收，改用本条隔离 worktree 里的同机制复现：在跑动途中保存一个 `src/modules/chat/**` 文件制造 HMR，读到同一 `<ProjectWorkspaceRouteContent>` 错误后立即回退并证明零残留（`git status --porcelain` 回到空）。
4. 机械核对「触发源是谁」与「无归属」：`find` 窗口读数、关键文件 mtime、在飞任务扫描（无 AC-184 认领者）。
5. 如实登记台账尾巴与本条读数；交付只落在 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条自己的隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` 退出 **0**、`1 passed`、`dock.wall ≤ 20000ms`，并把判据自己打印的读数行逐字抄进完成记录（至少含 `dock.state.before=in-turn`、`dock.server.unreachableAfterMs=900`、`dock.state.after=unreachable`、`dock.words.hit=[]`、`dock.frozen.samples=["0s","0s"]`、`dock.stop.count=0`、`dock.composer.stop.disabled=true`、`dock.recovered.elapsed`）。红态基线（本轮立案读数）：主检出 `15:27:13.669Z` 那拍 EXIT=1，红在 `e2e/activity-dock-truthful.spec.ts:680`，坞 10s 内 `5 ×` 解析为 `data-activity-state="in-turn"`。
- [x] AC2 分辨力（承重）：净树那次带 `--trace on` 的跑里，同一条用例的页面事件中 `[vite] hot updated` 计数为 **0**、`The above error occurred in the <ProjectWorkspaceRouteContent>` 计数为 **0**；把两条计数命令与逐字输出入档，并与失败跑的逐字对照（失败跑：`hot updated` 2 行、`ProjectWorkspaceRouteContent` error 1 条）。⚠️ 若净树跑因宿主原因出现无关 pageError，点名归因并给出可区分读数，不得含糊。
- [x] AC3 归因读数逐字入档：从 `~/.cache/quay-e2e-tmp/quay-e2e-jbXl5A/test-results/activity-dock-truthful-act-4a2b3-e-app-socket-is-partitioned/trace.zip` 解包，打出 `6-trace.trace` 的 `hot updated` 行与 `<ProjectWorkspaceRouteContent>` error 行的**相对时刻 + 由 `wallTime`/`monotonicTime` 换算出的绝对时刻**（本轮立案读数：HMR `15:27:03.535Z`、React error `15:27:03.568Z`），以及 `error-context.md` 里坞的解析快照（`data-activity-state="in-turn"`）；trace/error-context 路径与解包命令写进完成记录。若该目录已被回收，按 Plan(3) 用同机制复现替代，并证明复现后零残留（`git status --porcelain` 回到空）。
- [x] AC4 触发源与归属（机械）：`find src e2e server playwright.config.ts -newermt '2026-10-04 23:26:00' ! -newermt '2026-10-04 23:27:30' -type f` 列出被保存文件；`stat -c '%y %n'` 给出关键文件 mtime（本轮 `23:27:03` 一组）；在飞任务扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: AC-184`）→ 0 命中。命令与逐字输出入档。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；主检出 `git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`）。
- [x] AC6 如实登记：完成记录逐字写明「被提交的树满足 AC-184」与「台账 `15:27:13.669Z` 那拍红由主检出未提交 voice WIP 在运行途中的 HMR 推送把 `<ProjectWorkspaceRouteContent>` 的 React 树打崩、坞的活动订阅随之死掉、分区后读不到 `unreachable` 造成」，并附 AC1 的净树读数；⛔ 不得用组件层/jsdom 的绿替代浏览器层的绿。

## DoD

- 出货命令（`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`，逐字不改；⛔ 不加 `retries`、不 skip、不改断言、不改 timeout）在净检出上真的跑过，读数行逐字入档 —— 不是复述 `expect` 的文字，不是读台账尾巴。
- 归因的每一条读数（HMR 行 + React error 行的时刻、坞的 `in-turn` 快照、触发文件与 mtime）都能由任何人在同一 checkout 上从那份 `trace.zip` + `error-context.md`（或本条隔离 worktree 里的同机制复现）复现；路径与解包命令写进完成记录。
- 完成记录明确写出判法：**「未提交 WIP 在判据运行途中的 HMR 推送把承载页面的 React 树打崩 ≠ AC-184 回归」**，并给出 remedy：该 WIP 的作者不要在判据运行期保存主检出。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、未提交工作树、宿主配置一个字节未动。
- 若净树直跑为**红**（即红不依赖运行期编辑），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- `tasks/gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout.md`（自触）
- `e2e/activity-dock-truthful.spec.ts`（本条只跑不改：AC1/AC2 的判据本体）
- `src/modules/chat/hooks/useVoiceInput.ts`（本条只读不改：触发保存的文件之一 / mtime 证据）
- `src/modules/chat/utils/voiceLiveReading.ts`（本条只读不改：同窗口被保存文件）
- `goals/AC-184-真实浏览器-服务端不可达时坞显示连接中断-不再出现-thinking-计时冻结-停止按钮置灰并说明-恢复后回到真实状态.md`（本条只读不改：criterion/expect 的逐字来源）

## 完成记录

### 净检出直跑（AC1）——绿

- 隔离 worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`
- 起点 = 开工时 `develop`；`git rev-parse HEAD` = `e15729b36e9e3f6c93c20c65b81c94c5304716f7`；开工时 `git status --porcelain` = 空。
- 出货命令（逐字不改，无 `retries`/无 skip/无改断言/无改 timeout）：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`
- 结果：`EXIT=0`、`1 passed (27.3s)`、`dock.wall=14520ms`（≤ 20000ms）。
- 判据自打印读数逐字：

```
dock.state.before=in-turn
dock.text.before="Working… 0s"
dock.composer.stop.enabled.before=true
dock.shipped.intervalMs=5000
dock.shipped.unreachableAfterMs=15000
dock.server.unreachableAfterMs=900
dock.state.after=unreachable
dock.words.hit=[]
dock.frozen.gap=3072ms
dock.frozen.samples=["0s","0s"]
dock.stop.count=0
dock.text.unreachable="Connection lost · reconnecting… 0s"
dock.composer.stop.label="Stop this answer (process and scheduled tasks stay)"
dock.composer.stop.disabled=true
dock.composer.stop.title="Stop this answer (process and scheduled tasks stay) (Esc) — Stop is unavailable while the server is unreachable"
dock.recovered.elapsed=6558ms
dock.recovered.restart-would-be=0ms
dock.recovered.gap=3115ms after=3318ms
dock.wall=14520ms
```

- 红态基线（本轮立案读数）：主检出 `15:27:13.669Z` 那拍 EXIT=1，红在 `e2e/activity-dock-truthful.spec.ts:680`，坞 10s 内 `5 ×` 解析为 `data-activity-state="in-turn"`。

### 分辨力（AC2）——净树 0 / 0，失败跑 14 / 1

净树那次带 `--trace on` 的跑：命令 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184" --trace on` → `EXIT=0`、`1 passed (25.4s)`、`dock.wall=14512ms`；数据目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-SXCaVJ`。
解包：`unzip -o <data-dir>/test-results/activity-dock-truthful-act-4a2b3-e-app-socket-is-partitioned/trace.zip -d /tmp/ac184-cleantrace`。

两条计数命令与逐字输出（净树）：

- `cat /tmp/ac184-cleantrace/*-trace.trace | grep -c 'hot updated'` → **0**
- `cat /tmp/ac184-cleantrace/*-trace.trace | grep -c 'The above error occurred in the <ProjectWorkspaceRouteContent>'` → **0**

逐文件：`0-trace.trace … 9-trace.trace` 每个 `hot=0 pwsrc-error=0`。

失败跑（`~/.cache/quay-e2e-tmp/quay-e2e-jbXl5A`）同两条命令：

- `cat *-trace.trace | grep -c 'hot updated'` → **14**（全在 `6-trace.trace`，同一 page `page@2a547b801ea1c297e84fd2cc56606bee`）
- `cat *-trace.trace | grep -c 'The above error occurred in the <ProjectWorkspaceRouteContent>'` → **1**

⚠️ 如实对账：AC2 括号里「失败跑 `hot updated` 2 行」对应的是 Proposal(3) 引用的**因果对**——紧随 React error 之前的两条（`15:27:03.535Z` 的 `/src/index.css` 与 `ChatComposer.tsx`）；`6-trace.trace` 全量实为 **14 条**，其余 12 条是 React 树崩后 Vite 反复推送的 `/src/index.css`（rel 11269.007 … 11439.632）。本记录按全量 14 报告：它与 AC2 的「2 行」是同一现象的因果对子集，不冲突。

⚠️ 净树跑无关 pageError 点名：净树跑 console 有 `Failed to load resource` 403×4、404×3、400×2；失败跑有 404×3、400×2（403 为净树独有，来自未认证资源探测）。**均为资源加载错误，非 React 树崩溃**，可与承重信号区分：净树 `<ProjectWorkspaceRouteContent>` 错误计数为 0、`hot updated` 为 0。这类资源错误两条跑都在场，不承重。

### 归因读数逐字（AC3）

失败跑数据目录**仍在**（未被 6h TTL 回收），故用真迹，不做 Plan(3) 同机制复现（主检出的活 WIP 未被本任务触碰）。

- trace：`~/.cache/quay-e2e-tmp/quay-e2e-jbXl5A/test-results/activity-dock-truthful-act-4a2b3-e-app-socket-is-partitioned/trace.zip`
- error-context：同目录 `error-context.md`
- 解包命令：`unzip -o <trace.zip> -d /tmp/ac184-trace-unpack`
- 换算：`abs = wallTime + (rel − monotonicTime)`；`6-trace.trace` 头逐字 `"wallTime":1791127622736,"monotonicTime":10428.458`

| 事件 | rel(ms) | abs |
|---|---|---|
| `[vite] hot updated: /src/index.css` | 11227.724 | `2026-10-04T15:27:03.535Z` |
| `[vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx` | 11227.931 | `2026-10-04T15:27:03.535Z` |
| `The above error occurred in the <ProjectWorkspaceRouteContent> component:` | 11260.042 | `2026-10-04T15:27:03.568Z`（原值 1791127623567.584ms；截断 .567、四舍五入 .568） |

`error-context.md` 坞的解析快照逐字：

```
Error: expect(locator).toHaveAttribute(expected) failed
Locator: locator('[data-activity-dock]')
Expected: "unreachable"
Timeout: 10000ms
Call log:
  - Expect "toHaveAttribute" locator('[data-activity-dock]') with timeout 10000ms
  - waiting for locator('[data-activity-dock]')
    5 × locator resolved to <div data-activity-dock="" data-activity-phase="idle" data-activity-elapsed-ms="0" data-activity-state="in-turn" class="pointer-events-none bg-transparent chat-activity-enter">…</div>
      - unexpected value "in-turn"
```

因果链：分区后坞的读数源（会话活动订阅）随 `<ProjectWorkspaceRouteContent>` 的 React 树一起崩掉 ⇒ 页面再没有帧、也没有降级判定 ⇒ 坞卡在 `in-turn`、`data-activity-elapsed-ms="0"` ⇒ 10s 断言超时 ⇒ `15:27:13.669Z` 记 fail。

### 触发源与归属（AC4）

`find src e2e server playwright.config.ts -newermt '2026-10-04 23:26:00' ! -newermt '2026-10-04 23:27:30' -type f`（主检出）逐字输出 **14 份**：

```
e2e/voice-live-vad-ab.spec.ts
playwright.config.ts
src/modules/chat/tests/activityIndicatorResponsive.test.tsx
src/modules/chat/tests/chatComposerResponsive.test.tsx
src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx
src/modules/chat/tests/composerCompactTier.test.tsx
src/modules/chat/tests/occupiedSessionReadOnly.test.tsx
src/modules/chat/tests/residentComposerEnableAffordance.test.tsx
src/modules/chat/tests/voiceErrorMessages.test.tsx
src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
src/modules/chat/utils/tests/voiceLiveReading.test.ts
src/modules/chat/utils/voiceLiveReading.ts
src/shared/tests/voiceUpload16k.test.ts
src/shared/voiceDebug.ts
```

`stat -c '%y %n'`（关键文件）：

```
2026-10-04 23:27:03.273715893 +0800 src/modules/chat/utils/voiceLiveReading.ts
2026-10-04 23:27:03.271715900 +0800 playwright.config.ts
2026-10-04 23:43:54.646089681 +0800 src/modules/chat/hooks/useVoiceInput.ts
```

⇒ `voiceLiveReading.ts` / `playwright.config.ts` 的保存时刻（`23:27:03.27` = `15:27:03.27Z`）紧邻 HMR 推送（`15:27:03.535Z`），承重成立。⚠️ 立案时窗口命中 16 份含 `useVoiceInput.ts`；本次 14 份，且 `useVoiceInput.ts` mtime 已推进到 `23:43:54`（WIP 作者仍在持续保存主检出，见 AC5）。

在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: AC-184`，**排除本条自身**）→ **0 命中**。全 store `goal_ac: AC-184` 仅三条：本条 `ready`、`gap-activity-dock-unreachable-degradation` `done`、`gap-activity-idle-beat-clears-open-turn-anchor` `done`。

### 承重面未被本条触碰（AC5）

- 本条 worktree 的 delta：step 2b(i) 在 worktree 里 `git merge --no-edit develop` 后，HEAD 即 develop 同一提交 `bf9baf98`，故 `git diff --name-only develop..HEAD` → **空**（本条 worktree 分支 `task/gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout` 自身不含额外提交；`task_write` 的 tick 落在 develop 上，由这次 merge 带进 worktree）。本条唯一的 `task_write` 提交是 `bf9baf98 tasks: gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout task_write by cli:3770207`，其 `git show --stat` 逐字只含 `tasks/gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout.md`（`1 file changed, 137 insertions(+), 7 deletions(-)`）。⇒ 本条对代码零改动，`tasks/<本条 id>.md` 是唯一交付物。
- 主检出 `git status --porcelain` 对比开工快照：**发生外部变化，非本条所为**。开工快照（21 行）含未跟踪 `src/modules/chat/audio/voiceFrameProcessorUrl.ts` 与两处 ` M`；现状（18 行）三者消失——并发的 voice-WIP 作者在 `author` 分支提交了 `a4747974 fix(voice): load the AudioWorklet from the bundler's build, not the raw .ts source`（`git reflog` HEAD@{0} 即该 commit；`git ls-files src/modules/chat/audio/voiceFrameProcessorUrl.ts` 现已 tracked；其 mtime 推进到 `23:43:52`）。本条 ⛔ 未 `stash`、⛔ 未 `git checkout --`、⛔ 未编辑任何 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`——本条对主检出的全部动作只有 `git status`/`git log`/`git reflog`/`stat`/`find` 等只读。

### 判法（AC6 + DoD）

**已提交的树（`e15729b3` 起的净检出）满足 AC-184**：出货命令 exit 0、`1 passed`、`dock.wall=14520ms`，五条承重读数齐备。

**台账 `2026-10-04T15:27:13.669Z` 那拍红，由主检出未提交 voice WIP 在判据运行途中的 HMR 推送把 `<ProjectWorkspaceRouteContent>` 的 React 树打崩、坞的活动订阅随之死掉、分区后读不到 `unreachable`（红在 `e2e/activity-dock-truthful.spec.ts:680`）造成 —— 不是 AC-184 回归。** 净树同跑 `hot updated`/`ProjectWorkspaceRouteContent` 计数 0/0；失败跑 14/1，且两条 HMR 推送（`15:27:03.535Z`）紧邻触发文件保存（`15:27:03.27Z`）。

**Remedy**：该 WIP 的作者不要在判据运行期保存主检出（或把它改到可编译并提交）——本记录不代改那份 WIP。

未用组件层/jsdom 绿替代浏览器层绿：以上全部为真实浏览器 e2e 读数（Chromium），载重判据文件 `e2e/activity-dock-truthful.spec.ts` 一字节未改。