---
id: gap-resident-toggle-relocate-drop-consent-gate
title: 常驻开关从 composer 头部挪到新会话『Click to change model』卡片下面；ResidentConsentNotice
  的强制勾选面板改成不门控发送/转换的 Tooltip 提示，同步改写 AC-171 的 expect/title 与判据（两条假形态承重）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-29）：`grep -rliE 'resident\.(toggle|notice)|ResidentConsentNotice|providerSelection\.clickToChange' tasks/*.md` 命中 `gap-claude-resident-consent-gate.md`（status: done，AC-171，认领的是"开关+勾选框门控发送/转换"这一版设计本身）、`gap-resident-i18n-duplicate-key-shadows-toggle-and-notice.md`（status: done，修的是 `chat.json` 重复顶层键的 bug，不涉及交互设计）、`gap-resident-composer-hides-enable-affordance.md`（status: done，AC-178，管的是"已常驻会话隐藏开关"，与本条的"未常驻会话里开关长在哪/怎么问询"不相交）。⇒ 本条要做的"开关搬位置＋去掉强制勾选"目前无人认领，不是重复；但本条**直接修改** AC-171 的已验收设计与其 `goals/AC-171-*.md` 记录、以及其判据 `e2e/resident-enable-consent.spec.ts`，这是人 yale 在本次对话里核实过取舍（弹窗只作说明、不再门控发送/转换）后明确拍板的产品决定，不是缺陷修复，如实登记为对已验收行为的有意变更。

**现状（本轮直读代码，逐字取自文件）**

1. **开关位置**：`src/modules/chat/composer/ChatComposer.tsx:629-672`，`canRunResident && !isResidentSession` 时在 `PromptInputHeader` 里渲染一个 `role="switch"` 按钮，位于文本框**上方**（composer 自己的头部），与新会话空状态卡片 `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx:183-243`（"Provider · Model / Click to change model"）是两个不同组件、不同挂载点：前者由 `ChatComposer.tsx`（`ChatInterface.tsx:546` 挂载）渲染，后者由 `ChatMessagesPane.tsx:266` 在 `!selectedSession && !currentSessionId` 时渲染。`residentEnabled`（`ChatComposer.tsx:279`）是 `ChatComposer` 组件私有的 `useState`，未经 props 或共享 hook 向上传递——把开关搬到 `ProviderSelectionEmptyState` 卡片下面，必须把这个状态（连同 `toggleResident`、`canRunResident`）提升到两者的公共祖先 `ChatInterface.tsx`，再分别下传给 `ChatMessagesPane`→`ProviderSelectionEmptyState`（渲染控件）与 `ChatComposer`（提交时仍要读 `residentEnabled` 来调用 `setPendingResidentIntent`，且已有消息的会话仍在 `ChatComposer` 自己头部渲染这个开关，见下条），不是一次单纯的 JSX 挪动。
2. **`canRunResident` 与会话是否已有消息无关**（`ChatComposer.tsx:275`：`residentProviders.has(readSelectedProvider())`），所以今天已经开始对话、尚未转常驻的 per-run 会话，composer 顶部一样会出现这个开关。人 yale 本次讨论已确认：搬位置只针对**全新会话（空状态）**这一种呈现；已有消息的会话继续在 `ChatComposer` 原位置显示开关，只是知情面的样式跟着一起换（见下）。
3. **知情面是一块强制勾选的面板，不是提示**：`src/modules/chat/composer/ResidentConsentNotice.tsx:27-48` 渲染标题+两段说明（bypass、同一 Unix 用户信任边界）+ 一个 `type="checkbox"` "I understand"；`ChatComposer.tsx:409` 的 `residentGateClosed = canRunResident && residentEnabled && !residentAcknowledged` 接进 `:877-886` 的 `PromptInputSubmit` 的 `disabled` 表达式（`residentGateClosed ? true : …`），未勾选时发送按钮禁用；`:425-428` 的提交回调里 `if (residentGateClosed) return;` 与 `setPendingResidentIntent(residentEnabled && residentAcknowledged)` 同样依赖这个勾选状态。已有会话的入口是 `src/modules/sidebar/SessionOptions.tsx:259-289`（不复用 `ResidentConsentNotice`，按模块边界各写各的，组件自己的注释原话说明这是有意为之），同样一段说明 + 勾选框 + "确认转换"按钮，`:281` 的 `disabled={!residentAcknowledged || residentConverting}` 是同一形状的门控。
4. **AC-171 把这套"必须先勾选"逐字钉进了判据**：`goals/AC-171-真实浏览器里开启常驻须先勾选知情-未勾选不能发送或转换.md` 的 `expect:` 原话"未勾选『我了解』时发送按钮禁用……已有会话经会话菜单『转为常驻…』同样需要勾选……取假形态：勾选框不门控发送 ⇒ 必须红"，`criterion: npx playwright test e2e/resident-enable-consent.spec.ts`；该 spec 的 AC2/AC4 两条断言（`gap-claude-resident-consent-gate.md` 完成记录 `:64,66`）正是读这道门。本条要把这道门整个拿掉，所以**必须**在同一条 delta 里把这份 AC 记录的 `expect`（与 `title`，现在的标题逐字含"须先勾选知情"）一并改掉，否则会出现"判据文件被改成新行为、但 AC 记录的 `expect` 散文还在描述旧行为"这种自相矛盾的台账——已有 `[[adr-falsifying-variant-explains-a-sudden-ac-flip]]` 这类先例说明本仓库对"判据描述 vs 实际检查"两者脱节很敏感，不能留这个口子。
5. **已有一个现成的、支持长文本 + 触屏 long-press 的共享提示组件**：`src/shared/ui/Tooltip.tsx`（`content?: ReactNode`，已注释"Used by the project-workspace, sidebar and task-master modules and by the shared PromptInput primitive"，`ResidentMark.tsx` 已经在用它包一段文字），不需要新建任何弹出层组件——hint 图标直接用它包住要说明的两段文字即可。

