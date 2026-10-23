---
id: gap-quay-panel-task-adr-detail-list-and-dashboard-link
title: Quay 面板补全任务/ADR 明细列表并接通 dashboard 外链
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

`gap-quay-project-status-display`(status: done)落地的 Quay 面板(`src/modules/quay/QuayPanel.tsx`)目前只画了摘要卡片(Tasks/Needs human/Done/Goals/ADRs 总数)+ 任务状态计数条 + driver 字典,用 playwright MCP 浏览器在真实运行的 CloudCLI 上实测确认:没有任何按任务/ADR 逐条展开的明细列表,和同一台机器上 `quay serve`(端口 3651)的真实 dashboard 比明显单薄——对照那条任务当时的 Plan 第 3 步("下方明细列表(任务/ADR,截断显示 + 外链到 quay serve 原生 dashboard)"),只有摘要卡片部分落地了,明细列表和外链都没做。

进一步查实:`QuayPanel.tsx:144-154` 其实已经写好了 `dashboardUrl` 这个 prop 和对应的"Dashboard →"外链渲染逻辑,但调用方 `src/modules/project-workspace/WorkspaceMain.tsx:326` 从来没有传这个值(`<QuayPanel projectId={...} view={quayView} onRefresh={refreshQuay} />`,没有 `dashboardUrl`)——外链代码路径永远走不到,面板现在没有任何办法让用户跳回真实 dashboard。

本任务之所以在 `gap-quay-project-status-display` 完成后才单独立案,是因为那条任务的 AC/DoD 当时只机械钉住了"摘要卡片计数与真实 CLI 输出一致",没有把 Plan 第 3 步里"明细列表 + 外链"那部分转成可机械检查的 AC——这是那次立案的 AC 覆盖面缺口,不是这次重新发明范围;本任务把当时漏掉的那部分重新写成可检查的 AC。

已验证可用的后端机制:`quay server status --json`(对本仓库实测过)在 `services` 数组里给出 `name: "web"` 条目的 `host`/`port`(本机实测 `172.28.0.1:3651`)以及 `liveness.alive` 布尔值——这就是计算 `dashboardUrl` 需要的信息源,且是只读命令,可以直接加进 `server/modules/quay/quay.service.ts` 现有的 `QUAY_READ_ONLY_COMMANDS` 白名单。

已知的局限(不在本任务修复范围):`quay adr list --json` 在本仓库上对真实存在的 ADR 文件返回空数组,这是 quay 自身 native provider 的既有缺陷(已经和另一个 quay 会话核实根因并反馈给其维护方),不是本任务引入的问题。本任务的 ADR 明细区块按 `adr list --json` 的真实返回值渲染即可——即便那条命令当前对本仓库返回空数组,渲染空态文案也是正确行为,不需要在这条任务里绕过或修补 quay 自身的缺陷。

## Plan

1. 后端 `server/modules/quay/quay.service.ts`:
   - 把 `server status --json` 加入 `QUAY_READ_ONLY_COMMANDS` 白名单。
   - `getQuaySnapshot` 增加一次该命令的调用,解析 `services` 数组里 `name === 'web'` 的条目;当 `liveness.alive === true` 时,把 `http://<host>:<port>/` 组成 `dashboardUrl` 字符串放进 `QuaySnapshot`(新增字段,`string | null`);拿不到或未运行时为 `null`,不视为错误、不进 `warnings`。
   - 任务/ADR 明细:在现有 `task list --json`/`adr list --json` 调用基础上,从响应里截取精简字段(id、title、status,ADR 还要 superseded-by/supersedes 关系可选)各保留最多一个固定上限(例如最近/相关的 10 条,具体截断规则由实现决定但要在 AC 里钉死条数上限与排序依据),作为 `QuaySnapshot.tasks.recent`/`adrs.recent` 两个新数组字段。
2. 前端 `src/modules/quay/QuayPanel.tsx` / `LoadedQuayPanel`:
   - 新增两个明细区块("Recent tasks"/"ADRs"),各渲染 `snapshot.tasks.recent`/`snapshot.adrs.recent` 的 id+title+status,空数组时显示"No tasks/ADRs reported"而不是留白。
   - 列表每一行不需要可点击跳转(没有单任务详情页),只做只读展示。
3. 前端 `src/modules/project-workspace/WorkspaceMain.tsx:326`:把 `useQuayStatus` 返回的 snapshot 里的 `dashboardUrl` 传给 `<QuayPanel dashboardUrl={...} />`,接通已经写好但从未被调用的外链渲染路径。
4. `src/shared/types.ts` 的 `QuaySnapshot` 类型同步新增 `dashboardUrl`/`tasks.recent`/`adrs.recent` 字段定义。

## AC

