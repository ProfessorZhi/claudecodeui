# 移动端工作区导航与对话输入区紧凑布局 Proposal

- 状态：Proposal / 待评审
- 日期：2026-09-24
- 范围：仅前端；`src/modules/project-workspace/` 与 `src/modules/chat/`
- 浏览器证据：`artifacts/layout-review/`

---

## 摘要

CloudCLI 的移动端工作区顶部目前把标题与工作区 tabs 分成两行；对话输入区则把活动状态、语音回放、token usage、命令、定时发送、模型和权限等桌面端控件同时放在输入框上下。窄屏下一旦出现语音回放，footer 会自动折成两行；执行中还同时出现输入框上方 Stop 和右下角 Stop。

本提案把移动端改成两条稳定规则：

1. 顶部始终只有一行：菜单、会话标题、当前工作区入口；其他工作区放进可访问的选择面板。
2. 输入框主操作栏始终只有一行：附件、语音、更多、模型、权限、发送/停止；语音回放成为独立录音 chip，token usage、命令和定时发送进入“更多”。

执行状态在所有视口都进入消息流末尾，只保留右下角主停止按钮（桌面端的输入框上沿 tab 及其 Stop 由任务 `gap-desktop-activity-inline-single-stop` 退役）。桌面端维持现有 tabs 与工具栏布局。

---

## 背景与浏览器读数

2026-09-24 使用 MCP 浏览器在真实本地页面上做了不落源码的 DOM 原型。验证视口包括 1280×720、390×844、360×800 与 320×700。

| 场景 | 当前布局 | 原型布局 | 结论 |
|---|---:|---:|---|
| PC 1280×720 顶栏 | 57px | 57px | 桌面端可保持不变 |
| 移动端 390×844 顶栏 | 94px | 55px | 释放 39px 内容高度 |
| 移动端、存在语音回放的 footer | 93px、两行 | 57px、单行 | 主操作栏不再折行 |
| 360px footer 横向溢出 | — | 0px | 通过 |
| 320px footer 横向溢出 | — | 0px | 通过 |
| 执行态可访问名为 Stop 的按钮 | 两个设计入口 | 一个 | 只保留主操作按钮 |

证据截图：

- [当前移动端语音回放导致两行](../../artifacts/layout-review/mobile-with-voice-baseline.png)
- [移动端执行态原型](../../artifacts/layout-review/mobile-proposed-running.png)
- [360px 窄屏原型](../../artifacts/layout-review/mobile-proposed-360.png)
- [工作区选择面板原型](../../artifacts/layout-review/mobile-proposed-workspace-sheet.png)
- [PC 布局保持不变](../../artifacts/layout-review/pc-unchanged.png)

原型同时暴露了一个边界：把录音 chip 独立出来后，输入框总高度仍为 159px，因为 chip 自身占约 36px。本提案解决的是主操作栏换行与信息层级混乱，不承诺在存在录音时消除这 36px。

---

## 目标

1. `<768px` 的移动视口下，工作区 header 保持单行，高度不超过 56px（不含 PWA safe-area inset）。
2. 移动端 composer 的主操作栏在 320px、360px、390px 和 767px 下均不换行、无横向溢出。
3. 录音回放与普通输入工具分层显示；存在原始与裁剪后两条回放时，两者都可访问，但不挤占主操作栏。
4. token usage、命令和定时发送在移动端仍然可达，但不常驻占宽。
5. 执行中只有一个可交互 Stop；状态文本不覆盖消息输出；该规则在所有视口一致，不分桌面与移动。
6. 桌面端（`>=768px`）维持现有工作区 tabs 与 composer 工具布局；活动状态与 Stop 与移动端统一（见第 4 节）。桌面端接受的代价：状态行随消息流滚动，上翻历史时看不到“还在跑”。
7. 工作区选择、“更多”菜单和所有移动后的操作保持键盘、焦点与屏幕阅读器可用。

## 非目标

- 不改变发送、排队消息、语音识别、录音裁剪、token 统计或定时消息的业务行为。
- 不改变后端 API、WebSocket 协议、数据库或用户设置。
- 不移除任何工作区；插件 tabs 也必须继续可达。
- 不在本期进一步压缩录音 chip 的 36px 高度，也不自动丢弃最近录音。
- 不重做整个移动端视觉系统或侧边栏。

---

## 方案

### 1. 移动端 header 合并为一行

移动端结构：

```text
[菜单] [会话标题 / 项目名……] [Chat ▾]
```

