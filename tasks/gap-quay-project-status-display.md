---
id: gap-quay-project-status-display
title: quay 项目状态展示(CloudCLI 侧边栏徽标 + 项目面板,CLI 子进程路线)
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

在 CloudCLI 里加入「项目维度展示 quay 状态」的功能。quay 是外部安装的 Claude Code 插件,提供 CLI(`quay task/adr/goal/driver/config --json`)和一个绑定单一 repo_root、以 HTML 渲染为主的 web dashboard(`quay serve`)。已查实 dashboard 路由里只有 `/dashboard/cards`、`/git-history.json`、`/health` 返回 JSON,其余(`/tasks`、`/board`、`/adr` 等)是整页服务端渲染 HTML,且该 dashboard 一次只服务一个 repo_root,不适合作为跨项目集成的数据源。相反,quay CLI 本身(`quay --help` 确认存在完整子命令集,几乎所有读命令支持 `--json`)是结构化、可脚本化的只读接口,且可以直接以目标项目目录为 cwd 调用,不需要项目预先起好 `quay serve` 进程。因此集成方式选定为:后端以子进程方式调用 quay CLI 的只读命令,而非 iframe/代理嵌入 HTML dashboard,也不是接 MCP(`mcp__plugin_quay_quay__*` 工具是 Claude Code 会话内的 stdio 子进程,claudecodeui 自己的 Node 后端进程够不着)。

分两层:
- Tier 1(廉价、常驻):检测项目是否配置了 quay(`.quay/config.yml` 是否存在),纯 `fs.stat`,随项目列表返回,驱动侧边栏里的常驻徽标,不起子进程。
- Tier 2(按需、有代价):调用 quay CLI 的只读命令取任务/ADR/goal/driver 等快照,仅在用户展开面板时发起,服务端加 TTL 缓存与并发去重,避免轮询触发子进程风暴(仓库记忆里有多次「并发子进程/vitest 拖垮宿主 OOM」的前车之鉴,这里要主动避免重蹈)。

## Plan

1. 后端 `server/modules/quay/`(镜像现有 `server/modules/taskmaster/` 模块结构:`taskmaster.service.ts`/`taskmaster.routes.ts`/`taskmaster.module.ts`/`index.ts`):
   - `quay.service.ts`:
     - `detectQuayConfig(projectPath)`(Tier 1,同步 fs 检测 `.quay/config.yml` 是否存在)。
     - `runQuayCommand(cwd, args)`(子进程封装:`execFile` 数组参数、不经 shell、设超时;镜像 `server/modules/cli/cli.module.ts` 里 `execFileSync('sbx', argumentsList, {...})` 的现有子进程调用范式)。
     - `getQuaySnapshot(projectId)`(Tier 2:组合若干只读命令结果,按 projectId 做内存 TTL 缓存 + in-flight promise 去重,避免并发请求重复 spawn)。
   - **命令白名单,仅只读**:`config validate --json`、`task list --json`、`goal list --json`、`adr list --json`、`driver status --json`。明确禁止转发任何写操作参数(`task create/edit/check`、`driver start/stop`、`gate run`、`promote/retreat` 等)——这是只读展示功能,不是控制面,控制面是完全不同的权限粒度讨论,本任务不做。
   - `quay.routes.ts`:`GET /api/quay/:projectId/status`(Tier 1)、`GET /api/quay/:projectId/snapshot`(Tier 2)。路由只做入参解析、调用 service、格式化响应,业务逻辑不进路由(镜像 `plugins.routes.ts` 的 thin-route 写法)。
   - `quay.module.ts`:composition root,绑定 `execFile`、复用 `projectsDb.resolveProjectPathById` 解析受信项目路径——cwd 绝不接受前端直传的路径字符串本身。
   - `index.ts`:只导出 `quayRoutes` 与 `getProjectQuayStatus`(镜像 `taskmaster` 模块里 `getProjectTaskMaster` 的导出方式,供 `projects` 模块聚合时调用)。
2. 前端 Tier 1 徽标:镜像 `src/modules/sidebar/TaskIndicator.tsx` 的视觉语言(图标 + 状态色 + tooltip),新增 `QuayIndicator` 组件,挂进 `SidebarProjectItem.tsx` 里 `TaskIndicator` 旁边;状态判定逻辑(`hasQuayConfig` → 徽标是否渲染、driver running/idle/stale/not-configured 四态的颜色映射)放进 `sidebarProjectFormatting.ts`,镜像现有 `getTaskIndicatorStatus` 的写法。
3. 前端 Tier 2 面板:新增 `src/modules/quay/`(镜像 `src/modules/task-master/` 的模块结构:`index.ts` barrel、`QuayPanel.tsx`、`hooks/useQuayStatus.ts`);在 `src/modules/project-workspace/WorkspaceMain.tsx` 新增 `'quay'` 这个 `AppTab` 枚举值,门控条件 `shouldShowQuayTab = Boolean(selectedProject?.hasQuayConfig)`,与现有 `shouldShowTasksTab`(tasks/TaskMaster)并列处理(同样的 useEffect 兜底:tab 不可见时若当前选中了该 tab,要切回 'chat')。面板内容:顶部摘要卡片(tasks/gates/driver/needs-human 计数)+ 下方明细列表(任务/ADR,截断显示 + 外链到 `quay serve` 原生 dashboard),明确标注「只读」与「最后同步时间」,提供手动刷新按钮(绕过 TTL 缓存强制拉取一次)。
4. API 调用集中到 `src/shared/api.ts`(新增 `getQuayStatus(projectId)`、`getQuaySnapshot(projectId)`),组件不得自行拼 fetch 路径或散落请求逻辑(遵循 frontend-module-standards 的「Centralize frontend API access」规则)。

