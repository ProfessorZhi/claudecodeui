---
id: gap-claude-resident-shell-tab
title: AC-174 真实浏览器里常驻会话的 Shell 标签页禁用并显示「常驻会话不支持 Shell，关闭常驻模式后可用」、判定只读
  lifecycle_mode（按进程是否存活判定 ⇒ 常驻但未运行时 Shell 仍可用，必须红）；关闭常驻模式后同一会话的 Shell 标签页恢复可用
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-api-smoke-human-gate
  - gap-lifecycle-mode-matrix-and-host-api
goal_ac: AC-174
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn '^goal_ac: *AC-174' tasks/*.md | wc -l` → **0**；`grep -rln 'AC-174' tasks/*.md` → **2** 个文件 2 处命中，逐处核对**都在非目标段且都是让位**：`tasks/gap-claude-resident-status-bar.md:57` 逐字「AC-174 的 Shell 标签禁用」、`tasks/gap-claude-resident-running-view.md:50` 逐字「AC-174 的 Shell 标签禁用」；两条的顶层 `goal_ac` 分别是 AC-172 / AC-173，都不认领本条。按机制词再扫：`grep -rl 'shell-tab' tasks/*.md | wc -l` → **0**；`grep -rl '常驻会话不支持 Shell' tasks/*.md | wc -l` → **0**；`grep -rl 'resident-shell' tasks/*.md | wc -l` → **0**；`grep -rl 'Shell 标签' tasks/*.md | wc -l` → **2**（即上面那两处让位）。⇒ AC-174 无认领者，本条不是重复。

**来源与判据物。** 判据逐字取自 `goals/AC-174-真实浏览器里常驻会话的-shell-标签页不可用-关闭常驻模式后恢复.md` 的 `criterion:`：`npx playwright test e2e/resident-shell-tab.spec.ts`（命令逐字含文件路径，不用 glob）。`expect` 逐字（同文件 `:8-9`）：「常驻会话里 Shell 标签页禁用并显示「常驻会话不支持 Shell，关闭常驻模式后可用」，判定只看 lifecycle_mode、与进程是否存活无关；关闭常驻模式后同一会话的 Shell 标签页可用。取假形态：按进程是否存活判断 ⇒ 常驻但未运行时 Shell 可用，必须红。」

**红态基线（本轮直跑，读数不是推断）**：`npx playwright test e2e/resident-shell-tab.spec.ts --list` 退出 **1**，stderr 逐字 `Error: No tests found.` 与 `Make sure that arguments are regular expressions matching test files.`，stdout 逐字 `Total: 0 tests in 0 files`（`--list` 只做收集、不起 webServer，因此这条读数与判据同为「该文件不存在」这同一个事实）。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑既有 `npx playwright test e2e/model-env-kind-explanations.spec.ts --list` → 退出 **0**，读数逐字 `model-env-kind-explanations.spec.ts:37:3 › model env kind explanations › every kind explains itself in the browser and unset is linked via aria-describedby` / `Total: 1 test in 1 file`。全库收集基线同轮实测：`npx playwright test --list` → `Total: 70 tests in 14 files`。

**现状（本轮实测的读数）—— Shell 标签今天无条件可用，常驻这一格在前端一行都没有**

- **判据文件不存在**：`ls e2e/resident-shell-tab.spec.ts` → `No such file or directory`；`ls e2e/ | grep -ci resident` → **0**。
- **前端零常驻面**：`grep -rn 'resident\|Resident' src/ --include=*.ts --include=*.tsx | wc -l` → **0**；`grep -rn 'lifecycle_mode\|lifecycleMode' src/ --include=*.ts --include=*.tsx | wc -l` → **0**。服务端今天也**还没有这一列**：`grep -rn 'lifecycle_mode' server/ --include=*.ts | wc -l` → **0**（`server/` 里的 `lifecycleModes` 全是 provider 能力矩阵的驼峰字段，`provider-capabilities.service.ts:79` 逐字 `lifecycleModes: ['per-run']`）⇒ 本条判定要读的 `sessions.lifecycle_mode` 由 AC-169 落地，是本条的真前置。
- **Shell 标签今天无条件启用**：`src/modules/project-workspace/WorkspaceTabs.tsx:45-49` 的 `BASE_TABS` 逐字含 `{ id: 'shell', labelKey: 'tabs.shell', icon: Terminal }`；`:143-175` 的渲染是 `tabs.map(...)` → `<Pill role="tab" aria-selected={isActive} onClick={() => setActiveTab(tab.id)}>`，**没有 `disabled`、没有 `aria-disabled`、没有 `data-*` 钩子**。`src/shared/ui/PillBar.tsx:28-46` 的 `Pill` 把 `...props` 摊到 `<button>` 上 ⇒ `disabled`/`aria-disabled`/`data-*`/`title` 今天就能透传，缺的只是调用点传入。
- **会话对象已经在这条组件链上**：`src/modules/project-workspace/WorkspaceHeader.tsx:15` 逐字 `selectedSession: ProjectSession | null;`，`:132-137` 渲染 `<WorkspaceTabs activeTab setActiveTab shouldShowTasksTab shouldShowBrowserTab />`（**没把会话传下去**），`:112-118` 渲染移动端的 `<CollapsedWorkspaceSelector …>`（同样四个 props）。`src/shared/types.ts:108-130` 的 `ProjectSession` 带 `[key: string]: unknown` ⇒ 服务端列一旦回传，字段即随行到达。⇒ 判定源的接线点就在这里，**不需要新 hook**。
- **Shell 视图按 `activeTab` 挂载**：`src/modules/project-workspace/WorkspaceMain.tsx:186-196` 逐字 `{activeTab === 'shell' && (<StandaloneShell … isActive={activeTab === 'shell'} />)}` ⇒ 只禁用按钮、不守卫已激活态的话，一个已停在 Shell 上的会话被转为常驻后终端仍开着（「不可用」不成立）。
- **菜单项形状现成**：`src/modules/sidebar/SessionOptions.tsx:165-205` 的 `items={[…]}`，条件项的范式在 `:181-188` 逐字 `...(canFork && onFork ? [{ key: 'fork', label: 'Fork session', … onSelect: onFork }] : [])`；该文件的 `t` 是**调用方传进来的 prop**（`:37` 逐字 `t: TFunction;`、`:66` 解构），标签绝大多数是英文字面量（`:168` `label: 'Rename session'`、`:197` `label: 'Archive or delete session'`），只有 `sessionFilter.*` 两格走 `t(...)`（`:190-191`）。调用方两处：`src/modules/sidebar/SidebarSessionItem.tsx:433` 与 `src/modules/sidebar/SidebarRecentConversations.tsx:217`；该文件自己的头注释（`:40-44`）逐字写着两行共享同一份实现就是为了「the two rows cannot drift」⇒ 这一格必须两处都能到。
- **文案面**：`tabs.*` 在 `src/modules/i18n/locales/*/common.json` 的 `tabs` 对象里（`en` 逐字 `{"chat":"Chat","shell":"Shell","files":"Files","git":"Source Control","tasks":"Tasks","browser":"Browser","computer":"Computer"}`），12 个 locale 目录都在（`ls src/modules/i18n/locales/ | wc -l` → 12）；会话菜单的文案面是 `sidebar.json`（调用方的 `t` 由 `useTranslation(['sidebar','common'])` 绑定）。本仓补键的惯例是 **12 个全补**。
- **判据有 55 秒上限**：`playwright.config.ts:285` 逐字 `const SINGLE_SPEC_CEILING_MS = 55_000;`；`SPEC_BUDGET_MS`（`:287-289`）只有 `mobile-workspace-composer-layout.spec.ts` 一个例外 ⇒ 本判据必须在 **55s** 内自己结束（打印墙钟）。
- **本判据不需要调试 agent 替身、也不需要碰 `playwright.config.ts`**（与 AC-172/173 的关键区别）：proposal §6（`docs/proposals/claude-resident-sessions.md:281`）逐字「`lifecycle_mode … 表示用户对该会话的**偏好**，不代表进程是否存在」；§10（`:356`）逐字「**启动**：用户首次在常驻会话中发送消息，或手动点"启动"时，才懒启动。**不在服务启动时自动拉起**」⇒ 「常驻但未运行」**不需要任何替身**：把会话的 `lifecycle_mode` 置为 `resident` 而不发消息，进程本来就不存在（`GET /api/session-hosts` 里没有它）。这正是假形态要打的靶心。
- **判据为什么不能读宿主快照**：`server/modules/session-hosts/session-hosts.routes.ts:67` 的 `GET /` 投影 `hosts[].hostId/provider/mode/state/pid/startedAt/closeReason/bindings[].appSessionId/state/leases` —— 它说的是**进程在不在**，而本条要的判定说的是**偏好是什么**。两者在「常驻但未运行」这个状态上**读数相反**（快照说无宿主，偏好说 resident），这正是假形态能被打红的原因。

