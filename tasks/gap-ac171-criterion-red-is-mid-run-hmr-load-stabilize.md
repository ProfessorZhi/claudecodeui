---
id: gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize
title: AC-171 判据在负载与运行中 HMR 下假红：让 e2e/resident-enable-consent.spec.ts
  在门限内稳定跑绿（启动等就绪预算 + 开关状态对重挂载鲁棒两处加固），载重读数一条不动
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-171
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-05）：`grep -rl "^goal_ac: *AC-171" tasks/*.md` 只命中 `tasks/gap-claude-resident-consent-gate.md`（旧「须先勾选知情」设计版）与 `tasks/gap-resident-i18n-duplicate-key-shadows-toggle-and-notice.md`（locale 重复键修复版），二者均 `status: done` —— 无 todo/ready/needs-human 的认领任务。`grep -rl "resident-enable-consent" tasks/*.md` 另命中 `tasks/gap-ac180-enter-criterion-load-flake-stabilize.md`（done；其「非目标」逐字写着「不动 e2e/resident-enable-consent.spec.ts（AC-171）」）与两条已 done 的 AC-178 任务。⇒ 「AC-171 判据的负载 / 运行中 HMR 稳定性」无人认领，本条不是重复。

**判据物。** 逐字取自 `goals/AC-171-真实浏览器里开启常驻须先勾选知情-未勾选不能发送或转换.md`（文件名是旧题，frontmatter `title` 已是现行「常驻开关打开即生效，hint 仅作说明不门控发送或转换」）的 `criterion:`：`npx playwright test e2e/resident-enable-consent.spec.ts`。

**本轮读数（自己直跑，不是推断）。** 静默态 `npx playwright test e2e/resident-enable-consent.spec.ts` → `4 passed (25.2s)`，exit **0**；读数逐字 `session.lifecycle_mode=resident`、`control.session.lifecycle_mode=per-run`、`capability.residentProviders=claude`、`capability.nonResidentProviders=cursor,codex,opencode`、`toggle.present=false`（非 resident provider 不出开关）。⇒ **判据今天是真的**；本条写「让判据稳定跑绿」，不是「把坏掉的担保修好」（见 [[left-reverify-ac-ledger-red-can-be-a-flaky-rerun]]）。

**driver 红在哪（读判据自己的工件，不读台账 reason）。** 两处，均在 2026-10-05，都落在同一 test（`e2e/resident-enable-consent.spec.ts:441`）：

1. `~/.cache/quay-e2e-tmp/quay-e2e-FK72jV/`（工件 mtime `2026-10-05T02:50:35Z`）的 `test-results/resident-enable-consent-th-9e186-g-with-it-on-lands-resident/error-context.md` 逐字：`Error: expect(locator).toBeVisible() failed` / `Locator: locator('[data-slot="prompt-input-textarea"]')` / `Expected: visible` / `Timeout: 15000ms` / `Error: element(s) not found`；同批 trace 另有 `Error: Timeout 5000ms exceeded`。对应 spec `:326` 与 `:360` 的 `projectRow(page).click({ timeout: 5_000 })` —— 负载下「等就绪」的固定预算不够（与 AC-180 那条同类，见 [[criterion-budget-must-outlast-its-pre-assertion-waits]]）。
2. `~/.cache/quay-e2e-tmp/quay-e2e-VTYHJM/`（工件 mtime `2026-10-05T05:37:51Z`）同路径 `error-context.md` 逐字：`Error: the session a switch-on send is addressed to must read back as resident from the server` / `Expected: "resident"` / `Received: "per-run"`。

