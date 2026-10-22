---
id: gap-mobile-composer-footer-single-row-more-menu
title: 移动端 composer 主操作栏固定单行：常驻只留 附件/语音/更多/模型/权限/发送，Commands/定时发送/Token usage
  收进「更多」菜单（桌面不变）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

来源方案：`docs/proposals/mobile-workspace-and-composer-layout.md` 第 2 节与「风险」（本任务自包含）。仅前端，范围 `src/modules/chat/composer/`。

现状：`ChatComposer.tsx` 的 `PromptInputFooter` 是 `flex-wrap`，左组 `PromptInputTools` 依次放 附件、语音（+ 调试上传）、录音回放、`TokenUsageSummary`、Commands、清空；右组放 `ScheduleMessagePopover`、`ComposerModelMenu`、`ComposerPermissionMenu`、`PromptInputSubmit`。390px 下存在录音回放时 footer 折成两行（93px）。

目标（`<768px`）——主操作栏永远只有一行：

```text
[附件] [语音] [更多]       [模型] [权限] [发送/停止]
```

- footer 在 `<768px` 使用 `flex-nowrap`，左右两组均 `shrink-0`；模型按钮继续允许文字截断，不允许把权限或发送按钮推出可视区。
- Commands、Schedule、Token usage **不在移动端常驻**，改由「更多」入口打开 composer 锚定菜单提供：
  - 命令列表入口，保留现有数量徽标（`slashCommandsCount`）；
  - 定时发送，输入为空时保持禁用语义（现 `disabled={!input.trim()}`）；
  - Token usage：展示当前紧凑读数，并可打开现有详细面板（`onShowTokenUsage`）。
- 桌面（`>=768px`）仍直接显示 Commands、Schedule、Token usage，不增加一次点击；桌面布局位置不变。
- 「更多」只是移动端的**展示层**，不复制三项功能的业务状态：新组件 `ComposerMobileMoreMenu.tsx` 只负责菜单展示并调用已有的 command / schedule / token action。若现有 trigger 无法被菜单项调用，应给原组件加 trigger variant（`ScheduleMessagePopover.tsx` 加 menu-item variant；`TokenUsageSummary.tsx` 加受控展示 variant，复用其 token 解析与格式化），**不要**在新组件里重写业务逻辑。
- 菜单嵌套：在「更多」里打开 Schedule 时，焦点必须从第一层菜单正确转移并在关闭后返回，不能同时保留两个可交互遮罩。
- 移动/桌面边界用 `md`（768px），与 `useDeviceSettings().isMobile` 的边界一致；不得再用 `sm`（640px）决定这一组控件，否则 640–767px 出现第三种布局。
- i18n：新增 `input.moreTools`（「更多工具」）到全部 12 个 locale 的 `chat.json`（de en es fr id it ja ko ru tr zh-CN zh-TW），三个菜单项复用已有 key（`input.showAllCommands` 等）；如还需其它新 key，同样 12 个 locale 全补且不得为空。注意：现有 locale 之间本来就不对齐（非英文 locale 缺 65–95 个 key、靠 en 回退），本任务只要求**新增**的 key 全 12 个到位，不做既有缺口的补齐。

不做：不改发送、排队、语音识别、录音裁剪、token 统计、定时消息的业务行为；不改后端/WebSocket/用户设置；录音回放的移动端位置与执行态活动状态由同一方案的其它任务处理，本任务不移动录音回放、不碰 `ActivityIndicator`。

实施规范：按 `.agents/skills/frontend-module-standards/SKILL.md`（新组件导出须有消费者注释；新测试跨模块只经 barrel 导入；新增 state 须在声明上方注释用途）。`ChatComposer.tsx` 之后还会被同一方案的另外两个任务修改，请保持改动集中在 footer 结构，不做无关重排。

## AC

