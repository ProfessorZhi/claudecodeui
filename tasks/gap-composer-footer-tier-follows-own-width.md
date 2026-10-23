---
id: gap-composer-footer-tier-follows-own-width
title: composer footer 的紧凑排布按 composer 自身宽度切换而不是按视口：768px + 侧栏展开时输入框只有
  445px，桌面分支叠成两行（空闲 93px、双回放 129px），移动分支在 302px 宽下都是 57px 单行
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

来源：`gap-mobile-layout-e2e-viewport-matrix` 的 22 格矩阵单跑（22/22 通过）时读出的读数。全部通过并不代表布局正确：768px 档的读数是 `footer 445/445`（无横向溢出）但 `sameRow=false stacked=true`，footer 高度空闲 **93px**、含一对回放 **129px**（两组 top 差 72px）；同一台机器上移动分支在 302px 宽的 footer 里是 **57px 单行**，1280 档（footer 866px 宽）是 77px 单行。「叠成两行」本身就是缺陷，不因它在改动前就存在而变成可接受。

根因（读源码，非推测）：`src/modules/chat/composer/ChatComposer.tsx` 第 218 行用 `useDeviceSettings().isMobile`（`window.innerWidth < 768`）决定 footer 走哪套排布（`:549`、`:550`、`:578`、`:582`、`:634`，回放行 `:520`）。视口宽度不等于 footer 的可用宽度：768 视口加展开的侧栏，输入框只有 445px。桌面分支保留完整控件组并允许 `flex-wrap`，放不下就整组换行；而同样这批控件的紧凑排布（六个主控件 + 「更多」）在 302px 已经能单行放下。先前任务 `gap-composer-footer-desktop-768-replay-overflow` 只是允许左组换行来消掉 25px 横向溢出，没有触碰这个前提。

方案：让「用紧凑排布」这一个决定同时看两个信号，任一成立就紧凑：(1) 视口 < 768（现有规则，原样保留）；(2) composer 外壳（`chat-composer-shell` 内的输入框容器）的实测宽度 < 阈值。新增一个模块内 hook（`src/modules/chat/hooks/useComposerCompactTier.ts`），用 `ResizeObserver` 量该容器，返回是否紧凑，并在容器被拖拽/侧栏开合而改宽时不重挂载地翻转。**未测量（无 `ResizeObserver`、宽度为 0，即 jsdom）时一律退回仅按视口判断**，这样现有三份以 `window.innerWidth` 作为档位信号的单测（`chatComposerResponsive`、`voiceClipPlayback`、`activityIndicatorResponsive`）读数不变，新增的只是「测得窄」这一条腿。

范围边界：仅 footer 排布与回放行两处改用新信号。Tailwind 是 3.4 且没装 container-queries 插件，源码里也没有 `@container` 用法，所以不引入它；用 ResizeObserver（`useChatSessionState.ts`、`WorkspaceHeader.tsx`、`EditorSidebar.tsx` 已在用，是仓库既有惯例）。不动 `WorkspaceHeader`/`WorkspaceTabs`（它们按视口切换是对的）、不动活动指示（`:345`、`:444` 的 `!isMobile`：桌面执行态仍是 tab 状态 + composer 的 Stop，与矩阵任务的桌面判据一致）、不动 `useSendOnEnter`/`touchOnly`（那是设备属性，不是宽度属性）。

阈值必须实测推出，不许凭感觉：在真浏览器里扫 composer 容器宽度，读出「桌面排布带一对回放仍能单行放下」的最小宽度，阈值取该读数之上并写明余量；扫描过程原样记入 Evidence。

<!-- dedup-ref -->
关联（仅供追溯，不是前置）：`gap-composer-footer-desktop-768-replay-overflow`（同一区域，处理的是回放对造成的横向溢出，机制不同）、`gap-mobile-composer-footer-single-row-more-menu`（提供了紧凑排布本身）、`gap-mobile-voice-clip-row-below-textarea`（提供了回放行）。永久回归矩阵在 `gap-mobile-layout-e2e-viewport-matrix`，那条任务依赖本条落地后再把 768 判据收紧。

## AC