**第二处的根因（读 trace 得到，不是猜）。** VTYHJM 的 `trace.zip` 里（`grep -rl lifecycle-mode` **全空**）**没有任何 `lifecycle-mode` 请求**——POST `/api/providers/sessions`→201 有，PUT `.../lifecycle-mode` 无；却有 6×`[vite] hot updated: /src/App.tsx` 与 6×各 `/src/modules/project-workspace/{context/ProjectsStateContext.tsx, controllers/ProjectEffects.tsx, ProjectCommandPalette.tsx, ProjectMainRegion.tsx, ProjectSidebarRegion.tsx, ProjectWorkspaceRoute.tsx}` 及 `/src/index.css`。这正是**主检出上并发活编辑**触发的 Vite HMR（`git status`：`M src/modules/project-workspace/hooks/useProjectsState.ts` 未提交，而上面那串正是它的 importers）：`App.tsx` / 路由重挂载把 `src/modules/chat/ChatInterface.tsx:274` 的 `residentEnabled` 复位，开关点击读到的 `aria-checked=true` 在发送前丢失，于是 `src/modules/chat/hooks/useChatComposerState.ts:1044` 的新会话分支没走 `if (residentEnabled)` 的 PUT，会话落成 per-run（见 [[criterion-red-is-mid-run-hmr-of-live-edited-main-checkout]]、[[gap-round-criterion-red-may-be-main-checkout-wip]]）。⇒ 这是**环境产物（运行中 HMR 重挂载 + 负载）**，不是 AC-171 的 shipped 行为回归；判据本身正确。

**为什么「上一次修复」看着没过（其实没回归）。** AC-171 无代码回归：`6814265d`（开关搬到模型卡片下 + 退掉勾选门）与 `8b944e68`（composer 开关删除、意图只对新会话生效）都在 HEAD，本轮静默态 4 passed 即证。红只长在判据自己的两处鲁棒性缺口：固定 5s 启动预算、以及「点开关 → 发送」之间对一次重挂载不复位常驻意图。

**要建的东西（最小充分集）。** 让 `e2e/resident-enable-consent.spec.ts` 在装载状态下、在判据门限内、且运行中发生一次 HMR 重挂载时**稳定跑绿**：(1) 把 `:326`/`:360` 一类固定 5s 预算与 sleep 重试换成「先显式等就绪（可见）再动作」的成比例预算；(2) 在「点开关 → 发送」之间加重挂载鲁棒：发送前重新确认开关仍 `aria-checked=true`，一次有界重试内若被复位就重新打开，使一次 HMR 复位不能静默把这条腿变成 per-run；(3) 给用例显式预算，仍以判据门限为准（见 `playwright.config.ts` 的契约注释）。

**非目标。** 不改常驻运行时行为，不改 `residentEnabled` 的生产语义；**不弱化任何载重读数**——`:441` 腿的 `createdMode === 'resident'` 与正控制 `controlMode === 'per-run'`、`:574` silent-conversion 腿的 `SEEDED_SESSION_ID` 仍 per-run、`:721` capability 腿的缺席读数，逐字保留（现行 `toBe('resident')|toBe('per-run')` 共 **7** 处，不得减少）；不额外起并发压测（见 [[defer-load-problems-do-not-stress-test-inline]]）。

## Plan

1. **红态复现与定位（第一步）**：静默态连跑判据 3 次，登记每次 `duration` 与四项读数；读 `e2e/resident-enable-consent.spec.ts:311-362` 的 `openComposer`/`projectRow`，标出固定 5s 预算与 sleep 重试（`:326`、`:360`）。尝试在自然负载下复现（不额外加并发）。
2. **启动预算与负载解耦**：把 `projectRow(page).click({ timeout: 5_000 })` 换成先 `expect(projectRow).toBeVisible({ timeout })` 再 click，预算与用例门限相称；`:402` 的 5s 读数按需上调但保持有界。
3. **重挂载鲁棒（承重设计）**：在「开关 `aria-checked=true` 已读」与 `SEND_BUTTON.click()` 之间，加一次有界的「复认并（必要时）重开开关」：重新读 `[data-resident-enable="true"]` 的 `aria-checked`，若已复位则重开并复认；使发送前的最后一次状态读数就是「开关在开」。其后创建会话落 resident 的断言不变。
4. **显式预算**：给 4 个用例一个显式每用例预算（`test.describe.configure({ timeout })`，或逐 test 第三个参数），确保在判据门限内正常收尾，替代现只在 `beforeAll` 的 `test.setTimeout(120_000)`（`:436`）。
5. **跑绿**：连续 3 次绿，登记每次 `duration`（需有明显余量）；若仍触顶，继续收窄启动开销，**不得**弱化断言。
6. **假形态承重**：提交后在 `src/modules/chat/hooks/useChatComposerState.ts` 的新会话分支去掉 `if (residentEnabled)` 的 PUT，`:441` 腿必须在 `createdMode === 'resident'` 上红；`git checkout` 恢复后复绿。先提交再变异，跑完恢复（见 [[uncommitted-worker-implementation-wiped-by-checkout-restore]]）。
7. **契约面**：`npm run lint`、`npm run typecheck` 绿；`git diff --name-only $(git merge-base develop HEAD) HEAD` 落在 Touches 内。

