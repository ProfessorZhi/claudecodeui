---
id: gap-mcp-ui-visible-context-null-range-in-real-browser
title: ui_visible_context 在真实浏览器里 visibleMessages 恒为
  {first:null,last:null}、panel 为 null：定位成因并修到返回真实可见消息范围与当前面板
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

**Finding（2026-10-07，对运行中的服务做真实调用）：** 用 PAT 经 `/mcp` 调 `ui_visible_context`，设备是 Chrome · Android，正停在一个有大量消息的会话上，返回的该标签页是 `visibleMessages: {first: null, last: null}`、`panel: null`，而 `selectedProject`、`selectedSession`、`visibility`、`hasFocus`、`navigationPolicy` 都正确。`gap-mcp-ui-visible-context` 的 AC 全部勾选，DoD 也写着「返回的设备含该会话的 id 与可见消息 id 范围」，但范围这一项在真实浏览器里没有出现。单元测试通过是因为它在 jsdom 里用了手工构造的 DOM。

**现状（已读代码核实）：**

- 应答在 `src/modules/chat/hooks/useUiStateResponder.ts`：`readVisibleMessages()` 遍历 `document.querySelectorAll('[data-message-anchor-id]')`，用 `getBoundingClientRect()` 与滚动容器的裁剪矩形判断可见，取文档顺序里第一个与最后一个可见行的 id；`readActivePanel()` 读 `[data-workspace-tab][aria-current="true"]` 的 `data-workspace-tab`。
- `data-message-anchor-id` 由 `src/modules/chat/transcript/LazyMessageRow.tsx:136` 的持久包装元素产生，只有 `anchorId` 非空时才有该属性；该文件头注释说明行是懒加载的（挂载时可能为空的占位）。
- **成因尚未确定，以下只是候选，实现第一步必须用真实浏览器复现并证伪其余：** (a) 当前可见的行没有 `anchorId`，所以没有该属性；(b) 行存在但 `rowIsVisible` 的几何判断在手机布局里失败（滚动容器是 `scrollClipOf` 没找到的元素，或被判为不相交）；(c) 响应时机取到的是尚未挂载内容的占位行；(d) `panel` 为 null 可能是手机布局根本不渲染 `data-workspace-tab`，此时 null 是合法值，不应当当作缺陷。

**要交付：**

1. 先在真实浏览器里复现（至少一个手机视口与一个桌面视口），逐个排查候选成因，把结论补记在本 Proposal 末尾的「成因」小节。
2. 修复 `readVisibleMessages`，使在会话有可见消息时返回真实的首尾消息 id（这些 id 必须能被 `session_read mode=around` 的 `around` 参数解析）；空会话或确无可见行时仍返回 `{first:null,last:null}`。
3. `panel`：若手机布局确实没有可读的面板标识，则按成因结论给出稳定的取值（例如手机布局上报当前视图名），或在返回里明确该字段对该布局不适用；不允许让「没有面板」和「读取失败」都表现为同一个 `null`。
4. 为防回归，补一条真实浏览器的 e2e：在手机与桌面两种视口下，经真实服务发出 `ui.state_request`，断言应答的范围非空且 id 命中页面上实际可见的消息行。
5. 不新增 `server/**/*.test.ts` 文件（避免触动 quay-test-script 的文件数 pin）；前端回归写进已有的 `src/modules/chat/tests/uiStateResponder.test.tsx`，e2e 放在 `e2e/` 下。

### 成因

复现用的夹具：一条 prompt + 一条比任一被测视口都高的助手回答（`e2e/ui-visible-context-range.spec.ts` 里的 `seedUiVisibleContextTranscript`，会话 `e2e-ui-visible-context`）。把 pane 滚到回答中段。证据分三类：真实浏览器里对运行中的服务下的 `/mcp` 调用、源码、以及运行时 dump 出的渲染树 props。

**(a) 成立 —— 这是 `visibleMessages` 恒为 null 的直接原因。** 转录发布的 `data-message-anchor-id` 直接取 `ChatMessage.transcriptAnchorId`（`ChatMessagesPane.tsx` 的 `anchorId={item.transcriptAnchorId}`），而 Claude provider 只给 `role === 'user'` 的行盖这个戳（它记的是「这条 prompt 锚定哪一轮」）。运行时证据：`scrollIntoTallestRow` 里 dump 渲染树，pane 带内那条助手行的 `id`、`transcriptAnchorId`、`forkAnchorId`、`blockKey` **全是 null**；`id` 之所以是 null，是因为投影对非 live 行有意不写 `id`（`useChatMessages.ts` 只给 `isLiveRowId` 的行写）。于是带内一个 `[data-message-anchor-id]` 都没有（探针一度读到 `anchorCount: 1`），`readVisibleMessages` 只能返回 `{null,null}`——而 pane 里明明有一条 4282px（桌面）/ 10042px（手机）的消息。**单元测试用手拼的 `div` 恰好绕过了这道投影，所以从未见过这个形态。**

**(b) 证伪。** `rowIsVisible` 的几何判断是对的：面板 `overflow-y` 为 `auto`，`scrollClipOf` 能解析到 `.chat-messages-pane`；带内各行的矩形与 pane 矩形确实相交。空范围来自 (a) 的缺地址，不是几何失败。

**(c) 证伪。** `LazyMessageRow` 的持久包装元素无论内容是否挂载都存在（`isMounted = lazyRows === null || isNearViewport`，未挂载时 wrapper 仍在 DOM 里带占位高度），而复现时那条可见的助手行是**完整挂载**的（满高、有文本）却仍无 anchor——所以这不是「取到占位行」的时机问题。

