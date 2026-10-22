---
id: gap-composer-send-key-touch-scoped
title: 移动端软键盘 Enter 直接发送且无法换行：发送键须按设备判定（触摸设备固定 Enter 换行 + 按钮发送），sendByCtrlEnter
  作用域限定桌面
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

缺陷：在手机上输入框按软键盘的 Return/Enter 会**直接发送**，而要换行必须按 Shift+Enter——软键盘没有 Shift 键，于是移动端**根本没有换行手段**；空输入时按 Enter 更是一个死键（既不发也不换行）。

机制（已定位到行）：

1. `src/modules/chat/hooks/useChatComposerState.ts` 的 `handleKeyDown`：无修饰键 Enter 且 `!sendByCtrlEnter` 时 `event.preventDefault()` 后 `handleSubmit(event)`。该分支没有任何设备维度。
2. `handleSubmit` 先 `event.preventDefault()`（约 :658），再因输入为空而 return（约 :662-671）——所以空输入时 Enter 被吃掉什么也不做。
3. Shift+Enter 能换行，纯粹因为**没被拦截**、靠浏览器默认行为往 textarea 插 `\n`；代码里没有一行主动插入换行。
4. 提示文案容器是 `hidden basis-full ... lg:block`（`ChatComposer.tsx` 约 :595），实测 390px 与 780px 均 `display:none`，仅 ≥1024px 可见；文案本身还是桌面的 `Enter to send • Shift+Enter for new line`。
5. `sendByCtrlEnter` 是**账号级**偏好，存在服务端 `auth.db`（`src/shared/userSettings.ts`，服务端为准、localStorage 只是首屏镜像）。实测清空 localStorage 后重载并登录，该值从服务端恢复——手机与桌面共用一个值，无法各自设置。
6. 全仓库没有任何 `enterKeyHint`/`inputMode`：实测 textarea 的属性表为 `[data-slot, class, dir, placeholder, style]`。按规范（MDN 与 WHATWG `enterkeyhint`）未指定时由 UA 依据 `inputmode`/`type`/`pattern` 自行决定键帽，即**应用没有给软键盘任何信号**。注意：**不要**声称规范把 textarea 默认为 `enter`，MDN 与 WHATWG 都没有这句话。

已实测的判定矩阵（真 Chromium，独立实例；`prevented` 为 React 处理后的 `defaultPrevented`）：

- 桌面 / 偏好关：Enter → `prevented=true`、输入清空、消息已发出（URL 跳到 `/session/<id>`、页签变为消息文本）。
- 桌面 / 偏好开：Enter → `prevented=false`、值变为 `<text>\n`、未发送；`Ctrl+Enter` → `prevented=true` 并发送。
- 手机 390px + 触摸 / 偏好关：Enter → **`prevented=true`、输入清空、真实发送**（这是当前缺陷的现场读数）。
- 手机 390px + 触摸 / 偏好开：Enter → `prevented=false`、值 `<text>\n`。
- 触摸 / 空输入 + Enter：`prevented=true`、值仍为 `""`（死键）。
- 提示文案在 390px 与 780px 均 `display:none`。

同类产品基线（用于定调，不是推测）：桌面一律 Enter 发送 / Shift+Enter 换行，与现状一致；**移动端一律相反**——软键盘 Return 插入换行、由单独的发送按钮提交（ChatGPT、Claude、Gemini、Copilot、Teams、Discord、以及 WhatsApp/iMessage/Telegram）。ChatGPT 安卓端"Enter 直接发送"是被当作 **bug** 报的（指向键盘差异，SwiftKey/Samsung 中招）。开关的先例是 Slack 的 `Ctrl+Enter sends message` 与 Teams 的 `When writing a message, press Enter to`（MC1217643），两者都**明确只作用于桌面与 web，移动端固定 Return 换行 + 发送按钮**。

设计（B+D，已在真实浏览器里验证过）：

