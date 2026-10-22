---
id: gap-host-snapshot-failure-unknown-degradation
title: AC-189 宿主快照轮询失败降级为未知：状态栏与侧栏标记不再保留上一次 busy，成功即恢复
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-189
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，读任务库与代码）。`grep -rn "^goal_ac: *AC-189" tasks/*.md` → **0 命中**；`grep -rln "AC-189" tasks/ .quay/` 只命中 `.quay/goal-round.jsonl`、`tasks/.quay-parse-cache.json`（驱动器自己的读数，不是认领）。GOAL-014 已被认领的其它 AC 谈的都是**别的机制**：AC-182 服务端按节拍发业务心跳（`gap-activity-heartbeat-server-frames`，ready）、AC-183 客户端新鲜度状态机（`gap-client-activity-freshness-state-machine`，ready）、AC-184 真实浏览器里坞对不可达的降级（`gap-activity-dock-unreachable-degradation`，todo）、AC-185 发送失败的草稿与重发（`gap-activity-send-unreachable-draft-retry`，todo）、AC-186 回合真实阶段（`gap-claude-turn-phase-real-signals`，ready）、AC-187 坞文案来源（`gap-activity-dock-phase-truthful`，todo）、AC-188 单一活动坞全局一致（`gap-activity-single-dock-global-consistency`，todo）——它们谈的是活动坞、回合阶段与发送；本条谈的是**宿主快照轮询这条独立读数**失败时的降级。机制侧读数：`grep -rn "unknown" src/shared/hooks/useSessionHosts.ts src/modules/sidebar/ResidentMark.tsx src/modules/chat/transcript/ResidentStatusBar.tsx` → **0**；`grep -n "ResidentProcessState" src/shared/types.ts` → 只有 `unstarted | idle | busy | exited` 四个成员（`src/shared/types.ts:809`）；`grep -rn "error" src/modules/sidebar/ResidentMark.tsx` → 0，`src/modules/chat/transcript/ResidentStatusBar.tsx` 只读到自己的 `actionError`，两个消费者都**不读** hook 的 `error`；`test -f src/modules/chat/tests/hostSnapshotFailure.test.ts` → **ABSENT**。⇒「快照轮询失败降级为未知」这一机制无人认领，不是重复。

**现状读数（2026-10-01，读代码）。** `src/shared/hooks/useSessionHosts.ts:60-75` 的 `readSnapshot` 在 `catch` 里**保留** `state.snapshot`（旧快照），只把 `error` 设成异常消息；那段注释还明写「a single failed poll is not evidence that every process went away」——今天的实现是**有意保留旧状态**的，与 AC 要求相反。而 `error` 设了却**没有任何地方渲染**：`ResidentStatusBar.tsx:83` 只解构 `{ snapshot, start, close }`，`ResidentMark.tsx:34` 只解构 `{ snapshot }`，两者都经同一个共享翻译 `readResidentProcessState(host)`（`useSessionHosts.ts:318`）把宿主翻成状态词，再经 `data-resident-ui-state` / `data-resident-state` 发布。于是服务端一宕机、轮询全部失败，`snapshot` 停在宕机前那一次，状态栏与侧栏标记双双保留宕机前的 `busy`——这正是 GOAL-014 要消灭的「假装在思考」在**宿主快照**这条腿上的形态（活动坞那条腿由 AC-184 管）。

**要做的事。** 让「上一次读失败」进入那**一个**共享状态翻译：`error !== null` 时，宿主状态词一律读作新增的 `unknown`（不是上一次的 `busy`）；下一次读成功（`error` 回到 null）立即恢复为真实状态词。新增的 `unknown` 要同时接入读同一份 state 的两个消费者——`ResidentStatusBar` 的 `data-resident-ui-state` 与文案、`ResidentMark` 的 `data-resident-state` 与图形——失败时两处必须**同时**是 `unknown`，且标记不得再画忙碌的转圈或实心点。实现上复用 hook 结果里**已经存在**的 `error` 字段，不要给 `UseSessionHostsResult` 增加新的必填成员：那会让三个既有测试文件里 `vi.mock` 的返回字面量缺字段而 typecheck 红（`residentStatusBarLeaseSummary.test.tsx:87`、`residentStatusBarCloseReachable.test.tsx:86`、`residentStatusBarClearsTranscript.test.tsx:114`——三个都返回 `error: null`），把与 AC 无关的兄弟测试拖红。判据写在 AC 固定路径 `src/modules/chat/tests/hostSnapshotFailure.test.ts`，用假 `fetch` 驱动**真实** store（不 mock 掉 hook）：先成功返 busy，再失败，再成功返 idle。

