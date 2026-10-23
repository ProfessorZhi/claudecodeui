---
id: gap-desktop-activity-inline-single-stop
title: 桌面端执行状态并入消息流末尾、去掉 composer 上沿 tab 及其 Stop，与移动端统一；主 Stop 按钮是唯一停止入口（底部快捷键提示行不动）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数：同一区域已有 `gap-mobile-activity-inline-single-stop`（done）把移动端状态行放进消息流、只留主 Stop，并明文保留「桌面仍用 composer 上沿 tab、保留 Stop 与 Esc 提示」；`gap-activity-single-dock-global-consistency`（done）把活动并成单一坞。两条机制都不同于本任务：本任务是**撤销前者对桌面的保留**，让两个视口走同一条规则。`grep -rln "isInlineDock" tasks/` 只命中前者的实现记录，无任何任务认领桌面统一，不是重复。

现状（读代码）：`ChatMessagesPane.tsx:195` 的 `isInlineDock = isMobile || isShortTouchViewport` 决定状态行是否渲染，`:339` 据此区分底部留白（`pb-12 md:pb-14` 与 `pb-3 sm:pb-4`）；`ChatComposer.tsx:570` 以相同条件的取反渲染绝对定位的 tab，`:743` 用 `rounded-t-none` 与 tab 拼接输入框顶角。桌面执行中因此有两个可访问名为 Stop 的入口（tab 里的 Stop + `esc`，与右下角主按钮）。用户已裁定：桌面统一接受「状态行随消息流滚动，上翻历史时看不到还在跑」这一代价；底部快捷键提示行（`Enter to send • Shift+Enter …`）**不动**。

目标：

- 任何视口宽度与高度，运行状态都只渲染为 `ChatMessagesPane` 消息内容末尾的流内状态行（脉冲点、活动文本、elapsed）；`ChatComposer` 不再渲染悬浮 tab。`isInlineDock` 分支删除而非改成常量，因此「状态行与 tab 不会同时出现或同时缺席」不再依赖两处条件对齐。
- 删除桌面专属的配套处理：`ChatComposer` 的绝对定位外层与 `rounded-t-none` 条件；`ChatMessagesPane` 的 `hasActivityIndicator && !isInlineDock ? 'pb-12 md:pb-14'` 分支，底部留白恒为 `pb-3 sm:pb-4`。`hasActivityIndicator` 仍用来决定传给状态行的是 `activity` 还是 `null`（权限请求出现时继续隐藏，退出动画仍由组件自持）。
- `ActivityIndicator` 删除 Stop 按钮及其专属物：`onAbort`、`stopReasonId`、`stopReason`、`isInputFocused` 阴影分支；`activityDockView.ts` 里 `showStop`/`stopDisabled`/`stopReasonKey` 只有在 `ChatComposer`（`composerDock.stopReasonKey`，`:483`）等其他消费者也不再读取时才退役，先 grep 全部消费者再删，不得破坏主按钮在 `unreachable` 状态下已有的禁用与可见原因。
- Esc 中止由 `ChatInterface.tsx:345` 的全局 capture 阶段键盘监听持有（`canAbortSession` 为真时按 Esc 无条件调用 `handleAbortSession`），不依赖 `ActivityIndicator` 是否挂载，本任务**不改它的行为**；Esc 提示迁到主停止按钮的 `title`（形如「Stop (Esc)」），`aria-label` 保持 `input.stop`/`resident.stopResident` 不变，按名字找按钮的既有读数不受影响。
- 断连读数不丢：`unreachable` 时状态行写着「Connection lost · reconnecting…」，主按钮保持既有的禁用与原因展示。本任务用测试钉住这一点，而不是默认成立。

不做：不改底部快捷键提示行（`submitHint` 那一行及其 `touchOnly`/`lg` 显隐规则）；不改发送、排队、中止的业务行为（含上述 Esc 监听）；不改 `sessionActivity` 的产生方式、WebSocket 协议与服务端；不碰 header、录音回放与 footer 的其它布局；`docs/proposals/mobile-workspace-and-composer-layout.md` 目前是未跟踪文件，不在 worktree 内，不作为本任务的改动面（其目标 6 与第 5 节矩阵的更新另行随该文件入库时处理）。

实施规范：按 `.agents/skills/frontend-module-standards/SKILL.md`（`@/` 导入、导出组件消费者注释随消费者变化更新、被删 prop 的所有调用点同步清理、不留死导出）。

## AC

