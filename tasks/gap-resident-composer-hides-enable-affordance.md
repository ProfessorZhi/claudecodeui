---
id: gap-resident-composer-hides-enable-affordance
title: AC-178 已常驻会话的输入区不再渲染常驻开关与知情提示：给开关加 data-resident-enable 标记、渲染门加
  !isResidentSession，e2e 双模式读数 + 正控制 + 假形态 + 结构不变量
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-178
---
## Proposal

<!-- dedup-ref --> 机制去重读数（2026-09-29 本轮实测）：`grep -rln '^goal_ac: *AC-178' tasks/` → **0**；`grep -rln 'canRunResident' tasks/` → **0**；`grep -rln 'resident.toggle\|开启开关\|resident-consent-notice' tasks/` 命中 `gap-resident-i18n-duplicate-key-shadows-toggle-and-notice.md`（goal_ac: AC-171，status: needs-human）、`gap-resident-popover-close-reachable-narrow-viewport.md`（goal_ac: AC-177）、`gap-claude-resident-busy-send-ui.md`（goal_ac: AC-175）。AC-171 那条的 DoD 逐字写着「第 2 到 4 类界面缺陷（弹层关闭被盖、已常驻会话仍显示开关、状态条压消息）不在本任务，另立 AC 与任务」——本条正是其中第二类「已常驻会话仍显示开关」，与该任务机制不相交（AC-171 修的是 locale 文件重复键，不碰 `ChatComposer` 的渲染门）。AC-175 管忙时输入，AC-177 管弹层可点击性，都不隐藏开关。⇒ AC-178 无认领者，本条不是重复。三条 AC（177/178/179）共用新建的 `e2e/resident-ui-layout.spec.ts`，但断言对象不同，本条只实现 `-g "resident session hides enable affordance"` 命中的那条 test，不实现另两条。

**判据物。** 逐字取自 `goals/AC-178-已经是常驻的会话-输入区不再显示开启开关与知情提示.md` 的 `criterion:`：`npx playwright test e2e/resident-ui-layout.spec.ts -g "resident session hides enable affordance"`（命令逐字含文件路径与 `-g` 过滤）。`expect` 逐字（同文件 :9-11）：「会话宿主列表读回 lifecycleMode 为 resident 之后，输入区不出现常驻开关，也不出现知情提示与勾选框；同一次运行里一个 per-run 的新会话输入区仍出现开关（正控制，证明读数不是恒空）。取假形态：无论会话模式都渲染开关与知情提示 ⇒ 必须红，且红落在已常驻会话这一条读数上。」`origin` 逐字（同文件 :12-13）：「同日验证时已常驻会话的输入区仍显示开关与整段知情提示，占掉大半个输入区，把对话挤得几乎看不见。关闭在状态条与会话菜单里，这里没有第二个入口。」

**红态基线（本轮实测，不是推断）。** `ls e2e/resident-ui-layout.spec.ts` → `No such file or directory`；`ls e2e/ | grep -i resident` → `resident-busy-send.spec.ts` / `resident-enable-consent.spec.ts` / `resident-running-view.spec.ts` / `resident-shell-tab.spec.ts` / `resident-status-bar.spec.ts`（5 个，无 ui-layout）。所以判据今天必然红，红因是「该文件不存在」。命令形状本身可用：同形状对既有文件 `npx playwright test e2e/resident-status-bar.spec.ts --list` 能收集。

**现状（本轮直读的代码事实）—— 输入早就算好了，只是渲染门没用它**

- **判断已经在。** `src/modules/chat/composer/ChatComposer.tsx:258-261` 逐字：`const { snapshot: hostsSnapshot } = useSessionHosts();` 与 `const isResidentSession = sessionId ? findSessionHostState(hostsSnapshot, sessionId)?.lifecycleMode === 'resident' : false;`。它读的就是会话宿主列表（`GET /api/session-hosts` 的 `data.sessions[].lifecycleMode`；`src/shared/hooks/useSessionHosts.ts:288` 的 `findSessionHostState`；e2e 侧同读法见 `e2e/resident-enable-consent.spec.ts:195-203` 的 `sessionModes`）。同一个值已经用在忙时发送语（`:405` `busySendGoesToProcess`）上——所以本条只需把已有输入接到渲染门上，不新增数据通路。
- **渲染门没读它。** `ChatComposer.tsx:615` 逐字 `{canRunResident && (`，里面是 `role="switch"` 的常驻开关（`:617-643`，`aria-label={t('resident.toggle')}`），开关打开时其下渲染 `ResidentConsentNotice`（`:644-651`，`data-slot="resident-consent-notice"` + 勾选框）。`canRunResident = residentProviders.has(readSelectedProvider())`（`:275`）只问「这个 provider 支不支持常驻」，不问「这个会话是不是已经常驻」。
- **所以：已常驻会话 → `isResidentSession=true`、`canRunResident=true` → 开关照渲染**，与 origin 的现场逐字一致。
- **输入区的根 class。** `ChatComposer.tsx:448` 逐字 `className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6"`——判据用它把读数作用域钉死在输入区内（页面上还有暗色模式开关，见下）。