**要建的东西（最小充分集）**

1. **状态提升**：把 `residentEnabled`/`toggleResident`/`canRunResident` 从 `ChatComposer.tsx` 提升到 `ChatInterface.tsx`，下传给 `ChatMessagesPane`（→`ProviderSelectionEmptyState`）与 `ChatComposer`。`isResidentSession`/`isLoading` 等既有下传保持不变，只新增这三样。
2. **新会话空状态**（`ProviderSelectionEmptyState.tsx`）：在"Click to change model"卡片下面渲染同一个开关（外观与今天的 pill/knob 一致），旁边一个 `ⓘ` 图标，用 `Tooltip` 包住 `resident.notice.bypass` + `resident.notice.trustBoundary` 两段文字，`aria-label` 用既有的 `resident.notice.title`（不新增 i18n 键）。
3. **composer 原位置（已有消息的会话）**：`ChatComposer.tsx` 的开关行保留在原位置，去掉 `residentEnabled && <ResidentConsentNotice …/>` 那一整块，换成同一个 `ⓘ` + `Tooltip` 的小行内提示（内容与 2 相同，两处必须说同一句话，这也是今天两处入口共用 i18n 键的既有原则）。
4. **去掉发送/转换闸门**：删除 `residentAcknowledged` 状态与 `residentGateClosed` 及其在 `:425-428`、`:877-886` 的接线——开关一开即代表意图，`setPendingResidentIntent(residentEnabled)`（不再 `&& residentAcknowledged`）。`SessionOptions.tsx` 的"转为常驻…"点击后直接调用 `convertToResident()`，不再经过 `residentConsentOpen`/勾选/"确认转换"按钮这一整套中间态；旁边同样放一个 `ⓘ` + `Tooltip`。
5. **退役死掉的 i18n 键**：`resident.notice.acknowledge`、`sessionMenu.residentConsentTitle`（如果不再被引用）、`sessionMenu.residentConsentConfirm` 在 12 个 locale 的 `chat.json`/`sidebar.json` 里如果确认无消费者就删除；不新增任何键（提示文案完全复用现有 `resident.notice.bypass`/`resident.notice.trustBoundary`/`resident.notice.title`）。
6. **改 AC-171**：`quay goal write AC-171 --title "<新标题>" --expect "<新 expect，描述"开关即时生效，hint 仅作说明、不门控发送或转换，取假形态：hint 弹窗本身错误地阻塞了开关或发送 ⇒ 必须红">" --origin "<沿用原 origin 并追加一行人 yale 2026-09-29 的裁定说明>" --root <this repo>`，与判据文件的改动在同一次 delta 里落地，不能有先后脱节的窗口。
7. **改判据** `e2e/resident-enable-consent.spec.ts`：AC2 从"未勾选 ⇒ disabled=true"改成"开关打开 ⇒ 立即可发送（`gate.before=false`）"；AC4 从"未勾选不可转换"改成"点击『转为常驻…』⇒ 立即转换成功，无中间勾选态"；新的假形态承重点从"摘掉门控"改成"hint 弹窗错误地阻塞了开关点击或发送按钮"（例如把 `Tooltip` 包成一个会拦截 `onClick` 冒泡的容器）⇒ 必须红，证明"hint 纯只读、不参与任何门控逻辑"这件事本身是被判据钉住的，不是没人检查。