<!-- dedup-ref --> 可追溯性说明（非 gating）。AC-188（`gap-activity-single-dock-global-consistency`）日后会把 resident 状态栏的忙闲部分并入单一活动坞，届时本条的读数随状态栏一起搬家；那条自己声明依赖 AC-184，与本条无并发。本条不为 AC-190 的人工关卡申领任何东西，也不改活动坞、回合阶段、发送这三条机制的任何一个字节。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/hostSnapshotFailure.test.ts` 退出 0。红态基线：实现前 `test -f src/modules/chat/tests/hostSnapshotFailure.test.ts` → absent（或存在但降级断言红）。
- [x] AC2 失败降级（承重）：假 fetch 第一次成功返回一个 `busy` resident 宿主 ⇒ 状态栏 `data-resident-ui-state` 与侧栏标记 `data-resident-state` 同时为 `busy`；第二次轮询失败（fetch reject，或 `response.ok=false` 的 `{success:false,...}` 信封）⇒ **同一次渲染**里两处同时变为 `unknown`，且两处都不是 `busy`。
- [x] AC3 成功即恢复：第三次轮询成功返回 `idle` 宿主 ⇒ 两处同时回到 `idle`（不停在 `unknown`）。
- [x] AC4 两处恒等：三个相位里同时读状态栏与标记，两处属性值逐相位相等（`busy`/`busy`、`unknown`/`unknown`、`idle`/`idle`），证明两处读同一状态而不是各自判定。
- [x] AC5 公共结果形状不变：`UseSessionHostsResult` 不新增必填成员；`npm run typecheck` 退出 0，且既有 `vi.mock('@/shared/hooks/useSessionHosts')` 的返回字面量无需改动（`git diff --name-status develop...HEAD` 不含那三个测试文件）。
- [x] AC6 取假形态必须红：先提交实现，再把降级去掉（两个消费者回到 `readResidentProcessState(host)`、不把失败折进读数；等价于恢复「失败保留旧快照」的阅读路径）⇒ AC2 的降级断言逐字红；登记变异 diff、逐字失败行与 `git checkout --` 恢复命令，恢复后 `git status` 干净。
- [x] AC7 i18n 完整：`resident.statusBar.unknown` 在全部 12 个语言包（`src/modules/i18n/locales/{de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW}/chat.json`）都存在且非空；判据文件内一个用例逐包断言 `missing === []`（`console.log` 出检查数与 missing 数）。
- [x] AC8 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --name-status develop...HEAD` 只出现在 Touches 列出的文件里（新增文件用 ASCII `(new)`）。

## DoD

- 判据在**真实** `useSessionHosts` store 上跑：不 `vi.mock('@/shared/hooks/useSessionHosts')`，而是 `vi.stubGlobal('fetch', …)` 用脚本化应答队列驱动三次轮询（busy 成功 / 失败 / idle 成功），用 `vi.useFakeTimers()` 与 `vi.advanceTimersByTimeAsync(1000)` 驱动 1 秒轮询节拍，相位之间在 `act` 内推进并 flush；实现前「失败 ⇒ unknown」断言必须红。
- 降级走**一个**共享翻译：状态栏与标记都从 `readResidentProcessState` 的同一读数派生，不各自判 `error`；`data-resident-ui-state` 与 `data-resident-state` 在三个相位恒等。
- 文件是 `.test.ts`（AC 固定路径），因此用 `createElement` 而不是 JSX（写进 `.ts` 无需改名 `.tsx`）；遵守 `.agents/skills/frontend-module-standards/SKILL.md`（`@/` 导入、用 `type` 不用 `interface`、不建 module-local `types.ts`）。
- 测试位于 `src/modules/chat/tests/`，属 boundaries 的 `src/modules/**` include：跨模块 import 必须走 barrel。`ResidentMark` 目前不在 `src/modules/sidebar/index.ts` 的导出里，需先把 `export { default as ResidentMark } from '@/modules/sidebar/ResidentMark'` 加进该 barrel，再从 `@/modules/sidebar` 导入（这正是把 barrel 列进 Touches 的原因，不是可选）。`ResidentStatusBar` 属 chat 本模块，可深导入。
- 只动 Touches 列出的文件；确需别的文件时先把该文件加进 Touches 再写。变异前先提交实现（`git checkout --` 会抹掉未提交的改动）。

## Touches

- src/shared/hooks/useSessionHosts.ts
- src/shared/types.ts
- src/modules/chat/transcript/ResidentStatusBar.tsx
- src/modules/sidebar/ResidentMark.tsx
- src/modules/sidebar/index.ts
- src/modules/chat/tests/hostSnapshotFailure.test.ts (new)
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- tasks/gap-host-snapshot-failure-unknown-degradation.md

## Needs-Human

**执行 2026-10-01T14:58:52.126Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：0f15dcb5-089e-40bb-923b-840e8b5a0b86
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-host-snapshot-failure-unknown-degradation~wk-prod-anchor~1790866044959-1e33ef.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-host-snapshot-failure-unknown-degradation-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-01T17:43:47.008Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：ea064de0-3bca-46e4-8b65-aebcd5097e92
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-host-snapshot-failure-unknown-degradation~wk-prod-anchor~1790876577594-c47c22.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-host-snapshot-failure-unknown-degradation-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-02T02:49:35.428Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 4 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts:   AssertionError [ERR_ASSERTION]: the probe process must offer a raw write seam to write the frame to
- run_id：wk-prod-anchor
- session_id：953700ad-c694-49c8-82e5-75e54ca5629b
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-host-snapshot-failure-unknown-degradation~wk-prod-anchor~1790909144137-67b067.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-host-snapshot-failure-unknown-degradation-wk-prod-anchor.log

## Needs-Human

**执行 2026-10-02T04:25:24.449Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 5 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7175 server/modules/debug-agent/tests/debug-agent-gate.test.ts passed=false end_ms=1790914972851
- run_id：wk-prod-anchor
- session_id：ee41a3c1-5d9d-4074-afe6-14f8f107d63e
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-host-snapshot-failure-unknown-degradation~wk-prod-anchor~1790914931431-b3040e.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-host-snapshot-failure-unknown-degradation-wk-prod-anchor.log