- 左侧菜单按钮保持现状。
- 中间标题继续使用 `WorkspaceTitle`，允许收缩与省略；项目名保留第二行小字，但不得撑高 header。
- 右侧只显示当前工作区图标、名称和展开标记。
- 点击当前工作区入口后打开底部 dialog，列出 Chat、Shell、Files、Git、按配置启用的 Tasks/Browser，以及所有已启用插件工作区。
- 选择工作区后调用现有 `setActiveTab` 并关闭 dialog。
- dialog 使用现有 `Dialog` primitive，必须具有标题、焦点圈定、Escape 关闭、遮罩点击关闭和焦点返回。
- 桌面端继续渲染当前横向 `PillBar`，包含滚动渐变和左右滚动按钮。

项目里的 `useDeviceSettings` 默认以 `<768px` 判定 `isMobile`，而当前 header/composer 的部分 Tailwind 规则使用 `sm`（640px）。本改动应统一以 `md`（768px）为移动/桌面边界，避免 640–767px 出现菜单属于移动端、工具栏却属于桌面端的混合状态。

### 2. Composer 主操作栏固定为一行

移动端主操作栏：

```text
[附件] [语音] [更多]       [模型] [权限] [发送/停止]
```

规则：

- footer 在 `<768px` 使用 `flex-nowrap`，左右两组均 `shrink-0`。
- 模型按钮继续允许文字截断，不允许把权限或发送按钮推出可视区。
- Commands、Schedule、Token usage 不在移动端常驻。
- “更多”入口打开 composer 锚定菜单，提供：
  - 命令列表；保留现有未读/数量徽标。
  - 定时发送；输入为空时保持禁用语义。
  - Token usage；展示当前紧凑读数，并可打开现有详细面板。
- 桌面端仍直接显示 Commands、Schedule 和 Token usage，不增加一次点击。

“更多”只是移动端的展示层，不应复制三项功能的业务状态。定时发送面板、token 详情和命令菜单仍走现有 callback；若现有 trigger 无法被菜单项调用，应给原组件增加 trigger variant，而不是在新组件里重写业务逻辑。

### 3. 语音回放改为录音 chip 行

移动端有最近录音时：

```text
┌ 输入文字……                         ┐
│ [▶ 原始 0:15] [▶ 裁剪后 0:09]      │
├───────────────────────────────────┤
│ 附件 语音 更多       模型 权限 发送 │
└───────────────────────────────────┘
```

- `VoiceClipButton` 的回放、停止、时长及原始/裁剪后区分保持不变。
- 移动端把回放控件放到 textarea 与 footer 之间的独立行；该行只在 `clipSlot` 存在时出现。
- 单条和双条回放都允许在 chip 行内部换行，但不得导致 footer 换行。
- 桌面端继续把回放控件放在当前左侧工具组中。
- 隐藏的响应式副本必须通过 `display: none` 从可访问性树移除，不能让屏幕阅读器读到两套回放按钮。

### 4. 活动状态进入移动端消息流

- 移动端在 `ChatMessagesPane` 的消息内容末尾渲染紧凑状态行：脉冲点、活动文本和 elapsed time。
- 状态行参与正常文档流，不使用覆盖消息内容的绝对定位。
- 状态行不再带 Stop；右下角 `PromptInputSubmit` 是唯一停止入口。
- 桌面端同样使用流内状态行，不再渲染 composer 上沿的 tab 形 `ActivityIndicator`，也不再有 tab 内的 Stop；Esc 提示迁到主停止按钮的 `title`，`ChatInterface` 的全局 Esc 中止监听不变。
- 消息 pane 不再为浮层预留底部 padding（不区分断点）；`hasActivityIndicator` 只决定传给状态行的是 `activity` 还是 `null`。
- 桌面端的代价：状态行随消息流滚动，用户上翻历史时看不到运行状态，已确认接受。底部快捷键提示行不在本节范围，保持不变。
- 权限请求出现时继续隐藏普通活动状态，维持当前优先级。

### 5. 响应式行为矩阵

| 功能 | `<768px` | `>=768px` |
|---|---|---|
| 工作区切换 | 当前工作区按钮 + dialog | 横向 tabs |
| Activity 状态 | 消息流末尾 | 消息流末尾 |
| Activity Stop | 不显示 | 不显示 |
| 主 Stop | 显示，唯一入口 | 显示，唯一入口 |
| 录音回放 | textarea 下方 chip 行 | 左侧工具组 |
| Token usage | “更多”菜单 | 常驻 |
| Commands | “更多”菜单 | 常驻 |
| Schedule | “更多”菜单 | 常驻 |
| footer | 单行、禁止折行 | 维持当前布局 |

