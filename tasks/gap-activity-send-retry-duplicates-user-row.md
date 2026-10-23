---
id: gap-activity-send-retry-duplicates-user-row
title: AC-185 重发产生两条同文用户消息：转写层 optimistic local-echo 未被 persisted echo 退休（判据
  e2e/activity-dock-truthful.spec.ts:814 transcript.userRows=[2]），GOAL-014 记
  done-unresolved
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**来源**：AC-185 的判据现在真的会跑到断言（启动守卫已落地），于是暴露一个真实的产品缺陷 —— 重发产生**两条**同文用户消息，正是 AC-185 白纸黑字禁止的形态。AC-185 因此卡在台账 `{"ac":"AC-185","state":"done-unresolved"}`。

**证据（本轮 2026-10-02 直跑，逐字，非台账尾巴）。**

- 命令（AC-185 判据，逐字）：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"`
- 读数：`1 failed`，两次独立串跑均复现（确定性）。
- 逐字读数：`transcript.userRows=[2]`
- 失败断言 `e2e/activity-dock-truthful.spec.ts:814`：
  `expect(userRows, 'the retried text is exactly one user row, never two').toBe(1);`
  → `Expected: 1` / `Received: 2`
- AC-185 题面：「发送时服务端不可达：5 秒内坞说明发送失败，不在本地标成回合中，草稿不丢，重发不产生重复用户消息」。实现满足了坞与草稿两半，重发这一半产生了重复用户消息 —— 恰是 AC 禁止的那一条。

**为什么现在才浮出来（归因，不是本任务造成）。** 该判据以前在任何断言之前就死在 `Timed out waiting 30000ms from config.webServer`，因为 `e2e/activity-dock-truthful.spec.ts` 没有有界启动守卫。守卫已落地（`gap-activity-dock-truthful-criterion-bounded-boot-guard`，status done，2026-10-02T09:16Z；spec 现有 `warmClientStartup`×4、`navigateBounded`×6）。守卫没有造成这个缺陷，它只是移除了掩盖缺陷的那层东西。同一份 spec 的 AC-188 落守卫后已翻 achieved，说明守卫本身有效 —— AC-185 是那个**还剩下真实缺陷**的。

**机制（诊断读数钉死，非猜测）。** 判据红态下在 `computeMerged` / `removeOptimisticUserEchoes` 加临时诊断，逐字读数：

`[DIAG-MERGE-IN] {"server":[],"realtime":[{"id":"local_1790934624375_duagna",...},{"id":"6915f537-e4c8-43a4-881d-691484dff17d_text_0",...}]}`
`[DIAG-RECON] {"localId":"local_1790934624375_duagna","matched":null,"serverCandidates":[]}`

- 重发路径把**同一条** optimistic local row 放回（`useChatComposerState.ts` 的 `restoreUserTurn` + 复用 `undeliveredTurnRef.current.id`），客户端只有一条 local 行 —— 这一点实现是对的。
- 合并路径 `removeOptimisticUserEchoes(serverMessages, realtimeMessages)` **只在 `serverMessages`（REST 历史页）里找 echo**；而服务端把用户自己的 persisted turn 先经 socket 推回来，它落在 `realtimeMessages` 里（id 形如 `<uuid>_text_0`，非 `local_`）。诊断读数里 `server: []`、echo 就在 realtime 里 ⇒ 配对谓词看不到它，optimistic local 行永不退休，与它的 persisted 副本并排画出两行。**修的是这个配对谓词。**

**不是重复（去重读数）。** `task_get gap-activity-send-retry-duplicates-user-row` → not found；`task_list search "duplicate user message" / "local-echo" / "userRows" / "retry duplicates" / "transcript dedup" / "persisted echo"` → **0 命中**。本仓已有三条**白纸黑字把这一格让出去**的旁证，无一条认领此修复：`gap-activity-send-unreachable-draft-retry`（AC-185 实现，status done）明写「两行来自转写层 local-echo↔persisted 去重失败…**非本任务写面**」，其 AC4 已记 `transcript.userRows=[2]`；`gap-activity-dock-truthful-criterion-bounded-boot-guard`（status done）在 AC4 明写「AC-185 判据…以 `transcript.userRows=[2]` 恒红，属既有内容缺陷、非本任务…翻绿**待外部修复**」；`gap-activity-single-dock-global-consistency`（AC-188）Falsification record 把同一条登记为与本任务无关的既存红。⇒ 无认领者、无重复。