**i18n 现状给判据的硬约束（必须绕开，否则会被 AC-171 阻塞）。** `src/modules/i18n/locales/en/chat.json` 有两个顶层 `"resident"`（第 2 行、第 390 行；`zh-CN/chat.json` 第 2、311 行同样），`JSON.parse` 只留后者，故运行期 `resident.toggle` 与 `resident.notice.*` 均为 `undefined`（本轮实测：`JSON.parse(en/chat.json).resident` → `['pending','statusBar','divider','stopResident']`，`.toggle` 与 `.notice` 都是 `undefined`）。这正是 AC-171 的题（现 `needs-human` 未修）。后果有二：(a) `getByRole('switch', { name: enChat.resident.toggle })` 在 `name` 为 `undefined` 时**不过滤名字**，页面上（常驻开关 + `src/shared/ui/DarkModeToggle.tsx:16` 的 `Toggle dark mode`）会 `strict mode violation: getByRole('switch') resolved to 2 elements`——AC-171 的判据此刻就是这么红的；(b) 通知区当前显示原始键名。⇒ 本条判据**不得依赖这两个 i18n 键**：开关用**结构标记**读（本条给开关加 `data-resident-enable="true"`，与既有 `data-resident-*` 家族一致），通知用 `data-slot="resident-consent-notice"` 读，且所有读数**作用域限定在 `.chat-composer-shell`**。这样本条与 AC-171 各有独立判据、互不阻塞。

**要建的东西（AC-178 的最小充分集）**

1. **修（最小改动）。** (a) 给常驻开关的 `<button role="switch">` 加 `data-resident-enable="true"`；(b) 把 `ChatComposer.tsx:615` 的渲染门从 `canRunResident` 改为 `canRunResident && !isResidentSession`。通知与勾选框在开关之内，随之消失。**不新增任何关闭/退常驻入口**（§15.4 的关闭仍在状态条弹层与会话菜单）。不改 `data-slot="resident-consent-notice"` 契约。
2. **判据** `e2e/resident-ui-layout.spec.ts`（新建；**与 AC-177/AC-179 共用本文件，见 DoD 的并集语义**），`-g "resident session hides enable affordance"` 命中的那条 test：真浏览器、真服务；复用 `e2e/resident-status-bar.spec.ts` 的 debug-agent scenario 写法（`armScenario` → `POST /api/debug-agent/scenarios`，`seed.lifecycleMode` 建会话；`POST /api/debug-agent/clock` 推进）arm 一条 `lifecycleMode='resident'` 的会话 R，另 arm 一条 `lifecycleMode='per-run'` 的会话 P；`page.goto('/session/<id>')`（先例 `e2e/resident-shell-tab.spec.ts:398`）打开各自输入区，用 `.chat-composer-shell` 作用域读数。
3. **门控并集。** `playwright.config.ts:1378` 的 `DEBUG_AGENT_SPEC_FILES` 追加 `'resident-ui-layout.spec.ts'` 并加一行注释（该常量被多条常驻 e2e 任务各自追加，合并冲突时**取并集**，不取单边）。
4. **假形态。** 把渲染门还原成 `canRunResident`（即无论会话模式都渲染开关与通知）⇒ 判据必须红，红落在「已常驻会话」那条读数上。
5. **结构不变量 vitest。** `src/modules/chat/tests/residentComposerEnableAffordance.test.tsx`（新建），含**反向腿**——给 scoped gate 一条可跑的非 e2e 判据。
6. **预算。** 判据打印整体墙钟并断言 `< 55_000`（`playwright.config.ts:317 SINGLE_SPEC_CEILING_MS = 55_000`；60s 是外层闸门击杀处，超过会被从外面杀掉而什么都不报）。

## Plan

