---
id: gap-resident-composer-switch-removed-intent-new-session-only
title: 去掉输入框上方的『Keep this session running (resident)』开关；resident 意图只在新建会话那一次发送里生效并消费清零
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-178
---
## Proposal

<!-- dedup-ref --> 机制去重（立案时实测）：`tasks/*resident*.md` 里无人认领"去掉 composer 开关 + 意图只在新建会话生效"。相关但不同机制的已完成任务：`gap-resident-toggle-relocate-drop-consent-gate`（把开关同时放进空状态卡片下与 composer，去掉勾选门）、`gap-resident-composer-hides-enable-affordance`（AC-178，已常驻会话隐藏开关，并以"per-run 会话 composer 开关数=1"作正控制）。本条是人 yale 2026-10-04 对话中拍板的产品决定：新建会话的开关只留空状态（`ProviderSelectionEmptyState`，模型卡片下方），输入框上方的开关删除；已运行的非 resident 会话转 resident 的入口已经存在于 `SessionOptions.tsx` 的会话菜单（`convertToResident`），本条不新增、不改动。

**现状（读代码所得）**

1. 开关两处渲染：空状态 `ProviderSelectionEmptyState.tsx:240`；composer `ChatComposer.tsx:817`（`canRunResident && showResidentSwitch && !isResidentSession`，`showResidentSwitch={!showNewSessionEmptyState}`，`ChatInterface.tsx:749`）。两处共用 `ChatInterface.tsx:544` 的 `residentEnabled`，该状态**从不重置**（唯一写入口是 `toggleResident`），`ChatInterface` 在 `WorkspaceMain.tsx:266` 无 `key`，切会话不重挂载。
2. 意图经模块级一次性变量 `pendingResidentIntent`（`ResidentConsentNotice.tsx` 的 `setPendingResidentIntent`/`consumePendingResidentIntent`）从 `ChatComposer.tsx:521` 传到发送路径 `useChatComposerState.ts:963`，并在 `:1032` 以 `if (residentIntent && targetSessionId)` 应用——**对已有会话同样生效**，不限于刚创建的会话。
3. 全前端只有一处新建会话调用：`useChatComposerState.ts:982` 的 `api.providers.createSession`，仅在 `!targetSessionId` 时触发；侧边栏 `handleNewSession` 只清 `selectedSession` 并跳 `/`，不预建会话，所以每个新建会话在发送前都经过空状态。

**陷阱（本条必须同时处理，不能只删 UI）**：删除 composer 开关后若保留现有发送逻辑与不重置的 `residentEnabled`，会出现静默转换——在空状态开 resident 并发送后切到另一个旧的非 resident 会话再发送，旧会话被悄悄转成 resident（bypassPermissions），而界面上已无任何开关可见。

**要做的事**

1. `ChatComposer.tsx`：删除 `residentEnabled`、`onToggleResident`、`showResidentSwitch`、`canRunResident`（若仅此处用）、`noopResidentToggle`、`:817` 的 `PromptInputHeader` 开关块与 `:521` 的 `setPendingResidentIntent(...)`；随之失效的 grid/`col-span-full` 说明注释一并清理。
2. `ChatInterface.tsx`：不再向 composer 传上述 props；`residentEnabled` 仍留在此处供空状态使用。
3. `useChatComposerState.ts`：resident 意图只在 `!targetSessionId`（新建会话）分支里取用，应用 `setSessionLifecycleMode(..., 'resident')` 之后清零 `residentEnabled`（或在回到新会话空状态时重置）；已有会话的发送路径不再读取该意图。去掉模块级 `pendingResidentIntent` 一次性变量，改为把 `residentEnabled` 直接传给发送函数。
4. 保留：空状态开关、`SessionOptions.tsx` 的转换入口、`ResidentStatusBar`/`ResidentMark`、i18n 键 `resident.toggle`（空状态仍用）。
5. 更新测试：`residentComposerEnableAffordance.test.tsx`、`composerDraftScoping.test.tsx`、`e2e/resident-enable-consent.spec.ts`、`e2e/resident-ui-layout.spec.ts`（`COMPOSER_ENABLE` 相关）、`e2e/resident-enter-send.spec.ts`（`residentToggle`）改为走空状态，或删去仅针对 composer 开关的断言；AC-178 的正控制（per-run 会话 composer 开关数=1）与 AC-171 记录的 `expect` 描述了旧行为，需用 `quay goal write` 同一次 delta 里同步改写，不留台账与判据脱节的窗口。