- **B**：触摸专用设备上，裸 Enter 一律不发送。判定信号用**输入能力**而不是宽度：`(pointer: coarse) and (hover: none)`（两者都要，触摸屏笔记本的主指针仍是 fine，只有取交集才不会把有真键盘的机器判成触摸）。注意实测：**`'ontouchstart' in window` 在这一配置下是 false**，用它做嗅探会失效。
- **D**：该判定**只影响本机行为，不写回偏好**。`sendByCtrlEnter` 仍是账号级、仍决定有键盘设备上的行为；触摸设备忽略它。这正是 Slack/Teams 的作用域语义。
- 关键简化：`sendByCtrlEnter=true` 本来就等价于"Enter 换行、修饰键发送"，所以触摸设备**只需把有效值钉成 true** 就得到 B；`Ctrl+Enter` 那条分支本就无条件，即使设备判定出错也不会失去键盘发送路径。
- 提示文案与按键**同源**（同一个 hook 的返回值），二者不可能互相矛盾；触摸下提示不再出现 Shift/Ctrl 字样，并取消 `lg` 隐藏。

**本任务必须基于已存在的原型开发，不要从零重写。** 原型已落在一个独立 worktree：

- 路径：`/data/home/yale/work/claudecodeui-worktrees/mobile-enter-send-key`
- 分支：`proto/mobile-enter-send-key`，commit `bb787bcd`，基于 `develop`
- 内容：新增 `src/modules/chat/hooks/useSendOnEnter.ts`（导出 `useSendOnEnter(sendByCtrlEnter) -> { sendOnEnter, touchOnly }`，含媒体查询 `change` 监听），改 `useChatComposerState.ts`（keydown 用 `sendOnEnter`）与 `ChatComposer.tsx`（提示文案与容器可见性）。
- 该原型已过 `tsc --noEmit`（退出 0）、新增文件 `npx oxlint` 零告警、`npx vitest run src/modules/chat/tests src/shared/tests/uiPreferences.test.ts` 42 文件 / 313 用例全绿。

取用方式：把该分支并入本任务的 `task/<id>` 分支（`git merge proto/mobile-enter-send-key`，或先 cherry-pick `bb787bcd`），再在其上补齐下面的缺口。派生本任务时**不要**为它预建任何 `task/*` 分支：`claim-task` 把已存在的 `task/<候选 id>` 视为在途并拒绝派发。

原型**故意没做**、本任务要补齐的：

1. i18n：原型只用了 `defaultValue` 兜底，12 个 locale 的 `chat.json` 都没有 `input.hintText.touch`。
2. 触摸下的排队文案：原型的三元里 `touchOnly` 优先，于是"回合进行中、发送按钮变成排队箭头"时仍显示 `Tap ➤ to send`，应给出排队专用的触摸文案。
3. 设备判定与偏好覆盖没有任何自动化测试；原型的结论全部来自一次性手工探针。
4. 桌面空输入按 Enter 仍是死键——这是**独立**问题，本任务不要求修，但不要顺手改坏（见 DoD 的回归读数）。
5. 开关的描述文案仍只提 IME 用户，没有说明该设置在有键盘的设备上才生效。

同区域但机制不同的既有任务 `gap-composer-icon-buttons-unlabeled`（图标无障碍名）已 done，与本任务无关。

实施时按 `.agents/skills/frontend-module-standards/SKILL.md` 落位（新 hook 属模块私有，放 `src/modules/chat/hooks/`；新测试只经模块 barrel `@/modules/chat` 导入，否则 oxlint boundaries 会红）。

## AC