- [x] `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx` 退出 0，用假的 `ResizeObserver` 驱动测得宽度，覆盖：(a) 视口 1280 + 测得 445 ⇒ 紧凑结构（「更多」入口存在，Commands/Token/Schedule 不在 footer 内，含 `clipSlot` 时回放行在 footer 之前）；(b) 视口 1280 + 测得 866 ⇒ 宽结构原样（三个控件内联，回放在 footer 内）；(c) 视口 767 + 测得 900 ⇒ 仍紧凑（视口规则不被测得宽度覆盖）；(d) 阈值两侧各一格：阈值 −1 紧凑、阈值 宽（阈值常量由 hook 文件导出，测试与实现读同一个值）；(e) 未测量（不安装 `ResizeObserver`，以及宽度为 0）⇒ 与仅按视口时的结构逐字相同；(f) 挂载后触发假观察器改宽，档位在不重挂载的前提下翻转，且翻回去同样成立。
- [x] 抗假变体（每个只能让对应的格变红，还原后全绿）：① hook 忽略测得宽度、只返回视口规则 ⇒ (a) 变红，(b)(c) 仍绿；② hook 忽略视口、只看测得宽度 ⇒ (c) 变红，(a)(b) 仍绿；③ 把 `ResizeObserver` 回调里的 setState 去掉 ⇒ (f) 变红。变体只在探针里做，还原用 `git checkout`，`git diff` 之后只剩本任务声明的写点。
- [x] 既有三份以视口作为档位信号的单测不回归：`npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/activityIndicatorResponsive.test.tsx` 退出 0，且这三个文件在本任务里不需要改断言（只在确需时追加用例，不改既有读数）。
- [x] 范围未外溢：`git diff --stat` 相对本任务基线不含 `WorkspaceHeader.tsx`、`WorkspaceTabs.tsx`、`ChatMessagesPane.tsx`、`useSendOnEnter.ts`、`useDeviceSettings.ts`；`ChatComposer.tsx` 里 `:345`/`:444` 的活动指示分支仍读 `isMobile`。
- [x] 全量前端检查：`npm run test:client`、`npm run build:client`、`npm run typecheck`、`npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。

## DoD

真实落地判据：不是「单测过了」。jsdom 不排版，这条任务的结论只能在真浏览器里读到。要求用一次性的 Playwright 探针（不提交；沿用既有 layout probe 的 viewport 与看门狗写法，`TMPDIR` 指到 `/data` 上的目录避免写满根盘），在 768×900（侧栏展开，容器约 445px）、1024×768、1280×720 三个视口，空闲/单条回放/双条回放三个状态下读：footer `scrollWidth`/`clientWidth`、两个主控组的 top/bottom（是否同一行）、footer 高度、header 高度，并把读数表原样写进 Evidence。达标线：768 侧栏展开档空闲与含回放对都是**单行**（同一行为真、无横向溢出、footer 高度与移动档同量级），不是「不溢出就行」；1280 档 header 57px、footer 77px 单行与改动前逐字段相同（改动前的读数在基线树上现读，不抄本任务里的数字）。阈值来自容器宽度扫描（例如 445、520、600、680、760、866 各读一次，找到桌面排布带一对回放仍单行的最小宽度），扫描表与所选阈值、余量一并记录。另读一次实拖：在 1280 视口里把侧栏拖窄/合上，footer 排布在不重挂载的前提下翻转，两侧各读一次。

如实标注边界：视口来自 Chromium 的 viewport 模拟，不是真机；PWA safe-area 在 headless 里不生效；侧栏开合用的是应用自己的控件，宽度读数是该控件实际造成的容器宽度。

前端模块规范：实施前读 `.agents/skills/frontend-module-standards/SKILL.md`；新 hook 放 `src/modules/chat/hooks/`，导出处写明消费方，用 `type` 不用 `interface`，应用内导入一律 `@/...`，新测试文件按 boundaries 规则经模块 barrel 引入被测对象（否则 `npm run lint` 会红）。

L_D 该轴仍暗，理由：纯前端布局判据，验收读数是真浏览器的边界框读数与单测结构读数，没有独立的领域数据度量。

L_G 该轴仍暗，理由：同上；本任务的验证读数就是 DoD 里的边界框读数表与三个抗假变体的变红读数。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/hooks/useComposerCompactTier.ts (new)
- src/modules/chat/tests/composerCompactTier.test.tsx (new)
- tasks/gap-composer-footer-tier-follows-own-width.md

## Evidence

### 修点与判据面的关系

三处写点，都在 `## Touches` 内：