<!-- dedup-ref --> **两条真前置（关系边已写成顶层 `depends_on`，本段只作溯源）**：`gap-claude-resident-api-smoke-human-gate`（`goal_ac: AC-170`，status=todo）—— AC-170 的 `expect` 逐字「UI 相关 AC（AC-171 至 AC-175）的派工任务以本条对应的任务为前置」，人 yale 在 `docs/proposals/claude-resident-sessions-smoke.md` 写下 `冒烟验收：通过` 之前，本条不得开工。`gap-lifecycle-mode-matrix-and-host-api`（`goal_ac: AC-169`，status=todo）—— 本条判定要读的 `sessions.lifecycle_mode`（读回投影与字段名）、能力矩阵里 claude 的 `'resident'` 取值、以及**模式切换的写入口**（本条判据与菜单项都调它，不另写第二条写路径）都是它落的。两条机制与本条不相交（一条人工冒烟、一条偏好列与模式切换 API），故硬串行、不并发。`gap-claude-resident-process-survival`（AC-161，status=ready）是 AC-169 自己的前置，本条经 AC-169 传递覆盖，不重复加边。

**与同期兄弟的边界（本条不重复它们）**：`gap-claude-resident-consent-gate`（AC-171）own 的是**开启方向**的知情门控——新建会话的常驻开关与 `SessionOptions` 的「**转为常驻…**」及其勾选框；本条 own 的是**关闭方向**（「关闭常驻模式」）与 Shell 标签的禁用，「转为常驻…」不在本条范围。`gap-claude-resident-status-bar`（AC-172）own 的是会话内状态条、四态标记、popover 与 [关闭常驻进程]（关的是**进程**，不是模式）；本条 own 的是**模式→Shell 可用性**这条因果。`gap-claude-resident-running-view`（AC-173）own 的是 Running 视图分组与侧栏徽标；本条不碰它们。**重叠面**（各自独立、互不依赖）：`SessionOptions.tsx` 与 `src/shared/api.ts` 同时被 AC-171 与本条各加一格/一个客户端方法，`common.json`/`sidebar.json` 各补各的键。

