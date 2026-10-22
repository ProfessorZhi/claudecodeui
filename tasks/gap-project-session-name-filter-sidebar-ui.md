---
id: gap-project-session-name-filter-sidebar-ui
title: 项目级会话名过滤（侧边栏 UI）：隐藏计数条、临时显示开关、规则编辑面板（带实时预览）、搜索结果标记「已过滤」
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-project-session-name-filter-backend
---
## Proposal

<!-- dedup-ref -->本任务是项目级会话名过滤的前端半边，对应的后端接口（`projects.session_filter`、`includeHidden`、`hiddenCount`、`keepSessionIds`、PUT 保存与 POST preview、搜索结果 `filtered` 标记）由 gap-project-session-name-filter-backend 提供，本任务只消费这些接口，不改后端。

方案（已与人讨论确认的设计）：
1. 侧边栏展开的项目会话列表底部新增一行：「已隐藏 N 个 · 显示 · 编辑规则」，仅当该项目 `hiddenCount > 0` 时出现。「显示」只对当前浏览器生效：状态（按项目 id 记录是否临时显示全部）存入 `sidebarStoredPreferences.ts`，不改库内规则；再点一次收回。临时显示时以 `includeHidden=true` 重新请求该项目会话。
2. 项目右键菜单（或项目行菜单）新增「会话过滤…」，打开规则编辑面板：多行文本框，一行一条正则，不做人类友好化；输入后防抖调用 preview 接口，展示命中数、未命中数，并各列出最新若干会话名；服务端返回的非法行号在对应行标红；保存调用 PUT，非法时不关闭面板并显示服务端错误。
3. 加载会话（含加载更多）时，前端把正在运行的会话、需关注的会话、当前选中的会话 id 作为 `keepSessionIds` 传给后端，保证它们即使命中规则也照常显示。
4. 最近会话视图直接消费后端已按项目规则过滤后的结果，前端不再自行过滤；会话增量推送到达时，若新会话名命中该项目的规则（复用与后端语义一致的匹配，忽略大小写、不锚定），则不加入可见列表而是让 `hiddenCount` 加一。
5. 标题搜索结果里 `filtered: true` 的条目显示「已过滤」标记。
6. 新增/修改的前端代码遵循 `.agents/skills/frontend-module-standards/SKILL.md`；面板与底部条用现有 shared/ui 组件，i18n 文案补进现有语言文件。

## AC

- [x] `npx vitest run src/modules/sidebar/tests/sessionFilterBar.test.tsx` 退出码 0：`hiddenCount=0` 时不渲染底部条；`hiddenCount=114` 时渲染「已隐藏 114 个」；点「显示」后以 `includeHidden=true` 重新请求并写入本地偏好，刷新后保持，再点收回。
- [x] `npx vitest run src/modules/sidebar/tests/sessionFilterEditor.test.tsx` 退出码 0：输入规则后防抖调用 preview 并渲染命中数与会话名；服务端返回非法行号时该行带错误标记；保存非法时面板保持打开并显示错误；保存成功后触发该项目会话重新加载。
- [x] 同一测试组断言：请求会话时 `keepSessionIds` 含运行中、需关注、当前选中的会话 id；增量推送到达的会话名命中规则时不进入可见列表且 `hiddenCount` 加一；搜索结果 `filtered: true` 的条目带「已过滤」标记。
- [x] `npm run test:client` 与 `npm run typecheck` 退出码 0（既有前端测试不回归，含 `sidebarRowProps.test.tsx` 的 memo 边界断言）。

## DoD

真实落地判据：不是仅有组件与测试存在。要求在真实运行的 cloudcli（vite + 后端，连真实数据库副本）里用浏览器实际操作一遍：对 claudecodeui 项目打开「会话过滤…」，输入 `-(task-worker|selector|fix-worker)$`，预览显示命中约 114、保存后列表只剩约 14 个会话且底部出现「已隐藏 114 个」，点「显示」可临时展开且刷新后保持，运行中的自动会话仍可见；截图与操作记录写入完成记录。取假变体：把「显示」实现成清空库内规则或把 `keepSessionIds` 去掉时，对应测试必须变红。

## Touches

- src/shared/api.ts
- src/shared/types.ts
- src/modules/sidebar/SidebarProjectSessions.tsx
- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/SidebarRecentConversations.tsx
- src/modules/sidebar/SessionFilterBar.tsx (new)
- src/modules/sidebar/SessionFilterEditor.tsx (new)
- src/modules/sidebar/Sidebar.tsx
- src/modules/sidebar/SidebarContent.tsx
- src/modules/sidebar/SidebarModals.tsx
- src/modules/sidebar/SidebarProjectList.tsx
- src/modules/sidebar/index.ts
- src/modules/sidebar/hooks/useSidebarController.ts
- src/modules/sidebar/utils/sidebarStoredPreferences.ts
- src/modules/project-workspace/ProjectWorkspaceRoute.tsx
- src/modules/project-workspace/context/ProjectsStateContext.tsx
- src/modules/project-workspace/index.ts
- src/modules/project-workspace/hooks/useProjectSessionFilter.ts
- src/modules/project-workspace/hooks/useProjectsState.ts
- src/modules/i18n/locales/en/sidebar.json
- src/modules/i18n/locales/zh-CN/sidebar.json
- src/modules/sidebar/tests/sessionFilterBar.test.tsx (new)
- src/modules/sidebar/tests/sessionFilterEditor.test.tsx (new)
- tasks/gap-project-session-name-filter-sidebar-ui.md

## Needs-Human

**执行 2026-09-20T08:09:18.856Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7583 lint passed=false end_ms=1789891711950
- run_id：wk-prod-anchor
- session_id：f48dcccc-3a4d-4801-a5ee-500f58f7f157
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-project-session-name-filter-sidebar-ui~wk-prod-anchor~1789891687394-171e4c.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-project-session-name-filter-sidebar-ui-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-20T08:44:54.158Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7132 lint passed=false end_ms=1789893835672
- run_id：wk-prod-anchor
- session_id：fcf2d8f1-a906-426b-afb8-30fb031ec0fa
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-project-session-name-filter-sidebar-ui~wk-prod-anchor~1789893809635-020a5f.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-project-session-name-filter-sidebar-ui-wk-prod-anchor.log