1. 量红态：先在**未修改**的树上跑判据/等价探针，打印 `resident.session=<id>` `session.lifecycle_mode=resident` `composer.switch.count=<n>` `composer.notice.count=<n>` `composer.checkbox.count=<n>`，确认 `switch.count>0`（红态本体）。登记进 Evidence。
2. 按 Proposal 1 落地最小改动（加 `data-resident-enable` + 渲染门加 `!isResidentSession`）。
3. 写 `e2e/resident-ui-layout.spec.ts` 的 `resident session hides enable affordance` test：arm R（resident）与 P（per-run）；两条读数（AC2/AC3）；打印与墙钟断言。
4. 写 `src/modules/chat/tests/residentComposerEnableAffordance.test.tsx` 结构不变量 vitest（正/反两腿）。
5. `playwright.config.ts` 门控并集追加。
6. 假形态真跑真红，登记变异 diff、逐字失败行、退出码；恢复后 AC1 复绿。
7. `npm run lint` / `npm run typecheck` 绿；`git diff --stat` 与 Touches 逐条对齐；写完成记录。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-ui-layout.spec.ts -g "resident session hides enable affordance"` 退出 **0**，打印 `elapsed=<n>ms` 且 `< 55000`。红态基线（本轮实测）：`ls e2e/resident-ui-layout.spec.ts` → `No such file or directory`。
- [x] AC2 已常驻会话隐藏（承重）：判据打印 `resident.session=<id>` 与 `session.lifecycle_mode=resident`——该值来自 `GET /api/session-hosts` 的 `data.sessions[].lifecycleMode`（不是客户端自造）；`page.goto('/session/<R>')` 后 `.chat-composer-shell` 内 `composer.switch.count=0`、`composer.notice.count=0`、`composer.checkbox.count=0`，三条各配 `expect(...).toBe(0)`。另打印 `composer.visible=true` 与 `pane.visible=true`，证明「0」不是空白页/未渲染的读数（否定假阳性）。
- [x] AC3 正控制（证明读数不是恒空）：同一次运行里 arm 的 per-run 会话 P 打印 `per-run.session=<id>` 与 `session.lifecycle_mode=per-run`，`.chat-composer-shell` 内 `composer.switch.count=1` 且该元素带 `[data-resident-enable="true"]`，配 `expect(...).toBe(1)`。AC2 的「0」与 AC3 的「1」来自**同一个选择器、同一次运行**。
- [x] AC4 假形态必须红（承重）：把 `ChatComposer.tsx:615` 的渲染门还原为 `canRunResident`（无论模式都渲染开关与通知）⇒ 判据退出非 0，**红在 AC2 的已常驻会话读数断言上**（`composer.switch.count` 读到 1；控制腿仍为 1，故红不落在 AC3）；登记变异 diff、逐字失败行、退出码；恢复后 AC1 复绿。
- [x] AC5 结构不变量（非 e2e，给 scoped gate 一条可跑文件）：`npx vitest run src/modules/chat/tests/residentComposerEnableAffordance.test.tsx` 退出 **0**；该文件**含反向腿**（把 mock 宿主快照的该会话改回 `per-run`、或把渲染门改回无条件 ⇒ 该 vitest 红），证明它不是恒绿。读数只用 `[data-resident-enable]` / `[data-slot="resident-consent-notice"]`，不用 `resident.toggle` / `resident.notice.*`（现为 `undefined`）。
- [x] AC6 门控与契约：`playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES` 含 `'resident-ui-layout.spec.ts'`，且非本 spec 选择下 `webServer.env` 逐字不变（`git diff` 只多这一项与一行注释）；`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**。

## DoD

- 判据在**真浏览器**里跑：真服务、真 `GET /api/session-hosts` 读回、debug-agent scenario 驱动，**不拉起真 claude**。
- AC2/AC3 的读数都是判据的**原始输出行**（`session.lifecycle_mode=` / `composer.switch.count=` / `composer.notice.count=` / `composer.checkbox.count=`），不是转述。
- 假形态**真跑过、真红**，红落在 AC2 的已常驻会话读数上；恢复后判据复绿。
- 判据**不依赖** `resident.toggle` / `resident.notice.*` 两个当前 `undefined` 的 i18n 键（AC-171 未修），只用结构标记，故与 AC-171 互不阻塞。
- 不改 AC-172 已钉的 `data-resident-status-bar*` / `data-resident-close` / `data-slot="resident-consent-notice"` DOM 契约；不新增常驻关闭入口；不实现 AC-177（弹层可点击性）与 AC-179（状态条不压消息）。
- 与 AC-177/AC-179 共用 `e2e/resident-ui-layout.spec.ts`：若该文件已由兄弟任务创建，则**追加**本条的 test 与其所需 helper（取并集），不重写别人已写的用例、不改其 `-g` 命中的 test 标题；各自只认领自己 AC 的范围。
- 单文件判据在 **55s** 内自己结束（打印墙钟），不是被 60s 闸门外部击杀。
- 只动 Touches 列出的文件；`DEBUG_AGENT_SPEC_FILES` 的改动是并集语义（跨任务被多条追加，冲突取并集，不取单边）。

