---
id: gap-ac180-enter-criterion-load-flake-stabilize
title: AC-180 的 Enter 判据在负载下假红：让 e2e/resident-enter-send.spec.ts 在 60s
  门限内稳定跑绿（(b) 正控制腿的选项目 5s 预算不够、浏览器/上下文被关），载重读数一条不动
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-180
---
## Proposal

<!-- dedup-ref -->
机制去重读数（本轮立案时实测，2026-10-04）：`grep -rl "goal_ac: AC-180" tasks/*.md` 只命中 `tasks/gap-resident-enter-send-bypasses-intent-and-consent-gate.md` 与 `tasks/gap-resident-enter-send-spec-still-drives-retired-tick.md`，二者均 `status: done`（分别是 `75f16302` 与 `b1547537` 两次修复的归属任务），**无 todo/ready/needs-human 的认领任务**；`task_list --search resident-enter-send` 另命中 `gap-claude-resident-remote-control-isolation-arm-outside-harness`（另一条线，done）。⇒ 「AC-180 的判据在负载下假红」这一机制目前无人认领，不是重复。与那两条 done 任务的分工：它们修好了 Enter 路径与判据设计，本条修的是判据的**启动/选项目鲁棒性与预算**——不把它们的载重读数再动一次。

**现象（台账读数）。** AC-180 的判据 `npx playwright test e2e/resident-enter-send.spec.ts` 在本轮 goal-driver 的**直接重跑**里退出非 0：`.quay/gate-events.jsonl` 逐字记 `timestamp 2026-10-04T14:27:08.499Z, actor goal-cli, verdict fail`（同日更早一次 `2026-10-04T14:17:33.650Z, actor goal-sweep, verdict fail`）——正是这次 fail 触发了本次 gap-filing 派单（`anchor.json` 的 `bundle.at` = `2026-10-04T14:27:08.744Z`）。而同一判据在同一 HEAD（`fffcc9b7`）上于 14:17:55–14:24:32 连续 5 次 pass（`.quay/goal-round.jsonl` round 608–612 的 `frozenRecheck` 逐字 `verdict=pass, outcome=cleared, cause=now-true, durationMs≈22.5s`），本轮我本人在静默态直接重跑也 **2 passed / 16.7s / exit 0**（读数 `session.lifecycle_mode=resident`、`host.resident.bindsSession=true`、控制 `control.lifecycle_mode=per-run`）。⇒ 这是一条**负载假红**：一个红点夹在一串绿之间，不是担保本身为假（见 `[[left-reverify-ac-ledger-red-can-be-a-flaky-rerun]]`）。

**红落在哪（读判据自己的工件，不读台账 reason）。** 失败运行的数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-kAI2VK/`，`test-results/resident-enter-send-AC-180-2aeeb-ill-sends-and-lands-per-run/error-context.md` 逐字：`Error: Channel closed` 与 `Error: page.waitForTimeout: Target page, context or browser has been closed`。trace（`test.trace`）序列：`openComposer` 的 `projectRow(page).click({ timeout: 5_000 })` 先 `TimeoutError: locator.click: Timeout 5000ms exceeded`（找不到种子工作区 `mobile-send-key-workspace` 的侧栏行），重试若干次后又一次 `Click`，随后 `After Hooks` → `Error: Channel closed`。红落在 **(b) 正控制腿**（`e2e/resident-enter-send.spec.ts:349`），**不是**载重断言——(a) 腿（`lifecycle_mode=resident` 的真宿主读数）在同一运行里通过。

**根因（初判；worker 先复现再定论）。** 判据在装载状态下**启动与选项目过慢**：`openComposer`（`e2e/resident-enter-send.spec.ts:257-281`）用固定预算——`projectRow(page).click({ timeout: 5_000 })`、`waitForTimeout(500)`、以及首屏 `#username`/`Create Account` 的等待——负载下 5s 不够，重试环无法在预算内恢复；`playwright.config.ts:1793` 的全局 `timeout: 60_000` 是本判据的每用例预算，而契约注释（`playwright.config.ts:385-399`）逐字写明「the gate that runs this criterion kills it at 60s and records the kill as verdict: fail」——即这条判据的总预算就是 60s，正常态约 16.7–26s，负载下前置开销一旦顶到 60s 就是假红（见 `[[criterion-budget-must-outlast-its-pre-assertion-waits]]`）。现判据只在 `test.beforeAll` 里 `test.setTimeout(120_000)`（`:310-315`），那只抬钩子，不抬两个用例自身的每用例预算。