**(d) 成立（`panel` 为 null 的原因），但「手机布局下 null 是合法值」被证伪。** 桌面侧 `[data-workspace-tab]` 元素只有 `aria-selected`、没有 `aria-current`（dump 出 `ariaCurrent: null`），读不到活动项；手机侧 `tabEls: []`——`data-workspace-tab` 的行在未打开的 picker 对话框里，屏幕上不存在该属性。两种布局都在**明明显示着活动视图**时返回 null。所以 null 不是「该布局不适用」，而是「两种布局都没把活动视图说出来」。

**结论与修复一致：**

1. 把「一行由什么地址标识」收敛成一条规则 `messageAnchorId(message) = transcriptAnchorId ?? transcriptRowId ?? id ?? null`（`src/modules/chat/utils/messageKeys.ts`）。pane 用该规则发布 `data-message-anchor-id`，jump/locate 按同一属性查找（`findRenderedMessageElementById`），store 用它做 `windowIdOf`——读者只有一份，它们才会一致。为让 (a) 里那条助手行有地址，把「读到的行自己的 id」以 `transcriptRowId` 带到渲染消息上（`useChatMessages.ts` + `src/shared/types.ts` 新增字段）：它与 `id` 是两个字段，因为 React key 要跨 provider 重铸 ids 存活，而地址只需跨一次读取存活，二者稳定性要求相反。该地址与服务端 `session_read mode=around` 的解析口径（`transcriptAnchorId ?? id`）一致，所以报出的 id 一定可回读。
2. 让两种工作区界面渲染同一对 `data-workspace-tab` + `aria-current`（`WorkspaceTabs.tsx`）：桌面 pill 补 `aria-current`，手机折叠选择器的 **trigger**（关着时就摆在屏上、唯一说出当前视图的那个元素）也带上这对属性。`readActivePanel` 于是三态分明：无 `data-workspace-tab` → `null`（本页没有工作区，问题不成立）；有活动项 → 视图名；有壳但无活动项 → `'unknown'`（读取失败，导出常量 `UNKNOWN_PANEL`），不再与「无面板」共用一个 null。

### 验证

- `npx vitest run src/modules/chat/tests/uiStateResponder.test.tsx` → `10 passed`，退出码 0。新增用例经**真实 `LazyMessageRow`** 渲染行（`lazyRows={null}` 使内容挂载），pane 容器带 `overflow-y: auto`（与真实转录的裁剪结构一致），逐元素 stub `getBoundingClientRect`；断言首尾 id 非空且等于带内第一个/最后一个行的 `data-message-anchor-id`。另有：空带时诚实地返回 `{null,null}`；`messageAnchorId` 的三级优先；`null`（无工作区）与 `UNKNOWN_PANEL`（读取失败）不同值。
- `npx playwright test e2e/ui-visible-context-range.spec.ts` → `1 passed (22.5s)`，退出码 0。桌面与手机两种视口各跑一遍，真 PAT（经 `/api/settings/access-tokens` 铸出）、真 `/mcp` 调用、真 `session_read mode=around` 回读。
- **负控（AC-4）**：把 `readVisibleMessages` 临时改回恒返回 `{first:null,last:null}`，同一条 e2e 变红，断言行是 `e2e/ui-visible-context-range.spec.ts:313-316` 的 `expect(range?.first ?? null, …).not.toBeNull()`（`Received: null`，label `desktop: the reported range must name a first visible message`，tab dump `{"unresponsive":false,…,"panel":"chat","selectedSession":"e2e-ui-visible-context","visibleMessages":{"first":null,"last":null},…}`）。断言落在预期那一行，实现随即还原。
- `npm run typecheck` → 退出码 0；`npx oxlint src/modules/chat` → 退出码 0（无 error，仅既有 warning）。

## AC

- [x] 本 Proposal 末尾有「成因」小节，写明候选 (a)-(d) 各自被证实或证伪的依据，且其结论与修复一致。
- [x] `npx vitest run src/modules/chat/tests/uiStateResponder.test.tsx` 退出码 0，且新增的用例使用与真实转录一致的结构（经 `LazyMessageRow` 渲染的行，而不是手工拼的 `div`），断言返回的首尾 id 非空且等于视口内第一个与最后一个行的 `data-message-anchor-id`。
- [x] `npx playwright test e2e/ui-visible-context-range.spec.ts` 退出码 0：在手机视口与桌面视口各跑一遍，应答的 `visibleMessages.first` 与 `.last` 非空，且这两个 id 在页面上对应的行确实在视口内。
- [x] 同一 e2e 的负控：把 `readVisibleMessages` 临时改回返回恒 null 的实现，该用例必须变红（在报告里写明红的断言行）。
- [x] `panel` 在手机与桌面两种视口下的取值与成因结论一致，且「无面板」与「读取失败」不再是同一个值。
- [x] `npm run typecheck` 退出码 0；`npx oxlint src/modules/chat` 退出码 0。

## DoD

在真实运行的服务上实际操作一次：浏览器打开一个有多页消息的会话并滚到中间，用 PAT 经 `/mcp` 调 `ui_visible_context`，返回的 `visibleMessages.first/last` 是你屏幕上第一条和最后一条可见消息的 id，并且用其中一个 id 调 `session_read mode=around` 能读到对应消息；再用手机视口重复一次。仅有测试夹具通过不算完成。

## Touches

- src/modules/chat/hooks/useUiStateResponder.ts
- src/modules/chat/utils/messageKeys.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/project-workspace/WorkspaceTabs.tsx
- src/shared/types.ts
- src/modules/chat/tests/uiStateResponder.test.tsx
- e2e/ui-visible-context-range.spec.ts
- playwright.config.ts
- tasks/gap-mcp-ui-visible-context-null-range-in-real-browser.md
