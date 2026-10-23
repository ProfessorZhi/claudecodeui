---
id: gap-resident-status-bar-collapsed-lease-chips
title: 折叠状态条按 lease kind 展开的多个 chip 造成信息过载：合并为一个计数，per-kind 明细挪入已有 popover，同步改
  AC-172 判据 readBar() 的读取时序（两条假形态承重）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-29）：`grep -rliE 'lease-kind|data-lease-kind|per-kind|折叠条|状态条.*(简化|合并|信息过载)' tasks/*.md` 命中 `gap-claude-resident-status-bar.md`（status: done，AC-172，认领的是「per-kind chip 的计数必须等于宿主 lease 计数」这一正确性，不是「chip 太多造成折叠条信息过载」这一展示密度问题）与 `gap-claude-resident-running-view.md`（status: done，认领的是侧栏 Running 徽标只计正在运行会话，与本条无关的另一枚举）。⇒ 折叠条展示密度问题目前无认领者，本条不是重复。

**现状（本轮直读代码，逐字取自文件）。** `src/modules/chat/transcript/ResidentStatusBar.tsx:264-273` 的折叠条触发按钮里，为 `binding?.leases` 里出现的每一种 `kind` 各渲染一个独立的 `<span data-lease-kind data-lease-count>` chip（`{count} {t('resident.statusBar.counts.${kind}')}'`），数量不设上限——`HostLease.kind` 的闭集是 `turn / background-task / monitor / cron / resident-policy`（`server/shared/types.ts:1841`），五种同时挂在同一个 binding 上时折叠条要并排画五个 chip。而 `:303-367` 已经有一个点开才出现的 popover，装着地址、pid、uptime、复制/关闭按钮——每种信息一行，这部分本身不拥挤。折叠条与 popover 的信息密度因此不对称：popover 空着地方，折叠条却把明细全摊开。

**已验证不需要动的两处（避免重复劳动）。** `src/modules/sidebar/ResidentMark.tsx:8,42` 已经调用与状态条相同的 `readResidentProcessState()`（组件注释原话「the word this mark draws and the sentence the status bar shows come from one reading of one host」）——侧栏标记与状态条共享同一状态枚举的诉求**今天已经成立**，不在本条范围内。`src/modules/chat/transcript/PendingResidentMessage.tsx` 的 `queued/started/cancelled` 是「这条消息有没有被常驻进程处理」的命令生命周期，与状态条的 `unstarted/idle/busy/exited`（进程本身是否存活）是两个不同的状态机，把二者的符号强行统一会混淆两件不同的事，不是本条要做的事。

**与 AC-172 的耦合（本条范围必须一并处理）。** `e2e/resident-status-bar.spec.ts:320-338` 的 `readBar()` 在**不打开 popover**的情况下，直接用全局选择器 `[data-lease-kind]`（`:72` 的 `LEASE_PILL`）读取折叠条上的 chip；`:717-736` 的 AC3 断言（"the bar counts the leases the listing reports, kind for kind"）依赖这一读法。若把 chip 挪进 popover（只在 `isOpen && anchor` 时才挂进 DOM，`:303`），`readBar()` 在 popover 未打开时会读到 0 个 pill，AC-172 已验收的 AC3 断言会红。因此本条必须同时把 `readBar()` 改成先点开 popover（`data-resident-status-bar-trigger`）再读 `[data-lease-kind]`，让 AC3 的「界面按 kind 计数 === 宿主按 kind 计数」在新布局下继续成立——不改 AC-172 的判断标准本身，只改它的读取时序。

**要建的东西（最小充分集）**

1. 折叠条触发按钮不再逐 kind 展开 chip，改为渲染一个合并计数（新 i18n 键 `resident.statusBar.activeCount`，形如 `{{count}} active`），值为 `binding?.leases` 的总条数；0 条时不渲染该节点（与今天「没有 lease 就不画任何 chip」的既有行为一致）。
2. 原来逐 kind 的 `<span data-lease-kind data-lease-count>` 移进 popover 面板（`:303-367` 内，地址行上方或 uptime 行下方均可，具体位置由实现者按视觉密度选，只要求在 popover 打开时挂进 DOM），DOM 属性与文案键（`data-lease-kind` / `data-lease-count` / `resident.statusBar.counts.<kind>`）逐字保留，因为 AC-172 的判据要靠这两个属性名读回。
3. `e2e/resident-status-bar.spec.ts` 的 `readBar()` 改为：先点击 `[data-resident-status-bar-trigger]` 打开 popover、等 `[data-lease-kind]` 至少出现一次或超时按 0 条处理、再读 pill，读完不必关闭（后续断言若依赖 popover 关闭状态由实现者按既有测试流程处理，不得改变除 pill 读取时序外的任何既有断言语义）。
4. 新增一个纯前端结构性判据（vitest + Testing Library），直接渲染 `ResidentStatusBar` 并 mock `useSessionHosts`，钉住「触发按钮内没有 `[data-lease-kind]`、popover 打开后一个 kind 对应一个 chip 且计数之和等于折叠条上合并数字」这一机制本身，供 scoped gate 在不起 playwright 的情况下也能验一次。
5. 12 个 locale 的 `chat.json` 都补上 `resident.statusBar.activeCount` 键（沿用 `resident.statusBar.counts.*` 已经建立的补齐惯例）。

**非目标**：不改 `ResidentMark.tsx`（已经共享枚举）；不改 `PendingResidentMessage.tsx`（不同状态机，不强行统一）；不改 popover 内既有的地址/pid/uptime/复制/关闭字段与其 DOM 契约；不改 `HostLease.kind` 的闭集或后端投影；不改 AC-172 之外任何一条已验收 AC 的判断标准本身（只改 `readBar()` 的读取时序）。