- [x] `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` 退出码 0，用例各自独立且失败信息打印实际读数：(a) 移动档 footer 内可交互控件的可访问名恰为 附件、语音、更多、模型、权限、发送 六项（无 Commands/Schedule/Token usage）；(b) 桌面档 Commands、Schedule、Token usage 直接存在，且**不存在**「更多」trigger（正向对照）；(c) 移动档打开「更多」：三项都在，点击「命令」恰触发一次 `onToggleCommandMenu`，点击 Token usage 恰触发一次 `onShowTokenUsage`，Schedule 走原 `onScheduleMessage` 提交路径且提交一次；(d) `slashCommandsCount>0` 时菜单里的命令项仍带该数量徽标；(e) `input` 为空时 Schedule 项处于禁用（`aria-disabled` 或 `disabled`），有输入时可用；(f) 从「更多」进入 Schedule 再关闭：任一时刻不同时存在两个打开的 `role=dialog|menu` 遮罩，关闭后焦点回到「更多」trigger。jsdom 不解析 Tailwind，移动/桌面档由测试按组件实际使用的判定信号切换。
- [x] 新增 key 的 i18n 完整：一条 `node -e`（或等价脚本）校验 `src/modules/i18n/locales/{de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW}/chat.json` 全部可解析，且每个都存在非空字符串 `input.moreTools`；任一缺失/为空/解析失败以非 0 退出并打印缺哪个文件哪个 key。
- [x] 断点不再用 `sm` 决定这组控件：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ComposerMobileMoreMenu.tsx` 无命中（退出码 1）；`ChatComposer.tsx` 的 footer 与右组容器不再含 `sm:gap-2` 一类的 `sm:` 断点前缀（同样 `grep` 该两处行无 `sm:` 命中）。这是机制层辅助闸，不变量由 DoD 的真浏览器读数证明。
- [x] 桌面回归：`npx vitest run src/modules/chat` 退出码 0（含既有 `promptInputSubmit`、`sendOnEnter`、`voiceClipPlayback`、`tokenUsageFreshness`、`tokenBudgetSessionScope` 等不回归）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。

## DoD

真实落地判据：不是「测试存在」。要求在真实浏览器里读出下表并写进 Evidence，逐格记录实际数字；被测配置必须使用**长模型名**与**较长翻译**（zh-CN 或 de），不能只用短英文词：

| 视口 | `footer.scrollWidth === footer.clientWidth` | footer 高度 | 左组与右组垂直区间相交（同一行，top 差 ≤4px） |
|---|---|---|---|
| 320×700 | 必须 true | 记录（预期单行） | 必须 |
| 360×800 | 必须 true | 记录 | 必须 |
| 390×844 | 必须 true | 记录 | 必须 |
| 767×900 | 必须 true | 记录 | 必须 |

另读：390 下 Token/Commands/Schedule 三者均不在 footer 内，且各自**在两次点击以内**从「更多」到达并触发与桌面入口相同的结果（命令菜单打开、token 详情面板打开、定时面板打开）；768 与 1280 下三者仍直接位于 footer 原位、无「更多」trigger。

读数如实标注边界：本任务的探针是一次性的；含录音回放时 footer 是否仍单行由录音回放任务证明；6 个视口 × 4 状态的永久回归矩阵由同一方案的 e2e 矩阵任务承担，本任务不宣称已覆盖。

L_D 该轴仍暗，理由：本任务重排 composer 控件并接线已有回调，不产出领域数据或文档语义读数；新增 i18n key 的完整性已由上面的 AC 单独机械钉住，除此之外没有可分离的度量。

L_G 该轴仍暗，理由：同上；验证读数就是 DoD 里真浏览器视口表的实际数字。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/ComposerMobileMoreMenu.tsx (new)
- src/modules/chat/composer/ScheduleMessagePopover.tsx
- src/modules/chat/composer/TokenUsageSummary.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx (new)
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- tasks/gap-mobile-composer-footer-single-row-more-menu.md

## 完成记录

5/5 AC 通过（`task_check` 在 tick 前读 0/5，本写之后应读 5/5）。实现提交 `5b92a0b4`，只写了 Touches 里列出的文件。

AC 读数（全部在 worktree `.claude/worktrees/gap-mobile-composer-footer-single-row-more-menu`、commit `5b92a0b4` 的树上读出）：

- AC-1：`npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` → 退出码 0，9 用例全绿。用例各自独立渲染；断言消息带实际读数（footer 控件名拼接、菜单项文本、遮罩计数、`outerHTML`）。防伪变异两处：`isMobile` 恒 false → 8 红；`ComposerMobileMoreMenu` 里 schedule 退回 `variant="icon"` → (c-命令)(c-定时)(e)(f) 共 4 红，其中 (f) 正是「两个遮罩同时打开」这条不变量。
- AC-2：`node -e` 脚本校验 12 个 locale → `ok: input.moreTools present and non-empty in all 12 locales`，退出码 0。
- AC-3：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ComposerMobileMoreMenu.tsx` → 无命中（退出码 1）；`ChatComposer.tsx` 第 502 行（`PromptInputFooter className`）与第 581 行（右组 `div.ml-auto`）逐行 grep 同样无命中（退出码 1）。右组由 `sm:gap-2` 改为 `md:gap-2`。
- AC-4：`npx vitest run src/modules/chat` → 退出码 0，46 文件 / 344 用例全绿。
- AC-5：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0，且本任务的四个源文件与新测试零 warning / 零 error（`ScheduleMessagePopover.tsx` 上既有的 `react(purity) Date.now` 警告在本任务之前就存在，已用 develop 基线核实）。