**要建的东西（范围是 AC-174 的最小充分集）**

1. **判定源接线（承重件）**：`WorkspaceHeader` 把 `selectedSession` 的 `lifecycle_mode`（AC-169 落地后的**实际字段名**，第一步先量）传给 `WorkspaceTabs` 与 `CollapsedWorkspaceSelector`；Shell 标签的可用性**只**由它派生（`resident` ⇒ 禁用），**不读** `GET /api/session-hosts`、不读任何进程/宿主状态。
2. **Shell 标签的禁用与契约**：`WorkspaceTabs.tsx` 给 shell 格子加 `disabled`/`aria-disabled="true"` 与稳定契约（`data-workspace-tab="shell"` + `data-disabled-reason="resident"`），点击不改变 `activeTab`；移动端 `CollapsedWorkspaceSelector` 用同一判定。提示句（逐字「常驻会话不支持 Shell，关闭常驻模式后可用」）以**可稳定读取**的形式进 DOM：`title` 属性或 `aria-describedby` 指向的元素（二者至少其一，判据打印用的是哪一种）。
3. **已激活态的守卫**：`WorkspaceMain.tsx` 在 `activeTab === 'shell'` 且会话为常驻时**不挂载** `StandaloneShell`，改渲染同一句提示的提示块（`[data-resident-shell-notice]`）；会话在 Shell 上被转为常驻时**同页立即生效**。
4. **「关闭常驻模式」菜单项**：`SessionOptions.tsx` 的 `items` 加一格（条件 = 该会话 `lifecycle_mode === 'resident'`），`onSelect` 走 **AC-169 的模式切换写入口**（经 `src/shared/api.ts` 的客户端方法），成功后界面就地读回 `per-run`。会话对象经两个调用方（`SidebarSessionItem.tsx`、`SidebarRecentConversations.tsx`）传入（新 prop **可选**，以免弄红既有单测）。
5. **文案进 12 个 locale**：`common.json` 的 Shell 提示句（如 `tabs.shellResidentDisabled`）与会话菜单的关闭项标签/描述（如 `sidebar.json` 的 `sessionMenu.closeResident*`）；12 个全补、非空，判据运行期从出货目录读句子、不抄进 spec。
6. **判据 `e2e/resident-shell-tab.spec.ts`**：真浏览器 + 真服务；per-run 正控制 → 经 AC-169 的写入口置 `resident`（常驻但未运行，打印宿主快照证明无进程）→ 断言禁用 + 提示 + 点击不切换 → 菜单「关闭常驻模式」→ 断言恢复可用并能切进 Shell 视图；一条假形态臂。