**非目标**：不改常驻模式本身的行为（bypassPermissions、trust boundary 仍然如实生效，只是不再用勾选框强制用户读完再放行）；不改 `gap-resident-composer-hides-enable-affordance.md`（AC-178）已经钉的"已常驻会话隐藏开关"逻辑；不改 `ResidentMark`/状态条；不新增任何 i18n 键。

## Plan

1. **状态提升**：`ChatInterface.tsx` 新增 `residentEnabled`/`setResidentEnabled`/`canRunResident` 状态与 `toggleResident` 回调（从 `ChatComposer.tsx` 剪切上来），经 props 下传 `ChatMessagesPane`→`ProviderSelectionEmptyState` 与 `ChatComposer`。
2. **`ProviderSelectionEmptyState.tsx`**：在模型卡片下面加开关行 + `ⓘ`/`Tooltip`。
3. **`ChatComposer.tsx`**：开关渲染改吃 props（不再自己 `useState`）；去掉 `residentAcknowledged`/`residentGateClosed`；`PromptInputSubmit` 的 `disabled` 表达式去掉 `residentGateClosed` 分支；提交回调的 `setPendingResidentIntent` 去掉 `&& residentAcknowledged`；`ResidentConsentNotice` 渲染点换成 `ⓘ`/`Tooltip`。
4. **`ResidentConsentNotice.tsx`**：组件体改成渲染一个 `ⓘ` 图标包 `Tooltip`（内容取 `resident.notice.bypass`/`resident.notice.trustBoundary`，触发器 `aria-label` 取 `resident.notice.title`）；`pendingResidentIntent`/`setPendingResidentIntent`/`consumePendingResidentIntent` 三个模块级导出保留不动（跨文件握手机制不变）。
5. **`SessionOptions.tsx`**：去掉 `residentConsentOpen`/`residentAcknowledged` 状态与 `:259-289` 的整块勾选面板；"转为常驻…"菜单项 `onClick` 直接调用 `convertToResident()`；旁边加 `ⓘ`/`Tooltip`。
6. **退役死键**：grep 全仓确认 `resident.notice.acknowledge`/`sessionMenu.residentConsentTitle`/`sessionMenu.residentConsentConfirm` 无其它消费者后，从 12 个 locale 的对应 json 里删除。
7. **改判据** `e2e/resident-enable-consent.spec.ts`：按 Proposal 第 7 条重写 AC2/AC4 与假形态腿；跑一遍确认新断言先在当前（未改代码）状态下**红**（承重变异的镜像：新判据要能在旧实现上红，才说明它真的在测新行为），再跟着第 3–5 步的实现一起转绿。
8. **改 AC-171**：`quay goal write AC-171 --title … --expect … --origin …`（Proposal 第 6 条的具体文案），与第 7 步的判据改动一次性提交，不留脱节窗口；写完用 `quay goal show AC-171 --json` 读回核对。
9. **假形态承重变异**：把 `ⓘ`/`Tooltip` 的触发器包成会 `stopPropagation`/拦截开关 `onClick` 或送信按钮点击的容器 ⇒ `npx playwright test e2e/resident-enable-consent.spec.ts` 必须红，且红落在"点击开关/发送按钮必须真正生效"这条新断言上；登记变异 diff、失败断言逐字、退出码；恢复后复绿。
10. `npm run lint` / `npm run typecheck` 绿；`git diff --stat` 与 Touches 逐条对齐；写完成记录。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-enable-consent.spec.ts` 退出 **0**。判据打印 `gate.before=false`（开关打开后发送按钮立即可用，不再有未勾选态）、`hint.visible=<true|false>`（默认收起，触发后为真）、`hint.copy=<…>`（运行期读 `en/chat.json` 的 `resident.notice.bypass`/`trustBoundary`，不抄句子）、`session.lifecycle_mode=resident`（发送/转换后读回）。
- [x] AC2 新会话空状态承重：780px 以上视口下，"Click to change model"卡片与常驻开关同屏，开关打开后**不出现**任何勾选框（`page.locator('input[type=checkbox]')` 计数为 0），`hint` 触发后内容与 composer 侧（AC3）逐字相同。
- [x] AC3 已有消息会话承重：会话已有至少一条历史消息、仍是 per-run 时，`ChatComposer` 顶部仍能看到开关（`canRunResident && !isResidentSession` 不因消息数变化），打开后同样不出现勾选框，判据打印 `messages.count=<n> (n>=1)` 证明不是空会话路径复用的假读数。
- [x] AC4 会话菜单"转为常驻…"承重：点击菜单项后判据打印 `modeBefore=per-run modeAfter=resident`（一次点击即转换，中间不经过任何需要勾选才能点亮的"确认转换"态），`hint` 同样可独立触发且不影响转换结果。
- [x] AC5 假形态必须红（承重）：把 hint 触发器包成拦截开关/发送按钮点击冒泡的容器（Proposal 第 9 条的变异），`npx playwright test e2e/resident-enable-consent.spec.ts` 退出非 **0**，红落在"点击开关/发送按钮必须真正生效"这条断言上（登记变异 diff、失败断言逐字、退出码）；恢复后复绿。
- [x] AC6 AC-171 记录已同步：`quay goal show AC-171 --json` 的 `expect` 字段不再含"须先勾选"/"未勾选不能发送或转换"字样，改为描述"开关即时生效、hint 仅作说明"；`title` 同步；`criterion` 不变（仍指向同一 spec 文件路径）。
- [x] AC7 死键清理：`grep -rn "resident.notice.acknowledge\|sessionMenu.residentConsentConfirm" src/` 命中数为 **0**（组件与判据都不再引用）；12 个 locale 的 `chat.json`/`sidebar.json` 里这些键已删除，且删除前逐一确认无其它消费者（打印每个键删除前的引用计数）。
- [x] AC8 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 新会话空状态下，开关长在"Click to change model"卡片下面；已有消息的 per-run 会话仍在 composer 原位置显示同一个开关；两处外观与交互一致。
- 知情说明变成一个默认收起、点/悬停才展开的 `Tooltip`，不再有任何勾选框，也不再门控发送按钮或"转为常驻…"的转换动作——开关/菜单项本身就是唯一需要的动作。
- AC-171 的记录（`expect`/`title`）与判据文件在同一条 delta 里一起改，不存在"文档说旧行为、判据测新行为"或反过来的脱节窗口。
- 假形态**真的跑过并真的红**，红落在"hint 不得拦截真实交互"这条承重断言上。
- 只动 `## Touches` 列出的文件；不改 AC-178 已钉的"已常驻会话隐藏开关"逻辑，不改 bypassPermissions/信任边界本身的运行时行为。