**要做的事。** 在**生产代码**里修，使一次被重发的发送在转写里**恰好剩一条**该文本的用户行。**不动**判据里那条 `expect(userRows …).toBe(1)`，**不删/不弱化**它。

## Plan

1. **先复现、再钉因。** 跑判据取 `transcript.userRows=[2]` 红态；在合并/退休路径加一次临时诊断，对重发文本逐字打印：realtime 行 id、各行的 `replacesAfterRowCount`、时间戳、`findServerEchoForLocalUser` 是否命中，以及 fingerprint 命中的 server 行。读数留证，完成前删除诊断。
2. **在拥有该接缝的层修。** 让重发那条 optimistic local row 恰好被 persisted echo 退休一次。若失配在配对（fingerprint / 时间窗 / `replacesAfterRowCount` / id 守卫），改 `src/modules/chat/utils/sessionMessageReconciliation.ts`；只有当行的**身份**或**隐藏/放回表示**真的拆散了配对时，才动 `useChatComposerState.ts` / `useChatSessionState.ts`（`addMessage` / `markUserTurnUndelivered` / `restoreUserTurn` 的归属）。保留一对一语义（`claimedServerIds`），使**两次真实不同的同文发送仍各画一行**。
3. **单元判据。** 在 `src/modules/chat/tests/sessionMessageReconciliation.test.ts` 增一条重发形状：一条 local 行（首发/失败时刻）+ 一条 persisted echo（重发被接受时刻），文本相等 ⇒ local 行被退休（realtime 结果为空）。同文件**正控制**：两条真实不同的同文 local 发送、只有一条 persisted echo ⇒ 第二条 local 行留存（一对一未被破坏）。
4. **判据绿。** `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"` 退出 0，stdout `transcript.userRows=[1]`，:814 断言逐字未改地通过。
5. **正控制（承重，证明断言不空）。** 变异生产代码**重新造出**重复（强制重发走 `addMessage` 新造一行 / 关掉 echo 退休）⇒ 判据在 :814 红、`Received: 2`。逐字登记变异 diff / 失败行 / 退出码，再还原。
6. **假形态（承重，明确失败的修法必须红）。** 施加「骗过计数」的假修：只在视图层/ CSS 隐藏或按文本折叠同文用户行 ⇒ **必须红** —— 要么判据仍红（判据计数的是 DOM 节点的数量，隐藏不减少），要么第 3 步的一对一单元用例红（两次合法的同文发送必须都渲染）。逐字登记变异 diff / 读数，再还原。
7. **断言零改动证明。** 分支文件里逐字含 `expect(userRows, 'the retried text is exactly one user row, never two').toBe(1);`（`grep -c` = 1）；`git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -c "^-.*toBe(1)"` = 0。
8. **静态门与回归。** `npx vitest run src/modules/chat/tests/` 退出 0；`npm run typecheck`、`npm run lint` 均退出 0。
9. **对齐。** `git diff --stat` 只落在 `## Touches` 列出的文件上；变异写点在最终 diff 前已还原；完成后把 `## Touches` 收窄到真正写过的文件。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-185"` 退出 0；stdout `transcript.userRows=[1]`；整次调用落在 `SINGLE_SPEC_CEILING_MS = 55_000` 内。红态基线（2026-10-02 直跑）：退出 1、`transcript.userRows=[2]`、红落在 :814。修后直跑：`1 passed (10.9s)`、`transcript.userRows=[1]`、`send.wall=1731ms`。
- [x] AC2 断言逐字未改（承重）：分支文件里含逐字行 `expect(userRows, 'the retried text is exactly one user row, never two').toBe(1);`（`grep -c` = 1），且 `git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -c "^-.*toBe(1)"` 为 **0**；无 skip、无 `retries`、无弱化。
- [x] AC3 生产修复 + 单元判据：`npx vitest run src/modules/chat/tests/sessionMessageReconciliation.test.ts` 退出 0，且含一条重发形状新例（首发时刻的 local 行 + 重发被接受时刻的 persisted echo ⇒ local 被退休），并含**正控制**：两条真实不同的同文 local 发送、只有一条 persisted echo ⇒ 第二条 local 留存。8/8 通过。
- [x] AC4 正控制 —— 重复行断言**能**失败（承重）：对生产代码施加「重新造出重复」的变异后，`-g "AC-185"` 在 :814 红、`Received: 2`；逐字登记变异 diff / 失败行 / 退出码，随后 `git checkout -- <file>` 还原。证明该断言不是恒真的空洞判据。
- [x] AC5 假形态必须红（承重）：施加「只在视图层隐藏 / 按文本折叠同文用户行」的假修后必须失败 —— 或判据仍红（DOM 节点计数仍为 2），或 AC3 的一对一单元用例红（两次合法同文发送必须都渲染）。逐字登记变异 diff / 读数，随后还原。
- [x] AC6 无回归 + 静态门：`npx vitest run src/modules/chat/tests/` 退出 0（71 files / 465 tests）；`npm run typecheck`、`npm run lint` 均退出 0。
- [x] AC7 对齐：`git diff --stat` 只触及 `## Touches` 列出的文件；变异写点已还原（`git status --porcelain` 除本任务文件外为空）。