**非目标**：AC-171 的知情门控、「转为常驻…」与新建会话的常驻开关；AC-172 的状态条、四态标记、popover、[关闭常驻进程] 与无人轮呈现；AC-173 的 Running 分组与徽标；AC-175 的忙时直发与撤回；AC-169 的列/能力矩阵/`start|close` 路由**本身**（本条只消费）；§15.2 的「关闭常驻模式」**二次确认框**（它要读宿主 lease 清单，属 AC-172 的 lease 面；本条判据的会话无后台工作，走的正是「没有就直接切换」那一支）；任何真实 claude 二进制、任何 subprocess 形状、任何调试 agent 场景（本条不需要替身）。

## Plan

1. **量 AC-169 落地后的实际形状**（任一尚不具备时判据**点名拒绝**，缺哪件就打印哪件，不写假读数）：`sessions.lifecycle_mode` 在**浏览器拿到的会话对象**上的字段名与取值；模式切换写入口的 HTTP 形状（路径/方法/报文/状态码）与其**是否拉起进程**（按 proposal §10 应为不拉起；若实测拉起，改为主张只置偏好并**如实登记**这一读数，**不得**让判据去拉 claude）。
2. **判定源接线**：`WorkspaceHeader` → `WorkspaceTabs` / `CollapsedWorkspaceSelector` 的一个 prop（不新开 hook，不引第二份取数）。
3. **Shell 格子的禁用、契约与提示**；`WorkspaceMain.tsx` 的已激活态守卫。
4. **`SessionOptions.tsx` 的「关闭常驻模式」** + 两个调用方透传 + `src/shared/api.ts` 的写客户端。
5. **12 个 locale 的 `common.json`/`sidebar.json` 文案**。
6. **写判据**：打印模式读数、宿主快照、tab 的 `disabled`/`aria-disabled`/提示/点击后 `activeTab`、菜单点击后的模式读数与 tab 状态、已激活态守卫读数、整体墙钟，并断言 `< 55_000`。
7. **假形态承重变异**：把禁用改成**按进程是否存活**判定（如读 `GET /api/session-hosts` 是否存在该会话的 live host，或等价地把判定挂在「有没有宿主」上）⇒ 判据命令退出**非 0**，红**落在「常驻（未运行）时 Shell 必须禁用」那条断言**上；登记变异 diff、失败断言逐字、退出码；恢复后判据回到 0。
8. `npm run lint` / `npm run typecheck` 绿；`npx playwright test --list` 的收集总数与改动前只差新增的这一个文件；写完成记录。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-shell-tab.spec.ts` 退出 **0**，并打印整体墙钟 `elapsed=<n>ms` 且 `< 55_000`（`playwright.config.ts:285` 的单文件上限）。红态基线本轮实测：`--list` 退出 **1**、`Error: No tests found.` / `Total: 0 tests in 0 files`；正控制同形状跑 `e2e/model-env-kind-explanations.spec.ts --list` 退出 **0**、`Total: 1 test in 1 file`。
- [x] AC2 常驻（且进程不存在）时 Shell 禁用并出提示（**假形态的落点**）：判据打印 `mode=<resident>`、`hosts.forSession=<0>`（宿主快照里没有该会话，证明「常驻但未运行」）、`shellTab.disabled=<true>`、`shellTab.ariaDisabled=<true>`、`shellTab.notice=<逐字>`、`shellTab.notice.source=<title|aria-describedby>`、`tabClick.after=<activeTab 不变>`；断言 `notice` 与运行期从 `src/modules/i18n/locales/en/common.json` 读出的那句**逐字相等**，且点击不改变 `activeTab`。
- [x] AC3 正控制（证明断言非恒真）：同一次运行里先用 **per-run** 会话打印 `mode=per-run`、`shellTab.disabled=false`、`tabClick.after=shell`（点得进去）；并打印 `chatTab.disabled=false`（在 Shell 被禁的那些时刻）⇒ 禁用不是把整条 tablist 关掉。
- [x] AC4 关闭常驻模式后恢复：判据点会话菜单的「关闭常驻模式」（打印 `menu.item=<present>`、`menu.enabled=<true>`），打印 `mode.afterClose=per-run`、`shellTab.disabled.after=false`、`tabClick.afterClose=shell`、`shellView.mounted=true`；**正控制**：点击**前**同一格是 `mode=resident` 且 Shell 禁用（打印那一行）。
- [x] AC5 已激活态的守卫：判据在 Shell 标签**处于激活态**时把会话置为 `resident`，打印 `shellView.mounted.afterResident=false`、`notice.inView=<逐字>`、`activeTab=<非 shell>`；断言 `notice.inView` 与 `common.json` 的那句逐字相等。
- [x] AC6 假形态必须红（承重）：把禁用改成按进程是否存活判定（读 `GET /api/session-hosts` 的宿主存在性）⇒ 判据命令退出**非 0**，且红**落在 AC2 的 `shellTab.disabled === true` 那条断言**上（登记变异 diff、失败断言逐字、退出码）。恢复后判据回到 0。
- [x] AC7 文案 12 locale：新增 key（Shell 的提示句与其可访问名、会话菜单关闭项的标签与描述）在 **12 个 locale** 的 `common.json`/`sidebar.json` 里都存在且非空；判据打印 `locales.ok=12`、`locales.missing=<[]>`，任一缺失以非 0 退出并打印是哪个文件哪个 key；句子运行期从出货目录读，spec 里不抄。
- [x] AC8 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --stat` 与 Touches 逐条对齐（多写的文件须由判据强制）。
- [x] AC9 不波及别的判据：`npx playwright test --list` 打印 `files.before=14 files.after=15 tests.before=70 tests.after=<70+n>`，新增的**唯一**文件是 `resident-shell-tab.spec.ts`；`npx playwright test e2e/model-env-kind-explanations.spec.ts` 仍退出 **0**（打印退出码与墙钟）。