---

## 需要修改的文件

### 工作区导航

| 文件 | 修改 |
|---|---|
| `src/modules/project-workspace/WorkspaceHeader.tsx` | 移动端改为单行 header；把 `isMobile` 传给工作区切换组件；桌面滚动容器只在桌面渲染。 |
| `src/modules/project-workspace/WorkspaceTabs.tsx` | 增加移动端 collapsed trigger 与 dialog；复用现有 tab 定义、插件列表、翻译和 `setActiveTab`，避免维护第二份工作区清单。新增的 open state 必须按前端规范说明用途。 |
| `src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx`（新） | 覆盖桌面 tabs、移动 trigger、dialog 内容、插件 tab、选择后关闭及焦点返回。 |

`WorkspaceTitle.tsx` 当前已具备 `min-w-0` 和 truncate；预计无需修改。若实测长中文标题仍挤压右侧入口，只允许补充收缩样式，不改变标题数据或状态。

### 对话输入区与活动状态

| 文件 | 修改 |
|---|---|
| `src/modules/chat/composer/ChatComposer.tsx` | 删除上沿 Activity tab（所有视口）；增加录音 chip 行；footer 改为移动端单行；接入移动端“更多”；桌面其余布局保持原位。 |
| `src/modules/chat/composer/ComposerMobileMoreMenu.tsx`（新） | 只负责移动端菜单展示和调用已有 command/schedule/token action，不拥有业务状态。 |
| `src/modules/chat/composer/ScheduleMessagePopover.tsx` | 如有必要，增加 menu-item trigger variant，让移动端“更多”复用同一套定时选择内容与提交逻辑。 |
| `src/modules/chat/composer/ActivityIndicator.tsx` | 只保留流内状态行一种展示，不渲染 Stop；计时与退出动画逻辑只保留一份。 |
| `src/modules/chat/transcript/ChatMessagesPane.tsx` | 接收活动数据，在所有视口的消息列表末尾渲染 inline Activity；不再按断点预留浮层 padding。 |
| `src/modules/chat/ChatInterface.tsx` | 将现有 `sessionActivity` 传给 `ChatMessagesPane`；不新增可派生状态。 |
| `src/modules/chat/composer/TokenUsageSummary.tsx` | 如菜单需要复用格式化读数，增加受控展示 variant；不要复制 token 解析与格式化逻辑。 |
| `src/modules/chat/tests/voiceClipPlayback.test.tsx` | 更新“回放位于工具行”的旧断言，分别验证移动 chip 与桌面工具行，并确认隐藏副本不可访问。 |
| `src/modules/chat/tests/chatComposerResponsive.test.tsx`（新） | 覆盖移动主控、More 内容、单一 Stop、权限请求优先级与桌面控件保持。 |
| `src/modules/chat/tests/activityIndicatorResponsive.test.tsx`（新） | 覆盖流内状态行无 Stop（移动与桌面一致）、桌面无悬浮 tab、elapsed time 和退出行为。 |

### 文案与浏览器验收

| 文件 | 修改 |
|---|---|
| `src/modules/i18n/locales/*/chat.json` | 增加“更多工具”等移动 composer 文案；工作区 dialog 优先复用已有 `tabs.views` 与各 tab 名称。 |
| `e2e/mobile-workspace-composer-layout.spec.ts`（新） | 在真实浏览器中验证断点、边界框、横向溢出、菜单、语音回放和执行态。 |

不需要修改 `server/`、数据库 schema、`src/shared/api.ts` 或共享业务类型。

---

## 验证方法

### 1. 组件测试

工作区导航至少验证：

1. 桌面模式渲染完整 tablist，不出现 collapsed trigger。
2. 移动模式只显示当前工作区 trigger；打开 dialog 后包含全部内建、条件与插件 tabs。
3. 选择目标后只调用一次 `setActiveTab`，dialog 关闭，焦点返回 trigger。
4. Arrow/Escape/Tab 行为满足现有 Dialog primitive 的契约。

Composer 至少验证：

1. 移动端常驻操作只有附件、语音、更多、模型、权限、发送/停止。
2. More 内能触发 Commands、Schedule 和 Token usage 的现有回调。
3. `clipSlot` 同时含 original/trimmed 时，移动端出现两条可区分回放；桌面端仍在工具组。
4. `activity.canInterrupt=true` 时，移动端与桌面端的可访问性树都只有一个 Stop。
5. 权限请求出现时不同时展示普通活动状态。