## Touches

- `src/modules/chat/composer/ChatComposer.tsx`
- `e2e/resident-ui-layout.spec.ts` (new)
- `src/modules/chat/tests/residentComposerEnableAffordance.test.tsx` (new)
- `playwright.config.ts`
- `tasks/gap-resident-composer-hides-enable-affordance.md`（自触）

## Needs-Human

**执行 2026-09-29T06:42:40.549Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/session-hosts/tests/resident-server-restart.test.ts:   AssertionError [ERR_ASSERTION]: the next boot swept nothing (swept=0); the orphan was not there to reap
- run_id：wk-prod-anchor
- session_id：d21b265b-0dc3-4151-b7fb-2fb2ab342c64
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-composer-hides-enable-affordance~wk-prod-anchor~1790663753615-0fef23.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-composer-hides-enable-affordance-wk-prod-anchor.log

## Evidence

**本轮（2026-09-29，续跑）—— 合并 develop 后逐条复验的原始输出行。**

合并 develop（58 commits，含 `CLAUDE_SESSION_SCOPE_SWEEP: 'off'` 与 session-host-manager 修复）后在真浏览器、真服务上重跑：

- `npx playwright test e2e/resident-ui-layout.spec.ts -g "resident session hides enable affordance"` → **exit 0**：
  - `resident.session=a70c1e77-8ab0-45db-bc22-cad9f2508e9b` / `session.lifecycle_mode=resident`
  - `composer.visible=true` / `pane.visible=true`
  - `composer.switch.count=0` / `composer.notice.count=0` / `composer.checkbox.count=0`
  - `per-run.session=2358353e-80ce-4596-95c1-d2d17512e75f` / `session.lifecycle_mode=per-run`
  - `composer.switch.count=1` / `per-run.switch.marker="true"`
  - `elapsed=10691ms`（< 55000）
- `npx vitest run src/modules/chat/tests/residentComposerEnableAffordance.test.tsx` → **exit 0**（2 passed）。
- `npm run lint` → **exit 0**；`npm run typecheck` → **exit 0**。

**AC4 假形态（真跑真红）。** 变异 diff：

```
-          {canRunResident && !isResidentSession && (
+          {canRunResident && (
```

- e2e → **exit 1**，红落在 AC2 的已常驻会话读数：`composer.switch.count=1`；逐字失败行
  `Error: a session already stored resident has nothing left for the switch to turn on, so it must not render`
  接 `Expected: 0` / `Received: 1`（`e2e/resident-ui-layout.spec.ts:583`）。控制腿仍为 1，故红不落在 AC3。
- 同一变异下的 vitest → **exit 1**（resident 腿红、per-run 控制腿绿），反向腿成立。
- `git checkout -- src/modules/chat/composer/ChatComposer.tsx` 恢复后 AC1/AC5 复绿。

**并集落点（DoD「若该文件已由兄弟任务创建则追加」）。** 合并 develop 时 `e2e/resident-ui-layout.spec.ts`
与兄弟 AC-179 的 `status bar does not cover the transcript` 发生 add/add 冲突：保留 develop 的 test 与其
helper 逐字不动，追加本条 test；本条私有常量/helper 改名 `COMPOSER_*` 以避开顶层重名，并复用 develop 的
`createAccount`/`armScenario`/`readLifecycleMode`/`openPage`/`PANE`/`BAR`/`RUN_STARTED_AT`。
`playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES` 同样取并集，条目只保留一条。

## Needs-Human

**执行 2026-09-29T08:35:35.519Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=61701 server/modules/session-hosts/tests/resident-server-restart.test.ts passed=false end_ms=1790670827744
- run_id：wk-prod-anchor
- session_id：519e2785-4289-4d32-b6aa-3b0c9fc04f74
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-composer-hides-enable-affordance~wk-prod-anchor~1790670699374-d7922a.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-composer-hides-enable-affordance-wk-prod-anchor.log
