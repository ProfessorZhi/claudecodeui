---
id: gap-composer-footer-desktop-768-replay-overflow
title: 桌面 768px 档含录音回放时 composer footer 横向溢出 25px（scrollWidth 470 > clientWidth
  445）：非本方案引入，前序两任务已如实标注但无人认领
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

来源：本任务是 `gap-mobile-layout-e2e-viewport-matrix` 的永久回归矩阵在取证时读出的既有缺陷；此前已由两个 `done` 任务如实标注但均未认领——`gap-mobile-voice-clip-row-below-textarea` 的 DoD 表里 768×900 双条回放行写 `false（470/445）`，其正文第 108 行把它列为「边界如实标注（不在 DoD 断言集合内）」；`gap-mobile-composer-footer-single-row-more-menu` 的同名标注又把含回放的单行性推给回放任务。两者都只证明「非本次引入」，没有任务承接修复。

现状（真浏览器读数，实现树与基线树逐字段相同）：`src/modules/chat/composer/ChatComposer.tsx` 的桌面分支把两条回放按钮（`Replay original` / `Replay trimmed`）渲染在左侧工具组 `[data-slot="prompt-input-tools"]` 内；恰在 768px 宽、且左侧已放长模型名时，footer 的 `scrollWidth 470 / clientWidth 445`，即内容横向溢出 25px，footer 会横向滚动。320/360/390/767 四个移动档与 1280 桌面档的同一读数都是 `scrollWidth === clientWidth`（0 溢出）。

目标：768px 档在含两条回放时 `footer.scrollWidth === footer.clientWidth`（0 溢出），且不改变 1280 档与四个移动档的既有读数、不改变 768 档无回放时的 footer 高度 93px 与两组控件的落位。

## Plan

范围仅前端 `src/modules/chat/composer/`。断点边界必须继续用 `md`（768px），与 `useDeviceSettings().isMobile` 一致；不得用 `sm`（640px）决定这一组控件，否则 640–767px 会出现第三种布局。候选方向（实现者自行判断，不预先钉死机制）：给左侧工具组在 768 档一个可收缩的最小宽度、或让模型按钮在该档更早截断、或允许工具组内部换行而 footer 本身不滚动。修完必须留下真浏览器读数。

## AC

- [x] AC-1：真浏览器（Playwright，headless Chromium）在 768×900 视口、含两条回放（original + trimmed）、界面为 de 或 zh-CN、模型为长名时，读 `[data-slot="prompt-input-footer"]` 的 `scrollWidth === clientWidth`（0 溢出），并打印两个数字与 `innerWidth`。
- [x] AC-2：同一次读数里 1280×720 与 320/360/390/767 四档的 `scrollWidth === clientWidth` 仍为 true，footer 高度分别保持 77px 与 57px，左组/右组 top 差保持 4px（移动档）与 4px（1280 档），768 档无回放时 footer 高度仍 93px。
- [x] AC-3：失败信息必须打印实际读数（`scrollWidth`、`clientWidth`、`innerWidth`、footer 高度、工具组与右组的 `getBoundingClientRect()`），不得只断言布尔。
- [x] AC-4：反假：把本次改动还原（`git checkout`）后同一读数必须重新变成 470/445（即判据真的钉住了这次改动），且 1280 与四移动档读数不变。
- [x] AC-5：`npm run typecheck`、`npm run lint`、`npm run build:client` 退出码 0；相关 vitest 文件退出码 0。

## DoD

- 逐视口读数表（768 含/不含回放、1280 含/不含回放、320/360/390/767 含/不含回放），列 `innerWidth` / `scrollWidth` / `clientWidth` / 溢出量 / footer 高度 / 左组与右组 top 与 bottom / top 差。
- 整段调用（配置求值、seed、服务启动、浏览器启动）的墙钟总时长与通过/失败计数。
- AC-4 还原后变回 470/445 的那一次读数，原文贴出。
- 如实标注：headless Chromium 的视口/触摸模拟不等于真机；该档位此前两个任务已登记为既有边界，本次是首次认领修复。
- 与量化修前路径：修前读数已在本仓两处 DoD 里留档（470/445），修后必须并排给出。
- 人不介入的机械判据不设人审项；若未跑 MCP 人工复核，Evidence 必须写「未执行，理由：…」，不得留空。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/PromptInput.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- tasks/gap-composer-footer-desktop-768-replay-overflow.md

## Evidence

### 修点与判据面的关系

修点只有一处：`src/modules/chat/composer/ChatComposer.tsx:550`，footer 左侧工具组的桌面档位由 `min-w-0` 变成 `min-w-0 flex-wrap`（窄档仍是 `shrink-0`）；footer 本体桌面档仍是 `flex-wrap gap-y-1`、窄档仍是 `flex-nowrap`，逐字节未动。同一行上方的注释块补写了实测到的机制：盒子的 `flex-wrap` 只决定两个组落在哪儿，掰不开一个组；组里的回放按钮声明了 `shrink-0`、图标按钮也压不到图标以下，于是组把内容顶出盒子边缘，而不是自己换行。