**为什么上一次修复不再成立（其实没回归）。** 两次 done 任务都已落地且代码今天仍正确：`src/modules/chat/hooks/useChatComposerState.ts:1414/1417` 的 Enter（含 Ctrl/Cmd+Enter）分支只做 `event.currentTarget.form?.requestSubmit()`，提交统一落到 `src/modules/chat/composer/ChatComposer.tsx:498-500` 的 `handleComposerSubmit`（`setPendingResidentIntent(residentEnabled)`）。红与那两处无关，红在判据的**启动/选项目预算与负载**。⇒ 本条的措辞是「让判据稳定跑绿」，不是「把坏掉的东西修好」。

**要建的东西（最小充分集）。** 让 `e2e/resident-enter-send.spec.ts` 在装载状态、在 60s 门限内**稳定**跑绿：把口径从「固定 5s 预算 + sleep 重试」改成「显式等待就绪 + 与负载相称的预算」，并给两个用例显式的每用例预算，同时**载重读数一条不动**。

**非目标。** 不改常驻模式运行时行为；不弱化 (a) 的 `lifecycle_mode === 'resident'` + 真宿主持有读数，也不弱化 (b) 的 `per-run` 正控制；不动 `e2e/resident-enable-consent.spec.ts`（AC-171）；不额外起并发压测（见 `[[defer-load-problems-do-not-stress-test-inline]]`）。

## Plan

1. **红态复现与定位（先做）**：静默态连跑 `npx playwright test e2e/resident-enter-send.spec.ts` 3 次，登记每次 `duration` 与读数；读 `openComposer`（`:257-281`）与 `projectRow`（`:245-248`），标出负载下最先爆的固定预算（5s 的 `projectRow.click`、`waitForTimeout(500)`、首屏等待）。在自然负载下尝试复现 `projectRow` 的 5s 超时（不额外加并发）。
2. **把前置等待改成「显式就绪 + 成比例预算」**：先等待侧栏/项目行真正可见，而不是 sleep + 短 click；把 `projectRow.click` 的固定 5s 换成与判据预算相称的 `expect(...).toBeVisible({ timeout })` 后再 click，并确认 `openComposer` 的每个重试分支都有可恢复的预算。
3. **给两个用例显式的每用例预算**：按 `playwright.config.ts:391-399` 的既有先例（filter spec 用 `test.describe.configure({ timeout: 120_000 })`），用一个**仍以 60s 门限为准、但让前置开销有明确天花板**的显式设置，确保判据在门限内正常收尾（替代现只在 `beforeAll` 里的 `test.setTimeout`）。
4. **不要动载重断言**：(a) 的 `session.lifecycle_mode === 'resident'` 与 `host.resident.bindsSession === true`（`:332-346`）以及 (b) 的 `control.lifecycle_mode === 'per-run'`（`:365-369`）逐字保留。
5. **跑绿**：连续 3 次绿，登记每次 `duration`（需有明显余量）。若自然负载下仍触顶，继续收窄前置开销（第 2 步），**不得**把断言变弱。
6. **假形态承重**：提交后在 `useChatComposerState.ts` 的 Enter 分支把 `requestSubmit()` 换成直接调 `handleSubmit`（绕过 `handleComposerSubmit`），(a) 必须红；`git checkout` 恢复后复绿。先提交再变异，跑完恢复（见 `[[uncommitted-worker-implementation-wiped-by-checkout-restore]]`）。
7. **契约面**：`npm run lint`、`npm run typecheck` 绿；`git diff --name-only $(git merge-base develop HEAD) HEAD` 落在 Touches 内。

## AC