## DoD

- 判据在**真浏览器**里跑：真服务、真会话，**不拉起 claude**、不用调试 agent 替身；「常驻但未运行」由 §10 的懒启动语义天然给出（置偏好、不发消息）。
- 禁用与恢复的读数都是判据的**原始输出行**（`mode.*` / `shellTab.*` / `tabClick.*` / `menu.*` / `shellView.*` / `hosts.forSession`），不是转述。
- 判定源**只**是 `lifecycle_mode`：判据在宿主快照里**没有**该会话（`hosts.forSession=0`）时断言仍禁用，且假形态（按存活判定）在同一读数上真的红 —— 二者合起来证明判定与进程存活无关。
- 有**正控制**（per-run 时可用、chat 标签始终可用）与**已激活态守卫**（停在 Shell 上转常驻 ⇒ 视图卸载并出提示），证明禁用/恢复两个方向都不是恒真也不是恒假。
- 假形态**真的跑过并真的红**，红在 AC2 的禁用断言上（不是任何一条断言都行）。
- 「关闭常驻模式」走 AC-169 的模式切换写入口；前端没有第二份模式写路径。
- 单文件判据在 **55s** 内自己结束（打印墙钟），不是被看门狗或 60s 闸门外部击杀。
- 只动 Touches 列出的文件；不改 AC-161/162/164/169/170/171/172/173/175 的范围。

