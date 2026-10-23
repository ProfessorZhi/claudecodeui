---
id: gap-composer-icon-buttons-unlabeled
title: composer footer 三个图标按钮无可访问名称（commands 的名称是角标数字 "11"）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

composer footer 的图标按钮可访问名称不一致。实测（运行中的实例，Chromium 无障碍快照 + Playwright strict-mode 解析结果）：`📎 attach` 与 `⚡ token usage` 有名称（`aria-label="Attach files"` / `"Show token usage"`），而**麦克风、💬 commands、✕ clear 三个没有**——`aria-label` 为 `null`、`title` 为空串。后果具体而可见：无障碍树里它们只是匿名 `button`，`getByRole('button', { name: 'Voice input' })` 定位不到；更糟的是 commands 按钮唯一的文本是角标数字，于是**它的可访问名称变成了 `"11"`**——读屏用户听到的是「11」，而不是「显示所有命令」。

根因：`src/modules/chat/composer/VoiceInputButton.tsx:36` 只把文案传给 `tooltip`，而 `PromptInputButton` 的 tooltip 是自绘弹层（`src/modules/chat/composer/PromptInput.tsx:167-185` 把内容渲染进 `Tooltip`），既不产生 `title` 属性，也不构成 accessible name。commands 与 clear 两个按钮在 `ChatComposer.tsx`（`:448`、`:463`）同样只有 tooltip 包装，没有名称。

方案：给这三个按钮补 `aria-label`，取值用各自**已有**的 i18n 文案（不需要新增任何 key）：

- 麦克风：`voice.input` / `voice.stopRecording`——**必须随状态切换**，否则读屏用户无法得知「现在正在录音、再按即停止」。`VoiceInputButton` 里已经算过一次 `state === 'recording' ? ... : ...`，把它提成一个 `label` 常量同时供 `tooltip.content` 与 `aria-label` 用即可，避免两处各写一遍而漂移。
- commands：`input.showAllCommands`（`ChatComposer.tsx:449` 已在用）。
- clear：`input.clearInput`（`ChatComposer.tsx:465` 已在用，带 `defaultValue: 'Clear input'`）。

**不要用 `title` 代替 `aria-label`**：`title` 只在悬停时出现、触屏不可达，两者可并存但不互为替代。也不要把角标数字从无障碍树里删掉就完事——数字本身是有用信息（有多少条命令），要修的是让它不再**充当**名称。

## AC

- [x] 组件级：新增 `src/modules/chat/tests/voiceInputButtonName.test.tsx`，`npx vitest run src/modules/chat/tests/voiceInputButtonName.test.tsx` 退出码 0，覆盖：`VoiceInputButton` 在 `idle` 态按 `getByRole('button', { name: 'Voice input' })` 可定位、在 `recording` 态按 `{ name: 'Stop recording' }` 可定位（用 `getByRole` 而不是断言属性存在——属性加了但没接到按钮上是最可能的错法，前者会红、后者不会）；`recording` 态下旧名称 `Voice input` **不再**可定位。
- [x] 源码面：`grep -n "aria-label" src/modules/chat/composer/VoiceInputButton.tsx src/modules/chat/composer/ChatComposer.tsx` 至少命中 3 处（麦克风、commands、clear）；且 `VoiceInputButton.tsx` 中该属性与 `tooltip` 引用**同一个** label 变量（同文件内 `grep -c "label"` 与人工确认，防止两处文案日后漂移）。
- [x] 真实浏览器：在运行中的实例上，`📎 / 🎤 / 💬 / ✕` 四个控件（⚡ token usage 已有名称，作为对照）都能按可访问名称定位；**且 `getByRole('button', { name: '11' })` 不再命中 commands 按钮**——失败时打印各控件的实际可访问名称。
- [x] 静态门：`npm run lint` 与 `npx tsc --noEmit -p tsconfig.json` 均退出码 0。

## DoD

