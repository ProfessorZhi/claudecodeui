---
id: gap-mobile-workspace-header-single-row-selector
title: 移动端工作区 header 合并为单行：菜单 + 会话标题 + 当前工作区入口，其余工作区收进底部 dialog；移动/桌面边界统一到 md（768px）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

来源方案：`docs/proposals/mobile-workspace-and-composer-layout.md` 第 1 节（本任务自包含，下面是需要落地的全部约束）。仅前端，范围 `src/modules/project-workspace/`。

现状：`WorkspaceHeader.tsx` 在移动端把「菜单 + 标题」与「工作区 tabs（PillBar，横向滚动）」分成两行，390×844 下 header 高 94px；桌面 1280×720 下 57px。

目标形态（`<768px`）：

```text
[菜单] [会话标题 / 项目名……] [Chat ▾]
```

- 左侧菜单按钮 `MobileMenuButton` 保持现状。
- 中间 `WorkspaceTitle` 继续允许收缩与省略；项目名第二行小字保留，但不得撑高 header。`WorkspaceTitle.tsx` 已具备 `min-w-0` 与 truncate，预期无需修改；若长中文标题在 320px 仍挤压右侧入口，才允许补收缩样式（届时先用 task_write 把该文件补进 Touches），不改标题数据与状态。
- 右侧只显示当前工作区的图标、名称与展开标记，是一个 trigger 按钮。点击后打开底部 dialog，列出 Chat、Shell、Files、Git，按 `shouldShowBrowserTab` / `shouldShowTasksTab` 启用的 Browser/Tasks，以及**全部已启用的插件工作区**（插件 tab 不得因收纳而消失）。
- 选择一项：调用现有 `setActiveTab` 并关闭 dialog。dialog 用现有 `@/shared/ui` 的 `Dialog` primitive，必须有标题（复用 `tabs.views`）、焦点圈定、Escape 关闭、遮罩点击关闭、关闭后焦点返回 trigger；内容区允许纵向滚动（不得假设只有四个内建 tab）。
- 桌面（`>=768px`）继续渲染当前横向 `PillBar` tablist，含滚动渐变、左右滚动按钮、`ArrowLeft/ArrowRight/Home/End` 键盘行为，一字不改行为。
- 复用 `WorkspaceTabs.tsx` 里现有的 tab 定义、插件过滤、翻译，**不得维护第二份工作区清单**。新增的 dialog open state 必须按前端规范在声明上方注释其用途；不新增可由 props 派生的状态。
- 断点统一：`useDeviceSettings` 以 `<768px` 判定 `isMobile`，而 header/tabs 现有 Tailwind 规则用 `sm`（640px）。本任务把这两个文件里的响应式前缀统一到 `md`，避免 640–767px 出现「菜单属于移动端、tabs 属于桌面端」的混合状态。
- 不新增 i18n key：dialog 标题与各 tab 名称复用现有 `tabs.views` 与各 tab 的翻译。

不做：不改后端、不改 `src/shared/api.ts`、不改工作区/插件的业务行为；不重做侧边栏或整体移动视觉；composer 与消息区的移动端改动属于同一方案的其它任务，本任务不碰 `src/modules/chat/`。

实施规范：按 `.agents/skills/frontend-module-standards/SKILL.md` 落位（`@/` 源码根导入、`type` 而非 `interface`、导出组件须写消费者注释、新测试跨模块只经 barrel 导入，否则 oxlint boundaries 在全量 suite 里才红）。

## AC