- [x] `npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx` 退出码 0，且四格判定各自独立可反红并在失败信息里打印实际四格读数：触摸×偏好关 → `{sendOnEnter:false,touchOnly:true}`；触摸×偏好开 → `{sendOnEnter:false,touchOnly:true}`；非触摸×偏好关 → `{sendOnEnter:true,touchOnly:false}`；非触摸×偏好开 → `{sendOnEnter:false,touchOnly:false}`。jsdom 不实现 `matchMedia`，测试须自带媒体查询替身；因此该文件只能证明**策略**，媒体查询字符串本身由 e2e 证。
- [x] 同一文件断言"设备判定不污染偏好"：触摸 leg 下对偏好写入（`writeUserPreference` / `api.user.savePreferences`）的 spy 调用次数为 0，且 `readStoredUiPreferences()` 的 `sendByCtrlEnter` 在该 leg 前后相同。断言的是这两个读数，不是单纯的"没报错"。
- [x] 提示同源且三分支不回归：`npx vitest run src/modules/chat/tests/<新增或既有的 composer 提示用例>` 退出码 0——`touchOnly` 为真时提示文案不含 `Shift` 与 `Ctrl`，且其容器类名不含 `hidden`/`lg:block`；`touchOnly` 为假时 `input.hintText.enter` / `input.hintText.ctrlEnter` / 排队两条的取值与改动前逐字符相同。
- [x] i18n 完整性（12 个 locale × 2 个 key）：一条 `node -e` 或等价脚本校验 `src/modules/i18n/locales/*/chat.json` 全部存在非空 `input.hintText.touch`，且 `src/modules/i18n/locales/*/settings.json` 的 `quickSettings.sendByCtrlEnterDescription` 已说明该设置只在有键盘的设备上生效；任一缺失或为空即以非 0 退出并打印缺哪个文件哪个 key。同时校验 12 个 `chat.json` 与 12 个 `settings.json` 仍是可解析 JSON。
- [x] e2e 触摸 leg：`npx playwright test e2e/mobile-composer-send-key.spec.ts` 退出码 0。该 leg 以 `test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })` 运行，并**在断言行为之前先断言前提**：页内 `matchMedia('(pointer: coarse) and (hover: none)').matches` 必须为 true，否则以该读数直接 fail（没有这一条，spec 在桌面配置下会静默通过，等于没测）。随后断言三件事：空输入按 Enter 后 textarea 值 === `"\n"`；输入文本后按 Enter，值恰好多出一个 `\n` 且 `location.pathname` 不变；点 `button[aria-label="Send"]` 后 `location.pathname` 变为 `/session/<id>`。
- [x] e2e 桌面 leg（同一 spec 文件内的另一个 describe 块，共用一次运行与同一个 `DATABASE_PATH`；不要拆成第二个 spec 文件，那会踩"一次运行一个库"的鉴权坑）：默认配置下 Enter 提交（`location.pathname` 变化），Shift+Enter 只让值增加 `\n` 而不提交。该 leg 同时是空输入死键的回归读数：空输入按 Enter 后值仍为 `""`、`location.pathname` 不变。
- [x] 抗假变体：把 `sendOnEnter` 恒置为 `!sendByCtrlEnter`（等价于删掉触摸判定）后重跑该 spec，触摸 leg 必须在"输入文本后按 Enter 未提交"那条变红；还原后全绿，`git diff` 只剩本任务声明的写点。`npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx` 在变体下同样应变红。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 在本仓库预先就有 146 条诊断并非 0，不作为判据）。

## DoD

真实落地判据：不是"测试存在"。要求在真实浏览器里跑出 2×2 矩阵的实际读数并写进 Evidence：桌面/触摸 × 偏好开/关，四格各记录 `defaultPrevented`、textarea 值（JSON 转义后原样）、`location.pathname`、以及提示文案与其容器 `display`。

另需两条正向对照读数，而不是"没写就等于没污染"：

1. 触摸 leg 里前后各读一次 `GET /api/user/preferences`，`uiPreferences.sendByCtrlEnter` 两次相同——证明判定确实没写回账号偏好。
2. 触摸模拟开/关各切一次（不刷新页面），提示文案在两个方向上都跟着变——证明这是活的 `change` 监听，而不是首帧读一次；对应"平板插上键盘"的真实场景。

读数必须如实标注边界：触摸来自 Chromium 的 touch emulation（翻转的是真实的 Blink 媒体特性，实测 `pointer: coarse`/`hover: none` 均为 true），**不是真机软键盘**；软键盘键帽长什么样、Android/iOS 的 Enter 如何投递（composition / `keyCode 229`）仍未实测。`enterKeyHint` 本任务不要求加（采纳 B 之后键帽问题自然消失），若要加必须同时说明它在触摸下应为 `enter`。

量测注意（避免重蹈原型的覆辙）：`page.setViewportSize`/`browser_resize` 只改视口，**不会**翻转 pointer 媒体特性；而 CDP 的 `setDeviceMetricsOverride` 在 CDP 会话断开后失效、`setTouchEmulationEnabled` 却会留下——原型就因此一度在 1280px 宽的视口下测"触摸设备"。所以 e2e 里视口与触摸必须由同一处配置（`test.use`）一起给，且上面那条前提断言就是防这个的。

既有 e2e 已知坑（沿用而非新增）：新库首次启动走 onboarding，`beforeAll` 等 `#username` 在负载下有 ~1/7 概率红在 ~184s（安静时约 11s）——按墙钟归因，不要加重试；项目可由 `playwright.config.ts` 在服务启动前写入 transcript 自动登记（中途写入会被 watcher 当成 session_upserted 并标 "needs attention" 导致随机红）。

