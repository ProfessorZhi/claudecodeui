---
id: gap-activity-dock-unreachable-degradation
title: AC-184 活动坞在服务端不可达时不再撒谎：真实浏览器里经 app 自己的 socket 分区读到 unreachable、不再出现
  Thinking、计时冻结、停止置灰并说明、放行后回到真实状态
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-heartbeat-server-frames
  - gap-client-activity-freshness-state-machine
goal_ac: AC-184
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，读代码）。`grep -rn "^goal_ac: *AC-184" tasks/*.md` → **0 命中**；`grep -rln "AC-184" tasks/ .quay/` 只命中 `.quay/goal-round.jsonl`、`.quay/gate-events.jsonl`（驱动器自己的读数，不是认领）。机制侧同为零：`grep -rn "data-activity-dock" src/ e2e/ server/ shared/ --include=*.ts --include=*.tsx` → **0**；`grep -rn "routeWebSocket" e2e/` → **0**（§10.2 的一次性探针 spec 已按提案登记删除）；`test -f e2e/activity-dock-truthful.spec.ts` → **ABSENT**；`grep -n "activity-dock-truthful" playwright.config.ts` → **0**。

GOAL-014 里已认领的两条是**不同机制**，本条不重复它们：`gap-activity-heartbeat-server-frames`（`goal_ac: AC-182`，todo）证明「服务端在按节拍发帧、阈值被宣告」，`gap-client-activity-freshness-state-machine`（`goal_ac: AC-183`，todo）证明「没有帧时那个**纯状态机**怎么降级、怎么冻结」。两条都不碰真实网络也不碰 UI（AC-183 的边界原文：「本条只做状态机与它的假定时器/假 socket 判据，不碰真实网络，也不改 UI（UI 接入是 AC-184）」）。本条认领的正是它们白纸黑字让出的那一格：**真实浏览器、真实服务端、真实应用，在 app 自己的 socket 被分区之后，坞这个界面到底显示什么** —— 状态机对了而界面仍读本地表/本地时钟时，读数 (ii) 与 (iii) 依然会说谎，那正是用户报的「服务器挂了 Thinking 还在显示」。

前两条是本条的真前置，由 frontmatter 的 `depends_on` 显式声明（**唯一**的 gating 面）：判据要在**服务端宣告的阈值**上读到 `unreachable`，而那个字段由 AC-182 引入、被读的状态由 AC-183 引入，没有任何一路能靠替身绕过。同族不同机制的 AC-187（文案对应真实阶段且不按时间轮换）与 AC-188（页面上只有一个活动坞、各处状态一致）**目前没有任务认领，本条不替它们申领**：本条只要求在 **unreachable** 状态下坞里不出现回合进行中的文案（AC-187 管的是回合中状态下文案的**来源**），且本条为了自己的读数需要 `[data-activity-dock]` 用 strict locator 读得到唯一的一个（AC-188 管的是**全局各处**状态一致，含 ResidentStatusBar 的忙闲部分）。

**现状读数（2026-10-01，读代码）。** 界面上没有任何活动坞：`ActivityIndicator.tsx` 是今天唯一的活动表面，桌面页签（`variant='tab'`，`ChatComposer.tsx:472`）与移动内联（`variant='inline'`，`ChatMessagesPane.tsx:466`）两种出口共用它。它**每个出口都从本地表与本地时钟取数**：文案来自 `ACTION_KEYS` 六词按 `Math.floor(elapsedSeconds / 4) % 6` 轮换，已用时间来自 `setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)` —— `startedAt` 是 `SessionActivity.startedAt`（`src/shared/types.ts:196`，注释逐字写着「client clock」），即**本地**时钟。停止按钮只在 `renderedActivity.canInterrupt && onAbort` 时渲染，没有任何连接状态参与。上游的 `processingSessions`（`src/shared/hooks/useSessionProtection.ts:42`）同样只由 `complete` / `protocol_error` / 一次空闲订阅应答 / 成功的轮询清除 —— 服务端不可达时这四件事都不会发生（提案 §2 表 A1）。所以：**今天只要把服务端从页面这一侧切掉，坞会永远显示六词中的某个词并用本地钟一直计时**，而这正是判据 (ii)(iii) 要打红的形态。