- [x] `npx vitest run src/modules/chat/tests/activityIndicatorResponsive.test.tsx` 退出码 0，用例各自独立、失败信息打印实际读数：(a) 流内状态行渲染活动文本与 elapsed，其子树内无可访问名含 Stop 的元素；(b) 桌面档（`isMobile=false` 且非短触屏）的 `ChatMessagesPane` 在最后一条消息之后、滚动容器内部渲染状态行，类名不含 `absolute` 与 `fixed`；(c) 桌面档 `ChatComposer` 子树内不存在 `[data-activity-dock]`；(d) `activity` 由非空变 `null` 时按现有退出动画收起，移动档与桌面档行为一致；(e) 断言「桌面有 tab」的旧用例已被删除或改写，文件内不再出现 `tab variant` 的正向读数。
- [x] `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` 退出码 0：把 composer 与 pane 一并渲染，桌面档与移动档的可访问性视图里可访问名含 Stop 的按钮恰好 1 个且为 `PromptInputSubmit`；存在 pending 权限请求时两档均不渲染普通活动状态；主停止按钮 `title` 含 `Esc`、`aria-label` 与改动前一致；`unreachable` 状态下主按钮禁用且原因可见（断言实际读数）。
- [x] 底部留白：桌面档 `hasActivityIndicator=true` 时 pane 内容底部间距不含 `pb-12`/`md:pb-14`；`grep -nE 'pb-12|md:pb-14' src/modules/chat/transcript/ChatMessagesPane.tsx` 无命中（退出码 1）。
- [x] 悬浮 tab 彻底退役：`grep -nE 'isInlineDock|chat-activity-tab|rounded-t-none' src/modules/chat/composer/ChatComposer.tsx src/modules/chat/transcript/ChatMessagesPane.tsx src/modules/chat/composer/ActivityIndicator.tsx` 无命中（退出码 1）；`grep -n 'onAbort' src/modules/chat/composer/ActivityIndicator.tsx` 无命中（退出码 1）。
- [x] Esc 中止与 tab 无关：新增或保留一个用例，桌面档渲染 `ChatInterface`（此时页面上没有悬浮 tab），`canAbortSession` 为真时按一次 Esc，`handleAbortSession` 恰被调用 1 次；`canAbortSession` 为假时按 Esc 调用 0 次。该用例钉住 `ChatInterface.tsx:345` 现有监听的行为，不改变它（对照：`git diff develop -- src/modules/chat/ChatInterface.tsx` 不含对该 `useEffect` 的改动行）。
- [x] 跟随不回归：`npx vitest run src/modules/chat/tests/transcriptScrollOwnership.test.tsx src/modules/chat/tests/messageStreamEnd.test.tsx` 退出码 0；并在 `activityIndicatorResponsive.test.tsx` 新增桌面档用例——状态行挂载与 elapsed 更新时，用户在底部则继续贴底，用户已上滚离底则零次程序化写 `scrollTop`。
- [x] 同类测试同步：`npx vitest run src/modules/chat/tests/activityDockConsolidation.test.tsx src/modules/chat/tests/activityDockUnreachable.test.tsx src/modules/chat/tests/activityDockPhaseTruthful.test.tsx` 退出码 0（凡点击 dock 内 Stop 的断言已改为点击主按钮，读数含义不变）。
- [x] `npx vitest run src/modules/chat` 退出码 0；`npm run typecheck` 与 `npm run lint` 退出码均为 0。
- [x] 底部提示行未被触碰：`git diff develop -- src/modules/chat/composer/ChatComposer.tsx` 中不含对 `submitHint`、`input.hintText` 与提示行 `className`（含 `touchOnly ? 'hidden' : 'hidden lg:block'`）的任何改动行（逐行核对 diff）。

## DoD

真实落地判据：不是「测试存在」。在真浏览器里对一个真实执行中的会话（或经既有 e2e 约定的 in-page WebSocket 替身喂入真实 realtime 帧：伪造传输层、不伪造消费者，见 `e2e/transcript-follow.spec.ts`）读出并写进 Evidence：

| 视口 | 可见且可访问的 Stop 个数 | 状态行位置 | 是否覆盖消息正文 | 是否随消息滚动 | 输入框上方是否有悬浮元素 |
|---|---|---|---|---|---|
| 1440×900 执行中 | 必须恰 1 | 紧随最后一条消息之后，在滚动容器内 | 必须否（与最后一条消息边界框不相交） | 必须是（滚动后 `getBoundingClientRect().top` 随之变化） | 必须无 |
| 1280×720 执行中 | 同上 | 同上 | 同上 | 同上 | 同上 |
| 768×900 执行中 | 同上 | 同上 | 同上 | 同上 | 同上 |
| 390×844 执行中 | 与改动前一致（恰 1） | 同上 | 同上 | 同上 | 同上 |

另读：1440×900 下向上滚离底部后再来一段流式输出，页面不被拉回底部，且状态行此时不在视口内（这是被接受的代价，Evidence 里如实写出）；发起权限请求时普通活动状态消失、权限提示可见；运行中按 Esc 实际中止；活动结束后状态行按退出动画收起；服务端失联时状态行写出断连文案、主 Stop 禁用且原因可见。「可见且可访问的 Stop」必须用可访问性树（`getByRole('button', { name: /stop/i })` 且可见）计数，不得用类名或 `querySelectorAll` 估算。底部快捷键提示行在 1440×900 下仍然可见、文案与改动前逐字相同。

读数如实标注边界：一次性探针不入库；永久回归矩阵由 `e2e/activity-dock-truthful.spec.ts` 与新增的桌面视口用例承担；若执行态由传输层替身喂入，Evidence 里写明喂了哪些帧、没伪造什么。

L_D 该轴仍暗，理由：本任务改的是活动状态的呈现位置并删除一个重复的控件，不产出领域数据或文档语义读数。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/utils/activityDockView.ts
- src/modules/chat/tests/activityIndicatorResponsive.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/modules/chat/tests/activityDockConsolidation.test.tsx
- src/modules/chat/tests/activityDockUnreachable.test.tsx
- src/modules/chat/tests/activityDockPhaseTruthful.test.tsx
- e2e/activity-dock-truthful.spec.ts
- e2e/resident-ui-layout.spec.ts
- e2e/resident-busy-send.spec.ts
- e2e/mobile-workspace-composer-layout.spec.ts
- tasks/gap-desktop-activity-inline-single-stop.md
- src/modules/chat/ChatInterface.tsx （`isInputFocused` prop 随其唯一派生站删除；AC5 的对照只禁止改 Esc useEffect，本处不改）
- src/modules/chat/tests/occupiedSessionReadOnly.test.tsx （被删 prop 的调用点同步清理）
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx （AC5：桌面档渲染 ChatInterface，Esc 中止恰 1 次、canAbortSession 假时 0 次）