## DoD

真落地：在判据所在的**真实浏览器 + 真实服务端 + 真实调试 agent** 上，一次「服务端起初没收下的发送」被重发后，该文本在转写里**恰好一条用户行**。计数是**匹配该文本的 DOM 节点数**，所以 CSS 隐藏或视图层按文本过滤**都不是修复**；配对发生在转写层（local echo 对 persisted echo 的一对一退休）。:814 那条断言**一字未改、未被旁路**。这个重复是 AC-185 明令禁止的**真实产品缺陷**，不是判据假象。

- **不空**：AC4 证明该断言**能**失败；AC5 证明「骗过计数」的假修**不能**满足它。
- **归因如实**：本缺陷先于本任务存在，已在兄弟任务的完成记录里登记为既存红；若某次运行因宿主负载 / 启动形态而红，归因到那里，不栽本任务。
- **只动 `## Touches` 列出的文件**；若实现确实需要动别的文件（例如 `e2e/activity-dock-truthful.spec.ts` 非断言行、或 `src/shared/types.ts`），先把该文件加进 `## Touches` 再写。本任务预计**不需要**改 spec：它是判据载体，只读。

## Touches

- src/modules/chat/utils/sessionMessageReconciliation.ts
- src/modules/chat/tests/sessionMessageReconciliation.test.ts
- tasks/gap-activity-send-retry-duplicates-user-row.md

## Evidence

诊断（红态，临时，已删）：`[DIAG-MERGE-IN] {"server":[],"realtime":[{local_...},{6915f537-...-text_0}]}` / `[DIAG-RECON] {"matched":null,"serverCandidates":[]}` ⇒ echo 在 realtime，配对谓词只扫 serverMessages。

修复：`removeOptimisticUserEchoes` 现对两类候选各做一次一对一配对 —— REST 历史页行（保留 `replacesAfterRowCount` 索引地板，供 edit-replacement）与 realtime 里已是 persisted 的行（`local_`/`live:` 行被排除，optimistic 行绝不互相退休）。`claimedServerIds` 跨两表统一，一对一成立。

AC4 变异（逐字，已还原）：在 `removeOptimisticUserEchoes` 顶部加 `return realtimeMessages;`（关闭退休）⇒ `-g "AC-185"` 退出 1、`transcript.userRows=[2]`、:818 红 `Expected: 1 / Received: 2`。

AC5 假修（逐字，已还原）：删去两处 `claimedServerIds.add(...)`（按文本折叠，破坏一对一）⇒ `-g "AC-185"` 退出 0、`transcript.userRows=[1]`（骗过判据），但 `sessionMessageReconciliation.test.ts` 红 2：`matches optimistic attachment turns to persisted turns one-to-one` 与 `two real same-text sends with one persisted echo keep the unpaired row` ⇒ 一对一单元控制承重。

还原证据：`git status --porcelain` 各变异后为空（仅最终两文件在 diff 中）。