`src/modules/chat/composer/PromptInput.tsx` 在 `## Touches` 中声明但**未改动**（`PromptInputTools` / `PromptInputFooter` 本就允许调用方追加类名，换行许可因此不需要落在它上面）。anti-drift 只报 `out-of-declared` / `overbroad-declaration` / `cross-build-overlap`，声明未写不算违规；如实写明。

判据分两半交付：

- **一次性的真浏览器探针**（`e2e/tmp-768-overflow.spec.ts` + 配置副本 `zz-ovf.config.ts`，跑完即删、不入库——`## Touches` 没有声明任何 e2e 文件，落地它会构成 `out-of-declared`）。AC-1/AC-2/AC-3/AC-4 的全部读数与失败原文来自它；
- **两条可重跑的 jsdom 断言**落在两个已声明的 vitest 文件里，钉住「换行许可」这个不变量本身（jsdom 不解析样式表，读不出布局，只能读组件声明的类名——见 AC-3 一节）。

### 逐视口读数表（修后；语言 de；模型经 `POST /api/providers/claude/models` 注入的长名 `claude-sonnet-4-5-20250929`）

探针一次调用跑完 6 个视口 × 2 状态，12 条读数全部打印：

| 视口 | 状态 | innerWidth | scrollWidth | clientWidth | 溢出 | footer 高 | 左组 top / bottom | 右组 top / bottom | top 差 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 320×700 | 无回放 | 320 | 302 | 302 | 0 | 57px | 647 / 679 | 643 / 683 | 4 |
| 320×700 | 双回放 | 320 | 302 | 302 | 0 | 57px | 647 / 679 | 643 / 683 | 4 |
| 360×800 | 无回放 | 360 | 342 | 342 | 0 | 57px | 747 / 779 | 743 / 783 | 4 |
| 360×800 | 双回放 | 360 | 342 | 342 | 0 | 57px | 747 / 779 | 743 / 783 | 4 |
| 390×844 | 无回放 | 390 | 372 | 372 | 0 | 57px | 791 / 823 | 787 / 827 | 4 |
| 390×844 | 双回放 | 390 | 372 | 372 | 0 | 57px | 791 / 823 | 787 / 827 | 4 |
| 767×900 | 无回放 | 767 | 733 | 733 | 0 | 57px | 839 / 871 | 835 / 875 | 4 |
| 767×900 | 双回放 | 767 | 733 | 733 | 0 | 57px | 839 / 871 | 835 / 875 | 4 |
| 768×900 | 无回放 | 768 | 445 | 445 | 0 | 93px | 791 / 823 | 827 / 867 | 36 |
| 768×900 | 双回放 | 768 | **445** | **445** | **0** | 129px | 755 / 823 | 827 / 867 | 72 |
| 1280×720 | 无回放 | 1280 | 866 | 866 | 0 | 77px | 631 / 663 | 627 / 667 | 4 |
| 1280×720 | 双回放 | 1280 | 866 | 866 | 0 | 77px | 631 / 663 | 627 / 667 | 4 |

两条必须写明的读数事实：

- 768×900 **无回放**行与改动前逐字段相同（445/445、93px、左组 791–823、右组 827–867、top 差 36）——AC-2 钉的就是这一行的 93px。
- 768×900 **双回放**行的代价：左组占两行子行（高度 32 → 68，bottom 仍 823、top 由 791 升到 755），footer 高度 93 → 129，两组 top 差 36 → 72。这是本次改动可见的代价，不是回归；AC-2 未钉双回放时的 768 高度与 top 差，如实登记。

### 墙钟与通过/失败计数

```
$ npx playwright test --config zz-ovf.config.ts e2e/tmp-768-overflow.spec.ts --reporter=line
…
12 条 [ovf] READING（6 视口 × 2 状态）
  1 passed (39.3s)
# 调用外壳墙钟（含配置求值、seed、服务启动、浏览器启动）：39 956 ms；1 passed / 0 failed
```

### AC-1 / AC-2 / AC-3

AC-1 的读数是上表 768×900 双回放行：`innerWidth=768 scrollWidth=445 clientWidth=445 overflow=0`，两个数字与 `innerWidth` 在同一条消息里打印。AC-2 的同一次调用读数即上表余下各行（1280 = 866/866、77px、top 差 4；四移动档 = 302/342/372/733 各自相等、57px、top 差 4；768 无回放 = 445/445、93px）。

AC-3：探针的相等断言把整条读数拼进消息，**不是布尔**——AC-4 那一次失败原文（下）就是这条消息本身，可见它带全了 `scrollWidth` / `clientWidth` / `innerWidth` / footer 高度 / 左右两组 `getBoundingClientRect()` / top 差。两条 jsdom 断言的失败信息也带实际类名（`box="…" tools="…"`），但 jsdom 读不出矩形，矩形读数只由探针承担——这一分工如实写明，不宣称 jsdom 断言能替代浏览器读数。