**要做的事。** 把坞做实，并证明它在真实浏览器里说真话。坞构件挂在既有的 `ActivityIndicator.tsx` 上（两种出口共用一套状态，按 §4.6「ActivityIndicator（桌面页签/移动内联行）→ 并入活动坞」），挂 `data-activity-dock` 与 `data-activity-state`（取值至少含 AC 逐字要求的 `unreachable` 与 §4.6 的 `in-turn` 等其余状态；本条读数只依赖这两个）。三处从本地改成服务端权威：**已用时间**由服务端 `asOf` 与 `turn.startedAt` 推算（不可达时**冻结**，计算里不出现本地时钟）；**文案**在 unreachable 状态下一律换成连接中断，六个轮换词（及它们在 12 个 locale 里的取值）一个都不许出现；**停止控件**在 unreachable 时 `disabled` 且带非空说明文字，composer 的停止入口（`ChatComposer.tsx` 里 `isLoading ? onAbortSession` 那一支）不得仍然可点。

判据是 AC 的 `criterion:` 逐字命令，夹具是提案 §10 的 L3 层：调试 agent 用一个 `unattended-turn` 步骤把一个回合**开着**（`server/modules/debug-agent/debug-agent.scenario.ts:398`；照 `e2e/resident-busy-send.spec.ts` 的形状，`POST /api/debug-agent/clock` 的响应在走完之前不返回，所以所有读数都在**回合进行中**取得），`page.routeWebSocket` 在 app 自己的 `/ws` 上分区（丢弃服务端→页面的帧、`close({code:1006})`、拒绝重连、放行）—— 四个动作 §10.2 都已在**本仓库真实的 e2e 环境**里实测过（分区期间页面收到 0 帧、close 后约 5ms 触发 `onclose`、app 每 3.0 秒重连一次且被拒、放行后下一次重连成功）。**不在 e2e 里真杀服务端**：真杀会撞 40 秒启动守卫（关掉的端口被判「启动卡住」，退出码 1）并污染同一次运行；「进程死了就没有帧」由 AC-182 证明、「没有帧时状态机怎么表现」由 AC-183 证明、「没有帧时界面怎么表现」由本条证明、「真实部署上真的停服」由 AC-190 的人工关卡收口（提案 §10.3 的四层分工）。

**阈值必须由服务端宣告，不由 spec 硬编码。** 出货默认值 5000/15000 由 AC-182 的 AC6 钉死，本条**不许**碰它；亚秒级只允许由 `playwright.config.ts` 按 `selectedSpecFiles()` 为**这一次选择**注入的服务端环境变量取得（照 `QUAY_E2E_DEBUG_AGENT_HOME` 的既有形状，见 `playwright.config.ts:1391-1397`），客户端只读服务端在 hello（`chat_subscribed`）/快照帧里宣告的那个字段。

## Plan