L_D 该轴仍暗，理由：本任务修的是输入键的行为契约，不产出领域数据或文档语义读数；12 个 locale 的文案完整性由上面那条 i18n 判据单独机械钉住，除此之外该轴没有可分离的度量。

L_G 该轴仍暗，理由：同上；本任务的验证读数就是 DoD 里真浏览器 2×2 矩阵的四格读数与两条正向对照读数。

## Evidence

### 1. 真实浏览器 2×2 矩阵读数

一次 Playwright 运行内四格各起独立 browser context，同一账号、同一次服务启动；读数原样如下（`npx playwright test`，脚本为一次性探针，不入库）：

```
{"label":"touch×pref-off","touchOnly":true,"storedSendByCtrlEnter":false,"enterDefaultPrevented":false,"textareaValue":"\"hello\\n\"","pathnameBefore":"/","pathnameAfter":"/","hintText":"Tap ➤ to send • Return adds a line","hintDisplay":"block"}
{"label":"touch×pref-on","touchOnly":true,"storedSendByCtrlEnter":true,"enterDefaultPrevented":false,"textareaValue":"\"hello\\n\"","pathnameBefore":"/","pathnameAfter":"/","hintText":"Tap ➤ to send • Return adds a line","hintDisplay":"block"}
{"label":"desktop×pref-off","touchOnly":false,"storedSendByCtrlEnter":false,"enterDefaultPrevented":true,"textareaValue":"\"\"","pathnameBefore":"/","pathnameAfter":"/session/3cb8e266-3ec1-492a-bb73-9ea461bfa7cd","hintText":"Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands","hintDisplay":"block"}
{"label":"desktop×pref-on","touchOnly":false,"storedSendByCtrlEnter":true,"enterDefaultPrevented":false,"textareaValue":"\"hello\\n\"","pathnameBefore":"/","pathnameAfter":"/","hintText":"Ctrl+Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands","hintDisplay":"block"}
```

读法（这正是修复要立的契约）：

- **触摸列与偏好无关**：偏好关/开两格的四个读数逐字段相同——`prevented=false`、值恰好多一个 `\n`、`pathname` 停在 `/`、提示同为触摸文案。设备判定优先于账号偏好，且偏好开时也不会把 Enter 变回发送键。
- **桌面行按偏好分裂**：偏好关 `prevented=true` 且值被清空、`pathname` 跳到 `/session/<uuid>`（已发送，空值只是提交后清空的结果）；偏好开 `prevented=false`、值 `"hello\n"`、不发送。与改动前逐字符一致。
- 桌面两格的提示容器 `display:block` 是因为该窗口宽 1280px（≥`lg`）；触摸格在 390px 下同样是 `block`，即 `hidden lg:block` 已按设备摘掉。

### 2. 正向对照一：判定没有写回账号偏好

触摸 leg 内，页内自带 Bearer token 直连 `GET /api/user/preferences`，发送消息并等待写防抖（900ms）前后各读一次：

```
PREFERENCE before {"enabled":false}
PREFERENCE readings {"before":{"enabled":false},"after":{"enabled":false}}
```

两次相同，且该页自己发出的每一次 `GET /api/user/preferences` 都报 `false`。这不是"没写就等于没污染"：对照的是同一个键的两次独立读数。

### 3. 正向对照二：媒体查询是活的 `change` 监听，不是首帧读一次

触摸 leg 内用 CDP（`Emulation.setTouchEmulationEnabled` + `setDeviceMetricsOverride` **成对**下发，避免原型踩过的"只翻一半"）在不刷新页面的前提下双向切换，每次都轮询提示文案：

```
HINT after touch→keyboard flip {"text":"Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands","display":"none","opacity":"1"}
HINT after keyboard→touch flip {"text":"Tap ➤ to send • Return adds a line","display":"block","opacity":"1"}
```

两个方向都跟着变；且键盘态 `display:none`、触摸态 `display:block`——后者是证据而非"把类名删光"的产物，因为同一容器在键盘态仍保留 `hidden lg:block`（单测里有该正向对照）。这对应"平板插上键盘"的真实场景。

### 4. 边界（如实标注）

