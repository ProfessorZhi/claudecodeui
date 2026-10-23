---
id: gap-quay-panel-mobile-grid-blowout
title: Quay 面板移动端 Recent tasks/Tasks by status 网格溢出,文字被裁而不能横滑
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

用 playwright MCP 浏览器在 390×844(手机视口)下打开 Quay 面板,"Recent tasks" 区块的每一行文字都在屏幕右边缘被硬裁(不是省略号截断),且外层容器不能横向滑动看到被裁的部分。已经用 `browser_evaluate` 量过真实的盒模型,根因明确:

- `src/modules/quay/QuayPanel.tsx:214` 与 `:252` 两处网格都写的是 `grid gap-4 md:grid-cols-2`——在 `md` 断点以下**没有定义 base 列数**,Tailwind 因此不会生成 `minmax(0, 1fr)` 这种显式列尺寸函数。CSS Grid 的隐式单列轨道在缺少显式 `minmax(0, …)` 时,最小宽度会回退成内容的 min-content 宽度。
- `DetailList` 的行(`<li>`)里标题 `<span>` 用了 `truncate`(内含 `white-space: nowrap`),这意味着"截断生效前"的 min-content 宽度就是整段未换行文本的宽度——这里是长中文任务描述,一行能有几十个字。
- 实测数据(390px 视口,`:252` 这个网格):grid 容器本应是 `width:358px`,实测 `gridTemplateColumns` 被撑成 `"2943.53px"`;对应地 `<ul>`→`<li>`→标题 `<span>` 全部被撑到 2943px 宽,其中标题 span 自身量到 `width:2610.5`,尽管它确实带着 `truncate` 类——因为撑开的是它的**祖先**(grid 轨道),`truncate` 从来没机会在一个本就超宽的容器里发挥作用。外层 `data-workspace-view="quay"` 一路到面板根容器用的是 `overflow-hidden`(不是 `overflow-x: auto`),于是多出来的部分被直接裁掉,用户看到的就是"文字溢出屏幕,且滑不动"。

对照组:本仓库其它地方同款两列响应式网格都显式写了 base 列数——`src/modules/task-master/modals/TaskDetailModal.tsx:222`(`grid grid-cols-1 gap-4 md:grid-cols-3`)、`src/modules/mcp/McpServerFormModal.tsx:224`(`grid grid-cols-1 gap-4 md:grid-cols-2`)、`src/modules/task-master/TaskBoardContent.tsx:33-37`(`grid-cols-1 md:grid-cols-2 ...`)。只有 `QuayPanel.tsx` 这两处漏了 `grid-cols-1`,是实现疏漏,不是有意为之的设计。

## AC

- [x] `npm run typecheck` 退出码 0。
- [x] `src/modules/quay/QuayPanel.tsx` 第 214、252 行(或改动后的对应行)两处网格的 className 都包含 `grid-cols-1`(配合 `md:grid-cols-2`),新增一条窄测试对源文件内容做字符串/AST 级断言,防止以后又漏掉 base 列数——退出码 0。
- [x] 新增一条真实浏览器 e2e 断言(复用仓库现成的 playwright 真机模式,而非 jsdom——jsdom 不做真实的 CSS Grid 轨道尺寸计算,测不出这类问题):在 390px 宽视口下打开一个有 quay 配置的项目、切到 Quay tab,断言 `[data-testid="quay-panel-recent-tasks"]`(以及同一网格里的兄弟区块)的 `getBoundingClientRect().width` 不超过视口宽度(允许审 scrollbar 误差的小量),且该元素所在的最近 `overflow-hidden`/`overflow-y-auto` 祖先容器的 `scrollWidth` 不超过视口宽度——退出码 0,且这条测试在修复前必须红(用本任务记录的 2943.53px 复现基线核对)。

## DoD

- 真实验证(不只是单测绿):在本机启动的 CloudCLI 上,用 playwright MCP 浏览器把视口设成 390×844,打开 claudecodeui 自身项目并切到 Quay tab,对 "Recent tasks" 第一行跑一次和本任务诊断时同样的 `getBoundingClientRect`/`getComputedStyle` 检查(含 `gridTemplateColumns`),确认 grid 容器宽度与视口一致(≈358-390px 量级,不再是 2943px),标题文字出现省略号截断而不是被硬裁。
- 回归检查:同一视口下 "Tasks by status / Driver" 那个网格(第 214 行)也用同样方法核对一次,确认没有同款溢出(即便当前内容较短没触发,也要确认改完之后两处网格的列约束一致)。
- 桌面视口(例如 1280×800)下回归一次,确认两列布局(`md:grid-cols-2`)外观没有被这次改动破坏。

## Touches

- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- e2e/zz-quay-panel-mobile-grid.spec.ts (new, 或归并进既有 quay 相关 e2e spec——以实现时仓库里实际已有的 quay e2e 文件为准)
- tasks/gap-quay-panel-mobile-grid-blowout.md (self-touch)
