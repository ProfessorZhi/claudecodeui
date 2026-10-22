---
id: gap-mobile-voice-clip-row-below-textarea
title: 移动端录音回放独立成 textarea 与 footer 之间的 chip 行：原始/裁剪后两条都可访问，不再挤占主操作栏；桌面仍在左侧工具组
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mobile-composer-footer-single-row-more-menu
---
## Proposal

来源方案：`docs/proposals/mobile-workspace-and-composer-layout.md` 第 3 节（本任务自包含）。仅前端，范围 `src/modules/chat/composer/ChatComposer.tsx`。

现状：`ChatComposer.tsx` 在左侧 `PromptInputTools` 里、语音按钮右侧渲染 `VoiceClipButton`（`clipSlot` 存在才渲染，可含 original 与 trimmed 两条）。390px 下出现回放时 footer 由一行折成两行（93px）。前序任务已把移动端主操作栏收敛为 `[附件][语音][更多] … [模型][权限][发送]`，本任务处理回放的落位。

目标：

```text
┌ 输入文字……                         ┐
│ [▶ 原始 0:15] [▶ 裁剪后 0:09]      │   ← 仅 clipSlot 存在时出现的独立行
├───────────────────────────────────┤
│ 附件 语音 更多       模型 权限 发送 │
└───────────────────────────────────┘
```

- `<768px`：回放控件放到 textarea 与 footer 之间的独立行；该行**只在 `clipSlot` 存在时**出现。单条与双条回放都允许在 chip 行**内部**换行，但**不得**导致 footer 换行；出现/消失回放时 footer 的高度与位置不变，变化只发生在 chip 行。
- `>=768px`：继续把回放控件放在当前左侧工具组（位置与现在一致）。
- `VoiceClipButton` 的回放、停止、时长、原始/裁剪后区分，以及单槽播放（一次只播一条）语义**保持不变**；两处渲染（若采用桌面/移动各一份）必须**共享同一个播放状态**（`clipPlayState` / `toggleClipPlayback`），不得各自持有一份。
- 无障碍：任何时刻可访问性树里只能有**一套**回放按钮。若实现选择「渲染两份 DOM、用 CSS 显隐」，隐藏的那份必须以 `display:none`（如 `hidden` / `md:hidden`）从可访问性树与布局中完全移除，不能只是 `opacity-0` 或移出屏幕，也不能让屏幕阅读器读到两套 `Replay original` / `Replay trimmed`；若实现选择用 `isMobile` 信号只渲染一份，则同样要保证信号边界与 md（768px）一致。两种机制都可以，但**必须有一个在真浏览器里读出的可访问性树读数**（见 DoD）。
- 边界（方案已声明，不要试图“顺手解决”）：录音 chip 自身占约 36px，存在录音时输入区总高度仍约 159px；本任务解决的是主操作栏换行与信息层级，**不承诺**消除这 36px，不压缩 chip 高度，不自动丢弃最近录音。

不做：不改语音识别、录音裁剪、播放的业务行为；不改 `VoiceClipButton` 内部的回放/停止/时长逻辑（如确需改动，先用 task_write 把该文件补进 Touches 并说明原因）；不碰 `ActivityIndicator` 与消息 pane。

实施规范：按 `.agents/skills/frontend-module-standards/SKILL.md`。`voiceClipPlayback.test.tsx` 里现有断言的措辞「回放位于 composer 工具行」是旧布局的假设，要按新落位更新，而不是删掉断言。

## AC

- [x] `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 退出码 0；更新后的用例分别验证移动档与桌面档，且失败信息打印实际读数：(a) 移动档、`clipSlot` 含 original 与 trimmed：`Replay original` 与 `Replay trimmed` 均存在、可区分、可点击，且它们所在容器在 DOM 顺序上**位于 textarea 之后、footer 之前**，且**不在** footer 内；(b) 桌面档：两条回放仍在左侧工具组（footer 内、语音按钮之后）；(c) 无 `clipSlot` 时移动档**不渲染** chip 行（该行的容器整体不存在，不是空容器）；(d) 单槽播放语义不变：播放 original 时点 trimmed，original 被停止、trimmed 接管（沿用该文件既有的这组断言）。
- [x] 同一档位下回放按钮只有一套：`src/modules/chat/tests/chatComposerResponsive.test.tsx` 新增用例，在移动档与桌面档各自读 `getAllByRole('button', { name: 'Replay original' })`，可访问元素数**恰为 1**（对照：若渲染两份 DOM，测试须能读出被隐藏那份确实处于 `display:none`——jsdom 不解析 Tailwind 时，用注入等价 `display:none` 规则的样式表，或改用 `isMobile` 单份渲染，二者择一，并在失败信息里打印命中数）。
- [x] 断点边界：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ChatComposer.tsx` 中与回放行/回放容器相关的行无 `sm:` 命中（用 `grep -n` 读出行号并逐行核对，不以行号推断——静态判据的行号必须用 `grep -n` 现读）。这是机制层辅助闸，不变量由 DoD 的真浏览器读数证明。
- [x] `npx vitest run src/modules/chat` 退出码 0（既有 chat 测试不回归）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。