- `src/modules/chat/hooks/useComposerCompactTier.ts`（新）：导出阈值常量 `COMPACT_TIER_WIDTH_PX = 800`，用 `ResizeObserver` 量 `PromptInput` 表单自身的 `clientWidth`，两个信号（视口规则 / 测得宽度）取或；**未测量（无 `ResizeObserver`，或宽度读 0）时退回仅视口**——这一条腿是「现有三份 jsdom 单测读数不变」的机制，不是兜底巧合。`containerRef` 声明为 `MutableRefObject<HTMLFormElement | null>`，理由见下一节。
- `src/modules/chat/composer/ChatComposer.tsx`（改）：footer 的 `flex-nowrap`/`shrink-0`、回放行落点（footer 之前 / tools 之内）、「更多」入口与 Commands/Schedule/Token 的互换，共 6 处改读 `isCompactTier`；另加一处**接线**（`attachForm` + `assignRef`，见下一节）。
- `src/modules/chat/tests/composerCompactTier.test.tsx`（新，8 例）：(a) 分两例、(b)、(c)、(d)、(e)、(f) 对应 AC-1 的六个格，另加一例 (g) 钉接线（见「反假第二半」）。

`PromptInput.tsx` 既未改动也**未声明**（表单本就 `forwardRef` 到同一个 `<form data-slot="prompt-input">` 且 `data-slot` 齐全，接线只需落在消费方）。

一次性探针（`e2e/tmp-tier-probe.spec.ts` + 配置副本 `zz-tier.config.ts`，配置只把两道看门狗抬到 60s/300s、其余与 `playwright.config.ts` 逐字节相同）跑完即删、不入库：`## Touches` 没有声明任何 e2e 文件，落地它会构成 out-of-declared。**本任务全部浏览器读数（阈值扫描、修前/修后表、实拖腿）都来自它。**

### 接线缺陷：这一处是真浏览器抓出来的

第一版实现把 `ref={containerRef}` 写在 `<PromptInput>` 上、`{...getRootProps()}` 写在它之后。react-dropzone 的 `getRootProps()` 返回的对象**自带** `ref`（`node_modules/react-dropzone/dist/es/index.js:880`：`_defineProperty({…}, refKey, rootRef)`，`refKey` 默认就是 `ref`），spread 写在后面 ⇒ 我的 ref 被静默替换，`containerRef.current` 恒为 `null`，hook 在 `if (!box …) return` 处早退，测得宽度永远缺席，整套改动在浏览器里退化成「只按视口」。jsdom 侧 8 例当时全绿，因为测试的 `getRootProps` 替身返回空对象 `{}`，从来没有 ref——所以这个缺陷只有真浏览器能抓。

改法：把 `ref` 从 spread 里解出来（`const { ref: dropzoneFormRef, ...dropzoneFormProps } = getRootProps()`），用一个 callback ref（`attachForm`）把表单同时交给两边。dropzone 的 `rootRef` 是载荷（`preventDropOnDocument` 的 document 级判定与 `onDragLeave` 的容器判定都读它），所以既不能让我的 ref 盖掉它，也不能让它盖掉我的。测试补了 (g)：props 带 ref 时测得宽度必须照样生效，且 dropzone 的 ref 也必须照样拿到表单。

### 阈值推导（基线树上的容器宽度扫描）

真浏览器、桌面档位、footer 带一对回放（本行最宽的状态）、侧栏停在 288px，只移动视口来改容器宽度（容器 ≈ innerWidth − 288 − 35，1280 档被 866 封顶）：

| 容器宽 | 状态 | footer 高 | 两组 top 差 | 读出的排布 |
| --- | --- | --- | --- | --- |
| 445 | 空闲 | 93px | 36px | 左组整组换行 |
| 445 | 双回放 | 129px | 72px | 左组换行，且自身占两子行（高 68px） |
| 517 | 双回放 | 93px | 36px | 换行 |
| 597 | 双回放 | 93px | 36px | 换行 |
| 677 | 双回放 | 93px | 36px | 换行 |
| 687 | 双回放 | 93px | 36px | 换行 |
| 717 | 双回放 | 113px | 36px | 换行 |
| 742 | 双回放 | 113px | 36px | 换行（**仍会换行的最宽盒子**） |
| 757 | 双回放 | **77px** | **4px** | **单行**（**刚能单行的最窄盒子**） |
| 863 / 866 | 双回放 | 77px | 4px | 单行 |

