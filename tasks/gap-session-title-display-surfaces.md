---
id: gap-session-title-display-surfaces
title: 标题显示面收口：PluginTabContent 字段对齐 getSessionTitle，命令面板/Conversations/归档列表在改名后不刷新
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

已确认的现状（前端）：经 `session_upserted` 实时更新的面是顶部 `h2`、侧栏行、浏览器页签、Shell 名字、导出文件名、通知文案（由 `src/modules/project-workspace/hooks/useProjectsState.ts` 里 selectedSession 的合并块与列表的 `upsertSessionIntoProject` 提供）。以下四处不在其中：

1. `src/modules/plugins/PluginTabContent.tsx` 传给插件标签页的 `session.title` 读的是 `selectedSession.title || selectedSession.name || selectedSession.id`，而全局唯一权威 `getSessionTitle`（`src/shared/utils.ts`）读的是 `summary || name`。字段不一致，插件页可能显示 id 或旧名，而 header 是对的。
2. `src/modules/command-palette/hooks/useSessionsSource.ts` 只按 `projectId` 取一次 `api.projectSessions`，不订阅任何事件。
3. `src/modules/sidebar/SidebarRecentConversations.tsx` 读 `conversation.sessionTitle`，只在**本机**发起改名时才就地补丁（`src/modules/sidebar/hooks/useSidebarController.ts` 的改名回调里）。
4. 归档会话：`src/modules/sidebar/hooks/useSidebarController.ts` 持有独立的 `archivedSessions` store；它更糟——服务端 `server/modules/websocket/services/session-upsert-broadcast.service.ts` 对 `row.isArchived` 的行直接 `return null`，所以归档行**根本不会**产生事件。

方案：这四处是同一个机制——「持有会话名的本地 store 要跟着已发生的改名走」。以 `getSessionTitle` 为唯一权威，把改名结果补齐到所有 store：

1. `PluginTabContent` 改为调用 `getSessionTitle(selectedSession)`（经模块 barrel 导入，不深导入）。
2. 命令面板与 Conversations 订阅同一个 `session_upserted`（或等价的共享 store），收到属于自己列表的会话时就地改其标题，不整表 refetch。
3. 归档列表：本机发起的改名返回后就地补 `archivedSessions` 里那一行。

**明确不在本任务范围**（记录下来，不静默改）：服务端对归档行不广播这一条**不改**。改它等于让归档会话重新参与广播，是产品语义变更（归档会话的 transcript 仍可能被改动而产生 upsert），需要单独裁定。因此本任务只保证「本机改名后归档列表跟着变」；**另一个客户端**对归档会话的改名仍然不会实时到达——这条限制写进 Evidence，不要伪装成已解决。

实施时按 `.agents/skills/frontend-module-standards/SKILL.md` 落位，新增前端测试只经模块 barrel 导入。

## AC

- [x] `npx vitest run src/modules/plugins/tests/pluginTabSessionTitle.test.tsx` 退出码 0（经模块 barrel 渲染 `PluginTabContent`）：三种夹具——只有 `summary`、只有 `name`、两者皆无——插件拿到的 `session.title` 都等于 `getSessionTitle(selectedSession)`；两者皆无时断言与 `getSessionTitle` 自身的约定一致（不得凭空规定一个值）。
- [x] 抗假变体：把实现改回 `title || name || id` 后同一命令必须变红，且红的必须是「只有 `summary`」那条夹具；还原后转绿。
- [x] `npx vitest run src/modules/sidebar/tests/sessionTitleSurfaces.test.tsx` 退出码 0：归档列表与 Conversations store 在本机改名后（`api.renameSession` 成功返回）不经过任何整表 refetch 就显示新名。**正控**：改名前后两次读取该行的名字必须**不同**（证明补丁真的写进去了，而不是断言了一个恒等）。**负控**：一个不属于自己列表的会话的 upsert 不得引起这两处任何变化。
- [x] `npx vitest run src/modules/command-palette/tests/sessionTitleLiveUpdate.test.ts` 退出码 0：发出属于面板列表的 `session_upserted` 后，面板行的 label 变为新名，且未重新调用 `api.projectSessions`（以调用计数断言）；属于其他项目的 upsert 不改变面板。
- [x] 抗假变体：把命令面板的事件订阅整段去掉后同一命令必须变红；还原后转绿。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries 规则）。

