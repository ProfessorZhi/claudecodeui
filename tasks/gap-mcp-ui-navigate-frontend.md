---
id: gap-mcp-ui-navigate-frontend
title: 前端执行 ui.navigate：按本设备策略（接受/询问/拒绝）分流，确认提示条（跳转/忽略/总是接受/总是拒绝），导航到会话并定位消息，回
  ack 与最终结果
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-ui-device-settings
  - gap-mcp-ui-device-identity-hello
---
## Proposal

**背景（2026-10-07 与 yale 的讨论）：** `ui_open_session` 让外部 agent 在**指定设备**的浏览器里打开某个会话、翻到固定位置。策略与确认都在前端，每台设备各自决定。本任务交付前端半边：收到服务端的 `ui.navigate` 帧后，按本设备策略分流并执行；服务端半边在 `gap-mcp-ui-open-session`。

**已定的行为：**

- 策略（来自 `gap-mcp-ui-device-settings` 的 `readMcpNavigationPolicy()`，默认 `ask`）：
  - `reject`：不显示任何界面，直接回 ack `declined`（原因 `policy`）。
  - `accept`：直接导航，回 ack `applied`。**输入框有未发送草稿时仍然保持「接受」的行为**：本项目已按会话保存草稿（见 `src/modules/chat/hooks/useChatComposerState.ts`，草稿随会话持久化），跳转不会丢失草稿，所以不降级。
  - `ask`：显示非阻塞的确认提示条，先回 ack `shown`；用户操作后再发最终结果帧。
- 提示条内容：请求方客户端名、目标会话标题、定位说明（例如「第 N 条消息附近」或「最新」）；按钮：**跳转**、**忽略**、**总是接受**、**总是拒绝**。「总是接受 / 总是拒绝」点击时写回本设备策略（`useMcpNavigationSettings`），并在按钮旁明示「会修改设置」；其效果是本次请求立即按新策略处理（总是接受 = 本次跳转；总是拒绝 = 本次忽略）。
- 提示条 30 秒无操作自动失效，视为 `ignored`；新请求到来时旧提示条立刻失效，视为 `superseded`；同一时刻只保留一个提示条。
- 定位只支持两种：`{ latest: true }`（翻到底部，默认）与 `{ messageId }`（翻到该消息）。消息 id 不存在或无法定位时，仍打开会话，ack 带 `reason: MESSAGE_NOT_FOUND`，状态 `applied`（部分成功）。

**现状（已读代码核实）：**

- 路由 `/session/:sessionId`（`src/App.tsx`），工作区内导航在 `src/modules/project-workspace/ProjectMainRegion.tsx` 的 `navigate(\`/session/${targetSessionId}\`)`。
- 「以某条消息为中心取窗口」后端已有（`fetchWindowAround`，`/api/providers/sessions/:sessionId/messages?around=`），前端 `useSessionStore.ts`、`useChatSessionState.ts` 里有相关的窗口与滚动逻辑；**其中是否已有可直接复用的「跳到某条消息」入口尚未核实**，实现的第一步是读这两个文件并把结论写进 Proposal 的末尾补记。
- WS 入站帧在 `src/shared/context/WebSocketContext.tsx` 处理；设备身份与响应原语由 `gap-mcp-ui-device-identity-hello`、`gap-mcp-ui-visible-context` 提供。

**帧约定：**

- 服务端到前端：`{ type: 'ui.navigate', navigationId, requester, sessionId, at }`。
- 前端到服务端：`{ type: 'ui.navigate_ack', navigationId, status: 'shown' | 'applied' | 'declined', reason? }`（送达确认，服务端只等这一帧）；用户在提示条上操作后再发 `{ type: 'ui.navigate_result', navigationId, status: 'applied' | 'declined' | 'ignored' | 'superseded' | 'expired', reason? }`。

**要交付：** 新 hook `src/modules/chat/hooks/useUiNavigate.ts` 与提示条组件 `src/modules/chat/components/UiNavigatePrompt.tsx`（遵守 `$frontend-module-standards`），在 `WebSocketContext.tsx` 挂接 `ui.navigate`；新增键的 i18n 文案补全各语言（`src/modules/i18n/locales/*/chat.json` 12 种语言）。

**补记（2026-10-07，实现完成后逐条核实）：**

**1. 定位入口的核对结论（本任务的第一步，也是 AC5）。** 两个文件都读过了：