## Touches

- `e2e/resident-shell-tab.spec.ts` (new)
- `src/modules/project-workspace/WorkspaceTabs.tsx`
- `src/modules/project-workspace/WorkspaceHeader.tsx`
- `src/modules/project-workspace/WorkspaceMain.tsx`
- `src/modules/sidebar/SessionOptions.tsx`
- `src/modules/sidebar/SidebarSessionItem.tsx`
- `src/modules/sidebar/SidebarRecentConversations.tsx`
- `src/shared/api.ts`
- `src/modules/i18n/locales/en/common.json`
- `src/modules/i18n/locales/zh-CN/common.json`
- `src/modules/i18n/locales/zh-TW/common.json`
- `src/modules/i18n/locales/de/common.json`
- `src/modules/i18n/locales/es/common.json`
- `src/modules/i18n/locales/fr/common.json`
- `src/modules/i18n/locales/id/common.json`
- `src/modules/i18n/locales/it/common.json`
- `src/modules/i18n/locales/ja/common.json`
- `src/modules/i18n/locales/ko/common.json`
- `src/modules/i18n/locales/ru/common.json`
- `src/modules/i18n/locales/tr/common.json`
- `src/modules/i18n/locales/en/sidebar.json`
- `src/modules/i18n/locales/zh-CN/sidebar.json`
- `src/modules/i18n/locales/zh-TW/sidebar.json`
- `src/modules/i18n/locales/de/sidebar.json`
- `src/modules/i18n/locales/es/sidebar.json`
- `src/modules/i18n/locales/fr/sidebar.json`
- `src/modules/i18n/locales/id/sidebar.json`
- `src/modules/i18n/locales/it/sidebar.json`
- `src/modules/i18n/locales/ja/sidebar.json`
- `src/modules/i18n/locales/ko/sidebar.json`
- `src/modules/i18n/locales/ru/sidebar.json`
- `src/modules/i18n/locales/tr/sidebar.json`
- `tasks/gap-claude-resident-shell-tab.md`（自触）
## 执行记录

**判据：`npx playwright test e2e/resident-shell-tab.spec.ts` → 退出 0，`1 passed (17.4s)`，`elapsed=17376`（< 55_000 上限），整命令墙钟 `real 0m18.072s`。** 同一条命令的两条读数（本轮真跑，非转述）：

```
locales.ok=12 / locales.missing=[]                       ← AC7
capability.residentProviders=claude
mode.write.perRun={"provider":"claude","sessionId":"e2e-mobile-send-key","mode":"per-run","changed":false,"closedHostReason":null}
mode=per-run / shellTab.disabled=false / chatTab.disabled=false / tabClick.after=shell / shellView.mounted=true   ← AC3 正控制
guard.activeTab.before=shell / mode=resident / activeTab=chat                       ← AC5
shellTab.disabled=true / hosts.forSession=0 / shellView.mounted.afterResident=false
notice.inView=Shell is unavailable for resident sessions. Close resident mode to use it.
shellTab.disabledReason=resident / shellTab.ariaDisabled=true / shellTab.notice=<同一句> / shellTab.notice.source=title
tabClick.before=chat / tabClick.refused=true / tabClick.after=chat / chatTab.disabled=false          ← AC2
mode.beforeMenu=resident / shellTab.disabled.beforeMenu=true / menu.item=present / menu.enabled=true  ← AC4
mode.afterClose=per-run / shellTab.disabled.after=false / tabClick.afterClose=shell / shellView.mounted=true
```