- [x] `npx vitest run src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx` 退出码 0，且文件内各用例互相独立、失败信息打印实际读数（可访问名列表 / `setActiveTab` 调用次数 / `document.activeElement` 的可访问名）：(a) 桌面档：存在 `role=tablist`，`role=tab` 数 = 内建 + 条件 + 已启用插件 tabs 的总数，且**不存在** collapsed trigger；(b) 移动档：**不存在** `role=tablist`，恰有一个 trigger，其可访问名含当前工作区名称，`aria-haspopup="dialog"`，`aria-expanded` 随开合翻转；(c) 移动档打开 dialog：列出 Chat/Shell/Files/Git，`shouldShowBrowserTab`/`shouldShowTasksTab` 为真时多出 Browser/Tasks，列出全部 `enabled:true` 插件（造 12 个插件，全部可在 DOM 中找到），且**不含** `enabled:false` 的插件（正向 + 反向对照）；(d) 选择一项后 `setActiveTab` 恰好被调用 1 次且参数为该项 id，dialog 关闭，焦点回到 trigger；(e) Escape 与遮罩点击各自关闭 dialog 且焦点回到 trigger。jsdom 不解析 Tailwind，桌面/移动档由测试按组件实际使用的判定信号（`isMobile` prop 或其 hook）切换。
- [x] 桌面键盘行为回归：同一测试文件含用例——桌面档焦点在第一个 tab 上按 `End` 后，焦点与 `aria-selected="true"` 落在最后一个 tab；按 `Home` 回到第一个。该用例在改动前的 `WorkspaceTabs.tsx` 上同样为绿（先在未改动的工作树上跑一次并记入 Evidence，证明它测的是既有行为而非新行为）。
- [x] 断点统一：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/project-workspace/WorkspaceHeader.tsx src/modules/project-workspace/WorkspaceTabs.tsx` 无任何命中（退出码 1），且 `grep -cE '(^|[^a-zA-Z-])md:' src/modules/project-workspace/WorkspaceHeader.tsx` 输出大于 0（正向对照，防止靠删光响应式类通过）。该项只是机制层的辅助闸；不变量本身（767 是移动、768 是桌面）由 DoD 的真浏览器读数与同一方案的 e2e 矩阵任务证明。
- [x] `npx vitest run src/modules/project-workspace` 退出码 0（既有 6 个测试文件不回归）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 在本仓库预先非 0，不作判据）。

## DoD

真实落地判据：不是「测试存在」。要求在真实浏览器（真实本地页面，Playwright 一次性探针或 MCP 浏览器均可，探针不入库）里对**长标题会话**读出下表并写进 Evidence，逐格记录实际数字：

| 视口 | header 边界框高度 | `documentElement.scrollWidth <= innerWidth` | tablist 是否存在 | collapsed trigger 是否存在 |
|---|---|---|---|---|
| 320×700 | 必须 ≤56 | 必须 true | 必须无 | 必须有 |
| 360×800 | 必须 ≤56 | 必须 true | 必须无 | 必须有 |
| 390×844 | 必须 ≤56（改动前基线 94） | 必须 true | 必须无 | 必须有 |
| 767×900 | 必须 ≤56 | 必须 true | 必须无 | 必须有 |
| 768×900 | — | — | 必须有 | 必须无 |
| 1280×720 | 必须与改动前一致（基线 57） | — | 必须有 | 必须无 |

（PWA safe-area inset 单独扣除，不计入 56px。）另读两条：390 下打开 dialog，每个入口的边界框 ≥44×44px；选中另一个工作区后 dialog 关闭、页面确实切到该工作区。320px 读数必须用长中文标题与较长的翻译，不能只用 `Chat`、`Files` 等英文短词。

读数如实标注边界：探针是一次性的；跨 6 个视口 × 状态的**永久**回归矩阵由同一方案里的 e2e 矩阵任务承担，本任务不宣称已覆盖；本环境若没有已启用的插件，dialog 内插件入口的边界框只能由单测（12 个插件）证明，须在 Evidence 里明说。

L_D 该轴仍暗，理由：本任务改的是响应式布局与一个 dialog 的接线，不产出领域数据或文档语义读数，没有可分离的描述长度度量。

L_G 该轴仍暗，理由：同上；验证读数就是 DoD 里真浏览器视口表的实际数字。

## 完成记录

**落地**：`WorkspaceTabs.tsx` 把工作区清单收进一个模块私有的 `useWorkspaceTabDefinitions`（四个内建 + 条件启用的 Browser/Tasks + 全部 `enabled` 插件，各自带已翻译的 label 与图标），默认导出仍渲染原来的 `PillBar` tablist（桌面档），新增导出 `CollapsedWorkspaceSelector`（trigger + 底部 dialog）共用同一份清单 —— 没有第二份工作区清单；`WorkspaceHeader.tsx` 只在桌面档渲染 tablist 与渐变/滚动按钮，移动档把菜单、标题与该 selector 放在同一行；两文件的响应式前缀由 `sm` 统一到 `md`。

**读数**（在隔离 worktree 上取，并在合并 develop 之后复跑）：

- AC1 `npx vitest run src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx` 退出 0，7/7 通过（各用例互相独立，失败信息打印可访问名列表 / `setActiveTab` 调用次数 / `document.activeElement` 的可访问名）：(a) 桌面 tablist 上 `role=tab` 的可访问名列表 = `["Chat","Shell","Files","Source Control","Browser","Tasks", 12 个插件名]`，且 `[aria-haspopup="dialog"]` 0 个；(b) 移动档 `role=tab` 0 个、`[aria-haspopup="dialog"]` 恰 1 个、其可访问名含 `Chat`、`aria-expanded` 在开合之间 false→true→false；(c) dialog 内入口名列表与 (a) 是同一份（12 个 enabled 插件全部在 DOM 中、2 个 `enabled:false` 均不在，正反双向对照），dialog 可访问名 `Workspace views`；(d) 选 `Files` 后 `setActiveTab` 恰 1 次、参数 `files`、dialog 关闭、`document.activeElement` 回到 trigger；(e) Escape 与遮罩点击各自关闭 dialog 并把焦点还给 trigger。
- AC2 桌面键盘回归：`End` 后焦点与 `aria-selected="true"` 落在最后一个 tab，`Home` 回到第一个。**先在未改动的工作树上跑过一次**：在 `develop`（`d3d4a0db`）的临时 detached worktree 里跑同一份测试文件，`-t 'desktop keyboard'` ⇒ 1 passed / 6 skipped；整文件 ⇒ 2 passed（该键盘用例 + 桌面 tablist 用例）/ 5 failed（五个移动档用例；方向正确 —— 它们编码的正是本次新增行为，不是恒真）。
- AC3 断点统一：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/project-workspace/WorkspaceHeader.tsx src/modules/project-workspace/WorkspaceTabs.tsx` 无输出、退出码 1；`grep -cE '(^|[^a-zA-Z-])md:' src/modules/project-workspace/WorkspaceHeader.tsx` 输出 5（> 0）。
- AC4 `npx vitest run src/modules/project-workspace` 退出 0，7 个文件 31 个用例全绿（含既有 6 个文件不回归）。
- AC5 `npm run typecheck` 退出 0；`npm run lint`（`oxlint src/ server/ scripts/ shared/`）退出 0，两个改动文件与新增测试文件零命中（`pb-[env(safe-area-inset-bottom)]` 已按 lint 提示换成项目自带的 `pb-safe-area-inset-bottom`）。