真实落地判据：要在**真实前端**上用无障碍快照证明，不以「属性已添加」代替。(a) 改造前先记录一次四个控件的可访问名称（作为基线，其中 commands 应为角标数字、麦克风与 clear 应为空）；(b) 改造后再记录一次，四个控件都按语义名称可定位；(c) 录制态实测：点麦克风进入录音后，其可访问名称变为 `Stop recording`（不是只在源码里切换）；(d) 语言切换至少实测一种非英语 locale（如 zh-CN），确认名称随 `t()` 走而不是写死英文；(e) 留两次快照的操作记录与差异。

实施前须加载并遵循 `.agents/skills/frontend-module-standards/SKILL.md`（本任务只改 `src/`）。

如实登记的边界：本任务只修 **composer footer 的图标按钮**，不是一次无障碍审计——transcript 区、侧栏、设置面板的同类问题不在范围内，不得据本任务声称整体达标。

L_D 该轴仍暗，理由：可访问名称是界面契约而非领域能力，本任务没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；本任务的验证读数是 DoD 里的两次无障碍快照差异。

## Touches

- src/modules/chat/composer/VoiceInputButton.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceInputButtonName.test.tsx (new)
- tasks/gap-composer-icon-buttons-unlabeled.md

## Evidence

真实前端读数：Chromium 无障碍树逐按钮取值（CDP `Accessibility.getPartialAXTree`，`fetchRelatives:false`），再用 Playwright 1.63 自己的 role+name 引擎（`getByRole(name, exact)`）复核归属，避免"名称其实属于页面上别的按钮"。两次快照用同一套 seed（run 自带的临时 `DATABASE_PATH`/`HOME` 与 seeded transcripts），改造前取自 `git restore` 回 develop 源码后的同一 worktree，改造后取自本任务的提交。

操作记录：(1) 新库上建账号并走完 onboarding；(2) 打开 seeded 会话 `e2e-role-1-task-worker`（索引一个会话即自动注册其 project，未走任何 API 造数据）；(3) 等 voice availability 解析完、mic 真正出现；(4) 读 footer 内每个 button 的 Chromium accessible name 与 `getByRole` 归属；(5) 向输入框填入文本让 clear 按钮出现，再读一次；(6) 真实点击 mic 进入录音态，再读一次；(7) 切到 zh-CN 重新加载页面，再读一次。

| 控件 | 改造前 name | 改造后 name |
| --- | --- | --- |
| 📎 attach | `Attach files` | `Attach files`（对照组：改造前已有名称） |
| 🎤 mic（idle） | 空字符串 | `Voice input` |
| ⚡ token usage | `Show token usage` | `Show token usage`（对照组，未变） |
| 💬 commands | `6`（角标数字） | `Show all commands` |
| ✕ clear（有输入时） | 空字符串 | `Clear input` |

录音态：真实点击 mic 后，同一个按钮（footer 内 index 1）的名称变为 `Stop recording`，且 `getByRole('button', { name: 'Voice input' })` 计数由 1 变 0——旧名称确实消失，不是读到了另一个元素。

角标不再充当名称：`getByRole('button', { name: 角标数字 })` 计数 1 → 0。本实例的角标数字实测是 `6`（任务描述里那台实例是 `11`），因此 AC-3 里 `'11'` 那一条按同一条不变量、用 DOM 实际读出的角标数字断言：数字不再命中任何按钮（`'11'` 在本实例两个状态下计数本来就为 0，单用它断言会空过）。各控件的实际名称见上表。

zh-CN（`document.documentElement.lang` 与页脚文案实测已切换）：mic 空 → `语音输入`，commands `6` → `显示所有命令`；名称随 `t()` 走而非写死英文。

如实登记的边界：本任务只覆盖 composer footer 的图标按钮，不是无障碍审计——transcript 区、侧栏、设置面板的同类问题不在范围内，不据此声称整体达标。另：⚡ token usage 在 zh-CN 下仍是英文 `Show token usage`，因为 `chat:misc.showTokenUsage` 在 zh-CN 资源里没有译文，属既有 i18n 缺口，不在本任务范围内。