**判定源（与 Plan 1/2 的偏差，如实登记）。** Plan 假定 `lifecycle_mode` 会随 `ProjectSession` 对象到达 `WorkspaceHeader`，接线点就是 `selectedSession`。落地时实测不成立：浏览器拿到的会话对象上没有这一列（projects 列表的 `mapSessionRowToSummary` 把该列丢掉了，而那个文件不在 Touches 内），`GET /api/session-hosts` 的 `sessions[].lifecycleMode` 是**唯一**对浏览器发布该偏好的面（`hosts[]` 只答「进程在不在」，两者在「常驻但未运行」上读数相反）。因此判定源改为该 listing 的 `sessions[].lifecycleMode`，由 `WorkspaceMain` 持有并以 2s 轮询刷新（模式在侧栏菜单里改，没有任何广播）；`WorkspaceTabs`/`CollapsedWorkspaceSelector` 仍只收一个 prop，未新开 hook、未引第二份取数。**仍然只读偏好、不读任何进程/宿主状态**——这正是 AC6 的靶心。

**偏差：`SidebarSessionItem.tsx` / `SidebarRecentConversations.tsx` 未改。** Plan 4 要求两个调用方透传新 prop；实测不需要：菜单打开时 `SessionOptions` 自己读一次 listing（`onOpenChange(true)` 里读），会话对象不必携带模式。anti-drift 是**子集**判定，声明了未写不算违规；两文件仍在 Touches 里未写，此处登记以备审阅者核对。

**AC6 假形态（承重，真跑真红，已恢复）。** 变异：把判定从「偏好」换成「有没有 live host」——

```diff
-          data?: { sessions?: { appSessionId?: string; lifecycleMode?: string }[] };
+          data?: {
+            hosts?: { bindings?: { appSessionId?: string }[] }[];
+            sessions?: { appSessionId?: string; lifecycleMode?: string }[];
+          };
-        const row = body.data?.sessions?.find((entry) => entry.appSessionId === selectedSessionId);
-        setLifecycleMode({ sessionId: selectedSessionId, mode: row?.lifecycleMode ?? 'per-run' });
+        const hasLiveHost = (body.data?.hosts ?? []).some((host) =>
+          (host.bindings ?? []).some((binding) => binding.appSessionId === selectedSessionId));
+        setLifecycleMode({ sessionId: selectedSessionId, mode: hasLiveHost ? 'resident' : 'per-run' });
```

变异下**同一命令退出 1**，红**逐字落在 AC2 的那条断言上**（前一行打印的正是假形态的读数：`mode=resident / activeTab=shell / shellTab.disabled=false`，即「常驻但未运行时 Shell 仍可用」）：

```
Error: a resident session must close the Shell tab — and this session has no live process, so a reading that asked whether one exists would say the opposite
expect(received).toBe(expected) // Object.is equality
Expected: true
Received: false
> 445 |   ).toBe(true);
   at e2e/resident-shell-tab.spec.ts:445:5
 1 failed        (整命令墙钟 real 0m34.901s)
```

恢复后同命令回到退出 **0**（`elapsed=16890`）。**为确保红只落在这一条上，本轮把 AC2 的禁用读数挪到该状态下的第一处断言**：先有界地等「标签已禁用且视图已离开 Shell」（两者同源于一个属性、同一渲染到达），再断言 `shellTab.disabled === true`，其后才是 AC5 的 `notice.inView` / `activeTab`。

