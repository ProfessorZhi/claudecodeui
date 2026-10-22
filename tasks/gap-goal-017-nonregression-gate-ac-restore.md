---
id: gap-goal-017-nonregression-gate-ac-restore
title: GOAL-017 退出条件末条（AC-106..111 与 GOAL-016 折叠不变量保持为绿）的在域 AC 因 AC-218
  被改用为拖动滚动条判据而丢失：提议新建 AC-220 恢复该回归门，交人裁定
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案（GOAL-017 充分性判官最新 verdict=insufficient，见
    .quay/goal-sufficiency-followup.json
    since=2026-10-04T06:24:56.098Z）：退出条件末条（AC-106..111 与 GOAL-016 折叠不变量保持为绿）无在域
    AC。该条曾由 AC-218 承载（commit 053919cf，期间 verdict=covered，rounds 544–553 /
    2026-10-04T04:35–05:45Z），但 AC-218 于 2026-10-04T05:53Z 被改写为拖动滚动条判据（commits
    d4647214/ba457cf5），该覆盖随之丢失，verdict 在 round 556（06:10Z）/558（06:24Z）回到
    insufficient。本任务只提议新建 AC-220 恢复该回归门；须人裁定后由被授权的 goal 写入路径落地。本 agent 不改
    goals/*.md、不改任何 GOAL/AC 状态。
---
## Proposal

**未被覆盖的部分（逐字引用 —— GOAL-017 `## 退出条件` 的最后一条，也是当前唯一没有在域 AC 对应、且唯一不以 `AC-2XX：` 开头的一条）：**

> 既有 AC-106 至 AC-111（贴底与跟随）与 GOAL-016 的折叠不变量保持为绿，由各自的判据判定，不在此重复；若本目标的实现使其中任何一条转红，视为本目标未达成。

它承载的是标题里「本目标的改造不许把既有的贴底/跟随与折叠不变量弄红」这一条退出要求（标题逐字：`对话可跳到会话任意一轮，滚动条表示整段历史中的位置，加载在滚动时提前完成`；该改造（隐藏原生滚动条、把「后缀」store 换成绝对序号窗口、前插锚点、缓存增量化）恰是最可能弄坏这两组不变量的）。

**为何现有在域 AC 集不覆盖它（机械读数，不是推断）：**

- 当前 `goals/GOAL-017-…md` 的 `## 退出条件` 共 **12 条**：前 11 条逐字以 `AC-209：`…`AC-219：` 开头，第 12 条（上面引用那条）**没有 AC 号**。
- 在域 AC 集 = `goals/` 中 `goal: GOAL-017` 的记录 = **AC-209 … AC-219（11 条）**，现行最大编号为 AC-219。逐条抽取 `criterion:` 实测：**每一条的 criterion 只跑它自己的一个 spec/测试文件**（AC-209/210/211 走 `server/.../tests/*.test.ts`，AC-212 走 `sessionStoreWindow.test.ts`，AC-213 `transcript-jump-to-turn.spec.ts`，AC-214/215 `transcript-global-scrollbar.spec.ts`，AC-216 `transcript-prefetch.spec.ts`，AC-217 `transcript-rail-geometry.spec.ts`，AC-218 `transcript-scrub-smooth.spec.ts`，AC-219 `transcript-scrollbar-native-length.spec.ts`）。**没有任何一条**重跑 AC-106..111 或 GOAL-016 的折叠判据（AC-202..208）。AC-215/AC-218 的 `expect` 只在散文里提「AC-106 至 AC-111 各自的判据仍须为绿」，其 criterion 里没有机械效力。
- **决定性实测证据（同一机制的得而复失）**：AC-218 **曾经就是**这条回归门 —— commit `053919cf` 上其 title 逐字为「GOAL-017 退出条件第 9 条：既有 AC-106..111（贴底与跟随）与 GOAL-016 折叠不变量（AC-202..208）保持为绿（回归门）」，criterion 逐字重跑 follow + work-segments + 6 个 vitest 文件。在它存在期间，`.quay/goal-round.jsonl` 里 GOAL-017 的 `goal-sufficiency` 事实读数为 **`covered`**（round 544 起，2026-10-04T04:35–05:45Z 多轮）。随后 AC-218 于 **2026-10-04T05:53Z** 被改写为拖动滚动条判据（commits `d4647214` / `ba457cf5`），该覆盖随之消失，verdict **立即**回到 **`insufficient`**：round 556（06:10Z）、round 558（06:24Z）。`.quay/goal-sufficiency-followup.json` 现记 GOAL-017 `since=2026-10-04T06:24:56.098Z`、`filedAt=null`。⇒ 这条未覆盖的退出条件就是 `insufficient` 的**充分且直接**的原因，不是猜测。

**本提案（选 (a)：新增一条在域 AC，编号 AC-220，由人裁定）。** 新建 `goals/AC-220-goal-017-既有贴底跟随与折叠不变量保持为绿-回归门.md`（`goal: GOAL-017`、`kind: criterion`、`status: active`），把末条逐字要求的两组不变量收进**一条可运行的回归门**（criterion 沿用此前实测通过、且曾把判官翻回 `covered` 的版本）：

criterion（逐字）:

```
for f in e2e/transcript-follow.spec.ts e2e/transcript-work-segments.spec.ts src/modules/chat/tests/workSegmentGrouping.test.ts src/modules/chat/tests/workSegmentLossless.test.tsx src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx src/modules/chat/tests/workSegmentAnchorStability.test.ts src/modules/chat/tests/transcriptExportWorkSegments.test.tsx src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx vitest run src/modules/chat/tests/workSegmentGrouping.test.ts src/modules/chat/tests/workSegmentLossless.test.tsx src/modules/chat/tests/workSegmentExpansionPersistence.test.tsx src/modules/chat/tests/workSegmentAnchorStability.test.ts src/modules/chat/tests/transcriptExportWorkSegments.test.tsx src/modules/chat/tests/workSegmentCollapsedTitle.test.tsx && npx playwright test e2e/transcript-follow.spec.ts e2e/transcript-work-segments.spec.ts -g "AC-106|AC-107|AC-108|AC-110|AC-111|AC-207"
```

expect（逐字）: 在 GOAL-017 全部落地后的树上（自绘轨道 + 隐藏原生滚动条 + 绝对序号窗口 store + 前插锚点 + 增量缓存），把末条逐字要求的两组不变量当一个**回归门**重跑：AC-106 至 AC-111（贴底与跟随，`e2e/transcript-follow.spec.ts`，AC-109 因耗时未入链、由其自身 AC 判定）与 GOAL-016 的折叠判据 AC-202 至 AC-208（AC-207 为 e2e，其余六条为 vitest 文件）全部退出 0；任何一条转红 ⇒ GOAL-017 未达成。这条 AC 是**绿先行**的守恒门（两组判据此刻均绿：8 个被点名文件全在、AC-106..111 与 AC-202..208 的 `goals/` status 逐条 achieved），不是「文件不存在 ⇒ 红」的形态。**取假形态（证明门不是恒真；逐条变异 → 实测红 → 恢复 → 重新绿，记录变异 diff、逐字失败行、恢复命令）**：(a) 让转录滚动容器不可滚动（`overflow-hidden`）⇒ follow e2e 至少一条（AC-106）红；(b) 去掉跟随的 1px 容差补偿 ⇒ AC-106 红；(c) 让折叠段选择器随段增长重铸锚点 ⇒ `workSegmentAnchorStability.test.ts`（AC-205）红。**运行预算**：本仓 goal 判据门硬编码 60s 且不可调（四个调用点显式 6e4），此 criterion 此前实测 `WALL=43.03s / RC=0`（vitest 28 passed；playwright 6 passed 39.0s），约 28% 余量；须以该实测值为准，不得再叠加。

**为何这样覆盖了末条：** 末条的两组不变量各自已被单独判定（AC-106..111 六条、AC-202..208 七条），本提案不重写它们的 expect，只把「GOAL-017 的改造不许让它们转红」这一句**机械化**：AC-220 的判据在 GOAL-017 的树上重跑那两组判据，任何一条转红 AC-220 即红 ⇒ GOAL-017 未达成，与末条逐字一致。这正是 AC-218 曾经提供、并且实测把判官翻回 `covered` 的机制。

**为何选 (a) 而不是 (b)：** 末条不是「写得比本目标该做的多」—— 它要求的正是本目标该保证的反回归，缺的是在域 AC 覆盖（一个 AC 号），不是文本多余。此前人 yale 已就同一条裁定过「立 AC，**不**改退出条件文本」（见已完成的 `gap-goal-017-exit-clause-nonregression-ac` 的 Resolution(i)）；该裁定在本仓已被一次实测证明有效（`covered`），只是承载它的 AC-218 号随后被另一条退出条件（拖动滚动条）占用，覆盖静默丢失。故本次同样选 (a)：**再立一条 AC**。

**防复发（建议随裁定一并处理，属注解、不削弱文本）**：退出条件末条是 12 条里**唯一不以 `AC-2XX：` 开头**的一条，这正是它会被静默丢失的形态。建议裁定采纳时，给该条加前缀 `AC-220：`（使其与其余 11 条形制一致、把编号显式钉住）。此前 `covered` 读数是在**没有**该前缀的情况下出现的（判官按语义匹配），故前缀非必需；但加上它可让「该条由哪条 AC 承载」不再依赖语义推断，也能防止 AC-220 再被别的退出条件复用一个新号。

**顺带发现（登记供人裁定，不构成本条提案第二项）：** 判官输入同时含 `## 范围` 全文。`## 范围` 第 4 条「跳转路径复用并取代搜索跳转里『全量拉取再放宽窗口』的做法」目前**没有任何在域 AC 的 title/expect 断言**（AC-213 的 spec 仅在注释写「The rail and the sidebar search share one id-addressed jump」，无断言；`src/modules/chat/hooks/useChatSessionState.ts` 的搜索跳转仍走 `fetchFromServer(id, {limit:null, offset:0})` 全量拉取）。此前 `covered` 读数出现时该项亦未被覆盖，故它**不是**当前 `insufficient` 的决定因素；但它是一处真实的判据面欠账，建议人裁定：另立一条 AC，或明示不作退出条件。

<!-- dedup-ref -->
**机制去重读数（本轮立案实测，读任务库与代码）：** `task_list --search GOAL-017` 只返回两条且**均 done** —— 本主题的既往跟进任务 `gap-goal-017-exit-clause-nonregression-ac`（status: done）与种子任务 `transcript-long-session-e2e-seed`（status: done）；`grep -rln GOAL-017 tasks/*.md` 无第三条；`grep -rln 'AC-220|AC-221' tasks/ goals/` → 0 命中。既有 8 条派工任务（AC-209..AC-216 各一条）实现的是各自 AC 所测的产品机制，**无一条**提议新增 AC / 改退出条件文本，也**无一条**认领「不使 AC-106..111 / GOAL-016 折叠不变量转红」这一回归门机制。⇒ 无在飞认领者，本条不是重复：`gap-goal-017-exit-clause-nonregression-ac` 已 done 且其交付物（AC-218 回归门）已被后续改写覆盖，需要的是**新号 AC-220**，不是重开旧任务。

## AC

- [x] AC1 **人（yale）已裁定并被记录**：本任务 `## Resolution` 小节写明 (i) 是否采纳本提案（新建 AC-220 恢复回归门），(ii) 是否给退出条件末条加 `AC-220：` 前缀（加 / 不加并说明），(iii) 顺带发现的范围第 4 条欠账如何处置（另立 AC 并给出 id / 明示不作退出条件并在退出条件小节登记）。三者缺一即本 AC 不满足。（待外部 —— 只能由人写入）
- [x] AC2 **新 AC 记录落地且判据可跑**：`goals/AC-220-goal-017-既有贴底跟随与折叠不变量保持为绿-回归门.md` 由**被授权的 goal 写入路径**创建（`goal: GOAL-017`、`kind: criterion`、`status: active`），其 `criterion` 逐字为 Proposal 里的链式命令；在**改造后的树上**直跑该命令退出 0，并把实际读数（每段命令最后一行 + 退出码 + 实测耗时，须 < 60s 硬门）逐条记录。（待外部 —— 只能由 goal 写入路径创建，执行者不得代写）
- [x] AC3 **回归门非恒真**：按 expect 的三条取假形态逐条变异并实测 —— 每条变异后判据命令必须退出非 0，且失败落在**被点名的那一条**（(a)(b)→AC-106，(c)→AC-205）；记录变异 diff、逐字失败行、恢复命令与恢复后重新绿。三条假形态全绿（未红）即本 AC 不满足。（待外部 —— 须 AC2 落地后）
- [x] AC4 **判官判决不再恒为未覆盖**：AC-220 进入 develop（或 main checkout 的 `goals/`）后的**真实 round log** 里，GOAL-017 最新 `goal-sufficiency` 必须满足：verdict ∈ {`covered`, `insufficient`}（来自语义路径，非机械短路）、reason 不含 `cause=`、且由 `sufficiencyCacheKey(goal, inScopeAcs)`（含 AC-220 的 12 条在域 AC）算出的键命中 `.quay/goal-sufficiency-cache.json`。命令打印该 goal 的 `goal-sufficiency` 序列最后两条与缓存键命中与否。（待外部 —— 只能由 goal-driver 后续轮次产生）

## DoD

人工授权后，由**被授权的 goal 写入路径**（而非本 agent）真实创建 `goals/AC-220-goal-017-既有贴底跟随与折叠不变量保持为绿-回归门.md`（`goal: GOAL-017`、`status: active`，criterion/expect 逐字如上；建议同时给退出条件末条加 `AC-220：` 前缀）；并在其后的**真实 round log** 中观察到 GOAL-017 的 `goal-sufficiency` verdict **不再恒为 `insufficient`**（判官被实际咨询并给出结论）。**仅有 AC 记录创建而无后续 verdict 观察不算完成。**

承重性由三件事正面证明：

(a) **缺口被指名，不是猜的** —— 退出条件 12 条 vs 在域 AC 11 条；末条无 AC 号且 AC-209..219 的 criterion 无一条重跑 AC-106..111 / AC-202..208；
(b) **机制已被实测验证过** —— 同一份 criterion 由 AC-218 承载期间 verdict 读 `covered`（rounds 544–553），AC-218 被改写后 verdict 回 `insufficient`（rounds 556/558），得而复失都可归因；
(c) **回归门真的会红** —— AC3 的三条假形态各自把被点名的那条判据打红（不是「文件不存在」式的红）。

另需如实登记：本任务**不**让 AC-209..219 中任何一条转绿（它们的实现由各自派工任务承担），也**不**改任何 GOAL/AC 状态。本任务由跟进 agent 只提议：不改 `goals/*.md`、不改任何 GOAL/AC 状态、不把任何 AC 标 achieved / active / draft / retired。

## Touches

- goals/AC-220-goal-017-既有贴底跟随与折叠不变量保持为绿-回归门.md (new)
- goals/GOAL-017-对话可跳到会话任意一轮-滚动条表示整段历史中的位置-加载在滚动时提前完成.md
- tasks/gap-goal-017-nonregression-gate-ac-restore.md

## Resolution

**人 yale 2026-10-04 裁定（经 outer 会话记录）：任务关闭 —— 提案已被采纳并以 AC-222 / AC-223 落地，无需新号 AC-220。**

(i) **是否采纳本提案（新建在域回归门 AC 承载 GOAL-017 退出条件末条）：采纳。** 该回归门已由被授权的 goal 写入路径落地为 **AC-222**（`goals/AC-222-goal-017-退出条件第-9-条-….md`，`goal: GOAL-017`、`kind: criterion`、`status: achieved`，criterion pass 于 2026-10-04T07:57:44.737Z，actor `goal-driver`）。**编号非本提案暂记的 AC-220** —— AC-220 与 AC-221 已被另外两条退出条件占用，故按机制以 AC-222 重建该回归门；不改行文、不重开旧任务。AC-222 的 `origin:` 逐字记录了本次裁定，并附三条约束（判据瘦身 + 时限按实测 / 明写是守恒门 / 三条假形态必须实测）。criterion 与 expect 逐字取自本提案 Proposal 一节。

(ii) **是否给退出条件末条加前缀：加。** GOAL-017 `## 退出条件` 末条现逐字以 `AC-222：` 开头，与其余 11 条形制一致；「该条由哪条 AC 承载」不再依赖语义推断。

(iii) **顺带发现的范围第 4 条欠账（搜索跳转复用并取代「全量拉取再放宽窗口」）：另立 AC 并已落地。** 已建 **AC-223**（`status: achieved`），由任务 `gap-ac223-search-jump-reuses-id-window`（done）实现：搜索跳转走与轨道点击同一条 id 寻址窗口读，不再整段拉取。

**机械读数（裁定落地后实测）：** GOAL-017 的 `goal-sufficiency` 自 round 570（2026-10-04T08:03:48Z）起为 `covered`，至 round 576（2026-10-04T08:52:25Z）连续为 `covered`；此前 round 556 / 558 / 562 / 564 / 566 为 `insufficient`。`.quay/goal-sufficiency-followup.json` 的 `entries` 已为空。末条的得而复失与本次重得两端均可归因：AC-218 于 2026-10-04T05:53Z 被改用途 ⇒ verdict 回 `insufficient`；AC-222 于 07:47Z 激活、07:57Z achieved ⇒ verdict 回 `covered`。

**本任务不落地任何 goals/ 文件、不改任何 GOAL/AC 状态**：AC-222 与 AC-223 的创建由被授权的 goal 写入路径执行，本任务的 `## Touches` 中 `goals/AC-220-…md (new)` 因此从未创建 —— 实际承载者是 AC-222，如实登记，不追改 Touches（本任务不产出该文件）。