建议命令：

```bash
npx vitest run \
  src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx \
  src/modules/chat/tests/chatComposerResponsive.test.tsx \
  src/modules/chat/tests/activityIndicatorResponsive.test.tsx \
  src/modules/chat/tests/voiceClipPlayback.test.tsx
```

### 2. Playwright 边界框验收

在 320×700、360×800、390×844、767×900、768×900 和 1280×720 下分别覆盖 idle、单回放、双回放、执行中四种状态。

移动端断言：

- `header.height <= 56`（PWA safe-area 单独扣除）。
- `footer.scrollWidth === footer.clientWidth`。
- footer 左右主控组的垂直区间相交，证明处于同一行；允许按钮高度造成最多 4px 的 top 差。
- 单/双录音回放出现时 `footer.height <= 57`，回放行位于 footer 之前。
- 页面中可见且可访问的 Stop 恰好一个。
- Token、Commands、Schedule 不在 footer，可从 More 打开。
- 工作区 dialog 所有入口的触控尺寸至少 44×44px。

桌面端断言：

- 768px 与 1280px 均显示完整 tabs，而不是 collapsed trigger。
- 1280×720 下 header、composer/footer 与变更前截图的边界框不发生非预期变化。
- Token、Commands、Schedule、语音回放仍位于当前桌面位置。
- 执行中页面可见且可访问的 Stop 恰好一个，输入框上方无悬浮元素，状态行位于最后一条消息之后。

建议命令：

```bash
npm run test:e2e -- e2e/mobile-workspace-composer-layout.spec.ts
```

### 3. MCP 浏览器人工复核

1. 用临时可撤销 observer 身份进入现有长标题会话。
2. 分别设置 PC 与移动视口，保存 accessibility snapshot 与截图。
3. 在移动端打开 `Chat ▾`，确认 dialog 名称、焦点顺序和每个入口的边界框。
4. 通过语音调试上传入口生成真实 original/trimmed clip，确认 footer 不换行且两条音频都可播放/停止。
5. 观察一个真实执行中的会话，确认状态行随消息滚动、正文不被覆盖、仅主按钮可停止。
6. 撤销 observer subject，并探测 `/api/auth/user` 返回 401；删除临时 token。

### 4. 全量前端检查

```bash
npm run test:client
npm run build:client
npm run typecheck
npm run lint:client
```

---

## 验收标准

1. 320–767px 下 header 和 composer 主操作栏均不折行、不横向滚动。
2. 录音回放出现前后，footer 高度保持不变；变化只发生在独立 clip 行。
3. 所有视口的执行态恰好一个 Stop，活动状态不覆盖任何消息内容。
4. 被收纳的 Token、Commands、Schedule 均能在两次点击以内到达，功能与桌面入口一致。
5. 插件或条件工作区不会因 collapsed selector 而消失。
6. 768px 与常规桌面视口没有布局回归。
7. 组件测试、专用 Playwright 测试及全量前端检查全部通过。

---

## 风险与注意事项

- **断点漂移：** `isMobile` 是 768px，样式必须使用 `md` 对齐；混用 `sm` 会制造 640–767px 的第三种布局。
- **菜单嵌套：** More 内打开 Schedule 时要保证焦点从第一层菜单正确转移并返回，不能同时保留两个可交互遮罩。
- **重复响应式 DOM：** 为保持桌面/移动位置而渲染两个回放入口时，隐藏副本必须完全退出布局与可访问性树，并共享同一个播放状态。
- **插件数量：** 工作区 dialog 应允许纵向滚动，不能假设只有四个内建 tabs。
- **长模型名和翻译：** 320px 验收必须使用长模型名与较长翻译，不能只测 `Chat`、`Files` 等英文短词。
- **状态跟随：** inline Activity 进入消息流后必须继续触发现有 follow-to-bottom 逻辑；用户主动向上滚动时不能强行拉回底部。

---

## 推荐实施顺序

1. 先完成移动工作区 selector 与断点统一，建立 320/360/390/767/768 的 header 测试。
2. 完成 Composer More 与主操作栏单行约束。
3. 移动语音回放并更新现有播放测试。
4. 把 Activity 放进消息流，收敛到单一 Stop（移动端已落地；桌面端由 `gap-desktop-activity-inline-single-stop` 跟进）。
5. 运行完整 Playwright 矩阵与前端检查，再进行 MCP 真页面复核。