**DoD 真浏览器读数**（一次性 Playwright 探针，未入库、跑完即删；真实本地页面 = 本仓库 e2e harness 自带的隔离数据目录 + 真实后端 + 真实 Vite 客户端，Chromium，非 PWA，故 `env(safe-area-inset-*)` 为 0、无需扣除）：

| 视口 | header 边界框高度 | `scrollWidth <= innerWidth` | tablist | collapsed trigger |
|---|---|---|---|---|
| 320×700 | 45 | 320 ≤ 320 | 无 | 有（`Chat`，86×32） |
| 360×800 | 45 | 360 ≤ 360 | 无 | 有（`Chat`，86×32） |
| 390×844 | 45（改动前基线 94） | 390 ≤ 390 | 无 | 有（`Chat`，86×32） |
| 767×900 | 45 | 767 ≤ 767 | 无 | 有（`Chat`，86×32） |
| 768×900 | 57 | 768 ≤ 768 | 有（4 个 tab） | 无 |
| 1280×720 | 57（与基线 57 一致） | 1280 ≤ 1280 | 有（4 个 tab） | 无 |

- 长标题会话：`customTitle` = `移动端工作区顶部导航合并为单行的超长中文标题会话名称用来看标题会不会把右侧入口挤出屏幕`（28 字），读数时 `header h2` 逐字等于它，而 6 个视口的 header 高度都不受影响（移动档 45）。
- 320px 另取一格「最长出货 label」：切到 `Source Control`（出厂最长的工作区名）后 header 仍 45、`scrollWidth 320 ≤ innerWidth 320`、trigger 133.19×32。
- 390 下打开 dialog：入口 `Chat` / `Shell` / `Files` / `Source Control` 的边界框各为 372×44（≥44×44），dialog 可访问名 `Workspace views`。
- 390 下选中另一工作区（`Source Control`）：dialog 关闭（再读 `[role=dialog]` 为 null），header 内 trigger 文本与标题同时变为 `Source Control`，且 chat 面板消失（`composerVisible` 由 true 变 false）—— 页面确实切到了该工作区，不是只改了 trigger 的字。
- **边界（如实登记）**：探针是一次性的；跨 6 视口 × 状态的**永久**回归矩阵由同一方案里的 e2e 矩阵任务承担，本条不宣称已覆盖。本环境没有已启用的插件，Tasks/Browser 也未启用，所以 dialog 里只有 4 个内建入口、没有插件行 —— 12 个启用插件与 2 个禁用插件在 dialog 中的正/反两向对照只能由 AC1(c) 的单测证明，探针不覆盖这一格。UI 语言为英文，因此 320px 那格的中文压力来自会话标题本身（28 字，非 `Chat` 之类短词），而 trigger 用的是出厂**最长**的 label `Source Control` 而不是 `Chat`/`Files`。

## Touches

- src/modules/project-workspace/WorkspaceHeader.tsx
- src/modules/project-workspace/WorkspaceTabs.tsx
- src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx (new)
- tasks/gap-mobile-workspace-header-single-row-selector.md