## AC

- [x] `npm run typecheck` 退出码 0。
- [x] 新增的后端窄测试(`server/modules/quay/tests/`)退出码 0,覆盖:(a) `detectQuayConfig` 对 `.quay/config.yml` 存在/不存在两种输入返回正确结果;(b) `runQuayCommand` 对不在白名单内的命令拒绝执行并返回错误,而不会实际 spawn 子进程;(c) `getQuaySnapshot` 对同一 projectId 的两次并发调用只触发一次底层子进程调用(验证 in-flight 去重),且 TTL 内重复调用不重新 spawn。
- [x] 新增的前端窄测试(`src/modules/quay/tests/`、`src/modules/sidebar/tests/`)退出码 0,覆盖:(a) `QuayIndicator` 按 `hasQuayConfig` 及 driver 状态渲染正确的图标/颜色变体,`hasQuayConfig=false` 时不渲染;(b) `shouldShowQuayTab` 门控逻辑(含「tab 不可见时自动切回 chat」的 useEffect 行为);(c) `QuayPanel` 对 loading/error/not-configured/loaded 四种状态分别渲染正确内容。
- [x] 后端路由层确认:`runQuayCommand` 的调用点(grep `server/modules/quay/`)不存在任何非白名单参数被拼进 `execFile` 调用的路径——即没有一条代码路径能让前端请求触发 `task create/edit/check`、`driver start/stop`、`gate run`、`promote/retreat` 等写命令。

## DoD

- 真实跑通,而非只有单测 fixture 绿:在本机启动 CloudCLI(`npm run dev` 或等效命令),打开 claudecodeui 自身这个项目(本仓库已有真实 `.quay/config.yml` 与真实任务数据)。侧边栏对应项目行出现 quay 徽标;点击后切到新的 Quay tab,面板展示的任务计数/driver 状态与同一时刻直接在终端跑 `quay task list --json`、`quay driver status --json` 得到的真实输出一致(至少核对计数字段一致,不是展示占位/fixture 数据)。
- 另建一个不含 `.quay/config.yml` 的临时目录对应项目(或可验证的等效场景),确认该项目在侧边栏不出现 quay 徽标、WorkspaceMain 也不出现 Quay tab。
- 人工审查 `server/modules/quay/quay.service.ts` 中命令白名单与 `runQuayCommand` 的实现,确认不存在能透传写操作的路径(与 AC 最后一条对应,但 DoD 要求是人工读代码确认,不只是测试断言)。

## Touches

- server/modules/quay/quay.service.ts (new)
- server/modules/quay/quay.routes.ts (new)
- server/modules/quay/quay.module.ts (new)
- server/modules/quay/index.ts (new)
- server/modules/quay/tests/quay.service.test.ts (new)
- server/modules/projects/services/projects-with-sessions-fetch.service.ts
- server/index.ts
- src/modules/sidebar/QuayIndicator.tsx (new)
- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- src/modules/sidebar/tests/QuayIndicator.test.tsx (new)
- src/modules/quay/index.ts (new)
- src/modules/quay/QuayPanel.tsx (new)
- src/modules/quay/hooks/useQuayStatus.ts (new)
- src/modules/quay/hooks/useQuayTabVisibility.ts (new)
- src/modules/quay/tests/QuayPanel.test.tsx (new)
- src/modules/quay/tests/quayTabVisibility.test.tsx (new)
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/project-workspace/WorkspaceTabs.tsx
- src/modules/project-workspace/WorkspaceHeader.tsx
- src/modules/project-workspace/WorkspaceTitle.tsx
- src/modules/project-workspace/hooks/useProjectsState.ts
- src/shared/api.ts
- src/shared/types.ts
- tasks/gap-quay-project-status-display.md (self-touch)
## Needs-Human

**执行 2026-10-01T18:02:27.105Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：dc306ba1-0b90-4a8f-8429-654e24014e9b
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-quay-project-status-display~wk-prod-anchor~1790877701023-ef8b7f.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-quay-project-status-display-wk-prod-anchor.log
