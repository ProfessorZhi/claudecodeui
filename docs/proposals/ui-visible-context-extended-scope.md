# ui_visible_context 扩展范围规划：focused message / selected text / current diff / current task

- 状态：范围决策（只做调查与范围判定；未改任何实现代码、未新增字段、未立下游 task）
- 日期：2026-10-07
- 范围：仅 `ui_visible_context`（含它的浏览器半边 `useUiStateResponder`、服务端代理 `ui-state-request.service.ts` 与 MCP handler `mcp-ui-visible-context.ts`）的四个候选新维度
- 关联任务：`gap-mcp-ui-visible-context`（落地本工具）、`gap-mcp-ui-visible-context-null-range-in-real-browser`（真实浏览器下的范围读取缺陷修复）
- 关联代码：`src/shared/types.ts`（`UiVisibleContextReport`）、`src/modules/chat/hooks/useUiStateResponder.ts`、`server/modules/websocket/services/ui-state-request.service.ts`、`server/modules/mcp-gateway/mcp-ui-visible-context.ts`、`server/modules/oauth/access-tokens.service.ts`（`ACCESS_TOKEN_SCOPES`）

> 本文所有"现状"结论都来自对当前工作树代码的只读核对，逐条给出文件与符号；未运行浏览器、未跑任何 criterion。凡标"读代码"者即此意。

---

## 0. 结论摘要

本任务对四个候选维度逐一定了三态判定。结论是：**四个维度里，一个暂不纳入，三个"需要先补一点前端状态"（其中两个还要先定义"什么算当前"）**。没有任何一个维度现在就有可直接读取的单一状态——`ui_visible_context` 今天返回的一切（`panel`、`selectedProject`、`selectedSession`、`visibleMessages`、计数）都不需要新前端状态，因为它们在组件/deps 里已经存在；而这四个候选维度每一个都缺一块。

| 维度 | 判定 | 一句话理由 | 建议下游任务 |
|---|---|---|---|
| focused message | **暂不纳入** | 转录区没有任何"聚焦单条消息"的交互；候选触发点要么是瞬时的 jump，要么是从既有范围里凭空取的"中间点" | 暂无（等 reply/quote 或 turn 高亮交互出现再谈） |
| selected text | **需要先补前端状态**（且必须先定新 scope + 降级） | 浏览器 `window.getSelection()` 是现成的原语，但转录区没有区域化的选区读取逻辑，且选中文本是正文内容，超出 `cloudcli:read` 的"标识符与范围"边界 | `gap-ui-selected-text-scope-gate` |
| current diff | **需要先补前端状态** | Git 面板的展开态是 `Set<string>`（多文件同屏展开），根本没有单一"current diff"；要先定义可观测形态并补一个 DOM 契约 | `gap-ui-current-diff-reading` |
| current task | **需要先补前端状态**（其中"quay 任务"一半暂不纳入） | TaskMaster 任务板有真实的单选态 `selectedTask`，但它是组件私有且不可寻址；而 quay 任务面（`QuayPanel`）是只读镜像，压根没有"选中单个任务"的概念 | `gap-ui-current-task-reading` |

优先级建议：先做 **selected text 的 scope 决策**（它是唯一有隐私边界争议的，且决策会影响另外两个的字段设计），再做 **current diff**（无隐私争议、DOM 契约改动最小），最后做 **current task**（要处理两套任务 id 命名空间的歧义）。

---

## 1. 现状基线：ui_visible_context 今天到底返回什么

先把"基线"钉死，后面的"新增字段"才有参照。

每一台设备/标签页今天报告（`UiVisibleContextReport`，`src/shared/types.ts:584`，镜像在 `server/shared/types.ts:143`）：