**AC8 契约面。** `npm run lint` 退出 **0**（171 条 warning 全为既有、无一条落在本 delta 的文件上：`grep -E "WorkspaceTabs|WorkspaceHeader|WorkspaceMain|SessionOptions|shared/api|resident-shell-tab"` 无命中）；`npm run typecheck` 退出 **0**（三环 `tsconfig.json` / `server/` / `scripts/` 全过）；`git diff --stat` = 29 文件（24 locale + `WorkspaceTabs`/`WorkspaceHeader`/`WorkspaceMain`/`SessionOptions`/`shared/api` + 新 `e2e/resident-shell-tab.spec.ts`），**全部 ⊆ Touches**，未写 Touches 之外任何文件。

**AC9 不波及别的判据。** 同一棵树、同一份 `playwright.config.ts` 做 A/B（把新 spec 移开再收集）：`Total: 68 tests in 14 files` → `Total: 69 tests in 15 files`，文件集差集**只有** `resident-shell-tab.spec.ts`（`diff` 逐行只多这一行；worktree 的 `git status --short e2e/` 只有它一条 `??`）。**注意**：任务立案时登记的基线是 `70 tests in 14 files`，本轮实测的基线是 **68**——develop 在立案后动过（收集总数由配置与 develop 上的 spec 集决定），本条的实质不变量「只多一个文件、只多一条 test」成立。兄弟判据 `npx playwright test e2e/model-env-kind-explanations.spec.ts` 退出 **0**、`1 passed (10.2s)`、墙钟 `real 0m10.894s`。

**AC7 文案。** 12 个 `common.json` 各补 `tabs.shellResidentDisabled`（en 逐字 `Shell is unavailable for resident sessions. Close resident mode to use it.`、zh-CN 逐字「常驻会话不支持 Shell，关闭常驻模式后可用」）与 `tabs.shellResidentDisabledLabel`；12 个 `sidebar.json` 各补 `sessionMenu.closeResidentMode` / `closeResidentModeHint` / `closeResidentModeFailed`。**比 AC7 列的四格多一格**：`closeResidentModeFailed`（转换/关闭被服务端拒绝时就地说明，与同文件既有的 `residentConsentFailed` 同形）。en/zh-CN 的 `sessionMenu` 是既有对象，其余 10 个文件此前**没有** `sessionMenu` 键（本轮新建该对象作为首个键）；24 个文件在写入前都往返校验过 `json.dumps(indent=2, ensure_ascii=False)` 逐字节一致，故 diff 是最小的。句子在运行期从出货目录读（spec 里不抄），任一缺失以非 0 退出并点名文件与 key。

**Touches 之外没有第二份模式写路径**：`SessionOptions.closeResidentMode` 与既有的 `convertToResident` 走同一个客户端方法 `api.providers.setSessionLifecycleMode`（`src/shared/api.ts` 已有，本轮未改它，只加了只读的 `sessionHostListing`）。

**判据跑在真浏览器 + 真服务上，未拉起 claude**：驱动的会话是配置预置的 `e2e-mobile-send-key`（一条已发现的真实会话），全程只经 HTTP 改偏好、不发消息；`hosts.forSession=0` 证明「常驻但未运行」由懒启动语义天然给出，无需任何替身。

**合并 develop 后在合并树上复测（AC1 的读数，按驱动步序如实补记）。** `git merge --no-edit develop` 无冲突（并入的两个文件都是台账类，未触任何源码）；合并树上重跑判据 → 退出 **0**、`1 passed`、`elapsed=31978`、整命令墙钟 `real 0m32.699s`。同一份判据在合并前实测 `elapsed=17376` / `16890`（墙钟 18.1s / 17.6s）⇒ 本轮 32s 是**宿主负载**造成的同一读数变慢，仍**低于 55_000 的判据上限**，也低于 60s 的单测上限；登记此差异供审阅者判读（判据没有依赖墙钟的阈值，除 AC1 的 `< 55_000` 外无任何计时断言）。合并后再跑 `bash scripts/test.sh --for-task gap-claude-resident-shell-tab --allow-thin` → 退出 **0**、逐字 `no scoped test files for gap-claude-resident-shell-tab (thin)`；scoped-gate 缓存按 develop sha `e92ac433815581a9002bc06e86dd5f5188840a9d` 写入 `/data/home/yale/work/claudecodeui/.quay/scoped-gate-cache.json`。