## AC

- [x] AC1 判据绿且稳定：连续 3 次 `npx playwright test e2e/resident-enable-consent.spec.ts` 均 exit 0，逐次登记 `duration` 与 `session.lifecycle_mode=resident`、`control.session.lifecycle_mode=per-run`。红态基线：2026-10-05 两处 driver 红（工件 `quay-e2e-FK72jV` mtime `02:50:35Z`、`quay-e2e-VTYHJM` mtime `05:37:51Z`）。
- [x] AC2 红已定位到判据自身的启动预算与重挂载，而非担保为假：`## Evidence` 里逐字登记两处工件——FK72jV 的 `prompt-input-textarea` 可见性超时；VTYHJM 的 `Expected "resident" / Received "per-run"`，且其 trace 内**无** `lifecycle-mode` 请求、含 6×`[vite] hot updated: /src/App.tsx`。
- [x] AC3 启动预算与负载解耦（承重）：`grep -nE "click\(\{ timeout: *5_?000" e2e/resident-enable-consent.spec.ts` 命中 **0**；`grep -nE "test\.describe\.configure\(\{ *timeout:" e2e/resident-enable-consent.spec.ts` 命中 **≥1**（显式每用例预算）。
- [x] AC4 重挂载鲁棒（承重）：spec 在 `SEND_BUTTON.click()` 之前含一次「复认开关 `aria-checked`、必要时重开」的有界读取；`grep -c "aria-checked" e2e/resident-enable-consent.spec.ts` **≥** 现行 5，且新增的那次读数位于发送前。
- [x] AC5 载重读数不弱化（承重）：`grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enable-consent.spec.ts` **≥ 7**（现行值），且 `:574` silent-conversion 腿与 `:721` capability 腿逐字保留。
- [x] AC6 假形态必须红（承重）：在 `src/modules/chat/hooks/useChatComposerState.ts` 新会话分支去掉 `if (residentEnabled)` 的 PUT ⇒ `:441` 腿红在 `createdMode === 'resident'`（Received `per-run`）；登记变异 diff、失败断言逐字、退出码；恢复后复绿。
- [x] AC7 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 判据在 60s 门限内、装载状态下**稳定**跑绿：3 次连续绿、每次 `duration` 有明显余量（登记实测值），且判据自己读完收尾。
- 一次 HMR 重挂载（`App.tsx`/路由）不再能让「开关已开 → 发送」静默变成 per-run；一次负载不再能让启动等就绪超预算。
- 载重读数（`:441` resident + per-run 正控制、`:574` silent-conversion、`:721` capability）与今天逐字相同。
- 假形态真跑、真红，红落在 resident 读数上；只动 `## Touches` 列出的文件。

## Evidence

**AC1 — 判据 3 次连续绿（工作树 `…/gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize` 内直跑，2026-10-05）。** `npx playwright test e2e/resident-enable-consent.spec.ts` 逐次 **exit 0**，duration **25.3s / 24.6s / 41.9s**；每次读数均含 `session.lifecycle_mode=resident`、`control.session.lifecycle_mode=per-run`、`new.session.lifecycle_mode=resident`、`resident.armed.aria-checked=true`。41.9s 那次各用例逐条 duration 与静默态一致（4.0s / 5.2s / 2.8s / 2.9s），多出的 ~17s 全在 run 级装填（config 评估/seeding/server boot/browser launch/onboarding），仍在 55s watchdog 与 60s 门限之内。