「桌面排布带一对回放仍能单行放下」的最小宽度落在 **(742, 757]**。取 **`COMPACT_TIER_WIDTH_PX = 800`**：比仍会换行的最宽盒子（742）高 **58px**、比刚能单行的最窄盒子（757）高 **43px**、比 1280 视口给出的 866 低 **66px**（余量留在 866 一侧，所以 1280 档的宽排布逐字段不变）。阈值常量与上面这张表的两处余量写在 hook 的 JSDoc 里。

### 逐视口/状态读数表（修前 → 修后，同一棵树上只有接线不同）

`footer scroll/client` 一列两侧都是「盒宽/盒宽」（横向溢出处处为 0）；「宽/紧凑」按 footer 的排布分支读，结构列给出同一次读数里的 `clipRow`（回放行是否单独成行）、`inRow`（该行里的回放数）、`inTools`（tools 组里的回放数）。

| 视口 | 状态 | 容器宽 | footer scroll/client | 修前 footer 高 / top 差 / 结构 | 修后 footer 高 / top 差 / 结构 |
| --- | --- | --- | --- | --- | --- |
| 768×900 | 空闲 | 445 | 445/445 | 93px / 36px / 宽 | **57px / 4px / 紧凑** |
| 768×900 | 单条回放 | 445 | 445/445 | 93px / 36px / 宽，clipRow=false inTools=1 | **57px / 4px / 紧凑**，clipRow=true inRow=1 inTools=0 |
| 768×900 | 双条回放 | 445 | 445/445 | **129px / 72px / 宽**，clipRow=false inTools=2 | **57px / 4px / 紧凑**，clipRow=true inRow=2 inTools=0 |
| 1024×768 | 双条回放 | 701 | 701/701 | 113px / 36px / 宽 | **57px / 4px / 紧凑**，clipRow=true inRow=2 inTools=0 |
| 1280×720 | 双条回放 | 866 | 866/866 | 77px / 4px / 宽（header 57px） | 77px / 4px / 宽（header 57px），逐字段相同 |

同一棵树上的扫描档（修后；每档只列一个数）：

| innerWidth | 容器宽 | 档位 | footer 高 | top 差 | 溢出 | inTools |
| --- | --- | --- | --- | --- | --- | --- |
| 1280 | 866 | 宽 | 77px | 4px | 0 | 2 |
| 768 | 445 | 紧凑 | 57px | 4px | 0 | 0 |
| 840 | 517 | 紧凑 | 57px | 4px | 0 | 0 |
| 920 | 597 | 紧凑 | 57px | 4px | 0 | 0 |
| 1000 | 677 | 紧凑 | 57px | 4px | 0 | 0 |
| 1010 | 687 | 紧凑 | 57px | 4px | 0 | 0 |
| 1040 | 717 | 紧凑 | 57px | 4px | 0 | 0 |
| 1065 | 742 | 紧凑 | 57px | 4px | 0 | 0 |
| 1080 | 757 | 紧凑 | 57px | 4px | 0 | 0 |
| 1186 | 863 | 宽 | 77px | 4px | 0 | 2 |

两条必须写明的读数事实：

- 修前那一列不是别的树上的留档，而是**同一棵树**上接线修好之前的一次探针调用（`after-fix.log` 之前的那次，`after-run.log`）：768 档 129px/72px、1024 档 113px/36px、1280 档 77px/4px 与基线树现读逐字段相同——这正是「接线被覆盖时改动等于没做」的读数形式。
- 修后 768 档的三个状态都是 57px，与移动档（302px 宽盒子）的 57px 同量级；含回放对时回放行走自己的行、footer 仍是单行，两组 top 差 4px（32px 高的 tools 组与 40px 高的右组在同一行里垂直居中，top 差 4px 是同一行，不是两行）。

### 实拖腿（1280 视口，真实鼠标拖 `[role="separator"]`，不重挂载）

