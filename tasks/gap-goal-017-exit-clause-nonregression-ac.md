---
id: gap-goal-017-exit-clause-nonregression-ac
title: GOAL-017 退出条件第 9 条（AC-106..111 与 GOAL-016 折叠不变量保持为绿）无在域 AC
  覆盖：提议新增一条把该回归门机械化的 AC，并登记两处范围欠账，交人裁定
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案（GOAL-017 充分性判官 verdict=insufficient，自 2026-10-03T16:34:11.861Z
    未变，见 .quay/goal-sufficiency-followup.json / goal-round.jsonl round
    456）：GOAL-017 退出条件第 9 条（AC-106..111 与 GOAL-016 折叠不变量保持为绿）无在域 AC
    覆盖。本任务只提议新增一条回归门 AC（暂记 AC-217）+ 登记两处范围欠账；须人裁定后由被授权的 goal 写入路径落地。本 agent 不改
    goals/*.md、不改任何 GOAL/AC 状态。
---
## Proposal

**未被覆盖的部分（逐字引用 —— GOAL-017 `## 退出条件` 的第 9 条，也是唯一没有在域 AC 对应的一条）：**

> 既有 AC-106 至 AC-111（贴底与跟随）与 GOAL-016 的折叠不变量保持为绿，由各自的判据判定，不在此重复；若本目标的实现使其中任何一条转红，视为本目标未达成。

**为何现有 AC 集不覆盖它（机械读数，不是推断）：**

- GOAL-017 的 `## 退出条件` 共 9 条：前 8 条逐字点名 AC-209…AC-216，与在域 AC 集合（8 条）一一对应；**只有第 9 条没有对应的在域 AC**。
- 在域 AC 的 8 条里，**没有任何一条**的 `title` 或 `expect` 断言 AC-106..AC-111 或 GOAL-016 的折叠判据（AC-202..AC-208）。AC-215 的 `expect` 只在散文里写了一句「AC-106 至 AC-111 各自的判据仍须为绿（由它们自己的 AC 判定，不在此重复）」，但 **AC-215 的 criterion 逐字只跑 `npx playwright test e2e/transcript-global-scrollbar.spec.ts -g "AC-215"`** —— 那句散文没有任何机械效力；GOAL-016 的折叠不变量则全篇未被提及。
- 判据（充分性判官）：`.quay/goal-round.jsonl` round 456（`2026-10-03T16:34:11.861Z`）的 `goal-sufficiency` 事实为 `{"goal":"GOAL-017","verdict":"insufficient"}`，reason 逐字 `sufficiency=insufficient（在域 AC 8 条）`；`.quay/goal-sufficiency-followup.json` 记 GOAL-017 的 `since=2026-10-03T16:34:11.861Z`、`filedAt=null`（本任务为首次跟进立案）。判官输入由 `goal-driver.js` 的 `buildSufficiencyPrompt()`（约 :56955）构造：**`## 退出条件` 全文 + `## 范围` 全文 + 在域 AC 的 id/title/expect**。8 条 AC 对 9 条退出条件，第 9 条必然被判为未覆盖。

**本提案（选 (a)：新增一条在域 AC，编号暂记 AC-217，由人裁定）。** 新增 `goals/AC-217-…md`（`goal: GOAL-017`、`kind: criterion`、`status: active`），把第 9 条逐字要求的两组不变量收进**一条可运行的回归门**：

criterion（逐字）:

```
for f in e2e/transcript-follow.spec.ts e2e/transcript-work-segments.spec.ts src/modules/chat/tests/workSegmentGrouping.test.ts src/modules/chat/tests/workSegmentLossless.test.tsx src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx src/modules/chat/tests/workSegmentAnchorStability.test.ts src/modules/chat/tests/transcriptExportWorkSegments.test.tsx src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/transcript-follow.spec.ts -g "AC-10[6-9]|AC-11[01]" && npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207" && npx vitest run src/modules/chat/tests/workSegmentGrouping.test.ts src/modules/chat/tests/workSegmentLossless.test.tsx src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx src/modules/chat/tests/workSegmentAnchorStability.test.ts src/modules/chat/tests/transcriptExportWorkSegments.test.tsx src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx
```

expect（逐字）: 在 GOAL-017 全部落地后的树上（自绘轨道 + 隐藏原生滚动条 + 绝对序号窗口 store + 前插锚点 + 增量缓存），把第 9 条逐字要求的两组不变量当一个回归门重跑：AC-106 至 AC-111（贴底与跟随，`e2e/transcript-follow.spec.ts`）与 GOAL-016 的折叠判据 AC-202 至 AC-208（其中 AC-207 为 e2e，其余六条为 vitest 文件）全部退出 0。这条 AC 是**绿先行**的守恒门（不是「文件不存在 ⇒ 红」的形态；两组判据此刻均绿，13 条 AC 在 `goals/` 的 status 逐条为 achieved）。**取假形态（证明门不是恒真，逐条实测并记录变异 diff 与逐字失败行，恢复后重新绿）**：(a) 用 `overflow:hidden` 或等价手段让转录滚动容器不可滚动 ⇒ AC-106/107/110/111 至少一条红；(b) 前插时不保持锚点（去掉可见位置的 1px 补偿）⇒ AC-106 或 AC-108 至少一条红；(c) 让折叠段选择器在窗口前插后重算边界（破坏段锚点）⇒ `workSegmentAnchorStability.test.ts`（AC-205）红。当前读数：两组判据现在**绿**；假形态的红落点须**实测**，不得写成推断。**运行预算**：本条把三段套件串成一个判据，其 runner 时限须大于三段之和（仓库默认 60s 门限不够，按先例把本 AC 的时限调到实测值以上），实测耗时须写进 Evidence。

**为何这样覆盖了第 9 条：** 第 9 条的两组不变量各自已被单独判定（AC-106..111 六条、AC-202..208 七条），本提案不重写它们的 expect，只把「GOAL-017 的改造不许让它们转红」这一句**机械化**：新 AC 的判据在 GOAL-017 的树上重跑那 13 条判据，任何一条转红这条新 AC 即红 ⇒ GOAL-017 未达成，与第 9 条逐字一致。

**顺带发现（登记供人裁定，不构成本条提案的第二项）：** 判官同时读 `## 范围` 全文。范围里有两处子项**在今天没有任何在域 AC 的 title/expect 覆盖**，若只补上面这一条 AC，判官可能仍判 `insufficient`：

1. 范围第 3 条的子项「**每个用户轮次一个刻度**」与「**悬停或聚焦出预览**」：AC-213 只断言「点击某一轮后目标落在视口内」，AC-214(d) 只断言**拖动滑块时**的预览气泡 —— 按轮次的刻度集与悬停/聚焦预览均无断言。
2. 范围第 4 条「**跳转路径复用并取代搜索跳转里『全量拉取再放宽窗口』的做法**」：AC-213 只断言轨道点击「不经过搜索」，**没有**任何 AC 断言搜索跳转被取代（今天 `src/modules/chat/hooks/useChatSessionState.ts` 的搜索跳转仍走 `sessionStore.fetchFromServer(id, { limit: null, offset: 0 })` 全量拉取 + 按 timestamp 放宽窗口，见 :1490-1590）。任务 `tasks/transcript-turn-rail-and-jump.md` 的 DoD 已计划抽 `jumpToMessage`，但**判据面（AC-213 的 expect）不含它**。

建议：人可把这两处**并入 AC-217**，或各立一条 AC；若明示不作退出条件，需在退出条件小节里显式登记（否则判官输入里它们仍是「未覆盖」）。

**为何选 (a) 而不是 (b)：** 第 9 条不是「写得比本目标该做的多」—— 它要求的正是本目标该保证的：GOAL-017 隐藏原生滚动条、把「后缀」模型换成绝对序号窗口、前插时保持锚点、缓存增量化，这些改造**恰是**最可能弄坏贴底/跟随与折叠锚点的。它是**本目标自己**的退出条件，缺的是在域 AC 覆盖，不是文本多余。故 (a)。

<!-- dedup-ref -->
**机制去重读数（本轮立案实测，读任务库与代码）：** `grep -rn "goal_ac: *AC-217" tasks/ goals/` → **0 命中**（AC-217 尚不存在）；`grep -rln "GOAL-017" tasks/*.md` → 只命中 `tasks/transcript-long-session-e2e-seed.md`（种子任务）与 8 条派工任务（`session-turn-outline-endpoint`=AC-209、`session-window-around-id-endpoint`=AC-210、`session-history-incremental-cache`=AC-211[done]、`session-store-window-model`=AC-212、`transcript-turn-rail-and-jump`=AC-213、`transcript-global-scrollbar-track`=AC-214、`transcript-hide-native-scrollbar`=AC-215、`transcript-prefetch-before-edge`=AC-216），**无一条**提议新增 AC 或改退出条件/范围文本，也**无一条**认领「不使 AC-106..111 / GOAL-016 折叠不变量转红」这一机制。⇒ 无在飞认领者，本条不是重复。那 8 条实现的是各自 AC 所测的机制，与本条（只提议新增一条回归门 AC，不写产品代码）机制不同。

## AC

- [x] AC1 **新 AC 记录落地且判据可跑**：`goals/AC-218-…md` 存在，`goal: GOAL-017`、`kind: criterion`、`status: active`，其 `criterion` 逐字为上面那条链式命令；在**改造前的树上**直跑该命令退出 0（13 条判据全绿），并把实际读数（每段命令的最后一行 + 退出码 + 实测耗时）逐条记录。
- [x] AC2 **回归门非恒真**：按 expect 的三条取假形态逐条变异并实测 —— 每条变异后判据命令必须退出非 0，且失败落在**被点名的那一条**；记录变异 diff、逐字失败行、恢复命令与恢复后重新绿。三条假形态全绿（未红）即本 AC 不满足。
- [x] AC3 **人（yale）已裁定并被记录**：本任务的 `## Resolution` 小节写明 (i) 是否采纳本提案（采纳 / 改措辞 / 不采纳并改走文本修订），(ii) 两处范围欠账（范围第 3 条的刻度/悬停预览；范围第 4 条的搜索跳转复用）各自的处理方式 —— **并入 AC-217 / 另立 AC 并给出 id / 明示不作退出条件并在退出条件小节登记**。二者缺一即本 AC 不满足。
- [ ] AC4 **退出条件第 9 条不再被判为未覆盖**：裁定落地后，`.quay/goal-round.jsonl` 中 GOAL-017 最新 `goal-sufficiency` 的 reason 必须**同时**满足三条 —— (a) verdict ∈ {`covered`, `insufficient`}（在域 AC 非空且有退出条件，机械层 `goalSufficiencyVerdict()` 不会短路，故 reason 应来自语义路径）；(b) reason 中**不含** `cause=`（`not-evaluated（cause=judge-unavailable）` 一样「不是机械短路形态」，会被一次 spawn 失败冒充）；(c) **正面控制** —— 由 `sufficiencyCacheKey(goal, inScopeAcs)` 算出的键存在于 `.quay/goal-sufficiency-cache.json`（只有真跑过判官才写缓存；立案时 GOAL-017 的旧键在缓存里，纳入 AC-217 后键会变）。命令打印该 goal 的 `goal-sufficiency` 序列最后两条与缓存键命中与否。（待外部）
- [x] AC5 **本任务未触及 Touches 之外的文件**：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都能对应到 Touches 内的一条；命中 Touches 之外时逐行打印并以非 0 退出。（⚠️ 用 merge-base 而非裸 develop；若该命令退化读空——见 GOAL-007 的实测教训——改用「逐提交列文件 + 确认提交都是 develop 的祖先」）。

## DoD

人工授权后，由**被授权的 goal 写入路径**（而非本 agent）真实创建 `goals/AC-218-…md`（`goal: GOAL-017`、`status: active`，criterion/expect 逐字如上，可能按裁定并入两处范围欠账）；并在其后的**真实 round log** 中观察到 GOAL-017 的 sufficiency verdict 不再恒为 `insufficient`（判官被实际咨询并给出结论）。**仅有 AC 记录创建而无后续 verdict 观察不算完成。**

承重性由三件事正面证明：

(a) **缺口被指名，不是猜的** —— 退出条件 9 条 vs 在域 AC 8 条，且 AC-209..216 的 title/expect 无一条断言 AC-106..111 / GOAL-016 折叠判据；AC-215 的散文提及在 criterion 里没有机械效力；
(b) **回归门真的会红** —— AC2 的三条假形态各自把被点名的那条判据打红（不是「文件不存在」式的红）；
(c) **两处范围欠账被显式登记**（AC3），不被一份「退出条件 = 8 条 AC 全列」的文本藏回去。

另需如实登记：本任务**不**让 AC-209..216 中任何一条转绿（它们的实现由那 8 条派工任务承担），也**不**改任何 GOAL/AC 状态。

本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态，不把任何 AC 标 achieved / active / draft / retired。

## Touches

- goals/AC-218-goal-017-既有贴底跟随与折叠不变量保持为绿.md (new)
- goals/GOAL-017-对话可跳到会话任意一轮-滚动条表示整段历史中的位置-加载在滚动时提前完成.md
- tasks/gap-goal-017-exit-clause-nonregression-ac.md

## Resolution

**⚠️ 编号更正（2026-10-04，管理者）**：本任务立案时把新 AC 暂记作 `AC-217`，但 `AC-217` 已于 2026-10-04T03:01 被一条**不同的** AC 占用（`goals/AC-217-刻度与滚动条的视觉形态-…md`，`yale-session` 创建）。故本任务落地时的编号为：**退出条件第 9 条的回归门 AC = `AC-218`**，**搜索跳转取代欠账 = `AC-219`**（`goals/` 现行最大编号为 AC-217）。下文（含 AC1 / DoD / Touches）已按此更正；Proposal 里的「暂记 AC-217」保留为立案当时的事实。

**人 yale 裁定（2026-10-04，经管理者会话下达）—— 逐条对应本任务 AC3 的两项要求。**

### (i) 本提案：采纳 (a)，但改措辞立 AC，附三条约束

- **为什么必须立 AC（结构性，不是文本洁癖）**：GOAL-017 的 `## 退出条件` 共 9 条，前 8 条逐字点名 AC-209…AC-216，第 9 条是它**自己的反回归条款**却在域 AC 为空。判官输入 = 退出条件全文 + 范围全文 + 在域 AC 的 id/title/expect ⇒ 8 对 9，第 9 条**必然**判 `insufficient`，GOAL-017 **永远无法判 `covered`**。而第 9 条要求的恰好是本目标最可能弄坏的不变量（隐藏原生滚动条、绝对序号窗口、前插锚点、增量缓存 对 贴底/跟随/折叠锚点）。⇒ 立 AC，**不**改退出条件文本。
- **约束 1（判据瘦身，时限按实测）**：AC-218 的 criterion 不得把「2 条 playwright `-g` 过滤 + 1 条 playwright + 6 条 vitest」直接串成一条链就交付。这是一条**常驻绿门**、每轮重跑，而 e2e 腿在舰队负载下会 flake（`ac-criterion-fleet-red-is-one-resource-per-task`）—— 一条会 flake 的绿门会**稳定地**污染 GOAL-017 的判定。能下沉到 vitest 的不变量必须下沉；e2e 只保留真正 e2e-only 的那条；该 AC 的时限须设在实测耗时之上。
- **约束 2（明写是守恒门）**：AC-209…AC-216 尚未全绿（AC-214 刚 ready、AC-215 todo），所以 AC-218 的绿是**当下瞬间成立、落地后仍须绿**。这句话必须写进 `expect`，否则判官会把它读成「又一个待实现项」。
- **约束 3（假形态必须实测）**：提案 expect 里的三条取假形态 (a)(b)(c) 必须逐条变异并实测，记录变异 diff、逐字失败行与恢复命令。一条**恒真**的绿门是这类 AC 唯一的失败形态。

### (ii) 两处范围欠账的处置

- **欠账①（每用户轮次一个刻度 / 悬停或聚焦预览）—— 不并入 AC-218，且大部分已落在既有判据面上**：
  - 「每个用户轮次一个刻度」**已被 AC-213 的判据覆盖**：`e2e/transcript-jump-to-turn.spec.ts` 有 `tickFor(page, turnId)` 与断言 `the rail must offer the first turn`。
  - 「悬停/聚焦预览」落在 **AC-214**（`tasks/transcript-global-scrollbar-track`，status ready）的判据面里（其 Proposal 明写拖动期间的预览气泡）⇒ 由 AC-214 落地时在其 spec 内补断言，**不另立 AC**。
- **欠账②（搜索跳转复用并取代「全量拉取再放宽窗口」）—— 另立一条 AC，建议编号 `AC-219`**。AC-213 的 spec 只在注释里写了「The rail and the sidebar search share one id-addressed jump」，**没有任何断言**。「既有不变量保持绿」（AC-217）与「新增能力被取代」（AC-218）是两种机制，混在一条会让失败归因变糊。
- 裁定后 GOAL-017 的在域 AC 集合 = AC-209…AC-217 + AC-218 + AC-219：退出条件第 9 条由 **AC-218** 承载；范围第 3 条的刻度/预览由 **AC-213 / AC-214** 承载；范围第 4 条的搜索跳转取代由 **AC-218** 承载。四者都在判官输入里可见。

### 授权与边界

本记录只登记人的裁定，**不**创建 `goals/AC-218-*.md` / `goals/AC-219-*.md`，不改任何 GOAL/AC 状态，不改 GOAL-017 的退出条件文本。AC-217 与 AC-218 的创建由**被授权的 goal 写入路径**执行；本任务 AC1 要求 AC-217 的判据在当前树上可跑并给出红态/绿态读数，AC4 要求在其后的真实 round log 中观察到 GOAL-017 的 `goal-sufficiency` verdict 不再恒为 `insufficient`。

## Evidence

**2026-10-04（worker，worktree `gap-goal-017-exit-clause-nonregression-ac`）—— AC1 / AC2 / AC5 实测**

**AC1 落地与绿先行读数**
- `goals/AC-218-goal-017-既有贴底跟随与折叠不变量保持为绿.md` 由 goal-store ABI 创建（`quay goal batch`，commit `67e2db0f`；文件名改回 `## Touches` 声明的路径，commit `42188ddc`），`goal: GOAL-017`、`kind: criterion`、`status: active`。
- criterion（逐字）：存在性闸（8 个被点名文件）+ `npx vitest run <6 折叠文件>` + `npx playwright test e2e/transcript-follow.spec.ts e2e/transcript-work-segments.spec.ts -g "AC-106|AC-107|AC-108|AC-110|AC-111|AC-207"`。
- 绿先行读数（本 worktree，冷 vite 缓存）：vitest `Test Files 6 passed (6) / Tests 28 passed (28)`；playwright `6 passed (39.0s)`；整条 criterion `WALL=43.03s`，`CRITERION_RC=0`。
- **预算（关键约束）**：goal 判据门是**硬编码 60s 且本仓不可调**（四个调用点显式传 6e4，`QUAY_ACCEPTANCE_TIMEOUT_MS` 在 goal 路径不被读；见 memory `goal-criterion-gate-hard-60s-timeout`）。故 Resolution「时限调到实测值以上」在本仓不可实现，只能把 criterion 收进 60s。实测**完整 13 条**（6 条 follow e2e + AC-207 e2e + 6 条 vitest）为 **58.1s**（follow 47.8s + AC-207 7s + vitest 3.3s），仅 ~2s 余量、舰队负载下必 flake —— 故按 Resolution 约束 1 瘦身：保留 5/6 条 follow（AC-106/107/108/110/111）+ AC-207 + 6 条 vitest = 43s（~28% 余量）；**AC-109（贴底期间小幅手势脱离，实测 15s，六条中最重）未入链式判据**，由它自身的 AC 判据判定（驱动 I5 每轮重跑）。
- 并发不可用：设 `--workers=2` 跑两 spec 触发 `SqliteError: cannot start a transaction within a transaction`（一 run 一 DB 两 spec 陷阱）；`--workers=3` 被 config 的 `workers:1` 覆盖（仍打印 `using 1 worker`）——故 e2e 只能串行、~39s 是地板。

**AC2 三条取假形态（逐条变异 → 实测红 → 恢复 → 重新绿）**
- (a) **让转录滚动容器不可滚动** —— 变异：`src/modules/chat/transcript/ChatMessagesPane.tsx` 的 className 里 `overflow-y-auto overflow-x-hidden` → `overflow-hidden`。读数：criterion `RC=1`，红落在 **AC-106**（`e2e/transcript-follow.spec.ts`，10.0s），逐字失败行 `Error: the pane never reached the state this gesture was for (deltaY=-700)`。恢复：`git checkout -- src/modules/chat/transcript/ChatMessagesPane.tsx`。
- (b) **去掉跟随的 1px 容差补偿** —— 变异：`src/modules/chat/hooks/useChatSessionState.ts` 的 `const TRANSCRIPT_FOLLOW_TOLERANCE_PX = 1;` → `= 100000;`。读数：criterion `RC=1`，红落在 **AC-106**（1.1s），逐字失败行 `Error: a pinned transcript must stay on the bottom when the last row grows; it sat 480px above it`。恢复：`git checkout -- src/modules/chat/hooks/useChatSessionState.ts`。
- (c) **让折叠段选择器随段增长重铸锚点** —— 变异：`src/modules/chat/utils/workSegments.ts` 的 `key: getIntrinsicMessageKey(message),` → `key: \`${getIntrinsicMessageKey(message)}:${members.length}\``。读数：criterion `RC=1`，红落在 **AC-205**（`src/modules/chat/tests/workSegmentAnchorStability.test.ts`），逐字失败行 `AssertionError: append #1 must not re-mint the tail anchor`（另两条同文件用例亦红：`the anchor must be the first member's intrinsic key`）。恢复：`git checkout -- src/modules/chat/utils/workSegments.ts`。
- **criterion 顺序说明**：把 vitest 放在 playwright 之前，(c) 才会红在**被点名的 AC-205**（若 playwright 在前，同一变异会先红在 AC-207、vitest 永不被跑到）；(a)(b) 不影响 vitest，仍红在 follow e2e。
- **恢复后重新绿**：三条变异全部 `git checkout --` 复原、`git status --porcelain` 为空后重跑 criterion → `RC=0`，playwright `6 passed (39.0s)`、vitest `28 passed`。分支上三个提交（`67e2db0f` / `42188ddc` / `053919cf`）只触及 `goals/AC-218-…md`。

**AC4 —— 待外部（本条自身不可能满足）**
- AC4 要求裁定落地后 GOAL-017 最新 `goal-sufficiency` 的 reason 满足三合取，且 `sufficiencyCacheKey(goal, inScopeAcs)`（含 AC-218 的 10 条在域 AC）存在于 `.quay/goal-sufficiency-cache.json`。两者都只在 **AC-218 进入 develop（或 main checkout 的 goals/）之后**由 goal-driver 跑出的一轮里产生：缓存与 `goal-round.jsonl` 都是 gitignored 的驱动产物，本 worker 的 worktree 内无 goal-driver；且 `goal-round.jsonl` 现停在 round 538（2026-10-04T03:56Z），8 小时无新轮。故如实标 `（待外部）`，与 DoD「仅有 AC 记录创建而无后续 verdict 观察不算完成」一致。

**AC5 Touches**
- `git diff --name-only "$(git merge-base develop HEAD)"` 读数逐行对应 `## Touches`：`goals/AC-218-goal-017-既有贴底跟随与折叠不变量保持为绿.md`（new）与 `tasks/gap-goal-017-exit-clause-nonregression-ac.md`（本次 tick）。三条 e2e/vitest 变异均只在工作区、未提交，复原后 `git status` 为空；未触及 `## Touches` 之外的文件。

**未做（如实登记）**
- 未创建 `goals/AC-219-…md`（Resolution (ii) 的搜索跳转取代欠账）：AC-219 不在本任务 `## Touches`，AC1 只点名 AC-218，AC5 逐字禁止触及 Touches 之外的文件；Resolution 自身也写「AC-217 与 AC-218 的创建由被授权的 goal 写入路径执行」（其 (ii) 内部对「另立 AC-219」与「由 AC-218 承载」两说并存）。AC-219 应由后续的 goal 写入路径或另立任务落地。
- 未改任何 `goals/*.md` 的其它记录、未改任何 GOAL/AC 状态、未改 GOAL-017 的退出条件文本（AC-218 自身记录除外，那是本任务的交付物/AC1）。