**AC2 — 两处 driver 红逐字（任务立案时的工件）。**
- `~/.cache/quay-e2e-tmp/quay-e2e-FK72jV/`（mtime `2026-10-05T02:50:35Z`）`test-results/resident-enable-consent-th-9e186-g-with-it-on-lands-resident/error-context.md`：`Error: expect(locator).toBeVisible() failed` / `Locator: locator('[data-slot="prompt-input-textarea"]')` / `Expected: visible` / `Timeout: 15000ms` / `Error: element(s) not found`（同批 trace 另有 `Error: Timeout 5000ms exceeded`）⇒ 固定 5s 启动预算在负载下不够。
- `~/.cache/quay-e2e-tmp/quay-e2e-VTYHJM/`（mtime `2026-10-05T05:37:51Z`）同路径：`Error: the session a switch-on send is addressed to must read back as resident from the server` / `Expected: "resident"` / `Received: "per-run"`；其 `trace.zip` 内 `grep -rl lifecycle-mode` **全空**（无 `PUT …/lifecycle-mode` 请求），含 6×`[vite] hot updated: /src/App.tsx` ⇒ 运行中 HMR 重挂载复位 `residentEnabled`，非 AC-171 担保回归。

**AC3 — 承重（启动预算与负载解耦）：** `grep -cE "click\(\{ timeout: *5_?000" e2e/resident-enable-consent.spec.ts` = **0**；`grep -cE "test\.describe\.configure\(\{ *timeout:" e2e/resident-enable-consent.spec.ts` = **1**（`test.describe.configure({ timeout: 45_000 })`）。`openComposer`/`openWorkspace` 改为先 `expect(projectRow).toBeVisible({ timeout: PROJECT_ROW_READY_MS = 20_000 })` 再 `row.click()`（不再带固定子预算）。

**AC4 — 承重（重挂载鲁棒）：** `grep -c "aria-checked" e2e/resident-enable-consent.spec.ts` = **8**（≥ 现行 5）；新增的复认读数在 `armResidentSwitch()`（调用点 :603、:661）内，两次调用均在对应 `SEND_BUTTON.click()`（:604、:662）之前。

**AC5 — 承重（载重读数不弱化）：** `grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enable-consent.spec.ts` = **7**（未减少）；silent-conversion 腿（现 :646）与 capability 腿（现 :796）逐字保留。

**AC6 — 假形态真红：** 变异 = 在 `src/modules/chat/hooks/useChatComposerState.ts` 新会话分支删除 `if (residentEnabled) { … }` 整块（其中的 `await api.providers.setSessionLifecycleMode(provider, targetSessionId, 'resident');` 及其 catch / `clearResidentIntent?.()`），改为注释 `// FALSIFYING VARIANT (AC6): the resident lifecycle-mode write removed from the new-session branch.` ⇒ `npx playwright test e2e/resident-enable-consent.spec.ts -g "the new-session screen carries the switch"` **exit 1**，`session.lifecycle_mode=per-run`，失败断言逐字：`Error: the session a switch-on send is addressed to must read back as resident from the server` / `Expected: "resident"` / `Received: "per-run"`（即红在 `createdMode === 'resident'`）。`git checkout -- src/modules/chat/hooks/useChatComposerState.ts` 恢复（`setSessionLifecycleMode` 复现于 :1046），工作树 clean。假形态真红也证明 `armResidentSwitch` 的复认不会掩盖载重读数。

**AC7 — 契约面：** `npm run lint` **exit 0**；`npm run typecheck` **exit 0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` = `e2e/resident-enable-consent.spec.ts`（+ 本次 ABI tick commit 的 `tasks/gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize.md`），全部落在 `## Touches` 内。

## Touches

- `e2e/resident-enable-consent.spec.ts`
- `tasks/gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize.md`（自触）