- `deviceId` / `tabId` / `deviceName`——身份；
- `navigationPolicy` / `visibility` / `hasFocus` / `lastFocusedAt`——这台标签页的焦点状态；
- `panel: string | null`——当前工作区面板（读 DOM 的 `data-workspace-tab` + `aria-current`，`useUiStateResponder.ts:170`）；面板 id 集合见 `WorkspaceTabs.tsx`：`chat` / `shell` / `files` / `git` / `browser` / `tasks` / `quay`；
- `selectedProject` / `selectedSession`——打开的项目与会话；
- `visibleMessages: { first: string | null; last: string | null }`——视口内第一条到最后一行的 **id 范围**（`useUiStateResponder.ts:122`），是范围不是单条；
- `pendingApprovals` / `queuedMessages`——计数。

两条贯穿设计、且直接决定这四个维度能不能接进来的规矩：

1. **只报标识符与范围，不报正文。** 浏览器半边与 `readReport` 的投影白名单（`server/modules/websocket/services/ui-state-request.service.ts:133`）明确写着："whatever else the frame carries (**a message body, a selection**, a whole panel's content, a key a later client invents) is read by nobody"。**注意：这里 "a selection" 是被点名的、被主动丢掉的字段类型**——这不是疏漏，是这一层的既定边界。selected text 要进来，等于要动这条边界。
2. **能读就归入既有字段，不能读就给一个非 null 的哨兵，绝不用 `null` 兼职两种意思。** `panel` 用 `null`（没有工作区）与 `'unknown'`（有工作区但没读到）区分（`useUiStateResponder.ts:150`）就是先例。下面每个新字段都要遵守这条。

`ui_visible_context` 的 scope 是 `cloudcli:read`（`mcp-gateway.read-tools.ts:73`）。仓库已有的 scope 词表（`access-tokens.service.ts:41`）是：`cloudcli:read`、`cloudcli:session:send`、`cloudcli:session:create`、`cloudcli:session:control`、`cloudcli:approve`、`cloudcli:navigate`。最后一条 `cloudcli:navigate` 是"为单个高敏感动作新开一个 scope"的先例（`ui_open_session` 改的是用户屏幕），它是本文件里 selected text 决策的直接参照。

---

## 2. 维度一：focused message（用户聚焦/选中的那一条消息）——暂不纳入

### 2.1 代码现状（读代码）

逐条排除了所有可能的"聚焦单条消息"数据源：

- **没有 reply/quote。** `grep -rln "replyTo\|quotedMessage\|replyingTo\|referencedMessage" src` 无命中；`editingMessage\|onReply\|resendMessage` 在 `src/modules/chat` 下也无命中。用户根本没有"指着某条消息回复"的动作。
- **没有点击选中。** 转录行没有 `aria-selected`、没有 hover/click 捕获选中态；`ChatMessagesPane` 的行容器 `tabIndex={-1}`（`ChatMessagesPane.tsx:453`）只是让容器可被程序化滚动，不构成可聚焦的选择。
- **导航抽屉是"跳完即关"。** `InputOutlineDrawer` 点一条 user turn 就 `setIsOpen(false)` 再 `onJump(anchorId)`（`InputOutlineDrawer.tsx` 的 `handleJump`），不保留"我选中了第几条"的状态。
- **jump/locate 是命令式的一次性滚动。** `useUiNavigate` 对外只暴露 `locateMessage(messageId): Promise<boolean>`（`useUiNavigate.ts:62`），`useChatSessionState` 里按 `data-message-anchor-id` 找到元素、滚动、结束（`findRenderedMessageElementById`，`useChatSessionState.ts:121`）。**没有把"刚跳到的 id"存进任何 ref/state。** `ui_open_session` 的 `at.messageId` 走的是同一条路，同样不留痕。
- **没有任何保存 message id 的 state。** `grep` 在 `src/modules/chat` 下找不到"以 MessageId 结尾的 useState/useRef"。

结论：**前端不存在"当前消息"这个概念，一行 state 都没有。**

### 2.2 判定

**暂不纳入。** 理由点名到缺失的前端概念，而不是"以后再看"：