## DoD

真实落地判据：不是「测试存在」。要求在真实浏览器里通过语音调试上传入口（`?voiceDebug=1`，沿用 `e2e/voice-trim.spec.ts` 的录音/上传路径，产生**真实**的 original + trimmed 两条 clip，不得替身 `clipSlot`）读出下表并写进 Evidence，逐格记录实际数字：

| 视口 | 无回放 footer 高度 | 单条回放 footer 高度 | 双条回放 footer 高度 | `footer.scrollWidth === footer.clientWidth`（双条时） | chip 行位于 footer 之前 |
|---|---|---|---|---|---|
| 320×700 | 记录 | 必须与左栏相等 | 必须与左栏相等 | 必须 true | 必须 |
| 360×800 | 记录 | 同上 | 同上 | 必须 true | 必须 |
| 390×844 | 记录（改动前含回放为 93、两行） | 同上（目标 ≤57） | 同上（目标 ≤57） | 必须 true | 必须 |
| 767×900 | 记录 | 同上 | 同上 | 必须 true | 必须 |

（「必须相等」即回放出现前后 footer 高度保持不变，变化只发生在独立 chip 行。）另读四条：① 移动 390 下**可访问性树**里 `Replay original`/`Replay trimmed` 各恰 1 个（用 accessibility snapshot 或 `getByRole` 计数，不得用 `querySelectorAll` 数 DOM 冒充）；② 768 与 1280 下回放仍在左侧工具组原位、可访问性树同样各恰 1 个；③ 两条音频都真的可播放/停止：点 original 出现 `Stop original playback`，再点 trimmed 后 original 停止；④ 输入区总高度随录音出现而增加的量，如实记录（预期约 36px，方案已声明不消除，读数不得被写成「已消除」）。

读数如实标注边界：一次性探针不入库；永久回归矩阵由同一方案的 e2e 矩阵任务承担。

L_D 该轴仍暗，理由：本任务只移动一个既有控件的落位并更新旧断言，不产出领域数据或文档语义读数。

L_G 该轴仍暗，理由：同上；验证读数就是 DoD 里真浏览器的 footer 高度表与可访问性树计数。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- tasks/gap-mobile-voice-clip-row-below-textarea.md

## 完成记录

实现落位：`src/modules/chat/composer/ChatComposer.tsx` 新增 `data-slot="prompt-input-clip-row"` 独立行（条件 `clipSlot && isMobile`，第 509–517 行），插在 `PromptInputBody`（textarea）与 `PromptInputFooter` 之间；`PromptInputTools` 里的回放改为 `clipSlot && !isMobile`（第 548–555 行）。两处共用 `useVoiceInput` 返回的同一份 `clipSlot` / `clipPlayState` / `toggleClipPlayback`。机制选**单份渲染**：`isMobile` 来自 `useDeviceSettings`（断点 768，`innerWidth < 768`），与 md 边界一致，且任何时刻只渲染一套回放 DOM —— 因此可访问性树里天然只有一套，不需要靠 CSS 隐藏第二份。桌面档渲染路径相对改动前只多了 `!isMobile` 这一个条件。

### AC 读数（逐条，命令真实退出码）

| 判据 | 命令 | 退出码 | 读数 |
|---|---|---|---|
| AC1 | `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` | 0 | 21 passed（新增/更新 (a)(b)(c)(d) 四例；失败信息打印 `describePlacement` 实际落位） |
| AC2 | `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` | 0 | 10 passed；新增 (g)：两档各自 `Replay original=1`、`Replay trimmed=1` |
| AC3 | `grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ChatComposer.tsx` | — | 命中 4 行，逐行核对：336 壳内边距、338 Activity 容器宽、598 清空输入按钮 `hidden sm:flex`、661 发送按钮尺寸；**无一行**属于回放行（509–517）或回放渲染点（512/515/555） |
| AC4 | `npx vitest run src/modules/chat` | 0 | 46 files / 348 tests passed |
| AC5 | `npm run typecheck` / `npm run lint` | 0 / 0 | typecheck 无输出；lint 0 error（166 条均为既有 warning，改动文件无新增） |

### DoD 真实浏览器读数