- `useSessionStore.ts` **无需改动**，它的两枚入口正好够用：`loadWindowAround(sessionId, anchorId, { before, after })` 走既有的 `?around=` 窗口读（服务端只回该锚点周围的切片），`jumpToLatest(sessionId)` 翻到尾部。它自己是「取窗口」，不做「把窗口里的某一行移进视口」。
- 真正的「跳到某条消息」入口**已经存在**，在 `useChatSessionState.ts` 的 `jumpToMessage(anchorId)`：按 `transcriptAnchorId ?? id`（即 `anchorIdOf`）在已加载窗口里解析锚点，缺失时才 `loadWindowAround`，再经 rAF 把持久行包装 `[data-message-anchor-id]` 滚进视口。侧边栏搜索跳转与轮次导轨本来就走这条路径，**所以本次直接复用，没有新增定位实现**——Proposal 里「是否已有可复用入口尚未核实」的问题，结论是「有，且就是 sidebar search / rail 用的那一条」。
- 对 `useChatSessionState.ts` 的**第一处**改动：`jumpToMessage` 的返回值由 `void` 变成 `Promise<boolean>`（该消息已在转写中且视口正被移向它 → `true`；会话或锚点缺失、锚点不在窗口、或抛错 → `false`）。`MESSAGE_NOT_FOUND` 只有靠这个布尔值才判定得出来——「会话打开了但那条消息找不到」与「定位成功」在别处是同一种静默。既有调用方都不读返回值，改动向后兼容。该文件的**第二处**改动是合并 develop 后复跑 DoD 时发现的加载竞态修复，见补记第 5 条。

**2. 挂接点与 Proposal 的偏差（已记录，不是遗漏）。** Proposal 写的是「在 `WebSocketContext.tsx` 挂接 `ui.navigate`」。实现前核实：`WebSocketProvider` 位于 Router **之外**，本身不持有任何路由或转写状态，而「执行导航 + 定位消息」恰恰需要这两样，它没有 `useNavigate` 也没有 `jumpToMessage`。因此 hook 改由 **`ChatInterface.tsx`** 挂载：那里同时持有 `subscribe`、`sendMessage`、`onNavigateToSession`、`currentSessionId`、`jumpToMessage`、`scrollToBottomAndReset`，提示条也渲染在那里（`MarkdownWorkspaceContext.Provider` 之前）。**`WebSocketContext.tsx` 与 `useSessionStore.ts` 因此一行未改**；两者仍列在 Touches 里，只是为了记录这次核对。

- 顺带核实的模块依赖方向：chat → settings 是一条新边（settings → chat 早已存在），`.oxlintrc.json` 的 boundaries 只约束「跨模块必须走 barrel」、没有环检测规则，且 `settings/index.ts` 已导出 `writeMcpNavigationPolicy`；真正渲染 `ChatInterface` 的 `ProjectMainRegion` 测试（`chatInterfaceEscapeAbort.test.tsx`）也仍然通过。

**3. 提示条里「目标会话标题」的边界。** 标题按「当前选中项目的 session 列表 → 当前打开的会话」两级解析（`ChatInterface.resolveUiNavigateSessionTitle`）。目标会话属于**另一个项目**时解析不到：那份列表在 project-workspace 的 `ProjectsState` 里，而 project-workspace 已经 import chat，反向 import 会成环，故不回退到跨模块取数。此时提示条显示「另一个会话」而不是猜一个名字——请求方与定位说明仍然照常显示。e2e 里跨项目那一臂就是这个情形，同项目那一臂则断言标题确实出现。

**4. DoD 实证（真实运行的前端，非测试桩）。** `e2e/ui-navigate.spec.ts`：真实 Chromium + 真实后端 + 真实 Vite（`playwright.config.ts` 起的隔离数据目录），账号经向导创建，起始会话与目标会话都经侧边栏自己的链接打开。它在前端启动前包一层 `window.WebSocket`，把一帧模拟的 `ui.navigate` 通过 `dispatchEvent(new MessageEvent('message', …))` 交给应用自己的 socket，实测到：

- 策略未设置（默认 `ask`）时提示条出现，含请求方 `playwright-probe` 与定位说明，**且此时页面没有跳转**；
- 点「跳转」后 URL 变为 `/session/e2e-transcript-jump`，`Turn 121` 那一行**整行**落在转写视口内（`Turn 121` 距尾部 3600 行，尾页不可能自带它）；
- 点「总是接受」写入本设备策略并立即跳转，随后再触发一次：直接跳转、无提示条，且回帧是 `ui.navigate_ack{status:'applied'}`——「没问过」的判据是 ack 的 status 不是 `shown`，而不是「提示条此刻不可见」（一闪而过的提示条同样不可见）；
- Settings → API & Tokens 里 `mcp-navigation-policy-accept` 为选中态。