- 这一维度缺的**不是**一行 state，而是一个**交互**。要让"focused message"有数据源，得先在 UI 上发明一个"选中/聚焦一条消息"的动作（点击行选中？回复引用？当前 turn 高亮？），并回答它是否常驻、是否互斥、被别的动作打断时怎么清。这是产品交互设计，不是给 `useUiStateResponder` 加一个 deps 字段。
- 现存的两个候选触发点都不合格：jump/locate 是**瞬时**的（滚完就没有"现在在哪条"的意图，滚动位置随时被用户的下一次滚动推翻），把它固化成"当前消息"是无中生有；而"取 `visibleMessages` 的中点/第一条"更糟——它只是对同一个滚动位置换一种算法再报一遍，并不携带任何用户意图，`first`/`last` 这个范围已经把它夹在里面了，多一个"中间那条"是冗余而非新信息。

因此本维度**不拆下游任务**。

### 2.3 复核条件（什么时候可以再谈）

若将来出现下列任一交互，它自带的状态就是数据源，届时按"可直接拆实施任务"重新评估：

- 用户能对某条消息发起**回复/引用**（该消息 id 会进 composer 的引用态）；
- 转录有了**"当前 turn"高亮**或键盘上下键在行间移动的焦点模型（会产生一个常驻的"焦点行 id"）。

到那时建议的字段形态是 `focusedMessageId: string | null` 与既有 `visibleMessages` 并列；但在交互落地前，这个字段无源可读。

---

## 3. 维度二：selected text（用户当前选中的文本）——需要先补前端状态（且必须先定新 scope 与降级）

### 3.1 代码现状（读代码）

- **聊天转录区没有任何"浏览器文本选择"的读取逻辑。** `grep -rln "selectedText\|getSelection\|selectionchange" src` 只命中 `src/modules/shell/`，那是终端 xterm 自己的 `getSelection()`（`useShellTerminal.ts:224`、`mobileTerminalSelection.ts:663`），与聊天转录无关。
- 转录区**没有**读 `window.getSelection()` 的代码，`ui_visible_context` 也就无从带回任何选区信息。
- 前文 §1 已指出：投影白名单**主动丢弃** "a selection"（`ui-state-request.service.ts:133` 的注释），所以哪怕浏览器多发了选区，服务端也不会让调用方看到。

也就是说：**浏览器原语（`window.getSelection()`）现成，但应用层没有区域化、可寻址、可控的读取。** 这是"缺一块前端状态 + 一条新边界"，不是"缺一个交互"。

### 3.2 判定

**需要先补前端状态。** 待补的是 `useUiStateResponder` 里的一个选区读取器，范围明确、不大，但**必须同时决定三件事**：区域（只在转录区内选才算数，还是全页面）、敏感度（要不要新 scope）、降级（返回原文还是长度截断 + 标记）。

### 3.3 范围描述（可直接转下游任务）

- **数据源（待补状态）。** 在 `src/modules/chat/hooks/useUiStateResponder.ts` 增加 `readSelectedText()`（与 `readVisibleMessages` / `readActivePanel` 并列的 DOM 读取器）：
  - 读 `window.getSelection()`；
  - **区域判定**：仅当选区的 anchor/focus 都落在转录容器内（该容器有 `[data-message-anchor-id]` 行；用 `closest` 判定）才算数——选区在侧边栏、Git 面板或终端里时一律当"没有选中"；
  - 只发**已"落定"**的选区（`selectionchange` 的常见做法是读 `selection.isCollapsed === false` 为真才算）；
  - 不新增 deps，纯 DOM 读取，与既有两个读取器同构，因此**不需要把 state 提到 provider**——这一点让它停在"小改动"。