| 腿 | 侧栏宽 | 容器宽 | 档位 | footer 高 | 表单上的 `__probeMark` |
| --- | --- | --- | --- | --- | --- |
| 修前 拖前 | 288 | 866 | 宽 | 77px | 7 |
| 修前 拖到 480 | 480 | 765 | **宽（档位不跟盒子走 = 本任务要修的缺陷本身）** | 77px | 7 |
| 修前 拖回 | 289 | 866 | 宽 | 77px | 7 |
| 修后 拖前 | 288 | 866 | 宽 | 77px | 7 |
| 修后 拖到 480 | 480 | **765** | **紧凑（翻转）** | **57px** | **7（同一节点，未重挂载）** |
| 修后 拖回 | 289 | 866 | 宽 | 77px | 7 |

`__probeMark` 是探针写在 DOM 节点自身上的属性：重挂载会换掉元素、把它丢掉，所以三腿都是 7 说明档位翻转走的是同一次重渲染。第二腿回到 289 而不是 288 是侧栏拖拽把手的实际落点（夹取区间 220..480），如实登记。

### 反假：hook 的三个变体（逐格读数）

变体方式：临时改 hook 本体、跑完即还原。**还原方式与 AC 写的不同**：`git checkout` 无法还原一个尚未提交的新文件，所以三个变体都从副本还原（`cp …/useComposerCompactTier.ts.orig`），每次还原后用 `diff` 确认与备份逐字节相同（读数：`diff` 无输出）。`git diff` 之后没有变体残留（见「范围」一节）。

| 变体 | (a)×2 | (b) | (c) | (d) | (e) | (f) |
| --- | --- | --- | --- | --- | --- | --- |
| ① `isCompactTier: isMobile`（忽略测得宽度） | **红** | 绿 | 绿 | **红** | 绿 | **红** |
| ② `isCompactTier: boxIsNarrow`（忽略视口） | 绿 | 绿 | **红** | 绿 | 绿 | 绿 |
| ③ `ResizeObserver` 回调里去掉 setState | 绿 | 绿 | 绿 | 绿 | 绿 | **红** |

AC 要求的三条各自成立：① 让 (a) 红、(b)(c) 仍绿；② 让 (c) 红、(a)(b) 仍绿；③ 让 (f) 红。① 另让 (d)、(f) 红，(d)(f) 本身就是「按测得宽度」的格，与 AC 列举不冲突（AC 只规定哪些格必须仍绿）。(e) 三变体全绿：它钉的是未测量时退回视口规则，与两个信号各自的取值无关。

### 反假第二半：接线变体（(g) 单独变红）

把接线改回被覆盖的形状（`ref={containerRef}` 之后再来一个带 `ref` 的 spread），只跑本任务的测试文件：

```
× (g) the box is measured even when the dropzone's root props carry a ref of their own
  ✓ (a) ×2  ✓ (b)  ✓ (c)  ✓ (d)  ✓ (e)  ✓ (f)
  Tests  1 failed | 7 passed (8)
```

即 (g) 是这条缺陷的唯一红格，(a)–(f) 全绿——说明 (g) 钉的正是「接线」这个不变量本身，而不是重复 (a)。还原后 `8 passed`。

### AC-1 / AC-3 / AC-5 的命令与退出码

```
$ npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx                       # exit 0，1 file / 8 tests passed
$ npx vitest run …/composerCompactTier.test.tsx …/chatComposerResponsive.test.tsx \
      …/voiceClipPlayback.test.tsx …/activityIndicatorResponsive.test.tsx                 # exit 0，4 files / 52 tests passed
$ npx vitest run …/chatComposerResponsive.test.tsx …/voiceClipPlayback.test.tsx \
      …/activityIndicatorResponsive.test.tsx                                              # exit 0，3 files / 44 tests passed
$ npm run test:client                                                                     # exit 0，105 files / 746 tests passed
$ npm run build:client                                                                    # exit 0
$ npm run typecheck                                                                       # exit 0（client + server + scripts 三个 project）
$ npm run lint                                                                            # oxlint src/ server/ → exit 0（0 error；warning 数 166，本文件只贡献既有的 react(refs) 一条）
```

三条既有测试文件**未改一字**（`git status` 里没有它们）。探针两次调用的退出码：修前 `1 passed (27.0s)`、修后 `1 passed (28.2s)`，各 21 条读数。

### AC-4 范围未外溢