## DoD

真实落地判据：不是仅有单测。要求用临时 `DATABASE_PATH` 与临时 `HOME` 起真实服务实例（`HOST=127.0.0.1`，结束时按进程组杀），在真实浏览器里打开一个会话，经 UI 改名，然后**不刷新页面**依次读数四处：(1) 打开插件标签页读它拿到的 session title；(2) 打开命令面板搜索该会话读其行文本；(3) 把该会话归档后打开归档列表读其行文本；(4) 顶部 `h2` 作为对照。四处都必须显示新名，且窗口存活标记在读数前后都在（证明没有整页刷新）。读数写进 Evidence。另需如实记录：用**第二个**浏览器上下文（模拟另一客户端）对归档会话改名时，第一个上下文里的归档行**不会**实时更新——这是本任务明确不解决的限制。

L_D 该轴仍暗，理由：纯客户端 store 同步与展示，没有可独立度量的数据或文档语义读数；验收以上面的单测与真实浏览器读数为准。

## Evidence

### 单测（对应上面 6 条 AC）

- `npx vitest run src/modules/plugins/tests/pluginTabSessionTitle.test.tsx src/modules/sidebar/tests/sessionTitleSurfaces.test.tsx src/modules/command-palette/tests/sessionTitleLiveUpdate.test.ts` → `Test Files 3 passed (3)` / `Tests 13 passed (13)`，退出码 0。
- `npm run typecheck` → 退出码 0；`npm run lint` → 退出码 0。lint 的 warning 全落在本次未改动的文件里（`useVoiceInput.ts`、`useGitHubStars.ts`、`SidebarProjectItem.tsx` 等），本次改动的四个源文件零 finding。

### AC2 抗假变体（本次重跑实测）

把 `PluginTabContent.buildContext` 的 `title: getSessionTitle(selectedSession)` 改回 `selectedSession.title || selectedSession.name || selectedSession.id`，同一命令（退出码 1）：

```
× a session whose only name is its summary reaches the plugin as that summary
✓ a Cursor session whose only name is its `name` reaches the plugin as that name
× a session with neither a summary nor a name gets whatever the authority says, not the id
× a rename is pushed into the already-mounted plugin instead of waiting for a remount
Tests  3 failed | 1 passed (4)
```

「只有 `summary`」那条正是第一处红，符合 AC 指名。还原后 4/4 转绿。

### AC5 抗假变体（本次重跑实测）

把 `useSessionsSource` 里 `useEffect(() => subscribe(...))` 的回调体整体短路（`void event; return;`），同一命令（退出码 1）：

```
× an upsert for a listed session renames its row without re-listing the project
✓ an upsert for another project leaves the panel alone
✓ an upsert for a session the loaded page does not contain is not inserted
✓ an upsert for a listed session whose title did not change keeps the row identity
× two renames of the same session in a row both land
Tests  2 failed | 3 passed (5)
```

两条「label 必须变」的红，三条「不该变／不该插入」的保持绿。还原后 5/5 转绿。

### DoD 真实浏览器读数

工具是仓库自带的 playwright 配置：真实 server（`npx tsx server/index.ts`，`DATABASE_PATH`/`HOME` 指向本次运行 `mkdtemp` 出的临时目录，`HOST=127.0.0.1`，端口由内核按 run 分配）+ 真实 Vite client + 真实 Chromium；进程随 webServer 生命周期按组结束。

夹具是临时的：在 `playwright.config.ts` 加了两段 seed——一个 workspace 加一条 `custom-title` 为 `title-surface` 的真实 transcript（在 server 启动前写入，避免 watcher 把它读成 attention），以及一个装在临时 `HOME` 下 `~/.claude-code-ui/plugins/title-probe/` 的探针插件（其 `mount` 把宿主给的 `context.session.title` 写进自己的容器）；再由一个临时 spec `e2e/session-title-surfaces.spec.ts` 跑完全程。**两者都已删除／还原**，`git status` 干净——它们不在 Touches 里，留作复现副本在 `/tmp/gap-session-title-probe/`。