1. **红态先行。** 写判据文件 `e2e/activity-dock-truthful.spec.ts`（路径由 AC 的 `criterion:` 固定），用例标题含 `AC-184`（判据用 `-g "AC-184"` 过滤）。照 `e2e/resident-busy-send.spec.ts` 的形状起一个用例：`request.newContext()` 打 `POST /api/debug-agent/scenarios` 播种、`POST /api/debug-agent/clock` 用 `unattended-turn` 把回合开着（该响应 await 在读数之后，别让它成为失败时的第一错误）；`page.routeWebSocket` 装分区夹具；`page.goto` 到会话。实现前该文件红 —— 不存在，且 `[data-activity-dock]` / `data-activity-state` 都不存在。
2. **登记两处。** `playwright.config.ts`：把 `'activity-dock-truthful.spec.ts'` 加进 `DEBUG_AGENT_SPEC_FILES`（注释写清与既有四条同一理由：同一 provider、同一控制面、同一 fixture home）；并在同一文件里为**这次选择**注入缩短心跳节拍与判定阈值的服务端环境变量（沿用 `QUAY_E2E_DEBUG_AGENT_HOME` 的 per-selection 写法）。
3. **坞构件。** `src/modules/chat/composer/ActivityIndicator.tsx`：加 `data-activity-dock` 与 `data-activity-state`；入参从「一个本地 `SessionActivity`」改成「本地活动 + 一条权威连接/新鲜度视图」；已用时间改走 `asOf - turn.startedAt`（unreachable 时冻结）；unreachable 时文案换成连接中断、六词一个不出现；停止控件 `disabled` 且带非空说明（`title` 与 `aria-describedby` 指向同一段文案）。移动内联出口同样接入，两种出口一套状态。
4. **组合层。** `ChatComposer.tsx` 与 `ChatMessagesPane.tsx` 把连接/新鲜度视图与不可达说明传进坞；`ChatComposer.tsx` 的 submit-as-stop 在不可达时同样 `disabled` 并讲同一句话。
5. **投影层。** 若 AC-183 导出的面不够坞用，**不要改 `src/modules/chat/utils/activityFreshness.ts`**（那条任务的文件，改它会撞在同一 AC 上），把坞需要的选择器放进新文件 `src/modules/chat/utils/activityDockView.ts`；坞要读的状态与文案类型加在 `src/shared/types.ts`。
6. **文案。** 连接中断、重连中、停止被禁用的原因三类新键加进 `src/modules/i18n/locales/*/chat.json` **全部 12 个**文件（`grep -c "claudeStatus"` 今天在每个 locale 各 1 命中，缺一个就会有 i18n 完整性判据红）。
7. **组件级单元判据（快速反馈）。** 新增 `src/modules/chat/tests/activityDockUnreachable.test.tsx`：喂 unreachable 视图 ⇒ `data-activity-state=unreachable`、六词一个不出现、停止控件 `disabled` 且说明非空；喂 in-turn 视图 ⇒ 相反（**正控制**，证明「无六词」不是因为构件根本不渲染文案）；用 `vi.useFakeTimers()` 做「间隔 ≥1s 两次读数的已用时间文本相等」。既有 `src/modules/chat/tests/activityIndicatorResponsive.test.tsx` 随属性变化同步更新。
8. **假形态（承重，先提交再变异，`git checkout -- <file>` 恢复，逐字登记变异 diff / 失败行 / 恢复命令）。** (i) 坞仍读本地 `processingSessions` 与本地计时器（把入参换回 `SessionActivity` + `Date.now()` 自增）⇒ 判据 (ii) 与 (iii) **必须红**；(ii) 把冻结改回本地自增（unreachable 期间仍走 1 秒 interval）⇒ (iii) **必须红**；(iii) unreachable 时停止控件不禁用 ⇒ (iv) **必须红**。若某条假形态没红，是判据有洞：先补判据（例如把两次读数的间隔加宽到足以让本地秒级自增必然跨过一秒边界），再继续。
9. **墙钟。** 用例自己记起止并断言**用例体** ≤ `20_000`ms，把读数打印成一行（`dock.wall=…ms`）；整次调用须在 `SINGLE_SPEC_CEILING_MS = 55_000`（`playwright.config.ts:317`）与 60 秒闸之内 —— §10.2 的整次运行实测 25 秒、用例体 21 秒且其中 12.5 秒是人为加的等待，去掉后有充足余量。
10. **静态门与对齐。** `npm run typecheck`、`npm run lint`、`npx vitest run src/modules/chat/tests/activityDockUnreachable.test.tsx` 均退出 0；新测试文件在 `src/modules/chat/tests/` 下（属 boundaries `include`），跨模块 import 一律走 barrel —— 本文件只引同模块深路径，若确需引别的模块，先把符号补进对方 `index.ts` 并写进 `## Touches`（见经验：新测试文件深引别的模块会让 `scripts/test.sh` 的 lint 阶段红，而 worker 只跑自己的 AC 命令时看不见）。`git diff --stat` 与 `## Touches` 逐条对齐。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` 退出 0，`--list` 列出该用例。红态基线：实现前 `ls e2e/activity-dock-truthful.spec.ts` → `No such file or directory`。
- [x] AC2 读数 (i)：分区**前** `[data-activity-dock]` 的 `data-activity-state` 是一个回合中状态（≠ `unreachable`），且坞内文本含回合进行中的证据。打印 `dock.state.before` 与 `dock.text.before` 两条原始读数。
- [x] AC3 读数 (ii)：阈值之后 `[data-activity-dock]` 的 `data-activity-state` 为 `unreachable`，且坞内文本**不含**六词中的任何一个（`Thinking` / `Processing` / `Analyzing` / `Working` / `Computing` / `Reasoning`，以及它们在 12 个 locale 文件里的取值）。打印 `dock.state.after` 与命中的词表（空才算过）。
- [x] AC4 读数 (iii)：间隔 **≥1000ms** 的两次读数，坞内已用时间文本**逐字相等**。打印两次读数与实测间隔 `dock.frozen.gap=…ms`、`dock.frozen.samples=[…]`。
- [x] AC5 读数 (iv)：停止控件在该状态下 `disabled`（逐字读 `disabled` 属性，不是读 class），且说明文字非空（打印 `dock.stop.disabled` 与 `dock.stop.reason`）；composer 的停止入口同时不可点。
- [x] AC6 读数 (v)：放行分区后**一个重连周期内**（§10.2 实测重连间隔 3.0 秒，取 ≤5000ms）回到回合中状态（`data-activity-state` ≠ `unreachable`），且已用时间由快照推算 —— 打印 `dock.recovered.elapsed` 与「若从重连时刻重新计时会得到的值」两个读数，断言前者不是后者。
- [x] AC7 墙钟：用例体实测 ≤ `20_000`ms（打印 `dock.wall=…ms`），整次调用在 55s/60s 闸内退出。
- [x] AC8 假形态必须红（承重）：(i) 坞仍读本地 `processingSessions` 与本地计时器 ⇒ AC3 与 AC4 红；(ii) 冻结改回本地自增 ⇒ AC4 红；(iii) unreachable 时停止控件不禁用 ⇒ AC5 红。逐条记录变异 diff、逐字失败行与恢复命令；任何一条没红按「判据有洞」处理，先补判据。
- [x] AC9 登记与静态门：`grep -n "'activity-dock-truthful.spec.ts'" playwright.config.ts` 命中 `DEBUG_AGENT_SPEC_FILES` 数组内，且缩短阈值只由该 spec 的选择注入（其他选择读到的服务端仍是出货默认值 —— 打印两种选择下的读数）；`npm run typecheck`、`npm run lint`、`npx vitest run src/modules/chat/tests/activityDockUnreachable.test.tsx` 均退出 0；`git diff --stat` 只落在 `## Touches` 列出的文件上（新增文件用 ASCII `(new)`）。