DoD 真浏览器读数。环境：共享 node_modules，`npx playwright test` 起真后端 + 真 Vite（`playwright.config.ts` 的隔离 data dir）。配置按要求取「长模型名 + 较长翻译」：界面为 zh-CN（经应用自己的偏好镜像 `user-preferences` 载入），模型为长名 `claude-sonnet-4-5-20250929-extended-context` —— 该模型经 Settings → Agents → Models 由应用自己的入口创建，再经 composer 自己的模型菜单选中；读数中 `modelTruncated: true`，即模型按钮已达 CSS 上限度并被截断（<640px 上限 80px，640–767px 上限 224px）。探针是一次性的，读完已删除，不随任务落地。

| 视口 | scrollWidth === clientWidth | footer 高度 | 左组 / 右组垂直区间（top–bottom） | 相交 | top 差 |
|---|---|---|---|---|---|
| 320×700 | 302 === 302，true | 57px | 647–679 / 643–683 | 是 | 4px |
| 360×800 | 342 === 342，true | 57px | 747–779 / 743–783 | 是 | 4px |
| 390×844 | 372 === 372，true | 57px | 791–823 / 787–827 | 是 | 4px |
| 767×900 | 733 === 733，true | 57px | 839–871 / 835–875 | 是 | 4px |

那 4px 的来源已查明并如实登记，不是错位：右组里的发送按钮是 `h-10`（40px）、左组控件是 32px，footer 用 `items-center`，两组各自垂直居中，于是 top 差恒为 (40−32)/2 = 4px。

- 390：`inFooter` 读数 `{commands:0, schedule:0, tokens:0, more:1}` —— Token/Commands/Schedule 三者都不在 footer 内，且「更多」trigger 只有一个。footer 内按钮 5 个：`附加文件`、`更多工具`、模型（`Select model and reasoning effort`）、权限、`发送`。探针环境没有可用的语音 provider，`useVoiceAvailable` 为假，第 6 个（语音）在该环境本就不渲染；「恰为六项」这条不变量由 AC-1(a) 的 jsdom 用例机械钉住（那里 `useVoiceAvailable` 为真，读数恰 6）。
- 390「更多」菜单：标题 `更多工具`，随后三个 `role=menuitem` —— `显示所有命令` + 数量徽标 `6`、`Show token usage` + 紧凑读数 `0`、`定时发送这条消息`。两次点击以内到位的读数：`更多` → `显示所有命令` 后 `[role=listbox]` = 1（命令菜单打开，与桌面入口同一结果）；`更多` → `Show token usage` 后 `[role=dialog]` = 1（`Token Usage` 详情面板打开）；`更多` → `定时发送这条消息` 后 `[role=menu]` = 1（在同一个遮罩内展开定时面板，选项为 `15 分钟后 / 1 小时后 / 8 小时后 / 明天`）。三条路径中任一时刻 `role=dialog|menu` 遮罩数都不超过 1。
- 768×900：`{commands:1, schedule:1, tokens:1, more:0}`，footer 内 7 个按钮，高度 93px。1280×900：同样三者直接在场、无「更多」，高度 77px。这两档与 `develop` 基线逐字段相同（基线取法：把 develop 的四个源文件临时 checkout 进同一 worktree，用同一个探针再读一次，读完 `git checkout HEAD --` 还原）——768 = `93px / tools 791–823 / right 827–867 / 7 按钮`，1280 = `77px / tools 811–843 / right 807–847`。桌面布局未变。
- 基线对照（develop 源码 + 同一 zh-CN 配置）：320×700 与 360×800 的 footer 高度是 **93px（两行）**，左组宽 124px 与右组宽 202px 分居两行；本任务后为 57px 单行。390×844 的基线在**没有**录音回放时也已是 57px 单行 —— 方案里 390 折成两行发生在存在录音回放按钮时，本任务不含回放按钮，故那一格由录音回放任务证明。

边界如实标注：探针一次性、不随任务落地；含录音回放时的单行性归录音回放任务；6 视口 × 4 状态的永久回归矩阵归同方案的 e2e 矩阵任务；`md` 边界处的 640–767px 第三布局由 AC-3 的 grep 与 767 / 768 两个视口读数共同钉住。