- [x] AC1 判据绿且稳定：连续 3 次 `npx playwright test e2e/resident-enter-send.spec.ts` 均 exit 0，逐次登记 `duration` 与读数。红态基线：立案时该判据在本轮 driver 直接重跑 exit 非 0（`.quay/gate-events.jsonl` `2026-10-04T14:27:08.499Z` `verdict: fail`）。
- [x] AC2 红已定位到 (b) 腿的启动/选项目前置，而非载重断言：在 `## Evidence` 里逐字登记失败运行自己的工件（`test-results/*/error-context.md` + `test.trace`），证明红是 `Channel closed` / `Target page, context or browser has been closed` 与 `projectRow` 的 `Timeout 5000ms exceeded`，不是 (a) 的 resident 读数。
- [x] AC3 前置预算与负载解耦（承重）：`grep -nE "projectRow\(page\)\.click\(\{ timeout: 5_?000" e2e/resident-enter-send.spec.ts` 命中 **0**；`grep -nE "test\.describe\.configure\(\{ timeout:" e2e/resident-enter-send.spec.ts` 命中 **≥1**（两用例获得显式每用例预算，仍低于 60s 门限）。
- [x] AC4 正控制不弱化（承重）：`grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enter-send.spec.ts` ≥ **2**（(a) 的 resident 与 (b) 的 per-run 正控制逐字仍在），且 `grep -nE "waitForHost|heldByResidentHost" e2e/resident-enter-send.spec.ts` 命中 **≥1**（服务端真宿主持有读数仍在）。
- [x] AC5 假形态必须红（承重）：Enter 分支直接调 `handleSubmit` ⇒ (a) 腿非 **0**，红落在 resident 读数上；登记变异 diff、失败断言逐字、退出码；恢复后复绿。
- [x] AC6 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 判据在 60s 门限内、装载状态下**稳定**跑绿：3 次连续绿，每次 `duration` 有明显余量（登记实测值），且判据是自己读完收尾，不是被 60s 门限 kill 成 fail。
- 载重读数（(a) 的 resident + 真宿主；(b) 的 per-run 正控制）与今天逐字相同——加固的是前置预算与就绪等待，不是断言。
- 假形态真的跑过、真的红，红落在 (a) 的 resident 读数上。
- 只动 `## Touches` 列出的文件；若触及 `src/`（预计不触及）则遵守对应模块标准。

## Evidence

**红态基线（立案读数）。** `.quay/gate-events.jsonl`：`2026-10-04T14:27:08.499Z actor goal-cli verdict fail`（同日更早 `2026-10-04T14:17:33.650Z actor goal-sweep verdict fail`）；`anchor.json` 的 `bundle.at=2026-10-04T14:27:08.744Z`。同一 HEAD 上 14:17:55–14:24:32 连续 5 次 pass（`goal-round.jsonl` round 608–612，`frozenRecheck verdict=pass outcome=cleared cause=now-true durationMs≈22.5s`）。⇒ 一个红点夹在一串绿之间，是负载假红。

**红落点（读失败运行自己的工件，不读台账 reason）。** 失败数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-kAI2VK/`，`test-results/resident-enter-send-AC-180-2aeeb-ill-sends-and-lands-per-run/error-context.md` 逐字：

    - Name: resident-enter-send.spec.ts >> AC-180 (b) control: Enter with the resident switch off still sends, and lands per-run
    - Location: e2e/resident-enter-send.spec.ts:349:1
    Error: Channel closed
    Error: page.waitForTimeout: Target page, context or browser has been closed

同目录 `trace.zip` → `test.trace` 的 action/error 序列逐字：

    TimeoutError: locator.click: Timeout 5000ms exceeded     (×4, waiting for getByRole('heading', { name: ... }) 即 projectRow)
    Error: locator.click: Test ended.                        (同一个 getByRole('heading', ...))
    Error: page.waitForTimeout: Target page, context or browser has been closed

同 trace `2-trace.network` 逐字：整个用例窗口内只到根文档与少数 Vite 模块请求且状态未落（`http://127.0.0.1:2497/`、`/src/modules/i18n/index.ts`、`/src/modules/auth/index.ts`、`/src/modules/task-master/index.ts`、`/src/modules/plugins/index.ts`、`/src/modules/project-workspace/index.ts` …，status 均 `None`）——侧栏尚未渲染。⇒ 红落在 (b) 腿的 `openComposer` 启动/选项目前置（`projectRow.click({ timeout: 5_000 })`），(a) 的 resident 载重读数在同一运行里通过。