- **`ui_visible_context` 返回里新增的字段名与类型。**

  ```ts
  /**
   * 用户在转录区内选中的文本。
   * - `null`：没有（有效区域内的）选区；
   * - `'withheld'`：有选区，但本次调用的令牌没有 `cloudcli:selection`（见下）；
   * - 对象：授权后的降级读数。
   */
  selectedText:
    | { text: string; truncated: boolean; region: 'transcript' }
    | null
    | 'withheld';
  ```

  三态是有意的，遵守 §1 的第 2 条规矩：`null` 只表示"没有选区"，"有选区但无权读"必须用 `'withheld'` 区分，否则一个无权限的调用会把"用户正选着一段敏感文本"读成"用户什么都没选"。

  **投递方式（决策点）：** 推荐**不**把它加进 `ui_visible_context`（`cloudcli:read`）的常规返回，而是新开一个**独立读工具** `ui_selected_text`（`requiredScope: 'cloudcli:selection'`），返回同一形状的 per-tab 读数。理由：读工具的 seam（`McpReadToolRegistration.handler: (args) => unknown`，`mcp-gateway.read-tools.ts:1016`）**不传 `ctx`**，要在 `ui_visible_context` 内部做字段级 scope 判定就得改读 seam 的签名；而"单个高敏感动作 → 单个新工具 + 单个新 scope"正是 `ui_open_session` / `cloudcli:navigate` 的既有先例，零新机制。（resident 工具那条 seam 是能拿到 `ctx.principal.scopes` 的——见 `mcp-session-background.ts:253`——所以若确实想留在 `ui_visible_context` 内，另一条路是把该工具挪到能拿 `ctx` 的 seam，代价更大。）本文件推荐前者。
- **是否需要新 scope / 降级展示的决定（本维度重点）。**
  - **要新 scope**：新增 `cloudcli:selection`，**追加在 `ACCESS_TOKEN_SCOPES` 数组末尾**（`access-tokens.service.ts:41`；数组注释说明位置被若干处"按位置读取"依赖，只能追加，不能插中间）。
  - **理由**：选中文本是**正文内容**，正是 §1 规矩 1 明令不进 `ui_visible_context` 的东西（用户可能正选着密钥、私聊、银行卡号）。它比 `selectedSession`（一个 id）高一级敏感度，需要比 `cloudcli:read` 更高的授权粒度——`cloudcli:navigate` 是同类先例。
  - **即便授权，也要降级**：`text` 设长度上限（建议 ≤ 500 字符，与服务端已有的 `UI_CLIENT_ID_MAX_LENGTH` / `UI_CLIENT_NAME_MAX_LENGTH` 的风格一致），超限截断并置 `truncated: true`；`region` 恒为 `'transcript'`（它同时是"我确实做了区域判定"的证据）。
  - **默认行为**：令牌没有 `cloudcli:selection` 时，浏览器照发（浏览器不知道令牌），服务端在新工具一层把字段落成 `'withheld'`；`ui_visible_context` 则不返回该字段。
  - **工具 description 必须写明**：这是"用户正在选中的、可能含敏感内容的文本"，并要求调用方在展示/转发前自行判断。
- **建议的下一个实施任务标题**：`gap-ui-selected-text-scope-gate`——"为 ui_visible_context 增加选区读取：转录区选中的文本、经新 scope cloudcli:selection 授权、长度降级"。
- **大致 Touches**：`src/modules/chat/hooks/useUiStateResponder.ts`、`src/shared/types.ts`、`server/shared/types.ts`、`server/modules/websocket/services/ui-state-request.service.ts`（投影白名单）、`server/modules/mcp-gateway/`（新工具模块 + `mcp-gateway.read-tools.ts` 的 stage-3 表）、`server/modules/oauth/access-tokens.service.ts`（scope 词表）、以及随新工具必然要更新的若干 pinned 测试（`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-read-tools` 计数、`mcp-invalid-argument` 参数表）——立案时逐条核对。

---

## 4. 维度三：current diff（用户当前正在看的 diff）——需要先补前端状态

### 4.1 代码现状（读代码）

Git 面板是成熟模块，但**它的展开/选中模型是多值集合，不是单一"当前文件"**：