探针形态：由 `e2e/voice-trim.spec.ts` 临时派生的 scratch spec（配一份把 watchdog ceiling 抬高的 config 副本），跑完即删、**未入库**。真实 Chromium + 真实后端/Vite + 真实 `getUserMedia`（--use-fake-device 喂 config 写出的 fixture WAV）→ 真实 `MediaRecorder` → 真实 decode/trim/encode → 真实 `transcribeVoice` 打到 recogniser stand-in。`clipSlot` **不是替身**：两条 clip 由 `useVoiceInput` 的 `adoptClip` / `adoptTrimmedClip` 真实产生（trim 由 `?voiceTrim=on` + 适配器声明共同授权）。

入口如实标注偏离：DoD 写的 `?voiceDebug=1` **上传**入口产生不了 clip —— `submitCapture` 只在 `source === 'mic'` 时 `adoptClip`，上传路径刻意不占用 slot（`useVoiceInput.ts` 注释：a file they chose is already theirs to play）。所以探针走**同一 harness 的录音路径**（同一 fixture 音频、同一条链、同一 recogniser stand-in），这是能产生真实 original+trimmed 两条 clip 的唯一路径。窄视口下侧栏不可见，会话经 `/session/<id>` 直达。

| 视口 | 无回放 footer | 单条回放 footer | 双条回放 footer | `scrollWidth===clientWidth`（双条） | chip 行在 footer 之前 | chip 行 DOM 顺序 | chip 行在 footer 内 | a11y original / trimmed | 回放在工具组 | 输入区总高度 无→有录音 |
|---|---|---|---|---|---|---|---|---|---|---|
| 320×700 | 57 | 57 | 57 | true（302/302） | true | textarea 之后、footer 之前 | false | 1 / 1 | false | 123 → 159（+36） |
| 360×800 | 57 | 57 | 57 | true（342/342） | true | 同上 | false | 1 / 1 | false | 123 → 159（+36） |
| 390×844 | 57 | 57 | 57 | true（372/372） | true | 同上 | false | 1 / 1 | false | 123 → 159（+36） |
| 767×900 | 57 | 57 | 57 | true（733/733） | true | 同上 | false | 1 / 1 | false | 123 → 159（+36） |
| 768×900 | 93 | 93 | 93 | false（470/445） | n/a（无 chip 行） | n/a | n/a | 1 / 1 | true | 159 → 159（+0） |
| 1280×800 | 77 | 77 | 77 | true（866/866） | n/a（无 chip 行） | n/a | n/a | 1 / 1 | true | 143 → 143（+0） |

- 四条移动视口：footer 高度在「无回放 / 单条 / 双条」三态下**完全不变**（57px；改动前 390 双条为 93px 两行 → 目标 ≤57 达成），变化只发生在 chip 行；双条时 `footer.scrollWidth === footer.clientWidth` 全 true。
- ① 390 可访问性树：`Replay original` / `Replay trimmed` 各恰 1 个（`page.getByRole(...).count()`，非 `querySelectorAll`）。
- ② 768 与 1280：无 chip 行，两条回放仍在**左侧工具组**内（`data-slot="prompt-input-tools"` 内含 `Replay ` 按钮），可访问性树各恰 1 个。
- ③ 390：点 original → 出现 `Stop original playback`；再点 trimmed → 出现 `Stop trimmed playback`，此时 `Stop original playback` 计数为 0（original 真被停止、trimmed 接管）。
- ④ 输入区总高度（`data-slot="prompt-input"` 表单）随录音出现由 123 → 159 = **+36px**，与方案声明的「chip 自身约 36px、不消除」一致；**未**消除。
- 边界如实标注（不在 DoD 断言集合内）：768×900 桌面档在**双条**时 footer `scrollWidth 470 > clientWidth 445`（横向溢出 25px）。该档位按方案保持原布局，桌面分支相对改动前只多了 `!isMobile`，故此溢出非本次引入；DoD 要求「必须 true」的四条移动视口全部 true。
- 同一次运行里 `e2e/voice-trim.spec.ts` 既有的 AC-119/120/121/122 四条真实浏览器判据在新布局下全部通过（4 passed）。

### 可证伪性（防判据空洞）

对实现做两次临时变异，确认对应用例转红、其余保持绿，之后均已还原：
1. 回放**始终**渲染在工具组（改动前行为）→ (a) 红（`a recording at 390px must give the replay pair a row of its own; the controls read: no replay control rendered`），(d) 与单条用例红，(g) 红并打印 `narrow (390px): Replay original=0`。
2. 改成**两份 DOM**（工具组始终渲染 + 移动档再加一行）→ (g) 红并打印 `narrow (390px): Replay original=2, Replay trimmed=2`，(a) 因 `getByRole` 命中 2 个而红。

L_D 该轴仍暗，理由同正文：不产出领域数据或文档语义读数。L_G 该轴仍暗，理由同正文：验证读数即上表与可访问性树计数。