### AC-4 反假（还原后同一读数必须回到 470/445）

还原方式：`git checkout HEAD~1 -- src/modules/chat/composer/ChatComposer.tsx`（把本次改动从工作树撤掉、HEAD 不动），跑同一条探针，再 `git checkout HEAD -- <同文件>` 还原。撤销后的调用**退出码 1**：四条移动视口照旧全绿（302/302、342/342、372/372、733/733，高 57px，top 差 4px，与修后逐字节相同），到 768×900 双回放变红，原文：

```
[ovf] READING @768 double playback: innerWidth=768 footer=470/445 (overflow=25, h=93px) tools={"top":791,"bottom":823,"left":318,"right":739,"width":421,"height":32} right={"top":827,"bottom":867,"left":434,"right":739,"width":305,"height":40} topDiff=36 clips=2 inTools=2 clipRow=false model="claude-sonnet-4-5-20250929"

    Error: the footer must not carry content past its own edge; @768 double playback: innerWidth=768 scrollWidth=470 clientWidth=445 overflow=25 footerHeight=93 tools={"top":791,"bottom":823,"left":318,"right":739,"width":421,"height":32} right={"top":827,"bottom":867,"left":434,"right":739,"width":305,"height":40} topDiff=36 clips=2 inTools=2 clipRow=false
    Received: 470
…
  1 failed
# 撤销后的调用墙钟：35 817 ms；1 failed / 0 passed
```

矩阵在 768 中止，1280 在这一次里取不到，故在**同一撤销树**上单独再跑一次：`OVF_ONLY=1280` → 两状态都是 `866/866`（溢出 0、77px、top 差 4px），`1 passed (14.7s)`。即 1280 与四移动档的读数不因撤销而变，只有 768 双回放变回 470/445 —— 判据确实钉住了这次改动。

### 反假的第二半：改动前后的 jsdom 断言

`npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/voiceClipPlayback.test.tsx`——撤销树上 **2 failed / 33 passed**，改动后 **2 files passed / 35 tests passed**。红的两条正是本次新增的两条（`chatComposerResponsive.test.tsx` 的 `(a)`、`voiceClipPlayback.test.tsx` 的 `(b)`），其余 33 条两侧都为绿。

### AC-5

```
$ npm run typecheck     # exit 0
$ npm run lint          # oxlint src/ server/ scripts/ → exit 0
$ npm run build:client  # exit 0
$ npx vitest run <上述两个文件>  # exit 0（2 files / 35 tests passed）
```

### 与量化修前路径并排

修前读数已在本仓留档两次，两处都不在本任务的 diff 里：

- `tasks/gap-mobile-voice-clip-row-below-textarea.md:100` 的 DoD 表 768×900 双条回放行：`false（470/445）`；同文件 `:108` 把它写成「边界如实标注（不在 DoD 断言集合内）」。
- `tasks/gap-mobile-composer-footer-single-row-more-menu.md:116` 只把「含录音回放时的单行性」推给录音回放任务，未落数字。

| | scrollWidth / clientWidth | 溢出 | footer 高 | 出处 |
| --- | --- | --- | --- | --- |
| 修前 | 470 / 445 | 25px | 93px | 本任务 AC-4 撤销树实测 + 上两处 DoD 留档 |
| 修后 | 445 / 445 | 0 | 129px（左组两行） | 本任务探针实测 |

### 边界与如实标注

- headless Chromium 的视口与触摸模拟不等于真机：字体、滚动条占位、`window.innerWidth` 都与真实设备可能不同。本节只声明「768×900 这一档、这套字体、这条模型名下的读数」，不声明真机。
- 该档位此前两个任务都已登记为既有边界（一处带 470/445 数字，一处只推给别人），本次是**首次认领修复**。
- 探针一次性、不随任务落地：AC-1/AC-2/AC-4 的读数不能被下游自动重跑。可重跑的是两条 jsdom 断言（钉「换行许可」的不变量）。复现探针的配方即本节所述：6 视口 × 2 状态、长模型经 `POST /api/providers/claude/models` 注入、识别器 stand-in HTTP 服务、语言 de、`--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream` / `--use-file-for-fake-audio-capture`。
- 追加边界（本改动引入、尚未被别人钉住）：`e2e/mobile-workspace-composer-layout.spec.ts`（兄弟任务的 spec，`git cat-file -e develop:e2e/...` = ABSENT，不在 develop 上）在 768 双回放处断言 footer 高度与播放前相同；本改动把该高度抬到 129px，若那个 spec 将来落地，它的这一条会红——修它的是它自己的任务，这里如实登记而不是替它改。
- MCP 人工复核：未执行，理由：本任务全部判据都是机械读数（真浏览器数值 + 退出码），DoD 明示机械判据不设人审项；本次没有起 MCP 人工复核会话。