- **Changes 视图**：`ChangesView.tsx:52` 是 `const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())`，`:53` 是 `const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())`。两个都是 **Set**——多个文件的 diff 可以同时展开、多个文件可以同时勾选暂存。
- **每个文件行各自渲染一个 `GitDiffViewer`**（`FileChangeItem.tsx:127`，`diff` 来自 `gitDiff: GitDiffMap` 按路径取），所以"同屏多 diff"是常态。
- **History 视图**同构：`HistoryView.tsx:28` 是 `const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set())`，同样是集合。
- **没有单一"当前"态。** `grep "selectedFile\|activeFile\|currentFile"` 在 `useGitPanelController.ts` 为空；采集器根本没有"正在看哪个文件"这个变量。
- **面板身份已有，文件身份没有。** `panel` 字段已经能读出 `'git'`（当 Git 标签页是 `aria-current` 时），所以"用户在 Git 面板里"已知，"在看哪个文件"未知。
- **DOM 契约不齐。** Changes 视图的展开按钮有 `title` 和旋转的 chevron，但**没有 `aria-expanded`**（`FileChangeItem.tsx:54-63`）；History 视图的 `CommitHistoryItem.tsx:78` 反而有 `aria-expanded={isExpanded}`。

结论：**"当前 diff"在 UI 的交互模型里没有单一对应物**——面板允许并排展开多个 diff。硬造一个"current"是给一个本来是集合的东西套单例，会与真实交互不符。

### 4.2 判定

**需要先补前端状态**——但"补的状态"是一个**定义**加一个**DOM 契约**，不是新交互：

- **先定义可观测形态。** 诚实的读数是"当前展开了哪些 diff"（一个集合），而不是"哪一个"。因此新字段报**集合**，并带上是哪个 Git 子视图（changes / history / branches / worktrees）。
- **再补可寻址的 DOM 契约。** 读取器应与 `readActivePanel` / `readVisibleMessages` 同构走 DOM，而不是把 `ChangesView` 的局部 `useState` 提升到 context——后者要动 Git 面板内部结构，改动大。最小改动是让展开态在 DOM 上可见：给 Changes 的展开按钮补 `aria-expanded`（对齐 History 已有的写法），并给展开区/行加一个 `data-git-expanded-file={filePath}`（History 侧对应 `data-git-expanded-commit={hash}`）。这是一处小的、纯增量的 DOM 契约，不改变任何交互。
- 因为读取走 DOM，**不需要新 deps、不需要新 scope**（文件路径是标识符，不是正文），与 §1 的边界不冲突。

### 4.3 范围描述（可直接转下游任务）

- **数据源（现有状态 + 待补 DOM 契约）。** 数据来自 `ChangesView.tsx:52` 的 `expandedFiles`（MERGED with History 的 `expandedCommits`），经上面新增的 `data-git-expanded-*` / `aria-expanded` 暴露；读取器 `readCurrentDiff()` 放在 `useUiStateResponder.ts`，仅当 `panel === 'git'` 时读取。
- **`ui_visible_context` 返回里新增的字段名与类型。**

  ```ts
  /**
   * Git 面板当前展开的 diff 读数。`null` 表示 Git 面板不是当前活动面板。
   * 展开是多值的（面板允许多文件同屏展开），所以这里是集合而不是单值：
   * 一个视图只会填充 `files`（changes）或 `commits`（history）之一。
   */
  currentDiff: {
    /** 当前 Git 子视图 id：'changes' | 'history' | 'branches' | 'worktrees'。 */
    view: string;
    /** 展开中的工作区文件路径（changes 视图）。 */
    files: string[];
    /** 展开中的提交哈希（history 视图）。 */
    commits: string[];
  } | null;
  ```

  `null` 与"面板在 git 但没展开任何 diff"（`{ view, files: [], commits: [] }`）是两种不同读数，遵守 §1 的第 2 条规矩。
- **是否需要新 scope / 降级展示的决定。** **不需要新 scope，不需要降级**：文件路径与提交哈希都是标识符，与既有 `selectedProject` / `visibleMessages` 同级，仍落在 `cloudcli:read` 内。**不返回 diff 正文**——要看内容，调用方拿这些路径/哈希走既有的 Git 读取面（`GitDiffViewer` 的数据源 `GitDiffMap` 由服务端 git 路由产出）。
- **建议的下一个实施任务标题**：`gap-ui-current-diff-reading`——"ui_visible_context 增加 currentDiff：Git 面板展开的文件/提交集合 + 子视图，经 aria-expanded/data-git-expanded-* DOM 契约读取，仍属 cloudcli:read"。
- **大致 Touches**：`src/modules/git-panel/changes/FileChangeItem.tsx`、`src/modules/git-panel/history/CommitHistoryItem.tsx`（DOM 契约）、`src/modules/chat/hooks/useUiStateResponder.ts`、`src/shared/types.ts`、`server/shared/types.ts`、`server/modules/websocket/services/ui-state-request.service.ts`（投影白名单要放行新字段）、`server/modules/mcp-gateway/mcp-ui-visible-context.ts`（描述），以及相关 pinned 测试。

