---
id: gap-resident-enter-send-spec-still-drives-retired-tick
title: AC-180 的 Enter 判据仍驱动已退休的知情勾选框：重写 e2e/resident-enter-send.spec.ts
  到「开关即意图」的当前设计、收窄 AC-180 记录并清掉提交入口的过期注释
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

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rl "goal_ac: AC-180" tasks/*.md` 只命中 `tasks/gap-resident-enter-send-bypasses-intent-and-consent-gate.md`（status: **done**，上一版修复 75f16302 的归属任务，不是 in-flight 重复）；`grep -rl "resident-enter-send" tasks/*.md` 另命中 `gap-resident-toggle-relocate-drop-consent-gate.md`（status: **done**，它只在「遗留」里点名本判据应由 AC-180 的归属者同步）与 `gap-claude-resident-remote-control-isolation-arm-outside-harness.md`（另一条线）。⇒ 「AC-180 判据文件仍驱动退休勾选框」这一机制目前无人认领，不是重复。

**现象（台账读数）。** AC-180 曾于 2026-09-29T08:33 由 goal-driver 判 pass（`.quay/goal-round.jsonl` round 44 `acceptance passed (exit 0)`），但本轮 goal-driver 直接重跑其判据 `npx playwright test e2e/resident-enter-send.spec.ts` 得非 0 ⇒ 判据当前为假、账本尾巴不成立。

**为什么上一版修复不再成立（不是代码回归）。** AC-180 的判据文件由上一版修复 75f16302（`fix: route Enter through the composer's single submit entry`）落地，当时判据绿、且「Enter 路径与发送按钮共用同一提交入口」这件事是真的——今天读代码它仍然是真的：`src/modules/chat/hooks/useChatComposerState.ts:1206-1225` 的 Enter 分支只做 `event.currentTarget.form?.requestSubmit()`，提交统一落到 `src/modules/chat/composer/ChatComposer.tsx:431-435` 的 `handleComposerSubmit`（那里 `setPendingResidentIntent(residentEnabled)`）。判据变红的原因是之后那次**人 yale 拍板的产品变更**：`gap-resident-toggle-relocate-drop-consent-gate`（6814265d，`feat(resident): move the enable switch under the model card and retire the consent gate`）把「必须先勾选『我了解』」这道闸门整个退休——`resident.notice.acknowledge` 键已从 12 个 locale 的 `chat.json` 全部删除（本轮实测 `grep -rn "acknowledge" src/modules/i18n/locales/*/chat.json` 命中 **0**），勾选框不存在，开关打开即代表意图。那条任务在自己的「遗留」里逐字写明：`e2e/resident-enter-send.spec.ts:310`（AC-180 的判据）仍引用被退休的勾选框标记，应由 AC-180 的归属者同步。

**判据现在红在哪（逐行读数）。** `e2e/resident-enter-send.spec.ts` 第 15 行把 `resident.notice.acknowledge` 写进 locale 类型、第 310 行 `page.getByRole('checkbox', { name: enChat.resident.notice.acknowledge }).check()` 驱动那个已不存在的勾选框（键已删 ⇒ `name` 为 `undefined` ⇒ 匹配不到任何 `checkbox` ⇒ 超时）；第二条用例（原 (b)「未勾选时发送按钮禁用、消息不发出」）的 `expect(gate).toBe(true)`（:369）也不再有主体——闸门已退休，开关一开按钮就可用。`test.describe.configure({ mode: 'serial' })`，第一条用例即红 ⇒ 整个文件非 0。（`NOTICE` 那个 `data-slot` 仍挂在 `ResidentConsentNotice.tsx:51` 的 hint 触发器上，所以 :308 那条可见性断言本身还过——红落在勾选步骤。）

**要保留的不变量（收窄后的 AC-180）。** 闸门退休不改变 AC-180 真正要守的东西：**Enter 与发送按钮是同一个提交入口**，开关位置是这次发送唯一的意图来源，勾选态从来不是它的一部分。于是 AC-180 收窄为：(a) 开关打开后按 Enter 发送，服务端读回该会话 `lifecycle_mode` 为 `resident`，且宿主列表里有该会话的 resident 宿主；(b) 正控制：开关关闭时按 Enter 照常发送、落成 `per-run`。「未勾选不能发出」那一半随闸门一起退休，归入 AC-171 已改写的「开关即时生效」描述。这是把一条自相矛盾的 AC 收窄到它真正的不变量（`[[quay-self-contradictory-ac-narrowed-to-invariant]]`），不是放宽判据——Enter 路径的承重读数（开关开 ⇒ resident + 真宿主）一条不动。

**要建的东西（最小充分集）。**

1. **重写判据** `e2e/resident-enter-send.spec.ts` 到当前设计：删掉 `ChatLocale` 里的 `notice.acknowledge`、`openResidentComposer` 的 `acknowledge` 形参与 :309-311 的勾选分支、以及原 (b) 用例；保留 (a)（开关开 + Enter ⇒ `resident` + resident 宿主）与 (c)（开关关 + Enter ⇒ `per-run`，正控制）。读数仍只取服务端 `GET /api/session-hosts` 的两个半边（会话 `lifecycleMode` 与宿主 `mode`/`state`/`bindings`），不读客户端本地状态。
2. **假形态承重**：把 Enter 路径改回直接调 `handleSubmit`（绕过记录常驻意图的 `handleComposerSubmit`），(a) 必须红；恢复后复绿。先提交再变异，跑完 `git checkout` 恢复。
3. **同步 AC-180 记录**：`quay goal write AC-180 --title <新标题> --expect <新 expect> --origin <沿用原 origin 并追加一行人 yale 裁定的说明>`，与判据改动在同一条 delta 里落地（先例：AC-171 就是这么改的，见 `tasks/gap-resident-toggle-relocate-drop-consent-gate.md` 的 AC6 与完成记录）。`criterion` 不变（仍指向同一 spec 路径）。
4. **清掉过期注释**：`src/modules/chat/hooks/useChatComposerState.ts:1213-1218` 的 Enter 注释仍说提交入口「records the resident intent and enforces the consent gate in front of it」，后半句已随闸门退休而不成立。

**非目标。** 不恢复勾选框/闸门；不改 `ChatComposer`/`ProviderSelectionEmptyState`/`SessionOptions` 的开关位置与可见性（AC-171/AC-178 已钉）；不新增任何 i18n 键；不改常驻模式运行时行为（bypassPermissions、信任边界原样）。

## Plan

1. **红态基线**：`npx playwright test e2e/resident-enter-send.spec.ts`，登记逐字失败行（预期落在 :310 的勾选步骤上）。
2. **重写判据**为 (a) 与 (b) 正控制两条，去掉一切对勾选框与 `acknowledge` 键的引用；`grep -nE "acknowledge|checkbox" e2e/resident-enter-send.spec.ts` 命中 0。
3. **跑绿**；登记打印读数（`session.lifecycle_mode=resident`、`host.resident.bindsSession=true`、`control.lifecycle_mode=per-run`）。
4. **假形态**：提交后在 `useChatComposerState.ts` 的 Enter 分支把 `event.currentTarget.form?.requestSubmit()` 换成直接调 `handleSubmit`（或等价地让 `handleComposerSubmit` 不再 `setPendingResidentIntent`），跑判据 ⇒ 必须非 0，红落在 (a) 的 resident 读数；`git checkout` 恢复后复绿，登记变异 diff 与失败断言逐字。
5. **同步 AC-180 记录**：`quay goal write AC-180 …`；读回 `quay goal show AC-180 --json` 确认 `expect`/`title` 已改、`criterion` 逐字未变。
6. **修过期注释**（`useChatComposerState.ts`），复跑判据确认仍绿。
7. **契约面**：`npm run lint`、`npm run typecheck` 绿；`git diff --name-only $(git merge-base develop HEAD) HEAD` 落在 `## Touches` 内。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-enter-send.spec.ts` 退出 **0**；打印 `session.lifecycle_mode=resident`、`host.resident.bindsSession=true`、`control.lifecycle_mode=per-run`。红态基线：改判据前退出非 0（红落在 :310 的勾选步骤）。
- [x] AC2 (a) 承重：开关打开（全程无任何勾选态）后按 Enter 发送，服务端 `GET /api/session-hosts` 读回该会话 `lifecycleMode` 逐字 `resident`，且 `hosts` 里存在 `mode=resident`、`state!=closed`、`bindings` 含该会话 id 的宿主。
- [x] AC3 正控制：开关关闭时按 Enter 发送，同一端点读回 `per-run`，证明 AC2 的读数不是恒 `resident`。
- [x] AC4 判据不再驱动已退休的闸门：`grep -nE "acknowledge|getByRole\('checkbox'\)|resident.notice.acknowledge" e2e/resident-enter-send.spec.ts` 命中 **0**。
- [x] AC5 假形态必须红（承重）：Enter 路径绕过记录常驻意图的单一入口（直接调 `handleSubmit`）⇒ 判据退出非 **0**，红落在 (a) 的 resident 读数上；登记变异 diff、失败断言逐字、退出码；恢复后复绿。
- [x] AC6 AC-180 记录已同步：`quay goal show AC-180 --json` 的 `expect`/`title` 不再含「未勾选」「勾选」字样，改为「开关打开即代表意图，Enter 与发送按钮仍是同一提交入口」；`criterion` 逐字仍为 `npx playwright test e2e/resident-enter-send.spec.ts`。
- [x] AC7 过期注释已清：`grep -n "consent gate" src/modules/chat/hooks/useChatComposerState.ts` 命中 **0**。
- [x] AC8 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 判据文件读的是当前出货设计：开关打开按 Enter 落成常驻（服务端 `lifecycleMode` 与真宿主进程两侧都读到），开关关闭按 Enter 落成 per-run，全程没有任何勾选框参与。
- 假形态**真的跑过并真的红**，红落在「Enter 必须把常驻意图交给同一个提交入口」这条承重读数上，不是红在脚本本身出错。
- AC-180 的记录（`expect`/`title`）与判据文件在同一条 delta 里一起改，不留「记录说勾选、判据测无勾选」的脱节窗口。
- Enter 与发送按钮走同一入口这件事在本判据里仍被机械钉住，不靠 AC-171 的按钮判据代偿。

## Touches

- `e2e/resident-enter-send.spec.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `goals/AC-180-用-enter-键发送与点发送按钮等价-未勾选知情不能发出-勾选后落成常驻.md`
- `tasks/gap-resident-enter-send-spec-still-drives-retired-tick.md`（自触）