## Plan

1. **量当前形状（不假设，直接读）**：确认 `ResidentStatusBar.tsx` 折叠条今天渲染的 chip 数量随 lease kind 数变化（已在 Proposal 的代码引用里钉住行号，实现前用一条本地渲染/e2e 读数复核一遍再动手，防止行号漂移）。
2. **改 `ResidentStatusBar.tsx`**：折叠条加合并计数节点；chip 循环移入 popover；保留全部既有 `data-resident-*` 属性与 i18n 键不变。
3. **改 `e2e/resident-status-bar.spec.ts` 的 `readBar()`**：加开 popover 的步骤；重跑整条判据，确认 AC1–AC12（`gap-claude-resident-status-bar.md` 完成记录里逐条列出的编号）逐条仍绿，逐一比对判据自身打印的原始读数与该任务完成记录里登记的读数形状是否一致（不要求数值逐字相同，要求断言仍然成立）。
4. **写新增结构性判据**（vitest，新文件），含正/反两腿：反向腿把 chip 放回触发按钮内 ⇒ 判据红，证明不是恒绿。
5. **补 12 个 locale 的 `resident.statusBar.activeCount`**。
6. **假形态承重变异**：把 `readBar()` 的「先开 popover」步骤去掉（chip 已经挪进 popover，读法退回旧的不开 popover 直接读）⇒ `npx playwright test e2e/resident-status-bar.spec.ts` 必须红，且红落在原 AC3 的「the bar counts the leases the listing reports, kind for kind」断言上（登记变异 diff、失败断言逐字、退出码；恢复后复绿）。
7. `npm run lint` / `npm run typecheck` 绿；`git diff --stat` 与 Touches 逐条对齐；写完成记录。

## AC

- [x] AC1 结构性判据绿（新判据，承重）：`npx vitest run src/modules/chat/tests/residentStatusBarLeaseSummary.test.tsx` 退出 **0**；判据打印 `trigger.leaseKindNodes=0`（触发按钮内没有任何 `[data-lease-kind]`）、`trigger.summaryText=<合并计数文案>`、`popover.leaseKindNodes=<N>`（N = 不同 kind 数）、`popover.countSum=<M>` 且 `M === trigger.summaryCount`（合并数字等于 popover 里各 kind 计数之和）。**正控制**：把 fixture 的 lease 从 3 条改成 0 条重渲染，`trigger.summaryText` 变为空/不渲染（证明数字不是写死的常量）。**反向腿（承重）**：把 chip 渲染逻辑改回放在触发按钮内 ⇒ 该判据退出非 0，红落在 `trigger.leaseKindNodes=0` 这条断言上；恢复后复绿。
- [x] AC2 AC-172 已验收判据在新布局下仍然全绿：`npx playwright test e2e/resident-status-bar.spec.ts` 退出 **0**，打印 `elapsed=<n>ms` 且 `< 55000`（`playwright.config.ts` 的 `SINGLE_SPEC_CEILING_MS`）。判据自身原有的 12 条 AC 编号（AC1–AC12，对照 `gap-claude-resident-status-bar.md` 完成记录）逐条仍产出与其原始断言语义一致的读数（不要求数值逐字复现，要求断言仍成立，尤其是 AC3 的「the bar counts the leases the listing reports, kind for kind」）。
- [x] AC3 假形态必须红（承重）：把 `readBar()` 的「先开 popover 再读 pill」步骤去掉（其余不改），`npx playwright test e2e/resident-status-bar.spec.ts` 退出非 **0**，且红**落在原 AC3 的 kind-for-kind 断言上**（登记变异 diff、失败断言逐字、退出码）；恢复后同一命令复绿。
- [x] AC4 12 个 locale 补齐：`resident.statusBar.activeCount` 在 `src/modules/i18n/locales/{de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW}/chat.json` 里都存在且非空，任一缺失以非 0 退出并点名文件（沿用既有 i18n 完整性判据的读法，见 `i18n-completeness` 相关判据或等价的一条新脚本）。
- [x] AC5 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 折叠条上不再有随 lease kind 数量线性增长的 chip；popover 打开后能看到与今天逐字相同的 per-kind 明细（DOM 属性与 i18n 键不变）。
- AC-172（`gap-claude-resident-status-bar`）已验收的判据在新布局下**全绿**，其 kind-for-kind 计数断言的判断标准本身未被削弱——只改了读取时序（先开 popover），不是把断言改弱或删除。
- 假形态**真的跑过并真的红**，红落在原判据的承重断言上，不是随便一条断言都行。
- 只动 `## Touches` 列出的文件；不改 `ResidentMark.tsx`、`PendingResidentMessage.tsx`、popover 既有字段的 DOM 契约、`HostLease.kind` 闭集。

## Touches

- `src/modules/chat/transcript/ResidentStatusBar.tsx`
- `e2e/resident-status-bar.spec.ts`
- `src/modules/chat/tests/residentStatusBarLeaseSummary.test.tsx` (new)
- `src/modules/i18n/locales/de/chat.json`
- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/es/chat.json`
- `src/modules/i18n/locales/fr/chat.json`
- `src/modules/i18n/locales/id/chat.json`
- `src/modules/i18n/locales/it/chat.json`
- `src/modules/i18n/locales/ja/chat.json`
- `src/modules/i18n/locales/ko/chat.json`
- `src/modules/i18n/locales/ru/chat.json`
- `src/modules/i18n/locales/tr/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/locales/zh-TW/chat.json`
- `tasks/gap-resident-status-bar-collapsed-lease-chips.md`（自触）