## DoD

- 判据驱动的是**真实服务端与真实应用**：坞的读数来自 `npx playwright test` 起的真实 webServer + Vite 客户端、真实调试 agent 回合、经 `page.routeWebSocket` 装在 app 自己那条 socket 上的分区。不接受 in-page 替身、不接受 stub 掉 socket、不接受由 spec 自己往 DOM 写 `data-activity-state`、不接受把 `[data-activity-dock]` 的读数换成读某个内部 React state。
- **阈值由服务端宣告并被客户端读取**：spec 里没有 `staleAfter` / `unreachableAfterMs` 的字面量；亚秒级只发生在 `playwright.config.ts` 为本次选择注入的服务端环境变量上；出货默认值 5000/15000（AC-182 的 AC6）不在本条的改动面内。
- **unreachable 时坞一个回合进行中的文案都不剩**：六词在 12 个 locale 里的取值一并被排除，不是只排英文。
- **计时冻结来自「计算里不出现本地时钟」**，不是把 interval 调大、也不是停掉 interval 后仍留着一个旧的 tick 值。
- 停止控件在不可达时不可操作且有可见原因；composer 的停止入口不得仍可点 —— 一个灰一个能点就是两个故事。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- `e2e/activity-dock-truthful.spec.ts` (new)
- `playwright.config.ts`
- `src/modules/chat/composer/ActivityIndicator.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/shared/types.ts`
- `src/modules/chat/hooks/useActivityFreshness.ts` (new)
- `src/modules/chat/utils/activityDockView.ts` (new)
- `src/modules/chat/tests/activityDockUnreachable.test.tsx` (new)
- `src/modules/chat/tests/activityIndicatorResponsive.test.tsx`
- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/locales/zh-TW/chat.json`
- `src/modules/i18n/locales/ja/chat.json`
- `src/modules/i18n/locales/ko/chat.json`
- `src/modules/i18n/locales/de/chat.json`
- `src/modules/i18n/locales/es/chat.json`
- `src/modules/i18n/locales/fr/chat.json`
- `src/modules/i18n/locales/it/chat.json`
- `src/modules/i18n/locales/id/chat.json`
- `src/modules/i18n/locales/ru/chat.json`
- `src/modules/i18n/locales/tr/chat.json`
- `tasks/gap-activity-dock-unreachable-degradation.md`（自触）

## 完成记录（worker，2026-10-02）

实现：`src/modules/chat/utils/activityDockView.ts`（纯选择器：state / 已用时间 / 停止可否操作）；`src/modules/chat/hooks/useActivityFreshness.ts`（把 AC-183 的状态机接到 app 自己的 socket：`chat_subscribed` hello 与 `activity.heartbeat` 心跳是唯一的新鲜证据；阈值用服务端在 hello 里宣告的 `unreachableAfterMs`；同一 bootId 下重连沿用它已锚定的回合起点，所以时钟是**续**不是重启；provider 帧的 `timestamp` 是消息产生时刻、不是服务端此刻，故意不计）。`ActivityIndicator` 发布 `data-activity-dock` / `data-activity-state` / `data-activity-elapsed-ms`；`ChatComposer` 的 submit-as-stop 与坞同一个读数、同一句话；12 个 locale 各加 `claudeStatus.unreachable.{title,stopReason}`。`playwright.config.ts` 把 spec 登进 `DEBUG_AGENT_SPEC_FILES`，并只在**本次选择**给服务端注入 `ACTIVITY_HEARTBEAT_INTERVAL_MS=300` / `ACTIVITY_UNREACHABLE_AFTER_MS=900`（出货默认 5000/15000 未动）。

判据绿（`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`，整次 23.1s，用例体 14.5s）：`dock.state.before=in-turn`、`dock.text.before="Thinking… 0s Stop esc"`、`dock.composer.stop.enabled.before=true`；`dock.shipped.intervalMs=5000`、`dock.shipped.unreachableAfterMs=15000`、`dock.server.unreachableAfterMs=900`；分区后 `dock.state.after=unreachable`、`dock.words.hit=[]`；`dock.frozen.gap=3110ms`、`dock.frozen.samples=["0s","0s"]`；`dock.stop.disabled=true`、`dock.stop.reason="Stop is unavailable while the server is unreachable"`、`dock.composer.stop.disabled=true`；放行后 `dock.recovered.elapsed=6611ms`（restart-would-be=0ms，gap=3149ms）`after=3324ms`；`dock.wall=14514ms`。`--list` 列出该用例。

静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅仓库既有 warning）；`npx vitest run src/modules/chat/tests/activityDockUnreachable.test.tsx` 2 passed（连同 `activityIndicatorResponsive.test.tsx` 共 11 passed）。

取假形态（逐条先提交（75a06bff）再变异，`git checkout -- <file>` 恢复；现已还原、`git status --porcelain` 为空）：
- (iii) `activityDockView.ts`：`-      stopDisabled: hasAbort,` → `+      stopDisabled: false,` ⇒ AC5 红：`e2e/activity-dock-truthful.spec.ts:392` `Error: expect(locator).toBeDisabled() failed / Expected: disabled / Received: enabled`。恢复：`git checkout -- src/modules/chat/utils/activityDockView.ts`。
- (ii) `useActivityFreshness.ts`：`-    elapsedMs: slot.machine.getElapsedMs(),` → `+    elapsedMs: snapshot.turnStartedAt === null ? null : Date.now() - snapshot.turnStartedAt,` ⇒ AC4 红：`e2e/activity-dock-truthful.spec.ts:388` `Error: the elapsed reading must not advance while unreachable / Expected: "1s" / Received: "2s"`（`dock.frozen.samples=["1s","2s"]`）。恢复：`git checkout -- src/modules/chat/hooks/useActivityFreshness.ts`。
- (i) 坞仍读本地表与本地钟：在 (ii) 之上再加 `-    liveness: snapshot.liveness,` → `+    liveness: 'fresh',` ⇒ AC3 红：`e2e/activity-dock-truthful.spec.ts:373` `Error: expect(locator).toHaveAttribute(expected) failed / Expected: "unreachable" / Received: "in-turn"`（本地计时那一路的 AC4 红已由 (ii) 单独证得）。恢复：`git checkout -- src/modules/chat/hooks/useActivityFreshness.ts`。