流程：onboarding → 打开该会话 → 打开插件标签页 → 在页面上埋 `window.__titleProbeToken` 并记下 `load` 事件计数 → 经侧栏 `Session options → Rename session` 改成 `renamed-live-title` → 依次读数。读数行来自本次运行的 stdout：

```
[title-probe] plugin tab session.title  = "renamed-live-title"
[title-probe] command palette row       = "renamed-live-title claude"
[title-probe] workspace header          = "renamed-live-title"
[title-probe] archived list row         = "Restore session: renamed-live-title"
[title-probe] reloads between the first reading and the last: 0
```

- (1) 插件标签页：读的是插件自己写下的 `data-plugin-surface="session-title"` 容器文本，即宿主真正传进去的 context。
- (2) 命令面板：`Ctrl+K` 打开，该项目会话行的 label 已是新名，旧名 0 命中。
- (3) 归档列表：经 UI 归档后切到归档页，行内 `<p>` 文本与 `Restore session: <title>` 的 aria-label 都是新名。
- (4) 顶部 `h2` 对照：新名。**顺序说明**：`h2` 只在 chat 页签下显示会话名，而归档会清空当前选中会话（归档后 chat 页显示 "New Session"，实测），所以这条对照读数排在归档之前、把页签切回 chat 时读；这是实测到的先后约束，不是偷换判据。
- 无整页刷新：埋下的 `window.__titleProbeToken` 在最后一次读数后仍读得到原值，且这段期间 `load` 事件计数为 0。

**同一探针的抗假读数**：把 `PluginTabContent` 改回 `title || name || id` 后重跑，探针在第一次读插件面时即红——`Expected: "title-surface" / Received: "e2e-title-surface"`（插件拿到的是裸 id）。所以上面四读不是「怎么实现都绿」的空读数。

### 明确不解决的限制（如实记录）

第二个浏览器上下文（同一账号的独立 context，自带独立 WebSocket 连接）在第一个上下文已归档该会话之后，经它自己仍持有的那一行改名：`PUT /api/providers/sessions/e2e-title-surface` 返回 **200**，服务端确实改名成功，但第一个上下文里的归档行**不跟着变**——仍停在 `Restore session: renamed-live-title`，`renamed-after-archive` 0 命中。原因即 Proposal 所述：`session-upsert-broadcast.service.ts` 对 `row.isArchived` 直接 `return null`，归档行根本不产生事件；服务端这一条本任务明确不改。

### Touches 里声明了但未改动的两个文件

`src/modules/sidebar/SidebarRecentConversations.tsx` 与 `src/modules/project-workspace/hooks/useProjectsState.ts` 留在 Touches 中，但实现下来无需改动：Conversations 行读的 `conversation.sessionTitle` 由 `useSidebarController` 的 store 提供，改名补丁与 `session_upserted` 订阅都落在 controller（同属 Touches）内；`useProjectsState` 的 `upsertSessionIntoProject`／selectedSession 合并块已存在，顶部 `h2` 本来就对（上面真实浏览器读数 (4) 即是对照）。声明了但未改动不构成 anti-drift 违规。

## Touches

- src/modules/plugins/PluginTabContent.tsx
- src/modules/sidebar/hooks/useSidebarController.ts
- src/modules/sidebar/SidebarRecentConversations.tsx
- src/modules/command-palette/hooks/useSessionsSource.ts
- src/modules/project-workspace/hooks/useProjectsState.ts
- src/modules/plugins/tests/pluginTabSessionTitle.test.tsx (new)
- src/modules/sidebar/tests/sessionTitleSurfaces.test.tsx (new)
- src/modules/command-palette/tests/sessionTitleLiveUpdate.test.ts (new)
- tasks/gap-session-title-display-surfaces.md