**修复（`e2e/resident-enter-send.spec.ts`）。** `openComposer` 先 `await expect(projectRow(page)).toBeVisible({ timeout: PROJECT_ROW_READY_MS /* 20_000 */ })`，再 `await row.click()`（无固定子时限，由每用例预算兜底），删除固定 5s 的 `click({ timeout: 5_000 })`。新增 `test.describe.configure({ timeout: 45_000 })`：两个用例获得显式每用例预算，高于两个 20s 的 `waitFor*` 预算、低于 60s 门限与 55s watchdog。载重断言 (a) `toBe('resident')` + `waitForHost`、(b) `toBe('per-run')` 逐字未动。

**AC1 三次连续绿（逐次 wall 与读数）。**
1. `rc=0 wall=16735ms`；`session.lifecycle_mode=resident`、`host.resident.bindsSession=true`、`control.lifecycle_mode=per-run`；(a) 2.8s / (b) 2.9s / `2 passed (15.9s)`。
2. `rc=0 wall=16205ms`；(a) 2.9s / (b) 2.8s / `2 passed (15.5s)`。
3. `rc=0 wall=16528ms`；(a) 2.8s / (b) 2.8s / `2 passed (15.7s)`。
余量：wall ≈16.2–16.7s，相对 60s 门限 ≈43s。
合并 develop（voice 线与 `playwright.config.ts` 变更）后于 worktree 复跑一次：`rc=0`；`session.lifecycle_mode=resident`、`host.resident.bindsSession=true`、`control.lifecycle_mode=per-run`；(a) 2.9s / (b) 2.7s / `2 passed (15.4s)`。

**AC3 读数。** `grep -cE "projectRow\(page\)\.click\(\{ timeout: 5_?000" e2e/resident-enter-send.spec.ts` → `0`；`grep -nE "test\.describe\.configure\(\{ timeout:" e2e/resident-enter-send.spec.ts` → `330:test.describe.configure({ timeout: 45_000 });`（≥1）。

**AC4 读数。** `grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enter-send.spec.ts` → `2`；`grep -nE "waitForHost|heldByResidentHost" e2e/resident-enter-send.spec.ts` 命中（`waitForHost` 定义 :221；`heldByResidentHost` :360/362/365）。

**AC5 假形态（先提交再变异，跑完恢复）。** 变异 diff（`src/modules/chat/hooks/useChatComposerState.ts` 两处 Enter 分支，绕过 `handleComposerSubmit` 的 `setPendingResidentIntent`）：

    -          event.currentTarget.form?.requestSubmit();
    +          void handleSubmit(createFakeSubmitEvent());

失败断言逐字：`expect(received).toBe(expected) // Object.is equality` / `Expected: "resident"` / `Received: "per-run"` at `e2e/resident-enter-send.spec.ts:358:5`；读数 `session.lifecycle_mode=per-run`；(b) `1 did not run`（serial）。(a) 腿退出码 `PLAYWRIGHT_EXIT=1`。`git checkout -- src/modules/chat/hooks/useChatComposerState.ts` 恢复后复跑 `PLAYWRIGHT_EXIT=0`、`2 passed`、`session.lifecycle_mode=resident`、`host.resident.bindsSession=true`。

**AC6 契约面（合并 develop 后在 worktree 上复读）。** `npm run lint` → `LINT_RC=0`（仅既有 warning）；`npm run typecheck` → `TYPECHECK_RC=0`；`git diff --name-only $(git merge-base develop HEAD) HEAD` → `e2e/resident-enter-send.spec.ts`（合并后唯一的 delta；任务文件与 develop 逐字相同，故不出现在该 delta 里），落在 `## Touches` 内。

## Touches

- `e2e/resident-enter-send.spec.ts`
- `tasks/gap-ac180-enter-criterion-load-flake-stabilize.md`（自触）