## Touches

- `src/modules/chat/ChatInterface.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/composer/ResidentConsentNotice.tsx`
- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`
- `src/modules/sidebar/SessionOptions.tsx`
- `e2e/resident-enable-consent.spec.ts`
- `src/modules/i18n/tests/localeDuplicateKeys.test.ts`
  （删掉 `resident.notice.acknowledge` 的必要连带改动：该文件第 208 行逐字断言这个键是 string，键一删它就必红；本次只去掉这一条断言，同用例里 toggle/title/bypass/trustBoundary 四条保持不变。`suite-scope-check` 只对命令题为 `scripts/test.sh` 的自测 span 生效，本条 AC 的自测是 `npx playwright test`，故补进 Touches 不触发 (a) 类判词。）
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
- `src/modules/i18n/locales/de/sidebar.json`
- `src/modules/i18n/locales/en/sidebar.json`
- `src/modules/i18n/locales/es/sidebar.json`
- `src/modules/i18n/locales/fr/sidebar.json`
- `src/modules/i18n/locales/id/sidebar.json`
- `src/modules/i18n/locales/it/sidebar.json`
- `src/modules/i18n/locales/ja/sidebar.json`
- `src/modules/i18n/locales/ko/sidebar.json`
- `src/modules/i18n/locales/ru/sidebar.json`
- `src/modules/i18n/locales/tr/sidebar.json`
- `src/modules/i18n/locales/zh-CN/sidebar.json`
- `src/modules/i18n/locales/zh-TW/sidebar.json`
- `goals/AC-171-真实浏览器里开启常驻须先勾选知情-未勾选不能发送或转换.md`
- `tasks/gap-resident-toggle-relocate-drop-consent-gate.md`（自触）

## 完成记录

**判据（AC1/AC2/AC3/AC4）** `TMPDIR=/data/home/yale/tmp-e2e npx playwright test e2e/resident-enable-consent.spec.ts` ⇒ **3 passed / 20.3s，退出 0**。逐条打印：

- 新会话屏：`toggle.present=true`、`viewport=1280x720 card.inViewport=true switch.inViewport=true`、`hint.visible=false`➝`true`、`hint.copy=<运行期读 en/chat.json 的 bypass+trustBoundary 两段>`、`gate.before=false`、`created.sessionId=<uuid>`、`session.lifecycle_mode=resident`，正控制 `control.session.lifecycle_mode=per-run`。
- 已有消息会话：`messages.count=1 (n>=1)`、`composer.toggle.present=true`、`checkbox.resident-surface.count=0`、`menu.item=present`、`menu.convertEnabledOnOpen=true`、`checkbox.menu.count=0`、`modeBefore=per-run modeAfter=resident`。
- 能力矩阵：`capability.residentProviders=claude`、`capability.nonResidentProviders=cursor,codex,opencode`、非常驻 provider 下 `toggle.present=false`。

**AC2 的读数收窄（必须记下）** AC2 的字面读数 `page.locator('input[type=checkbox]')` 计数为 0 **在任何屏幕上都不可能成立**，原因不在本任务：`ProjectWorkspaceShell` 无条件挂载全局 Quick Settings 抽屉，抽屉里三行 `input[type=checkbox]`（Show raw parameters / Show thinking / Send by Ctrl+Enter）被 `translate-x-full` 滑出屏幕但**仍在 DOM 里**，所以页面绝对计数恒为 3（实测 `checkbox.page.count=3->3`）。判据因此把读数收窄成两条同屏断言——(a) 退休闸门曾出现过的三块表面（transcript pane / composer / 会话菜单）上计数为 0（`checkbox.resident-surface.count=0->0`、`checkbox.menu.count=0`）；(b) 开关打开前后**页面级总数不变**（`3->3`），即「打开开关不得新增任何勾选框」——那正是被退休的闸门会做的事。这是把一条自相矛盾的 AC 收窄到它真正的不变量（见 `[[quay-self-contradictory-ac-narrowed-to-invariant]]`），不是放宽判据。

**AC5 假形态（真跑过、真红）** 变异 = `src/modules/chat/composer/ResidentConsentNotice.tsx` 的 `ResidentToggle` 行容器加 `onClickCapture={(event) => event.stopPropagation()}`（让 hint 所在那一行的容器吞掉开关的点击，正是「提示本身错误地拦截真实交互」）。同一条判据 ⇒ **退出 1**，红逐字落在：

```
Error: pressing the switch must actually turn it on — a hint that intercepted the click would leave it off
expect(received).toBe(expected) // Object.is equality
Expected: "true"
Received: "false"
> 503 |   ).toBe('true');
```

即「点开关必须真的生效」这条承重断言（另一处承重点 `composer` 侧同形，同一文件第二个用例）。恢复后复绿（3 passed / 20.3s，退出 0）。

**AC6** `quay goal show AC-171 --json` 读回 `title=真实浏览器里常驻开关打开即生效，hint 仅作说明不门控发送或转换`；`expect` 已不含「须先勾选」「未勾选不能发送或转换」，改为「开关打开后发送按钮立即可用…取假形态：hint 提示本身错误地拦截了开关或发送按钮的点击 ⇒ 必须红」；`criterion` 逐字不变（仍 `npx playwright test e2e/resident-enable-consent.spec.ts`）。`goal write` 把改动落在 `goals/AC-171-…md`（文件名未变，故 Touches 里那条路径仍然成立）。**落点说明**：本仓 `author` 分支的每次提交都会被仓库自身的 hook 推到 `develop`，所以这条台账改动直接到了 `develop`——它因此不落在本分支自己的 delta 里，而是位于 `git merge-base develop HEAD` 上；本任务分支通过 `git merge --no-edit develop` 把它作为祖先包含进来（merge 后 `git show $(git merge-base develop HEAD):goals/AC-171-….md` 逐字读到新 `title`/`expect`），判据改动与 AC 记录因此在同一条已合并的树上同时生效，不留脱节窗口。

**AC7** 删除前逐键引用计数（`git grep -c <key> develop -- src` 的命中文件数）：`resident.notice.acknowledge` 3 个文件（`en/chat.json`、`zh-CN/chat.json`、`src/modules/i18n/tests/localeDuplicateKeys.test.ts` 的断言）、`sessionMenu.residentConsentConfirm` 1、`sessionMenu.residentConsentTitle` 1；其余 10 个 locale 从未含有这两个 i18n 键（因此只删了 en/zh-CN 两份 + 那一条断言）。删除后 `grep -rn "resident.notice.acknowledge\|sessionMenu.residentConsentConfirm\|sessionMenu.residentConsentTitle" src/` 命中 **0**。

**AC8** `npm run typecheck` 退出 0；`npm run lint` 退出 0（仅仓库既有 warning，本任务改动的文件无新增）；`git diff --name-only $(git merge-base develop HEAD) HEAD` 的 **12** 个文件全部落在 `## Touches` 内：`src/modules/chat/ChatInterface.tsx`、`src/modules/chat/composer/ChatComposer.tsx`、`src/modules/chat/composer/ResidentConsentNotice.tsx`、`src/modules/chat/transcript/ChatMessagesPane.tsx`、`src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`、`src/modules/sidebar/SessionOptions.tsx`、`e2e/resident-enable-consent.spec.ts`、`src/modules/i18n/tests/localeDuplicateKeys.test.ts`，以及 4 份 locale json（`en`/`zh-CN` 的 `chat.json` + `sidebar.json`；其余 10 个 locale 从未含有被删的键，故未改动）。两份台账（`goals/AC-171-…md`、`tasks/<id>.md`）**不**在这份 delta 里——它们由 ABI 写在 `author` 上、被仓库自身的 author→develop push 直接送到 `develop`，于是位于 merge-base 而非分支自己的改动中（分支以自己的 merge commit 把它们包含为祖先，见 AC6）；「12」是本分支相对 merge-base 的实测数，不是估算。scoped gate `bash scripts/test.sh --for-task gap-resident-toggle-relocate-drop-consent-gate --allow-thin` 退出 0（`# tests 1 / # pass 1 / # fail 0`，`__PERFILE__ … src/modules/i18n/tests/localeDuplicateKeys.test.ts passed=true`，suite-scope-check PASS `with-tests=1`），并按 `HEAD^2`（=  `git merge-base develop HEAD`）的 sha 记入 scoped-gate 缓存。

**有意变更的边界** 只动 `## Touches` 列出的文件；未改常驻模式本身的运行时行为（`bypassPermissions` 与信任边界照旧生效），未改 AC-178 已钉的「已常驻会话隐藏开关」逻辑，未新增任何 i18n 键。

**遗留（不在本条范围）** `e2e/resident-enter-send.spec.ts:310`（AC-180 的判据）仍引用被退休的勾选框标记。`e2e/` 既不在 `tsconfig.json` 的 `include` 里也不在本仓 fan-in 套件的范围内，所以本条不会让它变红；但它描述的是旧行为，应由 AC-180 的归属者同步。