后端半边（`ui.navigate_ack` / `ui.navigate_result` 的路由，以及 `ui.navigate` 的发出方）属 `gap-mcp-ui-open-session`，本构建的服务端会把未知帧型回成 `protocol_error`、而客户端会把它渲染成转写里的一行错误，所以该 spec 只**捕获**前端发出的回帧、不真的发给服务端（前端仍然调真正的 `sendMessage`，被断言的正是它产出的那一帧）。这一点写在 spec 的注释里。

**5. 合并 develop 后复跑 DoD 时发现并修掉的一处竞态（同一次实现内，不是新范围）。** 合并后复跑，出现过一次「点了跳转、URL 换了、目标行却没留下」。用一张临时的诊断 spec 在真实页面里每 50 ms 采样 DOM 与 store 状态，抓到两件事：(i) `[data-message-anchor-id]` 那一行先以**空壳**出现（有几何、无文本、`fully` 为真），约 70 ms 后整段消失，store 从「锚点周围 81 条、offset 4360」退回「尾部 20 条、offset 20」——`Turn 121` 从未渲染出来；(ii) store 写日志显示**同一会话的首页请求发了两次**。

原因：`useChatSessionState.ts` 的主加载 effect 用 `lastLoadedSessionKeyRef`（发请求时就写）加 `slot.fetchedAt`（请求落地后才写）判「这个会话已经加载过」。首页在途时这个判断为假，effect 一旦重入（会话列表刷新递回新的 `selectedProject` 对象）就会再发一份首页。两份首页按 FIFO 与跳转的 `loadWindowAround` 交错排队，**第二份首页落地最晚，把跳转刚取回的窗口整个覆盖掉**；`jumpToMessage` 于是在窗口里找不到锚点，「跳转」只剩 URL 变了——核心承诺（打开会话并滚到目标消息）实际没兑现，而它平时是靠第二份首页恰好落地得晚才看起来通过。

修法：新增 `inFlightFirstPageKeyRef`——同一会话的首页在途时 effect 重入直接返回，落地后释放（约 30 行，只动 `useChatSessionState.ts`）。修后同一采样里首页只发一次，锚点窗口稳定保持，目标行带着自己的文本 `Turn 121. …` 停在视口内直到采样结束。

**判据也随之收紧。** 原来的读法是先等「整行在视口内」、再读行文本，而空壳天生满足几何条件，等待可以被一行还没渲染内容的东西满足。现在 `expectLandedOn` 把两个条件合成一次轮询：整行在视口内**且**行文本命中的就是被寻址的那一轮——空壳与邻行都过不了。修后连跑 4 次全过（`npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 17/17、`npm run typecheck`、`npx oxlint src/modules/chat` 均为 0）。

## AC

- [x] `npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出码 0：策略 `reject` 时不渲染提示条且回 `declined`/`policy`；`accept` 时直接导航并回 `applied`，且输入框有草稿时同样直接导航、草稿内容保持；`ask` 时先回 `shown` 并渲染提示条，点「跳转」后导航并发 `applied`，点「忽略」发 `ignored`。
- [x] 同一测试文件断言：提示条 30 秒无操作发 `expired`；新请求到来时旧提示条发 `superseded` 且只剩一个提示条；点「总是接受」把本设备策略写成 `accept` 并立即跳转，点「总是拒绝」写成 `reject` 并发 `declined`。
- [x] 同一测试文件断言：`at: { messageId }` 存在时调用定位入口，不存在时仍打开会话且 ack 带 `MESSAGE_NOT_FOUND`；`at: { latest: true }` 翻到底部。
- [x] 12 种语言的 `chat.json` 都含提示条新增的键（逐文件 `grep` 或沿用现有 i18n 完整性测试的方式断言），`npm run typecheck` 与 `npx oxlint src/modules/chat` 退出码 0。
- [x] Proposal 末尾已补记对 `useSessionStore.ts` / `useChatSessionState.ts` 定位入口的核对结论，且实现与该结论一致。

## DoD

在真实运行的前端里：本设备策略为「询问」时，用一个模拟的 `ui.navigate` 帧触发，提示条出现，点「跳转」后打开目标会话并滚到目标消息；点「总是接受」后再触发一次，直接跳转且无提示条；Settings 里能看到策略已变为「接受」。仅有测试通过不算完成。

（实证：`e2e/ui-navigate.spec.ts`，2026-10-07 通过，退出码 0；细节见 Proposal 补记第 4、5 条。）

## Touches

- src/modules/chat/hooks/useUiNavigate.ts
- src/modules/chat/components/UiNavigatePrompt.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/settings/hooks/useMcpNavigationSettings.ts
- src/modules/settings/index.ts
- src/shared/context/WebSocketContext.tsx
- src/shared/types.ts
- src/modules/chat/tests/uiNavigate.test.tsx
- e2e/ui-navigate.spec.ts
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- tasks/gap-mcp-ui-navigate-frontend.md