```
$ git status --porcelain
 M src/modules/chat/composer/ChatComposer.tsx
?? src/modules/chat/hooks/useComposerCompactTier.ts
?? src/modules/chat/tests/composerCompactTier.test.tsx
$ git diff --stat
 src/modules/chat/composer/ChatComposer.tsx | 108 ++++++++++++++++++++---------
 1 file changed, 76 insertions(+), 32 deletions(-)
```

AC 点名的五个文件一个不在 diff 里；`ChatComposer.tsx` 里活动指示的两处仍读 `isMobile`，行号随本次在上方新增的注释与接线整体下移（AC 写 `:345`/`:444`，现在在 `:379`/`:478`）：

```
379:      {!hasPendingPermissions && !isMobile && (
478:            hasActivityIndicator && !isMobile ? 'rounded-t-none' : '',
```

这两行是 AC 钉的不变量（桌面执行态仍是 tab 状态 + composer 的 Stop），本次未改其条件；`useDeviceSettings()` 仍在本组件里被读（`:236`）。

### 探针字段的如实标注

探针里 `moreMenu` 一格在两档都读 0：它的正则要求标签**恰好**是 `More`/`更多`，而紧凑入口的标签是 `More tools`（`ComposerMobileMoreMenu.tsx:52` 的 `t('input.moreTools', { defaultValue: 'More tools' })`）。所以这一格不携带档位信号，本任务的档位由另外四路读法确定：回放行是否单独成行、回放落在行内还是 tools 内、Commands/Schedule 是否在 footer 内、以及 footer 高度与两组 top 差。单测那一侧按角色名取 `enChat.input.moreTools`，读得到。

### 边界与如实标注

- 视口来自 Chromium 的 viewport 模拟，不是真机；PWA safe-area 在 headless 里不生效；侧栏宽度是应用自己的拖拽把手实际造成的容器宽度（第二腿落在 289px，不是 288px）。本节只声明「这套字体、这条模型名（经 `POST /api/providers/claude/models` 注入的长名 `claude-sonnet-4-5-20250929`）、这台机器」下的读数。
- 探针是一次性的、不随任务落地：**DoD 的边界框读数不能被下游自动重跑**。可重跑的是本任务的 8 条 jsdom 断言，它们钉的是档位**结构与信号**（读得宽度变了档位就跟着变），读不出矩形——jsdom 不排版，这一分工如实写明，不宣称单测能替代浏览器读数。复现探针的配方：`TMPDIR=<4T 卷> npx playwright test --config <配置副本> e2e/tmp-tier-probe.spec.ts --workers=1`，`test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture=…','--autoplay-policy=no-user-gesture-required'] } })`（**这一行不能省**：缺了它录音起不来，`Stop recording` 永不出现）、识别器 stand-in HTTP 服务、`/?voiceTrim=on|off` 控制回放对是否落第二轨。
- 双回放状态下 768 档的 footer 高一栏是 57px，回放对在 footer **之前**的独立行里——达标线要求的是「footer 单行、无横向溢出、与移动档同量级」，回放行单独成行是紧凑排布本身的设计（`gap-mobile-voice-clip-row-below-textarea` 提供），不是这次新增的代价。
- 阈值扫描的采样点与 DoD 举的例子（445、520、600、680、760、866）不完全相同：本任务用的是 445/517/597/677/687/717/742/757/863，理由是这组点把 (742, 757] 这个过零点夹到一格宽；DoD 的例点（760）落在单行侧，读不出下界。
- 探针里 `formCount` 全程为 1，`micInForm` 全程为 true（录音起点的命中测试在两次调用里都打了 `[tier-probe] mic hit test`），说明测的就是页面上唯一的那个 composer 表单。
- 接线改动触及 `ChatComposer.tsx` 的拖拽接线（`attachForm` 同时喂 dropzone 的 `rootRef`），dropzone 的 `preventDropOnDocument` 与 dragleave 判定依赖它；本任务没有为拖拽另跑 e2e（拖放进 composer 的 e2e 属别的任务），如实登记这一点：接线在单测里只被 (g) 间接钉住（(g) 验证两边 ref 都拿到节点）。
- 规范复核：新 hook 在 `src/modules/chat/hooks/`，导出处写明消费方（`ChatComposer`），`type` 不用 `interface`，应用内导入一律 `@/...`，测试文件与相邻既有测试同路径深度引入被测对象，`npm run lint` 退出 0（boundaries 无告警）。