- 触摸来自 **Chromium 的 touch emulation**，翻转的是真实 Blink 媒体特性（页内实测 `pointer:coarse` 与 `hover:none` 均为 true，且 `'ontouchstart' in window` 为 false——后者不能用作嗅探，已在单测与 e2e 注释中钉住）。**不是真机软键盘**。
- 软键盘键帽长什么样、Android/iOS 的 Enter 如何投递（composition / `keyCode 229`）**仍未实测**。采纳 B+D 后键帽问题自然消失，故本任务**未加** `enterKeyHint`；若将来要加，触摸下其值应为 `enter`。
- 桌面 leg 的 `beforeAll` 走新库 onboarding，沿用既有 e2e 已知坑（负载下约 1/7 概率红在 `#username`）：按墙钟归因，未加重试。本次两次运行分别为 **20.6s** 与 **20.6s**（含两条 leg），远低于判据的 60s 上限。

### 5. 判据逐条读数

- AC-1/2/3 `npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx` → 退出 0，`Test Files 1 passed (1)`、`Tests 9 passed (9)`。四格断言各自独立：抗假变体下**只有** `touch×pref-off` 一格与"平板插键盘"用例变红，键盘两格仍绿——即四格不是一条共享断言。失败信息打印实际四格，例如变体下：`touch×pref-off is wrong; the four cells read {"touch×pref-off":{"sendOnEnter":true,"touchOnly":true},"touch×pref-on":{"sendOnEnter":false,"touchOnly":true},"keyboard×pref-off":{"sendOnEnter":true,"touchOnly":false},"keyboard×pref-on":{"sendOnEnter":false,"touchOnly":false}}`。
- 偏好污染断言：两轮（存储值 false/true 各一轮）中 `writeUserPreference` 与 `api.user.savePreferences` 的 spy 调用次数均为 **0**，且 `readStoredUiPreferences().sendByCtrlEnter` 在 leg 前后与播种值相同。
- 提示三分支：`touchOnly` 真时文案 === `input.hintText.touch`（不含 `Shift`/`Ctrl`，容器类名不含 `hidden`/`lg:block`）；排队态 === `touchQueue` 且 ≠ `touch`；`touchOnly` 假时 `enter`/`ctrlEnter`/`queue`/`updateQueued` 四例逐字符相同，且键盘态容器**仍带** `hidden lg:block`（正向对照）。
- AC-4 i18n → `locales=12 chat.json=12 settings.json=12 violations=0`。三个 chat 键（`touch`/`touchQueue`/`touchUpdateQueued`）12 个 locale 全部非空；12 个 `settings.json` 的 `quickSettings.sendByCtrlEnterDescription` 均**相对于 develop 有实际增长**且在原文之后追加，各 locale 增量与追加内容已逐条打印（zh-CN +34、zh-TW +41、ja +56、ko +65、en +123、id +133、es +134、ru +136、it +138、tr +138、de +141、fr +144 字符）——该判据不依赖任何多语言词表，只依赖"每个 locale 都真的被改过且原句仍在"。
- AC-5/6 `npx playwright test e2e/mobile-composer-send-key.spec.ts` → 退出 0，`2 passed (20.6s)`。触摸 leg 在断言行为前先断言 `(pointer: coarse) and (hover: none)` 为 true（连同两半分别断言），并先断言账号偏好确为关——否则该 leg 在桌面配置下会静默通过。
- AC-7 抗假变体：把 `useSendOnEnter` 改成 `sendOnEnter: !sendByCtrlEnter`（等价删掉触摸判定）后，单测 `Tests 2 failed | 7 passed (9)` 退出 1；e2e 触摸 leg 在**"输入文本后按 Enter 未提交"**那条变红——`expect(locator).toHaveValue(expected) failed / Expected: "hello\n" / Received: ""`（即消息被发出、输入被清空，正是缺陷现场）。还原后 `git diff` 为空（经 `git checkout` 从提交还原，非手工回写），全绿。
- AC-8 `npm run typecheck` 退出 0；`npm run lint`（`oxlint src/ server/`）退出 0。

## Touches

- src/modules/chat/hooks/useSendOnEnter.ts (new)
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/sendOnEnter.test.tsx (new)
- e2e/mobile-composer-send-key.spec.ts (new)
- playwright.config.ts
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- tasks/gap-composer-send-key-touch-scoped.md