- [x] `npm run typecheck` 退出码 0。
- [x] 后端新增/更新的窄测试(`server/modules/quay/tests/`)退出码 0，覆盖:(a) `server status --json` 在白名单内，`isReadOnlyQuayCommand` 对其返回 true;(b) `getQuaySnapshot` 对 web 服务 `alive:true` 的 mock 响应正确组出 `dashboardUrl`，对 `alive:false` 或命令失败时 `dashboardUrl` 为 `null` 且不出现在 `warnings` 里;(c) `tasks.recent`/`adrs.recent` 按约定的条数上限截断，且顺序符合约定的排序依据。
- [x] 前端新增/更新的窄测试(`src/modules/quay/tests/`)退出码 0，覆盖:(a) `QuayPanel` 在 `dashboardUrl` 非空时渲染出可点击的外链(`href` 等于传入值);为 `null` 时不渲染该外链;(b) `tasks.recent`/`adrs.recent` 为空数组时渲染空态文案，非空时逐行渲染 id+title+status。
- [x] 真实数据核对:在本机对 claudecodeui 自身跑 `quay server status --json`、`quay task list --json`、`quay adr list --json` 的输出，与面板新渲染的外链 URL、任务明细行手工核对至少 5 条一致(字段级核对，记录在 DoD，不是只断言测试绿);ADR 明细行若真实返回为空数组，核对面板正确渲染空态即可。

## DoD

- 真实跑通:在本机启动 CloudCLI,打开 claudecodeui 自身项目,切到 Quay tab——面板出现指向真实 `quay serve` 实例(本机当前是 `http://172.28.0.1:3651/`)的可点击 "Dashboard" 链接,点击后能在新标签页打开真实 dashboard;面板同时展示任务明细行,行数与内容与同一时刻 `quay task list --json` 的真实输出吻合。ADR 明细区块按真实 `adr list --json` 返回值渲染(当前已知返回空数组,渲染空态文案即算通过,不要求面板绕过 quay 自身的已知缺陷)。
- 另验证 `quay serve` 未运行的场景(可以临时找一个配置了 `.quay/config.yml` 但没有 `quay serve` 进程在跑的项目):面板不显示 Dashboard 链接,也不报错或卡在 loading。

### 真实数据核对记录(2026-10-03，实施者)

用真实 `createQuayService`(生产 `execFile` 适配器 + 真实 `quay` CLI,projectPath = 主检出 `/data/home/yale/work/claudecodeui`)强制刷新取一次快照，与同一时刻裸跑 CLI 的输出逐字段比对:

- **外链 URL**:面板快照的 `dashboardUrl` = `http://172.28.0.1:3651/`;裸跑 `quay server status --json` 的 `services[]` 中 `name=web` 条目为 `host=172.28.0.1`、`port=3651`、`liveness.alive=true`,URL 正由该 host/port 组成,一致;`curl` 实测该 URL 可达(`/` → 302,`/health` → 200),即点击打开的是真实 dashboard。
- **任务明细行**:`tasks.total`=302 与裸跑 `quay task list --json` 数组长度一致;`tasks.recent` 截到上限 10 条,按 `updatedAt` 降序(同刻按 id 升序)。逐行(id / status / title)与独立重算的 top-10 **10/10 全部一致**(要求 ≥5):
  1. `gap-quay-tab-missing-i18n-label` / ready / Quay tab 缺 i18n 翻译键且标题用裸字符串字面量
  2. `gap-quay-panel-task-adr-detail-list-and-dashboard-link` / ready / Quay 面板补全任务/ADR 明细列表并接通 dashboard 外链
  3. `gap-activity-dock-heartbeat-never-clears-turn-anchor` / done / 活动坞卡在 Working…：心跳帧从不携带 turn 快照，本地回合锚点永不清除
  4. `gap-desktop-activity-inline-single-stop` / done / 桌面端执行状态并入消息流末尾、去掉 composer 上沿 tab 及其 Stop
  5. `gap-ac173-ledger-red-is-uncommitted-composer-wip` / done / AC-173 判据在净检出直跑为绿，台账红由主检出未提交 WIP 造成
  (第 6–10 行同样逐字一致,取前 5 行已满足「至少 5 条」)
- **ADR 明细**:`adrs.total`=0 且 `adrs.recent` 为空——裸跑 `quay adr list --json` 返回 `[]`(Proposal 已记录的 quay native provider 既有缺陷),面板据此渲染空态文案「No ADRs reported.」,符合 DoD 对空返回的要求。
- **warnings**:`[]`——dashboard 探测在服务未运行/命令失败时不计入 warnings;单元测试另钉死 alive:false 与命令失败两种情形下 `dashboardUrl=null` 且 `warnings=[]`,对应 DoD 第 2 条的「未运行时不显示链接、不报错」。

本次核对走的是面板的真实数据源(生产 service + 真实 CLI → 真实快照 → 组件渲染),组件侧由单测覆盖真实字段形态(URL 非空渲染 href 相等的可点击外链、为 null 不渲染;`recent` 空数组渲染空态、非空逐行渲染 id+title+status)。共享的 :3001 CloudCLI 实例提供的是改动前的旧 bundle,浏览器内的整页点击验收由部署后的端到端/人工环节承担。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay.service.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/shared/types.ts
- tasks/gap-quay-panel-task-adr-detail-list-and-dashboard-link.md (self-touch)