**非目标**：不新增"已运行会话转 resident"的新入口（会话菜单已有）；不改 resident 运行时行为；首次发送失败后的重试路径不补开关（空状态里已开过则意图仍在）。

## AC

- [x] AC1 已有会话无开关：`npx playwright test e2e/resident-ui-layout.spec.ts -g "composer has no resident switch"` 退出 **0**，并打印对 per-run 与 resident 两种已有会话各自 `.chat-composer-shell` 内 `[data-resident-enable="true"]` 的 `count=0`；同次运行打印空状态下同一选择器 `count=1` 作正控制（同一选择器同一次运行）。
- [x] AC2 静默转换回归（承重）：判据先在空状态打开开关并发送，创建会话 A 后读回 `GET /api/session-hosts` 得 `lifecycleMode=resident`；再切到一个 per-run 会话 B 发送一条消息，读回 B 的 `lifecycleMode` 仍为 `per-run`，并打印 `B.lifecycle_mode=per-run`。退出 **0**。
- [x] AC3 假形态必须红：把发送路径还原为 `if (residentIntent && targetSessionId)` 且不清零意图 ⇒ AC2 的判据退出非 0，红在 B 的 `lifecycleMode` 读数上；登记变异 diff、逐字失败行、退出码，恢复后复绿。
- [x] AC4 新建流程不回归：空状态开关打开并发送后，新会话 `lifecycleMode=resident`（读自 `/api/session-hosts`）；`npx vitest run src/modules/chat/tests/residentComposerEnableAffordance.test.tsx` 与 `src/modules/chat/tests/composerDraftScoping.test.tsx` 退出 **0**，其中新增一条断言 `pendingResidentIntent` 的模块级导出已不存在（`grep -rn "setPendingResidentIntent\|consumePendingResidentIntent" src` 无输出）。
- [x] AC5 台账同步：AC-171 与 AC-178 的 `expect`/判据与新行为一致，`e2e/resident-enable-consent.spec.ts` 与 `e2e/resident-enter-send.spec.ts` 退出 **0**；`npm run lint` 与 `npm run typecheck` 退出 **0**。

## DoD

- 判据在真浏览器、真服务上跑，resident 状态一律读自 `GET /api/session-hosts` 的 `data.sessions[].lifecycleMode`，不使用客户端自造读数；不拉起真 claude（沿用 debug-agent 场景）。
- AC2 的"B 仍为 per-run"与 AC3 的变异红都是**真跑过的原始输出行**，不是转述；假形态红落在 B 的读数上而不是别处。
- 会话菜单的"转为常驻"入口在本条前后行为不变（用 `SessionOptions` 相关既有测试证明，不新增入口）。
- e2e 不在 typecheck/lint 范围内，所以 e2e 文件必须实际跑过，不能只看类型检查；单文件判据在各自时限内自行结束。
- 只动 Touches 列出的文件；与 `e2e/resident-ui-layout.spec.ts` 的兄弟任务共用文件时取并集追加，不重写他人用例。

## Touches

- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/composer/ResidentConsentNotice.tsx`
- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`
- `src/modules/chat/tests/residentComposerEnableAffordance.test.tsx`
- `src/modules/chat/tests/composerDraftScoping.test.tsx`
- `e2e/resident-ui-layout.spec.ts`
- `e2e/resident-enable-consent.spec.ts`
- `e2e/resident-enter-send.spec.ts`
- `goals/AC-171-真实浏览器里开启常驻须先勾选知情-未勾选不能发送或转换.md`
- `goals/AC-178-已经是常驻的会话-输入区不再显示开启开关与知情提示.md`
- `tasks/gap-resident-composer-switch-removed-intent-new-session-only.md`（自触）