---

## 5. 维度四：current task（用户当前聚焦的任务）——需要先补前端状态（其中 quay 任务一半暂不纳入）

本维度必须先纠正任务书里的一句假设。任务书说"CloudCodeUI 的 UI 层目前可能根本没有一个'浏览/聚焦单个 quay 任务'的界面"。**读代码的结果是：这样一套"选中单个任务"的界面存在——但它属于 TaskMaster，不属于 quay。** 这两套是**不同的任务系统、不同的 id 命名空间**，必须分开判。

### 5.1 代码现状（读代码）

- **quay 任务面（工作区 `quay` 标签页）没有选中概念。** `QuayPanel.tsx` 是"只读镜像"：它的任务列表由 `DetailList` 渲染，注释明写 **"Rows are display-only — quay has no per-entity page to link to, so there is nothing to click"**（`QuayPanel.tsx` 的 `DetailList` 文档注释），Recent tasks 就是一行行只读的 id/标题/时间戳（`QuayPanel.tsx:224`）。面板主动外链到 quay 自己的 dashboard（`dashboardUrl`），不重实现任务板。`QuayTaskCounts`（`src/shared/types.ts:181`）只是侧边栏徽标用的数量统计。
- **TaskMaster 任务面（工作区 `tasks` 标签页）有真正的单选态。** `TaskMasterPanel.tsx:20-21`：`const [selectedTask, setSelectedTask] = useState<TaskMasterTask | null>(null)` 与 `const [isTaskDetailOpen, setIsTaskDetailOpen] = useState(false)`；点任务卡片 → `handleTaskClick` → 打开 `TaskDetailModal`。这是全仓唯一一处"当前选中的任务"。
- **但它是组件私有、且是瞬时的。** `selectedTask` 是 `TaskMasterPanel` 的局部 state，未提升到 context；关闭模态即 `setSelectedTask(null)`。它不在任何 DOM 契约上（不像 `panel` 那样有 `data-workspace-tab`）。
- **两套 id 不是一个命名空间。** TaskMaster 任务是 `.taskmaster/tasks.json` 体系（`TaskMasterTask.id: TaskId`，`src/shared/types.ts:2764`），走 `/api/taskmaster/*`（`server/modules/taskmaster/`）；而 `ui_visible_context` 的兄弟工具是 `quay_snapshot`，本仓库工作流里的"任务"默认指 quay 任务（`tasks/<id>.md`）。两者若共用一个叫 `currentTask` 的字段而不标来源，会让调用方把 TaskMaster 任务误当成 quay 任务。

结论：**"当前任务"在 UI 里是存在的，但只存在于 TaskMaster 那一侧；quay 侧不存在。**

### 5.2 判定

**需要先补前端状态**，但这一维度内部要劈成两半：

- **TaskMaster 一半：需要先补状态（小）。** 数据源 `selectedTask` 已在，缺的只是一个"可寻址 + 可判定为空"的出口：要么把 `selectedTask` 提升到一个 context 供 responder 读，要么（更小、与 §4 同构）在 `TaskDetailModal` 打开时给根节点补一个 `data-task-selected={id}`（关闭即无该属性）。后者是纯增量 DOM 契约，不动面板内部结构。
- **quay 一半：暂不纳入。** 理由点名到缺失的前端概念：`QuayPanel` **被设计成**只读镜像并外链 dashboard，**没有任何"选中单个任务"的交互或状态**；要报"当前 quay 任务"，得先**建一个 quay 任务浏览/聚焦界面**（或给 QuayPanel 的只读行加选中态），这是产品范围变更，不是"补一行 state"。故 quay 侧不拆任务。

### 5.3 范围描述（可直接转下游任务）

- **数据源（现有状态 + 待补 DOM 契约）。** `TaskMasterPanel.tsx:20` 的 `selectedTask`，经"模态打开时根节点带 `data-task-selected`"暴露（沿用 §4 的 DOM 契约手法）。
- **`ui_visible_context` 返回里新增的字段名与类型。**

  ```ts
  /**
   * 用户当前聚焦的任务，或 null。
   * `source` 是必须的：TaskMaster 任务与 quay 任务是两套 id，不标来源会误读。
   */
  currentTask: {
    /** 哪一套任务系统。目前只有 'taskmaster' 有选中面；'quay' 不产出（见 §5.2）。 */
    source: 'taskmaster';
    /** 该任务在它自身命名空间里的 id。 */
    id: string;
    /** 任务标题，或 null（该界面未携带标题时）。 */
    title: string | null;
  } | null;
  ```

  三态合一：`null` = 没有聚焦任务；对象 = 有；而 `source` 把命名空间歧义消掉。
- **是否需要新 scope / 降级展示的决定。** **不需要新 scope、不需要降级**：任务 id 与标题是标识符/元数据，与 `selectedSession` 同级，仍在 `cloudcli:read` 内。`title` 是 TaskMaster 自带的一行摘要而非正文，可保留；若下游希望更保守，可只回 `id`，`title` 恒 `null`——留给立案时定。
- **建议的下一个实施任务标题**：`gap-ui-current-task-reading`——"ui_visible_context 增加 currentTask：TaskMaster 当前选中任务（source 标注命名空间），经 data-task-selected DOM 契约读取；quay 任务侧不纳入"。
- **大致 Touches**：`src/modules/task-master/modals/TaskDetailModal.tsx`（DOM 契约）或 `src/modules/task-master/context/`（若选择提升 state）、`src/modules/chat/hooks/useUiStateResponder.ts`、`src/shared/types.ts`、`server/shared/types.ts`、`server/modules/websocket/services/ui-state-request.service.ts`、`server/modules/mcp-gateway/mcp-ui-visible-context.ts`，以及相关 pinned 测试。

---

## 6. 暂不纳入清单与理由（汇总）

被明确排除、并写明理由的（避免"不处理也不说明"）：

1. **focused message（整维度）**——缺的不是 state 而是**交互**：转录区无 reply/quote、无点击选中、无常驻焦点行；`locateMessage` 是瞬时的、导航抽屉跳完即关，都不构成"当前消息"。取代方案"取可见范围的中点"只是对同一滚动位置换算法重报，不含用户意图，属冗余。**不拆任务**，直到出现回复引用或 turn 高亮交互。
2. **current task 的 quay 一半**——`QuayPanel` 是只读镜像（`DetailList` 明确"display-only / nothing to click"），**quay 侧没有选中单个任务的前端概念**；要报它得先建 quay 任务浏览界面，属产品范围变更。**不拆任务**。TaskMaster 一半按 §5 做。

---

## 7. 建议的下游任务拆分（优先级）

按"先解掉会污染其余设计的决策、再解无争议的"排序：

1. `gap-ui-selected-text-scope-gate`（§3）——**先做**，因为它要定 `cloudcli:selection` 这条新 scope 边界；这条边界一旦定了，"正文进不进 `ui_visible_context`"的判例也会同时定下其余两个字段该不该降级。
2. `gap-ui-current-diff-reading`（§4）——无隐私争议、DOM 契约改动最小，`cloudcli:read` 内闭环。
3. `gap-ui-current-task-reading`（§5）——最后做，因为它要在文档/字段层面处理 TaskMaster 与 quay 两套任务命名空间的歧义（`source` 字段就是为此而生）。

三个任务**不在本任务内创建**，由本文件描述范围，后续用 `quay-file-task` 另行立案。四个维度的三态判定、每个可做维度的字段名/类型/scope 决定、以及暂不纳入项的具体理由，均见上文对应小节。
